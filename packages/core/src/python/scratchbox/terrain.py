"""
Terrain representation in Scratchbox Procedural Engine.
Provides high-performance elevation sampling, slope calculation, and mesh access.
"""

from typing import Tuple, Any, Optional
import math

class Terrain:
    """Procedural geological terrain surface with domain warping and hydrological sediment."""

    def __init__(self, surface_or_mesh: Any, extents: Tuple[float, float], archetype: str, domain_warp_scale: float, hydraulic_erosion_steps: int):
        self._surface = surface_or_mesh
        self.extents = extents
        self.archetype = archetype
        self.domain_warp_scale = domain_warp_scale
        self.hydraulic_erosion_steps = hydraulic_erosion_steps

        # Extract mesh
        if hasattr(surface_or_mesh, "mesh"):
            self.mesh = surface_or_mesh.mesh
        else:
            self.mesh = surface_or_mesh

        # Calculate bounding box
        self.min_x = -extents[0] * 0.5
        self.max_x = extents[0] * 0.5
        self.min_z = -extents[1] * 0.5
        self.max_z = extents[1] * 0.5

    def sample_height(self, x: float, z: float) -> float:
        """Sample elevation height (meters) at coordinate (x, z)."""
        if hasattr(self._surface, "sample_height"):
            return float(self._surface.sample_height(x, z))
        return 0.0

    def sample_normal(self, x: float, z: float) -> Any:
        """Sample surface normal vector at coordinate (x, z)."""
        if hasattr(self._surface, "sample_normal"):
            return self._surface.sample_normal(x, z)
        # Numerical finite difference fallback
        eps = 0.1
        hL = self.sample_height(x - eps, z)
        hR = self.sample_height(x + eps, z)
        hD = self.sample_height(x, z - eps)
        hU = self.sample_height(x, z + eps)
        gx = (hR - hL) / (2.0 * eps)
        gz = (hU - hD) / (2.0 * eps)
        length = math.sqrt(gx * gx + 1.0 + gz * gz)
        return (-gx / length, 1.0 / length, -gz / length)

    def sample_slope_degrees(self, x: float, z: float) -> float:
        """Calculate surface slope angle in degrees at coordinate (x, z)."""
        if hasattr(self._surface, "sample_slope_degrees"):
            return float(self._surface.sample_slope_degrees(x, z))
        normal = self.sample_normal(x, z)
        ny = normal.y if hasattr(normal, "y") else normal[1]
        ny = max(-1.0, min(1.0, ny))
        return math.degrees(math.acos(ny))

    def get_mesh(self) -> Any:
        return self.mesh

    def apply_material(self, mat: Any) -> "Terrain":
        """Applies a PBR material to the underlying terrain mesh."""
        if hasattr(self.mesh, "apply_material"):
            self.mesh.apply_material(mat)
        elif hasattr(self.mesh, "material"):
            self.mesh.material = mat
        return self

    def set_material(self, mat: Any) -> "Terrain":
        """Sets the PBR material on the underlying terrain mesh."""
        return self.apply_material(mat)

    def set_color(self, color: Any) -> "Terrain":
        """Sets vertex color or base tint on the underlying terrain mesh."""
        if hasattr(self.mesh, "set_color"):
            self.mesh.set_color(color)
        return self

    @property
    def material(self) -> Any:
        return getattr(self.mesh, "material", None)

    @material.setter
    def material(self, mat: Any) -> None:
        self.apply_material(mat)

    def __getattr__(self, name: str) -> Any:
        """Transparently delegate any mesh methods (e.g. translate, scale) to self.mesh."""
        if hasattr(self.mesh, name):
            return getattr(self.mesh, name)
        raise AttributeError(f"'Terrain' object has no attribute '{name}'")
