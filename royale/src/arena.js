// ── arena.js ──────────────────────────────────────────────────────────────
// The arena: a sunny grass field split by a river, three brick lanes running
// its length, stone bridges over the water, and torch-lit banners along the
// edges with a crowd in tiered stands behind.
//
// Footprint is unchanged from the old trading floor: same ARENA numbers, same
// PIT half-extents, same bridge position. Only the material and the dressing
// are new, so nothing in towers.js or ui.js had to move.

import * as THREE from 'three';
import { vox, decoBox, neonBox } from './voxel.js';
import { PALETTE, ARENA } from './config.js';

const HW = ARENA.halfWidth;
const HL = ARENA.halfLength;

// The crossing. Same extent as the old recessed chasm - it is now water.
// The numbers themselves moved to ARENA.river in config.js, because troops.js
// has to answer "can I stand here" with the same footprint the water was drawn
// from rather than a second literal that can drift away from this one.
const PIT = ARENA.river;

// ── textures ──────────────────────────────────────────────────────────────
/**
 * Two-tone checkerboard for the grass. A flat green slab reads as a
 * placeholder; the checker gives the eye something to measure movement
 * against, which is what makes a lane feel like ground you cross.
 */
function grassTexture() {
  const cv = document.createElement('canvas');
  cv.width = 128;
  cv.height = 128;
  const g = cv.getContext('2d');
  const cell = 64;
  g.fillStyle = '#6cc24a';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#5ab03c';
  g.fillRect(0, 0, cell, cell);
  g.fillRect(cell, cell, cell, cell);
  // A little tooth so the fill is not a flat plane under the key light.
  for (let i = 0; i < 90; i++) {
    g.fillStyle = i % 2 ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)';
    g.fillRect((i * 53) % 128, (i * 91) % 128, 7, 4);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Staggered brick courses for the lane paths and the bridge deck. */
function brickTexture(base, mortar, brick) {
  const cv = document.createElement('canvas');
  cv.width = 128;
  cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = mortar;
  g.fillRect(0, 0, 128, 128);
  const rows = 6;
  const h = 128 / rows;
  for (let r = 0; r < rows; r++) {
    const cols = 4;
    const w = 128 / cols;
    // Stagger every other course, or the mortar reads as a grid not a wall.
    const off = (r % 2) * (w / 2);
    for (let c = -1; c <= cols; c++) {
      g.fillStyle = c % 2 === r % 2 ? brick : base;
      g.fillRect(c * w + off + 1, r * h + 1, w - 2, h - 2);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ── ground ────────────────────────────────────────────────────────────────
function buildFloor() {
  const g = new THREE.Group();
  const runLen = HL - PIT.halfL;

  // One grass texture, cloned per slab so each can carry its own repeat and
  // offset without the slabs fighting over a single shared transform.
  const makeSlab = (w, d, x, z) => {
    const t = grassTexture();
    t.repeat.set(w / 3.2, d / 3.2);
    t.offset.set((x + HW) / 6.4, (z + HL) / 6.4);
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshLambertMaterial({ map: t })
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0, z);
    m.receiveShadow = true;
    return m;
  };

  g.add(makeSlab(HW * 2, runLen, 0, -(PIT.halfL + runLen / 2)));
  g.add(makeSlab(HW * 2, runLen, 0, PIT.halfL + runLen / 2));
  const sideW = HW - PIT.halfW;
  const sideX = PIT.halfW + sideW / 2;
  g.add(makeSlab(sideW, PIT.halfL * 2, -sideX, 0));
  g.add(makeSlab(sideW, PIT.halfL * 2, sideX, 0));

  // Riverbed: a dark sand shelf, then the water surface below the grass line
  // so the drop to the crossing is legible from the top-down camera.
  g.add(vox(HW * 2, 0.6, PIT.halfL * 2, 0xc4a878, { y: -1.1 }));
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(HW * 2 - 0.3, PIT.halfL * 2 - 0.3),
    new THREE.MeshLambertMaterial({ color: PALETTE.water })
  );
  water.rotation.x = -Math.PI / 2;
  water.position.y = -0.62;
  g.add(water);

  // Foam along both banks, as unlit strips just proud of the water.
  for (const sz of [-1, 1]) {
    g.add(neonBox(HW * 2 - 0.6, 0.05, 0.26, PALETTE.foam, { y: -0.56, z: sz * (PIT.halfL - 0.2) }));
  }

  // Stone kerb framing the whole field, so the grass does not just stop.
  for (const sx of [-1, 1]) {
    g.add(vox(0.9, 0.8, HL * 2 + 1.8, PALETTE.stone, { x: sx * (HW + 0.45), y: -0.1 }));
  }
  for (const sz of [-1, 1]) {
    g.add(vox(HW * 2 + 1.8, 0.8, 0.9, PALETTE.stone, { z: sz * (HL + 0.45), y: -0.1 }));
  }
  return g;
}

// ── lanes ─────────────────────────────────────────────────────────────────
function buildLanes() {
  const g = new THREE.Group();
  const runLen = HL - PIT.halfL;

  for (const x of ARENA.laneX) {
    const t = brickTexture('#c9b79a', '#8a7857', '#b8a385');
    t.repeat.set(1, runLen / 2.2);
    const mat = new THREE.MeshLambertMaterial({ map: t });
    const w = ARENA.laneWidth;

    // Two straight runs either side of the river; the bridge carries the lane
    // across, so the path never breaks.
    for (const sz of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, runLen), mat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.04, sz * (PIT.halfL + runLen / 2));
      m.receiveShadow = true;
      g.add(m);
    }
  }
  return g;
}

// ── bridge ────────────────────────────────────────────────────────────────
function buildBridge() {
  const g = new THREE.Group();
  const deckW = ARENA.laneWidth + 0.7;
  const span = PIT.halfL * 2 + 1.4;

  // Stone abutments at each bank.
  for (const sz of [-1, 1]) {
    g.add(vox(deckW, 1.5, 1.6, PALETTE.stone, { y: -0.45, z: sz * (PIT.halfL + 0.3) }));
  }

  // Timber deck: individual planks with gaps, so it reads as a bridge and not
  // as a grey slab laid on the water. The wood is a warm tan, not a dark
  // brown: a dark span across the middle of the frame read as a monument and
 // pulled the eye off the towers, which are the things you actually play.
  // Planks are 0.3 wide on a 0.52 pitch, not 0.34 on 0.42. The tighter pitch
  // left 0.08-unit gaps, which is sub-pixel at the default camera distance, so
  // the deck rendered as one flat tan slab instead of as timber.
  for (let z = -PIT.halfL - 0.6; z <= PIT.halfL + 0.6; z += 0.52) {
    g.add(vox(deckW, 0.22, 0.3, 0xd8a468, { y: 0.12, z }));
    g.add(vox(deckW, 0.06, 0.3, 0xe8bd86, { y: 0.24, z }));
  }
  g.add(vox(deckW + 0.5, 0.2, span, 0xb9854c, { y: -0.02 }));

  // Rope-and-post rails, gold-capped.
  for (const ex of [-deckW / 2 - 0.16, deckW / 2 + 0.16]) {
    for (let z = -PIT.halfL - 0.6; z <= PIT.halfL + 0.6; z += 1.35) {
      g.add(vox(0.18, 0.9, 0.18, 0x9c6b3f, { x: ex, y: 0.5, z }));
      g.add(vox(0.26, 0.2, 0.26, PALETTE.gold, { x: ex, y: 1.02, z }));
    }
    g.add(vox(0.1, 0.12, span, PALETTE.goldDark, { x: ex, y: 0.94 }));
  }
  return g;
}

// ── decoration ────────────────────────────────────────────────────────────
/**
 * Torches, banners, crowd and clouds. Purely dressing, so it is built from
 * decoBox / neonBox: none of it casts or receives shadow, which is hundreds
 * of shadow passes nobody can see.
 * @returns {{root: THREE.Group, flames: Array<object>}}
 */
function buildDecor() {
  const g = new THREE.Group();
  const flames = [];

  // Torches down both long edges of the field. Each is a post, a bowl, a flame
  // and a glow; the flame is scaled per-frame by update().
  const torch = (x, z) => {
    const t = new THREE.Group();
    t.add(vox(0.24, 2.6, 0.24, 0x7a5636, { y: 1.3 }));
    t.add(decoBox(0.6, 0.3, 0.6, PALETTE.stoneDark, { y: 2.7 }));
    const flame = decoBox(0.42, 0.72, 0.42, PALETTE.flame, { y: 3.2 });
    const core = decoBox(0.22, 0.4, 0.22, PALETTE.flameCore, { y: 3.24 });
    const glow = new THREE.Mesh(
      new THREE.BoxGeometry(0.95, 0.95, 0.95),
      new THREE.MeshBasicMaterial({ color: PALETTE.flame, transparent: true, opacity: 0.22 })
    );
    glow.position.y = 3.2;
    t.add(flame, core, glow);
    t.position.set(x, 0, z);
    g.add(t);
    flames.push({ flame, core, glow, phase: (x * 3.1 + z * 1.7) % 6.28 });
  };

  for (let z = -HL + 2.4; z <= HL - 2.4; z += 6.2) {
    torch(-(HW - 0.7), z);
    torch(HW - 0.7, z);
  }

  // Banners: a pole, a gold finial, and a cloth panel in the team colour of
  // whichever half of the field it stands in.
  const banner = (x, z, tint, flip) => {
    const b = new THREE.Group();
    b.add(vox(0.2, 4.2, 0.2, 0x6b4a30, { y: 2.1 }));
    b.add(decoBox(0.5, 0.5, 0.5, PALETTE.gold, { y: 4.35 }));
    // Swallow-tail cut: a wide panel with a notch punched out of the bottom.
    b.add(decoBox(1.7, 2.3, 0.16, tint, { x: 0.9 * flip, y: 2.5 }));
    b.add(decoBox(1.0, 0.5, 0.17, tint, { x: 1.2 * flip, y: 1.05 }));
    b.add(decoBox(1.5, 0.22, 0.19, PALETTE.gold, { x: 0.9 * flip, y: 3.55 }));
    b.position.set(x, 0, z);
    g.add(b);
  };

  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) {
      banner(sx * (HW - 1.1), sz * (HL - 3.2), sz > 0 ? PALETTE.player : PALETTE.enemy, sx);
    }
  }

  // Crowd stands behind each end. Three tiers of seating and a block of
  // coloured dots for the people - the dots are the whole point, a stand of
  // empty stone reads as scaffolding.
  const stand = (z, facing) => {
    const s = new THREE.Group();
    for (let tier = 0; tier < 3; tier++) {
      const y = 0.9 + tier * 1.0;
      const depth = 2.2;
      const zz = facing * (2.0 + tier * depth);
      s.add(decoBox(HW * 2 + 4, 1.0, depth, PALETTE.stoneDark, { y: y - 0.5, z: zz }));
      const n = 22;
      for (let i = 0; i < n; i++) {
        const x = -((HW + 1.6) - (i / (n - 1)) * (HW + 1.6) * 2);
        // Skip a scatter of seats so the block is not a picket fence.
        if ((i * 7 + tier * 3) % 9 === 0) continue;
        const col = (i * 53 + tier * 29) % 3;
        const c = col === 0 ? PALETTE.crowd : col === 1 ? PALETTE.player : PALETTE.enemy;
        s.add(decoBox(0.5, 0.66, 0.5, c, { x, y: y + 0.33, z: zz }));
        s.add(decoBox(0.42, 0.4, 0.42, 0xf3d9b0, { x, y: y + 0.82, z: zz }));
      }
    }
    s.position.z = z;
    g.add(s);
  };
  stand(-HL - 1.5, -1);
  stand(HL + 1.5, 1);

  // Clouds: flat-bottomed puffs parked well above and behind the field. They
  // sit in front of the sky gradient, which is what sells the gradient as air
  // rather than as a background image.
  const cloud = (x, y, z, s) => {
    const c = new THREE.Group();
    const puffs = [
      [0, 0, 0, 3.4], [2.4, -0.3, 0, 2.5], [-2.3, -0.4, 0, 2.2],
      [1.0, 0.9, 0, 2.0], [-1.2, 0.7, 0, 1.8],
    ];
    for (const [px, py, pz, pr] of puffs) {
      c.add(decoBox(pr * 2, pr * 1.5, pr * 1.7, PALETTE.cloud, { x: px, y: py, z: pz }));
    }
    for (const [px, py, pz, pr] of puffs) {
      c.add(decoBox(pr * 1.9, pr * 0.5, pr * 1.68, PALETTE.cloudShade, { x: px, y: py - pr * 0.78, z: pz }));
    }
    c.position.set(x, y, z);
    c.scale.setScalar(s);
    return c;
  };
  g.add(cloud(-30, 30, -54, 1.5), cloud(24, 34, -62, 1.9), cloud(46, 28, -46, 1.2),
    cloud(-52, 26, -40, 1.1), cloud(4, 40, -76, 2.4));

  return { root: g, flames };
}

// ── public ────────────────────────────────────────────────────────────────
export function buildArena() {
  const root = new THREE.Group();
  const floor = buildFloor();
  const lanes = buildLanes();
  const bridge = buildBridge();
  const decor = buildDecor();
  root.add(floor, lanes, bridge, decor.root);

  let acc = 0;

  function update(dt) {
    acc += dt;
    // Torch flicker on two out-of-phase sines, so the field breathes instead
    // of strobing. Cheap: a scale write on two boxes per torch.
    for (const f of decor.flames) {
      const p = f.phase + acc * 7.3;
      const s = 0.86 + Math.sin(p) * 0.12 + Math.sin(p * 2.7) * 0.05;
      f.flame.scale.set(1, s, 1);
      f.core.scale.set(1, 0.9 + s * 0.2, 1);
      f.glow.material.opacity = 0.16 + (s - 0.86) * 0.9;
    }
  }

  return { root, update };
}