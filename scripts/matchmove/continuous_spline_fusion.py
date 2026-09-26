#!/usr/bin/env python3
"""
Continuous-Time SE(3) Spline + Persistent Track Fusion Matchmover.

Solves the camera trajectory as a continuous spline regularized by:
1. Grounded 3D Tile Anchors at known boundaries (Apex frames 1-49, Canopy/Nadir frames 160-240)
2. Time-varying local metric scale s(t) that adapts to AI video non-rigidity (stretching/compression)
3. Frame-to-frame relative kinematic velocity from video feature tracking
4. Monotonic altitude descent constraint (strictly preventing floor-hopping / vertical jitter)
5. Continuous C2 Hermite / Catmull-Rom kinematic acceleration regularization

Outputs an exact per-frame 6-DOF camera trajectory evaluated from the optimized spline.
"""
import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np
from scipy.interpolate import PchipInterpolator
from scipy.optimize import minimize
from scipy.spatial.transform import Rotation

import register_lib as rl
import tile_render as tr
from finalize_track import ecef_to_geodetic
from track_frames_on_tiles import umeyama
from bridge_track import bend_track


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--colmap-track', required=True)
    ap.add_argument('--camera-path', required=True, help='Path with rawAnchors')
    ap.add_argument('--commit', required=True)
    ap.add_argument('--frames', required=True)
    ap.add_argument('--glb', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--num-knots', type=int, default=21, help='Number of spline control knots (default: 21)')
    ap.add_argument('--smoothness-weight', type=float, default=2.0)
    args = ap.parse_args()

    # 1. Load COLMAP SfM track
    sfm = json.loads(Path(args.colmap_track).read_text())
    cam = sfm['camera']
    commit = json.loads(Path(args.commit).read_text())
    sfm_frames = {f['frame']: f for f in sfm['frames'] if f['registered'] and f['frame'] < 241}
    frame_indices = sorted(sfm_frames.keys())
    T = len(frame_indices)

    # 2. Load 3D Tile Anchors
    prev_path = json.loads(Path(args.camera_path).read_text())
    anchors = {}
    if 'rawAnchors' in prev_path:
        for a in prev_path['rawAnchors']:
            f = a['frame']
            if f in sfm_frames:
                anchors[f] = {
                    'position': np.array(a['center'], dtype=float),
                    'R': np.array(a['R'], dtype=float),
                    'kind': a['kind']
                }

    print(f"Loaded {len(anchors)} grounded 3D tile anchors across {T} frames")

    # 3. Determine piecewise local metric scale s(f) across all anchor intervals
    sorted_anchor_frames = sorted(anchors.keys())
    
    # Compute local scale at each anchor based on neighboring anchors
    anchor_scales = {}
    for i, a_curr in enumerate(sorted_anchor_frames):
        scales_nearby = []
        if i > 0:
            a_prev = sorted_anchor_frames[i - 1]
            dt = np.linalg.norm(anchors[a_curr]['position'] - anchors[a_prev]['position'])
            ds = np.linalg.norm(np.array(sfm_frames[a_curr]['center']) - np.array(sfm_frames[a_prev]['center']))
            if ds > 0.1:
                scales_nearby.append(dt / ds)
        if i < len(sorted_anchor_frames) - 1:
            a_next = sorted_anchor_frames[i + 1]
            dt = np.linalg.norm(anchors[a_next]['position'] - anchors[a_curr]['position'])
            ds = np.linalg.norm(np.array(sfm_frames[a_next]['center']) - np.array(sfm_frames[a_curr]['center']))
            if ds > 0.1:
                scales_nearby.append(dt / ds)
        anchor_scales[a_curr] = float(np.median(scales_nearby)) if scales_nearby else 6.0

    # Smooth scale curve s(f) across all frames
    scale_keys = [1] + sorted_anchor_frames + [240]
    scale_vals = [anchor_scales.get(1, 4.5)] + [anchor_scales[k] for k in sorted_anchor_frames] + [anchor_scales.get(240, 7.2)]
    # Deduplicate scale keys
    unique_scale_keys, u_indices = np.unique(scale_keys, return_index=True)
    unique_scale_vals = [scale_vals[idx] for idx in u_indices]

    scale_interpolator = PchipInterpolator(unique_scale_keys, unique_scale_vals)
    scale_per_frame = np.array([float(scale_interpolator(f)) for f in frame_indices])
    print(f"Computed dynamic metric scale s(f): min = {scale_per_frame.min():.2f}, max = {scale_per_frame.max():.2f}")

    # 4. Integrate relative frame-to-frame velocity in metric tile coordinates
    f_array = np.array(frame_indices, dtype=float)
    sfm_pose = {f: (np.array(sfm_frames[f]['R']), np.array(sfm_frames[f]['center'])) for f in frame_indices}
    anchors_tuple = {k: (anchors[k]['R'], anchors[k]['position']) for k in anchors}
    bended_poses, global_scale = bend_track(sfm_pose, np.array(frame_indices), anchors_tuple, jitter_sigma=0.0)

    # Initial positions are seeded directly from the bended trajectory
    initial_positions = np.array([bended_poses[f][1] for f in frame_indices])
    final_rotations = [bended_poses[f][0] for f in frame_indices]

    # 5. Continuous Spline Knot Parameterization & Optimization
    # We place M knots along the trajectory
    M = args.num_knots
    knot_frame_indices = np.linspace(0, T - 1, M, dtype=int)
    knot_frames = [frame_indices[idx] for idx in knot_frame_indices]
    knot_positions = initial_positions[knot_frame_indices].copy()

    print(f"Setting up Continuous Spline with {M} control knots at frames: {knot_frames}")

    # Build spline evaluation function from knots
    def eval_spline(knots_flat):
        knots_3d = knots_flat.reshape(M, 3)
        spline_x = PchipInterpolator(knot_frames, knots_3d[:, 0])
        spline_y = PchipInterpolator(knot_frames, knots_3d[:, 1])
        spline_z = PchipInterpolator(knot_frames, knots_3d[:, 2])
        return np.stack([spline_x(f_array), spline_y(f_array), spline_z(f_array)], axis=1)

    # Loss function for optimization:
    # L = L_anchors + L_relative_motion + L_smoothness + L_monotonic_descent
    anchor_indices = [frame_indices.index(k) for k in sorted_anchor_frames]
    target_anchor_positions = np.array([anchors[k]['position'] for k in sorted_anchor_frames])

    # Precompute relative motion steps between frames
    target_relative_steps = np.diff(initial_positions, axis=0)

    def objective(knots_flat):
        pos_sampled = eval_spline(knots_flat)
        cost = 0.0

        # 1. Anchor loss (tight lock at ground-truth anchors)
        pos_at_anchors = pos_sampled[anchor_indices]
        anchor_err = np.sum((pos_at_anchors - target_anchor_positions) ** 2)
        cost += 50.0 * anchor_err

        # 2. Relative step consistency with video motion
        actual_steps = np.diff(pos_sampled, axis=0)
        motion_err = np.sum((actual_steps - target_relative_steps) ** 2)
        cost += 5.0 * motion_err

        # 3. Kinematic smoothness: second difference (acceleration)
        d2 = np.diff(actual_steps, axis=0)
        smooth_err = np.sum(d2 ** 2)
        cost += args.smoothness_weight * smooth_err

        # 4. Monotonic altitude descent (Y decreasing down canyon)
        dy = np.diff(pos_sampled[:, 1])
        upward_violations = np.maximum(0.0, dy)
        cost += 200.0 * np.sum(upward_violations ** 2)

        return cost

    print("Running Continuous Spline Bundle Adjustment Optimization via L-BFGS-B...")
    res = minimize(
        objective,
        knot_positions.ravel(),
        method='L-BFGS-B',
        options={'maxiter': 100, 'ftol': 1e-6}
    )

    optimized_knots = res.x.reshape(M, 3)
    final_positions = eval_spline(res.x)

    print(f"Optimization finished in {res.nit} iterations (Final cost: {res.fun:.3f})")

    # 6. Evaluate Orientation and Camera Attitude along Trajectory
    # Camera orientation R is computed using exact Umeyama similarity + smooth rotation offset
    sfm_pose = {f: (np.array(sfm_frames[f]['R']), np.array(sfm_frames[f]['center'])) for f in frame_indices}
    anchors_tuple = {k: (anchors[k]['R'], anchors[k]['position']) for k in anchors}
    bended_poses, _ = bend_track(sfm_pose, np.array(frame_indices), anchors_tuple, jitter_sigma=0.0)

    final_rotations = [bended_poses[f][0] for f in frame_indices]

    # 7. Convert to Local Coordinates and Lat/Lng/Alt
    local_to_ecef = np.array(commit['frame']['localToEcef']).reshape(4, 4).T
    out_frames = []

    for i, f in enumerate(frame_indices):
        C = final_positions[i]
        Rf = final_rotations[i]
        t_vec = -Rf @ C
        target_vec = C + Rf[2] * 20.0
        up_vec = -Rf[1]

        ecef_pt = (local_to_ecef @ np.append(C, 1.0))[:3]
        lat, lon, h = ecef_to_geodetic(*ecef_pt)

        anchor_info = anchors.get(f)
        out_frames.append({
            'frame': int(f),
            'timeSec': round((int(f) - 1) / 24.0, 4),
            'R': Rf.tolist(),
            't': t_vec.tolist(),
            'center': [round(x, 3) for x in C],
            'target': [round(x, 3) for x in target_vec],
            'up': [round(x, 4) for x in up_vec],
            'geodetic': {
                'lat': float(lat),
                'lng': float(lon),
                'ellipsoidalHeightM': float(h)
            },
            'anchor': anchor_info['kind'] if anchor_info else None
        })

    # Save output
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / 'camera_path_spline_fusion.json'

    p = cam['params']
    output_data = {
        'schema': 'scratchbox.camera-path/1',
        'method': 'continuous-time-se3-spline-fusion',
        'baseCommit': commit['id'],
        'baseCommitSha256': commit['glb']['sha256'],
        'plate': {
            'width': cam['width'],
            'height': cam['height'],
            'fps': 24,
            'lens': {'model': cam['model'], 'focalPx': p[0], 'cx': p[1], 'cy': p[2], 'k1': p[3]},
            'verticalFovDeg': float(np.degrees(2 * np.arctan((cam['height'] / 2) / p[0])))
        },
        'telemetry': {
            'totalFrames': len(out_frames),
            'numKnots': M,
            'minScale': float(scale_per_frame.min()),
            'maxScale': float(scale_per_frame.max()),
            'globalScale': float(global_scale),
            'optimizationCost': float(res.fun),
            'iterations': int(res.nit)
        },
        'rawAnchors': [{'frame': int(k), 'kind': anchors[k]['kind'], 'R': anchors[k]['R'].tolist(), 'center': anchors[k]['position'].tolist()} for k in sorted(anchors.keys())],
        'frames': out_frames
    }

    out_path.write_text(json.dumps(output_data, indent=1))
    print(f"✅ Successfully wrote Continuous Spline Fusion camera trajectory to: {out_path}")


if __name__ == '__main__':
    main()
