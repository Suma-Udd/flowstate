import {
  CAPTURE_SAMPLE_RATE,
  PREROLL_MS,
  createChunkCollector,
  createPrerollRing,
  createWorkletMessageHandler,
  float32ToInt16,
  resampleWindowedSinc,
} from './audio-utils.mjs';

const bridge = window.flowRecorder;

// The microphone graph outlives a single dictation: main keeps this window
// open for a short warm hold so a second press does not pay the cold open.
// While open and not recording, audio only passes through a short rolling
// pre-roll ring; nothing leaves this process until begin.
let graph;
let queue = Promise.resolve();

// Wall-clock marks (ms, comparable with the main process) for the start-up
// latency harness. Cheap enough to always collect.
const stamp = () => performance.timeOrigin + performance.now();

function mediaErrorMessage(error) {
  if (error?.name === 'NotAllowedError') {
    return 'Microphone permission was denied.';
  }
  if (error?.name === 'NotFoundError') {
    return 'No microphone is available.';
  }
  if (error?.name === 'OverconstrainedError') {
    return 'The configured microphone is not available.';
  }
  if (error?.name === 'NotReadableError') {
    return 'The microphone could not be opened.';
  }
  return error?.message || String(error);
}

function stopStream(stream) {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function flushWorklet(node) {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error('Audio capture flush timed out.')),
      2000
    );
    const onMessage = (event) => {
      if (event.data?.type !== 'flushed') return;
      window.clearTimeout(timeout);
      node.port.removeEventListener('message', onMessage);
      resolve();
    };
    node.port.addEventListener('message', onMessage);
    node.port.postMessage({ type: 'flush' });
  });
}

async function cleanup(active) {
  active.track?.removeEventListener('ended', active.onTrackEnded);
  try {
    active.source?.disconnect();
    active.worklet?.disconnect();
    active.silentGain?.disconnect();
  } catch {
    // A completed close already disconnected the graph.
  }
  stopStream(active.stream);
  if (active.audioContext?.state !== 'closed') {
    await active.audioContext.close();
  }
}

async function open(deviceId) {
  if (graph) return;
  const audio = {
    autoGainControl: false,
    channelCount: { ideal: 1 },
    echoCancellation: false,
    noiseSuppression: false,
  };
  if (deviceId) audio.deviceId = { exact: deviceId };

  const marks = { cmd: stamp() };
  // The device open (the slow, hardware-bound part) and the audio-engine setup
  // do not depend on each other, so they run side by side.
  const audioContext = new AudioContext({ latencyHint: 'interactive' });
  let stream;
  try {
    [stream] = await Promise.all([
      navigator.mediaDevices.getUserMedia({ audio, video: false }),
      audioContext.audioWorklet.addModule('./worklet.js'),
    ]);
  } catch (error) {
    await audioContext.close().catch(() => {});
    throw error;
  }
  marks.gum = stamp();
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stopStream(stream);
    await audioContext.close().catch(() => {});
    throw new Error('The selected microphone produced no audio track.');
  }
  await audioContext.resume();
  marks.resumed = stamp();

  const source = audioContext.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(audioContext, 'flowstate-mono-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  const settings = track.getSettings();
  const ring = createPrerollRing(
    Math.round((audioContext.sampleRate * PREROLL_MS) / 1000)
  );

  const next = {
    audioContext,
    collector: null,
    contextSampleRate: audioContext.sampleRate,
    recording: false,
    ring,
    settings,
    silentGain,
    source,
    stream,
    track,
    worklet,
  };

  let sawFirstFrame;
  const firstFrame = new Promise((resolve) => { sawFirstFrame = resolve; });

  // The flush at stop still delivers a tail chunk, so routing is decided per
  // chunk by the live `recording` flag rather than fixed at connect time.
  const sink = {
    push(chunk) {
      if (next.recording) next.collector.push(chunk);
      else next.ring.push(chunk);
    },
  };
  const gatedBridge = {
    amplitude: (value) => { if (next.recording) bridge.amplitude(value); },
    error: (message) => bridge.error(message),
  };
  const handle = createWorkletMessageHandler({ collector: sink, bridge: gatedBridge });
  worklet.port.onmessage = (event) => {
    if (event.data?.type === 'first') {
      sawFirstFrame(stamp());
      return;
    }
    handle(event);
  };

  next.onTrackEnded = () => {
    bridge.error('The microphone disconnected during capture.');
  };
  track.addEventListener('ended', next.onTrackEnded, { once: true });

  source.connect(worklet);
  worklet.connect(silentGain);
  silentGain.connect(audioContext.destination);
  marks.graph = stamp();
  graph = next;

  // Report ready only once audio is really flowing, so "ready" means the first
  // syllable will be caught rather than that the device is still waking up.
  const timeout = new Promise((_resolve, reject) => {
    window.setTimeout(
      () => reject(new Error('The microphone produced no audio.')),
      4000
    );
  });
  marks.firstFrame = await Promise.race([firstFrame, timeout]);
  bridge.marks(marks);
  bridge.opened({
    contextSampleRate: audioContext.sampleRate,
    deviceId: settings.deviceId || null,
    deviceLabel: track.label || null,
  });
}

async function begin() {
  if (!graph) throw new Error('No microphone is open.');
  if (graph.recording) return;
  // Bring the ring up to date so the seed ends exactly at "now".
  await flushWorklet(graph.worklet);
  const collector = createChunkCollector();
  const seed = graph.ring.tail();
  if (seed.length > 0) collector.push(seed);
  graph.ring.clear();
  graph.collector = collector;
  graph.recording = true;
  bridge.started();
}

async function stop() {
  if (!graph?.recording) throw new Error('No audio capture is active.');
  const active = graph;
  await flushWorklet(active.worklet);
  active.recording = false;
  const input = active.collector.drain();
  active.collector = null;
  if (input.length === 0) {
    throw new Error('No audio was captured from the microphone.');
  }
  const output = resampleWindowedSinc(
    input,
    active.contextSampleRate,
    CAPTURE_SAMPLE_RATE
  );
  const pcm = float32ToInt16(output);
  bridge.complete(pcm, {
    capturedSeconds: input.length / active.contextSampleRate,
    outputSampleRate: CAPTURE_SAMPLE_RATE,
  });
}

function abort() {
  if (!graph) return;
  graph.recording = false;
  graph.collector = null;
  graph.ring.clear();
}

async function close() {
  const active = graph;
  graph = undefined;
  if (active) await cleanup(active);
}

const handlers = { open: (c) => open(c.deviceId), begin, stop, abort, close };

// Commands run one at a time: begin must not overtake an open still in flight.
bridge.onCommand((command) => {
  queue = queue
    .then(() => handlers[command.type](command))
    .catch(async (error) => {
      const active = graph;
      graph = undefined;
      if (active) await cleanup(active).catch(() => {});
      bridge.error(mediaErrorMessage(error));
    });
});
