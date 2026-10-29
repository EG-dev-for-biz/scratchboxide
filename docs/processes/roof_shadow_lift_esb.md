# Process: roof and terrace cast-shadow lift (suns fitted from the mesh) on the Empire State Building

> **Recorded:** 2026-10-29
> **Status:** Needs Fix (runs live in pipeline K and on district twins; on the ESB it lifts the 86th-floor deck and most setback strips with the photo seams unchanged, but 1,805 m2 of roof seen from above still has no sun)
> **Tags:** `operate-scratchbox` `pipeline-k` `roof-shadow` `texture-lighting` `empire-state`
> **Target Domain:** staged locations / pipeline K and district twins / textures

---

## 1. Session Context

* **What prompted this session:** the user pointed at the tower's shadow on the ESB's top decks, then at the dark strips along the foot of the setback walls ("terraces all the way down... resolved as a rule"), and asked that any build or district be judged from the top down as a whole. Image-model relighting (pipeline_k_view_relight_esb.md) never removed that shadow.
* **What was built:** `pipeline-k/roof-shadow.ts` (`SCRATCHBOX_K_ROOF_SHADOW=1`, node graph `twin.roofShadow`; off by default), run in the twin before harmonising, for pipeline K's building and for a district's tile_refine twin. Run note `roof_shadow.json`; the top-down audit `roof_shadow_topdown.png` beside the twin.
* **Instance used:** web `3910`, API `3911`, tools `3912` (`scratchbox-view-relight`, this checkout).
* **Scope tested:** ESB builds from the chat, isolated, pipeline K: runs `dd033adb` (per-deck fit), `da379575` (terrace rule), `45a8021f` (per-photo suns, neighbours), `3f4e8eb1` (terraces across photos, lit-level cap, audit). The remesh came from the stage cache in each (the same twin input as the relight-off run `c01f9e98`, twin `acc43b23`: 85,412 seam pairs in every run); each twin was computed fresh (new stage key per version). Dry runs between builds on the published relight-off twin.

---

## 2. What Was Tested & What Worked (Verified)

* **The method (no new data):** a shadow map per candidate sun (the whole mesh rendered from the sun, every roof texel's ray toward it answered at once), plus the extraction's neighbours as occluders, less what stands over the twin's footprint. Suns are fitted three ways, each gated (shadowed part darker by 1.2x or more, no channel stepping 1.5x another, clearly better than the median candidate, both checkerboard halves agree): per deck plane across photos; per photo on its own terraces; per terrace across photos on the suns already found. A photo takes a deck's sun only after its own cells on that deck confirm it.
* **Fits:** 9 of 12 decks matched a sun in `45a8021f`. The 86th-floor deck (318.5 m) and the 295.5 m deck agree independently (az 0-5, el 55-60; lit 2.5x and 2.0x the shadow). With the neighbours as occluders the 13 m deck fits too (az 225, el 15: their long shadows).
* **Rule coverage (`3f4e8eb1`, from above):** 2,326 m2 lifted, 368 m2 in shadow but rejected, 1,805 m2 with no sun, 2,799 m2 lit (`docs/screenshots/view_relight_2026-10-29/roof_shadow_audit_live.png`: green lifted, orange rejected, magenta no sun, grey lit). 39 s for the step.
* **Seams:** harmonised photo seams 0.1263 against 0.1263 with the lift off (before harmonising 0.1521 against 0.1517). Every image-model relight arm left them further apart.
* **Halos fixed:** without a cap, texels the mesh puts in shadow but the photo shows lit (scan edges a few centimetres off, vents, railings) glowed orange and white. The lift is now capped at the terrace's lit level; the close-ups (`roof_shadow_upper_terraces.jpg`, before / uncapped / capped) show the halos gone and the deck still evened.
* **Evidence:** `roof_shadow_86th_deck_top.jpg` (the deck from above, before and after), `roof_shadow_full_height.jpg` (both sides, lift map down the whole building; nothing darkened anywhere), `roof_shadow_app_viewport.jpg` (the build in the app viewport).

---

## 3. What Broke / Didn't Work

* **1,805 m2 of roof has no sun.** Mostly two blocks of the 5th-floor base roof and strips on the middle terraces: atlas fragments of photos that neither confirm a deck's sun nor fit alone (under 200 roof cells), on terraces across photos whose best known sun fails a gate. The audit shows them; the rule does not yet resolve them.
* **368 m2 in shadow but rejected:** terraces whose shadowed part is not darker under their photo's sun (a different capture) or steps by a colour change.
* **Harmonise's roof classes call most of the 86th-floor deck hidden** (310-320 m: 410 of 2,996 m2 roof): the corner height map at 0.5 m on the ESB's overlapping-box scan. The lift decides roof with its own filled map from above; the harmonise classes are unchanged (they also decide the twin's roof de-light).
* **The chat's first build request failed once** ("The AI request failed: fetch failed"); resent, it ran.
* **The first audit note named the cache's temporary folder** (`<entry>.tmp-<pid>-<hex>`); fixed to name the entry.

---

### The shadow-lift QA (any lift method, the ESB as its baseline)

`pipeline-k/shadow-lift-qa.ts` (`evaluateShadowLift`) judges a lift from the photos before and after it on the mesh they texture, knowing nothing of suns or method: the per-building step and a district pass are measured alike. It runs in the twin after the roof-shadow step (run note `roof_shadow_qa.json`, picture `roof_shadow_qa.png` beside the twin) and reports, over the surfaces seen from above:

* **halo**: a lifted texel that was darker than the unlifted surface around it and is now brighter than it by 15% or more (an over-lift; with the share at an edge);
* **lifted lit**: a lifted texel that was not darker than the unlifted surface around it (a wrong sun or shadow, or the patchwork of a per-photo lift: its shaded neighbours left unlifted);
* **residual**: still 25% or more darker than its surface after the lift;
* the median step from shade to the lit surface before and after;
* photo seams (texture-harmonize.ts's patch measure) before and after, all patches and lifted ones, and optionally after re-harmonising copies of both (for a lift applied after harmonising).

`ESB_SHADOW_LIFT_BASELINE` and `compareToBaseline` hold the ESB numbers any method is compared on.

| Measure (ESB, before harmonising) | uncapped lift (dry run) | capped lift (dry run) | live run 651b85ee: the baseline |
|---|---|---|---|
| halo share | 17.5% | 11.8% | 11.2% (97% at an edge) |
| lifted-lit share | 59.6% | 37.2% | 32.7% |
| residual share | 12.2% | 27.6% | 36.1% |
| step to the lit surface (log) | 0.43 -> 0.01 | 0.32 -> 0.04 | 0.35 -> 0.05 |
| photo seams after harmonising | 0.1255 -> 0.1285 (re-harmonised) | 0.1255 -> 0.1260 (re-harmonised) | 0.1261 |

From above (`roof_shadow_qa` picture) the defects are thin rims along the lifted areas' edges, not patches: the mesh's shadow edge a few decimetres off the photo's. Run 651b85ee's remesh was recomputed (78,593 seam pairs against 85,412 before), so its numbers stand on their own input. Its picture was lost when another session cleared the stage cache at 12:42; the run note keeps the numbers.

## 4. Candidate Tool/Service Ideas

* **No-sun photos by capture:** photos of one capture share a sun; grouping the no-sun fragments by appearance of their lit areas (white balance, exposure) or by atlas adjacency could hand them a sun none can fit alone.
* **Audit in the viewport:** the top-down audit as a layer the viewport can show over the twin, so the user sees what the lift missed without opening the run folder.
* **A/B in one build:** the twin with the step on and off on the same input, both GLBs and the audit; this session restarted the instance per arm.

---

## 5. Reproduction Steps

1. Launch entry with `SCRATCHBOX_K_ROOF_SHADOW=1` on free ports; start it.
2. Chat: "Build the Empire State Building, 350 Fifth Avenue, New York as a 3D building (isolated)."
3. Read `runs/<id>/roof_shadow.json` (`why`, `audit`, `records`, `photoRecords`, `auditPng`) and open the audit PNG it names.
4. For a district: "Build a textured 3D scene of the Flatiron District, New York." with the same flag.
