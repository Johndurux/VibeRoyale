// scene.js - renderer, camera, lights, dynamic sky.
import * as THREE from 'three';
import { PALETTE, ARENA } from './config.js';

export const canvas = document.getElementById('webgl');
export const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

export const scene = new THREE.Scene();

// -- sky -----------------------------------------------------------
// A vertical gradient painted to a 2x256 canvas and handed to the scene as a
// plain Texture. Three draws a non-cube background as one full-screen quad, so
// this is a real vertical sky gradient for the cost of a 2x256 upload - far
// cheaper than a skybox sphere, and it cannot clip against the far plane.
//
// The canvas is kept around and repaintable rather than baked once, which is
// what lets overtime drag the sky to a storm without swapping scene.background:
// the same texture, redrawn along a lerp, so it is continuous instead of a cut.
const skyCv = document.createElement('canvas');
skyCv.width = 2;
skyCv.height = 256;
const skyTex = new THREE.CanvasTexture(skyCv);
skyTex.colorSpace = THREE.SRGBColorSpace;
scene.background = skyTex;

// Two palettes. The stop positions match the four stops the original daytime
// gradient used, so the shipped sky is unchanged at mood 0.
const SKY_DAY = {
  stops: [0x6fc7f0, 0x9bd8f2, 0xffe0a8, 0xffd98a],
  at: [0.0, 0.42, 0.74, 1.0],
  fog: 0xffe0a8,
};
// The storm: dark violet overhead into a burning horizon, so overtime reads as
// a different time of day rather than a filter laid over the same one.
const SKY_STORM = {
  stops: [0x2a0f3a, 0x5c1a3e, 0x9c2f42, 0xd65a3a],
  at: [0.0, 0.42, 0.74, 1.0],
  fog: 0x8a2a3c,
};

// Pre-allocated blend colours. The blend runs every frame for five seconds, and
// a new THREE.Color per stop per frame is a heap allocation inside the render
// loop for values whose identity never changes - only their components do.
const DAY_COLS = SKY_DAY.stops.map((c) => new THREE.Color(c));
const STORM_COLS = SKY_STORM.stops.map((c) => new THREE.Color(c));
const skyNow = SKY_DAY.stops.map((c) => new THREE.Color(c));
const fogDay = new THREE.Color(SKY_DAY.fog);
const fogStorm = new THREE.Color(SKY_STORM.fog);
const fogNow = new THREE.Color(SKY_DAY.fog);

// 0 = day, 1 = full storm. Anything between is a blend of the two.
let skyMood = 0;
let skyMoodTarget = 0;

// Seconds for a full day->storm transition: slow enough to be noticed, fast
// enough that the player is not reading a different sky by the end of it.
const SKY_FADE = 5;

function paintSky() {
  const g = skyCv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, skyCv.height);
  for (let i = 0; i < skyNow.length; i++) {
    grad.addColorStop(SKY_DAY.at[i], '#' + skyNow[i].getHexString());
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, skyCv.width, skyCv.height);
  skyTex.needsUpdate = true;
}

// Fog is pinned to the horizon band of that gradient rather than to the flat
// background colour the old scene used: a mismatch draws a visible seam along
// the skyline. It is blended by the same mood, so it cannot lag behind the sky
// it sits under.
scene.fog = new THREE.Fog(SKY_DAY.fog, 58, 132);

/** Ask for a sky. 0 is the sunny day palette, 1 is the overtime storm. */
export function setSkyMood(mood) {
  // A non-finite mood is refused rather than obeyed. It would blend the sky
  // colours into NaN, and the first addColorStop of a NaN colour throws - from
  // inside the render loop, which kills the frame and freezes the whole board
  // with the last image it managed to draw. One bad caller must not be able to
  // stop the game rendering.
  if (!Number.isFinite(mood)) return;
  skyMoodTarget = Math.max(0, Math.min(1, mood));
}

/** Snap straight back to the daytime sky, no transition. Used on a reset. */
export function resetSky() {
  skyMood = 0;
  skyMoodTarget = 0;
  for (let i = 0; i < skyNow.length; i++) skyNow[i].copy(DAY_COLS[i]);
  fogNow.copy(fogDay);
  if (scene.fog) scene.fog.color.copy(fogNow);
  paintSky();
}

// Top-down-ish isometric. Pulled back and tilted so all three lanes and both
// tower rows are inside the frame at the default aspect ratio.
export const camera = new THREE.PerspectiveCamera(
  44, window.innerWidth / window.innerHeight, 0.1, 220
);
// The resting camera pose. Exported as a single object so a screen shake or a
// destruction zoom-in has one authoritative place to return to, rather than
// three modules each keeping their own copy of "where the camera normally is"
// and drifting apart.
//
// The resting camera pose. Exported as a single object so a screen shake or a
// destruction zoom-in has one authoritative place to return to, rather than
// three modules each keeping their own copy of "where the camera normally is"
// and drifting apart.
//
// The original angle and zoom, translated a few units toward the player side:
// same pitch, same scale, but the bottom of the frame now clears the player
// king tower instead of slicing it (its base used to land below the 16:9
// bottom edge). The rival king was never at risk - the shallow pitch sees far
// past it - so the composition reads exactly as it always did.
export const CAM_ORIGIN = { x: 0, y: 24.5, z: 34.5, lookX: 0, lookY: 0, lookZ: 3.6 };
camera.position.set(CAM_ORIGIN.x, CAM_ORIGIN.y, CAM_ORIGIN.z);
camera.lookAt(CAM_ORIGIN.lookX, CAM_ORIGIN.lookY, CAM_ORIGIN.lookZ);

// -- lights ------------------------------------------------------------
// Outdoors at midday. The hemisphere light does most of the work and is the
// single biggest reason the scene reads sunny: it tints everything from the
// blue sky above and bounces green back up off the grass, which no number of
// ambient lights can fake. The ground colour is deliberately desaturated - a
// fully saturated green bounce is physically right and visually wrong, because
// it tints every vertical stone face olive, which turned the towers the same
// colour as the grass they stand on.
export const ambientLight = new THREE.HemisphereLight(0xbfe8ff, 0x9db88a, 0.9);
scene.add(ambientLight);

export const dirLight = new THREE.DirectionalLight(0xfff4dd, 1.45);
dirLight.position.set(13, 26, 17);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
// Tight shadow frustum around the playfield: the default box would clip the
// towers out of the shadow map entirely.
const sc = dirLight.shadow.camera;
sc.left = -22; sc.right = 22; sc.top = 26; sc.bottom = -26;
sc.near = 1; sc.far = 70;
sc.updateProjectionMatrix();
scene.add(dirLight);

// Warm fill from the opposite side, so the shadowed faces of the towers are
// lit in orange rather than left black.
export const rimLight = new THREE.DirectionalLight(0xffd9a0, 0.5);
rimLight.position.set(-14, 9, -12);
scene.add(rimLight);

export { ARENA };

/**
 * Ease the sky toward its target. Called from the render loop rather than from
 * the event that asked for it, so a backgrounded tab does not fast-forward the
 * weather on the frame it comes back.
 * @param {number} dt
 */
export function updateSky(dt) {
  // Early out on a settled sky: the overwhelming majority of every match is
  // plain daylight, and this keeps that free - no lerp, repaint or upload.
  if (skyMood === skyMoodTarget) return;

  const step = dt / SKY_FADE;
  skyMood += Math.sign(skyMoodTarget - skyMood) * step;
  if (Math.abs(skyMoodTarget - skyMood) <= Math.abs(step)) skyMood = skyMoodTarget;

  for (let i = 0; i < skyNow.length; i++) {
    skyNow[i].copy(DAY_COLS[i]).lerp(STORM_COLS[i], skyMood);
  }
  fogNow.copy(fogDay).lerp(fogStorm, skyMood);
  if (scene.fog) scene.fog.color.copy(fogNow);
  paintSky();
}