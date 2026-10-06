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

// Enemies keep a tighter body radius. Closing to fighting distance is not the
// same as occupying the same tile - without this, two head-on fighters on a
// narrow bridge interpenetrate and read as one model with two health bars.
// Kept below every melee reach in CARDS (1.3 smallest), so a pair at this
// radius is still inside its own swing and the fight never stalls.
const ENEMY_SEPARATION = 1.0;

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

// ── weapon archetypes ─────────────────────────────────────────────────────
// Cards declare `weapon` ('sword' | 'spear' | 'spearshield' | 'bow') and both
// the strike animation and the hit effect follow that declaration, rather than
// a per-character id list drifting out of sync with the models.
const WINDUP = {
  sword: 0.14,
  spear: 0.1,
  spearshield: 0.14,
  bow: 0.2, // drawing a string reads slower than cocking an arm
};

function weaponOf(t) {
  if (t.card && t.card.weapon) return t.card.weapon;
  // Defence in depth for a card that predates the field: a long-range unit
  // without a declared weapon shoots, everything else swings.
  return t.stats && t.stats.range > 2 ? 'bow' : 'sword';
}

// Re-aim interval. Recomputing the target every frame makes a troop oscillate
// between two equidistant enemies; a third of a second is often enough to feel
// instant and slow enough to stay committed.
const RETARGET = 0.3;

const BRIDGE_HALF_W = 1.95; // Walkable deck inside bridge railings
const FENCE_OUTER_X = 2.35; // Outer boundary of railings & posts
const FENCE_SPAN_Z = 5.8;   // Length of bridge railing
const RIVER_HALF_W = RIVER.halfW; // 2.9
const RIVER_HALF_L = RIVER.halfL; // 5.2

// The deck inside the railings is walkable out to BRIDGE_HALF_W, but a chibi
// body is ~1 unit wide - a fighter centred at the legal edge puts half the
// model on the railing and reads as standing ON the fence. While a unit is
// within the bridge span its centre is held this far inside the deck, so
// separation shoves can slide units to the planks' edge without ever letting
// them stand on the posts.
const BRIDGE_CORRIDOR = BRIDGE_HALF_W - 0.55;

/** Hold a unit's centre on the planks while it is within the bridge span.
 *  Only units already at/near the deck are pulled in - a fighter standing on
 *  the grass bank beside the river (a left-lane deploy at x -6.2) must never
 *  be yanked toward the centre just because it is inside the span's z band. */
function clampToBridge(t) {
  if (Math.abs(t.z) <= FENCE_SPAN_Z && Math.abs(t.x) <= BRIDGE_HALF_W) {
    t.x = Math.max(-BRIDGE_CORRIDOR, Math.min(BRIDGE_CORRIDOR, t.x));
  }
}

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
    windupMax: WINDUP.sword,
    poseFrom: null,  // limb pose captured when a windup starts, so the
                     // anticipation blends from wherever the body actually is
    breath: 0,       // idle bob phase
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
  clampToBridge(t);
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

  // Stage scaling for the rival's fighters, set by main.js at match start.
  // Only the enemy side is ever scaled - the multipliers are a difficulty
  // system, and a difficulty system must not be able to weaken the player.
  let enemyMods = null;

  /**
   * Apply per-stage stat multipliers to units spawned on the enemy side.
   * @param {{hp?: number, dps?: number}|null} mods multipliers, 1 = none
   */
  function setEnemyMods(mods) {
    enemyMods = mods && (mods.hp || mods.dps)
      ? { hp: mods.hp || 1, dps: mods.dps || 1 }
      : null;
  }

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
    const weapon = weaponOf(t);

    if (weapon === 'bow') {
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
        audio.play(weapon === 'spearshield' ? 'thud' : 'slash');
      }
      if (vfx && vfx.meleeSlash) {
        const slashColor = weapon === 'spear' ? 0xbef2ff : (weapon === 'spearshield' ? 0xffd772 : 0xffffff);
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

    // Stage scaling lands here: the enemy's copy of the card stats is scaled
    // once at spawn, so every downstream reader (combat, health bar, HUD) sees
    // one consistent fighter. The player's units always read the raw table.
    let effective = stats;
    if (side === 'enemy' && enemyMods && (enemyMods.hp !== 1 || enemyMods.dps !== 1)) {
      effective = {
        ...stats,
        hp: Math.max(1, Math.round(stats.hp * enemyMods.hp)),
        dps: stats.dps * enemyMods.dps,
      };
    }

    const t = makeTroop(card, effective, x, z, side);
    troops.push(t);
    root.add(t.root);
    return t;
  }

  /**
   * Combat stance the legs settle into while a fighter is locked on a target:
   * front foot toward the enemy, rear foot braced. Eased rather than set, so
   * the legs glide out of a mid-stride walk pose instead of freezing in one -
   * that frozen stride was the biggest single source of stiffness. Walking
   * overwrites the legs outright on the next frame, and the idle ease relaxes
   * the stance once the fight moves on.
   */
  const STANCE = { legL: -0.22, legR: 0.14 };
  function stance(t, dt) {
    const s = Math.min(1, dt * 10);
    if (t.model.legL) t.model.legL.rotation.x += (STANCE.legL - t.model.legL.rotation.x) * s;
    if (t.model.legR) t.model.legR.rotation.x += (STANCE.legR - t.model.legR.rotation.x) * s;
  }

  /**
   * Ease an arm's sideways angle back to its chibi rest pose. Rest values live
   * on the model (userData.restZ), so troops.js never re-hardcodes the layout.
   */
  function armZ(g, target, dt) {
    if (!g) return;
    const rest = g.userData.restZ || 0;
    g.rotation.z += ((rest + target) - g.rotation.z) * Math.min(1, dt * 8);
  }

  /** Head helpers: the chibi head is ~40% of the silhouette, so a frozen
   * head reads as a frozen fighter. bob/sway while walking, tilt into combat,
   * ease back to the layout rest pose when nothing is happening. */
  function headPose(t, { bob = 0, sway = 0, pitch = 0 } = {}, dt) {
    const head = t.model.head;
    if (!head) return;
    const s = Math.min(1, dt * 8);
    head.position.y = (head.userData.baseY || 0) + bob;
    head.rotation.z += (sway - head.rotation.z) * s;
    head.rotation.x += (pitch - head.rotation.x) * s;
  }

  /**
   * Walk, windup, strike and idle motion.
   *
   * The strike poses are per weapon archetype (the card's `weapon` field), not
   * per character id - the animation follows what the fighter visibly holds.
   * Every windup BLENDS from the pose the body was actually in when the windup
   * started (poseFrom), which is what unstiffened the old version: a pose that
   * teleports on frame one and freezes for its duration reads as robotic, and
   * the worst offender was legs frozen mid-stride for a whole fight. The legs
   * now settle into a combat stance while locked on (see stance()), the torso
   * leans with each phase, and a standing fighter breathes.
   */
  function animate(t, dt) {
    const weapon = weaponOf(t);
    if (t.attackState === 'windup') {
      const w = t.windupMax > 0 ? Math.min(1, Math.max(0, 1 - t.windupT / t.windupMax)) : 1;
      const e = 1 - Math.pow(1 - w, 2); // ease-out into the anticipation pose
      const from = t.poseFrom || { armRx: 0, armRz: 0, armLx: 0, meshRx: 0 };
      const mix = (fromV, toV) => fromV + (toV - fromV) * e;

      if (weapon === 'bow') {
        // Bow arm levels at the target while the draw hand pulls back to the cheek.
        if (t.model.armL) {
          t.model.armL.rotation.x = mix(from.armLx, -1.5);
          t.model.armL.position.z = mix(0, 0.1);
        }
        if (t.model.armR) {
          t.model.armR.rotation.x = mix(from.armRx, 0.9);
          t.model.armR.position.z = mix(from.armRz, -0.35);
        }
        t.mesh.rotation.x = mix(from.meshRx, -0.06);
      } else if (weapon === 'spear' || weapon === 'spearshield') {
        // Cock the spear back over the shoulder; a shield arm plants forward.
        if (t.model.armR) {
          t.model.armR.rotation.x = mix(from.armRx, 0.55);
          t.model.armR.position.z = mix(from.armRz, -0.3);
        }
        if (t.model.armL) t.model.armL.rotation.x = mix(from.armLx, weapon === 'spearshield' ? -0.55 : 0.25);
        t.mesh.rotation.x = mix(from.meshRx, -0.1);
      } else { // sword
        // Raise the blade up and behind the head, torso coiling back.
        if (t.model.armR) {
          t.model.armR.rotation.x = mix(from.armRx, 2.4);
          t.model.armR.position.z = mix(from.armRz, -0.12);
        }
        if (t.model.armL) t.model.armL.rotation.x = mix(from.armLx, -0.3);
        t.mesh.rotation.x = mix(from.meshRx, -0.14);
      }
      stance(t, dt);
      armZ(t.model.armL, 0, dt);
      armZ(t.model.armR, 0, dt);
      headPose(t, { pitch: -0.07 }, dt); // eyes narrow up at the raised weapon
      t.mesh.position.y = 0;
    } else if (t.lunge > 0) {
      // k moves from 0 (hit lands) to 1 (recovery done). Each weapon gets its
      // own release curve: an ease-out so the strike snaps through the target
      // early and settles, instead of one sine that moves the same speed all
      // the way through.
      const k = 1 - t.lunge;
      const settle = Math.sin(k * Math.PI);

      if (weapon === 'bow') {
        const release = 1 - Math.pow(1 - k, 3);
        if (t.model.armR) {
          t.model.armR.rotation.x = 0.9 - 2.0 * release;
          t.model.armR.position.z = -0.35 + 0.5 * release;
        }
        if (t.model.armL) {
          t.model.armL.rotation.x = -1.5 + 0.4 * settle;
          t.model.armL.position.z = 0.1 - 0.12 * settle;
        }
        t.mesh.rotation.x = -0.1 * settle;
      } else if (weapon === 'spear' || weapon === 'spearshield') {
        const thrust = 1 - Math.pow(1 - k, 2);
        if (t.model.armR) {
          t.model.armR.rotation.x = 0.55 - 1.5 * thrust;
          t.model.armR.position.z = -0.3 + 0.85 * thrust;
        }
        if (t.model.armL) t.model.armL.rotation.x = weapon === 'spearshield' ? -0.55 + 0.15 * thrust : 0.25 - 0.55 * thrust;
        t.mesh.rotation.x = 0.2 * settle;
      } else { // sword
        const swing = 1 - Math.pow(1 - k, 2);
        if (t.model.armR) {
          t.model.armR.rotation.x = 2.4 - 3.7 * swing;
          t.model.armR.position.z = -0.12 + 0.32 * swing;
        }
        if (t.model.armL) t.model.armL.rotation.x = -0.3 + 0.3 * swing;
        t.mesh.rotation.x = 0.26 * settle;
      }
      stance(t, dt);
      armZ(t.model.armL, 0, dt);
      armZ(t.model.armR, 0, dt);
      headPose(t, { pitch: 0.06 }, dt); // head dips into the strike
      t.mesh.position.y = 0;
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
      // Arms flare out from the body as they swing - a chibi with limbs glued
      // to the torso slides; one with volume bounces.
      armZ(t.model.armL, Math.abs(swing) * 0.1, dt);
      armZ(t.model.armR, -Math.abs(swing) * 0.1, dt);
      // Two hops per stride cycle, synced to the legs, plus a slight forward
      // lean. Short chibi legs at this frequency without bounce read as
      // skating across the grass.
      t.mesh.position.y = Math.abs(Math.sin(t.walk)) * 0.09;
      t.mesh.rotation.x = 0.07;
      headPose(t, { bob: Math.sin(t.walk * 2) * 0.035, sway: Math.sin(t.walk) * 0.05, pitch: 0.03 }, dt);
    } else {
      // Ease limbs and mesh back to neutral when not moving or lunging, then
      // breathe: a slow chest bob plus a faint arm sway, so a fighter holding
      // a lane reads as alive rather than as a paused animation.
      const ease = (g) => {
        if (g) {
          g.rotation.x *= Math.max(0, 1 - dt * 10);
          if (g.position) g.position.z *= Math.max(0, 1 - dt * 10);
        }
      };
      ease(t.model.legL); ease(t.model.legR);
      ease(t.model.armL); ease(t.model.armR);
      armZ(t.model.armL, 0, dt);
      armZ(t.model.armR, 0, dt);
      t.mesh.rotation.x *= Math.max(0, 1 - dt * 10);

      t.breath += dt * 2.4;
      t.mesh.position.y = Math.sin(t.breath) * 0.035;
      if (t.model.armL) t.model.armL.rotation.x += Math.sin(t.breath) * 0.04;
      if (t.model.armR) t.model.armR.rotation.x += Math.sin(t.breath * 0.9) * 0.04;
      headPose(t, { bob: Math.sin(t.breath) * 0.012 }, dt);
    }

    t.root.position.set(t.x, 0, t.z);
    // Shortest-path turn, so a target switch does not spin the model the long
    // way round through 350 degrees.
    let d = t.facing - t.root.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    t.root.rotation.y += d * Math.min(1, dt * 12);
    // Bank into the turn: tilt proportional to how hard the body is currently
    // rotating, eased. A chibi that pivots bolt-upright reads as a figurine on
    // a turntable; a small roll makes the turn a movement.
    const bankTarget = THREE.MathUtils.clamp(-d * 0.55, -0.14, 0.14);
    t.mesh.rotation.z += (bankTarget - t.mesh.rotation.z) * Math.min(1, dt * 8);

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
              const weapon = weaponOf(t);
              t.windupMax = WINDUP[weapon] || 0.12;
              t.windupT = t.windupMax;
              // Capture where the limbs are right now so the windup blends
              // from the actual body pose instead of snapping from neutral.
              t.poseFrom = {
                armRx: t.model.armR ? t.model.armR.rotation.x : 0,
                armRz: t.model.armR ? t.model.armR.position.z : 0,
                armLx: t.model.armL ? t.model.armL.rotation.x : 0,
                meshRx: t.mesh.rotation.x,
              };
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
    // depend on iteration order. Friends hold a wide formation; enemies hold a
    // tighter one - close enough to fight, never close enough to share a tile.
    for (let i = 0; i < troops.length; i++) {
      const a = troops[i];
      if (a.dead) continue;
      for (let j = i + 1; j < troops.length; j++) {
        const b = troops[j];
        if (b.dead) continue;
        const friends = b.side === a.side;
        const min = friends ? SEPARATION : ENEMY_SEPARATION;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        if (d >= min) continue;
        if (d < 1e-4) {
          if (passable(b.x + 0.05, b.z)) b.x += 0.05;
          continue;
        }
        const push = (min - d) * 0.5;
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
    // Separation can slide a fighter to the deck's legal edge, where the
    // railing starts; the corridor clamp pulls the body back onto the planks.
    for (const t of troops) {
      if (!t.dead) clampToBridge(t);
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
    setEnemyMods,
    MAX_TROOPS,
  };
}