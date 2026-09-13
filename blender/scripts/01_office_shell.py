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
import bmesh
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
def _uv_world_scale(mesh, metres_per_tile=1.0):
    """Give a part UVs measured in *metres*: one UV unit is one metre of surface.

    Blender's own cube projection would do most of this, but it is an operator that
    wants a UV editor in the context and this runs headless. Projecting each face
    along its own dominant normal is not much more code and has no context to get
    wrong.

    This is the whole of texel density, and the shell is where it shows most: a
    22 x 16 m floor slab wearing a 0..1 unwrap gives whatever pattern it carries one
    single tile across the entire floor. Measuring in metres means one tile covers
    one metre here exactly as it does inside a block module, so the floor of the
    core and the floor of a room bolted onto it are finished at the same real
    scale. `03_office_furniture.py` and `02_office_blocks.py` do the same thing.
    """
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.normal_update()
    uv_layer = bm.loops.layers.uv.verify()
    for face in bm.faces:
        normal = face.normal
        axis = max(range(3), key=lambda i: abs(normal[i]))
        u_axis, v_axis = [i for i in range(3) if i != axis]
        for loop in face.loops:
            co = loop.vert.co
            loop[uv_layer].uv = (co[u_axis] / metres_per_tile, co[v_axis] / metres_per_tile)
    bm.to_mesh(mesh)
    bm.free()


_SHAPES = {}


def _box_mesh(size, material):
    """The shared cube mesh for one size and surface.

    The glazing below is seven identical copies of the same dozen parts, and built
    one mesh per part that would be eighty-odd meshes in the file for two walls of
    windows. Sharing them is the same discipline `03_office_furniture.py` and
    `02_office_blocks.py` use, and it is why detail here costs geometry rather than
    file size.
    """
    key = (round(size[0], 4), round(size[1], 4), round(size[2], 4), material.name)
    found = _SHAPES.get(key)
    if found is not None:
        return found
    bpy.ops.mesh.primitive_cube_add(size=2.0)
    ob = bpy.context.active_object
    ob.scale = (size[0] / 2.0, size[1] / 2.0, size[2] / 2.0)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    # Local coordinates, so the unwrap is in metres and then turns with the object.
    _uv_world_scale(ob.data)
    mesh = ob.data
    mesh.materials.append(material)
    bpy.data.objects.remove(ob, do_unlink=True)
    _SHAPES[key] = mesh
    return mesh


def box(name, size, loc, coll, material, rot=(0.0, 0.0, 0.0)):
    """Axis-aligned box. size = full (X, Y, Z) dimensions in meters.

    The mesh is shared with every other box of the same size and surface; only the
    placement is per object.
    """
    ob = bpy.data.objects.new(name, _box_mesh(size, material))
    ob.location = loc
    ob.rotation_euler = rot
    coll.objects.link(ob)
    return ob

def wall_run(name, along, fixed, span, door_centres, coll, material, thickness=None):
    """A wall with real doorways cut out of it.

    The office is not a sealed box any more: `02_office_blocks.py` attaches room
    modules to its side walls, and a doorway that is only a texture would make
    the new rooms unreachable. So each wall is built as segments with a gap where
    a doorway belongs, plus a lintel over the gap - the same shape
    `02_office_blocks.py` builds for its own blocks.

    `thickness` defaults to the exterior wall and the interior partitions pass
    their own; it is the only thing that differs between the two uses. It is
    resolved here rather than in the signature because `T` is defined further down
    the file, and a default argument is evaluated when the function is defined.
    """
    if thickness is None:
        thickness = T
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
            box("%s_%d" % (name, index), (length, thickness, H), (mid, fixed, H / 2), coll, material)
        else:
            box("%s_%d" % (name, index), (thickness, length, H), (fixed, mid, H / 2), coll, material)
        index += 1

    lintel = H - LINTEL
    if lintel > 0.01:
        for j, (a, b) in enumerate(cuts):
            mid = (a + b) / 2.0
            if along == 'x':
                box("%s_Lintel_%d" % (name, j), (DOOR_W, thickness, lintel),
                    (mid, fixed, LINTEL + lintel / 2.0), coll, material)
            else:
                box("%s_Lintel_%d" % (name, j), (thickness, DOOR_W, lintel),
                    (fixed, mid, LINTEL + lintel / 2.0), coll, material)


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

# ---- exterior glazing -------------------------------------------------------
#
# Every room in this office was a sealed white box with no opening to the outside,
# and that is most of why the building read as a massing model rather than as
# offices. A ribbon of windows along both long elevations is the cheapest
# architectural feature there is and the first one a viewer looks for.
#
# The rhythm is a bay: a pier, an opening, a pier, and so on, with the piers sized
# to fill the span exactly so the corners stay closed and two 8 m blocks still tile
# a 16 m wall.
#
# The sill at 0.9 m is not decoration. The walkability grid turns any mesh whose
# world height crosses 0.25..1.75 m into an obstacle, so the wall's footprint is
# what keeps the floor walkable - and cutting a hole in a wall would delete the
# obstacle and open the building to the void outside it. The sill is what holds
# that footprint exactly where it was.
WINDOW_BAYS = 7
WINDOW_OPEN = 2.4
WINDOW_SILL = 0.9
WINDOW_HEAD = 2.4
GLASS_T = 0.04
FRAME_T = 0.06


def glazed_wall(name, fixed, span, coll, material, outward):
    """One long exterior elevation: piers, sills, headers, glazing and mullions.

    `outward` is which way is out of the building (-1 for the front elevation, +1
    for the back), because the outside cill has to sit on the outside.
    """
    total = span[1] - span[0]
    pier = (total - WINDOW_BAYS * WINDOW_OPEN) / (WINDOW_BAYS + 1)
    if pier <= 0.05:
        raise SystemExit("%s: %d bays of %.2f m leave no room for piers in %.1f m"
                         % (name, WINDOW_BAYS, WINDOW_OPEN, total))

    def put(part_name, size, loc, surface):
        box("%s_%s" % (name, part_name), size, loc, coll, surface)

    open_h = WINDOW_HEAD - WINDOW_SILL
    mid_z = (WINDOW_SILL + WINDOW_HEAD) / 2.0
    head_h = H - WINDOW_HEAD
    x = span[0]
    for bay in range(WINDOW_BAYS + 1):
        put("Pier_%d" % bay, (pier, T, H), (x + pier / 2.0, fixed, H / 2.0), material)
        x += pier
        if bay == WINDOW_BAYS:
            break
        centre = x + WINDOW_OPEN / 2.0
        # Below the sill and above the head, the wall is still a wall.
        put("Sill_%d" % bay, (WINDOW_OPEN, T, WINDOW_SILL), (centre, fixed, WINDOW_SILL / 2.0), material)
        put("Header_%d" % bay, (WINDOW_OPEN, T, head_h), (centre, fixed, WINDOW_HEAD + head_h / 2.0), material)

        # The glazing, in the plane of the wall.
        put("Glass_%d" % bay, (WINDOW_OPEN - 2 * FRAME_T, GLASS_T, open_h - 2 * FRAME_T),
            (centre, fixed, mid_z), M["glass"])
        # Frame: two jambs, a head, a stool, and a centre mullion that makes it read
        # as two lights rather than one sheet.
        for side in (-1, 1):
            put("Jamb_%d_%d" % (bay, side), (FRAME_T, T + 0.02, open_h),
                (centre + side * (WINDOW_OPEN - FRAME_T) / 2.0, fixed, mid_z), M["frame"])
        put("HeadBar_%d" % bay, (WINDOW_OPEN, T + 0.02, FRAME_T),
            (centre, fixed, WINDOW_HEAD - FRAME_T / 2.0), M["frame"])
        put("Stool_%d" % bay, (WINDOW_OPEN, T + 0.02, FRAME_T),
            (centre, fixed, WINDOW_SILL + FRAME_T / 2.0), M["frame"])
        put("Mullion_%d" % bay, (FRAME_T / 1.6, T + 0.01, open_h - 2 * FRAME_T),
            (centre, fixed, mid_z), M["frame"])
        # An outside cill, so the window sits *in* the wall rather than in a hole.
        put("Cill_%d" % bay, (WINDOW_OPEN + 0.10, 0.16, 0.05),
            (centre, fixed + outward * (T / 2.0 + 0.07), WINDOW_SILL - 0.03), M["frame"])
        x += WINDOW_OPEN


glazed_wall("Wall_Back", Y1 + T / 2, (-(X1 + T), X1 + T), COLL["Office_Structure"], M["wall"], 1)
glazed_wall("Wall_Front", Y0 - T / 2, (-(X1 + T), X1 + T), COLL["Office_Structure"], M["wall_dk"], -1)
wall_run("Wall_Left", 'y', X0 - T / 2, (Y0, Y1), GROWTH_DOORS, COLL["Office_Structure"], M["wall"])
wall_run("Wall_Right", 'y', X1 + T / 2, (Y0, Y1), GROWTH_DOORS, COLL["Office_Structure"], M["wall"])

# ---- back-room dividers (verticals span Y: YSPLIT -> Y1) ----
for idx, x in enumerate([-4.0, 0.0, 3.0]):
    box("Partition_V_%d" % idx, (P, Y1 - YSPLIT, H),
        (x, (Y1 + YSPLIT) / 2, H / 2), COLL["Office_Structure"], M["wall"])

# ---- corridor walls: every back room opens onto the dev floor ---------------
#
# These were solid, which sealed the CEO's office, the two small offices and the
# meeting room off from the dev floor. Nothing in the walkability grid connected
# them - a region is a connected piece of the floor, and there was only one way in:
# none - so their eleven seats could be occupied but never left. A room with no
# doorway is not a room, so each wall is now built the way the perimeter is:
# segments with a gap where the door belongs, and a lintel over the gap.
#
# One doorway per room, each on the dev-floor side. The partitions *between* the
# back rooms stay solid: an office you reach from the corridor is an office, an
# office you can only reach through the office next door is a suite.
CORRIDOR_DOORS = (("CEO", X0, -4.0, -7.5), ("Office2", -4.0, 0.0, -2.0), ("Office3", 0.0, 3.0, 1.5))
for name, lo, hi, door in CORRIDOR_DOORS:
    wall_run("CorridorWall_%s" % name, 'x', YSPLIT, (lo, hi), (door,),
             COLL["Room_%s" % name], M["wall"], P)

# ---- meeting room: a glazed wall with a doorway through it ------------------
#
# The meeting room is fronted in glass, so its door is a gap in the glass with a
# frame around it and a transom over it - which is what a glazed partition with a
# door in it looks like, and what the shipped asset had never had.
MEETING_DOOR = 5.0
MEETING_SPAN = (3.0, X1)
for i, (lo, hi) in enumerate((
    (MEETING_SPAN[0], MEETING_DOOR - DOOR_W / 2.0),
    (MEETING_DOOR + DOOR_W / 2.0, MEETING_SPAN[1]),
)):
    mid, length = (lo + hi) / 2.0, hi - lo
    box("Meeting_Glass_%d" % i, (length, 0.04, H), (mid, YSPLIT, H / 2), COLL["Room_Meeting"], M["glass"])
    box("Meeting_Glass_Frame_Top_%d" % i, (length, 0.06, 0.08), (mid, YSPLIT, H - 0.04), COLL["Room_Meeting"], M["frame"])
    box("Meeting_Glass_Frame_Bot_%d" % i, (length, 0.06, 0.08), (mid, YSPLIT, 0.04), COLL["Room_Meeting"], M["frame"])
box("Meeting_Door_Transom", (DOOR_W, 0.04, H - LINTEL), (MEETING_DOOR, YSPLIT, LINTEL + (H - LINTEL) / 2.0),
    COLL["Room_Meeting"], M["glass"])
for side in (-1, 1):
    box("Meeting_Door_Jamb_%d" % side, (0.05, 0.09, H),
        (MEETING_DOOR + side * (DOOR_W / 2.0 + 0.025), YSPLIT, H / 2), COLL["Room_Meeting"], M["frame"])
box("Meeting_Door_Head", (DOOR_W + 0.15, 0.09, 0.05), (MEETING_DOOR, YSPLIT, LINTEL + 0.025),
    COLL["Room_Meeting"], M["frame"])
box("Meeting_Mullion", (0.07, 0.09, H), (7.0, YSPLIT, H / 2), COLL["Room_Meeting"], M["frame"])

# ---- accent trim along the back wall ----
# Deliberately *above* the skirting `03_office_furniture.py` lays along the same
# wall: two bands at the same height would z-fight and read as one muddled edge,
# where a dark base with a coloured reveal over it is a detail that reads.
box("Trim_Back", (W, 0.05, 0.12), (0, Y1 - 0.05, 0.17), COLL["Office_Structure"], M["accent"])

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
