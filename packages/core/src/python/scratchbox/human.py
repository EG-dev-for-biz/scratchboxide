"""
Declarative human entourage and architectural scale figure module for Scratchbox Python SDK.
Adheres strictly to the 18% Studio Grey Clay Invariant, Adaptive Domain Architecture (ADA),
and analytical 2-bone IK foot-to-ground clamping.
"""

from typing import Optional, Tuple, Union, Any
import math

class Human:
    """
    Architectural scale entourage figure.
    Grounded with analytical 2-bone IK and styled in 18% Studio Grey Clay.
    """
    def __init__(
        self,
        role: str = "scale_figure",
        height: float = 1.76,
        gender_beta: float = 0.0,
        pose: str = "standing_survey",
        position: Tuple[float, float, float] = (0.0, 0.0, 0.0),
        facing_deg: float = 0.0,
        surface: Optional[Any] = None,
        surface_y_offset: float = 0.0,
    ):
        self.role = str(role)
        self.height = float(height)
        self.gender_beta = float(gender_beta)
        self.pose = str(pose)
        self.position = (float(position[0]), float(position[1]), float(position[2]))
        self.facing_deg = float(facing_deg)
        self.surface = surface
        self.surface_y_offset = float(surface_y_offset)
        self._mesh = None

    def stand_on(
        self,
        surface: Any,
        offset: Tuple[float, float] = (0.0, 0.0),
        y_offset: float = 0.0,
        facing_deg: Optional[float] = None
    ) -> "Human":
        """
        Attach and ground this figure on a terrain, structure, plinth, or surface mesh.
        Native 2-bone IK in C++ solves foot elevation and slope adaptation.
        """
        self.surface = surface
        if offset and len(offset) == 2:
            self.position = (self.position[0] + float(offset[0]), self.position[1], self.position[2] + float(offset[1]))
        if y_offset != 0.0:
            self.surface_y_offset = float(y_offset)
        if facing_deg is not None:
            self.facing_deg = float(facing_deg)
        self._mesh = None  # Invalidate cached mesh
        return self

    @property
    def mesh(self) -> Any:
        if self._mesh is None:
            self._mesh = self.build_mesh()
        return self._mesh

    def build_mesh(self) -> Any:
        import scratchbox_native
        human_mod = getattr(scratchbox_native, "human", None)
        if not human_mod or not hasattr(human_mod, "create_grounded_character"):
            raise RuntimeError("scratchbox_native.human module not compiled or available.")

        surface_native_mesh = None
        if self.surface is not None:
            if hasattr(self.surface, "mesh"):
                surface_native_mesh = self.surface.mesh
            elif hasattr(self.surface, "vertices"):
                surface_native_mesh = self.surface

        pos_vec = scratchbox_native.math.Vec3(self.position[0], self.position[1], self.position[2])
        return human_mod.create_grounded_character(
            float(self.gender_beta),
            float(self.height),
            pos_vec,
            float(self.facing_deg),
            str(self.pose),
            str(self.role),
            surface_native_mesh,
            float(self.surface_y_offset)
        )

    def __repr__(self) -> str:
        return (
            f"<Human role='{self.role}' height={self.height:.2f}m "
            f"gender_beta={self.gender_beta:.2f} pose='{self.pose}' "
            f"pos={self.position} facing={self.facing_deg:.1f}°>"
        )


def create_human(
    role: str = "scale_figure",
    height: float = 1.76,
    gender_beta: float = 0.0,
    pose: str = "standing_survey",
    position: Tuple[float, float, float] = (0.0, 0.0, 0.0),
    facing_deg: float = 0.0,
    surface: Optional[Any] = None,
    surface_y_offset: float = 0.0,
    **kwargs
) -> Human:
    """
    Factory function for synthesizing an architectural scale entourage human.
    """
    return Human(
        role=role,
        height=height,
        gender_beta=gender_beta,
        pose=pose,
        position=position,
        facing_deg=facing_deg,
        surface=surface,
        surface_y_offset=surface_y_offset,
        **kwargs
    )
