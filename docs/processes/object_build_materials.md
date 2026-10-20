# Process: Object builds carry per-part PBR materials (textured by default, clay on request)

> **Recorded:** 2026-10-19
> **Status:** Verified (hydrant, espresso machine and perfume bottle built live with materials and viewed in clay; alien seed pod built live in clay on request, its colour build verified headless only; materials land per part in the GLB; clay request stays clay; metal and glass read correctly once the studio reflections were added). Spec-read time roughly doubles; see section 3.
> **Tags:** `operate-scratchbox` `object-build` `pbr-materials` `provenance` `studio-reflections`
> **Target Domain:** Gemini Agent tools (`build_3d_object_from_reference`) / Native Python engine / 3D Viewport

---

## 1. Session Context

* **What prompted this session:** the user approved "textured by default, clay on request" for 3D (2026-10-19). Object and abstract-form builds were all studio clay: the reference image was drawn as grey clay, the build spec had no material fields, and `object_spec.py` gave every part `sb.PbrMaterial.clay()`.
* **Instance used:** web port `3572`, API port `3571`, tools port `3573`, started from the `object-materials` worktree with `SCRATCHBOX_NO_ELECTRON=true` (the main checkout's `.claude/launch.json` was not touched).
* **Scope tested:** `build_3d_object_from_reference` for a vintage red fire hydrant, a brushed-steel espresso machine, a glass perfume bottle with a gold cap, and an alien seed pod (built once in clay on request, once with materials); switching built objects to clay; the GLB materials and provenance.

## 2. What changed

* **Spec contract** (`packages/core/src/common/spatial/object-build-spec.ts`): a sweep or revolve part may carry `material`, continuous factors only: `baseColor` (linear RGB 0..1), `roughness`, `metalness`, `transmission` (0..1), `ior` (1..3), `clearcoat` (0..1), `emissive` (linear RGB) with `emissiveStrength` (0..100), and a free-text `description` that nothing reads. There is no material type or preset. `validatePartMaterial` checks every range and names the field; a material on a replicate or relief part is rejected (copies take their seed's). `objectBuildSpecJsonSchema({ materials })` adds the material block to the schema the vision model is given; a clay build gets the old geometry-only schema.
* **Interpreter** (`packages/core/src/python/scratchbox/object_spec.py`): validates the same ranges with the same messages, and `build(spec, clay=False)` writes each part's factors into its own glTF material (replicated and mirrored copies share it). `clay=True`, or a part with no material, is studio clay. Materials are assigned directly, not through `apply_material`, because `apply_material` also paints the base colour into the vertex colours and glTF viewers multiply `COLOR_0` by `baseColorFactor` (every colour would be squared).
* **Native GLB writer** (`scratchbox_io.hpp` `serializeMultiMeshToGlb`): now writes `KHR_materials_clearcoat`, `KHR_materials_transmission`, `KHR_materials_ior` and `KHR_materials_volume` (it wrote only emissive strength before; the single-mesh writer already had them). `transmission`, `thickness`, `clearcoat_roughness` and `double_sided` are exposed on `sb.PbrMaterial`.
* **Builder** (`reference-object-builder.ts`): the reference is drawn in full colour and materials under neutral white studio light on the same plain `#808080` backdrop, whole object, three-quarter view; the spec prompt adds material conventions (linear RGB conversion, metalness only for bare metal, transmission for see-through parts, describe the surface not the light). Every sweep and revolve part must have a material; a missing one or a factor out of range gets the existing corrective re-ask. `clay: true` keeps the old path exactly (clay reference, no materials, `clay=True` build).
* **Provenance:** the materials are inferred by the vision model from a generated picture, never measured. The result, `data.objectBuild.materials` and the GLB say so: each glTF material has `extras.scratchbox = { partId, provenance, description }` and `asset.extras.scratchbox.materialProvenance` holds the label and note. Labels: `generated` (read from the generated reference), `as-given` (a `specJson` rebuild: the materials are as written in the spec), `clay`.
* **Tool** (`object-reference-tools.ts`): new `clay` boolean (set only when the user asks for clay, grey, untextured, a blockout or a shape study). The scene opens in `renderMode: 'pbr'` by default and `'clay'` (with `clayPreset: 'studio-grey'`) on request. Staged at a place: `'pbr'` unless clay was asked for; a reused scene keeps another non-clay mode it already had. The summary lists each part's surface and the provenance note.
* **Viewport** (`scene3d/syncAtmosphere.ts`): studio scenes that show authored materials get neutral studio reflections: a PMREM of three's `RoomEnvironment` as `scene.environment` at intensity 0.6, never the background. Off in clay mode, under an atmosphere sky, in directed dark or space scenes, and at real places (3D tiles or geo coordinates). Without it metal reflected nothing and the brushed-steel espresso machine rendered near black (screenshot `espresso_pbr_before_studio_reflections.png`).
* **Not used:** `pbr_synthesize_material` texture maps (its kernel output is uniform FBM noise). Materials are factors only; texture maps are future work.

## 3. Measurements and what worked (Verified)

### Shape accuracy: clay reference vs full-colour reference

Same pipeline, same prompts, two runs each (`gemini-4-argon` reading the spec, Nano Banana Lite drawing the reference). "Pass-1 high" is the number of high-confidence shape differences the vision model listed between the reference and a clay render of the first build; "remaining" is what it still listed for the returned build after up to two revisions. Lower is better. The comparison is of shape only in both arms (the render it sees is always clay).

| Prompt | Reference | Run | Outcome | Pass-1 high | Remaining high | Parts | Seconds |
| :--- | :--- | :---: | :--- | :---: | :---: | :---: | :---: |
| a brushed-steel espresso machine | colour + materials | 1 | built | 10 | 8 | 32 | 727 |
| a brushed-steel espresso machine | colour + materials | 2 | failed (a child off its parent after 2 revisions) | - | - | - | 835 |
| a brushed-steel espresso machine | clay | 1 | failed (interpreter: a sweep that turns straight back) | - | - | - | 379 |
| a brushed-steel espresso machine | clay | 2 | built | 9 | 9 | 24 | 399 |
| a glass perfume bottle with a gold cap | colour + materials | 1 | built | 3 | 3 | 4 | 153 |
| a glass perfume bottle with a gold cap | colour + materials | 2 | built | 5 | 5 | 9 | 224 |
| a glass perfume bottle with a gold cap | clay | 1 | built | 6 | 7 | 7 | 160 |
| a glass perfume bottle with a gold cap | clay | 2 | built | 4 | 5 | 4 | 77 |
| a vintage red fire hydrant | colour + materials | 1 | built | 7 | 4 | 25 | 638 |
| a vintage red fire hydrant | colour + materials | 2 | built | 3 | 6 | 22 | 470 |
| a vintage red fire hydrant | clay | 1 | built | 6 | 5 | 23 | 385 |
| a vintage red fire hydrant | clay | 2 | built | 6 | 4 | 22 | 297 |
| an alien seed pod | colour + materials | 1 | built | 5 | 6 | 21 | 778 |
| an alien seed pod | colour + materials | 2 | built | 6 | 6 | 27 | 632 |
| an alien seed pod | clay | 1 | built | 6 | 7 | 20 | 244 |
| an alien seed pod | clay | 2 | built | 8 | 8 | 33 | 491 |

* **Builds that succeeded:** 7 of 8 in each arm (the espresso machine failed once in each, for different reasons).
* **Mean pass-1 high-confidence differences:** colour 5.6, clay 6.4. **Mean remaining:** colour 5.4, clay 6.4. Shape accuracy did not drop with the colour reference (if anything it is slightly better, within run-to-run noise at n = 2), so no clay-only reference is kept for shape reading.
* **Cost:** mean wall time per build 557 s with materials vs 304 s clay (1.8x). Material blocks are 17-23 % of the spec JSON, which does not explain all of it; the colour builds also came out slightly larger (mean 110k vs 82k vertices, 20 vs 19 parts). This is a real slowdown, reported rather than hidden.
* **What the vision model read** (run 1 of each; plausible throughout): hydrant body "weathered red cast iron paint" `[0.38, 0.04, 0.04]` metalness 0, caps "aged tarnished brass" metalness 0.85; espresso body "brushed stainless steel" `[0.60, 0.61, 0.62]` metalness 1 roughness 0.32, drip tray "matte black ABS", water tank "smoky translucent plastic" transmission 0.75 ior 1.49, portafilter handle "satin dark walnut"; perfume "thick clear glass" transmission 0.96 ior 1.52, liquid transmission 0.9 ior 1.36, "satin gold metal" cap metalness 1; seed pod with a translucent emissive amber sac (transmission 0.7, emissive strength 2.2).

### Live app

* **Fire hydrant** — "Build a 3D model of a vintage red fire hydrant" → built in 430 s (22 parts, 99k vertices), opened in PBR mode: red enamel body, brass caps and chains reading as metal (`fire_hydrant_pbr.jpg`). The agent's reply said the materials are "factor values inferred from an internal reference image (no texture maps)". "Studio Grey Clay" → the same object in clay (`fire_hydrant_clay.png`).
* **Espresso machine** — built with 32 parts; before the studio reflections the steel rendered near black (`espresso_pbr_before_studio_reflections.png`; the in-app visual check also said it looked matte black); after them it reads as brushed steel with a black drip tray and dark wood handle (`espresso_pbr.png`).
* **Perfume bottle** — clear glass showing the pale gold liquid inside and a gold cap (`perfume_bottle_pbr.png`); asked for clay, the viewport switched to studio clay (`perfume_bottle_clay.png`).
* **Alien seed pod** — "...in plain grey clay, just the form" → the agent passed `clay: true`; the GLB has one clay material with provenance `clay` (`alien_seed_pod_clay_request.png`). The follow-up asking for the same object with its real colours and materials did not finish live: the dev server was stopped (SIGTERM from outside the session) during its first revision. The two headless colour builds of the seed pod in the measurement above did complete (21 and 27 parts, an emissive translucent amber sac read with transmission 0.7 and emissive strength 2.2).
* **Tests** (all through the credential-guarded runner, no billed calls): `object-spec-materials.test.ts` (new: ranges in TS and the interpreter, factors per part in the GLB, copies share the seed's material, clay build all clay, vertex colours stay white), `studio-reflections.test.ts` (new), `object-reference-tool.test.ts` (updated: default build is PBR with a colour reference and labelled materials; clay request; missing or out-of-range material gets the re-ask; given spec labelled `as-given`), `object-spec-interpreter.test.ts`, `object-build-spec.test.ts`, `python-engine-mesh-integrity.test.ts`, and the atmosphere suites. `npm run typecheck`, `npm run lint` (0 errors) and `npm run lint:primitives` pass.

## 4. What did not work / left open

* **Build time roughly doubles** with materials (above). Not addressed.
* **The shape comparison still sees a clay render**, so a wrong material is never caught or revised. A colour render of the build (the review renderer can draw material colours) compared with the reference would let revisions fix materials too.
* **No reflections at real places:** a textured object staged on 3D tiles gets no studio reflections (deliberately: a grey room is the wrong thing to reflect outdoors), so its metal may still look dark there until the scene has a sky environment.
* **`apply_material` squares colours** for every other `sb` script: it paints the base colour into `COLOR_0`, which glTF viewers multiply by `baseColorFactor`. `object_spec.py` now avoids it; the helper itself (`packages/core/src/python/scratchbox/__init__.py` `_mesh_apply_material`) is unchanged.
* **Follow-up suggestions** written by the chat prompt still offer `pbr_synthesize_material` texture maps; that prompt belongs to the textured-default work and was not edited here.

## 5. Candidate Tool/Service Ideas

* **Material comparison pass** — compare a material-colour render of the build with the reference and send material differences into the revision, the way shape differences are sent now. This session judged material reading only by eye and by reading the specs.
* **Save-a-viewport-frame endpoint** — the Browser pane screenshots are 800 px wide and have to be copied out of the tool-results folder; a route that writes the canvas at full resolution to `test-results/` would make these records sharper.

## 6. Reproduction Steps

1. In the worktree: `env SCRATCHBOX_NO_ELECTRON=true PORT=3571 SCRATCHBOX_WEB_PORT=3572 SCRATCHBOX_TOOLS_PORT=3573 SCRATCHBOX_ALLOWED_ORIGINS=http://127.0.0.1:3572 SCRATCHBOX_PYTHON=<repo>/.venv/bin/python npm run dev`, open the logged `?token=` URL.
2. Ask "Build a 3D model of a vintage red fire hydrant" (or the espresso machine, perfume bottle, alien seed pod); the scene opens in PBR mode with `data.objectBuild.materials.label === 'generated'`.
3. Ask for clay ("...in plain grey clay") to get `clay: true`, a clay reference and one clay material per part.
4. Screenshots: `test-results/screenshots/object_materials/` (gitignored).
