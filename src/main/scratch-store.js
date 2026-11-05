'use strict';

/* Scratchpad — issue #32's durable store.
   %APPDATA%\flowstate\scratchpad.json, one document, atomic writes via
   config.js's writer. The renderer saves on a short debounce and on leaving
   the screen; writes are serialised here so the last call always wins and a
   slow disk can never land an older draft over a newer one. */

const path = require('node:path');
const fs = require('node:fs/promises');
const { writeJsonAtomic } = require('./config');

const STORE_VERSION = 1;
const MAX_LENGTH = 2_000_000;
const FILE_NAME = 'scratchpad.json';

class ScratchStore {
  #text = '';
  #updatedAt = null;
  #writes = Promise.resolve();

  constructor(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new TypeError('ScratchStore requires a file path.');
    }
    this.filePath = path.resolve(filePath);
  }

  async load() {
    let raw;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.text === 'string') {
        this.#text = parsed.text.slice(0, MAX_LENGTH);
        this.#updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null;
      }
    } catch {
      // A damaged file must not stop launch. Keep the unreadable original
      // aside so the draft can still be recovered by hand.
      await fs.rename(this.filePath, `${this.filePath}.corrupt`).catch(() => {});
    }
  }

  get() {
    return { text: this.#text, updatedAt: this.#updatedAt };
  }

  set(text) {
    if (typeof text !== 'string') {
      return Promise.reject(new TypeError('Scratchpad text must be a string.'));
    }
    if (text.length > MAX_LENGTH) {
      return Promise.reject(
        new TypeError(`Scratchpad text must be ${MAX_LENGTH} characters or fewer.`)
      );
    }
    this.#text = text;
    this.#updatedAt = new Date().toISOString();
    const snapshot = { version: STORE_VERSION, text: this.#text, updatedAt: this.#updatedAt };
    const result = { updatedAt: this.#updatedAt };
    const write = this.#writes.then(() => writeJsonAtomic(this.filePath, snapshot));
    this.#writes = write.catch(() => {});
    return write.then(() => result);
  }
}

function createScratchStore({ directory, filePath } = {}) {
  const resolvedPath = filePath ?? (directory && path.join(directory, FILE_NAME));
  if (!resolvedPath) {
    throw new TypeError('createScratchStore requires directory or filePath.');
  }
  return new ScratchStore(resolvedPath);
}

module.exports = { MAX_LENGTH, ScratchStore, createScratchStore };
