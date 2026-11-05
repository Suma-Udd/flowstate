/**
 * Issue #16 — window size and position across launches.
 *
 * The happy path is three lines. Everything here is the tail: a monitor that is
 * no longer plugged in, a resolution that shrank, a config someone edited, the
 * very first launch. Each of those ends with a window nobody can see, and none of
 * them can be checked by looking at the app on the machine it works on.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MIN_WIDTH,
  MIN_HEIGHT,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  sanitiseBounds,
  restoreBounds,
  boundsToSave,
} = require('../src/main/window-state');

/* A 1920x1080 primary with a 40px taskbar, and a second display to the left with
   a negative origin — the arrangement that catches naive clamping. */
const PRIMARY = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const LEFT = { workArea: { x: -1280, y: 0, width: 1280, height: 984 } };
const DISPLAYS = [PRIMARY, LEFT];

test('a first launch gets the size every screen was designed at', () => {
  const bounds = restoreBounds(null, DISPLAYS);
  assert.equal(bounds.width, DEFAULT_WIDTH);
  assert.equal(bounds.height, DEFAULT_HEIGHT);
  assert.equal(bounds.maximised, false);
  assert.equal(bounds.x, undefined, 'a first launch should be centred by the OS');
});

test('saved bounds on a live display are restored exactly', () => {
  const saved = { x: 120, y: 80, width: 1400, height: 900, maximised: false };
  assert.deepEqual(restoreBounds(saved, DISPLAYS), {
    x: 120, y: 80, width: 1400, height: 900, maximised: false,
  });
});

test('a window saved on the second display comes back to it', () => {
  const saved = { x: -1200, y: 40, width: 1000, height: 700 };
  const bounds = restoreBounds(saved, DISPLAYS);
  assert.equal(bounds.x, -1200);
  assert.equal(bounds.y, 40);
});

test('a position on a display that is gone falls back to centred', () => {
  // Same saved bounds, but the second monitor has been unplugged.
  const saved = { x: -1200, y: 40, width: 1000, height: 700 };
  const bounds = restoreBounds(saved, [PRIMARY]);
  assert.equal(bounds.x, undefined, 'the window would have opened off-screen');
  assert.equal(bounds.width, 1000, 'the size is still worth keeping');
  assert.equal(bounds.height, 700);
});

test('a window with almost nothing left on screen is centred', () => {
  // 70px of it was visible — not enough titlebar to grab, so it is treated as
  // lost rather than nudged back into place.
  const bounds = restoreBounds({ x: 1850, y: 200, width: 1000, height: 700 }, [PRIMARY]);
  assert.equal(bounds.x, undefined);
  const below = restoreBounds({ x: 400, y: 1020, width: 1000, height: 700 }, [PRIMARY]);
  assert.equal(below.x, undefined, 'only 20px of the top edge was on screen');
});

test('a window slightly off an edge is nudged rather than discarded', () => {
  const bounds = restoreBounds({ x: 1200, y: 900, width: 1000, height: 700 }, [PRIMARY]);
  assert.equal(bounds.x, 920, 'not clamped to the work area');
  assert.equal(bounds.y, 340);
});

test('the 900x640 minimum wins over a smaller saved size', () => {
  const bounds = restoreBounds({ x: 10, y: 10, width: 400, height: 300 }, [PRIMARY]);
  assert.equal(bounds.width, MIN_WIDTH);
  assert.equal(bounds.height, MIN_HEIGHT);
});

test('a window larger than the display it lands on is shrunk to fit', () => {
  const small = { workArea: { x: 0, y: 0, width: 1366, height: 728 } };
  const bounds = restoreBounds({ x: 0, y: 0, width: 2400, height: 1400 }, [small]);
  assert.equal(bounds.width, 1366);
  assert.equal(bounds.height, 728);
  assert.equal(bounds.x, 0);
  assert.equal(bounds.y, 0);
});

test('the minimum still wins on a display smaller than it', () => {
  // A 1280x720 panel cannot show 900x640 plus chrome comfortably, but a 900x640
  // window is still usable and the screens are not designed below it.
  const tiny = { workArea: { x: 0, y: 0, width: 800, height: 600 } };
  const bounds = restoreBounds({ x: 0, y: 0, width: 1280, height: 800 }, [tiny]);
  assert.equal(bounds.width, MIN_WIDTH);
  assert.equal(bounds.height, MIN_HEIGHT);
});

test('a maximised window comes back maximised', () => {
  const bounds = restoreBounds(
    { x: 100, y: 100, width: 1280, height: 800, maximised: true },
    DISPLAYS
  );
  assert.equal(bounds.maximised, true);
  // The normal bounds survive, so unmaximising restores the right size.
  assert.equal(bounds.width, 1280);
  assert.equal(bounds.x, 100);
});

test('nonsense in the config is rejected rather than repaired', () => {
  for (const value of [
    undefined,
    null,
    'maximised',
    42,
    {},
    { width: '1280', height: 800 },
    { width: 1280, height: null },
    { width: 0, height: 0 },
    { width: -1280, height: -800 },
    { width: Number.NaN, height: 800 },
    { width: Number.POSITIVE_INFINITY, height: 800 },
  ]) {
    assert.equal(sanitiseBounds(value), null, `${JSON.stringify(value)} was accepted`);
  }
});

test('a size with no position is usable on its own', () => {
  const bounds = restoreBounds({ width: 1000, height: 700 }, DISPLAYS);
  assert.deepEqual(bounds, { width: 1000, height: 700, maximised: false });
});

test('fractional bounds are rounded, because a window cannot be 1279.5 wide', () => {
  const bounds = restoreBounds({ x: 10.4, y: 10.6, width: 1279.5, height: 799.4 }, [PRIMARY]);
  assert.equal(bounds.width, 1280);
  assert.equal(bounds.height, 799);
  assert.equal(bounds.x, 10);
  assert.equal(bounds.y, 11);
});

test('what gets saved is the normal geometry plus the maximised flag', () => {
  assert.deepEqual(
    boundsToSave({ x: 100, y: 50, width: 1280, height: 800 }, { maximised: true }),
    { x: 100, y: 50, width: 1280, height: 800, maximised: true }
  );
  assert.equal(boundsToSave(null), null, 'nothing to save must not write a broken object');
});

test('what is saved round-trips through what is restored', () => {
  const saved = boundsToSave({ x: 64, y: 32, width: 1500, height: 950 }, { maximised: false });
  assert.deepEqual(restoreBounds(saved, DISPLAYS), {
    x: 64, y: 32, width: 1500, height: 950, maximised: false,
  });
});
