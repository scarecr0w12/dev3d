/**
 * Dressing a floor.
 *
 * The block kit decides the *shape* of a floor; this decides what it is made of.
 * It takes a floor's `OfficeStyle`, a role-keyed description of every surface,
 * and produces a material set that can be applied to a clone of the office.
 *
 * Three things here are worth knowing before changing them:
 *
 *  - **Materials are keyed by role, and the mapping is total.** The kit and the
 *    core office were authored years apart and share no material names -
 *    `W_Wall` against `M_Wall_Paint` - but they share *surfaces*. Every material
 *    in both GLBs is listed in `ROLE_BY_MATERIAL`, and a check asserts that
 *    against the assets so a new material cannot slip through unstyled and ship
 *    as an unthemed grey box.
 *
 *  - **Materials are cloned per floor, not mutated in place.** One floor's
 *    "Nordic" must not repaint another floor's "Noir", and the GLB's own
 *    materials are shared by every clone. A floor owns its material set and
 *    releases it when it closes.
 *
 *  - **Patterns are generated, not sampled.** A grid, a plank, a hex tile: each
 *    is a small function over pixel coordinates, baked once into a `DataTexture`
 *    and cached. No image files, no network, no canvas - a floor looks the same
 *    on the first frame as on the hundredth, and nothing has to be awaited.
 */

import * as THREE from 'three';

import type { OfficeStyle, StyleMaterial, StylePattern, StyleRole } from '@dev3d/core';
import { STYLE_ROLE_LABEL, resolveStyle } from '@dev3d/core';

/**
 * Which role each material in the two GLBs plays.
 *
 * Names are matched on a prefix, because the core's are already grouped
 * (`M_Wall_*`, `M_Chair_*`) and the kit's are not (`W_Wall`, `W_AccentWall`).
 * Order matters: the first prefix that matches wins, so `W_AccentWall` must be
 * listed before `W_Wall`.
 */
const ROLE_BY_MATERIAL: ReadonlyArray<readonly [string, StyleRole]> = [
  // --- the core office (M_*): hand-authored, before the kit existed
  ['M_Wall_Accent', 'accent'],
  ['M_Wall_Paint', 'wall'],
  ['M_Carpet_DevFloor', 'carpet'],
  ['M_Floor_Concrete', 'floor'],
  ['M_Glass_Partition', 'glass'],
  ['M_Metal_Frame', 'frame'],
  ['M_Desk_Top', 'desk'],
  ['M_Desk_Oak', 'desk'],
  ['M_Table_Meeting', 'desk'],
  ['M_Chair_Pad', 'soft'],
  ['M_Chair_Shell', 'soft'],
  ['M_Soft_Furnishing', 'soft'],
  ['M_Rug', 'rug'],
  ['M_Plant', 'plant'],
  ['M_Accent_Orange', 'highlight'],
  ['M_Screen_Emissive', 'screen'],
  // --- the kit (`blocks.glb`): `W_` is the shell, `F_` is what is inside it
  ['W_AccentWall', 'accent'],
  ['W_Wall', 'wall'],
  ['W_Glass', 'glass'],
  ['W_Partition', 'glass'],
  ['W_Carpet', 'carpet'],
  ['W_Floor', 'floor'],
  ['W_Slab', 'floor'],
  ['W_Trim', 'trim'],
  ['F_Frame', 'frame'],
  ['F_Rail', 'frame'],
  ['F_DeskTop', 'desk'],
  ['F_Desk', 'desk'],
  ['F_SoftDeep', 'soft'],
  ['F_Soft', 'soft'],
  ['F_Rug', 'rug'],
  ['F_Plant', 'plant'],
  ['F_Board', 'trim'],
  ['F_Cork', 'rug'],
  ['F_Storage', 'accent'],
  ['F_Art', 'highlight'],
  ['F_Fixture', 'light'],
  ['F_Neon', 'light'],
  ['F_ScreenOff', 'screen'],
  ['F_Screen', 'screen'],
];

/** The role a material name plays, or null when this build has never seen it. */
export function roleForMaterial(name: string): StyleRole | null {
  for (const [prefix, role] of ROLE_BY_MATERIAL) {
    if (name === prefix || name.startsWith(prefix)) return role;
  }
  return null;
}

/** Every material name both assets are known to carry, for the coverage test. */
export const KNOWN_MATERIAL_NAMES: readonly string[] = ROLE_BY_MATERIAL.map(([prefix]) => prefix);

// --------------------------------------------------------------- patterns

const PATTERN_SIZE = 128;

/**
 * Bake a surface pattern into a repeating texture.
 *
 * Each returns a luminance multiplier around 1.0, applied to the role's colour -
 * so a pattern darkens and lightens the surface it is on without needing its own
 * palette, and switching a floor from planks to hex tile is one field.
 */
function paintPattern(pattern: StylePattern) {
  const size = PATTERN_SIZE;
  // Allocated as an explicit ArrayBuffer: a bare `new Uint8Array(n)` is typed
  // against `ArrayBufferLike`, which three.js will not accept as texture data.
  const data = new Uint8Array(new ArrayBuffer(size * size * 4));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let value = 1.0;
      switch (pattern) {
        case 'grid': {
          // A tile grid: a seam every 32 px in both directions.
          const edge = x % 32 === 0 || y % 32 === 0;
          const inner = (x % 32 === 1 || y % 32 === 1) ? 0.94 : 1.0;
          value = edge ? 0.78 : inner;
          break;
        }
        case 'planks': {
          // Boards 32 px tall, staggered by a half-board every other row, with a
          // seam at each end. The stagger is what makes it read as planks rather
          // than as a stack of stripes.
          const row = Math.floor(y / 32);
          const offset = (row % 2) * 32;
          const seamY = y % 32 === 0;
          const seamX = (x + offset) % 64 === 0;
          const grain = 1.0 + ((x * 7 + y * 13 + row * 29) % 11 - 5) * 0.004;
          value = seamY ? 0.8 : (seamX ? 0.86 : grain);
          break;
        }
        case 'hex': {
          // A hex lattice approximated by a triangular wave pair: cheap, and at
          // this tile size the eye reads a honeycomb.
          const a = Math.abs(((x * 2 + (y % 22 < 11 ? 0 : 22)) % 44) - 22) / 22;
          const b = Math.abs(((y * 1.732) % 38) - 19) / 19;
          const edge = Math.min(a, b);
          value = edge > 0.86 ? 0.74 : edge > 0.78 ? 0.88 : 1.0;
          break;
        }
        case 'weave': {
          // A basket weave: 16 px cells, alternating warp and weft.
          const cell = (Math.floor(x / 16) + Math.floor(y / 16)) % 2;
          const within = cell === 0 ? (x % 16 < 8 ? 1.04 : 0.96) : (y % 16 < 8 ? 1.04 : 0.96);
          value = within;
          break;
        }
        case 'speckle': {
          // Deterministic noise: the same speckle on every load and every
          // machine, which a `Math.random()` field would not be.
          const n = (x * 374761393 + y * 668265263) % 2147483647;
          const mixed = (n ^ (n >> 13)) % 1000;
          value = mixed < 40 ? 0.86 : mixed > 960 ? 1.08 : 1.0;
          break;
        }
        case 'plain':
        default:
          value = 1.0;
      }
      const level = Math.max(0, Math.min(255, Math.round(value * 255)));
      const at = (y * size + x) * 4;
      data[at] = level;
      data[at + 1] = level;
      data[at + 2] = level;
      data[at + 3] = 255;
    }
  }
  return data;
}

const patternCache = new Map<StylePattern, THREE.DataTexture>();

function patternTexture(pattern: StylePattern): THREE.DataTexture | null {
  if (pattern === 'plain') return null;
  const found = patternCache.get(pattern);
  if (found) return found;
  const texture = new THREE.DataTexture(paintPattern(pattern), PATTERN_SIZE, PATTERN_SIZE, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  patternCache.set(pattern, texture);
  return texture;
}

// --------------------------------------------------------------- materials

/**
 * A floor's material set: one `MeshStandardMaterial` per role.
 *
 * Owned by the floor that created it. Two floors with the same style get two
 * sets, because a floor that closes has to release its own buffers without
 * reaching into a sibling - and cloning a handful of materials per floor is
 * nothing next to the hundreds of meshes they dress.
 */
export type FloorMaterials = Record<StyleRole, THREE.MeshStandardMaterial>;

/** The rig and scene values a floor resolves to, for the renderer to apply. */
export type FloorLighting = AppliedStyle;

export interface AppliedStyle {
  style: OfficeStyle;
  materials: FloorMaterials;
  lighting: ReturnType<typeof resolveStyle>['lighting'];
  environment: ReturnType<typeof resolveStyle>['environment'];
  presetId: string;
  presetName: string;
  /** Materials whose name this build could not place; they render unstyled. */
  unmapped: string[];
}

function materialFor(role: StyleRole, surface: StyleMaterial, repeat: number): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(surface.color),
    roughness: surface.roughness,
    metalness: surface.metallic ?? 0,
  });
  // `transparent` is opt-in: keeping it off where it is not needed keeps a
  // surface out of the transparency sort, and the kit has hundreds of meshes.
  if (surface.transparent === true || (surface.opacity !== undefined && surface.opacity < 1)) {
    material.transparent = true;
    material.opacity = surface.opacity ?? 1;
    material.depthWrite = false;
  }
  const pattern = surface.pattern === undefined ? null : patternTexture(surface.pattern);
  if (pattern) {
    const tiled = pattern.clone();
    tiled.needsUpdate = true;
    // The repeat is per *room module*, and a module is a few metres across, so
    // this is the number of pattern cells across one. It is a rough unit on
    // purpose: the surfaces that carry a pattern are floors and rugs, and exact
    // texel density is not worth a UV-aware parameterisation here.
    const times = Math.max(0.5, Math.min(24, surface.patternRepeat ?? 4));
    tiled.repeat.set(times / 4, times / 4);
    material.map = tiled;
    // The pattern multiplies the colour rather than replacing it, so a dark
    // palette stays dark.
    material.color.multiplyScalar(1.0);
  }
  // Emissive roles glow faintly, which is what stops a dark floor's screens and
  // neon from reading as holes cut in the geometry.
  if (role === 'screen' || role === 'light') {
    material.emissive = new THREE.Color(surface.color);
    material.emissiveIntensity = role === 'light' ? 0.9 : 0.55;
  }
  return material;
}

/** Build the material set for one floor. The caller owns the result. */
export function applyStyle(style: OfficeStyle | undefined): AppliedStyle {
  const resolved = resolveStyle(style);
  const materials = {} as FloorMaterials;
  for (const role of Object.keys(resolved.materials) as StyleRole[]) {
    materials[role] = materialFor(role, resolved.materials[role], resolved.materials[role].patternRepeat ?? 4);
  }
  return {
    style: style ?? { preset: resolved.preset.id },
    materials,
    lighting: resolved.lighting,
    environment: resolved.environment,
    presetId: resolved.preset.id,
    presetName: resolved.preset.name,
    unmapped: [],
  };
}

/**
 * Re-dress an already-cloned subtree, in place.
 *
 * Every mesh keeps its own material *identity* from the original GLB - three.js
 * shares one material instance across every mesh that used it - so the swap is
 * done once per distinct material rather than once per mesh. That is the
 * difference between a few dozen assignments and a few thousand, and it is why
 * this can run when a floor grows a room.
 */
export function dressMaterials(root: THREE.Object3D, applied: AppliedStyle): string[] {
  const seen = new Map<THREE.Material, StyleRole | null>();
  const unmapped = new Set<string>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const material = mesh.material;
    const assign = (current: THREE.Material): THREE.Material => {
      let role = seen.get(current);
      if (role === undefined) {
        role = roleForMaterial(current.name);
        seen.set(current, role);
        if (role === null && current.name.length > 0) unmapped.add(current.name);
      }
      if (role === null) return current;
      return applied.materials[role];
    };
    if (Array.isArray(material)) mesh.material = material.map(assign);
    else if (material) mesh.material = assign(material);
  });
  applied.unmapped = [...unmapped].sort();
  return applied.unmapped;
}

/** Release everything a floor's material set owns. Textures are shared, so not these. */
export function disposeMaterials(materials: FloorMaterials): void {
  for (const material of Object.values(materials)) {
    // A tiled pattern is cloned per material, so it is owned here; the
    // `patternCache` original is not, and is reused by the next floor.
    material.map?.dispose();
    material.dispose();
  }
}

/**
 * A faint grid for the shadow catcher, in the floor's own colours.
 *
 * Generated once and shared, because every floor of the building stands on the
 * same plane and rebuilding a 64 KB buffer per floor would be waste.
 */
let groundGrid: THREE.DataTexture | null = null;

export function groundGridTexture(): THREE.DataTexture {
  if (groundGrid) return groundGrid;
  const size = 256;
  const data = new Uint8Array(new ArrayBuffer(size * size * 4));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const line = x % 32 === 0 || y % 32 === 0;
      const level = line ? 255 : 0;
      const at = (y * size + x) * 4;
      data[at] = level;
      data[at + 1] = level;
      data[at + 2] = level;
      data[at + 3] = line ? 255 : 0;
    }
  }
  groundGrid = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  groundGrid.wrapS = THREE.RepeatWrapping;
  groundGrid.wrapT = THREE.RepeatWrapping;
  groundGrid.colorSpace = THREE.SRGBColorSpace;
  groundGrid.needsUpdate = true;
  return groundGrid;
}

/** Roles a UI can offer to restyle, in the order the editor lists them. */
export const STYLE_ROLES = Object.keys(STYLE_ROLE_LABEL) as StyleRole[];
