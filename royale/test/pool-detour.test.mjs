// Pathing regression for the "troops stand face to face" report.
//
// This suite drives the REAL troop layer (src/troops.js) in Node - no browser
// - and reproduces the two shapes of the bug:
//
//   1. a pair pinned at the pool's edge just outside the bridge span, where
//      the straight line between them cuts the water and the old code had no
//      detour at all, so each walked into the waterline every frame and the
//      collision cascade slid them back: net-zero motion, never a blow;
//   2. left+middle / right+middle lane meetings, where a bank unit and a deck
//      unit on the same half are separated by the pool in x.
//
// A unit that walks a genuinely clear lane must NOT be sent on a detour, so
// the lane-march and bridge-cross cases are guarded too.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => pathToFileURL(path.join(here, '..', 'src', f)).href;

const { buildTroops, passable } = await import(src('troops.js'));
const { CHARACTERS } = await import(src('characters.js'));
const { CARDS } = await import(src('config.js'));

const PIP = CHARACTERS.find((c) => c.id === 'pip');
const PIP_STATS = CARDS.pip;
const DT = 1 / 60;

/** A fake enemy king, so a unit has something to walk at across the river. */
const FAKE_KING = { x: 0, z: -17.2, side: 'enemy', destroyed: false };

function newLayer(towers = []) {
  return buildTroops({ towers });
}

/**
 * Run a two-unit scenario for `seconds`, sampling at 0.5s so a stuck unit is
 * caught: if a unit covers real ground in a window but goes nowhere (net stay
 * near zero) while it is NOT in melee, that is the vibration, not marching.
 *
 * @returns {{a: object, b: object, minDist: number, stalls: Array<string>}}
 */
function runPair(layer, aPos, bPos, seconds) {
  const a = layer.spawn(PIP, aPos.x, aPos.z, aPos.side);
  const b = layer.spawn(PIP, bPos.x, bPos.z, bPos.side);
  assert.ok(a && b, `both units spawned at ${JSON.stringify(aPos)} / ${JSON.stringify(bPos)}`);

  const ticks = Math.round(seconds / DT);
  const SAMPLE = 60; // 1s: long enough that a corner turn still nets progress
  const stalls = [];
  let minDist = Infinity;

  // Per-tick previous positions (for path length) and per-sample anchors (for
  // net progress) are kept apart on purpose: using one pair for both made the
  // net term a single tick's movement while comparing it against half a
  // second's path, which flagged every honest marcher as stalled.
  let px = a.x; let pz = a.z; let qx = b.x; let qz = b.z;
  let ax0 = a.x; let az0 = a.z; let bx0 = b.x; let bz0 = b.z;
  let aPath = 0; let bPath = 0;

  for (let i = 1; i <= ticks; i++) {
    layer.update(DT);

    for (const t of layer.troops) {
      if (t.dead) continue;
      assert.ok(passable(t.x, t.z), `tick ${i}: unit at (${t.x.toFixed(2)}, ${t.z.toFixed(2)}) is not walkable`);
    }

    if (!a.dead) { aPath += Math.hypot(a.x - px, a.z - pz); px = a.x; pz = a.z; }
    if (!b.dead) { bPath += Math.hypot(b.x - qx, b.z - qz); qx = b.x; qz = b.z; }

    if (!a.dead && !b.dead) {
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      minDist = Math.min(minDist, d);
    }

    if (i % SAMPLE === 0) {
      const d = (!a.dead && !b.dead) ? Math.hypot(a.x - b.x, a.z - b.z) : minDist;
      const engaged = d <= PIP_STATS.range + 0.05;
      const anyWindup = a.attackState !== 'idle' || b.attackState !== 'idle';
      if (!engaged && !anyWindup) {
        const aMoved = a.dead ? 0 : Math.hypot(a.x - ax0, a.z - az0);
        const bMoved = b.dead ? 0 : Math.hypot(b.x - bx0, b.z - bz0);
        // A marching unit at speed 3.6 covers ~3.6 units in 1s, and even a
        // unit that turns a corner mid-window nets well over 2. The bug this
        // guards against is net-zero motion - walking into the waterline and
        // being slid back every frame - which nets under half a unit while
        // covering a full second of path.
        if (aPath > 1.0 && aMoved < 0.5) {
          stalls.push(`a stalled at (${a.x.toFixed(2)}, ${a.z.toFixed(2)}) path=${aPath.toFixed(2)} net=${aMoved.toFixed(2)}`);
        }
        if (bPath > 1.0 && bMoved < 0.5) {
          stalls.push(`b stalled at (${b.x.toFixed(2)}, ${b.z.toFixed(2)}) path=${bPath.toFixed(2)} net=${bMoved.toFixed(2)}`);
        }
      }
      aPath = 0; bPath = 0;
      ax0 = a.x; az0 = a.z; bx0 = b.x; bz0 = b.z;
    }
  }
  return { a, b, minDist, stalls };
}

test('pool-edge pair (deck side vs bank side) closes and fights', () => {
  // The literal pinned pair: a on the deck's legal edge just outside the span
  // (|z| = 5.83 > 5.8, so onBridge is false), b on the grass bank edge. The
  // straight line between them clips the pool for its whole length.
  const layer = newLayer();
  const { a, b, minDist, stalls } = runPair(
    layer,
    { x: 1.93, z: -5.83, side: 'player' },
    { x: 3.7, z: -5.83, side: 'enemy' },
    8,
  );
  assert.equal(stalls.length, 0, `units ground in place: ${stalls.join(' | ')}`);
  assert.ok(minDist <= PIP_STATS.range + 0.05,
    `pair never closed to melee: closest ${minDist.toFixed(2)} (need <= ${(PIP_STATS.range + 0.05).toFixed(2)})`);
  assert.ok(a.hp < a.maxHp && b.hp < b.maxHp,
    `pair did not trade blows: a.hp=${a.hp}, b.hp=${b.hp} (both must be below ${a.maxHp})`);
});

test('left lane meeting the middle engages instead of staring', () => {
  const layer = newLayer();
  const { minDist, stalls } = runPair(
    layer,
    { x: -6, z: -1, side: 'player' },
    { x: 0, z: -1, side: 'enemy' },
    9,
  );
  assert.equal(stalls.length, 0, `units ground in place: ${stalls.join(' | ')}`);
  assert.ok(minDist <= PIP_STATS.range + 0.05, `never closed to melee: closest ${minDist.toFixed(2)}`);
});

test('right lane meeting the middle engages instead of staring', () => {
  const layer = newLayer();
  const { minDist, stalls } = runPair(
    layer,
    { x: 6, z: -1, side: 'player' },
    { x: 0, z: -1, side: 'enemy' },
    9,
  );
  assert.equal(stalls.length, 0, `units ground in place: ${stalls.join(' | ')}`);
  assert.ok(minDist <= PIP_STATS.range + 0.05, `never closed to melee: closest ${minDist.toFixed(2)}`);
});

test('a clear left-lane march is not diverted', () => {
  // A left-lane unit targets the enemy's LEFT tower (x -6.2), so its route
  // runs straight down its own bank and never meets the pool. It must not be
  // sent around a pool end it was never going to touch.
  const leftTower = { x: -6.2, z: -10.9, side: 'enemy', destroyed: false };
  const layer = newLayer([leftTower]);
  const t = layer.spawn(PIP, -6, 12, 'player');
  assert.ok(t);
  let maxDrift = 0;
  for (let i = 1; i <= Math.round(14 / DT); i++) {
    layer.update(DT);
    assert.ok(passable(t.x, t.z), `left lane step ${i} not walkable`);
    maxDrift = Math.max(maxDrift, Math.abs(t.x + 6));
  }
  assert.ok(maxDrift < 1.4, `left-lane unit drifted off its lane by ${maxDrift.toFixed(2)}`);
  assert.ok(t.z < -8, `left-lane unit did not reach its tower, ended z=${t.z.toFixed(2)}`);
});

test('a middle-lane march still crosses on the bridge', () => {
  const layer = newLayer([FAKE_KING]);
  const t = layer.spawn(PIP, 0, 8, 'player');
  assert.ok(t);
  for (let i = 1; i <= Math.round(14 / DT); i++) {
    layer.update(DT);
    assert.ok(passable(t.x, t.z), `mid step ${i} not walkable`);
    if (Math.abs(t.z) <= 5.8) {
      assert.ok(Math.abs(t.x) <= 1.95 + 1e-9,
        `mid unit left the deck while inside the span: x=${t.x.toFixed(2)}, z=${t.z.toFixed(2)}`);
    }
  }
  assert.ok(t.z < -10, `mid-lane unit did not cross, ended z=${t.z.toFixed(2)}`);
});
