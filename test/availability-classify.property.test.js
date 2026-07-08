'use strict';

// Feature: account-browser-launcher, Property 8: Availability/auth response classification
//
// Property-based test for Task 4.2 (account-browser-launcher).
// Validates: Requirements 3.2, 3.3, 3.4, 3.8
//
// classifyAvailability(hasToken, result) is the pure classifier the launcher
// uses to turn a Donut_Browser_API reachability/auth response into the single
// availability outcome it gates on. Generating arbitrary donutRequest-shaped
// results { ok, status, error } (with hasToken=true) and asserting the
// documented classification per status/error:
//
//   no response (unreachable) -> { ok:false, error:'unreachable' }
//   HTTP 401                  -> { ok:false, error:'unauthorized'    }  (Req 3.3)
//   HTTP 402                  -> { ok:false, error:'payment_required' } (Req 3.4)
//   HTTP 2xx                  -> { ok:true,  error:null }
//   any other non-2xx status  -> { ok:false, error:'unreachable' }      (Req 3.2)
//
// Every non-2xx / no-response case yields ok:false, which is exactly what the
// launcher relies on to NOT open a Browser_Instance (Req 3.8).

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
// (hasToken is fixed true for this property; the missing-token case is Property 27.)
function expectedForHttp(status) {
  if (status === 401) return { ok: false, error: 'unauthorized' };
  if (status === 402) return { ok: false, error: 'payment_required' };
  if (status >= 200 && status < 300) return { ok: true, error: null };
  return { ok: false, error: 'unreachable' };
}

// ── Property 8 ──────────────────────────────────────────────────────────────

test('Property 8: with a token, classification matches the spec across arbitrary responses', async () => {
  // A response is either the transport "unreachable" result or an HTTP result
  // for a status spanning the whole range (covers 401, 402, 2xx, other non-2xx).
  const arbResult = fc.oneof(
    fc.constant(UNREACHABLE_RESULT),
    fc.integer({ min: 100, max: 599 }).map(httpResult),
  );

  await fc.assert(
    fc.asyncProperty(arbResult, async (result) => {
      const actual = classifyAvailability(true, result);
      const expected =
        result.error === 'unreachable'
          ? { ok: false, error: 'unreachable' }
          : expectedForHttp(result.status);

      assert.deepEqual(actual, expected);

      // Safety invariant behind Req 3.8: only a genuine 2xx response is "ok"
      // (never open a Browser_Instance for unreachable / 401 / 402 / other).
      if (actual.ok) {
        assert.ok(result.status >= 200 && result.status < 300);
      } else {
        assert.equal(actual.ok, false);
      }
    }),
    { numRuns: 100 },
  );
});

test('Property 8: HTTP 401 always classifies as unauthorized (Req 3.3)', async () => {
  await fc.assert(
    fc.asyncProperty(fc.constant(401), async (status) => {
      assert.deepEqual(classifyAvailability(true, httpResult(status)), {
        ok: false,
        error: 'unauthorized',
      });
    }),
    { numRuns: 100 },
  );
});

test('Property 8: HTTP 402 always classifies as payment_required (Req 3.4)', async () => {
  await fc.assert(
    fc.asyncProperty(fc.constant(402), async (status) => {
      assert.deepEqual(classifyAvailability(true, httpResult(status)), {
        ok: false,
        error: 'payment_required',
      });
    }),
    { numRuns: 100 },
  );
});

test('Property 8: any 2xx status classifies as ok', async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 200, max: 299 }), async (status) => {
      assert.deepEqual(classifyAvailability(true, httpResult(status)), {
        ok: true,
        error: null,
      });
    }),
    { numRuns: 100 },
  );
});

test('Property 8: other non-2xx statuses (not 401/402) classify as unreachable (Req 3.2)', async () => {
  const otherStatus = fc
    .integer({ min: 100, max: 599 })
    .filter((s) => (s < 200 || s >= 300) && s !== 401 && s !== 402);

  await fc.assert(
    fc.asyncProperty(otherStatus, async (status) => {
      assert.deepEqual(classifyAvailability(true, httpResult(status)), {
        ok: false,
        error: 'unreachable',
      });
    }),
    { numRuns: 100 },
  );
});

test('Property 8: an unreachable transport result classifies as unreachable', async () => {
  await fc.assert(
    fc.asyncProperty(fc.constant(UNREACHABLE_RESULT), async (result) => {
      assert.deepEqual(classifyAvailability(true, result), {
        ok: false,
        error: 'unreachable',
      });
    }),
    { numRuns: 100 },
  );
});
