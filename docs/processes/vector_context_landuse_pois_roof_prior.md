# Process: Google vector context in the staged pipeline — land use, POI names, the volume roof prior, the by-name footprint pick, and the roadmap cleanup

> **Recorded:** 2026-10-23
> **Status:** Verified (unit suites green; headless Haughwout gate equal to origin/main; Fallingwater pick fixed headless, its rebuild still blocked by the massing roof check)
> **Tags:** `staged-location` `google-vector-data` `structure-pick` `procedural-ground` `pipeline-e` `pipeline-g` `location-evidence` `photo-match`

---

## 1. Session Context

* **What prompted this session:** a live test of the front-page 3D Building button drew Fallingwater and produced a 300 m textured forest district with no house (run `a44d2ee7`, 8 min 13 s, finished degraded). Root cause measured: Places resolves "Fallingwater, Mill Run, Pennsylvania" to the road address 116 m from the house; Google's vector data has the house (53 × 53 m, 6.5 m) 100 m west and the nearest building at 42 m, so the 40 m vector search (`VECTOR_ISOLATE_RADIUS_M`) skipped and the 30 m structure seed took trees on the slope and grew to the 150 m cap. The user then asked for more leverage of the three Google data paths (grounding images, feature tiles, roadmap session) and approved six items.
* **Instance used:** none for the builds (all five dev-server slots were held by other chats). Builds ran headless through `scripts/dev/staged-replay.ts` with a new `--procedural true` flag (`SCRATCHBOX_ROOT=<worktree>`), billing Google as a real run does.
* **Scope:** branch `vector-context` (plumbing commit `8638cbe2`, five agent branches merged, pipeline H from main merged in).

---

## 2. What Was Tested & What Worked (Verified)

* **Feature-tile contents, probed live** (`fetchVectorTile`, Flatiron and Fallingwater tiles, z14–z18): land-use polygons carry type codes (`FEATURE_TYPE_PARK`, `PARKING_LOT`, `MIXED_FOREST`, `URBAN_AREA`, `LAND_COVER`), POIs carry `name` ("Worth Square", a `FEATURE_TYPE_HISTORIC` POI at Fallingwater), roads are **bare `FEATURE_TYPE_ROAD` at every zoom** (no class). The decoder already kept all three; the staged evidence dropped them.
* **Plumbing** (`vector-footprints.ts`): `VectorEvidence.landuse` (loops + types), `pois` (x, z, types, name), `roadTypes`; `evidenceLookup(...).landuseAt(x, z)`. Labels only. `vector-evidence-context.test.ts` 2/2.
* **Structure pick by the footprint the place names** (`extraction-sizing.ts` `chooseFootprint`: footprint under the point → footprint holding the POI with the most request-word overlap → nearest within `CONTAINMENT_MAX_RADIUS_M`; the component bounded by it; vector search radius = max(40, 150) m; the extraction grows to the chosen footprint's reach; `roadAt` cells never structure; canopy under a land-use area never a roof garden). Coexists with pipeline H's `seedFromVector`. `structure-isolation.test.ts` 14/14, `location-isolate-structure` 10/10, `district-containment-radius` 5/5.
* **Ground program from land use** (`procedural-ground.ts` v2 `buildGroundProgram`): per region measured openShare, canopyShare, roadShare, roughness, photo greenness → material (planted / paved), `generated` provenance with the reason, per-vertex `_SB_GROUND_REGION`; an unknown code flows through unchanged. `procedural-ground-landuse.test.ts` 9/9.
* **Volume roof prior** (`pipeline-e/volume-roof-prior.ts`): the modelled volume's top surface as planes (pitch, fall, area, plan) and height tiers; `reconcileTiers` takes the volume outline where the scan agrees (height within 1.5 m, IoU ≥ 0.6), `decideRoof` takes a volume plane as a candidate or corroboration, `vector-modelled` provenance with the residual. `volume-roof-prior.test.ts` 9/9 after fixing the test's own gable geometry (its 20 m-wide gable used a 6 m half-width; the prior's 19.1° was right).
* **POI names** (`building-name.ts`; brief `names` + `nearbyPois`; weak-wall references search "Flatiron Building, New York" instead of the street address). `building-name` 6/6, `pipeline-g-brief` 5/5, `pipeline-g-references` 5/5.
* **Roadmap cleanup + ortho judge view**: dead `createSession`/MVT parser removed from `GoogleVectorTileService`; `ortho-reference.ts` (Static Maps satellite GSD + orthographic camera) and an opt-in `includeSatelliteOrtho` on `photo_match_evaluate`. `ortho-reference` 4/4, `photo-match-eval-ortho` 4/4, `photo-match-evaluate-tool` 9/9, `instruction-tool-drift` 87/87.
* **`location_building_shape` context**: `context.names`, `nearbyPois`, `landuse`, `roads`, `volumeRoofPrior`; a footprint holding a POI named like the request within `nameSearchMeters` (150 m) is taken when neither containment nor the 12 m snap finds one. `location-building-shape-tool.test.ts` 7/8 (see §3).
* **Haughwout gate, headless, same machine, load < 4:** origin/main `26b9c408`: 321 s, pipeline H `l2g` 29,453 tris, 2 degradations (footprint lock: 931 remesh / 71 grammar vertices up to 5.04 m outside the footprint). Merged branch `46df5ed1`: 368 s (run alongside a second build), 29,993 tris, the same 2 degradations. Equal within noise; no new degradation. The user's app benchmark (2 min 56 s, 38,676 tris, 0 degradations) includes the texture stage and predates main's footprint lock; the two footprint-lock degradations come from main (`390ee3da`), not this branch.
* **Fallingwater, headless on the merged branch** (run `9a9bc215`, 26 s): vector committed (the house, 228 tris), extraction 25 → 64 m, remesh 4,312 tris of the house, plan IoU 0.75 against the footprint (`docs/screenshots/vector_context_2026-10-23/02_*.png`, `03_*.png`).

---

## 3. What Broke / Didn't Work

* **Fallingwater still has no procedural rebuild:** pipeline E rejected the massing ("roof 5.34 m off the scan's, median; at most 3 m allowed", 10.9 m at the 90th percentile) so H/G reported `pipeline_g_unavailable`; the fit degraded (75 % of the scan kept as scanned); no Street View pano looks at it. The scan under the forest canopy is poor. Per the 2026-10-23 rule (scan leads; loosen checks that fail builds) the roof check should let the scan's terraced roof lead — queued, not done here.
* **Road classes are not available** from the feature tiles at any zoom, so "widths and sidewalks per class" was not built; SB-Roadie's measured kerbs stay the width source.
* **SB-Veggie has no understorey input:** the ground program's planted regions reach the vegetation service as a validated `groundCover` request recorded with `planted: 0` and its reason; nothing is faked.
* **`location-building-shape-tool.test.ts` "missing vector credentials" case** fails in any worktree that symlinks `.env`: `resolveApiKey` → `tryLoadLocalEnv()` finds a Maps key, so the no-key path cannot be set up there. It passes where `.env` is absent (the agent worktrees). Pre-existing; not changed.
* **The first headless baseline** (HEAD `8638cbe2`, during the parallel agent runs at load ~108) hit pipeline G's 900 s grammar budget; a gate is only valid against a same-load baseline.
* **Type errors on origin/main** in `surface-material-tools.ts`, `weathering-tools.ts`, `pbr-library-match.ts` (not touched by this branch) make `npm run typecheck` red independently of this work.

---

## 4. Candidate Tool/Service Ideas

* **Massing roof check that lets the scan lead** for terraced/cantilevered roofs (Fallingwater): replace the 3 m median gate with the volume prior + scan tiers, failing only when both disagree.
* **One evidence call for the chat model:** `location_building_shape` now carries the context; the staged pipeline's own pick notes (`choice.note`, `seededOn`) could be exposed the same way for a place without running a build.
* **Grounding pitch ladder** and **registered-pano measured openings** (from the brainstorm) remain the next imagery items.
* **Static Maps ortho as a routine judge view** once a capture date can be read for it.

---

## 5. Reproduction Steps

1. `git worktree add .claude/worktrees/<name> vector-context`; symlink `node_modules`, `desktop-app/node_modules`, `secrets.json`, `service-account.json` (no `.env` if the credential test matters).
2. Unit suites: `HOME=/tmp/empty env -u GOOGLE_APPLICATION_CREDENTIALS -u GEMINI_API_KEY -u SCRATCHBOX_GEMINI_API_KEY npx vitest run --root <worktree> packages/core/test/{vector-evidence-context,structure-isolation,procedural-ground-landuse,volume-roof-prior,building-name,pipeline-g-brief,pipeline-g-references,ortho-reference,photo-match-eval-ortho,location-building-shape-tool}.test.ts`.
3. Headless gate: `SCRATCHBOX_ROOT=<worktree> TS_NODE_TRANSPILE_ONLY=1 TS_NODE_SKIP_PROJECT=1 TS_NODE_COMPILER_OPTIONS='{"target":"ES2022","module":"commonjs","moduleResolution":"node","esModuleInterop":true}' SCRATCHBOX_REPLAY_PRINT_DIGEST=1 node --expose-gc -r ts-node/register scripts/dev/staged-replay.ts --runs 1 --procedural true --query "E.V. Haughwout Building, 488 Broadway, New York"` (bills Google); compare against the same command on origin/main at the same load.
4. Live probes of the tiles: the scratch scripts in this session fetched `GoogleVectorTileService.fetchVectorTile(x, y, z, '')` and counted `properties.types` per layer.
