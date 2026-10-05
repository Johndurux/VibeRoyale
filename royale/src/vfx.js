// -- vfx.js ---------------------------------------------------------------
// Everything that appears on the pitch and is not a unit: deploy bursts,
// spell rings, tower rubble and the touch deployment overlay.
//
// Two rules shape this module.
//
// First, no per-instance colour may mutate a cached material. voxel.js hands
// out shared MeshLambertMaterial instances keyed by colour, so changing one
// instance's colour would repaint every other object using that colour. Any
// effect that animates its own opacity creates its own material instead.
//
// Second, nothing here owns game state. Effects are fire and forget: they
// animate, they clean themselves up, and they never decide anything. The
// caller has already made its decision by the time it calls in.

import * as THREE from 'three';
import { PALETTE, DEPLOY } from './config.js';

// Team colours for deploy bursts, from the same palette the towers and the
// HUD banners use, so "whose unit is that" is answerable without a health bar.
const TEAM_COLOR = { player: PALETTE.player, enemy: PALETTE.enemy };

export function createVfx() {
  const root = new THREE.Group();
  // Effects that are mid-animation. A plain array swept backwards: with a
  // handful of live effects per match this is cheaper than a Set, and the
  // stable ordering means overlapping effects do not reorder.
  const live = [];
  /**
   * A scatter of Points that fly outward and fade.
   *
   * One geometry and one material per burst, both disposed when it ends. The
   * geometry is tiny and the effect lasts under a second, so pooling would be
   * complexity for a cost that is already invisible; what matters is that the
   * buffers ARE disposed, or a long session of deploying would accumulate GPU
   * buffers without bound.
   */
  function burst(x, z, color, opts = {}) {
    const n = opts.count || 8;
    const life = opts.life || 0.4;
    const speed = opts.speed || 2.2;
    const size = opts.size || 0.16;
    const rise = opts.rise || 1.6;

    const pos = new Float32Array(n * 3);
    const vel = [];
    for (let i = 0; i < n; i++) {
      // Even angular spread rather than pure random: eight particles from a
      // true random distribution clump visibly. This reads as a ring bursting
      // outward, which is what the eye expects from a spawn.
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const s = speed * (0.65 + Math.random() * 0.5);
      pos[i * 3] = x;
      pos[i * 3 + 1] = opts.y != null ? opts.y : 0.35;
      pos[i * 3 + 2] = z;
      vel.push({
        x: Math.cos(a) * s,
        y: rise * (0.5 + Math.random() * 0.7),
        z: Math.sin(a) * s,
      });
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    // Its own material, because a burst fades and nothing else should fade
    // with it.
    const mat = new THREE.PointsMaterial({
      color,
      size,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    root.add(pts);

    live.push({
      t: 0,
      life,
      step(dt) {
        this.t += dt;
        const k = Math.min(1, this.t / this.life);
        const arr = geo.attributes.position.array;
        for (let i = 0; i < n; i++) {
          const v = vel[i];
          arr[i * 3] += v.x * dt;
          arr[i * 3 + 1] += v.y * dt;
          arr[i * 3 + 2] += v.z * dt;
          // Ballistic decay: the outward push fades, gravity takes over, and
          // the pieces fall back to the grass instead of drifting off.
          v.y -= 5.2 * dt;
          v.x *= 0.94;
          v.z *= 0.94;
        }
        geo.attributes.position.needsUpdate = true;
        // Ease the fade so the last frames do not vanish in a single pop.
        mat.opacity = 1 - k * k;
        return k < 1;
      },
      dispose() {
        root.remove(pts);
        geo.dispose();
        mat.dispose();
      },
    });
  }
  /**
   * The expanding ring a spell leaves behind.
   *
   * A flat ring rather than a particle cloud: a ring reads as a precise
   * radius, and the radius is the thing being judged - "did that fireball
   * actually cover my tank". A cloud would only say "something happened
   * there" and leave the player guessing.
   */
  function ring(x, z, color, radius, opts = {}) {
    const life = opts.life || 0.55;
    const geo = new THREE.RingGeometry(0.86, 1, 48);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.08, z);
    m.frustumCulled = false;
    root.add(m);

    live.push({
      t: 0,
      life,
      step(dt) {
        this.t += dt;
        const k = Math.min(1, this.t / this.life);
        // Overshoot the true radius slightly, then settle. The ring visibly
        // lands on the edge of the effect instead of fading before the player
        // has seen how big it was.
        const grow = k < 0.75 ? (k / 0.75) * 1.08 : 1.08 - (k - 0.75) * 0.08;
        m.scale.setScalar(radius * grow);
        mat.opacity = 0.9 * (1 - k * k);
        return k < 1;
      },
      dispose() {
        root.remove(m);
        geo.dispose();
        mat.dispose();
      },
    });
  }
  // The flat touch-deployment overlay: the player's legal half, in green.
  let zone = null;

  /**
   * Show or hide the deployment zone.
   * Includes a semitransparent green field and a glowing energy border line at Z = DEPLOY.nearZ (1.2).
   */
  function setDeployZone(on) {
    if (on && !zone) {
      const g = new THREE.Group();
      const geo = new THREE.PlaneGeometry(DEPLOY.edge * 2, DEPLOY.farZ - DEPLOY.nearZ);
      const mat = new THREE.MeshBasicMaterial({
        color: PALETTE.hpGreen,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
      });
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(0, 0.05, (DEPLOY.nearZ + DEPLOY.farZ) / 2);
      m.renderOrder = 2;
      g.add(m);

      // Glowing energy border strip at Z = DEPLOY.nearZ (1.2)
      const borderGeo = new THREE.BoxGeometry(DEPLOY.edge * 2, 0.08, 0.24);
      const borderMat = new THREE.MeshBasicMaterial({
        color: PALETTE.hpGreen,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
      });
      const borderMesh = new THREE.Mesh(borderGeo, borderMat);
      borderMesh.position.set(0, 0.08, DEPLOY.nearZ);
      g.add(borderMesh);

      root.add(g);
      zone = { g, geo, mat, borderGeo, borderMat, time: 0 };
    } else if (!on && zone) {
      root.remove(zone.g);
      zone.geo.dispose();
      zone.mat.dispose();
      zone.borderGeo.dispose();
      zone.borderMat.dispose();
      zone = null;
    }
  }

  /**
   * Launch a parabolic projectile from (sx, sy, sz) to (tx, 0, tz).
   * @param {number} sx start world x
   * @param {number} sy start world y
   * @param {number} sz start world z
   * @param {number} tx target world x
   * @param {number} tz target world z
   * @param {number} color hex
   * @param {number} [duration] seconds (default 0.45s)
   * @param {Function} [onImpact] callback when projectile reaches ground
   */
  function spellProjectile(sx, sy, sz, tx, tz, color, duration = 0.45, onImpact = null) {
    const pGroup = new THREE.Group();

    // Voxel core
    const coreGeo = new THREE.BoxGeometry(0.44, 0.44, 0.44);
    const coreMat = new THREE.MeshBasicMaterial({ color });
    const coreMesh = new THREE.Mesh(coreGeo, coreMat);
    pGroup.add(coreMesh);

    // Glowing halo
    const haloGeo = new THREE.BoxGeometry(0.68, 0.68, 0.68);
    const haloMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });
    const haloMesh = new THREE.Mesh(haloGeo, haloMat);
    pGroup.add(haloMesh);

    pGroup.position.set(sx, sy, sz);
    root.add(pGroup);

    const arcHeight = 6.8;

    live.push({
      t: 0,
      life: duration,
      step(dt) {
        this.t += dt;
        const k = Math.min(1, this.t / this.life);
        const px = sx + (tx - sx) * k;
        const pz = sz + (tz - sz) * k;
        // Parabolic arc with peak height
        const py = Math.max(0.1, sy * (1 - k) + 4 * arcHeight * k * (1 - k));
        pGroup.position.set(px, py, pz);

        coreMesh.rotation.x += 14 * dt;
        coreMesh.rotation.y += 18 * dt;
        haloMesh.rotation.z += 9 * dt;

        // Emitter trail
        if (Math.random() < 0.7) {
          burst(px, pz, color, { count: 3, life: 0.24, speed: 0.9, size: 0.12, rise: 0.6 });
        }

        if (k >= 1) {
          if (onImpact) onImpact();
          return false;
        }
        return true;
      },
      dispose() {
        root.remove(pGroup);
        coreGeo.dispose();
        coreMat.dispose();
        haloGeo.dispose();
        haloMat.dispose();
      },
    });
  }

  /**
   * Launch a ranged physical projectile (arrow or bullet) towards target.
   * Calls onHit when the projectile reaches its destination.
   *
   * @param {number} sx start world x
   * @param {number} sy start world y
   * @param {number} sz start world z
   * @param {object} target target entity or {x, z}
   * @param {number} [speed=16] units per second
   * @param {Function} [onHit] callback on arrival
   * @param {number} [color=0xffd166] projectile color
   */
  function arrowProjectile(sx, sy, sz, target, speed = 16, onHit = null, color = 0xffd166) {
    const pGroup = new THREE.Group();

    const getTargetPos = () => {
      let tObj = target;
      if (tObj && tObj.ref) tObj = tObj.ref;
      const tx = tObj ? (tObj.x ?? 0) : sx;
      const tz = tObj ? (tObj.z ?? 0) : sz;
      const ty = (tObj && (tObj.kind === 'tower' || tObj.maxHp > 1000)) ? 1.6 : 1.2;
      return { tx, ty, tz };
    };

    const initial = getTargetPos();
    const dist = Math.hypot(initial.tx - sx, initial.tz - sz);
    const spd = speed > 0 ? speed : 16;
    const duration = Math.max(0.08, dist / spd);

    // Slim colored arrow shaft
    const shaftGeo = new THREE.BoxGeometry(0.12, 0.12, 0.65);
    const shaftMat = new THREE.MeshBasicMaterial({ color: color || 0xffd166 });
    const shaftMesh = new THREE.Mesh(shaftGeo, shaftMat);
    pGroup.add(shaftMesh);

    // Bright glowing arrowhead tip
    const tipGeo = new THREE.BoxGeometry(0.2, 0.2, 0.24);
    const tipMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const tipMesh = new THREE.Mesh(tipGeo, tipMat);
    tipMesh.position.set(0, 0, 0.32);
    pGroup.add(tipMesh);

    pGroup.position.set(sx, sy, sz);
    root.add(pGroup);

    live.push({
      t: 0,
      life: duration,
      step(dt) {
        this.t += dt;
        const k = Math.min(1, this.t / this.life);
        const { tx, ty, tz } = getTargetPos();
        const px = sx + (tx - sx) * k;
        const py = sy + (ty - sy) * k + Math.sin(k * Math.PI) * 0.35;
        const pz = sz + (tz - sz) * k;

        pGroup.position.set(px, py, pz);
        // Face forward along trajectory
        pGroup.rotation.y = Math.atan2(tx - sx, tz - sz);

        if (k >= 1) {
          if (onHit) onHit();
          return false;
        }
        return true;
      },
      dispose() {
        root.remove(pGroup);
        shaftGeo.dispose();
        shaftMat.dispose();
        tipGeo.dispose();
        tipMat.dispose();
      },
    });
  }

  /**
   * Quick melee slash arc trail (crescent sweep).
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} facingAngle
   * @param {number} [color=0xffffff]
   */
  function meleeSlash(x, y, z, facingAngle, color = 0xffffff) {
    const slashGroup = new THREE.Group();
    // Offset slightly forward in front of unit
    const ox = Math.sin(facingAngle) * 0.55;
    const oz = Math.cos(facingAngle) * 0.55;
    slashGroup.position.set(x + ox, y || 1.2, z + oz);

    const geo = new THREE.RingGeometry(0.65, 1.35, 20, 1, -Math.PI * 0.45, Math.PI * 0.9);
    const mat = new THREE.MeshBasicMaterial({
      color: color || 0xffffff,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = Math.PI / 2 - facingAngle;
    mesh.rotation.y = 0.22; // subtle dynamic tilt
    slashGroup.add(mesh);

    root.add(slashGroup);

    live.push({
      t: 0,
      life: 0.16,
      step(dt) {
        this.t += dt;
        const k = Math.min(1, this.t / this.life);
        const scale = 0.75 + k * 0.65;
        mesh.scale.set(scale, scale, 1);
        mat.opacity = (1 - k) * 0.85;
        return k < 1;
      },
      dispose() {
        root.remove(slashGroup);
        geo.dispose();
        mat.dispose();
      },
    });
  }

  /**
   * Sharp hit sparks on weapon impact.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} [color=0xffe066]
   */
  function hitSparks(x, y, z, color = 0xffe066) {
    burst(x, z, color, {
      count: 7,
      life: 0.25,
      speed: 3.4,
      size: 0.15,
      rise: 2.2,
      y: y != null ? y : 1.4,
    });
  }

  /**
   * Fast tower defense projectile.
   */
  function towerProjectile(sx, sy, sz, target, speed = 18, onHit = null, color = 0xffe066) {
    return arrowProjectile(sx, sy, sz, target, speed, onHit, color);
  }

  /**
   * Unit defeat effect: white smoke puff with colorful bouncing voxel debris.
   *
   * @param {number} x
   * @param {number} z
   * @param {number|string} [color=0xffffff]
   */
  function koPoof(x, z, color = 0xffffff) {
    const colHex = typeof color === 'string'
      ? (parseInt(color.replace('#', ''), 16) || 0xffffff)
      : (color || 0xffffff);

    // White smoke puff
    burst(x, z, 0xffffff, {
      count: 9,
      life: 0.35,
      speed: 2.2,
      size: 0.28,
      rise: 2.4,
      y: 1.0,
    });

    const count = 6;
    const g = new THREE.Group();
    g.position.set(x, 0.8, z);
    const boxGeo = new THREE.BoxGeometry(0.24, 0.24, 0.24);
    const boxMat = new THREE.MeshBasicMaterial({
      color: colHex,
      transparent: true,
      opacity: 1,
    });
    const pieces = [];
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(boxGeo, boxMat);
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      const spd = 2.4 + Math.random() * 1.6;
      pieces.push({
        mesh: m,
        vx: Math.cos(angle) * spd,
        vy: 3.4 + Math.random() * 2.2,
        vz: Math.sin(angle) * spd,
        rx: (Math.random() - 0.5) * 16,
        ry: (Math.random() - 0.5) * 16,
      });
      g.add(m);
    }
    root.add(g);

    live.push({
      t: 0,
      life: 0.35,
      step(dt) {
        this.t += dt;
        const k = Math.min(1, this.t / this.life);
        for (const p of pieces) {
          p.mesh.position.x += p.vx * dt;
          p.mesh.position.y = Math.max(0, p.mesh.position.y + p.vy * dt);
          p.mesh.position.z += p.vz * dt;
          p.vy -= 14 * dt;
          p.mesh.rotation.x += p.rx * dt;
          p.mesh.rotation.y += p.ry * dt;
        }
        boxMat.opacity = Math.max(0, 1 - k * k);
        return k < 1;
      },
      dispose() {
        root.remove(g);
        boxGeo.dispose();
        boxMat.dispose();
      },
    });
  }

  /**
   * Advance every live effect and drop the finished ones.
   * @param {number} dt
   */
  function update(dt) {
    if (zone) {
      zone.time += dt;
      // Gentle pulse on border line opacity
      zone.borderMat.opacity = 0.65 + Math.sin(zone.time * 6) * 0.22;
    }
    for (let i = live.length - 1; i >= 0; i--) {
      const fx = live[i];
      if (!fx.step(dt)) {
        fx.dispose();
        live.splice(i, 1);
      }
    }
  }
  return {
    root,
    update,
    setDeployZone,
    spellProjectile,
    arrowProjectile,
    towerProjectile,
    meleeSlash,
    hitSparks,
    koPoof,
    /** A blue or red puff where a unit appears. */
    deployBurst(x, z, side) {
      burst(x, z, TEAM_COLOR[side] || PALETTE.player, { count: 8, life: 0.4 });
    },
    /** Grey chunks thrown out of a falling tower. */
    rubble(x, z, color) {
      burst(x, z, color || PALETTE.stone, {
        count: 14,
        life: 0.7,
        speed: 3.4,
        size: 0.22,
        rise: 3.2,
      });
    },
    /** The ring a spell leaves at its target. */
    spellRing(x, z, color, radius) {
      ring(x, z, color, radius);
    },
    /** A ring plus a matching particle pop, for spells that do damage. */
    spellBlast(x, z, color, radius) {
      ring(x, z, color, radius);
      burst(x, z, color, { count: 10, life: 0.5, speed: radius * 0.9, size: 0.2 });
    },
    /** How many effects are still running. Used by the dev probe. */
    get liveCount() { return live.length; },
  };
}