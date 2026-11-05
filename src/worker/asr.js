'use strict';

const { availableParallelism } = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { MODEL_NAME } = require('../shared/model-manifest');
const { DEFAULT_HOTWORDS_SCORE, ensureBpeVocab } = require('./hotwords');

const SAMPLE_RATE = 16_000;
const VAD_WINDOW_SIZE = 512;
const DEFAULT_MODELS_DIRECTORY = path.resolve(__dirname, '..', '..', 'models');

// Parakeet TDT transcribes all 25 of its languages but reports none, so the
// cleanup prompt's language lock depends on this classifier. Function words
// are what separate English from German in a single sentence; words both
// languages share ("in", "was", "will", "also", "man", "so", "um", "er",
// "okay") are deliberately left out. An ambiguous transcript stays unknown
// (''), which makes cleanup fall back to the raw text: a skipped cleanup is
// harmless, a wrong language lock is the drift gate G3 forbids.
const languageWords = {
  de: new Set(`
    der die das den dem des ein eine einen einem einer eines
    und oder aber sondern denn doch ist sind bin bist seid war waren wäre
    sein haben habe hast hat hatte hatten werden wird wurde wurden
    ich du sie es wir ihr mich mir dich dir uns euch ihm ihn ihnen
    mein meine meinen meinem dein deine unser unsere euer
    nicht kein keine keinen ja nein auch noch schon nur sehr mal jetzt
    heute morgen gestern hier dort wie wer wo warum wann welche welcher
    dass weil wenn ob als auf aus bei mit nach von zu zum zur für über
    unter vor durch gegen ohne zwischen kann kannst können muss müssen
    soll sollte will willst möchte gibt geht gehen machen mache macht
    gut bitte danke hallo dann alles etwas viel mehr ganz gerade immer
    eigentlich vielleicht natürlich genau einfach wirklich heißt sagen
  `.trim().split(/\s+/u)),
  en: new Set(`
    the a and or but is are am were be been being have has had do does
    did done i you he she it we they me my your his her its our their
    them him us this that these those what which who whom how why when
    where can could would should shall may might must not no yes of to
    on at for with from by about if just now right there here then than
    some any all more very really too up out get got going know think
    like want need make see hear say said hello hey thanks thank please
    let don't i'm it's that's can't won't isn't you're we're they're
    gonna wanna into over again because only maybe something
    everything nothing today tomorrow yesterday sentence testing
  `.trim().split(/\s+/u)),
};

const GERMAN_LETTERS = /[äöüß]/u;
// Share of a transcript's words that must be known function words before a
// language is claimed.
const MIN_EVIDENCE_SHARE = 0.15;

function inferTranscriptLanguage(text) {
  const letters = text.match(/\p{L}/gu) ?? [];
  const greekLetters = text.match(/\p{Script=Greek}/gu) ?? [];
  if (letters.length > 0 && greekLetters.length / letters.length > 0.5) {
    return 'el';
  }

  const words = text.toLocaleLowerCase().match(/[\p{L}']+/gu) ?? [];
  const scores = { de: 0, en: 0 };
  for (const word of words) {
    if (languageWords.de.has(word)) scores.de += 1;
    if (languageWords.en.has(word)) scores.en += 1;
    if (GERMAN_LETTERS.test(word)) scores.de += 1;
  }

  if (scores.de === scores.en) {
    return '';
  }
  // One stray "no" in thirteen words is not English. When Parakeet mishears
  // Greek as Spanish-looking text, a thin match would lock the cleanup
  // prompt to the wrong language (G3 dictation #25); unknown is safe.
  const winner = scores.de > scores.en ? 'de' : 'en';
  if (scores[winner] < Math.max(1, Math.ceil(words.length * MIN_EVIDENCE_SHARE))) {
    return '';
  }
  return winner;
}

function int16ToFloat32(pcm) {
  if (!(pcm instanceof Int16Array)) {
    throw new TypeError('pcm must be an Int16Array.');
  }

  const samples = new Float32Array(pcm.length);
  for (let index = 0; index < pcm.length; index += 1) {
    samples[index] = pcm[index] / 32_768;
  }
  return samples;
}

// Silero marks a segment from where it is already sure there is speech, so
// soft onsets ("k" in "kannst", "h" in "hören") and trailing consonants sit
// just outside its bounds. Cutting exactly there clipped the first word of
// short dictations; the margin keeps them at ~0.6 s of extra audio, which
// Parakeet ignores.
const SPEECH_PAD_SECONDS = 0.3;
// When the VAD finds nothing, a short capture is still decoded whole: a quiet
// or gated microphone (Voicemod's noise gate) can hide a real phrase from the
// VAD, and decoding a few seconds of near-silence costs ~100 ms and simply
// returns empty text if there really was nothing.
const UNDETECTED_FALLBACK_SECONDS = 8;
// Beam width of the hotword recogniser; 4 costs ~40 ms on a 10 s clip.
const BEAM_WIDTH = 4;

function trimSilence(vad, samples, windowSize = VAD_WINDOW_SIZE, {
  padSamples = Math.round(SPEECH_PAD_SECONDS * SAMPLE_RATE),
  fallbackSamples = UNDETECTED_FALLBACK_SECONDS * SAMPLE_RATE,
} = {}) {
  vad.reset();
  vad.clear();

  for (let offset = 0; offset < samples.length; offset += windowSize) {
    const remaining = samples.length - offset;
    if (remaining >= windowSize) {
      vad.acceptWaveform(samples.subarray(offset, offset + windowSize));
    } else {
      const finalWindow = new Float32Array(windowSize);
      finalWindow.set(samples.subarray(offset));
      vad.acceptWaveform(finalWindow);
    }
  }
  vad.flush();

  let speechStart = Number.POSITIVE_INFINITY;
  let speechEnd = 0;
  while (!vad.isEmpty()) {
    const segment = vad.front(false);
    speechStart = Math.min(speechStart, segment.start);
    speechEnd = Math.max(speechEnd, segment.start + segment.samples.length);
    vad.pop();
  }

  if (!Number.isFinite(speechStart)) {
    return samples.length <= fallbackSamples
      ? samples.slice()
      : new Float32Array(0);
  }

  const start = Math.max(0, Math.min(samples.length, speechStart - padSamples));
  const end = Math.max(start, Math.min(samples.length, speechEnd + padSamples));
  return samples.slice(start, end);
}

function roundedMilliseconds(value) {
  return Math.round(value * 10) / 10;
}

async function createAsrEngine({
  modelsDirectory = DEFAULT_MODELS_DIRECTORY,
  numThreads = Math.min(4, availableParallelism()),
  now = () => performance.now(),
  sherpaOnnx = require('sherpa-onnx-node'),
  hotwords = true,
  hotwordsScore = DEFAULT_HOTWORDS_SCORE,
  onWarning = () => {},
} = {}) {
  const modelDirectory = path.join(modelsDirectory, MODEL_NAME);
  const recognizerConfig = {
    featConfig: {
      sampleRate: SAMPLE_RATE,
      featureDim: 80,
    },
    modelConfig: {
      transducer: {
        encoder: path.join(modelDirectory, 'encoder.int8.onnx'),
        decoder: path.join(modelDirectory, 'decoder.int8.onnx'),
        joiner: path.join(modelDirectory, 'joiner.int8.onnx'),
      },
      tokens: path.join(modelDirectory, 'tokens.txt'),
      numThreads,
      provider: 'cpu',
      debug: 0,
      modelType: 'nemo_transducer',
    },
  };
  const vadConfig = {
    sileroVad: {
      model: path.join(modelsDirectory, 'silero_vad.onnx'),
      threshold: 0.5,
      minSpeechDuration: 0.25,
      minSilenceDuration: 0.5,
      maxSpeechDuration: 120,
      windowSize: VAD_WINDOW_SIZE,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: false,
  };

  async function createRecognizer(config) {
    return typeof sherpaOnnx.OfflineRecognizer.createAsync === 'function'
      ? sherpaOnnx.OfflineRecognizer.createAsync(config)
      : new sherpaOnnx.OfflineRecognizer(config);
  }

  // Hotwords need beam search plus sherpa's bpe mode (see hotwords.js). If
  // that recogniser cannot be built, dictation falls back to the plain greedy
  // one: a missing boost is harmless, a dead worker is not.
  let recognizer;
  let hotwordsActive = false;
  if (hotwords) {
    try {
      const bpeVocab = await ensureBpeVocab({
        modelDirectory,
        filePath: path.join(modelsDirectory, 'hotwords', 'bpe.vocab'),
      });
      recognizer = await createRecognizer({
        ...recognizerConfig,
        modelConfig: { ...recognizerConfig.modelConfig, modelingUnit: 'bpe', bpeVocab },
        decodingMethod: 'modified_beam_search',
        maxActivePaths: BEAM_WIDTH,
        hotwordsScore,
      });
      hotwordsActive = true;
    } catch (error) {
      onWarning(`Hotwords unavailable, using greedy decoding: ${error instanceof Error ? error.message : error}`);
    }
  }
  recognizer ??= await createRecognizer(recognizerConfig);
  const vad = new sherpaOnnx.Vad(vadConfig, 120);

  return {
    async transcribe({ pcm, hotwords: streamHotwords = '' }) {
      const totalStartedAt = now();
      const samples = int16ToFloat32(pcm);

      const vadStartedAt = now();
      const speech = trimSilence(vad, samples);
      const vadMs = now() - vadStartedAt;

      let result = { text: '', lang: '' };
      let inferMs = 0;
      if (speech.length > 0) {
        let stream;
        if (hotwordsActive && typeof streamHotwords === 'string' && streamHotwords.length > 0) {
          try {
            stream = recognizer.createStream(streamHotwords);
          } catch (error) {
            onWarning(`Hotwords rejected for one decode: ${error instanceof Error ? error.message : error}`);
          }
        }
        stream ??= recognizer.createStream();
        stream.acceptWaveform({
          sampleRate: SAMPLE_RATE,
          samples: speech,
        });

        const inferStartedAt = now();
        if (typeof recognizer.decodeAsync === 'function') {
          result = await recognizer.decodeAsync(stream);
        } else {
          recognizer.decode(stream);
          result = recognizer.getResult(stream);
        }
        inferMs = now() - inferStartedAt;
      }

      const text = String(result.text ?? '').trim();
      const nativeLanguage = String(result.lang ?? '').trim().toLowerCase();
      return {
        text,
        lang: nativeLanguage || inferTranscriptLanguage(text),
        vadMs: roundedMilliseconds(vadMs),
        inferMs: roundedMilliseconds(inferMs),
        totalMs: roundedMilliseconds(now() - totalStartedAt),
      };
    },
  };
}

module.exports = {
  DEFAULT_MODELS_DIRECTORY,
  MODEL_NAME,
  SAMPLE_RATE,
  VAD_WINDOW_SIZE,
  createAsrEngine,
  inferTranscriptLanguage,
  int16ToFloat32,
  trimSilence,
};
