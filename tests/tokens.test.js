/**
 * tokens.css — contrast and consistency checks.
 *
 * the design notes: "Every colour pair passes WCAG AA for its use. Check, do not
 * eyeball." This is that check, run by `npm test` so the palette cannot regress
 * silently and so the numbers in Session Log.md stay honest.
 *
 * No dependencies — the allowlist in the engine notes is closed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const TOKENS = fs.readFileSync(path.join(RENDERER, 'styles', 'tokens.css'), 'utf8');
const BASE = fs.readFileSync(path.join(RENDERER, 'styles', 'base.css'), 'utf8');
const SWATCHES = fs.readFileSync(path.join(RENDERER, 'swatches.html'), 'utf8');

/* ---------------------------------------------------------------------------
   Minimal CSS block reader. Finds a selector and returns its declaration body
   by matching braces, so nested at-rules do not confuse it.
   --------------------------------------------------------------------------- */

function blockAfter(css, needle) {
  const at = css.indexOf(needle);
  assert.notEqual(at, -1, `selector not found in tokens.css: ${needle}`);
  const open = css.indexOf('{', at + needle.length);
  assert.notEqual(open, -1, `no block opens after: ${needle}`);

  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces after: ${needle}`);
}

function declarations(block) {
  const out = {};
  // Strip comments first so a commented-out value is never read as real.
  const clean = block.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(clean)) !== null) out[m[1]] = m[2].trim();
  return out;
}

const LIGHT = declarations(blockAfter(TOKENS, "[data-theme='light']"));
const DARK_SYSTEM = declarations(blockAfter(TOKENS, ":root:not([data-theme='light'])"));
const DARK_EXPLICIT = declarations(blockAfter(TOKENS, "\n[data-theme='dark']"));

/* ---------------------------------------------------------------------------
   WCAG 2.1 relative luminance and contrast ratio.
   --------------------------------------------------------------------------- */

function rgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  assert.ok(m, `expected a 6-digit hex colour, got: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/* [ label, foreground, background, required ]
   4.5 — WCAG 1.4.3 body text.
   3.0 — WCAG 1.4.11 non-text contrast (focus rings, data marks).

   --text-faint (disabled) and --border-strong (decorative hairline) are
   deliberately absent: both are exempt, and the reasons are recorded in the
   palette notes at the foot of tokens.css. */
const PAIRS = [
  ['text on bg', '--text', '--bg', 4.5],
  ['text on surface', '--text', '--surface', 4.5],
  ['text on surface-alt', '--text', '--surface-alt', 4.5],
  ['text on surface-hover', '--text', '--surface-hover', 4.5],
  ['text-dim on bg', '--text-dim', '--bg', 4.5],
  ['text-dim on surface', '--text-dim', '--surface', 4.5],
  ['text-dim on surface-alt (placeholder)', '--text-dim', '--surface-alt', 4.5],
  ['text-dim on surface-hover', '--text-dim', '--surface-hover', 4.5],
  ['accent text on bg', '--accent', '--bg', 4.5],
  ['accent text on surface', '--accent', '--surface', 4.5],
  ['active nav: accent on accent-soft', '--accent', '--accent-soft', 4.5],
  ['accent-text on accent', '--accent-text', '--accent', 4.5],
  ['accent-text on accent-hover', '--accent-text', '--accent-hover', 4.5],
  ['danger on surface', '--danger', '--surface', 4.5],
  ['danger on danger-soft', '--danger', '--danger-soft', 4.5],
  ['warn on surface', '--warn', '--surface', 4.5],
  ['success on surface', '--success', '--surface', 4.5],
  // Added by issue #09: the two component pairs that actually ship.
  ['success badge: success on surface-alt', '--success', '--surface-alt', 4.5],
  ['success on surface-hover', '--success', '--surface-hover', 4.5],
  ['focus ring on surface', '--accent', '--surface', 3.0],
  ['focus ring on bg', '--accent', '--bg', 3.0],
  ['ramp-4 on surface', '--ramp-4', '--surface', 3.0],
  ['ramp-3 on surface', '--ramp-3', '--surface', 3.0],
];

for (const [themeName, palette] of [['light', LIGHT], ['dark', DARK_EXPLICIT]]) {
  test(`${themeName} palette meets WCAG AA for every pair`, () => {
    for (const [label, fg, bg, need] of PAIRS) {
      const have = contrast(palette[fg], palette[bg]);
      assert.ok(
        have >= need,
        `${themeName}: ${label} is ${have.toFixed(2)}:1, needs ${need.toFixed(1)}:1`
      );
    }
  });
}

test('--warn has no accessible tinted fill in the light theme', () => {
  // This is why .notice.is-warn in app.css is an outlined callout rather than a
  // tinted one, and why there is no .badge.is-warn at all. --warn is light enough
  // (relative luminance 0.174) that it clears 4.5:1 only against --surface
  // itself; every tint in the palette leaves it short, and no tint dark enough to
  // fix it still reads as amber.
  //
  // Pinned here so that a future "tidy the warn styles up to match danger" fails
  // a test rather than shipping 3.4:1 text. --t-micro and --t-caption are 11 and
  // 12px, nowhere near WCAG's 18.66px-bold large-text threshold, so 4.5 is the
  // floor for all of these.
  const tints = ['--surface-alt', '--surface-hover', '--accent-soft'];

  for (const bg of tints) {
    const have = contrast(LIGHT['--warn'], LIGHT[bg]);
    assert.ok(
      have < 4.5,
      `light: warn on ${bg} now measures ${have.toFixed(2)}:1 — the palette has `
      + 'changed enough that .notice.is-warn could use a tinted fill again'
    );
  }

  // And the one background it does clear, which is the one it uses.
  assert.ok(contrast(LIGHT['--warn'], LIGHT['--surface']) >= 4.5);
  assert.ok(contrast(DARK_EXPLICIT['--warn'], DARK_EXPLICIT['--surface']) >= 4.5);
});

test('the two dark palette blocks are identical', () => {
  // tokens.css declares dark twice — once as the prefers-color-scheme fallback
  // and once for the explicit attribute — because CSS cannot share a body
  // between a media query and a bare selector without a build step. If they
  // ever drift, System mode and explicit Dark mode stop matching.
  assert.deepEqual(
    DARK_EXPLICIT,
    DARK_SYSTEM,
    'the prefers-color-scheme dark block and [data-theme="dark"] have drifted'
  );
});

test('light and dark define exactly the same token names', () => {
  const lightNames = Object.keys(LIGHT).sort();
  const darkNames = Object.keys(DARK_EXPLICIT).sort();
  assert.deepEqual(darkNames, lightNames);
});

test('every palette token resolves to a 6-digit hex', () => {
  for (const [themeName, palette] of [['light', LIGHT], ['dark', DARK_EXPLICIT]]) {
    for (const [name, value] of Object.entries(palette)) {
      if (name === '--color-scheme') continue;
      assert.match(
        value,
        /^#[0-9A-Fa-f]{6}$/,
        `${themeName} ${name} is "${value}" — palette tokens must be plain hex`
      );
    }
  }
});

test('the data ramp ascends in the right direction for each theme', () => {
  // Light ramps toward darkness; dark ramps toward brightness, because a dark
  // background reads intensity as light rather than as depth. Getting this
  // backwards is the most common dark-mode data-viz mistake.
  const lightSteps = [1, 2, 3, 4].map((i) => luminance(LIGHT[`--ramp-${i}`]));
  for (let i = 1; i < lightSteps.length; i++) {
    assert.ok(
      lightSteps[i] < lightSteps[i - 1],
      `light ramp step ${i + 1} is not darker than step ${i}`
    );
  }

  const darkSteps = [1, 2, 3, 4].map((i) => luminance(DARK_EXPLICIT[`--ramp-${i}`]));
  for (let i = 1; i < darkSteps.length; i++) {
    assert.ok(
      darkSteps[i] > darkSteps[i - 1],
      `dark ramp step ${i + 1} is not brighter than step ${i}`
    );
  }
});

test('no colour literals outside tokens.css', () => {
  // Non-negotiable #1: a hex literal in a screen file is a bug. base.css is
  // checked whole; swatches.html is checked inside its <style> block, since
  // its prose deliberately quotes hex values when explaining the deviations.
  const styleBlock = /<style>([\s\S]*?)<\/style>/.exec(SWATCHES);
  assert.ok(styleBlock, 'swatches.html has no <style> block to check');

  for (const [name, css] of [['base.css', BASE], ['swatches.html <style>', styleBlock[1]]]) {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const hits = withoutComments.match(/#[0-9A-Fa-f]{3,8}\b/g) || [];
    assert.deepEqual(hits, [], `${name} contains colour literals: ${hits.join(', ')}`);

    const fns = withoutComments.match(/\b(?:rgba?|hsla?|oklch|color-mix)\s*\(/g) || [];
    assert.deepEqual(fns, [], `${name} builds colours inline: ${fns.join(', ')}`);
  }
});

test('reduced motion zeroes every duration token', () => {
  const reduced = declarations(blockAfter(TOKENS, '@media (prefers-reduced-motion: reduce)'));
  for (const name of ['--dur-fast', '--dur-base', '--dur-slow']) {
    assert.equal(reduced[name], '1ms', `${name} is not zeroed under reduced motion`);
  }
});

test('swatches.html sets the theme before first paint', () => {
  // No theme flash on launch, ever. The inline script must come before the
  // stylesheet links, or the first frame paints in the wrong theme.
  const script = SWATCHES.indexOf('data-theme');
  const firstLink = SWATCHES.indexOf('<link rel="stylesheet"');
  assert.ok(script !== -1 && firstLink !== -1);
  assert.ok(
    script < firstLink,
    'the inline theme script must run before the stylesheets load'
  );
});

test('no box-shadow is introduced anywhere', () => {
  // The single most defining choice of the aesthetic. base.css sets
  // `box-shadow: none` in the reset; nothing may set a real one.
  for (const [name, css] of [['tokens.css', TOKENS], ['base.css', BASE], ['swatches.html', SWATCHES]]) {
    const shadows = (css.match(/box-shadow\s*:\s*([^;]+);/g) || [])
      .filter((d) => !/:\s*none\s*;/.test(d));
    assert.deepEqual(shadows, [], `${name} sets a box-shadow: ${shadows.join(', ')}`);
  }
});
