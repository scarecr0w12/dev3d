/**
 * Floor layout: growing a floor when it runs out of desks.
 *
 * A floor is the core room plus a ring of room modules bolted onto its walls. A
 * module attaches through a **port** - a doorway on a wall, with an outward
 * normal - and the module it attaches to must have a doorway facing back. That
 * single rule is the whole jigsaw: everything here follows from it.
 *
 * Three properties this module is built to guarantee, because a building that
 * violates any of them looks broken in a way no amount of art fixes:
 *
 *  - **Nothing overlaps.** Every candidate placement is collision-tested against
 *    the core and every module already placed. A port that would collide is
 *    skipped, not squeezed.
 *  - **Nothing escapes the ring.** Growth walks outward from the core, so a
 *    floor stays a bounded, plausible building rather than a spiral.
 *  - **The answer is deterministic.** Ports are considered in a fixed order, so
 *    the same floor with the same kit always grows the same way. A 3D view that
 *    reshuffled itself between reloads would be unusable.
 *
 * The geometry is pure arithmetic on numbers, deliberately: a convention error
 * in a rotation is caught by a unit test rather than by squinting at a viewport.
 */

import type { BlockEdge, BlockKit, CorePort, FloorLayout, OfficeBlockKind, PlacedBlock } from '@dev3d/core';

/** The edge whose outward normal is opposite. A wall only mates with its facing wall. */
export function oppositeEdge(edge: BlockEdge): BlockEdge {
  switch (edge) {
    case 'n':
      return 's';
    case 's':
      return 'n';
    case 'e':
      return 'w';
    case 'w':
      return 'e';
  }
}

/**
 * The world direction a local edge points after rotating by `deg` about Y.
 *
 * three.js maps local (x, z) with `x' = x·cos + z·sin`, `z' = -x·sin + z·cos`,
 * and in this frame +x is east and +z is south. So local north `(0, -1)` at 90°
 * becomes west, which is exactly the kind of thing that is easy to get backwards
 * and expensive to notice.
 */
export function rotatedEdgeNormal(edge: BlockEdge, deg: number): BlockEdge {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.round(Math.cos(rad));
  const sin = Math.round(Math.sin(rad));
  const local: Record<BlockEdge, [number, number]> = {
    n: [0, -1],
    e: [1, 0],
    s: [0, 1],
    w: [-1, 0],
  };
  const [x, z] = local[edge];
  const wx = x * cos + z * sin;
  const wz = -x * sin + z * cos;
  if (wx === 0 && wz === -1) return 'n';
  if (wx === 1 && wz === 0) return 'e';
  if (wx === 0 && wz === 1) return 's';
  return 'w';
}

/** Rotate a local offset by `deg` about Y. */
function rotatePoint(x: number, z: number, deg: number): { x: number; z: number } {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: x * cos + z * sin, z: -x * sin + z * cos };
}

/** The centre of a module's edge, in the module's own centred frame. */
function edgeMidpoint(edge: BlockEdge, width: number, depth: number): { x: number; z: number } {
  switch (edge) {
    case 'n':
      return { x: 0, z: -depth / 2 };
    case 's':
      return { x: 0, z: depth / 2 };
    case 'e':
      return { x: width / 2, z: 0 };
    case 'w':
      return { x: -width / 2, z: 0 };
  }
}

/** A module's footprint in world space, as a half-extent about its centre. */
export function blockExtent(
  kind: OfficeBlockKind,
  rotation: number,
): { halfW: number; halfD: number } {
  const swapped = rotation === 90 || rotation === 270;
  return {
    halfW: (swapped ? kind.depth : kind.width) / 2,
    halfD: (swapped ? kind.width : kind.depth) / 2,
  };
}

interface Box {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function blockBox(placed: PlacedBlock, kind: OfficeBlockKind): Box {
  const { halfW, halfD } = blockExtent(kind, placed.rotation);
  return {
    minX: placed.x - halfW,
    maxX: placed.x + halfW,
    minZ: placed.z - halfD,
    maxZ: placed.z + halfD,
  };
}

function coreBox(kit: BlockKit): Box {
  return {
    minX: -kit.core.width / 2,
    maxX: kit.core.width / 2,
    minZ: -kit.core.depth / 2,
    maxZ: kit.core.depth / 2,
  };
}

/**
 * Do two footprints overlap? Touching edges are not an overlap - a module is
 * supposed to sit flush against the wall it attached to.
 */
function overlaps(a: Box, b: Box, tolerance = 0.01): boolean {
  return (
    a.minX < b.maxX - tolerance &&
    a.maxX > b.minX + tolerance &&
    a.minZ < b.maxZ - tolerance &&
    a.maxZ > b.minZ + tolerance
  );
}

export interface Placement {
  kind: OfficeBlockKind;
  x: number;
  z: number;
  rotation: 0 | 90 | 180 | 270;
  /** Which local edge mates with the port. */
  entryEdge: BlockEdge;
}

/**
 * Where `kind` would sit if it were attached to `port`.
 *
 * The rotations are tried cheapest-first so a module lands axis-aligned with the
 * building whenever its doorways allow it, which is what keeps the plan legible.
 */
export function placementFor(
  kind: OfficeBlockKind,
  port: { x: number; z: number; dir: BlockEdge },
): Placement | null {
  const needed = oppositeEdge(port.dir);
  for (const rotation of [0, 90, 180, 270] as const) {
    for (const edge of kind.doors) {
      if (rotatedEdgeNormal(edge, rotation) !== needed) continue;
      const mid = edgeMidpoint(edge, kind.width, kind.depth);
      const offset = rotatePoint(mid.x, mid.z, rotation);
      return { kind, x: port.x - offset.x, z: port.z - offset.z, rotation, entryEdge: edge };
    }
  }
  return null;
}

/** Every doorway a placed module offers the frontier, in world space. */
function portsOf(placed: PlacedBlock, kind: OfficeBlockKind, entryEdge: BlockEdge): CorePort[] {
  const out: CorePort[] = [];
  for (const edge of kind.doors) {
    if (edge === entryEdge) continue;
    const mid = edgeMidpoint(edge, kind.width, kind.depth);
    const offset = rotatePoint(mid.x, mid.z, placed.rotation);
    out.push({
      id: `${placed.id}:${edge}`,
      x: placed.x + offset.x,
      z: placed.z + offset.z,
      dir: rotatedEdgeNormal(edge, placed.rotation),
    });
  }
  return out;
}

export interface LayoutProblem {
  message: string;
}

export interface GrowResult {
  layout: FloorLayout;
  added: PlacedBlock[];
  /** True when the frontier ran dry before the target was met. */
  exhausted: boolean;
  problem?: LayoutProblem;
}

/** Rooms available to grow with. A fitting is never a room. */
function roomKinds(kit: BlockKit): OfficeBlockKind[] {
  return kit.blocks.filter((block) => block.fitting !== true && block.doors.length > 0);
}

/** Seats a placed module adds. */
function seatsOf(kind: OfficeBlockKind): number {
  return kind.seats.length;
}

/** The ids already used, so a new instance never collides after a removal. */
function nextInstanceId(layout: FloorLayout): string {
  let highest = 0;
  for (const block of layout.blocks) {
    const match = /^B(\d+)$/.exec(block.id);
    if (match?.[1] !== undefined) highest = Math.max(highest, Number.parseInt(match[1], 10));
  }
  return `B${highest + 1}`;
}

/**
 * Plan a floor of exactly `rooms` modules, rebuilt from the core.
 *
 * Replanning rather than patching is deliberate. An incremental build would have
 * to remember, for every module, which of its doorways was spent on the one it
 * attached through - and get that right across restarts, removals and edits. The
 * generation is deterministic, so replanning to N+1 produces the same building
 * as growing to N+1 did, and the prefix is stable: extending a floor never
 * reshuffles the rooms that were already there.
 */
export function planFloor(kit: BlockKit, coreSeats: number, rooms: number, maxBlocks = 24): GrowResult {
  const blocks: PlacedBlock[] = [];
  const added: PlacedBlock[] = [];
  const kinds = roomKinds(kit);
  const limit = Math.min(rooms, maxBlocks);
  if (kinds.length === 0 && limit > 0) {
    return {
      layout: { blocks, updatedAt: Date.now() },
      added,
      exhausted: true,
      problem: { message: 'the block kit has no rooms to build with.' },
    };
  }

  const known = new Map<string, OfficeBlockKind>();
  const frontier: CorePort[] = kit.core.ports.map((port) => ({ ...port }));
  const core = coreBox(kit);
  let cursor = 0;
  /** How many of each kind have been placed, which is what keeps the mix varied. */
  const placedCounts = new Map<string, number>();

  /**
   * The order to try module kinds in at one port.
   *
   * Always taking the first kind that fits produces a building made entirely of
   * whichever module happens to be listed first - a train of identical pods, not
   * a jigsaw. So kinds are tried least-used-first, which cycles through the kit.
   *
   * A junction seats nobody, which makes it tempting to push to the back of the
   * queue. That is a trap: a room with one doorway is a dead end, so a run of
   * single-door offices and meeting rooms stops the building dead. Junctions are
   * the only module that opens new doorways on all four sides, so they take their
   * turn like anything else - and a floor with a corridor in it reads better than
   * one that is nine pods in a line.
   */
  function kindOrder(): OfficeBlockKind[] {
    return [...kinds].sort((a, b) => {
      const byCount = (placedCounts.get(a.id) ?? 0) - (placedCounts.get(b.id) ?? 0);
      if (byCount !== 0) return byCount;
      return kinds.indexOf(a) - kinds.indexOf(b);
    });
  }

  while (added.length < limit && cursor < frontier.length) {
    const port = frontier[cursor];
    cursor += 1;
    if (port === undefined) break;

    // Least-used kind first, so the building is a mix rather than a row of the
    // same module. Still deterministic: the counts only depend on what is already
    // placed, and the tie-break falls back to kit order.
    for (const kind of kindOrder()) {
      const placement = placementFor(kind, port);
      if (placement === null) continue;

      const instance: PlacedBlock = {
        id: `B${blocks.length + 1}`,
        kind: kind.id,
        x: round(placement.x),
        z: round(placement.z),
        rotation: placement.rotation,
        attachedTo: port.id,
      };

      const box = blockBox(instance, kind);
      const collides =
        overlaps(box, core) ||
        blocks.some((other) => {
          const otherKind = known.get(other.id);
          return otherKind !== undefined && overlaps(box, blockBox(other, otherKind));
        });
      // A port that would collide is spent, not squeezed: a room pushed into
      // another room is worse than a room not built.
      if (collides) continue;

      blocks.push(instance);
      known.set(instance.id, kind);
      added.push(instance);
      placedCounts.set(kind.id, (placedCounts.get(kind.id) ?? 0) + 1);
      for (const next of portsOf(instance, kind, placement.entryEdge)) frontier.push(next);
      break;
    }
  }

  return { layout: { blocks, updatedAt: Date.now() }, added, exhausted: added.length < rooms };
}

export interface GrowResult {
  layout: FloorLayout;
  added: PlacedBlock[];
  /** True when the frontier ran dry before the target was met. */
  exhausted: boolean;
  problem?: LayoutProblem;
}

/**
 * Grow a floor until it can seat `targetSeats`.
 *
 * `coreSeats` is passed in rather than read from the kit: the core is a GLB whose
 * anchors the browser discovers at load time, and the server has no business
 * guessing at them.
 */
export function grow(
  kit: BlockKit,
  layout: FloorLayout,
  coreSeats: number,
  targetSeats: number,
  maxBlocks = 24,
): GrowResult {
  const startCount = layout.blocks.length;
  if (capacityOf(kit, layout, coreSeats) >= targetSeats) {
    return { layout, added: [], exhausted: false };
  }

  let planned = layout;
  let problem: LayoutProblem | undefined;

  for (let rooms = startCount + 1; rooms <= maxBlocks; rooms += 1) {
    const next = planFloor(kit, coreSeats, rooms, maxBlocks);
    problem = next.problem;
    // No progress means the frontier is spent. Keep the last building that did
    // fit rather than reporting a failure and losing the rooms already planned.
    if (next.layout.blocks.length <= planned.blocks.length) break;
    planned = next.layout;
    if (capacityOf(kit, planned, coreSeats) >= targetSeats) break;
  }

  // `added` is the whole suffix, not just the last round: a caller announcing
  // "three rooms were built" must not be told about only the final one.
  const added = planned.blocks.slice(startCount);
  // Exhausted means "this floor still cannot seat everyone", whether that is
  // because nothing else fits or because the module ceiling was reached.
  const exhausted = capacityOf(kit, planned, coreSeats) < targetSeats;

  const result: GrowResult = { layout: planned, added, exhausted };
  if (problem !== undefined && added.length === 0) result.problem = problem;
  return result;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Remove one module, newest first.
 *
 * Replanning rather than truncating is what keeps the building connected: the
 * `rooms`-th module is exactly the one the generation order added last, so the
 * remaining building is one the planner would have produced on its own.
 */
export function shrink(kit: BlockKit, layout: FloorLayout, coreSeats: number): { layout: FloorLayout; removed: PlacedBlock | null } {
  const count = layout.blocks.length;
  if (count === 0) return { layout, removed: null };
  const previous = planFloor(kit, coreSeats, count - 1);
  const last = layout.blocks[count - 1] ?? null;
  return { layout: previous.layout, removed: last };
}

/** Every seat a floor offers: the core's, then one set per placed module. */
export function seatIdsFor(kit: BlockKit, layout: FloorLayout, coreSeatIds: readonly string[]): string[] {
  const byId = new Map(kit.blocks.map((block) => [block.id, block]));
  const out = [...coreSeatIds];
  for (const placed of layout.blocks) {
    const kind = byId.get(placed.kind);
    if (!kind) continue;
    for (const seat of kind.seats) out.push(`${placed.id}::${seat}`);
  }
  return out;
}

/** How many employees a floor can seat right now. */
export function capacityOf(kit: BlockKit, layout: FloorLayout, coreSeatCount: number): number {
  const byId = new Map(kit.blocks.map((block) => [block.id, block]));
  return layout.blocks.reduce((sum, placed) => {
    const kind = byId.get(placed.kind);
    return sum + (kind ? kind.seats.length : 0);
  }, coreSeatCount);
}

/** A short human line for the console: `core + 3 rooms, 4 kinds used`. */
export function describeLayout(kit: BlockKit, layout: FloorLayout): string {
  if (layout.blocks.length === 0) return 'core only';
  const byId = new Map(kit.blocks.map((block) => [block.id, block]));
  const kinds = new Set<string>();
  for (const placed of layout.blocks) {
    const kind = byId.get(placed.kind);
    if (kind) kinds.add(kind.name);
  }
  const rooms = layout.blocks.length === 1 ? '1 room' : `${layout.blocks.length} rooms`;
  return `core + ${rooms} · ${[...kinds].join(', ')}`;
}
