import assert from 'node:assert/strict';
import test from 'node:test';
import {
  concatenateFloat32,
  createChunkCollector,
  createWorkletMessageHandler,
  float32ToInt16,
  resampleWindowedSinc,
} from '../src/renderer/recorder/audio-utils.mjs';
import {
  encodeMonoPcm16Wav,
  signalStats,
} from './helpers/wav.mjs';

function sineWave(frequency, sampleRate, seconds, amplitude = 1) {
  const samples = new Float32Array(Math.round(sampleRate * seconds));

  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = amplitude * Math.sin(2 * Math.PI * frequency * index / sampleRate);
  }

  return samples;
}

function rms(samples, start = 0) {
  let squareTotal = 0;
  let count = 0;

  for (let index = start; index < samples.length; index += 1) {
    squareTotal += samples[index] * samples[index];
    count += 1;
  }

  return Math.sqrt(squareTotal / count);
}

test('resampler produces the correct duration for common device rates', () => {
  for (const inputRate of [16_000, 44_100, 48_000]) {
    const input = sineWave(1000, inputRate, 0.25, 0.5);
    const output = resampleWindowedSinc(input, inputRate, 16_000);

    assert.equal(output.length, 4000);
  }
});

test('resampler preserves speech-band amplitude', () => {
  const input = sineWave(1000, 48_000, 0.5, 0.7);
  const output = resampleWindowedSinc(input, 48_000, 16_000);
  const boundarySamples = 100;
  const expectedRms = 0.7 / Math.sqrt(2);

  assert.ok(Math.abs(rms(output, boundarySamples) - expectedRms) < 0.01);
});

test('decimating filter strongly rejects content above the output Nyquist limit', () => {
  const input = sineWave(12_000, 48_000, 0.5, 0.8);
  const output = resampleWindowedSinc(input, 48_000, 16_000);
  const outputRms = rms(output, 100);

  assert.ok(outputRms < 0.001, `aliased RMS was ${outputRms}`);
});

test('Float32 to Int16 conversion clamps both rails and handles non-finite input', () => {
  const input = new Float32Array([
    -2,
    -1,
    -0.5,
    0,
    0.5,
    1,
    2,
    Number.NaN,
  ]);

  assert.deepEqual(
    [...float32ToInt16(input)],
    [-32768, -32768, -16384, 0, 16384, 32767, 32767, 0],
  );
});

test('WAV encoder writes a canonical mono 16 kHz PCM header and little-endian data', () => {
  const wav = encodeMonoPcm16Wav(new Int16Array([-32768, 0, 32767]), 16_000);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

  assert.equal(Buffer.from(wav.subarray(0, 4)).toString('ascii'), 'RIFF');
  assert.equal(view.getUint32(4, true), 42);
  assert.equal(Buffer.from(wav.subarray(8, 12)).toString('ascii'), 'WAVE');
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint32(28, true), 32_000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(Buffer.from(wav.subarray(36, 40)).toString('ascii'), 'data');
  assert.equal(view.getUint32(40, true), 6);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(46, true), 0);
  assert.equal(view.getInt16(48, true), 32767);
});

test('chunk concatenation and signal statistics preserve captured samples', () => {
  const samples = concatenateFloat32(
    [new Float32Array([0.25, -0.5]), new Float32Array([1])],
    3,
  );

  assert.deepEqual([...samples], [0.25, -0.5, 1]);
  assert.equal(signalStats(samples).peak, 1);
  assert.ok(Math.abs(signalStats(samples).rms - Math.sqrt(1.3125 / 3)) < 1e-7);
});

test('the collector keeps its running length in step with its chunks', () => {
  const collector = createChunkCollector();

  collector.push(new Float32Array([0.25, -0.5]));
  collector.push(new Float32Array([1]));
  assert.equal(collector.length, 3);

  const samples = collector.drain();
  assert.deepEqual([...samples], [0.25, -0.5, 1]);
  assert.equal(collector.length, 0);
  assert.equal(collector.drain().length, 0);
});

test('the worklet tail chunk delivered during flush is still captured', () => {
  // Regression: stop() clears its capture state before flushing the worklet,
  // and the flush emits the final partial buffer after that point. Losing it
  // from the running length made the capture assembly write past its buffer
  // and fail every dictation with "offset is out of bounds".
  const collector = createChunkCollector();
  const errors = [];
  const bridge = {
    amplitude: () => {},
    error: (message) => errors.push(message),
  };
  const handler = createWorkletMessageHandler({ collector, bridge });

  handler({ data: { type: 'samples', samples: new Float32Array(4096).fill(0.5) } });

  // stop() detaches its capture here; the worklet flush lands afterwards.
  handler({ data: { type: 'samples', samples: new Float32Array(1200).fill(0.25) } });

  assert.deepEqual(errors, []);
  assert.equal(collector.length, 5296);

  const samples = collector.drain();
  assert.equal(samples.length, 5296);
  assert.equal(samples[4095], 0.5);
  assert.equal(samples[4096], 0.25);
  assert.equal(samples[5295], 0.25);
});

test('the worklet handler forwards amplitude and reports its own failures', () => {
  const amplitudes = [];
  const errors = [];
  const bridge = {
    amplitude: (value) => amplitudes.push(value),
    error: (message) => errors.push(message),
  };
  const collector = createChunkCollector();
  const handler = createWorkletMessageHandler({ collector, bridge });

  handler({ data: { type: 'amplitude', amplitude: 0.4 } });
  handler({ data: { type: 'flushed' } });
  handler(undefined);
  assert.deepEqual(amplitudes, [0.4]);
  assert.deepEqual(errors, []);
  assert.equal(collector.length, 0);

  const failing = createWorkletMessageHandler({
    collector: {
      push: () => {
        throw new Error('collector exploded');
      },
    },
    bridge,
  });
  failing({ data: { type: 'samples', samples: new Float32Array(8) } });
  assert.deepEqual(errors, ['collector exploded']);
});

test('the worklet handler requires a collector and a bridge', () => {
  assert.throws(() => createWorkletMessageHandler(), TypeError);
  assert.throws(
    () => createWorkletMessageHandler({ collector: createChunkCollector() }),
    TypeError,
  );
  assert.throws(
    () => createWorkletMessageHandler({ bridge: { amplitude() {}, error() {} } }),
    TypeError,
  );
});

/* The per-tap reference the phase-table resampler replaced: every weight
   computed with sin/cos at the point of use. Kept here so the fast version
   is held to the same numbers, not just to "sounds right". */
function referenceResample(input, inputRate, outputRate, filterRadius = 48, rolloff = 0.94) {
  const sinc = (v) => (Math.abs(v) < 1e-12 ? 1 : Math.sin(Math.PI * v) / (Math.PI * v));
  const blackman = (d, r) => {
    const p = Math.abs(d) / r;
    return p > 1 ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * p) + 0.08 * Math.cos(2 * Math.PI * p);
  };
  const ratio = outputRate / inputRate;
  const output = new Float32Array(Math.max(1, Math.round(input.length * ratio)));
  const cutoff = 0.5 * Math.min(1, ratio) * rolloff;
  const step = inputRate / outputRate;
  for (let o = 0; o < output.length; o += 1) {
    const pos = o * step;
    let weighted = 0;
    let total = 0;
    for (let i = Math.ceil(pos - filterRadius); i <= Math.floor(pos + filterRadius); i += 1) {
      if (i < 0 || i >= input.length) continue;
      const d = pos - i;
      const w = 2 * cutoff * sinc(2 * cutoff * d) * blackman(d, filterRadius);
      weighted += input[i] * w;
      total += w;
    }
    output[o] = Math.abs(total) > 1e-12 ? weighted / total : 0;
  }
  return output;
}

function noisySpeechLike(sampleRate, seconds) {
  const samples = new Float32Array(Math.round(sampleRate * seconds));
  let seed = 7;
  for (let index = 0; index < samples.length; index += 1) {
    seed = (seed * 16807) % 2147483647;
    samples[index] = (0.4 * Math.sin(index * 0.013)) + (0.3 * ((seed / 2147483647) - 0.5));
  }
  return samples;
}

test('phase-table resampler matches the per-tap reference, edges included', () => {
  for (const rate of [48_000, 44_100, 32_000, 22_050, 96_000, 47_999.5]) {
    const input = noisySpeechLike(rate, 0.5);
    const expected = referenceResample(input, rate, 16_000);
    const actual = resampleWindowedSinc(input, rate, 16_000);
    assert.equal(actual.length, expected.length, `length at ${rate} Hz`);
    let maxDiff = 0;
    for (let index = 0; index < actual.length; index += 1) {
      maxDiff = Math.max(maxDiff, Math.abs(actual[index] - expected[index]));
    }
    // Integer rates use exact phases; the quantised fallback stays far
    // below one 16-bit PCM step (3e-5).
    assert.ok(maxDiff < (Number.isInteger(rate) ? 1e-6 : 1e-4), `${rate} Hz max diff ${maxDiff}`);
  }
});

test('a 60 s capture resamples well inside the release budget', () => {
  const input = noisySpeechLike(48_000, 60);
  const started = performance.now();
  resampleWindowedSinc(input, 48_000, 16_000);
  const elapsed = performance.now() - started;
  // The per-tap version took ~3.7 s here; the table version ~0.15 s.
  assert.ok(elapsed < 1_000, `took ${elapsed.toFixed(0)} ms`);
});
