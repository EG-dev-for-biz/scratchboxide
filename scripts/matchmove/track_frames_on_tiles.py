#!/usr/bin/env python3
"""
Absolute camera tracking against the tiles, frame by frame.

Each frame is registered by rendering the tiles from the previous frame's pose, matching the frame to the
render (LoFTR), lifting render pixels to 3D with metric depth and solving PnP. A frame is reliable when it
has enough inliers, a small reprojection RMS and no implausible jump from its neighbour. Where tile matching
stops being reliable (close range, where tile textures are far coarser than the plate), the SfM relative
motion is carried forward with a local similarity fitted on the last reliable stretch.

Writes <out>/camera_track_tiles.json with per-frame pose, source ('tile-pnp' | 'sfm-carried'), inliers and RMS.
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np

import register_lib as rl
import tile_render as tr


def umeyama(src, dst):
    mu_s, mu_d = src.mean(0), dst.mean(0)
    xs, xd = src - mu_s, dst - mu_d
    cov = xd.T @ xs / len(src)
    U, S, Vt = np.linalg.svd(cov)
    D = np.eye(3)
    if np.linalg.det(U @ Vt) < 0:
        D[2, 2] = -1
    R = U @ D @ Vt
    s = np.trace(np.diag(S) @ D) / xs.var(0).sum()
    return s, R, mu_d - s * R @ mu_s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--frames', required=True)
    ap.add_argument('--colmap-track', required=True)
    ap.add_argument('--seed', required=True, help='json with R and center of the first frame in tile coordinates')
    ap.add_argument('--glb', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--first', type=int, default=1)
    ap.add_argument('--last', type=int, default=240)
    ap.add_argument('--min-inliers', type=int, default=40)
    ap.add_argument('--max-rms', type=float, default=3.5)
    ap.add_argument('--max-jump-m', type=float, default=3.0)
    ap.add_argument('--fit-window', type=int, default=30, help='reliable frames used to carry SfM motion forward')
    ap.add_argument('--work', type=int, nargs=2, default=[960, 540])
    ap.add_argument('--step', type=int, default=1, help='register every n-th frame; the path is interpolated in between')
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    sfm = json.loads(Path(args.colmap_track).read_text())
    cam = sfm['camera']
    sfm_pose = {f['frame']: (np.array(f['R']), np.array(f['t']), np.array(f['center'])) for f in sfm['frames'] if f['registered']}
    W, H = args.work
    K, dist = rl.intrinsics_matrix(cam, W, H)
    vfov = np.degrees(2 * np.arctan((H / 2) / K[1, 1]))
    seed = json.loads(Path(args.seed).read_text())
    Rt, C = np.array(seed['R']), np.array(seed['center'])

    track = {}
    misses = 0

    def local_scale(last):
        """Median tile/SfM displacement ratio between the last reliable frame and earlier ones far enough away."""
        ratios = []
        for k in sorted(track):
            ds = np.linalg.norm(sfm_pose[last][2] - sfm_pose[k][2])
            if ds > 0.3:
                ratios.append(np.linalg.norm(track[last]['center'] - track[k]['center']) / ds)
        return float(np.median(ratios[-8:])) if ratios else 5.0

    def predict(fr):
        """Last reliable pose moved by the SfM relative motion since that frame (rotation offset from that frame)."""
        if not track:
            return Rt, C
        a = max(track)
        Ra, Ca = track[a]['R'], track[a]['center']
        Rs_a, _, Cs_a = sfm_pose[a]
        Rs_f, _, Cs_f = sfm_pose[fr]
        Rw = Ra.T @ Rs_a
        return Rs_f @ Rw.T, Ca + local_scale(a) * Rw @ (Cs_f - Cs_a)

    for fr in range(args.first, args.last + 1, args.step):
        if fr not in sfm_pose:
            continue
        frame = cv2.cvtColor(cv2.resize(cv2.imread(str(Path(args.frames) / f'{fr:04d}.jpg')), (W, H)), cv2.COLOR_BGR2RGB)
        best = None
        R_try, C_try = predict(fr) if track else (Rt, C)
        R_pred, C_pred = R_try, C_try
        for it in range(1 if (track and misses == 0) else 2):
            r = tr.render(args.glb, C_try, C_try + R_try[2] * 20.0, -R_try[1], vfov, W, H, spp=4)
            pf, pr, conf = rl.match(frame, r['color'], min_conf=0.3)
            X = tr.lift(r, pr)
            ok = np.isfinite(X).all(1)
            pf, X = pf[ok], X[ok]
            if len(X) < 12:
                break
            succ, rv, tv, inl = cv2.solvePnPRansac(X, pf, K, dist, rvec=cv2.Rodrigues(R_try)[0], tvec=(-R_try @ C_try).reshape(3, 1),
                                                    useExtrinsicGuess=True, iterationsCount=3000, reprojectionError=4.0, confidence=0.999)
            if not succ or inl is None or len(inl) < 12:
                break
            idx = inl.ravel()
            rv, tv = cv2.solvePnPRefineLM(X[idx], pf[idx], K, dist, rv, tv)
            R_new = cv2.Rodrigues(rv)[0]
            C_new = (-R_new.T @ tv).ravel()
            proj, _ = cv2.projectPoints(X[idx], rv, tv, K, dist)
            rms = float(np.sqrt(np.mean(np.sum((proj.reshape(-1, 2) - pf[idx]) ** 2, 1))))
            best = (R_new, C_new, len(idx), rms)
            R_try, C_try = R_new, C_new
        reliable = False
        if best:
            R_new, C_new, n_in, rms = best
            jump = min(np.linalg.norm(C_new - C_pred), np.linalg.norm(C_new - C))
            reliable = n_in >= args.min_inliers and rms <= args.max_rms and (not track or jump <= args.max_jump_m * args.step)
        if reliable:
            Rt, C = R_new, C_new
            track[fr] = {'R': Rt, 'center': C, 'source': 'tile-pnp', 'inliers': n_in, 'rmsPx': rms}
            misses = 0
            print(f'frame {fr:3d}: tile-pnp inliers {n_in:4d} rms {rms:4.2f}px centre {np.round(C, 2)}', flush=True)
        else:
            misses += 1
            print(f'frame {fr:3d}: unreliable ({"no solution" if not best else f"{best[2]} inliers, rms {best[3]:.2f}px"})', flush=True)

    reliable_frames = sorted(track)
    last_reliable = reliable_frames[-1]
    window = [f for f in reliable_frames if f > last_reliable - args.fit_window]
    src = np.array([sfm_pose[f][2] for f in window])
    dst = np.array([track[f]['center'] for f in window])
    s, Rsim, Tsim = umeyama(src, dst)
    # rotation offset between SfM and tile camera frames over the window
    rot_offsets = [track[f]['R'].T @ sfm_pose[f][0] for f in window]
    fit_err = float(np.sqrt(np.mean(np.sum((s * src @ Rsim.T + Tsim - dst) ** 2, 1))))

    frames_out = []
    for fr in range(args.first, args.last + 1):
        if fr in track and fr <= last_reliable:
            e = track[fr]
            R_f, C_f = e['R'], e['center']
            meta = {'source': e['source'], 'inliers': e['inliers'], 'rmsPx': e['rmsPx']}
        elif fr in sfm_pose:
            Rc, tc, Cc = sfm_pose[fr]
            C_f = s * Rsim @ Cc + Tsim
            R_f = Rc @ Rsim.T
            meta = {'source': 'sfm-carried'}
        else:
            continue
        frames_out.append({'frame': fr, 'R': R_f.tolist(), 't': (-R_f @ C_f).tolist(), 'center': C_f.tolist(),
                           'target': (C_f + R_f[2] * 20.0).tolist(), 'up': (-R_f[1]).tolist(), **meta})
    report = {'lastTilePnpFrame': last_reliable, 'tilePnpFrames': len(reliable_frames),
              'carryWindow': [window[0], window[-1]], 'carrySimilarity': {'scale': float(s), 'fitRmsM': fit_err},
              'thresholds': {'minInliers': args.min_inliers, 'maxRmsPx': args.max_rms, 'maxJumpM': args.max_jump_m}}
    (out / 'camera_track_tiles.json').write_text(json.dumps({'frame': 'tile local (x east, y up, z south), metres', 'camera': cam,
                                                             'report': report, 'frames': frames_out}, indent=1))
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
