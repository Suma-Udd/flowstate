'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inferTranscriptLanguage } = require('../src/worker/asr');

test('everyday English sentences are English, not unknown', () => {
  for (const text of [
    'So can you hear me right now?',
    'Okay, so I was thinking we could meet tomorrow.',
    'The deadline is Friday',
    "I don't think that's going to work.",
  ]) {
    assert.equal(inferTranscriptLanguage(text), 'en', text);
  }
});

test('everyday German sentences are German, including umlaut-only cues', () => {
  for (const text of [
    'Ich teste heute die Spracherkennung mit einem klaren deutschen Satz.',
    'Kannst du mir bitte die Datei schicken?',
    'Das ist gut',
    'Schöne Grüße',
  ]) {
    assert.equal(inferTranscriptLanguage(text), 'de', text);
  }
});

test('Greek script is Greek', () => {
  assert.equal(inferTranscriptLanguage('Γεια σου, τι κάνεις σήμερα;'), 'el');
});

test('words both languages share never decide the language on their own', () => {
  assert.equal(inferTranscriptLanguage('Okay also so'), '');
  assert.equal(inferTranscriptLanguage('Samuel Flowstate'), '');
  assert.equal(inferTranscriptLanguage(''), '');
});

test('a Spanish-looking mishearing with one stray English word stays unknown', () => {
  assert.equal(
    inferTranscriptLanguage('Ora tour eletría por eso perdonas que no se ponen o tema. Tiene que.'),
    ''
  );
});
