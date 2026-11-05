'use strict';

const path = require('node:path');

const MAX_CAPTURE_SECONDS = 120;
const OUTPUT_SAMPLE_RATE = 16_000;
const AMPLITUDE_INTERVAL_MS = 1000 / 30;
const wall = () => performance.timeOrigin + performance.now();

// How long the open microphone is kept after a dictation, so a quick second
// press starts instantly instead of paying the cold open again. Past this the
// recorder window is destroyed: nothing is resident at idle (G4) and Windows
// stops showing the microphone-in-use indicator.
const DEFAULT_WARM_HOLD_MS = 30_000;
// A first-key "arm" that never becomes a dictation (Ctrl+C) lets go quickly.
const DEFAULT_SPECULATIVE_HOLD_MS = 1_500;

class RecorderCancelledError extends Error {
  constructor(message = 'Recorder capture was cancelled.') {
    super(message);
    this.name = 'RecorderCancelledError';
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createRecorderManager({
  BrowserWindow,
  ipcMain,
  session,
  preloadPath = path.join(__dirname, 'recorder-preload.js'),
  rendererPath = path.join(__dirname, '..', 'renderer', 'recorder', 'index.html'),
  onAmplitude = () => {},
  onError = () => {},
  onMarks = () => {},
  getWarmHoldMs = () => DEFAULT_WARM_HOLD_MS,
  speculativeHoldMs = DEFAULT_SPECULATIVE_HOLD_MS,
  timers = { setTimeout, clearTimeout },
  now = () => performance.now(),
} = {}) {
  if (typeof BrowserWindow !== 'function') {
    throw new TypeError('BrowserWindow is required.');
  }
  if (!ipcMain || typeof ipcMain.on !== 'function') {
    throw new TypeError('ipcMain is required.');
  }
  if (
    !session
    || typeof session.setPermissionCheckHandler !== 'function'
    || typeof session.setPermissionRequestHandler !== 'function'
  ) {
    throw new TypeError('An Electron session is required.');
  }

  // `win` is the recorder renderer and its open microphone graph. It outlives a
  // single dictation (warm hold). `active` is the one dictation using it.
  let win;
  let active;
  let holdTimer = null;
  let disposed = false;
  const listeners = new Map();

  function senderIsWindow(event) {
    return Boolean(
      win
      && !win.window.isDestroyed()
      && event?.sender?.id === win.window.webContents.id
    );
  }

  function senderIsActive(event) {
    return Boolean(active && senderIsWindow(event));
  }

  function permissionIsRecorderAudio(webContents, permission, details) {
    return Boolean(
      win
      && webContents?.id === win.window.webContents.id
      && permission === 'media'
      && (!details?.mediaTypes || details.mediaTypes.includes('audio'))
    );
  }

  session.setPermissionCheckHandler(
    (webContents, permission, _origin, details) =>
      permissionIsRecorderAudio(webContents, permission, details)
  );
  session.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      callback(permissionIsRecorderAudio(webContents, permission, details));
    }
  );

  function addListener(channel, listener) {
    listeners.set(channel, listener);
    ipcMain.on(channel, listener);
  }

  function clearHold() {
    if (holdTimer !== null) timers.clearTimeout(holdTimer);
    holdTimer = null;
  }

  function destroyWindow() {
    clearHold();
    const closing = win;
    win = undefined;
    if (closing && !closing.window.isDestroyed()) closing.window.destroy();
  }

  // Keep the microphone open for `ms`, then drop the whole renderer.
  function holdThenClose(ms) {
    clearHold();
    if (!win) return;
    if (!(ms > 0)) {
      destroyWindow();
      return;
    }
    const holding = win;
    holdTimer = timers.setTimeout(() => {
      holdTimer = null;
      if (win === holding && !active) destroyWindow();
    }, ms);
  }

  function settleFailure(capture, reason) {
    if (!capture || capture.settled) return;
    capture.settled = true;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    capture.started.reject(error);
    capture.completed.reject(error);
  }

  function failCapture(capture, reason, { surface = true } = {}) {
    if (!capture || active !== capture) return;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    settleFailure(capture, error);
    active = undefined;
    destroyWindow();
    if (surface) onError(error.message);
  }

  addListener('recorder:opened', (event, metadata) => {
    if (!senderIsWindow(event) || win.opened) return;
    if (
      !metadata
      || !Number.isFinite(metadata.contextSampleRate)
      || metadata.contextSampleRate <= 0
    ) {
      const error = new Error('Recorder returned invalid startup metadata.');
      win.ready.reject(error);
      if (active) failCapture(active, error);
      else destroyWindow();
      return;
    }
    win.opened = true;
    win.marks.opened = wall();
    win.info = Object.freeze({
      contextSampleRate: metadata.contextSampleRate,
      deviceId: typeof metadata.deviceId === 'string' ? metadata.deviceId : null,
      deviceLabel: typeof metadata.deviceLabel === 'string' ? metadata.deviceLabel : null,
    });
    win.ready.resolve();
  });

  addListener('recorder:started', (event) => {
    if (!senderIsActive(event) || active.settled || active.startedResolved) return;
    active.startedResolved = true;
    active.marks.started = wall();
    active.started.resolve(win.info);
    onMarks(Object.freeze({
      ...win.marks,
      ...active.marks,
      warm: active.warm,
    }));
  });

  addListener('recorder:marks', (event, marks) => {
    if (!senderIsWindow(event) || !marks || typeof marks !== 'object') return;
    win.marks = { ...win.marks, ...marks };
  });

  addListener('recorder:amplitude', (event, value) => {
    if (!senderIsActive(event) || active.settled || !active.startedResolved) return;
    const amplitude = Number(value);
    if (!Number.isFinite(amplitude)) return;
    const timestamp = now();
    if (
      active.lastAmplitudeAt !== null
      && timestamp - active.lastAmplitudeAt < AMPLITUDE_INTERVAL_MS
    ) {
      return;
    }
    active.lastAmplitudeAt = timestamp;
    onAmplitude(Math.min(1, Math.max(0, amplitude)));
  });

  addListener('recorder:complete', (event, payload) => {
    if (!senderIsActive(event) || active.settled || !active.startedResolved) return;
    const pcm = payload?.pcm;
    const metadata = payload?.metadata;
    if (
      !(pcm instanceof Int16Array)
      || pcm.length === 0
      || pcm.length > MAX_CAPTURE_SECONDS * OUTPUT_SAMPLE_RATE
      || !metadata
      || metadata.outputSampleRate !== OUTPUT_SAMPLE_RATE
    ) {
      failCapture(active, new Error('Recorder returned invalid PCM.'));
      return;
    }

    const capture = active;
    capture.settled = true;
    active = undefined;
    capture.completed.resolve(Object.freeze({
      pcm,
      metadata: Object.freeze({
        capturedSeconds: Number(metadata.capturedSeconds),
        outputSampleRate: OUTPUT_SAMPLE_RATE,
      }),
    }));
    holdThenClose(getWarmHoldMs());
  });

  addListener('recorder:error', (event, message) => {
    if (!senderIsWindow(event)) return;
    const reason =
      typeof message === 'string' && message.trim()
        ? message.trim().slice(0, 500)
        : 'Microphone capture failed.';
    if (active) {
      failCapture(active, new Error(reason));
      return;
    }
    // A warm, idle microphone that goes away (unplugged, sleep) is not a
    // dictation failure: drop it silently and open a fresh one next time.
    win.ready.reject(new Error(reason));
    destroyWindow();
  });

  function lose(lost, error) {
    if (win !== lost) return;
    lost.ready.reject(error);
    if (active) failCapture(active, error);
    else destroyWindow();
  }

  function createWindow(deviceId) {
    const callAt = wall();
    const window = new BrowserWindow({
      title: 'Flowstate Recorder',
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
      },
    });
    const created = {
      window,
      deviceId,
      opened: false,
      info: null,
      speculative: false,
      ready: deferred(),
      marks: { call: callAt, created: wall() },
    };
    // Rejected when the window dies before the microphone opens; whoever is
    // waiting handles it, nobody else should see an unhandled rejection.
    created.ready.promise.catch(() => {});
    win = created;

    window.webContents.once('did-finish-load', () => {
      created.marks.loaded = wall();
      if (win === created && !window.isDestroyed()) {
        created.marks.cmdSent = wall();
        window.webContents.send('recorder:command', { type: 'open', deviceId });
      }
    });
    window.webContents.once('did-fail-load', (_event, code, description) => {
      lose(created, new Error(`Recorder renderer failed to load (${code}: ${description}).`));
    });
    window.webContents.once('render-process-gone', (_event, details) => {
      lose(created, new Error(`Recorder renderer stopped unexpectedly (${details.reason}).`));
    });
    window.once('closed', () => {
      if (win === created) {
        lose(created, new Error('Recorder window closed unexpectedly.'));
      }
    });

    void window.loadFile(rendererPath).catch((error) => {
      lose(created, new Error(`Recorder renderer failed to load: ${errorMessage(error)}`));
    });
    return created;
  }

  function ensureWindow(deviceId) {
    if (win && win.deviceId !== deviceId) destroyWindow();
    return win ?? createWindow(deviceId);
  }

  function start({ deviceId = null } = {}) {
    if (disposed) {
      return Promise.reject(new Error('Recorder manager has been disposed.'));
    }
    if (active) {
      return Promise.reject(new Error('A recorder capture is already active.'));
    }
    if (deviceId !== null && typeof deviceId !== 'string') {
      return Promise.reject(new TypeError('deviceId must be a string or null.'));
    }

    const target = ensureWindow(deviceId);
    clearHold();
    target.speculative = false;
    const capture = {
      started: deferred(),
      completed: deferred(),
      startedResolved: false,
      settled: false,
      lastAmplitudeAt: null,
      warm: target.opened,
      marks: { startCall: wall() },
    };
    // A cancelled start is commonly ignored by the debounce path. Attaching a
    // handler here prevents that intentional rejection becoming process noise.
    capture.completed.promise.catch(() => {});
    active = capture;

    target.ready.promise.then(
      () => {
        if (
          active === capture
          && !capture.settled
          && win === target
          && !target.window.isDestroyed()
        ) {
          target.window.webContents.send('recorder:command', { type: 'begin' });
        }
      },
      () => {}
    );
    return capture.started.promise;
  }

  // Open the microphone ahead of the real press (first chord key down).
  // Idempotent; does nothing while a dictation owns the recorder.
  function prewarm({ deviceId = null } = {}) {
    if (disposed || active) return;
    if (deviceId !== null && typeof deviceId !== 'string') return;
    if (win && win.deviceId === deviceId) return;
    ensureWindow(deviceId).speculative = true;
    holdThenClose(speculativeHoldMs);
  }

  // The speculative open was a false alarm (an ordinary Ctrl shortcut).
  function cancelPrewarm() {
    if (win?.speculative && !active) destroyWindow();
  }

  function stop() {
    if (!active || active.settled || !active.startedResolved) {
      return Promise.reject(new Error('No started recorder capture is active.'));
    }
    win.window.webContents.send('recorder:command', { type: 'stop' });
    return active.completed.promise;
  }

  function cancel() {
    if (!active) return;
    const capture = active;
    active = undefined;
    settleFailure(capture, new RecorderCancelledError());
    if (win && !win.window.isDestroyed()) {
      if (win.opened) win.window.webContents.send('recorder:command', { type: 'abort' });
      holdThenClose(getWarmHoldMs());
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    const capture = active;
    active = undefined;
    settleFailure(capture, new RecorderCancelledError());
    destroyWindow();
    for (const [channel, listener] of listeners) {
      ipcMain.removeListener(channel, listener);
    }
    listeners.clear();
    session.setPermissionCheckHandler(null);
    session.setPermissionRequestHandler(null);
  }

  return {
    cancel,
    cancelPrewarm,
    dispose,
    isCapturing: () => Boolean(active),
    isWarm: () => Boolean(win?.opened),
    prewarm,
    start,
    stop,
  };
}

module.exports = {
  AMPLITUDE_INTERVAL_MS,
  DEFAULT_SPECULATIVE_HOLD_MS,
  DEFAULT_WARM_HOLD_MS,
  MAX_CAPTURE_SECONDS,
  OUTPUT_SAMPLE_RATE,
  RecorderCancelledError,
  createRecorderManager,
};
