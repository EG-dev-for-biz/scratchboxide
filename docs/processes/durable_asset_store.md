# Durable asset store: files outlive the checkout, missing ones come back

**Date:** 2026-10-20
**Status:** Verified (stages 1–3 live; the real rebuild path verified end to end in the user's app on the Washington Square scene, 12 of 13 lost files back)

## Why

Every file the app published (`/models/...`, `/build/3d-python/...`, `/build/generated-images/...`) lived inside the
checkout that made it, and the project graph lived in `<checkout>/desktop-app/.scratchbox`. Deleting a worktree
deleted its models; a saved scene then showed "13 models failed to load" with nothing to be done (the Washington Square
scene on 2026-10-20). The user asked for the app to fetch data as needed and to keep a log of a project's changes.

## What exists now

### Stage 1: the store (`packages/core/src/node/asset-store/`)

- `~/.scratchbox/assets/blobs/<aa>/<sha256>`: the bytes, one file per distinct content (APFS clones where possible).
  `SCRATCHBOX_HOME` moves the whole home (tests, isolated instances).
- `~/.scratchbox/scratchbox.db`: one SQLite file through Node's built-in `node:sqlite` (no native package; Node 22.13+,
  Electron 38's Node qualifies). Tables: `blobs`, `served` (URL path → blob, origin, recipe, rebuilt flag), `recipes`
  (how a file was made), `events` (every change, the start of the project change log), `scanned` (sweep memo). WAL mode
  and a busy timeout let several app processes share it.
- Recorded automatically: `StageCache.publishFile` (every staged layer, with the run as recipe `staged:<runId>`),
  `StageCache.writeRunRecord` (the recipe body is the run record: request, place, keys), `generate_image` (recipe:
  prompt, aspect ratio, references, models), the Python runner's GLBs.
- Served: `desktop-app/server/app.ts` looks a missing `/models/...`, `/build/3d-python/...`, `/build/generated-images/...`,
  `/renders/...`, `/datasets/...` or `/splats/...` path up in the store after the static mounts and serves the blob with
  `X-Scratchbox-Asset-Store: stored|rebuilt`. A present file is still served from disk.
- Sweep: 5 s after startup the server records every file under each served `public/models` and `build/*` directory
  (streamed hashing, yielding between files; unchanged files are not hashed again). `SCRATCHBOX_ASSET_STORE_SWEEP=0`
  skips it; `SCRATCHBOX_ASSET_STORE=0` turns the store off entirely.

### Stage 2: recovery (`asset-recovery-service.ts`, `/api/assets`, `asset-recovery-client.ts`)

- A model that fails to load in the viewport is sent to `POST /api/assets/recover {paths}` (one batch per 250 ms, once
  per path per page). The job: store hit → `restored`; a `staged-location` recipe → the recorded request is re-run
  (`staged-rebuild.ts`, real dependencies, stages whose cache entries exist are reused) once per lost run, and each lost
  name is pointed at the new run's file of the same layer (`<base>_<key8><rest>` match), marked `rebuilt`; otherwise
  `unrecoverable` with why (never recorded; a `generate_image` recipe is not re-run automatically).
- The viewport shows "Recovering N missing files" with the run's progress and a Cancel button (`POST
  /api/assets/recover/:id/cancel` aborts the run), hides the red load error while the job runs, loads the files again
  when it ends, and shows `rebuilt` beside a rebuilt model in the model list. A failed recovery's reason is appended to
  the load error.
- `GET /api/assets/lookup?path=` and `GET /api/assets/events?subject=&limit=` read the index.

## Evidence (isolated instance on ports 3100–3102, `SCRATCHBOX_HOME` in a scratch dir)

- Sweep log: `[asset-store] /models: 42 file(s) recorded, 0 unchanged`; 28 blob prefix directories.
- `curl /models/test_conformal1_asymmetric_street_tree.glb`: 200 from disk; after `mv` of the checkout copy: 200 with
  `X-Scratchbox-Asset-Store: stored`, `Content-Type: model/gltf-binary`, bytes identical (`cmp`); same through the Vite
  proxy on 3100.
- Midtown demo (its model is not in this checkout): the viewport posted `/api/assets/recover`, polled the job, and
  showed "Recovery finished: 1 not recoverable" with the load error "…; this file was never recorded in the asset store,
  so there is no recipe to rebuild it from" (`recovery_notice_unrecoverable.png` in the session's scratch dir).
- Tests: `durable-asset-store.test.ts` (6: content addressing, replaced paths and events, truncated blob refused,
  recipes and aliasing, sweep memo, two instances on one database), `asset-recovery-service.test.ts` (4: restore /
  rebuild / unrecoverable in one job, cancel, a rebuild that published nothing), `staged-stage-cache.test.ts` still green.

### Stage 3: the project change log (`project-artifact-store.ts`, `project-graph-diff.ts`)

- Every `POST /workspace/project-artifacts` still writes `<workspace>/.scratchbox/project-artifacts.json`, and now also
  keeps the graph in the `projects` table (keyed by project id and checkout) and appends the changes since the last save
  to the project's log: `artifact.created / revised / archived / restored / linked / unlinked / selected`, each with the
  artifact id, kind and title, the revision number, content hash, command id and author, never a payload.
- A load with no file in the checkout reads the database: this checkout's copy, else the newest copy from any checkout
  (logged as `project.restored` with where it came from). A file the database has never seen is imported once
  (`project.imported`).
- `GET /workspace/project-artifacts/log?projectId=&limit=` and `GET /workspace/project-artifacts/list`.
- Live: two saves through the API on the 3100 instance gave `artifact.created` (document "Live log check", revision 1,
  author Eli) and `artifact.revised` (revision 2) above the `project.imported` entry of the checkout's existing file.
- Tests: `project-artifact-store-durable.test.ts` (4: the diff names changes without payloads; a save is logged and a
  checkout without the file gets the project back and keeps logging; a legacy file is imported once; the file-only mode).

## The real rebuild (2026-10-20, the user's app on 3060)

The Washington Square Arch scene had 13 files lost with a deleted worktree, all made before the store (no recipe).
"Rebuild this location" (the fallback from the scene's own place) ran the isolated structure and then the district as two
staged runs. What it taught, each fixed the same day:

- the lost names carry the slug of the words the place was first asked for with (`…_new_york_iso_l3a_…`); a rebuild
  from the resolved address publishes under another slug (`…_washington_square_iso_l3a_…`): match by layer token, not
  the prefix;
- the textured twins are published by the background texture pass after the run ends: take them from any run recorded
  at the same place (within 60 m), newest first;
- an isolated structure and its district are two runs: split the fallback by the `_iso` token.

Result: 6 structure layers rebuilt in 2.8 s (cached stages), then 4 textured twins and the district's trees in 108 s;
the scene shows the textured arch, its trees and the surrounding buildings again. One file is still missing: the
district remesh carved around the kept structure (`…_remesh_<key>_around_<key>.glb`, orchestrator.ts `_around_`), which
only a run staged into the active scene makes; the recovery reports it as failed with the run's file list.

## Not yet

- The carved district remesh above: the recovery could carve it itself from the restored structure files and the new
  district remesh (`hideFootprintInGlb`), given the anchor offset between the two runs.
- A view of the project log in the app (today it is the API only).

## Candidate tool/service ideas

- A chat tool `asset_history({ path })` over `/api/assets/events`, so the agent can answer "where did this model come
  from" from the recipe and log.
- A `generate_image` recipe re-run on request (not automatic: it bills and gives a different image).
