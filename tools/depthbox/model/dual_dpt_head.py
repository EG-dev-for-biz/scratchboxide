# Copyright (C) 2026 Scratchbox IDE.
# SPDX-License-Identifier: MIT

"""
Dual-DPT (Dense Prediction Transformer) Head for DepthBox (Depth Anything 3 Logic).
Shared multi-scale feature reassembly with twin progressive fusion branches:
1. Exponential Depth Head: d(u, v) = exp(y)
2. Directional Ray Head: r_hat(u, v) in S^2
"""

from typing import List, Tuple
import torch
import torch.nn as nn
import torch.nn.functional as F


class ResidualConvUnit(nn.Module):
    """
    Residual Convolutional Unit (RCU) for DPT feature refinement.
    """
    def __init__(self, channels: int):
        super().__init__()
        self.conv1 = nn.Conv2d(channels, channels, kernel_size=3, padding=1, bias=False)
        self.bn1 = nn.BatchNorm2d(channels)
        self.relu = nn.ReLU(inplace=True)
        self.conv2 = nn.Conv2d(channels, channels, kernel_size=3, padding=1, bias=False)
        self.bn2 = nn.BatchNorm2d(channels)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        res = x
        out = self.relu(self.bn1(self.conv1(x)))
        out = self.bn2(self.conv2(out))
        return self.relu(out + res)


class FeatureFusionBlock(nn.Module):
    """
    Progressive top-down fusion block combining high-level semantics with low-level details.
    """
    def __init__(self, channels: int):
        super().__init__()
        self.rcu1 = ResidualConvUnit(channels)
        self.rcu2 = ResidualConvUnit(channels)

    def forward(self, x: torch.Tensor, skip: torch.Tensor = None) -> torch.Tensor:
        if skip is not None:
            # Upsample previous layer to match skip connection size
            x = F.interpolate(x, size=skip.shape[2:], mode="bilinear", align_corners=False)
            x = x + self.rcu1(skip)
        return self.rcu2(x)


class DualDPTHead(nn.Module):
    """
    Dual-DPT Head:
    Reassembles 4 transformer feature maps into progressive spatial resolutions,
    then fuses them separately for Metric Depth and Ray Field outputs.
    """
    def __init__(
        self,
        in_channels: int = 768,
        features: int = 256,
        out_channels_depth: int = 1,
        out_channels_ray: int = 3,
        min_depth: float = 0.1,
        max_depth: float = 500.0
    ):
        super().__init__()
        self.min_depth = min_depth
        self.max_depth = max_depth

        # 1. Feature Reassembly Projectors (Layer 1..4)
        self.projectors = nn.ModuleList([
            nn.Sequential(
                nn.Conv2d(in_channels, features, kernel_size=1),
                nn.ConvTranspose2d(features, features, kernel_size=4, stride=4, padding=0) # 4x up
            ),
            nn.Sequential(
                nn.Conv2d(in_channels, features, kernel_size=1),
                nn.ConvTranspose2d(features, features, kernel_size=2, stride=2, padding=0) # 2x up
            ),
            nn.Sequential(
                nn.Conv2d(in_channels, features, kernel_size=1) # 1x identity
            ),
            nn.Sequential(
                nn.Conv2d(in_channels, features, kernel_size=1),
                nn.MaxPool2d(kernel_size=2, stride=2) # 0.5x down
            )
        ])

        # 2. Depth Fusion Branch
        self.depth_fusion1 = FeatureFusionBlock(features)
        self.depth_fusion2 = FeatureFusionBlock(features)
        self.depth_fusion3 = FeatureFusionBlock(features)
        self.depth_fusion4 = FeatureFusionBlock(features)
        self.depth_head = nn.Sequential(
            nn.Conv2d(features, features // 2, kernel_size=3, padding=1),
            nn.Upsample(scale_factor=2, mode="bilinear", align_corners=False),
            nn.ReLU(inplace=True),
            nn.Conv2d(features // 2, 32, kernel_size=3, padding=1),
            nn.ReLU(inplace=True),
            nn.Conv2d(32, out_channels_depth, kernel_size=1)
        )

        # 3. Ray Direction Fusion Branch
        self.ray_fusion1 = FeatureFusionBlock(features)
        self.ray_fusion2 = FeatureFusionBlock(features)
        self.ray_fusion3 = FeatureFusionBlock(features)
        self.ray_fusion4 = FeatureFusionBlock(features)
        self.ray_head = nn.Sequential(
            nn.Conv2d(features, features // 2, kernel_size=3, padding=1),
            nn.Upsample(scale_factor=2, mode="bilinear", align_corners=False),
            nn.ReLU(inplace=True),
            nn.Conv2d(features // 2, 32, kernel_size=3, padding=1),
            nn.ReLU(inplace=True),
            nn.Conv2d(32, out_channels_ray, kernel_size=1)
        )

    def forward(
        self,
        features: List[torch.Tensor],
        target_size: Tuple[int, int]
    ) -> Tuple[torch.Tensor, torch.Tensor]:
        """
        features: 4 feature maps [L3, L6, L9, L12] of shape (B, embed_dim, H_p, W_p)
        target_size: (H_target, W_target)
        Returns:
            depth_map: (B, 1, H, W) in metric meters [min_depth, max_depth]
            ray_map: (B, 3, H, W) unit-normalized direction vectors in S^2
        """
        # Step 1: Reassemble multi-scale tokens
        p1 = self.projectors[0](features[0])
        p2 = self.projectors[1](features[1])
        p3 = self.projectors[2](features[2])
        p4 = self.projectors[3](features[3])

        # Step 2: Progressive Depth Fusion (top-down from p4 to p1)
        d_out = self.depth_fusion4(p4)
        d_out = self.depth_fusion3(d_out, p3)
        d_out = self.depth_fusion2(d_out, p2)
        d_out = self.depth_fusion1(d_out, p1)
        raw_depth_logits = self.depth_head(d_out)
        raw_depth_logits = F.interpolate(raw_depth_logits, size=target_size, mode="bilinear", align_corners=False)

        # Exponential depth decoding: d = exp(y), clamped to physical ranges
        # Softplus / exp ensures strictly positive depth
        depth_meters = torch.clamp(torch.exp(raw_depth_logits), min=self.min_depth, max=self.max_depth)

        # Step 3: Progressive Ray Fusion (top-down from p4 to p1)
        r_out = self.ray_fusion4(p4)
        r_out = self.ray_fusion3(r_out, p3)
        r_out = self.ray_fusion2(r_out, p2)
        r_out = self.ray_fusion1(r_out, p1)
        raw_ray_logits = self.ray_head(r_out)
        raw_ray_logits = F.interpolate(raw_ray_logits, size=target_size, mode="bilinear", align_corners=False)

        # Normalize rays to unit vectors in S^2: ||r|| = 1
        ray_map = F.normalize(raw_ray_logits, p=2, dim=1, eps=1e-6)

        return depth_meters, ray_map
