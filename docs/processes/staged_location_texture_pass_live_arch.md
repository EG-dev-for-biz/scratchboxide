# Staged location texture pass, live on Washington Square Arch

Date: 2026-10-17. Branch `texture-integration` (worktree `.claude/worktrees/texture-integration`). Ports: web 3062, API 3063, tools 3064 (`SCRATCHBOX_NO_ELECTRON=true`, started from the worktree's `desktop-app`). Screenshots: `test-results/screenshots/texture_live/` (gitignored).

## What was run

1. New chat, prompt `Washington Square Arch`. The agent called `google_3d_tiles_get_clay` (isolate). The run finished degraded in 6 min 44 s. The clay layers streamed first. The background `textures` stage committed after 4 min 58 s, and the clay stayed on screen.
2. The `Show real textures` chat pill (Textures & Materials) led the agent to call `staged_location_material_mode({ mode: 'textured' })`. The overlay read "Real textures on 1 of 2 layers", but every twin mesh drew clay (bug 1 below).
3. After the fixes I retried the stage twice through the chat (`retryRunId a8999706, retryStage textures`). I switched with the overlay toggle, captured frames, then turned on Provenance.

## Status: Verified, with open quality issues

| Item | Evidence |
|---|---|
| Clay is the first result and never waits for the texture stage | The first artifact that shows l3b has no `textured` field. The clay stream is the same event sequence with the pass on or off (`staged-texture-orchestrator.test.ts`). |
| Material swap (twin crossfades from clay, geometry not changed) | `r3_clay_*.png` vs `r3_tex_*.png`. The twin meshes had 124/124 (l3b), 29/29 (l4), 40/40 (l3cf) and 2/2 (l4f) with a baseColor map. |
| Provenance by rung | `r3_prov_*.png`: green = multi-view, blue = single view, orange = tile. The legend shares match the record. |
| Final per-rung shares, all 6 layers | 18.9% Street View multi-view blend, 8.4% Street View single view, 72.1% tile photo transfer, 0.5% measured palette colour, 0% generated PBR, 0% clay |
| Views and models | 16 registered Street View views (registration 1.28 m RMS after alignment). Enhancement model `gemini-3.1-flash-image`: in the first run it accepted 5 of 104 charts; after the fixes it hit its 75 s budget on 4 layers, so no chart was enhanced. |

### Per-layer timings (last retry)

| Layer | Projection (s) | Enhance (s) | Total (s) |
|---|---|---|---|
| l2 | 42 | – | 45 |
| l3b | 28 | 75, timeout | 105 |
| l3c | 14 | 75, timeout | 92 |
| l3cf | 14 | 75, timeout | 90 |
| l4f | – | 12 | 13 |
| l4 | 13 | 75, timeout | 89 |

The stage took 7 min 16 s. The limit is 600 s; it includes waiting for the rebuild.

## Bugs found live and fixed

1. **Twins drew clay.** The scene carries `clayPreset`, and `TileClayProcessor.applyClayMaterial` re-ran over the whole scene on the tool's update. Fixed: it skips meshes marked `sbKeepAuthoredMaterial`.
2. **Sky and trees painted on a fitted face across the arch opening.** The occluder was the fitted solid itself. Fixed: the scan alone is the occluder, plus an observed-surface check (0.5 m + 3 cm/m).
3. **Exposure step between the warm tile and the cool Street View** (visible on the piers). Fixed: per-channel median gain over the overlap. Live gains: l3b 0.75/0.82/0.81, l2 0.99/1.13/1.17.
4. **The enhancement took 233 s of the 300 s stage**, with 79 of 104 charts rejected by the edge gate. It now has its own 75 s budget.
5. **The detail layer (l4) committed after the pass started, stayed clay, and covered the textured piers.** Fixed: every shown mesh layer is textured, and late layers are textured once the rebuild settles.
6. **The inner walls of the arch showed buildings seen past the silhouette.** Fixed: a pose-aware depth-edge guard (half the pose sigma in px). This also cut the Street View share on l3b from 37% to 16%.
7. **Duplicate degradation entries** (one per image of the same pano). They are now de-duplicated.

## Open issues from the first run, and what became of them

See "Quality pass" below for the evidence.

- **Ghosting.** Fixed: per-chart image alignment and one view per region (the spandrel figures, the inscription and the Greek key read single and sharp).
- **Dim, blue lighting.** Fixed: the studio rig's ambient light was replaced by light steel blue for geo-anchored scenes, and its levels were too low. Clay now renders sRGB 130/134/143 where it rendered 86/93/105 from the same camera.
- **Translucent l4 panels.** Diagnosed and fixed. The native detail solids include primitives wound inside out. The clay draws double-sided, which hid this. The twin drew front faces only, so it showed the solid's far inner faces, which carry the wall texture. The twin is now double-sided. In this run the detail stage did not run (vision timeout), so the fix was verified in a headless render, not live.
- **Seams.** The views now meet at boundaries chosen where they agree, blended in 6 bands. The source-disagreement metric itself did not drop (see the table). The target of p95 < 6 ΔE00 is **not met** by that metric. Measured as a low-frequency step in the output, seams sit at 1 to 6 ΔE00 above the texture's own contrast.
- **No solar de-lighting.** Not changed: capture times are still month-only.
- **Partial enhancement results lost on timeout.** Fixed: accepted charts are kept. In this run no chart was accepted, though: 27 + 26 + 26 + 2 + 1 were rejected by the edge gate and 107 timed out.
- **Ornament spec `lattice.counts 800 > 400`.** Fixed: a replicate read past 400 per axis is split into blocks that place the same instances.

## Candidate tool/service ideas

- An app endpoint to capture the active 3D view to a file at a chosen size and pose. I hand-rolled a localhost receiver plus `__scratchbox_capture_active_3d_scene`.
- A `staged_location_texture_report` tool that returns the per-layer cache records (rung shares, timings, degradations) without reading `.scratchbox/cache` by hand.
- A per-island shift search against the best view before blending, to address the ghosting.

## Quality pass (branch `texture-quality`, 2026-10-17)

Worktree `.claude/worktrees/texture-quality`. Ports: web 3062, API 3063, tools 3064. New chat, prompt `Washington Square Arch`. Screenshots are in `test-results/screenshots/texture_live_v2/` (`clay_*`, `tex_*` and `prov_*` for front, back, frieze_front, frieze_back, pier_front_left, pier_front_right, pier_back_left, statues_front and opening; the poses are taken from the facade normal; gitignored).

### What changed

1. **Per-view, per-chart image alignment** (`texture-alignment.ts`). For each atlas chart, each view's projection is moved by an image shift that maximises gradient NCC against the other views and the tile photo. The tile photo is registered to the geometry, so it fixes the gauge.
   - The search runs coarse to fine on a luminance pyramid whose base is anti-aliased to the texel grid. The window is ±2 pose sigma.
   - A shift is accepted only when it is robust; otherwise the view's median shift is used, otherwise none.
   - A per-chart affine field is fitted over tiles, and the search has a 20 s budget.
   - Each shifted sample re-reads its colour from the photo. The report gives the implied per-view yaw/pitch and the inter-view gradient NCC before and after.
2. **One view per region** (`texture-seams.ts`). Exposure gains are applied per chart and per view. A block MRF (8 x 8 texels, ICM) picks one view for each region, so boundaries fall where the views agree. The band blend (bands 1/2/4/12/32 texels) then blends the chosen views at those boundaries only. Pass version: `texture-pass/3`.
3. **Neutral studio light** (`lightingRigs.ts`). The ambient keeps the rig's own colour. Studio levels: ambient 1.0, key 2.25, fill 0.7, top 0.5. In the headless test, a sRGB 128 grey texture renders 133.9/133.9/133.9; before, it rendered 89.9/92.4/96.1.
4. **Double-sided twins**, and outward texel normals for closed solids that are inside out (`staged-glb-writer.ts`, `texture-uv.ts`).
5. **Enhancement keeps accepted charts** when its budget runs out (`texture-enhance.ts`).
6. **Edge guard at 0.25 pose sigma**, down from 0.5. The measured curve is below.
7. **Ornament replicate split** at 400 per axis (`ornament-expand.ts`).

### Live run (after)

- Registration: 1.95 m RMS before alignment, 1.38 m after, 275 pairs, 1 pano set aside.
- 15 views.
- The detail stage did not run: `gemini-4-argon` passed its 250 s limit, so there is no l4 layer.
- The textures stage committed in **6 min 43 s** (the earlier run took 7 min 16 s).
- Legend over the shown layers: Street View multi-view **31%**, single view **5%**, tile **63%**, palette 1%. The earlier run had 18.9%, 8.4%, 72.1% and 0.5%.
- No new server or console errors.

| Layer | Street View share (multi + single) | Source seam p95 / max ΔE00 | Projection (s) | Enhance |
|---|---|---|---|---|
| l2 | 27.1% | 28.6 / 57.0 | 43.6 | 1 chart rejected |
| l3b | 23.1% (16% before the fix, 37% before the guard existed) | 23.1 / 42.8 | 13.0 | 0 of 113 accepted, 83 timed out |
| l3c | 64.0% | 24.9 / 70.8 | 40.2 (alignment hit its budget) | 0 of 40, 13 timed out |
| l3cf | 64.5% | 21.9 / 69.6 | 39.6 (alignment hit its budget) | 0 of 38, 11 timed out |
| l4f | 10.5% | 18.7 / 28.0 | 3.1 | 2 rejected |

### Before/after on the same images

The live inputs were dumped once and replayed through origin/main and through this branch. The origin/main replay reproduced main's albedo bit for bit.

| Layer | Street View share | Source seam p95 / max | Output step p95 / inside-region p95 (new) | Inter-view gradient NCC | Leak proxy |
|---|---|---|---|---|---|
| l2 | 18.9 → 26.2% | 21.0 / 78.8 → 28.9 / 68.3 | 17.5 / 14.5 | 0.027 → 0.277 | 4.4 → 3.8% |
| l3b | 18.3 → 25.8% | 20.4 / 77.3 → 23.1 / 80.1 | 20.4 / 15.1 | 0.053 → 0.261 | 5.3 → 7.3% |
| l3c | 40.2 → 50.5% | 20.0 / 61.8 → 25.0 / 65.6 | 15.7 / 15.7 | 0.034 → 0.060 | 1.5 → 2.1% |
| l3cf | 41.4 → 51.6% | 22.5 / 51.0 → 25.4 / 48.7 | 15.3 / 15.2 | 0.036 → 0.068 | 0.7 → 1.1% |
| l4f | 1.7 → 8.0% | 12.6 / 14.0 → 11.6 / 31.0 | 13.4 / 16.7 | – | 4.1 → 2.6% |

How to read the columns:
- **Source seam:** at each boundary between dominant views, the ΔE00 between the two views' own colours (5 x 5 means). It measures how much the views disagree where they meet, not what the output shows. It rose with the wider coverage and with the boundaries the MRF moved. It is far from the < 6 target.
- **Output step:** the low-frequency colour step in the final texture across those boundaries (5 x 5 means, 6 texels apart), against the same measure inside one view's region. On l3c, l3cf and l4f it is no larger than the texture's own contrast; on l2 and l3b it is 3 to 5 ΔE00 above it. Main's averaged output scored 12.8 / 12.5 on l3b, but that output is ghosted and soft: its joint contrast is about 60% of a sharp bake (see the synthetic test).
- **Leak proxy:** the share of baked texels whose 5 x 5 colour is more than 25 ΔE00 from the tile photo there.

Synthetic checks (`texture-projection-alignment.test.ts`): three views of a facade with carved joints, each with a 0.3 to 0.6 degree pose error.
- Inter-view gradient NCC rose from 0.28 to 0.65, which is what exactly registered views reach (0.65).
- Gradient NCC of the bake against the truth rose from −0.13 to 0.88.
- With exact poses the alignment moves nothing.
- One view per region keeps joint contrast at 23.1, against 13.6 for the weighted blend and 22.1 for registered views.

### Edge guard curve (replayed)

Street View share / leak proxy for each guard share:

| Guard share | l3b | l2 |
|---|---|---|
| 0 | 33.1 / 7.4% | 32.7 / 4.0% |
| 0.15 | 29.3 / 6.5% | – |
| 0.25 | 25.8 / 6.6% | 26.2 / 3.9% |
| 0.3 | 23.9 / 7.1% | – |
| 0.5 | 18.3 / 4.1% | 18.9 / 3.3% |

The texels added between 0.5 and 0.25 are "far" from the tile photo 13% of the time on l3b and 5% on l2. Chosen: 0.25.

### What I saw (`tex_*` against the first run's `r3_tex_*`)

- **Better:**
  - The inscription on the attic reads ("TO COMMEMORATE THE ONE HUNDREDTH ANNIVERSARY ...").
  - The spandrel Victories and the right spandrel's shield are single and sharp, where `r3_tex_frieze_front` showed double images.
  - The Greek key band is crisp.
  - The pier faces carry one photo each instead of a blurred average.
  - The clay is mid grey, not navy.
- **Still wrong:**
  - Some boundaries between views show as rectangles, for example a lighter patch on the right spandrel and a square near the keystone.
  - The band under the inscription is blurry tile texture.
  - The fitted piers carry photos whose relief sits slightly off the geometry's edges (the alignment works in 2D per chart, and the pose residual is still 1.4 m).
  - The figures (l4f, l3cf) are mostly tile texture, with visible blocky islands.

## Open issues (after the quality pass)

- **Seam target not met.** The source-disagreement p95 is 22 to 29 ΔE00. The views really differ by light and capture date, and per-chart gains cannot undo cast shadows. Next step: gradient-domain (Poisson) blending at region boundaries, or a shadow-aware data term in the MRF.
- **Alignment is weak on the as-scanned lumps** (l3c, l3cf: NCC 0.03 → 0.06). On both layers it hits its 20 s budget (recorded as `alignment_timeout`).
- **The pose itself is not refined.** The per-view yaw/pitch implied by the chart shifts is reported but not fed back into the registration. Feeding it back would let the depth test and the edge guard use corrected poses.
- **Enhancement accepted nothing** in this run: 0 of 194 charts. The edge gate rejected 82 and 107 timed out.
- **The l4 see-through fix was verified only headless:** the detail stage timed out live (vision 250 s).
- **The native ornament builder still emits inside-out shells.** The viewport no longer shows them, but the C++ winding should be fixed at the source.
