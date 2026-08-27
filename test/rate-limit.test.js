import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_RATE_LIMITS,
  createRateLimitGuard,
  getRateLimitConfig,
  getTrustedClientIp,
  makeRateLimitIdentifier,
} from '../api/_rate-limit.js';

function createResponse() {
  return {
    headers: new Map(),
    statusCode: 200,
    payload: undefined,
    setHeader(name, value) {
      this.headers.set(name.toLowerCase(), value);
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.payload = value;
      return this;
    },
  };
}

function makeSetup(result, calls) {
  const limit = async (identifier) => {
    calls.push(identifier);
    return typeof result === 'function' ? result(identifier) : result;
  };
  return {
    config: { windowSeconds: 600, auditMax: 12, sitemapMax: 2 },
    secret: 'test-hmac-secret-with-sufficient-length',
    limiters: { audit: { limit }, sitemap: { limit } },
  };
}

const now = () => 1_200_000;
const testEnv = { NODE_ENV: 'test' };

test('uses secure defaults and accepts only positive integer overrides', () => {
  assert.deepEqual(getRateLimitConfig({}), DEFAULT_RATE_LIMITS);
  assert.deepEqual(getRateLimitConfig({
    RATE_LIMIT_WINDOW_SECONDS: '120',
    RATE_LIMIT_AUDIT_MAX: '7',
    RATE_LIMIT_SITEMAP_MAX: '3',
  }), { windowSeconds: 120, auditMax: 7, sitemapMax: 3 });
  assert.deepEqual(getRateLimitConfig({
    RATE_LIMIT_WINDOW_SECONDS: '0',
    RATE_LIMIT_AUDIT_MAX: '-2',
    RATE_LIMIT_SITEMAP_MAX: 'not-a-number',
  }), DEFAULT_RATE_LIMITS);
});

test('uses Vercel client IP before x-forwarded-for and accepts only the first address', () => {
  assert.equal(getTrustedClientIp({
    headers: {
      'x-vercel-forwarded-for': '203.0.113.8',
      'x-forwarded-for': '198.51.100.7, 198.51.100.6',
    },
  }), '203.0.113.8');
  assert.equal(getTrustedClientIp({ headers: { 'x-forwarded-for': '198.51.100.7, 198.51.100.6' } }), '198.51.100.7');
  assert.equal(getTrustedClientIp({ headers: {} }), 'missing');
});

test('pseudonymizes identifiers and changes them by scope and window', () => {
  const config = { secret: 'test-hmac-secret-with-sufficient-length', windowSeconds: 600 };
  const first = makeRateLimitIdentifier({ scope: 'audit', clientIp: '203.0.113.8', ...config, now: () => 1_200_000 });
  const repeat = makeRateLimitIdentifier({ scope: 'audit', clientIp: '203.0.113.8', ...config, now: () => 1_200_001 });
  const otherScope = makeRateLimitIdentifier({ scope: 'sitemap', clientIp: '203.0.113.8', ...config, now: () => 1_200_001 });
  const nextWindow = makeRateLimitIdentifier({ scope: 'audit', clientIp: '203.0.113.8', ...config, now: () => 1_800_000 });

  assert.equal(first, repeat);
  assert.notEqual(first, otherScope);
  assert.notEqual(first, nextWindow);
  assert.equal(first.includes('203.0.113.8'), false);
});

test('permits a request and emits non-sensitive rate limit headers', async () => {
  const calls = [];
  const guard = createRateLimitGuard({
    getLimiters: () => makeSetup({ success: true, limit: 12, remaining: 11, reset: 1_800_000 }, calls),
    now,
    env: testEnv,
  });
  const response = createResponse();
  const allowed = await guard({ headers: { 'x-vercel-forwarded-for': '203.0.113.8' } }, response, 'audit');

  assert.equal(allowed, true);
  assert.equal(response.headers.get('ratelimit-limit'), '12');
  assert.equal(response.headers.get('ratelimit-remaining'), '11');
  assert.equal(response.headers.get('ratelimit-reset'), '1800');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes('203.0.113.8'), false);
});

test('returns 429 with Retry-After when the audit limit is exhausted', async () => {
  const guard = createRateLimitGuard({
    getLimiters: () => makeSetup({ success: false, limit: 12, remaining: 0, reset: 1_205_000 }, []),
    now,
    env: testEnv,
  });
  const response = createResponse();
  const allowed = await guard({ headers: { 'x-vercel-forwarded-for': '203.0.113.8' } }, response, 'audit');

  assert.equal(allowed, false);
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers.get('retry-after'), '5');
  assert.equal(response.headers.get('ratelimit-remaining'), '0');
  assert.equal(response.payload.retryAfterSeconds, 5);
});

test('uses a separate sitemap bucket', async () => {
  const calls = [];
  const guard = createRateLimitGuard({
    getLimiters: () => makeSetup({ success: true, limit: 2, remaining: 1, reset: 1_800_000 }, calls),
    now,
    env: testEnv,
  });
  const response = createResponse();
  const allowed = await guard({ headers: { 'x-vercel-forwarded-for': '203.0.113.8' } }, response, 'sitemap');

  assert.equal(allowed, true);
  assert.equal(response.headers.get('ratelimit-limit'), '2');
  assert.equal(calls.length, 1);
});

test('fails closed with 503 when the provider times out or throws', async (t) => {
  for (const [name, getLimiters] of [
    ['timeout result', () => makeSetup({ success: true, limit: 12, remaining: 12, reset: 1_800_000, reason: 'timeout' }, [])],
    ['provider exception', () => ({
      config: { windowSeconds: 600 },
      secret: 'test-hmac-secret-with-sufficient-length',
      limiters: { audit: { limit: async () => { throw new Error('network failed'); } } },
    })],
    ['missing configuration', () => { throw new Error('missing config'); }],
  ]) {
    await t.test(name, async () => {
      const guard = createRateLimitGuard({ getLimiters, now, env: testEnv });
      const response = createResponse();
      const allowed = await guard({ headers: {} }, response, 'audit');

      assert.equal(allowed, false);
      assert.equal(response.statusCode, 503);
      assert.equal(response.headers.get('retry-after'), '30');
    });
  }
});

test('supports an explicit test-only bypass for independent endpoint regression tests', async () => {
  const guard = createRateLimitGuard({
    getLimiters: () => { throw new Error('should not construct a limiter'); },
    now,
    env: { NODE_ENV: 'test', RATE_LIMIT_TEST_BYPASS: 'true' },
  });
  const response = createResponse();

  assert.equal(await guard({ headers: {} }, response, 'audit'), true);
  assert.equal(response.statusCode, 200);
});
