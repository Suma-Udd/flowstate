/* ==========================================================================
   Insights — everything counted, never estimated.

   "Never invent a statistic." A figure the queries cannot produce honestly is
   left out rather than filled in: the WPM card carries no percentile because
   there is no honest population to compare one person against. Issue #30
   supplies the real SQL aggregates and #31 takes this file over.
   ========================================================================== */

(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else (root.FlowViews = root.FlowViews || {}).insights = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* SVG user units in a 120x120 viewBox, not layout values: a 270-degree arc
     drawn with stroke-dasharray on one circle. The dash geometry starts at
     3 o'clock and runs clockwise; screens.css rotates the whole SVG by 135deg,
     which lands the 90-degree gap centred on the bottom. */
  var R = 50;
  var CIRC = 2 * Math.PI * R;
  var SWEEP = 0.75;

  var DATE_FMT = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric'
  });
  var MONTH_FMT = new Intl.DateTimeFormat('en-GB', { month: 'short' });

  /* Rank drives the ramp step so the eye finds the top app before it reads a
     single label. It floors at ramp-2: ramp-1 is pale enough on --surface that a
     short bar would read as an empty track. */
  var RANK = ['is-r4', 'is-r3', 'is-r2'];
  function step(rank) { return RANK[rank] || 'is-r2'; }

  function usageRow(lib, iconMarkup, name, lang, percent, rank) {
    return '<div class="usage-row">'
      + '<span class="usage-icon">' + iconMarkup + '</span>'
      + '<span class="usage-name"' + (lang ? ' lang="' + lib.esc(lang) + '"' : '') + '>'
      + lib.esc(name) + '</span>'
      + '<span class="usage-value">' + percent.toFixed(1) + '%</span>'
      + '<span class="usage-track"><span class="usage-fill ' + step(rank)
      + '" data-fill="' + percent + '"></span></span>'
      + '</div>';
  }

  /* Density buckets are quartiles of the non-empty days, so the ramp always uses
     all four steps regardless of how busy the period was. A fixed threshold
     would make a quiet month look like an empty one. */
  function levels(days) {
    var active = days.filter(function (day) { return day.count > 0; })
      .map(function (day) { return day.count; })
      .sort(function (a, b) { return a - b; });

    function quantile(p) {
      if (!active.length) return 0;
      return active[Math.min(active.length - 1, Math.floor(active.length * p))];
    }

    var q1 = quantile(0.25);
    var q2 = quantile(0.5);
    var q3 = quantile(0.75);

    return function (count) {
      if (count === 0) return '';
      if (count <= q1) return ' is-l1';
      if (count <= q2) return ' is-l2';
      if (count <= q3) return ' is-l3';
      return ' is-l4';
    };
  }

  function dayLabel(day) {
    var when = DATE_FMT.format(new Date(day.date + 'T12:00:00Z'));
    if (day.count === 0) return 'No dictations on ' + when;
    return day.count + (day.count === 1 ? ' dictation on ' : ' dictations on ') + when;
  }

  /** Monday-first column for a yyyy-mm-dd date. */
  function rowOf(date) {
    return (new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7;
  }

  function heatmap(lib, streak) {
    var esc = lib.esc;
    var level = levels(streak.days);

    /* Leading and trailing void cells keep the grid rectangular without
       pretending a day existed outside the window. */
    var lead = rowOf(streak.days[0].date);
    var cells = [];
    for (var i = 0; i < lead; i++) cells.push('<span class="heat-cell is-void"></span>');

    streak.days.forEach(function (day) {
      cells.push('<span class="heat-cell' + level(day.count) + '" title="'
        + esc(dayLabel(day)) + '"></span>');
    });

    while ((cells.length % 7) !== 0) cells.push('<span class="heat-cell is-void"></span>');

    var weeks = cells.length / 7;

    /* Month labels sit above the first column that contains a day of that month.
       They are wider than a cell and deliberately overflow to the right, exactly
       as a calendar heatmap should; .heatmap-scroll contains it. */
    var months = [];
    var seen = null;
    for (var week = 0; week < weeks; week++) {
      var first = null;
      for (var row = 0; row < 7; row++) {
        var index = week * 7 + row - lead;
        if (index >= 0 && index < streak.days.length) { first = streak.days[index]; break; }
      }
      if (!first) continue;
      var month = MONTH_FMT.format(new Date(first.date + 'T12:00:00Z'));
      if (month !== seen) {
        seen = month;
        months.push('<span data-column="' + (week + 1) + '">' + esc(month) + '</span>');
      }
    }

    return '<div class="heatmap">'
        + '<div class="heatmap-weekdays" aria-hidden="true">'
        + '<span>Mon</span><span></span><span>Wed</span><span></span>'
        + '<span>Fri</span><span></span><span>Sun</span>'
        + '</div>'
        + '<div class="heatmap-scroll">'
        + '<div class="heatmap-months" data-months="' + weeks + '">' + months.join('') + '</div>'
        + '<div class="heatmap-grid" role="img" aria-label="Dictation activity heatmap: '
        + streak.activeDays + ' active days out of ' + streak.windowDays
        + ', arranged as ' + weeks + ' weeks.">' + cells.join('') + '</div>'
        + '</div>'
        + '</div>';
  }

  var PERIODS = [
    { key: 'last7', label: 'Last 7 days' },
    { key: 'last30', label: 'Last 30 days' },
    { key: 'all', label: 'All time' }
  ];
  var DEFAULT_PERIOD = 'last30';

  function head() {
    return ''
      + '<header class="page-head">'
      + '<div>'
      + '<h1 class="page-title">Insights</h1>'
      + '<p class="page-sub">Everything here is counted, never estimated. A figure'
      + ' the queries cannot produce honestly is left out rather than filled in.</p>'
      + '</div>'
      + '</header>';
  }

  function tabs(lib, selectedKey) {
    return '<div class="tabs" role="tablist" aria-label="Period">'
      + PERIODS.map(function (period) {
          return '<button type="button" class="tab" role="tab" data-period="' + period.key
            + '" aria-selected="' + (period.key === selectedKey ? 'true' : 'false') + '">'
            + lib.esc(period.label) + '</button>';
        }).join('')
      + '</div>';
  }

  function isLive(ctx) {
    return Boolean(ctx.bridge && ctx.bridge.insights && ctx.bridge.insights.summary);
  }

  /* Fresh install: nothing has been dictated, so a grid of zeroes would only be
     noise. One honest prompt instead. */
  function emptyAll(lib) {
    return '<section class="card">' + lib.emptyState('chart', 'Nothing to measure yet',
      'Hold your hotkey and speak. Words per minute, fixes, app usage and your streak'
      + ' appear here once you have dictated.',
      '<a class="btn is-primary on-accent" href="#/dictation">' + lib.icon('mic')
      + '<span>Start dictating</span></a>') + '</section>';
  }

  function usageList(lib, rows, empty, render) {
    if (!rows.length) return '<p class="card-note">' + lib.esc(empty) + '</p>';
    return '<div class="usage">' + rows.map(render).join('') + '</div>';
  }

  /* The cards under the period tabs. One renderer for the live screen and the
     #09 mockup, which feeds it the fixture of the same shape. */
  function body(ctx, d) {
    var lib = ctx.lib;
    var esc = lib.esc;
    var icon = lib.icon;
    var num = lib.num;
    var streak = d.streak;
    var hasSpeed = d.wpm.median != null;
    var frac = hasSpeed ? Math.min(1, d.wpm.median / d.wpm.scaleMax) : 0;
    var periodWord = d.period.label.toLowerCase();

    /* percentile is null on purpose: with no honest population to compare
       against, the line is absent and the card says why in one sentence rather
       than showing an invented "top 12%". */
    var wpmDetail = hasSpeed
      ? 'Median across ' + num(d.wpm.sampleSize)
        + (d.wpm.sampleSize === 1 ? ' timed dictation.' : ' timed dictations.')
        + (d.wpm.percentile == null
          ? ' No percentile, there is nothing honest to compare one person against.'
          : ' Top ' + d.wpm.percentile + '%.')
      : 'No timed dictations in this period.';

    var figures = [
      [streak.current, 'Current streak'],
      [streak.longest, 'Longest streak'],
      [streak.activeDays + ' / ' + streak.windowDays, 'Days with a dictation']
    ];

    return ''
      + '<div class="grid is-3">'

      + '<section class="card is-stat">'
      + '<div class="card-head"><h2 class="card-title">Speed</h2></div>'
      + '<div class="gauge">'
      + '<svg viewBox="0 0 120 120" aria-hidden="true">'
      + '<circle class="gauge-track" cx="60" cy="60" r="' + R + '" stroke-width="10"'
      + ' stroke-linecap="round" stroke-dasharray="' + (CIRC * SWEEP).toFixed(2)
      + ' ' + CIRC.toFixed(2) + '"/>'
      + (hasSpeed
        ? '<circle class="gauge-value" cx="60" cy="60" r="' + R + '" stroke-width="10"'
          + ' stroke-dasharray="' + (CIRC * SWEEP * frac).toFixed(2)
          + ' ' + CIRC.toFixed(2) + '"/>'
        : '')
      + '</svg>'
      + '<div class="gauge-center">'
      + '<span class="stat-value">' + (hasSpeed ? num(d.wpm.median) : '—') + '</span>'
      + '<span class="stat-caption">Words per minute</span>'
      + '</div>'
      + '</div>'
      + '<div class="gauge-bounds"><span>0</span><span>' + num(d.wpm.scaleMax) + '</span></div>'
      + '<p class="stat-detail">' + esc(wpmDetail) + '</p>'
      + '</section>'

      + '<section class="card is-stat">'
      + '<div class="card-head"><h2 class="card-title">Cleanup</h2></div>'
      + '<p class="stat-value">' + num(d.fixes.wordsChanged) + '</p>'
      + '<p class="stat-caption">Words fixed</p>'
      + '<p class="stat-detail">' + num(d.fixes.dictionaryCorrections)
      + ' dictionary corrections across ' + num(d.fixes.dictationsTouched)
      + ' dictations. Counted from the raw/cleaned diff.</p>'
      + '</section>'

      + '<section class="card is-stat">'
      + '<div class="card-head"><h2 class="card-title">Volume</h2></div>'
      + '<p class="stat-value">' + num(d.words.allTime) + '</p>'
      + '<p class="stat-caption">Total words dictated</p>'
      + '<p class="stat-detail">' + num(d.words.period) + ' in the '
      + esc(periodWord) + ', over ' + num(d.dictations.period)
      + (d.dictations.period === 1 ? ' dictation.' : ' dictations.') + '</p>'
      + '</section>'

      + '</div>'

      + '<div class="grid is-2">'

      + '<section class="card">'
      + '<div class="card-head">'
      + '<h2 class="card-title">App usage</h2>'
      + '<span class="card-meta">% of ' + num(d.dictations.period) + ' dictations</span>'
      + '</div>'
      + usageList(lib, d.byApp, 'No dictations in this period.', function (app, index) {
          return usageRow(lib, icon(lib.categoryIcon(app.category)),
            app.label, null, app.percent, index);
        })
      + '</section>'

      + '<section class="card">'
      + '<div class="card-head">'
      + '<h2 class="card-title">Languages</h2>'
      + '<span class="card-meta">Auto-detected</span>'
      + '</div>'
      + usageList(lib, d.byLanguage, 'No detected language in this period.', function (language, index) {
          return usageRow(lib,
            '<span class="usage-code">' + esc(language.code.toUpperCase()) + '</span>',
            language.label, language.code, language.percent, index);
        })
      + '<p class="card-note">Detected by the model, not chosen by hand. This is'
      + ' what it actually heard.</p>'
      + '</section>'

      + '</div>'

      + '<div class="grid">'
      + '<section class="card">'
      + '<div class="card-head">'
      + '<h2 class="card-title">Streak</h2>'
      + '<span class="card-meta">Last ' + streak.windowDays + ' days</span>'
      + '</div>'

      + '<div class="stack is-loose">'
      + '<div class="streak-figures">'
      + figures.map(function (figure) {
          return '<div class="streak-figure">'
            + '<p class="stat-value">' + esc(figure[0]) + '</p>'
            + '<p class="stat-caption">' + esc(figure[1]) + '</p>'
            + '</div>';
        }).join('')
      + '</div>'

      + heatmap(lib, streak)

      + '<div class="heat-legend">'
      + '<span>Fewer</span>'
      + '<span class="heat-cell"></span>'
      + '<span class="heat-cell is-l1"></span>'
      + '<span class="heat-cell is-l2"></span>'
      + '<span class="heat-cell is-l3"></span>'
      + '<span class="heat-cell is-l4"></span>'
      + '<span>More</span>'
      + '<span class="push">Quartiles of the ' + streak.activeDays + ' active days</span>'
      + '</div>'
      + '</div>'

      + '</section>'
      + '</div>';
  }

  /* Bar widths and the month row's column count are geometry derived from the
     data, so they are applied through the CSSOM rather than written into style
     attributes: the renderer's CSP then has no reason to allow inline styles
     at all. */
  function applyGeometry(root) {
    var fills = root.querySelectorAll('[data-fill]');
    for (var i = 0; i < fills.length; i++) {
      fills[i].style.width = fills[i].getAttribute('data-fill') + '%';
    }

    var months = root.querySelector('[data-months]');
    if (!months) return;

    months.style.gridTemplateColumns =
      'repeat(' + months.getAttribute('data-months') + ', var(--cell))';
    var labels = months.querySelectorAll('[data-column]');
    for (var j = 0; j < labels.length; j++) {
      labels[j].style.gridColumn = labels[j].getAttribute('data-column');
    }
  }

  function liveShell(ctx) {
    return head() + tabs(ctx.lib, DEFAULT_PERIOD) + '<div class="stack is-loose" data-body></div>';
  }

  /* Four queries, one per card group. The streak is not period-scoped, and the
     store caches all of them until something is written. */
  function liveMount(root, ctx) {
    var lib = ctx.lib;
    var insights = ctx.bridge.insights;
    var bodyEl = root.querySelector('[data-body]');
    var disposed = false;
    var generation = 0;

    function show(html) {
      bodyEl.innerHTML = html;
      applyGeometry(bodyEl);
    }

    function load(period) {
      var mine = ++generation;
      return Promise.all([
        insights.summary(period),
        insights.byApp(period),
        insights.byLanguage(period),
        insights.streak()
      ]).then(function (parts) {
        if (disposed || mine !== generation) return;
        var data = parts[0];
        data.byApp = parts[1];
        data.byLanguage = parts[2];
        data.streak = parts[3];
        show(data.dictations.allTime === 0 ? emptyAll(lib) : body(ctx, data));
      }).catch(function (error) {
        if (disposed || mine !== generation) return;
        show('<section class="card">' + lib.emptyState('alert',
          'Insights are not available', lib.ipcErrorMessage(error), null) + '</section>');
      });
    }

    function onClick(event) {
      var tab = event.target.closest && event.target.closest('[data-period]');
      if (!tab || tab.getAttribute('aria-selected') === 'true') return;
      var all = root.querySelectorAll('[data-period]');
      for (var i = 0; i < all.length; i++) {
        all[i].setAttribute('aria-selected', all[i] === tab ? 'true' : 'false');
      }
      load(tab.getAttribute('data-period'));
    }

    root.addEventListener('click', onClick);
    load(DEFAULT_PERIOD);

    return function teardown() {
      disposed = true;
      root.removeEventListener('click', onClick);
    };
  }

  return {
    fixture: 'insights',

    html: function (ctx, d) {
      if (isLive(ctx)) return liveShell(ctx);
      return head() + tabs(ctx.lib, d.period.key) + body(ctx, d);
    },

    mount: function (root, ctx) {
      if (isLive(ctx)) return liveMount(root, ctx);
      applyGeometry(root);
      return null;
    },

    skeleton: function (ctx) {
      return head() + tabs(ctx.lib, DEFAULT_PERIOD);
    },

    body: body,
    emptyAll: emptyAll
  };
});
