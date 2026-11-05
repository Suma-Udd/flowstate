'use strict';

/**
 * The last line of defence for gate G3's zero-invention rule. The prompt
 * tells the model to edit, never to answer, but G3 dictation #26 showed it
 * can still reply ("I'm sorry, but the text you've provided appears to be in
 * Spanish...") and that reply was pasted as if the user had said it.
 *
 * A cleanup is accepted only when it is recognisably the same words: most of
 * the output's words must already be in the transcript, and its length must
 * stay close. Cleanup legitimately adds punctuation and capitals, drops
 * fillers and fixes a few spellings, so the bar is generous; a reply,
 * translation or refusal fails it by a wide margin. Rejection means the raw
 * transcript pastes instead, which is always safe.
 */

const MIN_SHARED_WORDS = 0.7;
const MIN_LENGTH_RATIO = 0.4;
const MAX_LENGTH_RATIO = 1.3;
const MIN_NOVEL_WORD_LENGTH = 4;

const ASSISTANT_PHRASES = [
  /\bI['’]m sorry\b/i,
  /\bI (?:can(?:no|['’])t|am unable to|will not|won['’]t)\b/i,
  /\bas an AI\b/i,
  /\bthe (?:text|transcript) (?:you(?:['’]ve)?|that you)\b/i,
  /\bhere(?: is|['’]s) the (?:cleaned|edited|corrected|revised)\b/i,
  /\bplease (?:share|provide)\b/i,
];

// Grammar and spelling fixes change a letter or two ("Hello" -> "Hallo",
// "mir" -> "mich"); a reply or translation changes the words outright.
const MAX_WORD_EDITS = 2;

function withinEdits(left, right, limit = MAX_WORD_EDITS) {
  if (Math.abs(left.length - right.length) > limit) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMinimum = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      rowMinimum = Math.min(rowMinimum, current[j]);
    }
    if (rowMinimum > limit) return false;
    previous = current;
  }
  return previous[right.length] <= limit;
}

// Closed-class words carry grammar, not content, so cleanup may add them
// ("only typing" -> "only being typed"). Nothing a user could be misquoted
// as having said lives in this list.
const GRAMMAR_WORDS = new Set(`
  being been have having does that this these those with from into than
  then when which will would should could their there they them were
  dass einen einem einer eine sein sind wird wurde haben habe wenn dann
  auch noch schon dieser diese dieses
`.trim().split(/\s+/u));

// Inflection: "typing" -> "typed", "Satz" -> "Sätze" share a stem.
function sharesStem(left, right) {
  if (left.length < 5 || right.length < 5) return false;
  return left.slice(0, 3) === right.slice(0, 3)
    && Math.abs(left.length - right.length) <= 3;
}

function words(text) {
  return (String(text).toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

// Contractions kept whole with the apostrophe dropped: "what's" -> "whats",
// so "what's ever" can be recognised as the spoken form of "whatever".
function compactWords(text) {
  return (String(text).toLocaleLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [])
    .map((word) => word.replace(/['’]/gu, ''));
}

// Cleanup writes spoken numbers as digits ("twenty twenty five" -> "2025",
// "twenty first" -> "21st"). That is formatting, not invention, but only
// when the speaker actually said a number.
const NUMBER_WORDS = new Set(`
  zero one two three four five six seven eight nine ten eleven twelve
  thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty
  thirty forty fifty sixty seventy eighty ninety hundred thousand million
  billion first second third fourth fifth sixth seventh eighth ninth tenth
  null eins zwei drei vier fünf sechs sieben acht neun zehn elf zwölf
  zwanzig dreißig vierzig fünfzig hundert tausend
`.trim().split(/\s+/u));

function hasDigit(word) {
  return /\p{N}/u.test(word);
}

function unique(list) {
  return [...new Set(list)];
}

function dictionaryWords(terms) {
  if (!Array.isArray(terms)) return [];
  return terms.flatMap((entry) => words(typeof entry === 'string' ? entry : entry?.term ?? ''));
}

function checkCleanup(rawText, cleanedText, { dictionaryTerms = [] } = {}) {
  const source = words(rawText);
  const output = words(cleanedText);
  if (source.length === 0 || output.length === 0) {
    return { ok: false, reason: 'empty' };
  }

  // A phrase is only suspicious when the user did not say it themselves.
  const rawLower = String(rawText).toLocaleLowerCase();
  for (const pattern of ASSISTANT_PHRASES) {
    if (pattern.test(cleanedText) && !pattern.test(rawLower)) {
      return {
        ok: false,
        reason: 'assistant-reply',
        words: [String(cleanedText).match(pattern)[0]],
      };
    }
  }

  const ratio = output.length / source.length;
  const detail = { rawWords: source.length, outputWords: output.length };
  if (ratio < MIN_LENGTH_RATIO || ratio > MAX_LENGTH_RATIO) {
    return { ok: false, reason: 'length-changed', words: [], ...detail };
  }

  // Dictionary spellings are words the user chose, so the model may write
  // them even when the recogniser heard something else ("deep C" -> DeepSeek).
  const vocabulary = new Set([...source, ...dictionaryWords(dictionaryTerms)]);
  // "flow state" -> "Flowstate": two adjacent spoken words joined.
  // Also across a contraction ("what's ever" -> "whatever", one edit away).
  const compact = compactWords(rawText);
  const joined = [
    ...source.slice(1).map((word, index) => source[index] + word),
    ...compact.slice(1).map((word, index) => compact[index] + word),
  ];
  const joinedSet = new Set(joined);
  const spokeNumber = source.some((word) => hasDigit(word) || NUMBER_WORDS.has(word));
  const said = (word) =>
    vocabulary.has(word)
    || joinedSet.has(word)
    || joined.some((pair) => withinEdits(word, pair, 1))
    || source.some((spoken) => withinEdits(word, spoken) || sharesStem(word, spoken));
  const unsaid = output.filter((word) => !said(word));
  if ((output.length - unsaid.length) / output.length < MIN_SHARED_WORDS) {
    return { ok: false, reason: 'words-changed', words: unique(unsaid), ...detail };
  }

  // Zero tolerance for invented content: one new real word ("Paris" in an
  // answered question) is enough. Short words are exempt because cleanup
  // legitimately adds them ("a", "to" in "going to", "OK").
  const invented = (word) =>
    word.length >= MIN_NOVEL_WORD_LENGTH
    && !GRAMMAR_WORDS.has(word)
    && !(spokeNumber && hasDigit(word))
    && !said(word);
  const novel = output.filter(invented);
  if (novel.length > 0) {
    return { ok: false, reason: 'new-word', words: unique(novel), ...detail };
  }

  return { ok: true, reason: null };
}

module.exports = {
  MAX_LENGTH_RATIO,
  MIN_LENGTH_RATIO,
  MIN_SHARED_WORDS,
  checkCleanup,
};
