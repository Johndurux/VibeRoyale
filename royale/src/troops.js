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

/**
 * Water, and only water, is unwalkable. The inset keeps troops off the bank
 * rather than letting them stand with their feet in the river.
 * @param {number} x
 * @param {number} z
 * @returns {boolean}
 */
export function passable(x, z) {
  return !(Math.abs(x) < RIVER.halfW - 0.35 && Math.abs(z) < RIVER.halfL + 0.35);
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
    target: null,
    walk: 0,         // walk-cycle phase
    facing: side === 'player' ? Math.PI : 0,
    moving: false,
    lunge: 0,        // attack recoil, decays to 0
    born: 0,         // spawn-in progress, 0..1
    dead: false,
    deathT: 0,
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
  let best = null;
  let bestD = AGGRO * AGGRO;
  for (const o of troops) {
    if (o.side === t.side || o.dead) continue;
    const d = (o.x - t.x) * (o.x - t.x) + (o.z - t.z) * (o.z - t.z);
    if (d < bestD) { bestD = d; best = { kind: 'troop', ref: o }; }
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
  let nx = t.x + (dx / d) * s;
  let nz = t.z + (dz / d) * s;

  if (!passable(nx, nz)) {
    // Aim at the bridge: straight in x, and the far bank in z.
    const bz = Math.sign(dz || 1) * (RIVER.halfL + 0.8);
    const bdx = -t.x;
    const bdz = bz - t.z;
    const bd = Math.hypot(bdx, bdz) || 1;
    nx = t.x + (bdx / bd) * s;
    nz = t.z + (bdz / bd) * s;
  }

  // Keep everyone on the pitch. Without this a troop whose target is gone
  // walks off the grass and into the crowd stands.
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
export function buildTroops({ towers, onHit = null }) {
  const root = new THREE.Group();
  const troops = [];

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
   // several characters are built without limbs, and inventing a hidden joint
   * to animate would be a lie about a mesh that is not there.
 */
  function animate(t, dt) {
    if (t.moving) {
      t.walk += dt * t.stats.speed * 3.4;
      const swing = Math.sin(t.walk) * 0.55;
      if (t.model.legL) t.model.legL.rotation.x = swing;
      if (t.model.legR) t.model.legR.rotation.x = -swing;
      if (t.model.armL) t.model.armL.rotation.x = -swing * 0.7;
      if (t.model.armR) t.model.armR.rotation.x = swing * 0.7;
    } else {
      // Ease the legs back to neutral rather than freezing mid-stride.
      const ease = (g) => { if (g) g.rotation.x *= Math.max(0, 1 - dt * 9); };
      ease(t.model.legL); ease(t.model.legR);
      ease(t.model.armL); ease(t.model.armR);
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
    t.lunge = Math.max(0, t.lunge - dt * 5.5);
    t.mesh.scale.set(pop, pop, pop);
    t.mesh.position.z = Math.sin(t.lunge * Math.PI) * 0.3;

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

      const tgt = t.target;
      if (tgt) {
        const dist = Math.hypot(tgt.ref.x - t.x, tgt.ref.z - t.z);
        // Towers get padding because they are buildings; a troop stops at the
        // wall, not at the coordinate in the middle of it.
        const reach = t.stats.range + (tgt.kind === 'tower' ? TOWER_PAD : 0);
        if (dist <= reach) {
          t.facing = Math.atan2(tgt.ref.x - t.x, tgt.ref.z - t.z);
          if (t.swing <= 0) strike(t, onHit);
        } else {
          stepToward(t, tgt.ref.x, tgt.ref.z, dt);
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
        if (d < 1e-4) { b.x += 0.05; continue; }
        const push = (SEPARATION - d) * 0.5;
        const ux = dx / d;
        const uz = dz / d;
        a.x -= ux * push; a.z -= uz * push;
        b.x += ux * push; b.z += uz * push;
      }
    }
  }

  return { root, troops, spawn, update, MAX_TROOPS };
}