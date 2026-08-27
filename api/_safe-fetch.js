import { lookup as dnsLookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch } from 'undici';

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const ALLOWED_PORTS = new Set(['', '80', '443']);

export class UnsafeUrlError extends Error {
  constructor(message = 'Only public HTTP(S) URLs are allowed.') {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

export class ResponseLimitError extends Error {
  constructor(message = 'Remote response exceeded the allowed size.') {
    super(message);
    this.name = 'ResponseLimitError';
  }
}

function normalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

export function isPublicIpAddress(address) {
  let parsed;
  try {
    parsed = ipaddr.parse(normalizeHostname(address));
  } catch {
    return false;
  }

  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address();
  }

  return parsed.range() === 'unicast';
}

async function resolveAll(hostname) {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

export async function validatePublicUrl(rawUrl, resolver = resolveAll) {
  const candidate = String(rawUrl ?? '').trim();
  if (!candidate || candidate.length > 2048) throw new UnsafeUrlError('Invalid URL.');

  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new UnsafeUrlError('Invalid URL.');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) throw new UnsafeUrlError();
  if (url.username || url.password) throw new UnsafeUrlError('Credentials in URLs are not allowed.');
  if (!ALLOWED_PORTS.has(url.port)) throw new UnsafeUrlError('Only standard HTTP(S) ports are allowed.');

  const hostname = normalizeHostname(url.hostname);
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new UnsafeUrlError();
  }

  if (ipaddr.isValid(hostname)) {
    if (!isPublicIpAddress(hostname)) throw new UnsafeUrlError();
    return url;
  }

  let addresses;
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new UnsafeUrlError('Hostname could not be resolved safely.');
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new UnsafeUrlError('Hostname did not resolve to a public address.');
  }

  if (addresses.some(({ address }) => !isPublicIpAddress(address))) {
    throw new UnsafeUrlError('Hostname resolves to a non-public address.');
  }

  return url;
}

export function createSafeLookup(resolver = resolveAll) {
  return (hostname, options, callback) => {
    resolver(normalizeHostname(hostname))
      .then((addresses) => {
        if (!Array.isArray(addresses) || addresses.length === 0) {
          throw new UnsafeUrlError('Hostname did not resolve to a public address.');
        }
        if (addresses.some(({ address }) => !isPublicIpAddress(address))) {
          throw new UnsafeUrlError('Hostname resolves to a non-public address.');
        }

        if (options?.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      })
      .catch((error) => callback(error));
  };
}

const safeDispatcher = new Agent({
  connect: { lookup: createSafeLookup() },
});

async function readTextWithLimit(response, maxBytes, controller) {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maxBytes) {
    controller.abort();
    throw new ResponseLimitError();
  }

  if (!response.body) return '';

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      controller.abort();
      throw new ResponseLimitError();
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchPublicResource(rawUrl, options = {}, dependencies = {}) {
  const {
    method = 'GET',
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    readBody = method !== 'HEAD',
  } = options;

  if (!['GET', 'HEAD'].includes(method)) {
    throw new TypeError('fetchPublicResource only supports GET and HEAD.');
  }

  const fetchImpl = dependencies.fetchImpl || undiciFetch;
  const dispatcher = dependencies.dispatcher || safeDispatcher;
  const resolver = dependencies.resolver || resolveAll;
  let currentUrl = await validatePublicUrl(rawUrl, resolver);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(currentUrl, {
        method,
        headers,
        redirect: 'manual',
        signal: controller.signal,
        dispatcher,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel?.();
        if (!location) throw new Error('Redirect response is missing a Location header.');
        if (redirectCount === maxRedirects) throw new Error('Too many redirects.');

        const redirectUrl = new URL(location, currentUrl);
        currentUrl = await validatePublicUrl(redirectUrl.href, resolver);
        continue;
      }

      const text = readBody ? await readTextWithLimit(response, maxBytes, controller) : '';
      return {
        ok: response.ok,
        status: response.status,
        url: currentUrl.href,
        headers: response.headers,
        text: async () => text,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error('Too many redirects.');
}

export function normalizeUserUrl(rawUrl) {
  const value = String(rawUrl ?? '').trim();
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}
