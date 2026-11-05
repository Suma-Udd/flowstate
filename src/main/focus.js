'use strict';

const path = require('node:path');

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const MAX_PROCESS_PATH_CHARS = 32_768;

function createNativeFocusApi({ koffi = require('koffi') } = {}) {
  if (process.platform !== 'win32') {
    throw new Error('Foreground-window capture is only supported on Windows.');
  }

  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const GetForegroundWindow = user32.func(
    'void * __stdcall GetForegroundWindow(void)'
  );
  const GetWindowTextLengthW = user32.func(
    'int __stdcall GetWindowTextLengthW(void *hWnd)'
  );
  const GetWindowTextW = user32.func(
    'int __stdcall GetWindowTextW(void *hWnd, _Out_ void *text, int maxCount)'
  );
  const GetWindowThreadProcessId = user32.func(
    'uint32_t __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32_t *processId)'
  );
  const OpenProcess = kernel32.func(
    'void * __stdcall OpenProcess(uint32_t desiredAccess, int inheritHandle, uint32_t processId)'
  );
  const QueryFullProcessImageNameW = kernel32.func(
    'int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, _Out_ void *name, _Inout_ uint32_t *size)'
  );
  const CloseHandle = kernel32.func(
    'int __stdcall CloseHandle(void *handle)'
  );
  const GetLastError = kernel32.func(
    'uint32_t __stdcall GetLastError(void)'
  );

  return {
    getForegroundWindow: () => GetForegroundWindow(),
    getWindowId: (windowHandle) => koffi.address(windowHandle).toString(),
    getWindowThreadProcessId(windowHandle) {
      const processId = [0];
      const threadId = GetWindowThreadProcessId(windowHandle, processId);
      if (threadId === 0 || processId[0] === 0) {
        throw new Error(
          `GetWindowThreadProcessId failed (Win32 error ${GetLastError()}).`
        );
      }
      return { processId: processId[0], threadId };
    },
    getWindowTitle(windowHandle) {
      const length = GetWindowTextLengthW(windowHandle);
      if (length <= 0) {
        return '';
      }

      const buffer = Buffer.alloc((length + 1) * 2);
      const copied = GetWindowTextW(windowHandle, buffer, length + 1);
      if (copied <= 0) {
        return '';
      }
      return buffer.toString('utf16le', 0, copied * 2);
    },
    getProcessImagePath(processId) {
      const processHandle = OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION,
        0,
        processId
      );
      if (processHandle == null) {
        throw new Error(
          `OpenProcess(${processId}) failed (Win32 error ${GetLastError()}).`
        );
      }

      try {
        const buffer = Buffer.alloc(MAX_PROCESS_PATH_CHARS * 2);
        const length = [MAX_PROCESS_PATH_CHARS];
        const queried = QueryFullProcessImageNameW(
          processHandle,
          0,
          buffer,
          length
        );
        if (!queried) {
          throw new Error(
            `QueryFullProcessImageNameW(${processId}) failed ` +
              `(Win32 error ${GetLastError()}).`
          );
        }
        return buffer.toString('utf16le', 0, length[0] * 2);
      } finally {
        CloseHandle(processHandle);
      }
    },
  };
}

function createFocusTracker({ api = createNativeFocusApi(), now = Date.now } = {}) {
  if (typeof api.getForegroundWindow !== 'function') {
    throw new TypeError('api.getForegroundWindow must be a function.');
  }

  function captureAtKeyDown() {
    const windowHandle = api.getForegroundWindow();
    if (windowHandle == null) {
      throw new Error('GetForegroundWindow returned NULL.');
    }

    const { processId, threadId } =
      api.getWindowThreadProcessId(windowHandle);
    const imagePath = api.getProcessImagePath(processId);

    return Object.freeze({
      windowId: api.getWindowId(windowHandle),
      processId,
      threadId,
      imagePath,
      exe: path.win32.basename(imagePath),
      title: api.getWindowTitle(windowHandle),
      capturedAt: now(),
    });
  }

  function isTargetForeground(target) {
    if (!target || typeof target.windowId !== 'string') {
      return false;
    }
    const windowHandle = api.getForegroundWindow();
    return (
      windowHandle != null &&
      api.getWindowId(windowHandle) === target.windowId
    );
  }

  return {
    captureAtKeyDown,
    isTargetForeground,
  };
}

module.exports = {
  createFocusTracker,
  createNativeFocusApi,
};
