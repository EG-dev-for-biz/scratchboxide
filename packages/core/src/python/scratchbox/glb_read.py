# ********************************************************************************
# Copyright (C) 2026 Scratchbox LLC. All rights reserved.
#
# This software and associated documentation files are proprietary and confidential
# to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
# of this file, via any medium, is strictly prohibited without explicit written
# permission from Scratchbox LLC.
# ********************************************************************************
"""Reading a GLB back into meshes, so a script can start from an existing model (a staged build's massing, an earlier
script's output) and sculpt, add to and rebuild it, instead of only writing new geometry.

``read_glb(path)`` returns one ``Mesh`` per mesh primitive, each in world space (its node's transform applied, through
the node hierarchy), named after its node, with its vertex normals and first UV set when the file has them and its
material's base colour as the vertex colour. Textures are not read: a mesh comes back in its base colour. Positions,
normals, UVs and indices are read from any accessor layout glTF 2.0 allows (strided or tightly packed, float positions,
8, 16 or 32-bit indices); a primitive without indices is read as a triangle list.
"""

import math as _pymath
import struct
from typing import Dict, List, Optional, Tuple

from .vegetation import _read_glb

_COMPONENT = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
_COUNT = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def _accessor(js: dict, binary: bytes, index: int) -> List[Tuple[float, ...]]:
    acc = js["accessors"][index]
    view = js["bufferViews"][acc["bufferView"]]
    fmt, size = _COMPONENT[acc["componentType"]]
    n = _COUNT[acc["type"]]
    stride = view.get("byteStride") or size * n
    base = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    out = []
    for i in range(acc["count"]):
        out.append(struct.unpack_from("<" + fmt * n, binary, base + i * stride))
    if acc.get("normalized") and fmt != "f":
        scale = float((1 << (8 * size - (1 if fmt.islower() else 0))) - 1)
        out = [tuple(v / scale for v in t) for t in out]
    return out


def _mat_mul(a: List[float], b: List[float]) -> List[float]:
    # column-major 4x4
    return [sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4)) for c in range(4) for r in range(4)]


def _node_matrix(node: dict) -> List[float]:
    if "matrix" in node:
        return [float(v) for v in node["matrix"]]
    tx, ty, tz = node.get("translation", [0.0, 0.0, 0.0])
    qx, qy, qz, qw = node.get("rotation", [0.0, 0.0, 0.0, 1.0])
    sx, sy, sz = node.get("scale", [1.0, 1.0, 1.0])
    r = [
        1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qz * qw), 2 * (qx * qz - qy * qw),
        2 * (qx * qy - qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qx * qw),
        2 * (qx * qz + qy * qw), 2 * (qy * qz - qx * qw), 1 - 2 * (qx * qx + qy * qy),
    ]
    return [r[0] * sx, r[1] * sx, r[2] * sx, 0.0, r[3] * sy, r[4] * sy, r[5] * sy, 0.0, r[6] * sz, r[7] * sz, r[8] * sz, 0.0, tx, ty, tz, 1.0]


def _world_matrices(js: dict) -> Dict[int, List[float]]:
    nodes = js.get("nodes", [])
    identity = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]
    out: Dict[int, List[float]] = {}
    children = {c for n in nodes for c in n.get("children", [])}
    roots = [i for i in range(len(nodes)) if i not in children]
    stack = [(i, identity) for i in roots]
    while stack:
        i, parent = stack.pop()
        m = _mat_mul(parent, _node_matrix(nodes[i]))
        out[i] = m
        stack.extend((c, m) for c in nodes[i].get("children", []))
    return out


def read_glb(path: str, max_triangles: Optional[int] = None) -> list:
    """The meshes of the GLB at ``path``, in world space (see the module docstring). ``max_triangles`` stops reading once
    that many triangles are read (a very large scan), with the meshes read so far."""
    from . import math as _sbmath
    from scratchbox_native.geometry import Mesh

    with open(path, "rb") as f:
        js, binary = _read_glb(f.read())
    worlds = _world_matrices(js)
    meshes = []
    total = 0
    for ni, node in enumerate(js.get("nodes", [])):
        if "mesh" not in node:
            continue
        m4 = worlds.get(ni)
        gm = js["meshes"][node["mesh"]]
        for pi, prim in enumerate(gm.get("primitives", [])):
            if prim.get("mode", 4) != 4 or "POSITION" not in prim.get("attributes", {}):
                continue
            attrs = prim["attributes"]
            pos = _accessor(js, binary, attrs["POSITION"])
            nrm = _accessor(js, binary, attrs["NORMAL"]) if "NORMAL" in attrs else None
            uvs = _accessor(js, binary, attrs["TEXCOORD_0"]) if "TEXCOORD_0" in attrs else None
            idx = [t[0] for t in _accessor(js, binary, prim["indices"])] if "indices" in prim else list(range(len(pos)))
            colour = (1.0, 1.0, 1.0, 1.0)
            if "material" in prim:
                pbr = js["materials"][prim["material"]].get("pbrMetallicRoughness", {})
                colour = tuple(pbr.get("baseColorFactor", colour))
            name = node.get("name") or gm.get("name") or f"mesh_{ni}"
            mesh = Mesh(f"{name}" if len(gm.get("primitives", [])) == 1 else f"{name}_{pi}")
            col = _sbmath.Vec4(*[float(c) for c in colour])
            for k, p in enumerate(pos):
                x, y, z = p
                wx = m4[0] * x + m4[4] * y + m4[8] * z + m4[12]
                wy = m4[1] * x + m4[5] * y + m4[9] * z + m4[13]
                wz = m4[2] * x + m4[6] * y + m4[10] * z + m4[14]
                if nrm:
                    a, b, c = nrm[k]
                    nx, ny, nz = m4[0] * a + m4[4] * b + m4[8] * c, m4[1] * a + m4[5] * b + m4[9] * c, m4[2] * a + m4[6] * b + m4[10] * c
                    L = _pymath.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
                    n3 = _sbmath.Vec3(nx / L, ny / L, nz / L)
                else:
                    n3 = _sbmath.Vec3(0.0, 1.0, 0.0)
                uv = _sbmath.Vec2(float(uvs[k][0]), float(uvs[k][1])) if uvs else _sbmath.Vec2(0.0, 0.0)
                mesh.add_vertex(_sbmath.Vec3(wx, wy, wz), n3, uv, col)
            for t in range(0, len(idx) - 2, 3):
                mesh.add_triangle(int(idx[t]), int(idx[t + 1]), int(idx[t + 2]))
            if not nrm:
                mesh.recompute_normals()
            meshes.append(mesh)
            total += len(idx) // 3
            if max_triangles is not None and total >= max_triangles:
                return meshes
    return meshes
