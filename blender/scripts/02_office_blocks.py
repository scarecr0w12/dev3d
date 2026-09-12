"""dev3d - the office block kit.

A floor is not one hand-authored room any more: it is the core office plus a
jigsaw of room modules attached to it. This script builds those modules and, in
the same pass, writes the sidecar that describes them.

Why one pass, and why a sidecar
------------------------------
Geometry and metadata that are written by two different steps drift. So the
block's size, its doorway edges, its seat anchors, its props and its furniture
style are emitted by the same code that builds its walls, and `blocks.json`
cannot describe a block that does not exist. The three.js loader places seats by
looking up named nodes - never by hard-coded coordinates - and this file is the
index of which names exist where.

What a block carries now
------------------------
A module used to be four walls, a floor and a row of identical desks, and a
floor made of them read as one room photocopied. Each block now declares:

    furniture   how the inside is fitted out (desks, booths, racks, a gallery…)
    props       the loose objects that dress it (plants, shelves, a whiteboard…)
    kind        what it is for, and `category` groups kinds for a UI
    doors       which walls have a doorway - the only thing growth can use

Materials are named by *role*, not by look: `F_Wall`, `W_Partition`, `F_Desk`.
The palette in the GLB is a reasonable default, and the browser re-dresses every
role from the floor's own style, so a module looks like the floor it was built
on rather than like the file it came from.

Coordinates
-----------
Blender is Z-up, glTF is Y-up, and the exporter converts (blender X, Y, Z ->
gltf X, Z, -Y). Everything in `blocks.json` is written in the *browser* frame,
because that is where the assembly happens:

    x  east        z  south (positive z is toward the default camera)
    y  up          north is -z

A block's origin is its centre, at floor level. Doors are edges of that
rectangle, named for the compass direction their outward normal points. Empties
(six of them) carry the anchors; everything else is a mesh.

Run through the Blender MCP bridge (safe-mode compatible: bpy + mathutils +
stdlib only). Re-running is idempotent - the scene is reset first - and the
scene is left holding the kit, so run `01_office_shell.py` before re-exporting
the office itself.
"""

import bpy
import json
import math
import os
from mathutils import Matrix


def _office_dir():
    """Where the kit is written: `<repo>/apps/web/public/office`.

    Derived from this file's own location rather than hard-coded, so a checkout
    anywhere on any machine exports into its own tree. Blender's `--python` sets
    `__file__`; the MCP bridge may not, in which case the cwd is the bridge's
    own and no guess is possible, so `DEV3D_OFFICE_DIR` is the way to say.
    """
    override = os.environ.get("DEV3D_OFFICE_DIR")
    if override:
        return override
    source = globals().get("__file__")
    if source:
        repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(source))))
        return os.path.join(repo, "apps", "web", "public", "office")
    raise RuntimeError(
        "cannot locate the office directory: run this with Blender's --python "
        "(which sets __file__), or set DEV3D_OFFICE_DIR."
    )


OFFICE_DIR = _office_dir()
OUT_GLB = os.path.join(OFFICE_DIR, "blocks.glb")
OUT_JSON = os.path.join(OFFICE_DIR, "blocks.json")

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
        try:
            m.surface_render_method = 'BLENDED'
        except Exception:
            pass
    return m


# Names are roles, and the browser re-dresses every one of them from the floor's
# style. Two prefixes, deliberately: `W_` is the shell a module is made of, `F_`
# is what is inside it. A future role is a new name here plus one line in
# `apps/web/src/office/theme.ts`, and nothing else changes.
M = {
    # shell
    "slab":      mat("W_Slab", (0.15, 0.16, 0.18), rough=0.8),
    "floor":     mat("W_Floor", (0.18, 0.19, 0.21), rough=0.7),
    "carpet":    mat("W_Carpet", (0.11, 0.13, 0.17), rough=0.95),
    "wall":      mat("W_Wall", (0.62, 0.63, 0.66), rough=0.85),
    "accent":    mat("W_AccentWall", (0.22, 0.24, 0.28), rough=0.8),
    "partition": mat("W_Partition", (0.30, 0.33, 0.38), rough=0.9),
    "glass":     mat("W_Glass", (0.55, 0.72, 0.80), rough=0.05, alpha=0.22),
    "trim":      mat("W_Trim", (0.26, 0.29, 0.34), rough=0.6),
    # metalwork and structure
    "frame":     mat("F_Frame", (0.06, 0.06, 0.07), rough=0.35, metal=0.9),
    "rail":      mat("F_Rail", (0.12, 0.13, 0.15), rough=0.4, metal=0.7),
    # furniture
    "desk":      mat("F_Desk", (0.34, 0.27, 0.21), rough=0.55),
    "desk_top":  mat("F_DeskTop", (0.42, 0.34, 0.26), rough=0.45),
    "soft":      mat("F_Soft", (0.20, 0.28, 0.38), rough=0.9),
    "soft_deep": mat("F_SoftDeep", (0.16, 0.22, 0.32), rough=0.92),
    "rug":       mat("F_Rug", (0.16, 0.18, 0.24), rough=1.0),
    "plant":     mat("F_Plant", (0.13, 0.36, 0.20), rough=0.85),
    "board":     mat("F_Board", (0.90, 0.91, 0.93), rough=0.5),
    "cork":      mat("F_Cork", (0.48, 0.36, 0.24), rough=0.9),
    "storage":   mat("F_Storage", (0.26, 0.28, 0.32), rough=0.7),
    "art":       mat("F_Art", (0.72, 0.44, 0.28), rough=0.6),
    "fixture":   mat("F_Fixture", (0.94, 0.86, 0.70), rough=0.35, emit=(1.0, 0.78, 0.45)),
    "neon":      mat("F_Neon", (0.55, 0.78, 0.95), rough=0.3, emit=(0.45, 0.80, 1.0)),
    "screen":    mat("F_Screen", (0.02, 0.03, 0.05), rough=0.25, emit=(0.25, 0.55, 0.80)),
    "screen_off": mat("F_ScreenOff", (0.06, 0.07, 0.09), rough=0.35),
}


# ---- shared primitive geometry ---------------------------------------------
#
# Every box in this kit is the same 24-vertex cube, differing only by size and
# placement. Building one cube per part made the exporter emit one mesh, one
# accessor set and one bufferView per part - 2.4 MB of GLB for a kit whose
# geometry is a few hundred kilobytes, and the browser paid for it on load.
#
# So the cube (and the cylinder) is built once and *shared*, with each object's
# size applied to the mesh and its placement left on the object, which is what
# the exporter dedupes on. The shape cache is keyed by a rounded size, because
# two parts that differ by a thousandth of a metre are the same part.
_CUBE = None
_CYLINDER = None
_SHAPE_CACHE = {}


def _cube_mesh():
    global _CUBE
    if _CUBE is None:
        bpy.ops.mesh.primitive_cube_add(size=2.0, location=(0.0, 0.0, 0.0))
        ob = bpy.context.active_object
        _CUBE = ob.data
        _CUBE.name = "Shape_Cube"
        bpy.data.objects.remove(ob, do_unlink=True)
    return _CUBE


def _cylinder_mesh(vertices):
    global _CYLINDER
    if _CYLINDER is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=0.5, depth=1.0, location=(0.0, 0.0, 0.0))
        ob = bpy.context.active_object
        _CYLINDER = ob.data
        _CYLINDER.name = "Shape_Cylinder"
        bpy.data.objects.remove(ob, do_unlink=True)
    return _CYLINDER


def _sized_mesh(base, size, key, material):
    """A shared mesh scaled to `size`, made once per distinct size *and surface*.

    The material is part of the key because a mesh carries its material list: a
    desk top and a coat rack can be the same box, but they must not be the same
    surface. Twelve primitives times two dozen materials is still a couple of
    hundred meshes instead of fifteen hundred.
    """
    surface = material.name if material is not None else "-"
    cache_key = (key, surface, round(size[0], 4), round(size[1], 4), round(size[2], 4))
    found = _SHAPE_CACHE.get(cache_key)
    if found is not None:
        return found
    mesh = base.copy()
    mesh.name = "Shape_%s_%s_%d" % (key, surface, len(_SHAPE_CACHE))
    mesh.transform(Matrix.Diagonal((size[0] / 2.0, size[1] / 2.0, size[2] / 2.0, 1.0)))
    if material is not None:
        mesh.materials.append(material)
    _SHAPE_CACHE[cache_key] = mesh
    return mesh


def _link(name, mesh, loc, rot, coll):
    """One object on a shared mesh: only the placement is per object."""
    ob = bpy.data.objects.new(name, mesh)
    ob.location = loc
    ob.rotation_euler = rot
    coll.objects.link(ob)
    return ob


def box(name, size, loc, coll, material=None, rot=(0.0, 0.0, 0.0)):
    """Axis-aligned box. size = full (X, Y, Z) dimensions in metres."""
    return _link(name, _sized_mesh(_cube_mesh(), size, "Cube", material), loc, rot, coll)


def cyl(name, radius, depth, loc, coll, material=None, vertices=12, rot=(0.0, 0.0, 0.0)):
    """A cylinder. Twelve sides is a pot, a stool or a lamp post at this scale."""
    shape = (radius * 2.0, radius * 2.0, depth)
    return _link(name, _sized_mesh(_cylinder_mesh(vertices), shape, "Cyl", material), loc, rot, coll)


def empty(name, loc, coll):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = 'PLAIN_AXES'
    ob.empty_display_size = 0.4
    ob.location = loc
    coll.objects.link(ob)
    return ob


# ============================================================ dimensions
# A block is a whole number of metres on every side, and every size below is a
# multiple of 2 so two blocks along the core's 16 m wall can always be found
# that tile it exactly. Walls are 3 m, doorways 1.4 m wide and 2.2 m to the
# lintel - the same figures the core shell uses, so a doorway between a core and
# a module reads as one opening rather than two.
WALL_H = 3.0
WALL_T = 0.15
DOOR_W = 1.4
LINTEL = 2.2

DESK_W, DESK_D, DESK_H = 1.6, 0.8, 0.74
SEAT_OFFSET = 0.42
# A desk row plus the chair behind it needs this much clear depth. Every block
# that seats anybody is validated against it, so a new size cannot quietly ship
# with its desks through the wall.
ROW_DEPTH = 3.0


def edges_with_doors(doors):
    """Where each doorway sits, in metres measured along its own wall.

    Every doorway is centred on its wall, which is what keeps two 8 m blocks
    meeting a 16 m core wall symmetric.
    """
    return [(edge, 0.0) for edge in doors]


def build_wall(name, along, fixed, span, doors_at, coll, root, material):
    """One wall with door gaps, along `along` ('x' or 'y') at `fixed`."""
    cuts = [(c - DOOR_W / 2.0, c + DOOR_W / 2.0) for c in doors_at]
    cuts.sort()
    edges = [span[0]]
    for a, b in cuts:
        edges.append(a)
        edges.append(b)
    edges.append(span[1])

    def part(part_name, size, loc):
        ob = box(part_name, size, loc, coll, material)
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


# ============================================================ furniture builders
#
# One function per way of fitting a room out. Each returns the seat names it
# created, and each seat it creates is paired with a `Desk_*` empty at the
# surface the employee faces - a desk, a table, a rack. The UI derives an
# avatar's facing from exactly that pair, so a seat with no desk anchor would
# leave somebody spinning on the spot.
#
# Conventions, all of them Blender's frame:
#   X  along the block's width     Y  along its depth (+Y is browser-north)
#   facing 0 means the desk faces +Y, i.e. the employee sits at -Y of it.


class Block:
    """One module under construction: its collection, its root, its seats."""

    def __init__(self, spec, coll, root):
        self.spec = spec
        self.coll = coll
        self.root = root
        self.seats = []
        self.prop_count = 0

    def part(self, name, size, loc, material, rot=(0.0, 0.0, 0.0)):
        ob = box(name, size, loc, self.coll, material, rot)
        ob.parent = self.root
        ob.matrix_parent_inverse = self.root.matrix_world.inverted()
        return ob

    def tube(self, name, radius, depth, loc, material, rot=(0.0, 0.0, 0.0)):
        ob = cyl(name, radius, depth, loc, self.coll, material, rot=rot)
        ob.parent = self.root
        ob.matrix_parent_inverse = self.root.matrix_world.inverted()
        return ob

    def anchor(self, name, loc):
        ob = empty(name, loc, self.coll)
        ob.parent = self.root
        ob.matrix_parent_inverse = self.root.matrix_world.inverted()
        return ob

    def seat(self, index, seat_name, desk_name, x, y, facing, desk_at=None):
        """A desk, its screen, a chair, and the two anchors the UI looks up.

        Naming rule, and it is load-bearing: **only the anchor empties carry a
        reserved prefix.** `Seat_*` is a place to sit and `Desk_*` is what the
        person there faces; a mesh named `Seat_BOOTH_01_Pad` would be offered as
        a second place to sit, so every mesh here is named for what it is.

        `desk_at` moves the `Desk_*` anchor off the desk it builds - a workshop
        bench seats people at a bench across the room, and what they face is the
        bench, not the desk in front of them.
        """
        tag = seat_name[len("Seat_"):]
        cos, sin = math.cos(facing), math.sin(facing)

        # The desk root: what `deskNameForSeat` resolves to, so an avatar faces it.
        anchor_at = desk_at if desk_at is not None else (x, y, DESK_H)
        self.anchor(desk_name, anchor_at)

        self.part("DeskTop_%s" % tag, (DESK_W, DESK_D, 0.05), (x, y, DESK_H), M["desk_top"], (0, 0, facing))
        self.part("DeskApron_%s" % tag, (DESK_W - 0.2, DESK_D - 0.1, 0.10), (x, y, DESK_H - 0.09),
                  M["desk"], (0, 0, facing))
        for i, side in enumerate((-1, 1)):
            lx = x + side * (DESK_W / 2.0 - 0.09) * cos
            ly = y + side * (DESK_W / 2.0 - 0.09) * sin
            self.part("DeskLeg_%s_%d" % (tag, i), (0.07, DESK_D - 0.12, DESK_H - 0.1),
                      (lx, ly, (DESK_H - 0.1) / 2.0), M["frame"], (0, 0, facing))

        # Screen stand + panel, on the far side of the desk from the seat. Every
        # third workstation is dark, because a floor of uniformly glowing
        # monitors looks like a render rather than an office.
        sx = x - sin * -0.22
        sy = y + cos * -0.22
        screen_mat = M["screen"] if index % 3 != 2 else M["screen_off"]
        self.part("ScreenPanel_%s" % tag, (0.62, 0.03, 0.36), (sx, sy, DESK_H + 0.30),
                  screen_mat, (0, 0, facing))
        self.part("ScreenStand_%s" % tag, (0.12, 0.12, 0.16), (sx, sy, DESK_H + 0.06),
                  M["frame"], (0, 0, facing))

        # Chair: seat pad, backrest, post. Behind the desk, where the worker sits.
        cx = x + sin * (DESK_D / 2.0 + 0.34)
        cy = y - cos * (DESK_D / 2.0 + 0.34)
        self.part("ChairSeat_%s" % tag, (0.46, 0.44, 0.06), (cx, cy, 0.46), M["soft"], (0, 0, facing))
        self.part("ChairBack_%s" % tag, (0.44, 0.06, 0.42), (cx + sin * 0.2, cy - cos * 0.2, 0.68),
                  M["soft_deep"], (0, 0, facing))
        self.part("ChairPost_%s" % tag, (0.07, 0.07, 0.44), (cx, cy, 0.22), M["frame"], (0, 0, facing))

        self.anchor(seat_name, (cx, cy, 0.0))
        self.seats.append(seat_name)

    def chair(self, seat_name, desk_name, x, y, facing, anchor=None):
        """A chair at a shared table, with the table itself as the anchor.

        A meeting chair has no desk of its own, so the anchor sits on the table
        edge the chair is pulled up to. That is both truthful - it is what the
        person is facing - and the only thing that keeps `seatFacing` from
        falling back to the room centre, which would have half the table looking
        at the wrong wall.
        """
        tag = seat_name[len("Seat_"):]
        self.anchor(desk_name, (x, y, DESK_H) if anchor is None else (anchor[0], anchor[1], DESK_H))
        self.part("Chair_%s_Seat" % tag, (0.44, 0.42, 0.06), (x, y, 0.45), M["soft"], (0, 0, facing))
        self.part("Chair_%s_Back" % tag, (0.44, 0.06, 0.40),
                  (x + math.sin(facing) * 0.19, y - math.cos(facing) * 0.19, 0.66),
                  M["soft_deep"], (0, 0, facing))
        self.part("Chair_%s_Post" % tag, (0.07, 0.07, 0.42), (x, y, 0.21), M["frame"], (0, 0, facing))
        self.anchor(seat_name, (x, y, 0.0))
        self.seats.append(seat_name)

    def sofa(self, seat_name, x, y, facing, width=1.8):
        """A soft seat, anchored just in front of itself.

        A sofa has no desk and no table, so `seat` puts the anchor at the front
        edge of the cushion: `seatFacing` reads that as "looking out of the
        seat", which is the only sensible answer for a lounge. The `Desk_*`
        anchor is still built, or the room would offer a seat facing nowhere.
        """
        tag = seat_name[len("Seat_"):]
        cos, sin = math.cos(facing), math.sin(facing)
        self.part("Sofa_%s_Base" % tag, (width, 0.9, 0.40), (x, y, 0.22), M["soft"], (0, 0, facing))
        self.part("Sofa_%s_Back" % tag, (width, 0.22, 0.44), (x - sin * 0.34, y + cos * 0.34, 0.62),
                  M["soft_deep"], (0, 0, facing))
        for side in (-1, 1):
            self.part("Sofa_%s_Arm_%d" % (tag, 0 if side < 0 else 1), (0.18, 0.86, 0.24),
                      (x + side * (width / 2.0 - 0.09) * cos, y + side * (width / 2.0 - 0.09) * sin, 0.52),
                      M["soft_deep"], (0, 0, facing))
        self.seat(0, seat_name, desk_name(seat_name), x, y - 0.55, facing)

    def stool(self, seat_name, x, y):
        """A stool at a counter: a perch, not a desk, anchored on the counter."""
        tag = seat_name[len("Seat_"):]
        self.anchor("Desk_%s" % tag, (x, y - 0.62, DESK_H))
        self.tube("Stool_%s_Pad" % tag, 0.19, 0.07, (x, y, 0.66), M["soft"])
        self.tube("Stool_%s_Post" % tag, 0.045, 0.62, (x, y, 0.33), M["frame"])
        self.tube("Stool_%s_Base" % tag, 0.2, 0.03, (x, y, 0.03), M["frame"])
        self.anchor(seat_name, (x, y, 0.0))
        self.seats.append(seat_name)


# ---- props -----------------------------------------------------------------
#
# A prop is a small cluster of boxes. `PROP_BUILDERS` is the whole vocabulary,
# and a block declares which of them it carries and where; the list travels to
# `blocks.json` so the console can describe a room without loading the GLB.

def prop_plant(b, tag, x, y):
    b.part("Prop_%s_Pot" % tag, (0.34, 0.34, 0.30), (x, y, 0.15), M["storage"])
    b.part("Prop_%s_Foliage" % tag, (0.52, 0.52, 0.62), (x, y, 0.60), M["plant"])
    b.part("Prop_%s_Leaf" % tag, (0.66, 0.30, 0.24), (x, y, 0.86), M["plant"])


def prop_tall_plant(b, tag, x, y):
    b.part("Prop_%s_Pot" % tag, (0.42, 0.42, 0.36), (x, y, 0.18), M["storage"])
    b.tube("Prop_%s_Stem" % tag, 0.05, 0.9, (x, y, 0.72), M["frame"])
    b.part("Prop_%s_Crown" % tag, (0.72, 0.72, 0.70), (x, y, 1.38), M["plant"])
    b.part("Prop_%s_CrownHi" % tag, (0.46, 0.46, 0.40), (x, y, 1.78), M["plant"])


def prop_whiteboard(b, tag, x, y):
    b.part("Prop_%s_Board" % tag, (2.0, 0.06, 1.2), (x, y, 1.55), M["board"])
    b.part("Prop_%s_Frame" % tag, (2.08, 0.05, 0.06), (x, y + 0.01, 2.16), M["rail"])
    b.part("Prop_%s_Tray" % tag, (2.0, 0.12, 0.05), (x, y, 0.93), M["rail"])


def prop_pinboard(b, tag, x, y):
    b.part("Prop_%s_Board" % tag, (1.6, 0.05, 1.0), (x, y, 1.6), M["cork"])
    b.part("Prop_%s_Note" % tag, (0.3, 0.02, 0.22), (x - 0.4, y - 0.04, 1.75), M["board"])
    b.part("Prop_%s_Note2" % tag, (0.26, 0.02, 0.2), (x + 0.42, y - 0.04, 1.66), M["art"])


def prop_shelf(b, tag, x, y):
    b.part("Prop_%s_Carcass" % tag, (1.4, 0.4, 1.8), (x, y, 0.9), M["storage"])
    for i in range(3):
        z = 0.42 + i * 0.46
        b.part("Prop_%s_Shelf_%d" % (tag, i), (1.3, 0.34, 0.04), (x, y - 0.02, z), M["desk"])
        b.part("Prop_%s_Books_%d" % (tag, i), (0.9, 0.24, 0.22), (x - 0.1, y - 0.04, z + 0.13),
               M["art"] if i == 0 else M["accent"])


def prop_storage(b, tag, x, y):
    b.part("Prop_%s_Body" % tag, (1.2, 0.45, 0.78), (x, y, 0.39), M["storage"])
    b.part("Prop_%s_Handle" % tag, (0.34, 0.04, 0.04), (x, y - 0.24, 0.6), M["rail"])


def prop_lockers(b, tag, x, y):
    b.part("Prop_%s_Body" % tag, (1.2, 0.45, 1.9), (x, y, 0.95), M["storage"])
    for i in range(3):
        bx = x - 0.4 + i * 0.4
        b.part("Prop_%s_Door_%d" % (tag, i), (0.36, 0.04, 1.7), (bx, y - 0.24, 0.98), M["accent"])
        b.part("Prop_%s_Vent_%d" % (tag, i), (0.2, 0.03, 0.05), (bx, y - 0.27, 1.6), M["rail"])


def prop_coat_rack(b, tag, x, y):
    b.tube("Prop_%s_Post" % tag, 0.05, 1.7, (x, y, 0.85), M["frame"])
    b.tube("Prop_%s_Base" % tag, 0.22, 0.04, (x, y, 0.02), M["frame"])
    b.part("Prop_%s_Arm" % tag, (0.5, 0.05, 0.05), (x, y, 1.62), M["rail"])
    b.part("Prop_%s_Coat" % tag, (0.34, 0.22, 0.7), (x + 0.16, y, 1.2), M["soft_deep"])


def prop_water(b, tag, x, y):
    b.part("Prop_%s_Body" % tag, (0.34, 0.34, 0.86), (x, y, 1.05), M["board"])
    b.part("Prop_%s_Bottle" % tag, (0.26, 0.26, 0.5), (x, y, 1.7), M["glass"])
    b.part("Prop_%s_Tap" % tag, (0.06, 0.12, 0.06), (x, y - 0.17, 1.36), M["rail"])
    b.part("Prop_%s_Drip" % tag, (0.22, 0.22, 0.04), (x, y, 0.62), M["rail"])


def prop_coffee(b, tag, x, y):
    b.part("Prop_%s_Counter" % tag, (1.6, 0.6, 0.9), (x, y, 0.45), M["storage"])
    b.part("Prop_%s_Top" % tag, (1.7, 0.66, 0.05), (x, y, 0.92), M["desk_top"])
    b.part("Prop_%s_Machine" % tag, (0.4, 0.36, 0.42), (x - 0.42, y, 1.16), M["rail"])
    b.part("Prop_%s_Grinder" % tag, (0.16, 0.16, 0.3), (x + 0.42, y, 1.1), M["frame"])
    b.part("Prop_%s_Cups" % tag, (0.14, 0.14, 0.16), (x + 0.1, y, 1.03), M["board"])


def prop_printer(b, tag, x, y):
    b.part("Prop_%s_Body" % tag, (0.7, 0.6, 0.5), (x, y, 0.65), M["storage"])
    b.part("Prop_%s_Stand" % tag, (0.6, 0.5, 0.4), (x, y, 0.2), M["rail"])
    b.part("Prop_%s_Tray" % tag, (0.5, 0.3, 0.06), (x, y - 0.35, 0.82), M["board"])
    b.part("Prop_%s_Light" % tag, (0.06, 0.03, 0.03), (x - 0.2, y - 0.31, 0.86), M["neon"])


def prop_lamp(b, tag, x, y):
    b.tube("Prop_%s_Base" % tag, 0.16, 0.04, (x, y, 0.02), M["frame"])
    b.tube("Prop_%s_Post" % tag, 0.035, 1.4, (x, y, 0.72), M["frame"])
    b.part("Prop_%s_Shade" % tag, (0.34, 0.34, 0.24), (x, y, 1.5), M["fixture"])


def prop_pendant(b, tag, x, y):
    b.tube("Prop_%s_Cord" % tag, 0.012, 0.62, (x, y, 2.69), M["frame"])
    b.part("Prop_%s_Cone" % tag, (0.44, 0.44, 0.28), (x, y, 2.24), M["fixture"])
    b.tube("Prop_%s_Bulb" % tag, 0.07, 0.1, (x, y, 2.04), M["neon"])


def prop_rug(b, tag, x, y):
    b.part("Prop_%s_Pile" % tag, (3.2, 2.2, 0.02), (x, y, 0.014), M["rug"])


def prop_partition(b, tag, x, y):
    b.part("Prop_%s_Panel" % tag, (0.12, 1.4, 1.5), (x, y, 0.75), M["partition"])
    b.part("Prop_%s_Cap" % tag, (0.16, 1.44, 0.06), (x, y, 1.53), M["rail"])
    b.part("Prop_%s_Foot" % tag, (0.4, 0.16, 0.05), (x, y, 0.03), M["rail"])


def prop_stool(b, tag, x, y):
    b.tube("Prop_%s_Pad" % tag, 0.19, 0.08, (x, y, 0.66), M["soft"])
    b.tube("Prop_%s_Post" % tag, 0.045, 0.62, (x, y, 0.33), M["frame"])
    b.tube("Prop_%s_Base" % tag, 0.2, 0.03, (x, y, 0.03), M["frame"])


def prop_screen(b, tag, x, y):
    b.tube("Prop_%s_Stand" % tag, 0.03, 0.5, (x, y, 0.25), M["frame"])
    b.tube("Prop_%s_Base" % tag, 0.18, 0.03, (x, y, 0.02), M["frame"])
    b.part("Prop_%s_Panel" % tag, (0.9, 0.05, 0.52), (x, y, 0.76), M["screen"])


def prop_art(b, tag, x, y):
    b.part("Prop_%s_Canvas" % tag, (0.9, 0.05, 0.7), (x, y, 1.7), M["art"])
    b.part("Prop_%s_Frame" % tag, (0.96, 0.04, 0.76), (x, y + 0.01, 1.7), M["rail"])


PROP_BUILDERS = {
    "plant": prop_plant,
    "tallPlant": prop_tall_plant,
    "whiteboard": prop_whiteboard,
    "pinboard": prop_pinboard,
    "shelf": prop_shelf,
    "storage": prop_storage,
    "lockers": prop_lockers,
    "coatRack": prop_coat_rack,
    "water": prop_water,
    "coffee": prop_coffee,
    "printer": prop_printer,
    "lamp": prop_lamp,
    "pendant": prop_pendant,
    "rug": prop_rug,
    "partition": prop_partition,
    "stool": prop_stool,
    "screen": prop_screen,
    "art": prop_art,
}


# ---- furniture -------------------------------------------------------------

def seat_row(b, count, along='x'):
    """Seat centres for `count` desks in one centred row along the block."""
    if count <= 0:
        return []
    if count == 1:
        return [0.0]
    reach = (DESK_W + 0.35) * (count - 1) / 2.0
    step = (reach * 2.0) / (count - 1)
    return [-reach + step * i for i in range(count)]


def next_seat_name(block_id, index):
    return "Seat_%s_%02d" % (block_id.upper(), index + 1)


def desk_name(seat_name):
    return "Desk_%s" % seat_name[len("Seat_"):]


def furnish_desks(b, spec):
    positions = seat_row(b, spec["seats"])
    for i, x in enumerate(positions):
        name = next_seat_name(spec["id"], i)
        b.seat(i, name, desk_name(name), x, 0.0, 0.0)


def furnish_workshop(b, spec):
    """A bench on the far wall, and seated positions along the near side."""
    w, d = spec["width"], spec["depth"]
    tag = spec["id"].upper()
    bench_y = d / 2.0 - 0.5
    b.part("Bench_%s_Top" % tag, (w - 1.2, 0.7, 0.06), (0, bench_y, 0.92), M["desk_top"])
    b.part("Bench_%s_LegL" % tag, (0.08, 0.6, 0.9), (-(w / 2.0 - 0.7), bench_y, 0.45), M["frame"])
    b.part("Bench_%s_LegR" % tag, (0.08, 0.6, 0.9), (w / 2.0 - 0.7, bench_y, 0.45), M["frame"])
    for i in range(3):
        bx = -1.6 + i * 1.6
        b.part("Bench_%s_Vise_%d" % (tag, i), (0.4, 0.3, 0.22), (bx, bench_y - 0.1, 1.05), M["rail"])
    # The bench is what the workers face, so the anchor goes on the bench rather
    # than on the desk the row would otherwise have put in front of them.
    for i, x in enumerate(seat_row(b, spec["seats"])):
        name = next_seat_name(spec["id"], i)
        b.seat(i, name, desk_name(name), x, -1.2, 0.0, desk_at=(x, bench_y - 0.35, DESK_H))


def furnish_meeting(b, spec):
    w, d = spec["width"], spec["depth"]
    tag = spec["id"].upper()
    count = spec["seats"]
    # An odd count takes a head seat, so the sides carry the rest; a 5-seat table
    # is 2 + 2 + 1, not 2 + 2 + a phantom chair.
    odd = count % 2 == 1
    per_side = (count - 1) // 2 if odd else count // 2
    table_w = min(w - 1.6, per_side * 1.3 + 1.2)
    table_d = min(d - 2.6, 1.5)
    b.part("Table_%s_Top" % tag, (table_w, table_d, 0.06), (0, 0, 0.74), M["desk_top"])
    b.part("Table_%s_Ped" % tag, (table_w * 0.4, table_d * 0.5, 0.68), (0, 0, 0.34), M["desk"])
    # A screen at the head of the table, so the room reads as somewhere to present.
    b.part("Table_%s_Screen" % tag, (1.3, 0.06, 0.76), (0, -d / 2.0 + 0.45, 1.6), M["screen"])
    b.tube("Table_%s_ScreenPost" % tag, 0.04, 0.7, (0, -d / 2.0 + 0.45, 0.35), M["frame"])

    step = table_w / max(1, per_side) if per_side > 0 else 0.0
    start = -(table_w - step) / 2.0
    index = 0
    for side in (-1, 1):
        y = side * (table_d / 2.0 + 0.62)
        facing = math.pi if side < 0 else 0.0
        for i in range(per_side):
            x = start + step * i
            name = next_seat_name(spec["id"], index)
            b.chair(name, desk_name(name), x, y, facing, anchor=(x, side * table_d / 2.0, DESK_H))
            index += 1
    if odd:
        name = next_seat_name(spec["id"], index)
        b.chair(name, desk_name(name), table_w / 2.0 + 0.7, 0.0, -math.pi / 2.0,
                anchor=(table_w / 2.0, 0.0, DESK_H))


def furnish_boardroom(b, spec):
    """One long table with a full perimeter of chairs."""
    w, d = spec["width"], spec["depth"]
    tag = spec["id"].upper()
    table_w, table_d = w - 3.2, 2.0
    b.part("Board_%s_Top" % tag, (table_w, table_d, 0.08), (0, 0, 0.74), M["desk_top"])
    b.part("Board_%s_Base" % tag, (table_w - 1.6, table_d - 0.8, 0.66), (0, 0, 0.33), M["desk"])
    b.part("Board_%s_Inlay" % tag, (table_w - 0.6, 0.12, 0.02), (0, 0, 0.79), M["rail"])
    b.part("Board_%s_Screen" % tag, (2.4, 0.08, 1.35), (0, -d / 2.0 + 0.4, 1.55), M["screen"])
    b.part("Board_%s_ScreenFrame" % tag, (2.5, 0.06, 1.45), (0, -d / 2.0 + 0.45, 1.55), M["rail"])

    # Two end seats come out of the count first, then both long sides split the
    # rest evenly - and how many ends actually get a chair is whatever is left,
    # so the table never ends up with more places than it has seats.
    ends = 2 if spec["seats"] >= 4 else max(0, spec["seats"] - 2)
    per_side = (spec["seats"] - ends) // 2
    step = table_w / max(1, per_side)
    start = -(table_w - step) / 2.0
    index = 0
    for side in (-1, 1):
        y = side * (table_d / 2.0 + 0.66)
        facing = math.pi if side < 0 else 0.0
        for i in range(per_side):
            x = start + step * i
            name = next_seat_name(spec["id"], index)
            b.chair(name, desk_name(name), x, y, facing, anchor=(x, side * table_d / 2.0, DESK_H))
            index += 1
    for i in range(ends):
        side = -1 if i == 0 else 1
        name = next_seat_name(spec["id"], index)
        b.chair(name, desk_name(name), side * (table_w / 2.0 + 0.7), 0.0,
                -side * math.pi / 2.0, anchor=(side * table_w / 2.0, 0.0, DESK_H))
        index += 1


def furnish_lounge(b, spec):
    positions = seat_row(b, spec["seats"])
    for i, x in enumerate(positions):
        name = next_seat_name(spec["id"], i)
        b.sofa(name, x, 0.4, 0.0, width=1.7)
    b.prop_count += 1
    b.part("Lounge_%s_Table" % spec["id"].upper(), (1.2, 0.7, 0.06), (0, -1.4, 0.42), M["desk_top"])
    b.tube("Lounge_%s_TableLeg" % spec["id"].upper(), 0.09, 0.4, (0, -1.4, 0.2), M["frame"])


def furnish_booths(b, spec):
    """Acoustic booths: a desk, a hood and a side screen each.

    The hood is what makes a booth a booth rather than a small desk, so it is
    built even at the cost of a few more meshes.
    """
    w, d = spec["width"], spec["depth"]
    count = spec["seats"]
    step = w / count
    start = -(w - step) / 2.0
    booth_d = min(d - 0.5, 2.2)
    for i in range(count):
        x = start + step * i
        name = next_seat_name(spec["id"], i)
        b.seat(i, name, desk_name(name), x, 0.1, 0.0)
        b.part("Booth_%s_Back_%d" % (spec["id"].upper(), i), (step - 0.16, 0.08, 1.7),
               (x, booth_d / 2.0, 0.85), M["partition"])
        for side in (-1, 1):
            b.part("Booth_%s_Side_%d_%d" % (spec["id"].upper(), i, 0 if side < 0 else 1),
                   (0.08, booth_d, 1.5), (x + side * (step - 0.16) / 2.0, 0.0, 0.75), M["partition"])
        b.part("Booth_%s_Hood_%d" % (spec["id"].upper(), i), (step - 0.1, booth_d + 0.1, 0.14),
               (x, 0.0, 2.05), M["rail"])
        b.part("Booth_%s_Lamp_%d" % (spec["id"].upper(), i), (step - 0.3, 0.1, 0.05),
               (x, 0.25, 1.96), M["neon"])


def furnish_phone(b, spec):
    """A single-occupant booth: you stand in it, so there is no desk."""
    w, d = spec["width"], spec["depth"]
    for side in (-1, 1):
        b.part("Phone_%s_Side_%d" % (spec["id"].upper(), 0 if side < 0 else 1), (0.08, d, WALL_H),
               (side * w / 2.0, 0, WALL_H / 2.0), M["partition"])
    b.part("Phone_%s_Back" % spec["id"].upper(), (w, 0.08, WALL_H), (0, -d / 2.0, WALL_H / 2.0), M["partition"])
    b.part("Phone_%s_Hood" % spec["id"].upper(), (w, d, 0.16), (0, 0, WALL_H - 0.08), M["rail"])
    b.part("Phone_%s_Glass" % spec["id"].upper(), (w - 0.2, 0.05, WALL_H - 0.3), (0, d / 2.0 - 0.03, 1.45), M["glass"])
    b.part("Phone_%s_Light" % spec["id"].upper(), (w - 0.3, 0.12, 0.05), (0, 0, WALL_H - 0.2), M["neon"])
    b.part("Phone_%s_Shelf" % spec["id"].upper(), (w - 0.4, 0.34, 0.05), (0, -d / 2.0 + 0.3, 1.05), M["desk_top"])
    # The occupant stands at the shelf, so the anchor sits on the shelf edge.
    name = next_seat_name(spec["id"], 0)
    b.seat(0, name, desk_name(name), 0.0, -d / 2.0 + 1.25, 0.0)


def furnish_library(b, spec):
    """Shelving down one side, reading carrels down the other."""
    w, d = spec["width"], spec["depth"]
    shelf_y = -d / 2.0 + 0.5
    b.part("Lib_%s_Shelf" % spec["id"].upper(), (w - 1.0, 0.42, 1.9), (0, shelf_y, 0.95), M["storage"])
    rows = max(2, int((w - 1.0) // 1.0))
    step = (w - 1.0) / rows
    start = -(w - 1.0 - step) / 2.0
    for i in range(rows):
        x = start + step * i
        for j in range(3):
            z = 0.5 + j * 0.5
            b.part("Lib_%s_Shelf_%d_%d" % (spec["id"].upper(), i, j), (step - 0.12, 0.34, 0.04),
                   (x, shelf_y - 0.02, z), M["desk"])
            b.part("Lib_%s_Books_%d_%d" % (spec["id"].upper(), i, j), (step - 0.34, 0.24, 0.24),
                   (x, shelf_y - 0.04, z + 0.14), M["art"] if (i + j) % 2 == 0 else M["accent"])

    count = spec["seats"]
    positions = seat_row(b, count)
    for i, x in enumerate(positions):
        name = next_seat_name(spec["id"], i)
        b.seat(i, name, desk_name(name), x, d / 2.0 - 1.4, math.pi)
        # Carrel: a side screen each, so a reader is not sitting in a corridor.
        b.part("Carrel_%s_%d" % (spec["id"].upper(), i), (0.08, 0.9, 1.3),
               (x - 0.95, d / 2.0 - 1.5, 0.65), M["partition"])


def furnish_racks(b, spec):
    """A cold aisle: racks both sides, and an operator position at the head."""
    w, d = spec["width"], spec["depth"]
    for side in (-1, 1):
        y = side * (d / 2.0 - 0.55)
        b.part("Rack_%s_%d" % (spec["id"].upper(), 0 if side < 0 else 1), (w - 1.4, 0.9, 2.0),
               (0, y, 1.0), M["rail"])
        cells = max(2, int((w - 1.4) // 0.5))
        step = (w - 1.4) / cells
        start = -(w - 1.4 - step) / 2.0
        for i in range(cells):
            x = start + step * i
            for j in range(6):
                z = 0.3 + j * 0.3
                b.part("Rack_%s_Unit_%d_%d_%d" % (spec["id"].upper(), 0 if side < 0 else 1, i, j),
                       (step - 0.06, 0.06, 0.2), (x, y - side * 0.47, z),
                       M["neon"] if (i + j) % 4 == 0 else M["screen_off"])
    # The operator sits facing the aisle, and the anchor is the near rack face.
    name = next_seat_name(spec["id"], 0)
    b.seat(0, name, desk_name(name), 0.0, d / 2.0 - 1.9, 0.0)


def furnish_breakout(b, spec):
    w = spec["width"]
    b.part("Break_%s_Counter" % spec["id"].upper(), (w - 1.2, 0.65, 0.95), (0, 1.0, 0.48), M["storage"])
    b.part("Break_%s_CounterTop" % spec["id"].upper(), (w - 1.0, 0.72, 0.06), (0, 1.0, 0.98), M["desk_top"])
    b.part("Break_%s_Splash" % spec["id"].upper(), (w - 1.2, 0.06, 0.5), (0, 0.72, 1.28), M["trim"])
    positions = seat_row(b, spec["seats"])
    for i, x in enumerate(positions):
        name = next_seat_name(spec["id"], i)
        b.stool(name, x, -0.1)


def furnish_gallery(b, spec):
    w, d = spec["width"], spec["depth"]
    b.part("Gallery_%s_Wall" % spec["id"].upper(), (w - 0.6, 0.06, 1.5), (0, -d / 2.0 + 0.15, 1.7), M["art"])
    for i in range(3):
        b.part("Gallery_%s_Panel_%d" % (spec["id"].upper(), i), (0.06, 0.05, 1.5),
               (-(w - 1.2) / 2.0 + i * (w - 1.2) / 2.0, -d / 2.0 + 0.18, 1.7), M["rail"])
    positions = seat_row(b, spec["seats"])
    for i, x in enumerate(positions):
        name = next_seat_name(spec["id"], i)
        b.stool(name, x, 0.9)


FURNITURE = {
    "desks": furnish_desks,
    "workshop": furnish_workshop,
    "meeting": furnish_meeting,
    "boardroom": furnish_boardroom,
    "lounge": furnish_lounge,
    "booths": furnish_booths,
    "phone": furnish_phone,
    "library": furnish_library,
    "racks": furnish_racks,
    "breakout": furnish_breakout,
    "gallery": furnish_gallery,
    "none": lambda b, spec: None,
}


# ---- the kit ---------------------------------------------------------------
#
# Every block, with its size, its doorways and its fit-out. Sizes are all even
# metres so the core's 16 m side wall can still be tiled exactly by two modules,
# and nothing here is wider than 12 m or deeper than 8 m: beyond that a module
# stops reading as a room bolted onto a building and starts reading as a second
# building. `props` are placed by name at (x, y) in the block's own frame.
def P(kind, x, y):
    return (kind, x, y)


POD4_PROPS = [
    P("whiteboard", -3.2, 2.6), P("plant", 3.3, 2.6),
    P("coatRack", 3.5, -2.4), P("rug", 0.0, 0.4), P("pendant", -2.0, 0.4),
    P("pendant", 2.0, 0.4),
]

BLOCKS = [
    # ---------------------------------------------------------------- work
    {
        "id": "pod4", "name": "Open pod", "kind": "open", "category": "work",
        "furniture": "desks", "width": 8.0, "depth": 6.0, "doors": ["w", "e"],
        "seats": 4, "material": "carpet",
        "props": POD4_PROPS,
    },
    {
        "id": "studio6", "name": "Studio", "kind": "open", "category": "work",
        "furniture": "desks", "width": 12.0, "depth": 6.0, "doors": ["w", "e", "n"],
        "seats": 6, "material": "carpet",
        "props": [
            P("whiteboard", -4.4, 2.6), P("shelf", 4.4, 2.6), P("plant", -5.5, -2.5),
            P("pendant", -3.6, 0.1), P("pendant", 0.0, 0.1), P("pendant", 3.6, 0.1),
            P("rug", 0.0, 0.3),
        ],
    },
    {
        "id": "open8", "name": "Open plan", "kind": "open", "category": "work",
        "furniture": "desks", "width": 16.0, "depth": 6.0, "doors": ["w", "e"],
        "seats": 8, "material": "carpet",
        "props": [
            P("whiteboard", -6.4, 2.6), P("pinboard", 6.4, 2.6), P("tallPlant", -7.5, -2.5),
            P("tallPlant", 7.5, -2.5), P("pendant", -4.8, 0.1), P("pendant", 0.0, 0.1),
            P("pendant", 4.8, 0.1), P("rug", 0.0, 0.3), P("storage", 0.0, -2.7),
        ],
    },
    {
        "id": "duo2", "name": "Shared office", "kind": "open", "category": "work",
        "furniture": "desks", "width": 4.0, "depth": 6.0, "doors": ["w", "e"],
        "seats": 2, "material": "carpet",
        "props": [P("shelf", 0.0, 2.7), P("plant", 1.4, -2.4), P("lamp", -1.4, 2.5)],
    },
    {
        "id": "studio4", "name": "Compact studio", "kind": "open", "category": "work",
        "furniture": "desks", "width": 8.0, "depth": 4.0, "doors": ["w", "e"],
        "seats": 4, "material": "carpet",
        "props": [P("whiteboard", -3.3, 1.7), P("plant", 3.5, -1.6), P("pendant", 0.0, 0.1)],
    },
    # ---------------------------------------------------------------- meet
    {
        "id": "meeting6", "name": "Meeting room", "kind": "meeting", "category": "meet",
        "furniture": "meeting", "width": 8.0, "depth": 6.0, "doors": ["w"],
        "seats": 6, "material": "carpet",
        "props": [P("whiteboard", -3.2, 2.6), P("pinboard", 3.2, 2.6), P("water", 3.6, -2.4), P("rug", 0.0, 0.0)],
    },
    {
        "id": "board12", "name": "Boardroom", "kind": "boardroom", "category": "meet",
        "furniture": "boardroom", "width": 12.0, "depth": 8.0, "doors": ["w"],
        "seats": 12, "material": "carpet",
        "props": [
            P("art", -5.4, 3.6), P("art", 5.4, 3.6), P("water", -5.4, -3.2), P("tallPlant", 5.4, -3.2),
            P("pendant", -3.0, 0.0), P("pendant", 0.0, 0.0), P("pendant", 3.0, 0.0), P("rug", 0.0, 0.0),
        ],
    },
    {
        "id": "hoot4", "name": "Huddle room", "kind": "meeting", "category": "meet",
        "furniture": "meeting", "width": 6.0, "depth": 6.0, "doors": ["w"],
        "seats": 4, "material": "carpet",
        "props": [P("screen", 0.0, -2.5), P("whiteboard", 2.4, 2.6), P("plant", -2.5, 2.5), P("rug", 0.0, 0.0)],
    },
    {
        "id": "forum16", "name": "Forum", "kind": "meeting", "category": "meet",
        "furniture": "meeting", "width": 12.0, "depth": 8.0, "doors": ["w", "e"],
        "seats": 12, "material": "carpet",
        "props": [
            P("screen", 0.0, -3.5), P("whiteboard", -5.3, 3.6), P("pinboard", 5.3, 3.6),
            P("tallPlant", -5.5, -3.4), P("tallPlant", 5.5, -3.4), P("rug", 0.0, 0.0),
        ],
    },
    # ---------------------------------------------------------------- quiet
    {
        "id": "focus4", "name": "Focus room", "kind": "focus", "category": "quiet",
        "furniture": "booths", "width": 8.0, "depth": 4.0, "doors": ["w"],
        "seats": 4, "material": "carpet",
        "props": [P("plant", 3.6, 1.6), P("pendant", -2.4, 0.4), P("pendant", 0.0, 0.4), P("pendant", 2.4, 0.4)],
    },
    {
        "id": "focus6", "name": "Deep work room", "kind": "focus", "category": "quiet",
        "furniture": "booths", "width": 12.0, "depth": 6.0, "doors": ["w", "e"],
        "seats": 6, "material": "carpet",
        "props": [P("tallPlant", -5.5, 2.6), P("plant", 5.5, 2.6), P("rug", 0.0, 0.2), P("shelf", 0.0, -2.7)],
    },
    {
        "id": "phone1", "name": "Phone booth", "kind": "phone", "category": "quiet",
        "furniture": "phone", "width": 4.0, "depth": 4.0, "doors": ["w"],
        "seats": 1, "material": "carpet",
        "props": [P("plant", 1.6, -1.6), P("art", -1.6, 1.75)],
    },
    {
        "id": "library4", "name": "Library", "kind": "library", "category": "quiet",
        "furniture": "library", "width": 8.0, "depth": 6.0, "doors": ["w"],
        "seats": 4, "material": "carpet",
        "props": [P("lamp", -3.2, 1.0), P("lamp", 3.2, 1.0), P("plant", 0.0, 2.6), P("rug", 0.0, 1.4)],
    },
    # ---------------------------------------------------------------- support
    {
        "id": "workshop4", "name": "Workshop", "kind": "workshop", "category": "support",
        "furniture": "workshop", "width": 8.0, "depth": 6.0, "doors": ["w", "e"],
        "seats": 4, "material": "carpet",
        "props": [
            P("storage", -3.3, 1.2), P("printer", 3.4, 1.2), P("pinboard", 0.0, 2.6),
            P("pendant", -2.0, -1.0), P("pendant", 2.0, -1.0),
        ],
    },
    {
        "id": "server4", "name": "Server room", "kind": "server", "category": "support",
        "furniture": "racks", "width": 8.0, "depth": 6.0, "doors": ["w"],
        "seats": 1, "material": "floor",
        "props": [P("water", 0.0, 2.6), P("screen", -3.0, -0.6), P("lockers", 3.4, 2.4)],
    },
    {
        "id": "break6", "name": "Break room", "kind": "breakroom", "category": "support",
        "furniture": "breakout", "width": 10.0, "depth": 6.0, "doors": ["w", "e"],
        "seats": 4, "material": "carpet",
        "props": [
            P("coffee", -3.4, 1.1), P("water", 1.2, 1.1), P("plant", 4.0, 2.5),
            P("tallPlant", -4.4, 2.5), P("pendant", -1.6, 0.2), P("pendant", 1.6, 0.2),
            P("rug", 0.0, -1.0),
        ],
    },
    {
        "id": "locker6", "name": "Lockers", "kind": "breakroom", "category": "support",
        "furniture": "breakout", "width": 6.0, "depth": 4.0, "doors": ["w", "e"],
        "seats": 3, "material": "carpet",
        "props": [P("lockers", -2.0, 1.3), P("coatRack", 2.2, 1.3), P("plant", 2.4, -1.4), P("rug", 0.0, -0.6)],
    },
    {
        "id": "lounge3", "name": "Lounge", "kind": "lounge", "category": "support",
        "furniture": "lounge", "width": 8.0, "depth": 6.0, "doors": ["w", "e"],
        "seats": 3, "material": "carpet",
        "props": [
            P("tallPlant", -3.4, 2.5), P("plant", 3.4, 2.5), P("lamp", -3.5, -1.2),
            P("rug", 0.0, 0.4), P("art", 0.0, 2.7),
        ],
    },
    {
        "id": "gallery6", "name": "Pin-up gallery", "kind": "gallery", "category": "support",
        "furniture": "gallery", "width": 8.0, "depth": 6.0, "doors": ["w", "e"],
        "seats": 3, "material": "carpet",
        "props": [P("plant", -3.3, -2.4), P("plant", 3.3, -2.4), P("lamp", -3.4, 1.6), P("rug", 0.0, 1.0)],
    },
    # ---------------------------------------------------------------- circulation
    {
        "id": "junction", "name": "Junction", "kind": "junction", "category": "circulation",
        "furniture": "none", "width": 6.0, "depth": 6.0, "doors": ["n", "e", "s", "w"],
        "seats": 0, "material": "floor",
        "props": [P("plant", -2.2, 2.2), P("tallPlant", 2.2, -2.2), P("pendant", 0.0, 0.0)],
    },
    {
        "id": "junction4", "name": "Crossing", "kind": "junction", "category": "circulation",
        "furniture": "none", "width": 4.0, "depth": 4.0, "doors": ["n", "e", "s", "w"],
        "seats": 0, "material": "floor",
        "props": [P("plant", -1.4, 1.4), P("pendant", 0.0, 0.0)],
    },
    {
        # The circulation spine. A room with one doorway is a dead end, and a
        # junction is a node rather than a route between two of them - so without
        # a corridor a generated building is a chain of rooms and nothing else.
        "id": "corridor", "name": "Corridor", "kind": "corridor", "category": "circulation",
        "furniture": "none", "width": 8.0, "depth": 3.0, "doors": ["w", "e", "n"],
        "seats": 0, "material": "floor",
        "props": [P("plant", -3.4, 0.0), P("art", 0.0, 1.25), P("lamp", 3.4, 0.0)],
    },
    {
        "id": "passage4", "name": "Passage", "kind": "corridor", "category": "circulation",
        "furniture": "none", "width": 4.0, "depth": 4.0, "doors": ["w", "e"],
        "seats": 0, "material": "floor",
        "props": [P("coatRack", 1.3, 1.3), P("plant", -1.3, -1.3)],
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
    "id": "portal", "name": "Doorway", "kind": "portal", "category": "fitting",
    "furniture": "none", "width": 1.9, "depth": 0.5, "doors": [], "seats": 0,
    "material": "floor", "props": [],
}


# ============================================================ build
def build_block(spec):
    coll = new_coll("Block_%s" % spec["id"])
    # Every module is parented under one empty. Without it the GLB is a flat pile
    # of hundreds of sibling nodes and the browser would have to guess which
    # meshes belong to which module from their names - and it would guess wrong
    # the first time a module gained a part.
    root = empty("Kit_%s" % spec["id"], (0.0, 0.0, 0.0), coll)
    b = Block(spec, coll, root)
    w, d = spec["width"], spec["depth"]

    b.part("Block_%s_Slab" % spec["id"], (w + 0.3, d + 0.3, 0.2), (0, 0, -0.1), M["slab"])
    b.part("Block_%s_Floor" % spec["id"], (w - 0.3, d - 0.3, 0.02), (0, 0, 0.011), M[spec["material"]])

    doors = spec["doors"]
    # Blender's Y runs opposite to the browser's z, so a browser-north wall sits
    # at Blender +Y. The conversion is mirrored in one place, here.
    #
    # A doorway's wall gets an accent face: it is the one wall in the module a
    # visitor actually looks through, and it is what stops a corridor of modules
    # reading as a corridor of identical boxes.
    build_wall("Block_%s_Wall_N" % spec["id"], 'x', d / 2.0, (-w / 2.0, w / 2.0),
               [0.0] if "n" in doors else [], coll, root, M["wall"])
    build_wall("Block_%s_Wall_S" % spec["id"], 'x', -d / 2.0, (-w / 2.0, w / 2.0),
               [0.0] if "s" in doors else [], coll, root, M["wall"])
    build_wall("Block_%s_Wall_E" % spec["id"], 'y', w / 2.0, (-d / 2.0, d / 2.0),
               [0.0] if "e" in doors else [], coll, root, M["wall"])
    build_wall("Block_%s_Wall_W" % spec["id"], 'y', -w / 2.0, (-d / 2.0, d / 2.0),
               [0.0] if "w" in doors else [], coll, root, M["wall"])

    # A lit stroke along each doorway threshold, so a doorway reads as a way
    # through rather than as a gap somebody forgot to fill.
    for edge, (dx, dy) in (("n", (0.0, d / 2.0)), ("s", (0.0, -d / 2.0)),
                           ("e", (w / 2.0, 0.0)), ("w", (-w / 2.0, 0.0))):
        if edge not in doors:
            continue
        size = (DOOR_W, 0.1, 0.012) if edge in ("n", "s") else (0.1, DOOR_W, 0.012)
        b.part("Block_%s_Threshold_%s" % (spec["id"], edge.upper()), size, (dx, dy, 0.022), M["trim"])

    kind = spec["kind"]
    if kind == "junction":
        # A junction is circulation: no desks, just a lit strip, so the building
        # reads as connected rather than as a row of boxes.
        b.part("Block_%s_Guide" % spec["id"], (w - 0.6, 0.06, 0.01), (0, 0, 0.022), M["accent"])
    elif kind == "corridor":
        # Low walls on the two long sides so it reads as a route, and a lit strip
        # down the middle. No desks, no room anchor: nobody works in a corridor.
        for side in (-1, 1):
            b.part("Corridor_%s_Rail_%d" % (spec["id"], 0 if side < 0 else 1),
                   (w, 0.12, 1.05), (0, side * d / 2.0, 0.525), M["partition"])
        b.part("Corridor_%s_Guide" % spec["id"], (w - 0.8, 0.08, 0.01), (0, 0, 0.023), M["accent"])
    elif kind == "portal":
        # Jambs, a lintel and a glazed door leaf, centred on the local origin and
        # opening along local x so a placement rotation turns it to face outward.
        jamb = 0.09
        for side in (-1, 1):
            b.part("Portal_%s_Jamb_%d" % (spec["id"], 0 if side < 0 else 1),
                   (jamb, spec["depth"], WALL_H), (side * (DOOR_W / 2.0 + jamb / 2.0), 0, WALL_H / 2.0), M["frame"])
        b.part("Portal_%s_Lintel" % spec["id"], (DOOR_W + 2 * jamb, spec["depth"], WALL_H - LINTEL),
               (0, 0, LINTEL + (WALL_H - LINTEL) / 2.0), M["frame"])
        b.part("Portal_%s_Leaf" % spec["id"], (DOOR_W - 0.06, 0.05, LINTEL - 0.04),
               (0, 0, (LINTEL - 0.04) / 2.0), M["glass"])
        b.part("Portal_%s_Kick" % spec["id"], (DOOR_W - 0.06, 0.07, 0.18),
               (0, 0, 0.09), M["trim"])
    else:
        FURNITURE[spec["furniture"]](b, spec)

        # Every room module names itself, so an employee seated here is described
        # as being in the pod rather than at the bench. The core office does the
        # same with its own Anchor_Room_* empties.
        b.anchor("Anchor_Room_%s" % spec["id"].upper(), (0.0, 0.0, 0.0))

    # Props last, so they can be placed around whatever furniture went in.
    for index, (prop_kind, px, py) in enumerate(spec.get("props", [])):
        builder = PROP_BUILDERS.get(prop_kind)
        if builder is None:
            raise SystemExit("unknown prop %r on block %s" % (prop_kind, spec["id"]))
        builder(b, "%s_%d" % (spec["id"].upper(), index), px, py)

    return b.seats


# ============================================================ validate
def validate(spec, spec_seats):
    """Refuse to ship a module whose furniture pokes through its own walls.

    Cheap arithmetic, and it catches the one mistake this file is most likely to
    make: a size changed, or a seat count raised, without moving the desks in.
    """
    problems = []
    w, d = spec["width"], spec["depth"]
    if w <= 0 or d <= 0:
        problems.append("%s has a non-positive size" % spec["id"])
    # A fitting and the circulation modules are deliberately odd sizes - a
    # doorway is 1.9 m, a corridor 3 m deep - so the even-metre rule applies only
    # where a module has to tile a wall against another one.
    if spec["category"] not in ("fitting", "circulation") and (w % 2 != 0 or d % 2 != 0):
        problems.append("%s is not a whole number of metres on both sides" % spec["id"])
    for edge in spec["doors"]:
        if edge not in ("n", "e", "s", "w"):
            problems.append("%s has an unknown doorway %r" % (spec["id"], edge))
    if spec.get("fitting") is not True and len(spec["doors"]) == 0:
        problems.append("%s is not a fitting but has no doorways, so nothing can reach it" % spec["id"])

    # Only the doorways' own edges are cut, so a doorway wider than its wall is
    # the one way a wall can end up with nothing left of it.
    for edge in spec["doors"]:
        span = w if edge in ("n", "s") else d
        if span < DOOR_W + 0.4:
            problems.append("%s has a %.1f m %s wall, too narrow for a %.1f m doorway"
                            % (spec["id"], span, edge, DOOR_W))

    seats = spec["seats"]
    if len(spec_seats) != seats:
        problems.append("%s declares %d seats but built %d" % (spec["id"], seats, len(spec_seats)))

    # The width and depth a fit-out actually needs. A desk row is the demanding
    # case by a wide margin; everything else is measured by its own footprint, so
    # a room cannot grow a table that reaches into the next module.
    furniture = spec["furniture"]
    if furniture in ("desks", "workshop", "library", "booths"):
        if seats > 1:
            reach = max(abs(x) for x in seat_row(None, seats)) + DESK_W / 2.0
            if reach > w / 2.0 - 0.1:
                problems.append("%s seats %d across %.1f m: the desk row needs %.2f m of width"
                                % (spec["id"], seats, w, reach * 2))
        need = ROW_DEPTH + 0.4
        if furniture == "booths":
            # A booth adds a hood over the desk, which overhangs it.
            need = ROW_DEPTH + 0.6
        if d < need:
            problems.append("%s is %.1f m deep; a %s fit-out needs %.1f m"
                            % (spec["id"], d, furniture, need))
    elif furniture in ("meeting", "boardroom"):
        # The same table geometry `furnish_meeting` and `furnish_boardroom`
        # build, measured rather than assumed: the table, the chairs on both
        # long sides overhanging it by 0.62 m, and - for an odd count or a
        # boardroom - a chair at each end.
        if furniture == "meeting":
            per_side = seats // 2
            table_w = min(w - 1.6, per_side * 1.3 + 1.2)
            table_d = min(d - 2.6, 1.5)
            # Step is the table width divided by the number of chairs a side, so
            # the outermost chair centre sits half a step inside the end.
            step = table_w / max(1, per_side) if per_side > 0 else 0.0
            half_chairs = (table_w - step) / 2.0 + 0.22
            end_reach = (table_w / 2.0 + 0.7 + 0.22) if seats % 2 == 1 else half_chairs
        else:
            per_side = max(1, (seats - 2) // 2)
            table_w, table_d = w - 3.2, 2.0
            step = table_w / max(1, per_side)
            half_chairs = (table_w - step) / 2.0 + 0.22
            end_reach = table_w / 2.0 + 0.7 + 0.22
        if table_d <= 0.3 or table_w <= 0.5:
            problems.append("%s is %.1f x %.1f m: a table of any size will not fit" % (spec["id"], w, d))
            return problems
        reach_x = max(half_chairs, end_reach)
        reach_y = table_d / 2.0 + 0.62 + 0.22
        if reach_x > w / 2.0 - 0.1:
            problems.append("%s is %.1f m wide but seats %d: the table and its chairs need %.2f m"
                            % (spec["id"], w, seats, reach_x * 2))
        if reach_y > d / 2.0 - 0.1:
            problems.append("%s is %.1f m deep but seats %d: the table and its chairs need %.2f m"
                            % (spec["id"], d, seats, reach_y * 2))
    elif furniture == "lounge":
        if seats > 1 and seat_row(None, seats)[-1] + 1.0 > w / 2.0:
            problems.append("%s lays %d sofas in %.1f m; they need %.1f m"
                            % (spec["id"], seats, w, (seat_row(None, seats)[-1] + 1.0) * 2))
        if d < 4.0:
            problems.append("%s is %.1f m deep: a sofa and a coffee table need 4 m" % (spec["id"], d))
    elif furniture in ("racks", "breakout", "gallery", "phone"):
        if d < 4.0:
            problems.append("%s is %.1f m deep: a %s fit-out needs 4 m" % (spec["id"], d, furniture))

    # Nothing may be placed outside its own module: a prop or a wall fitting that
    # lands beyond the wall shows up in the next room, which is the single most
    # visible way a generated building can look broken.
    limit_x = w / 2.0 - 0.05
    limit_y = d / 2.0 - 0.05
    for prop_kind, px, py in spec.get("props", []):
        if abs(px) > limit_x or abs(py) > limit_y:
            problems.append("%s places its %s at (%.1f, %.1f), outside the %.1f x %.1f m module"
                            % (spec["id"], prop_kind, px, py, w, d))
    return problems


emitted = []
all_problems = []
prop_kinds = set()

# The room blocks first, then the portal, so a kit that loses a room to a
# validation failure still ships the fitting that connects the core to one.
for spec in BLOCKS:
    seats = build_block(spec)
    all_problems.extend(validate(spec, seats))
    entry = {
        "id": spec["id"],
        "name": spec["name"],
        "kind": spec["kind"],
        "category": spec["category"],
        "furniture": spec["furniture"],
        "width": spec["width"],
        "depth": spec["depth"],
        "doors": list(spec["doors"]),
        "seats": seats,
        # The cloneable node in blocks.glb. The browser instantiates a module by
        # cloning this, so it never has to guess which meshes belong together.
        "node": "Kit_%s" % spec["id"],
        "props": [prop for prop, _x, _y in spec.get("props", [])],
    }
    if spec["kind"] not in ("junction", "portal"):
        entry["room"] = "Anchor_Room_%s" % spec["id"].upper()
    for prop, _x, _y in spec.get("props", []):
        prop_kinds.add(prop)
    emitted.append(entry)

# The portal is emitted into the same kit but tagged, so the browser knows it is
# a fitting rather than a room and never offers it to the growth search.
PORTAL["fitting"] = True
portal_seats = build_block(PORTAL)
all_problems.extend(validate(PORTAL, portal_seats))
emitted.append({
    "id": PORTAL["id"],
    "name": PORTAL["name"],
    "kind": PORTAL["kind"],
    "category": PORTAL["category"],
    "furniture": PORTAL["furniture"],
    "width": PORTAL["width"],
    "depth": PORTAL["depth"],
    "doors": list(PORTAL["doors"]),
    "seats": portal_seats,
    "node": "Kit_%s" % PORTAL["id"],
    "props": [],
    "fitting": True,
})

# ============================================================ anchor contract
# The loader derives an avatar's facing from the `Seat_*` / `Desk_*` pair, and it
# counts seats by prefix - so the pair is a contract, and it is asserted rather
# than eyeballed. A seat with no desk leaves somebody facing nowhere; a desk with
# no seat is a dead node; a mesh wearing a reserved prefix would be offered as
# somewhere to sit.
#
# This runs *before* the export, so a kit that breaks the contract is reported
# and nothing is written: a half-correct kit in the app is worse than a loud
# failure here.
def anchor_contract():
    found = []
    seat_nodes = sorted(o.name for o in bpy.data.objects if o.type == 'EMPTY' and o.name.startswith("Seat_"))
    desk_nodes = sorted(o.name for o in bpy.data.objects if o.type == 'EMPTY' and o.name.startswith("Desk_"))
    expected_desks = sorted("Desk_" + name[len("Seat_"):] for name in seat_nodes)
    if desk_nodes != expected_desks:
        missing = sorted(set(expected_desks) - set(desk_nodes))
        orphans = sorted(set(desk_nodes) - set(expected_desks))
        if missing:
            found.append("%d seat(s) have no Desk_ anchor: %s" % (len(missing), ", ".join(missing[:6])))
        if orphans:
            found.append("%d Desk_ anchor(s) belong to no seat: %s" % (len(orphans), ", ".join(orphans[:6])))
    for ob in bpy.data.objects:
        if ob.type != 'EMPTY' and (
            ob.name.startswith("Seat_") or ob.name.startswith("Desk_") or ob.name.startswith("Anchor_Room_")
        ):
            found.append("%s is a %s wearing the reserved anchor prefix" % (ob.name, ob.type))
    return found


all_problems.extend(anchor_contract())
if all_problems:
    print("=== BLOCK KIT REFUSED ===")
    print("The kit does not satisfy its own contract, so nothing was exported.")
    for problem in all_problems:
        print("  " + problem)
    raise SystemExit(1)

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
    "version": 2,
    "note": "Generated by blender/scripts/02_office_blocks.py. Do not hand-edit: re-run the script.",
    "cell": 4.0,
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
except NameError:
    # Running through the Blender MCP bridge in safe mode: `open` is withheld,
    # so the sidecar is printed instead and `blender/scripts/write-blocks-json.mjs`
    # turns that line into the file. The GLB export above is unaffected.
    written = "via MCP (see BLOCKS_JSON below)"
except Exception as exc:  # the bridge may withhold file writes; print instead
    print("could not write %s: %s" % (OUT_JSON, exc))

meshes = [o for o in bpy.data.objects if o.type == 'MESH']
empties = [o for o in bpy.data.objects if o.type == 'EMPTY']
seat_count = len([o for o in empties if o.name.startswith("Seat_")])
desk_count = len([o for o in empties if o.name.startswith("Desk_")])

print("=== dev3d BLOCK KIT ===")
print("mode: %s" % mode)
print("glb: %s" % OUT_GLB)
print("json: %s" % written)
print("blocks: %d | meshes: %d | empties: %d | seats: %d | desks: %d"
      % (len(emitted), len(meshes), len(empties), seat_count, desk_count))
print("props in use: %s" % ", ".join(sorted(prop_kinds)))
for block in emitted:
    print("  %-11s %4.1f x %4.1f  %-11s %-10s doors=%-12s seats=%-2d props=%d%s" % (
        block["id"], block["width"], block["depth"], block["category"], block["furniture"],
        ",".join(block["doors"]) or "-", len(block["seats"]), len(block["props"]),
        "  (fitting)" if block.get("fitting") else ""))
print("kit validation: %d blocks, seat/desk anchors paired, nothing outside its module" % len(emitted))
print("BLOCKS_JSON=" + json.dumps(document))
