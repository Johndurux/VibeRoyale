// -- main.js ----------------------------------------------------------------
// Boot. Wires the modules together and starts the render loop. Deliberately
// thin: the game rules live in the modules, not here.

import { renderer, scene, camera, CAM_ORIGIN, updateSky, setSkyMood, resetSky } from './scene.js';
import { buildArena } from './arena.js';
import { buildTowers, damageTower, setHitListener, setWreckListener } from './towers.js';
import { createMatch } from './match.js';
import { buildSpells } from './spells.js';
import { createVfx } from './vfx.js';
import * as progression from './progression.js';
import { buildTroops, passable } from './troops.js';
import { CHARACTERS } from './characters.js';
import { createUI } from './ui.js';
import { createAudio } from './audio.js';
import { createBot } from './bot.js';
import { createLobby, DECK_KEY } from './lobby.js';
import { createMenu } from './menu.js';
import { ARENA, TOWERS, PALETTE, CARDS, SPELLS, FEATURES, STAGES } from './config.js';
import { neonBox } from './voxel.js';
import * as THREE from 'three';

// Clamp the simulation step so a throttled tab cannot teleport anything on
// the first frame back from a multi-second delta.
const MAX_DT = 0.05;

// -- camera shake ------------------------------------------------------------
// Decaying, seeded from the clock rather than random, so it is smooth at any
// frame rate and reproducible when a probe wants a screenshot of the peak.
let shakeAmp = 0;
let shakeT = 0;
let shakeDur = 0.001;
let camHome = null;

/**
 * Kick the camera. A new kick replaces an in-flight one rather than adding to
 * it, so a double KO does not launch the camera into orbit.
 * @param {number} amp world units at full strength
 * @param {number} dur seconds to decay to zero
 */
function shake(amp, dur) {
  shakeAmp = Math.max(shakeAmp, amp);
  shakeT = 0;
  shakeDur = Math.max(dur, 0.001);
}

/**
 * Apply the shake offset to the camera, on top of its home position.
 * @param {number} dt
 */
function updateShake(dt) {
  if (!camHome) {
    camHome = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
  }
  if (shakeAmp > 0.0005) {
    shakeT += dt;
    const k = Math.max(0, 1 - shakeT / shakeDur);
    // Square the falloff: a linear decay spends most of its time barely moving
    // and then stops, which reads as a jolt that never quite arrived.
    const a = shakeAmp * k * k;
    // Two incommensurate frequencies, so the motion never visibly repeats.
    camera.position.x = camHome.x + Math.sin(shakeT * 61) * a;
    camera.position.y = camHome.y + Math.sin(shakeT * 47) * a * 0.8;
    camera.position.z = camHome.z + Math.sin(shakeT * 73) * a * 0.35;
    if (k <= 0) shakeAmp = 0;
  } else {
    camera.position.set(camHome.x, camHome.y, camHome.z);
    camera.lookAt(CAM_ORIGIN.lookX, CAM_ORIGIN.lookY, CAM_ORIGIN.lookZ);
  }
}

const arena = buildArena();
const towerKit = buildTowers();
scene.add(arena.root, towerKit.root);

// Effects share the one scene graph. They are updated every frame whether or
// not the match is live, so a collapse still finishes animating after the
// result screen comes up - a tower that stops mid-fall because the match
// ended is the game losing track of its own state.
const vfx = createVfx();
scene.add(vfx.root);

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

// -- match bookkeeping ----------------------------------------------------------
// Per-match counters, reset in startMatch so a second match on the same page
// starts from zero. Leaving them accumulating is how the result screen ends up
// showing the sum of three matches.
//
// Declared here, above the HUD, and not down with the other bookkeeping: the
// HUD's onResult hook can reach endMatch(), and endMatch() reads all of these.
// A `let` below this point would still be in its temporal dead zone during the
// first paint, so the very first result of a match would throw a
// ReferenceError instead of ending the match.
let damageDealtThisMatch = 0;
let spellsCastThisMatch = 0;
let elixirSpentThisMatch = 0;
// The stage currently being played, set by startMatch from the STAGES table.
// endMatch books progression against it and PLAY AGAIN replays it.
let currentStage = 1;
// True while a QUICK BATTLE from the main menu is running: the fight is real
// (the rival uses a stage's knobs) but the campaign is not booked - a quick
// win banks match XP and streak, never a stage clear.
let casual = false;
// The single settlement guard. A king falling and the clock running out both
// route through matchClock.settle(), but endMatch() is also reachable from the
// HUD, so the gate lives at the one function that closes the match.
let settled = false;
let lastResult = null;

// Mounted after the towers exist: the HUD binds to towerKit.towers, so it has
// to be created once there is real HP to read. The two callbacks are how the
// HUD reports a card being armed and a match being decided without owning an
// audio handle or knowing what a bot is.
const ui = createUI({
  towerKit,
  camera,
  onCardPick: () => audio.play('card'),
  onResult: () => {
    // The UI reporting that it drew its panel. Settlement has already happened
    // in endMatch(); this is here only so the HUD can say so without owning
    // match state. Deliberately does not stop the bot or play a cue.
  },
  onMenu: () => quitToLobby(),
});

// Every tower hit raises a damage number at the tower that took it, and says
// so out loud. A king hit gets its own heavier cue - it is the sound of the
// one tower whose loss ends the match.
if (FEATURES.towerShatter) {
  setWreckListener((tower) => {
    vfx.rubble(tower.x, tower.z, PALETTE.stone);
    if (FEATURES.screenShake) {
      // A king is taller and its fall is the end of the match, so it hits
      // harder and longer. Scaled by kind rather than by a flat number so the
      // two do not read as the same event.
      const big = tower.kind === 'king';
      shake(big ? 0.85 : 0.4, big ? 0.75 : 0.45);
    }
  });
}

setHitListener((tower, amount, ko) => {
  ui.popDamage(tower, amount, ko);
  if (tower.side === 'enemy') damageDealtThisMatch += amount;
  if (vfx && vfx.hitSparks) {
    vfx.hitSparks(tower.x, 2.6, tower.z, 0xffbb33);
  }
  if (FEATURES.screenShake && !ko && tower.kind === 'king') {
    shake(0.12, 0.15);
  }
  if (ko) {
    audio.play('ko');
    if (tower.kind === 'king') {
      // The one thing that ends a match before the clock does. Routed through
      // matchClock so the knockout and the timeout share one guard, and so a
      // king that falls in overtime is recorded as an overtime result.
      matchClock.settle(tower.side === 'player' ? 'enemy' : 'player', 'king');
    }
  } else {
    audio.play(tower.kind === 'king' ? 'king' : 'towerHit');
  }
});

// -- the clock --------------------------------------------------------------
// Tracks regulation, overtime and sudden death. start() is called from
// startMatch(); stop() parks it when the result screen is up.
const matchClock = createMatch({
  towers: towerKit.towers,
  onTick: (info) => {
    // The HUD reads the clock every frame, so this is a cheap push of two
    // numbers. Phase is passed because the timer pill changes colour and
    // gains the OT badge, and it has to be told rather than guess.
    //
    // Guarded because the timer pill is the UI pass's markup. Until it
    // exists the clock still runs and overtime still fires; it just is not
    // drawn yet.
    if (ui.setTimer) ui.setTimer(info.seconds, info.phase);
  },
  onOvertime: () => {
    if (FEATURES.dynamicSky) setSkyMood('storm');
    if (FEATURES.lobbyMusic) audio.setScene('overtime');
    audio.play('overtime');
    if (FEATURES.haptics) buzz([30, 40, 30]);
    if (ui.flashOvertime) ui.flashOvertime();
  },
  onEnd: (result) => {
    // Reached only through settle(), so no double-fire is possible here.
    endMatch(result);
  },
});

// Troops come after the UI, because a troop landing a hit needs popDamageAt()
// to throw a number at whatever it hit - and troop-on-troop damage has no
// tower for the tower listener to hang off.
const troops = buildTroops({
  towers: towerKit.towers,
  vfx,
  audio,
  onHit: (troop, amount) => {
    ui.popDamageAt(troop.x, 2.8, troop.z, amount, false);
    audio.play('hit');
  },
  onTowerHit: (troop, tower) => {
    if (FEATURES.screenShake && troop.card && troop.card.id === 'armor') {
      shake(0.08, 0.12);
    }
  },
});
scene.add(troops.root);

// -- haptics ---------------------------------------------------------------------
/**
 * Buzz, if this device has a vibrator. No-op everywhere else.
 * @param {number|number[]} pattern
 */
function buzz(pattern) {
  if (!FEATURES.haptics) return;
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch (e) {
    // Unsupported here. Nothing to report.
  }
}

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

/**
 * May a spell card be dropped here?
 * Allows deployment across the entire arena footprint including enemy side and rivers.
 * @param {{x: number, z: number}|null} p
 * @returns {boolean}
 */
function legalSpell(p) {
  if (!p) return false;
  return Math.abs(p.x) <= DEPLOY_EDGE && Math.abs(p.z) <= DEPLOY_FAR_Z;
}

/**
 * Check legality based on card type (troop vs spell).
 * @param {string|null} cardId
 * @param {{x: number, z: number}|null} p
 * @returns {boolean}
 */
function legalForCard(cardId, p) {
  if (!p) return false;
  const card = CHARACTERS.find((c) => c.id === cardId);
  return (card && card.spell) ? legalSpell(p) : legal(p);
}

// -- spells ----------------------------------------------------------------------
const spells = buildSpells({
  towers: towerKit.towers,
  troops,
  vfx,
  onCast: (kind) => {
    audio.play('spell');
    if (FEATURES.haptics) buzz(kind === 'blast' ? 22 : 10);
  },
  onImpact: (kind, x, z) => {
    if (FEATURES.screenShake && kind === 'blast') shake(0.18, 0.22);
    if (kind === 'blast') audio.play('towerHit');
  },
  onHit: (target, amount) => {
    // Raised through the same damage-number path as a melee hit, so a tower
    // that dies to a fireball prints KO exactly like one finished by troops.
    ui.popDamage(target, amount, false);
  },
});

// -- the rival --------------------------------------------------------------
// Built now, armed later. The bot shares troops.js and the same 28-slot
// capacity the player is spending, so it is on exactly the same rules.
const bot = createBot({
  troops,
  towers: towerKit.towers,
  spells,
  difficulty: 'normal',
  // The rival's plays are audible so the player can read a counter from sound
  // alone when the far bank is off screen.
  onDeploy: () => audio.play('enemyPlace'),
});

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
  const ok = legalForCard(ui.selected, hover);
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

  const card = CHARACTERS.find((c) => c.id === id);
  const p = groundAt(clientX, clientY);
  const isAllowed = card && card.spell ? legalSpell(p) : legal(p);
  if (!isAllowed) {
    ui.flashHint('CANNOT DEPLOY THERE');
    audio.play('deny');
    return;
  }

  // A spell card has no unit to spawn, so the troop path is skipped entirely
  // rather than half-run. Dispatching on the card's own `spell` field keeps
  // characters.js the single source of truth for what a card is.
  //
  // This branch runs BEFORE the capacity check on purpose. Capacity counts
  // live troops and casting a spell adds none, so a field already at the cap
  // must still be able to throw a fireball. Otherwise the player is holding
  // the card, has the elixir, taps a legal spot, and nothing happens.
  if (card.spell) {
    const res = spells.cast(card.spell, p.x, p.z, 'player');
    if (!res) {
      ui.flashHint('SPELL UNAVAILABLE');
      audio.play('deny');
      return;
    }
    // Charged here, after the cast resolved, so a spell that could not
    // resolve never costs anything. The shared spend further down sits behind
    // the troop capacity gate, which a spell must not be subject to.
    if (!ui.spend(ui.costOf(id))) {
      ui.flashHint('NOT ENOUGH ELIXIR');
      audio.play('deny');
      return;
    }
    spellsCastThisMatch++;
    elixirSpentThisMatch += ui.costOf(id);
    audio.play('place');
    ui.select(null);
    ghost.visible = false;
    return;
  }

  // Capacity is checked BEFORE the spend, so elixir is only ever taken for a
  // placement that is definitely going to happen.
  let live = 0;
  for (const tr of troops.troops) if (!tr.dead) live++;
  if (live >= troops.MAX_TROOPS) {
    ui.flashHint('FIELD IS FULL');
    audio.play('deny');
    return;
  }

  // spend() is the only thing in the game that can lower the bar.
  if (!ui.spend(ui.costOf(id))) {
    ui.flashHint('NOT ENOUGH ELIXIR');
    audio.play('deny');
    return;
  }
  // Counted the moment the elixir actually leaves the bar, so the end-of-match
  // stat cannot under-report what a troop deploy really cost.
  elixirSpentThisMatch += ui.costOf(id);

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
  if (FEATURES.deployVfx) vfx.deployBurst(p.x, p.z, 'player');
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

let ctxTimer = null;

renderer.domElement.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  contextLost = true;
  showNotice(true);
  
  if (ctxTimer) clearTimeout(ctxTimer);
  ctxTimer = setTimeout(() => {
    if (contextLost && notice) {
      const title = notice.querySelector('.ctx-title');
      if (title) title.textContent = 'GPU DISCONNECTED';
      const body = notice.querySelector('.ctx-body');
      if (body) body.innerHTML = 'Graphics context could not be restored automatically.<br><br><button onclick="location.reload()" style="margin-top:15px; padding:10px 24px; font-family:var(--font-num); font-size:16px; cursor:pointer; background:#2A6A14; color:#FFF3CE; border:3px solid #14100C; border-radius:8px;">RELOAD PAGE</button>';
    }
  }, 5000);
}, false);

renderer.domElement.addEventListener('webglcontextrestored', () => {
  contextLost = false;
  if (ctxTimer) clearTimeout(ctxTimer);
  showNotice(false);
  
  const title = notice?.querySelector('.ctx-title');
  if (title) title.textContent = 'RECONNECTING GPU';
  const body = notice?.querySelector('.ctx-body');
  if (body) body.textContent = 'Graphics context lost. Execution resumes automatically.';
}, false);

// -- loop --------------------------------------------------------------------
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  if (contextLost) return;
  const dt = Math.min(clock.getDelta(), MAX_DT);
  arena.update(dt);
  // The board breathes from the first frame (crowd, foam, torn banners), but
  // nothing that costs elixir or spends a troop tick until the lobby hands
  // the match over. This is the single gate; there is no second one to forget.
  if (matchLive) {
    matchClock.update(dt);
    bot.update(dt);
    troops.update(dt);
    ui.update(dt);
    const selCard = ui.selected ? CHARACTERS.find((c) => c.id === ui.selected) : null;
    vfx.setDeployZone(!!(selCard && !selCard.spell));
  } else {
    vfx.setDeployZone(false);
  }

  // Outside the gate on purpose - see above.
  towerKit.update(dt, matchLive ? {
    troops,
    vfx,
    audio,
    onHit: (t, amount) => {
      ui.popDamageAt(t.x, 2.8, t.z, amount, false);
      audio.play('hit');
    },
  } : null);
  vfx.update(dt);
  updateShake(dt);
  if (FEATURES.dynamicSky) updateSky(dt);

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
// The counters themselves are declared next to the HUD, because the HUD's
// onResult hook can reach endMatch() and endMatch() reads them.

function towersLostToPlayer() {
  return towerKit.towers.filter((t) => t.side === 'enemy' && t.destroyed).length;
}

/**
 * Close the match out: stop the sim, bank the career numbers, show the result.
 *
 * Progression is recorded here and nowhere else, so a match abandoned by
 * closing the tab mid-play banks nothing - which is the intended reading of
 * "XP for a match you finished".
 *
 * @param {{winner:'player'|'enemy'|'draw', reason:string, overtime:boolean}} result
 */
function endMatch(result) {
  if (settled) return;
  settled = true;
  lastResult = result;
  matchLive = false;
  matchClock.stop();
  bot.stop();
  audio.setMusic(false);
  if (FEATURES.dynamicSky) resetSky();

  const won = result.winner === 'player';
  // recordMatch returns what the match was worth: the XP total, the stage it
  // cleared, the level it landed on, the streak tier and the cards it opened.
  // It is booked exactly once, here, and only on a match that reached a result.
  const banked = progression.recordMatch({
    won,
    // A casual match books against stage 0: STAGES has no row there, so the
    // clear and its bonus are structurally unreachable while wins, streaks
    // and match XP still bank. Practice pays; it cannot advance the campaign.
    stage: casual ? 0 : currentStage,
    difficulty: bot.difficulty,
    towersDestroyed: towersLostToPlayer(),
    damageDealt: damageDealtThisMatch,
  });
  const after = progression.snapshot();

  audio.play(won ? 'victory' : 'defeat');
  if (FEATURES.haptics) buzz(won ? [40, 60, 80] : [80, 60, 40]);

  // The stat block is assembled here and stashed on the result object. The rich
  // panel is the UI pass's job; until it exists, the numbers are still real and
  // reachable from the test surface, so the sim half of this feature is not
  // sitting on a placeholder.
  lastResult = {
    ...result,
    // A casual result carries no stage number, so the ribbon reads the plain
    // "rival king tower down" line instead of claiming a stage clear.
    stage: casual ? null : currentStage,
    stageCleared: banked.stageCleared,
    duration: matchClock.elapsed,
    progress: after,
    // Taken from the booking rather than recomputed: newlyUnlocked() wants
    // stage numbers, not the snapshots they came from, and passing the
    // snapshots silently produced an empty list every single match.
    unlocked: banked.unlocked,
    // What the match earned, not what the career totals to. The panel shows
    // "this game" and "career" as separate lines, and these are the first.
    xp: banked.total,
    xpBreakdown: {
      base: banked.base,
      towers: banked.towerBonus,
      streak: banked.streakBonus,
      stage: banked.stageBonus,
    },
    tier: banked.tier,
    leveledUp: banked.leveledUp,
    stats: {
      towersDestroyed: towersLostToPlayer(),
      damageDealt: Math.round(damageDealtThisMatch),
      elixirSpent: elixirSpentThisMatch,
      spellsCast: spellsCastThisMatch,
    },
    // Both buttons resolve here, on the payload, so the result screen never
    // has to know how a match is rebuilt. A won stage with a next one offers
    // NEXT STAGE (the campaign run continues without a lobby detour); PLAY
    // AGAIN replays this stage (a failed stage is a retry, stage 15 is the
    // end of the line); CHANGE DECK hands control back to the lobby, which is
    // the only place a deck can be edited.
    onPlayAgain: () => startMatch(currentStage, ui.deck || lobby.deck, { casual }),
    onNextStage: !casual && currentStage < STAGES.length
      ? () => startMatch(currentStage + 1, ui.deck || lobby.deck)
      : null,
    onChangeDeck: () => {
      // The match is already stopped by the time this runs, so all that is
      // left is to put the player back in front of the deck picker. The board
      // stays on its final state behind the lobby rather than being rebuilt -
      // the result screen is the last thing they should have to look at.
      if (ui.reset) ui.reset();
      audio.setMusic(false);
      lobby.show();
    },
  };

  // showResultPanel is added by the UI pass. Guarded so the sim half lands and
  // runs on its own; the old two-argument call keeps the existing ribbon.
  if (ui.showResultPanel) ui.showResultPanel(lastResult);
  else if (ui.showResult) ui.showResult(won, result.reason);
}

/**
 * Leave a live match for the lobby (the MENU button), without settling it.
 *
 * An abandoned match banks nothing - the same rule as closing the tab, so
 * quitting to dodge a loss never pays. The board keeps its state behind the
 * lobby rather than being rebuilt; the next BATTLE rebuilds everything from
 * scratch the way any match start does. Nothing here advances or records the
 * campaign: only endMatch() books progression.
 */
function quitToLobby() {
  if (settled) return; // the result screen owns the flow once settled
  matchLive = false;
  matchClock.stop();
  bot.stop();
  audio.setMusic(false);
  if (FEATURES.dynamicSky) resetSky();
  if (ui.reset) ui.reset();
  refreshGhost();
  lobby.show();
}

/**
 * @param {number} stage 1-based row of the STAGES table
 * @param {string[]} deck the four cards to fight with
 * @param {{casual?: boolean}} [opts] casual = a QUICK BATTLE: no stage badge,
 *   no campaign booking, no NEXT STAGE offer
 */
function startMatch(stage, deck, opts = {}) {
  // Every per-match counter and every animation resets here, not in the UI
  // constructor. This is the whole reason play-again works without a reload.
  damageDealtThisMatch = 0;
  spellsCastThisMatch = 0;
  elixirSpentThisMatch = 0;
  settled = false;
  lastResult = null;
  casual = !!opts.casual;
  camHome = null;
  shakeAmp = 0;

  // The stage is the difficulty: one row of the STAGES table picks the rival's
  // behaviour tier, its elixir income, and how strong its troops and towers
  // are. Clamped so a stale save or a probe cannot walk the table off its end.
  const cfg = STAGES[Math.max(0, Math.min(STAGES.length, stage) - 1)] || STAGES[0];
  currentStage = cfg.stage;

  ui.setDeck(deck);
  // The HUD's own per-match state - the selected card, the elixir-leak timer,
  // any result overlay - is cleared here rather than reloaded, so a second
  // match starts from the same state the first one did.
  if (ui.reset) ui.reset();
  // The stage badge is a campaign claim; a quick battle wears none.
  ui.setStage(casual ? 0 : currentStage);
  // One call arms the whole rival: behaviour knobs, elixir income, and the
  // hand mirror for this stage.
  bot.setStage(cfg);
  troops.setEnemyMods({ hp: cfg.troopHp, dps: cfg.troopDps });
  bot.start();
  // Order matters: the board is rebuilt and the clock armed before the loop is
  // allowed to run, so the first live frame already sees a consistent world.
  towerKit.reset();
  // After the rebuild: scale the rival's towers from their unscaled base. On
  // every match, from base - so the multiplier never compounds across rematches.
  towerKit.setSideHpScale('enemy', cfg.towerHp);
  troops.clear();
  matchClock.start();
  if (FEATURES.dynamicSky) setSkyMood('day');
  if (FEATURES.lobbyMusic) {
    audio.setScene('battle');
    audio.setMusic(true);
  }
  matchLive = true;
}

const lobby = createLobby({
  audio,
  onStart: startMatch,
  // The lobby's MENU button steps back out to the front door.
  onMenu: () => menu.show(),
});

const menu = createMenu({
  audio,
  onContinue: () => {
    menu.hide();
    lobby.show();
  },
  onQuick: () => {
    // A quick battle spars against the next uncleared stage's rival: real
    // resistance, but flagged casual so nothing books as a stage clear.
    menu.hide();
    startMatch(Math.min(1 + progression.snapshot().stage, STAGES.length), lobby.deck, { casual: true });
  },
  onNew: () => {
    // The wipe is total: the career record and the saved deck both go, then
    // the menu repaints to a virgin career. The lobby re-reads its deck on
    // every show(), so the wipe lands without a page reload.
    progression.reset();
    try {
      localStorage.removeItem(DECK_KEY);
    } catch (e) {
      // A blocked store has nothing to remove; the in-memory reset already
      // happened.
    }
    menu.show();
  },
});

// The front door. The lobby no longer self-presents on construction; a fresh
// load lands on the menu.
menu.show();

// -- probe bypass -----------------------------------------------------------
// The pre-match lobby exists for a human who needs a beat to choose a deck.
// The probe harnesses that drive this page (shot.mjs, ui-audit.mjs) were built
// for a game that was clickable from the first frame, and they still assume
// that. ?probe=1 replays that assumption: it skips the lobby and starts a
// normal match immediately with the full roster, so an audit can keep driving
// the page without learning what a lobby is. Human-loaded pages never see it.
// Dev-only, and origin-gated: DEV is true only on a local origin, so a deployed
// host (viberoyale.vercel.app or any other) reads every probe flag below as
// inert. The harnesses keep working because they run against localhost, which
// is exactly where this is true.
const DEV = /^(localhost|127\.0\.0\.1|\[::1\]|::1|0\.0\.0\.0)$/i.test(location.hostname);
const qs = new URLSearchParams(location.search);

if (DEV && qs.get('probe') === '1') {
  menu.hide();
  lobby.hide();
  startMatch(1, CHARACTERS.map((c) => c.id));
}

// -- test surface ------------------------------------------------------------
// Test-only: nothing in the game imports this. It exists so the screenshot and
// probe harnesses can put the board into a known state - damaged towers, a
// deployed troop, a spent card - without playing through to get there.
window.__vrScope = null;
try {
  // DEV-gated like the probe flags: off a local origin this stays null, so a
  // deployed page never publishes the test surface to any script on the origin.
  if (DEV) window.__vrScope = {
    __scene: { scene, camera, renderer, ARENA, TOWERS, PALETTE },
    __arena: { arena },
    __towers: towerKit,
    __troops: troops,
    __passable: passable,
    __characters: { CHARACTERS, CAM_ORIGIN },
    __cards: CARDS,
    __stages: STAGES,
    __ghost: { ghost, ok: ghostOk, no: ghostNo },
    __damage: damageTower,
    __ui: ui,
    // The placement internals, so a probe can assert the legality rules
    // directly as well as driving them through real mouse clicks.
    __deploy: deploy,
    __groundAt: groundAt,
    __legal: legal,
    __legalSpell: legalSpell,
    __legalForCard: legalForCard,
    // The phase-2 additions: sound, the rival, the lobby and the live gate, so
    // a probe can assert the match is frozen pre-start and armed after it.
    __audio: audio,
    __bot: bot,
    __lobby: lobby,
    __match: matchClock,
    __spells: spells,
    __vfx: vfx,
    __progress: progression,
    __shake: shake,
    get __matchLive() { return matchLive; },
    get __settled() { return settled; },
    get __result() { return lastResult; },
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
if (DEV && qs.get('state') === 'damaged') {
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
  menu.hide();
  lobby.hide();
  startMatch('normal', CHARACTERS.filter((c) => c.unlocked !== false).map((c) => c.id));
}

animate();