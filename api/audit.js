// api/audit.js
// Vercel serverless function — runs server-side, so it can fetch any target
// site without hitting browser CORS restrictions.
//
// Usage: GET /api/audit?url=https://example.com

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

async function safeFetch(url, options = {}) {
  try {
    const res = await withTimeout(
      fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'IndexicateGEOAudit/1.0 (+https://indexicate.com)',
        },
        ...options,
      }),
      TIMEOUT_MS
    );
    return res;
  } catch (err) {
    return null;
  }
}

function normalizeUrl(raw) {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  return url;
}

function extractTag(html, regex) {
  const match = html.match(regex);
  return match ? match[1].trim() : null;
}

function countMatches(html, regex) {
  const matches = html.match(regex);
  return matches ? matches.length : 0;
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&amp;|&quot;|&#39;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractJsonLdTypes(html) {
  const blocks = [...html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )];
  const types = new Set();
  for (const block of blocks) {
    try {
      const data = JSON.parse(block[1].trim());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        collectTypes(item, types);
      }
    } catch {
      // malformed JSON-LD — note it but don't crash
      types.add('(invalid JSON-LD found)');
    }
  }
  return [...types];
}

function collectTypes(item, types) {
  if (!item || typeof item !== 'object') return;
  if (item['@type']) {
    const t = item['@type'];
    if (Array.isArray(t)) t.forEach((x) => types.add(x));
    else types.add(t);
  }
  if (Array.isArray(item['@graph'])) {
    item['@graph'].forEach((g) => collectTypes(g, types));
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const rawUrl = req.query?.url;
  if (!rawUrl) {
    res.status(400).json({ error: 'Missing "url" query parameter.' });
    return;
  }

  let targetUrl;
  try {
    targetUrl = normalizeUrl(rawUrl);
    new URL(targetUrl); // throws if invalid
  } catch {
    res.status(400).json({ error: 'Invalid URL.' });
    return;
  }

  const origin = new URL(targetUrl).origin;

  // --- Fetch main page ---
  const pageRes = await safeFetch(targetUrl);
  if (!pageRes) {
    res.status(200).json({
      url: targetUrl,
      fetchError: 'Could not reach this URL. Check it is public and responding.',
    });
    return;
  }

  const httpsOk = targetUrl.startsWith('https://');
  const html = await pageRes.text().catch(() => '');

  // --- robots.txt ---
  const robotsRes = await safeFetch(origin + '/robots.txt');
  const robotsOk = !!(robotsRes && robotsRes.ok);
  const robotsText = robotsOk ? await robotsRes.text().catch(() => '') : '';

  // --- llms.txt ---
  const llmsRes = await safeFetch(origin + '/llms.txt');
  const llmsOk = !!(llmsRes && llmsRes.ok);

  // --- Title ---
  const title = extractTag(html, /<title[^>]*>([\s\S]*?)<\/title>/i);

  // --- Meta description ---
  const metaDescMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i
  ) || html.match(
    /<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["'][^>]*>/i
  );
  const metaDescription = metaDescMatch ? metaDescMatch[1].trim() : null;

  // --- H1 ---
  const h1Count = countMatches(html, /<h1[\s>]/gi);
  const h1Text = extractTag(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);

  // --- Schema.org / JSON-LD ---
  const schemaTypes = extractJsonLdTypes(html);

  // --- Open Graph ---
  const ogTitle = !!html.match(/<meta[^>]+property=["']og:title["']/i);
  const ogDescription = !!html.match(/<meta[^>]+property=["']og:description["']/i);
  const ogImage = !!html.match(/<meta[^>]+property=["']og:image["']/i);

  // --- Content depth ---
  const visibleText = stripTags(html);
  const wordCount = visibleText.length ? visibleText.split(/\s+/).filter(Boolean).length : 0;

  res.status(200).json({
    url: targetUrl,
    checks: {
      https: { pass: httpsOk },
      robotsTxt: { pass: robotsOk, snippet: robotsText.slice(0, 300) },
      llmsTxt: { pass: llmsOk },
      title: {
        pass: !!title && title.length >= 10 && title.length <= 70,
        value: title,
        length: title ? title.length : 0,
      },
      metaDescription: {
        pass: !!metaDescription && metaDescription.length >= 50 && metaDescription.length <= 160,
        value: metaDescription,
        length: metaDescription ? metaDescription.length : 0,
      },
      h1: {
        pass: h1Count === 1,
        count: h1Count,
        value: h1Text,
      },
      schemaOrg: {
        pass: schemaTypes.length > 0,
        types: schemaTypes,
      },
      openGraph: {
        pass: ogTitle && ogDescription && ogImage,
        ogTitle,
        ogDescription,
        ogImage,
      },
      contentDepth: {
        pass: wordCount >= 300,
        wordCount,
      },
    },
  });
}
