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
    describe() {
      return `${seats.size} seats · ${rooms.size} rooms · ${desks.size} desks · ${meshes} meshes`;
    },
  };
}
