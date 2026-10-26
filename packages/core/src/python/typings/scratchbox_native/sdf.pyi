"""Signed distance field primitives, smooth CSG booleans, and domain deformations"""

import collections.abc
import scratchbox_native.geometry
import scratchbox_native.math

__all__ = ['Field', 'box', 'capsule', 'cylinder', 'ellipsoid', 'gyroid', 'op_bend', 'op_intersection', 'op_repeat', 'op_smooth_intersection', 'op_smooth_subtraction', 'op_smooth_union', 'op_subtraction', 'op_twist', 'op_union', 'plane', 'round_box', 'sd_box', 'sd_capsule', 'sd_cylinder', 'sd_gyroid', 'sd_round_box', 'sd_sphere', 'sd_torus', 'sphere', 'to_mesh', 'torus']


class Field:
    """A signed distance field graph (negative inside). Combine with | (union), & (intersect) and - (subtract), or the methods with a blend radius k; mesh with to_mesh."""
    def __call__(self, p: collections.abc.Sequence[float]) -> float: ...

    def union(self, other: scratchbox_native.sdf.Field, k: float = 0.0) -> Field: ...

    def subtract(self, other: scratchbox_native.sdf.Field, k: float = 0.0) -> Field: ...

    def intersect(self, other: scratchbox_native.sdf.Field, k: float = 0.0) -> Field: ...

    def __or__(self, arg: scratchbox_native.sdf.Field, /) -> Field: ...

    def __and__(self, arg: scratchbox_native.sdf.Field, /) -> Field: ...

    def __sub__(self, arg: scratchbox_native.sdf.Field, /) -> Field: ...

    def translate(self, offset: collections.abc.Sequence[float]) -> Field: ...

    def rotate(self, axis: collections.abc.Sequence[float], degrees: float) -> Field: ...

    def scale(self, factor: float) -> Field: ...

    def round(self, radius: float) -> Field: ...

    def shell(self, thickness: float) -> Field: ...

    def displace(self, amplitude: float, frequency: float, seed: int = 7) -> Field: ...

    def twist(self, radians_per_unit: float) -> Field: ...

    def bend(self, radians_per_unit: float) -> Field: ...

    def repeat(self, period: collections.abc.Sequence[float]) -> Field:
        """Repeat along each axis with a positive period (0 leaves that axis alone)"""

    def mirror(self, normal: collections.abc.Sequence[float]) -> Field:
        """Mirror the half-space the normal points into across the plane through the origin"""

    def to_mesh(self, bounds_min: collections.abc.Sequence[float], bounds_max: collections.abc.Sequence[float], resolution: int = 128, projection_steps: int = 2, name: str = 'SdfMesh') -> scratchbox_native.geometry.Mesh:
        """Closed mesh of the surface inside the bounds (cubic cells, `resolution` along the longest side)"""


def box(size: collections.abc.Sequence[float]) -> Field:
    """A box of full size (w, h, d)"""


def capsule(a: collections.abc.Sequence[float], b: collections.abc.Sequence[float], radius: float) -> Field: ...


def cylinder(radius: float, height: float) -> Field:
    """A capped cylinder along +Y of full height"""


def ellipsoid(radii: collections.abc.Sequence[float]) -> Field: ...


def gyroid(scale: float = 1.0, thickness: float = 0.1) -> Field: ...


def op_bend(p: scratchbox_native.math.Vec3, k: float) -> scratchbox_native.math.Vec3: ...


def op_intersection(d1: float, d2: float) -> float: ...


def op_repeat(p: scratchbox_native.math.Vec3, c: scratchbox_native.math.Vec3) -> scratchbox_native.math.Vec3: ...


def op_smooth_intersection(d1: float, d2: float, k: float = 0.2) -> float: ...


def op_smooth_subtraction(d1: float, d2: float, k: float = 0.2) -> float: ...


def op_smooth_union(d1: float, d2: float, k: float = 0.2) -> float: ...


def op_subtraction(d1: float, d2: float) -> float: ...


def op_twist(p: scratchbox_native.math.Vec3, k: float) -> scratchbox_native.math.Vec3: ...


def op_union(d1: float, d2: float) -> float: ...


def plane(normal: collections.abc.Sequence[float], offset: float = 0.0) -> Field:
    """Half-space below the plane dot(p, normal) = offset"""


def round_box(size: collections.abc.Sequence[float], radius: float) -> Field: ...


def sd_box(p: scratchbox_native.math.Vec3, b: scratchbox_native.math.Vec3) -> float: ...


def sd_capsule(p: scratchbox_native.math.Vec3, a: scratchbox_native.math.Vec3, b: scratchbox_native.math.Vec3, radius: float) -> float: ...


def sd_cylinder(p: scratchbox_native.math.Vec3, radius: float, height: float) -> float: ...


def sd_gyroid(p: scratchbox_native.math.Vec3, scale: float = 1.0, thickness: float = 0.1) -> float: ...


def sd_round_box(p: scratchbox_native.math.Vec3, b: scratchbox_native.math.Vec3, r: float) -> float: ...


def sd_sphere(p: scratchbox_native.math.Vec3, radius: float) -> float: ...


def sd_torus(p: scratchbox_native.math.Vec3, major_radius: float, minor_radius: float) -> float: ...


def sphere(radius: float) -> Field: ...


def to_mesh(field: scratchbox_native.sdf.Field, bounds_min: collections.abc.Sequence[float], bounds_max: collections.abc.Sequence[float], resolution: int = 128, projection_steps: int = 2, name: str = 'SdfMesh') -> scratchbox_native.geometry.Mesh: ...


def torus(major_radius: float, minor_radius: float) -> Field:
    """A torus around +Y"""
