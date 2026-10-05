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
import { CARDS, SPELLS, RARITY } from './config.js';
import { renderFaces, FACE_PX } from './ui.js';
import { isUnlocked, unlockLevelFor, snapshot } from './progression.js';

// How many cards a deck holds. Four expresses a plan - a tank, two answers, a
// win condition - without asking anyone to study nine stats before their first
// match, which is what makes a lobby get skipped instead of read.
const DECK_SIZE = 4;

// The chosen deck survives a reload. A deck is a decision the player has
// already made, and silently re-picking the same four on every visit is the
// lobby telling them the choice did not matter. It is stored under its own key
// and re-validated against the unlock ladder on load, so a deck saved before a
// reset cannot smuggle a now-locked card back in.
const DECK_KEY = 'viberoyale.deck';

/**
 * Read the saved deck, keeping only ids that are playable right now.
 * Anything unparseable, unknown, duplicated or locked is dropped, and a save
 * that yields too few cards to form a hand is reported as null so the caller
 * can fall back to the default four.
 * @returns {string[]|null}
 */
function loadDeck() {
  try {
    const raw = localStorage.getItem(DECK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const seen = new Set();
    const ids = [];
    for (const id of parsed) {
      if (typeof id !== 'string' || seen.has(id)) continue;
      if (!CHARACTERS.some((c) => c.id === id && c.unlocked !== false)) continue;
      if (!isUnlocked(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids.length >= 2 ? ids : null;
  } catch (e) {
    // A corrupt or blocked save is not worth failing the lobby over.
    return null;
  }
}

/** Mirror the deck to storage. Never throws, never blocks the game. */
function saveDeck(ids) {
  try {
    localStorage.setItem(DECK_KEY, JSON.stringify(ids));
  } catch (e) {
    // Private browsing or a full quota. The match still gets the deck.
  }
}

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
  // A saved deck wins over the default hand, but only after loadDeck() has
  // checked every id against the ladder. Anything it rejects is simply absent,
  // and the fill below tops the hand back up to DECK_SIZE with unlocked cards.
  let deck = loadDeck() || [];
  for (const c of candidates) {
    if (deck.length >= DECK_SIZE) break;
    if (!deck.includes(c.id) && isUnlocked(c.id)) deck.push(c.id);
  }
  deck = deck.slice(0, DECK_SIZE);
  // The level the career is sitting at. Read live rather than captured once,
  // because show() re-runs the card pass after a match may have banked a
  // level-up - a card that opened during that match has to lose its padlock
  // on the way back in, not on the next reload.
  const careerLevel = () => snapshot().level;
  let difficulty = 'normal';

  const pickHost = document.getElementById('lobbyPick');
  const deckHost = document.getElementById('lobbyDeck');
  const diffHost = document.getElementById('lobbyDiff');
  const startBtn = document.getElementById('lobbyStart');
  const soundBtn = document.getElementById('lobbySound');
  const countEl = document.getElementById('lobbyCount');
  const countNum = document.getElementById('lobbyCountNum');
  const lvlNum = document.getElementById('lvLevelNum');
  const barFill = document.getElementById('lvBarFill');
  const xpNum = document.getElementById('lvXpNum');
  const recNum = document.getElementById('lvRecord');
  const streakEl = document.getElementById('lvStreak');
  const streakNum = document.getElementById('lvStreakNum');
  const tierEl = document.getElementById('lvTier');

  /**
   * Paint the career strip from progression.snapshot(). The bar's width is the
   * same levelProgress the result screen uses, so a level-up seen here and a
   * level-up seen there are one event, not two opinions. The tier classes drive
   * the flame's colour, and an empty tier means a cold flame rather than a
   * hidden one - the absence of a streak should be visible as "none", not as
   * a gap in the layout.
   */
  function drawCareer() {
    const s = snapshot();
    if (lvlNum) lvlNum.textContent = String(s.level);
    if (barFill) barFill.style.width = (s.levelProgress * 100).toFixed(1) + '%';
    if (xpNum) xpNum.textContent = s.xp + ' XP';
    if (recNum) recNum.textContent = s.wins + 'W · ' + s.losses + 'L';
    if (streakNum) streakNum.textContent = String(s.streak);
    if (tierEl) {
      tierEl.textContent = s.tier === 'onfire' ? 'ON FIRE' : s.tier === 'hot' ? 'HOT' : '';
    }
    if (streakEl) {
      streakEl.classList.toggle('hot', s.tier === 'hot' || s.tier === 'onfire');
      streakEl.classList.toggle('onfire', s.tier === 'onfire');
    }
  }

  const tooltipEl = document.getElementById('cardTooltip');

  function showTooltip(c, targetEl) {
    if (!tooltipEl || !targetEl || typeof targetEl.getBoundingClientRect !== 'function') return;
    const isSpell = !!c.spell;
    const s = CARDS[c.id] || {};
    const sp = c.spell ? SPELLS[c.spell] : null;

    let statsHtml = '';
    if (isSpell && sp) {
      if (sp.kind === 'blast') {
        statsHtml = `<span><b>DMG</b>${sp.amount}</span><span><b>AREA</b>${sp.radius}m</span>`;
      } else if (sp.kind === 'freeze') {
        statsHtml = `<span><b>STUN</b>${sp.duration}s</span><span><b>AREA</b>${sp.radius}m</span>`;
      } else if (sp.kind === 'heal') {
        statsHtml = `<span><b>HEAL</b>+${Math.round(sp.amount * 100)}%</span><span><b>AREA</b>${sp.radius}m</span>`;
      }
    } else {
      const rangeText = s.range < 1.5 ? 'Melee' : `${s.range}m`;
      statsHtml = `
        <span><b>HP</b>${s.hp || '-'}</span>
        <span><b>DPS</b>${s.dps || '-'}</span>
        <span><b>SPD</b>${s.speed || '-'}</span>
        <span><b>RNG</b>${rangeText}</span>
      `;
    }

    tooltipEl.innerHTML = `
      <div class="tt-head">
        <span class="tt-name">${c.name}</span>
        <span class="tt-type ${isSpell ? 'spell' : ''}">${isSpell ? 'SPELL' : 'TROOP'}</span>
      </div>
      <div class="tt-stats">${statsHtml}</div>
      <div class="tt-desc">${c.role || ''}</div>
    `;

    const rect = targetEl.getBoundingClientRect();
    tooltipEl.style.left = (rect.left + rect.width / 2) + 'px';
    tooltipEl.style.top = rect.top + 'px';
    tooltipEl.classList.add('on');
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.classList.remove('on');
  }

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
    const locked = !isUnlocked(c.id);
    const fresh = unlockLevelFor(c.id) === careerLevel();
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'lcard' + (opts.small ? ' small' : '') + (opts.selected ? ' on' : '') +
      (locked ? ' locked' : '') + (fresh ? ' fresh' : '');
    if (locked) el.disabled = true;
    el.style.setProperty('--c', c.color);
    // Same rim rule as the HUD chip: a flat tier colour, or the conic sweep for
    // a legend, which a single hex cannot express.
    el.style.setProperty('--rim', tier.gradient || tier.color);
    el.title = c.name + ' · ' + tier.name + ' · ' + c.role;
    el.innerHTML =
      '<span class="lcard-face"><canvas width="' + FACE_PX + '" height="' + FACE_PX + '"></canvas></span>' +
      '<span class="lcard-name"></span>' +
      '<span class="lcard-role"></span>' +
      '<span class="lcard-cost"></span>' +
      // The badge names the level that opens the card rather than saying
      // "locked", because the number is the reason to play another match.
      (locked ? '<span class="lcard-lock"><b>&#128274;</b>LVL ' + unlockLevelFor(c.id) + '</span>' : '') +
      (fresh ? '<span class="lcard-new">NEW!</span>' : '');
    el.querySelector('.lcard-name').textContent = c.name;
    el.querySelector('.lcard-role').textContent = c.role.split(' · ')[0];
    el.querySelector('.lcard-cost').textContent = cost == null ? '-' : String(cost);
    // The tier gradient goes on the frame, not the canvas, so the canvas stays
    // transparent and a blank portrait still means the model failed to draw.
    el.querySelector('.lcard-face').style.background = tier.bg;
    faces.push({ char: c, ctx: el.querySelector('canvas').getContext('2d') });

    el.addEventListener('pointerenter', () => showTooltip(c, el));
    el.addEventListener('pointerleave', hideTooltip);
    el.addEventListener('focus', () => showTooltip(c, el));
    el.addEventListener('blur', hideTooltip);

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

  function updateDeckValidation() {
    const valid = deck.length === DECK_SIZE;
    if (startBtn && !busy) {
      startBtn.disabled = !valid;
    }
    const hintEl = root.querySelector('.lv-hint') || document.querySelector('.lv-hint');
    if (hintEl) {
      if (!valid) {
        const needed = DECK_SIZE - deck.length;
        hintEl.textContent = 'CHOOSE ' + needed + ' MORE CARD' + (needed > 1 ? 'S' : '') + ' (4 REQUIRED)';
        hintEl.style.color = '#D21E1E';
      } else {
        hintEl.textContent = '3 · 2 · 1 · GO';
        hintEl.style.color = '#7A5A28';
      }
    }
  }

  function toggleCard(id) {
    // The button is already disabled, but a click can still arrive from a
    // keyboard or a stale handler on a re-rendered node, and a locked card in
    // the deck would be a card the HUD cannot spawn.
    if (!isUnlocked(id)) return;
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
    hideTooltip();
    drawPick();
    drawDeck();
    updateDeckValidation();
    saveDeck(deck);
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
    if (busy || deck.length !== DECK_SIZE) return;
    hideTooltip();
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
        updateDeckValidation();
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
  drawCareer();
  // The markup carries the .on class so the panel is there on the first paint
  // with no flash of HUD-only frame, but the body flag body.lobbying hides the
  // hand beneath it - and that flag is not in the static markup, so it is
  // asserted here where the two states live together.
  show();

  function hide() {
    hideTooltip();
    root.classList.remove('on');
    document.body.classList.remove('lobbying');
  }
  function show() {
    root.classList.add('on');
    document.body.classList.add('lobbying');
    // Re-read on the way in. A match can have banked a level-up and a streak
    // while the overlay was hidden, and the padlocks have to move with it.
    drawCareer();
    drawPick();
    drawDeck();
    updateDeckValidation();
  }

  return {
    hide,
    show,
    get deck() { return deck.slice(); },
    get difficulty() { return difficulty; },
  };
}