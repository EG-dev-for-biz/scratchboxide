"""
Scratchbox IDE 3D Engine — Python Procedural Scene & Geometry SDK
High-performance C++20 engine with Python bindings (nanobind).
"""

import sys
import os

try:
    import scratchbox_native as _native
except ImportError:
    _this_dir = os.path.dirname(os.path.abspath(__file__))
    _candidate_dirs = [
        _this_dir,
        os.path.join(_this_dir, "..", "build_py"),
        os.path.join(_this_dir, "build_py"),
        os.path.join(os.getcwd(), "packages", "core", "src", "native", "3d-engine", "build_py"),
        os.path.join(os.getcwd(), "build", "3d-native"),
    ]
    for d in _candidate_dirs:
        if os.path.isdir(d) and d not in sys.path:
            sys.path.insert(0, d)
    import scratchbox_native as _native

# Submodules
math = _native.math
geometry = _native.geometry
architecture = _native.architecture
nature = _native.nature
composer = _native.composer
shaper = _native.shaper
io = _native.io

# Core Types
Mesh = geometry.Mesh
Scene = geometry.Mesh
PbrMaterial = geometry.PbrMaterial
Vec2 = math.Vec2
Vec3 = math.Vec3
Vec4 = math.Vec4
Quat = math.Quat

# ==============================================================================
# Ergonomic Python Primitives & Blender-Style Aliases
# ==============================================================================
_orig_create_box = _native.geometry.create_box
_orig_create_pedestal = _native.geometry.create_studio_pedestal

def create_box(size=None, width=1.0, height=1.0, depth=1.0, color=None):
    if size is not None:
        if isinstance(size, (list, tuple)):
            s = Vec3(float(size[0]), float(size[1]), float(size[2]))
        elif isinstance(size, (int, float)):
            s = Vec3(float(size), float(size), float(size))
        else:
            s = size
    else:
        s = Vec3(float(width), float(height), float(depth))
    c = color if color is not None else Vec4(0.8, 0.8, 0.8, 1.0)
    return _orig_create_box(s, c)

def create_cube(size=1.0, width=None, height=None, depth=None, color=None):
    w = width if width is not None else (size if isinstance(size, (int, float)) else size[0])
    h = height if height is not None else (size if isinstance(size, (int, float)) else size[1])
    d = depth if depth is not None else (size if isinstance(size, (int, float)) else size[2])
    return create_box(width=w, height=h, depth=d, color=color)

def create_studio_pedestal(radius=4.0, height=0.25, bevel_radius=0.04, bevel=None, segments=64):
    b = bevel if bevel is not None else bevel_radius
    return _orig_create_pedestal(float(radius), float(height), float(b), int(segments))

def create_promenade(width=40.0, depth=30.0, height=0.6, steps=3, material='granite', color=None):
    c = color if color is not None else Vec4(0.82, 0.80, 0.77, 1.0)
    box = create_box(width=width, height=height, depth=depth, color=c)
    box.translate(0, float(height) * 0.5, 0)
    return box

# Attach ergonomic helpers to geometry submodule
geometry.Scene = geometry.Mesh
geometry.create_box = create_box
geometry.create_cube = create_cube
geometry.create_studio_pedestal = create_studio_pedestal
geometry.create_pedestal = create_studio_pedestal
geometry.create_promenade = create_promenade

# Polymorphic Mesh transforms (accept 3 floats, tuple/list, or Vec3)
_orig_mesh_translate = Mesh.translate
_orig_mesh_scale = Mesh.scale

def _mesh_translate(self, *args):
    if len(args) == 1:
        arg = args[0]
        if isinstance(arg, (list, tuple)):
            return _orig_mesh_translate(self, Vec3(float(arg[0]), float(arg[1]), float(arg[2])))
        elif isinstance(arg, (int, float)):
            return _orig_mesh_translate(self, Vec3(float(arg), float(arg), float(arg)))
        return _orig_mesh_translate(self, arg)
    elif len(args) == 3:
        return _orig_mesh_translate(self, Vec3(float(args[0]), float(args[1]), float(args[2])))
    raise TypeError(f"translate() takes 1 Vec3/tuple or 3 floats, got {args}")

def _mesh_scale(self, *args):
    if len(args) == 1:
        arg = args[0]
        if isinstance(arg, (list, tuple)):
            return _orig_mesh_scale(self, Vec3(float(arg[0]), float(arg[1]), float(arg[2])))
        elif isinstance(arg, (int, float)):
            return _orig_mesh_scale(self, Vec3(float(arg), float(arg), float(arg)))
        return _orig_mesh_scale(self, arg)
    elif len(args) == 3:
        return _orig_mesh_scale(self, Vec3(float(args[0]), float(args[1]), float(args[2])))
    raise TypeError(f"scale() takes 1 Vec3/tuple/float or 3 floats, got {args}")

Mesh.translate = _mesh_translate
Mesh.scale = _mesh_scale
Mesh.merge = Mesh.append
Mesh.__iadd__ = lambda self, other: (self.append(other), self)[1]

# ==============================================================================
# Architecture & Nature Procedural Building Blocks
# ==============================================================================
RoofType = architecture.RoofType
RoofType.MANSARD = RoofType.Mansard
RoofType.GABLE = RoofType.Gable
RoofType.HIP = RoofType.Hip
RoofType.FLAT_PARAPET = RoofType.FlatParapet
RoofType.FLAT = RoofType.FlatParapet
RoofType.Flat = RoofType.FlatParapet

def _resolve_roof_type(val):
    if isinstance(val, RoofType):
        return val
    if isinstance(val, str):
        v = val.lower().replace("-", "").replace("_", "")
        if "mansard" in v:
            return RoofType.Mansard
        elif "gable" in v:
            return RoofType.Gable
        elif "hip" in v:
            return RoofType.Hip
        elif "flat" in v or "parapet" in v:
            return RoofType.FlatParapet
    return RoofType.Mansard

BuildingConfig = architecture.BuildingConfig
BuildingConfig.stories = property(lambda s: s.floor_count, lambda s, v: setattr(s, "floor_count", int(v)))
BuildingConfig.floors = property(lambda s: s.floor_count, lambda s, v: setattr(s, "floor_count", int(v)))
BuildingConfig.roof = property(lambda s: s.roof_type, lambda s, v: setattr(s, "roof_type", _resolve_roof_type(v)))

def create_building(
    width=16.0,
    depth=12.0,
    floor_count=None,
    floors=None,
    stories=None,
    floor_height=3.4,
    ground_floor_height=4.2,
    roof=None,
    roof_type=None,
    bay_width=3.2,
    window_width=1.8,
    window_height=2.0,
    window_recess_depth=0.22,
    plinth_height=0.6,
    roof_pitch_degrees=32.0,
    roof_overhang=0.65,
    parapet_height=1.1,
    name="ProceduralBuilding"
):
    cfg = BuildingConfig()
    cfg.width = float(width)
    cfg.depth = float(depth)
    count = floor_count or floors or stories or 4
    cfg.floor_count = int(count)
    cfg.floor_height = float(floor_height)
    cfg.ground_floor_height = float(ground_floor_height)
    cfg.plinth_height = float(plinth_height)
    cfg.bay_width = float(bay_width)
    cfg.window_width = float(window_width)
    cfg.window_height = float(window_height)
    cfg.window_recess_depth = float(window_recess_depth)
    r = roof or roof_type or RoofType.Mansard
    cfg.roof_type = _resolve_roof_type(r)
    cfg.roof_pitch_degrees = float(roof_pitch_degrees)
    cfg.roof_overhang = float(roof_overhang)
    cfg.parapet_height = float(parapet_height)
    return architecture.generate_building(cfg, name)

architecture.create_building = create_building

def create_tree(
    attractor_count=160,
    crown_center=(0, 6, 0),
    crown_extents=(3.5, 4.5, 3.5),
    perception_radius=4.0,
    kill_radius=0.5,
    branch_step_length=0.35,
    base_radius=0.35,
    generate_leaves=True
):
    cfg = nature.SpaceColonizationConfig()
    cfg.attractor_count = int(attractor_count)
    if isinstance(crown_center, (list, tuple)):
        cfg.crown_center = Vec3(float(crown_center[0]), float(crown_center[1]), float(crown_center[2]))
    else:
        cfg.crown_center = crown_center
    if isinstance(crown_extents, (list, tuple)):
        cfg.crown_extents = Vec3(float(crown_extents[0]), float(crown_extents[1]), float(crown_extents[2]))
    else:
        cfg.crown_extents = crown_extents
    cfg.perception_radius = float(perception_radius)
    cfg.kill_radius = float(kill_radius)
    cfg.branch_step_length = float(branch_step_length)
    cfg.base_radius = float(base_radius)
    cfg.generate_leaves = bool(generate_leaves)
    return nature.generate_tree(cfg)

nature.create_tree = create_tree

def create_ivy(
    root=(0, 0, 0),
    obstacle_min=(-2, 0, -2),
    obstacle_max=(2, 6, 2),
    max_steps=120,
    cling_distance=0.15
):
    cfg = nature.IvyConfig()
    if isinstance(root, (list, tuple)):
        cfg.root_position = Vec3(float(root[0]), float(root[1]), float(root[2]))
    else:
        cfg.root_position = root
    if isinstance(obstacle_min, (list, tuple)):
        cfg.obstacle_min = Vec3(float(obstacle_min[0]), float(obstacle_min[1]), float(obstacle_min[2]))
    else:
        cfg.obstacle_min = obstacle_min
    if isinstance(obstacle_max, (list, tuple)):
        cfg.obstacle_max = Vec3(float(obstacle_max[0]), float(obstacle_max[1]), float(obstacle_max[2]))
    else:
        cfg.obstacle_max = obstacle_max
    cfg.max_steps = int(max_steps)
    cfg.cling_distance = float(cling_distance)
    return nature.generate_ivy(cfg)

nature.create_ivy = create_ivy

# Polymorphic IO helpers (support export_glb(mesh), save_glb(mesh), write_glb(path, mesh))
_orig_write_glb = _native.io.write_glb
_orig_export_glb_bytes = _native.io.export_glb_bytes

def export_glb(mesh_or_path, maybe_path_or_mesh=None):
    import __main__
    mesh = None
    path = None
    if maybe_path_or_mesh is not None:
        if isinstance(mesh_or_path, str):
            path = mesh_or_path
            mesh = maybe_path_or_mesh
        else:
            mesh = mesh_or_path
            path = maybe_path_or_mesh
    else:
        mesh = mesh_or_path
        path = getattr(__main__, "OUTPUT_GLB_PATH", None) or os.environ.get("OUTPUT_GLB_PATH", "output.glb")

    # If mesh is a single Mesh, wrap or pass directly
    return _orig_write_glb(str(path), mesh)

io.export_glb = export_glb
io.save_glb = export_glb
io.write_glb = export_glb

create_pedestal = create_studio_pedestal

__all__ = [
    "math",
    "geometry",
    "architecture",
    "nature",
    "composer",
    "io",
    "Mesh",
    "Scene",
    "PbrMaterial",
    "Vec2",
    "Vec3",
    "Vec4",
    "Quat",
    "RoofType",
    "BuildingConfig",
    "create_box",
    "create_cube",
    "create_studio_pedestal",
    "create_pedestal",
    "create_promenade",
    "create_building",
    "create_tree",
    "create_ivy",
]

