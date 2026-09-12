/**
 * Inspect a .glb without any dependencies.
 *
 * Reads the 12-byte header, walks the chunk table, and prints the JSON chunk's
 * node/mesh/material summary. Used to verify the Blender export actually
 * carries the `Seat_*` / `Anchor_Room_*` node names the office UI depends on.
 *
 *   node scripts/inspect-glb.mjs apps/web/public/office/office.glb
 */

import { readFileSync, statSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/inspect-glb.mjs <file.glb>');
  process.exit(2);
}

const buf = readFileSync(path);
const magic = buf.readUInt32LE(0);
if (magic !== 0x46546c67) {
  console.error(`not a GLB (magic=0x${magic.toString(16)})`);
  process.exit(1);
}

const version = buf.readUInt32LE(4);
const total = buf.readUInt32LE(8);

// Walk chunks: [length u32][type u32][data...]
let offset = 12;
let json = null;
let binBytes = 0;
while (offset + 8 <= buf.length) {
  const len = buf.readUInt32LE(offset);
  const type = buf.readUInt32LE(offset + 4);
  const start = offset + 8;
  if (type === 0x4e4f534a) json = JSON.parse(buf.subarray(start, start + len).toString('utf8'));
  else if (type === 0x004e4942) binBytes = len;
  offset = start + len + ((4 - (len % 4)) % 4);
}

if (!json) {
  console.error('no JSON chunk found');
  process.exit(1);
}

const nodes = json.nodes ?? [];
const nodeNames = nodes.map((n) => n.name ?? '(unnamed)');
const seats = nodeNames.filter((n) => n.startsWith('Seat_')).sort();
const rooms = nodeNames.filter((n) => n.startsWith('Anchor_Room_')).sort();
const desks = nodeNames.filter((n) => n.startsWith('Desk_')).sort();

const stat = statSync(path);
console.log(`file            : ${path}`);
console.log(`bytes           : ${stat.size.toLocaleString()}`);
console.log(`glb version     : ${version}  (declared length ${total})`);
console.log(`bin chunk bytes : ${binBytes.toLocaleString()}`);
console.log(`generator       : ${json.asset?.generator ?? '?'}`);
console.log(`scenes/nodes    : ${(json.scenes ?? []).length} / ${nodes.length}`);
console.log(`meshes          : ${(json.meshes ?? []).length}`);
console.log(`materials       : ${(json.materials ?? []).length}`);
console.log(`seat anchors    : ${seats.length}`);
console.log(`room anchors    : ${rooms.length}`);
console.log(`desk roots      : ${desks.length}`);
console.log('');
console.log('seats  :', seats.join(', ') || '(none)');
console.log('rooms  :', rooms.join(', ') || '(none)');

const missing = [];
if (seats.length === 0) missing.push('Seat_* nodes');
if (rooms.length === 0) missing.push('Anchor_Room_* nodes');
if ((json.materials ?? []).length === 0) missing.push('materials');
if (missing.length) {
  console.error(`\nFAIL: missing ${missing.join(', ')}`);
  process.exit(1);
}
console.log('\nOK: office.glb carries every anchor the UI needs.');
