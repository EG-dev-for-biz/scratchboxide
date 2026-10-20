# Process: Staged trees read 883 km tall — quantised GLB reader fix and impossible-bounds guard

> **Recorded:** 2026-10-19
> **Status:** Verified
> **Tags:** `operate-scratchbox` `staged-location` `trees` `object-placement` `glb-reader`
> **Target Domain:** Staged locations / build_3d_object_from_reference placement

---

## 1. Session Context

* **What prompted this session:** staging an object at the E.V. Haughwout Building (488 Broadway, NYC) with trees on failed: placement read the vegetation layer `stg-257114f6-l5` as reaching 883,679 m, so no spot was clear. With `trees: false` it worked.
* **Instance used:** web port `3075`, API port `3076`, tools port `3077` (a `scratchbox-trees-bounds` entry in `.claude/launch.json`, not committed).
* **Scope tested:** the trees layer the staged build writes at Haughwout, how placement reads it, and an object build at that place with trees on.

---

## 2. Root cause

The trees GLB was sound. The shared reader `glbToTriangleSoup` (`packages/core/src/node/3d-engine/part-connectivity.ts`), which placement's `SurfaceSampler` uses, read accessors without applying glTF normalisation. Staged trees are written with KHR_mesh_quantization (`scratchbox_staged_glb.hpp`): positions are normalised SHORT inside a node scale equal to the node's half extent. Read as raw integers, every vertex lands up to 32767 times too far out. The reader also drew EXT_mesh_gpu_instancing meshes once at the node instead of once per instance.

Not the cause: a broken tree, NaN or Inf, the writer's accessor min/max, or a stale cache across schema changes. The stage key `257114f6…` is the same in a fresh worktree with an empty cache: the build is deterministic, and the file it produces is correct.

Measured on the Haughwout trees layer staged live in this session (`e_v_haughwout_building_488_broadway_new__trees_257114f6.glb`, 9.1 MB):

| Reader | Triangles | Y range |
|---|---|---|
| old `glbToTriangleSoup` | 830,044 | −899,071 m … +899,119 m |
| fixed, instances skipped (placement on vegetation) | 284,652 | −5.50 m … 51.52 m |
| fixed, instances expanded | 38,817,098 | −5.50 m … 51.98 m |
| `glbWorldBounds` (instances included) | — | −5.50 m … 52.33 m |

Expanding every leaf instance is far too heavy for placement (38.8 M triangles here; 409 M triangles and 13.8 GB RSS for the largest cached district). Placement therefore leaves instanced meshes out on vegetation layers. Those meshes are the leaf clusters of levels 0–2, which lie inside the far level's crown masses, and placement still reads the masses. The crown top changes by under 0.5 m.

---

## 3. What changed

* `readAccessor` applies normalisation, and vertex colours are no longer divided twice. Instanced meshes are expanded by default, or left out with `instances: 'skip'`. `glbWorldBounds` gives true world bounds, instances included, without building a soup.
* `layer-bounds-guard.ts` (`implausibleLayerBounds`): a staged layer must be finite, within 9 km of the anchor in height and within 50 km horizontally.
* `TileVegetationService.plant`: if a cached trees entry has impossible bounds, it is deleted and rebuilt once, and `rebuiltStaleCache` says why (shown as stage progress). A fresh build with impossible bounds fails as `plant_failed`, and the stage then puts the scanned trees back, saying why.
* Placement refuses a staged layer with impossible bounds, naming the layer and the reason, instead of reading it as covering every spot.

---

## 4. What Was Tested & What Worked

* **Staging with trees on, live** — I asked the agent: "Build a 3D bronze bench standing on the sidewalk in front of the E.V. Haughwout Building, 488 Broadway, New York, with the street trees included (trees on)". → `google_3d_tiles_get_clay` staged the place in 303 s. Trees committed as `stg-257114f6-l5` (112 of 112 crowns regrown, 150,158 triangles), the same layer id as the original failure. The facade grammar degraded on 7 of 12 facades, which is unrelated to this fix.
* **Placement against that layer** — the first `build_3d_object_from_reference` call failed after its build. That was a real clash, not the trees: the bench, at 16 m west and 1.2 m north of the anchor, would have passed through the remeshed building wall (`stg-3d6343d9-l2`, rising 24.07 m above it). The tool named three clear spots. The agent rebuilt from the spec at the first one: 16 m west, 3 m north, heading 295°, standing on the ground at −0.864 m. The result says the bench was checked clear of walls, tree trunks and crowns across its footprint at 0.03 m. No layer was refused for its bounds.
* **The layer read by the old and fixed readers** — see the table in section 2: ±899 km before the fix, −5.5 m to 52 m after it.
* **Viewport** — screenshots `docs/screenshots/haughwout_trees_on_{district,street}.jpg` (gitignored) show the street trees at real size along the streets around the building. The browser console logged no errors and the server log showed no errors.

Tests (run through the guarded vitest wrapper, exit 0): `trees-layer-bounds.test.ts` (4 tests, real native-planted trees), plus `object-reference-tool.test.ts` (53), `part-connectivity.test.ts`, `tile-vegetation.test.ts` and `tile-vegetation-lod.test.ts`. Together that is 83 tests in those four existing suites. `npm run typecheck`, `npm run lint` (0 errors) and `npm run lint:primitives` pass. Screenshots: `test-results/screenshots/trees_layer_bounds_{top,aerial}.png` (gitignored).

---

## 5. What Broke / Didn't Work

* **Object framing after a placed build** — the agent's closing visual check scored 38/100: the scene camera opened against a surface and hid the bench. This is unrelated to the trees fix and was not investigated; I had to zoom out by hand to see the district.
* Nothing else broke. The staging cache in this worktree was empty, so a cached entry was never refused live; the stale-cache rebuild is covered by `trees-layer-bounds.test.ts` instead.

---

## 6. Candidate Tool/Service Ideas

* **Layer bounds in the staging result** — report each committed layer's world bounds (from `glbWorldBounds`) in the stage event, so the 883 km reading would have been visible in the staging card instead of only in a placement failure.
* **One GLB reader** — `part-connectivity`, `tile-texture-transfer` and `test/helpers/clay-glb-render` each have their own accessor reader. Only the texture pass's reader handled normalisation and instancing. A single shared reader would stop such fixes drifting apart.

---

## 7. Reproduction Steps

1. In a worktree from origin/main, add a launch entry on free ports and link `secrets.json`.
2. Ask: "Build a 3D bronze bench standing on the sidewalk in front of the E.V. Haughwout Building, 488 Broadway, New York, with the street trees included (trees on)."
3. The trees layer is `…_trees_257114f6.glb`. Read it with `glbToTriangleSoup`: its Y range is −5.5 m … 52 m with the fix, and ±899 km before it.
