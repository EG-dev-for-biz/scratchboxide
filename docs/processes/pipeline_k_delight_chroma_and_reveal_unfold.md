# Process: Pipeline K's de-light kept the photo's colour, and its reveals stopped drawing each window twice

> **Recorded:** 2026-11-02
> **Status:** Verified offline on the ESB's K build: measured, rendered and tested; typecheck passes. Unverified: not yet
> judged, and not yet seen in a fresh build. The [second preregistration](./2026-11-02-k-step-ablation-2-prereg.md) judges
> both changes.
> **Tags:** `pipeline-k` `twin-delight` `facade-lattice` `photo-match` `empire-state`
> **Target Domain:** Staged locations / pipeline K: `tile-refine-twin.ts`, `facade-lattice.ts`, `staged-build-steps.ts`,
> the orchestrator

---

## 1. Session Context

- **What prompted it.** The [K step ablation](./2026-11-02-k-step-ablation-prereg.md) judged its one paid call on only 2
  views, so it was indicative. Its stage cuts put 1.17 of K's 1.83 overall gap to the raw scan in the twin's de-light. In
  the judge's grids K's facade was flat light grey, and before the twin the windows were drawn twice. The parent session
  (relaying "Do what you think is best") asked for three things:
  - fix the de-light's colour loss as a bug;
  - add an off switch for it;
  - find and fix the doubled windows.
- **The de-light was already diagnosed.** The session "K at the ESB: paler than the raw scan, storefront lost" (branch
  `claude/hopeful-euler-0e3755`, [its record](./pipeline_k_twin_delight_no_shadow_lift_esb.md)) had found and fixed it on
  2026-11-01, but never opened a PR. Its two fix commits are picked onto this branch unchanged:
  - `0866e73a`: no shadow lift for pipeline K, `PIPELINE_K_SHADOW_LIFT = 0`;
  - `9e332b56`: harmonising in logs over a 0.03 floor.
- **No build and no model call.** Every measurement here is offline, on K default's own build (runs b9684a9b, 15a376d6 and
  61b8974b) and its stage files.

## 2. What Was Tested & What Worked (Verified)

### The de-light: what it did to the colour, and the switch

- **The cause, in the code.** `delightLinearRgb`'s shadow lift blends each channel of every texel darker than about a third
  of white toward a grey of `1.6 x luma + 0.14`. A blend toward grey removes chroma as it lightens. The highlight
  compression only multiplies RGB by one factor, so it keeps the hue.
- **Measured.** K's polish output (stage cut S2, the twin's input) was de-lit offline with the twin's own code. Harmonising
  and material regions were left out, so the de-light is the only difference. CIELAB is over the 26.6 M texels the twin
  classes as wall:

  | Texture | L* | L* spread | Chroma C* | Hue |
  |---|---|---|---|---|
  | The photo (the twin's input) | 37.16 | 19.61 | 6.75 | 40.8° |
  | Old de-light (shadow lift 0.60) | 51.62 | 11.82 | **2.85 (−58%)** | 46.9° (+6.1°) |
  | **Fixed: no shadow lift, highlights compressed** | **37.11** | **19.59** | **6.76 (+0.1%)** | **40.5° (−0.2°)** |
  | De-light off | 37.11 | 19.61 | 6.76 | 40.5° |
  | K as built (old de-light, harmonised, material regions) | 51.44 | 12.06 | 2.94 | 46.0° |

  - The fixed de-light keeps the photo's chroma and hue.
  - The 0.2° left is the twin's re-encode of the photos: the de-light off shows it too.
  - Rendered from the judged view VqOxFz9R, the old de-light greys the stone and lifts the storefront glazing to grey; the
    fixed one keeps both.
- **The switch** (commit `3613d705`):
  - **How to turn it off:** `twin.delight` in the node graph's toggles (`TOGGLEABLE_STEPS`, with a `BUILD_STEPS` entry so it
    is drawn), or `SCRATCHBOX_K_DELIGHT=0`.
  - **What off does:** the photos are kept as captured (`tileRefineTwin` `delightOff`), the twin's cache key gets
    `asCaptured`, and the provenance reads "as captured: not de-lit (the de-light turned off for this build)".
  - **The step log:** on, the twin logs `twin.delight` running and done.

### The doubled windows: the reveals repeated each opening's edge

- **Where it shows.** Seen at an angle from the street (pose G8sOFZp8, the 34th St podium, 46 m, looking up 12°), every
  window on K's rebuilt facades was drawn twice: the dark window, and an offset dark frame beside it. This holds in K's
  polish output, before any twin step.
  - The scan (raw, S1), K with the lattice off and K with the window fit off show none of it.
  - Face on, the lattice's redrawn texture (`repeatTexture`) is clean against the straightened photo. So the doubling is in
    the faces, not the texture.
- **The proof.** The same model rendered with the lattice's 448,331 side triangles (reveals, bevels, steps) left out loses
  the ghost frames.
- **The cause** (`facade-lattice.ts` `sideS`, `sideT`):
  - Every reveal and step face was textured by unfolding the *recessed* side's photo from the arris.
  - So the first reveal-depth of the opening's own texels, its dark frame, was drawn on the reveal and again on the recessed
    face behind it.
  - That choice dates from `9284a058` (2026-10-27), made to avoid smearing one line of texels across the face.
- **The fix** (commit `e5eb1f47`):
  - A reveal is the proud part's material seen edge on. So it now takes the *proud* side's photo, unfolded from the arris by
    the surface's distance from it: the bevel's `c·√2`, then the face's depth. The result is clamped to the photo.
  - Still unfolded, never one texel line.
  - `facade-lattice/20`, so no polish cached with the old mapping is served again.
- **Rebuilt offline on the ESB build's own inputs.** `rebuildFacadesOnLattice` ran on tile_refine's remesh, the
  straightened orthos, the window fit, the wall grammar, the sheets and the raw scan: 66 facades rebuilt, 202,953 cells, as
  in the build. Seen from G8sOFZp8, the reveals now take the stone's colour and the offset dark frames are mostly gone.

### Tests and checks (credentials unreachable)

- **`pipeline-k-roof-delight.test.ts`**, 2 new tests:
  - K's de-light keeps a storefront photo's mean CIELAB chroma within 3% and its hue within 1°, where the default lift loses
    over a quarter of the chroma;
  - the switch leaves the photos byte for byte, logs no `delight` step, and says "as captured".
- **`facade-lattice.test.ts`:** the reveal test now also pins the direction, the deepest texels on the proud side of the
  arris. It was checked to fail on the old mapping.
- **The related files:** `staged-build-steps-graph`, `pipeline-k-photo-recess`, `pipeline-k-material-regions`,
  `tile-detail-bake`, `wall-grammar`, `staged-fast-first`, `tile-refine-twin-recreate` and `pipeline-k-texture-harmonize`.
  93 passed and 2 were skipped.
- **`instruction-tool-drift.test.ts`:** 96 passed.
- **`npm run typecheck`:** exit 0.

## 3. What Broke / Didn't Work

- **An edge measure could not show the windows fix.** It measured the build's edges against the raw scan's render at the
  same pose.
  - The scan's render is soft, so every build edge lies about 10 px from it, before and after.
  - It cannot tell a ghost edge from a real one. The proof is the face-removal render and the before/after, and the judge
    decides.
- **Not fixed here: the podium's thin ledges.** The lattice gives each storey row its own measured depth, so the podium steps
  0.1 to 0.3 m from row to row, and each step draws a ledge.
  - The outline diagnosis (2026-11-01) named the same spread, 0.8 to 1.3 m across a sheet's rows at the podium corner, as
    needing its own look.
  - It is geometry. The second preregistration's lattice arms judge it.
- **White slivers at some window corners in the polish output.** They appear where side faces meet without a mitre. Seen,
  not chased.

## 4. Candidate Tool/Service Ideas

- **Rebuild one stage offline from a run's own inputs, behind a call.** This session wrote two scratch scripts for it:
  `tileRefineTwin` with steps switched, and `rebuildFacadesOnLattice` on the run's tile_refine and ortho files. With such a
  call, "does this change fix that build" is one call, not a fresh build.
- **The judge's registered camera written into its report**, so any later model can be rendered from exactly the pose a
  paid call judged. The renders here use the pano's position, with the eye 2.5 m over the terrain.

## 5. Reproduction Steps

1. Branch `fix/k-twin-delight`. The K build's cache is under this worktree's `.scratchbox/cache` (runs above).
2. De-light: `vite-node delight_measure.ts <out>`, which de-lights S2 three ways and renders from VqOxFz9R.
3. Lattice: `vite-node lattice_offline.ts <out> <tag>` on the old and new `facade-lattice.ts`, and
   `vite-node reveal_test.ts <out>` for the side-face proof.

   Both scripts are kept in the session's scratchpad, with the images in `docs/screenshots/k_delight_fix_2026-11-02/`
   (gitignored; the proof sheet is `proof_sheet_fixes.png`).
4. Tests:

   ```bash
   env -i PATH="$PATH" HOME="$(mktemp -d)" ./node_modules/.bin/vitest run packages/core/test/pipeline-k-roof-delight.test.ts packages/core/test/facade-lattice.test.ts
   ```

## 6. Live viewport check (2026-11-02, afternoon)

- **The build:** this worktree's app instance (`scratchbox-k-step-ablation`, ports 3740-3742), the home starter "Build a 3D
  building of the Empire State Building at 350 Fifth Avenue". It gave a fresh K build, run 8fd4c24b: every stage uncached,
  533 s in all, every stage committed.
- **The comparison:** the in-app chat added run 1's K twin (`c95df7ef`, built before the fixes) beside it, 140 m east.
  - Both towers stand in one scene, under the same studio light.
  - The two twins' origins differ by 9.7 m and 12.7 m (different geocoded queries). They were matched, so each close-up
    uses the same camera offset from its tower.
  - Every image is the app's own scene capture, 1422 × 1209.
- **Facade colour:** on the south shaft, head-on at 70 m, the fixed K reads L* 35.0, C* 4.4, hue 36°. The old K reads L* 46.1,
  C* 1.6, hue 37°: flat pale grey against warm stone and brown spandrels.
- **Reveals:** a window bay at 10 m, 46° off the face.
  - The old K draws a second, offset edge beside each window and a doubled sill line. The fixed K draws one.
  - **Seen in both builds, not touched by these fixes:** bright outlines round the glass panes (one notched) and a diagonal
    seam across the bay. They are left for a later look.
- **Proof sheet:** `docs/screenshots/k_delight_fix_2026-11-02/proof_sheet_viewport_before_after.png`. The captures are in
  `viewport/`.
- **Cost:** the build's vision calls were 371 flash and 25 argon, about $0.85 at the estimates' rates. The chat turn cost
  cents.
