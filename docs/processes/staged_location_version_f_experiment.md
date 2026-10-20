# Staged Location Builds: Version F experiment (procedural-first rebuild, the tile only as a reference)

> **Recorded:** 2026-10-19
> **Status:** Experiment, branch `version-f-experiment` (from origin/main 63643b5d). Not wired into the app, nothing on main changed. Hypothesis **rejected as stated**: the split is not ordinary against distinctive, it is shape against texture (below).
> **Tags:** `staged-build` `version-f` `procedural` `photo-match` `provenance` `render-compare`
> **Target Domain:** Real-world 3D locations (`google_3d_tiles_get_clay`, `isolate: true`)

---

## 1. What version F does

Pipeline E builds a clean massing from Google's vector data, reads details off the tile with gated steps, and pastes the scan's leftover pieces back as scanned. Version F keeps only E's **measured massing** and generates everything else from numbers. The Google tile is used to read those numbers and to check the result, never as geometry.

Code: `packages/core/src/node/3d-engine/staged-location/version-f/`. Dev driver: `scripts/dev/version-f.ts` (input: an E build's `pipeline_e/<key>` directory).

1. **READ** (`facade-parameters.ts`). One `gemini-4-argon` reading (the staged vision chain) of the building's facade system. The model is shown:
   - the scan from above;
   - up to 4 large seen walls through their own orthographic cameras, each with a metric ruler (1 m ticks, labelled every 5 m);
   - two 45°-ish obliques of the photo tile;
   - up to 2 Street View photos that the E build already used (its ownership note's panos, read from the replay recordings, so no held-out pano is fetched).

   The answer is continuous numbers only:
   - ground storey and upper storey heights;
   - bay spacing and edge margin;
   - opening width, height, sill and recess (upper storeys and ground storey separately);
   - plinth, string courses, cornice (thickness, projection), parapet, piers (width, projection);
   - roof pitch, ridge azimuth and a hipped flag;
   - raised roof volumes (box and height);
   - linear colours with roughness for wall, trim and glazing;
   - free-text `features`, recorded but never branched on.

   There are no style or type enums. The parser clamps every field and records which fields fell back to defaults. `sb-feature-types.ts` is not on main, so no label codes are used.
2. **GENERATE** (`facade-program.ts`). The numbers become operators on the measured massing:
   - **Openings (normal relief).** A lattice per wall. Storey lines come from the storey heights, bays at the read spacing are centred on the wall, and openings are recessed by the read depth. No openings go where a neighbour stands against the wall. That is measured from the full tile: the lowest of three height samples 3, 4.5 and 6 m outside the wall.
   - **Bands, plinth, cornice and parapet (curve sweeps).** Mitred along runs of consecutive walls that reach their height.
   - **Piers (face sweeps).** Swept up each bay boundary.
   - **Roof.** Planes from the read pitch at the eave the scan measures. Raised roof volumes become small parts at the read footprint, shrunk to stay inside their roof, at the scan's height.

   The same rules apply to every wall, seen or not. Modelled-volume facets (Jefferson) take openings and piers. They take no sweeps, because the native sweep needs extruded walls.

   The solid is built by the native staged-massing builder (`scratchbox_staged_massing.hpp`, C++20, compiled at run time through the native build cache; no scene `.cpp` is committed). Its **scan residual is off** (`residual 0`, which also drops the ground apron). Archie's `ProceduralBuildingGenerator` was not used: it builds only rectangular boxes and takes a closed `RoofType` enum, so it cannot take a measured footprint and would break the ADA rules.
3. **CHECK** (`render-compare.ts`). F and the tile are rendered from the same cameras (a small depth rasterizer):
   - **Four 45° obliques and a top-down view against the isolated scan:** silhouette IoU and depth agreement.
   - **Each seen wall's own orthographic camera against the tile ortho:**
     - depth MAE and the share within 0.15 m;
     - **window NCC**, the correlation of F's openings with where the photo is darker than the wall around it;
     - **edge distance**, from F's opening borders to the photo's strong edges, in metres.
4. **ADJUST** (`adjust.ts`). A bounded search on the coarse (0.15 m) wall comparison. The objective is (1 − NCC)/2 + 0.5 × depth MAE, area-weighted. The search runs in this order:
   - a grid over the ground storey and a common scale of the upper storeys;
   - a per-wall grid over bay pitch (±12 %) and phase;
   - three coordinate rounds over every knob (the step halves each round);
   - one silhouette round on the parapet height, using real native builds.
5. **Texture: option (a).** Pipeline E's own bake. Every face of F's solid is the tile photo rendered orthographically through a thin slab around it. Walls the tile hardly sees (coverage under 0.35) take the read wall colour, with the read glazing colour in their openings.
6. **Provenance:**
   - openings and sweeps on seen walls: `photo-inferred`;
   - openings and sweeps on hidden walls: `generated`;
   - walls and roofs: `vector-modelled`, or `measured` where the part's height came from the scan;
   - read roof pitch and raised volumes: `photo-inferred`.

   Every F layer had **0 residual (scan) nodes**.

## 2. Bake-off

**Places.** Puck and 721 Broadway (NYU Tisch, a plain 12-storey loft) are the ordinary buildings. Haughwout (cast iron) and Jefferson Market (Victorian Gothic, a modelled volume) are the distinctive ones.

**Held-out views.** For Puck, Haughwout and Jefferson I reused the round-6/7 views; none of them was used by any build here. The manifest generator drops any view whose pano appears in this branch's recordings, and it dropped none. 721 Broadway had no held-out views, so I created them per the bake-off doc, excluding every pano in the recordings: `photo-match-heldout.ts` found 41 unused panos, 9 of them locked, and I used 6 at distinct headings.

**Judging.** `gemini-4-argon` blind ×3, textured and clay, in context (the isolate and this build's removed trees cut from the tile).

**Arms:**
- **A:** the raw tile.
- **Eh:** current pipeline E, enhanced. It was rebuilt on this branch with the round-7 replay recordings: live calls for misses, cached plates where recorded.
- **F:** version F textured, plus the E build's trees.

The clay judging of F is the F-clay arm.

Tables: `test-results/screenshots/version_f/bakeoff/` (one grid per view, and `*_clay.png`). Judge spread: within-view sd 0.11 textured, 0.32 clay.

| Place (views) | Overall: A / Eh / F | Realism: A / Eh / F | Identity: A / Eh / F | **Clay shape: A / Eh / F** |
|---|---|---|---|---|
| Puck, ordinary (4) | 3.92 / **5.08** / 3.17 | 3.00 / **4.17** / 3.00 | 4.92 / **6.17** / 4.50 | 2.42 / 3.58 / **5.58** |
| 721 Broadway, ordinary (6) | **3.56** / 3.28 / 3.22 | **3.17** / 3.00 / 3.00 | **3.83** / 3.72 / 3.56 | 3.33 / 1.72 / **6.89** |
| Haughwout, distinctive (5) | 3.53 / **5.67** / 3.40 | 3.13 / **5.27** / 3.20 | 3.87 / **6.07** / 3.93 | 3.40 / **5.93** / 5.27 |
| Jefferson, distinctive (4) | **5.33** / 4.08 / 4.42 | **4.08** / 3.17 / 3.25 | **6.33** / 4.83 / 5.58 | 3.33 / 5.00 / **5.50** |
| **All 19 views** | 4.00 / **4.46** / 3.51 | 3.32 / **3.88** / 3.11 | 4.60 / **5.09** / 4.28 | 3.16 / 3.91 / **5.89** |

View wins (overall): A 6.3, Eh 11.3, F 1.3. View wins (clay): A 0, Eh 5, F 14.

## 3. Build time per stage

All times are in seconds. "Building" means the stages that build the structure (E's remesh/massing, grammar = inference and enhancement, relief). Tiles and trees are excluded. E and Eh were rebuilt with replayed model answers where recorded, so they are faster than cold builds (721 Broadway was all live). F's first reading call was live (15–18 s); the table's F read for Puck, Haughwout and Jefferson is the replayed rerun (0.6–1.3 s). With the live read, F totals are about 15 s higher.

| Place | E (massing / inference / relief = total) | Eh (massing / inference+enhance / relief = total) | F (E massing + read / generate / check / adjust / final build+texture = total) |
|---|---|---|---|
| Puck | 6.6 / 87 / 19 = 112 | 4.7 / 259 / 25 = **288** | 6.6 + 1.3 (live 18.0) / 0.3 / 0.8 / 26.9 / 4.2 = **42** (live ≈ 59) |
| 721 Broadway | 10.9 / 148 / 86 = 245 | 9.5 / 421 / 18 = **448** | 10.9 + 15.1 / 0.3 / 2.2 / 72.3 / 8.5 = **114** |
| Haughwout | 3.1 / 17 / 10 = 31 | 2.6 / 182 / 62 = **246** | 3.1 + 0.7 (live 15.2) / 0.1 / 0.3 / 5.4 / 1.6 = **12** (live ≈ 26) |
| Jefferson | 7.2 / 78 / 13 = 99 | 6.5 / 263 / 13 = **282** | 7.2 + 0.6 (live 17.1) / 0.1 / 0.3 / 12.5 / 4.0 = **26** (live ≈ 43) |

F with a live reading takes 10–25 % of Eh's time. Its largest stage is the adjustment: 72 s on 721 Broadway's 22 seen walls.

## 4. Render-compare before and after adjustment (F against the tile, same cameras)

| Place | Seen walls | Window NCC | Edge distance (m) | Wall depth MAE (m) | Depth within 0.15 m | Oblique silhouette IoU | Top IoU | Objective by round |
|---|---|---|---|---|---|---|---|---|
| Puck | 10 | 0.001 → 0.092 | 0.477 → 0.449 | 0.347 → 0.238 | 0.23 → 0.42 | 0.858 → 0.859 | 0.737 → 0.721 | 0.675 → 0.674 → 0.620 → 0.586 → 0.572 → 0.566 |
| 721 Broadway | 22 | −0.017 → **0.337** | 0.372 → 0.209 | 0.349 → 0.245 | 0.26 → 0.39 | 0.894 → 0.896 | 0.737 → 0.732 | 0.683 → 0.627 → 0.469 → 0.450 → 0.440 → 0.436 |
| Haughwout | 2 | 0.311 → **0.415** | 0.269 → 0.245 | 0.303 → 0.230 | 0.30 → 0.44 | 0.688 → 0.688 | 0.508 → 0.508 | 0.468 → 0.454 → 0.400 → 0.368 → 0.362 → 0.357 |
| Jefferson | 28 | 0.017 → 0.040 | 0.355 → 0.347 | 0.527 → 0.504 | 0.14 → 0.15 | 0.849 → 0.849 | 0.565 → 0.566 | 0.765 → 0.756 → 0.730 → 0.728 → 0.724 → 0.723 |

The rounds are: start, storey grid, per-wall lattice grid, then coordinate rounds 1–3.

- On 721 Broadway and Haughwout, the adjusted lattice lands on the tile's windows and piers. See `walls/tisch_walls_F_openings.png` and `walls/haughwout_walls_F_openings.png`: red is F's openings, green F's bands and piers, both drawn over the tile ortho.
- Silhouette barely moves. The massing is E's, and the only silhouette knob is the parapet.
- Haughwout's top IoU (0.51) is low because the isolate keeps neighbouring roof fragments and a water tower that F does not model.

## 5. Where F fails (what it could not express)

- **Texture is the loss.** F's walls carry the tile photo baked flat onto clean geometry: melted, de-lit, smeared at street level. Eh's Nano Banana Lite plates win realism by about 1.2–2.1 points at Puck and Haughwout. Where Eh's plates did not reach the views (Jefferson, 721 Broadway), F ties or beats Eh. It still does not beat the raw tile textured, except Jefferson against Eh.
- **Arches and non-rectangular openings.** Puck's round-arched arcades, Haughwout's arched bays and Jefferson's pointed Gothic windows all become rectangles. The model named each of these in `features`, but no operator takes them.
- **Irregular composition (Jefferson).** A single bay lattice cannot hold an asymmetric Gothic front. The adjustment kept window NCC near 0.04, and only 77 openings landed on 35 facets (12 rejected by the facet clipper). Modelled-volume facets take no sweeps, so Jefferson has no bands.
- **Per-wall variety.** One reading per building gives every wall the same storeys. Puck's double-height second storey and its penthouse walls fit badly: window NCC is only 0.09 after adjustment.
- **Roofscape.** Water towers, greenhouses and bulkheads are boxes at best. 1 of 6 raised volumes at Puck and 4 of 7 at 721 Broadway were dropped because they did not fit inside their roof.
- **Parapet.** The silhouette round chose a 2 m parapet at Puck for a 0.001 IoU gain. It reads as a slab ring in the obliques. A minimum gain would have kept the read 1.5 m. This was not changed after scoring.
- **Geometric floor.** F is light: Haughwout has 6.2 k vertices, Puck 25 k and 721 Broadway 33 k. At Haughwout and Jefferson that is under the 25 k scene floor of `GeometricComplexityGate`.
- **Clay is F's strength, with one exception.** F wins clay shape on 14 of 19 views (5.89 against Eh 3.91). The exception is Haughwout, where Eh's measured relief is a little better: 5.93 against 5.27.

## 6. Verdict on the hypothesis

*"F wins or ties on ordinary buildings at a fraction of E's build time, loses on distinctive ones."*

- **Time: confirmed.** F takes 10–25 % of Eh's building time with a live reading.
- **Ordinary buildings: half confirmed.** On 721 Broadway F ties textured (3.22 against Eh 3.28; all arms weak on those views) and wins clay by far (6.89 against 1.72). On Puck F **loses textured** (3.17 against 5.08) while winning clay (5.58 against 3.58).
- **Distinctive buildings: not confirmed as a clean loss.** At Haughwout F loses textured (3.40 against 5.67) and loses clay narrowly. At Jefferson F **beats Eh** both textured (4.42 against 4.08) and in clay (5.50 against 5.00), though the raw tile still wins textured (5.33).

The evidence points to a different split. F's procedural geometry is the best shape on 3 of 4 places. Its texture (the tile photo, option a) is what loses, wherever Eh's AI plates reached the held-out views.

## 7. Recommended next step

Combine the two: F's geometry with E's enhanced texturing. That means Eh's plate redraw run on F's walls (option b), with F's openings and lattice as the plate's structure guide. F's walls share E's massing planes, so the plates' face frames map one to one.

After that:
- add an arch-head parameter (a continuous head rise on openings, as a sweep or relief profile) so the arched fronts stop reading as rectangles;
- allow per-wall storey overrides from the per-wall grid.

Re-score on these 19 views.

## 8. Reproduction

- **Builds.** E and Eh: `SCRATCHBOX_STAGED_PIPELINE=e [SCRATCHBOX_STAGED_ENHANCE=0]` through the tool entry with `staged-replay.ts`.
- **F:**

  ```
  SCRATCHBOX_REPLAY_DIR=<rec> node -r ts-node/register -r ./scripts/dev/staged-replay.ts scripts/dev/version-f.ts <cache>/staged_location/pipeline_e/<key> "<place>" <out> --runs <cache>/staged_location/runs
  ```

- **Evaluator.** `scripts/dev/photo-match-eval.ts <manifest>` with arms A / Eh / F, `clay: true` and `treeLod: true`.
- **Tests.** `packages/core/test/staged-version-f.test.ts`: 6 tests, synthetic, no model calls. They cover parsing, storey lines, the prompt, the generator (5.1 k vertices, 0 residual nodes, all four labels, party wall blank above a 9 m neighbour, hidden walls `generated`, rendered and drawn offsets agreeing above 97 %), the loop chains, and the adjustment recovering a known lattice (window NCC above 0.8, storeys within 0.25 m / 0.1 m).
- **Screenshots** in `test-results/screenshots/version_f/`:
  - `bakeoff/` holds the judged grids;
  - `oblique/<place>_oblique{45,225}[_clay].png` are A | Eh | F;
  - `oblique/<place>_F_alone.png`;
  - `walls/` holds the lattice overlays;
  - `synthetic_generator.png`.
