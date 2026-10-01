# Copyright (C) 2026 Scratchbox LLC. All rights reserved.
# Proprietary and confidential. Unauthorized copying is strictly prohibited.


"""
GeoBox Core Module:
Tri-modal Alignment (Vision, Location, Geo-Text) with Soft-Geodesic Haversine Contrastive Loss.
"""

import math
from typing import Optional, Dict, Tuple
import torch
import torch.nn as nn
import torch.nn.functional as F

from .spherical_hash_encoder import SphericalHashLocationEncoder

EARTH_RADIUS_KM = 6371.0088

class SoftHaversineLoss(nn.Module):
    """
    Soft-Geodesic Haversine Contrastive Loss.
    Replaces rigid binary positives/negatives with smooth distance-weighted targets.
    Prevents penalizing nearby coordinates (e.g. 10km away in the same city).
    """
    def __init__(self, sigma_km: float = 25.0):
        super().__init__()
        self.sigma_km = sigma_km

    @staticmethod
    def haversine_pairwise(coords_a: torch.Tensor, coords_b: torch.Tensor) -> torch.Tensor:
        """
        Computes pairwise Haversine distances in kilometers.
        coords_a: (N, 2) [lat, lng] in degrees
        coords_b: (M, 2) [lat, lng] in degrees
        Returns: (N, M) distance matrix in km
        """
        lat1 = coords_a[:, 0:1] * (math.pi / 180.0) # (N, 1)
        lng1 = coords_a[:, 1:2] * (math.pi / 180.0)

        lat2 = coords_b[:, 0:1].t() * (math.pi / 180.0) # (1, M)
        lng2 = coords_b[:, 1:2].t() * (math.pi / 180.0)

        dlat = lat2 - lat1
        dlng = lng2 - lng1

        a = torch.sin(dlat * 0.5) ** 2 + torch.cos(lat1) * torch.cos(lat2) * (torch.sin(dlng * 0.5) ** 2)
        c = 2.0 * torch.asin(torch.clamp(torch.sqrt(torch.clamp(a, min=0.0, max=1.0)), min=0.0, max=1.0))

        return c * EARTH_RADIUS_KM

    def forward(self, logits: torch.Tensor, coords: torch.Tensor) -> torch.Tensor:
        """
        logits: (B, B) scaled cosine similarity matrix (e.g. z_img @ z_loc.T / tau)
        coords: (B, 2) ground-truth [lat, lng] in degrees for each item in the batch
        Returns: scalar cross-entropy loss against soft distance targets
        """
        dist_km = self.haversine_pairwise(coords, coords) # (B, B)

        # Gaussian distance decay kernel
        weights = torch.exp(- (dist_km ** 2) / (2.0 * (self.sigma_km ** 2))) # (B, B)

        # Normalize target distributions
        target_prob = weights / torch.sum(weights, dim=-1, keepdim=True)

        # Log softmax of predicted similarities
        log_prob = F.log_softmax(logits, dim=-1)

        # Kullback-Leibler / Cross-Entropy
        loss = - torch.sum(target_prob * log_prob, dim=-1).mean()
        return loss


class GeoBoxModel(nn.Module):
    """
    GeoBox Tri-Modal Model:
    Alongs vision, multi-resolution spherical location, and semantic geographic text.
    """
    def __init__(
        self,
        embed_dim: int = 512,
        vision_model_name: str = "google/siglip-base-patch16-224",
        pretrained_vision: bool = True,
        sigma_km: float = 25.0,
        init_temperature: float = 0.07,
        num_hash_levels: int = 16
    ):
        super().__init__()
        self.embed_dim = embed_dim

        # 1. Location Encoder
        self.location_encoder = SphericalHashLocationEncoder(
            output_dim=embed_dim,
            num_hash_levels=num_hash_levels,
            features_per_level=4,
            log2_hashmap_size=15,
            num_rff_freqs=64,
            hidden_dim=512
        )

        # 2. Vision & Text Backbones (Lazy / Dynamic loader to allow running with or without transformers)
        self.vision_model_name = vision_model_name
        self.pretrained_vision = pretrained_vision
        self.vision_encoder = None
        self.text_encoder = None
        self._init_vision_text_backbone()

        # 3. Learnable logit temperature scale
        self.logit_scale = nn.Parameter(torch.ones([]) * math.log(1.0 / init_temperature))

        # 4. Soft Loss Criterion
        self.haversine_criterion = SoftHaversineLoss(sigma_km=sigma_km)

    def _init_vision_text_backbone(self):
        """
        Initializes SigLIP or fallback vision projection head.
        """
        try:
            from transformers import AutoModel
            model = AutoModel.from_pretrained(self.vision_model_name)
            self.vision_encoder = model.vision_model
            self.text_encoder = model.text_model

            # Projections to shared embed_dim if dimensions differ
            vision_dim = model.config.vision_config.hidden_size
            text_dim = model.config.text_config.hidden_size

            self.vision_proj = nn.Linear(vision_dim, self.embed_dim, bias=False) if vision_dim != self.embed_dim else nn.Identity()
            self.text_proj = nn.Linear(text_dim, self.embed_dim, bias=False) if text_dim != self.embed_dim else nn.Identity()
        except Exception:
            # Fallback lightweight linear probe / dummy vision encoder for testing without HuggingFace cache
            self.vision_proj = nn.Sequential(
                nn.Conv2d(3, 64, kernel_size=7, stride=2, padding=3),
                nn.AdaptiveAvgPool2d((1, 1)),
                nn.Flatten(),
                nn.Linear(64, self.embed_dim)
            )
            self.text_proj = nn.Identity()

    def encode_image(self, images: torch.Tensor) -> torch.Tensor:
        """
        images: (B, 3, H, W) normalized image tensor
        Returns: (B, embed_dim) normalized embedding
        """
        if self.vision_encoder is not None:
            feats = self.vision_encoder(images).pooler_output
            z = self.vision_proj(feats)
        else:
            z = self.vision_proj(images)
        return F.normalize(z, p=2, dim=-1)

    def encode_location(self, coords_deg: torch.Tensor) -> torch.Tensor:
        """
        coords_deg: (B, 2) [latitude, longitude] in degrees
        Returns: (B, embed_dim) normalized embedding
        """
        return self.location_encoder(coords_deg)

    def encode_text(self, input_ids: torch.Tensor, attention_mask: Optional[torch.Tensor] = None) -> torch.Tensor:
        """
        Encodes geographic hierarchical text strings.
        """
        if self.text_encoder is not None:
            feats = self.text_encoder(input_ids=input_ids, attention_mask=attention_mask).pooler_output
            z = self.text_proj(feats)
            return F.normalize(z, p=2, dim=-1)
        return F.normalize(torch.randn(input_ids.shape[0], self.embed_dim, device=input_ids.device), p=2, dim=-1)

    def forward(
        self,
        images: torch.Tensor,
        coords_deg: torch.Tensor,
        text_tokens: Optional[Dict[str, torch.Tensor]] = None
    ) -> Dict[str, torch.Tensor]:
        """
        Joint forward pass computing multi-modal embeddings and soft-geodesic losses.
        """
        z_img = self.encode_image(images)
        z_loc = self.encode_location(coords_deg)

        scale = self.logit_scale.exp()
        logits_img_loc = torch.matmul(z_img, z_loc.t()) * scale
        logits_loc_img = logits_img_loc.t()

        loss_img_loc = self.haversine_criterion(logits_img_loc, coords_deg)
        loss_loc_img = self.haversine_criterion(logits_loc_img, coords_deg)
        loss_main = (loss_img_loc + loss_loc_img) * 0.5

        total_loss = loss_main
        loss_text = torch.tensor(0.0, device=images.device)

        # Optional tri-modal supervision with text hierarchy
        if text_tokens is not None and "input_ids" in text_tokens and self.text_encoder is not None:
            z_txt = self.encode_text(text_tokens["input_ids"], text_tokens.get("attention_mask"))
            logits_loc_txt = torch.matmul(z_loc, z_txt.t()) * scale
            loss_loc_txt = F.cross_entropy(logits_loc_txt, torch.arange(images.shape[0], device=images.device))
            total_loss = total_loss + 0.3 * loss_loc_txt
            loss_text = loss_loc_txt

        return {
            "loss": total_loss,
            "loss_geo": loss_main,
            "loss_text": loss_text,
            "z_img": z_img,
            "z_loc": z_loc,
            "logit_scale": scale
        }

    @torch.no_grad()
    def predict_location(
        self,
        query_image_embed: torch.Tensor,
        gallery_embeds: torch.Tensor,
        gallery_coords: torch.Tensor,
        top_k: int = 5
    ) -> Tuple[torch.Tensor, torch.Tensor]:
        """
        Retrieves top_k nearest geographic coordinates for query image embedding.
        query_image_embed: (B, D) or (D,)
        gallery_embeds: (N, D) precomputed gallery embeddings
        gallery_coords: (N, 2) [lat, lng]
        Returns: (top_k_coords, top_k_similarities)
        """
        if query_image_embed.ndim == 1:
            query_image_embed = query_image_embed.unsqueeze(0)

        # Cosine similarity
        sims = torch.matmul(query_image_embed, gallery_embeds.t()) # (B, N)
        top_vals, top_indices = torch.topk(sims, k=top_k, dim=-1)

        batch_coords = gallery_coords[top_indices] # (B, top_k, 2)
        return batch_coords, top_vals
