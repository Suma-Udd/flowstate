'use strict';

/* The dictionary's prompt cost — shared so the Dictionary screen's "prompt
   characters used" figure is never a guess at what the prompt builder
   actually sends.

   formatDictionaryEntry mirrors dictionaryLine() in src/main/prompt.js:
   `- "term"`, or
   `- "term" (may be heard as "soundsLike")`. If that formatting ever changes,
   change it here too — a screen and the prompt it describes disagreeing is
   worse than either being wrong alone.

   One deliberate simplification: prompt.js caps the *entire* system prompt
   (safety rules + target-app profile + dictionary) at maxChars, so a
   dictionary's real headroom is `maxChars` minus everything else already
   sent, not the full budget below. DICTIONARY_PROMPT_CHAR_CAP mirrors
   prompt.js's DEFAULT_MAX_PROMPT_CHARS so the two numbers do not drift by
   accident, but "chars" here is only the dictionary block's own size, not a
   claim that this many characters are actually free. */

const DICTIONARY_PROMPT_CHAR_CAP = 2000;
const DICTIONARY_WARN_AT_TERMS = 60;

function formatDictionaryEntry(term) {
  const spelling = JSON.stringify(term.term);
  if (!term.soundsLike) return `- ${spelling}`;
  return `- ${spelling} (may be heard as ${JSON.stringify(term.soundsLike)})`;
}

function buildDictionaryPromptBlock(terms) {
  return terms.map(formatDictionaryEntry).join('\n');
}

function computeDictionaryBudget(terms) {
  return Object.freeze({
    terms: terms.length,
    chars: buildDictionaryPromptBlock(terms).length,
    capChars: DICTIONARY_PROMPT_CHAR_CAP,
    warnAtTerms: DICTIONARY_WARN_AT_TERMS,
  });
}

module.exports = {
  DICTIONARY_PROMPT_CHAR_CAP,
  DICTIONARY_WARN_AT_TERMS,
  formatDictionaryEntry,
  buildDictionaryPromptBlock,
  computeDictionaryBudget,
};
