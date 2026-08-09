// api/audit.js
// Vercel serverless function — runs server-side so it can fetch any target
// site without hitting browser CORS restrictions.
//
// Usage: GET /api/audit?url=https://example.com
//
// Every check here is a real, verifiable technical signal computed from
// data actually fetched from the target site. Nothing is simulated. Where
// a result is ambiguous, the "note" field says so instead of implying
// certainty.

export const config = {
  runtime: 'nodejs',
};

const TIMEOUT_MS = 8000;
const SHORT_TIMEOUT_MS = 3000;
const AI_BOTS = ['GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'];

function withTimeout(promise, ms) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), ms)
  );
  return Promise.race([promise, timeout]);
}

async function safeFetch(url, options = {}, timeout = TIMEOUT_MS) {
  try {
    return await withTimeout(
      fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'IndexicateGEOAudit/1.0 (+https://indexicate.com)' },
        ...options,
      }),
      timeout
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

function extractJsonLdBlocks(html) {
  const blocks = [...html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )];
  const parsed = [];
  let hadInvalid = false;
  for (const block of blocks) {
    try {
      const data = JSON.parse(block[1].trim());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) flattenGraph(item, parsed);
    } catch {
      hadInvalid = true;
    }
  }
  return { items: parsed, hadInvalid };
}

function flattenGraph(item, out) {
  if (!item || typeof item !== 'object') return;
  out.push(item);
  if (Array.isArray(item['@graph'])) item['@graph'].forEach((g) => flattenGraph(g, out));
}

function typesOf(item) {
  const t = item['@type'];
  if (!t) return [];
  return Array.isArray(t) ? t : [t];
}

function findByType(items, typeName) {
  return items.filter((it) => typesOf(it).some((t) => String(t).toLowerCase() === typeName.toLowerCase()));
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
  res.setHeader('Cache-Control', 'no-store, max-age=0');
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

  const xContentTypeOptions = (pageRes.headers.get('x-content-type-options') || '').toLowerCase();
  const xFrameOptions = pageRes.headers.get('x-frame-options') || '';
  const referrerPolicy = pageRes.headers.get('referrer-policy') || '';
  const permissionsPolicy = pageRes.headers.get('permissions-policy') || '';
  const hsts = pageRes.headers.get('strict-transport-security') || '';
  const csp = pageRes.headers.get('content-security-policy') || '';

  // ---------- robots.txt + per-bot AI permissions ----------
  const robotsRes = await safeFetch(origin + '/robots.txt');
  const robotsOk = !!(robotsRes && robotsRes.ok);
  const robotsText = robotsOk ? await robotsRes.text().catch(() => '') : '';
  const robotsGroups = robotsOk ? parseRobotsGroups(robotsText) : [];
  const botStatus = {};
  for (const bot of AI_BOTS) {
    botStatus[bot] = robotsOk ? isBotBlocked(robotsGroups, bot) : { blocked: false, matchedGroup: 'none' };
  }

  // ---------- llms.txt ----------
  const llmsRes = await safeFetch(origin + '/llms.txt', {}, SHORT_TIMEOUT_MS);
  const llmsOk = !!(llmsRes && llmsRes.ok);
  const llmsContentType = llmsOk ? (llmsRes.headers.get('content-type') || '') : '';
  const llmsText = llmsOk ? await llmsRes.text().catch(() => '') : '';
  const llmsReferencedInHead = /<link[^>]+rel=["']alternate["'][^>]+type=["']text\/plain["'][^>]+href=["']\/?llms\.txt["']/i.test(html)
    || /<link[^>]+href=["']\/?llms\.txt["'][^>]+type=["']text\/plain["']/i.test(html);
  const llmsIsPlainText = llmsOk ? (llmsContentType.includes('text/plain') || (!llmsContentType.includes('html') && !llmsContentType.includes('json'))) : null;

  // ---------- sitemap.xml ----------
  const sitemapRes = await safeFetch(origin + '/sitemap.xml');
  const sitemapOk = !!(sitemapRes && sitemapRes.ok);

  // ---------- meta robots, detailed ----------
  const metaRobotsMatch = html.match(/<meta[^>]+name=["']robots["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i);
  const metaRobotsContent = metaRobotsMatch ? metaRobotsMatch[1].toLowerCase() : '';
  const hasNoindex = metaRobotsContent.includes('noindex');
  const hasNofollow = metaRobotsContent.includes('nofollow');
  const hasNosnippet = metaRobotsContent.includes('nosnippet');
  const hasMaxSnippetUnlimited = /max-snippet:\s*-1/.test(metaRobotsContent);
  const hasMaxImagePreviewLarge = /max-image-preview:\s*large/.test(metaRobotsContent);

  // ---------- title / meta description ----------
  const title = extractTag(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDescMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i
  ) || html.match(
    /<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["'][^>]*>/i
  );
  const metaDescription = metaDescMatch ? metaDescMatch[1].trim() : null;

  // ---------- H1 ----------
  const h1Count = countMatches(html, /<h1[\s>]/gi);
  const h1Raw = extractTag(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const h1Text = h1Raw
    ? h1Raw.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    : null;

  // ---------- lang / canonical ----------
  const langMatch = html.match(/<html[^>]+lang=["']([a-zA-Z-]+)["']/i);
  const htmlLang = langMatch ? langMatch[1] : null;

  const canonicalMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  const canonicalUrl = canonicalMatch ? canonicalMatch[1] : null;
  const canonicalMatchesServed = canonicalUrl ? (canonicalUrl.replace(/\/$/, '') === targetUrl.replace(/\/$/, '')) : null;

  // ---------- text-to-html ratio / content depth / alt text ----------
  const visibleText = stripTags(html);
  const wordCount = visibleText.length ? visibleText.split(/\s+/).filter(Boolean).length : 0;
  const textSize = Buffer.byteLength(visibleText, 'utf8');
  const textToHtmlRatio = htmlSize > 0 ? (textSize / htmlSize) * 100 : 0;

  const imgTags = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const imagesWithAlt = imgTags.filter((tag) => /alt=["'][^"']+["']/i.test(tag)).length;
  const altRatio = imgTags.length > 0 ? imagesWithAlt / imgTags.length : null;

  // ---------- internal linking & crawlability ----------
  const hrefMatches = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]);
  const staticInternalLinks = hrefMatches.filter((h) =>
    h.startsWith('/') || h.startsWith(origin) || h.startsWith('#')
  );
  const hasNavElement = /<nav[\s>]/i.test(html);
  const hasNoscript = /<noscript[\s>][\s\S]*?<\/noscript>/i.test(html);
  const noscriptHasLinks = hasNoscript ? /<noscript[\s>][\s\S]*?<a\b[^>]*href=[\s\S]*?<\/noscript>/i.test(html) : false;

  // ---------- structured data, granular ----------
  const { items: ldItems, hadInvalid } = extractJsonLdBlocks(html);
  const websiteItems = findByType(ldItems, 'WebSite');
  const orgItems = findByType(ldItems, 'Organization').concat(findByType(ldItems, 'LocalBusiness'));
  const personItems = findByType(ldItems, 'Person');
  const articleItems = findByType(ldItems, 'Article').concat(findByType(ldItems, 'BlogPosting'));
  const faqItems = findByType(ldItems, 'FAQPage');

  const orgHasSameAs = orgItems.some((o) => Array.isArray(o.sameAs) && o.sameAs.length > 0);
  const orgHasId = orgItems.some((o) => typeof o['@id'] === 'string' && o['@id'].length > 0);
  const orgHasName = orgItems.some((o) => typeof o.name === 'string' && o.name.length > 0);

  // ---------- Open Graph, detailed ----------
  const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i);
  const ogDescMatch = html.match(/<meta[^>]+property=["']og:description["']/i);
  const ogImageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i);
  const ogUrlMatch = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']*)["']/i);
  const ogImageIsAbsolute = ogImageMatch ? /^https?:\/\//i.test(ogImageMatch[1]) : false;
  const ogUrlMatchesCanonical = (ogUrlMatch && canonicalUrl) ? (ogUrlMatch[1].replace(/\/$/, '') === canonicalUrl.replace(/\/$/, '')) : null;

  // ---------- Twitter Card ----------
  const twitterCardMatch = html.match(/<meta[^>]+name=["']twitter:card["'][^>]+content=["']([^"']*)["']/i);
  const twitterImage = !!html.match(/<meta[^>]+name=["']twitter:image["']/i);

  // ---------- viewport / favicon ----------
  const hasViewport = !!html.match(/<meta[^>]+name=["']viewport["']/i);
  const hasFaviconTag = !!html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["']/i);
  let faviconOk = hasFaviconTag;
  if (!faviconOk) {
    const favRes = await safeFetch(origin + '/favicon.ico', { method: 'HEAD' }, SHORT_TIMEOUT_MS);
    faviconOk = !!(favRes && favRes.ok);
  }

  // ---------- hreflang ----------
  const hreflangMatches = [...html.matchAll(/<link[^>]+rel=["']alternate["'][^>]+hreflang=["']([^"']+)["']/gi)];
  const hreflangValues = hreflangMatches.map((m) => m[1]);

  // ---------- URL structure ----------
  const urlPath = new URL(targetUrl).pathname;
  const urlHasUnderscore = urlPath.includes('_');
  const urlHasUppercase = /[A-Z]/.test(urlPath);
  const urlParamCount = new URL(targetUrl).searchParams.size;
  const urlStructureIssues = [];
  if (urlHasUnderscore) urlStructureIssues.push('uses underscores instead of hyphens');
  if (urlHasUppercase) urlStructureIssues.push('contains uppercase letters');
  if (urlParamCount > 2) urlStructureIssues.push(`has ${urlParamCount} query parameters`);

  // ---------- 404 handling (soft-404 detection) ----------
  const probePath = '/geo-checker-404-probe-' + Math.random().toString(36).slice(2, 10);
  const notFoundRes = await safeFetch(origin + probePath, {}, SHORT_TIMEOUT_MS);
  const notFoundStatus = notFoundRes ? notFoundRes.status : null;
  const notFoundIsProper4xx = notFoundStatus !== null && notFoundStatus >= 400 && notFoundStatus < 500;

  res.status(200).json({
    url: targetUrl,
    categories: {
      foundation: {
        https: { pass: httpsOk },
        robotsTxt: { pass: robotsOk },
        sitemapXml: { pass: sitemapOk },
        metaRobotsIndexFollow: { pass: !hasNoindex && !hasNofollow, value: metaRobotsContent || null },
        metaRobotsSnippet: { pass: !hasNosnippet && hasMaxSnippetUnlimited, nosnippet: hasNosnippet, maxSnippet: hasMaxSnippetUnlimited, maxImagePreview: hasMaxImagePreviewLarge },
        llmsTxtExists: { pass: llmsOk },
        llmsTxtReferenced: { pass: llmsReferencedInHead, note: !llmsOk ? 'Cannot confirm reference — llms.txt itself was not found.' : null },
        aiBotGPTBot: { pass: !botStatus['GPTBot'].blocked, note: robotsOk ? null : 'No robots.txt found, assuming unblocked by default.' },
        aiBotChatGPTUser: { pass: !botStatus['ChatGPT-User'].blocked, note: robotsOk ? null : 'No robots.txt found, assuming unblocked by default.' },
        aiBotOAISearchBot: { pass: !botStatus['OAI-SearchBot'].blocked, note: robotsOk ? null : 'No robots.txt found, assuming unblocked by default.' },
        aiBotClaudeBot: { pass: !botStatus['ClaudeBot'].blocked, note: robotsOk ? null : 'No robots.txt found, assuming unblocked by default.' },
        aiBotPerplexityBot: { pass: !botStatus['PerplexityBot'].blocked, note: robotsOk ? null : 'No robots.txt found, assuming unblocked by default.' },
        aiBotGoogleExtended: { pass: !botStatus['Google-Extended'].blocked, note: robotsOk ? null : 'No robots.txt found, assuming unblocked by default.' },
        internalLinksStatic: { pass: staticInternalLinks.length >= 3, count: staticInternalLinks.length },
        navElement: { pass: hasNavElement },
        noscriptFallback: { pass: !hasNoscript || noscriptHasLinks, hasNoscript, note: !hasNoscript ? 'No <noscript> block found — only relevant if this is a JS-heavy site.' : null },
        hreflang: { pass: true, values: hreflangValues, note: hreflangValues.length === 0 ? 'No hreflang tags found — only relevant for multi-language sites.' : null },
        urlStructure: { pass: urlStructureIssues.length === 0, issues: urlStructureIssues },
        notFoundHandling: { pass: notFoundIsProper4xx, status: notFoundStatus, note: notFoundStatus === null ? 'Could not reach a test URL to check 404 behavior.' : null },
      },
      content: {
        title: {
          pass: !!title && title.length >= 10 && title.length <= 70,
          value: title, length: title ? title.length : 0,
        },
        metaDescription: {
          pass: !!metaDescription && metaDescription.length >= 50 && metaDescription.length <= 160,
          value: metaDescription, length: metaDescription ? metaDescription.length : 0,
        },
        h1: { pass: h1Count === 1, count: h1Count, value: h1Text },
        htmlLang: { pass: !!htmlLang, value: htmlLang },
        canonical: { pass: !!canonicalUrl, value: canonicalUrl },
        canonicalMatchesServed: { pass: canonicalMatchesServed !== false, note: !canonicalUrl ? 'No canonical tag to compare.' : null, value: canonicalUrl },
        textToHtmlRatio: { pass: textToHtmlRatio >= 15 || wordCount >= 300, value: Math.round(textToHtmlRatio * 10) / 10, wordCount },
        contentDepth: { pass: wordCount >= 300, wordCount },
        altText: {
          pass: altRatio === null || altRatio >= 0.8,
          totalImages: imgTags.length, withAlt: imagesWithAlt,
          note: imgTags.length === 0 ? 'No images found on the page.' : null,
        },
      },
      metadata: {
        schemaWebSite: { pass: websiteItems.length > 0 },
        schemaOrganization: { pass: orgItems.length > 0 && orgHasName },
        schemaOrganizationSameAs: { pass: orgHasSameAs, note: orgItems.length === 0 ? 'No Organization schema found to check.' : null },
        schemaOrganizationId: { pass: orgHasId, note: orgItems.length === 0 ? 'No Organization schema found to check.' : null },
        schemaArticle: { pass: articleItems.length > 0, note: 'Only relevant for blog/article pages.' },
        schemaFAQPage: { pass: faqItems.length > 0, note: 'Only relevant for FAQ-style pages.' },
        schemaValidJson: { pass: !hadInvalid, note: hadInvalid ? 'Some JSON-LD blocks failed to parse.' : null },
        openGraphTitle: { pass: !!ogTitleMatch },
        openGraphDescription: { pass: !!ogDescMatch },
        openGraphImage: { pass: !!ogImageMatch && ogImageIsAbsolute, hasTag: !!ogImageMatch, isAbsolute: ogImageIsAbsolute },
        openGraphUrlMatchesCanonical: { pass: ogUrlMatchesCanonical !== false, note: (!ogUrlMatch || !canonicalUrl) ? 'og:url or canonical missing — cannot compare.' : null },
        twitterCard: { pass: !!twitterCardMatch, value: twitterCardMatch ? twitterCardMatch[1] : null },
        twitterImage: { pass: twitterImage },
        viewport: { pass: hasViewport },
        favicon: { pass: faviconOk },
      },
      security: {
        xContentTypeOptions: { pass: xContentTypeOptions === 'nosniff', value: xContentTypeOptions || null },
        xFrameOptions: { pass: !!xFrameOptions, value: xFrameOptions || null },
        referrerPolicy: { pass: !!referrerPolicy, value: referrerPolicy || null },
        permissionsPolicy: { pass: !!permissionsPolicy, value: permissionsPolicy || null },
        hsts: { pass: !!hsts, value: hsts || null },
        csp: { pass: !!csp, value: csp || null },
      },
    },
  });
}
