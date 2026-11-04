# Process: the location sky's cumulus, reshaped and relit

> **Recorded:** 2026-11-03
> **Status:** Verified (live, the Penn Station K-D district opened from disk, same cameras before and after; headless dome renders of the same weather). Not done: a photo benchmark run (`scripts/sky-realism/benchmark.ts`); a district frame-time check while clouds drift.
> **Tags:** `operate-scratchbox` `sky` `clouds` `cumulus` `location-weather`
> **Target Domain:** 3D Viewport / atmosphere (sky dome bake, cumulus raymarch)

---

## 1. Session Context

* **What prompted this session:** MAIN, after the Penn K-D renders (`2026-11-03-penn-kd-district-views.jpg`, views 2-4): the partly cloudy sky's clouds are crisp, cartoon-like puffs. The user, mid-session: "clouds still feel too solid".
* **Instance used:** own entry `scratchbox-viewer-shadows`, web `4260`, API `4261`, tools `4262`. The Penn artifact (`/Volumes/Scratchbox/kd-penn-smoke-20261103/artifact.json`, run 266b12eb) wrapped as a session in the worktree; its 99 GLBs (12.2 GB) symlinked, not copied. No build was run.
* **Scope tested:** the cumulus only, at the location weather (`LOCATION_SCENE_WEATHER`: cover 0.4, haze 0.2 as turbidity 3.6, density 0.46, sun 20° at azimuth 227°). The weather inputs are unchanged.

---

## 2. What Was Tested & What Worked (Verified)

* **Before and after** (sheet: `docs/screenshots/2026-11-03-clouds/clouds-before-after.jpg`, gitignored):
  * **Live viewport, Penn:**
    - **Street level on 7th Ave, looking uptown:** before, a scatter of small beige blobs; after, a few soft cumulus between the towers.
    - **110 m up over 7th Ave:** before, popcorn puffs with hard rims and flat shading; after, larger cumulus with flat grey bases, see-through frayed edges, and rows fading into haze toward the horizon.
  * **Headless dome, same weather** (four headings, 1600x800): the same change, plus backlit grey clouds with brighter rims toward the sun.
* **Sky cover kept:**
  - **Method:** the table that turns the requested sky cover into the layer's plan coverage was re-measured with the benchmark's `measureClouds`, on 512x256 dome panoramas (suns 25/45/65°, four cloud positions, 15 coverages, old and new shader). Each table row now gives the new cloud the cover the old one measured at that row.
  - **Result:** the location's 0.392 maps to a plan coverage of 0.497 (was 0.05). The new cloud's measure rises steadily to overcast; the old one stopped rising at 0.94.
* **Tests:** `sky-realism-benchmark`, `atmosphere-scattering-pipeline`, `cloud-shell-layers`, `atmosphere-service-apis`, `sun-glare` and `headless-scene-atmosphere` pass (56 tests); core typecheck clean.
* **Cost:**
  - **Full bake:** 2.7-3.4 s, was 1.2-1.6 s (headless, M-series). This is paid on load and on a weather change.
  - **While the clouds drift:** the refresh is now 16 strips a face, so each frame's strip stays near 30 ms, as before.

---

## 3. What Broke / Didn't Work

* **Tried and dropped:**
  - **Vertical shape frequency at half:** made pillars.
  - **Fine (25 m) turbulence:** read as fuzz.
  - **The cloud's fine structure in the sun march's first step:** cost without a visible change.
* **Remaining:**
  - A few small, bright fragments near the top of the layer still read as solid.
  - Cloud-on-cloud shadows show as darker patches on some bodies.
  - The full bake doubled.

---

## 4. Candidate Tool/Service Ideas

* **Sky-only render tool** — renders the scene's own sky from given headings at full resolution, before and after a shader change. This session wrote a scratch harness (esbuild + headless Chrome, as `sky-dome-equirect-renderer` does) to iterate in seconds instead of reloading a 12 GB district.
* **Coverage table re-measure command** — rebuilds `CUMULUS_SKY_COVER` from old and new renders. This session hand-rolled it.

---

## 5. Reproduction Steps

1. Wrap `artifact.json` as `desktop-app/.scratchbox/sessions/<id>.json` (`activeArtifact` and `artifactHistory` set to it) and symlink the `/models/` files it names into `public/models/`.
2. Start an instance, set `localStorage['scratchbox_studio_current_session_id_v18']`, reload, and wait for the layers to attach.
3. Cameras, with heading 29° along 7th Ave (`dir = (sin h, -cos h)`, `perp = (cos h, sin h)`):
   - **street:** at along -150, offset +42, y 24.7, pitched 20° up;
   - **air:** at along -260, offset +45, y 110, pitched 6° up.

   The timeline sits at 0 s, so the clouds do not drift between captures.
4. "Before" is `90e65beb`'s `AtmosphericSkyDome.ts` over the branch's.
