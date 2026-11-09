# Process: Street objects rebuilt from Street View and the scan (location_street_objects, report-only)

> **Recorded:** 2026-11-03
> **Status:** Verified for the parts listed in section 2, through the app's tool runner on real Penn and Union Square data. Report-only: no build is changed.
> **Tags:** `operate-scratchbox` `street-objects` `streetview` `district` `residual-audit` `object-build-spec` `penn-station` `union-square`
> **Target Domain:** Staged locations / district street furniture

---

## 1. Session Context

* **What prompted this session:** the user's walk-mode screenshots of Penn's K-D district show melted bollards, lumpy planters and benches, a bent lamp post, a floating sign and shards. The user asked "how can the agent restructure objects at the surface level using procedural 3d Object abilities" and "we could probably deduce what the object are and look like using street view".
* **Instance used:** `scratchbox-street-objects` launch entry (this branch), web `3790`, API `3791`, tools `3792`. The tool was called through `POST /gemini/tools/run-stream`, the runner the node graph's tool nodes use.
* **Scope tested:** `location_street_objects` on two existing staged builds, read from disk:
  * **Penn:** the centre chunk of `kd-penn-smoke-20261103` (2 Penn Plaza, leaf tiles within 125 m), with its district audit.
  * **Union Square:** the aerial-paint session's Union Square district build, with its district audit.

---

## 2. What Was Tested & What Worked (Verified)

* **Families (free, offline, measured).** Penn's audit gives 152 street clusters, which become 126 families (6 rows); 14 clusters are left out (too tall, too wide or too low). Union Square gives 2,300 clusters and 1,857 families (75 rows). Each member's foot, height and plan are the scan's.
* **Views, fetched in memory.**
  * **Discovery:** 25–29 Google panoramas around Penn's picked families, from the free metadata endpoint; 66–73 user photospheres were left out.
  * **Images:** fetched only through the Maps Imagery Grounding API (fetchViews), each aimed and framed at one member. Run 3 fetched 40 of 41.
  * **Never written:** the reports, overlays and renders hold no photo pixel.
* **Registration.**
  * **Run 2:** one wide view per pano. Two of 5 panos took an edge pose, and the joint fit improved all 5 (held-out chamfer 6.77 → 6.40 px).
  * **Run 3:** on a machine at load average 270+, the joint fit "did not run in its budget", leaving 1 of 9 panos registered. The tool now gives the registration three times the staged build's time.
* **Reads.** One vision call per family. What the model named:
  * "stainless steel security bollard" (2 pieces in one scan ridge);
  * "round dark metal trash can with flared slatted top";
  * "stainless steel stair handrail with vertical posts";
  * "wheeled suitcase with extended handle", read as not permanent;
  * "yellow metal patio chair", read as not permanent.
* **Masks.** The segmenter (MediaPipe interactive + GrabCut) runs in memory (`segmentBytes`, the JPEG decoded inside the worker), prompted by the read's tight box. On a synthetic photo, 11,623 of 11,637 post pixels were found in 1.9 s.
* **Penn, 7th Ave & W 32nd St, whole district, after merging main (2026-11-08, head 9fd21683).**
  * **The build:** fresh and uncached (stage caches moved aside), `"query": "40.74870, -73.99080"`, `district: "scan"`, run `6f8baa5b`, stopped through `/gemini/staged-runs/:runId/stop` once its district audit was written. The audit: 4,425 clusters (2,363 artefacts, 700 real objects, 1,362 unsure).
  * **The tool run** (`build/street-objects/581ecfeff2ec`, 35.5 min, load 25-50): 1,796 street clusters became 1,453 families (53 rows). 400 panoramas were found, and 117 of the 160 planned images were fetched. Only 2 of 19 panos took an edge pose, and the joint fit did not run in its budget, so the poses are nominal. There were 46 vision reads.
  * **Decisions:**
    * 4 families rebuilt and kept, 9 objects in all: a 6-member row of lamp-post bases (IoU 0.743 against the scan's 0.033; ΔE 1.8 against 10), a signal pole (0.496 against 0.359), a utility pole with a signal box (0.505 against 0.045) and a young street tree (0.527 against 0.139);
    * 1 scan kept: a tree in a fenced pit, whose colour came out further from the photos;
    * 5 read as temporary: sidewalk sheds, a barricade, a scaffold pole, a potted tree;
    * 1,443 not seen.
  * **Explained share:** 71 of 4,425 audit clusters (1.6%), or 71 of 1,667 street clusters (4.3%), carry a Street View label; 9 clusters (0.2%) were rebuilt.
  * **Why the share is low:**
    * 858 clusters: every candidate view is blocked in the scan;
    * 369: past the 160-image budget;
    * 271: no pano frames them large enough;
    * 56: a different era;
    * the 2,758 unsure or artefact clusters are not street-object candidates at all.
  * **The eye-level renders are weak:** for the lamp-post row and the utility pole, the camera stands against scan geometry, so the before/after pair barely differs; the tree rebuilt as a solid of revolution reads as a toy.
  * **Sheet:** `docs/screenshots/street-objects_2026-11-08/penn-street-objects-pr95-sheet.jpg` (`make_map.py` beside it draws the plan map by decision).
* **Penn, run 2 on the same audit, after the fixes in fdb431ba (2026-11-08):**
  * **The fixes:**
    * the clear test sees only a blob's near side;
    * the budget is 400 images, and views prefer panos already registered;
    * timed-out fetches are asked for again.
  * **Before (run 1) against after (run 2):**
    * images fetched: 117 of 160 against 393 of 400 (64 asked twice);
    * vision reads: 46 against 142;
    * clusters with a Street View label: 71 against 186, which is 4.2% of 4,425, or 11.2% of the 1,667 street clusters;
    * rebuilt families: 4 against 8; scan kept: 1 against 6; temporary: 5 against 16;
    * run time: 35 min against 128 min.
  * **Still unexplained:**
    * 760 clusters are blocked in the scan (858 before): most of these blocks are real, sidewalk sheds and trees in the tile;
    * 372 are past the budget;
    * 271 have no pano near enough to frame them;
    * 151 are "views show nothing there".
  * **Weaknesses:**
    * The vision read is not stable from run to run. The young tree one/4102, rebuilt in run 1 from the same three panos, is read "not there" in run 2. The lamp-post row row/658 lost its one edge-registered view to the pano-reuse preference, and its other views show nothing.
    * A building's projecting bay (one/0) was rebuilt as a street object; a building part should not reach the families.
    * The eye-level renders still often stand inside scan geometry.
    * The joint registration never ran: scoring 22 panos' start poses against the whole district tile took its whole 600 s budget. This is fixed separately in PR #202.
  * **Sheet:** `docs/screenshots/street-objects_2026-11-08/penn-street-objects-run2-sheet.jpg`.
* **Penn, cheap evidence first (MAIN's order, 2026-11-08, commits 989ac31d and 973a15bc, the same audit):**
  * **The read** (`blob-reader.ts`): the scan's measures, the map and the tile's own photo, on contact sheets of 16 numbered patches with one vision call per sheet. Every answer goes to the model readings store.
  * **Coverage:**
    * 1,856 of 4,425 blobs read;
    * 308 left out as building parts (inside or touching a footprint);
    * 2,261 left out as the audit's scan artefacts;
    * 1,638 confident labels and 218 unsure;
    * 4,207 of 4,425 explained (95.1%); a vision label alone covers 37%.
  * **Time and calls:** orthophoto 37 s; 116 calls in 10.4 min.
  * **Stability:**
    * a rerun reads all 116 sheets back from the store (0 calls), identical;
    * a fresh read (`freshRead`) against run A agrees 92.3% on confident or unsure and 86.5% on the answer class; both-confident labels share a content word 94.8% of the time; the exact wording matches 21.8%.
  * **Spot check** by a separate model (3 sheets, 48 blobs): 27 fit, 2 wrong, 19 can't tell.
  * **Street View only for the unsure** (153 families): 167 images, 56 reads, 7 rebuilt, in 47.5 min all told. The eye-level camera stands on walkable ground: the newsstand reads well from the pavement; a bin is still blocked by a scan spike.
  * **Sheet:** `docs/screenshots/street-objects_2026-11-08/penn-blobs-cheap-first-sheet.jpg`.
* **Penn, 8th Ave at the Farley Building (2026-11-04, the user's walk-mode block).**
  * **The build:** staged at 40.7506, -73.9952 (`"query": "40.75060, -73.99520"`, `district: "scan"`, trees on), stopped once its district audit was written. A first build queried as "8th Ave & W 32nd St" geocoded to the 14 St / 8 Av station and was stopped.
  * **The audit:** 951 clusters. The bollard rows come out as rows: 20, 16 and 15 members at about 1.52 m pitch.
  * **The tool run:** 44 of 66 images, 5 panos registered.
  * **Rebuilt:** a row of 15 yellow bollards with a dark ring near the top (IoU 0.623 against the scan's 0.184; ΔE 20.1 against 22.5), and a stainless bollard (0.727 against 0.395; ΔE 13.8 against 17.5).
  * **Kept as scanned under MAIN's both-scores rule:** three objects with better silhouettes but colours further from the photos.
* **Penn, 7th Ave, final run (`build/street-objects/d579eca3329e`, head 711a138b).** 41 of 41 images fetched, 3 panos registered, 13 reads (all from the reply cache).
  * Stainless steel security bollards (`row/56`), rebuilt: silhouette IoU 0.392 against the scan blob's 0.08; colour ΔE 4.5 against 5.0. The scan's 5.2 m ridge was split into the 2 bollards one view shows; the row's two ridges no view split keep the scan.
  * A weathered beige concrete trash can (`row/277`), rebuilt: IoU 0.313 against 0.047. It is built at its photos' height (0.91 m, photo-inferred), not the blob's 1.43 m.
  * A stainless stair handrail (`row/17`): the scan stays (IoU 0.009).
  * A yellow patio chair (`one/36`): read as put out for a while, so not rebuilt.
  * 16 families not seen: blocked in the scan from every pano, or Street View shows nothing there (the 7th Ave shed era).
* **Union Square, run 3 (`build/street-objects/e327b5f58475`).**
  * An ornate cast-iron lamp post (`one/40`): IoU 0.815 against 0.33; ΔE 7.8 against 23.1.
  * A traffic signal pole with an NYPD camera (`one/230`): IoU 0.387 against 0.191.
  * A row of ribbed concrete planters (`row/460`): IoU 0.599 against 0.52.
  * 6 kept as scanned, each with its numbers (a planter whose colour came out further from the photos; one whose silhouette was no closer).
  * Run 2 had rebuilt the white T-profile flexible bollards: IoU 0.442 against 0.139, ΔE 10.6 against 55.6.
* **Earlier: Penn run 3's bin row** passed the old rule (IoU 0.243 against 0.218). The IoU floor added since would keep the scan.
* **The keep rule (MAIN, 2026-11-03):** the reference is the Street View crop. The rebuild must beat the scan's blob on both silhouette IoU (and reach at least 0.3) and colour ΔE, both measured. The saved Penn and Union Square runs, re-judged under it from their recorded scores, keep the same decisions.
* **Unit tests.** `packages/core/test/street-objects.test.ts`, 25 tests, no network or model:
  * profiles from exact ray-marched silhouettes: radius within 1 cm at 12 m, a 0.25 m pose offset taken up, a 10% scale error cancelled by the scan's height, a hidden foot;
  * a panel's offset;
  * round against flat from two sides;
  * families from synthetic clusters: an 11-member bollard row at 1.5 m pitch with its gap found within 6 cm, lamps, a bench, uneven planters, an artefact;
  * the split of a melted row (5 posts within 6 cm);
  * a bench's front outline (legs, seat, back);
  * specs through the validator;
  * the instanced layer GLB;
  * the photos' height rule;
  * the band partition.

---

## 3. What Broke / Didn't Work

* **The vision model's masks.** Asked for Gemini-style `box_2d` + `mask`, gemini-3.8-flash returns strings that start like PNGs, but their CRCs fail and inflate fails: it writes the bytes as text. Fixed by cutting the masks with the app's segmenter, in memory.
* **A narrow view along a row sees the nearer members.** Penn's bin row: the photo's bin stood about 13 m away while the view aimed at the member at 22 m, so the mask was twice the rebuild's height. Fixed by casting each mask's foot to the ground and giving the view to the member it stands on (or rejecting it).
* **"Temporary" given to views that show nothing there.** Fixed: a family no usable view shows is `not-seen`, with the capture months as the era note, before the permanence question.
* **Weak matches were kept.** The handrail was rebuilt as a solid of revolution and kept at IoU 0.078 against the scan's 0.036. Fixed: a keep needs IoU ≥ 0.3 too, and long objects are built from their front outline.
* **The scan's occluders were wrong in the photos' era.** At Penn the scan's slab in front of the bollards is gone in the photos, and hid the rebuild's middle in the check. Fixed: both arms are drawn whole; the photo's mask already leaves out what really hid the object.
* **A hidden foot was filled from one cut row** (a 6 cm stem on a bollard). Fixed: the median of the nearest read heights.
* **A melted blob's height is not the object's.** The Penn bin's blob is 1.43 m tall; its photos agree on 0.91 m. Fixed: the photos' height is taken, labelled photo-inferred, where the views agree with one another and differ from the scan by more than their poses could err.
* **Overlapping colour bands crashed a run** ("Cannot read properties of undefined (reading '1')"): a body band plus a stripe inside it left an empty band. Fixed: the bands are a partition of the height, and one family's failure is reported without stopping the district.
* **Two runs at once stalled in the grounding fetch** with no connection open: the service waits for its OAuth token before any per-image limit applies. Each batch now ends after 180 s, with the reason; the runs were made one at a time.
* **The machine was at load average 270–550** from other sessions. The registration's joint fit ran out of its budget once; the tool now gives it three times the staged build's time.
* **The eye-level camera stood inside geometry.** Fixed: it stands on the line from the member back to its pano.
* **Penn's 7th Ave west sidewalk** is under a sidewalk shed in the tiles. Most clusters there are blocked in the scan from every pano, or Street View shows nothing there. They are reported `not-seen`.

---

## 4. Candidate Tool/Service Ideas

* **A registration for narrow views:** register each pano once from a wide view and carry its pose to every narrow view of that pano. Done here by hand, with one context view per pano.
* **The splice (PR 2):** take the kept rebuilds into the K-D build behind a switch, take out the blobs, and fill the ground through the infill service.

---

## 5. Reproduction Steps

1. Start the `scratchbox-street-objects` launch entry (operate-scratchbox).
2. `POST http://127.0.0.1:3791/gemini/tools/run-stream` with `{"name": "location_street_objects", "args": {...}}`:
   * `auditJson`: the scene_inventory run note's `audit` (district_audit.json);
   * `scanGlb`: the tree strip's `devegetated.glb`;
   * `tileGlb`: the extraction's `textured_tile_seams_2.glb`;
   * `lat`, `lng`: the build's anchor;
   * optional: `only` (family ids), `maxImages`.
3. Read `build/street-objects/<key>/street_objects.json`, the `<family>_eye_before.png` and `_eye_after.png` pairs, and the `<family>_<n>.png` outline overlays.
