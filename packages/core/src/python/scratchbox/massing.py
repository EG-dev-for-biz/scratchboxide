# ********************************************************************************
# Copyright (C) 2026 Scratchbox LLC. All rights reserved.
#
# This software and associated documentation files are proprietary and confidential
# to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
# of this file, via any medium, is strictly prohibited without explicit written
# permission from Scratchbox LLC.
# ********************************************************************************
"""Massing from a scan: read a structure's shape off its 3D scan and choose the simplest massing that explains it.

The scan leads. A script loads the scan of a place (a GLB in the scene's metric frame: x east, y up, z south), cuts it to
the structure, builds candidate massings from it and lets the measurements decide::

    import scratchbox as sb
    scan = sb.massing.Scan.load(SCAN_GLB_PATH, plan=[[(x, z), ...]])   # plan: the footprint ring(s), when known
    choice = sb.massing.choose(scan)                                    # block, then lofted sections, simplest first
    print(choice.why)                                                   # each candidate's coverage and precision
    scene = sb.Scene(); scene.add_mesh(choice.mesh)

A candidate explains the scan when, height band by height band, it covers at least ``min_coverage`` of the scan and at
least ``min_precision`` of its own surface lies on the scan (surface the scan could not have seen, at street level or
pressed against a taller neighbour, is not held against it). The first candidate that explains the scan wins, so a
plain building stays a block and a tower with legs and a deck gets lofted sections that follow them. Nothing here asks
what kind of structure it is; ``Scan.candidates`` can be extended with a script's own meshes, scored the same way.
"""

from typing import List, Optional, Sequence, Tuple

from .glb_read import read_glb

try:
    import scratchbox_native as _native
    _sm = _native.scan_massing
except Exception:  # the engine module is built on first use by the runner
    _native = None
    _sm = None

Ring = Sequence[Tuple[float, float]]


def _require():
    if _sm is None:
        raise RuntimeError("scratchbox.massing needs the native engine module (scratchbox_native.scan_massing)")


class Candidate:
    """A massing candidate: a label, its mesh, and (once scored) its Agreement with the scan."""

    def __init__(self, label: str, mesh, agreement=None):
        self.label = label
        self.mesh = mesh
        self.agreement = agreement

    @property
    def triangles(self) -> int:
        return len(self.mesh.indices) // 3

    def __repr__(self) -> str:
        return f"Candidate({self.label!r}, {self.triangles} triangles, {self.agreement!r})"


class Choice:
    """The candidate chosen, whether it explains the scan, why, and every candidate's numbers."""

    def __init__(self, result: dict, candidates: List[Candidate]):
        self.label: Optional[str] = result["chosen"]
        self.explains: bool = result["explains"]
        self.why: str = result["why"]
        self.rows: List[dict] = list(result["candidates"])
        self.candidate: Optional[Candidate] = candidates[result["index"]] if result["index"] >= 0 else None

    @property
    def mesh(self):
        return self.candidate.mesh if self.candidate else None

    def __repr__(self) -> str:
        return f"Choice({self.label!r}, explains={self.explains})"


class Scan:
    """A structure's scan: its surface samples, the ground it stands on, and the district around it (for hidden walls)."""

    def __init__(self, mesh, plan: Optional[List[Ring]] = None, ground_y: Optional[float] = None, spacing: float = 0.5, district=None):
        _require()
        self.mesh = mesh
        self.plan = [list(r) for r in plan] if plan else []
        self.samples = _sm.sample_surface(mesh, spacing)
        if not self.samples:
            raise ValueError("the scan has no surface to sample")
        self.ground_y = ground_y if ground_y is not None else min(p.y for p in self.samples)
        self.spacing = spacing
        self.neighbours = None
        if district is not None:
            self.neighbours = _sm.TopGrid()
            self.neighbours.add_mesh(district)
        self._slices = None

    @classmethod
    def load(cls, path: str, plan: Optional[List[Ring]] = None, margin: float = 3.0, ground_y: Optional[float] = None, spacing: float = 0.5) -> "Scan":
        """The scan in `path` (a GLB), cut to within `margin` m of `plan` when a plan is given (its district kept for the hidden-wall test)."""
        _require()
        meshes = read_glb(path)
        if not meshes:
            raise ValueError(f"{path} holds no mesh")
        district = meshes[0]
        for m in meshes[1:]:
            district.append(m)
        if not plan:
            return cls(district, None, ground_y, spacing)
        lo = ground_y if ground_y is not None else -1e9
        crop = _sm.crop_to_plan(district, [list(r) for r in plan], margin, lo + 1.0 if ground_y is not None else lo)
        if not crop.indices:
            raise ValueError("no part of the scan stands within the margin of the plan")
        return cls(crop, plan, ground_y, spacing, district)

    def slices(self, cell: float = 0.5, slice_height: float = 1.0):
        """The scan cut into horizontal slices, each slice's plan filled (cached for the default cell and height)."""
        if cell == 0.5 and slice_height == 1.0 and self._slices is not None:
            return self._slices
        sl = _sm.slices(self.samples, self.ground_y, slice_height, cell, 1.0)
        if cell == 0.5 and slice_height == 1.0:
            self._slices = sl
        return sl

    def top(self) -> float:
        """The scan's highest point (a mast, a spire, rooftop plant included)."""
        return max(p.y for p in self.samples)

    def roof_y(self, cell: float = 1.0) -> float:
        """The roof height: the median, over the plan's cells (the whole scan's without a plan), of each cell's highest
        sample. Parapets, cornices and rooftop plant do not lift it the way the highest point does."""
        tops = {}
        rings = self.plan
        def inside(x, z):
            if not rings:
                return True
            for ring in rings:
                c = False
                j = len(ring) - 1
                for i in range(len(ring)):
                    (xi, zi), (xj, zj) = ring[i], ring[j]
                    if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi) + xi:
                        c = not c
                    j = i
                if c:
                    return True
            return False
        for p in self.samples:
            k = (int(p.x // cell), int(p.z // cell))
            if p.y > tops.get(k, -1e18) and inside(p.x, p.z):
                tops[k] = p.y
        if not tops:
            return self.top()
        v = sorted(tops.values())
        return v[len(v) // 2]

    def score(self, candidate: Candidate, tau: float = 1.0) -> Candidate:
        """Measure a candidate against the scan (height-balanced coverage and precision); returns the candidate."""
        cand = _sm.sample_surface(candidate.mesh, self.spacing)
        candidate.agreement = _sm.agreement(self.samples, cand, tau, 2.0, self.ground_y, self.neighbours, self.plan if self.neighbours is not None else [])
        return candidate

    def block(self) -> Candidate:
        """The plan extruded from the ground to the scan's top, each of its edges first moved onto the scan's wall
        (the map gives the footprint's shape, the scan where its walls stand); without a plan, the scan's own plan."""
        if self.plan:
            ring, edges = _sm.snap_plan_to_scan(list(self.plan[0]), self.samples, self.ground_y, self.roof_y(), 3.0)
            self.block_edges = edges
        else:
            ring = _sm.plan_outline(self.slices(), 0.5)
        return Candidate("block", _sm.extrude_block(list(ring), self.ground_y, self.roof_y()))

    def lofted_sections(self, link_iou: float = 0.35, keep_tol: float = 0.4, min_piece: float = 0.5) -> Candidate:
        """Each slice's pieces followed upward and skinned: tapers, legs and overhangs as the scan has them."""
        runs = _sm.loft_runs(self.slices(), 0.5, link_iou, 48, keep_tol, min_piece)
        return Candidate("lofted sections", _sm.loft_solids(runs))

    def candidates(self) -> List[Candidate]:
        """The built-in candidates, simplest first."""
        return [self.block(), self.lofted_sections()]


def choose(scan: Scan, candidates: Optional[List[Candidate]] = None, min_coverage: float = 0.9, min_precision: float = 0.85) -> Choice:
    """Score `candidates` (default: scan.candidates(), simplest first) and take the first that explains the scan."""
    _require()
    cands = candidates if candidates is not None else scan.candidates()
    for c in cands:
        if c.agreement is None:
            scan.score(c)
    result = _sm.choose([(c.label, c.triangles, c.agreement) for c in cands], min_coverage, min_precision)
    return Choice(result, cands)
