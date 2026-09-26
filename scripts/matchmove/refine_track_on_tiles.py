#!/usr/bin/env python3
"""
Refines a geometrically aligned camera track against the tiles using image evidence.

For keyframes, the tiles are rendered from the current pose and matched to the video frame (LoFTR);
matched render pixels are lifted to 3D with the render's depth. The track keeps its SfM shape and only
its similarity (scale, rotation, translation) is re-estimated by robust reprojection least squares over
the training keyframes. Every `--holdout-every`-th keyframe is kept out of the fit and scored.

Writes <out>/camera_track_refined.json and <out>/refine_report.json.
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation

import register_lib as rl
import tile_render as tr


def project(points, R, t, K, dist):
    uv, _ = cv2.projectPoints(points, cv2.Rodrigues(R)[0], t, K, dist)
    return uv.reshape(-1, 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--frames', required=True)
    ap.add_argument('--colmap-track', required=True)
    ap.add_argument('--aligned', required=True, help='alignment.json from align_track_to_tiles.py')
    ap.add_argument('--glb', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--keyframes', type=int, nargs='+', default=list(range(1, 241, 10)) + [240])
    ap.add_argument('--holdout-every', type=int, default=3)
    ap.add_argument('--work', type=int, nargs=2, default=[960, 540])
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    sfm = json.loads(Path(args.colmap_track).read_text())
    cam = sfm['camera']
    sim = json.loads(Path(args.aligned).read_text())['similarity']
    s, R, T = sim['scale'], np.array(sim['R']), np.array(sim['T'])
    sfm_pose = {f['frame']: (np.array(f['R']), np.array(f['t'])) for f in sfm['frames'] if f['registered']}
    W, H = args.work
    K, dist = rl.intrinsics_matrix(cam, W, H)
    vfov = np.degrees(2 * np.arctan((H / 2) / K[1, 1]))

    def tile_pose(frame, s, R, T):
        Rc, tc = sfm_pose[frame]
        C = s * R @ (-Rc.T @ tc) + T
        Rt = Rc @ R.T
        return Rt, -Rt @ C, C

    # 1. Correspondences at each keyframe from renders at the current pose
    corr = {}
    for kf in args.keyframes:
        if kf not in sfm_pose:
            continue
        Rt, tt, C = tile_pose(kf, s, R, T)
        frame = cv2.cvtColor(cv2.resize(cv2.imread(str(Path(args.frames) / f'{kf:04d}.jpg')), (W, H)), cv2.COLOR_BGR2RGB)
        r = tr.render(args.glb, C, C + Rt[2] * 20.0, -Rt[1], vfov, W, H, spp=4)
        pf, pr, conf = rl.match(frame, r['color'], work_w=640, work_h=360, min_conf=0.3)
        X = tr.lift(r, pr)
        ok = np.isfinite(X).all(1)
        pf, X = pf[ok], X[ok]
        n_in = 0
        if len(X) >= 12:
            succ, rv, tv, inl = cv2.solvePnPRansac(X, pf, K, dist, rvec=cv2.Rodrigues(Rt)[0], tvec=tt.reshape(3, 1), useExtrinsicGuess=True,
                                                    iterationsCount=4000, reprojectionError=6.0, confidence=0.999)
            if succ and inl is not None:
                n_in = len(inl)
                pf, X = pf[inl.ravel()], X[inl.ravel()]
        corr[kf] = {'p2d': pf if n_in else np.zeros((0, 2)), 'p3d': X if n_in else np.zeros((0, 3)), 'inliers': n_in, 'lifted': int(ok.sum())}
        print(f'keyframe {kf:3d}: lifted {int(ok.sum()):4d}, PnP inliers {n_in:4d}')

    keys = sorted(k for k in corr if corr[k]['inliers'] >= 15)
    hold = keys[1::args.holdout_every]
    train = [k for k in keys if k not in hold]

    def residuals(params, frames):
        R_ = Rotation.from_rotvec(params[:3]).as_matrix() @ R
        T_ = T + params[3:6]
        s_ = s * np.exp(params[6])
        res = []
        for k in frames:
            Rt, tt, _ = tile_pose(k, s_, R_, T_)
            res.append((project(corr[k]['p3d'], Rt, tt, K, dist) - corr[k]['p2d']).ravel())
        return np.concatenate(res) if res else np.zeros(0)

    def rms_per_frame(params, frames):
        out_ = {}
        for k in frames:
            r = residuals(params, [k]).reshape(-1, 2)
            out_[k] = float(np.sqrt(np.mean(np.sum(r ** 2, 1)))) if len(r) else None
        return out_

    x0 = np.zeros(7)
    before = rms_per_frame(x0, keys)
    fit = least_squares(residuals, x0, args=(train,), loss='huber', f_scale=3.0, max_nfev=200)
    after = rms_per_frame(fit.x, keys)
    R_f = Rotation.from_rotvec(fit.x[:3]).as_matrix() @ R
    T_f = T + fit.x[3:6]
    s_f = s * np.exp(fit.x[6])

    def summarize(d, frames):
        v = [d[k] for k in frames if d[k] is not None]
        return {'meanRmsPx': float(np.mean(v)) if v else None, 'maxRmsPx': float(np.max(v)) if v else None, 'frames': len(v)}

    report = {
        'workResolution': [W, H],
        'keyframes': {int(k): {'inliers': corr[k]['inliers'], 'lifted': corr[k]['lifted'], 'rmsBeforePx': before.get(k), 'rmsAfterPx': after.get(k),
                               'set': 'holdout' if k in hold else ('train' if k in train else 'unused')} for k in corr},
        'train': {'before': summarize(before, train), 'after': summarize(after, train)},
        'holdout': {'before': summarize(before, hold), 'after': summarize(after, hold)},
        'similarity': {'scale': float(s_f), 'R': R_f.tolist(), 'T': T_f.tolist(), 'maps': 'x_tile = scale * R x_sfm + T'},
        'deltaFromGeometricAlignment': {'rotationDeg': float(np.degrees(np.linalg.norm(fit.x[:3]))), 'translationM': float(np.linalg.norm(fit.x[3:6])),
                                        'scaleRatio': float(np.exp(fit.x[6]))},
    }
    (out / 'refine_report.json').write_text(json.dumps(report, indent=1))

    frames_out = []
    for f in sfm['frames']:
        if not f['registered']:
            continue
        Rt, tt, C = tile_pose(f['frame'], s_f, R_f, T_f)
        frames_out.append({'frame': f['frame'], 'R': Rt.tolist(), 't': tt.tolist(), 'center': C.tolist(),
                           'target': (C + Rt[2] * 20.0).tolist(), 'up': (-Rt[1]).tolist()})
    (out / 'camera_track_refined.json').write_text(json.dumps({'frame': 'tile local (x east, y up, z south), metres', 'camera': cam, 'frames': frames_out}, indent=1))
    print(json.dumps({k: report[k] for k in ('train', 'holdout', 'deltaFromGeometricAlignment')}, indent=1))


if __name__ == '__main__':
    main()
