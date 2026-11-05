# The material path on any object (2026-11-05)

Branch `feat/object-material-path`, stacked on `feat/k-material-height` (PR #147), itself on PR #140. The user's ask (2026-11-05): the material detection usable on any 3D object the app builds, not only buildings.

## What changed
- **Shared core** (`packages/core/src/node/3d-engine/material-path/`): appearance classes and their k-means, the map tiling and class-border weights (`surface-classes.ts`), the set match at any tile scale (`class-sets.ts` `resolveClassSets`), the look-pick, finish, harvest, set-fit and height. Pipeline K re-exports them from where it imported them and supplies a facade's tile scale; its classes' openings and repeats are optional priors.
- **Objects** (`object-materials.ts` `runObjectMaterialPath`): the UV rewrap gives every material a metric atlas; a photo-textured material is read into classes by colour, a one-colour part is one class with its own factors as its finish; sets at the object's own tile scale; occlusion, roughness, metalness and normal tiled at real size, colour untouched; the relief capped at a hundredth of the object's diagonal and displaced over the whole object.
- **Wiring:** `object_detail_pass` `materials: true` (part of the object's recipe, a version in the scene object store, after any weathering); `build_3d_object_from_reference` `materials: true` or `SCRATCHBOX_OBJECT_MATERIALS=1` as the build's last step; the system prompt's detail pass names it.

## Run in the app
One generated object, built from chat with `materials: true` (garden wall, 2 x 0.9 x 0.35 m; the tool took 251 s in all): version 1 as built, version 2 "each part's detected material", mounted in the scene; 8 materials given maps, 3 with a relief, 4 displaced cells. Sheet: `object-material-path-wall.jpg` in the side-session notes.

| part | set | height |
|---|---|---|
| brick courses | Rust003 | none |
| mortar core | Concrete023 | 2 mm |
| coping | Asphalt009 | 1 mm |

## Open
- **The visible change on this object is faint.** Before and after are hard to tell apart at 2.9 m and at 0.75 m: millimetre relief on a matte part in studio light.
- **The bricks took a rust set.** Objects have no look-pick yet (the tool passes no chooser), so the ranking's nearest by colour and finish is used and drawn at full grain; this is the same wrong-kind match the facades had before their look-pick. Wiring the vision chooser for objects is the next step.
- **Only one of the three object kinds asked for was run.** A street object rebuilt from Street View and an object from a real photo were not run; the photo-class path is covered by a unit test only.
- No default: the step runs when asked.

Tests: `object-material-path.test.ts`, `object-detail-tools.test.ts`, `object-reference-tool.test.ts` (the build's step), with PR #147's.
