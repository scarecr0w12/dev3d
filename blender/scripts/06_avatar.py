"""dev3d - the employee avatar, as an asset.

Why this file exists
--------------------
The figures in the office were the last thing built out of raw browser
primitives: boxes for a torso, a sphere for a head, two rings for a halo. They are
the one part of this project that could not be edited in Blender, could not be
seen in `preview:office`, and could not be reviewed anywhere except by loading the
app and looking at a screenshot.

So the figure is authored here, in the same language as everything else - bevelled
boxes, rounded limbs, smooth shading with an angle threshold - and exported to
`avatar.glb`. `apps/web/src/office/avatar.ts` clones it per employee and recolours
it; the procedural figure stays as the fallback for when the asset is missing, the
same way a missing block kit is survivable.

What it does *not* do
---------------------
There is no armature and no skinning. The browser animates this by moving named
parts - `Body` rises onto its feet, `LegL`/`LegR` swing, `SeatedLegs` is what a
chair folds a person into - and that contract is what the verification harness
asserts, so a skinned mesh would trade a checked pose for a checked animation
clip. That is a deliberate seam, not an oversight: see the note in
`docs/design-notes.md`.

Coordinates
-----------
Authored in Blender's frame and converted by the exporter, which maps
`(x, y, z)` to `(x, z, -y)`. The figure therefore faces **-Y** here, because the
browser's forward is +Z. Every position below is written in the *browser's* frame
and converted by `at()`, so the numbers can be read against `avatar.ts` directly
instead of being mentally rotated first.

    blender --background --factory-startup --python blender/scripts/06_avatar.py
"""

import bpy
import math
import os
from mathutils import Vector

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(REPO, "apps", "web", "public", "office", "avatar.glb")

# The two constants the proportions hang off, mirrored from `avatar.ts`. `HIP_Y` is
# the seat height the office furniture actually builds, and the standing leg is
# exactly `HIP_Y + STANCE` long so that a raised body's soles land on the floor.
HIP_Y = 0.5
STANCE = 0.44
SHOULDER_Y = 0.94

# ============================================================ reset
for ob in list(bpy.data.objects):
    bpy.data.objects.remove(ob, do_unlink=True)
for coll in list(bpy.data.collections):
    bpy.data.collections.remove(coll)
for mat_ in list(bpy.data.materials):
    bpy.data.materials.remove(mat_)

SCENE = bpy.context.scene
SCENE.unit_settings.system = 'METRIC'

# ============================================================ materials
#
# Neutral on purpose. Every colour comes from the employee's `Role.appearance` in
# the browser, which recolours these by name; naming them `A_*` keeps the avatar's
# surfaces out of the office's role table, which is about floors and walls.
MATERIALS = {
    "body": ('A_Body', (0.55, 0.60, 0.66), 0.62, 0.06),
    "head": ('A_Head', (0.86, 0.72, 0.63), 0.72, 0.02),
    "accent": ('A_Accent', (0.30, 0.36, 0.45), 0.45, 0.16),
    "dark": ('A_Dark', (0.13, 0.14, 0.17), 0.55, 0.25),
    "hair": ('A_Hair', (0.17, 0.18, 0.21), 0.85, 0.0),
    "lamp": ('A_Lamp', (0.60, 0.85, 1.0), 0.30, 0.10),
    "screen": ('A_Screen', (0.05, 0.10, 0.16), 0.40, 0.0),
}
EMISSIVE = {"lamp": (0.62, 0.85, 1.0), "screen": (0.35, 0.70, 1.0)}

M = {}
for key, (name, rgb, rough, metal) in MATERIALS.items():
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    for node in material.node_tree.nodes:
        if node.type != 'BSDF_PRINCIPLED':
            continue
        node.inputs["Base Color"].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
        node.inputs["Roughness"].default_value = rough
        node.inputs["Metallic"].default_value = metal
        if key in EMISSIVE:
            emit = EMISSIVE[key]
            node.inputs["Emission Color"].default_value = (emit[0], emit[1], emit[2], 1.0)
            node.inputs["Emission Strength"].default_value = 2.0
    M[key] = material

# ============================================================ part library
PARTS = {}
BEVEL = 0.012
SMOOTH_ANGLE = math.radians(34.0)


def at(x, y, z):
    """A browser-frame position in Blender's frame. See the note at the top."""
    return (x, -z, y)


def size_of(sx, sy, sz):
    return (sx, sz, sy)


def _shade_smooth(ob, angle):
    for op in ("shade_smooth_by_angle", "shade_auto_smooth"):
        fn = getattr(bpy.ops.object, op, None)
        if fn is None:
            continue
        try:
            fn(angle=angle)
            return op
        except Exception:
            continue
    bpy.ops.object.shade_flat()
    return "flat"


def _shape(kind, size, surface, material, verts=20):
    key = (kind, tuple(round(v, 4) for v in size), surface, verts)
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
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    # A limb is a cylinder with its rims rounded off, which at this size reads as
    # the capsule the browser builds. The bevel is clamped to a third of the
    # thinnest axis so a 5 cm arm is rounded rather than turned into a lozenge.
    width = min(BEVEL, min(size) / 2.5)
    if width > 0.0005:
        mod = ob.modifiers.new(name="Bevel", type='BEVEL')
        mod.width = width
        mod.segments = 3
        mod.limit_method = 'ANGLE'
        mod.angle_limit = math.radians(30.0)
        bpy.context.view_layer.objects.active = ob
        ob.select_set(True)
        bpy.ops.object.modifier_apply(modifier=mod.name)
    _shade_smooth(ob, SMOOTH_ANGLE)
    mesh = ob.data
    mesh.materials.append(material)
    bpy.data.objects.remove(ob, do_unlink=True)
    PARTS[key] = mesh
    return mesh


def place(name, kind, box_size, loc, material, parent, rot=(0.0, 0.0, 0.0), verts=20):
    """One part, positioned in the browser's frame, parented in Blender's.

    `loc` is in the **parent's** frame. Parenting is left to do the arithmetic - no
    `matrix_parent_inverse` - because that inverse means "keep the child where it
    is in the world", which would pin a leg to the floor instead of hanging it off
    the hip. Every pivot here is translated but never rotated, so a browser-frame
    offset converts the same way at any depth.
    """
    mesh = _shape(kind, size_of(*box_size), material.name, material, verts)
    ob = bpy.data.objects.new(name, mesh)
    ob.location = at(*loc)
    ob.rotation_euler = rot
    if parent is not None:
        # Kept as a parent relationship rather than baked into the mesh, because a
        # limb has to be rotatable about its joint by the animation.
        ob.parent = parent
    bpy.context.scene.collection.objects.link(ob)
    bpy.context.view_layer.update()
    return ob


def pivot(name, loc, parent):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = 'PLAIN_AXES'
    ob.empty_display_size = 0.08
    ob.location = at(*loc)
    if parent is not None:
        ob.parent = parent
    bpy.context.scene.collection.objects.link(ob)
    bpy.context.view_layer.update()
    return ob


# ============================================================ the figure
body = pivot("Body", (0.0, 0.0, 0.0), None)

# ---- folded legs, which is what a chair does to a person ----
seated = pivot("SeatedLegs", (0.0, 0.0, 0.0), body)
for side in (-1, 1):
    place("Seated_Thigh_%d" % side, 'box', (0.125, 0.125, 0.34),
          (side * 0.10, HIP_Y + 0.035, 0.16), M["dark"], seated)
    place("Seated_Shin_%d" % side, 'cyl', (0.10, 0.10, 0.40),
          (side * 0.10, HIP_Y - 0.23, 0.31), M["dark"], seated)
    place("Seated_Foot_%d" % side, 'box', (0.115, 0.055, 0.20),
          (side * 0.10, 0.033, 0.36), M["dark"], seated)

# ---- torso ----
place("Pelvis", 'box', (0.29, 0.19, 0.21), (0.0, HIP_Y + 0.055, 0.0), M["body"], body)
place("Belt", 'box', (0.305, 0.05, 0.225), (0.0, HIP_Y + 0.155, 0.0), M["accent"], body)
place("Torso", 'box', (0.335, 0.32, 0.215), (0.0, HIP_Y + 0.33, 0.0), M["body"], body)
place("Shoulders", 'box', (0.42, 0.105, 0.21), (0.0, SHOULDER_Y - 0.005, 0.0), M["accent"], body)
place("Neck", 'cyl', (0.096, 0.096, 0.11), (0.0, SHOULDER_Y + 0.065, 0.0), M["head"], body)

# ---- head, with the hair as a clipped sphere rather than a full ball ----
bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=16, radius=0.125, location=at(0.0, 1.16, 0.0))
sphere = bpy.context.active_object
sphere.name = "Head"
sphere.scale = (1.0, 1.02, 1.08)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
_shade_smooth(sphere, SMOOTH_ANGLE)
sphere.data.materials.append(M["head"])
sphere.parent = body

bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=10, radius=0.132,
                                     location=at(0.0, 1.168, -0.004))
hair = bpy.context.active_object
hair.name = "Hair"
# A cap, not a ball: a full sphere over the head would cover the face.
for vertex in hair.data.vertices:
    if vertex.co.z < -0.02:
        vertex.co.z = -0.02
_shade_smooth(hair, SMOOTH_ANGLE)
hair.data.materials.append(M["hair"])
hair.parent = body

place("Headset_Band", 'box', (0.205, 0.026, 0.03), (0.0, 1.196, 0.10), M["accent"], body)
for side in (-1, 1):
    place("EarCup_%d" % side, 'box', (0.028, 0.075, 0.03),
          (side * 0.136, 1.16, 0.005), M["accent"], body)
place("Mic_Boom", 'box', (0.016, 0.10, 0.016), (0.118, 1.115, 0.05), M["accent"], body, rot=(0.5, 0.0, 0.0))
place("Chest_Lamp", 'box', (0.085, 0.026, 0.018), (0.0, 0.90, 0.112), M["lamp"], body)

# ---- legs, which only a walked body has ----
for side, name in ((-1, "LegL"), (1, "LegR")):
    hip = pivot(name, (side * 0.098, HIP_Y, 0.0), body)
    place("%s_Thigh" % name, 'cyl', (0.116, 0.116, 0.47), (0.0, -0.235, 0.0), M["dark"], hip)
    place("%s_Shin" % name, 'cyl', (0.10, 0.10, 0.44), (0.0, -0.69, 0.0), M["dark"], hip)
    # The sole lands exactly HIP_Y + STANCE below the hip, or a raised figure floats.
    place("%s_Shoe" % name, 'box', (0.115, 0.055, 0.205),
          (0.0, -(HIP_Y + STANCE) + 0.0275, 0.035), M["dark"], hip)

# ---- arms ----
for side, name in ((-1, "ArmL"), (1, "ArmR")):
    arm = pivot(name, (side * 0.238, SHOULDER_Y, 0.0), body)
    place("%s_Upper" % name, 'cyl', (0.10, 0.10, 0.46), (0.0, -0.245, 0.0), M["body"], arm)
    place("%s_Hand" % name, 'box', (0.075, 0.085, 0.085), (0.0, -0.525, 0.01), M["accent"], arm)

# ---- the tablet somebody is holding when they are working ----
tablet = pivot("Tablet", (0.0, 0.80, 0.235), body)
place("Tablet_Back", 'box', (0.30, 0.014, 0.18), (0.0, 0.0, 0.0), M["dark"], tablet)
place("Tablet_Screen", 'box', (0.28, 0.17, 0.012), (0.0, 0.085, -0.075), M["screen"], tablet,
      rot=(-0.38, 0.0, 0.0))

# ============================================================ assert the contract
#
# The browser drives this by name, so the names are the interface: `Body` is what
# rises, `LegL`/`LegR` are the stride, `SeatedLegs` is what is hidden when the
# figure stands. A rename here is a rename of the pose, and it would fail as a
# silently un-animated figure rather than as an error.
REQUIRED = ["Body", "LegL", "LegR", "SeatedLegs", "ArmL", "ArmR", "Tablet"]
problems = []
for name in REQUIRED:
    if bpy.data.objects.get(name) is None:
        problems.append("no node named %s" % name)

# The sole of a standing leg has to reach the floor once the body is raised.
bpy.context.view_layer.update()
for name in ("LegL", "LegR"):
    hip = bpy.data.objects.get(name)
    if hip is None:
        continue
    for shoe in [ob for ob in bpy.data.objects if ob.name.startswith("%s_Shoe" % name)]:
        # Browser y is Blender z. The shoe's centre sits half a shoe above the sole,
        # and the whole figure rises by STANCE, so a sole on the floor measures zero.
        centre = shoe.matrix_world.translation.z
        sole = centre - 0.0275 + STANCE
        if abs(sole) > 0.01:
            problems.append("%s sole sits at %.3f m, not on the floor" % (name, sole))

if problems:
    print("=== AVATAR CONTRACT VIOLATED ===")
    for problem in problems:
        print("  " + problem)
    raise SystemExit(1)

# ============================================================ export
bpy.ops.object.select_all(action='DESELECT')
os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format='GLB',
    use_selection=False,
    export_apply=True,
    export_yup=True,
    export_cameras=False,
    export_lights=False,
    export_animations=False,
    export_materials='EXPORT',
)

meshes = [ob for ob in bpy.data.objects if ob.type == 'MESH']
print("=== dev3d AVATAR BUILT ===")
print("parts: %d meshes of %d shared shapes | materials: %d" % (len(meshes), len(PARTS), len(MATERIALS)))
print("nodes: %s" % ", ".join(REQUIRED))
print("hips at %.2f m (the seat height), standing leg %.2f m" % (HIP_Y, HIP_Y + STANCE))
print("exported: %s (%d KB)" % (OUT, os.path.getsize(OUT) // 1024))
