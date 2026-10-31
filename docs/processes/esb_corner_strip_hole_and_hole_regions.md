# Process: The grey strip down the Empire State Building's corner, and the outside check's hole regions

> **Recorded:** 2026-10-30
> **Status:** Verified (the strip is a tear in the stale Oct 26 build the viewer showed; a new uncached build, run 6ad5c7a3, has that corner closed and ran the new hole-region check, not flagged). Two of its stages degraded because another session cleared the stage caches mid-build (see section 3).
> **Tags:** `operate-scratchbox` `pipeline-k` `visible-defects` `holes` `empire-state`
> **Target Domain:** staged locations / pipeline K / outside check (`pipeline-k/visible-defects.ts`)

---

## 1. Session Context

* **What prompted this session:** the user saw a tall vertical strip of large flat grey triangles with gaps between them on the ESB tower shaft (about y 150 to 260 m), seen from below looking up a corner, in the viewer of the 3DGS session's instance (port 3420). That session ray-cast the strip (camera [-73.4, 124.8, 15.9], target [2.6, 223.8, 16.9]) and found facade sheet `FacadeLattice_46` first, with scan pieces about 9 m behind it.
* **Instance used:** `scratchbox-esb-strip-hole`: web port `3630`, API port `3631`, tools port `3632`, started once the 3DGS session freed its 3420 slot (before that, `preview_start` refused a fifth server for this folder, twice). The GLBs were also read in a scratch three.js 0.186 page (the app's own `node_modules/three`, GLTFLoader) on port 3633, and the 3420 instance was opened read-only once to see which chat it had open.
* **Scope tested:** which build the viewer showed; what draws the strip; whether the latest build has it; whether the outside check sees it; a hole-region rule for the outside check.

---

## 2. What Was Tested & What Worked (Verified)

* **Which build the viewer showed.** The hit object was `FacadeLattice_46 < external-object-stg-f433f2c4-l2~tex`. Remesh key `f433f2c4` is run `cf78b518` of **2026-10-26 18:46**, not run `66971359` of today. Its `sbFacadeLattice` extras match `public/models/empire_state_building_350_fifth_avenue_n_iso_l2_tex_5a6fb495.glb` exactly: 4,066 triangles, 1,650 cells, `measuredShare` 0.97, holes 5.08 %, bbox x -26.2..-6.2, y 88.2..263.4, z -20.3..15.5. Today's `..._l2_tex_1d19fa18.glb` has no such sheet; its `FacadeLattice_46` is a podium facade (y -0.4..22.9). The two runs geocoded 12 m apart (40.748545, -73.985763 vs 40.748441, -73.985664), so the old frame is the new one shifted by (+8.3, 0, +11.8) m (checked on the matching shaft sheet: old `FacadeLattice_46` vs new `FacadeLattice_49`).
* **What draws the strip: a hole, not untextured cells.** At the parent's camera with a 22° field of view, the strip shows in the Oct 26 GLB. Rays across it (screen x 365 to 410 px at four heights): `FacadeLattice_46` (normal -0.88, 0, -0.48) ends at about x -25.6, z 14.4-14.8; the next face's scan (`relief_m88`, normal -0.48, 0, 0.88) starts at about x -24.4, z 16.3; between them rays pass into the building and hit `relief_m98` / `relief_m88` faces with normal (+0.88, 0, +0.48) at x -3.2..-3.9, 10-22 m inside, facing away from the camera. Those are back faces; tile_refine's twin draws every material double-sided, so the photo seen from behind reads as flat grey. A few triangles in the strip are inner scan surfaces facing outward, drawn as front faces, which is why some of the strip reads as "triangles with gaps". Drawing every back face red (panel 2 of the evidence) shows the corner open nearly its whole visible height.
* **What made the hole.** Commit `44646045` (2026-10-26 18:57, 11 minutes after that build finished) added "a scan triangle is removed only when every rebuilt facade it faces covers it in its own rectangle" and the facade tear audit. The Oct 26 build removed the corner's scan triangles although facade 46's sheet stopped short of them: a tear. Later work closed walls further (wall sheets `ddbc18ab`, clip and infill `61e740ec`, the tile seam weld).
* **The latest build at the same corner.** `..._l2_tex_1d19fa18.glb` (run `66971359`) loaded with the (+8.3, 0, +11.8) m shift, same camera: the corner is closed (panels 3 and 4); only hairline cracks remain.
* **The outside check saw the old build, but not the strip as such.** Today's `measureVisibleDefects` on the Oct 26 GLB: flagged, 2.06 % through holes (limit 1 %), worst view 3.54 % at 270°/0°. Its masks show the corner strip as a line 1-4 px wide: one 1.35 m x 123 m strip is about 0.3 % of the view it shows in. A build whose only fault was this strip would pass every share limit.
* **Hole regions (`visible-defects/3`).** Each view's hole pixels (inside visible or see-through) are joined into 8-connected regions, measured in metres and placed on the surface around their rim. One region over `maxHoleRegionM2` (40 m²) flags the build whatever the shares (`holesFlagged`, used by the orchestrator's `visible_defects` degradation). The report lists the largest regions, one per place, each with its view, area, length, width, centre, the node at its back faces and the node around its rim. On the two builds:

  | build | largest region | regions over 40 m² | holes flagged |
  | :--- | :--- | :--- | :--- |
  | Oct 26 `5a6fb495` | 223.6 m² at the podium (az 225°); the corner strip 166.5 m², 123.3 m x 1.35 m, back faces of `FacadeLattice_46` (az 0°) | 8 | yes |
  | today `1d19fa18` | 29.7 m², 19.3 m x 1.53 m at [-58.1, 7.8, -31.1] in `relief_m27` (podium, az 315°) | 0 | no |

* **Uncached ESB build in the live app (run `6ad5c7a3`).** Stage caches cleared first (`staged_location/*` except `runs/`, `tile_refine/*`, `tile_vegetation/*`), instance started on the edited code, the 3D Building starter sent. Geocoded to 350 Fifth Ave, the Oct 26 build's frame, so the same camera applies with no offset. `tiles` 10 s, `remesh` 403 s and `textures` 1,047 s all `cached: false` (only the `textures-late` wait step reports cached, with no late layers). The orchestrator ran `visible-defects/3` on the polished remesh and on the finished twin: holes 0.26 %, untextured 0.27 % / 0.30 %, largest hole region 27.1 m² (23.1 m x 1.17 m at [-48.3, 13.7, -21.5] in `relief_m11`, podium, seen at 180°), not flagged. Its published twin `public/models/empire_state_building_350_fifth_avenue_n_iso_l2_tex_578981d4.glb` at the parent's camera (fov 22): the corner is closed; drawn with insides red, only hairline cracks show (`before_after_uncached_6ad5c7a3.png`).
* **Tests and types.** `packages/core/test/pipeline-k-visible-defects.test.ts`: a 40 x 120 x 40 m double-sided tower with a 1 m x 100 m slot 1 m from its corner stays under both share limits and is flagged by its region (74.8 m² straight on: the pixels on the slot's edges belong to the wall), placed in the front face at the slot, listed once across views; a 1 m x 20 m slot is reported and not flagged; the closed tower has no region. 12 of 12 pass with credentials unreachable (empty HOME). `npm run typecheck` exit 0.

---

## 3. What Broke / Didn't Work

* **The viewer was showing a 4-day-old build.** The 3420 instance's scene held the Oct 26 object `stg-f433f2c4-l2~tex`, and the strip was judged as if it were today's build. Nothing in the viewport said which run or date the staged object came from.
* **Another session cleared the caches during my build.** Run `7f594cd6` (another session, "Empire State Building, New York") started at 17:18:59 after deleting the stage caches, including my run's `staged_location/tiles/2f18e3fd…`. My run's Street View close-ups ("ENOENT: … tiles/2f18e3fd…/textured_tile_seams_2.glb") and ownership vote ("tile not found") then failed, and the run finished `degraded`. The remesh had already loaded its tiles and completed; neither failure touches the corner or the outside check. Clearing shared caches while another build runs breaks it; the no-cached-builds routine should check for a run in flight (a run directory without a `finish` line) first.
* **The chat lost the build's ending.** The chat's model turn failed ("The AI request failed: fetch failed") after the textures committed, the viewport kept only the clay layer, and after a reload the chat was not in the sidebar, so the corner was shot from the published twin in the probe page rather than the app's viewport.
* **The latest run before this one was partly cached.** Run `66971359`'s `remesh` stage was a cache hit (`timeline.jsonl` seq 13, `cached: true`), as was `69985ff6`'s (same remesh key `fcbd7f7a`).
* **Smaller holes remain in today's build.** Regions of 15-30 m² at the podium (`relief_m27`, `FacadeLattice_10044`, `FacadeLattice_4`) and a 22.5 m x 0.79 m slit on `FacadeLattice_56` at y 101.6 m; hairline cracks (one pixel wide, up to 41 m long) on the tower faces. Under the 40 m² limit; not investigated here.
* **The check's stated limit.** Through a hole, an inner surface facing outward is drawn as a front face and is not counted; parts of the Oct 26 strip were such surfaces (the grey triangles), so its region is smaller than the strip.

---

## 4. Candidate Tool/Service Ideas

* **Run and date on the staged object** — the viewport's staged-build overlay (or the scene object's tooltip) naming the run id, finish time and remesh key of each staged layer — this session had to match `sbFacadeLattice` extras across ten GLBs to learn the viewer showed a 4-day-old build.
* **Hole regions in the viewport** — a "show holes" toggle drawing back faces red (what the probe page did with one BackSide twin per mesh) and listing the report's `holeRegions` as click-to-fly bookmarks — the parent session ray-cast by hand to find the strip.
* **`mesh_inspect` on a published GLB with a camera** — return per-pixel node, material and facing for a given camera (what `T.survey` / `T.pick` did here) without a dev server.

---

## 5. Reproduction Steps

1. Serve a page that loads a GLB with three.js and a perspective camera (this session's: `scratchpad/viewer/index.html`, `?glb=&cam=&target=&fov=&off=`).
2. Load `public/models/empire_state_building_350_fifth_avenue_n_iso_l2_tex_5a6fb495.glb`, camera [-73.4, 124.8, 15.9] to [2.6, 223.8, 16.9], fov 22: the strip is at the screen's middle column. Add a red `BackSide` twin to every mesh to see the hole.
3. Load `public/models/empire_state_building_new_york_iso_l2_tex_1d19fa18.glb` offset by (8.3, 0, 11.8), same camera: the corner is closed.
4. `measureVisibleDefects(bytes)` on each GLB: `holeRegions`, `largestHoleRegionM2`, `holesFlagged`.
5. Evidence: `docs/screenshots/esb_corner_strip_2026-10-30/before_after_corner.png` (1 Oct 26 build, 2 its insides red, 3 run 66971359, 4 its insides red) and `before_after_uncached_6ad5c7a3.png` (1-2 the Oct 26 build, 3-4 the uncached run 6ad5c7a3 at the same camera and frame), with the full-size captures beside them.
