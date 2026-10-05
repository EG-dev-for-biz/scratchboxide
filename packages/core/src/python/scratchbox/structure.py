"""
Structure representation in Scratchbox Procedural Engine.
Supports terrain alignment, spatial transforms, and collision footprint extraction.
"""

from typing import Any, Optional, Tuple
import math

class Structure:
    """Procedural architectural structure adhering to Vitruvian tectonic grammar."""

    def __init__(
        self,
        mesh: Any,
        archetype: str,
        footprint_length: float,
        footprint_width: float,
        order: Any = None,
        position: Tuple[float, float, float] = (0.0, 0.0, 0.0)
    ):
        self.mesh = mesh
        self.archetype = archetype
        self.footprint_length = footprint_length
        self.footprint_width = footprint_width
        self.order = order
        self.position = list(position)

    def align_to_terrain(self, terrain: Any, offset_z: float = 0.2) -> "Structure":
        """
        Aligns the structure vertically to the terrain surface.
        Samples terrain elevation beneath the structure foundation to ensure 
        firm grounding without subterranean burial or floating artifacts.
        """
        cx = self.position[0]
        cz = self.position[2]
        half_l = self.footprint_length * 0.5
        half_w = self.footprint_width * 0.5

        # Sample foundation contact points (center + 4 corners + 4 edge midpoints)
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

        ground_elevations = [terrain.sample_height(x, z) for x, z in sample_pts]
        target_ground_y = max(ground_elevations)

        # Find current lowest vertex in structure mesh
        min_y = 1e9
        if hasattr(self.mesh, "vertices"):
            for v in self.mesh.vertices:
                vy = v.position.y if hasattr(v.position, "y") else v.position[1]
                if vy < min_y:
                    min_y = vy
        elif hasattr(self.mesh, "bounds"):
            min_y = self.mesh.bounds.min.y if hasattr(self.mesh.bounds.min, "y") else self.mesh.bounds.min[1]
        else:
            min_y = 0.0

        if min_y > 1e8:
            min_y = 0.0

        # Translate mesh vertically so base sits firmly on terrain
        delta_y = (target_ground_y + offset_z) - min_y
        self.translate(0.0, delta_y, 0.0)
        return self

    def translate(self, dx: Any, dy: Optional[float] = None, dz: Optional[float] = None) -> "Structure":
        """Translate the structure by (dx, dy, dz) meters or by a Vec3 / tuple."""
        if dy is None and dz is None:
            if hasattr(dx, "x") and hasattr(dx, "y") and hasattr(dx, "z"):
                offset_x, offset_y, offset_z = float(dx.x), float(dx.y), float(dx.z)
            elif isinstance(dx, (tuple, list)) and len(dx) >= 3:
                offset_x, offset_y, offset_z = float(dx[0]), float(dx[1]), float(dx[2])
            else:
                offset_x, offset_y, offset_z = float(dx), 0.0, 0.0
        else:
            offset_x, offset_y, offset_z = float(dx), float(dy or 0.0), float(dz or 0.0)

        self.position[0] += offset_x
        self.position[1] += offset_y
        self.position[2] += offset_z

        if hasattr(self.mesh, "translate"):
            try:
                import scratchbox_native as _sn
                self.mesh.translate(_sn.math.Vec3(offset_x, offset_y, offset_z))
            except Exception:
                if hasattr(self.mesh, "vertices"):
                    for v in self.mesh.vertices:
                        if hasattr(v.position, "x"):
                            v.position.x += offset_x
                            v.position.y += offset_y
                            v.position.z += offset_z
                        else:
                            v.position[0] += offset_x
                            v.position[1] += offset_y
                            v.position[2] += offset_z
        elif hasattr(self.mesh, "vertices"):
            for v in self.mesh.vertices:
                if hasattr(v.position, "x"):
                    v.position.x += offset_x
                    v.position.y += offset_y
                    v.position.z += offset_z
                else:
                    v.position[0] += offset_x
                    v.position[1] += offset_y
                    v.position[2] += offset_z

        if hasattr(self.mesh, "recomputeBounds"):
            self.mesh.recomputeBounds()
        elif hasattr(self.mesh, "recompute_bounds"):
            self.mesh.recompute_bounds()

        return self

    def apply_material(self, mat: Any) -> "Structure":
        """Applies a PBR material to the underlying structure mesh."""
        if hasattr(self.mesh, "apply_material"):
            self.mesh.apply_material(mat)
        elif hasattr(self.mesh, "material"):
            self.mesh.material = mat
        return self

    def set_material(self, mat: Any) -> "Structure":
        """Sets the PBR material on the underlying structure mesh."""
        return self.apply_material(mat)

    def set_color(self, color: Any) -> "Structure":
        """Sets vertex color or base tint on the underlying structure mesh."""
        if hasattr(self.mesh, "set_color"):
            self.mesh.set_color(color)
        return self

    @property
    def material(self) -> Any:
        return getattr(self.mesh, "material", None)

    @material.setter
    def material(self, mat: Any) -> None:
        self.apply_material(mat)

    def get_mesh(self) -> Any:
        return self.mesh

    def __getattr__(self, name: str) -> Any:
        """Transparently delegate any mesh methods to self.mesh."""
        if hasattr(self.mesh, name):
            return getattr(self.mesh, name)
        raise AttributeError(f"'Structure' object has no attribute '{name}'")
