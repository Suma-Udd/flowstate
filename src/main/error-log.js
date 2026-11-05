'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * A small, real error record — issue #19's About screen needs something
 * honest to show under "Recent errors" and to fold into "Copy diagnostics".
 * Kept in memory (bounded) for instant reads, and appended to a plain-text
 * file so "Open logs" has real content to open. Never the API key: callers
 * pass already-redacted messages, the same discipline every existing
 * `logger.error` call in this codebase already follows.
 */
function createErrorLog({ limit = 20, directory, fileSystem = fs } = {}) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('createErrorLog requires a positive integer limit.');
  }
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new TypeError('createErrorLog requires a log directory.');
  }

  const filePath = path.join(directory, 'flowstate.log');
  const entries = [];

  function writeLine(entry) {
    try {
      fileSystem.mkdirSync(directory, { recursive: true });
      fileSystem.appendFileSync(
        filePath,
        `${entry.at} ${entry.message.replace(/[\r\n]+/g, ' ')}\n`,
        'utf8'
      );
    } catch {
      // Logging must never crash the thing it is trying to explain.
    }
  }

  function record(message) {
    const entry = Object.freeze({
      at: new Date().toISOString(),
      message: String(message).slice(0, 500),
    });
    entries.unshift(entry);
    if (entries.length > limit) entries.length = limit;

    // The in-memory entry above survives for this session even if the file
    // write fails.
    writeLine(entry);
    return entry;
  }

  /**
   * Diagnostics for the log file only: not an error, so it never shows in
   * the recent-errors list. Longer than record() because a rejected cleanup
   * has to carry both texts to be diagnosable.
   */
  function append(message) {
    writeLine({ at: new Date().toISOString(), message: String(message).slice(0, 1500) });
  }

  return {
    directory,
    filePath,
    record,
    append,
    recent: (count = limit) => entries.slice(0, count),
  };
}

/** Wraps a console-shaped logger so every `.error()` call is also recorded. */
function withErrorCapture(base, errorLog) {
  if (!base || typeof base.error !== 'function') {
    throw new TypeError('withErrorCapture requires a base logger with .error().');
  }
  if (!errorLog || typeof errorLog.record !== 'function') {
    throw new TypeError('withErrorCapture requires an error log with .record().');
  }

  function format(args) {
    return args
      .map((arg) => (arg instanceof Error ? arg.message : String(arg)))
      .join(' ');
  }

  return {
    log: (...args) => base.log(...args),
    warn: (...args) => base.warn(...args),
    // Console plus the log file, without becoming a recent "error".
    note: (...args) => {
      base.warn(...args);
      errorLog.append?.(format(args));
    },
    error: (...args) => {
      base.error(...args);
      errorLog.record(format(args));
    },
  };
}

module.exports = {
  createErrorLog,
  withErrorCapture,
};
