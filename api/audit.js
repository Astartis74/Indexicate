// api/audit.js
// Vercel serverless function — runs server-side so it can fetch any target
// site without hitting browser CORS restrictions.
//
// Usage: GET /api/audit?url=https://example.com
//
// Every check here is a real, verifiable technical signal computed from
// data actually fetched from the target site. Nothing is simulated. Where
// a result is ambiguous (a thing wasn't found at the standard location but
// could exist elsewhere), the "note" field says so instead of implying
// certainty.

export const config = {
  runtime: 'nodejs',
};

const TIMEOUT_MS = 8000;
const AI_BOTS = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'];

function withTimeout(promise, ms) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), ms)
  );
  return Promise.race([promise, timeout]);
}

async function safeFetch(url, options = {}) {
  try {
    return await withTimeout(
      fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'IndexicateGEOAudit/1.0 (+https://indexicate.com)' },
        ...options,
      }),
      TIMEOUT_MS
    );
  } catch {
    return null;
  }
}

function normalizeUrl(raw) {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url;
}

function extractTag(html, regex) {
  const m = html.match(regex);
  return m ? m[1].trim() : null;
}

function countMatches(html, regex) {
  const m = html.match(regex);
  return m ? m.length : 0;
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
      for (const item of items) collectTypes(item, types);
    } catch {
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
  if (Array.isArray(item['@graph'])) item['@graph'].forEach((g) => collectTypes(g, types));
}

// --- robots.txt parsing: which user-agent groups block which bots ---
function parseRobotsGroups(robotsText) {
  const lines = robotsText.split(/\r?\n/).map((l) => l.trim());
  const groups = [];
  let current = null;
  for (const raw of lines) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(':');
    if (!rawKey) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      if (!current || current.disallows.length || current.allows.length) {
        current = { agents: [value], disallows: [], allows: [] };
        groups.push(current);
      } else {
        current.agents.push(value);
      }
    } else if (key === 'disallow' && current) {
      current.disallows.push(value);
    } else if (key === 'allow' && current) {
      current.allows.push(value);
    }
  }
  return groups;
}

function isBotBlocked(groups, botName) {
  const specific = groups.find((g) =>
    g.agents.some((a) => a.toLowerCase() === botName.toLowerCase())
  );
  const wildcard = groups.find((g) => g.agents.includes('*'));
  const group = specific || wildcard;
  if (!group) return { blocked: false, matchedGroup: 'none' };
  const blockedAll = group.disallows.some((d) => d === '/' || d === '/*');
  return { blocked: blockedAll, matchedGroup: specific ? botName : '*' };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const rawUrl = req.query?.url;
  if (!rawUrl) {
    res.status(400).json({ error: 'Missing "url" query parameter.' });
    return;
  }

  let targetUrl;
  try {
    targetUrl = normalizeUrl(rawUrl);
    new URL(targetUrl);
  } catch {
    res.status(400).json({ error: 'Invalid URL.' });
    return;
  }

  const origin = new URL(targetUrl).origin;

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
  const htmlSize = Buffer.byteLength(html, 'utf8');

  const robotsRes = await safeFetch(origin + '/robots.txt');
  const robotsOk = !!(robotsRes && robotsRes.ok);
  const robotsText = robotsOk ? await robotsRes.text().catch(() => '') : '';
  const robotsGroups = robotsOk ? parseRobotsGroups(robotsText) : [];
  const botStatus = AI_BOTS.map((bot) => ({ bot, ...isBotBlocked(robotsGroups, bot) }));
  const anyBotBlocked = robotsOk && botStatus.some((b) => b.blocked);

  const llmsRes = await safeFetch(origin + '/llms.txt');
  const llmsOk = !!(llmsRes && llmsRes.ok);

  const sitemapRes = await safeFetch(origin + '/sitemap.xml');
  const sitemapOk = !!(sitemapRes && sitemapRes.ok);

  const metaRobotsMatch = html.match(/<meta[^>]+name=["']robots["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i);
  const metaRobotsContent = metaRobotsMatch ? metaRobotsMatch[1].toLowerCase() : '';
  const hasNoindex = metaRobotsContent.includes('noindex');

  const title = extractTag(html, /<title[^>]*>([\s\S]*?)<\/title>/i);

  const metaDescMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i
  ) || html.match(
    /<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["'][^>]*>/i
  );
  const metaDescription = metaDescMatch ? metaDescMatch[1].trim() : null;

  const h1Count = countMatches(html, /<h1[\s>]/gi);
  const h1Text = extractTag(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);

  const langMatch = html.match(/<html[^>]+lang=["']([a-zA-Z-]+)["']/i);
  const htmlLang = langMatch ? langMatch[1] : null;

  const canonicalMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  const canonicalUrl = canonicalMatch ? canonicalMatch[1] : null;

  const visibleText = stripTags(html);
  const wordCount = visibleText.length ? visibleText.split(/\s+/).filter(Boolean).length : 0;
  const textSize = Buffer.byteLength(visibleText, 'utf8');
  const textToHtmlRatio = htmlSize > 0 ? (textSize / htmlSize) * 100 : 0;

  const imgTags = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const imagesWithAlt = imgTags.filter((tag) => /alt=["'][^"']+["']/i.test(tag)).length;
  const altRatio = imgTags.length > 0 ? imagesWithAlt / imgTags.length : null;

  const schemaTypes = extractJsonLdTypes(html);

  const ogTitle = !!html.match(/<meta[^>]+property=["']og:title["']/i);
  const ogDescription = !!html.match(/<meta[^>]+property=["']og:description["']/i);
  const ogImage = !!html.match(/<meta[^>]+property=["']og:image["']/i);

  const twitterCard = !!html.match(/<meta[^>]+name=["']twitter:card["']/i);
  const twitterTitle = !!html.match(/<meta[^>]+name=["']twitter:title["']/i);

  const hrefMatches = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]);
  const internalLinkCount = hrefMatches.filter((h) =>
    h.startsWith('/') || h.startsWith(origin) || h.startsWith('#')
  ).length;

  const hasViewport = !!html.match(/<meta[^>]+name=["']viewport["']/i);

  const hasFaviconTag = !!html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["']/i);
  let faviconOk = hasFaviconTag;
  if (!faviconOk) {
    const favRes = await safeFetch(origin + '/favicon.ico', { method: 'HEAD' });
    faviconOk = !!(favRes && favRes.ok);
  }

  res.status(200).json({
    url: targetUrl,
    categories: {
      foundation: {
        https: { pass: httpsOk },
        robotsTxt: { pass: robotsOk },
        aiBotsAllowed: {
          pass: robotsOk ? !anyBotBlocked : true,
          note: robotsOk ? null : 'No robots.txt found, so nothing blocks AI bots explicitly.',
          bots: botStatus,
        },
        llmsTxt: { pass: llmsOk },
        sitemapXml: { pass: sitemapOk },
        metaRobotsNoindex: { pass: !hasNoindex, value: metaRobotsContent || null },
      },
      content: {
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
        h1: { pass: h1Count === 1, count: h1Count, value: h1Text },
        htmlLang: { pass: !!htmlLang, value: htmlLang },
        canonical: { pass: !!canonicalUrl, value: canonicalUrl },
        textToHtmlRatio: { pass: textToHtmlRatio >= 15, value: Math.round(textToHtmlRatio * 10) / 10 },
        contentDepth: { pass: wordCount >= 300, wordCount },
        altText: {
          pass: altRatio === null || altRatio >= 0.8,
          totalImages: imgTags.length,
          withAlt: imagesWithAlt,
          note: imgTags.length === 0 ? 'No images found on the page.' : null,
        },
      },
      metadata: {
        schemaOrg: { pass: schemaTypes.length > 0, types: schemaTypes },
        openGraph: { pass: ogTitle && ogDescription && ogImage, ogTitle, ogDescription, ogImage },
        twitterCard: { pass: twitterCard && twitterTitle, twitterCard, twitterTitle },
        internalLinks: { pass: internalLinkCount >= 5, count: internalLinkCount },
        viewport: { pass: hasViewport },
        favicon: { pass: faviconOk },
      },
    },
  });
}
