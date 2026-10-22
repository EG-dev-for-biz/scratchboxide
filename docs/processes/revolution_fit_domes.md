# Revolution fit: domes, drums and lanterns rebuilt uniform-first (Flinders Street Station, Federation Square district)

**Date:** 2026-10-22 · **Status:** Implemented and measured on the real district cache; wired into the district massing
stage (on whenever that stage runs; `SCRATCHBOX_STAGED_REVOLUTION_FIT=0` turns it off). Not yet seen in the live app.

User direction (2026-10-22, with a screenshot of the faceted, dented Flinders Street Station dome from Google 3D Tiles): a
dome's curvature is uniform, so fit that first (one vertical axis, one smooth profile r(y), uniform around the axis), then
fit the outliers (lantern, ribs, drum rings, cornices, a mast) only where the scan clearly departs over a real area. The
result must read as a clean dome, not the scan's dents.

## What was built

- **Native** (`packages/core/src/native/3d-engine/include/scratchbox_revolution_fit.hpp`, CLI `scripts/revolution_fit.cpp`,
  compiled through `compileNativeCached`): universal operator 2 (a harmonic solid of revolution), found and fitted from
  measurement. No noun, no shape enum: a part is accepted because its horizontal sections are circles about one vertical
  axis.
  1. *Detection (plan):* DSM summits grown downwards by a priority flood; each level's region is a horizontal section;
     a level is round when its radial extent along 72 rays has a small robust spread (octagon 0.02, square 0.11; limit
     0.065) and its centre does not drift. The stack ends where the region joins the roof.
  2. *Axis (3D):* scan sampled at 60 points/m², 0.4 m slices fitted with trimmed Kasa circles; the axis is vertical through
     the counted slices' weighted centre; its error is their RMS about it. Rejected when fewer than half the slices are
     circles, when the median slice RMS exceeds 8% of the radius, or when the centres lean more than 3°.
  3. *Profile, uniform first:* each slice's radius is the half-sample mode of its points (dents pull a median in; the mode
     stays on the surface). Above a cap base y0 one smooth curve of five continuous numbers,
     r(t) = R0 (1 − t^q)^(1/p) (1 + b·4t(1 − t)) (ellipse p = q = 2, cone p = q = 1, concave p < 1, onion b > 0), fitted
     by Nelder–Mead to orthogonal meridian distances under a Welsch loss whose scale shrinks to the core spread. Below y0
     frustum bands (drum, plinth) and rings (a band thinner than 0.75 m only if it stands proud of both neighbours).
     Every half slice is tried as y0; of those within 5% of the best fit, the one with the fewest bands is kept.
  4. *Stacked revolutions:* points standing ≥ 0.6 m above the cap within half its radius are a lantern/finial, fitted as
     their own stack; the cap is refitted without them.
  5. *Periodic departures (ribs, facets):* relative radial residual over 720 angle bins, Fourier k = 1..90; a period
     scores the sum of its lines k, 2k, 3k over their local noise floors (median of neighbours k±8: dents are broadband,
     a period is a narrow line); kept at score ≥ 4, swing ≥ 5 cm, both halves agreeing on phase; the fundamental is kept
     when it stands out too. A swing over 6% of the radius rejects the part (polygons of few sides are not circles).
  6. *Local departures* (≥ 0.6 m over ≥ 2 m²) are reported, not rebuilt.
  7. *Geometry:* each stack's meridian revolved into a closed outward solid (≥ 16 segments per kept period), smooth
     normals per meridian run; the base sinks 1 m into what it stands on.
- **Node** (`packages/core/src/node/3d-engine/staged-location/revolution-fit.ts`): runs the tool, cuts the rebuilt volume
  out of other layers' GLBs (`cutRevolutionsFromGlb`), colours each rebuilt part per height from the de-lit tile photo
  sampled around it (uniform about the axis, as the shape is; 9-row running median), writes `revolutions.glb` with node
  extras: provenance `generated`, confidence, the fitted axis/profile/modulation, fit residuals, departures and the
  reason ("the scan of this part is a dented, faceted copy of a surface its own sections show to be uniform").
- **Hook** (`orchestrator.ts`, massing stage only; `district-massing.ts` untouched): after the district massing layer is
  written, the fit runs on the tree-stripped scan, its volume is cut from `district_massing_{textured,clay}.glb` (and from
  `remesh_carved*.glb` when not procedural), and `revolutions.glb` is published as layer `l2v` (label `generated`, the fit
  summary in the note). Failures are written as a run note and the build goes on without it.

## Measured (Federation Square district cache, 250 m, tree-stripped scan, 315,291 triangles)

949 summits, 61 round stacks, **2 accepted** (the Flinders Street Station dome; St Paul's north-west spire); 59 rejected
with their numbers (28 too few round sections, 18 sections too far from circles, 10 too few round sections as a share,
3 four-periodic swings over 6%: two square turret roofs and St Paul's other west spire at 7%). The hook took 23 s on the
loaded machine (the native fit and the photo surface for colour); 709 massing triangles cut.

| | Flinders St dome | St Paul's spire (NW) |
|---|---|---|
| Axis (x, z) m | (−168.84, −17.38) | (−123.58, −95.94) |
| Axis error (slice centres RMS) | **0.11 m** | 0.06 m |
| Tilt (reported, not applied) | 0.45° | 0.44° |
| Round slices / median slice RMS | 36/43, 3.6% of r | 51/58, 4.3% |
| Scan RMS to the rebuilt surface | **0.27 m** (0.17 m truncated at 0.5 m) | 0.25 m (0.17) |
| Scan within 25 cm | **88%** | 88% |
| Cap | R0 8.45 m, H 12.08 m, p 0.91, q 4.29, b −0.06 (a full-shouldered bell) | R0 3.39 m, H 22.7 m, p 0.93, q 1.59 |
| Periodic | K = 8, 31 cm swing (3.7% of r), score 9.2: octagonal | none kept |
| Stacked | lantern (bands r 1.59, 1.25→1.08 m) + finial to 42 m | upper spire, R0 1.33 m |
| Local departures (reported) | 3 (2.5-3.1 m², +0.8-1.0 m at the base: the corner pavilions) | 1 |

Synthetic test (`packages/core/test/revolution-fit.test.ts`, `test/helpers/synthetic-dome.ts`; a ribbed dome R0 6.0 H 6.5
on a 6.3 m drum with a 6.9 m cornice ring and a lantern, 12 sharp ribs, 10 smooth dents of 0.25–0.5 m plus 6 cm noise,
a box building beside it): one revolution found (not the box), axis 0.03 m off the truth (error 0.03 m), cap R0 5.98 H
6.57, drum 6.28, ring 6.85, lantern 1.24, **K = 12 found** (score 5.8; the plain dome's best period scores 2.7 and is not
kept). The rebuilt dome is **0.041 m RMS from the true ribbed surface where the scan is 0.098 m** (the dents are not kept);
signed volume within 15% of the truth; the cut takes the dome's scan and nothing else.

## Screenshots (`docs/screenshots/revolution-fit/`, clay, same camera per pair)

- `flinders_dome_scan_{before,after}_{0,1}.png`: the tree-stripped scan, then the scan with the dome's volume cut and the
  rebuilt dome, lantern and finial in its place.
- `flinders_dome_procedural_{before,after}_{0,1}.png`: the procedural district's massing layer (the dome there is the
  scan's residual), then the same layer cut, with the rebuilt dome.
- `st_pauls_spires_procedural_{before,after}_0.png`: the massing layer's truncated spire stumps (the massing layer's own
  defect), then the north-west spire rebuilt; the other stays a stump (rejected at a 7% four-fold swing).

Looked at: the dented, faceted dome reads as a clean octagonal-ribbed dome with a lantern and finial; the rebuilt spire
reads as a clean spire, next to its unrebuilt twin.

## Gaps

- **Lantern caps hit the shape bounds** (Flinders finial p 0.28, b 1.5: an onion where the scan's 2 m geometric error
  shows only a spike). Believable, not measured; labelled `generated`.
- **The octagon is a smooth 8-lobe modulation**, not flat facets with sharp arrises (harmonics up to 3K only).
- **Colour is per height only** (uniform around the axis); ribs and windows are not in the texture.
- **Local departures are reported, not rebuilt** (dormers, clock faces, pavilions abutting the dome).
- **Not yet run live** in the app (`operate-scratchbox`): verified on the cached district data and in vitest only. The
  massing stage itself is off unless `SCRATCHBOX_STAGED_DISTRICT_MASSING=1` or `SCRATCHBOX_STAGED_PROCEDURAL=1`.
- **Twin parts can split at a threshold**: St Paul's two west spires measure 4-fold swings either side of the 6% bound
  (polygons of few sides are rejected), so one is rebuilt and one keeps the massing layer's stump. Pairing like parts
  (same profile within tolerance) to decide them together is the next step. St Paul's main spire is rejected at a 24%
  four-fold swing (its scan sections are square).
- **Speed:** the cap-base search fits the cap at every half slice (at most 64 bases); 6 s for the dome alone, 30-90 s for
  the whole raw district on a loaded machine.
