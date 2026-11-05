'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const insights = require('../src/renderer/views/insights');
const lib = require('../src/renderer/lib');

function data(overrides = {}) {
  const days = Array.from({ length: 90 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 6, 19 + i)).toISOString().slice(0, 10),
    count: i % 3 === 0 ? 2 : 0,
  }));
  return {
    period: { key: 'last30', label: 'Last 30 days', days: 30 },
    wpm: { median: 120, percentile: null, sampleSize: 4, scaleMax: 200 },
    fixes: { wordsChanged: 9, dictionaryCorrections: 2, dictationsTouched: 3 },
    words: { period: 40, allTime: 90 },
    dictations: { period: 4, allTime: 8 },
    byApp: [{ exe: 'Code.exe', label: 'Visual Studio Code', category: 'editor', dictations: 4, percent: 100 }],
    byLanguage: [{ code: 'en', label: 'English', dictations: 4, percent: 100 }],
    streak: { current: 1, longest: 3, activeDays: 30, windowDays: 90, days },
    ...overrides,
  };
}

test('body renders every figure from the data and never an invented percentile', () => {
  const html = insights.body({ lib }, data());
  assert.match(html, /Words fixed/);
  assert.match(html, /No percentile/);
  assert.doesNotMatch(html, /Top \d/);
  assert.doesNotMatch(html, /style=|box-shadow/);
});

test('a period with no timed dictation shows a dash and no gauge fill', () => {
  const html = insights.body({ lib }, data({
    wpm: { median: null, percentile: null, sampleSize: 0, scaleMax: 200 },
    byApp: [],
    byLanguage: [],
  }));
  assert.match(html, /No timed dictations in this period/);
  assert.match(html, /No dictations in this period/);
  assert.doesNotMatch(html, /gauge-value/);
});

test('a heatmap with no active days still lays out a full grid', () => {
  const empty = data();
  empty.streak = { ...empty.streak, current: 0, longest: 0, activeDays: 0,
    days: empty.streak.days.map((day) => ({ date: day.date, count: 0 })) };
  const html = insights.body({ lib }, empty);
  assert.equal((html.match(/heat-cell/g) || []).length >= 90, true);
  assert.doesNotMatch(html, /is-l[1-4]" title/);
});

test('fresh install gets one honest prompt, not a grid of zeroes', () => {
  const html = insights.emptyAll(lib);
  assert.match(html, /Start dictating/);
  assert.doesNotMatch(html, /heat-cell|gauge/);
});

test('the live shell has real period tabs and an empty body slot', () => {
  const live = insights.html({ lib, bridge: { insights: { summary() {} } } }, null);
  for (const key of ['last7', 'last30', 'all']) assert.match(live, new RegExp(`data-period="${key}"`));
  assert.match(live, /data-body/);
});
