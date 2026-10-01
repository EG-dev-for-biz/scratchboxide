# Copyright (C) 2026 Scratchbox LLC. All rights reserved.
# Proprietary and confidential. Unauthorized copying is strictly prohibited.

"""
Unit tests for DepthBox mathematical principles, depth-ray unprojection,
pinhole ray maps, and geometric loss calculations.
Runs in standard Python 3 with zero external dependencies.
"""

import math
import unittest


def compute_pinhole_ray(u: float, v: float, w: int, h: int, fov_deg: float = 60.0):
    """
    Computes camera space unit ray for pixel (u, v).
    """
    fov_rad = math.radians(fov_deg)
    f = 0.5 * h / math.tan(fov_rad * 0.5)
    cx = w * 0.5
    cy = h * 0.5

    x = (u - cx) / f
    y = (v - cy) / f
    z = 1.0

    length = math.sqrt(x * x + y * y + z * z)
    return (x / length, y / length, z / length)


def unproject_point(d: float, ray: tuple):
    """
    3D point from depth and unit ray: P = d * r
    """
    rx, ry, rz = ray
    return (d * rx, d * ry, d * rz)


def silog_loss_scalar(pred_depths, gt_depths, lam: float = 0.85):
    """
    Computes SILog loss over a list of depths.
    """
    diffs = [math.log(p) - math.log(g) for p, g in zip(pred_depths, gt_depths)]
    n = len(diffs)
    diff_sq_mean = sum(d * d for d in diffs) / n
    diff_mean = sum(diffs) / n
    variance = diff_sq_mean - lam * (diff_mean ** 2)
    return math.sqrt(max(0.0, variance))


def ray_cosine_loss(pred_rays, gt_rays):
    """
    Computes average (1 - <r_pred, r_gt>)
    """
    total = 0.0
    for p, g in zip(pred_rays, gt_rays):
        dot = p[0] * g[0] + p[1] * g[1] + p[2] * g[2]
        dot = max(-1.0, min(1.0, dot))
        total += (1.0 - dot)
    return total / len(pred_rays)


class TestDepthBoxMath(unittest.TestCase):

    def test_pinhole_ray_unit_length(self):
        w, h = 518, 518
        for u in [0, 100, 259, 400, 517]:
            for v in [0, 100, 259, 400, 517]:
                rx, ry, rz = compute_pinhole_ray(u, v, w, h, fov_deg=65.0)
                length = math.sqrt(rx * rx + ry * ry + rz * rz)
                self.assertAlmostEqual(length, 1.0, places=5)

    def test_center_ray_is_forward(self):
        w, h = 518, 518
        rx, ry, rz = compute_pinhole_ray(259.0, 259.0, w, h, fov_deg=60.0)
        self.assertAlmostEqual(rx, 0.0, places=4)
        self.assertAlmostEqual(ry, 0.0, places=4)
        self.assertAlmostEqual(rz, 1.0, places=4)

    def test_unproject_plane_geometry(self):
        # A flat wall at depth 10.0m along ray
        w, h = 400, 400
        ray_center = compute_pinhole_ray(200.0, 200.0, w, h, fov_deg=60.0)
        px, py, pz = unproject_point(10.0, ray_center)
        self.assertAlmostEqual(pz, 10.0, places=4)
        self.assertAlmostEqual(px, 0.0, places=4)
        self.assertAlmostEqual(py, 0.0, places=4)

    def test_silog_loss_zero_when_identical(self):
        depths = [1.5, 3.2, 10.0, 25.4, 100.0]
        loss = silog_loss_scalar(depths, depths, lam=0.85)
        self.assertAlmostEqual(loss, 0.0, places=4)

    def test_silog_scale_invariance(self):
        gt = [2.0, 4.0, 8.0, 16.0]
        # Predict with constant scaling factor 2.0 (relative geometry identical)
        pred_scaled = [d * 2.0 for d in gt]
        loss_scaled = silog_loss_scalar(pred_scaled, gt, lam=1.0)
        # When lambda=1.0, SILog is completely invariant to global scale factor!
        self.assertAlmostEqual(loss_scaled, 0.0, places=4)

    def test_ray_cosine_loss(self):
        inv_sqrt2 = 1.0 / math.sqrt(2.0)
        rays_a = [(0.0, 0.0, 1.0), (inv_sqrt2, 0.0, inv_sqrt2)]
        rays_b = [(0.0, 0.0, 1.0), (inv_sqrt2, 0.0, inv_sqrt2)]
        loss = ray_cosine_loss(rays_a, rays_b)
        self.assertAlmostEqual(loss, 0.0, places=5)

        # 90-degree orthogonal ray has dot product 0 -> loss = 1.0
        rays_c = [(1.0, 0.0, 0.0)]
        rays_d = [(0.0, 0.0, 1.0)]
        loss_ortho = ray_cosine_loss(rays_c, rays_d)
        self.assertAlmostEqual(loss_ortho, 1.0, places=5)

    def test_exponential_depth_positivity(self):
        # Raw logits from neural net can be negative, zero, or positive
        logits = [-10.0, -2.5, 0.0, 1.5, 5.0]
        for y in logits:
            d = math.exp(y)
            self.assertGreater(d, 0.0)


if __name__ == "__main__":
    unittest.main()
