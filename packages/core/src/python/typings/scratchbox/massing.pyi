"""
Massing from a scan: read a structure's shape off its 3D scan and choose the simplest massing that explains it.

The scan leads. A script loads the scan of a place (a GLB in the scene's metric frame: x east, y up, z south), cuts it to
the structure, builds candidate massings from it and lets the measurements decide::

    import scratchbox as sb
    scan = sb.massing.Scan.from_scene()        # the open staged scene's isolated structure scan (SCAN_* variables)
    # or: sb.massing.Scan.load(path, plan=[[(x, z), ...]], ground_y=..., district=path) for any scan GLB
    choice = sb.massing.choose(scan)                                    # block, then lofted sections, simplest first
    print(choice.why)                                                   # each candidate's coverage and precision
    scene = sb.Scene(); scene.add_mesh(choice.mesh)

A candidate explains the scan when, height band by height band, it covers at least ``min_coverage`` of the scan and at
least ``min_precision`` of its own surface lies on the scan (surface the scan could not have seen, at street level or
pressed against a taller neighbour, is not held against it). The first candidate that explains the scan wins, so a
plain building stays a block and a tower with legs and a deck gets lofted sections that follow them. Nothing here asks
what kind of structure it is; ``Scan.candidates`` can be extended with a script's own meshes, scored the same way.
"""

import scratchbox_native.scan_massing
import typing

__all__ = ['Candidate', 'Choice', 'List', 'Optional', 'Ring', 'Scan', 'Sequence', 'Tuple', 'choose', 'json', 'os', 'read_glb']


class Candidate:
    """A massing candidate: a label, its mesh, and (once scored) its Agreement with the scan."""
    def __init__(self, label: str, mesh, agreement=None) -> None: ...

    @property
    def triangles(self) -> int: ...

    def __repr__(self) -> str: ...

    def __setattr__(self, name: str, value: typing.Any, /) -> None: ...

    label: typing.Any
    mesh: typing.Any
    agreement: typing.Any


class Choice:
    """The candidate chosen, whether it explains the scan, why, and every candidate's numbers."""
    def __init__(self, result: dict, candidates: typing.List[Candidate]) -> None: ...

    @property
    def mesh(self): ...

    def __repr__(self) -> str: ...

    def __setattr__(self, name: str, value: typing.Any, /) -> None: ...

    label: typing.Any
    explains: typing.Any
    why: typing.Any
    rows: typing.Any
    candidate: typing.Any

List = typing.List
Optional = typing.Optional
Ring = typing.Any

class Scan:
    """A structure's scan: its surface samples, the ground it stands on, and the district around it (for hidden walls)."""
    def __init__(self, mesh, plan: typing.Optional[typing.List[typing.Sequence[typing.Tuple[float, float]]]] = None, ground_y: typing.Optional[float] = None, spacing: float = 0.5, district=None) -> None: ...

    @classmethod
    def load(cls, path: str, plan: typing.Optional[typing.List[typing.Sequence[typing.Tuple[float, float]]]] = None, ground_y: typing.Optional[float] = None, district: typing.Optional[str] = None, crop_margin: typing.Optional[float] = None, spacing: float = 0.5) -> Scan:
        """
        The scan in `path` (a GLB). It should be the structure alone (an isolated scan): every candidate is judged
        against all of it. `district` (a GLB of the surroundings) lets walls pressed against a taller neighbour go
        unjudged. `crop_margin`, for a scan of a whole area, keeps only what stands within that many metres of `plan`
        (neighbours inside the margin then count against every candidate: prefer an isolated scan).
        """

    @classmethod
    def from_scene(cls, spacing: float = 0.5) -> Scan:
        """
        The open staged scene's structure scan: SCAN_GLB_PATH (the isolated scan), SCAN_PLAN (its footprint rings,
        JSON), SCAN_GROUND_Y (street level) and SCAN_DISTRICT_GLB_PATH (the surroundings), set by the tool when the scene
        on the canvas is a staged build.
        """

    def slices(self, cell: float = 0.5, slice_height: float = 1.0) -> list[scratchbox_native.scan_massing.Slice]:
        """The scan cut into horizontal slices, each slice's plan filled (cached for the default cell and height)."""

    def top(self) -> float:
        """The scan's highest point (a mast, a spire, rooftop plant included)."""

    def roof_y(self, cell: float = 1.0) -> float:
        """
        The roof height: the median, over the plan's cells (the whole scan's without a plan), of each cell's highest
        sample. Parapets, cornices and rooftop plant do not lift it the way the highest point does.
        """

    def score(self, candidate: Candidate, tau: float = 1.0) -> Candidate:
        """Measure a candidate against the scan (height-balanced coverage and precision); returns the candidate."""

    def block(self) -> Candidate:
        """
        The plan extruded from the ground to the scan's top, each of its edges first moved onto the scan's wall
        (the map gives the footprint's shape, the scan where its walls stand); without a plan, the scan's own plan.
        """

    def lofted_sections(self, link_iou: float = 0.35, keep_tol: float = 0.4, min_piece: float = 0.5) -> Candidate:
        """Each slice's pieces followed upward and skinned: tapers, legs and overhangs as the scan has them."""

    def roof_objects(self, photo: typing.Optional[str] = None, photo_frame: typing.Optional[dict] = None, min_rise: float = 0.6) -> dict:
        """
        The objects standing on the roof (tanks, bulkheads, plant, anything): found where the scan stands above the roof
        plane, their edges sharpened by the photo straight down when there is one, each fitted by the simplest of its
        outline raised, a solid of revolution and its own lofted sections. `photo` is a PNG straight down and
        `photo_frame` its {"x0", "z0", "texel"} in the scan's frame; by default the scene's (SCAN_ROOF_PHOTO_PATH,
        SCAN_ROOF_PHOTO_FRAME). Returns {"roof_y", "objects": [{"outline", "top_y", "chosen", "why", "mesh", ...}], ...}.
        """

    def snapped_plan(self) -> typing.List[typing.Tuple[float, float]]:
        """The footprint with each edge moved onto the scan's wall (the scan's own plan without a footprint)."""

    def block_with_roof_objects(self, photo: typing.Optional[str] = None, photo_frame: typing.Optional[dict] = None) -> Candidate:
        """The block, and every object fitted on its roof, as one candidate (the roof objects in report `roof`)."""

    def candidates(self) -> typing.List[Candidate]:
        """The built-in candidates, simplest first."""

    def __setattr__(self, name: str, value: typing.Any, /) -> None: ...

    mesh: typing.Any
    plan: typing.Any
    samples: typing.Any
    ground_y: typing.Any
    spacing: typing.Any
    neighbours: typing.Any
    block_edges: typing.Any

Sequence = typing.Sequence
Tuple = typing.Tuple

def choose(scan: Scan, candidates: typing.Optional[typing.List[Candidate]] = None, min_coverage: float = 0.9, min_precision: float = 0.85) -> Choice:
    """Score `candidates` (default: scan.candidates(), simplest first) and take the first that explains the scan."""

import json
import os

def read_glb(path: str, max_triangles: typing.Optional[int] = None) -> list:
    """
    The meshes of the GLB at ``path``, in world space (see the module docstring). ``max_triangles`` stops reading once
    that many triangles are read (a very large scan), with the meshes read so far.
    """
