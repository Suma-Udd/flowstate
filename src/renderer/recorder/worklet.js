class MonoCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.offset = 0;
    this.levelSquares = 0;
    this.levelSamples = 0;
    this.levelWindow = Math.max(1, Math.round(sampleRate / 30));
    this.sawFrame = false;

    this.port.onmessage = (event) => {
      if (event.data?.type === 'flush') {
        this.emitBuffer();
        this.emitAmplitude();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }

  emitBuffer() {
    if (this.offset === 0) return;
    const chunk = this.buffer.slice(0, this.offset);
    this.port.postMessage({ type: 'samples', samples: chunk }, [chunk.buffer]);
    this.offset = 0;
  }

  emitAmplitude() {
    if (this.levelSamples === 0) return;
    const amplitude = Math.sqrt(this.levelSquares / this.levelSamples);
    this.port.postMessage({ type: 'amplitude', amplitude });
    this.levelSquares = 0;
    this.levelSamples = 0;
  }

  process(inputs, outputs) {
    const inputChannels = inputs[0];
    if (inputChannels?.length > 0) {
      const frameCount = inputChannels[0].length;
      if (!this.sawFrame && frameCount > 0) {
        this.sawFrame = true;
        this.port.postMessage({ type: 'first' });
      }
      for (let frame = 0; frame < frameCount; frame += 1) {
        let sample = 0;
        for (const channel of inputChannels) sample += channel[frame] ?? 0;
        sample /= inputChannels.length;

        this.buffer[this.offset] = sample;
        this.offset += 1;
        this.levelSquares += sample * sample;
        this.levelSamples += 1;

        if (this.offset === this.buffer.length) this.emitBuffer();
        if (this.levelSamples >= this.levelWindow) this.emitAmplitude();
      }
    }

    for (const output of outputs) {
      for (const channel of output) channel.fill(0);
    }
    return true;
  }
}

registerProcessor('flowstate-mono-capture', MonoCaptureProcessor);
