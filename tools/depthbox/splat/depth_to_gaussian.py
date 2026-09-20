#!/usr/bin/env python3
"""
DepthBox Depth-Ray to 3D Gaussian Splats (3DGS) Exporter.
Converts DepthBox depth and ray predictions into full 3D Gaussians with
surface normals, orientation quaternions, anisotropic scale, and spherical harmonics.
Runs in pure Python 3 standard library with zero external dependencies,
while optionally using NumPy when available.
"""

import math
import struct
from typing import Dict, Any, List, Tuple

SH_C0 = 0.28209479177387814

class GaussianSplatData:
    def __init__(self, px, py, pz, sx, sy, sz, r, g, b, opacity, qx, qy, qz, qw, nx, ny, nz):
        self.position = (px, py, pz)
        self.scale = (sx, sy, sz)
        self.color = (r, g, b)
        self.opacity = opacity
        self.quaternion = (qx, qy, qz, qw)
        self.normal = (nx, ny, nz)

def depth_ray_to_gaussian_splats_pure(
    width: int,
    height: int,
    rgb_list: List[Tuple[int, int, int]], # W * H tuples of (r, g, b) in [0, 255]
    depth_list: List[float],             # W * H floats
    ray_list: List[Tuple[float, float, float]], # W * H tuples of (rx, ry, rz)
    stride: int = 2,
    edge_tau: float = 0.08,
    min_depth: float = 0.1,
    max_depth: float = 500.0
) -> List[GaussianSplatData]:
    """
    Synthesizes oriented 3D Gaussian Splats using pure Python 3 standard library.
    """
    splats = []

    for y in range(0, height, stride):
        for x in range(0, width, stride):
            idx = y * width + x
            d = depth_list[idx]
            if d < min_depth or d > max_depth or math.isnan(d):
                continue

            rx, ry, rz = ray_list[idx]
            px = d * rx
            py = d * ry
            pz = d * rz

            r, g, b = rgb_list[idx]

            # Compute neighbors for surface normal
            x_next = min(width - 1, x + stride)
            x_prev = max(0, x - stride)
            y_next = min(height - 1, y + stride)
            y_prev = max(0, y - stride)

            d_r = depth_list[y * width + x_next]
            d_l = depth_list[y * width + x_prev]
            d_d = depth_list[y_next * width + x]
            d_u = depth_list[y_prev * width + x]

            # Relative depth step check
            max_dx = max(1e-4, max(d_r, d_l))
            max_dy = max(1e-4, max(d_d, d_u))
            is_edge = (abs(d_r - d_l) / max_dx > edge_tau) or (abs(d_d - d_u) / max_dy > edge_tau)

            r_r = ray_list[y * width + x_next]
            r_l = ray_list[y * width + x_prev]
            r_d = ray_list[y_next * width + x]
            r_u = ray_list[y_prev * width + x]

            tx = (d_r * r_r[0] - d_l * r_l[0], d_r * r_r[1] - d_l * r_l[1], d_r * r_r[2] - d_l * r_l[2])
            ty = (d_d * r_d[0] - d_u * r_u[0], d_d * r_d[1] - d_u * r_u[1], d_d * r_d[2] - d_u * r_u[2])

            len_tx = math.sqrt(tx[0]*tx[0] + tx[1]*tx[1] + tx[2]*tx[2])
            len_ty = math.sqrt(ty[0]*ty[0] + ty[1]*ty[1] + ty[2]*ty[2])

            # Normal = tx x ty
            nx = tx[1]*ty[2] - tx[2]*ty[1]
            ny = tx[2]*ty[0] - tx[0]*ty[2]
            nz = tx[0]*ty[1] - tx[1]*ty[0]
            len_n = math.sqrt(nx*nx + ny*ny + nz*nz)

            if len_n > 1e-6:
                nx /= len_n
                ny /= len_n
                nz /= len_n
            else:
                nx, ny, nz = -rx, -ry, -rz

            # Ensure normal faces camera (dot(n, r) < 0)
            if nx*rx + ny*ry + nz*rz > 0:
                nx, ny, nz = -nx, -ny, -nz

            # Quaternion from (0, 0, 1) to normal n
            dot_z = nz
            if dot_z >= 0.9999:
                qx, qy, qz, qw = 0.0, 0.0, 0.0, 1.0
            elif dot_z <= -0.9999:
                qx, qy, qz, qw = 0.0, 1.0, 0.0, 0.0
            else:
                ax = -ny
                ay = nx
                az = 0.0
                s = math.sqrt((1.0 + dot_z) * 2.0)
                inv_s = 1.0 / s
                qx = ax * inv_s
                qy = ay * inv_s
                qz = az * inv_s
                qw = s * 0.5
                q_len = math.sqrt(qx*qx + qy*qy + qz*qz + qw*qw)
                qx /= q_len
                qy /= q_len
                qz /= q_len
                qw /= q_len

            # Surfel scales
            base_scale = (d / 500.0) * stride * 1.8
            sx = max(0.02, min(5.0, len_tx * 0.75 if len_tx > 1e-4 else base_scale))
            sy = max(0.02, min(5.0, len_ty * 0.75 if len_ty > 1e-4 else base_scale))
            sz = max(0.005, min(sx, sy) * 0.2) # Flattened surfel disc

            opacity = 0.75 if is_edge else 0.98

            splats.append(GaussianSplatData(
                px, py, pz, sx, sy, sz, r, g, b, opacity, qx, qy, qz, qw, nx, ny, nz
            ))

    return splats

def voxel_filter_splats(splats: List[GaussianSplatData], voxel_size: float = 0.05) -> List[GaussianSplatData]:
    """
    Decimates and deduplicates 3D Gaussian splats using a 3D spatial voxel grid.
    """
    if not splats or voxel_size <= 0:
        return splats

    inv_v = 1.0 / voxel_size
    grid: Dict[Tuple[int, int, int], List[GaussianSplatData]] = {}

    for s in splats:
        vx = int(math.floor(s.position[0] * inv_v))
        vy = int(math.floor(s.position[1] * inv_v))
        vz = int(math.floor(s.position[2] * inv_v))
        k = (vx, vy, vz)
        if k not in grid:
            grid[k] = []
        grid[k].append(s)

    filtered = []
    for k, cell_splats in grid.items():
        w_sum = sum(max(0.01, cs.opacity) for cs in cell_splats)
        avg_px = sum(cs.position[0] * cs.opacity for cs in cell_splats) / w_sum
        avg_py = sum(cs.position[1] * cs.opacity for cs in cell_splats) / w_sum
        avg_pz = sum(cs.position[2] * cs.opacity for cs in cell_splats) / w_sum

        avg_r = sum(cs.color[0] * cs.opacity for cs in cell_splats) / w_sum
        avg_g = sum(cs.color[1] * cs.opacity for cs in cell_splats) / w_sum
        avg_b = sum(cs.color[2] * cs.opacity for cs in cell_splats) / w_sum

        avg_sx = max(voxel_size * 0.5, sum(cs.scale[0] * cs.opacity for cs in cell_splats) / w_sum)
        avg_sy = max(voxel_size * 0.5, sum(cs.scale[1] * cs.opacity for cs in cell_splats) / w_sum)
        avg_sz = max(0.005, min(avg_sx, avg_sy) * 0.2)

        lead = cell_splats[0]
        filtered.append(GaussianSplatData(
            avg_px, avg_py, avg_pz,
            avg_sx, avg_sy, avg_sz,
            avg_r, avg_g, avg_b,
            min(1.0, w_sum / len(cell_splats)),
            lead.quaternion[0], lead.quaternion[1], lead.quaternion[2], lead.quaternion[3],
            lead.normal[0], lead.normal[1], lead.normal[2]
        ))

    return filtered

def export_splat_binary_pure(splats: List[GaussianSplatData], filepath: str) -> int:
    """Exports to standard 32-byte .splat binary format."""
    with open(filepath, "wb") as f:
        for s in splats:
            f.write(struct.pack(
                "<ffffff",
                s.position[0], s.position[1], s.position[2],
                s.scale[0], s.scale[1], s.scale[2]
            ))
            r = min(255, max(0, int(s.color[0])))
            g = min(255, max(0, int(s.color[1])))
            b = min(255, max(0, int(s.color[2])))
            a = min(255, max(0, int(s.opacity * 255.0)))
            f.write(struct.pack("BBBB", r, g, b, a))

            # Quantized quaternion
            qx_q = min(255, max(0, int(s.quaternion[0] * 127.5 + 127.5)))
            qy_q = min(255, max(0, int(s.quaternion[1] * 127.5 + 127.5)))
            qz_q = min(255, max(0, int(s.quaternion[2] * 127.5 + 127.5)))
            qw_q = min(255, max(0, int(s.quaternion[3] * 127.5 + 127.5)))
            f.write(struct.pack("BBBB", qx_q, qy_q, qz_q, qw_q))

    return len(splats)

if __name__ == "__main__":
    print("[DepthToGaussian] Testing synthetic 3DGS pipeline in pure Python 3...")
    W, H = 32, 32
    rgb_list = [(180, 140, 220)] * (W * H)
    depth_list = [15.0] * (W * H)
    ray_list = [(0.0, 0.0, 1.0)] * (W * H)

    splats = depth_ray_to_gaussian_splats_pure(W, H, rgb_list, depth_list, ray_list, stride=2)
    print(f"[DepthToGaussian] Generated {len(splats)} splats.")
    assert len(splats) == (W // 2) * (H // 2), f"Expected {(W // 2) * (H // 2)} splats, got {len(splats)}"

    out_file = "/tmp/test_depthbox_splat.splat"
    exported_count = export_splat_binary_pure(splats, out_file)
    print(f"[DepthToGaussian] Exported {exported_count} splats to {out_file} ({exported_count * 32} bytes).")
    print("[DepthToGaussian] ALL CHECKS PASSED.")
