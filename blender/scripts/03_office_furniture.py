"""dev3d - office furniture, fixtures and interior detail.

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

Detail, and what it costs
-------------------------
Everything here is built from three *shapes*: a bevelled box, a bevelled
cylinder, and the empties. A shape is built once and shared - a bevelled box of a
given size and surface is a single mesh with many users, not one mesh per part -
which is what lets the office carry real detail without the asset growing with
it. The block kit learned this the hard way: built one-mesh-per-part it exported a
2.4 MB GLB of 1 468 identical cubes, where sharing the geometry produced 438 KB.

Two things make the detail read, and together they are worth more than the
polygon count:

  * **A bevel on every edge.** A razor-sharp 90 degree corner has no surface for a
    highlight to sit on, which is exactly why an unmodified box reads as cardboard
    however carefully it is lit. Six millimetres of bevel is enough to catch one.
  * **Smooth shading with an angle threshold.** The bevel then smooths into a
    rounded edge while the flats stay flat. Without the threshold a smooth-shaded
    box looks inflated rather than rounded.

Neither trick moves anything: the anchors, their names and their counts are the
contract, and they are asserted at the bottom of this file.

What is deliberately *not* here
-------------------------------
There is no solid ceiling. The office is presented as a dollhouse - you look down
into it - and every mesh in the model casts a shadow, so a ceiling would both hide
the rooms and put every desk in shadow. Exposed beams and pendant lights give the
dev floor a ceiling line without closing the box, and the enclosed rooms get a
recessed panel for the same reason.

Run order (each script resets the scene, so this order is the only one that works):

    01_office_shell.py     the shell, with growth doorways in the side walls
    03_office_furniture.py this file
    99_export_glb.py       writes apps/web/public/office/office.glb

Coordinates are Blender's: X east-west, Y north-south, Z up, the shell's footprint
22 x 16 m centred on the origin, and the back strip (Y 3..8) holding the enclosed
rooms. The exporter converts to glTF's Y-up frame, so nothing here needs to know
about it.
"""

import bpy
import bmesh
import math
from mathutils import Vector

# ============================================================ scene check
# This script adds furniture to the shell. Run against an empty scene it would
# produce a furnished room with no walls, and the export would look wrong in a way
# that is easy to miss, so it refuses instead.
if not any(ob.name == "Floor_Slab" for ob in bpy.data.objects):
    print("=== dev3d FURNITURE REFUSED ===")
    print("No Floor_Slab in the scene, so 01_office_shell.py has not run.")
    print("The scripts each reset the scene; the order is 01, then 03, then 99.")
    raise SystemExit(1)

# ============================================================ shell constants
# Mirrored from 01_office_shell.py rather than imported, because each script is
# run on its own by Blender and neither can see the other's namespace. If the
# shell's footprint changes, these move with it.
W, D = 22.0, 16.0
H = 3.0
T = 0.15                      # exterior wall thickness
P = 0.12                      # interior partition thickness
X0, X1 = -W / 2, W / 2
Y0, Y1 = -D / 2, D / 2
YSPLIT = 3.0
DOOR_W = 1.4
LINTEL = 2.2
GROWTH_DOORS = (-4.0, 4.0)

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
    "wall_dk": mat("M_Wall_Accent", (0.20, 0.22, 0.26), rough=0.80),
    # The one genuinely new surface. The core asset had nothing emissive but a
    # monitor, and a ceiling fixture that glows monitor-blue reads as a bug; the
    # web dresses this by role, where 'light' is the brighter of the two emissives.
    "light": mat("M_Light_Panel", (0.92, 0.90, 0.84), rough=0.3, emit=(1.0, 0.94, 0.82)),
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
STRUCT = coll("Office_Structure")
ROOM_CEO = coll("Room_CEO")
ROOM_MEETING = coll("Room_Meeting")
ROOM_OFFICE2 = coll("Room_Office2")
ROOM_OFFICE3 = coll("Room_Office3")

# ============================================================ part library
#
# A part is a shape plus a surface. The shape is built once and indexed by
# (kind, size, surface, bevel), so two hundred identical office chairs are two
# hundred objects pointing at the same handful of meshes.

PARTS = {}

BEVEL = 0.006
BEVEL_SEGMENTS = 2
SMOOTH_ANGLE = math.radians(34.0)


def _shape_key(kind, size, surface, bevel, segments, verts):
    return (kind, tuple(round(v, 5) for v in size), surface, round(bevel, 5), segments, verts)


def _shade_smooth(ob, angle):
    """Smooth the rounded edges, and leave the flats flat.

    Blender moved this around: 4.1 replaced `use_auto_smooth` with an operator,
    and the operator itself was renamed on the way. All three are tried in order
    of preference rather than version-sniffed, and a fallback to flat shading means
    the worst case is a bevel with a hard edge on it rather than a crash.
    """
    for op in ("shade_smooth_by_angle", "shade_auto_smooth"):
        fn = getattr(bpy.ops.object, op, None)
        if fn is None:
            continue
        try:
            fn(angle=angle)
            return op
        except Exception:
            continue
    try:
        bpy.ops.object.shade_smooth()
        ob.data.use_auto_smooth = True
        ob.data.auto_smooth_angle = angle
        return "legacy"
    except Exception:
        bpy.ops.object.shade_flat()
        return "flat"


def _bevel(ob, size, width, segments):
    """Round every edge, as far as the part's thinnest axis allows.

    The clamp is load-bearing: an 8 mm bevel on a 14 mm-thick leaf would bevel the
    leaf out of existence, and on a book or a keyboard it would round the part into
    a lozenge. A third of the thinnest axis is the largest bevel that still leaves
    a flat face in the middle of it.
    """
    width = min(width, min(size) / 3.0)
    if width <= 0.0005:
        return 0.0
    mod = ob.modifiers.new(name="Bevel", type='BEVEL')
    mod.width = width
    mod.segments = segments
    mod.limit_method = 'ANGLE'
    mod.angle_limit = math.radians(30.0)
    try:
        mod.miter_outer = 'MITER_ARC'
    except Exception:
        pass
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return width


def _uv_world_scale(mesh, metres_per_tile=1.0):
    """Give a part UVs measured in *metres*: one UV unit is one metre of surface.

    Blender's own cube projection would do most of this, but it is an operator that
    wants a UV editor in the context and this runs headless. Projecting each face
    along its own dominant normal is not much more code and has no context to get
    wrong.

    This is the whole of texel density. An unwrap that fills 0..1 on every part -
    which is what a primitive gives you, and what this asset had - makes a 20 cm
    drawer and an 8 m floor slab wear the same number of texture pixels, so the
    drawer's material is a smear and the slab's is a blur. Measuring in metres
    instead means one tile of a surface covers one metre everywhere in the
    building, whatever the part is, and the browser's per-role tiling becomes an
    exact figure rather than the guess it used to be.
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


def _shape(kind, size, surface, material, bevel=BEVEL, segments=BEVEL_SEGMENTS, verts=24):
    """The shared mesh for one part, built on first use and cached after that."""
    key = _shape_key(kind, size, surface, bevel, segments, verts)
    found = PARTS.get(key)
    if found is not None:
        return found

    if kind == 'box':
        bpy.ops.mesh.primitive_cube_add(size=2.0)
        ob = bpy.context.active_object
        ob.scale = (size[0] / 2.0, size[1] / 2.0, size[2] / 2.0)
    else:
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=size[0] / 2.0, depth=size[2])
        ob = bpy.context.active_object
    ob.name = "Part_%s" % kind
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    _bevel(ob, size, bevel, segments)
    _shade_smooth(ob, SMOOTH_ANGLE)
    mesh = ob.data
    # After the bevel, so the rounded edges get UVs of their own rather than an
    # interpolation of the primitive's.
    _uv_world_scale(mesh)
    mesh.materials.append(material)
    # The mesh outlives the object that made it: it is the template every instance
    # is cut from, and it is why the detail here costs geometry rather than file
    # size. Blender keeps a zero-user mesh until something purges orphans, and the
    # export happens long before that.
    bpy.data.objects.remove(ob, do_unlink=True)
    PARTS[key] = mesh
    return mesh


def place(name, mesh, loc, into, rot=(0.0, 0.0, 0.0)):
    """One instance of a shared part. Rotation and position live on the object."""
    ob = bpy.data.objects.new(name, mesh)
    ob.location = loc
    ob.rotation_euler = rot
    into.objects.link(ob)
    return ob


def box(name, size, loc, into, material, rot=(0.0, 0.0, 0.0), bevel=BEVEL):
    """A bevelled, smooth-shaded box. size = full (X, Y, Z) dimensions in metres."""
    return place(name, _shape('box', size, material.name, material, bevel), loc, into, rot)


def cyl(name, radius, depth, loc, into, material, rot=(0.0, 0.0, 0.0), bevel=0.003, verts=24):
    """A bevelled cylinder. Its axis is Z until `rot` turns it."""
    size = (radius * 2.0, radius * 2.0, depth)
    mesh = _shape('cyl', size, material.name, material, bevel, verts=verts)
    return place(name, mesh, loc, into, rot)


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
SEAT_BACK = DESK_D / 2.0 + 0.34


def task_chair(tag, cx, cy, facing, into):
    """A task chair: five-star base, casters, gas lift, seat, back and armrests.

    The chair is the one piece of furniture an employee is *inside*, so it is the
    one worth spending parts on. The five-star base and its casters are what stop a
    seated person reading as a stack of boxes balanced on a post, and the seat is
    left at the height the old one was, because the avatar's seated pose was fitted
    to it.
    """
    cos, sin = math.cos(facing), math.sin(facing)

    def at(dx, dy):
        """A point in the chair's own frame, in world coordinates."""
        return (cx + dx * cos - dy * sin, cy + dx * sin + dy * cos)

    for i in range(5):
        angle = facing + i * (2.0 * math.pi / 5.0)
        arm_cos, arm_sin = math.cos(angle), math.sin(angle)
        box("Chair_%s_Arm_%d" % (tag, i), (0.30, 0.055, 0.030),
            (cx + arm_cos * 0.15, cy + arm_sin * 0.15, 0.052), into, M["chair"], (0.0, 0.0, angle))
        # The caster lies on its side, so its axis runs across the arm rather than
        # through the floor - which is what makes it read as a wheel.
        cyl("Chair_%s_Caster_%d" % (tag, i), 0.034, 0.026,
            (cx + arm_cos * 0.295, cy + arm_sin * 0.295, 0.034), into, M["frame"],
            (math.pi / 2.0, 0.0, angle), verts=14)

    cyl("Chair_%s_Lift" % tag, 0.030, 0.31, (cx, cy, 0.20), into, M["frame"], verts=18)
    cyl("Chair_%s_Shroud" % tag, 0.049, 0.17, (cx, cy, 0.30), into, M["chair"], verts=18)

    box("Chair_%s_Seat" % tag, (0.48, 0.46, 0.070), (cx, cy, 0.450), into, M["chair"], (0.0, 0.0, facing), bevel=0.016)
    box("Chair_%s_Pad" % tag, (0.43, 0.41, 0.022), (cx, cy, 0.496), into, M["chair_pad"], (0.0, 0.0, facing), bevel=0.010)

    bx, by = at(0.0, -0.205)
    box("Chair_%s_Back" % tag, (0.46, 0.055, 0.44), (bx, by, 0.72), into, M["chair"], (0.0, 0.0, facing), bevel=0.018)
    lx, ly = at(0.0, -0.170)
    box("Chair_%s_Lumbar" % tag, (0.40, 0.035, 0.21), (lx, ly, 0.66), into, M["chair_pad"], (0.0, 0.0, facing), bevel=0.012)

    for side in (-1, 1):
        ax, ay = at(side * 0.258, -0.03)
        box("Chair_%s_ArmPost_%d" % (tag, side), (0.036, 0.036, 0.19), (ax, ay, 0.585), into, M["frame"], (0.0, 0.0, facing))
        box("Chair_%s_ArmPad_%d" % (tag, side), (0.055, 0.26, 0.028), (ax, ay, 0.694), into, M["chair"], (0.0, 0.0, facing), bevel=0.010)


def meeting_chair(seat_name, x, y, facing):
    """A chair at the meeting table: four legs, a seat and a back.

    Simpler than the task chair on purpose. Eight of these ring a shared table, and
    armrests at 1.1 m spacing would merge their footprints into one solid ring in
    the walkability grid - which is how a room ends up with nowhere to stand.

    Its meshes are named `Chair_*`, not `Seat_*`, or the loader would count a seat
    back as a place to sit.
    """
    tag = seat_name[len("Seat_"):]
    cos, sin = math.cos(facing), math.sin(facing)
    for i, (dx, dy) in enumerate(((-0.185, -0.165), (0.185, -0.165), (-0.185, 0.165), (0.185, 0.165))):
        box("Chair_%s_Leg_%d" % (tag, i), (0.036, 0.036, 0.44),
            (x + dx * cos - dy * sin, y + dx * sin + dy * cos, 0.22), ROOM_MEETING, M["frame"], (0.0, 0.0, facing))
    box("Chair_%s_Seat" % tag, (0.45, 0.43, 0.055), (x, y, 0.468), ROOM_MEETING, M["chair_pad"], (0.0, 0.0, facing), bevel=0.014)
    box("Chair_%s_Back" % tag, (0.44, 0.05, 0.40),
        (x + math.sin(facing) * 0.195, y - math.cos(facing) * 0.195, 0.68), ROOM_MEETING, M["chair"],
        (0.0, 0.0, facing), bevel=0.016)
    empty(seat_name, (x, y, 0.0), AGENTS)


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

    def at(dx, dy):
        """A point in the desk's own frame, in world coordinates."""
        return (x + dx * cos - dy * sin, y + dx * sin + dy * cos)

    # The desk root: what `deskNameForSeat` resolves to, so an avatar faces it.
    empty(desk_name, (x, y, DESK_H), DESKS)

    tx, ty = at(0.0, 0.0)
    box("DeskTop_%s" % tag, (DESK_W, DESK_D, 0.042), (tx, ty, DESK_H - 0.021), DESKS, M["desk_top"],
        (0.0, 0.0, facing), bevel=0.009)
    box("DeskApron_%s" % tag, (DESK_W - 0.34, 0.045, 0.10), (tx, ty, DESK_H - 0.095), DESKS, M["desk"], (0.0, 0.0, facing))
    # A cable tray is the detail that says "someone works here" rather than
    # "someone placed a slab here", and it is two boxes.
    box("DeskTray_%s" % tag, (0.95, 0.12, 0.05), (tx, ty, DESK_H - 0.145), DESKS, M["frame"], (0.0, 0.0, facing))

    for i, side in enumerate((-1, 1)):
        lx, ly = at(side * (DESK_W / 2.0 - 0.10), 0.0)
        box("DeskLeg_%s_%d" % (tag, i), (0.055, DESK_D - 0.14, DESK_H - 0.042),
            (lx, ly, (DESK_H - 0.042) / 2.0), DESKS, M["frame"], (0.0, 0.0, facing), bevel=0.010)

    # ---- the screen: a panel set into a bezel, on a column and a foot ----
    #
    # At the *back* of the desk, at +dy. It used to be at -0.22 with the keyboard at
    # +0.10, which put the keyboard 0.32 m behind the monitor: from the seat you
    # looked at the screen and reached past it to type. `at` measures from the desk's
    # centre and the seat is at -SEAT_BACK, so +dy is away from the person.
    mx, my = at(0.0, 0.22)
    box("ScreenPanel_%s" % tag, (0.595, 0.020, 0.335), (mx, my, DESK_H + 0.30), DESKS, M["screen"], (0.0, 0.0, facing))
    for edge, (dx, dz, size) in (
        ("T", (0.0, 0.178, (0.625, 0.030, 0.020))),
        ("B", (0.0, -0.178, (0.625, 0.030, 0.020))),
        ("L", (-0.312, 0.0, (0.020, 0.030, 0.355))),
        ("R", (0.312, 0.0, (0.020, 0.030, 0.355))),
    ):
        ex, ey = at(dx, 0.215)
        box("ScreenBezel_%s_%s" % (tag, edge), size, (ex, ey, DESK_H + 0.30 + dz), DESKS, M["chair"],
            (0.0, 0.0, facing), bevel=0.004)
    box("ScreenNeck_%s" % tag, (0.05, 0.05, 0.13), (mx, my, DESK_H + 0.065), DESKS, M["chair"], (0.0, 0.0, facing))
    box("ScreenFoot_%s" % tag, (0.26, 0.18, 0.016), (mx, my, DESK_H + 0.008), DESKS, M["chair"],
        (0.0, 0.0, facing), bevel=0.006)

    # ---- what is actually on the desk, on the near side of the screen ----
    kx, ky = at(0.0, -0.10)
    box("Keyboard_%s" % tag, (0.36, 0.13, 0.016), (kx, ky, DESK_H + 0.008), DESKS, M["chair"],
        (0.0, 0.0, facing), bevel=0.005)
    px, py = at(0.30, -0.10)
    box("Mouse_%s" % tag, (0.065, 0.105, 0.026), (px, py, DESK_H + 0.013), DESKS, M["chair"],
        (0.0, 0.0, facing), bevel=0.011)
    gx, gy = at(-0.44, -0.02)
    cyl("Mug_%s" % tag, 0.038, 0.092, (gx, gy, DESK_H + 0.046), DESKS, M["accent"], verts=18)

    # ---- the chair, behind the desk where the employee sits ----
    cx, cy = at(0.0, -SEAT_BACK)
    task_chair(tag, cx, cy, facing, DESKS)
    empty(seat_name, (cx, cy, 0.0), AGENTS)


def plant(name, x, y, into, scale=1.0):
    """A potted plant: a real pot, and leaves that are actually leaves.

    What was here before was one box the size of a shrub. Nine tilted leaves cost
    forty triangles each and are the whole difference between foliage and a green
    cube - and they are fanned by a fixed sequence rather than at random, so the
    asset is byte-identical on every build.
    """
    cyl("%s_Pot" % name, 0.155 * scale, 0.27 * scale, (x, y, 0.135 * scale), into, M["frame"], verts=20)
    cyl("%s_Rim" % name, 0.170 * scale, 0.035 * scale, (x, y, 0.262 * scale), into, M["frame"], verts=20)
    for i in range(9):
        angle = i * (2.0 * math.pi / 9.0)
        tilt = 0.34 + (i % 3) * 0.15
        reach = (0.09 + (i % 4) * 0.035) * scale
        height = (0.36 + (i % 5) * 0.075) * scale
        box("%s_Leaf_%d" % (name, i), (0.082 * scale, 0.30 * scale, 0.013 * scale),
            (x + math.cos(angle) * reach, y + math.sin(angle) * reach, height), into, M["plant"],
            (tilt, 0.0, angle), bevel=0.005)


def sofa(name, x, y, into):
    """A lounge sofa built as a frame, two arms and separate cushions.

    One box with a back is a bench. The cushions are what make it furniture: they
    break the silhouette into the shape the eye already knows.
    """
    box("%s_Base" % name, (2.52, 0.95, 0.26), (x, y, 0.20), into, M["soft"], bevel=0.020)
    box("%s_Back" % name, (2.52, 0.22, 0.50), (x, y - 0.365, 0.58), into, M["soft"], bevel=0.020)
    for side in (-1, 1):
        box("%s_Arm_%d" % (name, side), (0.20, 0.95, 0.30), (x + side * 1.16, y, 0.48), into, M["soft"], bevel=0.024)
        box("%s_Leg_%d" % (name, side), (0.05, 0.05, 0.08), (x + side * 1.12, y + 0.40, 0.04), into, M["frame"])
        box("%s_LegB_%d" % (name, side), (0.05, 0.05, 0.08), (x + side * 1.12, y - 0.40, 0.04), into, M["frame"])
    for i, offset in enumerate((-0.80, 0.0, 0.80)):
        box("%s_SeatCushion_%d" % (name, i), (0.78, 0.72, 0.15), (x + offset, y + 0.05, 0.405), into, M["chair_pad"], bevel=0.028)
        box("%s_BackCushion_%d" % (name, i), (0.76, 0.17, 0.30), (x + offset, y - 0.29, 0.62), into, M["chair_pad"], bevel=0.028)


def coffee_table(name, x, y, into):
    box("%s_Top" % name, (1.20, 0.70, 0.042), (x, y, 0.40), into, M["desk_top"], bevel=0.010)
    for i, (dx, dy) in enumerate(((-0.50, -0.28), (0.50, -0.28), (-0.50, 0.28), (0.50, 0.28))):
        cyl("%s_Leg_%d" % (name, i), 0.021, 0.38, (x + dx, y + dy, 0.19), into, M["frame"], verts=14)
    cyl("%s_Bowl" % name, 0.10, 0.07, (x, y, 0.455), into, M["accent"], verts=20)


def bookcase(name, x, y, into):
    """A bookcase: two sides, a back, four shelves and something on them."""
    box("%s_Back" % name, (2.36, 0.02, 1.12), (x, y + 0.19, 0.56), into, M["desk"])
    for side in (-1, 1):
        box("%s_Side_%d" % (name, side), (0.03, 0.40, 1.15), (x + side * 1.185, y, 0.575), into, M["desk"])
    for i, height in enumerate((0.18, 0.47, 0.76, 1.10)):
        box("%s_Shelf_%d" % (name, i), (2.38, 0.40, 0.026), (x, y, height), into, M["desk"], bevel=0.004)
    # Books, in three blocks of three, so the shelves do not read as empty.
    for block, hx in enumerate((-0.86, 0.0, 0.80)):
        for j in range(3):
            box("%s_Book_%d_%d" % (name, block, j), (0.055, 0.20, 0.24 - j * 0.03),
                (x + hx + j * 0.062, y + 0.02, 0.30 + 0.24 / 2 - 0.015), into,
                M["accent"] if (block + j) % 2 == 0 else M["soft"], bevel=0.003)


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
    box("DevFloor_Rug_%d" % i, (19.0, 2.6, 0.02), (0.0, y, 0.012), DEV, M["rug"], bevel=0.008)

# ---- the CEO's office: X -11..-4 in the back strip --------------------------
# `math.pi` faces the desk south, so the CEO sits with their back to the north
# wall and the window the ceiling lights do not provide.
workstation("Seat_CEO", "Desk_CEO", -7.6, 5.6, math.pi)
bookcase("CEO_Bookcase", -9.6, 7.5, ROOM_CEO)
plant("CEO_Plant", -4.8, 7.35, ROOM_CEO, scale=1.15)
box("CEO_Credenza", (1.5, 0.42, 0.62), (-5.6, 7.6, 0.31), ROOM_CEO, M["desk"], bevel=0.012)

# ---- the two small offices --------------------------------------------------
workstation("Seat_Office2", "Desk_Office2", -2.0, 5.6, math.pi)
workstation("Seat_Office3", "Desk_Office3", 1.5, 5.6, math.pi)
plant("Office2_Plant", -3.6, 7.3, ROOM_OFFICE2, scale=0.85)
plant("Office3_Plant", 2.6, 7.3, ROOM_OFFICE3, scale=0.85)

# ---- the meeting room: X 3..11, one table and eight chairs ------------------
TABLE_X, TABLE_Y = 7.0, 5.5
box("Meeting_Table_Top", (4.6, 1.5, 0.058), (TABLE_X, TABLE_Y, 0.74), ROOM_MEETING, M["table"], bevel=0.014)
for i, offset in enumerate((-1.40, 1.40)):
    box("Meeting_Table_Pedestal_%d" % i, (1.05, 0.88, 0.68), (TABLE_X + offset, TABLE_Y, 0.34), ROOM_MEETING, M["table"], bevel=0.010)
# Four chairs a side, facing the table across it.
for i in range(4):
    offset = -1.65 + i * 1.1
    meeting_chair("Seat_Meeting_%02d" % (i + 1), TABLE_X + offset, TABLE_Y - 1.15, math.pi)
    meeting_chair("Seat_Meeting_%02d" % (i + 5), TABLE_X + offset, TABLE_Y + 1.15, 0.0)

# A whiteboard on the back wall, because a meeting room without one is a room with
# a table in it.
box("Meeting_Board_Frame", (2.80, 0.05, 1.26), (TABLE_X, Y1 - 0.035, 1.62), ROOM_MEETING, M["frame"], bevel=0.008)
box("Meeting_Board", (2.72, 0.02, 1.18), (TABLE_X, Y1 - 0.070, 1.62), ROOM_MEETING, M["wall"], bevel=0.004)
box("Meeting_Board_Tray", (2.80, 0.09, 0.028), (TABLE_X, Y1 - 0.085, 0.99), ROOM_MEETING, M["desk_top"], bevel=0.006)

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
sofa("Lounge_Sofa", -8.6, -6.4, DEV)
coffee_table("Lounge_Table", -8.6, -5.25, DEV)
plant("Lounge_Plant", -10.1, -7.2, DEV, scale=1.0)
box("Lounge_Shelf", (1.9, 0.32, 0.04), (-8.6, -7.35, 0.86), DEV, M["desk_top"], bevel=0.008)

# ---- the lobby: a reception desk, so the front door has somewhere to arrive --
box("Lobby_Desk", (3.40, 0.70, 0.05), (0.0, -7.4, 1.025), DEV, M["desk_top"], bevel=0.010)
box("Lobby_Desk_Front", (3.40, 0.05, 0.92), (0.0, -7.06, 0.52), DEV, M["desk"], bevel=0.008)
for side in (-1, 1):
    box("Lobby_Desk_Side_%d" % side, (0.05, 0.70, 0.92), (side * 1.675, -7.4, 0.52), DEV, M["desk"], bevel=0.008)
box("Lobby_Desk_Trim", (3.40, 0.06, 0.08), (0.0, -7.06, 1.05), DEV, M["accent"])

# ============================================================ architectural detail
def skirt(name, along, fixed, span, gaps):
    """Skirting board: the 11 cm band where a wall stops meeting a floor.

    It is the cheapest architectural detail there is - one box per wall run - and
    it is also the one that most reliably makes a room read as *finished* rather
    than as a massing model, because it gives the wall a base and the floor an
    edge to end at. Doorways are left open, so a run that crosses one is cut.
    """
    cuts = sorted((c - DOOR_W / 2.0, c + DOOR_W / 2.0) for c in gaps)
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
            box("%s_%d" % (name, index), (length, 0.022, 0.11), (mid, fixed, 0.055), STRUCT, M["wall_dk"], bevel=0.004)
        else:
            box("%s_%d" % (name, index), (0.022, length, 0.11), (fixed, mid, 0.055), STRUCT, M["wall_dk"], bevel=0.004)
        index += 1


# Perimeter. The side runs are cut at the growth doorways, or the skirting would
# draw a line straight across a doorway.
skirt("Skirt_Back", 'x', Y1 - 0.011, (X0, X1), ())
skirt("Skirt_Front", 'x', Y0 + 0.011, (X0, X1), ())
skirt("Skirt_Left", 'y', X0 + 0.011, (Y0, Y1), GROWTH_DOORS)
skirt("Skirt_Right", 'y', X1 - 0.011, (Y0, Y1), GROWTH_DOORS)
# The partitions between the back rooms, both faces.
for i, x in enumerate((-4.0, 0.0, 3.0)):
    for side in (-1, 1):
        skirt("Skirt_Part_%d_%d" % (i, side), 'y', x + side * (P / 2.0 + 0.011), (YSPLIT, Y1), ())
# The corridor wall, dev-floor side and room side.
for i, (lo, hi) in enumerate(((-11.0, -4.0), (-4.0, 0.0), (0.0, 3.0))):
    for side in (-1, 1):
        skirt("Skirt_Corr_%d_%d" % (i, side), 'x', YSPLIT + side * (P / 2.0 + 0.011), (lo, hi), ())

# Door architraves at the four growth doorways in the side walls. They sit just
# outside the opening rather than in it, so they frame the doorway without
# narrowing it - which matters, because the walkability grid inflates every
# obstacle by the walker's radius.
for side, x in ((-1, X0), (1, X1)):
    for door in GROWTH_DOORS:
        for j, edge in enumerate((-1, 1)):
            box("Portal_%d_%d_%d" % (side, int(door), j), (T + 0.04, 0.055, LINTEL),
                (x, door + edge * (DOOR_W / 2.0 + 0.028), LINTEL / 2.0), STRUCT, M["frame"], bevel=0.006)
        box("Portal_%d_%d_Head" % (side, int(door)), (T + 0.04, DOOR_W + 0.17, 0.055),
            (x, door, LINTEL + 0.028), STRUCT, M["frame"], bevel=0.006)

# ---- the ceiling line, and the lights that hang from it ----
#
# See the note at the top of the file: exposed structure rather than a ceiling.
for i, y in enumerate(DEV_ROWS):
    box("Ceiling_Beam_%d" % i, (W, 0.18, 0.15), (0.0, y, 2.925), STRUCT, M["wall_dk"], bevel=0.008)
    for j, x in enumerate((-8.0, 0.0, 8.0)):
        tag = "%d_%d" % (i, j)
        cyl("Pendant_Cord_%s" % tag, 0.012, 0.34, (x, y, 2.68), DEV, M["frame"], verts=8)
        cyl("Pendant_Shade_%s" % tag, 0.19, 0.075, (x, y, 2.49), DEV, M["wall_dk"], verts=22)
        cyl("Pendant_Lamp_%s" % tag, 0.165, 0.014, (x, y, 2.448), DEV, M["light"], verts=22)

# Recessed panels in the enclosed rooms. They sit above 1.75 m, which keeps them
# out of the walkability band entirely - a floor light is not an obstacle.
for name, x, y in (("CEO", -7.5, 5.5), ("Office2", -2.0, 5.5), ("Office3", 1.5, 5.5), ("Meeting", TABLE_X, 5.2)):
    box("Room_Light_%s" % name, (1.30, 0.32, 0.03), (x, y, 2.955), STRUCT, M["light"], bevel=0.006)

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
# Unique mesh datablocks, which is the number the export actually writes: every
# instance above shares one of these.
unique = set(o.data.name for o in meshes)

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
print("meshes: %d instances of %d shared shapes | polygons: %d" % (len(meshes), len(unique), polys))
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
