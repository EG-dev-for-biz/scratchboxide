"""Massing read from a scan (sections, lofts, an extruded block) and the choice between candidates by how well each explains the scan, height by height"""

import collections.abc
import scratchbox_native.geometry
import scratchbox_native.math

__all__ = ['Agreement', 'LoftRun', 'Slice', 'TopGrid', 'agreement', 'choose', 'crop_to_plan', 'extrude_block', 'loft_runs', 'loft_solids', 'plan_outline', 'sample_surface', 'slices', 'snap_plan_to_scan']


class Agreement:
    @property
    def coverage(self) -> float: ...

    @property
    def precision(self) -> float: ...

    @property
    def f(self) -> float: ...

    @property
    def banded_coverage(self) -> float: ...

    @property
    def banded_precision(self) -> float: ...

    @property
    def banded_f(self) -> float: ...

    @property
    def worst_band_coverage(self) -> float: ...

    @property
    def bands(self) -> int: ...

    @property
    def scan_samples(self) -> int: ...

    @property
    def candidate_samples(self) -> int: ...

    @property
    def unseen_samples(self) -> int: ...

    def __repr__(self) -> str: ...


class LoftRun:
    @property
    def y0(self) -> float: ...

    @property
    def y1(self) -> float: ...

    @property
    def ring_count(self) -> int: ...

    @property
    def rings(self) -> list[tuple[float, list[tuple[float, float]]]]: ...


class Slice:
    @property
    def y0(self) -> float: ...

    @property
    def y1(self) -> float: ...

    @property
    def cell_count(self) -> int: ...


class TopGrid:
    """The scan's highest point per plan cell (for the hidden-wall test)"""
    def __init__(self) -> None: ...

    def add_mesh(self, mesh: scratchbox_native.geometry.Mesh) -> None: ...

    def at(self, x: float, z: float) -> float: ...


def agreement(scan: collections.abc.Sequence[scratchbox_native.math.Vec3], candidate: collections.abc.Sequence[scratchbox_native.math.Vec3], tau: float = 1.0, band: float = 2.0, ground_y: float | None = None, neighbours: scratchbox_native.scan_massing.TopGrid | None = None, own_plan: collections.abc.Sequence[collections.abc.Sequence[tuple[float, float]]] = ...) -> Agreement:
    """How well candidate samples explain scan samples: coverage, precision and F, overall and height-balanced; surface at street level (ground_y) or beside a taller neighbour (neighbours, off own_plan) is left out of precision"""


def choose(ordered: collections.abc.Sequence[tuple[str, int, scratchbox_native.scan_massing.Agreement]], min_coverage: float = 0.9, min_precision: float = 0.85) -> dict:
    """Candidates (label, triangles, Agreement) simplest first: the first explaining the scan wins, else the best height-balanced F"""


def crop_to_plan(mesh: scratchbox_native.geometry.Mesh, plan: collections.abc.Sequence[collections.abc.Sequence[tuple[float, float]]], margin: float = 3.0, min_y: float = -1000000000.0) -> scratchbox_native.geometry.Mesh:
    """The triangles of a scan above min_y and within margin of the plan rings (x, z)"""


def extrude_block(ring: collections.abc.Sequence[tuple[float, float]], y0: float, y1: float) -> scratchbox_native.geometry.Mesh:
    """A footprint ring (x, z) extruded from y0 to y1"""


def loft_runs(slices: collections.abc.Sequence[scratchbox_native.scan_massing.Slice], cell: float = 0.5, link_iou: float = 0.35, ring_points: int = 48, keep_tol: float = 0.4, min_piece: float = 0.5) -> list[LoftRun]:
    """Each slice's pieces followed upward (overlap or nearness, mutual best), their outlines resampled and thinned"""


def loft_solids(runs: collections.abc.Sequence[scratchbox_native.scan_massing.LoftRun]) -> scratchbox_native.geometry.Mesh:
    """The runs skinned into closed solids (Loft3D), one mesh"""


def plan_outline(slices: collections.abc.Sequence[scratchbox_native.scan_massing.Slice], cell: float = 0.5) -> list[tuple[float, float]]:
    """The outline (x, z) of the largest piece of all slices together: the scan's plan"""


def sample_surface(mesh: scratchbox_native.geometry.Mesh, spacing: float = 0.5) -> list[scratchbox_native.math.Vec3]:
    """Evenly spaced points on a mesh's surface (about one per spacing^2)"""


def slices(samples: collections.abc.Sequence[scratchbox_native.math.Vec3], base_y: float, slice: float = 1.0, cell: float = 0.5, close: float = 1.0) -> list[Slice]:
    """The scan cut into horizontal slices, each slice's plan filled"""


def snap_plan_to_scan(ring: collections.abc.Sequence[tuple[float, float]], samples: collections.abc.Sequence[scratchbox_native.math.Vec3], ground_y: float, top_y: float, search: float = 3.0) -> tuple[list[tuple[float, float]], list[tuple[float, int, bool]]]:
    """The footprint ring (x, z) with each edge moved along its normal onto the scan's wall; returns (ring, [(shift m, support, moved)] per edge)"""
