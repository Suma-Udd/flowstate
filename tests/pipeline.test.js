'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  expandSnippets,
  repairDictionary,
  runPipeline,
} = require('../src/main/pipeline');

test('snippet triggers are case-insensitive, whole-phrase, punctuation-tolerant, and longest-match-first', () => {
  const snippets = [
    {
      id: 'short',
      trigger: 'status update',
      expansion: 'SHORT',
      appScope: null,
    },
    {
      id: 'long',
      trigger: 'status update template',
      expansion: 'LONG',
      appScope: null,
    },
  ];

  const result = expandSnippets(
    'Use STATUS, update template; leave homework status updater alone.',
    snippets
  );

  assert.equal(
    result.text,
    'Use LONG; leave homework status updater alone.'
  );
  assert.deepEqual(
    result.matches.map((match) => match.id),
    ['long']
  );
});

test('snippet expansion respects executable scope and never recursively expands inserted text', () => {
  const snippets = [
    {
      id: 'scoped',
      trigger: 'work signoff',
      expansion: 'second trigger',
      appScope: 'Code.exe',
    },
    {
      id: 'recursive',
      trigger: 'second trigger',
      expansion: 'must not appear',
      appScope: null,
    },
  ];

  assert.equal(
    expandSnippets('Work signoff.', snippets, { executable: 'C:\\Apps\\Code.exe' }).text,
    'second trigger.'
  );
  assert.equal(
    expandSnippets('Work signoff.', snippets, { executable: 'notepad.exe' }).text,
    'Work signoff.'
  );
});

test('dictionary repair restores an evidenced near-miss and exact casing', () => {
  const dictionary = [{ term: 'Samuel', soundsLike: null, lang: 'en' }];

  assert.equal(
    repairDictionary(
      'Samul approved it.',
      dictionary,
      {
        sourceText: 'Samuel approved it.',
        rawText: 'Samuel approved it.',
        language: 'en',
      }
    ).text,
    'Samuel approved it.'
  );
  assert.equal(
    repairDictionary(
      'samuel approved it.',
      dictionary,
      {
        sourceText: 'Samuel approved it.',
        rawText: 'Samuel approved it.',
        language: 'en',
      }
    ).text,
    'Samuel approved it.'
  );
});

test('dictionary repair never changes a near word the user actually said differently', () => {
  const result = repairDictionary(
    'Please invite Summer tomorrow.',
    [{ term: 'Samuel', soundsLike: null, lang: 'en' }],
    {
      sourceText: 'Please invite Summer tomorrow.',
      rawText: 'Please invite Summer tomorrow.',
      language: 'en',
    }
  );

  assert.equal(result.text, 'Please invite Summer tomorrow.');
  assert.deepEqual(result.corrections, []);
});

test('full pipeline expands snippets before cleanup and repairs dictionary after cleanup', async () => {
  const calls = [];
  const result = await runPipeline({
    rawText: 'Use release shortcut for Samuel.',
    snippets: [
      {
        id: 'release',
        trigger: 'release shortcut',
        expansion: 'the release checklist',
        appScope: null,
      },
    ],
    dictionaryTerms: [
      { term: 'Samuel', soundsLike: null, lang: 'en' },
    ],
    language: 'en',
    target: { exe: 'Code.exe' },
    async cleanup(text) {
      calls.push(text);
      return {
        text: 'Use the release checklist for Samul.',
        cleanupApplied: true,
        provider: 'test',
        model: 'test',
        reason: 'cleaned',
        llmMs: 1,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  });

  assert.deepEqual(calls, ['Use the release checklist for Samuel.']);
  assert.deepEqual(result.stages, {
    raw: 'Use release shortcut for Samuel.',
    snippets: 'Use the release checklist for Samuel.',
    llm: 'Use the release checklist for Samul.',
    dictionary: 'Use the release checklist for Samuel.',
    final: 'Use the release checklist for Samuel.',
  });
  assert.equal(result.text, 'Use the release checklist for Samuel.');
  assert.deepEqual(
    result.dictionaryCorrections.map(({ from, to }) => ({ from, to })),
    [{ from: 'Samul', to: 'Samuel' }]
  );
});

test('an exact sounds-like phrase is repaired even when it is spelled far from the term', () => {
  const result = repairDictionary("It's running the deep C KPI anyways.", [
    { id: 'deepseek', term: 'DeepSeek API', soundsLike: 'deep C KPI' },
  ]);
  assert.equal(result.text, "It's running the DeepSeek API anyways.");
  assert.deepEqual(result.corrections.map((entry) => entry.from), ['deep C KPI']);
});
