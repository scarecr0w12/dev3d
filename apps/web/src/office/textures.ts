/**
 * The PBR texture library.
 *
 * The office was built on a rule: no image files, nothing to await, nothing to
 * fetch. Every surface was a flat colour times a small greyscale pattern computed
 * in the browser, which is why a texture could only ever make a surface lighter or
 * darker and never make it a different *material*.
 *
 * This is the other half. `blender/scripts/07_textures.py` writes real albedo,
 * normal and roughness maps as PNGs, plus an `index.json` that says which style
 * role each set dresses and how many metres one tile of it covers. Nothing here
 * knows a material by name: the sidecar is the single place the pairing lives, so
 * adding a surface is a Blender run rather than a code change.
 *
 * Loading is deliberately explicit rather than automatic. `applyStyle` stays
 * synchronous - it is called from a render loop and from the server - so the
 * library is loaded once, up front, and *handed* to the theme layer. A floor that
 * is dressed before the library arrives is dressed procedurally and never
 * upgraded, which is why the canvas awaits this before it builds anything.
 */

import * as THREE from 'three';

import type { StyleRole } from '@dev3d/core';

/** One material's maps, and the real-world size one tile of them covers. */
export interface TextureSet {
  tileMetres: number;
  /**
   * The albedo's own average, in linear light.
   *
   * A style's colour means "the colour of this surface", and a map already carries
   * a colour, so the theme divides one by the other rather than multiplying two
   * colours together - which is what would otherwise render every textured surface
   * darker than the preset claims, by exactly this figure.
   */
  albedoMean: [number, number, number];
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

/** What each style role is dressed with. A role with no entry keeps its pattern. */
export type TextureLibrary = Partial<Record<StyleRole, TextureSet>>;

interface LibraryIndex {
  sets?: Array<{ id?: unknown; role?: unknown; tileMetres?: unknown; albedoMean?: unknown }>;
}

/** Where the library lives under the served app. */
export const TEXTURE_BASE = '/textures';

function asRole(value: unknown): StyleRole | null {
  // The roles the generator can write, as a plain list rather than an import: this
  // is a runtime check on a file, and a role the theme does not know would be a
  // silent no-op rather than an error.
  const roles = [
    'wall', 'accent', 'glass', 'floor', 'carpet', 'frame', 'trim', 'desk',
    'soft', 'plant', 'rug', 'light', 'screen', 'highlight',
  ] as const;
  return typeof value === 'string' && (roles as readonly string[]).includes(value)
    ? (value as StyleRole)
    : null;
}

/**
 * Load every set the index names.
 *
 * Throws rather than returning a partial library: the caller falls back to the
 * procedural patterns on any failure, and half a library is a floor dressed in one
 * material on one side of a doorway and another on the other.
 */
export async function loadTextureLibrary(
  baseUrl: string = TEXTURE_BASE,
  anisotropy = 8,
): Promise<TextureLibrary> {
  const response = await fetch(`${baseUrl}/index.json`);
  if (!response.ok) throw new Error(`no texture index at ${baseUrl}/index.json (${response.status})`);
  const index = (await response.json()) as LibraryIndex;
  const entries = (index.sets ?? [])
    .map((entry) => {
      const role = asRole(entry.role);
      const mean = Array.isArray(entry.albedoMean) ? entry.albedoMean : null;
      if (typeof entry.id !== 'string' || role === null || typeof entry.tileMetres !== 'number') return null;
      if (mean === null || mean.length !== 3 || mean.some((v) => typeof v !== 'number' || !(v > 0))) return null;
      return { id: entry.id, role, tileMetres: entry.tileMetres, albedoMean: mean as [number, number, number] };
    })
    .filter((entry): entry is { id: string; role: StyleRole; tileMetres: number; albedoMean: [number, number, number] } => entry !== null);
  if (entries.length === 0) throw new Error('the texture index names no usable sets');

  const loader = new THREE.TextureLoader();
  const library: TextureLibrary = {};

  const load = async (id: string, suffix: string, srgb: boolean): Promise<THREE.Texture> => {
    const texture = await loader.loadAsync(`${baseUrl}/${id}_${suffix}.png`);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    // Albedo is a picture and must be sRGB-decoded; a normal or a roughness map is
    // data and must not be. Getting this backwards is the classic way to ship a
    // floor that looks washed out and a normal map that lights from the wrong side.
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.anisotropy = anisotropy;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
  };

  await Promise.all(
    entries.map(async (entry) => {
      const [map, normalMap, roughnessMap] = await Promise.all([
        load(entry.id, 'albedo', true),
        load(entry.id, 'normal', false),
        load(entry.id, 'roughness', false),
      ]);
      library[entry.role] = {
        tileMetres: entry.tileMetres,
        albedoMean: entry.albedoMean,
        map,
        normalMap,
        roughnessMap,
      };
    }),
  );
  return library;
}

/**
 * Release a library's own textures.
 *
 * The theme clones a map per material, and those clones are released with the
 * floor that owns them; these are the originals and outlive every floor.
 */
export function disposeTextureLibrary(library: TextureLibrary): void {
  for (const set of Object.values(library)) {
    if (!set) continue;
    set.map.dispose();
    set.normalMap.dispose();
    set.roughnessMap.dispose();
  }
}
