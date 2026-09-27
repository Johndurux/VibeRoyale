// ── scene.js ──────────────────────────────────────────────────────────────
// Renderer, scene graph, camera and lights for the trading pit. Everything
// that must exist before the first frame. Mirrors the shape of Vrunner's
// scene.js so the two games feel like siblings, but the camera is a
// top-down/isometric tower-defence rig rather than a chase rig.

import * as THREE from 'three';
import { PALETTE, ARENA } from './config.js';

export const canvas = document.getElementById('webgl');
export const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

export const scene = new THREE.Scene();

// ── sky ───────────────────────────────────────────────────────────────────
// A vertical gradient painted to a 2x256 canvas and handed to the scene as a
// plain Texture. Three draws a non-cube background as one full-screen quad, so
// this is a real vertical sky gradient for the cost of a 2x256 upload - far
// cheaper than a skybox sphere, and it cannot clip against the far plane.
function skyTexture() {
  const cv = document.createElement('canvas');
  cv.width = 2;
  cv.height = 256;
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, cv.height);
  grad.addColorStop(0.00, '#6fc7f0');
  grad.addColorStop(0.42, '#9bd8f2');
  grad.addColorStop(0.74, '#ffe0a8');
  grad.addColorStop(1.00, '#ffd98a');
  g.fillStyle = grad;
  g.fillRect(0, 0, cv.width, cv.height);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
scene.background = skyTexture();

// Fog is pinned to the horizon band of that gradient rather than to the flat
// background colour the old scene used. A mismatch here draws a visible seam
// along the skyline, so the fog colour is sampled from the same stops.
scene.fog = new THREE.Fog(0xffe0a8, 58, 132);

// Top-down-ish isometric. Pulled back and tilted so all three lanes and both
// tower rows are inside the frame at the default aspect ratio.
export const camera = new THREE.PerspectiveCamera(
  42, window.innerWidth / window.innerHeight, 0.1, 220
);
// Pulled back off the old 27/25.5 rig. At that distance the near king tower
// ran off the bottom of the frame and the far stand off the top: the arena is
// 34 units deep and the old frustum only covered about 29 at the near plane.
// Same 45-degree elevation, just far enough to hold the whole pitch.
export const CAM_ORIGIN = { x: 0, y: 36.5, z: 34.5, lookY: 0, lookZ: -1.5 };
camera.position.set(CAM_ORIGIN.x, CAM_ORIGIN.y, CAM_ORIGIN.z);
camera.lookAt(CAM_ORIGIN.lookY, CAM_ORIGIN.lookY, CAM_ORIGIN.lookZ);

// ── lights ────────────────────────────────────────────────────────────────
// Outdoors at midday. The hemisphere light does most of the work and is the
// single biggest reason the scene reads sunny: it tints everything from the
// blue sky above and bounces green back up off the grass, which no number of
// ambient lights can fake. The cyan pit-bounce and neon rim are gone; they
// only existed to make dark metal legible in a dark room.
// The ground colour is deliberately desaturated. A fully saturated green
// bounce is physically right and visually wrong: it tints every vertical
// stone face olive, which turned the towers the same colour as the grass.
export const ambientLight = new THREE.HemisphereLight(0xbfe8ff, 0x9db88a, 0.9);
scene.add(ambientLight);

export const dirLight = new THREE.DirectionalLight(0xfff4dd, 1.45);
dirLight.position.set(13, 26, 17);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
// Tight shadow frustum around the playfield: the default ±5 box would clip
// the towers out of the shadow map entirely.
const sc = dirLight.shadow.camera;
sc.left = -22; sc.right = 22; sc.top = 26; sc.bottom = -26;
sc.near = 1; sc.far = 70;
sc.updateProjectionMatrix();
scene.add(dirLight);

// Warm fill from the opposite side, so the shadowed faces of the towers are
// lit in orange rather than left black. No shadows cast: it is a fill.
export const rimLight = new THREE.DirectionalLight(0xffd9a0, 0.5);
rimLight.position.set(-14, 9, -12);
scene.add(rimLight);

export { ARENA };