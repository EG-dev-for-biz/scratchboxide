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
* **A rebuild kept by the check (Penn run 3, `row/154`, bins at a 9.2 m pitch).** Silhouette IoU 0.243 rebuilt against 0.218 scanned; colour ΔE 2.5 against 25.8. The eye-level render shows a clean, dark, flared bin where the scan had a lump. That run had no IoU floor; with the floor (0.3) it would stay scanned. See section 3.
* **Unit tests.** `packages/core/test/street-objects.test.ts`, 23 tests, no network or model:
  * profiles from exact ray-marched silhouettes: radius within 1 cm at 12 m, a 0.25 m pose offset taken up, a 10% scale error cancelled by the scan's height, a hidden foot;
  * a panel's offset;
  * round against flat from two sides;
  * families from synthetic clusters: an 11-member bollard row at 1.5 m pitch with its gap found within 6 cm, lamps, a bench, uneven planters, an artefact;
  * the split of a melted row (5 posts within 6 cm);
  * a bench's front outline (legs, seat, back);
  * specs through the validator;
  * the instanced layer GLB.

---

## 3. What Broke / Didn't Work

* **The vision model's masks.** Asked for Gemini-style `box_2d` + `mask`, gemini-3.8-flash returns strings that start like PNGs, but their CRCs fail and inflate fails: it writes the bytes as text. Fixed by cutting the masks with the app's segmenter, in memory.
* **A narrow view along a row sees the nearer members.** Penn's bin row: the photo's bin stood about 13 m away while the view aimed at the member at 22 m, so the mask was twice the rebuild's height. Fixed by casting each mask's foot to the ground and giving the view to the member it stands on (or rejecting it).
* **"Temporary" given to views that show nothing there.** Fixed: a family no usable view shows is `not-seen`, with the capture months as the era note, before the permanence question.
* **Weak matches were kept.** The handrail was rebuilt as a solid of revolution and kept at IoU 0.078 against the scan's 0.036. Fixed: a keep needs IoU ≥ 0.3 too, and long objects are built from their front outline.
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
