# Process: Street-level splat world at 7th Ave / Penn Station, asked for from the chat

> **Recorded:** 2026-10-29
> **Status:** Verified end to end (prompt → Street View stations → splat world → 3D Scene at the vantage; front-page 3D World button), Needs Fix on quality (soft facades, streaks on the near street) and on chat runs being cut off by other sessions sharing the checkout; the cloud world cache is built and tested but has no bucket configured yet
> **Tags:** `operate-scratchbox` `3dgs` `street-view` `maps-imagery-grounding` `ai-beautify` `location-generate-3dgs`
> **Target Domain:** Gemini Agent Chat / location_generate_3dgs / 3D Scene

---

## 1. Session Context

* **What prompted this session:** the user asked for a navigable 3DGS "world" built from Street View (Maps Imagery Grounding), survey stations with AI Beautify, and Nano Banana. It is to stand on the west sidewalk of 7th Ave at the Penn Station / Madison Square Garden entrance, looking east across the avenue, and to be asked for by prompt.
* **Instance used:** web port `3420`, API port `3421`, tools port `3422` (`scratchbox-street-stations` in `.claude/launch.json`), running this checkout (branch `feat/cartesian-normal-snapping`, with uncommitted changes).
* **Scope tested:** `location_generate_3dgs` with a street vantage (`vantageSideDeg`, `vantageHeadingDeg`), called by the in-app chat model from this prompt: "Make a walkable 3D Gaussian splat world of the spot on the west sidewalk of 7th Ave at the Penn Station and Madison Square Garden entrance, looking east across the avenue."
* **Uncached:** a fresh extraction (named by its centre) and a fresh output folder; `forceRebake` is on by default, so every station image was generated in this run. The only cache used was the Street View metadata cache (pano ids, positions, dates).

---

## 2. What Was Tested & What Worked (Verified)

* **The chat model fills the vantage from words.** It called `location_generate_3dgs` with `{ location: "7th Avenue & West 32nd Street, New York", vantageSideDeg: 270, vantageHeadingDeg: 90 }`, read from the tool's own declaration and system prompt section 8.
* **The sidewalk snap.** The extraction was centred at 40.749745, -73.991630, on 7th Ave's west sidewalk at W 32nd St. That is within a few metres of the point picked by hand from the vector centrelines: 7th Ave runs at a bearing of 29.3°, and the viewer stands 13.5 m west of its centreline. The look heading is snapped to across the street on Manhattan's rotated grid.
* **Street stations.** The run found 6 Google panos and asked 24 views (4 per pano) through the grounding API. 12 came back and were registered (edge, then joint registration against the extraction).
  - All 12 were beautified from their own photographs, four at a time.
  - All 12 were baked; 12 street stations were done in about 3 minutes.
  - They are photoreal, obstruction-free and evenly lit. The actual Penn Station / MSG entrance canopy and its signage appear in the view behind the vantage.
* **Stitching regardless.** Street View from April 2026 shows an open lot behind a construction fence on the north side of W 32nd St, east of 7th Ave, where the tiles still have a building. Those views are kept by design (user decision, 2026-10-29). The geometry check is reported per station (`scanMismatch`) and never rejects or rerolls.

* **The finished world** (run through the app's tool route with the chat's own arguments, after the chat run was cut off, see section 3; 24 street plates reused from that run): 4,123,470 splats from 30 of 40 stations (all 24 street stations, 6 of 16 survey stations), 2229 s; `fused.splat` 126 MB, tiles 51 MB, `scene3d.json` beside them.
* **Survey stations anchored on the street views run in parallel** (four at a time), each warped from the street view that covers most of its frame; a station whose image call came back empty is now dropped with its reason instead of failing the run.
* **It opens as a walkable 3D Scene**: the front page's new 3D World button (System Spec and KPI Dashboard removed) opens the saved scene with no chat call; the view starts first-person 1.6 m above the scanned sidewalk on 7th Ave's west side, looking east down W 32nd St, buildings on both sides. Fixes it needed: live Google tiles off for a splat scene (`geoAnchor.active: false`, they covered the splat with their coarser copy), and the auto-framer keeps a pose saved on purpose (`keepPoseOnLoad`) even inside the geometry (it had moved the viewer out to an orbit 760 m away).

---

## 3. What Broke / Didn't Work

Each item below was observed in this session.

* **The bake could not run inside the app.** `SurveySplatPipelineService` and `Splat3DTilesService` resolved `scripts/station_to_splats.cpp`, `scripts/splat_to_3dtiles.cpp` and `build/` from `process.cwd()`, and the app's server runs from `desktop-app/`.
  - Error: `station_to_splats source not found: /Users/eligreen/dev/scratchbox-ide-master/desktop-app/scripts/station_to_splats.cpp`.
  - Fixed: both now resolve from the repo root (`repoPath`).
* **Stations ran one at a time.** One image call took up to 8 minutes, so 39 stations in a row could never fit the chat's 60-minute limit.
  - Fixed: street stations now run four at a time, because each one beautifies its own photograph. The first accepted one starts the chain the survey stations follow.
  - The time limit is now 120 minutes (15 minutes idle) when a vantage is given.
* **The snap first chose the wrong street, twice.**
  - From "Madison Square Garden" it chose a 118 m road inside the block. The vector tiles label every road alike (`residential`, 8 m, 2 lanes, no name).
  - It then chose a road beside "Chase Square at Madison Square Garden", the point Places returned for the model's landmark wording.
  - Fixed: candidate streets are checked nearest first, and the first with a Google-captured pano at its point wins. The tool and the prompt now ask for the street corner as the location, and the result says how far the named place lay from the chosen street.
* **`toWebUrl` returned absolute file paths as URLs.** Any path starting with "/" was returned unchanged, so the scene would have been given `/Users/.../fused.splat`. Fixed.
* **The result never opened a 3D Scene.** `location_generate_3dgs` returned `scene3DData` but no `artifact`. Its scene also defaulted to a golden-hour sky (AGENTS.md 3.6). Fixed:
  - it returns a `3d-scene` artifact;
  - with a vantage, the scene opens first-person (`cameraMode: 'fps'`) at 1.6 m above the scanned sidewalk, looking along the heading;
  - the environment is a neutral studio.
* **UI: "/" partway through a prompt opens the skill picker.** For example "Penn Station / Madison Square Garden". Return then goes to the picker and the message is not sent. Not fixed (outside this change).
* **UI: other sessions' edits in the same checkout hot-reload the page.** The chat's view of a running tool is wiped; the tool keeps running on the server. Not fixed.

* **A chat run was cut off by another session.** At about 22:05 another session's app (it shares this checkout's `.scratchbox` chat state) switched the active chat in this tab; the stream was dropped and the tool aborted with 24 street stations done. Workaround: the same arguments through `/gemini/tools/run-stream`. Not fixed.
* **Quality of the first world.** Facades are soft, the near street surface has dark streaks and specks, and only 6 of 16 survey stations were accepted; the left side of W 32nd St shows the tiles' building where Street View has an open lot (stitched by design). Not yet investigated stage by stage.
* **A large splat loads slowly.** The 126 MB `fused.splat` takes tens of seconds before anything shows; the 3D Tiles tileset (with its levels of detail) is written but the scene loads the single splat file.

---

## 4. Candidate Tool/Service Ideas

* **A street-name check for the snap.** Reverse-geocode each candidate street's point and compare its route name with the street the user named ("7th Ave"). The vector tiles carry no names, so this run relied on the model writing a corner.
* **A walk-path render tool for a splat world.** Render N first-person frames along the sidewalk from a finished tileset, as proof images. This session had to drive the viewport by hand.
* **Per-splat provenance.** Today provenance is per station in `tileset.meta.json`. A per-splat source id would let the viewer show where a pixel came from.

* **World cache bucket** — `worlds/v1/<key>/` in a bucket named by `worldCacheBucket` (cloud-store.json) or `SCRATCHBOX_WORLD_CACHE_BUCKET`: built and tested with a directory bucket; no bucket is configured on this machine yet, so worlds are still built each time.
* **Load the splat world by its tileset** (levels of detail) instead of the single 126 MB splat, so it shows in seconds.

---

## 5. Reproduction Steps

1. Add the `scratchbox-street-stations` entry (ports 3420/3421/3422, this checkout) and run `preview_start`.
2. Open `http://127.0.0.1:3420/` and start a New Chat.
3. Send: "Make a walkable 3D Gaussian splat world of the spot on the west sidewalk of 7th Ave at the Penn Station and Madison Square Garden entrance, looking east across the avenue." Avoid a "/" in the text (see section 3).
4. Or press **3D World** on the front page: it opens the saved scene directly.
5. The output folder is `desktop-app/public/tilesets/7th_avenue_west_32nd_street_new_york_40.74974_-73.99163/`, with the station images and blockouts in `stations/`.

---

## 6. Self-critique (2026-10-30): viewport, code, research

The user asked for a critique of the work. It was examined in the viewport, by point renders of the splat data from the vantage, by tracing individual splats, and against published work (a research subagent's survey).

**Found and fixed:**
* **The world turned upside down when you looked around.** In first-person mode, mouse-look only relabelled the camera's rotation order (`camera.rotation.order = 'YXZ'`) and did not convert the angles. A view facing more than 90 degrees from -Z flipped on the first drag; at the vantage (heading 119.3 degrees) the camera came out about 160 degrees about its own X axis. Fixed in `attachViewportControls.ts` by re-expressing the orientation in YXZ (`setFromQuaternion`). The up vector after a drag is now (0.04, 1.00, 0.03).
* **An inverted world seen through the street.** 72% of the street had no splats, and 5% of all splats lay up to 16 m *below* it: scan surfaces in Penn Station's stairwells and pits. Through the holes they read as an upside-down city. One "brick building" in the first build turned out, by tracing, to be 121,641 splats below the street. Fixed by containing the fused splats to the scan's hulls (`splat-containment.ts`):
  - **Ground:** a low percentile of the scan's top surface over an 8 m window. A minimum let the pits sink it and ate real facades.
  - **Building columns:** more than 4 m above the ground, plus low structures whose connected footprint is at least 50 m² (a fence line, sheds, a canopy). Car-sized lumps are not kept.
  - **What goes:** splats under the ground, in the air over the street, and above the scan.
  - This is the rule GS4Buildings / Clean-GS apply at training time, applied once here.
* **Floating smears over the street.** The scan's car and tree lumps were painted with the street behind them (the station images are obstruction-free). They are dropped by the same containment. On the first build: 379,719 splats underground, 77,387 in the air and 31,278 above the scan.
* **The street was missing.** Three of my own faults:
  - **Wrong camera height:** street stations recorded their absolute frame height (about 27.5 m) as `cameraAltitude`, not their height above the street (2.5 m). So the baker gave them coarse mid-altitude splats, and the fuser gave them a low ground priority.
  - **Views pitched up:** they pitched 12 degrees upward, so the ground was out of frame within about 11 m of each pano. They are now level.
  - **Ground dropped as grazing:** the bake's grazing floor of 0.2 dropped the street beyond 12 m. For street stations it is now 0.06; elongation stays capped by the baker.
* **Street plates were reused by station id alone.** They skip the geometry check, so an image made for another camera would have been baked onto the wrong view. A plate now records its camera (`<station>_plate.json`) and is reused only when the station still has that camera.
* **My first containment test was wrong**, not the code: its facade point was in the middle of a building.

**Not fixed (ranked):**
1. **Soft facades and seams.** Fusion keeps one splat per voxel. Published practice picks one view per surface patch with a grazing cutoff (Waechter et al.) and bounds each splat's size by its source pixel (Mip-Splatting).
2. **Colour drift between stations.** Each station is restyled on its own; the survey stations are now anchored on the street views, but no per-station gain is fitted in the overlaps.
3. **Load time.** The scene loads one 100+ MB splat; the 3D Tiles tileset (with its levels of detail) is written but not used by the viewer.
4. **Cached station splats are not invalidated when bake settings change.** Only the camera is checked; this session deleted them by hand to re-bake.
5. **Chat runs are fragile here.** Another session sharing this checkout can switch the active chat and abort the tool.
6. **The 3D World button names this one world's folder.** Without it, the button builds the world from the chat.

## 7. World cache in Google Cloud (2026-10-30)

* **The bucket:** `gs://scoutscan-splat-worlds`, project `scoutscan`, us-central1, uniform access. It was created with the app's service account and set as `worldCacheBucket` in `~/.scratchbox/cloud-store.json`; the training bucket is unchanged.
* **Stored:** this world, key `0536cef80b926fb1d30177b9`, 429 files, 212 MB. The manifest (`world.json`) is written last. The per-station work (`stations/`) is not stored, and no Street View photograph ever reaches the output folder.
* **Fetched:** the same ask, sent to a new output folder, came back from the bucket in 1 min 46 s, against 10 to 37 minutes to build. The result says `worldCache.state: 'fetched'` and when the world was built. The scene was rewritten for the new folder's paths and opens first-person at the vantage. `refresh: true` builds the world again.

