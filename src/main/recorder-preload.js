'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, command) => {
    if (
      !command
      || !['open', 'begin', 'stop', 'abort', 'close'].includes(command.type)
      || (
        command.type === 'open'
        && command.deviceId !== null
        && typeof command.deviceId !== 'string'
      )
    ) {
      return;
    }
    callback(Object.freeze({
      type: command.type,
      deviceId: command.deviceId ?? null,
    }));
  };
  ipcRenderer.on('recorder:command', listener);
  return () => ipcRenderer.removeListener('recorder:command', listener);
}

contextBridge.exposeInMainWorld(
  'flowRecorder',
  Object.freeze({
    onCommand: subscribe,
    opened: (metadata) => ipcRenderer.send('recorder:opened', metadata),
    started: () => ipcRenderer.send('recorder:started'),
    marks: (marks) => ipcRenderer.send('recorder:marks', marks),
    amplitude: (value) => ipcRenderer.send('recorder:amplitude', value),
    complete: (pcm, metadata) =>
      ipcRenderer.send('recorder:complete', { pcm, metadata }),
    error: (message) => ipcRenderer.send('recorder:error', String(message)),
  })
);
