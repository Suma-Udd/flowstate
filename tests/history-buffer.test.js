'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHistoryBuffer } = require('../src/main/history-buffer');

test('the pre-database history buffer is newest-first, bounded, and immutable', async () => {
  const history = createHistoryBuffer({ limit: 2 });
  const first = { text: 'first' };
  await history.append(first);
  first.text = 'changed outside';
  await history.append({ text: 'second' });
  await history.append({ text: 'third' });

  assert.deepEqual(
    history.recent().map((entry) => entry.text),
    ['third', 'second']
  );
  assert.ok(history.recent().every(Object.isFrozen));
});

test('clear() empties the buffer and count() reports its size', async () => {
  const history = createHistoryBuffer({ limit: 10 });
  assert.equal(history.count(), 0);

  await history.append({ text: 'first' });
  await history.append({ text: 'second' });
  assert.equal(history.count(), 2);

  history.clear();
  assert.equal(history.count(), 0);
  assert.deepEqual(history.recent(), []);
});
