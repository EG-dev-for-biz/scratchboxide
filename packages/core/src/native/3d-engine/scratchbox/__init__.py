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

# Attach ergonomic helpers to geometry submodule
geometry.create_box = create_box
geometry.create_cube = create_cube
geometry.create_studio_pedestal = create_studio_pedestal

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

__all__ = [
    "math",
    "geometry",
    "architecture",
    "nature",
    "composer",
    "io",
    "Mesh",
    "PbrMaterial",
    "Vec2",
    "Vec3",
    "Vec4",
    "Quat",
]
