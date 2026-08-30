// api/sitemap.js
// Fetches /sitemap.xml for a domain and returns the list of URLs found.
// Handles both plain sitemaps and one level of sitemap index nesting.

import { fetchPublicResource, normalizeUserUrl, UnsafeUrlError, validatePublicUrl } from './_safe-fetch.js';
import { enforceRateLimit } from './_rate-limit.js';

export const config = {
  runtime: 'nodejs',
};

const TIMEOUT_MS = 8000;

async function safeFetch(url, timeout = TIMEOUT_MS) {
  try {
    return await fetchPublicResource(url, {
      timeoutMs: timeout,
      maxBytes: 1024 * 1024,
      headers: { 'User-Agent': 'IndexicateGEOAudit/1.0 (+https://indexicate.com)' },
    });
  } catch {
    return null;
  }
}

function extractLocs(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1].trim());
}

export function createSitemapHandler({ rateLimitGuard = enforceRateLimit } = {}) {
  return async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (!await rateLimitGuard(req, res, 'sitemap')) return;

  const rawUrl = req.query?.url;
  if (!rawUrl) {
    res.status(400).json({ error: 'Missing "url" query parameter.' });
    return;
  }

  let target;
  let origin;
  try {
    target = normalizeUserUrl(rawUrl);
    await validatePublicUrl(target);
    origin = new URL(target).origin;
  } catch (error) {
    const message = error instanceof UnsafeUrlError ? error.message : 'Invalid URL.';
    return res.status(400).json({ error: message });
  }

  const sitemapRes = await safeFetch(origin + '/sitemap.xml');
  if (!sitemapRes || !sitemapRes.ok) {
    res.status(200).json({ error: 'No sitemap.xml found at this domain, or it could not be reached.', urls: [] });
    return;
  }

  const xml = await sitemapRes.text().catch(() => '');
  let urls = extractLocs(xml);
  const isIndex = /<sitemapindex/i.test(xml);

  // If this is a sitemap index (a sitemap of sitemaps), follow up to 5 nested
  // sitemaps one level deep to collect real page URLs.
  if (isIndex && urls.length > 0) {
    const nested = [];
    for (const sm of urls.slice(0, 5)) {
      const nestedRes = await safeFetch(sm);
      if (nestedRes && nestedRes.ok) {
        const nestedXml = await nestedRes.text().catch(() => '');
        nested.push(...extractLocs(nestedXml));
      }
    }
    urls = nested;
  }

  res.status(200).json({
    urls: urls.slice(0, 50),
    total: urls.length,
    isIndex,
  });
  };
}

export default createSitemapHandler();
