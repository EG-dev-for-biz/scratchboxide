# Process: per-part weathering and decals on generated objects (object_detail_pass), live in the app

> **Recorded:** 2026-11-03
> **Status:** Verified (three generated objects weathered live, each part on its own material, mounted in the open scene and still drawn after a reload; version 1 restored and version 2 shown again live). Not covered: an object staged at a real place (placement path), a chat on Node 20 (no asset store: the file-only versions are unit-tested only).
> **Tags:** `operate-scratchbox` `object-build` `weathering` `decals` `scene-object-store` `detail-pass`
> **Target Domain:** Gemini Agent Chat / 3D Viewport / scene object store

---

## 1. Session Context

* **What prompted this session:** weather_mesh and asset_decal wrote into a /models copy the scene never draws, and weather_mesh gave every part of the lunar lander one material family's maps (evidence: `docs/screenshots/detail_pass_check_2026-11-03/weather_mesh_lander_before_after.png`). PR #71's DETAIL PASS rule was held because of it. This session built `object_detail_pass` (PR #84) and checked it live.
* **Instance used:** web `3171`, API `3172`, tools `3173` (own `scratchbox-object-detail` entry, Node 22.18 so the durable asset store is on; on the shell's Node 20 the store reports `node:sqlite is not available` and is off). A local receiver on `3174` saved frames from `window.__scratchbox_capture_active_3d_scene()`.
* **Scope tested:** the agent's own use of the restored DETAIL PASS rule after `build_3d_object_from_reference`, the pass on three objects, mounting in the open scene, restore of version 1 and back, a page reload. Load on the Mac: live steps only while the 1-minute load average was under 100.

---

## 2. What Was Tested & What Worked (Verified)

* **Apollo lunar module** ("has stood on the Moon since 1969, and show its age"; later "age it again: 55 years on the lunar surface"). The agent built it (410 s) and called `object_detail_pass`; after the two fixes below, the pass made version 2 in 10.9 s with no billed call. Every material kept: gold foil stays gold (sun-bleached, dust specks), white cabin white, struts silver; regolith dust on the up-facing footpads. Its recipe (from the version record): edgeWear 0.55, grime 0.52, dust 0.58, sunFade 0.48, per-part shares on footpads, struts, ladder. Its first call named `ladder_rungs`, which has no node of its own; the error listed the part ids and its next call succeeded.
* **Brass ship's sextant, 1880s** ("used at sea for decades"). The agent built it (458 s) and ran the pass unprompted right after (16.1 s, no billed call), with a polished-brass worn-edge finish (edgeColor [0.82, 0.68, 0.34], metalness 1, roughness 0.16-0.22) on the screws, index arm and telescope, and greenish salt grime. "Show me the sextant as it was before the ageing" restored version 1 in 0.6 s; "switch back to the aged one" mounted version 2 again in 1.2 s with no re-bake.
* **Bus stop sign on a galvanised post** ("at a city kerb since the 1970s, with BUS STOP lettering"). The agent built it (366 s) and ran the pass with one decal painted from a description by `gemini-3.1-flash-image` (13.0 s in all, one billed image call), projected onto `sign_plate` only and only its front face; enamel edges chipped to rusty iron (`sign_plate` edgeColor [0.22, 0.16, 0.12]), kerb grime and dust on the cast base.
* **Mounted live and after a reload.** Each pass switched the open scene at once (the generator's inline copy and the hero object's file move together). After a page reload the viewport fetched `GET /models/objects/object/hero-1793767009563~2a258b1c/3c457c3eba009c58/b585de6d6053a0df.glb → 200`, the version-2 file, and drew the weathered lander. Console: no model or shader errors (only `[project-artifacts]` save warnings from the server restarts).
* **Versions in the scene object store.** Records at `/models/objects/object/<id>~<h>/3c457c3eba009c58/<hash>.json`, provenance `generated`, producer `object-detail-pass/1`, each with its recipe; version 1 is the object as built.
* **Proof sheet:** `docs/screenshots/object_detail_pass_2026-11-03/object_detail_pass_proof_2026-11-03.png` (gitignored), frames beside it.

---

## 3. What Broke / Didn't Work

* **The store refused the as-built object** (first live attempt): `scene object store: object/hero-…@3c457c3eba009c58 is not a valid GLB (mesh 0 primitive 0 POSITION min/max [[-2.175,1.05072,-2.175],…] do not match the data [[-2.174999952316284,1.0507240295410156,…]]`. The engine's GLB writer (`scratchbox_io.hpp`) rounds accessor min/max to six significant digits. Fixed in the pass (`exactPositionBounds`: the bounds measured from the data, JSON only); the writer itself is unchanged (a follow-up).
* **`Maximum call stack size exceeded`** on the 383k-triangle lander: `UvAtlasRewrap.ts` spread one argument per triangle (`densityAll.push(...dens)`) and per chart (`Math.max(...)`). Fixed with loops.
* **Judgement:** the agent gave the lunar module run-off streaks (0.38) although nothing runs down a surface on the Moon. The `streaks` parameter now says 0 where nothing ever wets the object; not re-tested live.

---

## 4. Candidate Tool/Service Ideas

* **Spec part ids for merged parts** — `object_detail_pass` could accept a spec part id whose geometry the builder merged into another part's mesh (the lander's `ladder_rungs`) and map it to that node, instead of failing the call; the agent needed one retry.
* **A frame capture route** — this session saved viewport frames through `window.__scratchbox_capture_active_3d_scene()` and a hand-run local receiver; a `POST /api/scene-capture` that writes the active scene's frame to `docs/screenshots/` would replace it.
* **Exact accessor bounds in the engine's GLB writer** — `scratchbox_io.hpp` should write min/max at full float precision, so every engine GLB passes glTF validators and the store's check without repair.

---

## 5. Reproduction Steps

1. Check out `feat/object-detail-pass`; add a launch entry with Node 22 on PATH (the asset store needs `node:sqlite`) and free ports.
2. Start it, open the app, new chat: "Make an Apollo lunar module that has stood on the Moon since 1969, and show its age." The agent builds and then calls `object_detail_pass`.
3. Ask "show me it as it was before the ageing" (restoreVersion 1), then "switch back to the aged one".
4. Reload the page: the scene loads `/models/objects/object/…/<hash>.glb`, the newest version.
