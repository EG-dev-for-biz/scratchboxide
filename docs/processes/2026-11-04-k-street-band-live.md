# Process: Pipeline K street band, the lowest 12 m from registered Street View, live at Penn 2 and Herald Square

> **Recorded:** 2026-11-04
> **Status:** Needs Fix: the projection works and is gated as specified, but it textures 0–0.7% of the low wall at both places, because the photos' ownership cut-outs and framing leave almost no storefront texel to take
> **Tags:** `operate-scratchbox` `pipeline-k` `street-view` `texture` `provenance`
> **Target Domain:** Staged-location pipeline K (twin textures)

---

## 1. Session Context

* **What prompted this session:** texture pipeline K's lowest storeys from registered Street View (`pipeline-k/street-band.ts`), proven on uncached builds of Penn 2 and a Herald Square building at walk height.
* **Instance used:** launch entry `scratchbox-street-band` on this worktree: web `3470`, API `3471`, tools `3472`, with `SCRATCHBOX_K_STREET_BAND=1`. The cache was this worktree's own `.scratchbox/` and started empty.
* **How the builds ran:** `google_3d_tiles_get_clay` `{query, isolate: true}` went through the app server's tool endpoint, `POST /gemini/tools/run-stream`. That is the same handler a chat tool call reaches. The Browser pane's page could not get a chat stream out: its requests stayed pending.
* **Runs:**
  * Penn 2: `e4e94d74` (first build) and `9bb0dadc` (final code).
  * Marbridge Building, 1328 Broadway: `32a51c78` (first build), `a75c0b8c`, `7a459d44` (final code).
  * For the last two runs of each place, the textures stage and the street band ran fresh: their textures entries and the `street-band` readings were cleared. The earlier stages came from the first build's cache.

---

## 2. What Was Tested & What Worked (Verified)

* **The band's cut and its maps:** on both twins every lattice primitive with surface below 12 m was cut exactly at that height. Its band became a primitive of its own, with every map cropped to its rectangle and the base colour at 2.5 cm a texel (6x the tile photo). The part above keeps its maps. At Herald Square 4 bands were planned: 732 m² of the 1,003 m² low wall. At Penn 2, 18 bands: 5,573 m² of 9,057 m².
* **Survey:** 24 views were fetched per run (12 planned, each also aimed at street level), registered against the tile mesh, cut out by ownership masks and cleaned in memory. Nothing from Street View was written to disk: the clean step ran without its cache directory.
* **Refined poses only:**
  * Herald `7a459d44`: 24 of 24 views registered jointly (0.25–0.55 m).
  * Penn 2 `9bb0dadc`: 22 of 24.
  * Earlier runs: Penn 2 `e4e94d74` locked only 2 of 22 (edge residual stuck at the 12 px cap). Herald `32a51c78` ran out of registration time while the machine's load was 293.
* **Texels taken (final code):**
  * Herald: one photo (2026-04, joint 0.25 m, agreement 0.49 after a (−30, 15) texel shift, gain 1.34/1.34/1.53, 72 px/m) gave 7 m², 0.7% of the low wall.
  * Penn 2: none.
* **Labels:** the band's node carries `sbStreetBand`: the pano, its date, the method, the residual, the agreement, the shares, and a per-texel source texture. The twin's provenance gains a photo-inferred entry.
* **Store:** a projected band is kept as texels (`street-band/<sha256>`); a band no photo reached is not kept, so it is asked again next time.

## 3. What Broke / Didn't Work

* **Coverage.** Texel tests were refused for these reasons:

  | Reason | Penn 2 `9bb0dadc` | Herald `7a459d44` |
  | :--- | ---: | ---: |
  | Not the structure in the photo (ownership mask) | 40% | 23% |
  | Outside the photo | 30% | 35% |
  | Facing away (views of other faces) | 29% | 41% |
  | Hidden | 1% | 0.1% |

  Whole photos were also refused at Herald: 5 because their exposure could not be matched to the tile photo, 6 by the structure check.

  The cause is upstream of the projection:
  * The ownership cut-out excludes most of the storefront level, which a sidewalk shed, awnings, signs or the context mesh in front can explain.
  * The survey's views frame the whole face, so the band is often below their frame.

* **What was kept reads wrong.** In the last run the kept patch at Herald (facade 10006) is a storefront fragment on a smeared wall. An earlier run kept a window-sized patch that a 0.9 m shift had put in place (sheet, third row). Two guards came out of that run and are in this branch: a photo whose exposure cannot be matched is refused, and photo islands under 1.5 m² are dropped.
* **Ground floor not rebuilt on most Herald facades.** K's lattice reaches below 12 m on 4 of the 16 planned primitives. The rest of the street level is scan pieces, which this stage does not texture.
* **Sidewalk not textured.** It is the scene's ground, not part of the twin. The ownership mask covers only the structure, so sidewalk pixels would need a cut-out of their own.

Sheet: `docs/screenshots/street_band_2026-11-04/street_band_before_after.jpg` (gitignored). It shows a walk-height before/after (plain three.js render of the twin GLBs, not the app viewport), the band texture strips with labels, and the numbers.

## 4. Candidate Tool/Service Ideas

* **A street-level survey for the band:** views planned from the band's own texels (aimed at 3–6 m, closer panos, the face's own normal), not the face-framing survey.
* **An ownership mask for the band:** structure pixels below 12 m that the depth test already proves unoccluded by the tile mesh. People and vehicles are then masked by the segmenter alone, not by "outside the cut-out".
* **Scan pieces at street level:** cut and re-parameterised like the lattice band, so the ground floor the lattice leaves as scan can take Street View too.
* **`streetview-clean.ts` cache:** pipeline E passes `cacheDir`, which writes each cleaned Street View image as a PNG to disk. That conflicts with the memory-only rule.

Cost: about $2–3 for all five survey runs.

| Item | Cost |
| :--- | ---: |
| 116 Street View images at $0.007 | $0.81 |
| Vision calls priced in `model_calls.json` | $0.44 |
| About 18 clean-fill image calls (unpriced) | about $0.7 |
