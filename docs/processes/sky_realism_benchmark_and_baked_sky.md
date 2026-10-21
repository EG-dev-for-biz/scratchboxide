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

## 4. Still open

* **Cloud bases** are ~30% too bright on the few clear-sun cloudy references (3-5 skies, noisy).
* **Backlit clouds** toward a low sun are too evenly cream.
* **Horizon:** a band of small distant clouds sits along it.
* **The glow round the sun** is too wide (~40° against 10-15° in photos).
* **Low-sun sky colour** is lavender where real skies are teal.
* **Cloud type per reference:** most "partly cloudy" references are cirrus or stratocumulus. The benchmark always draws cumulus; it should pick the shell decks for those.
* **Worst-frame spikes** while clouds drift (24-30 ms).

## 5. Candidate tool/service ideas

* **A scene-JSON loader hook for live checks.** There is no deterministic way to open a scene with a given atmosphere in the app without a chat turn (and its model calls).
* **A frame-time probe** in the viewport that works while the pane is hidden, using GPU timer queries rather than requestAnimationFrame.
