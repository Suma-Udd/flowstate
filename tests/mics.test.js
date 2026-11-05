'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  CHANNELS,
  createMicrophoneService,
  normaliseDevices,
} = require('../src/main/mics');

let nextWebContentsId = 100;

class FakeMicWindow extends EventEmitter {
  static windows = [];

  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.webContents = new EventEmitter();
    this.webContents.id = ++nextWebContentsId;
    this.webContents.sent = [];
    this.webContents.send = (channel, payload) => {
      this.webContents.sent.push([channel, payload]);
    };
    FakeMicWindow.windows.push(this);
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }
  loadFile() {
    return Promise.resolve();
  }
}

function fakeSession() {
  return {
    check: null,
    request: null,
    setPermissionCheckHandler(handler) {
      this.check = handler;
    },
    setPermissionRequestHandler(handler) {
      this.request = handler;
    },
  };
}

test('normaliseDevices drops the anonymous no-permission input instead of failing', () => {
  assert.deepEqual(normaliseDevices([{ deviceId: '', groupId: '', label: '' }]), []);
  assert.deepEqual(
    normaliseDevices([
      { deviceId: '', label: '' },
      { deviceId: 'default', label: 'Default - Yeti' },
    ]).map((device) => device.deviceId),
    ['default']
  );
});

test('normaliseDevices hides the Windows communications alias', () => {
  assert.deepEqual(
    normaliseDevices([
      { deviceId: 'default', label: 'Default - Microphone (Voicemod)' },
      { deviceId: 'communications', label: 'Communications - Microphone (Voicemod)' },
      { deviceId: 'abc', label: 'Headset (WH-1000XM6) (Bluetooth)' },
    ]).map((device) => device.deviceId),
    ['default', 'abc']
  );
});

test('with a session, the list window runs there and only it passes the media check', async () => {
  const ipcMain = new EventEmitter();
  const session = fakeSession();
  const service = createMicrophoneService({
    BrowserWindow: FakeMicWindow,
    ipcMain,
    session,
    createId: () => 'request-1',
  });

  const listed = service.list();
  const window = FakeMicWindow.windows.at(-1);
  assert.equal(window.options.webPreferences.session, session);
  assert.equal(window.options.webPreferences.sandbox, true);

  assert.equal(session.check(window.webContents, 'media'), true);
  assert.equal(session.check({ id: 9999 }, 'media'), false);
  assert.equal(session.check(window.webContents, 'notifications'), false);

  let granted;
  session.request(window.webContents, 'media', (value) => {
    granted = value;
  });
  assert.equal(granted, false, 'listing devices never needs a capture grant');

  window.webContents.emit('did-finish-load');
  ipcMain.emit(CHANNELS.result, { sender: window.webContents }, {
    id: 'request-1',
    devices: [{ deviceId: 'default', groupId: '', label: 'Default - Yeti Nano' }],
  });
  assert.deepEqual((await listed).map((device) => device.label), ['Yeti Nano']);

  assert.equal(window.destroyed, true);
  assert.equal(session.check(window.webContents, 'media'), false,
    'a destroyed window must not keep the permission');

  service.dispose();
  assert.equal(session.check, null);
  assert.equal(session.request, null);
});

test('without a session the window keeps the default session', () => {
  const service = createMicrophoneService({
    BrowserWindow: FakeMicWindow,
    ipcMain: new EventEmitter(),
  });
  service.list().catch(() => {});
  assert.equal('session' in FakeMicWindow.windows.at(-1).options.webPreferences, false);
  service.dispose();
});

test('a session without permission handlers is rejected', () => {
  assert.throws(
    () => createMicrophoneService({
      BrowserWindow: FakeMicWindow,
      ipcMain: new EventEmitter(),
      session: {},
    }),
    /Electron session/
  );
});
