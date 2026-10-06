// Static contract test for the main.js wiring.
//
// The integration cliff is the failure mode here: main.js calls into eight
// other modules, and a method that was renamed or never written shows up as an
// undefined call in the browser rather than as anything this repo can check
// today. These assertions compare every member main.js actually calls against
// the members each module actually publishes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./src/', import.meta.url));
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}

/** The tail of a module's return object, where its public surface lives. */
function published(file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  return src.slice(src.lastIndexOf('return {'));
}
function has(ret, member) {
  return new RegExp('(^|[\\s{,])' + member + '\\b').test(ret);
}
function lineOf(re) {
  return main.slice(0, main.search(re)).split('\n').length;
}
function count(re) {
  return (main.match(new RegExp(re.source, 'gm')) || []).length;
}

console.log('\n== each module publishes the members main.js needs ==');
const surface = {
  'ui.js': ['update', 'setDeck', 'popDamage', 'popDamageAt', 'showResult', 'spend', 'select', 'costOf', 'markAffordable', 'flashHint', 'elixir', 'selected', 'deck'],
  'vfx.js': ['root', 'update', 'setDeployZone', 'deployBurst', 'rubble', 'spellRing', 'spellBlast', 'liveCount'],
  'audio.js': ['unlock', 'play', 'setMusic', 'setScene'],
  'troops.js': ['root', 'troops', 'update', 'spawn', 'clear', 'blast', 'freezeArea', 'inRadius', 'MAX_TROOPS'],
  'towers.js': ['root', 'towers', 'update', 'reset', 'damageTower'],
  'bot.js': ['update', 'start', 'stop', 'setDifficulty', 'setElixirRate', 'setStage', 'difficulty'],
  'lobby.js': ['hide', 'show', 'deck', 'stage'],
  'match.js': ['update', 'remaining', 'settle', 'start', 'stop', 'elixirMult', 'isOvertime', 'isLive', 'isDone', 'phase', 'elapsed', 'elixirPeriod'],
  'spells.js': ['cast'],
};
for (const [file, members] of Object.entries(surface)) {
  const ret = published(file);
  const missing = members.filter((m) => !has(ret, m));
  ok(missing.length === 0, file + ': ' + members.length + ' members' + (missing.length ? ' -- MISSING ' + missing.join(', ') : ''));
}

console.log('\n== main.js calls nothing that does not exist ==');
// The four methods the UI pass still owes are called behind a guard, so they
// are allowed to be absent. Everything else must be a real member.
const guarded = new Set(['setTimer', 'reset', 'flashOvertime', 'showResultPanel']);
const pairs = [
  ['ui', 'ui.js'], ['vfx', 'vfx.js'], ['troops', 'troops.js'],
  ['towerKit', 'towers.js'], ['bot', 'bot.js'], ['lobby', 'lobby.js'],
  ['matchClock', 'match.js'], ['spells', 'spells.js'], ['audio', 'audio.js'],
];
for (const [obj, file] of pairs) {
  const called = new Set();
  // `[A-Za-z_]` rather than `[a-zA-Z]` on the tail: troops.MAX_TROOPS is one
  // member, and stopping at the first letter would report a "MAX" that does not
  // exist and hide a real typo in the rest of the name.
  for (const m of main.matchAll(new RegExp('\\b' + obj + '\\.([A-Za-z_][A-Za-z0-9_]*)', 'g'))) called.add(m[1]);
  called.delete('js');
  const ret = published(file);
  const missing = [...called].filter((m) => !guarded.has(m) && !has(ret, m));
  ok(missing.length === 0, obj + ' -> ' + [...called].sort().join(', ') + (missing.length ? '  MISSING ' + missing.join(', ') : ''));
}

console.log('\n== the four UI-pass methods are actually guarded ==');
for (const m of guarded) {
  ok(new RegExp('if \\(ui\\.' + m + '\\)').test(main), 'ui.' + m + ' is behind an existence check');
}

console.log('\n== no temporal dead zone on the settlement path ==');
// The HUD's onResult hook can reach endMatch(), and endMatch reads these four.
// Declared below createUI they would be in the TDZ on the first result.
const lineSettled = lineOf(/^let settled = false;/m);
const lineDamage = lineOf(/^let damageDealtThisMatch = 0;/m);
const lineUi = lineOf(/^const ui = createUI\(/m);
ok(lineSettled < lineUi, 'settled (L' + lineSettled + ') is declared before createUI (L' + lineUi + ')');
ok(lineDamage < lineUi, 'damageDealtThisMatch (L' + lineDamage + ') is declared before createUI');
ok(count(/^let settled = false;/m) === 1, 'settled is declared exactly once');

console.log('\n== exactly one of each definition ==');
const defs = [
  ['function endMatch', /^function endMatch\(/m],
  ['function startMatch', /^function startMatch\(/m],
  ['function animate', /^function animate\(/m],
  ['const matchClock', /^const matchClock = createMatch\(/m],
  ['const vfx', /^const vfx = createVfx\(/m],
  ['const spells', /^const spells = buildSpells\(/m],
  ['function buzz', /^function buzz\(/m],
  ['function shake', /^function shake\(/m],
  ['setHitListener call', /^setHitListener\(\(/m],
  ['setWreckListener call', /^[ \t]*setWreckListener\(\(/m],
];
for (const [label, re] of defs) {
  const n = count(re);
  ok(n === 1, label + ' appears ' + n + ' time(s)');
}

console.log('\n== the render loop: sim gated, effects not ==');
const loop = main.slice(main.indexOf('function animate('));
const cut = loop.indexOf('renderer.render(scene, camera);');
const head = loop.slice(0, cut);
ok(head.includes('matchClock.update(dt)'), 'the clock ticks inside the live gate');
ok(head.includes('bot.update(dt)') && head.includes('troops.update(dt)') && head.includes('ui.update(dt)'), 'bot, troops and ui tick inside the gate');
ok(!/\{\s*bot\.update/.test(head) || head.indexOf('matchClock.update') < head.indexOf('bot.update'), 'the clock advances first, so a timeout settles before the bot acts');
ok(loop.includes('vfx.update(dt)'), 'vfx updates');
ok(loop.includes('updateShake(dt)'), 'the camera shake updates');
ok(loop.includes('updateSky(dt)'), 'the sky updates');
ok(/\btowerKit\.update\(dt\b/.test(loop), 'the towers keep updating');
ok(head.indexOf('vfx.update') > head.indexOf('matchLive'), 'vfx runs for every frame, live or not, so a collapse finishes after the match ends');

console.log('\n== settlement has one gate ==');
const endBody = main.slice(main.indexOf('function endMatch('), main.indexOf('function startMatch('));
ok(endBody.includes('if (settled) return;'), 'endMatch returns early when already settled');
const atSettled = endBody.indexOf('settled = true;');
const atStop = endBody.indexOf('bot.stop();');
ok(atSettled > -1 && atSettled < atStop, 'settled is set before the bot is stopped');
// Comments mention the call by name, so the count has to be of real code:
// strip line comments before counting, or the explanation of the design reads
// as a second call site.
const codeOnly = main.replace(/^\s*\/\/.*$/gm, '');
ok((codeOnly.match(/matchClock\.settle\(/g) || []).length === 1, 'matchClock.settle is called from exactly one place');
ok(main.includes('onEnd: (result) => {'), 'the clock reports its result to main.js');
ok(endBody.includes('progression.recordMatch'), 'progression is banked in endMatch');
ok(count(/progression\.recordMatch\(/g) === 1, 'recordMatch is called from exactly one place');

console.log('\n== a second match starts clean ==');
const start = main.slice(main.indexOf('function startMatch('));
for (const c of ['damageDealtThisMatch = 0', 'spellsCastThisMatch = 0', 'elixirSpentThisMatch = 0', 'settled = false', 'lastResult = null', 'towerKit.reset()', 'troops.clear()', 'matchClock.start()']) {
  ok(start.includes(c), 'startMatch resets ' + c.replace(/ = .*/, ''));
}
ok(start.indexOf('towerKit.reset()') < start.indexOf('matchLive = true;'), 'the board is rebuilt before the loop is allowed to run');
ok(start.indexOf('matchClock.start()') < start.indexOf('matchLive = true;'), 'the clock is armed before the loop is allowed to run');
ok(!start.includes('progression.recordMatch'), 'an abandoned match banks nothing');

console.log('\n== the play-again path exists ==');
ok(endBody.includes('onPlayAgain'), 'the result carries onPlayAgain');
ok(endBody.includes('onChangeDeck'), 'the result carries onChangeDeck');
ok(endBody.includes('startMatch(currentStage'), 'play-again replays the same stage');
ok(endBody.includes('lobby.show()'), 'change-deck returns to the lobby');
ok(!endBody.includes('location.reload'), 'nothing reloads the page, so the career save survives');

console.log('\n== deploy dispatches on the card ==');
const at = main.indexOf('function deploy(');
// Read to the end of the function by brace balance, not a fixed window and not
// the first "\n}\n". deploy() has nested blocks, so a literal "\n}\n" match
// cuts it off at the first early return and every assertion after it silently
// passes on a fragment.
function blockAfter(src, start) {
  let depth = 0;
  let seen = false;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') { depth++; seen = true; }
    else if (ch === '}') {
      depth--;
      if (seen && depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced block at ' + start);
}
const deploy = blockAfter(main, at);
ok(deploy.includes('if (card.spell)'), 'a spell card is detected from the card object');
ok(deploy.includes('spells.cast(card.spell'), 'a spell resolves through the resolver');
ok(deploy.includes('troops.spawn(card'), 'a troop card still spawns through troops');
ok(deploy.includes('spellsCastThisMatch++'), 'a cast is counted');
ok(deploy.includes('elixirSpentThisMatch += ui.costOf(id)'), 'a spell charges its cost');
ok(deploy.includes("vfx.deployBurst(p.x, p.z, 'player')"), 'the deploy puff is drawn');
// The spell branch is the code between the dispatch and the capacity gate. The
// gate used to sit above the dispatch, so the slice is anchored on the gate
// rather than on troops.spawn, which has since moved below it.
const spellStart = deploy.indexOf('if (card.spell)');
const spellEnd = deploy.indexOf('FIELD IS FULL');
const spellBranch = deploy.slice(spellStart, spellEnd > spellStart ? spellEnd : undefined);
ok(!spellBranch.includes('deployBurst'), 'the spell branch does not also draw a deploy puff');
ok(!spellBranch.includes('FIELD IS FULL'), 'a spell is not refused because the field is full - it adds no troop');
ok(spellBranch.includes('ui.spend(ui.costOf(id))'), 'a spell charges its own elixir');
ok(deploy.indexOf('if (card.spell)') < deploy.indexOf('FIELD IS FULL'), 'the spell branch runs before the troop capacity gate');

console.log('\n== the wreck is felt, not just seen ==');
ok(main.includes('vfx.rubble(tower.x, tower.z, PALETTE.stone)'), 'rubble is thrown where a tower fell');
ok(/if \(FEATURES\.towerShatter\)/.test(main), 'the wreck listener is behind towerShatter');
ok(/if \(FEATURES\.screenShake\)/.test(main), 'the camera kick is behind screenShake');
ok(/if \(FEATURES\.haptics\)/.test(main), 'haptics are behind the haptics flag');
ok(/if \(FEATURES\.dynamicSky\)/.test(main), 'the sky change is behind dynamicSky');
ok(/if \(FEATURES\.lobbyMusic\)/.test(main), 'the music scene change is behind lobbyMusic');
ok(main.includes("audio.setScene('overtime')"), 'overtime switches the audio scene');
ok(main.includes("audio.setScene('battle')"), 'a new match switches back to the battle scene');
ok(main.includes("audio.play('overtime')"), 'overtime has its own cue');

console.log('\n== the dev flags are gated ==');
ok(/const DEV = true;/.test(main), 'a DEV flag exists');
ok(main.includes("if (DEV && qs.get('probe') === '1')"), 'the probe flag is behind DEV');
ok(main.includes("if (DEV && qs.get('state') === 'damaged')"), 'the state flag is behind DEV');
ok(!/^\s*if \(new URLSearchParams\(location\.search\)\.get\('probe'\)/m.test(main), 'the bare probe flag no longer arms a match');

console.log('\n== the test surface sees the new systems ==');
for (const k of ['__match', '__spells', '__vfx', '__progress', '__settled', '__result']) {
  ok(main.includes(k), 'window.__vrScope exposes ' + k);
}

console.log('\n== every __vrScope member is a real binding ==');
// The checks above are substring searches, so they pass just as happily for a
// name that does not exist. `__shake` shipped that way: the key was correct
// enough to match, the value was a function called `shake`, and the object
// literal threw a ReferenceError on load. Every member the test surface
// exposes has to resolve to something main.js actually imported or declared.
const scopeStart = main.indexOf('window.__vrScope = {');
const scopeEnd = main.indexOf('};', scopeStart);
ok(scopeStart > -1 && scopeEnd > scopeStart, 'the __vrScope object literal is findable');
if (scopeStart > -1 && scopeEnd > scopeStart) {
  const literal = main.slice(scopeStart, scopeEnd);
  // Imported names, plus namespace imports (`import * as progression`).
  const bound = new Set();
  for (const m of main.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) bound.add(name);
    }
  }
  for (const m of main.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
  // Top-level declarations. A name is "bound" if it is declared anywhere at
  // column 0-ish, which covers `const x =` and `function x(`.
  for (const m of main.matchAll(/^\s*(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) bound.add(m[1]);

  // Values only: `key: value` and the bare shorthand `key,`. The key half of a
  // `key: value` pair is a property name and needs no binding.
  const names = new Set();
  for (const m of literal.matchAll(/(?:^|[{,]\s*)([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/g)) names.add(m[2]);
  // Bare shorthand entries sit on their own line, e.g. the old `__shake,`.
  for (const m of literal.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*,/gm)) names.add(m[1]);

  const unbound = [...names].filter((n) => !bound.has(n));
  ok(unbound.length === 0, names.size + ' __vrScope members resolve' + (unbound.length ? ' -- UNBOUND ' + unbound.join(', ') : ''));
}

console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' - ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail === 0 ? 0 : 1);