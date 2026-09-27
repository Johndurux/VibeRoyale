// ── voxel.js ────────────────────────────────────────────────────────────
// The one primitive every mesh in the game is built from. Kept in its own
// leaf module so both the scene and the entity factories can use it without
// importing each other.

import * as THREE from 'three';

/**
 * Geometry cache. A district's scenery alone asks for several hundred boxes
 * and most of them repeat the same handful of dimensions, so building a fresh
 * BoxGeometry per call left the renderer with hundreds of unique buffers and
 * the frame rate collapsed. Sharing by dimension tuple is invisible to the
 * caller because geometry is only ever read, never mutated.
 * @type {Map<string, THREE.BoxGeometry>}
 */
const GEO_CACHE = new Map();

/**
 * Material cache, same argument: 700 separate MeshLambertMaterial instances of
 * the same colour is 700 shader programs to bind. Keyed by colour and
 * lit/unlit, because a glowing prop must not cast shade.
 * @type {Map<string, THREE.Material>}
 */
const MAT_CACHE = new Map();

function boxGeo(w, h, d) {
  const key = w + '_' + h + '_' + d;
  let g = GEO_CACHE.get(key);
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d);
    // Marked so disposeObject() knows this buffer belongs to the cache and to
    // every other mesh sharing these dimensions, and must not be freed with
    // any single one of them.
    g.userData.shared = true;
    GEO_CACHE.set(key, g);
  }
  return g;
}

function lambert(color) {
  const key = 'L' + color;
  let m = MAT_CACHE.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color });
    m.userData.shared = true;
    MAT_CACHE.set(key, m);
  }
  return m;
}

/**
 * A single shaded box.
 * @param {number} w width
 * @param {number} h height
 * @param {number} d depth
 * @param {number} color  hex colour
 * @param {{x?:number,y?:number,z?:number}} [at] centre offset
 * @returns {THREE.Mesh}
 */
export function vox(w, h, d, color, { x = 0, y = 0, z = 0 } = {}) {
  const mesh = new THREE.Mesh(boxGeo(w, h, d), lambert(color));
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * A box that is only there to be seen: no shadow casting, no shadow receiving.
 * Scenery uses this. Shadows are resolved per light per object, so a district's
 * several hundred background props were costing real frame time to render
 * shadows nobody can tell apart through the fog.
 * @param {number} w width
 * @param {number} h height
 * @param {number} d depth
 * @param {number} color  hex colour
 * @param {{x?:number,y?:number,z?:number}} [at] centre offset
 * @returns {THREE.Mesh}
 */
export function decoBox(w, h, d, color, { x = 0, y = 0, z = 0 } = {}) {
  const mesh = new THREE.Mesh(boxGeo(w, h, d), lambert(color));
  mesh.position.set(x, y, z);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

/**
 * Unlit box for neon and lamps. `transparent` and `depthWrite` are left on the
 * material, not the mesh, so the pulse in animateScenery can fade a lamp
 * without touching anything else.
 * @param {number} w width
 * @param {number} h height
 * @param {number} d depth
 * @param {number} color  hex colour
 * @param {{x?:number,y?:number,z?:number}} [at] centre offset
 * @returns {THREE.Mesh}
 */
export function neonBox(w, h, d, color, { x = 0, y = 0, z = 0 } = {}) {
  const key = 'B' + color;
  let m = MAT_CACHE.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color, transparent: true });
    m.userData.shared = true;
    MAT_CACHE.set(key, m);
  }
  const mesh = new THREE.Mesh(boxGeo(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

/** Diagnostic counts, so the perf probe can assert the caches are working. */
export function voxelCacheStats() {
  return { geometries: GEO_CACHE.size, materials: MAT_CACHE.size };
}
