// api/sitemap.js
// Fetches /sitemap.xml for a domain and returns the list of URLs found.
// Handles both plain sitemaps and one level of sitemap index nesting.

export const config = {
  runtime: 'nodejs',
};

const TIMEOUT_MS = 8000;

function withTimeout(promise, ms) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), ms)
  );
  return Promise.race([promise, timeout]);
}

async function safeFetch(url, timeout = TIMEOUT_MS) {
  try {
    return await withTimeout(
      fetch(url, { headers: { 'User-Agent': 'IndexicateGEOAudit/1.0 (+https://indexicate.com)' } }),
      timeout
    );
  } catch {
    return null;
  }
}

function extractLocs(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1].trim());
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const rawUrl = req.query?.url;
  if (!rawUrl) {
    res.status(400).json({ error: 'Missing "url" query parameter.' });
    return;
  }

  let target = rawUrl.trim();
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
  let origin;
  try {
    origin = new URL(target).origin;
  } catch {
    res.status(400).json({ error: 'Invalid URL.' });
    return;
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
}
