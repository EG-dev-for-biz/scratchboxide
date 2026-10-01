# Copyright (C) 2026 Scratchbox LLC. All rights reserved.
# Proprietary and confidential. Unauthorized copying is strictly prohibited.

"""
Input-Adaptive Cross-View Attention Module for DepthBox (Depth Anything 3 Logic).
Allows seamless dynamic token exchange across an arbitrary number of input views (N >= 1).
"""

from typing import Optional
import torch
import torch.nn as nn
import torch.nn.functional as F


class CameraPoseEncoder(nn.Module):
    """
    Encodes 6-DOF camera pose and pinhole intrinsics into camera embedding tokens.
    Input: (B, N, 16) 4x4 camera extrinsics or 7-dim pose [tx, ty, tz, qx, qy, qz, qw] + [fx, fy, cx, cy]
    Output: (B, N, embed_dim) camera conditioning tokens
    """
    def __init__(self, in_features: int = 16, embed_dim: int = 768):
        super().__init__()
        self.mlp = nn.Sequential(
            nn.Linear(in_features, embed_dim // 2),
            nn.GELU(),
            nn.Linear(embed_dim // 2, embed_dim),
            nn.LayerNorm(embed_dim)
        )

    def forward(self, camera_meta: torch.Tensor) -> torch.Tensor:
        return self.mlp(camera_meta)


class CrossViewAttentionBlock(nn.Module):
    """
    Cross-View Attention Block.
    Performs within-view self-attention when N=1, and joint cross-view self-attention when N > 1.
    """
    def __init__(
        self,
        embed_dim: int = 768,
        num_heads: int = 12,
        mlp_ratio: float = 4.0,
        dropout: float = 0.0
    ):
        super().__init__()
        self.embed_dim = embed_dim
        self.num_heads = num_heads
        self.norm1 = nn.LayerNorm(embed_dim)
        self.attn = nn.MultiheadAttention(
            embed_dim,
            num_heads,
            dropout=dropout,
            batch_first=True
        )
        self.norm2 = nn.LayerNorm(embed_dim)
        mlp_hidden_dim = int(embed_dim * mlp_ratio)
        self.mlp = nn.Sequential(
            nn.Linear(embed_dim, mlp_hidden_dim),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(mlp_hidden_dim, embed_dim),
            nn.Dropout(dropout)
        )

    def forward(
        self,
        x: torch.Tensor,
        num_views: int = 1,
        camera_tokens: Optional[torch.Tensor] = None
    ) -> torch.Tensor:
        """
        x: (B * N, C, H, W) spatial feature maps from backbone
        num_views: N views per batch element
        camera_tokens: Optional (B, N, C) pose embeddings
        Returns: (B * N, C, H, W) cross-view conditioned spatial feature maps
        """
        BN, C, H, W = x.shape
        B = BN // num_views
        P = H * W # tokens per view

        # Reshape to (B, N, P, C)
        x_flat = x.flatten(2).transpose(1, 2) # (BN, P, C)
        x_views = x_flat.view(B, num_views, P, C)

        if num_views == 1:
            # Single-view within-image spatial self-attention
            h = self.norm1(x_flat)
            attn_out, _ = self.attn(h, h, h)
            x_flat = x_flat + attn_out
            x_flat = x_flat + self.mlp(self.norm2(x_flat))
            return x_flat.transpose(1, 2).view(BN, C, H, W)

        # Multi-view: Flatten across views (B, N * P, C)
        if camera_tokens is not None:
            # Prepend 1 camera token per view: (B, N, 1 + P, C)
            cam = camera_tokens.unsqueeze(2) # (B, N, 1, C)
            x_with_cam = torch.cat([cam, x_views], dim=2)
            total_tokens = num_views * (P + 1)
            x_cross = x_with_cam.view(B, total_tokens, C)

            h = self.norm1(x_cross)
            attn_out, _ = self.attn(h, h, h)
            x_cross = x_cross + attn_out
            x_cross = x_cross + self.mlp(self.norm2(x_cross))

            # Reshape back and discard camera tokens
            x_views_out = x_cross.view(B, num_views, P + 1, C)[:, :, 1:, :]
            x_out = x_views_out.reshape(BN, P, C)
        else:
            x_cross = x_views.reshape(B, num_views * P, C)
            h = self.norm1(x_cross)
            attn_out, _ = self.attn(h, h, h)
            x_cross = x_cross + attn_out
            x_cross = x_cross + self.mlp(self.norm2(x_cross))
            x_out = x_cross.reshape(BN, P, C)

        return x_out.transpose(1, 2).view(BN, C, H, W)
