#!/usr/bin/env python3
"""
Scratchbox IDE - TRELLIS Urban Diffusion Transformer (DiT) & Training Loop
Implements structural flow-matching DiT with dual conditioning:
1. Multi-view visual passes (ortho/perspective) via cross-attention.
2. Google Vector LOD2 CAD scaffold O-Voxels as hard structural priors.
3. Google Vector semantic class embeddings (AdaLN-Zero).
4. Custom geometric loss formulation: Flow Matching + Planar Normal Regularizer + Metric Boundary Penalty.
"""

import os
import sys
import math
import argparse
import torch
import torch.nn as nn
import torch.nn.functional as F

class AdaLNBlock(nn.Module):
    """Adaptive Layer Normalization (AdaLN-Zero) for condition injection."""
    def __init__(self, hidden_dim: int, cond_dim: int):
        super().__init__()
        self.norm = nn.LayerNorm(hidden_dim, elementwise_affine=False, eps=1e-6)
        self.linear = nn.Linear(cond_dim, 6 * hidden_dim, bias=True)
        # Initialize zero for residual identity
        nn.init.zeros_(self.linear.weight)
        nn.init.zeros_(self.linear.bias)

    def forward(self, x: torch.Tensor, c: torch.Tensor):
        scale_shift = self.linear(c).unsqueeze(1)
        gamma1, beta1, alpha1, gamma2, beta2, alpha2 = scale_shift.chunk(6, dim=-1)
        x_norm = self.norm(x) * (1 + gamma1) + beta1
        return x_norm, alpha1, gamma2, beta2, alpha2

class MultiHeadCrossAttention(nn.Module):
    """Cross-attention over multi-view visual conditioning tokens."""
    def __init__(self, hidden_dim: int, num_heads: int = 8):
        super().__init__()
        self.num_heads = num_heads
        self.head_dim = hidden_dim // num_heads
        self.scale = 1.0 / math.sqrt(self.head_dim)
        
        self.q = nn.Linear(hidden_dim, hidden_dim, bias=False)
        self.k = nn.Linear(hidden_dim, hidden_dim, bias=False)
        self.v = nn.Linear(hidden_dim, hidden_dim, bias=False)
        self.out = nn.Linear(hidden_dim, hidden_dim, bias=False)

    def forward(self, x: torch.Tensor, context: torch.Tensor):
        B, N, C = x.shape
        _, M, _ = context.shape
        
        q = self.q(x).reshape(B, N, self.num_heads, self.head_dim).permute(0, 2, 1, 3)
        k = self.k(context).reshape(B, M, self.num_heads, self.head_dim).permute(0, 2, 1, 3)
        v = self.v(context).reshape(B, M, self.num_heads, self.head_dim).permute(0, 2, 1, 3)
        
        attn = torch.matmul(q, k.transpose(-2, -1)) * self.scale
        attn = F.softmax(attn, dim=-1)
        
        out = torch.matmul(attn, v).permute(0, 2, 1, 3).reshape(B, N, C)
        return self.out(out)

class TrellisUrbanDiTBlock(nn.Module):
    """Core Transformer block combining Self-Attention, Cross-Attention & AdaLN-Zero."""
    def __init__(self, hidden_dim: int, num_heads: int, cond_dim: int):
        super().__init__()
        self.adaln = AdaLNBlock(hidden_dim, cond_dim)
        self.self_attn = nn.MultiheadAttention(hidden_dim, num_heads, batch_first=True)
        self.cross_attn = MultiHeadCrossAttention(hidden_dim, num_heads)
        self.mlp = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim * 4),
            nn.GELU(approximate="tanh"),
            nn.Linear(hidden_dim * 4, hidden_dim)
        )

    def forward(self, x: torch.Tensor, c: torch.Tensor, visual_ctx: torch.Tensor):
        x_norm, alpha1, gamma2, beta2, alpha2 = self.adaln(x, c)
        
        # 1. Spatial Self-Attention (token-to-token across O-Voxel space)
        sa_out, _ = self.self_attn(x_norm, x_norm, x_norm)
        x = x + alpha1 * sa_out
        
        # 2. Cross-Attention to multi-view camera projections
        ca_out = self.cross_attn(x, visual_ctx)
        x = x + ca_out
        
        # 3. Feedforward with AdaLN modulation
        mlp_norm = F.layer_norm(x, (x.shape[-1],)) * (1 + gamma2) + beta2
        x = x + alpha2 * self.mlp(mlp_norm)
        return x

class TrellisUrbanRemeshDiT(nn.Module):
    """
    Trellis 4B Urban Diffusion Transformer for Google 3D Tile Remeshing.
    """
    def __init__(
        self,
        in_channels: int = 16, # O-Voxel feature dimension (geometry + normal + PBR)
        out_channels: int = 16,
        hidden_dim: int = 1024,
        depth: int = 24,
        num_heads: int = 16,
        num_classes: int = 32
    ):
        super().__init__()
        self.in_proj = nn.Linear(in_channels * 2, hidden_dim) # token concat: noisy + scaffold
        self.time_embed = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim),
            nn.SiLU(),
            nn.Linear(hidden_dim, hidden_dim)
        )
        self.class_embed = nn.Embedding(num_classes, hidden_dim)
        
        self.blocks = nn.ModuleList([
            TrellisUrbanDiTBlock(hidden_dim, num_heads, hidden_dim)
            for _ in range(depth)
        ])
        
        self.final_norm = nn.LayerNorm(hidden_dim)
        self.out_proj = nn.Linear(hidden_dim, out_channels)
        nn.init.zeros_(self.out_proj.weight)
        nn.init.zeros_(self.out_proj.bias)

    def forward(self, x_t: torch.Tensor, t: torch.Tensor, scaffold: torch.Tensor, visual_ctx: torch.Tensor, class_id: torch.Tensor):
        """
        x_t: [B, N, C] noisy O-Voxel latents at timestep t
        t: [B] diffusion timestep in [0, 1]
        scaffold: [B, N, C] LOD2 CAD scaffold O-Voxel tokens
        visual_ctx: [B, M, C] multi-view visual tokens
        class_id: [B] Google Vector classification index
        """
        # Concat noisy latent with structural scaffold condition
        x = torch.cat([x_t, scaffold], dim=-1)
        x = self.in_proj(x)
        
        # Timestep Fourier embedding
        half = x.shape[-1] // 2
        freqs = torch.exp(-math.log(10000) * torch.arange(start=0, end=half, dtype=torch.float32, device=t.device) / half)
        args = t[:, None].float() * freqs[None]
        t_emb = torch.cat([torch.cos(args), torch.sin(args)], dim=-1)
        t_emb = self.time_embed(t_emb)
        
        # Combine timestep and Google Vector class embedding
        c = t_emb + self.class_embed(class_id)
        
        for block in self.blocks:
            x = block(x, c, visual_ctx)
            
        x = self.final_norm(x)
        velocity = self.out_proj(x)
        return velocity

def compute_urban_loss(
    v_pred: torch.Tensor,
    v_target: torch.Tensor,
    decoded_normals: torch.Tensor,
    cad_normals: torch.Tensor,
    displacement_norm: torch.Tensor,
    max_bound_m: float = 0.15,
    lambda_planar: float = 0.2,
    lambda_bound: float = 0.5
):
    """
    Computes Flow Matching Velocity Loss + Planar Normal Loss + Metric Boundary Penalty.
    """
    # 1. Standard Flow Matching Velocity Loss
    l_flow = F.mse_loss(v_pred, v_target)
    
    # 2. Planar Normal Regularizer (Forces exterior facade normals to snap to CAD azimuth)
    dot_prod = torch.sum(decoded_normals * cad_normals, dim=-1)
    l_planar = torch.mean((1.0 - dot_prod) ** 2)
    
    # 3. Metric Boundary Penalty (Penalizes hallucinations exceeding 15cm from photogrammetry)
    excess_drift = F.relu(displacement_norm - max_bound_m)
    l_bound = torch.mean(excess_drift ** 2)
    
    total_loss = l_flow + (lambda_planar * l_planar) + (lambda_bound * l_bound)
    return total_loss, {"loss_flow": l_flow.item(), "loss_planar": l_planar.item(), "loss_bound": l_bound.item()}

if __name__ == "__main__":
    print("[TRELLIS Urban DiT] Instantiating test model on CUDA/CPU...")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = TrellisUrbanRemeshDiT(in_channels=16, out_channels=16, hidden_dim=256, depth=4, num_heads=4).to(device)
    
    # Dummy forward pass
    B, N, C = 2, 512, 16
    x_t = torch.randn(B, N, C, device=device)
    t = torch.rand(B, device=device)
    scaffold = torch.randn(B, N, C, device=device)
    visual_ctx = torch.randn(B, 64, 256, device=device)
    class_id = torch.zeros(B, dtype=torch.long, device=device)
    
    v_pred = model(x_t, t, scaffold, visual_ctx, class_id)
    print(f"[TRELLIS Urban DiT] Forward pass successful: output shape = {v_pred.shape}")
