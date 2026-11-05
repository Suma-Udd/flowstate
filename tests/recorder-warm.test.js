'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const {
  RecorderCancelledError,
  createRecorderManager,
} = require('../src/main/recorder');

class FakeWebContents extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.sent = [];
  }
  send(channel, payload) {
    this.sent.push([channel, payload]);
  }
}

class FakeWindow extends EventEmitter {
  constructor(options, id) {
    super();
    this.destroyed = false;
    this.webContents = new FakeWebContents(id);
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }
  isDestroyed() {
    return this.destroyed;
  }
  loadFile() {
    return Promise.resolve();
  }
}

function harness() {
  const ipcMain = new EventEmitter();
  const windows = [];
  const errors = [];
  const marks = [];
  const pending = [];
  let holdMs = 30_000;
  let nextId = 10;
  const timers = {
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, live: true };
      pending.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer) timer.live = false;
    },
  };
  const manager = createRecorderManager({
    BrowserWindow: class {
      constructor(options) {
        const window = new FakeWindow(options, nextId++);
        windows.push(window);
        return window;
      }
    },
    ipcMain,
    session: {
      setPermissionCheckHandler() {},
      setPermissionRequestHandler() {},
    },
    onError: (message) => errors.push(message),
    onMarks: (value) => marks.push(value),
    getWarmHoldMs: () => holdMs,
    timers,
  });
  return {
    errors,
    ipcMain,
    manager,
    marks,
    windows,
    fire() {
      for (const timer of pending.splice(0)) if (timer.live) timer.fn();
    },
    liveTimers: () => pending.filter((timer) => timer.live).length,
    setHold: (value) => { holdMs = value; },
    window: () => windows.at(-1),
  };
}

function openMic(h, window = h.window()) {
  window.webContents.emit('did-finish-load');
  h.ipcMain.emit('recorder:opened', { sender: window.webContents }, {
    contextSampleRate: 48_000,
    deviceId: 'd',
    deviceLabel: 'Mic',
  });
}

async function dictate(h) {
  const started = h.manager.start({ deviceId: 'd' });
  const window = h.window();
  openMic(h, window);
  await Promise.resolve();
  h.ipcMain.emit('recorder:started', { sender: window.webContents });
  await started;
  const completed = h.manager.stop();
  h.ipcMain.emit('recorder:complete', { sender: window.webContents }, {
    pcm: new Int16Array([1, 2]),
    metadata: { capturedSeconds: 0.1, outputSampleRate: 16_000 },
  });
  await completed;
  return window;
}

test('a second press inside the warm hold reuses the open microphone', async () => {
  const h = harness();
  const first = await dictate(h);
  assert.equal(h.windows.length, 1);
  assert.equal(h.manager.isWarm(), true);

  const sentBefore = first.webContents.sent.length;
  const started = h.manager.start({ deviceId: 'd' });
  assert.equal(h.windows.length, 1, 'no new window for a warm press');
  await Promise.resolve();
  assert.deepEqual(first.webContents.sent.slice(sentBefore), [
    ['recorder:command', { type: 'begin' }],
  ]);
  h.ipcMain.emit('recorder:started', { sender: first.webContents });
  await started;
  assert.equal(h.marks.at(-1).warm, true);
  // Pressing again cancelled the pending close.
  h.fire();
  assert.equal(first.isDestroyed(), false);
  h.manager.cancel();
});

test('the warm hold expires: nothing is resident afterwards', async () => {
  const h = harness();
  const window = await dictate(h);
  assert.equal(h.liveTimers(), 1);
  h.fire();
  assert.equal(window.isDestroyed(), true);
  assert.equal(h.manager.isWarm(), false);
  void h.manager.start({ deviceId: 'd' }).catch(() => {});
  assert.equal(h.windows.length, 2, 'the next press pays a cold open');
  h.manager.cancel();
});

test('a zero warm hold closes the microphone straight after the dictation', async () => {
  const h = harness();
  h.setHold(0);
  const window = await dictate(h);
  assert.equal(window.isDestroyed(), true);
});

test('prewarm opens early and the real press adopts that window', async () => {
  const h = harness();
  h.manager.prewarm({ deviceId: 'd' });
  const window = h.window();
  assert.equal(h.windows.length, 1);
  openMic(h, window);
  assert.equal(h.manager.isWarm(), true);

  const started = h.manager.start({ deviceId: 'd' });
  assert.equal(h.windows.length, 1, 'start adopted the armed window');
  await Promise.resolve();
  assert.deepEqual(window.webContents.sent.at(-1), [
    'recorder:command',
    { type: 'begin' },
  ]);
  h.ipcMain.emit('recorder:started', { sender: window.webContents });
  await started;
  h.fire();
  assert.equal(window.isDestroyed(), false, 'the speculative close was cancelled');
  h.manager.cancel();
});

test('a press while the armed microphone is still opening waits, then begins', async () => {
  const h = harness();
  h.manager.prewarm({ deviceId: 'd' });
  const window = h.window();
  window.webContents.emit('did-finish-load');
  const started = h.manager.start({ deviceId: 'd' });
  await Promise.resolve();
  assert.equal(
    window.webContents.sent.some(([, c]) => c.type === 'begin'),
    false
  );
  h.ipcMain.emit('recorder:opened', { sender: window.webContents }, {
    contextSampleRate: 48_000,
    deviceId: 'd',
    deviceLabel: 'Mic',
  });
  await Promise.resolve();
  assert.deepEqual(window.webContents.sent.at(-1), [
    'recorder:command',
    { type: 'begin' },
  ]);
  h.ipcMain.emit('recorder:started', { sender: window.webContents });
  await started;
  h.manager.cancel();
});

test('an unused prewarm lets go by itself and on disarm', () => {
  const h = harness();
  h.manager.prewarm({ deviceId: 'd' });
  const first = h.window();
  h.fire();
  assert.equal(first.isDestroyed(), true);

  h.manager.prewarm({ deviceId: 'd' });
  const second = h.window();
  h.manager.cancelPrewarm();
  assert.equal(second.isDestroyed(), true);
});

test('disarm never tears down a window a dictation owns or a hold is keeping', async () => {
  const h = harness();
  const window = await dictate(h);
  h.manager.prewarm({ deviceId: 'd' });
  h.manager.cancelPrewarm();
  assert.equal(window.isDestroyed(), false, 'warm-held window is not speculative');

  const started = h.manager.start({ deviceId: 'd' });
  h.manager.cancelPrewarm();
  assert.equal(window.isDestroyed(), false);
  h.manager.cancel();
  await assert.rejects(started, RecorderCancelledError);
});

test('prewarm with a different microphone replaces the open window', async () => {
  const h = harness();
  const first = await dictate(h);
  h.manager.prewarm({ deviceId: 'other' });
  assert.equal(first.isDestroyed(), true);
  assert.equal(h.windows.length, 2);
  h.manager.cancelPrewarm();
});

test('cancel during a warm capture aborts it but keeps the microphone warm', async () => {
  const h = harness();
  const window = await dictate(h);
  const started = h.manager.start({ deviceId: 'd' });
  await Promise.resolve();
  h.manager.cancel();
  await assert.rejects(started, RecorderCancelledError);
  assert.deepEqual(window.webContents.sent.at(-1), [
    'recorder:command',
    { type: 'abort' },
  ]);
  assert.equal(window.isDestroyed(), false);
  assert.equal(h.manager.isCapturing(), false);
  // A late `started` from the aborted capture is ignored.
  h.ipcMain.emit('recorder:started', { sender: window.webContents });
  assert.equal(h.manager.isCapturing(), false);
});

test('cancel while the microphone is still opening never sends begin', async () => {
  const h = harness();
  const started = h.manager.start({ deviceId: 'd' });
  const window = h.window();
  window.webContents.emit('did-finish-load');
  h.manager.cancel();
  await assert.rejects(started, RecorderCancelledError);
  openMic(h, window);
  await Promise.resolve();
  assert.equal(
    window.webContents.sent.some(([, c]) => c.type === 'begin'),
    false
  );
});

test('a warm microphone that disappears is dropped silently, then reopened', async () => {
  const h = harness();
  const window = await dictate(h);
  h.ipcMain.emit(
    'recorder:error',
    { sender: window.webContents },
    'The microphone disconnected during capture.'
  );
  assert.equal(window.isDestroyed(), true);
  assert.deepEqual(h.errors, []);
  void h.manager.start({ deviceId: 'd' }).catch(() => {});
  assert.equal(h.windows.length, 2);
  h.manager.cancel();
});

test('an error during a live capture surfaces and tears the window down', async () => {
  const h = harness();
  const window = await dictate(h);
  const started = h.manager.start({ deviceId: 'd' });
  await Promise.resolve();
  h.ipcMain.emit('recorder:error', { sender: window.webContents }, 'boom');
  await assert.rejects(started, /boom/);
  assert.deepEqual(h.errors, ['boom']);
  assert.equal(window.isDestroyed(), true);
});

test('recorder IPC from a foreign sender is ignored', async () => {
  const h = harness();
  const started = h.manager.start({ deviceId: 'd' });
  const window = h.window();
  openMic(h, window);
  await Promise.resolve();
  h.ipcMain.emit('recorder:started', { sender: { id: 999 } });
  assert.equal(h.manager.isCapturing(), true);
  h.ipcMain.emit('recorder:started', { sender: window.webContents });
  await started;
  h.manager.cancel();
});

test('dispose destroys a warm window and rejects a pending capture', async () => {
  const h = harness();
  const window = await dictate(h);
  const started = h.manager.start({ deviceId: 'd' });
  h.manager.dispose();
  await assert.rejects(started, RecorderCancelledError);
  assert.equal(window.isDestroyed(), true);
});

test('the renderer keeps a pre-roll ring and gates amplitude to live captures', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'recorder', 'recorder.js'),
    'utf8'
  );
  assert.match(source, /createPrerollRing/);
  assert.match(source, /if \(next\.recording\) bridge\.amplitude/);
  assert.match(source, /graph\.ring\.tail\(\)/);
});
