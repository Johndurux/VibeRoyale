// ── elixir.js ─────────────────────────────────────────────────────────────
// The elixir economy, in one place.
//
// ui.js (the player's bar) and bot.js (the rival's bank) each used to carry
// their own copy of the cap, the period and the opening half-bar. Three copies
// of one number is how a rule comes to exist in one place and be forgotten in
// another: match.js published `elixirMult`, config.js declared that overtime
// doubles elixir, match.js's own comment said the HUD read it every frame - and
// neither spender ever asked for it. Overtime doubled the clock and nothing
// else, so both bars kept filling at the regulation rate in the one phase that
// is supposed to be decided by tempo.
//
// The arithmetic now lives here and both spenders call it. A test can step
// regen() directly, which is the point: the rate is no longer something you can
// only see by watching a bar in a browser.

import { ELIXIR } from './config.js';

export const ELIXIR_MAX = ELIXIR.max;
export const ELIXIR_PERIOD = ELIXIR.period;
/** Both sides open on a half bar: enough for one cheap card, not two. */
export const ELIXIR_START = ELIXIR.start;

/**
 * One frame of regeneration, capped.
 *
 * @param {number} current the bar as it stands, as a float - the fraction is
 *   the accumulator, so partial progress toward the next drop is never lost
 * @param {number} dt seconds this frame covered (main.js clamps it already)
 * @param {number} [mult] phase multiplier: 1 in regulation, MATCH.elixirMult in
 *   overtime. Anything that is not a positive finite number reads as 1, so a
 *   caller that forgets the argument cannot stop the bar dead.
 * @returns {number} the new value, never past the cap
 */
export function regen(current, dt, mult = 1) {
  const m = Number.isFinite(mult) && mult > 0 ? mult : 1;
  return Math.min(ELIXIR_MAX, current + (dt * m) / ELIXIR_PERIOD);
}
