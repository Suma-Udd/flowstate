/* ==========================================================================
   Flowstate — the app shell (issue #16)

   The live shell that replaces the #09 mockup scaffolding: a frameless window
   with a custom titlebar, the 240px sidebar, and a hash router over the nine v1
   screens. Vanilla JS, no framework, no bundler, no build step — loaded as a
   classic script by index.html and required directly by tests/shell.test.js,
   hence the UMD-ish tail.

   What lives here and what does not:

     - here: the route table, the titlebar, the sidebar, the theme, and the
       lifecycle around a view (render, teardown, error state);
     - in src/renderer/views/*.js: one file per screen, each a pure
       html(ctx, data) plus an optional mount(root, ctx, data). Issues #18, #19,
       #24, #25, #29 and #31 each own exactly one of those files, so none of
       them has to touch this one.

   Two things this file is deliberately strict about:

     1. No theme flash, ever. index.html's inline <head> script has already
        stamped the resolved theme onto <html> before the first stylesheet
        paints. Everything here only *changes* the theme; nothing here
        establishes it.
     2. No timers and no requestAnimationFrame. The shell is event-driven —
        hashchange, clicks, and IPC. A loop ticking in this window is a gate G4
        failure whether or not the window is on screen.
   ========================================================================== */

(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
    return;
  }

  root.FlowApp = api;

  /* index.html loads this last, so the document is parsed and every view has
     registered itself by the time this runs. Booting here rather than from a
     second inline <script> keeps the page's only inline block the theme
     bootstrap, which is the one that has to be inline. */
  if (root.document && root.document.querySelector('[data-content]')) {
    api.shell = api.createShell({
      doc: root.document,
      lib: root.FlowLib,
      views: root.FlowViews,
      bridge: root.flow
    });
    void api.shell.start();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------------------------------------------------
     Routes

     One table drives the router, the sidebar, the window title and the
     Settings tab strip, so a route cannot exist without a way to reach it.
     `nav` is which sidebar item lights up — the three Settings routes share
     one, which is why it is a separate field from `view`.
     --------------------------------------------------------------------- */

  var DEFAULT_ROUTE = '/dictation';

  var ROUTES = [
    { path: '/welcome', view: 'onboarding', nav: null, title: 'Welcome' },
    { path: '/dictation', view: 'dictation', nav: 'dictation', title: 'Dictation' },
    { path: '/history', view: 'history', nav: 'history', title: 'History' },
    { path: '/dictionary', view: 'dictionary', nav: 'dictionary', title: 'Dictionary' },
    { path: '/snippets', view: 'snippets', nav: 'snippets', title: 'Snippets' },
    { path: '/scratchpad', view: 'scratchpad', nav: 'scratchpad', title: 'Scratchpad' },
    { path: '/insights', view: 'insights', nav: 'insights', title: 'Insights' },
    { path: '/settings/general', view: 'settings-general', nav: 'settings', title: 'Settings · General' },
    { path: '/settings/system', view: 'settings-system', nav: 'settings', title: 'Settings · System' },
    { path: '/settings/about', view: 'settings-about', nav: 'settings', title: 'Settings · About' }
  ];

  /* Order is deliberate: Dictation first because it is the home screen,
     Insights last because it is the one you visit occasionally. */
  var NAV = [
    { key: 'dictation', label: 'Dictation', icon: 'mic', path: '/dictation' },
    { key: 'history', label: 'History', icon: 'clock', path: '/history' },
    { key: 'dictionary', label: 'Dictionary', icon: 'book', path: '/dictionary' },
    { key: 'snippets', label: 'Snippets', icon: 'bolt', path: '/snippets' },
    { key: 'scratchpad', label: 'Scratchpad', icon: 'note', path: '/scratchpad' },
    { key: 'insights', label: 'Insights', icon: 'chart', path: '/insights' }
  ];

  /* Help goes to About: that is where the version, the doc links and the
     diagnostics button live, which is what someone clicking Help wants. */
  var FOOT = [
    { key: 'settings', label: 'Settings', icon: 'sliders', path: '/settings/general' },
    { key: 'help', label: 'Help', icon: 'help', path: '/settings/about' }
  ];

  var SETTINGS_TABS = [
    { label: 'General', path: '/settings/general' },
    { label: 'System', path: '/settings/system' },
    { label: 'About', path: '/settings/about' }
  ];

  var THEME_MODES = ['light', 'dark', 'system'];

  /** '#/settings/general' -> the route, or null. Trailing slashes tolerated. */
  function parseRoute(hash) {
    var path = String(hash == null ? '' : hash).replace(/^#/, '');
    if (path.length > 1) path = path.replace(/\/+$/, '');
    for (var i = 0; i < ROUTES.length; i++) {
      if (ROUTES[i].path === path) return ROUTES[i];
    }
    return null;
  }

  function routeFor(path) {
    return parseRoute('#' + path);
  }

  /* ---------------------------------------------------------------------
     The shell
     --------------------------------------------------------------------- */

  /**
   * Binds the shell to a document.
   *
   * Options:
   *   doc      the document to render into
   *   lib      FlowLib — icons, escaping, formatting
   *   views    { name: { html(ctx, data), mount?(root, ctx, data) } }
   *   bridge   window.flow, the preload bridge. Optional: without it the shell
   *            still renders its chrome and says why the data is missing,
   *            which is what a review build opened in a browser looks like.
   *   location a { hash } object; window.location by default
   */
  function createShell(options) {
    var opts = options || {};
    var doc = opts.doc;
    var lib = opts.lib;
    var views = opts.views || {};
    var bridge = opts.bridge || null;
    var loc = opts.location || (typeof location !== 'undefined' ? location : null);

    if (!doc) throw new Error('createShell needs a document');
    if (!lib) throw new Error('createShell needs FlowLib');

    var html = doc.documentElement;
    var esc = lib.esc;
    var icon = lib.icon;

    var current = null;      // the route on screen
    var teardown = null;     // the current view's cleanup, if it registered one
    var renderToken = 0;     // guards against a slow fixture painting over a newer route
    var fixtures = {};       // name -> Promise, so a revisit is instant

    /* --- elements ------------------------------------------------------- */

    function el(selector) {
      var node = doc.querySelector(selector);
      if (!node) throw new Error('the shell is missing ' + selector);
      return node;
    }

    var content = el('[data-content]');
    var brandSlot = el('[data-brand]');
    var navSlot = el('[data-nav]');
    var footSlot = el('[data-nav-foot]');
    var titlebarSlot = el('[data-window-controls]');
    var statusSlot = el('[data-status]');

    /* --- theme ---------------------------------------------------------

       main owns the theme: it holds the mode in config, drives
       nativeTheme.themeSource, and resolves system mode to a concrete
       light/dark. The renderer only ever stamps what main tells it, so the
       attribute on <html> and the OS are never able to disagree.
       ------------------------------------------------------------------- */

    function applyTheme(theme) {
      if (!theme) return;
      if (theme.resolved === 'light' || theme.resolved === 'dark') {
        html.setAttribute('data-theme', theme.resolved);
      }
      if (THEME_MODES.indexOf(theme.mode) !== -1) {
        html.setAttribute('data-theme-mode', theme.mode);
      }
    }

    function themeState() {
      return {
        mode: html.getAttribute('data-theme-mode') || 'system',
        resolved: html.getAttribute('data-theme') || 'light'
      };
    }

    function setTheme(mode) {
      if (THEME_MODES.indexOf(mode) === -1) {
        return Promise.reject(new Error('unknown theme mode: ' + mode));
      }
      var previous = themeState();
      // Stamp the mode immediately so the control cannot look unresponsive while
      // the write to disk completes; the resolved theme arrives with the reply,
      // because only main knows what System currently means.
      html.setAttribute('data-theme-mode', mode);
      if (!bridge || !bridge.theme) return Promise.resolve(themeState());
      return bridge.theme.set(mode).then(function (theme) {
        applyTheme(theme);
        return theme;
      }, function (error) {
        // A theme that did not persist must not stay on screen: the next launch
        // would come up in the old one and the toggle would look broken.
        applyTheme(previous);
        html.setAttribute('data-theme-mode', previous.mode);
        throw error;
      });
    }

    /* --- data ----------------------------------------------------------

       Screens still read the #09 fixtures. The real channels arrive per
       screen — #17 for settings, #28 for history, #30 for insights — and each
       of those issues swaps its own view over. Until then this is the one
       place the app reads canned data, which is also the one place to delete.
       ------------------------------------------------------------------- */

    function fixture(name) {
      if (!name) return Promise.resolve(null);
      if (!fixtures[name]) {
        if (!bridge || !bridge.fixtures) {
          fixtures[name] = Promise.reject(
            new Error('the preload bridge is unavailable, so ' + name + ' cannot be read')
          );
        } else {
          fixtures[name] = bridge.fixtures.get(name);
        }
      }
      return fixtures[name];
    }

    /* --- chrome --------------------------------------------------------- */

    function navMarkup(items, activeKey) {
      return items.map(function (item) {
        return '<a class="nav-item" href="#' + esc(item.path) + '"'
          + (item.key === activeKey ? ' aria-current="page"' : '') + '>'
          + icon(item.icon, 'nav-icon')
          + '<span>' + esc(item.label) + '</span>'
          + '</a>';
      }).join('');
    }

    function paintNav(activeKey) {
      navSlot.innerHTML = navMarkup(NAV, activeKey);
      footSlot.innerHTML = navMarkup(FOOT, activeKey);
    }

    /* Minimise / maximise / close, in the Windows order and with the Windows
       behaviours: maximise toggles to restore, close destroys the window and
       leaves the app running in the tray. Double-clicking the drag region
       maximises too — that comes free with -webkit-app-region: drag. */
    var WINDOW_BUTTONS = [
      { action: 'minimise', label: 'Minimise', icon: 'winMinimise' },
      { action: 'maximise', label: 'Maximise', icon: 'winMaximise' },
      { action: 'close', label: 'Close', icon: 'winClose', cls: ' is-close' }
    ];

    function paintTitlebar(maximised) {
      titlebarSlot.innerHTML = WINDOW_BUTTONS.map(function (button) {
        var isMaximise = button.action === 'maximise';
        var label = isMaximise && maximised ? 'Restore' : button.label;
        var glyph = isMaximise && maximised ? 'winRestore' : button.icon;
        return '<button type="button" class="titlebar-btn' + (button.cls || '') + '"'
          + ' data-window-action="' + button.action + '" aria-label="' + esc(label) + '"'
          + ' title="' + esc(label) + '">' + icon(glyph) + '</button>';
      }).join('');
    }

    function onTitlebarClick(event) {
      var button = event.target.closest('[data-window-action]');
      if (!button || !bridge || !bridge.window) return;
      var action = button.getAttribute('data-window-action');
      if (action === 'minimise') bridge.window.minimise();
      else if (action === 'maximise') bridge.window.toggleMaximise();
      else if (action === 'close') bridge.window.close();
    }

    /* The status card is where other apps put an upsell. Flowstate puts
       the two facts you actually want: is the model resident, and how much have
       you dictated today. #17's model channel replaces the fixture behind it. */
    function paintStatus(data) {
      if (!data) {
        statusSlot.innerHTML = '<h2 class="status-head">'
          + '<span class="status-dot"></span><span>Model</span></h2>'
          + '<p class="status-model">Status unavailable</p>';
        return;
      }
      var model = data.model;
      var today = data.today;
      var dot = { loaded: ' is-ok', ready: ' is-ok', loading: ' is-warn', missing: ' is-error' }[model.status] || '';
      var heading = model.status === 'loaded' ? 'Model resident'
        : model.status === 'ready' ? 'Model ready'
        : 'Model ' + esc(model.status);
      var meta = today.dictations === 0
        ? 'No dictations yet'
        : lib.num(today.dictations) + (today.dictations === 1 ? ' dictation' : ' dictations')
          + (today.scope || ' today') + ' · ' + lib.num(today.words) + ' words';
      statusSlot.innerHTML = ''
        + '<h2 class="status-head">'
        + '<span class="status-dot' + dot + '"></span>'
        + '<span>' + heading + '</span>'
        + '</h2>'
        + '<p class="status-model">' + esc(model.name) + ' · ' + esc(model.quantisation) + '</p>'
        + '<p class="status-meta">' + meta + '</p>';
    }

    /* The card reports what is true on this PC: whether the speech model is
       installed, and how much has been dictated so far. Placeholder data is
       only the fallback for a window with no bridge to ask. */
    var MODEL_STATUS = {
      ready: 'ready', downloading: 'loading', verifying: 'loading', installing: 'loading',
      checking: 'loading', missing: 'missing', corrupt: 'missing', cancelled: 'missing', error: 'missing'
    };
    var latestModel = null;
    var latestTotals = { dictations: 0, words: 0 };

    function paintLiveStatus() {
      if (!latestModel) return;
      var status = MODEL_STATUS[latestModel.phase] || 'missing';
      var name = 'Parakeet TDT 0.6B v3';
      var detail = 'int8';
      if (status === 'loading' && Number.isFinite(latestModel.percent)) {
        detail = 'downloading ' + Math.round(latestModel.percent) + '%';
      }
      paintStatus({
        model: { status: status, name: name, quantisation: detail },
        today: { dictations: latestTotals.dictations, words: latestTotals.words, scope: ' in total' }
      });
    }

    function refreshTotals() {
      if (!bridge.insights || typeof bridge.insights.summary !== 'function') return;
      bridge.insights.summary('all').then(function (summary) {
        latestTotals = {
          dictations: summary.dictations.allTime,
          words: summary.words.allTime
        };
        paintLiveStatus();
      }).catch(function () { /* the card keeps its last numbers */ });
    }

    function startLiveStatus() {
      bridge.model.status().then(function (status) {
        latestModel = status;
        paintLiveStatus();
      }).catch(function (error) { paintStatus(null); report(error); });
      bridge.model.onProgress(function (status) {
        latestModel = status;
        paintLiveStatus();
      });
      refreshTotals();
      if (bridge.dictation && typeof bridge.dictation.onResult === 'function') {
        bridge.dictation.onResult(refreshTotals);
      }
    }

    /* --- update card ----------------------------------------------------

       Main owns the updater and pushes its state. This only draws it: the
       announcement, the notes, one button to accept and one to wait. */

    var updateSlot = doc.querySelector('[data-update-card]');
    var UPDATE_PHASES = ['available', 'downloading', 'verifying', 'installing', 'error'];

    function paintUpdate(state) {
      if (!updateSlot) return;
      var phase = state && state.phase;
      // An error with no version is a failed manual check, which belongs to
      // the About screen, not to a card about an update that exists.
      if (!state || !state.version || UPDATE_PHASES.indexOf(phase) === -1) {
        updateSlot.hidden = true;
        updateSlot.innerHTML = '';
        return;
      }
      var head = '<div class="update-card-head"><span class="onb-mark" aria-hidden="true"></span>'
        + '<span>Flowstate ' + esc(state.version) + ' is out</span></div>';
      var body = '';
      if (phase === 'available') {
        body = (state.notes ? '<p class="update-notes">' + esc(state.notes) + '</p>' : '')
          + '<div class="btn-row">'
          + '<button type="button" class="btn is-primary on-accent" data-update-action="install">Update and restart</button>'
          + '<button type="button" class="btn is-quiet" data-update-action="later">Later</button></div>';
      } else if (phase === 'downloading') {
        var percent = Math.round((state.progress || 0) * 100);
        body = '<progress class="progress" max="100" value="' + percent + '">' + percent + '%</progress>'
          + '<p class="update-notes">Downloading… ' + percent + '%</p>';
      } else if (phase === 'verifying') {
        body = '<p class="update-notes">Checking the download…</p>';
      } else if (phase === 'installing') {
        body = '<p class="update-notes">Installing. Flowstate restarts by itself in a moment.</p>';
      } else if (phase === 'error') {
        body = '<div class="notice is-danger">' + icon('alert') + '<p>' + esc(state.error || 'The update failed.') + '</p></div>'
          + '<div class="btn-row">'
          + '<button type="button" class="btn" data-update-action="install">Try again</button>'
          + '<button type="button" class="btn is-quiet" data-update-action="later">Dismiss</button></div>';
      }
      updateSlot.innerHTML = head + body;
      updateSlot.hidden = false;
    }

    function onUpdateClick(event) {
      var button = event.target.closest('[data-update-action]');
      if (!button || !bridge || !bridge.update) return;
      var action = button.getAttribute('data-update-action');
      if (action === 'install') bridge.update.install().catch(report);
      else if (action === 'later') bridge.update.dismiss().then(paintUpdate).catch(report);
    }

    /* --- views ---------------------------------------------------------- */

    /* Every view is handed the same context. Nothing in views/ reaches for a
       global: what it cannot get from here it cannot do, which is what keeps
       them unit-testable without a browser. */
    function context() {
      return {
        lib: lib,
        bridge: bridge,
        route: current,
        navigate: navigate,
        settingsTabs: SETTINGS_TABS,
        views: views,
        theme: themeState(),
        setTheme: setTheme,
        tabs: tabsMarkup
      };
    }

    function tabsMarkup(activePath) {
      return '<nav class="tabs" aria-label="Settings sections">'
        + SETTINGS_TABS.map(function (tab) {
            return '<a class="tab" href="#' + esc(tab.path) + '" aria-selected="'
              + (tab.path === activePath ? 'true' : 'false') + '">' + esc(tab.label) + '</a>';
          }).join('')
        + '</nav>';
    }

    function runTeardown() {
      if (typeof teardown === 'function') {
        try { teardown(); } catch (error) { report(error); }
      }
      teardown = null;
    }

    function report(error) {
      /* Renderer errors are surfaced, never swallowed: a blank pane is
         indistinguishable from a layout bug. #19's About screen shows the same
         list from main's log. */
      if (typeof console !== 'undefined' && console.error) console.error(error);
    }

    function fail(error) {
      content.className = 'content';
      content.innerHTML = '<div class="view"><div class="empty">' + icon('alert')
        + '<p class="empty-title">This screen could not load</p>'
        + '<p class="empty-body">' + esc(error && error.message ? error.message : String(error))
        + '</p></div></div>';
      html.setAttribute('data-ready', 'error');
      report(error);
    }

    function paintView(route, data) {
      var view = views[route.view];
      var ctx = context();

      content.className = 'content' + (view.fill ? ' is-fill' : '');
      /* The view element is recreated on every navigation, which is what makes
         the route transition animate without a class-toggling reflow dance. */
      content.innerHTML = '<div class="view' + (view.fill ? ' is-fill' : '') + '">'
        + view.html(ctx, data) + '</div>';

      var mounted = content.firstElementChild;
      if (typeof view.mount === 'function') {
        teardown = view.mount(mounted, ctx, data) || null;
      }
      /* Route changes move focus to the new pane, or a keyboard user is left
         with focus on a nav item and no idea the page changed. */
      content.setAttribute('tabindex', '-1');
      html.setAttribute('data-ready', 'true');
    }

    /* A view that names a fixture but has no live channel of its own (#20:
       Dictionary, Snippets, History today) can wait a real IPC round-trip
       before it has anything to paint. A view that exports skeleton(ctx) gets
       it painted immediately, in the route's own shape, so a slow fixture read
       never shows a blank pane or the previous screen hanging around. The real
       paintView() below still replaces it in one shot once data lands — this
       is a placeholder frame, not a second render path. */
    function paintSkeleton(route, view) {
      if (typeof view.skeleton !== 'function') return;
      var ctx = context();
      content.className = 'content';
      content.innerHTML = '<div class="view">' + view.skeleton(ctx) + '</div>';
    }

    function render(route) {
      var token = ++renderToken;
      var view = views[route.view];

      current = route;
      html.setAttribute('data-route', route.path);
      doc.title = route.title + ' — Flowstate';
      paintNav(route.nav);
      html.removeAttribute('data-ready');
      runTeardown();

      if (!view) {
        fail(new Error('no view is registered for ' + route.path));
        return Promise.resolve();
      }

      paintSkeleton(route, view);

      return fixture(view.fixture)
        .then(function (data) {
          if (token !== renderToken) return; // a newer navigation won
          paintView(route, data);
        })
        .catch(function (error) {
          if (token !== renderToken) return;
          fail(error);
        });
    }

    function navigate(path) {
      var route = routeFor(path);
      if (!route) return Promise.resolve();
      if (loc && loc.hash !== '#' + route.path) {
        loc.hash = '#' + route.path; // hashchange drives the render
        return Promise.resolve();
      }
      return render(route);
    }

    /* --- lifecycle ------------------------------------------------------ */

    function onHashChange() {
      var route = parseRoute(loc && loc.hash);
      if (!route) {
        // An unknown hash is a typo or a stale link, not a 404 page: send it
        // home rather than showing the user an error they cannot act on.
        if (loc) loc.hash = '#' + DEFAULT_ROUTE;
        return;
      }
      if (current && current.path === route.path) return;
      void render(route);
    }

    var listeners = [];

    function on(target, event, handler) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(event, handler);
      listeners.push([target, event, handler]);
    }

    function start() {
      brandSlot.innerHTML = '<span class="brand-mark" aria-hidden="true"></span>'
        + '<span class="brand-name">Flowstate</span>';
      paintTitlebar(false);
      paintNav(null);
      paintStatus(null);
      on(titlebarSlot, 'click', onTitlebarClick);
      on(updateSlot, 'click', onUpdateClick);
      if (bridge && bridge.update) {
        bridge.update.onChange(paintUpdate);
        bridge.update.state().then(paintUpdate).catch(report);
      }
      on(doc.defaultView, 'hashchange', onHashChange);

      if (bridge && bridge.window) {
        if (typeof bridge.window.onStateChange === 'function') {
          bridge.window.onStateChange(function (state) {
            paintTitlebar(Boolean(state && state.maximised));
            html.setAttribute('data-maximised', state && state.maximised ? 'true' : 'false');
          });
        }
        if (typeof bridge.window.state === 'function') {
          bridge.window.state().then(function (state) {
            paintTitlebar(Boolean(state && state.maximised));
          }).catch(report);
        }
      }

      /* Two independent signals for a live OS theme change, because System mode
         silently stopping to follow Windows is the kind of bug nobody notices
         for a week: main's nativeTheme event, and the renderer's own media
         query, which Chromium updates from themeSource. Both converge on
         applyTheme, and applying the same theme twice is a no-op. */
      if (bridge && bridge.theme && typeof bridge.theme.onSystemChange === 'function') {
        bridge.theme.onSystemChange(applyTheme);
      }
      var view = doc.defaultView;
      if (view && typeof view.matchMedia === 'function') {
        var dark = view.matchMedia('(prefers-color-scheme: dark)');
        var onMedia = function () {
          if (themeState().mode !== 'system') return;
          applyTheme({ mode: 'system', resolved: dark.matches ? 'dark' : 'light' });
        };
        on(dark, 'change', onMedia);
      }

      // The status card is chrome, not a screen: a failure there must not stop
      // the route from rendering.
      if (bridge && bridge.model && typeof bridge.model.status === 'function') {
        startLiveStatus();
      } else {
        fixture('dictation').then(function (data) {
          paintStatus(data);
        }).catch(function (error) {
          paintStatus(null);
          report(error);
        });
      }

      var route = parseRoute(loc && loc.hash) || routeFor(DEFAULT_ROUTE);
      if (loc && loc.hash !== '#' + route.path) loc.hash = '#' + route.path;
      return render(route);
    }

    function destroy() {
      runTeardown();
      for (var i = 0; i < listeners.length; i++) {
        listeners[i][0].removeEventListener(listeners[i][1], listeners[i][2]);
      }
      listeners = [];
    }

    return {
      start: start,
      destroy: destroy,
      navigate: navigate,
      route: function () { return current; },
      theme: themeState,
      setTheme: setTheme,
      /* Test and debug seams. */
      applyTheme: applyTheme,
      paintTitlebar: paintTitlebar,
      paintStatus: paintStatus
    };
  }

  return {
    DEFAULT_ROUTE: DEFAULT_ROUTE,
    ROUTES: ROUTES,
    NAV: NAV,
    FOOT: FOOT,
    SETTINGS_TABS: SETTINGS_TABS,
    THEME_MODES: THEME_MODES,
    parseRoute: parseRoute,
    routeFor: routeFor,
    createShell: createShell
  };
});
