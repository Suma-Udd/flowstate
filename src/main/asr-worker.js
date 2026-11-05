'use strict';

function messageFrom(error) {
  return error instanceof Error ? error.message : String(error);
}

function createAsrWorkerManager({
  fork,
  workerPath,
  workerArgs = [],
  maxRespawns = 1,
  onResult = () => {},
  onStateChange = () => {},
  getUnloadAfterMs = () => 0,
  getHotwords = () => '',
  timers = { setTimeout, clearTimeout },
} = {}) {
  if (typeof fork !== 'function') {
    throw new TypeError('fork must be a function.');
  }
  if (typeof workerPath !== 'string' || workerPath.length === 0) {
    throw new TypeError('workerPath must be a non-empty string.');
  }
  if (!Array.isArray(workerArgs) || workerArgs.some((value) => typeof value !== 'string')) {
    throw new TypeError('workerArgs must be an array of strings.');
  }

  let child;
  let remainingRespawns = maxRespawns;
  let state = Object.freeze({ status: 'stopped', error: null });
  let stopping = false;
  let workerError;
  let idleTimer;
  let wakeWaiters = [];
  const pending = new Map();

  function setState(status, error = null, waking = false) {
    state = Object.freeze({ status, error, waking });
    onStateChange(state);
  }

  function clearIdleTimer() {
    if (idleTimer !== undefined) {
      timers.clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  }

  function settleWakeWaiters(error) {
    const waiters = wakeWaiters;
    wakeWaiters = [];
    for (const waiter of waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }

  /* One-shot timer, armed only while the model is resident and nothing is in
     flight. No polling: an idle app has no timer at all once it has unloaded
     (or when unload is set to Never). */
  function armIdleTimer() {
    clearIdleTimer();
    if (state.status !== 'ready' || pending.size > 0) return;
    const ms = Number(getUnloadAfterMs());
    if (!Number.isFinite(ms) || ms <= 0) return;
    idleTimer = timers.setTimeout(() => {
      idleTimer = undefined;
      unload();
    }, ms);
    idleTimer.unref?.();
  }

  function unload() {
    if (state.status !== 'ready' || !child || pending.size > 0) return;
    const activeChild = child;
    child = undefined;
    clearIdleTimer();
    setState('unloaded');
    activeChild.kill();
  }

  function rejectPending(error) {
    settleWakeWaiters(error);
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  }

  function terminalError(reason) {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    rejectPending(error);
    setState('error', error.message);
  }

  function handleFailure(failedChild, reason) {
    if (child !== failedChild) {
      return;
    }

    child = undefined;
    const error =
      workerError ??
      (reason instanceof Error ? reason : new Error(String(reason)));
    workerError = undefined;
    rejectPending(error);

    if (stopping) {
      setState('stopped');
      return;
    }
    if (remainingRespawns <= 0) {
      terminalError(error);
      return;
    }

    remainingRespawns -= 1;
    setState('restarting', error.message);
    spawnWorker(true);
  }

  function handleMessage(activeChild, message) {
    if (child !== activeChild || !message || typeof message !== 'object') {
      return;
    }

    if (message.type === 'ready') {
      workerError = undefined;
      setState('ready');
      settleWakeWaiters();
      armIdleTimer();
      return;
    }
    if (message.type === 'result' && typeof message.id === 'string') {
      const request = pending.get(message.id);
      if (!request) {
        return;
      }
      pending.delete(message.id);
      request.resolve(message);
      onResult(message);
      armIdleTimer();
      return;
    }
    if (message.type === 'error') {
      if (typeof message.id === 'string' && pending.has(message.id)) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        request.reject(new Error(message.message || 'ASR worker error.'));
        armIdleTimer();
      } else if (typeof message.message === 'string') {
        workerError = new Error(message.message);
      }
    }
  }

  function spawnWorker(isRespawn = false, waking = false) {
    if (stopping) {
      return;
    }

    setState(isRespawn ? 'restarting' : 'loading', null, waking);
    let spawned;
    try {
      spawned = fork(workerPath, workerArgs, {
        serviceName: 'Flowstate ASR worker',
      });
    } catch (error) {
      if (remainingRespawns > 0) {
        remainingRespawns -= 1;
        setState('restarting', messageFrom(error));
        spawnWorker(true);
      } else {
        terminalError(error);
      }
      return;
    }

    child = spawned;
    workerError = undefined;
    spawned.on('message', (message) => handleMessage(spawned, message));
    spawned.on('error', (error) => {
      handleFailure(spawned, new Error(`ASR worker error: ${messageFrom(error)}`));
      spawned.kill();
    });
    spawned.on('exit', (code) => {
      handleFailure(
        spawned,
        new Error(`ASR worker exited unexpectedly (code ${String(code)}).`)
      );
    });
  }

  /* Bring an unloaded model back. Returns true when a load is in progress or
     already done. Called on hotkey-down so the load overlaps the speaking. */
  function wake() {
    if (state.status === 'unloaded' && !stopping) {
      remainingRespawns = maxRespawns;
      spawnWorker(false, true);
    }
    return state.status === 'ready' || state.status === 'loading';
  }

  function start() {
    if (child || state.status === 'loading' || state.status === 'restarting') {
      return;
    }
    stopping = false;
    remainingRespawns = maxRespawns;
    spawnWorker();
  }

  function stop() {
    stopping = true;
    clearIdleTimer();
    const activeChild = child;
    child = undefined;
    rejectPending(new Error('ASR worker stopped.'));
    if (activeChild) {
      activeChild.kill();
    }
    setState('stopped');
  }

  function transcribe(request = {}) {
    if (state.status === 'unloaded') wake();
    if (state.status === 'loading' && state.waking) {
      return new Promise((resolve, reject) => {
        wakeWaiters.push({ resolve, reject });
      }).then(() => transcribeNow(request));
    }
    return transcribeNow(request);
  }

  // Read on every request, so a dictionary edit applies to the next dictation
  // with no rebuild and no worker restart. A failing source must never cost a
  // dictation: no hotwords is just the unboosted transcript.
  function currentHotwords() {
    try {
      const value = getHotwords();
      return typeof value === 'string' ? value : '';
    } catch {
      return '';
    }
  }

  function transcribeNow({ id, pcm, hintLang } = {}) {
    if (state.status !== 'ready' || !child) {
      return Promise.reject(new Error('ASR worker is not ready.'));
    }
    if (typeof id !== 'string' || id.length === 0) {
      return Promise.reject(new TypeError('id must be a non-empty string.'));
    }
    if (!(pcm instanceof Int16Array)) {
      return Promise.reject(new TypeError('pcm must be an Int16Array.'));
    }
    if (pending.has(id)) {
      return Promise.reject(new Error(`ASR request id is already pending: ${id}`));
    }

    clearIdleTimer();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        child.postMessage({ type: 'transcribe', id, pcm, hintLang, hotwords: currentHotwords() });
      } catch (error) {
        pending.delete(id);
        reject(error);
        armIdleTimer();
      }
    });
  }

  return {
    getState: () => state,
    start,
    stop,
    transcribe,
    wake,
    unload,
    refreshIdleTimer: armIdleTimer,
  };
}

module.exports = {
  createAsrWorkerManager,
};
