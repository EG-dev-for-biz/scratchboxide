#!/usr/bin/env python3
# Copyright (C) 2026 Scratchbox LLC. All rights reserved.
#
# This software and associated documentation files are proprietary and confidential
# to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
# of this file, via any medium, is strictly prohibited without explicit written
# permission from Scratchbox LLC.
"""
Working-resolution copies of texture library sets (gs://scratchbox-library-training-textures, indexed in
assets/textures/library/index.json) for producers that run offline from the repository, such as
scripts/generate_forest_procedural_3d.cpp. Each set's 8K maps are area-resampled (the colour map in linear light, normals
renormalised after averaging, as the engine's material_maps::prepare does), packed into glTF's albedo, normal and ORM
(R occlusion, G roughness, B metalness) maps, written as JPEG to assets/textures/library/copies/<id>/ and measured; the
set's entry in assets/textures/library/copies/index.json carries the publisher's real tile size and the measurements.
Copies are never tinted: a producer tints a copy to the colour it measures.

The sets' maps must be in a library cache first (the app's fetchLibrarySets, which needs the app's Google credentials):
  CACHE_DIR=<cache> npx vite-node <a script calling fetchLibrarySets([...ids], { repoRoot, cacheDir: CACHE_DIR })>
then, from the repository root:
  python3 scripts/copy_texture_library_sets.py <cache dir> <id>[:<max px>] ...
e.g. python3 scripts/copy_texture_library_sets.py build/texture-library Ground071:2048 Moss001:1024 bark_willow_02:2048
"""
import datetime
import json
import os
import re
import sys

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None  # the library's maps are 8K and 16K

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIBRARY_INDEX = os.path.join(REPO, 'assets', 'textures', 'library', 'index.json')
ESTIMATED_SIZES = os.path.join(REPO, 'assets', 'textures', 'library', 'estimated-sizes.json')
OUT_DIR = os.path.join(REPO, 'assets', 'textures', 'library', 'copies')
OUT_INDEX = os.path.join(OUT_DIR, 'index.json')

# the roles texture-library.ts mapRole() reads from a set's file names
ROLE_PATTERNS = [
    ('color', re.compile(r'_(Color|diff|diffuse|albedo|basecolor)[_.]', re.I)),
    ('normal', re.compile(r'_(NormalGL|nor_gl)[_.]', re.I)),
    ('roughness', re.compile(r'_(Roughness|rough)[_.]', re.I)),
    ('ao', re.compile(r'_(AmbientOcclusion|ao)[_.]', re.I)),
    ('metalness', re.compile(r'_(Metalness|metal)[_.]', re.I)),
    ('arm', re.compile(r'_arm[_.]', re.I)),
]
JPEG_QUALITY = {'albedo': 90, 'normal': 92, 'orm': 90}
# ambientCG and Poly Haven publish every set under CC0
LICENCE = {'ambientCG': 'CC0 1.0', 'Poly Haven': 'CC0 1.0'}


def role_files(set_dir, set_id):
    roles = {}
    for name in sorted(os.listdir(set_dir)):
        if not re.search(r'\.(png|jpe?g)$', name, re.I):
            continue
        rest = name[len(set_id):] if name.lower().startswith(set_id.lower()) else name
        for role, pattern in ROLE_PATTERNS:
            if pattern.search(rest):
                roles.setdefault(role, os.path.join(set_dir, name))
                break
    return roles


def read(path, mode):
    """A map as float32 0..1: 'rgb' or 'l'. 16-bit PNGs keep their precision."""
    im = Image.open(path)
    if mode == 'l':
        if im.mode in ('I;16', 'I;16B', 'I'):
            return np.asarray(im, dtype=np.float32) / 65535.0
        return np.asarray(im.convert('L'), dtype=np.float32) / 255.0
    if im.mode in ('I;16', 'I;16B', 'I'):
        g = np.asarray(im, dtype=np.float32) / 65535.0
        return np.repeat(g[..., None], 3, axis=2)
    return np.asarray(im.convert('RGB'), dtype=np.float32) / 255.0


def srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4).astype(np.float32)


def linear_to_srgb(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1.0 / 2.4) - 0.055).astype(np.float32)


def box_resample(a, size):
    """Area resampling to size x size: each output pixel the mean of the source pixels it covers (a seamless tile stays
    seamless). The library's maps are square powers of two, so the factor is a whole number."""
    h, w = a.shape[:2]
    if h != w or h % size:
        raise ValueError(f'a {w}x{h} map cannot be box-resampled to {size}')
    f = h // size
    return a.reshape(size, f, size, f, *a.shape[2:]).mean(axis=(1, 3), dtype=np.float32)


def linear_to_lab(rgb):
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = np.einsum("...j,ij->...i", rgb, m) / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def r4(v):
    return [round(float(x), 4) for x in v]


def copy_set(cache_dir, set_id, max_px, entry, estimated):
    set_dir = os.path.join(cache_dir, set_id)
    roles = role_files(set_dir, set_id)
    if 'color' not in roles:
        raise SystemExit(f'{set_id}: no colour map in {set_dir} (fetch the set into the cache first)')
    color = read(roles['color'], 'rgb')
    source_px = list(color.shape[1::-1])
    size = min(max_px, color.shape[0])
    albedo = box_resample(srgb_to_linear(color), size)
    del color

    if 'normal' in roles:
        n = box_resample(read(roles['normal'], 'rgb') * 2.0 - 1.0, size)
        n /= np.maximum(np.linalg.norm(n, axis=2, keepdims=True), 1e-6)
    else:
        n = np.zeros((size, size, 3), np.float32)
        n[..., 2] = 1.0
    tilt = np.degrees(np.arccos(np.clip(n[..., 2], -1.0, 1.0)))

    orm = np.zeros((size, size, 3), np.float32)
    orm[..., 0] = 1.0
    orm[..., 1] = 1.0
    if 'arm' in roles:
        orm = box_resample(read(roles['arm'], 'rgb'), size)
    for role, ch in (('ao', 0), ('roughness', 1), ('metalness', 2)):
        if role in roles:
            orm[..., ch] = box_resample(read(roles[role], 'l'), size)

    out = os.path.join(OUT_DIR, set_id)
    os.makedirs(out, exist_ok=True)
    maps = {}
    for name, img in (('albedo', linear_to_srgb(albedo)), ('normal', n * 0.5 + 0.5), ('orm', orm)):
        file = f'{name}.jpg'
        Image.fromarray(np.clip(np.rint(img * 255.0), 0, 255).astype(np.uint8), 'RGB').save(
            os.path.join(out, file), quality=JPEG_QUALITY[name], subsampling=0 if name != 'albedo' else 2)
        maps[name] = f'{set_id}/{file}'

    # measured on the written maps (what a producer embeds)
    written = srgb_to_linear(np.asarray(Image.open(os.path.join(out, 'albedo.jpg')).convert('RGB'), np.float32) / 255.0)
    lab = linear_to_lab(written.reshape(-1, 3).astype(np.float64))
    lin = written.reshape(-1, 3)
    real = entry.get('realSizeM')
    size_source = entry.get('sizeSource')
    if not real and set_id in estimated:
        w = estimated[set_id]['widthM']
        real = [w, w]
        size_source = f"estimated (vision model, confidence {estimated[set_id]['conf']}): generated"
    if not real:
        raise SystemExit(f'{set_id}: neither its publisher nor estimated-sizes.json gives a real tile size')
    return {
        'id': set_id,
        'publisher': entry.get('publisher'),
        'licence': LICENCE.get(entry.get('publisher'), 'see publisher'),
        'source': {'bucket': 'scratchbox-library-training-textures', 'files': sorted(os.path.relpath(p, cache_dir) for p in roles.values()), 'pixels': source_px},
        'maps': maps,
        'pixels': [size, size],
        'realSizeM': real,
        'sizeSource': size_source,
        'colour': {
            'meanLinearRgb': r4(lin.mean(0)), 'spreadLinearRgb': r4(lin.std(0)),
            'meanLab': [round(float(x), 2) for x in lab.mean(0)], 'spreadLab': [round(float(x), 2) for x in lab.std(0)],
            'meanLuminance': round(float(lin.mean(0) @ np.array([0.2126, 0.7152, 0.0722])), 4),
        },
        'roughnessMean': round(float(orm[..., 1].mean()), 4),
        'occlusionMean': round(float(orm[..., 0].mean()), 4),
        'normalTiltRmsDeg': round(float(np.sqrt((tilt ** 2).mean())), 2),
        'appearance': entry.get('appearance'),
        'copiedAt': datetime.date.today().isoformat(),
    }


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    cache_dir = sys.argv[1]
    library = {s['id']: s for s in json.load(open(LIBRARY_INDEX))['sets']}
    estimated = json.load(open(ESTIMATED_SIZES))['sets']
    index = json.load(open(OUT_INDEX)) if os.path.exists(OUT_INDEX) else {
        'schema': 'scratchbox.texture-library-copies/1',
        'about': ('Working-resolution copies of texture library sets (assets/textures/library/index.json) for producers that '
                  'run offline from the repository; made by scripts/copy_texture_library_sets.py. Never tinted: a producer '
                  'tints a copy to the colour it measures. appearance is the publisher\'s text, for reading; nothing branches on it.'),
        'conventions': {
            'maps': "albedo: sRGB colour; normal: OpenGL tangent space (+Y up); orm: R occlusion, G roughness, B metalness (glTF's packing)",
            'realSizeM': "the tile's real width and height in metres: the publisher's, else the vision-model estimate in estimated-sizes.json (sizeSource says which)",
            'colour': 'mean and standard deviation of linear sRGB (Rec. 709, D65) and CIELAB (D65) over the albedo map as written; meanLuminance: Rec. 709 Y',
        },
        'sets': [],
    }
    for arg in sys.argv[2:]:
        set_id, _, px = arg.partition(':')
        if set_id not in library:
            raise SystemExit(f'{set_id} is not in {LIBRARY_INDEX}')
        e = copy_set(cache_dir, set_id, int(px or 2048), library[set_id], estimated)
        index['sets'] = [s for s in index['sets'] if s['id'] != set_id] + [e]
        print(json.dumps({k: e[k] for k in ('id', 'pixels', 'realSizeM', 'sizeSource', 'colour', 'roughnessMean', 'normalTiltRmsDeg')}))
    index['sets'].sort(key=lambda s: s['id'].lower())
    with open(OUT_INDEX, 'w') as f:
        json.dump(index, f, indent=1)
        f.write('\n')


if __name__ == '__main__':
    main()
