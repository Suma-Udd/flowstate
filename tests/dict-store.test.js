'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDictionaryStore } = require('../src/main/dict-store');

async function tempDictionary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flowstate-dict-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return {
    directory,
    filePath: path.join(directory, 'dictionary.json'),
    store: createDictionaryStore({ directory }),
  };
}

test('first load creates an empty, valid dictionary file', async (t) => {
  const { filePath, store } = await tempDictionary(t);

  const terms = await store.load();
  const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));

  assert.deepEqual(terms, []);
  assert.deepEqual(persisted, { version: 1, terms: [] });
});

test('add persists across a restart', async (t) => {
  const { directory, store } = await tempDictionary(t);
  await store.load();

  const added = await store.add({ term: 'Grafana', soundsLike: 'graph ana', lang: 'en' });
  assert.equal(added.term, 'Grafana');
  assert.equal(added.corrections, 0);
  assert.match(added.addedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(added.id);

  const reloaded = createDictionaryStore({ directory });
  const terms = await reloaded.load();

  assert.equal(terms.length, 1);
  assert.equal(terms[0].term, 'Grafana');
  assert.equal(terms[0].soundsLike, 'graph ana');
  assert.equal(terms[0].lang, 'en');
  assert.equal(terms[0].id, added.id);
});

test('update and remove persist across a restart', async (t) => {
  const { directory, store } = await tempDictionary(t);
  await store.load();
  const term = await store.add({ term: 'Terraform' });

  await store.update(term.id, { term: 'Terraform', soundsLike: 'terra form', lang: 'en' });
  const afterUpdate = await createDictionaryStore({ directory }).load();
  assert.equal(afterUpdate[0].soundsLike, 'terra form');
  assert.equal(afterUpdate[0].lang, 'en');

  const removed = await store.remove(term.id);
  assert.equal(removed, true);
  const afterRemove = await createDictionaryStore({ directory }).load();
  assert.deepEqual(afterRemove, []);

  assert.equal(await store.remove('does-not-exist'), false);
});

test('recordCorrections persists one count per repaired occurrence', async (t) => {
  const { directory, store } = await tempDictionary(t);
  await store.load();
  const first = await store.add({ term: 'Samuel' });
  const second = await store.add({ term: 'Flowstate' });

  assert.equal(
    await store.recordCorrections([first.id, first.id, 'missing-id']),
    2
  );
  const reloaded = await createDictionaryStore({ directory }).load();
  assert.equal(reloaded.find((term) => term.id === first.id).corrections, 2);
  assert.equal(reloaded.find((term) => term.id === second.id).corrections, 0);
});

test('add rejects an empty spelling', async (t) => {
  const { store } = await tempDictionary(t);
  await store.load();
  await assert.rejects(() => store.add({ term: '   ' }), TypeError);
});

test('add rejects an unsupported language', async (t) => {
  const { store } = await tempDictionary(t);
  await store.load();
  await assert.rejects(() => store.add({ term: 'Bonjour', lang: 'fr' }), TypeError);
});

test('duplicate detection on add is case-insensitive', async (t) => {
  const { store } = await tempDictionary(t);
  await store.load();
  await store.add({ term: 'Samuel' });
  await assert.rejects(() => store.add({ term: 'samuel' }), /already in the dictionary/);
  await assert.rejects(() => store.add({ term: 'SAMUEL' }), /already in the dictionary/);
});

test('duplicate detection on update excludes the term being edited', async (t) => {
  const { store } = await tempDictionary(t);
  await store.load();
  const a = await store.add({ term: 'Flowstate' });
  const b = await store.add({ term: 'DeepSeek' });

  // Renaming a term to its own current spelling (a no-op edit) must not
  // trip the duplicate check against itself.
  const unchanged = await store.update(a.id, { term: 'Flowstate', soundsLike: 'flow state' });
  assert.equal(unchanged.soundsLike, 'flow state');

  await assert.rejects(() => store.update(b.id, { term: 'flowstate' }), /already in the dictionary/);
});

test('update rejects an id that does not exist', async (t) => {
  const { store } = await tempDictionary(t);
  await store.load();
  await assert.rejects(() => store.update('missing', { term: 'x' }), /no longer exists/);
});

test('export returns the version and every term', async (t) => {
  const { store } = await tempDictionary(t);
  await store.load();
  await store.add({ term: 'Parakeet' });
  await store.add({ term: 'koffi', soundsLike: 'coffee' });

  const exported = store.export();
  assert.equal(exported.version, 1);
  assert.equal(exported.terms.length, 2);
});

test('import merges terms, skipping duplicates and invalid entries', async (t) => {
  const { directory, store } = await tempDictionary(t);
  await store.load();
  await store.add({ term: 'Ryzen' });

  const result = await store.import({
    version: 1,
    terms: [
      { term: 'Kubernetes', soundsLike: 'koo ber net eez' },
      { term: 'ryzen' },           // duplicate, case-insensitive
      { term: '   ' },             // invalid: empty spelling
      { not: 'a term' },           // invalid: no term field at all
      { term: 'Θεσσαλονίκη', lang: 'el' },
    ],
  });

  assert.equal(result.added, 2);
  assert.equal(result.skipped, 3);

  const reloaded = await createDictionaryStore({ directory }).load();
  const names = reloaded.map((t) => t.term).sort();
  assert.deepEqual(names, ['Kubernetes', 'Ryzen', 'Θεσσαλονίκη'].sort());
});

test('import also accepts a bare array', async (t) => {
  const { store } = await tempDictionary(t);
  await store.load();
  const result = await store.import([{ term: 'Bürgeramt', lang: 'de' }]);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 0);
});

test('import rejects a payload with no terms array', async (t) => {
  const { store } = await tempDictionary(t);
  await store.load();
  await assert.rejects(() => store.import({ hello: 'world' }), TypeError);
});

test('a corrupt dictionary file fails loudly rather than silently discarding terms', async (t) => {
  const { filePath, store } = await tempDictionary(t);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({ version: 1, terms: 'not-an-array' }), 'utf8');
  await assert.rejects(() => store.load(), TypeError);
});

test('every method requires load() first', async (t) => {
  const { store } = await tempDictionary(t);
  assert.throws(() => store.list(), /not been loaded/);
  await assert.rejects(() => store.add({ term: 'x' }), /not been loaded/);
});
