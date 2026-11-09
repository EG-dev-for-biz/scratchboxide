/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E's own texture ladder (face-textures.ts: tile-ortho -> nearest-fill -> facade-median) has no repetition
 * rung at all (docs/processes/texture_repeat_inference.md section 5). This file ports the gated same-plane-repeat
 * detector and filler of `texture-repeat.ts` (texture-pass.ts's rung) onto pipeline-e's own, simpler per-face texture
 * buffer, as the SAME rung at the SAME position in the trust order: real tile-photo texels first, a confirmed
 * same-plane repeat second, the nearest-texel/facade-median smear last.
 *
 * texture-repeat.ts's `detectPlaneRepeats`/`repeatFill` operate on the shared `UvAtlas`/`BakedTexturePlanes` contracts
 * (texture-pass.ts's general, possibly-island-unwrapped atlas). A pipeline-E `FaceTexture` is already exactly the kind
 * of surface those functions need: one face's ortho render is an axis-aligned, fitted planar grid by construction (it
 * is rendered straight off the face's own (s, t) frame, never unwrapped into an atlas island), so "row = one
 * direction along the face, column = the other" is always a meaningful assumption here - unlike texture-pass.ts's
 * scan-fitted rebuilds, whose UV atlas is island-unwrapped whenever the fit gate fails (see that file's "Greene
 * Street" case, docs/processes/texture_repeat_inference.md section 3). This is reused, not reimplemented: the same
 * gates (NCC_GATE, MIN_REPEATS, K_SIGMA, trimmed-mean), the same statistics, the same refusal-with-a-reason shape.
 *
 * Wrapping: a FaceTexture's `rgba` alpha channel already marks a texel "produced" exactly where `source ===
 * SRC.tileOrtho` (face-textures.ts's `textureFromOrtho`), so it doubles as BakedTexturePlanes.albedo unchanged. The
 * wrapped UvAtlas has one map (mapIndex 0 everywhere, the whole face rectangle "covered") and a confidence plane that
 * marks only the real tile-ortho texels as real, at the ladder's 'tile photo transfer' rung, so `isReal()` (donor
 * eligibility) in texture-repeat.ts reads real tile-photo texels as donors and nothing else - never a previous fill.
 */

import { packConfidenceTexel, TEXTURE_LADDER_RUNGS } from '../../../../common/spatial/texture-pass-contracts';
import type { BakedTexturePlanes, ConfidencePlane, TexturePassDegradation, UvAtlas } from '../../../../common/spatial/texture-pass-contracts';
import { detectPlaneRepeats, repeatFill, TEXTURE_RUNG_REPEATED_NAME } from '../texture-repeat';
import type { FaceTexture } from './massing-glb';
import { SRC } from './face-textures';

/** The ladder rung index this fill is packed with (derived, never hardcoded: texture-pass.ts's shared ladder). */
export const RUNG_REPEATED = TEXTURE_LADDER_RUNGS.indexOf(TEXTURE_RUNG_REPEATED_NAME);
const RUNG_TILE_ORTHO = TEXTURE_LADDER_RUNGS.indexOf('tile photo transfer');

/** Wraps one face's plain texture (textureFromOrtho's output, before fillNearest/facadeMedian) as a one-map UvAtlas + BakedTexturePlanes. */
function wrapFace(t: FaceTexture, pixelM: number, real: number): { atlas: UvAtlas; planes: BakedTexturePlanes } {
    const n = t.width * t.height;
    const atlas: UvAtlas = {
        layerKey: 'pipeline-e-face',
        width: t.width,
        height: t.height,
        maps: [{ nodeName: 'pipeline-e-face', kind: 'chart-plane', texelsPerMeter: pixelM > 0 ? 1 / pixelM : 1, atlasRect: [0, 0, 1, 1] }],
        texels: {
            covered: new Uint8Array(n).fill(1),
            gutter: new Uint8Array(n),
            mapIndex: new Uint16Array(n), // all 0: the whole face is one plane
            position: new Float32Array(n * 3),
            normal: new Float32Array(n * 3),
            sizeM: new Float32Array(n).fill(pixelM > 0 ? pixelM : 1)
        }
    };
    const confidence: ConfidencePlane = { width: t.width, height: t.height, data: new Uint8Array(n * 4) };
    for (let i = 0; i < n; i++) if (t.source[i] === real) packConfidenceTexel(confidence, i, 0, 0.5, RUNG_TILE_ORTHO);
    const planes: BakedTexturePlanes = { layerKey: 'pipeline-e-face', width: t.width, height: t.height, albedo: t.rgba, confidence, provenance: [], degradations: [] };
    return { atlas, planes };
}

export interface FaceRepeatResult { filled: number; degradations: TexturePassDegradation[] }

/**
 * Fills same-plane texels this face's tile-ortho left uncovered, from the real tile-ortho texels at a gated,
 * detected repeat pitch - the same statistics `texture-repeat.ts` runs for texture-pass.ts, run here on a single
 * face's own planar grid instead of a shared atlas island. Writes `SRC.repeatFill` into `t.source` (never
 * `SRC.tileOrtho`: a repeat-filled texel must never be read back as a real, measured photo texel by the grammar,
 * relief, bay-average or Street-View colour steps downstream in inference.ts, all of which gate on
 * `source === SRC.tileOrtho`). A face with no gated axis is left untouched (falls through to fillNearest/facadeMedian
 * exactly as before this rung existed). `opts` names a legend whose real photo texels and repeat-fill entry sit at other
 * indices (pipeline-e.ts `closeUnsourcedTexels`); the texels to fill must then have alpha 0, as textureFromOrtho's do.
 */
export function repeatFillFace(t: FaceTexture, pixelM: number, opts: { real?: number; fillSource?: number } = {}): FaceRepeatResult {
    const { atlas, planes } = wrapFace(t, pixelM, opts.real ?? SRC.tileOrtho);
    const detections = detectPlaneRepeats(atlas, planes);
    const { planes: out, degradations } = repeatFill(atlas, planes, detections, RUNG_REPEATED);
    let filled = 0;
    const n = t.width * t.height;
    for (let i = 0; i < n; i++) {
        if (t.source[i] !== 255) continue; // only fill what the tile ortho never covered
        if (!out.albedo[i * 4 + 3]) continue; // this rung did not write this texel
        t.rgba.set(out.albedo.subarray(i * 4, i * 4 + 4), i * 4);
        t.source[i] = opts.fillSource ?? SRC.repeatFill;
        filled++;
    }
    return { filled, degradations };
}
