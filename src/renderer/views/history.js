/* ==========================================================================
   History — the raw-versus-cleaned comparison.

   The important part of the screen is the pair, not the list: over months it is
   how the cleanup pass earns trust. Issue #29 takes this file over and points it
   at #28's FTS5 search instead of the fixture.
   ========================================================================== */

(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else (root.FlowViews = root.FlowViews || {}).history = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function options(lib, items, allLabel, valueKey, labelKey) {
    return '<option value="">' + lib.esc(allLabel) + '</option>'
      + items.map(function (item) {
          return '<option value="' + lib.esc(item[valueKey]) + '"'
            + (item.selected ? ' selected' : '') + '>' + lib.esc(item[labelKey]) + '</option>';
        }).join('');
  }

  /* <details>/<summary> rather than a div and a click handler: expanding is
     keyboard-operable and announced correctly with no JS at all.

     Raw sits in dim text, cleaned in full-strength text on an accent-tinted
     panel, so the hierarchy itself says which one you actually got. */
  function entry(lib, expandedId, e) {
    var esc = lib.esc;
    var icon = lib.icon;

    var meta = [
      '<span>' + esc(e.app.label) + '</span>',
      '<time datetime="' + esc(e.at) + '">' + esc(e.relative) + '</time>',
      '<span class="num">' + e.words + ' words</span>',
      '<span class="num">' + e.wpm + ' wpm</span>',
      lib.langBadge(e.lang)
    ];

    /* A skipped cleanup and a timed-out cleanup both leave the raw text on the
       clipboard, but they are not the same event. Under four words the skip is
       the intended behaviour, so it gets a neutral badge; a timeout is a real
       degradation and gets the danger treatment. Conflating them would train
       you to ignore both. */
    var degraded = !e.cleanupApplied && e.llmMs > 0;
    if (!e.cleanupApplied) {
      meta.push(degraded
        ? '<span class="badge is-danger">Cleanup timed out</span>'
        : '<span class="badge">Cleanup skipped</span>');
    }

    var note = e.cleanupNote
      ? '<div class="notice' + (degraded ? ' is-warn' : '') + '">'
        + icon(degraded ? 'alert' : 'info')
        + '<span>' + esc(e.cleanupNote) + '</span></div>'
      : '';

    var timings = [
      ['ASR', e.asrMs + ' ms'],
      ['Cleanup', e.llmMs === 0 ? 'skipped' : e.llmMs + ' ms'],
      ['Total', e.totalMs + ' ms'],
      ['Spoken', (e.durationMs / 1000).toFixed(1) + ' s']
    ];

    return '<li>'
      + '<details class="entry"' + (e.id === expandedId ? ' open' : '') + '>'
      + '<summary class="list-item">'
      + '<div class="list-main">'
      + '<p class="list-title clamp-2" lang="' + esc(e.lang) + '">' + esc(e.cleaned) + '</p>'
      + '<p class="list-meta">' + meta.join('<span aria-hidden="true">·</span>') + '</p>'
      + '</div>'
      + '<span class="list-actions" aria-hidden="true">' + icon('chevronDown', 'entry-caret')
      + '</span>'
      + '</summary>'

      + '<div class="entry-body">'
      + '<p class="caption">' + esc(e.windowTitle) + '</p>'
      + '<div class="compare">'
      + '<div class="compare-pane">'
      + '<p class="compare-label"><span>Raw transcript</span></p>'
      + '<p class="compare-text" lang="' + esc(e.lang) + '">' + esc(e.raw) + '</p>'
      + '</div>'
      + '<div class="compare-pane is-cleaned">'
      + '<p class="compare-label"><span>'
      + (e.cleanupApplied ? 'After cleanup' : 'Pasted as-is') + '</span>'
      + (e.cleanupApplied ? icon('check') : '') + '</p>'
      + '<p class="compare-text" lang="' + esc(e.lang) + '">' + esc(e.cleaned) + '</p>'
      + '</div>'
      + '</div>'
      + note
      + '<dl class="timings">' + timings.map(function (timing) {
          return '<div><dt>' + esc(timing[0]) + '</dt><dd>' + esc(timing[1]) + '</dd></div>';
        }).join('') + '</dl>'
      + '<div class="btn-row">'
      + '<button type="button" class="btn">' + icon('copy') + '<span>Copy</span></button>'
      + '<button type="button" class="btn">' + icon('undo')
      + '<span>Paste into the foreground app</span></button>'
      + '<button type="button" class="btn is-danger">' + icon('trash')
      + '<span>Delete</span></button>'
      + '</div>'
      + '</div>'

      + '</details>'
      + '</li>';
  }

  /* --- live screen (#29) ------------------------------------------------- */

  var PAGE = 50;
  var SEARCH_DEBOUNCE_MS = 120;
  var RETENTION = [
    { days: 7, label: '7 days' }, { days: 30, label: '30 days' },
    { days: 365, label: '1 year' }, { days: 0, label: 'Keep everything' }
  ];
  var RANGES = [
    { key: 'all', label: 'All time' }, { key: 'today', label: 'Today' },
    { key: '7d', label: 'Last 7 days' }, { key: '30d', label: 'Last 30 days' }
  ];

  /* The index folds case, accents and ß, so a highlight that did not would
     mark nothing for "grusse" in "Grüße". Fold char by char and keep an offset
     map back to the original text; matches are word prefixes, like the index. */
  function foldChar(ch) {
    return ch.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/ß/g, 'ss');
  }

  function queryTerms(query) {
    return foldChar(query).split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 12);
  }

  function highlight(esc, text, terms) {
    text = String(text);
    if (!terms.length) return esc(text);
    var folded = '';
    var map = [];
    var at = 0;
    Array.from(text).forEach(function (ch) {
      var f = foldChar(ch);
      for (var k = 0; k < f.length; k++) map.push(at);
      folded += f;
      at += ch.length;
    });
    var ranges = [];
    var wordRe = /[\p{L}\p{N}]+/gu;
    var m;
    while ((m = wordRe.exec(folded))) {
      for (var t = 0; t < terms.length; t++) {
        if (m[0].indexOf(terms[t]) === 0) {
          var lastChar = map[m.index + terms[t].length - 1];
          ranges.push([map[m.index], lastChar + (text.codePointAt(lastChar) > 0xffff ? 2 : 1)]);
          break;
        }
      }
    }
    var out = '';
    var pos = 0;
    ranges.forEach(function (r) {
      if (r[0] < pos) return;
      out += esc(text.slice(pos, r[0])) + '<mark class="hit">' + esc(text.slice(r[0], r[1])) + '</mark>';
      pos = r[1];
    });
    return out + esc(text.slice(pos));
  }

  function relativeTime(iso, now) {
    var min = Math.floor(Math.max(0, now - Date.parse(iso)) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + ' min ago';
    var hours = Math.floor(min / 60);
    if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    var days = Math.floor(hours / 24);
    return days + (days === 1 ? ' day ago' : ' days ago');
  }

  function dayKey(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
  }

  function dayLabel(iso, now) {
    var ms = Date.parse(iso);
    if (dayKey(ms) === dayKey(now)) return 'Today';
    if (dayKey(ms) === dayKey(now - 86400000)) return 'Yesterday';
    var sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
    return new Date(ms).toLocaleDateString(undefined, {
      weekday: 'long', day: 'numeric', month: 'long', year: sameYear ? undefined : 'numeric'
    });
  }

  function rangeFrom(key, now) {
    if (key === 'today') { var d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }
    if (key === '7d') return now - 7 * 86400000;
    if (key === '30d') return now - 30 * 86400000;
    return undefined;
  }

  function liveEntry(lib, e, terms, now, open) {
    var esc = lib.esc;
    var icon = lib.icon;
    var hl = function (text) { return highlight(esc, text, terms); };
    var meta = [
      '<span>' + esc(e.app.label || 'Unknown app') + '</span>',
      '<time datetime="' + esc(e.at) + '">' + esc(relativeTime(e.at, now)) + '</time>',
      '<span class="num">' + e.words + ' words</span>',
      lib.langBadge(e.lang)
    ];
    if (e.pasteStatus === 'failed') meta.push('<span class="badge is-danger">Not pasted</span>');
    if (!e.cleanupApplied) meta.push('<span class="badge">Cleanup skipped</span>');

    var timings = [
      ['ASR', e.asrMs == null ? 'n/a' : e.asrMs + ' ms'],
      ['Cleanup', !e.llmMs ? 'skipped' : e.llmMs + ' ms'],
      ['Total', e.totalMs == null ? 'n/a' : e.totalMs + ' ms'],
      ['Spoken', e.durationMs == null ? 'n/a' : (e.durationMs / 1000).toFixed(1) + ' s']
    ];
    var raw = e.raw || e.text || '';
    var cleaned = e.cleaned || e.text || '';
    var lang = esc(e.lang || '');

    return '<li data-id="' + esc(e.id) + '">'
      + '<details class="entry"' + (open ? ' open' : '') + '>'
      + '<summary class="list-item"><div class="list-main">'
      + '<p class="list-title clamp-2" lang="' + lang + '">' + hl(cleaned) + '</p>'
      + '<p class="list-meta">' + meta.join('<span aria-hidden="true">·</span>') + '</p>'
      + '</div><span class="list-actions" aria-hidden="true">'
      + icon('chevronDown', 'entry-caret') + '</span></summary>'
      + '<div class="entry-body">'
      + (e.windowTitle ? '<p class="caption">' + esc(e.windowTitle) + '</p>' : '')
      + '<div class="compare">'
      + '<div class="compare-pane"><p class="compare-label"><span>Raw transcript</span></p>'
      + '<p class="compare-text" lang="' + lang + '">' + hl(raw) + '</p></div>'
      + '<div class="compare-pane is-cleaned"><p class="compare-label"><span>'
      + (e.cleanupApplied ? 'After cleanup' : 'Pasted as-is') + '</span>'
      + (e.cleanupApplied ? icon('check') : '') + '</p>'
      + '<p class="compare-text" lang="' + lang + '">' + hl(cleaned) + '</p></div>'
      + '</div>'
      + '<dl class="timings">' + timings.map(function (t) {
          return '<div><dt>' + esc(t[0]) + '</dt><dd>' + esc(t[1]) + '</dd></div>';
        }).join('') + '</dl>'
      + '<div class="btn-row">'
      + '<button type="button" class="btn" data-action="copy">' + icon('copy') + '<span>Copy</span></button>'
      + '<button type="button" class="btn" data-action="paste">' + icon('undo')
      + '<span>Paste into the foreground app</span></button>'
      + '<button type="button" class="btn is-danger" data-action="delete">' + icon('trash')
      + '<span>Delete</span></button>'
      + '</div></div></details></li>';
  }

  function liveHtml(ctx) {
    var icon = ctx.lib.icon;
    return ''
      + '<header class="page-head"><div>'
      + '<h1 class="page-title">History</h1>'
      + '<p class="page-sub">Every dictation is written to disk before the paste is attempted,'
      + ' so nothing you said is ever lost, including the ones that failed to land.</p>'
      + '</div><div class="page-actions">'
      + '<button type="button" class="btn is-danger" data-action="clear">' + icon('trash')
      + '<span>Clear all</span></button></div></header>'
      + '<div class="stack is-tight">'
      + '<label class="search"><span class="visually-hidden">Search dictations</span>'
      + icon('search')
      + '<input type="search" class="input" placeholder="Search raw and cleaned text" data-search>'
      + '</label>'
      + '<div class="list-toolbar">'
      + '<label class="visually-hidden" for="filter-lang">Language</label>'
      + '<select class="select" id="filter-lang" data-filter="language"><option value="">All languages</option></select>'
      + '<label class="visually-hidden" for="filter-app">App</label>'
      + '<select class="select" id="filter-app" data-filter="app"><option value="">All apps</option></select>'
      + '<label class="visually-hidden" for="filter-range">Date range</label>'
      + '<select class="select" id="filter-range" data-filter="range">'
      + RANGES.map(function (r) { return '<option value="' + r.key + '">' + r.label + '</option>'; }).join('')
      + '</select>'
      + '<span class="caption push" data-count aria-live="polite"></span>'
      + '<label class="visually-hidden" for="retention">Keep dictations for</label>'
      + '<select class="select" id="retention" data-retention>'
      + RETENTION.map(function (r) { return '<option value="' + r.days + '">Keep: ' + r.label + '</option>'; }).join('')
      + '</select>'
      + '</div></div>'
      + '<div class="stack is-loose" data-list></div>'
      + '<div data-sentinel></div>';
  }

  function liveMount(root, ctx) {
    var lib = ctx.lib;
    var bridge = ctx.bridge;
    var esc = lib.esc;
    var doc = root.ownerDocument;
    var win = doc.defaultView;

    var listEl = root.querySelector('[data-list]');
    var countEl = root.querySelector('[data-count]');
    var searchEl = root.querySelector('[data-search]');
    var sentinelEl = root.querySelector('[data-sentinel]');
    var retentionEl = root.querySelector('[data-retention]');

    var disposed = false;
    var entries = [];
    var expanded = {};
    var total = 0;
    var terms = [];
    var query = '';
    var generation = 0;
    var exhausted = false;
    var loading = false;
    var timer = null;
    var observer = null;
    var toastEl = null;
    var toastTimer = null;

    function toast(message) {
      if (toastTimer) clearTimeout(toastTimer);
      if (toastEl) toastEl.remove();
      toastEl = doc.createElement('div');
      toastEl.className = 'toast';
      toastEl.setAttribute('role', 'status');
      toastEl.innerHTML = '<span>' + esc(message) + '</span>';
      doc.body.appendChild(toastEl);
      toastTimer = setTimeout(function () {
        if (toastEl) toastEl.remove();
        toastEl = null;
      }, 3500);
    }

    function unavailable(error) {
      if (disposed) return;
      listEl.innerHTML = '<section class="card">' + lib.emptyState('alert',
        'History is not available', lib.ipcErrorMessage(error), null) + '</section>';
    }

    function filters() {
      var f = {};
      var lang = root.querySelector('[data-filter="language"]').value;
      var app = root.querySelector('[data-filter="app"]').value;
      var from = rangeFrom(root.querySelector('[data-filter="range"]').value, Date.now());
      if (lang) f.language = lang;
      if (app) f.app = app;
      if (from !== undefined) f.from = from;
      return f;
    }

    function renderList() {
      var now = Date.now();
      var narrowed = Boolean(query) || Object.keys(filters()).length > 0;
      var totalText = lib.num(total) + (total === 1 ? ' dictation' : ' dictations');
      if (entries.length === 0) {
        listEl.innerHTML = '<section class="card">' + (total === 0
          ? lib.emptyState('clock', 'Nothing dictated yet',
              'Hold your hotkey and speak. Every dictation lands here, raw and cleaned side by side, the moment it completes.',
              '<a class="btn is-primary on-accent" href="#/dictation">' + lib.icon('mic')
              + '<span>Go to Dictation</span></a>')
          : lib.emptyState('search', 'No dictations match',
              'Nothing matches this search and these filters. Try clearing one.', null))
          + '</section>';
        countEl.textContent = totalText;
        return;
      }
      var groups = [];
      entries.forEach(function (e) {
        var label = dayLabel(e.at, now);
        var g = groups[groups.length - 1];
        if (!g || g.label !== label) {
          g = { label: label, items: [] };
          groups.push(g);
        }
        g.items.push(e);
      });
      listEl.innerHTML = groups.map(function (g) {
        return '<section class="card is-flush"><h2 class="sticky-day">'
          + '<span class="card-title">' + esc(g.label) + '</span>'
          + '<span class="card-meta">' + g.items.length + (g.items.length === 1 ? ' dictation' : ' dictations')
          + '</span></h2><ul class="list">' + g.items.map(function (e) {
              return liveEntry(lib, e, terms, now, Boolean(expanded[e.id]));
            }).join('') + '</ul></section>';
      }).join('');
      countEl.textContent = (narrowed
        ? lib.num(entries.length) + (exhausted ? '' : '+') + ' of ' : '') + totalText;
    }

    function loadPage(reset) {
      if (disposed) return Promise.resolve();
      if (reset) { generation++; entries = []; exhausted = false; loading = false; }
      if (exhausted || loading) return Promise.resolve();
      loading = true;
      var mine = generation;
      var f = filters();
      f.limit = PAGE;
      f.offset = entries.length;
      return bridge.history.search(query, f).then(function (rows) {
        if (disposed || mine !== generation) return;
        loading = false;
        entries = entries.concat(rows);
        if (rows.length < PAGE) exhausted = true;
        renderList();
      }).catch(function (error) {
        if (mine === generation) loading = false;
        unavailable(error);
      });
    }

    function fillFacets() {
      return bridge.history.facets().then(function (facets) {
        if (disposed) return;
        total = facets.total;
        var langSel = root.querySelector('[data-filter="language"]');
        var appSel = root.querySelector('[data-filter="app"]');
        facets.languages.forEach(function (code) {
          langSel.insertAdjacentHTML('beforeend',
            '<option value="' + esc(code) + '">' + esc(lib.langLabel(code)) + '</option>');
        });
        facets.apps.forEach(function (a) {
          appSel.insertAdjacentHTML('beforeend',
            '<option value="' + esc(a.exe) + '">' + esc(a.label) + '</option>');
        });
      });
    }

    function entryFor(li) {
      var id = li && li.getAttribute('data-id');
      return entries.filter(function (e) { return e.id === id; })[0];
    }

    function onInput() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        query = searchEl.value.trim();
        terms = queryTerms(query);
        loadPage(true);
      }, SEARCH_DEBOUNCE_MS);
    }

    function onChange(event) {
      if (event.target.hasAttribute('data-filter')) loadPage(true);
    }

    function onToggle(event) {
      var li = event.target.closest && event.target.closest('li[data-id]');
      if (!li || event.target.tagName !== 'DETAILS') return;
      expanded[li.getAttribute('data-id')] = event.target.open;
    }

    function onClick(event) {
      var button = event.target.closest('[data-action]');
      if (!button) return;
      var action = button.getAttribute('data-action');

      if (action === 'clear') {
        lib.confirmDialog(doc, {
          title: 'Clear all history?',
          body: 'This permanently deletes every saved dictation, raw and cleaned. It cannot be undone.',
          confirmLabel: 'Clear all', danger: true
        }).then(function (yes) {
          if (!yes || disposed) return;
          bridge.history.clear().then(function () {
            total = 0;
            toast('History cleared.');
            return loadPage(true);
          }).catch(function (error) { toast(lib.ipcErrorMessage(error)); });
        });
        return;
      }

      var entry = entryFor(button.closest('li[data-id]'));
      if (!entry) return;

      if (action === 'copy') {
        var text = entry.text || entry.cleaned || entry.raw || '';
        if (win.navigator && win.navigator.clipboard) {
          win.navigator.clipboard.writeText(text).then(
            function () { toast('Copied.'); },
            function () { toast('Could not copy.'); });
        } else toast('Could not copy.');
      } else if (action === 'paste') {
        bridge.history.paste(entry.id).then(function (r) {
          if (disposed) return;
          toast(r.ok ? 'Pasted.' : r.onClipboard
            ? 'Paste was blocked. The text is on your clipboard.' : 'Could not paste this entry.');
        }).catch(function (error) { toast(lib.ipcErrorMessage(error)); });
      } else if (action === 'delete') {
        bridge.history.delete(entry.id).then(function () {
          if (disposed) return;
          total = Math.max(0, total - 1);
          entries = entries.filter(function (e) { return e.id !== entry.id; });
          renderList();
          toast('Deleted.');
        }).catch(function (error) { toast(lib.ipcErrorMessage(error)); });
      }
    }

    function onRetention() {
      bridge.config.set({ history: { retentionDays: Number(retentionEl.value) } })
        .then(function () { toast('Retention updated.'); })
        .catch(function (error) { toast(lib.ipcErrorMessage(error)); });
    }

    searchEl.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    root.addEventListener('toggle', onToggle, true);
    root.addEventListener('click', onClick);
    retentionEl.addEventListener('change', onRetention);

    if (win.IntersectionObserver) {
      observer = new win.IntersectionObserver(function (items) {
        if (items[0].isIntersecting && entries.length > 0) loadPage(false);
      }, { rootMargin: '400px' });
      observer.observe(sentinelEl);
    }

    bridge.config.get().then(function (config) {
      if (!disposed && config && config.history) retentionEl.value = String(config.history.retentionDays);
    }).catch(function () {});
    fillFacets().then(function () { return loadPage(true); }).catch(unavailable);

    return function teardown() {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (toastTimer) clearTimeout(toastTimer);
      if (toastEl) toastEl.remove();
      if (observer) observer.disconnect();
    };
  }

  function isLive(ctx) {
    return Boolean(ctx.bridge && ctx.bridge.history && ctx.bridge.history.facets);
  }

  return {
    highlight: highlight,
    queryTerms: queryTerms,
    dayLabel: dayLabel,
    fixture: 'history',

    mount: function (root, ctx) {
      return isLive(ctx) ? liveMount(root, ctx) : null;
    },

    /* See dictionary.js's skeleton — same shape, painted before the fixture
       read resolves. History groups rows by day rather than a flat list, but
       a flat run of skeleton rows in the one card is close enough to the real
       shape to stop the page from jumping once the days land. */
    skeleton: function (ctx) {
      return ctx.lib.skeletonList('History',
        'Every dictation is written to disk before the paste is attempted, so'
        + ' nothing you said is ever lost.', 8);
    },

    html: function (ctx, d) {
      if (isLive(ctx)) return liveHtml(ctx);
      var lib = ctx.lib;
      var esc = lib.esc;
      var icon = lib.icon;

      return ''
        + '<header class="page-head">'
        + '<div>'
        + '<h1 class="page-title">History</h1>'
        + '<p class="page-sub">Every dictation is written to disk before the paste is'
        + ' attempted, so nothing you said is ever lost — including the ones that'
        + ' failed to land.</p>'
        + '</div>'
        + '<div class="page-actions">'
        + '<button type="button" class="btn is-danger">' + icon('trash')
        + '<span>Clear all</span></button>'
        + '</div>'
        + '</header>'

        /* Search on its own row rather than sharing one with the three filters.
           At 900px the selects take their intrinsic widths and squeeze the
           search field down to about 160px, which is not enough to read a query
           back — and a search box you cannot read is worse than one that costs
           a row. */
        + '<div class="stack is-tight">'
        + '<label class="search">'
        + '<span class="visually-hidden">Search dictations</span>'
        + icon('search')
        + '<input type="search" class="input" placeholder="Search raw and cleaned text">'
        + '</label>'

        + '<div class="list-toolbar">'
        + '<label class="visually-hidden" for="filter-lang">Language</label>'
        + '<select class="select" id="filter-lang">'
        + options(lib, d.filters.languages, 'All languages', 'code', 'label') + '</select>'

        + '<label class="visually-hidden" for="filter-app">App</label>'
        + '<select class="select" id="filter-app">'
        + options(lib, d.filters.apps, 'All apps', 'exe', 'label') + '</select>'

        + '<label class="visually-hidden" for="filter-range">Date range</label>'
        + '<select class="select" id="filter-range">'
        + d.filters.ranges.map(function (range) {
            return '<option value="' + esc(range.key) + '"'
              + (range.selected ? ' selected' : '') + '>' + esc(range.label) + '</option>';
          }).join('')
        + '</select>'

        + '<span class="caption push">' + lib.num(d.totals.matching) + ' of '
        + lib.num(d.totals.dictations) + ' dictations · Retention: '
        + esc(d.totals.retentionLabel) + '</span>'
        + '</div>'
        + '</div>'

        + '<div class="stack is-loose">'
        + (d.days.length === 0
            ? '<section class="card">' + (d.totals.dictations === 0
                ? lib.emptyState('clock', 'Nothing dictated yet',
                    'Hold your hotkey and speak — every dictation lands here, raw and'
                    + ' cleaned side by side, the moment it completes.',
                    '<a class="btn is-primary on-accent" href="#/dictation">' + icon('mic')
                    + '<span>Go to Dictation</span></a>')
                : lib.emptyState('search', 'No dictations match',
                    'Nothing in the last ' + lib.num(d.totals.dictations)
                    + (d.totals.dictations === 1 ? ' dictation matches' : ' dictations matches')
                    + ' this search and these filters. Try clearing one.', null))
              + '</section>'
            : d.days.map(function (day) {
                return '<section class="card is-flush">'
                  + '<h2 class="sticky-day">'
                  + '<span class="card-title">' + esc(day.label) + '</span>'
                  + '<span class="card-meta">' + day.dictations
                  + (day.dictations === 1 ? ' dictation' : ' dictations') + '</span>'
                  + '</h2>'
                  + '<ul class="list">'
                  + day.entries.map(function (e) { return entry(lib, d.expandedId, e); }).join('')
                  + '</ul>'
                  + '</section>';
              }).join(''))
        + '</div>';
    }
  };
});
