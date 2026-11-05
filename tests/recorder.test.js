'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const {
  AMPLITUDE_INTERVAL_MS,
  createRecorderManager,
  RecorderCancelledError,
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
    this.options = options;
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

class FakeSession {
  setPermissionCheckHandler(handler) {
    this.check = handler;
  }
  setPermissionRequestHandler(handler) {
    this.request = handler;
  }
}

function harness() {
  const ipcMain = new EventEmitter();
  const windows = [];
  const amplitudes = [];
  const errors = [];
  const fakeSession = new FakeSession();
  let clock = 0;
  let nextId = 10;
  const manager = createRecorderManager({
    BrowserWindow: class {
      constructor(options) {
        const window = new FakeWindow(options, nextId++);
        windows.push(window);
        return window;
      }
    },
    ipcMain,
    session: fakeSession,
    now: () => clock,
    onAmplitude: (value) => amplitudes.push(value),
    onError: (message) => errors.push(message),
  });

  const event = () => ({ sender: windows.at(-1).webContents });
  return {
    amplitudes,
    errors,
    event,
    ipcMain,
    manager,
    session: fakeSession,
    setClock: (value) => { clock = value; },
    window: () => windows.at(-1),
  };
}

test('recorder window is hidden, sandboxed, and grants only its own audio permission', () => {
  const h = harness();
  const started = h.manager.start();
  const window = h.window();

  assert.equal(window.options.show, false);
  assert.equal(window.options.skipTaskbar, true);
  assert.equal(window.options.focusable, false);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.sandbox, true);

  assert.equal(
    h.session.check(window.webContents, 'media', '', { mediaTypes: ['audio'] }),
    true
  );
  assert.equal(
    h.session.check({ id: 999 }, 'media', '', { mediaTypes: ['audio'] }),
    false
  );
  assert.equal(h.session.check(window.webContents, 'notifications'), false);

  h.manager.dispose();
  assert.rejects(started, RecorderCancelledError);
});

test('start, throttled amplitude, stop, and PCM completion are correlated', async () => {
  const h = harness();
  const started = h.manager.start({ deviceId: 'mic-2' });
  const window = h.window();
  window.webContents.emit('did-finish-load');
  assert.deepEqual(window.webContents.sent, [
    ['recorder:command', { type: 'open', deviceId: 'mic-2' }],
  ]);

  h.ipcMain.emit('recorder:opened', h.event(), {
    contextSampleRate: 48_000,
    deviceId: 'mic-2',
    deviceLabel: 'Desk mic',
  });
  await Promise.resolve();
  assert.deepEqual(window.webContents.sent.at(-1), [
    'recorder:command',
    { type: 'begin' },
  ]);
  h.ipcMain.emit('recorder:started', h.event());
  assert.equal((await started).deviceId, 'mic-2');

  h.setClock(0);
  h.ipcMain.emit('recorder:amplitude', h.event(), 0.2);
  h.setClock(AMPLITUDE_INTERVAL_MS - 1);
  h.ipcMain.emit('recorder:amplitude', h.event(), 0.8);
  h.setClock(AMPLITUDE_INTERVAL_MS + 1);
  h.ipcMain.emit('recorder:amplitude', h.event(), 4);
  assert.deepEqual(h.amplitudes, [0.2, 1]);

  const completed = h.manager.stop();
  assert.deepEqual(window.webContents.sent.at(-1), [
    'recorder:command',
    { type: 'stop' },
  ]);
  const pcm = new Int16Array([1, -2, 3]);
  h.ipcMain.emit('recorder:complete', h.event(), {
    pcm,
    metadata: { capturedSeconds: 0.5, outputSampleRate: 16_000 },
  });
  assert.equal((await completed).pcm, pcm);
  // The window and microphone stay open for the warm hold; destroy ends it.
  assert.equal(window.isDestroyed(), false);
  h.manager.dispose();
  assert.equal(window.isDestroyed(), true);
});

test('permission and missing-device errors reject capture and surface a reason', async () => {
  const h = harness();
  const started = h.manager.start();
  h.ipcMain.emit(
    'recorder:error',
    h.event(),
    'No microphone is available.'
  );

  await assert.rejects(started, /No microphone/);
  assert.deepEqual(h.errors, ['No microphone is available.']);
  assert.equal(h.manager.isCapturing(), false);
});

test('the AudioWorklet emits levels at 30Hz rather than audio-buffer rate', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'recorder', 'worklet.js'),
    'utf8'
  );
  assert.match(source, /Math\.round\(sampleRate \/ 30\)/);
  assert.match(source, /levelSamples >= this\.levelWindow/);
  assert.match(source, /postMessage\(\{ type: 'amplitude', amplitude \}\)/);
});
