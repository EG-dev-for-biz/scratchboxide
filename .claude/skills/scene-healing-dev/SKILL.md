---
name: scene-healing-dev
description: Developer guide for building scene-healing into Scratchbox's code (seam stage, remesh cleanup, infill, orient, outside check, LOD) — where each fix lives, what exists, what is missing, and the order to build it. Use when changing any mesh repair, cleanup or QA code; the healing method itself is the app skill .agents/skills/scene-healing/SKILL.md.
---

# Scene healing: developer guide

The method (defects, measures, bounded fixes, reporting) is in the app skill `.agents/skills/scene-healing/SKILL.md`;
read it first. This file maps it onto the codebase.

## Where each fix lives today

| Fix | Code | State |
|---|---|---|
| Vertex weld between tile pieces (3 cm, one side moves, flip guard, sliver drop) | `scratchbox_tile_seam_weld.hpp`, CLI `scripts/tile_seam_weld.cpp`, `tile-seam-weld-service.ts` | done: the seam stage on the extraction (orchestrator, `deps.tileSeams`), and again inside tile_refine |
| Display weld (1 cm, normals) | was `staged-location/weld-tiles.ts` | retired: the seam stage's clay output is what the tiles layer shows |
| T-junction close | `TileSeamWeld::closeTJunctions` (seam stage); also the rectifier's own stage | done: split into the other piece's edge, UVs interpolated, piece identity taken before the weld, one side moves per round |
| Plane / line / corner snapping | `scratchbox_scan_rectifier.hpp` via tile_refine | done |
| Hole fill (shortest-closing-edge ears, envelope guard, refused caps, covered-by-wall drop) | `pipeline-k/lattice-stitch.ts` `fillOpenLoops` | done |
| Inside-out turning | `remesh-orient.ts` | done |
| Outside check (clay, holes, smears by node, 12 views) | `pipeline-k/visible-defects.ts` | done; pipeline K only |
| Spike filter | `remesh-cleanup.ts` `spikeEdits` | built, **off by default** (`spikeK: 0`, `remesh-cleanup/3`): on the ESB it moved 180 vertices up to its 3 m cap on thin real features and stretched the photos (untextured 0.24% -> 0.35%, smears 0.09% -> 0.19%). Before turning it on: a texture-stretch guard (no move that stretches a textured triangle's mapping), a cap within the scan's error, and the outside check before and after |
| Overlap trim between pieces | `TileSeamWeld::trimOverlaps` (seam stage) | partial: drops only triangles wholly over a lower piece; most overlap strips are crossed by larger, partly covered triangles (needs a cut along the other piece's rim) |
| Step / groove blend | — | missing |
| Per-piece colour levelling across seams | `texture-harmonize.ts` (building photos only) | missing for tiles |
| Vision judge with confidence gate | — | missing |
| Provenance-weighted simplification | — | missing (no simplification stage) |

## Build order (agreed direction)
1. **One native seam stage on the extraction** (done 2026-10-28, apart from cutting partly covered overlap triangles), before any consumer: vertex weld + T-junction split + overlap trim in
   `scratchbox_tile_seam_weld.hpp`; the CLI writes the welded textured GLB and its clay; the orchestrator runs it once
   per extraction (cached beside it) and points every consumer (display, vehicles, tile_refine, ownership, survey,
   occluders) at the welded files; retire `weld-tiles.ts`.
2. **Spike filter in the remesh cleanup** (done, `remesh-cleanup.ts`): the Laplacian/MAD flag and capped λ/μ
   smoothing from the app skill §3.2, flagged vertices only.
3. **Step / groove blend and tile colour levelling**, only if the census still shows lines after step 1.
4. **Outside check per step**: baseline after the cleanup, then after each polish step, so every defect is pinned on the
   step that added it; then the whole-scene QA second to last.
5. **Vision judge** on the QA step's flagged regions (app skill §3.7).
6. **Provenance-weighted simplification** when building LOD is picked up (app skill §4).

## Rules for this code
- Native C++20 for geometry (AGENTS.md §3); continuous tolerances only; nothing keyed by object type.
- Every move bounded and reported (gap histogram, counts, max move); measured geometry stays `measured` within its
  error, fills are `generated`.
- Verify each change with the census and the outside check, before and after, on an uncached build; revert what
  raises holes, clay or smears.
- Ideas from outside projects only, never their code; nothing GPL.

## Measurements so far (Washington Square Park extraction, 524 tiles)
- Seam gaps: 3% under 1 cm, 46% 1–3 cm, 50% 3–50 cm.
- T-junctions: 50% of seam points (127,215), 31,655 within 3 cm.
- Overlaps: ~10,100 m², mostly 1–3 cm apart.
- Steps: 38% under 1 cm, 40% 1–3 cm, 21% over 3 cm.
- Grooves on flat ground seen (16 cm deep, ~1 m wide, at a fountain-basin seam).
- After the seam stage (same extraction, per tile material): gaps 0.1 mm–3 cm 119,088 → 2,472; T-junctions within 3 cm
  35,120 → 4,721; overlaps 10,911 → 10,309 m²; steps 1–3 cm 99,394 → 43,615; gaps over 3 cm unchanged (out of tolerance).
- Census script: `/private/tmp/claude-501/-Users-eligreen-dev-scratchbox-ide-master/868b8581-82ba-4cb3-bf30-b9d75c46aee2/scratchpad/seams.ts` (scratchpad; move it into the repo if it should outlive the session).
