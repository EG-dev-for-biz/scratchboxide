# Pipeline K-D: the chunk cut moved into the Cloud Run job

**Date:** 2026-11-04 · **Branch:** `perf/kd-chunk-cut-in-job` · **Status:** Verified offline on the Penn Station run's real chunk layers; no new cloud run.

## The problem

At Penn Station (run `c81d307d`, evidence in `/Volumes/3DTESTING/Scratchbox-drive/kd-penn-c81d307d-20261103/`) the chunks
finished in the cloud at about 750–1,800 s, but the laptop reported them at 1,200–2,320 s (start + cloud seconds against
the runner's "built in the cloud" line, which is printed after the download). Some chunks were 7 to 19 minutes behind.
Each chunk's layers were cut to its territory and placed in the district's frame by `joinChunkGlb`, synchronously on the
server's main thread (load average 260–525). This blocked the downloads and the job polls too, hence the `ETIMEDOUT`s.
The old join also kept every replaced buffer: about a third of a joined layer was unreferenced bytes.

## What changed

- **The cut runs in the job** (`kd-chunk-job.ts` → `district-chunks.ts cutChunkLayer`). Each layer is cut to what the
  chunk keeps, placed in the district's frame, compacted and stamped (`asset.extras.scratchbox.kdCut`, with the
  transform it used) before upload.
- **The frame is exact, never assumed.** A centre built on the laptop passes the frame in the request. A centre in the
  cloud publishes its frame to `kd-jobs/<run>/frame.json` as soon as its tiles are in (`StagedLocationContext.onFrame`).
  The other jobs wait for it (at most 10 min) and otherwise send their layers uncut. An assumed origin height moves x/z
  only by about 1e-9 m. Even that flipped 4–39 triangles a layer at Penn, on vertices lying exactly on cell lines and
  footprint edges, so a cut in an assumed frame was rejected.
- **The laptop only checks and publishes** (`joinChunkLayerFile` on one worker thread a district, `chunk-join-worker.ts`).
  It checks the stamp (chunk, run, the transform number for number; anything else is refused), strips it and writes the
  file. An uncut layer (a chunk built locally, a job without the frame) is cut, placed and compacted there, on the worker.
- **Compaction everywhere** (`GlbEdit.finish`): only referenced accessors and bufferViews are kept, byte for byte.
  `joinChunkGlb` (the centre built here, the placeholders) compacts too.
- **Records:** the chunks stage report gains `join` (files, cut by job / here, bytes in/out, dropped bytes, worker,
  publish and total ms), the job outcome gains `cut`, and `cloud-job.json` gains `downloadMs`.

## Proof

- `packages/core/test/pipeline-kd-chunk-cut-in-job.test.ts`, against the old join frozen in
  `test/helpers/legacy-join-chunk-glb.ts`: the same triangles, every attribute bit for bit, the same node world matrices,
  extras, materials and images, for:
  - a transformed scan layer (uint32, uint16 and non-indexed primitives, an image in a bufferView);
  - instanced trees (root node);
  - baked whole pieces;
  - vertices exactly on cell lines;
  - the uncut fallback.

  It also checks no unreferenced byte in what the job sends or the laptop writes, the refusal of a layer placed in
  another frame (1 mm higher), and two jobs exchanging the frame through the bucket.
- **The same parity on the run's 8 largest real chunk layers** (`KD_PARITY_RUN_DIR=… KD_PARITY_RUN=094ec418
  KD_PARITY_LIMIT=8`): passed.

## Measured (the real Penn chunk files, old join vs new path, this laptop)

| Chunk | Load | Download before → after | Joined layer written before → after | Laptop before (main thread) | Laptop after | Main thread's longest block, before → after |
| ---: | ---: | --- | --- | ---: | ---: | --- |
| 7 | ~350 | 264 → 235 MB | 411 → 235 MB | 367 s | 0.98 s | 240 s → 0.39 s |
| 2 | ~250 → 64 | 244 → 218 MB | 387 → 218 MB | 7.2 s | 0.81 s | 3.9 s → 0.36 s |
| 8 | 64 | 48 → 45 MB | 68 → 45 MB | 1.4 s | 0.17 s | 0.76 s → 0.07 s |

- **What remains on the main thread** is `publishFile` (sha256 and copy), about 0.2 s per 100 MB.
- **The job's added time** is the cut: 4.7 s for chunk 2 here, about $0.001 a chunk at 8 vCPU / 32 GiB. Chunk 7's
  208 s was measured at load 350 and is not representative.
- **Downloads drop only ~11%**, because the cut drops triangles' indices, not vertices. Dropping unreferenced vertices
  too would shrink them further. That is a follow-up: it changes vertex order, which the parity here holds fixed.

## Not done

No Cloud Run run (it needs the user's OK, and a new image: `deploy/kd-chunk-job/deploy.sh build`). The end-to-end
lag in a live district is therefore not yet measured.
