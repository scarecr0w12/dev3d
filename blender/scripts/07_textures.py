"""dev3d - build the PBR texture library the office is dressed with.

Why this file exists
--------------------
Until now every surface in the office was a flat colour multiplied by a small
greyscale pattern generated in the browser: no image files, nothing to await,
nothing to fetch. The cost of that is that a texture could only make a surface
*lighter or darker* - never a different hue, never a different material. Concrete
was grey with a grid drawn on it.

This writes the other half: real albedo, normal and roughness maps, as real files,
at a real physical scale. They are **authored rather than scanned** - this machine
has no HTTPS route to a texture library, which is worth knowing rather than
pretending otherwise - so the quality ceiling is lower than a photogrammetry set.
What they do have is the thing that matters: full colour variation, a height field
that a normal map is derived from, and roughness that varies across the surface
instead of being one number.

Dropping scanned maps in later is a file swap, not a code change: the loader keys
on role and file name, and nothing here is baked into the renderer.

The scale convention is the one the assets already use: **one UV unit is one
metre**, so `tile_metres` below is both the size of the texture on the floor and
the number that keeps texel density even across a 20 cm drawer and an 8 m slab.

    blender --background --factory-startup --python blender/scripts/07_textures.py

Add `-- --size 512` for a faster, smaller run, or `-- --only concrete,wood`.
"""

import bpy
import json
import math
import os
import struct
import sys
import zlib
import numpy as np


def _repo_root():
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
OUT = os.path.join(REPO, "apps", "web", "public", "textures")

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, fallback):
    if name in argv:
        at = argv.index(name)
        if at + 1 < len(argv):
            return argv[at + 1]
    return fallback


SIZE = int(arg("--size", "1024"))
ONLY = [part for part in arg("--only", "").split(",") if part]


# --------------------------------------------------------------------- noise
#
# Every field has to **tile**, because these are floor and wall finishes: a seam
# every two metres would be worse than no texture at all. Value noise on a lattice
# that wraps at its own cell count is exactly periodic over the image, so every
# octave can be summed without a seam appearing anywhere.

def value_noise(cells, size, seed):
    """Seamless value noise on a `cells` x `cells` lattice, sampled size x size."""
    lattice = np.random.default_rng(seed).random((cells, cells))
    step = cells / size
    axis = np.arange(size) * step
    base = np.floor(axis).astype(np.int64)
    frac = axis - base
    smooth = frac * frac * (3.0 - 2.0 * frac)          # smoothstep, so no lattice creases
    lo = base % cells
    hi = (base + 1) % cells
    v00 = lattice[np.ix_(lo, lo)]
    v10 = lattice[np.ix_(lo, hi)]
    v01 = lattice[np.ix_(hi, lo)]
    v11 = lattice[np.ix_(hi, hi)]
    top = v00 + (v10 - v00) * smooth[None, :]
    bottom = v01 + (v11 - v01) * smooth[None, :]
    return top + (bottom - top) * smooth[:, None]


def fbm(base_cells, size, seed, octaves=5, gain=0.5):
    """Layered noise, normalised to 0..1. Each octave is periodic, so the sum is."""
    total = np.zeros((size, size))
    amplitude = 1.0
    norm = 0.0
    for octave in range(octaves):
        total += amplitude * value_noise(base_cells * (2 ** octave), size, seed + octave * 977)
        norm += amplitude
        amplitude *= gain
    return total / norm


def normal_from_height(height, slope):
    """A tangent-space normal map from a height field, wrapping at the edges.

    `slope` is the *typical* steepness to encode, and the gradient is scaled to hit
    it rather than being multiplied by the image size. That distinction is the whole
    of this function: a per-pixel difference across a 512 px tile is a slope of 512
    times itself in UV space, so scaling by the size produces a normal map that is
    almost entirely sideways - which does not look like a rough surface, it looks
    like television static, and it does it at every mip level.
    """
    dy, dx = np.gradient(height)
    rms = float(np.sqrt(np.mean(dx * dx + dy * dy)))
    scale = slope / rms if rms > 1e-9 else 0.0
    nx = -dx * scale
    ny = -dy * scale
    nz = np.ones_like(height)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack((nx / length * 0.5 + 0.5, ny / length * 0.5 + 0.5, nz / length * 0.5 + 0.5), axis=-1)


def to_srgb(linear):
    """Encode linear light as sRGB, which is what an albedo file holds."""
    clipped = np.clip(linear, 0.0, 1.0)
    return np.where(clipped <= 0.0031308, clipped * 12.92, 1.055 * np.power(clipped, 1 / 2.4) - 0.055)


def tint(colour, shade):
    """A linear RGB triple scaled per-channel by a 0..1 field."""
    return np.stack([colour[channel] * shade for channel in range(3)], axis=-1)


# ------------------------------------------------------------------ materials
#
# Each builder returns (albedo in linear light, height, roughness) - the three
# channels, derived from one field so they are in register with each other.

def build_concrete(size):
    """Poured concrete: mottled, pitted, with the surface polished unevenly."""
    mottle = fbm(3, size, 11, octaves=5)
    pores = fbm(48, size, 23, octaves=2)
    grit = fbm(160, size, 31, octaves=1)
    # Aggregate showing through where the surface was ground back.
    stone = np.clip((fbm(24, size, 47, octaves=2) - 0.52) * 6.0, 0.0, 1.0)
    height = mottle * 0.45 + pores * 0.35 + grit * 0.2 - stone * 0.12
    # The fine grit is *not* in the albedo. Grain at a two-centimetre scale reads as
    # noise on a wall and as nothing at all in a photograph of concrete; it belongs
    # in the height field, where it becomes shading rather than speckle.
    shade = 0.74 + mottle * 0.20 - stone * 0.16
    albedo = tint((0.62, 0.62, 0.60), shade)
    albedo += tint((0.05, 0.05, 0.055), stone)          # aggregate is darker and cooler
    roughness = np.clip(0.62 + mottle * 0.22 - stone * 0.18 + pores * 0.08, 0.0, 1.0)
    return albedo, height, roughness


def build_plaster(size):
    """Painted plaster: a fine roller stipple over a slightly uneven skim."""
    skim = fbm(2, size, 101, octaves=3)
    stipple = fbm(96, size, 113, octaves=2)
    height = skim * 0.25 + stipple * 0.75
    # Paint is flat: the roller texture is a *sheen* effect, so it lives in the
    # roughness and the height, and the colour only varies at the scale of the skim.
    shade = 0.93 + skim * 0.07
    albedo = tint((0.82, 0.82, 0.81), shade)
    roughness = np.clip(0.86 + stipple * 0.10 - skim * 0.04, 0.0, 1.0)
    return albedo, height, roughness


def build_wood(size):
    """Sapling oak: growth rings, a warp in the grain, and a fine fibre along it."""
    # The grain runs up the tile, and the rings are warped so they are not stripes.
    v = np.linspace(0.0, 1.0, size)[:, None] * np.ones((1, size))
    u = np.ones((size, 1)) * np.linspace(0.0, 1.0, size)[None, :]
    warp = fbm(3, size, 211, octaves=3)
    rings = np.sin((u * 5.0 + warp * 0.55 + v * 0.12) * math.pi * 2.0) * 0.5 + 0.5
    rings = rings ** 1.6
    fibre = fbm(128, size, 223, octaves=2, gain=0.6)
    height = rings * 0.55 + fibre * 0.45
    # The grain carries the colour - that is what wood looks like - but the fibre
    # streak is a *finish*, so it stays out of the albedo and in the height.
    shade = 0.82 + rings * 0.22
    albedo = tint((0.42, 0.30, 0.19), shade)
    albedo += tint((0.10, 0.06, 0.03), np.clip(1.0 - rings, 0.0, 1.0) * 0.5)   # darker late wood
    roughness = np.clip(0.44 + (1.0 - rings) * 0.22 + fibre * 0.10, 0.0, 1.0)
    return albedo, height, roughness


def build_carpet(size):
    """Loop pile: a dense short fibre over a tufted grid."""
    fibre = fbm(200, size, 307, octaves=2, gain=0.7)
    tuft = fbm(64, size, 311, octaves=2)
    # A faint grid of rows, which is what a tufted carpet actually looks like.
    rows = np.abs(np.sin(np.linspace(0.0, math.pi * 64.0, size)))[:, None] * np.ones((1, size))
    height = fibre * 0.6 + tuft * 0.25 + rows * 0.15
    # A carpet's colour varies at the scale of its tufts, not of its fibres.
    shade = 0.84 + tuft * 0.16 + rows * 0.06
    albedo = tint((0.16, 0.18, 0.21), shade)
    roughness = np.clip(0.93 + fibre * 0.05, 0.0, 1.0)
    return albedo, height, roughness


def build_fabric(size):
    """Upholstery weave: warp and weft over and under, with slub in the yarn."""
    warp = np.abs(np.sin(np.linspace(0.0, math.pi * 40.0, size)))[:, None] * np.ones((1, size))
    weft = np.ones((size, 1)) * np.abs(np.sin(np.linspace(0.0, math.pi * 40.0, size)))[None, :]
    over = (warp > weft).astype(float)
    slub = fbm(96, size, 401, octaves=2)
    height = np.where(over > 0.5, warp, weft) * 0.6 + slub * 0.4
    shade = 0.74 + np.where(over > 0.5, warp, weft) * 0.20 + slub * 0.14
    albedo = tint((0.24, 0.29, 0.36), shade)
    roughness = np.clip(0.86 + slub * 0.10, 0.0, 1.0)
    return albedo, height, roughness


def build_rug(size):
    """A flat-weave rug: thicker and fuzzier yarn than upholstery, with slub.

    A rug is the one soft surface in the office that is *looked down at*, so its
    weave is coarser than a chair's - sixteen yarns across a metre rather than
    forty - and it carries more fuzz, which is what separates wool from upholstery
    at the same colour.
    """
    warp = np.abs(np.sin(np.linspace(0.0, math.pi * 16.0, size)))[:, None] * np.ones((1, size))
    weft = np.ones((size, 1)) * np.abs(np.sin(np.linspace(0.0, math.pi * 16.0, size)))[None, :]
    over = np.where(warp > weft, warp, weft)
    yarn = fbm(64, size, 601, octaves=3)
    fuzz = fbm(220, size, 607, octaves=2, gain=0.7)
    height = over * 0.5 + yarn * 0.3 + fuzz * 0.2
    shade = 0.80 + over * 0.14 + yarn * 0.10
    albedo = tint((0.34, 0.32, 0.30), shade)
    roughness = np.clip(0.92 + fuzz * 0.06, 0.0, 1.0)
    return albedo, height, roughness


def build_metal(size):
    """Brushed steel: long directional streaks, and nothing else."""
    streak = value_noise(256, size, 503)          # one row of noise, stretched down the tile
    streak = np.repeat(streak[:1, :], size, axis=0)
    broad = fbm(4, size, 509, octaves=3)
    fine = np.repeat(value_noise(512, size, 521)[:1, :], size, axis=0)
    height = streak * 0.6 + fine * 0.2 + broad * 0.2
    shade = 0.86 + streak * 0.10 + broad * 0.08
    albedo = tint((0.55, 0.56, 0.58), shade)
    roughness = np.clip(0.28 + streak * 0.16 + broad * 0.10, 0.0, 1.0)
    return albedo, height, roughness


MATERIALS = [
    # role is the style role this set dresses; tile_metres is how much floor, wall
    # or desk one tile of it covers - which is also its texel density - and slope is
    # how steep the surface reads, as the typical tangent-space slope to encode.
    #
    # These are deliberately gentle. Paint over plaster is nearly flat (a slope of
    # 0.12 is about seven degrees), and the first pass here asked for 0.30 - which
    # shingles a wall in visible ripple at arm's length rather than reading as a
    # finish. A slope that looks right on a sphere is too much on a wall.
    ("concrete", "floor", 2.0, 0.30, build_concrete),
    ("plaster", "wall", 2.0, 0.12, build_plaster),
    ("wood", "desk", 1.6, 0.32, build_wood),
    ("carpet", "carpet", 1.5, 0.65, build_carpet),
    ("rug", "rug", 1.2, 0.55, build_rug),
    ("fabric", "soft", 0.8, 0.42, build_fabric),
    ("metal", "frame", 1.0, 0.14, build_metal),
]


# --------------------------------------------------------------------- output

def write_png(path, rgb):
    """Write an 8-bit truecolour PNG. Returns its size in bytes.

    Written here rather than through `bpy.data.images` on purpose. Blender's image
    save is three traps deep for generated buffers: `save()` writes PNG whatever
    `file_format` says, it writes a *corrupt* buffer unless the image is packed, and
    packing a float-buffer image still produced a fully transparent file (every map
    exactly 7 KB, mean 0.250 - which is RGBA of black with alpha 1). Twenty lines of
    `zlib` and `struct` have none of that, and a PNG is a container this can verify.
    """
    height, width = rgb.shape[:2]
    payload = b"".join(b"\x00" + rgb[y].tobytes() for y in range(height))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)   # 8-bit RGB
    blob = (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(payload, 6))
            + chunk(b"IEND", b""))
    with open(path, "wb") as handle:
        handle.write(blob)
    return len(blob)


def encode(rgb):
    """Float 0..1 to the bytes a PNG holds, with the field's own spread checked.

    A texture that is one flat colour passes every other check in this repository
    and is worthless, so it is refused here rather than shipped.
    """
    data = np.clip(rgb, 0.0, 1.0)
    if data.ndim == 2:
        # A roughness map is one channel of information; the file carries it in all
        # three, because that is what an image is and what three.js reads back.
        data = np.repeat(data[:, :, None], 3, axis=2)
    spread = float(data.max() - data.min())
    # A blank write has no spread at all; a deliberately subtle finish like painted
    # plaster has a little. The floor is set to tell those apart rather than to
    # judge how strong a texture should be.
    if spread < 0.01:
        raise SystemExit("a map came out flat (spread %.4f) - nothing to texture with" % spread)
    return np.rint(data * 255.0).astype(np.uint8)


def write_set(name, role, tile, relief, builder):
    albedo, height, roughness = builder(SIZE)
    normal = normal_from_height(height, relief)
    # Roughness is a low-frequency channel on every one of these surfaces, so it is
    # stored at half size: a quarter of the bytes for something nobody can see.
    rough_small = roughness[::2, ::2]
    written = []
    for suffix, data in (
        ("albedo", to_srgb(albedo)),
        ("normal", normal),
        ("roughness", rough_small),
    ):
        path = os.path.join(OUT, "%s_%s.png" % (name, suffix))
        size_bytes = write_png(path, encode(data))
        written.append((suffix, size_bytes))
    # The albedo's own average, in **linear** light, which is the space the renderer
    # multiplies in. A style's colour means "the colour of this surface", and the map
    # already carries a colour, so the browser divides one by the other - see
    # `applyPbrSet`. Without it every textured surface renders darker than the preset
    # says it is, by exactly the albedo's average.
    mean = [float(np.clip(albedo[:, :, channel].mean(), 0.01, 1.0)) for channel in range(3)]
    return {"id": name, "role": role, "tileMetres": tile, "albedoMean": mean, "files": written}


os.makedirs(OUT, exist_ok=True)

print("=== dev3d PBR TEXTURE LIBRARY ===")
print("size: %d px | out: %s" % (SIZE, OUT))
entries = []
total = 0
for name, role, tile, relief, builder in MATERIALS:
    if ONLY and name not in ONLY:
        continue
    result = write_set(name, role, tile, relief, builder)
    entries.append(result)
    for suffix, size_bytes in result["files"]:
        total += size_bytes
        print("  %-10s %-9s %7.0f KB" % (name, suffix, size_bytes / 1024.0))
    print("  %-10s dresses role '%s', one tile covers %.1f m, albedo mean (%.2f, %.2f, %.2f)"
          % (name, role, tile, result["albedoMean"][0], result["albedoMean"][1], result["albedoMean"][2]))

# The sidecar the browser reads, so the scale and the file names live in one place
# rather than in two that can drift.
index = {
    "note": "Generated by blender/scripts/07_textures.py. Do not hand-edit.",
    "uvUnits": "metres",
    "pixelSize": SIZE,
    "sets": [
        {"id": e["id"], "role": e["role"], "tileMetres": e["tileMetres"], "albedoMean": e["albedoMean"]}
        for e in entries
    ],
}
with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as handle:
    json.dump(index, handle, indent=2)
    handle.write("\n")

print("sets: %d | total %.1f MB | index written" % (len(entries), total / (1024.0 * 1024.0)))
