'use strict';

const { randomUUID } = require('node:crypto');

const DEFAULT_DURATION_MS = 5_000;

function messageFrom(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * "Test your setup" (issue #18) — one dictation into the app itself, so a new
 * install can be verified without alt-tabbing. It reuses the same recorder and
 * ASR worker the real hotkey-driven loop uses, but it is triggered by a click
 * rather than a hold, records for a fixed window rather than until keyup, and
 * never touches focus.js or inject.js: the result goes back over IPC, never
 * onto the clipboard or into another window.
 */
function createTestRunner({
  recorder,
  worker,
  windows,
  getConfig,
  durationMs = DEFAULT_DURATION_MS,
  createId = randomUUID,
  timers = { setTimeout, clearTimeout },
} = {}) {
  if (!recorder || typeof recorder.start !== 'function' || typeof recorder.stop !== 'function') {
    throw new TypeError('A recorder manager is required.');
  }
  if (!worker || typeof worker.transcribe !== 'function') {
    throw new TypeError('An ASR worker manager is required.');
  }
  if (!windows || typeof windows.showPill !== 'function') {
    throw new TypeError('A window manager is required.');
  }
  if (typeof getConfig !== 'function') {
    throw new TypeError('getConfig must be a function.');
  }

  let running = false;

  async function run() {
    if (running) throw new Error('A test dictation is already running.');
    if (worker.getState?.().status === 'unloaded') worker.wake?.();
    const workerState = worker.getState?.();
    if (workerState && workerState.status !== 'ready' && !workerState.waking) {
      throw new Error('Speech recognition is still loading.');
    }

    running = true;
    let started = false;
    try {
      windows.showPill('listening');
      const config = getConfig();
      await recorder.start({ deviceId: config.audio?.deviceId ?? null });
      started = true;

      await new Promise((resolve) => timers.setTimeout(resolve, durationMs));

      windows.setPillState('thinking');
      const capture = await recorder.stop();
      started = false;
      const result = await worker.transcribe({ id: createId(), pcm: capture.pcm });

      if (!result.text) {
        throw new Error('No speech was detected. Try again a little closer to the microphone.');
      }
      windows.hidePill();
      return Object.freeze({ text: result.text, lang: result.lang });
    } catch (error) {
      if (started) recorder.cancel();
      windows.hidePill();
      throw new Error(messageFrom(error));
    } finally {
      running = false;
    }
  }

  return Object.freeze({
    run,
    isRunning: () => running,
  });
}

module.exports = { DEFAULT_DURATION_MS, createTestRunner };
