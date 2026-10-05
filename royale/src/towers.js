// ── towers.js ─────────────────────────────────────────────────────────────
// The towers. A small tower is a chunky ATM / vending machine with a small
// screen that reads its own HP as a PERCENTAGE (99% -> 45% -> KO). The king
// tower is the same idea at vault scale, ringed in neon.
//
// Phases 3+ call damage(); phase 1 only needs them to exist, read full HP and
// render. The damage path is wired up now so the glitch can be inspected.

import * as THREE from 'three';
import { vox, decoBox } from './voxel.js';
import { PALETTE, TOWERS } from './config.js';

// ── HP screen canvas ──────────────────────────────────────────────────────
const SCREEN_W = 256, SCREEN_H = 128;

// Exported because ui.js paints the same three thresholds onto the HUD bars.
// One owner for the colour language: if these drift apart, the tower screen
// and the HUD bar will disagree about how much damage a side has taken.
export function hpColour(ratio) {
  if (ratio > 0.6) return '#6fcf3e';   // healthy: grass green
  if (ratio > 0.25) return '#ff9f45';  // taking losses: warm amber
  return '#ff5c4d';                    // critical: alarm red
}

// Screen body. A bright parchment rather than the old near-black: the panel
// is lit by the same sun as the arena, so a dark readout would read as a hole
// punched in a sunny castle wall.
const SCREEN_BG = '#f4ead6';
const SCREEN_WASH = 'rgba(120,90,40,0.07)';

// Same face the HUD uses for numbers, so the tower screen and the HUD bar are
// visibly the same instrument.
const SCREEN_FONT = '"Bungee", "Baloo 2", "Trebuchet MS", sans-serif';

/**
 * Stamp a number with a thick ink outline, then fill it. Drawn twice - once as
 * a fat stroke in ink, once filled in the HP colour - which is what makes game
 * numerals readable against any background.
 * @param {CanvasRenderingContext2D} ctx already positioned, centred, filled
 * @param {string} text
 * @param {number} y
 * @param {string} colour
 */
function inkedText(ctx, text, y, colour) {
  const px = parseInt(ctx.font.match(/(\d+)px/)[1], 10);
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = Math.max(3, px * 0.18);
  ctx.strokeText(text, ctx.canvas.width / 2, y);
  ctx.fillStyle = colour;
  ctx.fillText(text, ctx.canvas.width / 2, y);
}

// Scratch canvas holding a crisp copy of the readout, so the glitch pass can
// re-cut bands out of it. One reused buffer - the screens redraw every frame.
let tearCv = null;
function tearBuf() {
  if (!tearCv) {
    tearCv = document.createElement('canvas');
    tearCv.width = SCREEN_W;
    tearCv.height = SCREEN_H;
  }
  return tearCv;
}

/**
 * Draw the tower's HP readout.
 * @param {HTMLCanvasElement} cv
 * @param {number} ratio  hp / maxHp, 0..1
 * @param {string} label  override text; defaults to the percentage
 * @param {number} glitch 0..1, drives the slice-offset tearing
 * @param {number} seed   varies the tear pattern between frames
 */
function drawHpScreen(cv, ratio, label, glitch, seed) {
  const g = cv.getContext('2d');
  const w = SCREEN_W, h = SCREEN_H;
  g.clearRect(0, 0, w, h);

  // Screen body: a light panel with a faint scanline wash.
  g.fillStyle = SCREEN_BG;
  g.fillRect(0, 0, w, h);
  g.fillStyle = SCREEN_WASH;
  for (let y = 0; y < h; y += 4) g.fillRect(0, y, w, 2);

  const col = hpColour(ratio);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `400 ${Math.round(h * 0.46)}px ${SCREEN_FONT}`;

  // Repaint the panel inside a horizontal slice. The tear has to re-lay the
  // background before stamping the shifted slice: a bare clearRect would punch
  // an opaque black slot through the screen, because the plane ignores alpha.
  const repaintBand = (by, bh) => {
    g.save();
    g.beginPath();
    g.rect(0, by, w, bh);
    g.clip();
    g.fillStyle = SCREEN_BG;
    g.fillRect(0, by, w, bh);
    g.fillStyle = SCREEN_WASH;
    for (let y = by; y < by + bh; y += 4) g.fillRect(0, y, w, 2);
    g.restore();
  };

  if (glitch > 0) {
    // Render the readout once, crisply, into a scratch buffer. The tear then
    // slices THAT instead of re-stroking the text per band - re-stroking meant
    // three full copies of the label overlapping, which read as garbled
    // digits ("55%0%") rather than a damaged screen.
    const tb = tearBuf();
    const tg = tb.getContext('2d');
    tg.clearRect(0, 0, w, h);
    tg.textAlign = 'center';
    tg.textBaseline = 'middle';
    tg.font = g.font;
    inkedText(tg, label, h * 0.52, col);

    // Clean pass first, so the percentage is always legible.
    inkedText(g, label, h * 0.52, col);

    // Then cut three thin slices out of the snapshot and stamp them back a few
    // pixels sideways. The slices are NARROW and sit inside the glyph band
    // (~0.30h to ~0.72h). Cutting thirds of the whole screen instead shears
    // every digit into two misaligned halves, which reads as a broken font
    // rather than a damaged screen.
    const top = h * 0.30, band = h * 0.42;
    const bands = [
      { at: 0.05, hgt: 0.11, dx: (seed % 5) - 2 },
      { at: 0.36, hgt: 0.09, dx: ((seed + 3) % 7) - 3 },
      { at: 0.66, hgt: 0.10, dx: ((seed + 5) % 6) - 2 },
    ];
    for (const b of bands) {
      const off = Math.round(b.dx * (1 + glitch * 3));
      if (off === 0) continue;
      const by = Math.round(top + b.at * band);
      const bh = Math.round(b.hgt * band);
      g.save();
      g.beginPath();
      g.rect(0, by, w, bh);
      g.clip();
      repaintBand(by, bh);
      g.drawImage(tb, 0, by, w, bh, off, by, w, bh);
      // a red ghost of the same slice sells the "wrong signal" read
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = 0.35;
      g.drawImage(tb, 0, by, w, bh, -off, by, w, bh);
      g.globalAlpha = 1;
      g.restore();
    }
    const ty = ((seed * 37) % 100) / 100 * h;
    g.fillStyle = `rgba(255,255,255,${0.35 * glitch})`;
    g.fillRect(0, ty, w, 2);
  } else {
    g.fillStyle = col;
    g.fillText(label, w / 2, h * 0.52);
  }

  // Thin border so the screen reads as inset hardware.
  g.strokeStyle = 'rgba(90,70,40,0.4)';
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, w - 3, h - 3);
}

// ── tower construction ────────────────────────────────────────────────────
/**
 * @param {string} kind 'small' or 'king'
 * @param {number} x world x
 * @param {number} z world z
 * @param {string} side 'player' or 'enemy'
 */
function makeTower(kind, x, z, side) {
  const g = new THREE.Group();
  const isKing = kind === 'king';
  const maxHp = isKing ? TOWERS.kingMaxHp : TOWERS.smallMaxHp;

  const w = isKing ? 4.2 : 2.6;
  const h = isKing ? 5.4 : 3.5;
  const d = isKing ? 3.4 : 2.1;
  // Team tint, not two arbitrary accents: the fastest read on the board is
  // "which side is that", and the roof is what carries it.
  const ringCol = side === 'player' ? PALETTE.player : PALETTE.enemy;
  const shell = isKing ? PALETTE.towerStone : PALETTE.towerStoneLit;
  const top = 0.45 + h;

  // plinth: two stepped courses so the tower has a base to stand on
  g.add(decoBox(w + 1.0, 0.3, d + 1.0, PALETTE.towerStoneDark, { y: 0.15 }));
  g.add(decoBox(w + 0.5, 0.18, d + 0.5, PALETTE.stone, { y: 0.38 }));

  // main body
  g.add(vox(w, h, d, shell, { y: 0.45 + h / 2 }));
  // String courses top and bottom, and quoins up the corners. A full-height
  // inset panel was tried first and read as a blank billboard at this camera
  // distance - it competed with the HP screen, which is the one panel that
  // genuinely has to be legible.
  g.add(vox(w + 0.14, 0.34, d + 0.14, PALETTE.towerStoneLit, { y: 0.75 }));
  g.add(vox(w + 0.14, 0.34, d + 0.14, PALETTE.towerStoneLit, { y: top - 0.3 }));
  for (const dx of [-1, 1]) {
    for (const dz of [-1, 1]) {
      g.add(vox(0.36, h * 0.84, 0.36, PALETTE.towerStoneLit, {
        x: dx * (w / 2 - 0.16), z: dz * (d / 2 - 0.16), y: 0.45 + h / 2,
      }));
    }
  }
  // arrow-slit windows, so the body is not a blank wall of stone
  for (const dz of [-1, 1]) {
    const n = isKing ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const o = ((i / (n - 1)) - 0.5) * w * 0.5;
      g.add(decoBox(0.24, 0.5, 0.08, 0x4a3524, { x: o, y: 0.45 + h * 0.34, z: dz * (d / 2 + 0.05) }));
    }
  }

  // crenellations. At this camera distance a smooth cap reads as a box, and
  // the merlons are most of what says "castle".
  const merlon = 0.4;
  const n = isKing ? 4 : 3;
  for (let i = 0; i < n; i++) {
    const o = ((i / (n - 1)) - 0.5) * w * 0.74;
    for (const dz of [-1, 1]) {
      g.add(decoBox((w / n) * 0.5, merlon, 0.32, PALETTE.towerStoneLit,
        { x: o, y: top + merlon / 2, z: dz * (d / 2 - 0.18) }));
    }
  }
  for (const dx of [-1, 1]) {
    for (let i = 0; i < n; i++) {
      const o = ((i / (n - 1)) - 0.5) * d * 0.74;
      g.add(decoBox(0.32, merlon, (d / n) * 0.5, PALETTE.towerStoneLit,
        { x: dx * (w / 2 - 0.18), y: top + merlon / 2, z: o }));
    }
  }

  // team roof: a pitched cap in the side's colour, gold-rimmed. This is the
  // one saturated element on the model.
  g.add(decoBox(w + 0.34, 0.2, d + 0.34, PALETTE.gold, { y: top + 0.1 }));
  g.add(decoBox(w * 0.84, 0.42, d * 0.84, ringCol, { y: top + 0.4 }));
  g.add(decoBox(w * 0.58, 0.38, d * 0.58, ringCol, { y: top + 0.78 }));
  g.add(decoBox(w * 0.28, 0.3, d * 0.28, ringCol, { y: top + 1.1 }));

  // pennant on a mast, above the roof
  g.add(vox(0.1, 1.3, 0.1, 0x6b4a30, { x: w * 0.28, y: top + 1.8, z: -d * 0.2 }));
  g.add(decoBox(0.8, 0.44, 0.08, ringCol, { x: w * 0.28 + 0.44, y: top + 2.2, z: -d * 0.2 }));

  // guard at the door, in the same toy language as the roster
  const guard = new THREE.Group();
  guard.add(vox(0.3, 0.24, 0.26, 0x4a3524, { y: 0.12 }));
  guard.add(vox(0.44, 0.46, 0.38, ringCol, { y: 0.47 }));
  guard.add(vox(0.18, 0.26, 0.18, ringCol, { x: -0.29, y: 0.5 }));
  guard.add(vox(0.18, 0.26, 0.18, ringCol, { x: 0.29, y: 0.5 }));
  guard.add(vox(0.46, 0.44, 0.44, 0xf3d9b0, { y: 0.92 }));
  guard.add(vox(0.5, 0.14, 0.48, PALETTE.gold, { y: 1.15 }));
  guard.add(vox(0.1, 0.1, 0.05, 0x1a1a1a, { x: -0.11, y: 0.95, z: 0.23 }));
  guard.add(vox(0.1, 0.1, 0.05, 0x1a1a1a, { x: 0.11, y: 0.95, z: 0.23 }));
  guard.add(vox(0.44, 0.56, 0.05, 0x9aa4b0, { x: 0.38, y: 0.55, z: 0.26 }));
  guard.position.set(0, 0.45, d / 2 + 0.46);
  g.add(guard);

  // HP screen, facing both ways so the top-down camera always reads it.
  const cv = document.createElement('canvas');
  cv.width = SCREEN_W; cv.height = SCREEN_H;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const screenW = isKing ? 2.6 : 1.7;
  const screenH = screenW * (SCREEN_H / SCREEN_W);
  const screenY = 0.45 + h * 0.6;
  const faceMat = new THREE.MeshBasicMaterial({ map: tex });
  // Gold bezel, not a black one: the readout is a banner on a castle wall.
  g.add(vox(screenW + 0.22, screenH + 0.22, 0.1, PALETTE.gold, { y: screenY, z: d / 2 + 0.1 }));
  g.add(vox(screenW + 0.22, screenH + 0.22, 0.1, PALETTE.gold, { y: screenY, z: -d / 2 - 0.1 }));
  const mkScreen = (zOff) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(screenW, screenH), faceMat);
    m.position.set(0, screenY, zOff);
    if (zOff < 0) m.rotation.y = Math.PI;
    return m;
  };
  g.add(mkScreen(d / 2 + 0.16), mkScreen(-d / 2 - 0.16));

  // King gets a crown on the peak. Gold, so the objective is the first thing
  // the eye lands on and everything else is pointed at it.
  if (isKing) {
    const cy = top + 1.42;
    g.add(vox(1.4, 0.2, 1.4, PALETTE.goldDark, { y: cy - 0.3 }));
    g.add(vox(1.12, 0.38, 1.12, PALETTE.gold, { y: cy - 0.04 }));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      g.add(vox(0.28, 0.46, 0.28, PALETTE.gold, { x: Math.cos(a) * 0.4, z: Math.sin(a) * 0.4, y: cy + 0.36 }));
    }
    g.add(vox(0.26, 0.26, 0.26, ringCol, { y: cy + 0.7 }));
  }

  g.position.set(x, 0, z);
  g.rotation.y = side === 'player' ? 0 : Math.PI;

  const range = isKing ? (TOWERS.kingRange || 7.0) : (TOWERS.smallRange || 7.5);
  const fireRate = isKing ? (TOWERS.kingFireRate || 1.0) : (TOWERS.smallFireRate || 0.9);
  const damage = isKing ? (TOWERS.kingDamage || 55) : (TOWERS.smallDamage || 42);

  const tower = {
    kind, side, x, z,
    mesh: g, cv, tex, maxHp, hp: maxHp,
    glitch: 0, seed: 0,
    destroyed: false,
    wrecked: false,
    range,
    fireRate,
    damage,
    cooldown: Math.random() * 0.3,
    target: null,
  };

  drawHpScreen(cv, 1, '100%', 0, 0);
  tex.needsUpdate = true;
  return tower;
}

/**
 * Apply damage. Phases 3+ call this; phase 1 uses it to exercise the glitch.
 * @param {object} tower
 * @param {number} amount
 * @returns {boolean} true if this hit destroyed the tower
 */
// Hit listener, set by main.js. towers.js has no DOM and no camera, so the
// damage number cannot be raised here directly - the UI layer subscribes and
// projects the tower's world position itself. Default null so the towers stay
// renderable with no HUD at all.
let hitListener = null;
export function setHitListener(fn) { hitListener = fn; }

// Wreck listener, raised once per tower when the shatter begins - the moment
// the roof comes off, NOT when the stump finishes sinking. main.js subscribes
// and throws rubble and shakes the camera. Late by a whole second is too late:
// the shake has to land with the collapse, or the impact is silent.
let wreckListener = null;
export function setWreckListener(fn) { wreckListener = fn; }

export function damageTower(tower, amount) {
  if (tower.destroyed) return false;
  tower.hp = Math.max(0, tower.hp - amount);
  tower.glitch = 1;
  tower.seed = (tower.seed + 7) % 1000;
  if (tower.hp <= 0) {
    // `destroyed` flips immediately so nothing can target the corpse, but the
    // model stays up and lit for the next third of a second. The kill and the
    // collapse are deliberately not the same event.
    tower.destroyed = true;
    beginDeath(tower);
    if (hitListener) hitListener(tower, amount, true);
    return true;
  }
  if (hitListener) hitListener(tower, amount, false);
  return false;
}

/**
 * How tall a tower is, used to scale the death animation.
 *
 * A fixed shake amplitude and a fixed sink depth look wrong on both towers: a
 * 3.5-unit small tower juddering a full 0.4 units looks like it is falling
 * over, and a 5.4-unit king sinking the same amount barely registers. Both are
 * derived from height so the collapse reads at the same apparent rate.
 * @param {object} tower
 * @returns {number}
 */
function towerHeight(tower) {
  return tower.kind === 'king' ? 5.4 : 3.5;
}

/**
 * Begin the three-step death: shake, shatter, wreck.
 *
 * The previous version did all three in a single frame - the tower just
 * appeared tipped over and half-buried, with no transition. That reads as a
 * bug rather than as a kill, and the player never gets to watch the thing
 * they spent three minutes working towards actually come down.
 *
 * Driven from buildTowers' update() rather than from timers, so the collapse
 * freezes with the rest of the simulation when the match does (main.js stops
 * calling update once matchLive is false). A tower that keeps sinking after
 * the result screen is up is the game losing track of its own state.
 *
 * `destroyed` has already flipped by the time this is called, so the tower is
 * already untargetable - the kill and the collapse are deliberately separate
 * events that happen to start together.
 *
 * @param {object} tower
 */
function beginDeath(tower) {
  if (tower.deathStep) return;
  tower.deathStep = 'shaking';
  tower.deathT = 0;
  // Ground level is the baseline both steps animate away from, captured once
  // so the shake and the sink do not each re-derive it and drift apart.
  tower.baseY = tower.mesh.position.y;
  tower.baseRotZ = tower.mesh.rotation.z;
  tower.height = towerHeight(tower);
}

/**
 * Advance one tower's death animation by dt seconds.
 *
 * A string step rather than three booleans: no combination of booleans can be
 * simultaneously true, and the state is legible in the dev probe.
 * @param {object} tower
 * @param {number} dt
 */
function stepDeath(tower, dt) {
  tower.deathT += dt;
  const m = tower.mesh;
  const h = tower.height;

  if (tower.deathStep === 'shaking') {
    // Decaying judder, driven off deathT rather than re-rolled per frame:
    // re-rolling at 60fps is white noise, and this has to read as one
    // continuous shudder travelling through the structure.
    const k = 1 - tower.deathT / TOWERS.deathShake;
    const amp = 0.09 * h * k;
    m.position.x = tower.x + Math.sin(tower.deathT * 47) * amp;
    m.position.y = tower.baseY + Math.sin(tower.deathT * 63) * amp * 0.35;
    // The readout is pinned wide open for the whole shake, so KO arrives
    // already flaring instead of switching cleanly to a static red 0%.
    tower.glitch = Math.max(tower.glitch, 0.55 + 0.45 * k);
    if (tower.deathT >= TOWERS.deathShake) {
      m.position.set(tower.x, tower.baseY, tower.z);
      tower.deathStep = 'shattering';
      tower.deathT = 0;
      if (wreckListener) wreckListener(tower);
    }
    return;
  }

  if (tower.deathStep === 'shattering') {
    // The roof, crown and neon die here. Scaling the meshes rather than
    // touching the material, because voxel.js shares materials between every
    // tower in the game and disposing or recolouring one would recolour all six.
    for (const child of m.children) {
      const isNeon = child.material && child.material.isMeshBasicMaterial && !child.material.map;
      if (isNeon) child.scale.setScalar(0.001);
    }
    tower.glitch = 1;
    if (tower.deathT >= TOWERS.deathShatter) {
      tower.deathStep = 'wrecking';
      tower.deathT = 0;
    }
    return;
  }

  if (tower.deathStep === 'wrecking') {
    // Ease the sink and tip so it beds into the ground rather than stopping
    // dead. Linear reads as the mesh being dragged down by a script.
    const k = Math.min(1, tower.deathT / TOWERS.deathWreck);
    const ease = 1 - (1 - k) * (1 - k);
    m.position.y = tower.baseY - 1.4 * (h / 3.5) * ease;
    m.rotation.z = tower.baseRotZ
      + 0.16 * (tower.side === 'player' ? 1 : -1) * ease;
    if (k >= 1) {
      tower.deathStep = 'wrecked';
      tower.wrecked = true;
    }
  }
}

// ── public ────────────────────────────────────────────────────────────────
export function buildTowers() {
  const root = new THREE.Group();
  const towers = [];

  for (const side of ['player', 'enemy']) {
    const sign = side === 'player' ? 1 : -1;
    towers.push(makeTower('king', TOWERS.king.x, TOWERS.king.z * sign, side));
    for (const s of TOWERS.small) {
      towers.push(makeTower('small', s.x, s.z * sign, side));
    }
  }
  for (const t of towers) root.add(t.mesh);

  function isTowerActive(tower) {
    if (tower.destroyed) return false;
    if (tower.kind !== 'king') return true;
    if (tower.hp < tower.maxHp) return true;
    return towers.some((t) => t.side === tower.side && t.kind === 'small' && t.destroyed);
  }

  function update(dt, combat = null) {
    for (const t of towers) {
      if (t.deathStep) stepDeath(t, dt);
      const ratio = t.hp / t.maxHp;
      const label = t.destroyed ? 'KO' : `${Math.ceil(ratio * 100)}%`;
      if (t.holdGlitch) {
        // Test-only: pin the tear open so a screenshot can actually catch it.
        // In a real match nothing sets this; the glitch decays as normal.
        t.glitch = 1;
        t.seed = (t.seed + 7) % 1000;
      } else if (t.glitch > 0) {
        t.glitch = Math.max(0, t.glitch - dt * 3.2);
      }
      drawHpScreen(t.cv, ratio, label, t.glitch, t.seed + Math.floor(t.glitch * 30));
      t.tex.needsUpdate = true;

      // Active tower defense shooting
      if (combat && combat.troops && isTowerActive(t)) {
        t.cooldown -= dt;
        const enemySide = t.side === 'player' ? 'enemy' : 'player';
        const isTargetValid = (u) => u && !u.dead && Math.hypot(u.x - t.x, u.z - t.z) <= t.range;

        if (!isTargetValid(t.target)) {
          t.target = null;
          const candidates = combat.troops.troops.filter((u) => !u.dead && u.side === enemySide);
          let bestDist = t.range;
          let bestTroop = null;
          for (const u of candidates) {
            const d = Math.hypot(u.x - t.x, u.z - t.z);
            if (d < bestDist) {
              bestDist = d;
              bestTroop = u;
            }
          }
          t.target = bestTroop;
        }

        if (t.target && t.cooldown <= 0) {
          t.cooldown = t.fireRate;
          const tgt = t.target;
          const dmg = t.damage;
          const startY = t.kind === 'king' ? 5.2 : 3.6;

          if (combat.audio) combat.audio.play('arrow');

          const onHitCallback = () => {
            if (!tgt || tgt.dead) return;
            tgt.hp -= dmg;
            if (combat.vfx && combat.vfx.hitSparks) {
              combat.vfx.hitSparks(tgt.x, 1.4, tgt.z, 0xffe066);
            }
            if (tgt.hp <= 0) {
              tgt.dead = true;
              tgt.deathT = 0.26;
              if (combat.vfx && combat.vfx.koPoof) {
                combat.vfx.koPoof(tgt.x, tgt.z, tgt.card ? tgt.card.color : 0xffffff);
              }
              if (combat.audio) combat.audio.play('pop');
            }
            if (combat.onHit) combat.onHit(tgt, dmg);
          };

          const shotColor = t.side === 'player' ? 0x6fe6ff : 0xff7b54;
          if (combat.vfx && combat.vfx.towerProjectile) {
            combat.vfx.towerProjectile(t.x, startY, t.z, tgt, 18, onHitCallback, shotColor);
          } else if (combat.vfx && combat.vfx.arrowProjectile) {
            combat.vfx.arrowProjectile(t.x, startY, t.z, tgt, 18, onHitCallback, shotColor);
          } else {
            onHitCallback();
          }
        }
      }
    }
  }

  function reset() {
    for (const t of towers) {
      const old = t.mesh;
      // makeTower returns the whole tower record - the scene graph is the
      // .mesh inside it. Storing the record in t.mesh used to be what happened
      // here, and root.add() then refused it as "not an instance of
      // Object3D", so every match started by taking all six towers off the
      // board and never putting them back. The record object itself is kept,
      // because main.js and the death animation both hold these references.
      const fresh = makeTower(t.kind, t.x, t.z, t.side);
      t.hp = t.maxHp;
      t.destroyed = false;
      t.wrecked = false;
      t.deathStep = null;
      t.deathT = 0;
      t.glitch = 0;
      t.height = 0;
      t.range = fresh.range;
      t.fireRate = fresh.fireRate;
      t.damage = fresh.damage;
      t.cooldown = Math.random() * 0.3;
      t.target = null;
      t.mesh = fresh.mesh;
      // The HP screen is painted into this tower's own canvas, so the new mesh
      // and the record have to agree on which canvas that is. Swapping the mesh
      // alone would leave the fresh screens wired to a canvas nothing draws
      // into - a frozen 100% that never shows another hit.
      t.cv = fresh.cv;
      t.tex = fresh.tex;
      root.remove(old);
      root.add(t.mesh);
    }
  }

  return { root, towers, update, reset, damageTower };
}