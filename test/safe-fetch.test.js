import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSafeLookup,
  fetchPublicResource,
  isPublicIpAddress,
  ResponseLimitError,
  UnsafeUrlError,
  validatePublicUrl,
} from '../api/_safe-fetch.js';

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];
const privateResolver = async () => [{ address: '10.20.30.40', family: 4 }];
const mixedResolver = async () => [
  { address: '93.184.216.34', family: 4 },
  { address: '127.0.0.1', family: 4 },
];

const blockedAddresses = [
  '0.0.0.0',
  '10.0.0.1',
  '100.64.0.1',
  '127.0.0.1',
  '169.254.169.254',
  '172.16.0.1',
  '192.168.1.1',
  '224.0.0.1',
  '::',
  '::1',
  '::ffff:127.0.0.1',
  'fc00::1',
  'fe80::1',
];

for (const address of blockedAddresses) {
  test(`blocks non-public address ${address}`, () => {
    assert.equal(isPublicIpAddress(address), false);
  });
}

test('accepts representative public IPv4 and IPv6 addresses', () => {
  assert.equal(isPublicIpAddress('93.184.216.34'), true);
  assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true);
});

test('accepts a public HTTPS URL after DNS validation', async () => {
  const url = await validatePublicUrl('https://example.com/path', publicResolver);
  assert.equal(url.href, 'https://example.com/path');
});

test('rejects unsupported schemes, credentials, ports, and local hostnames', async () => {
  const inputs = [
    'file:///etc/passwd',
    'ftp://example.com/file',
    'https://user:pass@example.com/',
    'https://example.com:8443/',
    'http://localhost/',
    'http://service.local/',
  ];

  for (const input of inputs) {
    await assert.rejects(validatePublicUrl(input, publicResolver), UnsafeUrlError);
  }
});

test('rejects literal private addresses and DNS answers containing a private address', async () => {
  await assert.rejects(validatePublicUrl('http://127.0.0.1/'), UnsafeUrlError);
  await assert.rejects(validatePublicUrl('https://example.com/', privateResolver), UnsafeUrlError);
  await assert.rejects(validatePublicUrl('https://example.com/', mixedResolver), UnsafeUrlError);
});

test('safe lookup fails closed when connection-time DNS becomes private', async () => {
  const lookup = createSafeLookup(privateResolver);
  await new Promise((resolve, reject) => {
    lookup('example.com', { all: false }, (error) => {
      try {
        assert.ok(error instanceof UnsafeUrlError);
        resolve();
      } catch (assertionError) {
        reject(assertionError);
      }
    });
  });
});

test('rejects a redirect to a private target before a second request', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response('', {
      status: 302,
      headers: { location: 'http://127.0.0.1/admin' },
    });
  };

  await assert.rejects(
    fetchPublicResource(
      'https://example.com/',
      {},
      { fetchImpl, dispatcher: {}, resolver: publicResolver },
    ),
    UnsafeUrlError,
  );
  assert.equal(calls, 1);
});

test('follows a validated public redirect and returns the final URL', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (calls === 1) {
      return new Response('', {
        status: 302,
        headers: { location: '/final' },
      });
    }
    return new Response('<html>ok</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  };

  const response = await fetchPublicResource(
    'https://example.com/start',
    {},
    { fetchImpl, dispatcher: {}, resolver: publicResolver },
  );

  assert.equal(response.url, 'https://example.com/final');
  assert.equal(await response.text(), '<html>ok</html>');
  assert.equal(calls, 2);
});

test('rejects a body that exceeds the configured byte limit', async () => {
  const fetchImpl = async () => new Response('0123456789', { status: 200 });

  await assert.rejects(
    fetchPublicResource(
      'https://example.com/',
      { maxBytes: 5 },
      { fetchImpl, dispatcher: {}, resolver: publicResolver },
    ),
    ResponseLimitError,
  );
});

test('aborts a request that exceeds the timeout', async () => {
  const fetchImpl = async (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason));
  });

  await assert.rejects(
    fetchPublicResource(
      'https://example.com/',
      { timeoutMs: 5 },
      { fetchImpl, dispatcher: {}, resolver: publicResolver },
    ),
    (error) => error?.name === 'AbortError' || error?.name === 'TimeoutError',
  );
});
