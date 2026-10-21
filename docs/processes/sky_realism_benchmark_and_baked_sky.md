# Sky realism benchmark, physical sky, rebuilt cumulus and the baked sky

* **Date:** 2026-10-20
* **Branch:** `sky-benchmark` (pushed to main in steps: 0283c1aa, 9124739e, ede91162, 1911117d, d00be8d1, and the bake commit)
* **Status:** Verified (benchmark runs, unit tests, headless-Chrome renders, live app on ports 3330-3332). The frame rate inside the app was not measured: the browser pane was hidden, which throttles animation frames. Bake timings below come from a standalone WebGL page.

## 1. The benchmark (`scripts/sky-realism/benchmark.ts`)

* **References:** 59 CC0 Poly Haven "puresky" HDRIs, listed in `scripts/sky-realism/references.json`. They are fetched once at 2K into `~/.cache/scratchbox/sky-references`, never into the repo.
* **The sun's position:**
  * Measured from the disc in the photo. It matches the elevation in the asset names to within 0.4° (`kloofendal_43d` → 42.9°).
  * With no disc visible, it comes from the NOAA ephemeris and the capture time. Poly Haven's `date_taken` is local camera time; the South African captures were calibrated as UTC+2 against 20 measured discs.
  * Five references have neither and are skipped, with the reason in the report.
* **Rendering:** the real `createAtmosphericSkyDome` is rendered in headless Chrome as linear-light panoramas (`packages/core/src/node/atmosphere-benchmark/`), in batches with retries.
* **Fair comparison:** each render is adapted to the photo's recorded camera white balance (Bradford, blackbody white to D65) before measuring.
* **Measures** (all independent of exposure; pass marks in `SKY_REALISM_TOLERANCES`):
  * sky gradient;
  * sky colour;
  * horizon to zenith ratio;
  * sun colour;
  * direct to diffuse light;
  * sky brightness relative to the sun;
  * cloud fraction;
  * cloud brightness per unit of sun;
  * cloud brightening toward the sun.
* **Run it:** `npx tsx scripts/sky-realism/benchmark.ts --out test-results/sky-realism/<run>` takes about 25 s. It writes `report.json`, `report.html`, one photo/render PNG per sky and paged contact sheets.

## 2. What it found, and what changed

| Finding | Change |
| :--- | :--- |
| Scene sky fill was ~5x too strong for clear skies (washed-out shadows) | Sun versus sky light split by Bird & Hulstrom's clear-sky model with Kasten & Czeplak cloud cover (`clear-sky-irradiance.ts`); the level-surface brightness keeps the diurnal curve |
| Hand-picked zenith/horizon palette | Physical sky (`physical-sky.ts`): Rayleigh, Mie (g 0.7), ozone, Hillaire multiple scattering, Earth shadow; 6.5 ms per sun change |
| The dome skipped tone mapping, so the physical sky showed near-black in the viewport | The dome includes `tonemapping_fragment` / `colorspace_fragment` |
| Cumulus "bubble" in every scene | Simplex noise typo (`floor(p * ns.z)` for `floor(p * ns.z * ns.z)`) returned values to ~2e5; sine hash precision; raymarch rebuilt (Nubis-style shape, measured lighting, coverage = sky cover via a measured table) |
| Cumulus cost 74-103 ms per 1080p frame | Sky baked into a 1024 cube map (below) |

**Benchmark, baseline → now** (median error, pass rate):

| Measure | Baseline | Now |
| :--- | :--- | :--- |
| Gradient | 0.65, 0% | 0.44, 19% |
| Horizon:zenith | 0.77, 17% | 0.46, 33% |
| Sun colour | 0.015, 23% | 0.011, 51% |
| Direct:diffuse | 1.57, 6% | 0.80, 31% |
| Cloud fraction | 0.23, 11% | 0.02, 75% |
| Cloud brightness | 0.70, 22% | 0.56, 40% |
| Toward-sun clouds | 0.32, 67% | 0.07, 75% |

## 3. The baked sky (`AtmosphericSkyDome.ts`)

* **How it works:** the sky depends only on view direction. Its shader (`skyMaterial` on the module) renders off-screen into a 1024 half-float cube map, and the visible dome only looks the map up.
* **When it re-bakes:**
  * in full when any uniform changes (compared each frame, so direct writes such as `AtmosphereService.setClouds` count);
  * while clouds or wind-driven decks drift, one strip (an eighth of a face) per frame every 0.5 s of scene time.
* **Timings** (standalone page, 1920x1080, M1 Ultra, before other sessions loaded the GPU):

  | Case | Per frame |
  | :--- | :--- |
  | Static sky, with or without cumulus | 0.9 ms (was 74-85 ms with cumulus) |
  | Drifting cumulus | 6-8 ms mean, 24-30 ms worst |
  | Full bake on a sun or settings change | 160-250 ms, once |

* **Quality:** the cumulus now uses 40 m raymarch steps (was 60 m), which removed the step hatching in large clouds. Scores are unchanged by the bake.

**Live check (app on 3330, isolated `SCRATCHBOX_HOME`):**
* The chat asked for a stone bench with sun 35° / azimuth 200 / 30% cumulus.
* The agent ran `build_3d_object_from_reference` and `atmosphere_configure_scene`; the scene data carries the sun and cloud cover.
* Orbiting under the bench shows the baked blue sky with cumulus. No console errors.
* Screenshot: `test-results/screenshots/sky_bake/live_app_bench_cumulus.jpg` (gitignored).

## 4. Second round (2026-10-21): typed clouds, spectral sky, calibrated decks

* **Clouds read per photo** (`scripts/sky-realism/annotate-clouds.ts`):
  * gemini-4-argon reads each cloudy reference once into a cumulus sky cover plus up to four physical shell decks;
  * readings are cached in `references.json` with model and date;
  * 33 of 34 are read. `kloofendal_overcast` timed out three times and is recorded as unread.

  The benchmark draws each reading instead of cumulus everywhere. Fog gradient error 0.81 → 0.31, overcast 0.83 → 0.48. Cloud bases on clear-sun skies: +38% → +11%. The excess was cirrus and altocumulus scored against cumulus, so base lighting was left alone.
* **Shell deck coverage = visible sky cover:**
  * density starts at the threshold (a sub-threshold veil made 2% coverage show as 17-34%);
  * a measured table maps coverage, as for the cumulus.
* **Spectral physical sky:**
  * 12 wavelengths, the 5778 K solar spectrum, CIE 1931;
  * sky colour pass 20% → 33% (default haze), 33% → 43% with typed clouds;
  * the high-sun zenith colour bias is halved.
* **`--fit-turbidity`:** haze fitted per photo from its own direct:diffuse. The "glow too wide" was mostly the default haze (photos fit T 1.1-2.9).
* **Backlit cumulus:**
  * forward bias of multiply scattered light fades with optical depth;
  * distant cloud merges into a soft bank.

  A debug pass (terms switched off one at a time) showed the golden backlit cores come from diffusion through small, optically thin cumulus. The benchmark's photos agree: clouds near the sun are not too bright (bias -0.14, i.e. slightly dark). A sharper droplet phase made no measurable difference and was not kept.

### Sun glare (`SunGlare.ts`)

* **Measured, not tuned by eye.** The radial profile round the sun in the 13 clear daytime photos, minus the sky, fits L/E = 4.2·θ^-2.5 per sr (θ in degrees). That is about 2.8% of the sun's energy, inside CIE eye glare (10·θ^-2). Photo/render ratio at 0.75-3°: 1.00, 0.99, 0.80, 0.72, 0.61.
* **Drawn** as a screen-space additive overlay scaled by the scene sun's light; `sunGlare` (default 1, 0 for none) scales it.
* **Occluded** by:
  * cloud: the baked sky at the sun against the cloudless disc;
  * geometry: a 16×16 probe through a frustum 1.2 discs wide, every 4 frames.

  A clay block slid across the sun gave visibility 0 / 0.5 / 1 (behind / edge / clear).
* **Not drawn** into cube captures (probes, the sky bake, the benchmark's panoramas).
* **Sun disc:** the dome disc was 0.89° in radius (3.3× too big). It is now the true 0.267°, and the grey marker sphere is hidden.
* **Limitation:** the probe draws alpha-tested leaves as solid quads.

## 5. Still open

* **Sky ~1.3x bright relative to the sun, with a 20-30% dark ring 45° from it.** Both persist with fitted haze. HDR lens glare in the photos adds light round the sun; separating it needs glare-free references (sky-scanner radiance data).
* **Low suns stay slightly warm** (dUV ~+0.01, 4 photos).
* **Readings that stack overlapping decks** over-cover (table_mountain_1). Cloud fraction from the read-then-draw path passes 50% (median 0.11).
* **Worst-frame spikes** while clouds drift (24-30 ms).

## 6. Candidate tool/service ideas

* **A scene-JSON loader hook for live checks.** There is no deterministic way to open a scene with a given atmosphere in the app without a chat turn (and its model calls).
* **A frame-time probe** in the viewport that works while the pane is hidden, using GPU timer queries rather than requestAnimationFrame.
