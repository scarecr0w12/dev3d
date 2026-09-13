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
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

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
/**
 * Hip height off the floor when seated, which is the height of a chair's seat.
 *
 * Taken from the furniture rather than picked: `03_office_furniture.py` puts the
 * seat pad's top surface at 0.507 m. A figure whose hips sit below that is a figure
 * sitting *inside* its chair, which is what this was — the hips were at 0.32 m, so
 * every seated employee was 18 cm sunk into the seat.
 */
const HIP_Y = 0.5;
/** Where the shoulders are, and so where the arms hang from. */
const SHOULDER_Y = 0.94;
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

/**
 * Trace a rounded rectangle into the current 2D path.
 *
 * Exported because the vendor terminals draw the same plate, and they had their
 * own copy with two corners wrong: the top-right `arcTo` aimed at a diagonal
 * control point instead of the one directly below the corner, and the bottom-right
 * passed the *same* point twice — which `arcTo` treats as a degenerate call and
 * draws a straight line, so that corner was not rounded at all. One implementation
 * is the only way two call sites cannot disagree about where a corner is.
 */
export function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
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

/**
 * One employee's figure, cut from the loaded `avatar.glb`.
 *
 * The clone shares geometry and images with the template - which is what makes a
 * dozen employees cost one model's worth of memory - so only the *materials* are
 * per avatar, and they are swapped once per distinct material rather than once per
 * mesh. A name the model carries that this build has never heard of keeps what it
 * came with, so adding a surface to `06_avatar.py` is never a crash here.
 */
function avatarFromTemplate(
  template: THREE.Object3D,
  materials: Record<string, THREE.Material>,
  id: string,
): THREE.Object3D {
  const source = template.getObjectByName('Body') ?? template;
  const clone = source.clone(true);
  const seen = new Map<THREE.Material, THREE.Material>();
  clone.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.userData.avatarId = id;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    const swap = (current: THREE.Material): THREE.Material => {
      let replacement = seen.get(current);
      if (replacement === undefined) {
        replacement = materials[current.name] ?? current;
        seen.set(current, replacement);
      }
      return replacement;
    };
    if (Array.isArray(mesh.material)) mesh.material = mesh.material.map(swap);
    else if (mesh.material) mesh.material = swap(mesh.material);
  });
  return clone;
}

export function createAvatar(
  id: string,
  displayName: string,
  appearance: RoleAppearance,
  /**
   * The loaded `avatar.glb`, if the canvas has one.
   *
   * Optional on purpose: the procedural figure is the fallback, so a missing or
   * failed asset is a plainer office rather than no office, and the verification
   * harness exercises the fallback without needing a filesystem.
   */
  template?: THREE.Object3D | null,
): Avatar {
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
  const hairMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#2b2f38'), roughness: 0.85 });
  materials.push(bodyMat, headMat, accentMat, lampMat, darkMat, screenMat, hairMat);

  /**
   * The avatar's surfaces, keyed by the names `06_avatar.py` gives them.
   *
   * A GLB's materials are shared by every clone - three.js hands one instance to
   * every mesh that used it - so a figure built from the model has its materials
   * swapped for this avatar's own, exactly as a floor swaps a wall's. The name is
   * the only thing that survives the export, so the name is the interface.
   */
  const materialByName: Record<string, THREE.Material> = {
    A_Body: bodyMat,
    A_Head: headMat,
    A_Accent: accentMat,
    A_Dark: darkMat,
    A_Hair: hairMat,
    A_Lamp: lampMat,
    A_Screen: screenMat,
  };

  const addMesh = (
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
    rot?: [number, number, number],
  ): THREE.Mesh => {
    geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    if (rot) mesh.rotation.set(rot[0], rot[1], rot[2]);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.userData.avatarId = id;
    parent.add(mesh);
    return mesh;
  };

  /**
   * A bevelled box, which is the whole of this figure's shape language.
   *
   * It is the same trick the office furniture is built on: a razor-sharp 90 degree
   * corner has no surface for a highlight to land on, so an unbevelled box reads as
   * cardboard however it is lit. Two centimetres of radius is enough, and it is
   * what turns a stack of bricks into a person. The radius is clamped to a third of
   * the smallest side, or a thin part would be rounded into a lozenge.
   */
  const rounded = (w: number, h: number, d: number, radius = 0.022): THREE.BufferGeometry =>
    new RoundedBoxGeometry(w, h, d, 2, Math.min(radius, Math.min(w, h, d) / 3));

  /** A limb: a capsule, so it has no corners at all, which is what a limb is. */
  const limb = (radius: number, total: number): THREE.BufferGeometry =>
    new THREE.CapsuleGeometry(radius, Math.max(0.01, total - radius * 2), 4, 12);

  // ------------------------------------------------------------------- torso
  //
  // Everything here is measured from HIP_Y, and the standing leg is exactly
  // `HIP_Y + STANCE` long so that a raised body's soles land on the floor. Both
  // used to be guessed at, which is how the hips ended up under the seat.
  /** The folded legs of somebody at a desk; hidden the moment they stand. */
  let seatedLegs: THREE.Object3D | null = new THREE.Group();
  seatedLegs.name = 'SeatedLegs';
  body.add(seatedLegs);
  for (const side of [-1, 1]) {
    addMesh(seatedLegs, rounded(0.125, 0.125, 0.34), darkMat, side * 0.10, HIP_Y + 0.035, 0.16); // thigh
    addMesh(seatedLegs, limb(0.05, 0.40), darkMat, side * 0.10, HIP_Y - 0.23, 0.31); // shin
    addMesh(seatedLegs, rounded(0.115, 0.055, 0.20), darkMat, side * 0.10, 0.033, 0.36); // foot
  }
  addMesh(body, rounded(0.29, 0.19, 0.21), bodyMat, 0, HIP_Y + 0.055, 0); // pelvis
  addMesh(body, rounded(0.305, 0.05, 0.225), accentMat, 0, HIP_Y + 0.155, 0); // belt
  addMesh(body, rounded(0.335, 0.32, 0.215), bodyMat, 0, HIP_Y + 0.33, 0); // torso
  addMesh(body, rounded(0.42, 0.105, 0.21), accentMat, 0, SHOULDER_Y - 0.005, 0); // shoulders
  addMesh(body, limb(0.048, 0.11), headMat, 0, SHOULDER_Y + 0.065, 0); // neck

  // -------------------------------------------------------------------- head
  //
  // A sphere for the skull with a clipped second sphere over the top as hair. The
  // hair is a `thetaLength` rather than a full ball, or it would cover the face.
  const head = addMesh(body, new THREE.SphereGeometry(0.125, 20, 16), headMat, 0, 1.16, 0);
  head.scale.set(1, 1.08, 1.02);
  addMesh(body, new THREE.SphereGeometry(0.132, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.54),
    hairMat, 0, 1.168, -0.004);
  addMesh(body, rounded(0.205, 0.026, 0.03), accentMat, 0, 1.196, 0.10); // headset band
  addMesh(body, rounded(0.028, 0.075, 0.03), accentMat, 0.136, 1.16, 0.005); // ear cup R
  addMesh(body, rounded(0.028, 0.075, 0.03), accentMat, -0.136, 1.16, 0.005); // ear cup L
  addMesh(body, rounded(0.016, 0.10, 0.016), accentMat, 0.118, 1.115, 0.05, [0.5, 0, 0]); // mic boom
  addMesh(body, rounded(0.085, 0.026, 0.018), lampMat, 0, 0.90, 0.112); // chest status lamp

  // -------------------------------------------------------------------- legs
  //
  // Only a walked body has them. The figure is otherwise compressed into a chair,
  // so standing up is the whole torso rising onto a pair of legs long enough to
  // reach the floor from the raised hip - which is why the leg length is derived
  // from HIP_Y and STANCE rather than guessed at.
  const legs: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const hip = new THREE.Group();
    hip.name = side < 0 ? 'LegL' : 'LegR';
    hip.position.set(side * 0.098, HIP_Y, 0);
    body.add(hip);
    addMesh(hip, limb(0.058, 0.47), darkMat, 0, -0.235, 0); // thigh
    addMesh(hip, limb(0.05, 0.44), darkMat, 0, -0.69, 0); // shin
    // The sole has to land exactly `HIP_Y + STANCE` below the hip, or a raised
    // figure floats or sinks.
    addMesh(hip, rounded(0.115, 0.055, 0.205), darkMat, 0, -(HIP_Y + STANCE) + 0.0275, 0.035); // shoe
    hip.visible = false;
    legs.push(hip);
  }
  let legRight: THREE.Object3D | null = legs[1] ?? null;
  let legLeft: THREE.Object3D | null = legs[0] ?? null;

  // -------------------------------------------------------------------- arms
  const arms: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.238, SHOULDER_Y, 0);
    body.add(pivot);
    addMesh(pivot, limb(0.05, 0.46), bodyMat, 0, -0.245, 0);
    addMesh(pivot, rounded(0.075, 0.085, 0.085), accentMat, 0, -0.525, 0.01); // hand
    arms.push(pivot);
  }
  let armRight: THREE.Object3D | null = arms[1] ?? null;
  let armLeft: THREE.Object3D | null = arms[0] ?? null;

  // ------------------------------------------------------- tablet for 'working'
  const tabletGroup = new THREE.Group();
  tabletGroup.position.set(0, 0.80, 0.235);
  tabletGroup.visible = false;
  body.add(tabletGroup);
  addMesh(tabletGroup, rounded(0.30, 0.014, 0.18, 0.006), darkMat, 0, 0, 0);
  const screen = addMesh(tabletGroup, rounded(0.28, 0.17, 0.012, 0.006), screenMat, 0, 0.085, -0.075);
  screen.rotation.x = -0.38;
  let tablet: THREE.Object3D | null = tabletGroup;

  /**
   * The asset supersedes the primitives, when the canvas has one.
   *
   * The figure is built first and then swapped out rather than skipped, because
   * the pose contract below is resolved by *name* and one path that resolves those
   * names is worth more than the twenty small geometries this throws away - they
   * are shared shapes, and they are disposed with the avatar either way. What
   * matters is that `Body`, `LegL`/`LegR`, `SeatedLegs`, `ArmL`/`ArmR` and
   * `Tablet` mean the same thing whichever figure is standing there.
   */
  if (template) {
    body.clear();
    body.add(avatarFromTemplate(template, materialByName, id));
    seatedLegs = body.getObjectByName('SeatedLegs') ?? null;
    legRight = body.getObjectByName('LegR') ?? null;
    legLeft = body.getObjectByName('LegL') ?? null;
    armRight = body.getObjectByName('ArmR') ?? null;
    armLeft = body.getObjectByName('ArmL') ?? null;
    tablet = body.getObjectByName('Tablet') ?? null;
  }

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

      /**
       * Which way the body faces.
       *
       * The director produces a `yaw` for every motion it drives — the direction
       * of travel, the angle of a body standing about, and the turn towards a
       * conversation partner — and nothing read it. `facingYaw` is set by
       * `setFacing`, which `OfficeCanvas` only calls for employees the director
       * does *not* know about, so after the first `applyLiveliness()` every body
       * kept its seat's yaw for the whole session: walkers strafed sideways and
       * two people in conversation never turned to face each other, which is the
       * opposite of what the liveliness module promises.
       *
       * `facingYaw` remains the fallback for the director-less case.
       */
      const targetYaw = motion && Number.isFinite(motion.yaw) ? motion.yaw : facingYaw;

      // Turn toward the target smoothly; snap when motion is reduced.
      const delta = angleDelta(group.rotation.y, targetYaw);
      group.rotation.y = reducedMotion ? targetYaw : group.rotation.y + delta * (1 - Math.exp(-9 * dt));

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
      seatedLegs && (seatedLegs.visible = !onFeet);
      if (legRight) legRight.visible = onFeet;
      if (legLeft) legLeft.visible = onFeet;

      // A body only holds a tablet while it is actually sitting at its desk: an
      // employee called back to work mid-stroll walks home first.
      if (tablet) tablet.visible = status === 'working' && mode === 'seated';

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
