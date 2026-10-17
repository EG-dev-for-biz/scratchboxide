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

## Open issues (seen, not fixed)

- **Ghosting.** The spandrel Victories and the pier panels show double images from multi-view blending under the 1.3 m pose residual (`r3_tex_frieze_front.png`). The design's per-island 2D shift refinement is not built.
- **The scene lighting is dim and blue.** Clay renders navy too (`r2_clay_front.png`), so the textures look dark even though the atlas albedo averages sRGB about 135 to 145. This is the viewport's staged lighting, not the bake.
- **Translucent l4 panels over the pier in textured mode** (`r3_tex_pier_front_right.png`). This may be the ghost/reveal state of a superseded layer. Not diagnosed.
- **Seams.** The p95 seam is 17 to 24 ΔE00 and the maximum 56 to 75 ΔE00 between dominant views. The palette distance is fine (3.2 to 4.7 ΔE00).
- **No solar de-lighting.** Grounding capture dates are month-only (for example `2026-05`), so no view was solar de-lit. Only the capped shadow lift applied: 68 to 80% of the lift was kept on average.
- **The enhancement's partial results are lost on timeout.** All charts are discarded rather than keeping the ones already accepted.
- **Pre-existing, not from the texture pass.** The ornament spec in run 1 failed validation (`lattice.counts 800 > 400`).

## Candidate tool/service ideas

- An app endpoint to capture the active 3D view to a file at a chosen size and pose. I hand-rolled a localhost receiver plus `__scratchbox_capture_active_3d_scene`.
- A `staged_location_texture_report` tool that returns the per-layer cache records (rung shares, timings, degradations) without reading `.scratchbox/cache` by hand.
- A per-island shift search against the best view before blending, to address the ghosting.
