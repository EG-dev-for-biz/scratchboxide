# Plan: occlusion mask, plane regularization, footprint warp (K and K-D first)

> Date: 2026-10-29. Status: plan, nothing built. Priority: pipelines K and K-D (`feat/pipeline-kd`), then I.
> Source: a review of an outside agent's literature-based recommendations (Verdie et al. 2015, Texture2LoD3,
> Sat2RealCity, Extend3D); only the three pieces that fit the code and AGENTS.md were kept.

## Order

| # | Piece | Pipelines | Why this order |
|---|-------|-----------|----------------|
| 1 | Occlusion mask for facade and plane orthos | K, K-D | Most new value; K-D districts have street trees and awnings on every block, the ESB has few. |
| 2 | Plane regularization: measure, then close the gaps | K, K-D | The rectifier already does most of it; one known gap (flatten ignores the families). Small, measured work. |
| 3 | Footprint-conformal warp after `registerToFootprint` | I (J only with approval) | K and K-D never call `registerToFootprint`; it serves the procedural path only. |

K-D builds each chunk as a full K build (extraction, remesh, K, trees, textures; `pipeline-k/district-chunks.ts`), and no
chunk line cuts a building, so pieces 1 and 2 reach K-D through K with no district-specific code. The one K-D concern is
context: a chunk's extraction keeps a margin past its cell, so occluders standing just over a cell line (a neighbour's
tree) must be inside that margin for piece 1 to see them; check that margin against the ray reach chosen below.

## 1. Occlusion mask

### What exists
- Orthos are rendered from the scan's own baked photo texels of each plane's triangles (tile_refine's facade orthos;
  `pipeline-k/plane-orthos.ts` for the other planes). There are no camera rays at ortho time: Google's capture has
  already baked whatever stood in front of a wall into that wall's texels, or left no wall there (a hole).
- Two masks travel beside each straightened ortho: `<image>_uncovered.png` (the photo never reached the texel) and
  `<image>_featureless.png` (a smear) (`pipeline-k/ortho-rectify.ts`, `pipeline-k.ts` ~l.240-262).
- Consumers already honour "uncovered": `window-fit.ts` (`Darkness.of` -> `valid`), `wall-grammar.ts` (`uncoveredOf`,
  continues the wall's rhythm over it), the lattice (builds only covered cells), the hole fill (repeats, storeys, nearest).

### The gap
A texel behind a crown, awning, scaffold or vehicle is "covered", so its colour (often the occluder's, bled onto the wall
by the photogrammetry) is read as wall: window fit loses rows behind street trees, the wall grammar reads a broken
rhythm, the facade reader reads foliage as an opening or as wall.

### Design (geometry only, no brightness rule, no class labels)
- **Where:** native, in tile_refine's ortho export (it already holds the mesh and a BVH, `bvhP`/`bvhT` ~l.2239), plus
  the same call from `plane-orthos.ts` for the planes tile_refine does not photograph.
- **What it casts against:** the raw extraction (before the tree strip), so crowns, awnings, vehicles and neighbouring
  buildings all count; any surface, never a named kind.
- **Weight:** for each covered texel at wall point p, cast a small fan of rays from p + eps n outward toward where the
  capture could have stood: the normal tilted up by 0/30/45/60 degrees, yawed -30/0/+30 (12 rays; the capture is mostly
  aerial oblique). A ray blocked within `reachM` (start at 25 m) by a surface not on this plane (beyond its depth band)
  counts as blocked. `W_vis` = share of rays clear, in [0, 1].
- **Output:** `<image>_occluded.png`, one channel, 255 x (1 - W_vis), in the ortho's frame (warped through the same
  straightening warp as the photo, like the uncovered mask), named in `facades.json` / `planes.json` as `occludedMask`.
- **Consumers (each its own switch while it is proven):**
  1. `window-fit.ts`: texels with `W_vis < occlusionMinVisible` (start 0.35) are not `valid`, exactly like uncovered;
     `completeLattice` then completes those sites from the facade's own repeats (photo-inferred, as today).
  2. `wall-grammar.ts`: occluded spans continue the wall's rhythm like uncovered spans (generated where continued).
  3. `facade-reader.ts`: the zone crop carries the mask (occluded texels greyed in the crop sent to the vision model,
     the same treatment as uncovered), so it neither reads foliage as an opening nor tiles from it; tiling across an
     occluded span is generated, as across an uncovered one.
  4. Texture refill (off by default at first): an occluded texel is refilled from the facade's repeats only when the
     repeat disagrees with it (NCC below the rectifier's repeat threshold), so a wall that was photographed clean
     between the leaves keeps its photo. Labelled generated in the GLB extras with its reason ("occluded in the capture").
- **Labels:** the mask itself is measured geometry; every fill it enables is generated or photo-inferred as above.
- **Switches:** `SCRATCHBOX_K_OCCLUSION=0` off; node graph `remesh.occlusion`; refill `SCRATCHBOX_K_OCCLUSION_REFILL=1`.
- **Report:** per facade, occluded share and the texels refilled, in `rectify.json` and the stage summary.

### Tests (no billing)
- Native: a wall quad with a box 3 m in front; the mask's flagged texels match the box's projection along the fan
  (counted), a box behind the wall flags nothing, a box on the wall plane flags nothing.
- `window-fit`: a synthetic facade with a regular grid whose bottom storey is painted foliage-green and flagged occluded:
  the lattice is completed there (count of sites), and without the mask it is not.
- `wall-grammar`: an occluded span is continued, same as an uncovered one.

### Live check
- Fresh, uncached builds (clear stage caches first). ESB: occluded share near 0 and output unchanged (regression guard).
- A block with street trees in front of its walls, built as K and as a K-D district (which block is the user's call;
  SoHo around the Haughwout is a candidate). Judge the straightened orthos with the mask overlaid, window-fit rows
  recovered behind trees, and the rebuilt facades, by screenshot (`screenshot-review`).

## 2. Plane regularization

### What exists (scan rectifier, `scratchbox_scan_rectifier.hpp`)
- Wall orientation families from an area-weighted azimuth vote, mod 90, so a family carries its perpendicular
  (`familyBinDeg`, `familySnapDeg` 1.5, `localOrientationWindowDeg`); walls plumb (`plumbSnapDeg` 1.5).
- Inclined planes take a wall direction of their building (`inclinedAzimuthSnapDeg`) and a pitch agreed by nearby slopes
  (`pitchConsensusRadius` 30 m): this is the Z-symmetry the outside agent proposed.
- Footprint walls matched and snapped; relief sheets snapped at their own step.

So parallel, orthogonal and matched-pitch regularization is already there in the rectifier. Building it again from the paper would just duplicate it.

### The known gap
`facadeFlatten` in `scratchbox_tile_refine.hpp` (~l.2576-2810) runs after the rectifier and finds its own wall planes as
(azimuth, offset) density modes at 1 degree bins, merged within 2 degrees, without reading the rectifier's families. Its
planes can sit up to a degree or two off the family the rectifier just snapped to, and the facades, orthos and lattice are
built on flatten's planes.

### Steps
1. **Measure first** (a stats block in tile_refine's report, no behaviour change): for every flatten plane, its angle to
   the nearest rectifier family; for every pair of adjacent walls, the angle error to the nearest of parallel or
   perpendicular; for opposed slopes, the pitch difference; plane offset spread within merged groups. Run on fresh ESB,
   Haughwout and one K-D district builds.
2. **Close what the numbers show**, smallest first:
   - flatten planes snapped to the rectifier family within `familySnapDeg`, under the same
     `maxSnapInducedDisplacement` guard (expected to be the main fix);
   - if adjacent-wall errors remain on non-family corners (a Broadway wall meeting a grid wall), leave them: they are
     real angles, and the mod-90 family must not force them square.
3. Each change behind a switch, reported in the flatten stats, kept only when the tear audit, the facade lattice and
   window-fit results are no worse.

### Tests
A synthetic two-wall corner, noise added, walls 1.2 degrees off square: flatten's planes come out on the family (angles
asserted), and a true 75-degree corner stays 75.

## 3. Footprint-conformal warp (pipeline I; J only with approval)

### What exists
`pipeline-i/register.ts` fits the generated model with one similarity (mirror, yaw, horizontal scale, height scale,
shift). `pipeline-i/refine.ts` projects survey plates only where the model's wall stands within 0.5 m of the massing
plane (`PROJECT_MAX_RELIEF_M`). A concave or scooped rear fails that and is left unprojected; Trellis's unseen texels
come back black (`docs/processes/pipeline_i_texture_hole_fix.md`).

### Design
- After `registerToFootprint`, per height band (the scan's storey pitch, else 3 m) and per footprint edge, measure the
  model's outermost surface offset from the edge along its inward normal (binned along the edge).
- Build a smooth plan displacement field from those offsets (pull out to the edge where the model stands inside it,
  pull in where it overflows), interpolated across the model (moving least squares over the edge samples), capped at
  a share of the footprint's short side, and applied to every vertex by its plan position and band.
- The scan's height and the footprint stay as given; nothing is clipped. The warp is labelled generated, with its mean
  and max displacement and the walls brought within `PROJECT_MAX_RELIEF_M` reported.
- Switch: `SCRATCHBOX_I_FOOTPRINT_WARP=0` off.
- **Pipeline J:** AGENTS.md keeps Meshy's model as-is ("nothing is clipped", an explicit exception). Warping it needs the
  user's decision first; until then the warp is I only.

### Tests and live check
A synthetic box with a scooped rear, registered then warped: all four walls within 0.5 m of the footprint planes,
height unchanged, triangle count unchanged. Live: a fresh pipeline I Haughwout build, projected facades 4 of 4 (was 2),
black-texel infill count down, scored against the Haughwout baseline (`watch-staged-build`).

## Docs to keep in step
Each piece that ships updates the AGENTS.md pipeline K (or I) paragraph with its default and switch, and gets a
`docs/processes/` findings report with a README row. Load the `facade-relief-research` skill before touching
window-fit or the wall grammar for piece 1.
