# Plan: capture training data from every 3D Building run

Drafted 2026-10-24. Steps 1–2 built 2026-10-24 (`cloud-store/building-training-capture.ts`, bucket `gs://scoutscan-building-training`, on for the user's instance only). **Update:** pipeline I now uses Trellis multi, not Meshy (user decision 2026-10-24). Trellis (MIT) targets may be trained on and are tagged `targetKind: model-output`; our pipelines' are `pipeline-rebuild`; any Meshy-era record stays evaluation-only. Self-hosting: [the Trellis services plan](2026-10-24-trellis-self-hosted-services-plan.md). Companion to [the TRELLIS.2 fine-tune plan](2026-10-24-trellis2-building-finetune-plan.md); this plan replaces its §3 (data collection).

## The idea

Every 3D Building press already produces the exact pair TRELLIS.2 needs:

**melted photogrammetry (input)** → **finished 3D object (target)**

The target comes from Trellis multi (Pipeline I) or from our own pipeline (E/G/H). Capture every run, label it honestly, upload it to the Google Cloud bucket we already have, and shard it for training on Vertex. No extra runs are needed: the dataset grows as a side effect of normal use.

## 1. What already exists (audited)

| Piece | Where | Reuse? |
|---|---|---|
| `CloudBucket` (GCS + directory implementations) | `packages/core/src/node/cloud-store/cloud-bucket.ts` | **Yes:** the upload path |
| `AssetCloudMirror`: content-addressed blobs `blobs/<aa>/<sha256>`, background upload, sweep, restore | `cloud-store/asset-cloud-mirror.ts` | **Yes:** GLBs and images are already hashed into the durable store, so a training record only needs to *reference* hashes, not copy bytes |
| SQLite asset-db snapshots to the bucket | `cloud-store/asset-db-snapshot.ts` | Yes: the pattern for the daily manifest |
| WebDataset `.tar` shard streaming from GCS | `tools/geobox/data/webdataset_gcs_loader.py` | **Yes:** the trainer's loader |
| Vertex custom-job launcher with service-account auth | `tools/geobox/launch_vertex_job.cjs` | **Yes:** the job submission |
| TRELLIS urban training image + launcher | `scripts/train/Dockerfile.train`, `launch_vertex_train.sh` | **Partly:** keep the CUDA 12.4 base and the Vertex job shape |
| `scripts/train/trellis_urban_dit.py` | | **No:** a self-written toy DiT that trains on `torch.randn` tensors, not TRELLIS. Replace it with the real TRELLIS.2 `train.py`. |

**Things to fix in the old setup:**
- The launcher defaults to project `scratchbox-ai`, but our Vertex project is `scoutscan`.
- The Dockerfile copies `scripts/dataset`, which doesn't exist.
- It assumes 8×A100 (`a2-ultragpu-8g`), which is fine for TRELLIS.2.

## 2. What one training record holds

One record per built structure per run, schema `scratchbox.building-training/1`:

- **Input: the melt.**
  - The isolated structure's textured scan GLB.
  - Its clay GLB.
  - The tile-photo station renders.
  - The 4 character-sheet panels + camera intrinsics/extrinsics (Pipeline I's `sheet-stations.ts` already plans these).
- **Target: the finished object.**
  - The final building GLB the run delivered (Meshy-fitted, or E/G/H output) + its clay twin.
  - `source`: `meshy-7.1` | `pipeline-e` | `pipeline-g` | `pipeline-h` + pipeline version.
- **Geometry context.**
  - Footprint (vector, else `scanDerivedFootprint`) and height envelope.
  - `GeodeticAnchor`.
  - The ENU→unit-cube normalisation used.
- **Quality and labels.**
  - Fit from `registerToFootprint` (`planIoU`, `coverage`, `overflowShare`, yaw, scale, mirrored).
  - Scan RMS residual.
  - Photo-match realism + identity.
  - Complexity-gate result.
  - Degradations + their reasons.
  - Per-part provenance labels.
- **Human signal** (the best label we'll get):
  - did the user keep it, rebuild it, switch pipelines, or edit it afterwards;
  - an explicit 👍/👎 if we add one.
- **Bookkeeping:** run id, timestamp, app version, place string, city-block id (for leak-free splits).

All bytes are referenced by sha256 into the durable store, so the record itself is a small JSON file.

## 3. Capture flow

1. **Hook:** when a staged build finishes (`orchestrator.ts`, where the run record is finalised), write the record. A **failed or degraded build is captured too**, marked so: it's useful as a negative example and for evaluation. Capture must never slow down or fail the build: it's fire-and-forget, and errors are logged.
2. **Store:** the record goes into a new `training_records` table in the asset DB. The blobs it names are pinned, so asset-store cleanup keeps them.
3. **Upload:** `AssetCloudMirror` already uploads the blobs. Records go to `gs://<bucket>/training/building/v1/records/<runId>.json`.
4. **User feedback:** later "keep / rebuild / edit" events update the record's human-signal field.
5. **Opt-out switch:** a setting `scratchbox.training.capture` (default on, as you asked), so isolated test instances (`SCRATCHBOX_HOME`) and tests write nothing. Tests never touch GCS (credentials unreachable).

## 4. From records to shards (cloud side)

A Cloud Run Job or Vertex batch job (CPU), run nightly:

1. List new records and apply the **quality gate** to sort each record into a tier:
   - **gold:** delivered, 0 degradations, plan IoU ≥ 0.85, photo-match above a threshold, kept by the user;
   - **silver:** delivered with minor degradations;
   - **eval-only:** failures and anything below that.
2. Run TRELLIS.2 `data_toolkit` on the targets → O-Voxel, `ss_latent`, `shape_latent`, `pbr_latent`; render `render_cond` from the 4 panels + extra random views.
3. Write WebDataset `.tar` shards to `gs://…/training/building/v1/shards/{train,val,test}/`, split by **city block**. Haughwout and a fixed 100-building test set are frozen and never trained on.
4. Write a dataset card: counts by tier, source, city and era, plus the pipeline-version mix.

## 5. Training (Vertex, reusing the launchers)

- New image `trellis2-trainer`: the TRELLIS.2 repo + its `train.py` + configs, on the existing CUDA 12.4 base.
- Data loading: adapt `webdataset_gcs_loader.py` or use TRELLIS.2's own dataset classes on a mounted copy of the shards.
- Launched with `launch_vertex_job.cjs`'s auth (project `scoutscan`).
- The phases and gates are as in the fine-tune plan §4.

**Trigger:** retrain when gold records grow by 25% since the last checkpoint, never automatically to production. A new checkpoint is evaluated on the frozen test set and adopted only if it beats the current Pipeline I default.

## 6. Meshy-sourced targets: handle with care

Meshy outputs are the most detailed targets we'll get, so capture them all; capturing is harmless. **Training** on them needs two things:
1. **Meshy's terms:** check whether they allow training on outputs.
2. **A per-source weight** in the training mix, so we don't simply clone Meshy's style.

Until (1) is resolved, Meshy records are tagged `train_allowed: false` and used for evaluation and as a baseline only.

## 7. How much data, how fast

- Meshy-based targets alone never get past Meshy-level quality. Our own pipeline outputs plus the user's keep/rebuild signal are what can take the model beyond it, on our buildings.
- Organic use is probably tens of buildings a week. To reach the 300-building pilot quickly, add a **headless harvest**: a place list run through the same staged-replay path overnight. It's the same capture hook, so there's no separate data path.

## 8. Build order

1. Record schema + capture hook + DB table + pinning, with unit tests asserting the written record and hashes (no network).
2. Upload records via `CloudBucket`; live-check one real build lands in GCS.
3. Feedback events (keep / rebuild / edit).
4. Headless harvest runner over a place list.
5. Cloud sharding job (`data_toolkit` → WebDataset), first run on the pilot set.
6. Fix and repurpose the trainer image + launcher (project `scoutscan`, real TRELLIS.2).
7. Phase 0/1 training per the fine-tune plan.

Steps 1–4 are app work we can start now. Steps 5–7 need a cloud GPU budget and the decisions below.

## 9. Decisions needed

1. **Meshy outputs:** train on them, or evaluation-only until their terms are checked? (Recommended: evaluation-only for now.)
2. **Capture default:** on for every user/instance, or only your own instance?
3. **Bucket:** reuse the existing asset-mirror bucket, or a separate `scoutscan-building-training` bucket? (Recommended: separate, for clean access control and lifecycle rules.)
