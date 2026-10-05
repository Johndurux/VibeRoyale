// -- troops.js --------------------------------------------------------------
// The things you actually play.
//
// A troop is a character model plus a card's stats plus a little state: where
// it is standing, what it is hitting, how long until it swings again. This is
// deliberately the only module that knows how a unit moves, walks, hits and
// dies, so main.js stays a wiring diagram and towers.js stays about towers.

import * as THREE from 'three';
import { CARDS, ARENA } from './config.js';
import { damageTower, hpColour } from './towers.js';
import { decoBox } from './voxel.js';

// The one copy of "is this water". arena.js draws the river from the same
// ARENA.river footprint, so the thing a troop refuses to walk into and the
// thing the player can see are guaranteed to be the same shape.
const RIVER = ARENA.river;

// How far out a troop notices an enemy it was not already walking toward. Wide
// enough that a push through the middle gets intercepted, tight enough that a
// troop in the far lane ignores a scrap three lanes over.
const AGGRO = 6.5;

// Bodies push each other apart so a five-card push arrives as a wall of
// fighters rather than five models occupying the same cubic decimetre.
const SEPARATION = 1.5;

// Tower padding. A troop stops this far short of a tower's centre instead of
// walking into it: the king is a vault, not a post, and clipping the model into
// the masonry looks like a bug even though the numbers are fine.
const TOWER_PAD = 1.5;

// Ceiling on live troops. Elixir already limits how fast anyone can fill the
// field, but a 10-drop regen race should not be able to make the frame budget
// the thing that decides the match.
const MAX_TROOPS = 28;

// HP bar sits above the tallest headwear in the roster (the hat tops out
// around y=2.5) with a little air, so no card's bar is ever inside its own hat.
const BAR_Y = 3.15;
const BAR_W = 1.5;
const BAR_H = 0.24;

// Re-aim interval. Recomputing the target every frame makes a troop oscillate
// between two equidistant enemies; a third of a second is often enough to feel
// instant and slow enough to stay committed.
const RETARGET = 0.3;

const BRIDGE_HALF_W = 1.95; // Walkable deck inside bridge railings
const FENCE_OUTER_X = 2.35; // Outer boundary of railings & posts
const FENCE_SPAN_Z = 5.8;   // Length of bridge railing
const RIVER_HALF_W = RIVER.halfW; // 2.9
const RIVER_HALF_L = RIVER.halfL; // 5.2

/**
 * Footprint check: tests if a coordinate is walkable.
 * - Bridge deck (|x| <= 1.95, |z| <= 5.8) is WALKABLE.
 * - Bridge railings & posts (1.95 < |x| <= 2.35, |z| <= 5.8) are IMPASSABLE.
 * - River water (1.95 < |x| < 2.9, |z| < 5.2) is IMPASSABLE.
 * - Side grass banks (|x| >= 2.9) and end fields (|z| >= 5.2) are WALKABLE.
 * @param {number} x
 * @param {number} z
 * @returns {boolean}
 */
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

/** '#a259ff' -> 0xa259ff, for reusing a card's own colour on its debris. */
function hexOf(css) {
  return parseInt(String(css).replace('#', ''), 16);
}

// The three HP bands, taken from towers.js's hpColour rather than restated as
// hexes here. towers.js is already the single owner of that colour language -
// it is what the tower screens and the HUD rows are painted from - so a fourth
// copy of "green is healthy, red is dying" written into this file is exactly
// the kind of drift that ends with a green troop next to a red tower.
const HP_BANDS = [hpColour(1), hpColour(0.4), hpColour(0.1)];

/**
 * A health bar over a troop's head.
 *
 * Three fills, one per band, and the update swaps which child is visible rather
 * than recolouring a mesh. That is not fussiness: voxel.js hands out shared
 * cached materials, so writing `fill.material.color` would repaint every other
 * object in the game using that colour. Swapping visibility is the way to get
 * a colour change out of a cache that must not be mutated.
 *
 * The camera is fixed, so the bar needs no billboarding - it is built facing
 * +Z, which is where the camera always is.
 */
function buildBar() {
  const g = new THREE.Group();
  g.add(decoBox(BAR_W + 0.14, BAR_H + 0.12, 0.08, 0x1a1a1a, { y: 0 }));
  const fills = HP_BANDS.map((css) => {
    const m = decoBox(BAR_W, BAR_H, 0.1, hexOf(css), { y: 0.02, z: 0.03 });
    m.visible = false;
    g.add(m);
    return m;
  });
  g.position.y = BAR_Y;
  return { g, fills };
}

/**
 * Build the live troop.
 * @param {object} card entry from CHARACTERS - supplies the model
 * @param {object} stats entry from CARDS - supplies the numbers
 * @param {number} x
 * @param {number} z
 * @param {'player'|'enemy'} side
 * @returns {object} the troop
 */
function makeTroop(card, stats, x, z, side) {
  // The real voxel model, the same build() the card portrait was rendered from.
  // Nothing here is a stand-in, so what you pick is literally what arrives.
  const model = card.build();

  // holder -> model, so the spawn squash scales the whole fighter and the
  // attack lunge can slide the model forward without touching the mesh.
  const root = new THREE.Group();
  const mesh = new THREE.Group();
  mesh.add(model);
  root.add(mesh);

  const bar = buildBar();
  root.add(bar.g);

  return {
    card,
    stats,
    side,
    x,
    z,
    root,
    mesh,
    model,
    bar: bar.fills,
    barHost: bar.g,
    hp: stats.hp,
    maxHp: stats.hp,
    swing: 0,        // seconds until the next hit lands
    retarget: 0,     // seconds until the next target search
    // Seconds of freeze remaining. Counts down in update() and gates both
    // movement and attacks, so a frozen unit is genuinely inert rather than
    // merely slowed - the difference between a spell and a tax.
    frozen: 0,
    target: null,
    walk: 0,         // walk-cycle phase
    facing: side === 'player' ? Math.PI : 0,
    moving: false,
    lunge: 0,        // attack recoil, decays to 0
    born: 0,         // spawn-in progress, 0..1
    dead: false,
    deathT: 0,
    attackState: 'idle', // 'idle' | 'windup' | 'recovery'
    windupT: 0,
    attackTarget: null,
  };
}

/**
 * Pick what this troop should be hitting: the nearest enemy troop inside
 * aggro, otherwise the nearest enemy tower still standing.
 *
 * Nearest-tower is doing real work rather than being lazy. A troop that spawns
 * in the left lane is already closest to the left tower, so it walks to the
 * tower that lane defends without anyone having to assign lanes - and when
 * that tower falls it re-evaluates and moves on to whatever is nearest.
 *
 * @param {object} t
 * @param {Array<object>} troops
 * @param {Array<object>} towers
 * @returns {{kind: 'troop'|'tower', ref: object}|null}
 */
function pickTarget(t, troops, towers) {
  // The card's own declared priority, defaulting to the historical behaviour
  // so any card without the field keeps working.
  const mode = (t.card && t.card.targetPriority) || 'nearest';

  // A buildings-only unit still defends itself. If no enemy tower is worth
  // walking to, it fights, because a siege unit that stands in a crowd and
  // does nothing is not an answer to anything.
  if (mode === 'buildings') {
    let bw = null;
    let bwD = Infinity;
    for (const w of towers) {
      if (w.side === t.side || w.destroyed) continue;
      const d = (w.x - t.x) * (w.x - t.x) + (w.z - t.z) * (w.z - t.z);
      if (d < bwD) { bwD = d; bw = { kind: 'tower', ref: w }; }
    }
    if (bw) return bw;
  }

  let best = null;
  let bestD = AGGRO * AGGRO;
  // Separate from bestD on purpose. In lowestHP mode bestD holds a distance,
  // and overloading one variable for two units is how a radius check quietly
  // turns into an HP check.
  let bestHp = Infinity;
  for (const o of troops) {
    if (o.side === t.side || o.dead) continue;
    const d = (o.x - t.x) * (o.x - t.x) + (o.z - t.z) * (o.z - t.z);
    if (d >= AGGRO * AGGRO) continue;
    if (mode === 'lowestHP') {
      // Ties break on distance, so a cluster of identical 3-drops does not all
      // converge on one and leave a lane open.
      if (o.hp < bestHp) { bestHp = o.hp; bestD = d; best = { kind: 'troop', ref: o }; }
      else if (best && o.hp === bestHp && d < bestD) { bestD = d; best = { kind: 'troop', ref: o }; }
    } else if (d < bestD) {
      bestD = d; best = { kind: 'troop', ref: o };
    }
  }
  if (best) return best;

  bestD = Infinity;
  for (const w of towers) {
    if (w.side === t.side || w.destroyed) continue;
    const d = (w.x - t.x) * (w.x - t.x) + (w.z - t.z) * (w.z - t.z);
    if (d < bestD) { bestD = d; best = { kind: 'tower', ref: w }; }
  }
  return best;
}

/**
 * One step toward a point, refusing to enter the river.
 *
 * There is no pathfinder here and there does not need to be one: the river is
 * the only obstacle, it spans the middle, and the bridge sits on the centre
 * line. So a blocked step is answered by aiming at the bridge mouth instead of
 * the target, which makes every troop in the game funnel over the same stone
 * the player can see. Pushes read as a column crossing, not as units sliding
 * across the water.
 *
 * @param {object} t
 * @param {number} tx
 * @param {number} tz
 * @param {number} dt
 */
function stepToward(t, tx, tz, dt) {
  const dx = tx - t.x;
  const dz = tz - t.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-4) { t.moving = false; return; }

  const s = t.stats.speed * dt;

  // River crossing and bridge navigation
  const crossingRiver = (t.z * tz < 0);
  const onBridge = (Math.abs(t.x) <= BRIDGE_HALF_W && Math.abs(t.z) <= FENCE_SPAN_Z);
  const mySide = Math.sign(t.z) || 1;
  const mouthZ = mySide * (FENCE_SPAN_Z + 0.2);

  let aimX = tx;
  let aimZ = tz;

  if (crossingRiver) {
    if (Math.abs(t.x) <= BRIDGE_HALF_W) {
      // Aligned with the bridge deck: cross through
      if (Math.abs(t.z) <= FENCE_SPAN_Z) {
        aimX = t.x;
        aimZ = -mySide * (FENCE_SPAN_Z + 0.5);
      } else {
        aimX = 0;
        aimZ = tz;
      }
    } else if (Math.abs(t.x) < RIVER_HALF_W) {
      // In center corridor approaching bridge from side: funnel cleanly through mouth
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

  // Collision resolution against bridge fence and water
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

  // Safety clamp
  const mx = ARENA.halfWidth - 0.6;
  const mz = ARENA.halfLength - 0.6;
  t.x = Math.max(-mx, Math.min(mx, nx));
  t.z = Math.max(-mz, Math.min(mz, nz));
  t.moving = true;
  // Face travel, not the target: a troop sidestepping around a friend should
  // not skate sideways while facing its enemy.
  t.facing = Math.atan2(dx, dz);
}

/**
 * Land one hit. Towers go through towers.js's own damageTower(), which already
 * raises the damage number, marks the glitch and wrecks the mesh on KO - so a
 * troop killing a tower takes exactly the same path the old keydown demo did,
 * just with a fighter standing there instead of a hardcoded 120.
 *
 * @param {object} t
 * @param {object} onHit called as (troop, amount) for troop-on-troop hits
 */
function strike(t, onHit) {
  t.swing = t.stats.hitEvery;
  t.lunge = 1;
  const amount = t.stats.dps * t.stats.hitEvery;
  const tgt = t.target;
  if (!tgt) return;
  if (tgt.kind === 'tower') {
    damageTower(tgt.ref, amount);
  } else if (!tgt.ref.dead) {
    tgt.ref.hp -= amount;
    if (tgt.ref.hp <= 0) {
      tgt.ref.dead = true;
      tgt.ref.deathT = 0.26;
    }
    if (onHit) onHit(tgt.ref, amount);
  }
}

/**
 * Mount the troop layer.
 *
 * @param {{towers: Array<object>, onHit?: (troop: object, amount: number) => void}} deps
 */
export function buildTroops({ towers, vfx = null, audio = null, onHit = null, onTowerHit = null }) {
  const root = new THREE.Group();
  const troops = [];

  function applyHit(t, tgt) {
    if (!tgt || t.dead) return;
    const amount = t.stats.dps * t.stats.hitEvery;
    if (tgt.kind === 'tower') {
      if (!tgt.ref.destroyed) {
        damageTower(tgt.ref, amount);
        if (onTowerHit) onTowerHit(t, tgt.ref);
      }
    } else if (!tgt.ref.dead) {
      tgt.ref.hp -= amount;
      if (vfx && vfx.hitSparks) {
        vfx.hitSparks(tgt.ref.x, 1.4, tgt.ref.z, 0xffe066);
      }
      if (tgt.ref.hp <= 0) {
        tgt.ref.dead = true;
        tgt.ref.deathT = 0.26;
        if (vfx && vfx.koPoof) {
          vfx.koPoof(tgt.ref.x, tgt.ref.z, tgt.ref.card ? tgt.ref.card.color : 0xffffff);
        }
        if (audio) audio.play('pop');
      }
      if (onHit) onHit(tgt.ref, amount);
    }
  }

  function executeHit(t) {
    const tgt = t.attackTarget || t.target;
    if (!tgt) return;
    const charId = t.card ? t.card.id : '';
    const isRanged = charId === 'honey' || charId === 'goggles' || charId === 'lavender' || (t.stats && t.stats.range > 2.0 && charId !== 'armor');

    if (isRanged) {
      if (audio) audio.play('arrow');
      if (vfx && vfx.arrowProjectile) {
        vfx.arrowProjectile(t.x, 1.4, t.z, tgt, 16, () => {
          applyHit(t, tgt);
        });
      } else {
        applyHit(t, tgt);
      }
    } else {
      if (audio) {
        audio.play(charId === 'armor' ? 'thud' : 'slash');
      }
      if (vfx && vfx.meleeSlash) {
        const slashColor = charId === 'pip' ? 0x00f0ff : (charId === 'mist' ? 0xa259ff : 0xffffff);
        vfx.meleeSlash(t.x, 1.2, t.z, t.facing, slashColor);
      }
      applyHit(t, tgt);
    }
  }

  function strike(t) {
    t.swing = t.stats.hitEvery;
    t.lunge = 1;
    t.attackState = 'recovery';
    executeHit(t);
  }

  /**
   * Put a fighter on the field.
   * @param {object} card entry from CHARACTERS
   * @param {number} x
   * @param {number} z
   * @param {'player'|'enemy'} side
   * @returns {object|null} the troop, or null if the field is full
   */
  function spawn(card, x, z, side) {
    const stats = CARDS[card.id];
    if (!stats) return null;
    // A spell is priced and has a card, but it has no unit: its build() is
    // null and there is nothing to stand on the pitch. Getting here would put
    // a card with no model and no combat stats into the field, so it is
    // refused here and spells.js handles those ids.
    if (card.spell) return null;
    // A spawn inside the river would be a card the player paid for that then
    // stands in the water, so it is refused rather than quietly relocated.
    if (!passable(x, z)) return null;
    if (troops.filter((t) => !t.dead).length >= MAX_TROOPS) return null;

    const t = makeTroop(card, stats, x, z, side);
    troops.push(t);
    root.add(t.root);
    return t;
  }

  /**
   * Walk cycle. Legs and arms are swung only when the model actually has them -
   * several characters are built without limbs, and inventing a hidden joint
   * to animate would be a lie about a mesh that is not there.
   */
  function animate(t, dt) {
    if (t.attackState === 'windup') {
      const charId = t.card ? t.card.id : '';
      const isThrust = charId === 'pip' || charId === 'mrhat';
      const isRanged = charId === 'honey' || charId === 'goggles' || charId === 'lavender' || (t.stats && t.stats.range > 2.0 && charId !== 'armor');

      if (isRanged) {
        if (t.model.armR) {
          t.model.armR.rotation.x = 1.45;
          t.model.armR.position.z = -0.15;
        }
        if (t.model.armL) {
          t.model.armL.rotation.x = 1.25;
          t.model.armL.position.z = 0.08;
        }
      } else if (isThrust) {
        if (t.model.armR) {
          t.model.armR.rotation.x = -0.55;
          t.model.armR.position.z = -0.28;
        }
        if (t.model.armL) {
          t.model.armL.rotation.x = 0.35;
        }
      } else {
        if (t.model.armR) {
          t.model.armR.rotation.x = -1.15;
          t.model.armR.position.z = -0.2;
        }
        if (t.model.armL) {
          t.model.armL.rotation.x = 0.45;
        }
      }
      t.mesh.rotation.x = -0.12;
    } else if (t.lunge > 0) {
      // k moves from 0 (start of hit) to 1 (end of recovery)
      const k = 1 - t.lunge;
      const charId = t.card ? t.card.id : '';
      const isThrust = charId === 'pip' || charId === 'mrhat';
      const isRanged = charId === 'honey' || charId === 'goggles' || charId === 'lavender' || (t.stats && t.stats.range > 2.0 && charId !== 'armor');

      if (isThrust) {
        // Thrust animation: forward z translation with focused arm drive
        const thrust = Math.sin(k * Math.PI);
        if (t.model.armR) {
          t.model.armR.rotation.x = thrust * 0.75;
          t.model.armR.position.z = thrust * 0.42;
        }
        if (t.model.armL) {
          t.model.armL.rotation.x = -thrust * 0.35;
        }
        t.mesh.rotation.x = thrust * 0.16;
      } else if (isRanged) {
        // Aiming pose with recoil kickback
        const recoil = Math.sin(k * Math.PI);
        if (t.model.armR) {
          t.model.armR.rotation.x = 1.35 - recoil * 0.55;
          t.model.armR.position.z = -recoil * 0.18;
        }
        if (t.model.armL) {
          t.model.armL.rotation.x = 1.25 - recoil * 0.45;
          t.model.armL.position.z = -recoil * 0.15;
        }
        t.mesh.rotation.x = -recoil * 0.12;
      } else {
        // Slashing / punching swing
        const slashAngle = Math.sin(k * Math.PI) * 1.55;
        if (t.model.armR) {
          t.model.armR.rotation.x = slashAngle;
          t.model.armR.position.z = Math.sin(k * Math.PI) * 0.25;
        }
        if (t.model.armL) {
          t.model.armL.rotation.x = -slashAngle * 0.4;
        }
        t.mesh.rotation.x = Math.sin(k * Math.PI) * 0.22;
      }
    } else if (t.moving) {
      t.walk += dt * t.stats.speed * 3.4;
      const swing = Math.sin(t.walk) * 0.55;
      if (t.model.legL) t.model.legL.rotation.x = swing;
      if (t.model.legR) t.model.legR.rotation.x = -swing;
      if (t.model.armL) t.model.armL.rotation.x = -swing * 0.7;
      if (t.model.armR) {
        t.model.armR.rotation.x = swing * 0.7;
        t.model.armR.position.z = 0;
      }
      t.mesh.rotation.x = 0;
    } else {
      // Ease limbs and mesh back to neutral when not moving or lunging
      const ease = (g) => {
        if (g) {
          g.rotation.x *= Math.max(0, 1 - dt * 10);
          if (g.position) g.position.z *= Math.max(0, 1 - dt * 10);
        }
      };
      ease(t.model.legL); ease(t.model.legR);
      ease(t.model.armL); ease(t.model.armR);
      t.mesh.rotation.x *= Math.max(0, 1 - dt * 10);
    }

    t.root.position.set(t.x, 0, t.z);
    // Shortest-path turn, so a target switch does not spin the model the long
    // way round through 350 degrees.
    let d = t.facing - t.root.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    t.root.rotation.y += d * Math.min(1, dt * 12);

    // Spawn-in squash, and the attack recoil sliding the model forward.
    if (t.born < 1) {
      t.born = Math.min(1, t.born + dt * 4.5);
    }
    const pop = 0.55 + 0.45 * t.born;
    t.lunge = Math.max(0, t.lunge - dt * 3.8);
    if (t.lunge <= 0 && t.attackState === 'recovery') {
      t.attackState = 'idle';
    }
    t.mesh.scale.set(pop, pop, pop);
    t.mesh.position.z = t.lunge > 0 ? Math.sin((1 - t.lunge) * Math.PI) * 0.3 : 0;

    // HP bar. Hidden at full health so a field of fresh troops is not a field
    // of neon bars; the moment something is hurt, the bar appears.
    const ratio = Math.max(0, t.hp / t.maxHp);
    const showBar = ratio < 0.999;
    t.barHost.visible = showBar;
    if (showBar) {
      const band = Math.max(0, HP_BANDS.indexOf(hpColour(ratio)));
      for (let i = 0; i < t.bar.length; i++) {
        const f = t.bar[i];
        f.visible = i === band;
        if (!f.visible) continue;
        f.scale.x = ratio;
        // Keep the fill's left edge pinned as it shrinks, otherwise the bar
        // drains from the middle and reads as some other value than the one it
        // is showing.
        f.position.x = -(BAR_W * (1 - ratio)) / 2;
      }
    }
  }

  function update(dt) {
    for (let i = troops.length - 1; i >= 0; i--) {
      const t = troops[i];
      if (t.dead) {
        // Squash into the ground, then leave. Hard-edged like everything else.
        t.deathT -= dt;
        t.mesh.scale.set(1, Math.max(0.02, t.deathT / 0.26), 1);
        if (t.deathT <= 0) {
          root.remove(t.root);
          troops.splice(i, 1);
        }
        continue;
      }

      t.retarget -= dt;
      if (t.retarget <= 0) {
        t.target = pickTarget(t, troops, towers);
        t.retarget = RETARGET;
      }
      t.swing -= dt;
      t.moving = false;

      // Frozen units do not move and do not swing. They keep their target and
      // their retarget timer, so the instant the ice thaws they resume the
      // fight they were already in instead of standing confused.
      if (t.frozen > 0) {
        t.frozen = Math.max(0, t.frozen - dt);
        animate(t, dt);
        continue;
      }

      if (t.attackState === 'windup') {
        t.windupT -= dt;
        if (t.attackTarget && t.attackTarget.ref) {
          t.facing = Math.atan2(t.attackTarget.ref.x - t.x, t.attackTarget.ref.z - t.z);
        }
        if (t.windupT <= 0) {
          t.attackState = 'recovery';
          t.lunge = 1;
          executeHit(t);
        }
      } else {
        const tgt = t.target;
        if (tgt) {
          const dist = Math.hypot(tgt.ref.x - t.x, tgt.ref.z - t.z);
          // Towers get padding because they are buildings; a troop stops at the
          // wall, not at the coordinate in the middle of it.
          const reach = t.stats.range + (tgt.kind === 'tower' ? TOWER_PAD : 0);
          if (dist <= reach) {
            t.facing = Math.atan2(tgt.ref.x - t.x, tgt.ref.z - t.z);
            if (t.swing <= 0) {
              t.attackState = 'windup';
              t.windupT = 0.12;
              t.swing = t.stats.hitEvery;
              t.attackTarget = tgt;
            }
          } else {
            stepToward(t, tgt.ref.x, tgt.ref.z, dt);
          }
        }
      }

      animate(t, dt);
    }

    // Soft separation, applied after everyone has moved so the result does not
    // depend on iteration order. Friends only: enemies are meant to close.
    for (let i = 0; i < troops.length; i++) {
      const a = troops[i];
      if (a.dead) continue;
      for (let j = i + 1; j < troops.length; j++) {
        const b = troops[j];
        if (b.dead || b.side !== a.side) continue;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        if (d >= SEPARATION) continue;
        if (d < 1e-4) {
          if (passable(b.x + 0.05, b.z)) b.x += 0.05;
          continue;
        }
        const push = (SEPARATION - d) * 0.5;
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

  /**
   * Every living troop of one side within `radius` of a point.
   *
   * Shared by all three spells so the hit test is written once. A freeze that
   * used a different radius test than the fireball would be a bug that only
   * ever showed up in one of the two.
   *
   * @param {number} x
   * @param {number} z
   * @param {number} radius
   * @param {'player'|'enemy'} side
   * @returns {Array<object>}
   */
  function inRadius(x, z, radius, side) {
    const r2 = radius * radius;
    return troops.filter(
      (t) => !t.dead && t.side === side
        && (t.x - x) * (t.x - x) + (t.z - z) * (t.z - z) <= r2
    );
  }

  /**
   * Raw area damage, returning how many died.
   *
   * Uses the same death path as a melee hit (dead flag plus the squash timer)
   * rather than removing the troop outright, so a spell kill animates exactly
   * like a troop kill. Yanking the record here would skip that animation and
   * leave a hole in the very array the update loop is iterating.
   *
   * @param {number} x
   * @param {number} z
   * @param {number} radius
   * @param {number} amount
   * @param {'player'|'enemy'} side the side that gets hit
   * @returns {number} how many died
   */
  function blast(x, z, radius, amount, side) {
    const hits = inRadius(x, z, radius, side);
    let killed = 0;
    for (const t of hits) {
      if (t.dead) continue;
      t.hp -= amount;
      if (t.hp <= 0) {
        t.dead = true;
        t.deathT = 0.26;
        if (vfx && vfx.koPoof) {
          vfx.koPoof(t.x, t.z, t.card ? t.card.color : 0xffffff);
        }
        if (audio) audio.play('pop');
        killed++;
      }
      if (onHit) onHit(t, amount);
    }
    return killed;
  }

  /**
   * Freeze every enemy in an area.
   *
   * Durations do not stack: re-freezing refreshes to the longer of the two, so
   * two overlapping freezes cannot be chained into an indefinite stun.
   *
   * @param {number} x
   * @param {number} z
   * @param {number} radius
   * @param {number} duration
   * @param {'player'|'enemy'} side the side that gets frozen
   * @returns {number} how many were caught
   */
  function freezeArea(x, z, radius, duration, side) {
    const hits = inRadius(x, z, radius, side);
    for (const t of hits) {
      if (t.dead) continue;
      t.frozen = Math.max(t.frozen, duration);
    }
    return hits.length;
  }

  /**
   * Empty the field for a rematch.
   *
   * Drops the records and scene objects outright rather than waiting out the
   * death animation, because a rematch should not spend its first two seconds
   * clearing the previous match's corpses.
   *
   * The health-bar fills own their materials (buildBar makes one per band), so
   * those are disposed here. The voxel models are shared and cached by
   * voxel.js, so they must NOT be - disposing one would break every other unit
   * on the board.
   */
  function clear() {
    for (const t of troops) {
      t.dead = true;
      root.remove(t.root);
      for (const fill of t.bar) {
        if (fill.material && fill.material.userData?.shared !== true && fill.material.dispose) {
          fill.material.dispose();
        }
      }
    }
    troops.length = 0;
  }

  return {
    root,
    troops,
    spawn,
    update,
    clear,
    blast,
    freezeArea,
    inRadius,
    MAX_TROOPS,
  };
}