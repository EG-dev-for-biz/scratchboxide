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

## Band A measured (2026-11-09, run `be77c251`, `SCRATCHBOX_KD_BAND=shown`)

Same place, same radius, fresh, 8 vCPU / 32 GiB, the parent in Cloud Run:

| | Full band (`b3b2e8c3`) | Shown band (`be77c251`) |
| --- | ---: | ---: |
| District complete, end to end | 27.1 min | **6.5 min** (392 s) |
| Building tasks | 10.8–21.2 min | 2.0–4.4 min |
| Ground cells | 1.4–6.9 min | 2.4–3.4 min |
| Compute | $5.33 | $1.31 |
| Model calls / cost | 5,639 / $9.13 | 0 / $0 |
| 429s (logged retries) | 0 | 0 |

The full band's 156 failed model calls were deadlines on the slower fallback models (often hedged duplicates), not quota.
Timing sheet: `docs/screenshots/kd-cloud-timing-sheet.png` (gitignored; sent with the report).

**Where the 6.5 minutes go:** the last chunk lands at 290 s; the parent then reads the seam colours (8 s), closes the
seams chunk by chunk (50 s), audits every layer (25 s) and writes overlaps and the place store (17 s), all after the last
chunk. The slowest task (the Penn 2 block, 263 s in the cloud) is 189 s of build (K 49 s, twin 35 s, polish 29 s, window
fit 26 s, window array 12 s) and 74 s of start, cut and upload; every shown task carries 70–80 s of that overhead.

**What still blocks 3 minutes, ranked by estimated saving:**
1. *The parent's tail* (−90 s): close each chunk's seams as it lands (the order can follow arrival), audit after the
   district is shown, write the place store in the background.
2. *Task overhead* (−40 to −50 s a task): compiled JavaScript in the image (ts-node ~15 s), the image kept warm (a new
   image's first import took 33 s), outcome polled every 2 s instead of 10 s, layers uploaded as each stage commits.
3. *The longest building* (−60 to −90 s): the Penn 2 block's K and polish run single-threaded per facade group; split a
   block-sized building's facades across the task's 8 cores, or show its scan first and swap its straightened facades in.
4. *Cells* (−30 s): cells at 141–202 s keep building facades that are cut away; skip remesh work inside footprints.

With 1 and 2 the shown band at Penn 150 m is about 4.5 min; with all four, about 3 min.

## The tail and the start, cut (2026-11-09, same place, fresh, shown band)

| Run | Change | Shown | Slowest task |
| --- | --- | ---: | ---: |
| `be77c251` | first shown run | 392 s | 263 s |
| `9b41cf60` | JavaScript image (no ts-node), runner reads progress every 2 s, building layers not seamed, no place audit | 395 s | 320 s |
| shown3 | the cells' seams closed while the buildings build | 334 s | 320 s |
| shown4 | slim node base (image 1,039 → 749 MB) | **296 s** | 282 s |

- **The tail is gone:** the seams start when the last cell lands (228–245 s) and are closed before the largest building
  lands; the district is shown one second after its last chunk.
- **The start did not move:** Cloud Run reports every task "started deployed execution in 1m29s–1m30s", on the JavaScript
  image and on the slim one alike (the image itself imports in about a second). It is the time Cloud Run takes to start
  an 8 vCPU / 32 GiB task, not our code or the pull. Removing it needs instances that are already running (below).
- **Identity:** the two shown runs `be77c251` (ts-node image) and `9b41cf60` (JavaScript image) built every one of their
  34 chunks to the same bytes: 110 of 110 layers, 1.19 GB, identical binary chunks (only the cut stamp's run id differs).
- **Variance:** the largest building's build moved between 190 and 231 s from run to run on the same input.

**What still blocks 3 minutes (296 s now):**
1. *Cloud Run's task start* (−80 to −90 s a task): a pool of warm 8 vCPU workers (a Cloud Run service with min instances
   or a worker pool, scaled up when a district is asked for) taking chunks from a queue, instead of one job execution
   per chunk. This alone gives about 3.4 min at Penn.
2. *The largest building* (−40 to −60 s): its K remesh (80–137 s) and twin (30–56 s) per facade group in parallel on the
   task's cores, or its scan shown first and its straightened facades swapped in.

## The worker pool and the window array on threads (2026-11-09)

- **The pool** (`kd-chunk-job.ts --serve`, `CloudRunServiceJobs`; `deploy.sh service`): the chunk build as a Cloud Run
  service, 0 instances between districts, one chunk an instance (it exits after), request-based billing: idle cost $0/h.
  A new instance started in about 8 s median (2-30 s) against a job task's 90 s. **Penn shown in 244-251 s.**
- **Warm reuse was slower, not faster:** a reused instance built the same bytes (110/110) but its native steps took about
  twice as long; hence one chunk an instance.
- **The window array's first pass on the worker threads:** 15-24 s → 6-11 s on the largest buildings, the same bytes.
- **Identity:** jobs vs pool, 110 of 110 layers byte-identical.
- **Contention:** the largest building (chunk 26) built alone in 169 s, in 230 s beside 33 others.

**Still blocking 3 minutes (244 s now):** the largest buildings' build (169 s alone): the twin's de-light and PNG encoding
(22 s) and the stage cache's publishing (13 s) on the main thread are next; and contention in the fan-out (+25-35%).
Findings record: `docs/processes/2026-11-09-kd-cloud-fanout.md`.

## Second round (2026-11-09): 240 s, and what remains is the pool's CPU

The twin's de-light and encode moved to the PNG codec threads (textures ~30% faster on the largest buildings) and the
largest extractions start first: **Penn shown in 240 s**, byte-identical. Spreading the pool across two regions did not
help (248 s). The largest building builds in 146-149 s alone as a Cloud Run job task but 193-211 s alone on a service
instance (request- or instance-billed, gen1 or gen2): the pool's CPU is ~35% slower in the native multi-threaded steps.
Under 3 minutes needs the few largest chunks on job-class CPU with a fast start (suspended Compute Engine VMs, or GKE
Autopilot's Performance class); details in `docs/processes/2026-11-09-kd-cloud-fanout.md`.

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
