# The 3D viewport's Parts view: a 3D object or building as the parts it is made of

**Date:** 2026-11-06 · **Status:** Verified live (the finished Penn 2 build, pipeline K, in an isolated app instance on ports 3180–3182) · **Branch:** `feat/parts-view`

## Ask

The user (2026-11-06): "in a similar fashion to how 'viewport' agent helps visualize all the parts of map data, when showing
a 3d object or a 3d building can we change that visualizer to show the parts of a 3d object or building?" The Map data
view (PR #163, `MapDataControl.tsx`, unmerged at the time) shows a place as its map data: a tool strip button, a panel
with switchable layers and a legend whose rows hide groups, a click that reads a blob. This is the same shape for a
model's parts.

## What was built

- **Setting** `Scene3DData.partsView` (`common/spatial/model-parts-view.ts`): `on`, `hidden[]` (part keys), `solo` (one
  key shown alone), `tint` (default on). Changes go through `mutateSceneData` with the operators `set_parts_view` /
  `clear_parts_view`, so they sit in the scene's history like the weather or the camera.
- **The parts** (`primitives/scene3d/modelParts.ts` `collectModelParts`): every mesh of the loaded models and the
  generated root, identified by the extras the file carries, nearest ancestor first: `sbFacadeLattice` (a rebuilt facade,
  labelled `Facade <id>`, with its measured share, windows and panes), `sbBaseSkirt`, `sbSeal` (its routes),
  `sbTree`, a staged node's `sb` (grouped by its provenance label, `staged:<label>`), a merged staged mesh's table (one
  part per row, hidden by collapsing its triangles with `setPartVisibility`), the geometry's `sbLatticeCut` /
  `sbFootprintClip`, an object build's material `scratchbox.partId` (the part's description, roughness and metalness),
  a decal; else **any other `sb*` key whose value is a record a pipeline wrote** (it carries a `provenance`, `version`
  or `schema`), named from the key, so extras this code never heard of still make a group (on Penn 2: "Corner join",
  "Scan restored", "Inner core" came out of the file with no code naming them); else "Meshes". The viewer's own
  `userData` hooks (meshes, functions, flags) never make a group. Each group takes a hue, each part a shade of it.
- **Overlay** (`ModelPartsOverlay`): one translucent flat-colour mesh per part sharing the part's geometry (a merged
  part: its triangle range over the mesh's own attributes; never disposed, the attributes are the model's), drawn with a
  polygon offset; the highlighted part at 0.85 opacity, the rest dimmed to 0.2 while one is lit, 0.45 otherwise; off
  entirely when the tint switch is off and nothing is lit.
- **Panel** (`ModelPartsControl.tsx`): the switch, "Colour each part", the totals, "Show all (n hidden)", "Re-read"
  (after a load the key did not see), the picked part's readout (label, group, provenance and confidence, detail,
  triangles), then one section per group with a group switch and a collapsible list: a row toggles its part, "only"
  shows it alone, hovering a row highlights it in the viewport. A click without a drag (4 px) on the viewport picks the
  part under the pointer (`pickModelPart`, a merged part by its triangle through `partAwareRaycast`).
- **Load:** `gltf.asset.extras` is now kept on the model root as `userData.sbAssetExtras` (a building's material
  classes and provenance live there and the loader dropped them).

## Evidence (live)

Isolated instance `scratchbox-parts-view` (web 3180, API 3181, tools 3182, launch token off). The finished Penn 2 build
(`two_penn_plaza_2_pennsylvania_plaza_new__iso_l2_tex_71021a81.glb`, pipeline K at 8588b51d) mounted through the chat.
Parts on: **294 parts in 8 groups, 367,149 triangles** — Meshes 88 (the scan's relief pieces), Scan clipped to the
footprint 16, Rebuilt facades 32 (238,882 tris), Base skirt 1, Seal and infill 66, Corner join 7, Scan restored 10,
Inner core 74. The facades drew in greens, the other groups in their hues (`docs/screenshots/parts-view-penn2-tinted.jpg`).
Hovering "Facade 16" lit it and dimmed the rest; "only" left the front facade alone (293 hidden); "Show all" restored
every part. A click on the building read:

```
Facade 16 · Rebuilt facades
lines photo-inferred, depth measured (median per cell, averaged along the row's repeats); 1630 window cells recessed as the straightened photo shows them (photo-inferred, the photometric relief's contrast rule)
84% measured · 223 windows · 214 panes
28,876 triangles
```

(`docs/screenshots/parts-view-penn2-picked.jpg`). Console: only the two pre-existing 409s from the workspace save, none
from the view. Test: `packages/core/test/scene3d-model-parts.test.ts` (grouping of a building, an object build and a
merged staged layer, an unknown key with provenance making a group and a viewer hook not; hide, solo and restore on the
meshes and the merged index; picking by ray; the overlay's meshes, opacity and disposal). `npm run typecheck` clean.

## Found on the way

- The chat composer opens its slash-command picker on a model path that starts with `/models/...` typed mid-sentence,
  and Return then sends nothing; Escape and the Send button get past it. (Not changed here.)
- The first overlay drew white: three.js reads `hsl(h, s%, l%)` with commas only; the space syntax gives white without
  an error. The test now checks a part's colour is not white.
- The viewer's `facadeMaterialLook` writes `userData.sbFacadeEnvHook` on every scan piece; a name-based rule listed it
  as a group ("Facade env hook"). The shape rule (a record with provenance, version or schema) replaced it.

## Candidate tool/service ideas

- An in-app tool (`scene_3d_dispatch_operators` `sb_set_parts_view`) so the chat model can hide, solo or read a part by
  name ("show only the base skirt", "what is facade 16 made of"); the setting already lives in the scene.
- The picked part's readout as a chat attachment, so "why does this part look wrong" carries its provenance.
