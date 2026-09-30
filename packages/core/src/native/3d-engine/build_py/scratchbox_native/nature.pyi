"""Procedural botanical growth, trees and ivy"""

import scratchbox_native.geometry
import scratchbox_native.math


class SpaceColonizationConfig:
    def __init__(self) -> None: ...

    @property
    def attractor_count(self) -> int: ...

    @attractor_count.setter
    def attractor_count(self, arg: int, /) -> None: ...

    @property
    def crown_center(self) -> scratchbox_native.math.Vec3: ...

    @crown_center.setter
    def crown_center(self, arg: scratchbox_native.math.Vec3, /) -> None: ...

    @property
    def crown_extents(self) -> scratchbox_native.math.Vec3: ...

    @crown_extents.setter
    def crown_extents(self, arg: scratchbox_native.math.Vec3, /) -> None: ...

    @property
    def perception_radius(self) -> float: ...

    @perception_radius.setter
    def perception_radius(self, arg: float, /) -> None: ...

    @property
    def kill_radius(self) -> float: ...

    @kill_radius.setter
    def kill_radius(self, arg: float, /) -> None: ...

    @property
    def branch_step_length(self) -> float: ...

    @branch_step_length.setter
    def branch_step_length(self, arg: float, /) -> None: ...

    @property
    def base_radius(self) -> float: ...

    @base_radius.setter
    def base_radius(self, arg: float, /) -> None: ...

    @property
    def tip_radius(self) -> float: ...

    @tip_radius.setter
    def tip_radius(self, arg: float, /) -> None: ...

    @property
    def da_vinci_exponent(self) -> float: ...

    @da_vinci_exponent.setter
    def da_vinci_exponent(self, arg: float, /) -> None: ...

    @property
    def generate_leaves(self) -> bool: ...

    @generate_leaves.setter
    def generate_leaves(self, arg: bool, /) -> None: ...

def generate_tree(config: SpaceColonizationConfig) -> scratchbox_native.geometry.Mesh:
    """Generate a realistic botanical tree using Runions space colonization"""

class IvyConfig:
    def __init__(self) -> None: ...

    @property
    def root_position(self) -> scratchbox_native.math.Vec3: ...

    @root_position.setter
    def root_position(self, arg: scratchbox_native.math.Vec3, /) -> None: ...

    @property
    def obstacle_min(self) -> scratchbox_native.math.Vec3: ...

    @obstacle_min.setter
    def obstacle_min(self, arg: scratchbox_native.math.Vec3, /) -> None: ...

    @property
    def obstacle_max(self) -> scratchbox_native.math.Vec3: ...

    @obstacle_max.setter
    def obstacle_max(self, arg: scratchbox_native.math.Vec3, /) -> None: ...

    @property
    def max_steps(self) -> int: ...

    @max_steps.setter
    def max_steps(self, arg: int, /) -> None: ...

    @property
    def cling_distance(self) -> float: ...

    @cling_distance.setter
    def cling_distance(self, arg: float, /) -> None: ...

def generate_ivy(config: IvyConfig) -> scratchbox_native.geometry.Mesh:
    """Generate obstacle-clinging ivy vines across geometric boundaries"""
