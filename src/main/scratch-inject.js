'use strict';

/* Dictating while the Scratchpad is the foreground window inserts at the
   caret directly. The clipboard is machine-wide shared state; text that is
   going into our own editor has no reason to touch it. Every other target
   goes through the normal paste service untouched.

   History is still written first, same promise as the paste path: the row
   exists even if delivery fails. */

function createScratchRouter({
  injector,
  history,
  isActive,
  deliver,
  ownProcessId = process.pid,
  logger = console,
}) {
  if (!injector || typeof injector.pasteText !== 'function') {
    throw new TypeError('A paste service is required.');
  }

  async function pasteText(options = {}) {
    const { text, target, historyEntry = {} } = options;
    const ownWindow = target && target.processId === ownProcessId;
    if (!ownWindow || typeof text !== 'string' || text.length === 0 || !isActive()) {
      return injector.pasteText(options);
    }

    try {
      await history.append({ ...historyEntry, text, target });
    } catch (error) {
      logger.error?.(
        'Flowstate history write failed; scratchpad insert was skipped: '
          + `${error instanceof Error ? error.message : String(error)}`
      );
      return {
        ok: false,
        state: 'error',
        code: 'history-write-failed',
        message: 'The transcript could not be saved, so it was not inserted.',
        target,
        historySaved: false,
      };
    }

    if (!deliver(text)) {
      return {
        ok: false,
        state: 'error',
        code: 'scratchpad-unavailable',
        message: 'The Scratchpad could not take the text. It is saved in History.',
        target,
        historySaved: true,
      };
    }

    return {
      ok: true,
      state: 'pasted',
      code: 'scratchpad',
      target,
      historySaved: true,
      input: 'scratchpad',
      clipboardLeftForManualPaste: false,
    };
  }

  return { pasteText };
}

module.exports = { createScratchRouter };
