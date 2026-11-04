# Process: the sun's glare behind a building, and the probe that refitted the cascades

> **Recorded:** 2026-11-03
> **Status:** Verified (live, the ESB pipeline-K build opened from disk: before and after on the same walking path and still camera; real-WebGL unit test). Not covered: a district (the probe's per-frame cost there), a scene with lens flare set, god rays.
> **Tags:** `operate-scratchbox` `viewport` `sun-glare` `shadows` `contact-shadows`
> **Target Domain:** 3D Viewport / sky sun (SunGlare.ts), shadow cascades, post stack

---

## 1. Session Context

* **What prompted this session:** the user: "currently when the sun is obstructed by an object/building it slowly fades out rather than truly being obstructed."
* **Instance used:** own entry `scratchbox-viewer-shadows`, web `4260`, API `4261`, tools `4262`, from the `claude/viewer-shadows-2e1e9a` worktree on `fix/sun-occlusion-snap` (from main `d20e36d3`). The ESB chat `session-chat-1793173055785` (run 9dea22a0) copied in, its 11 GLBs symlinked. No build was run.
* **Before/after:** "before" is main's `SunGlare.ts` checked out over the branch and the page reloaded; "after" is the branch.

---

## 2. What Was Tested & What Worked (Verified)

* **The cause, read and then measured.**
  - **What lingers:** of the sun's effects, only the glare does. It measured the sun's geometry visibility every 4th frame, then eased toward it with a 0.2 s time constant.
  - **What doesn't:** the god rays never dim for geometry (they are depth-tested, and dim only with cloud). The lens flare reads the finished frame, so it follows the glare. The viewer has no bloom pass. Exposure is not eased over time.
  - **This scene:** it has no god rays and no lens set, so no flare, diffusion or temporal AA. With the glare switched off on main, nothing else glows on.
* **Walking path:** a street-level camera 266 m north of the tower, looking at the sun (36° up), moving sideways 0.2 m every 2 frames (about 6 m/s). The disc crosses the tower's edge between x = -27.1 and -24.6 m. Sheet: `docs/screenshots/2026-11-03-sun-occlusion/sun-occlusion-before-after.jpg` (gitignored); a copy is in the shared notes folder.

  | | Glare drawn when the sun is first wholly hidden | < 0.1 | < 0.01 |
  |---|---|---|---|
  | main | 0.37 | +283 ms | +750 ms (still 0.004 at +921 ms) |
  | fix | 0 | +0 ms | +0 ms |

  While the disc crosses the edge, the fix's glare stays within 0.1 above the measured share (1.00 / 0.98, 0.86 / 0.78, 0.53 / 0.45, 0.26 / 0.18).
* **Second bug, found while reading:** each probe was a full `renderer.render`, which drew every shadow map again and refitted the sun's four cascades to the probe's narrow view toward the sun. The contact shadows (#52) run after the scene draw and read those cascades.
  - **On main:** with a still camera, frames 4, 8 and 12 darkened 0.62% of the frame by more than 6 levels: lines under the base's ledges and beside its piers. The next frame restored them.
  - **With the fix:** 16 still frames are identical. The fix's frame matches main's non-probe frames (0.01% of pixels differ by more than 6 levels, JPEG noise) and not its probe frames (0.76%).
* **Frame cost:** render CPU per frame (mean / p95), 120 frames, with the outer `renderer.render` calls timed:

  | View | main | fix |
  |---|---|---|
  | corner view S1 | 7.6 / 11.2 ms | 6.4 / 7.0 ms |
  | edge view | 8.6 / 12.4 ms | 7.4 / 7.9 ms |

  - **GPU time** (`__SB_VIEWPORT_COST__.measure`, timer queries): 2.2-2.5 ms on both.
  - **The probe itself:** 0.38 ms a frame for the scene's 506 objects.
* **Unit test:** `sun-glare-occlusion.test.ts` runs on real WebGL with a fake 60 Hz clock while a wall's edge crosses the disc. It checks:
  - no glare from the frame the sun is covered, and back within 0.1 at once when it reappears;
  - half covered: the band's edge, then a glide to the measured share;
  - an edge jittering 0.8 probe pixels: the measured share swings by more than 0.04 and the glare by less than 0.01;
  - a 12-frame sweep: never more than 0.1 behind;
  - the cascades are only ever fitted to the view.

---

## 3. What Broke / Didn't Work

* **Not covered:**
  - **A district:** the probe now draws every frame, and its cost there was not measured. It walks the same objects the main pass and the four cascade passes do, so it should stay a small share.
  - **A scene with lens flare or god rays.**
* **Left as they are:**
  - The probe still draws alpha-tested leaves as solid quads (already noted in `sky_realism_benchmark_and_baked_sky.md`).
  - The god rays dim only with cloud, never with geometry, as before.

---

## 4. Candidate Tool/Service Ideas

* **Frame-strip capture:** a dev hook that walks the camera along a path one step a frame and records crops with timestamps and named uniforms. This session pasted one into the page and POSTed the frames to a local receiver.
* **Runtime switch for viewport effects:** for example `__SB_VIEWPORT_EFFECTS__.set('glare', false)`. This session hid the glare mesh by name.

---

## 5. Reproduction Steps

1. Open the ESB session as in `2026-11-03-viewport-sun-shadows-cascades.md` and collapse the build panel, chat and sidebar (canvas 1416 x 841).
2. **Walking path:** camera at (x, 1.7, -200) looking along the sun; x from -30 m in steps of +0.2 m every 2 frames.
3. **Still view:** S1 (115, 1.7, 115) → (30, 40, 60); compare 16 consecutive frames.
4. **Before:** check main's `SunGlare.ts` out over the branch and reload.
