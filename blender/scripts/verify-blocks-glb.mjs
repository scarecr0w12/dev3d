// Verify blocks.glb against blocks.json: every kit's real bounding box must sit
// inside the size it declares, and every seat/desk anchor must be inside it too.
// Run: node blender/scripts/verify-blocks-glb.mjs
import { readFileSync } from 'node:fs';

const GLB = 'apps/web/public/office/blocks.glb';
const JSON_PATH = 'apps/web/public/office/blocks.json';

function gltfJson(path) {
  const b = readFileSync(path);
  let off = 12;
  while (off + 8 <= b.length) {
    const len = b.readUInt32LE(off);
    const type = b.readUInt32LE(off + 4);
    const start = off + 8;
    if (type === 0x4e4f534a) return JSON.parse(b.subarray(start, start + len).toString('utf8'));
    off = start + len + ((4 - (len % 4)) % 4);
  }
  throw new Error(`no JSON chunk in ${path}`);
}

const gltf = gltfJson(GLB);
const doc = JSON.parse(readFileSync(JSON_PATH, 'utf8'));

const nodes = gltf.nodes ?? [];
const byName = new Map(nodes.map((n) => [n.name, n]));

/** World translation of a node, following parents (the kit is only 2 deep). */
const parentOf = new Map();
nodes.forEach((node, index) => {
  for (const child of node.children ?? []) parentOf.set(child, index);
});
function worldOf(index) {
  const chain = [];
  for (let at = index; at !== undefined; at = parentOf.get(at)) chain.unshift(at);
  let x = 0;
  let y = 0;
  let z = 0;
  for (const at of chain) {
    const t = nodes[at].translation ?? [0, 0, 0];
    x += t[0];
    y += t[1];
    z += t[2];
  }
  return [x, y, z];
}

const problems = [];
let checked = 0;

for (const block of doc.blocks) {
  const root = byName.get(block.node);
  if (!root) {
    problems.push(`${block.id}: no node named ${block.node} in the GLB`);
    continue;
  }
  const rootIndex = nodes.indexOf(root);
  const halfW = block.width / 2;
  const halfD = block.depth / 2 + 0.2; // the slab overhangs by 0.15 m
  const box = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, maxY: -Infinity };

  const walk = (index) => {
    const node = nodes[index];
    const [x, y, z] = worldOf(index);
    if (node.mesh !== undefined) {
      // glTF is Y-up: browser x = gltf x, browser z = gltf z, ceiling = gltf y.
      box.minX = Math.min(box.minX, x);
      box.maxX = Math.max(box.maxX, x);
      box.minZ = Math.min(box.minZ, z);
      box.maxZ = Math.max(box.maxZ, z);
      box.maxY = Math.max(box.maxY, y);
    }
    if (node.name?.startsWith('Seat_') || node.name?.startsWith('Desk_')) {
      if (Math.abs(x) > halfW + 0.01 || Math.abs(z) > halfD + 0.01) {
        problems.push(`${block.id}: ${node.name} at (${x.toFixed(2)}, ${z.toFixed(2)}) is outside the ${block.width}x${block.depth} module`);
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(rootIndex);

  checked += 1;
  // Mesh *origins* only, so this is a conservative floor on the real extent: if
  // an origin is already outside, the part certainly is.
  if (box.minX < -halfW - 0.01 || box.maxX > halfW + 0.01) {
    problems.push(`${block.id}: a mesh origin sits at x ${box.minX.toFixed(2)}..${box.maxX.toFixed(2)}, beyond +-${halfW}`);
  }
  if (box.minZ < -halfD - 0.01 || box.maxZ > halfD + 0.01) {
    problems.push(`${block.id}: a mesh origin sits at z ${box.minZ.toFixed(2)}..${box.maxZ.toFixed(2)}, beyond +-${halfD.toFixed(2)}`);
  }
  if (box.maxY > 3.05) {
    problems.push(`${block.id}: a part reaches y ${box.maxY.toFixed(2)}, above the 3 m wall`);
  }
}

const seats = nodes.filter((n) => n.name?.startsWith('Seat_')).length;
const desks = nodes.filter((n) => n.name?.startsWith('Desk_')).length;
const declaredSeats = doc.blocks.reduce((sum, b) => sum + b.seats.length, 0);

// Every material either asset carries must be one the theme knows. The browser
// dresses a floor by looking each material's name up in a role table, and a name
// that table has never seen renders as an unthemed grey box - the kind of thing
// that shows up only as "why is this one wall the wrong colour" in a viewport.
//
// `apps/web/src/office/theme.ts` is the source of truth; the list is repeated
// rather than imported because this runs as a plain node script, and the web
// smoke test pins the other direction (that the table covers this list).
const ROLE_PREFIXES = [
  'M_Wall_Accent', 'M_Wall_Paint', 'M_Carpet_DevFloor', 'M_Floor_Concrete', 'M_Glass_Partition',
  'M_Metal_Frame', 'M_Desk_Top', 'M_Desk_Oak', 'M_Table_Meeting', 'M_Chair_Pad', 'M_Chair_Shell',
  'M_Soft_Furnishing', 'M_Rug', 'M_Plant', 'M_Accent_Orange', 'M_Screen_Emissive',
  'W_AccentWall', 'W_Wall', 'W_Glass', 'W_Partition', 'W_Carpet', 'W_Floor', 'W_Slab', 'W_Trim',
  'F_Frame', 'F_Rail', 'F_DeskTop', 'F_Desk', 'F_SoftDeep', 'F_Soft', 'F_Rug', 'F_Plant',
  'F_Board', 'F_Cork', 'F_Storage', 'F_Art', 'F_Fixture', 'F_Neon', 'F_ScreenOff', 'F_Screen',
];

const coreMaterials = (gltfJson('apps/web/public/office/office.glb').materials ?? []).map((m) => m.name);
const kitMaterials = (gltf.materials ?? []).map((m) => m.name);
const allMaterials = [...new Set([...coreMaterials, ...kitMaterials])].sort();
const unstyled = allMaterials.filter((name) => !ROLE_PREFIXES.some((prefix) => name === prefix || name.startsWith(prefix)));
const unusedPrefixes = ROLE_PREFIXES.filter((prefix) => !allMaterials.some((name) => name === prefix || name.startsWith(prefix)));

console.log(`blocks in json:   ${doc.blocks.length}`);
console.log(`kits in glb:      ${(gltf.scenes?.[0]?.nodes ?? []).length}`);
console.log(`seat anchors:     ${seats} (json declares ${declaredSeats})`);
console.log(`desk anchors:     ${desks}`);
console.log(`materials:        ${coreMaterials.length} core + ${kitMaterials.length} kit = ${allMaterials.length} distinct`);
console.log(`modules checked:  ${checked}`);
if (seats !== declaredSeats) problems.push(`seat anchor count ${seats} != declared ${declaredSeats}`);
if (seats !== desks) problems.push(`seat anchors ${seats} != desk anchors ${desks}`);
if (unstyled.length > 0) problems.push(`no theme role for: ${unstyled.join(', ')}`);
if (unusedPrefixes.length > 0) problems.push(`theme role matches nothing in the assets: ${unusedPrefixes.join(', ')}`);
if (problems.length > 0) {
  console.log('=== GLB/JSON MISMATCH ===');
  for (const problem of problems) console.log('  ' + problem);
  process.exit(1);
}
console.log('blocks.glb agrees with blocks.json: sizes, anchors, heights and material roles all check out.');
