"""Parametric human anatomy, kinematics, and scale entourage"""

import enum
import scratchbox_native.geometry
import scratchbox_native.math

__all__ = ['GenderMorph', 'SbHumanModel', 'Skeleton', 'create_grounded_character']


class GenderMorph(enum.Enum):
    Male = 1
    Female = 2
    Neutral = 0


class SbHumanModel:
    @staticmethod
    def load_standard(gender: scratchbox_native.human.GenderMorph, target_height: float = 1.76) -> SbHumanModel: ...

    def evaluate_posed(self, skeleton: scratchbox_native.human.Skeleton) -> scratchbox_native.geometry.Mesh: ...

    @property
    def skeleton(self) -> Skeleton: ...
    @skeleton.setter
    def skeleton(self, value: Skeleton) -> None: ...


class Skeleton:
    def find_joint(self, name: str) -> int: ...

    def set_joint_rotation(self, name: str, rotation: scratchbox_native.math.Vec3) -> None: ...

    def get_joint_rotation(self, name: str) -> scratchbox_native.math.Vec3: ...


def create_grounded_character(gender_beta: float = 0.0, target_height: float = 1.76, position: scratchbox_native.math.Vec3 = ..., facing_angle_deg: float = 0.0, pose_archetype: str = 'standing_survey', role: str = 'scale_figure', surface_mesh: scratchbox_native.geometry.Mesh | None = None, surface_y_offset: float = 0.0) -> scratchbox_native.geometry.Mesh:
    """Procedurally synthesizes and grounds an architectural scale entourage figure conforming to the 18% Studio Grey Clay Invariant"""
