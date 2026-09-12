"""dev3d - Office shell.

Builds the architectural shell of the dev3d office: floor slab, exterior
walls, back-room dividers, the glass meeting room and the open dev floor.

    THIS IS THE SHELL ONLY. The desks, chairs and `Seat_*` anchors that the
    office UI places employees at were authored in interactive Blender
    sessions and are not reproducible from this file. Running it replaces the
    furnished office with a bare room, so run `99_export_glb.py` only when you
    mean to - and note that the exporter refuses to write an anchor-less scene.

Conventions
-----------
Units are meters. X = width (east-west), Y = depth (north-south), Z = up.
The office footprint is 22 x 16 m. The back strip (Y 3..8) holds the
enclosed rooms; the open dev floor is Y -8..3.

Run through the Blender MCP bridge (safe-mode compatible: bpy + mathutils
+ stdlib only). Re-running is idempotent - the scene is reset first.
"""

import bpy
import math
from mathutils import Euler, Vector

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

# ============================================================ collections
def new_coll(name):
    c = bpy.data.collections.new(name)
    scn.collection.children.link(c)
    return c

COLL = {}
for _name in ("Office_Structure", "Room_CEO", "Room_Office2", "Room_Office3",
              "Room_Meeting", "DevFloor", "Agent_Desks", "Agents",
              "Lighting", "Cameras"):
    COLL[_name] = new_coll(_name)

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
        try:
            m.surface_render_method = 'BLENDED'
        except Exception:
            pass
    return m

M = {
    "floor":   mat("M_Floor_Concrete", (0.16, 0.17, 0.19), rough=0.75),
    "carpet":  mat("M_Carpet_DevFloor", (0.10, 0.12, 0.16), rough=0.95),
    "wall":    mat("M_Wall_Paint", (0.62, 0.63, 0.66), rough=0.85),
    "wall_dk": mat("M_Wall_Accent", (0.20, 0.22, 0.26), rough=0.80),
    "glass":   mat("M_Glass_Partition", (0.55, 0.72, 0.80), rough=0.05, alpha=0.22),
    "frame":   mat("M_Metal_Frame", (0.06, 0.06, 0.07), rough=0.35, metal=0.9),
    "screen":  mat("M_Screen_Emissive", (0.02, 0.03, 0.05), rough=0.25, emit=(0.25, 0.55, 0.80)),
    "accent":  mat("M_Accent_Orange", (0.95, 0.42, 0.10), rough=0.45),
}

# ============================================================ helpers
def box(name, size, loc, coll, material=None, rot=(0.0, 0.0, 0.0)):
    """Axis-aligned box. size = full (X, Y, Z) dimensions in meters."""
    bpy.ops.mesh.primitive_cube_add(size=2.0, location=loc, rotation=rot)
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

def wall_run(name, along, fixed, span, door_centres, coll, material):
    """A wall with real doorways cut out of it.

    The office is not a sealed box any more: `02_office_blocks.py` attaches room
    modules to its side walls, and a doorway that is only a texture would make
    the new rooms unreachable. So each wall is built as segments with a gap where
    a doorway belongs, plus a lintel over the gap - the same shape
    `02_office_blocks.py` builds for its own blocks.
    """
    cuts = sorted((c - DOOR_W / 2.0, c + DOOR_W / 2.0) for c in door_centres)
    edges = [span[0]]
    for a, b in cuts:
        edges.extend((a, b))
    edges.append(span[1])

    index = 0
    for i in range(0, len(edges) - 1, 2):
        lo, hi = edges[i], edges[i + 1]
        if hi - lo <= 0.01:
            continue
        mid, length = (lo + hi) / 2.0, hi - lo
        if along == 'x':
            box("%s_%d" % (name, index), (length, T, H), (mid, fixed, H / 2), coll, material)
        else:
            box("%s_%d" % (name, index), (T, length, H), (fixed, mid, H / 2), coll, material)
        index += 1

    lintel = H - LINTEL
    if lintel > 0.01:
        for j, (a, b) in enumerate(cuts):
            mid = (a + b) / 2.0
            if along == 'x':
                box("%s_Lintel_%d" % (name, j), (DOOR_W, T, lintel), (mid, fixed, LINTEL + lintel / 2.0), coll, material)
            else:
                box("%s_Lintel_%d" % (name, j), (T, DOOR_W, lintel), (fixed, mid, LINTEL + lintel / 2.0), coll, material)


def frame_view(loc, dist, rot_deg):
    """Point the 3D viewport at a target so MCP screenshots are useful."""
    try:
        screen = bpy.context.screen
        if not screen:
            return "no screen (background mode)"
        for area in screen.areas:
            if area.type == 'VIEW_3D':
                r3d = area.spaces.active.region_3d
                r3d.view_location = Vector(loc)
                r3d.view_distance = dist
                r3d.view_rotation = Euler([math.radians(a) for a in rot_deg]).to_quaternion()
        return "ok"
    except Exception as exc:
        return "skipped: %s" % exc

# ============================================================ layout
W, D = 22.0, 16.0           # footprint
H = 3.0                     # wall height
T = 0.15                    # exterior wall thickness
P = 0.12                    # interior partition thickness
X0, X1 = -W / 2, W / 2      # -11 .. 11
Y0, Y1 = -D / 2, D / 2      #  -8 .. 8
YSPLIT = 3.0                # back rooms occupy Y 3..8

# ---- floor slab (top surface at z = 0) ----
box("Floor_Slab", (W + 0.4, D + 0.4, 0.2), (0, 0, -0.1), COLL["Office_Structure"], M["floor"])
box("Floor_DevCarpet", (W - 0.3, YSPLIT - Y0 - 0.15, 0.02),
    (0, (YSPLIT + Y0) / 2, 0.011), COLL["DevFloor"], M["carpet"])

# ---- exterior walls ----
# Growth doorways sit on the east and west walls, two per side, mirroring the
# four ports `02_office_blocks.py` publishes for the core. Two 8 m blocks tile
# each 16 m wall exactly.
DOOR_W = 1.4
LINTEL = 2.2
GROWTH_DOORS = (-4.0, 4.0)

box("Wall_Back", (W + 2 * T, T, H), (0, Y1 + T / 2, H / 2), COLL["Office_Structure"], M["wall"])
box("Wall_Front", (W + 2 * T, T, H), (0, Y0 - T / 2, H / 2), COLL["Office_Structure"], M["wall_dk"])
wall_run("Wall_Left", 'y', X0 - T / 2, (Y0, Y1), GROWTH_DOORS, COLL["Office_Structure"], M["wall"])
wall_run("Wall_Right", 'y', X1 + T / 2, (Y0, Y1), GROWTH_DOORS, COLL["Office_Structure"], M["wall"])

# ---- back-room dividers (verticals span Y: YSPLIT -> Y1) ----
for idx, x in enumerate([-4.0, 0.0, 3.0]):
    box("Partition_V_%d" % idx, (P, Y1 - YSPLIT, H),
        (x, (Y1 + YSPLIT) / 2, H / 2), COLL["Office_Structure"], M["wall"])

# ---- corridor walls: solid for the offices, glass for the meeting room ----
box("CorridorWall_CEO", (abs(X0) - 4.0, P, H), ((-4.0 + X0) / 2, YSPLIT, H / 2),
    COLL["Room_CEO"], M["wall"])
box("CorridorWall_Office2", (4.0, P, H), (-2.0, YSPLIT, H / 2),
    COLL["Room_Office2"], M["wall"])
box("CorridorWall_Office3", (3.0, P, H), (1.5, YSPLIT, H / 2),
    COLL["Room_Office3"], M["wall"])

# ---- meeting room: full-height glazed wall + frame + mullion ----
box("Meeting_Glass_Wall", (X1 - 3.0, 0.04, H), ((X1 + 3.0) / 2, YSPLIT, H / 2),
    COLL["Room_Meeting"], M["glass"])
box("Meeting_Glass_Frame_Top", (X1 - 3.0, 0.06, 0.08), ((X1 + 3.0) / 2, YSPLIT, H - 0.04),
    COLL["Room_Meeting"], M["frame"])
box("Meeting_Glass_Frame_Bot", (X1 - 3.0, 0.06, 0.08), ((X1 + 3.0) / 2, YSPLIT, 0.04),
    COLL["Room_Meeting"], M["frame"])
box("Meeting_Mullion", (0.07, 0.09, H), (7.0, YSPLIT, H / 2), COLL["Room_Meeting"], M["frame"])

# ---- accent trim along the back wall ----
box("Trim_Back", (W, 0.05, 0.12), (0, Y1 - 0.05, 0.06), COLL["Office_Structure"], M["accent"])

# ============================================================ world + light
world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
scn.world = world
world.use_nodes = True
for node in world.node_tree.nodes:
    if node.type == 'BACKGROUND':
        node.inputs[0].default_value = (0.035, 0.04, 0.05, 1.0)
        node.inputs[1].default_value = 1.0

bpy.ops.object.light_add(type='SUN', location=(6, -8, 12))
sun = bpy.context.active_object
sun.name = "Sun_Key"
sun.data.energy = 3.0
sun.rotation_euler = Euler((math.radians(52), 0.0, math.radians(38)))
for c in list(sun.users_collection):
    c.objects.unlink(sun)
COLL["Lighting"].objects.link(sun)

# ============================================================ camera
bpy.ops.object.camera_add(location=(14, -18, 16))
cam = bpy.context.active_object
cam.name = "Cam_Office_Overview"
direction = Vector((0, 1.5, 1.0)) - Vector(cam.location)
cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
for c in list(cam.users_collection):
    c.objects.unlink(cam)
COLL["Cameras"].objects.link(cam)
scn.camera = cam

print("viewport framing:", frame_view((0, 0, 1.2), 30.0, (68.0, 0.0, 35.0)))

# ============================================================ report
print("=== dev3d OFFICE SHELL BUILT ===")
print("footprint: %.0f x %.0f x %.1f m" % (W, D, H))
print("objects: %d | collections: %d" % (len(bpy.data.objects), len(bpy.data.collections)))
for name in sorted(COLL):
    print("  %-18s %d obj" % (name, len(COLL[name].objects)))
