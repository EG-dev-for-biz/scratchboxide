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

## Round 3 (branch `texture-quality-3`, 2026-10-17)

Worktree `.claude/worktrees/texture-quality-3`. Ports: web 3062, API 3063, tools 3064. Two cold live runs of `Washington Square Arch` (the texture and vision caches were cleared before the second). Screenshots: `test-results/screenshots/texture_live_v3/` (`clay_*`, `tex_*`, `prov_*` for the same 9 view names as v2; gitignored). The poses were set from the facade heading (33° front, 213° back) through the viewport's own orbit refs, so they are close to v2's but not identical.

The fit stage on this branch includes the newer tile-refine and relief commits from main. So the fitted geometry differs from v2's (the arch opening is taller), and a view-by-view comparison with v2 is confounded by that.

### What changed

1. **Seams** (`texture-seams.ts`, `texture-projection.ts`, pass `texture-pass/4`):
   - **Gradient-domain blend.** One view per region is now blended with a screened Poisson solve per chart (conjugate gradients, Neumann at gutters and other rungs, λ = 0.01). Across a boundary the guidance is the smaller of the two views' own steps. It replaces the band blend, which took up to 40 s per layer; the solve takes under 1 s.
   - **Shadow-aware data cost.** The block MRF penalises a view whose block luminance is more than 0.3 log below the median of the views there (the mean of the two when there are only two). When a view's capture time is known, it also penalises texels facing away from that view's sun.
   - **Edge-following boundaries.** Block boundaries are refined texel by texel onto image edges.
2. **Pose feedback** (`texture-pose-refine.ts`). Every aligned chart sample is a 2D-3D correspondence. Each view's pose (eye shift east/north, heading, pitch) is solved from these correspondences, using two or more charts, and the views are then projected and aligned again.
   - The refined poses are kept only when the poses alone make the views agree better (+0.05 inter-view NCC before any shift) and the final agreement is no worse.
   - The refinement is skipped when the alignment's own NCC is below 0.35.
3. **Alignment on the lumps.** I tried a geometry reference built from the scan's own normals (sky exposure plus convexity) and a full, unbudgeted search. Neither changed the inter-view NCC on l3c much:

   | l3c run | NCC (before → after) | Notes |
   |---|---|---|
   | 20 s budget | 0.036 → 0.067 | |
   | Full search | 0.036 → 0.089 | 37 s |
   | Geometry reference at share 1.0 | 0.036 → 0.075 | |
   | Geometry reference at share 0.5 | 0.036 → 0.067 | |

   The views of the as-scanned lumps barely agree, because the relief parallax is not modelled. So the geometry reference was not shipped and the budget stays at 20 s. Instead, the texture stage now runs **3 layers at once**, so one layer's model wait overlaps the next layer's projection.
4. **Enhancement** (`texture-enhance.ts`). I measured 159 real `gemini-3.1-flash-image` answers on the live charts, with every gate metric recorded (scratch harness, billed):
   - 142 answers failed three or more metrics. I looked at them: on flat, soft tile crops the model invents structure (a Greek key, a grid of blocks, wood grain on a plain pier) or regrades the colour.
   - 6 answers passed the design gate. Near misses that only sharpened scored Sobel NCC 0.954 to 0.996, so the threshold is now 0.95.
   - 26 answers could not be gated at all: they had no texel inside the 2 px border.
   - Many crops were a few fragments scattered in a crop of flat fill.

   What changed as a result:
   - A chart is now sent only if it has at least 256 gateable texels that fill at least 30% of the crop.
   - The crop is the bounding box of the transferred texels.
   - The crop is padded to the model's nearest supported aspect ratio, and the answer is cropped back.
   - Up to 12 charts are in flight at once.
   - The budget is 150 s per layer.
5. **Detail reading** (cherry-picked from the `detail-vision-timeout` subagent branch). The reading is now split into per-face batches of at most 6 images and 12 slots, run in parallel at thinking LOW. Each call has a stall watch: no first token within 60 s, or a silent stream for 30 s. The stage limit is 320 s.
   - Root cause of the old timeout: one call carried 22 images (24 MP) and about 85k prompt tokens. Every revision resent all of them. The focused run readings then ran inside the same 250 s.
   - A follow-up fix: the first live run showed that the reading let a repeat along an edge with `count 0` through, and the ornament build then failed its schema. Rule 7 now sends such a repeat back.
6. **Winding at the source** (cherry-picked from the `ornament-winding` subagent branch, `scratchbox_ornament.hpp`):
   - Partial revolves are made counter-clockwise, with their cut faces wound consistently.
   - Closed sweeps (rings) are wound by frame handedness.
   - Each proud panel is oriented on its own.
   - Every shell is checked by its signed volume about its own centroid.
   - Test: `photo-ornament-winding.test.ts` builds through the real native binary. It failed on main with 15 and 19 bad shells, and passes now.
   - The double-sided twin is kept as a safety net.
7. **The layer record** now keeps the output seam, the region-blend, alignment and pose-refine numbers, and the timings.

### Replay on the v2 live inputs (old = region select with band blend, as in v2; new = this branch)

| Layer | Source seam p95 (old → new) | Output step p95 (old → new) / interior | Low-frequency step p95 (old → new) / interior | Blocks left on a shadowed view (shadow cost off → on) |
|---|---|---|---|---|
| l2 | 24.4 → 30.9 | 17.3 → 11.8 / 14.8 | 16.4 → 12.0 / 14.1 | 369 → 263 |
| l3b | 18.5 → 20.7 | 17.0 → 12.2 / 14.2 | 17.7 → 13.2 / 15.4 | 148 → 110 |
| l3c | 26.5 → 29.1 | 16.8 → 15.4 / 15.4 | 14.5 → 15.0 / 14.0 | 359 → 235 |
| l3cf | 26.8 → 28.9 | 16.5 → 15.3 / 15.5 | 14.9 → 15.4 / 14.1 | – |

- **The seam the output shows went down.** The step across region boundaries is now at or below the texture's own contrast on every layer (it was 2 to 3 ΔE00 above it on l2 and l3b).
- **The source disagreement went up.** The source seam measures how much the chosen views disagree where they meet. Shadow avoidance moves cuts to where a lit view meets a shadowed one. With shadow cost off and the texel refinement on, it dropped (l3b 18.5 → 17.1, l3c 26.5 → 24.5).
- **The < 6 ΔE00 target is not met by either metric.** The views really differ by light and capture date.

Pose feedback on the same inputs:

| Layer | Correspondence RMS (m) | Inter-view NCC with the re-posed views | Result |
|---|---|---|---|
| l3b | 1.57 → 1.35 | 0.23 → 0.17 | Rejected |
| l3c | 1.39 → 1.22 | – | Rejected |

The per-chart shifts on the real arch are largely whole-course jumps on the repeated coursing. They agree in the image but are not consistent with any rigid pose, so the gate kept the registered poses. On a synthetic facade with non-periodic relief, the refinement recovers the true poses: RMS 0.15 → 0.007 m, and NCC from the poses alone 0.63 → 0.99.

### Live (second run, cold texture and vision stages)

- **Status: Verified, with open quality issues.** The run finished degraded in 5 min 49 s. The textures stage took 4 min 8 s, against 6 min 43 s in v2.
- **Registration:** 1.86 m before, 1.32 m after (210 pairs, 2 panos set aside).
- **Detail reading:** it ran: 24 vision calls in 3 min 2 s. Batch b7 returned an invalid reply with no time left to revise it, so its 10 slots stayed flat and the other batches stood.
- **Detail build:** it produced an `l4` layer. Some elements were dropped for self-intersection, and the stage summary reads "degraded".
- **Figures:** the figure reading degraded to the smoothed scan because the reply was invalid JSON. It had succeeded in the first run.
- **Errors:** there were no new server errors. One `PUT /workspace/sessions/...` returned 500 once, and the next save succeeded; the session routes were not touched on this branch.

| Layer | Street View share | Source seam p95 | Output step p95 / interior | Alignment NCC | Pose refine (RMS m) | Enhancement |
|---|---|---|---|---|---|---|
| l2 | 30.7% | 32.4 | 12.3 / 12.1 | 0.020 → 0.091 | – | 0 of 1 |
| l3b | 26.5% | 26.2 | 12.5 / 12.3 | 0.014 → 0.178 | 1.53 → 1.43, rejected | **8 of 112 accepted**, 69 rejected, 0 timed out, 81 s |
| l3c | 64.4% | 22.9 | 14.8 / 15.0 | 0.019 → 0.089 (budget) | 1.50 → 1.35, rejected | 0 of 39 (4 rejected, the rest not gateable or without a reference) |
| l3cf | 65.0% | 20.8 | 14.9 / 15.3 | 0.018 → 0.082 (budget) | 1.54 → 1.43, rejected | 0 of 37 |
| l4f | 53.6% | 11.1 | 5.1 / 12.7 | −0.005 → 0.254 | – | 0 of 2 |
| l4 (new) | 20.7% | 23.1 | 12.1 / 11.2 | 0.003 → 0.312 | – | 0 of 36 |

The first live run, with the textures cached cold the same way, accepted 10 of 115 charts on l3b, with 0 timed out. v2 had 0 of 194, with 107 timed out.

### What I saw (`texture_live_v3` against v2)

- **Better:**
  - The pier faces (`tex_pier_back_left`, `tex_pier_front_right`) show no rectangular exposure patches. The Greek key band and the pier carving read cleanly, and the light changes smoothly across view boundaries.
  - The detail layer is live: `l4` roundels and a triangular element on the attic (photo-inferred) render solid from both sides, with no see-through panels.
- **Still wrong:**
  - On the back spandrels (`tex_frieze_back`), adjacent regions show the carving offset from one another: angular patches along the fitted face's facets. These are misregistration, not exposure, and the Poisson blend cannot fix content that is in the wrong place.
  - On the front left pier (`tex_front`), the statue of Washington from the photos is smeared onto the pier face behind the figure: a pale ghost. The figure stage had degraded to the smoothed scan, so the occluder is thinner than the statue.
  - In `tex_opening`, the inner face of the right pier carries a tree and a building seen through the arch. It is labelled multi-view Street View. The depth-edge guard at 0.25 pose sigma lets it through on this geometry.
  - The attic band under the inscription is still soft tile texture. The inscription reads only partly ("…DTH ANNIVERSARY … E WASHINGTON"), where v2 read it whole. The fitted attic differs between the runs, and part of it is now covered by the l4 triangle.
  - Some detail elements read from photos, such as the attic triangle and the roundels on the back attic, do not look like features of the real arch. They are labelled `photo-inferred`.

### Open issues (after round 3)

- **Seam target not met** (source disagreement p95 20 to 32 ΔE00). The visible seams that remain are misregistration on the carved spandrels, not exposure.
- **Pose feedback is in place but never applies on the arch.** The alignment's shifts on repeated coursing are not pose evidence. A per-chart consensus that rejects whole-course jumps (RANSAC over charts, or a pose prior applied in the search) would be needed before the poses can be refined from them.
- **Alignment on the as-scanned lumps** stays at NCC ≈ 0.09. Neither more time nor the geometry's normals help; the relief parallax would have to be modelled (a depth-aware warp per view).
- **Enhancement mostly invents** on flat, soft tile crops. 8 to 10 of about 112 l3b charts pass, and none on the lumps. The gate is doing its job.
- **Leaks** remain on the arch's inner faces (background seen through the arch) and behind the statues when the figures degrade to the smoothed scan.
- **Detail reading:** one batch can still end with an invalid reply and no time left to revise it. The figure reading can return truncated JSON.

### Candidate tool/service ideas

- A `staged_location_texture_report` tool. The numbers now in the layer record are what it would return.
- An app hook to set the active 3D view's camera by target, heading, pitch and distance. I set it through the React refs of `Scene3DPrimitive` from the console.

## Round 4 (branch `geo-registration`, 2026-10-17)

Worktree `.claude/worktrees/geo-registration`, from `origin/main` `e6ea6f5b`. Ports: web 3062, API 3063, tools 3064 (server started from the worktree root with `npm run dev`). Three cold live runs of `Washington Square Arch` (runs `1147e5bb`, `5026cb65`, `30529604`; code fixes between them, see below). Screenshots of the last run: `test-results/screenshots/texture_live_v4/` (`clay_*`, `tex_*`, `prov_*`, same 9 view names as v3; gitignored). The poses were set with `window.__SB_SET_CAMERA_VIEW__` from the facade heading (33° front, 213° back) around the l3b bounding box, so they are close to v3's but not identical.

### What changed

1. **Geometric pano registration** (`pano-edge-registration.ts`). Every pano with a wide image in hand (survey and ring views, at least 50° wide) is posed against the full tile mesh (`extraction.geometryGlb`: the real opening, statues, trees, the buildings behind) by `StreetViewPoseRegistrar`: chamfer distance (truncated, orientation-binned distance transforms) from the mesh's sky silhouette, occluding contours and long creases (rendered with `HeadlessMeshSilhouetteRenderer`) to the photo's sky boundary and structural line segments. The photo is read at structural scale (reduced to 900 px, blur 2 px, segments of at least 30 px and gradient 6), so the joints between courses barely register. The search starts at the box pose (local 1 m / 1° grid, then bounded Nelder-Mead). Per pano the edge pose is kept only when a held-out measure prefers it: the inter-view gradient NCC through the scan (blur 3 px) with the other panos. The box-pair RMS is reported, never used to choose (the box poses were fitted to it). The chosen poses feed the located elements (pass 2), the close-ups' poses in the vision stage, the texture projection, and the pose sigma (edge residual, floor 0.25 m). A pose correction can now carry its reference heading, so all frames of a pano share one rigid rotation.
   - Live fix after run 1: the narrow close-ups (30-45° crops of carved faces) held the fit at the truncation and drowned the held-out measure, so only views of at least 50° register and judge a pano, and an edge pose must end below 5 px and below where it started.
2. **Occlusion from the true geometry** (`texture-projection.ts`, pass `texture-pass/5`). The full tile mesh rides along as `contextDepthFor`: a texel is hidden by the nearer of the scan and the remeshed occluder, and the photo must show the scan's own surface at the texel, not what lies past an opening. Samples the remeshed occluder alone would have kept are counted as caught leaks (hidden, seen past, at an edge).
3. **Reprojection accept gate** (`detail-reprojection.ts`). Each built photo-read element is rendered through the registered camera of every Street View image it cites (hidden behind the fitted structure where it stands behind it); the box of what shows is compared with the cited box (IoU, Dice). Below IoU 0.15 in every cited image, or not showing at all, the element is rejected with that reason and the detail is rebuilt without it. Elements read only from tile orthos are not gated. Scores: run note `detail_reprojection.json`.
4. **Robustness.** The figures are read one call per figure, in parallel, each asked again (up to 3 attempts) when the reply is cut off, not JSON, or a spec the builder refuses (the last added after run 2, where a relief part attached to a parent sent a figure to the smoothed scan). Each detail batch's revision has its own 75 s budget beyond the pass budget (the vision stage limit includes it).
5. **Alignment within the residual.** A view of an edge-posed pano is searched by the per-chart alignment within one pose sigma (its edge residual), not two, so the search cannot reach the next course. Live search half-widths: 15-21 px for the edge-posed views, 160 px (the cap) for the box-posed ones.

### Synthetic checks (all fail without the change)

- Repeated coursing facade (`staged-location-edge-registration.test.ts`): two panos off by one course and half a block. The texture cannot tell the stated pose from the true one (NCC within 0.15). The edge registration recovers the eye to < 0.2 m and the angles to < 0.3°, and the held-out NCC prefers it.
- Opening plus statue (`texture-projection-context-occlusion.test.ts`): against the fitted face alone, 300 texels in the opening and the statue land on the wall (leak share 27%); with the full scan, 0 leaked texels.
- Gate (`photo-ornament-reprojection-gate.test.ts`), figure retries (`photo-ornament-figures-reading.test.ts`), revision budget (`photo-ornament-batches.test.ts`), alignment window (`texture-alignment-edge-window.test.ts`).

### Registration, before and after

Replay on the v3 inputs (the 13 ring views of v3 run `f573fe2a`, fetched again; scratch harness): the edge pose won on all 12 panos. The edge residual went from the 12 px truncation at the box poses to 1.5-3.3 px (7 px on one pano, which the held-out measure then rejected in the stricter live version). Inter-view gradient NCC went from 0.001 (box poses) to 0.075. Overlays of the mesh edges on the photos showed the box poses drawing the arch's top about 1.5-2 m low; the edge poses sit on the silhouette.

Live:

| Run | Box solve RMS (fitted, m) | Panos posed by edges | Inter-view gradient NCC (box → chosen) | Box-pair RMS at chosen poses (m) | Time |
|---|---|---|---|---|---|
| 1 (close-ups included) | 1.87 → 1.38 | 5 of 17 | −0.012 → −0.003 | 1.48 | 67 s |
| 2 | 1.82 → 1.04 | 8 of 17 | 0.011 → 0.030 | 1.54 | 41 s |
| 3 (final) | 1.87 → 1.33 | 6 of 17 | 0.011 → 0.034 | 1.77 | 38 s |

- The box-pair RMS (the round 3 "1.32-1.38 m") does not fall: it is the box solve's own objective, so the box poses are best on it by construction. Held out for the edge poses, the pairs that name an edge-posed pano usually got closer in run 2 (for example 2.26 → 1.53 m, 2.28 → 1.51 m, 2.19 → 1.40 m), and rose in others. Before any solve, the pairs disagree by 1.82-1.87 m.
- The edge poses move the eye 1-4 m and the heading up to 2.5° from the box pose. The sky edge pins rotation better than translation, so a large move may trade translation against heading. Tightening the bounds to 2 m and the prior to 1 m lowered the held-out NCC in the replay (0.075 → 0.030), so the looser search was kept.
- Most panos stay on the box pose by the held-out measure, so the views mix two pose families.

### Texture, detail, figures (final run)

| Layer | Street View share | Source seam p95 (v3) | Output step p95 / interior | Alignment NCC | Leak share caught by the scan (hidden / seen past / edge) | Enhancement |
|---|---|---|---|---|---|---|
| l2 | 33.6% | 25.8 (32.4) | 13.5 / 14.7 | 0.072 → −0.220 | 1.7% (6425 / 37 / 4228) | 0 of 1 |
| l3b | 30.2% | 31.4 (26.2) | 14.8 / 13.4 | −0.049 → 0.101 | 2.3% (5968 / 1 / 3942) | 11 of 112 |
| l3cf | 69.2% | 22.3 (20.8) | 14.3 / 17.1 | −0.026 → 0.167 | 0.3% (709 / 0 / 1221) | 0 of 38 |
| l4 | 46.7% | 20.8 (23.1) | 11.3 / 11.6 | −0.047 → 0.204 | 2.1% (3928 / 0 / 2377) | 0 of 29 |
| l4f | 26.5% | 26.1 (11.1) | 4.5 / 24.8 | – | 1.1% (19 / 0 / 62) | 0 of 2 |

- Pose feedback still rejected on l3b (RMS 1.45 → 1.41 m; NCC from the poses alone 0.181 → 0.147 in run 1) and l3cf (the alignment's own NCC under 0.35).
- Reprojection gate: run 1 rejected 10 of 22 gated elements, run 2 7 of 23, run 3 13 of 31 (12 more cited tile orthos only). The threshold 0.15 sits in the gap of the live distributions: kept elements have IoU 0.16-0.80; rejected ones are built far from or at another size than what was cited. Examples (run 2): a dentil course cited across the whole frame `[485,0,610,980]` but built as a sliver `[344,403,363,441]` (IoU 0); a high-relief eagle cited at `[636,422,798,754]` built at `[559,272,591,469]` (0.002); the left and right attic festoon panels built over a box ten times the cited one (0.05, 0.01). Real features built in the wrong place are rejected too (the keystone eagle in run 3).
- Figures: committed in runs 1 and 3 (per-figure calls; no truncated JSON). Run 2 degraded on a refused spec, now asked again.
- No new server errors in any run. The browser showed 404s for v3 model URLs left in the persisted chat sessions (files not in this worktree).

### What I saw (`texture_live_v4` against v3)

- **Better:**
  - Front (`tex_front`): the trophy-panel medallions and the spandrel Victories read cleanly and in place; the pale statue ghost on the front left pier is gone (only faint relief behind the figure in `tex_pier_front_left`).
  - The invented back attic roundels and the attic triangle of v3 are not in the build.
  - Inner right pier (`tex_opening`): the tree seen through the arch is no longer painted on it.
- **Still wrong:**
  - Back spandrels (`tex_frieze_back`): worse than v3. The region is a patchwork of offset blocks, some carrying horizontal mouldings that are not there. The back panos are mostly edge-posed while their neighbours stay box-posed, so adjacent regions come from two pose families.
  - Inner right pier: a park fence and a cornice from the background are still painted near its foot; the coffers of the vault appear on its upper part.
  - Front left pier: two rings, the built l4 medallion and the texture's ring, sit offset from each other.
  - The attic inscription is not readable (soft tile texture and stripes).

### Open issues (after round 4)

- Mixed pose families: per-pano choice by a weak held-out measure leaves neighbouring views on different poses, and the seams on the back show it. A joint choice (all panos of a face together), or a joint refinement of all panos by photo consistency through the scan with the edge term as the anchor (`StreetViewCrossViewRefiner`), would be the next step.
- Translation is weakly determined by the silhouette; the edge poses move 1-4 m. The held-out NCC prefers them, but it is low in absolute terms (0.03-0.08).
- Leaks through the opening are reduced, not removed: the remaining ones are on texels the tile mesh itself places where the photo shows the background (the scan's opening is eroded).
- Pose feedback is still rejected on every layer.

### Candidate tool/service ideas

- A `staged_location_set_view` tool (target, heading, elevation, distance) and a capture endpoint that writes the active view to a file: I used `__SB_SET_CAMERA_VIEW__`, `__scratchbox_capture_active_3d_scene` and a localhost receiver.
- A registration overlay endpoint: the mesh edges at the box and the edge pose on each grounding image (what the scratch harness drew), so a reviewer can see each pano's registration.

## Round 5 (branch `joint-registration`, 2026-10-17)

Worktree `.claude/worktrees/joint-registration`, from `origin/main` `0be7689d`. Ports: web 3062, API 3063, tools 3064 (server started from the worktree root with `npm run dev`). Live runs of `Washington Square Arch`, cold for the evidence (registration), vision/detail and texture stages (their caches cleared before each run; the tiles, remesh and fit stages cached): two with the round-4 behaviour (`SCRATCHBOX_STAGED_ROUND4_BASELINE=1`: runs `b1c2e1bb`, `24886740`), five with this round's changes as they were built (`091b3cd6`, `51e4a1d7`, `1a748aa5`, `01296671`, `e6cd6e49`), and four after the camera fix below (`863e1906` and its texture retry `3ae567f6`, `d408f5e9`, and the final run `decf63a4` on the pushed code). Screenshots (of `decf63a4`): `test-results/screenshots/texture_live_v5/` (`clay_*`, `tex_*`, `prov_*`, the same 9 view names as v4, 808 x 943 like v4; gitignored). The views were set with `__SB_SET_CAMERA_VIEW__` around the l3b box (front heading 33°, back 213°); front, back and the friezes match v4's framing, the pier and opening views are close but not identical.

### What changed

1. **Fit metric** (`texture-fit-metric.ts`, in the `TexturePassRecord` as `layers[].fit`, run note `texture_fit.json`). Per layer and per Street View view: the final textured layer is rendered from the view's pose (texel splat, z-buffered, the full tile mesh hides what stands in front), and compared with the photo on texels the view's own pano did not make: structural-edge chamfer both ways (long, strong segments at 640 px; px, lower is better), gradient NCC of the surface, and the layer's own geometry edges against the photo's (clay chamfer). Also on the photo-tier texels alone (`fit.photo`). Live this provenance-masked hold-out turned out to move with the bake (which texels a view's pano made changes with the selection), so a second, true hold-out was added: **leave one pano out** (`fit.loo`): the photo tier is baked again without each pano's views and that pano's views score it. It runs after every layer is textured, within what is left of the stage's 600 s limit.
2. **Joint registration** (`pano-joint-registration.ts`, run note `joint_registration.json`). All panos of the structure are posed together by `StreetViewCrossViewRefiner` (robust Levenberg-Marquardt, two scales 360 / 640 px): the full mesh's sky silhouette, occluding contours and creases against the photo's sky boundary and structural segments (new edge term in the refiner), cross-view photo consistency of patches carried through the scan between every pair of views, priors about the start pose (the edge pose where its search locked onto the scan, else the box pose). Then a per-pano angular warp lattice (16 x 12, membrane + ridge regularised, capped 0.6°). The scan is split into a 3D checkerboard (1.5 m cells): the fit uses the even cells; every candidate (the round-4 per-pano choice, the joint poses, the joint poses with warps) is scored on the odd cells only, by the other panos' photos carried into each view against its own photo (chamfer and gradient NCC, as the texture metric). A candidate replaces the per-pano choice only if it is better there. The detail elements are placed again through the kept poses; the projection reads a photo through its pano's warp when one is kept. The refiner settings (minimum peak 0.4, margin 0.06, priors 0.8 m / 0.3 m / 0.6°) were chosen offline on a recorded live run's held-out cells (scratch replay; chamfer 9.16 -> 8.32 px, NCC 0.082 -> 0.097 against 8.75 / 0.093 with the refiner's defaults and 8.78 / 0.070 without the edge term).
3. **View selection** (`texture-projection.ts`, `texture-seams.ts`): incidence floor cos 0.375 (68°), resolution floor (view GSD at most ~7 texels), and per region the photo-consistency outlier rejection of Waechter et al. 2014 (mean shift of the views' block colours; a view more than 14 ΔE from the mode leaves the region's choice and its weight leaves the blend), then the existing per-chart gains and Poisson blend.
4. **Fitted surface off the scan** (`scan-deviation.ts`): per fitted texel, the point-to-triangle distance to the remeshed scan. More than 8 cm off (live: 40% of l3b, median 31 cm, p95 1 m; 14-19% of l3c / l4) the photos are sampled at the scan's surface under the texel (nearest scan point within 0.6 m) and carried to the fitted texel; texels with no scan within 0.6 m are not projected (tile/clay tier, `fitted_without_scan`). The first version left all off-scan texels to the tile tier: live that removed the spandrel Victories from the front (the viewport shows the fitted layer there, never the scan: a superseded layer is hidden as a whole, `texturedTwins.ts twinEligible`) and lowered the fit, so it was replaced the same day.
5. **Camera model** (coordinator's finding from a parallel experiment, `StreetViewPoseRegistrar.ts groundingFocalPx`): the grounding API's requested fov is the horizontal fov of a 1920 x 1280 frame and every aspect is a centred crop at the same focal length, fx = 960 / tan(fov/2). The grounding cameras took the requested fov as the crop's own: fx 11% short for the 4:3 frames (1707 x 1280), 50% for square ones. Fixed in `castCamera`, `viewCamera`, the edge and joint registrations, the aim and survey fov requests and the native sample size (`frameCamera` stays a plain pinhole: rendered cube faces use it).

### Synthetic checks (all fail without the change)

- `texture-fit-metric.test.ts`: windows facade, three panos; the right texture scores chamfer < 1 px, NCC > 0.9, one shifted 0.4 m > 2 px worse and NCC 0.3 lower; a texture right only on a view's own texels scores badly from that view; leave-one-pano-out with one pano's stated pose 0.4 m off scores > 1 px worse.
- `staged-location-joint-registration.test.ts`: coursing facade, five panos with up to 1 m / 0.8° pose error, scan 0.2 m off at the parapet and 0.15 m at the opening. Held-out chamfer 4.07 -> 2.72 px; true reprojection error of held-out points 4.38 px (per-pano choice) -> 0.96 px (joint).
- `texture-view-selection.test.ts` (outlier view out of the choice and the weights; grazing and coarse views dropped; off-scan texels find the scan under them, texels with no scan near are not projected). `streetview-grounding-intrinsics.test.ts` pins fx = fy = 960 / tan(fov/2) and the principal point at the crop centre for 16:9, 4:3, 1:1, 9:16 and downscaled copies.

### Held-out fit, before and after

Registration, paired on each run's own held-out cells (round-4 per-pano choice -> joint; chamfer px / gradient NCC):

| Run | Per-pano choice | Joint | Kept | Cross-view matches (median residual) |
|---|---|---|---|---|
| `091b3cd6` (first version) | 9.62 / 0.087 | 8.47 / 0.091 | joint | 76 -> 70 (3.2 -> 2.1 px) |
| `1a748aa5` (tuned) | 9.27 / 0.082 | 7.88 / 0.094 | joint | 118 -> 125 (3.7 -> 3.3 px) |
| `01296671` | 9.37 / 0.096 | 8.72 / 0.082 | per-pano (old rule: NCC loss > 0.01) | |
| `e6cd6e49` | 8.91 / 0.093 | 7.95 / 0.115 | joint | 168 -> 179 (3.5 -> 3.1 px) |
| `3ae567f6` (camera fix) | 8.19 / 0.149 | 7.09 / 0.210 | joint | 489 -> 527 (2.2 -> 1.8 px) |
| `d408f5e9` (camera fix) | 8.02 / 0.141 | 7.31 / 0.190 | joint | 478 -> 496 (1.9 -> 1.6 px) |
| `decf63a4` (final) | 8.48 / 0.116 | 7.38 / 0.157 | joint | 385 -> 382 (2.1 -> 1.7 px) |

The warps never improved the held-out score by the margin (0.1 px at best), so none was kept. With the camera fix the cross-view matches quadrupled and their residual fell to 1.6-1.8 px.

Texture, leave one pano out (the four panos with close-ups judge; the close-ups are never used by the registration). Paired on identical inputs (a recorded run's views, offline, before the camera fix), round-4 behaviour -> each change:

| Layer | Round 4 | Joint poses | View selection + off-scan | All three |
|---|---|---|---|---|
| l3b | 8.19 / 0.001 | 8.13 / 0.012 | 8.04 / 0.015 | 7.93 / 0.020 |
| l2 | 8.31 / 0.007 | 8.28 / 0.007 | 8.20 / 0.011 | 7.89 / 0.024 |

Live, leave one pano out after the camera fix (`3ae567f6`): l2 5.49 / 0.267, l3b 4.82 / 0.267, l3c 5.92 / 0.132, l3cf 5.94 / 0.132, l4 5.06 / 0.264; final run `decf63a4`: l2 5.95 / 0.243, l3b 5.51 / 0.229, l3c 5.99 / 0.240 (l3cf, l4, l4f had no time left in the stage's limit). Before the fix, run `e6cd6e49`: l2 7.78 / 0.030, l3b 7.28 / 0.036, l3cf 8.04 / 0.016, l4 6.38 / -0.031. The provenance-masked fit varied as much between two round-4 runs (l3b 7.47 / 0.256 and 7.08 / 0.017) as between rounds; after the fix l3b 6.87 / 0.189, l2 7.88 / 0.143, l4 6.62 / 0.123.

The final run `decf63a4` committed every stage but the photo reading and detail (degraded as in every round: elements outside their slots or rejected by the gate), with no server error; seam p95 l2 19.3 (interior 17.2), l3b 17.9 (16.6), l3c 13.3 (17.4), l4 13.0 (14.4); leak share 0.3% (l2), 0.7% (l3b), 0.7% (l4). Other numbers (`3ae567f6`): output seam p95 l2 15.9 (interior 17.4), l3b 17.2 (13.7), l3c 18.7 (17.5), l4 8.3 (14.2); leak share caught by the scan 0.6% (l2), 1.3% (l3b), 0% (l3c), 1.8% (l4); Street View share l2 29%, l3b 25%, l3c 75%, l4 45%. Timings: joint registration 90-107 s (scoring 15 s of it), scan deviation 1-13 s per layer, fit 1-5 s, leave-one-pano-out 27-134 s per layer.

Detail reprojection gate (median IoU of the built elements against the boxes they were read from): v4 0.19; round-4 behaviour 0.27 and 0.22; joint poses before the camera fix 0.04, 0.09, 0.17 (the run whose joint poses were not kept); after the fix 0.35 (`3ae567f6`), 0.26 (`d408f5e9`) and 0.34 (`decf63a4`, 29 of 36 accepted). The reading itself changes from run to run (25-43 elements), so this is a weak measure of the poses; it was worse with the joint poses before the camera fix and better after it.

### What I saw (`texture_live_v5` against v4)

- **Better:**
  - Back (`tex_frieze_back`): the patchwork of offset blocks is gone; the frieze, the keystone eagle and the spandrel reliefs run continuously, and the attic inscription is readable in part. Front (`tex_frieze_front`): the attic inscription reads ("TO COMMEMORATE THE ONE HUNDREDTH ANNIVERSARY ... WASHINGTON"), the keystone eagle, dentils and frieze wreaths line up across the views.
  - Inner pier (`tex_opening`): the coffers are now on the vault above the impost, not on the pier; no fence or background cornice on the pier. In the replay before the camera fix the coffers stayed on the pier with the joint poses, the full-mesh depth test and the scan sampling all on (that region of the pier is on the scan, 0% off-scan), so the contamination was the camera model, not occlusion.
  - Back pier (`tex_pier_back_left`): coursing and the Greek key band are sharp where v4 was blurred tile texture.
- **Still wrong:**
  - Front-right pier (`3ae567f6`): a bright built ring (l4) sat slightly off the texture's medallion; in the final run the pier medallions read as one ring each.
  - The front spandrel Victories read less clearly than in v4 (darker, some streaks along the courses).
  - A blue sky patch sits on the top of the back attic (a leak onto a texel no view sees well).
  - The statue pedestals still carry some of the park fence.

### Bugs found live and fixed

- Leaving off-scan fitted texels to the tile tier hid carved relief (above, item 4).
- The leave-one-pano-out re-bakes inside each layer's pass starved the other layers' native unwrappers (`island unwrapper timed out after 120000 ms`, run `863e1906`), then, moved to the end of the stage, pushed it past its 600 s limit (`d408f5e9`): it now runs after the layers and only in what is left of the limit.

### Open issues (after round 5)

- The viewport shows a layer as a whole: where the fitted solid departs from the scan the scan's own texture is never shown; per-region layer choice would need the viewport to cut the fitted layer.
- The per-pano warps never helped; with the camera fix the rigid poses already agree to 1.6-1.8 px on the training matches.
- The coordinator's experiment suggests a stronger chain: anchor each pano by a wide view aligned to the tile's sky outline, map the narrow views of the same pano by pure rotation (feature matches between the views of one pano), and other panos by feature matches to a reference pano. The joint registration already shares one rigid pose per pano across its frames; the feature-matched same-pano rotation is not used.
- The provenance-masked fit is a weak comparison across runs; the leave-one-pano-out fit is the one to compare, and it was added late, so round 4 has it only from the offline replay.

### Candidate tool/service ideas

- A replay endpoint for a run's registration and texture inputs (frames, views, meshes), so changes are compared on identical inputs; this round used local dumps and scratch replays for that.

## Photo tier A (branch `photo-tier-a`, 2026-10-17): not pushed

Worktree `.claude/worktrees/photo-tier-a`, from `origin/main` `0be7689d`, merged with round 5 (`c4ec7b8c`). Ports: web 3072, API 3073, tools 3074 (3062-3064 were taken). Screenshots: `test-results/screenshots/texture_live_photoA/` (`clay_*`, `tex_*`, `prov_*`; front, back, four obliques, top, opening, both friezes, and close-ups `close_attic_*`, `close_spandrels_*`, `close_pier_front_a/b`; gitignored). Views set with `__SB_SET_CAMERA_VIEW__` around `[0, 10, 0]` (front at theta pi - 0.7); not the same framing as v5.

**Status: Needs Fix.** Photo tier A runs end to end and wins on its own held-out score, but it makes round 5's leave-one-pano-out fit worse on `l3b`, so it was not pushed to main.

### What was built

- **Camera model.** The first commit is round 5's `793c066f`, cherry-picked (fx = fy = 960 / tan(fov/2) at every crop, principal point at the crop centre). A second commit also changed the run-reading, detail and figure aims. It changed which crops the pipeline requests, which failed `staged-location-orchestrator` and `photo-ornament-real-arch`, so I dropped it. `slot-projection uncertaintyPx` now uses `groundingFocalPx`.
- **`photo-tier-rectify.ts`** sets up the geometry and **`python/photo_tier/face_rectify.py`** does the image work (OpenCV in the project `.venv`, one subprocess per layer):
  - **Grouping and frames.** Planar wall charts are grouped into facades by heading. Each facade gets a frontal camera at 50 px/m, plus the tile mesh's depth culled to a slab of ±3 m around the plane.
  - **Wide-view anchors.** Each pano's wide view is anchored on the tile outline:
    - The outline is the face's own edge: within 1 m of the depth most of the surface has, and not on the slab cut.
    - A sample pushed out of the photo costs the chamfer cap.
    - A two-sided Lab term separates the outline from course joints that run parallel to it.
    - The panos' anchors vote through SIFT homographies between their wide views (agreement within 10 px).
  - **View chains.** Narrow views map to their pano's wide view by a rotation homography. Other panos map to the reference pano by SIFT, using features on the facade only. Every placement becomes a pose correction, so each chart gets its own plane homography.
  - **Rectification plane.** The plane is moved to the tile's median depth over the chart.
  - **Fusion.** Gated co-registration, a gradient agreement check, Lab normalisation, and a per-pixel median that votes per pano. A pano's views share its eye, so an occluder appears in all of them.
  - **Relief.** More than 0.3 m of relief is left to the rungs below with the degradation `non-planar region: photo tier needs better geometry`.
  - **Labels.** Texels are labelled `street-view-rectified` / `photo-inferred` with pano ids and capture dates. Rung 0 means at least two panos agree; rung 1 means one pano.
- **Wiring.** The survey and ring whole-face views feed the tier, which is how it gets its wide views. The tier also runs inside round 5's leave-one-pano-out bake: the judged texture is the projection with the tier's texels over it, both made without the judging pano.
- **Score and switches.**
  - The offline experiment's held-out score is in `TextureLayerBundle.photoTier.heldOut`, for three methods: tile, previous ladder, and photo tier A without one pano.
  - Diagnostic switches: `SCRATCHBOX_PHOTO_TIER_OFF=1`, `SCRATCHBOX_PHOTO_TIER_POSE_ONLY=1` and `SCRATCHBOX_PHOTO_TIER_KEEP=<dir>`.

### Synthetic checks (`staged-texture-photo-tier.test.ts`, all new)

The test scene is a 12 x 9 m coursed wall, ray cast through the 960/tan camera, with registered poses 0.3-0.6° and up to 0.5 m off. It has a statue 1.2 m proud of the wall, a van 8 m in front, and an old pano whose stones differ.

- The anchors improve on the pose, and a course-locked anchor is outvoted.
- Narrow views map to the wide view at 0.15 px.
- The rectified texels sit on the true texture with zero shift at a quarter-texel search, mean error about 9-12 grey levels.
- Van texels are under 1%.
- The statue is left alone, with a measured deviation of 1.2 m.
- Provenance and the fallbacks behave as designed: no outline, no worker, no planar face, an unplaced old pano.
- The ladder integration has its own test.

### Live (Washington Square Arch)

Only `l3b` (the scan-fitted rebuild) has planar wall charts. `l2`, `l3c`, `l3cf`, `l4` and `l4f` report `photo_tier_no_planar_face`. Each retry re-runs registration, and the untouched `l2` moved from 5.4 to 8.4 px between runs, so `l2` is used as the control.

| Run (tier) | l3b LOO chamfer / NCC | l2 LOO (control) | l3b − l2 chamfer |
|---|---|---|---|
| round 5 `decf63a4` (no tier) | 5.51 / 0.229 | 5.95 / 0.243 | −0.44 |
| `f12c3a22`, tier off | 5.47 / 0.192 | 6.48 / 0.118 | −1.01 |
| `a9a57257`, outline-anchored | 8.79 / 0.048 | 5.63 / 0.179 | +3.16 |
| `78f4a57e`, pose-only | 8.35 / 0.099 | 8.41 / 0.098 | −0.06 |
| `cb9a542f`, outline-anchored + tile-surface plane | no time left for LOO | 5.41 / 0.309 | – |

On its own held-out score (the offline `score.py` on the faces' frontal frames, one pano held out), the final run `cb9a542f` scores as follows on 239k common pixels:

| Method | Geometry-edge chamfer (px) | Held-out gradient NCC | Held-out chamfer (px) | Invented-edge share | Laplacian variance | ΔE00 to palette |
|---|---|---|---|---|---|---|
| Photo tier A | 2.0 | 0.187 | 9.2 | 0.34 | 2157 | 7.1 |
| Previous ladder | 8.4 | 0.028 | 8.0 | 0.37 | 1807 | 7.9 |
| Tile | 40 | 0.005 | 8.0 | 0 | 54 | 8.5 |

On `l3b` the tier writes 34% of the texels (8% where two panos agree) from 14 panos across 43 charts. 16% of the fitted-face texels are left as non-planar (p90 2.5 m). It takes 72 s per layer, or 18 s with a warm worker cache. The tier's own time pushed `l3b`'s leave-one-pano-out out of the stage limit in the last run.

### What I saw (`texture_live_photoA`)

- **Better:**
  - Both attic inscriptions read in the close-ups. On the front: "TO COMMEMORATE THE ONE HUNDREDTH ANNIVERSARY ... WASHINGTON". On the back: "LET US RAISE A STANDARD TO WHICH THE WISE AND THE HONEST CAN REPAIR ... WASHINGTON".
  - The front frieze, keystone eagle and spandrel Victories are sharp and continuous.
- **Worse:**
  - The front piers carry a tree and sky (`close_pier_front_a`), and the back piers are washed pale. These are single-pano texels (rung 1), with no second pano to vote the occluder out.
  - A pigeon is painted on the back frieze, and sky patches sit on the back attic.
  - The fused chart images show sky inside the pier and attic regions. Either the anchors disagree with the registered poses by 10-30 cm, or the fitted charts extend past the arch. The tier cannot tell which.

### Open issues

- **Anchor against poses.** The outline anchor and round 5's registered poses disagree by 10-30 cm. The leave-one-pano-out fit judges from the registered poses, so a texture moved toward the tile outline scores worse even if the outline is right. Pose-only placement is neutral against the control. Before the tier can help, it needs a joint decision of what is true: an outline term inside the joint registration rather than a separate anchor.
- **Few wide views.** Most panos have no usable wide view, so consensus rarely forms (0 agreeing pairs on 3 of 5 facades). Many narrow views stay unplaced.
- **Single-pano texels.** These have no occluder rejection. The tier should not write rung-1 texels over the projection's multi-view texels.
- **Time.** 72 s per layer squeezes round 5's leave-one-pano-out out of the 600 s stage limit.
- **De-lighting.** The tier does not de-light (the projection does), so its texels differ in exposure from their neighbours.

## Round 6 (branch `photo-tier-a`, 2026-10-17): pushed with photo tier A off by default

Worktree `.claude/worktrees/photo-tier-a` (photo tier A merged with round 5, `c4ec7b8c`). Ports: web 3072, API 3073, tools 3074 (`npm --prefix <worktree> run dev`, `secrets.json` symlinked for the runs and removed after). Three cold runs of `Washington Square Arch` (the vision/detail and texture caches cleared before each; the evidence and its registration always run again): `98e8d2f8` (tier on), `71cddb48` (tier off, `SCRATCHBOX_PHOTO_TIER_OFF=1`), `41d7bc30` (tier on). Screenshots (of `98e8d2f8`): `test-results/screenshots/texture_live_v6/` (`clay_*`, `tex_*`, `prov_*`, the 16 view names of photo tier A, 808 x 943; gitignored), set with `__SB_SET_CAMERA_VIEW__` around the l3b box centre `[-1.25, 10.8, -2.4]`, front heading 33°.

**Status: Verified with the tier off; the tier Needs Fix.** Every change works live, no stage or server error, the stage stays inside its 600 s limit (549 s and 556 s) with the tier at 16 s per layer. With the tier on the leave-one-pano-out fit of `l3b` is worse than round 5's (6.37 and 6.14 px against 5.51); with it off and the outline term on (`71cddb48`) it is 5.10 / 0.233 against round 5's 5.51 / 0.229 (not worse, within the 1.6 px control noise). So the round was pushed with **photo tier A opt-in, off by default**: `SCRATCHBOX_PHOTO_TIER=1` turns it on for a server (the texture pass option `photoTier: true` or options per call; the pass version is `texture-pass/10`, `+tier` when on). The outline term, the merge rule, the de-light and exposure match, the caching, the leave-one-pano-out sampling labels, the contract schema and the MediaPipe model ship either way. (`SCRATCHBOX_PHOTO_TIER_OFF` is gone.)

### What changed

1. **Face outline inside the joint registration** (`pano-joint-registration.ts`, `StreetViewCrossViewRefiner.ts`). The tile mesh within 1.5 m of the fitted faces (`faceSlabMesh`, so trees and statues in front of a face are left out) gives each wide view the outline of the structure's own faces (`faceOutlineSamples`: surface next to no surface or a far step, and only where the full mesh shows that surface). It is held to the photo's strong colour-contrast edges (`colourContrastEdges`: per-channel Sobel, non-maximum suppression, top 15 %) with the weight of the sky and edge terms (40 equivalent matches), against the cross-view photo consistency and the priors. The held-out fit reports it on the odd cells (`outlinePx`). The photo tier's separate anchor is gone: every view is placed by its registered pose, so the projection and the tier read the photos through one pose set (`SCRATCHBOX_JOINT_OUTLINE=0` turns the term off).
2. **Single-pano texels** (`face_rectify.py`, `photo-tier-rectify.ts mergePhotoTier`). Texels at least two panos agree on (rung 0) replace whatever is below; single-pano texels (rung 1) only fill what the projection does not have (what would fall to the tile) and never replace its single- or multi-view texels. A single-pano pixel must look like the face: per-pixel median over its pano's views, not sky (b* < -8, chroma > 8) or vegetation (a* < -6) by colour, and within 15 ΔE76 of the tile's colour at 0.4 m after the chart's offset; rejected pixels go with a 15 cm margin.
3. **De-light and exposure** (`photo-tier-rectify.ts delightAndMatch`). The tier's texels are de-lit with the shared `delightLinearPlane` (the projection's lift cap) and each chart's exposure is matched to the ladder below by `solveRelativeGains` (ladder as one view, each chart as another; tile texels weigh 0.3; capped at 0.4 in log).
4. **Time.** The geometry (chart depths, regions, tile photos) is set up once per layer, the worker caches each view's warp per (photo, chart frame, homography) and each co-registration, and charts run in 4 threads. The leave-one-pano-out fit runs on the tier's layers first and says `sampled` (with `panosTotal`) when it judged fewer panos than have views.
5. MediaPipe `assets/models/pose_landmarker_full.task` (float16, 9.4 MB, Apache-2.0, from `storage.googleapis.com/mediapipe-models`), loaded and run with mediapipe 1.1.1 in `.venv`; committed (the gitignore keeps the rest of `assets/models/` out).

### Synthetic checks (all fail without the change)

- `staged-location-joint-registration.test.ts`: the slab mesh keeps the facade and drops a tree 2.5 m in front and a building behind; outline samples never lie where the tree hides the face (> 95 % on the true outline). With a tree in the scan the photos do not show: true held-out reprojection error 11.4 px (start), 6.0 px (joint without the term), 1.3 px (with it).
- `staged-texture-photo-tier.test.ts` (13 tests): placement by registered pose; texels on the true texture within one texel; the van dropped; the statue left; foliage, sky and pale patches seen by one pano are not written (< 2 %), the rest of the wall is (> 60 %); photos 0.72 x under the ladder come out within 6 % of its mean luminance; the merge rule texel by texel; a cached re-run 1.6 s against 3.2 s cold with identical texels; an old pano with other stones outvoted (mean change < 4 grey levels).

### Live

Joint registration, held-out cells (chamfer px / gradient NCC / face outline px), per-pano choice -> joint, kept every time:

| Run | Per-pano choice | Joint | Total (s) |
|---|---|---|---|
| photo tier A `cb9a542f` (no outline term) | 7.93 / 0.111 / – | 7.66 / 0.150 / – | 99.7 |
| `98e8d2f8` | 8.27 / 0.127 / 3.39 | 7.36 / 0.199 / 3.02 | 104.5 |
| `71cddb48` | 8.18 / 0.107 / 3.42 | 7.36 / 0.166 / 2.90 | 104.4 |
| `41d7bc30` | 8.21 / 0.112 / 3.48 | 7.30 / 0.187 / 2.94 | ~104 |

Leave one pano out (chamfer px / gradient NCC; l2 is the control, untouched by the tier):

| Run | l3b | l2 (control) | l3b − l2 | others |
|---|---|---|---|---|
| round 5 `decf63a4` | 5.51 / 0.229 | 5.95 / 0.243 | −0.44 | l3c 5.99 / 0.240 |
| `98e8d2f8` tier on | 6.37 / 0.197 | 7.12 / 0.068 | −0.75 | l3cf 6.53 / 0.051 (3 of 4, sampled), l4 6.85 / 0.141 (2 of 4, sampled) |
| `71cddb48` tier off | 5.10 / 0.233 | 5.51 / 0.271 | −0.41 | l3cf 6.10 / 0.164 (sampled), l4 5.75 / 0.297 (sampled) |
| `41d7bc30` tier on | 6.14 / 0.277 | 5.96 / 0.169 | +0.18 | l3c 5.42 / 0.210 (3 of 4, sampled) |

The l2 control moved 1.6 px between runs, so a single run cannot separate the tier from the registration. Relative to the control, the tier-on runs give −0.75 and +0.18 (mean −0.29), the tier-off run −0.41 and round 5 −0.44: no gain from the tier. In absolute terms the tier-on l3b (6.37, 6.14) is worse than round 5 (5.51); the tier-off run with the outline term is better (5.10 / 0.233) but so is its control (5.51 against 5.95), so that is within the noise too. Which layers exist also changes between runs (l3c in `41d7bc30` only).

The tier on l3b (`41d7bc30`; `98e8d2f8` within 1 %): 26 % of texels written, 22.6 % after the merge (111,680 rung 0, 47,098 rung 1 filling tile texels, 21,530 rung 1 left to the projection); single-pano pixels 174,385, of which 100,873 rejected (52,034 sky, 3,520 vegetation, 13,985 off the tile, the rest margin); de-lit 180,308 texels (mean lift kept 0.74); exposure matched on 48 charts, mean |log gain| 0.30, several at the 0.4 cap; non-planar 22 % (p90 2.7 m). Its own held-out score (score.py, 248k common pixels): geometry-edge chamfer 2.0 px (previous ladder 7.4, tile 40), held-out gradient NCC 0.204 (0.080, 0.067), held-out chamfer 7.8 px (5.0, 5.6), invented-edge share 0.30 (0.23, 0), palette ΔE00 5.2 (6.7, 7.2).

Timings: tier 15.6-15.9 s per layer (setup 1.4 s, worker 14 s in 4 threads; photo tier A was 72 s cold); a leave-one-pano-out re-bake of l3b with the tier 22-25 s per pano (all 4 judged, 89-93 s); texture stage 549 s and 556 s with the tier, l3cf and l4 sampled for lack of time left.

### What I saw (`texture_live_v6` against v5 and photo tier A)

- **Better:** the front piers no longer carry a tree or sky (photo tier A's rung-1 texels; the occluder check and the merge rule keep them out). The back attic inscription reads ("...AND THE HONEST CAN REPAIR. THE EVENT IS IN THE HAND OF GOD ... WASHINGTON"); the front frieze, keystone eagle and medallions are sharp. The sky strip on the back attic top is gone.
- **Still wrong:** the back frieze around the keystone eagle is a patchwork of offset blocks (v5 had it continuous); which source each block comes from was not traced. The pigeon on the back frieze is still there; v5 had it too, so it is not the tier's. The back piers are washed pale in all three rounds. Close to the front piers the statues sit in blocky texel patches.

### Bugs found and fixed

- The live result failed `validateContract('StagedLocationResult')` with the new record fields (orchestrator tests): schema added.
- `staged-e2e-integration` "warm" fails on this branch only by the order of the layer labels (`l4:photo-inferred` committed before `l3cf` on the warm run); the set is the same. Not investigated further.

### Open issues

- The leave-one-pano-out fit is dominated by registration noise (the control moves 1.6 px); comparing the tier needs the same registration in both arms: the replay endpoint below, or the tier switched off and on inside one run's leave-one-pano-out.
- The tier's own held-out chamfer (7.8 px) is worse than the ladder's (5.0) while its NCC and geometry-edge chamfer are better: its edges are sharper but some (30 %) are not in any photo. The rung-0 fusion of panos of different dates and exposures (gains at the 0.4 cap) is the likely cause.
- 58 % of single-pano pixels are rejected, most as sky: the fitted charts extend past the arch's silhouette in the photos (the photo tier A finding), now rejected rather than painted.

### Candidate tool/service ideas

- A replay endpoint for a run's registration and texture inputs, so the tier can be judged with and without on identical poses (this round needed three cold runs and still could not separate it).

## Round 8: the texture stage off the main thread (2026-10-18)

Worktree `.claude/worktrees/texture-worker` from `origin/main` `5595a53f`. Ports: web 3062, API 3063, tools 3064 (server started from the worktree root with `npm run dev`, `secrets.json` symlinked for the runs and removed after). Runs of `Washington Square Arch`, cold for the survey, evidence (Street View), vision/detail, figures and texture stages (their caches cleared before each run; tiles, remesh and fit cached): `3f779f28` (workers, the pushed code), `1a81d2b6` and `6d84931a` (workers, with a temporary block tracer and CPU profile), `f7bd860a` (`SCRATCHBOX_TEXTURE_WORKERS=0`, the main-thread path, on `6d84931a`'s cached evidence; the chat's model then called the tool again, `bf241176`), `1ac2b311` (workers, the pushed code). Screenshots of `1ac2b311`: `test-results/screenshots/texture_worker/` (`live_tex_front`, `live_tex_back`, `live_tex_frieze_back`, `live_tex_attic_back_close`; gitignored), views set with `__SB_SET_CAMERA_VIEW__` around `[-1.25, 10.8, -2.4]`.

**Status: Verified.** The texture stage's CPU work runs in worker threads; the main thread's event-loop delay over the stage is p99 12 ms (the histogram's 10 ms resolution included) with workers against 76 ms with the main-thread path, and the longest block is 0.2-0.5 s (other stages, below) against 56.7 s. No vision call timed out in any worker run.

- `TextureWorkerPool` (`texture-worker-pool.ts`, thread entry `texture-worker.ts`): at most N jobs computing (default min(4, cpus - 1), `SCRATCHBOX_TEXTURE_WORKERS=<n>`; `=0` keeps the main-thread path). The shared sources (views decoded, the tile surface with its BVH, scan and context meshes; `texture-sources.ts`) are prepared in a thread and kept in SharedArrayBuffers; a layer's clay and twin are transferred. The model enhancement calls and progress come back by message. The stage's AbortSignal asks the thread to stop (the native unwrapper is killed on the signal) and terminates it after 1 s; a dead thread rejects with `TextureWorkerCrashError`. A layer's leave-one-pano-out job stays on its thread until it runs or the stage closes the pool.
- Vision call limits (`call-timer.ts`): a limit that fires late because the thread was blocked is extended by how late it fired (at most one limit in all), so a reply that already arrived is read before the call is cut; the face survey's limit starts when the request is sent.
- The stage records `eventLoopMeanMs`/`P50`/`P99`/`MaxMs` and `textureWorkers` in its breakdown.

| run | path | vision ended | textures ended | texture stage | event loop p99 / max (texture stage) | l2 fit.loo |
|---|---|---|---|---|---|---|
| last round (cold) | main thread | 357 s (2 reading batches timed out) | 713 s | | | 5.03-5.84 px (control range) |
| `3f779f28` | workers | 211 s | 527 s | 353 s | 12.1 / 306 ms | 5.94 px |
| `1a81d2b6` | workers | 255 s | 532 s | 346 s | 12.4 / 13 573 ms (see below) | 7.41 px |
| `6d84931a` | workers | 213 s | 476 s | 320 s | 11.9 / 228 ms | 6.05 px |
| `f7bd860a` | main thread | 270 s | 373 s | 277 s | 76.4 / 56 707 ms | 6.05 px |
| `1ac2b311` | workers | 240 s | 516 s | 342 s | 12.1 / 529 ms | 6.07 px |

- The main-thread run `f7bd860a` reused `6d84931a`'s evidence and gave the same l2 fit (6.609 px) and leave-one-pano-out fit (6.053 px, NCC 0.154) as the worker run; `l4f`'s twin is bit-identical between the two (GLB binary chunk, JSON without the clock fields). `l2`'s albedo differs in 1 540 of 4.2 M texels in one island (max 19 levels; confidence plane identical): that run committed a photo correction the worker run did not, so the inputs were not the same; the layers with an image-model enhancement differ by the model's answers. Bit-identity on the same inputs is proven by `staged-texture-worker.test.ts`.
- l2's leave-one-pano-out fit is 5.94-6.07 px in four of the five runs (7.41 px in `1a81d2b6`), above the last round's 5.03-5.84 px. The main-thread path gives the same 6.05 px on the same evidence, so the shift comes from the evidence and registration of these runs, not from where the pass runs.
- Main-thread blocks left during the texture stage (CPU profile of `6d84931a`): the vision stage's slot cover (`fitted-solid.ts` crossings via `computeSlotOffer`, ~0.5 s), `downscaleEvidence` (JS JPEG decode/encode and `downscaleRgba`, ~0.5 s), `detail-reprojection.ts` `renderedBox` (~0.2 s) and the project-artifact store's saves (`serializeProjectGraph`, 0.1-0.14 s each). In `1a81d2b6` one 13.6 s block fell inside the vision stage (the tracer's last mark was a texture progress message; nothing of the texture stage was on the main thread then). None of these is texture work.
- Per layer, the UV step is 0.1-0.7 s in a thread (it read 34-53 s on the main-thread path, where a layer's wall clock included the other layers' CPU).
- Visible in the screenshots (the pass itself is unchanged): the front is well covered; on the back a sky-blue wedge on the right spandrel, a dark object (branch or bird in a photo) on the right of the frieze, a pale square at the keystone, and the attic's right half smeared.

Tests: `staged-texture-worker.test.ts` (bit-identical twin, planes, report and leave-one-pano-out job through the pool with the enhancement; sources prepared in a thread equal to inline; a 20 ms timer never more than 100 ms late while a 2048-texel layer bakes in a thread, 3.6 s late inline; a stop rejects with the signal's reason and the thread exits; a dying thread rejects with `TextureWorkerCrashError`), `staged-call-timer.test.ts`. `texture-uv-atlas.test.ts`'s real-arch case (skipped unless the gitignored scan caches exist, which the live runs created) finds 1 gutter hole on this data with `origin/main`'s `texture-uv.ts` too.

### Candidate Tool/Service Ideas

- Move the vision stage's slot cover and evidence downscaling (JS JPEG codec) to a worker thread too: they are the largest main-thread blocks left.
- A run replay for the texture stage from a run's recorded inputs, so the main-thread and worker paths (or two rounds) can be compared on identical inputs live.

## Round 9: the l2 fit "regression", bisected on replayed evidence; back-side artifacts; main-thread blocks (2026-10-18)

Worktree `.claude/worktrees/fit-regression` from `origin/main` `97987c35`; bisect worktrees `fr-df49d8ef`, `fr-72870107`, `fr-97987c35` (removed after). Ports: web 3082, API 3083, tools 3084 (server started from the worktree root with `npm run dev`, `secrets.json` symlinked for the runs and removed after). Screenshots: `test-results/screenshots/fit_regression/` (`run1_tex_back`, `run2_tex_{front,back,frieze_back,attic_back_close,spandrels_back}`, `run2_prov_{front,back,frieze_back}`, `run3_tex_*`; gitignored), views set with `__SB_SET_CAMERA_VIEW__` around `[-1.25, 10.8, -2.4]` (theta = 180° − heading) and written with `__scratchbox_capture_active_3d_scene` to a localhost receiver.

**Status: Verified, with the l2 shift explained as evidence and geometry variability, not a code regression.** The back-side fixes remove the sky texels and the stretched tile texels; the wedge and the keystone square remain as geometry (pass-through scan pieces), see below.

### Replay harness (identical evidence through different commits)

A scratch harness (not committed) ran `runStagedLocation` headless at a given commit with the app's own dependencies, wrapping three of them: the Street View grounding service (each request answered from a recording, live on a miss), the vision client (each request keyed by its normalised content, images by their pixels without the APP segments; live on a miss and recorded), and the tree strip (optionally answering with another commit's devegetated tile). Survey replies were bridged between the old single-call survey and the per-face survey by the image captions (boxes are 0..1000, size-independent). Tiles and geocode came from round 8's cache; texture enhancement off in every arm. The same commit replayed twice gave bit-identical numbers (run `52517386` = `4e198670` = `5a30df8d`).

### Bisect (same survey replies, same Street View recordings)

| Code | Tree strip (geometry) | Registration held-out, per-pano -> joint (px / NCC) | Images in common with `97987c35` | l2 LOO | l3b LOO | l3cf LOO |
|---|---|---|---|---|---|---|
| `97987c35` | its own (`0b6ef750` crown merge: 6,450 tris removed, remesh 2,106 tris) | 8.137 / 0.126 -> 7.117 / 0.196 | 54 of 54 | 5.301 / 0.216 | 5.058 / 0.234 | 4.443 / 0.153 |
| `df49d8ef` (before the scheduling commits) | `97987c35`'s | 8.137 / 0.126 -> 7.117 / 0.196 | 54 of 54 | 5.301 / 0.216 | 5.058 / 0.234 | 4.443 / 0.153 |
| `df49d8ef` | its own (old strip: 2,955 tris removed, remesh 2,203 tris) | 7.696 / 0.139 -> 7.24 / 0.208 | 22 of 54 | 6.99 / 0.006 | 7.61 / 0.005 | 8.86 (2 of 4) |
| `97987c35` | `df49d8ef`'s | 7.696 / 0.139 -> 7.24 / 0.208 | (same as the row above) | 6.99 / 0.006 | 7.61 / 0.005 | 8.42 (3 of 4) |

- Every commit from `df49d8ef` to `97987c35` (the scheduling commits `59a15531`, `c6580650`, `2326971e`, `72870107`, the merge `5595a53f`, the worker change) gives the same fit, to the digit, on the same evidence and geometry. None of them moves the fit.
- The geometry does. `0b6ef750` (tile vegetation: one crown for a two-bump crown top, cut-at-boundary crowns removed) changes the devegetated tile, so the remesh (`l2`) changes, mostly in the ground apron (old-only 470 / new-only 381 triangle centroids more than 0.3 m from the other, all but 8 below y = 2 m). The fit changes with it, so the box registration of the *same* 395 matched element pairs uses 172 pairs (after RMS 1.14 m) instead of 337 (1.40 m), the close-ups are aimed differently (32 of 54 images differ), and the leave-one-pano-out fit moves by 1.7 px. On this sample the new geometry is the better one (5.30 against 6.99).
- So `l2` is not a control: its geometry and its close-ups change with the run. The round-8 live spread (5.94-7.41) and this round's live runs (6.67, 5.06, 6.09, 5.63) are evidence variability: the survey and matching readings change from run to run, which re-aims the close-ups that both texture and judge the layer.

### Back-side artifacts (run `1ac2b311`, traced through the confidence planes)

A point-splat render of each layer twin from the back, coloured by rung and by provenance entry (scratch tool), located each artifact:

| Artifact | Layer, rung | Cause | Fix |
|---|---|---|---|
| Sky-blue wedge, right spandrel | `l3cf` node `x21` (as-scanned pass-through piece, one 6.2 m² triangle), rung 1 from pano `5bmwoz` | one pano's texels show the sky past the arch's edge; nothing outvotes one pano | single-pano witness (below) leaves them to the tile; the wedge itself is scan geometry and stays (grey now) |
| Pale square at the keystone | `l3cf` node `x18`, rung **0** but from two crops of the same pano | rung 0 counted views, not panos | rung 0 now needs two distinct panos; witness |
| Dark object, right of the frieze | `l3b`, rung 1 from `5bmwoz` | one pano's texels | witness; in the live runs after the fix the spot is tile-rung texels and a dark mark remains: the tile photo has it too, so it is probably on the arch |
| Smeared right half of the attic | `l3b`, rung 2 (tile transfer) | fitted texels 0.3-1.5 m off the tile (median 0.32 m) took the nearest tile point within 2.08 m (2 x the Street View residual): past the tile's edge that is the edge, stretched across the band | the tile sampler takes only points in front of or behind a texel (sideways at most 0.15 m + 0.3 x the normal offset) |

Single-pano witness (`single-pano-witness.ts`): texels only one pano saw are compared with the tile photo at the same texel (both low-passed over 0.2 m, the tile exposure-matched over the layer); past the layer's own disagreement level (median + 4 robust sigmas, within 20-30 CIE76, with hysteresis) they are left to the tile rung, in the leave-one-pano-out re-bakes too, and counted in a `single_pano_contradicted` degradation. A flat 20 dropped 79 % of `l3cf`'s single-pano texels (its leave-one-pano-out 4.44 -> 5.74 px), hence the adaptive limit.

On the same replayed evidence, before -> after the fixes: l2 5.30 -> 5.16 px (NCC 0.216 -> 0.237), l3b 5.06 -> 5.03, l3cf 4.44 -> 4.46; the registration is unchanged to the digit.

### Main-thread blocks

CPU profiles of replayed runs (12 s vision reply latency, so the stages overlap as live) and a whole-run block tracer:

| Block | Before | After |
|---|---|---|
| Evidence: frame decode, edge search, cross-view matching (the main thread waited on the pool with `Atomics.wait`), held-out scoring | 107 s in one block | in a worker thread (`pano-registration-run.ts`), same poses |
| Evidence: box registration of the matched pairs (`registerPanos` ray casts) | 7.1 s | in the registration thread |
| Vision: slot cover (`computeSlotOffer` crossings) | ~0.5 s live, 153 ms here | time-sliced per slot (`time-slice.ts`, 8 ms slices) |
| Vision: `downscaleEvidence` / survey `capImageSide` (YCC conversion, area average, encode in JS) | 614 ms active for 8 images | one ffmpeg process per image (Y'CbCr planes), 14 ms active |
| Detail: reprojection gate renders | ~0.2 s | time-sliced per render |

The round-8 13.6 s block was not reproduced in the replays; the 107 s registration block was the largest block in every replayed profile and is the likely source. Live after the fixes (whole run, `main_thread.json`): run `49a4a860` p99 12.6 ms, max 1.24 s (evidence, while the narrow crops are fetched); run `8c465131` max 5.2 s in one block while the detail and texture stages ran (not reproduced in run `9f3f817f`, max 1.5 s, evidence; its CPU profile was lost when the server was stopped); texture stage p99 12.0-12.6 ms.

Also: the cross-view match and edge render pools loaded their `.ts` workers through ts-node with the working directory's tsconfig (the repo root's gives no target, so ES5: a worker summing a Set returned 0). All three pools now share `worker-ts-register.ts` (ES2022, project tsconfig skipped).

### Live (cold for the survey, evidence, vision/detail, figures and texture stages)

| Run | Total | Textures | l2 LOO | l3b | l3cf | l4 | Joint registration held-out (chosen) | Main thread p99 / max |
|---|---|---|---|---|---|---|---|---|
| `c999d28a` | 9 min 9 s | 6 min 16 s | 6.67 / 0.180 | 6.54 / 0.109 | 6.29 | 7.59 | 7.02 / 0.195 (joint) | (tracer not yet in) |
| `49a4a860` | 8 min 20 s | 5 min 6 s | 5.06 / 0.297 | 5.82 / 0.091 | 6.71 | 3.26 | 7.34 / 0.164 (joint+warp) | 12.6 ms / 1.24 s |
| `18683533` | – | – | – | – | – | – | – | server out of memory (below) |
| `8c465131` | ~9 min | 6 min 9 s | 6.09 / 0.136 | 5.96 / 0.155 | 5.11 | 5.98 (3 of 4) | 6.62 / 0.231 (joint) | 12.6 ms / 5.2 s |
| `9f3f817f` | ~8 min | 4 min 32 s | 5.63 / 0.248 | 5.81 / 0.183 | 5.42 | 4.44 | 7.24 / 0.170 (joint+warp) | 12.0 ms / 1.5 s |

`18683533`: the server's main isolate ran out of heap (4 GB, `Ineffective mark-compacts near heap limit`) three minutes into the second build in one server process. The orchestrator itself retains nothing between runs (replayed three builds in one process on `97987c35` and on this branch: heap after GC 70 -> 71 -> 72 MB and 69 -> 70 -> 70 MB; peak heap during one build 311 MB and 347 MB), so the growth is in the server around it (chat payloads of 0.7 MB per tool result, scene artifacts); not traced further. Each later run used a fresh server.

### What I saw (`fit_regression` against `texture_worker`)

- **Better:** the sky-blue wedge on the right spandrel is grey (tile texels on the pass-through piece), the keystone square is no longer pale, and the back attic is no longer streaked (run 3 reads the whole inscription across the attic).
- **Still wrong:** the wedge and the keystone square remain visible as shapes: they are as-scanned pass-through pieces of `l3cf` drawn over `l3b` (geometry, not texture). A dark mark stays right of the frieze in every run; the tile photo has it too. The left spandrel shows a lighter rectangle in run 2 (an `l3cf` piece with its own exposure).

### Candidate tool/service ideas

- Commit the replay harness as a dev tool (`scripts/staged_replay.ts`: record/replay of Street View and vision replies, geometry swap) so later rounds are compared on identical evidence.
- A per-layer exposure tie between overlapping layers (`l3cf` pieces over `l3b`), or drop pass-through pieces that lie within a few centimetres of a fitted face.
- Find the server-side heap growth across staged builds (run two builds in one server with a heap snapshot after each).

## Round 10: three research findings measured on replayed evidence (branch `texture-research`, 2026-10-18)

Source: the repo research notes (group A: frequency-split compositing, after a ratio-image relight in an unlicensed repo; group C1: footprint-aware sampling and band-limited view weights after mip-NeRF/BungeeNeRF, soft visibility after NeuRay's mixture-of-logistics). Everything was written clean-room from the public maths; no code was copied.

**Status: one of the three adopted (footprint sampling). The frequency split, the band-limited weights and soft visibility were implemented, measured and not kept.**

### How it was measured

- Evidence: `scripts/dev/staged-replay.ts` in strict mode (no billed calls) on the round-9 recordings (Washington Square Arch: 54 grounding images, 47 image-model answers for the enhancement). The tiles, remesh, fit, survey, vision and figure stages came from the stage cache, and only the texture stage was cleared before each arm. So every arm textured the same geometry from the same views. The baseline (`d89ed83a`) was replayed three times, with the texture stage both on and off the worker threads, and gave the same numbers to the digit each time: l2 5.164 / 0.237, l3b 5.033 / 0.228, l3cf 4.46 / 0.069, l4 5.555 / 0.065 (3 of 4 panos).
- Held-out score: `fit.loo` per layer (leave-one-pano-out chamfer px / gradient NCC; lower chamfer and higher NCC are better). Offline A/Bs used dumps of each layer's bake inputs (atlas, views, depth maps) and ran projection-only leave-one-pano-out bakes on them. Those offline runs had no tile reference and no pose refinement, so the full replay is the verdict.
- Aliasing metric: for each view, a single-view bake compared with a dense box reference that the harness computed itself (a 10 x 10 grid of exact pinhole projections over the texel square, bilinear in linear light). The value is the RMS difference in sRGB levels.
- Enhancement accept rate: the 47 recorded model answers replayed through `enhanceTransferredAtlas` with the gate unchanged (`DEFAULT_ENHANCE_GATE`: Sobel NCC 0.95, new edges 5 % beyond 3 px, low-band SSIM 0.95, low-band dE 3, sharpness 1.05). With the split off, the replay reproduced the live decisions exactly (3 of 47 accepted).
- Screenshots (gitignored): `test-results/screenshots/texture_research/`. Each arm's layer twins (l3b, l3cf, l4, l4f) were rendered unlit in three.js from five fixed cameras: front, back, back attic close, back frieze, and a front spandrel close-up (the spandrels come from the close-up crops). The prefixes are `base_`, `footprint_`, `soft_doubt_` and `soft_nodoubt_`; side-by-side sheets are `cmp_*.png`.

### 1. Frequency-split compositing of the enhancement answers (not kept)

`out = L(orig) + (cand - L(cand))`, a mask-normalised Gaussian low pass applied before the gate. Accept rate by low-band sigma, with the same 47 answers and the same thresholds:

| Split sigma | Accepted | Rejected: edges moved / new structure / layout / no gain |
|---|---|---|
| off (live) | 3 | 41 / 3 / 0 / 0 |
| 1 px | 16 | 26 / 3 / 2 / 0 |
| 2 px | 7 | 35 / 4 / 1 / 0 |
| max(2 px, 2 % of the crop's short side) | 7 | 35 / 4 / 1 / 0 |
| 3 px, 4 px, 6 px | 4, 3, 3 | |
| 2 % / 5 % of the short side | 16 / 10 | |

- On this evidence the gate never rejected for colour or layout (0 of 44). Every gain therefore came from the edge checks: the composite carries the transfer's own coarse edges, so the edge-moved check passes by construction, and the smaller the sigma the more it does. That is a loosening of the edge check in effect, even though no threshold changed.
- One of the 4 new accepts at 2 px, `l3b` chart s03, a pier face, carries a vertical meander fret running down the pier. The two reference panos show the meander only on the impost band (`enhance_split_s03_*.png`). The fret is invented structure, and it passed with 4.5 % new edges (limit 5 %). The other 3 new accepts add generic stone grain (`enhance_split_s23_s29_s31_*.png`).
- Not kept: no layout or colour rejections to recover here, and the one structural gain was a hallucination.

### 2a. Footprint-aware sampling (kept, `ad2248b0`)

The close-up crops resolve about 6 px per 5 cm texel (measured footprint median 5.5-8.8 px on l3b's 16 views), so the centre point sample aliased. Each texel is now the photo's box mean over the texel square projected through the camera Jacobian. Bilinear taps are placed about a pixel apart, read from a linear-RGB pyramid level when more than 32 would be needed. A footprint within one pixel is the bilinear point sample, bit for bit. The footprint must clear the redaction rects and the depth-edge guard whole.

| | Before | After |
|---|---|---|
| Aliasing error vs box reference, l3b, all 16 views (556,792 texel samples) | 5.10 levels RMS | 0.60 |
| Worst chart (l3b s00, the front spandrels, view 7) | 7.88 | 0.69 |
| Held-out, full replay l2 / l3b / l3cf / l4 (chamfer px) | 5.164 / 5.033 / 4.46 / 5.555 | 5.078 / 5.128 / 5.18 / 5.49 |
| Held-out NCC | 0.237 / 0.228 / 0.069 / 0.065 | 0.234 / 0.223 / 0.020 / 0.056 |
| Pixel-weighted mean chamfer over the four layers | 5.148 | 5.159 |
| Offline projection-only l3b / l3cf | 4.733 / 4.392 | 4.750 / 4.259 |

- The held-out score is neutral overall (+0.011 px weighted). l2 and l4 improve; l3b is a little worse (driven by pano `LlULdr`, 4.72 -> 4.87). l3cf is worse by 0.72 px, but it is a small layer (77k judged pixels, one pano) and the offline projection-only bake improves it, so the regression comes from the stages after the projection (witness, merge), not the sampling itself. The chamfer judges line segments at 640 px; a point-sampled bake's aliasing adds short spurious edges, which a symmetric chamfer partly rewards.
- Visible gain: the blocky speckle on the spandrel figures and medallions is gone (`cmp_spandrel_medallion_zoom_base_vs_footprint.png`, `footprint_l3b_s00_close_view_point_vs_footprint_zoom.png`); the bake is softer and no longer sparkles. Kept as neutral with a visible gain.
- Side effect: the enhancement crops change with the projection's coverage, so in the replay the enhancement missed its recordings and stood unenhanced (`enhance_failed`, strict replay). Enhanced texels do not enter the held-out bake.
- Tests: a bar facade at 2 periods per texel (point mean/max error 10.8/33.3 levels, footprint 3.5/16.3); the alignment test now judges against the texel's box mean (footprint 0.962, point 0.899, limit 0.9); the seam-refinement case pins point sampling, as it was tuned (3.41 -> 3.90 point, 3.55 -> 4.16 footprint).

### 2b. Band-limited view weights in the band blend (not kept)

Each view's weight in band l is scaled by exp(-0.5 (2 pi sigma_gsd / lambda_l)^2), with sigma_gsd = GSD / sqrt(12) and lambda_l = 2 pi sqrt(sigma_lo sigma_hi) texels. In a synthetic rig (a 4x coarser view) it kept the joints, raising the neighbour step from 18.2 to 19.7 (fine view alone 22.5) and cutting the error from 4.07 to 2.90. On the real evidence it changed nothing: the default path selects one view per region and blends in the gradient domain (Poisson), so the band blend never runs there. With the band blend forced (`poisson: false`) l3b's held-out score was 4.739 both ways; with the weighted blend (`regionSelect: false`) it was 4.845 both ways. The close-up crops' GSD (8-30 mm) is far finer than the 5 cm texel, so every view passes every band. Not kept (patch in the session scratchpad).

### 3. Soft visibility (not kept)

The hard occlusion test and depth-edge guard became a probability: a two-component logistic along the ray (occluder depth, fitted-surface depth, scale tol / 4), the guard ring as a product of the probes' agreement with the texel's own state, and the pose / footprint ring as their mean. The hard drop applies only below 0.05. The occluder's mix weight was halved where the photo showed the tile photo's colour of the surface at the texel (CIE76 <= 20, the witness's limit).

| Full replay, held-out chamfer / NCC | l2 | l3b | l3cf | l4 |
|---|---|---|---|---|
| Footprint (hard visibility) | 5.078 / 0.234 | 5.128 / 0.223 | 5.18 / 0.020 | 5.49 / 0.056 (3 of 4) |
| Soft, with the colour doubt | 5.857 / 0.181 | 5.305 / 0.194 | not measured | 7.035 / 0.098 (2 of 4) |
| Soft, without the doubt | 5.054 / 0.259 | 5.232 / 0.201 | 5.92 / -0.008 | 6.31 / 0.061 |

- The colour doubt is useless on a monochrome monument. The arch's marble in front of the arch's marble agrees with the tile colour, so self-occluded texels were rescued and coloured from the occluder: l3b baked 253k -> 340k texels, and the back attic band got stretched streaks (`soft_doubt_attic_back_close.png`). It did reveal the back keystone ornament that the hard test leaves to the tile's dark square.
- Without the doubt, l2 is slightly better and l3b, l3cf and l4 are worse. Offline (projection only, no witness) l3b improved (4.750 -> 4.628), so the loss appears only once the later stages run; the full replay is the verdict. A pose-sigma widening of the depth scale was dropped before measuring: it let a panel 1 m in front through at weight 0.1 in the synthetic rig.
- Not kept (patch in the session scratchpad).

### Candidate tool/service ideas

- Commit a bake-input dump hook (atlas, views, depth maps per layer) to the replay harness, so offline A/Bs of the projection need no preload script.
- Make the enhancement replay independent of the projection's coverage, e.g. key the recordings by the transfer crop under the texels the projection never covers, so projection changes can still be compared with the enhancement on.
- A naturalness check in the enhancement gate (NIQE-style, research group A) would have caught the invented meander fret no better than the edge checks did. A reference-grounded structure check (the model's added edges must appear in a registered reference crop) is the missing gate.

## Round 11: pass-through scan that lies on a fitted face is hidden (2026-10-18)

Worktree `.claude/worktrees/hide-redundant-scan` from `origin/main` `d89ed83a`. Ports: web 3092, API 3093, tools 3094, screenshot receiver 3099 (API server started from `desktop-app/` with `node -r ts-node/register [-r scripts/dev/staged-replay.ts] server/index.ts`, vite beside it; `secrets.json` symlinked for the runs and removed after). Replays: `scripts/dev/staged-replay.ts` on a copy of round 9's recording (`scratchpad/mem/rec`; 75-77 vision hits, 54 grounding hits per build, 3 misses for the new `l3cf` content's enhancement call, recorded live). Screenshots: `test-results/screenshots/hide_redundant_scan/` (`before_*` and `after_*`: the same replayed evidence in the app, `SCRATCHBOX_STAGED_HIDE_REDUNDANT=0` and on; `live_after_*`: the live run; `synthetic_wall_copy_statue_fragments.png`: the unit test; gitignored). Views set with `__SB_SET_CAMERA_VIEW__` around `[-1.25, 10.8, -2.4]` (front theta 147°, back -33°).

**Status: Verified.** Round 9's back-side wedge (`l3cf` region `x21`, a 19.4 m² pass-through piece lying on the right spandrel) is gone from the drawn and textured layers; the textured fitted wall shows there. The keystone square (`x18`) stays: it stands 0.10-0.20 m off the fitted frieze (measured below), so the rule keeps it as proud.

### What changed

- `redundant-scan.ts`: a point of a pass-through triangle is redundant when a fitted face lies directly behind it: its projection along that face's normal lands inside the face, and |offset| <= the face's tolerance. The redundant set of one fitted face is a prism (two slab planes at ±tol, one plane through each edge along the normal, 1 mm slack at the edges); coplanar, edge-connected fitted triangles that fill their convex hull are one face. Each pass-through triangle is clipped exactly against the prisms near it (Sutherland-Hodgman): the parts inside go to the hidden side, the rest is kept as convex pieces with straight edges; a piece no prism actually reaches stays whole. Nothing without a fitted face behind it is hidden, so no hole opens. Tolerance per fitted surface: 3 x its scan rms, clamped to 0.10-0.15 m.
- Fit stage: the split runs on the fit's pass-through GLB (22 ms on the arch). `l3ch` (the hidden parts, as-scanned, note "hidden: redundant with the fitted surface ...") is committed first and the fitted body `l3b` supersedes it, so it is out of the drawn scene, gets no textured twin, is not in the visible-layer gate, and shows under "Show replaced layers". `l3c` is the rest; the figures stage cuts `l3cf` from that rest (figure detection still reads the full pass-through). Per region with anything hidden: a `pass_through_hidden` degradation ("pass-through hidden: redundant with fitted surface, offset X m (largest Y m, tolerance ...); shown under replaced layers", `part.objectId` = `l3ch`, so the provenance view highlights it); a region hidden whole loses its "kept as scanned" `pass_through` record. `structureFit.passThroughHidden` in the result (triangles hidden whole / clipped, areas, tolerance, report path); the summary aggregates them in one sentence. `SCRATCHBOX_STAGED_HIDE_REDUNDANT=0` turns it off.

### Synthetic checks (fail without the change)

`staged-redundant-scan.test.ts`: a fitted wall with a noisy scan copy 5 cm in front (hidden whole, 48.2 m²), a lump 1.3 m proud and a fragment past the wall's edge (kept whole), a fragment straddling the edge (clipped at x = 10 m, area conserved), a 6 m² triangle leaning out of the wall (clipped exactly where it leaves the 0.10 m slab), every hidden point within the tolerance of the wall directly behind it. `staged-texture-orchestrator.test.ts`: through the orchestrator, the copy lands in `l3ch` (superseded by `l3b`, no twin), `l3c` and its twin hold exactly the lump's and the fragment's triangles, the degradation, result record and summary.

### On the arch (fit `0a38cbdd`, the same in every run)

379 pass-through triangles, 238.5 m² in 28 regions; hidden 70.4 m² in 26 regions (1 triangle whole, 224 clipped); the drawn `l3c` has 1,315 triangles. The first version cut every piece along every fitted triangle it passed (24,100 drawn triangles; the `l3cf` texture pass took 2x as long and its leave-one-pano-out fit was 4.93 px over 3 of 4 panos); merging coplanar fitted faces and keeping unreached pieces whole fixed that.

Tolerance sweep (hidden area): 0.10-0.15 m (default) 70.4 m²; 0.20 m 109.1; 0.30 m 156.8; 0.50 m 186.5. The keystone square `x18`: 0.85 of 2.73 m² hidden at the default, all of it at 0.20 m, so it stands 0.10-0.20 m proud of the fitted frieze. The wedge `x21`: 9.95 of 19.35 m² at the default (the part over the spandrel; the rest lies past the arch's edge or proud), 17.7 at 0.20 m.

### Held-out fit on identical replayed evidence (leave one pano out, px / gradient NCC)

| Arm | l2 | l3b | l3cf | l4 |
|---|---|---|---|---|
| off (`SCRATCHBOX_STAGED_HIDE_REDUNDANT=0`) | 5.164 / 0.237 | 5.033 / 0.228 | 4.460 / 0.069 (80,255 px, 4 panos) | 5.555 / 0.065 |
| off, `l3cf` scored only on the pixels of the pieces that stay drawn (scratch scoring mask, not committed) | | | 4.200 / 0.106 (51,436 px) | |
| on | 5.164 / 0.237 | 5.033 / 0.228 | **3.851 / 0.289** (54,598 px, 4 panos) | 5.555 / 0.065 |

After merging `origin/main` (`38dbc1fa`, round 10's texture-projection change; its vision prompts changed, so the off arm recorded 47 new replies live and the on arm replayed them): off l2 5.078, l3b 5.128 / 0.223, l3cf 5.180 / 0.020 (73,021 px), l4 5.490; on the same, except l3cf **3.704 / 0.241** (49,075 px).

The registration (joint 7.12 / 0.196) and every other layer are the same to the digit. The two in-app replays (`b30415d7` off, `6a236b83` on) reproduced the headless numbers exactly. On the same kept pixels the new `l3cf` texture fits better (3.85 against 4.20 px): with the copy of the wall gone the layer's own statistics (single-pano witness level, exposure match) are those of the pieces it draws.

### Live (cold for the survey, evidence, vision/detail, figures and texture stages; tiles, remesh, fit cached)

Run `08391af1` (about 8 min): joint registration 6.86 / 0.183 (warp 6.78 / 0.192); leave-one-pano-out l2 6.63 / 0.171, l3b 5.46 / 0.235, l3cf 6.42 / 0.031 (29,258 px), l4 no pixels (the detail stage degraded: built away from where it was read). The same 70.3 m² in 26 regions hidden; 26 `pass_through_hidden` entries in the overlay's degraded parts, each highlighting `l3ch`. Main thread p99 14.4 ms, max 1.46 s (evidence). As round 9 found, a live run's evidence differs from run to run, so these numbers are not comparable with the replays.

### What I saw (`after_*` against `before_*`, same evidence)

- **Better:** the back's sky-blue/grey wedge on the right spandrel is gone; the spandrel shows the fitted wall's texture (`*_tex_back`, `*_tex_back_spandrels`). In the provenance view the orange as-scanned wedge is gone from the spandrel (`after_prov_back`) and comes back hatched with "Show replaced layers" (`after_prov_replaced_back`).
- **Unchanged, by the rule:** the keystone square (0.10-0.20 m proud), the dark mark right of the frieze (tile photo), the statues and pedestals (figures layer), the front.
- **Still wrong:** the keystone square remains a differently exposed patch; at 0.20 m it would go too, but 0.20 m also reaches relief that stands that far out, so the default stays 0.10-0.15 m.

### Candidate tool/service ideas

- A union held-out fit: score what is drawn (all visible layers together) per pano, so a layer that loses pixels to another is judged on the composite rather than on its own remainder.
- Save the overlay panel (DOM) beside the 3D capture, so the provenance list shows in screenshot evidence too.
