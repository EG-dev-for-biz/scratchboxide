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

    _orig_create_plane = getattr(_geom, "create_plane", None)
    def create_plane(width=2.0, height=2.0, seg_x=4, seg_y=4, segments=None, **kwargs):
        sx = int(segments if segments is not None else seg_x)
        sy = int(segments if segments is not None else seg_y)
        if _orig_create_plane:
            return _orig_create_plane(float(width), float(height), sx, sy)
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

    cfg = _native.architecture.BuildingConfig()
    cfg.width = float(width)
    cfg.depth = float(depth)
    cfg.floor_count = int(kwargs.get("floor_count", floors))
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
    "geospatial",
    "nature",
    "architecture",
    "math",
    "geometry",
    "io",
    "core",
    "shaper",
    "composer",
    "plant"
]
