'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fixtures = require('./fixtures/prompt-cases.json');
const {
  APP_PROFILES,
  DEFAULT_APP_PROFILE,
  getAppProfile,
} = require('../src/shared/app-profiles');
const {
  DEFAULT_MAX_PROMPT_CHARS,
  buildSystemPrompt,
  countWords,
  rankDictionaryTerms,
  shouldSkipLlm,
} = require('../src/main/prompt');

test('profile selection is case-insensitive, path-safe, and has a sane default', () => {
  const cases = [
    ['C:\\Program Files\\Microsoft VS Code\\Code.exe', 'code-editor'],
    ['WINDOWSTERMINAL.EXE', 'terminal'],
    ['Discord.exe', 'discord'],
    ['chrome.exe', 'browser'],
    ['notepad.exe', 'notepad'],
  ];

  for (const [executable, expectedId] of cases) {
    assert.equal(getAppProfile(executable).id, expectedId);
  }
  assert.equal(getAppProfile('unknown.exe'), DEFAULT_APP_PROFILE);
  assert.equal(getAppProfile(null), DEFAULT_APP_PROFILE);
  assert.match(APP_PROFILES['code.exe'].rules.join(' '), /Do not correct.*punctuation/i);
  assert.match(APP_PROFILES['windowsterminal.exe'].rules.join(' '), /bare command/i);
  assert.match(APP_PROFILES['discord.exe'].rules.join(' '), /signoff/i);
});

test('language lock is explicit and repeated for every supported ASR language', () => {
  const names = { en: 'English', de: 'German', el: 'Greek' };

  for (const [code, name] of Object.entries(names)) {
    const prompt = buildSystemPrompt({
      detectedLanguage: code,
      executable: 'notepad.exe',
    });
    const lock = `${name} (${code})`;

    assert.ok(
      prompt.split(lock).length - 1 >= 3,
      `${code} language lock was not repeated`
    );
    assert.match(prompt, /Never answer a question/);
    assert.match(prompt, /Never summarise, translate, continue, complete/);
    assert.match(prompt, /does not answer, summarise, translate, continue/);
    assert.ok(prompt.length <= DEFAULT_MAX_PROMPT_CHARS);
  }
});

test('all 20 multilingual fixtures build the intended profile prompt within budget', () => {
  assert.equal(fixtures.length, 20);
  assert.deepEqual(
    [...new Set(fixtures.map((fixture) => fixture.language))].sort(),
    ['de', 'el', 'en']
  );

  for (const fixture of fixtures) {
    const profile = getAppProfile(fixture.executable);
    const prompt = buildSystemPrompt({
      detectedLanguage: fixture.language,
      executable: fixture.executable,
      transcript: fixture.raw,
      removeFillers: fixture.removeFillers,
    });

    assert.match(prompt, new RegExp(`TARGET APP — ${profile.label}`));
    assert.ok(prompt.length <= DEFAULT_MAX_PROMPT_CHARS);
    assert.ok(fixture.raw.length > 0);
    assert.ok(fixture.expected.length > 0);
  }
});

test('the filler preference produces an unambiguous prompt rule', () => {
  const remove = buildSystemPrompt({
    detectedLanguage: 'en',
    removeFillers: true,
  });
  const preserve = buildSystemPrompt({
    detectedLanguage: 'en',
    removeFillers: false,
  });

  assert.match(remove, /Remove speech fillers/);
  assert.doesNotMatch(remove, /user has disabled filler removal/);
  assert.match(preserve, /Preserve filler words/);
  assert.match(preserve, /user has disabled filler removal/);
});

test('dictionary terms are language-filtered, active-only, and must-spell-exactly', () => {
  const prompt = buildSystemPrompt({
    detectedLanguage: 'en',
    executable: 'chrome.exe',
    transcript: 'search for graph ana docs',
    dictionaryTerms: [
      { term: 'Grafana', soundsLike: 'graph ana', lang: 'en' },
      { term: 'HiddenTerm', lang: 'en', active: false },
      { term: 'Bürgeramt', lang: 'de' },
    ],
  });

  assert.match(prompt, /MUST SPELL EXACTLY/);
  assert.match(prompt, /"Grafana" \(may be heard as "graph ana"\)/);
  assert.doesNotMatch(prompt, /HiddenTerm/);
  assert.doesNotMatch(prompt, /Bürgeramt/);
});

test('an oversized dictionary is truncated by transcript relevance under the hard cap', () => {
  const terms = Array.from({ length: 100 }, (_, index) => ({
    term: `UnrelatedTerm${String(index).padStart(3, '0')}`,
    lang: 'en',
  }));
  terms.push({
    term: 'Grafana',
    soundsLike: 'graph ana',
    lang: 'en',
  });

  const prompt = buildSystemPrompt({
    detectedLanguage: 'en',
    executable: 'chrome.exe',
    transcript: 'graph ana docs',
    dictionaryTerms: terms,
    maxChars: 1_850,
  });

  assert.ok(prompt.length <= 1_850);
  assert.match(prompt, /Grafana/);
  assert.ok(
    terms.filter(({ term }) => prompt.includes(term)).length < terms.length,
    'the complete dictionary was sent'
  );
  assert.equal(
    rankDictionaryTerms(terms, 'graph ana docs', 'en')[0].term,
    'Grafana'
  );
});

test('Unicode word counting applies the under-N rule to English, German, and Greek', () => {
  assert.equal(countWords("don't re-run Grafana"), 3);
  assert.equal(countWords('öffne das Bürgeramt'), 3);
  assert.equal(countWords('άνοιξε το μουσείο'), 3);
  assert.equal(shouldSkipLlm('one two three', 4), true);
  assert.equal(shouldSkipLlm('one two three four', 4), false);
  assert.equal(shouldSkipLlm('ένα δύο τρία', 4), true);
  assert.equal(shouldSkipLlm('npm test', 0), false);
});

test('unsupported languages fail closed instead of risking translation', () => {
  assert.throws(
    () => buildSystemPrompt({ detectedLanguage: 'fr' }),
    /Unsupported detected language/
  );
});
