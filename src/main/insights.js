'use strict';

/*
 * Insights aggregation (#30). Every number on the Insights screen is computed
 * here, in SQL, from the dictations table. Nothing is estimated: a figure the
 * data cannot support (a WPM percentile has no honest population) is absent.
 *
 * "Fixes made" are counted from the stored text, not guessed. At write time
 * db.js diffs the stages with fixCounts() and stores the counts in
 * words_changed / dict_corrections (migration 2), so reading them is a SUM.
 *
 * Days are local calendar days: SQLite's 'localtime' modifier and the JS Date
 * constructor agree on the process time zone, so a dictation at 00:30 counts
 * for the day the user saw on the clock.
 *
 * Results are cached per (query, local day) and dropped whenever the store
 * reports a write through version(), so navigating to Insights never rescans
 * the table unless something changed.
 */

const HEATMAP_DAYS = 90;
const GAUGE_FLOOR = 200;
const GAUGE_STEP = 50;
const DIFF_CELL_LIMIT = 4_000_000;

const PERIODS = Object.freeze({
  last7: Object.freeze({ key: 'last7', label: 'Last 7 days', days: 7 }),
  last30: Object.freeze({ key: 'last30', label: 'Last 30 days', days: 30 }),
  all: Object.freeze({ key: 'all', label: 'All time', days: null }),
});

const KNOWN_APPS = Object.freeze({
  code: ['Visual Studio Code', 'editor'],
  'code - insiders': ['VS Code Insiders', 'editor'],
  cursor: ['Cursor', 'editor'],
  devenv: ['Visual Studio', 'editor'],
  idea64: ['IntelliJ IDEA', 'editor'],
  chrome: ['Google Chrome', 'browser'],
  msedge: ['Microsoft Edge', 'browser'],
  firefox: ['Firefox', 'browser'],
  opera: ['Opera', 'browser'],
  brave: ['Brave', 'browser'],
  discord: ['Discord', 'chat'],
  slack: ['Slack', 'chat'],
  telegram: ['Telegram', 'chat'],
  whatsapp: ['WhatsApp', 'chat'],
  teams: ['Microsoft Teams', 'chat'],
  obsidian: ['Obsidian', 'notes'],
  notepad: ['Notepad', 'notes'],
  onenote: ['OneNote', 'notes'],
  notion: ['Notion', 'notes'],
  windowsterminal: ['Windows Terminal', 'terminal'],
  powershell: ['PowerShell', 'terminal'],
  pwsh: ['PowerShell', 'terminal'],
  cmd: ['Command Prompt', 'terminal'],
});

const LANGUAGE_LABELS = Object.freeze({ en: 'English', de: 'Deutsch', el: 'Ελληνικά' });

function tokens(text) {
  return typeof text === 'string' ? text.split(/\s+/).filter(Boolean) : [];
}

/* Word-level edit distance between two texts: how many words were replaced,
   inserted or removed to turn `from` into `to`. The shared head and tail are
   trimmed first, so a long dictation with one fix costs almost nothing. */
function wordsChanged(from, to) {
  const a = tokens(from);
  const b = tokens(to);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0) return m;
  if (m === 0) return n;
  // Pathologically long and different: the larger side is the true upper bound.
  if (n * m > DIFF_CELL_LIMIT) return Math.max(n, m);

  let previous = new Array(m + 1);
  let current = new Array(m + 1);
  for (let j = 0; j <= m; j += 1) previous[j] = j;
  for (let i = 1; i <= n; i += 1) {
    current[0] = i;
    for (let j = 1; j <= m; j += 1) {
      const cost = a[start + i - 1] === b[start + j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[m];
}

/* The two fix counts for one row. Cleanup is measured from the text after
   snippet expansion (an expanded snippet is the user's own doing, not a fix)
   to the final cleaned text; dictionary corrections from the text the
   dictionary stage received to what it produced. */
function fixCounts(row) {
  const raw = row.raw_text;
  const snippets = row.snippet_text;
  const base = snippets ?? raw;
  const dictionaryInput = row.llm_text ?? snippets ?? raw;
  return {
    words_changed: wordsChanged(base, row.cleaned_text),
    dict_corrections: row.dictionary_text == null
      ? 0
      : wordsChanged(dictionaryInput, row.dictionary_text),
  };
}

function labelForApp(exe) {
  if (typeof exe !== 'string' || exe.length === 0) {
    return { label: 'Unknown app', category: 'other' };
  }
  const stem = exe.replace(/\.exe$/i, '');
  const known = KNOWN_APPS[stem.toLowerCase()];
  return known ? { label: known[0], category: known[1] } : { label: stem, category: 'other' };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function localDayString(ms) {
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/* Start of the local day `daysBack` days before the day containing `ms`. */
function startOfLocalDay(ms, daysBack = 0) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - daysBack).getTime();
}

function createInsights({ db, flush = () => {}, version = () => 0, now = Date.now } = {}) {
  if (!db) throw new TypeError('createInsights requires a database.');

  const DAY_SQL = "strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime')";
  const sql = {
    totals: db.prepare(`
      SELECT COUNT(*) AS dictations,
             COALESCE(SUM(word_count), 0) AS words,
             COALESCE(SUM(words_changed), 0) AS words_changed,
             COALESCE(SUM(dict_corrections), 0) AS dict_corrections,
             COALESCE(SUM(CASE WHEN words_changed > 0 THEN 1 ELSE 0 END), 0) AS touched
      FROM dictations WHERE created_at >= @from`),
    // The one or two middle values; averaging them gives the median.
    middle: db.prepare(`
      SELECT wpm FROM dictations
      WHERE created_at >= @from AND wpm IS NOT NULL
      ORDER BY wpm
      LIMIT 2 - (SELECT COUNT(*) FROM dictations WHERE created_at >= @from AND wpm IS NOT NULL) % 2
      OFFSET (SELECT (COUNT(*) - 1) / 2 FROM dictations WHERE created_at >= @from AND wpm IS NOT NULL)`),
    wpmCount: db.prepare(
      'SELECT COUNT(*) AS n FROM dictations WHERE created_at >= @from AND wpm IS NOT NULL'),
    byApp: db.prepare(`
      SELECT MIN(app_exe) AS exe, COUNT(*) AS dictations
      FROM dictations WHERE created_at >= @from
      GROUP BY LOWER(COALESCE(app_exe, ''))
      ORDER BY dictations DESC, MIN(app_exe) IS NULL, LOWER(exe)`),
    byLanguage: db.prepare(`
      SELECT language AS code, COUNT(*) AS dictations
      FROM dictations WHERE created_at >= @from AND language IS NOT NULL
      GROUP BY language
      ORDER BY dictations DESC, code`),
    perDay: db.prepare(`
      SELECT ${DAY_SQL} AS day, COUNT(*) AS count
      FROM dictations WHERE created_at >= @from
      GROUP BY day ORDER BY day`),
    // Gaps-and-islands: consecutive local days share day-number minus rank.
    islands: db.prepare(`
      WITH d AS (SELECT DISTINCT ${DAY_SQL} AS day FROM dictations),
           g AS (SELECT day, julianday(day) - ROW_NUMBER() OVER (ORDER BY day) AS grp FROM d)
      SELECT MIN(day) AS start, MAX(day) AS end, COUNT(*) AS length
      FROM g GROUP BY grp ORDER BY end`),
  };

  let cache = new Map();
  let cacheStamp = null;

  function cached(key, compute) {
    flush();
    const stamp = `${version()}|${localDayString(now())}`;
    if (stamp !== cacheStamp) {
      cache = new Map();
      cacheStamp = stamp;
    }
    if (!cache.has(key)) cache.set(key, compute());
    return cache.get(key);
  }

  function periodFor(period = 'last30') {
    const resolved = typeof period === 'string' ? PERIODS[period] : undefined;
    if (!resolved) throw new TypeError('insights period must be last7, last30 or all.');
    return resolved;
  }

  function fromFor(period) {
    return period.days === null ? 0 : startOfLocalDay(now(), period.days - 1);
  }

  function median(from) {
    const n = sql.wpmCount.get({ from }).n;
    if (n === 0) return { median: null, sampleSize: 0 };
    const rows = sql.middle.all({ from });
    const value = rows.reduce((sum, row) => sum + row.wpm, 0) / rows.length;
    return { median: round1(value), sampleSize: n };
  }

  function summary(periodKey) {
    const period = periodFor(periodKey);
    return cached(`summary:${period.key}`, () => {
      const from = fromFor(period);
      const inPeriod = sql.totals.get({ from });
      const allTime = sql.totals.get({ from: 0 });
      const speed = median(from);
      const scaleMax = speed.median === null
        ? GAUGE_FLOOR
        : Math.max(GAUGE_FLOOR, (Math.floor(speed.median / GAUGE_STEP) + 1) * GAUGE_STEP);
      return Object.freeze({
        period: Object.freeze({ key: period.key, label: period.label, days: period.days }),
        // percentile stays null: there is no population to rank one person against.
        wpm: Object.freeze({
          median: speed.median,
          percentile: null,
          sampleSize: speed.sampleSize,
          scaleMax,
        }),
        fixes: Object.freeze({
          wordsChanged: inPeriod.words_changed,
          dictionaryCorrections: inPeriod.dict_corrections,
          dictationsTouched: inPeriod.touched,
        }),
        words: Object.freeze({ period: inPeriod.words, allTime: allTime.words }),
        dictations: Object.freeze({
          period: inPeriod.dictations,
          allTime: allTime.dictations,
        }),
      });
    });
  }

  function byApp(periodKey) {
    const period = periodFor(periodKey);
    return cached(`app:${period.key}`, () => {
      const rows = sql.byApp.all({ from: fromFor(period) });
      const total = rows.reduce((sum, row) => sum + row.dictations, 0);
      return Object.freeze(rows.map((row) => {
        const { label, category } = labelForApp(row.exe);
        return Object.freeze({
          exe: row.exe,
          label,
          category,
          dictations: row.dictations,
          percent: round1((row.dictations / total) * 100),
        });
      }));
    });
  }

  function byLanguage(periodKey) {
    const period = periodFor(periodKey);
    return cached(`lang:${period.key}`, () => {
      const rows = sql.byLanguage.all({ from: fromFor(period) });
      const total = rows.reduce((sum, row) => sum + row.dictations, 0);
      return Object.freeze(rows.map((row) => Object.freeze({
        code: row.code,
        label: LANGUAGE_LABELS[row.code] ?? row.code,
        dictations: row.dictations,
        percent: round1((row.dictations / total) * 100),
      })));
    });
  }

  function streak() {
    return cached('streak', () => {
      const todayString = localDayString(now());
      const yesterdayString = localDayString(startOfLocalDay(now(), 1));
      const islands = sql.islands.all();
      const longest = islands.reduce((best, island) => Math.max(best, island.length), 0);
      const last = islands[islands.length - 1];
      // Today may not have happened yet: a streak that ended yesterday is alive.
      const alive = last && (last.end === todayString || last.end === yesterdayString);
      const current = alive ? last.length : 0;

      const counts = new Map(
        sql.perDay
          .all({ from: startOfLocalDay(now(), HEATMAP_DAYS - 1) })
          .map((row) => [row.day, row.count])
      );
      const days = [];
      for (let back = HEATMAP_DAYS - 1; back >= 0; back -= 1) {
        const date = localDayString(startOfLocalDay(now(), back));
        days.push(Object.freeze({ date, count: counts.get(date) ?? 0 }));
      }
      return Object.freeze({
        current,
        longest,
        activeDays: days.filter((day) => day.count > 0).length,
        windowDays: HEATMAP_DAYS,
        days: Object.freeze(days),
      });
    });
  }

  return Object.freeze({ summary, streak, byApp, byLanguage });
}

module.exports = {
  HEATMAP_DAYS,
  PERIODS,
  createInsights,
  fixCounts,
  labelForApp,
  wordsChanged,
};
