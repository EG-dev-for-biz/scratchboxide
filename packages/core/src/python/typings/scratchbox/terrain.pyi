"""
Terrain representation in Scratchbox Procedural Engine.
Provides high-performance elevation sampling, slope calculation, and mesh access.
"""

import typing

__all__ = ['Any', 'Optional', 'Terrain', 'Tuple', 'math']

Any = typing.Any
Optional = typing.Optional

class Terrain:
    """Procedural geological terrain surface with domain warping and hydrological sediment."""
    def __init__(self, surface_or_mesh: typing.Any, extents: typing.Tuple[float, float], archetype: str, domain_warp_scale: float, hydraulic_erosion_steps: int) -> None: ...

    def sample_height(self, x: float, z: float) -> float:
        """Sample elevation height (meters) at coordinate (x, z)."""

    def sample_normal(self, x: float, z: float) -> typing.Any:
        """Sample surface normal vector at coordinate (x, z)."""

    def sample_slope_degrees(self, x: float, z: float) -> float:
        """Calculate surface slope angle in degrees at coordinate (x, z)."""

    def get_mesh(self) -> typing.Any: ...

    def apply_material(self, mat: typing.Any) -> Terrain:
        """Applies a PBR material to the underlying terrain mesh."""

    def set_material(self, mat: typing.Any) -> Terrain:
        """Sets the PBR material on the underlying terrain mesh."""

    def set_color(self, color: typing.Any) -> Terrain:
        """Sets vertex color or base tint on the underlying terrain mesh."""

    @property
    def material(self) -> typing.Any: ...
    @material.setter
    def material(self, value: typing.Any) -> None: ...

    def __getattr__(self, name: str) -> typing.Any:
        """Transparently delegate any mesh methods (e.g. translate, scale) to self.mesh."""

    extents: typing.Any
    archetype: typing.Any
    domain_warp_scale: typing.Any
    hydraulic_erosion_steps: typing.Any
    min_x: typing.Any
    max_x: typing.Any
    min_z: typing.Any
    max_z: typing.Any
    mesh: typing.Any

Tuple = typing.Tuple
import math
