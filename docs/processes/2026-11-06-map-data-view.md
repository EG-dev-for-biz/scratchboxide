# Map data view: blob groups, Google vector data and the roadmap over a staged place

**Date:** 2026-11-06
**Branch:** `feat/map-data-view`
**Target domain:** Generative Canvas / 3D viewport
**Status:** Verified live (Penn Station district, ports 3140/3141/3142)

---

## 1. Session Context

* **What prompted this session:** the user wants the 2026-11-06 blob graph prototype (the Penn Station district scan split into 1,231 blobs by group) seen live in the viewport, together with Google's vector map data and the roadmap, as a visualiser setting.
* **Scope tested:** the tool strip's new **Map data** control (beside Weather): the master switch, each layer switch, the legend rows that hide groups and area codes, the click that reads a blob out, the roadmap opacity; the routes behind it (`/api/map-data/blob-groups`, `/vector`, `/roadmap`, `/roadmap/tile`, `/discover`, `/usage`).
* **Data:** the prototype's `blob_graph.json`, `split/labels.bin` and `welded.glb` (from `/Volumes/3DTESTING/scratchbox-ide/blob-test/penn/`), copied into the worktree's `.scratchbox/map-data/penn/`; the scan opened as a model from a `.3d` file (`desktop-app/penn_map_data.3d`, not committed) with `geoAnchor` 40.75032, -73.99172 and `mapDataView.blobGraphPath` set.

## 2. What was verified

* **Blob groups:** the route returns the scan (995,971 vertices, 561,965 triangles) and one blob index a triangle, in `loadScanMesh` order (the split's own); the header's counts equal the prototype's: building 118 blobs, ground 1, ground-object 464, roof-object 280, wall-attachment 213, transient-candidate 63, tree 92; 19 unassigned triangles. Drawn as 7 meshes (one per group) over one shared position buffer; the scene's own model is hidden under them once it has loaded.
* **Click to read:** a click on the Penn Plaza slab read `building/17/38596/49262/f47`: "Mid-century modern slab skyscraper with repetitive gridded window facade, part of the Penn Plaza commercial complex" (confidence 0.88, 25,603 triangles, vector feature f47).
* **Vector data:** 9 vector tiles; 81 road centrelines, 467 footprints, 72 areas (parking lot 37, urban area 9, land cover 9, dry crops 9, mixed crops 5, park 3), 0 rail lines, 66 POIs within 200 m. Carriageways measured kerb to kerb on the scan (`road-surfaces.ts`): 26 runs, 671 stations, median width 11.25 m. Everything draped on the scan's measured terrain (walkable surface, 2 m grid).
* **Alignment (by eye, at the sheet's resolution):** footprints follow the scan's block and tower edges; centrelines and carriageways run down the streets; the roadmap's streets lie under the scan's streets (proof sheet panels 4, 5, 8, 9).
* **Roadmap:** the account's key is allowed a Map Tiles API roadmap session; 16 tiles at z18, cached on disk after the first fetch; attribution "Map data ©2026 Google".
* **Console:** no errors from the map data view (the 404/409s in the console belong to other sessions' chats in the shared store).
* **Tests:** `packages/core/test/map-data-view.test.ts` (15 tests, credentials out of reach, Node 22.18): contract round trip, group order, open labels, codes as labels, projection against `LocalTangentPlane`, a carriageway 10 m kerb to kerb measured as 10 m on a synthetic scan, roadmap tile placement, ground sampling, union outlines (overlaps, courtyards, specks, a turned square).

The proof sheet: `docs/screenshots/2026-11-06-map-data-view-proof-sheet.jpg` (gitignored; also in the session notes folder): 12 shots from one saved camera, each layer on and off, plus the panel's text.

## 3. Issues found and fixed during the session

* **Scene not hidden under the blobs** (z-fighting): the hide ran before the model loaded. Now it runs again when the scene's models finish loading, and the blob materials carry a polygon offset.
* **Flat, washed-out groups:** Lambert without normals drew no shading and the tone mapping turned orange to yellow. Now flat-shaded standard materials, not tone mapped.
* **Footprint outlines of modelled-volume buildings** drew as triangle soup (one with 15,223 plan triangles gave 190 loops). Several parts or volumes are now drawn as the outline of their union, traced on a 0.5 m grid (courtyards kept, specks under 10 m² dropped, simplified to 0.75 m): that building now has 5 loops.
* **Kerb share above 100 %:** `road-surfaces.ts` computes `measuredKerbShare` over the whole road, so a road split into runs reads above 1. The view counts its share from the stations instead (the source quirk is left for its owner).
* **Lines through buildings** read confusingly from oblique views: lines now draw depth-tested, with a faint copy through what stands over them.

## 4. Known limits

* The blob layer colours the mesh the blob graph indexes (the welded extraction). A K-D district build is a different mesh, so on such a scene the blob groups draw over it as the scan, not by recolouring the build.
* Overlays sit in the scene frame of the place's origin; an object moved off the origin would not line up with them.
* A few Google footprints overlap each other (around Herald Square), so their outlines draw densely there.
* Google's road lines carry no width: widths come only from the scan (no scan, no carriageways).
* POI labels crowd where Google packs many names (MSG concourse).
* Vector data and the roadmap cover the full 200 m radius, so they run past the scan's edge into the empty studio (context, by design; an option to clip to the scan is a small follow-up).
* An independent visual check (Haiku, given the claims) confirmed panels 1, 3, 6, 7 and 10 and the label size; it could not confirm street-by-street roadmap alignment at the sheet's resolution, and saw no round outline round the Garden's drum in panel 5 (that claim was dropped).

## 5. Cost

* Map Tiles API: 16 roadmap tiles fetched once (then from the disk cache), about 3 sessions and 3 viewport (attribution) calls; vector tiles: 9 per uncached overlay, about 6 overlay builds as the code changed. Well under $0.10.
* The app's automatic visual check (`gemini-3.8-flash`) ran on each scene open, as it does for any 3D canvas; not caused by this change.

## 6. Reproduction Steps

1. Copy the prototype's `blob_graph.json`, `split/labels.bin` and `welded.glb` into `<workspace>/.scratchbox/map-data/penn/`, and `welded.glb` into `public/models/penn_blob_welded.glb` (symlinks are not served).
2. Write a `.3d` file in `desktop-app/` with that model as an object, `geoAnchor` {40.75032, -73.99172} and `mapDataView: { on: false, blobGraphPath: ".scratchbox/map-data/penn/blob_graph.json" }`; start the launch entry with `SCRATCHBOX_ROOT` and `SCRATCHBOX_WORKSPACE_ROOTS` set to the worktree; open the file from the files explorer.
3. Press the tool strip's **Map data** button, switch it on, switch layers and legend rows; click a blob to read it.

## 7. Candidate Tool/Service Ideas

* **A viewport capture route:** this session captured the canvas with `toDataURL` in the frame after a render and posted base64 through `/workspace/create-file` (which only writes text and never overwrites). A `POST /3d/viewport/capture` that writes a PNG beside the scene would replace it.
* **A camera pose setter for automation:** shots shared one pose only through the camera panel's Save / Restore buttons; a scriptable `sb_set_camera` hook from the page would make proof runs deterministic.
* **An in-app tool for the view:** the chat model cannot switch the map data view or name a blob graph yet (`mapDataView` is a scene field only the panel writes).
