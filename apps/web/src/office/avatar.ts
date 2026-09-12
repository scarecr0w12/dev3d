/**
 * Procedural employee avatars.
 *
 * Each employee is a cheap stylised humanoid built from a dozen boxes and one
 * sphere, coloured from `Role.appearance` (bodyColor / accentColor / height).
 * The point is legibility at a glance across a 22x16 m office: who is where,
 * and what are they doing right now.
 *
 * Status is carried three ways at once - a floor ring when selected, an emissive
 * tint (chest lamp plus a wash over the body), and body language: idle bob,
 * a thinking pulse with a hand at the chin, typing when working, a turned,
 * gesturing body when talking, an amber pulse when blocked, red when errored,
 * and grey immobility when offline.
 *
 * Everything created here is owned here and disposed in `dispose()`.
 */

import * as THREE from 'three';

import type { EmployeeStatus, RoleAppearance } from '@dev3d/core';

import { STATUS_COLOR, STATUS_LABEL, STATUS_STYLE } from '../app/status';

export interface Avatar {
  readonly group: THREE.Group;
  readonly id: string;
  /** Current status; also redraws the name plate. */
  setStatus(status: EmployeeStatus): void;
  getStatus(): EmployeeStatus;
  setSelected(selected: boolean): void;
  /** Sets the yaw the avatar turns to face (radians, +Z forward). */
  setFacing(yaw: number): void;
  update(dt: number, elapsed: number, reducedMotion: boolean): void;
  dispose(): void;
}

const GREY = new THREE.Color('#5b6472');
const LABEL_WIDTH = 320;
const LABEL_HEIGHT = 80;

function angleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

export function createAvatar(id: string, displayName: string, appearance: RoleAppearance): Avatar {
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const bodyColor = new THREE.Color(appearance.bodyColor || '#94a3b8');
  const accentColor = new THREE.Color(appearance.accentColor || '#334155');
  const headColor = bodyColor.clone().lerp(new THREE.Color('#f4d7c2'), 0.55);
  const heightFactor = clamp(appearance.height || 1, 0.8, 1.3);

  const group = new THREE.Group();
  group.name = `Avatar_${id}`;
  group.userData.avatarId = id;
  group.scale.setScalar(heightFactor);

  /** Bobs and leans; the label and selection rings stay outside it. */
  const body = new THREE.Group();
  group.add(body);

  const bodyMat = new THREE.MeshStandardMaterial({ color: bodyColor.clone(), roughness: 0.62, metalness: 0.06 });
  const headMat = new THREE.MeshStandardMaterial({ color: headColor, roughness: 0.72, metalness: 0.02 });
  const accentMat = new THREE.MeshStandardMaterial({ color: accentColor.clone(), roughness: 0.45, metalness: 0.16 });
  const lampMat = new THREE.MeshStandardMaterial({
    color: accentColor.clone().lerp(new THREE.Color('#ffffff'), 0.2),
    emissive: new THREE.Color(STATUS_STYLE.idle.color),
    emissiveIntensity: STATUS_STYLE.idle.intensity,
    roughness: 0.3,
    metalness: 0.1,
  });
  const darkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#20242c'), roughness: 0.55, metalness: 0.25 });
  const screenMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#0b1220'),
    emissive: new THREE.Color('#38bdf8'),
    emissiveIntensity: 0.55,
    roughness: 0.4,
  });
  materials.push(bodyMat, headMat, accentMat, lampMat, darkMat, screenMat);

  const addMesh = (
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh => {
    geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.userData.avatarId = id;
    parent.add(mesh);
    return mesh;
  };

  // ------------------------------------------------------------------- torso
  addMesh(body, new THREE.BoxGeometry(0.30, 0.30, 0.20), darkMat, 0, 0.17, 0); // seated legs
  addMesh(body, new THREE.BoxGeometry(0.34, 0.05, 0.22), accentMat, 0, 0.335, 0); // belt
  addMesh(body, new THREE.BoxGeometry(0.36, 0.40, 0.23), bodyMat, 0, 0.55, 0); // torso
  addMesh(body, new THREE.BoxGeometry(0.44, 0.09, 0.21), accentMat, 0, 0.735, 0); // shoulders
  addMesh(body, new THREE.BoxGeometry(0.10, 0.07, 0.10), darkMat, 0, 0.80, 0); // neck

  // -------------------------------------------------------------------- head
  const head = addMesh(body, new THREE.SphereGeometry(0.128, 16, 12), headMat, 0, 0.925, 0);
  head.scale.set(1, 1.06, 1);
  addMesh(body, new THREE.BoxGeometry(0.21, 0.045, 0.035), accentMat, 0, 0.945, 0.108); // headset band
  addMesh(body, new THREE.BoxGeometry(0.035, 0.085, 0.035), accentMat, 0.135, 0.925, 0.01); // ear cup R
  addMesh(body, new THREE.BoxGeometry(0.035, 0.085, 0.035), accentMat, -0.135, 0.925, 0.01); // ear cup L
  addMesh(body, new THREE.BoxGeometry(0.10, 0.035, 0.02), lampMat, 0, 0.63, 0.118); // chest status lamp

  // -------------------------------------------------------------------- arms
  const arms: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.225, 0.71, 0);
    body.add(pivot);
    addMesh(pivot, new THREE.BoxGeometry(0.095, 0.30, 0.095), bodyMat, 0, -0.16, 0);
    addMesh(pivot, new THREE.BoxGeometry(0.09, 0.07, 0.10), accentMat, 0, -0.33, 0.01); // hand
    arms.push(pivot);
  }
  const armRight = arms[1] ?? null;
  const armLeft = arms[0] ?? null;

  // ------------------------------------------------------- tablet for 'working'
  const tablet = new THREE.Group();
  tablet.position.set(0, 0.60, 0.22);
  tablet.visible = false;
  body.add(tablet);
  addMesh(tablet, new THREE.BoxGeometry(0.30, 0.014, 0.18), darkMat, 0, 0, 0);
  const screen = addMesh(tablet, new THREE.BoxGeometry(0.28, 0.17, 0.012), screenMat, 0, 0.085, -0.075);
  screen.rotation.x = -0.38;

  // ---------------------------------------------------------------- name plate
  const labelCanvas = document.createElement('canvas');
  labelCanvas.width = LABEL_WIDTH;
  labelCanvas.height = LABEL_HEIGHT;
  const labelCtx = labelCanvas.getContext('2d');
  const labelTexture = new THREE.CanvasTexture(labelCanvas);
  labelTexture.colorSpace = THREE.SRGBColorSpace;
  const labelMaterial = new THREE.SpriteMaterial({ map: labelTexture, transparent: true, depthWrite: false });
  materials.push(labelMaterial);
  const label = new THREE.Sprite(labelMaterial);
  label.scale.set(1.72, 0.43, 1);
  label.position.set(0, 1.32, 0);
  label.renderOrder = 5;
  group.add(label);

  const drawLabel = (name: string, status: EmployeeStatus): void => {
    if (!labelCtx) return;
    const ctx = labelCtx;
    ctx.clearRect(0, 0, LABEL_WIDTH, LABEL_HEIGHT);
    roundRectPath(ctx, 2, 8, LABEL_WIDTH - 4, LABEL_HEIGHT - 16, 14);
    ctx.fillStyle = 'rgba(9, 11, 16, 0.74)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(30, 32, 8, 0, Math.PI * 2);
    ctx.fillStyle = STATUS_COLOR[status];
    ctx.fill();

    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e9edf5';
    ctx.font = '600 30px ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif';
    const shown = name.length > 15 ? `${name.slice(0, 14)}…` : name;
    ctx.fillText(shown, 50, 30);

    ctx.fillStyle = 'rgba(190, 200, 216, 0.86)';
    ctx.font = '400 19px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillText(STATUS_LABEL[status], 50, 57);
    labelTexture.needsUpdate = true;
  };

  // ----------------------------------------------------------- selection rings
  const ringGeometry = new THREE.RingGeometry(0.38, 0.47, 44);
  const haloGeometry = new THREE.RingGeometry(0.53, 0.575, 44);
  geometries.push(ringGeometry, haloGeometry);
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#38bdf8'),
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const haloMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color('#7dd3fc'),
    transparent: true,
    opacity: 0.4,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  materials.push(ringMaterial, haloMaterial);
  const ring = new THREE.Mesh(ringGeometry, ringMaterial);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  ring.visible = false;
  const halo = new THREE.Mesh(haloGeometry, haloMaterial);
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.03;
  halo.visible = false;
  group.add(ring, halo);

  // -------------------------------------------------------------------- state
  let status: EmployeeStatus = 'idle';
  let selected = false;
  let facingYaw = 0;
  let currentIntensity = STATUS_STYLE.idle.intensity;
  const currentEmissive = new THREE.Color(STATUS_STYLE.idle.color);
  const targetEmissive = new THREE.Color(STATUS_STYLE.idle.color);
  const targetBodyColor = bodyColor.clone();
  const greyColor = new THREE.Color(GREY);

  drawLabel(displayName, status);

  const applyStyle = (next: EmployeeStatus): void => {
    const style = STATUS_STYLE[next];
    targetEmissive.set(style.color);
    targetBodyColor.copy(bodyColor).lerp(greyColor, style.grey);
  };

  return {
    group,
    id,
    getStatus: () => status,
    setStatus(next) {
      if (next === status) return;
      status = next;
      tablet.visible = next === 'working';
      applyStyle(next);
      drawLabel(displayName, next);
    },
    setSelected(next) {
      if (next === selected) return;
      selected = next;
      ring.visible = next;
      halo.visible = next;
    },
    setFacing(yaw) {
      if (Number.isFinite(yaw)) facingYaw = yaw;
    },
    update(dt, elapsed, reducedMotion) {
      const t = reducedMotion ? 0 : elapsed;
      const style = STATUS_STYLE[status];

      // Turn toward the desk / room smoothly; snap when motion is reduced.
      const delta = angleDelta(group.rotation.y, facingYaw);
      group.rotation.y = reducedMotion ? facingYaw : group.rotation.y + delta * (1 - Math.exp(-9 * dt));

      // Emissive and body tint ease between statuses instead of snapping.
      const k = 1 - Math.exp(-7 * dt);
      currentEmissive.lerp(targetEmissive, k);
      currentIntensity += (style.intensity - currentIntensity) * k;
      bodyMat.color.lerp(targetBodyColor, k);
      lampMat.emissive.copy(currentEmissive);
      lampMat.emissiveIntensity = currentIntensity;
      bodyMat.emissive.copy(currentEmissive);
      bodyMat.emissiveIntensity = currentIntensity * 0.16;
      headMat.emissive.copy(currentEmissive);
      headMat.emissiveIntensity = currentIntensity * 0.08;

      // Reset the pose, then let the status override it.
      let bob = Math.sin(t * 1.1) * 0.012;
      let lean = 0;
      let headPitch = 0;
      let headYaw = Math.sin(t * 0.6) * 0.06;
      let rightArm = -0.12 + Math.sin(t * 0.9) * 0.05;
      let leftArm = -0.12 + Math.sin(t * 0.9 + 1.4) * 0.05;
      let armSpread = 0.05;

      switch (status) {
        case 'thinking':
          bob = Math.sin(t * 1.6) * 0.02;
          headPitch = -0.16;
          headYaw = Math.sin(t * 0.9) * 0.16;
          rightArm = -1.15; // hand up toward the chin
          leftArm = -0.25 + Math.sin(t * 1.2) * 0.06;
          break;
        case 'working':
          bob = Math.sin(t * 2.2) * 0.008;
          lean = 0.07;
          headPitch = 0.2;
          headYaw = Math.sin(t * 1.4) * 0.03;
          rightArm = -0.62 + Math.sin(t * 11) * 0.26;
          leftArm = -0.62 + Math.sin(t * 11 + Math.PI) * 0.26;
          break;
        case 'talking':
          bob = Math.sin(t * 1.3) * 0.014;
          headYaw = Math.sin(t * 1.7) * 0.3;
          headPitch = Math.sin(t * 1.1) * 0.08;
          rightArm = -0.85 + Math.sin(t * 2.4) * 0.3;
          leftArm = -0.5 + Math.sin(t * 2.1 + 0.8) * 0.22;
          armSpread = 0.35;
          break;
        case 'blocked':
          bob = Math.sin(t * 1.2) * 0.004;
          lean = 0.04;
          headPitch = 0.1;
          headYaw = Math.sin(t * 0.5) * 0.05;
          rightArm = 0.12;
          leftArm = 0.12;
          break;
        case 'error':
          bob = 0;
          lean = -0.05;
          headPitch = -0.1;
          headYaw = 0;
          rightArm = 0.2;
          leftArm = 0.2;
          break;
        case 'offline':
          bob = 0;
          lean = 0.02;
          headPitch = 0.22;
          headYaw = 0;
          rightArm = 0.05;
          leftArm = 0.05;
          break;
        case 'idle':
        default:
          break;
      }

      body.position.y = bob;
      body.rotation.x = lean;
      head.rotation.x = headPitch;
      head.rotation.y = headYaw;
      if (armRight) {
        armRight.rotation.x = rightArm;
        armRight.rotation.z = -armSpread;
      }
      if (armLeft) {
        armLeft.rotation.x = leftArm;
        armLeft.rotation.z = armSpread;
      }
      tablet.visible = status === 'working';

      if (selected) {
        const pulse = 1 + (reducedMotion ? 0 : Math.sin(t * 3.4) * 0.07);
        halo.scale.setScalar(pulse);
        haloMaterial.opacity = 0.28 + (reducedMotion ? 0 : Math.sin(t * 3.4) * 0.14);
        ringMaterial.opacity = 0.8;
        if (!reducedMotion) ring.rotation.z += dt * 0.6;
      }
    },
    dispose() {
      if (group.parent) group.parent.remove(group);
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      labelTexture.dispose();
      labelCtx?.clearRect(0, 0, LABEL_WIDTH, LABEL_HEIGHT);
    },
  };
}
