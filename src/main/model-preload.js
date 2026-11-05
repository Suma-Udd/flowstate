'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed preloads cannot import arbitrary local modules, so these channel
// names intentionally mirror model-window.js.
const CHANNELS = Object.freeze({
  cancel: 'flowstate:model-setup-cancel',
  download: 'flowstate:model-setup-download',
  status: 'flowstate:model-setup-status',
  statusChanged: 'flowstate:model-setup-status-changed',
});

contextBridge.exposeInMainWorld('flowModel', Object.freeze({
  cancel: () => ipcRenderer.invoke(CHANNELS.cancel),
  download: () => ipcRenderer.invoke(CHANNELS.download),
  status: () => ipcRenderer.invoke(CHANNELS.status),
  onStatus(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('onStatus callback must be a function.');
    }
    const listener = (_event, status) => callback(status);
    ipcRenderer.on(CHANNELS.statusChanged, listener);
    return () => ipcRenderer.removeListener(CHANNELS.statusChanged, listener);
  },
}));
