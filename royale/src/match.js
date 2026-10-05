// ── match.js ──────────────────────────────────────────────────────────────
// The match clock. It owns three states and the transition between them, and
// it is the only thing in the game allowed to declare a match over on time.
//
// Regulation runs down from MATCH.regular. At zero the match does not end -
// it escalates. Overtime doubles elixir and counts UP, which is the part that
// matters for how it feels: the number on screen stops being a countdown the
// player is losing and becomes a scoreboard they are trying to break. It ends
// early if a king falls, and otherwise runs MATCH.overtime seconds before
// sudden death decides it on total tower HP.
//
// It reports outcomes through callbacks rather than touching the DOM, so the
// UI layer decides what a win looks like and this file never learns what a
// result screen is.

import { MATCH, ELIXIR } from './config.js';

/**
 * @param {object} deps
 * @param {Array<object>} deps.towers live towers, for the sudden-death read
 * @param {(info: object) => void} [deps.onTick] called whenever the displayed
 *   second changes
 * @param {(info: object) => void} [deps.onOvertime] fired once, on entry
 * @param {(result: object) => void} [deps.onEnd] fired once, when settled
 */
export function createMatch({ towers, onTick = null, onOvertime = null, onEnd = null }) {
  // 'idle' before the lobby hands over, 'reg' during regulation, 'ot' during
  // overtime. 'done' is a terminal state so a late tower collapse arriving
  // after sudden death cannot overwrite a result already on screen.
  let phase = 'idle';
  let elapsed = 0;
  let otElapsed = 0;
  // The last whole second shown, so onTick fires once per displayed digit
  // instead of once per frame.
  let shownSec = -1;

  function sideTotal(side) {
    let sum = 0;
    let n = 0;
    for (const t of towers) {
      if (t.side !== side) continue;
      n++;
      sum += t.destroyed ? 0 : t.hp / t.maxHp;
    }
    return n ? sum / n : 0;
  }

  /**
   * Sudden death. Decided on the same "total HP %" number the HUD already
   * prints on each side banner, so the reason string and the number the
   * player was watching all the way through cannot disagree.
   * @returns {{winner: 'player'|'enemy'|'draw', reason: string}}
   */
  function suddenDeath() {
    const a = sideTotal('player');
    const b = sideTotal('enemy');
    // A hair of tolerance: two sides at 100.0% and 99.98% are the same match
    // as far as a player is concerned, and losing a tower race inside a
    // rounding error would feel arbitrary.
    if (Math.abs(a - b) < 0.001) {
      return { winner: 'draw', reason: 'SUDDEN DEATH · TOWERS EVEN' };
    }
    if (a > b) return { winner: 'player', reason: 'SUDDEN DEATH · MORE TOWER HP' };
    return { winner: 'enemy', reason: 'SUDDEN DEATH · MORE TOWER HP' };
  }

  function finish(outcome) {
    if (phase === 'done') return;
    phase = 'done';
    if (onEnd) onEnd(outcome);
  }

  return {
    /**
     * Advance the clock. Only ever called from the one render loop, and only
     * while the match is live, so a paused or backgrounded tab cannot quietly
     * burn a player's regulation away.
     * @param {number} dt
     */
    update(dt) {
      if (phase === 'done' || phase === 'idle') return;

      if (phase === 'reg') {
        elapsed += dt;
        if (elapsed >= MATCH.regular) {
          // Clamp rather than let it overshoot: at 0.05s max step the
          // overshoot is invisible, but an unclamped accumulator would carry
          // the error into overtime and start that 60s late as well.
          elapsed = MATCH.regular;
          phase = 'ot';
          otElapsed = 0;
          if (onOvertime) onOvertime({ elixirMult: MATCH.elixirMult });
        }
      } else {
        otElapsed += dt;
        if (otElapsed >= MATCH.overtime) {
          otElapsed = MATCH.overtime;
          finish(suddenDeath());
        }
      }

      const sec = this.remaining();
      if (sec !== shownSec) {
        shownSec = sec;
        if (onTick) onTick({ seconds: sec, phase });
      }
    },

    /**
     * Seconds left on the clock, negative once the match is over. Overtime
     * reports the time REMAINING in overtime, so one formatter and one
     * countdown colour work for both halves of the match.
     * @returns {number}
     */
    remaining() {
      if (phase === 'ot') return Math.ceil(MATCH.overtime - otElapsed);
      if (phase === 'reg') return Math.ceil(MATCH.regular - elapsed);
      return 0;
    },

    /**
     * Declare the match won by a king falling. main.js calls this from the
     * same tower listener that raises the damage numbers, so a knockout and a
     * timeout are settled by the same guard and cannot both fire.
     * @param {'player'|'enemy'|'draw'} winner
     * @param {string} reason
     */
    settle(winner, reason) {
      finish({ winner, reason, overtime: phase === 'ot' });
    },

    /** Arm the clock for a new match and zero every accumulator. */
    start() {
      phase = 'reg';
      elapsed = 0;
      otElapsed = 0;
      shownSec = -1;
    },

    /** Park the clock without declaring anything (lobby, result screen). */
    stop() {
      if (phase !== 'done') phase = 'idle';
    },

    /**
     * Elixir regen multiplier for the current phase. Read by ui.js on every
     * frame, which is why it is a getter rather than an event: the HUD has to
     * be able to ask "how fast should the bar fill right now" without
     * tracking transitions itself.
     * @returns {number}
     */
    get elixirMult() {
      return phase === 'ot' ? MATCH.elixirMult : 1;
    },

    get isOvertime() { return phase === 'ot'; },
    get isLive() { return phase === 'reg' || phase === 'ot'; },
    get isDone() { return phase === 'done'; },
    get phase() { return phase; },
    // Seconds elapsed in total, for the result screen's duration line.
    get elapsed() { return elapsed + otElapsed; },
    // The economy constants, re-exported so ui.js has one import for "how the
    // bar behaves" instead of reaching into config.js for a second opinion.
    get elixirPeriod() { return ELIXIR.period; },
  };
}