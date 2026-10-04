"""
Scratchbox Agentic 3D Procedural Engine (Python SDK)
Autonomous, headless, real-time procedural creation competing directly with Blender.
"""

import sys
import os
from typing import Any

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

# Submodules
class _NatureModule:
    PlantPreset = PlantPreset
    Flora = Flora
    if _native and hasattr(_native, "nature"):
        SpaceColonizationConfig = getattr(_native.nature, "SpaceColonizationConfig", None)
        SpaceColonizationTree = getattr(_native.nature, "SpaceColonizationTree", None)

nature = _NatureModule()

class _ArchitectureModule:
    RomanOrder = RomanOrder
    if _native and hasattr(_native, "architecture"):
        BuildingConfig = getattr(_native.architecture, "BuildingConfig", None)
        RoofType = getattr(_native.architecture, "RoofType", None)
        generate_building = getattr(_native.architecture, "generate_building", None)
        generate_peripteral_temple = getattr(_native.architecture, "generate_peripteral_temple", None)

architecture = _ArchitectureModule()

math = getattr(_native, "math", None) if _native else None
geometry = getattr(_native, "geometry", None) if _native else None
io = getattr(_native, "io", None) if _native else None
core = getattr(_native, "core", None) if _native else None
shaper = getattr(_native, "shaper", None) if _native else None
composer = getattr(_native, "composer", None) if _native else None
plant = getattr(_native, "plant", None) if _native else None

__all__ = [
    "World",
    "Terrain",
    "Structure",
    "RomanOrder",
    "PlantPreset",
    "Flora",
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
