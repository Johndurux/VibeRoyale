// -- main.js ----------------------------------------------------------------
// Boot. Wires the modules together and starts the render loop. Deliberately
// thin: the game rules live in the modules, not here.

import { renderer, scene, camera, CAM_ORIGIN } from './scene.js';
import { buildArena } from './arena.js';
import { buildTowers, damageTower, setHitListener } from './towers.js';
import { buildTroops, passable } from './troops.js';
import { CHARACTERS } from './characters.js';
import { createUI } from './ui.js';
import { createAudio } from './audio.js';
import { createBot } from './bot.js';
import { createLobby } from './lobby.js';
import { ARENA, TOWERS, PALETTE, CARDS } from './config.js';
import { neonBox } from './voxel.js';
import * as THREE from 'three';

// Clamp the simulation step so a throttled tab cannot teleport anything on
// the first frame back from a multi-second delta.
const MAX_DT = 0.05;

const arena = buildArena();
const towerKit = buildTowers();
scene.add(arena.root, towerKit.root);

// -- audio ------------------------------------------------------------------
// Nothing is audible until the first real gesture, because a browser will not
// start an AudioContext without one. Every call into this handle is safe
// before that point, so the game below can wire sound in unconditionally and
// never branch on whether audio happened to be allowed.
const audio = createAudio();

// One gesture unlocks the whole session. keydown is here as well as pointerdown
// because a player who starts by hitting a number key deserves the same sound
// as one who taps a card.
const unlockAudio = () => audio.unlock();
window.addEventListener('pointerdown', unlockAudio, { passive: true });
window.addEventListener('keydown', unlockAudio, { passive: true });

// -- match state ------------------------------------------------------------
// The whole simulation is frozen until the lobby says go. Not gated per
// handler: one flag, read in the loop, so there is no path where the field is
// live but the bot is not, or the bot is spending elixir behind a lobby the
// player cannot click through.
let matchLive = false;

// Mounted after the towers exist: the HUD binds to towerKit.towers, so it has
// to be created once there is real HP to read. The two callbacks are how the
// HUD reports a card being armed and a match being decided without owning an
// audio handle or knowing what a bot is.
const ui = createUI({
  towerKit,
  camera,
  onCardPick: () => audio.play('card'),
  onResult: (won) => {
    matchLive = false;
    bot.stop();
    audio.setMusic(false);
    audio.play(won ? 'victory' : 'defeat');
  },
});

// Every tower hit raises a damage number at the tower that took it, and says
// so out loud. A king hit gets its own heavier cue - it is the sound of the
// one tower whose loss ends the match.
setHitListener((tower, amount, ko) => {
  ui.popDamage(tower, amount, ko);
  if (ko) audio.play('ko');
  else audio.play(tower.kind === 'king' ? 'king' : 'towerHit');
});

// Troops come after the UI, because a troop landing a hit needs popDamageAt()
// to throw a number at whatever it hit - and troop-on-troop damage has no
// tower for the tower listener to hang off.
const troops = buildTroops({
  towers: towerKit.towers,
  onHit: (troop, amount) => {
    ui.popDamageAt(troop.x, 2.8, troop.z, amount, false);
    audio.play('hit');
  },
});
scene.add(troops.root);

// -- the rival --------------------------------------------------------------
// Built now, armed later. The bot shares troops.js and the same 28-slot
// capacity the player is spending, so it is on exactly the same rules.
const bot = createBot({
  troops,
  towers: towerKit.towers,
  difficulty: 'normal',
  // The rival's plays are audible so the player can read a counter from sound
  // alone when the far bank is off screen.
  onDeploy: () => audio.play('enemyPlace'),
});

// -- placement --------------------------------------------------------------
// A card is played in two moves: click the card, then click the field. This
// block owns both halves - turning a screen pixel into a spot on the grass,
// and deciding which spots are allowed.

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
// The grass is flat, so the plane y=0 IS the ground. Raycasting the arena's own
// floor meshes would work too and would be a worse idea: the floor is four
// separate slabs with a river cut through the middle, and a ray that clips the
// seam between two of them would drop the card in the gap.
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _ground = new THREE.Vector3();

// Deployment limits. The player owns +Z, so the far half is the rival's and
// dropping a card there would be a free forward placement. The near and far
// bounds also keep cards off the exact back line, behind the king tower.
const DEPLOY_NEAR_Z = 1.2;
const DEPLOY_FAR_Z = ARENA.halfLength - 1.2;
const DEPLOY_EDGE = ARENA.halfWidth - 1.0;
const KING_CLEARANCE = 3.4;

const playerKing = towerKit.towers.find((t) => t.side === 'player' && t.kind === 'king');

/**
 * Turn a pixel into a point on the grass.
 * @param {number} clientX
 * @param {number} clientY
 * @returns {{x: number, z: number}|null} null if the ray misses the ground
 */
function groundAt(clientX, clientY) {
  pointerNdc.x = (clientX / window.innerWidth) * 2 - 1;
  pointerNdc.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);
  return raycaster.ray.intersectPlane(groundPlane, _ground)
    ? { x: _ground.x, z: _ground.z }
    : null;
}

/**
 * May a card be dropped here? One predicate, used by both the ghost ring and
 * the click, so what the ring shows as legal and what actually happens can
 * never disagree.
 * @param {{x: number, z: number}|null} p
 * @returns {boolean}
 */
function legal(p) {
  if (!p) return false;
  if (Math.abs(p.x) > DEPLOY_EDGE) return false;
  if (p.z < DEPLOY_NEAR_Z || p.z > DEPLOY_FAR_Z) return false;
  // The river, straight from the same footprint arena.js drew the water from.
  if (!passable(p.x, p.z)) return false;
  // Not on top of your own king. The tower is a building, not a spawn point.
  if (playerKing && Math.hypot(p.x - playerKing.x, p.z - playerKing.z) < KING_CLEARANCE) return false;
  return true;
}

// -- the ghost ring ---------------------------------------------------------
// Two rings, built once, and the illegal one is simply made visible. Not
// because it is tidy: voxel.js hands out shared cached materials, so recolouring
// a single ring green-to-red would repaint every other object in the game that
// uses that colour. Swapping visibility has no such blast radius.
const GHOST_R = 1.5;
const GHOST_T = 0.24;

function ghostRing(colour) {
  const g = new THREE.Group();
  const span = GHOST_R * 2 + GHOST_T;
  g.add(neonBox(span, 0.1, GHOST_T, colour, { z: -GHOST_R }));
  g.add(neonBox(span, 0.1, GHOST_T, colour, { z: GHOST_R }));
  g.add(neonBox(GHOST_T, 0.1, span, colour, { x: -GHOST_R }));
  g.add(neonBox(GHOST_T, 0.1, span, colour, { x: GHOST_R }));
  return g;
}

const ghost = new THREE.Group();
const ghostOk = ghostRing(PALETTE.hpGreen);
const ghostNo = ghostRing(PALETTE.hpRed);
ghost.add(ghostOk, ghostNo);
ghost.position.y = 0.08;
ghost.visible = false;
scene.add(ghost);

/** The last point the cursor was over, valid or not. */
let hover = null;

function refreshGhost() {
  // The lobby hides the hand, so a ghost ring would be something the player
  // cannot act on - visible while useless is a control that lies.
  if (!matchLive) {
    ghost.visible = false;
    return;
  }
  if (!ui.selected || !hover) {
    ghost.visible = false;
    return;
  }
  ghost.visible = true;
  ghost.position.x = hover.x;
  ghost.position.z = hover.z;
  const ok = legal(hover);
  ghostOk.visible = ok;
  ghostNo.visible = !ok;
}

renderer.domElement.addEventListener('pointermove', (e) => {
  hover = groundAt(e.clientX, e.clientY);
  refreshGhost();
});

renderer.domElement.addEventListener('pointerleave', () => {
  hover = null;
  ghost.visible = false;
});

/**
 * Play the selected card at a screen position.
 * @param {number} clientX
 * @param {number} clientY
 */
function deploy(clientX, clientY) {
  // Not reachable while the lobby is up (the overlay eats the click), but the
  // key path and any probe that drives deploy() directly must not be able to
  // spend elixir on a match that has not started.
  if (!matchLive) return;
  const id = ui.selected;
  if (!id) {
    ui.flashHint('PICK A CARD FIRST');
    audio.play('deny');
    return;
  }

  const p = groundAt(clientX, clientY);
  if (!legal(p)) {
    ui.flashHint('CANNOT DEPLOY THERE');
    audio.play('deny');
    return;
  }

  // Capacity is checked BEFORE the spend, so elixir is only ever taken for a
  // placement that is definitely going to happen.
  let live = 0;
  for (const t of troops.troops) if (!t.dead) live++;
  if (live >= troops.MAX_TROOPS) {
    ui.flashHint('FIELD IS FULL');
    audio.play('deny');
    return;
  }

  // spend() is the same gate the old keydown demo used, and it is still the
  // only thing in the game that can lower the bar.
  if (!ui.spend(ui.costOf(id))) {
    ui.flashHint('NOT ENOUGH ELIXIR');
    audio.play('deny');
    return;
  }

  const card = CHARACTERS.find((c) => c.id === id);
  const t = troops.spawn(card, p.x, p.z, 'player');
  if (!t) {
    // Unreachable given the checks above, so it is reported rather than
    // swallowed. A card that silently cost elixir and produced nothing would
    // be precisely the kind of lie this HUD does not tell.
    console.error('deploy: spawn refused after a successful spend', id, p);
    ui.flashHint('DEPLOY FAILED');
    audio.play('deny');
    return;
  }
  // The two sounds of a card actually arriving: the drop and the body popping
  // in. Spawn is separate so the same cue is reusable by the bot.
  audio.play('place');
  audio.play('spawn');
  // The card is spent, so it is no longer armed.
  ui.select(null);
  ghost.visible = false;
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  deploy(e.clientX, e.clientY);
});

// -- keyboard ---------------------------------------------------------------
// A convenience, not a second control scheme: these call the same ui.select()
// a click does, so there is no way for the mouse path and the key path to
// disagree about what is armed.
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // Number keys are a convenience for choosing a card once the match is live.
  // Before that they would race the lobby, which has its own keys to press.
  if (!matchLive) return;

  if (e.key === 'Escape') {
    if (ui.selected) { ui.select(null); ghost.visible = false; }
    return;
  }

  const n = parseInt(e.key, 10);
  if (!(n >= 1 && n <= 9)) return;
  // Keys address the hand the player is actually holding, not the full nine:
  // a shortcut that arms a card you do not have is a shortcut that lies.
  const deckIds = ui.deck || CHARACTERS.filter((c) => c.unlocked !== false).map((c) => c.id);
  const list = deckIds.map((id) => CHARACTERS.find((c) => c.id === id)).filter(Boolean);
  const card = list[n - 1];
  if (!card) return;
  ui.select(card.id);
  refreshGhost();
});

// -- context loss ------------------------------------------------------------
let contextLost = false;
const notice = document.getElementById('contextLost');
const showNotice = (on) => { if (notice) notice.style.display = on ? 'flex' : 'none'; };

renderer.domElement.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  contextLost = true;
  showNotice(true);
}, false);

renderer.domElement.addEventListener('webglcontextrestored', () => {
  contextLost = false;
  showNotice(false);
}, false);

// -- loop --------------------------------------------------------------------
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  if (contextLost) return;
  const dt = Math.min(clock.getDelta(), MAX_DT);
  arena.update(dt);
  towerKit.update(dt);
  // The board breathes from the first frame (crowd, foam, torn banners), but
  // nothing that costs elixir or spends a troop tick until the lobby hands
  // the match over. This is the single gate; there is no second one to forget.
  if (matchLive) {
    bot.update(dt);
    troops.update(dt);
    ui.update(dt);
  }
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// -- lobby ------------------------------------------------------------------
// The pre-match screen resolves the two things a match needs up front: the
// four cards the player is fighting with, and how hard the rival pushes back.
// onStart runs after the countdown and is the only place matchLive turns true.
function startMatch(difficulty, deck) {
  ui.setDeck(deck);
  bot.setDifficulty(difficulty);
  bot.start();
  matchLive = true;
}

const lobby = createLobby({ audio, onStart: startMatch });

// -- probe bypass -----------------------------------------------------------
// The pre-match lobby exists for a human who needs a beat to choose a deck.
// The probe harnesses that drive this page (shot.mjs, ui-audit.mjs) were built
// for a game that was clickable from the first frame, and they still assume
// that. ?probe=1 replays that assumption: it skips the lobby and starts a
// normal match immediately with the full roster, so an audit can keep driving
// the page without learning what a lobby is. Human-loaded pages never see it.
if (new URLSearchParams(location.search).get('probe') === '1') {
  lobby.hide();
  startMatch('normal', CHARACTERS.filter((c) => c.unlocked !== false).map((c) => c.id));
}

// -- test surface ------------------------------------------------------------
// Test-only: nothing in the game imports this. It exists so the screenshot and
// probe harnesses can put the board into a known state - damaged towers, a
// deployed troop, a spent card - without playing through to get there.
window.__vrScope = null;
try {
  window.__vrScope = {
    __scene: { scene, camera, renderer, ARENA, TOWERS, PALETTE },
    __arena: { arena },
    __towers: towerKit,
    __troops: troops,
    __characters: { CHARACTERS, CAM_ORIGIN },
    __cards: CARDS,
    __ghost: { ghost, ok: ghostOk, no: ghostNo },
    __damage: damageTower,
    __ui: ui,
    // The placement internals, so a probe can assert the legality rules
    // directly as well as driving them through real mouse clicks.
    __deploy: deploy,
    __groundAt: groundAt,
    __legal: legal,
    // The phase-2 additions: sound, the rival, the lobby and the live gate, so
    // a probe can assert the match is frozen pre-start and armed after it.
    __audio: audio,
    __bot: bot,
    __lobby: lobby,
    get __matchLive() { return matchLive; },
  };
} catch (e) {
  window.__vrScopeError = String(e);
  console.error('__vrScope build failed:', e);
}

// Test-only: ?state=damaged puts the enemy side into a known state so a shot can
// prove the HP readout, the glitch tear and the KO treatment without waiting for
// a real push. No game code reads this.
//   Order is [king, small-left, small-right] - three per side, so this plan
//   targets all three. A previous version asked for a 4th tower that does not
//   exist, so the KO step silently did nothing and the shot showed no wreck.
if (new URLSearchParams(location.search).get('state') === 'damaged') {
  const enemy = towerKit.towers.filter((t) => t.side === 'enemy');
  const plan = [
    { pick: 0, amount: 0.45, hold: false },   // king  -> 55% amber
    { pick: 1, amount: 0.78, hold: true },    // left  -> 22% red, tear held
    { pick: 2, amount: 1.0, hold: false },    // right -> KO, wrecked
  ];
  for (const step of plan) {
    const t = enemy[step.pick];
    if (!t) continue;
    damageTower(t, t.maxHp * step.amount);
    if (!t.destroyed && step.hold) t.holdGlitch = true;
  }
  // Report the resulting state so a shot can be checked against numbers
  // instead of squinting at pixels.
  console.log('VRSTATE ' + JSON.stringify(towerKit.towers.map((t) => ({
    side: t.side,
    kind: t.kind,
    hp: Math.round(t.hp),
    maxHp: t.maxHp,
    pct: t.destroyed ? 'KO' : Math.ceil((t.hp / t.maxHp) * 100),
    glitch: Number(t.glitch.toFixed(2)),
    wrecked: !!t.wrecked,
  }))));
  // The probe needs to photograph the damage, which only paints once the match
  // is live and the loop is running HUD updates. The lobby would be in the way
  // of that frame, so a probe load starts the match immediately with the full
  // roster. No game code reads this flag - it is the screenshot harness.
  lobby.hide();
  startMatch('normal', CHARACTERS.filter((c) => c.unlocked !== false).map((c) => c.id));
}

animate();