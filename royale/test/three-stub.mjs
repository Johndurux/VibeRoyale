// A stand-in for the three.js classes the pure-logic modules touch at import
// time or on the code paths under test.
//
// This is deliberately shallow. It is not a WebGL substitute and makes no claim
// to be one - nothing rendered is checked here. What it buys is the ability to
// execute match.js, progression.js and spells.js for real, so their arithmetic
// and state transitions are actually observed rather than inferred from reading
// the source. Anything that needs real geometry or a GPU still has to be checked
// in a browser by a person.

class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new V3(this.x, this.y, this.z); }
  add() { return this; }
  sub() { return this; }
  setScalar() { return this; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  normalize() { return this; }
  distanceTo() { return 0; }
}

class Obj3D {
  constructor() {
    this.position = new V3();
    this.rotation = { x: 0, y: 0, z: 0, set() {}, copy() {} };
    this.scale = new V3(1, 1, 1);
    this.children = [];
    this.parent = null;
    this.visible = true;
    this.name = '';
    this.userData = {};
  }
  add(...c) { for (const x of c) { x.parent = this; this.children.push(x); } return this; }
  remove(c) { this.children = this.children.filter((x) => x !== c); return this; }
  clear() { this.children = []; return this; }
  traverse(fn) { fn(this); for (const c of this.children) c.traverse(fn); }
  lookAt() {}
  getObjectByName(n) { return this.getObjectByProperty('name', n); }
  getObjectByProperty(k, v) {
    let hit = null;
    this.traverse((o) => { if (!hit && o[k] === v) hit = o; });
    return hit;
  }
}

class Group extends Obj3D {}
class Scene extends Obj3D {}

class Mesh extends Obj3D {
  constructor(geometry = null, material = null) {
    super();
    this.geometry = geometry;
    this.material = material;
    this.castShadow = false;
    this.receiveShadow = false;
  }
}

// Geometry and material are pure data holders here; nothing reads their buffers.
// Written as classes, not factory functions. The source under test does
// `new THREE.BoxGeometry(...)` and `new THREE.MeshLambertMaterial(...)`, and an
// arrow function is not constructible - every one of those calls threw
// "THREE.BoxGeometry is not a constructor" the moment a character was built.
// The classes still work when called without `new`-free factory style, because
// a class body only runs under `new`, which is exactly how THREE is used.
class geo {
  // Arguments are accepted and ignored: dimensions do not change any behaviour
  // a logic test can observe, but `new THREE.BoxGeometry(w, h, d)` must not
  // throw. userData is real - voxel.js marks shared buffers on it and
  // disposeObject() reads it back to decide what not to free.
  constructor(..._args) {
    this.attributes = {};
    this.groups = [];
    this.boundingSphere = { center: new V3(), radius: 1 };
    this.userData = {};
    this.type = 'BufferGeometry';
  }
  dispose() {}
  translate() {}
  rotateX() {}
  rotateY() {}
  scale() {}
  setFromPoints() {}
  computeVertexNormals() {}
}

class mat {
  // Options are applied so `new THREE.MeshLambertMaterial({ color })` records
  // the colour it was handed; userData is real for the same reason as above.
  constructor(opts) {
    this.color = { set() {}, setHex() {}, getHex: () => 0xffffff, clone() { return new mat().color; } };
    this.opacity = 1;
    this.transparent = false;
    this.emissive = new V3();
    this.userData = {};
    if (opts && typeof opts === 'object') Object.assign(this, opts);
  }
  dispose() {}
}

export const MeshBasicMaterial = mat;
export const MeshLambertMaterial = mat;
export const MeshStandardMaterial = mat;
export const MeshPhongMaterial = mat;
export const LineBasicMaterial = mat;
export const PointsMaterial = mat;
export const SpriteMaterial = mat;
export const BoxGeometry = geo;
export const PlaneGeometry = geo;
export const CylinderGeometry = geo;
export const SphereGeometry = geo;
export const ConeGeometry = geo;
export const BufferGeometry = geo;

export const Vector2 = V3;
export const Vector3 = V3;
export const Color = class { constructor(hex) { this.hex = hex; } set() { return this; } setHex(h) { this.hex = h; return this; } getHex() { return this.hex; } clone() { return new Color(this.hex); } };
export const Euler = class { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set() { return this; } };
export const Quaternion = class { identity() { return this; } };
export const Matrix4 = class { identity() { return this; } };
export const Layers = class { enable() {} disable() {} };
export const Fog = class { constructor() {} };
export const Clock = class { getDelta() { return 0; } getElapsedTime() { return 0; } start() {} stop() {} };
export const Raycaster = class { setFromCamera() {} intersectObjects() { return []; } };
export const Object3D = Obj3D;

// Exported under its real name. This was `Scene2`, which meant `THREE.Scene`
// resolved to undefined and any module constructing one threw. scene.js and
// ui.js both do, so the name has to match what the source actually asks for.
export { Scene };
export const PerspectiveCamera = class extends Obj3D {
  constructor(fov = 50, aspect = 1, near = 0.1, far = 2000) {
    super();
    this.fov = fov;
    this.aspect = aspect;
    this.near = near;
    this.far = far;
  }
};
export const AmbientLight = class extends Obj3D { constructor(c, i) { super(); this.color = c; this.intensity = i; } };
export const DirectionalLight = class extends Obj3D { constructor(c, i) { super(); this.color = c; this.intensity = i; this.shadow = { mapSize: { width: 1, height: 1 } }; } };
export const HemisphereLight = class extends Obj3D { constructor() { super(); } };
export const PointLight = class extends Obj3D { constructor() { super(); } };

export const WebGLRenderer = class {
  // dispose() is here because renderFaces() calls it on the way out, and a
  // renderer that cannot be disposed leaks a real GPU context in the browser.
  // Shadow map fields are duplicated between the constructor and the class
 // field below in the original; keeping one of them is enough.
  constructor() {
    this.domElement = { style: {}, addEventListener() {}, getContext: () => null };
    this.shadowMap = { enabled: false };
    this.info = { render: { calls: 0, triangles: 0 } };
  }
  setSize() {}
  setPixelRatio() {}
  setClearColor() {}
  render() {}
  dispose() {}
  setAnimationLoop() {}
};
export const PCFSoftShadowMap = 1;
export const ACESFilmicToneMapping = 4;
export const SRGBColorSpace = 'srgb';

// The camera base and the remaining graph classes. Group, Scene and Mesh were
// already declared above, so only what was genuinely absent is added here.
// These exist because renderFaces() really does build each character and add it
// to a scene, so a lobby test can run that path instead of mocking it out.
class Camera extends Obj3D {
  constructor() { super(); this.isCamera = true; this.projectionMatrix = {}; }
  updateProjectionMatrix() {}
}
class Points extends Mesh {}
// Group, Scene and Mesh were declared above but only reached through the
// default export, so `THREE.Group` was undefined for anyone importing them by
// name - which is every module in src/. Named exports are the contract here.
export { Group, Mesh, Camera, Points };
export const RingGeometry = geo;
export const Plane = class {};

// Geometry and material bases. All a test needs is for construction to work
// and for the handful of setters voxel.js calls to return something chainable.
class Material {
  constructor(opts) { this.opacity = 1; this.transparent = false; Object.assign(this, opts || {}); }
  clone() { return new Material(this); }
}
class BufferAttribute {
  constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; this.needsUpdate = false; }
  setXYZ() { return this; }
  set() { return this; }
}
class CanvasTexture {
  constructor(canvas) { this.image = canvas; this.needsUpdate = true; this.wrapS = 0; this.wrapT = 0; this.repeat = { set() {} }; }
  dispose() {}
}
export { Material, BufferAttribute, CanvasTexture };

export const DoubleSide = 2;
export const RepeatWrapping = 1000;
export const FrontSide = 0;
export const BackSide = 1;

export default {
  Vector3: V3, Vector2: V3, Euler: Object, Quaternion: Object, Matrix4: Object,
  Object3D: Obj3D, Group, Scene, Camera, Mesh, Points, Material, BufferAttribute, CanvasTexture,
  MeshBasicMaterial: mat, MeshLambertMaterial: mat,
  BoxGeometry: geo, PlaneGeometry: geo, CylinderGeometry: geo, SphereGeometry: geo,
  ConeGeometry: geo, BufferGeometry: geo, Clock, Raycaster, WebGLRenderer,
};