/* ==========================================================================
   Snippets — say a short trigger, get a long block of text.

   Issue #25. Search, add, inline edit, delete-with-undo, import and export,
   all wired to window.flow.snippets and persisted at
   %APPDATA%\flowstate\snippets.json (src/main/snippets-store.js). Deliberately
   the same page as views/dictionary.js — the design notes asks for #25 to feel
   *identical* to #24, not merely similar — so the only structural additions
   are the conflict notice (real overlap data from the store, computed by
   src/shared/snippet-conflicts.js) and the trigger test field.
   ========================================================================== */

(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else (root.FlowViews = root.FlowViews || {}).snippets = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var UNDO_WINDOW_MS = 6000;

  /* Longest-match-first, the same order the pipeline expands in, so the
     preview cannot disagree with what a real dictation would produce. */
  function expander(snippets) {
    var byLength = snippets.slice().sort(function (a, b) {
      return b.trigger.length - a.trigger.length;
    });
    return function (text) {
      var out = text == null ? '' : String(text);
      byLength.forEach(function (snippet) {
        var pattern = new RegExp(
          snippet.trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        out = out.replace(pattern, snippet.expansion);
      });
      return out;
    };
  }

  /* --- pure markup builders -------------------------------------------- */

  function conflictsSection(lib, conflicts) {
    var icon = lib.icon;
    var esc = lib.esc;
    return '<div data-conflicts>'
      + conflicts.map(function (conflict) {
          return '<div class="notice is-warn">' + icon('alert')
            + '<span><strong>' + conflict.triggers.map(function (trigger) {
                return '“' + esc(trigger) + '”';
              }).join(' and ') + '</strong> overlap. ' + esc(conflict.message) + '</span></div>';
        }).join('')
      + '</div>';
  }

  function scopeBadge(esc, appScope) {
    return '<span class="badge">'
      + esc(appScope ? appScope.replace(/\.exe$/i, '') : 'Everywhere') + '</span>';
  }

  function snippetRow(lib, snippet) {
    var esc = lib.esc;
    var icon = lib.icon;
    var meta = [
      scopeBadge(esc, snippet.appScope),
      '<span class="num">' + lib.num(snippet.uses)
        + (snippet.uses === 1 ? ' use' : ' uses') + '</span>',
      snippet.lastUsed
        ? '<time datetime="' + esc(snippet.lastUsed) + '">last used ' + esc(snippet.lastUsed) + '</time>'
        : '<span>never used</span>'
    ];

    return '<li class="list-item" data-snippet-id="' + esc(snippet.id) + '">'
      + '<div class="list-main">'
      + '<p class="list-title">“' + esc(snippet.trigger) + '”</p>'
      + '<pre class="expansion">' + esc(snippet.expansion) + '</pre>'
      + '<p class="list-meta">' + meta.join('<span aria-hidden="true">·</span>') + '</p>'
      + '</div>'
      + '<div class="list-actions">'
      + '<button type="button" class="btn-icon" data-action="edit" aria-label="Edit '
      + esc(snippet.trigger) + '">' + icon('pencil') + '</button>'
      + '<button type="button" class="btn-icon is-danger" data-action="delete" aria-label="Delete '
      + esc(snippet.trigger) + '">' + icon('trash') + '</button>'
      + '</div>'
      + '</li>';
  }

  function addSnippetAction(lib) {
    return '<button type="button" class="btn is-primary on-accent" data-action="add">'
      + lib.icon('plus') + '<span>Add snippet</span></button>';
  }

  function snippetsSection(lib, snippets, allSnippets) {
    if (snippets.length === 0 && allSnippets.length === 0) {
      return lib.emptyState('bolt', 'No snippets yet',
        'Add a trigger to turn a short phrase into a block of text — an email'
        + ' signature, a commit template, an address you type out too often.',
        addSnippetAction(lib));
    }
    if (snippets.length === 0) {
      return lib.emptyState('search', 'No snippets match',
        'Nothing in your snippets matches this search. Try a different phrase,'
        + ' or clear the search field.', null);
    }
    return '<ul class="list" data-snippets>'
      + snippets.map(function (s) { return snippetRow(lib, s); }).join('')
      + '</ul>';
  }

  function countText(lib, count) {
    return lib.num(count) + (count === 1 ? ' snippet' : ' snippets');
  }

  /* --- view -------------------------------------------------------------- */

  return {
    fixture: 'snippets',

    /* See dictionary.js's skeleton — same shape, painted before the fixture
       read resolves. */
    skeleton: function (ctx) {
      return ctx.lib.skeletonList('Snippets',
        'Say a short trigger, get a long block of text.', 6);
    },

    html: function (ctx, d) {
      var lib = ctx.lib;
      var esc = lib.esc;
      var icon = lib.icon;

      return ''
        + '<header class="page-head">'
        + '<div>'
        + '<h1 class="page-title">Snippets</h1>'
        + '<p class="page-sub">Say a short trigger, get a long block of text.'
        + ' Expansion happens before cleanup, so the result gets formatted for the'
        + ' app you are in rather than pasted in raw.</p>'
        + '</div>'
        + '<div class="page-actions">'
        + '<button type="button" class="btn" data-action="import">' + icon('upload')
        + '<span>Import</span></button>'
        + '<input type="file" accept="application/json,.json" class="visually-hidden"'
        + ' data-import-input tabindex="-1" aria-hidden="true">'
        + '<button type="button" class="btn" data-action="export">' + icon('download')
        + '<span>Export</span></button>'
        + addSnippetAction(lib)
        + '</div>'
        + '</header>'

        + '<div class="stack">'

        /* Matching is longest-wins, so a trigger that is a prefix of another
           still works — but it works in a way that surprises you once. Saying
           so up front is cheaper than debugging it later. */
        + conflictsSection(lib, d.conflicts)

        + '<section class="card">'
        + '<div class="card-head">'
        + '<h2 class="card-title">Test a trigger</h2>'
        + '<span class="card-meta">Nothing is pasted</span>'
        + '</div>'
        + '<div class="stack">'
        + '<div class="field">'
        + '<label class="field-label" for="probe">Type or paste a sentence containing a trigger</label>'
        + '<input type="text" class="input" id="probe" data-probe value="'
        + esc(d.testField.input) + '">'
        + '</div>'
        + '<div>'
        + '<p class="micro">Result</p>'
        + '<pre class="expansion" data-probe-out></pre>'
        + '</div>'
        + '</div>'
        + '</section>'

        + '<div class="list-toolbar">'
        + '<label class="search">'
        + '<span class="visually-hidden">Search snippets</span>'
        + icon('search')
        + '<input type="search" class="input" placeholder="Search triggers and expansions" data-search>'
        + '</label>'
        + '<span class="caption num" data-count>' + countText(lib, d.snippets.length) + '</span>'
        + '</div>'

        + '<section class="card is-flush" data-list-region>'
        + snippetsSection(lib, d.snippets, d.snippets)
        + '</section>'

        + '</div>';
    },

    mount: function (root, ctx, d) {
      var lib = ctx.lib;
      var bridge = ctx.bridge;
      var esc = lib.esc;
      var doc = root.ownerDocument;

      var disposed = false;
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

      var probe = root.querySelector('[data-probe]');
      var probeOut = root.querySelector('[data-probe-out]');

      function teardown() {
        disposed = true;
        if (probe) probe.removeEventListener('input', runProbe);
        dismissToast();
      }

      var searchInput = root.querySelector('[data-search]');
      var countEl = root.querySelector('[data-count]');
      var conflictsEl = root.querySelector('[data-conflicts]');
      var listRegion = root.querySelector('[data-list-region]');
      var importInput = root.querySelector('[data-import-input]');

      var snippets = d.snippets.slice();
      var query = '';
      var expand = expander(snippets);

      function runProbe() { probeOut.textContent = expand(probe.value); }
      if (probe) {
        probe.addEventListener('input', guarded(runProbe));
        runProbe();
      }

      if (!bridge || !bridge.snippets) return teardown;

      /* --- render ----------------------------------------------------- */

      function matching() {
        if (!query) return snippets;
        var q = query.toLowerCase();
        return snippets.filter(function (s) {
          return s.trigger.toLowerCase().indexOf(q) !== -1
            || s.expansion.toLowerCase().indexOf(q) !== -1;
        });
      }

      function renderList() {
        var filtered = matching();
        listRegion.innerHTML = snippetsSection(lib, filtered, snippets);
        countEl.textContent = countText(lib, filtered.length);
      }

      function renderConflicts(conflicts) {
        conflictsEl.outerHTML = conflictsSection(lib, conflicts);
        conflictsEl = root.querySelector('[data-conflicts]');
      }

      function applyList(payload) {
        snippets = payload.snippets.slice();
        expand = expander(snippets);
        if (probe) runProbe();
        renderConflicts(payload.conflicts);
        renderList();
      }

      bridge.snippets.list().then(guarded(applyList)).catch(function (error) {
        if (typeof console !== 'undefined' && console.error) console.error(error);
      });

      /* --- search ------------------------------------------------------- */

      if (searchInput) {
        searchInput.addEventListener('input', guarded(function () {
          query = searchInput.value.trim();
          renderList();
        }));
      }

      /* --- toast: delete-with-undo — same real-delete-then-re-add shape as
         dictionary.js's; see that file's comment for the full reasoning. */

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

      function deleteSnippet(snippet) {
        bridge.snippets.remove(snippet.id).then(guarded(function (payload) {
          applyList(payload);
          showToast('Deleted “' + snippet.trigger + '”', function () {
            bridge.snippets.add({
              trigger: snippet.trigger,
              expansion: snippet.expansion,
              appScope: snippet.appScope
            })
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

         A native <dialog>, same shape as dictionary.js's term dialog: focus
         trap and Escape-to-cancel come free, and a server-side duplicate
         check keeps the dialog open and explains itself rather than closing.
         The two structural differences are a multi-line expansion field and
         a free-text app-scope field instead of a closed language select —
         a snippet can be scoped to any executable, not just the three
         configured ASR languages. */

      function openSnippetDialog(existing) {
        var isEdit = Boolean(existing);
        var dialog = doc.createElement('dialog');
        dialog.className = 'confirm-dialog';
        dialog.innerHTML = ''
          + '<h2 class="card-title">' + (isEdit ? 'Edit snippet' : 'Add snippet') + '</h2>'
          + '<form class="stack" data-snippet-form novalidate>'
          + '<div class="field">'
          + '<label class="field-label" for="snip-trigger">Trigger phrase</label>'
          + '<input type="text" class="input" id="snip-trigger" data-field="trigger" required'
          + ' maxlength="200" value="' + esc(existing ? existing.trigger : '') + '">'
          + '</div>'
          + '<div class="field">'
          + '<label class="field-label" for="snip-expansion">Expansion</label>'
          + '<textarea class="textarea" id="snip-expansion" data-field="expansion" required'
          + ' rows="4" maxlength="4000">' + esc(existing ? existing.expansion : '') + '</textarea>'
          + '<p class="field-hint">What the trigger expands to. Line breaks are preserved.</p>'
          + '</div>'
          + '<div class="field">'
          + '<label class="field-label" for="snip-scope">Only in this app'
          + ' <span class="dim">(optional)</span></label>'
          + '<input type="text" class="input" id="snip-scope" data-field="appScope"'
          + ' maxlength="260" placeholder="e.g. code.exe" value="'
          + esc(existing && existing.appScope ? existing.appScope : '') + '">'
          + '<p class="field-hint">The executable name. Leave blank to expand everywhere.</p>'
          + '</div>'
          + '<div class="notice is-danger" data-error hidden></div>'
          + '<div class="btn-row is-spaced">'
          + '<button type="button" class="btn" data-action="cancel">Cancel</button>'
          + '<button type="submit" class="btn is-primary on-accent">'
          + (isEdit ? 'Save changes' : 'Add snippet') + '</button>'
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
        var form = dialog.querySelector('[data-snippet-form]');

        form.addEventListener('submit', guarded(function (event) {
          event.preventDefault();
          var payload = {
            trigger: dialog.querySelector('[data-field="trigger"]').value.trim(),
            expansion: dialog.querySelector('[data-field="expansion"]').value.trim(),
            appScope: dialog.querySelector('[data-field="appScope"]').value.trim() || null
          };
          if (!payload.trigger) {
            errorEl.hidden = false;
            errorEl.innerHTML = lib.icon('alert') + '<span>Enter a trigger phrase.</span>';
            return;
          }
          if (!payload.expansion) {
            errorEl.hidden = false;
            errorEl.innerHTML = lib.icon('alert') + '<span>Enter what the trigger expands to.</span>';
            return;
          }
          var call = isEdit
            ? bridge.snippets.update(existing.id, payload)
            : bridge.snippets.add(payload);
          call.then(guarded(function (result) {
            applyList(result);
            dialog.close();
          })).catch(guarded(function (error) {
            errorEl.hidden = false;
            errorEl.innerHTML = lib.icon('alert') + '<span>' + esc(lib.ipcErrorMessage(error)) + '</span>';
          }));
        }));

        dialog.showModal();
        dialog.querySelector('[data-field="trigger"]').focus();
      }

      /* --- import / export -------------------------------------------- */

      function exportSnippets() {
        bridge.snippets.export().then(guarded(function (payload) {
          var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
          var url = URL.createObjectURL(blob);
          var link = doc.createElement('a');
          link.href = url;
          link.download = 'flowstate-snippets.json';
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
          bridge.snippets.import(parsed).then(guarded(function (payload) {
            applyList(payload);
            var added = payload.added || 0;
            var skipped = payload.skipped || 0;
            showToast(
              added + (added === 1 ? ' snippet' : ' snippets') + ' imported'
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

        if (action === 'add') { openSnippetDialog(); return; }
        if (action === 'import') { importInput && importInput.click(); return; }
        if (action === 'export') { exportSnippets(); return; }

        var row = actionEl.closest('[data-snippet-id]');
        if (!row) return;
        var snippet = snippets.filter(function (s) { return s.id === row.getAttribute('data-snippet-id'); })[0];
        if (!snippet) return;

        if (action === 'edit') openSnippetDialog(snippet);
        else if (action === 'delete') deleteSnippet(snippet);
      }));

      return teardown;
    }
  };
});
