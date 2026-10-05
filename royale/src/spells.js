// -- spells.js -------------------------------------------------------------
// Resolves a cast: which things are in the area, what happens to them, and
// what the screen shows while it happens.
//
// Spells are the one place a single effect spans three different kinds of
// object - troops, towers, and the ground itself. That is why this is its own
// module rather than three branches inside troops.js: troops.js owns troops,
// towers.js owns towers, and the code that has to talk to both lives here and
// receives both as plain arrays.
//
// Note what is NOT here: a damage number is raised through the same hit
// listener the melee code uses, but a spell does not decide whether it hit.
// The caller has already validated legality and paid the elixir.

import { SPELLS } from './config.js';
import { damageTower } from './towers.js';

/**
 * @typedef {object} SpellResult
 * @property {'blast'|'freeze'|'heal'} kind
 * @property {number} x centre of the area
 * @property {number} z
 * @property {number} radius
 * @property {number} hits how many troops were affected
 * @property {number} kills troops that died to it
 * @property {number} towersHit towers that took damage
 * @property {number} restored HP healed, for the result screen
 */

/**
 * Build the spell resolver.
 *
 * Dependencies are injected rather than imported: the vfx layer owns a scene
 * graph and a per-frame list, and importing it here would mean importing a
 * second copy of THREE into a module that otherwise has no rendering in it at
 * all. The troops layer is injected for the same reason - main.js owns the one
 * instance, and a module-level import would be a second field.
 *
 * @param {object} deps
 * @param {Array<object>} deps.towers live tower records
 * @param {ReturnType<import('./troops.js').buildTroops>} deps.troops
 * @param {{spellBlast: Function, spellRing: Function}} deps.vfx
 * @param {(kind: string, x: number, z: number) => void} [deps.onCast]
 *   raised once per successful cast, for audio and haptics
 * @param {(target: object, amount: number) => void} [deps.onHit]
 *   the existing damage-number listener, shared with melee
 */
export function buildSpells({ towers, troops, vfx, onCast = null, onHit = null, onImpact = null }) {
  /**
   * Every enemy tower inside the area.
   * @param {number} x
   * @param {number} z
   * @param {number} radius
   * @param {'player'|'enemy'} [targetSide]
   * @returns {Array<object>}
   */
  function towersInRadius(x, z, radius, targetSide) {
    const r2 = radius * radius;
    return towers.filter(
      (w) => !w.destroyed
        && (!targetSide || w.side === targetSide)
        && (w.x - x) * (w.x - x) + (w.z - z) * (w.z - z) <= r2
    );
  }

  /**
   * Cast a spell at a point.
   *
   * `side` is the caster, so every effect lands on the OTHER side's units. That
   * is the single most important line in this file and it is stated once here
   * rather than threaded through each branch: a fireball that hits its own
   * troops is the kind of bug that looks like a balance complaint.
   *
   * @param {string} id key into SPELLS, i.e. a card's `spell` field
   * @param {number} x
   * @param {number} z
   * @param {'player'|'enemy'} side the caster
   * @returns {SpellResult|null} null if the id is not a known spell
   */
  function cast(id, x, z, side) {
    const def = SPELLS[id];
    if (!def) return null;
    const foe = side === 'player' ? 'enemy' : 'player';

    /** @type {SpellResult} */
    const result = {
      kind: def.kind, x, z, radius: def.radius, hits: 0, kills: 0, towersHit: 0, restored: 0,
    };

    function applyImpact() {
      if (def.kind === 'blast') {
        // Troops first, then towers. A tower that dies to the same fireball goes
        // through damageTower, so the shatter sequence and the KO screen run
        // exactly as they would for a troop finishing it.
        result.kills = troops.blast(x, z, def.radius, def.amount, foe);
        result.hits = troops.inRadius(x, z, def.radius, foe).length;
        const hitTowers = towersInRadius(x, z, def.radius, foe);
        for (const w of hitTowers) {
          if (damageTower(w, def.amount)) result.towersHit++;
          if (onHit) onHit(w, def.amount);
        }
        if (vfx && vfx.spellBlast) vfx.spellBlast(x, z, def.color, def.radius);
        if (onImpact) onImpact('blast', x, z, side);
      }

      if (def.kind === 'freeze') {
        result.hits = troops.freezeArea(x, z, def.radius, def.duration, foe);
        // Towers are structures, not units: freezing one is meaningless, and
        // pretending otherwise would be a second hit test for no player-visible
        // effect. The ring still draws so the player can see exactly how much of
        // the push the ice actually caught.
        if (vfx && vfx.spellRing) vfx.spellRing(x, z, def.color, def.radius);
        if (onImpact) onImpact('freeze', x, z, side);
      }

      if (def.kind === 'heal') {
        // `amount` is a FRACTION of a unit's own max HP, not a flat number, so
        // the spell scales with whatever it lands on: a 400 HP trooper and a
        // 2000 HP tank are both meaningfully repaired instead of one being
        // ignored. It has to be applied per unit here rather than summed and
        // passed to healArea - summing first would heal the tank for the
        // trooper's size, which is a different and wrong number.
        let restored = 0;
        let caught = 0;
        for (const t of troops.inRadius(x, z, def.radius, side)) {
          const before = t.hp;
          t.hp = Math.min(t.maxHp, t.hp + t.maxHp * def.amount);
          restored += t.hp - before;
          caught++;
        }
        result.restored = restored;
        result.hits = caught;
        if (vfx && vfx.spellRing) vfx.spellRing(x, z, def.color, def.radius);
        if (onImpact) onImpact('heal', x, z, side);
      }
    }

    if (vfx && typeof vfx.spellProjectile === 'function') {
      const king = towers ? towers.find((t) => t.side === side && t.kind === 'king') : null;
      const sx = king ? king.x : (side === 'player' ? 0 : 0);
      const sy = king ? 4.5 : 2.5;
      const sz = king ? king.z : (side === 'player' ? 12 : -12);
      vfx.spellProjectile(sx, sy, sz, x, z, def.color, 0.45, applyImpact);
    } else {
      applyImpact();
    }

    if (onCast) onCast(def.kind, x, z);
    return result;
  }

  return { cast };
}