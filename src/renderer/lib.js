/* ==========================================================================
   Flowstate — renderer library (issue #16)

   Icons, escaping, formatting. Everything the shell and the views need and
   nothing else. Vanilla JS, no framework, no bundler, no build step: loaded as
   a classic script by index.html and required directly by the tests, hence the
   UMD-ish tail.

   This is deliberately the same icon set and the same helpers the #09 mockups
   carry in src/renderer/mockups/shell.js. That file is frozen review
   scaffolding — it is the artefact gate G2 compares against, it must keep
   opening standalone over http, and it is deleted once #18/#19/#24/#25/#29/#31
   have replaced every mockup with a live screen. Making it depend on this file
   would put the live app inside the review artefact's dependency chain, which
   is the wrong direction. Until then the app depends on this file and on
   nothing in mockups/.
   ========================================================================== */

(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.FlowLib = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Icons — 24x24, stroke-only, currentColor, so they take the theme for free
     and there is not a single image file to ship. */
  var ICONS = {
    wave: ['M4 10v4', 'M8 6v12', 'M12 9v6', 'M16 4v16', 'M20 10v4'],
    mic: [
      'M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z',
      'M5 11a7 7 0 0 0 14 0', 'M12 18v3', 'M8 21h8'
    ],
    clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 7v5l3 2'],
    book: ['M5 4h10a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2Z', 'M9 8h5', 'M9 12h5'],
    bolt: ['M13 3 5 14h5l-1 7 8-11h-5l1-7Z'],
    note: [
      'M4 5a2 2 0 0 1 2-2h8l6 6v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z',
      'M14 3v6h6', 'M8 13h8', 'M8 17h5'
    ],
    chart: ['M3 20h18', 'M7 20v-6', 'M12 20V8', 'M17 20v-9'],
    sliders: ['M4 7h9', 'M17 7h3', 'M4 17h5', 'M13 17h7', 'M15 4v6', 'M9 14v6'],
    help: [
      'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
      'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.5', 'M12 17h.01'
    ],
    search: ['M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z', 'M15.5 15.5 20 20'],
    plus: ['M12 5v14', 'M5 12h14'],
    pencil: ['M4 20h4L20 8l-4-4L4 16Z', 'M14 6l4 4'],
    trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6'],
    copy: ['M8 8h12v12H8Z', 'M16 8V4H4v12h4'],
    download: ['M12 4v11', 'M8 11l4 4 4-4', 'M4 20h16'],
    upload: ['M12 20V9', 'M8 13l4-4 4 4', 'M4 4h16'],
    info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 11v6', 'M12 8h.01'],
    alert: ['M12 4 2 20h20L12 4Z', 'M12 10v5', 'M12 18h.01'],
    external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
    chevronDown: ['m6 9 6 6 6-6'],
    chevronUp: ['m6 15 6-6 6 6'],
    check: ['m5 13 4 4 10-10'],
    refresh: ['M20 4v5h-5', 'M19.4 9a8 8 0 1 0 .6 6'],
    globe: [
      'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M3 12h18',
      'M12 3c2.5 2.4 4 5.6 4 9s-1.5 6.6-4 9c-2.5-2.4-4-5.6-4-9s1.5-6.6 4-9Z'
    ],
    code: ['m9 8-5 4 5 4', 'M15 8l5 4-5 4'],
    message: ['M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4Z'],
    fileText: ['M6 3h8l4 4v14H6Z', 'M14 3v4h4', 'M9 12h6', 'M9 16h4'],
    terminal: ['M3 4h18v16H3Z', 'm7 9 2.5 3L7 15', 'M12 15h5'],
    flame: ['M12 21a5 5 0 0 0 5-5c0-4-5-11-5-11S7 12 7 16a5 5 0 0 0 5 5Z'],
    sparkle: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z'],
    type: ['M4 7V5h16v2', 'M12 5v14', 'M9 19h6'],
    play: ['m8 5 10 7-10 7Z'],
    folder: ['M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z'],
    x: ['M6 6l12 12', 'M18 6 6 18'],
    undo: ['M4 10h9a5 5 0 1 1 0 10H9', 'M8 6l-4 4 4 4'],
    inbox: ['M4 13h4l2 3h4l2-3h4', 'M4 13 6 5h12l2 8v6H4Z'],

    /* Window controls. Windows draws these as thin 10px glyphs on a 1px grid,
       which is why they are square paths rather than the rounded 1.75 stroke
       every other icon in the app uses — see .titlebar-btn svg in app.css. */
    winMinimise: ['M4 12h16'],
    winMaximise: ['M5 5h14v14H5Z'],
    winRestore: ['M8 8h11v11H8Z', 'M15 5H5v10'],
    winClose: ['M5 5l14 14', 'M19 5 5 19']
  };

  /* Category icon per app, so the Insights usage list reads at a glance. */
  var CATEGORY_ICON = {
    editor: 'code',
    browser: 'globe',
    chat: 'message',
    notes: 'fileText',
    terminal: 'terminal'
  };

  var LANG_LABEL = { en: 'English', de: 'Deutsch', el: 'Ελληνικά' };

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function icon(name, cls) {
    var paths = ICONS[name];
    if (!paths) throw new Error('unknown icon: ' + name);
    return '<svg' + (cls ? ' class="' + cls + '"' : '')
      + ' viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"'
      + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
      + paths.map(function (d) { return '<path d="' + d + '"/>'; }).join('')
      + '</svg>';
  }

  var NUM = new Intl.NumberFormat('en-GB');
  function num(value) { return NUM.format(value); }

  /* Words: whitespace tokens containing at least one letter or digit. A bare em
     dash is punctuation, not a word. The same definition the fixtures were
     checked against, and the one insights.js must use in #30. */
  function words(text) {
    return String(text).split(/\s+/).filter(function (token) {
      return /[\p{L}\p{N}]/u.test(token);
    }).length;
  }

  function langLabel(code) { return LANG_LABEL[code] || code || 'unknown language'; }

  function langBadge(code) {
    return '<span class="badge">' + esc(langLabel(code)) + '</span>';
  }

  function categoryIcon(category) { return CATEGORY_ICON[category] || 'fileText'; }

  /* Grouped rows, as most settings screens do them: label and
     current value on the left, the control on the right, a hairline between.
     One builder for all three Settings screens, so a row on General is
     byte-identical to a row on System.

     `label`, `value` and `action` are markup — callers escape what they
     interpolate, because every one of them has a <kbd>, a <select> or a
     <button> to put there. `hint` is plain text and is escaped here.

     The reference's "label and current value on the left" holds when the control
     is a button. Where the control is a select, a switch or a segmented group it
     already states the current value, and printing it twice is noise — those
     rows pass null for value and keep only the hint. */
  function row(label, value, hint, action) {
    return '<div class="row">'
      + '<div class="row-main">'
      + '<p class="row-label">' + label + '</p>'
      + (value ? '<p class="row-value">' + value + '</p>' : '')
      + (hint ? '<p class="row-hint">' + esc(hint) + '</p>' : '')
      + '</div>'
      + (action ? '<div class="row-action">' + action + '</div>' : '')
      + '</div>';
  }

  /* A real checkbox, so it is Tab-reachable, Space-operable and announced as a
     checkbox for free. The row's label is the accessible name. */
  function toggle(id, label, checked) {
    return '<input type="checkbox" class="switch" id="' + esc(id) + '"'
      + (checked ? ' checked' : '') + ' aria-label="' + esc(label) + '">';
  }

  /* The empty state for any list screen: no dictionary terms, no snippets, no
     history, no recent dictations. `action` is markup (a real <button> or a
     real route link, never href="#") — omit it where there is nothing useful
     to do from here. Reuses .empty, which until now only rendered the shell's
     own "this screen could not load" fallback (app.js's fail()) — the same
     icon/title/body shape is exactly right for "there is nothing here yet". */
  function emptyState(iconName, title, body, action) {
    return '<div class="empty">' + icon(iconName)
      + '<p class="empty-title">' + esc(title) + '</p>'
      + '<p class="empty-body">' + esc(body) + '</p>'
      + (action ? '<div class="empty-action">' + action + '</div>' : '')
      + '</div>';
  }

  /* A skeleton row shaped like a real .list-item, so the list that replaces it
     lands in the same place and nothing shifts. Pure decoration: no text, no
     interactive element, aria-hidden so a screen reader does not read out
     three rows of nothing while the real data is one IPC round-trip away. */
  function skeletonRows(count) {
    var out = '';
    for (var i = 0; i < count; i++) {
      out += '<li class="list-item skel-item" aria-hidden="true">'
        + '<div class="list-main">'
        + '<span class="skel skel-line is-title"></span>'
        + '<span class="skel skel-line is-meta"></span>'
        + '</div></li>';
    }
    return out;
  }

  /* A skeleton page: the real header (title, subtitle) paints immediately —
     it is static copy, not data, so there is nothing to placeholder — and the
     list underneath it is `rowCount` skeleton rows in a real card, matching
     the layout the live view will paint into. */
  function skeletonList(title, sub, rowCount) {
    return '<header class="page-head"><div>'
      + '<h1 class="page-title">' + esc(title) + '</h1>'
      + '<p class="page-sub">' + esc(sub) + '</p>'
      + '</div></header>'
      + '<p class="visually-hidden" role="status">Loading ' + esc(title.toLowerCase()) + '</p>'
      + '<div class="stack">'
      + '<section class="card is-flush"><ul class="list" aria-hidden="true">'
      + skeletonRows(rowCount)
      + '</ul></section>'
      + '</div>';
  }

  /* A badge alone says "Error"; it does not say what to do. Shared by
     dictation.js and settings-system.js, which each show the same real
     model-manager state and must not drift into two different explanations
     of the same failure. model-manager.js's own message where there is one
     (a real SHA-256 mismatch, a real network failure), a plain fact where
     there is not (nothing has been downloaded yet). Every case points at the
     Re-download control already next to it. */
  var MODEL_FAIL_TEXT = {
    missing: 'The speech model has not been downloaded yet. Dictation is unavailable until it is.',
    corrupt: 'The downloaded model failed verification and was removed.',
    cancelled: 'The download was cancelled before it finished.'
  };

  /* ipcRenderer.invoke() wraps a rejected main-process handler as
     "Error invoking remote method 'channel': Error: <original message>" —
     useful in a stack trace, not on a screen. A real mics.list() failure
     (Windows privacy settings, a missing device) reaches a notice through
     exactly this path, so every such notice reads the reason a real service
     gave, not Electron's own plumbing wrapped around it. */
  function ipcErrorMessage(error) {
    var text = error && error.message ? error.message : String(error);
    return text
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
      .replace(/^Error:\s*/, '');
  }

  function modelNoticeHtml(state) {
    if (state.phase !== 'error' && !MODEL_FAIL_TEXT[state.phase]) return '';
    var text = state.phase === 'error' && state.error
      ? state.error
      : (MODEL_FAIL_TEXT[state.phase] || 'The speech model could not be loaded.');
    return '<div class="notice is-danger">' + icon('alert') + '<p>' + esc(text) + '</p></div>';
  }

  /* A native <dialog> for the two destructive actions in Settings (re-download
     the model, clear history) — issue #19's "confirm first" rule. <dialog>
     gives Escape-to-cancel, a focus trap and an ::backdrop scrim for free,
     which is a lot of correct keyboard behaviour this app does not have to
     write by hand. Resolves true if the caller confirmed, false otherwise. */
  function confirmDialog(doc, options) {
    var opts = options || {};
    return new Promise(function (resolve) {
      var dialog = doc.createElement('dialog');
      dialog.className = 'confirm-dialog';
      dialog.innerHTML = ''
        + '<h2 class="card-title">' + esc(opts.title) + '</h2>'
        + '<p>' + esc(opts.body) + '</p>'
        + '<div class="btn-row is-spaced">'
        + '<button type="button" class="btn" data-action="cancel">'
        + esc(opts.cancelLabel || 'Cancel') + '</button>'
        + '<button type="button" class="btn' + (opts.danger ? ' is-danger' : ' is-primary on-accent')
        + '" data-action="confirm">' + esc(opts.confirmLabel || 'Confirm') + '</button>'
        + '</div>';
      doc.body.appendChild(dialog);

      function cleanup(result) {
        dialog.removeEventListener('close', onClose);
        dialog.removeEventListener('click', onClick);
        dialog.remove();
        resolve(result);
      }
      function onClose() { cleanup(dialog.returnValue === 'confirm'); }
      function onClick(event) {
        var button = event.target.closest('[data-action]');
        if (!button) return;
        dialog.close(button.getAttribute('data-action'));
      }

      dialog.addEventListener('close', onClose);
      dialog.addEventListener('click', onClick);
      dialog.showModal();
    });
  }

  return {
    ICONS: ICONS,
    LANG_LABEL: LANG_LABEL,
    esc: esc,
    icon: icon,
    num: num,
    words: words,
    langLabel: langLabel,
    langBadge: langBadge,
    categoryIcon: categoryIcon,
    row: row,
    toggle: toggle,
    confirmDialog: confirmDialog,
    emptyState: emptyState,
    skeletonRows: skeletonRows,
    skeletonList: skeletonList,
    modelNoticeHtml: modelNoticeHtml,
    ipcErrorMessage: ipcErrorMessage
  };
});
