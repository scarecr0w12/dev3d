/**
 * Glazing a grown module's outside walls.
 *
 * The block kit cannot do this. A module is authored with doorways on whichever
 * edges suit its shape, and which of those edges ends up against another module —
 * or against the core — is decided by the layout engine at placement time. So the
 * browser is the first place that knows, which is why a grown wing read as a blank
 * box while the core had a ribbon of windows along both elevations.
 *
 * This module is deliberately free of React and of the scene graph: it is planar
 * geometry and a handful of boxes, and both are worth being able to test without a
 * WebGL context. `OfficeCanvas` supplies the footprints, because measuring them is
 * a scene concern, and inserts the result.
 */

import * as THREE from 'three';

import type { BlockEdge } from '@dev3d/core';

/** A module's footprint, in metres. */
export interface BlockFootprint {
  width: number;
  depth: number;
}

/** A placed module, as much of it as the geometry here needs. */
export interface PlacedBlockLike {
  id: string;
  kind: string;
  x: number;
  z: number;
  /** Degrees, and always a multiple of ninety. */
  rotation: number;
}

/** An axis-aligned rectangle on the floor. */
export interface FootprintBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * The elevation's proportions, matching the core office's so the two read as one
 * building: a 0.9 m sill, a 2.4 m head, and a 3 m wall.
 */
export const GLAZE = {
  sill: 0.9,
  head: 2.4,
  wall: 3.0,
  frame: 0.06,
  /** How much room a neighbour needs before an edge counts as shared. */
  clearance: 0.35,
} as const;

/** Where a wall sits in a module's own frame, and which way it runs. */
function wallOf(edge: BlockEdge, size: BlockFootprint) {
  const alongX = edge === 'n' || edge === 's';
  const fixed = edge === 'e' ? size.width / 2
    : edge === 'w' ? -size.width / 2
      : edge === 'n' ? -size.depth / 2
        : size.depth / 2;
  return { alongX, fixed, span: alongX ? size.width : size.depth };
}

/**
 * The edges of a module that face nothing.
 *
 * An edge is outside when no other module — and not the core — comes within
 * `clearance` of any point along it. Sampling rather than solving
 * segment-to-rectangle distance: modules are axis-aligned rectangles, a long edge
 * can meet a short neighbour anywhere along its length, and a sample every half
 * metre is exact enough here and far easier to check by reading.
 *
 * A doorway on an outside edge does not make it an outside *wall* — it makes it an
 * opening, which is a different thing and is left alone by the caller.
 */
export function exteriorEdges(
  placed: PlacedBlockLike,
  blocks: readonly PlacedBlockLike[],
  sizeOf: (kind: string) => BlockFootprint | null,
  core: FootprintBox,
): BlockEdge[] {
  const size = sizeOf(placed.kind);
  if (!size) return [];

  const theta = (placed.rotation * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  /** A local offset in world space: three.js turns +x towards -z. */
  const turn = (lx: number, lz: number): [number, number] => [lx * cos + lz * sin, -lx * sin + lz * cos];

  const neighbours: FootprintBox[] = [core];
  for (const other of blocks) {
    if (other.id === placed.id) continue;
    const otherSize = sizeOf(other.kind);
    if (!otherSize) continue;
    const otherTheta = (other.rotation * Math.PI) / 180;
    // The bounding box of a rotated rectangle, which for a quarter turn is the
    // rectangle with its sides swapped.
    const halfX = Math.abs((otherSize.width / 2) * Math.cos(otherTheta))
      + Math.abs((otherSize.depth / 2) * Math.sin(otherTheta));
    const halfZ = Math.abs((otherSize.width / 2) * Math.sin(otherTheta))
      + Math.abs((otherSize.depth / 2) * Math.cos(otherTheta));
    neighbours.push({
      minX: other.x - halfX, maxX: other.x + halfX,
      minZ: other.z - halfZ, maxZ: other.z + halfZ,
    });
  }

  const outside: BlockEdge[] = [];
  for (const edge of ['n', 'e', 's', 'w'] as BlockEdge[]) {
    const { alongX, fixed, span } = wallOf(edge, size);
    const [midX, midZ] = turn(alongX ? 0 : fixed, alongX ? fixed : 0);
    const [axisX, axisZ] = turn(alongX ? 1 : 0, alongX ? 0 : 1);
    const centreX = placed.x + midX;
    const centreZ = placed.z + midZ;

    let blockedSamples = 0;
    let samples = 0;
    const steps = Math.max(3, Math.ceil(span / 0.5));
    for (let i = 0; i <= steps; i += 1) {
      const along = (i / steps - 0.5) * span;
      const px = centreX + axisX * along;
      const pz = centreZ + axisZ * along;
      samples += 1;
      for (const box of neighbours) {
        if (px > box.minX - GLAZE.clearance && px < box.maxX + GLAZE.clearance
          && pz > box.minZ - GLAZE.clearance && pz < box.maxZ + GLAZE.clearance) {
          blockedSamples += 1;
          break;
        }
      }
    }
    // A **fraction**, not "any sample". A neighbour that merely clips the end of an
    // edge - which is every module in a row, since they share corners - must not make
    // the whole wall count as shared, or almost nothing is ever glazed. A neighbour
    // that joins a quarter of the wall has, and erring towards "shared" is the right
    // way to be wrong: a window looking into the room next door is worse than a blank
    // wall.
    if (blockedSamples / samples <= 0.25) outside.push(edge);
  }
  return outside;
}

/** The mesh names a module's wall on `edge` is built under. */
export function wallNodeName(kindId: string, edge: BlockEdge): string {
  return `Block_${kindId}_Wall_${edge.toUpperCase()}_0`;
}

/** The lintel that exists only when that wall has a doorway in it. */
export function lintelNodeName(kindId: string, edge: BlockEdge): string {
  return `Block_${kindId}_Wall_${edge.toUpperCase()}_Lintel_0`;
}

/**
 * The glazing for one outside wall, in the module's own frame.
 *
 * The caller adds this to the module instance, so the instance's position and
 * rotation apply to it exactly as they do to the walls.
 *
 * The **sill** is load-bearing rather than decorative. The renderer samples
 * walkable space from the geometry in front of it, so hiding the wall to put glass
 * in its place deletes an obstacle — and a window taken down to the floor would be
 * a hole an employee can walk out of. The sill below the glass is what keeps the
 * module's footprint exactly where it was, band and all; the core's elevations have
 * one for the same reason.
 */
export function glazingFor(placed: PlacedBlockLike, edge: BlockEdge, size: BlockFootprint): THREE.Group {
  const { alongX, fixed, span } = wallOf(edge, size);
  const { sill, head, wall, frame } = GLAZE;
  const group = new THREE.Group();
  group.name = `${placed.id}::Glazing_${edge.toUpperCase()}`;

  const put = (
    name: string,
    material: string,
    along: number,
    z: number,
    length: number,
    height: number,
    thickness: number,
  ): THREE.Mesh => {
    const geometry = alongX
      ? new THREE.BoxGeometry(length, height, thickness)
      : new THREE.BoxGeometry(thickness, height, length);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ name: material }));
    if (alongX) mesh.position.set(along, z, fixed);
    else mesh.position.set(fixed, z, along);
    mesh.name = `${placed.id}::${name}`;
    group.add(mesh);
    return mesh;
  };

  put('Glaze_Sill', 'W_Wall', 0, sill / 2, span, sill, 0.15);
  put('Glaze_Header', 'W_Wall', 0, head + (wall - head) / 2, span, wall - head, 0.15);
  put('Glaze_Glass', 'W_Glass', 0, (sill + head) / 2, span - frame * 2, head - sill - frame * 2, 0.04);
  for (const z of [sill + frame / 2, head - frame / 2]) {
    put(`Glaze_Bar_${z.toFixed(2)}`, 'F_Frame', 0, z, span, frame, 0.18);
  }
  for (const side of [-1, 1]) {
    put(`Glaze_Jamb_${side}`, 'F_Frame', side * (span / 2 - frame / 2), (sill + head) / 2, frame, head - sill, 0.18);
  }
  // A mullion roughly every 2.4 m, as the core's elevations have.
  const bays = Math.max(1, Math.round(span / 2.4));
  for (let i = 1; i < bays; i += 1) {
    put(`Glaze_Mullion_${i}`, 'F_Frame', (i / bays - 0.5) * span, (sill + head) / 2,
      Math.max(0.04, frame * 0.8), head - sill - frame * 2, 0.17);
  }
  return group;
}
