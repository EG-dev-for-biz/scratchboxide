# Process: screen-space contact shadows for the sky's sun

> **Recorded:** 2026-11-03
> **Status:** Verified (live, the ESB pipeline-K build opened from disk; same cameras and canvas, before and after; a real-WebGL unit test). Not done: a district; frame cost; crawl while the camera moves.
> **Tags:** `operate-scratchbox` `viewport` `shadows` `contact-shadows` `post-stack`
> **Target Domain:** 3D Viewport / sky sun, post stack (aerial perspective pass)

---

## 1. Session Context

* **What prompted this session:** MAIN's queue after #40. Past the nearest cascade a shadow texel is a decimetre or more, so sills, cornices and mullions 50-200 m out cast nothing the shadow map can hold.
* **Instance used:** own entry `scratchbox-viewer-shadows`, web `4260`, API `4261`, tools `4262`. The ESB chat `session-chat-1793173055785` (run 9dea22a0), copied into the worktree, with its GLBs symlinked. No build was run.
* **Scope tested:** the contact shadow pass (`contactShadows.ts`) in the aerial perspective pass, on top of #40 (cascaded sun shadows, PCSS, GTAO).

---

## 2. What Was Tested & What Worked (Verified)

* **Real-WebGL unit test** (`contact-shadows.test.ts`, headless Chrome). A wall 60 m out under a coarse 256 px cascade map:
  - a 0.3 m ledge's shadow, which the map misses, is darkened to 0.20-0.35 (the sun's share of the wall's light is 0.81);
  - the same kind of ledge inside a canopy's shadow, which the map holds, stays at 1;
  - with the cascades out of the pass, that point is darkened (so the gate is what spares it);
  - open wall and sky stay at 1.
* **Live, ESB, four cameras** (sheet `docs/screenshots/2026-11-03-contact-shadows/contact-shadows-before-after.jpg`, gitignored):
  - **Where it darkens:** the darkening map shows lines under the base's cornices and ledges, beside the tower's piers, and in window reveals. The shaded north face is almost untouched.
  - **How much:** pixels darkened by more than 6 levels are S1 3.9%, S2 3.6%, A1c 1.7% and A3 1.1% of the frame, against a capture noise floor of 0.3-0.8%.
  - The `ContactShadows` program compiles, with no console errors.
* **Fixed in session:** normals rebuilt from depth are wrong at a depth jump, which drew a one-pixel false shadow along the tower's silhouette against the sky. Pixels whose neighbour lies more than 30 pixel footprints away are now skipped.

---

## 3. What Broke / Didn't Work

* **Operating slip:** a pane resize moved the layout under a coordinate click, which sent a chat suggestion ("Resolved Address:") as a prompt. It was stopped at once. The server log shows one routing model call and no tool calls. Clicks after that went by element reference.
* **Not covered:** a district, the pass's frame cost, and crawl while the camera moves (only still frames were checked).
* **Post, not lighting:** the pass works after shading, so it removes an estimated sun share (from the depth normal and the sun and sky intensities), not the sun term itself.

---

## 4. Candidate Tool/Service Ideas

* **Runtime switch for post passes** — a diagnostics hook to turn a pass (GTAO, contact shadows) off and on in the live viewport. This session swapped `syncAtmosphere.ts` between commits and waited for the hot reload instead.

---

## 5. Reproduction Steps

1. Open the ESB session as in `2026-11-03-viewport-sun-shadows-cascades.md`.
2. Use the same cameras: S1 `(115, 1.7, 115) → (30, 40, 60)`, S2 `(75, 1.7, 112) → (35, 22, 72)`, A1c `(200, 280, 200) → (10, 160, 10)`, A3 `(140, 110, -90) → (0, 25, -20)`.
3. For "before", check out `syncAtmosphere.ts` from `6657dfd4` (no contact pass is made).
