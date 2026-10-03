#!/usr/bin/env python3
"""Trains an animatable Gaussian performer avatar on multi-view diffusion output.

Inputs
  --body        gvhmr_body.json from scripts/run_gvhmr.py --motion-dir (needs world_from_multiview)
  --result-dir  Multi-view result dir (cameras.json + videos/dense/*.mp4)
  --source      the original performer clip (gvhmr_input.mp4), supervised through GVHMR's camera
  --out-dir     writes human_4dgs.ply (Scratchbox codec: SH-DC colour, w-first quats, 4-bone weights),
                refine_report.json and qa/*.png

Model
  Canonical Gaussians = SMPL-X rest-surface samples (from the GVHMR body) + clothing samples from a
  frame-0 visual hull of the generated views, canonicalised by inverse LBS of the nearest body point.
  Each frame deforms them with the exact skinning the performer studio uses (scripts/sbx_skinning.py,
  splat orientation follows the primary bone). Offsets, colours, scales, rotations and opacities are
  optimised with gsplat against generated views + source video (L1 + SSIM + mask), with an offset
  regulariser keeping body samples near the surface. gsplat's DefaultStrategy densifies and prunes
  (children inherit their parent's bone weights; splats over 8 cm or near-transparent are pruned).
  Requires CUDA (gsplat).
"""
import argparse
import json
import math
import os
import random
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sbx_skinning import bone_rotations, mat_to_quat_wxyz, skin_points  # noqa: E402

SH_C0 = 0.28209479177387814


def read_video(path: Path, width=None, height=None) -> np.ndarray:
    import av
    frames = []
    with av.open(str(path)) as container:
        for frame in container.decode(video=0):
            if width and height:
                frame = frame.reformat(width=width, height=height)
            frames.append(frame.to_ndarray(format='rgb24'))
    return np.stack(frames)


def sample_rest_surface(body: dict, n: int, rng: np.random.Generator):
    V = np.asarray(body['rest_vertices'])
    F = np.asarray(body['faces'])
    tri = V[F]
    cr = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    area = 0.5 * np.linalg.norm(cr, axis=1)
    face = rng.choice(len(F), size=n, p=area / area.sum())
    s, t = np.sqrt(rng.random(n)), rng.random(n)
    bary = np.stack([1 - s, s * (1 - t), s * t], 1)
    pos = (tri[face] * bary[..., None]).sum(1)
    vn = np.zeros_like(V)
    np.add.at(vn, F.ravel(), np.repeat(cr, 3, axis=0))
    vn /= np.linalg.norm(vn, axis=1, keepdims=True) + 1e-12
    normal = (vn[F[face]] * bary[..., None]).sum(1)
    normal /= np.linalg.norm(normal, axis=1, keepdims=True) + 1e-12
    idx = np.asarray(body['skin_indices'])[F[face]]  # n,3,4
    w = np.asarray(body['skin_weights'])[F[face]] * bary[..., None]
    dense = np.zeros((n, 22))
    for k in range(3):
        for m in range(4):
            np.add.at(dense, (np.arange(n), idx[:, k, m]), w[:, k, m])
    top = np.argsort(-dense, 1)[:, :4]
    tw = np.take_along_axis(dense, top, 1)
    tw /= tw.sum(1, keepdims=True) + 1e-12
    return pos, normal, top, tw, float(area.sum())


def quat_from_normal_wxyz(n: np.ndarray) -> np.ndarray:
    q = np.zeros((len(n), 4))
    q[:, 0] = 1
    s = np.sqrt(np.clip((1 + n[:, 2]) * 2, 1e-12, None))
    ok = n[:, 2] > -0.9999
    q[ok] = np.stack([s / 2, -n[:, 1] / s, n[:, 0] / s, np.zeros(len(n))], 1)[ok]
    q[~ok] = [0, 0, 1, 0]
    return q / np.linalg.norm(q, axis=1, keepdims=True)


def visual_hull_points(cams, masks0, bbox_min, bbox_max, voxel=0.015, min_views_ratio=0.9):
    """Frame-0 visual hull surface voxels carved from binary masks of all generated views."""
    axes = [np.arange(bbox_min[i], bbox_max[i], voxel) for i in range(3)]
    grid = np.stack(np.meshgrid(*axes, indexing='ij'), -1).reshape(-1, 3)
    inside = np.zeros(len(grid), dtype=np.int32)
    seen = np.zeros(len(grid), dtype=np.int32)
    for cam, mask in zip(cams, masks0):
        pc = grid @ cam['w2c'][:3, :3].T + cam['w2c'][:3, 3]
        z = pc[:, 2]
        uv = (pc @ cam['K'].T)[:, :2] / np.clip(z[:, None], 1e-6, None)
        u, v = uv[:, 0].astype(int), uv[:, 1].astype(int)
        valid = (z > 0.1) & (u >= 0) & (v >= 0) & (u < mask.shape[1]) & (v < mask.shape[0])
        seen += valid
        inside[valid] += mask[v[valid], u[valid]] > 127
    occupied = (inside >= np.maximum(2, (seen * min_views_ratio).astype(int))) & (seen >= 2)
    occ = occupied.reshape(*[len(a) for a in axes])
    interior = occ.copy()
    for d in range(3):
        for s in (-1, 1):
            interior &= np.roll(occ, s, axis=d)
    surface = occ & ~interior
    return grid[surface.reshape(-1)]


def canonicalise(points_posed, posed_body_pts, body_top, body_w, rest_joints, posed_joints, R):
    """Inverse LBS using the skin weights of the nearest posed body sample."""
    from scipy.spatial import cKDTree
    _, nn = cKDTree(posed_body_pts).query(points_posed)
    top, w = body_top[nn], body_w[nn]
    A = np.einsum('nk,nkij->nij', w, R[top])
    t = np.einsum('nk,nki->ni', w, posed_joints[top] - np.einsum('nkij,nkj->nki', R[top], rest_joints[top]))
    canon = np.einsum('nij,nj->ni', np.linalg.inv(A), points_posed - t)
    return canon, top, w, nn


def ssim(x, y):
    import torch.nn.functional as F
    import torch
    C1, C2 = 0.01 ** 2, 0.03 ** 2
    g = torch.exp(-((torch.arange(11, device=x.device) - 5.0) ** 2) / (2 * 1.5 ** 2))
    g = (g / g.sum())
    win = (g[:, None] @ g[None, :])[None, None].repeat(3, 1, 1, 1)
    f = lambda t: F.conv2d(t, win, padding=5, groups=3)
    mx, my = f(x), f(y)
    sxx, syy, sxy = f(x * x) - mx ** 2, f(y * y) - my ** 2, f(x * y) - mx * my
    return (((2 * mx * my + C1) * (2 * sxy + C2)) / ((mx ** 2 + my ** 2 + C1) * (sxx + syy + C2))).mean()


def write_ply(path: Path, pos, rgb, opacity, scales, quats_wxyz, normals, bone_idx, bone_w):
    op = np.clip(opacity, 1e-4, 1 - 1e-4)
    rows = np.concatenate([
        pos, normals, (rgb - 0.5) / SH_C0, np.log(op / (1 - op))[:, None], np.log(np.clip(scales, 1e-6, None)), quats_wxyz,
    ], 1)
    header = '\n'.join([
        'ply', 'format ascii 1.0', 'comment scratchbox_encoding color=sh_dc quat=wxyz',
        'comment generator refine_multiview_avatar (Multi-view + GVHMR)',
        f'element vertex {len(pos)}',
        *[f'property float {p}' for p in ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
                                          'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']],
        *[f'property int bone_idx_{i}' for i in range(4)], *[f'property float bone_weight_{i}' for i in range(4)],
        'end_header'])
    with open(path, 'w') as f:
        f.write(header + '\n')
        for r, b, w in zip(rows, bone_idx, bone_w):
            f.write(' '.join(f'{v:.5f}' for v in r) + ' ' + ' '.join(str(int(x)) for x in b) + ' '
                    + ' '.join(f'{v:.4f}' for v in w) + '\n')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--body', required=True)
    ap.add_argument('--result-dir', required=True)
    ap.add_argument('--source', required=True)
    ap.add_argument('--out-dir', required=True)
    ap.add_argument('--birefnet', required=True, help='BiRefNet model dir (models/birefnet)')
    ap.add_argument('--performer_4d-root', required=True)
    ap.add_argument('--num-body', type=int, default=80000)
    ap.add_argument('--num-hull', type=int, default=60000)
    ap.add_argument('--iters', type=int, default=50000)
    ap.add_argument('--source-weight', type=float, default=6.0)
    ap.add_argument('--detail-weight', type=float, default=5.0,
                    help='Loss weight inside the face/hand regions of the real source view')
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--device', default='cuda')
    ap.add_argument('--max-seconds', type=float, default=0, help='Stop training early to fit a task time limit (0 = no limit)')
    args = ap.parse_args()

    import torch
    from gsplat import rasterization
    from gsplat.strategy import DefaultStrategy
    sys.path.insert(0, args.performer_4d_root)
    from performer_4d.foreground import predict_foreground_masks

    t0 = time.time()
    rng = np.random.default_rng(args.seed)
    torch.manual_seed(args.seed)
    dev = torch.device(args.device)
    out = Path(args.out_dir)
    (out / 'qa').mkdir(parents=True, exist_ok=True)
    body = json.load(open(args.body))
    rest_j = np.asarray(body['rest_joints'])
    frames_j = np.asarray([f['joints'] for f in body['frames']])
    T = len(frames_j)
    Rs = np.stack([bone_rotations(rest_j, frames_j[f]) for f in range(T)])  # T,22,3,3

    # ---- cameras & images ----------------------------------------------------------------
    result = Path(args.result_dir)
    rig = json.load(open(result / 'cameras.json'))
    world_from_4d = np.asarray(body.get('world_from_multiview', np.eye(4)))
    views = []
    for cam in rig['cameras']:
        c2w = world_from_4d @ np.asarray(cam['camera_to_world'])
        frames = read_video(result / cam['video'])[:T]
        views.append({'w2c': np.linalg.inv(c2w), 'K': np.asarray(cam['K']), 'frames': frames, 'weight': 1.0,
                      'name': f"gen_{cam['camera_id']:02d}"})
    src_w, src_h = 1080, int(round(1080 * body['height'] / body['width']))
    Ks = np.asarray(body['K']).copy()
    Ks[0] *= src_w / body['width']
    Ks[1] *= src_h / body['height']
    views.append({'w2c': np.asarray(body['source_world_to_camera']), 'K': Ks,
                  'frames': read_video(Path(args.source), src_w, src_h)[:T], 'weight': args.source_weight, 'name': 'source'})
    for v in views:
        v['masks'] = predict_foreground_masks(tuple(v['frames']), args.birefnet, args.device)

    # Face and hand boxes in the real source view: the only sharp supervision, so detail is learnt there.
    src = views[-1]
    def project(p):
        pc = src['w2c'][:3, :3] @ p + src['w2c'][:3, 3]
        uv = src['K'] @ pc
        return uv[:2] / uv[2], pc[2]
    src['detail_boxes'] = []
    for f in range(T):
        boxes = []
        J = frames_j[f]
        forearm = lambda wrist, elbow: J[wrist] + 0.08 * (J[wrist] - J[elbow]) / (np.linalg.norm(J[wrist] - J[elbow]) + 1e-9)
        centres = ((J[15] + np.array([0.0, 0.06, 0.0]), 0.16), (forearm(20, 18), 0.11), (forearm(21, 19), 0.11))
        for centre, radius in centres:
            (u, v), depth = project(centre)
            r = src['K'][0, 0] * radius / max(depth, 0.1)
            boxes.append(tuple(int(round(c)) for c in (u - r, v - r, u + r, v + r)))
        src['detail_boxes'].append(boxes)
    print(f'[refine] {len(views)} views x {T} frames loaded + masked in {time.time() - t0:.0f}s', flush=True)

    # ---- initialisation ------------------------------------------------------------------
    b_pos, b_nrm, b_top, b_w, area = sample_rest_surface(body, args.num_body, rng)
    posed0 = skin_points(b_pos, b_top, b_w, rest_j, frames_j[0], Rs[0])
    lo, hi = posed0.min(0) - 0.35, posed0.max(0) + 0.35
    lo[1] = 0.0  # the floor: never carve clothing below the ground plane
    hull = visual_hull_points([v for v in views if v['name'] != 'source'],
                              [v['masks'][0] for v in views if v['name'] != 'source'], lo, hi)
    from scipy.spatial import cKDTree
    dist, _ = cKDTree(posed0).query(hull)
    hull = hull[dist > 0.02]
    if len(hull) > args.num_hull:
        hull = hull[rng.choice(len(hull), args.num_hull, replace=False)]
    h_pos, h_top, h_w, h_nn = canonicalise(hull, posed0, b_top, b_w, rest_j, frames_j[0], Rs[0])
    pos = np.concatenate([b_pos, h_pos])
    nrm = np.concatenate([b_nrm, b_nrm[h_nn]])
    top = np.concatenate([b_top, h_top])
    wts = np.concatenate([b_w, h_w])
    is_body = np.concatenate([np.ones(len(b_pos)), np.zeros(len(h_pos))])
    N = len(pos)
    spacing = math.sqrt(area / args.num_body)
    print(f'[refine] {len(b_pos)} body + {len(h_pos)} clothing-hull Gaussians', flush=True)

    tt = lambda a, dt=torch.float32: torch.tensor(np.asarray(a), dtype=dt, device=dev)
    P = lambda t, grad=True: torch.nn.Parameter(t, requires_grad=grad)
    # Trainable splat attributes plus per-splat skinning data; gsplat's densification splits/duplicates
    # every entry, so children inherit their parent's bone weights and rest-surface anchor.
    params = torch.nn.ParameterDict({
        'means': P(tt(pos)),
        'scales': P(tt(np.log(np.tile([0.7 * spacing, 0.7 * spacing, 0.25 * spacing], (N, 1))))),
        'quats': P(tt(quat_from_normal_wxyz(nrm))),
        'opacities': P(torch.full((N,), 2.0, device=dev)),
        'colors': P(torch.zeros(N, 3, device=dev)),
        'anchor': P(tt(pos), False),
        'bone_idx': P(tt(top, torch.long), False),
        'bone_w': P(tt(wts), False),
        'is_body': P(tt(is_body), False),
    })
    lrs = {'means': 2e-4, 'scales': 5e-3, 'quats': 1e-3, 'opacities': 3e-2, 'colors': 1e-2}
    optimizers = {k: torch.optim.Adam([params[k]], lr=lr, eps=1e-15) for k, lr in lrs.items()}
    strategy = DefaultStrategy(refine_start_iter=500, refine_stop_iter=int(args.iters * 0.6), reset_every=3000,
                               refine_every=100, prune_scale3d=0.08, verbose=False)
    strategy.check_sanity(params, optimizers)
    strategy_state = strategy.initialize_state(scene_scale=1.0)

    rest_t = tt(rest_j)
    R_t = tt(Rs)
    P_t = tt(frames_j)
    boneQ = tt(np.stack([[mat_to_quat_wxyz(r) for r in frame] for frame in Rs]))  # T,22,4

    def quat_mul(a, b):
        aw, ax, ay, az = a.unbind(-1)
        bw, bx, by, bz = b.unbind(-1)
        return torch.stack([aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by,
                            aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw], -1)

    def deform(f):
        top_t, w_t = params['bone_idx'], params['bone_w']
        rel = params['means'][:, None, :] - rest_t[top_t]
        rot = torch.einsum('nkij,nkj->nki', R_t[f][top_t], rel)
        x = ((P_t[f][top_t] + rot) * w_t[..., None]).sum(1) / w_t.sum(1, keepdim=True).clamp(min=1e-6)
        q = quat_mul(boneQ[f][top_t[:, 0]], torch.nn.functional.normalize(params['quats'], dim=-1))
        return x, q

    def render(f, view, bg):
        x, q = deform(f)
        h, w = view['frames'].shape[1:3]
        colors, alphas, info = rasterization(
            x, q, torch.exp(params['scales']), torch.sigmoid(params['opacities']), torch.sigmoid(params['colors']),
            tt(view['w2c'])[None], tt(view['K'])[None], w, h, backgrounds=bg[None], packed=False)
        return colors[0], alphas[0, ..., 0], info

    # ---- optimisation --------------------------------------------------------------------
    weights = np.array([v['weight'] for v in views])
    budget_stop = args.max_seconds > 0 and (lambda: time.time() - t0 > args.max_seconds)
    for it in range(args.iters):
        if budget_stop and budget_stop():
            print(f'[refine] time budget reached at iter {it}; exporting', flush=True)
            break
        f = random.randrange(T)
        v = views[rng.choice(len(views), p=weights / weights.sum())]
        bg = torch.rand(3, device=dev)
        img = tt(v['frames'][f]) / 255.0
        mask = tt(v['masks'][f]) / 255.0
        gt = img * mask[..., None] + bg * (1 - mask[..., None])
        pred, alpha, info = render(f, v, bg)
        strategy.step_pre_backward(params, optimizers, strategy_state, it, info)
        err = (pred - gt).abs().mean(-1)
        detail = 0.0
        if 'detail_boxes' in v:
            h, w = err.shape
            weight = torch.ones_like(err)
            for k, (x0, y0, x1, y1) in enumerate(v['detail_boxes'][f]):
                x0, y0, x1, y1 = max(0, x0), max(0, y0), min(w, x1), min(h, y1)
                if x1 - x0 < 16 or y1 - y0 < 16:
                    continue
                weight[y0:y1, x0:x1] = args.detail_weight
                if k == 0:  # face crop gets its own structural term
                    crop = lambda t: t[y0:y1, x0:x1].permute(2, 0, 1)[None]
                    detail = 1 - ssim(crop(pred), crop(gt))
            l1 = (err * weight).sum() / weight.sum()
        else:
            l1 = err.mean()
        loss = 0.8 * l1 + 0.2 * (1 - ssim(pred.permute(2, 0, 1)[None], gt.permute(2, 0, 1)[None])) + 0.2 * detail \
            + 0.5 * (alpha - mask).abs().mean() \
            + 10.0 * (((params['means'] - params['anchor']) ** 2).sum(-1) * params['is_body']).mean() \
            + 1e-3 * torch.relu(params['scales'] - math.log(4 * spacing)).mean() \
            + 1e-4 * torch.sigmoid(params['opacities']).mean()
        # Below-floor splats (ground at y=0) are invisible in training views but smear in the studio.
        x_f, _ = deform(f)
        loss = loss + 10.0 * torch.relu(-0.01 - x_f[:, 1]).mean()
        loss.backward()
        for o in optimizers.values():
            o.step()
            o.zero_grad(set_to_none=True)
        strategy.step_post_backward(params, optimizers, strategy_state, it, info, packed=False)
        if it % 500 == 0:
            print(f'[refine] iter {it} loss {loss.item():.4f} l1 {l1.item():.4f} splats {len(params["means"])} '
                  f'({time.time() - t0:.0f}s)', flush=True)

    # ---- export ----------------------------------------------------------------------------
    import imageio.v3 as iio
    with torch.no_grad():
        qa = []
        for f in (0, T // 2):
            for v in [views[0], views[len(views) // 4], views[len(views) // 2], views[-1]]:
                pred, _, _ = render(f, v, torch.ones(3, device=dev))
                gt = v['frames'][f]
                pr = (pred.clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)
                qa.append(np.concatenate([gt, pr], 1) if gt.shape == pr.shape else pr)
                iio.imwrite(out / 'qa' / f'f{f:03d}_{v["name"]}.png', qa[-1])
        # Drop splats that dip below the floor in any frame.
        keep = torch.ones(len(params['means']), dtype=torch.bool, device=dev)
        for f in range(0, T, max(1, T // 24)):
            keep &= deform(f)[0][:, 1] > -0.03
        print(f'[refine] pruning {int((~keep).sum())} below-floor splats', flush=True)
        for k in list(params.keys()):
            params[k] = torch.nn.Parameter(params[k][keep], requires_grad=False)
        q = torch.nn.functional.normalize(params['quats'], dim=-1)
        # Surface normal = the splat's thinnest axis, for the PLY's nx/ny/nz.
        from gsplat.utils import normalized_quat_to_rotmat
        R = normalized_quat_to_rotmat(q)
        thin = torch.argmin(params['scales'], dim=-1)
        normals = R[torch.arange(len(q), device=dev), :, thin]
        write_ply(out / 'human_4dgs.ply', params['means'].cpu().numpy(), torch.sigmoid(params['colors']).cpu().numpy(),
                  torch.sigmoid(params['opacities']).cpu().numpy(), torch.exp(params['scales']).cpu().numpy(),
                  q.cpu().numpy(), normals.cpu().numpy(), params['bone_idx'].cpu().numpy(), params['bone_w'].cpu().numpy())
    report = {'gaussians': int(len(params['means'])), 'initial_gaussians': int(N), 'body_gaussians': int(len(b_pos)),
              'hull_gaussians': int(len(h_pos)),
              'views': len(views), 'frames': int(T), 'iters': it + 1, 'final_loss': float(loss.item()),
              'seconds': round(time.time() - t0, 1)}
    json.dump(report, open(out / 'refine_report.json', 'w'), indent=2)
    print('[refine] done', json.dumps(report), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
