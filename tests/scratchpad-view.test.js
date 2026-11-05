'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const scratchpad = require('../src/renderer/views/scratchpad');
const lib = require('../src/renderer/lib');

/* The smallest DOM the view touches: elements are plain objects keyed by the
   selector the view asks for. */
function fakeRoot() {
  const els = {};
  const make = (extra = {}) => ({
    value: '',
    textContent: '',
    hidden: false,
    selectionStart: 0,
    selectionEnd: 0,
    attrs: {},
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    removeEventListener(type) { delete this.listeners[type]; },
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    hasAttribute(k) { return k in this.attrs; },
    focus() {},
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    setRangeText(text, start, end) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
      this.selectionStart = start + text.length;
      this.selectionEnd = this.selectionStart;
    },
    ...extra,
  });
  for (const key of ['pad', 'words', 'chars', 'lines', 'status', 'copy', 'export',
    'clear', 'clear-label', 'clear-cancel']) {
    els[key] = make(key === 'pad' ? { attrs: { readonly: '' } } : {});
  }
  const map = {
    '[data-pad]': 'pad', '[data-words]': 'words', '[data-chars]': 'chars',
    '[data-lines]': 'lines', '[data-pad-status]': 'status', '[data-copy]': 'copy',
    '[data-export]': 'export', '[data-clear]': 'clear',
    '[data-clear-label]': 'clear-label', '[data-clear-cancel]': 'clear-cancel',
  };
  return { els, root: { querySelector: (sel) => els[map[sel]] } };
}

function fakeScratch(initial = { text: '', updatedAt: null }) {
  const state = { sets: [], active: [], inserted: null, copies: 0 };
  const api = {
    get: async () => initial,
    set: async (text) => {
      state.sets.push(text);
      return { updatedAt: '2026-10-17T09:30:00.000Z' };
    },
    setActive: async (v) => { state.active.push(v); },
    onInsert: (cb) => {
      state.inserted = cb;
      return () => { state.inserted = null; };
    },
    copy: async () => { state.copies += 1; return { copied: true }; },
    export: async () => ({ saved: false }),
  };
  return { api, state };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('the live shell starts read-only and empty: the stored text arrives from main', () => {
  const html = scratchpad.html({ lib, bridge: { scratch: {} } }, { text: 'FIXTURE', savedRelative: 'x' });
  assert.match(html, /readonly/);
  assert.doesNotMatch(html, /FIXTURE/);
  for (const hook of ['data-copy', 'data-export', 'data-clear', 'data-words']) {
    assert.match(html, new RegExp(hook));
  }
});

test('mount loads the stored text, counts it, and marks the pad active', async () => {
  const { els, root } = fakeRoot();
  const { api, state } = fakeScratch({ text: 'Drei kleine Worte\n\nZwei', updatedAt: '2026-10-17T09:00:00.000Z' });
  const teardown = scratchpad.mount(root, { lib, bridge: { scratch: api } });
  await tick();
  assert.equal(els.pad.value, 'Drei kleine Worte\n\nZwei');
  assert.equal('readonly' in els.pad.attrs, false);
  assert.equal(els.words.textContent, '4');
  assert.equal(els.lines.textContent, '2');
  assert.deepEqual(state.active, [true]);
  teardown();
  assert.deepEqual(state.active, [true, false]);
});

test('dictated text goes in at the caret, with a space only where one is needed', async () => {
  const { els, root } = fakeRoot();
  const { api, state } = fakeScratch({ text: 'Hello world', updatedAt: null });
  const teardown = scratchpad.mount(root, { lib, bridge: { scratch: api } });
  await tick();
  els.pad.setSelectionRange(5, 5);
  state.inserted('there');
  assert.equal(els.pad.value, 'Hello there world');
  state.inserted('again');
  assert.equal(els.pad.value, 'Hello there again world');
  assert.equal(els.words.textContent, '4');
  teardown();
});

test('typing autosaves after a pause, and leaving flushes unsaved text', async () => {
  const { els, root } = fakeRoot();
  const { api, state } = fakeScratch();
  const teardown = scratchpad.mount(root, { lib, bridge: { scratch: api } });
  await tick();
  els.pad.value = 'unsaved thought';
  els.pad.listeners.input();
  assert.equal(els.status.textContent, 'Unsaved changes');
  assert.equal(state.sets.length, 0);
  teardown();
  assert.deepEqual(state.sets, ['unsaved thought']);
});

test('clear needs a second press, and Keep it backs out', async () => {
  const { els, root } = fakeRoot();
  const { api, state } = fakeScratch({ text: 'precious', updatedAt: null });
  const teardown = scratchpad.mount(root, { lib, bridge: { scratch: api } });
  await tick();

  els.clear.listeners.click();
  assert.equal(els.pad.value, 'precious');
  assert.equal(els['clear-label'].textContent, 'Confirm clear');
  assert.equal(els['clear-cancel'].hidden, false);

  els['clear-cancel'].listeners.click();
  assert.equal(els.pad.value, 'precious');
  assert.equal(els['clear-label'].textContent, 'Clear');

  els.clear.listeners.click();
  els.clear.listeners.click();
  assert.equal(els.pad.value, '');
  assert.equal(els.words.textContent, '0');
  await tick();
  assert.equal(state.sets.at(-1), '');
  teardown();
});

test('copy saves first, then asks main to copy what it stored', async () => {
  const { els, root } = fakeRoot();
  const { api, state } = fakeScratch({ text: 'abc', updatedAt: null });
  const teardown = scratchpad.mount(root, { lib, bridge: { scratch: api } });
  await tick();
  els.copy.listeners.click();
  await tick();
  await tick();
  assert.deepEqual(state.sets, ['abc']);
  assert.equal(state.copies, 1);
  assert.equal(els.status.textContent, 'Copied all');
  teardown();
});
