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

import json
import os
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

    @staticmethod
    def _merged(path: str):
        meshes = read_glb(path)
        if not meshes:
            raise ValueError(f"{path} holds no mesh")
        out = meshes[0]
        for m in meshes[1:]:
            out.append(m)
        return out

    @classmethod
    def load(cls, path: str, plan: Optional[List[Ring]] = None, ground_y: Optional[float] = None, district: Optional[str] = None,
             crop_margin: Optional[float] = None, spacing: float = 0.5) -> "Scan":
        """The scan in `path` (a GLB). It should be the structure alone (an isolated scan): every candidate is judged
        against all of it. `district` (a GLB of the surroundings) lets walls pressed against a taller neighbour go
        unjudged. `crop_margin`, for a scan of a whole area, keeps only what stands within that many metres of `plan`
        (neighbours inside the margin then count against every candidate: prefer an isolated scan)."""
        _require()
        mesh = cls._merged(path)
        if crop_margin is not None and plan:
            lo = ground_y + 1.0 if ground_y is not None else -1e9
            mesh = _sm.crop_to_plan(mesh, [list(r) for r in plan], crop_margin, lo)
            if not mesh.indices:
                raise ValueError("no part of the scan stands within the margin of the plan")
        return cls(mesh, plan, ground_y, spacing, cls._merged(district) if district else None)

    @classmethod
    def from_scene(cls, spacing: float = 0.5) -> "Scan":
        """The open staged scene's structure scan: SCAN_GLB_PATH (the isolated scan), SCAN_PLAN (its footprint rings,
        JSON), SCAN_GROUND_Y (street level) and SCAN_DISTRICT_GLB_PATH (the surroundings), set by the tool when the scene
        on the canvas is a staged build."""
        path = os.environ.get("SCAN_GLB_PATH")
        if not path:
            raise RuntimeError("no structure scan: open a staged 3D Building scene first (SCAN_GLB_PATH is not set)")
        plan = json.loads(os.environ.get("SCAN_PLAN", "[]")) or None
        ground = os.environ.get("SCAN_GROUND_Y")
        return cls.load(path, plan=[[tuple(p) for p in r] for r in plan] if plan else None, ground_y=float(ground) if ground else None,
                        district=os.environ.get("SCAN_DISTRICT_GLB_PATH"), spacing=spacing)

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

    def roof_objects(self, photo: Optional[str] = None, photo_frame: Optional[dict] = None, min_rise: float = 0.6) -> dict:
        """The objects standing on the roof (tanks, bulkheads, plant, anything): found where the scan stands above the roof
        plane, their edges sharpened by the photo straight down when there is one, each fitted by the simplest of its
        outline raised, a solid of revolution and its own lofted sections. `photo` is a PNG straight down and
        `photo_frame` its {"x0", "z0", "texel"} in the scan's frame; by default the scene's (SCAN_ROOF_PHOTO_PATH,
        SCAN_ROOF_PHOTO_FRAME). Returns {"roof_y", "objects": [{"outline", "top_y", "chosen", "why", "mesh", ...}], ...}."""
        photo = photo or os.environ.get("SCAN_ROOF_PHOTO_PATH")
        frame = photo_frame or (json.loads(os.environ["SCAN_ROOF_PHOTO_FRAME"]) if os.environ.get("SCAN_ROOF_PHOTO_FRAME") else None)
        ring = self.snapped_plan()
        kwargs = {}
        if photo and frame:
            from PIL import Image
            im = Image.open(photo).convert("RGBA")
            kwargs = dict(photo_rgba=im.tobytes(), photo_width=im.width, photo_height=im.height, photo_x0=float(frame["x0"]), photo_z0=float(frame["z0"]), photo_texel=float(frame["texel"]))
        return _sm.roof_objects(self.samples, list(ring), self.roof_y(), min_rise=min_rise, **kwargs)

    def snapped_plan(self) -> List[Tuple[float, float]]:
        """The footprint with each edge moved onto the scan's wall (the scan's own plan without a footprint)."""
        if not self.plan:
            return _sm.plan_outline(self.slices(), 0.5)
        ring, _ = _sm.snap_plan_to_scan(list(self.plan[0]), self.samples, self.ground_y, self.roof_y(), 3.0)
        return ring

    def block_with_roof_objects(self, photo: Optional[str] = None, photo_frame: Optional[dict] = None) -> Candidate:
        """The block, and every object fitted on its roof, as one candidate (the roof objects in report `roof`)."""
        block = self.block()
        roof = self.roof_objects(photo, photo_frame)
        mesh = block.mesh
        for o in roof["objects"]:
            if o["mesh"] is not None and o["mesh"].indices:
                mesh.append(o["mesh"])
        c = Candidate("block + roof objects", mesh)
        c.roof = roof
        return c

    def candidates(self) -> List[Candidate]:
        """The built-in candidates, simplest first."""
        return [self.block(), self.block_with_roof_objects(), self.lofted_sections()]


def choose(scan: Scan, candidates: Optional[List[Candidate]] = None, min_coverage: float = 0.9, min_precision: float = 0.85) -> Choice:
    """Score `candidates` (default: scan.candidates(), simplest first) and take the first that explains the scan."""
    _require()
    cands = candidates if candidates is not None else scan.candidates()
    for c in cands:
        if c.agreement is None:
            scan.score(c)
    result = _sm.choose([(c.label, c.triangles, c.agreement) for c in cands], min_coverage, min_precision)
    return Choice(result, cands)
