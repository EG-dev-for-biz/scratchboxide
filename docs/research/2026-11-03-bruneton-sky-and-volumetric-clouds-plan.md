# One sky for Scratchbox: precomputed multiple scattering, then volumetric clouds

2026-11-03 · sky lane · each phase is agreed with MAIN before it starts, and each lands as its own PR to `main`.

## Why

Scratchbox draws two different skies today, and neither scatters light more than once in the same way.

- **The viewer** (`physical-sky.ts`) computes a spectral sky on the CPU in TypeScript: 12 wavelength bins, Rayleigh, Mie and ozone, and Hillaire's (2020) isotropic approximation for multiple scattering. The result goes into a sky-view table that the dome's GLSL samples (`AtmosphericSkyDome.ts`). Aerial perspective (`AerialPerspectiveEffect.ts`) and the sky light rig (`sky-light-rig.ts`) have their own code paths.
- **The native engine** (`scratchbox_sky.hpp`) computes single scattering in RGB. The path tracers (`scratchbox_pathtracer.hpp`, the Metal tracer) and `native-sky-service.ts` light bakes and IBL probes from it.

So a bake cannot match the viewport: the native sky has no multiple scattering, and the viewer's multiple scattering is an approximation. One precomputed model in C++, with both sides reading its tables, fixes that at the root. Clouds have a similar gap. They exist only as curved shell layers inside the dome (`cloud-shell-layers.ts`), with no ray-march, so in the Penn district renders (MAIN, 2026-11-03: views 2–4 of `2026-11-03-penn-kd-district-views.jpg`) they read as crisp cut-out puffs against a photoreal city.

## P1: Bruneton precompute in C++20 (this PR)

- **Header:** `scratchbox_atmosphere_lut.hpp`, a line-for-line port of Bruneton's `functions.glsl` and the precompute order of his `model.cc` (BSD-3 notice kept), in double precision and multi-threaded. It computes transmittance, direct irradiance, single Rayleigh and Mie scattering, then the scattering density, indirect irradiance and multiple scattering for N orders.
- **Inputs:** continuous quantities only. Radii, two-layer density profiles, per-wavelength spectra (solar, Rayleigh, Mie scattering and extinction, absorption, ground albedo), Mie g and `mu_s_min`. No presets.
- **Wavelengths:** precomputed in batches of three. Each batch carries a 3×3 matrix to the output channels: the identity gives radiance at three wavelengths, as three-geospatial ships it; CIE 1931 weights × bin width integrate many bins into linear sRGB, the viewer's 12 bins among them.
- **Output:** Bruneton's layout, RGBA, float32 or binary16:
  - transmittance 256×64;
  - scattering (rgb = Rayleigh + higher orders over the Rayleigh phase, a = single Mie R), single Mie and higher-order scattering, 256×128×32 (NU 8 × MU_S 32, MU 128, R 32);
  - irradiance 64×16;
  - `atmosphere.json` beside them, describing the medium, the layout and the timings.
- **Driver and service:** the CLI `scripts/atmosphere_lut.cpp` and the service `atmosphere-lut-service.ts`, built through `compileNativeCached`. The same driver also loads tables (ours or any in this layout) and evaluates sky radiance, transmittance and sun and sky irradiance.
- **Validation** (`packages/core/test/atmosphere-lut.test.ts`):
  1. All of Bruneton's `functions_test.cc` is ported: 25 tests and 127 checks, at his tolerances.
  2. Our Earth tables vs three-geospatial's shipped tables (pinned `eac10398`, fetched into `.model-cache/` by `scripts/fetch_three_geospatial_atmosphere.mjs`), per table and channel. Tolerance: mean < 0.3 %, p99 < 2.5 %, max < 15 %. The same runtime functions on both sets of tables must give the same sky to within a mean of 1.5 % for a camera at 1 m and 0.3 % at 1 km.
  3. The four sun elevations (90°, 30°, 5°, −3°) against the native and viewer skies, rendered as a labelled sheet in `docs/screenshots/sky_bruneton_2026-11-03/`.
  4. The precompute timing.
- **Where it runs:** every run, pull requests included, builds the functions test (1) and a single-scattering Earth precompute, checks its layout and refuses non-physical media: about 8 s cold. The 4-order and spectral tables with checks 2–4 take about 30 minutes on a CI runner (the scattering density is 90 % of it), so they run only under `SCRATCHBOX_HEAVY_TESTS=1`: set by the macOS job on pushes to main and nightly, and locally for the sheet. Check 2 also needs the fetched fixture and skips with its reason without it.
- **Not ported:** `model_test.cc`. It compares the GPU model's renders against the CPU reference by PSNR, which has no counterpart here: there is no GPU model in this PR. Its spectral-vs-three-wavelength question is answered in P3 instead, as the viewer columns of the sheet.

### P1 results (2026-11-03, 16-core Mac)

**Ported unit cases:** 25 tests, 127 checks, all pass.

**Tables vs three-geospatial** (relative error per channel R / G / B, as mean / p99 / max):

| Table | Mean (%) | p99 (%) | Max (%) |
|---|---|---|---|
| transmittance | 0.019 / 0.022 / 0.026 | 0.55 / 0.78 / 1.10 | 5.2 / 7.1 / 2.9 |
| scattering | 0.035 / 0.045 / 0.076 | 0.61 / 0.91 / 1.71 | 4.5 / 5.7 / 11.4 |
| single Mie | 0.046 / 0.054 / 0.066 | 0.61 / 0.69 / 1.03 | 4.7 / 7.5 / 10.3 |
| higher order | 0.086 / 0.097 / 0.123 | 0.64 / 0.97 / 1.79 | 4.5 / 5.2 / 10.6 |
| irradiance | 0.028 / 0.031 / 0.041 | 0.24 / 0.33 / 0.57 | 0.3 / 0.4 / 0.6 |

The worst texels sit at the table edges: straight-up and straight-down view rows, and horizon transmittance near 1e-3.

**Sky luminance through the same runtime functions:**
- **Camera at 1 km:** 0.03 % mean difference.
- **Camera at 1 m:** 0.63 % mean difference. The ground slice of the 4D table (R row 0) is the only one that differs, by about 1 %; every slice above agrees within 0.1 %.
- **Likely cause:** float32 cancellation in r² − R² on three-geospatial's GPU at ground level, against our double precision. Not proven.

**Skies, mean hemisphere luminance relative to Bruneton in the same medium:**

| Sun elevation | Native single scattering | Viewer (Hillaire approximation) |
|---|---|---|
| 90° | 64 % | 90 % |
| 30° | 74 % | 79 % |
| 5° | 78 % | 76 % |
| −3° | 69 % | 87 % |

**Precompute time** (4 orders, 16 threads):
- 3 wavelengths: 25 s standalone, 38 s inside the test suite on a shared machine.
- 12 wavelengths in 4 batches: 141 s inside the test suite.

**Proof sheet:** `docs/screenshots/sky_bruneton_2026-11-03/sky_bruneton_comparison.png`, with `summary.json` beside it.

## P2: native consumers read the tables

**Goal:** bakes match the viewport. One `AtmosphereLut` runtime in C++ (the header's `GetSkyRadiance`, `GetSkyRadianceToPoint` and `GetSunAndSkyIrradiance`) replaces `sky::PhysicalSky` wherever it is used.

- **Consumers:** `scratchbox_pathtracer.hpp` (sky radiance on escape, the sun as the disc's radiance times `GetTransmittanceToSun`, aerial perspective to a hit), the Metal tracer, `scratchbox_engine.hpp`, `native-sky-service.ts` (IBL probes and sky images), and the scripts that include `scratchbox_sky.hpp`.
- **Interface:** `PhysicalSky` keeps its public API (`skyRadiance`, `sunDiscRadiance`, `sampleSunDirection`, `sunIrradiance`, `skyIrradianceHorizontal`, `hazeExtinction`), so callers don't change, but its body samples the tables. Its single-scattering integrator is deleted, not kept alongside.
- **Medium mapping:** today's knobs (`airDensity`, `dustDensity`, `ozoneDensity`) become the medium's coefficients, which are continuous. A changed medium means new tables. They are cached by a hash of the medium, like the native build cache: 25 s for three wavelengths and about 100 s spectral on 16 cores. They can also be precomputed off the request path (see "Precompute speed" below).
- **Done:**
  - an existing path-traced bake under the same sun renders against the viewer dome, side by side, and the luminance difference on the sky is within 2 % mean;
  - the native sky tests (`native-sky-and-delight-engine.test.ts`, `native-tile-path-tracer.test.ts`) are updated to the new radiance, with the change stated rather than tolerances loosened;
  - nothing in the tree still includes the old integrator.
- **Overlap:** the main checkout holds uncommitted path-tracer and Metal work from another lane (`scratchbox_pathtracer.hpp`, `scratchbox_metal_pathtracer*.hpp`). P2 starts only after MAIN says that work has landed or names who owns those files.

### P2 as built (2026-11-03, user approval "proceed with phase 2")

- **One change, every native consumer:** `PhysicalSky`'s body reads the tables; its public API and its equirectangular sky table (which the Metal tracer uploads) are unchanged, so the CPU tracer, the Metal tracer, the engine, `render_tile_pathtraced`, `sbvg_pathtracer` and `native-sky-service.ts` take the new sky without an edit. None of the held-back path-tracer files is touched. The single-scattering integrator is deleted.
- **Reads:** sky radiance from `GetSkyRadiance` (the equirectangular table resampled from it: 0.02–0.13 % from reading the 4D tables directly), the sun's transmittance from `GetTransmittanceToSun`, the sky irradiance from the irradiance table, the haze extinction from the medium's own profiles.
- **Medium:** `sky::earthAtmosphere`: the knobs (`airDensity`, `dustDensity`, `ozoneDensity`, `sunAngularDiameterDeg`, and the new `groundAlbedo`, default 0.1) scale Hillaire's Earth coefficients; solar irradiance 1, so radiance stays relative to `sunIntensity`. Three wavelengths, four orders.
- **Cache:** `atmosphere_lut::cachedAtmosphere`: per process, then on disk (`SCRATCHBOX_ATMOSPHERE_CACHE`, else `$TMPDIR/scratchbox-atmosphere-cache`), keyed by every input the precompute reads; float32, written under a temporary name and renamed; processes wanting one medium at once take turns on an `flock`, so one precomputes and the rest read. About 30 MB a medium. A cold medium cost 104 s on this Mac under a load average near 300 (25 s idle); a warm one reads in well under a second.
- **What changed, same medium** (mean hemisphere luminance, old single scattering over the tables): 74 % at a 60° sun, 75 % at 30°, 78 % at 10°, 80 % at 2°; per direction 62–95 %, lowest toward the horizon away from the sun, where the higher orders carry most of the light. Sky irradiance on a level surface rose by the same factor (old 75–82 % of new). The sun's transmittance is unchanged to four digits. This is the "64–90 %" P1 found, now in the native renders. Sheet: `docs/screenshots/sky_p2_2026-11-03/sky_p2_old_vs_tables.png`, `summary.json` beside it.
- **Who sees the brighter sky** (mean light up 25–35 %, exposure and sky fill both): the CPU path tracer (`render_tile_pathtraced`: survey station renders, the path-trace route's CPU side), the Metal tracer (the `/3d/path-trace` route), the Python module's sensor passes (`renderSensorPasses`), `sbvg_pathtracer` and `NativeSkyService` (exported; no caller in the app). Nothing de-lights against this sky: pipeline K's sky de-light (`sky-delight.ts`), roof-shadow lift and harmonising have their own models, and no K or K-D chunk constructs a `PhysicalSky`, so the chunk image needs no tables. The viewer is unchanged until P3.
- **First start on a machine:** the native warm-up (`native-warmup.ts`) ends with the default medium's tables (`NativeSkyService.warmDefaultSky`), after the location path's engines.
- **Tests:** the suite runs the sky at one scattering order (`SCRATCHBOX_SKY_SCATTERING_ORDERS=1`, set in `vitest.config.ts` unless `SCRATCHBOX_HEAVY_TESTS=1`): a 0.2 s precompute per machine instead of 25–100 s. One order has no sky irradiance (Bruneton's irradiance table holds orders 1 to N−1), so the light run checks it is zero and the heavy run checks its value. `native-tile-path-tracer.test.ts`'s sky check reads the tables and tightens the equirectangular tolerance from 5 % to 1 %; its new heavy test checks the four-order sky, where single scattering alone gives 65–92 % of the zenith.
- **Moved to P3:** the bake against the viewer dome within 2 %. The viewer dome is still the TypeScript single-scattering sky until P3, so a native bake and the viewport now differ by the table above; P3 closes it.

## P3: the viewer samples the same tables

**Goal:** one sky app-wide. The CPU TypeScript integrator in `physical-sky.ts` goes.

- **Table delivery:** the server serves the tables for the scene's medium: binary16 RGBA, 16 MB for scattering plus single Mie; or 8 MB with combined scattering, where alpha holds single Mie R and the full Mie is extrapolated, as Bruneton and three-geospatial do.
- **Viewer upload:** `THREE.Data3DTexture` (scattering) and `DataTexture` (transmittance, irradiance), with a GLSL port of Bruneton's runtime functions (`GetSkyRadiance`, `GetSkyRadianceToPoint`, `GetSunAndSkyIrradiance`). The tables are physical, so the viewer computes nothing.
- **Consumers:**
  - `AtmosphericSkyDome.ts` stops calling `buildPhysicalSkyLut` and samples the 4D table per pixel;
  - `AerialPerspectiveEffect.ts` uses `GetSkyRadianceToPoint` with the depth buffer, and keeps its own pass (no pmndrs composer is needed);
  - `sky-light-rig.ts` takes sun and sky irradiance from `GetSunAndSkyIrradiance`.
- **Weather:** the Weather tool still goes through `scene-weather.ts` `applySceneWeather`. Turbidity and haze set the medium's Mie coefficients, and the tables follow. A haze change is a table change, so the server holds a small cache keyed by medium.
- **No uninvited sky** (AGENTS.md §3.6): unchanged. The dome and its tables exist only when the scene asks for an atmosphere.
- **Done:**
  - the viewport sky and a native render at the same sun agree within 2 % mean on the sky;
  - `physical-sky.ts` is deleted, or reduced to the medium description;
  - one screenshot sheet per sun elevation of the live app beside the native render;
  - the frame time of the dome pass is no worse than today's.

## P4: volumetric clouds

**Goal:** clouds that read as volumes lit by the same sky. The shell decks stay as the cheap far field.

- **Shape, in C++** (AGENTS.md §1.6: no canned textures):
  - a weather map (coverage, type as a continuous height-profile parameter, precipitation);
  - a 128³ shape noise (Perlin–Worley) and a 32³ detail noise (Worley).
  - All of it is generated procedurally in `scratchbox_engine.hpp`'s noise and written as tiling 3D tables. Parameters are continuous: coverage, base altitude, thickness, erosion and density scale.
- **Viewer:**
  - a GLSL ray-march at quarter or half resolution with temporal reprojection;
  - Beer–Powder with multiple-scattering octaves for the lighting (Wrenninge), and a dual-lobe Henyey–Greenstein phase;
  - ambient light from the P3 irradiance table, and the sun through `GetTransmittanceToSun` at the cloud's own point, so clouds redden at sunset with the same air the sky uses;
  - cloud shadows from a top-down optical-depth map (cascaded at district scale);
  - light shafts through the `shadow_length` input Bruneton's `GetSkyRadiance` already takes.
- **Native:** the same density field and lighting in the path tracer, extending or replacing `scratchbox_atmosphere.hpp`'s cloud lighting, so bakes carry the same clouds.
- **Far field:** past the ray-march distance, `cloud-shell-layers.ts` decks continue the same weather map.
- **No uninvited clouds:** clouds appear only when the prompt, the contract or the Weather tool asks.
- **Done:** the Penn district views 2–4 re-rendered with volumetric clouds at the same sun, on a sheet beside the current puffs; a frame-time budget met (P5); clouds and sky reading as one light.

## P5: the competitive bar

- **Against photographs:** side-by-side renders against the 13 clear-day Poly Haven HDR skies that `SunGlare.ts` was measured on (the sky-realism benchmark). Each is matched on sun elevation and turbidity fitted from the photo. Reported per sky: luminance error by zenith band, chromaticity error (Δu′v′) and the horizon-to-zenith gradient.
- **Against three-geospatial:** the same views from their renderer (their tables plus clouds) beside ours.
- **Frame-time budgets** on the user's Mac at 1440p: sky and aerial perspective ≤ 1.0 ms, clouds ≤ 4 ms at half resolution. Measured in the live app, not estimated.
- **Further development:**
  - more wavelengths for twilight (15 batches is Bruneton's reference spectral count);
  - ozone from a measured cross-section rather than the three-point fit;
  - a measured solar spectrum rather than a 5778 K blackbody;
  - multiple scattering inside clouds;
  - aerosol profiles from data.

## Precompute speed

On 16 cores, three wavelengths at four orders take 25 s, 90 % of it in the scattering density: 16 × 32 directions per texel, each two 4D lookups. Options, in order:

1. precompute off the request path, cached by medium hash, so any scene's sky is a lookup;
2. vectorise the density loop: the directions are the same for every texel of an r slice;
3. a Metal compute port of the density pass, checked bit-for-bit against the C++ port, like pipeline K's native kernels.

None of these changes the tables.
