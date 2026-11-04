# Process: Grass blades widened ring by ring with distance, live

> **Recorded:** 2026-11-04
> **Status:** Verified live at Sheep Meadow (one ring vs rings at two pixel angles, same placement); far grass reads 2.3–2.8x stronger with the pixel angle matched to the view, at 7x fewer triangles
> **Tags:** `operate-scratchbox` `grass` `instancing` `native-engine` `lod`
> **Target Domain:** Staged-location evidence tools (`location_grass_map` blades) / 3D viewport

---

## 1. Session Context

* **What prompted this session:** after PR #107, blades 4–5 mm wide fell under a pixel about 10 m out, so the band's far part looked like the tile photo alone.
* **Instance used:** web `3170`, API `3171`, tools `3172` (own launch entry, removed afterwards). Sheep Meadow was freshly extracted.
* **Scope tested:** `location_grass_map` with `blades: true`, `bladeBandRadiusM: 120`, and `bladePixelAngle` 0 (one ring, the old behaviour), 0.0015 (default) and 0.0035. Viewport at eye height 1.7 m from the band centre, looking at ground 3, 12 and 30 m away, grass off and on.

---

## 2. What Was Tested & What Worked (Verified)

* **Native rings** (`scratchbox_grass_field.hpp`):
  * Clump variants are built per distance ring. In ring r the blades are 2^r wider and fewer per clump, so coverage per clump holds.
  * r is the doubling that brings a blade to pixel angle × distance from the centre, capped at 16×.
  * Clearance from buildings and water is per ring; every GLB node carries its ring and blade width scale.
* **Same 60,000 clumps (reached 86 m at the budget):**

  | Setting | Instanced triangles | Pixel change vs grass off, just under the horizon (12 m view / 30 m view) |
  |---|---|---|
  | one ring | 23.8 M | 5.7 / 6.2 |
  | rings @0.0015 | 3.8 M | 7.3 / 7.8 |
  | rings @0.0035 | 3.3 M | 12.9 / 10.6 |

* Near the viewer (ring 0) nothing changes; the 3 m views agree within the renderer's temporal jitter.
* Proof sheet: `docs/screenshots/2026-11-04-grass-distance-proof.png` (gitignored, local).

---

## 3. What Broke / Didn't Work

* **The pixel angle has to follow the viewer.** The default 0.0015 rad is about a pixel on a ~1000 px tall 60° view. This pane was ~470 px tall (about 0.0035 rad a pixel), where the default gives only a modest gain. The viewport's own size is not known to the tool, so the value is a parameter.
* **The rings centre on the band centre,** not the live camera; a viewer far from the centre sees widened blades near them. Re-running the tool around a new centre moves the rings.

---

## 4. Candidate Tool/Service Ideas

* **Viewer-driven pixel angle:** the viewport could pass its vertical field of view and height when it mounts a grass layer, or re-request the field around the camera when it moves far from the centre.
* **Viewport capture with layer toggles over HTTP:** this session toggled the layer and rendered frames through `javascript_tool` to get the A/B pairs.

---

## 5. Reproduction Steps

1. Start an instance; delete `public/models/sheep_meadow_*`.
2. Run `location_grass_map` with `{"query":"Sheep Meadow, Central Park, New York, NY","radiusMeters":160,"blades":true,"bladeBandRadiusM":120,"bladePixelAngle":0.0035}` (and `0` for the old behaviour).
3. Open the scene, place the camera at the centre at eye height, and compare the blades layer on and off at 12 m and 30 m.
