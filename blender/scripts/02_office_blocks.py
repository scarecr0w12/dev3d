"""dev3d - the office block kit.

A floor is not one hand-authored room any more: it is the core office plus a
jigsaw of room modules attached to it. This script builds those modules and, in
the same pass, writes the sidecar that describes them.

Why one pass, and why a sidecar
------------------------------
Geometry and metadata that are written by two different steps drift. So the
block's size, its doorway edges and its seat anchors are emitted by the same
code that builds its walls, and `blocks.json` cannot describe a block that does
not exist. The three.js loader places seats by looking up named nodes - never by
hard-coded coordinates - and this file is the index of which names exist where.

Coordinates
-----------
Blender is Z-up, glTF is Y-up, and the exporter converts (blender X, Y, Z ->
gltf X, Z, -Y). Everything in `blocks.json` is written in the *browser* frame,
because that is where the assembly happens:

    x  east        z  south (positive z is toward the default camera)
    y  up          north is -z

A block's origin is its centre, at floor level. Doors are edges of that
rectangle, named for the compass direction their outward normal points.

Run through the Blender MCP bridge (safe-mode compatible: bpy + mathutils +
stdlib only). Re-running is idempotent - the scene is reset first - and the
scene is left holding the kit, so run `01_office_shell.py` before re-exporting
the office itself.
"""

import bpy
import json
import math

OUT_GLB = r"E:\Development\dev3d\apps\web\public\office\blocks.glb"
OUT_JSON = r"E:\Development\dev3d\apps\web\public\office\blocks.json"

# ============================================================ reset
for ob in list(bpy.data.objects):
    bpy.data.objects.remove(ob, do_unlink=True)
for coll in list(bpy.data.collections):
    bpy.data.collections.remove(coll)
for mat_ in list(bpy.data.materials):
    bpy.data.materials.remove(mat_)

scn = bpy.context.scene
scn.unit_settings.system = 'METRIC'
scn.unit_settings.length_unit = 'METERS'

KIT = bpy.data.collections.new("Blocks_Kit")
scn.collection.children.link(KIT)


def new_coll(name):
    c = bpy.data.collections.new(name)
    KIT.children.link(c)
    return c


# ============================================================ materials
def _bsdf(m):
    for node in m.node_tree.nodes:
        if node.type == 'BSDF_PRINCIPLED':
            return node
    return None


def _set(bsdf, names, value):
    for n in names:
        if n in bsdf.inputs:
            bsdf.inputs[n].default_value = value
            return True
    return False


def mat(name, rgb, rough=0.6, metal=0.0, emit=None, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = _bsdf(m)
    if b is None:
        return m
    _set(b, ["Base Color"], (rgb[0], rgb[1], rgb[2], 1.0))
    _set(b, ["Roughness"], rough)
    _set(b, ["Metallic"], metal)
    if emit is not None:
        _set(b, ["Emission Color", "Emission"], (emit[0], emit[1], emit[2], 1.0))
        _set(b, ["Emission Strength"], 1.6)
    if alpha < 1.0:
        _set(b, ["Alpha"], alpha)
        try:
            m.blend_method = 'BLEND'
        except Exception:
            pass
    return m


M = {
    "floor": mat("BM_Floor", (0.15, 0.16, 0.18), rough=0.8),
    "carpet": mat("BM_Carpet", (0.11, 0.13, 0.17), rough=0.95),
    "wall": mat("BM_Wall", (0.60, 0.61, 0.64), rough=0.85),
    "accent": mat("BM_WallAccent", (0.22, 0.24, 0.28), rough=0.8),
    "glass": mat("BM_Glass", (0.55, 0.72, 0.80), rough=0.05, alpha=0.22),
    "frame": mat("BM_Frame", (0.06, 0.06, 0.07), rough=0.35, metal=0.9),
    "desk": mat("BM_Desk", (0.32, 0.26, 0.21), rough=0.6),
    "screen": mat("BM_Screen", (0.02, 0.03, 0.05), rough=0.25, emit=(0.25, 0.55, 0.80)),
    "soft": mat("BM_Soft", (0.20, 0.28, 0.38), rough=0.9),
}


def box(name, size, loc, coll, material=None):
    """Axis-aligned box. size = full (X, Y, Z) dimensions in metres."""
    bpy.ops.mesh.primitive_cube_add(size=2.0, location=loc)
    ob = bpy.context.active_object
    ob.name = name
    ob.scale = (size[0] / 2.0, size[1] / 2.0, size[2] / 2.0)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    for c in list(ob.users_collection):
        c.objects.unlink(ob)
    coll.objects.link(ob)
    if material:
        ob.data.materials.append(material)
    return ob


def empty(name, loc, coll):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = 'PLAIN_AXES'
    ob.empty_display_size = 0.4
    ob.location = loc
    coll.objects.link(ob)
    return ob


# ============================================================ the kit

# A block is 8 m along its wide edges and 6 m deep, so two blocks tile exactly
# across the core's 16 m side wall. A junction is square, which is what lets the
# building turn a corner instead of growing in one straight line.
WALL_H = 3.0
WALL_T = 0.15
DOOR_W = 1.4
LINTEL = 2.2

# doors: edges of the block with a doorway. width/depth in metres.
# seats: how many desks to build, laid out in a row along the middle.
BLOCKS = [
    {
        "id": "pod4",
        "name": "Open pod",
        "kind": "open",
        "width": 8.0,
        "depth": 6.0,
        "doors": ["w", "e"],
        "seats": 4,
        "material": "carpet",
    },
    {
        "id": "office2",
        "name": "Private office",
        "kind": "room",
        "width": 8.0,
        "depth": 6.0,
        "doors": ["w"],
        "seats": 2,
        "material": "carpet",
    },
    {
        "id": "meeting6",
        "name": "Meeting room",
        "kind": "meeting",
        "width": 8.0,
        "depth": 6.0,
        "doors": ["w"],
        "seats": 6,
        "material": "carpet",
    },
    {
        "id": "lounge3",
        "name": "Lounge",
        "kind": "lounge",
        "width": 8.0,
        "depth": 6.0,
        "doors": ["w", "e"],
        "seats": 3,
        "material": "carpet",
    },
    {
        "id": "junction",
        "name": "Junction",
        "kind": "junction",
        "width": 6.0,
        "depth": 6.0,
        "doors": ["n", "e", "s", "w"],
        "seats": 0,
        "material": "floor",
    },
    {
        # The circulation spine. A room with one doorway is a dead end, and a
        # junction is a node rather than a route between two of them - so without
        # a corridor a generated building is a chain of rooms and nothing else.
        # Thin, doorways at both ends and along one side, and no desks: it is
        # somewhere to walk, not somewhere to work.
        "id": "corridor",
        "name": "Corridor",
        "kind": "corridor",
        "width": 8.0,
        "depth": 3.0,
        "doors": ["w", "e", "n"],
        "seats": 0,
        "material": "floor",
    },
]

# A portal is what connects a new block to the core. It is a doorway standing in
# the core's outer wall: two jambs, a lintel and a glazed door. The core is a
# hand-authored asset whose furniture is not scripted, so its walls cannot be
# rebuilt with a hole in them - a glazed door is the honest alternative, and it
# reads as a connection from inside either room.
#
# It carries no doors of its own, so the placement search can never choose it as
# a room: growth is driven by `doors`, and a portal has none.
PORTAL = {
    "id": "portal",
    "name": "Doorway",
    "kind": "portal",
    "width": 1.9,
    "depth": 0.5,
    "doors": [],
    "seats": 0,
    "material": "floor",
}


def edges_with_doors(doors, width, depth):
    """Where each doorway sits, in metres measured along its own wall.

    Every wall is built as segments with gaps and a lintel over each gap, so a
    doorway is a real hole in the geometry rather than a decal - two blocks that
    mate have to be walkable between.
    """
    out = []
    for edge in doors:
        if edge in ("n", "s"):
            # A north/south wall runs east-west, so the gap is placed on x.
            out.append((edge, 0.0))
        else:
            out.append((edge, 0.0))
    return out


def build_wall(name, along, fixed, span, doors_at, coll, root):
    """One wall with door gaps, along `along` ('x' or 'y') at `fixed`."""
    cuts = [(c - DOOR_W / 2.0, c + DOOR_W / 2.0) for c in doors_at]
    cuts.sort()
    edges = [span[0]]
    for a, b in cuts:
        edges.append(a)
        edges.append(b)
    edges.append(span[1])

    def part(part_name, size, loc):
        ob = box(part_name, size, loc, coll, M["wall"])
        ob.parent = root
        ob.matrix_parent_inverse = root.matrix_world.inverted()
        return ob

    index = 0
    for i in range(0, len(edges) - 1, 2):
        lo, hi = edges[i], edges[i + 1]
        if hi - lo <= 0.01:
            continue
        mid = (lo + hi) / 2.0
        length = hi - lo
        if along == 'x':
            part("%s_%d" % (name, index), (length, WALL_T, WALL_H), (mid, fixed, WALL_H / 2.0))
        else:
            part("%s_%d" % (name, index), (WALL_T, length, WALL_H), (fixed, mid, WALL_H / 2.0))
        index += 1

    # The lintel: the strip of wall above each doorway.
    lh = WALL_H - LINTEL
    if lh > 0.01:
        for j, (a, b) in enumerate(cuts):
            mid = (a + b) / 2.0
            if along == 'x':
                part("%s_Lintel_%d" % (name, j), (DOOR_W, WALL_T, lh), (mid, fixed, LINTEL + lh / 2.0))
            else:
                part("%s_Lintel_%d" % (name, j), (WALL_T, DOOR_W, lh), (fixed, mid, LINTEL + lh / 2.0))


def build_desk(coll, root, seat_name, x, y):
    """A desk, a screen and the `Seat_` empty the UI places an employee at.

    Only the empty carries the `Seat_` prefix. The loader finds seats by looking
    for that prefix, so naming the desk parts `Seat_..._Desk` would offer a
    tabletop as somewhere to sit an employee.
    """
    tag = seat_name[len("Seat_"):]

    def part(name, size, loc, material):
        ob = box(name, size, loc, coll, material)
        ob.parent = root
        ob.matrix_parent_inverse = root.matrix_world.inverted()
        return ob

    part("Desk_%s" % tag, (1.6, 0.8, 0.05), (x, y, 0.74), M["desk"])
    for i, leg_x in enumerate((-0.7, 0.7)):
        for j, leg_y in enumerate((-0.32, 0.32)):
            part("Leg_%s_%d_%d" % (tag, i, j), (0.06, 0.06, 0.74), (x + leg_x, y + leg_y, 0.37), M["frame"])
    part("Screen_%s" % tag, (0.6, 0.04, 0.36), (x, y - 0.22, 0.99), M["screen"])

    seat = empty(seat_name, (x, y + 0.42, 0.0), coll)
    seat.parent = root
    seat.matrix_parent_inverse = root.matrix_world.inverted()


def build_block(spec):
    coll = new_coll("Block_%s" % spec["id"])
    # Every module is parented under one empty. Without it the GLB is a flat pile
    # of 150 sibling nodes and the browser would have to guess which meshes belong
    # to which module from their names - and it would guess wrong the first time a
    # module gained a part.
    root = empty("Kit_%s" % spec["id"], (0.0, 0.0, 0.0), coll)
    w, d = spec["width"], spec["depth"]

    def part(name, size, loc, material):
        ob = box(name, size, loc, coll, material)
        ob.parent = root
        # Keep the world transform: the box was placed in absolute coordinates.
        ob.matrix_parent_inverse = root.matrix_world.inverted()
        return ob

    part("Block_%s_Slab" % spec["id"], (w + 0.3, d + 0.3, 0.2), (0, 0, -0.1), M["floor"])
    part("Block_%s_Carpet" % spec["id"], (w - 0.3, d - 0.3, 0.02), (0, 0, 0.011), M[spec["material"]])

    doors = spec["doors"]
    # Blender's Y runs opposite to the browser's z, so a browser-north wall sits
    # at Blender +Y. The conversion is mirrored in one place, here.
    build_wall("Block_%s_Wall_N" % spec["id"], 'x', d / 2.0, (-w / 2.0, w / 2.0), [0.0] if "n" in doors else [], coll, root)
    build_wall("Block_%s_Wall_S" % spec["id"], 'x', -d / 2.0, (-w / 2.0, w / 2.0), [0.0] if "s" in doors else [], coll, root)
    build_wall("Block_%s_Wall_E" % spec["id"], 'y', w / 2.0, (-d / 2.0, d / 2.0), [0.0] if "e" in doors else [], coll, root)
    build_wall("Block_%s_Wall_W" % spec["id"], 'y', -w / 2.0, (-d / 2.0, d / 2.0), [0.0] if "w" in doors else [], coll, root)

    if spec["kind"] == "junction":
        # A junction is circulation: no walls beyond its doorways, just a lit
        # strip, so the building reads as connected rather than as a row of boxes.
        part("Block_%s_Guide" % spec["id"], (w - 0.6, 0.06, 0.01), (0, 0, 0.02), M["accent"])
        return []

    if spec["kind"] == "corridor":
        # Low walls on the two long sides so it reads as a route, and a lit strip
        # down the middle. No desks, no room anchor: nobody works in a corridor.
        for side in (-1, 1):
            part("Corridor_%s_Rail_%d" % (spec["id"], 0 if side < 0 else 1),
                 (w, 0.12, 1.05), (0, side * d / 2.0, 0.525), M["wall"])
        part("Corridor_%s_Guide" % spec["id"], (w - 0.8, 0.08, 0.01), (0, 0, 0.021), M["accent"])
        return []

    if spec["kind"] == "portal":
        # Jambs, a lintel and a glazed door leaf, centred on the local origin and
        # opening along local x so a placement rotation turns it to face outward.
        jamb = 0.09
        for side in (-1, 1):
            part("Portal_%s_Jamb_%d" % (spec["id"], 0 if side < 0 else 1),
                 (jamb, spec["depth"], WALL_H), (side * (DOOR_W / 2.0 + jamb / 2.0), 0, WALL_H / 2.0), M["frame"])
        part("Portal_%s_Lintel" % spec["id"], (DOOR_W + 2 * jamb, spec["depth"], WALL_H - LINTEL),
             (0, 0, LINTEL + (WALL_H - LINTEL) / 2.0), M["frame"])
        part("Portal_%s_Leaf" % spec["id"], (DOOR_W - 0.06, 0.05, LINTEL - 0.04),
             (0, 0, (LINTEL - 0.04) / 2.0), M["glass"])
        return []

    # Every room module names itself, so an employee seated here is described as
    # being in the pod rather than at the bench. The core office does the same
    # with its own Anchor_Room_* empties.
    room = empty("Anchor_Room_%s" % spec["id"].upper(), (0.0, 0.0, 0.0), coll)
    room.parent = root
    room.matrix_parent_inverse = root.matrix_world.inverted()

    seats = []
    count = spec["seats"]
    # One row along the block, evenly spaced and centred.
    spacing = (w - 1.6) / max(1, count - 1) if count > 1 else 0.0
    start = -(w - 1.6) / 2.0 if count > 1 else 0.0
    for i in range(count):
        name = "Seat_%s_%02d" % (spec["id"].upper(), i + 1)
        x = start + spacing * i
        build_desk(coll, root, name, x, 0.0)
        seats.append(name)
    return seats


emitted = []
for spec in BLOCKS:
    seats = build_block(spec)
    entry = {
        "id": spec["id"],
        "name": spec["name"],
        "kind": spec["kind"],
        "width": spec["width"],
        "depth": spec["depth"],
        "doors": list(spec["doors"]),
        "seats": seats,
        # The cloneable node in blocks.glb. The browser instantiates a module by
        # cloning this, so it never has to guess which meshes belong together.
        "node": "Kit_%s" % spec["id"],
    }
    if spec["kind"] not in ("junction", "portal"):
        entry["room"] = "Anchor_Room_%s" % spec["id"].upper()
    emitted.append(entry)

# The portal is emitted into the same kit but tagged, so the browser knows it is
# a fitting rather than a room and never offers it to the growth search.
portal_seats = build_block(PORTAL)
emitted.append({
    "id": PORTAL["id"],
    "name": PORTAL["name"],
    "kind": PORTAL["kind"],
    "width": PORTAL["width"],
    "depth": PORTAL["depth"],
    "doors": list(PORTAL["doors"]),
    "seats": portal_seats,
    "node": "Kit_%s" % PORTAL["id"],
    "fitting": True,
})
# ============================================================ the core's ports
# The core office is built by 01_office_shell.py, which owns its geometry. Its
# size is repeated here because the ports have to sit on its actual walls: an
# 22 x 16 m shell, growing east and west, with two doorways per side wall. Two
# 8 m blocks tile each 16 m wall exactly, so the four ports are a complete ring.
CORE_W, CORE_D = 22.0, 16.0
CORE_PORTS = [
    {"id": "core_e1", "x": CORE_W / 2.0, "z": -4.0, "dir": "e"},
    {"id": "core_e2", "x": CORE_W / 2.0, "z": 4.0, "dir": "e"},
    {"id": "core_w1", "x": -CORE_W / 2.0, "z": -4.0, "dir": "w"},
    {"id": "core_w2", "x": -CORE_W / 2.0, "z": 4.0, "dir": "w"},
]

document = {
    "version": 1,
    "note": "Generated by blender/scripts/02_office_blocks.py. Do not hand-edit: re-run the script.",
    "cell": 6.0,
    "core": {
        "model": "office.glb",
        "width": CORE_W,
        "depth": CORE_D,
        "ports": CORE_PORTS,
    },
    "blocks": emitted,
}

# ============================================================ export
bpy.ops.object.select_all(action='DESELECT')
for ob in KIT.objects:
    ob.select_set(True)
for child in KIT.children:
    for ob in child.objects:
        ob.select_set(True)

try:
    bpy.ops.export_scene.gltf(
        filepath=OUT_GLB,
        export_format='GLB',
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
        export_animations=False,
        export_materials='EXPORT',
    )
    mode = "selection"
except TypeError as exc:
    print("selection kwargs rejected (%s); falling back to whole scene" % exc)
    bpy.ops.export_scene.gltf(filepath=OUT_GLB, export_format='GLB')
    mode = "whole-scene"

written = "no"
try:
    with open(OUT_JSON, "w", encoding="utf-8") as handle:
        json.dump(document, handle, indent=2)
        handle.write("\n")
    written = OUT_JSON
except Exception as exc:  # the bridge may withhold file writes; print instead
    print("could not write %s: %s" % (OUT_JSON, exc))

meshes = [o for o in bpy.data.objects if o.type == 'MESH']
empties = [o for o in bpy.data.objects if o.type == 'EMPTY']

print("=== dev3d BLOCK KIT ===")
print("mode: %s" % mode)
print("glb: %s" % OUT_GLB)
print("json: %s" % written)
print("blocks: %d | meshes: %d | seat anchors: %d" % (len(emitted), len(meshes), len(empties)))
for block in emitted:
    print("  %-10s %4.1f x %4.1f  doors=%-12s seats=%d%s" % (
        block["id"], block["width"], block["depth"], ",".join(block["doors"]) or "-",
        len(block["seats"]), "  (fitting)" if block.get("fitting") else ""))
print("BLOCKS_JSON=" + json.dumps(document))
