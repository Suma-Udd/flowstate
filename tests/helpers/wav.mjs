const DEFAULT_OUTPUT_RATE = 16_000;

function assertSampleRate(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number`);
  }
}

export function encodeMonoPcm16Wav(samples, sampleRate = DEFAULT_OUTPUT_RATE) {
  if (!(samples instanceof Int16Array)) {
    throw new TypeError('samples must be an Int16Array');
  }

  assertSampleRate(sampleRate, 'sampleRate');

  const bytesPerSample = 2;
  const channelCount = 1;
  const dataLength = samples.length * bytesPerSample;
  const wav = new ArrayBuffer(44 + dataLength);
  const view = new DataView(wav);

  const writeAscii = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataLength, true);

  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(44 + (index * bytesPerSample), samples[index], true);
  }

  return new Uint8Array(wav);
}

export function signalStats(samples) {
  if (!(samples instanceof Float32Array)) {
    throw new TypeError('samples must be a Float32Array');
  }

  if (samples.length === 0) {
    return { peak: 0, rms: 0 };
  }

  let peak = 0;
  let squareTotal = 0;

  for (const sample of samples) {
    const absoluteSample = Math.abs(sample);
    peak = Math.max(peak, absoluteSample);
    squareTotal += sample * sample;
  }

  return {
    peak,
    rms: Math.sqrt(squareTotal / samples.length),
  };
}
