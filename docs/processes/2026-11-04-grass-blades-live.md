# Process: 3D grass blades over the district grass map (location_grass_map `blades`), live

> **Recorded:** 2026-11-04
> **Status:** Verified (live at Sheep Meadow, Madison Square Park, Bryant Park and Penn Station); two live bugs fixed during the session; mid-distance visibility is a known limit
> **Tags:** `operate-scratchbox` `grass` `instancing` `native-engine` `provenance` `penn-station`
> **Target Domain:** Gemini Agent Chat / 3D Viewport / staged-location evidence tools

---

## 1. Session Context

* **What prompted this session:** grow real 3D grass over the ground `detectGrass` marks as grass, as instanced meshes (not splats), near the camera only.
* **Instance used:** web port `3170`, API port `3171`, tools port `3172` (own `scratchbox-grass-blades` entry in the worktree's `.claude/launch.json`, removed afterwards).
* **Scope tested:** `location_grass_map` with `blades: true` through the tool route (`POST /gemini/tools/run`) and through the in-app chat, which mounted each result in the viewport; camera driven with `__SB_SET_CAMERA_VIEW__`, the blades layer toggled for before/after.

---

## 2. What Was Tested & What Worked (Verified)

* **Native field** (`scripts/grass_field.cpp` over `scratchbox_grass_field.hpp`, built by `compileNativeCached`): four `GrassClumpGenerator` clump variants, placed on blue-noise strata kept with each cell's confidence, inside a band, budget-capped nearest first. The GLB has one node per variant with `EXT_mesh_gpu_instancing` (`TRANSLATION`, `ROTATION`, `SCALE`, `_COLOR_0`, `_CONFIDENCE`). three.js loads it as `InstancedMesh` with `instanceColor` (checked in the scene graph: 4 meshes, counts summing to the report).
* **Sheep Meadow, Central Park** (r 160 m, band 120 m): 39,214 m² seen grass. The run reached the 60,000-instance budget at 80 m (43,980 farther clumps left out and reported). 59,973 clumps snapped to the scan surface, 27 left on the estimate. Dense setting (14/m², 10–22 cm, band 40 m): 55,221 clumps, 21.9 M instanced triangles, rendered interactively.
* **Bryant Park** (r 180): 3,036 clumps, 481 kept clear of the vector building (the library) and water.
* **Madison Square Park** (r 150): 9,968 clumps. In the viewport, 209 of 229 sampled clumps lie within 5 cm of the tile surface (raycast down).
* **Penn Station, 7th Ave & W 32nd St** (district test place, r 250): 81 m² of grass in the whole area, so 38 clumps on the nearest patch, 106 m from the place. The band recentres on the nearest grass and says so.
* Each run took about 17–30 s with tiles cached.

Proof sheet: `docs/screenshots/2026-11-04-grass-blades-proof.png` (gitignored; sent in the PR thread).

---

## 3. What Broke / Didn't Work

* **Blades buried under crowns (fixed).** Mask-2 cells (grass filled in under park crowns) used the ground model's smooth terrain, which lay about 0.4 m (median) under the tile's real ground. Raycasts from the viewport showed no clump open to the sky at Bryant Park. Fix: each clump stands on the scan's own surface nearest the cell estimate (within 0.75 m, measured), and the estimate under crowns is the terrain plus the rise of the nearest seen ground.
* **White blades (fixed).** Under-crown patches that touch no seen grass got no photo colour, and the native code fell back to a white tint. Fix: the nearest seen grass colour is carried over any ground.
* **Mid-distance visibility (open).** Blades 4–5 mm wide fall under a pixel at about 10 m, so at that distance the field looks like the tile photo alone. Needs a distance treatment (wider far blades or cards), not more instances.
* **Grass detection misses many NYC lawns (open, upstream of this work).** Madison Square Park has 44 m² read green and Bryant Park little near its centre. Their lawns fail the colour test in these tiles (`notGreen`). The blades follow the mask faithfully, so they show up sparse and shade-tinted under the crowns.

---

## 4. Candidate Tool/Service Ideas

* **Viewport layer toggle over HTTP:** show or hide a mounted object and render a frame on demand. This session toggled `visible` through `javascript_tool` and called `__SB_3D_RENDER_FRAME__` by hand to get before/after pairs.
* **Tool-run result → open in viewport:** the `/gemini/tools/run` route returns an artifact but does not mount it, so the live view needed a chat turn (a billed model call) just to open it.

---

## 5. Reproduction Steps

1. Start an instance on free ports (operate-scratchbox §2).
2. `POST /gemini/tools/run` with `{"name":"location_grass_map","args":{"query":"Sheep Meadow, Central Park, New York, NY","radiusMeters":160,"blades":true,"bladeBandRadiusM":120}}`, or ask the chat for it to have the scene mounted.
3. In the viewport: `__SB_SET_CAMERA_VIEW__([0,0.45,1],{theta:0.4,phi:1.3,distance:3.2})`, then toggle the `external-object-grass-blades-*` group.
