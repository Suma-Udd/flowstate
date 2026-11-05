'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(callback) {
  const listener = (_event, command) => {
    if (!command || command.type !== 'start') return;
    if (command.deviceId !== null && typeof command.deviceId !== 'string') return;
    callback(Object.freeze({ type: 'start', deviceId: command.deviceId ?? null }));
  };
  ipcRenderer.on('flowstate:mic-preview-internal-command', listener);
  return () => ipcRenderer.removeListener('flowstate:mic-preview-internal-command', listener);
}

contextBridge.exposeInMainWorld(
  'flowMicPreview',
  Object.freeze({
    onCommand: subscribe,
    level: (value) => ipcRenderer.send('flowstate:mic-preview-internal-level', value),
    error: (message) => ipcRenderer.send('flowstate:mic-preview-internal-error', String(message)),
  })
);
