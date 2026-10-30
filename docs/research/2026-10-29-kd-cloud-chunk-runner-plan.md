# Pipeline K-D: cloud chunk runner (plan, 2026-10-29)

Status: **plan, waiting for the user's go-ahead.** Nothing has been deployed.

## What changes

The orchestrator's `chunks` stage (`orchestrator.ts`, around line 1742) calls `deps.runChunk(request, { signal, onProgress })` for each chunk and joins whatever it gets back: it reads `out.compat.frame`, `out.result.stages`, `out.result.status` and the layers in `out.result.artifact.data.stagedBuild.layers`, and opens each layer's GLB (`url`, `textured.url`) as `cache.modelsDir/<basename(url)>`. That is the whole contract. Today `staged-location-tool.ts` implements it with `runStagedLocationOffThread` (one local worker thread a chunk, three at a time).

The plan adds a second implementation, `cloudChunkRunner` (new file `staged-location/cloud-chunk-runner.ts`), that:

1. writes the chunk request to `gs://<bucket>/kd-jobs/<parentRunId>/<chunk>/request.json`;
2. starts one Cloud Run job execution for it (Cloud Run Admin API v2 `jobs.run`, env override `KD_JOB=gs://…/request.json`);
3. reads the job's `progress.jsonl` every 10 s and forwards new lines to `onProgress`; on `signal` abort it cancels the execution (`executions.cancel`) and rejects with the abort;
4. when the execution succeeds, downloads `outcome.json` (the `StagedLocationOutcome`), every layer GLB it names into the local `cache.modelsDir` under the same basename, and the chunk's run record (`runs/<chunkRunId>/`) into the local stage cache, so `watch-staged-build` and stage reviews see the chunk as if it had run here;
5. when it fails, rejects with the job's own error (read from `error.json`, else the execution's failure message). The orchestrator's existing retry-once-then-degrade path handles it. No silent fallback to a local build.

The orchestrator does not change. Two small changes outside it:

- `staged-location-tool.ts`: `runChunk` picks the cloud runner when `SCRATCHBOX_KD_CHUNK_RUNNER=cloud` and the job is configured, else stays local; with the cloud runner `prefetchTiles` is left out (the laptop would download leaves nobody reads).
- `district-chunks.ts` `chunkParallel`: with the cloud runner, the width comes from `SCRATCHBOX_KD_CLOUD_PARALLEL` (default 48, i.e. every chunk at once) instead of the laptop's memory. The centre chunk still builds locally, now with the whole machine.

The job side is a new entry point, `staged-location/kd-chunk-job.ts`: read the request, `runStagedLocation(request, createStagedLocationDeps(root))` (the same deps the worker makes), append each progress line to `progress.jsonl` (flushed every 5 s), upload the outcome, the layers' GLBs and the run record, then run the existing `syncCacheDir` so the chunk's stage and native caches reach `cache/v1/` like a local build's do. Exit code 0 only after the outcome is uploaded.

## Decisions to confirm

### 1. Where it runs: Cloud Run jobs (recommended) or GCE

| | Cloud Run jobs | GCE (spot VMs) |
|---|---|---|
| Size of one chunk | max 8 vCPU / 32 GiB a task | any (e.g. c3-highcpu-22 for the slow chunks) |
| Start | ~30–60 s with the image cached | 1–2 min boot + image pull |
| Disk | in-memory only: files count against the 32 GiB (or a GCS volume mount) | local SSD / PD |
| Ops | none; scale to zero; per-second billing | instance template, MIG or per-chunk VM create/delete, a cleanup path for orphans |
| Price (us-central1) | $0.000018 /vCPU-s + $0.000002 /GiB-s ≈ **$0.75/h** a task | spot c3-highcpu-8 ≈ $0.10–0.15/h; preemptible |

Recommendation: **Cloud Run jobs, 8 vCPU / 32 GiB, one execution a chunk, region us-central1** (the existing Artifact Registry `depthbox3-repo` is there). It is the smallest moving part and the only service already used for scale-to-zero GPU work in `scoutscan`. Its cost per district is a few dollars (below), so spot savings do not justify the VM lifecycle code. The 8-vCPU ceiling sets the tail (see wall clock). GCE stays the follow-up if the slowest chunk dominates.

Checks before the first run: the region's Cloud Run CPU and memory quota must cover the width (48 × 8 = 384 vCPU, 1.5 TiB); if it does not, `SCRATCHBOX_KD_CLOUD_PARALLEL` is set to what it covers and a quota increase requested. `tile_refine` and the texture pool are given `threads: 8` explicitly in the job (`os.cpus()` inside Cloud Run can report the host's cores, not the task's 8).

### 2. Image: Node + the native C++ engine

`deploy/kd-chunk-job/Dockerfile`, built by Cloud Build (`deploy/kd-chunk-job/cloudbuild.yaml`; there is no Docker on the laptop):

- `node:22-bookworm` + `clang` (C++20), `python3` with only what the K stages spawn (decided by the smoke test below, not guessed);
- the repo's `packages/core` (source and its production `node_modules`), run through the same TypeScript register the worker thread uses;
- **native binaries compiled at image build time**: a build step runs the native drivers K-D uses once (`compileNativeCached`, `-O3`, no `-march=native`), so a task never spends minutes in clang. The engine has only been built on macOS so far; if a header does not build with Linux clang/libstdc++, that is fixed in the header, not worked around.
- Image tag = the git commit, so a district's chunks all run the same code as the laptop's centre chunk. The runner refuses to start if the job's image tag differs from the local `HEAD` (a mixed-code district would seam badly), unless `SCRATCHBOX_KD_CLOUD_ALLOW_SKEW=1`.

Smoke test before any district: one chunk built both locally and in the cloud from the same request, compared by triangle counts, layer list and a clay render of each.

### 3. Credentials: Maps tiles and the Gemini model

- **The app's service-account key** (the file `GoogleMediaCredentialsService.findServiceAccountPath` finds locally) goes into Secret Manager in `scoutscan` and is mounted as a file, `GOOGLE_APPLICATION_CREDENTIALS` pointing at it. Every path the chunk build takes (Vertex/Gemini vision, vector tiles, Imagery Grounding) then authenticates exactly as it does on the laptop. Alternative: the job's own service account through ADC, but `gemini.ensureAuth` and the vector-tile path look for a key file, so that would need code changes in several places.
- **The Maps key** (`GOOGLE_MAPS_API_KEY`) as a second secret, exposed as an env var.
- The job runs as a dedicated service account `kd-chunk-job@scoutscan` with `roles/storage.objectAdmin` on the job bucket and the training bucket, and `roles/secretmanager.secretAccessor` on the two secrets.
- The laptop's app service account needs `roles/run.developer` on the job (to run executions with overrides and cancel them) and `roles/iam.serviceAccountUser` on `kd-chunk-job@`.
- **Gemini quota:** the vision calls share one quota. Locally three chunks' vehicle stages overlap; in the cloud up to 44 would. The first trial (8 chunks) measures 429s and vehicle-stage time. If they degrade, the runner staggers starts (N executions a minute), rather than anything clever across processes.

Deploy needs the user's own `gcloud` login: the CLI here is on `eli@scratchbox.ai` with expired tokens and the default project `scratchbox-canvas`, and the setup above (secrets, IAM, job, Cloud Build) is done once, by `deploy/kd-chunk-job/deploy.sh`, with `--project scoutscan`.

### 4. File transfer: a new bucket (recommended)

`gs://scoutscan-kd-jobs` in us-central1, with a 7-day delete lifecycle rule. Each chunk's objects:

```
kd-jobs/<parentRunId>/<chunk>/request.json     written by the laptop
kd-jobs/<parentRunId>/<chunk>/progress.jsonl   rewritten by the job every 5 s
kd-jobs/<parentRunId>/<chunk>/outcome.json     the StagedLocationOutcome
kd-jobs/<parentRunId>/<chunk>/models/<name>.glb  every layer GLB the outcome names (clay and textured)
kd-jobs/<parentRunId>/<chunk>/run/<file>       the chunk's run record (stages.json, timeline.jsonl, notes)
kd-jobs/<parentRunId>/<chunk>/error.json       on failure
```

A separate bucket keeps transient job traffic out of the training bucket (whose contents are training data) and gives it its own expiry. The durable copy of everything a chunk computed still goes to the training bucket's `cache/v1/` through the existing mirror. Uses the existing `CloudBucket` / `GcsCloudBucket` (`cloud-store/cloud-bucket.ts`).

### 5. Shared cache

- Phase 1 (this task): each task starts with an empty stage cache, builds, and mirrors its caches to `cache/v1/` (`syncCacheDir`, the same layout as the laptop's). This matches the rule that test builds are judged uncached anyway.
- Leaf tiles: each task fetches its own chunk's leaves from Google (the laptop's prefetch does nothing for a cloud task). Map Tiles billing is per root-tileset session, so 44 sessions instead of one is a small cost; it is in the cost table.
- Phase 2 (only if wanted): read-through, i.e. before a stage runs, the job looks up `cache/v1/staged_location/<stage>/<key>/done.json` and pulls the entry. That makes a re-run of a district after a late-stage change cheap. It needs a hook in `StageCache.get`, so it is left out of this task.

### 6. Cost per district (Shibuya 350 m, 44 chunks + the local centre)

Measured locally (run `c527da43`, 28 chunks done so far, three or four at once on the M4 Max): chunk wall time mean 8.6 min, max 40.7 min (chunk 37, remesh 36.6 min); remesh about 68% of the total.

| Item | Estimate |
|---|---|
| Cloud Run tasks: 44 × (~10 min build + ~2 min start/transfer) ≈ 9 task-hours × $0.75 | **≈ $7** (2× slower vCPUs: ≈ $13) |
| GCS: writes, reads, a few GB for under 7 days | < $0.10 |
| Egress of the outputs to the laptop: ~0.1–0.3 GB a chunk → 5–13 GB at $0.12/GB | ≈ $1–1.50 |
| Map Tiles root sessions: 44 instead of 1 | cents |
| Gemini vision | the same calls as a local build; no change |
| Cloud Build per image | ≈ $0.10 |
| **Total extra per district** | **≈ $8–15** |

Wall clock: the critical path becomes the slowest chunk on 8 vCPU (chunk 37: 25–40 min expected, since an M4 Max performance core is faster than one vCPU) plus start, transfer and the seam stage on the laptop. Estimate **45–60 min against ~120 min locally**. The measured times, cost (from the execution durations, multiplied out) and any degraded chunks are reported in the run note and in `docs/processes/`.

## Order of work

1. `kd-chunk-job.ts` and `cloud-chunk-runner.ts`, with tests that build the request and outcome objects and check the download mapping (no network, no bills).
2. The Dockerfile and Cloud Build config; build the image and fix any Linux build failure in the engine headers.
3. `deploy.sh`: bucket, secrets, service account, IAM, job. **Needs the user's go-ahead and `gcloud auth login`.**
4. Smoke test: one chunk, local against cloud.
5. Trial: 8 chunks of Shibuya at once (quota, Gemini 429s, start time).
6. The full Shibuya 350 m K-D build from the `scratchbox-pipeline-kd` instance with `SCRATCHBOX_KD_CHUNK_RUNNER=cloud`, caches cleared first; review the join and seams (`watch-staged-build`, screenshots), report wall clock and cost against `c527da43`.
