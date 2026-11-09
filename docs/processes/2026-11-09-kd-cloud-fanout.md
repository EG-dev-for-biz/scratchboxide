# Pipeline K-D on Cloud Run: a task per building, the shown band and the worker pool

**Date:** 2026-11-09 · **Branch:** `feat/kd-building-fanout` · **Status:** Measured fresh on the Penn Station district
(2 Penn Plaza, 150 m: 9 ground cells and 25 building tasks, plus the outline-less buildings kept with their cells). Shown in
4.1 min; under 3 min not reached. Design and order of work: `docs/research/2026-11-08-kd-cloud-processing-design.md`.

![timing sheet](kd-cloud-fanout/2026-11-09-timing-sheet.jpg)

## What was built
- **A task per building** (`SCRATCHBOX_KD_CHUNK_UNIT=building`, `district-chunks.ts`): every planned building is a
  chunk of its own beside the 120 m ground cells; the cells build with K's facade work off; the seam stage reads the cells
  only. Needs the cloud runner with its centre in the cloud.
- **The shown band** (`SCRATCHBOX_KD_BAND=shown`, `KD_SHOWN_STEPS`): no model call at all (`models` off strips every model
  client from the build's deps), no material sets, no facade upscale. User decision 2026-11-08: "under 3 minutes" means
  shown and explorable, the refined detail after.
- **The parent's tail:** the cells' seams close while the buildings still build; the shown band is not audited into the
  place store; the run notes when the district is shown (`district_chunks_joined.shownAtMs`).
- **Task start:** the job image runs JavaScript transpiled at image build (`deploy/kd-chunk-job/transpile.js`), on the slim
  node base (1,039 → 749 MB); the runner reads progress every 2 s and a task's outcome at its "chunk built" line.
- **The warm worker pool** (`kd-chunk-job.ts --serve`, `CloudRunServiceJobs`, `SCRATCHBOX_KD_CLOUD_SERVICE`,
  `deploy.sh service`): the same chunk build as a Cloud Run service, 0 instances between districts, one chunk an instance
  (the instance exits after its chunk), request-based billing.
- **The window array's first pass on the worker threads** (`inferWindowArraysOnThreads`): the same `window_fit.json`
  byte for byte (parity tests); 15-24 s → 6-11 s on the largest buildings.
- **Place-store pulls 32 at once:** Penn's 398 objects (446 MB) open in 9.1 s in-region (24 s from the Mac).
- Logged transient model retries (`[gemini] transient <status>`), and a fix for buildings with no outline (NaN task).

## Measured (fresh, `SCRATCHBOX_CACHE_RESTORE=off`, 8 vCPU / 32 GiB a task, the parent in Cloud Run)

| Run | District shown | Slowest task | Compute | Models |
| --- | ---: | ---: | ---: | ---: |
| Full band, jobs (`b3b2e8c3`) | 27.1 min | 21.2 min | $5.33 | 5,639 calls, $9.13, 0 429s |
| Shown band, jobs (`be77c251`) | 6.5 min | 4.4 min | $1.31 | 0 |
| + seams streamed | 5.6 min | 5.3 min | $1.26 | 0 |
| + slim image | 4.9 min | 4.7 min | $1.24 | 0 |
| Shown band on the worker pool | **4.1 min** | 4.0 min | $0.78 | 0 |

- **Start:** a Cloud Run job task "started deployed execution in 1m29s-1m30s" whatever the image; a service instance
  started in about 8 s from zero (median, 2-30 s).
- **Warm reuse:** a reused service instance built the same bytes but its native steps ran about 2x slower; so each
  instance builds one chunk and exits. Idle cost of the pool: $0/h (min 0 instances, request-based billing); the images in
  Artifact Registry are the only standing cost (a few GB).
- **Identity:** 110 of 110 layers (1.19 GB) byte-identical across 34 chunks for three pairs: jobs on the ts-node image vs
  the JavaScript image, jobs vs the pool, and a fresh pool vs a reused-instance pool.
- **Fan-out contention:** the largest building (chunk 26) built alone in 169 s, and in 230 s beside 33 others.
- **Model quota:** at 37 tasks and ~5,600 calls in 25 min, no 429; 156 failures were deadlines on the slower fallback
  models (gemini-2.5-pro, 2.5-flash, 4-argon), often hedged duplicates. These models run on Vertex's dynamic shared
  quota: there is no per-project figure to raise; a burst of 100 buildings (~10,000 flash calls) needs provisioned
  throughput to be sure.

## What still blocks 3 minutes (4.1 min now)
1. **The largest buildings' build** (169 s alone, 210-230 s in the fan-out): on the main thread the twin's de-light and
   PNG encoding (22 s) and the stage cache's publishing (13 s, profiled in the cloud) are the next to move onto worker
   threads; K's rectify, window fit and polish already use the 8 cores natively.
2. **Contention in the fan-out** (+25-35% a building): fewer instances at once for the largest buildings, or those few on
   larger machines.

## Cloud resources (project `scoutscan`, us-central1)
`kd-chunk-worker` (service, 0 instances at rest), `kd-chunk-job-fanout-8c` (job), `kd-district-driver` (job: a district
built headless, `scripts/kd_district_cloud_run.ts`), `kd-chunk-prof` (job: a chunk under `--cpu-prof`, profiles to
`gs://scoutscan-kd-jobs/kd-prof/`), `kd-chunk-job-fanout-4c` (job, not measured). The shared `kd-chunk-job` was not touched.
