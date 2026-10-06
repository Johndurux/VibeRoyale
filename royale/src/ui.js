// ── ui.js ──────────────────────────────────────────────────────────────────
// The heads-up display: everything on screen that is not the 3D pit.
//
// Two rules shaped this file. The HUD is built from the same material as the
// cast - hard boxes, no radii, no blur, cream on near-black - because a soft
// glass panel floating over voxel toys reads as a different game wearing the
// same screen. And nothing here invents state: the tower rows read live HP
// and the roster reads the real CHARACTERS table, so no readout can quietly
// disagree with the pit behind it. No fake gold, no fake clock.

import * as THREE from 'three';
import { CHARACTERS } from './characters.js';
import { hpColour } from './towers.js';
import { RARITY, CARDS } from './config.js';

// Portrait resolution. Over-sampled against the ~46px the face is displayed at
// so the voxel steps stay crisp instead of aliasing into mush. Exported
// because lobby.js paints the same portraits for its deck picker - one
// portrait pipeline, not two that can drift apart.
export const FACE_PX = 96;

// The three spell sigils, drawn straight onto the 2D card face rather than in
// 3D. A spell is an area, not a body, so the mark is a ring with a shape inside
// it: the ring is the blast radius, which is what the player is actually
// judging when they choose a spell over a troop.
const SPELL_SIGIL = {
  fireball: { core: '#FF6A2A', edge: '#FFD27A', shape: 'burst' },
  freeze: { core: '#6AD8FF', edge: '#D8F4FF', shape: 'shard' },
  heal: { core: '#5BD97A', edge: '#D6FFDF', shape: 'cross' },
};

/**
 * Paint a spell's sigil into a card face.
 * @param {CanvasRenderingContext2D} ctx the face's 2D context
 * @param {object} char a CHARACTERS / SPELL_CARDS entry
 */
function drawSpellGlyph(ctx, char) {
  if (!ctx) return;
  const s = SPELL_SIGIL[char.spell] || SPELL_SIGIL.fireball;
  const c = FACE_PX / 2;
  const r = FACE_PX * 0.34;
  ctx.clearRect(0, 0, FACE_PX, FACE_PX);
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fillStyle = s.core;
  ctx.fill();
  ctx.lineWidth = FACE_PX * 0.05;
  ctx.strokeStyle = s.edge;
  ctx.stroke();
  ctx.fillStyle = s.edge;
  ctx.strokeStyle = s.edge;
  ctx.lineCap = 'round';
  if (s.shape === 'burst') {
    // Fireball: radiating spokes.
    ctx.lineWidth = FACE_PX * 0.045;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a) * r * 0.34, c + Math.sin(a) * r * 0.34);
      ctx.lineTo(c + Math.cos(a) * r * 0.8, c + Math.sin(a) * r * 0.8);
      ctx.stroke();
    }
  } else if (s.shape === 'shard') {
    // Freeze: a six-point star.
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
      const x = c + Math.cos(a) * r * 0.78;
      const y = c + Math.sin(a) * r * 0.78;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  } else {
    // Heal: a cross, the one mark everyone already reads correctly.
    const t = r * 0.26;
    const l = r * 0.74;
    ctx.fillRect(c - t, c - l, t * 2, l * 2);
    ctx.fillRect(c - l, c - t, l * 2, t * 2);
  }
}

// buildTowers() pushes king, then small[0] (x = -6.2), then small[1] (x = +6.2),
// so filtering by side preserves that order and these labels stay true.
const ROWS = ['KING', 'LEFT', 'RIGHT'];

// Elixir economy. One drop every ELIXIR_PERIOD seconds, capped at ten - the
// rate Clash Royale actually uses. It regenerates for real here rather than
// sitting as a decorative number, and spend() is the only way it goes down, so
// the bar is a genuine resource: a number that ticks up and can never be
// lowered would be a lie told by the HUD.
const ELIXIR_MAX = 10;
const ELIXIR_PERIOD = 2.8;

// How close to a whole drop counts as reaching it. Accumulating dt/ELIXIR_PERIOD
// lands on values like 9.99999999999964, and Math.floor would floor that to 9 -
// so a visibly full bar would sit next to the number 9. Snapping the last sliver
// is what keeps the readout and the fill from ever disagreeing at the cap.
const ELIXIR_EPS = 1e-6;

// ── portraits ──────────────────────────────────────────────────────────────
/**
 * Render each unlocked character's real voxel model into its card canvas.
 *
 * A letter avatar would be the cheap option, but the whole point is that the
 * roster looks like the cast you are picking - so each face is the actual
 * `build()` output, lit by a small rig borrowed from scene.js. Painted once at
 * boot; the render loop never touches this context.
 *
 * The offscreen renderer shares the voxel.js geometry and material caches with
 * the main scene. That is safe because each WebGLRenderer owns a separate GL
 * context and its own GPU bindings, so disposing this one frees only its own
 * resources and leaves the cache intact for the pit.
 *
 * @param {Array<{char: object, ctx: CanvasRenderingContext2D}>} targets
 */
export function renderFaces(targets) {
  if (!targets.length) return;

  const cv = document.createElement('canvas');
  cv.width = FACE_PX;
  cv.height = FACE_PX;
  const r = new THREE.WebGLRenderer({
    canvas: cv,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  r.setPixelRatio(1);
  r.setSize(FACE_PX, FACE_PX, false);
  r.setClearColor(0x000000, 0);
  r.shadowMap.enabled = false;

  const s = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(28, 1, 0.1, 40);
  cam.position.set(0, 2.0, 6.4);
  cam.lookAt(0, 1.42, 0);

  // Daylight rig to match the arena: a hemisphere for the sky/ground wrap, a
  // warm key with a little top-front bias so the face is lit, and a cool sky
  // fill instead of the old cyan rim. Soft rim light is what makes a toy read
  // as glossy rather than as a flat swatch.
  s.add(new THREE.HemisphereLight(0xd8f0ff, 0xc9b48c, 1.0));
  const key = new THREE.DirectionalLight(0xfff4dd, 1.6);
  key.position.set(3, 6, 6);
  s.add(key);
  const rim = new THREE.DirectionalLight(0xbfe4ff, 0.5);
  rim.position.set(-4, 2.5, 2);
  s.add(rim);
  const fill = new THREE.DirectionalLight(0xffd9a0, 0.35);
  fill.position.set(2, 1, -5);
  s.add(fill);

  for (const t of targets) {
    const g = t.char.build();
    // Spells have no unit to construct - SPELL_CARDS entries return null from
    // build() on purpose - so they get a flat sigil on the card face instead of
    // a portrait. Without this branch every spell card threw while building the
    // lobby grid, because the caller here assumed build() always returns a
    // mesh. The three sigils are drawn from the spell's own identity rather
    // than from a shared placeholder, so FIREBALL, FREEZE and HEAL are
    // distinguishable at 44px.
    if (!g) {
      drawSpellGlyph(t.ctx, t.char);
      continue;
    }
    s.add(g);
    r.render(s, cam);
    t.ctx.clearRect(0, 0, FACE_PX, FACE_PX);
    // Requires preserveDrawingBuffer above: without it the buffer is undefined
    // after the render call and the copy comes back blank.
    t.ctx.drawImage(cv, 0, 0);
    s.remove(g);
  }

  r.dispose();
}

// ── roster ────────────────────────────────────────────────────────────────
/**
 * Build the clickable card hand.
 * @param {HTMLElement} host
 * @param {HTMLElement} hint
 * @param {(id: string) => void} [onCardPick] called with the id of a card the
 *   player armed. This exists so a click can make a sound without the HUD
 *   owning an audio handle - the module never imports audio.js, it just
 *   reports what happened and main.js decides what that sounds like.
 * @param {string[]|null} [deck] ids to show, or null for the whole roster. The
 *   lobby hands over the hand the player actually chose, so the deck previewed
 *   on that screen and the cards in the pit are the same four. A preview that
 *   disagrees with the hand would be the exact kind of lie this HUD does not
 *   tell.
 */
function buildRoster(host, hint, onCardPick, deck) {
  const faces = [];
  const chips = new Map();

  // A deck of ids resolves to real characters; an id that matches nothing is
  // dropped rather than rendered as a blank card, and a deck that resolves to
  // nothing falls back to the full roster so the hand is never empty.
  let list = null;
  if (deck && deck.length) {
    list = deck
      .map((id) => CHARACTERS.find((c) => c.id === id))
      .filter(Boolean);
    if (!list.length) list = null;
  }
  const shown = list || CHARACTERS;

  shown.forEach((c) => {
    const unlocked = c.unlocked !== false;
    // Falls back to common so a character added without a rarity still renders
    // a valid card rather than falling through to a transparent border.
    const tier = RARITY[c.rarity] || RARITY.common;
    // The price, printed on the card. It is the same number spend() will refuse
    // if the player taps too early, so it has to be readable BEFORE they
    // commit - a roster that hides its costs somewhere else is a roster you
    // cannot actually choose from.
    const cost = (CARDS[c.id] || {}).cost;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.style.setProperty('--c', c.color);
    // The rim is what the card is judged on at a glance, so it carries the
    // rarity: a flat colour for the three normal tiers, the conic sweep for
    // legendary, which is the one tier a hex cannot express.
    b.style.setProperty('--rim', tier.gradient || tier.color);
    b.setAttribute('aria-pressed', 'false');
    b.disabled = !unlocked;
    b.title = unlocked ? c.name + ' · ' + tier.name + ' · ' + c.role : c.name + ' — locked';
    // Role is written "Folk · Detail"; the card only has room for the first half.
    b.innerHTML =
      '<span class="chip-face"><canvas width="' + FACE_PX + '" height="' + FACE_PX + '"></canvas></span>' +
      '<span class="chip-name"></span>' +
      '<span class="chip-role"></span>' +
      '<span class="chip-cost"></span>' +
      (unlocked ? '' : '<span class="chip-lock">LOCKED</span>');
    b.querySelector('.chip-name').textContent = c.name;
    b.querySelector('.chip-cost').textContent = cost == null ? '-' : String(cost);
    b.querySelector('.chip-role').textContent = c.role.split(' · ')[0];
    // The gradient goes on the frame, not the canvas. The canvas has to stay
    // transparent so the audit's blank-face check still means "the 3D model
    // actually drew" - painting the tier into the canvas would make every
    // portrait pass that check whether or not the character rendered.
    b.querySelector('.chip-face').style.background = tier.bg;
    host.appendChild(b);
    if (unlocked) faces.push({ char: c, ctx: b.querySelector('canvas').getContext('2d') });
    chips.set(c.id, b);
  });

  renderFaces(faces);

  // The unchanged guard matters: this runs every frame, and writing a class
  // that is already set is still a style recalc on nine cards.
  function markAffordable(current) {
    for (const [id, el] of chips) {
      const c = CARDS[id];
      const broke = !!c && current < c.cost;
      if (el.classList.contains('broke') !== broke) el.classList.toggle('broke', broke);
    }
  }

  function baseText(id) {
    const c = CHARACTERS.find((x) => x.id === id);
    if (!c) return 'PICK A CARD · TAP THE FIELD';
    return c.name + ' · ' + ((CARDS[id] || {}).cost) + ' ELIXIR · TAP THE FIELD';
  }

  // A timer, not an animation event, for the same reason the damage pops use
  // one: immune to the tab being backgrounded mid-message.
  let flashTimer = null;
  function flashHint(msg) {
    if (!hint) return;
    hint.textContent = msg;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashTimer = null;
      if (hint) hint.textContent = baseText(selected);
    }, 1100);
  }

  let selected = null;
  function select(id) {
    if (id === selected) return;
    selected = id;
    for (const [key, el] of chips) el.setAttribute('aria-pressed', String(key === id));
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
    if (hint) hint.textContent = baseText(id);
  }

  for (const [id, el] of chips) {
    el.addEventListener('click', () => {
      select(id);
      if (onCardPick) onCardPick(id);
    });
  }

  // Default to the first fighter actually on show - the deck, not the whole
  // roster - so the armed card is always one the player brought.
  const first = shown.find((c) => c.unlocked !== false);
  if (first) select(first.id);

  return {
    get selected() { return selected; },
    select,
    markAffordable,
    flashHint,
  };
}

// ── tower readouts ────────────────────────────────────────────────────────
function buildSide(host, totalHost) {
  const refs = [];
  for (const label of ROWS) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML =
      '<span class="row-label"></span>' +
      '<span class="bar"><i></i></span>' +
      '<span class="row-pct">100%</span>';
    row.querySelector('.row-label').textContent = label;
    host.appendChild(row);
    refs.push({
      fill: row.querySelector('i'),
      pct: row.querySelector('.row-pct'),
      bar: row.querySelector('.bar'),
      last: null,
    });
  }
  return { refs, total: totalHost, lastAvg: null };
}

// ── public ────────────────────────────────────────────────────────────────
// Scratch vector for world->screen projection. One, reused: popDamage runs on
// every hit and allocating a Vector3 per call would churn the heap in a loop.
const _proj = new THREE.Vector3();

// How far above each tower's base the damage number should float. A king is
// taller and carries a crown, so it needs more clearance or the number lands
// inside its own roof.
const POP_HEIGHT = { king: 8.6, small: 6.4 };

/**
 * Mount the HUD and return a per-frame updater.
 * @param {object} deps
 * @param {{towers: Array<object>}} deps.towerKit live towers to read HP from
 * @param {THREE.Camera} deps.camera used to project damage numbers
 * @param {(id: string) => void} [deps.onCardPick] the player armed a card
 * @param {(won: boolean) => void} [deps.onResult] a king has fallen and the
 *   outcome is decided. main.js uses it to stop the bot and to choose the
 *   victory or defeat cue, so the HUD never needs to know what audio is.
 */
export function createUI({ towerKit, camera, onCardPick, onResult, onMenu }) {
  // Kept as variables, not arguments, because the lobby hands the deck over
  // after this returns: the lobby owns the pre-match screen and resolves the
  // hand when the player presses start, which is after boot. setDeck() then
  // rebuilds the hand in place rather than the HUD guessing at it up front.
  const rosterHost = document.getElementById('roster');
  const hintHost = document.getElementById('rosterHint');
  let roster = buildRoster(rosterHost, hintHost, onCardPick, null);
  // Tracks the resolved hand. null means "the whole roster", which is what a
  // match plays before the lobby has decided; setDeck() replaces it. Read by
  // main.js so the number-key shortcut cannot pick a card the hand does not
  // actually hold.
  let deck = null;

  const player = buildSide(
    document.getElementById('playerRows'),
    document.getElementById('playerTotal')
  );
  const enemy = buildSide(
    document.getElementById('enemyRows'),
    document.getElementById('enemyTotal')
  );

  const sides = [
    { ref: player, towers: towerKit.towers.filter((t) => t.side === 'player') },
    { ref: enemy, towers: towerKit.towers.filter((t) => t.side === 'enemy') },
  ];

  const elixirFill = document.getElementById('elixirFill');
  const elixirNum = document.getElementById('elixirNum');
  const fx = document.getElementById('fx');
  const stageBadge = document.getElementById('stageBadge');
  const stageNum = document.getElementById('stageNum');
  const result = document.getElementById('result');
  const resultTitle = document.getElementById('resultTitle');
  const resultSub = document.getElementById('resultSub');
  const btnPlayAgain = document.getElementById('btnPlayAgain');
  const btnChangeDeck = document.getElementById('btnChangeDeck');
  const btnMenu = document.getElementById('btnMenu');
  if (btnMenu && typeof onMenu === 'function') {
    // The way out of a live match: leave for the lobby (and its stage grid)
    // without settling anything. main.js decides what leaving means.
    btnMenu.addEventListener('click', () => onMenu());
  }

  let currentPlayAgain = null;
  let currentChangeDeck = null;

  if (btnPlayAgain) {
    btnPlayAgain.addEventListener('click', () => {
      const cb = currentPlayAgain;
      reset();
      if (cb) cb();
    });
  }
  if (btnChangeDeck) {
    btnChangeDeck.addEventListener('click', () => {
      const cb = currentChangeDeck;
      reset();
      if (cb) cb();
    });
  }

  // Elixir is a float, not a count. That is the whole fix: as an integer it
  // could only ever hold whole drops, so the partial progress toward the next
  // one had nowhere to live and the bar jumped a full 10% step at a time. The
  // fraction IS the accumulator, so a frame spike adds the time it really
  // covered and can never swallow a drop.
  let elixir = ELIXIR_MAX / 2;
  let elixirShown = -1;
  // Tracked separately from elixirShown because the number only changes on a
  // whole drop while the fill moves every frame.
  let elixirFillShown = -1;

  const playerKing = towerKit.towers.find((t) => t.side === 'player' && t.kind === 'king');
  const enemyKing = towerKit.towers.find((t) => t.side === 'enemy' && t.kind === 'king');
  let settled = false;

  /**
   * Throw a bold, inked number up off a tower. Projected from the live world
   * position rather than pinned to a screen corner, so it lands on the tower
   * that was actually hit even after the camera is pulled back.
   * @param {object} tower
   * @param {number} amount raw damage dealt
   * @param {boolean} ko true if this hit destroyed the tower
   */
  function popDamageAt(x, y, z, amount, ko) {
    if (!fx || !camera) return;
    _proj.set(x, y, z).project(camera);
    const el = document.createElement('div');
    el.className = ko ? 'dmg ko' : 'dmg';
    el.textContent = ko ? 'KO!' : String(Math.max(1, Math.round(amount)));
    el.style.left = (_proj.x * 0.5 + 0.5) * window.innerWidth + 'px';
    el.style.top = (-_proj.y * 0.5 + 0.5) * window.innerHeight + 'px';
    fx.appendChild(el);
    // animationend would be tidier, but a timer is immune to the animation
    // being skipped when the tab is backgrounded mid-pop.
    setTimeout(() => el.remove(), 950);
  }

  function popDamage(tower, amount, ko) {
    const h = POP_HEIGHT[tower.kind] || 6.4;
    popDamageAt(tower.x, tower.mesh.position.y + h, tower.z, amount, ko);
  }

  /**
   * The campaign badge above the board. Hidden for 0/undefined, so a mode
   * without a stage (free play, a probe) leaves the HUD clean instead of
   * showing a stale number.
   * @param {number} [n]
   */
  function setStage(n) {
    if (!stageBadge) return;
    const show = Number.isFinite(n) && n >= 1;
    stageBadge.style.display = show ? '' : 'none';
    if (show && stageNum) stageNum.textContent = String(n);
  }

  /**
   * Reset the HUD result screen, confetti, and settled flag for a new match.
   */
  function reset() {
    settled = false;
    currentPlayAgain = null;
    currentChangeDeck = null;
    if (result) {
      result.classList.remove('on', 'lose');
      result.querySelectorAll('.confetti').forEach((c) => c.remove());
    }
    if (btnPlayAgain) btnPlayAgain.textContent = 'PLAY AGAIN';
    setStage(0);
    elixir = ELIXIR_MAX / 2;
    elixirShown = -1;
    elixirFillShown = -1;
    if (roster) {
      roster.select(null);
      roster.markAffordable(elixir);
    }
  }

  /**
   * Fill the result overlay with gold confetti and show it.
   * @param {boolean} won
   * @param {string|object} [reason]
   * @param {object} [payload]
   */
  function showResult(won, reason, payload) {
    if (!result) return;
    const data = (payload && typeof payload === 'object')
      ? payload
      : (reason && typeof reason === 'object') ? reason : null;
    if (data) {
      if (typeof data.onPlayAgain === 'function') currentPlayAgain = data.onPlayAgain;
      if (typeof data.onChangeDeck === 'function') currentChangeDeck = data.onChangeDeck;
    }
    // The campaign continuation: a won stage with a next one turns the primary
    // button into NEXT STAGE, so a run goes 1 -> 2 -> ... -> 15 without a
    // lobby detour. A loss (or the end of the campaign) keeps PLAY AGAIN.
    if (won && data && typeof data.onNextStage === 'function') {
      currentPlayAgain = data.onNextStage;
      if (btnPlayAgain) btnPlayAgain.textContent = 'NEXT STAGE \u25B6';
    } else if (btnPlayAgain) {
      btnPlayAgain.textContent = 'PLAY AGAIN';
    }
    if (settled) return;
    settled = true;
    // Reported before the overlay is built, so main.js can stop the bot and
    // pick a cue without waiting on any DOM work.
    if (onResult) onResult(won);
    result.classList.toggle('lose', !won);
    resultTitle.textContent = won ? 'VICTORY' : 'DEFEAT';
    // A stage match says which stage it was: the cleared number on a win (the
    // lobby already shows the next one open), the plain fall line on a loss.
    const st = data && data.stage;
    resultSub.textContent = won
      ? (st ? 'STAGE ' + st + ' CLEARED' : 'RIVAL KING TOWER DOWN')
      : 'YOUR KING TOWER FELL';
    const cols = ['#FFC94A', '#FFE9A8', '#6FCF3E', '#6FC7F0', '#FF9AD5', '#FFFFFF'];
    for (let i = 0; i < 90; i++) {
      const bit = document.createElement('i');
      bit.className = 'confetti';
      bit.style.left = Math.random() * 100 + 'vw';
      bit.style.background = cols[i % cols.length];
      bit.style.animationDuration = 1.6 + Math.random() * 2.2 + 's';
      bit.style.animationDelay = Math.random() * 1.6 + 's';
      if (i % 3 === 0) bit.style.width = 7 + Math.random() * 5 + 'px';
      result.appendChild(bit);
    }
    result.classList.add('on');
  }

  /**
   * Rich result handler passed from main.js endMatch().
   * @param {object} payload
   */
  function showResultPanel(payload) {
    if (!payload) return;
    const won = payload.winner === 'player' || !!payload.won;
    showResult(won, payload.reason, payload);
  }

  function update(dt = 0) {
    for (const side of sides) {
      for (let i = 0; i < side.ref.refs.length; i++) {
        const t = side.towers[i];
        const r = side.ref.refs[i];
        if (!t || !r) continue;
        const ratio = t.destroyed ? 0 : t.hp / t.maxHp;
        const pct = t.destroyed ? 0 : Math.max(0, Math.min(100, Math.ceil(ratio * 100)));
        // Skip untouched rows: writing identical styles every frame is a
        // needless style recalc six times a frame.
        const sig = pct + '|' + (t.destroyed ? 1 : 0);
        if (r.last === sig) continue;
        r.last = sig;
        r.fill.style.width = pct + '%';
        r.fill.style.background = hpColour(ratio);
        r.pct.textContent = t.destroyed ? 'KO' : pct + '%';
        r.pct.style.color = t.destroyed ? 'var(--vr-danger-red)' : hpColour(ratio);
        r.bar.classList.toggle('is-ko', !!t.destroyed);
      }

      // Side total is the mean of that side's three towers: a real derived
      // number rather than a decorative "score".
      let sum = 0;
      for (const t of side.towers) sum += t.destroyed ? 0 : t.hp / t.maxHp;
      const avg = side.towers.length ? Math.round((sum / side.towers.length) * 100) : 0;
      if (side.ref.lastAvg !== avg) {
        side.ref.lastAvg = avg;
        side.ref.total.textContent = avg + '%';
        side.ref.total.style.color = hpColour(avg / 100);
      }
    }

    // Elixir regen. Dividing by the period turns dt straight into a fraction of
    // a drop, so the fill creeps continuously and no separate remainder counter
    // is needed. MAX_DT in main.js already caps a backgrounded tab's delta.
    if (dt > 0 && elixir < ELIXIR_MAX) {
      elixir = Math.min(ELIXIR_MAX, elixir + dt / ELIXIR_PERIOD);
    }
    // Snap to the whole drop it has effectively reached, so the number and the
    // fill can never show different states at the cap.
    const nearest = Math.round(elixir);
    if (nearest > elixirShown && Math.abs(elixir - nearest) < ELIXIR_EPS) {
      elixir = nearest;
    }
    // The number is the floor, because that is what the bar can actually be
    // spent at. The fill is the real fraction, so the remaining progress
    // toward the next drop is visible instead of the bar sitting dead for
    // 2.8 seconds and then jumping a whole step.
    const shown = Math.floor(elixir);
    if (shown !== elixirShown) {
      elixirShown = shown;
      elixirNum.textContent = String(shown);
    }
    const frac = (elixir / ELIXIR_MAX) * 100;
    if (Math.abs(frac - elixirFillShown) > 0.1) {
      elixirFillShown = frac;
      elixirFill.style.width = frac + '%';
    }

    roster.markAffordable(elixir);

    // Match resolution. Both king towers are real objects with real HP, so
    // this is a genuine terminal condition, not a scripted win that fires on a
    // timer. It only becomes reachable once something can actually deal
    // damage, which the phase-1 arena cannot do on its own.
    if (!settled && enemyKing && enemyKing.destroyed) showResult(true);
    else if (!settled && playerKing && playerKing.destroyed) showResult(false);
  }

  update();

  /**
   * Swap the hand for the deck the player chose in the lobby.
   *
   * Rebuilt rather than filtered, because the chips own their canvases and a
   * filtered-out card would leave a stale portrait behind. The armed card is
   * re-seeded from the new hand, and the affordability pass runs once so the
   * rebuild does not leave every card dimmed until the next frame.
   *
   * @param {string[]} ids
   */
  function setDeck(ids) {
    if (!rosterHost) return;
    deck = ids && ids.length ? ids.slice() : null;
    rosterHost.innerHTML = '';
    roster = buildRoster(rosterHost, hintHost, onCardPick, deck);
    roster.markAffordable(elixir);
  }

  /**
   * Spend elixir. The single gate through which the bar can go down, so no
   * caller can decrement the number behind the HUD's back and leave the fill
   * disagreeing with the readout.
   *
   * The fractional remainder is deliberately preserved. In Clash Royale you
   * keep the progress you had made toward the next drop, so spending a 3-cost
   * card does not throw away the regen already banked toward the one after it.
   * Because elixir is a float, that progress simply rides along with the value
   * - there is no separate accumulator left to reset.
   *
   * @param {number} cost whole elixir; must be > 0
   * @returns {boolean} true if the cost was paid, false if elixir was short
   */
  function spend(cost) {
    if (!(cost > 0)) return false;
    if (elixir < cost) return false;
    elixir = Math.max(0, elixir - cost);
    // Paint immediately, in this call, rather than waiting for the next frame.
    // Regen is also live, so deferring would let the bar creep UP for one frame
    // while the number already reads lower - the bar and the readout would then
    // briefly disagree about how much elixir is left, which is the one thing the
    // elixir HUD must never do. Both sentinels are reset so the next update()
    // re-syncs cleanly even when the spend lands on the same displayed digit.
    const pct = (elixir / ELIXIR_MAX) * 100;
    elixirShown = Math.floor(elixir);
    elixirFillShown = pct;
    elixirNum.textContent = String(elixirShown);
    elixirFill.style.width = pct + '%';
    roster.markAffordable(elixir);
    return true;
  }

  return {
    update,
    setDeck,
    setStage,
    popDamage,
    popDamageAt,
    showResult,
    showResultPanel,
    reset,
    spend,
    // Delegated to the live roster rather than bound at build time, because
    // setDeck() swaps `roster` for a new hand. A reference captured here would
    // keep writing to the first hand's detached chips, and deploy() would arm
    // a card on cardboard nobody can see.
    select: (id) => roster.select(id),
    costOf: (id) => (CARDS[id] || {}).cost,
    markAffordable: (current) => roster.markAffordable(current),
    flashHint: (msg) => roster.flashHint(msg),
    get elixir() { return elixir; },
    get selected() { return roster.selected; },
    get deck() { return deck; },
  };
}