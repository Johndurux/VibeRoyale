// ── progression.js ─────────────────────────────────────────────────────────
// The career that lives in localStorage: XP, level, card unlocks and win
// streak. It touches no DOM, so the lobby, the result screen and the audio
// layer can each read it without importing each other, and the arithmetic can
// be reasoned about on its own.
//
// It does import CHARACTERS, because roster order IS the unlock ladder: a
// card's unlock level is a function of where it sits in the cast. Deriving it
// from a private copy of that list would let the lobby print "LVL 3" on a card
// that actually opened at level 4.
//
// Every read and write is wrapped. Private browsing, a locked-down enterprise
// profile and a full quota all throw on localStorage access, and a progression
// system that throws is worse than no progression: it takes the lobby down
// with it. The module keeps an in-memory copy and simply stops persisting when
// the browser says no, so the game plays exactly the same with storage off.

import { PROGRESS, UNLOCKS, CARDS } from './config.js';
// The roster order is what the unlock ladder walks, so progression has to see
// the same CHARACTERS array the lobby and the HUD read. One list, one order -
// if the ladder were computed from a private copy, "LVL 3" on a card and the
// card actually opening at level 3 would be two different statements.
import { CHARACTERS } from './characters.js';

// The save shape. Kept flat and primitive so a corrupt or partial record
// cannot produce a value that breaks arithmetic further down.
function blank() {
  return {
    xp: 0,
    level: 1,
    wins: 0,
    losses: 0,
    totalDamageDealt: 0,
    towersDestroyed: 0,
    streak: 0,
    bestStreak: 0,
    matches: 0,
  };
}

/** Read a whole number out of a record, falling back when it is nonsense. */
function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// Storage itself may be absent or hostile, so even getting the handle is
// guarded. `mem` is the source of truth for the session; localStorage is only
// ever a mirror of it, which is why a thrown read is not fatal.
let mem = blank();
let storageOk = true;

try {
  const raw = localStorage.getItem(PROGRESS.storageKey);
  if (raw) {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const b = blank();
      mem = {
        xp: num(parsed.xp, b.xp),
        level: Math.max(1, num(parsed.level, b.level)),
        wins: num(parsed.wins),
        losses: num(parsed.losses),
        totalDamageDealt: num(parsed.totalDamageDealt),
        towersDestroyed: num(parsed.towersDestroyed),
        streak: num(parsed.streak),
        bestStreak: num(parsed.bestStreak),
        matches: num(parsed.matches),
      };
    }
  }
} catch (e) {
  storageOk = false;
}

function persist() {
  if (!storageOk) return;
  try {
    localStorage.setItem(PROGRESS.storageKey, JSON.stringify(mem));
  } catch (e) {
    // Quota exceeded, private mode, or a locked-down profile. The session
    // still counts; it just will not survive a reload, which is a far smaller
    // failure than the whole lobby refusing to mount.
    storageOk = false;
  }
}

/**
 * XP required to advance FROM a given level to the next.
 *
 * The thresholds are generated rather than listed, so "each level needs 20%
 * more than the last" is a single formula instead of a list that can go out
 * of step with that sentence.
 * @param {number} level current level, 1-based
 * @returns {number} XP needed
 */
export function xpForLevel(level) {
  return Math.round(PROGRESS.firstLevelXp * Math.pow(PROGRESS.levelGrowth, level - 1));
}

/**
 * Total XP at which a given level begins. Level 1 starts at zero.
 * @param {number} level
 * @returns {number}
 */
export function xpFloor(level) {
  let total = 0;
  for (let i = 1; i < level; i++) total += xpForLevel(i);
  return total;
}

/**
 * The level a given XP total has reached. Derived rather than stored, so a
 * hand-edited or stale save can never claim a level its XP does not support.
 * @param {number} xp
 * @returns {number}
 */
export function levelForXp(xp) {
  let level = 1;
  let left = Math.max(0, xp);
  // Bounded so a tampered XP total cannot spin here: the loop only runs while
  // there is still a threshold left to pay.
  let guard = 0;
  while (left >= xpForLevel(level) && guard++ < 500) {
    left -= xpForLevel(level);
    level++;
  }
  return level;
}

/**
 * The unlock order: the sequence cards actually open in.
 *
 * Deliberately NOT roster order. The cast is arranged for variety, so walking
 * it in order would hand a new player the 5-cost legendary ARMOR as a free
 * card and gate MR. HAT, the cheapest thing in the game. Sorting by elixir
 * cost is the rule the brief asks for - "the cheapest/most basic ones" - and
 * spells sort last on purpose, because a free 4-cost AoE blast would delete
 * the learning curve rather than flatten it. Ties keep roster order, so the
 * sequence is stable between sessions.
 *
 * Built once at module load: it is a pure function of a constant roster, and
 * recomputing it per card per render would be work done to produce the same
 * array every time.
 * @type {string[]}
 */
const UNLOCK_ORDER = CHARACTERS
  .map((c, i) => ({ id: c.id, i, spell: !!CARDS[c.id]?.spell, cost: CARDS[c.id]?.cost ?? 99 }))
  .sort((a, b) => (a.spell - b.spell) || (a.cost - b.cost) || (a.i - b.i))
  .map((c) => c.id);

// position of each id within the unlock sequence
const UNLOCK_RANK = new Map(UNLOCK_ORDER.map((id, i) => [id, i]));

/**
 * The level a card opens at. The first UNLOCKS.free are available from the
 * start; the rest climb the ladder in UNLOCK_ORDER.
 *
 * Past the end of the ladder, the final level repeats: the ladder is sized for
 * a known roster, and if a future card is added the alternative is for it to
 * be permanently unreachable, which is a far worse failure than it opening
 * at the same level as the last one.
 *
 * @param {string} id character id
 * @returns {number} 1 for the free cards
 */
export function unlockLevelFor(id) {
  const rank = UNLOCK_RANK.get(id);
  if (rank === undefined) return 1;
  if (rank < UNLOCKS.free) return 1;
  const step = rank - UNLOCKS.free;
  return UNLOCKS.ladder[Math.min(step, UNLOCKS.ladder.length - 1)];
}

/**
 * Is a card available at the current level?
 * @param {string} id character id
 * @param {number} [level]
 * @returns {boolean}
 */
export function isUnlocked(id, level = mem.level) {
  if (!UNLOCK_RANK.has(id)) return false;
  return unlockLevelFor(id) <= level;
}

/**
 * Apply the outcome of a match and report what it was worth.
 *
 * The streak tier is decided from the streak that existed going in, BEFORE
 * this match is booked, so a win that reaches 3 does not retroactively claim
 * the bonus for the streak it just started. A loss resets the streak and then
 * pays the participation XP, so a bad run is never a dead end.
 *
 * @param {object} r
 * @param {boolean} r.won
 * @param {string} r.difficulty 'easy' | 'normal' | 'hard'
 * @param {number} r.towersDestroyed
 * @param {number} r.damageDealt
 * @returns {object} a breakdown the result screen can print line by line
 */
export function recordMatch({ won, difficulty, towersDestroyed = 0, damageDealt = 0 }) {
  const previousLevel = mem.level;
  const before = mem.streak;

  mem.matches += 1;
  mem.totalDamageDealt += Math.max(0, Math.round(damageDealt || 0));

  if (won) {
    mem.wins += 1;
    mem.towersDestroyed += Math.max(0, towersDestroyed || 0);
    mem.streak += 1;
    if (mem.streak > mem.bestStreak) mem.bestStreak = mem.streak;
  } else {
    mem.losses += 1;
    mem.streak = 0;
  }

  const tier = streakTier(before);
  const base = won ? (PROGRESS.winXp[difficulty] ?? PROGRESS.winXp.normal) : PROGRESS.lossXp;
  const towerBonus = won ? Math.max(0, towersDestroyed || 0) * PROGRESS.towerXp : 0;
  let streakBonus = 0;
  let total = base + towerBonus;
  // Only a win can carry a streak bonus: paying a losing streak for "HOT
  // STREAK" would be a lie about what the player is doing.
  //
  // The test is "any tier at all", not an exact match on 'hot'. That meant
  // 'onfire' paid nothing, so the player on the longest streak in the game was
  // paid the least for it. ON FIRE already carries its own reward - the
  // regen multiplier - but it must not pay LESS than HOT does.
  if (won && tier !== '') {
    streakBonus = Math.round((base + towerBonus) * (PROGRESS.hotStreakXpMult - 1));
    total += streakBonus;
  }

  mem.xp += total;
  // Re-derive rather than incrementing: a level is what the XP says it is.
  mem.level = levelForXp(mem.xp);
  const leveledUp = mem.level > previousLevel;
  persist();

  return {
    base,
    towerBonus,
    streakBonus,
    total,
    level: mem.level,
    previousLevel,
    leveledUp,
    streak: mem.streak,
    tier,
    unlocked: leveledUp ? newlyUnlocked(previousLevel, mem.level) : [],
  };
}

/**
 * The banner a streak earns, or '' for none.
 * @param {number} streak
 * @returns {string} 'onfire' | 'hot' | ''
 */
export function streakTier(streak) {
  if (streak >= PROGRESS.onFireAt) return 'onfire';
  if (streak >= PROGRESS.hotStreakAt) return 'hot';
  return '';
}

/**
 * Which cards opened up between two levels, so a level-up says what it gave
 * you rather than just a number going up.
 * @param {number} from
 * @param {number} to
 * @returns {string[]}
 */
export function newlyUnlocked(from, to) {
  const out = [];
  for (const id of UNLOCK_ORDER) {
    const need = unlockLevelFor(id);
    if (need > from && need <= to) out.push(id);
  }
  return out;
}

/**
 * Elixir regen multiplier earned by the CURRENT streak, applied to the next
 * match. ON FIRE is a match-long buff, not a banked one, so the lobby shows
 * it as a flame and the HUD plays faster while it lasts.
 * @returns {number}
 */
export function regenMultiplier() {
  return streakTier(mem.streak) === 'onfire' ? PROGRESS.onFireRegenMult : 1;
}

/**
 * Has this player seen the tutorial? Read in its own try/catch so a browser
 * that refuses storage answers "no, show it", which is the safe direction:
 * repeating four coach marks is a small annoyance, skipping them for someone
 * who has never seen them is a broken first five minutes.
 * @returns {boolean}
 */
export function hasSeenTutorial() {
  try {
    return localStorage.getItem(PROGRESS.tutorialKey) === '1';
  } catch (e) {
    return false;
  }
}

/** Remember the tutorial. Silently does nothing if storage is unavailable. */
export function markTutorialSeen() {
  try {
    localStorage.setItem(PROGRESS.tutorialKey, '1');
  } catch (e) {}
}

/** A read-only snapshot for the UI. Never hand out the live record. */
export function snapshot() {
  const level = mem.level;
  const floor = xpFloor(level);
  const need = xpForLevel(level);
  const into = mem.xp - floor;
  return {
    xp: mem.xp,
    level,
    wins: mem.wins,
    losses: mem.losses,
    matches: mem.matches,
    streak: mem.streak,
    bestStreak: mem.bestStreak,
    totalDamageDealt: mem.totalDamageDealt,
    towersDestroyed: mem.towersDestroyed,
    tier: streakTier(mem.streak),
    regen: regenMultiplier(),
    // Progress inside the current level, for the result screen's bar. Clamped
    // so a save that has drifted ahead of its own level cannot draw a bar
    // wider than its track.
    levelProgress: need > 0 ? Math.max(0, Math.min(1, into / need)) : 1,
    xpInto: Math.max(0, into),
    xpNeed: need,
  };
}

/** Wipe the career. Only a probe calls this; no game path does. */
export function reset() {
  mem = blank();
  persist();
}