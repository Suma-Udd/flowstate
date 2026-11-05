'use strict';

const MODEL_NAME = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8';

const MODEL_ARCHIVE = Object.freeze({
  filename: `${MODEL_NAME}.tar.bz2`,
  url:
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/' +
    `${MODEL_NAME}.tar.bz2`,
  bytes: 487_170_055,
  sha256: '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf',
});

const SILERO_VAD = Object.freeze({
  filename: 'silero_vad.onnx',
  url:
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/' +
    'silero_vad.onnx',
  bytes: 643_854,
  sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
});

const REQUIRED_MODEL_FILES = Object.freeze([
  Object.freeze({ filename: 'encoder.int8.onnx', minimumBytes: 600_000_000 }),
  Object.freeze({ filename: 'decoder.int8.onnx', minimumBytes: 10_000_000 }),
  Object.freeze({ filename: 'joiner.int8.onnx', minimumBytes: 5_000_000 }),
  Object.freeze({ filename: 'tokens.txt', minimumBytes: 50_000 }),
]);

module.exports = {
  MODEL_ARCHIVE,
  MODEL_NAME,
  REQUIRED_MODEL_FILES,
  SILERO_VAD,
};
