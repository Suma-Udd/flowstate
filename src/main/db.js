'use strict';

/*
 * The dictation history database (#28): better-sqlite3 at
 * %APPDATA%\flowstate\flowstate.db, WAL mode, one row per dictation, FTS5
 * search over the raw and cleaned text.
 *
 * The write path is the reason this file looks the way it does. inject.js
 * awaits `history.append()` before it touches the clipboard (Engine Spec hard
 * rule 6: the transcript is retained before the paste, so a failed paste never
 * loses it). better-sqlite3 is synchronous, so a disk write inside append()
 * would sit between the user's keyup and their text. Instead append()
 * validates, copies the row into an in-memory queue and returns; the queue is
 * flushed to disk on the next macrotask (setImmediate). Every await between
 * append() and SendInput in inject.js resolves as a microtask on the happy
 * path, so the paste chord is sent before the flush runs. The row reaches
 * disk a moment after the text reaches the caret, never before it.
 *
 * Search folding: FTS5's `unicode61 remove_diacritics 2` tokenizer folds Latin
 * diacritics (München matches munchen) but was measured on the bundled SQLite
 * 3.53.3 to leave Greek tonos alone — `καλημερα` did not find `καλημέρα`, and
 * `ελλας` did not find `Ελλάς`. Typing Greek without accents is normal, so the
 * text is folded in JS before indexing: NFKD, strip combining marks, lower
 * case, ß -> ss, final ς -> σ. The folded copies live in two plain columns
 * (raw_search, cleaned_search) that an external-content FTS5 table indexes,
 * kept in sync by ordinary SQL triggers. Folding in JS rather than in a
 * registered SQL function keeps the triggers pure SQL, so the database stays
 * writable from any SQLite client and from future migrations. The tokenizer
 * keeps remove_diacritics 2 as a second line for anything NFKD does not
 * decompose (ø, đ, ł).
 *
 * The DB is local and never leaves the machine.
 */

const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_CHECK_INTERVAL_MS = DAY_MS;
const { createInsights, fixCounts } = require('./insights');

const MAX_QUEUE = 1_000;
const MAX_WRITE_ATTEMPTS = 3;
const MAX_RESULTS = 10_000;
const DEFAULT_RESULTS = 50;
const MAX_QUERY_LENGTH = 500;
const MAX_QUERY_TERMS = 16;

/* Ordered, append-only. A shipped migration is never edited: a database on
   someone's machine has already run it. Add a new step with
   the next version number instead. Each step runs in its own transaction
   together with its schema_version row, so a crash mid-migration leaves the
   previous version intact. */
const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: 'dictations-and-fts',
    up(db) {
      db.exec(`
        CREATE TABLE dictations (
          -- INTEGER PRIMARY KEY is the rowid FTS5 points at. A TEXT primary
          -- key would leave an implicit rowid that VACUUM may renumber, which
          -- would silently detach every FTS entry from its row.
          seq INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          raw_text TEXT NOT NULL,
          snippet_text TEXT,
          llm_text TEXT,
          dictionary_text TEXT,
          final_text TEXT NOT NULL,
          cleaned_text TEXT NOT NULL,
          raw_search TEXT NOT NULL,
          cleaned_search TEXT NOT NULL,
          language TEXT,
          app_exe TEXT,
          window_title TEXT,
          duration_ms INTEGER,
          word_count INTEGER NOT NULL,
          wpm REAL,
          vad_ms REAL,
          asr_ms REAL,
          llm_ms REAL,
          inject_ms REAL,
          total_ms REAL,
          llm_input_tokens INTEGER,
          llm_output_tokens INTEGER,
          llm_tokens INTEGER,
          llm_provider TEXT,
          llm_model TEXT,
          cleanup_applied INTEGER NOT NULL CHECK (cleanup_applied IN (0, 1)),
          cleanup_reason TEXT,
          paste_status TEXT NOT NULL DEFAULT 'pending'
            CHECK (paste_status IN ('pending', 'pasted', 'failed')),
          paste_code TEXT
        );

        CREATE INDEX dictations_created_at ON dictations (created_at);
        CREATE INDEX dictations_language ON dictations (language, created_at);
        CREATE INDEX dictations_app ON dictations (app_exe, created_at);

        CREATE VIRTUAL TABLE dictations_fts USING fts5(
          raw_search,
          cleaned_search,
          content = 'dictations',
          content_rowid = 'seq',
          tokenize = 'unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER dictations_fts_insert AFTER INSERT ON dictations BEGIN
          INSERT INTO dictations_fts (rowid, raw_search, cleaned_search)
          VALUES (new.seq, new.raw_search, new.cleaned_search);
        END;

        CREATE TRIGGER dictations_fts_delete AFTER DELETE ON dictations BEGIN
          INSERT INTO dictations_fts (dictations_fts, rowid, raw_search, cleaned_search)
          VALUES ('delete', old.seq, old.raw_search, old.cleaned_search);
        END;

        CREATE TRIGGER dictations_fts_update
        AFTER UPDATE OF raw_search, cleaned_search ON dictations BEGIN
          INSERT INTO dictations_fts (dictations_fts, rowid, raw_search, cleaned_search)
          VALUES ('delete', old.seq, old.raw_search, old.cleaned_search);
          INSERT INTO dictations_fts (rowid, raw_search, cleaned_search)
          VALUES (new.seq, new.raw_search, new.cleaned_search);
        END;
      `);
    },
  }),
  Object.freeze({
    version: 2,
    name: 'fix-counts',
    up(db) {
      // Insights (#30) counts cleanup and dictionary fixes from the stored
      // stages. Computing them once per row keeps the screen's query a SUM.
      db.exec(`
        ALTER TABLE dictations ADD COLUMN words_changed INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE dictations ADD COLUMN dict_corrections INTEGER NOT NULL DEFAULT 0;
      `);
      const update = db.prepare(
        'UPDATE dictations SET words_changed = @words_changed, dict_corrections = @dict_corrections WHERE seq = @seq'
      );
      const rows = db.prepare(
        'SELECT seq, raw_text, snippet_text, llm_text, dictionary_text, cleaned_text FROM dictations'
      ).all();
      for (const row of rows) update.run({ seq: row.seq, ...fixCounts(row) });
    },
  }),
]);

function foldForSearch(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ς/g, 'σ');
}

// Words as a reader counts them: letters or digits, joined by an apostrophe
// or hyphen (don't, Wi-Fi). Unicode-aware so German and Greek count the same
// way English does.
const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

function countWords(text) {
  return (String(text).match(WORD_PATTERN) ?? []).length;
}

/* Turns whatever the user typed into a safe FTS5 MATCH expression: every term
   is folded the same way the index was, quoted (so FTS5 operators and stray
   quotes in the input are plain text, never syntax), and prefix-matched so a
   half-typed word already finds results. Terms are ANDed. */
function buildMatchExpression(query) {
  const terms = foldForSearch(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0)
    .slice(0, MAX_QUERY_TERMS);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term}"*`).join(' ');
}

function finiteOrNull(value) {
  const number = Number(value);
  return value === null || value === undefined || !Number.isFinite(number)
    ? null
    : number;
}

function nonNegativeIntegerOrNull(value) {
  const number = finiteOrNull(value);
  return number === null || number < 0 ? null : Math.round(number);
}

function stringOrNull(value) {
  return typeof value === 'string' ? value : null;
}

function timestampFrom(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/* The history entry dictation.js builds, plus the `text` and `target` that
   inject.js adds, mapped onto the table's columns. Explicit field list: an
   unknown property on the entry is ignored, never written. */
function rowFromEntry(entry, nowMs) {
  const stages = entry.pipelineStages ?? {};
  const finalText = stringOrNull(entry.finalText) ?? stringOrNull(stages.final) ?? entry.text;
  const rawText = stringOrNull(entry.rawText) ?? stringOrNull(stages.raw) ?? finalText;
  const cleanedText = stringOrNull(entry.cleanedText) ?? finalText;
  const durationMs = nonNegativeIntegerOrNull(entry.durationMs);
  const wordCount = countWords(finalText);
  const target = entry.target ?? {};
  const row = {
    id: entry.id,
    created_at: timestampFrom(entry.createdAt, nowMs),
    raw_text: rawText,
    snippet_text: stringOrNull(entry.snippetText) ?? stringOrNull(stages.snippets),
    llm_text: stringOrNull(entry.llmText) ?? stringOrNull(stages.llm),
    dictionary_text: stringOrNull(entry.dictionaryText) ?? stringOrNull(stages.dictionary),
    final_text: finalText,
    cleaned_text: cleanedText,
    raw_search: foldForSearch(rawText),
    cleaned_search: foldForSearch(cleanedText),
    language: stringOrNull(entry.language),
    app_exe: stringOrNull(target.exe),
    window_title: stringOrNull(target.title),
    duration_ms: durationMs,
    word_count: wordCount,
    // Words that landed per minute of speech. Omitted rather than guessed
    // when there is no duration or nothing countable was said.
    wpm: durationMs && wordCount > 0
      ? Math.round((wordCount / (durationMs / 60_000)) * 10) / 10
      : null,
    vad_ms: finiteOrNull(entry.vadMs),
    asr_ms: finiteOrNull(entry.asrMs),
    llm_ms: finiteOrNull(entry.llmMs),
    inject_ms: null,
    total_ms: null,
    llm_input_tokens: nonNegativeIntegerOrNull(entry.llmInputTokens),
    llm_output_tokens: nonNegativeIntegerOrNull(entry.llmOutputTokens),
    llm_tokens: nonNegativeIntegerOrNull(entry.llmTokens),
    llm_provider: stringOrNull(entry.llmProvider),
    llm_model: stringOrNull(entry.llmModel),
    cleanup_applied: entry.cleanupApplied === true ? 1 : 0,
    cleanup_reason: stringOrNull(entry.cleanupReason),
  };
  return { ...row, ...fixCounts(row) };
}

function appLabel(exe) {
  if (typeof exe !== 'string' || exe.length === 0) return null;
  return exe.replace(/\.exe$/i, '');
}

/* The renderer-facing shape. Field names follow
   src/renderer/fixtures/history.json, which #29's screen was designed
   against; `text` is what was pasted, for the Dictation screen's recent list.
   `relative` ("2 minutes ago") is deliberately absent: it goes stale the
   moment it is computed, so it belongs to whoever paints it. */
function entryFromRow(row) {
  return Object.freeze({
    id: row.id,
    at: new Date(row.created_at).toISOString(),
    app: Object.freeze({ exe: row.app_exe, label: appLabel(row.app_exe) }),
    windowTitle: row.window_title,
    lang: row.language,
    words: row.word_count,
    durationMs: row.duration_ms,
    wpm: row.wpm,
    vadMs: row.vad_ms,
    asrMs: row.asr_ms,
    llmMs: row.llm_ms,
    injectMs: row.inject_ms,
    totalMs: row.total_ms,
    llmTokens: row.llm_tokens,
    llmInputTokens: row.llm_input_tokens,
    llmOutputTokens: row.llm_output_tokens,
    llmProvider: row.llm_provider,
    llmModel: row.llm_model,
    cleanupApplied: row.cleanup_applied === 1,
    cleanupReason: row.cleanup_reason,
    pasteStatus: row.paste_status,
    pasteCode: row.paste_code,
    raw: row.raw_text,
    cleaned: row.cleaned_text,
    text: row.final_text,
    stages: Object.freeze({
      raw: row.raw_text,
      snippets: row.snippet_text,
      llm: row.llm_text,
      dictionary: row.dictionary_text,
      final: row.final_text,
    }),
  });
}

function currentSchemaVersion(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
  return db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_version').get().version;
}

/* Brings `db` up to the newest migration in `migrations`. Exported with the
   list as a parameter so tests can prove ordering and atomicity with steps
   that never ship. */
function migrate(db, { migrations = MIGRATIONS, now = Date.now } = {}) {
  for (let index = 0; index < migrations.length; index += 1) {
    const step = migrations[index];
    if (!Number.isInteger(step.version) || step.version !== index + 1) {
      throw new Error(
        `Migration ${index} must have version ${index + 1}; found ${String(step.version)}.`
      );
    }
  }

  const from = currentSchemaVersion(db);
  const latest = migrations.length;
  if (from > latest) {
    // An older build opened a database a newer build already migrated.
    // Writing to it could corrupt columns this build does not know about.
    throw new Error(
      `flowstate.db is at schema version ${from}, newer than this build (${latest}).`
    );
  }

  const record = db.prepare(
    'INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)'
  );
  const applied = [];
  for (const step of migrations.slice(from)) {
    db.transaction(() => {
      step.up(db);
      record.run(step.version, step.name, now());
    })();
    applied.push(step.version);
  }
  return Object.freeze({ from, to: latest, applied: Object.freeze(applied) });
}

function requireEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError('History entries must be objects.');
  }
  if (typeof entry.text !== 'string' || entry.text.length === 0) {
    throw new TypeError('History entries require non-empty text.');
  }
  if (typeof entry.id !== 'string' || entry.id.length === 0) {
    throw new TypeError('History entries require an id.');
  }
}

function requireRetentionDays(days) {
  if (!Number.isInteger(days) || days < 0) {
    throw new TypeError('history.retentionDays must be a non-negative integer.');
  }
  return days;
}

function createHistoryDatabase({
  filePath,
  Database = require('better-sqlite3'),
  getRetentionDays = () => 0,
  logger = console,
  now = Date.now,
  schedule = setImmediate,
  migrations = MIGRATIONS,
} = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new TypeError('createHistoryDatabase requires a database file path.');
  }
  if (typeof getRetentionDays !== 'function') {
    throw new TypeError('getRetentionDays must be a function.');
  }

  const inMemory = filePath === ':memory:';
  if (!inMemory) fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const db = new Database(filePath);
  let closed = false;
  try {
    if (!inMemory) db.pragma('journal_mode = WAL');
    // NORMAL is crash-safe in WAL mode (an app crash loses nothing); only a
    // power cut can drop the last commit. FULL would fsync on every
    // dictation for a guarantee this personal log does not need.
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 2000');
    migrate(db, { migrations, now });
  } catch (error) {
    db.close();
    throw error;
  }

  const statements = {
    insert: db.prepare(`
      INSERT INTO dictations (
        id, created_at, raw_text, snippet_text, llm_text, dictionary_text,
        final_text, cleaned_text, raw_search, cleaned_search, language,
        app_exe, window_title, duration_ms, word_count, wpm, vad_ms, asr_ms,
        llm_ms, inject_ms, total_ms, llm_input_tokens, llm_output_tokens,
        llm_tokens, llm_provider, llm_model, cleanup_applied, cleanup_reason,
        words_changed, dict_corrections
      ) VALUES (
        @id, @created_at, @raw_text, @snippet_text, @llm_text, @dictionary_text,
        @final_text, @cleaned_text, @raw_search, @cleaned_search, @language,
        @app_exe, @window_title, @duration_ms, @word_count, @wpm, @vad_ms, @asr_ms,
        @llm_ms, @inject_ms, @total_ms, @llm_input_tokens, @llm_output_tokens,
        @llm_tokens, @llm_provider, @llm_model, @cleanup_applied, @cleanup_reason,
        @words_changed, @dict_corrections
      )
      ON CONFLICT (id) DO NOTHING
    `),
    outcome: db.prepare(`
      UPDATE dictations
      SET paste_status = @paste_status,
          paste_code = @paste_code,
          inject_ms = COALESCE(@inject_ms, inject_ms),
          total_ms = COALESCE(@total_ms, total_ms)
      WHERE id = @id
    `),
    get: db.prepare('SELECT * FROM dictations WHERE id = ?'),
    remove: db.prepare('DELETE FROM dictations WHERE id = ?'),
    removeAll: db.prepare('DELETE FROM dictations'),
    count: db.prepare('SELECT COUNT(*) AS count FROM dictations'),
    expire: db.prepare('DELETE FROM dictations WHERE created_at < ?'),
  };

  /* Pending writes, oldest first. Each item is an insert or an outcome
     update; outcomes queue behind their insert, so order on disk matches
     order of events even though nothing waits for the disk. */
  const queue = [];
  let flushScheduled = false;
  let lastRetentionAt = -Infinity;
  // Bumped on every change to the table; Insights drops its cache when it moves.
  let writeVersion = 0;

  function warn(message) {
    try {
      // Never the transcript: logs end up in the diagnostics payload.
      logger.error?.(`Flowstate history: ${message}`);
    } catch {
      // Logging is optional; the queue still drains.
    }
  }

  function requireOpen() {
    if (closed) throw new Error('The history database is closed.');
  }

  function scheduleFlush() {
    if (flushScheduled || closed) return;
    flushScheduled = true;
    schedule(() => {
      flushScheduled = false;
      flush();
      maybeApplyRetention();
    });
  }

  function writeItem(item) {
    writeVersion += 1;
    if (item.kind === 'insert') statements.insert.run(item.row);
    else statements.outcome.run(item.row);
  }

  /* Drains the queue to disk. Called on the next macrotask after a write,
     before every read (so a read never misses a row the user just
     dictated), and on close. Not on the dictation path. */
  function flush() {
    if (closed || queue.length === 0) return 0;
    const batch = queue.splice(0, queue.length);
    let written = 0;
    try {
      db.transaction(() => {
        for (const item of batch) writeItem(item);
      })();
      return batch.length;
    } catch (error) {
      // One bad row must not take the rest of the batch with it: retry each
      // on its own and keep only the ones that still fail.
      warn(`batch write failed (${error.code ?? error.message}); writing rows singly.`);
    }
    for (const item of batch) {
      try {
        writeItem(item);
        written += 1;
      } catch (error) {
        item.attempts += 1;
        if (item.attempts < MAX_WRITE_ATTEMPTS) {
          queue.push(item);
        } else {
          warn(`dropped a ${item.kind} after ${item.attempts} failed writes (${error.code ?? error.message}).`);
        }
      }
    }
    if (queue.length > 0) scheduleFlush();
    return written;
  }

  function enqueue(item) {
    if (queue.length >= MAX_QUEUE) {
      // Only reachable if the disk has been failing for a long time. Keep the
      // newest dictations, which are the ones the user still remembers.
      queue.shift();
      warn('write queue full; the oldest unsaved dictation was dropped.');
    }
    queue.push({ ...item, attempts: 0 });
    scheduleFlush();
  }

  /* The paste path's call. Validates and queues; never touches the disk and
     never waits. Returns a promise so it is a drop-in for the in-memory
     buffer inject.js was written against. */
  async function append(entry) {
    requireOpen();
    requireEntry(entry);
    enqueue({ kind: 'insert', row: rowFromEntry(entry, now()) });
  }

  /* Called by dictation.js once the paste has an outcome, so the row says
     whether its text actually landed. Also queued, also never waits. */
  function recordOutcome({ id, ok, code, injectMs, totalMs } = {}) {
    requireOpen();
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('recordOutcome requires the dictation id.');
    }
    enqueue({
      kind: 'outcome',
      row: {
        id,
        paste_status: ok === true ? 'pasted' : 'failed',
        paste_code: stringOrNull(code),
        inject_ms: finiteOrNull(injectMs),
        total_ms: finiteOrNull(totalMs),
      },
    });
  }

  function limitFrom(value, label) {
    if (value === undefined) return DEFAULT_RESULTS;
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(`${label} must be a non-negative integer.`);
    }
    return Math.min(value, MAX_RESULTS);
  }

  function recent(count) {
    requireOpen();
    flush();
    const limit = limitFrom(count, 'history.recent count');
    return db
      .prepare('SELECT * FROM dictations ORDER BY created_at DESC, seq DESC LIMIT ?')
      .all(limit)
      .map(entryFromRow);
  }

  /* Full-text search, newest first. Filters: language, app (exe name), from /
     to (ISO date or epoch ms, inclusive / exclusive), limit, offset. An empty
     query lists everything the filters allow, which is what a History screen
     with only a filter set needs. */
  function search(query = '', filters = {}) {
    requireOpen();
    if (typeof query !== 'string' || query.length > MAX_QUERY_LENGTH) {
      throw new TypeError(`history.search query must be a string of at most ${MAX_QUERY_LENGTH} characters.`);
    }
    if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
      throw new TypeError('history.search filters must be an object.');
    }
    const known = ['language', 'app', 'from', 'to', 'limit', 'offset'];
    const unknown = Object.keys(filters).filter((key) => !known.includes(key));
    if (unknown.length > 0) {
      throw new TypeError(`history.search does not understand: ${unknown.join(', ')}.`);
    }
    flush();

    const where = [];
    const params = {};
    const match = buildMatchExpression(query);
    if (match) {
      where.push('d.seq IN (SELECT rowid FROM dictations_fts WHERE dictations_fts MATCH @match)');
      params.match = match;
    }
    if (filters.language !== undefined) {
      if (typeof filters.language !== 'string') throw new TypeError('history.search language must be a string.');
      where.push('d.language = @language');
      params.language = filters.language;
    }
    if (filters.app !== undefined) {
      if (typeof filters.app !== 'string') throw new TypeError('history.search app must be a string.');
      where.push('d.app_exe = @app COLLATE NOCASE');
      params.app = filters.app;
    }
    for (const [key, operator] of [['from', '>='], ['to', '<']]) {
      if (filters[key] === undefined) continue;
      const at = timestampFrom(filters[key], null);
      if (at === null) throw new TypeError(`history.search ${key} must be a date.`);
      where.push(`d.created_at ${operator} @${key}`);
      params[key] = at;
    }
    params.limit = limitFrom(filters.limit, 'history.search limit');
    params.offset = filters.offset === undefined ? 0 : limitFrom(filters.offset, 'history.search offset');

    const sql =
      'SELECT d.* FROM dictations AS d'
      + (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '')
      + ' ORDER BY d.created_at DESC, d.seq DESC LIMIT @limit OFFSET @offset';
    return db.prepare(sql).all(params).map(entryFromRow);
  }

  /* What the History filters can offer: only languages and apps that exist in
     the store, plus the total, so the dropdowns never list a dead option. */
  function facets() {
    requireOpen();
    flush();
    const languages = db
      .prepare('SELECT DISTINCT language FROM dictations WHERE language IS NOT NULL ORDER BY language')
      .all()
      .map((row) => row.language);
    const apps = db
      .prepare(
        'SELECT app_exe AS exe, COUNT(*) AS n FROM dictations WHERE app_exe IS NOT NULL'
        + ' GROUP BY app_exe COLLATE NOCASE ORDER BY n DESC'
      )
      .all()
      .map((row) => ({ exe: row.exe, label: appLabel(row.exe) }));
    return { total: statements.count.get().count, languages, apps };
  }

  function get(id) {
    requireOpen();
    flush();
    const row = statements.get.get(id);
    return row ? entryFromRow(row) : null;
  }

  function remove(id) {
    requireOpen();
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('history.delete requires a dictation id.');
    }
    flush();
    writeVersion += 1;
    return statements.remove.run(id).changes > 0;
  }

  /* VACUUM after a bulk delete: it returns the space, and it means deleted
     transcripts do not linger in free pages of the file. The WAL checkpoint
     first, because VACUUM cannot shrink what the WAL still references. */
  function compact() {
    if (!inMemory) db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    if (!inMemory) db.pragma('wal_checkpoint(TRUNCATE)');
  }

  function clear() {
    requireOpen();
    // Pending rows are part of "everything": discard rather than write them.
    queue.length = 0;
    writeVersion += 1;
    const removed = statements.removeAll.run().changes;
    // Rebuild drops any FTS segment data the per-row delete triggers left.
    db.exec("INSERT INTO dictations_fts (dictations_fts) VALUES ('rebuild')");
    compact();
    return removed;
  }

  function count() {
    requireOpen();
    flush();
    return statements.count.get().count;
  }

  /* Deletes rows older than the retention window and compacts if anything
     went. 0 days keeps everything. */
  function applyRetention(days = getRetentionDays()) {
    requireOpen();
    requireRetentionDays(days);
    lastRetentionAt = now();
    if (days === 0) return 0;
    flush();
    writeVersion += 1;
    const removed = statements.expire.run(now() - days * DAY_MS).changes;
    if (removed > 0) compact();
    return removed;
  }

  /* Retention is event-driven (Engine Spec hard rule 5: no polling timers).
     It runs at open, when the setting changes, and at most once a day after a
     flush — that last one is how a tray app that runs for weeks still
     expires old rows. */
  function maybeApplyRetention() {
    if (closed || now() - lastRetentionAt < RETENTION_CHECK_INTERVAL_MS) return;
    try {
      applyRetention();
    } catch (error) {
      warn(`retention failed (${error.code ?? error.message}).`);
    }
  }

  function close() {
    if (closed) return;
    flush();
    closed = true;
    db.close();
  }

  try {
    applyRetention();
  } catch (error) {
    warn(`retention at open failed (${error.code ?? error.message}).`);
  }

  /* Prepared on first use so a store opened with test migrations that lack the
     fix-count columns still opens. */
  let insightsApi = null;
  function insightsFor() {
    requireOpen();
    insightsApi ??= createInsights({ db, flush, version: () => writeVersion, now });
    return insightsApi;
  }
  const insights = Object.freeze({
    summary: (period) => insightsFor().summary(period),
    streak: () => insightsFor().streak(),
    byApp: (period) => insightsFor().byApp(period),
    byLanguage: (period) => insightsFor().byLanguage(period),
  });

  return Object.freeze({
    filePath,
    insights,
    append,
    recordOutcome,
    recent,
    search,
    facets,
    get,
    delete: remove,
    clear,
    count,
    flush,
    applyRetention,
    pendingWrites: () => queue.length,
    schemaVersion: () => currentSchemaVersion(db),
    close,
  });
}

module.exports = {
  MIGRATIONS,
  buildMatchExpression,
  countWords,
  createHistoryDatabase,
  foldForSearch,
  migrate,
};
