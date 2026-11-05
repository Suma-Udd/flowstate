'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHistoryDatabase } = require('../src/main/db');
const { wordsChanged, fixCounts, labelForApp } = require('../src/main/insights');

/* All timestamps are built from local-time Date parts, so the suite passes in
   any time zone: "local day" is whatever the machine's calendar says. */
const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 10, 16, 12);

const tempDirectories = [];
test.after(() => {
  for (const directory of tempDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

function openStore(t, { now = NOW } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowstate-insights-'));
  tempDirectories.push(directory);
  const clock = { now };
  const store = createHistoryDatabase({
    filePath: path.join(directory, 'flowstate.db'),
    logger: { error() {} },
    now: () => clock.now,
    schedule: () => {},
  });
  t.after(() => store.close());
  return { store, clock };
}

let nextId = 1;
/* One dictation of `words` words spoken in `ms` milliseconds, so wpm is exact. */
function dictation({ when, words = 10, ms = 6_000, exe = 'Code.exe', language = 'en', ...rest }) {
  const text = Array.from({ length: words }, (_, i) => `w${i}`).join(' ');
  return {
    id: `d-${nextId++}`,
    createdAt: new Date(when).toISOString(),
    language,
    rawText: text,
    finalText: text,
    cleanedText: text,
    text,
    durationMs: ms,
    target: exe === null ? {} : { exe, title: 'x', windowId: 'w', capturedAt: 1 },
    ...rest,
  };
}

async function seed(store, entries) {
  for (const e of entries) await store.append(e);
  store.flush();
}

test('wordsChanged counts replaced, inserted and removed words', () => {
  assert.equal(wordsChanged('a b c', 'a b c'), 0);
  assert.equal(wordsChanged('hello world', 'Hello world.'), 2);
  assert.equal(wordsChanged('um so the thing', 'the thing'), 2);
  assert.equal(wordsChanged('the thing', 'the big thing'), 1);
  assert.equal(wordsChanged('', 'a b'), 2);
  assert.equal(wordsChanged(null, null), 0);
});

test('fixCounts measures cleanup after snippets and dictionary on its own input', () => {
  const counts = fixCounts({
    raw_text: 'um sig and flowstate',
    snippet_text: 'um best regards and flowstate',
    llm_text: 'Best regards and flowstate.',
    dictionary_text: 'Best regards and Flowstate.',
    cleaned_text: 'Best regards and Flowstate.',
  });
  // snippets -> final: um dropped, "regards"->"regards"?, casing and punctuation.
  assert.equal(counts.words_changed, wordsChanged('um best regards and flowstate', 'Best regards and Flowstate.'));
  assert.equal(counts.dict_corrections, 1);
  assert.deepEqual(
    fixCounts({ raw_text: 'a', snippet_text: null, llm_text: null, dictionary_text: null, cleaned_text: 'a' }),
    { words_changed: 0, dict_corrections: 0 }
  );
});

test('labelForApp names known apps, falls back to the exe stem, and never blanks', () => {
  assert.deepEqual(labelForApp('Code.exe'), { label: 'Visual Studio Code', category: 'editor' });
  assert.deepEqual(labelForApp('WINDOWSTERMINAL.EXE'), { label: 'Windows Terminal', category: 'terminal' });
  assert.deepEqual(labelForApp('weird.exe'), { label: 'weird', category: 'other' });
  assert.deepEqual(labelForApp(null), { label: 'Unknown app', category: 'other' });
});

test('an empty database returns honest zeroes and no invented numbers', (t) => {
  const { store } = openStore(t);
  const summary = store.insights.summary('last30');
  assert.equal(summary.wpm.median, null);
  assert.equal(summary.wpm.percentile, null);
  assert.equal(summary.wpm.sampleSize, 0);
  assert.equal(summary.dictations.allTime, 0);
  assert.equal(summary.words.allTime, 0);
  assert.equal(summary.fixes.wordsChanged, 0);
  assert.deepEqual(store.insights.byApp('all'), []);
  assert.deepEqual(store.insights.byLanguage('all'), []);
  const streak = store.insights.streak();
  assert.equal(streak.current, 0);
  assert.equal(streak.longest, 0);
  assert.equal(streak.activeDays, 0);
  assert.equal(streak.days.length, streak.windowDays);
  assert.ok(streak.days.every((day) => day.count === 0));
});

test('median WPM is exact for odd and even samples and ignores rows without a duration', async (t) => {
  const { store } = openStore(t);
  // 10 words / 6 s = 100 wpm; 10 / 5 s = 120; 10 / 4 s = 150.
  await seed(store, [
    dictation({ when: at(2026, 10, 15), ms: 6_000 }),
    dictation({ when: at(2026, 10, 15, 13), ms: 5_000 }),
    dictation({ when: at(2026, 10, 15, 14), ms: 4_000 }),
    dictation({ when: at(2026, 10, 15, 15), ms: null }),
  ]);
  let wpm = store.insights.summary('last7').wpm;
  assert.equal(wpm.median, 120);
  assert.equal(wpm.sampleSize, 3);
  assert.equal(wpm.percentile, null);

  await seed(store, [dictation({ when: at(2026, 10, 15, 16), ms: 3_000 })]); // 200 wpm
  wpm = store.insights.summary('last7').wpm;
  assert.equal(wpm.median, 135); // (120 + 150) / 2
  assert.equal(wpm.sampleSize, 4);
  assert.ok(wpm.scaleMax >= 200 && wpm.scaleMax >= wpm.median);
});

test('periods split words and dictations; all-time ignores the window', async (t) => {
  const { store } = openStore(t);
  await seed(store, [
    dictation({ when: at(2026, 10, 16), words: 10 }),
    dictation({ when: at(2026, 10, 10), words: 20 }), // exactly 6 days back: inside last7
    dictation({ when: at(2026, 10, 9, 23, 59), words: 40 }), // 7 days back: outside last7
    dictation({ when: at(2026, 9, 17), words: 80 }), // 29 days back: inside last30
    dictation({ when: at(2026, 9, 16, 23, 59), words: 160 }), // 30 days back: outside
  ]);
  const seven = store.insights.summary('last7');
  assert.equal(seven.dictations.period, 2);
  assert.equal(seven.words.period, 30);
  const thirty = store.insights.summary('last30');
  assert.equal(thirty.dictations.period, 4);
  assert.equal(thirty.words.period, 150);
  const all = store.insights.summary('all');
  assert.equal(all.dictations.period, 5);
  assert.equal(all.words.period, 310);
  assert.equal(all.words.allTime, 310);
  assert.equal(seven.words.allTime, 310);
});

test('fix counts are stored at write time and summed per period', async (t) => {
  const { store } = openStore(t);
  await seed(store, [
    dictation({
      when: at(2026, 10, 15),
      rawText: 'um hello flow state',
      snippetText: 'um hello flow state',
      llmText: 'Hello flow state.',
      dictionaryText: 'Hello Flowstate.',
      cleanedText: 'Hello Flowstate.',
      finalText: 'Hello Flowstate.',
    }),
    dictation({ when: at(2026, 10, 14) }), // untouched
  ]);
  const fixes = store.insights.summary('last7').fixes;
  assert.equal(fixes.wordsChanged, wordsChanged('um hello flow state', 'Hello Flowstate.'));
  assert.equal(fixes.dictionaryCorrections, wordsChanged('Hello flow state.', 'Hello Flowstate.'));
  assert.equal(fixes.dictationsTouched, 1);
});

test('app usage is grouped case-insensitively, labelled, and sums to 100', async (t) => {
  const { store } = openStore(t);
  await seed(store, [
    dictation({ when: at(2026, 10, 15), exe: 'Code.exe' }),
    dictation({ when: at(2026, 10, 15, 13), exe: 'code.exe' }),
    dictation({ when: at(2026, 10, 15, 14), exe: 'Code.exe' }),
    dictation({ when: at(2026, 10, 15, 15), exe: 'chrome.exe' }),
    dictation({ when: at(2026, 10, 15, 16), exe: null }),
  ]);
  const apps = store.insights.byApp('last30');
  assert.deepEqual(apps.map((a) => [a.label, a.dictations, a.percent]), [
    ['Visual Studio Code', 3, 60],
    ['Google Chrome', 1, 20],
    ['Unknown app', 1, 20],
  ]);
  assert.equal(apps[0].category, 'editor');
});

test('language breakdown counts detected languages only', async (t) => {
  const { store } = openStore(t);
  await seed(store, [
    dictation({ when: at(2026, 10, 15), language: 'en' }),
    dictation({ when: at(2026, 10, 15, 13), language: 'en' }),
    dictation({ when: at(2026, 10, 15, 14), language: 'de' }),
    dictation({ when: at(2026, 10, 15, 15), language: 'el' }),
    dictation({ when: at(2026, 10, 15, 16), language: null }),
  ]);
  const languages = store.insights.byLanguage('all');
  assert.deepEqual(languages.map((l) => [l.code, l.label, l.dictations, l.percent]), [
    ['en', 'English', 2, 50],
    ['de', 'Deutsch', 1, 25],
    ['el', 'Ελληνικά', 1, 25],
  ]);
});

test('streak crosses a month boundary and is broken by a zero day', async (t) => {
  const { store, clock } = openStore(t, { now: at(2026, 10, 3, 9) });
  await seed(store, [
    // Sep 29, 30, Oct 1, 2 (4 days), a zero day (Sep 28), then Sep 25-27.
    ...[[9, 25], [9, 26], [9, 27], [9, 29], [9, 30], [10, 1], [10, 2]].map(([m, d]) =>
      dictation({ when: at(2026, m, d, 8) })),
    dictation({ when: at(2026, 10, 2, 22) }), // second dictation, same day
  ]);
  let streak = store.insights.streak();
  assert.equal(streak.longest, 4);
  // Today (Oct 3) has nothing yet, yesterday does: the streak is still alive.
  assert.equal(streak.current, 4);
  const sep28 = streak.days.find((day) => day.date === '2026-09-28');
  assert.equal(sep28.count, 0);
  assert.equal(streak.days.find((day) => day.date === '2026-10-02').count, 2);
  assert.equal(streak.days[streak.days.length - 1].date, '2026-10-03');
  assert.equal(streak.activeDays, 7);

  // The next day passes with no dictation: the streak is broken, longest stays.
  clock.now = at(2026, 10, 5, 9);
  streak = store.insights.streak();
  assert.equal(streak.current, 0);
  assert.equal(streak.longest, 4);
});

test('a dictation just after local midnight counts for the new day', async (t) => {
  const { store } = openStore(t, { now: at(2026, 10, 2, 12) });
  await seed(store, [
    dictation({ when: at(2026, 10, 1, 23, 50) }),
    dictation({ when: at(2026, 10, 2, 0, 10) }),
  ]);
  const days = store.insights.streak().days;
  assert.equal(days.find((d) => d.date === '2026-10-01').count, 1);
  assert.equal(days.find((d) => d.date === '2026-10-02').count, 1);
  assert.equal(store.insights.streak().current, 2);
});

test('cache serves repeats and drops on write, delete and clear', async (t) => {
  const { store } = openStore(t);
  await seed(store, [dictation({ when: at(2026, 10, 15), id: 'keep' })]);
  const first = store.insights.summary('last30');
  assert.equal(store.insights.summary('last30'), first, 'second call is the cached object');

  await seed(store, [dictation({ when: at(2026, 10, 15, 13), id: 'extra' })]);
  assert.equal(store.insights.summary('last30').dictations.period, 2);

  store.delete('extra');
  assert.equal(store.insights.summary('last30').dictations.period, 1);

  store.clear();
  assert.equal(store.insights.summary('all').dictations.allTime, 0);
});

test('cache also turns over when the local day changes', async (t) => {
  const { store, clock } = openStore(t);
  await seed(store, [dictation({ when: at(2026, 10, 16, 9) })]);
  assert.equal(store.insights.summary('last7').dictations.period, 1);
  clock.now = at(2026, 10, 30, 9);
  assert.equal(store.insights.summary('last7').dictations.period, 0);
});

test('rejects an unknown period', (t) => {
  const { store } = openStore(t);
  assert.throws(() => store.insights.summary('last90'), /period/);
});

test('migration 2 backfills fix counts for rows written before it existed', async (t) => {
  const Database = require('better-sqlite3');
  const { MIGRATIONS, migrate } = require('../src/main/db');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flowstate-insights-'));
  tempDirectories.push(directory);
  const filePath = path.join(directory, 'flowstate.db');
  const db = new Database(filePath);
  migrate(db, { migrations: MIGRATIONS.slice(0, 1) });
  db.prepare(`INSERT INTO dictations (id, created_at, raw_text, final_text, cleaned_text,
      raw_search, cleaned_search, word_count, cleanup_applied)
    VALUES ('old', ?, 'um hello there', 'Hello there.', 'Hello there.', '', '', 2, 1)`).run(NOW);
  db.close();

  const store = createHistoryDatabase({ filePath, logger: { error() {} }, now: () => NOW });
  t.after(() => store.close());
  assert.equal(store.insights.summary('all').fixes.wordsChanged,
    wordsChanged('um hello there', 'Hello there.'));
});

test('50,000 rows: every query is fast, and a cached repeat is instant', async (t) => {
  const { store } = openStore(t);
  const apps = ['Code.exe', 'chrome.exe', 'Discord.exe', 'Obsidian.exe', 'WindowsTerminal.exe'];
  const langs = ['en', 'en', 'en', 'de', 'el'];
  const hour = 60 * 60 * 1000;
  const start = at(2025, 12, 1);
  for (let batch = 0; batch < 100; batch += 1) {
    for (let i = 0; i < 500; i += 1) {
      const n = batch * 500 + i;
      await store.append(dictation({
        when: start + n * (hour / 6),
        words: 5 + (n % 40),
        ms: 3_000 + (n % 9) * 700,
        exe: apps[n % apps.length],
        language: langs[n % langs.length],
        rawText: `um w${n} text`,
        snippetText: `um w${n} text`,
        llmText: `Um w${n} text.`,
        dictionaryText: `Um w${n} text.`,
        cleanedText: `Um w${n} text.`,
      }));
    }
    store.flush();
  }
  assert.equal(store.count(), 50_000);

  const timings = {};
  const time = (name, fn) => {
    const began = process.hrtime.bigint();
    const value = fn();
    timings[name] = Number(process.hrtime.bigint() - began) / 1e6;
    return value;
  };
  const summary = time('summary(all)', () => store.insights.summary('all'));
  time('summary(last30)', () => store.insights.summary('last30'));
  time('byApp(all)', () => store.insights.byApp('all'));
  time('byLanguage(all)', () => store.insights.byLanguage('all'));
  time('streak', () => store.insights.streak());
  time('summary(all) cached', () => store.insights.summary('all'));
  console.log('insights timings at 50k rows (ms):', JSON.stringify(timings));

  assert.equal(summary.dictations.allTime, 50_000);
  assert.ok(summary.fixes.wordsChanged > 0);
  for (const [name, ms] of Object.entries(timings)) {
    if (name.endsWith('cached')) assert.ok(ms < 5, `${name} took ${ms}ms`);
    else assert.ok(ms < 1_500, `${name} took ${ms}ms`);
  }
});
