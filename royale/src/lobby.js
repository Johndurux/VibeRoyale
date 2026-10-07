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
import { CARDS, SPELLS, RARITY, STAGES } from './config.js';
import { renderFaces, FACE_PX } from './ui.js';
import { isUnlocked, unlockStageFor, snapshot } from './progression.js';

// How many cards a deck holds. Four expresses a plan - a tank, two answers, a
// win condition - without asking anyone to study nine stats before their first
// match, which is what makes a lobby get skipped instead of read.
const DECK_SIZE = 4;

// The chosen deck survives a reload. A deck is a decision the player has
// already made, and silently re-picking the same four on every visit is the
// lobby telling them the choice did not matter. It is stored under its own key
// and re-validated against the unlock ladder on load, so a deck saved before a
// reset cannot smuggle a now-locked card back in.
export const DECK_KEY = 'viberoyale.deck';

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
 * @param {() => void} [deps.onMenu] called when the lobby's MENU button sends
 *   the player back out to the main menu; absent leaves the button inert
 */
export function createLobby({ audio, onStart, onMenu }) {
  const root = document.getElementById('lobby');
  if (!root) return { hide() {}, show() {}, deck: [], stage: 1 };

  // Every unlocked fighter is a candidate. A character added with
  // unlocked:false stays in the world (a probe can still spawn it) but is not
  // offered here, which is exactly how the HUD roster treats it.
  const candidates = CHARACTERS.filter((c) => c.unlocked !== false);

  // Default hand is roster order - real, if unromantic, and drawn from the same
  // list the HUD will show, so nothing here is a different cast.
  // A saved deck wins over the default hand, but only after loadDeck() has
  // checked every id against the ladder. Anything it rejects is simply absent,
  // and the fill below tops the hand back up to DECK_SIZE with unlocked cards.
  let deck = [];

  /**
   * Rebuild the hand from storage. Runs at boot and again on every show():
   * a NEW GAME wipes the save underneath the lobby, and re-reading on entry
   * is what makes that wipe real without a page reload.
   */
  function rebuildDeck() {
    deck = loadDeck() || [];
    for (const c of candidates) {
      if (deck.length >= DECK_SIZE) break;
      if (!deck.includes(c.id) && isUnlocked(c.id)) deck.push(c.id);
    }
    deck = deck.slice(0, DECK_SIZE);
  }
  rebuildDeck();
  // The level the career is sitting at. Read live rather than captured once,
  // because show() re-runs the card pass after a match may have banked a
  // level-up - a card that opened during that match has to lose its padlock
  // on the way back in, not on the next reload.
  const careerLevel = () => snapshot().level;
  // The campaign position, live for the same reason: winning a stage re-renders
  // this screen, and the next stage must already be open when it does.
  const clearedStage = () => snapshot().stage;
  // Stage the BATTLE button will launch. Defaults to the first uncleared
  // stage, so the lobby always opens one click away from moving forward.
  let stage = Math.min(1 + clearedStage(), STAGES.length);

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
  const menuBtn = document.getElementById('lobbyMenu');
  const boardHost = document.getElementById('lobbyBoard');
  // Tabs and their panes, matched by key. Both maps are allowed to be
  // incomplete - every access below is guarded, so a partial DOM degrades to
  // a lobby without tabs instead of a lobby that throws.
  const tabs = {
    stage: document.getElementById('ltabStage'),
    deck: document.getElementById('ltabDeck'),
    board: document.getElementById('ltabBoard'),
  };
  const panes = {
    stage: document.getElementById('paneStage'),
    deck: document.getElementById('paneDeck'),
    board: document.getElementById('paneBoard'),
  };

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

  // ── tabs: one screen, one job ────────────────────────────────────────────
  /**
   * Swap the visible pane. The career strip and the BATTLE button stay put;
   * only the middle of the panel changes. The board is painted on entry, so
   * it can never show numbers older than the moment its tab was opened.
   * @param {'stage'|'deck'|'board'} name
   */
  function showTab(name) {
    for (const key of Object.keys(panes)) {
      if (panes[key]) panes[key].classList.toggle('on', key === name);
      if (tabs[key]) tabs[key].classList.toggle('on', key === name);
    }
    if (name === 'board') drawBoard();
  }

  /**
   * The local leaderboard: this career's own numbers, nothing invented. Every
   * row reads progression.snapshot() - the same source the career strip and
   * the main menu's fact board use - so no two screens can disagree about
   * what the player has done. No fake rival names: a leaderboard full of bots
   * is a lie this screen refuses to tell.
   */
  function drawBoard() {
    if (!boardHost) return;
    const s = snapshot();
    const rows = [
      ['STAGE CLEARED', s.stage + ' / ' + s.stagesTotal],
      ['LEVEL', s.level],
      ['XP', s.xp],
      ['RECORD', s.wins + 'W · ' + s.losses + 'L'],
      ['BEST STREAK', s.bestStreak],
      ["TOWERS KO'D", s.towersDestroyed],
      ['DAMAGE DEALT', s.totalDamageDealt],
      ['MATCHES', s.matches],
    ];
    boardHost.innerHTML = '';
    for (const [label, value] of rows) {
      const row = document.createElement('div');
      row.className = 'lb-row';
      const name = document.createElement('span');
      name.textContent = label;
      const num = document.createElement('b');
      num.textContent = String(value);
      row.appendChild(name);
      row.appendChild(num);
      boardHost.appendChild(row);
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
    const fresh = isUnlocked(c.id) && unlockStageFor(c.id) === clearedStage() && clearedStage() > 0;
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
      // The badge names the stage that opens the card rather than saying
      // "locked", because the number is the reason to play another stage.
      (locked ? '<span class="lcard-lock"><b>&#128274;</b>STAGE ' + unlockStageFor(c.id) + '</span>' : '') +
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
      // The hint exists only to say why BATTLE is unready. The old idle line
      // ("3 · 2 · 1 · GO") sat faintly under the button on every tab and read
      // as a broken countdown; hidden is the honest idle state.
      if (!valid) {
        const needed = DECK_SIZE - deck.length;
        hintEl.textContent = 'CHOOSE ' + needed + ' MORE CARD' + (needed > 1 ? 'S' : '') + ' (4 REQUIRED)';
        hintEl.style.display = 'block';
      } else {
        hintEl.style.display = 'none';
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

  // ── stage select ─────────────────────────────────────────────────────────
  // Replaces the old difficulty picker: the stage IS the difficulty now, a
  // row in the STAGES table that picks the rival's behaviour tier and stacks
  // multipliers on top. A stage is playable when it is the first uncleared
  // one or anything before it; replaying old stages is how a stuck player
  // earns repeat XP, so they stay lit rather than going dark.
  function drawStages() {
    if (!diffHost) return;
    diffHost.innerHTML = '';
    const cleared = clearedStage();
    for (const cfg of STAGES) {
      const b = document.createElement('button');
      b.type = 'button';
      const locked = cfg.stage > cleared + 1;
      const lv = LEVELS.find((l) => l.key === cfg.botLevel) || LEVELS[1];
      b.className = 'ldiff stage' + (cfg.stage === stage ? ' on' : '') + (locked ? ' locked' : '');
      if (locked) b.disabled = true;
      b.innerHTML = '<span class="ldiff-name"></span><span class="ldiff-blurb"></span>';
      b.querySelector('.ldiff-name').innerHTML = locked
        ? cfg.stage + ' &#128274;'
        : cfg.stage + ' &middot; ' + lv.name;
      b.querySelector('.ldiff-blurb').textContent = locked
        ? 'CLEAR STAGE ' + (cleared + 1)
        : lv.blurb;
      b.addEventListener('click', () => {
        stage = cfg.stage;
        if (audio) audio.play('card');
        drawStages();
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
        if (onStart) onStart(stage, deck.slice());
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

  // ── tab switching + the way back to the menu ─────────────────────────────
  for (const key of Object.keys(tabs)) {
    if (tabs[key]) {
      tabs[key].addEventListener('click', () => {
        if (audio) audio.play('card');
        showTab(key);
      });
    }
  }
  if (menuBtn && onMenu) {
    menuBtn.addEventListener('click', () => {
      if (audio) audio.play('card');
      hide();
      onMenu();
    });
  }

  drawPick();
  drawDeck();
  drawStages();
  drawCareer();
  // No show() here. The main menu is the front door now: a fresh load lands
  // on the menu, and the lobby is a room the player steps into from it.
  // Constructing visible would put a deck picker in front of someone who has
  // not chosen anything yet.

  function hide() {
    hideTooltip();
    root.classList.remove('on');
    document.body.classList.remove('lobbying');
  }
  function show() {
    root.classList.add('on');
    document.body.classList.add('lobbying');
    // Re-read on the way in. A match can have banked a stage clear, a level
    // and a streak while the overlay was hidden, and the padlocks, the stage
    // grid and the default stage all have to move with it.
    stage = Math.min(1 + clearedStage(), STAGES.length);
    // And the deck: NEW GAME wipes its save while the lobby is hidden, so
    // re-reading here is what makes the wipe take effect without a reload.
    rebuildDeck();
    drawCareer();
    drawStages();
    drawPick();
    drawDeck();
    updateDeckValidation();
    showTab('stage');
  }

  return {
    hide,
    show,
    get deck() { return deck.slice(); },
    get stage() { return stage; },
  };
}