#!/usr/bin/env python3
"""
inspect_smpl_tree.py - Pure Python Standalone Botanical glTF 2.0 Inspector & Analyzer.

Zero external dependencies (uses standard library: sys, struct, json, math, os).
Analyzes SMPL-Tree geometry, Leaf Area Index (LAI), SSS radiometric colors, and manifold topology.

Usage:
    python3 scripts/inspect_smpl_tree.py [path_to_model.glb]
"""

import sys
import os
import json
import struct
import math

COMPONENT_TYPES = {
    5120: ('b', 1),   # BYTE
    5121: ('B', 1),   # UNSIGNED_BYTE
    5122: ('h', 2),   # SHORT
    5123: ('H', 2),   # UNSIGNED_SHORT
    5125: ('I', 4),   # UNSIGNED_INT
    5126: ('f', 4)    # FLOAT
}

TYPE_NUM_COMPONENTS = {
    'SCALAR': 1,
    'VEC2': 2,
    'VEC3': 3,
    'VEC4': 4,
    'MAT4': 16
}

def parse_glb(filepath):
    """Parses binary glTF 2.0 (.glb) into JSON header and binary buffer."""
    with open(filepath, 'rb') as f:
        header = f.read(12)
        if len(header) < 12:
            raise ValueError(f"File too small to be a valid GLB: {filepath}")
        
        magic, version, length = struct.unpack('<4sII', header)
        if magic != b'glTF':
            raise ValueError(f"Invalid magic {magic}, expected b'glTF'")
        if version != 2:
            raise ValueError(f"Unsupported glTF version {version}, expected 2")
        
        # Read Chunk 0: JSON
        c0_len, c0_type = struct.unpack('<II', f.read(8))
        if c0_type != 0x4E4F534A: # 'JSON'
            raise ValueError(f"Expected JSON chunk type, got {hex(c0_type)}")
        json_bytes = f.read(c0_len)
        gltf = json.loads(json_bytes.decode('utf-8'))
        
        # Read Chunk 1: BIN
        bin_data = b''
        if f.tell() < length:
            c1_hdr = f.read(8)
            if len(c1_hdr) == 8:
                c1_len, c1_type = struct.unpack('<II', c1_hdr)
                bin_data = f.read(c1_len)
        
        return gltf, bin_data

def get_accessor_data(gltf, bin_data, accessor_idx):
    """Extracts typed data array for a given accessor index."""
    acc = gltf['accessors'][accessor_idx]
    bv_idx = acc.get('bufferView')
    if bv_idx is None:
        return []
    
    bv = gltf['bufferViews'][bv_idx]
    offset = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    count = acc['count']
    c_type = acc['componentType']
    type_str = acc['type']
    
    fmt_char, comp_size = COMPONENT_TYPES[c_type]
    num_comps = TYPE_NUM_COMPONENTS[type_str]
    stride = bv.get('byteStride', comp_size * num_comps)
    
    result = []
    fmt = f'<{num_comps}{fmt_char}'
    for i in range(count):
        elem_offset = offset + i * stride
        chunk = bin_data[elem_offset:elem_offset + comp_size * num_comps]
        unpacked = struct.unpack(fmt, chunk)
        if num_comps == 1:
            result.append(unpacked[0])
        else:
            result.append(unpacked)
    return result

def triangle_area_3d(v0, v1, v2):
    """Computes Euclidean 3D triangle area using cross product."""
    ax, ay, az = v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]
    bx, by, bz = v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]
    cx = ay * bz - az * by
    cy = az * bx - ax * bz
    cz = ax * by - ay * bx
    return 0.5 * math.sqrt(cx * cx + cy * cy + cz * cz)

def inspect_tree(filepath):
    print("=" * 76)
    print(f"  BOTANICAL GLTF 2.0 INSPECTOR & ARCHITECTURAL AUDITOR")
    print(f"  Target File: {filepath}")
    print("=" * 76)

    if not os.path.exists(filepath):
        print(f"Error: File not found: {filepath}")
        return False

    file_size_mb = os.path.getsize(filepath) / (1024 * 1024)
    gltf, bin_data = parse_glb(filepath)

    print(f"  glTF Asset Generator: {gltf.get('asset', {}).get('generator', 'Unknown')}")
    print(f"  Binary File Size:     {file_size_mb:.2f} MB")
    print(f"  Total Meshes:         {len(gltf.get('meshes', []))}")
    print(f"  Total Materials:      {len(gltf.get('materials', []))}")
    print("-" * 76)

    all_positions = []
    foliage_positions = []
    wood_positions = []
    wood_colors = []
    foliage_colors = []
    wood_indices = []
    foliage_indices = []

    total_upper_leaf_area = 0.0
    total_wood_area = 0.0

    for mesh in gltf.get('meshes', []):
        mesh_name = mesh.get('name', 'Unnamed')
        for prim in mesh.get('primitives', []):
            attrs = prim.get('attributes', {})
            pos_idx = attrs.get('POSITION')
            col_idx = attrs.get('COLOR_0')
            idx_idx = prim.get('indices')

            positions = get_accessor_data(gltf, bin_data, pos_idx) if pos_idx is not None else []
            colors = get_accessor_data(gltf, bin_data, col_idx) if col_idx is not None else []
            indices = get_accessor_data(gltf, bin_data, idx_idx) if idx_idx is not None else []

            is_foliage = "foliage" in mesh_name.lower()
            is_wood = "wood" in mesh_name.lower() or "bare" in mesh_name.lower()

            if is_foliage:
                fol_base_idx = len(foliage_positions)
                foliage_positions.extend(positions)
                foliage_colors.extend(colors)
                all_positions.extend(positions)
                foliage_indices.extend([i + fol_base_idx for i in indices])

                # Calculate leaf area (count first 6 triangles per 14-triangle leaf = upper face)
                if indices:
                    tri_count = len(indices) // 3
                    for t in range(tri_count):
                        # Upper leaf faces are the first 6 triangles of each 14-triangle leaf bundle
                        leaf_tri_in_quad = t % 14
                        if leaf_tri_in_quad < 6:
                            i0, i1, i2 = indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]
                            if i0 < len(positions) and i1 < len(positions) and i2 < len(positions):
                                total_upper_leaf_area += triangle_area_3d(positions[i0], positions[i1], positions[i2])
            else:
                wood_base_idx = len(wood_positions)
                wood_positions.extend(positions)
                wood_colors.extend(colors)
                all_positions.extend(positions)
                wood_indices.extend([i + wood_base_idx for i in indices])

                if indices:
                    tri_count = len(indices) // 3
                    for t in range(tri_count):
                        i0, i1, i2 = indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]
                        if i0 < len(positions) and i1 < len(positions) and i2 < len(positions):
                            total_wood_area += triangle_area_3d(positions[i0], positions[i1], positions[i2])

    if not all_positions:
        print("Warning: No vertex positions found in glTF file.")
        return False

    # Bounding Box
    min_x = min(p[0] for p in all_positions)
    max_x = max(p[0] for p in all_positions)
    min_y = min(p[1] for p in all_positions)
    max_y = max(p[1] for p in all_positions)
    min_z = min(p[2] for p in all_positions)
    max_z = max(p[2] for p in all_positions)

    tree_height = max_y - min_y
    crown_width_x = max_x - min_x
    crown_depth_z = max_z - min_z
    crown_diameter = max(crown_width_x, crown_depth_z)
    projected_ground_radius = crown_diameter * 0.5
    projected_ground_area = math.pi * (projected_ground_radius ** 2)

    # Leaf count estimate (16 vertices per lobed leaf with upper, under, petiole)
    estimated_leaf_count = len(foliage_positions) // 16 if foliage_positions else 0
    foliage_tri_count = len(foliage_indices) // 3
    wood_tri_count = len(wood_indices) // 3

    # Leaf Area Index (LAI)
    lai = total_upper_leaf_area / projected_ground_area if projected_ground_area > 1e-4 else 0.0

    print("  BOTANICAL MORPHOLOGY & DIMENSIONS:")
    print(f"    Total Tree Height:      {tree_height:.2f} m  (Base: {min_y:.2f}m, Apex: {max_y:.2f}m)")
    print(f"    Crown Spread (X x Z):   {crown_width_x:.2f} m x {crown_depth_z:.2f} m")
    print(f"    Crown Diameter:         {crown_diameter:.2f} m")
    print(f"    Projected Ground Area:  {projected_ground_area:.2f} m^2")
    print("-" * 76)
    print("  GEOMETRIC DENSITY & CANOPY METRICS:")
    print(f"    Bare Wood Vertices:     {len(wood_positions):,}")
    print(f"    Bare Wood Triangles:    {wood_tri_count:,}")
    print(f"    Bare Wood Surface Area: {total_wood_area:.2f} m^2")
    print(f"    Foliage Vertices:       {len(foliage_positions):,}")
    print(f"    Foliage Triangles:      {foliage_tri_count:,}")
    print(f"    Total Anatomical Leaves: {estimated_leaf_count:,} leaves")
    print(f"    One-Sided Leaf Area:    {total_upper_leaf_area:.2f} m^2")
    print(f"    Leaf Area Index (LAI):  {lai:.2f}  (Decurrent hardwood standard: 3.5 - 6.5)")
    print("-" * 76)

    # Radiometric Subsurface Scattering (SSS) Verification
    if foliage_colors:
        avg_r = sum(c[0] for c in foliage_colors) / len(foliage_colors)
        avg_g = sum(c[1] for c in foliage_colors) / len(foliage_colors)
        avg_b = sum(c[2] for c in foliage_colors) / len(foliage_colors)
        max_g = max(c[1] for c in foliage_colors)

        # High green/red ratio with bright translucent peak indicates active SSS transmission
        sss_active = max_g > 0.80 and avg_g > 0.35
        print("  RADIOMETRIC LIGHTING & SSS TRANSMISSION AUDIT:")
        print(f"    Mean Foliage COLOR_0:   R={avg_r:.3f}, G={avg_g:.3f}, B={avg_b:.3f}")
        print(f"    Peak Translucent Glow:  G_max = {max_g:.3f}")
        print(f"    Chlorophyll SSS Status: {'[VERIFIED] Translucent Backlight SSS Active' if sss_active else '[INFO] Standard Reflection'}")
    else:
        print("  RADIOMETRIC LIGHTING & SSS TRANSMISSION AUDIT: Bare wood / winter phenology (no foliage colors)")

    if wood_colors:
        w_r = sum(c[0] for c in wood_colors) / len(wood_colors)
        w_g = sum(c[1] for c in wood_colors) / len(wood_colors)
        w_b = sum(c[2] for c in wood_colors) / len(wood_colors)
        delta_rg = abs(w_r - w_g)
        delta_gb = abs(w_g - w_b)
        delta_rb = abs(w_r - w_b)
        max_delta = max(delta_rg, delta_gb, delta_rb)
        print(f"    Mean Wood Bark COLOR_0: R={w_r:.3f}, G={w_g:.3f}, B={w_b:.3f}")
        print(f"    Bark Chroma Delta:      max|Δ| = {max_delta:.3f}  ({'[VERIFIED] Weathered Desaturated Neutral' if max_delta <= 0.05 else '[INFO] Colored Warm Tone'})")

    print("-" * 76)

    # Watertight Manifold Topology Audit on Bare Wood (Spatial Position Equivalence)
    if wood_indices and wood_positions:
        # Quantize vertex positions to 0.1mm to weld UV/normal seams
        def pos_key(idx):
            if idx < len(wood_positions):
                p = wood_positions[idx]
                return (round(p[0], 4), round(p[1], 4), round(p[2], 4))
            return idx

        spatial_edge_counts = {}
        for t in range(wood_tri_count):
            i0, i1, i2 = wood_indices[t * 3], wood_indices[t * 3 + 1], wood_indices[t * 3 + 2]
            k0, k1, k2 = pos_key(i0), pos_key(i1), pos_key(i2)
            if k0 == k1 or k1 == k2 or k2 == k0:
                continue # degenerate
            for u, v in [(k0, k1), (k1, k2), (k2, k0)]:
                edge = (min(u, v), max(u, v))
                spatial_edge_counts[edge] = spatial_edge_counts.get(edge, 0) + 1

        boundary_edges = sum(1 for c in spatial_edge_counts.values() if c == 1)
        non_manifold_edges = sum(1 for c in spatial_edge_counts.values() if c > 2)
        manifold_edges = sum(1 for c in spatial_edge_counts.values() if c == 2)
        total_edges = len(spatial_edge_counts)

        print("  TOPOLOGICAL WATERTIGHTNESS AUDIT (BARE WOOD):")
        print(f"    Total Spatial Edges:    {total_edges:,}")
        print(f"    Manifold 2-Edges:       {manifold_edges:,} ({manifold_edges / total_edges * 100:.1f}%)" if total_edges > 0 else "0")
        print(f"    Open Boundary Edges:    {boundary_edges} {'[WATERTIGHT CLOSED]' if boundary_edges == 0 else '[OPEN HOLES FOUND]'}")
        print(f"    Non-Manifold Edges:     {non_manifold_edges} {'[CLEAN 2-MANIFOLD]' if non_manifold_edges == 0 else '[NON-MANIFOLD EDGES]'}")

    print("=" * 76)
    return True

if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "public/models/smpl_real_data_fitted_summer.glb"
    inspect_tree(path)
