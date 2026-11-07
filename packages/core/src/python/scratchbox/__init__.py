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
from . import vegetation
from .vegetation import SbVeggieTree, create_vegetation
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
        for t in (getattr(self, "_sb_veggie_trees", None) or []):
            t.translate(*args) if len(args) == 3 else t.translate(_to_point3(args[0]))
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
        for t in (getattr(self, "_sb_veggie_trees", None) or []):
            t.scale(*args) if len(args) == 3 or isinstance(args[0], (int, float)) else t.scale(_to_point3(args[0]))
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
        # An SB-Veggie tree is not geometry yet: the mesh holds it, and the GLB writer grows it natively with its levels of
        # detail (vegetation.py). A mesh that holds trees passes them on when it is merged into another.
        if isinstance(other, SbVeggieTree):
            held = getattr(self, "_sb_veggie_trees", None)
            if held is None:
                held = []
                self._sb_veggie_trees = held
            if all(t is not other for t in held):
                held.append(other)
            return self
        inner = getattr(other, "_sb_veggie_trees", None)
        if inner:
            held = getattr(self, "_sb_veggie_trees", None)
            if held is None:
                held = []
                self._sb_veggie_trees = held
            for t in inner:
                if all(h is not t for h in held):
                    held.append(t)
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
        for t in (getattr(self, "_sb_veggie_trees", None) or []):
            t.rotate_y(angle_deg)
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
            pres_c = bool(kwargs.get("preserve_creases", False))
            crease_deg = float(kwargs.get("crease_angle_deg", 45.0))
            if _orig_decimate_qem:
                _orig_decimate_qem(self, t_tri, r, max_err, pres_b, pres_c, crease_deg)
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

        _orig_bake_rtao = getattr(_NativeMesh, "bake_rtao", None)
        _orig_compute_rtao = getattr(_NativeMesh, "compute_rtao", None)

        def _mesh_bake_rtao(self, samples_per_vertex=16, max_distance=1.5, intensity=1.0, seed=42):
            if _orig_bake_rtao:
                _orig_bake_rtao(self, int(samples_per_vertex), float(max_distance), float(intensity), int(seed))
            return self

        def _mesh_compute_rtao(self, samples_per_vertex=16, max_distance=1.5, seed=42):
            if _orig_compute_rtao:
                return list(_orig_compute_rtao(self, int(samples_per_vertex), float(max_distance), int(seed)))
            return [1.0] * len(self.vertices)

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
        _NativeMesh.bake_rtao = _mesh_bake_rtao
        _NativeMesh.compute_rtao = _mesh_compute_rtao
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
            # name= also qualifies its face names (top -> name.top) for named edits after a merge
            mesh = _orig_create_box(s, c, str(kwargs["name"])) if kwargs.get("name") else _orig_create_box(s, c)
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
    if "windows_per_bay" in kwargs:
        cfg.windows_per_bay = max(1, int(kwargs["windows_per_bay"]))
    if "window_gap" in kwargs:
        cfg.window_gap_m = float(kwargs["window_gap"])
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
    _frame, _roof, _foundation, _trim) with world-metre UVs, ready for write_textured_building.
    foundation is the plinth alone; trim is the horizontal trim of every floor (sills, ledges, belt
    and string courses, cornices, floor-slab edges); roof includes the top deck, the terrace a tier
    above stands on when stacked.

    Both builders take the same layout controls:
      floor_heights: storey heights from the ground floor up (entries override the defaults);
      centre_bay_scale / end_bay_scale: width of the middle and outermost bays relative to the rest;
      windows_per_bay / window_gap: openings side by side in each bay (2 = a pair), window_width each, with
        window_gap metres of wall between them; a bay too narrow for them keeps one;
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


def site() -> Dict[str, Any]:
    """
    The measured massing of the real building passed as execute_3d_python_script's site: place, frame (x east,
    z south, metres from the place point, y up from the building's lowest point), "tiers" (each base_m, top_m,
    area_m2, plan "loops", provenance, source, confidence), "top_m" (the highest point the vector data reaches),
    "wall_direction_deg" and notes. Raises when the call gave no site.
    """
    path = os.environ.get("SCRATCHBOX_SITE_JSON")
    if not path or not os.path.exists(path):
        raise RuntimeError("no site was measured for this run: pass site=<building or address> to execute_3d_python_script")
    with open(path, "r", encoding="utf-8") as fh:
        raw = _json.load(fh)
    snake = lambda k: _re.sub(r"(?<!^)(?=[A-Z])", "_", k).lower().replace("_m2", "_m2")
    def conv(o):
        if isinstance(o, dict):
            return {snake(k): conv(v) for k, v in o.items()}
        if isinstance(o, list):
            return [conv(v) for v in o]
        return o
    return conv(raw)


def _choose_tier_outline(t, sc, shell, axis: float, modeled, tol: float) -> Dict[str, Any]:
    """The outline a scan tier gets: candidates scored against the scan within the tier's own height band (coverage and
    precision as sb.massing measures them, F decides): the slices' consensus (square to the walls), the same snapped onto
    the scan's walls, the fullest slice squared and snapped, and Google's modeled outline at this height when there is
    one. Returns {"ring", "label", "provenance", "scores": [{"label", "coverage", "precision", "f"}...]}."""
    base, top = t["base_m"], t["top_m"]
    band = [p for p in shell if base - 0.5 <= p.y <= top + 0.5]
    cands = []
    rings, weights = [r for r, _ in t["slices"]], [w for _, w in t["slices"]]
    consensus = _rectilinear_consensus(rings, weights, axis, 0.5) if len(rings) > 1 else _rectilinear_ring(t["fullest"], axis)
    fullest = _rectilinear_ring(t["fullest"], axis) or _simplify_ring(t["fullest"], tol)[0]
    def snap(ring):
        out, _edges = massing_module._sm.snap_plan_to_scan(list(ring), sc.samples, base, top, 3.0)
        out = [tuple(q) for q in out]
        return None if len(out) < 3 or _ring_crosses(out) else out
    if consensus:
        cands.append(("consensus of the tier's slices, square to the walls", consensus, "measured"))
        sn = snap(consensus)
        if sn:
            cands.append(("consensus, walls snapped onto the scan", sn, "measured"))
    sn = snap(fullest)
    cands.append(("fullest slice, square, walls snapped onto the scan" if sn else "fullest slice, square to the walls", sn or fullest, "measured"))
    mid = (base + top) / 2
    for mt in modeled:
        if mt["base_m"] <= mid <= mt["top_m"]:
            cands.append(("Google's modeled volume at this height", [tuple(q) for q in mt["loops"][0]], "vector-modelled"))
            break
    scores, best = [], None
    for label, ring, prov in cands:
        if not _generator_safe(ring):
            scores.append({"label": label, "rejected": "crosses itself once tidied as the building generator tidies outlines"})
            continue
        mesh = massing_module._sm.extrude_block(list(ring), base, top)
        cs = massing_module._sm.sample_surface(mesh, sc.spacing)
        a = massing_module._sm.agreement(band, cs, 1.0, 2.0, sc.ground_y, None, [], coverage_tau=2.5)
        sc_ = {"label": label, "coverage": round(a.coverage, 3), "precision": round(a.precision, 3), "f": round(a.f, 3)}
        scores.append(sc_)
        if best is None or a.f > best[0]:
            best = (a.f, label, ring, prov)
    if best is None:
        safe = _simplify_ring(t["fullest"], tol)[0]
        return {"ring": safe, "label": "fullest slice, simplified (every squared candidate crossed itself)", "provenance": "measured", "scores": scores}
    return {"ring": best[2], "label": best[1], "provenance": best[3], "scores": scores}


def _generator_safe(ring) -> bool:
    """Whether the building generator can take this outline: tidied as it tidies one (points under 5 cm merged, bends
    under 10 degrees and spikes dropped), it still has 3 corners and does not cross itself."""
    pts = [tuple(p) for p in ring]
    changed = True
    while changed and len(pts) >= 3:
        changed = False
        for i in range(len(pts)):
            a, b, c = pts[i - 1], pts[i], pts[(i + 1) % len(pts)]
            ab = (b[0] - a[0], b[1] - a[1]); bc = (c[0] - b[0], c[1] - b[1])
            lab, lbc = _py_math.hypot(*ab), _py_math.hypot(*bc)
            drop = lab < 0.05
            if not drop and lbc >= 0.05:
                u = (ab[0] / lab, ab[1] / lab); v = (bc[0] / lbc, bc[1] / lbc)
                cr, dt = u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]
                drop = (abs(cr) < 0.1736 and dt > 0) or dt < -0.985
            if drop:
                pts.pop(i)
                changed = True
                break
    return len(pts) >= 3 and not _ring_crosses(pts)


def _hull_area(pts) -> float:
    """Area of the convex hull of (x, z) points."""
    pts = sorted(set(pts))
    if len(pts) < 3:
        return 0.0
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0:
            up.pop()
        up.append(p)
    h = lo[:-1] + up[:-1]
    return abs(sum(h[i][0] * h[(i + 1) % len(h)][1] - h[(i + 1) % len(h)][0] * h[i][1] for i in range(len(h)))) / 2.0


def _min_rect_axis_deg(ring) -> float:
    """The direction (degrees, 0..90) of the minimum-area rectangle enclosing a ring: its walls' direction."""
    pts = sorted(set(tuple(p) for p in ring))
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for q in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], q) <= 0:
            lo.pop()
        lo.append(q)
    for q in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], q) <= 0:
            up.pop()
        up.append(q)
    h = lo[:-1] + up[:-1]
    best, best_a = 0.0, float("inf")
    for i in range(len(h)):
        (ax, az), (bx, bz) = h[i], h[(i + 1) % len(h)]
        t = _py_math.atan2(bz - az, bx - ax)
        c, s_ = _py_math.cos(t), _py_math.sin(t)
        us = [x * c + z * s_ for x, z in h]; vs = [-x * s_ + z * c for x, z in h]
        area = (max(us) - min(us)) * (max(vs) - min(vs))
        if area < best_a:
            best_a, best = area, _py_math.degrees(t) % 90.0
    return best


def _rectilinear_ring(ring, axis_deg: float, cell: float = 1.0, min_run: float = 3.0, noise_cells: int = 2):
    """The ring rebuilt square to the walls (see _rectilinear_consensus, with one ring)."""
    return _rectilinear_consensus([ring], [1.0], axis_deg, 0.5, cell, min_run, noise_cells, ring)


def _rectilinear_consensus(rings, weights, axis_deg: float, quorum: float = 0.5, cell: float = 1.0, min_run: float = 3.0,
                           noise_cells: int = 2, reference=None):
    """One plan square to the walls from several slices of it: each ring is filled on a `cell` grid turned to axis_deg
    with its weight (its slice's height), and a cell belongs to the plan when it is filled in at least `quorum` of the
    total weight (a light court present in most slices stays; a wing one slice lost, or a canopy one slice caught, does
    not decide). Noise up to noise_cells is opened and closed away and the edge traced back as straight wall runs (steps
    under min_run folded). None when the result crosses itself or its area differs from `reference`'s (default: the
    weighted mean of the rings') by more than a fifth."""
    a = _py_math.radians(axis_deg)
    c, s_ = _py_math.cos(a), _py_math.sin(a)
    Ps = [[(x * c + z * s_, -x * s_ + z * c) for x, z in r] for r in rings if len(r) >= 3]
    if not Ps:
        return None
    allp = [p for P in Ps for p in P]
    u0, v0 = min(p[0] for p in allp) - 2 * cell, min(p[1] for p in allp) - 2 * cell
    nu = int((max(p[0] for p in allp) - u0) / cell) + 3
    nv = int((max(p[1] for p in allp) - v0) / cell) + 3
    if nu * nv > 4_000_000:
        return None
    acc = [[0.0] * nu for _ in range(nv)]
    total = 0.0
    for P, w in zip(Ps, weights):
        total += w
        n = len(P)
        for j in range(nv):
            vc = v0 + (j + 0.5) * cell
            xs = []
            for i in range(n):
                (ua, va), (ub, vb) = P[i], P[(i + 1) % n]
                if (va > vc) != (vb > vc):
                    xs.append(ua + (vc - va) * (ub - ua) / (vb - va))
            xs.sort()
            for k in range(0, len(xs) - 1, 2):
                i0 = max(0, int(_py_math.ceil((xs[k] - u0) / cell - 0.5)))
                i1 = min(nu - 1, int(_py_math.floor((xs[k + 1] - u0) / cell - 0.5)))
                for i in range(i0, i1 + 1):
                    acc[j][i] += w
    need = quorum * total
    grid = [[v >= need - 1e-9 for v in row] for row in acc]
    def morph(g, keep):   # keep=True: dilate; False: erode (4-neighbourhood)
        out = [row[:] for row in g]
        for j in range(1, nv - 1):
            for i in range(1, nu - 1):
                nb = (g[j][i], g[j - 1][i], g[j + 1][i], g[j][i - 1], g[j][i + 1])
                out[j][i] = any(nb) if keep else all(nb)
        return out
    for _ in range(noise_cells):
        grid = morph(grid, False)
    for _ in range(noise_cells):
        grid = morph(grid, True)                # open: spikes and slivers up to noise_cells wide gone
    for _ in range(noise_cells):
        grid = morph(grid, True)
    for _ in range(noise_cells):
        grid = morph(grid, False)               # close: notches up to noise_cells wide filled
    # boundary edges with the filled side on the left, chained into loops (corner points on the cell lattice)
    nxt = {}
    for j in range(nv):
        for i in range(nu):
            if not grid[j][i]:
                continue
            if j == 0 or not grid[j - 1][i]:
                nxt[(i, j)] = (i + 1, j)
            if i == nu - 1 or not grid[j][i + 1]:
                nxt[(i + 1, j)] = (i + 1, j + 1)
            if j == nv - 1 or not grid[j + 1][i]:
                nxt[(i + 1, j + 1)] = (i, j + 1)
            if i == 0 or not grid[j][i - 1]:
                nxt[(i, j + 1)] = (i, j)
    if not nxt:
        return None
    loops, seen = [], set()
    for start in list(nxt):
        if start in seen:
            continue
        loop, q = [], start
        while q not in seen and q in nxt:
            seen.add(q); loop.append(q); q = nxt[q]
        if len(loop) >= 4:
            loops.append(loop)
    def la(l):
        return abs(sum(l[i][0] * l[(i + 1) % len(l)][1] - l[(i + 1) % len(l)][0] * l[i][1] for i in range(len(l)))) / 2.0
    loop = max(loops, key=la)
    # corners only
    pts = [loop[i] for i in range(len(loop)) if (loop[i - 1][0] - loop[i][0]) * (loop[(i + 1) % len(loop)][1] - loop[i][1]) != (loop[i - 1][1] - loop[i][1]) * (loop[(i + 1) % len(loop)][0] - loop[i][0])]
    pts = [[u0 + i * cell, v0 + j * cell] for i, j in pts]

    def collinear_clean(q):
        out_ = []
        for i in range(len(q)):
            p0, p1, p2 = q[i - 1], q[i], q[(i + 1) % len(q)]
            if abs((p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0])) > 1e-6:
                out_.append(p1)
        return out_
    # a short step between two parallel wall runs is folded away: the shorter of the two runs is moved onto the other's
    # line, so the wall stays one straight run and every corner stays square
    for _ in range(4 * len(pts)):
        pts = collinear_clean(pts)
        m_ = len(pts)
        if m_ <= 4:
            break
        lens = [abs(pts[(i + 1) % m_][0] - pts[i][0]) + abs(pts[(i + 1) % m_][1] - pts[i][1]) for i in range(m_)]
        i = min(range(m_), key=lambda k: lens[k])
        if lens[i] >= min_run:
            break
        a_, b_ = pts[i], pts[(i + 1) % m_]
        axis_k = 0 if abs(a_[0] - b_[0]) > 1e-9 else 1     # the step runs along u (0) or v (1)
        prev_len, next_len = lens[i - 1], lens[(i + 1) % m_]
        d = b_[axis_k] - a_[axis_k]
        if next_len <= prev_len:     # move the run after the step back onto the run before it
            pts[(i + 1) % m_][axis_k] -= d
            pts[(i + 2) % m_][axis_k] -= d
        else:                        # move the run before the step onto the run after it
            pts[i][axis_k] += d
            pts[i - 1][axis_k] += d
    out = collinear_clean(pts)
    out = [tuple(q) for q in out]
    back = [(x * c - z * s_, x * s_ + z * c) for x, z in out]
    area = lambda r: abs(sum(r[i][0] * r[(i + 1) % len(r)][1] - r[(i + 1) % len(r)][0] * r[i][1] for i in range(len(r)))) / 2.0
    ref = area(reference) if reference is not None else sum(area(r) * w for r, w in zip(rings, weights)) / max(1e-9, total)
    if len(back) < 4 or _ring_crosses(back) or abs(area(back) - ref) > 0.2 * ref:
        return None
    return back


def _ring_crosses(r) -> bool:
    """Whether a closed ring's non-adjacent edges cross."""
    n = len(r)
    def o(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    for i in range(n):
        a, b = r[i], r[(i + 1) % n]
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue
            c, d = r[j], r[(j + 1) % n]
            d1, d2, d3, d4 = o(c, d, a), o(c, d, b), o(a, b, c), o(a, b, d)
            e = 1e-6 * max(_py_math.dist(a, b), _py_math.dist(c, d)) ** 2 + 1e-9   # as the generator's test: collinear is no cross
            if ((d1 > e and d2 < -e) or (d1 < -e and d2 > e)) and ((d3 > e and d4 < -e) or (d3 < -e and d4 > e)):
                return True
    return False


def _simplify_ring(ring, tol: float):
    """Douglas-Peucker on a closed ring (split at its two farthest points), the tolerance raised until the ring no longer
    crosses itself; returns (ring, tolerance used)."""
    def dp(pts, t):
        if len(pts) < 3:
            return list(pts)
        (ax, az), (bx, bz) = pts[0], pts[-1]
        L = _py_math.hypot(bx - ax, bz - az) or 1e-9
        k, dmax = 0, -1.0
        for i in range(1, len(pts) - 1):
            d = abs((bx - ax) * (az - pts[i][1]) - (ax - pts[i][0]) * (bz - az)) / L
            if d > dmax:
                k, dmax = i, d
        if dmax <= t:
            return [pts[0], pts[-1]]
        return dp(pts[:k + 1], t)[:-1] + dp(pts[k:], t)
    pts = [tuple(p) for p in ring]
    if len(pts) < 4:
        return pts, 0.0
    far = max(range(len(pts)), key=lambda i: (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2)
    t = tol
    for _ in range(8):
        out = dp(pts[:far + 1], t)[:-1] + dp(pts[far:] + [pts[0]], t)[:-1]
        if len(out) >= 3 and not _ring_crosses(out):
            return out, t
        t *= 1.6
    return out, t


def site_tiers(massing: Optional[Dict[str, Any]] = None, name: str = "Site", floor_height: float = 3.7,
               ground_floor_height: float = 4.5, plinth_height: float = 0.6, min_tier_m: float = 2.4,
               spire_area_m2: float = 200.0, source: str = "auto", scan_setback: float = 0.12, scan_window_m: float = 45.0,
               scan_outline_tol: float = 0.6,
               **common) -> Dict[str, Any]:
    """
    Turns measured massing (sb.site() by default) into create_building_parts arguments, one tier per level of the
    setback stack, sized to the measurement: each tier's outline is its measured plan, base_y its measured base, and
    its storeys fill exactly from base to measured top. Storey heights are not measured: the ground floor takes
    ground_floor_height and the rest floor_height (norms), all scaled together so they land on the measured top, and
    the report says so ("generated"). A tier thinner than min_tier_m joins the tier above; one under spire_area_m2
    (a mast or spire) is returned under "spires" for the script to build as an add-on, not as storeys. Every tier
    above the ground one gets entrance=False. **common (bay_width, window sizes, details, facade_rules, roof...) is
    passed to every tier.

    When the site was measured with siteFacade, its facade readings are applied per tier (the reading covering the
    tier's height; tiers above every reading repeat the highest one, labelled so): storey heights, bay width, window
    size, sill and recess, ground-floor openings, plinth, parapet, piers (as pilasters) and cornice (as a moulding).
    A read value replaces the same setting in **common, and the report lists each replacement; values a reading
    dropped (out of range, not fitting the measured tiers, failing the cross-check) are not used.

    source picks the setback stack: "auto" (default) takes Google's modeled volume when there is one, else the
    building's 3D-tiles scan read into tiers by sb.massing (labelled measured), else the vector extrusions; "modeled",
    "scan" or "vector" force one. plan["source"] says which was used. Scan tiers are read from the scan's fine levels: a
    scan loses parts of a slice (a wing, a notch's walls) far more often than it adds any, so a straight shaft's plan
    flickers while its largest extent holds. A new tier starts where the largest convex extent in the next scan_window_m
    metres falls more than scan_setback below the current tier's largest (or rises 30% above it); each tier takes its
    fullest slice's outline. Each outline is rebuilt square to the walls: filled on a 1 m
    grid turned to the walls' direction (the base's minimum-area enclosing rectangle), single-cell noise removed, and its
    edge traced back as straight wall runs; a plan that loses over a fifth of its area that way (curved, mostly
    diagonal) is instead simplified as read (Douglas-Peucker from scan_outline_tol metres) and checked not to cross.

    Returns {"tiers": [kwargs...], "spires": [...], "above_top_m": metres the vector top rises above the last tier
    (an antenna), "colors": the read wall / trim / glass colours (sRGB) with their provenance, or None,
    "report": [...]}; build with
        parts = sb.stack_buildings(*[sb.create_building_parts(**t) for t in plan["tiers"]]).
    """
    m = massing if massing is not None else site()
    vector_tiers = m.get("tiers", [])
    scan = m.get("scan")
    if source not in ("auto", "modeled", "scan", "vector"):
        raise ValueError(f"source must be auto, modeled, scan or vector, got {source!r}")
    use_scan = source == "scan" or (source == "auto" and m.get("source") != "modeled" and scan is not None)
    if source == "modeled" and m.get("source") != "modeled":
        raise ValueError("the site has no modeled volume (Google gives this building as extrusions or not at all); use source='scan' or 'vector'")
    if use_scan:
        if scan is None:
            raise ValueError("the site has no 3D-tiles scan: " + "; ".join(n for n in m.get("notes", []) if "scan" in n))
        sc = massing_module.Scan.load(scan["glb_path"], plan=scan.get("plan") or None, ground_y=scan.get("ground_y", 0.0))
        fine = [t for t in sc.tiers(change=0.08, min_tier=2.0).tiers if t.area > 1.0]
        hulls = [_hull_area([tuple(p) for p in t.outline]) for t in fine]
        merged = []
        for i, t in enumerate(fine):
            ahead = max(h for k, h in enumerate(hulls) if k >= i and fine[k].y0 < t.y0 + scan_window_m)
            if merged and (1.0 - scan_setback) * merged[-1]["run_max"] <= ahead <= 1.3 * merged[-1]["run_max"]:
                last = merged[-1]
                if hulls[i] > last["run_max"]:      # the fullest slice's outline is one of the candidates
                    last.update(fullest=[tuple(p) for p in t.outline], area_m2=t.area, run_max=hulls[i])
                last["top_m"] = t.y1
                last["slices"].append(([tuple(p) for p in t.outline], t.y1 - t.y0))
                continue
            merged.append({"base_m": t.y0, "top_m": t.y1, "area_m2": t.area, "fullest": [tuple(p) for p in t.outline], "run_max": hulls[i],
                           "slices": [([tuple(p) for p in t.outline], t.y1 - t.y0)]})
        axis = _min_rect_axis_deg(merged[0]["fullest"]) if merged else 0.0
        modeled = [t for t in m.get("tiers", []) if m.get("source") == "modeled"]
        shell, _interior = _scan_shell(sc, scan)
        vector_tiers = []
        for t in merged:
            choice = _choose_tier_outline(t, sc, shell, axis, modeled, scan_outline_tol)
            vector_tiers.append({"base_m": t["base_m"], "top_m": t["top_m"], "area_m2": t["area_m2"], "loops": [choice["ring"]],
                                 "provenance": choice["provenance"], "source": f"setback tier from the 3D-tiles scan (sb.massing); outline: {choice['label']}",
                                 "confidence": 0.8, "outline_choice": choice["scores"]})
        used = "scan"
    else:
        used = m.get("source", "vector") if source == "auto" else source
    raw = sorted(vector_tiers, key=lambda t: (t["base_m"], -t["area_m2"]))
    if not raw:
        raise ValueError("the site has no measured tiers: " + "; ".join(m.get("notes", [])))
    readings = sorted((m.get("facade") or {}).get("readings", []), key=lambda r: r["applies_from_m"])

    def reading_for(mid):
        for r in readings:
            if r["applies_from_m"] <= mid <= r["applies_to_m"]:
                return r, False
        below = [r for r in readings if r["applies_to_m"] < mid]
        return (below[-1], True) if below else (None, False)

    def srgb(c):
        return tuple(round(1.055 * max(0.0, x) ** (1 / 2.4) - 0.055 if x > 0.0031308 else 12.92 * x, 4) for x in c)

    colors = None
    for r in readings:
        v = r.get("values", {})
        if "wall_rgb" in v:
            colors = {"wall": srgb(v["wall_rgb"]), "trim": srgb(v.get("trim_rgb", v["wall_rgb"])),
                      "glass": srgb(v.get("glass_rgb", (0.05, 0.07, 0.09))), "provenance": r["provenance"],
                      "source": r["source"]}
            break

    tiers, spires, report = [], [], []
    carry_base = None
    for t in raw:
        base = t["base_m"] if carry_base is None else carry_base
        top = t["top_m"]
        if t["area_m2"] < spire_area_m2:
            spires.append({"base_m": base, "top_m": top, "area_m2": t["area_m2"], "loops": t["loops"],
                           "provenance": t["provenance"]})
            carry_base = None
            continue
        if top - base < min_tier_m:
            carry_base = base      # too thin for a storey: the next tier starts here instead
            continue
        carry_base = None
        loops = t["loops"]
        ground = not tiers and base < 0.5
        h = top - base
        reading, repeated = reading_for((base + top) / 2)
        v = reading["values"] if reading else {}
        fh = v.get("upper_storey_m", floor_height)
        gh = v.get("ground_storey_m", ground_floor_height)
        ph = v.get("plinth", {}).get("height_m", plinth_height) if ground else plinth_height
        if ground:
            usable = h - ph
            n = max(1, int(round((usable - gh) / fh)) + 1)
            nominal = [gh] + [fh] * (n - 1)
        else:
            n = max(1, int(round(h / fh)))
            nominal = [fh] * n
            usable = h
        k = usable / sum(nominal)
        heights = [round(x * k, 4) for x in nominal]
        kw = dict(common)
        kw.update(footprint=[tuple(p) for p in loops[0]], courtyards=[[tuple(p) for p in l] for l in loops[1:]] or None,
                  base_y=base, floors=n, floor_heights=heights, ground_floor_height=heights[0], floor_height=heights[-1],
                  plinth_height=ph if ground else 0.0, name=f"{name}T{len(tiers)}")
        kw.setdefault("roof", "flat")
        applied, replaced = [], []

        def put(key, value, label):
            if key in common and common[key] != value:
                replaced.append(f"{key} {common[key]!r} -> {value!r}")
            kw[key] = value
            applied.append(label)
        if v:
            if "bay_width_m" in v:
                put("bay_width", v["bay_width_m"], "bay width")
            win = v.get("window")
            if win:
                put("window_width", win["width_m"], "window size")
                kw["window_height"] = win["height_m"]
                kw["window_recess_depth"] = win["recess_m"]
            if "parapet_m" in v:
                put("parapet_height", v["parapet_m"], "parapet")
            details = dict(kw.get("details") or {})
            piers = v.get("piers")
            if piers and piers["width_m"] >= 0.1:
                details.update(pilaster_width_m=piers["width_m"], pilaster_projection_m=max(0.03, piers["projection_m"]))
                applied.append("piers")
            cornice = v.get("cornice")
            if cornice and cornice["thickness_m"] >= 0.1 and cornice["projection_m"] >= 0.05:
                details["cornice_profile"] = moulding_profile(cornice["thickness_m"], cornice["projection_m"])
                applied.append("cornice")
            if details:
                kw["details"] = details
            rules = list(kw.get("facade_rules") or [])
            if win:
                rules.append({"floors": (1, 10000), "sill_height_m": win["sill_m"]})
            go = v.get("ground_opening")
            if ground and go:
                rules.append({"floors": 0, "window_width_m": go["width_m"], "window_height_m": go["height_m"], "sill_height_m": go["sill_m"]})
                applied.append("ground openings")
            if rules:
                kw["facade_rules"] = rules
        if not ground:
            kw["entrance"] = False
        tiers.append(kw)
        report.append({"name": kw["name"], "base_m": round(base, 2), "top_m": round(top, 2), "floors": n,
                       **({"outline_choice": t["outline_choice"]} if "outline_choice" in t else {}),
                       "storey_m": round(sum(heights) / n, 2), "size": f"{t['provenance']} ({t.get('source', '')})",
                       "storeys": ("generated: norms scaled to the measured height" if "upper_storey_m" not in v else
                                   f"{reading['provenance']} storey height {fh:.2f} m, scaled to the measured height"),
                       "facade": ({"source": reading["source"], "provenance": "generated" if repeated else reading["provenance"],
                                   "confidence": reading["confidence"], "applied": applied, "replaced": replaced,
                                   "note": "repeated upward from the highest reading" if repeated else "",
                                   "dropped": reading.get("rejected", {})} if reading else None)})
    tops = [t["top_m"] for t in raw]
    above = (m.get("top_m") or 0.0) - max(tops)
    return {"tiers": tiers, "spires": spires, "above_top_m": round(above, 2) if above > 0.5 else 0.0, "colors": colors,
            "source": used, "report": report}


def benchmark_massing(plan: Dict[str, Any], benchmark: str, crown: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Scores a massing (sb.site_tiers' plan, and optionally sb.site_crown's result) against a building's documented form:
    a benchmark JSON (schema scratchbox.massing-benchmark/1, e.g. docs/benchmarks/<building>.json) giving documented
    setback floors, base footprint, roof and antenna heights with their sources, and the estimates used to turn floors
    into heights. Evaluation only: nothing here changes the plan.

    Returns {"setbacks": [{"floor", "expected_m", "nearest_m", "error_m", "found"}...], "found", "documented",
    "extra_levels": tier boundaries matching no documented setback, "mean_abs_error_m", "footprint": {"documented_m",
    "measured_m", "error_share"}, "heights": {...}, "tolerance_m", "notes"}.
    """
    path = benchmark
    if not os.path.isabs(path) and not os.path.exists(path):
        d = os.path.dirname(os.path.abspath(__file__))
        while d != os.path.dirname(d) and not os.path.exists(os.path.join(d, path)):
            d = os.path.dirname(d)
        path = os.path.join(d, path)
    with open(path, "r", encoding="utf-8") as fh:
        bm = _json.load(fh)
    doc, est = bm["documented"], bm["estimated"]
    storey = est["storey_m"]["value"]
    tol = est["tolerance_m"]["value"]
    tops = sorted({round(r["top_m"], 2) for r in plan["report"]})
    boundaries = tops[:-1] if len(tops) > 1 else tops       # the last tier's top is the building's, not a setback
    setbacks, used = [], set()
    for floor in doc["setback_floors"]["value"]:
        expected = floor * storey
        nearest = min(boundaries + tops[-1:], key=lambda h: abs(h - expected)) if tops else None
        err = None if nearest is None else nearest - expected
        found = err is not None and abs(err) <= tol
        if found:
            used.add(nearest)
        setbacks.append({"floor": floor, "expected_m": round(expected, 1), "nearest_m": nearest, "error_m": None if err is None else round(err, 1), "found": found})
    extra = [h for h in boundaries if h not in used]
    errs = [abs(x["error_m"]) for x in setbacks if x["found"]]
    out: Dict[str, Any] = {"benchmark": bm["name"], "setbacks": setbacks, "found": sum(x["found"] for x in setbacks),
                           "documented": len(setbacks), "extra_levels": extra,
                           "mean_abs_error_m": round(sum(errs) / len(errs), 2) if errs else None, "tolerance_m": tol,
                           "source": plan.get("source"),
                           "notes": [est["setback_heights_m"]["method"], est["tolerance_m"]["method"]]}
    if "base_footprint_m" in doc and plan["tiers"]:
        ring = list(plan["tiers"][0]["footprint"])
        axis = _py_math.radians(_min_rect_axis_deg(ring))
        c, s_ = _py_math.cos(axis), _py_math.sin(axis)
        us = [x * c + z * s_ for x, z in ring]; vs = [-x * s_ + z * c for x, z in ring]
        measured = sorted([max(us) - min(us), max(vs) - min(vs)], reverse=True)
        documented = sorted(doc["base_footprint_m"]["value"], reverse=True)
        out["footprint"] = {"documented_m": documented, "measured_m": [round(v, 1) for v in measured],
                            "error_share": [round(abs(m - d) / d, 3) for m, d in zip(measured, documented)]}
    heights = {}
    if crown and "antenna_tip_m" in doc:
        heights["antenna_tip"] = {"documented_m": doc["antenna_tip_m"]["value"], "measured_m": round(crown["to_m"], 1),
                                  "error_m": round(crown["to_m"] - doc["antenna_tip_m"]["value"], 1)}
    if "storeys" in doc:
        heights["storeys"] = {"documented": doc["storeys"]["value"], "built": sum(t["floors"] for t in plan["tiers"])}
    out["heights"] = heights
    return out


def site_colors(plan: Dict[str, Any], massing: Optional[Dict[str, Any]] = None, spacing_m: float = 0.5,
                margin_m: float = 2.0, terrace_band_m: float = 3.0) -> Dict[str, Any]:
    """
    The real building's colours, tier by tier, read from the 3D tiles' photos (photo-inferred): targets for tinting
    surfaces (sb.library_surface(..., target_color=...), or a coursed surface's unit_color) per tier with per-part
    surfaces keys ("<name>T4_wall"). Needs sb.site_tiers' plan and a site with a scan.

    Per tier, from the photo samples on the building in its height band (sRGB 0..1):
      "wall"       the sunlit sides' lit colour (the photos bake sun and shade in: the brighter half of the sides);
      "wall_spread_lab" the sunlit sides' CIELAB standard deviation [L, a, b] (the photo's texture spread at tile
                   resolution: windows and joints raise it), for sb.library_surface(target_spread=...);
      "wall_shade" the shaded sides' (how far the photos' shade darkens it);
      "sides"      each side's lit colour (N, NE, ... NW of the outward normal);
      "glass"      the dark population of the walls (windows, and the shade between piers, at tile resolution);
      "terrace"    up-facing surfaces within terrace_band_m of the tier's top (its roof deck: a setback terrace
                   when a tier stands on it), or None, with its "terrace_spread_lab";
    and "crown": the same above the last tier. Every reading says how many samples it rests on. A texel can hold stone
    and window together, so these are readings of the photo, not of materials; the Street View facade colours
    (plan["colors"]) read the lower floors closer up. Returns {"tiers": [...], "crown", "provenance", "source", "method"}.
    """
    m = massing if massing is not None else site()
    scan = m.get("scan") or {}
    photo, ground = scan.get("photo_glb_path"), scan.get("photo_ground_y")
    if not photo or ground is None:
        raise RuntimeError("no photo-textured tiles for this site (the scan has no photo_glb_path): pass site= to the script tool")
    rings = [[(float(x), float(z)) for x, z in ring] for ring in scan.get("plan") or []]
    tiers = plan["tiers"]
    spans = [(t.get("base_y", 0.0), t.get("base_y", 0.0) + t.get("plinth_height", 0.0) + sum(t["floor_heights"])) for t in tiers]
    top = spans[-1][1]
    bands = spans + [(top, 1.0e4)]
    walls = massing_module._sm.scan_colours(photo, float(ground), rings, bands, spacing_m, margin_m)
    # a deck lies around the tier's top: a scan-measured top includes the parapet, so the terrace sits a little below it
    decks = massing_module._sm.scan_colours(photo, float(ground), rings, [(y1 - terrace_band_m, y1 + terrace_band_m) for _, y1 in spans], spacing_m, margin_m)
    sides = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")

    def srgb(c):
        return [round(1.055 * max(0.0, x) ** (1 / 2.4) - 0.055 if x > 0.0031308 else 12.92 * x, 4) for x in c]

    def lum(c):
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

    def mean(cs, ws):
        w = sum(ws) or 1.0
        return [sum(c[i] * k for c, k in zip(cs, ws)) / w for i in range(3)]

    def reading(band):
        rs = [r for r in walls["regions"] if r["band"] == band and r["facing"] < 8 and r["samples"] >= 100]
        if not rs:
            return {"wall": None, "wall_spread_lab": None, "wall_shade": None, "sides": {}, "glass": None, "wall_samples": 0}
        rs.sort(key=lambda r: lum(r["lit_linear"]), reverse=True)
        half = max(1, len(rs) // 2)
        lit, shade = rs[:half], rs[half:] or rs[:half]
        return {"wall": srgb(mean([r["lit_linear"] for r in lit], [r["samples"] for r in lit])),
                "wall_spread_lab": [round(x, 2) for x in mean([r["lit_spread_lab"] for r in lit], [r["samples"] for r in lit])],
                "wall_shade": srgb(mean([r["lit_linear"] for r in shade], [r["samples"] for r in shade])),
                "sides": {sides[r["facing"]]: srgb(r["lit_linear"]) for r in rs},
                "glass": srgb(mean([r["dark_linear"] for r in rs], [r["samples"] * r["dark_share"] for r in rs])),
                "wall_samples": sum(r["samples"] for r in rs)}

    out_tiers = []
    for i, (t, (y0, y1)) in enumerate(zip(tiers, spans)):
        row = {"name": t.get("name"), "base_m": round(y0, 2), "top_m": round(y1, 2)}
        row.update(reading(i))
        deck = [r for r in decks["regions"] if r["band"] == i and r["facing"] == 8 and r["samples"] >= 50]
        row["terrace"] = srgb(deck[0]["lit_linear"]) if deck else None
        row["terrace_spread_lab"] = [round(x, 2) for x in deck[0]["lit_spread_lab"]] if deck else None
        row["terrace_samples"] = deck[0]["samples"] if deck else 0
        out_tiers.append(row)
    crown = reading(len(spans))
    up = [r for r in walls["regions"] if r["band"] == len(spans) and r["facing"] == 8 and r["samples"] >= 50]
    crown["up"] = srgb(up[0]["lit_linear"]) if up else None
    return {"tiers": out_tiers, "crown": crown, "provenance": "photo-inferred",
            "source": f"Google 3D Tiles photos of the building ({walls['kept']} samples on it)",
            "method": ("photo texels sampled every %.2f m over the tiles inside the building outline (+%.1f m); per tier and "
                       "facing the lit colour (an Otsu split of log luminance keeps the lit side when sun and shade differ "
                       "1.6x or more); the wall colour from the sunlit sides; glass from the dark population" % (spacing_m, margin_m))}


_SITE_GUIDES: Dict[Any, Any] = {}


def site_guides(massing: Optional[Dict[str, Any]] = None):
    """
    The real building's straightened facade photos from a 3D Building run of the same building (pipeline K): its finished
    model (rebuilt facades carrying the straightened, de-lit and harmonised photos) seen straight on at each facade, or
    K's rectified orthos when the model is not found; on their planes in sb.site_tiers' frame: (guides, info). guides is None when there are none, and
    info["reason"] says why (run the 3D Building for the place first). Used by sb.site_part_colors and, on its own, by
    write_textured_building's default weathering (the photos' residual against their own repeats is its stain).
    """
    m = massing if massing is not None else site()
    g = m.get("guides")
    if not g:
        return None, {"reason": m.get("guides_reason") or "no facade guides for this site"}
    key = (g.get("run_id"), g.get("orthos_dir"), g.get("model"))
    if key not in _SITE_GUIDES:
        _SITE_GUIDES[key] = _native.weathering.load_facade_guides(g["facades"], g.get("model") or "", g.get("model_matrix") or [])
    loaded = _SITE_GUIDES[key]
    return loaded, {"source": g.get("source"), "facades": loaded.facade_count, "notes": list(loaded.notes)}


def site_part_colors(parts, extras=None, massing: Optional[Dict[str, Any]] = None, spacing_m: float = 0.25) -> Dict[str, Any]:
    """
    Every built part's colour read from the real building's straightened facade photos (sb.site_guides), after each
    photo is registered to the build: slid within half a bay and half a storey to where the build's glass lands on the
    photo's dark windows and its walls on the photo's light surfaces. A part's colour is the lit middle of the photo
    under it (40th-95th luminance percentile, linear mean), so a tier's wall, trim, frame and glass each get their own.

    parts: building parts (sb.stack_buildings / create_building_parts); extras: add-on dicts with "mesh" (optional).
    Returns {"parts": {name: {"color": sRGB, "samples", "provenance": "photo-inferred"} or {"color": None, "samples"}},
    "facades": [{"id", "shift_s", "shift_t", "score", "score_at_zero", ...}], "source"}. Raises with the reason when the
    site has no guides. A part the photos do not cover (a roof, a hidden face) gets None: tint it from sb.site_colors.
    """
    guides, info = site_guides(massing)
    if guides is None:
        raise RuntimeError(f"no facade guides: {info['reason']}")
    entries = []
    meshes = list(parts) + [e["mesh"] for e in (extras or [])]
    for mm in meshes:
        slot = mm.name.rsplit("_", 1)[-1]
        role = 1 if slot == "glass" else 0 if slot in ("wall", "foundation") else -1
        entries.append((mm.name, role, mm))
    res = guides.register_and_colour(entries, spacing_m)

    def srgb(c):
        return [round(1.055 * max(0.0, x) ** (1 / 2.4) - 0.055 if x > 0.0031308 else 12.92 * x, 4) for x in c]
    out = {}
    for name, d in res["parts"].items():
        ok = d["samples"] >= 20
        out[name] = {"color": srgb(d["linear"]) if ok else None, "samples": d["samples"]}
        if ok:
            out[name]["provenance"] = "photo-inferred"
    return {"parts": out, "facades": res["facades"], "source": info.get("source")}


def site_lattice(plan: Dict[str, Any], massing: Optional[Dict[str, Any]] = None, apply: bool = True,
                 min_piers: int = 4, min_contrast: float = 1.3) -> Dict[str, Any]:
    """
    The real building's facade lattice per tier, read from its straightened facade photos (sb.site_guides): each photo's
    column profile split into light pier columns and dark infill (the windows and spandrels between them), giving the
    pier pitch and width and three colours: the pier stone, the infill and the glass (the darkest fifth of the infill).
    A tier takes the width-weighted median over the photos that cross its height and show a clear lattice (at least
    min_piers piers, light over dark at least min_contrast, piers narrower than 60% of the pitch); a tier no such photo
    crosses repeats the nearest one below or above (labelled so).

    Each tier's bay is also read from the same photos' median bay (sb.site_textures' cell): how many windows sit side by
    side in it (dark runs across its window rows), their width and the wall between them, and whether any band across
    the bay is light like the stone ("light_band", the brightest row against the pier).

    With apply (default) each of plan's tiers (sb.site_tiers) is changed in place to that lattice: bay_width = the
    pitch, a pilaster of the pier's width at every bay (details pilaster_width_m, pilaster_bay_stride 1), the windows
    the bay shows (windows_per_bay, window_width, window_gap), else window_width = the infill's width less 0.3 m. Where
    no band across the bay is light (light_band under 0.8), the photo shows no sills, ledges or belt courses there, so the
    tier gets none (sill off, belt_projection_m 0, sill_profile and string courses dropped) and the piers run unbroken.
    Colours are returned, not applied:
    {"trim": pier (the pilasters are trim), "wall": infill (the spandrels between windows are wall), "glass"}, sRGB.

    Returns {"tiers": [{"name", "pitch_m", "pier_width_m", "colors", "facades": ids, "provenance": "photo-inferred" or
    "generated", "note"}], "source"}. Raises with the reason when the site has no guides.
    """
    guides, info = site_guides(massing)
    if guides is None:
        raise RuntimeError(f"no facade guides: {info['reason']}")

    def srgb(c):
        return [round(1.055 * max(0.0, x) ** (1 / 2.4) - 0.055 if x > 0.0031308 else 12.92 * x, 4) for x in c]

    good = []
    for d in guides.lattices():
        if not d["ok"] or d["piers"] < min_piers or d["contrast"] < min_contrast or d["pier_width_m"] >= 0.6 * d["pitch_m"]:
            continue
        up = d["axis_t"][1]
        if abs(up) < 0.9:
            continue        # a photo not upright on its facade has no columns to read
        y0, y1 = sorted((d["centroid"][1] + up * d["t_min"], d["centroid"][1] + up * d["t_max"]))
        good.append(dict(d, y0=y0, y1=y1))

    def wmedian(pairs):
        pairs = sorted(pairs)
        half, acc = sum(w for _, w in pairs) / 2.0, 0.0
        for v, w in pairs:
            acc += w
            if acc >= half:
                return v
        return pairs[-1][0]

    def reading(sel):
        w = [d["width_m"] for d in sel]
        tot = sum(w)
        col = lambda key: srgb([sum(d[key][i] * wi for d, wi in zip(sel, w)) / tot for i in range(3)])
        return {"pitch_m": round(wmedian([(d["pitch_m"], d["width_m"]) for d in sel]), 3),
                "pier_width_m": round(wmedian([(d["pier_width_m"], d["width_m"]) for d in sel]), 3),
                "colors": {"trim": col("pier_linear"), "wall": col("infill_linear"), "glass": col("glass_linear")},
                "facades": [d["id"] for d in sel]}

    out = []
    for t in plan["tiers"]:
        base = t.get("base_y", 0.0)
        top = base + sum(t.get("floor_heights") or [t.get("floor_height", 3.5) * t.get("floors", 1)])
        sel = [d for d in good if d["y0"] < top and d["y1"] > base]
        entry = {"name": t["name"], "base_m": round(base, 2), "top_m": round(top, 2)}
        if sel:
            entry.update(reading(sel), provenance="photo-inferred", note="")
            bay = guides.element_textures(base, top, 8.0, 0.6, 1.2)
            if bay["ok"]:
                entry["bay"] = {"windows": bay["windows_per_bay"], "window_width_m": round(bay["window_width_m"], 3),
                                "window_gap_m": round(bay["window_gap_m"], 3), "light_band": round(bay["light_band"], 3),
                                "spandrel_height_m": round(bay["spandrel_height_m"], 3)}
        out.append(entry)
    for i, e in enumerate(out):
        if "pitch_m" in e:
            continue
        near = sorted((abs(i - k), k) for k, o in enumerate(out) if "facades" in o and o["provenance"] == "photo-inferred")
        if not near:
            e.update(provenance=None, note="no facade photo with a clear lattice")
            continue
        src = out[near[0][1]]
        e.update({k: src[k] for k in ("pitch_m", "pier_width_m", "colors") + (("bay",) if "bay" in src else ())}, facades=[], provenance="generated",
                 note=f"no photo with a clear lattice crosses this tier: repeated from {src['name']}")
    if apply:
        for t, e in zip(plan["tiers"], out):
            if e.get("pitch_m") is None:
                continue
            pitch, pier = e["pitch_m"], e["pier_width_m"]
            t["bay_width"] = pitch
            infill = pitch - pier - 0.3
            bay = e.get("bay") or {}
            applied = []
            if bay.get("windows", 0) >= 2 and bay["window_gap_m"] > 0.1:
                n, gap = bay["windows"], bay["window_gap_m"]
                t["windows_per_bay"], t["window_gap"] = n, round(gap, 3)
                t["window_width"] = round(max(0.4, (infill - (n - 1) * gap) / n), 3)
                applied.append(f"{n} windows a bay, {t['window_width']:.2f} m with {gap:.2f} m of wall between")
            elif bay.get("windows") == 1:
                t["window_width"] = round(max(0.6, min(bay["window_width_m"], infill)), 3)
                applied.append(f"one window a bay, {t['window_width']:.2f} m")
            else:
                t["window_width"] = round(max(0.6, min(t.get("window_width", pitch), infill)), 3)
            details = dict(t.get("details") or {})
            details.update(pilaster_width_m=pier, pilaster_bay_stride=1)
            details.setdefault("pilaster_projection_m", 0.08)
            if bay and bay["light_band"] < 0.8:
                details["belt_projection_m"] = 0.0
                details.pop("sill_profile", None)
                details.pop("string_course_profile", None)
                rules = [r for r in (t.get("facade_rules") or [])]
                rules.append({"floors": (0, 10000), "sill": False})
                t["facade_rules"] = rules
                applied.append(f"no sills, ledges or belts (the brightest band across the bay is {bay['light_band']:.2f} of the stone)")
            t["details"] = details
            e["applied"] = applied
    return {"tiers": out, "source": info.get("source")}


def site_textures(plan: Dict[str, Any], massing: Optional[Dict[str, Any]] = None, px_per_m: float = 64.0,
                  course_m: float = 0.6, head_m: float = 1.2, out_dir: Optional[str] = None) -> Dict[str, Any]:
    """
    Each tier's own textures, made from the real building's straightened facade photos (sb.site_guides) instead of a
    library: within the tier's height, every pier is stacked storey by storey into one pier tile (the pier's width by one
    storey) and every bay's infill into one cell, and each pixel is the median over all those repeats, so the stone,
    spandrels and frames stay and one-off stains, reflections and smears drop out. The spandrel tile is the cell's band
    between windows; glass is the darkest fifth of its window rows. The photos are about 8 cm a pixel, so stone joints
    (courses course_m tall, blocks head_m long, half-bond) and a slight per-block tone are drawn on at px_per_m (generated).

    Returns {"surfaces": {f"{tier}_trim": pier tile (the pilasters are trim), f"{tier}_wall": spandrel tile (the wall
    between windows), f"{tier}_glass": flat colour}, "tiers": [{"name", "pier_width_m", "storey_m", "pitch_m",
    "spandrel_height_m", "samples", "facades", "provenance", "note"}], "source"}; pass surfaces into
    write_textured_building's surfaces (add the roof's yourself). Use with sb.site_lattice(plan) so the build's piers and
    bays have the photos' sizes. A tier no clear photo crosses takes the nearest tier's textures (labelled generated).
    Raises with the reason when the site has no guides.
    """
    import tempfile
    guides, info = site_guides(massing)
    if guides is None:
        raise RuntimeError(f"no facade guides: {info['reason']}")
    out_dir = out_dir or tempfile.mkdtemp(prefix="sb_site_textures_")
    os.makedirs(out_dir, exist_ok=True)

    def srgb(c):
        return [round(1.055 * max(0.0, x) ** (1 / 2.4) - 0.055 if x > 0.0031308 else 12.92 * x, 4) for x in c]
    made, tiers = {}, []
    for t in plan["tiers"]:
        base = t.get("base_y", 0.0)
        top = base + sum(t.get("floor_heights") or [t.get("floor_height", 3.5) * t.get("floors", 1)])
        d = guides.element_textures(base, top, px_per_m, course_m, head_m)
        entry = {"name": t["name"], "base_m": round(base, 2), "top_m": round(top, 2), "facades": list(d["facades"])}
        if d["ok"]:
            files = {}
            for k in ("pier", "pier_normal", "spandrel", "spandrel_normal", "cell"):
                path = os.path.join(out_dir, f"{t['name']}_{k}.png")
                with open(path, "wb") as fh:
                    fh.write(d[f"{k}_png"])
                files[k] = path
            src = f"{info.get('source')}: median over {d['pier_samples']} pier and {d['cell_samples']} bay repeats"
            made[t["name"]] = {
                "trim": {"albedo": files["pier"], "normal": files["pier_normal"], "tile_m": (d["pier_width_m"], d["storey_m"]),
                         "roughness": 0.8, "provenance": "photo-inferred", "confidence": 0.7,
                         "source": src + "; stone joints and block tones generated"},
                "wall": {"albedo": files["spandrel"], "normal": files["spandrel_normal"],
                         "tile_m": (d["infill_width_m"], d["spandrel_height_m"]), "roughness": 0.7, "provenance": "photo-inferred",
                         "confidence": 0.6, "source": src + "; panel joints generated"},
                "glass": {"color": srgb(d["glass_linear"]), "roughness": 0.1, "provenance": "photo-inferred", "source": src}}
            entry.update(pier_width_m=round(d["pier_width_m"], 3), storey_m=round(d["storey_m"], 3), pitch_m=round(d["pitch_m"], 3),
                         spandrel_height_m=round(d["spandrel_height_m"], 3), samples={"piers": d["pier_samples"], "bays": d["cell_samples"]},
                         files=files, provenance="photo-inferred", note="")
        else:
            entry.update(provenance=None, note=d["reason"])
        tiers.append(entry)
    surfaces, photo = {}, set(made)
    for i, e in enumerate(tiers):
        if e["name"] not in made:
            near = sorted((abs(i - k), o["name"]) for k, o in enumerate(tiers) if o["name"] in photo)
            if not near:
                continue
            src_name = near[0][1]
            made[e["name"]] = {k: dict(v, provenance="generated", source=f"repeated from {src_name}: {e['note']}")
                               for k, v in made[src_name].items()}
            e.update(provenance="generated", note=f"{e['note']}: repeated from {src_name}")
        for slot, spec in made[e["name"]].items():
            surfaces[f"{e['name']}_{slot}"] = spec
    if not surfaces:
        raise RuntimeError("no tier has a facade photo with a clear lattice: " + "; ".join(e["note"] for e in tiers))
    return {"surfaces": surfaces, "tiers": tiers, "source": info.get("source"), "dir": out_dir}


def site_score(*built, massing: Optional[Dict[str, Any]] = None, plan: Optional[Dict[str, Any]] = None, min_coverage: float = 0.9,
               min_precision: float = 0.85, relief: float = 2.5, band_m: float = 10.0) -> Dict[str, Any]:
    """
    How well what the script built explains the real building: every mesh given (building parts, stacked tiers, crown
    or other add-on meshes, in sb.site_tiers' frame) is measured against the site's 3D-tiles scan with sb.massing's
    height-balanced coverage (share of the scan the build lies on, within `relief` metres: a cornice or a recessed window
    is detail, not missed shape) and precision (share of the build's visible surface the scan supports). It explains the
    scan when banded coverage >= min_coverage and banded precision >= min_precision (sb.massing.choose's thresholds).
    Both sides are compared by their outer shells (_outer_shell_interior): the build's floor slabs and the roofs hidden
    under the tier above, and the scan's inner surfaces (tile seams, nested detail levels, the walls of overlapping
    parts), are set aside and counted, since nothing outside can see them.
    Returns {"coverage", "precision", "f", "banded_coverage", "banded_precision", "banded_f", "worst_band_coverage",
    "explains", "thresholds", "scan", "build_interior_samples_set_aside", "scan_interior_samples_set_aside",
    "scan_shell_samples", "gaps"}. "gaps" says where the build and the scan disagree, band_m by band_m in height and by
    compass side (see _gap_report; with `plan`, split into inside and outside the tier's walls), worst places first.
    """
    m = massing if massing is not None else site()
    scan = m.get("scan")
    if scan is None:
        raise RuntimeError("no 3D-tiles scan of the site to score against: " + "; ".join(n for n in m.get("notes", []) if "scan" in n))
    meshes = []

    def gather(b):
        if isinstance(b, _native.geometry.Mesh):
            meshes.append(b)
        elif isinstance(b, dict) and "mesh" in b:
            meshes.append(b["mesh"])
        else:  # building parts, a list of tiers or add-ons
            for x in b:
                gather(x)
    for b in built:
        gather(b)
    if not meshes:
        raise ValueError("site_score needs at least one mesh (building parts, tiers, add-ons)")
    whole = _native.geometry.Mesh("site-build")
    for mesh in meshes:
        whole.append(mesh)
    sc = massing_module.Scan.load(scan["glb_path"], plan=scan.get("plan") or None, ground_y=scan.get("ground_y", 0.0))
    samples = massing_module._sm.sample_surface(whole, sc.spacing)
    shell, interior_scan = _scan_shell(sc, scan)
    inside = set(_outer_shell_interior(samples))
    samples = [p for i, p in enumerate(samples) if i not in inside]
    a = massing_module._sm.agreement(shell, samples, 1.0, 2.0, sc.ground_y, sc.neighbours, sc.plan if sc.neighbours is not None else [],
                                     coverage_tau=max(1.0, relief))
    out = {k: round(float(getattr(a, k)), 4) for k in ("coverage", "precision", "f", "banded_coverage", "banded_precision", "banded_f", "worst_band_coverage")}
    out["explains"] = out["banded_coverage"] >= min_coverage and out["banded_precision"] >= min_precision
    out["thresholds"] = {"banded_coverage": min_coverage, "banded_precision": min_precision, "relief_m": relief}
    out["scan"] = scan.get("source", "")
    out["build_interior_samples_set_aside"] = len(inside)
    out["scan_interior_samples_set_aside"] = interior_scan
    out["scan_shell_samples"] = len(shell)
    out["gaps"] = _gap_report(shell, samples, plan, relief, band_m)
    return out


def _scan_shell(sc, scan: Dict[str, Any], cell: float = 1.0):
    """The scan's outer shell (_outer_shell_interior), cached beside the scan GLB. Returns (shell samples, interior
    sample count)."""
    import hashlib
    path = scan["glb_path"]
    cache = path + f".shell_{cell:g}.json"
    key = hashlib.sha1(f"v4:{os.path.getsize(path)}:{os.path.getmtime(path)}:{len(sc.samples)}".encode()).hexdigest()
    interior = None
    try:
        with open(cache, "r", encoding="utf-8") as fh:
            c = _json.load(fh)
        if c.get("key") == key:
            interior = c["interior"]
    except Exception:
        pass
    if interior is None:
        interior = _outer_shell_interior(sc.samples, cell)
        try:
            with open(cache, "w", encoding="utf-8") as fh:
                _json.dump({"key": key, "interior": interior}, fh)
        except Exception:
            pass
    inside = set(interior)
    return [p for i, p in enumerate(sc.samples) if i not in inside], len(inside)


def _outer_shell_interior(S, cell: float = 1.0) -> List[int]:
    """Which surface samples lie inside a solid, out of sight from the street and the sky: a scan's inner surfaces
    (tile seams, nested detail levels, the walls of overlapping parts) or a build's floor slabs and the roofs under the
    tier above. Per `cell`-high slice, empty cells are outside when a flood from the slice's border or from open sky (a
    column with no sample above that height, within a cell) reaches them. The slice's walls are the samples within 1.5
    cells above and below, thickened by a cell, so a wall's gaps (common in any one thin slice) do not let the flood
    leak inside. A sample is on the shell when outside air lies within two cells of it, or when it is the highest
    surface in its column (a roof or terrace); courts open to the sky stay on the shell. Returns the indices of the
    samples that are not."""
    if not S:
        return []
    ix = [int(_py_math.floor(p.x / cell)) for p in S]
    iy = [int(_py_math.floor(p.y / cell)) for p in S]
    iz = [int(_py_math.floor(p.z / cell)) for p in S]
    i0, i1, k0, k1 = min(ix) - 2, max(ix) + 2, min(iz) - 2, max(iz) + 2
    top = {}
    occ = {}
    for n in range(len(S)):
        occ.setdefault(iy[n], set()).add((ix[n], iz[n]))
        # a roof's samples do not land in every cell: a column's top is the highest scan within a cell of it, so a
        # roofed cell the sampling skipped is not mistaken for open sky (courts 3 cells wide or more stay open)
        for di in (-1, 0, 1):
            for dk in (-1, 0, 1):
                c = (ix[n] + di, iz[n] + dk)
                top[c] = max(top.get(c, -10 ** 9), iy[n])
    outside_by_y = {}
    for y in occ:
        cells_ = set()
        for yy in (y - 1, y, y + 1):
            for (i, k) in occ.get(yy, ()):
                cells_.update(((i, k), (i + 1, k), (i - 1, k), (i, k + 1), (i, k - 1)))
        seen = set()
        stack = [(i, k0) for i in range(i0, i1 + 1)] + [(i, k1) for i in range(i0, i1 + 1)] + [(i0, k) for k in range(k0, k1 + 1)] + [(i1, k) for k in range(k0, k1 + 1)]
        # open sky: an empty cell with no scan above this height in its column
        stack += [(i, k) for (i, k), t in top.items() if t < y - 1 and (i, k) not in cells_]
        while stack:
            c = stack.pop()
            if c in seen or c in cells_ or not (i0 <= c[0] <= i1 and k0 <= c[1] <= k1):
                continue
            seen.add(c)
            i, k = c
            stack.extend(((i + 1, k), (i - 1, k), (i, k + 1), (i, k - 1)))
        outside_by_y[y] = seen
    interior = []
    for n in range(len(S)):
        if iy[n] >= top[(ix[n], iz[n])] - 1:
            continue  # the highest surface in its column faces the sky: a roof or setback terrace
        out = outside_by_y.get(iy[n], set())
        if not any((ix[n] + di, iz[n] + dk) in out for di in (-2, -1, 0, 1, 2) for dk in (-2, -1, 0, 1, 2)):
            interior.append(n)
    return interior


def _gap_report(scan_samples, built_samples, plan: Optional[Dict[str, Any]], reach: float, band_m: float) -> Dict[str, Any]:
    """Where a build and its scan disagree, height band by height band and side by side: the share of scan surface no
    built surface comes within `reach` of (missed), split into what lies inside the build's walls at that height (a
    recess, notch or court the build filled) and outside them (a wing or projection it left out), and the share of
    built surface no scan comes within `reach` of (extra). A coarse grid test (cells of reach / 2), for finding gaps, not
    for scoring them. Sides are compass octants of the outward direction from the scan's centre."""
    cell = reach / 2.0
    def cells(pts):
        return {(int(_py_math.floor(p.x / cell)), int(_py_math.floor(p.y / cell)), int(_py_math.floor(p.z / cell))) for p in pts}
    def dilate(cs):
        out = set()
        for (i, j, k) in cs:
            for di in (-2, -1, 0, 1, 2):
                for dj in (-2, -1, 0, 1, 2):
                    for dk in (-2, -1, 0, 1, 2):
                        out.add((i + di, j + dj, k + dk))
        return out
    near_built = dilate(cells(built_samples))
    near_scan = dilate(cells(scan_samples))
    key = lambda p: (int(_py_math.floor(p.x / cell)), int(_py_math.floor(p.y / cell)), int(_py_math.floor(p.z / cell)))
    cx = sum(p.x for p in scan_samples) / len(scan_samples)
    cz = sum(p.z for p in scan_samples) / len(scan_samples)
    sides = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")
    side = lambda p: sides[int(((_py_math.degrees(_py_math.atan2(p.x - cx, -(p.z - cz))) % 360.0) + 22.5) // 45.0) % 8]
    tiers = []
    if plan:
        for t in plan["tiers"]:
            y0 = t.get("base_y", 0.0)
            tiers.append((y0, y0 + t.get("plinth_height", 0.0) + sum(t["floor_heights"]), list(t["footprint"])))
    def inside(p):
        for y0, y1, ring in tiers:
            if y0 <= p.y <= y1:
                c, j = False, len(ring) - 1
                for i in range(len(ring)):
                    (xi, zi), (xj, zj) = ring[i], ring[j]
                    if (zi > p.z) != (zj > p.z) and p.x < (xj - xi) * (p.z - zi) / (zj - zi) + xi:
                        c = not c
                    j = i
                return c
        return None
    rows = {}
    for p in scan_samples:
        b = int(p.y // band_m)
        r = rows.setdefault(b, {"scan": 0, "missed": 0, "inside": 0, "outside": 0, "built": 0, "extra": 0, "sides": {}})
        r["scan"] += 1
        if key(p) not in near_built:
            r["missed"] += 1
            sd = side(p)
            r["sides"][sd] = r["sides"].get(sd, 0) + 1
            w = inside(p)
            if w is True:
                r["inside"] += 1
            elif w is False:
                r["outside"] += 1
    for p in built_samples:
        b = int(p.y // band_m)
        r = rows.setdefault(b, {"scan": 0, "missed": 0, "inside": 0, "outside": 0, "built": 0, "extra": 0, "sides": {}})
        r["built"] += 1
        if key(p) not in near_scan:
            r["extra"] += 1
    table, worst = [], []
    for b in sorted(rows):
        r = rows[b]
        row = {"from_m": b * band_m, "to_m": (b + 1) * band_m, "scan_samples": r["scan"],
               "missed_share": round(r["missed"] / r["scan"], 3) if r["scan"] else None,
               "missed_inside_walls": r["inside"], "missed_outside_walls": r["outside"],
               "extra_share": round(r["extra"] / r["built"], 3) if r["built"] else None,
               "missed_by_side": dict(sorted(r["sides"].items(), key=lambda kv: -kv[1]))}
        table.append(row)
        for sd, n in r["sides"].items():
            worst.append({"from_m": b * band_m, "to_m": (b + 1) * band_m, "side": sd, "missed_samples": n})
    worst.sort(key=lambda w: -w["missed_samples"])
    return {"band_m": band_m, "reach_m": reach, "bands": table, "worst": worst[:8],
            "note": "missed inside walls = the build fills a recess, notch or court the scan shows open; outside = a wing or projection the build lacks"}


def site_crown(massing: Optional[Dict[str, Any]] = None, slot: str = "wall", min_confidence: float = 0.0) -> Dict[str, Any]:
    """
    The crown of the site's building (whatever stands above its last full tier: spire, mast, lantern, drums, fins), fitted
    from the 3D tiles when execute_3d_python_script ran with siteFacade's sibling siteCrown=True. Each fitted piece is
    built as a closed mesh with flat faces (hard edges stay hard), in the same frame as sb.site_tiers (x east, z south,
    y above the street), ready for write_textured_building(extras=...).

    Returns {"extras": [{"mesh", "slot", "provenance", "confidence", "source"}...], "pieces": [{"id", "operator",
    "label", "provenance", "measured", "generated"}...], "silhouette": the fit's outline disagreement with the tiles
    (0 = identical), "matched", "from_m", "to_m", "notes"}. Raises when the site has no fitted crown.
    """
    m = massing if massing is not None else site()
    crown = m.get("crown")
    if not crown:
        raise RuntimeError("no crown was fitted for this site: pass siteCrown=True with site to execute_3d_python_script"
                           + (f" ({'; '.join(n for n in m.get('notes', []) if 'crown' in n)})" if m.get("notes") else ""))
    extras, pieces = [], []
    for p in crown["pieces"]:
        if p["confidence"] < min_confidence:
            continue
        mesh = _native.geometry.Mesh(f"crown-{p['id'].replace('/', '-')}")
        P, I = p["positions"], p["indices"]
        for t in range(0, len(I) - 2, 3):
            a, b, c = (_native.math.Vec3(P[3 * k], P[3 * k + 1], P[3 * k + 2]) for k in (I[t], I[t + 1], I[t + 2]))
            n = (b - a).cross(c - a)
            if n.length() < 1e-12:
                continue
            n = n.normalized()
            base = len(mesh.vertices)
            for v in (a, b, c):
                mesh.add_vertex(v, n, _native.math.Vec2(0.0, 0.0), _native.math.Vec4(1.0, 1.0, 1.0, 1.0))
            mesh.add_triangle(base, base + 1, base + 2)
        if not len(mesh.vertices):
            continue
        source = (f"crown {p['operator']} fitted to the 3D tiles (shape program; measured: {', '.join(p['measured']) or 'none'};"
                  f" generated: {', '.join(p['generated']) or 'none'})")
        extras.append({"mesh": mesh, "slot": slot, "provenance": p["provenance"], "confidence": p["confidence"], "source": source})
        pieces.append({k: p[k] for k in ("id", "operator", "label", "provenance", "measured", "generated")})
    return {"extras": extras, "pieces": pieces, "silhouette": crown["silhouette"], "matched": crown["matched"],
            "from_m": crown["from_m"], "to_m": crown["to_m"], "notes": crown.get("notes", [])}


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


def _lab_chroma(srgb_color) -> float:
    """CIELAB (D65) chroma of an sRGB 0..1 colour."""
    r, g, b = ((x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in (float(c) for c in srgb_color[:3]))
    X, Y, Z = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, 0.2126 * r + 0.7152 * g + 0.0722 * b, (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
    f = [t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116 for t in (X, Y, Z)]
    return _py_math.hypot(500 * (f[0] - f[1]), 200 * (f[1] - f[2]))


def _hue_spread(spread_lab) -> Optional[float]:
    """The a/b part of a CIELAB spread: how much a map's hue varies (0 for a greyscale map)."""
    return _py_math.hypot(float(spread_lab[1]), float(spread_lab[2])) if spread_lab else None


def _lab_of_set(st) -> Optional[tuple]:
    """A fetched library set's measured CIELAB mean and spread from its index entry, when it has been measured."""
    colour = (st.get("index") or {}).get("colour")
    return (colour["meanLab"], colour["spreadLab"]) if colour else None


def library_surface(candidates, tile_m=None, target_color=None, target_roughness: Optional[float] = None, max_size: int = 1024,
                    confidence: float = 0.5, target_spread=None) -> Dict[str, Any]:
    """
    A write_textured_building surface from the texture library (photographed and scanned ambientCG and Poly Haven PBR
    sets), chosen by appearance and tinted to a measured colour. The sets must be fetched before the script runs: find
    them with texture_library_search and name them in execute_3d_python_script's librarySets. A name the library does
    not have is reported with the closest names it does.

    candidates: one set name or several; with target_color (sRGB 0..1, e.g. plan["colors"]["wall"]) and/or
    target_roughness (0 polished .. 1 matte) the set nearest in mean colour and roughness wins, and its maps are remapped
    to the targets (the colour in linear light), so the surface keeps the set's grain, veining and relief at the measured
    colour and finish. Library sets range from polished slabs to rough rock, so give target_roughness whenever the finish
    matters (a weathered stone facade is about 0.8). Without targets the first candidate is used as it is.
    tile_m: the real size (width, height) in metres one tile of the set covers. Leave it out to use the chosen set's
    real size from the library index (its publisher's measurement; "tile_m_source" says where it came from). Required,
    as the script's estimate, when the chosen set's size is unknown; a tile_m given is always reported as estimated.
    Maps are shrunk to at most max_size pixels a side and packed (albedo, OpenGL normal, ORM), cached beside the set.
    1024 is a millimetre or two per pixel on a building's metre-scale tiles; a whole building's surfaces at 2048 can
    outgrow what the viewport loads.

    The colour map is baked once per set to a neutral mean and the target colour is returned as the surface's "tint"
    (the base colour factor), so tiers tinted to different measured colours (sb.site_colors) share one image. The bake
    moves the map's CIELAB distribution, not one multiplier per channel: its mean goes to a neutral grey and its colour
    variation is kept, or scaled to target_spread (a measured CIELAB standard deviation [L, a, b] of the surface, e.g.
    from photo texels) when given; a negative component keeps the set's own spread in that channel. A greyscale set has no hue variation to keep, so on a coloured target it would give
    one flat hue: among candidates such a set ranks lower, and "lab_bake" says when it was used anyway.

    Returns the surfaces entry ({"albedo", "normal", "orm", "tint", "tile_m", "source", "provenance": "generated",
    "confidence"}) plus "library": {"chosen", "candidates": [{"name", "mean_srgb", "mean_roughness", "distance"}],
    "lab_bake", "color_factor", "target_srgb", "target_spread", "target_roughness", "roughness_remap", "missing", "tile_m_estimated", "tile_m_source",
    "indexed_tile_m"}. Raises with the closest set names when no candidate was fetched, and when tile_m is left out but
    the chosen set has no known real size.
    """
    import hashlib
    names = [candidates] if isinstance(candidates, str) else list(candidates)
    manifest_path = os.environ.get("SCRATCHBOX_LIBRARY_JSON")
    if not manifest_path:
        raise RuntimeError("no texture library sets were fetched for this script: name them in execute_3d_python_script's librarySets")
    with open(manifest_path, "r", encoding="utf-8") as fh:
        manifest = _json.load(fh)
    fetched = {st["name"].lower(): st for st in manifest.get("sets", [])}
    missing = [m for m in manifest.get("missing", []) if m["name"].lower() in {n.lower() for n in names}]
    sets = [fetched[n.lower()] for n in names if n.lower() in fetched]
    if not sets:
        hints = "; ".join(f"{m['name']}: {m['reason']}" + (f" (closest: {', '.join(m['nearest'])})" if m["nearest"] else "") for m in missing)
        raise ValueError(f"none of {names} was fetched from the texture library" + (f": {hints}" if hints else "; add them to librarySets"))

    def lin(c):
        return tuple((x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)

    def srgb(c):
        return tuple(round(1.055 * max(0.0, x) ** (1 / 2.4) - 0.055 if x > 0.0031308 else 12.92 * x, 4) for x in c)

    def prepared(st):
        out_dir = os.path.join(st["dir"], f"prepared_{max_size}")
        stats_path = os.path.join(out_dir, "stats.json")
        try:
            with open(stats_path, "r", encoding="utf-8") as fh:
                return out_dir, _json.load(fh)
        except Exception:
            pass
        m = st["maps"]
        r = _native.surface.prepare_material_maps(m["color"], m.get("normal", ""), m.get("roughness", ""), m.get("ao", ""),
                                                  m.get("metalness", ""), m.get("arm", ""), max_size)
        os.makedirs(out_dir, exist_ok=True)
        for key in ("albedo", "normal", "orm"):
            with open(os.path.join(out_dir, f"{key}.png"), "wb") as fh:
                fh.write(r[f"{key}_png"])
        stats = {"mean_albedo_linear": list(r["mean_albedo_linear"]), "mean_roughness": r["mean_roughness"],
                 "source_size": list(r["source_size"]), "size": list(r["size"]), "maps": sorted(k for k in m if m[k])}
        with open(stats_path, "w", encoding="utf-8") as fh:
            _json.dump(stats, fh)
        return out_dir, stats

    target = tuple(float(x) for x in target_color[:3]) if target_color is not None else None
    ranked = []
    for st in sets:
        out_dir, stats = prepared(st)
        mean_srgb = srgb(stats["mean_albedo_linear"])
        d2 = sum((a - b) ** 2 for a, b in zip(mean_srgb, target)) if target else 0.0
        # a set without hue variation of its own cannot carry a coloured target's: it pays the target's chroma (ΔE / 100,
        # this distance's scale), fading out as its own measured hue spread reaches 1 ΔE
        src = _lab_of_set(st)
        if target and src:
            d2 += (_lab_chroma(target) / 100.0 * max(0.0, 1.0 - _hue_spread(src[1]))) ** 2
        if target_roughness is not None:
            d2 += (stats["mean_roughness"] - float(target_roughness)) ** 2
        ranked.append((d2 ** 0.5, st, out_dir, stats, mean_srgb))
    if target or target_roughness is not None:
        ranked.sort(key=lambda r: r[0])
    dist, st, out_dir, stats, mean_srgb = ranked[0]

    def remapped(name, scale, offset, srgb_space):
        # a remapped copy of a prepared map, cached by its remap
        key = hashlib.sha1(repr((scale, offset)).encode()).hexdigest()[:10]
        out = os.path.join(out_dir, f"{name}_{key}.png")
        if not os.path.exists(out):
            with open(os.path.join(out_dir, f"{name}.png"), "rb") as fh:
                data = _native.surface.remap_png_channels(fh.read(), scale, offset, srgb_space)
            with open(out, "wb") as fh:
                fh.write(data)
        return out

    albedo, orm = os.path.join(out_dir, "albedo.png"), os.path.join(out_dir, "orm.png")
    factor, rough_remap, lab_bake = (1.0, 1.0, 1.0), None, None
    if target:
        # The map is baked once to a neutral mean (its grain, veining and colour variation kept, or scaled to a measured
        # spread) and the measured colour rides on the material's base colour factor, which glTF caps at 1: every tier
        # tinted from one set then shares one image.
        target_lin = lin(target)
        # the bake's lightness: high enough that the factor (at most 1) only darkens it to the target, low enough that its
        # lighter pixels (mean + 2.5 spreads) do not clip to white
        lab_l = lambda y: 116.0 * max(y, 0.008856) ** (1 / 3) - 16.0
        l_floor, l_ceil = lab_l(max(target_lin)), lab_l(0.8)
        want_spread = tuple(float(x) for x in target_spread[:3]) if target_spread is not None else (-1.0, -1.0, -1.0)

        def baked(floor):
            # one bake per set and spread, shared by every target it is bright enough for; a brighter target gets its own
            key = hashlib.sha1(repr(("lab", want_spread) + ((round(floor, 1),) if floor else ())).encode()).hexdigest()[:10]
            path = os.path.join(out_dir, f"albedo_lab_{key}.png")
            try:
                with open(path[:-4] + ".json", "r", encoding="utf-8") as fh:
                    meta = _json.load(fh)
                if os.path.exists(path):
                    return path, meta
            except Exception:
                pass
            with open(os.path.join(out_dir, "albedo.png"), "rb") as fh:
                src_png = fh.read()
            t = _native.surface.transfer_lab_png(src_png, (l_ceil, 0.0, 0.0), want_spread)
            spread_l = want_spread[0] if want_spread[0] >= 0 else t["from_spread_lab"][0]
            bake_l = max(floor or 0.0, min(l_ceil, 100.0 - 2.5 * spread_l))
            if abs(bake_l - l_ceil) > 0.5:
                t = _native.surface.transfer_lab_png(src_png, (bake_l, 0.0, 0.0), want_spread)
            with open(path, "wb") as fh:
                fh.write(t["png"])
            meta = {"from_mean_lab": [round(v, 2) for v in t["from_mean_lab"]], "from_spread_lab": [round(v, 2) for v in t["from_spread_lab"]],
                    "to_mean_lab": [round(v, 2) for v in t["mean_lab"]], "to_spread_lab": [round(v, 2) for v in t["spread_lab"]],
                    "mean_linear": [round(v, 4) for v in t["mean_linear"]],
                    "spread": "scaled to target_spread" if target_spread is not None else "the set's own"}
            with open(path[:-4] + ".json", "w", encoding="utf-8") as fh:
                _json.dump(meta, fh)
            return path, meta

        albedo, lab_bake = baked(None)
        if max(lab_bake["mean_linear"]) < max(target_lin):
            albedo, lab_bake = baked(l_floor)
        # the factor carries the target against the bake's measured mean, so the surface averages to the target colour
        factor = tuple(round(min(1.0, tl / max(m, 1e-4)), 4) for tl, m in zip(target_lin, lab_bake["mean_linear"]))
        hue_spread = _hue_spread(lab_bake.get("from_spread_lab"))
        if hue_spread is not None and hue_spread < 1.0 and _lab_chroma(target) >= 3.0:
            lab_bake = {**lab_bake, "greyscale_set": "no hue variation of its own: the coloured target is one flat hue on it"}
    if target_roughness is not None:
        mean_r, want = stats["mean_roughness"], min(1.0, max(0.0, float(target_roughness)))
        # scale a set's roughness to the target where it has some, shift it where it is near 0 (a polished set)
        scale_g, offset_g = (want / mean_r, 0.0) if mean_r >= 0.1 else (1.0, want - mean_r)
        rough_remap = {"scale": round(scale_g, 4), "offset": round(offset_g, 4), "from_mean": round(mean_r, 4), "to_mean": want}
        orm = remapped("orm", (1.0, scale_g, 1.0), (0.0, offset_g, 0.0), False)
    indexed = (st.get("index") or {}).get("realSizeM")
    if tile_m is None:
        if not indexed:
            notes = "; ".join((st.get("index") or {}).get("notes") or []) or "the library index has no entry for it"
            raise ValueError(f"texture library set {st['name']} has no known real size ({notes}): pass tile_m=(w, h) as your estimate")
        tile, tile_estimated = (float(indexed[0]), float(indexed[1])), False
        tile_source = st["index"].get("sizeSource", "library index")
    else:
        tile = (float(tile_m[0]), float(tile_m[1])) if isinstance(tile_m, (list, tuple)) else (float(tile_m), float(tile_m))
        tile_estimated, tile_source = True, "estimated by the script"
    source = (f"texture library set {st['name']} (gs://{manifest.get('bucket', '')})"
              + (f", tinted to the measured colour {list(target)}" if target else "")
              + (f", roughness set to {rough_remap['to_mean']:g}" if rough_remap else "")
              + f"; tile {tile[0]:g} x {tile[1]:g} m " + ("estimated" if tile_estimated else f"from {tile_source}"))
    return {"albedo": albedo, "normal": os.path.join(out_dir, "normal.png"), "orm": orm, "tint": factor,
            "tile_m": tile, "source": source, "provenance": "generated", "confidence": confidence,
            "library": {"chosen": st["name"], "target_srgb": list(target) if target else None, "lab_bake": lab_bake, "target_spread": list(target_spread) if target_spread is not None else None,
                        "color_factor": list(factor),
                        "target_roughness": target_roughness, "roughness_remap": rough_remap,
                        "candidates": [{"name": r[1]["name"], "mean_srgb": list(r[4]), "mean_roughness": round(r[3]["mean_roughness"], 3),
                                        "distance": round(r[0], 4)} for r in ranked],
                        "missing": missing, "tile_m_estimated": tile_estimated, "tile_m_source": tile_source,
                        "indexed_tile_m": list(indexed) if indexed else None,
                        "size": stats["size"], "source_size": stats["source_size"]}}


_PHOTO_STAIN_CACHE: Dict[Any, Any] = {}


def _photo_stain_field(path: str, ground_y: float, plan, bay_m: float, storey_m: float):
    """The site's measured staining field (sb._native.weathering.build_photo_stain), kept for the process: a script that
    writes several builds of one site reads the photos once."""
    key = (path, os.path.getmtime(path), round(ground_y, 3), round(bay_m, 3), round(storey_m, 3))
    if key not in _PHOTO_STAIN_CACHE:
        rings = [[(float(x), float(z)) for x, z in ring] for ring in plan]
        _PHOTO_STAIN_CACHE[key] = _native.weathering.build_photo_stain(path, ground_y, rings, bay_m, storey_m)
    return _PHOTO_STAIN_CACHE[key]


def write_textured_building(path: str, parts, surfaces: Optional[Dict[str, Any]] = None,
                            weathering: Union[Dict[str, Any], bool, None] = None,
                            decals: Optional[List[Dict[str, Any]]] = None,
                            extras: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """
    Write building parts to a GLB with real-scale PBR textures per part.

    surfaces maps a part slot ("wall", "roof", "foundation", "trim", "frame", "glass"), or one part's full
    name (a tier's "<name>T4_wall", which wins over its slot: per-tier colours from sb.site_colors), to either
      {"coursed": {<CoursedSurfaceParams fields>}}            procedural, synthesized natively
      {"albedo": file, "normal": file?, "orm": file?,          image maps from a material library or
       "tile_m": (w, h), "tint": (r, g, b)?, "source": str}   an image model, laid at tile_m metres
      {"color": (r, g, b), "source": str?}                       a flat colour (sRGB), no maps
    Optional per-part "roughness" / "metallic" set the material factors. Parts without an
    entry keep their flat slot material.

    weathering (on by default when the script has a site, i.e. the build stands for a real place; a
    dict sets it, False turns it off) bakes marks from the built geometry (run-off streaks under ledges,
    rain exposure wash, shelter and cavity grime, rising damp, soot around the chimney tops) into
    a unique atlas over the "receivers" parts (default wall, foundation, roof). With "mode":
    "layer" (the default) the receivers carry it on a second UV set and the viewer blends it over
    their own materials (SB_material_weathering), adding no geometry, so even a skyscraper fits;
    "overlay" adds an alpha-blended shell over them instead, which any glTF viewer shows (for export)
    but which doubles their triangles. When the script has a site with photo tiles the weathering is
    measured ("measured", default on): the photos' staining wider than a bay (run-off columns, grime
    under setbacks, damp) is read per height band and facing and painted where the photos cover the
    surface (photo-inferred); the procedural layers fill the rest, scaled per band to the measured mean
    (generated). "photo_bay_m" / "photo_storey_m" set the filter that averages away the window and floor
    rhythm. Its other keys are WeatheringParams fields plus "receivers";
    strengths are continuous and 0 turns a layer off.

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
    surface it takes: "wall", "foundation", "trim", "roof", "frame", "glass", or a new slot name given its own
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
    # a key is a slot (every part of it) or one part's full name (one tier's wall, say), which wins over its slot
    unknown = sorted(set(surfaces) - set(slots) - {p.name for p in parts})
    if unknown:
        raise ValueError(f"Unknown surface slot(s) or part(s) {unknown} (slots {sorted(set(slots))}, or a part name such as {parts[0].name!r})")
    synthesized = {}   # one texture synthesis per surfaces key, reused by every tier and add-on that takes it
    shared_targets = set()
    for part in parts:
        slot = part.name.rsplit("_", 1)[-1]
        key = part.name if part.name in surfaces else slot
        spec = surfaces.get(key)
        extra = extra_info.get(part.name)
        if not spec:
            if extra:
                part.material = _with_provenance(part.material, extra["provenance"], extra["confidence"], extra["source"])
            else:
                part.material = _with_provenance(part.material, "generated", 1.0, "procedural building")
                report[slot] = {"source": "flat material", "provenance": "generated", "confidence": 1.0}
            continue
        mat = part.material
        if "coursed" in spec and key in synthesized:
            tile, maps = synthesized[key]
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
            synthesized[key] = (tile, maps)
            mat.base_color = _native.math.Vec4(1.0, 1.0, 1.0, mat.base_color.w)
            mat.roughness = 1.0
            mat.metallic = 1.0
            source = "procedural coursed surface"
        elif "color" in spec and "albedo" not in spec:
            # a flat measured colour (sRGB), no maps: glass read from photos, say
            c = [float(x) for x in spec["color"][:3]]
            c = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
            mat.base_color = _native.math.Vec4(c[0], c[1], c[2], mat.base_color.w)
            tile, maps = (1.0, 1.0), {}
            source = spec.get("source", "flat colour")
        else:
            if "albedo" not in spec or "tile_m" not in spec:
                raise ValueError(f"Surface '{key}' needs 'coursed' parameters, an 'albedo' file and 'tile_m', or a flat 'color'")
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
            report[key] = {"source": source, "tile_m": tile, "provenance": provenance, "confidence": confidence}
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

    # A build that stands for a real place (the script has a site) is weathered by default: real buildings are.
    # weathering=False turns it off; a dict sets it.
    auto_weathering = weathering is None and bool(os.environ.get("SCRATCHBOX_SITE_JSON"))
    if auto_weathering:
        weathering = {}
        report["weathering_default"] = "on: the build stands for a real place (pass weathering=False to turn it off)"
    if weathering is False:
        weathering = None
    if weathering is None and painted:
        weathering = {k: 0.0 for k in ("streak_strength", "exposure_wash", "shelter_grime", "cavity_grime",
                                       "damp_strength", "soot_strength")}
    if weathering is not None:
        options = dict(weathering)
        # trim (sills, courses, mouldings) is left out by default: its profiles' faces turn through many charts, which
        # splits every corner of the layer's second UV set, and the streaks it causes fall on the walls below anyway
        wanted = set(options.pop("receivers", ["wall", "foundation", "roof"]))
        mode = options.pop("mode", "layer")
        # measured staining: the site's photo tiles read per facing (on by default when the site has them)
        measured = options.pop("measured", None)
        bay_m, storey_m = float(options.pop("photo_bay_m", 2.8)), float(options.pop("photo_storey_m", 3.7))
        photo, photo_source, guides = None, None, None
        if measured is not False and os.environ.get("SCRATCHBOX_SITE_JSON"):
            guides, _ginfo = site_guides()
            if guides is not None:
                photo_source = f"{_ginfo.get('source')}; "
        if measured is not False:
            scan = (site().get("scan") or {}) if os.environ.get("SCRATCHBOX_SITE_JSON") else {}
            if scan.get("photo_glb_path") and scan.get("photo_ground_y") is not None:
                photo = _photo_stain_field(scan["photo_glb_path"], float(scan["photo_ground_y"]), scan.get("plan") or [], bay_m, storey_m)
                photo_source = (photo_source or "") + f"{scan.get('source', 'the site scan')}: photo tiles filtered {bay_m:g} m wide x {storey_m:g} m tall"
            elif measured:
                raise ValueError("measured weathering needs a site with photo tiles: pass site= to the script tool")
        if mode not in ("layer", "overlay"):
            raise ValueError(f"Unknown weathering mode '{mode}' (layer, overlay)")
        params = _native.weathering.WeatheringParams()
        params.layer = mode == "layer"
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
                baked = _native.weathering.bake_weathering(receivers, list(parts), params, f"{base_name}_weathering", painted, photo, guides)
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
        if params.layer:
            # The layer must not cost the build its place in the viewport: when the file would outgrow the viewport's
            # limits a half-size atlas is tried; then default weathering is left out (said why) and asked-for weathering
            # stops with the numbers rather than writing a file the viewport cannot open.
            def glb_bytes(ms):
                verts = 0
                for mm in ms:
                    mm.weld_identical_vertices()
                    verts += len(mm.vertices) * (72 if getattr(mm, "has_uv1", False) else 64) + mm.triangle_count * 12
                # the writer stores byte-identical images once (one set's maps shared by every tier)
                import hashlib
                unique = {hashlib.sha1(t[2]).digest(): len(t[2]) for t in textures}
                return verts + sum(unique.values())
            limit_mb = float(os.environ.get("SCRATCHBOX_MAX_SCENE_MB", 96)) * 0.95
            limit_verts = float(os.environ.get("SCRATCHBOX_MAX_SCENE_VERTICES", 1_000_000)) * 0.95
            for _attempt in range(2):
                layered = {id(r): m for r, m in zip(receivers, baked["layered"])}
                trial = [layered.get(id(m), m) for m in meshes]
                size = glb_bytes(trial) + len(baked["atlas_png"])
                verts = sum(len(mm.vertices) for mm in trial)
                if size <= limit_mb * 1e6 and verts <= limit_verts:
                    break
                if params.max_atlas_width > 2048:
                    params.max_atlas_width = 2048
                    params.texel_m = params.texel_m * 2.0
                    baked = _native.weathering.bake_weathering(receivers, list(parts), params, f"{base_name}_weathering", painted, photo, guides)
                    report["weathering_fit"] = "atlas halved (texel %.2f m) to fit the viewport" % params.texel_m
                    continue
                baked = None
                break
            else:
                baked = None
            if baked is None:
                why = ("with it the file would be %.0f MB / %d vertices, over the viewport's %.0f MB / %d"
                       % (size / 1e6, verts, limit_mb / 0.95, limit_verts / 0.95))
                if not auto_weathering:
                    raise ValueError(f"weathering does not fit: {why}; weather fewer receivers, lighten the build, "
                                     "or pass weathering=False")
                report["weathering_default"] = f"left out: {why} (lighten the build to have it)"
                weathering = None
        if baked is None:
            pass
        elif params.layer:
            # the receivers themselves carry the atlas on their second UV set; the viewer blends it over their materials
            layered = {id(r): m for r, m in zip(receivers, baked["layered"])}
            meshes = [layered.get(id(m), m) for m in meshes]
            # one entry per weathered part (a stacked building's parts share no common name); the image is stored once
            for lm in baked["layered"]:
                textures.append((lm.name, "weathering", baked["atlas_png"], "image/png", 1.0, 1.0))
        else:
            overlay = baked["overlay"]
            if len(overlay.vertices):
                overlay.material = _with_provenance(overlay.material, "generated", 1.0, "geometry-driven weathering bake")
                meshes.append(overlay)
                textures.append((overlay.name, "base_color", baked["atlas_png"], "image/png", 1.0, 1.0))
        if baked is not None:
            if photo is not None or guides is not None:
                report["weathering_measured"] = {
                    "provenance": "photo-inferred where measured; the procedural fill is generated, scaled per band to the measured mean",
                    "source": photo_source, "photo_samples": photo.samples if photo is not None else 0,
                    "measured_texels": baked["photo_texels"], "from_facade_guides": baked["guide_texels"],
                    "filled_texels": baked["filled_texels"],
                    "band_scale": [round(x, 3) for x in baked["band_scale"]]}
            report["weathering"] = {"source": "generated (geometry-driven bake)", "mode": mode, "receivers": sorted(wanted),
                                    "atlas_px": (baked["atlas_width"], baked["atlas_height"]),
                                    "charts": baked["charts"], "baked_texels": baked["baked_texels"],
                                    "texel_m": round(params.texel_m, 4),
                                    "clear_triangles": baked.get("clear_triangles", 0)}
        if baked is not None and fitted is not None:
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

# Trees: every tree is an SB-Veggie tree (vegetation.py), grown natively when the scene that holds it is written.
create_tree = vegetation.create_tree


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
    """Trees are SB-Veggie trees (sb.create_tree, sb.vegetation); ivy is grown on an obstacle box."""
    SbVeggieTree = SbVeggieTree
    create_tree = staticmethod(vegetation.create_tree)
    create_vegetation = staticmethod(create_vegetation)
    create_ivy = staticmethod(create_ivy)

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

    def _write_glb_geometry(out_path, target):
        if isinstance(target, (list, tuple)):
            mesh_list = [getattr(m, "mesh", m) for m in target if m is not None and not vegetation.is_tree(m)]
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

    def _has_triangles(target):
        sub_parts = getattr(target, "_sub_parts", None)
        parts = target if isinstance(target, (list, tuple)) else (sub_parts if sub_parts and len(sub_parts) > 1 else [target])
        return any(len(getattr(getattr(m, "mesh", m), "indices", ())) > 0 for m in parts if m is not None)

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

        # The scene's SB-Veggie trees are grown natively and written into the same GLB (vegetation.py).
        trees = vegetation.trees_of(target)
        geometry = [m for m in target if not vegetation.is_tree(m)] if isinstance(target, (list, tuple)) else (None if vegetation.is_tree(target) else target)
        if not trees:
            return _write_glb_geometry(out_path, target)
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        base = b""
        # the native writer refuses an all-empty GLB; a container that only holds trees has no base geometry to write
        if geometry and _has_triangles(geometry):
            _write_glb_geometry(out_path, geometry)
            with open(out_path, "rb") as f:
                base = f.read()
        merged = vegetation.attach_trees(base, trees)
        with open(out_path, "wb") as f:
            f.write(merged)
        return True

    _orig_export_glb_bytes = getattr(_native.io, "export_glb_bytes", None) if _native and hasattr(_native, "io") else None

    def export_glb(arg1, arg2=None) -> bytes:
        if arg2 is None and not isinstance(arg1, str):
            target = arg1
            trees = vegetation.trees_of(target)
            if trees:
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

# Reading a GLB back into meshes (glb_read.py): a script can start from an existing model and sculpt it.
from .glb_read import read_glb  # noqa: E402
# Massing read from a scan and chosen by how well it explains it (massing.py): sb.massing.Scan, sb.massing.choose.
from . import massing  # noqa: E402
massing_module = massing  # site_tiers / site_score take a `massing` argument, which shadows the module inside them
if _native is not None and hasattr(_native, "io"):
    _native.io.read_glb = read_glb
if io is not None:
    io.read_glb = read_glb

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
    "read_glb",
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
    "SbVeggieTree",
    "vegetation",
    "massing",
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
    "processing",
    "topology",
    "sdf",
    "hair"
]
