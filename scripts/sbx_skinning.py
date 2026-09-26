"""NumPy port of packages/core/src/common/humanoid-skinning.ts (computeBoneRotations / skinPoint).

The multi-view refinement trains Gaussians under exactly the deformation the performer studio plays
back, so trained splats render identically in the viewer. Parity is enforced by
packages/core/test/4danyone-performer-integrity.test.ts.
"""
import json
import sys

import numpy as np

PARENTS = [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19]
SEGMENT_CHILD = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, -1, -1, 15, 16, 17, -1, 18, 19, 20, 21, -1, -1]
LATERAL_REF = [(2, 1), None, None, (2, 1), None, None, (17, 16), None, None, (17, 16), None, None,
               (17, 16), None, None, None, None, None, None, None, None, None]


def _normalize(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else None


def _swing(a, b):
    a, b = _normalize(a), _normalize(b)
    if a is None or b is None:
        return np.eye(3)
    axis = np.cross(a, b)
    s = np.linalg.norm(axis)
    c = float(np.clip(a @ b, -1.0, 1.0))
    if s < 1e-6:
        if c > 0:
            return np.eye(3)
        p = _normalize(np.cross(a, [1.0, 0, 0]) if abs(a[0]) < 0.9 else np.cross(a, [0, 1.0, 0]))
        return 2 * np.outer(p, p) - np.eye(3)
    u = axis / s
    K = np.array([[0, -u[2], u[1]], [u[2], 0, -u[0]], [-u[1], u[0], 0]])
    return np.eye(3) + s * K + (1 - c) * K @ K


def _frame(primary, lateral):
    e1 = _normalize(primary)
    if e1 is None:
        return None
    lat = lateral - e1 * (lateral @ e1)
    e2 = _normalize(lat)
    if e2 is None or np.linalg.norm(lat) < 0.2 * np.linalg.norm(lateral):
        return None
    return np.stack([e1, e2, np.cross(e1, e2)], axis=1)


def bone_rotations(canonical, posed):
    canonical = np.asarray(canonical, dtype=np.float64)
    posed = np.asarray(posed, dtype=np.float64)
    n = min(len(canonical), len(posed), len(PARENTS))
    R = [None] * n
    for j in range(n):
        child = SEGMENT_CHILD[j]
        if child < 0 or child >= n:
            R[j] = R[PARENTS[j]] if PARENTS[j] >= 0 else np.eye(3)
            continue
        seg_c = canonical[child] - canonical[j]
        seg_p = posed[child] - posed[j]
        rot = None
        lateral = LATERAL_REF[j]
        if lateral:
            fc = _frame(seg_c, canonical[lateral[1]] - canonical[lateral[0]])
            fp = _frame(seg_p, posed[lateral[1]] - posed[lateral[0]])
            if fc is not None and fp is not None:
                rot = fp @ fc.T
        if rot is None:
            Rp = R[PARENTS[j]] if PARENTS[j] >= 0 else np.eye(3)
            rot = _swing(Rp @ seg_c, seg_p) @ Rp
        R[j] = rot
    return np.stack(R)


def mat_to_quat_wxyz(m):
    """Matches humanoid-skinning.ts mat3ToQuat, returned as (w, x, y, z)."""
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        s = 0.5 / np.sqrt(tr + 1)
        return np.array([0.25 / s, (m[2, 1] - m[1, 2]) * s, (m[0, 2] - m[2, 0]) * s, (m[1, 0] - m[0, 1]) * s])
    if m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = 2 * np.sqrt(1 + m[0, 0] - m[1, 1] - m[2, 2])
        return np.array([(m[2, 1] - m[1, 2]) / s, 0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s])
    if m[1, 1] > m[2, 2]:
        s = 2 * np.sqrt(1 + m[1, 1] - m[0, 0] - m[2, 2])
        return np.array([(m[0, 2] - m[2, 0]) / s, (m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s])
    s = 2 * np.sqrt(1 + m[2, 2] - m[0, 0] - m[1, 1])
    return np.array([(m[1, 0] - m[0, 1]) / s, (m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s])


def skin_points(points, bone_idx, bone_w, canonical, posed, R):
    """LBS for many points: sum_k w_k (posed[j] + R_j (p - canonical[j])), renormalised."""
    canonical = np.asarray(canonical)
    posed = np.asarray(posed)
    rel = points[:, None, :] - canonical[bone_idx]
    rotated = np.einsum('nkij,nkj->nki', R[bone_idx], rel)
    out = ((posed[bone_idx] + rotated) * bone_w[..., None]).sum(1)
    return out / np.clip(bone_w.sum(1, keepdims=True), 1e-6, None)


if __name__ == '__main__':
    # Parity probe: stdin {"canonical": [...], "posed": [...]} -> stdout rotations (22x3x3)
    payload = json.load(sys.stdin)
    json.dump(bone_rotations(payload['canonical'], payload['posed']).tolist(), sys.stdout)
