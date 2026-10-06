// ── bot.js ────────────────────────────────────────────────────────────────
// The rival. Before this file the enemy side was three static towers and
// nothing else, so the other half of the board was scenery - the player could
// win by walking a card forward and never once be made to answer.
//
// This is deliberately not a pathfinder or a "perfect" opponent. It has its own
// elixir bar with the same rate as the player's, and it only ever acts on the
// tick, so it is playing the same game with the same information the player
// has - just with hands. Difficulty changes how fast it thinks, how straight
// it aims and how much it commits, never how much elixir it gets: an opponent
// that simply has a bigger budget is not a hard opponent, it is a rigged one.
//
// Everything it does goes through troops.spawn(), the same call the player's
// click makes, so the bot is bound by the same rules as a human - it cannot
// drop a troop in the river, past the back line, or onto a full field, because
// the same guards refuse it.

import { ARENA, CARDS, STAGE_UNLOCKS } from './config.js';
import { CHARACTERS } from './characters.js';
import { passable } from './troops.js';

// The enemy's deployment half is the mirror of main.js's: -Z, and the same
// insets off the edges. These are duplicated rather than imported because
// main.js's are deliberately private to the player's own legal() predicate -
// but they are the same numbers, and a divergence here would be a bug that
// only shows as a bot that deploys in a place a human could not.
const DEPLOY_NEAR_Z = 1.2;
const DEPLOY_FAR_Z = ARENA.halfLength - 1.2;
const DEPLOY_EDGE = ARENA.halfWidth - 1.0;
const KING_CLEARANCE = 3.4;

// Elixir economy, matched to ui.js on purpose: same cap, same period, same
// opening half-bar. The bot starts with the same resources the player does.
const ELIXIR_MAX = 10;
const ELIXIR_PERIOD = 2.8;

// A player troop this far onto the enemy half is a problem, not scenery. The
// bridge mouth is at z = 0, so anything past ~1 has committed to the crossing.
const THREAT_Z = 1.0;

// The defender lands this far onto our own side of the bridge at the earliest,
// clamped so the intended point is always in the legal band and findSpot only
// has to solve the river, never the back line.
const DEFEND_MIN_Z = -(DEPLOY_NEAR_Z + 0.2);

// Minimum gap between two of the bot's own troops, so it does not stack its
// whole deck into one tile and then watch it trade alone.
const CROWD_GAP = 2.2;

// ── the presence guarantee ────────────────────────────────────────────────
// Patience is a difficulty dial, not an absence. Whatever a tier's knobs say,
// the rival may never leave the board looking empty: its first fighter is out
// within FIRST_DEPLOY_BY seconds of the match going live, and the silence
// between deployments never exceeds FORCE_DEPLOY_EVERY seconds. A slow tier
// waits longer between THOUGHTS - it never just stands there. The forced card
// is always a TROOP, never a spell: a blast with no good target would spend
// elixir on nothing just to look busy.
const FIRST_DEPLOY_BY = 4;
const FORCE_DEPLOY_EVERY = 8;

// ── difficulty ────────────────────────────────────────────────────────────
// Four knobs, not one difficulty number, because they are the four ways a
// player actually perceives an opponent: how slow they are, how sloppy they
// aim, how reliably they answer a threat, and how greedily they push.
const LEVELS = {
  easy: {
    label: 'RECRUIT',
    think: [2.4, 3.6],   // seconds between decisions
    jitter: 2.2,         // placement noise, world units
    answer: 0.75,        // chance a threat is answered at all
    pushAt: 8,           // elixir it banks before opening a lane
    commit: 0.25,        // chance of opening early on a big card
  },
  normal: {
    label: 'RIVAL',
    think: [1.7, 2.5],
    jitter: 0.9,
    answer: 0.92,
    pushAt: 6,
    commit: 0.55,
  },
  hard: {
    label: 'MARSHAL',
    think: [1.0, 1.7],
    jitter: 0.3,
    answer: 0.99,
    pushAt: 4.5,
    commit: 0.8,
  },
};

const rand = (a, b) => a + Math.random() * (b - a);

/**
 * Mount the rival.
 * @param {object} deps
 * @param {{troops: Array<object>, spawn: Function, MAX_TROOPS: number}} deps.troops
 *   the live troop layer, from buildTroops()
 * @param {Array<object>} deps.towers live towers, for target and guard checks
 * @param {string[]|null} [deps.deck] ids the bot is allowed to play
 * @param {string} [deps.difficulty] key of LEVELS
 * @param {(id: string, x: number, z: number) => void} [deps.onDeploy] called
 *   after a card reaches the field. main.js uses it for the rival's placement
 *   cue, so the other side of the river is audible without the bot ever
 *   importing audio.
 */
export function createBot({ troops, towers, spells = null, deck = null, difficulty = 'normal', onDeploy = null }) {
  const byId = new Map(CHARACTERS.map((c) => [c.id, c]));
  // An empty or unknown deck falls back to the full roster rather than giving
  // the bot an empty hand - a bot that can never act is the old bug again.
  // An empty or unknown deck falls back to the full roster rather than giving
  // the bot an empty hand - a bot that can never act is the old bug again.
  // setStage() replaces this with the campaign mirror per stage.
  let hand = (deck && deck.length ? deck : CHARACTERS.map((c) => c.id))
    .filter((id) => byId.has(id) && CARDS[id]);

  const myKing = towers.find((t) => t.side === 'enemy' && t.kind === 'king');

  let level = LEVELS[difficulty] || LEVELS.normal;
  let levelKey = LEVELS[difficulty] ? difficulty : 'normal';
  // The behaviour knobs actually in play. Default to the tier's own table;
  // setStage() replaces them with the campaign row, which sharpens every
  // stage over the previous one.
  let knobs = level;
  let stageNum = 0;
  let elixir = ELIXIR_MAX / 2;
  let elixirRate = 1; // stage scaling; 1 keeps the bot on the player's income
  let thinkIn = rand(knobs.think[0], knobs.think[1]);
  let live = false;
  let sinceDeploy = 0;   // seconds since a card actually reached the field
  let matchT = 0;        // seconds since start()
  let deployedCount = 0; // cards this match that actually reached the field

  // ── rules ────────────────────────────────────────────────────────────────
  /** May the bot drop a troop here? The mirror of the player's legal(). */
  function legal(x, z) {
    if (Math.abs(x) > DEPLOY_EDGE) return false;
    if (z > -DEPLOY_NEAR_Z || z < -DEPLOY_FAR_Z) return false;
    if (!passable(x, z)) return false;
    if (myKing && Math.hypot(x - myKing.x, z - myKing.z) < KING_CLEARANCE) return false;
    return true;
  }

  /** Is this spot already occupied by one of our own, roughly? */
  function crowded(x, z, gap = CROWD_GAP) {
    for (const t of troops.troops) {
      if (t.dead || t.side !== 'enemy') continue;
      if (Math.hypot(t.x - x, t.z - z) < gap) return true;
    }
    return false;
  }

  /**
   * Find somewhere legal to stand near an ideal spot.
   *
   * The ideal point is usually fine, but "usually" is the problem: the river
   * sits in the way of any sensible defensive line, and a card dropped in the
   * water is a card that costs elixir and produces nothing. So the search
   * widens in rings and stops at the first legal point, which lands the unit on
   * the bank beside the fight instead of in the middle of it.
   *
   * @param {number} x
   * @param {number} z
   * @param {boolean} avoidCrowd also refuse spots already taken by a friend
   * @returns {{x: number, z: number}|null}
   */
  function findSpot(x, z, avoidCrowd) {
    if (legal(x, z) && (!avoidCrowd || !crowded(x, z))) return { x, z };
    // Rings of increasing radius, each sampled on eight points, so the search
    // is symmetric and does not have a favourite direction.
    for (let r = 1.2; r <= 5.2; r += 1.2) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const px = x + Math.cos(a) * r;
        const pz = z + Math.sin(a) * r;
        if (legal(px, pz) && (!avoidCrowd || !crowded(px, pz))) return { x: px, z: pz };
      }
    }
    return null;
  }

  /**
   * Spend elixir and put a fighter on the board.
   * @returns {boolean} true if a card actually reached the field
   */
  function play(id, x, z, avoidCrowd) {
    const cost = (CARDS[id] || {}).cost;
    if (cost == null || elixir < cost) return false;
    const card = byId.get(id);
    if (!card) return false;
    // The capacity check is duplicated from main.js on purpose: the player's
    // deploy() checks it too, and both are allowed to assume the other does not
    // exist. MAX_TROOPS is shared, so the bot is competing for the same 28
    // slots the player is.
    let count = 0;
    for (const t of troops.troops) if (!t.dead) count++;
    if (count >= troops.MAX_TROOPS) return false;
    const spot = findSpot(x, z, avoidCrowd);
    if (!spot) return false;
    const t = troops.spawn(card, spot.x, spot.z, 'enemy');
    if (!t) return false;
    elixir -= cost;
    sinceDeploy = 0;
    deployedCount += 1;
    if (onDeploy) onDeploy(id, spot.x, spot.z);
    return true;
  }

  /** The cheapest unit (never a spell) the hand can currently afford. */
  function cheapestTroopId() {
    let best = null;
    for (const id of hand) {
      const c = CARDS[id];
      if (!c || c.spell) continue;
      if (best === null || c.cost < CARDS[best].cost) best = id;
    }
    return best;
  }

  /**
   * The presence guarantee, checked every frame. Before its first deploy the
   * bot must put a fighter out within FIRST_DEPLOY_BY; afterwards the silence
   * between deployments never exceeds FORCE_DEPLOY_EVERY. Past the deadline
   * it spends on the cheapest unit it owns, in a random lane behind its own
   * bank. This is what keeps an NPC on the board on every stage 1-15.
   */
  function enforcePresence() {
    const wait = deployedCount === 0 ? FIRST_DEPLOY_BY : FORCE_DEPLOY_EVERY;
    if (sinceDeploy < wait) return;
    const id = cheapestTroopId();
    if (!id) return;
    const lane = ARENA.laneX[Math.floor(Math.random() * ARENA.laneX.length)];
    if (play(id, lane + rand(-1.5, 1.5), -(ARENA.river.halfL + rand(1.0, 2.6)), true)) {
      sinceDeploy = 0;
    }
  }

  // ── reading the board ────────────────────────────────────────────────────
  /** Player troops that have committed to the crossing, most dangerous first. */
  function threats() {
    const out = [];
    for (const t of troops.troops) {
      if (t.dead || t.side !== 'player') continue;
      if (t.z > THREAT_Z) continue;
      out.push(t);
    }
    // "Most dangerous" is the one that has travelled furthest, measured by
    // how negative its z is rather than by how big it is: a small troop already
    // on the king tower is a bigger emergency than a fresh tank in the lane.
    out.sort((a, b) => a.z - b.z);
    return out;
  }

  /** The player's weakest standing tower - where a push has the best odds. */
  function weakestTarget() {
    let best = null;
    let bestRatio = Infinity;
    for (const w of towers) {
      if (w.side !== 'player' || w.destroyed) continue;
      const ratio = w.hp / w.maxHp;
      if (ratio < bestRatio) { bestRatio = ratio; best = w; }
    }
    return best;
  }

  // ── choosing a card ──────────────────────────────────────────────────────
  function affordable() {
    const out = [];
    for (const id of hand) {
      const card = byId.get(id);
      if (card && card.spell) continue; // Spells are evaluated strategically
      const s = CARDS[id];
      if (s && elixir >= s.cost) out.push(id);
    }
    return out;
  }

  /**
   * Cast a spell on behalf of the bot.
   * @param {string} id
   * @param {number} x
   * @param {number} z
   * @returns {boolean}
   */
  function castSpell(id, x, z) {
    if (!spells) return false;
    const s = CARDS[id];
    if (!s || elixir < s.cost) return false;
    const res = spells.cast(id, x, z, 'enemy');
    if (!res) return false;
    elixir -= s.cost;
    if (onDeploy) onDeploy(id, x, z);
    return true;
  }

  /**
   * Evaluate spell opportunities (Fireball clumping / lethal burn, Freeze on tanks).
   * @returns {boolean} true if a spell was cast
   */
  function evaluateSpells() {
    if (!spells) return false;

    const pTroops = troops.troops.filter((t) => !t.dead && t.side === 'player');
    const playerKing = towers.find((t) => t.side === 'player' && t.kind === 'king');

    // 1. Fireball evaluation
    if (hand.includes('fireball') && CARDS.fireball && elixir >= CARDS.fireball.cost) {
      // Lethal burn check: player king tower under 340 HP
      if (playerKing && !playerKing.destroyed && playerKing.hp < 340) {
        return castSpell('fireball', playerKing.x, playerKing.z);
      }

      // Clumping check: 2 or more player troops within 2.5 blast radius near bridges or towers
      for (const t1 of pTroops) {
        const cluster = pTroops.filter((t2) => Math.hypot(t2.x - t1.x, t2.z - t1.z) <= 2.5);
        if (cluster.length >= 2) {
          let sx = 0, sz = 0;
          for (const c of cluster) { sx += c.x; sz += c.z; }
          const cx = sx / cluster.length;
          const cz = sz / cluster.length;
          return castSpell('fireball', cx, cz);
        }
      }
    }

    // 2. Freeze evaluation
    if (hand.includes('freeze') && CARDS.freeze && elixir >= CARDS.freeze.cost) {
      // Check for dangerous player unit approaching bot towers within attack distance
      const botTowers = towers.filter((t) => t.side === 'enemy' && !t.destroyed);
      const danger = pTroops.find((t) => {
        if (t.frozen > 0.5) return false;
        const nearTower = botTowers.some((bt) => Math.hypot(t.x - bt.x, t.z - bt.z) <= 5.8);
        return nearTower && (t.card?.id === 'armor' || t.hp >= 550 || t.z < -3.5);
      });
      if (danger) {
        return castSpell('freeze', danger.x, danger.z);
      }
    }

    return false;
  }

  /**
   * Answer a threat. The rule of thumb is the one a human learns in a few
   * games: match the threat's damage or you lose the trade, and keep the
   * answer cheap, because elixir you did not spend is elixir for the push
   * that follows.
   */
  function chooseDefense(threat) {
    const options = affordable();
    if (!options.length) return null;
    // A troop carries its card's stats with it (buildTroops merges CARDS in),
    // so the threat's reach and damage are read off the live object, not looked
    // up by id and re-derived.
    const ts = threat.stats || {};
    let best = null;
    let bestScore = -Infinity;
    for (const id of options) {
      const s = CARDS[id];
      // Raw value: damage and durability per elixir. Cheap cards win this by
      // default, which is correct for the common case of a cheap threat.
      let score = (s.dps * 10 + s.hp / 60) / s.cost;
      // A card that out-damages the threat will not lose the fight, and that
      // is worth more than any amount of efficiency.
      if (s.dps >= ts.dps) score += 6;
      // Out-ranging is close to free damage: the answer hits and they cannot
      // hit back.
      if (s.range >= ts.range) score += 2.5;
      // A fragile card against a big threat is the classic misplay, and the
      // score has to be able to reach for something sturdier.
      if (s.hp < ts.hp * 0.5) score -= 4;
      // A card that dies in one hit is worthless against a tank, whatever its
      // damage says on paper.
      if (ts.dps > s.hp * 0.5) score -= 3;
      score += rand(0, knobs.jitter);
      if (score > bestScore) { bestScore = score; best = id; }
    }
    return best;
  }

  /**
   * Open a lane. A tank that the player has to answer is the whole point, so
   * durability is weighted heavily and the expensive cards are preferred once
   * the bot can already afford them.
   */
  function choosePush() {
    const options = affordable();
    if (!options.length) return null;
    let best = null;
    let bestScore = -Infinity;
    for (const id of options) {
      const s = CARDS[id];
      let score = (s.hp / 100 + s.dps / 20) / s.cost;
      // With a full bank, spending is better than banking: elixir that is not
      // on the field is not doing anything.
      if (elixir >= 7 && s.cost >= 4) score += 2;
      if (s.range < 1.5) score += 1; // melee holds a lane, ranged does not
      score += rand(0, knobs.jitter);
      if (score > bestScore) { bestScore = score; best = id; }
    }
    return best;
  }

  // ── the two things it does ───────────────────────────────────────────────
  function defend(threat) {
    const id = chooseDefense(threat);
    if (!id) return false;
    // Stand just in front of the threat on our own bank, so the answer is
    // already there when the attacker arrives and never has to out-run it.
    // Clamped past the bridge so the intended point is always on legal ground;
    // findSpot then only has to solve the river, never the back line.
    const x = threat.x + rand(-knobs.jitter, knobs.jitter);
    const z = Math.min(DEFEND_MIN_Z, threat.z - rand(1.2, 2.6));
    return play(id, x, z, true);
  }

  function push() {
    const id = choosePush();
    if (!id) return false;
    const target = weakestTarget();
    const lane = target ? target.x : ARENA.laneX[0];
    // Behind our own bridge, on the lane the weak tower sits in, so the troops
    // walk out under their own steam instead of appearing on the far bank.
    const x = lane + rand(-2.2, 2.2);
    const z = -(ARENA.river.halfL + rand(1.0, 2.6));
    return play(id, x, z, true);
  }

  /** One decision. Called only on the think tick, never per frame. */
  function decide() {
    if (evaluateSpells()) return;
    const list = threats();
    if (list.length) {
      // Answer the most advanced threat. A lower-level bot sometimes just lets
      // one walk through, which is the most human-looking flaw an opponent can
      // have and costs it nothing in fairness.
      if (Math.random() < knobs.answer) defend(list[0]);
      return;
    }
    if (elixir >= knobs.pushAt || (elixir >= 5 && Math.random() < knobs.commit)) {
      push();
    }
  }

  // ── public ───────────────────────────────────────────────────────────────
  return {
    /** Advance the clock. dt only; the bot never reads a frame directly. */
    update(dt) {
      if (!live) return;
      matchT += dt;
      sinceDeploy += dt;
      elixir = Math.min(ELIXIR_MAX, elixir + (dt / ELIXIR_PERIOD) * elixirRate);
      enforcePresence();
      thinkIn -= dt;
      if (thinkIn > 0) return;
      thinkIn = rand(knobs.think[0], knobs.think[1]);
      decide();
    },

    /** Arm the bot and reset its bank, at the moment the match goes live. */
    start() {
      elixir = ELIXIR_MAX / 2;
      thinkIn = rand(1.2, 2.2);
      sinceDeploy = 0;
      matchT = 0;
      deployedCount = 0;
      live = true;
    },

    /** Stop it, e.g. once a king has fallen. */
    stop() {
      live = false;
    },

    /**
     * Change difficulty mid-session. Applied cleanly so a lobby that renders
     * a difficulty list and the match that uses it cannot disagree.
     */
    setDifficulty(next) {
      if (!LEVELS[next]) return;
      levelKey = next;
      level = LEVELS[next];
      if (!stageNum) knobs = level;
    },

    /**
     * Arm the bot for a campaign stage. One call does three things:
     *
     * 1. Behaviour: the stage row's `bot` knobs replace the tier table, so a
     *    stage plays measurably sharper than the one before it - faster
     *    decisions, better placement, more reliable answers, earlier pushes.
     * 2. Income: the row's elixir multiplier.
     * 3. Deck: the bot's hand mirrors the player's unlock ladder - a card
     *    joins the rival's hand once its gate stage is reached (the same
     *    STAGE_UNLOCKS table the lobby reads). Early stages the rival fights
     *    with a small cheap hand; by stage 11 it brings everything, spells
     *    included.
     */
    setStage(cfg) {
      if (!cfg) return;
      stageNum = cfg.stage || stageNum;
      this.setDifficulty(cfg.botLevel);
      this.setElixirRate(cfg.elixir);
      if (cfg.bot && cfg.bot.think) knobs = cfg.bot;
      hand = CHARACTERS
        .map((c) => c.id)
        .filter((id) => byId.has(id) && CARDS[id] && (STAGE_UNLOCKS[id] ?? 0) <= stageNum);
    },

    /**
     * Scale the rival's elixir income. The bot still fills the same 10-drop
     * bar and reads the same card costs, but a late-stage opponent regenerating
     * 1.9x is the difference between answering one push and answering three.
     * Clamped so a typo in the stage table cannot give the bot infinite elixir.
     */
    setElixirRate(mult) {
      elixirRate = Number.isFinite(mult) ? Math.max(0.25, Math.min(3, mult)) : 1;
    },

    get elixir() { return elixir; },
    get difficulty() { return levelKey; },
    get isLive() { return live; },
    get hand() { return hand.slice(); },
    get stage() { return stageNum; },
    // Probe surface for the presence guarantee.
    get sinceDeploy() { return sinceDeploy; },
    get matchT() { return matchT; },
    get knobs() { return knobs; },
  };
}