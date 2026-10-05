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
  // Spells. They are priced here and nowhere else, because the HUD reads the
  // same table to print the cost and refuse a purchase the player cannot
  // afford. They carry no hp/dps/range/speed, and that is the marker
  // troops.js and the bot both test for rather than a separate roster flag:
  // a spell that somehow reached spawn() would produce a zero-HP unit that
  // dies on the first tick, so spawn() refuses these outright.
  fireball: { cost: 4, spell: 'fireball' },
  freeze:   { cost: 3, spell: 'freeze' },
  heal:     { cost: 3, spell: 'heal' },
};

// ── spells ────────────────────────────────────────────────────────────────
// What each spell actually does, separated from its price above. `kind` is the
// branch spells.js takes; the rest of the fields are that branch's arguments.
// `amount` on heal is a FRACTION of max HP rather than flat damage: a heal
// that restored a flat number would be a full repair on a 2-cost and a
// rounding error on a tank, which is exactly backwards.
export const SPELLS = {
  fireball: { kind: 'blast',   radius: 2.5, amount: 340, color: 0xff7a2f, label: 'BLAST' },
  freeze:   { kind: 'freeze',  radius: 3.0, duration: 2.5, color: 0x8fe8ff, label: 'FROZEN' },
  heal:     { kind: 'heal',    radius: 3.0, amount: 0.45, color: 0x8bef5a, label: 'MENDED' },
};

// ── deployment ────────────────────────────────────────────────────────────
// The legal band for a card, shared by main.js (the player), bot.js (the
// rival) and vfx.js (the touch deployment overlay). These three used to hold
// private copies of the same four numbers, which is a bug waiting to happen:
// if the band ever moved, the rival would be dropping units somewhere a
// human could not. One table, three readers.
export const DEPLOY = {
  nearZ: 1.2,                       // past the bridge onto your own half
  farZ: ARENA.halfLength - 1.2,     // off the back line, behind the king
  edge: ARENA.halfWidth - 1.0,
  kingClearance: 3.4,               // a building is not a spawn point
  // Ring the ghost draws under the cursor. Fingers are coarser than a mouse
  // cursor, so touch gets a wider target for the same underlying spot.
  ghostRadius: 1.5,
  ghostRadiusTouch: 2.5,
};

// ── elixir ────────────────────────────────────────────────────────────────
// One definition of the economy, previously copied into ui.js and bot.js. The
// bot's fairness rests entirely on it running at the player's exact rate, so
// the number it used to keep to itself is now the same number.
export const ELIXIR = {
  max: 10,
  period: 2.8,     // seconds per drop
  start: 5,        // both sides open on half a bar
  // A full bar that stays full is elixir being wasted. Three seconds is long
  // enough that a player mid-decision is never nagged, and short enough that
  // idling through a full bar does not go unnoticed.
  leakAfter: 3,
};

// ── match clock ───────────────────────────────────────────────────────────
export const MATCH = {
  regular: 180,      // 3:00 of regulation
  overtime: 60,      // then a minute of double elixir
  // Sudden death is decided on total tower HP percentage, the same number the
  // HUD already prints as each side's total, so the winner on the result
  // screen is the winner on the side banners.
  elixirMult: 2,
  onFireRegenMult: 1.1,
};

// ── progression ───────────────────────────────────────────────────────────
// Career numbers. XP for a win is per difficulty rather than a single award,
// because beating the MARSHAL is the thing worth chasing; losing is still
// worth something so a bad run is never a dead end.
export const PROGRESS = {
  storageKey: 'vr_progress',
  tutorialKey: 'vr_tutorial_seen',
  winXp: { easy: 50, normal: 100, hard: 200 },
  lossXp: 25,
  towerXp: 30,       // per enemy tower destroyed
  // Streak tiers, checked from the top down. A 5-win run is also a 3-win run,
  // so testing the XP branch first would quietly hand every ON FIRE match
  // the smaller bonus instead of the bigger one.
  hotStreakAt: 3,
  hotStreakXpMult: 1.5,
  onFireAt: 5,
  onFireRegenMult: MATCH.onFireRegenMult,
  // Each level asks 20% more XP than the last. 100 is the first threshold
  // and 1.2 is the stated growth; the two together are the only definition
  // of "level N costs", so nothing has to hardcode a level total.
  firstLevelXp: 100,
  levelGrowth: 1.2,
};

// ── unlocks ───────────────────────────────────────────────────────────────
// Five cards to start, the remaining seven across levels 2-8. The order is
// cheapest-and-most-basic first, so an early level-up widens a hand that can
// already fight rather than handing over a card the player has no answer for.
export const UNLOCKS = {
  free: 5,
  ladder: [2, 3, 4, 5, 6, 7, 8],
};

// ── feature flags ─────────────────────────────────────────────────────────
// Every subsystem added after the arena can be switched off here without
// touching game logic. A flag is read at the one place a feature is wired in,
// so turning one off removes its behaviour rather than hiding it behind a
// guard that can still be reached by a direct call.
export const FEATURES = {
  matchTimer: true,
  overtime: true,
  tutorial: true,
  longPressTips: true,
  progression: true,
  spells: true,
  targeting: true,
  elixirLeak: true,
  deployVfx: true,
  towerShatter: true,
  screenShake: true,
  dynamicSky: true,
  lobbyMusic: true,
  deployZone: true,
  haptics: true,
};

// ── towers ────────────────────────────────────────────────────────────────
export const TOWERS = {
  // The three-step death timeline, in seconds. Tuned against the tower's own
  // scale: a small tower is 3.5 units tall and a king is 5.4, so a fixed
  // duration reads as different speeds on the two. The shake scales with
  // height for exactly that reason - see towers.js.
  deathShake: 0.45,    // 1. the tower shudders, still standing, still lit
  deathShatter: 0.3,   // 2. the crown and roof blow off, rubble flies
  deathWreck: 0.9,     // 3. the stump sinks and tips over, and stays there

  smallMaxHp: 500,
  kingMaxHp: 1000,
  // Tower defense attributes
  smallRange: 7.5,
  smallFireRate: 0.9,
  smallDamage: 42,
  kingRange: 7.0,
  kingFireRate: 1.0,
  kingDamage: 55,
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