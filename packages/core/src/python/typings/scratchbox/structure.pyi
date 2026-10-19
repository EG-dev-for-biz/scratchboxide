"""
Structure representation in Scratchbox Procedural Engine.
Supports terrain alignment, spatial transforms, and collision footprint extraction.
"""

import typing

__all__ = ['Any', 'Optional', 'Structure', 'Tuple', 'math']

Any = typing.Any
Optional = typing.Optional

class Structure:
    """Procedural architectural structure adhering to Vitruvian tectonic grammar."""
    def __init__(self, mesh: typing.Any, archetype: str, footprint_length: float, footprint_width: float, order: typing.Any = None, position: typing.Tuple[float, float, float] = (0.0, 0.0, 0.0)) -> None: ...

    def align_to_terrain(self, terrain: typing.Any, offset_z: float = 0.2) -> Structure:
        """
        Aligns the structure vertically to the terrain surface.
        Samples terrain elevation beneath the structure foundation to ensure 
        firm grounding without subterranean burial or floating artifacts.
        """

    def translate(self, dx: typing.Any, dy: typing.Optional[float] = None, dz: typing.Optional[float] = None) -> Structure:
        """Translate the structure by (dx, dy, dz) meters or by a Vec3 / tuple."""

    def apply_material(self, mat: typing.Any) -> Structure:
        """Applies a PBR material to the underlying structure mesh."""

    def set_material(self, mat: typing.Any) -> Structure:
        """Sets the PBR material on the underlying structure mesh."""

    def set_color(self, color: typing.Any) -> Structure:
        """Sets vertex color or base tint on the underlying structure mesh."""

    @property
    def material(self) -> typing.Any: ...
    @material.setter
    def material(self, value: typing.Any) -> None: ...

    def get_mesh(self) -> typing.Any: ...

    def get_bounding_box(self) -> typing.Tuple[typing.Tuple[float, float, float], typing.Tuple[float, float, float]]:
        """Returns ((min_x, min_y, min_z), (max_x, max_y, max_z)) of structure."""

    def find_mount_plane(self, face: str = 'front') -> dict:
        """
        Calculates the 3D origin, normal, tangent basis vectors (u, v), and dimensions
        for an exterior façade mount plane (e.g. for fire escapes, signs, awnings).
        """

    def solve_mount_clearance(self, target_width: float, target_height: float, face: str = 'front', obstacles: typing.Optional[list] = None, safety_margin: float = 0.25) -> dict:
        """
        Analytical 2D clearance interval solver.
        Finds a collision-free mounting interval on the building façade avoiding apertures.
        """

    def attach_to_mount(self, attachment: typing.Any, face: str = 'front', u_offset: float = 0.0, v_offset: float = 0.0, standoff_meters: float = 0.05) -> Structure:
        """
        Mounts an external accessory (e.g. fire escape, sign, awning) flush against
        the structure façade with zero air gap and exact normal orientation.
        """

    def __getattr__(self, name: str) -> typing.Any:
        """Transparently delegate any mesh methods to self.mesh."""

    mesh: typing.Any
    archetype: typing.Any
    footprint_length: typing.Any
    footprint_width: typing.Any
    order: typing.Any
    position: typing.Any

Tuple = typing.Tuple
import math
