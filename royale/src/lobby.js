// ── lobby.js ──────────────────────────────────────────────────────────────
// The pre-match screen. It exists because a match that starts the instant the
// page loads gives the player no beat to read the board, and because the one
// decision that actually changes how a match plays - how hard the rival hits
// back - has to be made by the player, not buried in a constant.
//
// It reuses the HUD's own portrait renderer and the same rarity rim language,
// so the deck previewed here is visibly the deck held when the arena comes up.
// The lobby builds DOM into a fixed overlay and reveals the HUD on start; it
// never touches the 3D scene.

import { CHARACTERS } from './characters.js';
import { CARDS, RARITY } from './config.js';
import { renderFaces, FACE_PX } from './ui.js';

// How many cards a deck holds. Four expresses a plan - a tank, two answers, a
// win condition - without asking anyone to study nine stats before their first
// match, which is what makes a lobby get skipped instead of read.
const DECK_SIZE = 4;

const LEVELS = [
  { key: 'easy',   name: 'RECRUIT', blurb: 'slow, sloppy, generous' },
  { key: 'normal', name: 'RIVAL',   blurb: 'answers threats, pushes back' },
  { key: 'hard',   name: 'MARSHAL', blurb: 'fast, precise, relentless' },
];

/**
 * Build the lobby overlay.
 * @param {object} deps
 * @param {object|null} deps.audio createAudio() handle, for cues and the mute
 *   button; a null audio disables the toggle rather than leaving it dead
 * @param {(difficulty: string, deck: string[]) => void} deps.onStart
 *   called once the countdown finishes
 */
export function createLobby({ audio, onStart }) {
  const root = document.getElementById('lobby');
  if (!root) return { hide() {}, show() {}, deck: [], difficulty: 'normal' };

  // Every unlocked fighter is a candidate. A character added with
  // unlocked:false stays in the world (a probe can still spawn it) but is not
  // offered here, which is exactly how the HUD roster treats it.
  const candidates = CHARACTERS.filter((c) => c.unlocked !== false);

  // Default hand is roster order - real, if unromantic, and drawn from the same
  // list the HUD will show, so nothing here is a different cast.
  let deck = candidates.slice(0, DECK_SIZE).map((c) => c.id);
  let difficulty = 'normal';

  const pickHost = document.getElementById('lobbyPick');
  const deckHost = document.getElementById('lobbyDeck');
  const diffHost = document.getElementById('lobbyDiff');
  const startBtn = document.getElementById('lobbyStart');
  const soundBtn = document.getElementById('lobbySound');
  const countEl = document.getElementById('lobbyCount');
  const countNum = document.getElementById('lobbyCountNum');

  /**
   * One card, in the HUD's own language. Faces are collected as they are
   * built and rendered once at the end of the pass, rather than re-queried
   * afterwards - each renderFaces() spins up a WebGL context, so it has to be
   * one call per panel, not one per card.
 * @param {object} c a CHARACTERS entry
 * @param {{selected?: boolean, small?: boolean}} opts
 * @param {Array<{char: object, ctx: CanvasRenderingContext2D}>} faces
 */
  function cardEl(c, opts, faces) {
    const tier = RARITY[c.rarity] || RARITY.common;
    const cost = (CARDS[c.id] || {}).cost;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'lcard' + (opts.small ? ' small' : '') + (opts.selected ? ' on' : '');
    el.style.setProperty('--c', c.color);
    // Same rim rule as the HUD chip: a flat tier colour, or the conic sweep for
    // a legend, which a single hex cannot express.
    el.style.setProperty('--rim', tier.gradient || tier.color);
    el.title = c.name + ' · ' + tier.name + ' · ' + c.role;
    el.innerHTML =
      '<span class="lcard-face"><canvas width="' + FACE_PX + '" height="' + FACE_PX + '"></canvas></span>' +
      '<span class="lcard-name"></span>' +
      '<span class="lcard-role"></span>' +
      '<span class="lcard-cost"></span>';
    el.querySelector('.lcard-name').textContent = c.name;
    el.querySelector('.lcard-role').textContent = c.role.split(' · ')[0];
    el.querySelector('.lcard-cost').textContent = cost == null ? '-' : String(cost);
    // The tier gradient goes on the frame, not the canvas, so the canvas stays
    // transparent and a blank portrait still means the model failed to draw.
    el.querySelector('.lcard-face').style.background = tier.bg;
    faces.push({ char: c, ctx: el.querySelector('canvas').getContext('2d') });
    return el;
  }

  // ── the picker ───────────────────────────────────────────────────────────
  function drawPick() {
    if (!pickHost) return;
    pickHost.innerHTML = '';
    const faces = [];
    for (const c of candidates) {
      const b = cardEl(c, { selected: deck.indexOf(c.id) >= 0 }, faces);
      b.addEventListener('click', () => toggleCard(c.id));
      pickHost.appendChild(b);
    }
    renderFaces(faces);
  }

  function toggleCard(id) {
    const at = deck.indexOf(id);
    if (at >= 0) {
      // Refuse to go under half a deck: a hand that cannot fight is not a
      // choice, it is a broken lobby.
      if (deck.length <= DECK_SIZE / 2) return;
      deck.splice(at, 1);
    } else {
      // Adding past four drops the oldest pick, so the deck is always exactly
      // DECK_SIZE and the start button never depends on an edge case.
      if (deck.length >= DECK_SIZE) deck.shift();
      deck.push(id);
    }
    if (audio) audio.play('card');
    drawPick();
    drawDeck();
  }

  // ── the deck strip: what you are actually taking in ──────────────────────
  function drawDeck() {
    if (!deckHost) return;
    deckHost.innerHTML = '';
    const faces = [];
    for (const id of deck) {
      const c = candidates.find((x) => x.id === id);
      if (!c) continue;
      const el = cardEl(c, { selected: true, small: true }, faces);
      el.classList.add('fixed');
      el.addEventListener('click', () => toggleCard(id));
      deckHost.appendChild(el);
    }
    renderFaces(faces);
  }

  // ── difficulty ───────────────────────────────────────────────────────────
  function drawDiff() {
    if (!diffHost) return;
    diffHost.innerHTML = '';
    for (const lv of LEVELS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ldiff' + (lv.key === difficulty ? ' on' : '');
      b.innerHTML = '<span class="ldiff-name"></span><span class="ldiff-blurb"></span>';
      b.querySelector('.ldiff-name').textContent = lv.name;
      b.querySelector('.ldiff-blurb').textContent = lv.blurb;
      b.addEventListener('click', () => {
        difficulty = lv.key;
        if (audio) audio.play('card');
        drawDiff();
      });
      diffHost.appendChild(b);
    }
  }

  // ── start + countdown ────────────────────────────────────────────────────
  let busy = false;
  function begin() {
    if (busy) return;
    busy = true;
    if (startBtn) startBtn.disabled = true;
    // Three ticks and a GO. The flag is what stops a double-click: the
    // countdown sits on top of the buttons anyway, so this is belt and braces.
    const steps = ['3', '2', '1', 'GO!'];
    let i = 0;
    if (countEl) countEl.classList.add('on');
    const tickOnce = () => {
      if (i >= steps.length) {
        if (countEl) countEl.classList.remove('on');
        hide();
        if (audio) audio.setMusic(true);
        if (onStart) onStart(difficulty, deck.slice());
        busy = false;
        return;
      }
      if (countNum) countNum.textContent = steps[i];
      if (audio) audio.play(i < 3 ? 'tick' : 'go');
      i++;
      setTimeout(tickOnce, i <= 3 ? 620 : 400);
    };
    tickOnce();
  }

  if (startBtn) startBtn.addEventListener('click', begin);

  // ── sound toggle ─────────────────────────────────────────────────────────
  if (soundBtn) {
    const paint = () => {
      const off = audio ? audio.muted : true;
      soundBtn.textContent = off ? 'SOUND OFF' : 'SOUND ON';
      soundBtn.classList.toggle('off', off);
    };
    if (audio) {
      soundBtn.addEventListener('click', () => {
        // The first click anywhere is a valid gesture for the AudioContext, so
        // this doubles as the unlock if the player goes straight for sound.
        audio.unlock();
        audio.setMuted(!audio.muted);
        if (!audio.muted) audio.play('card');
        paint();
      });
    } else {
      soundBtn.disabled = true;
    }
    paint();
  }

  drawPick();
  drawDeck();
  drawDiff();
  // The markup carries the .on class so the panel is there on the first paint
  // with no flash of HUD-only frame, but the body flag body.lobbying hides the
  // hand beneath it - and that flag is not in the static markup, so it is
  // asserted here where the two states live together.
  show();

  function hide() {
    root.classList.remove('on');
    document.body.classList.remove('lobbying');
  }
  function show() {
    root.classList.add('on');
    document.body.classList.add('lobbying');
  }

  return {
    hide,
    show,
    get deck() { return deck.slice(); },
    get difficulty() { return difficulty; },
  };
}