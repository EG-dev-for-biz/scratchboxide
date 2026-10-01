# Copyright (C) 2026 Scratchbox LLC. All rights reserved.
# Proprietary and confidential. Unauthorized copying is strictly prohibited.


"""
Multi-Resolution Spherical Hash Grid Location Encoder for GeoBox.
Maps continuous geodetic coordinates (Lat, Lng) to multi-scale spherical hash embeddings
projected into the multimodal vision-language latent space.
"""

import math
import torch
import torch.nn as nn
import torch.nn.functional as F

class SphericalHashGrid(nn.Module):
    """
    Multi-resolution hash grid defined over the unit sphere S^2.
    Overcomes spectral bias and enables simultaneous representation of
    macro-continental biomes (500km) and micro-urban spatial features (25m).
    """
    def __init__(
        self,
        num_levels: int = 16,
        features_per_level: int = 4,
        log2_hashmap_size: int = 15,  # 32,768 entries per level
        min_resolution: float = 4.0,   # ~500 km scale
        max_resolution: float = 2048.0 # ~25 m scale
    ):
        super().__init__()
        self.num_levels = num_levels
        self.features_per_level = features_per_level
        self.hashmap_size = 1 << log2_hashmap_size
        self.min_resolution = min_resolution
        self.max_resolution = max_resolution

        # Compute geometric progression ratio b for scale resolution
        self.b = math.exp((math.log(max_resolution) - math.log(min_resolution)) / max(num_levels - 1, 1))

        # Spatial hash prime coefficients (large coprime integers)
        self.register_buffer("primes", torch.tensor([1, 2654435761, 805459861], dtype=torch.int64), persistent=False)

        # Multi-level embedding tables
        self.embeddings = nn.ModuleList([
            nn.Embedding(self.hashmap_size, features_per_level)
            for _ in range(num_levels)
        ])

        # Initialize embeddings with small uniform variance
        for emb in self.embeddings:
            nn.init.uniform_(emb.weight, -1e-4, 1e-4)

    def _hash(self, coords_int: torch.Tensor) -> torch.Tensor:
        """
        Fast spatial hash: ((x * p1) ^ (y * p2) ^ (z * p3)) % hashmap_size
        coords_int: (B, 8, 3) int64 tensor of corner indices
        """
        h = (coords_int[..., 0] * self.primes[0]) ^ \
            (coords_int[..., 1] * self.primes[1]) ^ \
            (coords_int[..., 2] * self.primes[2])
        return torch.remainder(h, self.hashmap_size)

    def forward(self, cartesian_coords: torch.Tensor) -> torch.Tensor:
        """
        cartesian_coords: (B, 3) unit vector on sphere S^2, values in [-1, 1]
        Returns: (B, num_levels * features_per_level) interpolated features
        """
        # Normalize to [0, 1] range: p = (x + 1) * 0.5
        norm_coords = (cartesian_coords + 1.0) * 0.5
        B = norm_coords.shape[0]
        level_features = []

        for lvl in range(self.num_levels):
            scale = self.min_resolution * (self.b ** lvl)
            scaled_p = norm_coords * scale

            # Continuous floor and ceil corners
            p0 = torch.floor(scaled_p).to(torch.int64)
            p1 = p0 + 1
            f = (scaled_p - p0.to(scaled_p.dtype)) # weights in [0, 1]

            # 8 corners of the 3D voxel
            c000 = p0
            c100 = torch.stack([p1[..., 0], p0[..., 1], p0[..., 2]], dim=-1)
            c010 = torch.stack([p0[..., 0], p1[..., 1], p0[..., 2]], dim=-1)
            c110 = torch.stack([p1[..., 0], p1[..., 1], p0[..., 2]], dim=-1)
            c001 = torch.stack([p0[..., 0], p0[..., 1], p1[..., 2]], dim=-1)
            c101 = torch.stack([p1[..., 0], p0[..., 1], p1[..., 2]], dim=-1)
            c011 = torch.stack([p0[..., 0], p1[..., 1], p1[..., 2]], dim=-1)
            c111 = p1

            corners = torch.stack([c000, c100, c010, c110, c001, c101, c011, c111], dim=1) # (B, 8, 3)
            corner_hashes = self._hash(corners) # (B, 8)

            # Lookup embedding features for all 8 corners: (B, 8, F)
            corner_feats = self.embeddings[lvl](corner_hashes)

            # Trilinear weights
            wx = f[..., 0:1] # (B, 1)
            wy = f[..., 1:2]
            wz = f[..., 2:3]

            w000 = (1.0 - wx) * (1.0 - wy) * (1.0 - wz)
            w100 = wx * (1.0 - wy) * (1.0 - wz)
            w010 = (1.0 - wx) * wy * (1.0 - wz)
            w110 = wx * wy * (1.0 - wz)
            w001 = (1.0 - wx) * (1.0 - wy) * wz
            w101 = wx * (1.0 - wy) * wz
            w011 = (1.0 - wx) * wy * wz
            w111 = wx * wy * wz

            weights = torch.stack([w000, w100, w010, w110, w001, w101, w011, w111], dim=1) # (B, 8, 1)

            # Interpolated feature for this level: (B, F)
            interpolated = torch.sum(corner_feats * weights, dim=1)
            level_features.append(interpolated)

        return torch.cat(level_features, dim=-1) # (B, num_levels * features_per_level)


class RandomFourierFeatures(nn.Module):
    """
    Random Fourier Feature positional encoder for spherical coordinates.
    Provides smooth global spectral continuity across coordinate boundaries.
    """
    def __init__(self, in_features: int = 3, num_frequencies: int = 64, scale: float = 16.0):
        super().__init__()
        self.num_frequencies = num_frequencies
        B = torch.randn(num_frequencies, in_features) * scale
        self.register_buffer("B", B)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (B, 3)
        # Projection: (B, num_frequencies)
        proj = 2.0 * math.pi * torch.matmul(x, self.B.t())
        return torch.cat([torch.cos(proj), torch.sin(proj)], dim=-1) # (B, 2 * num_frequencies)


class SphericalHashLocationEncoder(nn.Module):
    """
    Complete GeoBox Location Encoder:
    Combines Spherical Multi-Resolution Hash Grid + Random Fourier Features + Residual MLP.
    Output vector is L2-normalized to lie on the unit hypersphere matching the vision embedding.
    """
    def __init__(
        self,
        output_dim: int = 512,
        num_hash_levels: int = 16,
        features_per_level: int = 4,
        log2_hashmap_size: int = 15,
        num_rff_freqs: int = 64,
        hidden_dim: int = 512
    ):
        super().__init__()
        self.output_dim = output_dim

        # 1. Multi-scale feature extractors
        self.hash_grid = SphericalHashGrid(
            num_levels=num_hash_levels,
            features_per_level=features_per_level,
            log2_hashmap_size=log2_hashmap_size
        )
        self.rff = RandomFourierFeatures(
            in_features=3,
            num_frequencies=num_rff_freqs,
            scale=16.0
        )

        in_dim = (num_hash_levels * features_per_level) + (2 * num_rff_freqs) + 3 # hash + rff + raw xyz

        # 2. Residual Projection MLP
        self.input_layer = nn.Sequential(
            nn.Linear(in_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.GELU()
        )

        self.res_block1 = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.GELU(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.LayerNorm(hidden_dim)
        )

        self.res_block2 = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.GELU(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.LayerNorm(hidden_dim)
        )

        self.out_proj = nn.Linear(hidden_dim, output_dim)

    @staticmethod
    def geodetic_to_cartesian(coords_deg: torch.Tensor) -> torch.Tensor:
        """
        Converts (lat, lng) in degrees to 3D Cartesian coordinates on unit sphere S^2.
        coords_deg: (B, 2) [latitude, longitude] in degrees
        Returns: (B, 3) [x, y, z] unit vectors
        """
        lat_rad = coords_deg[:, 0] * (math.pi / 180.0)
        lng_rad = coords_deg[:, 1] * (math.pi / 180.0)

        cos_lat = torch.cos(lat_rad)
        sin_lat = torch.sin(lat_rad)
        cos_lng = torch.cos(lng_rad)
        sin_lng = torch.sin(lng_rad)

        x = cos_lat * cos_lng
        y = cos_lat * sin_lng
        z = sin_lat

        return torch.stack([x, y, z], dim=-1)

    def forward(self, coords_deg: torch.Tensor) -> torch.Tensor:
        """
        coords_deg: (B, 2) tensor of [lat, lng] in degrees.
        Returns: (B, output_dim) L2-normalized geographic embedding.
        """
        # Convert to unit sphere
        xyz = self.geodetic_to_cartesian(coords_deg)

        # Extract multi-resolution features
        hash_feat = self.hash_grid(xyz)
        rff_feat = self.rff(xyz)

        # Concatenate inputs
        x = torch.cat([hash_feat, rff_feat, xyz], dim=-1)

        # Forward through residual MLP
        h = self.input_layer(x)
        h = F.gelu(h + self.res_block1(h))
        h = F.gelu(h + self.res_block2(h))
        out = self.out_proj(h)

        # L2-normalize
        return F.normalize(out, p=2, dim=-1)
