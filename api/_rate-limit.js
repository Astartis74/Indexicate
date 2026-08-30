import { createHmac } from 'node:crypto';
import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';

export const DEFAULT_RATE_LIMITS = Object.freeze({
  windowSeconds: 600,
  auditMax: 12,
  sitemapMax: 2,
});

const SCOPES = new Set(['audit', 'sitemap']);
let runtimeLimiters;
let runtimeSetupError;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getRateLimitConfig(env = process.env) {
  return {
    windowSeconds: positiveInteger(env.RATE_LIMIT_WINDOW_SECONDS, DEFAULT_RATE_LIMITS.windowSeconds),
    auditMax: positiveInteger(env.RATE_LIMIT_AUDIT_MAX, DEFAULT_RATE_LIMITS.auditMax),
    sitemapMax: positiveInteger(env.RATE_LIMIT_SITEMAP_MAX, DEFAULT_RATE_LIMITS.sitemapMax),
  };
}

function getRequiredSecret(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`Missing required rate-limit setting: ${name}`);
  return value;
}

function getHeader(req, name) {
  const value = req?.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

export function getTrustedClientIp(req) {
  const forwarded = getHeader(req, 'x-vercel-forwarded-for') || getHeader(req, 'x-forwarded-for') || '';
  return String(forwarded).split(',')[0].trim() || 'missing';
}

export function makeRateLimitIdentifier({ scope, clientIp, secret, windowSeconds, now = Date.now }) {
  if (!SCOPES.has(scope)) throw new TypeError(`Unsupported rate-limit scope: ${scope}`);
  const window = Math.floor(now() / (windowSeconds * 1000));
  return createHmac('sha256', secret)
    .update(`${scope}:${window}:${clientIp}`)
    .digest('base64url');
}

export function createRuntimeLimiters(env = process.env) {
  const url = getRequiredSecret(env, 'UPSTASH_REDIS_REST_URL');
  const token = getRequiredSecret(env, 'UPSTASH_REDIS_REST_TOKEN');
  const secret = getRequiredSecret(env, 'RATE_LIMIT_HMAC_SECRET');
  const config = getRateLimitConfig(env);
  const redis = new Redis({ url, token });
  const makeLimiter = (prefix, max) => new Ratelimit({
    redis,
    prefix,
    limiter: Ratelimit.fixedWindow(max, `${config.windowSeconds} s`),
    analytics: false,
  });

  return {
    config,
    secret,
    limiters: {
      audit: makeLimiter('indexicate:rate-limit:audit', config.auditMax),
      sitemap: makeLimiter('indexicate:rate-limit:sitemap', config.sitemapMax),
    },
  };
}

function getRuntimeLimiters() {
  if (runtimeLimiters) return runtimeLimiters;
  if (runtimeSetupError) throw runtimeSetupError;
  try {
    runtimeLimiters = createRuntimeLimiters();
    return runtimeLimiters;
  } catch (error) {
    runtimeSetupError = error;
    throw error;
  }
}

function isTestBypass(env = process.env) {
  return env.NODE_ENV === 'test' && env.RATE_LIMIT_TEST_BYPASS === 'true';
}

function setRateLimitHeaders(res, result) {
  res.setHeader('RateLimit-Limit', String(result.limit));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, result.remaining)));
  res.setHeader('RateLimit-Reset', String(Math.ceil(result.reset / 1000)));
}

function logRateLimitEvent(event) {
  // Keep the event measurable without emitting IP addresses, audited URLs, or bodies.
  console.info(JSON.stringify({ component: 'rate-limit', ...event }));
}

function respondUnavailable(res, scope, reason) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Retry-After', '30');
  logRateLimitEvent({ scope, outcome: 'unavailable', reason });
  res.status(503).json({ error: 'Request protection is temporarily unavailable. Please retry shortly.' });
  return false;
}

export function createRateLimitGuard({ getLimiters = getRuntimeLimiters, now = Date.now, env = process.env } = {}) {
  return async function enforceRateLimit(req, res, scope) {
    if (!SCOPES.has(scope)) throw new TypeError(`Unsupported rate-limit scope: ${scope}`);
    if (isTestBypass(env)) return true;

    let setup;
    try {
      setup = getLimiters();
    } catch (error) {
      return respondUnavailable(res, scope, 'configuration');
    }

    const clientIp = getTrustedClientIp(req);
    const identifier = makeRateLimitIdentifier({
      scope,
      clientIp,
      secret: setup.secret,
      windowSeconds: setup.config.windowSeconds,
      now,
    });

    let result;
    try {
      result = await setup.limiters[scope].limit(identifier);
    } catch (error) {
      return respondUnavailable(res, scope, 'provider-error');
    }

    if (result.reason === 'timeout') {
      return respondUnavailable(res, scope, 'provider-timeout');
    }

    setRateLimitHeaders(res, result);
    if (!result.success) {
      const retryAfter = Math.max(1, Math.ceil((result.reset - now()) / 1000));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Retry-After', String(retryAfter));
      logRateLimitEvent({ scope, outcome: 'limited', reason: result.reason || 'limit' });
      res.status(429).json({
        error: 'Too many requests. Please retry later.',
        retryAfterSeconds: retryAfter,
      });
      return false;
    }

    return true;
  };
}

export const enforceRateLimit = createRateLimitGuard();
