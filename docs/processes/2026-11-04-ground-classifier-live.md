# Process: District ground classifier (scan + photo + Google vector data) and the grass mask, live

> **Recorded:** 2026-11-04
> **Status:** Verified live (fresh extractions at Penn, Madison Sq, Bryant Park, Sheep Meadow); Penn's false grass removed, olive NYC lawns found
> **Tags:** `operate-scratchbox` `ground-classifier` `grass` `google-vector` `provenance` `penn-station`
> **Target Domain:** Staged-location evidence tools (`location_grass_map`) / district ground

---

## 1. Session Context

* **What prompted this session:** the Penn proof for PR #107 showed that every grass patch `detectGrass` found at Penn was a green object: a footbridge roof over the rail cut and a truck's green cab. Meanwhile, NYC park lawns were missed. The user asked to classify the ground with Google's vector data, extended into a classifier usable on any district area, so that as much ground as possible gets classified.
* **Instance used:** web `3170`, API `3171`, tools `3172` (own `scratchbox-grass-blades` entry in the worktree's launch file, removed afterwards). Stage outputs of all four places were deleted before the runs (fresh extractions; the raw Google leaf-tile cache was kept).
* **Scope tested:** `location_grass_map` through `POST /gemini/tools/run` at four places, with its new overlay PNG; offline reruns of the same steps for the measurements below.

---

## 2. What Was Tested & What Worked (Verified)

* **Diagnosis (measured, per-cell CIELAB of the tile photo):**
  * Penn's footbridge roof (L 65, a* −12.7, b* 10, hue 139°, texture 10.7) matches Sheep Meadow's lawn (L 55, a* −12.4, b* 10.8, hue 138°, texture 12.2) almost exactly, so colour and texture cannot separate them.
  * Google's vector data can: the bridge and the truck lie outside every Google park outline, in "urban area", next to road centrelines. Every real lawn lies inside a park outline.
  * NYC park lawns in these tiles are olive: Bryant's is a* −3.5, b* 21, hue 99°, so they failed the old `a* <= -5` test.
* **`ground-classifier.ts`** (new): for every 1 m cell of any district it fuses:
  * the scan's height above the terrain;
  * the photo's lit colour and texture;
  * Google's buildings, water and carriageways;
  * land-use priors (`ground-area-priors.ts`: data keyed by Google codes, read at the caller; parks say planted, parking lots and roads say paved, coarse Landsat/urban cover has no opinion).

  It outputs continuous scores (low vegetation, tree canopy, paved, water, building, raised structure) and a display-only label.
* **`detectGrass`** reads it: a vegetation hue window from olive to fresh green, times the area prior. Green open ground off every planted area, and green on paved ground, is held back, counted and drawn orange in the overlay.
* **Live results** (seen grass, before → after):

  | Place | Before | After | Held back off planted / on paved |
  |---|---|---|---|
  | Penn (7th Ave & W 32nd St) | 61 m² | 0 m² | 259 / 66 m² |
  | Madison Square Park | 44 m² | 878 m² | 251 / 501 m² |
  | Bryant Park | 3,023 m² | 3,504 m² | 243 / 655 m² |
  | Sheep Meadow | 39,214 m² | 39,198 m² | 1,343 / 526 m² (the park drives) |

  Proof sheet: `docs/screenshots/2026-11-04-ground-classifier-proof.png` (gitignored, local).
* **Height-less Google footprints over open ground.** Bryant Park's lawn lies inside a Google footprint with no height (the library stacks run beneath it); 5,513 m² of open terrain-level ground there. The classifier counts a footprint as building only where the scan shows something standing, and reports the rest (`openInFootprintM2`). Walls still get full clearance, because their cells stand tall.

---

## 3. What Broke / Didn't Work

* **Regression caught and fixed in-session:** a first version excluded every vector-footprint cell, which cut Bryant's lawn to 149 m². Fixed by the rule above.
* **Open:** the label map's "raised structure" is broad: everything standing 0.6–2 m that isn't vegetation-coloured (cars, kiosks, benches, hedges in shade). It is display-only and nothing branches on it, but it would need texture or height-shape terms to split further.
* **Open:** green lawns outside any Google park outline (private lawns, courtyards) are now held back unless an area carries a vegetation prior. That is visible as orange and counted, never silent.

---

## 4. Candidate Tool/Service Ideas

* **`location_ground_classify`:** expose the classifier on its own, returning the label raster and the per-label areas as a viewport layer. Today it is only reachable through `location_grass_map`.
* **More area priors as data:** Google's other land-use codes (playgrounds, sports fields, golf, cemetery, campus) can carry priors by adding entries to `GOOGLE_AREA_PRIORS`, with no code change.

---

## 5. Reproduction Steps

1. Start an instance on free ports (operate-scratchbox §2) and delete the place's `public/models/<place>_*` stage outputs.
2. `POST /gemini/tools/run` with `{"name":"location_grass_map","args":{"query":"7th Ave & W 32nd St, New York, NY","radiusMeters":250}}`.
3. Open `resultPayload.overlayPng` (green = grass, cyan = filled under crowns, orange = green held back); `resultPayload.ground.areaM2` gives the area per label.
