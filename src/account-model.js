'use strict';

// Pure model-default helpers for the Account and Settings records.
//
// These are extracted out of main.js (which can't be imported outside Electron)
// so the documented Donut Browser defaults and pass-through behavior can be unit
// tested directly. main.js requires this module and calls these helpers from
// encryptAccount/decryptAccount (Account) and loadSettings (Settings).

// Applies the documented Donut Browser defaults to an Account record's new
// fields, leaving any already-present value untouched (so an existing
// donutProfileId or donutProfilePendingDelete passes through unchanged, and is
// never encrypted here). Mutates and returns the passed object.
//   donutProfileId:            defaults to null   when absent
//   donutProfilePendingDelete: defaults to false  when absent
function applyAccountDonutDefaults(o) {
  if (o.donutProfileId === undefined) o.donutProfileId = null;
  if (o.donutProfilePendingDelete === undefined) o.donutProfilePendingDelete = false;
  return o;
}

// Applies the documented Donut Browser defaults to a Settings object's new
// fields, leaving existing values untouched. Mutates and returns the object.
//   donutApiTokenEnc:      defaults to null   when absent
//   donutApiPort:          defaults to 10108  when absent
//   pendingDonutDeletions: defaults to []     when absent
function applySettingsDonutDefaults(s) {
  if (s.donutApiTokenEnc === undefined) s.donutApiTokenEnc = null;
  if (s.donutApiPort === undefined) s.donutApiPort = 10108;
  if (s.pendingDonutDeletions === undefined) s.pendingDonutDeletions = [];
  return s;
}

module.exports = { applyAccountDonutDefaults, applySettingsDonutDefaults };
