'use strict';

/* Loaded only by `Flowstate.exe --self-test=...`: proves sherpa-onnx and its
   DLLs load inside a utility process, then reports back and stops. */

try {
  const sherpa = require('sherpa-onnx-node');
  if (typeof sherpa.OfflineRecognizer !== 'function' || typeof sherpa.Vad !== 'function') {
    throw new Error('sherpa-onnx-node loaded without OfflineRecognizer or Vad');
  }
  process.parentPort.postMessage({ ok: true, detail: 'ok (OfflineRecognizer, Vad)' });
} catch (error) {
  process.parentPort.postMessage({ ok: false, error: error.message });
}
