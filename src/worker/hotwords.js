'use strict';

/* Hotwords for Parakeet's modified_beam_search.
   Measured on 2026-10-17 (see CHANGELOG.md): writing terms as sentencepiece
   pieces does nothing, because sherpa splits the U+2581 word marker off every
   piece ("▁De" becomes "▁" + "De", and "De" is not in tokens.txt), so the
   lines never match what the model emits. What works is sherpa's own bpe mode:
   a bpe.vocab ("piece<TAB>score") next to modelingUnit 'bpe', after which a
   hotword is just the plain term. Parakeet ships no bpe.vocab, so one is
   derived from tokens.txt, using the negated token id as the score: a
   sentencepiece unigram vocabulary lists its pieces best-first, so the id is a
   usable proxy for the score. Terms travel per stream (createStream(hotwords)),
   so a dictionary change needs no recogniser rebuild. */

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_TERMS = 200;
const MAX_TERM_LENGTH = 100;
// Tuned on the TTS bench: 0.5-1.0 gave the best hit rate with zero terms
// injected into control sentences; 3 started to inject, 5 wrecked WER.
const DEFAULT_HOTWORDS_SCORE = 1.0;
const TAB = String.fromCharCode(9);
const NEWLINE = String.fromCharCode(10);

/** "piece id" per line -> "piece<TAB>-id" per line. The piece is everything
 * before the last space; malformed lines are skipped. */
function buildBpeVocabText(tokensText) {
  const lines = [];
  for (const raw of String(tokensText).split(NEWLINE)) {
    const line = raw.trim();
    const cut = line.lastIndexOf(' ');
    if (cut <= 0) continue;
    const id = Number(line.slice(cut + 1));
    if (!Number.isInteger(id) || id < 0) continue;
    lines.push(`${line.slice(0, cut)}${TAB}${-id}`);
  }
  return lines.length > 0 ? lines.join(NEWLINE) + NEWLINE : '';
}

/** Dictionary terms (strings or { term } objects) -> clean, unique hotword
 * phrases. "/" separates hotwords and ":" introduces a score in sherpa's
 * per-stream syntax, so neither may appear inside a phrase. */
function normaliseHotwordTerms(terms) {
  const seen = new Set();
  const result = [];
  for (const entry of Array.isArray(terms) ? terms : []) {
    const raw = typeof entry === 'string' ? entry : entry?.term;
    if (typeof raw !== 'string') continue;
    const phrase = raw.replace(/[/:\r\n\t]+/gu, ' ').replace(/\s+/gu, ' ').trim();
    if (!phrase || phrase.length > MAX_TERM_LENGTH || seen.has(phrase)) continue;
    seen.add(phrase);
    result.push(phrase);
    if (result.length >= MAX_TERMS) break;
  }
  return result;
}

/** The string sherpa's createStream(hotwords) takes, or '' for none. */
function buildStreamHotwords(terms) {
  return normaliseHotwordTerms(terms).join('/');
}

/** Writes <modelsDirectory>/hotwords/bpe.vocab unless it is already current,
 * and returns its path. */
async function ensureBpeVocab({ modelDirectory, filePath }) {
  const text = buildBpeVocabText(
    await fs.readFile(path.join(modelDirectory, 'tokens.txt'), 'utf8')
  );
  if (!text) throw new Error('tokens.txt has no usable pieces.');
  let current = null;
  try {
    current = await fs.readFile(filePath, 'utf8');
  } catch {
    // missing: written below
  }
  if (current !== text) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, text, 'utf8');
  }
  return filePath;
}

module.exports = {
  DEFAULT_HOTWORDS_SCORE,
  buildBpeVocabText,
  buildStreamHotwords,
  ensureBpeVocab,
  normaliseHotwordTerms,
};
