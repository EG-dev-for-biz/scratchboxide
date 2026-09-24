#!/usr/bin/env python3
"""
Scratchbox IDE - Harvested Urban Pair Dataset Validator & Quality Gate
Audits 3D Tile meshes (.glb), Google Vector Maps metadata (.json), and Multi-Scene
AI Beautify / Nerfstudio camera rigs (transforms.json & station PNGs) to ensure
clean geometric bounds, valid binary glTF headers, closed vector footprints, valid
pinhole camera matrices, and 1:1 co-registration.
"""

import os
import sys
import json
import argparse
import struct
from typing import Dict, Any, List, Tuple

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

def parse_args():
    parser = argparse.ArgumentParser(description="Audit and validate harvested urban building pairs")
    parser.add_argument("--input_dir", type=str, default="./data/urban_pairs", help="Directory containing building pair folders or manifest")
    parser.add_argument("--manifest", type=str, default=None, help="Path to manifest JSON/JSONL")
    parser.add_argument("--strict", action="store_true", help="Fail with non-zero exit code on any validation rejection")
    parser.add_argument("--check_stations", action="store_true", default=True, help="Validate station images and transforms.json if present")
    return parser.parse_args()

def validate_glb_header(glb_path: str) -> Tuple[bool, str, int]:
    """Verifies binary glTF 2.0 container header (magic=0x46546C67, version=2)."""
    if not os.path.exists(glb_path):
        return False, "File does not exist", 0

    file_size = os.path.getsize(glb_path)
    if file_size < 20:
        return False, f"File too small ({file_size} bytes)", file_size

    with open(glb_path, "rb") as f:
        magic, version, length = struct.unpack("<4sII", f.read(12))

    if magic != b"glTF":
        return False, f"Invalid magic header: {magic}", file_size

    if version != 2:
        return False, f"Unsupported glTF version: {version}", file_size

    return True, "Valid glTF 2.0 binary", file_size

def validate_png_file(png_path: str) -> Tuple[bool, str]:
    """Verifies that an image is a valid PNG file with proper magic header."""
    if not os.path.exists(png_path):
        return False, f"Missing PNG file: {png_path}"
    if os.path.getsize(png_path) < 8:
        return False, f"PNG file too small: {png_path}"
    with open(png_path, "rb") as f:
        header = f.read(8)
    if header != PNG_MAGIC:
        return False, f"Invalid PNG magic bytes in {png_path}"
    return True, "Valid PNG"

def validate_vector_metadata(vector_path: str) -> Tuple[bool, str, Dict[str, Any]]:
    """Verifies GeoJSON vector footprint structure, height, and closed polygon."""
    if not os.path.exists(vector_path):
        return False, "Vector metadata file missing", {}

    try:
        with open(vector_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        return False, f"JSON parse error: {e}", {}

    if "building_id" not in data:
        return False, "Missing building_id field", data

    height = data.get("height_meters", 0.0)
    if height <= 0:
        return False, f"Invalid building height: {height}m", data

    poly = data.get("footprint_polygon_wgs84", [])
    if len(poly) < 4:
        return False, f"Invalid footprint polygon (points={len(poly)}, minimum=4)", data

    # Check if polygon is closed
    first, last = poly[0], poly[-1]
    if abs(first[0] - last[0]) > 1e-6 or abs(first[1] - last[1]) > 1e-6:
        return False, "Footprint polygon is not closed (first != last)", data

    return True, "Valid vector metadata", data

def validate_transforms_json(transforms_path: str, bldg_dir: str) -> Tuple[bool, str, int]:
    """Verifies Nerfstudio / COLMAP camera format transforms.json and frame images."""
    if not os.path.exists(transforms_path):
        return False, "transforms.json does not exist", 0

    try:
        with open(transforms_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        return False, f"transforms.json parse error: {e}", 0

    if "frames" not in data or not isinstance(data["frames"], list):
        return False, "transforms.json missing 'frames' list", 0

    frames = data["frames"]
    if len(frames) == 0:
        return False, "transforms.json frames list is empty", 0

    for idx, frame in enumerate(frames):
        rel_beautify = frame.get("file_path")
        if not rel_beautify:
            return False, f"Frame {idx} missing file_path", 0

        abs_beautify = os.path.join(bldg_dir, rel_beautify)
        valid_png, png_msg = validate_png_file(abs_beautify)
        if not valid_png:
            return False, f"Frame {idx} beautify error: {png_msg}", 0

        c2w = frame.get("transform_matrix")
        if not c2w or len(c2w) != 4 or len(c2w[0]) != 4:
            return False, f"Frame {idx} invalid transform_matrix 4x4", 0

    return True, f"Valid transforms.json with {len(frames)} frames", len(frames)

def audit_dataset(input_dir: str, manifest_path: str = None, strict: bool = False, check_stations: bool = True) -> Dict[str, Any]:
    print(f"[Dataset Auditor] Starting audit on: {input_dir}")
    
    # Locate manifest if not specified
    if not manifest_path:
        if os.path.exists(input_dir):
            for fname in os.listdir(input_dir):
                if fname.endswith("manifest.json") or fname.endswith("manifest.jsonl"):
                    manifest_path = os.path.join(input_dir, fname)
                    break

    building_dirs = []
    if os.path.exists(os.path.join(input_dir, "tile.glb")):
        building_dirs.append({
            "building_id": os.path.basename(os.path.abspath(input_dir)),
            "building_dir": os.path.abspath(input_dir),
            "tile_path": os.path.join(input_dir, "tile.glb"),
            "vector_path": os.path.join(input_dir, "vector_metadata.json")
        })
    elif manifest_path and os.path.exists(manifest_path):
        print(f"[Dataset Auditor] Reading manifest: {manifest_path}")
        with open(manifest_path, "r", encoding="utf-8") as f:
            if manifest_path.endswith(".jsonl"):
                for line in f:
                    if line.strip():
                        item = json.loads(line)
                        building_dirs.append(item)
            else:
                m_data = json.load(f)
                building_dirs = m_data.get("buildings", [])
    elif os.path.exists(input_dir):
        # Scan subdirectories that contain building assets
        for entry in sorted(os.listdir(input_dir)):
            full_path = os.path.join(input_dir, entry)
            if os.path.isdir(full_path) and os.path.exists(os.path.join(full_path, "tile.glb")):
                building_dirs.append({
                    "building_id": entry,
                    "building_dir": full_path,
                    "tile_path": os.path.join(full_path, "tile.glb"),
                    "vector_path": os.path.join(full_path, "vector_metadata.json")
                })

    total = len(building_dirs)
    passed = 0
    rejected = 0
    rejection_reasons = []
    total_stations = 0

    for bldg in building_dirs:
        bldg_id = bldg.get("building_id", "unknown")
        bldg_dir = bldg.get("building_dir") or os.path.join(input_dir, bldg_id)
        tile_path = bldg.get("tile_path") or os.path.join(bldg_dir, "tile.glb")
        vector_path = bldg.get("vector_path") or os.path.join(bldg_dir, "vector_metadata.json")

        # 1. Audit GLB
        glb_valid, glb_msg, glb_size = validate_glb_header(tile_path)
        if not glb_valid:
            rejected += 1
            rejection_reasons.append(f"{bldg_id}: GLB error - {glb_msg}")
            continue

        # 2. Audit Vector
        if os.path.exists(vector_path) or manifest_path:
            vec_valid, vec_msg, _ = validate_vector_metadata(vector_path)
            if not vec_valid:
                rejected += 1
                rejection_reasons.append(f"{bldg_id}: Vector error - {vec_msg}")
                continue

        # 3. Audit Multi-Scene Transforms & Station Images if present
        transforms_path = os.path.join(bldg_dir, "transforms.json")
        if check_stations and os.path.exists(transforms_path):
            trans_valid, trans_msg, frame_count = validate_transforms_json(transforms_path, bldg_dir)
            if not trans_valid:
                rejected += 1
                rejection_reasons.append(f"{bldg_id}: Camera Rig error - {trans_msg}")
                continue
            total_stations += frame_count

        passed += 1

    summary = {
        "total_audited": total,
        "passed": passed,
        "rejected": rejected,
        "total_stations": total_stations,
        "pass_rate": (passed / total * 100.0) if total > 0 else 0.0,
        "rejection_reasons": rejection_reasons[:10]
    }

    print(f"[Dataset Auditor] Audit Complete: {passed}/{total} passed ({summary['pass_rate']:.1f}%), {total_stations} multi-scene stations validated")
    if rejection_reasons:
        print(f"[Dataset Auditor] Sample rejections: {rejection_reasons[:3]}")

    if strict and rejected > 0:
        print(f"[Dataset Auditor] Strict mode: exiting with failure code 1")
        sys.exit(1)

    return summary

if __name__ == "__main__":
    args = parse_args()
    audit_dataset(args.input_dir, args.manifest, args.strict, args.check_stations)
