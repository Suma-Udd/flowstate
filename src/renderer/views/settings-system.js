/* ==========================================================================
   Settings · System — startup, the speech model, and history retention.

   Issue #19 wires every real control here to #17's channels and puts a
   confirmation dialog in front of the two destructive rows (re-download,
   clear history).

   Two rows the #09 mockup carried have no backing config field and are
   dropped rather than wired to nothing: "Keep running when the window
   closes" is not a setting — main.js is a tray-first app unconditionally
   (window-all-closed never quits) — so it becomes a plain statement of fact,
   not a toggle nobody can turn off. "Database" size/count has no durable
   source until History's own issue (#28/#29) lands a real SQLite file; this
   screen shows the honest pre-database buffer count instead of a fabricated
   total.
   ========================================================================== */

(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else (root.FlowViews = root.FlowViews || {})['settings-system'] = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STATUS = {
    loaded: ['is-success', 'Loaded'],
    loading: ['is-warn', 'Loading'],
    missing: ['is-danger', 'Not downloaded']
  };

  /* Real model-manager phases (src/main/model-manager.js getState().phase),
     as opposed to the fixture's decorative loaded/loading/missing status —
     the same mapping dictation.js's speech-model card uses. */
  var PHASE_BADGE = {
    ready: ['is-success', 'Loaded'],
    downloading: ['is-warn', 'Downloading'],
    verifying: ['is-warn', 'Verifying'],
    installing: ['is-warn', 'Installing'],
    checking: ['is-warn', 'Checking'],
    missing: ['is-danger', 'Not downloaded'],
    corrupt: ['is-danger', 'Not downloaded'],
    cancelled: ['is-danger', 'Not downloaded'],
    error: ['is-danger', 'Error']
  };

  var MODEL_DISPLAY = { name: 'Parakeet TDT 0.6B v3', quantisation: 'int8' };

  return {
    fixture: 'settings',

    html: function (ctx, s) {
      var lib = ctx.lib;
      var esc = lib.esc;
      var icon = lib.icon;
      var row = lib.row;
      var sys = s.system;

      var startup = ''
        + row('Start on login', null, sys.autostart.hint,
            lib.toggle('autostart', 'Start on login', sys.autostart.enabled))
        + row('Start minimised to tray', null, sys.startMinimised.hint,
            lib.toggle('minimised', 'Start minimised to tray', sys.startMinimised.enabled))
        + row('Keep running when the window closes',
            'Always on', sys.closeToTray.hint, null);

      var m = sys.model;
      var status = STATUS[m.status] || ['', m.status];

      var model = ''
        + '<div class="row">'
        + '<div class="row-main">'
        + '<p class="row-label">Model</p>'
        + '<p class="row-value" data-model-value>' + esc(m.name) + ' · ' + esc(m.quantisation)
        + ' · ' + lib.num(m.sizeMb) + ' MB</p>'
        + '</div>'
        + '<div class="row-action"><span class="badge ' + status[0] + '" data-model-badge>'
        + esc(status[1]) + '</span></div>'
        + '</div>'

        + '<div class="row">'
        + '<div class="row-main">'
        + '<p class="row-label">Location</p>'
        + '<p class="row-value"><span class="mono" data-model-location>' + esc(m.location) + '</span></p>'
        + '</div>'
        + '<div class="row-action">'
        + '<button type="button" class="btn" data-action="reveal-model">' + icon('folder')
        + '<span>Show</span></button>'
        + '</div>'
        + '</div>'

        + row('Unload when idle', null, m.unloadHint,
            '<label class="visually-hidden" for="unload">Unload when idle</label>'
            + '<select class="select" id="unload" data-unload-select>'
            + m.unloadOptions.map(function (minutes) {
                return '<option value="' + minutes + '"'
                  + (minutes === m.unloadAfterMinutes ? ' selected' : '') + '>'
                  + (minutes === 0 ? 'Never' : minutes + ' minutes') + '</option>';
              }).join('')
            + '</select>')

        + row('Re-download model', 'Removes the local copy and fetches it again', null,
            '<button type="button" class="btn is-danger" data-action="redownload">' + icon('refresh')
            + '<span>Re-download</span></button>');

      var h = sys.history;
      var history = ''
        + row('Keep dictations for', null,
            'Retention also appears on the History screen, next to the data it governs.',
            '<label class="visually-hidden" for="retention">Keep dictations for</label>'
            + '<select class="select" id="retention" data-retention-select>'
            + h.retentionOptions.map(function (option) {
                return '<option value="' + option.days + '"'
                  + (option.days === h.retentionDays ? ' selected' : '') + '>'
                  + esc(option.label) + '</option>';
              }).join('')
            + '</select>')

        + row('Database', null,
            'A durable, cross-restart database lands with History (#28/#29). Until then'
            + ' this counts dictations held in memory since Flowstate last started.',
            '<span class="badge" data-history-count>' + lib.num(h.dictations) + ' dictations</span>')

        + row('Location', '<span class="mono">' + esc(h.location) + '</span>',
            'Local only. Nothing in this file ever leaves the machine.', null)

        + row('Clear history', 'Deletes every dictation held this session', null,
            '<button type="button" class="btn is-danger" data-action="clear-history">' + icon('trash')
            + '<span>Clear history</span></button>');

      return ''
        + '<header class="page-head">'
        + '<div>'
        + '<h1 class="page-title">Settings</h1>'
        + '<p class="page-sub">Everything here persists immediately. There is no Save'
        + ' button because there is nothing to save.</p>'
        + '</div>'
        + '</header>'

        + ctx.tabs('/settings/system')

        + '<div class="stack is-loose">'
        + '<section><h2 class="group-label">Startup</h2>'
        + '<div class="card is-flush"><div class="rows">' + startup + '</div></div></section>'
        + '<section><h2 class="group-label">Speech model</h2>'
        + '<div class="card is-flush"><div class="rows" data-model-rows>' + model + '</div>'
        + '<div class="row-notice" data-model-notice aria-live="polite"></div></div></section>'
        + '<section><h2 class="group-label">History</h2>'
        + '<div class="card is-flush"><div class="rows" data-history-rows>' + history + '</div></div></section>'
        + '</div>';
    },

    mount: function (root, ctx) {
      var lib = ctx.lib;
      var bridge = ctx.bridge;
      var disposed = false;
      var unsubscribers = [];

      function on(unsubscribe) {
        if (typeof unsubscribe === 'function') unsubscribers.push(unsubscribe);
      }
      function guarded(fn) {
        return function () {
          if (disposed) return;
          fn.apply(null, arguments);
        };
      }

      function teardown() {
        disposed = true;
        for (var i = 0; i < unsubscribers.length; i++) unsubscribers[i]();
      }

      if (!bridge) return teardown;

      /* --- startup toggles, live -------------------------------------------- */

      var autostartToggle = root.querySelector('#autostart');
      var minimisedToggle = root.querySelector('#minimised');

      function wireToggle(input, patch) {
        if (!input) return;
        input.addEventListener('change', guarded(function () {
          var checked = input.checked;
          bridge.config.set(patch(checked)).catch(guarded(function () {
            input.checked = !checked;
          }));
        }));
      }
      wireToggle(autostartToggle, function (checked) { return { system: { autostart: checked } }; });
      wireToggle(minimisedToggle, function (checked) { return { system: { startMinimised: checked } }; });

      /* --- speech model card, live ------------------------------------------ */

      var modelBadgeEl = root.querySelector('[data-model-badge]');
      var modelValueEl = root.querySelector('[data-model-value]');
      var modelLocationEl = root.querySelector('[data-model-location]');
      var unloadSelect = root.querySelector('[data-unload-select]');
      var modelRowsEl = root.querySelector('[data-model-rows]');
      var modelNoticeEl = root.querySelector('[data-model-notice]');

      function paintModel(state) {
        var variant = PHASE_BADGE[state.phase] || ['', state.phase];
        var label = variant[1];
        if ((state.phase === 'downloading' || state.phase === 'verifying'
             || state.phase === 'installing') && Number.isFinite(state.percent)) {
          label += ' — ' + state.percent + '%';
        }
        modelBadgeEl.className = 'badge ' + variant[0];
        modelBadgeEl.textContent = label;
        modelValueEl.textContent = MODEL_DISPLAY.name + ' · ' + MODEL_DISPLAY.quantisation
          + ' · ' + lib.num(Math.round(state.totalBytes / (1024 * 1024))) + ' MB';
        modelLocationEl.textContent = state.modelsDirectory;
        if (modelNoticeEl) modelNoticeEl.innerHTML = lib.modelNoticeHtml(state);
      }

      if (bridge.model && typeof bridge.model.status === 'function') {
        bridge.model.status().then(guarded(paintModel)).catch(function (error) {
          if (typeof console !== 'undefined' && console.error) console.error(error);
        });
        if (typeof bridge.model.onProgress === 'function') {
          on(bridge.model.onProgress(guarded(paintModel)));
        }
      }

      if (unloadSelect) {
        unloadSelect.addEventListener('change', guarded(function () {
          var minutes = Number(unloadSelect.value);
          bridge.config.set({ asr: { unloadAfterMinutes: minutes } }).catch(function () {});
        }));
      }

      if (modelRowsEl) {
        modelRowsEl.addEventListener('click', guarded(function (event) {
          var reveal = event.target.closest('[data-action="reveal-model"]');
          if (reveal && bridge.app && typeof bridge.app.reveal === 'function') {
            bridge.app.reveal('model').catch(function () {});
            return;
          }
          var redownload = event.target.closest('[data-action="redownload"]');
          if (!redownload || !bridge.model) return;
          lib.confirmDialog(root.ownerDocument, {
            title: 'Re-download the speech model?',
            body: 'This removes the local copy and fetches it again. Dictation is unavailable '
              + 'until the download finishes.',
            confirmLabel: 'Re-download',
            danger: true
          }).then(guarded(function (confirmed) {
            if (!confirmed) return;
            bridge.model.download().catch(function () {
              /* model.onProgress carries the failure into the badge. */
            });
          }));
        }));
      }

      /* --- history: retention (real) + session count + clear (real, scoped) - */

      var retentionSelect = root.querySelector('[data-retention-select]');
      if (retentionSelect) {
        retentionSelect.addEventListener('change', guarded(function () {
          var days = Number(retentionSelect.value);
          bridge.config.set({ history: { retentionDays: days } }).catch(function () {});
        }));
      }

      var historyCountEl = root.querySelector('[data-history-count]');
      var historyRowsEl = root.querySelector('[data-history-rows]');

      function refreshHistoryCount() {
        if (!bridge.history || typeof bridge.history.recent !== 'function' || !historyCountEl) return;
        bridge.history.recent(10_000).then(guarded(function (entries) {
          var count = Array.isArray(entries) ? entries.length : 0;
          historyCountEl.textContent = lib.num(count) + (count === 1 ? ' dictation' : ' dictations');
        })).catch(function () {
          /* #28 has not landed yet; the fixture's count stays on screen. */
        });
      }
      refreshHistoryCount();

      if (bridge.dictation && typeof bridge.dictation.onResult === 'function') {
        on(bridge.dictation.onResult(guarded(refreshHistoryCount)));
      }

      if (historyRowsEl) {
        historyRowsEl.addEventListener('click', guarded(function (event) {
          var button = event.target.closest('[data-action="clear-history"]');
          if (!button || !bridge.history || typeof bridge.history.clear !== 'function') return;
          lib.confirmDialog(root.ownerDocument, {
            title: 'Clear history?',
            body: 'This deletes every dictation Flowstate is currently holding. This cannot be undone.',
            confirmLabel: 'Clear history',
            danger: true
          }).then(guarded(function (confirmed) {
            if (!confirmed) return;
            bridge.history.clear().then(guarded(refreshHistoryCount)).catch(function () {});
          }));
        }));
      }

      /* --- initial real-data fetch, then live subscriptions ------------------ */

      if (bridge.config && typeof bridge.config.get === 'function') {
        bridge.config.get().then(guarded(function (config) {
          if (autostartToggle) autostartToggle.checked = config.system.autostart;
          if (minimisedToggle) minimisedToggle.checked = config.system.startMinimised;
          if (unloadSelect) unloadSelect.value = String(config.asr.unloadAfterMinutes);
          if (retentionSelect) retentionSelect.value = String(config.history.retentionDays);
        })).catch(function (error) {
          if (typeof console !== 'undefined' && console.error) console.error(error);
        });

        if (typeof bridge.config.onChange === 'function') {
          on(bridge.config.onChange(guarded(function (config) {
            if (autostartToggle) autostartToggle.checked = config.system.autostart;
            if (minimisedToggle) minimisedToggle.checked = config.system.startMinimised;
            if (unloadSelect) unloadSelect.value = String(config.asr.unloadAfterMinutes);
            if (retentionSelect) retentionSelect.value = String(config.history.retentionDays);
          })));
        }
      }

      return teardown;
    }
  };
});
