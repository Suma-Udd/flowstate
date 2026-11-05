'use strict';

const {
  getAppQuirk,
} = require('../shared/app-quirks');
const { createFocusTracker } = require('./focus');

const DEFAULT_CLIPBOARD_BACKOFF_MS = Object.freeze([10, 25, 50, 100, 200]);
const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x2;
const VK = Object.freeze({
  control: 0x11,
  shift: 0x10,
  alt: 0x12,
  leftWin: 0x5b,
  rightWin: 0x5c,
  v: 0x56,
  insert: 0x2d,
});
const PASTE_CHORDS = Object.freeze({
  'ctrl+v': Object.freeze([VK.control, VK.v]),
  'shift+insert': Object.freeze([VK.shift, VK.insert]),
});
const MODIFIER_KEYS = Object.freeze({
  Control: VK.control,
  Shift: VK.shift,
  Alt: VK.alt,
  MetaLeft: VK.leftWin,
  MetaRight: VK.rightWin,
});

class ClipboardOperationError extends Error {
  constructor(label, attempts, cause) {
    super(
      `${label} failed after ${attempts} attempts: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
    this.name = 'ClipboardOperationError';
    this.code = 'clipboard-unavailable';
    this.attempts = attempts;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createNativeUser32({ koffi = require('koffi') } = {}) {
  if (process.platform !== 'win32') {
    throw new Error('Text injection is only supported on Windows.');
  }

  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const MOUSEINPUT = koffi.struct({
    dx: 'long',
    dy: 'long',
    mouseData: 'uint32_t',
    dwFlags: 'uint32_t',
    time: 'uint32_t',
    dwExtraInfo: 'uintptr_t',
  });
  const KEYBDINPUT = koffi.struct({
    wVk: 'uint16_t',
    wScan: 'uint16_t',
    dwFlags: 'uint32_t',
    time: 'uint32_t',
    dwExtraInfo: 'uintptr_t',
  });
  const HARDWAREINPUT = koffi.struct({
    uMsg: 'uint32_t',
    wParamL: 'uint16_t',
    wParamH: 'uint16_t',
  });
  const INPUT = koffi.struct({
    type: 'uint32_t',
    u: koffi.union({
      mi: MOUSEINPUT,
      ki: KEYBDINPUT,
      hi: HARDWAREINPUT,
    }),
  });
  const SendInput = user32.func(
    '__stdcall',
    'SendInput',
    'unsigned int',
    ['unsigned int', koffi.pointer(INPUT), 'int']
  );
  const GetAsyncKeyState = user32.func(
    'short __stdcall GetAsyncKeyState(int virtualKey)'
  );
  const GetLastError = kernel32.func(
    'uint32_t __stdcall GetLastError(void)'
  );

  return {
    getPressedModifiers() {
      return Object.entries(MODIFIER_KEYS)
        .filter(([, virtualKey]) => (GetAsyncKeyState(virtualKey) & 0x8000) !== 0)
        .map(([name]) => name);
    },
    sendPasteChord(chord) {
      const keys = PASTE_CHORDS[chord];
      if (!keys) {
        throw new Error(`Unsupported paste chord: ${String(chord)}.`);
      }
      const events = [
        makeKeyboardEvent(keys[0], true),
        makeKeyboardEvent(keys[1], true),
        makeKeyboardEvent(keys[1], false),
        makeKeyboardEvent(keys[0], false),
      ];
      const sentEvents = SendInput(
        events.length,
        events,
        koffi.sizeof(INPUT)
      );
      return {
        requestedEvents: events.length,
        sentEvents,
        accepted: sentEvents === events.length,
        win32Error: sentEvents === events.length ? 0 : GetLastError(),
      };
    },
  };
}

function makeKeyboardEvent(virtualKey, down) {
  return {
    type: INPUT_KEYBOARD,
    u: {
      ki: {
        wVk: virtualKey,
        wScan: 0,
        dwFlags: down ? 0 : KEYEVENTF_KEYUP,
        time: 0,
        dwExtraInfo: 0,
      },
    },
  };
}

async function withClipboardRetry(
  label,
  operation,
  {
    backoffMs = DEFAULT_CLIPBOARD_BACKOFF_MS,
    wait = sleep,
  } = {}
) {
  let lastError;
  const attempts = backoffMs.length + 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return {
        attempts: attempt,
        value: await operation(),
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await wait(backoffMs[attempt - 1]);
      }
    }
  }

  throw new ClipboardOperationError(label, attempts, lastError);
}

function hasFormat(formats, expression) {
  return formats.some((format) => expression.test(format));
}

function recognisedFormat(format) {
  return (
    /(^|\/)text($|\/|-|_)/i.test(format) ||
    /unicode.*text|text.*unicode/i.test(format) ||
    /html/i.test(format) ||
    /rtf|rich text/i.test(format) ||
    /image|bitmap|dib/i.test(format) ||
    /bookmark|url/i.test(format)
  );
}

const CLIPBOARD_KINDS = Object.freeze(['text', 'html', 'rtf', 'image', 'bookmark']);

// Windows reports a format as present while handing back nothing for it
// (empty HTML after the fragment markers are stripped, a text slot with ""),
// and a write of "" leaves no format at all. Treating "" as absent keeps a
// snapshot comparable with what was read back.
function emptyAsNull(value) {
  return typeof value === 'string' && value.length === 0 ? null : value ?? null;
}

function normaliseNewlines(value) {
  return value == null ? null : value.replace(/\r\n/g, '\n');
}

// One unreadable format must not lose the others: each read is isolated and
// a failure is recorded by name, never with the clipboard contents.
function snapshotClipboard(clipboard) {
  const formats = clipboard.availableFormats();
  const readFailures = [];
  const attempt = (kind, read) => {
    try {
      return read();
    } catch (error) {
      readFailures.push({
        format: kind,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const hasText =
    hasFormat(formats, /(^|\/)text($|\/|-|_)/i) ||
    hasFormat(formats, /unicode.*text|text.*unicode/i);
  const hasHtml = hasFormat(formats, /html/i);
  const hasRtf = hasFormat(formats, /rtf|rich text/i);
  const hasImage = hasFormat(formats, /image|bitmap|dib/i);

  const bookmark = attempt('bookmark', () => clipboard.readBookmark());
  const image = hasImage ? attempt('image', () => clipboard.readImage()) : null;
  const imagePng = attempt('image', () =>
    image != null && !image.isEmpty() ? Buffer.from(image.toPNG()) : null
  );

  return {
    formats,
    unsupportedFormats: formats.filter((format) => !recognisedFormat(format)),
    text: hasText ? emptyAsNull(attempt('text', () => clipboard.readText())) : null,
    html: hasHtml ? emptyAsNull(attempt('html', () => clipboard.readHTML())) : null,
    rtf: hasRtf ? emptyAsNull(attempt('rtf', () => clipboard.readRTF())) : null,
    imagePng,
    bookmark:
      bookmark != null && (bookmark.url || bookmark.title)
        ? { title: bookmark.title, url: bookmark.url }
        : null,
    readFailures,
  };
}

function clipboardKinds(snapshot) {
  return CLIPBOARD_KINDS.filter((kind) => {
    if (kind === 'image') return snapshot.imagePng != null;
    return snapshot[kind] != null;
  });
}

/**
 * Writes the snapshot back. `skip` names formats to leave out (ones already
 * known not to survive a round trip), so a single bad format costs only
 * itself. Returns the kinds actually written.
 */
function restoreClipboard(clipboard, nativeImage, snapshot, { skip } = {}) {
  const skipped = skip ?? new Set();
  const data = {};
  const written = [];

  if (snapshot.text != null && !skipped.has('text')) {
    data.text = snapshot.text;
    written.push('text');
  }
  if (snapshot.html != null && !skipped.has('html')) {
    data.html = snapshot.html;
    written.push('html');
  }
  if (snapshot.rtf != null && !skipped.has('rtf')) {
    data.rtf = snapshot.rtf;
    written.push('rtf');
  }
  if (snapshot.imagePng != null && !skipped.has('image')) {
    data.image = nativeImage.createFromBuffer(snapshot.imagePng);
    written.push('image');
  }
  if (snapshot.bookmark != null && !skipped.has('bookmark')) {
    data.text ??= snapshot.bookmark.url;
    data.bookmark = snapshot.bookmark.title;
    written.push('bookmark');
  }

  if (Object.keys(data).length === 0) {
    clipboard.clear();
  } else {
    clipboard.write(data);
  }
  return written;
}

function sameImage(expected, actual, nativeImage) {
  if (expected == null || actual == null) return expected == null && actual == null;
  if (expected.equals(actual)) return true;
  // The PNG encoder is allowed to differ byte for byte; the picture is not.
  if (!nativeImage) return false;
  try {
    const left = nativeImage.createFromBuffer(expected);
    const right = nativeImage.createFromBuffer(actual);
    const leftSize = left.getSize();
    const rightSize = right.getSize();
    return (
      leftSize.width === rightSize.width &&
      leftSize.height === rightSize.height &&
      Buffer.from(left.toBitmap()).equals(Buffer.from(right.toBitmap()))
    );
  } catch {
    return false;
  }
}

function equivalentClipboard(expected, actual, nativeImage) {
  const comparisons = {
    text: normaliseNewlines(expected.text) === normaliseNewlines(actual.text),
    html: normaliseNewlines(expected.html) === normaliseNewlines(actual.html),
    rtf: expected.rtf === actual.rtf,
    image: sameImage(expected.imagePng, actual.imagePng, nativeImage),
    bookmark:
      expected.bookmark == null
        ? actual.bookmark == null
        : expected.bookmark.title === actual.bookmark?.title &&
          expected.bookmark.url === actual.bookmark?.url,
  };
  return {
    comparisons,
    equivalent: Object.values(comparisons).every(Boolean),
  };
}

class ClipboardFormatMismatch extends Error {
  constructor(formats) {
    super(`restored clipboard did not match the saved clipboard (${formats.join(', ')})`);
    this.name = 'ClipboardFormatMismatch';
    this.formats = formats;
  }
}

function createPasteService(options = {}) {
  let { clipboard, nativeImage } = options;
  if (!clipboard || !nativeImage) {
    const electron = require('electron');
    clipboard ??= electron.clipboard;
    nativeImage ??= electron.nativeImage;
  }

  const user32 = options.user32 ?? createNativeUser32();
  const focus = options.focus ?? createFocusTracker();
  const history = options.history;
  const logger = options.logger ?? console;
  const wait = options.wait ?? sleep;
  const backoffMs =
    options.backoffMs ?? DEFAULT_CLIPBOARD_BACKOFF_MS;

  if (!history || typeof history.append !== 'function') {
    throw new TypeError(
      'history.append must be provided so text is retained before injection.'
    );
  }
  if (typeof focus.isTargetForeground !== 'function') {
    throw new TypeError('focus.isTargetForeground must be a function.');
  }

  async function retry(label, operation) {
    return withClipboardRetry(label, operation, { backoffMs, wait });
  }

  async function writeText(text) {
    return retry('clipboard write', () => {
      clipboard.writeText(text);
      if (clipboard.readText() !== text) {
        throw new Error(
          'clipboard verification did not return the text just written'
        );
      }
    });
  }

  function describe(error) {
    return error instanceof Error ? error.message : String(error);
  }

  // Which formats cannot be written on their own? Probed one at a time so a
  // throwing format is named instead of taking the whole clipboard with it.
  function probeWritableFormats(snapshot, skip) {
    const failed = new Map();
    for (const kind of clipboardKinds(snapshot)) {
      if (skip.has(kind)) continue;
      try {
        restoreClipboard(clipboard, nativeImage, snapshot, {
          skip: new Set(CLIPBOARD_KINDS.filter((other) => other !== kind)),
        });
      } catch (error) {
        failed.set(kind, describe(error));
      }
    }
    return failed;
  }

  /**
   * Restores as much of the saved clipboard as possible. Resolves with the
   * formats that could not be restored (empty when everything came back);
   * rejects only when not a single format could be put back.
   */
  async function restore(snapshot) {
    const failedFormats = new Map(
      snapshot.readFailures.map(({ format, message }) => [format, message])
    );
    const present = clipboardKinds(snapshot);
    let attempts = 0;

    for (let round = 0; round <= present.length; round += 1) {
      let outcome;
      try {
        outcome = await retry('clipboard restore', () => {
          restoreClipboard(clipboard, nativeImage, snapshot, {
            skip: new Set(failedFormats.keys()),
          });
          const observed = snapshotClipboard(clipboard);
          const comparison = equivalentClipboard(snapshot, observed, nativeImage);
          const mismatched = CLIPBOARD_KINDS.filter(
            (kind) => !comparison.comparisons[kind] && !failedFormats.has(kind)
          );
          if (mismatched.length > 0) {
            throw new ClipboardFormatMismatch(mismatched);
          }
          return comparison;
        });
      } catch (error) {
        const cause = error.cause;
        attempts += error.attempts ?? 0;
        if (cause instanceof ClipboardFormatMismatch) {
          for (const kind of cause.formats) {
            failedFormats.set(kind, 'did not read back the same after writing');
          }
        } else {
          // The write itself threw: find which format is responsible.
          const probed = probeWritableFormats(snapshot, new Set(failedFormats.keys()));
          if (probed.size === 0) {
            logger.error(`Flowstate clipboard restore failed: ${describe(cause ?? error)}`);
            throw error;
          }
          for (const [kind, message] of probed) failedFormats.set(kind, message);
        }
        for (const [kind, message] of failedFormats) {
          logger.error(
            `Flowstate clipboard format ${kind} could not be restored: ${message}`
          );
        }
        if (failedFormats.size >= present.length && present.length > 0) {
          // Nothing left to write: leave the clipboard empty rather than
          // holding the dictated text the user did not copy.
          try { clipboard.clear(); } catch { /* best effort */ }
          throw error;
        }
        continue;
      }
      return {
        attempts: attempts + outcome.attempts,
        comparison: outcome.value,
        failedFormats: [...failedFormats.keys()],
      };
    }
    throw new ClipboardOperationError('clipboard restore', attempts, 'no format restorable');
  }

  async function safeRestore(snapshot) {
    try {
      return await restore(snapshot);
    } catch (error) {
      return null;
    }
  }

  function failure(code, message, target, details = {}) {
    return {
      ok: false,
      state: 'error',
      code,
      message,
      target,
      historySaved: true,
      ...details,
    };
  }

  async function pasteText({
    text,
    target,
    historyEntry = {},
  } = {}) {
    if (typeof text !== 'string' || text.length === 0) {
      throw new TypeError('text must be a non-empty string.');
    }
    if (
      !target ||
      typeof target.windowId !== 'string' ||
      typeof target.capturedAt !== 'number'
    ) {
      throw new TypeError(
        'target must be the foreground window captured at hotkey key-down.'
      );
    }

    try {
      await history.append({
        ...historyEntry,
        text,
        target,
      });
    } catch (error) {
      logger.error(
        `Flowstate history write failed; injection was skipped: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
      return {
        ok: false,
        state: 'error',
        code: 'history-write-failed',
        message: 'The transcript could not be saved, so it was not pasted.',
        target,
        historySaved: false,
      };
    }

    const heldModifiers = user32.getPressedModifiers();
    if (heldModifiers.length > 0) {
      return failure(
        'modifier-held',
        'Release the dictation shortcut before pasting.',
        target,
        { heldModifiers }
      );
    }
    if (!focus.isTargetForeground(target)) {
      return failure(
        'target-not-foreground',
        'The window where dictation started is no longer in the foreground.',
        target
      );
    }

    let saved;
    try {
      saved = await retry(
        'clipboard snapshot',
        () => snapshotClipboard(clipboard)
      );
    } catch (error) {
      return failure(
        error.code,
        'The clipboard is busy. The transcript remains in history.',
        target,
        { clipboardSnapshotAttempts: error.attempts }
      );
    }

    if (saved.value.unsupportedFormats.length > 0) {
      logger.warn(
        'Flowstate cannot restore these clipboard formats after paste: ' +
          JSON.stringify(saved.value.unsupportedFormats)
      );
    }

    let written;
    try {
      written = await writeText(text);
    } catch (error) {
      const restored = await safeRestore(saved.value);
      return failure(
        error.code,
        'The clipboard is busy. The transcript remains in history.',
        target,
        {
          clipboardSnapshotAttempts: saved.attempts,
          clipboardWriteAttempts: error.attempts,
          clipboardCommonFormatsRestored: restored != null,
        }
      );
    }

    const modifiersBeforeInput = user32.getPressedModifiers();
    const targetStillForeground = focus.isTargetForeground(target);
    if (modifiersBeforeInput.length > 0 || !targetStillForeground) {
      const restored = await safeRestore(saved.value);
      return failure(
        modifiersBeforeInput.length > 0
          ? 'modifier-held'
          : 'target-not-foreground',
        modifiersBeforeInput.length > 0
          ? 'Release the dictation shortcut before pasting.'
          : 'The window where dictation started is no longer in the foreground.',
        target,
        {
          heldModifiers: modifiersBeforeInput,
          clipboardSnapshotAttempts: saved.attempts,
          clipboardWriteAttempts: written.attempts,
          clipboardCommonFormatsRestored: restored != null,
        }
      );
    }

    const quirk = getAppQuirk(target.exe);
    let input;
    try {
      input = user32.sendPasteChord(quirk.pasteChord);
    } catch (error) {
      logger.error(
        `Flowstate paste input failed: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
      return failure(
        'paste-input-failed',
        'Paste was blocked. The transcript is on the clipboard for manual paste.',
        target,
        {
          clipboardLeftForManualPaste: true,
          clipboardSnapshotAttempts: saved.attempts,
          clipboardWriteAttempts: written.attempts,
        }
      );
    }

    if (!input.accepted) {
      return failure(
        'paste-rejected',
        'Paste was blocked. The transcript is on the clipboard for manual paste.',
        target,
        {
          input,
          clipboardLeftForManualPaste: true,
          clipboardSnapshotAttempts: saved.attempts,
          clipboardWriteAttempts: written.attempts,
        }
      );
    }

    await wait(quirk.restoreDelayMs);
    let restored;
    try {
      restored = await restore(saved.value);
    } catch (error) {
      logger.error(`Flowstate ${error.message}`);
      return failure(
        'clipboard-restore-failed',
        'Text was pasted, but the previous clipboard could not be restored.',
        target,
        {
          input,
          clipboardLeftForManualPaste: false,
          clipboardSnapshotAttempts: saved.attempts,
          clipboardWriteAttempts: written.attempts,
          clipboardRestoreAttempts: error.attempts,
          clipboardCommonFormatsRestored: false,
        }
      );
    }

    return {
      ok: true,
      state: 'pasted',
      code: 'pasted',
      target,
      historySaved: true,
      input,
      pasteChord: quirk.pasteChord,
      restoreDelayMs: quirk.restoreDelayMs,
      clipboardLeftForManualPaste: false,
      clipboardSnapshotAttempts: saved.attempts,
      clipboardWriteAttempts: written.attempts,
      clipboardRestoreAttempts: restored.attempts,
      clipboardCommonFormatsRestored: true,
      clipboardFullyRestored:
        saved.value.unsupportedFormats.length === 0 &&
        restored.failedFormats.length === 0,
      droppedClipboardFormats: [...saved.value.unsupportedFormats],
      clipboardFailedFormats: restored.failedFormats,
    };
  }

  return {
    pasteText,
  };
}

module.exports = {
  ClipboardOperationError,
  DEFAULT_CLIPBOARD_BACKOFF_MS,
  createNativeUser32,
  createPasteService,
  equivalentClipboard,
  restoreClipboard,
  snapshotClipboard,
  withClipboardRetry,
};
