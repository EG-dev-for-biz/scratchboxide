#!/usr/bin/env python3
"""
Normal Map Converter & Tangent Space Inspector
==============================================
CLI Tool to inspect, validate, and convert normal maps across engines:
- Invert Green Channel (DirectX <-> OpenGL / Unreal <-> Blender/Unity)
- Check normalization (identifies compression degradation / length loss)
- Detect gamma-space corruption (checks if sRGB was erroneously applied)
- Re-normalize vectors to unit length
"""

import sys
import os
import argparse
import math

try:
    from PIL import Image
    import numpy as np
    HAS_DEPS = True
except ImportError:
    HAS_DEPS = False

def analyze_and_convert(image_path, output_path=None, flip_green=False, normalize=False):
    if not HAS_DEPS:
        print("Error: PIL (Pillow) and numpy are required. Install with: pip install pillow numpy")
        return False

    print(f"\n=======================================================")
    print(f" [NORMAL MAP INSPECTOR] Loading: {image_path}")
    print(f"=======================================================")

    img = Image.open(image_path).convert('RGB')
    arr = np.array(img, dtype=np.float32)

    # Convert [0..255] to [-1..1]
    vectors = (arr / 255.0) * 2.0 - 1.0
    r, g, b = vectors[:, :, 0], vectors[:, :, 1], vectors[:, :, 2]

    # Calculate vector lengths
    lengths = np.sqrt(r**2 + g**2 + b**2)
    avg_length = float(np.mean(lengths))
    min_length = float(np.min(lengths))
    max_length = float(np.max(lengths))

    print(f" Resolution: {img.width}x{img.height}")
    print(f" Vector Length Stats: Avg={avg_length:.3f} | Min={min_length:.3f} | Max={max_length:.3f}")

    # Check for unit normalization
    if abs(avg_length - 1.0) > 0.05:
        print(" [WARNING] Vectors deviate significantly from unit length (1.0).")
        print("           Possible normal compression artifacts or linear/sRGB mismatch.")
    else:
        print(" [OK] Vector normalization is within valid tolerance.")

    # Check for Z hemisphere (B channel should be predominantly positive, pointing out of surface)
    avg_z = float(np.mean(b))
    print(f" Average Tangent Z (+Z outwards): {avg_z:.3f}")
    if avg_z < 0.2:
        print(" [CRITICAL] Tangent Z is very low or negative! The image may not be a tangent-space normal map.")
    elif avg_z > 0.7:
        print(" [OK] Tangent space orientation verified (dominant positive Z).")

    # Flip green if requested
    if flip_green:
        print(" [ACTION] Inverting Green channel (DirectX <-> OpenGL conversion)...")
        g = -g
        vectors[:, :, 1] = g

    # Normalize if requested
    if normalize:
        print(" [ACTION] Re-normalizing vectors to exact unit length (1.0)...")
        # Avoid division by zero
        safe_lengths = np.where(lengths == 0, 1.0, lengths)
        vectors[:, :, 0] /= safe_lengths
        vectors[:, :, 1] /= safe_lengths
        vectors[:, :, 2] /= safe_lengths

    # Save output if specified
    if output_path or flip_green or normalize:
        if not output_path:
            base, ext = os.path.splitext(image_path)
            output_path = f"{base}_converted{ext}"

        # Convert back to [0..255]
        out_arr = ((vectors + 1.0) * 0.5 * 255.0).clip(0, 255).astype(np.uint8)
        out_img = Image.fromarray(out_arr, mode='RGB')
        out_img.save(output_path)
        print(f" [SAVED] Result written to: {output_path}")

    print(f"=======================================================\n")
    return True

def main():
    parser = argparse.ArgumentParser(description="Normal Map Inspector & Converter (DirectX/OpenGL)")
    parser.add_argument("input", help="Path to input normal map image")
    parser.add_argument("-o", "--output", help="Path to output converted image")
    parser.add_argument("--flip-green", "-g", action="store_true", help="Invert Green channel (DirectX <-> OpenGL)")
    parser.add_argument("--normalize", "-n", action="store_true", help="Re-normalize vectors to unit length")

    if len(sys.argv) == 1:
        parser.print_help()
        sys.exit(1)

    args = parser.parse_args()
    analyze_and_convert(args.input, args.output, args.flip_green, args.normalize)

if __name__ == '__main__':
    main()
