# Process: Grass split into spatial tiles so the viewer culls it, live

> **Recorded:** 2026-11-04
> **Status:** Verified live at Sheep Meadow: at eye level the viewer draws 1.86–2.03 M grass triangles instead of 3.83 M, with an identical picture (mean pixel difference 0.02 of 255)
> **Tags:** `operate-scratchbox` `grass` `instancing` `culling`
> **Target Domain:** Staged-location evidence tools (`location_grass_map` blades) / 3D viewport

---

## 1. Session Context

* **What prompted this session:** the user asked whether baking the grass into one or a few objects would cut the load. One merged object would not: the triangles drawn stay the same, and memory grows from about 8 MB of instancing to about 100 MB. Instead, each variant was one InstancedMesh spanning the whole band, which three.js can never frustum-cull. Splitting the band into a few spatial chunks can be culled.
* **Instance used:** web `3170`, API `3171`, tools `3172` (own launch entry, removed afterwards). Load under 100; Sheep Meadow freshly extracted.
* **Scope tested:** `location_grass_map` with the default `bladeChunkM` (30 m) and with `bladeChunkM: 0` (one node per variant). Same 150,000 clumps and 3.83 M instanced triangles in both. Measured with three's own frustum test on each InstancedMesh, and with `renderer.info` for the frame.

---

## 2. What Was Tested & What Worked (Verified)

* **`writeGrassFieldGlb`:** each variant's clump mesh is written once, plus one instancing node per (variant, 30 m tile) holding that tile's clumps. The tile is recorded in the node extras. Sheep Meadow: 304 nodes over 20 meshes, 9.3 MB.
* **Live measurements** (eye 1.7 m at the band centre):

  | View | One node per variant | 30 m tiles |
  |---|---|---|
  | Meadow | 3.83 M (60 calls) | 1.86 M (153 calls) |
  | Opposite way | 3.83 M (53 calls) | 2.00 M (148 calls) |
  | Side | 3.83 M (48 calls) | 2.03 M (145 calls) |
  | Aerial view of the whole band | 3.83 M | 3.83 M (420 calls) |

* Renderer totals for the frame: one node per variant 3.87–3.91 M; tiles 1.93–2.08 M.
* Proof sheet: `docs/screenshots/2026-11-04-grass-chunks-proof.png` (gitignored, local).

---

## 3. What Broke / Didn't Work

* Nothing broke. **Trade-off:** draw calls rise from about 50 to about 150 at eye level (WebGL handles this easily). The tiles around the camera hold the dense near ring and are always in view, so the saving at eye level is about half rather than more.

---

## 4. Candidate Tool/Service Ideas

* **Per-tile distance hiding:** the node extras already carry each tile, so the viewer could hide or swap tiles past a distance (to a baked card layer) as the camera moves.

---

## 5. Reproduction Steps

1. Start an instance; delete `public/models/sheep_meadow_*`.
2. Run `location_grass_map` with `{"query":"Sheep Meadow, Central Park, New York, NY","radiusMeters":160,"blades":true,"bladeBandRadiusM":120}`, then again with `"bladeChunkM":0`.
3. In the viewport, set the camera at eye height at the band centre and read `renderer.info.render.triangles` after a frame, looking each way.
