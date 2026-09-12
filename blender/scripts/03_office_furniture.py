"""dev3d - office furniture and anchors.

`01_office_shell.py` builds the architecture; this builds everything in it, and
the named empties the whole application hangs off.

Why this file exists
--------------------
The desks, chairs and `Seat_*` anchors in the shipped `office.glb` were authored
in interactive Blender sessions that were never written back to a script. That
made the asset unreproducible, which is not a tidiness problem: running the shell
script and re-exporting silently replaced the furnished office with a bare room,
taking all 21 seat anchors with it. It was recovered once from a build artifact
and could easily not have been.

So the furniture is scripted now. The names are a contract, not a detail:

    Seat_CEO, Seat_Dev_01..10, Seat_Office2, Seat_Office3, Seat_Meeting_01..08
    Anchor_Room_CEO, Anchor_Room_DevFloor, Anchor_Room_Lobby, Anchor_Room_Lounge,
    Anchor_Room_Meeting, Anchor_Room_Office2, Anchor_Room_Office3
    Desk_CEO, Desk_Dev_01..10, Desk_Office2, Desk_Office3

Thirteen desks and twenty-one seats is not an accident: the eight meeting chairs
have no desk of their own, which is exactly what the shipped asset's node counts
say. The org chart refers to people by those names, so a rename here is a rename
of where somebody sits.

Run order (each script resets the scene, so this order is the only one that works):

    01_office_shell.py     the shell, with growth doorways in the side walls
    03_office_furniture.py this file
    99_export_glb.py       writes apps/web/public/office/office.glb

Coordinates are Blender's: X east-west, Y north-south, Z up, the shell's footprint
22 x 16 m centred on the origin, and the back strip (Y 3..8) holding the enclosed
rooms. The exporter converts to glTF's Y-up frame, so nothing here needs to know
about it.

Safe-mode compatible: bpy + mathutils + stdlib only.
"""

import bpy
import math
from mathutils import Euler, Vector

# ============================================================ scene check
# This script adds furniture to the shell. Run against an empty scene it would
# produce a furnished room with no walls, and the export would look wrong in a way
# that is easy to miss, so it refuses instead.
if not any(ob.name == "Floor_Slab" for ob in bpy.data.objects):
    print("=== dev3d FURNITURE REFUSED ===")
    print("No Floor_Slab in the scene, so 01_office_shell.py has not run.")
    print("The scripts each reset the scene; the order is 01, then 03, then 99.")
    raise SystemExit(1)

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
    """Reuse the shell's material if it made one, so the palette stays single-source."""
    existing = bpy.data.materials.get(name)
    if existing is not None:
        return existing
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
        _set(b, ["Emission Strength"], 2.0)
    if alpha < 1.0:
        _set(b, ["Alpha"], alpha)
        try:
            m.blend_method = 'BLEND'
        except Exception:
            pass
    return m


M = {
    "desk": mat("M_Desk_Oak", (0.30, 0.24, 0.19), rough=0.55),
    "desk_top": mat("M_Desk_Top", (0.38, 0.31, 0.24), rough=0.45),
    "frame": mat("M_Metal_Frame", (0.06, 0.06, 0.07), rough=0.35, metal=0.9),
    "screen": mat("M_Screen_Emissive", (0.02, 0.03, 0.05), rough=0.25, emit=(0.25, 0.55, 0.80)),
    "chair": mat("M_Chair_Shell", (0.13, 0.15, 0.19), rough=0.7),
    "chair_pad": mat("M_Chair_Pad", (0.22, 0.25, 0.31), rough=0.85),
    "table": mat("M_Table_Meeting", (0.24, 0.19, 0.15), rough=0.5),
    "soft": mat("M_Soft_Furnishing", (0.20, 0.28, 0.38), rough=0.9),
    "plant": mat("M_Plant", (0.13, 0.36, 0.20), rough=0.85),
    "rug": mat("M_Rug", (0.16, 0.18, 0.24), rough=1.0),
    "accent": mat("M_Accent_Orange", (0.95, 0.42, 0.10), rough=0.45),
    "wall": mat("M_Wall_Paint", (0.62, 0.63, 0.66), rough=0.85),
}

# ============================================================ collections
def coll(name):
    found = bpy.data.collections.get(name)
    if found is not None:
        return found
    made = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(made)
    return made


DESKS = coll("Agent_Desks")
AGENTS = coll("Agents")
DEV = coll("DevFloor")
ROOM_CEO = coll("Room_CEO")
ROOM_MEETING = coll("Room_Meeting")
ROOM_OFFICE2 = coll("Room_Office2")
ROOM_OFFICE3 = coll("Room_Office3")


def box(name, size, loc, into, material=None, rot=(0.0, 0.0, 0.0)):
    """Axis-aligned box. size = full (X, Y, Z) dimensions in metres."""
    bpy.ops.mesh.primitive_cube_add(size=2.0, location=loc, rotation=rot)
    ob = bpy.context.active_object
    ob.name = name
    ob.scale = (size[0] / 2.0, size[1] / 2.0, size[2] / 2.0)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    for c in list(ob.users_collection):
        c.objects.unlink(ob)
    into.objects.link(ob)
    if material:
        ob.data.materials.append(material)
    return ob


def empty(name, loc, into, size=0.4):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = 'PLAIN_AXES'
    ob.empty_display_size = size
    ob.location = loc
    into.objects.link(ob)
    return ob


# ============================================================ furniture
DESK_W, DESK_D, DESK_H = 1.6, 0.8, 0.74
# The seat sits behind the desk edge, which is the offset the block kit uses too.
SEAT_OFFSET = 0.42


def workstation(seat_name, desk_name, x, y, facing):
    """A desk, its screen, a chair, and the two anchors the UI looks up.

    Naming rule, and it is load-bearing: **only the anchor empties carry a
    reserved prefix.** The loader finds seats, desks and rooms by prefix, so a
    mesh called `Seat_Meeting_01_Seat` would be offered as somewhere to put an
    employee, and `deskNameForSeat("Seat_Dev_01")` looks up exactly `Desk_Dev_01`
    - a desk whose parts were all suffixed with it would never be found. So the
    desk root is an empty named for the seat, and every mesh is named for what it
    is plus the tag.

    `facing` is the yaw the desk is turned to: 0 faces south (+Y in Blender, which
    is +z in the browser), and the seat empty sits behind the desk from there.
    """
    tag = desk_name[len("Desk_"):]
    cos, sin = math.cos(facing), math.sin(facing)

    # The desk root: what `deskNameForSeat` resolves to, so an avatar faces it.
    empty(desk_name, (x, y, DESK_H), DESKS)

    box("DeskTop_%s" % tag, (DESK_W, DESK_D, 0.05), (x, y, DESK_H), DESKS, M["desk_top"], (0, 0, facing))
    box("DeskApron_%s" % tag, (DESK_W - 0.2, DESK_D - 0.1, 0.10), (x, y, DESK_H - 0.09), DESKS, M["desk"], (0, 0, facing))
    for i, side in enumerate((-1, 1)):
        # Legs sit at the rotated corners, so a turned desk still stands on them.
        lx = x + side * (DESK_W / 2.0 - 0.09) * cos
        ly = y + side * (DESK_W / 2.0 - 0.09) * sin
        box("DeskLeg_%s_%d" % (tag, i), (0.07, DESK_D - 0.12, DESK_H - 0.1), (lx, ly, (DESK_H - 0.1) / 2.0), DESKS, M["frame"], (0, 0, facing))

    # Screen stand + panel, on the far side of the desk from the seat.
    sx = x - sin * -0.22
    sy = y + cos * -0.22
    box("ScreenPanel_%s" % tag, (0.62, 0.03, 0.36), (sx, sy, DESK_H + 0.30), DESKS, M["screen"], (0, 0, facing))
    box("ScreenStand_%s" % tag, (0.12, 0.12, 0.16), (sx, sy, DESK_H + 0.06), DESKS, M["frame"], (0, 0, facing))

    # Chair: seat pad, backrest, post. Behind the desk, where the employee sits.
    cx = x + sin * (DESK_D / 2.0 + 0.34)
    cy = y - cos * (DESK_D / 2.0 + 0.34)
    box("ChairSeat_%s" % tag, (0.46, 0.44, 0.06), (cx, cy, 0.46), DESKS, M["chair_pad"], (0, 0, facing))
    box("ChairBack_%s" % tag, (0.44, 0.06, 0.42), (cx + sin * 0.2, cy - cos * 0.2, 0.68), DESKS, M["chair"], (0, 0, facing))
    box("ChairPost_%s" % tag, (0.07, 0.07, 0.44), (cx, cy, 0.22), DESKS, M["frame"], (0, 0, facing))

    empty(seat_name, (cx, cy, 0.0), AGENTS)


def meeting_chair(seat_name, x, y, facing):
    """A chair at the meeting table. No desk: a shared table is the point.

    Its meshes are named `Chair_*`, not `Seat_*`, or the loader would count a
    seat back as a place to sit.
    """
    tag = seat_name[len("Seat_"):]
    box("Chair_%s_Seat" % tag, (0.44, 0.42, 0.06), (x, y, 0.45), ROOM_MEETING, M["chair_pad"], (0, 0, facing))
    box("Chair_%s_Back" % tag, (0.44, 0.06, 0.40), (x + math.sin(facing) * 0.19, y - math.cos(facing) * 0.19, 0.66), ROOM_MEETING, M["chair"], (0, 0, facing))
    box("Chair_%s_Post" % tag, (0.07, 0.07, 0.42), (x, y, 0.21), ROOM_MEETING, M["frame"], (0, 0, facing))
    empty(seat_name, (x, y, 0.0), AGENTS)


# ---- the development floor: ten desks in two rows of five -------------------
# The open floor is Y -8..3, so the rows sit clear of the corridor wall at Y 3
# and of the front wall at Y -8.
DEV_ROWS = (-0.6, -4.6)
DEV_COLS = (-8.0, -4.0, 0.0, 4.0, 8.0)
for row, y in enumerate(DEV_ROWS):
    for col, x in enumerate(DEV_COLS):
        n = row * len(DEV_COLS) + col + 1
        workstation("Seat_Dev_%02d" % n, "Desk_Dev_%02d" % n, x, y, 0.0)

# A rug under each row, so the open floor reads as zones rather than a car park.
for i, y in enumerate(DEV_ROWS):
    box("DevFloor_Rug_%d" % i, (19.0, 2.6, 0.02), (0.0, y, 0.012), DEV, M["rug"])

# ---- the CEO's office: X -11..-4 in the back strip --------------------------
workstation("Seat_CEO", "Desk_CEO", -7.6, 5.6, math.pi)
box("CEO_Shelf", (2.4, 0.4, 1.1), (-9.6, 7.5, 0.55), ROOM_CEO, M["desk"])
box("CEO_Plant_Pot", (0.34, 0.34, 0.30), (-4.8, 7.4, 0.15), ROOM_CEO, M["frame"])
box("CEO_Plant", (0.52, 0.52, 0.62), (-4.8, 7.4, 0.60), ROOM_CEO, M["plant"])

# ---- the two small offices --------------------------------------------------
workstation("Seat_Office2", "Desk_Office2", -2.0, 5.6, math.pi)
workstation("Seat_Office3", "Desk_Office3", 1.5, 5.6, math.pi)

# ---- the meeting room: X 3..11, one table and eight chairs ------------------
TABLE_X, TABLE_Y = 7.0, 5.5
box("Meeting_Table_Top", (4.6, 1.5, 0.06), (TABLE_X, TABLE_Y, 0.74), ROOM_MEETING, M["table"])
box("Meeting_Table_Pedestal", (1.1, 0.9, 0.68), (TABLE_X, TABLE_Y, 0.34), ROOM_MEETING, M["table"])
# Four chairs a side, facing the table across it.
for i in range(4):
    offset = -1.65 + i * 1.1
    meeting_chair("Seat_Meeting_%02d" % (i + 1), TABLE_X + offset, TABLE_Y - 1.15, math.pi)
    meeting_chair("Seat_Meeting_%02d" % (i + 5), TABLE_X + offset, TABLE_Y + 1.15, 0.0)

# ============================================================ room anchors
# Named after the rooms the shell builds, so a department can say which room it
# occupies and a seatless employee has somewhere specific to stand.
ROOMS = [
    ("Anchor_Room_CEO", -7.5, 5.5),
    ("Anchor_Room_Office2", -2.0, 5.5),
    ("Anchor_Room_Office3", 1.5, 5.5),
    ("Anchor_Room_Meeting", TABLE_X, TABLE_Y),
    ("Anchor_Room_DevFloor", 0.0, -2.5),
    ("Anchor_Room_Lobby", 0.0, -7.0),
    ("Anchor_Room_Lounge", -8.6, -6.4),
]
for name, x, y in ROOMS:
    empty(name, (x, y, 0.0), AGENTS, size=0.6)

# ---- the lounge: what makes Anchor_Room_Lounge a room rather than a label ----
box("Lounge_Sofa_Base", (2.6, 0.95, 0.42), (-8.6, -6.4, 0.21), DEV, M["soft"])
box("Lounge_Sofa_Back", (2.6, 0.24, 0.44), (-8.6, -6.85, 0.64), DEV, M["soft"])
box("Lounge_Coffee_Table", (1.2, 0.7, 0.06), (-8.6, -5.3, 0.40), DEV, M["desk_top"])
box("Lounge_Table_Leg", (0.9, 0.5, 0.38), (-8.6, -5.3, 0.19), DEV, M["frame"])
box("Lounge_Plant_Pot", (0.32, 0.32, 0.28), (-10.0, -7.2, 0.14), DEV, M["frame"])
box("Lounge_Plant", (0.5, 0.5, 0.6), (-10.0, -7.2, 0.56), DEV, M["plant"])

# ---- the lobby: a reception desk, so the front door has somewhere to arrive --
box("Lobby_Desk", (3.4, 0.7, 1.05), (0.0, -7.4, 0.525), DEV, M["desk_top"])
box("Lobby_Desk_Trim", (3.4, 0.06, 0.08), (0.0, -7.06, 1.05), DEV, M["accent"])

# ============================================================ report
# The prefixes are a contract, so the count is asserted rather than eyeballed: a
# mesh accidentally named `Seat_*` would silently become somewhere to sit.
def prefixed(prefix, kind):
    found = sorted(ob.name for ob in bpy.data.objects if ob.type == kind and ob.name.startswith(prefix))
    return found


seats = prefixed("Seat_", 'EMPTY')
desks = prefixed("Desk_", 'EMPTY')
rooms = prefixed("Anchor_Room_", 'EMPTY')
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
polys = sum(len(o.data.polygons) for o in meshes)

problems = []
if len(seats) != 21:
    problems.append("expected 21 Seat_* empties, found %d" % len(seats))
if len(desks) != 13:
    problems.append("expected 13 Desk_* empties, found %d" % len(desks))
if len(rooms) != 7:
    problems.append("expected 7 Anchor_Room_* empties, found %d" % len(rooms))
for ob in bpy.data.objects:
    if ob.type != 'EMPTY' and (ob.name.startswith("Seat_") or ob.name.startswith("Desk_") or ob.name.startswith("Anchor_Room_")):
        problems.append("%s is a %s but carries a reserved anchor prefix" % (ob.name, ob.type))

print("=== dev3d OFFICE FURNITURE BUILT ===")
print("meshes: %d | polygons: %d" % (len(meshes), polys))
print("seats: %d | desks: %d | rooms: %d" % (len(seats), len(desks), len(rooms)))
print("SEATS=" + ",".join(seats))
print("ROOMS=" + ",".join(rooms))
print("DESKS=" + ",".join(desks))
if problems:
    print("=== ANCHOR CONTRACT VIOLATED ===")
    for problem in problems:
        print("  " + problem)
    raise SystemExit(1)
print("anchor contract: 21 seats, 13 desks, 7 rooms - as the org chart expects")
