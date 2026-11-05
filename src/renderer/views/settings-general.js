/* ==========================================================================
   Settings · General

   Grouped rows, one label and one control per line. There is no
   Save button anywhere in Flowstate — everything persists the moment it changes,
   which is why no row has a dirty state to show.

   Issue #19 wires every row in this file to #17's real channels: the shortcut
   through a live hold-and-release rebind capture, the microphone list through
   `mics.list()`/`onDeviceChange`, the language chips as real toggles (#18
   deliberately left them read-only — this issue is what makes them live), and
   the cleanup toggle through `llm.enabled`, and filler removal through the
   prompt-level `llm.removeFillers` preference.
   ========================================================================== */

(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else (root.FlowViews = root.FlowViews || {})['settings-general'] = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var THEME_OPTIONS = [
    { key: 'light', label: 'Light' },
    { key: 'dark', label: 'Dark' },
    { key: 'system', label: 'System' }
  ];

  var ALL_LANGUAGES = ['en', 'de', 'el'];

  /* Mirrors dictation.js: config.hotkey.chord stores uiohook's canonical
     "Meta" (src/main/hotkey.js's KEY_CODES has no "Win"), but the key cap
     should say what is printed on the keyboard. */
  var KEY_LABEL = { Meta: 'Win' };
  function keyLabel(key) { return KEY_LABEL[key] || key; }

  function chordHtml(esc, chord) {
    return chord.map(function (key) {
      return '<kbd class="kbd">' + esc(keyLabel(key)) + '</kbd>';
    }).join(' <span aria-hidden="true">+</span> ');
  }

  function micOptionHtml(esc, mic, selectedDeviceId) {
    return '<option value="' + esc(mic.deviceId) + '"'
      + (mic.deviceId === selectedDeviceId ? ' selected' : '') + '>'
      + esc(mic.label) + (mic.isDefault ? ' — system default' : '')
      + '</option>';
  }

  var PROVIDER_LABEL = { deepseek: 'DeepSeek', openai: 'OpenAI', groq: 'Groq', openrouter: 'OpenRouter', custom: 'your custom provider' };
  function providerLabel(id) { return PROVIDER_LABEL[id] || id; }

  /* Cleanup is switched on but there is no key to reach the provider with: a
     real, derivable state (config.llm.apiKeyConfigured), not a guess at
     whether the network happens to be up. Until a key is saved, every
     transcript is pasted exactly as heard, which is a fine way to work. */
  function cleanupNoticeHtml(esc, icon, provider) {
    return '<div class="notice">' + icon('info')
      + '<p>No ' + esc(provider) + ' key yet, so transcripts are pasted exactly as heard.'
      + ' Add a key below to get punctuation and filler removal.</p></div>';
  }

  function languageChipsHtml(esc, langLabel, enabledCodes) {
    return ALL_LANGUAGES.map(function (code) {
      var enabled = enabledCodes.indexOf(code) !== -1;
      return '<button type="button" class="chip" aria-pressed="' + (enabled ? 'true' : 'false')
        + '" lang="' + esc(code) + '">' + esc(langLabel(code)) + '</button>';
    }).join('');
  }

  return {
    fixture: 'settings',

    html: function (ctx, s) {
      var lib = ctx.lib;
      var esc = lib.esc;
      var icon = lib.icon;
      var row = lib.row;
      var g = s.general;

      var shortcut = ''
        + '<div class="row" data-shortcut-row>'
        + '<div class="row-main">'
        + '<p class="row-label">Shortcut</p>'
        + '<div class="chord" data-chord>' + chordHtml(esc, g.hotkey.chord) + '</div>'
        + '<p class="row-hint" data-shortcut-hint aria-live="polite">' + esc(g.hotkey.hint) + '</p>'
        + '</div>'
        + '<div class="row-action">'
        + '<button type="button" class="btn" data-action="change-shortcut">' + icon('pencil')
        + '<span data-shortcut-btn-label>Change</span></button>'
        + '</div>'
        + '</div>';

      var mic = ''
        + '<div class="row" data-mic-row>'
        + '<div class="row-main">'
        + '<p class="row-label">Microphone</p>'
        + '<p class="row-hint" data-mic-hint>' + esc(g.microphone.hint) + '</p>'
        + '<div data-mic-error aria-live="polite"></div>'
        + '</div>'
        + '<div class="row-action">'
        + '<label class="visually-hidden" for="mic">Microphone</label>'
        + '<select class="select" id="mic" data-mic-select>'
        + '<option selected>' + esc(g.microphone.selectedLabel) + '</option>'
        + '</select>'
        + '</div>'
        + '</div>';

      var dictation = shortcut + mic
        + row('Dictation languages', null, g.languages.hint,
            '<div class="chip-group" data-langs>' + languageChipsHtml(esc, lib.langLabel, g.languages.enabled)
            + '</div>');

      var c = g.cleanup;
      var apiKeyMissing = c.enabled && c.apiKeyConfigured === false;
      var cleanup = row('Clean up transcripts',
          esc(c.provider) + ' · ' + lib.num(c.timeoutMs)
          + ' ms hard timeout · skip under ' + c.skipUnderWords + ' words',
          c.hint,
          '<label class="visually-hidden" for="cleanup">Clean up transcripts</label>'
          + lib.toggle('cleanup', 'Clean up transcripts', c.enabled))
        + '<div class="row-notice" data-cleanup-notice aria-live="polite">'
        + (apiKeyMissing ? cleanupNoticeHtml(esc, icon, c.provider) : '')
        + '</div>';
      var fillers = row('Remove filler words', null, g.fillers.hint,
          '<label class="visually-hidden" for="fillers">Remove filler words</label>'
          + lib.toggle(
            'fillers',
            'Remove filler words',
            g.fillers.removeFillers
          ));

      /* Light / Dark / System as radio inputs behind labels: one arrow-key group,
         correct semantics, and no JS needed for the control itself. The mode comes
         from the shell, which took it from main — never from the fixture, because
         this row is real. */
      var appearance = row('Theme', null,
        'System follows Windows live — changing the OS theme re-themes Flowstate'
        + ' without a restart.',
        '<div class="segmented" role="radiogroup" aria-label="Theme" data-theme-group>'
          + THEME_OPTIONS.map(function (option) {
              return '<label><input type="radio" name="theme" class="visually-hidden"'
                + ' value="' + option.key + '"'
                + (option.key === ctx.theme.mode ? ' checked' : '') + '>'
                + esc(option.label) + '</label>';
            }).join('')
          + '</div>');

      return ''
        + '<header class="page-head">'
        + '<div>'
        + '<h1 class="page-title">Settings</h1>'
        + '<p class="page-sub">Everything here persists immediately. There is no Save'
        + ' button because there is nothing to save.</p>'
        + '</div>'
        + '</header>'

        + ctx.tabs('/settings/general')

        + '<div class="stack is-loose">'
        + '<section><h2 class="group-label">Dictation</h2>'
        + '<div class="card is-flush"><div class="rows">' + dictation + '</div></div></section>'
        + '<section><h2 class="group-label">Cleanup</h2>'
        + '<div class="card is-flush"><div class="rows">' + cleanup + fillers + '</div></div>'
        + '<div class="card" data-provider-card><div class="card-head"><h2 class="card-title">Cleanup service</h2></div>'
        + '<div data-provider-slot>' + (ctx.views && ctx.views['cleanup-provider'] ? ctx.views['cleanup-provider'].shell() : '') + '</div>'
        + '</div></section>'
        + '<section><h2 class="group-label">Appearance</h2>'
        + '<div class="card is-flush"><div class="rows">' + appearance + '</div></div></section>'
        + '</div>';
    },

    mount: function (root, ctx) {
      var lib = ctx.lib;
      var esc = lib.esc;

      var group = root.querySelector('[data-theme-group]');

      function onThemeChange(event) {
        var input = event.target;
        if (!input || input.name !== 'theme') return;
        /* If the write fails, the shell restores the mode it had, so the control
           must stop claiming the one that did not stick. */
        ctx.setTheme(input.value).catch(function (error) {
          var actual = group.querySelector(
            'input[value="' + (root.ownerDocument.documentElement.getAttribute('data-theme-mode') || 'system') + '"]');
          if (actual) actual.checked = true;
          if (typeof console !== 'undefined' && console.error) console.error(error);
        });
      }
      group.addEventListener('change', onThemeChange);

      var bridge = ctx.bridge;
      var unsubscribers = [group ? function () { group.removeEventListener('change', onThemeChange); } : null];
      var disposed = false;

      function on(unsubscribe) {
        if (typeof unsubscribe === 'function') unsubscribers.push(unsubscribe);
      }
      function guarded(fn) {
        return function () {
          if (disposed) return;
          fn.apply(null, arguments);
        };
      }

      if (!bridge) {
        return function teardown() {
          disposed = true;
          for (var i = 0; i < unsubscribers.length; i++) if (unsubscribers[i]) unsubscribers[i]();
        };
      }

      /* --- shortcut: live chord + rebind capture --------------------------- */

      var shortcutHint = root.querySelector('[data-shortcut-hint]');
      var shortcutButton = root.querySelector('[data-action="change-shortcut"]');
      var shortcutButtonLabel = root.querySelector('[data-shortcut-btn-label]');
      var chordEl = root.querySelector('[data-chord]');
      var defaultHint = 'Hold to talk. A tap under 300 ms cancels silently.';
      var rebinding = false;

      function paintChord(chord) {
        chordEl.innerHTML = chordHtml(esc, chord);
      }

      function setRebinding(active) {
        rebinding = active;
        shortcutButtonLabel.textContent = active ? 'Cancel' : 'Change';
        shortcutHint.textContent = active
          ? 'Press your new shortcut, or Escape to cancel.'
          : defaultHint;
        shortcutHint.classList.remove('is-danger');
      }

      function showRebindError(reason) {
        shortcutHint.textContent = reason;
        shortcutHint.classList.add('is-danger');
      }

      if (bridge.hotkey && shortcutButton) {
        if (typeof bridge.hotkey.onRebindResult === 'function') {
          on(bridge.hotkey.onRebindResult(guarded(function (result) {
            setRebinding(false);
            if (result.status === 'accepted') {
              paintChord(result.chord);
            } else if (result.status === 'rejected') {
              showRebindError(result.reason || 'That shortcut could not be used.');
            }
            // 'cancelled': silently return to the previous chord and hint.
          })));
        }

        shortcutButton.addEventListener('click', guarded(function () {
          if (rebinding) {
            if (typeof bridge.hotkey.cancelRebind === 'function') {
              bridge.hotkey.cancelRebind().catch(function () {});
            }
            setRebinding(false);
            return;
          }
          if (typeof bridge.hotkey.startRebind !== 'function') return;
          bridge.hotkey.startRebind().then(guarded(function () {
            setRebinding(true);
          }), guarded(function (error) {
            showRebindError(error && error.message ? error.message : String(error));
          }));
        }));

        var onKeydown = guarded(function (event) {
          if (rebinding && event.key === 'Escape') {
            if (typeof bridge.hotkey.cancelRebind === 'function') {
              bridge.hotkey.cancelRebind().catch(function () {});
            }
            setRebinding(false);
          }
        });
        root.ownerDocument.addEventListener('keydown', onKeydown);
        on(function () { root.ownerDocument.removeEventListener('keydown', onKeydown); });
      }

      /* --- microphone list + selection, live ------------------------------- */

      var micSelect = root.querySelector('[data-mic-select]');
      var micHint = root.querySelector('[data-mic-hint]');
      var micError = root.querySelector('[data-mic-error]');
      var currentDeviceId = null;

      function paintMics(mics) {
        micSelect.innerHTML = mics.length === 0
          ? '<option value="" disabled selected>No microphone found</option>'
          : mics.map(function (m) {
              return micOptionHtml(esc, m, currentDeviceId);
            }).join('');
        if (!mics.some(function (m) { return m.deviceId === currentDeviceId; })) {
          currentDeviceId = mics[0] ? mics[0].deviceId : null;
          if (currentDeviceId !== null) micSelect.value = currentDeviceId;
        }
        var selected = mics.filter(function (m) { return m.deviceId === currentDeviceId; })[0];
        micHint.textContent = selected && selected.note
          ? selected.note
          : 'Bluetooth headsets drop to the narrowband hands-free profile when the mic opens.';
      }

      if (micSelect) {
        micSelect.addEventListener('change', guarded(function () {
          currentDeviceId = micSelect.value;
          if (bridge.config && typeof bridge.config.set === 'function') {
            bridge.config.set({ audio: { deviceId: currentDeviceId } }).catch(function () {
              /* The next config.onChange resolves the real value. */
            });
          }
        }));

        if (bridge.mics && typeof bridge.mics.list === 'function') {
          bridge.mics.list().then(guarded(paintMics)).catch(guarded(function (error) {
            if (typeof console !== 'undefined' && console.error) console.error(error);
            // Never leave the fixture device on screen as if it were real.
            micSelect.innerHTML = '<option value="" disabled selected>No microphone found</option>';
            if (micError) {
              micError.innerHTML = '<div class="notice is-danger">' + lib.icon('alert')
                + '<p>Microphones are unavailable: '
                + esc(lib.ipcErrorMessage(error)) + '</p></div>';
            }
          }));
          if (typeof bridge.mics.onDeviceChange === 'function') {
            on(bridge.mics.onDeviceChange(guarded(paintMics)));
          }
        }
      }

      /* --- language chips, live toggles ------------------------------------- */

      var langsEl = root.querySelector('[data-langs]');
      var latestLanguages = ALL_LANGUAGES.slice();

      function paintLanguages(enabledCodes) {
        latestLanguages = enabledCodes.slice();
        langsEl.innerHTML = languageChipsHtml(esc, lib.langLabel, enabledCodes);
      }

      if (langsEl) {
        langsEl.addEventListener('click', guarded(function (event) {
          var chip = event.target.closest('.chip');
          if (!chip || !bridge.config || typeof bridge.config.set !== 'function') return;
          var code = chip.getAttribute('lang');
          var previous = latestLanguages.slice();
          var enabled = previous.indexOf(code) !== -1;
          var next = enabled
            ? previous.filter(function (c) { return c !== code; })
            : previous.concat([code]);
          // Auto-detect needs at least one enabled language; the control simply
          // refuses the click rather than sending a patch the server would
          // reject anyway.
          if (next.length === 0) return;
          paintLanguages(next);
          bridge.config.set({ asr: { languages: next } }).catch(guarded(function () {
            paintLanguages(previous);
          }));
        }));
      }

      /* --- cleanup toggle, live --------------------------------------------- */

      var cleanupToggle = root.querySelector('#cleanup');
      var fillerToggle = root.querySelector('#fillers');
      var cleanupNoticeEl = root.querySelector('[data-cleanup-notice]');

      function paintCleanupNotice(llm) {
        if (!cleanupNoticeEl) return;
        cleanupNoticeEl.innerHTML = (llm.enabled && llm.apiKeyConfigured === false)
          ? cleanupNoticeHtml(esc, lib.icon, providerLabel(llm.provider))
          : '';
      }

      if (cleanupToggle) {
        cleanupToggle.addEventListener('change', guarded(function () {
          var checked = cleanupToggle.checked;
          if (bridge.config && typeof bridge.config.set === 'function') {
            bridge.config.set({ llm: { enabled: checked } }).catch(guarded(function () {
              cleanupToggle.checked = !checked;
            }));
          }
        }));
      }
      if (fillerToggle) {
        fillerToggle.addEventListener('change', guarded(function () {
          var checked = fillerToggle.checked;
          if (bridge.config && typeof bridge.config.set === 'function') {
            bridge.config.set({ llm: { removeFillers: checked } }).catch(guarded(function () {
              fillerToggle.checked = !checked;
            }));
          }
        }));
      }

      /* --- initial real-data fetch, then live subscriptions ------------------ */

      if (bridge.config && typeof bridge.config.get === 'function') {
        bridge.config.get().then(guarded(function (config) {
          paintChord(config.hotkey.chord);
          paintLanguages(config.asr.languages);
          if (cleanupToggle) cleanupToggle.checked = config.llm.enabled;
          if (fillerToggle) fillerToggle.checked = config.llm.removeFillers;
          paintCleanupNotice(config.llm);
          currentDeviceId = config.audio.deviceId
            || (micSelect && micSelect.options[0] && micSelect.options[0].value)
            || null;
          if (micSelect && micSelect.value !== null) micSelect.value = currentDeviceId;
        })).catch(function (error) {
          if (typeof console !== 'undefined' && console.error) console.error(error);
        });

        if (typeof bridge.config.onChange === 'function') {
          on(bridge.config.onChange(guarded(function (config) {
            if (!rebinding) paintChord(config.hotkey.chord);
            paintLanguages(config.asr.languages);
            if (cleanupToggle) cleanupToggle.checked = config.llm.enabled;
            if (fillerToggle) fillerToggle.checked = config.llm.removeFillers;
            paintCleanupNotice(config.llm);
          })));
        }
      }

      /* --- cleanup service: provider, key, Test -------------------------- */

      var providerForm = ctx.views && ctx.views['cleanup-provider'];
      var providerSlot = root.querySelector('[data-provider-slot]');
      if (providerForm && providerSlot) {
        on(providerForm.mount(providerSlot, ctx, {
          onChange: guarded(function (llm) { paintCleanupNotice(llm); })
        }));
      }

      return function teardown() {
        disposed = true;
        for (var i = 0; i < unsubscribers.length; i++) if (unsubscribers[i]) unsubscribers[i]();
      };
    }
  };
});
