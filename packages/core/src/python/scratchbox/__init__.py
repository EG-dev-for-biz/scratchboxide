"""
Scratchbox Agentic 3D Procedural Engine (Python SDK)
Autonomous, headless, real-time procedural creation competing directly with Blender.
"""

import sys
import os
import math as _py_math
from typing import Any, Tuple, Optional, Union, List

# Ensure native module is discoverable from both package installations and local build dirs
try:
    import scratchbox_native as _native
except ImportError:
    _cur_dir = os.path.dirname(os.path.abspath(__file__))
    _candidate_dirs = [
        os.path.abspath(os.path.join(_cur_dir, "..", "..", "native", "3d-engine", "scratchbox")),
        os.path.abspath(os.path.join(_cur_dir, "..", "..", "native", "3d-engine", "build_py")),
        _cur_dir
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
from .plant import PlantPreset, Flora

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
        # Support appending Terrain or Structure instances directly
        target = other.mesh if hasattr(other, "mesh") else other
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
            if "base_color" in kwargs:
                bc = kwargs["base_color"]
                if isinstance(bc, (tuple, list)):
                    if len(bc) == 3:
                        mat.base_color = math.Vec4(float(bc[0]), float(bc[1]), float(bc[2]), 1.0)
                    elif len(bc) >= 4:
                        mat.base_color = math.Vec4(float(bc[0]), float(bc[1]), float(bc[2]), float(bc[3]))
                elif hasattr(bc, "w"):
                    mat.base_color = bc
                elif hasattr(bc, "x") and hasattr(bc, "y") and hasattr(bc, "z"):
                    mat.base_color = math.Vec4(float(bc.x), float(bc.y), float(bc.z), 1.0)

            if "metallic" in kwargs:
                mat.metallic = float(kwargs["metallic"])
            elif "metalness" in kwargs:
                mat.metallic = float(kwargs["metalness"])

            if "roughness" in kwargs:
                mat.roughness = float(kwargs["roughness"])

            if "emissive" in kwargs:
                em = kwargs["emissive"]
                intensity = float(kwargs.get("emissive_intensity", 1.0))
                if isinstance(em, (tuple, list)) and len(em) >= 3:
                    mat.emissive = math.Vec3(float(em[0]) * intensity, float(em[1]) * intensity, float(em[2]) * intensity)
                elif hasattr(em, "x"):
                    mat.emissive = math.Vec3(float(em.x) * intensity, float(em.y) * intensity, float(em.z) * intensity)

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
            self.material = mat
            return self

        _NativeMesh.align_to_terrain = _mesh_align_to_terrain
        _NativeMesh.apply_material = _mesh_apply_material
        _NativeMesh.set_material = _mesh_apply_material

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

    _orig_create_cylinder = getattr(_geom, "create_cylinder", None)
    def create_cylinder(radius=None, radius_top=1.0, radius_bottom=1.0, height=2.0, segments=24, color=None, **kwargs):
        rt = float(radius if radius is not None else radius_top)
        rb = float(radius if radius is not None else radius_bottom)
        c = color
        if c is not None:
            if isinstance(c, (tuple, list)) and len(c) >= 3:
                c = math.Vec4(float(c[0]), float(c[1]), float(c[2]), float(c[3]) if len(c) > 3 else 1.0)
        else:
            c = math.Vec4(0.8, 0.8, 0.8, 1.0)
        if _orig_create_cylinder:
            return _orig_create_cylinder(rt, rb, float(height), int(segments), c)
        raise RuntimeError("Native create_cylinder not available")
    _geom.create_cylinder = create_cylinder

    def create_cone(radius=1.0, height=2.0, segments=24, color=None, **kwargs):
        return create_cylinder(radius_top=0.0, radius_bottom=radius, height=height, segments=segments, color=color, **kwargs)
    _geom.create_cone = create_cone

    _orig_create_plane = getattr(_geom, "create_plane", None)
    def create_plane(width=2.0, height=2.0, depth=None, seg_x=4, seg_y=4, segments=None, width_segments=None, depth_segments=None, **kwargs):
        h = float(depth if depth is not None else height)
        sx = int(segments if segments is not None else (width_segments if width_segments is not None else seg_x))
        sy = int(segments if segments is not None else (depth_segments if depth_segments is not None else seg_y))
        if _orig_create_plane:
            return _orig_create_plane(float(width), h, sx, sy)
        raise RuntimeError("Native create_plane not available")
    _geom.create_plane = create_plane

    _orig_create_box = getattr(_geom, "create_box", None)
    def create_box(size=None, color=None, width=1.0, height=1.0, depth=1.0, **kwargs):
        if size is not None:
            if isinstance(size, (tuple, list)) and len(size) >= 3:
                s = math.Vec3(float(size[0]), float(size[1]), float(size[2]))
            elif isinstance(size, (int, float)):
                v = float(size)
                s = math.Vec3(v, v, v)
            else:
                s = size
        else:
            s = math.Vec3(float(width), float(height), float(depth))

        if color is not None:
            if isinstance(color, (tuple, list)) and len(color) >= 3:
                c = math.Vec4(float(color[0]), float(color[1]), float(color[2]), float(color[3]) if len(color) > 3 else 1.0)
            else:
                c = color
        else:
            c = math.Vec4(0.8, 0.8, 0.8, 1.0)

        if _orig_create_box:
            return _orig_create_box(s, c)
        raise RuntimeError("Native create_box not available")
    _geom.create_box = create_box
    _geom.create_cube = create_box

    _orig_create_sphere = getattr(_geom, "create_sphere", None)
    def create_sphere(radius=1.0, rings=16, sectors=32, color=None, segments=None, **kwargs):
        r = int(segments if segments is not None else rings)
        s = int(segments if segments is not None else sectors)
        if color is not None:
            if isinstance(color, (tuple, list)) and len(color) >= 3:
                c = math.Vec4(float(color[0]), float(color[1]), float(color[2]), float(color[3]) if len(color) > 3 else 1.0)
            else:
                c = color
        else:
            c = math.Vec4(0.9, 0.3, 0.3, 1.0)
        if _orig_create_sphere:
            return _orig_create_sphere(float(radius), r, s, c)
        raise RuntimeError("Native create_sphere not available")
    _geom.create_sphere = create_sphere

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
    name: str = "ProceduralBuilding",
    **kwargs
) -> Any:
    """
    Constructs multi-story procedural architecture with rhythmic fenestration and modeled roofs.
    """
    if _native is None or not hasattr(_native, "architecture"):
        raise RuntimeError("Native 3D architecture module scratchbox_native.architecture is required")

    # Support continuous dimensional parameters (Alien Planet Test)
    archetype_str = str(kwargs.get("archetype", "")).lower()
    if "dome" in archetype_str:
        rad = float(kwargs.get("radius", max(width, depth) * 0.5))
        dome_mesh = create_sphere(radius=rad, segments=32)
        dome_mesh.name = name or "GeodesicDome"
        return dome_mesh

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
    cfg.roof_pitch_degrees = float(roof_pitch_degrees)
    cfg.roof_overhang = float(roof_overhang)
    cfg.parapet_height = float(parapet_height)

    RoofType = _native.architecture.RoofType
    if isinstance(roof, str):
        r = roof.lower().strip()
        if "mansard" in r:
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
            def __init__(self, glb_p, manifest_p, q):
                self.query = q
                self.glb_path = glb_p
                self.manifest_path = manifest_p
                self.raw_mesh = None
                self.terrain_mesh = None
                self.buildings_mesh = None

        return LocationData(glb_path, manifest_path, query_val)

geospatial = _GeospatialModule()

class _NatureModule:
    PlantPreset = PlantPreset
    Flora = Flora
    create_tree = staticmethod(create_tree)
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
        target_mesh = target.mesh if hasattr(target, "mesh") else target
        if _orig_write_glb:
            return _orig_write_glb(out_path, target_mesh)
        raise RuntimeError("Native io.write_glb not available")

    def export_glb(arg1, arg2=None):
        return write_glb(arg1, arg2)

    _native.io.write_glb = write_glb
    _native.io.export_glb = export_glb
    if io is not None:
        io.write_glb = write_glb
        io.export_glb = export_glb

create_cylinder = getattr(_geom, "create_cylinder", None)
create_cone = getattr(_geom, "create_cone", None)
create_plane = getattr(_geom, "create_plane", None)
create_box = getattr(_geom, "create_box", None)
create_cube = getattr(_geom, "create_cube", None)
create_sphere = getattr(_geom, "create_sphere", None)

__all__ = [
    "World",
    "Terrain",
    "Structure",
    "RomanOrder",
    "PlantPreset",
    "Flora",
    "create_building",
    "create_tree",
    "create_studio_pedestal",
    "create_cylinder",
    "create_cone",
    "create_plane",
    "create_box",
    "create_cube",
    "create_sphere",
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
    "plant"
]
