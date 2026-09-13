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

import type { TextureLibrary, TextureSet } from './textures';

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
  ['M_Light_Panel', 'light'],
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

/*
 * `KNOWN_MATERIAL_NAMES` used to sit here, exported "for the coverage test" — and
 * the coverage test kept its own copy instead, so the export had no reader and the
 * two lists could drift apart without anything noticing. A list a test derives from
 * the code under test proves nothing anyway: it would pass whatever the code said.
 * The test's own copy is the honest one, so this is gone.
 */

// --------------------------------------------------------------- patterns

const PATTERN_SIZE = 128;

const patternFieldCache = new Map<StylePattern, Float32Array>();
const patternCache = new Map<StylePattern, THREE.DataTexture>();
const reliefCache = new Map<StylePattern, { normal: THREE.DataTexture; roughness: THREE.DataTexture }>();

/**
 * The height field a pattern is made of, before anything is drawn from it.
 *
 * A pattern is not only a colour multiplier any more: the same field is
 * projected three ways - as the tint, as a tangent-space normal map and as a
 * roughness map - so that a plank seam is a dark line, a groove and a rougher
 * patch at exactly the same pixel. Deriving all three from one field is what
 * keeps them in register; sampling three textures would let them drift.
 *
 * Each value is a luminance multiplier around 1.0, applied to the role's colour -
 * so a pattern darkens and lightens the surface it is on without needing its own
 * palette, and switching a floor from planks to hex tile is one field.
 */
function patternField(pattern: StylePattern): Float32Array {
  const found = patternFieldCache.get(pattern);
  if (found) return found;
  const size = PATTERN_SIZE;
  const field = new Float32Array(size * size);
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
      field[y * size + x] = value;
    }
  }
  patternFieldCache.set(pattern, field);
  return field;
}

/** A greyscale level, clamped to a byte. */
function level(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

/**
 * Wrap a baked buffer as a repeating texture.
 *
 * Every texture made here is *data*, not colour - a multiplier or a slope - so
 * three.js must not sRGB-decode it. They are also mipped and anisotropic, which
 * is what stops a floor's pattern turning into a shimmering moire at the grazing
 * angle a floor is almost always seen from.
 */
function fieldTexture(data: Uint8Array<ArrayBuffer>): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, PATTERN_SIZE, PATTERN_SIZE, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  // Clamped by the renderer against the device's real limit, so this is a
  // request rather than a promise.
  texture.anisotropy = 8;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function patternTexture(pattern: StylePattern): THREE.DataTexture | null {
  if (pattern === 'plain') return null;
  const found = patternCache.get(pattern);
  if (found) return found;
  const field = patternField(pattern);
  // Allocated as an explicit ArrayBuffer: a bare `new Uint8Array(n)` is typed
  // against `ArrayBufferLike`, which three.js will not accept as texture data.
  const data = new Uint8Array(new ArrayBuffer(PATTERN_SIZE * PATTERN_SIZE * 4));
  for (const [i, value] of field.entries()) {
    const at = i * 4;
    const grey = level(value);
    data[at] = grey;
    data[at + 1] = grey;
    data[at + 2] = grey;
    data[at + 3] = 255;
  }
  const texture = fieldTexture(data);
  patternCache.set(pattern, texture);
  return texture;
}

/**
 * How steeply a baked relief is cut, before the style's own `relief` scales it.
 *
 * The field is nearly flat - a seam sits at 0.8 against a board's 1.0 - so the
 * raw central difference between neighbouring texels is a slope of about 0.1.
 * This is what turns that into an edge that catches a highlight.
 */
const RELIEF_BAKE = 5.0;

/**
 * A pattern's relief, in register with its tint: a normal map and a roughness map.
 *
 * The normal comes from central differences over the field, wrapping at the
 * edges. The pattern tiles, so the neighbour of the first column is the last one;
 * clamping instead would put a visible ridge down every tile boundary.
 *
 * The roughness map's green channel is the one three.js reads, and it
 * *multiplies* the material's roughness, so it stays at or below 1: grooves sit
 * at 1 and the faces between them are pulled slightly smoother. A floor's style
 * roughness therefore reads as an average rather than an exact figure, which is
 * the honest description of a surface that is not uniformly finished.
 */
function reliefTextures(pattern: StylePattern): { normal: THREE.DataTexture; roughness: THREE.DataTexture } {
  const found = reliefCache.get(pattern);
  if (found) return found;

  const size = PATTERN_SIZE;
  const field = patternField(pattern);
  /**
   * The height at a texel, wrapping at the edges.
   *
   * The fallback is unreachable - the modulo keeps every index inside the field -
   * and exists only because indexed access is typed as possibly absent. A neutral
   * 1.0 is the right one to be wrong with: it is flat, so a mistake here would
   * show up as no relief rather than as a spike.
   */
  const sample = (x: number, y: number): number => {
    const column = ((x % size) + size) % size;
    const row = ((y % size) + size) % size;
    return field[row * size + column] ?? 1;
  };

  let min = Infinity;
  let max = -Infinity;
  for (const value of field) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const span = max - min > 0.0001 ? max - min : 1;

  const normalData = new Uint8Array(new ArrayBuffer(size * size * 4));
  const roughData = new Uint8Array(new ArrayBuffer(size * size * 4));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = (y * size + x) * 4;
      // Tangent space: +x runs right, +y runs up the image, +z leaves the surface.
      const dx = (sample(x + 1, y) - sample(x - 1, y)) * RELIEF_BAKE;
      const dy = (sample(x, y + 1) - sample(x, y - 1)) * RELIEF_BAKE;
      const length = Math.hypot(dx, dy, 1);
      normalData[at] = level((-dx / length) * 0.5 + 0.5);
      normalData[at + 1] = level((-dy / length) * 0.5 + 0.5);
      normalData[at + 2] = level((1 / length) * 0.5 + 0.5);
      normalData[at + 3] = 255;

      // 1 in the groove, easing down to 0.75 on the face. See the note above.
      const rough = level(1 - 0.25 * ((sample(x, y) - min) / span));
      roughData[at] = rough;
      roughData[at + 1] = rough;
      roughData[at + 2] = rough;
      roughData[at + 3] = 255;
    }
  }

  const textures = { normal: fieldTexture(normalData), roughness: fieldTexture(roughData) };
  reliefCache.set(pattern, textures);
  return textures;
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

/**
 * How much relief a role's pattern is cut with, when a style does not say.
 *
 * Only patterned surfaces have relief at all, so this decides how strongly a
 * floor, a rug or a woven seat reads as a surface rather than as a printed
 * image. Floors get the most because a floor is seen at a grazing angle, where
 * relief and anisotropy are the two things that separate a floor from a
 * photograph of one. Walls get none: paint over plaster is flat, and a normal
 * map on it reads as a mistake.
 */
const ROLE_RELIEF: Record<StyleRole, number> = {
  floor: 1.0,
  carpet: 0.7,
  rug: 0.8,
  trim: 0.4,
  desk: 0.35,
  soft: 0.3,
  wall: 0,
  accent: 0,
  glass: 0,
  frame: 0,
  plant: 0,
  light: 0,
  screen: 0,
  highlight: 0,
};

/**
 * The real material sets, once they have loaded.
 *
 * Module state rather than a parameter because `applyStyle` is called from a render
 * loop and from the server, and neither can await a texture. It is null until the
 * canvas has fetched the library, and every surface falls back to its generated
 * pattern until then - so the office is never undressed, only less detailed.
 */
let textureLibrary: TextureLibrary | null = null;

/** Hand the theme a loaded library. Passing null goes back to generated patterns. */
export function setTextureLibrary(next: TextureLibrary | null): void {
  textureLibrary = next;
}

/** What the theme is currently dressing with, for the status line and for tests. */
export function activeTextureLibrary(): TextureLibrary | null {
  return textureLibrary;
}

/**
 * Dress one role with a real set: albedo, normal and roughness, at real scale.
 *
 * `repeat` is `1 / tileMetres`, which is exact rather than a guess because both
 * assets carry UVs measured in metres - so a concrete tile covers two metres on a
 * desk-sized panel and two metres on the 22 m floor slab, and the texel density is
 * the same on both. Each map is cloned per material because the repeat is a
 * property of the texture object, while the image and its GPU upload are shared.
 */
function applyPbrSet(material: THREE.MeshStandardMaterial, set: TextureSet): void {
  const perMetre = 1 / set.tileMetres;
  const tile = (texture: THREE.Texture): THREE.Texture => {
    const tiled = texture.clone();
    tiled.needsUpdate = true;
    tiled.repeat.set(perMetre, perMetre);
    return tiled;
  };
  material.map = tile(set.map);
  material.normalMap = tile(set.normalMap);
  material.roughnessMap = tile(set.roughnessMap);
  material.normalScale = new THREE.Vector2(1, 1);

  // The style's colour means "the colour of this surface", and the map already
  // carries a colour, so one is divided by the other rather than two colours being
  // multiplied: a concrete albedo averaging 0.44 lit by a preset colour of 0.44
  // should render at 0.44, not at 0.19. Without this every textured surface comes
  // out darker than the Look panel says it is, and darker presets come out black.
  //
  // `material.color` is in linear light, which is the space `albedoMean` is
  // measured in, so the division is direct. The clamp keeps a very dark preset
  // colour from asking for an unbounded multiplier and blowing out the highlights.
  const colour = material.color;
  material.color = new THREE.Color(
    Math.min(4, colour.r / set.albedoMean[0]),
    Math.min(4, colour.g / set.albedoMean[1]),
    Math.min(4, colour.b / set.albedoMean[2]),
  );
}

function materialFor(role: StyleRole, surface: StyleMaterial): THREE.MeshStandardMaterial {
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
  const patternKind = surface.pattern;
  const pattern = patternKind === undefined ? null : patternTexture(patternKind);
  if (textureLibrary?.[role] !== undefined) {
    // A real material wins over the generated one rather than layering with it: a
    // surface with two normal maps and two roughness maps is not a richer material,
    // it is a doubled one.
    applyPbrSet(material, textureLibrary[role] as TextureSet);
  } else if (patternKind !== undefined && pattern) {
    const tiled = pattern.clone();
    tiled.needsUpdate = true;
    // Both assets carry UVs measured in *metres* - one UV unit is one metre of
    // surface on every part, whatever its size - so this is a real-world scale
    // rather than the guess it used to be. `patternRepeat` is tiles per nominal
    // four-metre room module, which is what the presets were tuned against.
    const tilesPerMetre = Math.max(0.5, Math.min(24, surface.patternRepeat ?? 4)) / 4.0;
    tiled.repeat.set(tilesPerMetre, tilesPerMetre);
    material.map = tiled;
    // The pattern multiplies the colour rather than replacing it, so a dark
    // palette stays dark.
    material.color.multiplyScalar(1.0);

    // The relief is that same field projected as slope and as finish, tiled in
    // step with the tint, so the groove you can see is the groove that catches
    // the light.
    const relief = surface.relief ?? ROLE_RELIEF[role];
    if (relief > 0) {
      const { normal, roughness } = reliefTextures(patternKind);
      const normalMap = normal.clone();
      const roughnessMap = roughness.clone();
      normalMap.needsUpdate = true;
      roughnessMap.needsUpdate = true;
      normalMap.repeat.copy(tiled.repeat);
      roughnessMap.repeat.copy(tiled.repeat);
      material.normalMap = normalMap;
      material.normalScale = new THREE.Vector2(relief, relief);
      material.roughnessMap = roughnessMap;
    }
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
    materials[role] = materialFor(role, resolved.materials[role]);
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
 *
 * Takes only the two fields it touches - the palette it swaps in, and somewhere to
 * write what it could not place. It used to demand a whole `AppliedStyle`, which is
 * what made the caller fabricate one with `{ materials } as AppliedStyle`: a cast
 * that hides exactly the mistake it should catch. The returned list is the same one
 * written to `applied.unmapped`, so a caller with a scratch carrier still gets the
 * report.
 */
export function dressMaterials(
  root: THREE.Object3D,
  applied: { materials: FloorMaterials; unmapped?: string[] },
): string[] {
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
  const list = [...unmapped].sort();
  applied.unmapped = list;
  return list;
}

/** Release everything a floor's material set owns. Textures are shared, so not these. */
export function disposeMaterials(materials: FloorMaterials): void {
  for (const material of Object.values(materials)) {
    // A tiled pattern is cloned per material, so it is owned here; the
    // `patternCache` originals are not, and are reused by the next floor. The
    // relief maps are cloned per material for the same reason - each one tiles
    // to its own role's repeat - so each is disposed here too.
    material.map?.dispose();
    material.normalMap?.dispose();
    material.roughnessMap?.dispose();
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
