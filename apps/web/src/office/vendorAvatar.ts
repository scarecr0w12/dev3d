/**
 * Third-party vendor terminals.
 *
 * A vendor is drawn as a **rented workstation**, not a person: a plinth, a
 * screen, a beacon, and a cable to the floor. That is a deliberate choice about
 * what the office means, not a shortcut.
 *
 * `Role`s are staff. They have a desk, a department, a manager, a model policy
 * and a lifetime of usage, and the office's whole visual language - a humanoid
 * that thinks, types, argues and walks to the meeting room - exists to make those
 * seven statuses legible at a glance across a 22 x 16 m floor. An external
 * harness has none of that. It is a process somebody else operates, which the
 * office switches on, hands a job to, and switches off. Dressing Codex as an
 * employee would be the same category error as calling an MCP server a
 * colleague - and it would make "there is a person at that desk" stop meaning
 * anything.
 *
 * So a vendor gets its own silhouette, its own motion vocabulary, and its own
 * place on the floor. What it *shares* with an employee is everything the office
 * needs in order to treat it as an occupant at all: `Avatar` - so it is placed,
 * animated, picked, focused and disposed by exactly the same code.
 *
 * ## Reading it at a distance
 *
 * The screen is the vendor's face, and it carries the vendor's own colour - the
 * one thing that tells four identical-looking terminals apart. Around it:
 *
 *  - a **beacon** on the plinth, coloured by status, which is the same signal an
 *    employee's chest lamp gives;
 *  - a **standby breath** when docked: the screen is lit but dim and slowly
 *    pulsing, so an available vendor is visible without competing for attention;
 *  - a **work scroll** when engaged: the screen brightens and its scanlines run
 *    fast, which reads as "this machine is busy" from across the room;
 *  - **darkness** when off site or unreachable, because a vendor that is not
 *    there should not look like one that is.
 *
 * Nothing here walks, talks, or has a face. Under `prefers-reduced-motion` the
 * breath and the scroll stop and every state is carried by colour alone, which is
 * how the rest of the office degrades too.
 */

import * as THREE from 'three';

import type { VendorStatus } from '@dev3d/core';

import type { Avatar } from './avatar.ts';
import { roundRectPath } from './avatar.ts';
import { VENDOR_STATUS_COLOR, VENDOR_STATUS_LABEL, VENDOR_STATUS_STYLE } from '../app/status.ts';

/** The screen's canvas, in pixels. Roughly the panel's own aspect. */
const SCREEN_WIDTH = 512;
const SCREEN_HEIGHT = 320;

/**
 * The palette a vendor with no declared colour gets.
 *
 * Deterministic by index, so the same vendor keeps the same colour across
 * reloads and two vendors never share one - which is the entire job, since the
 * screen is what distinguishes four otherwise identical terminals.
 */
const VENDOR_PALETTE = ['#38bdf8', '#f0abfc', '#a3e635', '#fbbf24', '#fb923c', '#22d3ee', '#c084fc', '#4ade80'];

export function defaultVendorColor(index: number): string {
  const safe = ((index % VENDOR_PALETTE.length) + VENDOR_PALETTE.length) % VENDOR_PALETTE.length;
  return VENDOR_PALETTE[safe] ?? '#38bdf8';
}

/*
 * A local `roundRectPath` used to sit here, copied from the employee avatar's and
 * subtly wrong: its top-right corner aimed at a diagonal control point, and its
 * bottom-right passed the same point twice — a degenerate `arcTo`, which draws a
 * straight line, so that corner was square while the other three were round. The
 * plate is small and the difference reads as "slightly off" rather than as a bug,
 * which is exactly why nobody reported it. The shared one is imported instead.
 */

export interface VendorAvatarOptions {
  /** The vendor's own colour, or one derived from its position in the bay. */
  color: string;
  /** Who operates it - shown on the screen, because "whose machine" matters. */
  operator: string;
  /** Life-time delegations, drawn on the screen so the terminal carries a record. */
  engagements: number;
}

/**
 * Build one vendor terminal.
 *
 * Satisfies `Avatar<VendorStatus>` exactly, so `OfficeCanvas` needs no special
 * case beyond choosing this factory.
 */
export function createVendorAvatar(
  id: string,
  displayName: string,
  options: VendorAvatarOptions,
): Avatar<VendorStatus> {
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const accent = new THREE.Color(options.color || '#38bdf8');

  const group = new THREE.Group();
  group.name = `Vendor_${id}`;
  // The same key the employee avatars stamp, because this is the *only* thing
  // picking reads: a distinct visual that skipped it would be unselectable.
  group.userData.avatarId = id;

  const body = new THREE.Group();
  group.add(body);

  const plinthMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#252a33'), roughness: 0.62, metalness: 0.34 });
  const trimMat = new THREE.MeshStandardMaterial({ color: accent.clone().lerp(new THREE.Color('#0b0e14'), 0.55), roughness: 0.4, metalness: 0.5 });
  const casingMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#161a21'), roughness: 0.5, metalness: 0.45 });
  const beaconMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#101318'),
    emissive: new THREE.Color(VENDOR_STATUS_COLOR.docked),
    emissiveIntensity: 0.2,
    roughness: 0.3,
    metalness: 0.1,
  });
  const screenMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#05070b'),
    emissive: new THREE.Color('#ffffff'),
    // The map carries the drawn panel; the emissive tint is what makes it glow
    // like a screen rather than look like a printed label.
    emissiveMap: null,
    emissiveIntensity: 0.6,
    roughness: 0.35,
    metalness: 0.05,
  });
  materials.push(plinthMat, trimMat, casingMat, beaconMat, screenMat);

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
    // Stamped on every mesh as well as the group, so the parent walk in `pickAt`
    // finds it from any hit.
    mesh.userData.avatarId = id;
    parent.add(mesh);
    return mesh;
  };

  // ------------------------------------------------------------------- plinth
  addMesh(body, new THREE.BoxGeometry(0.46, 0.60, 0.30), plinthMat, 0, 0.30, 0); // column
  addMesh(body, new THREE.BoxGeometry(0.56, 0.05, 0.40), trimMat, 0, 0.025, 0); // base plate
  addMesh(body, new THREE.BoxGeometry(0.50, 0.04, 0.36), trimMat, 0, 0.615, 0); // deck
  // A cable to the floor: the one detail that says "plugged in" rather than
  // "standing here", and the cheapest possible way to say it.
  const cable = addMesh(body, new THREE.BoxGeometry(0.035, 0.30, 0.035), casingMat, -0.17, 0.15, -0.13);
  cable.rotation.z = 0.28;

  // ------------------------------------------------------------------- screen
  /** Tilts back a little, so the panel faces someone approaching it. */
  const screenPivot = new THREE.Group();
  screenPivot.position.set(0, 0.66, 0);
  screenPivot.rotation.x = -0.14;
  body.add(screenPivot);
  addMesh(screenPivot, new THREE.BoxGeometry(0.62, 0.42, 0.045), casingMat, 0, 0.21, 0); // bezel

  const screenCanvas = document.createElement('canvas');
  screenCanvas.width = SCREEN_WIDTH;
  screenCanvas.height = SCREEN_HEIGHT;
  const screenCtx = screenCanvas.getContext('2d');
  const screenTexture = new THREE.CanvasTexture(screenCanvas);
  screenTexture.colorSpace = THREE.SRGBColorSpace;
  // Repeat vertically so the scanline layer can scroll by moving the offset,
  // which costs nothing per frame instead of redrawing the canvas.
  screenTexture.wrapS = THREE.RepeatWrapping;
  screenTexture.wrapT = THREE.RepeatWrapping;
  screenMat.map = screenTexture;
  screenMat.emissiveMap = screenTexture;
  screenMat.needsUpdate = true;

  const panel = addMesh(screenPivot, new THREE.BoxGeometry(0.56, 0.36, 0.012), screenMat, 0, 0.21, 0.028);
  panel.receiveShadow = false;

  // ------------------------------------------------------------------ beacon
  const beacon = addMesh(body, new THREE.BoxGeometry(0.09, 0.05, 0.09), beaconMat, 0.19, 0.655, 0.11);

  // ---------------------------------------------------------------- name plate
  const LABEL_WIDTH = 320;
  const LABEL_HEIGHT = 80;
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
  label.position.set(0, 1.30, 0);
  label.renderOrder = 5;
  group.add(label);

  const drawLabel = (status: VendorStatus): void => {
    if (!labelCtx) return;
    const ctx = labelCtx;
    ctx.clearRect(0, 0, LABEL_WIDTH, LABEL_HEIGHT);
    roundRectPath(ctx, 2, 8, LABEL_WIDTH - 4, LABEL_HEIGHT - 16, 14);
    // A squarer, cooler plate than an employee's, so the two read differently
    // even before the silhouette does.
    ctx.fillStyle = 'rgba(7, 9, 14, 0.82)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(${Math.round(accent.r * 255)}, ${Math.round(accent.g * 255)}, ${Math.round(accent.b * 255)}, 0.55)`;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(30, 32, 8, 0, Math.PI * 2);
    ctx.fillStyle = VENDOR_STATUS_COLOR[status];
    ctx.fill();

    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e9edf5';
    ctx.font = '600 30px ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif';
    const shown = displayName.length > 15 ? `${displayName.slice(0, 14)}…` : displayName;
    ctx.fillText(shown, 50, 30);

    ctx.fillStyle = 'rgba(190, 200, 216, 0.86)';
    ctx.font = '400 19px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillText(VENDOR_STATUS_LABEL[status], 50, 57);
    labelTexture.needsUpdate = true;
  };

  /**
   * Draw the terminal's screen.
   *
   * Redrawn on a status change rather than per frame: the live parts - the
   * scroll and the glow - are done by moving the texture offset and easing the
   * emissive, both of which are free. A canvas redraw and a texture upload every
   * frame, per vendor, would be the most expensive thing in the scene for a
   * panel nobody is reading at 60 Hz.
   */
  const drawScreen = (status: VendorStatus): void => {
    if (!screenCtx) return;
    const ctx = screenCtx;
    const color = VENDOR_STATUS_COLOR[status];
    const live = status === 'engaged' || status === 'docked';

    ctx.clearRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
    ctx.fillStyle = '#05070b';
    ctx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
    if (!live) {
      // Off site or unreachable: the panel is dark and says so once, quietly.
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(148, 163, 184, 0.55)';
      ctx.font = '400 30px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.fillText(status === 'offsite' ? 'OFF SITE' : 'NO SIGNAL', SCREEN_WIDTH / 2, SCREEN_HEIGHT / 2);
      ctx.textAlign = 'left';
      screenTexture.needsUpdate = true;
      return;
    }

    // A header band in the vendor's own colour: the one thing that tells four
    // otherwise identical terminals apart.
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.22;
    ctx.fillRect(0, 0, SCREEN_WIDTH, 74);
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.fillRect(0, 72, SCREEN_WIDTH, 3);

    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f1f5f9';
    ctx.font = '600 38px ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif';
    const title = displayName.length > 14 ? `${displayName.slice(0, 13)}…` : displayName;
    ctx.fillText(title, 24, 38);

    ctx.font = '400 21px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillStyle = 'rgba(203, 213, 225, 0.82)';
    const operator = options.operator.length > 22 ? `${options.operator.slice(0, 21)}…` : options.operator;
    ctx.fillText(operator, 24, 100);

    ctx.fillText(`engagements  ${options.engagements}`, 24, 132);
    ctx.fillText(status === 'engaged' ? 'status       WORKING' : 'status       STANDBY', 24, 164);

    // A rule of blocks: lit while engaged, hollow on standby. Cheap to draw and
    // it turns the panel into something with a rhythm rather than a list.
    const blocks = 12;
    const blockWidth = (SCREEN_WIDTH - 48) / blocks;
    for (let i = 0; i < blocks; i += 1) {
      const filled = status === 'engaged' ? i < blocks : i < 3;
      ctx.fillStyle = filled ? color : 'rgba(148, 163, 184, 0.22)';
      ctx.globalAlpha = filled ? 0.85 : 1;
      ctx.fillRect(24 + i * blockWidth, 200, blockWidth - 6, 18);
    }
    ctx.globalAlpha = 1;

    // Scanlines. Below the informational area, and translucent, so they read as
    // a screen rather than as content.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    for (let y = 236; y < SCREEN_HEIGHT; y += 8) {
      ctx.fillRect(0, y, SCREEN_WIDTH, 2);
    }

    screenTexture.needsUpdate = true;
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
  let status: VendorStatus = 'offsite';
  let selected = false;
  let facingYaw = 0;
  const targetEmissive = new THREE.Color(VENDOR_STATUS_STYLE.offsite.color);
  let targetIntensity = VENDOR_STATUS_STYLE.offsite.intensity;
  const currentEmissive = new THREE.Color(VENDOR_STATUS_STYLE.offsite.color);
  let currentIntensity = VENDOR_STATUS_STYLE.offsite.intensity;

  const applyStatus = (next: VendorStatus): void => {
    const style = VENDOR_STATUS_STYLE[next];
    targetEmissive.set(style.color);
    targetIntensity = style.intensity;
    beaconMat.emissive.set(style.color);
    // The screen is tinted by the *vendor's* colour while it is live, because
    // that is what distinguishes terminals; a dead one goes to its status colour
    // so the reason is visible.
    if (next === 'engaged' || next === 'docked') screenMat.emissive.copy(accent);
    else screenMat.emissive.copy(targetEmissive);
  };

  drawLabel(status);
  drawScreen(status);
  applyStatus(status);

  return {
    group,
    id,
    getStatus: () => status,
    setStatus(next) {
      if (next === status) return;
      status = next;
      applyStatus(next);
      drawLabel(next);
      drawScreen(next);
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
    /**
     * `motion` is accepted and ignored.
     *
     * A terminal is bolted down: it does not walk to the meeting room, does not
     * chat, and is never handed a `LivelinessMotion` because it is deliberately
     * not in the liveliness roster. The parameter exists because the interface is
     * shared, and dropping it would mean `OfficeCanvas` needed two update paths.
     */
    update(dt, elapsed, reducedMotion) {
      const t = reducedMotion ? 0 : elapsed;
      const style = VENDOR_STATUS_STYLE[status];
      const live = status === 'docked' || status === 'engaged';

      // Ease the glow between statuses rather than snapping, exactly as an
      // employee's chest lamp does.
      const k = 1 - Math.exp(-7 * dt);
      currentEmissive.lerp(targetEmissive, k);
      currentIntensity += (targetIntensity - currentIntensity) * k;

      // Standby breathes slowly; working pulses faster and brighter. This is the
      // whole "dim until engaged" behaviour the bay is meant to show.
      const breath = reducedMotion
        ? 0
        : status === 'engaged'
          ? Math.sin(t * 3.1) * 0.16
          : status === 'docked'
            ? Math.sin(t * 0.9) * 0.07
            : status === 'unreachable'
              ? Math.sin(t * 1.6) * 0.05
              : 0;

      screenMat.emissive.copy(live ? accent : currentEmissive);
      screenMat.emissiveIntensity = Math.max(0, currentIntensity + breath);
      beaconMat.emissiveIntensity = Math.max(0, currentIntensity * 0.9 + breath);

      // The scanline scroll. Fast while working, barely moving on standby, and
      // frozen when the panel is off or motion is reduced.
      if (!reducedMotion && live) {
        screenTexture.offset.y = (screenTexture.offset.y - dt * (status === 'engaged' ? 0.35 : 0.06)) % 1;
      }

      // A working terminal vibrates very slightly. Not enough to notice as
      // movement, enough that it does not read as a photograph.
      body.position.y = !reducedMotion && status === 'engaged' ? Math.sin(t * 22) * 0.0035 : 0;

      const delta = ((facingYaw - group.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      group.rotation.y = reducedMotion ? facingYaw : group.rotation.y + delta * (1 - Math.exp(-9 * dt));

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
      screenTexture.dispose();
      labelTexture.dispose();
      screenCtx?.clearRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
      labelCtx?.clearRect(0, 0, LABEL_WIDTH, LABEL_HEIGHT);
    },
  };
}
