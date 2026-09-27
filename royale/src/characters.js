// ── characters.js ───────────────────────────────────────────────────────
// The character roster. Each entry is data plus a `build()` that returns the
// voxel mesh, so adding a character never touches game logic.
//

import * as THREE from 'three';
import { vox } from './voxel.js';

export const CHARACTERS = [
  {
    id: 'armor',
    name: 'ARMOR',
    role: 'Gold Mecha · Glow Visor',
    color: '#c7a458',
    rarity: 'legendary',
    avatarChar: 'A',
    unlocked: true,
    build: () => {
      const g = new THREE.Group();
      const legL = new THREE.Group(); legL.position.set(-0.24, 0.42, 0);
      legL.add(vox(0.36, 0.16, 0.44, 0x1c1a1b, { y: -0.34, z: 0.04 }));
      legL.add(vox(0.28, 0.5, 0.3, 0xefe9dc, { y: -0.05 }));

      const legR = new THREE.Group(); legR.position.set(0.24, 0.42, 0);
      legR.add(vox(0.36, 0.16, 0.44, 0x1c1a1b, { y: -0.34, z: 0.04 }));
      legR.add(vox(0.28, 0.5, 0.3, 0xefe9dc, { y: -0.05 }));
      g.add(legL, legR); g.legL = legL; g.legR = legR;

      const body = vox(1.0, 0.82, 0.78, 0xc7a458, { y: 0.95 });
      const grill1 = vox(0.65, 0.1, 0.05, 0x1c1a1b, { y: 1.12, z: 0.4 });
      const grill2 = vox(0.65, 0.1, 0.05, 0x1c1a1b, { y: 0.88, z: 0.4 });
      const backStripe = vox(0.18, 0.65, 0.04, 0x1c1a1b, { y: 0.95, z: -0.40 });
      g.add(body, grill1, grill2, backStripe);

      const armL = new THREE.Group(); armL.position.set(-0.62, 0.98, 0);
      armL.add(vox(0.24, 0.58, 0.24, 0xc7a458, { y: -0.15 }));
      armL.add(vox(0.26, 0.18, 0.26, 0xefe9dc, { y: -0.45 }));

      const armR = new THREE.Group(); armR.position.set(0.62, 0.98, 0);
      armR.add(vox(0.24, 0.58, 0.24, 0xc7a458, { y: -0.15 }));
      armR.add(vox(0.26, 0.18, 0.26, 0xefe9dc, { y: -0.45 }));
      g.add(armL, armR); g.armL = armL; g.armR = armR;

      const head = vox(1.08, 0.96, 1.05, 0xc7a458, { y: 1.9 });
      const eyeL = vox(0.24, 0.24, 0.05, 0xffd772, { x: -0.26, y: 1.94, z: 0.54 });
      const eyeR = vox(0.24, 0.24, 0.05, 0xffd772, { x: 0.26, y: 1.94, z: 0.54 });
      eyeL.material = new THREE.MeshBasicMaterial({ color: 0xffd772 });
      eyeR.material = new THREE.MeshBasicMaterial({ color: 0xffd772 });

      const earL = vox(0.12, 0.6, 0.18, 0xece2c8, { x: -0.58, y: 2.3, z: -0.1 });
      const earR = vox(0.12, 0.6, 0.18, 0xece2c8, { x: 0.58, y: 2.3, z: -0.1 });
      const backBun = vox(0.18, 0.35, 0.14, 0x1c1a1b, { y: 1.90, z: -0.53 });
      g.add(head, eyeL, eyeR, earL, earR, backBun);
      return g;
    }
  },
  {
    id: 'mist',
    name: 'MIST',
    role: 'Ghost Skull · Cyan Translucent',
    color: '#62f2cc',
    rarity: 'epic',
    avatarChar: 'M',
    unlocked: true,
    build: () => {
      const g = new THREE.Group();
      const ghostMat = new THREE.MeshLambertMaterial({ color: 0x6fe3c3, transparent: true, opacity: 0.72 });

      const legL = new THREE.Group(); legL.position.set(-0.22, 0.42, 0);
      legL.add(new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.6, 0.3), ghostMat));
      const legR = new THREE.Group(); legR.position.set(0.22, 0.42, 0);
      legR.add(new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.6, 0.3), ghostMat));
      g.add(legL, legR); g.legL = legL; g.legR = legR;

      const body = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.8, 0.76), ghostMat);
      body.position.y = 0.95;
      g.add(body);

      const armL = new THREE.Group(); armL.position.set(-0.58, 0.98, 0);
      armL.add(new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.6, 0.24), ghostMat));
      const armR = new THREE.Group(); armR.position.set(0.58, 0.98, 0);
      armR.add(new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.6, 0.24), ghostMat));
      g.add(armL, armR); g.armL = armL; g.armR = armR;

      const head = new THREE.Mesh(new THREE.BoxGeometry(1.06, 0.96, 1.02), ghostMat);
      head.position.y = 1.9;
      const eyeL = vox(0.26, 0.3, 0.08, 0x125f4b, { x: -0.24, y: 1.94, z: 0.5 });
      const eyeR = vox(0.26, 0.3, 0.08, 0x125f4b, { x: 0.24, y: 1.94, z: 0.5 });
      const mouthHole = vox(0.28, 0.2, 0.08, 0x125f4b, { y: 1.62, z: 0.5 });
      const topNodes = vox(0.3, 0.22, 0.3, 0x6fe3c3, { y: 2.45 });
      const backBun = vox(0.18, 0.35, 0.14, 0x125f4b, { y: 1.90, z: -0.52 });
      g.add(head, eyeL, eyeR, mouthHole, topNodes, backBun);
      return g;
    }
  },
  {
    id: 'pip',
    name: 'PIP',
    role: 'Cute Folk · Pink Bun',
    color: '#f2a7bc',
    rarity: 'common',
    avatarChar: 'P',
    unlocked: true,
    build: () => {
      const g = new THREE.Group();
      const legL = new THREE.Group(); legL.position.set(-0.22, 0.42, 0);
      legL.add(vox(0.34, 0.16, 0.44, 0x1c1a1b, { y: -0.34, z: 0.04 }));
      legL.add(vox(0.26, 0.5, 0.28, 0x2a2224, { y: -0.05 }));

      const legR = new THREE.Group(); legR.position.set(0.22, 0.42, 0);
      legR.add(vox(0.34, 0.16, 0.44, 0x1c1a1b, { y: -0.34, z: 0.04 }));
      legR.add(vox(0.26, 0.5, 0.28, 0x2a2224, { y: -0.05 }));
      g.add(legL, legR); g.legL = legL; g.legR = legR;

      const body = vox(0.9, 0.78, 0.74, 0xf2a7bc, { y: 0.95 });
      const stripe = vox(0.18, 0.65, 0.04, 0xf3ece2, { y: 0.95, z: 0.38 });
      const backStripe = vox(0.18, 0.65, 0.04, 0xf3ece2, { y: 0.95, z: -0.38 });
      g.add(body, stripe, backStripe);

      const armL = new THREE.Group(); armL.position.set(-0.56, 0.98, 0);
      armL.add(vox(0.22, 0.6, 0.22, 0xf2a7bc, { y: -0.15 }));
      const armR = new THREE.Group(); armR.position.set(0.56, 0.98, 0);
      armR.add(vox(0.22, 0.6, 0.22, 0xf2a7bc, { y: -0.15 }));
      g.add(armL, armR); g.armL = armL; g.armR = armR;

      const head = vox(1.05, 0.94, 1.0, 0xf2a7bc, { y: 1.88 });
      const eyeL = vox(0.34, 0.34, 0.04, 0xf3efe6, { x: -0.26, y: 1.92, z: 0.52 });
      const eyeR = vox(0.34, 0.34, 0.04, 0xf3efe6, { x: 0.26, y: 1.92, z: 0.52 });
      const pupL = vox(0.14, 0.14, 0.06, 0x1c1a1b, { x: -0.24, y: 1.9, z: 0.54 });
      const pupR = vox(0.14, 0.14, 0.06, 0x1c1a1b, { x: 0.24, y: 1.9, z: 0.54 });
      const ribbon = vox(0.3, 0.18, 0.24, 0xe8607f, { y: 2.44 });
      const bun = vox(0.18, 0.35, 0.18, 0xeee6da, { y: 2.65 });
      const backBun = vox(0.18, 0.35, 0.14, 0xeee6da, { y: 1.90, z: -0.50 });
      g.add(head, eyeL, eyeR, pupL, pupR, ribbon, bun, backBun);
      return g;
    }
  },
  {
    id: 'honey',
    name: 'HONEY',
    role: 'Bee Folk · Cyan Gloves',
    color: '#f0d44d',
    rarity: 'rare',
    avatarChar: 'H',
    unlocked: true,
    build: () => {
      const g = new THREE.Group();
      const legL = new THREE.Group(); legL.position.set(-0.22, 0.42, 0);
      legL.add(vox(0.34, 0.16, 0.44, 0x141112, { y: -0.34, z: 0.04 }));
      legL.add(vox(0.26, 0.5, 0.28, 0x2b1e22, { y: -0.05 }));

      const legR = new THREE.Group(); legR.position.set(0.22, 0.42, 0);
      legR.add(vox(0.34, 0.16, 0.44, 0x141112, { y: -0.34, z: 0.04 }));
      legR.add(vox(0.26, 0.5, 0.28, 0x2b1e22, { y: -0.05 }));
      g.add(legL, legR); g.legL = legL; g.legR = legR;

      const body = vox(0.92, 0.8, 0.76, 0x2b1e22, { y: 0.95 });
      const beeStripe = vox(0.94, 0.24, 0.78, 0xf0d44d, { y: 1.05 });
      const backStripe = vox(0.18, 0.65, 0.04, 0xf0d44d, { y: 0.95, z: -0.39 });
      g.add(body, beeStripe, backStripe);

      const armL = new THREE.Group(); armL.position.set(-0.58, 0.98, 0);
      armL.add(vox(0.24, 0.58, 0.24, 0xf0d44d, { y: -0.15 }));
      armL.add(vox(0.26, 0.18, 0.26, 0x3fd7ea, { y: -0.45 }));

      const armR = new THREE.Group(); armR.position.set(0.58, 0.98, 0);
      armR.add(vox(0.24, 0.58, 0.24, 0xf0d44d, { y: -0.15 }));
      armR.add(vox(0.26, 0.18, 0.26, 0x3fd7ea, { y: -0.45 }));
      g.add(armL, armR); g.armL = armL; g.armR = armR;

      const head = vox(1.06, 0.94, 1.02, 0xf0d44d, { y: 1.88 });
      const eyeL = vox(0.34, 0.34, 0.04, 0xf3efe6, { x: -0.26, y: 1.92, z: 0.52 });
      const eyeR = vox(0.34, 0.34, 0.04, 0xf3efe6, { x: 0.26, y: 1.92, z: 0.52 });
      const pupL = vox(0.14, 0.14, 0.06, 0x1c1a1b, { x: -0.24, y: 1.9, z: 0.54 });
      const pupR = vox(0.14, 0.14, 0.06, 0x1c1a1b, { x: 0.24, y: 1.9, z: 0.54 });
      const antL = vox(0.14, 0.32, 0.14, 0x1c1a1b, { x: -0.32, y: 2.45 });
      const antR = vox(0.14, 0.32, 0.14, 0x1c1a1b, { x: 0.32, y: 2.45 });
      const backBun = vox(0.18, 0.35, 0.14, 0x2b1e22, { y: 1.90, z: -0.52 });
      g.add(head, eyeL, eyeR, pupL, pupR, antL, antR, backBun);
      return g;
    }
  },
  {
    id: 'goggles',
    name: 'GOGGLES',
    role: 'Steampunk Engineer',
    color: '#6a4a2c',
    rarity: 'rare',
    avatarChar: 'G',
    unlocked: true,
    build: () => {
      const g = new THREE.Group();
      const legL = new THREE.Group(); legL.position.set(-0.22, 0.42, 0);
      legL.add(vox(0.34, 0.16, 0.44, 0x161616, { y: -0.34, z: 0.04 }));
      legL.add(vox(0.26, 0.5, 0.28, 0x22324a, { y: -0.05 }));
      const legR = new THREE.Group(); legR.position.set(0.22, 0.42, 0);
      legR.add(vox(0.34, 0.16, 0.44, 0x161616, { y: -0.34, z: 0.04 }));
      legR.add(vox(0.26, 0.5, 0.28, 0x22324a, { y: -0.05 }));
      g.add(legL, legR); g.legL = legL; g.legR = legR;

      const body = vox(0.94, 0.8, 0.78, 0x5a3a22, { y: 0.95 });
      const belt = vox(0.96, 0.16, 0.8, 0xd8432d, { y: 0.7 });
      const backStripe = vox(0.18, 0.65, 0.04, 0xd8432d, { y: 0.95, z: -0.40 });
      g.add(body, belt, backStripe);

      const armL = new THREE.Group(); armL.position.set(-0.58, 0.98, 0);
      armL.add(vox(0.24, 0.58, 0.24, 0x6a4a2c, { y: -0.15 }));
      const armR = new THREE.Group(); armR.position.set(0.58, 0.98, 0);
      armR.add(vox(0.24, 0.58, 0.24, 0x6a4a2c, { y: -0.15 }));
      g.add(armL, armR); g.armL = armL; g.armR = armR;

      const head = vox(1.08, 0.95, 1.05, 0x6a4a2c, { y: 1.88 });
      const goggleFrame = vox(1.12, 0.42, 0.2, 0x6b6a3c, { y: 1.95, z: 0.5 });
      const lensL = vox(0.32, 0.32, 0.06, 0xd7f58a, { x: -0.26, y: 1.95, z: 0.6 });
      const lensR = vox(0.32, 0.32, 0.06, 0xd7f58a, { x: 0.26, y: 1.95, z: 0.6 });
      lensL.material = new THREE.MeshBasicMaterial({ color: 0xd7f58a });
      lensR.material = new THREE.MeshBasicMaterial({ color: 0xd7f58a });
      const backBun = vox(0.18, 0.35, 0.14, 0xd8432d, { y: 1.90, z: -0.53 });
      g.add(head, goggleFrame, lensL, lensR, backBun);
      return g;
    }
  },
  {
    id: 'captain',
    name: 'CAPTAIN',
    role: 'Army Officer · Green Cap',
    color: '#2a74bd',
    rarity: 'epic',
    avatarChar: 'C',
    unlocked: true,
    build: () => {
      const g = new THREE.Group();
      const legL = new THREE.Group(); legL.position.set(-0.22, 0.42, 0);
      legL.add(vox(0.34, 0.16, 0.44, 0xe9c64a, { y: -0.34, z: 0.04 }));
      legL.add(vox(0.26, 0.5, 0.28, 0x2a74bd, { y: -0.05 }));
      const legR = new THREE.Group(); legR.position.set(0.22, 0.42, 0);
      legR.add(vox(0.34, 0.16, 0.44, 0xe9c64a, { y: -0.34, z: 0.04 }));
      legR.add(vox(0.26, 0.5, 0.28, 0x2a74bd, { y: -0.05 }));
      g.add(legL, legR); g.legL = legL; g.legR = legR;

      const body = vox(0.96, 0.82, 0.78, 0x2a74bd, { y: 0.95 });
      const greenCoat = vox(0.98, 0.3, 0.8, 0x25623a, { y: 1.05 });
      const backStripe = vox(0.18, 0.65, 0.04, 0xe9c64a, { y: 0.95, z: -0.40 });
      g.add(body, greenCoat, backStripe);

      const armL = new THREE.Group(); armL.position.set(-0.6, 0.98, 0);
      armL.add(vox(0.24, 0.6, 0.24, 0x2a74bd, { y: -0.15 }));
      const armR = new THREE.Group(); armR.position.set(0.6, 0.98, 0);
      armR.add(vox(0.24, 0.6, 0.24, 0x2a74bd, { y: -0.15 }));
      g.add(armL, armR); g.armL = armL; g.armR = armR;

      const head = vox(1.08, 0.94, 1.04, 0x2a74bd, { y: 1.88 });
      const capBrim = vox(1.2, 0.16, 0.5, 0x6b6440, { y: 2.35, z: 0.25 });
      const capTop = vox(1.08, 0.35, 1.0, 0x6b6440, { y: 2.48 });
      const eyeL = vox(0.28, 0.24, 0.04, 0xffd772, { x: -0.24, y: 1.92, z: 0.53 });
      const eyeR = vox(0.28, 0.24, 0.04, 0xffd772, { x: 0.24, y: 1.92, z: 0.53 });
      eyeL.material = new THREE.MeshBasicMaterial({ color: 0xffd772 });
      eyeR.material = new THREE.MeshBasicMaterial({ color: 0xffd772 });
      const backBun = vox(0.18, 0.35, 0.14, 0xe9c64a, { y: 1.90, z: -0.53 });
      g.add(head, capBrim, capTop, eyeL, eyeR, backBun);
      return g;
    }
  },
  {
    id: 'lavender',
    name: 'LAVENDER',
    role: 'Purple Bunny · Dreamer',
    color: '#b08be0',
    rarity: 'rare',
    avatarChar: 'L',
    unlocked: true,
    build: () => {
      const g = new THREE.Group();
      const legL = new THREE.Group(); legL.position.set(-0.22, 0.42, 0);
      legL.add(vox(0.34, 0.16, 0.44, 0x9a70d6, { y: -0.34, z: 0.04 }));
      legL.add(vox(0.26, 0.5, 0.28, 0xb08be0, { y: -0.05 }));
      const legR = new THREE.Group(); legR.position.set(0.22, 0.42, 0);
      legR.add(vox(0.34, 0.16, 0.44, 0x9a70d6, { y: -0.34, z: 0.04 }));
      legR.add(vox(0.26, 0.5, 0.28, 0xb08be0, { y: -0.05 }));
      g.add(legL, legR); g.legL = legL; g.legR = legR;

      const body = vox(0.92, 0.8, 0.76, 0xb08be0, { y: 0.95 });
      const belly = vox(0.65, 0.55, 0.05, 0xdcc8f5, { y: 0.95, z: 0.39 });
      const backStripe = vox(0.18, 0.65, 0.04, 0xdcc8f5, { y: 0.95, z: -0.39 });
      g.add(body, belly, backStripe);

      const armL = new THREE.Group(); armL.position.set(-0.58, 0.98, 0);
      armL.add(vox(0.24, 0.6, 0.24, 0xb08be0, { y: -0.15 }));
      const armR = new THREE.Group(); armR.position.set(0.58, 0.98, 0);
      armR.add(vox(0.24, 0.6, 0.24, 0xb08be0, { y: -0.15 }));
      g.add(armL, armR); g.armL = armL; g.armR = armR;

      const head = vox(1.06, 0.95, 1.02, 0xb08be0, { y: 1.88 });
      const eyeL = vox(0.32, 0.32, 0.04, 0xefe6fb, { x: -0.26, y: 1.92, z: 0.52 });
      const eyeR = vox(0.32, 0.32, 0.04, 0xefe6fb, { x: 0.26, y: 1.92, z: 0.52 });
      const pupL = vox(0.14, 0.14, 0.06, 0x6d4fa0, { x: -0.24, y: 1.9, z: 0.54 });
      const pupR = vox(0.14, 0.14, 0.06, 0x6d4fa0, { x: 0.24, y: 1.9, z: 0.54 });
      const earL = vox(0.2, 0.6, 0.18, 0x9a70d6, { x: -0.28, y: 2.6 });
      const earR = vox(0.2, 0.6, 0.18, 0x9a70d6, { x: 0.28, y: 2.6 });
      const backBun = vox(0.18, 0.35, 0.14, 0xdcc8f5, { y: 1.90, z: -0.52 });
      g.add(head, eyeL, eyeR, pupL, pupR, earL, earR, backBun);
      return g;
    }
  },
  {
    id: 'tux',
    name: 'TUX',
    role: 'Dark Purple · Cyan Tie',
    color: '#5b36a0',
    rarity: 'common',
    avatarChar: 'T',
    unlocked: true,
    build: () => {
      const g = new THREE.Group();
      const legL = new THREE.Group(); legL.position.set(-0.22, 0.42, 0);
      legL.add(vox(0.34, 0.16, 0.44, 0x1f1d22, { y: -0.34, z: 0.04 }));
      legL.add(vox(0.26, 0.5, 0.28, 0x1f1d22, { y: -0.05 }));
      const legR = new THREE.Group(); legR.position.set(0.22, 0.42, 0);
      legR.add(vox(0.34, 0.16, 0.44, 0x1f1d22, { y: -0.34, z: 0.04 }));
      legR.add(vox(0.26, 0.5, 0.28, 0x1f1d22, { y: -0.05 }));
      g.add(legL, legR); g.legL = legL; g.legR = legR;

      const body = vox(0.94, 0.8, 0.76, 0x4d2d8e, { y: 0.95 });
      const tieKnot = vox(0.22, 0.16, 0.06, 0x3fe2ec, { y: 1.15, z: 0.39 });
      const tieBody = vox(0.14, 0.38, 0.06, 0x3fe2ec, { y: 0.95, z: 0.39 });
      tieKnot.material = new THREE.MeshBasicMaterial({ color: 0x3fe2ec });
      tieBody.material = new THREE.MeshBasicMaterial({ color: 0x3fe2ec });
      const backStripe = vox(0.18, 0.65, 0.04, 0x3fe2ec, { y: 0.95, z: -0.39 });
      g.add(body, tieKnot, tieBody, backStripe);

      const armL = new THREE.Group(); armL.position.set(-0.58, 0.98, 0);
      armL.add(vox(0.24, 0.58, 0.24, 0x5b36a0, { y: -0.15 }));
      armL.add(vox(0.26, 0.18, 0.26, 0xe8e4dc, { y: -0.45 }));
      const armR = new THREE.Group(); armR.position.set(0.58, 0.98, 0);
      armR.add(vox(0.24, 0.58, 0.24, 0x5b36a0, { y: -0.15 }));
      armR.add(vox(0.26, 0.18, 0.26, 0xe8e4dc, { y: -0.45 }));
      g.add(armL, armR); g.armL = armL; g.armR = armR;

      const head = vox(1.08, 0.95, 1.04, 0x5b36a0, { y: 1.88 });
      const eyeL = vox(0.32, 0.32, 0.04, 0xf3efe6, { x: -0.26, y: 1.92, z: 0.52 });
      const eyeR = vox(0.32, 0.32, 0.04, 0xf3efe6, { x: 0.26, y: 1.92, z: 0.52 });
      const pupL = vox(0.14, 0.14, 0.06, 0x1c1a1b, { x: -0.24, y: 1.9, z: 0.54 });
      const pupR = vox(0.14, 0.14, 0.06, 0x1c1a1b, { x: 0.24, y: 1.9, z: 0.54 });
      const hairL = vox(0.18, 0.24, 0.24, 0x1f2420, { x: -0.2, y: 2.45 });
      const hairR = vox(0.18, 0.24, 0.24, 0x1f2420, { x: 0.2, y: 2.45 });
      const backBun = vox(0.18, 0.35, 0.14, 0x3fe2ec, { y: 1.90, z: -0.53 });
      g.add(head, eyeL, eyeR, pupL, pupR, hairL, hairR, backBun);
      return g;
    }
  },
  {
    id: 'mrhat',
    name: 'MR. HAT',
    role: 'Dapper Gent · Emerald Cap',
    color: '#b89c5e',
    rarity: 'common',
    avatarChar: 'M',
    unlocked: true,
    build: () => {
      const g = new THREE.Group();
      const legL = new THREE.Group(); legL.position.set(-0.22, 0.42, 0);
      legL.add(vox(0.34, 0.16, 0.44, 0x2fb58f, { y: -0.34, z: 0.04 }));
      legL.add(vox(0.26, 0.5, 0.28, 0xb89c5e, { y: -0.05 }));
      const legR = new THREE.Group(); legR.position.set(0.22, 0.42, 0);
      legR.add(vox(0.34, 0.16, 0.44, 0x2fb58f, { y: -0.34, z: 0.04 }));
      legR.add(vox(0.26, 0.5, 0.28, 0xb89c5e, { y: -0.05 }));
      g.add(legL, legR); g.legL = legL; g.legR = legR;

      const body = vox(0.92, 0.8, 0.76, 0xb89c5e, { y: 0.95 });
      const greenVest = vox(0.94, 0.24, 0.78, 0x2fb58f, { y: 0.95 });
      const backStripe = vox(0.18, 0.65, 0.04, 0x2fb58f, { y: 0.95, z: -0.40 });
      g.add(body, greenVest, backStripe);

      const armL = new THREE.Group(); armL.position.set(-0.58, 0.98, 0);
      armL.add(vox(0.24, 0.58, 0.24, 0xb89c5e, { y: -0.15 }));
      armL.add(vox(0.26, 0.18, 0.26, 0xe8e4dc, { y: -0.45 }));
      const armR = new THREE.Group(); armR.position.set(0.58, 0.98, 0);
      armR.add(vox(0.24, 0.58, 0.24, 0xb89c5e, { y: -0.15 }));
      armR.add(vox(0.26, 0.18, 0.26, 0xe8e4dc, { y: -0.45 }));
      g.add(armL, armR); g.armL = armL; g.armR = armR;

      const head = vox(1.06, 0.94, 1.02, 0xb89c5e, { y: 1.88 });
      const hatBrim = vox(1.28, 0.12, 0.54, 0x2fb58f, { y: 2.36, z: 0.26 });
      const hatTop = vox(1.1, 0.32, 1.0, 0xece6d6, { y: 2.48 });
      const eyeL = vox(0.32, 0.32, 0.04, 0xf7f5ef, { x: -0.26, y: 1.92, z: 0.52 });
      const eyeR = vox(0.32, 0.32, 0.04, 0xf7f5ef, { x: 0.26, y: 1.92, z: 0.52 });
      const pupL = vox(0.14, 0.14, 0.06, 0x9a948a, { x: -0.24, y: 1.9, z: 0.54 });
      const pupR = vox(0.14, 0.14, 0.06, 0x9a948a, { x: 0.24, y: 1.9, z: 0.54 });
      const backBun = vox(0.18, 0.35, 0.14, 0x2fb58f, { y: 1.90, z: -0.52 });
      g.add(head, hatBrim, hatTop, eyeL, eyeR, pupL, pupR, backBun);
      return g;
    }
  }
];
