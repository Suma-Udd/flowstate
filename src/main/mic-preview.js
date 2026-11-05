'use strict';

const { EventEmitter } = require('node:events');
const path = require('node:path');

/**
 * A continuous, one-device-at-a-time microphone level meter for the Dictation
 * screen (issue #18) — "a dead mic must be obvious in one glance" per
 * the design notes. It is deliberately not the recorder in recorder.js: it never
 * assembles PCM, only forwards the AudioWorklet's ~30Hz RMS amplitude, and it
 * runs on its own session partition so its permission grant cannot collide
 * with the real dictation recorder's session.defaultSession handler.
 */

function clampAmplitude(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

function createMicPreviewService({
  BrowserWindow,
  ipcMain,
  session,
  preloadPath = path.join(__dirname, 'mic-preview-preload.js'),
  rendererPath = path.join(__dirname, '..', 'renderer', 'mic-preview', 'index.html'),
} = {}) {
  if (typeof BrowserWindow !== 'function') {
    throw new TypeError('Microphone preview requires BrowserWindow.');
  }
  if (!ipcMain || typeof ipcMain.on !== 'function') {
    throw new TypeError('Microphone preview requires ipcMain.');
  }
  if (
    !session
    || typeof session.setPermissionCheckHandler !== 'function'
    || typeof session.setPermissionRequestHandler !== 'function'
  ) {
    throw new TypeError('Microphone preview requires an isolated Electron session.');
  }

  const events = new EventEmitter();
  let active; // { window, deviceId }
  let disposed = false;

  function senderIsActive(event) {
    return Boolean(
      active
      && !active.window.isDestroyed()
      && event?.sender?.id === active.window.webContents.id
    );
  }

  function permissionIsPreviewAudio(webContents, permission, details) {
    return Boolean(
      active
      && webContents?.id === active.window.webContents.id
      && permission === 'media'
      && (!details?.mediaTypes || details.mediaTypes.includes('audio'))
    );
  }

  session.setPermissionCheckHandler((webContents, permission, _origin, details) =>
    permissionIsPreviewAudio(webContents, permission, details));
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(permissionIsPreviewAudio(webContents, permission, details));
  });

  const onLevel = (event, value) => {
    if (!senderIsActive(event)) return;
    events.emit('level', clampAmplitude(value));
  };
  const onError = (event, message) => {
    if (!senderIsActive(event)) return;
    const reason =
      typeof message === 'string' && message.trim()
        ? message.trim().slice(0, 500)
        : 'Microphone preview failed.';
    events.emit('error', reason);
    stop();
  };

  ipcMain.on('flowstate:mic-preview-internal-level', onLevel);
  ipcMain.on('flowstate:mic-preview-internal-error', onError);

  function destroyActive() {
    if (!active) return;
    const { window } = active;
    active = undefined;
    if (!window.isDestroyed()) window.destroy();
  }

  function start(deviceId = null) {
    if (disposed) throw new Error('Microphone preview has been disposed.');
    const normalisedDeviceId = deviceId === undefined ? null : deviceId;
    if (normalisedDeviceId !== null && typeof normalisedDeviceId !== 'string') {
      throw new TypeError('deviceId must be a string or null.');
    }
    if (active) {
      if (active.deviceId === normalisedDeviceId) return;
      destroyActive();
    }

    const window = new BrowserWindow({
      title: 'Flowstate Microphone Preview',
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
        session,
      },
    });
    active = { window, deviceId: normalisedDeviceId };

    window.webContents.once('did-finish-load', () => {
      if (active?.window !== window || window.isDestroyed()) return;
      window.webContents.send('flowstate:mic-preview-internal-command', {
        type: 'start',
        deviceId: normalisedDeviceId,
      });
    });
    window.webContents.once('render-process-gone', () => {
      if (active?.window !== window) return;
      active = undefined;
      events.emit('error', 'The microphone preview stopped unexpectedly.');
    });
    window.once('closed', () => {
      if (active?.window === window) active = undefined;
    });
    void window.loadFile(rendererPath).catch((error) => {
      if (active?.window === window) active = undefined;
      events.emit('error', `Microphone preview failed to load: ${error.message}`);
    });
  }

  function stop() {
    destroyActive();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    destroyActive();
    ipcMain.removeListener('flowstate:mic-preview-internal-level', onLevel);
    ipcMain.removeListener('flowstate:mic-preview-internal-error', onError);
    session.setPermissionCheckHandler(null);
    session.setPermissionRequestHandler(null);
    events.removeAllListeners();
  }

  return Object.freeze({
    start,
    stop,
    dispose,
    isActive: () => Boolean(active),
    onLevel(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('Level listener must be a function.');
      }
      events.on('level', listener);
      return () => events.off('level', listener);
    },
    onError(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('Error listener must be a function.');
      }
      events.on('error', listener);
      return () => events.off('error', listener);
    },
  });
}

module.exports = {
  clampAmplitude,
  createMicPreviewService,
};
