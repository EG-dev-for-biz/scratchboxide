# Process: streetview_look, Street View of any spot by date, and the 7th Ave sidewalk shed at Penn

> **Recorded:** 2026-11-03
> **Status:** Verified (the tool through the app's own tool runner, uncached, on the 7th Ave west sidewalk at Penn; 11 fixture tests)
> **Tags:** `operate-scratchbox` `streetview` `location-evidence` `penn-station` `district` `temporary-structures`
> **Target Domain:** Location evidence tools / Street View

---

## 1. Session Context

* **What prompted this session:** the Penn kd run on Cloud Run (266b12eb) has 100 m of slanted slabs and a deck along
  7th Ave's west sidewalk. The scan photos read as a sidewalk shed with a construction staging yard
  (`2026-11-03-vehicle-patch-shells.md`, the west sidewalk section). The user asked whether Street View is used in the
  process (it is not, in the district builds), then: "we are building generalized tools, so do it in a way you think best
  helps overall workflow".
* **The gap:** `streetview_grounding_image` fetches one view that the caller aims by hand. `streetview_survey` is built
  around one structure: it isolates it from the 3D Tiles and covers each of its faces. Nothing looked at an arbitrary
  spot (a sidewalk, a kiosk, a lump in the scan) across the captures Google holds, aimed for you, with a question asked
  of every view.
* **Instance used:** web port `3753`, API port `3754`, tools port `3755` (`scratchbox-streetview-look` launch entry,
  this branch; workspace and staged cache on the Scratchbox SSD). The tool was called through `POST /gemini/tools/run`,
  the runner the node graph's tool nodes use.

---

## 2. What Was Tested & What Worked (Verified)

* **The tool** (`packages/core/src/node/gemini/tools/location-evidence/streetview-look.ts`, registered with the location
  evidence tools):
  * **Input:** a point, an outline of lat/lng corners, or a query. Optional: `heightM`, `target` (the place, in words),
    `question`, `maxViews`, `maxRangeM`.
  * **Discovery:** the free metadata endpoint on an 11 m grid over everything within range (`discoverPanosAt`), Google
    captures only. Both the newest capture at each place and the older ones beside it count.
  * **Choice:** greedily, a capture month not yet seen, then a side of the spot not yet seen, then the nearer.
  * **Aim:**
    * the heading goes to the middle of the arc the outline spans from the camera;
    * the elevation goes to mid-height from the 2.5 m eye;
    * the field of view is sized to the arc and the height (30–90°), and `framed` says whether the spot fits.
  * **Images:** from the grounding API only, written exactly as returned. A refused pano is replaced and reported.
  * **The question:** one vision call per view. The answer gives whether the place is in view, the answer in words,
    yes/no and a confidence (photo-inferred), and the answers are tallied per capture month.
* **The run on the 7th Ave west sidewalk:**
  * **Input:** the outline from run 266b12eb's frame, along 60–160 m and across -9.7 to -15.5 m, converted with
    `scanToGeodetic`; `heightM` 4; range 40 m; 8 views.
  * **First call:** 35.7 s, with 146 metadata queries, 22 Google captures in range (2026-04 ×18, 2025-06 ×4), 64
    non-Google rejected, no refusals and 8 images.
  * **Second call:** 12 s, with all 146 metadata answers from the cache.
* **The answer:** every view, all within 10 m, says no temporary structure stands on the sidewalk (no ×8, confidence
  0.95–0.99). The sidewalk is open under Penn 2's finished canopy and its white V-columns.
* **The shed is temporary and gone:**
  * The scan's own photos of the same stretch show a 100 m sidewalk shed with a deck under tarps, a PENN STATION banner
    on its steel frame, pallets, a skip and barriers.
  * Street View in June 2025 and April 2026 shows the sidewalk without it.
  * **So the 3D Tiles predate the finished Penn 2:** the same era mismatch as the Penn 2 note.
* **What Street View cannot settle:** the tiles' own capture date. No capture older than 2025-06 is within 40 m.
* **Evidence:** `docs/screenshots/2026-11-03-streetview-look-penn-sidewalk.png`: the scan's texture of the structure
  above the 8 views, each with its month, distance, heading and answer.
* **Tests:** `packages/core/test/streetview-look-tool.test.ts`, 11 tests, no network. The setup is a synthetic street
  with three capture months (one month 5 m off another's line), a user photosphere and a refused pano; each JPEG is
  coloured by its month, and the fake vision model reads the colour.
  * **Discovery and choice:** every month is covered and the photosphere is never asked for.
  * **Aim:** each heading is the bearing to the spot within 0.05°, and the API pitch is the elevation's negative.
  * **Outlines:** an outline's corners lie inside the field of every framed view.
  * **Refusals:** the refusal is replaced and reported.
  * **Images and answers:** the bytes are written exactly as returned, and the tallies per month are right.
  * **Edge cases:** no question asks nothing; a question with no vision model is reported, not answered; the tool
    fails plainly without credentials or coverage.
  * **Pure functions:** the arc, the aim, the probe grid and the answer parsing are covered.
  * **Wiring:** the tool is in the registry and the declarations.

---

## 3. What Broke / Didn't Work

* **The first call's visibility field.**
  * **What happened:** it read every view as "not in view", with 0 yes and 0 no, though each answer described the
    sidewalk.
  * **Why:** the prompt called the spot "it", and the call named it "the long, low structure", which is gone in these
    captures, so the model said the target was not visible.
  * **Fixed in this branch:**
    * the field is now `placeInView`: the place, whatever stands there in that capture;
    * the prompt says a thing gone by a capture leaves its place in view;
    * the `target` argument asks for the place, not the thing asked about;
    * a test pins the prompt.
  * **The re-run:** "no" ×8, with the place in view in every view.
* **Long outlines from close.** A 100 m outline seen from 10 m does not fit 90°, so all 8 views report `framed: false`
  and show the 20–30 m in front of the camera. That is the right behaviour, and the flag says so. To see all of a long
  stretch, ask more views or split it.

---

## 4. Candidate Tool/Service Ideas

* **Older captures.**
  * **The idea:** a capture-history source for a place, so a look can reach the era the 3D Tiles were captured.
  * **The limit today:** the metadata endpoint answers one capture per place, so the newest captures hide older ones at
    the same spot. Here nothing older than 2025-06 was in reach. The look reports this in its `discovery.note`.
* **A look from a scan region.**
  * **The idea:** the same look taking a run id and a region in its frame (or a residual-audit cluster).
  * **What this session did by hand:** converting the frame outline to lat/lng (`scanToGeodetic`).
* **A temporary-structure flag on the district's clutter.**
  * **The idea:** feed this look's "gone in every newer capture" into the vehicle and clutter stage as evidence that a
    street lump is temporary.
  * **Whose call:** the policy is MAIN's.

---

## 5. Reproduction Steps

1. Add a launch entry running this branch, with free ports, and start it (`operate-scratchbox`).
2. `POST http://127.0.0.1:<api>/gemini/tools/run` with `{"name": "streetview_look", "workspaceRoot": <an allowed root>, "args": {...}}`.
   The args used here:
   * `outline`: [40.7496063, -73.9917732], [40.7503941, -73.9911996], [40.7504194, -73.9912597], [40.7496316, -73.9918333];
   * `heightM`: 4;
   * `target`: "the west sidewalk of 7th Avenue along Penn Station and Madison Square Garden, W 31st to W 33rd St";
   * `question`: "Does a temporary structure, such as a sidewalk shed, scaffolding or a fenced construction staging area, stand on this stretch of sidewalk in this photo?";
   * `maxViews`: 8, `maxRangeM`: 40.
3. Read `resultPayload.months` (tallies per capture month) and the images under `build/streetview-grounding/`.
