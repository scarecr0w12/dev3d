"""dev3d - render a contact sheet of the block kit.

The kit is 24 modules that all sit at the origin, which is right for an asset
that exists to be instanced and useless for looking at. This builds the kit,
lays the modules out in a grid, adds a camera and a neutral three-point rig, and
renders one image - so a change to a room is something you can *see* before it
reaches the browser.

It is deliberately not part of the export path: it writes a PNG to `blender/out`
and touches nothing the app loads.

    blender --background --factory-startup --python blender/scripts/04_preview_blocks.py

Add `-- --cols 6 --width 2400` to taste.
"""

import bpy
import math
import os
import sys
from mathutils import Euler, Vector


def _repo_root():
    """This checkout's root, from this file's own location.

    Blender's `--python` sets `__file__`, so the script finds the kit it means to
    draw and the directory it means to write into without a hard-coded path.
    `DEV3D_REPO_ROOT` overrides it for the unusual case where `__file__` is absent.
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
HERE = os.path.join(REPO, "blender", "scripts", "02_office_blocks.py")
OUT = os.path.join(REPO, "blender", "out", "blocks-preview.png")

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, fallback):
    if name in argv:
        at = argv.index(name)
        if at + 1 < len(argv):
            return argv[at + 1]
    return fallback


COLS = int(arg("--cols", "6"))
IMAGE_W = int(arg("--width", "2400"))
# Modules to draw, by id ("attention" only): `--only pod4,lounge3` renders the
# sheet with everything else hidden, which is how a single room gets inspected.
ONLY = [part for part in arg("--only", "").split(",") if part]
SPACING_X, SPACING_Y = 19.0, 15.0

# Build the kit. `exec` on a file read here is ordinary Python: this script is
# run by Blender itself, not through the MCP bridge's safe mode. Its own report
# is swallowed, because this script prints its own.
with open(HERE, encoding="utf-8") as handle:
    source = handle.read()
scope = {"__name__": "__kit__", "__file__": HERE}
try:
    exec(compile(source, HERE, "exec"), scope)
except SystemExit as exc:
    print("the kit script refused to build: SystemExit(%s)" % exc.code)
    raise

names = [ob.name for ob in bpy.data.objects if ob.type == 'EMPTY' and ob.name.startswith("Kit_")]
names.sort()
if ONLY:
    names = [name for name in names if name[len("Kit_"):] in ONLY]
if not names:
    print("=== PREVIEW FAILED ===")
    print("No Kit_* modules to draw (only=%s)." % ",".join(ONLY))
    raise SystemExit(1)

for index, name in enumerate(names):
    root = bpy.data.objects[name]
    root.location = ((index % COLS) * SPACING_X, -(index // COLS) * SPACING_Y, 0.0)

rows = math.ceil(len(names) / COLS)
span_x = max(1.0, (min(COLS, len(names)) - 1) * SPACING_X)
span_y = max(1.0, (rows - 1) * SPACING_Y)

# A neutral rig, so the preview shows the geometry rather than a mood. The app
# styles the floor; this is here to make a wall legible.
bpy.ops.object.light_add(type='SUN', location=(span_x / 2.0 + 14.0, span_y / 2.0 - 18.0, 24.0))
sun = bpy.context.active_object
sun.data.energy = 2.6
sun.rotation_euler = Euler((math.radians(46.0), 0.0, math.radians(34.0)))

world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
bpy.context.scene.world = world
world.use_nodes = True
for node in world.node_tree.nodes:
    if node.type == 'BACKGROUND':
        node.inputs[0].default_value = (0.09, 0.10, 0.12, 1.0)
        node.inputs[1].default_value = 1.0

# A matte floor under the grid so the modules have something to stand on. It
# sits below the modules' own slabs, or it swallows them at this angle.
bpy.ops.mesh.primitive_plane_add(size=max(span_x, span_y) * 3.0,
                                 location=(span_x / 2.0, -span_y / 2.0, -0.35))
floor = bpy.context.active_object
floor.name = "Preview_Ground"
floor_material = bpy.data.materials.new("Preview_Ground")
floor_material.use_nodes = True
for node in floor_material.node_tree.nodes:
    if node.type == 'BSDF_PRINCIPLED':
        node.inputs["Base Color"].default_value = (0.13, 0.14, 0.17, 1.0)
        node.inputs["Roughness"].default_value = 0.95
floor.data.materials.append(floor_material)

# Frame the grid by arithmetic rather than by guessing a distance: take a box
# around every module - its declared footprint plus a small margin - and pull
# back until that box fits both the horizontal and the vertical field of view.
span_box_x = max(1.0, (min(COLS, len(names)) - 1) * SPACING_X) + 18.0
span_box_y = max(1.0, (rows - 1) * SPACING_Y) + 10.0
half_diagonal = math.sqrt((span_box_x / 2.0) ** 2 + (span_box_y / 2.0) ** 2 + 1.6 ** 2)
centre = Vector((span_x / 2.0, -span_y / 2.0, 0.8))

scene = bpy.context.scene
scene.render.resolution_x = IMAGE_W
scene.render.resolution_y = int(IMAGE_W * 0.60)
aspect = scene.render.resolution_x / scene.render.resolution_y

# A long lens from a high-ish angle reads as a building; a very wide one from
# straight above reads as a plan.
bpy.ops.object.camera_add(location=(0.0, 0.0, 0.0))
camera = bpy.context.active_object
camera.name = "Cam_Preview"
camera.data.lens = 42.0
scene.camera = camera

sensor = camera.data.sensor_width
fov_x = 2.0 * math.atan(sensor / (2.0 * camera.data.lens))
fov_y = 2.0 * math.atan((sensor / aspect) / (2.0 * camera.data.lens))
elevation = math.radians(52.0)
# `direction` points from the subject toward the camera, so it has to be *added*:
# subtracting it puts the camera under the floor, looking at nothing.
direction = Vector((0.0, -math.cos(elevation), math.sin(elevation)))
distance = half_diagonal / math.sin(min(fov_x, fov_y) / 2.0) * 0.98
camera.location = centre + direction * distance
look = centre - Vector(camera.location)
camera.rotation_euler = look.to_track_quat('-Z', 'Y').to_euler()

available_engines = [item.identifier for item in
                     bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
for wanted in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'BLENDER_WORKBENCH'):
    if wanted in available_engines:
        scene.render.engine = wanted
        break
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = OUT
scene.render.film_transparent = False

print("=== dev3d BLOCK KIT PREVIEW ===")
print("modules: %d in %d rows | grid %.0f x %.0f m | subject %.1f m | camera %.1f m back"
      % (len(names), rows, span_x, span_y, half_diagonal, distance))
for name in names:
    block = None
    for entry in scope["emitted"]:
        if entry["node"] == name:
            block = entry
    if block is None:
        continue
    print("  %-11s %-10s %4.1f x %4.1f m  %2d seats  props: %s"
          % (block["id"], block["furniture"], block["width"], block["depth"],
             len(block["seats"]), ", ".join(block["props"]) or "-"))
print("render: %s at %dx%d" % (OUT, scene.render.resolution_x, scene.render.resolution_y))
bpy.ops.render.render(write_still=True)
print("preview written")
