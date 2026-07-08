'use strict';

// Feature: account-browser-launcher, Property 8: Availability/auth response classification
//
// Property-based test for Task 4.2 (account-browser-launcher).
// Validates: Requirements 3.2, 3.3, 3.4, 3.8
//
// classifyAvailability(hasToken, result) is the pure classifier the launcher
// uses to turn a Donut_Browser_API reachability/auth response into the single
// availability outcome it gates on. This test generates arbitrary donutRequest
// results (statuses + error classifications) plus the has-token flag and asserts
// the classification matches the spec for each case:
//
//   no token                  -> { ok:false, error:'no_token' }
//   no response (unreachable) -> { ok:false, error:'unreachable' }
//   HTTP 401                  -> { ok:false, error:'unauthorized' }
//   HTTP 402                  -> { ok:false, error:'payment_required' }
//   HTTP 2xx                  -> { ok:true,  error:null }
//   any other non-2xx status  -> { ok:false, error:'unreachable' }
//
// In all non-ok cases the result must be ok:false, which the launcher relies on
// to NOT open a Browser_Instance (Req 3.8).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { classifyAvailability } = require('../src/donut-http');

// Build a donutRequest-shaped result for a given HTTP status, mirroring exactly
// how donutRequest classifies a response that arrived: ok iff 2xx, error 'http'
// for a non-2xx response, null on success.
function httpResult(status) {
  const ok = status >= 200 && status < 300;
  return { ok, status, json: null, error: ok ? null : 'http' };
}

// The unreachable result donutRequest produces when no response arrives
// (connection refused / socket error / timeout).
const UNREACHABLE_RESULT = { ok: false, status: 0, json: null, error: 'unreachable' };

// Independent oracle derived straight from the spec's natural-language mapping.
// Precedence: token presence first, then transport reachability, then the
// distinct auth/payment statuses, then success, then everything else.
function expectedClassification(hasToken, result) {
  if (!hasToken) return { ok: false, error: 'no_token' };
  if (!result || result.error === 'unreachable') return { ok: false, error: 'unreachable' };
  if (result.status === 401) return { ok: false, error: 'unauthorized' };
  if (result.status === 402) return { ok: false, error: 'payment_required' };
  if (result.status >= 200 && result.status < 300) return { ok: true, error: null };
  return { ok: false, error: 'unreachable' };
}

// ── Property 8 ──────────────────────────────────────────────────────────────

test('Property 8: classification matches the spec across arbitrary results', async () => {
  // A result is either the unreachable transport result or an HTTP result for
  // some status in the full range (covering 401, 402, 2xx, and other non-2xx).
  const arbResult = fc.oneof(
    fc.constant(UNREACHABLE_RESULT),
    fc.integer({ min: 100, max: 599 }).map(httpResult),
  );

  await fc.assert(
    fc.asyncProperty(fc.boolean(), arbResult, async (hasToken, result) => {
      const actual = classifyAvailability(hasToken, result);
      const expected = expectedClassification(hasToken, result);
      assert.deepEqual(actual, expected);

      // Cross-check the safety invariant: only a 2xx response with a token is ok.
      if (actual.ok) {
        assert.equal(hasToken, true);
        assert.ok(result.status >= 200 && result.status < 300);
      }
    }),
    { numRuns: 200 },
  );
});

test('Property 8: HTTP 401 always classifies as unauthorized (with a token)', async () => {
  await fc.assert(
    fc.asyncProperty(fc.constant(401), async (status) => {
      const r = classifyAvailability(true, httpResult(status));
      assert.deepEqual(r, { ok: false, error: 'unauthorized' });
    }),
    { numRuns: 100 },
  );
});

test('Property 8: HTTP 402 always classifies as payment_required (with a token)', async () => {
  await fc.assert(
    fc.asyncProperty(fc.constant(402), async (status) => {
      const r = classifyAvailability(true, httpResult(status));
      assert.deepEqual(r, { ok: false, error: 'payment_required' });
    }),
    { numRuns: 100 },
  );
});

test('Property 8: any 2xx status classifies as ok (with a token)', async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 200, max: 299 }), async (status) => {
      const r = classifyAvailability(true, httpResult(status));
      assert.deepEqual(r, { ok: true, error: null });
    }),
    { numRuns: 100 },
  );
});

test('Property 8: other non-2xx statuses (not 401/402) classify as unreachable', async () => {
  const otherStatus = fc
    .integer({ min: 100, max: 599 })
    .filter((s) => (s < 200 || s >= 300) && s !== 401 && s !== 402);

  await fc.assert(
    fc.asyncProperty(otherStatus, async (status) => {
      const r = classifyAvailability(true, httpResult(status));
      assert.deepEqual(r, { ok: false, error: 'unreachable' });
    }),
    { numRuns: 100 },
  );
});

test('Property 8: an unreachable transport result classifies as unreachable (with a token)', async () => {
  await fc.assert(
    fc.asyncProperty(fc.constant(UNREACHABLE_RESULT), async (result) => {
      const r = classifyAvailability(true, result);
      assert.deepEqual(r, { ok: false, error: 'unreachable' });
    }),
    { numRuns: 100 },
  );
});

test('Property 8: no stored token short-circuits to no_token regardless of response', async () => {
  const arbResult = fc.oneof(
    fc.constant(UNREACHABLE_RESULT),
    fc.integer({ min: 100, max: 599 }).map(httpResult),
    fc.constant(null),
    fc.constant(undefined),
  );

  await fc.assert(
    fc.asyncProperty(arbResult, async (result) => {
      const r = classifyAvailability(false, result);
      assert.deepEqual(r, { ok: false, error: 'no_token' });
    }),
    { numRuns: 100 },
  );
});
