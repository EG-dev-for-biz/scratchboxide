"""
Renders the tile district with the native path tracer (texture as captured) and lifts pixels to 3D
with its metric depth. Camera convention matches the renderer: forward = target - position,
right = forward x up, image y points down.
"""
import json
import os
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[2]
BINARY = REPO / 'build' / '3d-native' / 'render_tile_pathtraced'


def camera_basis(position, target, up):
    position = np.asarray(position, float)
    forward = np.asarray(target, float) - position
    forward /= np.linalg.norm(forward)
    right = np.cross(forward, np.asarray(up, float))
    right /= np.linalg.norm(right)
    upv = np.cross(right, forward)
    # OpenCV world -> camera rotation: rows are camera x (right), y (down), z (forward)
    return np.stack([right, -upv, forward])


def render(glb, position, target, up, vfov_deg, width, height, spp=4, out_dir=None, seed=1, exposure='auto', clay=False, sun=None):
    """
    exposure: 'auto' (per-image) or a fixed EV number.
    clay: render untextured studio clay lit by the physical sun and sky (geometry-only blockout) instead of the
    captured texture. sun: renderer sun config, e.g. {'latitude', 'longitude', 'unixSeconds'} or
    {'elevationDeg', 'azimuthDeg'}.
    """
    out_dir = Path(out_dir or tempfile.mkdtemp(prefix='tile_render_'))
    out_dir.mkdir(parents=True, exist_ok=True)
    config = {
        'glbPath': str(glb), 'outputDir': str(out_dir),
        'sun': sun or {'elevationDeg': 55.0, 'azimuthDeg': 200.0},
        'width': int(width), 'height': int(height), 'samplesPerPixel': int(spp), 'maxBounces': 1,
        'shadingMode': 'baked', 'denoise': False, 'groundPlane': False,
        'exposure': exposure if exposure == 'auto' else float(exposure), 'seed': seed,
        'camera': {'position': list(map(float, position)), 'target': list(map(float, target)), 'up': list(map(float, up)),
                   'verticalFovDeg': float(vfov_deg)}
    }
    if clay:
        config.update({'shadingMode': 'relit', 'maxBounces': 2, 'denoise': True,
                       'clayAlbedo': [0.716, 0.672, 0.610], 'clayRoughness': 0.82, 'clayMetallic': 0.02})
    cfg = out_dir / 'render_config.json'
    cfg.write_text(json.dumps(config))
    subprocess.run([str(BINARY), str(cfg)], check=True, capture_output=True)
    color = np.asarray(Image.open(out_dir / 'beauty.png').convert('RGB'))
    depth = np.fromfile(out_dir / 'depth.f32', dtype='<f4').reshape(height, width)
    f = (height / 2.0) / np.tan(np.radians(vfov_deg) / 2.0)
    return {
        'color': color, 'depth': depth, 'dir': str(out_dir), 'stats': json.loads((out_dir / 'stats.json').read_text()),
        'position': np.asarray(position, float), 'R': camera_basis(position, target, up),
        'f': f, 'cx': (width - 1) / 2.0, 'cy': (height - 1) / 2.0, 'width': width, 'height': height
    }


def lift(r, uv):
    """World points for render pixels uv (N x 2, OpenCV pixel-centre coordinates); NaN where there is no geometry."""
    uv = np.asarray(uv, float)
    ui = np.clip(np.round(uv[:, 0]).astype(int), 0, r['width'] - 1)
    vi = np.clip(np.round(uv[:, 1]).astype(int), 0, r['height'] - 1)
    d = r['depth'][vi, ui].astype(float)
    rays = np.stack([(uv[:, 0] - r['cx']) / r['f'], (uv[:, 1] - r['cy']) / r['f'], np.ones(len(uv))], 1)
    rays /= np.linalg.norm(rays, axis=1, keepdims=True)
    world = r['position'] + (rays @ r['R']) * d[:, None]
    world[d <= 0] = np.nan
    return world
