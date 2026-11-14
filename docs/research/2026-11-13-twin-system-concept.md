# The twin system: concept

Date: 2026-11-13. Status: explanation, not a plan. The measured twin is PR #189 (`feat/measured-procedural-twin`), open and
not on main; pipeline K's texture twin is on main.

## The idea in one paragraph

A scan of a real building (Google's photogrammetry) is accurate in where things are and poor in how they look up close:
walls bulge, edges melt, windows smear, and the photo is baked onto a lumpy surface. A **twin** is a second model of the
same building, in the same place and frame, that is clean where the scan is rough. The scan stays the source of truth
for position and size; the twin is what is shown. Every part of a twin says where it came from (`measured`,
`vector-modelled`, `photo-inferred` or `generated`), so nothing inferred is ever presented as measured.

## "Twin" means two things in this codebase

| Name | What it is | Geometry | Where |
|---|---|---|---|
| **Texture twin** (pipeline K's `twin.glb`) | the rebuilt scan with its photos corrected | the scan's own triangles, straightened and rebuilt by K | `tile-refine-twin.ts`, pipeline K's texture stage; on main |
| **Measured procedural twin** | a new building generated from measurements of the scan | none of the scan's surface: every surface is a new procedural element | `measured-twin/`, `scratchbox_measured_twin.hpp`; PR #189 |

They answer different needs. The texture twin keeps every measured bump and fixes the colour. The procedural twin throws
the bumps away and redraws the building from what was measured about it.

## 1. The texture twin (pipeline K)

A staged building opens in clay first, then crossfades to its textured twin when the textures are ready. The twin is the
same triangles as the clay model, each carrying the tile photo that saw it, with the photos corrected:

- de-lit (the capture's light lifted out, so the app's own sun can light it);
- cast shadows on roofs and terraces lifted by a sun fitted from the mesh;
- harmonised (one gain per photo, seams levelled where photos overlap);
- material regions drawn over it (roughness, metalness, normal relief per appearance class), the photo kept as the colour.

Nothing is re-projected or invented in the geometry. This is the twin the whole-building material map reads, because its
light has already been removed.

## 2. The measured procedural twin

### What it is made from

The generator is native C++ (`scratchbox_measured_twin.hpp`, driven by `scripts/measured_twin.cpp`) and takes a plain
line spec. It builds each part from a measurement, using the four geometric operators (sweeps, solids of revolution,
replicators, relief fields) and no named building parts:

| Part | Made from | Label |
|---|---|---|
| Massing | the tree-free scan's height map split into setback tiers; each tier a prism of its squared outline, with a flat roof cap | measured |
| Slender top (a mast, a spire) | one fitted vertical axis; each 1 m slice's radius read in sectors, smoothed, and cut into tapered steps | measured |
| Fins, ledges, parapets, roof objects | the scan's sections stacked along each wall or around the axis; what stands clearly proud is redrawn as blocks or swept profiles | measured |
| Windows | each window box mapped through its wall photo's frame onto the prism wall, punched through, recessed by the reveal depth, closed by glass and frame | photo-inferred (generated where a reading was continued over a hole) |
| Reveal depth | read from Street View when a trustworthy reading exists, else a plausible 0.12 m | photo-inferred or generated |
| Colour | each element takes the median of the scan's own photo over it | photo-inferred |
| Wall detail | each texel the median of the wall's straightened photo at that point and the storeys above and below, so the storey's real pattern stays and a one-off reflection or smear is outvoted | photo-inferred |
| Relief | a normal map; never moves the surface | generated |

### Where its inputs come from: four modes

The generator is the same in every mode. What changes is who supplies the wall photos and the window boxes.

| Mode | Inputs | Model calls |
|---|---|---|
| **From a K build** | a finished pipeline K run's records: its wall frames, straightened photos, kept window boxes, material classes | none (reuses K's) |
| **K-free** (`selfRead`) | only the cut-out scan; the generator renders each wall's photo from the scan's texture and finds windows from its own periodicity | none |
| **Inferred** (`infer`) | the K-free first pass, then: the building's window system read once by a vision model, congruent walls copied, finishes read, a Street View base band, relief | a few |
| **Hybrid** (`hybrid`) | pipeline K's detail stages (straightening, window fit, facade reader, window arrays, symmetry) run on the cut-out's own wall photos, without K's rebuild, polish or texture stage; then the twin's shell | about 10-16 |

The hybrid is the intended form: K's reading of the facades with the twin's clean shell, at a fraction of K's time and
calls.

## How the two twins compare with the scan

| | Raw scan | Texture twin (K) | Procedural twin |
|---|---|---|---|
| Position and size | measured | measured | measured (tiers, axis, profiles) |
| Surface | lumpy, melted edges | straightened walls, the scan kept elsewhere | flat walls, sharp corners, all new |
| Windows | in the photo only | recessed where K rebuilt the facade | punched and recessed everywhere a reading exists |
| One-off detail (a sign, a carving) | kept | kept | lost unless it stands proud enough to be kept as scan detail |
| Triangles (ESB) | large | large | about 330,000 |

## What has been shown so far

- **ESB, judged blind against held-out Street View photos** (`docs/processes/2026-11-08-hybrid-twin-vs-k-prereg.md`): the
  hybrid twin scored 5.00 overall against K's 4.55, with shape, materials and both decoy bars met, on three judged
  views. Both scored below the raw scan (6.67), as K has in every earlier ESB comparison.
- **The structure intent's windows in the twin** (this branch, 2026-11-13): no visible change on the ESB; on Penn 2,
  42 % more windows placed and a slightly more regular facade by eye. The judge could not settle it: current Street View
  shows Penn 2 reclad, the tile shows the old facade
  (`docs/processes/2026-11-13-intent-windows-twin-penn2-prereg.md`).

## Limits

- The twin is only as good as its window readings. A wall with no reading gets no windows; overlapping readings are
  dropped by the generator rather than merged.
- Street-level podiums and entrances come out as coarse blocks: the scan is weakest there and the twin has little to
  measure.
- Reveal and pier depths are mostly generated. Google's tiles model a facade as a nearly flat skin, so the scan rarely
  resolves them.
- One building has been judged. The result at the ESB is not yet a result for buildings in general.

## Where the code is

| Piece | File |
|---|---|
| Generator | `packages/core/src/native/3d-engine/include/scratchbox_measured_twin.hpp`, `scripts/measured_twin.cpp` |
| Records, spec, build entry | `packages/core/src/node/3d-engine/staged-location/measured-twin/measured-twin.ts` |
| Inferred inputs | `…/measured-twin/infer.ts` |
| Hybrid inputs | `…/measured-twin/hybrid.ts` |
| Exposure gain on the result | `…/measured-twin/exposure.ts` |
| Chat tool (`location_measured_twin`) | `packages/core/src/node/gemini/tools/measured-twin-tool.ts` |
| Texture twin | `packages/core/src/node/3d-engine/staged-location/tile-refine-twin.ts` and pipeline K's texture stage |
| Plan and experiment notes | `docs/research/2026-11-08-hybrid-twin-plan.md`, `docs/research/2026-11-07-esb-procedural.md` |
