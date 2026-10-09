// ── characters.js ────────────────────────────────────────────────────────
// The character roster. Each entry is data plus a `build()` that returns the
// voxel mesh, so adding a character never touches game logic.
//
// The bodies come from chibi.js — the VibeOffice chibi port (blocky
// proportions, dark silhouette outline, glowing square eyes) — and each build
// arms its fighter from the shared weapon library below. The whole roster
// fights with one of four weapon archetypes (sword / spear / spear+shield /
// bow), declared in `weapon`, and troops.js animates off that field rather
// than off character ids — so the animation a card gets follows the weapon it
// visibly carries, and a new card with a known weapon animates for free.

import { buildChibi } from './chibi.js';
import { vox } from './voxel.js';

// ── weapon library ───────────────────────────────────────────────────────
// All grips sit at the same local height on an arm pivot (the glove), so a
// weapon can move between characters without retuning its geometry.

/**
 * Straight sword: grip, crossguard, blade with a lighter core edge.
 */
function sword({ grip = 0x1c1a1b, guard = 0xe9c64a, blade = 0xefe9dc, edge = 0xffffff } = {}) {
  return [
    vox(0.09, 0.28, 0.09, grip, { y: -0.44, z: 0.14 }),
    vox(0.28, 0.07, 0.22, guard, { y: -0.29, z: 0.16 }),
    vox(0.09, 0.86, 0.17, blade, { y: 0.16, z: 0.17 }),
    vox(0.04, 0.8, 0.05, edge, { y: 0.16, z: 0.27 }),
    vox(0.06, 0.14, 0.12, edge, { y: 0.64, z: 0.17 }),
  ];
}

/**
 * Spear: long shaft, ring collar, leaf blade.
 */
function spear({ shaft = 0x8a5d3b, collar = 0xe9c64a, blade = 0xefe9dc, tip = 0xffffff } = {}) {
  return [
    vox(0.08, 1.32, 0.08, shaft, { y: -0.08, z: 0.16 }),
    vox(0.19, 0.08, 0.19, collar, { y: 0.52, z: 0.16 }),
    vox(0.1, 0.38, 0.18, blade, { y: 0.74, z: 0.16 }),
    vox(0.06, 0.14, 0.1, tip, { y: 0.98, z: 0.16 }),
  ];
}

/**
 * Round-plate shield, strapped to the forearm. Returned separately because it
 * rides armL while the spear rides armR.
 */
function shield({ plate = 0xe9c64a, rim = 0x1c1a1b, boss = 0xefe9dc } = {}) {
  return [
    vox(0.16, 0.6, 0.5, plate, { y: -0.3, z: 0.16 }),
    vox(0.18, 0.64, 0.08, rim, { y: -0.3, z: 0.42 }),
    vox(0.08, 0.08, 0.08, boss, { y: -0.3, z: 0.46 }),
  ];
}

/**
 * Bow: limbs, string and a nocked arrow. Held in armL; the draw hand (armR)
 * is posed by the animation, not the model.
 */
function bow({ limb = 0xf0d44d, string = 0xefe9dc, arrow = 0x3fd7ea, arrowhead = 0x141112 } = {}) {
  return [
    vox(0.08, 0.24, 0.12, 0x2b1e22, { y: -0.42, z: 0.24 }),
    vox(0.08, 0.46, 0.1, limb, { y: -0.16, z: 0.28 }),
    vox(0.08, 0.46, 0.1, limb, { y: -0.68, z: 0.28 }),
    vox(0.03, 0.9, 0.03, string, { y: -0.42, z: 0.18 }),
    vox(0.05, 0.05, 0.6, arrow, { y: -0.42, z: 0.36 }),
    vox(0.12, 0.12, 0.14, arrowhead, { y: -0.42, z: 0.68 }),
  ];
}

const TROOP_CARDS = [
  {
    id: 'armor',
    name: 'ARMOR',
    role: 'Gold Sentinel · Shield & Spear',
    color: '#c7a458',
    rarity: 'legendary',
    weapon: 'spearshield',
  // A siege piece walks past the scuffle and hits the building. It is the
  // counter to a stacked push, and useless as an answer to one troop.
  targetPriority: 'buildings',
    avatarChar: 'A',
    unlocked: true,
    build: () => {
      const g = buildChibi('armor');
      g.armR.add(...spear({ shaft: 0x1c1a1b, collar: 0xffc94a, blade: 0xffc94a, tip: 0xefe9dc }));
      g.armL.add(...shield({ plate: 0xffc94a, rim: 0x1c1a1b, boss: 0xefe9dc }));
      return g;
    }
  },
  {
    id: 'mist',
    name: 'MIST',
    role: 'Tosca Ghost · Spectral Spear',
    color: '#62f2cc',
    rarity: 'epic',
    weapon: 'spear',
  // Glass cannon: finishes whatever is weakest, so it deletes a 2-cost scout
  // instead of trading into the tank that was placed to hold the lane.
  targetPriority: 'lowestHP',
    avatarChar: 'M',
    unlocked: true,
    build: () => {
      const g = buildChibi('mist');
      g.armR.add(...spear({ shaft: 0x3aa88e, collar: 0x125f4b, blade: 0x3fe0c5, tip: 0xd8fffa }));
      return g;
    }
  },
  {
    id: 'pip',
    name: 'PIP',
    role: 'Pink Chibi · Pike',
    color: '#f2a7bc',
    rarity: 'common',
    weapon: 'spear',
  // Cheap and quick, so it just takes what is in front of it.
  targetPriority: 'nearest',
    avatarChar: 'P',
    unlocked: true,
    build: () => {
      const g = buildChibi('pip');
      g.armR.add(...spear({ shaft: 0x8a5d3b, collar: 0xe8607f, blade: 0xefe9dc, tip: 0xffffff }));
      return g;
    }
  },
  {
    id: 'honey',
    name: 'HONEY',
    role: 'Yellow Panda · Longbow',
    color: '#f0d44d',
    rarity: 'rare',
    weapon: 'bow',
  // Long range and outranges most answers; the plain default is right.
  targetPriority: 'nearest',
    avatarChar: 'H',
    unlocked: true,
    build: () => {
      const g = buildChibi('honey');
      g.armL.add(...bow({}));
      return g;
    }
  },
  {
    id: 'goggles',
    name: 'GOGGLES',
    role: 'Neon Visor · Brass Sword',
    color: '#6a4a2c',
    rarity: 'rare',
    weapon: 'sword',
  // Same reasoning as HONEY, and the same reason neither needs a special rule.
  targetPriority: 'nearest',
    avatarChar: 'G',
    unlocked: true,
    build: () => {
      const g = buildChibi('goggles');
      g.armR.add(...sword({ grip: 0x5a3a22, guard: 0xd89535, blade: 0xd89535, edge: 0xf5e2b8 }));
      return g;
    }
  },
  {
    id: 'captain',
    name: 'CAPTAIN',
    role: 'Horned Traveler · Officer Sword',
    color: '#2a74bd',
    rarity: 'epic',
    weapon: 'sword',
  // The answer to a tank: match the threat's durability rather than its
  // health bar, so it stays in the fight long enough to matter.
  targetPriority: 'nearest',
    avatarChar: 'C',
    unlocked: true,
    build: () => {
      const g = buildChibi('captain');
      g.armR.add(...sword({ guard: 0xe9c64a, blade: 0xefe9dc, edge: 0xffffff }));
      return g;
    }
  },
  {
    id: 'lavender',
    name: 'LAVENDER',
    role: 'Lavender Bunny · Hunter Bow',
    color: '#b08be0',
    rarity: 'rare',
    weapon: 'bow',
  // A back-line support unit that should be picking off stragglers, not
  // walking into the middle of a push.
  targetPriority: 'lowestHP',
    avatarChar: 'L',
    unlocked: true,
    build: () => {
      const g = buildChibi('lavender');
      g.armL.add(...bow({ limb: 0x9a70d6, arrow: 0xffd772, arrowhead: 0x6d4fa0 }));
      return g;
    }
  },
  {
    id: 'tux',
    name: 'TUX',
    role: 'Dark Purple · Cyan Edge Sword',
    color: '#5b36a0',
    rarity: 'common',
    weapon: 'sword',
  // Straightforward brawler.
  targetPriority: 'nearest',
    avatarChar: 'T',
    unlocked: true,
    build: () => {
      const g = buildChibi('tux');
      g.armR.add(...sword({ guard: 0x3fe2ec, blade: 0xefe9dc, edge: 0x3fe2ec }));
      return g;
    }
  },
  {
    id: 'mrhat',
    name: 'MR. HAT',
    role: 'Tan Explorer · Duelist Sword',
    color: '#b89c5e',
    rarity: 'common',
    weapon: 'sword',
  // Straightforward brawler.
  targetPriority: 'nearest',
    avatarChar: 'M',
    unlocked: true,
    build: () => {
      const g = buildChibi('mrhat');
      g.armR.add(...sword({ grip: 0x2fb58f, guard: 0xffd772, blade: 0xefe9dc, edge: 0xffffff }));
      return g;
    }
  }
];

// ── spells ────────────────────────────────────────────────────────────────
// Spells live in the same roster as troops on purpose: the lobby picker, the
// HUD hand and the unlock ladder all walk one array, and a second array of
// spells would mean a second code path through all three for no gain.
//
// What makes them different is `spell` (which SPELLS entry they resolve
// through) and the absence of a real `build()`. A spell has no unit to
// construct, so build() returns null and every consumer that would have put
// a mesh on the card face checks for a spell first and draws a glyph instead.
// `targetPriority` is meaningless here and is deliberately absent rather than
// set to a default, so nothing can mistake a fireball for a melee unit.
export const SPELL_CARDS = [
  {
    id: 'fireball',
    name: 'FIREBALL',
    role: 'Spell · Area Damage',
    rarity: 'rare',
    unlocked: true,
    spell: 'fireball',
    // The ring that blooms where it lands. Sized generously because the blast
    // radius is what the player is actually judging, and a VFX smaller than
    // the effect would make a 4-cost feel like it did less than it did.
    build() { return null; },
  },
  {
    id: 'freeze',
    name: 'FREEZE',
    role: 'Spell · Stuns Enemies',
    rarity: 'epic',
    unlocked: true,
    spell: 'freeze',
    build() { return null; },
  },
  {
    id: 'heal',
    name: 'HEAL',
    role: 'Spell · Repairs Allies',
    rarity: 'rare',
    unlocked: true,
    spell: 'heal',
    build() { return null; },
  },
];

/**
 * The full roster, troops and spells together.
 *
 * Deliberately one array rather than two. The lobby picker, the HUD hand, the
 * bot's legal hand and progression's unlock ladder all iterate a roster, and
 * every one of those would otherwise need a second pass, a second filter and a
 * second "is this a spell" check. One array means a spell is a first-class card
 * everywhere a troop is, and the only thing that distinguishes them is the
 * `spell` field - which is what the consumers actually branch on.
 *
 * @type {Array<object>}
 */
export const CHARACTERS = [...TROOP_CARDS, ...SPELL_CARDS];
