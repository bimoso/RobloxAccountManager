'use strict';

// Feature: account-browser-launcher, Property 27: Missing token blocks all Donut calls
//
// Property-based test for Task 4.3 (account-browser-launcher).
// Validates: Requirements 9.6
//
// Requirement 9.6 / Property 27: when no Donut_API_Token is stored, an
// "Open in Browser" attempt SHALL surface an error directing the user to
// Settings and SHALL NOT send any request to the Donut_Browser_API.
//
// The pure decision point is classifyAvailability(hasToken, result) in
// src/donut-http.js: with hasToken=false it must short-circuit to
// { ok:false, error:'no_token' } for ANY result value, without consulting the
// result at all. The operational invariant ("no request is ever issued") is
// modelled here by reproducing checkDonutAvailability's control flow — token
// check first, transport only when a token exists — and asserting, via a spy
// transport, that the transport is never invoked when the token is absent.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { classifyAvailability } = require('../src/donut-http');

// Faithful model of main.js's checkDonutAvailability() control flow, wired to an
// injected transport spy so we can observe whether any Donut_Browser_API request
// would be issued. The ordering mirrors the design's sequence diagram: the token
// presence is checked BEFORE any call to the transport (donutRequest).
async function checkDonutAvailabilityModel(hasToken, transport) {
  if (!hasToken) {
    // Req 9.6 / Property 27: short-circuit BEFORE touching the transport.
    return classifyAvailability(false, null);
  }
  const result = await transport();
  return classifyAvailability(true, result);
}

// An arbitrary standing in for any possible donutRequest() result value — the
// classification must ignore it entirely when the token is missing.
const anyResult = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.record({
    ok: fc.boolean(),
    status: fc.integer({ min: 0, max: 599 }),
    json: fc.oneof(fc.constant(null), fc.object()),
    error: fc.constantFrom(null, 'unreachable', 'http'),
  }),
);

// ── Property 27 ─────────────────────────────────────────────────────────────

test('Property 27: classifyAvailability(false, ...) is always no_token for any result', async () => {
  await fc.assert(
    fc.property(anyResult, (result) => {
      const out = classifyAvailability(false, result);
      assert.deepEqual(out, { ok: false, error: 'no_token' });
    }),
    { numRuns: 100 },
  );
});

test('Property 27: a missing token never issues any Donut_Browser_API request', async () => {
  await fc.assert(
    fc.asyncProperty(anyResult, async (result) => {
      let transportCalls = 0;
      const spyTransport = async () => {
        transportCalls += 1;
        return result;
      };

      const out = await checkDonutAvailabilityModel(false, spyTransport);

      // The transport (donutRequest) must never be invoked without a token.
      assert.equal(transportCalls, 0);
      // And the surfaced result must be the no_token error that drives the
      // "configure your token in Settings" message.
      assert.deepEqual(out, { ok: false, error: 'no_token' });
    }),
    { numRuns: 100 },
  );
});

// A concrete example alongside the property, to make the expected shape obvious.
test('Property 27 (example): no token short-circuits to no_token without a request', async () => {
  let transportCalls = 0;
  const spyTransport = async () => {
    transportCalls += 1;
    return { ok: true, status: 200, json: null, error: null };
  };

  const out = await checkDonutAvailabilityModel(false, spyTransport);

  assert.equal(transportCalls, 0);
  assert.deepEqual(out, { ok: false, error: 'no_token' });
});
