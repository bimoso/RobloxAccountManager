'use strict';

// Feature: account-browser-launcher, Property 25: Authorization header reflects the decrypted stored token
//
// Property-based test for Task 3.3 (account-browser-launcher).
// Validates: Requirements 9.3
//
// donutRequest() is the pure transport used by the Account_Browser_Launcher to
// talk to the Donut_Browser_API. main.js decrypts the stored Donut_API_Token and
// passes the plaintext value as the `token` argument. This test injects a fake
// http module (via opts.http) to capture the constructed request headers without
// a real network call, and asserts that:
//   - for any token value passed, the outgoing `Authorization` header equals
//     exactly `Bearer {token}`, and
//   - when no token is provided, no `Authorization` header is attached.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fc = require('fast-check');

const { donutRequest } = require('../src/donut-http');

// A minimal stand-in for Node's `http` module. It records the headers passed to
// http.request and drives donutRequest's resolve-never-reject flow to
// completion (fake 200 response) so the returned promise settles.
function makeFakeHttp() {
  const captured = { headers: null };

  const fakeHttp = {
    request(options, cb) {
      captured.headers = options.headers;

      const res = new EventEmitter();
      res.statusCode = 200;

      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.write = () => {};
      req.destroy = () => {};
      req.end = () => {
        // Deliver the response after donutRequest has attached its listeners.
        cb(res);
        process.nextTick(() => res.emit('end'));
      };

      return req;
    },
  };

  return { fakeHttp, captured };
}

const BASE_URL = 'http://127.0.0.1:10108';

// ── Property 25 ─────────────────────────────────────────────────────────────

test('Property 25: Authorization header reflects the decrypted stored token', async () => {
  await fc.assert(
    fc.asyncProperty(fc.string(), async (token) => {
      const { fakeHttp, captured } = makeFakeHttp();

      await donutRequest(BASE_URL, token, 'GET', '/status', null, {
        http: fakeHttp,
      });

      if (token) {
        // A non-empty (truthy) token must produce exactly `Bearer {token}`.
        assert.equal(captured.headers.Authorization, `Bearer ${token}`);
      } else {
        // An empty token is falsy: no Authorization header should be attached.
        assert.equal(captured.headers.Authorization, undefined);
      }
    }),
    { numRuns: 100 },
  );
});

test('Property 25: no Authorization header when no token is provided', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(undefined, null, ''),
      async (noToken) => {
        const { fakeHttp, captured } = makeFakeHttp();

        await donutRequest(BASE_URL, noToken, 'POST', '/open', { a: 1 }, {
          http: fakeHttp,
        });

        assert.equal(captured.headers.Authorization, undefined);
      },
    ),
    { numRuns: 100 },
  );
});

// A concrete example alongside the property, to make the expected shape obvious.
test('Property 25 (example): a specific token yields the exact Bearer header', async () => {
  const { fakeHttp, captured } = makeFakeHttp();

  await donutRequest(BASE_URL, 'tok-abc-123', 'GET', '/status', null, {
    http: fakeHttp,
  });

  assert.equal(captured.headers.Authorization, 'Bearer tok-abc-123');
});
