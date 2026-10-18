#!/usr/bin/env python3
"""
Scratchbox Local SF3D (Stable Fast 3D) Organic Prop Generator
Runs Stable Fast 3D on a single image. no_pbr mode keeps SF3D's geometry and repacks it in
18% Studio Grey Clay; PBR mode exports SF3D's textured mesh. Both get metric rescaling and an
optional ground snap. If SF3D is missing or fails, the script exits non-zero with a coded error
(no substitute geometry).
"""

import sys
import os
import time
import json
import math
import struct
import argparse
from typing import Tuple, List, Dict, Any, Optional

def pack_glb(
    vertices: List[Tuple[float, float, float]],
    normals: List[Tuple[float, float, float]],
    indices: List[Tuple[int, int, int]],
    clay_color: Tuple[float, float, float] = (0.55, 0.57, 0.60),
    metallic: float = 0.0,
    roughness: float = 0.85
) -> bytes:
    """
    Direct zero-dependency standard binary glTF 2.0 (.glb) packer.
    Encodes vertices, normals, and face indices into contiguous binary buffers
    with standard PBR metallic-roughness 18% Studio Grey Clay material.
    """
    num_vertices = len(vertices)
    num_indices = len(indices) * 3

    # Flatten indices
    flat_indices = []
    for tri in indices:
        flat_indices.extend(tri)

    use_uint32 = num_vertices > 65535
    index_component_type = 5125 if use_uint32 else 5123  # UNSIGNED_INT or UNSIGNED_SHORT
    index_stride = 4 if use_uint32 else 2

    # Calculate bounding box
    min_x = min(v[0] for v in vertices)
    max_x = max(v[0] for v in vertices)
    min_y = min(v[1] for v in vertices)
    max_y = max(v[1] for v in vertices)
    min_z = min(v[2] for v in vertices)
    max_z = max(v[2] for v in vertices)

    # Pack BIN data
    # 1. Position buffer (VEC3 FLOAT)
    pos_data = bytearray()
    for v in vertices:
        pos_data.extend(struct.pack("<fff", float(v[0]), float(v[1]), float(v[2])))

    # 2. Normal buffer (VEC3 FLOAT)
    norm_data = bytearray()
    for n in normals:
        norm_data.extend(struct.pack("<fff", float(n[0]), float(n[1]), float(n[2])))

    # 3. Index buffer
    idx_data = bytearray()
    idx_format = "<I" if use_uint32 else "<H"
    for idx in flat_indices:
        idx_data.extend(struct.pack(idx_format, int(idx)))

    # Align each buffer to 4 bytes
    def align4(b: bytearray) -> bytearray:
        rem = len(b) % 4
        if rem != 0:
            b.extend(b"\x00" * (4 - rem))
        return b

    pos_data = align4(pos_data)
    norm_data = align4(norm_data)
    idx_data = align4(idx_data)

    offset_pos = 0
    length_pos = len(pos_data)
    offset_norm = length_pos
    length_norm = len(norm_data)
    offset_idx = offset_norm + length_norm
    length_idx = len(idx_data)

    bin_data = pos_data + norm_data + idx_data
    total_bin_length = len(bin_data)

    # Construct glTF JSON document
    gltf = {
        "asset": {
            "version": "2.0",
            "generator": "Scratchbox Local SF3D Organic Engine"
        },
        "scene": 0,
        "scenes": [{ "nodes": [0] }],
        "nodes": [{
            "name": "LocalSF3D_OrganicProp",
            "mesh": 0
        }],
        "meshes": [{
            "name": "OrganicPropMesh",
            "primitives": [{
                "attributes": {
                    "POSITION": 0,
                    "NORMAL": 1
                },
                "indices": 2,
                "material": 0,
                "mode": 4  # TRIANGLES
            }]
        }],
        "materials": [{
            "name": "StudioGreyClay_PBR",
            "pbrMetallicRoughness": {
                "baseColorFactor": [clay_color[0], clay_color[1], clay_color[2], 1.0],
                "metallicFactor": float(metallic),
                "roughnessFactor": float(roughness)
            },
            "doubleSided": True
        }],
        "accessors": [
            {
                "bufferView": 0,
                "byteOffset": 0,
                "componentType": 5126,  # FLOAT
                "count": num_vertices,
                "type": "VEC3",
                "min": [min_x, min_y, min_z],
                "max": [max_x, max_y, max_z]
            },
            {
                "bufferView": 1,
                "byteOffset": 0,
                "componentType": 5126,  # FLOAT
                "count": num_vertices,
                "type": "VEC3"
            },
            {
                "bufferView": 2,
                "byteOffset": 0,
                "componentType": index_component_type,
                "count": num_indices,
                "type": "SCALAR",
                "min": [0],
                "max": [num_vertices - 1]
            }
        ],
        "bufferViews": [
            {
                "buffer": 0,
                "byteOffset": offset_pos,
                "byteLength": length_pos,
                "target": 34962  # ARRAY_BUFFER
            },
            {
                "buffer": 0,
                "byteOffset": offset_norm,
                "byteLength": length_norm,
                "target": 34962  # ARRAY_BUFFER
            },
            {
                "buffer": 0,
                "byteOffset": offset_idx,
                "byteLength": length_idx,
                "target": 34963  # ELEMENT_ARRAY_BUFFER
            }
        ],
        "buffers": [
            {
                "byteLength": total_bin_length
            }
        ]
    }

    json_bytes = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
    # Pad JSON to 4-byte alignment with space (0x20)
    json_padding = (4 - (len(json_bytes) % 4)) % 4
    json_bytes += b' ' * json_padding

    # Pad BIN to 4-byte alignment with null (0x00)
    bin_padding = (4 - (len(bin_data) % 4)) % 4
    bin_data += b'\x00' * bin_padding

    total_length = 12 + 8 + len(json_bytes) + 8 + len(bin_data)

    # GLB Header: magic (0x46546C67), version (2), totalLength
    glb_header = struct.pack("<4sII", b"glTF", 2, total_length)
    # JSON Chunk header: length, type (0x4E4F534A -> JSON)
    json_header = struct.pack("<II", len(json_bytes), 0x4E4F534A)
    # BIN Chunk header: length, type (0x004E4942 -> BIN\0)
    bin_header = struct.pack("<II", len(bin_data), 0x004E4942)

    return glb_header + json_header + json_bytes + bin_header + bin_data


def compute_smooth_normals(
    vertices: List[Tuple[float, float, float]],
    indices: List[Tuple[int, int, int]]
) -> List[Tuple[float, float, float]]:
    """Calculates angle-weighted smooth surface normal vectors."""
    normals = [[0.0, 0.0, 0.0] for _ in range(len(vertices))]
    for i0, i1, i2 in indices:
        p0 = vertices[i0]
        p1 = vertices[i1]
        p2 = vertices[i2]

        ux, uy, uz = p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]
        vx, vy, vz = p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]

        nx = uy * vz - uz * vy
        ny = uz * vx - ux * vz
        nz = ux * vy - uy * vx
        mag = math.sqrt(nx * nx + ny * ny + nz * nz)
        if mag > 1e-9:
            nx /= mag
            ny /= mag
            nz /= mag
            normals[i0][0] += nx
            normals[i0][1] += ny
            normals[i0][2] += nz
            normals[i1][0] += nx
            normals[i1][1] += ny
            normals[i1][2] += nz
            normals[i2][0] += nx
            normals[i2][1] += ny
            normals[i2][2] += nz

    smooth = []
    for n in normals:
        mag = math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2])
        if mag > 1e-9:
            smooth.append((n[0] / mag, n[1] / mag, n[2] / mag))
        else:
            smooth.append((0.0, 1.0, 0.0))
    return smooth


class Sf3dFailure(Exception):
    """A specific, reportable reason the SF3D run produced no mesh."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# Exit codes the TypeScript service maps to typed errors.
EXIT_NOT_INSTALLED = 3
EXIT_RUN_FAILED = 4


def emit_failure(code: str, message: str) -> None:
    print("__LOCAL_SF3D_ERROR_START__")
    print(json.dumps({"success": False, "code": code, "error": message}))
    print("__LOCAL_SF3D_ERROR_END__")
    sys.stderr.write(f"[LocalSF3D] {code}: {message}\n")


def run_sf3d_model(image_path: str, remesh_option: str, device: str):
    """
    Runs Stable Fast 3D (github.com/Stability-AI/stable-fast-3d) on one image and returns the trimesh it produced.
    Raises Sf3dFailure when the package or its weights are missing or the model fails; never substitutes geometry.
    """
    try:
        import torch
        from PIL import Image
        from sf3d.system import SF3D
        from sf3d.utils import remove_background, resize_foreground
    except ImportError as e:
        raise Sf3dFailure(
            "SF3D_NOT_INSTALLED",
            f"Stable Fast 3D is not installed in this Python environment ({e}). Install it from "
            "https://github.com/Stability-AI/stable-fast-3d (pip install -r requirements.txt && pip install -e .) "
            "and accept the stabilityai/stable-fast-3d licence on Hugging Face.",
        )

    if not os.path.isfile(image_path):
        raise Sf3dFailure("SF3D_INPUT_MISSING", f"Input image not found: {image_path}")

    try:
        image = Image.open(image_path).convert("RGBA")
    except Exception as e:
        raise Sf3dFailure("SF3D_INPUT_UNREADABLE", f"Could not read input image {image_path}: {e}")

    # SF3D expects the subject cut out on a transparent background. Use the image's own alpha when it has one.
    alpha_min, _alpha_max = image.getchannel("A").getextrema()
    if alpha_min == 255:
        try:
            import rembg
        except ImportError as e:
            raise Sf3dFailure(
                "SF3D_NOT_INSTALLED",
                f"The input image has no transparent background and rembg is not installed to remove it ({e}). "
                "Install rembg or pass an RGBA image with the subject cut out.",
            )
        image = remove_background(image, rembg.new_session())
    image = resize_foreground(image, 0.85)

    try:
        model = SF3D.from_pretrained(
            "stabilityai/stable-fast-3d", config_name="config.yaml", weight_name="model.safetensors"
        )
        model.to(device)
        model.eval()
        with torch.no_grad():
            mesh, _glob = model.run_image(image, bake_resolution=1024, remesh=remesh_option, vertex_count=-1)
    except Exception as e:
        raise Sf3dFailure("SF3D_RUN_FAILED", f"Stable Fast 3D failed on {image_path} (device {device}): {e}")

    if mesh is None or len(getattr(mesh, "vertices", [])) == 0 or len(getattr(mesh, "faces", [])) == 0:
        raise Sf3dFailure("SF3D_EMPTY_MESH", f"Stable Fast 3D returned an empty mesh for {image_path}.")
    return mesh


def run_sf3d_pipeline(
    image_path: str,
    output_glb_path: str,
    no_pbr: bool = True,
    target_scale_meters: float = 0.35,
    ground_cut: bool = True,
    remesh_option: str = "none",
    device: str = "auto",
    clay_color: Tuple[float, float, float] = (0.55, 0.57, 0.60)
) -> Dict[str, Any]:
    """Main local execution routine."""
    start_time = time.time()

    # Hardware detection
    actual_device = "cpu"
    try:
        import torch
        if device == "cuda" and torch.cuda.is_available():
            actual_device = "cuda"
        elif device == "mps" and hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            actual_device = "mps"
        elif device == "auto":
            if torch.cuda.is_available():
                actual_device = "cuda"
            elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                actual_device = "mps"
            else:
                actual_device = "cpu"
        else:
            actual_device = device
    except ImportError:
        actual_device = "cpu"

    mesh = run_sf3d_model(image_path, remesh_option, actual_device)
    vertices: List[Tuple[float, float, float]] = [tuple(float(c) for c in v) for v in mesh.vertices.tolist()]
    indices: List[Tuple[int, int, int]] = [tuple(int(i) for i in f) for f in mesh.faces.tolist()]

    # 1. Metric Rescaling
    min_x = min(v[0] for v in vertices)
    max_x = max(v[0] for v in vertices)
    min_y = min(v[1] for v in vertices)
    max_y = max(v[1] for v in vertices)
    min_z = min(v[2] for v in vertices)
    max_z = max(v[2] for v in vertices)

    extent_x = max_x - min_x
    extent_y = max_y - min_y
    extent_z = max_z - min_z
    max_dim = max(extent_x, extent_y, extent_z)

    scale_factor = (target_scale_meters / max_dim) if max_dim > 1e-6 else 1.0

    # 2. Origin Centering & Ground Alignment
    center_x = (min_x + max_x) * 0.5
    center_z = (min_z + max_z) * 0.5
    min_y_scaled = min_y * scale_factor

    transformed_verts = []
    ground_threshold = 0.005 * target_scale_meters if ground_cut else -1.0

    for v in vertices:
        tx = (v[0] - center_x) * scale_factor
        ty = (v[1] * scale_factor) - min_y_scaled  # Y_min -> 0.0
        tz = (v[2] - center_z) * scale_factor

        # Ground snap contact plane
        if ground_cut and ty < ground_threshold:
            ty = 0.0

        transformed_verts.append((tx, ty, tz))

    out_dir = os.path.dirname(os.path.abspath(output_glb_path))
    if out_dir and not os.path.exists(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    if no_pbr:
        # Clay: SF3D's geometry only, repacked with the studio clay material (its baked texture is dropped).
        normals = compute_smooth_normals(transformed_verts, indices)
        glb_bytes = pack_glb(
            vertices=transformed_verts,
            normals=normals,
            indices=indices,
            clay_color=clay_color,
            metallic=0.0,
            roughness=0.85
        )
        with open(output_glb_path, "wb") as f:
            f.write(glb_bytes)
    else:
        # PBR: keep SF3D's UVs and baked material, with the metric rescale and ground snap applied.
        import numpy as np
        mesh.vertices = np.asarray(transformed_verts, dtype=np.float64)
        mesh.export(output_glb_path, file_type="glb", include_normals=True)

    elapsed_ms = int((time.time() - start_time) * 1000)

    # Final bounds
    final_min = [min(v[i] for v in transformed_verts) for i in range(3)]
    final_max = [max(v[i] for v in transformed_verts) for i in range(3)]
    final_dims = [final_max[i] - final_min[i] for i in range(3)]
    final_center = [(final_min[i] + final_max[i]) * 0.5 for i in range(3)]

    result = {
        "success": True,
        "glb_path": output_glb_path,
        "mode": "no_pbr_clay" if no_pbr else "pbr",
        "neural_execution": True,
        "device": actual_device,
        "vertex_count": len(transformed_verts),
        "triangle_count": len(indices),
        "execution_time_ms": elapsed_ms,
        "target_scale_meters": target_scale_meters,
        "bounds": {
            "min": final_min,
            "max": final_max,
            "center": final_center,
            "dimensions": final_dims
        }
    }

    # Output structured JSON result for parent process parser
    print(f"__LOCAL_SF3D_RESULT_START__")
    print(json.dumps(result))
    print(f"__LOCAL_SF3D_RESULT_END__")

    return result


def main():
    parser = argparse.ArgumentParser(description="Local SF3D Organic Prop Generator")
    parser.add_argument("image_path", type=str, help="Path to input 2D image")
    parser.add_argument("output_glb_path", type=str, help="Destination .glb path")
    parser.add_argument("--no_pbr", action="store_true", default=True, help="Disable UV unwrapping and neural texture baking (default: True)")
    parser.add_argument("--with_pbr", dest="no_pbr", action="store_false", help="Enable neural PBR material projection")
    parser.add_argument("--target_scale_meters", type=float, default=0.35, help="Bounding size in meters (default: 0.35m)")
    parser.add_argument("--ground_cut", action="store_true", default=True, help="Snap base vertices to Y=0 (default: True)")
    parser.add_argument("--no_ground_cut", dest="ground_cut", action="store_false", help="Disable ground contact snap")
    parser.add_argument("--remesh_option", type=str, choices=["none", "triangle", "quad"], default="none", help="Topology remeshing option")
    parser.add_argument("--device", type=str, choices=["auto", "mps", "cuda", "cpu"], default="auto", help="Execution device target")

    args = parser.parse_args()

    try:
        run_sf3d_pipeline(
            image_path=args.image_path,
            output_glb_path=args.output_glb_path,
            no_pbr=args.no_pbr,
            target_scale_meters=args.target_scale_meters,
            ground_cut=args.ground_cut,
            remesh_option=args.remesh_option,
            device=args.device
        )
    except Sf3dFailure as e:
        emit_failure(e.code, e.message)
        sys.exit(EXIT_NOT_INSTALLED if e.code == "SF3D_NOT_INSTALLED" else EXIT_RUN_FAILED)


if __name__ == "__main__":
    main()
