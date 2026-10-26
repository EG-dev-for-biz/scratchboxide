"""
Scratchbox Agentic 3D Procedural Engine (Python SDK)
Autonomous, headless, real-time procedural creation with cinematic DCC fidelity.
"""


import sys
import os
import json as _json
import math as _py_math
import re as _re
import random as _random
from typing import Any, Dict, Tuple, Optional, Union, List

# Ensure native module is discoverable from both package installations and local build dirs
try:
    import scratchbox_native as _native
except ImportError:
    _cur_dir = os.path.dirname(os.path.abspath(__file__))
    _candidate_dirs = [
        os.path.abspath(os.path.join(_cur_dir, "..", "..", "native", "3d-engine", "build_py"))
    ]
    for d in _candidate_dirs:
        if os.path.exists(d) and d not in sys.path:
            sys.path.insert(0, d)
    try:
        import scratchbox_native as _native
    except ImportError:
        _native = None

from .world import World
Scene = World
from .terrain import Terrain
from .structure import Structure
from .plant import PlantPreset, Flora, create_vegetation
from . import human as _py_human
from .human import (
    Human,
    create_human,
    StudioHuman,
    PoseBone,
    Armature,
    ShapeKeys,
    ShapeKeyBlock,
    PrincipledBsdfMaterial,
    create as create_character
)

# Classical Roman Orders
RomanOrder = None
if _native is not None:
    RomanOrder = getattr(_native, "RomanOrder", None)
    if RomanOrder is None and hasattr(_native, "architecture"):
        RomanOrder = getattr(_native.architecture, "RomanOrder", None)
    if RomanOrder is None and hasattr(_native, "core"):
        RomanOrder = getattr(_native.core, "RomanOrder", None)

math = getattr(_native, "math", None) if _native else None
geometry = getattr(_native, "geometry", None) if _native else None
io = getattr(_native, "io", None) if _native else None
core = getattr(_native, "core", None) if _native else None
shaper = getattr(_native, "shaper", None) if _native else None
composer = getattr(_native, "composer", None) if _native else None
plant = getattr(_native, "plant", None) if _native else None
processing = getattr(_native, "processing", None) if _native else None
topology = getattr(_native, "topology", None) if _native else None
sdf = getattr(_native, "sdf", None) if _native else None
meshops = getattr(_native, "meshops", None) if _native else None
relief = getattr(_native, "relief", None) if _native else None
hair = getattr(_native, "hair", None) if _native else None
rig = getattr(_native, "rig", None) if _native else None

class _HumanModuleWrapper:
    """Unified facade exposing both high-level DCC human objects and native C++20 kinematics."""
    def __init__(self, py_mod, native_mod):
        self._py_mod = py_mod
        self._native_mod = native_mod

    def __getattr__(self, name):
        if hasattr(self._py_mod, name):
            return getattr(self._py_mod, name)
        if self._native_mod and hasattr(self._native_mod, name):
            return getattr(self._native_mod, name)
        raise AttributeError(f"module 'scratchbox.human' has no attribute '{name}'")

    def __dir__(self):
        d = set(dir(self._py_mod))
        if self._native_mod:
            d.update(dir(self._native_mod))
        return sorted(d)

human = _HumanModuleWrapper(_py_human, getattr(_native, "human", None) if _native else None)
random = _random
py_math = _py_math


def _WHITE_VERTEX():
    return math.Vec4(1.0, 1.0, 1.0, 1.0)


def _to_point3(pt):
    if hasattr(pt, "x") and hasattr(pt, "y") and hasattr(pt, "z"):
        return float(pt.x), float(pt.y), float(pt.z)
    if isinstance(pt, (tuple, list)) and len(pt) >= 3:
        return float(pt[0]), float(pt[1]), float(pt[2])
    return 0.0, 0.0, 0.0

# ============================================================================
# 1. ENHANCED MESH CAPABILITIES (Chaining, Multi-Type Args, Aliases)
# ============================================================================
if _native is not None and hasattr(_native, "geometry") and hasattr(_native.geometry, "Mesh"):
    _Mesh = _native.geometry.Mesh
    _orig_translate = _Mesh.translate
    _orig_scale = _Mesh.scale
    _orig_append = _Mesh.append
    _orig_rotate_x = getattr(_Mesh, "rotate_x", None)
    _orig_rotate_y = getattr(_Mesh, "rotate_y", None)
    _orig_rotate_z = getattr(_Mesh, "rotate_z", None)

    def _mesh_translate(self, *args):
        if len(args) == 3:
            _orig_translate(self, math.Vec3(float(args[0]), float(args[1]), float(args[2])))
        elif len(args) == 1:
            a = args[0]
            if isinstance(a, (tuple, list)) and len(a) >= 3:
                _orig_translate(self, math.Vec3(float(a[0]), float(a[1]), float(a[2])))
            else:
                _orig_translate(self, a)
        else:
            raise TypeError(f"translate() takes 1 or 3 arguments ({len(args)} given)")
        return self

    def _mesh_scale(self, *args):
        if len(args) == 3:
            _orig_scale(self, math.Vec3(float(args[0]), float(args[1]), float(args[2])))
        elif len(args) == 1:
            a = args[0]
            if isinstance(a, (int, float)):
                s = float(a)
                _orig_scale(self, math.Vec3(s, s, s))
            elif isinstance(a, (tuple, list)) and len(a) >= 3:
                _orig_scale(self, math.Vec3(float(a[0]), float(a[1]), float(a[2])))
            else:
                _orig_scale(self, a)
        else:
            raise TypeError(f"scale() takes 1 or 3 arguments ({len(args)} given)")
        return self

    def _rebase_factor(part_mat, container_mat):
        """Per-channel factor taking colours drawn with part_mat to the same colours drawn with container_mat."""
        pc = getattr(part_mat, "base_color", None) if part_mat is not None else None
        if pc is None:
            return None
        cc = getattr(container_mat, "base_color", None) if container_mat is not None else None
        if cc is None:
            cc = math.Vec4(1.0, 1.0, 1.0, 1.0)
        def ratio(p, c):
            return float(p) / float(c) if abs(float(c)) > 1e-6 else float(p)
        f = (ratio(pc.x, cc.x), ratio(pc.y, cc.y), ratio(pc.z, cc.z), ratio(pc.w, cc.w))
        if all(abs(v - 1.0) < 1e-6 for v in f):
            return None
        return math.Vec4(*f)

    def _mesh_append(self, other):
        # Track sub-meshes per-instance directly on the C++ Mesh via dynamic_attr
        if not hasattr(self, "_sub_parts"):
            self._sub_parts = []
            if hasattr(self, "vertex_count") and self.vertex_count > 0:
                self._sub_parts.append(self)
        target = other.mesh if hasattr(other, "mesh") else other
        self._sub_parts.append(target)
        if hasattr(target, "_sub_parts") and target._sub_parts:
            for sub in target._sub_parts:
                if sub is not target and sub not in self._sub_parts:
                    self._sub_parts.append(sub)

        # The merged copy is drawn with this container's material, so rebase the part's own material colour
        # onto it (vertex x part colour / container colour): glTF's baseColorFactor x COLOR_0 then gives the
        # part's colour exactly once. Only the merged copy changes; the part keeps its own vertices, since
        # write_glb also exports sub-parts individually with their own materials.
        factor = _rebase_factor(getattr(target, "material", None), getattr(self, "material", None))
        if factor is not None and hasattr(target, "multiply_vertex_colors"):
            copy = _Mesh(getattr(target, "name", "part"))
            _orig_append(copy, target)
            copy.multiply_vertex_colors(factor)
            _orig_append(self, copy)
        else:
            _orig_append(self, target)
        return self

    def _mesh_merge(self, other) -> "scratchbox_native.geometry.Mesh":
        return _mesh_append(self, other)

    def _mesh_rotate_x(self, angle_deg):
        if _orig_rotate_x:
            _orig_rotate_x(self, float(angle_deg))
        return self

    def _mesh_rotate_y(self, angle_deg):
        if _orig_rotate_y:
            _orig_rotate_y(self, float(angle_deg))
        return self

    def _mesh_rotate_z(self, angle_deg):
        if _orig_rotate_z:
            _orig_rotate_z(self, float(angle_deg))
        return self

    _Mesh.translate = _mesh_translate
    _Mesh.scale = _mesh_scale
    _Mesh.append = _mesh_append
    _Mesh.merge = _mesh_merge
    _Mesh.rotate_x = _mesh_rotate_x
    _Mesh.rotate_y = _mesh_rotate_y
    _Mesh.rotate_z = _mesh_rotate_z

    def _mesh_tag(self, tag_name):
        self._mesh_tag_name = str(tag_name)
        return self

    def _mesh_get_tag(self) -> str:
        return getattr(self, "_mesh_tag_name", getattr(self, "name", ""))

    _Mesh.tag = _mesh_tag
    _Mesh.get_tag = _mesh_get_tag

def _parse_color(c):
    if isinstance(c, str):
        hex_str = c.strip().lstrip("#")
        if len(hex_str) == 3:
            r = int(hex_str[0] * 2, 16) / 255.0
            g = int(hex_str[1] * 2, 16) / 255.0
            b = int(hex_str[2] * 2, 16) / 255.0
            return r, g, b, 1.0
        elif len(hex_str) == 6:
            r = int(hex_str[0:2], 16) / 255.0
            g = int(hex_str[2:4], 16) / 255.0
            b = int(hex_str[4:6], 16) / 255.0
            return r, g, b, 1.0
        elif len(hex_str) == 8:
            r = int(hex_str[0:2], 16) / 255.0
            g = int(hex_str[2:4], 16) / 255.0
            b = int(hex_str[4:6], 16) / 255.0
            a = int(hex_str[6:8], 16) / 255.0
            return r, g, b, a
    elif isinstance(c, (tuple, list)):
        if len(c) == 3:
            return float(c[0]), float(c[1]), float(c[2]), 1.0
        elif len(c) >= 4:
            return float(c[0]), float(c[1]), float(c[2]), float(c[3])
    elif hasattr(c, "x") and hasattr(c, "y") and hasattr(c, "z"):
        w = getattr(c, "w", 1.0)
        return float(c.x), float(c.y), float(c.z), float(w)
    return 0.8, 0.8, 0.8, 1.0

# ============================================================================
# 2. ENHANCED PBR MATERIAL & DYNAMIC PRESET RESOLVER
# ============================================================================
if _native is not None and hasattr(_native, "geometry") and hasattr(_native.geometry, "PbrMaterial"):
    _NativePbr = _native.geometry.PbrMaterial

    class PbrMaterialWrapper:
        def __new__(cls, name: str = "defaultMaterial", **kwargs):
            instance = _NativePbr(str(name))
            cls._apply_kwargs(instance, kwargs)
            return instance

        @classmethod
        def _apply_kwargs(cls, mat, kwargs):
            bc = kwargs.get("base_color", kwargs.get("color", None))
            if bc is not None:
                r, g, b, a = _parse_color(bc)
                mat.base_color = math.Vec4(r, g, b, a)

            if "metallic" in kwargs:
                mat.metallic = float(kwargs["metallic"])
            elif "metalness" in kwargs:
                mat.metallic = float(kwargs["metalness"])

            if "roughness" in kwargs:
                mat.roughness = float(kwargs["roughness"])

            if "emissive" in kwargs:
                em = kwargs["emissive"]
                intensity = float(kwargs.get("emissive_intensity", 1.0))
                er, eg, eb, _ = _parse_color(em)
                mat.emissive = math.Vec3(er * intensity, eg * intensity, eb * intensity)

            if "clearcoat" in kwargs:
                mat.clearcoat = float(kwargs["clearcoat"])
            if "ior" in kwargs:
                mat.ior = float(kwargs["ior"])

    for k in dir(_NativePbr):
        if not k.startswith("__"):
            setattr(PbrMaterialWrapper, k, getattr(_NativePbr, k))

    class _PbrMeta(type):
        def __getattr__(cls, name):
            if hasattr(_NativePbr, name):
                return getattr(_NativePbr, name)
            # Dynamic preset synthesizing realistic PBR values from name
            def _dynamic_preset(*args, **kwargs):
                mat = _NativePbr(name)
                nl = name.lower()
                if any(x in nl for x in ("metal", "steel", "chrome", "titan", "iron", "copper", "brass")):
                    mat.metallic = 0.9
                    mat.roughness = 0.25
                    mat.base_color = math.Vec4(0.7, 0.72, 0.75, 1.0)
                elif "glass" in nl:
                    mat.metallic = 0.0
                    mat.roughness = 0.05
                    mat.ior = 1.52
                    mat.base_color = math.Vec4(0.9, 0.95, 1.0, 0.2)
                elif "plastic" in nl:
                    mat.metallic = 0.0
                    mat.roughness = 0.4
                    mat.base_color = math.Vec4(0.1, 0.1, 0.1, 1.0) if "black" in nl else math.Vec4(0.8, 0.8, 0.8, 1.0)
                elif any(x in nl for x in ("clay", "plaster", "matte_grey", "studio_grey")):
                    mat.metallic = 0.0
                    mat.roughness = 0.85
                    mat.base_color = math.Vec4(0.55, 0.57, 0.60, 1.0)
                elif any(x in nl for x in ("car_paint", "paint", "gloss")):
                    mat.metallic = 0.8
                    mat.roughness = 0.15
                    mat.clearcoat = 1.0
                    mat.base_color = math.Vec4(0.85, 0.05, 0.08, 1.0)
                elif any(x in nl for x in ("rubber", "tire")):
                    mat.metallic = 0.0
                    mat.roughness = 0.92
                    mat.base_color = math.Vec4(0.08, 0.08, 0.08, 1.0)
                elif any(x in nl for x in ("stone", "rock", "concrete", "basalt", "travertine")):
                    mat.metallic = 0.05
                    mat.roughness = 0.85
                    mat.base_color = math.Vec4(0.6, 0.6, 0.6, 1.0)
                else:
                    mat.metallic = 0.1
                    mat.roughness = 0.7
                    mat.base_color = math.Vec4(0.7, 0.7, 0.7, 1.0)
                PbrMaterialWrapper._apply_kwargs(mat, kwargs)
                return mat
            return _dynamic_preset

    PbrMaterial = _PbrMeta("PbrMaterial", (), dict(PbrMaterialWrapper.__dict__))

    def _set_base_color(self, color):
        if isinstance(color, (tuple, list)):
            if len(color) == 3:
                self.base_color = math.Vec4(float(color[0]), float(color[1]), float(color[2]), 1.0)
            elif len(color) >= 4:
                self.base_color = math.Vec4(float(color[0]), float(color[1]), float(color[2]), float(color[3]))
        else:
            self.base_color = color

    _NativePbr.set_base_color = _set_base_color
    _NativePbr.set_color = _set_base_color
    _native.geometry.PbrMaterial = PbrMaterial
    geometry.PbrMaterial = PbrMaterial

    _NativeMesh = getattr(_native.geometry, "Mesh", None)
    if _NativeMesh is None:
        _NativeMesh = getattr(_native.geometry, "ScratchboxMesh", None)

    if _NativeMesh is not None:
        def _mesh_align_to_terrain(self, terrain, offset_z=0.2) -> "scratchbox_native.geometry.Mesh":
            min_x, max_x = 1e9, -1e9
            min_z, max_z = 1e9, -1e9
            min_y = 1e9
            if hasattr(self, "vertices") and self.vertices:
                for v in self.vertices:
                    pos = v.position
                    px = pos.x if hasattr(pos, "x") else pos[0]
                    py = pos.y if hasattr(pos, "y") else pos[1]
                    pz = pos.z if hasattr(pos, "z") else pos[2]
                    if px < min_x: min_x = px
                    if px > max_x: max_x = px
                    if pz < min_z: min_z = pz
                    if pz > max_z: max_z = pz
                    if py < min_y: min_y = py

            cx = (min_x + max_x) * 0.5 if min_x < 1e8 else 0.0
            cz = (min_z + max_z) * 0.5 if min_z < 1e8 else 0.0
            half_w = (max_x - min_x) * 0.5 if min_x < 1e8 else 1.0
            half_l = (max_z - min_z) * 0.5 if min_z < 1e8 else 1.0

            sample_pts = [
                (cx, cz),
                (cx - half_w, cz - half_l),
                (cx + half_w, cz - half_l),
                (cx - half_w, cz + half_l),
                (cx + half_w, cz + half_l),
                (cx, cz - half_l),
                (cx, cz + half_l),
                (cx - half_w, cz),
                (cx + half_w, cz)
            ]

            ground_elevations = [terrain.sample_height(x, z) for x, z in sample_pts] if hasattr(terrain, "sample_height") else [0.0]
            target_ground_y = max(ground_elevations) if ground_elevations else 0.0
            if min_y > 1e8: min_y = 0.0

            delta_y = (target_ground_y + float(offset_z)) - min_y
            self.translate(math.Vec3(0.0, delta_y, 0.0))
            return self

        def _mesh_apply_material(self, mat):
            # write_glb exports merged sub-parts individually, so the material must reach each of them too.
            # glTF renders baseColorFactor x COLOR_0: the material carries the colour, so the vertex colours
            # are reset to white (clearing primitive default tints) rather than painted with the same colour,
            # which squared it. Per-vertex shading baked afterwards (AO, weathering) multiplies onto white.
            for target in [self] + [p for p in (getattr(self, "_sub_parts", None) or []) if p is not self]:
                target.material = mat
                if mat is not None and hasattr(target, "set_color"):
                    target.set_color(_WHITE_VERTEX())
            return self

        _NativeMesh.align_to_terrain = _mesh_align_to_terrain
        _NativeMesh.apply_material = _mesh_apply_material
        _NativeMesh.set_material = _mesh_apply_material

        # Fluent Non-Linear Deformers (Taper, Twist, Bend, Bulge, Displace)
        def _mesh_taper(self, factor=0.5, axis=1):
            if _native and hasattr(_native, "shaper") and hasattr(_native.shaper, "taper"):
                ax_idx = 0 if axis in ("x", "X", 0) else (1 if axis in ("y", "Y", 1) else 2)
                _native.shaper.taper(self, ax_idx, float(factor))
            return self

        def _mesh_twist(self, angle_deg=45.0, axis=1):
            if _native and hasattr(_native, "shaper") and hasattr(_native.shaper, "twist"):
                ax_idx = 0 if axis in ("x", "X", 0) else (1 if axis in ("y", "Y", 1) else 2)
                _native.shaper.twist(self, ax_idx, float(angle_deg))
            return self

        def _mesh_bend(self, angle_deg=30.0, radius=2.0, main_axis=1, bend_axis=0):
            if _native and hasattr(_native, "shaper") and hasattr(_native.shaper, "bend"):
                m_ax = 0 if main_axis in ("x", "X", 0) else (1 if main_axis in ("y", "Y", 1) else 2)
                b_ax = 0 if bend_axis in ("x", "X", 0) else (1 if bend_axis in ("y", "Y", 1) else 2)
                _native.shaper.bend(self, m_ax, b_ax, float(angle_deg), float(radius))
            return self

        def _mesh_bulge(self, *args, **kwargs):
            if _native and hasattr(_native, "shaper") and hasattr(_native.shaper, "bulge"):
                if len(args) == 2 and isinstance(args[0], (int, float)) and isinstance(args[1], (int, float)):
                    c = math.Vec3(0.0, 0.0, 0.0)
                    strength = float(args[0])
                    radius = 1.0
                    power = 2.0
                elif len(args) == 1 and isinstance(args[0], (int, float)):
                    c = math.Vec3(0.0, 0.0, 0.0)
                    strength = float(args[0])
                    radius = 1.0
                    power = 2.0
                else:
                    center = args[0] if len(args) > 0 else kwargs.get("center", (0.0, 0.0, 0.0))
                    radius = args[1] if len(args) > 1 else kwargs.get("radius", 1.0)
                    strength = args[2] if len(args) > 2 else kwargs.get("strength", 0.3)
                    power = args[3] if len(args) > 3 else kwargs.get("power", 2.0)
                    if isinstance(center, (tuple, list)) and len(center) >= 3:
                        c = math.Vec3(float(center[0]), float(center[1]), float(center[2]))
                    elif isinstance(center, (int, float)):
                        c = math.Vec3(0.0, 0.0, 0.0)
                        strength = float(center)
                    elif hasattr(center, "x") and hasattr(center, "y") and hasattr(center, "z"):
                        c = center
                    else:
                        c = math.Vec3(0.0, 0.0, 0.0)
                _native.shaper.bulge(self, c, float(radius), float(strength), float(power))
            return self

        def _mesh_displace(self, frequency=2.0, amplitude=0.05, **kwargs):
            freq = float(kwargs.get("freq", frequency))
            amp = float(kwargs.get("amp", amplitude))
            if hasattr(self, "displace_along_normals"):
                self.displace_along_normals(freq, amp)
            return self

        def _mesh_subtract(self, other) -> "scratchbox_native.geometry.Mesh":
            if other is None:
                return self
            b_self = getattr(self, "bounds", None)
            b_other = getattr(other, "bounds", None)
            if b_self and b_other and hasattr(b_self, "intersects") and not b_self.intersects(b_other):
                return self

            if hasattr(self, "slice_by_plane") and b_other is not None and b_self is not None:
                c_other = b_other.center() if callable(b_other.center) else b_other.center
                c_self = b_self.center() if callable(b_self.center) else b_self.center
                delta_x = c_other.x - c_self.x
                delta_y = c_other.y - c_self.y
                delta_z = c_other.z - c_self.z
                length = (delta_x**2 + delta_y**2 + delta_z**2)**0.5
                if length > 1e-4 and math is not None:
                    normal = math.Vec3(delta_x / length, delta_y / length, delta_z / length)
                    b_size = b_other.size() if callable(b_other.size) else b_other.size
                    cut_plane_pt = math.Vec3(
                        c_other.x - normal.x * (b_size.x * 0.4),
                        c_other.y - normal.y * (b_size.y * 0.4),
                        c_other.z - normal.z * (b_size.z * 0.4),
                    )
                    self.slice_by_plane(cut_plane_pt, normal, True, True)

            if hasattr(self, "recompute_smooth_normals"):
                self.recompute_smooth_normals()
            if hasattr(self, "recompute_bounds"):
                self.recompute_bounds()
            return self

        _orig_taubin_smooth = getattr(_NativeMesh, "taubin_smooth", None)
        _orig_decimate_qem = getattr(_NativeMesh, "decimate_qem", None)
        _orig_poisson_sample = getattr(_NativeMesh, "poisson_sample", None)
        _orig_fill_holes = getattr(_NativeMesh, "fill_holes", None)
        _orig_isotropic_remesh = getattr(_NativeMesh, "isotropic_remesh", None)
        _orig_bake_cavity_ao = getattr(_NativeMesh, "bake_cavity_ao", None)
        _orig_slice_by_plane = getattr(_NativeMesh, "slice_by_plane", None)
        _orig_clean = getattr(_NativeMesh, "clean", None)
        _orig_hausdorff_distance = getattr(_NativeMesh, "hausdorff_distance", None)

        def _mesh_taubin_smooth(self, iterations=10, lambda_val=0.5, mu_val=-0.53, preserve_boundaries=True):
            if _orig_taubin_smooth:
                _orig_taubin_smooth(self, int(iterations), float(lambda_val), float(mu_val), bool(preserve_boundaries))
            return self

        def _mesh_decimate(self, ratio=0.5, target_triangles=0, **kwargs):
            t_tri = int(kwargs.get("target_triangles", target_triangles))
            r = float(kwargs.get("target_ratio", ratio))
            max_err = float(kwargs.get("max_error", 1e9))
            pres_b = bool(kwargs.get("preserve_boundary", True))
            if _orig_decimate_qem:
                _orig_decimate_qem(self, t_tri, r, max_err, pres_b)
            return self

        def _mesh_poisson_sample(self, count=100, min_distance=0.0, seed=42):
            if _orig_poisson_sample:
                return _orig_poisson_sample(self, int(count), float(min_distance), int(seed))
            return []

        def _mesh_fill_holes(self, max_hole_edges=64):
            if _orig_fill_holes:
                _orig_fill_holes(self, int(max_hole_edges))
            return self

        def _mesh_isotropic_remesh(self, target_edge_length=0.25, iterations=4, crease_angle_deg=45.0):
            if _orig_isotropic_remesh:
                _orig_isotropic_remesh(self, float(target_edge_length), int(iterations), float(crease_angle_deg))
            return self

        def _mesh_bake_cavity_ao(self, intensity=0.65):
            if _orig_bake_cavity_ao:
                _orig_bake_cavity_ao(self, float(intensity))
            return self

        _orig_compute_curvature_ao = getattr(_NativeMesh, "compute_curvature_ao", None)
        def _mesh_compute_curvature_ao(self, intensity=0.65):
            if _orig_compute_curvature_ao:
                for target in [self] + [p for p in (getattr(self, "_sub_parts", None) or []) if p is not self]:
                    _orig_compute_curvature_ao(target, float(intensity))
            elif hasattr(self, "bake_cavity_ao"):
                self.bake_cavity_ao(intensity)
            return self

        def _mesh_slice_by_plane(self, plane_point=(0.0, 0.0, 0.0), plane_normal=(0.0, 1.0, 0.0), keep_positive=True, cap_cut=True):
            if _orig_slice_by_plane:
                pp = math.Vec3(float(plane_point[0]), float(plane_point[1]), float(plane_point[2])) if isinstance(plane_point, (tuple, list)) else plane_point
                pn = math.Vec3(float(plane_normal[0]), float(plane_normal[1]), float(plane_normal[2])) if isinstance(plane_normal, (tuple, list)) else plane_normal
                _orig_slice_by_plane(self, pp, pn, bool(keep_positive), bool(cap_cut))
            return self

        def _mesh_clean(self, weld_epsilon=1e-5):
            if _orig_clean:
                _orig_clean(self, float(weld_epsilon))
            return self

        def _mesh_hausdorff_distance(self, other, samples=500):
            if _orig_hausdorff_distance:
                target = other.mesh if hasattr(other, "mesh") else other
                return _orig_hausdorff_distance(self, target, int(samples))
            return None

        def _mesh_snap_to(self, target, face="top", clearance=0.0, offset=(0.0, 0.0, 0.0)):
            if _native and hasattr(_native, "composer") and hasattr(_native.composer, "SpatialConstraintSolver"):
                solver = _native.composer.SpatialConstraintSolver()
                t_mesh = target.mesh if hasattr(target, "mesh") else target
                solver.register_mesh("target", t_mesh)
                solver.register_mesh("self", self)
                off = math.Vec3(float(offset[0]), float(offset[1]), float(offset[2])) if isinstance(offset, (tuple, list)) else offset
                solver.add_constraint("self", "attached_to_surface", "target", str(face), float(clearance), off)
                solver.solve(0)
            return self

        def _mesh_ground_on(self, target, clearance=0.0) -> "scratchbox_native.geometry.Mesh":
            if _native and hasattr(_native, "composer") and hasattr(_native.composer, "SpatialConstraintSolver"):
                solver = _native.composer.SpatialConstraintSolver()
                solver.register_mesh("self", self)
                t_mesh = target.mesh if hasattr(target, "mesh") else target
                if solver.ground_on_terrain("self", t_mesh, float(clearance)):
                    return self
            return self.snap_to(target, face="top", clearance=clearance)

        _NativeMesh.taper = _mesh_taper
        _NativeMesh.twist = _mesh_twist
        _NativeMesh.bend = _mesh_bend
        _NativeMesh.bulge = _mesh_bulge
        _NativeMesh.displace = _mesh_displace
        _NativeMesh.subtract = _mesh_subtract
        _NativeMesh.taubin_smooth = _mesh_taubin_smooth
        _NativeMesh.decimate = _mesh_decimate
        _NativeMesh.decimate_qem = _mesh_decimate
        _NativeMesh.poisson_sample = _mesh_poisson_sample
        _NativeMesh.fill_holes = _mesh_fill_holes
        _NativeMesh.isotropic_remesh = _mesh_isotropic_remesh
        _NativeMesh.bake_cavity_ao = _mesh_bake_cavity_ao
        _NativeMesh.compute_curvature_ao = _mesh_compute_curvature_ao
        _NativeMesh.bake_curvature_ao = _mesh_compute_curvature_ao
        _NativeMesh.slice_by_plane = _mesh_slice_by_plane
        _NativeMesh.slice = _mesh_slice_by_plane
        _NativeMesh.clean = _mesh_clean
        _NativeMesh.hausdorff_distance = _mesh_hausdorff_distance
        _NativeMesh.snap_to = _mesh_snap_to
        _NativeMesh.ground_on = _mesh_ground_on
        _NativeMesh.tag = _mesh_tag
        _NativeMesh.get_tag = _mesh_get_tag

# ============================================================================
# 3. PRIMITIVE FACTORY HELPERS
# ============================================================================
if _native is not None and hasattr(_native, "geometry"):
    _geom = _native.geometry

    _orig_create_studio_pedestal = getattr(_geom, "create_studio_pedestal", None)
    def create_studio_pedestal(radius=4.0, height=0.25, bevel=0.04, bevel_radius=None, segments=64, **kwargs):
        br = bevel_radius if bevel_radius is not None else bevel
        if _orig_create_studio_pedestal:
            return _orig_create_studio_pedestal(float(radius), float(height), float(br), int(segments))
        raise RuntimeError("Native create_studio_pedestal not available")
    _geom.create_studio_pedestal = create_studio_pedestal

    def _resolve_color_and_material(color=None, material=None, default_color=None):
        mat = material
        c = color
        if c is not None and hasattr(c, "roughness"):
            mat = c
            c = getattr(c, "base_color", None)
        if mat is not None and c is None:
            c = getattr(mat, "base_color", None)

        if c is not None:
            if isinstance(c, (tuple, list)) and len(c) >= 3:
                vec_c = math.Vec4(float(c[0]), float(c[1]), float(c[2]), float(c[3]) if len(c) > 3 else 1.0)
            elif isinstance(c, (int, float)):
                val = float(c)
                vec_c = math.Vec4(val, val, val, 1.0)
            elif hasattr(c, "x") and hasattr(c, "y") and hasattr(c, "z") and hasattr(c, "w"):
                vec_c = c
            else:
                vec_c = c
        else:
            vec_c = default_color if default_color is not None else math.Vec4(0.8, 0.8, 0.8, 1.0)
        return vec_c, mat

    def _finish_primitive(mesh, color, mat):
        """Give a new primitive its requested colour exactly once.

        glTF renders baseColorFactor x COLOR_0, so the colour lives in the material and the vertex
        colours stay white; a colour passed without a material becomes this mesh's own material colour.
        """
        if mat is not None and hasattr(mesh, "apply_material"):
            mesh.apply_material(mat)
        elif color is not None and hasattr(mesh, "set_color"):
            vec_c, _ = _resolve_color_and_material(color, None)
            mesh.material.base_color = vec_c
            mesh.set_color(_WHITE_VERTEX())
        return mesh

    _orig_create_cylinder = getattr(_geom, "create_cylinder", None)
    def create_cylinder(radius_top=1.0, radius_bottom=1.0, height=2.0, segments=24, color=None, material=None, capped=True, *, radius=None, **kwargs):
        rt = float(radius if radius is not None else radius_top)
        rb = float(radius if radius is not None else radius_bottom)
        c, mat = _resolve_color_and_material(color, material, default_color=math.Vec4(0.8, 0.8, 0.8, 1.0))
        if _orig_create_cylinder:
            mesh = _orig_create_cylinder(rt, rb, float(height), int(segments), c, bool(capped))
            return _finish_primitive(mesh, color, mat)
        raise RuntimeError("Native create_cylinder not available")
    _geom.create_cylinder = create_cylinder

    def create_cone(radius=1.0, height=2.0, segments=24, color=None, material=None, **kwargs) -> "scratchbox_native.geometry.Mesh":
        return create_cylinder(radius_top=0.0, radius_bottom=radius, height=height, segments=segments, color=color, material=material, **kwargs)
    _geom.create_cone = create_cone

    _orig_create_plane = getattr(_geom, "create_plane", None)
    def create_plane(width=2.0, height=2.0, depth=None, seg_x=4, seg_y=4, segments=None, width_segments=None, depth_segments=None, size=None, color=None, material=None, **kwargs):
        if size is not None:
            if isinstance(size, (int, float)):
                width, depth = float(size), float(size)
            elif isinstance(size, (tuple, list)):
                width, depth = float(size[0]), float(size[-1])
            else:
                width, depth = float(size.x), float(size.z)
        h = float(depth if depth is not None else height)
        sx = int(segments if segments is not None else (width_segments if width_segments is not None else seg_x))
        sy = int(segments if segments is not None else (depth_segments if depth_segments is not None else seg_y))
        _, mat = _resolve_color_and_material(color, material)
        if _orig_create_plane:
            mesh = _orig_create_plane(float(width), h, sx, sy)
            return _finish_primitive(mesh, color, mat)
        raise RuntimeError("Native create_plane not available")
    _geom.create_plane = create_plane

    _orig_create_box = getattr(_geom, "create_box", None)
    def create_box(*args, **kwargs):
        size = None
        color = None
        material = kwargs.get("material")
        if len(args) == 3 and all(isinstance(a, (int, float)) for a in args):
            s = math.Vec3(float(args[0]), float(args[1]), float(args[2]))
            color = kwargs.get("color")
        elif len(args) == 4 and all(isinstance(a, (int, float)) for a in args[:3]):
            s = math.Vec3(float(args[0]), float(args[1]), float(args[2]))
            color = args[3]
        else:
            if len(args) >= 1:
                size = args[0]
            if len(args) >= 2:
                color = args[1]
            if size is None:
                size = kwargs.get("size")
            if color is None:
                color = kwargs.get("color")

            if size is not None:
                if isinstance(size, (tuple, list)) and len(size) >= 3:
                    s = math.Vec3(float(size[0]), float(size[1]), float(size[2]))
                elif isinstance(size, (int, float)):
                    val = float(size)
                    s = math.Vec3(val, val, val)
                elif hasattr(size, "x") and hasattr(size, "y") and hasattr(size, "z"):
                    s = size
                else:
                    s = size
            else:
                w = kwargs.get("width", 1.0)
                h = kwargs.get("height", 1.0)
                d = kwargs.get("depth", 1.0)
                s = math.Vec3(float(w), float(h), float(d))

        c, mat = _resolve_color_and_material(color, material, default_color=math.Vec4(0.8, 0.8, 0.8, 1.0))

        if _orig_create_box:
            mesh = _orig_create_box(s, c)
            return _finish_primitive(mesh, color, mat)
        raise RuntimeError("Native create_box not available")
    _geom.create_box = create_box
    _geom.create_cube = create_box
    create_cube = create_box

    _orig_create_sphere = getattr(_geom, "create_sphere", None)
    def create_sphere(radius=1.0, rings=16, sectors=32, color=None, segments=None, material=None, **kwargs):
        r = int(segments if segments is not None else rings)
        s = int(segments if segments is not None else sectors)
        c, mat = _resolve_color_and_material(color, material, default_color=math.Vec4(0.9, 0.3, 0.3, 1.0))
        if _orig_create_sphere:
            mesh = _orig_create_sphere(float(radius), r, s, c)
            return _finish_primitive(mesh, color, mat)
        raise RuntimeError("Native create_sphere not available")
    _geom.create_sphere = create_sphere

    def _to_vec3(val, default=(1.0, 1.0, 1.0)):
        if val is None:
            return math.Vec3(float(default[0]), float(default[1]), float(default[2]))
        if hasattr(val, "x") and hasattr(val, "y") and hasattr(val, "z"):
            return math.Vec3(float(val.x), float(val.y), float(val.z))
        if isinstance(val, (int, float)):
            f = float(val)
            return math.Vec3(f, f, f)
        if isinstance(val, (tuple, list)):
            if len(val) >= 3:
                return math.Vec3(float(val[0]), float(val[1]), float(val[2]))
            if len(val) == 2:
                return math.Vec3(float(val[0]), float(val[1]), 1.0)
            if len(val) == 1:
                return math.Vec3(float(val[0]), float(val[0]), float(val[0]))
        return math.Vec3(float(default[0]), float(default[1]), float(default[2]))

    _orig_create_beveled_box = getattr(_geom, "create_beveled_box", None)
    def create_beveled_box(size=(1.0, 1.0, 1.0), bevel=0.02, color=None, material=None, **kwargs):
        s = _to_vec3(size)
        c, mat = _resolve_color_and_material(color, material, default_color=math.Vec4(0.8, 0.8, 0.8, 1.0))
        b = float(kwargs.get("bevel_radius", bevel))
        if _orig_create_beveled_box:
            mesh = _orig_create_beveled_box(s, b, c)
            return _finish_primitive(mesh, color, mat)
        raise RuntimeError("Native create_beveled_box not available")
    _geom.create_beveled_box = create_beveled_box

    _orig_create_subdivided_box = getattr(_geom, "create_subdivided_box", None)
    def create_subdivided_box(size=(1.0, 1.0, 1.0), subdivisions=4, color=None, material=None, **kwargs):
        s = _to_vec3(size)
        c, mat = _resolve_color_and_material(color, material, default_color=math.Vec4(0.8, 0.8, 0.8, 1.0))
        if isinstance(subdivisions, (tuple, list)) and len(subdivisions) >= 3:
            sx, sy, sz = int(subdivisions[0]), int(subdivisions[1]), int(subdivisions[2])
        else:
            sub = int(subdivisions)
            sx, sy, sz = sub, sub, sub
        if _orig_create_subdivided_box:
            mesh = _orig_create_subdivided_box(s, sx, sy, sz, c)
            return _finish_primitive(mesh, color, mat)
        raise RuntimeError("Native create_subdivided_box not available")
    _geom.create_subdivided_box = create_subdivided_box

    _orig_create_envelope = getattr(_geom, "create_envelope", None)
    def create_envelope(bounds=(1.0, 0.3, 1.5), crown=0.25, slope=0.3, center_dip=0.0, grid=(16, 16), color=None, material=None, **kwargs):
        b = _to_vec3(bounds)
        c, mat = _resolve_color_and_material(color, material, default_color=math.Vec4(0.8, 0.85, 0.9, 1.0))
        gx = int(grid[0] if isinstance(grid, (tuple, list)) else grid)
        gz = int(grid[1] if isinstance(grid, (tuple, list)) and len(grid) > 1 else gx)
        cr = float(kwargs.get("transverse_crown", crown))
        sl = float(kwargs.get("longitudinal_slope", slope))
        cd = float(kwargs.get("center_channel", center_dip))
        if _orig_create_envelope:
            mesh = _orig_create_envelope(b, cr, sl, cd, gx, gz, c)
            return _finish_primitive(mesh, color, mat)
        raise RuntimeError("Native create_envelope not available")
    _geom.create_envelope = create_envelope

    _orig_create_arched_blister = getattr(_geom, "create_arched_blister", None)
    def create_arched_blister(bounds=(0.35, 0.45, 0.9), arch_radius=0.4, swell=0.08, side=1.0, grid=(16, 8), color=None, material=None, **kwargs):
        b = _to_vec3(bounds)
        c, mat = _resolve_color_and_material(color, material, default_color=math.Vec4(0.8, 0.85, 0.9, 1.0))
        gphi = int(grid[0] if isinstance(grid, (tuple, list)) else grid)
        gw = int(grid[1] if isinstance(grid, (tuple, list)) and len(grid) > 1 else 8)
        ar = float(kwargs.get("radius", arch_radius))
        sw = float(kwargs.get("bulge", swell))
        ss = float(kwargs.get("side_sign", side))
        if _orig_create_arched_blister:
            mesh = _orig_create_arched_blister(b, ar, sw, gphi, gw, ss, c)
            return _finish_primitive(mesh, color, mat)
        raise RuntimeError("Native create_arched_blister not available")
    _geom.create_arched_blister = create_arched_blister

    _orig_create_lathe = getattr(_geom, "create_lathe", None)
    def create_lathe(profile, segments=32, total_angle_rad=None, color=None, material=None, **kwargs):
        c, mat = _resolve_color_and_material(color, material, default_color=math.Vec4(0.8, 0.85, 0.9, 1.0))
        prof_vec = []
        for p in profile:
            if hasattr(p, "x") and hasattr(p, "y"):
                prof_vec.append(math.Vec2(float(p.x), float(p.y)))
            elif isinstance(p, (tuple, list)) and len(p) >= 2:
                prof_vec.append(math.Vec2(float(p[0]), float(p[1])))
        seg = int(segments)
        ang = float(total_angle_rad if total_angle_rad is not None else (math.TWO_PI if hasattr(math, "TWO_PI") else 6.283185307))
        if _orig_create_lathe:
            mesh = _orig_create_lathe(prof_vec, seg, ang, c)
            return _finish_primitive(mesh, color, mat)
        raise RuntimeError("Native create_lathe not available")
    _geom.create_lathe = create_lathe

    _orig_create_loft = getattr(_geom, "create_loft", None)
    def create_loft(slices, close_ends=True, color=None, material=None, **kwargs):
        c, mat = _resolve_color_and_material(color, material, default_color=math.Vec4(0.8, 0.85, 0.9, 1.0))
        slices_vec = []
        for slice_pts in slices:
            s_vec = []
            for p in slice_pts:
                if hasattr(p, "x") and hasattr(p, "y") and hasattr(p, "z"):
                    s_vec.append(math.Vec3(float(p.x), float(p.y), float(p.z)))
                elif isinstance(p, (tuple, list)) and len(p) >= 3:
                    s_vec.append(math.Vec3(float(p[0]), float(p[1]), float(p[2])))
            slices_vec.append(s_vec)
        if _orig_create_loft:
            mesh = _orig_create_loft(slices_vec, bool(close_ends), c)
            return _finish_primitive(mesh, color, mat)
        raise RuntimeError("Native create_loft not available")
    _geom.create_loft = create_loft

    def create_form(bounds=(1.0, 1.0, 1.0), curvature=0.0, bevel=0.02, axis_of_revolution=None, crown=0.25, slope=0.3, center_dip=0.0, color=None, material=None, **kwargs) -> "scratchbox_native.geometry.Mesh":
        """Universal ADA Form Generator: Maps physical continuous parameters to the optimal 3D geometry engine."""
        b = _to_vec3(bounds)
        c, mat = _resolve_color_and_material(color, material)
        
        if axis_of_revolution is not None:
            radius = max(b.x, b.z) * 0.5
            height = b.y
            segs = int(kwargs.get("segments", 32))
            prof = [math.Vec2(0.0, -height*0.5), math.Vec2(radius, -height*0.5), math.Vec2(radius, height*0.5), math.Vec2(0.0, height*0.5)]
            return create_lathe(prof, segments=segs, color=c, material=mat)
            
        if curvature <= 0.001:
            bev = float(kwargs.get("bevel_radius", bevel))
            return create_beveled_box(size=b, bevel=bev, color=c, material=mat)
        else:
            cr = float(crown if crown is not None else curvature)
            sl = float(slope if slope is not None else 0.0)
            dip = float(center_dip if center_dip is not None else 0.0)
            gx = int(kwargs.get("grid_x", 16))
            gz = int(kwargs.get("grid_z", 16))
            return create_envelope(bounds=b, crown=cr, slope=sl, center_dip=dip, grid=(gx, gz), color=c, material=mat)
    _geom.create_form = create_form

    def create_catenary_cable(start=(0, 0, 0), end=(10, 0, 0), sag=1.2, radius=0.03, segments=16, color=None, **kwargs) -> "scratchbox_native.geometry.Mesh":
        """Constructs a catenary hanging curve cable between two 3D anchor points."""
        sx, sy, sz = _to_point3(start)
        ex, ey, ez = _to_point3(end)
        cable_mesh = _NativeMesh("CatenaryCable")
        seg_cnt = max(4, int(segments))
        pts = []
        for i in range(seg_cnt + 1):
            t = float(i) / float(seg_cnt)
            # Linear interpolation
            px = sx + (ex - sx) * t
            pz = sz + (ez - sz) * t
            # Catenary parabolic drop
            linear_y = sy + (ey - sy) * t
            catenary_drop = 4.0 * float(sag) * t * (1.0 - t)
            py = linear_y - catenary_drop
            pts.append((px, py, pz))

        # Build consecutive cylinder links
        for i in range(seg_cnt):
            p0 = pts[i]
            p1 = pts[i+1]
            dx, dy, dz = p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]
            seg_len = _py_math.sqrt(dx*dx + dy*dy + dz*dz)
            if seg_len < 1e-4: continue
            cyl = create_cylinder(radius=radius, height=seg_len, segments=8, color=color)
            # Midpoint position
            mx, my, mz = (p0[0] + p1[0]) * 0.5, (p0[1] + p1[1]) * 0.5, (p0[2] + p1[2]) * 0.5
            # Align cylinder (+Y axis) to segment vector (dx, dy, dz)
            pitch = _py_math.atan2(_py_math.sqrt(dx*dx + dz*dz), dy) if dy != 0 else (_py_math.pi * 0.5)
            yaw = _py_math.atan2(dx, dz)
            cyl.rotate_x(_py_math.degrees(pitch))
            cyl.rotate_y(_py_math.degrees(yaw))
            cyl.translate(mx, my, mz)
            cable_mesh.append(cyl)

        if color:
            cable_mesh.apply_material(PbrMaterial(base_color=color, metalness=0.8, roughness=0.3))
        return cable_mesh
    _geom.create_catenary_cable = create_catenary_cable

    create_beveled_box = _geom.create_beveled_box
    create_subdivided_box = _geom.create_subdivided_box
    create_envelope = _geom.create_envelope
    create_arched_blister = _geom.create_arched_blister
    create_lathe = _geom.create_lathe
    create_loft = _geom.create_loft
    create_form = _geom.create_form

# ============================================================================
# 4. RELATIVE ANCHORING & LAYOUT MODULE
# ============================================================================
class _LayoutModule:
    class BoundingVolume:
        def __init__(self, extents=(10.0, 10.0, 10.0), center=(0.0, 0.0, 0.0)):
            self.extents = (float(extents[0]), float(extents[1]), float(extents[2])) if isinstance(extents, (tuple, list)) else (10.0, 10.0, 10.0)
            self.center = (float(center[0]), float(center[1]), float(center[2])) if isinstance(center, (tuple, list)) else (0.0, 0.0, 0.0)

        def get_socket(self, target: Any) -> "scratchbox_native.math.Vec3":
            cx, cy, cz = self.center
            ex, ey, ez = self.extents
            hx, hy, hz = ex * 0.5, ey * 0.5, ez * 0.5

            # 1. Continuous 3D vector coordinates (u, v, w) in [-1.0, 1.0] (ADA Pillar 3 Invariant)
            if hasattr(target, "x") and hasattr(target, "y") and hasattr(target, "z"):
                return math.Vec3(cx + float(target.x) * hx, cy + float(target.y) * hy, cz + float(target.z) * hz)
            if isinstance(target, (tuple, list)) and len(target) >= 3:
                u, v, w = float(target[0]), float(target[1]), float(target[2])
                return math.Vec3(cx + u * hx, cy + v * hy, cz + w * hz)

            # 2. Continuous axis notation or open-domain directional string lookup
            nl = str(target).lower().strip()
            if any(k in nl for k in ("ground", "base", "bottom", "foundation", "floor", "-y", "down")):
                return math.Vec3(cx, cy - hy, cz)
            elif any(k in nl for k in ("roof", "crown", "top", "summit", "apex", "+y", "up")):
                return math.Vec3(cx, cy + hy, cz)
            elif any(k in nl for k in ("left", "port", "west", "wing_l", "-x")):
                return math.Vec3(cx - hx, cy, cz)
            elif any(k in nl for k in ("right", "starboard", "east", "wing_r", "+x")):
                return math.Vec3(cx + hx, cy, cz)
            elif any(k in nl for k in ("front", "bow", "nose", "north", "fore", "+z")):
                return math.Vec3(cx, cy, cz + hz)
            elif any(k in nl for k in ("back", "rear", "stern", "aft", "south", "tail", "-z")):
                return math.Vec3(cx, cy, cz - hz)
            return math.Vec3(cx, cy, cz)

    @property
    def SpatialConstraintSolver(self):
        if _native and hasattr(_native, "composer") and hasattr(_native.composer, "SpatialConstraintSolver"):
            return _native.composer.SpatialConstraintSolver
        return None

    @staticmethod
    def resolve_constraints(meshes, relations, terrain=None, collision_passes=8):
        """
        Resolve a relational scene graph against named meshes.

        meshes:    dict mapping entity name -> ScratchboxMesh
        relations: list of dicts, e.g.
                   {"subject": "hvac", "predicate": "attached_to_surface",
                    "target": "roof", "face": "top", "clearance": "0.0"}
                   Use target "terrain" to raycast-ground onto the terrain mesh.
        terrain:   optional terrain ScratchboxMesh used for ground snapping.
        Returns a list of ContactAuditViolation (empty when fully certified).
        """
        if _native and hasattr(_native, "composer") and hasattr(_native.composer, "resolve_constraints"):
            mesh_map = {str(k): (v.mesh if hasattr(v, "mesh") else v) for k, v in dict(meshes).items()}
            rel_list = []
            for r in relations:
                rel_list.append({
                    "subject": str(r.get("subject", r.get("subjectId", ""))),
                    "predicate": str(r.get("predicate", "supported_by")),
                    "target": str(r.get("target", r.get("targetId", ""))),
                    "face": str(r.get("face", r.get("faceAlignment", "top"))),
                    "clearance": str(r.get("clearance", r.get("clearanceMeters", 0.0))),
                })
            t_mesh = None
            if terrain is not None:
                t_mesh = terrain.mesh if hasattr(terrain, "mesh") else terrain
            return _native.composer.resolve_constraints(mesh_map, rel_list, t_mesh, int(collision_passes))
        return []

layout = _LayoutModule()

class _PbrModule:
    @property
    def PbrMaterial(self):
        return getattr(geometry, "PbrMaterial", None) or getattr(_native.geometry, "PbrMaterial", None)

    @property
    def ProceduralMaterial(self):
        return getattr(geometry, "PbrMaterial", None) or getattr(_native.geometry, "PbrMaterial", None)

    def __getattr__(self, name):
        pbr_cls = getattr(geometry, "PbrMaterial", None)
        if pbr_cls and hasattr(pbr_cls, name):
            return getattr(pbr_cls, name)
        return None

pbr = _PbrModule()

# ============================================================================
# 4. HIGH-LEVEL AGENTIC BUILDERS (create_building, create_tree)
# ============================================================================
def create_building(
    width: float = 18.0,
    depth: float = 14.0,
    floors: int = 4,
    floor_height: float = 3.4,
    ground_floor_height: float = 4.2,
    plinth_height: float = 0.8,
    bay_width: float = 3.2,
    window_width: float = 1.8,
    window_height: float = 2.0,
    window_recess_depth: float = 0.25,
    roof: Any = "mansard",
    roof_height: float = 3.5,
    roof_overhang: float = 0.4,
    roof_pitch_degrees: float = 55.0,
    parapet_height: float = 0.8,
    curvature: float = 0.0,
    superellipse_exponent: Optional[float] = None,
    twist_degrees: float = 0.0,
    taper: float = 1.0,
    bulge: float = 0.0,
    bay_count: Optional[int] = None,
    bake_curvature_ao: bool = True,
    details: Optional[Dict[str, Any]] = None,
    floor_heights: Optional[List[float]] = None,
    centre_bay_scale: float = 1.0,
    end_bay_scale: float = 1.0,
    facade_rules: Optional[List[Dict[str, Any]]] = None,
    name: str = "ProceduralBuilding",
    **kwargs
) -> "scratchbox_native.geometry.Mesh":
    """
    Constructs multi-story procedural architecture with rhythmic fenestration,
    recessed reveals, continuous compound curvature manifolds, and modeled roofs.
    """
    cfg = _building_config(**{k: v for k, v in locals().items() if k not in ("name", "kwargs")}, **kwargs)
    return _native.architecture.generate_building(cfg, name)


def _building_config(
    width, depth, floors, floor_height, ground_floor_height, plinth_height, bay_width,
    window_width, window_height, window_recess_depth, roof, roof_height, roof_overhang,
    roof_pitch_degrees, parapet_height, curvature, superellipse_exponent, twist_degrees,
    taper, bulge, bay_count, bake_curvature_ao, details=None, floor_heights=None,
    centre_bay_scale=1.0, end_bay_scale=1.0, facade_rules=None, footprint=None, courtyards=None,
    entrance_edge=None, entrance=True, **kwargs
):
    if _native is None or not hasattr(_native, "architecture"):
        raise RuntimeError("Native 3D architecture module scratchbox_native.architecture is required")

    cfg = _native.architecture.BuildingConfig()
    cfg.width = float(width)
    cfg.depth = float(depth)

    if "radius" in kwargs:
        r = float(kwargs["radius"])
        cfg.width = r * 2.0
        cfg.depth = r * 2.0

    floor_cnt = int(kwargs.get("levels", kwargs.get("floor_count", floors)))
    cfg.floor_count = max(1, floor_cnt)

    if "height" in kwargs:
        total_h = float(kwargs["height"])
        cfg.floor_height = total_h / max(1, cfg.floor_count)
        cfg.ground_floor_height = cfg.floor_height
    else:
        cfg.floor_height = float(floor_height)
        cfg.ground_floor_height = float(ground_floor_height)

    cfg.plinth_height = float(plinth_height)
    cfg.bay_width = float(bay_width)
    cfg.window_width = float(window_width)
    cfg.window_height = float(window_height)
    cfg.window_recess_depth = float(window_recess_depth)
    cfg.roof_height = float(kwargs.get("roof_height", roof_height))
    cfg.roof_pitch_degrees = float(roof_pitch_degrees)
    cfg.roof_overhang = float(roof_overhang)
    cfg.parapet_height = float(parapet_height)

    # Continuous Curvilinear & Parametric Manifold (ADA Continuous Invariant)
    curv_val = float(kwargs.get("curvature", curvature))
    cfg.curvature = curv_val
    if superellipse_exponent is not None or "superellipse_exponent" in kwargs:
        cfg.superellipse_exponent = float(kwargs.get("superellipse_exponent", superellipse_exponent if superellipse_exponent is not None else 2.4))
    elif curv_val > 0.001:
        cfg.superellipse_exponent = max(1.8, 10.0 - 7.6 * min(1.0, curv_val))

    cfg.twist_degrees = float(kwargs.get("twist_degrees", kwargs.get("twist", twist_degrees)))
    cfg.taper = float(kwargs.get("taper", taper))
    cfg.bulge = float(kwargs.get("bulge", bulge))
    if bay_count is not None or "bay_count" in kwargs:
        cfg.bay_count = int(kwargs.get("bay_count", bay_count if bay_count is not None else 0))
    cfg.bake_curvature_ao = bool(kwargs.get("bake_curvature_ao", bake_curvature_ao))

    RoofType = _native.architecture.RoofType
    if isinstance(roof, str):
        r = roof.lower().strip()
        if "dome" in r:
            cfg.roof_type = RoofType.Dome
        elif "vault" in r:
            cfg.roof_type = RoofType.BarrelVault
        elif "mansard" in r:
            cfg.roof_type = RoofType.Mansard
        elif "hip" in r:
            cfg.roof_type = RoofType.Hip
        elif "gable" in r:
            cfg.roof_type = RoofType.Gable
        elif "flat" in r:
            cfg.roof_type = RoofType.FlatParapet
        else:
            cfg.roof_type = RoofType.FlatParapet
    elif isinstance(roof, RoofType):
        cfg.roof_type = roof
    else:
        cfg.roof_type = RoofType.Mansard

    if details:
        fd = _native.architecture.FacadeDetails()
        for key, value in details.items():
            if not hasattr(fd, key):
                raise ValueError(_unknown_key("facade detail", key, fd))
            if key.endswith("_profile"):
                value = [_native.math.Vec2(float(x), float(y)) for x, y in value]
            setattr(fd, key, value)
        cfg.details = fd
    if floor_heights:
        cfg.floor_heights = [float(h) for h in floor_heights]
    cfg.centre_bay_scale = float(centre_bay_scale)
    cfg.end_bay_scale = float(end_bay_scale)
    def _loop(points, what):
        try:
            loop = [_native.math.Vec2(float(x), float(z)) for x, z in points]
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{what} must be a list of (x, z) points in metres") from exc
        if len(loop) < 3:
            raise ValueError(f"{what} needs at least 3 points, got {len(loop)}")
        return loop
    if footprint is not None:
        cfg.footprint = _loop(footprint, "footprint")
        cfg.footprint_holes = [_loop(h, f"courtyard {i}") for i, h in enumerate(courtyards or [])]
    elif courtyards:
        raise ValueError("courtyards need a footprint outline around them")
    if entrance_edge is not None:
        if footprint is None:
            raise ValueError("entrance_edge applies to a footprint outline; the rectangle's entrance is on its south side")
        cfg.entrance_edge = int(entrance_edge)
    if not entrance:
        if entrance_edge is not None:
            raise ValueError("entrance=False leaves the building without a door; drop entrance_edge")
        cfg.entrance_edge = -2
    if facade_rules:
        side_index = {"south": 0, "north": 1, "east": 2, "west": 3}
        balcony_modes = {"none": 0, "bay": 1, "continuous": 2}
        rules = []
        for n, spec in enumerate(facade_rules):
            rule = _native.architecture.FacadeRule()
            where = f"facade rule {n}"
            for key, value in spec.items():
                if key == "floors":
                    if isinstance(value, (list, tuple)):
                        if len(value) != 2 or not all(isinstance(v, int) and not isinstance(v, bool) for v in value):
                            raise ValueError(f"{where}: 'floors' must be an int or an (lowest, highest) pair of ints, got {value!r}")
                        lo, hi = value
                        if lo > hi:
                            raise ValueError(f"{where}: 'floors' range ({lo}, {hi}) has its lowest floor above its highest")
                    elif isinstance(value, int) and not isinstance(value, bool):
                        lo = hi = value
                    else:
                        raise ValueError(f"{where}: 'floors' must be an int or an (lowest, highest) pair of ints, got {value!r}")
                    rule.floor_min, rule.floor_max = lo, hi
                    continue
                if not hasattr(rule, key):
                    raise ValueError(_unknown_key("facade rule field", key, rule))
                if key == "sides":
                    if isinstance(value, str) or not isinstance(value, (list, tuple)):
                        raise ValueError(f"{where}: 'sides' must be a list of side names or indices, got {value!r}")
                    sides = []
                    for v in value:
                        if footprint is not None:
                            if not (isinstance(v, int) and not isinstance(v, bool) and v >= 0):
                                raise ValueError(f"{where}: on a footprint outline, sides are edge indices (0 = edge0, as in facades), got {v!r}")
                            sides.append(v)
                            continue
                        if isinstance(v, str):
                            if v not in side_index:
                                raise ValueError(f"{where}: unknown side '{v}' (south, north, east, west)")
                            sides.append(side_index[v])
                        elif isinstance(v, int) and 0 <= v <= 3:
                            sides.append(v)
                        else:
                            raise ValueError(f"{where}: side must be a name or an index 0..3, got {v!r}")
                    value = sides
                elif key.endswith("_profile"):
                    value = [_native.math.Vec2(float(x), float(y)) for x, y in value]
                elif key in ("opening", "sill", "hood"):
                    value = int(bool(value))
                elif key == "balcony":
                    if isinstance(value, str):
                        if value not in balcony_modes:
                            raise ValueError(f"{where}: unknown balcony mode '{value}' (none, bay, continuous)")
                        value = balcony_modes[value]
                try:
                    setattr(rule, key, value)
                except TypeError as exc:
                    raise ValueError(f"{where}: '{key}' does not accept {value!r}") from exc
            rules.append(rule)
        cfg.rules = rules
    return cfg


def _unknown_key(what: str, key: str, params) -> str:
    """The error for a settings key a native params object does not have, naming the closest valid ones."""
    import difflib
    valid = sorted(n for n in dir(params) if not n.startswith("_") and not callable(getattr(params, n)))
    close = difflib.get_close_matches(key, valid, n=3, cutoff=0.5)
    hint = f"; did you mean {', '.join(close)}?" if close else ""
    return f"Unknown {what} '{key}'{hint} (valid: {', '.join(valid)})"


def moulding_profile(height: float, projection: float, tiers: int = 3, curvature: float = 0.6,
                     invert: bool = False, samples: int = 4) -> List[Tuple[float, float]]:
    """
    A closed (outward, up) moulding section in metres for FacadeDetails profiles, hanging below
    its anchor line (y from -height to 0). Each of `tiers` steps rises and projects further; the
    step faces bow by `curvature` (0 = square fillets, 1 = full quarter rounds). invert=True puts
    the largest projection at the bottom (bases, plinth caps). The wall side is embedded 2 cm.
    """
    tiers = max(1, int(tiers))
    pts = [(-0.02, -height), (0.0, -height)]
    dh = height / tiers
    for i in range(tiers):
        x0 = projection * i / tiers
        x1 = projection * (i + 1) / tiers
        y0 = -height + i * dh
        for k in range(1, samples + 1):
            t = k / samples
            bow = (1.0 - (1.0 - t) ** 2) * curvature + t * (1.0 - curvature)
            pts.append((x0 + (x1 - x0) * bow, y0 + dh * 0.7 * t))
        pts.append((x1, y0 + dh))
    pts.append((-0.02, 0.0))
    if invert:
        pts = [(x, -height - y) for x, y in reversed(pts)]
    return pts


class _BuildingParts(list):
    """
    The parts list create_building_parts returns (one Mesh per material slot), carrying the
    building's chimney tops (soot sources) and its facade frames (south = +Z entrance side,
    north, east, west) for decals.
    """
    soot_sources: List[Tuple[float, float, float]] = []
    facades: Dict[str, Dict[str, Any]] = {}


def create_building_parts(
    width: float = 18.0,
    depth: float = 14.0,
    floors: int = 4,
    floor_height: float = 3.4,
    ground_floor_height: float = 4.2,
    plinth_height: float = 0.8,
    bay_width: float = 3.2,
    window_width: float = 1.8,
    window_height: float = 2.0,
    window_recess_depth: float = 0.25,
    roof: Any = "mansard",
    roof_height: float = 3.5,
    roof_overhang: float = 0.4,
    roof_pitch_degrees: float = 55.0,
    parapet_height: float = 0.8,
    curvature: float = 0.0,
    superellipse_exponent: Optional[float] = None,
    twist_degrees: float = 0.0,
    taper: float = 1.0,
    bulge: float = 0.0,
    bay_count: Optional[int] = None,
    bake_curvature_ao: bool = True,
    details: Optional[Dict[str, Any]] = None,
    floor_heights: Optional[List[float]] = None,
    centre_bay_scale: float = 1.0,
    end_bay_scale: float = 1.0,
    facade_rules: Optional[List[Dict[str, Any]]] = None,
    footprint: Optional[List[Tuple[float, float]]] = None,
    courtyards: Optional[List[List[Tuple[float, float]]]] = None,
    entrance_edge: Optional[int] = None,
    entrance: bool = True,
    base_y: float = 0.0,
    offset: Tuple[float, float] = (0.0, 0.0),
    name: str = "ProceduralBuilding",
    **kwargs
) -> _BuildingParts:
    """
    The building create_building makes, as one mesh per material slot (<name>_wall, _glass,
    _frame, _roof, _foundation) with world-metre UVs, ready for write_textured_building.

    Both builders take the same layout controls:
      floor_heights: storey heights from the ground floor up (entries override the defaults);
      centre_bay_scale / end_bay_scale: width of the middle and outermost bays relative to the rest;
      facade_rules: dicts applied in order (later wins). Selectors: "floors" (n or (lo, hi), 0 =
        ground), "sides" ("south" = +Z entrance side, "north", "east", "west" or 0..3),
        "bay_stride"/"bay_offset", "centre_span" / "end_span" (bays within n of the middle / an
        end). Overrides: window_width_m, window_height_m, sill_height_m, opening (False = blank
        wall), sill, hood (False removes), sill_profile, hood_profile, hood_pitch_deg, balcony
        ("none", "bay", "continuous" along adjacent bays). The entrance bay keeps its door.

    base_y and offset (x, z) place the building: a tier of a set-back tower stands at the height of
    the tier below (see stack_buildings), a wing beside it at an offset.

    footprint [(x, z), ...] (x east, z south, metres) builds any plan outline instead of the width x
    depth rectangle, with courtyards as holes inside it: one facade per edge (facades "edge0", ... outer
    edges first, each with its compass "heading_deg"), quoins and corner pilasters on outside corners,
    plain returns at inside ones, edges too short for a window left blank. Points under 5 cm apart and
    bends under 10 degrees are merged. The entrance goes on the longest outer edge unless entrance_edge
    picks one; facade rule "sides" are edge indices. Outlines take roof="flat" for now.
    entrance=False gives no door at all: an upper tier of a set-back tower opens onto its terrace
    through windows, not a front door.
    """
    cfg = _building_config(**{k: v for k, v in locals().items() if k not in ("name", "kwargs", "base_y", "offset")}, **kwargs)
    parts = _BuildingParts(_native.architecture.generate_building_parts(cfg, name))
    dx, dz = float(offset[0]), float(offset[1]); dy = float(base_y)
    shift = lambda p: (p[0] + dx, p[1] + dy, p[2] + dz)
    if dx or dy or dz:
        for part in parts:
            part.translate(_native.math.Vec3(dx, dy, dz))
    parts.soot_sources = [shift((t.x, t.y, t.z)) for t in _native.architecture.chimney_tops(cfg)]
    parts.facades = {f["name"]: {"start": shift((f["start"].x, f["start"].y, f["start"].z)),
                                 "right": (f["right"].x, f["right"].y, f["right"].z),
                                 "normal": (f["normal"].x, f["normal"].y, f["normal"].z),
                                 "length": f["length"],
                                 # compass bearing the facade faces (x east, z south: north is -z)
                                 "heading_deg": round(_py_math.degrees(_py_math.atan2(f["normal"].x, -f["normal"].z)) % 360.0, 3)}
                     for f in _native.architecture.facade_frames(cfg)}
    return parts


def stack_buildings(*tiers) -> _BuildingParts:
    """
    Combine buildings made by create_building_parts (each with its own name, placed with base_y and
    offset) into one parts list for write_textured_building: set-back towers as tiers standing on each
    other, wings beside a block. Surfaces and weathering apply to every tier's parts by slot; soot
    sources are merged; facades are addressed as "<tier name>/south" etc., and the first tier's also
    as plain "south". The tier below a set-back usually takes roof="flat" (its parapet edges the
    terrace); only the top tier carries the pitched roof.
    """
    if not tiers:
        raise ValueError("stack_buildings needs at least one building")
    combined = _BuildingParts()
    combined.soot_sources = []
    combined.facades = {}
    seen = set()
    for i, tier in enumerate(tiers):
        names = [p.name for p in tier]
        clash = sorted(seen.intersection(names))
        if clash:
            raise ValueError(f"stack_buildings: part names {clash} repeat; give each tier its own name=")
        seen.update(names)
        combined.extend(tier)
        combined.soot_sources.extend(getattr(tier, "soot_sources", []))
        tier_name = tier[0].name.rsplit("_", 1)[0] if len(tier) else f"tier{i}"
        for side, frame in getattr(tier, "facades", {}).items():
            combined.facades[f"{tier_name}/{side}"] = frame
            if i == 0:
                combined.facades[side] = frame
    return combined


_PROVENANCE_LABELS = ("measured", "vector-modelled", "photo-inferred", "generated")


def _confidence(value, where) -> float:
    try:
        c = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{where}: confidence must be a number in 0..1, got {value!r}") from None
    if not 0.0 <= c <= 1.0:
        raise ValueError(f"{where}: confidence must be in 0..1, got {c}")
    return c


def _with_provenance(material, provenance: str, confidence: float, source: str):
    """The material with its provenance label, confidence and source description in its glTF extras."""
    if provenance not in _PROVENANCE_LABELS:
        raise ValueError(f"provenance must be one of {_PROVENANCE_LABELS}, got {provenance!r}")
    material.extras_json = _json.dumps({"scratchbox": {"provenance": provenance, "confidence": confidence, "source": str(source)}})
    return material


def _decal_image(spec_image) -> Tuple[bytes, str, str]:
    """(image bytes, mime type, source label) for a decal's "image": a file path or {"blot": {...}}."""
    if isinstance(spec_image, dict) and "blot" in spec_image:
        bp = _native.weathering.BlotParams()
        for key, value in spec_image["blot"].items():
            if not hasattr(bp, key):
                raise ValueError(f"Unknown blot parameter '{key}'")
            setattr(bp, key, _native.math.Vec3(*value) if key == "color" else value)
        return _native.weathering.synthesize_blot(bp), "image/png", "procedural blot"
    file_path = str(spec_image)
    ext = os.path.splitext(file_path)[1].lower()
    if ext not in _IMAGE_MIME:
        raise ValueError(f"Unsupported decal image type '{ext}' for {file_path}")
    with open(file_path, "rb") as fh:
        return fh.read(), _IMAGE_MIME[ext], "image file"


def _decal_frame(parts, spec) -> Tuple[Tuple[float, float, float], Tuple[float, float, float], Tuple[float, float, float]]:
    """(center, normal, up) for a decal placed by facade + u/v metres, or given directly."""
    if "facade" in spec:
        facades = getattr(parts, "facades", {})
        if spec["facade"] not in facades:
            raise ValueError(f"Unknown facade '{spec['facade']}' (have {sorted(facades)})")
        f = facades[spec["facade"]]
        u, v = float(spec.get("u", f["length"] * 0.5)), float(spec.get("v", 2.0))
        c = tuple(f["start"][i] + f["right"][i] * u for i in range(3))
        return (c[0], c[1] + v, c[2]), f["normal"], (0.0, 1.0, 0.0)
    if "center" not in spec or "normal" not in spec:
        raise ValueError("A decal needs 'facade' with 'u'/'v', or 'center' and 'normal'")
    return tuple(spec["center"]), tuple(spec["normal"]), tuple(spec.get("up", (0.0, 1.0, 0.0)))


_IMAGE_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}


# An add-on denser than this is not weathered unless asked: the bake's overlay copies every receiving triangle.
_EXTRA_WEATHER_MAX_TRIANGLES = 20000


def write_textured_building(path: str, parts, surfaces: Optional[Dict[str, Any]] = None,
                            weathering: Optional[Dict[str, Any]] = None,
                            decals: Optional[List[Dict[str, Any]]] = None,
                            extras: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """
    Write building parts to a GLB with real-scale PBR textures per part.

    surfaces maps a part slot ("wall", "roof", "foundation", "frame", "glass") to either
      {"coursed": {<CoursedSurfaceParams fields>}}            procedural, synthesized natively
      {"albedo": file, "normal": file?, "orm": file?,          image maps from a material library or
       "tile_m": (w, h), "tint": (r, g, b)?, "source": str}   an image model, laid at tile_m metres
    Optional per-part "roughness" / "metallic" set the material factors. Parts without an
    entry keep their flat slot material.

    weathering, when given, bakes marks from the built geometry (run-off streaks under ledges,
    rain exposure wash, shelter and cavity grime, rising damp, soot around the chimney tops) into
    a unique atlas on an alpha-blended overlay shell over the "receivers" parts (default wall,
    foundation, roof). Its keys are WeatheringParams fields plus "receivers"; strengths are
    continuous and 0 turns a layer off.

    decals places images on the building. Each is a dict with
      placement: "facade" ("south" = +Z entrance side, "north", "east", "west") with "u" metres
                 along it from its start corner and "v" metres above the ground, or "center" and
                 "normal" (and optional "up") in world metres;
      "size": (width_m, height_m); "image": a PNG/JPEG path or {"blot": {<BlotParams fields>}};
      "mode": "paint" (default: painted into the weathering atlas, follows the surface and ages
              under decal_aging; PNG only) or "panel" (its own quad standing "standoff_m" off the
              wall, with "thickness_m" for boards and plaques, full image resolution);
      optional "opacity", "depth_m" (paint projection depth) and "source" (provenance label).

    extras attaches closed add-ons built with sb.sdf, sb.meshops or sb.relief (ornaments, dormer and
    chimney bodies, fluted pilasters) to the building. Each is a dict with "mesh" and "slot" (which
    surface it takes: "wall", "foundation", "roof", "frame", "glass", or a new slot name given its own
    surfaces entry), optional "color" (r, g, b) for an untextured slot, "provenance" (default
    "generated"), "confidence" (default 1.0), "source" (what made it) and "weather" (receives the
    weathering bake; default True up to 20,000 triangles, False above, since the bake's overlay copies
    every receiving triangle; every add-on blocks it either way). Each gets world-metre UVs, so tiled
    surfaces lie at the same scale as the building's; add-ons of one slot share one set of maps.
    Returns {"path", "parts": {...}, "decals": [...], "extras": [...]} so the caller can label
    provenance honestly; weathering and procedural marks are reported as generated.
    """
    surfaces = surfaces or {}
    textures, report = [], {}
    base_name = parts[0].name.rsplit("_", 1)[0] if len(parts) else "Building"
    extra_parts, extra_report, no_weather = [], [], set()
    for i, spec in enumerate(extras or []):
        if "mesh" not in spec or "slot" not in spec:
            raise ValueError(f"extra {i} needs 'mesh' and 'slot'")
        slot = str(spec["slot"])
        if not slot or "_" in slot:
            raise ValueError(f"extra {i}: slot must be a word without underscores, got {slot!r}")
        mesh = _native.architecture.project_world_uvs(spec["mesh"])
        if not len(mesh.vertices):
            raise ValueError(f"extra {i} ({slot}) has no triangles")
        # One texture target ("<base>_extras-<slot>-") then matches every add-on of the slot and nothing else.
        mesh.name = f"{base_name}_extras-{slot}-{i:03d}_{slot}"
        if "color" in spec:
            mat = mesh.material
            r, g, b = (float(c) for c in spec["color"])
            mat.base_color = _native.math.Vec4(r, g, b, 1.0)
            mesh.material = mat
        extra_parts.append(mesh)
        triangles = len(mesh.indices) // 3
        weather = bool(spec.get("weather", triangles <= _EXTRA_WEATHER_MAX_TRIANGLES))
        if not weather:
            no_weather.add(mesh.name)
        extra_report.append({"name": mesh.name, "slot": slot, "triangles": triangles, "weathered": weather,
                             "provenance": spec.get("provenance", "generated"),
                             "confidence": _confidence(spec.get("confidence", 1.0), f"extra {i}"),
                             "source": spec.get("source", "add-on")})
    extra_info = {e["name"]: e for e in extra_report}
    parts_in = parts
    parts = list(parts) + extra_parts
    slots = [p.name.rsplit("_", 1)[-1] for p in parts]
    unknown = sorted(set(surfaces) - set(slots))
    if unknown:
        raise ValueError(f"Unknown surface slot(s) {unknown} (have {sorted(set(slots))})")
    synthesized = {}   # one texture synthesis per slot, reused by every tier and add-on that takes it
    shared_targets = set()
    for part in parts:
        slot = part.name.rsplit("_", 1)[-1]
        spec = surfaces.get(slot)
        extra = extra_info.get(part.name)
        if not spec:
            if extra:
                part.material = _with_provenance(part.material, extra["provenance"], extra["confidence"], extra["source"])
            else:
                part.material = _with_provenance(part.material, "generated", 1.0, "procedural building")
                report[slot] = {"source": "flat material", "provenance": "generated", "confidence": 1.0}
            continue
        mat = part.material
        if "coursed" in spec and slot in synthesized:
            tile, maps = synthesized[slot]
            mat.base_color = _native.math.Vec4(1.0, 1.0, 1.0, mat.base_color.w)
            mat.roughness = 1.0
            mat.metallic = 1.0
            source = "procedural coursed surface"
        elif "coursed" in spec:
            params = _native.surface.CoursedSurfaceParams()
            for key, value in spec["coursed"].items():
                if not hasattr(params, key):
                    raise ValueError(_unknown_key("coursed surface parameter", key, params))
                setattr(params, key, _native.math.Vec3(*value) if key.endswith("_color") else value)
            tex = _native.surface.synthesize_coursed_surface(params)
            tile = (tex["tile_width_m"], tex["tile_height_m"])
            maps = {"base_color": (tex["albedo_png"], "image/png"),
                    "normal": (tex["normal_png"], "image/png"),
                    "orm": (tex["orm_png"], "image/png")}
            synthesized[slot] = (tile, maps)
            mat.base_color = _native.math.Vec4(1.0, 1.0, 1.0, mat.base_color.w)
            mat.roughness = 1.0
            mat.metallic = 1.0
            source = "procedural coursed surface"
        else:
            if "albedo" not in spec or "tile_m" not in spec:
                raise ValueError(f"Surface '{slot}' needs 'coursed' parameters or an 'albedo' file and 'tile_m'")
            tile = tuple(spec["tile_m"])
            maps = {}
            for usage, key in (("base_color", "albedo"), ("normal", "normal"), ("orm", "orm")):
                if spec.get(key):
                    file_path = str(spec[key])
                    ext = os.path.splitext(file_path)[1].lower()
                    if ext not in _IMAGE_MIME:
                        raise ValueError(f"Unsupported texture file type '{ext}' for {file_path}")
                    with open(file_path, "rb") as fh:
                        maps[usage] = (fh.read(), _IMAGE_MIME[ext])
            tint = spec.get("tint", (1.0, 1.0, 1.0))
            mat.base_color = _native.math.Vec4(tint[0], tint[1], tint[2], mat.base_color.w)
            if "orm" in maps:
                mat.roughness = 1.0
                mat.metallic = 1.0
            source = spec.get("source", "image maps")
        if "roughness" in spec:
            mat.roughness = float(spec["roughness"])
        if "metallic" in spec:
            mat.metallic = float(spec["metallic"])
        # Provenance is one of the four honest labels with a confidence, written into the GLB; a free
        # "source" string describes where the maps came from but never upgrades the label.
        provenance = spec.get("provenance", "generated")
        confidence = _confidence(spec.get("confidence", 1.0 if "coursed" in spec else 0.5), slot)
        if extra:   # an add-on keeps its own label: its shape was made by the script, not measured
            part.material = _with_provenance(mat, extra["provenance"], extra["confidence"], f"{extra['source']}; surface: {source}")
        else:
            part.material = _with_provenance(mat, provenance, confidence, source)
            report[slot] = {"source": source, "tile_m": tile, "provenance": provenance, "confidence": confidence}
        target = part.name
        if extra:
            target = f"{base_name}_extras-{slot}-"
            if target in shared_targets:
                continue
            shared_targets.add(target)
        for usage, (data, mime) in maps.items():
            textures.append((target, usage, data, mime, 1.0 / tile[0], 1.0 / tile[1]))

    meshes = list(parts)
    painted, decal_report = [], []
    for i, spec in enumerate(decals or []):
        center, normal, up = _decal_frame(parts_in, spec)
        width, height = (float(x) for x in spec["size"])
        data, mime, kind = _decal_image(spec["image"])
        mode = spec.get("mode", "paint")
        source = spec.get("source", "generated (procedural blot)" if kind == "procedural blot" else kind)
        if mode == "paint":
            if mime != "image/png":
                raise ValueError("Painted decals need a PNG image")
            painted.append((_native.math.Vec3(*center), _native.math.Vec3(*normal), _native.math.Vec3(*up),
                            width, height, float(spec.get("depth_m", 0.35)), float(spec.get("opacity", 1.0)), data))
        elif mode == "panel":
            panel = _native.weathering.make_decal_panel(
                _native.math.Vec3(*center), _native.math.Vec3(*normal), _native.math.Vec3(*up), width, height,
                float(spec.get("thickness_m", 0.0)), float(spec.get("standoff_m", 0.004)), f"{base_name}_decal[{i:03d}]")
            panel.material = _with_provenance(panel.material, spec.get("provenance", "generated"),
                                              _confidence(spec.get("confidence", 0.5), f"decal {i}"), source)
            meshes.append(panel)
            textures.append((panel.name, "base_color", data, mime, 1.0, 1.0))
        else:
            raise ValueError(f"Unknown decal mode '{mode}' (paint, panel)")
        decal_report.append({"mode": mode, "source": source, "size_m": (width, height),
                             "center": tuple(round(c, 3) for c in center)})

    if weathering is None and painted:
        weathering = {k: 0.0 for k in ("streak_strength", "exposure_wash", "shelter_grime", "cavity_grime",
                                       "damp_strength", "soot_strength")}
    if weathering is not None:
        options = dict(weathering)
        wanted = set(options.pop("receivers", ["wall", "foundation", "roof"]))
        params = _native.weathering.WeatheringParams()
        options.setdefault("soot_sources", getattr(parts_in, "soot_sources", []))
        for key, value in options.items():
            if not hasattr(params, key):
                raise ValueError(_unknown_key("weathering parameter", key, params))
            if key == "soot_sources":
                value = [_native.math.Vec3(*pt) for pt in value]
            elif key.endswith("_color"):
                value = _native.math.Vec3(*value)
            setattr(params, key, value)
        receivers = [p for p in parts if p.name.rsplit("_", 1)[-1] in wanted and p.name not in no_weather]
        if not receivers:
            have = sorted({p.name.rsplit("_", 1)[-1] for p in parts})
            raise ValueError(f"weathering receivers {sorted(wanted)} match no building part (have {have})")
        # Unless the script chose texel_m, a building too big for the atlas at the default texel (a skyscraper)
        # is baked at the finest texel that fits rather than refused; the report says which texel was used and why.
        fitted = None
        for _attempt in range(6):
            try:
                baked = _native.weathering.bake_weathering(receivers, list(parts), params, f"{base_name}_weathering", painted)
                break
            except RuntimeError as exc:
                m = _re.search(r"atlas would be (\d+) x (\d+)", str(exc))
                if "texel_m" in options or not m:
                    raise
                over = int(m.group(2)) / float(m.group(1))
                fitted = params.texel_m * max(1.1, _py_math.sqrt(over) * 1.05)
                params.texel_m = fitted
        else:
            raise RuntimeError("weathering atlas does not fit even at a texel of %.2f m; pass texel_m or fewer receivers" % params.texel_m)
        overlay = baked["overlay"]
        if len(overlay.vertices):
            overlay.material = _with_provenance(overlay.material, "generated", 1.0, "geometry-driven weathering bake")
            meshes.append(overlay)
            textures.append((overlay.name, "base_color", baked["atlas_png"], "image/png", 1.0, 1.0))
        report["weathering"] = {"source": "generated (geometry-driven bake)", "receivers": sorted(wanted),
                                "atlas_px": (baked["atlas_width"], baked["atlas_height"]),
                                "charts": baked["charts"], "baked_texels": baked["baked_texels"],
                                "texel_m": round(params.texel_m, 4),
                                "clear_triangles": baked.get("clear_triangles", 0)}
        if fitted is not None:
            report["weathering"]["texel_note"] = ("coarsened from the default so the atlas fits this building's area; "
                                                  "pass texel_m to choose it")

    # Parts are generated as triangle soup (each face its own corners, for per-face UVs); merging the corners
    # that are identical in every attribute is lossless and keeps a skyscraper loadable in the viewport.
    for m in meshes:
        m.weld_identical_vertices()
    _native.io.write_glb_textured(path, meshes, textures)
    return {"path": path, "parts": report, "decals": decal_report, "extras": extra_report}

def create_curved_building(
    width: float = 18.0,
    depth: float = 18.0,
    floors: int = 6,
    curvature: float = 0.85,
    superellipse_exponent: float = 2.4,
    twist_degrees: float = 0.0,
    taper: float = 0.85,
    bulge: float = 0.12,
    roof: str = "dome",
    roof_height: float = 4.0,
    bake_curvature_ao: bool = True,
    name: str = "CurvedBuilding",
    **kwargs
) -> "scratchbox_native.geometry.Mesh":
    """
    Constructs a sculptural curved building using superelliptic floorplate lofts,
    continuous elevation scaling (taper/bulge), and automatic curvature-coupled AO.
    """
    return create_building(
        width=width,
        depth=depth,
        floors=floors,
        curvature=curvature,
        superellipse_exponent=superellipse_exponent,
        twist_degrees=twist_degrees,
        taper=taper,
        bulge=bulge,
        roof=roof,
        roof_height=roof_height,
        bake_curvature_ao=bake_curvature_ao,
        name=name,
        **kwargs
    )

def create_tower(
    width: float = 16.0,
    depth: float = 16.0,
    floors: int = 14,
    twist_degrees: float = 45.0,
    taper: float = 0.70,
    bulge: float = 0.08,
    superellipse_exponent: float = 2.6,
    roof: str = "flat",
    bake_curvature_ao: bool = True,
    name: str = "TwistingTower",
    **kwargs
) -> "scratchbox_native.geometry.Mesh":
    """
    Constructs a soaring parametric skyscraper tower with continuous helical twist,
    entasis taper, and surface-normal recessed fenestration bays.
    """
    return create_curved_building(
        width=width,
        depth=depth,
        floors=floors,
        curvature=0.9,
        superellipse_exponent=superellipse_exponent,
        twist_degrees=twist_degrees,
        taper=taper,
        bulge=bulge,
        roof=roof,
        bake_curvature_ao=bake_curvature_ao,
        name=name,
        **kwargs
    )

def create_tree(
    attractor_count: int = 120,
    crown_center: Any = (0.0, 5.0, 0.0),
    crown_extents: Any = (2.5, 3.5, 2.5),
    root_anchor: Any = (0.0, 0.0, 0.0),
    perception_radius: float = 2.0,
    kill_radius: float = 0.5,
    branch_step_length: float = 0.25,
    clear_trunk_height: float = 1.5,
    base_radius: float = 0.25,
    tip_radius: float = 0.03,
    generate_leaves: bool = True,
    use_detailed_leaves: bool = True,
    leaf_density: Optional[float] = None,
    season: Optional[float] = None,
    material: Any = None,
    name: str = "SpaceColonizationTree",
    **kwargs
) -> "scratchbox_native.geometry.Mesh":
    """
    Synthesizes botanical trees and vegetation adhering to Runions space colonization.
    """
    if _native is None or not hasattr(_native, "nature"):
        raise RuntimeError("Native 3D nature module scratchbox_native.nature is required")

    cfg = _native.nature.SpaceColonizationConfig()
    cfg.attractor_count = int(attractor_count)

    def _to_vec3(v):
        if hasattr(v, "x") and hasattr(v, "y") and hasattr(v, "z"):
            return math.Vec3(float(v.x), float(v.y), float(v.z))
        if isinstance(v, (tuple, list)) and len(v) >= 3:
            return math.Vec3(float(v[0]), float(v[1]), float(v[2]))
        return math.Vec3(0, 0, 0)

    cfg.crown_center = _to_vec3(crown_center)
    cfg.crown_extents = _to_vec3(crown_extents)
    cfg.root_anchor = _to_vec3(root_anchor)
    cfg.perception_radius = float(perception_radius)
    cfg.kill_radius = float(kill_radius)
    cfg.branch_step_length = float(branch_step_length)
    cfg.clear_trunk_height = float(clear_trunk_height)
    cfg.base_radius = float(base_radius)
    cfg.tip_radius = float(tip_radius)
    cfg.generate_leaves = bool(generate_leaves)
    cfg.use_detailed_leaves = bool(use_detailed_leaves)

    if leaf_density is not None:
        cfg.volumetric_density = float(leaf_density)
    if "volumetric_density" in kwargs:
        cfg.volumetric_density = float(kwargs["volumetric_density"])

    mesh = _native.nature.generate_tree(cfg)
    mesh.name = name
    if material is not None:
        mesh.material = material
    return mesh

def create_ivy(
    root: Any = (0.0, 0.0, 0.0),
    obstacle_min: Any = (-4.0, 0.0, -4.0),
    obstacle_max: Any = (4.0, 6.0, 4.0),
    max_steps: int = 60,
    cling_distance: Optional[float] = None,
    material: Any = None,
    name: str = "IvyGrowth",
    **kwargs
) -> "scratchbox_native.geometry.Mesh":
    """
    Grows obstacle-clinging ivy vines from root across the obstacle AABB [obstacle_min, obstacle_max].
    """
    if _native is None or not hasattr(_native, "nature"):
        raise RuntimeError("Native 3D nature module scratchbox_native.nature is required")

    cfg = _native.nature.IvyConfig()
    cfg.root_position = math.Vec3(*_to_point3(kwargs.get("root_position", root)))
    cfg.obstacle_min = math.Vec3(*_to_point3(obstacle_min))
    cfg.obstacle_max = math.Vec3(*_to_point3(obstacle_max))
    cfg.max_steps = int(max_steps)
    if cling_distance is not None:
        cfg.cling_distance = float(cling_distance)

    mesh = _native.nature.generate_ivy(cfg)
    mesh.name = name
    if material is not None:
        mesh.material = material
    return mesh

# ============================================================================
# 5. GEOSPATIAL & SUBMODULE EXPORTS
# ============================================================================
class _GeospatialModule:
    @staticmethod
    def load_location(query: Optional[str] = None):
        """Scripts are not staged on real places, so there is no place to load. A place comes from the
        google_3d_tiles_get_clay tool, and one object standing at a place from build_3d_object_from_reference."""
        raise RuntimeError(
            "sb.geospatial.load_location(): scripts are not staged on real places. Get the place with "
            "google_3d_tiles_get_clay, or build one object standing there with build_3d_object_from_reference "
            "and its location; a script builds only what it constructs itself."
        )

geospatial = _GeospatialModule()

class _NatureModule:
    PlantPreset = PlantPreset
    Flora = Flora
    create_tree = staticmethod(create_tree)
    create_ivy = staticmethod(create_ivy)
    if _native and hasattr(_native, "nature"):
        SpaceColonizationConfig = getattr(_native.nature, "SpaceColonizationConfig", None)
        SpaceColonizationTree = getattr(_native.nature, "SpaceColonizationTree", None)
        generate_tree = getattr(_native.nature, "generate_tree", None)

nature = _NatureModule()

class _ArchitectureModule:
    RomanOrder = RomanOrder
    create_building = staticmethod(create_building)
    if _native and hasattr(_native, "architecture"):
        BuildingConfig = getattr(_native.architecture, "BuildingConfig", None)
        RoofType = getattr(_native.architecture, "RoofType", None)
        generate_building = getattr(_native.architecture, "generate_building", None)
        generate_peripteral_temple = getattr(_native.architecture, "generate_peripteral_temple", None)

architecture = _ArchitectureModule()

class _ConstantsModule:
    @property
    def OUTPUT_GLB_PATH(self):
        return os.environ.get("OUTPUT_GLB_PATH", "output.glb")

constants = _ConstantsModule()

if _native is not None and hasattr(_native, "io"):
    _orig_write_glb = getattr(_native.io, "write_glb", None)

    def write_glb(arg1, arg2=None):
        if arg2 is not None:
            out_path = str(arg1)
            target = arg2
        else:
            out_path = os.environ.get("OUTPUT_GLB_PATH", "output.glb")
            target = arg1

        if hasattr(target, "compile_to_glb"):
            return target.compile_to_glb(out_path)
        if isinstance(target, (bytes, bytearray)):
            os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
            with open(out_path, "wb") as f:
                f.write(target)
            return out_path

        if isinstance(target, (list, tuple)):
            mesh_list = [getattr(m, "mesh", m) for m in target if m is not None]
            if _orig_write_glb:
                return _orig_write_glb(out_path, mesh_list)
        else:
            sub_parts = getattr(target, "_sub_parts", None)
            if sub_parts and len(sub_parts) > 1:
                mesh_list = [getattr(m, "mesh", m) for m in sub_parts if m is not None]
                if _orig_write_glb:
                    return _orig_write_glb(out_path, mesh_list)

        target_mesh = target.mesh if hasattr(target, "mesh") else target
        if _orig_write_glb:
            return _orig_write_glb(out_path, target_mesh)
        raise RuntimeError("Native io.write_glb not available")

    _orig_export_glb_bytes = getattr(_native.io, "export_glb_bytes", None) if _native and hasattr(_native, "io") else None

    def export_glb(arg1, arg2=None) -> bytes:
        if arg2 is None and not isinstance(arg1, str):
            target = arg1
            if isinstance(target, (list, tuple)):
                mesh_list = [getattr(m, "mesh", m) for m in target if m is not None]
                if _orig_export_glb_bytes:
                    return _orig_export_glb_bytes(mesh_list)
            else:
                sub_parts = getattr(target, "_sub_parts", None)
                if sub_parts and len(sub_parts) > 1:
                    mesh_list = [getattr(m, "mesh", m) for m in sub_parts if m is not None]
                    if _orig_export_glb_bytes:
                        return _orig_export_glb_bytes(mesh_list)

            target_mesh = target.mesh if hasattr(target, "mesh") else target
            if _orig_export_glb_bytes:
                return _orig_export_glb_bytes(target_mesh)

            import tempfile
            with tempfile.NamedTemporaryFile(suffix=".glb", delete=False) as tf:
                tmp_path = tf.name
            try:
                write_glb(tmp_path, target)
                with open(tmp_path, "rb") as f:
                    return f.read()
            finally:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
        return write_glb(arg1, arg2)

    _native.io.write_glb = write_glb
    _native.io.export_glb = export_glb
    if io is not None:
        io.write_glb = write_glb
        io.export_glb = export_glb

from .adaptive_object import (
    create_panelized_loft,
    create_hydraulic_actuator,
    create_louver_bay,
    create_intake_strainer,
    create_spline_conduit_harness,
    create_structural_truss_member,
    sweep_curve_profile,
    revolve_harmonic_solid,
    replicate_metric_array,
    create_revolving_component,
    create_wheel,
    create_wheel_assembly,
    create_lofted_hull,
    create_cambered_foil,
    validate_scene,
    superellipse_loop,
    superellipse_point,
)

# Attach universal operators to geometry module
if _native is not None and hasattr(_native, "geometry"):
    _native.geometry.create_revolving_component = create_revolving_component
    _native.geometry.create_wheel = create_wheel
    _native.geometry.create_wheel_assembly = create_wheel_assembly
    _native.geometry.create_lofted_hull = create_lofted_hull
    _native.geometry.create_cambered_foil = create_cambered_foil

# Validation Module
class _ValidationModule:
    validate_scene = staticmethod(validate_scene)

validation = _ValidationModule()

# Build specs read from reference images (build_3d_object_from_reference): sb.object_spec.build(spec) -> Scene
from . import object_spec

__all__ = [
    "create_panelized_loft",
    "create_hydraulic_actuator",
    "create_louver_bay",
    "create_intake_strainer",
    "create_spline_conduit_harness",
    "create_structural_truss_member",
    "sweep_curve_profile",
    "revolve_harmonic_solid",
    "replicate_metric_array",
    "create_revolving_component",
    "create_wheel",
    "create_wheel_assembly",
    "create_lofted_hull",
    "create_cambered_foil",
    "validate_scene",
    "validation",
    "superellipse_loop",
    "superellipse_point",
    "Scene",
    "World",
    "Terrain",
    "Structure",
    "RomanOrder",
    "PlantPreset",
    "Flora",
    "create_vegetation",
    "create_building",
    "create_curved_building",
    "create_tower",
    "create_tree",
    "create_ivy",
    "create_studio_pedestal",
    "create_cylinder",
    "create_cone",
    "create_plane",
    "create_box",
    "create_cube",
    "create_sphere",
    "create_catenary_cable",
    "create_beveled_box",
    "create_subdivided_box",
    "create_envelope",
    "create_arched_blister",
    "create_lathe",
    "create_loft",
    "create_form",
    "layout",
    "pbr",
    "geospatial",
    "nature",
    "architecture",
    "constants",
    "math",
    "geometry",
    "io",
    "core",
    "shaper",
    "composer",
    "plant",
    "processing",
    "topology",
    "sdf",
    "hair"
]
