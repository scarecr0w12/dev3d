/**
 * Floor-layout tests.
 *
 * The geometry here decides whether a generated building looks like a building.
 * A rotation convention that is off by 90 degrees produces rooms hanging off the
 * corner of the office, which is the kind of bug that is obvious in a viewport
 * and invisible in a type signature - so the conventions are pinned by test
 * rather than by looking.
 *
 * The kit is built inline instead of read from `blocks.json`, so the tests
 * describe the *rules* and do not silently change when the art does.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { BlockKit, FloorLayout, OfficeBlockKind } from '@dev3d/core';

import {
  capacityOf,
  describeLayout,
  grow,
  oppositeEdge,
  placementFor,
  rotatedEdgeNormal,
  seatIdsFor,
  shrink,
} from './layout.ts';

const POD: OfficeBlockKind = {
  id: 'pod4',
  name: 'Open pod',
  kind: 'open',
  width: 8,
  depth: 6,
  doors: ['w', 'e'],
  seats: ['Seat_POD4_01', 'Seat_POD4_02', 'Seat_POD4_03', 'Seat_POD4_04'],
};

const OFFICE: OfficeBlockKind = {
  id: 'office2',
  name: 'Private office',
  kind: 'room',
  width: 8,
  depth: 6,
  doors: ['w'],
  seats: ['Seat_OFFICE2_01', 'Seat_OFFICE2_02'],
};

const JUNCTION: OfficeBlockKind = {
  id: 'junction',
  name: 'Junction',
  kind: 'junction',
  width: 6,
  depth: 6,
  doors: ['n', 'e', 's', 'w'],
  seats: [],
};

const MEETING: OfficeBlockKind = {
  id: 'meeting6',
  name: 'Meeting room',
  kind: 'meeting',
  width: 8,
  depth: 6,
  doors: ['w'],
  seats: ['Seat_MEETING6_01', 'Seat_MEETING6_02', 'Seat_MEETING6_03'],
};

const LOUNGE: OfficeBlockKind = {
  id: 'lounge3',
  name: 'Lounge',
  kind: 'lounge',
  width: 8,
  depth: 6,
  doors: ['w', 'e'],
  seats: ['Seat_LOUNGE3_01', 'Seat_LOUNGE3_02'],
};

const PORTAL: OfficeBlockKind = {
  id: 'portal',
  name: 'Doorway',
  kind: 'portal',
  width: 1.9,
  depth: 0.5,
  doors: [],
  seats: [],
  fitting: true,
};

/** A 22 x 16 core with the four ports the shipped kit publishes. */
function kit(blocks: OfficeBlockKind[] = [POD, OFFICE, MEETING, LOUNGE, JUNCTION, PORTAL]): BlockKit {
  return {
    version: 1,
    cell: 6,
    core: {
      model: 'office.glb',
      width: 22,
      depth: 16,
      ports: [
        { id: 'core_e1', x: 11, z: -4, dir: 'e' },
        { id: 'core_e2', x: 11, z: 4, dir: 'e' },
        { id: 'core_w1', x: -11, z: -4, dir: 'w' },
        { id: 'core_w2', x: -11, z: 4, dir: 'w' },
      ],
    },
    blocks,
  };
}

const EMPTY: FloorLayout = { blocks: [] };

test('oppositeEdge is its own inverse', () => {
  for (const edge of ['n', 'e', 's', 'w'] as const) {
    assert.equal(oppositeEdge(oppositeEdge(edge)), edge);
    assert.notEqual(oppositeEdge(edge), edge);
  }
});

test('rotatedEdgeNormal turns edges the way three.js turns geometry', () => {
  // At zero rotation nothing moves: this is the identity the whole jigsaw rests on.
  for (const edge of ['n', 'e', 's', 'w'] as const) {
    assert.equal(rotatedEdgeNormal(edge, 0), edge);
  }
  // A quarter turn clockwise from above sends north to west and east to north.
  assert.equal(rotatedEdgeNormal('n', 90), 'w');
  assert.equal(rotatedEdgeNormal('e', 90), 'n');
  assert.equal(rotatedEdgeNormal('s', 90), 'e');
  assert.equal(rotatedEdgeNormal('w', 90), 's');
  // Half a turn swaps every wall for its opposite.
  for (const edge of ['n', 'e', 's', 'w'] as const) {
    assert.equal(rotatedEdgeNormal(edge, 180), oppositeEdge(edge));
  }
  assert.equal(rotatedEdgeNormal('n', 270), 'e');
  assert.equal(rotatedEdgeNormal(edge360(), 360), 'n');
});

function edge360(): 'n' {
  return 'n';
}

test('a module is only placed where it has a doorway facing the port', () => {
  // A pod has doors on w and e, so it can meet a port from either side.
  const east = placementFor(POD, { x: 11, z: -4, dir: 'e' });
  assert.ok(east, 'a pod should attach to an east-facing wall');
  // Its west door faces the wall, so it sits east of the port.
  assert.equal(east?.entryEdge, 'w');
  assert.equal(east?.rotation, 0);
  assert.equal(east?.x, 11 + POD.width / 2, 'the module is flush against the wall, not on it');
  assert.equal(east?.z, -4);

  // The private office has only a west door, so a west-facing wall is reached by
  // turning it half about: the same door then faces back at the parent.
  const westOffice = placementFor(OFFICE, { x: -11, z: -4, dir: 'w' });
  assert.ok(westOffice, 'a single-door room can still meet a wall from either side');
  assert.equal(westOffice?.entryEdge, 'w');
  assert.equal(westOffice?.rotation, 180);
  assert.equal(westOffice?.x, -11 - OFFICE.width / 2);

  // A fitting has no doorways at all, so nothing can ever connect it.
  assert.equal(placementFor(PORTAL, { x: 11, z: -4, dir: 'e' }), null);

  // North and south ports turn the module a quarter turn.
  const north = placementFor(JUNCTION, { x: 0, z: -8, dir: 'n' });
  assert.ok(north);
  assert.equal(north?.rotation, 0, 'a junction has all four doors, so it never needs turning');
  assert.equal(north?.z, -8 - JUNCTION.depth / 2);
});

test('a fitting is never chosen as a room', () => {
  const kitWithOnlyFitting = kit([PORTAL]);
  const result = grow(kitWithOnlyFitting, EMPTY, 21, 40);
  assert.deepEqual(result.added, []);
  assert.equal(result.exhausted, true);
  assert.match(result.problem?.message ?? '', /no rooms/);
});

test('growth fills the four core walls before going any further', () => {
  // 21 core seats; asking for 33 has to add modules until it can seat them all.
  const result = grow(kit(), EMPTY, 21, 33);
  assert.ok(result.added.length >= 3, `expected at least three modules, got ${result.added.length}`);
  assert.equal(result.exhausted, false);
  assert.ok(capacityOf(kit(), result.layout, 21) >= 33, 'the floor must reach the target');

  // Every module is attached to a real port and sits outside the core.
  for (const block of result.added) {
    assert.ok(block.attachedTo.length > 0, `${block.id} has no port`);
    const outsideX = Math.abs(block.x) > 11;
    const outsideZ = Math.abs(block.z) > 8;
    assert.ok(outsideX || outsideZ, `${block.id} at ${block.x},${block.z} is inside the core`);
  }
  // The first module of each kind to be placed goes on a core port, because the
  // core's walls are the frontier's head.
  assert.ok(
    result.added.slice(0, 4).every((block) => block.attachedTo.startsWith('core_')),
    result.added.map((block) => block.attachedTo).join(', '),
  );
});

test('the building is a mix of module kinds, not a row of the same one', () => {
  const result = grow(kit(), EMPTY, 21, 200, 24);
  const kinds = new Set(result.layout.blocks.map((block) => block.kind));
  assert.ok(kinds.size >= 4, `only ${kinds.size} module kind(s) used: ${[...kinds].join(', ')}`);
  // A junction seats nobody, but without one the building cannot branch: a room
  // with a single doorway is a dead end, and a run of them stops growth dead.
  assert.ok(kinds.has('junction'), 'a building long enough to need corners should contain one');
  assert.ok(result.layout.blocks.length > 10, `growth stalled at ${result.layout.blocks.length} modules`);
});

test('no two modules overlap, however far the floor grows', () => {
  // Ask for a building far larger than the core walls can carry, so growth has
  // to work through several generations of the frontier.
  const result = grow(kit(), EMPTY, 21, 200, 40);
  assert.ok(result.added.length > 8, `expected a real building, got ${result.added.length} modules`);

  const byId = new Map(kit().blocks.map((block) => [block.id, block]));
  const boxes = result.layout.blocks.map((placed) => {
    const kind = byId.get(placed.kind);
    assert.ok(kind);
    const swapped = placed.rotation === 90 || placed.rotation === 270;
    const halfW = (swapped ? kind.depth : kind.width) / 2;
    const halfD = (swapped ? kind.width : kind.depth) / 2;
    return {
      id: placed.id,
      minX: placed.x - halfW,
      maxX: placed.x + halfW,
      minZ: placed.z - halfD,
      maxZ: placed.z + halfD,
    };
  });

  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (!a || !b) continue;
      const separated =
        a.maxX <= b.minX + 0.01 ||
        a.minX >= b.maxX - 0.01 ||
        a.maxZ <= b.minZ + 0.01 ||
        a.minZ >= b.maxZ - 0.01;
      assert.ok(separated, `${a.id} overlaps ${b.id}`);
    }
  }

  // And nothing ends up inside the core either.
  for (const box of boxes) {
    const insideCore = box.minX > -11 && box.maxX < 11 && box.minZ > -8 && box.maxZ < 8;
    assert.ok(!insideCore, `${box.id} is inside the core`);
  }
});

test('growth is deterministic: the same floor always grows the same way', () => {
  const first = grow(kit(), EMPTY, 21, 120, 20);
  const second = grow(kit(), EMPTY, 21, 120, 20);
  assert.deepEqual(
    first.layout.blocks.map((block) => `${block.id}:${block.kind}@${block.x},${block.z}r${block.rotation}`),
    second.layout.blocks.map((block) => `${block.id}:${block.kind}@${block.x},${block.z}r${block.rotation}`),
  );
});

test('a floor that already has enough desks is left alone', () => {
  const result = grow(kit(), EMPTY, 21, 21);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.layout.blocks, []);
  assert.equal(result.exhausted, false);
});

test('growth continues from modules already placed, and stops when told to', () => {
  const grown = grow(kit(), EMPTY, 21, 200, 40);
  // A later round starts from the existing building rather than over again.
  const again = grow(kit(), grown.layout, 21, 400, 40);
  assert.deepEqual(again.added, [], 'the module ceiling was already reached');
  assert.equal(again.exhausted, true);

  // Raising the ceiling extends the same building, keeping the old modules.
  const extended = grow(kit(), grown.layout, 21, 200, 60);
  for (const block of grown.layout.blocks) {
    assert.ok(
      extended.layout.blocks.some((candidate) => candidate.id === block.id && candidate.x === block.x),
      `${block.id} was lost when the building was extended`,
    );
  }
  assert.ok(
    extended.layout.blocks.length >= grown.layout.blocks.length,
    `extending shrank the building: ${grown.layout.blocks.length} -> ${extended.layout.blocks.length}`,
  );
});

test('instance ids stay unique across rounds, so no seat id can collide', () => {
  const first = grow(kit(), EMPTY, 21, 41, 5);
  const second = grow(kit(), first.layout, 21, 60, 10);
  const ids = second.layout.blocks.map((block) => block.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate instance ids: ${ids.join(', ')}`);

  const seats = seatIdsFor(kit(), second.layout, ['Seat_Dev_01']);
  assert.equal(new Set(seats).size, seats.length, 'two modules claimed the same seat');
  assert.ok(seats.includes('Seat_Dev_01'), 'the core seats must survive generation');
  assert.ok(seats.some((seat) => seat.includes('::')));
});

test('shrinking removes the newest module, and never orphans one', () => {
  const grown = grow(kit(), EMPTY, 21, 200, 12);
  assert.ok(grown.layout.blocks.length >= 3);
  const last = grown.layout.blocks[grown.layout.blocks.length - 1];
  const removed = shrink(kit(), grown.layout, 21);
  assert.equal(removed.removed?.id, last?.id);
  assert.equal(removed.layout.blocks.length, grown.layout.blocks.length - 1);
  // Nothing still points at the module that just left.
  for (const block of removed.layout.blocks) {
    assert.notEqual(block.attachedTo, last?.id);
  }

  // The core itself cannot be removed, only the modules on it.
  let empty = grown.layout;
  for (let i = 0; i < 40; i += 1) empty = shrink(kit(), empty, 21).layout;
  assert.deepEqual(empty.blocks, []);
  assert.equal(shrink(kit(), empty, 21).removed, null);
  assert.equal(capacityOf(kit(), empty, 21), 21);
});

test('seat ids name the module they belong to, and core seats are untouched', () => {
  const layout: FloorLayout = {
    blocks: [{ id: 'B1', kind: 'pod4', x: 15, z: -4, rotation: 0, attachedTo: 'core_e1' }],
  };
  const seats = seatIdsFor(kit(), layout, ['Seat_Dev_01', 'Seat_CEO']);
  assert.deepEqual(seats, [
    'Seat_Dev_01',
    'Seat_CEO',
    'B1::Seat_POD4_01',
    'B1::Seat_POD4_02',
    'B1::Seat_POD4_03',
    'B1::Seat_POD4_04',
  ]);
  assert.equal(capacityOf(kit(), layout, 21), 25);
  assert.match(describeLayout(kit(), layout), /core \+ 1 room/);
  assert.equal(describeLayout(kit(), EMPTY), 'core only');
});
