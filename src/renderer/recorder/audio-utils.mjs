export const CAPTURE_SAMPLE_RATE = 16_000;

function sinc(value) {
  if (Math.abs(value) < 1e-12) return 1;
  const angle = Math.PI * value;
  return Math.sin(angle) / angle;
}

function blackmanWindow(distance, radius) {
  const position = Math.abs(distance) / radius;
  if (position > 1) return 0;
  return (
    0.42
    + (0.5 * Math.cos(Math.PI * position))
    + (0.08 * Math.cos(2 * Math.PI * position))
  );
}

function greatestCommonDivisor(left, right) {
  let a = left;
  let b = right;
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

// A tap's weight depends only on how far the input sample sits from the
// output position, and that distance repeats with a period of one output
// "phase". Computing sin/cos per tap per sample made a 30 s capture cost
// hundreds of millions of trig calls on key release (5.9 s measured in G3).
// The weights are therefore computed once per phase into a table and the
// inner loop is a plain multiply-add. Integer rates give an exact phase count
// (48 kHz -> 16 kHz has one phase; 44.1 kHz -> 16 kHz has 160); anything else
// falls back to 1024 quantised phases, a timing error under 0.1 % of a sample.
const FALLBACK_PHASES = 1024;
const MAX_EXACT_PHASES = 4096;

export function resampleWindowedSinc(
  input,
  inputRate,
  outputRate = CAPTURE_SAMPLE_RATE,
  { filterRadius = 48, rolloff = 0.94 } = {}
) {
  if (!(input instanceof Float32Array)) {
    throw new TypeError('input must be a Float32Array.');
  }
  if (!Number.isFinite(inputRate) || inputRate <= 0) {
    throw new RangeError('inputRate must be positive.');
  }
  if (!Number.isFinite(outputRate) || outputRate <= 0) {
    throw new RangeError('outputRate must be positive.');
  }
  if (input.length === 0) return new Float32Array();
  if (inputRate === outputRate) return input.slice();

  const ratio = outputRate / inputRate;
  const output = new Float32Array(Math.max(1, Math.round(input.length * ratio)));
  const cutoff = 0.5 * Math.min(1, ratio) * rolloff;
  const step = inputRate / outputRate;
  const radius = Math.floor(filterRadius);
  const taps = (2 * radius) + 1;

  const integerRates = Number.isInteger(inputRate) && Number.isInteger(outputRate);
  const divisor = integerRates ? greatestCommonDivisor(inputRate, outputRate) : 1;
  const exactPhases = integerRates ? outputRate / divisor : Infinity;
  const phases = exactPhases <= MAX_EXACT_PHASES ? exactPhases : FALLBACK_PHASES;

  // weights[phase * taps + j] is the weight of input sample (base - radius + j)
  // for an output position base + phase / phases.
  const weights = new Float64Array(phases * taps);
  const sums = new Float64Array(phases);
  for (let phase = 0; phase < phases; phase += 1) {
    const fraction = phase / phases;
    let sum = 0;
    for (let j = 0; j < taps; j += 1) {
      const distance = fraction + radius - j;
      const weight =
        2
        * cutoff
        * sinc(2 * cutoff * distance)
        * blackmanWindow(distance, filterRadius);
      weights[(phase * taps) + j] = weight;
      sum += weight;
    }
    sums[phase] = sum;
  }

  const lastInput = input.length - 1;
  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    let base;
    let phase;
    if (phases === exactPhases) {
      const numerator = outputIndex * inputRate;
      base = Math.floor(numerator / outputRate);
      phase = (numerator - (base * outputRate)) / divisor;
    } else {
      const position = outputIndex * step;
      base = Math.floor(position);
      phase = Math.round((position - base) * phases);
      if (phase === phases) {
        base += 1;
        phase = 0;
      }
    }

    const first = base - radius;
    const offset = phase * taps;
    let weighted = 0;
    let totalWeight;
    if (first >= 0 && first + taps - 1 <= lastInput) {
      for (let j = 0; j < taps; j += 1) {
        weighted += input[first + j] * weights[offset + j];
      }
      totalWeight = sums[phase];
    } else {
      // Edges: only in-range taps count, and they renormalise among
      // themselves, exactly as the per-sample version did.
      totalWeight = 0;
      for (let j = 0; j < taps; j += 1) {
        const inputIndex = first + j;
        if (inputIndex < 0 || inputIndex > lastInput) continue;
        const weight = weights[offset + j];
        weighted += input[inputIndex] * weight;
        totalWeight += weight;
      }
    }
    output[outputIndex] = Math.abs(totalWeight) > 1e-12
      ? weighted / totalWeight
      : 0;
  }
  return output;
}

export function concatenateFloat32(chunks, totalLength) {
  const output = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  if (offset !== totalLength) {
    throw new RangeError('Captured chunk lengths do not match.');
  }
  return output;
}

// Owns the captured chunks and their running length together. Keeping the two
// in one place is deliberate: a separate counter can fall out of step with the
// chunk list, and the mismatch only surfaces later as an out-of-bounds write
// inside concatenateFloat32().
export function createChunkCollector() {
  const chunks = [];
  let totalLength = 0;

  return {
    get length() {
      return totalLength;
    },
    push(chunk) {
      if (!(chunk instanceof Float32Array)) {
        throw new TypeError('chunk must be a Float32Array.');
      }
      chunks.push(chunk);
      totalLength += chunk.length;
    },
    drain() {
      const merged = concatenateFloat32(chunks, totalLength);
      chunks.length = 0;
      totalLength = 0;
      return merged;
    },
  };
}

// The worklet port swallows exceptions thrown by its message handler, so a
// failure here has to be reported explicitly rather than left to bubble.
export function createWorkletMessageHandler({ collector, bridge } = {}) {
  if (!collector || typeof collector.push !== 'function') {
    throw new TypeError('A chunk collector is required.');
  }
  if (
    !bridge
    || typeof bridge.amplitude !== 'function'
    || typeof bridge.error !== 'function'
  ) {
    throw new TypeError('A recorder bridge is required.');
  }

  return (event) => {
    try {
      const data = event?.data;
      if (data?.type === 'samples' && data.samples instanceof Float32Array) {
        collector.push(data.samples);
      } else if (data?.type === 'amplitude') {
        bridge.amplitude(data.amplitude);
      }
    } catch (error) {
      bridge.error(error instanceof Error ? error.message : String(error));
    }
  };
}

export function float32ToInt16(input) {
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const finite = Number.isFinite(input[index]) ? input[index] : 0;
    const sample = Math.max(-1, Math.min(1, finite));
    output[index] = sample < 0
      ? Math.round(sample * 0x8000)
      : Math.round(sample * 0x7fff);
  }
  return output;
}

export const PREROLL_MS = 250;

// Rolling window of the most recent audio while the microphone is open but no
// dictation is recording. begin() seeds the capture from tail(), so speech that
// started a hair before the recorder was told to begin (key hook and IPC delay)
// is not lost. Whole chunks are dropped from the front, so memory stays bounded
// at roughly maxSamples plus one chunk.
export function createPrerollRing(maxSamples) {
  if (!Number.isInteger(maxSamples) || maxSamples < 0) {
    throw new RangeError('maxSamples must be a non-negative integer.');
  }
  const chunks = [];
  let total = 0;

  return {
    get length() {
      return total;
    },
    push(chunk) {
      if (!(chunk instanceof Float32Array)) {
        throw new TypeError('chunk must be a Float32Array.');
      }
      chunks.push(chunk);
      total += chunk.length;
      while (chunks.length > 1 && total - chunks[0].length >= maxSamples) {
        total -= chunks.shift().length;
      }
    },
    tail(count = maxSamples) {
      const wanted = Math.min(Math.max(0, count), total, maxSamples);
      const output = new Float32Array(wanted);
      let remaining = wanted;
      for (let index = chunks.length - 1; index >= 0 && remaining > 0; index -= 1) {
        const chunk = chunks[index];
        const take = Math.min(remaining, chunk.length);
        output.set(chunk.subarray(chunk.length - take), remaining - take);
        remaining -= take;
      }
      return output;
    },
    clear() {
      chunks.length = 0;
      total = 0;
    },
  };
}
