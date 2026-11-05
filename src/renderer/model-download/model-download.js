'use strict';

const progress = document.querySelector('[data-progress]');
const percent = document.querySelector('[data-percent]');
const title = document.querySelector('[data-status-title]');
const detail = document.querySelector('[data-status-detail]');
const error = document.querySelector('[data-error]');
const cancel = document.querySelector('[data-cancel]');
const download = document.querySelector('[data-download]');

const COPY = Object.freeze({
  checking: ['Checking local files…', 'Verifying the model cache.'],
  missing: ['Preparing download…', 'About 488 MB to download and roughly 650 MB on disk.'],
  corrupt: ['A fresh copy is needed', 'The local model did not pass its integrity check.'],
  downloading: ['Downloading speech recognition…', 'You can cancel and resume from this point later.'],
  verifying: ['Verifying the download…', 'Checking the SHA-256 integrity digest.'],
  installing: ['Installing the speech model…', 'This stays outside the app so updates can reuse it.'],
  cancelled: ['Download paused', 'Your progress is saved. Resume whenever you are ready.'],
  error: ['The model could not be installed', 'Nothing corrupt will be loaded. Retry when ready.'],
  ready: ['Ready to dictate', 'The model passed its integrity checks.'],
});

function render(status) {
  const phase = COPY[status?.phase] ? status.phase : 'error';
  const [heading, description] = COPY[phase];
  const value = Math.max(0, Math.min(100, Number(status?.percent) || 0));
  title.textContent = heading;
  detail.textContent = description;
  percent.textContent = `${value.toFixed(value % 1 ? 1 : 0)}%`;
  progress.value = value;
  progress.textContent = percent.textContent;

  const active = phase === 'downloading';
  cancel.hidden = !active;
  cancel.disabled = !active;
  download.hidden = !['missing', 'corrupt', 'cancelled', 'error'].includes(phase);
  download.textContent =
    phase === 'cancelled'
      ? 'Resume download'
      : phase === 'error'
        ? 'Try again'
        : 'Download model';

  error.hidden = !status?.error;
  error.textContent = status?.error || '';
}

window.flowModel.onStatus(render);
window.flowModel.status().then(render);
cancel.addEventListener('click', () => window.flowModel.cancel());
download.addEventListener('click', () => {
  download.disabled = true;
  window.flowModel.download().finally(() => {
    download.disabled = false;
  });
});
