/* ==========================================================================
   Microphone preview (issue #18) — the Dictation screen's live level meter.

   Deliberately not the recorder in ../recorder/recorder.js: this never
   assembles PCM and never resamples. It reuses ../recorder/worklet.js purely
   for its already-existing ~30Hz RMS amplitude messages and drops the
   'samples' messages the same worklet also emits, since nothing here ever
   needs the audio itself. main destroys this window outright to stop the
   meter — there is no in-page "stop" command to listen for.
   ========================================================================== */

const bridge = window.flowMicPreview;
let capture;

function stopStream(stream) {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function mediaErrorMessage(error) {
  if (error?.name === 'NotAllowedError') return 'Microphone permission was denied.';
  if (error?.name === 'NotFoundError') return 'No microphone is available.';
  if (error?.name === 'OverconstrainedError') return 'The configured microphone is not available.';
  if (error?.name === 'NotReadableError') return 'The microphone could not be opened.';
  return error?.message || String(error);
}

async function cleanup(active) {
  active.track?.removeEventListener('ended', active.onTrackEnded);
  try {
    active.source?.disconnect();
    active.worklet?.disconnect();
    active.silentGain?.disconnect();
  } catch {
    // Already torn down.
  }
  stopStream(active.stream);
  if (active.audioContext?.state !== 'closed') {
    await active.audioContext.close();
  }
}

async function start(deviceId) {
  if (capture) return;
  const audio = {
    autoGainControl: false,
    channelCount: { ideal: 1 },
    echoCancellation: false,
    noiseSuppression: false,
  };
  if (deviceId) audio.deviceId = { exact: deviceId };

  const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stopStream(stream);
    throw new Error('The selected microphone produced no audio track.');
  }

  const audioContext = new AudioContext({ latencyHint: 'interactive' });
  await audioContext.audioWorklet.addModule('../recorder/worklet.js');
  await audioContext.resume();

  const source = audioContext.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(audioContext, 'flowstate-mono-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;

  capture = { audioContext, source, worklet, silentGain, stream, track };

  worklet.port.onmessage = (event) => {
    if (event.data?.type === 'amplitude') bridge.level(event.data.amplitude);
    // 'samples' messages are dropped: the preview never assembles PCM.
  };

  capture.onTrackEnded = () => bridge.error('The microphone disconnected.');
  track.addEventListener('ended', capture.onTrackEnded, { once: true });

  source.connect(worklet);
  worklet.connect(silentGain);
  silentGain.connect(audioContext.destination);
}

bridge.onCommand((command) => {
  start(command.deviceId).catch(async (error) => {
    const active = capture;
    capture = undefined;
    if (active) await cleanup(active).catch(() => {});
    bridge.error(mediaErrorMessage(error));
  });
});
