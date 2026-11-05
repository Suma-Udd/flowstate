/* ==========================================================================
   Scratchpad — somewhere to dictate when there is no other target.

   The one screen that fills its pane instead of scrolling a document: the editor
   is the scroll container, so the page furniture stays put while a long thought
   scrolls underneath it. Hence `fill: true`.
   ========================================================================== */

(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else (root.FlowViews = root.FlowViews || {}).scratchpad = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  return {
    fixture: 'scratchpad',
    fill: true,

    html: function (ctx, d) {
      var lib = ctx.lib;
      var icon = lib.icon;
      var live = Boolean(ctx.bridge && ctx.bridge.scratch);

      /* With the real bridge the text arrives from main in mount(); the fixture
         is only the shape (and what the mockups and tests render). */
      var text = live ? '' : d.text;
      var caption = live ? 'Autosaved continuously' : 'Autosaved continuously · ' + d.savedRelative;

      return ''
        + '<header class="page-head">'
        + '<div>'
        + '<h1 class="page-title">Scratchpad</h1>'
        + '<p class="page-sub">Somewhere to dictate when there is no other target.'
        + ' Dictating here inserts at the caret with no clipboard round-trip.</p>'
        + '</div>'
        + '<div class="page-actions">'
        + '<button type="button" class="btn" data-copy>' + icon('copy') + '<span>Copy all</span></button>'
        + '<button type="button" class="btn" data-export>' + icon('download')
        + '<span>Export .txt</span></button>'
        + '<button type="button" class="btn is-danger" data-clear>' + icon('trash')
        + '<span data-clear-label>Clear</span></button>'
        + '<button type="button" class="btn" data-clear-cancel hidden>'
        + '<span>Keep it</span></button>'
        + '</div>'
        + '</header>'

        + '<div class="editor-wrap">'
        + '<label class="visually-hidden" for="pad">Scratchpad</label>'
        + '<textarea class="editor" id="pad" spellcheck="false" data-pad'
        + (live ? ' readonly' : '') + '>'
        + lib.esc(text) + '</textarea>'
        + '</div>'

        + '<footer class="editor-foot">'
        + '<div class="counts">'
        + '<span><strong class="num" data-words></strong> words</span>'
        + '<span><strong class="num" data-chars></strong> characters</span>'
        + '<span><strong class="num" data-lines></strong> paragraphs</span>'
        + '</div>'
        + '<p class="caption" data-pad-status role="status">' + lib.esc(caption) + '</p>'
        + '</footer>';
    },

    mount: function (root, ctx) {
      var lib = ctx.lib;
      var scratch = ctx.bridge && ctx.bridge.scratch;
      var pad = root.querySelector('[data-pad]');
      var wordsOut = root.querySelector('[data-words]');
      var charsOut = root.querySelector('[data-chars]');
      var linesOut = root.querySelector('[data-lines]');
      var statusOut = root.querySelector('[data-pad-status]');
      var copyBtn = root.querySelector('[data-copy]');
      var exportBtn = root.querySelector('[data-export]');
      var clearBtn = root.querySelector('[data-clear]');
      var clearLabel = root.querySelector('[data-clear-label]');
      var cancelBtn = root.querySelector('[data-clear-cancel]');

      var SAVE_DELAY = 400;
      var saveTimer = null;
      var confirmTimer = null;
      var dirty = false;
      var gone = false;
      var unsubscribe = null;

      /* Counts are computed from the text, never read from the fixture. A stored
         count is a count that can lie the moment anyone types. */
      function recount() {
        var text = pad.value;
        wordsOut.textContent = lib.num(lib.words(text));
        charsOut.textContent = lib.num(text.length);
        linesOut.textContent = lib.num(
          text.split(/\n{2,}/).filter(function (part) { return part.trim().length; }).length
        );
      }

      function say(message) { if (statusOut) statusOut.textContent = message; }

      function clock(iso) {
        var when = iso ? new Date(iso) : new Date();
        return when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      }

      function problem(error) {
        return error && error.message ? error.message : 'unknown error';
      }

      /* Saves are chained by main, so the latest call always wins; here we only
         make sure a burst of typing is one write and that leaving flushes. */
      function save() {
        if (!scratch || !dirty) return Promise.resolve();
        clearTimeout(saveTimer);
        saveTimer = null;
        dirty = false;
        say('Saving…');
        return scratch.set(pad.value).then(function (saved) {
          if (!gone && !dirty) say('Saved · ' + clock(saved && saved.updatedAt));
        }).catch(function (error) {
          dirty = true;
          if (!gone) say('Could not save · ' + problem(error));
        });
      }

      function schedule() {
        if (!scratch) return;
        dirty = true;
        say('Unsaved changes');
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, SAVE_DELAY);
      }

      function onInput() { recount(); schedule(); }

      /* Dictated text lands at the caret (or replaces the selection). A space is
         added only when the caret sits straight after a non-space character, so
         two dictations do not run together. */
      function insertAtCaret(text) {
        if (typeof text !== 'string' || !text) return;
        var start = pad.selectionStart;
        var end = pad.selectionEnd;
        var before = pad.value.charAt(start - 1);
        var lead = start > 0 && !/\s/.test(before) && !/^\s/.test(text) ? ' ' : '';
        pad.setRangeText(lead + text, start, end, 'end');
        pad.focus();
        onInput();
      }

      function resetClear() {
        clearTimeout(confirmTimer);
        clearBtn.removeAttribute('data-confirm');
        clearLabel.textContent = 'Clear';
        cancelBtn.hidden = true;
      }

      function onClear() {
        if (!pad.value.length) return;
        if (!clearBtn.hasAttribute('data-confirm')) {
          clearBtn.setAttribute('data-confirm', 'true');
          clearLabel.textContent = 'Confirm clear';
          cancelBtn.hidden = false;
          confirmTimer = setTimeout(resetClear, 5000);
          return;
        }
        resetClear();
        pad.value = '';
        onInput();
        pad.focus();
        void save();
      }

      /* Copy and export act on what main has stored, so flush the editor first. */
      function afterSave(action, done) {
        if (!scratch) return;
        dirty = true;
        save().then(function () { return scratch[action](); }).then(done).catch(function (error) {
          say('Failed · ' + problem(error));
        });
      }

      function onCopy() {
        afterSave('copy', function () { say('Copied all'); });
      }

      function onExport() {
        afterSave('export', function (result) {
          if (result && result.saved) say('Exported · ' + result.fileName);
        });
      }

      pad.addEventListener('input', onInput);
      clearBtn.addEventListener('click', onClear);
      cancelBtn.addEventListener('click', resetClear);
      copyBtn.addEventListener('click', onCopy);
      exportBtn.addEventListener('click', onExport);
      recount();

      if (scratch) {
        scratch.get().then(function (doc) {
          if (gone) return undefined;
          pad.value = doc.text;
          pad.removeAttribute('readonly');
          recount();
          say(doc.updatedAt ? 'Saved · ' + clock(doc.updatedAt) : 'Autosaved continuously');
          pad.focus();
          pad.setSelectionRange(pad.value.length, pad.value.length);
          unsubscribe = scratch.onInsert(insertAtCaret);
          return scratch.setActive(true);
        }).catch(function (error) {
          say('Could not open · ' + problem(error));
        });
      }

      return function () {
        gone = true;
        clearTimeout(confirmTimer);
        clearTimeout(saveTimer);
        pad.removeEventListener('input', onInput);
        clearBtn.removeEventListener('click', onClear);
        cancelBtn.removeEventListener('click', resetClear);
        copyBtn.removeEventListener('click', onCopy);
        exportBtn.removeEventListener('click', onExport);
        if (unsubscribe) unsubscribe();
        if (scratch) {
          /* Leaving flushes, so text typed in the last 400 ms is not lost. */
          if (dirty) void scratch.set(pad.value);
          void scratch.setActive(false);
        }
      };
    }
  };
});
