"""Isoparametric normal relief: designed height fields (profiles along curves, periodic ridges, projected images) displaced along normals after adaptive subdivision"""

import collections.abc
import scratchbox_native.geometry

__all__ = ['Layer', 'apply', 'helix_ridges', 'image', 'profile', 'ridges']


class Layer:
    """One relief layer; chain .limit_box / .facing / .strength to mask it"""
    def limit_box(self, box_min: collections.abc.Sequence[float], box_max: collections.abc.Sequence[float], feather_m: float = 0.0) -> Layer:
        """Only inside this box, fading over feather_m at its faces"""

    def facing(self, direction: collections.abc.Sequence[float], max_angle_deg: float = 45.0, soft_deg: float = 15.0) -> Layer:
        """Only on surfaces within max_angle_deg of direction, fading over soft_deg"""

    def strength(self, factor: float) -> Layer: ...


def apply(mesh: scratchbox_native.geometry.Mesh, layers: collections.abc.Sequence[scratchbox_native.relief.Layer], target_edge_m: float = 0.0, max_subdivisions: int = 6, samples_per_detail: float = 3.0, smooth_angle_deg: float = 30.0, name: str = 'Relief') -> scratchbox_native.geometry.Mesh:
    """Subdivide where the layers reach (conformally, until edges resolve the finest detail) and displace along smooth normals"""


def helix_ridges(origin: collections.abc.Sequence[float], axis: collections.abc.Sequence[float], radius_m: float, pitch_m: float, depth_m: float, helix_deg: float = 30.0, sharpness: float = 0.6, duty: float = 0.5) -> Layer:
    """Ridges around an axis (a whole number per turn at radius_m, pitch_m rounded to fit): straight flutes at helix_deg 0, a crossing knurl at helix_deg > 0 (depth_m < 0 for grooves)"""


def image(png: bytes, centre: collections.abc.Sequence[float], normal: collections.abc.Sequence[float], up: collections.abc.Sequence[float], width_m: float, height_m: float, depth_m: float, tiles_u: float = 1.0, tiles_v: float = 1.0, projection_depth_m: float = 0.5) -> Layer:
    """A height image (luminance x alpha, white = full depth_m) projected onto the surface like a decal, tiled tiles_u x tiles_v times"""


def profile(carriers: collections.abc.Sequence[collections.abc.Sequence[collections.abc.Sequence[float]]], width_m: float, depth_m: float, sharpness: float = 0.3, flat_top: float = 0.0) -> Layer:
    """A cross-section swept along polylines (lists of points): depth_m < 0 cuts a groove or shut line, > 0 raises a bead or rib; width_m is the half-width, sharpness 0 round .. 1 V, flat_top the fraction of the width at full height"""


def ridges(origin: collections.abc.Sequence[float], direction: collections.abc.Sequence[float], pitch_m: float, depth_m: float, sharpness: float = 0.6, duty: float = 0.5, second_direction: collections.abc.Sequence[float] | None = None) -> Layer:
    """Periodic ridges of pitch_m along direction (depth_m < 0 for grooves); a second_direction multiplies in a crossing set (knurling, waffle)"""
