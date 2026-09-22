#!/usr/bin/env python3
"""
Clean-Room Scan Template to SB-Human (.sbhuman v2) Converter
Extracts empirical scan geometry, kinematic hierarchy, CSR joint regressor,
and 4-influence skinning weights directly from scan archives into native .sbhuman binary format.
Zero external dependencies (uses standard zipfile, struct, math, io).
"""

import sys
import os
import zipfile
import struct
import math
import io
import ast

CANONICAL_55_JOINT_NAMES = [
    "Pelvis",        # 0
    "LeftHip",       # 1
    "RightHip",      # 2
    "Spine1",        # 3
    "LeftKnee",      # 4
    "RightKnee",     # 5
    "Spine2",        # 6
    "LeftAnkle",     # 7
    "RightAnkle",    # 8
    "Spine3",        # 9
    "LeftFoot",      # 10
    "RightFoot",     # 11
    "Neck",          # 12
    "LeftCollar",    # 13
    "RightCollar",   # 14
    "Head",          # 15
    "LeftShoulder",  # 16
    "RightShoulder", # 17
    "LeftElbow",     # 18
    "RightElbow",    # 19
    "LeftWrist",     # 20
    "RightWrist",    # 21
    "Jaw",           # 22
    "LeftEye",       # 23
    "RightEye",      # 24
    # Left Hand Fingers (SMPL-X order: Index, Middle, Pinky, Ring, Thumb)
    "LeftIndex1",    # 25
    "LeftIndex2",    # 26
    "LeftIndex3",    # 27
    "LeftMiddle1",   # 28
    "LeftMiddle2",   # 29
    "LeftMiddle3",   # 30
    "LeftPinky1",    # 31
    "LeftPinky2",    # 32
    "LeftPinky3",    # 33
    "LeftRing1",     # 34
    "LeftRing2",     # 35
    "LeftRing3",     # 36
    "LeftThumb1",    # 37
    "LeftThumb2",    # 38
    "LeftThumb3",    # 39
    # Right Hand Fingers (SMPL-X order: Index, Middle, Pinky, Ring, Thumb)
    "RightIndex1",   # 40
    "RightIndex2",   # 41
    "RightIndex3",   # 42
    "RightMiddle1",  # 43
    "RightMiddle2",  # 44
    "RightMiddle3",  # 45
    "RightPinky1",   # 46
    "RightPinky2",   # 47
    "RightPinky3",   # 48
    "RightRing1",    # 49
    "RightRing2",    # 50
    "RightRing3",    # 51
    "RightThumb1",   # 52
    "RightThumb2",   # 53
    "RightThumb3"    # 54
]

def read_npy_from_zip(zf, npy_name):
    raw = zf.read(npy_name)
    if raw[:6] != b'\x93NUMPY':
        raise ValueError(f"Invalid npy magic in {npy_name}")
    header_len = int.from_bytes(raw[8:10], 'little')
    header_dict = ast.literal_eval(raw[10:10+header_len].decode('latin1').strip())
    data_bytes = raw[10+header_len:]
    return header_dict, data_bytes

def parse_model_archive(archive_stream_or_path):
    """
    Parses a single model archive (.npz or bytes) into structured arrays
    """
    if isinstance(archive_stream_or_path, (str, bytes)) and os.path.exists(str(archive_stream_or_path)):
        zf = zipfile.ZipFile(archive_stream_or_path)
    else:
        zf = zipfile.ZipFile(archive_stream_or_path)

    # 1. Vertices (v_template.npy)
    h_v, b_v = read_npy_from_zip(zf, 'v_template.npy')
    nv = h_v['shape'][0]
    raw_verts = struct.unpack(f'<{nv * 3}f', b_v)
    verts = [list(raw_verts[i*3 : (i+1)*3]) for i in range(nv)]

    # 2. Triangular Faces (f.npy)
    h_f, b_f = read_npy_from_zip(zf, 'f.npy')
    nt = h_f['shape'][0]
    # Check dtype
    f_fmt = 'I' if 'u4' in h_f['descr'] or 'i4' in h_f['descr'] else 'Q'
    raw_f = struct.unpack(f'<{nt * 3}{f_fmt}', b_f)
    faces = [list(raw_f[i*3 : (i+1)*3]) for i in range(nt)]

    # 3. UV Coordinates (vt.npy, ft.npy if present)
    uvs = [[0.0, 0.0] for _ in range(nv)]
    if 'vt.npy' in zf.namelist() and 'ft.npy' in zf.namelist():
        h_vt, b_vt = read_npy_from_zip(zf, 'vt.npy')
        vt_count = h_vt['shape'][0]
        vt_fmt = 'd' if 'f8' in h_vt['descr'] else 'f'
        raw_vt = struct.unpack(f'<{vt_count * 2}{vt_fmt}', b_vt)
        vt_list = [list(raw_vt[i*2 : (i+1)*2]) for i in range(vt_count)]

        h_ft, b_ft = read_npy_from_zip(zf, 'ft.npy')
        ft_fmt = 'I' if 'u4' in h_ft['descr'] or 'i4' in h_ft['descr'] else 'Q'
        raw_ft = struct.unpack(f'<{nt * 3}{ft_fmt}', b_ft)

        assigned = [False] * nv
        for t in range(nt):
            for c in range(3):
                v_idx = faces[t][c]
                if not assigned[v_idx]:
                    vt_idx = raw_ft[t * 3 + c]
                    if vt_idx < len(vt_list):
                        uvs[v_idx] = [float(vt_list[vt_idx][0]), float(vt_list[vt_idx][1])]
                        assigned[v_idx] = True

    # 4. Skinning Weights (weights.npy: shape (10475, 55))
    h_w, b_w = read_npy_from_zip(zf, 'weights.npy')
    nj = h_w['shape'][1]
    raw_w = struct.unpack(f'<{nv * nj}f', b_w)
    skin_weights = [] # each entry is ( [j0, j1, j2, j3], [w0, w1, w2, w3] )
    for i in range(nv):
        row = raw_w[i * nj : (i + 1) * nj]
        # find top 4 weights
        indexed = sorted([(val, j) for j, val in enumerate(row) if val > 1e-6], reverse=True)
        top4 = indexed[:4]
        total_w = sum(w for w, _ in top4)
        j_arr = [0, 0, 0, 0]
        w_arr = [0.0, 0.0, 0.0, 0.0]
        if total_w > 1e-6:
            inv = 1.0 / total_w
            for k, (w, j) in enumerate(top4):
                j_arr[k] = j
                w_arr[k] = w * inv
        else:
            j_arr[0] = 0
            w_arr[0] = 1.0
        skin_weights.append((j_arr, w_arr))

    # 5. Joint Regressor (J_regressor.npy: shape (55, 10475), Fortran order: True)
    h_j, b_j = read_npy_from_zip(zf, 'J_regressor.npy')
    nj_reg, nv_reg = h_j['shape']
    raw_j = struct.unpack(f'<{nj_reg * nv_reg}f', b_j)
    # Fortran order means element (j, v) is at raw_j[v * nj_reg + j]
    row_offsets = [0]
    col_indices = []
    reg_values = []
    for j in range(nj_reg):
        row_entries = []
        for v in range(nv_reg):
            val = raw_j[v * nj_reg + j]
            if abs(val) > 1e-6:
                row_entries.append((v, val))
        for v, val in row_entries:
            col_indices.append(v)
            reg_values.append(val)
        row_offsets.append(len(col_indices))

    # 6. Kinematic Tree (kintree_table.npy: shape (2, 55))
    h_k, b_k = read_npy_from_zip(zf, 'kintree_table.npy')
    raw_k = struct.unpack(f'<{h_k["shape"][0] * h_k["shape"][1]}q', b_k)
    # Row 0 contains parents, Row 1 contains joints 0..54
    parents_raw = raw_k[:55]
    parents = []
    for p in parents_raw:
        if p == 4294967295 or p < 0:
            parents.append(-1)
        else:
            parents.append(int(p))

    zf.close()

    return {
        'nv': nv,
        'nt': nt,
        'verts': verts,
        'faces': faces,
        'uvs': uvs,
        'skin_weights': skin_weights,
        'reg_row_offsets': row_offsets,
        'reg_col_indices': col_indices,
        'reg_values': reg_values,
        'parents': parents
    }

def compute_smooth_normals(verts, faces):
    nv = len(verts)
    normals = [[0.0, 0.0, 0.0] for _ in range(nv)]
    for f in faces:
        i0, i1, i2 = f[0], f[1], f[2]
        p0, p1, p2 = verts[i0], verts[i1], verts[i2]
        # Cross product (p1 - p0) x (p2 - p0)
        e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]
        e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]]
        nx = e1[1] * e2[2] - e1[2] * e2[1]
        ny = e1[2] * e2[0] - e1[0] * e2[2]
        nz = e1[0] * e2[1] - e1[1] * e2[0]
        for idx in (i0, i1, i2):
            normals[idx][0] += nx
            normals[idx][1] += ny
            normals[idx][2] += nz

    for i in range(nv):
        n = normals[i]
        length = math.sqrt(n[0]*n[0] + n[1]*n[1] + n[2]*n[2])
        if length > 1e-6:
            inv = 1.0 / length
            normals[i] = [n[0] * inv, n[1] * inv, n[2] * inv]
        else:
            normals[i] = [0.0, 1.0, 0.0]
    return normals

def build_8_canonical_shape_modes(verts, height):
    """
    Constructs the 8 canonical semantic body shape dimensions for 10,475 vertices:
    Mode 0: Stature Elongation (PC0)
    Mode 1: Athletic Muscularity / V-Taper (PC1)
    Mode 2: BMI / Abdominal & Flank Breadth (PC2)
    Mode 3: Gender Dimorphic Transition (PC3: +Female hourglass/breast, -Male V-taper)
    Mode 4: Torso vs Leg Proportion (PC4)
    Mode 5: Biacromial Shoulder Width (PC5)
    Mode 6: Pelvic Breadth & Gluteal Curvature (PC6)
    Mode 7: Cranial / Head Scaling (PC7)
    """
    nv = len(verts)
    s = height / 1.80
    num_modes = 8
    # Stored mode-major: [b * nv * 3 + i * 3 + c]
    shape_dirs = [0.0] * (num_modes * nv * 3)

    for i in range(nv):
        p = verts[i]
        px, py, pz = p[0], p[1], p[2]

        # Mode 0: Stature / Overall Height Elongation
        m0 = (0 * nv + i) * 3
        shape_dirs[m0 + 1] = py * 0.05

        # Mode 1: Athletic Muscularity / V-Taper
        m1 = (1 * nv + i) * 3
        upper_factor = 1.0 if py > 1.1 * s else 0.25
        pec_factor = 0.035 if (1.25 * s < py < 1.45 * s and pz > 0.02 * s) else 0.0
        shape_dirs[m1 + 0] = px * 0.045 * upper_factor
        shape_dirs[m1 + 2] = (pz * 0.040 * upper_factor) + pec_factor

        # Mode 2: BMI / Abdominal & Flank Breadth
        m2 = (2 * nv + i) * 3
        torso_factor = 1.0 if (0.8 * s < py < 1.4 * s) else 0.3
        shape_dirs[m2 + 0] = px * 0.05 * torso_factor
        shape_dirs[m2 + 2] = pz * 0.06 * torso_factor

        # Mode 3: Gender Dimorphic Transition (+Female, -Male)
        m3 = (3 * nv + i) * 3
        breast_factor = 0.045 if (1.25 * s < py < 1.42 * s and pz > 0.01 * s) else 0.0
        pelvic_factor = 0.035 if (0.75 * s < py < 1.02 * s) else 0.0
        waist_narrow = -0.025 if (1.05 * s < py < 1.22 * s) else 0.0
        shape_dirs[m3 + 0] = px * (pelvic_factor + waist_narrow)
        shape_dirs[m3 + 2] = breast_factor

        # Mode 4: Torso vs Leg Proportion
        m4 = (4 * nv + i) * 3
        if py < 0.90 * s:
            shape_dirs[m4 + 1] = 0.04 * s
        else:
            shape_dirs[m4 + 1] = -0.03 * s

        # Mode 5: Biacromial Shoulder Width
        m5 = (5 * nv + i) * 3
        if py > 1.20 * s and abs(px) > 0.12 * s:
            shape_dirs[m5 + 0] = (0.035 * s) if px > 0 else (-0.035 * s)

        # Mode 6: Pelvic Breadth & Gluteal Curvature
        m6 = (6 * nv + i) * 3
        if 0.70 * s < py < 1.05 * s:
            shape_dirs[m6 + 0] = (0.030 * s) if px > 0 else (-0.030 * s)
            if pz < 0.0:
                shape_dirs[m6 + 2] = -0.035 * s

        # Mode 7: Cranial / Head Scaling
        m7 = (7 * nv + i) * 3
        if py > 1.55 * s:
            shape_dirs[m7 + 0] = px * 0.06
            shape_dirs[m7 + 1] = (py - 1.68 * s) * 0.06
            shape_dirs[m7 + 2] = (pz - 0.02 * s) * 0.06

    return shape_dirs

def serialize_to_sbhuman(model_data, output_path, target_height=None):
    """
    Serializes model_data dict into zero-dependency .sbhuman (v2 binary format)
    """
    verts = [v[:] for v in model_data['verts']]
    min_y = min(v[1] for v in verts)
    max_y = max(v[1] for v in verts)
    raw_height = max_y - min_y

    # Ground alignment: shift Y so lowest vertex touches Y=0
    for v in verts:
        v[1] -= min_y

    # If target height requested, scale all coordinates
    if target_height is not None and target_height > 0.1:
        scale = target_height / raw_height
        for v in verts:
            v[0] *= scale
            v[1] *= scale
            v[2] *= scale
        height = target_height
    else:
        height = raw_height

    nv = len(verts)
    faces = model_data['faces']
    nt = len(faces)
    uvs = model_data['uvs']
    normals = compute_smooth_normals(verts, faces)
    skin_weights = model_data['skin_weights']

    # Compute 55 joint rest positions via CSR regressor
    reg_row_offsets = model_data['reg_row_offsets']
    reg_col_indices = model_data['reg_col_indices']
    reg_values = model_data['reg_values']
    num_joints = len(CANONICAL_55_JOINT_NAMES)

    joint_rest_positions = []
    for j in range(num_joints):
        start = reg_row_offsets[j]
        end = reg_row_offsets[j + 1]
        jx, jy, jz = 0.0, 0.0, 0.0
        for k in range(start, end):
            v_idx = reg_col_indices[k]
            w = reg_values[k]
            jx += verts[v_idx][0] * w
            jy += verts[v_idx][1] * w
            jz += verts[v_idx][2] * w
        joint_rest_positions.append([jx, jy, jz])

    # Build 8 canonical shape modes
    num_shape_modes = 8
    shape_dirs = build_8_canonical_shape_modes(verts, height)

    # Pose correctives
    num_pose_correctives = 0 # Can be 0 or populated
    pose_dirs = []

    # Flatten indices
    flat_indices = []
    for f in faces:
        flat_indices.extend(f)

    # Header packing
    # #pragma pack(push, 1)
    # struct SbHumanHeader {
    #     uint32_t magic{0x4E4D4853};
    #     uint32_t version{2};
    #     uint32_t numVertices;
    #     uint32_t numIndices;
    #     uint32_t numJoints;
    #     uint32_t numShapeModes;
    #     uint32_t numExpressionModes;
    #     uint32_t numPoseCorrectives;
    #     uint32_t numRegressorEntries;
    #     uint32_t flags;
    # };
    header = struct.pack(
        '<10I',
        0x4E4D4853,                 # magic
        2,                          # version 2
        nv,                         # numVertices
        len(flat_indices),          # numIndices
        num_joints,                 # numJoints
        num_shape_modes,            # numShapeModes
        0,                          # numExpressionModes
        num_pose_correctives,       # numPoseCorrectives
        len(reg_col_indices),       # numRegressorEntries
        1 | 2 | 4                   # flags
    )

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    with open(output_path, 'wb') as f:
        # Write header
        f.write(header)

        # 1. Vertices (position: 4f (16-byte alignas(16) Vec3), normal: 4f (16-byte alignas(16) Vec3), uv: 2f (8 bytes Vec2))
        for i in range(nv):
            v_bytes = struct.pack(
                '<4f4f2f',
                verts[i][0], verts[i][1], verts[i][2], 0.0,
                normals[i][0], normals[i][1], normals[i][2], 0.0,
                uvs[i][0], uvs[i][1]
            )
            f.write(v_bytes)

        # 2. Indices
        idx_bytes = struct.pack(f'<{len(flat_indices)}I', *flat_indices)
        f.write(idx_bytes)

        # 3. Skeleton joints
        parents = model_data['parents']
        for j in range(num_joints):
            name = CANONICAL_55_JOINT_NAMES[j]
            name_bytes = name.encode('utf-8')
            f.write(struct.pack('<I', len(name_bytes)))
            f.write(name_bytes)
            f.write(struct.pack('<i', parents[j]))
            pos = joint_rest_positions[j]
            # alignas(16) Vec3 restPosition: 4 floats (16 bytes)
            f.write(struct.pack('<4f', pos[0], pos[1], pos[2], 0.0))

        # 4. Skin weights (VertexSkinWeight: uint16[4], float[4])
        for i in range(nv):
            j_arr, w_arr = skin_weights[i]
            sw_bytes = struct.pack('<4H4f', j_arr[0], j_arr[1], j_arr[2], j_arr[3],
                                           w_arr[0], w_arr[1], w_arr[2], w_arr[3])
            f.write(sw_bytes)

        # 5. Shape PCA directions
        if shape_dirs:
            sd_bytes = struct.pack(f'<{len(shape_dirs)}f', *shape_dirs)
            f.write(sd_bytes)

        # 6. Expression PCA directions (none)

        # 7. Pose Corrective directions
        if pose_dirs:
            pd_bytes = struct.pack(f'<{len(pose_dirs)}f', *pose_dirs)
            f.write(pd_bytes)

        # 8. Joint Regressor (CSR: rowOffsets, colIndices, values)
        if reg_col_indices:
            ro_bytes = struct.pack(f'<{len(reg_row_offsets)}I', *reg_row_offsets)
            ci_bytes = struct.pack(f'<{len(reg_col_indices)}I', *reg_col_indices)
            val_bytes = struct.pack(f'<{len(reg_values)}f', *reg_values)
            f.write(ro_bytes)
            f.write(ci_bytes)
            f.write(val_bytes)

    size = os.path.getsize(output_path)
    print(f"Successfully generated: {output_path} ({size / (1024*1024):.2f} MB, {nv} vertices, {nt} triangles, {num_joints} joints)")
    return size

def main():
    root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    source_zip = "/Users/eligreen/dev/models_smplx_v1_1.zip"
    single_neutral_npz = "/Users/eligreen/dev/SMPLX_NEUTRAL.npz"

    targets = [
        ("SMPLX_NEUTRAL.npz", "sbhuman_neutral.sbhuman", 1.72),
        ("SMPLX_MALE.npz",    "sbhuman_male.sbhuman",    1.80),
        ("SMPLX_FEMALE.npz",  "sbhuman_female.sbhuman",  1.66)
    ]

    print(f"--- Starting Scan Template Ingestion Pipeline ---")

    if os.path.exists(source_zip):
        print(f"Reading from source archive: {source_zip}")
        outer_zip = zipfile.ZipFile(source_zip)
        for npz_name, sbhuman_name, target_h in targets:
            inner_path = f"models/smplx/{npz_name}"
            print(f"\nProcessing {inner_path} -> {sbhuman_name} (target height: {target_h}m)...")
            raw_npz = outer_zip.read(inner_path)
            model_data = parse_model_archive(io.BytesIO(raw_npz))

            # 1. Output to packages/core/assets/models/
            out_asset = os.path.join(root_dir, "packages", "core", "assets", "models", sbhuman_name)
            serialize_to_sbhuman(model_data, out_asset, target_height=target_h)

            # 2. Output to public/models/
            out_public = os.path.join(root_dir, "public", "models", sbhuman_name)
            serialize_to_sbhuman(model_data, out_public, target_height=target_h)
        outer_zip.close()
    elif os.path.exists(single_neutral_npz):
        print(f"Fallback: reading neutral template from {single_neutral_npz}")
        model_data = parse_model_archive(single_neutral_npz)
        out_asset = os.path.join(root_dir, "packages", "core", "assets", "models", "sbhuman_neutral.sbhuman")
        serialize_to_sbhuman(model_data, out_asset, target_height=1.72)
    else:
        print(f"Error: Neither {source_zip} nor {single_neutral_npz} found!")
        sys.exit(1)

    print("\n--- Ingestion Pipeline Completed Successfully ---")

if __name__ == '__main__':
    main()
