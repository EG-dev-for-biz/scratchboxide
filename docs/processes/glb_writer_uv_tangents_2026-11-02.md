# The native GLB writer's tangents on normal-mapped meshes

**Date:** 2026-11-02
**Status:** fixed and verified. The writer now gives every normal-mapped sub-mesh tangents that follow its UVs, wherever
the producer left the `Vertex` placeholder. On every corner that MikkTSpace's own assumption holds for, they match
MikkTSpace exactly. A three.js render of the SB-Veggie tree and of a bark column built against the old and new headers
shows that the old placeholder lit the normal map in the wrong frame and the new tangents light it as MikkTSpace does.
**Code:** `ScratchboxMesh::computeUvTangents` (`scratchbox_geometry.hpp`); `GlbWriter::serializeToGlb` and
`serializeMultiMeshToGlb` (`scratchbox_io.hpp`); `uv::generateMikkTSpaceTangents` now calls the same routine.
**Test:** `packages/core/test/glb-uv-tangents.test.ts`.

## The problem

`geometry::Vertex` defaults its tangent to (1,0,0,1), and the writer wrote `TANGENT` as given. Most producers never set
tangents. Their normal textures were therefore lit in a frame that ignored the UVs. Wherever a surface faces ±x, the
placeholder tangent is parallel to the normal, so three.js's TBN collapses and the normal map either does nothing or
turns inside out there. On 2026-11-02 the forest generator was the one found (its own fix, `computeTangents`, is commit
`ae720963` on `claude/elated-wright-2b37e5`). A sweep of `TextureUsage::NORMAL`, `normalTexture` and `.tangent` across
`packages/core/src/native` and `scripts/*.cpp` found the rest.

| Producer | Writer | Normal map | Tangents set? |
| :--- | :--- | :--- | :--- |
| `scratchbox_botanical_texture.hpp` (bark, foliage; `scripts/run_sb_veggie.cpp`, `run_smpl_tree.cpp`) | `serializeMultiMeshToGlb` | by target name | no |
| `scratchbox_tile_cleanup.hpp` `createGlbTextures` (texture-informed facades) | either | `NORMAL` | no |
| `scripts/generate_empire_state_building.cpp`, `generate_rectified_esb_architectural_hybrid.cpp`, `build_omnispatial_master_models.cpp` | `writeMultiMeshToFile` | per material | no |
| `scripts/generate_forest_procedural_3d.cpp` (main) | `serializeMultiMeshToGlb` | photo maps | no (fixed on its own branch) |
| `bindings/python_bindings.cpp` `write_glb_textured` | `serializeMultiMeshToGlb` | `"normal"` | caller's |
| `scratchbox_uv_engine.hpp` (preserve-UV path) | caller's | caller's | yes, with the old routine's handedness (below) |
| `scratchbox_photometric_relief.hpp` | its own writer | `normalTexture` | writes no `TANGENT`: the viewer derives them, as glTF allows |

The skinned, instanced and LOD writers take no textures and so never write a normal texture.

## The fix

**One routine:** `ScratchboxMesh::computeUvTangents(onlyPlaceholders)`, in glTF's convention:
- xyz runs along +u: each triangle's dP/du, weighted by its corner angle and made perpendicular to the normal;
- w is the sign that makes cross(N, T)·w point up the image (decreasing glTF v), as glTF's +Y-up normal textures need.

At each vertex only the triangles whose UVs run the way most of the vertex's surface does count. The vote is weighted
by corner angle times the surface area each triangle maps per unit of UV. This was needed because SB-Veggie's tube
rings wrap u from (n-1)/n back to 0 without a seam vertex: a first version that counted every triangle let the
wrapped strip cancel its neighbours' frames at the shared vertices, and the trunk's tangents disagreed with three.js's
own. With the vote, 99.5% of the trunk's corners (on triangles running the majority way) have T along their own
triangle's +u. A vertex with no UV gradient gets a tangent perpendicular to its normal, with w = +1.

**The writer:**
- `serializeToGlb` (and so `writeToFile` and `streamChunk`): when any texture is `NORMAL`, it computes tangents on a copy
  of the mesh.
- `serializeMultiMeshToGlb` (and so `writeMultiMeshToFile` and the Python binding): it computes tangents for each
  sub-mesh that a `NORMAL` texture applies to.
- In both, only vertices still at the placeholder are written. Tangents a producer set are kept bit for bit.
- The texture-to-sub-mesh matching, by material index or by target name, moved into `GlbWriter::textureAppliesTo`, so
  the tangent pass and the material writer read the same rule.

**`uv::generateMikkTSpaceTangents`** had the opposite handedness: its w pointed the bitangent along +v, which is image
down in glTF. It now calls `computeUvTangents`, so the engine has one tangent routine and one convention. The existing
gaps test, which checks unit length, |w| = 1 and orthogonality, still passes.

A correct tangent can itself be (1,0,0,1). This happens on a face whose normal is +y or +z, with u along +x and v
running the right way: the bark column's top cap, and a third of the ESB facade vertices. Those are written as
computed. The writer cannot tell such a value from the placeholder and recomputes it, which gives the same value.

## Verification

**Test** (`glb-uv-tangents.test.ts`, run with HOME empty and every environment variable unset, so no credentials were
reachable): 1/1 passed. The test writes a capped cylinder routed by target name, a plate with its own tangents and a
box without a normal map, through both writers. It asserts:
- every cylinder vertex: unit T, |T·N| < 1e-4, |w| = 1;
- every triangle corner: T along +u, and cross(N, T)·w along −v;
- no placeholder left on the 66 side vertices;
- the plate's tangents kept bit for bit;
- the box written as given;
- the single-mesh writer's tangents identical to the multi-mesh writer's.

With it, the 19 test files that touch the UV engine, MikkTSpace, normal textures or the forest generator ran the same
way: 18 passed and 1 skipped as before (`algorithmic-uv-unwrap-rewrap-real`, which needs real assets); 153 tests passed
and 9 were skipped.

**Against MikkTSpace** (three.js r186's WASM port, w negated for glTF as `computeMikkTSpaceTangents` does). The
check: the angle between our T and MikkTSpace's, and agreement of w, per corner. Corners whose triangle runs against
its vertex's majority are left out (0-17% per mesh).

| GLB | Corners wound counter-clockwise about their normal | T angle (median) | w agrees |
| :--- | ---: | ---: | ---: |
| ESB, limestone, spandrels, glazing, bronze (`generate_empire_state_building.cpp`) | 131,688 | 0.00° | 100% |
| SB-Veggie wood / foliage (`run_sb_veggie.cpp`) | 7,944 / 396,864 | 0.05° | 100% / 100% |
| Forest floor (main's `generate_forest_procedural_3d.cpp`) | 163,050 | 0.00° | 100% |
| Bark column (engine cylinder, botanical bark set) | 768 | 0.00° | 100% |

Every disagreement is on a triangle wound clockwise about its own vertex normals. MikkTSpace takes its sign from the
UV winding alone and assumes counter-clockwise triangles, while the engine reads the normal. So the disagreements
expose producer winding faults (listed below), not tangent faults. Before the fix every one of these GLBs carried
100% placeholder tangents, with max |T·N| = 1.

**Render** (three.js r186 in the app's browser pane, each producer compiled once against `HEAD`'s headers and once
against the new ones). The columns are before, after, and a reference using MikkTSpace tangents (triangles wound
against their normals are handed to MikkTSpace with two corners swapped, then put back). The rows are lit, view-space
normal with the normal map, and the difference from the reference ×4. Mean |RGB| difference from the reference
(0-255):

| Producer | Lit, before / after | Normal view, before / after |
| :--- | ---: | ---: |
| SB-Veggie tree, lower trunk | 2.35 / 0.00 | 6.14 / 0.01 |
| Bark column (engine cylinder, botanical bark set tiled 3 x 2) | 8.21 / 0.00 | 8.78 / 0.00 |

In the before column the bark is lit wrongly where the trunk faces +x: the grooves read as streaked ridges, and the
difference image lights up there. The after column's difference image is black.

Proof sheets (gitignored): `docs/screenshots/glb-uv-tangents-2026-11-02/tree_tangents_before_after.png`,
`column_tangents_before_after.png`.

## Producer faults found on the way (not fixed here)

- **SB-Veggie** (`scratchbox_sb_veggie.hpp`, the tube rings): `nextS = (s + 1) % radial` with u = s / radial. Each
  ring's last strip runs u from (n-1)/n back to 0, so the whole texture is squashed backwards into one strip per branch.
  The trunk segment (720 of 4,064 wood triangles) and every leaf card are also wound clockwise about their normals.
  On a double-sided material three.js then shades the trunk with its normals flipped, which is why the lit trunk reads
  dark on its lit side.
- **Main's forest generator**, trunks: the vertex normals stand about 90° off the faces (N·dP/du ≈ 0.9 on the probed
  triangles), and 91% of triangles are wound clockwise about them. No tangent can be right on that surface until its
  normals are. Branch `claude/elated-wright-2b37e5` rewrote this generator; check whether that rewrite fixed it.
- **ESB generator**: the stainless steel spire (240 corners) and 144 glazing corners are wound clockwise.

## Hand-over

- The forest generator's own `computeTangents` (`ae720963`, branch `claude/elated-wright-2b37e5`) sets explicit
  tangents, so the writer keeps them. Its convention is the same as the writer's. Once both branches land it can be
  dropped, since the writer now computes the same frame, or replaced by `mesh.computeUvTangents()`.
- TS code that adds normal textures to an engine GLB after it is written (`twin-library-detail.ts` on `texCoord: 1`,
  `material-regions.ts`, `GlbTextureRecolorService.ts`) never passes through this writer. Where such a GLB carries
  `TANGENT` and had no normal texture at write time, it still carries the placeholder. `UvAtlasRewrap.ts` already
  rewrites `TANGENT` for its own UVs.
