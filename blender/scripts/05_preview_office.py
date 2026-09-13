"""dev3d - render the office, so a change to it is something you can see.

`04_preview_blocks.py` does this for the block kit. This does it for the core
office, which is the other half of the asset and the half a person actually looks
at - and it is the only way to see a bevel or a chair caster before it reaches the
browser.

It runs the shell and the furniture scripts in one Blender session, which is the
same order `99_export_glb.py` expects and the only order that works: every script
resets the scene, so `03` has to find `01`'s shell already built. Then it frames
the result from a few angles and renders them.

It writes PNGs to `blender/out` and touches nothing the app loads.

    blender --background --factory-startup --python blender/scripts/05_preview_office.py

Add `-- --width 2400` to taste, or `-- --views overview,desks` for just some.
"""

import bpy
import math
import os
import sys
from mathutils import Euler, Vector


def _repo_root():
    """This checkout's root, from this file's own location.

    Blender's `--python` sets `__file__`, so the script finds the office scripts it
    means to run and the directory it means to write into without a hard-coded
    path. `DEV3D_REPO_ROOT` overrides it for the unusual case where `__file__` is
    absent.
    """
    override = os.environ.get("DEV3D_REPO_ROOT")
    if override:
        return override
    source = globals().get("__file__")
    if source:
        return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(source))))
    raise RuntimeError(
        "cannot locate the repository root: run this with Blender's --python "
        "(which sets __file__), or set DEV3D_REPO_ROOT."
    )


REPO = _repo_root()
SCRIPTS = os.path.join(REPO, "blender", "scripts")
OUT_DIR = os.path.join(REPO, "blender", "out")

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, fallback):
    if name in argv:
        at = argv.index(name)
        if at + 1 < len(argv):
            return argv[at + 1]
    return fallback


IMAGE_W = int(arg("--width", "1800"))
ONLY = [part for part in arg("--views", "").split(",") if part]


def run(script):
    """Run one of the office scripts in this Blender session.

    `exec` on a file read here is ordinary Python: this script is run by Blender
    itself, not through the MCP bridge's safe mode. Each script prints its own
    report, which is left visible - a refusal or an anchor-contract violation
    raises `SystemExit`, and that is exactly the case worth stopping for.
    """
    path = os.path.join(SCRIPTS, script)
    with open(path, encoding="utf-8") as handle:
        source = handle.read()
    exec(compile(source, path, "exec"), {"__name__": "__preview__", "__file__": path})


run("01_office_shell.py")
run("03_office_furniture.py")

# ---- the exterior walls have to stay sealed --------------------------------
#
# The renderer turns every mesh whose world height crosses 0.25..1.75 m into a nav
# obstacle, so cutting an opening into a wall is cutting a hole in the building
# unless something below the sill stays inside that band. That is the entire reason
# the windows have a 0.9 m sill, and it is the kind of property that a render
# cannot show you: the elevation looks right either way.
#
# It is checked here rather than in the browser because Blender already has the
# world matrices, and because the wall is the thing that was just edited.
NAV_BAND = (0.25, 1.75)
NAV_RADIUS = 0.26


def nav_boxes():
    """Every mesh crossing the nav band, as a world-space footprint."""
    boxes = []
    for ob in bpy.data.objects:
        if ob.type != 'MESH':
            continue
        corners = [ob.matrix_world @ Vector(corner) for corner in ob.bound_box]
        low = min(point.z for point in corners)
        high = max(point.z for point in corners)
        if high < NAV_BAND[0] or low > NAV_BAND[1]:
            continue
        boxes.append((
            min(point.x for point in corners), max(point.x for point in corners),
            min(point.y for point in corners), max(point.y for point in corners),
        ))
    return boxes


def wall_leaks(boxes, z_plane, x_from, x_to):
    """Gaps in the obstacle line along one exterior wall, inflated like the grid."""
    spans = sorted(
        (box[0] - NAV_RADIUS, box[1] + NAV_RADIUS)
        for box in boxes
        if not (z_plane < box[2] - NAV_RADIUS or z_plane > box[3] + NAV_RADIUS)
    )
    reached = x_from
    leaks = []
    for low, high in spans:
        if high <= reached:
            continue
        if low > reached + 1e-9:
            leaks.append((reached, low))
        reached = max(reached, high)
    if reached < x_to - 1e-9:
        leaks.append((reached, x_to))
    return leaks


boxes = nav_boxes()
leaks = wall_leaks(boxes, -8.075, -11.0, 11.0) + wall_leaks(boxes, 8.075, -11.0, 11.0)
print("nav seal: %d obstacles in the %.2f..%.2f m band | long walls %s"
      % (len(boxes), NAV_BAND[0], NAV_BAND[1], "sealed" if not leaks else "LEAKING"))
for low, high in leaks:
    print("  a body could walk out between x %.2f and %.2f" % (low, high))
if leaks:
    raise SystemExit("the exterior glazing opened the building")

# ---- and the rooms have to be reachable from the dev floor ------------------
#
# The check above proves nobody can walk *out*. This proves somebody can walk *in*:
# the floor is labelled into connected regions the way the renderer's grid does,
# and a room whose doorway was forgotten is its own region with its seats sealed
# inside it. That is not hypothetical - it is exactly what the back offices were
# before they were given doorways, and it is invisible in a render, because a
# doorway nobody cut looks the same as a doorway you cannot see from this angle.
CELL = 0.2
GRID_BOUNDS = (-13.0, 13.0, -9.5, 9.5)


def label_regions(obstacles, bounds):
    """Flood fill the floor into connected regions. Returns (label, cols, rows)."""
    cols = int((bounds[1] - bounds[0]) / CELL) + 1
    rows = int((bounds[3] - bounds[2]) / CELL) + 1
    blocked = bytearray(cols * rows)
    for min_x, max_x, min_y, max_y in obstacles:
        for row in range(rows):
            y = bounds[2] + row * CELL
            if y < min_y - NAV_RADIUS or y > max_y + NAV_RADIUS:
                continue
            for col in range(cols):
                x = bounds[0] + col * CELL
                if x < min_x - NAV_RADIUS or x > max_x + NAV_RADIUS:
                    continue
                blocked[row * cols + col] = 1
    label = [-1] * (cols * rows)
    regions = 0
    for start in range(cols * rows):
        if blocked[start] or label[start] != -1:
            continue
        # Four-connected on purpose: two spaces that only touch at a corner are not
        # connected for a person with a radius, which is the renderer's rule too.
        stack = [start]
        label[start] = regions
        while stack:
            at = stack.pop()
            row, col = divmod(at, cols)
            for nrow, ncol in ((row - 1, col), (row + 1, col), (row, col - 1), (row, col + 1)):
                if nrow < 0 or ncol < 0 or nrow >= rows or ncol >= cols:
                    continue
                n = nrow * cols + ncol
                if blocked[n] or label[n] != -1:
                    continue
                label[n] = regions
                stack.append(n)
        regions += 1
    return label, cols, rows, regions


def region_near(label, cols, rows, bounds, point, snap_cells=15):
    """The region of the nearest walkable cell, or -1.

    Room anchors sit in the middle of their room, which is where the table is, so
    the point itself is usually inside furniture. The renderer snaps a destination
    to walkable floor for the same reason; this does the same thing, or every room
    would be reported unreachable for having a desk in it.
    """
    col0 = int((point[0] - bounds[0]) / CELL)
    row0 = int((point[1] - bounds[2]) / CELL)
    for radius in range(0, snap_cells + 1):
        for drow in range(-radius, radius + 1):
            for dcol in range(-radius, radius + 1):
                if max(abs(drow), abs(dcol)) != radius:
                    continue
                row, col = row0 + drow, col0 + dcol
                if row < 0 or col < 0 or row >= rows or col >= cols:
                    continue
                found = label[row * cols + col]
                if found != -1:
                    return found
    return -1


label, cols, rows, regions = label_regions(boxes, GRID_BOUNDS)


def anchors_with(prefix, kind='EMPTY'):
    return {
        ob.name: (ob.matrix_world.translation.x, ob.matrix_world.translation.y)
        for ob in bpy.data.objects
        if ob.type == kind and ob.name.startswith(prefix)
    }


rooms = anchors_with('Anchor_Room_')
seats = anchors_with('Seat_')
home = region_near(label, cols, rows, GRID_BOUNDS, rooms.get('Anchor_Room_DevFloor', (0.0, -2.5)))


def stranded(group):
    return [name for name, point in sorted(group.items())
            if region_near(label, cols, rows, GRID_BOUNDS, point) != home]


sealed_rooms = [name for name in stranded(rooms) if name != 'Anchor_Room_DevFloor']
sealed_seats = stranded(seats)
print("nav reach: %d regions on a %.0f x %.0f m grid | dev floor reaches %d/%d rooms and %d/%d seats"
      % (regions, GRID_BOUNDS[1] - GRID_BOUNDS[0], GRID_BOUNDS[3] - GRID_BOUNDS[2],
         len(rooms) - 1 - len(sealed_rooms), len(rooms) - 1,
         len(seats) - len(sealed_seats), len(seats)))
# Sizes rather than just a count, because "one region" and "one region plus the
# strip of plate outside the building" are the same number and not the same thing.
if regions > 1:
    sizes = sorted((label.count(index) * CELL * CELL for index in range(regions)), reverse=True)
    print("  region areas (m2): %s" % ", ".join("%.0f" % size for size in sizes))
for name in sealed_rooms:
    print("  %s cannot be reached from the dev floor" % name)
for name in sealed_seats:
    print("  %s is sealed off from the dev floor" % name)
if sealed_rooms or sealed_seats:
    raise SystemExit("somebody has no way to their desk")

# A neutral rig, so the preview shows the geometry rather than a mood: the app
# styles the floor, and this is here to make an edge legible. The world is dim but
# not black, because a bevel with nothing to reflect is a bevel you cannot see.
world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
bpy.context.scene.world = world
world.use_nodes = True
for node in world.node_tree.nodes:
    if node.type == 'BACKGROUND':
        node.inputs[0].default_value = (0.16, 0.18, 0.22, 1.0)
        node.inputs[1].default_value = 1.0

bpy.ops.object.light_add(type='SUN', location=(14.0, -20.0, 26.0))
sun = bpy.context.active_object
sun.data.energy = 2.6
sun.rotation_euler = Euler((math.radians(44.0), 0.0, math.radians(38.0)))

bpy.ops.object.light_add(type='AREA', location=(-12.0, -14.0, 9.0))
fill = bpy.context.active_object
fill.data.energy = 520.0
fill.data.size = 12.0
fill.rotation_euler = (Vector((0.0, 0.0, 1.0)) - Vector(fill.location)).to_track_quat('-Z', 'Y').to_euler()

# Something for the office to stand on, well below its own slab.
bpy.ops.mesh.primitive_plane_add(size=120.0, location=(0.0, 0.0, -0.30))
ground = bpy.context.active_object
ground.name = "Preview_Ground"
ground_material = bpy.data.materials.new("Preview_Ground")
ground_material.use_nodes = True
for node in ground_material.node_tree.nodes:
    if node.type == 'BSDF_PRINCIPLED':
        node.inputs["Base Color"].default_value = (0.10, 0.11, 0.13, 1.0)
        node.inputs["Roughness"].default_value = 0.9
ground.data.materials.append(ground_material)

scene = bpy.context.scene
scene.render.resolution_x = IMAGE_W
scene.render.resolution_y = int(IMAGE_W * 0.58)
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.film_transparent = False

available_engines = [item.identifier for item in
                     bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
for wanted in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'BLENDER_WORKBENCH'):
    if wanted in available_engines:
        scene.render.engine = wanted
        break

bpy.ops.object.camera_add(location=(0.0, 0.0, 0.0))
camera = bpy.context.active_object
camera.name = "Cam_Preview"
camera.data.lens = 50.0
scene.camera = camera

# Each view is a camera position, the point it aims at, and a lens. The detail
# views are the ones that matter for judging the geometry: an overview at this
# size shows the plan, and a chair three millimetres across shows nothing.
#
# Every position here is *inside* the building. The walls are solid and single
# sided in effect, so a camera behind the front wall renders its outer face and
# nothing else - which looks exactly like a render that failed.
VIEWS = [
    ("overview", (17.0, -26.0, 19.0), (0.0, 0.0, 0.9), 50.0),
    ("elevation", (0.0, -34.0, 5.0), (0.0, 0.0, 1.6), 85.0),
    ("desks", (-4.0, -7.2, 1.85), (-4.0, -4.4, 0.72), 50.0),
    ("lounge", (-6.1, -4.5, 2.05), (-8.8, -6.5, 0.5), 40.0),
    ("meeting", (4.4, 3.9, 2.3), (7.6, 6.1, 0.75), 44.0),
    ("ceo", (-5.2, 3.6, 2.4), (-8.4, 6.6, 0.75), 44.0),
]
wanted_views = [view for view in VIEWS if not ONLY or view[0] in ONLY]
if not wanted_views:
    print("=== PREVIEW FAILED ===")
    print("No view matched --views %s" % ",".join(ONLY))
    raise SystemExit(1)

print("=== dev3d OFFICE PREVIEW ===")
for name, location, target, lens in wanted_views:
    camera.data.lens = lens
    camera.location = Vector(location)
    camera.rotation_euler = (Vector(target) - Vector(location)).to_track_quat('-Z', 'Y').to_euler()
    out = os.path.join(OUT_DIR, "office-%s.png" % name)
    scene.render.filepath = out
    bpy.ops.render.render(write_still=True)
    print("  %-9s lens %4.1f  camera %5.1f m back  -> %s"
          % (name, lens, (Vector(target) - Vector(location)).length, out))
print("render: %dx%d" % (scene.render.resolution_x, scene.render.resolution_y))
print("preview written")
