'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  APP_QUIRKS,
  DEFAULT_APP_QUIRK,
  getAppQuirk,
} = require('../src/shared/app-quirks');
const { createFocusTracker } = require('../src/main/focus');
const {
  createNativeUser32,
  createPasteService,
  withClipboardRetry,
} = require('../src/main/inject');

function createFakeClipboard(initial = {}) {
  let state = {
    text: initial.text ?? null,
    html: initial.html ?? null,
    rtf: initial.rtf ?? null,
    imagePng: initial.imagePng ?? null,
    bookmark: initial.bookmark ?? null,
    unsupportedFormats: initial.unsupportedFormats ?? [],
  };
  let writes = 0;

  function formats() {
    const result = [];
    if (state.text != null) result.push('text/plain');
    if (state.html != null) result.push('text/html');
    if (state.rtf != null) result.push('text/rtf');
    if (state.imagePng != null) result.push('image/png');
    if (state.bookmark != null) result.push('text/uri-list');
    return [...result, ...state.unsupportedFormats];
  }

  return {
    availableFormats: formats,
    clear() {
      state = {
        text: null,
        html: null,
        rtf: null,
        imagePng: null,
        bookmark: null,
        unsupportedFormats: [],
      };
    },
    readBookmark: () =>
      state.bookmark ?? { title: '', url: '' },
    readHTML: () => state.html ?? '',
    readImage: () => ({
      isEmpty: () => state.imagePng == null,
      toPNG: () => Buffer.from(state.imagePng ?? []),
    }),
    readRTF: () => state.rtf ?? '',
    readText: () => state.text ?? '',
    write(data) {
      writes += 1;
      state = {
        text: data.text ?? null,
        html: data.html ?? null,
        rtf: data.rtf ?? null,
        imagePng: data.image?.toPNG() ?? null,
        bookmark:
          data.bookmark == null
            ? null
            : { title: data.bookmark, url: data.text ?? '' },
        unsupportedFormats: [],
      };
    },
    writeText(text) {
      writes += 1;
      state = {
        text,
        html: null,
        rtf: null,
        imagePng: null,
        bookmark: null,
        unsupportedFormats: [],
      };
    },
    getState: () => state,
    getWrites: () => writes,
  };
}

function createHarness({
  clipboard = createFakeClipboard({ text: 'original clipboard' }),
  focusChecks = [true, true],
  historyAppend = async () => {},
  input = {
    requestedEvents: 4,
    sentEvents: 4,
    accepted: true,
    win32Error: 0,
  },
  modifiers = [[], []],
} = {}) {
  const events = [];
  const waits = [];
  const warnings = [];
  let focusIndex = 0;
  let modifierIndex = 0;
  const user32 = {
    getPressedModifiers() {
      events.push('modifiers');
      return modifiers[Math.min(modifierIndex++, modifiers.length - 1)];
    },
    sendPasteChord(chord) {
      events.push(`send:${chord}`);
      return input;
    },
  };
  const history = {
    async append(entry) {
      events.push('history');
      await historyAppend(entry);
    },
  };
  const focus = {
    isTargetForeground() {
      events.push('focus');
      return focusChecks[Math.min(focusIndex++, focusChecks.length - 1)];
    },
  };
  const logger = {
    error(message) {
      events.push('log:error');
      warnings.push(message);
    },
    warn(message) {
      events.push('log:warn');
      warnings.push(message);
    },
  };
  const service = createPasteService({
    clipboard,
    nativeImage: {
      createFromBuffer(buffer) {
        return {
          toPNG: () => Buffer.from(buffer),
        };
      },
    },
    user32,
    focus,
    history,
    logger,
    wait: async (ms) => {
      events.push(`wait:${ms}`);
      waits.push(ms);
    },
  });
  const target = Object.freeze({
    windowId: '101',
    processId: 7,
    threadId: 9,
    imagePath: 'C:\\Apps\\Code.exe',
    exe: 'Code.exe',
    title: 'notes.txt',
    capturedAt: 1_234,
  });

  return {
    clipboard,
    events,
    service,
    target,
    waits,
    warnings,
  };
}

test('quirk table covers all six Spike C target types at the safe delay', () => {
  for (const executable of [
    'notepad.exe',
    'chrome.exe',
    'opera.exe',
    'code.exe',
    'discord.exe',
    'windowsterminal.exe',
  ]) {
    assert.equal(APP_QUIRKS[executable].restoreDelayMs, 120);
    assert.equal(APP_QUIRKS[executable].pasteChord, 'ctrl+v');
  }
  assert.match(APP_QUIRKS['code.exe'].note, /asynchronously/i);
  assert.equal(getAppQuirk('C:\\Program Files\\Code.EXE'), APP_QUIRKS['code.exe']);
  assert.equal(getAppQuirk('unknown.exe'), DEFAULT_APP_QUIRK);
});

test('focus capture records exe and title at key-down and matches by HWND', () => {
  let foreground = { id: '42' };
  const tracker = createFocusTracker({
    api: {
      getForegroundWindow: () => foreground,
      getWindowId: (handle) => handle.id,
      getWindowThreadProcessId: () => ({
        processId: 100,
        threadId: 200,
      }),
      getProcessImagePath: () => 'C:\\Windows\\System32\\notepad.exe',
      getWindowTitle: () => 'Draft — Notepad',
    },
    now: () => 9_876,
  });

  const captured = tracker.captureAtKeyDown();
  assert.deepEqual(captured, {
    windowId: '42',
    processId: 100,
    threadId: 200,
    imagePath: 'C:\\Windows\\System32\\notepad.exe',
    exe: 'notepad.exe',
    title: 'Draft — Notepad',
    capturedAt: 9_876,
  });
  assert.equal(tracker.isTargetForeground(captured), true);

  foreground = { id: '43' };
  assert.equal(tracker.isTargetForeground(captured), false);
});

test('clipboard retry uses bounded backoff before succeeding', async () => {
  const waits = [];
  let attempts = 0;
  const result = await withClipboardRetry(
    'clipboard write',
    () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('locked');
      }
      return 'written';
    },
    {
      backoffMs: [10, 25, 50],
      wait: async (ms) => waits.push(ms),
    }
  );

  assert.deepEqual(result, { attempts: 3, value: 'written' });
  assert.deepEqual(waits, [10, 25]);
});

test(
  'Windows user32 bindings can be constructed repeatedly',
  { skip: process.platform !== 'win32' },
  () => {
    const first = createNativeUser32();
    const second = createNativeUser32();

    assert.ok(Array.isArray(first.getPressedModifiers()));
    assert.ok(Array.isArray(second.getPressedModifiers()));
  }
);

test('history is saved before mocked user32 input and clipboard restores at 120 ms', async () => {
  const image = Buffer.from([1, 2, 3, 4]);
  const clipboard = createFakeClipboard({
    text: 'original',
    html: '<b>original</b>',
    rtf: '{\\rtf1 original}',
    imagePng: image,
  });
  const harness = createHarness({ clipboard });

  const result = await harness.service.pasteText({
    text: 'dictated text',
    target: harness.target,
    historyEntry: { id: 'dictation-1' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.clipboardCommonFormatsRestored, true);
  assert.equal(result.clipboardFullyRestored, true);
  assert.deepEqual(harness.clipboard.getState(), {
    text: 'original',
    html: '<b>original</b>',
    rtf: '{\\rtf1 original}',
    imagePng: image,
    bookmark: null,
    unsupportedFormats: [],
  });
  assert.deepEqual(harness.waits, [120]);
  assert.ok(
    harness.events.indexOf('history') <
      harness.events.indexOf('send:ctrl+v')
  );
});

test('silent clipboard lock failures are retried and verified', async () => {
  const clipboard = createFakeClipboard({ text: 'original' });
  const realWriteText = clipboard.writeText;
  let attempts = 0;
  clipboard.writeText = (text) => {
    attempts += 1;
    if (attempts >= 3) {
      realWriteText(text);
    }
  };
  const harness = createHarness({ clipboard });

  const result = await harness.service.pasteText({
    text: 'after contention',
    target: harness.target,
  });

  assert.equal(result.ok, true);
  assert.equal(result.clipboardWriteAttempts, 3);
  assert.deepEqual(harness.waits, [10, 25, 120]);
  assert.equal(clipboard.readText(), 'original');
});

test('a rejected SendInput leaves text on the clipboard for manual paste', async () => {
  const harness = createHarness({
    input: {
      requestedEvents: 4,
      sentEvents: 0,
      accepted: false,
      win32Error: 5,
    },
  });

  const result = await harness.service.pasteText({
    text: 'manual fallback',
    target: harness.target,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'paste-rejected');
  assert.equal(result.clipboardLeftForManualPaste, true);
  assert.equal(harness.clipboard.readText(), 'manual fallback');
  assert.equal(
    harness.events.some((event) => event.startsWith('wait:')),
    false
  );
});

test('a foreground change never sends input to the new window', async () => {
  const harness = createHarness({ focusChecks: [true, false] });

  const result = await harness.service.pasteText({
    text: 'belongs in the first window',
    target: harness.target,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'target-not-foreground');
  assert.equal(
    harness.events.some((event) => event.startsWith('send:')),
    false
  );
  assert.equal(harness.clipboard.readText(), 'original clipboard');
  assert.equal(harness.events[0], 'history');
});

test('held hotkey modifiers stop injection before the clipboard is touched', async () => {
  const harness = createHarness({ modifiers: [['Control', 'MetaLeft']] });

  const result = await harness.service.pasteText({
    text: 'wait for keyup',
    target: harness.target,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'modifier-held');
  assert.deepEqual(result.heldModifiers, ['Control', 'MetaLeft']);
  assert.equal(harness.clipboard.getWrites(), 0);
  assert.equal(harness.events[0], 'history');
});

test('unsupported clipboard formats are reported without logging contents', async () => {
  const clipboard = createFakeClipboard({
    text: 'private clipboard contents',
    unsupportedFormats: ['Custom.App.SecretFormat'],
  });
  const harness = createHarness({ clipboard });

  const result = await harness.service.pasteText({
    text: 'dictated text',
    target: harness.target,
  });

  assert.equal(result.ok, true);
  assert.equal(result.clipboardCommonFormatsRestored, true);
  assert.equal(result.clipboardFullyRestored, false);
  assert.deepEqual(result.droppedClipboardFormats, [
    'Custom.App.SecretFormat',
  ]);
  assert.match(harness.warnings[0], /Custom\.App\.SecretFormat/);
  assert.doesNotMatch(harness.warnings.join('\n'), /private clipboard contents/);
});

test('history failure prevents both clipboard mutation and user32 input', async () => {
  const harness = createHarness({
    historyAppend: async () => {
      throw new Error('database unavailable');
    },
  });

  const result = await harness.service.pasteText({
    text: 'must not be lost',
    target: harness.target,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'history-write-failed');
  assert.equal(result.historySaved, false);
  assert.equal(harness.clipboard.getWrites(), 0);
  assert.equal(
    harness.events.some((event) => event.startsWith('send:')),
    false
  );
});

const IMAGE_BYTES = Buffer.from([1, 2, 3, 4]);

function imageHtmlClipboard(overrides) {
  const base = createFakeClipboard({
    text: 'https://cdn.example/x.png',
    html: '<img src="https://cdn.example/x.png">',
    imagePng: IMAGE_BYTES,
  });
  return Object.assign(base, overrides({ ...base }));
}

test('a format that cannot be written is named and everything else is restored', async () => {
  const clipboard = imageHtmlClipboard((base) => ({
    write(data) {
      if (data.html !== undefined) throw new Error('HTML write refused');
      base.write(data);
    },
  }));
  const harness = createHarness({ clipboard });

  const result = await harness.service.pasteText({ text: 'dictated', target: harness.target });

  assert.equal(result.ok, true);
  assert.equal(result.clipboardFullyRestored, false);
  assert.deepEqual(result.clipboardFailedFormats, ['html']);
  const state = clipboard.getState();
  assert.equal(state.text, 'https://cdn.example/x.png');
  assert.deepEqual(state.imagePng, IMAGE_BYTES);
  assert.ok(harness.warnings.some((line) => /format html could not be restored: HTML write refused/.test(line)));
  assert.doesNotMatch(harness.warnings.join('\n'), /cdn\.example/);
});

test('a format that reads back different is dropped, the rest stays', async () => {
  let reads = 0;
  const clipboard = imageHtmlClipboard((base) => ({
    readHTML: () => (reads++ === 0 ? base.readHTML() : '<corrupt>'),
  }));
  const harness = createHarness({ clipboard });

  const result = await harness.service.pasteText({ text: 'dictated', target: harness.target });

  assert.equal(result.ok, true);
  assert.deepEqual(result.clipboardFailedFormats, ['html']);
  assert.deepEqual(clipboard.getState().imagePng, IMAGE_BYTES);
  assert.ok(harness.warnings.some((line) => /format html could not be restored/.test(line)));
});

test('a format that cannot be read at snapshot time is named and skipped', async () => {
  const clipboard = imageHtmlClipboard(() => ({
    readHTML() {
      throw new Error('clipboard read denied');
    },
  }));
  const harness = createHarness({ clipboard });

  const result = await harness.service.pasteText({ text: 'dictated', target: harness.target });

  assert.equal(result.ok, true);
  assert.deepEqual(result.clipboardFailedFormats, ['html']);
  assert.deepEqual(clipboard.getState().imagePng, IMAGE_BYTES);
});

test('a format listed but empty (image plus blank HTML) restores cleanly', async () => {
  const clipboard = imageHtmlClipboard((base) => ({
    availableFormats: () => [...base.availableFormats(), 'text/html'],
    readHTML: () => '',
  }));
  const harness = createHarness({ clipboard });

  const result = await harness.service.pasteText({ text: 'dictated', target: harness.target });

  assert.equal(result.ok, true);
  assert.equal(result.clipboardFullyRestored, true);
  assert.deepEqual(result.clipboardFailedFormats, []);
  assert.deepEqual(clipboard.getState().imagePng, IMAGE_BYTES);
});

test('a clipboard where nothing can be restored fails and is not left holding the dictation', async () => {
  const clipboard = imageHtmlClipboard((base) => ({
    write() {
      throw new Error('clipboard locked');
    },
    clear: base.clear,
  }));
  const harness = createHarness({ clipboard });

  const result = await harness.service.pasteText({ text: 'dictated', target: harness.target });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'clipboard-restore-failed');
});
