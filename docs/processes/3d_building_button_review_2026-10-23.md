# Process: The 3D Building button, tested live, and what the pipeline G run records say

> **Recorded:** 2026-10-23
> **Status:** Verified (two live runs in the app; one regression found and fixed; the rerun's result is in §2)
> **Tags:** `operate-scratchbox` `staged-location` `pipeline-g` `footprint-lock` `starter-buttons` `geocoding` `solar-api`
> **Target Domain:** Real-world 3D locations (isolated structure) / Studio new-chat page / 3D Viewport

---

## 1. Session Context

* **What prompted this session:** the user asked for the front-page 3D Building button to be tested and reviewed, with feedback on how to write the pipeline for the best results.
* **Instance used:** web port `3100`, API `3101`, tools `3102` (`scratchbox-asset-store` entry, worktree `asset-store`, dist rebuilt from main at `4526ea4e` and again after the fix below).
* **Scope:** the button's random prompt (it drew Fallingwater), then the Flatiron prompt typed by hand, each followed through `.scratchbox/cache/staged_location/runs/<id>/` (timeline, `pipeline_e.json`, `pipeline_g.json`), plus the records of the five pipeline G runs already on disk from earlier today.

---

## 2. What Was Tested & What Worked (Verified)

* **Button → prompt → tool.** New Chat → 3D Building sent the Fallingwater prompt; the model called `google_3d_tiles_get_clay` with `{ isolate, trees, procedural }` within 5 s. Routing is fine.
* **Fallingwater (run a44d2ee7, 8 min 13 s, degraded).** Screenshot `docs/screenshots/3d_building_button_2026-10-23/01_fallingwater_district_fallback.jpg`: a 300 m textured district of forested hillside, no house. See §3.
* **Flatiron before the fix (run 7b928a5b, 10 min 23 s, degraded).** The textured remeshed scan of the Flatiron (which reads well on its own: `02_flatiron_scan_fallback.jpg`), but pipeline G never ran. See §3.
* **Flatiron after the fix (run 92f97642).** Filled in below once the run completes.

---

## 3. What Broke / Didn't Work

### 3.1 Fallingwater: the geocode, not the data

* Places resolves "Fallingwater, Mill Run, Pennsylvania" to the road address (1491 Mill Run Rd), **116 m from the house**. The vector stage searches `VECTOR_ISOLATE_RADIUS_M = 40` m around that point and found nothing; the structure pick seeds on the tallest thing within `STRUCTURE_SEED_SEARCH_M = 30` m, which on a wooded slope is canopy/terrain, and grew the component past the 150 m cap (`containment_failed`).
* The data is there: a direct `fetchVectorEvidence` probe at the geocode with 200 m found 7 buildings, among them a 53 × 53 m, 6.5 m part 100 m west (the house) and the nearest building at **42 m** (just outside 40 m).
* So the "no data → build procedurally" rule would not have applied; the pipeline looked in the wrong place. Fixes to make (not done here):
  1. when the vector search finds nothing within 40 m, widen to the extraction radius (the orchestrator already widens the structure seed search to the extraction radius after a miss; the vector radius should follow);
  2. prefer the Places result whose type is the landmark itself over its street address (`alternatives` is already carried on `ResolvedPlace`);
  3. seed the structure pick on the nearest vector building to the geocode when one exists, instead of the nearest tall cell.

### 3.2 Flatiron: a regression from this morning's footprint lock

* Same cached vector and tiles as yesterday's successful G run (cfdd1825: massing check IoU 0.93, roof 2.42 m off, 4 stepped tiers, then G built 179 elements). Today the massing failed its own check: **roof 22.87 m off the scan at the median (13.31 m allowed)**, so `pipeline_e_fallback` → G unavailable → the old pipeline, where scan_fit timed out (30 s), the lattice grammar missed its chamfer threshold by 0.02 px and the texture pass timed out (600 s).
* Cause: commit `3942f130` (the footprint lock, 10:56 today) made a procedural build take the Solar API's height first "even where the scan disagrees" and keep **every** pitched Solar facet as a roof plane "as measured". The Flatiron's Solar data has 12 pitched facets around its roof penthouse; as planes over a 1,300 m² plan they slope the roof 23 m off. Yesterday's code rejected them (each facet had to lower the roof error).
* Fix (this session, `massing-spec.ts`, tests in `footprint-lock.test.ts`): under the lock the scan leads: Solar's height only within `HEIGHT_AGREEMENT_M` of the scan's, else the vector height if that agrees, else the scan's own (said in the notes); a Solar facet is kept only when it raises neither the median nor the mean roof error against the scan. The gentle-facet-as-flat rule (`LOCK_FLAT_BELOW_PITCH_DEG`) and the footprint lock itself are unchanged. User decision 2026-10-23: vector and Solar data are guidance, useful where present and in agreement.

### 3.3 What the earlier pipeline G records show (runs 245b6c58 Haughwout, 043baf17 Capitol, 2f837466 Guaranty, cfdd1825 Flatiron)

* **Openings lost silently.** Flatiron: 678 openings read, **583 rejected by the native tool** (280 from one grouped facade). `scratchbox_staged_massing.hpp` rejects an opening only when it lies outside its wall, above the wall top, or overlaps another opening on the face; the step note says "rejected by the native tool" with no reason. The "continue the wall's own repeats into unseen parts" instruction in the reading prompt is the likely source of overlapping duplicates (348 of the 678 were continued).
* **Weak readings kept.** Flatiron walls 4:1 and fg:0 explained 1–2% of their plate (the check's calibration: a wall that built as a blank box explained 0.1–4%), were re-read, and the first reading kept anyway.
* **Coverage limits.** Capitol: 3 of 6 walls read; three faces had no Google panorama on their outward side. Guaranty: 0 of 3 facade textures accepted; Haughwout: 2 of 5. Roof objects: Flatiron 0 of 100 clusters, Capitol 4 of 34 (all "unsure, kept as built").

---

## 4. Candidate Tool/Service Ideas

* **Vector search radius follows the extraction radius** (§3.1.1), and a `resolve` that prefers the landmark's own Places result.
* **Massing check failure on a procedural request retries from the scan's plan** (`scanDerivedFootprint`) before falling back to the old pipeline: the vector massing is guidance, the scan is what is there.
* **Native rejection reasons per opening** (outside wall / above top / overlap) in the native tool's JSON, surfaced in the `native build` step, so continuation errors are visible.
* **Continuation dedupe before the build:** continued openings that overlap a read opening or another continuation on the same face are dropped in TypeScript, not left to the native tool.
* **Per-wall read gate:** a reading that explains under 5% of its plate after the re-read should fall to the median-colour wall (generated) rather than build a lattice nobody saw.
* **Run summary in chat names the first cause.** The chat's finish summary lists eight degraded stages for the Flatiron; the first one (the massing check) is the only cause. Lead with it.

---

## 5. Reproduction Steps

1. `preview_start({name: "scratchbox-asset-store"})`, open the token URL from its log.
2. New Chat → 3D Building (random prompt), or type the Flatiron prompt from `starterPrompts.ts`.
3. Follow `.scratchbox/cache/staged_location/runs/<id>/timeline.jsonl`; `pipeline_e.json` holds the massing check; `pipeline_g.json` the G steps; the massing itself in `.scratchbox/cache/staged_location/pipeline_e/<key>/massing.json` (`check`, `solar`, `notes`).
4. For the geocode probe: `fetchVectorEvidence({ lat, lng, radiusM: 200, fetchTile: GoogleVectorTileService.fetchVectorTile })` under `ts-node -P desktop-app/tsconfig.electron.json` with `secrets.json` in the env.
