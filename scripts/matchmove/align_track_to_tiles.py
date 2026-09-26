#!/usr/bin/env python3
"""
Places a COLMAP camera track in a tile district by geometry instead of appearance (tile textures are
too coarse at close range for feature matching against a sharp plate).

1. Fit the street plane and the facade plane in both the SfM cloud and the tile mesh.
2. Initial similarity: rotation from the two plane normals, translation from the plane offsets plus an
   along-facade anchor (a tile point the camera at `--anchor-frame` is centred on), scale from `--init-scale`
   or from the camera height change between `--height-frames` against `--height-metres`.
3. Refine scale, rotation and translation with robust point-to-plane ICP against the tile surface.

Writes <out>/alignment.json (similarity, residual statistics) and <out>/camera_track_tile.json (per-frame
OpenCV pose, camera centre and look-at in tile metres).
"""
import argparse
import json
import struct
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree


def load_glb_triangles(path):
    b = Path(path).read_bytes()
    jlen = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + jlen])
    bin_off = 20 + jlen + 8
    acc, views = j['accessors'], j['bufferViews']

    def read(ai, comps, dtype):
        a = acc[ai]
        bv = views[a['bufferView']]
        n = a['count'] * comps
        return np.frombuffer(b, dtype=dtype, count=n, offset=bin_off + bv.get('byteOffset', 0) + a.get('byteOffset', 0)).reshape(-1, comps)

    tris = []
    for mesh in j['meshes']:
        for prim in mesh['primitives']:
            v = read(prim['attributes']['POSITION'], 3, '<f4').astype(np.float64)
            it = {5121: 'u1', 5123: '<u2', 5125: '<u4'}[acc[prim['indices']]['componentType']]
            idx = read(prim['indices'], 1, it).reshape(-1, 3).astype(np.int64)
            tris.append(v[idx])
    return np.concatenate(tris)  # T x 3 x 3


def sample_surface(tris, n, rng):
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    cross = np.cross(b - a, c - a)
    area = 0.5 * np.linalg.norm(cross, axis=1)
    keep = area > 1e-6
    tris, cross, area = tris[keep], cross[keep], area[keep]
    pick = rng.choice(len(tris), size=n, p=area / area.sum())
    r1, r2 = rng.random(n), rng.random(n)
    s = np.sqrt(r1)
    pts = (1 - s)[:, None] * tris[pick, 0] + (s * (1 - r2))[:, None] * tris[pick, 1] + (s * r2)[:, None] * tris[pick, 2]
    normals = cross[pick] / np.linalg.norm(cross[pick], axis=1, keepdims=True)
    return pts, normals


def ransac_plane(pts, thresh, iters=4000, rng=None, constraint=None):
    rng = rng or np.random.default_rng(0)
    best, best_n = None, -1
    for _ in range(iters):
        p = pts[rng.choice(len(pts), 3, replace=False)]
        n = np.cross(p[1] - p[0], p[2] - p[0])
        if np.linalg.norm(n) < 1e-12:
            continue
        n /= np.linalg.norm(n)
        if constraint is not None and not constraint(n):
            continue
        d = -n @ p[0]
        inl = np.abs(pts @ n + d) < thresh
        if inl.sum() > best_n:
            best_n, best = inl.sum(), inl
    q = pts[best]
    centroid = q.mean(0)
    _, _, vt = np.linalg.svd(q - centroid)
    n = vt[2]
    return n, -n @ centroid, best


def frame_basis(a, b):
    a = a / np.linalg.norm(a)
    b = b - a * (a @ b)
    b /= np.linalg.norm(b)
    return np.stack([a, b, np.cross(a, b)], 1)


def rotvec_to_matrix(w):
    th = np.linalg.norm(w)
    if th < 1e-12:
        return np.eye(3)
    k = w / th
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + np.sin(th) * K + (1 - np.cos(th)) * K @ K


def icp_sim3(src, tgt_pts, tgt_normals, s, R, T, iters=40, max_dist=3.0, huber=0.3, fix_scale=False, max_scale_step=0.02):
    tree = cKDTree(tgt_pts)
    history = []
    for it in range(iters):
        p = s * src @ R.T + T
        d, idx = tree.query(p, distance_upper_bound=max_dist)
        ok = np.isfinite(d)
        q, n, pp, ps = tgt_pts[idx[ok]], tgt_normals[idx[ok]], p[ok], src[ok]
        r = np.einsum('ij,ij->i', pp - q, n)
        w = np.where(np.abs(r) < huber, 1.0, huber / np.maximum(np.abs(r), 1e-9))
        # p' = c + (1 + ds) dR (p - c) + dT, linearized in (rotation vector, dT, ds) about the centroid c
        c = pp.mean(0)
        pc = pp - c
        J = np.hstack([np.cross(pc, n), n, np.einsum('ij,ij->i', pc, n)[:, None]])
        A = J.T @ (J * w[:, None])
        g = J.T @ (w * r)
        if fix_scale:
            delta = np.zeros(7)
            delta[:6] = -np.linalg.solve(A[:6, :6] + 1e-6 * np.eye(6), g[:6])
        else:
            delta = -np.linalg.solve(A + 1e-6 * np.eye(7), g)
            delta[6] = np.clip(delta[6], -max_scale_step, max_scale_step)
        dR = rotvec_to_matrix(delta[:3])
        k = 1 + delta[6]
        R = dR @ R
        T = k * dR @ T + c - k * dR @ c + delta[3:6]
        s = s * k
        history.append({'iter': it, 'matched': int(ok.sum()), 'medianAbsResidualM': float(np.median(np.abs(r))), 'scale': float(s)})
        if it > 3 and abs(history[-2]['medianAbsResidualM'] - history[-1]['medianAbsResidualM']) < 1e-4 and np.linalg.norm(delta) < 1e-6:
            break
    p = s * src @ R.T + T
    d, _ = tree.query(p)
    return s, R, T, history, d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--colmap', required=True, help='dir with track.json and points_obs.npz')
    ap.add_argument('--glb', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--facade-normal', type=float, nargs=3, required=True, help='outward facade normal in tile frame')
    ap.add_argument('--anchor', type=float, nargs=3, required=True, help='tile point the anchor frame is centred on')
    ap.add_argument('--anchor-frame', type=int, required=True)
    ap.add_argument('--anchor-distance', type=float, required=True, help='approx. camera distance to the anchor (m)')
    ap.add_argument('--ground-frames', type=int, nargs=2, default=[200, 241])
    ap.add_argument('--facade-frames', type=int, nargs=2, default=[40, 100])
    ap.add_argument('--region-radius', type=float, default=140.0)
    ap.add_argument('--scales', type=float, nargs='+', default=[4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 9.0])
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(7)

    track = json.loads((Path(args.colmap) / 'track.json').read_text())
    obs = np.load(Path(args.colmap) / 'points_obs.npz')
    X, fmed, perr = obs['xyz'], obs['fmed'], obs['err']
    good = perr < 2.0
    frames = {f['frame']: f for f in track['frames'] if f['registered']}
    centers = {k: np.array(v['center']) for k, v in frames.items()}

    # --- SfM planes
    ext = np.linalg.norm(np.percentile(X[good], 95, 0) - np.percentile(X[good], 5, 0))
    th = ext * 0.004
    gmask = good & (fmed >= args.ground_frames[0]) & (fmed < args.ground_frames[1])
    n_g, d_g, g_in = ransac_plane(X[gmask], th, rng=rng)
    cam_ground = np.mean([centers[k] for k in range(*args.ground_frames) if k in centers], 0)
    if n_g @ cam_ground + d_g < 0:
        n_g, d_g = -n_g, -d_g
    fmask = good & (fmed >= args.facade_frames[0]) & (fmed < args.facade_frames[1])
    n_f, d_f, f_in = ransac_plane(X[fmask], th, rng=rng, constraint=lambda n: abs(n @ n_g) < 0.15)
    # Facades are vertical: remove any lean the fit picked up from perspective, and refit the offset
    n_f = n_f - n_g * (n_g @ n_f)
    n_f /= np.linalg.norm(n_f)
    d_f = -np.median(X[fmask][f_in] @ n_f)
    cam_facade = np.mean([centers[k] for k in range(*args.facade_frames) if k in centers], 0)
    if n_f @ cam_facade + d_f < 0:
        n_f, d_f = -n_f, -d_f

    # --- tile surface around the anchor
    tris = load_glb_triangles(args.glb)
    cen = tris.mean(1)
    near = np.linalg.norm((cen - np.array(args.anchor))[:, [0, 2]], axis=1) < args.region_radius
    tile_pts, tile_nrm = sample_surface(tris[near], 600000, rng)
    up = np.array([0.0, 1.0, 0.0])
    facade_n_tile = np.array(args.facade_normal, float)
    facade_n_tile -= up * (up @ facade_n_tile)
    facade_n_tile /= np.linalg.norm(facade_n_tile)
    anchor = np.array(args.anchor, float)
    # Tile facade plane: vertical surface points behind the anchor, 15-55 m up, within 45 m laterally
    along = np.cross(up, facade_n_tile)
    rel = tile_pts - anchor
    slab = (tile_pts[:, 1] > 15) & (tile_pts[:, 1] < 55) & (np.abs(rel @ along) < 45) & (rel @ facade_n_tile < 2) & (rel @ facade_n_tile > -25) \
        & (np.abs(tile_nrm @ facade_n_tile) > 0.8)
    nt_f, dt_f, _ = ransac_plane(tile_pts[slab], 0.5, rng=rng, constraint=lambda n: abs(n[1]) < 0.1)
    if nt_f @ facade_n_tile < 0:
        nt_f, dt_f = -nt_f, -dt_f
    # Tile street: level points in front of the facade near the anchor
    street = (np.abs(tile_nrm[:, 1]) > 0.95) & (np.abs(rel @ along) < 40) & (rel @ facade_n_tile > 0) & (rel @ facade_n_tile < 30) & (tile_pts[:, 1] < 3)
    nt_g, dt_g, _ = ransac_plane(tile_pts[street], 0.3, rng=rng, constraint=lambda n: abs(n[1]) > 0.95)
    if nt_g[1] < 0:
        nt_g, dt_g = -nt_g, -dt_g

    # --- initial similarity: rotation from the two plane normals; the anchor-frame camera sits on the anchor's
    # facade-normal line at the SfM ratio of its facade distance to its street height
    R0 = frame_basis(nt_g, nt_f) @ frame_basis(n_g, n_f).T
    ca = centers[args.anchor_frame]
    anchor_foot = anchor - nt_f * (nt_f @ anchor + dt_f)
    anchor_foot = anchor_foot - nt_g * (nt_g @ anchor_foot + dt_g)

    def initial_T(scale):
        c = anchor_foot + nt_f * ((n_f @ ca + d_f) * scale) + nt_g * ((n_g @ ca + d_g) * scale)
        return c - scale * R0 @ ca

    src_all = X[good]
    sub = src_all[rng.choice(len(src_all), size=min(40000, len(src_all)), replace=False)]
    search = []
    for sc in args.scales:
        T_init = initial_T(sc)
        s_, R_, T_, h_, d_ = icp_sim3(sub, tile_pts, tile_nrm, sc, R0, T_init, iters=30, max_dist=4.0, fix_scale=True)
        inside = np.linalg.norm(((sc * sub @ R_.T + T_) - anchor)[:, [0, 2]], axis=1) < args.region_radius * 0.8
        search.append({'scale': sc, 'median': float(np.median(d_[inside])), 'within0p5m': float(np.mean(d_[inside] < 0.5)), 'R': R_, 'T': T_})
    best = min(search, key=lambda r: r['median'])
    s0, R0b, T0 = best['scale'], best['R'], best['T']
    # Scale stays at the best searched value: point-to-plane ICP drifts toward shrinking when scale is free
    s, R, T, hist, dists = icp_sim3(sub, tile_pts, tile_nrm, s0, R0b, T0, iters=40, max_dist=2.0, huber=0.2, fix_scale=True)
    s, R, T, hist2, dists = icp_sim3(sub, tile_pts, tile_nrm, s, R, T, iters=30, max_dist=1.0, huber=0.1, fix_scale=True)

    result = {
        'similarity': {'scale': float(s), 'R': R.tolist(), 'T': T.tolist(), 'maps': 'x_tile = scale * R x_sfm + T'},
        'scaleSearch': [{k: v for k, v in r.items() if k in ('scale', 'median', 'within0p5m')} for r in search],
        'planes': {'sfmGroundInliers': int(g_in.sum()), 'sfmFacadeInliers': int(f_in.sum()),
                   'tileFacade': {'n': nt_f.tolist(), 'd': float(dt_f)}, 'tileStreet': {'n': nt_g.tolist(), 'd': float(dt_g)}},
        'residuals': {'points': int(len(sub)), 'medianM': float(np.median(dists)), 'p90M': float(np.percentile(dists, 90)),
                      'within0p5m': float(np.mean(dists < 0.5)), 'within1m': float(np.mean(dists < 1.0))},
        'icp': hist + hist2,
    }
    (out / 'alignment.json').write_text(json.dumps(result, indent=1))

    cams = []
    for f in track['frames']:
        if not f['registered']:
            continue
        Rc, tc = np.array(f['R']), np.array(f['t'])
        C = s * R @ (-Rc.T @ tc) + T
        Rt = Rc @ R.T
        cams.append({'frame': f['frame'], 'R': Rt.tolist(), 't': (-Rt @ C).tolist(), 'center': C.tolist(),
                     'target': (C + Rt[2] * 20.0).tolist(), 'up': (-Rt[1]).tolist()})
    (out / 'camera_track_tile.json').write_text(json.dumps({'frame': 'tile local (x east, y up, z south), metres', 'camera': track['camera'], 'frames': cams}, indent=1))
    print(json.dumps({k: v for k, v in result.items() if k not in ('icp',)}, indent=1))
    print('icp scale path:', [round(h['scale'], 4) for h in (hist + hist2)][::6])


if __name__ == '__main__':
    main()
