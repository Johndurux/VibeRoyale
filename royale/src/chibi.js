// ── chibi.js ──────────────────────────────────────────────────────────────
// The VibeOffice chibi look, ported. The character silhouettes come from the
// VibeOffice project's characterBuilder.js: blocky chibi proportions (huge
// head, short legs), every box wrapped in a dark inverted-hull outline, and
// glowing square eyes. The models here are that project's nine office
// residents, re-keyed to the VibeRoyale roster one-for-one:
//
//   armor -> Aureus        mist -> Specter      pip -> Boba
//   honey -> Volt          goggles -> Cyber Oak captain -> Ranger Blue
//   lavender -> Usagi      tux -> Sir Shade     mrhat -> Minty Cap
//
// What changed against the VibeOffice original, and why:
//  - MeshLambertMaterial, not MeshStandardMaterial. voxel.js lights the whole
//    arena with a hemisphere + directional pair and shades every prop with
//    Lambert; a Standard-material character in that rig reads as a different
//    render pass standing on the floor. Lambert carries emissive exactly as
//    well, so the glowing eyes and neon visors survive.
//  - Merged geometries and materials are cached per part signature, the same
//    policy as voxel.js's GEO/MAT caches. A match spawns and clears dozens of
//    units; building a fresh material set per spawn would leak GPU programs
//    the way the old per-mesh materials did before the caches existed.
//  - The 1.48 world-scale multiplier is dropped in favour of CHIBI_SCALE,
//    which matches the silhouette height the towers and lanes were tuned
//    against (head top ~2.4 world units).
//  - The animation contract is VibeRoyale's, not userData: the returned group
//    exposes legL/legR/armL/armR pivots, which is what troops.js swings.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Old roster silhouette: leg pivot at 0.42, head top at ~2.36. The chibi
// rig puts its head top at 2.575 at scale 1.0, so 0.92 lands the crown back
// at the height the deploy rings, tower ranges and camera framing expect.
const CHIBI_SCALE = 0.92;

// ── outline materials ─────────────────────────────────────────────────────
// Inverted hull, VibeOffice style: a dark expanded copy of every box drawn
// BackSide, so the silhouette gets a clean cartoon rim. The ghost instead
// wears a glowing tosca hull on each merged body part. Created lazily so the
// Node stub never has to construct a material at import time.

let outlineMat = null;
let ghostOutlineMat = null;

function getOutlineMat() {
  if (!outlineMat) {
    outlineMat = new THREE.MeshBasicMaterial({
      color: 0x1a1a1a,
      side: THREE.BackSide,
    });
    outlineMat.userData.shared = true;
  }
  return outlineMat;
}

function getGhostOutlineMat() {
  if (!ghostOutlineMat) {
    // Tosca hologram rim, lifted verbatim from the VibeOffice ghost.
    ghostOutlineMat = new THREE.MeshBasicMaterial({
      color: 0x3fe0c5,
      side: THREE.BackSide,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    ghostOutlineMat.userData.shared = true;
  }
  return ghostOutlineMat;
}

// ── merged-part cache ─────────────────────────────────────────────────────
// One cache entry per (part definition, default colour, ghostness). The
// entry holds the merged geometry, its expanded outline geometry, and the
// material each merged colour group shares. buildPart() then assembles fresh
// Mesh objects around the cached buffers, so N units on the field cost N
// meshes but one geometry and one material per colour group.
//
// The signature is the JSON of the box defs plus the two flags. Defs are
// static per character part, so this hashes a few dozen small objects once
// per part for the whole session.

const PART_CACHE = new Map();

function partSignature(defs, defaultColor, isGhost) {
  return JSON.stringify([defs, defaultColor, isGhost]);
}

function mergeBoxDefs(defs, defaultColor) {
  // Group boxes by material key, merge each group into one geometry, and
  // collect the expanded hull boxes for the outline pass.
  const groups = new Map();
  const outlineGeos = [];

  for (const b of defs) {
    const size = b.size || [1, 1, 1];
    const pos = b.pos || [0, 0, 0];
    const rot = b.rot || [0, 0, 0];

    const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
    geo.rotateX(rot[0]);
    geo.rotateY(rot[1]);
    geo.rotateZ(rot[2]);
    geo.translate(pos[0], pos[1], pos[2]);

    const color = b.color !== undefined ? b.color : defaultColor;
    const emissive = b.emissive || 0;
    const emissiveIntensity = b.emissiveIntensity || 0;
    const transparent = !!b.transparent;
    const opacity = b.opacity !== undefined ? b.opacity : 1.0;
    const hasOutline = !b.noOutline;
    const key = `${color}_${emissive}_${emissiveIntensity}_${transparent}_${opacity}`;

    if (!groups.has(key)) {
      groups.set(key, { geos: [], opts: { color, emissive, emissiveIntensity, transparent, opacity }, hasOutline });
    }
    groups.get(key).geos.push(geo);

    if (hasOutline) {
      const t = 0.055;
      const hullGeo = new THREE.BoxGeometry(size[0] + t, size[1] + t, size[2] + t);
      hullGeo.rotateX(rot[0]);
      hullGeo.rotateY(rot[1]);
      hullGeo.rotateZ(rot[2]);
      hullGeo.translate(pos[0], pos[1], pos[2]);
      outlineGeos.push(hullGeo);
    }
  }

  const parts = [];
  for (const { geos, opts } of groups.values()) {
    if (!geos.length) continue;
    const merged = mergeGeometries(geos, false);
    parts.push({ geo: merged, opts });
  }
  const outlineGeo = outlineGeos.length ? mergeGeometries(outlineGeos, false) : null;
  return { parts, outlineGeo };
}

function lambertPartMat(opts) {
  // Emissive eyes and neon visors are what make the chibi faces read at
  // arena distance, so they ride the material rather than a second unlit
  // mesh. Materials are cached by the same key the merge used.
  const mat = new THREE.MeshLambertMaterial({
    color: opts.color,
    transparent: opts.transparent,
    opacity: opts.opacity,
    depthWrite: opts.transparent ? false : true,
    emissive: opts.emissive ? opts.emissive : 0x000000,
    emissiveIntensity: opts.emissiveIntensity || 0,
  });
  mat.userData.shared = true;
  return mat;
}

/**
 * Build one body part as a Group of merged meshes plus (for non-ghost parts)
 * a single outline mesh. Cached: the expensive merge runs once per signature.
 * @param {Array<object>} defs box definitions
 * @param {number} defaultColor fallback colour for boxes without one
 * @param {boolean} [isGhost] swap the dark silhouette for the tosca hull
 * @returns {THREE.Group}
 */
function buildPart(defs, defaultColor, isGhost = false) {
  const container = new THREE.Group();
  if (!defs || !defs.length) return container;

  const sig = partSignature(defs, defaultColor, isGhost);
  let entry = PART_CACHE.get(sig);
  if (!entry) {
    const { parts, outlineGeo } = mergeBoxDefs(defs, defaultColor);
    for (const p of parts) p.mat = lambertPartMat(p.opts);
    entry = { parts, outlineGeo };
    PART_CACHE.set(sig, entry);
  }

  for (const p of entry.parts) {
    const mesh = new THREE.Mesh(p.geo, p.mat);
    mesh.castShadow = !p.opts.transparent;
    mesh.receiveShadow = true;
    container.add(mesh);

    // Ghost hull: each merged body part gets its own slightly larger tosca
    // copy. Scale on the mesh, so the cached geometry is shared untouched.
    if (isGhost) {
      const hull = new THREE.Mesh(p.geo, getGhostOutlineMat());
      hull.scale.set(1.04, 1.04, 1.04);
      container.add(hull);
    }
  }

  if (!isGhost && entry.outlineGeo) {
    const outlineMesh = new THREE.Mesh(entry.outlineGeo, getOutlineMat());
    outlineMesh.renderOrder = -1;
    container.add(outlineMesh);
  }

  return container;
}

// ── the roster ────────────────────────────────────────────────────────────
// Nine VibeOffice residents, verbatim except where noted. Field names match
// the VibeOffice config shape (baseColor, accessoryVoxels, glowingEyes, ...)
// so a future model can be lifted across unchanged.

export const CHIBI_MODELS = {
  // ARMOR <- Aureus (Gold Sentinel): gold plating, antenna with a glowing
  // cube, black belt, split glowing eyes.
  armor: {
    baseColor: 0xd4a359,
    limbColor: 0xc4944a,
    gloveColor: 0x1f1912,
    legColor: 0xb5853f,
    shoeColor: 0x1f1912,
    glowingEyes: true,
    pupilColor: 0xffe600,
    accessoryVoxels: [
      { size: [0.10, 0.55, 0.10], pos: [0, 0.90, 0], color: 0x785e33 },
      { size: [0.28, 0.28, 0.28], pos: [0, 1.22, 0], color: 0xffea00, emissive: 0xffd000, emissiveIntensity: 2.5 },
      { size: [0.18, 0.26, 0.26], pos: [-0.76, 0.05, 0], color: 0x9a7437 },
      { size: [0.18, 0.26, 0.26], pos: [0.76, 0.05, 0], color: 0x9a7437 },
    ],
    bodyVoxels: [
      { size: [1.05, 0.92, 0.78], pos: [0, 0, 0], color: 0xd4a359 },
      { size: [0.74, 0.60, 0.12], pos: [0, 0.06, 0.42], color: 0xb5853f, noOutline: true },
      { size: [1.08, 0.16, 0.80], pos: [0, -0.36, 0], color: 0x1f1912, noOutline: true },
    ],
  },

  // MIST <- Specter (Tosca Ghost): translucent tosca body, skull face, no
  // dark outline (the glowing tosca hull replaces it), drifting particles.
  mist: {
    isGhost: true,
    baseColor: 0xa8e6df,
    limbColor: 0xa8e6df,
    gloveColor: 0x3fe0c5,
    legColor: 0x88dbd1,
    shoeColor: 0x3fe0c5,
    hasParticles: true,
    particleColor: 0x3fe0c5,
    customEyes: true,
    headVoxels: [
      {
        size: [1.45, 1.25, 1.28], pos: [0, 0, 0], color: 0xa8e6df,
        transparent: true, opacity: 0.50, emissive: 0x3fe0c5, emissiveIntensity: 0.6,
      },
      { size: [0.44, 0.44, 0.24], pos: [-0.36, 0.08, 0.58], color: 0x051a14, noOutline: true },
      { size: [0.44, 0.44, 0.24], pos: [0.36, 0.08, 0.58], color: 0x051a14, noOutline: true },
      { size: [0.15, 0.15, 0.15], pos: [-0.34, 0.08, 0.62], color: 0x3fe0c5, emissive: 0x3fe0c5, emissiveIntensity: 2.5, noOutline: true },
      { size: [0.15, 0.15, 0.15], pos: [0.34, 0.08, 0.62], color: 0x3fe0c5, emissive: 0x3fe0c5, emissiveIntensity: 2.5, noOutline: true },
      { size: [0.16, 0.20, 0.16], pos: [0, -0.12, 0.60], color: 0x051a14, noOutline: true },
      { size: [0.10, 0.14, 0.10], pos: [-0.24, -0.32, 0.61], color: 0x051a14, noOutline: true },
      { size: [0.10, 0.14, 0.10], pos: [-0.08, -0.32, 0.61], color: 0x051a14, noOutline: true },
      { size: [0.10, 0.14, 0.10], pos: [0.08, -0.32, 0.61], color: 0x051a14, noOutline: true },
      { size: [0.10, 0.14, 0.10], pos: [0.24, -0.32, 0.61], color: 0x051a14, noOutline: true },
    ],
    bodyVoxels: [
      {
        size: [1.05, 0.92, 0.78], pos: [0, 0, 0], color: 0xa8e6df,
        transparent: true, opacity: 0.48, emissive: 0x3fe0c5, emissiveIntensity: 0.5,
      },
      { size: [0.68, 0.12, 0.45], pos: [0, 0.22, 0.12], color: 0xe6fffa, noOutline: true },
      { size: [0.58, 0.12, 0.45], pos: [0, 0.02, 0.12], color: 0xe6fffa, noOutline: true },
      { size: [0.48, 0.12, 0.45], pos: [0, -0.18, 0.12], color: 0xe6fffa, noOutline: true },
      { size: [0.14, 0.56, 0.12], pos: [0, 0.02, 0.35], color: 0xccfbf1, noOutline: true },
    ],
    leftArmVoxels: [
      { size: [0.26, 0.44, 0.28], pos: [0, -0.18, 0], color: 0xa8e6df, transparent: true, opacity: 0.50 },
      { size: [0.32, 0.32, 0.32], pos: [0, -0.48, 0], color: 0x3fe0c5, transparent: true, opacity: 0.70 },
    ],
    rightArmVoxels: [
      { size: [0.26, 0.44, 0.28], pos: [0, -0.18, 0], color: 0xa8e6df, transparent: true, opacity: 0.50 },
      { size: [0.32, 0.32, 0.32], pos: [0, -0.48, 0], color: 0x3fe0c5, transparent: true, opacity: 0.70 },
    ],
  },

  // PIP <- Boba (Pink Chibi): pink, cream eye frames, white buns on stalks,
  // blush marks.
  pip: {
    baseColor: 0xf472b6,
    limbColor: 0xf472b6,
    gloveColor: 0xffffff,
    legColor: 0xdb2777,
    shoeColor: 0x9d174d,
    eyeFrameColor: 0xfffbeb,
    pupilColor: 0x24141e,
    pupilSize: 0.20,
    accessoryVoxels: [
      { size: [0.16, 0.40, 0.16], pos: [-0.44, 0.82, 0.1], color: 0xffffff, rot: [0, 0, 0.25] },
      { size: [0.16, 0.40, 0.16], pos: [0.44, 0.82, 0.1], color: 0xffffff, rot: [0, 0, -0.25] },
      { size: [0.22, 0.12, 0.06], pos: [-0.56, -0.28, 0.64], color: 0xfb7185, noOutline: true },
      { size: [0.22, 0.12, 0.06], pos: [0.56, -0.28, 0.64], color: 0xfb7185, noOutline: true },
    ],
    bodyVoxels: [
      { size: [1.05, 0.92, 0.78], pos: [0, 0, 0], color: 0xf472b6 },
      { size: [0.58, 0.16, 0.14], pos: [0, 0.42, 0.38], color: 0xffffff, noOutline: true },
      { size: [0.12, 0.12, 0.08], pos: [0, 0.16, 0.42], color: 0xffffff, noOutline: true },
      { size: [0.12, 0.12, 0.08], pos: [0, -0.08, 0.42], color: 0xffffff, noOutline: true },
    ],
  },

  // HONEY <- Volt (Yellow Panda): bright yellow, dark vest, black ear boxes,
  // cyan gloves, white muzzle.
  honey: {
    baseColor: 0xf2d94e,
    limbColor: 0xf2d94e,
    gloveColor: 0x06b6d4,
    legColor: 0x1f2937,
    shoeColor: 0x111827,
    pupilColor: 0x18181b,
    pupilSize: 0.20,
    accessoryVoxels: [
      { size: [0.44, 0.44, 0.34], pos: [-0.62, 0.74, 0], color: 0x18181b },
      { size: [0.44, 0.44, 0.34], pos: [0.62, 0.74, 0], color: 0x18181b },
      { size: [0.48, 0.24, 0.14], pos: [0, -0.28, 0.66], color: 0xffffff, noOutline: true },
      { size: [0.16, 0.12, 0.16], pos: [0, -0.24, 0.68], color: 0x18181b, noOutline: true },
    ],
    bodyVoxels: [
      { size: [1.05, 0.92, 0.78], pos: [0, 0, 0], color: 0xf2d94e },
      { size: [1.10, 0.94, 0.52], pos: [0, -0.01, -0.16], color: 0x18181b },
      { size: [0.36, 0.90, 0.18], pos: [-0.38, 0, 0.36], color: 0x18181b, noOutline: true },
      { size: [0.36, 0.90, 0.18], pos: [0.38, 0, 0.36], color: 0x18181b, noOutline: true },
    ],
    leftArmVoxels: [
      { size: [0.26, 0.44, 0.28], pos: [0, -0.18, 0], color: 0xf2d94e },
      { size: [0.32, 0.32, 0.32], pos: [0, -0.48, 0], color: 0x06b6d4 },
    ],
    rightArmVoxels: [
      { size: [0.26, 0.44, 0.28], pos: [0, -0.18, 0], color: 0xf2d94e },
      { size: [0.32, 0.32, 0.32], pos: [0, -0.48, 0], color: 0x06b6d4 },
    ],
  },

  // GOGGLES <- Cyber Oak (Neon Glasses): brown, green neon visor over the
  // eyes, orange mouth, glowing chest screen.
  goggles: {
    baseColor: 0x784f33,
    limbColor: 0x633e24,
    gloveColor: 0x18181b,
    legColor: 0x54321b,
    shoeColor: 0x22150c,
    customEyes: true,
    accessoryVoxels: [
      { size: [0.85, 0.16, 0.85], pos: [0.15, 0.70, 0], color: 0x22160f },
      { size: [0.60, 0.38, 0.60], pos: [0.15, 0.92, 0], color: 0x22160f },
      { size: [0.62, 0.08, 0.62], pos: [0.15, 0.78, 0], color: 0x39ff14, noOutline: true },
      { size: [1.28, 0.48, 0.14], pos: [0, 0.05, 0.64], color: 0x18181b, noOutline: true },
      { size: [0.46, 0.34, 0.16], pos: [-0.36, 0.05, 0.66], color: 0x22c55e, emissive: 0x39ff14, emissiveIntensity: 2.8, noOutline: true },
      { size: [0.46, 0.34, 0.16], pos: [0.36, 0.05, 0.66], color: 0x22c55e, emissive: 0x39ff14, emissiveIntensity: 2.8, noOutline: true },
      { size: [0.42, 0.15, 0.10], pos: [0, -0.28, 0.65], color: 0xff6a00, noOutline: true },
    ],
    bodyVoxels: [
      { size: [1.05, 0.92, 0.78], pos: [0, 0, 0], color: 0x784f33 },
      { size: [0.44, 0.38, 0.10], pos: [0, 0.08, 0.42], color: 0x18181b, noOutline: true },
      { size: [0.34, 0.28, 0.12], pos: [0, 0.08, 0.43], color: 0x16a34a, emissive: 0x22c55e, emissiveIntensity: 2.5, noOutline: true },
      { size: [0.08, 0.08, 0.14], pos: [0.08, 0.08, 0.45], color: 0xef4444, emissive: 0xff0000, emissiveIntensity: 3.0, noOutline: true },
    ],
  },

  // CAPTAIN <- Ranger Blue (Horned Traveler): blue, brown horned hat, green
  // scarf and backpack, glowing sky-blue eyes.
  captain: {
    baseColor: 0x3b82f6,
    limbColor: 0x2563eb,
    gloveColor: 0x18181b,
    legColor: 0x1e40af,
    shoeColor: 0x172554,
    glowingEyes: true,
    pupilColor: 0x38bdf8,
    accessoryVoxels: [
      { size: [1.60, 0.18, 1.45], pos: [0, 0.68, 0], color: 0x6d4c41 },
      { size: [1.10, 0.52, 1.05], pos: [0, 0.96, 0], color: 0x5d4037 },
      { size: [0.20, 0.46, 0.20], pos: [-0.60, 1.25, 0], color: 0xede0d4, rot: [0, 0, 0.4] },
      { size: [0.20, 0.46, 0.20], pos: [0.60, 1.25, 0], color: 0xede0d4, rot: [0, 0, -0.4] },
      // Scarf and its tail: noOutline, since the scarf wraps into the body
      // silhouette and a hull there draws a stray line down the chest.
      { size: [1.38, 0.28, 1.15], pos: [0, -0.62, 0.05], color: 0x10b981, noOutline: true },
      { size: [0.35, 0.55, 0.20], pos: [-0.30, -0.85, 0.55], color: 0x059669, noOutline: true },
    ],
    bodyVoxels: [
      { size: [1.05, 0.92, 0.78], pos: [0, 0, 0], color: 0x3b82f6 },
      { size: [0.85, 0.75, 0.38], pos: [0, 0.04, -0.52], color: 0x10b981, noOutline: true },
      { size: [0.70, 0.24, 0.40], pos: [0, 0.28, -0.52], color: 0x059669, noOutline: true },
    ],
  },

  // LAVENDER <- Usagi (Lavender Bunny): long ears with pink inner panels,
  // cream eye frames, white tail.
  lavender: {
    baseColor: 0xc084fc,
    limbColor: 0xa855f7,
    gloveColor: 0xffffff,
    legColor: 0x9333ea,
    shoeColor: 0x581c87,
    eyeFrameColor: 0xfffbeb,
    pupilColor: 0x6b21a8,
    pupilSize: 0.20,
    accessoryVoxels: [
      { size: [0.28, 1.10, 0.22], pos: [-0.44, 1.15, 0], color: 0xc084fc },
      { size: [0.16, 0.88, 0.10], pos: [-0.44, 1.15, 0.08], color: 0xf5d0fe, noOutline: true },
      { size: [0.28, 1.10, 0.22], pos: [0.44, 1.15, 0], color: 0xc084fc },
      { size: [0.16, 0.88, 0.10], pos: [0.44, 1.15, 0.08], color: 0xf5d0fe, noOutline: true },
      { size: [0.14, 0.12, 0.08], pos: [0, -0.16, 0.65], color: 0xf472b6, noOutline: true },
    ],
    bodyVoxels: [
      { size: [1.05, 0.92, 0.78], pos: [0, 0, 0], color: 0xc084fc },
      { size: [0.34, 0.34, 0.30], pos: [0, -0.20, -0.52], color: 0xffffff },
      { size: [0.38, 0.24, 0.10], pos: [0, 0.28, 0.40], color: 0xfdf4ff, noOutline: true },
    ],
  },

  // TUX <- Sir Shade (Dark Purple Gentleman): deep purple, black top hat
  // with a white band, white shirt and glowing cyan tie.
  tux: {
    baseColor: 0x581c87,
    limbColor: 0x4c1d95,
    gloveColor: 0xffffff,
    legColor: 0x3b0764,
    shoeColor: 0x18181b,
    pupilColor: 0x1f1635,
    pupilSize: 0.20,
    accessoryVoxels: [
      { size: [1.60, 0.16, 1.45], pos: [0, 0.68, 0], color: 0x18181b },
      { size: [1.00, 0.72, 0.95], pos: [0, 1.05, 0], color: 0x18181b },
      { size: [1.04, 0.14, 0.98], pos: [0, 0.76, 0], color: 0xffffff, noOutline: true },
      { size: [0.48, 0.24, 0.48], pos: [0, 1.46, 0], color: 0xffffff, noOutline: true },
    ],
    bodyVoxels: [
      { size: [1.05, 0.92, 0.78], pos: [0, 0, 0], color: 0x581c87 },
      { size: [0.42, 0.80, 0.10], pos: [0, 0.05, 0.40], color: 0xf4f4f5, noOutline: true },
      { size: [0.18, 0.52, 0.14], pos: [0, 0.02, 0.46], color: 0x06b6d4, emissive: 0x0891b2, emissiveIntensity: 1.2, noOutline: true },
      { size: [0.26, 0.14, 0.16], pos: [0, 0.28, 0.46], color: 0x06b6d4, noOutline: true },
    ],
  },

  // MR. HAT <- Minty Cap (Tan & Teal Explorer): tan, teal cap with a brim,
  // black rectangular glasses, teal gloves and shoes.
  mrhat: {
    baseColor: 0xc49a6c,
    limbColor: 0xb5895c,
    gloveColor: 0x0d9488,
    legColor: 0x8a623c,
    shoeColor: 0x0d9488,
    customEyes: true,
    accessoryVoxels: [
      { size: [1.54, 0.06, 1.42], pos: [0, 0.65, 0], color: 0x18181b },
      { size: [1.52, 0.18, 1.40], pos: [0, 0.75, 0], color: 0x14b8a6 },
      { size: [1.05, 0.42, 1.00], pos: [0, 1.00, 0], color: 0x0d9488 },
      { size: [0.75, 0.10, 0.48], pos: [0, 0.72, 0.75], color: 0x14b8a6 },
      { size: [0.76, 0.04, 0.08], pos: [0, 0.70, 0.98], color: 0x18181b, noOutline: true },
      { size: [1.36, 0.50, 0.12], pos: [0, 0.04, 0.64], color: 0xffffff, noOutline: true },
      { size: [0.48, 0.38, 0.14], pos: [-0.38, 0.04, 0.65], color: 0x1e293b, noOutline: true },
      { size: [0.48, 0.38, 0.14], pos: [0.38, 0.04, 0.65], color: 0x1e293b, noOutline: true },
      { size: [0.22, 0.22, 0.16], pos: [-0.32, 0.08, 0.67], color: 0xffffff, noOutline: true },
      { size: [0.22, 0.22, 0.16], pos: [0.44, 0.08, 0.67], color: 0xffffff, noOutline: true },
    ],
    bodyVoxels: [
      { size: [1.05, 0.92, 0.78], pos: [0, 0, 0], color: 0xc49a6c },
      { size: [0.12, 0.12, 0.10], pos: [0, 0.22, 0.41], color: 0x14b8a6, noOutline: true },
      { size: [0.12, 0.12, 0.10], pos: [0, -0.05, 0.41], color: 0x14b8a6, noOutline: true },
    ],
    leftLegVoxels: [
      { size: [0.28, 0.36, 0.32], pos: [0, -0.16, 0], color: 0x8a623c },
      { size: [0.34, 0.26, 0.44], pos: [0, -0.42, 0.04], color: 0x0d9488 },
    ],
    rightLegVoxels: [
      { size: [0.28, 0.36, 0.32], pos: [0, -0.16, 0], color: 0x8a623c },
      { size: [0.34, 0.26, 0.44], pos: [0, -0.42, 0.04], color: 0x0d9488 },
    ],
  },
};

// ── eyes ──────────────────────────────────────────────────────────────────
// The two face styles from VibeOffice, emitted as head box definitions so
// they merge with the head and lose the wild internal outline lines.
function eyeDefs(config) {
  if (config.glowingEyes) {
    // Split dark panels with a glowing pupil dot.
    const eyeW = 0.52, eyeH = 0.48, eyeX = 0.36, pupil = 0.16;
    const glow = config.pupilColor || 0xffea00;
    return [
      { size: [eyeW + 0.06, eyeH + 0.06, 0.04], pos: [-eyeX, 0.02, 0.63], color: 0x050505, noOutline: true },
      { size: [eyeW + 0.06, eyeH + 0.06, 0.04], pos: [eyeX, 0.02, 0.63], color: 0x050505, noOutline: true },
      { size: [eyeW, eyeH, 0.08], pos: [-eyeX, 0.02, 0.66], color: 0x111111, noOutline: true },
      { size: [eyeW, eyeH, 0.08], pos: [eyeX, 0.02, 0.66], color: 0x111111, noOutline: true },
      { size: [pupil, pupil, 0.12], pos: [-eyeX, 0.02, 0.68], color: glow, emissive: glow, emissiveIntensity: 2.8, noOutline: true },
      { size: [pupil, pupil, 0.12], pos: [eyeX, 0.02, 0.68], color: glow, emissive: glow, emissiveIntensity: 2.8, noOutline: true },
    ];
  }
  // Framed white eyes with a small pupil pinched into the inner corner.
  const eyeW = 0.58, eyeH = 0.50, eyeX = 0.33, frame = 0.08;
  const pupil = config.pupilSize || 0.20;
  const frameColor = config.eyeFrameColor !== undefined ? config.eyeFrameColor : 0x221a14;
  const pupilColor = config.pupilColor || 0x111111;
  return [
    { size: [eyeW + frame, eyeH + frame, 0.04], pos: [-eyeX, 0.02, 0.63], color: frameColor, noOutline: true },
    { size: [eyeW + frame, eyeH + frame, 0.04], pos: [eyeX, 0.02, 0.63], color: frameColor, noOutline: true },
    { size: [eyeW, eyeH, 0.08], pos: [-eyeX, 0.02, 0.66], color: 0xfcfaf2, noOutline: true },
    { size: [eyeW, eyeH, 0.08], pos: [eyeX, 0.02, 0.66], color: 0xfcfaf2, noOutline: true },
    { size: [pupil, pupil, 0.12], pos: [-eyeX - 0.07, -0.05, 0.68], color: pupilColor, noOutline: true },
    { size: [pupil, pupil, 0.12], pos: [eyeX - 0.07, -0.05, 0.68], color: pupilColor, noOutline: true },
  ];
}

// ── particles ─────────────────────────────────────────────────────────────
// One geometry shared by every ghost; the scatter is decorative and identical
// between instances, so there is nothing to gain from per-unit buffers.
let particleGeo = null;
let particleMat = null;

function ghostParticles(color) {
  if (!particleGeo) {
    const count = 28;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3 + 0] = (Math.random() - 0.5) * 1.6;
      positions[i * 3 + 1] = Math.random() * 2.4;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 1.6;
    }
    particleGeo = new THREE.BufferGeometry();
    particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    particleMat = new THREE.PointsMaterial({
      color,
      size: 0.08,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
    });
    particleMat.userData.shared = true;
  }
  return new THREE.Points(particleGeo, particleMat);
}

/**
 * Build a chibi fighter in the VibeOffice style.
 * @param {string} id a CHIBI_MODELS key (and VibeRoyale card id)
 * @returns {THREE.Group} with legL/legR/armL/armR/head/body pivot refs for
 *   troops.js's walk and attack animation
 */
export function buildChibi(id) {
  const config = CHIBI_MODELS[id];
  if (!config) throw new Error(`chibi: unknown model '${id}'`);

  const isGhost = !!config.isGhost;
  const base = config.baseColor || 0xd8c29d;
  const root = new THREE.Group();
  root.name = id;

  // Body
  const bodyGroup = new THREE.Group();
  bodyGroup.position.set(0, 0.98, 0);
  bodyGroup.add(buildPart(config.bodyVoxels || [{ size: [1.05, 0.92, 0.78], pos: [0, 0, 0], color: base }], base, isGhost));
  root.add(bodyGroup);

  // Head + face + accessories, merged so the outline never cuts through the
  // face panels.
  const headGroup = new THREE.Group();
  headGroup.position.set(0, 1.95, 0.05);
  const headDefs = config.headVoxels ? [...config.headVoxels] : [{ size: [1.45, 1.25, 1.28], pos: [0, 0, 0], color: base }];
  if (config.accessoryVoxels) headDefs.push(...config.accessoryVoxels);
  if (!config.customEyes) headDefs.push(...eyeDefs(config));
  headGroup.add(buildPart(headDefs, base, isGhost));
  root.add(headGroup);

  // Arms. Pivot height 1.34 is VibeOffice's shoulder line; weapons from the
  // old roster hang from the same local origin, so they keep their grip.
  const armDefsL = config.leftArmVoxels || [
    { size: [0.26, 0.44, 0.28], pos: [0, -0.18, 0], color: config.limbColor || base },
    { size: [0.32, 0.32, 0.32], pos: [0, -0.48, 0], color: config.gloveColor || 0xffffff },
  ];
  const armDefsR = config.rightArmVoxels || [
    { size: [0.26, 0.44, 0.28], pos: [0, -0.18, 0], color: config.limbColor || base },
    { size: [0.32, 0.32, 0.32], pos: [0, -0.48, 0], color: config.gloveColor || 0xffffff },
  ];

  const armL = new THREE.Group();
  armL.position.set(-0.80, 1.34, 0);
  armL.rotation.z = 0.08;
  armL.add(buildPart(armDefsL, base, isGhost));

  const armR = new THREE.Group();
  armR.position.set(0.80, 1.34, 0);
  armR.rotation.z = -0.08;
  armR.add(buildPart(armDefsR, base, isGhost));
  root.add(armL, armR);

  // Legs, pivoted at the hip so troops.js's walk swing rotates the whole
  // limb including the shoe.
  const legDefsL = config.leftLegVoxels || [
    { size: [0.28, 0.36, 0.32], pos: [0, -0.16, 0], color: config.legColor || base },
    { size: [0.34, 0.24, 0.44], pos: [0, -0.42, 0.05], color: config.shoeColor || 0x222222 },
  ];
  const legDefsR = config.rightLegVoxels || [
    { size: [0.28, 0.36, 0.32], pos: [0, -0.16, 0], color: config.legColor || base },
    { size: [0.34, 0.24, 0.44], pos: [0, -0.42, 0.05], color: config.shoeColor || 0x222222 },
  ];

  const legL = new THREE.Group();
  legL.position.set(-0.34, 0.54, 0);
  legL.add(buildPart(legDefsL, base, isGhost));

  const legR = new THREE.Group();
  legR.position.set(0.34, 0.54, 0);
  legR.add(buildPart(legDefsR, base, isGhost));
  root.add(legL, legR);

  if (config.hasParticles) {
    root.add(ghostParticles(config.particleColor || 0x64ffda));
  }

  root.scale.setScalar(CHIBI_SCALE);

  // The animation contract troops.js speaks.
  root.legL = legL;
  root.legR = legR;
  root.armL = armL;
  root.armR = armR;
  root.head = headGroup;
  root.body = bodyGroup;

  return root;
}
