# Third-party notices

Flowstate is MIT licensed (see [LICENSE](LICENSE)). It is built on the software and the model below, each under its own license.

## Speech model, downloaded on first run

**NVIDIA Parakeet TDT 0.6B v3**, converted to ONNX (int8) by the sherpa-onnx project.
Copyright NVIDIA Corporation. Licensed under the Creative Commons Attribution 4.0 International license (CC-BY-4.0): https://creativecommons.org/licenses/by/4.0/
Original model: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
The model is not part of this repository and is not bundled in the installer. Flowstate downloads it once, from the sherpa-onnx release assets, after checking its SHA-256. It has been converted to ONNX and quantised to int8; no other change was made by Flowstate.

**Silero VAD**, voice activity detection.
Copyright Silero Team. MIT License. https://github.com/snakers4/silero-vad
Downloaded on first run together with the speech model.

## Runtime libraries

| Component | License | Link |
|---|---|---|
| sherpa-onnx (`sherpa-onnx-node`, `sherpa-onnx-win-x64`) | Apache-2.0 | https://github.com/k2-fsa/sherpa-onnx |
| ONNX Runtime (shipped inside sherpa-onnx-win-x64) | MIT | https://github.com/microsoft/onnxruntime |
| Electron | MIT | https://github.com/electron/electron |
| Chromium and its dependencies (shipped inside Electron) | various, see `LICENSES.chromium.html` in the install folder | https://www.chromium.org |
| uiohook-napi | MIT | https://github.com/SnosMe/uiohook-napi |
| libuiohook (compiled into uiohook-napi) | LGPL-3.0-or-later | https://github.com/kwhat/libuiohook |
| koffi | MIT | https://github.com/Koromix/koffi |
| better-sqlite3 | MIT | https://github.com/WiseLibs/better-sqlite3 |
| SQLite (inside better-sqlite3) | Public domain | https://sqlite.org |

### About libuiohook

libuiohook is licensed under the GNU Lesser General Public License, version 3 or later. It is compiled into the native module `uiohook-napi.node`, which Flowstate ships as a separate file, `resources\app.asar.unpacked\node_modules\uiohook-napi\...`, next to the app and not inside its archive. You can replace that file with a build of your own, made from the libuiohook and uiohook-napi sources linked above. A copy of the LGPL is at https://www.gnu.org/licenses/lgpl-3.0.html.

## Build tools (not shipped)

electron-builder (MIT) and @electron/rebuild (MIT) are used to build the installer. They are development dependencies and are not part of the installed app.

## Trademarks

Wispr Flow is a trademark of its owner. Flowstate is an independent project and is not affiliated with it. Windows is a trademark of Microsoft. NVIDIA is a trademark of NVIDIA Corporation.
