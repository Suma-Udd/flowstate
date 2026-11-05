'use strict';

const path = require('node:path');

const CHANNELS = Object.freeze({
  cancel: 'flowstate:model-setup-cancel',
  download: 'flowstate:model-setup-download',
  status: 'flowstate:model-setup-status',
  statusChanged: 'flowstate:model-setup-status-changed',
});

function createModelWindowController({
  BrowserWindow,
  ipcMain,
  modelManager,
  onReady = () => {},
  timers = { setTimeout, clearTimeout },
} = {}) {
  if (typeof BrowserWindow !== 'function') {
    throw new TypeError('BrowserWindow is required.');
  }
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new TypeError('ipcMain is required.');
  }
  if (!modelManager || typeof modelManager.download !== 'function') {
    throw new TypeError('modelManager is required.');
  }

  let closeTimer = null;
  let disposed = false;
  let window;

  function sendStatus(status = modelManager.getState()) {
    if (window && !window.isDestroyed()) {
      window.webContents.send(CHANNELS.statusChanged, status);
    }
  }

  function scheduleReadyClose() {
    if (closeTimer !== null) timers.clearTimeout(closeTimer);
    closeTimer = timers.setTimeout(() => {
      closeTimer = null;
      if (window && !window.isDestroyed()) window.close();
    }, 900);
  }

  async function download() {
    try {
      const status = await modelManager.download();
      if (status.phase === 'ready') {
        onReady();
        scheduleReadyClose();
      }
      return status;
    } catch {
      return modelManager.getState();
    }
  }

  ipcMain.handle(CHANNELS.status, () => modelManager.getState());
  ipcMain.handle(CHANNELS.download, download);
  ipcMain.handle(CHANNELS.cancel, () => modelManager.cancel());
  const unsubscribe = modelManager.onStatus(sendStatus);

  function open({ autoDownload = true } = {}) {
    if (disposed) throw new Error('Model window controller is disposed.');
    if (window && !window.isDestroyed()) {
      window.show();
      window.focus();
      return window;
    }

    window = new BrowserWindow({
      width: 560,
      height: 500,
      minWidth: 520,
      minHeight: 460,
      show: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'Set up Flowstate',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'model-preload.js'),
      },
    });
    window.removeMenu();
    window.once('ready-to-show', () => {
      window?.show();
      sendStatus();
      if (autoDownload && modelManager.getState().phase !== 'ready') {
        void download();
      }
    });
    window.on('close', (event) => {
      const phase = modelManager.getState().phase;
      if (phase === 'verifying' || phase === 'installing') {
        event.preventDefault();
      } else if (phase === 'downloading') {
        modelManager.cancel();
      }
    });
    window.on('closed', () => {
      window = undefined;
      modelManager.cancel();
    });
    void window.loadFile(
      path.join(__dirname, '..', 'renderer', 'model-download', 'index.html')
    );
    return window;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    ipcMain.removeHandler(CHANNELS.status);
    ipcMain.removeHandler(CHANNELS.download);
    ipcMain.removeHandler(CHANNELS.cancel);
    if (closeTimer !== null) timers.clearTimeout(closeTimer);
    closeTimer = null;
    modelManager.cancel();
    if (window && !window.isDestroyed()) window.destroy();
    window = undefined;
  }

  return {
    dispose,
    getWindow: () => window,
    open,
  };
}

module.exports = {
  CHANNELS,
  createModelWindowController,
};
