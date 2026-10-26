"""Hard-surface mesh operations: booleans, bevel, inset/extrude, solidify (closed in, closed out)"""

import collections.abc
import scratchbox_native.geometry

__all__ = ['bevel', 'inset_extrude', 'intersect', 'solidify', 'subtract', 'union']


def bevel(mesh: scratchbox_native.geometry.Mesh, width: float, segments: int = 1, sharp_angle_deg: float = 30.0, smooth_angle_deg: float = 30.0, name: str = 'Beveled') -> scratchbox_native.geometry.Mesh:
    """Bevel edges sharper than sharp_angle_deg on a closed mesh: segments 1 = chamfer, more = rounded. Width is capped per vertex at 45% of its shortest edge so faces never invert"""


def inset_extrude(mesh: scratchbox_native.geometry.Mesh, facing: collections.abc.Sequence[float], max_angle_deg: float = 10.0, inset: float = 0.0, depth: float = 0.0, box_min: collections.abc.Sequence[float] | None = None, box_max: collections.abc.Sequence[float] | None = None, smooth_angle_deg: float = 30.0, name: str = 'InsetExtruded') -> scratchbox_native.geometry.Mesh:
    """Faces within max_angle_deg of `facing` (and with centroids inside box_min..box_max when given) form regions; each region's border is inset by `inset` within its plane and the region moved by `depth` along its normal (negative depth recesses it: panels, pockets, plinths, raised bosses)"""


def intersect(a: scratchbox_native.geometry.Mesh, b: scratchbox_native.geometry.Mesh, smooth_angle_deg: float = 30.0, name: str = 'Intersect', require_closed: bool = True) -> scratchbox_native.geometry.Mesh:
    """Exact overlap of two closed meshes; result is closed"""


def solidify(mesh: scratchbox_native.geometry.Mesh, thickness: float, smooth_angle_deg: float = 30.0, name: str = 'Solidified') -> scratchbox_native.geometry.Mesh:
    """Give a surface thickness: an inner copy offset by `thickness` against its normals, joined along open edges"""


def subtract(a: scratchbox_native.geometry.Mesh, b: scratchbox_native.geometry.Mesh, smooth_angle_deg: float = 30.0, name: str = 'Subtract', require_closed: bool = True) -> scratchbox_native.geometry.Mesh:
    """Exact a minus b (cut openings, bores, recesses); result is closed"""


def union(a: scratchbox_native.geometry.Mesh, b: scratchbox_native.geometry.Mesh, smooth_angle_deg: float = 30.0, name: str = 'Union', require_closed: bool = True) -> scratchbox_native.geometry.Mesh:
    """Exact union of two closed meshes; result is closed and keeps a's material"""
