# Process: Denser grass for the same triangle budget, live

> **Recorded:** 2026-11-04
> **Status:** Verified live at Sheep Meadow (fresh extraction): 240 blades/m² near the viewer instead of 88, and 150,000 clumps instead of 60,000, both at 3.83 M triangles
> **Tags:** `operate-scratchbox` `grass` `instancing` `native-engine` `lod`
> **Target Domain:** Staged-location evidence tools (`location_grass_map` blades) / 3D viewport

---

## 1. Session Context

* **What prompted this session:** the user asked how to simulate denser grass with more blades. The answer that cost nothing extra: make the widened distant blades cheap (their curve is not seen) and spend the triangles saved on more blades near the viewer.
* **Instance used:** web `3170`, API `3171`, tools `3172` (own launch entry, removed afterwards). Run after the load average fell below 100; Sheep Meadow's stage outputs were deleted first.
* **Scope tested:** two `location_grass_map` runs, same seed and band, before and after. "Before" is the PR #111 defaults (`bladeDensityPerM2: 4`, `bladesPerClump: 22`, `bladeFarSegments: 5`, `bladeMaxClumps: 60000`); "after" is the new defaults. Captures at eye height from the band centre, 3 m and 12 m, with the camera held until it settles.

---

## 2. What Was Tested & What Worked (Verified)

* **`GrassClumpConfig.minSegments`** (default 4, so other callers are unchanged): the grass field sets it to 1, so the widened distant blades use `farSegmentsPerBlade` (default 2: 6 triangles a blade instead of 18).
* **New defaults:** 8 clumps/m² × 30 blades near the viewer (240 blades/m², was 88), with a 150,000-clump budget (was 60,000).
* **Tool:** `location_grass_map` takes `bladesPerClump`, `bladeSegments`, `bladeFarSegments` and `bladeMaxClumps`.
* **Live comparison:**

  | | Before | After |
  |---|---|---|
  | Clumps | 60,000 | 150,000 |
  | Reach | 86 m | 99 m |
  | Instanced triangles | 3.83 M | 3.83 M |

* **Pixel change vs grass off** (far / middle / near rows):

  | View | Before | After |
  |---|---|---|
  | 3 m | 6.6 / 3.1 / 0.9 | 9.5 / 5.2 / 2.3 |
  | 12 m | 7.1 / 3.1 / 1.4 | 10.7 / 5.1 / 2.8 |

* Proof sheet: `docs/screenshots/2026-11-04-grass-denser-proof.png` (gitignored, local).

---

## 3. What Broke / Didn't Work

* **The viewer eases the camera toward a set view.** A frame captured right after `__SB_SET_CAMERA_VIEW__` can be mid-move, so the first 3 m "off" frame and one 12 m frame were misaligned. Every compared frame was retaken after setting the view four times; sky rows then differ by 0.00.
* **Stale browser tabs.** Six old Browser-pane tabs, each holding a scene, left new scenes stuck loading. Closing them fixed it.
* **Open:** each variant is one InstancedMesh spanning the whole band, so frustum culling never drops any of it. Splitting the instances into spatial chunks would let the viewer skip off-screen grass.

---

## 4. Candidate Tool/Service Ideas

* **Spatially chunked instancing:** one InstancedMesh per (variant, ~25 m tile), so three.js frustum-culls the grass behind the viewer and per-chunk distance hiding becomes possible.
* **A viewport "settle then capture" call over HTTP,** in place of the hand-rolled settle loop.

---

## 5. Reproduction Steps

1. Start an instance; delete `public/models/sheep_meadow_*`.
2. Run `location_grass_map` with `{"query":"Sheep Meadow, Central Park, New York, NY","radiusMeters":160,"blades":true,"bladeBandRadiusM":120}`, then again with `bladeDensityPerM2: 4, bladesPerClump: 22, bladeFarSegments: 5, bladeMaxClumps: 60000` for the old look.
3. Compare at eye height from the centre, setting the view repeatedly until the camera stops moving.
