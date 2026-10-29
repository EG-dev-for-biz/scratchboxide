/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

# Implementation Guide: Agency Deck → Motion Deliverables

> **Written:** 2026-10-28
> **Goal:** make this repo able to take an agency creative deck and ship finished
> social/DOOH motion deliverables — MP4 + GIF + editable After Effects `.jsx` — without
> hand-authoring compositions or hand-maintaining a parallel AE script.
> **Companions:** [`VECTOR_MOTION_GRAPHICS_ENGINE_PLAN.md`](./VECTOR_MOTION_GRAPHICS_ENGINE_PLAN.md)
> (the motion half) and its
> [review](./VECTOR_MOTION_GRAPHICS_ENGINE_PLAN_REVIEW_2026-10-28.md) (what that plan
> under-scopes).
> **Tags:** `motion-graphics` `vector-ir` `ooxml` `pptx` `after-effects` `lottie` `jb-chase`

---

## 0. The target capability, stated as a command

Everything below exists to make this work end to end:

```
sbox deck ingest "CfB Tactical - CBCB Offer Assets.pptx" --out ./campaign
sbox deck decode ./campaign --out ./campaign/brief.md
sbox motion render ./campaign/compositions/offer-led.json --gif --ae
```

That is the real benchmark run on 2026-10-28 in `jb-chase`: a Google Slides deck →
decoded brief → four 1080×1920 spots, each with a GIF twin and an editable AE script.
Today this repo can do the ffmpeg encode and nothing else in that chain.

**Work in this order.** Part A unblocks Part B; Part B unblocks C and D. Part E is
independent and can go in parallel. Do not start Part B before Part A's tests pass —
the whole engine computes wrong values otherwise, silently.

---

## Part A — Repair the foundations you intend to reuse

The motion plan's §2 says to import these "directly" and not duplicate them. They are
real code, but they do not yet do what Phase 1 needs. Fix them first, in their own PRs,
because each benefits the rest of the product independently.

### A1. Implement cubic-bezier easing in the shared evaluator

**File:** `packages/core/src/common/spatial/universal-animation-types.ts`

The type vocabulary exists and the evaluator ignores it. `UniversalInterpolationType`
declares `'cubicspline' | 'cubicBezier'` (lines 36–37) and `UniversalKeyframe` carries
`inTangent`, `outTangent`, `controlPoints?: [x1,y1,x2,y2]` (lines 46–48), but
`evaluateAnimationTrack()` (line 152) never reads any of them. A `cubicBezier` keyframe
is not `'step'` (line 178) and not a quaternion (line 184), so it falls through to the
scalar branch (line 190) and returns a **linear** `lerpScalar`.

Every eased move in a motion graphic is a cubic bezier. Leaving this produces output
that is wrong in a way nothing crashes on.

Add, before the scalar branch:

```ts
// Cubic-bezier timing. controlPoints are CSS/AE-style [x1,y1,x2,y2] in 0..1 on the
// normalized segment; solve x(s)=t for s by Newton with a bisection fallback, then
// return y(s). Falls back to linear when the keyframe carries no control points.
function solveCubicBezierEase(cp: [number, number, number, number], t: number): number;
```

Then in `evaluateAnimationTrack()`:

```ts
let eased = t;
if (interp === 'cubicBezier' && k0.controlPoints) {
  eased = solveCubicBezierEase(k0.controlPoints, t);
}
```

and use `eased` in place of `t` in the scalar and vector branches.

Decide explicitly what `'cubicspline'` does. glTF cubic spline is **value-space**
Hermite interpolation using `inTangent`/`outTangent` — a different operation from
bezier *timing*. Either implement it properly or remove it from the union. Do not leave
a third declared mode that silently behaves as linear.

**Tests** — `packages/core/test/motion-bezier-easing.test.ts`, asserting closed-form
values computed by hand, not "looks about right":
* linear control points `[0,0,1,1]` reproduce `lerpScalar` to within 1e-9.
* AE Easy Ease `[0.333,0,0.667,1]` at `t=0.5` returns exactly `0.5` (symmetric curve).
* A known asymmetric curve at three sample points matches hand-computed values.
* Monotonicity: 100 samples across `t∈[0,1]` are non-decreasing.

### A2. Add 2D interpolation

**Same file.** Arrays interpolate only at `length === 3` (line 194). A 2D `[x, y]`
reaches the final `return k0.value` (line 202) and **holds** instead of animating.
Phase 1 is entirely 2D.

Add `lerpVector2()` beside `lerpVector3()` and a `length === 2` branch. Guard on length
rather than adding a 2D-specific track type, so the function stays property-agnostic as
§2 claims it is.

**Test:** `[0,0] → [10,20]` at `t=0.5` returns exactly `[5,10]`; a 2D track with
`cubicBezier` easing agrees with the scalar case per-component.

> Alternative worth considering before the IR freezes: decompose every 2D property into
> two scalar tracks at the IR boundary. That keeps the shared evaluator untouched, at the
> cost of contradicting the IR in the plan's §3 where `position` is one property. Pick
> one deliberately — do not end up with both.

### A3. Make the GIF export two-pass

**File:** `packages/core/src/node/video/HeadlessVideoEditorService.ts`, lines 483–486.

Current single invocation:

```
fps=<n>,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse
```

One pass, no `stats_mode`, no dither control. The delivery standard this engine must
satisfy is two-pass:

```
pass 1:  fps=<n>,scale=<w>:-1:flags=lanczos,palettegen=stats_mode=diff   -> <tmp>.png
pass 2:  fps=<n>,scale=<w>:-1:flags=lanczos [x]; [x][1:v]
         paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle       -> <out>.gif
```

This is a structural change, not a flag change: the method currently builds one `args`
array for one `execFile`. The GIF branch needs to become two sequential `execFile` calls
with a temp palette file, cleaned up in a `finally`. Keep the existing single-pass path
reachable behind an option (`palette: 'single' | 'two-pass'`, defaulting to two-pass) so
existing callers can be migrated rather than surprised.

**Test:** `packages/core/test/headless-video-gif-palette.test.ts` — render a fixture
with a smooth gradient both ways, assert the two-pass output has a measurably lower mean
absolute error against the source frames. Assert the temp palette file does not survive.

---

## Part B — The motion engine (the plan's Phase 1)

Build as specified in `VECTOR_MOTION_GRAPHICS_ENGINE_PLAN.md` §3–§5, with these
corrections.

### B1. Correct the file layout

The plan's §9 puts tests beside source (`src/common/motion/motion-evaluator.test.ts`).
That is not this repo's convention: `test:core` runs `vitest run packages/core/test`,
which holds 871 flat kebab-case `*.test.ts` files importing via `../src/...`. CLI tests
live in `packages/cli/test/` as `sbox-<command>.test.ts`.

```
packages/core/src/common/motion/
  motion-graphics-types.ts        # IR (plan §3, unchanged)
  motion-evaluator.ts             # evaluateComposition() — pure, deterministic
  ae-script-exporter.ts           # Part C
  lottie-exporter.ts              # later
packages/core/src/node/motion/
  remotion-compiler.ts
  motion-render-service.ts
packages/core/test/
  motion-evaluator.test.ts
  motion-remotion-compiler.test.ts
  motion-ae-exporter.test.ts
packages/cli/src/commands/
  motion.ts
packages/cli/test/
  sbox-motion.test.ts
```

Export new public surface through the `packages/core/src/node.ts` barrel, matching how
`matchmove.ts` imports `GeoCameraMatchmovePipelineService` from `@scratchbox/core/node`.

### B2. Pin Remotion as a real dependency

§5.1 shells out to `npx remotion render`. Remotion is not a dependency of any workspace
here. `npx` resolving a renderer at runtime is a different failure mode from a pinned
dependency — it can silently fetch a different version on a different machine.

Add `remotion` and `@remotion/cli` to `packages/core/package.json` at an exact version,
and resolve the binary the way `HeadlessVideoEditorService` resolves ffmpeg (explicit
env override first, then a known path, then `PATH`) rather than assuming `npx`.

### B3. Follow the existing CLI shape

`packages/cli/src/index.ts` is a flat switch (`case 'init'`, `case 'matchmove'`, …).
Add `case 'motion':` the same way. Model the command file on
`packages/cli/src/commands/matchmove.ts`: copyright header, `export async function
motionCommand(args: string[]): Promise<void>`, a usage block written to `console.error`
with `process.exitCode = 1` on bad input, a local `getArg(flag)` helper, and `--dry-run`
meaning "compute and print, run no renderer."

---

## Part C — After Effects export (the plan's Phase 3, needed sooner)

Phase 1 alone does **not** produce an AE script, so it does not meet the deliverable
standard this guide targets. Treat the AE exporter as part of the first useful release,
not a later phase.

**File:** `packages/core/src/common/motion/ae-script-exporter.ts`. Walk the IR, emit
ExtendScript. Two failure modes will cost a day each if not handled up front:

1. **Tangent offsets are relative, not absolute.** In AE's `Shape()`, `inTangents` and
   `outTangents` are `[dx, dy]` offsets **from their vertex**, not stage coordinates.
   Emitting absolute control points distorts every curve.
   ```
   outTangents.push([cp1x - anchorX, cp1y - anchorY]);   // correct
   ```
2. **`KeyframeEase` arity must match the property's dimension.** Mismatches throw at
   runtime inside AE, where they are painful to debug:
   * 2D/3D spatial (Position, Anchor Point, Scale) → **three** ease objects per side:
     `prop.setTemporalEaseAtKey(i, [e,e,e], [e,e,e])`
   * 1D scalar (Opacity, Rotation, Trim End) → **one**:
     `prop.setTemporalEaseAtKey(i, [e], [e])`

Wrap output in `app.beginUndoGroup` / `app.endUndoGroup`. Emit text as real
`comp.layers.addText()` layers, never rasterized.

**Verification — static, and it catches both bugs above.** In
`packages/core/test/motion-ae-exporter.test.ts`, generate a script from a fixture IR and
assert on the emitted source:
* `app.beginUndoGroup` is the first non-comment statement.
* Every `setTemporalEaseAtKey` call's two arrays have equal length, and that length is 1
  or 3; cross-check against the property name being keyed.
* For a fixture with known curvature, every tangent magnitude is small relative to the
  comp dimensions — absolute coordinates on a 1080×1920 stage show up immediately as
  offsets in the hundreds.

A human still has to open one script in AE once per release. Record that in the PR; do
not let the static assertions stand in for having seen it run.

---

## Part D — Deck ingestion (absent from the plan entirely)

The motion plan starts from an IR that already exists. Producing that IR from an agency
deck is the other half of the goal and has **no coverage anywhere in this repo**: zero
hits for `pptx`, `presentationml`, `slideLayout`, `p:timing`, or the Slides API.

### D1. Ingest `.pptx`, not the Slides API

**Use the `.pptx` export, not `slides.googleapis.com`.** This is the decisive
constraint: the Slides REST API does not expose object animations at all. A `.pptx`
export carries them as a `<p:timing>` tree per slide. The archive is also a plain zip of
every original full-resolution asset, so one pass gets media *and* motion.

**File:** `packages/core/src/node/deck/pptx-ingest-service.ts`.

```ts
export interface DeckSlide {
  id: string;
  title: string | null;
  textBlocks: Array<{ text: string; x: number; y: number; w: number; h: number }>;
  media: Array<{ file: string; x: number; y: number; w: number; h: number }>;
  typefaces: string[];
  animation: DeckAnimationStep[];
}
```

Extract media byte-identical from `ppt/media/`. Categorize by **aspect ratio and frame
count**, not filename — the export renames everything to `image1.png`, `image2.png`, and
a multi-frame GIF is a motion reference while a 0.5625 ratio still is a 9:16 frame
plate. Attribute each asset to its owner by reading `ppt/slides/_rels/*.rels` **plus**
`ppt/slideLayouts/_rels/` and `ppt/slideMasters/_rels/`; assets referenced only by a
layout are template furniture, and mislabelling them "unused" sends people hunting.

Geometry comes free and exact: every `<a:off>`/`<a:ext>` is in EMU (914400 per inch).
Normalize against `<p:sldSz>` from `ppt/presentation.xml` to get 0..1 fractions — far
more reliable than measuring a render.

### D2. Parse `<p:timing>` into IR tracks — the high-value part

This is where deck ingestion stops being an importer and starts feeding the engine
directly. Only three `nodeType` values carry authored effects:

| `nodeType` | Meaning |
|---|---|
| `clickEffect` | starts a new build step |
| `withEffect` | runs alongside the previous |
| `afterEffect` | runs after the previous completes |

Everything above them — `tmRoot`, `mainSeq`, `clickPar`, `withGroup` — is scaffolding
carrying no effect. **Walk for those three leaf types in document order and you have the
build sequence directly, with no tree recursion.**

Per node, read: `presetID`/`presetClass`/`presetSubtype` (effect, category, direction),
duration from the child behaviour node's `dur` in **milliseconds** (the effect node
itself usually carries none), delay from `p:stCondLst/p:cond/@delay`, and the target
from `p:spTgt/@spid` resolved against the slide's shape ids.

Map that to `MotionTrack[]`: an `entr` fade becomes an opacity track `0→1` over the
duration; a `Fly In` with directional subtype becomes a position track offset along that
axis. Keep the mapping table in one file and make unmapped presets **fail loudly** with
the preset id, rather than silently emitting nothing.

Two cautions from the benchmark run. First, a deck may contain **no** `<p:timing>` at
all — the CBCB deck has zero across all six slides, with motion described only in caption
text. Report that state explicitly rather than emitting an empty composition that looks
successful. Second, media in a copied deck can be **403 Forbidden** at the CDN while the
Slides UI shows broken-image placeholders; the `.pptx` export embeds the real bytes and
is the reliable path.

### D3. `sbox deck` command

```
sbox deck ingest <deck.pptx> --out <dir>     # media + manifest.json + geometry
sbox deck decode <dir> --out <brief.md>      # readable brief, animation timeline per slide
sbox deck to-ir <dir> --slide <n>            # emit a VectorComposition JSON for Part B
```

`to-ir` is the join between the two halves and should be the acceptance test for this
part.

---

## Part E — Fonts (independent, do it early)

The IR carries `fontFamily`/`fontWeight` as bare strings (plan §3). On any machine
lacking the face, every renderer silently substitutes and the output is wrong in a way
that passes every automated check.

This is not hypothetical: the benchmark deck required Open Sans Light / Regular /
SemiBold specifically, recovered from `ppt/fonts/*.fntdata` inside the archive (Google's
`.fntdata` is a TTF/OTF payload under a different extension).

Do three things:
1. Extract embedded fonts during Part D ingestion into the campaign directory.
2. Add `fontRef?: { file: string; postscriptName: string }` to the IR's text node, so a
   composition can point at a specific file rather than hope.
3. Make each exporter **fail** when a referenced face cannot be resolved — Remotion via
   `@remotion/google-fonts` or a local `@font-face`, AE by checking the font is
   installed before `addText`. Never substitute silently.

---

## Part F — Acceptance

Keep the plan's §5.4 criteria verbatim; they are well chosen, and the closed-form
evaluator tests would have caught A1 immediately. Add these for the wider goal:

* **A1/A2 gate.** Bezier and 2D tests pass before any engine code lands on top.
* **Round trip.** `sbox deck ingest` → `to-ir` → `motion render --gif --ae` on the CBCB
  fixture exits 0; `ffprobe` confirms 1080×1920, 30 fps and the expected duration on the
  MP4, and dimensions/frame count on the GIF.
* **Animation fidelity.** For a deck that *does* carry `<p:timing>`, the IR's build order,
  trigger types and per-step durations match the source XML exactly — asserted against a
  hand-written fixture, since no convenient real deck may have animations.
* **Drift check — the reason this engine exists.** Render the MP4 and generate the AE
  script from the same IR, then assert they agree on a shared property sampled at N
  times. This is the regression test for the failure the plan was written to prevent, and
  it is worth more than any individual exporter test.

Per `.agents/skills/prevent-architectural-simulation-trap`: every gate above is a real
subprocess exit code, a real `ffprobe` read or a real assertion on emitted source. No
stage is "done" because it was written.

---

## Honest sequencing

1. **A1 + A2** — shared evaluator. Small, high-risk (3D transforms and camera solves use
   this function), highest leverage. Ship alone, with tests.
2. **A3** — two-pass GIF. Independent; improves every existing GIF caller.
3. **B** — IR, evaluator, Remotion compiler, CLI. The plan as written, with B1–B3.
4. **C** — AE exporter. Together with B this replaces `jb-chase`'s two-sources-of-truth
   setup, which is the point.
5. **D** — deck ingestion. Largest net-new surface; nothing exists to reuse.
6. **E** — fonts, in parallel with C or D.
7. Lottie and the Phase 4 timeline UI afterwards.

Parts A–C make this repo able to *build* deliverables like the benchmark. Only Part D
makes it able to start from a deck, which is what "goals like this" actually means.
