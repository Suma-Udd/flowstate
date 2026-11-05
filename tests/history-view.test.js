'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const history = require('../src/renderer/views/history');
const lib = require('../src/renderer/lib');

const esc = lib.esc;

test('highlight marks accent- and case-insensitive word prefixes, like the index in the original text', () => {
  const terms = history.queryTerms('grusse HALL');
  assert.equal(
    history.highlight(esc, 'Grüße an Hallo Welt', terms),
    '<mark class="hit">Grüße</mark> an <mark class="hit">Hall</mark>o Welt'
  );
});

test('highlight escapes markup and ignores a query with no usable terms', () => {
  assert.equal(
    history.highlight(esc, '<b>x</b>', history.queryTerms('x')),
    '&lt;b&gt;<mark class="hit">x</mark>&lt;/b&gt;'
  );
  assert.equal(history.highlight(esc, 'a & b', history.queryTerms('"" *')), 'a &amp; b');
});

test('days are labelled Today and Yesterday relative to now', () => {
  const now = Date.parse('2026-10-17T12:00:00');
  assert.equal(history.dayLabel('2026-10-17T08:00:00', now), 'Today');
  assert.equal(history.dayLabel('2026-10-16T23:00:00', now), 'Yesterday');
  assert.notEqual(history.dayLabel('2026-10-10T08:00:00', now), 'Today');
});

test('the live shell renders when a bridge with facets exists', () => {
  const live = history.html({ lib, bridge: { history: { facets() {} } } }, null);
  assert.match(live, /data-search/);
  assert.match(live, /data-retention/);
  assert.doesNotMatch(live, /style=|box-shadow/);
});
