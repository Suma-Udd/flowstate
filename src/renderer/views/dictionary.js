/* ==========================================================================
   Dictionary — the words the model must never get wrong.

   Issue #24. Search, add, inline edit, delete-with-undo, import and export,
   all wired to window.flow.dict and persisted at
   %APPDATA%\flowstate\dictionary.json (src/main/dict-store.js). Snippets
   (#25) is deliberately the same page: if a change here is not mirrored in
   views/snippets.js, the two screens have drifted.
   ========================================================================== */

(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else (root.FlowViews = root.FlowViews || {}).dictionary = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LANGUAGE_OPTIONS = [
    { value: '', label: 'Any language' },
    { value: 'en', label: 'English' },
    { value: 'de', label: 'Deutsch' },
    { value: 'el', label: 'Ελληνικά' }
  ];

  var UNDO_WINDOW_MS = 6000;

  /* --- pure markup builders -------------------------------------------- */

  function budgetNotice(lib, budget) {
    var icon = lib.icon;
    var near = budget.terms >= budget.warnAtTerms;
    return '<div class="notice' + (near ? ' is-warn' : '') + '" data-budget>'
      + icon(near ? 'alert' : 'info')
      + '<span><strong>' + lib.num(budget.terms)
      + (budget.terms === 1 ? ' term' : ' terms') + '</strong> · '
      + lib.num(budget.chars) + ' of ' + lib.num(budget.capChars)
      + ' prompt characters used. '
      + (near
          ? 'Past ' + budget.warnAtTerms
            + ' terms the list is truncated by relevance rather than sent whole.'
          : 'The list is sent in full until it passes ' + budget.warnAtTerms + ' terms.')
      + '</span></div>';
  }

  function termRow(lib, term) {
    var esc = lib.esc;
    var icon = lib.icon;
    var meta = [];
    if (term.soundsLike) {
      meta.push('<span>sounds like <span class="sounds-like">'
        + esc(term.soundsLike) + '</span></span>');
    }
    if (term.lang) meta.push(lib.langBadge(term.lang));
    meta.push('<span class="num">' + lib.num(term.corrections)
      + (term.corrections === 1 ? ' correction' : ' corrections') + '</span>');

    return '<li class="list-item" data-term-id="' + esc(term.id) + '">'
      + '<div class="list-main">'
      + '<p class="list-title"' + (term.lang ? ' lang="' + esc(term.lang) + '"' : '') + '>'
      + esc(term.term) + '</p>'
      + '<p class="list-meta">' + meta.join('<span aria-hidden="true">·</span>') + '</p>'
      + '</div>'
      + '<div class="list-actions">'
      + '<button type="button" class="btn-icon" data-action="edit" aria-label="Edit '
      + esc(term.term) + '">' + icon('pencil') + '</button>'
      + '<button type="button" class="btn-icon is-danger" data-action="delete" aria-label="Delete '
      + esc(term.term) + '">' + icon('trash') + '</button>'
      + '</div>'
      + '</li>';
  }

  function addTermAction(lib) {
    return '<button type="button" class="btn is-primary on-accent" data-action="add">'
      + lib.icon('plus') + '<span>Add term</span></button>';
  }

  function termsSection(lib, terms, allTerms) {
    if (terms.length === 0 && allTerms.length === 0) {
      return lib.emptyState('book', 'No custom terms yet',
        'Add one when the model keeps getting a name, acronym or phrase wrong —'
        + ' for example "Grafana" or "Samuel". Flowstate checks the output'
        + ' against this list and repairs it after cleanup.',
        addTermAction(lib));
    }
    if (terms.length === 0) {
      return lib.emptyState('search', 'No terms match',
        'Nothing in the dictionary matches this search. Try a different'
        + ' spelling, or clear the search field.', null);
    }
    return '<ul class="list" data-terms>'
      + terms.map(function (t) { return termRow(lib, t); }).join('')
      + '</ul>';
  }

  function countText(lib, count) {
    return lib.num(count) + (count === 1 ? ' term' : ' terms');
  }

  /* --- view -------------------------------------------------------------- */

  return {
    fixture: 'dictionary',

    /* Painted immediately on navigation, before the fixture read resolves —
       see app.js's paintSkeleton(). Same header copy as the real screen so
       nothing above the list shifts once it lands. */
    skeleton: function (ctx) {
      return ctx.lib.skeletonList('Dictionary',
        'The words the model must never get wrong.', 6);
    },

    html: function (ctx, d) {
      var lib = ctx.lib;
      var icon = lib.icon;

      return ''
        + '<header class="page-head">'
        + '<div>'
        + '<h1 class="page-title">Dictionary</h1>'
        + '<p class="page-sub">The words the model must never get wrong. Every term'
        + ' here is checked against the output and repaired after cleanup, because'
        + ' instructing a model to spell a name is not the same as it doing so.</p>'
        + '</div>'
        + '<div class="page-actions">'
        + '<button type="button" class="btn" data-action="import">' + icon('upload')
        + '<span>Import</span></button>'
        + '<input type="file" accept="application/json,.json" class="visually-hidden"'
        + ' data-import-input tabindex="-1" aria-hidden="true">'
        + '<button type="button" class="btn" data-action="export">' + icon('download')
        + '<span>Export</span></button>'
        + addTermAction(lib)
        + '</div>'
        + '</header>'

        + '<div class="stack">'

        /* The dictionary is injected into every system prompt, so its size is
           not free. The slot is always visible with the real figures; past
           the threshold it turns into a warning rather than appearing out of
           nowhere. */
        + budgetNotice(lib, d.promptBudget)

        + '<div class="list-toolbar">'
        + '<label class="search">'
        + '<span class="visually-hidden">Search terms</span>'
        + icon('search')
        + '<input type="search" class="input" placeholder="Search terms and hints" data-search>'
        + '</label>'
        + '<span class="caption num" data-count>' + countText(lib, d.terms.length) + '</span>'
        + '</div>'

        + '<section class="card is-flush" data-list-region>'
        + termsSection(lib, d.terms, d.terms)
        + '</section>'

        + '</div>';
    },

    mount: function (root, ctx, d) {
      var lib = ctx.lib;
      var bridge = ctx.bridge;
      var esc = lib.esc;
      var doc = root.ownerDocument;

      var disposed = false;
      var unsubscribers = [];
      var toastEl = null;
      var toastTimer = null;

      function guarded(fn) {
        return function () {
          if (disposed) return;
          return fn.apply(null, arguments);
        };
      }

      function dismissToast() {
        if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
        if (toastEl) { toastEl.remove(); toastEl = null; }
      }

      function teardown() {
        disposed = true;
        for (var i = 0; i < unsubscribers.length; i++) unsubscribers[i]();
        dismissToast();
      }

      var searchInput = root.querySelector('[data-search]');
      var countEl = root.querySelector('[data-count]');
      var budgetEl = root.querySelector('[data-budget]');
      var listRegion = root.querySelector('[data-list-region]');
      var importInput = root.querySelector('[data-import-input]');

      var terms = d.terms.slice();
      var query = '';

      if (!bridge || !bridge.dict) return teardown;

      /* --- render ----------------------------------------------------- */

      function matching() {
        if (!query) return terms;
        var q = query.toLowerCase();
        return terms.filter(function (t) {
          return t.term.toLowerCase().indexOf(q) !== -1
            || (t.soundsLike && t.soundsLike.toLowerCase().indexOf(q) !== -1);
        });
      }

      function renderList() {
        var filtered = matching();
        listRegion.innerHTML = termsSection(lib, filtered, terms);
        countEl.textContent = countText(lib, filtered.length);
      }

      function renderBudget(budget) {
        budgetEl.outerHTML = budgetNotice(lib, budget);
        budgetEl = root.querySelector('[data-budget]');
      }

      function applyList(payload) {
        terms = payload.terms.slice();
        renderBudget(payload.promptBudget);
        renderList();
      }

      bridge.dict.list().then(guarded(applyList)).catch(function (error) {
        if (typeof console !== 'undefined' && console.error) console.error(error);
      });

      /* --- search ------------------------------------------------------- */

      if (searchInput) {
        searchInput.addEventListener('input', guarded(function () {
          query = searchInput.value.trim();
          renderList();
        }));
      }

      /* --- toast: delete-with-undo ---------------------------------------

         Removal is real and immediate — the store no longer has the term the
         moment the toast appears — so Undo is "add it back", not "cancel a
         pending delete". That is honest about what actually happened and
         needs no soft-delete state in the store. */

      function showToast(message, onUndo) {
        dismissToast();
        toastEl = doc.createElement('div');
        toastEl.className = 'toast';
        toastEl.setAttribute('role', 'status');
        toastEl.innerHTML = '<span>' + esc(message) + '</span>'
          + (onUndo
              ? '<button type="button" class="btn is-quiet" data-action="undo">'
                + lib.icon('undo') + '<span>Undo</span></button>'
              : '');
        doc.body.appendChild(toastEl);

        if (onUndo) {
          var undoBtn = toastEl.querySelector('[data-action="undo"]');
          undoBtn.addEventListener('click', guarded(function () {
            dismissToast();
            onUndo();
          }));
          undoBtn.focus();
        }

        toastTimer = setTimeout(guarded(dismissToast), UNDO_WINDOW_MS);
      }

      function deleteTerm(term) {
        bridge.dict.remove(term.id).then(guarded(function (payload) {
          applyList(payload);
          showToast('Deleted “' + term.term + '”', function () {
            bridge.dict.add({ term: term.term, soundsLike: term.soundsLike, lang: term.lang })
              .then(guarded(applyList))
              .catch(function (error) {
                if (typeof console !== 'undefined' && console.error) console.error(error);
              });
          });
        })).catch(function (error) {
          if (typeof console !== 'undefined' && console.error) console.error(error);
        });
      }

      /* --- add / edit dialog ---------------------------------------------

         A native <dialog>, same as lib.confirmDialog's: focus trap and
         Escape-to-cancel come free. Unlike confirmDialog this one has real
         form fields and a server-side duplicate check that must keep the
         dialog open and explain itself rather than just closing. */

      function openTermDialog(existing) {
        var isEdit = Boolean(existing);
        var dialog = doc.createElement('dialog');
        dialog.className = 'confirm-dialog';
        dialog.innerHTML = ''
          + '<h2 class="card-title">' + (isEdit ? 'Edit term' : 'Add term') + '</h2>'
          + '<form class="stack" data-term-form novalidate>'
          + '<div class="field">'
          + '<label class="field-label" for="dict-term-spelling">Correct spelling</label>'
          + '<input type="text" class="input" id="dict-term-spelling" data-field="term" required'
          + ' maxlength="200" value="' + esc(existing ? existing.term : '') + '">'
          + '</div>'
          + '<div class="field">'
          + '<label class="field-label" for="dict-term-sounds-like">Sounds like'
          + ' <span class="dim">(optional)</span></label>'
          + '<input type="text" class="input" id="dict-term-sounds-like" data-field="soundsLike"'
          + ' maxlength="200" value="' + esc(existing && existing.soundsLike ? existing.soundsLike : '') + '">'
          + '<p class="field-hint">How it sounds spoken aloud, if the correct spelling'
          + ' would not otherwise be recognised.</p>'
          + '</div>'
          + '<div class="field">'
          + '<label class="field-label" for="dict-term-lang">Language'
          + ' <span class="dim">(optional)</span></label>'
          + '<select class="select" id="dict-term-lang" data-field="lang">'
          + LANGUAGE_OPTIONS.map(function (opt) {
              var current = existing && existing.lang ? existing.lang : '';
              return '<option value="' + opt.value + '"'
                + (current === opt.value ? ' selected' : '') + '>' + opt.label + '</option>';
            }).join('')
          + '</select>'
          + '</div>'
          + '<div class="notice is-danger" data-error hidden></div>'
          + '<div class="btn-row is-spaced">'
          + '<button type="button" class="btn" data-action="cancel">Cancel</button>'
          + '<button type="submit" class="btn is-primary on-accent">'
          + (isEdit ? 'Save changes' : 'Add term') + '</button>'
          + '</div>'
          + '</form>';
        doc.body.appendChild(dialog);

        function cleanup() {
          dialog.removeEventListener('close', onClose);
          dialog.remove();
        }
        function onClose() { cleanup(); }
        dialog.addEventListener('close', onClose);

        dialog.querySelector('[data-action="cancel"]').addEventListener('click', function () {
          dialog.close();
        });

        var errorEl = dialog.querySelector('[data-error]');
        var form = dialog.querySelector('[data-term-form]');

        form.addEventListener('submit', guarded(function (event) {
          event.preventDefault();
          var payload = {
            term: dialog.querySelector('[data-field="term"]').value.trim(),
            soundsLike: dialog.querySelector('[data-field="soundsLike"]').value.trim() || null,
            lang: dialog.querySelector('[data-field="lang"]').value || null
          };
          if (!payload.term) {
            errorEl.hidden = false;
            errorEl.innerHTML = lib.icon('alert') + '<span>Enter the correct spelling.</span>';
            return;
          }
          var call = isEdit
            ? bridge.dict.update(existing.id, payload)
            : bridge.dict.add(payload);
          call.then(guarded(function (result) {
            applyList(result);
            dialog.close();
          })).catch(guarded(function (error) {
            errorEl.hidden = false;
            errorEl.innerHTML = lib.icon('alert') + '<span>' + esc(lib.ipcErrorMessage(error)) + '</span>';
          }));
        }));

        dialog.showModal();
        dialog.querySelector('[data-field="term"]').focus();
      }

      /* --- import / export -------------------------------------------- */

      function exportTerms() {
        bridge.dict.export().then(guarded(function (payload) {
          var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
          var url = URL.createObjectURL(blob);
          var link = doc.createElement('a');
          link.href = url;
          link.download = 'flowstate-dictionary.json';
          link.click();
          URL.revokeObjectURL(url);
        })).catch(function (error) {
          if (typeof console !== 'undefined' && console.error) console.error(error);
        });
      }

      function importFromFile(file) {
        var reader = new FileReader();
        reader.addEventListener('load', guarded(function () {
          var parsed;
          try {
            parsed = JSON.parse(String(reader.result));
          } catch (error) {
            showToast('That file is not valid JSON.', null);
            return;
          }
          bridge.dict.import(parsed).then(guarded(function (payload) {
            applyList(payload);
            var added = payload.added || 0;
            var skipped = payload.skipped || 0;
            showToast(
              added + (added === 1 ? ' term' : ' terms') + ' imported'
                + (skipped > 0 ? ', ' + skipped + ' skipped as duplicates or invalid' : '') + '.',
              null
            );
          })).catch(guarded(function (error) {
            showToast(lib.ipcErrorMessage(error), null);
          }));
        }));
        reader.readAsText(file);
      }

      if (importInput) {
        importInput.addEventListener('change', guarded(function () {
          var file = importInput.files && importInput.files[0];
          importInput.value = '';
          if (file) importFromFile(file);
        }));
      }

      /* --- delegated clicks: header actions, empty-state action, rows --- */

      root.addEventListener('click', guarded(function (event) {
        var actionEl = event.target.closest('[data-action]');
        if (!actionEl) return;
        var action = actionEl.getAttribute('data-action');

        if (action === 'add') { openTermDialog(); return; }
        if (action === 'import') { importInput && importInput.click(); return; }
        if (action === 'export') { exportTerms(); return; }

        var row = actionEl.closest('[data-term-id]');
        if (!row) return;
        var term = terms.filter(function (t) { return t.id === row.getAttribute('data-term-id'); })[0];
        if (!term) return;

        if (action === 'edit') openTermDialog(term);
        else if (action === 'delete') deleteTerm(term);
      }));

      return teardown;
    }
  };
});
