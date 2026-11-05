'use strict';

const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const path = require('node:path');

const CHANNELS = Object.freeze({
  command: 'flowstate:mics-command',
  result: 'flowstate:mics-result',
  changed: 'flowstate:mics-changed-internal',
});

const LIST_TIMEOUT_MS = 5_000;

function cleanText(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.length > 1_024) {
    throw new TypeError(`Microphone ${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length === 0) {
    throw new TypeError(`Microphone ${field} cannot be empty.`);
  }
  return trimmed;
}

function normaliseDevices(input) {
  if (!Array.isArray(input) || input.length > 256) {
    throw new TypeError('Microphone enumeration returned an invalid device list.');
  }

  const devices = [];
  const seen = new Set();
  for (const candidate of input) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new TypeError('Microphone enumeration returned an invalid device.');
    }
    // Chromium reports one anonymous input with an empty id when the page has
    // no media permission. It is not a device anyone can select, so it is
    // dropped instead of failing the whole list.
    const deviceId = cleanText(candidate.deviceId, 'deviceId', { allowEmpty: true });
    if (deviceId.length === 0 || seen.has(deviceId)) continue;
    // Windows' "Communications" entry is an alias of a real input already in
    // the list; showing it makes one microphone look like two.
    if (deviceId === 'communications') continue;
    seen.add(deviceId);

    const rawLabel = cleanText(candidate.label ?? '', 'label', { allowEmpty: true });
    const isDefault = deviceId === 'default';
    const fallback = isDefault
      ? 'System default microphone'
      : `Microphone ${devices.length + 1}`;
    const label = rawLabel.replace(/^default\s*[-–—:]\s*/i, '').trim() || fallback;

    devices.push(Object.freeze({
      deviceId,
      groupId: cleanText(candidate.groupId ?? '', 'groupId', { allowEmpty: true }),
      label,
      isDefault,
    }));
  }

  devices.sort((left, right) => Number(right.isDefault) - Number(left.isDefault));
  return Object.freeze(devices);
}

function createMicrophoneService({
  BrowserWindow,
  ipcMain,
  preloadPath = path.join(__dirname, 'mics-preload.js'),
  rendererPath = path.join(__dirname, '..', 'renderer', 'mics', 'index.html'),
  session,
  timers = { setTimeout, clearTimeout },
  createId = randomUUID,
} = {}) {
  if (typeof BrowserWindow !== 'function') {
    throw new TypeError('Microphone service requires BrowserWindow.');
  }
  if (
    session !== undefined
    && (
      typeof session?.setPermissionCheckHandler !== 'function'
      || typeof session?.setPermissionRequestHandler !== 'function'
    )
  ) {
    throw new TypeError('Microphone service session must be an Electron session.');
  }
  if (!ipcMain || typeof ipcMain.on !== 'function') {
    throw new TypeError('Microphone service requires ipcMain.');
  }

  const events = new EventEmitter();
  const pending = new Map();
  let disposed = false;
  let ready = false;
  let watcherCount = 0;
  let window;
  let queued = [];

  // enumerateDevices only returns real ids and labels when the page passes a
  // 'media' permission *check*. The recorder owns session.defaultSession's
  // handler and answers yes only for its own capture window, so this hidden
  // list window lives on its own session and is the only page it vouches for.
  // It never needs a capture grant, so every permission *request* is refused.
  if (session) {
    session.setPermissionCheckHandler((webContents, permission) =>
      permission === 'media'
      && Boolean(window && !window.isDestroyed())
      && webContents?.id === window.webContents.id);
    session.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
  }

  function senderIsService(event) {
    return Boolean(
      window
      && !window.isDestroyed()
      && event?.sender === window.webContents
    );
  }

  function rejectPending(error) {
    for (const request of pending.values()) {
      timers.clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }

  function destroyIfIdle() {
    if (watcherCount !== 0 || pending.size !== 0) return;
    if (window && !window.isDestroyed()) window.destroy();
  }

  function send(command) {
    if (!window || window.isDestroyed()) return;
    if (!ready) {
      queued.push(command);
      return;
    }
    window.webContents.send(CHANNELS.command, command);
  }

  function ensureWindow() {
    if (disposed) throw new Error('Microphone service has been disposed.');
    if (window && !window.isDestroyed()) return window;

    ready = false;
    queued = [];
    window = new BrowserWindow({
      title: 'Flowstate Microphone Devices',
      width: 1,
      height: 1,
      show: false,
      frame: false,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        ...(session ? { session } : {}),
      },
    });

    const created = window;
    window.webContents.once('did-finish-load', () => {
      if (window !== created || created.isDestroyed()) return;
      ready = true;
      const commands = queued;
      queued = [];
      for (const command of commands) send(command);
    });
    window.webContents.once('render-process-gone', (_event, details = {}) => {
      rejectPending(new Error(
        `Microphone device monitor stopped unexpectedly (${details.reason || 'unknown'}).`
      ));
      if (!created.isDestroyed()) created.destroy();
    });
    window.once('closed', () => {
      if (window !== created) return;
      window = undefined;
      ready = false;
      queued = [];
      rejectPending(new Error('Microphone device monitor closed unexpectedly.'));
    });
    void window.loadFile(rendererPath).catch((error) => {
      rejectPending(new Error(`Microphone device monitor failed to load: ${error.message}`));
      if (!created.isDestroyed()) created.destroy();
    });
    return window;
  }

  const onResult = (event, payload) => {
    if (!senderIsService(event) || !payload || typeof payload.id !== 'string') return;
    const request = pending.get(payload.id);
    if (!request) return;
    pending.delete(payload.id);
    timers.clearTimeout(request.timer);
    if (typeof payload.error === 'string' && payload.error.trim()) {
      request.reject(new Error(payload.error.trim().slice(0, 500)));
    } else {
      try {
        request.resolve(normaliseDevices(payload.devices));
      } catch (error) {
        request.reject(error);
      }
    }
    destroyIfIdle();
  };

  const onChanged = (event, devices) => {
    if (!senderIsService(event) || watcherCount === 0) return;
    try {
      events.emit('change', normaliseDevices(devices));
    } catch {
      // The sandboxed utility renderer is still an IPC sender. Invalid data is
      // dropped rather than forwarded into every application window.
    }
  };

  ipcMain.on(CHANNELS.result, onResult);
  ipcMain.on(CHANNELS.changed, onChanged);

  function list() {
    ensureWindow();
    const id = createId();
    return new Promise((resolve, reject) => {
      const timer = timers.setTimeout(() => {
        pending.delete(id);
        reject(new Error('Microphone enumeration timed out.'));
        destroyIfIdle();
      }, LIST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      send({ type: 'list', id });
    });
  }

  function watch() {
    ensureWindow();
    watcherCount += 1;
    if (watcherCount === 1) send({ type: 'watch' });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      watcherCount = Math.max(0, watcherCount - 1);
      if (watcherCount === 0) {
        send({ type: 'unwatch' });
        destroyIfIdle();
      }
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    watcherCount = 0;
    ipcMain.removeListener(CHANNELS.result, onResult);
    ipcMain.removeListener(CHANNELS.changed, onChanged);
    rejectPending(new Error('Microphone service was disposed.'));
    if (window && !window.isDestroyed()) window.destroy();
    window = undefined;
    events.removeAllListeners();
    if (session) {
      session.setPermissionCheckHandler(null);
      session.setPermissionRequestHandler(null);
    }
  }

  return Object.freeze({
    dispose,
    list,
    onChange(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('Microphone change listener must be a function.');
      }
      events.on('change', listener);
      return () => events.off('change', listener);
    },
    watch,
  });
}

module.exports = {
  CHANNELS,
  LIST_TIMEOUT_MS,
  createMicrophoneService,
  normaliseDevices,
};
