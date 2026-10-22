# Scene object store: per-object versioned GLBs, kept when a scene is done

**Date:** 2026-10-22
**Status:** Verified on cached Federation Square data (headless staged builds, scratch `SCRATCHBOX_HOME`); not yet exercised in the live app UI.

## Why

The user asked to store the scene data after a scene is finished. This is the approved queued plan: each rebuilt object becomes its
own versioned GLB asset in the durable asset store, with the scene's own data, so a later build or a reopened project can reuse them.

## What exists now

- **Keys.** An object is `<kind>/<identity>@<locationHash>`. `kind` is an open label (`building`, `tree`, `ground`, `road`,
  `scan-residual`). `locationHash` hashes the build's ENU frame origin, to about 1 cm. Each version carries an `inputHash` of what
  determined its geometry.
  - **Buildings** use their Google vector feature id.
  - **Trees** use their **object catalog** row id, not the crown id. This departs from the plan for a measured reason: across two
    Federation Square strips, 0 of 404 crown ids kept their stem, while 162 crowns matched a stem within 1 m. Crowns are matched
    one to one with catalog rows within 3 m, nearest pairs first. Two trees closer than 3 m therefore never share a key. In the
    first trial they did: 6 pointer flips.
- **Records.** Records are additive-only JSON.
  - `scratchbox.object/1`: identity, WGS-84 centre, ENU bounding box and frame, provenance labels and confidence, materials
    (`surface` when a material names `/models/surfaces/<id>`), input hash and readable inputs, producer stage and key, catalog id,
    and the GLB's served path, sha256 and counts.
  - `scratchbox.scene/1`: the final `Scene3DData`, every layer (url, sha256, how many objects were cut from it) and every object
    version used. It is stored at `/models/scenes/<locationHash>/<runId>.json` with recipe `scene:<runId>` of kind `scene-record`.
- **SQLite.** `asset-db.ts` gets two new tables. The schema is additive, now version 2.
  - `object_versions` holds one row per (object, input hash) and is never rewritten. The only exception is a repair, when the
    bytes were lost and are stored again.
  - `object_current` holds each object's current pointer.
  - Objects link to the existing `objects` catalog through `catalog_id`, using `findCatalogObject` / `recordDiscoveredObjectIn`
    in `object-catalog.ts`.
- **Code.**
  - `asset-store/scene-object-store.ts` (`SceneObjectStore.put/find/read/versions/putScene/readScene/latestSceneAt`).
  - `staged-location/scene-objects.ts` holds the manifests, the cut, the store pass, the building input hash and the massing
    reuse plan.
  - `glb-subset.ts` composes node subtrees and triangle subsets; it carries EXT_mesh_gpu_instancing and refuses skins, sparse
    accessors and unknown extensions.
  - `glb-integrity.ts` is the structural check.
  - `glb-texture-repack.ts` cuts shared atlas pages down to what an object samples.
- **What is separable.** Each producer writes a `scratchbox.layer-objects/1` manifest beside the layer GLB, in `objects.json` in
  its stage cache entry, with node indices and the GLB's sha256.
  - **District massing.** Each building is its own nodes, found by the id the node names carry, plus the scanned residual
    triangles over its footprint (cut per triangle). Residual on no footprint becomes `scan-residual/unattributed`.
  - **SB-Veggie layer.** Each grown crown is its own subtree. The 22 crowns kept as scanned are outlines only and are not stored.
  - **Procedural ground and streets.** Each is one whole-layer object (`ground/surface`, `road/network`). Their meshes join every
    street and patch, so nothing smaller can be separated.
- **When it runs.** At finish, in the background (`inBackground`, yielding between objects), so the build result does not wait.
  `SCRATCHBOX_OBJECT_STORE=0` turns it off.
- **Reuse.** The district massing stage computes each building's input hash before massing. The hash covers:
  - its vector entry, ground level and massing spec;
  - an order-free digest of the scan triangles over its owned footprint cells;
  - the version constants.

  Buildings with a stored version for that hash are left out of the native run, and their stored GLBs are merged into the layer.
  The ground, the streets and, when nothing is massed, the unattributed residual are reused the same way.
  `SCRATCHBOX_OBJECT_REUSE=0` turns reuse off; objects are still stored.

## Gates (tests)

`packages/core/test/scene-object-store.test.ts` has 11 tests:

- the GLB cut keeps names, extras and bit-exact positions;
- instancing is carried;
- the merge works;
- the structural check reports bad references, wrong bounds and misalignment;
- repacked texels are unchanged (PNG, per vertex);
- a store round trip reads back byte-identical and the record parses;
- the same inputs make no new version and nothing is cut;
- a changed input makes version 2 and moves the pointer, and version 1 stays readable; the earlier input moves the pointer back
  with no version 3;
- a malformed GLB is refused;
- the massing manifest attributes residual per footprint, and a scan change over one building changes only that building's hash;
- a whole scene is stored, then reused, then re-versioned;
- a renumbered tree crown keeps its catalog identity.

**Validator:** the repo has no Khronos `gltf-validator` dependency (searched). Every stored GLB instead passes `checkGlbBytes`,
which checks the core rules: the container, index ranges, accessor and buffer view bounds and alignment, POSITION min/max against
the data, index values, a single parent per node with no cycles, and declared extensions.

## Real runs (Federation Square, `SCRATCHBOX_STAGED_PROCEDURAL=1`, scratch `SCRATCHBOX_HOME`)

| Run | Massing stage | Store pass | Result |
| :-- | --: | --: | :-- |
| First store (cache hit, manifest backfilled in 1.5 s) | 2.1 s | 89 s (before the speed-ups below) | 497 objects stored: 96 buildings, 1 unattributed residual, ground, roads, 398 trees; 285 MB |
| Same build again | 1.0 s | 0.4 s | 497 reused, 0 new versions, 0 pointer moves |
| Massing cache emptied, reuse on | **20.1 s** | 0.3 s | 96 buildings, ground and streets taken from the store; native run skipped (plan 93 ms, assemble 303 ms) |
| Massing cache emptied, `SCRATCHBOX_OBJECT_REUSE=0` | **129.1 s** | 0.2 s | regenerated; every object had the same input hash, so no new versions |

- **Saving:** a rebuild of the massing stage drops from 129 s to 20 s (84%). The rest is loading the scan and checking each building.
- **Fidelity:** the layer reassembled from stored objects was rendered against the original from three views with the repo's
  `renderTriangles` (`docs/screenshots/scene_objects_original_vs_reused.jpg`).
  - Mean absolute difference is 0.46 to 0.72 per 255.
  - 0.07 to 0.2% of pixels differ by more than 24, from the JPEG re-encode of cut atlas pages.
  - The images are visually identical.
- **Atlas cut:** every building GLB that carries the two shared 4096 px pages whole would be 532 MB together. With the pages cut
  to what each building samples, plus the 1 px uniform tile confidence map left shared, the 97 massing objects total 84 MB, against
  the 40 MB layer.
- **Store-pass speed:** reading image sizes from headers (no decode unless cut) and a faster PNG writer took the cut pass from
  54 s to 15 s.

## Gaps

- **Trees are only reused at storage, not in generation.** SB-Veggie grows every crown in one native call with a shared triangle
  budget, so per-tree generation reuse needs the planter changed. Trees are 190 MB stored against the 78 MB layer, because the
  shared leaf-cluster meshes are copied into each tree.
- **Atlas cutting is partial.** Residual scan photo cuts are bounding-box crops per primitive, so tile photos still duplicate
  somewhat (84 MB against 40 MB).
- **Not separable or stored yet:**
  - the remesh, the tiles and the carved remesh, which are scan layers, listed in the scene record but not cut;
  - the isolated-structure pipeline E and fit layers;
  - bridges and water (`procedural-bridges.ts` is not wired into the build).
- **Not linked yet.**
  - Building catalog rows are linked only by a 3 m centre match; the scene inventory's catalog rows carry no vector id.
  - No surface-library material is used by any build yet, so `materials[].surface` is empty.
- **Reopening a project** can find the scene by `latestSceneAt(frame)`, but no UI or server route reads scene records yet.
- **Revolution fit (merged upstream the same day).** It cuts its parts out of the massing layer in place. Buildings are listed
  after that cut, and the fit's on/off state and version are in each building's input hash. Its own `revolutions.glb` layer is not
  cut into objects yet. The Federation Square trial ran before that merge; its massing stage key now includes the revolution fit
  version.
