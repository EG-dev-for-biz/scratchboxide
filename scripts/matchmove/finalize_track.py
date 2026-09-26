#!/usr/bin/env python3
"""
Builds the final camera path: the SfM track (smooth, internally consistent) bent onto the tile-registered
poses (absolute, but noisy frame to frame). A global similarity places the SfM track; the remaining
position and rotation offsets to the tile-PnP frames are smoothed over time and applied to every frame.
Frames past the last tile-PnP frame keep the offset of the end of that stretch.

Also exports the path in geodetic coordinates using the base commit's local-to-ECEF transform.
"""
import argparse
import json
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.spatial.transform import Rotation

from track_frames_on_tiles import umeyama

WGS84_A = 6378137.0
WGS84_F = 1 / 298.257223563
WGS84_E2 = WGS84_F * (2 - WGS84_F)


def ecef_to_geodetic(x, y, z):
    lon = np.arctan2(y, x)
    p = np.hypot(x, y)
    lat = np.arctan2(z, p * (1 - WGS84_E2))
    for _ in range(6):
        n = WGS84_A / np.sqrt(1 - WGS84_E2 * np.sin(lat) ** 2)
        h = p / np.cos(lat) - n
        lat = np.arctan2(z, p * (1 - WGS84_E2 * n / (n + h)))
    n = WGS84_A / np.sqrt(1 - WGS84_E2 * np.sin(lat) ** 2)
    return np.degrees(lat), np.degrees(lon), p / np.cos(lat) - n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--colmap-track', required=True)
    ap.add_argument('--tile-track', required=True)
    ap.add_argument('--commit', required=True, help='commit.json of the tile base commit')
    ap.add_argument('--out', required=True)
    ap.add_argument('--sigma-frames', type=float, default=6.0)
    ap.add_argument('--cut-frames', type=int, nargs='*', default=[241], help='frames after a hard cut in the plate (excluded)')
    args = ap.parse_args()

    sfm = json.loads(Path(args.colmap_track).read_text())
    tiles = json.loads(Path(args.tile_track).read_text())
    commit = json.loads(Path(args.commit).read_text())
    cam = sfm['camera']
    sfm_pose = {f['frame']: (np.array(f['R']), np.array(f['center'])) for f in sfm['frames'] if f['registered'] and f['frame'] not in args.cut_frames}
    pnp = {f['frame']: (np.array(f['R']), np.array(f['center'])) for f in tiles['frames'] if f['source'] == 'tile-pnp'}
    frames = sorted(sfm_pose)
    pf = sorted(pnp)

    src = np.array([sfm_pose[f][1] for f in pf])
    dst = np.array([pnp[f][1] for f in pf])
    s, R, T = umeyama(src, dst)

    def placed(f):
        Rc, Cc = sfm_pose[f]
        return Rc @ R.T, s * R @ Cc + T

    # Offsets at tile-PnP frames: position delta and camera-to-world rotation correction
    dpos = np.array([pnp[f][1] - placed(f)[1] for f in pf])
    drot = np.array([Rotation.from_matrix(pnp[f][0].T @ placed(f)[0]).as_rotvec() for f in pf])
    full = np.arange(frames[0], frames[-1] + 1)
    last = pf[-1]

    def smooth_series(values):
        series = np.zeros((len(full), values.shape[1]))
        for k in range(values.shape[1]):
            v = np.interp(np.minimum(full, last), pf, values[:, k])
            series[:, k] = gaussian_filter1d(v, args.sigma_frames, mode='nearest')
        return series

    pos_corr = smooth_series(dpos)
    rot_corr = smooth_series(drot)

    out_frames = []
    local_to_ecef = np.array(commit['frame']['localToEcef']).reshape(4, 4).T
    for i, f in enumerate(full):
        if f not in sfm_pose:
            continue
        Rw, C = placed(f)
        C = C + pos_corr[i]
        # D = M_pnp M_placed^T for camera-to-world M = R^T, so R_final = R_placed D^T (equals R_pnp when unsmoothed)
        Rf = Rw @ Rotation.from_rotvec(rot_corr[i]).as_matrix().T
        ecef = local_to_ecef @ np.append(C, 1.0)
        lat, lon, h = ecef_to_geodetic(*ecef[:3])
        out_frames.append({
            'frame': int(f), 'timeSec': (f - 1) / 24.0,
            'R': Rf.tolist(), 't': (-Rf @ C).tolist(), 'center': C.tolist(),
            'target': (C + Rf[2] * 20.0).tolist(), 'up': (-Rf[1]).tolist(),
            'geodetic': {'lat': float(lat), 'lng': float(lon), 'ellipsoidalHeightM': float(h)},
            'source': 'tile-pnp' if f in pnp else ('sfm-bent' if f <= last else 'sfm-carried')
        })

    fcx = cam['params']
    vfov = float(np.degrees(2 * np.arctan((cam['height'] / 2) / fcx[0])))
    result = {
        'schema': 'scratchbox.camera-path/1',
        'frame': 'tile local (x east, y up, z south), metres; OpenCV pose x_cam = R x_world + t',
        'baseCommit': commit['id'], 'baseCommitSha256': commit['glb']['sha256'],
        'plate': {'width': cam['width'], 'height': cam['height'], 'fps': 24, 'lens': {'model': cam['model'], 'focalPx': fcx[0], 'cx': fcx[1], 'cy': fcx[2], 'k1': fcx[3]},
                  'verticalFovDeg': vfov, 'excludedFrames': args.cut_frames},
        'fit': {'similarityScale': float(s), 'tilePnpFrames': len(pf), 'lastTilePnpFrame': int(last),
                'offsetStats': {'positionMeanM': float(np.linalg.norm(dpos, axis=1).mean()), 'positionMaxM': float(np.linalg.norm(dpos, axis=1).max()),
                                'rotationMeanDeg': float(np.degrees(np.linalg.norm(drot, axis=1)).mean())},
                'sigmaFrames': args.sigma_frames},
        'frames': out_frames
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(result, indent=1))
    print(json.dumps({k: result[k] for k in ('plate', 'fit')}, indent=1))


if __name__ == '__main__':
    main()
