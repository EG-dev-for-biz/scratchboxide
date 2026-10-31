# Process: Matching a reference photo's look onto the 3D viewport's objects (the Empire State Building twin)

> **Recorded:** 2026-10-31
> **Status:** Verified (the match, the refit, the sky left alone, the segmenter route and its typed not-found error, in the live app on the ESB pipeline K twin); Unverified (the "Selected object" mode, a scene with splats, lens distortion on)
> **Target domain:** 3D Scene viewport / optics chain output pass / Colour harmony panel
> **Tags:** `operate-scratchbox`, `look-match`, `color-grade`, `reference-photo`, `segmentation`, `empire-state`

## What was built

Step 1 of the reference-photo look match (`services/postprocessing/look-match.ts`):

- **Measure.** Both sides are measured in Oklab on display colours (the photo as stored, the viewport as shown), in 9 bands of equal pixel count by lightness. Each band records its median lightness, its mean colour (a, b) and the spread of colour about that mean. The photo can be the whole image, or the part a description picks out, cut out by the open-vocabulary segmenter (`POST /api/color-match/segment`, `desktop-app/server/routes/colorMatchRoutes.ts`, over `ObjectSegmenterService`). The viewport side is the frame the canvas shows, read back by `ViewportOpticsChain.requestObjectSample`, with a mask of the scene's objects (depth, plus splat coverage) or of the selected object. It is never the sky.
- **Fit.** One knot per band, at the same rank on each side:
  - lightness goes to the reference's: a tone curve, its slope held between 0.25 and 4;
  - the mean colour goes to the reference's: the cast of each tone;
  - colour about the mean is scaled by the ratio of spreads (0.25 to 3). Where the render is colourless (spread under 0.004) the gain stays at 1, so noise is never amplified into colour.
- **Draw.** It runs in the output pass, after tone mapping and before the grain, because that is the domain the photo was measured in. It is weighted by an object mask (`renderObjectMask`, bent by the lens when distortion is on). The scene stores the fit as `Scene3DData.lookMatch`, keeping the photo's bands too, so **Refit to view** re-measures a new framing without the photo. Its strength and clearing go through `sb_set_look_match` (the chat can adjust a match but not make one).

## Live run

- **Instance:** `scratchbox-cartesian-normal-snapping` (web 3070, API 3071, tools 3072), this checkout. The twin `empire_state_building_350_fifth_avenue_n_iso_l2_tex_578981d4.glb` was opened by the chat into a new studio-void 3D scene.
- **Reference:** `public/test_esb_facade.jpg`, a Google Street View photo of the ESB from 34th Street under broken cloud. It was matched with the target "the Empire State Building"; the segmenter answered 200 in about 60 s, with Gemini placing the prompts.
- **First fit, measured at a far framing:**
  - object pixels' mean display RGB went from 129.8, 123.2, 120.3 to 100.2, 101.9, 101.9;
  - luminance P10/P50/P90 went from 84/122/169 to 44/98/168: cooler, deeper shadows, the twin's yellow cast gone;
  - sky pixels' mean absolute difference: **0.000**.
- **After the camera moved closer**, the old fit undershot the photo's lightness by up to 0.07 in the upper bands. The fit is made against one view.
- **After Refit to view**, every band's lightness and mean colour matched the photo's to within 0.001:

| Band | Photo L, a, b, spread | Matched view L, a, b, spread |
| --- | --- | --- |
| 1 | 0.227, -0.004, -0.002, 0.016 | 0.227, -0.004, -0.002, 0.002 |
| 3 | 0.414, -0.002, 0.000, 0.013 | 0.414, -0.002, 0.000, 0.005 |
| 5 | 0.498, -0.001, 0.002, 0.013 | 0.498, -0.002, 0.002, 0.012 |
| 7 | 0.577, -0.002, -0.001, 0.013 | 0.577, -0.001, 0.000, 0.013 |
| 9 | 0.786, -0.001, -0.005, 0.012 | 0.785, -0.001, -0.004, 0.012 |

  In the three darkest bands the spread stays low (0.002 to 0.005 against the photo's 0.013 to 0.016). The twin's shadows have almost no colour to scale, so the gain is held at 1 there by design.
- **Error path:** `target: "a red giraffe"` gave a 422 `SegmentTargetNotFoundError` ("There is no giraffe in this urban street scene") in 8 s, and the panel shows the message.
- **Console:** no errors from the grade, the panel or WebGL. Connection-refused errors appeared only while the backend was still starting.
- **Screenshots** (gitignored): `docs/screenshots/look-match/esb_unmatched.png`, `esb_matched.png` and `esb_panel.jpg`.

## Candidate Tool/Service Ideas

- **Refit as the camera settles.** A fit is made against one framing and drifts when the view changes (0.07 in L here). Re-measure the view, against the stored photo bands, when the camera stops moving.
- **Measure the hero only by default.** The ESB scene is the building alone, but a staged location includes street and neighbours; "All objects" then mixes them in while the photo's mask is the building. Default the viewport side to the object the photo's target names.
- **Make a match from the chat.** The chat can only adjust or clear a match. An operator that takes a workspace image path, plus the segment route, would let "match it to this photo" work from the chat.
- **A `scene_3d_load_model` dev path.** Opening an existing GLB needed a chat turn, whose `mount_canvas_primitive` call failed once, as the chat itself said. A direct "open this GLB" action would make tests like this one cheaper.
