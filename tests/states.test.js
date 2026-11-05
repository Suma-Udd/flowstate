/**
 * Issue #20 — P2 states, keyboard navigation, reduced motion.
 *
 * The four still-fixture-only screens (Dictionary, Snippets, History) and the
 * Dictation recent list are always rendered from a fully-populated fixture in
 * every other test file, so the empty-state and skeleton branches added by
 * this issue have never actually been exercised. These tests render the same
 * views with a synthetic empty/zero-length dataset instead, the same way
 * tests/shell.test.js renders them against the real fixture.
 *
 * What is asserted is structural, in the same style tests/shell.test.js and
 * tests/tokens.test.js already use for markup and CSS text: a real element for
 * every action (never href="#"), no interactive element inside a skeleton
 * (it is a loading placeholder, not a tab stop), and every new keyframe stays
 * on the transform/opacity rule the rest of the app already enforces.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const VIEWS = path.join(RENDERER, 'views');

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');
const fixture = (name) => JSON.parse(read(RENDERER, 'fixtures', `${name}.json`));

const FlowLib = require('../src/renderer/lib.js');
const dictionaryView = require(path.join(VIEWS, 'dictionary.js'));
const snippetsView = require(path.join(VIEWS, 'snippets.js'));
const historyView = require(path.join(VIEWS, 'history.js'));
const dictationView = require(path.join(VIEWS, 'dictation.js'));

const ctx = { lib: FlowLib };

/* ---------------------------------------------------------------------------
   Empty states
   --------------------------------------------------------------------------- */

test('an empty dictionary shows a real add-term action, not a bare list', () => {
  const data = { ...fixture('dictionary'), terms: [] };
  const html = dictionaryView.html(ctx, data);

  assert.match(html, /class="empty"/, 'no .empty markup was rendered');
  assert.match(html, /No custom terms yet/);
  assert.match(html, /<button type="button"[^>]*>[\s\S]*Add term/, 'no real add-term button');
  assert.ok(!/href="#"/.test(html), 'an href="#" would drive the router home');
  assert.ok(!/<ul class="list">/.test(html), 'an empty screen still rendered the populated list');
});

test('an empty snippet list shows a real add-snippet action', () => {
  const data = { ...fixture('snippets'), snippets: [] };
  const html = snippetsView.html(ctx, data);

  assert.match(html, /class="empty"/);
  assert.match(html, /No snippets yet/);
  assert.match(html, /<button type="button"[^>]*>[\s\S]*Add snippet/);
  assert.ok(!/<ul class="list">/.test(html));
});

test('history distinguishes "nothing yet" from "no matches"', () => {
  const base = fixture('history');

  const nothingYet = historyView.html(ctx, {
    ...base, days: [], totals: { ...base.totals, dictations: 0, matching: 0 },
  });
  assert.match(nothingYet, /Nothing dictated yet/);
  assert.match(nothingYet, /<a class="btn[^"]*" href="#\/dictation">/, 'no real link back to Dictation');
  assert.ok(!/href="#"/.test(nothingYet.replace(/href="#\/dictation"/, '')));

  const noMatches = historyView.html(ctx, {
    ...base, days: [], totals: { ...base.totals, dictations: 5, matching: 0 },
  });
  assert.match(noMatches, /No dictations match/);
  assert.ok(!/Nothing dictated yet/.test(noMatches), 'a filtered-empty search read as a brand new install');
});

test('the recent dictations list has an empty state, and never nests a div in the ul', () => {
  const data = { ...fixture('dictation'), recent: [] };
  const html = dictationView.html(ctx, data);

  assert.match(html, /No dictations yet/);
  // <ul> may only contain <li> — the empty state must replace it, not sit
  // inside it.
  assert.ok(!/<ul class="list" data-recent>\s*<div class="empty">/.test(html),
    'the empty state was nested inside the <ul> it replaces');
});

/* ---------------------------------------------------------------------------
   Loading skeletons
   --------------------------------------------------------------------------- */

const SKELETON_VIEWS = [
  ['dictionary', dictionaryView],
  ['snippets', snippetsView],
  ['history', historyView],
];

test('every still-fixture-only list screen exports a skeleton', () => {
  for (const [name, view] of SKELETON_VIEWS) {
    assert.equal(typeof view.skeleton, 'function', `${name}.js has no skeleton()`);
  }
});

test('a skeleton has no interactive element and no tab stop', () => {
  // It is a loading placeholder painted before any real data exists: a
  // keyboard user tabbing through it must not land on something that does
  // nothing, and a screen reader must not read out empty rows.
  for (const [name, view] of SKELETON_VIEWS) {
    const html = view.skeleton(ctx);
    assert.ok(!/<button|<input|<select|<a\s|tabindex/i.test(html),
      `${name}.js's skeleton contains a focusable element`);
    assert.match(html, /aria-hidden="true"/, `${name}.js's skeleton is not hidden from assistive tech`);
    assert.match(html, /role="status"/, `${name}.js's skeleton has nothing announcing that it is loading`);
  }
});

test('the skeleton and the real screen agree on the page title', () => {
  for (const [name, view] of SKELETON_VIEWS) {
    const real = view.html(ctx, fixture(name));
    const skeletonHtml = view.skeleton(ctx);
    const title = /<h1 class="page-title">([^<]*)<\/h1>/.exec(real);
    assert.ok(title, `${name}.js has no page title to compare against`);
    assert.ok(skeletonHtml.includes(title[1]),
      `${name}.js's skeleton title disagrees with the real screen's`);
  }
});

/* ---------------------------------------------------------------------------
   Motion: any new keyframe stays on transform/opacity
   --------------------------------------------------------------------------- */

test('the skeleton pulse animates opacity only', () => {
  const APP_CSS = read(RENDERER, 'styles', 'app.css');
  const clean = APP_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const keyframes = /@keyframes skel-pulse\s*\{([\s\S]*?)\n\}/.exec(clean);
  assert.ok(keyframes, 'app.css has no @keyframes skel-pulse');
  const properties = [...keyframes[1].matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
  assert.ok(properties.length > 0, 'the skeleton keyframes animate nothing');
  for (const property of properties) {
    assert.equal(property, 'opacity', `skel-pulse animates "${property}"`);
  }
});

test('the skeleton pulse duration is a token, not a literal', () => {
  const APP_CSS = read(RENDERER, 'styles', 'app.css');
  const rule = /\.skel\s*\{([\s\S]*?)\}/.exec(APP_CSS.replace(/\/\*[\s\S]*?\*\//g, ''));
  assert.ok(rule, 'app.css has no .skel rule');
  assert.match(rule[1], /animation:\s*skel-pulse\s+var\(--dur-slow\)/,
    '.skel does not derive its duration from a --dur-* token');
});

/* ---------------------------------------------------------------------------
   Error states this issue names what the app already knew
   --------------------------------------------------------------------------- */

test('a model failure explains itself, not just its badge', () => {
  const DICTATION_JS = read(VIEWS, 'dictation.js');
  const SETTINGS_SYSTEM_JS = read(VIEWS, 'settings-system.js');
  for (const [name, source] of [['dictation.js', DICTATION_JS], ['settings-system.js', SETTINGS_SYSTEM_JS]]) {
    assert.match(source, /data-model-notice/, `${name} has no model error notice slot`);
    // Both screens show the same real model-manager state and must share the
    // one explanation of it (lib.modelNoticeHtml) rather than drifting into
    // two different messages for the same failure — or, as a first pass of
    // this issue actually shipped, one screen wiring the markup and never
    // filling it in.
    assert.match(source, /lib\.modelNoticeHtml\(/, `${name} never paints the model notice slot it renders`);
  }
});

test('cleanup enabled without an API key is named, not silently skipped', () => {
  const SETTINGS_GENERAL_JS = read(VIEWS, 'settings-general.js');
  assert.match(SETTINGS_GENERAL_JS, /apiKeyConfigured/);
  assert.match(SETTINGS_GENERAL_JS, /data-cleanup-notice/);
});

test('an invoke() rejection is shown as the reason, not Electron\'s own plumbing', () => {
  // A real mics.list() rejection reaches these notices as ipcRenderer.invoke()
  // wraps it: "Error invoking remote method 'channel': Error: <reason>".
  // Found by looking at tools/shoot-states.mjs's own captured screenshot,
  // not assumed away — see Session Log.md's entry for this issue.
  const wrapped = new Error(
    "Error invoking remote method 'flowstate:mics-list': Error: "
    + 'Access to the microphone was denied by Windows privacy settings.'
  );
  assert.equal(FlowLib.ipcErrorMessage(wrapped),
    'Access to the microphone was denied by Windows privacy settings.');
  // A plain, non-IPC error still comes through unchanged.
  assert.equal(FlowLib.ipcErrorMessage(new Error('The model is not ready.')),
    'The model is not ready.');
});

test('a real dictation that failed to paste is surfaced, not only the pill', () => {
  const DICTATION_JS = read(VIEWS, 'dictation.js');
  assert.match(DICTATION_JS, /result\.injection/,
    'dictation.js never looks at the injection result its own onResult broadcast carries');
});
