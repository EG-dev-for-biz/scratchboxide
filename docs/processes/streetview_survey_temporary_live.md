# Process: streetview_survey checkTemporary — temporary structures in Street View views

> **Recorded:** 2026-10-19
> **Status:** Verified for the survey (13 places surveyed, flagged views checked by eye on contact sheets, two real swaps); texture-pass flag: see section 3
> **Tags:** `operate-scratchbox` `location-evidence` `street-view` `vision` `temporary-structures`
> **Target Domain:** Gemini Agent Chat / real-world locations

---

## 1. Session Context

* **What prompted this session:** Street View captures taken while scaffolding, a sidewalk shed or netting stood in front of a building paint it onto the texture. `streetview_survey` gained an option, `checkTemporary` (default false), that asks the vision model chain about every view, replaces a flagged view by a clear capture of the same face from another month when one exists, and writes the flagged regions as masks.
* **Code:** `packages/core/src/node/3d-engine/staged-location/temporary-structures.ts` (question, parsing, masks, the swap, the texture-pass helper); `streetview-survey.ts` (option, result fields); `streetview-evidence.ts` (`discoverPanos` now also lists the panos its 6 m thinning dropped, `superseded`: an older capture next to a newer one); `orchestrator.ts` (texture pass, only with `SCRATCHBOX_SURVEY_TEMPORARY=1`).
* **Instance used:** web `3072`, API `3071`, tools `3073`, started from the worktree with `npm run dev` and env vars, `SCRATCHBOX_PYTHON` set to the checkout's `.venv`. The handler was also run from a script (same code, same caches) to keep the payloads for contact sheets.

---

## 2. What Was Tested & What Worked (Verified)

* **The question.** One call per view: is anything temporary covering the building or standing in front of it (the prompt gives examples only; the description is free text, never branched on), confidence, outlines as `[y, x]` in 0..1000, and the share of the photo the building's outside occupies. A view is flagged at confidence ≥ 0.5. Replies are recorded in the staged reply cache, so a rerun of the same images makes no new call.
* **True positives, checked by eye** (`*_views.png` contact sheets, regions in magenta):
  * Flatiron Building: all 6 views (2024-09 and 2026-04) show the facade scaffolding, hoists and netting; the outlines follow it.
  * Woolworth Building: the green sidewalk shed on the 31° and 211° faces (3 views).
  * Grace Church: the blue-netted scaffolding on the 180° face; the outline follows the netting.
  * The Ansonia: a sidewalk shed (2026-04) and another shed with a hoist mast (2026-08) in front of the 119° face.
* **True negatives:** Washington Square Arch (first run), the Dakota, the Haughwout, the Chrysler Building, Cooper Union, the Puck Building: no flag, and none visible in the photos.
* **Swaps (real):** at the Ansonia both flagged 119° views were replaced by clear captures of the same face (2026-04 → 2026-08, and 2026-08 → 2026-04); before and after in `ansonia_swaps_before_after.png`. The agent's report: `ansonia_result_card.jpg`.
* **Kept and flagged:** Grace Church 180° (no eligible pano of that face from another month), Woolworth 31° and 211°, all Flatiron faces (their other months are also under scaffolding, or are indoor panos). The agent's report: `grace_result_card.jpg`, `grace_result_card_faces.jpg`.
* **Off-face flags are not swapped.** In the second arch run (agent, with ownership masks) one view was flagged for "temporary metal crowd-control barriers at the base of the arch on the right", confidence 0.72. The barriers stand beside the arch, not on it: less than 20 percent of the outline lies on the view's own face, so the view was kept and listed under `offFace`; the region took no pixel out of the owner mask (`arch_view5_barriers_flagged.png`, `arch_result_card.jpg`).
* **Per face:** `coverage[].temporary` gives `free` (no view that sees the face has a flagged region on it), `bestViewFree`, `flaggedViews` and `uncheckedViews`. Which face a region lies on is decided from the structure mesh's depth and normals in the view, not from the footprint rectangle (that was too coarse on the synthetic street).

---

## 3. What Broke / Didn't Work

* **Indoor panos replaced the scaffolded views (fixed this session).** The first Flatiron run swapped all 6 views for 2010–2014 "clear" captures that were indoor business panos (a wallpapered wall, a ceiling). The question now also asks the building's share of the photo, and an alternative counts only with at least 15 percent and half the flagged view's share. On the rerun every indoor pano was rejected ("0 percent of the photo") and the Flatiron views were kept and flagged.
* **A swapped-out pano was offered again (fixed).** At the Ansonia the 2026-04 pano replaced for its shed was then tried as the alternative for the other flagged view of the same face. It is now excluded.
* **The share rule is strict at the Woolworth.** Its 2024-05 alternatives show the face at 42 and 28 percent of the photo against a 45 percent bar (half of the flagged view's 90); they were rejected, so the shed views stand flagged. A looser bar would have swapped in views that are mostly a neighbouring glass tower.
* **Run-to-run variation:** the first arch run had no flag; the second flagged distant crowd barriers at 0.72 (off the face, so harmless).
* **Misses:** at the Jefferson Market Library view 0 (2024-09) shows green netting at its right edge and was read clear. At the Ansonia the 2026-08 hoist mast was not outlined (the shed was).
* **Old captures:** the metadata endpoint returns only the newest pano at a point, so another month is only found where a nearby point resolves to a different pano (or in the panos the discovery thins out). At the Flatiron those were mostly indoor panos.
* **Texture pass (`SCRATCHBOX_SURVEY_TEMPORARY=1`), live:** two isolated staged builds of Grace Church through the agent ("Use google_3d_tiles_get_clay on "Grace Church, 802 Broadway, New York" with isolate true"). The texture pass asked about every Street View close-up and wrote the run note `texture_temporary`:
  * With the ownership step on (run `45b3b0a8`), 1 of 3 close-ups was flagged ("scaffolding and blue construction netting on the left side of the church", 0.96), but the ownership step had already refused all three views (the structure not in the photo, or IoU 0.25), so the regions had no owned pixel to remove (`maskedPixels` 0, as it should).
  * With `SCRATCHBOX_TEXTURE_OWNERSHIP=0` (run `6147a82b`), 2 of 4 close-ups were flagged and their regions took 278,398 and 368,693 pixels out of the views (`maskedPixels`).
  * In both builds the no-fit rung then set Street View aside on its held-out gate (unrelated to this change), so the layers were textured from the tile photo. Screenshots: `grace_staged_build_flag_on.jpg`, `grace_staged_build_flag_on_ownership_off.jpg`. Without the flag nothing changes (the step is skipped, and the cache key is unchanged).

---

## 4. Candidate Tool/Service Ideas

* **Historical panoramas by id.** A face whose every recent capture is under scaffolding (the Flatiron) needs older outdoor captures at the same spot; the metadata endpoint cannot list them.
* **Keep tool payloads in the session record** (again): the contact sheets needed a script rerun of the handler.

---

## 5. Reproduction Steps

1. In the worktree, symlink `secrets.json` (remove it afterwards). Start the app with `SCRATCHBOX_PYTHON=<checkout>/.venv/bin/python SCRATCHBOX_NO_ELECTRON=true PORT=3071 SCRATCHBOX_WEB_PORT=3072 SCRATCHBOX_TOOLS_PORT=3073 SCRATCHBOX_ALLOWED_ORIGINS=http://127.0.0.1:3072 npm run dev` and open the token URL.
2. Ask: "Use the streetview_survey tool on "The Ansonia, 2109 Broadway, New York" with maxViews 6 and checkTemporary true."
3. Images and masks (`*_temporary.png`, 255 = a flagged region) are in `desktop-app/build/streetview-grounding/`. The synthetic test is `packages/core/test/streetview-survey-temporary.test.ts` (contact sheet in `test-results/screenshots/survey_temporary/`).
