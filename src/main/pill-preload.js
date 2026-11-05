'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The recording pill's bridge (issue #11).
 *
 * Deliberately separate from preload.js: that file is the GUI's `window.flow`
 * surface, defined in full in SUM-77. The pill is not the GUI. It draws five
 * states and it does not have a single thing to say back, so its bridge is
 * one-way by construction — there is no `invoke`, no `send`, and nothing here
 * that a compromised overlay renderer could call.
 *
 * Every payload is validated on arrival even though main is the only sender.
 * A malformed state would leave the pill styled as nothing at all, which
 * during a live dictation is indistinguishable from the app having died.
 */

const STATES = ['idle-armed', 'listening', 'thinking', 'pasting', 'error'];

/** Subscribes to a channel, handing the listener the payload and nothing else. */
function subscribe(channel, map, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => {
    const value = map(payload);
    if (value === undefined) return;
    callback(value);
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld(
  'flowPill',
  Object.freeze({
    onState: (callback) =>
      subscribe(
        'pill:state',
        (payload) => {
          if (!payload || !STATES.includes(payload.state)) return undefined;
          return {
            state: payload.state,
            // One line, and short: the pill is 56px tall and the user is
            // mid-sentence. Anything longer is for the log, not for here.
            reason: typeof payload.reason === 'string' ? payload.reason.slice(0, 120) : '',
          };
        },
        callback
      ),

    onAmplitude: (callback) =>
      subscribe(
        'pill:amplitude',
        (payload) => {
          const value = Number(payload);
          if (!Number.isFinite(value)) return undefined;
          return Math.min(1, Math.max(0, value));
        },
        callback
      ),

    onVisibility: (callback) =>
      subscribe('pill:visibility', (payload) => Boolean(payload), callback),
  })
);
