import assert from 'node:assert/strict';
import test from 'node:test';

import auditHandler, { createAuditHandler } from '../api/audit.js';
import sitemapHandler, { createSitemapHandler } from '../api/sitemap.js';

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_TEST_BYPASS = 'true';

function createResponse() {
  return {
    headers: new Map(),
    statusCode: 200,
    payload: undefined,
    ended: false,
    setHeader(name, value) {
      this.headers.set(name.toLowerCase(), value);
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.payload = value;
      this.ended = true;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

for (const [name, handler, createHandler, scope] of [
  ['audit', auditHandler, createAuditHandler, 'audit'],
  ['sitemap', sitemapHandler, createSitemapHandler, 'sitemap'],
]) {
  test(`${name} rejects non-GET methods`, async () => {
    const response = createResponse();
    await handler({ method: 'POST', query: {} }, response);

    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.get('allow'), 'GET, OPTIONS');
    assert.deepEqual(response.payload, { error: 'Method not allowed.' });
  });

  test(`${name} rejects a private target before fetching`, async () => {
    const response = createResponse();
    await handler({ method: 'GET', query: { url: 'http://127.0.0.1/' } }, response);

    assert.equal(response.statusCode, 400);
    assert.match(response.payload.error, /public HTTP\(S\)/);
  });

  test(`${name} returns 429 before target validation or outbound fetch`, async () => {
    const guardCalls = [];
    const rateLimitedHandler = createHandler({
      rateLimitGuard: async (_req, response, receivedScope) => {
        guardCalls.push(receivedScope);
        response.status(429).json({ error: 'Too many requests. Please retry later.' });
        return false;
      },
    });
    const response = createResponse();
    await rateLimitedHandler({ method: 'GET', query: { url: 'http://127.0.0.1/' } }, response);

    assert.deepEqual(guardCalls, [scope]);
    assert.equal(response.statusCode, 429);
    assert.deepEqual(response.payload, { error: 'Too many requests. Please retry later.' });
  });
}
