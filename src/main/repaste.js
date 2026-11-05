'use strict';

/* Re-paste a past dictation into whatever app was in front before you came to
   Flowstate. Pasting needs another window to hold focus, so the focused
   Flowstate window is minimised, which hands focus back to the previous app,
   given a moment to land, pasted into, then restored.

   The text is left on the clipboard afterwards. Unlike the live path in
   inject.js there is no snapshot to restore, because the user pressed "paste"
   on text they chose; and if the paste chord is blocked the text is already
   there for a manual Ctrl+V. */

const { getAppQuirk } = require('../shared/app-quirks');

const FOCUS_HANDOFF_MS = 350;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createRePaster({
  clipboard,
  user32,
  getWindows = () => [],
  wait = sleep,
  handoffMs = FOCUS_HANDOFF_MS,
  logger = console,
} = {}) {
  if (!clipboard || typeof clipboard.writeText !== 'function') {
    throw new TypeError('createRePaster requires the clipboard.');
  }
  if (!user32 || typeof user32.sendPasteChord !== 'function') {
    throw new TypeError('createRePaster requires the paste input.');
  }

  let busy = false;

  return async function rePaste(text) {
    if (typeof text !== 'string' || text.length === 0) {
      return { ok: false, code: 'empty' };
    }
    if (busy) return { ok: false, code: 'busy' };
    busy = true;

    const minimised = [];
    try {
      clipboard.writeText(text);
      if (clipboard.readText() !== text) {
        return { ok: false, code: 'clipboard-busy' };
      }
      if (user32.getPressedModifiers?.().length > 0) {
        return { ok: false, code: 'modifier-held', onClipboard: true };
      }
      for (const window of getWindows()) {
        if (window.isDestroyed() || !window.isFocused()) continue;
        window.minimize();
        minimised.push(window);
      }
      await wait(handoffMs);
      const input = user32.sendPasteChord(getAppQuirk('').pasteChord);
      if (!input?.accepted) return { ok: false, code: 'paste-rejected', onClipboard: true };
      await wait(getAppQuirk('').restoreDelayMs);
      return { ok: true, code: 'pasted' };
    } catch (error) {
      logger.error(`Flowstate re-paste failed: ${error.message}`);
      return { ok: false, code: 'paste-input-failed', onClipboard: true };
    } finally {
      for (const window of minimised) {
        if (!window.isDestroyed()) window.restore();
      }
      busy = false;
    }
  };
}

module.exports = { FOCUS_HANDOFF_MS, createRePaster };
