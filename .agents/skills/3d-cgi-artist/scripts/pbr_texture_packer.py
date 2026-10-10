#!/usr/bin/env python3
"""
PBR Texture Packer for Unreal Engine & Unity
============================================
Packs individual grayscale texture maps into channel-packed engine formats:
- Unreal ORM (Occlusion, Roughness, Metallic)
- Unity Mask Map (Metallic, Occlusion, Detail, Smoothness)
"""

import sys
import os
import argparse

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

def load_or_constant(path, size, default_value):
    """Loads a grayscale image or generates a solid constant value image."""
    if path and os.path.exists(path):
        img = Image.open(path).convert('L')
        if size and img.size != size:
            print(f" [RESIZE] Rescaling {os.path.basename(path)} from {img.size} to {size}")
            img = img.resize(size, Image.Resampling.LANCZOS)
        return img
    else:
        return Image.new('L', size if size else (1024, 1024), color=default_value)

def pack_orm(ao_path, roughness_path, metallic_path, output_path):
    """Packs Unreal Engine ORM: R=Occlusion, G=Roughness, B=Metallic."""
    print(" [PACKING] Target: Unreal Engine ORM (R=AO, G=Roughness, B=Metallic)...")
    
    # Determine reference resolution
    ref_img = None
    for p in [roughness_path, metallic_path, ao_path]:
        if p and os.path.exists(p):
            ref_img = Image.open(p)
            break
    size = ref_img.size if ref_img else (1024, 1024)

    r_ao = load_or_constant(ao_path, size, 255)            # Default AO: white (1.0)
    g_rough = load_or_constant(roughness_path, size, 128)  # Default Roughness: 0.5
    b_metal = load_or_constant(metallic_path, size, 0)     # Default Metallic: 0.0

    packed = Image.merge('RGB', (r_ao, g_rough, b_metal))
    packed.save(output_path)
    print(f" [SAVED] Unreal ORM map written to: {output_path}")

def pack_unity_mask(metallic_path, ao_path, detail_path, smoothness_path, roughness_path, output_path):
    """Packs Unity Mask Map: R=Metallic, G=AO, B=Detail, A=Smoothness."""
    print(" [PACKING] Target: Unity Mask Map (R=Metallic, G=AO, B=Detail, A=Smoothness)...")

    ref_img = None
    for p in [metallic_path, roughness_path, smoothness_path, ao_path]:
        if p and os.path.exists(p):
            ref_img = Image.open(p)
            break
    size = ref_img.size if ref_img else (1024, 1024)

    r_metal = load_or_constant(metallic_path, size, 0)
    g_ao = load_or_constant(ao_path, size, 255)
    b_detail = load_or_constant(detail_path, size, 0)

    # If smoothness is not provided, invert roughness
    if smoothness_path and os.path.exists(smoothness_path):
        a_smooth = load_or_constant(smoothness_path, size, 128)
    elif roughness_path and os.path.exists(roughness_path):
        rough_img = load_or_constant(roughness_path, size, 128)
        from PIL import ImageOps
        a_smooth = ImageOps.invert(rough_img)
    else:
        a_smooth = Image.new('L', size, color=128)

    packed = Image.merge('RGBA', (r_metal, g_ao, b_detail, a_smooth))
    packed.save(output_path)
    print(f" [SAVED] Unity Mask map written to: {output_path}")

def main():
    if not HAS_PIL:
        print("Error: PIL (Pillow) is required. Install with: pip install pillow")
        sys.exit(1)

    parser = argparse.ArgumentParser(description="PBR Texture Channel Packer (Unreal / Unity)")
    parser.add_argument("--format", choices=["unreal", "unity"], default="unreal", help="Engine target format")
    parser.add_argument("--ao", help="Path to Ambient Occlusion map")
    parser.add_argument("--roughness", help="Path to Roughness map")
    parser.add_argument("--metallic", help="Path to Metallic map")
    parser.add_argument("--smoothness", help="Path to Smoothness map (Unity only)")
    parser.add_argument("--detail", help="Path to Detail mask (Unity only)")
    parser.add_argument("-o", "--output", required=True, help="Output path for packed texture")

    args = parser.parse_args()

    if args.format == "unreal":
        pack_orm(args.ao, args.roughness, args.metallic, args.output)
    elif args.format == "unity":
        pack_unity_mask(args.metallic, args.ao, args.detail, args.smoothness, args.roughness, args.output)

if __name__ == '__main__':
    main()
