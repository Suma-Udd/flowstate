/* ==========================================================================
   Cleanup provider form

   One small form used in two places: Settings → General and the first-run
   setup. Pick a provider, paste a key, press Test.

   The key is written straight to config.json by main and never comes back to
   the renderer: config.get() only reports whether one is saved. So the field
   is write-only. It is empty after saving and says "saved" instead.

   Not a routed screen. It registers as FlowViews['cleanup-provider'] and the
   shell hands it to every view as ctx.views.
   ========================================================================== */

(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else (root.FlowViews = root.FlowViews || {})['cleanup-provider'] = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* What each failure from the Test button means, in words a person can act on. */
  var TEST_MESSAGES = {
    'missing-key': 'Paste your API key first.',
    'not-configured': 'Enter a base URL and a model name first.',
    unauthorized: 'The provider rejected this key. Check that it was copied completely.',
    'not-found': 'The provider could not find that model or address. Check the model name and base URL.',
    'rate-limit': 'The provider says this key is out of quota or going too fast. Try again in a minute.',
    timeout: 'No answer within 12 seconds. The provider may be busy.',
    'network-error': 'Could not reach the provider. Check your internet connection.',
    'malformed-response': 'The provider answered in a format Flowstate does not understand.',
    'unsupported-provider': 'That provider is not one Flowstate knows.',
    'http-error': 'The provider returned an error. Try again in a moment.'
  };

  function testMessage(reason) {
    return TEST_MESSAGES[reason] || 'The test did not work (' + reason + ').';
  }

  function shell() {
    return ''
      + '<div class="provider-form" data-provider-form>'
      + '<p class="card-note">Loading…</p>'
      + '</div>';
  }

  function formHtml(lib, providers, llm) {
    var esc = lib.esc;
    var selected = providers.filter(function (p) { return p.id === llm.provider; })[0] || providers[0];
    var isCustom = selected.id === 'custom';
    var needsKey = selected.requiresApiKey;

    var options = providers.map(function (p) {
      return '<option value="' + esc(p.id) + '"' + (p.id === selected.id ? ' selected' : '') + '>'
        + esc(p.label) + '</option>';
    }).join('');

    var keyPlaceholder = llm.apiKeyConfigured
      ? 'Key saved. Paste a new one to replace it.'
      : (needsKey ? 'Paste your API key' : 'Optional for a local server');

    return ''
      + '<div class="field">'
      + '<label class="field-label" for="llm-provider">Cleanup provider</label>'
      + '<select class="select" id="llm-provider" data-provider>' + options + '</select>'
      + '</div>'

      + '<div class="field">'
      + '<label class="field-label" for="llm-key">API key</label>'
      + '<div class="input-row">'
      + '<input class="input" id="llm-key" type="password" autocomplete="off" spellcheck="false"'
      + ' data-key placeholder="' + esc(keyPlaceholder) + '">'
      + (llm.apiKeyConfigured
          ? '<button type="button" class="btn is-quiet" data-action="remove-key">Remove</button>'
          : '')
      + '</div>'
      + '<p class="field-hint">'
      + (llm.apiKeyConfigured ? lib.icon('check') + ' A key is saved on this PC. ' : '')
      + 'It is stored only in <span class="mono">%APPDATA%\\flowstate\\config.json</span>'
      + ' and sent only to the provider you pick.'
      + (selected.keyDoc
          ? ' <button type="button" class="link-btn" data-action="get-key">Get a key'
            + lib.icon('external') + '</button>'
          : '')
      + '</p>'
      + '</div>'

      + (isCustom
          ? '<div class="field">'
            + '<label class="field-label" for="llm-base">Base URL</label>'
            + '<input class="input" id="llm-base" type="url" spellcheck="false" data-base-url'
            + ' placeholder="http://localhost:11434/v1" value="' + esc(llm.baseUrl || '') + '">'
            + '<p class="field-hint">Any server that speaks the OpenAI chat format, such as Ollama or LM Studio.</p>'
            + '</div>'
            + '<div class="field">'
            + '<label class="field-label" for="llm-model">Model</label>'
            + '<input class="input" id="llm-model" type="text" spellcheck="false" data-model'
            + ' placeholder="llama3.2" value="' + esc(llm.model || '') + '">'
            + '</div>'
          : '<p class="field-hint">Uses <span class="mono">' + esc(selected.model)
            + '</span>, a small fast model. Cleanup is a short edit, so it costs a fraction of a cent.</p>')

      + '<div class="btn-row">'
      + '<button type="button" class="btn" data-action="test">' + lib.icon('play') + '<span>Test</span></button>'
      + '</div>'
      + '<div data-test-result aria-live="polite"></div>';
  }

  /**
   * Fills `slot` and wires it. Returns a teardown function.
   *   ctx.bridge  window.flow
   *   ctx.lib     FlowLib
   *   options.onChange(llmConfig)  called after any saved change
   */
  function mount(slot, ctx, options) {
    var lib = ctx.lib;
    var esc = lib.esc;
    var bridge = ctx.bridge;
    var opts = options || {};
    var disposed = false;
    var providers = [];
    var llm = null;
    var offConfig = null;

    if (!slot) return function () {};
    if (!bridge || !bridge.llm || !bridge.config) {
      slot.innerHTML = '<p class="card-note">Cleanup settings are unavailable in this view.</p>';
      return function () {};
    }

    function guarded(fn) {
      return function () {
        if (disposed) return;
        return fn.apply(null, arguments);
      };
    }

    function result(html) {
      var el = slot.querySelector('[data-test-result]');
      if (el) el.innerHTML = html;
    }

    function noticeHtml(kind, text) {
      var icon = kind === 'is-danger' ? 'alert' : 'check';
      return '<div class="notice ' + (kind === 'ok' ? '' : kind) + '">' + lib.icon(icon)
        + '<p>' + esc(text) + '</p></div>';
    }

    function save(patch) {
      return bridge.config.set({ llm: patch }).then(guarded(function (next) {
        llm = next.llm;
        if (typeof opts.onChange === 'function') opts.onChange(llm);
        return next;
      }));
    }

    function paint() {
      slot.innerHTML = formHtml(lib, providers, llm);
    }

    function selectedProvider() {
      return providers.filter(function (p) { return p.id === llm.provider; })[0] || providers[0];
    }

    function onChange(event) {
      var target = event.target;
      if (target.matches('[data-provider]')) {
        save({ provider: target.value }).then(guarded(paint)).catch(guarded(function (error) {
          result(noticeHtml('is-danger', lib.ipcErrorMessage(error)));
        }));
      } else if (target.matches('[data-key]')) {
        var value = target.value.trim();
        if (value === '') return;
        save({ apiKey: value, enabled: true }).then(guarded(function () {
          paint();
          result(noticeHtml('ok', 'Key saved. Press Test to check it works.'));
        })).catch(guarded(function (error) {
          result(noticeHtml('is-danger', lib.ipcErrorMessage(error)));
        }));
      } else if (target.matches('[data-base-url]')) {
        save({ baseUrl: target.value.trim() }).catch(guarded(function (error) {
          result(noticeHtml('is-danger', lib.ipcErrorMessage(error)));
        }));
      } else if (target.matches('[data-model]')) {
        save({ model: target.value.trim() }).catch(guarded(function (error) {
          result(noticeHtml('is-danger', lib.ipcErrorMessage(error)));
        }));
      }
    }

    function onClick(event) {
      var button = event.target.closest('[data-action]');
      if (!button) return;
      var action = button.getAttribute('data-action');

      if (action === 'get-key') {
        var doc = selectedProvider().keyDoc;
        if (doc && bridge.app && bridge.app.openDoc) bridge.app.openDoc(doc).catch(function () {});
      } else if (action === 'remove-key') {
        save({ apiKey: '' }).then(guarded(function () {
          paint();
          result('');
        }));
      } else if (action === 'test') {
        // A key typed but not yet committed (no blur yet) is saved first, so
        // the test always checks what is on screen.
        var typed = slot.querySelector('[data-key]');
        var pending = typed && typed.value.trim() !== ''
          ? save({ apiKey: typed.value.trim(), enabled: true }).then(guarded(paint))
          : Promise.resolve();
        button.disabled = true;
        result('<p class="card-note">Testing…</p>');
        pending.then(function () { return bridge.llm.test(); }).then(guarded(function (outcome) {
          var again = slot.querySelector('[data-action="test"]');
          if (again) again.disabled = false;
          if (outcome.ok) {
            result(noticeHtml('ok',
              'It works. “' + outcome.sample + '” became “' + outcome.text + '” in '
              + Math.round(outcome.llmMs) + ' ms.'));
          } else {
            result(noticeHtml('is-danger', testMessage(outcome.reason)));
          }
        })).catch(guarded(function (error) {
          var again = slot.querySelector('[data-action="test"]');
          if (again) again.disabled = false;
          result(noticeHtml('is-danger', lib.ipcErrorMessage(error)));
        }));
      }
    }

    slot.addEventListener('change', onChange);
    slot.addEventListener('click', onClick);

    Promise.all([bridge.llm.providers(), bridge.config.get()]).then(guarded(function (values) {
      providers = values[0];
      llm = values[1].llm;
      paint();
    })).catch(guarded(function (error) {
      slot.innerHTML = noticeHtml('is-danger', lib.ipcErrorMessage(error));
    }));

    if (typeof bridge.config.onChange === 'function') {
      offConfig = bridge.config.onChange(guarded(function (next) {
        // Keep the saved-key hint honest if something else changes the config,
        // without repainting under someone who is typing.
        if (next.llm && llm && next.llm.apiKeyConfigured !== llm.apiKeyConfigured
            && !slot.contains(slot.ownerDocument.activeElement)) {
          llm = next.llm;
          paint();
        }
      }));
    }

    return function teardown() {
      disposed = true;
      slot.removeEventListener('change', onChange);
      slot.removeEventListener('click', onClick);
      if (typeof offConfig === 'function') offConfig();
    };
  }

  return {
    shell: shell,
    mount: mount,
    formHtml: formHtml,
    testMessage: testMessage,
    TEST_MESSAGES: TEST_MESSAGES
  };
});
