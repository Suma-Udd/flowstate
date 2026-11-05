'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSnippetsStore } = require('../src/main/snippets-store');

async function tempSnippets(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flowstate-snippets-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return {
    directory,
    filePath: path.join(directory, 'snippets.json'),
    store: createSnippetsStore({ directory }),
  };
}

test('first load creates an empty, valid snippets file', async (t) => {
  const { filePath, store } = await tempSnippets(t);

  const snippets = await store.load();
  const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));

  assert.deepEqual(snippets, []);
  assert.deepEqual(persisted, { version: 1, snippets: [] });
});

test('add persists across a restart', async (t) => {
  const { directory, store } = await tempSnippets(t);
  await store.load();

  const added = await store.add({
    trigger: 'my work email',
    expansion: 'alex@example.com',
  });
  assert.equal(added.trigger, 'my work email');
  assert.equal(added.expansion, 'alex@example.com');
  assert.equal(added.appScope, null);
  assert.equal(added.uses, 0);
  assert.equal(added.lastUsed, null);
  assert.match(added.createdAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(added.id);

  const reloaded = createSnippetsStore({ directory });
  const snippets = await reloaded.load();

  assert.equal(snippets.length, 1);
  assert.equal(snippets[0].trigger, 'my work email');
  assert.equal(snippets[0].id, added.id);
});

test('appScope is normalised to a lowercase executable name', async (t) => {
  const { store } = await tempSnippets(t);
  await store.load();

  const added = await store.add({
    trigger: 'server ssh',
    expansion: 'ssh alex@10.0.0.5',
    appScope: 'WindowsTerminal.EXE',
  });
  assert.equal(added.appScope, 'windowsterminal.exe');
});

test('add rejects a missing trigger, expansion, or a non-executable scope', async (t) => {
  const { store } = await tempSnippets(t);
  await store.load();

  await assert.rejects(() => store.add({ trigger: '   ', expansion: 'x' }), TypeError);
  await assert.rejects(() => store.add({ trigger: 'x', expansion: '   ' }), TypeError);
  await assert.rejects(
    () => store.add({ trigger: 'x', expansion: 'y', appScope: 'not-an-exe' }),
    TypeError
  );
});

test('update and remove persist across a restart', async (t) => {
  const { directory, store } = await tempSnippets(t);
  await store.load();
  const snippet = await store.add({ trigger: 'standard signoff', expansion: 'Thanks,\nSamuel' });

  await store.update(snippet.id, {
    trigger: 'standard signoff',
    expansion: 'Best,\nSamuel',
    appScope: 'discord.exe',
  });
  const afterUpdate = await createSnippetsStore({ directory }).load();
  assert.equal(afterUpdate[0].expansion, 'Best,\nSamuel');
  assert.equal(afterUpdate[0].appScope, 'discord.exe');

  const removed = await store.remove(snippet.id);
  assert.equal(removed, true);
  const afterRemove = await createSnippetsStore({ directory }).load();
  assert.deepEqual(afterRemove, []);

  assert.equal(await store.remove('does-not-exist'), false);
});

test('recordUses persists one use per matched snippet occurrence', async (t) => {
  const { directory, store } = await tempSnippets(t);
  await store.load();
  const first = await store.add({
    trigger: 'first trigger',
    expansion: 'First expansion',
  });
  const second = await store.add({
    trigger: 'second trigger',
    expansion: 'Second expansion',
  });

  assert.equal(
    await store.recordUses([first.id, first.id, 'missing-id']),
    2
  );
  const reloaded = await createSnippetsStore({ directory }).load();
  assert.equal(reloaded.find((snippet) => snippet.id === first.id).uses, 2);
  assert.match(
    reloaded.find((snippet) => snippet.id === first.id).lastUsed,
    /^\d{4}-\d{2}-\d{2}$/
  );
  assert.equal(reloaded.find((snippet) => snippet.id === second.id).uses, 0);
  assert.equal(reloaded.find((snippet) => snippet.id === second.id).lastUsed, null);
});

test('duplicate detection on add is case-insensitive within the same scope', async (t) => {
  const { store } = await tempSnippets(t);
  await store.load();
  await store.add({ trigger: 'meeting notes', expansion: '## Notes', appScope: 'Obsidian.exe' });
  await assert.rejects(
    () => store.add({ trigger: 'MEETING NOTES', expansion: 'different text', appScope: 'obsidian.exe' }),
    /already has a snippet in that scope/
  );
});

test('the same trigger is allowed in a different scope', async (t) => {
  const { store } = await tempSnippets(t);
  await store.load();
  await store.add({ trigger: 'commit template', expansion: 'feat: ', appScope: 'WindowsTerminal.exe' });
  const second = await store.add({ trigger: 'commit template', expansion: 'fix: ', appScope: 'code.exe' });
  assert.equal(second.trigger, 'commit template');
});

test('duplicate detection on update excludes the snippet being edited', async (t) => {
  const { store } = await tempSnippets(t);
  await store.load();
  const a = await store.add({ trigger: 'flowstate repo', expansion: 'https://github.com/Suma-Udd/flowstate' });
  const b = await store.add({ trigger: 'german signoff', expansion: 'Viele Grüße,\nSamuel' });

  // A no-op edit must not trip the duplicate check against itself.
  const unchanged = await store.update(a.id, {
    trigger: 'flowstate repo',
    expansion: 'https://github.com/Suma-Udd/flowstate',
  });
  assert.equal(unchanged.trigger, 'flowstate repo');

  await assert.rejects(
    () => store.update(b.id, { trigger: 'FLOWSTATE REPO', expansion: 'x' }),
    /already has a snippet in that scope/
  );
});

test('update rejects an id that does not exist', async (t) => {
  const { store } = await tempSnippets(t);
  await store.load();
  await assert.rejects(() => store.update('missing', { trigger: 'x', expansion: 'y' }), /no longer exists/);
});

test('export returns the version and every snippet', async (t) => {
  const { store } = await tempSnippets(t);
  await store.load();
  await store.add({ trigger: 'greek greeting', expansion: 'Γεια σου!' });
  await store.add({ trigger: 'server ssh', expansion: 'ssh alex@10.0.0.5' });

  const exported = store.export();
  assert.equal(exported.version, 1);
  assert.equal(exported.snippets.length, 2);
});

test('import merges snippets, skipping duplicates and invalid entries', async (t) => {
  const { directory, store } = await tempSnippets(t);
  await store.load();
  await store.add({ trigger: 'server ssh', expansion: 'ssh alex@10.0.0.5' });

  const result = await store.import({
    version: 1,
    snippets: [
      { trigger: 'commit template', expansion: 'feat(scope): summary' },
      { trigger: 'server SSH', expansion: 'a different expansion' }, // duplicate, case-insensitive
      { trigger: '   ', expansion: 'x' },                             // invalid: empty trigger
      { trigger: 'x', expansion: '   ' },                             // invalid: empty expansion
      { not: 'a snippet' },                                           // invalid: no trigger field at all
    ],
  });

  assert.equal(result.added, 1);
  assert.equal(result.skipped, 4);

  const reloaded = await createSnippetsStore({ directory }).load();
  const triggers = reloaded.map((s) => s.trigger).sort();
  assert.deepEqual(triggers, ['commit template', 'server ssh'].sort());
});

test('import also accepts a bare array', async (t) => {
  const { store } = await tempSnippets(t);
  await store.load();
  const result = await store.import([{ trigger: 'flowstate repo', expansion: 'https://github.com/Suma-Udd/flowstate' }]);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 0);
});

test('import rejects a payload with no snippets array', async (t) => {
  const { store } = await tempSnippets(t);
  await store.load();
  await assert.rejects(() => store.import({ hello: 'world' }), TypeError);
});

test('a corrupt snippets file fails loudly rather than silently discarding entries', async (t) => {
  const { filePath, store } = await tempSnippets(t);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({ version: 1, snippets: 'not-an-array' }), 'utf8');
  await assert.rejects(() => store.load(), TypeError);
});

test('every method requires load() first', async (t) => {
  const { store } = await tempSnippets(t);
  assert.throws(() => store.list(), /not been loaded/);
  await assert.rejects(() => store.add({ trigger: 'x', expansion: 'y' }), /not been loaded/);
});
