# Process: The scene weather draws Blender's multiple-scattering sky (vendored, MIT), old against new at Penn Station

> **Recorded:** 2026-11-07
> **Status:** Verified (live viewport, 4 suns x 2 models, Penn Station); unit tests and typecheck clean
> **Tags:** `operate-scratchbox` `sky` `scene-weather` `vendoring` `native-engine`
> **Target Domain:** Generative Canvas / 3D Viewport (atmosphere)

---

## 1. Session Context

* **What prompted this session:** vendor Blender's multiple-scattering sky (`intern/sky/source/sky_multiple_scattering.cpp`, MIT) into the native engine and use it for the scene weather's sky. Real places open under a 20° sun (user decision 2026-11-02), where the higher orders of scattering set the sky's and the light's colour.
* **Instance used:** web port `3240`, API port `3241`, tools port `3242` (own `scratchbox-vendor-sky` launch entry).
* **Scope tested:** the weather's sky config (`skyModel: 'multiple-scattering'`) reaching the dome, the dome fetching the native table (`GET /api/sky/multiple-scattering`) and redrawing from it, at sun 20°, 5°, 0° and -4°.

---

## 2. What Was Tested & What Worked (Verified)

* **The route** — `fetch('/api/sky/multiple-scattering?sunElevationDeg=20&turbidity=3.6')` from the page → `success: true`, a 64 x 48 table, sun transmittance `[0.462, 0.349, 0.196]`, level-surface sky irradiance `[0.095, 0.098, 0.108]` (per unit top-of-air solar luminance). The server warm-up logged `weather sky (multiple scattering): ready (0.3 s)`.
* **Old against new in the viewport** — the saved "3D scene of Penn Station NY" (geoAnchor 40.750568, -73.993519; clay scan) was given the location weather (cloud 0.4, haze 0.2) on 2026-11-07 by `applySceneWeather` at the times the ephemeris puts the sun at 20°, 5°, 0° and -4° (14:38, 16:16, 16:45, 17:07 local mean solar time). The "old" copy of each had `skyModel` removed (what `main` writes). Each was opened in the viewport and captured with `__scratchbox_capture_active_3d_scene` looking toward and away from the sun. The network log shows one `200` per sun (`sunElevationDeg=20.00, 0.00, 5.00, -4.00`, the 0° also being the dome's sunset anchor); no `[sky]` error in the console.
* **What the sheet shows:**
  * away from the sun the new sky is bluer at every sun; toward the sun at 20° and 5° the circumsolar glow is about as white as the old one's;
  * at 0° the new sky is bluer overhead with a pale lilac horizon toward the sun, its warm band weaker than the old sky's;
  * at -4° the new sky is a deep twilight blue where the old one is near-black grey: the higher orders light the sky after sunset;
  * at 20° the new sky's light is bluer, so the daylight white balance (`daylightWhiteBalance`) warms the lights and the clay reads warmer and darker grey than under the old sky.
* **Unit tests** (Node 22.18, empty HOME, credential variables unset): `sky-multiple-scattering.test.ts` (10), `sky-dome-multiple-scattering.test.ts` (3), `scene-weather.test.ts` (14), `sky-white-balance.test.ts` (3), `atmosphere-scattering-pipeline.test.ts` (1) all pass. `npm run typecheck` exits 0.

---

## 3. What Broke / Didn't Work

* Nothing failed in the session.
* Not checked live: the Weather tool's "Off" button. It is covered by `scene-weather.test.ts`: `clearSceneWeather` drops the whole weather sky config, `skyModel` with it, and restores the studio.

---

## 4. Notes

* Scenes saved with a weather before this change have no `skyModel` and keep the spectral sky until their weather is set again. Nothing rewrites saved scenes.
* The first frame of a weather sky draws the spectral table. The native table (about 4 ms native, one HTTP round trip) replaces it and relights the scene. If the native sky fails, the dome keeps the spectral sky, names it (`skyModel: 'spectral'`, `skyModelError`) and logs the reason.
* The upstream model fixes the ground albedo at 0.3 and the aerosol anisotropy at 0.8; they are not exposed.

---

## 5. Candidate Tool/Service Ideas

* **Open a scene JSON in the viewport without a chat:** the proof needed hand-written session files under `desktop-app/.scratchbox/sessions` to put eight scene variants in the app. A dev route or `window.__SB_OPEN_SCENE__(data)` would make A/B renders a one-liner.
* **Expose the dome's model state:** `skyModel` / `skyModelError` live on the dome module, which `Scene3DPrimitive` does not publish on `window`. Publishing it alongside `__SB_3D_SCENE__` would let checks confirm which sky drew a frame directly, not only from the network log.
