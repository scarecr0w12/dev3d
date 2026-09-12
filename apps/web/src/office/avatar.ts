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
 * On top of that sits the liveliness layer. A body handed a `LivelinessMotion`
 * is a person who has got up: the figure rises onto its legs, walks with a
 * stride in proportion to the ground it is covering, stands about looking
 * around, turns to face whoever it is talking to, and shows one line of that
 * conversation in a bubble over its head. `mode: 'seated'` is the old behaviour
 * exactly - status decides the pose - so a working office looks as it always
 * did, and only the idle are on their feet.
 *
 * Everything created here is owned here and disposed in `dispose()`.
 */

import * as THREE from 'three';

import type { EmployeeStatus, RoleAppearance } from '@dev3d/core';

// An explicit extension, so `node apps/web/.verify/smoke.ts` can load this module
// directly and assert the pose it produces. Vite resolves either spelling.
import { STATUS_COLOR, STATUS_LABEL, STATUS_STYLE } from '../app/status.ts';
import type { LivelinessMotion } from './liveliness';

/**
 * What the office needs from anything that occupies a spot on the floor.
 *
 * Generic over the status vocabulary on purpose. An employee is driven by
 * `EmployeeStatus` - thinking, talking, on a break - and a third-party vendor by
 * `VendorStatus` - docked, engaged, unreachable. Those are genuinely different
 * words for genuinely different things, and collapsing them into one union would
 * make every `Record<EmployeeStatus, …>` table in the console silently indexable
 * with a key that means nothing.
 *
 * The interface is shared anyway, because *placement, animation, selection and
 * disposal* are identical for both: whatever `OfficeCanvas` does with a body it
 * does with a terminal. See `vendorAvatar.ts` for the other implementation.
 */
export interface Avatar<S extends string = EmployeeStatus> {
  readonly group: THREE.Group;
  readonly id: string;
  /** Current status; also redraws the name plate. */
  setStatus(status: S): void;
  getStatus(): S;
  setSelected(selected: boolean): void;
  /** Sets the yaw the avatar turns to face (radians, +Z forward). */
  setFacing(yaw: number): void;
  /**
   * @param motion where the liveliness layer wants this body, or null to leave
   *   it at its desk with the status pose. A vendor ignores it - see below.
   */
  update(dt: number, elapsed: number, reducedMotion: boolean, motion?: LivelinessMotion | null): void;
  dispose(): void;
}

const GREY = new THREE.Color('#5b6472');
const LABEL_WIDTH = 320;
const LABEL_HEIGHT = 80;
const BUBBLE_WIDTH = 448;
const BUBBLE_HEIGHT = 112;
/** How far the whole figure rises when it stands up, in metres. */
const STANCE = 0.44;
/** Ground covered by one leg cycle, which sets the cadence of the walk. */
const STRIDE = 0.78;

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
  // Named because the pose this produces is asserted in the verification harness:
  // the layer is otherwise only checkable by looking at a screenshot, and "the
  // figure rose onto its legs" is arithmetic rather than taste.
  body.name = 'Body';
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
  /** The folded legs of somebody at a desk; hidden the moment they stand. */
  const seatedLegs = addMesh(body, new THREE.BoxGeometry(0.30, 0.30, 0.20), darkMat, 0, 0.17, 0);
  seatedLegs.name = 'SeatedLegs';
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

  // -------------------------------------------------------------------- legs
  //
  // Only a walked body has them. The figure is otherwise compressed into a
  // chair, so standing up is the whole torso rising onto a pair of legs long
  // enough to reach the floor from the raised hip - which is why the leg length
  // is derived from STANCE rather than guessed at.
  const legs: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const hip = new THREE.Group();
    hip.name = side < 0 ? 'LegL' : 'LegR';
    hip.position.set(side * 0.09, 0.32, 0);
    body.add(hip);
    addMesh(hip, new THREE.BoxGeometry(0.105, 0.72, 0.13), darkMat, 0, -0.40, 0);
    addMesh(hip, new THREE.BoxGeometry(0.11, 0.06, 0.20), darkMat, 0, -0.73, 0.04); // foot
    hip.visible = false;
    legs.push(hip);
  }
  const legRight = legs[1] ?? null;
  const legLeft = legs[0] ?? null;

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
  label.name = 'Label';
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

  // ------------------------------------------------------------ speech bubble
  //
  // The strongest signal that two figures are talking to each other rather than
  // merely standing near each other. One line at a time, shrunk to fit rather
  // than wrapped, because two lines of text over somebody fifteen metres away is
  // four pixels of nothing.
  const bubbleCanvas = document.createElement('canvas');
  bubbleCanvas.width = BUBBLE_WIDTH;
  bubbleCanvas.height = BUBBLE_HEIGHT;
  const bubbleCtx = bubbleCanvas.getContext('2d');
  const bubbleTexture = new THREE.CanvasTexture(bubbleCanvas);
  bubbleTexture.colorSpace = THREE.SRGBColorSpace;
  const bubbleMaterial = new THREE.SpriteMaterial({
    map: bubbleTexture,
    transparent: true,
    depthWrite: false,
    opacity: 0,
  });
  materials.push(bubbleMaterial);
  const bubbleSprite = new THREE.Sprite(bubbleMaterial);
  bubbleSprite.name = 'Bubble';
  bubbleSprite.scale.set(2.16, 0.54, 1);
  bubbleSprite.position.set(0, 1.84, 0);
  bubbleSprite.renderOrder = 6;
  bubbleSprite.visible = false;
  group.add(bubbleSprite);

  let drawnBubble = '';

  const drawBubble = (text: string): void => {
    if (!bubbleCtx) return;
    const ctx = bubbleCtx;
    ctx.clearRect(0, 0, BUBBLE_WIDTH, BUBBLE_HEIGHT);

    // The box stops short of the bottom of the canvas to leave room for the tail.
    const boxHeight = BUBBLE_HEIGHT - 26;
    roundRectPath(ctx, 2, 2, BUBBLE_WIDTH - 4, boxHeight - 4, 18);
    ctx.fillStyle = 'rgba(9, 11, 16, 0.88)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(BUBBLE_WIDTH / 2 - 14, boxHeight - 2);
    ctx.lineTo(BUBBLE_WIDTH / 2 + 14, boxHeight - 2);
    ctx.lineTo(BUBBLE_WIDTH / 2, BUBBLE_HEIGHT - 2);
    ctx.closePath();
    ctx.fillStyle = 'rgba(9, 11, 16, 0.88)';
    ctx.fill();

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#eef2f9';
    let size = 30;
    const font = (px: number): string => `600 ${px}px ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif`;
    ctx.font = font(size);
    // Shrink rather than clip or wrap: a line is short by construction, but a
    // name that made one 40 characters long must not overflow the box.
    let width = ctx.measureText(text).width;
    while (width > BUBBLE_WIDTH - 44 && size > 18) {
      size -= 2;
      ctx.font = font(size);
      width = ctx.measureText(text).width;
    }
    ctx.fillText(text, BUBBLE_WIDTH / 2, boxHeight / 2 + 1);
    bubbleTexture.needsUpdate = true;
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
  /** 0 at a desk, 1 on both feet: eased, so standing up is a movement. */
  let stance = 0;
  /** Where the legs are in the walk cycle. */
  let gait = 0;
  let bubbleAlpha = 0;
  let bubbleTarget = 0;

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
    update(dt, elapsed, reducedMotion, motion) {
      const t = reducedMotion ? 0 : elapsed;
      const style = STATUS_STYLE[status];
      const mode = motion?.mode ?? 'seated';
      const speed = motion ? Math.max(0, motion.speed) : 0;
      /** A stable per-person offset, so a crowd is never in step. */
      const phase = motion?.phase ?? 0;

      // A body the director knows about is placed by the director, every frame
      // and in every mode - including `seated`. Placing only the ones on their
      // feet looks right until a body sits down somewhere the floor plan did not
      // put it: an employee sent to the meeting room, or everybody seated at
      // once because liveliness was switched off, would keep standing at the old
      // desk while the office believed otherwise. The canvas only places a body
      // the director has never heard of.
      if (motion) group.position.set(motion.x, motion.y, motion.z);

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
      let stanceTarget = 0;
      let swing = 0;

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

      // ------------------------------------------------------- the walk itself
      //
      // Cadence comes from the ground being covered rather than from the clock,
      // so a fast walker's legs move faster and a slow one does not moonwalk.
      if (mode !== 'seated') {
        stanceTarget = 1;
        if (mode === 'walking') {
          const cadence = (Math.max(speed, 0.2) / STRIDE) * Math.PI;
          if (!reducedMotion) gait += dt * cadence;
          const energy = clamp(speed / 1.2, 0.35, 1.6);
          swing = Math.sin(gait + phase) * 0.62 * energy;
          bob = Math.abs(Math.sin(gait + phase)) * 0.028 * energy;
          lean = 0.06;
          headPitch = 0.04;
          headYaw = 0;
          // Arms counter-swing, which is what reads as walking at a distance.
          rightArm = -0.05 - Math.sin(gait + phase) * 0.42 * energy;
          leftArm = -0.05 + Math.sin(gait + phase) * 0.42 * energy;
          armSpread = 0.08;
        } else if (mode === 'standing') {
          bob = Math.sin(t * 0.9 + phase) * 0.008;
          headYaw = Math.sin(t * 0.5 + phase) * 0.14;
          rightArm = -0.06 + Math.sin(t * 0.8 + phase) * 0.05;
          leftArm = -0.06 + Math.sin(t * 0.75 + phase * 1.3) * 0.05;
          armSpread = 0.07;
        } else {
          // Talking: one hand doing most of it, head moving with the sentence.
          bob = Math.sin(t * 1.2 + phase) * 0.012;
          headYaw = Math.sin(t * 1.6 + phase) * 0.11;
          headPitch = Math.sin(t * 1.3) * 0.05;
          rightArm = -0.55 + Math.sin(t * 3.1 + phase) * 0.24;
          leftArm = -0.16 + Math.sin(t * 1.7 + phase) * 0.08;
          armSpread = 0.22;
        }
      }

      // Standing up and sitting down are movements, not switches.
      const stanceStep = reducedMotion ? 1 : 1 - Math.exp(-6 * dt);
      stance += (stanceTarget - stance) * stanceStep;
      const lifted = stance * STANCE;

      body.position.y = bob + lifted;
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
      if (legRight) legRight.rotation.x = -swing;
      if (legLeft) legLeft.rotation.x = swing;

      const onFeet = stance > 0.04;
      seatedLegs.visible = !onFeet;
      if (legRight) legRight.visible = onFeet;
      if (legLeft) legLeft.visible = onFeet;

      // A body only holds a tablet while it is actually sitting at its desk: an
      // employee called back to work mid-stroll walks home first.
      tablet.visible = status === 'working' && mode === 'seated';

      // The plate rides up with the body, or a standing person's name would be
      // written across their face.
      label.position.y = 1.32 + lifted * 0.95;
      bubbleSprite.position.y = label.position.y + 0.52;

      // --------------------------------------------------------- speech bubble
      const text = motion?.bubble ?? null;
      if (text !== null) {
        if (text !== drawnBubble) {
          drawBubble(text);
          drawnBubble = text;
        }
        bubbleTarget = 1;
      } else {
        bubbleTarget = 0;
      }
      const fade = reducedMotion ? 1 : 1 - Math.exp(-(bubbleTarget > bubbleAlpha ? 9 : 4) * dt);
      bubbleAlpha += (bubbleTarget - bubbleAlpha) * fade;
      bubbleMaterial.opacity = bubbleAlpha;
      bubbleSprite.visible = bubbleAlpha > 0.02;

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
      bubbleTexture.dispose();
      labelCtx?.clearRect(0, 0, LABEL_WIDTH, LABEL_HEIGHT);
      bubbleCtx?.clearRect(0, 0, BUBBLE_WIDTH, BUBBLE_HEIGHT);
    },
  };
}
