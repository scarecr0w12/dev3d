/**
 * Anchor lookup for the office model.
 *
 * The GLB carries named empty nodes - `Seat_*`, `Anchor_Room_*`, `Desk_*` - and
 * the org chart refers to people by those exact names. Nothing in this UI
 * hard-codes a coordinate: an avatar is placed by looking its seat name up in
 * the loaded scene.
 *
 * Missing names must never crash the office. Every failed lookup is recorded,
 * logged exactly once, and answered with a sensible fallback so a hot-desking
 * employee (or an org chart edited by hand) still ends up standing somewhere
 * reasonable.
 */

import * as THREE from 'three';

export type AnchorKind = 'seat' | 'room' | 'desk';

export interface AnchorStats {
  seats: number;
  rooms: number;
  desks: number;
  meshes: number;
  materials: number;
  /** Anchor names that appeared more than once; the first node wins. */
  duplicateNames: string[];
}

export interface OfficeAnchors {
  readonly seats: string[];
  readonly rooms: string[];
  readonly desks: string[];
  readonly stats: AnchorStats;
  /** Names the org asked for that the model does not carry. */
  readonly missing: string[];
  getSeat(name: string | null | undefined): THREE.Object3D | null;
  getRoom(name: string | null | undefined): THREE.Object3D | null;
  getDesk(name: string | null | undefined): THREE.Object3D | null;
  worldPosition(node: THREE.Object3D | null | undefined): THREE.Vector3 | null;
  seatPosition(name: string | null | undefined): THREE.Vector3 | null;
  roomPosition(name: string | null | undefined): THREE.Vector3 | null;
  deskPosition(name: string | null | undefined): THREE.Vector3 | null;
  /** Yaw that turns an avatar's face (+Z) toward its desk, room, or the room exit. */
  seatFacing(seatName: string | null | undefined, roomName: string | null | undefined): number;
  /** Where an employee with no seat stands: a row of bench desks by the dev floor. */
  hotDeskPosition(index: number): THREE.Vector3;
  /**
   * Where a third-party vendor's terminal stands.
   *
   * A vendor is not given a `Seat_*`: those belong to the org chart, and a
   * vendor has no place on it. It docks instead, in a room the floor either grew
   * for the purpose or already had. See the implementation for the ordering and
   * why it is that order.
   */
  vendorBayPosition(index: number): THREE.Vector3;
  /** The yaw a docked terminal faces, so a row faces into its room. */
  vendorBayFacing(): number;
  /** Where the bay is, in words, for the HUD and the console. */
  vendorBayLabel(): string;
  /** True when this floor has a grown rack room for the bay to sit in. */
  hasServerRoom(): boolean;
  describe(): string;
}

const SEAT_PREFIX = 'Seat_';
const ROOM_PREFIX = 'Anchor_Room_';
const DESK_PREFIX = 'Desk_';

/**
 * A grown module's nodes are namespaced by instance: `B1::Seat_POD4_02`. Two pods
 * both contain a `Seat_POD4_02`, so without the prefix the second one to load
 * would be a duplicate and the first would win - and an employee would be seated
 * in the wrong room.
 */
const INSTANCE_SEPARATOR = '::';

const warned = new Set<string>();

/** The node name with any instance prefix removed. */
function bareName(name: string): string {
  const at = name.indexOf(INSTANCE_SEPARATOR);
  return at === -1 ? name : name.slice(at + INSTANCE_SEPARATOR.length);
}

/** The instance prefix, including the separator, or an empty string. */
function instancePrefix(name: string): string {
  const at = name.indexOf(INSTANCE_SEPARATOR);
  return at === -1 ? '' : name.slice(0, at + INSTANCE_SEPARATOR.length);
}

export function anchorKindOf(name: string): AnchorKind | null {
  const bare = bareName(name);
  if (bare.startsWith(SEAT_PREFIX)) return 'seat';
  if (bare.startsWith(ROOM_PREFIX)) return 'room';
  if (bare.startsWith(DESK_PREFIX)) return 'desk';
  return null;
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[dev3d office] ${message}`);
}

/**
 * `Seat_Dev_01` -> `Desk_Dev_01`, and `B1::Seat_POD4_02` -> `B1::Desk_POD4_02`.
 *
 * The instance prefix is carried across, or a seat in a grown module would look
 * for a desk in the core office and never find one.
 */
export function deskNameForSeat(seatName: string): string {
  const prefix = instancePrefix(seatName);
  const bare = bareName(seatName);
  const desk = bare.startsWith(SEAT_PREFIX) ? `${DESK_PREFIX}${bare.slice(SEAT_PREFIX.length)}` : `${DESK_PREFIX}${bare}`;
  return `${prefix}${desk}`;
}

export function roomLabel(roomId: string | null | undefined): string {
  if (!roomId) return 'bench';
  const bare = bareName(roomId);
  return bare.startsWith(ROOM_PREFIX) ? bare.slice(ROOM_PREFIX.length) : bare;
}

export function indexAnchors(root: THREE.Object3D): OfficeAnchors {
  root.updateMatrixWorld(true);

  const seats = new Map<string, THREE.Object3D>();
  const rooms = new Map<string, THREE.Object3D>();
  const desks = new Map<string, THREE.Object3D>();
  const duplicates = new Set<string>();
  const materials = new Set<string>();
  let meshes = 0;

  const store = (map: Map<string, THREE.Object3D>, name: string, object: THREE.Object3D): void => {
    if (map.has(name)) {
      duplicates.add(name);
      return;
    }
    map.set(name, object);
  };

  root.traverse((object) => {
    const name = object.name;
    if (name.length > 0) {
      const kind = anchorKindOf(name);
      if (kind === 'seat') store(seats, name, object);
      else if (kind === 'room') store(rooms, name, object);
      else if (kind === 'desk') store(desks, name, object);
    }
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) {
      meshes += 1;
      const material = mesh.material;
      if (Array.isArray(material)) {
        for (const entry of material) materials.add(entry.uuid);
      } else if (material) {
        materials.add(material.uuid);
      }
    }
  });

  const missing = new Set<string>();

  const lookup = (map: Map<string, THREE.Object3D>, kind: AnchorKind, name: string | null | undefined): THREE.Object3D | null => {
    if (!name) return null;
    const found = map.get(name);
    if (found) return found;
    missing.add(name);
    warnOnce(`${kind}:${name}`, `${kind} anchor "${name}" is not in the office model; using a fallback position`);
    return null;
  };

  const worldPosition = (node: THREE.Object3D | null | undefined): THREE.Vector3 | null => {
    if (!node) return null;
    return node.getWorldPosition(new THREE.Vector3());
  };

  /** Silent lookup: used for probes that must not be reported as missing. */
  const peek = (map: Map<string, THREE.Object3D>, name: string | null | undefined): THREE.Vector3 | null =>
    name ? worldPosition(map.get(name) ?? null) : null;

  const roomPosition = (name: string | null | undefined): THREE.Vector3 | null => worldPosition(lookup(rooms, 'room', name));
  const deskPosition = (name: string | null | undefined): THREE.Vector3 | null => worldPosition(lookup(desks, 'desk', name));
  const seatPosition = (name: string | null | undefined): THREE.Vector3 | null => worldPosition(lookup(seats, 'seat', name));

  /** Where the bench row sits when nobody has a desk. */
  const benchOrigin = (): THREE.Vector3 => {
    const devFloor = worldPosition(rooms.get('Anchor_Room_DevFloor') ?? null);
    if (devFloor) return devFloor;
    const lobby = worldPosition(rooms.get('Anchor_Room_Lobby') ?? null);
    if (lobby) return lobby;
    return new THREE.Vector3(0, 0, 0);
  };

  /**
   * A room anchor looked up by its *bare* name, ignoring any instance prefix.
   *
   * Needed because the two rooms a vendor bay can use are reached differently.
   * `Anchor_Room_Lobby` is in the core and has no prefix, but a rack room is a
   * grown module and therefore arrives as `B1::Anchor_Room_SERVER4`. Looking
   * that up by exact name would work on one floor and silently fail on the next,
   * depending on which module instance happened to be built first.
   */
  const roomByBareName = (bare: string): THREE.Object3D | null => {
    for (const [name, object] of rooms) {
      if (bareName(name) === bare) return object;
    }
    return null;
  };

  /**
   * The rack room, when the floor has grown one.
   *
   * **Why the bay prefers it, and what happens when there is none.** A vendor is
   * external compute that the office has plugged in, and `server4` is the only
   * module in the kit whose furniture (`racks`) implies machinery rather than
   * people - so it is where a bank of terminals belongs, and it is the one room
   * whose single seat means housing them there never competes with the roster.
   *
   * Not every floor has one: modules are grown on demand, least-used-first, so a
   * small team may never build a server room at all. Falling back to the core's
   * **reception** is the right degradation rather than a compromise - a
   * contractor with nowhere to work waits in the lobby - and it is why this is a
   * preference order rather than a required anchor. A floor with neither (a
   * hand-edited model, or a kit that failed to load) still gets a bay at the
   * bench origin, because a vendor the office is paying for must be visible
   * somewhere rather than silently at the world origin.
   */
  const serverRoom = (): THREE.Vector3 | null => worldPosition(roomByBareName('Anchor_Room_SERVER4'));
  /** The core's reception: where a vendor waits when there is no rack room. */
  const lobby = (): THREE.Vector3 | null => worldPosition(roomByBareName('Anchor_Room_Lobby'));

  return {
    seats: [...seats.keys()].sort(),
    rooms: [...rooms.keys()].sort(),
    desks: [...desks.keys()].sort(),
    stats: {
      seats: seats.size,
      rooms: rooms.size,
      desks: desks.size,
      meshes,
      materials: materials.size,
      duplicateNames: [...duplicates].sort(),
    },
    get missing(): string[] {
      return [...missing].sort();
    },
    getSeat: (name) => lookup(seats, 'seat', name),
    getRoom: (name) => lookup(rooms, 'room', name),
    getDesk: (name) => lookup(desks, 'desk', name),
    worldPosition,
    seatPosition,
    roomPosition,
    deskPosition,
    seatFacing(seatName, roomName) {
      const seat = seatPosition(seatName);
      if (!seat) return 0;
      // Not every seat has a desk (meeting chairs and the bench do not), so this
      // probe stays silent and simply falls through to the room anchor.
      const desk = peek(desks, seatName ? deskNameForSeat(seatName) : null);
      const target = desk ?? peek(rooms, roomName);
      if (!target) return 0;
      const dx = target.x - seat.x;
      const dz = target.z - seat.z;
      if (Math.abs(dx) < 0.0001 && Math.abs(dz) < 0.0001) return 0;
      return Math.atan2(dx, dz);
    },
    hotDeskPosition(index) {
      const origin = benchOrigin();
      const column = ((index % 4) + 4) % 4;
      const row = Math.max(0, Math.floor(index / 4));
      // Two rows of four, just off the dev floor anchor, so bench staff are
      // clearly in the office but visibly not at a named seat.
      return new THREE.Vector3(origin.x - 1.9 + column * 1.25, origin.y, origin.z + 1.7 + row * 1.2);
    },
    hasServerRoom: () => serverRoom() !== null,
    vendorBayPosition(index) {
      const origin = serverRoom() ?? lobby() ?? benchOrigin();
      const column = ((index % 3) + 3) % 3;
      const row = Math.max(0, Math.floor(index / 3));
      // Three to a row, offset from the room's own anchor along +Z and then
      // stacked backwards. Deliberately a *different* row shape from the
      // hot-desk bench: four abreast with wider spacing reads as desks for
      // people, and three slightly tighter reads as a bank of machines.
      return new THREE.Vector3(origin.x - 1.5 + column * 1.5, origin.y, origin.z + 1.4 + row * 1.5);
    },
    vendorBayFacing() {
      const origin = serverRoom() ?? lobby() ?? benchOrigin();
      const first = this.vendorBayPosition(0);
      // Face back toward the room's anchor, so a row of terminals addresses the
      // space it is in rather than staring at a wall.
      const dx = origin.x - first.x;
      const dz = origin.z - first.z;
      if (Math.abs(dx) < 0.0001 && Math.abs(dz) < 0.0001) return 0;
      return Math.atan2(dx, dz);
    },
    vendorBayLabel() {
      if (serverRoom() !== null) return 'the server room';
      if (lobby() !== null) return 'reception';
      return 'the bench';
    },
    describe() {
      return `${seats.size} seats · ${rooms.size} rooms · ${desks.size} desks · ${meshes} meshes`;
    },
  };
}
