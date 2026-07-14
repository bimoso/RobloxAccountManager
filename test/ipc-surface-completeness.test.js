'use strict';

// IPC_Surface completeness checklist.
//
// Validates Requirements 10.1, 10.2, 10.4, 10.5: every `window.api` member the
// Renderer_UI depends on must have an equivalent Tauri backend counterpart —
// each `invoke('<cmd>')` string in preload.js must resolve to a command
// registered in `src-tauri/src/lib.rs`'s `tauri::generate_handler![ ... ]`, and
// each event channel subscribed via `on('<event>')` must resolve to an emitted
// event-name constant somewhere in the Rust sources.
//
// Per Requirement 10.5, a `window.api` call with NO backend counterpart is a
// migration defect that must be resolved before the migration is complete
// (not something the user works around). This test is the checklist that
// surfaces such defects: it parses preload.js and the Rust sources as text and
// diffs the referenced-vs-registered sets, failing with an explicit list of any
// unmatched member.
//
// The parsing is deliberately text-based (no Tauri runtime, no Rust toolchain):
// preload.js is a classic script that can't run outside a browser, and the Rust
// command/event registrations are stable source-level facts.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PRELOAD_PATH = path.join(ROOT, 'src-tauri', 'preload.js');
const LIB_RS_PATH = path.join(ROOT, 'src-tauri', 'src', 'lib.rs');
const RUST_SRC_DIR = path.join(ROOT, 'src-tauri', 'src');

// ── preload.js extraction ───────────────────────────────────────────────────

// Every command name passed to the `invoke('<cmd>', ...)` request/response
// bridge. These are bare snake_case identifiers that must match a Rust
// `#[tauri::command] fn <cmd>` registered in `generate_handler!`.
function extractPreloadInvokeCommands(source) {
  const names = new Set();
  const re = /\binvoke\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    names.add(m[1]);
  }
  return names;
}

// Every event channel passed to the `on('<event>', ...)` subscription bridge.
// These are `scheme://path` strings that must match an emitted event-name
// constant in the Rust sources. The `on(channel, handler)` helper *definition*
// takes a bare identifier (no quotes) so it is not captured here.
function extractPreloadListenEvents(source) {
  const names = new Set();
  const re = /\bon\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    names.add(m[1]);
  }
  return names;
}

// ── Rust backend extraction ─────────────────────────────────────────────────

// The command names registered with the Tauri builder. Parses the
// `tauri::generate_handler![ ... ]` block and takes the final `::`-delimited
// segment of each entry (e.g. `window::window_minimize` -> `window_minimize`),
// which is the exact string the Renderer_UI invokes.
function extractRegisteredCommands(libRsSource) {
  const start = libRsSource.indexOf('generate_handler!');
  assert.notEqual(
    start,
    -1,
    'could not find tauri::generate_handler! in lib.rs — the command registry must exist',
  );
  const open = libRsSource.indexOf('[', start);
  const close = libRsSource.indexOf(']', open);
  assert.ok(open !== -1 && close !== -1, 'malformed generate_handler! macro in lib.rs');

  const block = libRsSource.slice(open + 1, close);
  const names = new Set();
  // Each entry is `module::command` (optionally `crate::module::command`).
  const re = /([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*)/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    const segments = m[1].split('::');
    names.add(segments[segments.length - 1]);
  }
  return names;
}

// Every emitted event-name constant across the Rust sources, i.e. string
// literals of the form `"<scheme>://<path>"` (e.g. `"roblox://closed"`). These
// are declared as `pub const ..._EVENT: &str = "scheme://path";`.
function extractEmittedEventNames(rustSrcDir) {
  const names = new Set();
  const re = /"([a-z][a-z0-9]*:\/\/[a-z0-9-]+)"/g;
  for (const file of fs.readdirSync(rustSrcDir)) {
    if (!file.endsWith('.rs')) continue;
    const source = fs.readFileSync(path.join(rustSrcDir, file), 'utf8');
    let m;
    while ((m = re.exec(source)) !== null) {
      names.add(m[1]);
    }
  }
  return names;
}

// ── The checklist ────────────────────────────────────────────────────────────

const preloadSource = fs.readFileSync(PRELOAD_PATH, 'utf8');
const libRsSource = fs.readFileSync(LIB_RS_PATH, 'utf8');

const invokedCommands = extractPreloadInvokeCommands(preloadSource);
const listenedEvents = extractPreloadListenEvents(preloadSource);
const registeredCommands = extractRegisteredCommands(libRsSource);
const emittedEvents = extractEmittedEventNames(RUST_SRC_DIR);

test('sanity: preload.js exposes the expected IPC surface', () => {
  // Guards against a parsing regression silently reducing the checklist to a
  // trivially-passing empty set.
  assert.ok(
    invokedCommands.size >= 30,
    `expected preload.js to invoke many commands, found ${invokedCommands.size}`,
  );
  assert.ok(
    listenedEvents.size >= 5,
    `expected preload.js to subscribe to several events, found ${listenedEvents.size}`,
  );
});

test('every window.api invoke() command has a registered Tauri command (Req 10.1, 10.4, 10.5)', () => {
  const missing = [...invokedCommands]
    .filter((cmd) => !registeredCommands.has(cmd))
    .sort();

  assert.deepEqual(
    missing,
    [],
    missing.length === 0
      ? undefined
      : 'Migration defect (Requirement 10.5): the following window.api commands are ' +
          'invoked by src-tauri/preload.js but have NO command registered in ' +
          "src-tauri/src/lib.rs's tauri::generate_handler![]:\n  - " +
          missing.join('\n  - ') +
          '\nEach must be wired to a #[tauri::command] and added to generate_handler! ' +
          'before the migration is complete.',
  );
});

test('every window.api on() event has an emitted Tauri event counterpart (Req 10.2, 10.4, 10.5)', () => {
  const missing = [...listenedEvents]
    .filter((evt) => !emittedEvents.has(evt))
    .sort();

  assert.deepEqual(
    missing,
    [],
    missing.length === 0
      ? undefined
      : 'Migration defect (Requirement 10.5): the following window.api event channels are ' +
          'subscribed to by src-tauri/preload.js but have NO emitted event-name constant in the ' +
          'Rust sources (src-tauri/src/*.rs):\n  - ' +
          missing.join('\n  - '),
  );
});
