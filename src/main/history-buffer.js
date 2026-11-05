'use strict';

/* Session-only history. Since #28 flowstate.db (db.js) is the real store;
   main.js falls back to this buffer only when the database cannot open, so
   a locked or corrupt file degrades history instead of blocking the paste. */

function createHistoryBuffer({ limit = 100 } = {}) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('History buffer limit must be a positive integer.');
  }

  const entries = [];

  async function append(entry) {
    if (!entry || typeof entry.text !== 'string' || entry.text.length === 0) {
      throw new TypeError('History entries require non-empty text.');
    }
    entries.unshift(Object.freeze({ ...entry }));
    if (entries.length > limit) entries.length = limit;
  }

  return {
    append,
    recent: (count = limit) => entries.slice(0, count),
    count: () => entries.length,
    clear: () => { entries.length = 0; },
  };
}

module.exports = {
  createHistoryBuffer,
};
