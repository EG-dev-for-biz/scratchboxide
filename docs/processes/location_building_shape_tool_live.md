# Process: location_building_shape — Google footprint, vector height, Solar DSM and roof segments in one agent tool

> **Recorded:** 2026-10-19
> **Status:** Verified
> **Tags:** `operate-scratchbox` `google-vector-data` `solar-api` `location-evidence` `agent-tools`
> **Target Domain:** Gemini Agent Chat / real-world locations

---

## 1. Session Context

* **What prompted this session:** exposing `building-shape-fusion.ts`, Google Vector Tiles (featuretiles) and the Solar API (DSM and buildingInsights) as the in-app agent tool `location_building_shape` (domain pack `tools/location-evidence-tools.ts`, implementation `tools/location-evidence/building-shape.ts`).
* **Instance used:** web port `3092`, API port `3091`, tools port `3093` (started from the `tool-building-shape` worktree with the same env vars as the `scratchbox-dev` entry; stopped by PID afterwards).
* **Scope tested:** two agent prompts that call the tool, plus a direct run of the same pipeline for the overlay images.

---

## 2. What Was Tested & What Worked (Verified)

* **Puck Building, 295 Lafayette St, New York** (neighbourRadiusMeters 30, writeMassingGlb) — the agent called the tool (3.7 s) and returned: footprint `extruded_area`, 6 parts joined across 4 zoom-17 tiles, 2296.5 m2, containing the geocoded point; vector extruded top 39.03 m (parts 39.03 / 32.98 / 29.98 m); Solar DSM main roof 42.06 m and highest point 50.0 m above a 12.28 m street measured on nearby roads (imagery 2023-06-18); Solar roof planes up to 45.29 m (77 segments in the footprint); the vector and DSM DISAGREE by 6.94 m on part f89/e0 (tolerance 3 m), stated and not averaged; 14 neighbours within 30 m of the footprint; massing GLB written. Evidence: `test-results/screenshots/tool_building_shape/inapp_puck_building_result_card.jpg`; overlay `puck_building_footprint_on_ortho.png` (orange footprint sits on the Puck block in the Map Tiles API satellite ortho; neighbours sit on their buildings).
* **Pulteney Bridge, Bath** — the agent called the tool, which failed with code `no_footprint`: "No building footprint in Google's vector data contains Pulteney Bridge, Bridge St, Bath BA2 4AT, UK or lies within 12 m of it; the nearest is 23.4 m away (17/64677/43657/f90). No footprint is invented for it." The five nearest footprints are listed with their rings. Evidence: `inapp_pulteney_bridge_no_footprint_card.jpg`; overlay `pulteney_bridge_no_footprint_on_ortho.png` (no footprint on the bridge; the nearest are the buildings beyond each bank).

---

## 3. What Broke / Didn't Work

* **Vector-tile decoder (fixed in this session)** — the first overlay showed rectangles as triangles. `google-feature-tile-decoder.ts` dropped vertex 0 of every `TRIANGLE_FAN` as a fan centre; in the real SoHo tiles all 512 fans' triangles sum to the polygon through every vertex, and vertex 0 lies outside the others in 419. Fixed (vertex 0 kept); synthetic test fans that carried an invented centre now list their corners.
* **Console** — the restored older chats in this profile request models that 404 (`Failed to load resource: 404`); unrelated to this tool.

---

## 4. Candidate Tool/Service Ideas

* A top-down ortho overlay of a footprint result (Map Tiles API satellite, or the 3D Tiles ortho) as a tool output, so the footprint can be checked without a separate script.
