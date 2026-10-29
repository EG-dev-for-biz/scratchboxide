/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

# Review: Vector Motion Graphics Engine — Implementation Plan

> **Recorded:** 2026-10-28
> **Status:** Review only — no code changed in this repo. Three reuse claims in §2 of the
> plan do not hold against current `main`; one claim in the §7 prior-art audit is stale.
> The plan's central thesis is **confirmed**.
> **Reviews:** [`VECTOR_MOTION_GRAPHICS_ENGINE_PLAN.md`](./VECTOR_MOTION_GRAPHICS_ENGINE_PLAN.md)
> **Tags:** `motion-graphics` `vector-ir` `keyframes` `remotion` `after-effects` `jb-chase`

---

## 1. Context

Reviewed from the `jb-chase` side, immediately after running the exact pipeline the plan
names as its motivating case: decoding an agency deck (Chase for Business "CBCB Offer
Assets") and shipping four 9:16 social spots as MP4 + GIF + editable After Effects
`.jsx`. The question asked was whether this repo could have done that work instead.

It could have done roughly **one of the seven steps** — the ffmpeg encode. That part of
the plan's self-assessment is accurate and is not the interesting finding. What follows
is what changed when the plan's §2 reuse inventory was checked line by line.

---

## 2. Confirmed: the gap is real, and the motivating problem is real

Verified against current `main`:

* **No `motion/` module** under `packages/core/src/common/` or `packages/core/src/node/`.
* **No `motion` CLI command.** `packages/cli/src/commands/` holds `attach`, `bake`,
  `branch`, `commit`, `diff`, `generate`, `init`, `matchmove`, `qa`, `rig`, `splat`,
  `status` — nothing else.
* **No Lottie or AE serializer** anywhere; no file matching `*lottie*`, `*ae-export*`,
  `*vector-scene*`.
* **Remotion is not a dependency** of this repo, in any workspace `package.json`.

So §1's claim that this is "a confirmed, audited gap — not a hidden duplicate" holds.

The motivating problem is also real, and was observed first-hand. In `jb-chase` the
rendered video comes from a hand-authored Remotion component and the AE script comes
from a **separate** Python exporter — two independent sources of truth for the same
keyframes. On 2026-10-28 that pipeline produced a live instance of exactly the drift the
plan predicts: the deliverable README documented the CTA as `#0B6EFD` and the score bars
as `#5BC0DE` / `#7CC242`, while the component actually rendered `#015EB8`, `#4DBBCC` and
`#77AC4F`. Documentation drifting from the keyframes it describes is the mild form; the
AE script silently diverging from the shipped video is the expensive form. One IR
compiling to both is the right shape of fix.

---

## 3. Three §2 reuse claims that need repair before they can be reused

§2 instructs: "**Import directly.** … Do not duplicate the interpolation math"
(plan line 47). Against current `main`, that import does not deliver what Phase 1 needs.

### 3.1 The shared evaluator has no bezier math — `cubicBezier` silently evaluates as linear

`packages/core/src/common/spatial/universal-animation-types.ts` declares the vocabulary
but never implements it:

* lines 36–37 — `'cubicspline' | 'cubicBezier'` in `UniversalInterpolationType`.
* lines 46–48 — `inTangent?`, `outTangent?`, `controlPoints?: [x1,y1,x2,y2]` on
  `UniversalKeyframe`.
* `evaluateAnimationTrack()` (line 152) **never reads any of those three fields.**

Trace a `cubicBezier` keyframe through the body: it is not `'step'` (line 178), not a
quaternion (`slerp`, line 184), so it reaches the scalar branch at line 190 and returns
`lerpScalar(...)` — a straight linear interpolation.

This is the single most important property for motion graphics. AE Easy Ease, and the
`BEZIER_PRESETS` (`easyEase`, `snappy`, `dramatic`) that `jb-chase`'s own
`remotion-ae-export` skill standardizes on, are all cubic-bezier eases. A Phase 1 built
on this evaluator as-is would render every "eased" move as a linear ramp while the IR
claims otherwise — which is precisely the "no loose-tolerance math" failure §8 commits
the plan to avoiding.

**Scope impact:** Phase 1 must add real cubic-bezier (and decide about `cubicspline`)
evaluation to a function that 3D node transforms and camera solves already depend on.
That is a shared-code change with regression surface, not an import.

### 3.2 No 2D support — a `[x, y]` value falls through to step/hold

The same function interpolates arrays **only** at `length === 3` (line 194). There is no
`lerpVector2` and no `length === 2` branch. A 2D position, scale or anchor point reaches
the final `return k0.value` (line 202) and therefore holds at the previous keyframe
instead of animating.

Phase 1's entire premise is 2D (`Transform2D`, `position`, `anchorPoint`). Either every
2D property is decomposed into scalar tracks at the IR boundary — which contradicts the
IR as written in §3, where `position` is one property — or the evaluator gains 2D
support. Worth deciding before the IR is frozen, not after.

### 3.3 The GIF path is single-pass — the plan's hedge resolves to "yes, fix it"

§5.2 (plan line 176) says to confirm the existing service's palette handling, "if it
currently does a naive single-pass GIF, that's a pre-existing gap worth fixing there."

Confirmed: it is single-pass.
`packages/core/src/node/video/HeadlessVideoEditorService.ts` lines 483–486 emit

```
fps=<n>,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse
```

at a default 15 fps — one pass, no `stats_mode=diff`, no dithering control. The
`jb-chase` standing dual-format rule uses a two-pass palette
(`palettegen=stats_mode=diff` → `paletteuse=dither=bayer:bayer_scale=3`). So the
conditional task in §5.2 is unconditionally in scope. It is a good fix — it improves
every GIF export in the product — but it is work, and it touches a 1,588-line shared
service.

### 3.4 What *does* hold

Both reuse targets are genuinely real code, not scaffolding:
`universal-animation-types.ts` is 460 lines of actual math (`lerpScalar`,
`lerpVector3`, `slerpQuaternion`, `evaluateAnimationTrack`, `evaluateAnimationClip`),
and `HeadlessVideoEditorService.ts` is 1,588 lines driving ffmpeg through real
`execFile` calls with binary resolution via `FFMPEG_PATH`. The plan is right that
neither should be rebuilt — only that both need extending first.

---

## 4. §7 prior-art audit: the anti-pattern example is stale

§7 (plan lines 241–244) cites `physics-animation-operators.ts` as the canonical hollow
scaffold — "(56 lines) … keyframes are pushed into an array and **nothing ever reads
them back during playback.** No interpolation evaluator consumes this data." §8 then
builds on that example as the pattern the plan must not repeat.

Against current `main` this is no longer true:

* The file is **80 lines**, not 56.
* `packages/core/src/browser/generative-canvas/primitives/scene3d/objectAnimationRuntime.ts`
  (578 lines) is an explicit per-frame consumer. Its header states it "reads that config
  every frame"; line 362 collects `mesh.keyframes` into playback records; line 498 calls
  `applyKeyframesToObject3D(object3d, record.keyframes, timeMs)`; `sampleChannel()`
  (line 526) does the interpolation; the section is commented "Keyframe playback (wins
  over simulated motion)" (line 492).

So keyframes authored by `sb_insert_keyframe` *are* read back and interpolated during
playback. A runtime consumer was added after the audit was written.

This does not weaken the plan — §2's gap finding was independently re-verified above and
still holds. But the audit section should be re-run before it is cited again, and §8's
anti-pattern example needs replacing with one that is still accurate.

---

## 5. Two gaps the file layout (§9) does not account for

1. **Remotion toolchain.** §5.1 step 3 shells out to `npx remotion render`, but Remotion
   is not a dependency of this repo. Phase 1 adds a toolchain and install story that no
   file in §9 covers — and `npx` resolving a renderer at runtime is a different failure
   mode from a pinned workspace dependency.
2. **Font resolution for vector text.** §3 commits to text being "real `<text>`/AE text
   layers, never rasterized," which is correct. Nothing in the plan says how a font
   reaches the generated Remotion project, the Lottie export or the AE script. This is
   not hypothetical: the `jb-chase` CBCB build required the deck's exact Open Sans
   Light / Regular / SemiBold weights, which had to be extracted from the source `.pptx`
   (`ppt/fonts/*.fntdata`) to avoid substitution. An IR that carries `fontFamily` and
   `fontWeight` as bare strings will silently substitute on any machine lacking the face.

---

## 6. Net assessment of Phase 1

The architecture is sound and some of its choices are notably good: pre-baking resolved
frames so the React layer only indexes (§5.1) genuinely prevents preview/IR divergence,
and deferring `pathData` morphing rather than shipping a naive point-correspondence
(§3) is the right call.

The sequencing claim is where it is optimistic. §10 calls Phase 1 "smallest lift; mostly
assembly of existing pieces plus the new SVG-node renderer." In practice:

| Component | Assessment |
|---|---|
| `motion-graphics-types.ts` (IR) | As described. Straightforward. |
| `motion.ts` CLI | Trivial — one `case` in a flat switch, matching 12 existing commands. |
| `remotion-compiler.ts` | The genuinely novel piece. As scoped. |
| `motion-evaluator.ts` | **Larger than scoped** — blocked on §3.1 and §3.2 below it. |
| Bezier + 2D in `universal-animation-types.ts` | **Not in the plan at all.** Shared-code change with 3D/camera-solve regression surface. |
| Two-pass GIF in `HeadlessVideoEditorService` | **Conditional in the plan, unconditional in fact.** |

So: assembly, plus three repairs underneath it, and the repairs carry the risk. The §5.4
acceptance criteria are well chosen and should be kept exactly as written — particularly
the closed-form evaluator tests, which would have caught §3.1 immediately.

One scoping note for anyone reading this with `jb-chase` delivery in mind: **Phase 1
does not produce an AE `.jsx`.** That is Phase 3. Phase 1 replaces the hand-written
Remotion composition and nothing else, so the two-sources-of-truth problem in §2 above
persists until Phase 3 lands.

---

## 7. Not verified

Stated so this review is not over-read:

* The C++ `scratchbox_native` module was not built, and nothing here was executed in
  this repo — this is a static read of `main` plus `git`-clean file inspection.
* `evaluateAnimationClip()` and the OTIO/timeline math (`timelineMath.ts`,
  `rationalTime.ts`, `timecode.ts`) cited in §2 were not reviewed.
* Phase 2 (Lottie) and Phase 4 (UI primitive) were read but not audited against code.
* No judgement is offered on whether this engine is the right priority for this product —
  only on what Phase 1 would cost if built.
