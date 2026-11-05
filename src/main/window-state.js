'use strict';

/**
 * Window size and position across launches — issue #16.
 *
 * Restoring saved bounds is three lines of happy path and a long tail of ways to
 * open a window nobody can see: a monitor that is no longer plugged in, a
 * resolution that shrank, a config edited by hand, a `null` from the very first
 * launch. All of it is pure arithmetic, so it lives here with tests rather than
 * inside the window factory where it could only be checked by unplugging a
 * screen.
 *
 * Bounds are stored in config under `ui.windowBounds`, which already exists in
 * the schema (the engine notes) — no migration is needed to start using it.
 */

/* the design notes: "Minimum window 900x640. Everything must survive it." */
const MIN_WIDTH = 900;
const MIN_HEIGHT = 640;

/* The size a first launch gets: the review size every screen was designed at. */
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;

/**
 * How much of the window has to still land on a display for its saved position to
 * be worth restoring: enough of the titlebar to grab. Below this the window is
 * treated as lost and gets centred instead — a window with a corner poking onto a
 * monitor is worse than one that opens in the middle, because there is nothing
 * left to drag it back with.
 *
 * Deliberately absolute rather than a fraction of the window: what matters is
 * whether there is a handle on screen, not what proportion of the window it is.
 */
const MIN_VISIBLE_WIDTH = 120;
const MIN_VISIBLE_HEIGHT = 40;

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max < min ? min : max);
}

/**
 * A stored bounds object, or null if it cannot be trusted. Rejects rather than
 * repairs: a config with a string width is a config someone edited, and guessing
 * what they meant is how a window ends up 40px tall.
 */
function sanitiseBounds(value) {
  if (!value || typeof value !== 'object') return null;
  const { x, y, width, height } = value;
  if (!isNumber(width) || !isNumber(height)) return null;
  if (width <= 0 || height <= 0) return null;

  const bounds = {
    width: Math.round(width),
    height: Math.round(height),
    maximised: value.maximised === true,
  };

  // Position is optional: a window may have been saved before it was ever moved.
  if (isNumber(x) && isNumber(y)) {
    bounds.x = Math.round(x);
    bounds.y = Math.round(y);
  }
  return bounds;
}

function workAreaOf(display) {
  const area = display && display.workArea ? display.workArea : display;
  if (!area || !isNumber(area.width) || !isNumber(area.height)) return null;
  return {
    x: isNumber(area.x) ? area.x : 0,
    y: isNumber(area.y) ? area.y : 0,
    width: area.width,
    height: area.height,
  };
}

/** The visible overlap between a window and a work area, per axis. */
function overlap(bounds, area) {
  return {
    width: Math.min(bounds.x + bounds.width, area.x + area.width)
      - Math.max(bounds.x, area.x),
    height: Math.min(bounds.y + bounds.height, area.y + area.height)
      - Math.max(bounds.y, area.y),
  };
}

/**
 * The display the window sits on, or null if it sits usefully on none of them —
 * the monitor was unplugged, or it was dragged almost entirely off the edge.
 */
function displayFor(bounds, displays) {
  let best = null;
  let bestArea = 0;

  for (const display of displays || []) {
    const area = workAreaOf(display);
    if (!area) continue;
    const seen = overlap(bounds, area);
    if (seen.width < MIN_VISIBLE_WIDTH || seen.height < MIN_VISIBLE_HEIGHT) continue;
    const visible = seen.width * seen.height;
    if (visible > bestArea) {
      best = area;
      bestArea = visible;
    }
  }
  return best;
}

/**
 * The bounds a window should open with.
 *
 * @param {object|null} saved     `ui.windowBounds` from config
 * @param {Array} displays        screen.getAllDisplays()
 * @returns {{width:number,height:number,x?:number,y?:number,maximised:boolean}}
 *          A result with no x/y means "let the OS centre it".
 */
function restoreBounds(saved, displays) {
  const fallback = {
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    maximised: false,
  };

  const bounds = sanitiseBounds(saved);
  if (!bounds) return fallback;

  // Never smaller than the minimum the screens were designed against, even if
  // the config says otherwise.
  bounds.width = Math.max(bounds.width, MIN_WIDTH);
  bounds.height = Math.max(bounds.height, MIN_HEIGHT);

  if (bounds.x === undefined) {
    return { width: bounds.width, height: bounds.height, maximised: bounds.maximised };
  }

  const area = displayFor(bounds, displays);
  if (!area) {
    // The display it was last on is gone, or it was saved off-screen.
    return { width: bounds.width, height: bounds.height, maximised: bounds.maximised };
  }

  /* A display that has since shrunk — a laptop panel after a dock, or a scaling
     change — must not produce a window taller than it. The minimum wins over the
     work area if they disagree: 900x640 is a hard floor, and a window slightly
     taller than a small screen is still usable, while a 600px-tall one is not. */
  const width = Math.max(MIN_WIDTH, Math.min(bounds.width, area.width));
  const height = Math.max(MIN_HEIGHT, Math.min(bounds.height, area.height));

  return {
    width,
    height,
    x: clamp(bounds.x, area.x, area.x + area.width - width),
    y: clamp(bounds.y, area.y, area.y + area.height - height),
    maximised: bounds.maximised,
  };
}

/**
 * What to persist. Takes the window's *normal* bounds — a maximised window's
 * outer bounds are the screen, and saving those would leave nothing to restore
 * to when it is unmaximised.
 */
function boundsToSave(normalBounds, { maximised = false } = {}) {
  const bounds = sanitiseBounds(normalBounds);
  if (!bounds) return null;
  return {
    x: bounds.x ?? null,
    y: bounds.y ?? null,
    width: bounds.width,
    height: bounds.height,
    maximised: Boolean(maximised),
  };
}

module.exports = {
  MIN_WIDTH,
  MIN_HEIGHT,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  MIN_VISIBLE_WIDTH,
  MIN_VISIBLE_HEIGHT,
  sanitiseBounds,
  restoreBounds,
  boundsToSave,
};
