/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

# Character Wrap Service — Implementation Plan

## 1. Executive Summary & Objective

Competitive research into Blender's MPFB (MakeHuman Plugin For Blender) and AVC Suite
(Avatar Creator / Avatar Wrap / Sync) found that neither beats Scratchbox IDE's native
SB-Human pipeline on generation fidelity — PCA shape morphology, FACS-52 blendshapes,
biophysical melanin/SSS skin, and pluggable PBR/4DGS/2DGS/groom skinning modalities are
all already native C++20, not Python-interpreted Blender add-ons. The one capability
neither competitor's pricing model requires sb-ide to match feature-for-feature, but
that sb-ide genuinely lacks, is AVC Suite's **Wrap**: conforming an arbitrary external
mesh or point cloud onto a working, rigged, skinned character.

### The Core Objective
Build a **`CharacterWrapService`** that takes any source surface — a photogrammetry
scan, a Gaussian-splat performer capture, a Mixamo/BVH-posed mesh, or any other
triangle soup with no known topology or rig — and conforms it onto the canonical
22-joint SB-Human rig, producing a `.sbhuman` asset with transferred blend shapes and
skin weights. This is the sb-ide-native equivalent of AVC Suite's Wrap tool, built from
math that is **already specified and partially implemented** in this codebase — it is
integration work, not research.

### Non-Negotiable Constraints (per `AGENTS.md`)
- **Zero closed taxonomies.** The service must never branch on `sourceFormat:
  'metahuman' | 'genesis9' | 'scan'`. A source is just untyped geometry (positions,
  optional normals/colors, optional existing skin weights) — see §3.
- **Native C++20 first.** The fitting/optimization loop runs in the native engine via
  `NativeCppCompilerService`, not a JS/TS fallback, per the 3D Engine Architecture
  Directive. TypeScript orchestrates I/O and calls into native compute.
- **Live subprocess verification.** Every claim of a successful wrap must be backed by
  an actual compiled-and-executed fit (exit code 0) with reported residual error, not a
  mocked return value — per `.agents/skills/prevent-architectural-simulation-trap`.
- **Measured-geometry exemption.** Wrapped output is reshaped *measured* geometry (it
  conforms to a real external source), so it is exempt from the 25k-vertex
  `GeometricComplexityGate` floor — judged by fit residual (§6), never padded with
  extra vertices to pass a floor that doesn't apply to it.

---

## 2. Reuse Inventory — What Already Exists and Must Not Be Rebuilt

| Existing asset | Path | Reuse strategy |
|---|---|---|
| Barycentric surface-mapping + 3-stage progressive optimization (global → coarse joints → full articulation), with edge-preservation (`L_edge`), translation (`L_trans`), joint-angle prior, and shape/expression prior losses | `docs/knowledge-base/parametric-humanoids/04_deformation_transfer_and_inverse_fitting.md` | **This is the mathematical core of Wrap.** It is currently a spec document with no service behind it — Phase 1 below is "build the thing this doc describes," not invent new math. |
| Nearest-surface shell-offset fitting with per-bone max-offset caps, neighbor adjacency, and missing-value fill/smoothing (`fitToSplats`, `assignSplats`, `shellOffsets`, `fillMissing`, `neighbors`) | `packages/core/src/node/spatial/PerformerSurfaceMeshService.ts` | **Generalize, don't duplicate.** `fitToSplats` already does source-agnostic "find nearest source geometry per target vertex, cap displacement per bone, fill gaps" — the same operation Wrap needs, just currently typed to `SurfaceSplat[]` (Gaussian splats) only. Extract the fit kernel to accept any `WrapSourceSample[]` (points with optional normal/color), add a `fitToSource()` overload alongside the existing `fitToSplats()`. |
| Canonical 22-joint rig, skin-weight types, `computeBoneRotations`, `retargetSegmentDirections`, `skinPoint` | `packages/core/src/common/humanoid-skinning.ts` | Reuse directly for the LBS re-skin step after the target mesh is conformed. |
| `HumanoidSkinModality` / `ISbHumanSkinAdapter` pluggable rendering protocol | `packages/core/src/common/humanoid-avatar-protocol.ts` | The wrapped output is just another actor with `sourceType: 'wrapped-external'` added to the existing open union (see §3) — no new rendering path needed. |
| 55→22 joint collapse for clothing/accessory morphology (`CharacterClothingMorphology.mapJointTo22`) | `packages/core/src/node/spatial/CharacterClothingMorphology.ts` | Reuse when the source carries its own (non-SB-Human) joint indexing that needs collapsing before re-skinning. |
| `.sbhuman` binary serialization (`saveToFile` / `loadFromFile`) | `03_asset_schema_and_weight_ingestion.md`, native `scratchbox_skinning.hpp` | Output format for the wrapped result — no new file format. |
| Native C++20 compile-and-stream pattern | `NativeCppCompilerService` (per `AGENTS.md` 3D Engine directive) | The fit's inner loop (Gauss-Newton / Levenberg-Marquardt over barycentric correspondences) compiles and runs here, mirroring `AdaptiveMatchmoveCalibrationService`'s existing LM bundle-adjustment usage pattern for matchmove. |

Nothing in this plan introduces a new mesh format, a new rig, or a new skinning math
model. It wires existing, independently-documented pieces into one callable pipeline.

---

## 3. Dimensional Type Contract (ADA-Compliant)

New file: `packages/core/src/common/spatial/character-wrap-types.ts`

```ts
/**
 * A single sample of untyped source geometry. No format, no provenance taxonomy —
 * just position plus whatever else is actually known. Anything with this shape can be
 * wrapped: a photogrammetry scan, a splat-converted point cloud, a posed mesh, a
 * single depth-camera frame. The LLM / caller infers *what* it is; this type only
 * carries *how* it is measured.
 */
export interface WrapSourceSample {
    position: [number, number, number];
    normal?: [number, number, number];
    color?: [number, number, number];
    /** Existing skin weights on the source, if any (e.g. a rigged Mixamo mesh). Optional. */
    boneIndex?: number;
    boneWeight?: number;
}

export interface WrapSource {
    samples: WrapSourceSample[];
    /** Optional existing triangulation, if the source is a mesh rather than a point cloud. */
    indices?: Uint32Array;
    /** Optional sparse landmark hints (e.g. MediaPipe/vision-detected joint estimates) that seed Stage 1 global alignment. Open-ended key, never a closed joint-name enum. */
    landmarkHints?: Record<string, [number, number, number]>;
}

export interface WrapFitOptions {
    /** Per-stage convergence thresholds, continuous — never a named "quality preset" enum. */
    maxOffsetMeters?: number;
    edgePreservationWeight?: number;
    jointPriorWeight?: number;
    shapePriorWeight?: number;
    maxIterationsPerStage?: [number, number, number];
    targetResidualMeters?: number;
}

export interface WrapFitResult {
    sbhumanPath: string;
    /** Mean and max per-vertex residual after Stage 3, meters. This is the quality signal — never a pass/fail label. */
    meanResidualMeters: number;
    maxResidualMeters: number;
    iterationsRun: [number, number, number];
    /** Fraction of target vertices with no nearby source sample within maxOffsetMeters (filled by neighbor smoothing). */
    unmatchedFraction: number;
}
```

Note what is deliberately absent: there is no `sourceFormat` field and no
`quality: 'draft' | 'final'` enum. Fit behavior is driven purely by the continuous
fields in `WrapFitOptions`, and the LLM-facing tool description (§5) is responsible for
mapping a user's words ("quick preview wrap" vs. "precise wrap for export") onto those
continuous values — never onto a closed switch branch in code.

---

## 4. Service Architecture

New file: `packages/core/src/node/spatial/CharacterWrapService.ts`

```ts
import type { WrapSource, WrapFitOptions, WrapFitResult } from '../../common/spatial/character-wrap-types';

export class CharacterWrapService {
    /**
     * Conforms an arbitrary source surface onto the canonical SB-Human rig.
     * Orchestrates the 3-stage progressive fit (module 04) by compiling and running
     * the native optimizer via NativeCppCompilerService, then re-skins the result
     * with the existing humanoid-skinning.ts LBS machinery.
     */
    static async wrapToSbHuman(source: WrapSource, options?: WrapFitOptions): Promise<WrapFitResult>;
}
```

### 4.1 Stage breakdown (maps directly onto module 04 §3)

1. **Stage 1 — Global alignment.** Reuse `retargetSegmentDirections` /
   `computeBoneRotations` from `humanoid-skinning.ts` seeded by `landmarkHints` when
   present, else by bounding-box centroid + PCA major axis, to get a rough
   translation/rotation/scale before any per-vertex fitting starts. Cheap, runs in TS.
2. **Stage 2 — Coarse body topology.** Generalize `PerformerSurfaceMeshService`'s
   `assignSplats` + `shellOffsets` + `fillMissing` kernel to accept `WrapSourceSample[]`
   instead of `SurfaceSplat[]` (same nearest-neighbor-with-bone-mask-and-cap logic;
   the splat-specific fields — opacity, Gaussian covariance — become optional). This
   produces the coarse per-vertex displacement field and resolves `β` (shape PCA).
3. **Stage 3 — Full articulation & fine mimicry.** The part that is genuinely new
   native code: a Gauss-Newton/Levenberg-Marquardt solver over the edge-preservation,
   translation, joint-prior, and shape-prior losses from module 04 §4, implemented as
   a `scratchbox_wrap_fit.hpp` native module compiled through
   `NativeCppCompilerService`, following the same LM-solver pattern already proven in
   `AdaptiveMatchmoveCalibrationService`. Input: Stage 2's coarse field. Output: final
   per-vertex positions + resolved `θ` (pose) + `ψ` (expression) + skin weights.
4. **Re-skin & serialize.** Apply `skinPoint`/LBS to bind the fitted mesh to the
   22-joint rig, then write out via the existing `.sbhuman` `saveToFile`.

### 4.2 Why native for Stage 3, not Stage 2
Stage 2's nearest-neighbor assignment is already proven fast enough in TS/JS for
`PerformerSurfaceMeshService` (per-frame, interactive use). Stage 3's iterative
nonlinear least-squares refinement is the part that would be slow in JS and is exactly
the kind of SIMD-friendly, allocation-free loop the 3D Engine Architecture Directive
reserves for native C++20 — so only Stage 3 gets a new native module; Stages 1–2 are
orchestration reusing existing TS.

---

## 5. Agent Tool Surface

Add to the spatial tools domain pack (`packages/core/src/node/gemini/tools/spatial-tools.ts`,
per the Megaservice Deconstruction directive — never add this to a monolithic registry
file):

```
character_wrap_mesh_to_sbhuman({
  sourceGlbPath | sourcePlyPath | sourceSplatPath,   // one of; loader picks by extension, not a type switch
  landmarkHints?,
  maxOffsetMeters?, targetResidualMeters?,
  outputSbhumanPath?
})
```

Tool description instructs the model to translate natural-language intent ("rough
preview", "precise, ready for export") into the continuous `WrapFitOptions` fields
itself — consistent with the Adaptive Domain Architecture directive that the LLM, not a
keyword classifier, is the domain engine.

---

## 6. Verification Plan (per Mechanical Reality Grounding directive)

No claim of "wrap succeeded" is accepted without:

1. **Real subprocess compile + run.** `clang++ -std=c++20 -O3` on the Stage 3 native
   module, exit code 0, invoked via `NativeCppCompilerService` exactly as every other
   native generator in this codebase.
2. **Quantitative residual, not a boolean.** `WrapFitResult.meanResidualMeters` /
   `maxResidualMeters` reported from real per-vertex distance computation against the
   source — never a mocked "fit: true".
3. **Visual verification screenshot**, per the Visual Progress & Verification
   Directive: render source (as point cloud) and wrapped `.sbhuman` result overlaid in
   the viewport, saved to `test-results/screenshots/character_wrap_<case>.png`
   (`.gitignore`'d, not committed).
4. **Unit tests with real data, not mock-only assertions**: new
   `packages/core/test/character-wrap-service.test.ts` must assert on actual returned
   vertex counts, residual magnitude bounds, and `.sbhuman` binary magic-header bytes —
   following the existing pattern in `performer-avatar-integrity.test.ts` and
   `sbhuman-avatar-lbs-frame.test.ts`.
5. **Regression fixtures**: reuse an existing captured performer surface
   (`PerformerSurfaceMeshService` test fixtures already in `packages/core/test/`) as a
   "known good" source with a known expected residual range, so Stage 3 solver changes
   can be checked for regression without needing a fresh scan every time.

---

## 7. Phased Delivery

| Phase | Deliverable | Depends on |
|---|---|---|
| **Phase 1** | `character-wrap-types.ts` + `CharacterWrapService` skeleton with Stages 1–2 wired to generalized `PerformerSurfaceMeshService` kernel (no Stage 3 yet — output is the coarse fit) | None — pure reuse/refactor |
| **Phase 2** | `scratchbox_wrap_fit.hpp` native Stage 3 solver + `NativeCppCompilerService` integration | Phase 1 |
| **Phase 3** | Re-skin + `.sbhuman` serialization wiring, full `wrapToSbHuman()` end-to-end | Phase 1, 2 |
| **Phase 4** | `character_wrap_mesh_to_sbhuman` agent tool + spatial-tools.ts registration | Phase 3 |
| **Phase 5** | Test suite (§6) + visual verification screenshots + regression fixtures | Phase 3 |

Explicitly out of scope for this plan (tracked separately, not blocking): DCC export
sync (AVC Suite's "Sync" equivalent) and photo-driven melanin/SSS inference — both
identified in the earlier competitive brainstorm as follow-on gaps, each warranting
their own plan once Wrap ships.
