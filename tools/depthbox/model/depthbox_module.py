# Copyright (C) 2026 Scratchbox LLC. All rights reserved.
# Proprietary and confidential. Unauthorized copying is strictly prohibited.

"""
Unified DepthBox Module (Depth Anything 3 Logic).
Integrates DINOv2 backbone, input-adaptive cross-view attention, dual-DPT heads,
and geometric supervision losses for urban/geospatial depth-ray prediction.
"""

from typing import Tuple, Dict, Optional, List
import math
import torch
import torch.nn as nn
import torch.nn.functional as F

from .da3_backbone import DINOv2FeatureExtractor
from .cross_view_attention import CrossViewAttentionBlock, CameraPoseEncoder
from .dual_dpt_head import DualDPTHead


class DepthBoxLoss(nn.Module):
    """
    Combined Geometric Loss for DepthBox:
    1. Scale-Invariant Logarithmic (SILog) Depth Loss
    2. Ray Cosine Angular Error Loss
    3. Multi-Scale Depth Gradient Sharpness Loss
    """
    def __init__(
        self,
        silog_lambda: float = 0.85,
        ray_weight: float = 1.0,
        grad_weight: float = 0.5,
        eps: float = 1e-6
    ):
        super().__init__()
        self.silog_lambda = silog_lambda
        self.ray_weight = ray_weight
        self.grad_weight = grad_weight
        self.eps = eps

    def forward(
        self,
        depth_pred: torch.Tensor,
        depth_gt: torch.Tensor,
        ray_pred: torch.Tensor,
        ray_gt: torch.Tensor,
        valid_mask: Optional[torch.Tensor] = None
    ) -> Dict[str, torch.Tensor]:
        """
        depth_pred, depth_gt: (B, 1, H, W) in meters
        ray_pred, ray_gt: (B, 3, H, W) unit direction vectors
        valid_mask: (B, 1, H, W) boolean/float mask where 1 = valid ground truth
        """
        if valid_mask is None:
            valid_mask = (depth_gt > 0.1) & (depth_gt < 500.0)
        else:
            valid_mask = valid_mask & (depth_gt > 0.1)

        mask = valid_mask.float()
        num_valid = torch.clamp(mask.sum(), min=1.0)

        # 1. SILog Loss
        log_pred = torch.log(torch.clamp(depth_pred, min=self.eps))
        log_gt = torch.log(torch.clamp(depth_gt, min=self.eps))
        diff = (log_pred - log_gt) * mask

        diff_sq_mean = (diff ** 2).sum() / num_valid
        diff_mean = diff.sum() / num_valid
        silog_loss = torch.sqrt(torch.clamp(diff_sq_mean - self.silog_lambda * (diff_mean ** 2), min=self.eps))

        # 2. Ray Cosine Loss: 1 - <r_pred, r_gt>
        cos_sim = (ray_pred * ray_gt).sum(dim=1, keepdim=True)
        cos_sim = torch.clamp(cos_sim, -1.0, 1.0)
        ray_loss = ((1.0 - cos_sim) * mask).sum() / num_valid

        # 3. Depth Gradient Sharpness Loss
        diff_x = torch.abs(log_pred[:, :, :, :-1] - log_pred[:, :, :, 1:]) - \
                 torch.abs(log_gt[:, :, :, :-1] - log_gt[:, :, :, 1:])
        diff_y = torch.abs(log_pred[:, :, :-1, :] - log_pred[:, :, 1:, :]) - \
                 torch.abs(log_gt[:, :, :-1, :] - log_gt[:, :, 1:, :])
        mask_x = mask[:, :, :, :-1] * mask[:, :, :, 1:]
        mask_y = mask[:, :, :-1, :] * mask[:, :, 1:, :]
        grad_loss = (torch.abs(diff_x) * mask_x).sum() / torch.clamp(mask_x.sum(), min=1.0) + \
                    (torch.abs(diff_y) * mask_y).sum() / torch.clamp(mask_y.sum(), min=1.0)

        total_loss = silog_loss + self.ray_weight * ray_loss + self.grad_weight * grad_loss

        return {
            "total_loss": total_loss,
            "silog_loss": silog_loss,
            "ray_loss": ray_loss,
            "grad_loss": grad_loss
        }


class DepthBoxModel(nn.Module):
    """
    DepthBox Foundation Model.
    Accepts 1, 2, or N images and predicts pixel-aligned Metric Depth and Ray Field maps.
    """
    def __init__(
        self,
        backbone_name: str = "dinov2_vitb14_reg",
        pretrained_backbone: bool = True,
        min_depth: float = 0.1,
        max_depth: float = 500.0,
        enable_cross_view: bool = True
    ):
        super().__init__()
        self.min_depth = min_depth
        self.max_depth = max_depth
        self.enable_cross_view = enable_cross_view

        # 1. Vision Transformer Backbone
        self.backbone = DINOv2FeatureExtractor(
            model_name=backbone_name,
            pretrained=pretrained_backbone,
            out_indices=(3, 6, 9, 12)
        )
        embed_dim = self.backbone.embed_dim

        # 2. Cross-View Dynamic Attention
        self.cross_attn = CrossViewAttentionBlock(embed_dim=embed_dim)
        self.camera_encoder = CameraPoseEncoder(in_features=16, embed_dim=embed_dim)

        # 3. Dual-DPT Prediction Heads
        self.dual_head = DualDPTHead(
            in_channels=embed_dim,
            features=256,
            min_depth=min_depth,
            max_depth=max_depth
        )

        # 4. Training Loss Criterion
        self.criterion = DepthBoxLoss()

    def forward(
        self,
        images: torch.Tensor,
        camera_poses: Optional[torch.Tensor] = None
    ) -> Tuple[torch.Tensor, torch.Tensor]:
        """
        images: (B, 3, H, W) for single image OR (B, N, 3, H, W) for multi-view sequences
        camera_poses: Optional (B, N, 16) flattened 4x4 camera extrinsics
        Returns:
            depth_map: (B, 1, H, W) or (B, N, 1, H, W)
            ray_map: (B, 3, H, W) or (B, N, 3, H, W)
        """
        has_views_dim = (images.dim() == 5)
        if has_views_dim:
            B, N, C, H, W = images.shape
            images_flat = images.view(B * N, C, H, W)
            num_views = N
        else:
            B, C, H, W = images.shape
            images_flat = images
            num_views = 1

        # 1. Extract multi-scale ViT tokens
        features = self.backbone(images_flat)

        # 2. Cross-View Token Conditioning on late stage (feature index 3)
        if self.enable_cross_view and num_views > 1:
            cam_tokens = self.camera_encoder(camera_poses) if camera_poses is not None else None
            features[3] = self.cross_attn(features[3], num_views=num_views, camera_tokens=cam_tokens)

        # 3. Decode into Depth and Ray maps
        depth_flat, ray_flat = self.dual_head(features, target_size=(H, W))

        if has_views_dim:
            depth = depth_flat.view(B, N, 1, H, W)
            ray = ray_flat.view(B, N, 3, H, W)
        else:
            depth = depth_flat
            ray = ray_flat

        return depth, ray

    @staticmethod
    def unproject_to_pointcloud(
        depth: torch.Tensor,
        ray: torch.Tensor
    ) -> torch.Tensor:
        """
        Unprojects predicted depth and rays to dense 3D points in camera coordinates:
        P(u, v) = d(u, v) * r(u, v)
        depth: (..., 1, H, W)
        ray: (..., 3, H, W)
        Returns: (..., 3, H, W) 3D coordinate pointmap in meters
        """
        return depth * ray
