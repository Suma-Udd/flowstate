'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  buildBpeVocabText,
  buildStreamHotwords,
  ensureBpeVocab,
  normaliseHotwordTerms,
} = require('../src/worker/hotwords');

const TAB = String.fromCharCode(9);

test('buildBpeVocabText turns "piece id" lines into "piece<TAB>-id"', () => {
  const text = buildBpeVocabText(['<unk> 0', '▁De 838', '▁ 5', 'junk', 'x notanumber', ''].join('\n'));
  assert.deepEqual(text.trimEnd().split('\n'), [
    `<unk>${TAB}0`,
    `▁De${TAB}-838`,
    `▁${TAB}-5`,
  ]);
  assert.ok(text.endsWith('\n'));
  assert.equal(buildBpeVocabText(''), '');
});

test('normaliseHotwordTerms dedupes and strips sherpa syntax characters', () => {
  assert.deepEqual(
    normaliseHotwordTerms([
      { term: ' DeepSeek ' }, 'DeepSeek', { term: 'a/b:c' }, { term: 'Visual  Studio' },
      { term: '' }, { term: 42 }, null, { term: 'x'.repeat(101) },
    ]),
    ['DeepSeek', 'a b c', 'Visual Studio'],
  );
  assert.deepEqual(normaliseHotwordTerms(undefined), []);
});

test('normaliseHotwordTerms caps the list', () => {
  const many = Array.from({ length: 500 }, (_, i) => `term${i}`);
  assert.equal(normaliseHotwordTerms(many).length, 200);
});

test('buildStreamHotwords joins phrases with a slash and is empty for none', () => {
  assert.equal(buildStreamHotwords([{ term: 'DeepSeek' }, { term: 'Visual Studio' }]), 'DeepSeek/Visual Studio');
  assert.equal(buildStreamHotwords([]), '');
});

test('ensureBpeVocab writes once and rewrites only when tokens change', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flowstate-bpe-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'tokens.txt'), '<unk> 0\nab 1\n', 'utf8');
  const filePath = path.join(dir, 'hotwords', 'bpe.vocab');
  assert.equal(await ensureBpeVocab({ modelDirectory: dir, filePath }), filePath);
  assert.equal(await fs.readFile(filePath, 'utf8'), `<unk>${TAB}0\nab${TAB}-1\n`);
  const first = (await fs.stat(filePath)).mtimeMs;
  await ensureBpeVocab({ modelDirectory: dir, filePath });
  assert.equal((await fs.stat(filePath)).mtimeMs, first);
  await fs.writeFile(path.join(dir, 'tokens.txt'), '<unk> 0\nab 1\ncd 2\n', 'utf8');
  await ensureBpeVocab({ modelDirectory: dir, filePath });
  assert.match(await fs.readFile(filePath, 'utf8'), /cd/u);
});

test('ensureBpeVocab rejects an empty tokens file', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flowstate-bpe-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'tokens.txt'), '', 'utf8');
  await assert.rejects(
    ensureBpeVocab({ modelDirectory: dir, filePath: path.join(dir, 'bpe.vocab') }),
    /no usable pieces/u,
  );
});
