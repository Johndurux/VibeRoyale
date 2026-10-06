// ── progression.js ─────────────────────────────────────────────────────────
// The career that lives in localStorage: XP, level, stage clears, card
// unlocks and win streak. It touches no DOM, so the lobby, the result screen
// and the audio layer can each read it without importing each other, and the
// arithmetic can be reasoned about on its own.
//
// Card unlocks are stage-gated: a card opens when the player clears the stage
// STAGE_UNLOCKS names for it, not when an XP level ticks over. XP and level
// still exist - they are the score and the result screen's progress bar - but
// they gate nothing, so a player who grinds free matches cannot out-level the
// campaign.
//
// Every read and write is wrapped. Private browsing, a locked-down enterprise
// profile and a full quota all throw on localStorage access, and a progression
// system that throws is worse than no progression: it takes the lobby down
// with it. The module keeps an in-memory copy and simply stops persisting when
// the browser says no, so the game plays exactly the same with storage off.

import { PROGRESS, STAGES, STAGE_UNLOCKS, CARDS } from './config.js';

// The save shape. Kept flat and primitive so a corrupt or partial record
// cannot produce a value that breaks arithmetic further down.
function blank() {
  return {
    xp: 0,
    level: 1,
    stage: 0,        // highest stage cleared; 0 means the campaign is virgin
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
        stage: num(parsed.stage, b.stage),
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
 * The stage that must be CLEARED to open a card; 0 = free from the start.
 *
 * STAGE_UNLOCKS in config.js is the whole table: a gate of 1 means winning
 * stage 1 grants the card, a gate of 7 means winning stage 7 does. A card
 * missing from it is 0 - free on purpose rather than locked by accident, so
 * adding a casual card never requires touching progression. An id that is not
 * on the roster at all still answers 0 here; `isUnlocked` is the gate that
 * rejects unknown ids, and keeping this function total means a typo prints a
 * padlock instead of crashing the lobby.
 * @param {string} id character id
 * @returns {number} the stage whose clear grants the card, 0 = free
 */
export function unlockStageFor(id) {
  return STAGE_UNLOCKS[id] ?? 0;
}

/**
 * Is a card available at this point in the campaign?
 *
 * Free cards (gate 0) are always true, including for a brand-new career with
 * nothing cleared - the default deck has to be playable before stage 1 is
 * won, not after. A gated card opens the moment its gate stage is cleared:
 * clearing stage 1 grants TUX for the stage 2 attempt.
 *
 * @param {string} id character id
 * @param {number} [cleared] override for the highest cleared stage
 * @returns {boolean}
 */
export function isUnlocked(id, cleared = mem.stage) {
  if (!CARDS[id] && !STAGE_UNLOCKS[id]) return false;
  const need = unlockStageFor(id);
  if (need <= 0) return true;
  return cleared >= need;
}

/**
 * Apply the outcome of a match and report what it was worth.
 *
 * The streak tier is decided from the streak that existed going in, BEFORE
 * this match is booked, so a win that reaches 3 does not retroactively claim
 * the bonus for the streak it just started. A loss resets the streak and then
 * pays the participation XP, so a bad run is never a dead end.
 *
 * Stage advances only in sequence: clearing stage N+1 banks it, replaying an
 * older stage pays its repeat XP but moves nothing. A first clear pays the
 * stage's full XP reward on top of the match XP; a repeat pays a quarter,
 * because grinding an old stage should never out-earn moving forward.
 *
 * @param {object} r
 * @param {boolean} r.won
 * @param {number} r.stage the stage that was played, 1-based
 * @param {string} r.difficulty 'easy' | 'normal' | 'hard' - the stage's bot tier
 * @param {number} r.towersDestroyed
 * @param {number} r.damageDealt
 * @returns {object} a breakdown the result screen can print line by line
 */
export function recordMatch({ won, stage = 0, difficulty, towersDestroyed = 0, damageDealt = 0 }) {
  const previousLevel = mem.level;
  const previousStage = mem.stage;
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

  // The campaign itself. Sequential advance only, and the stage reward rides
  // on top of the match XP: a first clear is an event, a replay is a wage.
  const cfg = STAGES[stage - 1];
  let stageBonus = 0;
  let stageCleared = false;
  if (won && cfg && stage === previousStage + 1) {
    mem.stage = stage;
    stageCleared = true;
    stageBonus = cfg.xp;
    total += stageBonus;
  } else if (won && cfg && stage <= previousStage) {
    stageBonus = Math.round(cfg.xp / 4);
    total += stageBonus;
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
    stageBonus,
    stageCleared,
    clearedStage: mem.stage,
    total,
    level: mem.level,
    previousLevel,
    leveledUp,
    streak: mem.streak,
    tier,
    unlocked: stageCleared ? newlyUnlocked(previousStage, mem.stage) : [],
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
 * Which cards opened up between two stage clears, so a cleared stage says
 * what it gave you rather than just a number going up.
 * @param {number} fromStage
 * @param {number} toStage
 * @returns {string[]}
 */
export function newlyUnlocked(fromStage, toStage) {
  const out = [];
  for (const id of Object.keys(STAGE_UNLOCKS)) {
    const need = STAGE_UNLOCKS[id];
    if (need > fromStage && need <= toStage) out.push(id);
  }
  // Roster order, so the result screen reads like the picker does.
  return out.sort((a, b) => {
    const ra = CARDS[a] ? 0 : 1;
    const rb = CARDS[b] ? 0 : 1;
    return ra - rb;
  });
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
    stage: mem.stage,
    nextStage: Math.min(mem.stage + 1, STAGES.length),
    stagesTotal: STAGES.length,
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