/* ==========================================================================
   Dictation — the home screen. What you see when you open the app.

   `html()` still renders from the #09 fixture: it is the graceful initial
   paint (and, over http with no bridge, the whole story), and it is what
   tests/shell.test.js exercises directly. Issue #18's job is `mount()` — once
   the screen is up, it replaces the hotkey chord, the microphone list, the
   speech model card and the language chips with the real channels from #17,
   starts a live microphone level meter (a new small capability this issue
   adds: src/main/mic-preview.js), and wires the "test your setup" button to
   src/main/test-run.js. The "Recent dictations" list tries the real history
   channel and only keeps the fixture rows if that channel is not there yet —
   #28 is what makes it answer.
   ========================================================================== */

(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else (root.FlowViews = root.FlowViews || {}).dictation = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STATUS = {
    loaded: ['is-success', 'Loaded'],
    loading: ['is-warn', 'Loading'],
    missing: ['is-danger', 'Not downloaded']
  };

  /* Mirrors MIN_HOLD_MS in src/main/dictation.js. This is a fixed app
     behaviour, not a per-user setting, so it is a constant here rather than a
     config field there is nothing to fetch. */
  var TAP_CANCEL_MS = 300;

  /* config.hotkey.chord stores uiohook's canonical code — src/main/hotkey.js's
     KEY_CODES has no "Win", only "Meta" — but the key cap should say what is
     printed on the keyboard. Every other token (Ctrl, Alt, Shift, letters) is
     already display-ready. */
  var KEY_LABEL = { Meta: 'Win' };
  function keyLabel(key) { return KEY_LABEL[key] || key; }

  /* Real model-manager phases (src/main/model-manager.js getState().phase),
     as opposed to the fixture's decorative loaded/loading/missing status. */
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

  /* Static, correct facts about the one model this app ships — not a
     statistic, so a constant is honest here. size/location come from the
     model manager at runtime. */
  var MODEL_DISPLAY = { name: 'Parakeet TDT 0.6B v3', quantisation: 'int8' };

  function chordHtml(esc, chord) {
    return chord.map(function (key) {
      return '<kbd class="kbd">' + esc(keyLabel(key)) + '</kbd>';
    }).join('<span class="chord-plus" aria-hidden="true">+</span>');
  }

  function chordHintText(tapCancelMs) {
    return 'Hold to talk. A tap under ' + tapCancelMs
      + ' ms cancels silently, so a mistyped chord never leaves an empty dictation behind.';
  }

  function micOptionHtml(esc, mic, selectedDeviceId) {
    return '<option value="' + esc(mic.deviceId) + '"'
      + (mic.deviceId === selectedDeviceId ? ' selected' : '') + '>'
      + esc(mic.label) + (mic.isDefault ? ' — system default' : '')
      + '</option>';
  }

  function languageChipsHtml(esc, langLabel, enabledCodes) {
    return ['en', 'de', 'el'].map(function (code) {
      var enabled = enabledCodes.indexOf(code) !== -1;
      return '<button type="button" class="chip" aria-pressed="' + (enabled ? 'true' : 'false')
        + '" lang="' + esc(code) + '">' + esc(langLabel(code)) + '</button>';
    }).join('');
  }

  function modelRows(lib, model) {
    var esc = lib.esc;
    var rows = [
      ['Model', esc(model.name) + ' · ' + esc(model.quantisation), null],
      ['On disk', lib.num(model.sizeMb) + ' MB', null],
      ['Cold load', lib.num(model.coldLoadMs) + ' ms', 'Paid once at startup, then the model stays warm.'],
      ['Unload when idle', 'After ' + model.unloadAfterMinutes + ' minutes', null]
    ];

    return rows.map(function (row) {
      return '<div class="row"><div class="row-main">'
        + '<p class="row-label">' + row[0] + '</p>'
        + '<p class="row-value">' + row[1] + '</p>'
        + (row[2] ? '<p class="row-hint">' + esc(row[2]) + '</p>' : '')
        + '</div></div>';
    }).join('')
      + '<div class="row"><div class="row-main">'
      + '<p class="row-label">Location</p>'
      + '<p class="row-value"><span class="mono">' + esc(model.location) + '</span></p>'
      + '</div><div class="row-action">'
      + '<button type="button" class="btn" data-action="redownload">' + lib.icon('refresh') + '<span>Re-download</span></button>'
      + '</div></div>';
  }

  /* The real model-manager tracks download bytes and a phase, not a friendly
     name, a cold-load time or an on-disk size — those either do not exist yet
     (cold load is never surfaced over IPC) or mean something different
     (state.totalBytes is the download size, not the extracted size). Rows
     this cannot honestly fill are omitted rather than guessed. */
  function realModelRows(lib, state, config) {
    var esc = lib.esc;
    var rows = [
      ['Model', esc(MODEL_DISPLAY.name) + ' · ' + esc(MODEL_DISPLAY.quantisation), null],
      ['Download size', lib.num(Math.round(state.totalBytes / (1024 * 1024))) + ' MB', null]
    ];
    if (config && config.asr) {
      rows.push(['Unload when idle', 'After ' + config.asr.unloadAfterMinutes + ' minutes', null]);
    }

    return rows.map(function (row) {
      return '<div class="row"><div class="row-main">'
        + '<p class="row-label">' + row[0] + '</p>'
        + '<p class="row-value">' + row[1] + '</p>'
        + (row[2] ? '<p class="row-hint">' + esc(row[2]) + '</p>' : '')
        + '</div></div>';
    }).join('')
      + '<div class="row"><div class="row-main">'
      + '<p class="row-label">Location</p>'
      + '<p class="row-value"><span class="mono">' + esc(state.modelsDirectory) + '</span></p>'
      + '</div><div class="row-action">'
      + '<button type="button" class="btn" data-action="redownload">' + lib.icon('refresh') + '<span>Re-download</span></button>'
      + '</div></div>';
  }

  /* <ul> may only contain <li>: the empty state is a sibling the caller
     swaps the list for, never a <div> nested inside it. */
  function recentListHtml(lib, entries) {
    if (!entries || entries.length === 0) {
      return lib.emptyState('clock', 'No dictations yet',
        'Hold your hotkey and start talking — your last five land here.', null);
    }
    return '<ul class="list" data-recent>' + recentItemsHtml(lib, entries) + '</ul>';
  }

  function recentItemsHtml(lib, entries) {
    var esc = lib.esc;
    var icon = lib.icon;
    return entries.map(function (recent) {
      return '<li class="list-item">'
        + '<div class="list-main">'
        + '<p class="list-title clamp-2" lang="' + esc(recent.lang) + '">'
        + esc(recent.text) + '</p>'
        + '<p class="list-meta">'
        + '<span>' + esc(recent.app.label) + '</span><span aria-hidden="true">·</span>'
        + '<time datetime="' + esc(recent.at) + '">' + esc(recent.relative) + '</time>'
        + '<span aria-hidden="true">·</span>'
        + '<span class="num">' + recent.words + ' words</span>'
        + lib.langBadge(recent.lang)
        + '</p>'
        + '</div>'
        + '<div class="list-actions">'
        + '<button type="button" class="btn-icon" aria-label="Copy this dictation">'
        + icon('copy') + '</button>'
        + '</div>'
        + '</li>';
    }).join('');
  }

  return {
    fixture: 'dictation',

    html: function (ctx, d) {
      var lib = ctx.lib;
      var esc = lib.esc;
      var icon = lib.icon;

      var selected = d.microphones.filter(function (mic) {
        return mic.deviceId === d.selectedDeviceId;
      })[0];

      var status = STATUS[d.model.status] || ['', d.model.status];

      return ''
        + '<header class="page-head">'
        + '<div>'
        + '<h1 class="page-title">Dictation</h1>'
        + '<p class="page-sub">Hold the hotkey, speak, release. The cleaned-up text'
        + ' appears at the caret in whatever you were using.</p>'
        + '</div>'
        + '<div class="page-actions">'
        + '<button type="button" class="btn is-primary on-accent" data-test-run>' + icon('play')
        + '<span>Test your setup</span></button>'
        + '</div>'
        + '</header>'

        + '<div data-test-notice aria-live="polite"></div>'

        + '<div class="grid is-2">'

        /* Real <kbd> elements rather than styled spans: it is the correct
           element for a key cap and it reads correctly to a screen reader. */
        + '<section class="card">'
        + '<div class="card-head"><h2 class="card-title">Hotkey</h2></div>'
        + '<div class="chord" data-chord>' + chordHtml(esc, d.hotkey.chord) + '</div>'
        + '<p class="chord-hint" data-chord-hint>' + esc(chordHintText(TAP_CANCEL_MS)) + '</p>'
        + '</section>'

        + '<section class="card">'
        + '<div class="card-head">'
        + '<h2 class="card-title">Microphone</h2>'
        + '<span class="card-meta" data-level-peak>Peak ' + Math.round(d.inputLevel.peak * 100) + '%</span>'
        + '</div>'
        + '<div class="stack">'
        + '<div class="field">'
        + '<label class="field-label" for="mic">Input device</label>'
        + '<select class="select" id="mic" data-mic-select>'
        + d.microphones.map(function (mic) {
            return micOptionHtml(esc, mic, d.selectedDeviceId);
          }).join('')
        + '</select>'
        + '<p class="field-hint" data-mic-hint>' + esc(selected && selected.note
            ? selected.note
            : 'Wideband capture at 16 kHz, which is what the model expects.') + '</p>'
        + '<div data-mic-error aria-live="polite"></div>'
        + '</div>'
        /* Bars scale on transform, never height, so the live meter in #18 can
           run at 30Hz without laying out a frame. */
        + '<div>'
        + '<div class="meter" data-meter role="img" aria-label="Input level meter">'
        + d.inputLevel.bars.map(function () { return '<span class="meter-bar"></span>'; }).join('')
        + '</div>'
        + '<div class="meter-scale"><span>Silent</span><span>Speaking</span></div>'
        + '</div>'
        + '</div>'
        + '</section>'

        + '</div>'

        + '<div class="grid is-2">'

        + '<section class="card">'
        + '<div class="card-head">'
        + '<h2 class="card-title">Languages</h2>'
        + '<span class="card-meta">Auto-detect</span>'
        + '</div>'
        + '<div class="chip-group" data-langs>'
        + d.languages.map(function (language) {
            return '<button type="button" class="chip" aria-pressed="'
              + (language.enabled ? 'true' : 'false') + '" lang="' + esc(language.code) + '">'
              + esc(language.native) + '</button>';
          }).join('')
        + '</div>'
        + '<p class="card-note" data-detect-note>Auto-detect is on. Flowstate works out the language of'
        + ' each dictation. Enabling fewer languages does not make detection faster.</p>'
        + '</section>'

        + '<section class="card">'
        + '<div class="card-head">'
        + '<h2 class="card-title">Speech model</h2>'
        + '<span class="badge ' + status[0] + '" data-model-badge>' + esc(status[1]) + '</span>'
        + '</div>'
        + '<div class="rows" data-model-rows>' + modelRows(lib, d.model) + '</div>'
        + '<div data-model-notice aria-live="polite"></div>'
        + '</section>'

        + '</div>'

        + '<div class="grid">'
        + '<section class="card is-flush">'
        + '<div class="card-head">'
        + '<h2 class="card-title">Recent dictations</h2>'
        + '<span class="card-meta">Click to copy</span>'
        + '</div>'
        + '<div data-recent-wrap>' + recentListHtml(lib, d.recent) + '</div>'
        + '</section>'
        + '</div>';
    },

    /* The bar levels are set through the CSSOM rather than written as style
       attributes, so the renderer's Content-Security-Policy has no reason to
       allow inline styles for a value that changes 30 times a second. */
    mount: function (root, ctx, d) {
      var lib = ctx.lib;
      var esc = lib.esc;
      var icon = lib.icon;
      var bars = root.querySelectorAll('[data-meter] .meter-bar');
      for (var i = 0; i < bars.length; i++) {
        bars[i].style.setProperty('--level', String(d.inputLevel.bars[i]));
      }

      var bridge = ctx.bridge;
      if (!bridge) return function () {};

      var disposed = false;
      var unsubscribers = [];
      var currentDeviceId = d.selectedDeviceId;

      function on(unsubscribe) {
        if (typeof unsubscribe === 'function') unsubscribers.push(unsubscribe);
      }

      function guarded(fn) {
        return function () {
          if (disposed) return;
          fn.apply(null, arguments);
        };
      }

      /* --- hotkey chord, live -------------------------------------------- */

      function paintChord(chord) {
        root.querySelector('[data-chord]').innerHTML = chordHtml(esc, chord);
      }

      /* --- languages, live ------------------------------------------------ */

      function paintLanguages(enabledCodes) {
        root.querySelector('[data-langs]').innerHTML =
          languageChipsHtml(esc, lib.langLabel, enabledCodes);
      }

      function applyConfig(config) {
        paintChord(config.hotkey.chord);
        paintLanguages(config.asr.languages);
        return config;
      }

      /* --- auto-detect note, updated by whatever the session has actually
         heard: a real dictation (dictation.onResult) or a test run. ---- */

      function paintDetected(lang) {
        root.querySelector('[data-detect-note]').innerHTML =
          'Auto-detect is on. The last dictation was detected as <strong>'
          + esc(lib.langLabel(lang))
          + '</strong>. Enabling fewer languages does not make detection faster.';
      }

      /* --- microphone list + hint, live ------------------------------------ */

      var micSelect = root.querySelector('[data-mic-select]');
      var micHint = root.querySelector('[data-mic-hint]');
      var micError = root.querySelector('[data-mic-error]');

      function paintMics(mics) {
        micSelect.innerHTML = mics.length === 0
          ? '<option value="" disabled selected>No microphone found</option>'
          : mics.map(function (mic) {
              return micOptionHtml(esc, mic, currentDeviceId);
            }).join('');
        if (!mics.some(function (mic) { return mic.deviceId === currentDeviceId; })) {
          currentDeviceId = mics[0] ? mics[0].deviceId : null;
          if (micSelect.value !== null) micSelect.value = currentDeviceId;
        }
        micHint.textContent = 'Wideband capture at 16 kHz, which is what the model expects.';
      }

      /* --- live level meter -------------------------------------------------

         A fresh, honest buffer: it starts flat rather than keeping the
         fixture's waveform on screen once real capture begins, because that
         waveform belongs to nobody's actual voice. */

      var levels = new Array(bars.length).fill(0);
      var peakEl = root.querySelector('[data-level-peak]');

      function paintLevels() {
        var peak = 0;
        for (var index = 0; index < bars.length; index++) {
          var level = levels[index];
          if (level > peak) peak = level;
          bars[index].style.setProperty('--level', String(level));
        }
        peakEl.textContent = 'Peak ' + Math.round(peak * 100) + '%';
      }

      var offLevel = bridge.micPreview && bridge.micPreview.onLevel
        ? bridge.micPreview.onLevel(guarded(function (level) {
            levels.shift();
            levels.push(level);
            paintLevels();
          }))
        : null;
      on(offLevel);

      var offMicError = bridge.micPreview && bridge.micPreview.onError
        ? bridge.micPreview.onError(guarded(function (message) {
            micError.innerHTML = '<div class="notice is-danger">' + icon('alert')
              + '<p>' + esc(message) + '</p></div>';
          }))
        : null;
      on(offMicError);

      function startPreview(deviceId) {
        if (!bridge.micPreview || typeof bridge.micPreview.start !== 'function') return;
        micError.innerHTML = '';
        levels.fill(0);
        paintLevels();
        bridge.micPreview.start(deviceId).catch(function () {
          /* onError already surfaces the reason through the push channel. */
        });
      }

      /* --- speech model card, live ------------------------------------------ */

      var modelBadgeEl = root.querySelector('[data-model-badge]');
      var modelRowsEl = root.querySelector('[data-model-rows]');
      var modelNoticeEl = root.querySelector('[data-model-notice]');
      var latestConfig = null;

      function paintModel(state) {
        var variant = PHASE_BADGE[state.phase] || ['', state.phase];
        var label = variant[1];
        if ((state.phase === 'downloading' || state.phase === 'verifying'
             || state.phase === 'installing') && Number.isFinite(state.percent)) {
          label += ' — ' + state.percent + '%';
        }
        modelBadgeEl.className = 'badge ' + variant[0];
        modelBadgeEl.textContent = label;
        modelRowsEl.innerHTML = realModelRows(lib, state, latestConfig);
        modelNoticeEl.innerHTML = lib.modelNoticeHtml(state);
      }

      modelRowsEl.addEventListener('click', guarded(function (event) {
        var button = event.target.closest('[data-action="redownload"]');
        if (!button || !bridge.model) return;
        bridge.model.download().catch(function () {
          /* model.onProgress carries the failure into the badge/rows. */
        });
      }));

      /* --- test your setup --------------------------------------------------- */

      var testButton = root.querySelector('[data-test-run]');
      var testNotice = root.querySelector('[data-test-notice]');

      function showNotice(text, isError) {
        testNotice.innerHTML = '<div class="notice' + (isError ? ' is-danger' : '') + '">'
          + icon(isError ? 'alert' : 'check') + '<p>' + esc(text) + '</p></div>';
      }

      if (testButton && bridge.dictation && typeof bridge.dictation.testRun === 'function') {
        testButton.addEventListener('click', guarded(function () {
          testButton.disabled = true;
          testNotice.innerHTML = '';
          bridge.dictation.testRun().then(guarded(function (result) {
            testButton.disabled = false;
            paintDetected(result.lang);
            showNotice('Heard: “' + result.text + '” (' + lib.langLabel(result.lang) + ').', false);
          }), guarded(function (error) {
            testButton.disabled = false;
            showNotice(error && error.message ? error.message : String(error), true);
          }));
        }));
      }

      if (bridge.dictation && typeof bridge.dictation.onResult === 'function') {
        on(bridge.dictation.onResult(guarded(function (result) {
          if (result && result.lang) paintDetected(result.lang);
          /* A real dictation that transcribed fine but did not land: named
             here rather than left to the pill alone, because the pill is
             gone in three seconds and this is the one place that says why
             and what to do about it (the text is not lost — it is on the
             clipboard) until it lands. */
          if (result && result.injection && result.injection.ok === false) {
            var reason = result.injection.message || 'The dictation could not be pasted.';
            showNotice(reason, true);
          }
        })));
      }

      /* --- microphone selection, live ---------------------------------------- */

      micSelect.addEventListener('change', guarded(function () {
        currentDeviceId = micSelect.value;
        startPreview(currentDeviceId);
        if (bridge.config && typeof bridge.config.set === 'function') {
          bridge.config.set({ audio: { deviceId: currentDeviceId } }).catch(function () {
            /* Geometry-class settings are not worth interrupting the user
               over; the next config.onChange resolves the real value. */
          });
        }
      }));

      /* --- initial real-data fetch, then live subscriptions ------------------ */

      if (bridge.config && typeof bridge.config.get === 'function') {
        bridge.config.get().then(guarded(function (config) {
          latestConfig = config;
          applyConfig(config);
          currentDeviceId = config.audio.deviceId
            || (micSelect.options[0] && micSelect.options[0].value)
            || null;
          startPreview(currentDeviceId);
        })).catch(function (error) {
          if (typeof console !== 'undefined' && console.error) console.error(error);
        });

        if (typeof bridge.config.onChange === 'function') {
          on(bridge.config.onChange(guarded(function (config) {
            latestConfig = config;
            applyConfig(config);
            if (config.audio.deviceId !== currentDeviceId) {
              currentDeviceId = config.audio.deviceId;
              startPreview(currentDeviceId);
            }
          })));
        }
      }

      if (bridge.mics && typeof bridge.mics.list === 'function') {
        bridge.mics.list().then(guarded(paintMics)).catch(guarded(function (error) {
          if (typeof console !== 'undefined' && console.error) console.error(error);
          // Never leave the fixture devices on screen as if they were real.
          micSelect.innerHTML = '<option value="" disabled selected>No microphone found</option>';
          micError.innerHTML = '<div class="notice is-danger">' + icon('alert')
            + '<p>Microphones are unavailable: ' + esc(lib.ipcErrorMessage(error))
            + '</p></div>';
        }));
        if (typeof bridge.mics.onDeviceChange === 'function') {
          on(bridge.mics.onDeviceChange(guarded(paintMics)));
        }
      }

      if (bridge.model && typeof bridge.model.status === 'function') {
        bridge.model.status().then(guarded(paintModel)).catch(function (error) {
          if (typeof console !== 'undefined' && console.error) console.error(error);
        });
        if (typeof bridge.model.onProgress === 'function') {
          on(bridge.model.onProgress(guarded(paintModel)));
        }
      }

      if (bridge.history && typeof bridge.history.recent === 'function') {
        bridge.history.recent(5).then(guarded(function (entries) {
          if (Array.isArray(entries)) {
            root.querySelector('[data-recent-wrap]').innerHTML = recentListHtml(lib, entries);
          }
        })).catch(function () {
          /* #28 has not landed yet; the fixture rows already on screen stay. */
        });
      }

      return function teardown() {
        disposed = true;
        for (var index = 0; index < unsubscribers.length; index++) unsubscribers[index]();
        if (bridge.micPreview && typeof bridge.micPreview.stop === 'function') {
          bridge.micPreview.stop().catch(function () {});
        }
      };
    }
  };
});
