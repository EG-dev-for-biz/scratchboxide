# Process: Walk and run at street level in the Scene3D viewport, tested on the Penn Station K-D district

> **Recorded:** 2026-11-03
> **Status:** Verified (walk, run, kerb, wall slide, frame cost, live in the app). Not covered: pointer lock and Esc in a visible window (the pane was hidden throughout), a whole-frame interval on an unloaded Mac
> **Tags:** `operate-scratchbox` `viewport` `walk-mode` `collision` `bvh` `penn-station`
> **Target Domain:** Generative Canvas / 3D Viewport

---

## 1. Session Context

* **What prompted this session:** the user judges districts by eye and asked for a walk / run mode to explore one at street level (where texture smear and debris show).
* **Instance used:** branch `feat/viewport-walk-mode` (worktree on 3DTESTING), web port `3740`, API port `3741`, tools port `3742`, launch entry `scratchbox-feat-viewport-walk-mode` (`SCRATCHBOX_ASSET_STORE_SWEEP=0`).
* **Scope tested:** the Walk button and Shift+F, walking, running, the ground follow, the step up a kerb, the slide along a facade, the HUD, and the frame cost, on the Penn Station K-D staged build (run `30345545`): the textured district `penn_station_ny_l2_tex_8d879137.glb` (777,516 triangles in 686 meshes), its terrain and its trees, opened from a `.3d` scene file through the files explorer (no build was run).

---

## 2. What Was Tested & What Worked (Verified)

The proof sheet: `docs/screenshots/2026-11-03-viewport-walk-mode-proof-sheet.png` (gitignored; also in the session notes folder).

* **Entering** — the Walk button (and `__SB_WALK__.start`) → the walker stands on the surface under the screen centre with the eye 1.70 m above it; 258 ms (the drop ray and the first four collision trees).
* **Walking a sidewalk** — `KeyW` held through the app's own frame loop, along Madison Square Garden's 8th Ave facade → 1.39 m/s (5.62 m in 4.04 s of frames); the HUD read "Walking · 1.4 m/s · frame 21.9 ms (46 fps) · walk 0.88 ms".
* **Running down 8th Ave** — `ShiftLeft` + `KeyW` through the frame loop → 20.35 m in 4.07 s of frames = 5.00 m/s (131 frames, longest 53 ms). Fixed 1/60 s steps: 25.00 m in 5 s.
* **Stepping up a kerb** — walking from the street onto the sidewalk → the feet rise 0.47 m over the scan's sloped kerb, the last 0.15–0.20 m in one frame (live, two passes at the same spot: 1.707 → 1.906 m); the eye eases up over ~0.25 s; bollards on the kerb stop the body.
* **Sliding along a facade** — W+A, 45° into the Garden's wall → 1.40 m/s until the body meets it, then 0.94 m/s along it, 0.3–0.4 m off the face (the face measured by rays at n ≈ 21.7 m).
* **Frame cost** — the app's whole frame by GPU timer query (`__SB_VIEWPORT_COST__.measure`, 1451×802, 215 draws, 492k triangles in view): 6.9 / 11.6 ms p50 / p95 on 8th Ave, 5.4 / 7.8 ms on the sidewalk. The walker's own CPU cost a frame (300 steps each): running 0.2 / 0.6 ms, walking 0.4 / 0.8, sliding 0.6 / 1.1 (p50 / p95), worst 4.1 ms; 0–40 triangles tested a step. Collision trees for the whole district: 663 geometries, 649k triangles, 432 ms in all, built only as the walker nears each. Whole live frames ran p50 26–30 ms, p95 ~47 ms with the Mac at load ~760 (other sessions' suites).
* **A first fix found live** — gathering the meshes near the walker checked all 712 meshes' visibility and matrices every step (0.74 ms); it now looks closely only at meshes whose last-measured box comes within 50 m, every box re-measured at the twice-a-second refresh (0.12 ms; refresh 0.8–1.7 ms).
* **A second fix found live** — the HUD used Tailwind classes the app does not compile (its stylesheet is hand-written); it is styled inline now.

---

## 3. What Broke / Didn't Work

* **Frame timing in the hidden Browser pane** — nobody had this session open, so the page ran as a background page: `requestAnimationFrame` fell to 1–2 a second for long stretches (frames up to 1 s). The walker takes at most 0.1 s a frame by design (a stalled tab resumes where it was), so throttled runs cover less ground; the speeds above come from unthrottled stretches, and the frame costs from the GPU timer query and from timing the walker's own steps. For the live frame intervals, `requestAnimationFrame` was driven from a zero-delay timer for a few minutes, then restored.
  - Console evidence: none.
* **An unexplained drift once** — between two runs the walker once ended 9 m from where it stood; not reproducible in later idle and walking runs (the shared pane may have had other input). Watch for it.
* **Opening a 3D canvas runs the app's automatic visual check** (one `gemini-3.8-flash` call per open or reload; three in this session). Not caused by this change.

---

## 4. Candidate Tool/Service Ideas

* **Open a scene file by path** — the Spotlight file list is a fixed default list; opening the `.3d` file needed the sidebar's files explorer, found by script. A `?open=<workspace path>` or a Spotlight search over the real workspace would replace that.
* **Save a canvas capture** — this session posted base64 JPEGs through `/workspace/create-file`; a viewport "save frame" hook (canvas and HUD together) would replace it.
* **A walk recording** — replaying a held-key path at fixed steps would make before/after street-level comparisons of two builds exact.

---

## 5. Reproduction Steps

1. Copy `penn_station_ny_l2_tex_8d879137.glb`, `penn_station_ny_terrain_a8dad101.glb` and `penn_station_ny_trees_43e31057.glb` into the worktree's `public/models/` (symlinks are not served).
2. Write a `.3d` file in `desktop-app/` holding Scene3DData with those three as `objects` (`content.durableUri: /models/<file>`, role `environment`, `geoAnchor.active: false`), start the launch entry, open the file from the files explorer.
3. Press the toolstrip's Walk button (or Shift+F with the pointer over the street), then WASD, Shift to run, F to fly, Esc to leave.
