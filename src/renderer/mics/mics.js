'use strict';

const bridge = window.flowMics;
let watching = false;

function errorMessage(error) {
  if (error?.name === 'NotAllowedError') return 'Microphone permission was denied.';
  if (error?.name === 'NotFoundError') return 'No microphone is available.';
  return error?.message || String(error);
}

async function enumerate() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    throw new Error('Microphone enumeration is unavailable.');
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === 'audioinput')
    .map((device) => ({
      deviceId: device.deviceId,
      groupId: device.groupId,
      label: device.label,
    }));
}

async function reportChange() {
  try {
    bridge.changed(await enumerate());
  } catch {
    // A device-change notification is advisory. The next explicit list()
    // returns a useful error if Chromium can no longer enumerate inputs.
  }
}

bridge.onCommand((command) => {
  if (!command || typeof command.type !== 'string') return;
  if (command.type === 'list' && typeof command.id === 'string') {
    enumerate().then(
      (devices) => bridge.result({ id: command.id, devices }),
      (error) => bridge.result({
        id: command.id,
        error: errorMessage(error).slice(0, 500),
      })
    );
    return;
  }
  if (command.type === 'watch' && !watching) {
    watching = true;
    navigator.mediaDevices?.addEventListener('devicechange', reportChange);
    return;
  }
  if (command.type === 'unwatch' && watching) {
    watching = false;
    navigator.mediaDevices?.removeEventListener('devicechange', reportChange);
  }
});
