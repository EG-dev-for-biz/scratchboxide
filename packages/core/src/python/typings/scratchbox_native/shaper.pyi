"""Non-linear geometric mesh deformers and procedural shaping"""

import collections.abc
import scratchbox_native.geometry
import scratchbox_native.math
import typing

__all__ = ['Lattice3D', 'bend', 'bulge', 'lathe', 'loft', 'subdivide', 'taper', 'twist']


class Lattice3D:
    @typing.overload
    def __init__(self) -> None: ...

    @typing.overload
    def __init__(self, dim_x: int, dim_y: int, dim_z: int, bounds: scratchbox_native.math.AABB) -> None: ...

    @property
    def dim_x(self) -> int: ...
    @dim_x.setter
    def dim_x(self, value: int) -> None: ...

    @property
    def dim_y(self) -> int: ...
    @dim_y.setter
    def dim_y(self, value: int) -> None: ...

    @property
    def dim_z(self) -> int: ...
    @dim_z.setter
    def dim_z(self, value: int) -> None: ...

    @property
    def rest_bounds(self) -> scratchbox_native.math.AABB: ...
    @rest_bounds.setter
    def rest_bounds(self, value: scratchbox_native.math.AABB) -> None: ...

    def get_control_point(self, i: int, j: int, k: int) -> scratchbox_native.math.Vec3: ...

    def set_control_point(self, i: int, j: int, k: int, pos: scratchbox_native.math.Vec3) -> None: ...

    def offset_control_point(self, i: int, j: int, k: int, delta: scratchbox_native.math.Vec3) -> None: ...

    def deform(self, mesh: scratchbox_native.geometry.Mesh) -> scratchbox_native.geometry.Mesh:
        """Deforms mesh vertices using trivariate Bernstein tensor product evaluation"""


def bend(mesh: scratchbox_native.geometry.Mesh, main_axis: int = 1, bend_axis: int = 0, angle_deg: float = 30.0, radius: float = 2.0) -> scratchbox_native.geometry.Mesh: ...


def bulge(mesh: scratchbox_native.geometry.Mesh, center: scratchbox_native.math.Vec3 = ..., radius: float = 1.0, strength: float = 0.3, power: float = 2.0) -> scratchbox_native.geometry.Mesh: ...


def lathe(profile: collections.abc.Sequence[scratchbox_native.math.Vec2], radial_segments: int = 32, total_angle_rad: float = 6.283185, color: scratchbox_native.math.Vec4 = ...) -> scratchbox_native.geometry.Mesh:
    """Revolve 2D profile into rotational solid"""


def loft(slices: collections.abc.Sequence[collections.abc.Sequence[scratchbox_native.math.Vec3]], close_ends: bool = True, color: scratchbox_native.math.Vec4 = ...) -> scratchbox_native.geometry.Mesh:
    """Loft skin between 3D station slices"""


def subdivide(mesh: scratchbox_native.geometry.Mesh, iterations: int = 1) -> scratchbox_native.geometry.Mesh:
    """Refine mesh using Loop Subdivision"""


def taper(mesh: scratchbox_native.geometry.Mesh, axis: int = 1, factor: float = 0.5) -> scratchbox_native.geometry.Mesh: ...


def twist(mesh: scratchbox_native.geometry.Mesh, axis: int = 1, angle_deg: float = 45.0) -> scratchbox_native.geometry.Mesh: ...
