// ── config.js ─────────────────────────────────────────────────────────────
// Every tunable number for VibeRoyale, in one place. Phase 1 fixes the arena
// footprint and tower HP; later phases add liquidity, combat and match flow
// here rather than scattering literals through the modules.

// ── arena footprint ───────────────────────────────────────────────────────
// The arena is a trading floor: the player's side is +Z (nearest the camera),
// the opponent's is -Z.
export const ARENA = {
  halfWidth: 11,      // x extent of the floor
  halfLength: 17,     // z extent of the floor
  // Lane centre lines. Phase 1 draws the three lanes and the deal bridge;
  // phases 3-4 reuse these exact numbers for unit movement and bot AI.
  laneX: [-6.2, 0, 6.2],
  laneWidth: 3.4,
  // The crossing, as a footprint. arena.js draws the water from it and
  // troops.js tests it before every step, so "is this spot walkable" has a
  // single answer instead of a second copy of these numbers drifting.
  river: { halfW: 2.9, halfL: 5.2 },
};
// -- cards ------------------------------------------------------------------
// What each fighter costs and what it does on the field. Keyed by character id
// rather than folded into CHARACTERS, because these are the balance knobs: a
// character is a model, a card is a decision, and retuning a card should not
// mean editing somebody's art.
//
// The shape of the numbers, against TOWERS below: a 500 HP side tower falls to
// a 5-cost in about four seconds of contact and to a 2-cost in under two.
// That gap is the whole trade - the cheap card wins a fight and loses a tower
// push, which is what the elixir cost is asking you to think about.
//
// 'hitEvery' is the swing period in seconds, so dps * hitEvery is one hit.
// 'range' is centre-to-centre in world units, same scale as the lane spacing,
// so a ranged fighter visibly out-reaches a melee one.
export const CARDS = {
  armor:    { cost: 5, hp: 1100, dps: 150, range: 1.7, speed: 2.2, hitEvery: 0.9 },
  captain:  { cost: 4, hp: 900,  dps: 130, range: 1.6, speed: 2.4, hitEvery: 0.8 },
  mist:     { cost: 3, hp: 420,  dps: 95,  range: 1.4, speed: 3.4, hitEvery: 0.55 },
  honey:    { cost: 3, hp: 520,  dps: 110, range: 2.6, speed: 2.6, hitEvery: 0.7 },
  goggles:  { cost: 3, hp: 600,  dps: 105, range: 1.5, speed: 2.8, hitEvery: 0.65 },
  tux:      { cost: 3, hp: 640,  dps: 120, range: 1.5, speed: 2.5, hitEvery: 0.7 },
  lavender: { cost: 2, hp: 300,  dps: 80,  range: 2.4, speed: 3.0, hitEvery: 0.6 },
  pip:      { cost: 2, hp: 260,  dps: 85,  range: 1.3, speed: 3.6, hitEvery: 0.5 },
  mrhat:    { cost: 2, hp: 340,  dps: 75,  range: 1.4, speed: 3.1, hitEvery: 0.6 },
};

// ── towers ────────────────────────────────────────────────────────────────
export const TOWERS = {
  smallMaxHp: 500,
  kingMaxHp: 1000,
  // Side positions, per side ('player' = +Z, 'enemy' = -Z).
  // King sits centre-back; the two ATM towers guard the side lanes forward.
  king: { x: 0, z: 13.2 },
  small: [
    { x: -6.2, z: 8.4 },
    { x: 6.2, z: 8.4 },
  ],
};

// ── palette (sunny arena, not a trading pit) ──────────────────────────────
// Every colour here is the 3D twin of a --vr-* CSS variable in index.html.
// The two are kept adjacent on purpose: a HUD that sits in a different
// temperature than the world behind it reads as a different game wearing the
// same screen, which is exactly what the old dark-on-dark UI did.
export const PALETTE = {
  // sky
  skyTop: 0x6fc7f0,
  skyMid: 0x9bd8f2,
  skyBottom: 0xffd98a,
  fog: 0xbfe3f5,

  // ground
  grass: 0x6cc24a,
  grassAlt: 0x5ab03c,
  grassDark: 0x4a9633,
  stone: 0xc9b79a,
  stoneDark: 0xa8956f,
  stoneLine: 0x8a7857,

  // the centre crossing: water, not a black void
  water: 0x3fa9e0,
  waterDeep: 0x2a7fbf,
  foam: 0xd8f2ff,

  // gold trim, the one luxury material in the game
  gold: 0xffc94a,
  goldDark: 0xb8860b,

  // health - mirrors the Clash band, not the old market band
  hpGreen: 0x6fcf3e,
  hpWarn: 0xff9f45,
  hpRed: 0xff5c4d,

  // towers
  towerStone: 0xb8a88c,
  towerStoneLit: 0xd4c4a6,
  towerStoneDark: 0x8f7f66,

  // team identity. Blue is you, red is them - the fastest read on the board.
  player: 0x3d8be8,
  enemy: 0xe04a3f,

  // decoration
  flame: 0xff9a3c,
  flameCore: 0xffe066,
  cloud: 0xffffff,
  cloudShade: 0xdcecf8,
  crowd: 0xffd9a0,
  ink: 0x1a1a1a,
};

// ── team ──────────────────────────────────────────────────────────────────
export const TEAM = {
  player: { key: 'player', tint: PALETTE.player, label: 'YOU' },
  enemy: { key: 'enemy', tint: PALETTE.enemy, label: 'RIVAL' },
};

// ── rarity ────────────────────────────────────────────────────────────────
// Drives the card border in ui.js and the card gradient in the portrait. The
// legendary value is a gradient string, not a hex, because a legend is drawn
// as a conic sweep and a flat colour cannot express it.
export const RARITY = {
  common: {
    key: 'common', color: '#b0b0b0', name: 'COMMON',
    bg: 'linear-gradient(180deg,#e2e6ea,#b6bcc4)',
  },
  rare: {
    key: 'rare', color: '#ff9f45', name: 'RARE',
    bg: 'linear-gradient(180deg,#ffdcae,#ff9f45)',
  },
  epic: {
    key: 'epic', color: '#a259ff', name: 'EPIC',
    bg: 'linear-gradient(180deg,#e2c8ff,#a259ff)',
  },
  legendary: {
    key: 'legendary',
    color: '#ffd700',
    name: 'LEGENDARY',
    gradient: 'linear-gradient(135deg,#FFD700 0%,#FF69B4 38%,#00C2FF 72%,#FFD700 100%)',
    bg: 'linear-gradient(140deg,#ffe98a 0%,#ff9ad5 36%,#7fd8ff 70%,#ffe98a 100%)',
  },
};