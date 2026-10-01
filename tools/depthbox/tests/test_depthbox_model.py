# Copyright (C) 2026 Scratchbox LLC. All rights reserved.
# Proprietary and confidential. Unauthorized copying is strictly prohibited.

"""
Unit tests for DepthBox Model Architecture (PyTorch).
Tests backbone extraction, cross-view attention, dual-DPT heads,
tensor dimensions across N=1 and N=2 views, and loss gradients.
"""

import unittest

try:
    import torch
    import torch.nn as nn
    TORCH_AVAILABLE = True
except ImportError:
    TORCH_AVAILABLE = False


class TestDepthBoxModel(unittest.TestCase):

    def setUp(self):
        if not TORCH_AVAILABLE:
            self.skipTest("PyTorch is not installed in the local environment.")

    def test_model_forward_single_view(self):
        from tools.depthbox.model.depthbox_module import DepthBoxModel

        model = DepthBoxModel(backbone_name="dinov2_vits14_reg", pretrained_backbone=False)
        model.eval()

        # Single image: (B, 3, H, W)
        B, H, W = 1, 224, 224
        images = torch.randn(B, 3, H, W)

        with torch.no_grad():
            depth, rays = model(images)

        self.assertEqual(depth.shape, (B, 1, H, W))
        self.assertEqual(rays.shape, (B, 3, H, W))

        # Check positive depth
        self.assertTrue((depth >= 0.1).all().item())

        # Check unit ray normalization: ||r|| = 1.0
        ray_norms = torch.norm(rays, dim=1)
        self.assertTrue(torch.allclose(ray_norms, torch.ones_like(ray_norms), atol=1e-4))

    def test_model_forward_multi_view(self):
        from tools.depthbox.model.depthbox_module import DepthBoxModel

        model = DepthBoxModel(backbone_name="dinov2_vits14_reg", pretrained_backbone=False)
        model.eval()

        # Multi-view sequence: (B, N, 3, H, W)
        B, N, H, W = 2, 2, 224, 224
        images = torch.randn(B, N, 3, H, W)
        poses = torch.randn(B, N, 16)

        with torch.no_grad():
            depth, rays = model(images, camera_poses=poses)

        self.assertEqual(depth.shape, (B, N, 1, H, W))
        self.assertEqual(rays.shape, (B, N, 3, H, W))

    def test_pointcloud_unprojection(self):
        from tools.depthbox.model.depthbox_module import DepthBoxModel

        # Depth 5.0m along forward ray (0, 0, 1)
        depth = torch.full((1, 1, 10, 10), 5.0)
        rays = torch.zeros((1, 3, 10, 10))
        rays[:, 2, :, :] = 1.0 # unit z

        points = DepthBoxModel.unproject_to_pointcloud(depth, rays)
        self.assertEqual(points.shape, (1, 3, 10, 10))
        self.assertTrue(torch.allclose(points[:, 2, :, :], torch.full((1, 10, 10), 5.0)))
        self.assertTrue(torch.allclose(points[:, 0, :, :], torch.zeros((1, 10, 10))))

    def test_loss_backward_gradient_flow(self):
        from tools.depthbox.model.depthbox_module import DepthBoxModel, DepthBoxLoss

        model = DepthBoxModel(backbone_name="dinov2_vits14_reg", pretrained_backbone=False)
        model.train()
        criterion = DepthBoxLoss()

        B, H, W = 1, 140, 140
        images = torch.randn(B, 3, H, W, requires_grad=True)
        depth_gt = torch.full((B, 1, H, W), 4.0)
        ray_gt = torch.zeros((B, 3, H, W))
        ray_gt[:, 2, :, :] = 1.0

        depth_pred, ray_pred = model(images)
        loss_dict = criterion(depth_pred, depth_gt, ray_pred, ray_gt)
        total_loss = loss_dict["total_loss"]

        total_loss.backward()

        # Verify gradients exist in dual heads
        self.assertIsNotNone(model.dual_head.depth_head[-1].weight.grad)
        self.assertIsNotNone(model.dual_head.ray_head[-1].weight.grad)


if __name__ == "__main__":
    unittest.main()
