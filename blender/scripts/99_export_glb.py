"""dev3d - export the office to GLB for the web app.

The `Seat_*` and `Anchor_Room_*` empties are the contract between Blender and
the browser: they survive export as named nodes, so the office UI can place an
employee at a desk by name instead of hard-coding coordinates.

Blender is Z-up; glTF is Y-up. The exporter converts automatically
(blender X,Y,Z -> gltf X, Z, -Y), and the node transforms carry that, so the
browser needs no manual correction.

**Read this before running it.** `01_office_shell.py` builds the architectural
shell only - the floor, the walls, the meeting room. The desks, chairs and
`Seat_*` anchors were authored in interactive Blender sessions that were never
written back to a script. So running 01 and then 99 replaces the furnished
office with a bare shell, and this script will refuse to do it. Pass
`-- --force-empty` if you really mean to.

Run through the Blender MCP bridge. Safe mode allows import/export operators
but not `os`, so the output path is fixed and verification happens outside.
"""

import bpy
import json
import math
import sys

OUT = r"E:\Development\dev3d\apps\web\public\office\office.glb"

seats_present = [o for o in bpy.data.objects if o.type == 'EMPTY' and o.name.startswith("Seat_")]
force = "--force-empty" in sys.argv
if not seats_present and not force:
    print("=== dev3d GLB EXPORT REFUSED ===")
    print("The scene has no Seat_* anchors, so it is not the furnished office.")
    print("This is almost always '01_office_shell.py ran but the furniture did not':")
    print("the desks and chairs were authored interactively and are not scripted,")
    print("so re-running 01 destroys them. Nothing was written.")
    print("Pass '-- --force-empty' to export anyway.")
    raise SystemExit(1)

bpy.ops.object.select_all(action='DESELECT')

try:
    bpy.ops.export_scene.gltf(
        filepath=OUT,
        export_format='GLB',
        use_selection=False,
        export_apply=True,
        export_yup=True,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
        export_animations=False,
        export_materials='EXPORT',
    )
    mode = "full"
except TypeError as exc:
    print("full kwargs rejected (%s); falling back" % exc)
    bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB')
    mode = "minimal"

def by_name(ob):
    return ob.name


anchors = []
for ob in sorted(bpy.data.objects, key=by_name):
    if ob.name.startswith("Seat_") or ob.name.startswith("Anchor_"):
        anchors.append({
            "name": ob.name,
            "blender": [round(ob.location.x, 3), round(ob.location.y, 3), round(ob.location.z, 3)],
            "gltf": [round(ob.location.x, 3), round(ob.location.z, 3), round(-ob.location.y, 3)],
            "yawDeg": round(math.degrees(ob.rotation_euler.z), 1),
        })

meshes = [o for o in bpy.data.objects if o.type == 'MESH']
polys = sum(len(o.data.polygons) for o in meshes)

print("=== dev3d GLB EXPORT ===")
print("mode: %s" % mode)
print("path: %s" % OUT)
print("exported meshes: %d | polygons: %d | empties: %d" % (
    len(meshes), polys, len([o for o in bpy.data.objects if o.type == 'EMPTY'])))
print("ANCHORS_JSON=" + json.dumps(anchors))
