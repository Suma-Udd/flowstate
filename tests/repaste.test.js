'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRePaster } = require('../src/main/repaste');

function harness({ accepted = true, modifiers = [], sendThrows = false, clipboardEchoes = true } = {}) {
  const log = [];
  let clip = '';
  const clipboard = {
    writeText: (text) => { clip = clipboardEchoes ? text : 'other'; log.push('write'); },
    readText: () => clip,
  };
  const user32 = {
    getPressedModifiers: () => modifiers,
    sendPasteChord: (chord) => {
      log.push(`chord:${chord}`);
      if (sendThrows) throw new Error('blocked');
      return { accepted };
    },
  };
  const window = {
    isDestroyed: () => false,
    isFocused: () => true,
    minimize: () => log.push('minimize'),
    restore: () => log.push('restore'),
  };
  const other = { ...window, isFocused: () => false, minimize: () => log.push('WRONG') };
  const rePaste = createRePaster({
    clipboard,
    user32,
    getWindows: () => [window, other],
    wait: async (ms) => { log.push(`wait:${ms}`); },
    logger: { error() {} },
  });
  return { rePaste, log };
}

test('re-paste hands focus back, pastes, then restores the window', async () => {
  const h = harness();
  assert.deepEqual(await h.rePaste('Hallo'), { ok: true, code: 'pasted' });
  assert.deepEqual(
    h.log.filter((entry) => !entry.startsWith('wait')),
    ['write', 'minimize', 'chord:ctrl+v', 'restore']
  );
  assert.ok(h.log.some((entry) => entry === 'wait:350'));
});

test('re-paste reports a blocked paste and leaves the text on the clipboard', async () => {
  for (const options of [{ accepted: false }, { sendThrows: true }]) {
    const h = harness(options);
    const result = await h.rePaste('Hallo');
    assert.equal(result.ok, false);
    assert.equal(result.onClipboard, true);
    assert.ok(h.log.includes('restore'), 'window is restored even on failure');
  }
});

test('re-paste refuses while a modifier is held, on a busy clipboard and on empty text', async () => {
  const held = harness({ modifiers: ['Control'] });
  assert.equal((await held.rePaste('x')).code, 'modifier-held');
  assert.ok(!held.log.includes('minimize'));
  const busy = harness({ clipboardEchoes: false });
  assert.equal((await busy.rePaste('x')).code, 'clipboard-busy');
  assert.equal((await busy.rePaste('')).code, 'empty');
});
