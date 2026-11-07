"""Non-linear geometric mesh deformers and procedural shaping"""

import collections.abc
import scratchbox_native.geometry
import scratchbox_native.math
import typing

__all__ = ['Lattice3D', 'bend', 'boolean_mesh', 'bulge', 'extrude_polygon', 'kelvinlet', 'lathe', 'loft', 'replicate_along_curve', 'replicate_on_grid', 'subdivide', 'sweep', 'taper', 'twist']


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


def boolean_mesh(a: scratchbox_native.geometry.Mesh, b: scratchbox_native.geometry.Mesh, op: str) -> scratchbox_native.geometry.Mesh:
    """Boolean a and b by BSP mesh CSG: op is "union", "subtract" or "intersect" (an arch, a vault or a staircase composes from this plus extrude/lathe/sweep, instead of its own named primitive)"""


def bulge(mesh: scratchbox_native.geometry.Mesh, center: scratchbox_native.math.Vec3 = ..., radius: float = 1.0, strength: float = 0.3, power: float = 2.0) -> scratchbox_native.geometry.Mesh: ...


def extrude_polygon(footprint: collections.abc.Sequence[scratchbox_native.math.Vec2], base_y: float = 0.0, height: float = 1.0, color: scratchbox_native.math.Vec4 = ...) -> scratchbox_native.geometry.Mesh:
    """Extrude a 2D XZ polygon along +Y into a closed, capped solid (walls + top + bottom)"""


def kelvinlet(mesh: scratchbox_native.geometry.Mesh, center: scratchbox_native.math.Vec3, epsilon: float, displacement: scratchbox_native.math.Vec3 = ..., twist_deg: float = 0.0, twist_axis: scratchbox_native.math.Vec3 = ..., scale_factor: float = 1.0, pinch_strength: float = 0.0, pinch_direction: scratchbox_native.math.Vec3 = ..., pinch_secondary_direction: scratchbox_native.math.Vec3 | None = None, poisson_ratio: float = 0.5, falloff_scales: int = 1, falloff_ratio: float = 1.5, steps: int = 0, weights: collections.abc.Sequence[float] = ...) -> scratchbox_native.geometry.Mesh:
    """Kelvinlet deformation: the elastic response to a regularised point load at center with core radius epsilon (metres). Loads superpose: displacement (the load point moves by exactly this), twist_deg about twist_axis, scale_factor (needs poisson_ratio < 0.5), pinch_strength (stretch by exp(strength) along pinch_direction; negative squeezes). No falloff edge; poisson_ratio 0.5 keeps volume and bulges like clay; falloff_scales 2 or 3 confine it closer to the load point; big moves are integrated in steps so they drag instead of fold. weights: one 0..1 value per vertex (0 holds it still), or empty"""


def lathe(profile: collections.abc.Sequence[scratchbox_native.math.Vec2], radial_segments: int = 32, total_angle_rad: float = 6.283185, color: scratchbox_native.math.Vec4 = ..., cap_ends: bool = False) -> scratchbox_native.geometry.Mesh:
    """Revolve 2D profile into rotational solid; cap_ends closes an open axial hole on a full sweep"""


def loft(slices: collections.abc.Sequence[collections.abc.Sequence[scratchbox_native.math.Vec3]], close_ends: bool = True, color: scratchbox_native.math.Vec4 = ...) -> scratchbox_native.geometry.Mesh:
    """Loft skin between 3D station slices"""


def replicate_along_curve(seed: scratchbox_native.geometry.Mesh, curve: collections.abc.Sequence[scratchbox_native.math.Vec3], pitch: float, merge_distance: float = 0.0, fit_to_length: bool = True) -> scratchbox_native.geometry.Mesh:
    """Repeat seed at a continuous pitch along curve, oriented by rotation-minimizing frames (bolt circles, louvres, teeth, treads)"""


def replicate_on_grid(seed: scratchbox_native.geometry.Mesh, count_u: int, count_v: int, pitch_u: float, pitch_v: float, row_offset_u: float = 0.0, alternate_rows: bool = False, merge_distance: float = 0.0, origin: scratchbox_native.math.Vec3 = ..., axis_u: scratchbox_native.math.Vec3 = ..., axis_v: scratchbox_native.math.Vec3 = ...) -> scratchbox_native.geometry.Mesh:
    """Repeat seed over a flat U x V lattice (bolt patterns, tile fields, brick-bonded rows)"""


def subdivide(mesh: scratchbox_native.geometry.Mesh, iterations: int = 1) -> scratchbox_native.geometry.Mesh:
    """Refine mesh using Loop Subdivision"""


def sweep(curve: collections.abc.Sequence[scratchbox_native.math.Vec3], profile: collections.abc.Sequence[scratchbox_native.math.Vec2], total_twist_rad: float = 0.0, start_scale: float = 1.0, end_scale: float = 1.0, close_ends: bool = True, color: scratchbox_native.math.Vec4 = ...) -> scratchbox_native.geometry.Mesh:
    """Sweep 2D profile along a 3D carrier curve with rotation-minimizing frames (limbs, hoses, struts, coils)"""


def taper(mesh: scratchbox_native.geometry.Mesh, axis: int = 1, factor: float = 0.5) -> scratchbox_native.geometry.Mesh: ...


def twist(mesh: scratchbox_native.geometry.Mesh, axis: int = 1, angle_deg: float = 45.0) -> scratchbox_native.geometry.Mesh: ...
