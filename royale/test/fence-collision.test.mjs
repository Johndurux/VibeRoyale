import test from 'node:test';
import assert from 'node:assert/strict';

const BRIDGE_HALF_W = 1.95; // Walkable deck inside railings
const FENCE_OUTER_X = 2.35; // Outer boundary of railings & posts
const FENCE_SPAN_Z = 5.8;  // Length of bridge railing
const RIVER_HALF_W = 2.9;  // River bank edge
const RIVER_HALF_L = 5.2;  // River bank Z edge
const ARENA_HW = 11.0;
const ARENA_HL = 22.0;

export function passable(x, z) {
  const ax = Math.abs(x);
  const az = Math.abs(z);

  // 1. Bridge railing / fence collision
  if (az <= FENCE_SPAN_Z && ax > BRIDGE_HALF_W && ax <= FENCE_OUTER_X) {
    return false;
  }

  // 2. River water collision
  if (az < RIVER_HALF_L) {
    if (ax > BRIDGE_HALF_W && ax < RIVER_HALF_W) {
      return false;
    }
  }

  return true;
}

export function stepToward(t, tx, tz, dt) {
  const dx = tx - t.x;
  const dz = tz - t.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-4) { t.moving = false; return; }

  const s = t.stats.speed * dt;

  // Determine if moving across the river
  const crossingRiver = (t.z * tz < 0);
  const onBridge = (Math.abs(t.x) <= BRIDGE_HALF_W && Math.abs(t.z) <= FENCE_SPAN_Z);
  const mySide = Math.sign(t.z) || 1;
  const mouthZ = mySide * (FENCE_SPAN_Z + 0.2);

  let aimX = tx;
  let aimZ = tz;

  if (crossingRiver) {
    if (Math.abs(t.x) <= BRIDGE_HALF_W) {
      // Aligned with the bridge: cross through
      if (Math.abs(t.z) <= FENCE_SPAN_Z) {
        aimX = t.x;
        aimZ = -mySide * (FENCE_SPAN_Z + 0.5);
      } else {
        aimX = 0;
        aimZ = tz;
      }
    } else if (Math.abs(t.x) < RIVER_HALF_W) {
      // In center corridor approaching bridge from side: funnel through mouth
      aimX = 0;
      aimZ = mouthZ;
    }
  } else if (onBridge && Math.abs(tx) > BRIDGE_HALF_W) {
    // On bridge but targeting something on the bank: must exit bridge first
    aimX = t.x;
    aimZ = Math.sign(tz - t.z || mySide) * (FENCE_SPAN_Z + 0.5);
  }

  const adx = aimX - t.x;
  const adz = aimZ - t.z;
  const ad = Math.hypot(adx, adz) || 1;

  let nx = t.x + (adx / ad) * s;
  let nz = t.z + (adz / ad) * s;

  // Collision resolution against fence and water
  if (!passable(nx, nz)) {
    if (passable(t.x, nz)) {
      nx = t.x;
    } else if (passable(nx, t.z)) {
      nz = t.z;
    } else {
      const altZ = t.z + Math.sign(adz || 1) * s;
      if (passable(t.x, altZ)) {
        nx = t.x;
        nz = altZ;
      } else {
        t.moving = false;
        return;
      }
    }
  }

  // Final safety clamp
  const mx = ARENA_HW - 0.6;
  const mz = ARENA_HL - 0.6;
  t.x = Math.max(-mx, Math.min(mx, nx));
  t.z = Math.max(-mz, Math.min(mz, nz));
  t.moving = true;
  t.facing = Math.atan2(dx, dz);
}

export function separateTroops(troops, separation = 0.9) {
  for (let i = 0; i < troops.length; i++) {
    const a = troops[i];
    if (a.dead) continue;
    for (let j = i + 1; j < troops.length; j++) {
      const b = troops[j];
      if (b.dead || b.side !== a.side) continue;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const d = Math.hypot(dx, dz);
      if (d >= separation) continue;
      if (d < 1e-4) {
        if (passable(b.x + 0.05, b.z)) b.x += 0.05;
        continue;
      }
      const push = (separation - d) * 0.5;
      const ux = dx / d;
      const uz = dz / d;

      const ax = a.x - ux * push;
      const az = a.z - uz * push;
      const bx = b.x + ux * push;
      const bz = b.z + uz * push;

      if (passable(ax, az)) { a.x = ax; a.z = az; }
      else if (passable(ax, a.z)) { a.x = ax; }
      else if (passable(a.x, az)) { a.z = az; }

      if (passable(bx, bz)) { b.x = bx; b.z = bz; }
      else if (passable(bx, b.z)) { b.x = bx; }
      else if (passable(b.x, bz)) { b.z = bz; }
    }
  }
}

test('unit crossing arena never clips through fence or walks on water', () => {
  // Scenario 1: Unit spawned at (3.5, 8.0) walking toward King tower (0, -13.2)
  const t1 = { x: 3.5, z: 8.0, stats: { speed: 3.0 }, moving: false, facing: 0 };
  for (let step = 0; step < 600; step++) {
    stepToward(t1, 0, -13.2, 0.016);
    assert.equal(passable(t1.x, t1.z), true, `Step ${step}: (${t1.x.toFixed(2)}, ${t1.z.toFixed(2)}) must be passable`);
    if (Math.abs(t1.z) < RIVER_HALF_L) {
      assert.ok(Math.abs(t1.x) <= BRIDGE_HALF_W || Math.abs(t1.x) >= RIVER_HALF_W,
        `Step ${step}: (${t1.x.toFixed(2)}, ${t1.z.toFixed(2)}) cannot be in fence or water`);
    }
  }
  assert.ok(t1.z < 0, 'Unit successfully crossed to enemy side');

  // Scenario 2: Unit on bridge deck (0, 0) targeting side enemy at (6.2, 0)
  const t2 = { x: 0, z: 0, stats: { speed: 3.0 }, moving: false, facing: 0 };
  for (let step = 0; step < 200; step++) {
    stepToward(t2, 6.2, 0, 0.016);
    assert.equal(passable(t2.x, t2.z), true, `Step ${step}: (${t2.x.toFixed(2)}, ${t2.z.toFixed(2)}) must be passable`);
    if (Math.abs(t2.z) <= FENCE_SPAN_Z) {
      assert.ok(Math.abs(t2.x) <= BRIDGE_HALF_W,
        `Unit on bridge must stay on bridge deck until exit, got x=${t2.x.toFixed(2)}`);
    }
  }

  // Scenario 3: Unit on side bank (4.0, 2.0) targeting unit on bridge (0, 2.0)
  const t3 = { x: 4.0, z: 2.0, stats: { speed: 3.0 }, moving: false, facing: 0 };
  for (let step = 0; step < 400; step++) {
    stepToward(t3, 0, 2.0, 0.016);
    assert.equal(passable(t3.x, t3.z), true, `Step ${step}: (${t3.x.toFixed(2)}, ${t3.z.toFixed(2)}) must be passable`);
    if (Math.abs(t3.z) < RIVER_HALF_L) {
      assert.ok(Math.abs(t3.x) >= RIVER_HALF_W || Math.abs(t3.x) <= BRIDGE_HALF_W,
        `Unit cannot clip fence from bank, got x=${t3.x.toFixed(2)}, z=${t3.z.toFixed(2)}`);
    }
  }

  // Scenario 4: Direct middle lane push from (0, 10) to (0, -10)
  const t4 = { x: 0, z: 10.0, stats: { speed: 3.0 }, moving: false, facing: 0 };
  for (let step = 0; step < 500; step++) {
    stepToward(t4, 0, -10.0, 0.016);
    assert.equal(passable(t4.x, t4.z), true);
    assert.ok(Math.abs(t4.x) <= BRIDGE_HALF_W, 'Stays on bridge');
  }
  assert.ok(t4.z < -9, `Crossed completely to target, ended at ${t4.z}`);
});

test('soft separation on bridge never pushes friendly troops through fences', () => {
  // Two troops placed side-by-side on the bridge deck near the fence
  const tA = { x: 1.5, z: 1.0, side: 'player', dead: false };
  const tB = { x: 1.8, z: 1.0, side: 'player', dead: false };
  const troops = [tA, tB];

  for (let iter = 0; iter < 50; iter++) {
    separateTroops(troops, 0.9);
    assert.equal(passable(tA.x, tA.z), true, `tA (${tA.x.toFixed(2)}, ${tA.z.toFixed(2)}) must remain passable`);
    assert.equal(passable(tB.x, tB.z), true, `tB (${tB.x.toFixed(2)}, ${tB.z.toFixed(2)}) must remain passable`);
    assert.ok(Math.abs(tA.x) <= BRIDGE_HALF_W, `tA x must be <= ${BRIDGE_HALF_W}, got ${tA.x}`);
    assert.ok(Math.abs(tB.x) <= BRIDGE_HALF_W, `tB x must be <= ${BRIDGE_HALF_W}, got ${tB.x}`);
  }
});
