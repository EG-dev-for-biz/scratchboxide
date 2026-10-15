"""
Scratchbox Agentic 3D Procedural Engine (Python SDK)
Autonomous, headless, real-time procedural creation competing directly with Blender.
"""

import sys
import os
import math as _py_math
import random as _random
from typing import Any, Tuple, Optional, Union, List

# Ensure native module is discoverable from both package installations and local build dirs
try:
    import scratchbox_native as _native
except ImportError:
    _cur_dir = os.path.dirname(os.path.abspath(__file__))
    _candidate_dirs = [
        os.path.abspath(os.path.join(_cur_dir, "..", "build_py"))
    ]
    for d in _candidate_dirs:
        if os.path.exists(d) and d not in sys.path:
            sys.path.insert(0, d)
    try:
        import scratchbox_native as _native
    except ImportError:
        _native = None

from .world import World
from .terrain import Terrain
from .structure import Structure
from .plant import PlantPreset, Flora, create_vegetation

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
hair = getattr(_native, "hair", None) if _native else None
rig = getattr(_native, "rig", None) if _native else None
random = _random
py_math = _py_math

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

        # Bake material base_color into vertices if set
        if hasattr(target, "material") and target.material:
            mat = target.material
            col = getattr(mat, "base_color", getattr(mat, "baseColorFactor", None))
            if col is not None and hasattr(target, "set_color"):
                target.set_color(col)

        _orig_append(self, target)
        return self

    def _mesh_merge(self, other):
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

    def _mesh_get_tag(self):
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
        def _mesh_align_to_terrain(self, terrain, offset_z=0.2):
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
            for target in [self] + [p for p in (getattr(self, "_sub_parts", None) or []) if p is not self]:
                target.material = mat
                if mat is not None:
                    col = getattr(mat, "base_color", getattr(mat, "baseColorFactor", None))
                    if col is not None and hasattr(target, "set_color"):
                        target.set_color(col)
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

        def _mesh_subtract(self, other):
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

        def _mesh_ground_on(self, target, clearance=0.0):
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

    _orig_create_cylinder = getattr(_geom, "create_cylinder", None)
    def create_cylinder(radius_top=1.0, radius_bottom=1.0, height=2.0, segments=24, color=None, material=None, capped=True, *, radius=None, **kwargs):
        rt = float(radius if radius is not None else radius_top)
        rb = float(radius if radius is not None else radius_bottom)
        c, mat = _resolve_color_and_material(color, material, default_color=math.Vec4(0.8, 0.8, 0.8, 1.0))
        if _orig_create_cylinder:
            mesh = _orig_create_cylinder(rt, rb, float(height), int(segments), c, bool(capped))
            if mat is not None and hasattr(mesh, "apply_material"):
                mesh.apply_material(mat)
            return mesh
        raise RuntimeError("Native create_cylinder not available")
    _geom.create_cylinder = create_cylinder

    def create_cone(radius=1.0, height=2.0, segments=24, color=None, material=None, **kwargs):
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
            if mat is not None and hasattr(mesh, "apply_material"):
                mesh.apply_material(mat)
            return mesh
        raise RuntimeError("Native create_plane not available")
    _geom.create_plane = create_plane

    _orig_create_box = getattr(_geom, "create_box", None)
    def create_box(*args, **kwargs):
        size = None
        color = None
        material = kwargs.get("material")
        if len(args) == 3 and all(isinstance(a, (int, float)) for a in args):
            s = math.Vec3(float(args[0]), float(args[1]), float(args[2]))
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
            if mat is not None and hasattr(mesh, "apply_material"):
                mesh.apply_material(mat)
            return mesh
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
            if mat is not None and hasattr(mesh, "apply_material"):
                mesh.apply_material(mat)
            return mesh
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
            if mat is not None and hasattr(mesh, "apply_material"):
                mesh.apply_material(mat)
            return mesh
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
            if mat is not None and hasattr(mesh, "apply_material"):
                mesh.apply_material(mat)
            return mesh
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
            if mat is not None and hasattr(mesh, "apply_material"):
                mesh.apply_material(mat)
            return mesh
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
            if mat is not None and hasattr(mesh, "apply_material"):
                mesh.apply_material(mat)
            return mesh
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
            if mat is not None and hasattr(mesh, "apply_material"):
                mesh.apply_material(mat)
            return mesh
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
            if mat is not None and hasattr(mesh, "apply_material"):
                mesh.apply_material(mat)
            return mesh
        raise RuntimeError("Native create_loft not available")
    _geom.create_loft = create_loft

    def create_form(bounds=(1.0, 1.0, 1.0), curvature=0.0, bevel=0.02, axis_of_revolution=None, crown=0.25, slope=0.3, center_dip=0.0, color=None, material=None, **kwargs):
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

    def create_catenary_cable(start=(0, 0, 0), end=(10, 0, 0), sag=1.2, radius=0.03, segments=16, color=None, **kwargs):
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

        def get_socket(self, target: Any):
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
    name: str = "ProceduralBuilding",
    **kwargs
) -> Any:
    """
    Constructs multi-story procedural architecture with rhythmic fenestration,
    recessed reveals, continuous compound curvature manifolds, and modeled roofs.
    """
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

    return _native.architecture.generate_building(cfg, name)

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
) -> Any:
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
) -> Any:
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
) -> Any:
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
) -> Any:
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
        glb_path = os.environ.get("SCRATCHBOX_LOCATION_GLB")
        manifest_path = os.environ.get("SCRATCHBOX_LOCATION_MANIFEST")
        query_val = query or os.environ.get("SCRATCHBOX_LOCATION_QUERY", "")

        class LocationData:
            """The place extracted for this run: file paths and the query only. The tiles' geometry is not loaded
            into sb meshes; the tool mounts the extracted GLB under the script's model itself."""
            def __init__(self, glb_p, manifest_p, q):
                self.query = q
                self.glb_path = glb_p
                self.manifest_path = manifest_p

        return LocationData(glb_path, manifest_path, query_val)

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

    def export_glb(arg1, arg2=None):
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
    AdaptiveHeroObjectSynthesizer,
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

__all__ = [
    "AdaptiveHeroObjectSynthesizer",
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
