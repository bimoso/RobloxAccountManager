'use strict';

// Secret redaction helpers for the Account_Browser_Launcher (Req 6.1, 6.2, 6.4, 6.5).
//
// Extracted out of main.js (which can't be imported outside Electron) so the
// redaction logic can be unit/property tested directly. main.js requires this
// module and wraps redactSecrets/redactArgs with the set of secrets currently in
// play (the decrypted Donut_API_Token, plus any cookie value being handled) at
// every launcher sendLog call site and at any external-process argument list.
//
// The guarantee (design Properties 16/17): for a fixed minimum fragment length
// MIN_SECRET_FRAGMENT_LEN, no output produced by redactSecrets/redactArgs may
// contain the secret value OR any substring of it whose length is >= that
// minimum. A "fragment" therefore means any window of a secret at least this
// long -- so a leaked prefix, suffix, or middle slice of a cookie/token is
// scrubbed just like the whole value, while short incidental overlaps with
// ordinary log text (below the threshold) are left readable.

// The fixed minimum fragment length. Any run of >= this many characters that
// occurs inside a known secret is treated as sensitive and masked. Chosen large
// enough that ordinary words/ids in log text are not redacted by coincidence,
// yet small enough that no meaningful slice of a credential can survive.
const MIN_SECRET_FRAGMENT_LEN = 8;

// Human-readable marker left in place of a stripped secret fragment. Purely
// cosmetic: correctness never depends on the mask (see redactStringWith, which
// falls back to empty-string stripping if a mask ever interacted badly).
const DEFAULT_MASK = '[redacted]';

// Builds the set of every length-`minLen` window of every secret. Removing all
// of these from a string is what guarantees no >= minLen substring of any secret
// survives: any longer secret slice necessarily contains a length-minLen window,
// so eliminating the windows eliminates the longer slices too.
function buildFragmentSet(secrets, minLen) {
  const set = new Set();
  if (!Array.isArray(secrets)) return set;
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length < minLen) continue;
    for (let i = 0; i + minLen <= s.length; i++) set.add(s.slice(i, i + minLen));
  }
  return set;
}

// True iff `text` contains any length-minLen fragment from `frags`.
function containsFragment(text, frags, minLen) {
  if (typeof text !== 'string' || text.length < minLen || frags.size === 0) return false;
  for (let i = 0; i + minLen <= text.length; i++) {
    if (frags.has(text.slice(i, i + minLen))) return true;
  }
  return false;
}

// One left-to-right redaction pass: every maximal region whose every length-minLen
// window is a secret fragment collapses to a single `mask`. Non-matching text is
// copied verbatim.
function onePass(text, frags, minLen, mask) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (i + minLen <= n && frags.has(text.slice(i, i + minLen))) {
      // Extend across the maximal span every trailing window of which is a fragment.
      let j = i + minLen;
      while (j < n && frags.has(text.slice(j - minLen + 1, j + 1))) j++;
      out += mask;
      i = j;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

// Strips every >= minLen secret fragment from a single string.
//
// Runs the masking pass to a fixpoint so any fragment newly exposed by an earlier
// replacement is also caught. As a bulletproof backstop, if a (non-empty) mask
// ever interacts with surrounding text to leave a fragment behind, it re-strips
// with an empty mask -- which strictly shortens the string each pass and so
// terminates while provably removing all remaining fragments.
function redactStringWith(text, frags, minLen, mask) {
  if (typeof text !== 'string' || frags.size === 0 || text.length < minLen) return text;
  let cur = text;
  for (let pass = 0; pass < 50; pass++) {
    const next = onePass(cur, frags, minLen, mask);
    if (next === cur) break;
    cur = next;
  }
  if (containsFragment(cur, frags, minLen)) {
    for (let pass = 0; pass < 1000 && containsFragment(cur, frags, minLen); pass++) {
      cur = onePass(cur, frags, minLen, '');
    }
  }
  return cur;
}

// Recursively redacts a value: strings are scrubbed, arrays/objects are walked
// (both keys and values, in case a secret ends up used as an object key), and
// everything else is returned unchanged. Circular references are guarded.
function redactValue(value, frags, minLen, mask, seen) {
  if (typeof value === 'string') return redactStringWith(value, frags, minLen, mask);
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, frags, minLen, mask, seen));
  const out = {};
  for (const k of Object.keys(value)) {
    const rk = redactStringWith(k, frags, minLen, mask);
    out[rk] = redactValue(value[k], frags, minLen, mask, seen);
  }
  return out;
}

// Picks the effective mask: the caller's mask, unless that mask itself contains a
// secret fragment (which would defeat the purpose), in which case empty-string
// stripping is used instead.
function effectiveMask(mask, frags, minLen) {
  const m = mask != null ? mask : DEFAULT_MASK;
  return containsFragment(m, frags, minLen) ? '' : m;
}

// Public: redact any secret fragments out of a log message string, a metadata
// object/array, or any nested combination thereof (Req 6.1, 6.4). Returns a new,
// scrubbed value; the input is never mutated. Passing no/short/empty secrets is a
// no-op that returns the value unchanged.
//
//   value   - string | object | array | primitive to scrub
//   secrets - array of secret strings (cookie value, Donut_API_Token value)
//   opts    - { minLen = MIN_SECRET_FRAGMENT_LEN, mask = DEFAULT_MASK }
function redactSecrets(value, secrets, opts = {}) {
  const minLen = opts.minLen || MIN_SECRET_FRAGMENT_LEN;
  const frags = buildFragmentSet(secrets || [], minLen);
  if (frags.size === 0) return value;
  const mask = effectiveMask(opts.mask, frags, minLen);
  return redactValue(value, frags, minLen, mask, new Set());
}

// Public: redact any secret fragments out of an argument list constructed for an
// external process (Req 6.2, 6.5). Returns a new array; non-string entries pass
// through untouched. A launcher that never places a secret on a command line
// still routes its arg lists through here as defense in depth.
function redactArgs(args, secrets, opts = {}) {
  if (!Array.isArray(args)) return args;
  const minLen = opts.minLen || MIN_SECRET_FRAGMENT_LEN;
  const frags = buildFragmentSet(secrets || [], minLen);
  if (frags.size === 0) return args.slice();
  const mask = effectiveMask(opts.mask, frags, minLen);
  return args.map((a) => (typeof a === 'string' ? redactStringWith(a, frags, minLen, mask) : a));
}

// Public: builds the account-identifying fields for a log entry about an action
// involving that Account's cookie (Req 6.3 / design Property 18). Includes the
// username when present and the userId when present, guaranteeing at least one of
// the two is emitted whenever either is available -- and never includes the
// cookie itself. Absent/empty identifiers are simply omitted.
function accountLogIdentity(account) {
  const out = {};
  if (account) {
    if (account.username != null && account.username !== '') out.username = account.username;
    if (account.userId != null && account.userId !== '') out.userId = account.userId;
  }
  return out;
}

module.exports = {
  MIN_SECRET_FRAGMENT_LEN,
  DEFAULT_MASK,
  redactSecrets,
  redactArgs,
  accountLogIdentity,
};
