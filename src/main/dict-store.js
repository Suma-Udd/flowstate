'use strict';

/* Dictionary — issue #24's durable store.
   %APPDATA%\flowstate\dictionary.json, atomic writes via config.js's own
   writer so a crash mid-save behaves exactly like a crash mid-config-save:
   the previous file, not a half-written one. There is no SQLite here —
   History's FTS5 database (#28) is for search over thousands of dictations;
   a dictionary lives in a few dozen terms and is read whole on every prompt
   build regardless, so a JSON file is the honest amount of infrastructure. */

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const { writeJsonAtomic } = require('./config');

const STORE_VERSION = 1;

// Mirrors ipc.js's own LANGUAGES and settings-general.js's ALL_LANGUAGES —
// the three configured ASR languages. Not imported from either to avoid a
// renderer/main import across the IPC boundary; see the engine notes's config
// schema for the source of truth.
const LANGUAGES = Object.freeze(['en', 'de', 'el']);

const MAX_TERM_LENGTH = 200;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/** Validates and normalises the fields a caller may set on a term. Does not
 * touch id/addedAt/corrections — those are the store's own to assign. */
function validateTermInput(input) {
  if (!isPlainObject(input)) {
    throw new TypeError('A dictionary term must be an object.');
  }

  const term = typeof input.term === 'string' ? input.term.trim() : '';
  if (!term) throw new TypeError('A dictionary term needs a spelling.');
  if (term.length > MAX_TERM_LENGTH) {
    throw new TypeError(`A dictionary term must be ${MAX_TERM_LENGTH} characters or fewer.`);
  }

  let soundsLike = null;
  if (input.soundsLike !== undefined && input.soundsLike !== null) {
    if (typeof input.soundsLike !== 'string') {
      throw new TypeError('soundsLike must be a string.');
    }
    const trimmed = input.soundsLike.trim();
    if (trimmed.length > MAX_TERM_LENGTH) {
      throw new TypeError(`The "sounds like" hint must be ${MAX_TERM_LENGTH} characters or fewer.`);
    }
    soundsLike = trimmed.length > 0 ? trimmed : null;
  }

  let lang = null;
  if (input.lang !== undefined && input.lang !== null && input.lang !== '') {
    if (!LANGUAGES.includes(input.lang)) {
      throw new TypeError(`lang must be one of ${LANGUAGES.join(', ')}, or omitted.`);
    }
    lang = input.lang;
  }

  return { term, soundsLike, lang };
}

function normaliseTermKey(term) {
  return term.trim().toLowerCase();
}

function cloneTerm(term) {
  return { ...term };
}

/** Defensive read of a term already on disk. Throws on structural corruption
 * (not an object, no id) but tolerates a field that has since gone bad by
 * falling back to a safe default, so one damaged entry cannot brick the
 * whole file the way a thrown error while loading every other term would. */
function normaliseStoredTerm(raw) {
  if (!isPlainObject(raw)) {
    throw new TypeError('Dictionary file is corrupt: a term is not an object.');
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    throw new TypeError('Dictionary file is corrupt: a term has no id.');
  }
  const validated = validateTermInput(raw);
  return {
    id: raw.id,
    term: validated.term,
    soundsLike: validated.soundsLike,
    lang: validated.lang,
    addedAt: typeof raw.addedAt === 'string' && raw.addedAt.length > 0 ? raw.addedAt : todayIso(),
    corrections: Number.isInteger(raw.corrections) && raw.corrections >= 0 ? raw.corrections : 0,
  };
}

/** Accepts either an export's own `{ version, terms }` shape or a bare array
 * — a hand-edited or re-imported file is still just a list of terms. Returns
 * the entries that pass validation plus a count of the ones that did not, so
 * one bad line is reported as skipped rather than aborting the whole import:
 * a dictionary shared with one other person (see Flowstate.md) is exactly the
 * case where one bad line should not lose the other forty. */
function parseImportPayload(payload) {
  const list = Array.isArray(payload) ? payload
    : (isPlainObject(payload) && Array.isArray(payload.terms)) ? payload.terms
      : null;
  if (!list) {
    throw new TypeError(
      'Dictionary import data must be an export (an object with a "terms" array) or a bare array.'
    );
  }
  const valid = [];
  let invalid = 0;
  for (const item of list) {
    try {
      valid.push(validateTermInput(item));
    } catch {
      invalid += 1;
    }
  }
  return { valid, invalid };
}

class DictionaryStore {
  #terms = [];
  #loaded = false;
  #writes = Promise.resolve();

  constructor(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new TypeError('DictionaryStore requires a file path.');
    }
    this.filePath = path.resolve(filePath);
  }

  async load() {
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      raw = { version: STORE_VERSION, terms: [] };
      await writeJsonAtomic(this.filePath, raw);
    }
    if (!isPlainObject(raw) || !Array.isArray(raw.terms)) {
      throw new TypeError('Dictionary file is corrupt: missing a terms array.');
    }
    this.#terms = raw.terms.map(normaliseStoredTerm);
    this.#loaded = true;
    return this.list();
  }

  #assertLoaded() {
    if (!this.#loaded) throw new Error('The dictionary store has not been loaded.');
  }

  #persist() {
    const snapshot = { version: STORE_VERSION, terms: this.#terms };
    const operation = this.#writes.then(() => writeJsonAtomic(this.filePath, snapshot));
    // A failed write rejects its own caller without poisoning the next
    // mutation — the same serialisation config.js's ConfigStore.update uses.
    this.#writes = operation.catch(() => {});
    return operation;
  }

  #findIndexByTerm(text, excludeId) {
    const key = normaliseTermKey(text);
    return this.#terms.findIndex(
      (candidate) => candidate.id !== excludeId && normaliseTermKey(candidate.term) === key
    );
  }

  list() {
    this.#assertLoaded();
    return this.#terms.map(cloneTerm);
  }

  async add(input) {
    this.#assertLoaded();
    const validated = validateTermInput(input);
    if (this.#findIndexByTerm(validated.term) !== -1) {
      throw new Error(`"${validated.term}" is already in the dictionary.`);
    }
    const record = {
      id: randomUUID(),
      term: validated.term,
      soundsLike: validated.soundsLike,
      lang: validated.lang,
      addedAt: todayIso(),
      corrections: 0,
    };
    this.#terms.push(record);
    await this.#persist();
    return cloneTerm(record);
  }

  async update(id, input) {
    this.#assertLoaded();
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('A dictionary term id is required.');
    }
    const index = this.#terms.findIndex((candidate) => candidate.id === id);
    if (index === -1) throw new Error('That dictionary term no longer exists.');

    const validated = validateTermInput(input);
    if (this.#findIndexByTerm(validated.term, id) !== -1) {
      throw new Error(`"${validated.term}" is already in the dictionary.`);
    }

    const next = {
      ...this.#terms[index],
      term: validated.term,
      soundsLike: validated.soundsLike,
      lang: validated.lang,
    };
    this.#terms[index] = next;
    await this.#persist();
    return cloneTerm(next);
  }

  async remove(id) {
    this.#assertLoaded();
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('A dictionary term id is required.');
    }
    const index = this.#terms.findIndex((candidate) => candidate.id === id);
    if (index === -1) return false;
    this.#terms.splice(index, 1);
    await this.#persist();
    return true;
  }

  async recordCorrections(ids) {
    this.#assertLoaded();
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      throw new TypeError('Dictionary correction ids must be an array of strings.');
    }

    const correctionCounts = new Map();
    for (const id of ids) {
      correctionCounts.set(id, (correctionCounts.get(id) ?? 0) + 1);
    }
    if (correctionCounts.size === 0) return 0;
    let recorded = 0;
    this.#terms = this.#terms.map((term) => {
      const count = correctionCounts.get(term.id) ?? 0;
      if (count === 0) return term;
      recorded += count;
      return {
        ...term,
        corrections: term.corrections + count,
      };
    });
    if (recorded > 0) await this.#persist();
    return recorded;
  }

  async import(payload) {
    this.#assertLoaded();
    const { valid: incoming, invalid } = parseImportPayload(payload);
    let added = 0;
    let skipped = invalid;
    for (const item of incoming) {
      if (this.#findIndexByTerm(item.term) !== -1) {
        skipped += 1;
        continue;
      }
      this.#terms.push({
        id: randomUUID(),
        term: item.term,
        soundsLike: item.soundsLike,
        lang: item.lang,
        addedAt: todayIso(),
        corrections: 0,
      });
      added += 1;
    }
    if (added > 0) await this.#persist();
    return { added, skipped };
  }

  export() {
    this.#assertLoaded();
    return { version: STORE_VERSION, terms: this.list() };
  }
}

function createDictionaryStore({ directory, filePath } = {}) {
  const resolvedPath = filePath ?? (directory && path.join(directory, 'dictionary.json'));
  if (!resolvedPath) {
    throw new TypeError('createDictionaryStore requires directory or filePath.');
  }
  return new DictionaryStore(resolvedPath);
}

module.exports = {
  LANGUAGES,
  MAX_TERM_LENGTH,
  STORE_VERSION,
  DictionaryStore,
  createDictionaryStore,
  validateTermInput,
};
