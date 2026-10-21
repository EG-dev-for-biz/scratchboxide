# Process: Residual audit for staged location builds, and the 488 Broadway roof spike

> **Recorded:** 2026-10-19
> **Updated 2026-10-21:** a confidently radially-symmetric real-object cluster (a rooftop tank, a chimney) is now fit with a
> clean solid of revolution from its own measured per-slice radius (`residual-shape-fit.ts`), instead of staying raw,
> unresolved scan triangles — the water tower this session found and labelled (section 1) is built, not just labelled.
> See section 5a.
> **Status:** Verified (tool, pipeline E wiring, three live NYC builds); two findings left open (section 5)
> **Tags:** `operate-scratchbox` `staged-location` `pipeline-e` `residual-audit` `scan-artefacts` `sb-feature-types`
> **Target Domain:** Staged location builds (pipeline E), in-app Gemini tools (location evidence pack)

---

## 1. Session context

* **What prompted this session:** a pipeline E build of the E.V. Haughwout Building (488 Broadway) showed a long diagonal spike over the roof, floating slabs and slivers, and a box where the real rooftop water tower stands. Nothing decided whether a leftover scan cluster (the "as-scanned" residual) was a real object or a scan artefact.
* **Instance used:** branch `residual-audit` worktree, web `3742`, API `3741`, tools `3743`, `SCRATCHBOX_STAGED_PIPELINE=e`, started with env vars from `desktop-app/` (`npm run dev`).
* **Scope tested:** the spike's cause and fix; the new native measures and verdicts; the audit running inside pipeline E after every native run; the in-app tool `location_residual_audit`; `photo_match_evaluate` before and after.

---

## 2. The spike: a parapet sweep across the roof

The spike was not scan geometry. It was pipeline E's photo-inferred parapet sweep (`sweep:parapet_…`).

* **The cause:**
  1. The roof reading (`inference.ts`) named the part's walls by key.
  2. Two raised blocks were then added on the roof. Their corners lie on walls 1 and 3, so the native tool split those walls into `…:0:1:0/1` and `…:0:3:0/1`.
  3. `emitSweep` in `scratchbox_staged_massing.hpp` skipped the keys it could not find. It then joined the walls either side with straight segments across the plan. One edge was 35.2 m long, from (11.6, 14.7) to (−5.1, −16.3).
* **A second bug:** the parapet's profile sat at the part's `topY` (34.3 m), a cap over its roof planes. The Solar roof plane under it is at 24–26 m, so the frame floated about 9 m above the roof.
* **The fix:**
  * Sweep keys now resolve a split wall to its pieces (`key:k`).
  * Walls are chained only where one ends where the next begins (5 cm), in any input order. A missing key is noted and never bridged.
  * Each run is mitred, and capped unless it closes.
  * A sweep may carry `relativeToTop` (spec token `top`). The parapet now uses it: heights are above each wall's own top polyline.
  * Test: `residual-audit.test.ts`, "parapet sweep over a wall another part split". Screenshot: `parapet_split_wall.png`.
* **The missed water tower:** the roof reading had boxed it. Raised block 5 ran from the roof up to 34.33 m, and its residual became "cut" inside the box, so it was hidden. A raised block is now not boxed when the residual audit measured a real object there that is round in plan (radial symmetry ≥ 0.5, plan overlap ≥ 50 %, `BLOCK_NOT_PRISM`).
  * Open space below alone is not enough. At the Little Singer Building the ragged, hollow scan of a bulkhead read 73 % open below, which wrongly kept its block from being boxed. That rule was corrected in this session.
  * In this session's live Haughwout build the roof reading proposed only one block, so this rule was not exercised there. It is covered by a unit test.

## 3. The tool: `location_residual_audit`

**Native measures** (`scratchbox_residual_audit.hpp`, `scripts/residual_audit.cpp`, built through the native build cache):

* **Clustering.** Candidate triangles form connected components through welded vertices.
  * Triangles that copy a massing surface are clustered apart from the rest. A copy faces the nearest solid surface squarely (|n·d| ≥ 0.9) within 3 m of it.
  * A copy component outside the solid joins one neighbouring component when ≥ 50 % of its rim turns toward the solid there. That is the top of a box resting on its walls.
* **Per cluster, continuous numbers only:**
  * Size: bounding box; gravity frame (origin, x axis, extents); principal axes and extents; area.
  * Shape: thinness (c/a), elongation (b/a), main-axis and sheet-normal verticality.
  * Surface: triangle quality median, sliver share, longest edge, normal coherence, up/down/side shares, boundary-edge share (closure), copy share.
  * Volume: envelope volume and its fill of the box. Where the cluster's own sides wall the space in, the envelope goes down to the support.
  * Attachment:
    * gap to the solid (minimum and median) and the contact share;
    * contact along the long axis, in 20 bins;
    * the share inside the solid (ray parity, two rays);
    * per plan cell, the drop to the first surface below. From that: grounded (≤ 0.75 m, or walled in by its own sides), enclosed, open below (≥ 0.75 m) and overhang (> 6 m) shares;
    * base and top above the support and above the ground.
  * Symmetry: circle fits of horizontal slices (radial symmetry = median of (1 − rms/(0.25 r)) × the share of 12 sectors filled), cross-section constancy (1 − the coefficient of variation of slice sizes), and periodicity of the height profile with its period.
  * Photo: mean tile colour and the spread of luminance.

**Verdict** (`residual-audit.ts`): continuous ramps, all in `RESIDUAL_AUDIT_THRESHOLDS`.

* Artefact evidence is the strongest of five scores:
  * spike (long, thin, not vertical, touching along under 30 % of its length);
  * sliver (a sheet of needle triangles);
  * floating (≥ 0.75–1.5 m from the massing with nothing under it);
  * curtain (a hanging vertical sheet, open below);
  * copy (copy share 0.6–0.9).
* Sky-coloured photo adds at most 0.15.
* Real evidence is the minimum of:
  * a body (thickness ≥ 0.12–0.3 of its length, normals spread);
  * rising 0.5–1.5 m above its support;
  * attached;
  * mostly outside the massing.
  * It is boosted up to 30 % by radial symmetry or constant section.
* A body that touches nothing is held at artefact 0.55 (unsure), because its supports may be what the scan lost.
* Verdict:
  * **scan-artefact** when artefact ≥ 0.6 and leads real by 0.2;
  * **real-object** the other way round;
  * **unsure** otherwise.
* The reason is built from the numbers.
* Feature-type labels (sb-feature/1 codes, below) are attached afterwards with a confidence. A test checks that relabelling a cluster does not change its verdict.

**Output:**

* JSON (`scratchbox.residual-audit-result/1`). Every cluster carries its measures, verdict, confidence, reason, triangle ids (plus `sources` mapping ids to nodes and local triangles), local frame and an `sb-feature/1` record. Real objects are listed in `candidates` for `streetview_look_at`, `vision_measure_shape` and `location_fit_object`.
* With `writeCleanGlb`, a copy of each layer GLB with only the artefact triangles removed from their nodes. All other bytes and labels are kept.

**Inside pipeline E** (`pipeline-e.ts` `runNativeMassing`, so the massing, inferred/enhanced and relief runs are all audited):

* Artefacts are removed.
* Unsure clusters move to their own nodes, with provenance `as-scanned:unsure` and a note in the layer's provenance.
* Real objects stay as scanned.
* Ground-apron triangles (wholly within 0.85 m of the ground) are not audited.
* The orchestrator writes `residual_audit_<layer>.json` run notes and a build note. It records degradation `residual_unsure` when clusters stay unsure, or `residual_audit_failed` when the audit could not run (the residual is then kept unaudited).
* `PIPELINE_E_VERSION` is now `pipeline-e/v2`.

**Gemini tool:** `location_residual_audit`, in the location evidence pack.

* Input is one of: `runId` (default: the open staged build), `buildDir`, or `glbPath` (geometry only, no photo).
* Options: `allLayers`, `writeCleanGlb`.
* It is registered with a label, a description and a 15-minute time budget.
* The description says it uses real data only.

## 4. Live results (in the app)

| Place (run) | Clusters | Artefacts removed | Real objects | Unsure | Removed area |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Haughwout, 488 Broadway (`4400aa71`, relief layer) | 50 | 25 (206 tris) | 5 | 20 | 250 m² |
| Little Singer, 561 Broadway (`6464c5d2`, enhanced layer) | 62 | 41 (234 tris) | 6 | 15 | 197 m² |
| Gunther Building, 469 Broome St (`8ea24242`, relief layer) | 63 | 43 (353 tris) | 5 | 15 | 183 m² |

**Haughwout real objects**

| Cluster | Labels | Area | Confidence | Measures |
| :--- | :--- | ---: | ---: | :--- |
| 34, the water tower | `ROOF_OBJECT`, `ROOF_OBJECT_TANK` (0.57) | 127.5 m² | 1.00 | extents 4.8 × 11.3 × 4.6 m; radial symmetry 0.57, r 1.64 m; open below 97 %; top 11.31 m above the roof; 0.12 m from the massing; coherence 0.01 |
| 21 | `FACADE_ELEMENT` | 80 m² | 1.00 | east-side assembly from 6.6 to 22.5 m, thickness 0.45 |
| 44 | `ROOF_OBJECT` | 47 m² | 0.66 | rise 2.08 m, constancy 0.73 |
| 22 | `FACADE_ELEMENT` | 3.4 m² | 0.69 | |
| 48 | `ROOF_OBJECT` | 2.5 m² | 0.90 | rise 1.2 m |

* **Removed at Haughwout:** all copy artefacts (copy share 1.00): the scan's roof poking through the Solar roof plane, 0.6–2.8 m off it. The largest are 114, 68 and 47 m².
* **Unsure at Haughwout:** the largest are 195, 146 and 112 m². They are roof-edge tangles of parapet and clutter, and the tilted facade "fins" (real 0.3–0.4).
* **In chat:** the agent reported the audit unprompted in the build reply, and the `location_residual_audit` call returned the same 5 real objects and 25 artefacts across all 4 native runs.

**Little Singer and Gunther**

* No round tank was found at either.
* **Little Singer:** the largest real object is a 190 m² rooftop structure (rise 5.7 m). Unsure clusters include tall strips along the party walls (36.7 m tall, "no measure stands out").
* **Gunther:** the massing fits the scan poorly. Clusters of 250 and 197 m² rising from 6.6 m to 33.6 m are geometry the massing lacks.
  * They were labelled `ROOF_OBJECT` live. The label rule now calls a real cluster at least 8 m tall over at least 80 m² a `BUILDING_PART`. That change is labels only, made after the run and not re-run live.

**Photo match at Haughwout** (`photo_match_evaluate`, in context, trees on, 4 held-out views, 3 blind runs, `gemini-4-argon`):

The audit's own effect was isolated with a control arm: the audited relief layer plus the 206 removed triangles put back as a separate GLB.

| Arm | Overall | Identity | Realism | Shape | Clay shape |
| :--- | ---: | ---: | ---: | ---: | ---: |
| audited | 5.17 | 5.75 | 4.75 | 5.5 | 4.34 (±0.2) |
| artefacts put back | 5.17 | 5.75 | 4.75 | 5.5 | 4.59 (±0.2) |
| old build (with the spike) | 5.17 | 5.83 | 4.84 | 5.58 | 5.83 (±0.5) |

* **The audit does not lower identity or realism.** The audited arm and the put-back arm score identically when textured.
* **Clay is 0.25 lower with the audit,** within the views' spread (sd about 1).
* **The old build's arm is a different build** (other code, different facade relief and textures). Its higher clay score comes from that, not from the spike: its facade relief differs in the clay grids.
* **Trees made no difference:** the place has no trees layer (0 trees on the structure), so "trees on" had nothing to add.
* Grids: `photo_match/`.

## 5. What did not work, or is left open

* **Unsure stays common:** 15–20 clusters per place. Roof-edge tangles mix a real parapet with clutter and pieces of roof, and connectivity cannot separate them. They stay, labelled unsure (degradation `residual_unsure`).
* **The facade fins at Haughwout and the party-wall strips at Little Singer** are unsure (real 0–0.4, artefact 0). By eye most look like artefacts. No measure here separates them yet. A per-cluster Street View check (`streetview_look_at`) is the natural next step.
* **The judge's views at Haughwout** are partly blocked by the building across Broadway (first run). The in-context run fixed registration. Still only 4 views.
* **Not done:**
  * Google Solar dataLayers DSM as a second height source. The DSM is 0.1–0.5 m per pixel (`solar-dsm.ts` asks for 0.5 m by default, so a 3.3 m tank is about 7 × 7 px). It is not wired into the audit.
  * Street View agreement per cluster.
* **Photo agreement is weak evidence:** only the sky colour enters the verdict (0.15). The live builds had no sky-coloured clusters.

## 5a. Shape fit (2026-10-21): a labelled tank is now a built tank

A real-object cluster was kept as scanned either way — a round tank got the `ROOF_OBJECT_TANK` label, but still rendered
with its own raw, unresolved scan triangles (its native UV straight into the shared tile photo), the same as a box-like
bulkhead. `residual-shape-fit.ts` closes this for the radially-symmetric case:

* The native tool already fits a Kasa circle to every horizontal slice through a cluster (`scratchbox_residual_audit.hpp`'s
  `SliceFit`, `sliceStepM` apart) to score `radialSymmetry`; it just discarded the per-slice fits afterwards. They are now
  serialised (`NativeCluster.slices`: y, cx, cz, r, rmsRel, sectors, per slice).
* A slice counts toward the profile only above `MIN_SECTORS` (0.9: close to a full circle). On the tank-on-legs synthetic
  fixture (residual-audit.test.ts) this is a sharp, not gradual, cut: the four support legs' slices measure 0.667 (noisy,
  rmsRel 0.03-0.06), the tank wall's measure a clean 1.000 (rmsRel ~0.003) — confirmed against the native numbers, not
  assumed. A cluster's support frame below a fitted tank keeps its own raw scanned triangles; the fit only ever replaces
  triangles within its own measured height range.
* The profile is revolved into a clean mesh by the existing shape-program trial's native generator (`emitRevolve`,
  `scratchbox_shape_program.hpp`), reusing `scripts/shape_program.cpp`'s "mode program" with `fit 0 0` (no scan-target
  fit — the profile is already measured, so nothing is fitted, only revolved). No new native geometry code.
* Coloured with the cluster's own measured average photo colour (`NativeCluster.photo.rgb`) as a flat material
  (`massing-glb.ts`'s `FLAT_COLOUR_REF_BASE`), since no per-texel photo mapping exists for a curved surface built this
  way; a clay grey fallback when the cluster has no photo. Labelled `measured` (`RESIDUAL_SHAPE_TOKEN`), not `generated`:
  the geometry comes from the cluster's own measured radii, not invention.
* Tests: `residual-shape-fit.test.ts` (the tank-on-legs fixture end to end: native slice serialisation, the profile
  picked, the native revolve, `applyAudit`'s per-triangle height split).

Not done: lobed/non-circular bodies (a chimney's box-like cross-section, `ROOF_OBJECT_CHIMNEY`/`ROOF_OBJECT_BULKHEAD`)
are not fit by this path (the shape-program's prism/sweep operators could cover them, but radial symmetry is the only
measure wired through so far); a cluster just under `MIN_RADIAL_SYMMETRY` (0.5) or `MIN_SECTORS` stays exactly as before.

## 6. Feature-type model (scope addition)

* `packages/core/src/common/spatial/sb-feature-types.ts` (schema `sb-feature/1`) holds the model. The design is in `sb_feature_types.md`.
* The AGENTS.md line, "Open Feature-Type Vocabulary (Labels Only)", has landed on main. It names this file path.

## 7. Candidate tool/service ideas

* **`streetview_look_at(clusterFrame)`:** registered Street View crops of one audited cluster, so a vision check can settle the unsure ones (fins, roof tangles).
* **An `allLayers` before/after render in the tool:** same-camera clay renders with each cluster coloured by verdict. This session used a scratch renderer for these.
* **A run note listing the visible layers,** so the audit tool can pick the layer the scene shows instead of the latest native run.

## 8. Reproduction

1. Link `secrets.json`. In `desktop-app/`, run `SCRATCHBOX_NO_ELECTRON=true SCRATCHBOX_STAGED_PIPELINE=e PORT=3741 SCRATCHBOX_WEB_PORT=3742 SCRATCHBOX_TOOLS_PORT=3743 SCRATCHBOX_ALLOWED_ORIGINS=http://127.0.0.1:3742 npm run dev` and open the token URL.
2. Ask "Build the Haughwout Building, 488 Broadway, New York in 3D (clay), isolated to just the building."
3. Read `.scratchbox/cache/staged_location/runs/<run>/residual_audit_*.json`, or ask the agent to audit the leftover scan clusters (it calls `location_residual_audit`).
4. Tests: `packages/core/test/residual-audit.test.ts` and `sb-feature-types.test.ts`. Screenshots go to `test-results/screenshots/residual_audit/` (`synthetic_verdicts.png`, `parapet_split_wall.png`, `haughwout_before_after_oblique.png`, `app/…`).
