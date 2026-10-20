# Staged Location Builds: Pipeline E Measured Relief (averaging the scan along repeats)

> **Recorded:** 2026-10-19
> **Status:** Verified behind pipeline E's flag (`SCRATCHBOX_STAGED_PIPELINE=e`; the relief stage is on whenever E runs, `SCRATCHBOX_STAGED_PIPELINE_E_RELIEF=0` turns it off). Branch `version-e-relief`, not merged to main.
> **Tags:** `operate-scratchbox` `staged-build` `pipeline-e` `relief` `measured` `photo-match`
> **Target Domain:** Real-world 3D locations (`google_3d_tiles_get_clay`, `isolate: true`)

---

## 1. What it does

Pipeline E's bands were read by a vision model from one side-on render and accepted 4 of 49 times. The relief stage measures detail from the scan instead, by averaging it along what repeats. It runs in the background after the clean (and inferred) layer and commits a refined layer `l2r`. The clean building still arrives in 3-6 s.

1. **Relief maps** (`pipeline-e/relief.ts` `reliefMap`). For every face of the massing (walls, roof planes, modelled facets) the native massing tool already renders the scan's outermost surface through a slab about the face (`face_<i>.prot`, -1.5 to +2.5 m along the normal). It now also writes the face's own extent (`face_<i>.inside`). A texel is invalid when it is outside the face, unseen, behind a measured tree crown, inside the inference's occluder masks, inside a scanned residual cluster that is already kept as scan, or a clamp hit at the slab's limits.
2. **Averaging** (native: `scratchbox_relief_average.hpp`, CLI `scripts/relief_average.cpp`, built through the native build cache).
   - Each map is made relative to its local wall line: block medians (0.5 m), then a robust local plane over a 4 m window (Tukey biweight), shifted inside the face at its edges. It is done in two passes, the second leaving out what the first found.
   - **(a) Bands:** each row is cut into 0.5 m blocks. A block's median is one sample. The row's depth is the trimmed mean (20 %) with the Tukey–McLaughlin standard error, and the cross-section is the row means.
   - **(c) Vertical elements:** the same down the columns, with the accepted band rows and the openings (plus 0.3 m) left out.
   - **(b) Lattice units:** when a facade grammar was accepted, its openings are grouped by size, resampled into one frame (the opening scaled, a 0.5 m margin unscaled), co-registered by a ±0.15 m shift search against the median of the others, and averaged. One opening is one sample. This measures the reveal depth (the core's median) and the projection profiles below, above, left and right of the opening, with their extent along the edge.
3. **Geometry.**
   - Full-length bands are swept along the wall with the engine's sweep, mitred round the corners where the next wall of the loop shows the same band. Their profiles are combined by inverse variance.
   - Partial bands, vertical elements and the projections beside openings use a new face-local sweep operator (`facesweep`: a profile `offset(c) >= 0` swept along a face axis at any number of placements, capped).
   - Measured reveals set the recess depth of the lattice's openings.
   - Photo-inferred bands at the same height on the same wall are replaced by the measured ones.
   - When a refined layer has split a wall (an inferred roof block), the features are moved onto the pieces (`retargetGeometry`).
4. **Gates.**
   - **Per feature:** depth ≥ **k = 3** standard errors and ≥ 0.05 m, from ≥ **N = 6** blocks of 0.5 m (lines) or **N = 4** openings (units). The blocks must agree with the line's sign (≥ 70 %), and the depth must be ≤ 1.2 m; anything deeper stands in front of the wall and is left to the residual.
   - **Per layer:** the photo-match judge (`gemini-4-argon`, blind, shuffled, 3 runs) on up to 4 of the build's own Street View photos compares the layer it refines, the measured layer and the measured + generated layer. Measured is kept unless its overall score is lower. Generated is kept only when it lowers neither overall nor shape (identity) nor detail (realism).
5. **Labels.**
   - Kept measured features are `measured`, method "measured by averaging the scan along repeats", with the depth ± standard error and the sample count in the node's provenance note.
   - Per the realism-first directive (AGENTS.md, origin/main ea029cb7), a **generated** typical profile is added where the facade clearly has the feature but the average is too weak. That means a band candidate refused only for its SE or block count, at a wall's top or within 0.6 m of a storey line of the accepted grammar, or a lattice group whose recess was refused.
   - A generated profile's depth is the typical one (band 0.12 m, crown 0.35 m, reveal 0.15 m) clamped into the candidate's evidence bounds (mean ± 3 SE). Nothing is added when the upper bound is under 0.05 m. It is labelled `generated`, confidence 0.5.
   - Depth Anything V2 relief from Street View (now allowed) was not used.

## 2. Synthetic test (`packages/core/test/staged-pipeline-e-relief.test.ts`, 6 tests)

The test facade is a 24 × 15 m south wall, built as a scan grid at 0.08 m spacing. Its true relief:
- a 0.6 m cornice ramp;
- a 0.15 m string course;
- two 0.12 m pilasters;
- 18 windows with 0.25 m reveals and 0.08 m sills.

The noise is heavy: white 0.10 m, correlated 0.08 m (sinusoids of 7.5-38 m wavelength) and 3 % outliers up to ±0.7 m. The scan is rendered through the native slab.

What the averaging recovered on seed 11:

| Feature | Recovered (± SE) | Truth |
|---|---|---|
| Cornice | 0.575 ± 0.006 m | 0.6 m |
| String course | 0.145 ± 0.006 m | 0.15 m |
| Pilasters | 0.131 m, 0.120 m | 0.12 m |
| Reveal (18 openings) | 0.253 ± 0.011 m | 0.25 m |
| Sill | 0.075 ± 0.005 m | 0.08 m |

- The sill's extent past the jambs came out at -0.10 / +0.10 m (truth ±0.10 m); the test allows ±0.15 m.
- The cornice's cross-section RMS against the truth is under 5 cm.
- No other band or vertical element was kept.
- A noise-only facade keeps nothing.
- The same assertions pass on 20 of 20 noise seeds.

**A correction to an earlier claim.** I first reported six passing seeds, but the test's generator was not drawing independent noise. Its random-number generator lost precision in float arithmetic and repeated every ~10,000 draws. With a correct 32-bit generator, two of eight seeds failed:
- a 0.10 m-wide (2-line) partial band was kept by chance;
- one noisy texel cut a sill's extent short.

Two fixes followed:
- line features narrower than 0.15 m (below what the scan resolves) are refused;
- the extents beside openings grow across gaps of up to 0.15 m.

The test now states the extent precision as ±0.15 m. It also allows the face's mode (the wall snap, which the averaging does not use) to sit within 0.1 m of zero. The rebuilt four places keep exactly the same features as before this fix.

Before the two-pass local-plane detrend, the correlated noise produced 0.29 m false bands; the test failed then, and it fails without the change (no relief module).

The other tests check:
- the swept geometry (cornice 0.5-0.7 m proud at its height, 18 recesses at the measured depth, labels with "+- … m (standard error)");
- the split-wall retarget;
- the generated rules: a typical band at a storey line inside the bounds, a typical reveal, none where the scan bounds it out, and clamping.

Related suites still pass: `staged-pipeline-e` (12), `staged-location-orchestrator` (36), grammar, tool and texture-orchestrator suites (75 tests in all).

## 3. The four places (headless builds on round-3 recordings, then live in the app)

**Kept / proposed per place:**

| Place | Bands | Vertical elements | Window reveals | Projections beside openings | Generated (built) | Relief stage time |
|---|---|---|---|---|---|---|
| Puck Building | 12 / 26 | 5 / 26 | – (no grammar accepted) | – | 2 crown bands | 16-90 s |
| Jefferson Market Library (modelled volume, 76 facets) | 14 / 151 | 16 / 103 | – | – | 0 (32 facet "crowns" refused by the gate, then ruled out) | 75 s |
| Haughwout Building | 8 / 15 | 0 / 24 | 5 / 5 groups (51 + 14 + 6 + 9 + 27 openings) | 3 / 4 | 6 bands | 44 s |
| St. Mark's Church | 3 / 8 | 0 / 7 | – | – | 0 | 40-106 s |
| **All** | **37 / 200 (18.5 %)** | **21 / 160 (13 %)** | **5 / 5** | **3 / 4** | **8** | |

E's vision band step on the same builds kept 4 of 48.

**Measured depths (± SE):**

| Place | Bands | Vertical elements | Other |
|---|---|---|---|
| Puck | 0.12-0.44 m (median 0.24, SE median 0.03), at about 10.4, 18.2, 29.4 and 38.1 m on several walls (the floor bands between the arcade bays) | piers 0.16-0.19 m | |
| Jefferson | 0.05-0.47 m (median 0.15) | 0.06-0.41 m | |
| Haughwout | 0.12-0.60 m (median 0.25) | | reveals 0.22-0.35 m (median 0.27, SE 0.01-0.04); projections above the openings 0.12-0.46 m |
| St. Mark's | 0.09-0.47 m | | |

**Generated depths:**
- Puck: 0.14 and 0.35 m.
- Haughwout: 0.12-0.30 m.

Haughwout's two tallest measured bands (2.1-2.4 m, 0.52-0.60 m out) follow the scan's melt, in which the entablature and the arch heads are smeared together. They are measured, but they read as slabs (see `clay/haughwout_front_before_after.png`).

**In-build photo-match gate** (4 Street View photos × 3 runs; base / measured / generated, overall score):

| Place | Base | Measured | Generated | Outcome |
|---|---|---|---|---|
| Puck | 4 | 4 | 4 | measured and generated kept |
| Jefferson | 4.42 | 4.42 | 4.25 | generated refused |
| Haughwout | 2.67 | 2.67 | 2.67 | measured and generated kept |
| St. Mark's | 3.25 | 3.25 | – | measured kept |

**Held-out photo-match** (`scripts/dev/photo-match-eval.ts`, round 3's held-out views, none used by any build; in context; `gemini-4-argon` blind × 3):

| Arm | Views | Shape | Materials | Detail | Errors | Overall |
|---|---|---|---|---|---|---|
| E | 18 | 4.07 | 3.93 | 3.26 | 2.98 | 3.61 |
| E + measured relief | 18 | 4.11 | 3.93 | 3.30 | 2.96 | 3.59 |
| E + measured + generated | 10 (Puck, Haughwout) | 4.47 | 4.23 | 3.40 | 3.03 | 3.77 |

On the same 10 views E scores 4.40 / 4.24 / 3.33 / 3.07 / 3.80.

Per place, E against E + measured (overall): Puck 4.00 / 4.00, Jefferson 3.17 / 3.17, Haughwout 3.60 / 3.53 (shape 4.07 → 4.20, detail 3.13 → 3.27, errors 3.13 → 3.07), St. Mark's 3.58 / 3.58.

- 179 of 230 judge cells were identical across the 3 runs (mean within-cell sd 0.11).
- **The relief is not measurable to the judge at Street View distance with photo-textured renders.** The arms differ by ≤ 0.07 overall, within the judge's noise.
- The judge has no separate realism and identity scores. Shape and overall stand in for identity, detail and errors for realism.

## 4. In the app (operate-scratchbox)

- **Instance:** from the `version-e-relief` worktree, web 3481, API 3482, tools 3483, `SCRATCHBOX_STAGED_PIPELINE=e`.
- **Requests:** "Build the … in 3D (clay)" for all four places. Each finished with "Measured relief committed" as a stage of its own, listed after Facade grammar.
- **Agent reply:** on Jefferson it lists "Measured Relief (`measured`, `stg-…-l2r`)" with the kept counts and the gate.
- **Before/after:** while the relief stage ran, the scene showed the E (inferred) layer, so the live before/after came from one camera. On Haughwout the entablatures between storeys and the deeper reveals appear (`app/haughwout_app_before_E_inferred.jpg`, `app/haughwout_app_after_relief.jpg`).
- **Console:** no errors.
- **Gate results live:**
  - Puck: 4 / 4 / 4.
  - Haughwout: 2.83 / 2.83 / 2.83; detail 2.83 → 2.92.
  - Jefferson: 4.33 / 4.33.
  - St. Mark's: 3.25 / 3.25.

## 5. What did not work, and limits

- **No judged gain.** The relief stage adds real, measured geometry (clay shows it), but the held-out judge does not see it through the photo texture at street distance.
- **Masks shrink the maps.** Occluder masks from the vision reading cover large parts of some walls (Puck), so many bands are built only along part of a wall.
- **Lattices are rare.** A window lattice was accepted only on Haughwout in these builds, so reveals were measured there only.
- **Melted scans.** Where the scan's melt joins elements (Haughwout's entablature and arch heads), the averaged cross-section is the melted shape.

## 6. Candidate tool/service ideas

- A `photo_match_evaluate` option to score realism and identity separately (the directive's two scores), so the generated gate can use them directly.
- A clay-only arm in the photo-match evaluator (no photo texture), to judge geometry changes like this one.
- A viewport toggle for showing a superseded layer, for same-camera before/after views in the app.

## 7. Reproduction

- **Headless builds:** `SCRATCHBOX_STAGED_PIPELINE=e node -r ts-node/register -r ./scripts/dev/staged-replay.ts <build.ts> "<query>"`.
- **Run notes:** `pipeline_e_relief.json` and `pipeline_e_relief_gate.json` in `.scratchbox/cache/staged_location/runs/<runId>/`.
- **Relief outputs:** `.scratchbox/cache/staged_location/pipeline_e/<key>/relief/`, with `relief.json`, the `relief_map_<face>.png` diagnostics and the averaged unit patches.
- **Evaluation:** `scripts/dev/photo-match-eval.ts <manifest>` with arms E (`…_inferred_tex.glb`), `massing_relief_textured.glb` and `massing_relief_generated_textured.glb`.
