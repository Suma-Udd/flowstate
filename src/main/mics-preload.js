'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = Object.freeze({
  command: 'flowstate:mics-command',
  result: 'flowstate:mics-result',
  changed: 'flowstate:mics-changed-internal',
});

contextBridge.exposeInMainWorld('flowMics', Object.freeze({
  onCommand(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Microphone command callback must be a function.');
    }
    const listener = (_event, command) => callback(command);
    ipcRenderer.on(CHANNELS.command, listener);
    return () => ipcRenderer.removeListener(CHANNELS.command, listener);
  },
  result: (payload) => ipcRenderer.send(CHANNELS.result, payload),
  changed: (devices) => ipcRenderer.send(CHANNELS.changed, devices),
}));
