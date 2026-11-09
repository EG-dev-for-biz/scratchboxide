# K-D district in the cloud: shown in 3 minutes

**Date:** 2026-11-08 · **Branch:** `feat/kd-building-fanout` · **Status:** design, from measured runs; not built yet.

**User decision (2026-11-08):** "under 3 minutes" means the district is **shown and explorable** in 3 minutes, with the
model-refined detail (reader glass, material sets, upscaled facades) arriving after. It does not mean fully finished.

## What was measured (Penn Station, 2 Penn Plaza, fresh, `SCRATCHBOX_CACHE_RESTORE=off`)

Run `b3b2e8c3`, 150 m: 9 ground cells and 28 building tasks (`SCRATCHBOX_KD_CHUNK_UNIT=building`), 8 vCPU / 32 GiB each,
all at once on Cloud Run. The parent build also ran in Cloud Run (`kd-district-driver`).

| Piece | Time in the cloud |
| --- | --- |
| Ground cell (120 m, K's facade work off) | 273–415 s |
| Small building task (radius 16–60 m) | 650–950 s |
| Large building task (Penn 2 / MSG block, 81–91 m) | over 1,200 s, still in facade upscale at 20 min |
| Cold start of a task (execution created → node running) | ~40 s, of which ts-node ~15 s |
| Place-store open of Penn (398 objects, 446 MB), in-region | 9.1 s at 32 reads at once (14.8 s at 6) |
| Same open from the Mac | 24 s at 32 (44–60 s at 6) |

**Why a small building took 9 minutes** (chunk 14, a 23 m building, 561 s of build): geometry was about 50 s
(tile_refine 1.5 s, K 33 s, wall grammar 5 s, polish 7 s). The rest is fixed work per building, whatever its size:

| Step | s | What it is |
| --- | ---: | --- |
| `twin.materials` | 212 | 8K texture-library maps downloaded and decoded on an empty disk (65 GB across the district's tasks) |
| `twin.facadeUpscale` | 135 | 12 `gemini-3-pro-image` calls |
| `remesh.buildingSystem` | 73 | model read of the building's window system |
| `remesh.facadeRead` + `twin.facadeRead` | 70 | the facade reader, ~90 `gemini-3.8-flash` calls |

113 model calls took about 845 s of summed model time inside a 561 s build. A cell task spreads this over many
buildings; a building task pays all of it for one building. So **a task per building does not get a district under the
slowest cell**: the time is model calls and texture preparation, not CPU, and more machines do not shorten it.

## The design

### 1. Known places open from the store (seconds)
- The app server runs as a Cloud Run service with one warm instance (`min-instances=1`) in us-central1, beside the bucket.
- A place already in the place store opens with no rebuild: manifest, objects and readings pulled 32 at once
  (`PLACE_STORE_PARAMS.pullConcurrency`, landed on this branch). Penn: 9 s in-region.
- This is the only way any place opens in seconds. A fresh place takes the build below.

### 2. A fresh build in three bands, by what each piece needs
The district is shown when band A is in; bands B and C stream in after.

**Band A: shown (target ≤ 3 min wall).**
1. *Scan per cell* (the 120 m cells, as today): tiles from the GCS tile mirror, seam weld, tile_refine, trees, ground,
   streets. Cells in parallel, one task each. Measured ~2 min of build for a cell before its textures.
2. *Geometry per building* (one task per building, as on this branch): K's straightening, window fit, wall grammar,
   lattice, polish; **no model calls, no material sets, no upscale**. ~50–90 s for a small building, more for a block.
3. *Photo textures*: the twin de-lit, roof shadow lifted and harmonised; photos only (no material regions).
4. *Join*: the cell join and seams, unchanged; buildings placed by their footprints (`chunkOwner` with the 1 m reach).

**Band B: model-refined (target ≤ 8 min).** One district-wide model pool, not calls from inside each task:
- the facade reader, the building system read, the window reader: queued per plane, run against one budget for the
  whole district (`SCRATCHBOX_MODEL_CALL_BUDGET` today divides the budget per chunk instead);
- answers cached by content (the model readings store, `SCRATCHBOX_MODEL_READINGS_DIR`, mirrored in GCS), so a rebuild
  asks only about what changed;
- each building's glass and lattice re-drawn from its answers and re-published as a new layer version (the object store
  already versions layers).

**Band C: finish (whenever it is done).** Material sets (`twin.materials`) and facade upscale, per building, published
as they finish. Neither is on the path to "shown".

### 3. Fixed costs taken out of every task
- **Texture library prepared once**: each set's maps resampled to the texel sizes builds use and stored as raw tiles in
  GCS (or baked into the image), read by key. This removes the 212 s and the 65 GB of downloads a district.
- **Image**: TypeScript compiled to JavaScript at image build (no ts-node at start, ~15 s a task); native engines
  already precompiled (`kd-chunk-job.ts --warm`).
- **Runner**: a task's outcome is read when its "chunk built" line arrives, not when the job exits after mirroring its
  caches (landed on this branch; it was ~45 s a task).

### 4. Infrastructure
| Piece | Where |
| --- | --- |
| App server | Cloud Run service, 8 vCPU / 32 GiB, `min-instances=1` |
| District parent (plan, join, seams, publish) | the app server, or a Cloud Run job (`kd-district-driver`, working today) |
| Cells, building geometry | Cloud Run jobs, one task each, scale to zero (quota: 8,000 vCPU in us-central1, 180 runs/min) |
| Model pool | a Cloud Run service draining a Cloud Tasks queue, one rate limit for the district |
| Vertex AI | provisioned throughput for `gemini-3.8-flash` and `gemini-3-pro-image` (see below) |
| Data | GCS: tile mirror, place store, model readings, prepared texture library, cache mirror |

**Vertex quota.** These models run on Vertex's dynamic shared quota: there is no per-project requests-per-minute figure
to raise. A 100-building district asks ~10,000 `gemini-3.8-flash` and ~1,200 image calls (113 a building measured; the
image calls are band C). To keep band B under 5 minutes that is ~2,000 flash calls a minute at peak, which needs
provisioned throughput rather than shared capacity. Every transient retry is now logged with its status
(`[gemini] transient 429: retry …`), so the first full run gives the real 429 rate.

## Order of work
1. **Band A path** (the 3-minute goal): a `shown` mode of the chunk build that skips the model steps, material sets and
   upscale (`remesh.facadeRead`, `twin.materials` and `twin.facadeUpscale` are `request.steps` switches already; the
   building system read has only `SCRATCHBOX_K_BUILDING_SYSTEM=0` and needs a step switch), and publishes the district when every cell and building has its geometry and photo textures.
   Measure at Penn 150 m, then 250 m.
2. **Prepared texture library** in GCS (needed by band C, and removes the largest fixed cost).
3. **Model pool** with one district budget and the shared readings store; band B re-publishes per building.
4. **Image**: compiled JavaScript; tile mirror read first.
5. **Warm app server** on Cloud Run with the place-store open.

## Not measured yet
- The 4 vCPU task size (job `kd-chunk-job-fanout-4c` is deployed; not run).
- Identity of a cloud building task against the same build on the Mac (the Mac is arm64 with Apple clang, the job x86
  with clang 19: byte identity is not expected; a pixel diff is the fair test).
- Cost per district: so far about $0.06–0.23 a task in compute; the model share is in each run's `model_calls`.
