"""Ivy growth (trees: the vegetation submodule, SB-Veggie)"""

import scratchbox_native.geometry
import scratchbox_native.math

__all__ = ['IvyConfig', 'generate_ivy']


class IvyConfig:
    def __init__(self) -> None: ...

    @property
    def root_position(self) -> scratchbox_native.math.Vec3: ...
    @root_position.setter
    def root_position(self, value: scratchbox_native.math.Vec3) -> None: ...

    @property
    def obstacle_min(self) -> scratchbox_native.math.Vec3: ...
    @obstacle_min.setter
    def obstacle_min(self, value: scratchbox_native.math.Vec3) -> None: ...

    @property
    def obstacle_max(self) -> scratchbox_native.math.Vec3: ...
    @obstacle_max.setter
    def obstacle_max(self, value: scratchbox_native.math.Vec3) -> None: ...

    @property
    def max_steps(self) -> int: ...
    @max_steps.setter
    def max_steps(self, value: int) -> None: ...

    @property
    def cling_distance(self) -> float: ...
    @cling_distance.setter
    def cling_distance(self, value: float) -> None: ...


def generate_ivy(config: scratchbox_native.nature.IvyConfig) -> scratchbox_native.geometry.Mesh:
    """Generate obstacle-clinging ivy vines across geometric boundaries"""
