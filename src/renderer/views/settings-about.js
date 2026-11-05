/* ==========================================================================
   Settings · About — versions, paths, doc links, recent errors.

   Also where the sidebar's Help item lands, because this is the screen someone
   clicking Help actually wants. Issue #19 wires this screen to real data:
   `app.version()` for the fact list and the recent-errors list (side-effect
   free — it must be safe to call on every mount), `app.diagnostics()` for the
   "Copy diagnostics" button (the one call that actually touches the
   clipboard), `app.openLogs()`, and `app.openDoc(key)` for the documentation links.
   ========================================================================== */

(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else (root.FlowViews = root.FlowViews || {})['settings-about'] = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TIME_FMT = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
  });

  /* Which update phases mean "there is something newer", and the words for
     each. The card in the corner (app.js) does the announcing; this screen
     answers "am I up to date?" when someone asks. */
  function updateLine(state) {
    if (!state) return '';
    if (state.phase === 'checking') return 'Checking…';
    if (state.phase === 'up-to-date') return 'You are on the latest version.';
    if (state.phase === 'available') return 'Version ' + state.version + ' is available.';
    if (state.phase === 'downloading') return 'Downloading version ' + state.version + '…';
    if (state.phase === 'verifying') return 'Checking the download…';
    if (state.phase === 'installing') return 'Installing. Flowstate restarts by itself.';
    if (state.phase === 'error') return state.error || 'The update check failed.';
    return '';
  }

  function factsHtml(esc, a) {
    var facts = [
      ['Speech model', a.modelVersion],
      ['sherpa-onnx', a.sherpaVersion],
      ['Electron', a.electronVersion],
      ['Node', a.nodeVersion],
      ['Machine', a.platform],
      ['Config', a.configLocation],
      ['Logs', a.logLocation]
    ];
    return facts.map(function (fact) {
      var mono = /^(%|[A-Za-z]:\\)|-/.test(fact[1]);
      return '<div><dt>' + esc(fact[0]) + '</dt>'
        + '<dd' + (mono ? ' class="mono"' : '') + '>' + esc(fact[1]) + '</dd></div>';
    }).join('');
  }

  function errorsHtml(esc, errors) {
    if (errors.length === 0) {
      return '<li class="list-item"><p class="list-title dim">No errors in the last 7 days.</p></li>';
    }
    return errors.map(function (error) {
      return '<li><time datetime="' + esc(error.at) + '">'
        + esc(TIME_FMT.format(new Date(error.at))) + '</time>'
        + '<span>' + esc(error.message) + '</span></li>';
    }).join('');
  }

  return {
    fixture: 'settings',

    html: function (ctx, s) {
      var lib = ctx.lib;
      var esc = lib.esc;
      var icon = lib.icon;
      var a = s.about;

      return ''
        + '<header class="page-head">'
        + '<div>'
        + '<h1 class="page-title">Settings</h1>'
        + '<p class="page-sub">Everything here persists immediately. There is no Save'
        + ' button because there is nothing to save.</p>'
        + '</div>'
        + '</header>'

        + ctx.tabs('/settings/about')

        + '<div class="grid is-2">'

        + '<section class="card">'
        + '<div class="card-head">'
        + '<h2 class="card-title">Flowstate</h2>'
        + '<span class="card-meta is-plain" data-app-version>v' + esc(a.appVersion) + '</span>'
        + '</div>'
        + '<dl class="facts" data-facts>' + factsHtml(esc, a) + '</dl>'
        + '<div class="btn-row is-spaced">'
        + '<button type="button" class="btn is-primary on-accent" data-action="check-updates">' + icon('refresh')
        + '<span>Check for updates</span></button>'
        + '<button type="button" class="btn" data-action="run-setup">' + icon('play')
        + '<span>Run setup again</span></button>'
        + '</div>'
        + '<div data-update-line class="card-note" aria-live="polite"></div>'
        + '<div class="btn-row is-spaced">'
        + '<button type="button" class="btn" data-action="copy-diagnostics">' + icon('copy')
        + '<span>Copy diagnostics</span></button>'
        + '<button type="button" class="btn" data-action="open-logs">' + icon('folder')
        + '<span>Open logs</span></button>'
        + '</div>'
        + '<div data-diagnostics-notice aria-live="polite"></div>'
        + '<p class="card-note">' + esc(a.diagnosticsHint) + '</p>'
        + '</section>'

        + '<div class="stack is-loose">'

        /* Buttons, not links: an <a href="#"> would drive the hash router back to
           the default route the moment anyone clicked one. */
        + '<section class="card">'
        + '<div class="card-head"><h2 class="card-title">Documentation</h2></div>'
        + '<div class="link-list" data-docs>'
        + a.docs.map(function (doc) {
            return '<button type="button" class="cluster is-tight"'
              + ' data-doc-key="' + esc(doc.target) + '"'
              + '>' + icon('external')
              + '<span>' + esc(doc.label) + '</span></button>';
          }).join('')
        + '</div>'
        + '<p class="card-note">Flowstate is free and open source under the MIT license.'
        + ' Made by Sumayer.</p>'
        + '</section>'

        + '<section class="card">'
        + '<div class="card-head">'
        + '<h2 class="card-title">Recent errors</h2>'
        + '<span class="card-meta" data-errors-meta>' + a.recentErrors.length + ' in the last 7 days</span>'
        + '</div>'
        + '<ul class="error-log" data-errors>' + errorsHtml(esc, a.recentErrors) + '</ul>'
        + '<p class="card-note">Errors name what failed and what the app did'
        + ' instead. Nothing here contains an API key.</p>'
        + '</section>'

        + '</div>'
        + '</div>';
    },

    mount: function (root, ctx) {
      var lib = ctx.lib;
      var esc = lib.esc;
      var icon = lib.icon;
      var bridge = ctx.bridge;
      var disposed = false;

      function guarded(fn) {
        return function () {
          if (disposed) return;
          fn.apply(null, arguments);
        };
      }

      if (!bridge || !bridge.app) return function () { disposed = true; };

      var versionEl = root.querySelector('[data-app-version]');
      var factsEl = root.querySelector('[data-facts]');
      var errorsEl = root.querySelector('[data-errors]');
      var errorsMetaEl = root.querySelector('[data-errors-meta]');

      function paintVersions(data) {
        versionEl.textContent = 'v' + data.appVersion;
        factsEl.innerHTML = factsHtml(esc, data);
        var errors = data.recentErrors || [];
        errorsEl.innerHTML = errorsHtml(esc, errors);
        errorsMetaEl.textContent = errors.length + ' in the last 7 days';
      }

      if (typeof bridge.app.version === 'function') {
        bridge.app.version().then(guarded(paintVersions)).catch(function (error) {
          if (typeof console !== 'undefined' && console.error) console.error(error);
        });
      }

      /* --- copy diagnostics / open logs -------------------------------------- */

      var noticeEl = root.querySelector('[data-diagnostics-notice]');
      function showNotice(text, isError) {
        noticeEl.innerHTML = '<div class="notice' + (isError ? ' is-danger' : '') + '">'
          + icon(isError ? 'alert' : 'check') + '<p>' + esc(text) + '</p></div>';
      }

      var copyButton = root.querySelector('[data-action="copy-diagnostics"]');
      if (copyButton && typeof bridge.app.diagnostics === 'function') {
        copyButton.addEventListener('click', guarded(function () {
          bridge.app.diagnostics().then(guarded(function (data) {
            paintVersions(data);
            showNotice('Versions, paths and recent errors were copied to the clipboard.', false);
          }), guarded(function (error) {
            showNotice(error && error.message ? error.message : String(error), true);
          }));
        }));
      }

      /* --- updates and setup ------------------------------------------------- */

      var updateLineEl = root.querySelector('[data-update-line]');
      var updateButton = root.querySelector('[data-action="check-updates"]');
      var offUpdate = null;
      if (updateButton && bridge.update) {
        updateButton.addEventListener('click', guarded(function () {
          updateButton.disabled = true;
          updateLineEl.textContent = 'Checking…';
          bridge.update.check().then(guarded(function (state) {
            updateButton.disabled = false;
            updateLineEl.textContent = updateLine(state);
          }), guarded(function (error) {
            updateButton.disabled = false;
            updateLineEl.textContent = error && error.message ? error.message : String(error);
          }));
        }));
        offUpdate = bridge.update.onChange(guarded(function (state) {
          if (state.phase !== 'checking') updateLineEl.textContent = updateLine(state);
        }));
      } else if (updateButton) {
        updateButton.disabled = true;
      }

      var setupButton = root.querySelector('[data-action="run-setup"]');
      if (setupButton) {
        setupButton.addEventListener('click', guarded(function () { ctx.navigate('/welcome'); }));
      }

      var logsButton = root.querySelector('[data-action="open-logs"]');
      if (logsButton && typeof bridge.app.openLogs === 'function') {
        logsButton.addEventListener('click', guarded(function () {
          bridge.app.openLogs().catch(guarded(function (error) {
            showNotice(error && error.message ? error.message : String(error), true);
          }));
        }));
      }

      /* --- documentation links ------------------------------------------------ */

      var docsEl = root.querySelector('[data-docs]');
      if (docsEl && typeof bridge.app.openDoc === 'function') {
        docsEl.addEventListener('click', guarded(function (event) {
          var button = event.target.closest('[data-doc-key]');
          if (!button) return;
          bridge.app.openDoc(button.getAttribute('data-doc-key')).catch(guarded(function (error) {
            showNotice(error && error.message ? error.message : String(error), true);
          }));
        }));
      }

      return function teardown() {
        disposed = true;
        if (typeof offUpdate === 'function') offUpdate();
      };
    }
  };
});
