# Copyright (C) 2026 Scratchbox LLC. All rights reserved.
# Proprietary and confidential. Unauthorized copying is strictly prohibited.


"""
GeoBox ONNX Export & Global Gallery Generator:
Exports the trained Location Encoder to portable ONNX format and precomputes
the 100,000-point terrestrial location gallery for instant <15ms C++ engine retrieval.
"""

import os
import sys
import json
import math
import argparse
import numpy as np
import torch

# Ensure local module path resolution
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from model.spherical_hash_encoder import SphericalHashLocationEncoder

def generate_fibonacci_sphere_points(n_points: int = 100000) -> np.ndarray:
    """
    Generates n_points uniformly distributed across the Earth sphere using Fibonacci spiral.
    Returns: (n_points, 2) array of [latitude_deg, longitude_deg]
    """
    indices = np.arange(0, n_points, dtype=float) + 0.5
    phi = np.arcsin(1.0 - 2.0 * indices / n_points) # latitude in radians
    golden_ratio = (1.0 + math.sqrt(5.0)) / 2.0
    theta = 2.0 * math.pi * indices / golden_ratio  # longitude in radians

    # Map theta to [-pi, pi]
    theta = (theta + math.pi) % (2.0 * math.pi) - math.pi

    lat_deg = np.rad2deg(phi)
    lng_deg = np.rad2deg(theta)

    return np.stack([lat_deg, lng_deg], axis=-1).astype(np.float32)


def export_location_encoder_onnx(
    encoder: SphericalHashLocationEncoder,
    output_onnx_path: str,
    embed_dim: int = 512
):
    """
    Exports the Location Encoder to ONNX with dynamic batch size.
    """
    encoder.eval()
    dummy_input = torch.tensor([[37.7749, -122.4194], [48.8584, 2.2945]], dtype=torch.float32)

    os.makedirs(os.path.dirname(os.path.abspath(output_onnx_path)), exist_ok=True)

    print(f"📦 [ONNX Exporter] Exporting Location Encoder to: {output_onnx_path}")
    torch.onnx.export(
        encoder,
        dummy_input,
        output_onnx_path,
        export_params=True,
        opset_version=17,
        do_constant_folding=True,
        input_names=["coords_deg"],
        output_names=["location_embedding"],
        dynamic_axes={
            "coords_deg": {0: "batch_size"},
            "location_embedding": {0: "batch_size"}
        }
    )
    print("✅ [ONNX Exporter] Export complete.")


def precompute_global_gallery(
    encoder: SphericalHashLocationEncoder,
    output_bin_path: str,
    output_json_path: str,
    num_points: int = 100000,
    batch_size: int = 2048
):
    """
    Precomputes the worldwide terrestrial gallery embeddings.
    Saves a raw float32 binary matrix [N, D] for zero-copy C++ mmap reading.
    """
    encoder.eval()
    device = next(encoder.parameters()).device

    print(f"🌐 [Gallery Generator] Generating {num_points} Fibonacci sphere points...")
    coords_np = generate_fibonacci_sphere_points(num_points)

    total_pts = coords_np.shape[0]
    embed_dim = encoder.output_dim
    all_embeddings = np.zeros((total_pts, embed_dim), dtype=np.float32)

    print(f"⚡ [Gallery Generator] Encoding {total_pts} points in batches of {batch_size}...")
    with torch.no_grad():
        for start_idx in range(0, total_pts, batch_size):
            end_idx = min(start_idx + batch_size, total_pts)
            batch_coords = torch.from_numpy(coords_np[start_idx:end_idx]).to(device)
            embeds = encoder(batch_coords).cpu().numpy()
            all_embeddings[start_idx:end_idx] = embeds

    # 1. Save binary embeddings: [N, D] float32
    os.makedirs(os.path.dirname(os.path.abspath(output_bin_path)), exist_ok=True)
    all_embeddings.tofile(output_bin_path)
    bin_size_mb = os.path.getsize(output_bin_path) / (1024 * 1024)
    print(f"💾 [Gallery Generator] Saved raw binary matrix: {output_bin_path} ({bin_size_mb:.2f} MB)")

    # 2. Save coordinates and index metadata
    meta = {
        "numPoints": total_pts,
        "embedDim": embed_dim,
        "format": "float32_row_major",
        "samplePoints": coords_np[:10].tolist()
    }
    with open(output_json_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    print(f"📄 [Gallery Generator] Saved gallery metadata: {output_json_path}")


def main():
    parser = argparse.ArgumentParser(description="GeoBox Model ONNX Export & Gallery Generator")
    parser.add_argument("--checkpoint", type=str, default="", help="Path to trained PyTorch checkpoint (.pt)")
    parser.add_argument("--output-dir", type=str, default="build/geobox_deploy", help="Output directory")
    parser.add_argument("--gallery-points", type=int, default=10000, help="Number of gallery points (default: 10,000 for testing, 100,000 for prod)")
    parser.add_argument("--embed-dim", type=int, default=512, help="Embedding dimension")
    args = parser.parse_args()

    out_dir = os.path.abspath(args.output_dir)
    os.makedirs(out_dir, exist_ok=True)

    encoder = SphericalHashLocationEncoder(output_dim=args.embed_dim)

    if args.checkpoint and os.path.exists(args.checkpoint):
        print(f"📥 Loading checkpoint: {args.checkpoint}")
        ckpt = torch.load(args.checkpoint, map_location="cpu")
        state_dict = ckpt.get("model_state_dict", ckpt)
        # Filter for location encoder keys
        loc_dict = {k.replace("location_encoder.", ""): v for k, v in state_dict.items() if "location_encoder." in k}
        if loc_dict:
            encoder.load_state_dict(loc_dict, strict=False)
            print("✓ Loaded location encoder weights from checkpoint.")

    onnx_path = os.path.join(out_dir, "geobox_location_encoder.onnx")
    export_location_encoder_onnx(encoder, onnx_path, embed_dim=args.embed_dim)

    bin_path = os.path.join(out_dir, "geobox_global_gallery.f32")
    json_path = os.path.join(out_dir, "geobox_global_gallery.json")
    precompute_global_gallery(encoder, bin_path, json_path, num_points=args.gallery_points)

    print("\n🎉 [GeoBox Deployment] All export artifacts generated successfully!")


if __name__ == "__main__":
    main()
