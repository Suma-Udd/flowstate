'use strict';

/* Snippets — trigger-overlap detection, shared so the Snippets screen's
   conflict notice is never a guess at what the expansion pass would actually
   do. Mirrors dictionary-prompt.js's role for the Dictionary screen's
   prompt-budget figure: one real computation, used by both ipc.js and its
   tests, instead of a renderer-side approximation that could quietly
   disagree with the engine's own longest-match-first expansion order (see
   views/snippets.js's `expander`). */

function normaliseTrigger(trigger) {
  return trigger.trim().toLowerCase();
}

/* Two snippets can only actually collide if the same dictation could match
   either of them: both unscoped (apply everywhere), scoped to the same app,
   or one unscoped and the other scoped (the unscoped one still applies
   inside that app too). Two snippets scoped to different specific apps never
   compete. */
function scopesOverlap(a, b) {
  return !a || !b || a === b;
}

function computeSnippetConflicts(snippets) {
  const conflicts = [];
  for (let i = 0; i < snippets.length; i += 1) {
    for (let j = i + 1; j < snippets.length; j += 1) {
      const a = snippets[i];
      const b = snippets[j];
      if (!scopesOverlap(a.appScope, b.appScope)) continue;

      const aKey = normaliseTrigger(a.trigger);
      const bKey = normaliseTrigger(b.trigger);
      if (aKey === bKey || aKey.length === bKey.length) continue;

      const [shorter, longer] = aKey.length < bKey.length ? [a, b] : [b, a];
      const shorterKey = normaliseTrigger(shorter.trigger);
      const longerKey = normaliseTrigger(longer.trigger);
      if (longerKey.indexOf(shorterKey) !== 0) continue;

      conflicts.push(Object.freeze({
        kind: 'prefix',
        triggers: [shorter.trigger, longer.trigger],
        message: `"${shorter.trigger}" is a prefix of "${longer.trigger}". `
          + 'Longest match wins, so the shorter trigger only fires when the '
          + 'longer one does not.',
      }));
    }
  }
  return conflicts;
}

module.exports = {
  computeSnippetConflicts,
};
