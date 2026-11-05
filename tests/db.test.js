'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  MIGRATIONS,
  buildMatchExpression,
  countWords,
  createHistoryDatabase,
  foldForSearch,
  migrate,
} = require('../src/main/db');
const { createPasteService } = require('../src/main/inject');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-16T12:00:00Z');

// Removed once at the end, not per test: Windows refuses to delete a
// database file a test's still-open connection holds, and per-test hooks
// run before the connections registered after them are closed.
const tempDirectories = [];
test.after(() => {
  for (const directory of tempDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function tempDbPath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowstate-db-'));
  tempDirectories.push(directory);
  return path.join(directory, 'flowstate.db');
}

/* A store whose flushes run only when the test says so, so the tests can
   observe the gap between append() and the disk write. */
function openStore(t, options = {}) {
  const scheduled = [];
  let clock = options.now ?? NOW;
  const store = createHistoryDatabase({
    filePath: options.filePath ?? tempDbPath(t),
    logger: { error() {} },
    now: () => clock,
    schedule: (callback) => scheduled.push(callback),
    ...options.extra,
  });
  t.after(() => store.close());
  return {
    store,
    scheduled,
    setClock(value) { clock = value; },
    runScheduled() {
      while (scheduled.length > 0) scheduled.shift()();
    },
  };
}

let nextId = 1;
function entry(overrides = {}) {
  const id = overrides.id ?? `dictation-${nextId++}`;
  const finalText = overrides.finalText ?? 'Hello world.';
  return {
    id,
    createdAt: new Date(NOW).toISOString(),
    language: 'en',
    rawText: 'hello world',
    snippetText: 'hello world',
    llmText: finalText,
    dictionaryText: finalText,
    finalText,
    cleanedText: finalText,
    cleanupApplied: true,
    cleanupReason: 'cleaned',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-flash',
    llmMs: 640.2,
    llmInputTokens: 210,
    llmOutputTokens: 12,
    llmTokens: 222,
    vadMs: 9.5,
    asrMs: 311.4,
    durationMs: 3_000,
    text: finalText,
    target: { windowId: 'w-1', exe: 'Code.exe', title: 'db.js — flowstate', capturedAt: 1 },
    ...overrides,
  };
}

function ftsIntegrity(filePath) {
  const db = new Database(filePath);
  try {
    // Throws SQLITE_CORRUPT_VTAB if the index disagrees with dictations.
    db.exec("INSERT INTO dictations_fts (dictations_fts) VALUES ('integrity-check')");
    return true;
  } finally {
    db.close();
  }
}

function idsOf(entries) {
  return entries.map((item) => item.id);
}

test('append queues without touching the disk; the flush lands on the next macrotask', async (t) => {
  const filePath = tempDbPath(t);
  const h = openStore(t, { filePath });
  const row = entry({ id: 'queued' });

  await h.store.append(row);
  assert.equal(h.store.pendingWrites(), 1);
  assert.equal(h.scheduled.length, 1);

  const reader = new Database(filePath, { readonly: true });
  t.after(() => reader.close());
  assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM dictations').get().n, 0);

  h.runScheduled();
  assert.equal(h.store.pendingWrites(), 0);
  assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM dictations').get().n, 1);
});

test('the database file is in WAL mode with a recorded schema version', (t) => {
  const filePath = tempDbPath(t);
  const h = openStore(t, { filePath });
  assert.equal(h.store.schemaVersion(), MIGRATIONS.length);
  const reader = new Database(filePath, { readonly: true });
  t.after(() => reader.close());
  assert.equal(reader.pragma('journal_mode', { simple: true }), 'wal');
  assert.deepEqual(
    reader.prepare('SELECT version, name FROM schema_version ORDER BY version').all(),
    MIGRATIONS.map((step) => ({ version: step.version, name: step.name }))
  );
});

test('insert stores every documented column and the five pipeline stages', async (t) => {
  const h = openStore(t);
  await h.store.append(entry({
    id: 'full-row',
    rawText: 'um so the snip thing',
    snippetText: 'um so the snippet thing',
    llmText: 'So the snippet thing.',
    dictionaryText: 'So the Snippet thing.',
    finalText: 'So the Snippet thing.',
    cleanedText: 'So the Snippet thing.',
    durationMs: 2_000,
  }));
  h.store.recordOutcome({ id: 'full-row', ok: true, code: 'pasted', injectMs: 121.5, totalMs: 1_190.3 });

  const saved = h.store.get('full-row');
  assert.deepEqual(saved, {
    id: 'full-row',
    at: '2026-10-16T12:00:00.000Z',
    app: { exe: 'Code.exe', label: 'Code' },
    windowTitle: 'db.js — flowstate',
    lang: 'en',
    words: 4,
    durationMs: 2_000,
    wpm: 120,
    vadMs: 9.5,
    asrMs: 311.4,
    llmMs: 640.2,
    injectMs: 121.5,
    totalMs: 1_190.3,
    llmTokens: 222,
    llmInputTokens: 210,
    llmOutputTokens: 12,
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-flash',
    cleanupApplied: true,
    cleanupReason: 'cleaned',
    pasteStatus: 'pasted',
    pasteCode: 'pasted',
    raw: 'um so the snip thing',
    cleaned: 'So the Snippet thing.',
    text: 'So the Snippet thing.',
    stages: {
      raw: 'um so the snip thing',
      snippets: 'um so the snippet thing',
      llm: 'So the snippet thing.',
      dictionary: 'So the Snippet thing.',
      final: 'So the Snippet thing.',
    },
  });
  assert.ok(Object.isFrozen(saved));
});

test('append rejects entries the paste path must not proceed with', async (t) => {
  const h = openStore(t);
  await assert.rejects(h.store.append({ id: 'x', text: '' }), /non-empty text/);
  await assert.rejects(h.store.append({ text: 'no id' }), /require an id/);
  assert.equal(h.store.pendingWrites(), 0);
});

test('a duplicate id is ignored rather than failing the batch it is in', async (t) => {
  const h = openStore(t);
  await h.store.append(entry({ id: 'twice', finalText: 'First.' }));
  await h.store.append(entry({ id: 'twice', finalText: 'Second.' }));
  await h.store.append(entry({ id: 'after' }));
  h.runScheduled();
  assert.equal(h.store.count(), 2);
  assert.equal(h.store.get('twice').text, 'First.');
});

test('recent is newest first and bounded', async (t) => {
  const h = openStore(t);
  for (let index = 0; index < 5; index += 1) {
    await h.store.append(entry({ id: `r${index}`, createdAt: NOW + index * 1_000 }));
  }
  assert.deepEqual(idsOf(h.store.recent(3)), ['r4', 'r3', 'r2']);
  assert.equal(h.store.recent().length, 5);
  assert.throws(() => h.store.recent(-1), /non-negative integer/);
});

test('FTS finds German umlauts and ß with or without the diacritics', async (t) => {
  const h = openStore(t);
  await h.store.append(entry({
    id: 'de',
    language: 'de',
    rawText: 'ähm grüße aus münchen die straße ist schön',
    finalText: 'Grüße aus München, die Straße ist schön.',
  }));
  await h.store.append(entry({ id: 'en', rawText: 'nothing german here' }));

  for (const query of [
    'grüße', 'GRÜSSE', 'grusse', 'münchen', 'Munchen', 'MÜNCHEN',
    'straße', 'strasse', 'schön', 'schon', 'ähm', 'ahm', 'münch',
  ]) {
    assert.deepEqual(idsOf(h.store.search(query)), ['de'], `query ${query}`);
  }
  assert.ok(ftsIntegrity(h.store.filePath));
});

test('FTS finds Greek with or without tonos, in any case, and by prefix', async (t) => {
  const h = openStore(t);
  await h.store.append(entry({
    id: 'el',
    language: 'el',
    rawText: 'καλημέρα κόσμε η Ελλάς',
    finalText: 'Καλημέρα κόσμε, η Ελλάς.',
  }));
  await h.store.append(entry({ id: 'en', rawText: 'kalimera in latin letters' }));

  for (const query of [
    'καλημέρα', 'καλημερα', 'ΚΑΛΗΜΕΡΑ', 'ΚΑΛΗΜΈΡΑ',
    'κόσμε', 'κοσμε', 'κοσμ', 'Ελλάς', 'ελλας', 'ΕΛΛΑΣ', 'ελλάσ',
  ]) {
    assert.deepEqual(idsOf(h.store.search(query)), ['el'], `query ${query}`);
  }
  assert.ok(ftsIntegrity(h.store.filePath));
});

test('search covers raw and cleaned text, ANDs terms, and treats FTS syntax as text', async (t) => {
  const h = openStore(t);
  await h.store.append(entry({
    id: 'a',
    rawText: 'um the retry logic',
    finalText: 'Move the retry logic out of the dictation path.',
  }));
  await h.store.append(entry({ id: 'b', rawText: 'retry later', finalText: 'Retry later.' }));

  assert.deepEqual(idsOf(h.store.search('dictation')), ['a'], 'cleaned-only word');
  assert.deepEqual(idsOf(h.store.search('um')).sort(), ['a'], 'raw-only word');
  assert.deepEqual(idsOf(h.store.search('retry')).sort(), ['a', 'b']);
  assert.deepEqual(idsOf(h.store.search('retry path')), ['a']);
  for (const hostile of ['"', 'retry OR', 'NEAR(retry', 'retry*', 'raw_search:retry', '(', 'AND']) {
    assert.doesNotThrow(() => h.store.search(hostile), `query ${hostile}`);
  }
  assert.deepEqual(idsOf(h.store.search('raw_search:dictation')).sort(), [],
    'a column filter in user input is a word, not syntax');
  assert.equal(h.store.search('').length, 2, 'empty query lists everything');
  assert.throws(() => h.store.search('x'.repeat(501)), /at most 500/);
  assert.throws(() => h.store.search('x', { colour: 'red' }), /does not understand: colour/);
});

test('search filters by language, app and date range', async (t) => {
  const h = openStore(t);
  await h.store.append(entry({ id: 'old-en', createdAt: NOW - 10 * DAY_MS }));
  await h.store.append(entry({ id: 'new-de', language: 'de', createdAt: NOW - DAY_MS }));
  await h.store.append(entry({
    id: 'new-en-chrome',
    createdAt: NOW,
    target: { windowId: 'w', exe: 'chrome.exe', title: 'Inbox', capturedAt: 1 },
  }));

  assert.deepEqual(idsOf(h.store.search('', { language: 'de' })), ['new-de']);
  assert.deepEqual(idsOf(h.store.search('hello', { app: 'CHROME.EXE' })), ['new-en-chrome']);
  assert.deepEqual(
    idsOf(h.store.search('', { from: NOW - 2 * DAY_MS })),
    ['new-en-chrome', 'new-de']
  );
  assert.deepEqual(
    idsOf(h.store.search('', { to: new Date(NOW - 5 * DAY_MS).toISOString() })),
    ['old-en']
  );
  assert.deepEqual(idsOf(h.store.search('', { limit: 1, offset: 1 })), ['new-de']);
  assert.throws(() => h.store.search('', { from: 'not a date' }), /must be a date/);
});

test('delete removes the row and its index entry', async (t) => {
  const h = openStore(t);
  await h.store.append(entry({ id: 'keep', finalText: 'Keep this one.' }));
  await h.store.append(entry({ id: 'drop', finalText: 'Drop this one.' }));
  assert.equal(h.store.delete('drop'), true);
  assert.equal(h.store.delete('drop'), false);
  assert.deepEqual(idsOf(h.store.search('drop')), []);
  assert.deepEqual(idsOf(h.store.search('this')), ['keep']);
  assert.ok(ftsIntegrity(h.store.filePath));
});

test('the update trigger keeps the index in sync when search text changes', async (t) => {
  const h = openStore(t);
  await h.store.append(entry({ id: 'edit', finalText: 'Before.' }));
  h.store.flush();
  const writer = new Database(h.store.filePath);
  writer
    .prepare("UPDATE dictations SET cleaned_text = 'After.', cleaned_search = 'after.' WHERE id = 'edit'")
    .run();
  writer.close();
  assert.deepEqual(idsOf(h.store.search('after')), ['edit']);
  assert.deepEqual(idsOf(h.store.search('before')), []);
  assert.ok(ftsIntegrity(h.store.filePath));
});

test('clear empties rows, index and queue, then compacts the file', async (t) => {
  const h = openStore(t);
  for (let index = 0; index < 50; index += 1) {
    await h.store.append(entry({ finalText: `Dictation number ${index} with some words.` }));
  }
  h.store.flush();
  await h.store.append(entry({ id: 'still-queued' }));
  assert.equal(h.store.clear(), 50);
  assert.equal(h.store.pendingWrites(), 0);
  h.runScheduled();
  assert.equal(h.store.count(), 0);
  assert.deepEqual(h.store.search('dictation'), []);

  const reader = new Database(h.store.filePath, { readonly: true });
  t.after(() => reader.close());
  assert.equal(reader.pragma('freelist_count', { simple: true }), 0);
  assert.ok(ftsIntegrity(h.store.filePath));
});

test('retention: 0 keeps everything, N days expires older rows and vacuums', async (t) => {
  let retentionDays = 0;
  const h = openStore(t, { extra: { getRetentionDays: () => retentionDays } });
  await h.store.append(entry({ id: 'ancient', createdAt: NOW - 400 * DAY_MS }));
  await h.store.append(entry({ id: 'month', createdAt: NOW - 31 * DAY_MS }));
  await h.store.append(entry({ id: 'week', createdAt: NOW - 6 * DAY_MS }));
  await h.store.append(entry({ id: 'today', createdAt: NOW }));

  assert.equal(h.store.applyRetention(), 0);
  assert.equal(h.store.count(), 4);

  retentionDays = 30;
  assert.equal(h.store.applyRetention(), 2);
  assert.deepEqual(idsOf(h.store.recent()), ['today', 'week']);
  assert.equal(h.store.applyRetention(7), 0);
  assert.equal(h.store.applyRetention(1), 1);
  assert.deepEqual(idsOf(h.store.recent()), ['today']);
  assert.throws(() => h.store.applyRetention(-1), /non-negative integer/);

  const reader = new Database(h.store.filePath, { readonly: true });
  t.after(() => reader.close());
  assert.equal(reader.pragma('freelist_count', { simple: true }), 0, 'VACUUM ran');
  assert.ok(ftsIntegrity(h.store.filePath));
});

test('retention runs at open and again after a flush once a day has passed', async (t) => {
  const filePath = tempDbPath(t);
  const first = openStore(t, { filePath });
  await first.store.append(entry({ id: 'old', createdAt: NOW - 40 * DAY_MS }));
  await first.store.append(entry({ id: 'fresh', createdAt: NOW }));
  first.store.close();

  const second = openStore(t, { filePath, extra: { getRetentionDays: () => 30 } });
  assert.deepEqual(idsOf(second.store.recent()), ['fresh'], 'expired at open');

  // Within the day: a flush does not re-run retention.
  second.setClock(NOW + 12 * 60 * 60 * 1000);
  await second.store.append(entry({ id: 'later', createdAt: NOW - 31 * DAY_MS }));
  second.runScheduled();
  assert.equal(second.store.count(), 2);

  // A day after the last run, the next flush expires it.
  second.setClock(NOW + DAY_MS + 1);
  await second.store.append(entry({ id: 'next-day', createdAt: NOW + DAY_MS }));
  second.runScheduled();
  assert.deepEqual(idsOf(second.store.recent()), ['next-day', 'fresh']);
});

test('close flushes queued dictations so a quit loses nothing', async (t) => {
  const filePath = tempDbPath(t);
  const first = openStore(t, { filePath });
  await first.store.append(entry({ id: 'at-quit' }));
  assert.equal(first.store.pendingWrites(), 1);
  first.store.close();
  assert.throws(() => first.store.recent(), /closed/);

  const second = openStore(t, { filePath });
  assert.deepEqual(idsOf(second.store.recent()), ['at-quit']);
});

test('migration: a fresh database runs every step once; reopening runs none', (t) => {
  const filePath = tempDbPath(t);
  const db = new Database(filePath);
  t.after(() => db.close());
  const all = MIGRATIONS.map((step) => step.version);
  assert.deepEqual(migrate(db, { now: () => NOW }), { from: 0, to: all.length, applied: all });
  assert.deepEqual(migrate(db, { now: () => NOW }), { from: all.length, to: all.length, applied: [] });
  assert.deepEqual(
    db.prepare('SELECT version, name, applied_at FROM schema_version ORDER BY version').all(),
    MIGRATIONS.map((step) => ({ version: step.version, name: step.name, applied_at: NOW }))
  );
});

test('migration: later steps apply in order on top of an existing database', async (t) => {
  const filePath = tempDbPath(t);
  const v1 = openStore(t, { filePath });
  await v1.store.append(entry({ id: 'from-v1', finalText: 'Written by version one.' }));
  v1.store.close();

  const order = [];
  const migrations = [
    ...MIGRATIONS,
    {
      version: MIGRATIONS.length + 1,
      name: 'add-favourite',
      up(db) {
        order.push(MIGRATIONS.length + 1);
        db.exec('ALTER TABLE dictations ADD COLUMN favourite INTEGER NOT NULL DEFAULT 0');
      },
    },
    {
      version: MIGRATIONS.length + 2,
      name: 'favourite-index',
      up(db) {
        order.push(MIGRATIONS.length + 2);
        db.exec('CREATE INDEX dictations_favourite ON dictations (favourite)');
      },
    },
  ];
  const v3 = openStore(t, { filePath, extra: { migrations } });
  assert.deepEqual(order, [MIGRATIONS.length + 1, MIGRATIONS.length + 2]);
  assert.equal(v3.store.schemaVersion(), MIGRATIONS.length + 2);
  assert.deepEqual(idsOf(v3.store.search('version one')), ['from-v1'], 'data survives');
});

test('migration: a failing step rolls back and leaves the previous version', (t) => {
  const filePath = tempDbPath(t);
  const db = new Database(filePath);
  t.after(() => db.close());
  migrate(db);
  const broken = [
    ...MIGRATIONS,
    {
      version: MIGRATIONS.length + 1,
      name: 'half-done',
      up(target) {
        target.exec('CREATE TABLE half_done (x)');
        throw new Error('step failed midway');
      },
    },
  ];
  assert.throws(() => migrate(db, { migrations: broken }), /step failed midway/);
  assert.equal(
    db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v,
    MIGRATIONS.length
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'half_done'").get().n,
    0
  );
});

test('migration: refuses misnumbered steps and databases from a newer build', (t) => {
  const filePath = tempDbPath(t);
  const db = new Database(filePath);
  t.after(() => db.close());
  assert.throws(
    () => migrate(db, { migrations: [{ version: 2, name: 'gap', up() {} }] }),
    /must have version 1/
  );
  migrate(db);
  const future = MIGRATIONS.length + 1;
  db.prepare("INSERT INTO schema_version (version, name, applied_at) VALUES (?, 'future', 0)").run(future);
  assert.throws(() => migrate(db), /newer than this build/);
  db.close();
  assert.throws(
    () => createHistoryDatabase({ filePath, logger: { error() {} } }),
    new RegExp(`schema version ${future}, newer than this build [(]${MIGRATIONS.length}[)]`)
  );
});

test('a failed paste still writes its row, with the reason it did not land', async (t) => {
  const h = openStore(t);
  const injector = createPasteService({
    clipboard: {},
    nativeImage: {},
    user32: {
      getPressedModifiers: () => [],
      sendPasteChord: () => assert.fail('must not send input to a background window'),
    },
    focus: { isTargetForeground: () => false },
    history: h.store,
    logger: { error() {}, warn() {} },
  });
  const row = entry({ id: 'failed-paste', finalText: 'Text that could not be pasted.' });
  delete row.text;
  delete row.target;
  const target = { windowId: 'w-9', exe: 'notepad.exe', title: 'Untitled', capturedAt: 1 };

  const result = await injector.pasteText({ text: row.finalText, target, historyEntry: row });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'target-not-foreground');
  assert.equal(result.historySaved, true);

  h.store.recordOutcome({ id: 'failed-paste', ok: result.ok, code: result.code, injectMs: 0.4, totalMs: 900 });
  h.runScheduled();
  const saved = h.store.get('failed-paste');
  assert.equal(saved.text, 'Text that could not be pasted.');
  assert.equal(saved.app.exe, 'notepad.exe');
  assert.equal(saved.pasteStatus, 'failed');
  assert.equal(saved.pasteCode, 'target-not-foreground');
  assert.deepEqual(idsOf(h.store.search('pasted')), ['failed-paste']);
});

test('with the real scheduler the paste chord is sent before the row reaches disk', async (t) => {
  const filePath = tempDbPath();
  // Default schedule (setImmediate), exactly as main.js opens it.
  const store = createHistoryDatabase({ filePath, logger: { error() {} } });
  t.after(() => store.close());
  let clipboardText = 'previous clipboard';
  const clipboard = {
    availableFormats: () => ['text/plain'],
    readBookmark: () => ({ title: '', url: '' }),
    readText: () => clipboardText,
    writeText(text) { clipboardText = text; },
    write(data) { clipboardText = data.text; },
    clear() { clipboardText = ''; },
  };
  let pendingAtChord;
  const injector = createPasteService({
    clipboard,
    nativeImage: {},
    user32: {
      getPressedModifiers: () => [],
      sendPasteChord() {
        pendingAtChord = store.pendingWrites();
        return { requestedEvents: 4, sentEvents: 4, accepted: true, win32Error: 0 };
      },
    },
    focus: { isTargetForeground: () => true },
    history: store,
    logger: { error() {}, warn() {} },
  });
  const row = entry({ id: 'timed', finalText: 'Pasted first, saved second.' });
  delete row.text;
  delete row.target;

  const result = await injector.pasteText({
    text: row.finalText,
    target: { windowId: 'w', exe: 'notepad.exe', title: 'Untitled', capturedAt: 1 },
    historyEntry: row,
  });
  assert.equal(result.ok, true);
  assert.equal(pendingAtChord, 1, 'the row was still queued when the chord went out');
  // The clipboard-restore delay after the chord is a macrotask; the flush ran in it.
  assert.equal(store.pendingWrites(), 0);
  assert.equal(clipboardText, 'previous clipboard');
  assert.equal(store.get('timed').text, 'Pasted first, saved second.');
});

test('a row whose outcome never arrives stays pending, not pasted', async (t) => {
  const h = openStore(t);
  await h.store.append(entry({ id: 'crashed-mid-paste' }));
  assert.equal(h.store.get('crashed-mid-paste').pasteStatus, 'pending');
});

test('fold, word count and match expressions behave as documented', () => {
  assert.equal(foldForSearch('Grüße ΚΑΛΗΜΈΡΑ Ελλάς ﬁx'), 'grusse καλημερα ελλασ fix');
  assert.equal(countWords("Don't stop — it's Wi-Fi, 42 Grüße, καλημέρα."), 7);
  assert.equal(countWords('   '), 0);
  assert.equal(buildMatchExpression('  '), null);
  assert.equal(buildMatchExpression('"München" OR NEAR('), '"munchen"* "or"* "near"*');
});

test('facets lists only the languages and apps that exist, with a total', async (t) => {
  const h = openStore(t);
  await h.store.append(entry({ language: 'de', target: { exe: 'Notepad.exe', windowId: '1', title: 't' } }));
  await h.store.append(entry({ language: 'en', target: { exe: 'notepad.exe', windowId: '1', title: 't' } }));
  const facets = h.store.facets();
  assert.equal(facets.total, 2);
  assert.deepEqual(facets.languages, ['de', 'en']);
  assert.equal(facets.apps.length, 1);
});

test('search stays instant across 10,000 rows and pages with limit/offset', async (t) => {
  const h = openStore(t);
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'grüße', 'golf'];
  for (let i = 0; i < 10_000; i++) {
    await h.store.append(entry({
      finalText: `${words[i % words.length]} note number ${i}.`,
      rawText: `${words[i % words.length]} note number ${i}`,
    }));
    if (i % 200 === 199) h.store.flush();
  }
  h.store.flush();
  assert.equal(h.store.count(), 10_000);
  const started = performance.now();
  const hits = h.store.search('grusse', { limit: 50 });
  const elapsed = performance.now() - started;
  assert.equal(hits.length, 50);
  assert.ok(elapsed < 150, `search took ${elapsed.toFixed(1)} ms`);
  const second = h.store.search('grusse', { limit: 50, offset: 50 });
  assert.equal(second.length, 50);
  assert.notEqual(second[0].id, hits[0].id);
});
