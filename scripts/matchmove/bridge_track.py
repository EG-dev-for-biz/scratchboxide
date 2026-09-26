#!/usr/bin/env python3
"""
Final camera path from anchored stretches of the shot.

Repetitive facades (window grids) let PnP lock onto the wrong floor, so absolute anchors come only from
stretches with non-repeating structure: tile-PnP frames in `--pnp-range` (e.g. the roofline) and frames of the
geometrically aligned track in `--aligned-range` (e.g. overhead street and canopy). The SfM track is bent
through those anchors (exactly at anchors, monotone-cubic in between). Frames between them are then
re-solved against the tiles starting from the bridged pose; a solution becomes an anchor only when it stays
within the pass's distance of the bridge (so floor-shifted solutions are rejected). Remaining gaps are
tracked frame by frame from the anchors on both sides with a small per-step limit, and a tracked frame is kept
when the forward and backward walks agree, or when it is close to the anchor its walk started from.
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from scipy.interpolate import PchipInterpolator
from scipy.ndimage import gaussian_filter1d
from scipy.spatial.transform import Rotation

import register_lib as rl
import tile_render as tr
from finalize_track import ecef_to_geodetic
from track_frames_on_tiles import umeyama


def bend_track(sfm_pose, frames, anchors, jitter_sigma=1.0):
    """
    Places the SfM track (frame -> (R world->cam, centre)) in the anchors' frame with one similarity, then
    bends it through the anchors: exact at anchor frames when jitter_sigma is 0, monotone-cubic in between,
    and held constant before the first / after the last anchor.
    """
    keys = sorted(anchors)
    s, Rw, Tw = umeyama(np.array([sfm_pose[k][1] for k in keys]), np.array([anchors[k][1] for k in keys]))

    def placed(f):
        Rc, Cc = sfm_pose[f]
        return Rc @ Rw.T, s * Rw @ Cc + Tw

    dpos = np.array([anchors[k][1] - placed(k)[1] for k in keys])
    drot = np.array([Rotation.from_matrix(anchors[k][0].T @ placed(k)[0]).as_rotvec() for k in keys])
    at = np.clip(frames, keys[0], keys[-1]).astype(float)
    pos_c = PchipInterpolator(keys, dpos, axis=0)(at)
    rot_c = PchipInterpolator(keys, drot, axis=0)(at)
    if jitter_sigma > 0:
        pos_c = gaussian_filter1d(pos_c, jitter_sigma, axis=0, mode='nearest')
        rot_c = gaussian_filter1d(rot_c, jitter_sigma, axis=0, mode='nearest')
    poses = {}
    for i, f in enumerate(frames):
        Rp, Cp = placed(f)
        poses[int(f)] = (Rp @ Rotation.from_rotvec(rot_c[i]).as_matrix().T, Cp + pos_c[i])
    return poses, float(s)


def merge_walks(seg, fwd, bwd, a, b, agree_m, trust_frames):
    """
    Decides which gap frames tracked from anchor `a` (forward) and anchor `b` (backward) become anchors.
    fwd/bwd map frame -> (R, C, (inliers, rms)). Returns (kept [(frame, pose, how)], disagreements).
    """
    kept, disagree = [], []
    for f in seg:
        pf_, pb_ = fwd.get(f), bwd.get(f)
        if pf_ and pb_:
            d = float(np.linalg.norm(pf_[1] - pb_[1]))
            if d <= agree_m:
                kept.append((f, pf_ if pf_[2][0] >= pb_[2][0] else pb_, 'both'))
            else:
                disagree.append({'frame': f, 'distanceM': d})
        elif pf_ and f - a <= trust_frames:
            kept.append((f, pf_, 'forward'))
        elif pb_ and b - f <= trust_frames:
            kept.append((f, pb_, 'backward'))
    return kept, disagree


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--colmap-track', required=True)
    ap.add_argument('--tile-track', required=True)
    ap.add_argument('--aligned-track', required=True)
    ap.add_argument('--commit', required=True)
    ap.add_argument('--frames', required=True)
    ap.add_argument('--glb', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--pnp-range', type=int, nargs=2, default=[1, 49])
    ap.add_argument('--aligned-range', type=int, nargs=2, default=[150, 240])
    ap.add_argument('--refine-range', type=int, nargs=2, default=[50, 149])
    ap.add_argument('--refine-step', type=int, default=4)
    ap.add_argument('--accept-m', type=float, default=3.0)
    ap.add_argument('--wide-accept-m', type=float, default=6.0, help='first pass: strongly matched frames may move this far')
    ap.add_argument('--wide-min-inliers', type=int, default=100)
    ap.add_argument('--jitter-sigma', type=float, default=1.0, help='frames; smoothing of the interpolated correction')
    ap.add_argument('--cut-frames', type=int, nargs='*', default=[241])
    ap.add_argument('--reuse-anchors', help='camera path json from a previous run; its raw anchors replace the solve passes')
    ap.add_argument('--track-gaps', action='store_true')
    ap.add_argument('--gap-min-frames', type=int, default=8)
    ap.add_argument('--seq-step', type=int, default=2)
    ap.add_argument('--seq-max-step-m', type=float, default=1.5)
    ap.add_argument('--seq-agree-m', type=float, default=1.0)
    ap.add_argument('--seq-trust-frames', type=int, default=8)
    ap.add_argument('--seq-max-misses', type=int, default=3)
    ap.add_argument('--seq-min-inliers', type=int, default=40)
    args = ap.parse_args()

    sfm = json.loads(Path(args.colmap_track).read_text())
    cam = sfm['camera']
    commit = json.loads(Path(args.commit).read_text())
    sfm_pose = {f['frame']: (np.array(f['R']), np.array(f['center'])) for f in sfm['frames'] if f['registered'] and f['frame'] not in args.cut_frames}
    frames = np.array(sorted(sfm_pose))
    anchors, kinds = {}, {}
    if args.reuse_anchors:
        for a in json.loads(Path(args.reuse_anchors).read_text())['rawAnchors']:
            anchors[a['frame']] = (np.array(a['R']), np.array(a['center']))
            kinds[a['frame']] = a['kind']
    else:
        for f in json.loads(Path(args.tile_track).read_text())['frames']:
            if f['source'] == 'tile-pnp' and args.pnp_range[0] <= f['frame'] <= args.pnp_range[1]:
                anchors[f['frame']] = (np.array(f['R']), np.array(f['center']))
                kinds[f['frame']] = 'tile-pnp'
        for f in json.loads(Path(args.aligned_track).read_text())['frames']:
            if args.aligned_range[0] <= f['frame'] <= args.aligned_range[1] and f['frame'] % 2 == 0 and f['frame'] in sfm_pose:
                anchors[f['frame']] = (np.array(f['R']), np.array(f['center']))
                kinds[f['frame']] = 'geometric'

    def bend(anch):
        return bend_track(sfm_pose, frames, anch, args.jitter_sigma)

    poses, scale = bend(anchors)

    W, H = 960, 540
    K, dist = rl.intrinsics_matrix(cam, W, H)
    vfov = np.degrees(2 * np.arctan((H / 2) / K[1, 1]))

    def resolve(f, R0, C0):
        frame = cv2.cvtColor(cv2.resize(cv2.imread(str(Path(args.frames) / f'{f:04d}.jpg')), (W, H)), cv2.COLOR_BGR2RGB)
        Rt, C, result = R0, C0, None
        for _ in range(2):
            r = tr.render(args.glb, C, C + Rt[2] * 20.0, -Rt[1], vfov, W, H, spp=4)
            pf, pr, _ = rl.match(frame, r['color'], min_conf=0.3)
            X = tr.lift(r, pr)
            ok = np.isfinite(X).all(1)
            if ok.sum() < 12:
                break
            succ, rv, tv, inl = cv2.solvePnPRansac(X[ok], pf[ok], K, dist, rvec=cv2.Rodrigues(Rt)[0], tvec=(-Rt @ C).reshape(3, 1),
                                                    useExtrinsicGuess=True, iterationsCount=3000, reprojectionError=4.0, confidence=0.999)
            if not succ or inl is None or len(inl) < 12:
                break
            idx = inl.ravel()
            rv, tv = cv2.solvePnPRefineLM(X[ok][idx], pf[ok][idx], K, dist, rv, tv)
            Rt = cv2.Rodrigues(rv)[0]
            C = (-Rt.T @ tv).ravel()
            proj, _ = cv2.projectPoints(X[ok][idx], rv, tv, K, dist)
            result = (len(idx), float(np.sqrt(np.mean(np.sum((proj.reshape(-1, 2) - pf[ok][idx]) ** 2, 1)))))
        return Rt, C, result

    accepted, rejected = [], []
    passes = [('wide', args.wide_accept_m, args.wide_min_inliers), ('tight', args.accept_m, 40)]
    if not args.reuse_anchors:
        for name, accept_m, min_inliers in passes:
            for f in range(args.refine_range[0], args.refine_range[1] + 1, args.refine_step):
                if f not in poses or kinds.get(f) == 'tile-pnp-bridged':
                    continue
                R0, C0 = poses[f]
                Rt, C, result = resolve(f, R0, C0)
                shift = float(np.linalg.norm(C - C0))
                if result and result[0] >= min_inliers and result[1] <= 3.5 and shift <= accept_m:
                    anchors[f] = (Rt, C)
                    kinds[f] = 'tile-pnp-bridged'
                    accepted.append({'frame': f, 'pass': name, 'inliers': result[0], 'rmsPx': result[1], 'shiftM': shift})
                    print('accept', name, f, result, round(shift, 2), flush=True)
                elif name == 'tight':
                    rejected.append({'frame': f, 'inliers': result[0] if result else 0, 'rmsPx': result[1] if result else None, 'shiftM': shift if result else None})
            poses, scale = bend(anchors)

    def walk(start, order):
        Rs, Cs = anchors[start]
        prev, misses, out = start, 0, {}
        for f in order:
            Rb_p, Cb_p = poses[prev]
            Rb_f, Cb_f = poses[f]
            R0, C0 = Rb_f @ Rb_p.T @ Rs, Cs + (Cb_f - Cb_p)
            Rt, C, res = resolve(f, R0, C0)
            if res and res[0] >= args.seq_min_inliers and res[1] <= 3.5 and np.linalg.norm(C - C0) <= args.seq_max_step_m:
                out[f] = (Rt, C, res)
                Rs, Cs, prev, misses = Rt, C, f, 0
            else:
                misses += 1
                if misses > args.seq_max_misses:
                    break
        return out

    gap_report = []
    if args.track_gaps:
        keys = sorted(anchors)
        for a, b in zip(keys[:-1], keys[1:]):
            if b - a < args.gap_min_frames:
                continue
            seg = [f for f in range(a + args.seq_step, b, args.seq_step) if f in poses]
            fwd, bwd = walk(a, seg), walk(b, seg[::-1])
            merged, disagree = merge_walks(seg, fwd, bwd, a, b, args.seq_agree_m, args.seq_trust_frames)
            kept = []
            for f, pick, how in merged:
                anchors[f] = (pick[0], pick[1])
                kinds[f] = 'tile-pnp-tracked'
                kept.append({'frame': f, 'from': how, 'inliers': pick[2][0], 'rmsPx': pick[2][1]})
            gap_report.append({'gap': [a, b], 'forwardSolved': sorted(fwd), 'backwardSolved': sorted(bwd), 'kept': kept, 'disagreements': disagree})
            print('gap', a, b, 'fwd', len(fwd), 'bwd', len(bwd), 'kept', len(kept), 'disagree', len(disagree), flush=True)
        poses, scale = bend(anchors)

    local_to_ecef = np.array(commit['frame']['localToEcef']).reshape(4, 4).T
    out_frames = []
    for f in frames:
        Rf, C = poses[int(f)]
        lat, lon, h = ecef_to_geodetic(*(local_to_ecef @ np.append(C, 1.0))[:3])
        out_frames.append({'frame': int(f), 'timeSec': (int(f) - 1) / 24.0, 'R': Rf.tolist(), 't': (-Rf @ C).tolist(), 'center': C.tolist(),
                           'target': (C + Rf[2] * 20.0).tolist(), 'up': (-Rf[1]).tolist(),
                           'geodetic': {'lat': float(lat), 'lng': float(lon), 'ellipsoidalHeightM': float(h)},
                           'anchor': kinds.get(int(f))})
    p = cam['params']
    counts = {}
    for v in kinds.values():
        counts[v] = counts.get(v, 0) + 1
    result = {
        'schema': 'scratchbox.camera-path/1',
        'frame': 'tile local (x east, y up, z south), metres; OpenCV pose x_cam = R x_world + t',
        'baseCommit': commit['id'], 'baseCommitSha256': commit['glb']['sha256'],
        'plate': {'width': cam['width'], 'height': cam['height'], 'fps': 24,
                  'lens': {'model': cam['model'], 'focalPx': p[0], 'cx': p[1], 'cy': p[2], 'k1': p[3]},
                  'verticalFovDeg': float(np.degrees(2 * np.arctan((cam['height'] / 2) / p[0]))), 'excludedFrames': args.cut_frames},
        'anchors': counts,
        'midRefinement': {'accepted': accepted, 'rejected': rejected, 'reusedFrom': args.reuse_anchors,
                          'passes': [{'name': n, 'acceptWithinM': a, 'minInliers': m} for n, a, m in passes]},
        'gapTracking': {'enabled': args.track_gaps, 'gaps': gap_report,
                        'params': {'stepFrames': args.seq_step, 'maxStepM': args.seq_max_step_m, 'agreeM': args.seq_agree_m,
                                   'trustFrames': args.seq_trust_frames, 'minInliers': args.seq_min_inliers}},
        'similarityScale': scale,
        'rawAnchors': [{'frame': int(k), 'kind': kinds[k], 'R': anchors[k][0].tolist(), 'center': anchors[k][1].tolist()} for k in sorted(anchors)],
        'frames': out_frames
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(result, indent=1))
    print(json.dumps({k: result[k] for k in ('anchors', 'similarityScale')}, indent=1))


if __name__ == '__main__':
    main()
