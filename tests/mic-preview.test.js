'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { clampAmplitude, createMicPreviewService } = require('../src/main/mic-preview');

class FakeWebContents extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
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
  const fakeSession = new FakeSession();
  let nextId = 10;
  const service = createMicPreviewService({
    BrowserWindow: class {
      constructor(options) {
        const window = new FakeWindow(options, nextId++);
        windows.push(window);
        return window;
      }
    },
    ipcMain,
    session: fakeSession,
  });

  const event = () => ({ sender: windows.at(-1).webContents });
  return { event, ipcMain, service, session: fakeSession, window: () => windows.at(-1), windows };
}

test('clampAmplitude keeps values inside 0..1 and rejects garbage', () => {
  assert.equal(clampAmplitude(0.4), 0.4);
  assert.equal(clampAmplitude(-3), 0);
  assert.equal(clampAmplitude(9), 1);
  assert.equal(clampAmplitude('nonsense'), 0);
});

test('the preview window is hidden, sandboxed, and uses the isolated session', () => {
  const h = harness();
  h.service.start('mic-2');
  const window = h.window();

  assert.equal(window.options.show, false);
  assert.equal(window.options.skipTaskbar, true);
  assert.equal(window.options.focusable, false);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.options.webPreferences.session, h.session);

  assert.equal(
    h.session.check(window.webContents, 'media', '', { mediaTypes: ['audio'] }),
    true
  );
  assert.equal(h.session.check({ id: 999 }, 'media', '', { mediaTypes: ['audio'] }), false);
  assert.equal(h.session.check(window.webContents, 'notifications'), false);
});

test('start sends the device once the window has loaded', () => {
  const h = harness();
  h.service.start('mic-2');
  const window = h.window();
  const sent = [];
  const originalSend = window.webContents.send;
  window.webContents.send = (...args) => sent.push(args);
  window.webContents.emit('did-finish-load');

  assert.deepEqual(sent, [[
    'flowstate:mic-preview-internal-command',
    { type: 'start', deviceId: 'mic-2' },
  ]]);
  assert.equal(h.service.isActive(), true);
  void originalSend;
});

test('starting the same device again is a no-op; a different device swaps the window', () => {
  const h = harness();
  h.service.start('mic-2');
  const first = h.window();

  h.service.start('mic-2');
  assert.equal(h.window(), first, 'the same device must not recreate the window');
  assert.equal(first.destroyed, false);

  h.service.start('mic-3');
  assert.equal(first.destroyed, true, 'a device change tears down the old window');
  assert.equal(h.window() !== first, true);
  assert.equal(h.service.isActive(), true);
});

test('level and error messages are scoped to the active window only', () => {
  const h = harness();
  h.service.start(null);
  const active = h.window();
  const levels = [];
  const errors = [];
  h.service.onLevel((value) => levels.push(value));
  h.service.onError((message) => errors.push(message));

  h.ipcMain.emit('flowstate:mic-preview-internal-level', h.event(), 0.6);
  h.ipcMain.emit('flowstate:mic-preview-internal-level', { sender: { id: 9999 } }, 0.9);
  assert.deepEqual(levels, [0.6]);

  h.ipcMain.emit('flowstate:mic-preview-internal-error', h.event(), 'The microphone disconnected.');
  assert.deepEqual(errors, ['The microphone disconnected.']);
  assert.equal(active.destroyed, true, 'an error stops the preview');
  assert.equal(h.service.isActive(), false);
});

test('stop and dispose destroy the window and refuse further use', () => {
  const h = harness();
  h.service.start('mic-1');
  const window = h.window();
  h.service.stop();
  assert.equal(window.destroyed, true);
  assert.equal(h.service.isActive(), false);

  h.service.start('mic-1');
  h.service.dispose();
  assert.equal(h.window().destroyed, true);
  assert.throws(() => h.service.start('mic-1'), /disposed/);
});

test('a render-process crash surfaces an error and clears the active window', () => {
  const h = harness();
  h.service.start('mic-1');
  const window = h.window();
  const errors = [];
  h.service.onError((message) => errors.push(message));

  window.webContents.emit('render-process-gone');
  assert.deepEqual(errors, ['The microphone preview stopped unexpectedly.']);
  assert.equal(h.service.isActive(), false);
});
