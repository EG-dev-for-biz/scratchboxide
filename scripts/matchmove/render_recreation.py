#!/usr/bin/env python3
"""
Renders the plate's camera path through the tile district and composes comparison videos.

Each frame is rendered as a pinhole image with a small field-of-view margin, then warped with the plate's
radial distortion (k1) so it overlays the original frame. Exposure follows the renderer's auto exposure,
sampled on a low-resolution pre-pass and smoothed over time so it adapts without flicker. Outputs
recreated.mp4, side_by_side.mp4 and wipe.mp4 (split line sweeping across) in --out.
"""
import argparse
import json
import subprocess
from pathlib import Path

import cv2
import numpy as np
from scipy.ndimage import gaussian_filter1d

import register_lib as rl
import tile_render as tr


def distortion_maps(K, dist, W, H, K_render):
    """Maps sampling a pinhole render (intrinsics K_render) so the result has the plate's distortion."""
    u, v = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))
    pts = np.stack([u.ravel(), v.ravel()], 1).reshape(-1, 1, 2)
    undist = cv2.undistortPoints(pts, K, dist).reshape(-1, 2)
    mx = (undist[:, 0] * K_render[0, 0] + K_render[0, 2]).reshape(H, W).astype(np.float32)
    my = (undist[:, 1] * K_render[1, 1] + K_render[1, 2]).reshape(H, W).astype(np.float32)
    return mx, my


def label(img, text, x):
    (tw, th), base = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 1)
    cv2.rectangle(img, (x + 10, 10), (x + 22 + tw, 22 + th + base), (0, 0, 0), -1)
    cv2.putText(img, text, (x + 16, 16 + th), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)


def ffmpeg_encode(pattern, out_file, fps=24):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-framerate', str(fps), '-i', pattern, '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                    '-crf', '16', '-movflags', '+faststart', str(out_file)], check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--path', required=True)
    ap.add_argument('--frames', required=True)
    ap.add_argument('--glb', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--size', type=int, nargs=2, default=[1280, 720])
    ap.add_argument('--spp', type=int, default=6)
    ap.add_argument('--margin', type=float, default=1.08, help='render field-of-view margin before distortion')
    ap.add_argument('--exposure-every', type=int, default=8, help='frames between auto-exposure samples')
    ap.add_argument('--exposure-sigma', type=float, default=6.0, help='frames; temporal smoothing of exposure')
    ap.add_argument('--labels', nargs=2, default=['Reference clip', 'Plaza tile commit, solved camera'])
    args = ap.parse_args()
    out = Path(args.out)
    for d in ('render', 'side', 'wipe'):
        (out / d).mkdir(parents=True, exist_ok=True)

    path = json.loads(Path(args.path).read_text())
    lens = path['plate']['lens']
    cam = {'params': [lens['focalPx'], lens['cx'], lens['cy'], lens['k1']], 'width': path['plate']['width'], 'height': path['plate']['height']}
    W, H = args.size
    K, dist = rl.intrinsics_matrix(cam, W, H)
    Wr, Hr = int(round(W * args.margin / 2) * 2), int(round(H * args.margin / 2) * 2)
    vfov_r = np.degrees(2 * np.arctan((Hr / 2) / K[1, 1]))
    K_render = np.array([[K[0, 0], 0, (Wr - 1) / 2], [0, K[1, 1], (Hr - 1) / 2], [0, 0, 1]])
    mx, my = distortion_maps(K, dist, W, H, K_render)

    frames = path['frames']
    n = len(frames)
    numbers = [f['frame'] for f in frames]
    sampled = list(range(0, n, args.exposure_every)) + ([n - 1] if (n - 1) % args.exposure_every else [])
    sample_ev = []
    for i in sampled:
        C, Rt = np.array(frames[i]['center']), np.array(frames[i]['R'])
        r = tr.render(args.glb, C, C + Rt[2] * 20.0, -Rt[1], vfov_r, 480, int(round(480 * Hr / Wr)), spp=1)
        sample_ev.append(r['stats']['exposureEv'])
    exposure = gaussian_filter1d(np.interp(numbers, [numbers[i] for i in sampled], sample_ev), args.exposure_sigma, mode='nearest')
    (out / 'exposure.json').write_text(json.dumps({'frames': numbers, 'ev': exposure.tolist()}))

    for i, f in enumerate(frames):
        C, Rt = np.array(f['center']), np.array(f['R'])
        r = tr.render(args.glb, C, C + Rt[2] * 20.0, -Rt[1], vfov_r, Wr, Hr, spp=args.spp, seed=f['frame'], exposure=exposure[i])
        rendered = cv2.remap(r['color'][:, :, ::-1], mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        plate = cv2.resize(cv2.imread(str(Path(args.frames) / f"{f['frame']:04d}.jpg")), (W, H), interpolation=cv2.INTER_AREA)
        cv2.imwrite(str(out / 'render' / f'{i:04d}.png'), rendered)
        side = np.hstack([plate, rendered])
        label(side, args.labels[0], 0)
        label(side, args.labels[1], W)
        cv2.imwrite(str(out / 'side' / f'{i:04d}.jpg'), side, [cv2.IMWRITE_JPEG_QUALITY, 92])
        split = int(W * (0.1 + 0.8 * i / max(1, n - 1)))
        wipe = rendered.copy()
        wipe[:, :split] = plate[:, :split]
        cv2.line(wipe, (split, 0), (split, H - 1), (255, 255, 255), 2)
        cv2.imwrite(str(out / 'wipe' / f'{i:04d}.jpg'), wipe, [cv2.IMWRITE_JPEG_QUALITY, 92])
        if i % 20 == 0:
            print(f'rendered {i + 1}/{n}', flush=True)

    ffmpeg_encode(str(out / 'render' / '%04d.png'), out / 'recreated.mp4')
    ffmpeg_encode(str(out / 'side' / '%04d.jpg'), out / 'side_by_side.mp4')
    ffmpeg_encode(str(out / 'wipe' / '%04d.jpg'), out / 'wipe.mp4')
    print('videos written to', out)


if __name__ == '__main__':
    main()
