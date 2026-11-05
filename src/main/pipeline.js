'use strict';

const { normaliseExecutable } = require('../shared/app-quirks');

const WORD_PATTERN = /[\p{L}\p{N}]+/gu;
const WORD_BOUNDARY_CLASS = '\\p{L}\\p{N}';

function phraseTokens(value) {
  if (typeof value !== 'string') return [];
  return value.match(WORD_PATTERN) ?? [];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/*
 * Speech recognition is inconsistent about commas, dashes, and pauses inside
 * a trigger. Treat any non-word run as a separator while keeping word
 * boundaries strict, so "work, email" matches "work email" but
 * "homework email" does not.
 */
function phraseRegExp(phrase) {
  const tokens = phraseTokens(phrase);
  if (tokens.length === 0) return null;
  const body = tokens.map(escapeRegExp).join(`[^${WORD_BOUNDARY_CLASS}]+`);
  return new RegExp(
    `(?<![${WORD_BOUNDARY_CLASS}])${body}(?![${WORD_BOUNDARY_CLASS}])`,
    'giu'
  );
}

function literalPhraseRegExp(phrase) {
  const tokens = phraseTokens(phrase);
  if (tokens.length === 0) return null;
  return new RegExp(
    `(?<![${WORD_BOUNDARY_CLASS}])${escapeRegExp(phrase)}(?![${WORD_BOUNDARY_CLASS}])`,
    'gu'
  );
}

function scopedToTarget(snippet, executable) {
  if (!snippet.appScope) return true;
  return normaliseExecutable(snippet.appScope) === normaliseExecutable(executable);
}

function expandSnippets(text, snippets = [], { executable } = {}) {
  if (typeof text !== 'string') {
    throw new TypeError('Snippet expansion requires text.');
  }

  const candidates = [];
  for (const [order, snippet] of snippets.entries()) {
    if (
      !snippet
      || typeof snippet.trigger !== 'string'
      || typeof snippet.expansion !== 'string'
      || !scopedToTarget(snippet, executable)
    ) {
      continue;
    }
    const pattern = phraseRegExp(snippet.trigger);
    if (!pattern) continue;
    for (const match of text.matchAll(pattern)) {
      candidates.push({
        start: match.index,
        end: match.index + match[0].length,
        order,
        snippet,
      });
    }
  }

  /*
   * Prefix conflicts share a start index. Sorting the wider source span first
   * makes the longest phrase win. The original list order is the stable final
   * tie-breaker, and replacements are selected against the original text so
   * an expansion can never recursively trigger another snippet.
   */
  candidates.sort(
    (left, right) =>
      left.start - right.start
      || (right.end - right.start) - (left.end - left.start)
      || right.snippet.trigger.length - left.snippet.trigger.length
      || left.order - right.order
  );

  const selected = [];
  let cursor = 0;
  for (const candidate of candidates) {
    if (candidate.start < cursor) continue;
    selected.push(candidate);
    cursor = candidate.end;
  }

  let expanded = '';
  cursor = 0;
  const matches = [];
  for (const candidate of selected) {
    expanded += text.slice(cursor, candidate.start);
    expanded += candidate.snippet.expansion;
    matches.push(Object.freeze({
      id: candidate.snippet.id ?? null,
      trigger: candidate.snippet.trigger,
      expansion: candidate.snippet.expansion,
      source: text.slice(candidate.start, candidate.end),
    }));
    cursor = candidate.end;
  }
  expanded += text.slice(cursor);

  return Object.freeze({
    text: expanded,
    matches: Object.freeze(matches),
  });
}

function comparable(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('und')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function levenshtein(left, right) {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1]
        + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        substitution
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function fuzzyThreshold(length) {
  if (length <= 4) return 1;
  if (length <= 8) return 2;
  if (length <= 14) return 3;
  return 4;
}

function countPhrase(text, phrase) {
  const pattern = phraseRegExp(phrase);
  if (!pattern) return 0;
  return [...text.matchAll(pattern)].length;
}

function countLiteralPhrase(text, phrase) {
  const pattern = literalPhraseRegExp(phrase);
  if (!pattern) return 0;
  return [...text.matchAll(pattern)].length;
}

function wordSpans(text) {
  return [...text.matchAll(WORD_PATTERN)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function activeDictionaryTerms(dictionaryTerms, language) {
  if (!Array.isArray(dictionaryTerms)) return [];
  return dictionaryTerms.filter((entry) => {
    if (!entry || typeof entry.term !== 'string' || entry.term.trim().length === 0) {
      return false;
    }
    if (entry.active === false) return false;
    const entryLanguage = entry.lang ?? entry.language;
    return !entryLanguage || !language || entryLanguage === language;
  });
}

function repairOneTerm(text, {
  id,
  term,
  soundsLike,
  sourceText,
  rawText,
}) {
  const canonical = term.trim();
  const canonicalComparable = comparable(canonical);
  if (!canonicalComparable) return { text, corrections: [] };

  const evidencePhrases = [canonical];
  if (typeof soundsLike === 'string' && soundsLike.trim()) {
    evidencePhrases.push(soundsLike.trim());
  }
  const evidenceCount = evidencePhrases.reduce(
    (total, phrase) => total + countPhrase(sourceText, phrase),
    0
  );
  const alreadyCorrect = countLiteralPhrase(text, canonical);
  const needed = Math.max(0, evidenceCount - alreadyCorrect);
  if (needed === 0) return { text, corrections: [] };

  const spans = wordSpans(text);
  const sizes = new Set();
  for (const phrase of evidencePhrases) {
    const count = phraseTokens(phrase).length;
    if (count > 0) {
      sizes.add(count);
      if (count > 1) sizes.add(count - 1);
      sizes.add(count + 1);
    }
  }

  const threshold = fuzzyThreshold(canonicalComparable.length);
  const candidates = [];
  for (let startIndex = 0; startIndex < spans.length; startIndex += 1) {
    for (const size of sizes) {
      const endIndex = startIndex + size - 1;
      if (endIndex >= spans.length) continue;
      const start = spans[startIndex].start;
      const end = spans[endIndex].end;
      const source = text.slice(start, end);
      const sourceComparable = comparable(source);
      if (
        !sourceComparable
        || (sourceComparable === canonicalComparable && source === canonical)
      ) {
        continue;
      }

      /*
       * An exact sounds-like match is how the recogniser mishears this term
       * ("deep C KPI" for "DeepSeek API"), so it is replaced however far its
       * spelling is from the term.
       */
      const isEvidence = evidencePhrases.some(
        (phrase) => comparable(phrase) === sourceComparable
      );
      const distance = isEvidence
        ? 0
        : levenshtein(sourceComparable, canonicalComparable);
      if (distance > threshold) continue;

      /*
       * A near word already present in the raw dictation is something the user
       * actually said differently. It is protected unless it is the explicit
       * spelling or sounds-like evidence for this dictionary entry.
       */
      if (!isEvidence && countPhrase(rawText, source) > 0) continue;

      candidates.push({ start, end, source, distance });
    }
  }

  candidates.sort(
    (left, right) =>
      left.distance - right.distance
      || left.start - right.start
      || (right.end - right.start) - (left.end - left.start)
  );

  const selected = [];
  for (const candidate of candidates) {
    if (selected.length >= needed) break;
    if (
      selected.some(
        (existing) =>
          candidate.start < existing.end && candidate.end > existing.start
      )
    ) {
      continue;
    }
    selected.push(candidate);
  }
  selected.sort((left, right) => left.start - right.start);

  let repaired = '';
  let cursor = 0;
  const corrections = [];
  for (const candidate of selected) {
    repaired += text.slice(cursor, candidate.start);
    repaired += canonical;
    corrections.push(Object.freeze({
      id: id ?? null,
      term: canonical,
      from: candidate.source,
      to: canonical,
    }));
    cursor = candidate.end;
  }
  repaired += text.slice(cursor);
  return { text: repaired, corrections };
}

function repairDictionary(
  text,
  dictionaryTerms = [],
  {
    sourceText = text,
    rawText = sourceText,
    language,
  } = {}
) {
  if (typeof text !== 'string') {
    throw new TypeError('Dictionary repair requires text.');
  }

  let repaired = text;
  const corrections = [];
  for (const entry of activeDictionaryTerms(dictionaryTerms, language)) {
    const result = repairOneTerm(repaired, {
      id: entry.id,
      term: entry.term,
      soundsLike: entry.soundsLike,
      sourceText,
      rawText,
    });
    repaired = result.text;
    corrections.push(...result.corrections);
  }

  return Object.freeze({
    text: repaired,
    corrections: Object.freeze(corrections),
  });
}

async function runPipeline({
  rawText,
  snippets = [],
  dictionaryTerms = [],
  language,
  target,
  cleanup,
} = {}) {
  if (typeof rawText !== 'string' || rawText.length === 0) {
    throw new TypeError('Pipeline rawText must be a non-empty string.');
  }
  if (typeof cleanup !== 'function') {
    throw new TypeError('Pipeline cleanup must be a function.');
  }

  const snippetResult = expandSnippets(rawText, snippets, {
    executable: target?.exe ?? target?.imagePath,
  });
  const cleanupResult = await cleanup(snippetResult.text, {
    dictionaryTerms,
    language,
    target,
  });
  if (!cleanupResult || typeof cleanupResult.text !== 'string' || !cleanupResult.text) {
    throw new TypeError('Pipeline cleanup returned no text.');
  }
  const dictionaryResult = repairDictionary(
    cleanupResult.text,
    dictionaryTerms,
    {
      sourceText: snippetResult.text,
      rawText,
      language,
    }
  );

  const stages = Object.freeze({
    raw: rawText,
    snippets: snippetResult.text,
    llm: cleanupResult.text,
    dictionary: dictionaryResult.text,
    final: dictionaryResult.text,
  });

  return Object.freeze({
    text: stages.final,
    stages,
    cleanup: cleanupResult,
    snippetMatches: snippetResult.matches,
    dictionaryCorrections: dictionaryResult.corrections,
  });
}

module.exports = {
  expandSnippets,
  levenshtein,
  repairDictionary,
  runPipeline,
};
