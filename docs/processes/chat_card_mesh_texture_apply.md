# Process: Chat media card texture buttons apply to the selected scene mesh, or say why not

> **Recorded:** 2026-10-30
> **Status:** Verified (scene meshes in a studio scene: applied, undone, persisted, clay mode, full PBR set; failures for nothing selected, a missing image and no open viewport). A selection on a loaded or generated model was checked by vitest only.
> **Tags:** `operate-scratchbox` `chat-media-cards` `3d-viewport` `pbr-materials` `honest-status`
> **Target Domain:** Generative Canvas / chat media cards / 3D viewport

---

## 1. Session Context

* **What prompted this session:** the chat media cards' texture buttons were cosmetic. "Apply as 3D Texture" / "Apply as Texture" opened a 3D scene and showed "<action> Succeeded!" after an 800 ms timer. The PBR matrix card's "Bake into C++" sent an event nothing listened to, and its "Project to Mesh" showed "Applied!" on a timer. The only listener (`GenerativeCanvasStudio.handleApply3DTexture`) switched the layout and raised a toast that is never rendered.
* **Instance used:** web port `3170`, API port `3171`, tools port `3172` (own `scratchbox-great-aryabhata` entry in `.claude/launch.json`, removed after the run). The workspace was this worktree's `desktop-app`.
* **Scope tested:** `ImageGeneratedCard` "Apply as 3D Texture" and `TextureMatrixCard` "Apply to Selected Mesh" against a studio scene holding two scene meshes (`customMeshes`: a box `pedestal`, a sphere `orb`). The session was seeded in localStorage: a brick PNG drawn in the page as a data URI, a card whose image path 404s, and a texture-matrix message with five generated 128 px maps. No model was called for the seeds.

---

## 2. What Was Tested & What Worked (Verified)

* **Nothing selected:** clicked Apply on the brick card with no selection. The card showed (amber) "Nothing is selected in the 3D viewport. Select a mesh, then apply again." and the scene data did not change. Screenshot `test-results/screenshots/mesh-texture-2026-10-30/1-nothing-selected-failure.jpg`.
* **Applied to the selected mesh:** clicked the box in the viewport (`__SB_LAST_PICK__.selected = "pedestal"`), then Apply. The card showed (green) "Applied to 'Pedestal': base colour map." The box rendered brick, and the Orb did not change. Scene data: `pedestal.pbrTextures = { albedoUrl: data:image/png… }`, `material.color = "#ffffff"`. Live material: `MeshPhysicalMaterial`, colour `ffffff`, map 256×256. The action log ends `apply_mesh_texture`, and the undo counter reads 1. Screenshot `2-brick-applied-to-pedestal.jpg`.
* **Undo:** the viewport undo button restored `material.color "#38bdf8"` with no `pbrTextures`. The live material went back to `38bdf8` with no map, and the box rendered blue again. Screenshot `3-undo-removes-texture.jpg`.
* **Image that does not load:** selected the Orb and clicked Apply on the card whose image 404s (`GET /media/does-not-exist-texture-check.png → 404`). The card showed "The base colour image (/media/does-not-exist-texture-check.png) could not be loaded. Nothing was changed." The Orb data was unchanged and no undo step was added. Screenshot `4-missing-image-failure.jpg`.
* **Clay mode:** reloaded the session with `renderMode: 'clay'`, selected the Orb and clicked Apply. The card showed "Applied to 'Orb': base colour map. The viewport is in clay mode: switch it to textured to see it." The Orb still wears clay (`b0b8c4`). The material clay mode set aside (`userData.sbClayOriginalMaterial`) holds the 256×256 map. Before this change, a texture that finished loading under clay was dropped. Screenshot `5-clay-mode-applied-with-note.jpg`.
* **Persistence:** reloaded with `renderMode: 'pbr'`. The Orb drew the brick from the saved scene data (live colour `ffffff`, map set). Screenshot `6-reload-textured-orb-persisted.jpg`.
* **No open viewport:** switched to the chat-only layout (0 `.sb-scene3d-primitive-container`) and clicked Apply. The card showed "No 3D scene is open. Open the scene, select a mesh in its viewport, then apply again." No scene was opened or created. Screenshot `7-no-viewport-failure.jpg`.
* **PBR matrix card:** the card now shows only the channel pills and "Apply to Selected Mesh". "Bake into C++", the "Triplanar Enabled / Standard UV" toggle and the "Mapping: TRIPLANAR" label are gone, because nothing implemented them. With the box selected, the card showed "Applied to 'Pedestal': base colour, normal, roughness, metalness and ambient occlusion maps." The live material has map, normalMap, roughnessMap, metalnessMap and aoMap, with roughness and metalness factors of 1. Screenshot `8-pbr-matrix-full-set-applied.jpg`.
* **Image over a PBR set:** applied the brick over that set. The normal, roughness, metalness and AO maps were dropped, and the roughness and metalness factors (1, set only to multiply those maps) were removed. Live roughness and metalness are back to the viewport's 0.5 and 0.1. Screenshot `9-brick-over-pbr-set-nonmetal.jpg`.
* **Health:** every API call returned 200 (`PUT /workspace/sessions/sess-texture-check`, `POST /workspace/project-artifacts`, …). The only console errors were the deliberate 404 for the missing image, once per reload.

---

## 3. What Broke / Didn't Work

* **Image over a PBR set left the surface metallic (found and fixed this session):** the first version kept `metalness: 1` / `roughness: 1` when a base-colour-only image replaced a full set, so the brick drew as metal. `applyMeshTexture` now drops a factor whose map is gone. The fix was re-checked live (screenshot 9) and in `mesh-texture-apply.test.ts`.
* **Not exercised live:** switching a plain scene from clay back to textured. No user control changes `renderMode` on a non-staged scene: only scene data, the agent or the staged overlay can. The set-aside material was checked to hold the texture, and that material is the one clay mode restores.
* **Not exercised live:** a selection that is part of a loaded or generated model. It is covered by vitest ("'Marble statue' is not one of the scene's own meshes…"). Image textures are not applied to models: `objects[].material` (`ObjectMaterialOverride`) has no texture channel, and generated-model parts have no scene-data record to persist one in.
* **Side observation, not caused by this change:** each scene load in this session ran the app's automatic "Visual check (gemini-3.8-flash · Vertex AI)". These were real model calls, and their notes appeared in the chat.

---

## 4. Candidate Tool/Service Ideas

* **Seed a chat session through an API** — a debug endpoint or `window` hook that loads a session (messages plus artifact) into the studio. This session had to write `scratchbox_studio_sessions_v18` in localStorage and reload, which also wrote a session file into the workspace's `.scratchbox/sessions`.
* **Render-mode switch for any scene** — a viewport control, or a `window.__SB_…` hook, that sets `renderMode` the way the staged overlay's clay/textured toggle does. Only scene data can change it today, so the clay-to-textured restore could not be clicked live.
* **Image textures on loaded models** — a texture channel on `ObjectMaterialOverride` (`materialOverride.ts` `fill`), applied only where the mesh has UVs. Without it, "Apply as 3D Texture" can only report that a model selection takes no image texture.

---

## 5. Reproduction Steps

1. Add a launch entry for this worktree on three free ports (see the `operate-scratchbox` skill) and open the web port.
2. In the page, write a session to `localStorage['scratchbox_studio_sessions_v18']` (and its id to `scratchbox_studio_current_session_id_v18`). Give it an assistant message with `imageContent` (any PNG data URI), and an `activeArtifact` of type `3d-scene` whose `data.customMeshes` holds a `box` and a `sphere`, with no `cppGenerator` / `pythonGenerator` (native geometry hides scene meshes). Use `layoutMode: '3d'`, then reload.
3. Hover the image and click "Apply as 3D Texture": expect the nothing-selected failure.
4. Click a mesh in the viewport, then Apply again: the mesh draws the image, the card names it, and the viewport's undo removes it.
