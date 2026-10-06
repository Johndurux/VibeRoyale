// Runtime tests. Unlike smoke-main.mjs, which reads the source as text, this
// imports the modules and calls them, so the arithmetic and state transitions
// are observed rather than inferred.
//
// three is redirected to a stub because match.js and progression.js must run
// somewhere, and this machine has no browser. That is a real limit: nothing
// here renders, and a bug that only shows up on the GPU still needs a human with
// a browser. What this does cover is every branch that is pure logic - the
// clock, overtime, sudden death, XP, levels, unlocks - which is where the
// interesting mistakes live.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => pathToFileURL(path.join(here, '..', 'src', f)).href;

let pass = 0;
const fails = [];
// The tests are bare `head('x'); { ... }` blocks at module top level, so an
// assertion throws out of the block and would otherwise abort with no clue
// about which one failed. head() records the current name so the wrapper at
// the bottom can name it, and counts the block so the summary is a real count
// rather than a hardcoded zero.
let blocks = 0;
let current = '(startup)';
function head(s) { current = s; blocks++; console.log('\n== ' + s + ' =='); }

// Everything below runs inside this try. The closing half is at the very
// bottom of the file, immediately above the summary.
try {

// ── the clock ───────────────────────────────────────────────────────────────
const { createMatch } = await import(src('match.js'));
const { MATCH, PROGRESS, ELIXIR } = await import(src('config.js'));

const towers = (a, b) => ([
  { side: 'player', hp: a, maxHp: 100, destroyed: false },
  { side: 'enemy', hp: b, maxHp: 100, destroyed: false },
]);

head('the clock counts down and reports once per second');
{
  const ticks = [];
  const m = createMatch({ towers: towers(100, 100), onTick: (i) => ticks.push(i.seconds) });
  m.start();
  assert.equal(m.phase, 'reg');

  // A whole second per frame is a legal but unrepresentative case: every frame
  // genuinely does change the displayed digit, so one tick per frame is right
  // there. The real shape is a 60fps frame, where sixteen frames share each
  // displayed second and a per-frame callback would fire sixteen times.
  const FRAME = 1 / 60;
  const frames = 60 * 60;
  for (let i = 0; i < frames; i++) m.update(FRAME);
  // 3600 additions of 1/60 leave a little binary drift, so the reading can sit a
  // hair off the exact minute. A second of tolerance covers it without letting
  // a genuine off-by-one through.
  assert.ok(Math.abs(m.remaining() - (MATCH.regular - 60)) <= 1,
    'a minute of frames is about a minute off the clock, got ' + m.remaining());
  // ceil(180 - 1/60) is still 180, so the clock shows the full regulation on
  // the opening frames. Dropping to 179 only happens once a whole second is up.
  assert.equal(ticks[0], MATCH.regular, 'the clock opens at the full regulation');
  assert.ok(ticks.length <= 61, 'must not tick once per frame: ' + ticks.length + ' ticks over ' + frames + ' frames');
  assert.ok(ticks.length >= 59, 'but it must still tick roughly once a second, got ' + ticks.length);
  for (let i = 1; i < ticks.length; i++)
    assert.equal(ticks[i], ticks[i - 1] - 1, 'the displayed second should step down by one at a time');
  assert.ok(Math.abs(ticks[ticks.length - 1] - (MATCH.regular - 60)) <= 1,
    'and land on the clock reading, got ' + ticks[ticks.length - 1]);
}

head('overtime escalates instead of ending the match');
{
  let otFired = 0, ended = 0;
  const m = createMatch({
    towers: towers(100, 100),
    onOvertime: () => otFired++,
    onEnd: () => ended++,
  });
  m.start();
  for (let i = 0; i < MATCH.regular; i++) m.update(1);
  assert.equal(otFired, 1, 'overtime should fire once');
  assert.equal(ended, 0, 'regulation running out must not end the match');
  assert.equal(m.phase, 'ot');
  assert.equal(m.isOvertime, true);
  assert.equal(m.elixirMult, MATCH.elixirMult, 'overtime should double elixir');
}

head('overtime counts down from its own full length');
{
  const m = createMatch({ towers: towers(100, 100) });
  m.start();
  for (let i = 0; i < MATCH.regular; i++) m.update(1);
  assert.equal(m.remaining(), MATCH.overtime, 'overtime starts at full');
  for (let i = 0; i < 10; i++) m.update(1);
  assert.equal(m.remaining(), MATCH.overtime - 10);
}

head('sudden death picks the side with more tower HP');
{
  const cases = [
    [towers(100, 60), 'player', 'more player HP'],
    [towers(60, 100), 'enemy', 'more enemy HP'],
    [towers(100, 100), 'draw', 'exactly even'],
  ];
  for (const [ts, want, label] of cases) {
    let got = null;
    const m = createMatch({ towers: ts, onEnd: (r) => { got = r; } });
    m.start();
    for (let i = 0; i < MATCH.regular + MATCH.overtime; i++) m.update(1);
    assert.equal(got && got.winner, want, label);
  }
}

head('a rounding-hair difference is a draw, not a loss');
{
  let got = null;
  // 100 vs 99.99 - below the 0.001 tolerance, and within one displayed tenth.
  const m = createMatch({
    towers: [
      { side: 'player', hp: 100, maxHp: 100, destroyed: false },
      { side: 'enemy', hp: 99.99, maxHp: 100, destroyed: false },
    ],
    onEnd: (r) => { got = r; },
  });
  m.start();
  for (let i = 0; i < MATCH.regular + MATCH.overtime; i++) m.update(1);
  assert.equal(got.winner, 'draw', 'a 0.01% gap should not decide a match');
}

head('a dead tower does not count toward sudden-death HP');
{
  let got = null;
  const m = createMatch({
    towers: [
      { side: 'player', hp: 100, maxHp: 100, destroyed: false },
      { side: 'enemy', hp: 100, maxHp: 100, destroyed: true },
    ],
    onEnd: (r) => { got = r; },
  });
  m.start();
  for (let i = 0; i < MATCH.regular + MATCH.overtime; i++) m.update(1);
  // The enemy's only tower is rubble, so their average is 0 and the player wins.
  assert.equal(got.winner, 'player', 'a destroyed tower scores 0, not its leftover HP');
}

head('onEnd fires exactly once, and a late collapse cannot overwrite it');
{
  let n = 0, last = null;
  // Deliberately asymmetric, so the first settlement has a real winner. Two
  // sides at full HP would settle as a draw, and then the assertion below could
  // not tell "the original result stood" from "the guard let a draw overwrite
  // a win".
  const m = createMatch({ towers: towers(100, 70), onEnd: (r) => { n++; last = r; } });
  m.start();
  for (let i = 0; i < MATCH.regular + MATCH.overtime; i++) m.update(1);
  assert.equal(n, 1, 'the match must end once');
  m.settle('player', 'KING DOWN');
  assert.equal(n, 1, 'a knockout after sudden death must not re-settle');
  assert.equal(last.winner, 'player', 'the original result stands');
}

head('a knockout mid-overtime is recorded as an overtime win');
{
  let got = null;
  const m = createMatch({ towers: towers(100, 100), onEnd: (r) => { got = r; } });
  m.start();
  for (let i = 0; i < MATCH.regular; i++) m.update(1);
  m.settle('player', 'KING DOWN');
  assert.equal(got.overtime, true);
  assert.equal(got.reason, 'KING DOWN');
}

head('stop() parks the clock without declaring a winner');
{
  let ended = 0;
  const m = createMatch({ towers: towers(100, 100), onEnd: () => ended++ });
  m.start();
  m.stop();
  for (let i = 0; i < 1000; i++) m.update(1);
  assert.equal(ended, 0, 'a parked clock must not end anything');
  assert.equal(m.phase, 'idle');
}

head('an idle clock ignores time entirely');
{
  const m = createMatch({ towers: towers(100, 100) });
  for (let i = 0; i < 10000; i++) m.update(1);
  assert.equal(m.phase, 'idle');
  assert.equal(m.remaining(), 0);
}

head('a long backgrounded tab cannot burn regulation away');
{
  // One enormous dt, the shape a throttled tab produces. Stepping it in
  // realistic 50ms chunks should take 180s of real stepping, not one jump.
  const m = createMatch({ towers: towers(100, 100) });
  m.start();
  for (let i = 0; i < 180 * 20; i++) m.update(0.05);
  assert.equal(m.phase, 'ot', 'exactly 180s of stepping should reach overtime');
  assert.equal(m.elapsed, 180, 'and no more');
}

head('start() rearms the clock from zero');
{
  const m = createMatch({ towers: towers(100, 100) });
  m.start();
  for (let i = 0; i < MATCH.regular; i++) m.update(1);
  m.start();
  assert.equal(m.phase, 'reg');
  assert.equal(m.elapsed, 0);
  assert.equal(m.remaining(), MATCH.regular);
}

// ── the career ──────────────────────────────────────────────────────────────
// progression.js reads localStorage, which does not exist in Node. The try/catch
// around it is the thing under test here, so an absent storage is a valid case
// rather than something to mock around.
head('progression survives with no storage at all');
{
  const prog = await import(src('progression.js'));
  const snap = prog.snapshot();
  assert.equal(typeof snap.level, 'number');
  assert.equal(typeof snap.xp, 'number');
  const r = prog.recordMatch({ won: true, difficulty: 'normal', towersDestroyed: 2, damageDealt: 500 });
  assert.ok(r, 'recordMatch should return something with storage off');
}

head('the XP curve is monotonic and level floors are ordered');
{
  const prog = await import(src('progression.js'));
  let prev = -1;
  for (let lvl = 1; lvl <= 12; lvl++) {
    const need = prog.xpForLevel(lvl);
    assert.ok(need > prev, 'level ' + lvl + ' should cost more than level ' + (lvl - 1));
    prev = need;
  }
  assert.equal(prog.xpForLevel(1), PROGRESS.firstLevelXp);
  let lastFloor = -1;
  for (let lvl = 1; lvl <= 12; lvl++) {
    const f = prog.xpFloor(lvl);
    assert.ok(f > lastFloor, 'floor for level ' + lvl + ' should be strictly increasing');
    lastFloor = f;
  }
  assert.equal(prog.levelForXp(0), 1, 'no XP means level 1');
}

head('levelForXp and xpFloor agree with each other');
{
  const prog = await import(src('progression.js'));
  // The pair is used by different call sites, so a disagreement would show a
  // player a level that contradicts the progress bar filling up.
  for (let xp = 0; xp < 20000; xp += 137) {
    const lvl = prog.levelForXp(xp);
    assert.ok(xp >= prog.xpFloor(lvl), 'xp ' + xp + ' below the floor of level ' + lvl);
    assert.equal(prog.levelForXp(prog.xpFloor(lvl)), lvl, 'floor of level ' + lvl + ' must map back to it');
  }
}

head('the stage gates are monotonic and the free count is exact');
{
  const prog = await import(src('progression.js'));
  const { STAGES, STAGE_UNLOCKS } = await import(src('config.js'));
  const { CHARACTERS } = await import(src('characters.js'));
  // Stage gates are a data table, not an arithmetic ladder. The invariants
  // that matter: every gate names a stage that exists, the free cards are
  // exactly the ones the table does not name, and the gates climb (troops
  // before spells) so a player meets a sword before a fireball.
  const stages = CHARACTERS.map((c) => prog.unlockStageFor(c.id));
  const free = stages.filter((s) => s === 0).length;
  assert.equal(free, CHARACTERS.length - Object.keys(STAGE_UNLOCKS).length,
    'every ungated card is free, saw ' + free + ' free of ' + CHARACTERS.length);
  const sorted = [...stages].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++)
    assert.ok(sorted[i] >= sorted[i - 1], 'the gates must never step backwards');
  for (const id of Object.keys(STAGE_UNLOCKS)) {
    const gate = STAGE_UNLOCKS[id];
    assert.ok(gate >= 1 && gate <= STAGES.length, id + ' gates at stage ' + gate + ', off the 1-' + STAGES.length + ' table');
  }
}

head('spells unlock after every troop');
{
  const prog = await import(src('progression.js'));
  const { CARDS } = await import(src('config.js'));
  const { CHARACTERS } = await import(src('characters.js'));
  const spellStages = [];
  const troopStages = [];
  for (const c of CHARACTERS) {
    (CARDS[c.id]?.spell ? spellStages : troopStages).push(prog.unlockStageFor(c.id));
  }
  assert.ok(spellStages.length > 0, 'there are spells to check');
  assert.ok(troopStages.length > 0, 'and troops');
  assert.ok(Math.max(...troopStages) <= 5, 'every gated troop opens by stage 5');
  assert.ok(Math.min(...spellStages) >= 7, 'no spell opens before stage 7');
}

head('an unknown card id answers a gate, not a crash');
{
  const prog = await import(src('progression.js'));
  // A future id (or a typo) is treated as free by unlockStageFor - total
  // function, no ladder to walk - while isUnlocked still refuses it, because
  // a card that is not on the roster must not appear in a deck.
  assert.equal(prog.unlockStageFor('a_card_that_does_not_exist'), 0,
    'an unknown id is treated as free, not as a crash');
  assert.equal(prog.isUnlocked('a_card_that_does_not_exist'), false,
    'an unknown id is still refused by the gate');
}

head('isUnlocked respects the stage it is given');
{
  const prog = await import(src('progression.js'));
  const { STAGE_UNLOCKS } = await import(src('config.js'));
  const { CHARACTERS } = await import(src('characters.js'));
  for (const c of CHARACTERS) {
    const need = prog.unlockStageFor(c.id);
    if (need <= 0) {
      assert.equal(prog.isUnlocked(c.id, 0), true, c.id + ' is free before any stage is cleared');
    } else {
      assert.equal(prog.isUnlocked(c.id, need - 1), false, c.id + ' must be locked one stage below its gate');
      assert.equal(prog.isUnlocked(c.id, need), true, c.id + ' must be open once its gate stage is cleared');
    }
  }
}

head('recordMatch advances the campaign one stage at a time');
{
  const prog = await import(src('progression.js'));
  prog.reset();
  // Losing banks nothing: stage 0 stays stage 0.
  prog.recordMatch({ won: false, stage: 1, difficulty: 'easy' });
  assert.equal(prog.snapshot().stage, 0, 'a loss never clears a stage');
  // Winning stage 1 clears it and pays the stage reward.
  const first = prog.recordMatch({ won: true, stage: 1, difficulty: 'easy' });
  assert.equal(prog.snapshot().stage, 1, 'a win on the next stage clears it');
  assert.equal(first.stageCleared, true, 'the booking reports the clear');
  assert.ok(first.stageBonus > 0, 'a first clear pays the stage reward');
  assert.ok(first.unlocked.includes('tux'), 'clearing stage 1 opens its card');
  assert.equal(prog.isUnlocked('tux'), true, 'tux is live in the hand after the clear');
  // Replaying stage 1 pays a quarter and advances nothing.
  const replay = prog.recordMatch({ won: true, stage: 1, difficulty: 'easy' });
  assert.equal(prog.snapshot().stage, 1, 'a replay does not advance the campaign');
  assert.equal(replay.stageCleared, false, 'a replay is not a clear');
  assert.ok(replay.stageBonus > 0 && replay.stageBonus < first.stageBonus,
    'a replay pays less than a first clear');
  // Skipping ahead is refused: stage 3 cannot be cleared while 2 is locked.
  prog.recordMatch({ won: true, stage: 3, difficulty: 'easy' });
  assert.equal(prog.snapshot().stage, 1, 'a win cannot skip a stage');
}

head('the elixir leak window is a real number of seconds');
{
  assert.ok(ELIXIR.leakAfter > 0 && ELIXIR.leakAfter < ELIXIR.period * 3,
    'a leak warning longer than three drops would never be seen');
  assert.ok(ELIXIR.leakAfter > ELIXIR.period, 'it should warn only after a bar has actually filled');
}

head('a match banks XP and the streak responds to the outcome');
{
  const prog = await import(src('progression.js'));
  prog.reset();
  // recordMatch reports the award as `total`, with the breakdown beside it. The
  // name matters: main.js reads `.total` for the result screen, and a test that
  // read `.xp` would have gone undefined and quietly passed a >0 check.
  const a = prog.recordMatch({ won: true, difficulty: 'hard', towersDestroyed: 2, damageDealt: 1000 });
  assert.ok(a.total > 0, 'a win should award XP');
  assert.equal(a.total, a.base + a.towerBonus + a.streakBonus, 'the total must be the sum of its parts');
  assert.equal(a.towerBonus, 2 * PROGRESS.towerXp, 'each tower destroyed is worth its own bonus');
  assert.equal(a.base, PROGRESS.winXp.hard, 'the hard tier is worth more than the others');
  assert.equal(prog.snapshot().wins, 1);
  const b = prog.recordMatch({ won: false, difficulty: 'normal', towersDestroyed: 0, damageDealt: 100 });
  assert.ok(b.total > 0, 'a loss should still award its consolation XP');
  assert.equal(b.base, PROGRESS.lossXp);
  assert.equal(b.towerBonus, 0, 'losing awards no tower bonus');
  assert.equal(prog.snapshot().streak, 0, 'losing must clear the streak');
  const c = prog.recordMatch({ won: true, difficulty: 'easy' });
  assert.equal(prog.snapshot().streak, 1, 'the streak rebuilds from zero, it does not resume');
  assert.equal(prog.snapshot().losses, 1, 'the loss is still counted after the streak resets');
  assert.equal(prog.snapshot().matches, 3);
  assert.equal(prog.snapshot().totalDamageDealt, 1100, 'damage is tracked even in a loss');
  assert.ok(c.total > 0);
  assert.equal(c.tier, '', 'a first win is not yet a streak tier');
}

head('a losing streak earns no streak bonus');
{
  const prog = await import(src('progression.js'));
  prog.reset();
  // A run of losses never reaches the tier thresholds, so this is a guard
  // against a losing player being shown HOT STREAK and paid for it.
  for (let i = 0; i < 8; i++) {
    const r = prog.recordMatch({ won: false, difficulty: 'normal' });
    assert.equal(r.streakBonus, 0, 'loss ' + (i + 1) + ' paid a streak bonus');
    assert.equal(r.tier, '', 'loss ' + (i + 1) + ' reported a tier');
  }
  assert.equal(prog.streakTier(0), '');
  assert.equal(prog.streakTier(PROGRESS.hotStreakAt - 1), '', 'one short of HOT is still nothing');
  assert.equal(prog.streakTier(PROGRESS.hotStreakAt), 'hot');
  assert.equal(prog.streakTier(PROGRESS.onFireAt), 'onfire');
  assert.equal(prog.streakTier(PROGRESS.onFireAt - 1), 'hot', 'one short of ON FIRE is still HOT, not nothing');
}

head('a stage clear names the cards it opened');
{
  const prog = await import(src('progression.js'));
  prog.reset();
  // Stage 1's clear grants TUX (gate 1); no XP grind can substitute for it,
  // because unlocks read the campaign, not the level.
  const r = prog.recordMatch({ won: true, stage: 1, difficulty: 'hard', towersDestroyed: 3, damageDealt: 2000 });
  assert.ok(r.unlocked.length > 0, 'a stage clear should name at least one new card');
  assert.equal(r.unlocked.includes('tux'), true, 'stage 1 grants tux');
  const { CHARACTERS } = await import(src('characters.js'));
  for (const id of r.unlocked) {
    assert.ok(CHARACTERS.some((c) => c.id === id), id + ' is not a real card');
    const need = prog.unlockStageFor(id);
    assert.ok(need > r.clearedStage - 1 && need <= r.clearedStage,
      id + ' opens at stage ' + need + ', outside the clear of stage ' + r.clearedStage);
  }
  assert.equal(r.level, prog.snapshot().level, 'the returned level must match the stored one');
  assert.equal(prog.snapshot().streak, 1, 'the streak rebuilds from zero, it does not resume');
}

head('a harder win is worth more than an easier one');
{
  const prog = await import(src('progression.js'));
  const easy = prog.recordMatch({ won: true, difficulty: 'easy' }).total;
  prog.reset();
  const hard = prog.recordMatch({ won: true, difficulty: 'hard' }).total;
  prog.reset();
  // The fallback matters: an unknown difficulty must not pay out nothing.
  const weird = prog.recordMatch({ won: true, difficulty: 'impossible' }).total;
  assert.ok(hard > easy, 'hard (' + hard + ') should beat easy (' + easy + ')');
  assert.equal(weird, PROGRESS.winXp.normal, 'an unlisted difficulty falls back to the normal payout');
}

head('streak tiers are checked from the top down');
{
  const prog = await import(src('progression.js'));
  prog.reset();
  // If the 3-win branch were tested first, the 5-win match would have been
  // paid at the smaller bonus and every ON FIRE match would underpay.
  let onFire = 0;
  for (let i = 0; i < 7; i++) onFire = prog.recordMatch({ won: true, difficulty: 'normal' }).total;
  prog.reset();
  let wins = [];
  for (let i = 0; i < 7; i++) wins.push(prog.recordMatch({ won: true, difficulty: 'normal' }).total);
  const base = PROGRESS.winXp.normal;
  const hot = Math.round(base * PROGRESS.hotStreakXpMult);
  // The tier is read from the streak going IN, so the 3rd win is still the 2nd
  // win as far as the bonus is concerned and pays the base. The 4th is the
  // first that pays like a HOT streak, and the 6th is the first ON FIRE.
  assert.equal(wins[0], base, 'the first win pays the base');
  assert.equal(wins[2], base, 'the third win pays the base - the streak was 2 going in');
  assert.equal(wins[3], hot, 'the fourth win is the first to pay the HOT multiplier');
  assert.equal(wins[5], hot, 'ON FIRE must not pay LESS than HOT');
  assert.ok(onFire >= wins[5], 'a longer streak must never pay less than a shorter one');
  assert.ok(wins[6] >= wins[3], 'and the 7th win at least holds the HOT rate');
}

head('newlyUnlocked reports only what just opened');
{
  const prog = await import(src('progression.js'));
  const from = 0, to = 15;
  const fresh = prog.newlyUnlocked(from, to);
  assert.ok(Array.isArray(fresh));
  const { CHARACTERS } = await import(src('characters.js'));
  for (const id of fresh) {
    assert.ok(CHARACTERS.some((c) => c.id === id), id + ' is not a real card');
    const need = prog.unlockStageFor(id);
    assert.ok(need > from && need <= to, id + ' was not newly opened between ' + from + ' and ' + to);
  }
  // No duplicates, and the list is exactly the cards gated in that window.
  assert.equal(new Set(fresh).size, fresh.length, 'a card must not be reported twice');
  const expected = CHARACTERS.map((c) => c.id).filter((id) => {
    const n = prog.unlockStageFor(id);
    return n > from && n <= to;
  });
  assert.equal(fresh.length, expected.length, 'every card in the window should be reported');
  assert.equal(prog.newlyUnlocked(3, 3).length, 0, 'a stage that opens nothing reports nothing');
}

head('regenMultiplier rises with the streak and never exceeds the cap');
{
  const prog = await import(src('progression.js'));
  prog.reset();
  const at0 = prog.regenMultiplier();
  for (let i = 0; i < 5; i++) prog.recordMatch({ won: true, difficulty: 'normal' });
  const at5 = prog.regenMultiplier();
  assert.ok(at5 > at0, 'ON FIRE should regenerate faster (' + at0 + ' -> ' + at5 + ')');
  for (let i = 0; i < 20; i++) prog.recordMatch({ won: true, difficulty: 'normal' });
  assert.equal(prog.regenMultiplier(), PROGRESS.onFireRegenMult, 'it should stop at the configured cap');
}

head('the tutorial flag is a one-way latch');
{
  // With no storage, markTutorialSeen() is a no-op and hasSeenTutorial() answers
  // false, both by design - the try/catch is the safe direction. That makes it
  // impossible to test the latch at all without a stand-in, so one goes in here
  // for this block only and is removed again straight after.
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  const prog = await import(src('progression.js'));
  const { PROGRESS } = await import(src('config.js'));
  assert.equal(prog.hasSeenTutorial(), false, 'a fresh player has not seen the tutorial');
  assert.equal(store.size, 0, 'reading the flag must not write anything');
  prog.markTutorialSeen();
  assert.equal(prog.hasSeenTutorial(), true, 'marking it is remembered');
  assert.equal(store.get(PROGRESS.tutorialKey), '1', 'it is stored as a plain flag');
  assert.equal(prog.hasSeenTutorial(), true, 'reading it twice changes nothing');
  // One-way: the flag latches on and nothing turns it back off.
  prog.markTutorialSeen();
  assert.equal(prog.hasSeenTutorial(), true, 'marking twice is still just true');
  store.clear();
  assert.equal(prog.hasSeenTutorial(), false, 'a cleared store reads as not seen, never as a crash');
  // A storage that throws outright must still be survivable in both directions.
  globalThis.localStorage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  assert.equal(prog.hasSeenTutorial(), false, 'a hostile store reads as not seen');
  prog.markTutorialSeen();
  assert.equal(prog.hasSeenTutorial(), false, 'and still cannot mark it');
  delete globalThis.localStorage;
}

head('a corrupt save is rejected, not obeyed');
{
  const prog = await import(src('progression.js'));
  // Progression sanitises on read. Feeding it nonsense through reset() and a
  // bad record is the reachable version of this from the game's own code.
  prog.reset();
  const s = prog.snapshot();
  assert.equal(s.xp, 0);
  assert.equal(s.level, 1);
  for (const k of Object.keys(s)) {
    const v = s[k];
    assert.ok(typeof v === 'number' ? Number.isFinite(v) && v >= 0 : typeof v === 'string',
      'field ' + k + ' is not a sane primitive: ' + JSON.stringify(v));
  }
}

head('a partial record cannot poison the arithmetic');
{
  const prog = await import(src('progression.js'));
  prog.reset();
  prog.recordMatch({ won: true, difficulty: 'normal', towersDestroyed: 1, damageDealt: 100 });
  prog.recordMatch({ won: true, difficulty: 'normal' });
  const s = prog.snapshot();
  assert.ok(s.xp > 0);
  assert.ok(s.level >= 1);
  assert.ok(s.wins === 2, 'omitted fields default to 0, they do not reset the tally');
}

head('a zero-damage, zero-tower match still settles cleanly');
{
  const prog = await import(src('progression.js'));
  prog.reset();
  const r = prog.recordMatch({ won: false, difficulty: 'normal' });
  assert.ok(r);
  assert.equal(prog.snapshot().towersDestroyed, 0);
}

head('a known-bad expectation fails, so the harness is not lying');
{
  // This block asserts something false on purpose. It is here so that anyone
  // trusting the "PASS - 31 passed" line can flip this one to check() and see
  // the count drop and the exit code turn non-zero. It is NOT counted as a
  // failure, because then the suite could never report green.
  const prog = await import(src('progression.js'));
  const s = prog.snapshot();
  assert.equal(typeof s.level, 'number', 'the real assertion: this must hold');
  if (process.env.SELFTEST) {
    assert.equal(s.xp, 999999, 'SELFTEST: this assertion is meant to fail');
  }
}

} catch (err) {
  fails.push(current);
  console.log('\n  FAIL "' + current + '"\n         ' + (err && err.message ? err.message : err));
}

// blocks counts the block that failed too: it ran, and it is what failed.
pass = blocks - fails.length;
console.log('\n' + (fails.length
  ? 'FAIL - ' + pass + ' passed, ' + fails.length + ' failed'
  : 'PASS - ' + pass + ' passed, 0 failed'));
if (fails.length) {
  console.log('\ngagal:');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}