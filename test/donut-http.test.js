'use strict';

// Integration tests for donutRequest() against an in-process HTTP server.
//
// Task 3.2 (account-browser-launcher). Covers Requirements 3.1 and 3.2:
// verifies the real request construction (method, path, headers including the
// Bearer Authorization header, JSON body encoding) end-to-end against a
// stand-in for the Donut_Browser_API started with Node's own http.createServer,
// and verifies the 'unreachable' classification when no server is listening and
// when a request times out.
//
// This is the boundary the property tests (which mock donutHttp itself) don't
// exercise: it uses a real socket, real http.request, and a real server.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { donutRequest } = require('../src/donut-http');

// Starts an in-process HTTP server standing in for Donut Browser. The handler
// receives (req, collectedBodyString, res) so each test can assert on the
// captured request and shape the response. Resolves with { baseUrl, close, last }
// where `last` is populated with the most recent captured request details.
function startFixture(handler) {
  return new Promise((resolve) => {
    const captured = {};
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        captured.method = req.method;
        captured.url = req.url;
        captured.headers = req.headers;
        captured.body = body;
        handler(req, body, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        captured,
        close: () =>
          new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ── Request construction: method, path, headers, Authorization ──────────────

test('sends the given method and path, and a Bearer Authorization header', async () => {
  const fixture = await startFixture((req, body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  try {
    const result = await donutRequest(
      fixture.baseUrl,
      'my-secret-token',
      'GET',
      '/v1/profiles',
      null,
    );

    assert.equal(fixture.captured.method, 'GET');
    assert.equal(fixture.captured.url, '/v1/profiles');
    assert.equal(
      fixture.captured.headers['authorization'],
      'Bearer my-secret-token',
    );
    assert.equal(fixture.captured.headers['accept'], 'application/json');
    assert.equal(fixture.captured.headers['content-type'], 'application/json');

    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { ok: true });
    assert.equal(result.error, null);
  } finally {
    await fixture.close();
  }
});

test('preserves the query string on the request path', async () => {
  const fixture = await startFixture((req, body, res) => {
    res.writeHead(200);
    res.end('{}');
  });

  try {
    await donutRequest(fixture.baseUrl, 't', 'GET', '/v1/profiles?limit=5', null);
    assert.equal(fixture.captured.url, '/v1/profiles?limit=5');
  } finally {
    await fixture.close();
  }
});

test('omits the Authorization header when no token is provided', async () => {
  const fixture = await startFixture((req, body, res) => {
    res.writeHead(200);
    res.end('{}');
  });

  try {
    await donutRequest(fixture.baseUrl, null, 'GET', '/v1/profiles', null);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        fixture.captured.headers,
        'authorization',
      ),
      false,
      'Authorization header must be absent when no token is supplied',
    );
  } finally {
    await fixture.close();
  }
});

// ── JSON body encoding ──────────────────────────────────────────────────────

test('encodes a JSON body and sets a matching Content-Length', async () => {
  const fixture = await startFixture((req, body, res) => {
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'profile-1' }));
  });

  try {
    const payload = { name: 'account-a', engine: 'wayfern' };
    const result = await donutRequest(
      fixture.baseUrl,
      'tok',
      'POST',
      '/v1/profiles',
      payload,
    );

    assert.equal(fixture.captured.method, 'POST');
    const expectedBody = JSON.stringify(payload);
    assert.equal(fixture.captured.body, expectedBody);
    assert.equal(
      fixture.captured.headers['content-length'],
      String(Buffer.byteLength(expectedBody)),
    );

    assert.equal(result.ok, true);
    assert.equal(result.status, 201);
    assert.deepEqual(result.json, { id: 'profile-1' });
    assert.equal(result.error, null);
  } finally {
    await fixture.close();
  }
});

test('sends an empty body with zero Content-Length when body is null', async () => {
  const fixture = await startFixture((req, body, res) => {
    res.writeHead(200);
    res.end('{}');
  });

  try {
    await donutRequest(fixture.baseUrl, 'tok', 'DELETE', '/v1/profiles/p1', null);
    assert.equal(fixture.captured.body, '');
    assert.equal(fixture.captured.headers['content-length'], '0');
    assert.equal(fixture.captured.method, 'DELETE');
  } finally {
    await fixture.close();
  }
});

// ── Result classification for non-2xx and non-JSON responses ────────────────

test('classifies a non-2xx response as an http error while capturing status/json', async () => {
  const fixture = await startFixture((req, body, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'invalid token' }));
  });

  try {
    const result = await donutRequest(fixture.baseUrl, 'bad', 'GET', '/v1/profiles', null);
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.deepEqual(result.json, { message: 'invalid token' });
    assert.equal(result.error, 'http');
  } finally {
    await fixture.close();
  }
});

test('returns json: null for a 2xx response with a non-JSON body', async () => {
  const fixture = await startFixture((req, body, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('not json');
  });

  try {
    const result = await donutRequest(fixture.baseUrl, 'tok', 'GET', '/v1/ping', null);
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(result.json, null);
    assert.equal(result.error, null);
  } finally {
    await fixture.close();
  }
});

// ── 'unreachable' classification ────────────────────────────────────────────

test("classifies a refused connection (no server listening) as 'unreachable'", async () => {
  // Bind a server to grab a free port, then close it so nothing is listening
  // there — connecting yields ECONNREFUSED, which must map to 'unreachable'.
  const fixture = await startFixture(() => {});
  const deadBaseUrl = fixture.baseUrl;
  await fixture.close();

  const result = await donutRequest(deadBaseUrl, 'tok', 'GET', '/v1/profiles', null);
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.json, null);
  assert.equal(result.error, 'unreachable');
});

test("classifies a request that exceeds the timeout as 'unreachable'", async () => {
  // The server accepts the connection but never responds, so the client-side
  // request timeout must fire and produce the 'unreachable' classification.
  const fixture = await startFixture((req, body, res) => {
    // Intentionally never call res.end() — hold the request open.
  });

  try {
    const result = await donutRequest(
      fixture.baseUrl,
      'tok',
      'GET',
      '/v1/profiles',
      null,
      { timeoutMs: 100 },
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.equal(result.json, null);
    assert.equal(result.error, 'unreachable');
  } finally {
    await fixture.close();
  }
});

test("classifies a malformed base URL as 'unreachable' without throwing", async () => {
  const result = await donutRequest('not a url', 'tok', 'GET', '/v1/profiles', null);
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.error, 'unreachable');
});
