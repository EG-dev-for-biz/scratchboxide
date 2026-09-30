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
io = _native.io

# Core Types
Mesh = geometry.Mesh
PbrMaterial = geometry.PbrMaterial
Vec2 = math.Vec2
Vec3 = math.Vec3
Vec4 = math.Vec4
Quat = math.Quat

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
