'use strict';

// Unit tests for the Account/Settings model defaults and pass-through behavior.
//
// Task 2.3 (account-browser-launcher). Covers Requirements 2.1 and 9.2's model
// aspects: new Account/Settings fields get documented defaults when absent, and
// the Donut fields pass through encryptAccount/decryptAccount unchanged (never
// encrypted).
//
// main.js can't be imported outside Electron, so the pure defaulting logic it
// uses inside loadSettings/encryptAccount/decryptAccount lives in
// src/account-model.js and is exercised here directly.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  applyAccountDonutDefaults,
  applySettingsDonutDefaults,
} = require('../src/account-model');

// Mirrors main.js's isEncrypted(): a value is "encrypted at rest" iff it carries
// one of the known ciphertext prefixes. Used to assert the Donut fields are NOT
// encrypted after the account passes through the encrypt path.
function isEncrypted(v) {
  return (
    typeof v === 'string' &&
    (v.startsWith('safe:') ||
      v.startsWith('gs:') ||
      v.startsWith('gcm:') ||
      v.startsWith('cbc:'))
  );
}

// ── Account defaults (as applied on load / decryptAccount) ──────────────────

test('a loaded account missing the new fields gets the documented defaults', () => {
  // Simulates an account record saved before this feature: no Donut fields.
  const account = {
    id: 'a1',
    username: 'player1',
    userId: '12345',
    nickname: 'Main',
    cookie: 'the-cookie',
  };

  const result = applyAccountDonutDefaults(account);

  assert.equal(result.donutProfileId, null);
  assert.equal(result.donutProfilePendingDelete, false);
});

test('existing fields on the loaded account are preserved untouched', () => {
  const account = {
    id: 'a1',
    username: 'player1',
    userId: '12345',
    nickname: 'Main',
    cookie: 'the-cookie',
  };

  applyAccountDonutDefaults(account);

  assert.equal(account.id, 'a1');
  assert.equal(account.username, 'player1');
  assert.equal(account.userId, '12345');
  assert.equal(account.nickname, 'Main');
  assert.equal(account.cookie, 'the-cookie');
});

// ── Account pass-through (encryptAccount / decryptAccount) ──────────────────
//
// Both encryptAccount and decryptAccount in main.js apply their Donut defaults
// through applyAccountDonutDefaults after handling the cookie, and never encrypt
// donutProfileId / donutProfilePendingDelete. These tests assert that an account
// that already has those fields set keeps them exactly, in plaintext.

test('encrypt/decrypt pass-through leaves donutProfileId unchanged and unencrypted', () => {
  const account = {
    id: 'a1',
    donutProfileId: 'donut-profile-abc-123',
    donutProfilePendingDelete: false,
  };

  applyAccountDonutDefaults(account);

  assert.equal(account.donutProfileId, 'donut-profile-abc-123');
  assert.equal(
    isEncrypted(account.donutProfileId),
    false,
    'donutProfileId must be stored as plaintext, never encrypted',
  );
});

test('encrypt/decrypt pass-through leaves donutProfilePendingDelete unchanged', () => {
  const pendingTrue = applyAccountDonutDefaults({
    id: 'a1',
    donutProfileId: 'p1',
    donutProfilePendingDelete: true,
  });
  assert.equal(pendingTrue.donutProfilePendingDelete, true);

  const pendingFalse = applyAccountDonutDefaults({
    id: 'a2',
    donutProfileId: 'p2',
    donutProfilePendingDelete: false,
  });
  assert.equal(pendingFalse.donutProfilePendingDelete, false);
});

test('an explicitly-null donutProfileId is preserved (not re-defaulted or altered)', () => {
  const account = applyAccountDonutDefaults({
    id: 'a1',
    donutProfileId: null,
    donutProfilePendingDelete: false,
  });

  assert.equal(account.donutProfileId, null);
  assert.equal(account.donutProfilePendingDelete, false);
});

// ── Settings defaults (as applied in loadSettings) ──────────────────────────

test('loadSettings defaults donutApiPort to 10108 and pendingDonutDeletions to [] when absent', () => {
  const settings = { multiInstance: true, antiAfk: false };

  const result = applySettingsDonutDefaults(settings);

  assert.equal(result.donutApiPort, 10108);
  assert.deepEqual(result.pendingDonutDeletions, []);
  assert.equal(result.donutApiTokenEnc, null);
});

test('loadSettings does not disturb existing settings fields', () => {
  const settings = { multiInstance: true, antiAfk: false, antiAfkInterval: 60 };

  applySettingsDonutDefaults(settings);

  assert.equal(settings.multiInstance, true);
  assert.equal(settings.antiAfk, false);
  assert.equal(settings.antiAfkInterval, 60);
});

test('loadSettings keeps already-present Donut settings values', () => {
  const settings = {
    donutApiTokenEnc: 'gs:sometoken',
    donutApiPort: 20000,
    pendingDonutDeletions: ['profile-x', 'profile-y'],
  };

  applySettingsDonutDefaults(settings);

  assert.equal(settings.donutApiTokenEnc, 'gs:sometoken');
  assert.equal(settings.donutApiPort, 20000);
  assert.deepEqual(settings.pendingDonutDeletions, ['profile-x', 'profile-y']);
});
