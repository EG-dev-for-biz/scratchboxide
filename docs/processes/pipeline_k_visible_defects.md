# Pipeline K: the outside check (visible clay and holes) on the Empire State Building

**Date:** 2026-10-27
**Target Domain:** staged locations / pipeline K / build QA
**Status:** Verified (offline on cached ESB builds, and live in run `2e702979`)

## Why

The user's ESB build (run `b6081752`) showed a grey band down the facade: the seal's untextured caps across the facade's central recess (52,802 m² of clay fill). Area cannot tell a visible cap from one hidden inside the shell, and the existing tear audit does not run when the seal is on (K's stitch mode reports zero tears without running it; with the seal off, the default since this change, it runs), and it looks at each facade straight on only, so the build is now checked as the viewer sees it. The user then chose to go without the seal (the stitch session made it opt-in, `SCRATCHBOX_K_SEAL=1`) and asked for a check that also finds holes.

## The check

`packages/core/src/node/3d-engine/staged-location/pipeline-k/visible-defects.ts`, `measureVisibleDefects(glbBytes)`: 12 orthographic views (every 45° on the horizon, four diagonals from 35° above) at 0.15 m pixels, each two depth buffers (what the viewer draws, and the nearest triangle whichever way it faces). Per building pixel:

- **clay**: the drawn surface's material has no base colour texture;
- **inside visible** / **see-through**: the nearest triangle is the back of a photo-textured one (a wall seen from inside), with something drawn there or behind it, or nothing at all.

tile_refine's twin draws every material double-sided (`tile-refine-twin.ts:319`), so in the shown model a hole shows the far wall's photo from inside rather than the background; the check reads the winding, not the flag. Limits: 1% of the building over all views, 3% in any one view, for clay and for holes. Wired after the remesh polish in `orchestrator.ts` for a pipeline K isolate (one building; a district is not checked): run note `pipeline_k_visible_defects`, remesh degradation `visible_defects` when over a limit.

Known blind spots: a hole whose far side has no surface at all, and one through which the eye first meets an inner surface facing outward (an inner shell, a floor slab from above).

Tests: `packages/core/test/pipeline-k-visible-defects.test.ts` (9, a 10 m cube: clay outside / inside / small, a hole straight on and from above, the twin's double-sided case, a hole behind a hidden back face, a hole closed by a clay cap, a closed cube with no defect).

## Results (same ESB scan inputs, tile_refine `ec2cfbc7`)

| Build | Clay | Worst view | Holes | Worst view | Holes from (back faces of) |
|---|---|---|---|---|---|
| Seal v11 (polish `d8f09956`, the user's run) | 3.52% | 8.86% | 3.72% | 6.39% | FacadeLattice_31, Seal, FacadeLattice_49 |
| Seal with stitch fixes 1+2 (polish `0f567677`) | 1.27% | 1.98% | 2.61% | 3.85% | FacadeLattice_0, _53, _49 |
| No seal (polish `87d950ee`) | 0.23% | 0.61% | 4.70% | 7.31% | FacadeLattice_31, _0, _11 |
| Twin shown, seal v11 (`7b5fa275`) | 3.57% | 8.85% | 3.72% | 6.39% | as its polish |
| Twin shown, no seal (run `8fc9f702`, `07ddb64a`) | 0.32% | 0.73% | 4.70% | 7.31% | as its polish |
| Older pre-seal twin (`e73642ee`) | 0.35% | 0.72% | 4.52% | 6.98% | FacadeLattice_45, _51, _16 |

Each measurement takes about 2 s. Every build is over the hole limit; only the seal builds are over the clay limit.

The tear audit and this check can disagree: with the seal off the audit runs and finds no tear, while this check finds 4.70% holes. They look at different things: the audit compares the scan with the result straight on per facade, and the slits here are recess sides and facade edges seen at an angle.

## What the pictures show

Defect images (grey good, orange clay, magenta inside visible, blue see-through) in `docs/screenshots/2026-10-27-esb-visible-defects-*.png`:

- `seal-v11_az135_el35`: the orange band down the centre of the face is the user's screenshot, found by the check; orange caps also on the setback roofs.
- `no-seal_az135_el35`: the band is gone; thin magenta and blue slits remain along the rebuilt facades' edges and the setback lines.
- `no-seal_az225_el0`: the same slits, plus an open patch at the base on that side.

The slits match the texture session's prediction: the facade lattice's recess step faces are drawn only toward built cells, so the recess sides stay open (1,666 sides / 1,169 m² by its count). They were there before the seal too (the older pre-seal twin: 4.52%).

## Live run

Own instance `scratchbox-k-no-surroundings` (ports 3570 / 3571 / 3572), new chat, the 3D Building button, run `2e702979` (`{ isolate: true, pipeline: 'k' }`, seal off by default).

- Run note `runs/2e702979/pipeline_k_visible_defects.json`: `visible-defects/1`, flagged, 0.23% clay (worst 0.61%), 4.70% holes (3.06% inside, 1.64% see-through; worst 7.31% at 225°/0°), the same numbers as the offline measurement of polish `87d950ee`; no masks in the note.
- Timeline: `remesh degraded`, breakdown `visibleDefects: 1299 ms`.
- Build panel: "Staged build degraded: ... remesh: visible_defects; fit: fit_rejected". The chat reply spells the reason out (clay within its limit, holes over it, the FacadeLattice nodes named). Screenshot: `docs/screenshots/2026-10-27-esb-visible-defects-live-run.jpg`.

## Follow-up (2026-10-27): reveals closed, the fit left out, clay judged on the finished model

**Status:** holes Verified (offline and live); still 0.12 points over the hole limit.

- **Reveals wound backwards.** In `facade-lattice.ts` `latticeFacade`, every step face across s and every upward step face across t was wound opposite its declared normal. On the ESB polish that is 31,410 + 5,585 triangles, 8,156 m². The material is single-sided, so the viewer culled them from the side they show to, and the check read them as back faces.
- **Reveals beside the scan.** A rebuilt cell also had no reveal toward a neighbour left as scan, or past the lattice's edge.
- **The fix** (`facade-lattice/5`): one helper winds every side face outward. A reveal is now drawn toward a rebuilt cell, toward a scan cell (to its measured depth), and at the lattice's edge (to the scan's own depth in the cell).
- **Offline replay** (tile_refine `ec2cfbc7`, K orthos `fd680ca2`, run `2e702979`'s base loops):
  - holes 3.98% → 1.12%; worst view 5.35% → 1.73%;
  - by height band on the horizon views: below 25 m 0.71% → 0.47%, 25 to 200 m 1.92% → 0.24%, above 200 m 1.10% → 0.28%;
  - every lattice face now agrees with its normal.
- **The fit.** It is no longer run for a K isolate (`fit`, `project`, `vision`, `correct`, `detail` and `figures` are out of scope). K keeps the straightened scan, and an accepted fit would replace it with primitives. On the ESB it was always rejected by its gates, not its time limit: 82% of the scan kept as scanned (limit 35%), 94% of the rebuild unobserved (limit 35%), fit-to-scan RMS 10 cm (limit 6 cm).
- **Clay judged on the finished model.** The remesh stage measured clay before the texture stage paints the party wall, so the PartyWall (79% of the clay) was always reported. That stage now degrades on holes only. The finished twin is measured in the texture stage (note `pipeline_k_visible_defects_textured`, degradation `visible_clay` on the texture pass).
- **Live**, own instance `scratchbox-k-defects` (3610 / 3611 / 3612), the 3D Building button:
  - run `4309ff23`: `fit` skipped, no `fit_rejected`, holes 1.12% (worst 1.73%);
  - run `d674158b`: the finished model has 0.30% clay (limit 1%) and 1.12% holes, the same as offline.
- **Left:** 0.47% of the holes at the base (the wedge beside the party wall, `relief_m34`), and scattered slits at the setbacks (`FacadeLattice_10`, `relief_m11`). Images: `docs/screenshots/` was not written; the masks are in this session's scratchpad only.

## Candidate Tool/Service Ideas

- Export the defect images with the run note (they make the degradation readable at a glance); a PNG encoder is not in `packages/core`'s dependencies, so this needs one or a native writer.
- Attribute hole pixels to a facade id and cell (back-projected), so the lattice owner gets a list, not a picture.
