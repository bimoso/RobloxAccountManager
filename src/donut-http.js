'use strict';

// Plain-HTTP transport for the Donut Browser local API (the Donut_Browser_API).
//
// Extracted out of main.js (which can't be imported outside Electron) so the
// request construction and result classification can be unit/property tested
// directly against an in-process http server. main.js requires this module and
// wraps donutRequest with getDonutBaseUrl()/getDonutToken() (which read the
// encrypted settings) as donutHttp(method, urlPath, body).
//
// This mirrors main.js's httpsGet/httpsPost posture: no third-party HTTP client
// (Node's built-in `http` module only), a hard request timeout, JSON body
// encoding, and a resolve-never-reject contract so callers branch on a
// classified result instead of catching exceptions.

const http = require('http');

const DEFAULT_DONUT_PORT = 10108;
const DEFAULT_TIMEOUT_MS = 5000;

// Builds the Donut Browser local API base URL from a port. Falls back to the
// documented default port (10108) when the port is absent/falsy.
function buildDonutBaseUrl(port) {
  return `http://127.0.0.1:${port || DEFAULT_DONUT_PORT}`;
}

// Performs a single request to the Donut Browser local API.
//
// All inputs are injected (baseUrl, token, method, path, body), so this stays
// pure with respect to app state and is testable without Electron. `opts.http`
// lets tests inject a fake http module, and `opts.timeoutMs` overrides the
// default request timeout.
//
// Always resolves (never rejects) with:
//   { ok, status, json, error }
// where:
//   ok:     true  iff a response arrived with a 2xx status
//   status: the numeric HTTP status, or 0 when no response was received
//   json:   the parsed JSON response body, or null when absent/unparseable
//   error:  'unreachable' -> no response (connection refused / socket error / timeout)
//           'http'        -> a response arrived but its status was not 2xx
//           null          -> success
//
// The Authorization header is only attached when a token is provided; callers
// that require a token (per Req 9.6) gate on that before calling.
function donutRequest(baseUrl, token, method, urlPath, body, opts = {}) {
  const httpMod = opts.http || http;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(urlPath, baseUrl);
    } catch {
      // A malformed base URL / path can never reach Donut Browser.
      resolve({ ok: false, status: 0, json: null, error: 'unreachable' });
      return;
    }

    const bodyBuf = body != null ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': bodyBuf.length,
      'Accept': 'application/json',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = httpMod.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json = null;
        if (data) { try { json = JSON.parse(data); } catch { json = null; } }
        const status = res.statusCode || 0;
        const ok = status >= 200 && status < 300;
        resolve({ ok, status, json, error: ok ? null : 'http' });
      });
    });
    req.on('error', () => resolve({ ok: false, status: 0, json: null, error: 'unreachable' }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ ok: false, status: 0, json: null, error: 'unreachable' });
    });

    if (bodyBuf.length) req.write(bodyBuf);
    req.end();
  });
}

// Classifies the outcome of the Donut_Browser_API reachability/auth preflight
// (Req 3.1-3.4, 3.8, 9.6; Property 8, Property 27) into the single availability
// result the launcher gates on:
//   { ok, error: null | 'unreachable' | 'unauthorized' | 'payment_required' | 'no_token' }
//
// Pure so it can be property-tested directly. Inputs:
//   hasToken - whether a Donut_API_Token is stored (checked first: a missing
//              token short-circuits with 'no_token' before any request is made,
//              Req 9.6 / Property 27 — the caller must not call donutRequest).
//   result   - the { ok, status, error } from a donutRequest reachability call
//              (only consulted when hasToken is true).
//
// Classification (Req 3.2/3.3/3.4/3.8, Property 8):
//   no token                    -> { ok:false, error:'no_token' }
//   no response (unreachable)   -> { ok:false, error:'unreachable' }
//   HTTP 401                    -> { ok:false, error:'unauthorized' }
//   HTTP 402                    -> { ok:false, error:'payment_required' }
//   HTTP 2xx                    -> { ok:true,  error:null }
//   any other non-2xx status    -> { ok:false, error:'unreachable' }
function classifyAvailability(hasToken, result) {
  if (!hasToken) return { ok: false, error: 'no_token' };
  if (!result || result.error === 'unreachable') return { ok: false, error: 'unreachable' };
  if (result.status === 401) return { ok: false, error: 'unauthorized' };
  if (result.status === 402) return { ok: false, error: 'payment_required' };
  if (result.ok) return { ok: true, error: null };
  return { ok: false, error: 'unreachable' };
}

module.exports = { donutRequest, buildDonutBaseUrl, classifyAvailability, DEFAULT_DONUT_PORT };
