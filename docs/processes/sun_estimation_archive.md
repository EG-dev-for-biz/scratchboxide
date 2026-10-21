# Sun estimation from imagery: archived branches and what to port for footage matching

**Date:** 2026-10-20
**Status:** Archived; port when footage matching starts

## Why these branches are not merged

`tile-sun` and `measured-brdf` tried to measure the tile capture's sun, in order to de-light textures during staged builds. Neither shipped. De-lighting needs correct irradiance per texel; the user chose Nano Banana de-light instead (the "De-light strategy" decision, 2026-10-18). Main has since rewritten the code they hook into: lighting correction and pixel ownership in `texture-pass.ts`, and the tile reader in `tile-texture-transfer.ts`. Merging them would mean porting de-light wiring into code that runs on every build.

Footage matching needs much less: the sun's direction to within a few degrees, and a rough ambient-to-sun ratio. That part of the work is worth keeping.

## Where the code is

- Tag `archive/tile-sun-2026-10-20` (branch `tile-sun`, a4daf594)
- Tag `archive/measured-brdf-2026-10-20` (branch `measured-brdf`, 57d2925e)

## What to port, and what not to

| File | Lines | What it does | Decision |
|---|---|---|---|
| `staged-location/pano-sun.ts` (measured-brdf) | 530 | Sun direction from the sky in Street View panoramas: a clear-sky model and the sun disc on the solar path | **Port.** Generalise to any image with a known camera (a plate showing sky) |
| `staged-location/tile-sun-facing.ts` (tile-sun) | 679 | Sun direction and ambient ratio from wall and roof brightness against their facing directions | **Port.** Works when the plate shows no sky, using matched 3D tiles |
| `staged-location/tile-sun-geometry.ts` (tile-sun) | 120 | Ray casts and sun visibility on the tile mesh | **Port.** Checks that a comp's shadows agree with the scene |
| `staged-location/tile-sun.ts` (tile-sun) | 774 | Sun from the shadows baked into the tile photos | **Port the shadow-consistency part only.** Drop the de-light |
| `atmosphere/sky-photometry.ts` changes (measured-brdf) | 19 | `SunNotFoundError` and helpers | Port |
| `staged-location/measured-brdf.ts` | 489 | Reflectance lobes per texel for de-lighting | Leave archived (superseded) |
| `staged-location/lighting-views.ts` | 177 | Plans up to 24 sky crops per build | Leave archived (specific to staged builds) |
| Wiring in texture-pass, orchestrator, transfer, staged GLB writer and tile_refine | ~350 | Applies de-light inside builds | Do not port |

Tests to bring along: `staged-tile-sun-facing.test.ts` (176 lines), the shadow parts of `staged-tile-sun.test.ts` (365), and the sun-detection parts of `measured-brdf.test.ts` (342).

## Re-checked 2026-10-21 (integration pass)

A session merging every branch with real unpushed/unmerged work into `main` (per a user request) reached `tile-sun` and `measured-brdf` independently, tried the merge, and hit real conflicts in the same three files this doc's own reasoning predicts (`orchestrator.ts`, `texture-pass.ts`, plus `staged-glb-writer.ts` for measured-brdf and `tile-texture-transfer.ts` for tile-sun) — both branches are still ~470-480 commits behind `main` and still collide with code `main` has since rewritten (the facade-materials roughness system in particular, which did not exist when this doc was written). The merges were aborted rather than resolved by guesswork, matching this doc's own "do not port the wiring" conclusion. No change to the decision above: still archived, still waiting on footage matching to start before porting the named pieces.

## Porting plan (when footage matching is active)

1. **One standalone module** (e.g. `packages/core/src/node/spatial/sun-from-imagery/`), not wired into staged builds.
   - **Input:** images with known cameras (intrinsics and pose from the matchmove), optional geometry (the matched tiles or a mesh), and optional capture time and place.
   - **Output:** sun azimuth and elevation with an uncertainty, the ambient-to-sun ratio, and which evidence agreed (sky disc, facing brightness, shadows). Labelled `photo-inferred`.
2. **NOAA as prior and check.** When date and place are known, `atmosphere_calculate_solar_position` gives the true sun. Use it as a prior, and as the ground truth to measure the image estimates against.
3. **Validate before exposing it.** Run on real plates with known capture times and report the error in degrees. Expose it as a chat tool (for matchmove and lighting match) only once the error is acceptable. Its accuracy on real plates is unknown today.
4. **Follow the current rules.** No closed category lists. `tile-sun-facing.ts`'s `MaterialGroup.source: 'vision' | 'chroma'` is a label only. No fallbacks: a refused estimate says why.
