/**
 * Where a person can walk, derived from the office that is actually loaded.
 *
 * **There is no navmesh in this repository and no hand-authored path data.**
 * Walkable space is computed from the floor's own geometry: every mesh that
 * stands in a person's band - above the ankle, below the head - is treated as an
 * obstacle, and the floor around them is sampled onto a grid. That works because
 * of how both GLBs are built: walls, desks and chairs are boxes, and a doorway
 * is a genuine gap between two wall segments rather than a hole cut out of one.
 * A bounding box is therefore an exact description of a wall, which is what lets
 * this be simple and still be right.
 *
 * Two consequences worth knowing:
 *
 *  - **A sealed room is sealed here too.** The three back offices and the glass
 *    meeting room have no doorway, so the grid says so and an errand into one is
 *    refused rather than walked through a wall. Nothing special-cases them.
 *  - **A floor that grows is walkable immediately.** A new module is more boxes,
 *    so the grid covers it without anyone describing it twice.
 *
 * The grid is deliberately free of three.js: it takes boxes, not meshes, so the
 * decision layer can be tested without a WebGL context.
 */

export interface Vec2 {
  x: number;
  z: number;
}

/** The footprint of something a person cannot walk through. */
export interface ObstacleBox {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface NavBounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface NavGrid {
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  readonly bounds: NavBounds;
  /** How many cells are actually walkable; 0 means nothing can move here. */
  readonly walkableCells: number;
  /** How many disconnected pieces the walkable space is in. */
  readonly regions: number;
  /** Whether the exact point is walkable (as opposed to near something walkable). */
  isWalkable(x: number, z: number): boolean;
  /** Connected piece this point belongs to, or -1 when the point itself is blocked. */
  regionAt(x: number, z: number): number;
  /**
   * The nearest walkable point to `(x, z)`, or null when there is none within
   * reach. A destination is snapped rather than refused, because anchors are
   * authored by hand and a sofa moved over one should move the person who was
   * going to stand there.
   */
  resolve(x: number, z: number): Vec2 | null;
  /** A walkable route from one point to another, or null when there is none. */
  path(from: Vec2, to: Vec2): Vec2[] | null;
  /**
   * A few points spread across one connected piece: its middle and its four
   * extremes. Rooms that carry no anchor of their own - a grown module, a
   * corridor - still get somewhere for people to stand.
   */
  regionSpots(region: number): Vec2[];
}

export interface NavGridOptions {
  /**
   * The extent to sample. Defaults to exactly what the obstacles cover.
   *
   * **A margin here is a bug, and it is a subtle one.** The plate a floor is
   * drawn on is deliberately a little larger than its walls, so sampling the
   * plate finds a walkable strip *outside* the building - one that connects to
   * the inside through the growth doorways. An errand could then route out of
   * one door and back in through another, and a room's "extremes" could put
   * somebody standing in the void beside the office. Hugging the geometry
   * instead leaves only the doorway thresholds walkable, which is where a
   * grown module attaches anyway.
   */
  bounds?: NavBounds;
  /** Grid resolution in metres. */
  cell?: number;
  /** Clearance a walker keeps from furniture, in metres. */
  radius?: number;
  /** How far a blocked destination may be snapped, in metres. */
  snapDistance?: number;
}

const DEFAULT_CELL = 0.2;
const DEFAULT_RADIUS = 0.26;
const DEFAULT_SNAP = 1.2;

/** The extent a set of obstacles covers, or null when there are none. */
export function navBoundsOf(boxes: readonly ObstacleBox[]): NavBounds | null {
  let minX = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const box of boxes) {
    if (!Number.isFinite(box.minX) || !Number.isFinite(box.maxX)) continue;
    if (!Number.isFinite(box.minZ) || !Number.isFinite(box.maxZ)) continue;
    if (box.minX < minX) minX = box.minX;
    if (box.minZ < minZ) minZ = box.minZ;
    if (box.maxX > maxX) maxX = box.maxX;
    if (box.maxZ > maxZ) maxZ = box.maxZ;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
  return { minX, minZ, maxX, maxZ };
}

/**
 * A binary heap of cell indices, keyed by f-score.
 *
 * Written out rather than pulled in because it is thirty lines, it is on the
 * hot path of every errand, and a dependency-free `packages/core`-style module
 * is this repository's habit.
 */
class CellHeap {
  private readonly items: number[] = [];
  private readonly keys: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, key: number): void {
    this.items.push(item);
    this.keys.push(key);
    let child = this.items.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if ((this.keys[parent] ?? 0) <= (this.keys[child] ?? 0)) break;
      this.swap(parent, child);
      child = parent;
    }
  }

  pop(): number | undefined {
    const top = this.items[0];
    if (top === undefined) return undefined;
    const lastItem = this.items.pop();
    const lastKey = this.keys.pop();
    if (this.items.length > 0 && lastItem !== undefined && lastKey !== undefined) {
      this.items[0] = lastItem;
      this.keys[0] = lastKey;
      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1;
        const right = left + 1;
        let smallest = parent;
        if (left < this.items.length && (this.keys[left] ?? 0) < (this.keys[smallest] ?? 0)) smallest = left;
        if (right < this.items.length && (this.keys[right] ?? 0) < (this.keys[smallest] ?? 0)) smallest = right;
        if (smallest === parent) break;
        this.swap(parent, smallest);
        parent = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const item = this.items[a];
    const key = this.keys[a];
    if (item === undefined || key === undefined) return;
    const otherItem = this.items[b] ?? 0;
    const otherKey = this.keys[b] ?? 0;
    this.items[a] = otherItem;
    this.keys[a] = otherKey;
    this.items[b] = item;
    this.keys[b] = key;
  }
}

/** An empty grid: every question about it is answered with "nowhere". */
function emptyGrid(bounds: NavBounds, cell: number): NavGrid {
  return {
    cell,
    cols: 0,
    rows: 0,
    bounds,
    walkableCells: 0,
    regions: 0,
    isWalkable: () => false,
    regionAt: () => -1,
    resolve: () => null,
    path: () => null,
    regionSpots: () => [],
  };
}

export function buildNavGrid(boxes: readonly ObstacleBox[], options: NavGridOptions = {}): NavGrid {
  const cell = options.cell !== undefined && options.cell > 0 ? options.cell : DEFAULT_CELL;
  const radius = options.radius ?? DEFAULT_RADIUS;
  const snap = options.snapDistance ?? DEFAULT_SNAP;
  const bounds = options.bounds ?? navBoundsOf(boxes);
  if (bounds === null) return emptyGrid({ minX: 0, minZ: 0, maxX: 0, maxZ: 0 }, cell);

  const spanX = bounds.maxX - bounds.minX;
  const spanZ = bounds.maxZ - bounds.minZ;
  if (!(spanX > 0) || !(spanZ > 0) || !Number.isFinite(spanX) || !Number.isFinite(spanZ)) {
    return emptyGrid(bounds, cell);
  }

  const cols = Math.max(1, Math.ceil(spanX / cell));
  const rows = Math.max(1, Math.ceil(spanZ / cell));
  const total = cols * rows;
  const blocked = new Uint8Array(total);

  const indexOf = (col: number, row: number): number => row * cols + col;
  const centreX = (col: number): number => bounds.minX + (col + 0.5) * cell;
  const centreZ = (row: number): number => bounds.minZ + (row + 0.5) * cell;

  // A cell is blocked when its centre is inside an obstacle's footprint grown by
  // the walker's radius. Testing centres rather than index ranges keeps the
  // inflation symmetric - an index range rounds outwards and quietly narrows
  // every doorway by up to a cell.
  for (const box of boxes) {
    if (!Number.isFinite(box.minX) || !Number.isFinite(box.maxX)) continue;
    if (!Number.isFinite(box.minZ) || !Number.isFinite(box.maxZ)) continue;
    const minCol = Math.max(0, Math.floor((box.minX - radius - bounds.minX) / cell));
    const maxCol = Math.min(cols - 1, Math.ceil((box.maxX + radius - bounds.minX) / cell));
    const minRow = Math.max(0, Math.floor((box.minZ - radius - bounds.minZ) / cell));
    const maxRow = Math.min(rows - 1, Math.ceil((box.maxZ + radius - bounds.minZ) / cell));
    for (let row = minRow; row <= maxRow; row += 1) {
      const z = centreZ(row);
      if (z < box.minZ - radius || z > box.maxZ + radius) continue;
      for (let col = minCol; col <= maxCol; col += 1) {
        const x = centreX(col);
        if (x < box.minX - radius || x > box.maxX + radius) continue;
        blocked[indexOf(col, row)] = 1;
      }
    }
  }

  // Connected pieces, so "can I get there from here" is one array read rather
  // than an A* search. Four-connected on purpose: two spaces that only touch at
  // a diagonal corner are not connected for a person with a radius.
  const region = new Int32Array(total).fill(-1);
  const stack: number[] = [];
  let regions = 0;
  let walkableCells = 0;
  for (let start = 0; start < total; start += 1) {
    if (blocked[start] === 1 || region[start] !== -1) continue;
    const id = regions;
    regions += 1;
    region[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      walkableCells += 1;
      const col = current % cols;
      const row = (current - col) / cols;
      const west = col > 0 ? current - 1 : -1;
      const east = col < cols - 1 ? current + 1 : -1;
      const north = row > 0 ? current - cols : -1;
      const south = row < rows - 1 ? current + cols : -1;
      for (const neighbour of [west, east, north, south]) {
        if (neighbour < 0 || blocked[neighbour] === 1 || region[neighbour] !== -1) continue;
        region[neighbour] = id;
        stack.push(neighbour);
      }
    }
  }

  if (walkableCells === 0) return emptyGrid(bounds, cell);

  const cellAt = (x: number, z: number): { col: number; row: number } => ({
    col: Math.floor((x - bounds.minX) / cell),
    row: Math.floor((z - bounds.minZ) / cell),
  });

  const inside = (col: number, row: number): boolean => col >= 0 && row >= 0 && col < cols && row < rows;

  const isFree = (col: number, row: number): boolean =>
    inside(col, row) && blocked[indexOf(col, row)] === 0;

  const isWalkable = (x: number, z: number): boolean => {
    const { col, row } = cellAt(x, z);
    return isFree(col, row);
  };

  const regionAt = (x: number, z: number): number => {
    const { col, row } = cellAt(x, z);
    if (!inside(col, row)) return -1;
    return region[indexOf(col, row)] ?? -1;
  };

  const pointOf = (index: number): Vec2 => {
    const col = index % cols;
    const row = (index - col) / cols;
    return { x: centreX(col), z: centreZ(row) };
  };

  const maxRings = Math.max(1, Math.ceil(snap / cell));

  const resolve = (x: number, z: number): Vec2 | null => {
    const { col, row } = cellAt(x, z);
    if (isFree(col, row)) return { x: centreX(col), z: centreZ(row) };
    for (let ring = 1; ring <= maxRings; ring += 1) {
      // Nearest by Euclidean distance within the ring, so the snap does not
      // depend on which corner of the search happens to be visited first.
      let best: Vec2 | null = null;
      let bestDistance = Infinity;
      for (let dc = -ring; dc <= ring; dc += 1) {
        for (let dr = -ring; dr <= ring; dr += 1) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== ring) continue;
          const c = col + dc;
          const r = row + dr;
          if (!isFree(c, r)) continue;
          const distance = (c - col) * (c - col) + (r - row) * (r - row);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = { x: centreX(c), z: centreZ(r) };
          }
        }
      }
      if (best) return best;
    }
    return null;
  };

  /**
   * Whether a straight line between two points stays on walkable floor.
   *
   * Sampled at half a cell, so a line cannot step over a blocked cell and claim
   * to be clear - which is what path smoothing and separation both rest on.
   */
  const lineWalkable = (a: Vec2, b: Vec2): boolean => {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / (cell * 0.5)));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      if (!isWalkable(a.x + dx * t, a.z + dz * t)) return false;
    }
    return true;
  };

  // Scratch buffers, kept on the grid: one A* at a time, and a search is a few
  // thousand cells. Reallocating three typed arrays per errand would be the most
  // expensive part of picking a destination.
  const gScore = new Float64Array(total);
  const cameFrom = new Int32Array(total);
  const closed = new Uint8Array(total);

  const path = (from: Vec2, to: Vec2): Vec2[] | null => {
    const startPoint = resolve(from.x, from.z);
    const endPoint = resolve(to.x, to.z);
    if (!startPoint || !endPoint) return null;
    const startCell = cellAt(startPoint.x, startPoint.z);
    const endCell = cellAt(endPoint.x, endPoint.z);
    const startIndex = indexOf(startCell.col, startCell.row);
    const endIndex = indexOf(endCell.col, endCell.row);
    if (startIndex === endIndex) return [endPoint];

    gScore.fill(Number.POSITIVE_INFINITY);
    cameFrom.fill(-1);
    closed.fill(0);
    gScore[startIndex] = 0;

    const endX = endPoint.x;
    const endZ = endPoint.z;
    /** Octile distance: the real cost of moving on an eight-way grid. */
    const heuristic = (index: number): number => {
      const col = index % cols;
      const row = (index - col) / cols;
      const dx = Math.abs(centreX(col) - endX);
      const dz = Math.abs(centreZ(row) - endZ);
      const diagonal = Math.min(dx, dz);
      return (dx + dz - diagonal) + diagonal * Math.SQRT2;
    };

    const open = new CellHeap();
    open.push(startIndex, heuristic(startIndex));
    let found = false;
    let guard = total * 4;

    while (open.size > 0 && guard > 0) {
      guard -= 1;
      const index = open.pop();
      if (index === undefined) break;
      if (index === endIndex) {
        found = true;
        break;
      }
      if (closed[index] === 1) continue;
      closed[index] = 1;
      const col = index % cols;
      const row = (index - col) / cols;
      const currentG = gScore[index] ?? Number.POSITIVE_INFINITY;

      for (let dc = -1; dc <= 1; dc += 1) {
        for (let dr = -1; dr <= 1; dr += 1) {
          if (dc === 0 && dr === 0) continue;
          const nc = col + dc;
          const nr = row + dr;
          if (!isFree(nc, nr)) continue;
          // No cutting a corner: a diagonal step needs both of its orthogonal
          // neighbours open, or a walker would slip through a gap it cannot fit.
          if (dc !== 0 && dr !== 0 && (!isFree(col + dc, row) || !isFree(col, row + dr))) continue;
          const next = indexOf(nc, nr);
          if (closed[next] === 1) continue;
          const step = dc !== 0 && dr !== 0 ? Math.SQRT2 : 1;
          const tentative = currentG + step;
          if (tentative >= (gScore[next] ?? Number.POSITIVE_INFINITY)) continue;
          gScore[next] = tentative;
          cameFrom[next] = index;
          open.push(next, tentative + heuristic(next));
        }
      }
    }

    if (!found) return null;

    const cells: number[] = [];
    let cursor = endIndex;
    let hops = 0;
    while (cursor !== -1 && hops <= total) {
      cells.push(cursor);
      if (cursor === startIndex) break;
      cursor = cameFrom[cursor] ?? -1;
      hops += 1;
    }
    if (cells[cells.length - 1] !== startIndex) return null;
    cells.reverse();

    // String pulling. A grid path is a staircase; a person is not. Every point
    // that a straight line from the last kept point can see past is dropped.
    const route: Vec2[] = [];
    let anchor = 0;
    while (anchor < cells.length - 1) {
      let next = anchor + 1;
      for (let probe = cells.length - 1; probe > anchor + 1; probe -= 1) {
        const candidate = cells[probe];
        const fromAnchor = cells[anchor];
        if (candidate === undefined || fromAnchor === undefined) continue;
        if (lineWalkable(pointOf(fromAnchor), pointOf(candidate))) {
          next = probe;
          break;
        }
      }
      const index = cells[anchor];
      if (index !== undefined) route.push(pointOf(index));
      anchor = next;
    }
    const last = cells[cells.length - 1];
    if (last !== undefined) route.push(pointOf(last));

    // The caller asked to end at a particular spot, and the grid answers in cell
    // centres. When the real destination is walkable the last half-cell of drift
    // is removed, so somebody going back to their chair sits in the chair.
    const final = route[route.length - 1];
    if (final !== undefined && isWalkable(to.x, to.z) && lineWalkable(final, to)) {
      route[route.length - 1] = { x: to.x, z: to.z };
    }
    return route;
  };

  const regionSpots = (id: number): Vec2[] => {
    if (id < 0) return [];
    let minCol = cols;
    let maxCol = -1;
    let minRow = rows;
    let maxRow = -1;
    let sumX = 0;
    let sumZ = 0;
    let count = 0;
    for (let index = 0; index < total; index += 1) {
      if (region[index] !== id) continue;
      const col = index % cols;
      const row = (index - col) / cols;
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
      sumX += centreX(col);
      sumZ += centreZ(row);
      count += 1;
    }
    if (count === 0) return [];

    const middle: Vec2 = { x: sumX / count, z: sumZ / count };
    const extremes: Vec2[] = [
      { x: centreX(minCol), z: centreZ(minRow) },
      { x: centreX(maxCol), z: centreZ(minRow) },
      { x: centreX(minCol), z: centreZ(maxRow) },
      { x: centreX(maxCol), z: centreZ(maxRow) },
      { x: middle.x, z: centreZ(minRow) },
      { x: middle.x, z: centreZ(maxRow) },
      { x: centreX(minCol), z: middle.z },
      { x: centreX(maxCol), z: middle.z },
    ];

    // Snapped, deduplicated and thinned: a corner that is half a metre from the
    // middle of a tiny room is not a second place to stand.
    const spots: Vec2[] = [];
    const consider = (point: Vec2): void => {
      const snapped = resolve(point.x, point.z);
      if (!snapped) return;
      for (const existing of spots) {
        if (Math.hypot(existing.x - snapped.x, existing.z - snapped.z) < 1.1) return;
      }
      spots.push(snapped);
    };
    consider(middle);
    for (const extreme of extremes) consider(extreme);
    if (spots.length === 0) spots.push(resolve(middle.x, middle.z) ?? middle);
    return spots;
  };

  return {
    cell,
    cols,
    rows,
    bounds,
    walkableCells,
    regions,
    isWalkable,
    regionAt,
    resolve,
    path,
    regionSpots,
  };
}
