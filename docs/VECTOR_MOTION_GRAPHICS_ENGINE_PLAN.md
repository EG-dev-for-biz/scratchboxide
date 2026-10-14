/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

# Vector Motion Graphics Engine — Implementation Plan

## 1. Executive Summary & Objective

Scratchbox IDE has mature, real infrastructure for 3D/geospatial synthesis, NLE video
compositing, and ffmpeg-based export — but **no vector-shape scene graph and no
AE/Lottie/Rive-style keyframe composition system**. "Vector" everywhere in this codebase
today means GIS vector tiles (`vector-spatial-intelligence`, `stage-3d-vector-world`),
never SVG/path vector graphics. This is a confirmed, audited gap — not a hidden
duplicate (see §7 Prior Art Audit).

### The Core Objective
Build a **single canonical vector + keyframe intermediate representation (IR)** for 2D
motion graphics, then compile that one IR to three outputs instead of hand-maintaining
three separate pipelines:

1. **Remotion/SVG render** → MP4 + GIF (primary preview & delivery path)
2. **Lottie / dotLottie JSON** → native vector playback on signage/web, no video decode
3. **After Effects `.jsx`** → hand-off to human motion designers

The motivating case is the `jb-chase` DOOH campaign, which today hand-authors Remotion
compositions and hand-keeps an AE script in sync by hand. With one IR, the rendered
video and the AE script are generated from the *same* keyframes and cannot drift apart.

### Non-Negotiable Constraint
Per `.agents/skills/prevent-architectural-simulation-trap`: every stage must produce
genuinely computed/rendered output, verified by real execution (subprocess exit codes,
`ffprobe`-confirmed file properties, actual pixel diffs). No stage may be a "hollow
scaffold" — see §8 for the specific anti-pattern already present in this codebase
(`physics-animation-operators.ts`) that this plan must not repeat.

---

## 2. Reuse Inventory — What Already Exists and Must Not Be Rebuilt

| Existing asset | Path | Reuse strategy |
|---|---|---|
| Keyframe/interpolation type model (glTF-style: linear/step/slerp/cubicspline/cubicBezier, in/out tangents) | `packages/core/src/common/spatial/universal-animation-types.ts` | **Import directly.** `UniversalKeyframe<T>`, `UniversalInterpolationType`, `evaluateAnimationTrack()` are property-agnostic math — repoint `targetNodeId` at 2D shape IDs instead of 3D nodes. Do not duplicate the interpolation math. |
| Frame-accurate NLE time math | `timelineMath.ts`, `rationalTime.ts`, `timecode.ts`, `otioSerializer.ts` (`packages/core/src/.../services/video/`) | Reuse for frame snapping / timecode formatting in the CLI and any future scrubber UI. |
| Working ffmpeg render pipeline (h264/prores/vp9, mp4/webm/gif/mov, binary resolution via `FFMPEG_PATH`) | `HeadlessVideoEditorService.ts` (1552 lines), `HeadlessVideoCompositorService.ts` | **Call into this for final encode**, especially the GIF path. Do not re-derive ffmpeg binary resolution or re-implement codec flag selection. |
| Typed, AI-drivable UI primitive pattern | `packages/core/src/browser/generative-canvas/canvas-types.ts` + `primitives/*` | Template for the Phase 4 UI primitive (`VectorCompositionPrimitive`), not needed until Phase 4. |
| CLI dispatch pattern | `packages/cli/src/index.ts` (flat `switch` over `argv[0]`, one file per command in `commands/`) | Add a new `motion` command the same way; see §5. |
| NLE timeline scrubbing/playhead interaction patterns | `VideoTimelinePrimitive.tsx`, `video/VideoTimelineTracks.tsx` | Reference only, for Phase 4 UI — these are video-clip tracks, not property-keyframe lanes, so the interaction *patterns* transfer but the component itself does not. |

Everything else needed (vector scene graph, SVG renderer, Lottie/AE serializers) is new
and lives in a new `motion/` module, parallel to `common/spatial/` and `common/botanical/`.

---

## 3. The Canonical IR

New file: `packages/core/src/common/motion/motion-graphics-types.ts`

```ts
import type {
  UniversalKeyframe,
  UniversalInterpolationType,
} from '../spatial/universal-animation-types';

export type MotionProperty =
  | 'position' | 'scale' | 'rotation' | 'opacity'
  | 'fillColor' | 'strokeColor' | 'strokeWidth'
  | 'pathData' | 'anchorPoint' | 'custom';

export interface MotionTrack<T = any> {
  id: string;
  targetNodeId: string;        // VectorNode.id
  property: MotionProperty;
  interpolation: UniversalInterpolationType;
  keyframes: UniversalKeyframe<T>[];
}

export interface Transform2D {
  x: number; y: number;
  scaleX: number; scaleY: number;
  rotationDeg: number;
  anchorX: number; anchorY: number;
}

export interface PaintStyle {
  fill?: { type: 'solid' | 'linearGradient' | 'radialGradient'; stops: Array<{ offset: number; color: string }> };
  stroke?: { color: string; width: number; dash?: number[]; cap?: 'butt' | 'round' | 'square' };
}

export type VectorNode =
  | { kind: 'group'; id: string; name: string; transform: Transform2D; opacity: number; children: VectorNode[] }
  | { kind: 'shape'; id: string; name: string; transform: Transform2D; opacity: number; paint: PaintStyle; pathData: string }
  | { kind: 'text'; id: string; name: string; transform: Transform2D; opacity: number; paint: PaintStyle;
      content: string; fontFamily: string; fontSize: number; fontWeight: number; align: 'left' | 'center' | 'right' };

export interface VectorComposition {
  id: string;
  name: string;
  widthPx: number;
  heightPx: number;
  fps: number;
  durationSeconds: number;
  backgroundColor: string | null;
  rootNode: VectorNode;        // kind: 'group'
  tracks: MotionTrack[];
}
```

Deliberate choices, stated up front so they aren't re-litigated mid-build:

- **No closed-form "shape type" enum beyond rect/ellipse/path primitives at the
  authoring layer** — everything compiles down to `pathData` (an SVG path string) at
  the IR level, same as how real vector tools normalize shapes internally. Keeps the
  evaluator and all three exporters dealing with one representation.
- **`pathData` keyframing (true shape morphing) is explicitly OUT of Phase 1 scope.**
  Interpolating between two arbitrary SVG paths correctly requires point-correspondence
  resolution (the `flubber` library is the standard solution). Claiming "shape morph
  support" in Phase 1 without this would violate the no-loose-tolerance / no-fake-output
  rule in §8. Phase 1 only keyframes `position/scale/rotation/opacity/fillColor/
  strokeColor/strokeWidth` — i.e., exactly what Remotion `spring()`/`interpolate()`
  already does today in jb-chase, so Phase 1 is a strict superset of current capability,
  not a regression.
- **Text is vector (real `<text>`/AE text layers), never rasterized**, matching the
  existing jb-chase pipeline requirement.

---

## 4. Evaluator

New file: `packages/core/src/common/motion/motion-evaluator.ts`

```ts
export function evaluateComposition(
  comp: VectorComposition,
  timeSeconds: number
): ResolvedNode; // fully resolved tree: every node's live transform/paint at this instant
```

Implementation: walk `rootNode`, for each node look up tracks where `targetNodeId ===
node.id`, call the **existing** `evaluateAnimationTrack()` from
`universal-animation-types.ts` per track, merge resolved values over the node's base
properties. Pure function. No I/O, no randomness, no clock reads — same `(comp, t)` in
always yields the same tree out.

This is the single source of truth every renderer must call. It must ship with unit
tests (vitest, matching `test:core`) that assert **exact** interpolated values at known
times for known keyframe sets — not "looks about right," closed-form expected values
computed by hand for at least linear, step, and cubic-bezier cases.

---

## 5. Phase 1 — Remotion Compiler + CLI + ffmpeg Export (MVP)

### 5.1 Render path
New file: `packages/core/src/node/motion/remotion-compiler.ts`

1. Call `evaluateComposition(comp, t)` once per frame for `t = 0..durationSeconds` at
   `comp.fps` → produces a flat array of resolved-frame JSON (no interpolation logic
   lives in the React layer; it only indexes into pre-baked frames). This guarantees the
   Remotion preview and the IR's "ground truth" evaluation can never diverge — a
   deliberate choice to avoid re-implementing interpolation twice.
2. Generate a self-contained Remotion project: one `.tsx` entry that renders the node
   tree as real `<svg>`/`<path>`/`<text>`/`<g>` elements, driven by
   `frames[useCurrentFrame()]`.
3. Shell out to `npx remotion render` → `.mp4`.

### 5.2 Export path
New file: `packages/core/src/node/motion/motion-render-service.ts` — calls into the
**existing** `HeadlessVideoEditorService` for the GIF derivative (two-pass palette
method, matching the jb-chase standing dual-format rule) rather than re-deriving ffmpeg
invocation. Confirm `HeadlessVideoEditorService`'s existing `gif` format path already
does palette generation; if it currently does a naive single-pass GIF, that's a
pre-existing gap worth fixing there (benefits every future GIF export, not just this
feature) rather than forking a second ffmpeg wrapper.

### 5.3 CLI
New file: `packages/cli/src/commands/motion.ts`, exporting `motionCommand(args)`,
dispatched from `packages/cli/src/index.ts` via a new `case 'motion':` (same pattern as
every existing command).

```
sbox motion render <composition.json>
  [-o <output.mp4>]
  [--gif]                 also emit paletted GIF alongside mp4
  [--fps <n>]             override composition fps
  [--dry-run]             evaluate all frames, print resolved keyframe values, no render
```

`--dry-run` mirrors the existing `matchmove --dry-run` convention: validate the IR and
print the evaluated-frame output without invoking Remotion/ffmpeg, for fast iteration
and for CI.

### 5.4 Phase 1 acceptance criteria (real verification, not claimed)
- `sbox motion render fixture.json -o out.mp4 --gif` exits 0, and `ffprobe` on both
  `out.mp4` and `out.gif` reports the expected duration/fps/dimensions.
- Evaluator unit tests pass with closed-form expected values.
- One jb-chase composition (e.g. the CardMotif animation) is re-expressed in the IR and
  its rendered MP4 is pixel-diffed against the current hand-written Remotion output
  within a stated, justified tolerance (not an arbitrary loose one — define it from
  actual anti-aliasing variance, not convenience).

---

## 6. Phase 2 & 3 — Additional Exporters

### Phase 2: Lottie / dotLottie
New file: `packages/core/src/common/motion/lottie-exporter.ts`. Lottie's keyframe schema
(`{t, s, e, i, o}` with bezier in/out handles) maps almost mechanically onto
`UniversalKeyframe`, since both are bezier-tangent keyframe models — this is the
highest-reuse, highest-DOOH-value exporter (native vector playback on signage, no video
decode, tiny file size, perfect loops). **Verification requirement:** render the
exported JSON with a real Lottie renderer (`lottie-web` under headless Chromium or
`@lottiefiles/lottie-renderer`), sample N frames, and pixel-diff against the Phase 1
Remotion reference render. A JSON file that merely "validates against the Lottie schema"
is not sufFficient proof it's correct — it must actually play back correctly.

### Phase 3: After Effects `.jsx`
New file: `packages/core/src/common/motion/ae-script-exporter.ts`. Walks the IR and
emits ExtendScript: `comp.layers.addShape()` / `addText()` per node,
`property("Position").setValueAtTime(t, [x,y])` per keyframe, mapping
`UniversalInterpolationType` → AE's keyframe interpolation + `setTemporalEaseAtKey` for
bezier tangents. This directly replaces jb-chase's current hand-maintained AE script
with a generated one that cannot drift from the rendered video, because both come from
the same IR.

---

## 7. Prior-Art Audit (why this isn't a duplicate)

Confirmed via direct code inspection before writing this plan — no overlap found with:
- `vector-spatial-intelligence`, `stage-3d-vector-world` — "vector" = GIS road/building
  vector tiles, unrelated to SVG.
- `complex-visual-workflows` — orchestrates 3D/Omni-video/ComfyUI generation, not vector
  authoring.
- `universal-animation-types.ts` — real keyframe math, but targets 3D node transforms
  and camera solves, not 2D shape properties (reused, not duplicated — see §2).
- `physics-animation-operators.ts` (56 lines) — the only "keyframe" code targeting
  arbitrary properties, but it is a genuine stub: keyframes are pushed into an array and
  **nothing ever reads them back during playback.** No interpolation evaluator consumes
  this data. This is the anti-pattern this plan is explicitly designed not to repeat
  (§8).
- Zero repo-wide hits for "Lottie", "Rive", "AfterEffects"/"AE" prior to this plan.

---

## 8. Compliance with `prevent-architectural-simulation-trap`

Explicit mapping of that skill's rules to this plan's gates:

| Rule | How this plan satisfies it |
|---|---|
| No hollow scaffolds / stub methods returning mocks | `motion-evaluator.ts` ships with closed-form unit tests before any renderer is built on top of it. No exporter is "done" until it has a real consumer verifying its output (ffprobe, pixel diff, real Lottie playback). |
| No synthetic terminal mirages (claiming builds/tests pass without running them) | Phase acceptance criteria in §5.4 require actual subprocess exit codes and `ffprobe` output, not assumed success. |
| No loose-tolerance math | Pixel-diff tolerances for Phase 1/2 verification must be derived from measured anti-aliasing variance between two renders of the *same* frame, not picked arbitrarily. |
| No toy-primitive fallbacks | Shape morphing is explicitly deferred (§3) rather than faked with a naive/incorrect interpolation that happens to not crash. |

---

## 9. File Layout Summary

```
packages/core/src/common/motion/
  motion-graphics-types.ts        # IR: VectorNode, VectorComposition, MotionTrack
  motion-evaluator.ts             # evaluateComposition() — pure, deterministic
  motion-evaluator.test.ts
  lottie-exporter.ts               # Phase 2
  ae-script-exporter.ts            # Phase 3

packages/core/src/node/motion/
  remotion-compiler.ts             # IR -> generated Remotion project + frame bake
  motion-render-service.ts         # shells to `remotion render`; calls HeadlessVideoEditorService for GIF
  remotion-compiler.test.ts

packages/cli/src/commands/
  motion.ts                        # sbox motion render / --dry-run

docs/
  VECTOR_MOTION_GRAPHICS_ENGINE_PLAN.md   # this document
```

Phase 4 (optional, platform-level, not required for jb-chase): surface the IR as a new
typed primitive (`VectorCompositionPrimitive.tsx` + schema addition in
`generative-canvas/canvas-types.ts`), with a timeline UI adapting
`VideoTimelineTracks.tsx`'s scrubbing/snapping interactions to per-property keyframe
lanes instead of video clips.

---

## 10. Sequencing

1. **Phase 1** — IR, evaluator (+ tests), Remotion compiler, CLI `motion render`, GIF via
   existing ffmpeg service. Smallest lift; mostly assembly of existing pieces plus the
   new SVG-node renderer.
2. **Phase 2** — Lottie exporter + real-playback verification harness.
3. **Phase 3** — AE `.jsx` exporter, retiring jb-chase's hand-maintained script.
4. **Phase 4 (optional)** — first-class desktop primitive + timeline UI.

Each phase is independently shippable and independently valuable; Phase 1 alone already
gives jb-chase a declarative, single-source-of-truth replacement for hand-written
Remotion compositions with no loss of current capability.
