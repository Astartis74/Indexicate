import assert from 'node:assert/strict';
import test from 'node:test';

import auditHandler from '../api/audit.js';
import sitemapHandler from '../api/sitemap.js';

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

for (const [name, handler] of [
  ['audit', auditHandler],
  ['sitemap', sitemapHandler],
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
}
