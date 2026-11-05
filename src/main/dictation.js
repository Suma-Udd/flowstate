'use strict';

const { randomUUID } = require('node:crypto');
const { DictationStateMachine } = require('./state');
const {
  buildSystemPrompt,
  shouldSkipLlm,
} = require('./prompt');
const { runPipeline } = require('./pipeline');
const { checkCleanup } = require('./cleanup-guard');

const MIN_HOLD_MS = 300;
const ERROR_DISPLAY_MS = 2_000;
const PASTING_DISPLAY_MS = 350;

function messageFrom(error) {
  return error instanceof Error ? error.message : String(error);
}

function createDictationController({
  recorder,
  worker,
  llm,
  injector,
  windows,
  focus,
  getConfig,
  getSnippets = () => [],
  getDictionaryTerms = () => [],
  recordSnippetUses = () => {},
  recordDictionaryCorrections = () => {},
  recordHistoryOutcome = () => {},
  isEnabled = () => true,
  onResult = () => {},
  logger = console,
  now = () => performance.now(),
  wallClock = Date.now,
  createId = randomUUID,
  timers = { setTimeout, clearTimeout },
  minHoldMs = MIN_HOLD_MS,
  errorDisplayMs = ERROR_DISPLAY_MS,
  pastingDisplayMs = PASTING_DISPLAY_MS,
} = {}) {
  if (!recorder || typeof recorder.start !== 'function') {
    throw new TypeError('A recorder manager is required.');
  }
  if (!worker || typeof worker.transcribe !== 'function') {
    throw new TypeError('An ASR worker manager is required.');
  }
  if (!injector || typeof injector.pasteText !== 'function') {
    throw new TypeError('A paste service is required.');
  }
  if (!windows || typeof windows.showPill !== 'function') {
    throw new TypeError('A window manager is required.');
  }
  if (!focus || typeof focus.captureAtKeyDown !== 'function') {
    throw new TypeError('A focus tracker is required.');
  }
  if (typeof getConfig !== 'function') {
    throw new TypeError('getConfig must be a function.');
  }

  let current;
  let errorTimer = null;
  let disposed = false;

  const machine = new DictationStateMachine({
    onTransition(transition) {
      const id = current?.id ?? 'none';
      logger.log(
        `Dictation state id=${id} ${transition.from} -> ${transition.to} ` +
          `event=${transition.event}`
      );
    },
  });

  function clearTimer(handle) {
    if (handle !== null) timers.clearTimeout(handle);
    return null;
  }

  function pillStateFor(state) {
    if (state === 'arming') return 'idle-armed';
    if (state === 'listening') return 'listening';
    if (state === 'thinking') return 'thinking';
    if (state === 'pasting') return 'pasting';
    return null;
  }

  function showSessionPill(session) {
    if (current !== session || session.cancelled || machine.state === 'idle') return;
    const state = pillStateFor(machine.state);
    if (!state) return;
    session.pillShown = true;
    windows.showPill(state);
  }

  function returnErrorToIdle() {
    errorTimer = null;
    if (machine.state !== 'error') return;
    machine.transition('RESET');
    windows.hidePill();
  }

  function surfaceError(reason, session = current) {
    const message = String(reason || 'Dictation failed.').slice(0, 120);
    if (session) {
      session.cancelled = true;
      session.pillTimer = clearTimer(session.pillTimer);
    }
    recorder.cancel();
    if (machine.state !== 'error') {
      machine.transition('FAIL', { reason: message });
    }
    windows.showPill('error', { reason: message });
    logger.error(`Dictation failed: ${message}`);
    if (current === session) current = undefined;
    errorTimer = clearTimer(errorTimer);
    errorTimer = timers.setTimeout(returnErrorToIdle, errorDisplayMs);
  }

  function roundedMilliseconds(value) {
    return Math.round(Math.max(0, value) * 10) / 10;
  }

  function fallbackCleanupResult(text, reason = 'unavailable', llmMs = 0) {
    return Object.freeze({
      text,
      cleanupApplied: false,
      provider: null,
      model: null,
      reason,
      llmMs: roundedMilliseconds(llmMs),
      usage: Object.freeze({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }),
    });
  }

  async function cleanupTranscript(text, {
    language,
    target,
    dictionaryTerms = [],
  }) {
    let config;
    try {
      config = getConfig();
    } catch {
      return fallbackCleanupResult(text, 'config-error');
    }

    if (shouldSkipLlm(text, config.llm?.skipUnderWords)) {
      return fallbackCleanupResult(text, 'short-utterance');
    }

    if (!llm || typeof llm.cleanup !== 'function') {
      return fallbackCleanupResult(text);
    }

    const startedAt = now();
    try {
      const instruction = buildSystemPrompt({
        detectedLanguage: language,
        executable: target?.exe ?? target?.imagePath,
        transcript: text,
        dictionaryTerms,
        removeFillers: config.llm?.removeFillers !== false,
      });
      const cleanup = await llm.cleanup({ text, instruction });
      if (
        !cleanup
        || typeof cleanup.text !== 'string'
        || cleanup.text.length === 0
        || !cleanup.usage
      ) {
        throw new TypeError('invalid cleanup result');
      }
      const verdict = checkCleanup(text, cleanup.text, { dictionaryTerms });
      if (!verdict.ok) {
        // The model answered, translated or rewrote instead of editing.
        // Never paste words the user did not say: the raw transcript wins.
        try {
          // Local app log only: the offending words and both texts are what
          // make a false positive diagnosable, and they never leave the machine.
          const clip = (value) => JSON.stringify(String(value).slice(0, 300));
          const offending = verdict.words?.length
            ? ` [${verdict.words.map((word) => JSON.stringify(word)).join(', ')}]`
            : '';
          (logger.note ?? logger.warn)?.call(
            logger,
            `Flowstate cleanup rejected the model output (${verdict.reason}${offending}); `
              + `pasting the raw transcript. raw=${clip(text)} model=${clip(cleanup.text)}`
          );
        } catch {
          // Diagnostics are optional; the raw transcript still has to paste.
        }
        return fallbackCleanupResult(
          text,
          `rejected-${verdict.reason}`,
          now() - startedAt
        );
      }
      return cleanup;
    } catch {
      try {
        logger.warn?.('Flowstate cleanup used the raw transcript (service-error).');
      } catch {
        // Diagnostics are optional; the raw transcript still has to paste.
      }
      return fallbackCleanupResult(text, 'service-error', now() - startedAt);
    }
  }

  function logTiming(session, result, cleanup, captureMs, injectMs) {
    const timing = Object.freeze({
      captureMs: roundedMilliseconds(captureMs),
      vadMs: roundedMilliseconds(Number(result.vadMs) || 0),
      asrMs: roundedMilliseconds(Number(result.inferMs) || 0),
      llmMs: roundedMilliseconds(Number(cleanup.llmMs) || 0),
      injectMs: roundedMilliseconds(injectMs),
      totalMs: roundedMilliseconds(now() - session.releaseAt),
    });
    logger.log(
      `Dictation timing id=${session.id} ` +
        `capture=${timing.captureMs}ms vad=${timing.vadMs}ms ` +
        `asr=${timing.asrMs}ms llm=${timing.llmMs}ms ` +
        `inject=${timing.injectMs}ms ` +
        `total=${timing.totalMs}ms`
    );
    return timing;
  }

  function recordPipelineActivity(pipeline) {
    const snippetIds = pipeline.snippetMatches
      .map((match) => match.id)
      .filter((id) => typeof id === 'string');
    const dictionaryIds = pipeline.dictionaryCorrections
      .map((correction) => correction.id)
      .filter((id) => typeof id === 'string');
    if (snippetIds.length === 0 && dictionaryIds.length === 0) return;

    const records = [];
    if (snippetIds.length > 0) {
      records.push(
        Promise.resolve().then(() => recordSnippetUses(snippetIds))
      );
    }
    if (dictionaryIds.length > 0) {
      records.push(
        Promise.resolve().then(
          () => recordDictionaryCorrections(dictionaryIds)
        )
      );
    }
    void Promise.all(records).catch(() => {
      try {
        logger.warn?.(
          'Flowstate could not update pipeline usage counters (counter-error).'
        );
      } catch {
        // Usage counters never block or invalidate a completed dictation.
      }
    });
  }

  // Spoken length from the samples actually captured, not the hotkey hold:
  // the hold includes the recorder's start-up, the samples do not.
  function captureDurationMs(capture) {
    const rate = Number(capture?.metadata?.outputSampleRate) || 16_000;
    const samples = capture?.pcm?.length;
    return Number.isFinite(samples) ? Math.round((samples * 1000) / rate) : null;
  }

  /* Tells history whether the text landed, so a failed paste is still a row
     with its transcript and the reason it did not paste. Queued by the
     history store, never awaited: the user's text is already at the caret
     or on the clipboard by now. */
  function recordOutcome(session, injection, injectMs) {
    try {
      void Promise.resolve(recordHistoryOutcome({
        id: session.id,
        ok: injection.ok === true,
        code: injection.code,
        injectMs: roundedMilliseconds(injectMs),
        totalMs: roundedMilliseconds(now() - session.releaseAt),
      })).catch(() => {
        logger.warn?.('Flowstate could not record the paste outcome (history-error).');
      });
    } catch {
      try {
        logger.warn?.('Flowstate could not record the paste outcome (history-error).');
      } catch {
        // History bookkeeping never blocks or invalidates a dictation.
      }
    }
  }

  async function finishSession(session) {
    if (
      current !== session
      || session.cancelled
      || session.finishing
      || !session.captureReady
    ) {
      return;
    }
    session.finishing = true;
    session.pillTimer = clearTimer(session.pillTimer);

    try {
      machine.transition('RELEASE', { reason: session.releaseReason });
      session.pillShown = true;
      windows.showPill('thinking');

      const captureStartedAt = now();
      const capture = await recorder.stop();
      const captureMs = now() - captureStartedAt;
      if (current !== session || session.cancelled) return;

      const result = await worker.transcribe({
        id: session.id,
        pcm: capture.pcm,
      });
      if (current !== session || session.cancelled) return;
      if (result.text.length === 0) {
        throw new Error('No speech was detected.');
      }
      const durationMs = captureDurationMs(capture);

      let snippets = [];
      try {
        const activeSnippets = getSnippets({
          language: result.lang,
          target: session.target,
          text: result.text,
        });
        if (Array.isArray(activeSnippets)) snippets = activeSnippets;
      } catch {
        try {
          logger.warn?.(
            'Flowstate pipeline continued without snippets (snippets-error).'
          );
        } catch {
          // Snippet expansion is optional; raw text can still continue.
        }
      }

      let dictionaryTerms = [];
      try {
        const activeTerms = getDictionaryTerms({
          language: result.lang,
          text: result.text,
        });
        if (Array.isArray(activeTerms)) dictionaryTerms = activeTerms;
      } catch {
        try {
          logger.warn?.(
            'Flowstate pipeline continued without dictionary terms (dictionary-error).'
          );
        } catch {
          // Dictionary enforcement is optional; cleanup can still continue.
        }
      }

      const pipeline = await runPipeline({
        rawText: result.text,
        snippets,
        dictionaryTerms,
        language: result.lang,
        target: session.target,
        cleanup: (text) => cleanupTranscript(text, {
          language: result.lang,
          target: session.target,
          dictionaryTerms,
        }),
      });
      if (current !== session || session.cancelled) return;
      const cleanup = pipeline.cleanup;

      machine.transition('TEXT_READY', { textLength: pipeline.text.length });
      windows.setPillState('pasting');
      const injectStartedAt = now();
      const injection = await injector.pasteText({
        text: pipeline.text,
        target: session.target,
        historyEntry: {
          id: session.id,
          createdAt: new Date(wallClock()).toISOString(),
          language: result.lang,
          rawText: pipeline.stages.raw,
          snippetText: pipeline.stages.snippets,
          llmText: pipeline.stages.llm,
          dictionaryText: pipeline.stages.dictionary,
          finalText: pipeline.stages.final,
          cleanedText: pipeline.stages.final,
          pipelineStages: pipeline.stages,
          cleanupApplied: cleanup.cleanupApplied,
          cleanupReason: cleanup.reason,
          llmProvider: cleanup.provider,
          llmModel: cleanup.model,
          llmMs: cleanup.llmMs,
          llmInputTokens: cleanup.usage.inputTokens,
          llmOutputTokens: cleanup.usage.outputTokens,
          llmTokens: cleanup.usage.totalTokens,
          vadMs: result.vadMs,
          asrMs: result.inferMs,
          durationMs,
        },
      });
      const injectMs = now() - injectStartedAt;
      if (injection.historySaved !== false) {
        recordPipelineActivity(pipeline);
        recordOutcome(session, injection, injectMs);
      }
      if (current !== session || session.cancelled) return;

      const timing = logTiming(session, result, cleanup, captureMs, injectMs);
      onResult(Object.freeze({
        ...result,
        rawText: pipeline.stages.raw,
        text: pipeline.text,
        pipeline: pipeline.stages,
        snippetMatches: pipeline.snippetMatches,
        dictionaryCorrections: pipeline.dictionaryCorrections,
        cleanup,
        target: session.target,
        injection: Object.freeze({ ...injection }),
        timing,
      }));
      if (!injection.ok) {
        surfaceError(injection.message, session);
        return;
      }

      await new Promise((resolve) => {
        session.pastingResolve = resolve;
        session.pastingTimer = timers.setTimeout(() => {
          session.pastingTimer = null;
          session.pastingResolve = null;
          resolve();
        }, pastingDisplayMs);
      });
      if (current !== session || session.cancelled) return;

      machine.transition('COMPLETE');
      current = undefined;
      windows.hidePill();
    } catch (error) {
      if (!session.cancelled && current === session) {
        surfaceError(messageFrom(error), session);
      }
    }
  }

  function captureStarted(session) {
    if (current !== session || session.cancelled) return;
    session.captureReady = true;
    if (machine.state === 'arming') machine.transition('CAPTURE_STARTED');

    if (session.committed) {
      if (!session.released) showSessionPill(session);
      else void finishSession(session);
    }
  }

  function captureFailed(session, error) {
    if (current !== session || session.cancelled) return;
    surfaceError(messageFrom(error), session);
  }

  // First chord key is down but the chord is not complete. Start opening the
  // microphone now; it is dropped again within ~1.5 s if this turns out to be
  // an ordinary shortcut. The ASR worker is deliberately NOT woken here: loading
  // the model on every Ctrl press would cost far more than it saves.
  function handleHotkeyArm() {
    if (disposed || current || machine.state !== 'idle' || !isEnabled()) return;
    try {
      recorder.prewarm?.({ deviceId: getConfig().audio?.deviceId ?? null });
    } catch {
      // Arming is an optimisation; the real press still opens the recorder.
    }
  }

  function handleHotkeyDisarm() {
    if (current) return;
    try {
      recorder.cancelPrewarm?.();
    } catch {
      // Nothing to undo.
    }
  }

  function handleHotkeyDown() {
    if (disposed || current || machine.state !== 'idle' || !isEnabled()) return;

    if (worker.getState?.().status === 'unloaded') worker.wake?.();
    const workerState = worker.getState?.();
    if (workerState && workerState.status !== 'ready' && !workerState.waking) {
      surfaceError('Speech recognition is still loading.', undefined);
      return;
    }

    let target;
    try {
      target = focus.captureAtKeyDown();
    } catch (error) {
      surfaceError(`Could not capture the active window: ${messageFrom(error)}`, undefined);
      return;
    }

    const session = {
      id: createId(),
      target,
      downAt: now(),
      captureReady: false,
      cancelled: false,
      committed: false,
      finishing: false,
      pillShown: false,
      pillTimer: null,
      pastingTimer: null,
      pastingResolve: null,
      released: false,
      releaseReason: null,
    };
    current = session;
    machine.transition('BEGIN');

    session.pillTimer = timers.setTimeout(() => {
      session.pillTimer = null;
      if (current !== session || session.released || session.cancelled) return;
      session.committed = true;
      showSessionPill(session);
    }, minHoldMs);

    let startPromise;
    try {
      const config = getConfig();
      startPromise = recorder.start({ deviceId: config.audio?.deviceId ?? null });
    } catch (error) {
      captureFailed(session, error);
      return;
    }
    Promise.resolve(startPromise).then(
      () => captureStarted(session),
      (error) => captureFailed(session, error)
    );
  }

  function cancelSession(session) {
    if (current !== session) return;
    session.cancelled = true;
    session.pillTimer = clearTimer(session.pillTimer);
    session.pastingTimer = clearTimer(session.pastingTimer);
    session.pastingResolve?.();
    session.pastingResolve = null;
    recorder.cancel();
    if (machine.can('CANCEL')) {
      machine.transition('CANCEL');
    }
    if (session.pillShown) windows.hidePill();
    current = undefined;
  }

  function handleHotkeyUp(reason = 'keyup') {
    const session = current;
    if (!session || session.released || session.finishing) return;
    session.released = true;
    session.releaseReason = reason;
    session.releaseAt = now();
    session.pillTimer = clearTimer(session.pillTimer);

    const heldMs = Math.max(0, now() - session.downAt);
    if (reason === 'shutdown' || (reason !== 'watchdog' && heldMs < minHoldMs)) {
      cancelSession(session);
      return;
    }

    session.committed = true;
    showSessionPill(session);
    if (session.captureReady) void finishSession(session);
  }

  function pushAmplitude(value) {
    if (
      current
      && current.pillShown
      && !current.released
      && machine.state === 'listening'
    ) {
      windows.pushPillAmplitude(value);
    }
  }

  function cancel() {
    if (current) cancelSession(current);
  }

  function dispose() {
    disposed = true;
    cancel();
    errorTimer = clearTimer(errorTimer);
    if (machine.state === 'error') {
      machine.transition('RESET');
      windows.hidePill();
    }
  }

  return {
    cancel,
    dispose,
    getState: () => machine.state,
    handleHotkeyArm,
    handleHotkeyDisarm,
    handleHotkeyDown,
    handleHotkeyUp,
    pushAmplitude,
  };
}

module.exports = {
  ERROR_DISPLAY_MS,
  MIN_HOLD_MS,
  PASTING_DISPLAY_MS,
  createDictationController,
};
