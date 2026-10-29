# Viewport sky realism: one set of light numbers, metered exposure, the sky to -18°

**Date:** 2026-10-28
**Target Domain:** 3D Viewport / atmosphere (sky dome, clouds, aerial perspective, exposure)
**Status:** Partly verified (live on the ESB at 36°, 3°, -6°, -12°, -19°; a grey orb probe 6.3:1 lit:shaded at 36° clear; photometry bench 6/6). Not done: drift without bake jumps, distance flattening of clouds, sun bloom tied to exposure, the Weather tool's sky preview. Open fault, outside the sky: the ESB's textured twin is drawn unlit.

## Setup

Own instance `scratchbox-sky-realism` (ports 3110 / 3111 / 3112), chat "Build a 3D building of the Empire State Building at 350 Fifth Avenue" (`scene-stg-2e702979`, pipeline K). Weather tool: 2026-06-15, cloud cover 35%, haze 0. Times 16:06 (sun 36.3° at 271°), 19:09 (3.1°), 20:06 (-5.9°), 20:50 (-12.2°), 21:48 (-18.9°).

- **Views:** relative to the 36° sun. View A is 90° round from the sun, 700 m out and 120 m up, aimed at 200 m. View B is 150° round, 380 m out and 10 m up, aimed at 260 m.
- **Meter:** in the page, a 90 x 70 raycast grid over the drawn canvas reads linear luminance and takes the median of each class:
  - lit wall: normal · sun > 0.3;
  - shaded wall: normal · sun < -0.05;
  - sky above 0.25 up, low sky, and the ground half of the dome.
- **Before:** the committed files (HEAD `99043f3b`) put back for the "before" shots, then this session's files restored.
- **Framing:** the panel layout differed between the two runs, so the "after" shots are wider crops (562 vs 416 px) of the same camera.

Screenshots (gitignored): `docs/screenshots/2026-10-28-sky-{before,after}-*.png`.

## Changes

1. **One set of light numbers** (`sky-light-rig.ts`, new; `AtmosphericSkyDome.ts` `applyPhysicalSky`):
   - the hemisphere light's colour is the physical sky table's irradiance colour (a chosen kelvin still tints it);
   - its level is the profile's while the sun is up, and below the horizon falls with the table from the sunset value;
   - the aerial perspective's haze colours are the table's horizon and zenith radiance, at the dome's scale (`hazeColors()`), replacing its fixed golden/twilight/night palette.
2. **Metered exposure** (`calibratedExposure`):
   - an incident meter (0.75 π / E) on the level-surface light, applied as `renderer.toneMappingExposure` each frame (`Scene3DPrimitive.tsx`), still through ACES;
   - below E = 1 it makes up only E^-0.3 of the drop, capped at 8.
   - Unlit photo materials (MeshBasicMaterial with a map) are divided back by the exposure (`compensateUnlitForExposure`), since a photo carries its own.
3. **Clouds:**
   - bake 1024 → 2048 per face;
   - 48-120 view steps (was 32-80) and a 7-step, 6.3 km sun march (was 6, 3.8 km), long enough to reach the neighbouring cloud;
   - a powder term that darkens edges facing away from the sun and fades out toward it (silver lining kept);
   - darker bellies (the base sees 0.3 of the horizon light, was 0.5).
4. **Aerial perspective:**
   - **On with the sky** (only an explicit `false` turns it off): `syncAtmosphere.ts`, the Weather tool (`scene-weather.ts`) and `atmosphere_configure_scene`. Its range follows the haze (`hazeRangeM`).
   - **Black frame bug fixed:** its scene target was 8-bit and its pass wrote linear values with no tone mapping or sRGB encode, so any scene with it on rendered nearly black. The target is now half float, and the pass tone-maps and encodes. It is scene-referred to the optics chain.
5. **Physical sky to -18° and below, no palette:**
   - `uPhysicalSkyWeight` is always 1, with the table built at max(elevation, -18°);
   - night adds a moonlit-air and airglow term (`uNightSky`, van Rhijn brightening toward the horizon) at a quarter of the night fill's irradiance;
   - the night fill is retuned (0.037 sky, 0.27 moon, set with the grey orb) and the moon casts no shadows;
   - stars are divided by the exposure;
   - below the horizon the dome draws ground (albedo 0.15 under the scene's light), softening into the horizon haze.

## Measurements (view A unless noted; linear luminance on screen)

| Sun | Exposure before / after | Sky high | Low sky | Ground (dome) | Picture |
|---|---|---|---|---|---|
| 36° (haze 20%, before) | 1 | 0.016 | 0.025 | 0.020 | before: almost black (the aerial perspective bug) |
| 36° (haze 0) | 1 / 1.354 | 0.118 → 0.191 | 0.244 → 0.344 | 0.217 → 0.112 | blue overhead, hazier toward the horizon; ground now under the sky |
| 36°, view B | 1 / 1.354 | 0.312 → 0.422 | 0.481 → 0.554 | — | lit tops, grey bellies |
| 3.1° | 1 / 3.355 | 0.047 → 0.333 | 0.078 → 0.431 | 0.025 → 0.031 | before: brown-dark sky, orange clouds on black; after: warm golden sky and clouds |
| -5.9° | 1 / 6.865 | **0 → 0.009** | **0 → 0.021** | 0 → 0.002 | before: pure black (the hand-over hole); after: deep blue twilight, horizon glow |
| -12.2° | 1 / 5.28 | 0.012 → 0.011 | 0.023 → 0.030 | 0.036 → 0.006 | before: saturated palette blue; after: dark blue night, stars, black ground |
| -18.9° | — / 5.26 | 0.011 | 0.030 | 0.006 | as -12° |

How the exposure was tuned, each step measured:

- **Square-root adaptation, capped at 40:** -6° and -12° showed as bright as day. Exposure 14.0 and 9.0, sky 0.12-0.40, the ground lavender 0.38-0.56 (`sky-step-A-sun-6-first-exposure.png`).
- **The same exposure applied to unlit photos:** the night ESB blew out to white (exposure 9.04). Fixed by the unlit compensation.
- **Power 0.3, cap 8, ground below the horizon:** dusk and night dark, but -12° (0.097) was brighter than -6° (0.040), because the night term was at the full fill (`sky-step-A-sun-6-sqrt-adaptation.png`).
- **The night term cut to a quarter:** -6° 0.009, -12° 0.011. Kept. Night is still marginally above dusk on this view (the twilight band is toward the sun, outside view A).

**Lit:shaded on the ESB reads about 1:1** (1.00-1.04 before, 0.8-1.4 after) **and cannot be judged on this scene:** its textured twin (`external-object-…~tex`, 271k vertices) is MeshBasicMaterial, so the sun and sky do not light it at all; the lit MeshStandardMaterial copy is hidden. That, not the sky, is why the building reads "flat"; it also glows at day brightness at night (now held there by the unlit compensation, as it was before).

## Grey orb probe (lit:shaded, which the unlit ESB cannot show)

The probe is an 18% grey MeshStandardMaterial sphere, 40 m in radius and roughness 0.9. It was added in the page only (a measurement probe, not scene content and not committed), between view A's camera and the building.

- **Meter:** the orb's sides are classified by the key light (n · key > 0.5 lit, < -0.3 shaded). The sky is the band 3-23° up.
- **Scene light:** "scene" values undo three's ACES curve (grey axis) and the exposure, giving the light ratio rather than the filmic display contrast.
- **Frames:** when the session's window was not on screen, frames were drawn by hand through `__SB_3D_RENDER_FRAME__`.

| Sun | Cloud | Exposure | Lit:shaded, scene light | Lit:shaded, on screen | Lit orb / sky (scene) |
|---|---|---|---|---|---|
| 36.3° | 35% | 1.354 | 4.45 (light numbers predict 4.6: lit 0.1013 vs 0.1014, shaded 0.0228 vs 0.0221) | 10.3 | — |
| 36.3° | 0 | 1.354 | **6.3** (5-8 target) | 16 | 1.34 |
| 3.1° | 0 | 3.355 | 5.1 | 12 | 0.53 (the bright low sky outshines an 18% card, as it does in life) |
| -12.2° (moon side) | 0 | 4.013 | 12.4 (clear moonlight, skylight-only shade) | — | 0.85 |

- **The renderer draws the light numbers exactly** (lit and shaded within 3% of the prediction from the light values).
- **Cloud cover softens the ratio** (35%: 4.45, clear: 6.3), as Kasten & Czeplak's split intends.
- **The ACES toe roughly doubles the contrast on screen.**

The orb found two faults in the night light, both fixed and re-measured:

- **The moon was too weak.** At 0.063 the orb read 0.001 against a sky of 0.027, a black disc (`sky-orb-sun-12-weak-moon.png`). `NIGHT_MOON_INTENSITY` is now 0.27.
- **The moon's shadows covered almost everything.** It used three's default 10 m shadow box, never fitted to the content, so the orb's moonlit side was in shadow (1 lit pixel of 404). The moon no longer casts shadows (`moonLight.castShadow = false`).
- **After both fixes,** the moonlit side shows as a moonlit sphere at 0.85x the sky (`sky-orb-sun-12-moonside.jpg`).

## Photometry bench (`packages/core/test/sky-light-rig.test.ts`, 6 tests, passing)

- 60° sun, turbidity 2 and 2.4: sky 15.6% / 19.0% of the sun's horizontal irradiance (10-20% asserted).
- 36°: horizon/zenith radiance 2.2 (1.5-4 asserted). At 60° it is 1.18, low; not asserted.
- 36°: a vertical wall lit vs shaded 6.4:1 (5-8 asserted). On screen, lit wall > mean sky > shaded wall; an 18% card at 0.10-0.18 before the curve.
- Twilight: the sky level falls monotonically from 0° to -18°, under 5% of sunset by -6°.
- Exposure: dusk > day; capped; a grey card at night 10-60% of day.

## Tests and typecheck

- `npx tsc --noEmit -p packages/core`: clean in the changed files. Other sessions' files show errors: `treeCrownShading.ts` (ShaderChunk), `tile-detail-bake.ts` (coverage).
- Atmosphere tests (19 files): the three whose expectation was "aerial perspective off unless asked" are updated and pass (36/36).
- Still failing and untouched by this change:
  - the native C++ sky and diurnal compile tests (30 s timeouts);
  - `facade-details-weathering` (4);
  - `headless-scene-atmosphere` (NoSceneBuiltError from the synthesizer).

## Not done

- Cloud drift without bake jumps.
- Flattening of distant clouds (they still fade, by the 25 km haze).
- Sun bloom tied to exposure (the glare mesh is tone-mapped, so it follows exposure, but not measured).
- A sky preview in the Weather tool.
- An overcast bench render.

## Candidate Tool/Service Ideas

- A viewport "meter" API (`window.__SB_3D_*` today has none): the lit/shaded/sky luminance classification used here as a registered debug call, so lighting changes can be measured without hand-written raycast scripts.
- A camera preset by sun-relative azimuth/distance in `scene3d_set_camera`, so before/after views are reproducible across sessions.
- The Weather tool's date is lost on reload of a chat (the panel came back with an empty date and today's sun); store it with the scene's weather.
