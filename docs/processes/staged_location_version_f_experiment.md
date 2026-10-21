# Staged Location Builds: Version F experiment (procedural-first rebuild, the tile only as a reference)

> **Recorded:** 2026-10-19
> **Status:** Experiment, branch `version-f-experiment` (from origin/main 63643b5d; dc29d42f merged for round 2). Not on main, off by default. Round 1: hypothesis **rejected as stated** (the split was shape against texture). Round 2 (§9): F's geometry with E's enhanced texturing (F2) is the best arm overall on the same 19 views (4.61 against Eh 4.46) and keeps F's clay lead, but still loses to Eh textured at Puck and Haughwout.
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

## 9. Round 2 (2026-10-20): E's enhanced redraw on F's walls, arch heads, arcades, per-wall storeys

origin/main dc29d42f was merged first. Its sweep change, parapets relative to the wall top, is adopted. Commit `45014935`.

### What changed
1. **Texture: E's redraw on F's walls (`version-f/f2.ts`, `SCRATCHBOX_STAGED_GEOMETRY=f` with pipeline E; experiment only).**
   - **Where it runs.** The grammar stage builds version F instead of E's inference: `runVersionFEnhanced`.
   - **Survey first.** The Street View survey that enhanced mode runs anyway (registered, cut out) is awaited first. Its two best photos join F's reading.
   - **The redraw.** F's plan (read, generate, check, adjust) then gets pipeline E's own redraw, `enhanceWall`:
     - Nano Banana Lite plates and `buildTexturePlatePrompt`;
     - the identity gate and the region audit;
     - Street View guidance;
     - up to 4 unseen walls.
   - **One to one.** The redraw runs on the massing's walls, which F shares exactly (the same planes and frames).
   - **Structure guide.** Each redraw is also shown F's planned structure of that wall as a last image: openings dark, bands and piers light, outside black. The sentence sent with it says it is shape only, so no colour is taken from it.
   - **Labels.** Accepted texels are `generated` ("AI-enhanced from tile, guided by version F's structure").
   - **Not run.** E's other texture repairs (occluder fill, averaged bays, straightening, Street View colour) are not run.
   - **Plate cache.** The cache is keyed by the structure picture and its sentence.
2. **Shape vocabulary, all continuous and read in the same vision pass (prompt `version-f/facade-parameters/v2`):**
   - **Arch heads.** Each opening family carries `archRiseRatio` (head rise over half-width: 0 flat, about 0.5 segmental, 1 semicircular) and `apexSharpness` (0 round to 1 equilateral pointed: the two arcs' centres move apart). The head is built with the existing opening operator as stepped slices: about 0.1 m each on walls, 0.18 m on modelled-volume facets, which take nothing under 0.15 m.
   - **Facade bands.** Horizontal zones with their own opening family, `bayGroup` (one opening spans that many bays) and `storeyGroup` (one opening spans that many storeys). These cover arcades and double-height arched storeys.
   - **Per-wall storeys.** `wallStoreys` gives one wall its own storeys. It is read per wall picture and tied to that wall.
   - **Adjustment.**
     - *Knobs:* the adjust loop gains knobs for arch rise and sharpness, and for each band's opening (width, height, sill, rise, sharpness, bottom).
     - *Per-wall grid:* a grid of storey shift and scale for each seen wall.
3. **Round-1 fixes:**
   - **Parapet.** It changes only for a mean silhouette IoU gain of at least 0.01. Puck now keeps the read 1.4 m, where round 1 took 2 m for +0.001.
   - **Raised volumes.**
     - *Fix:* a volume now takes the part under most of it and shrinks towards the middle of what lies on that part.
     - *Remaining drops:* Puck still drops 1 of 3 and 721 Broadway 2 of 5.
   - **Geometry floor.** No padding was added. The vertex counts rise only from real detail (arch heads, arcade openings):
     - Puck: 25 k → 49 k;
     - 721 Broadway: 33 k → 242 k (segmental heads on every window: 4,566 opening rectangles);
     - Haughwout: 6.8 k → 58 k;
     - Jefferson: 7.6 k → 16 k.
4. **F1 rebuilt.** Round 1's builds had been deleted in cleanup, so F1 was rebuilt with `--legacy` and round 1's saved readings. On Puck and 721 Broadway it reproduces round 1's render-compare numbers exactly. Haughwout and Jefferson differ only by main's massing changes.

### Bake-off (round 2)

**Setup.** Round 1's 19 held-out views exactly. No build fetched any of their panos (none dropped). `gemini-4-argon` blind ×3, textured and clay, in context.

**Arms.** All four were judged together:
- **A:** the raw tile.
- **Eh:** pipeline E enhanced, rebuilt on this merge.
- **F1:** round 1.
- **F2:** this round.

Absolute numbers are comparable within this table, not with §2.

**Where the files are.** Grids in `test-results/screenshots/version_f/bakeoff2/`.

**Judge spread.** Within-view sd 0.19 textured, 0.39 clay.

| Place (views) | Overall: A / Eh / F1 / F2 | Realism: A / Eh / F1 / F2 | Identity: A / Eh / F1 / F2 | **Clay shape: A / Eh / F1 / F2** |
|---|---|---|---|---|
| Puck, ordinary (4) | 4.00 / **5.33** / 3.17 / 4.92 | 3.08 / **4.50** / 3.00 / 4.17 | 5.08 / 6.08 / 4.67 / **6.17** | 1.67 / 1.67 / **5.75** / 4.92 |
| 721 Broadway, ordinary (6) | 3.39 / 3.78 / 3.39 / **4.00** | 3.11 / 3.50 / 3.06 / **3.61** | 3.83 / 4.17 / 3.72 / **4.45** | 3.44 / 3.44 / **6.22** / 5.78 |
| Haughwout, distinctive (5) | 3.47 / **5.27** / 3.47 / 4.87 | 3.13 / **4.93** / 3.07 / 4.73 | 3.80 / **5.67** / 3.87 / 5.07 | 3.20 / 5.47 / 5.27 / **6.20** |
| Jefferson, distinctive (4) | **5.25** / 3.58 / 4.08 / 4.92 | **3.92** / 3.08 / 3.17 / 3.50 | **6.42** / 4.83 / 5.33 / 6.00 | 2.58 / 4.50 / **6.25** / 6.17 |
| **All 19 views** | 3.93 / 4.46 / 3.51 / **4.61** | 3.28 / **4.00** / 3.07 / **4.00** | 4.63 / 5.11 / 4.30 / **5.30** | 2.82 / 3.82 / **5.88** / 5.79 |

View wins (overall): A 4, Eh 9, F1 0, F2 6. View wins (clay): A 0, Eh 2, F1 9, F2 8.

- **The texture fix works.** F2 raises F's textured score by +1.10 overall (3.51 → 4.61), realism by +0.93 and identity by +1.00. The gain holds at every place, from +0.84 (Jefferson) to +1.75 (Puck).
- **F2 is the best arm on all 19 views,** narrowly against Eh (+0.15 overall, realism tied, identity +0.19). That is within about one judge-spread of Eh. Per place:
  - **721 Broadway (ordinary):** F2 is the best arm of all four.
  - **Jefferson:** F2 beats Eh by +1.34 but stays under the raw tile.
  - **Puck and Haughwout:** F2 stays under Eh (−0.41 and −0.40).
- **Clay: F2 keeps F's lead over Eh (5.79 against 3.82).** It is best at Haughwout, where the arch heads land on the cast-iron arcade. It is slightly under F1 at Puck, 721 Broadway and Jefferson:
  - **Puck:** the read arcade bands become 3-bay openings 8 m tall, which read as tall slots, not arches, from the street.
  - **721 Broadway:** the segmental heads add little at street distance.
  - **Arches in general:** they show clearly on the walls themselves (`plates2/haughwout_wall3_F_structure.png`). From the held-out views they are mostly hidden by the street foreground (`closeup2/`).

### The plates and F's lattice
- **Do they agree?** F's openings were compared with each accepted plate's darkness (window NCC) and its strong edges (edge distance on the plate):
  - **Haughwout wall 3:** NCC 0.46, edge distance 0.15 m.
  - **721 Broadway walls 81 / 64 / 70 / 56:** NCC 0.28–0.35, edge distance 0.23–0.26 m.
  - **Puck walls 17 / 19 / 20 / 24 / 25 / 32:** NCC −0.05 to 0.10, edge distance 0.16–0.25 m. The arcade-and-pier plates do not reduce to one lattice.
  - **Jefferson wall 97:** NCC 0.0.
- **Which follows which?** F was then let follow each plate: per wall, bay pitch, phase and storey shift searched against the plate. Both versions were then compared against the tile from the same cameras. The rule is the adjust objective (lower is closer).
  - **Haughwout:** plate follows F; 0.375 as planned against 0.387 following the plate.
  - **Puck:** plate follows F; 0.562 against 0.589.
  - **Jefferson:** plate follows F. No plate moved the lattice, so F stays as planned.
  - **721 Broadway:** F follows the plate, chosen by a negligible margin: 0.449 against 0.447.

  So the plate follows F on 3 of 4 places. The alternative layers are written beside the chosen ones (`version_f2_alt_*`) but were not judged. Choosing by judge would have needed a fifth arm.

### Walls redrawn and accepted
Plates are drawn once per input and cached. Jefferson's first F2 build (before the facet fix) accepted 5 of 12 walls; the redraw is stochastic.

| Place | F2 walls redrawn and accepted |
|---|---|
| Puck | 8 of 11 |
| 721 Broadway | 6 of 12 |
| Haughwout | 3 of 6 |
| Jefferson | 1 of 12, after rebuilding with the facet fix |

- **Rejections are the same gate as Eh's:**
  - the identity count (unseen walls: 1 storey on the tile against 5 on the plate);
  - the region audit (more than 35 % erased or replaced).
- **Before the "shape only" clause:**
  - the first Haughwout F2 test redrew its 31 m Broadway front in near-black, and the audit erased 86 % of it. With the clause, that wall still failed in the final build: 3 of 6 accepted, the Broadway front among the rejected.
  - Haughwout's accepted wall 3 turned the tile's clock into a street lamp (`plates2/haughwout_wall3_tile_vs_plate.png`). The region audit did not flag it, so this is generated content that is not true to the building.

### Build time
All times in seconds. "Building" means massing + grammar (+ relief for Eh; F2 skips relief, `SCRATCHBOX_STAGED_PIPELINE_E_RELIEF=0`). Model answers were replayed where recorded:
- **Live:** F2's Puck and 721 Broadway readings (26 s and 15 s).
- **Replayed:** Haughwout and Jefferson F2 readings (live ≈ 15–23 s).

| Place | Eh (massing / inference+enhance / relief = building) | F1 (E massing + F1) | F2 (massing / Street View survey / F plan (read, adjust) / redraw / agreement / layer = building) |
|---|---|---|---|
| Puck | 6 / 343 / 72 = **421** | 7 + 34 = **40** | 5 / 149 / 64 (26, 34) / 137 / 29 / 5 = **389** (93 % of Eh) |
| 721 Broadway | 10 / 326 / 107 = **443** | 11 + 89 = **99** | 9 / 115 / 120 (15, 97) / 110 / 47 / 12 = **414** (93 %) |
| Haughwout | 3 / 212 / 76 = **292** | 3 + 8 = **11** | 3 / 115 / 10 (1, 8) / 85 / 4 / 2 = **220** (75 %) |
| Jefferson | 6 / 223 / 71 = **300** | 7 + 18 = **25** | 7 / 65 / 17 (1, 15) / 186 / 1 / 3 = **280** (93 %) |

F2 costs about what Eh costs. The redraw (85–186 s) and the Street View survey (65–149 s) dominate. F's own plan is 10–120 s. F's round-1 speed advantage is gone once the plates are drawn.

### Render-compare, before → after adjustment (F2), and F1 after for reference

| Place | Window NCC | Edge distance (m) | Wall depth MAE (m) | Oblique silhouette IoU | F1 after (NCC / edge / depth) |
|---|---|---|---|---|---|
| Puck | 0.030 → 0.094 | 0.515 → 0.494 | 0.289 → 0.217 | 0.856 → 0.855 | 0.092 / 0.449 / 0.238 |
| 721 Broadway | −0.008 → 0.376 | 0.371 → 0.259 | 0.346 → 0.273 | 0.895 → 0.895 | 0.337 / 0.209 / 0.245 |
| Haughwout | 0.322 → **0.465** | 0.266 → 0.220 | 0.246 → 0.215 | 0.694 → 0.694 | 0.421 / 0.245 / 0.214 |
| Jefferson | 0.007 → 0.030 | 0.392 → 0.419 | 0.516 → 0.486 | 0.849 → 0.848 | 0.043 / 0.447 / 0.487 |

The arch heads raise window NCC at Haughwout (0.42 → 0.47) and 721 Broadway (0.34 → 0.38). Puck and Jefferson are unchanged within noise.

### Not solved
- The plates still carry generated content the audit does not catch (Haughwout's clock drawn as a street lamp).
- Jefferson's Gothic facets mostly refuse the redraw (1 of 12), and its facets take no bands.
- Puck's read arcades are too coarse as slots.
- 3 raised volumes are still dropped (Puck 1, 721 Broadway 2).
- The plate-or-F choice is made by render-compare only; the judge did not see the alternative.

### Verdict and next step
- **The texture fix works:** F2 is the best arm overall, it closes most of the texture gap to Eh, and it keeps F's geometric lead in clay.
- **Not decisive:**
  - F2 still loses textured to Eh at Puck and Haughwout, by about 0.4;
  - it beats Eh mainly where Eh's own inference was weak (Jefferson, 721 Broadway);
  - it no longer saves build time.
- **Next steps:**
  - judge the `version_f2_alt` layers, F following the plate, as a fifth arm;
  - let the redraw see F's openings only on seen walls (the unseen-wall counts gate rejects them anyway);
  - give arcade bands a pier between grouped bays rather than one wide slot;
  - drop E's Street View survey wait from the read path to recover time.

**Screenshots** (`test-results/screenshots/version_f/`):
- `bakeoff2/`: judged grids photo | A | Eh | F1 | F2, plus clay;
- `oblique2/<place>_oblique{45,225}[_clay].png`: A | Eh | F1 | F2;
- `oblique2/<place>_F2_alone.png`;
- `closeup2/<place>_closeup_photo_F1_F2.png`: the held-out photo, F1 and F2, textured and clay;
- `plates2/`: F's structure guide and the tile / plate / audited plate / Street View strip per place.

Key ones are copied to `scratchpad/shots/version_f2/`.

**Tests:** `staged-version-f.test.ts`, 10 tests (guarded, no model calls). The 4 new ones cover:
- parsing of the round-2 fields;
- arch slices following round and pointed curves;
- bay and storey grouping plus per-wall storeys (round 1's program unchanged with `legacy`);
- a raised volume straddling two parts kept on its host at the scan's height.

## 10. Round 3 (2026-10-21): faster, gated locally, per wall (branch `version-f-round3`, from origin/main 0fa43cb0)

F2 (round 2) cost about what Eh costs (220-414 s) and still let generated content through (a clock drawn as a lamp post). Round 3 keeps F2's split (F's geometry, E's redraw on it) and changes how it is scheduled, scored and gated. `SCRATCHBOX_STAGED_GEOMETRY=f` now runs round 3 (`version-f/f3.ts`); `SCRATCHBOX_VERSION_F_ROUND=2` runs round 2's `f2.ts` unchanged (the F2 arm below was built with it, on this branch).

### What changed

**Speed**

1. **Native render-compare and adjustment** (`scratchbox_version_f_compare.hpp`, the CLI `scripts/version_f_compare.cpp`, the client `version-f/native-compare.ts`, the search `adjustParametersNative` in `adjust.ts`). The per-wall comparison (the program's offset map drawn as rectangles in the wall's frame, then window NCC, edge distance, depth MAE against the tile's evidence) runs in C++20: one process per adjustment holds the seen walls' evidence, every batch of jobs is spread over the cores, and a wall whose rectangles a candidate did not change is answered from memory (a knob that moves one wall re-renders that wall only). The kernel's numbers are the JavaScript reference's to float precision (test). The search itself is batched: the storey grid in one batch; every wall's whole lattice grid (pitch, phase, storey shift and scale) in one batch, each wall keeping its own best (the objective is a sum over walls, so the walls are independent); the coordinate rounds best-first (all knob trials in one batch, the best improving one applied, again until none improves, at most 6 passes per round). The silhouette round's three parapet builds run at once. On the synthetic fixture: 64 ms against 1,553 ms in JavaScript for the same search. On the places: see the stage table.
2. **Scheduled as a graph** (`f3.ts`). The Street View survey starts at once and nothing waits for it until the redraw needs its crops: the reading, generation, check and adjustment run alongside it, and the clay shape is handed to the orchestrator (`onLayer`) the moment the adjustment is done (committed as `l2g` with the tile-photo twin; the same object is replaced in place as walls land, and once more at the end). Every seen wall is redrawn at once, not 3 at a time (`ImageCallGovernor`: at most 12 image calls in flight across the building, a 429 pauses new calls for a doubling back-off as the vision chain's hedge pause does, 5xx and deadlines retry twice), then the unseen walls with a finished neighbour as their reference. The textured twin is written again for the walls accepted so far at most every 12 s while the redraw runs ("textures streamed per wall"). The reading does not wait for the survey, so it sees the tile's pictures only unless the survey was already in (its photos join the reading then).
3. **Agreement: the plate follows F.** Round 2 built F following the plates too and chose by render-compare; F as planned won 3 of 4 places and tied the fourth (0.449 against 0.447). The second build is gone; each accepted plate's window NCC and edge distance against F's openings are still recorded.

**Gates (cheap, local)**

4. **Lattice identity instead of the vision count on strong-fit walls** (`local-gate.ts` `latticeIdentity`). On a wall whose adjusted window NCC against the tile is at least **0.25** (`STRONG_FIT_NCC`; round 2's strong fits were 0.38-0.47, the weak ones 0.03-0.09), a plate's storeys and bays are read against F's planned lattice instead of one `visionFacadeCounter` call per plate. The pass rule is sign-free, because the redraws light the glazing the tile shows dark (a Haughwout sample had its windows lighter than its wall): the magnitude of the plate's lattice correlation with F's openings (the better of darkness and absolute deviation) at least 0.6 of the tile's own NCC against F and at least 0.15, and the mean distance from F's opening borders to the plate's strong edges at most 1.25 times the tile's own (and 0.3 m). Row and column counts along F's storeys and bays are reported, not gated: on Haughwout's cast iron the piers and spandrels contrast as much as the windows, and a first version that gated on them rejected plates that were plainly the same wall (`test-results/screenshots/version_f3/haughwout_smoke_wall{2,3}_samples.png`). Weak-fit walls keep the vision count, run for all three samples at once.
5. **Best of 3** (`f3-redraw.ts`). Each wall is drawn three times at once (one cache slot per sample), every answer goes through the alignment, the identity gate (lattice or vision), the region audit, the Street View check and the feature guard on its own, and the best eligible one by local numbers (lattice correlation + half the photo support − the audit's flagged share − chamfer/60) is the plate. No serial retry: a wall none of whose samples passes keeps its tile texture, with every sample's reason.
6. **Must-keep feature guard** (`local-gate.ts` `featureGuard`). The per-wall reading names the distinct features on each wall picture with a region and open feature-type codes (`sb-feature-types.ts` codes as labels, general to specific; a code not in the catalogue is kept on the feature and logged for review, never added; nothing routes geometry by them). A candidate plate is rejected when, in a region, its band-passed structure no longer correlates with the tile's (within the audit's drift) at 0.3, or loses 60 % of the contrast, or moves the tone by more than 20 dE; a rectified Street View crop that covers half the region may vouch for the plate instead of the melted tile. Haughwout's reading named the clock ("Projecting circular facade clock", `SB_FEATURE_TYPE_FACADE_ELEMENT_CLOCK`, a code the model proposed), the entrance bay, the shopfronts, the awnings and the fire escape.

**Quality**

7. **One reading per seen wall, all at once** (`readPerWall`, prompt `version-f/facade-parameters/v3`). Each call shows the scan from above, that wall with the ruler, the two obliques and the Street View photos, and answers that wall's own storeys, bays, families, bands and features. The largest wall's reading is the building's; every other wall keeps its own (`wallStoreys` now carries bays, families and bands). A wall whose reading fails keeps the building's numbers and says so.
8. **Street View as window evidence** (`refineWithStreetView`). Where a registered photo covers a wall, its rectified crop replaces the tile photo as the wall's luminance evidence (the depth stays the tile's), that wall's lattice and storeys are searched again on the kernel, and the solid is rebuilt when a wall moved. (In these builds the survey registered no view: the Street View branch is being fixed elsewhere; the step ran on nothing and said so.)
9. **Arcade piers and raised volumes** (`facade-program.ts`). A band that groups bays is now one arch per bay between piers over the band's height (`pierWidthM` read per band, else the read piers' width, else 0.4 m), not one slot over the group; the piers are face sweeps. A raised volume that does not fit its roof is no longer dropped: it is shrunk along each axis on its own, else kept as a 1.2 m box slid onto its roof, with the reason in the program's notes; a real object the residual audit measured on the roof under the read box gives the volume its footprint, labelled `measured`.

Round 2's unseen-wall count gate (1 storey on the tile against 5 on the plate) is unchanged in both arms.
