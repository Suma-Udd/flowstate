'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createScratchRouter } = require('../src/main/scratch-inject');

const OWN = 4242;
const target = (processId) => ({ windowId: 'w', processId, capturedAt: 1 });

function rig({ active = true, deliverResult = true, historyFails = false } = {}) {
  const calls = { paste: [], history: [], delivered: [] };
  const router = createScratchRouter({
    injector: {
      pasteText: async (options) => {
        calls.paste.push(options);
        return { ok: true, code: 'pasted' };
      },
    },
    history: {
      append: async (entry) => {
        if (historyFails) throw new Error('disk');
        calls.history.push(entry);
      },
    },
    isActive: () => active,
    deliver: (text) => {
      calls.delivered.push(text);
      return deliverResult;
    },
    ownProcessId: OWN,
    logger: { error() {} },
  });
  return { router, calls };
}

test('own window with the Scratchpad open: inserted directly, never pasted', async () => {
  const { router, calls } = rig();
  const result = await router.pasteText({ text: 'hello', target: target(OWN), historyEntry: { id: '1' } });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'scratchpad');
  assert.equal(result.clipboardLeftForManualPaste, false);
  assert.deepEqual(calls.delivered, ['hello']);
  assert.equal(calls.paste.length, 0, 'the clipboard path must not run');
  assert.equal(calls.history[0].text, 'hello');
  assert.equal(calls.history[0].id, '1');
});

test('another application still goes through the paste service', async () => {
  const { router, calls } = rig();
  const result = await router.pasteText({ text: 'hello', target: target(1) });
  assert.equal(result.code, 'pasted');
  assert.equal(calls.paste.length, 1);
  assert.equal(calls.delivered.length, 0);
});

test('own window on another screen goes through the paste service', async () => {
  const { router, calls } = rig({ active: false });
  await router.pasteText({ text: 'hello', target: target(OWN) });
  assert.equal(calls.paste.length, 1);
  assert.equal(calls.delivered.length, 0);
});

test('a history write failure skips the insert', async () => {
  const { router, calls } = rig({ historyFails: true });
  const result = await router.pasteText({ text: 'hello', target: target(OWN) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'history-write-failed');
  assert.equal(result.historySaved, false);
  assert.equal(calls.delivered.length, 0);
});

test('an undelivered insert is reported, with the transcript safe in history', async () => {
  const { router } = rig({ deliverResult: false });
  const result = await router.pasteText({ text: 'hello', target: target(OWN) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'scratchpad-unavailable');
  assert.equal(result.historySaved, true);
});
