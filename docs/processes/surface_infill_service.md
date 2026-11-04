# Process: Surface infill — one geometry rebuild, one texture ladder and one seam gate for every removed region

> **Recorded:** 2026-11-03
> **Status:** Verified at unit level and offline on real extractions; **not wired into builds yet** (PR 1 of 5)
> **Tags:** `surface-infill`, `vehicle-removal`, `tree-strip`, `base-cleanup`, `texture-ladder`, `seam-gate`, `provenance`, `penn-station`, `trafalgar-square`
> **Target Domain:** Real-world 3D locations (staged-location removal steps: `vehicle-removal.ts`, the tree strip, pipeline K's base cleanup, Street View residue)

---

## 1. Session Context

* **What prompted this session:** district streets looked smeared and blotchy after vehicle removal, and the user widened
  the ask to every surface where a staged build removes something: "should be for any location so it should be for any
  surface where something is removed, our logic and ability to infill must be top notch". Each removal step had its own
  ad-hoc fill: vehicles mirror the road photo along its markings with a generated lane colour; the tree strip carries the
  nearest real texel or the tile's mean colour (`strip_fill_generated` in 5 of Penn's 20 K-D chunks); K's base cleanup
  skirt is clay; `fillOpenLoops` continues the nearest facade.
* **Instance used:** none (this PR is the service alone; no build calls it yet). Offline dev runs on cached real
  extractions, worktree `/Volumes/3DTESTING/scratchbox-ide/worktrees/surface-infill`, branch `feat/surface-infill`.
* **Scope tested:** `surface-infill.ts`, `surface-infill-geometry.ts`, `surface-infill-synthesis.ts`,
  `surface-infill-gates.ts`; `packages/core/test/surface-infill.test.ts` (14 tests).

---

## 2. What was built

* **The call.** A removal step hands over each region (`InfillRegionSpec`: its footprint as world triangles, the measured
  ring of surface points around it, what was removed) and gets back the surface under it (`RegionInfill`: the chart, the
  surface model, the fill raster, a per-texel label and rung, every attempt with its gate numbers and reason).
  `applyInfillToGlb` writes vertices (moved along the chart normal) and texels (painted where the surface lies on the
  model inside the target) into a GLB without removing a triangle; `infillExtras` (`sbInfill`) and `writeInfillRecords`
  carry the provenance; `measureFill` gives the seam-gate numbers of whatever a scan holds over a region (so two fills of
  one region are measured alike).
* **Geometry.** A chart fitted to the ring (level ground in plan, a wall in its own plane). The ring is joined into
  levels by smooth links (neighbours that differ less than half a step or a 12 % grade), so a kerb, a stair or a plinth
  splits it and a grade or camber does not; each level is a moving local quadric (sigma-scaled, ridge on the curvature
  terms so a one-sided ring falls back to a plane); a straight Fisher breakline where the two levels separate on one,
  else the nearest ring points' vote; heights never leave a level's ring range inside it. `closeLoop` closes an open
  loop watertight: ear clipping, interior points, Lawson flips on interior edges only, rim heights kept exactly.
* **Texture ladder**, every rung chosen by what the surface measures (no surface named anywhere):
  1. real views that see the surface clear (pinhole projection, depth test against the scan without what was removed,
     the caller's occluder masks, a per-view gain matched on ring texels): `measured`;
  2. continuation from the same surface's clear texels (exemplar synthesis whose admissible offsets the reading fixes):
     directional along the measured orientation (structure tensor), with dashes and crossing bars at their measured
     period (texture-repeat's NCC / repeats / phase-contrast gates, plus a trough between copies and a third repeat, read
     strip by strip so a dashed line beside plain lanes is found); periodic at the measured lattice (axes from the
     gradient-orientation histogram, so a square grid is read on its own axes); stochastic from any clear texel:
     `photo-inferred` for the first two, `generated` for the third; then a smooth rim-correction field (push-pull);
  3. a library material at real size, chosen by appearance (grain spread, then colour) and tinted to the ring: `generated`;
  4. a detail-locked generative inpaint for what remains (`InfillInpainter`, e.g. texture-inpaint.ts's `inpaintImage`):
     `generated`.
  Another step's fill (the strip's caps and skirts) is never a source.
* **Seam gate** before any write: rim CIEDE2000 (median, p90) against the real texels beside the fill, its bar the
  surface's own across a virtual seam 5 texels out; gradient and fine-detail energy against the ring band (strip by strip
  across a measured direction, so a fill holding more of a line is not "busier"); orientation and coherence continuity;
  one-way stretch; an FFT autocorrelation repeat test that admits the shifts the real surface repeats at (its line, its
  lattice). The texture tests judge the region as it will look (this attempt with the fills accepted before it). A
  rejected attempt falls to the next rung with its reason; when none passes, the least bad is kept, labelled generated,
  its failures recorded (`gatePassed: false`).

---

## 3. What was tested & what worked (Verified)

* **Unit tests** (`packages/core/test/surface-infill.test.ts`, 14 tests, all passing; fixtures in
  `surface-infill-fixtures.ts`: 30 m scans on a 0.25 m mesh with 5 cm PNG photos and a draped lump, with ground truth):
  grade and camber kept within 1.2 cm under the hole; a kerb split into two levels on a straight breakline (accuracy
  ≥ 0.92) with the full 0.15 m step across 0.5 m; a smooth camber not split; a wall charted in its own plane; a closed
  loop watertight (loop edges once, interior edges twice), rim vertices bit-identical, interior within 1 cm, every
  triangle facing up; a folded loop refused; the gate passing the true surface and failing a flat smear, a +40 step and a
  9 x 9 tiled copy, each with its reason; a lane line continued (mean luma > 200 on it, asphalt 70-100 beside it, grain
  spread 0.6-1.6 of the truth's, no car colour) and its dashes in phase (> 85 % of texels agree with the truth); paving
  joints kept on their 0.5 m lattice (tiles > 30 luma lighter than joints); gravel synthesised (mean ΔE00 to the truth
  < 3, spread ≥ 0.7, detail ≥ 0.6, repeat < 0.5); a clear registered view taken (`measured`, median ΔE00 to the truth
  < 3) and a mismatched one refused by the gate; the library (tinted to within ΔE00 4 of the truth's mean), a stand-in
  inpaint, and the membrane, each reached with its reason; the GLB write-back on a kerb street (indices unchanged,
  every vertex outside the target bit-identical, inside within 3 cm of its level, the kerb rise kept, no van colour left,
  `sbInfill` extras written).
* **Offline on real extractions** (§4's sheet): see the numbers there.

---

## 4. Proof sheets (docs/screenshots/surface_infill_2026-11-03/, gitignored; sent to the chat)

Offline dev runs on real extractions at 13de10e4. Vehicle regions were rebuilt from the vehicle step's recorded readings
(no model call), with PR 2's vertex moves; tree caps come from the strip's devegetated.glb. Both fills are measured by
the same seam gate in the same chart, as written into the GLB.

| Place (regions) | Gate passed: today's → infill | Median rim ΔE00 | Median fine detail (floor 0.5) |
|---|---|---|---|
| Penn Station's streets, K-D chunk 93a2d05b (30 vehicle regions) | 16 → 20 (in-chart 25) | 2.36 → 1.47 | 0.83 → 0.80 |
| Trafalgar Square, a plaza (40 largest of 290 vehicle regions) | 32 → 31 (in-chart 34) | 2.03 → 1.15 | 0.81 → 0.70 |
| Trafalgar Square, tree caps (30 largest of 1,151) | 16 → 17 (in-chart 19) | 3.99 → 2.12 | 1.16 → 1.04 |
| Fixtures (lane street, paving, gravel, kerb street) | all pass; every rung as the surface measures | 0.14-1.74 | 0.80-1.16 |

What the pictures show:
- Penn: a queue of cars and a red bus lane come out with their lane lines and the red continued (today's fill smears
  them). A semi truck's lot is mostly clean, with a few dark lumps of the trucks' roofs left standing; in PR 2 the
  vertices that move are decided against the ring's surface as before, which fixes that.
- Trafalgar: an enclosed courtyard car park (326 m²) has no clear surface within reach. Both fills fall to flat grey;
  the infill only because no library was handed in (the vehicle step should pass the surface library). One region of
  parked cars fails the infill's sharpness floor (0.47) where today's smear passes.
- Tree caps: grass and paving continue under the cut crowns where the strip's own fill leaves flat grey blocks; the
  join to the ground around halves (rim 4.0 → 2.1).
- The infill's gate is stricter than what today's fills show: a share of its own passes (in-chart) is lost when the fill
  is written into the scan's atlas at its own resolution (25 → 20 at Penn).

---

## 5. What is not done

* Not wired: vehicles, the tree strip, K's base cleanup and the Street View residue still use their own fills (PRs 2-4);
  SB-Roadie is still shelved (PR 5).
* No in-app build has run with it, so no ESB base, park or Federation Square sheet yet: those places come with the wired
  PRs, built uncached in the app.
* The synthesis runs in TypeScript; under the shared machine's load (load average 300-750 during this session) a region
  took 3-60 s. A district of hundreds of regions wants the synthesis native (C++) or in the texture worker pool.

---

## 6. Candidate Tool/Service Ideas

* **`location_measure_fill`** — the seam-gate numbers (`measureFill`) of any region of a staged layer, for the agent to
  check a fill it is shown instead of judging it by eye.
* **Region replay** — the regions a removal step removed, stored with the build (footprint, ring) so a fill can be redone
  without re-running the step (this session rebuilt them from the vehicle step's recorded readings).

---

## 7. Reproduction Steps

1. `npx vitest run packages/core/test/surface-infill.test.ts` (Node 22.18, credentials unset, empty HOME).
2. The offline sheets: the scratchpad scripts `sheet-real.ts` (vehicle regions rebuilt from a `vehicle_removal.json`'s
   readings over its extraction), `sheet-trees.ts` (the strip's caps in a `devegetated.glb`) and `sheet-synth.ts`,
   bundled with esbuild and run with node; composed with `compose.py`.
