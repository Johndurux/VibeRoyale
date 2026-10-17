// The match loop, driven for real in Node.
//
// The other suites test the parts: run-runtime.mjs exercises the clock against
// six fake tower records, pool-detour.test.mjs marches two units through the
// pool, lobby-deck.test.mjs feeds the lobby a fake DOM. None of them ever ran
// the whole thing together, and that is exactly where an integration gap hides.
// It hid one: match.js published `elixirMult` for overtime, config.js declared
// that overtime doubles elixir, match.js's own comment claimed the HUD read it
// every frame - and the two things that actually hold elixir (ui.js's bar,
// bot.js's bank) each totalled it up from their own private copy of the period.
// Overtime doubled the clock and nothing else, and no test in the repo could
// have noticed, because no test ran a match.
//
// So this file builds the same four objects main.js builds, in the same order,
// and steps them with the same calls and the same combat context object that
// animate() uses:
//
//     matchClock.update(dt); bot.update(dt, elixirMult); troops.update(dt);
//     towerKit.update(dt, { troops, vfx, audio, onHit });
//
// What is still NOT covered, and cannot be from here: anything that needs a GPU
// or a real frame time. vfx is null below, so a tower's shot resolves on the
// tick it fires instead of travelling as a projectile - the loop still proves
// the damage arithmetic, not the flight. The HP screens are drawn into a stub
// canvas whose 2D context records calls instead of rasterising. Layout, touch
// input and audio nodes still need a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => pathToFileURL(path.join(here, '..', 'src', f)).href;

// towers.js paints each tower's HP screen into a 2D canvas every frame, so a
// headless run has to hand it one. A recording context is enough: nothing here
// asserts on pixels, and the proxy keeps up when the drawing code grows a new
// call. measureText has to return a number, and the gradient helpers have to
// return an object with addColorStop, or the draw code throws on the way past.
function ctx2d() {
  const c = {
    canvas: { width: 256, height: 128 },
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
    font: '', textAlign: '', textBaseline: '', globalAlpha: 1, drawn: 0,
    clearRect() { c.drawn++; }, fillRect() { c.drawn++; }, strokeRect() { c.drawn++; },
    drawImage() { c.drawn++; }, fillText() { c.drawn++; }, strokeText() { c.drawn++; },
    save() {}, restore() {}, translate() {}, scale() {}, rotate() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, rect() {},
    fill() { c.drawn++; }, stroke() { c.drawn++; },
  };
  return new Proxy(c, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return () => ({ width: 8 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
globalThis.document = {
  createElement(tag) {
    const n = { tagName: String(tag).toUpperCase(), width: 256, height: 128, style: {} };
    n.getContext = () => ctx2d();
    return n;
  },
};

const { buildTowers, setHitListener } = await import(src('towers.js'));
const { buildTroops } = await import(src('troops.js'));
const { createBot } = await import(src('bot.js'));
const { createMatch } = await import(src('match.js'));
const { CARDS, ELIXIR, MATCH, STAGES } = await import(src('config.js'));
const { CHARACTERS } = await import(src('characters.js'));
const { ELIXIR_MAX, ELIXIR_PERIOD, ELIXIR_START, regen } = await import(src('elixir.js'));
const progression = await import(src('progression.js'));

const DT = 1 / 60;

/**
 * The four live objects main.js wires together, plus the counters a probe would
 * otherwise have to watch the screen for.
 *
 * @param {object} [opts]
 * @param {string} [opts.difficulty] passed straight to the bot
 * @param {boolean} [opts.kingFall] whether a falling king settles the match, as
 *   main.js's hit listener does. Off when a test needs the clock to reach its
 *   own handover rather than be cut short by a knockout.
 */
function world({ difficulty = 'normal', kingFall = true } = {}) {
  const kit = buildTowers();
  const seen = { troopHits: 0, towerHits: 0, shots: 0, kos: 0, damageDealt: 0, deploys: [], playerDeploys: [] };
  const troops = buildTroops({
    towers: kit.towers,
    onHit: () => { seen.troopHits++; },
    onTowerHit: () => { seen.towerHits++; },
  });
  const bot = createBot({
    troops,
    towers: kit.towers,
    difficulty,
    onDeploy: (id, x, z) => seen.deploys.push({ id, x, z }),
  });
  let overtimeFired = 0;
  const ends = [];
  const match = createMatch({
    towers: kit.towers,
    onOvertime: () => { overtimeFired++; },
    onEnd: (result) => ends.push(result),
  });

  // main.js's hit listener, cut down to the part that decides the match: a king
  // that falls settles it through the clock, so a knockout and a timeout share
  // one gate. The HUD, haptics and audio it also drives are not simulated here.
  setHitListener((tower, amount, ko) => {
    // The damage the player's side did, exactly as main.js totals it: hits on
    // enemy towers only, so the number the career banks is damage dealt rather
    // than damage traded.
    if (tower.side === 'enemy') seen.damageDealt += amount;
    if (ko) {
      seen.kos++;
      if (kingFall && tower.kind === 'king') {
        match.settle(tower.side === 'player' ? 'enemy' : 'player', 'king');
      }
    }
  });

  // vfx and audio are null: there is no renderer and no AudioContext here. Both
  // are optional in towers.js by design, which is what makes this runnable.
  const combat = { troops, vfx: null, audio: null, onHit: () => { seen.shots++; } };

  return { kit, troops, bot, match, combat, seen, ends, get overtimeFired() { return overtimeFired; } };
}

/**
 * One frame, in animate()'s order. The towers keep running after the match is
 * over (a collapse has to be allowed to finish) but stop shooting, which is
 * what main.js does by handing them a null combat context.
 * @param {object} w world
 * @param {number} [dt]
 */
function frame(w, dt = DT) {
  w.match.update(dt);
  if (w.match.isLive) {
    const mult = w.match.elixirMult;
    w.bot.update(dt, mult);
    w.troops.update(dt);
    w.kit.update(dt, w.combat);
  } else {
    w.kit.update(dt, null);
  }
}

/** Step the loop for `seconds` of game time. */
function run(w, seconds, dt = DT) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) frame(w, dt);
}

/** Arm everything the way startMatch() does. */
function begin(w) {
  w.kit.reset();
  w.troops.clear();
  w.bot.start();
  w.match.start();
}

// A stand-in for the player, and only for the player: a bar that fills with the
// same regen() the HUD uses, spent through the same troops.spawn() a tap goes
// through, at the same front line DEPLOY.nearZ describes. It exists because a
// test where only the rival deploys has an empty half of the pitch, and
// troop-on-troop fighting - the melee `onHit` callback - never happens at all.
// It is a metronome, not a strategy: fixed lanes, no targeting, no spells. Real
// decisions belong to a human in a browser.
const LANES = [-6, 0, 6, -4, 4];

/**
 * @param {object} w world
 * @param {{card?: string, interval?: number}} [opts]
 * @returns {(dt: number) => void} call once per frame, after the towers
 */
function autoplay(w, { card = 'pip', interval = 1.5 } = {}) {
  // The same card object main.js deploys: the character record, not the bare
  // stats row. troops.spawn() reaches for card.build() to make the unit's mesh,
  // so a card id on its own is a card that throws.
  const record = CHARACTERS.find((c) => c.id === card);
  assert.ok(record, card + ' is not in CHARACTERS');
  let bank = ELIXIR_START;
  let since = interval;
  return (dt) => {
    bank = regen(bank, dt, w.match.elixirMult);
    since += dt;
    if (since < interval) return;
    const cost = CARDS[card].cost;
    if (bank < cost) return;
    const x = LANES[w.seen.playerDeploys.length % LANES.length];
    // Just past the river band on the player's own half, so the unit walks to
    // the bridge rather than starting on top of it.
    const u = w.troops.spawn(record, x, 6.6, 'player');
    if (!u) return; // MAX_TROOPS, or the river: both are refusals, not failures
    bank -= cost;
    since = 0;
    w.seen.playerDeploys.push(card);
  };
}

/** Step the loop with both sides playing. */
function runWithPlayer(w, seconds, dt = DT) {
  const play = autoplay(w);
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    if (w.match.isLive) play(dt);
    frame(w, dt);
  }
}

const sideHp = (w, side) => w.kit.towers.filter((t) => t.side === side).map((t) => t.hp);
const sideMax = (w, side) => w.kit.towers.filter((t) => t.side === side).map((t) => t.maxHp);

test('a stepped match actually fights: both sides deploy and the board takes damage', () => {
  const w = world();
  begin(w);
  runWithPlayer(w, 90);

  // The loop armed rather than sitting idle: this is the failure that would
  // make every other number here meaningless.
  assert.notEqual(w.match.phase, 'idle', 'the match never started');
  assert.ok(w.seen.deploys.length > 0, 'the rival deployed nothing in 90s of stepped play');
  assert.ok(w.seen.playerDeploys.length > 0, 'the player stand-in never got a unit out');
  assert.ok(w.seen.shots > 0, 'no tower ever got a shot off');
  // Troop-on-troop: the two sides meeting in the middle, which only happens if
  // both of them are actually walking at each other.
  assert.ok(w.seen.troopHits > 0, 'the two sides never traded a blow: ' + JSON.stringify(w.seen));
  // And troops on towers, which is the other damage route out of troops.js.
  assert.ok(w.seen.towerHits > 0, 'no unit ever reached a tower');

  const playerHp = sideHp(w, 'player');
  const playerMax = sideMax(w, 'player');
  assert.ok(playerHp.some((hp, i) => hp < playerMax[i]),
    'the rival pushed nothing through, player towers untouched at ' + playerHp);

  // If the match is already over, the only way this loop can end early is a
  // king falling - the clock still has MATCH.regular to run at 90s.
  if (w.match.phase === 'done') {
    assert.equal(w.ends.length, 1, 'an ended match must have reported exactly one result');
    assert.equal(w.ends[0].reason, 'king', 'the match ended early without a king falling');
  } else {
    assert.equal(w.match.phase, 'reg', '90s of a 180s regulation should be regulation or over');
    assert.ok(w.match.elapsed < MATCH.regular, 'the clock ran past regulation without handing over');
  }
});

test('overtime starts once at the end of regulation, and doubles elixir for the rival', () => {
  // kingFall off: this test is about the clock reaching its own handover at the
  // scheduled second, so a knockout must not be allowed to cut it short. The
  // knockout route is covered in the settlement test below.
  const w = world({ kingFall: false });
  begin(w);
  assert.equal(w.match.elixirMult, 1, 'regulation is the plain rate');

  // Left short of the handover on purpose, so the transition is observed rather
  // than assumed. MATCH.regular is the match's own length, not a test constant.
  run(w, MATCH.regular - 1);
  assert.equal(w.match.phase, 'reg', 'a second before the horn is still regulation');
  assert.equal(w.overtimeFired, 0, 'overtime fired early');

  run(w, 2);
  assert.equal(w.match.phase, 'ot', 'the clock should have handed over to overtime');
  assert.equal(w.overtimeFired, 1, 'overtime fires exactly once');
  assert.equal(w.match.elixirMult, MATCH.elixirMult, 'overtime doubles elixir');
  assert.equal(MATCH.elixirMult, 2, 'and the config still says two');

  // The rival's bank, measured rather than inferred. start() is a public call
  // that puts the bank back on the opening half bar and re-rolls its think
  // timer, so the next second is a clean window: no spend can land in it.
  w.bot.start();
  const bank0 = w.bot.elixir;
  assert.equal(bank0, ELIXIR_START, 'a reset bank opens on the config half bar');

  const OT_SECONDS = 1;
  const otTicks = Math.round(OT_SECONDS / DT);
  for (let i = 0; i < otTicks; i++) w.bot.update(DT, w.match.elixirMult);
  const gained = w.bot.elixir - bank0;
  const inOT = (OT_SECONDS * MATCH.elixirMult) / ELIXIR_PERIOD;
  const inReg = OT_SECONDS / ELIXIR_PERIOD;
  // 60 ticks of 1/60: one second exactly, so the gain is one second's worth of
  // the period, doubled. Binary drift over 60 additions is why this is a
  // tolerance and not an equality - 1e-9 is far tighter than any beat the
  // unwired multiplier would miss.
  assert.ok(Math.abs(gained - inOT) < 1e-9,
    'overtime should fill the rival at ' + inOT + ' per second, got ' + gained);
  // The discriminating half: the old code produced inReg here. Without this,
  // a regression back to a private period would still land inside the
  // tolerance above if the multiplier happened to be misread as 1.
  assert.ok(gained > (inOT + inReg) / 2,
    'the rival banked ' + gained + ', which is the regulation rate (' + inReg + '), not double (' + inOT + ')');

  // And the argument is what does it, not the phase: the same call with 1 is
  // the regulation rate even while the match is in overtime.
  w.bot.start();
  for (let i = 0; i < otTicks; i++) w.bot.update(DT, 1);
  assert.ok(Math.abs((w.bot.elixir - bank0) - inReg) < 1e-9,
    'a plain multiplier should still be the plain rate, got ' + (w.bot.elixir - bank0));
});

test('the player\'s bar is a one-line caller of the same regen, so its rate cannot drift', () => {
  // ui.js needs a DOM, so its bar cannot be stepped here; what this locks is
  // that the arithmetic it uses is the same function the rival's bank uses,
  // that the function honours the phase multiplier, and that the two numbers
  // ui.js still holds (the cap and the opening bar) come from the config rather
  // than from a second opinion. The HUD's own frame-by-frame behaviour is
  // checked in a browser, where the bar is.
  assert.equal(ELIXIR_MAX, ELIXIR.max, 'the cap is the config cap');
  assert.equal(ELIXIR_PERIOD, ELIXIR.period, 'the period is the config period');
  assert.equal(ELIXIR_START, ELIXIR.start, 'the opening bar is the config bar');
  assert.equal(ELIXIR.period, 2.8, 'and the config period is still the rate the game was tuned on');
  assert.equal(ELIXIR_MAX, 10, 'and the cap is still ten');

  // A full bar from empty takes the cap times the period. This is the number
  // the felt pace of the game sits on, so it is pinned here rather than
  // discovered by watching.
  let bar = 0;
  let t = 0;
  while (bar < ELIXIR_MAX && t < 1000) {
    const before = bar;
    bar = regen(bar, DT);
    if (bar === before) break;
    t += DT;
  }
  assert.ok(Math.abs(t - ELIXIR_MAX * ELIXIR_PERIOD) < 0.02,
    'an empty bar should fill in ' + ELIXIR_MAX * ELIXIR_PERIOD + 's, filled in ' + t);

  // Overtime is the same call with the phase's multiplier, and nothing else
  // changes: same cap, same period, double the rate.
  assert.ok(Math.abs(regen(0, ELIXIR_PERIOD, 2) - 2) < 1e-12, 'overtime banks two drops per period');
  assert.ok(Math.abs(regen(0, ELIXIR_PERIOD, 1) - 1) < 1e-12, 'regulation banks one');
  assert.equal(regen(9.9, 100, 1), ELIXIR_MAX, 'and it never goes past the cap');
  // A caller that forgets the argument, or hands it junk, must not freeze the
  // bar: main.js is the only caller today, and a bar that silently stops is a
  // worse failure than one that fills at the wrong rate.
  assert.ok(Math.abs(regen(0, ELIXIR_PERIOD) - 1) < 1e-12, 'omitting the multiplier reads as regulation');
  for (const junk of [0, -3, NaN, Infinity, null, undefined, '2']) {
    assert.ok(Math.abs(regen(0, ELIXIR_PERIOD, junk) - 1) < 1e-12, 'multiplier ' + String(junk) + ' reads as regulation');
  }
});

test('a match settles exactly once, and the settle is what books the career', () => {
  const w = world();
  begin(w);
  // Regulation plus overtime plus a beat. A knockout ends it early, and that is
  // legal; what is not legal is a second settle, or a match that never ends.
  runWithPlayer(w, MATCH.regular + MATCH.overtime + 2);

  assert.equal(w.match.phase, 'done', 'the match should be over by the end of overtime');
  assert.equal(w.match.isDone, true);
  assert.equal(w.ends.length, 1, 'the clock must report exactly one result, got ' + w.ends.length);
  const result = w.ends[0];
  assert.ok(['player', 'enemy', 'draw'].includes(result.winner), 'unknown winner ' + result.winner);
  // The two legal routes, and the reason has to name the one that happened: a
  // king fall is reason 'king', the clock is a sudden-death line.
  if (result.reason === 'king') {
    assert.ok(w.seen.kos > 0, 'a king was reported down with no knockout recorded');
    assert.equal(result.overtime, w.match.elapsed > MATCH.regular, 'the overtime flag should match the clock');
  } else {
    assert.match(result.reason, /SUDDEN DEATH/, 'a timeout has to be decided by the sudden-death rule');
    assert.ok(w.match.elapsed >= MATCH.regular, 'sudden death cannot arrive before regulation is up');
  }

  // A late settle is refused, and the result already on screen survives it.
  const before = { ...w.ends[0] };
  w.match.settle(result.winner === 'player' ? 'enemy' : 'player', 'late');
  assert.equal(w.ends.length, 1, 'a settle after the match is over must not report a second result');
  assert.deepEqual(w.ends[0], before, 'and must not overwrite the one that stands');

  // Stepping the loop past the end must not resurrect the match, fire another
  // timeout or leave the towers shooting.
  const shots = w.seen.shots;
  run(w, 10);
  assert.equal(w.ends.length, 1, 'the loop kept settling after the end');
  assert.equal(w.match.phase, 'done', 'the phase must stay terminal');
  assert.equal(w.seen.shots, shots, 'towers kept shooting after the match was settled');
  for (const t of w.kit.towers) {
    assert.ok(Number.isFinite(t.hp) && t.hp >= 0 && t.hp <= t.maxHp, 'tower hp went out of range: ' + t.hp);
  }

  // The settle is the only thing that books a career, and it books the shape
  // endMatch() sends: a win on a real stage clears that stage. Progression has
  // its own suite; what this adds is that a match produced by the loop, end to
  // end, feeds it numbers it accepts.
  const towersDown = w.kit.towers.filter((t) => t.side === 'enemy' && t.destroyed).length;
  progression.reset();
  const booked = progression.recordMatch({
    won: result.winner === 'player',
    stage: 1,
    difficulty: 'normal',
    towersDestroyed: towersDown,
    damageDealt: Math.round(w.seen.damageDealt),
  });
  assert.ok(booked.total > 0, 'a settled match should be worth something');
  assert.equal(booked.clearedStage, progression.snapshot().stage,
    'the clear the return describes must be the one the career remembers');
  if (result.winner === 'player') {
    assert.equal(booked.stageCleared, true, 'a win on stage 1 clears stage 1');
    assert.equal(booked.clearedStage, 1, 'and the career records stage 1 as its high-water mark');
    assert.ok(booked.stageBonus > 0, 'a first clear is worth a bonus on top of the match xp');
    // snapshot().stage is the highest stage CLEARED, not the next one to play -
    // the lobby is what adds one (lobby.js: `1 + clearedStage()`).
    assert.equal(progression.snapshot().stage, 1, 'the mark is the cleared stage, not the next one');
    assert.equal(progression.snapshot().nextStage, 2, 'so the next stage offered is 2');
  } else {
    // recordMatch reports "nothing cleared" as falsy rather than as 0, and both
    // mean the same thing to main.js.
    assert.ok(!booked.stageCleared, 'a loss clears nothing: ' + booked.stageCleared);
    assert.equal(progression.snapshot().stage, 0, 'a loss must not move the high-water mark');
    assert.equal(progression.snapshot().nextStage, 1, 'and the player is offered the same stage again');
  }
  assert.ok(STAGES.length >= 1, 'STAGES is the table the clear is checked against');
  assert.ok(CARDS && Object.keys(CARDS).length > 0, 'the card table loads');
});
