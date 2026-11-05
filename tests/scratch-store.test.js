'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createScratchStore, MAX_LENGTH } = require('../src/main/scratch-store');

async function temp(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flowstate-scratch-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('a fresh store is empty and has never been saved', async (t) => {
  const store = createScratchStore({ directory: await temp(t) });
  await store.load();
  assert.deepEqual(store.get(), { text: '', updatedAt: null });
});

test('saved text survives a restart, including German and Greek', async (t) => {
  const directory = await temp(t);
  const first = createScratchStore({ directory });
  await first.load();
  const saved = await first.set('Drei Punkte.\n\nΤο τρίτο.');
  assert.match(saved.updatedAt, /^\d{4}-\d\d-\d\dT/);

  const second = createScratchStore({ directory });
  await second.load();
  assert.equal(second.get().text, 'Drei Punkte.\n\nΤο τρίτο.');
  assert.equal(second.get().updatedAt, saved.updatedAt);
});

test('overlapping saves land in call order: the last one wins on disk', async (t) => {
  const directory = await temp(t);
  const store = createScratchStore({ directory });
  await store.load();
  await Promise.all(['a', 'ab', 'abc', 'abcd'].map((text) => store.set(text)));

  const reread = createScratchStore({ directory });
  await reread.load();
  assert.equal(reread.get().text, 'abcd');
});

test('non-strings and oversize text are rejected and change nothing', async (t) => {
  const store = createScratchStore({ directory: await temp(t) });
  await store.load();
  await store.set('keep');
  await assert.rejects(store.set(42), TypeError);
  await assert.rejects(store.set('x'.repeat(MAX_LENGTH + 1)), TypeError);
  assert.equal(store.get().text, 'keep');
});

test('a damaged file does not stop launch and is kept aside', async (t) => {
  const directory = await temp(t);
  const file = path.join(directory, 'scratchpad.json');
  await fs.writeFile(file, '{ not json', 'utf8');
  const store = createScratchStore({ directory });
  await store.load();
  assert.equal(store.get().text, '');
  assert.equal(await fs.readFile(`${file}.corrupt`, 'utf8'), '{ not json');
});
