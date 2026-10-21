# Fit to View showed a blank terrain plane, not the staged building: two unrelated bugs

**Date:** 2026-10-21
**Area:** 3D viewport camera framing (`autoFraming.ts`, `Scene3DPrimitive.tsx`)
**Status:** Fixed, verified live

## The report

A screenshot of a staged build (E.V. Haughwout Building, 488 Broadway, isolated structure) showed the
"Facade grammar" panel with vector massing, Google 3D Tiles and surrounding terrain all committed, but the
viewport itself showed only a flat ground plane and a thin footprint outline — no visible building.

A prior agent (working on an unrelated texture task) investigated and correctly ruled out
`vector-first-paint.ts` producing empty geometry; it hypothesised a layer-id collision (vector massing and
terrain both publish `layer: 'l0'`) but did not confirm or fix it. That hypothesis turned out to be a red
herring: `layer` is a server-side bookkeeping tag used for `supersedes` matching, not a client-side scene
key, and vector-vs-terrain sharing it causes no visible problem. The real causes were in the viewport's
camera-framing code, and there were two of them, independent of each other.

## Cause 1: `sbEnvironment` is too broad a signal for "exclude from framing"

`computeSceneGeometryBounds` (`autoFraming.ts`) is meant to frame the hero/focal geometry, excluding
background scenery like terrain, by walking up each mesh's ancestors for a `userData.sbEnvironment` tag
(`hasEnvironmentAncestor`). That tag is set by `isEnvironmentDef` in `Scene3DPrimitive.tsx`:

```ts
const isEnvironmentDef = (def) =>
  def?.content?.metadata?.role === 'environment' || !!def?.content?.metadata?.isGround || ...
```

`role: 'environment'` is set unconditionally on **every** staged-location layer object
(`layerObject` in `staged-artifact.ts`) — the hero tiles/building mesh included — because the flag's real
purpose is ground-snapping ("every attached hero snaps onto all of this"), a legitimately broad concern.
Camera framing reused the same flag for a narrower, different concern ("don't frame the kilometres-wide
terrain disc"), and since the hero building also carries the flag, it got excluded from framing right along
with terrain. With nothing left in the focal set, the code fell back to the full, unfiltered scene bounds —
dominated by an ~8 km terrain disc (`TERRAIN_RADIUS_M`) — so the camera framed terrain, and the ~40 m
building rendered as an invisible speck.

**Fix:** a second, narrower flag, `userData.sbFramingBackground`, set only when
`def.content.metadata.stage === 'terrain'`. `sbEnvironment` is unchanged (ground-snapping still applies to
everything); `hasEnvironmentAncestor` now checks the narrower flag.

## Cause 2 (found during live verification of cause 1's fix): draw-call-merged meshes share the UI-helper name prefix

With cause 1 fixed, "Fit to View" *still* framed an empty area of terrain. Live inspection
(`window.__SB_3D_SCENE__`, a debug global) showed the terrain was correctly excluded and the building's
geometry was present, visible, and correctly tagged — but `computeSceneGeometryBounds`'s name-based skip
list excludes anything starting with `sb-`, meant for the viewport's own internal helpers
(`sb-selection-helper`, `sb-grid-helper`, `sb-starfield`, ...). The viewport draw-call-reduction work earlier
this session (`mergeStagedParts.ts`) names a staged building's merged meshes `sb-merged-parts-<n>` — real
geometry, not a helper — so every merged building was silently excluded from every framing bound, leaving
only whatever small, irrelevant geometry (a ~2 m UI gizmo, in the live repro) happened to survive both skip
lists.

**Fix:** narrowed the `sb-` skip check to exclude `sb-merged-parts-` explicitly.

## Why this needed two fixes, not one

Both bugs are the same shape: a naming or tagging convention invented for one purpose
(ground-snapping; "this is an internal helper, not content") got reused, unnarrowed, by unrelated code
(camera framing) that needed a different, narrower answer for the same objects. Fixing only one left the
other fully blocking. The lesson for future shared conventions: a flag's name should say what it is
(`sbEnvironment` = "part of the staged scene, snaps heroes onto it"), not what a single caller uses it for;
callers that need a narrower distinction should get their own flag rather than overloading the broad one.

## Verification

- 3 new/updated unit tests in `packages/core/test/scene3d-auto-framing.test.ts` (11 total, all passing):
  a staged building is framed over terrain even though both carry `sbEnvironment`; a building whose meshes
  are named `sb-merged-parts-N` is framed over a `sb-`-prefixed helper box.
- `npm run typecheck` (packages/core), `npm run lint`, `npm run lint:primitives`: clean (pre-existing
  warnings only, none in the touched files).
- **Live, end to end**, on the exact reported scenario: staged the Haughwout Building as an isolated
  structure (own launch entry, ports 3910-3912) with vector massing, Google 3D Tiles and surrounding terrain
  all committed. Before the fixes, "Fit to View" showed a blank terrain plane (screenshot
  `01_before_fit_to_view_blank_terrain.jpg`). After both fixes, with the exact same build, "Fit to View"
  correctly frames the building (`02_after_fit_to_view_frames_building.jpg`).
- Live object inspection via the browser console confirmed: terrain tagged `sbFramingBackground: true`,
  size ~8000×84×8000 m; the building's merged meshes (`sb-merged-parts-0..12`) tagged
  `sbFramingBackground: false`, size ~40×36×38 m, both visible with non-empty geometry.

Screenshots: `test-results/screenshots/believability/` (gitignored), copied to
`/private/tmp/claude-501/-Users-eligreen-Dev-scratchbox-ide-master/0e56213a-b439-4e65-b21e-80ced59c9b90/scratchpad/shots/believability/`.

## Files

- `packages/core/src/browser/generative-canvas/primitives/Scene3DPrimitive.tsx`: sets `sbFramingBackground`
  alongside `sbEnvironment` when a staged layer's GLB is attached.
- `packages/core/src/browser/generative-canvas/primitives/scene3d/autoFraming.ts`: `hasEnvironmentAncestor`
  checks the narrower flag; the `sb-` skip list excludes `sb-merged-parts-`.
- `packages/core/test/scene3d-auto-framing.test.ts`: the two regression tests above.
