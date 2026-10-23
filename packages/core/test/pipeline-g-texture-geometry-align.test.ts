/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * alignTextureToOpenings (pipeline-g.ts): a small corrective shift that brings a plate's texture, already placed on a
 * wall by plateOntoFace's geometric reprojection, nearest the wall's own known openings — catching a residual drift
 * (eg. a survey station's pose a little off) the reprojection itself cannot.
 */

import { describe, expect, it } from 'vitest';
import type { OpeningItem } from '../src/node/3d-engine/staged-location/pipeline-e/massing-spec';
import type { MassingFace } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import { alignTextureToOpenings, inOpening } from '../src/node/3d-engine/staged-location/pipeline-g/pipeline-g';

const W = 64, H = 64, PIXEL_M = 0.1;
// orthoSMin/orthoTMax: the frame's top-left world corner (s, t); orthoTMax - H*pixel = tMin
const frame: Pick<MassingFace, 'orthoSMin' | 'orthoTMax' | 'pixel'> = { orthoSMin: 0, orthoTMax: H * PIXEL_M, pixel: PIXEL_M };

/** An opening rectangle 2m square around (sMid, tMid), the face's own read program in (s, t) metres. */
function opening(sMid: number, tMid: number): OpeningItem {
    return { id: 'o', face: 'w', s0: sMid - 1, s1: sMid + 1, t0: tMid - 1, t1: tMid + 1, depth: 0.3, scanned: false, confidence: 0.6, provenance: 'photo-inferred' };
}

/** A white RGBA texture with a dark square painted where the opening actually renders, offset by (dxPx, dyPx) pixels from where `o` says it should be — simulating a plate whose geometric reprojection drifted a little from the built opening. */
function texture(o: OpeningItem, dxPx: number, dyPx: number): Uint8Array {
    const rgba = new Uint8Array(W * H * 4).fill(255);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const s = frame.orthoSMin + (x - dxPx + 0.5) * PIXEL_M, t = frame.orthoTMax - (y - dyPx + 0.5) * PIXEL_M;
        if (inOpening(o, s, t)) rgba.set([20, 20, 20, 255], (y * W + x) * 4);
    }
    return rgba;
}

/** Share of the texture's dark (opening) pixels that fall within the opening's own rasterised mask, dilated by `tolPx`. */
function darkInsideShare(rgba: Uint8Array, o: OpeningItem, tolPx: number): number {
    const mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const s = frame.orthoSMin + (x + 0.5) * PIXEL_M, t = frame.orthoTMax - (y + 0.5) * PIXEL_M;
        if (inOpening(o, s, t)) mask[y * W + x] = 1;
    }
    const dilated = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let hit = false;
        for (let dy = -tolPx; dy <= tolPx && !hit; dy++) for (let dx = -tolPx; dx <= tolPx && !hit; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && xx < W && yy >= 0 && yy < H && mask[yy * W + xx]) hit = true;
        }
        dilated[y * W + x] = hit ? 1 : 0;
    }
    let dark = 0, inside = 0;
    for (let i = 0; i < W * H; i++) if (rgba[i * 4] < 128) { dark++; if (dilated[i]) inside++; }
    return dark ? inside / dark : 1;
}

describe('alignTextureToOpenings', () => {
    it('leaves a texture already aligned to its opening unchanged', () => {
        const o = opening(3.2, 3.2);
        const tex = texture(o, 0, 0);
        const use = new Uint8Array(W * H).fill(1);
        const r = alignTextureToOpenings(tex, W, H, use, [o], frame, PIXEL_M);
        expect(r.dx).toBe(0);
        expect(r.dy).toBe(0);
        expect(r.coveredOpenings).toBe(1);
        expect(r.chamferPx).toBeLessThan(1);
    });

    it('finds the shift that brings a drifted plate texture back onto the wall\'s known opening', () => {
        const o = opening(3.2, 3.2);
        const use = new Uint8Array(W * H).fill(1);
        const drifted = texture(o, 5, -4);
        const beforeShare = darkInsideShare(drifted, o, 1);

        const r = alignTextureToOpenings(drifted, W, H, use, [o], frame, PIXEL_M);
        expect(r.coveredOpenings).toBe(1);
        expect(r.dx).not.toBe(0);
        expect(r.dy).not.toBe(0);
        // the aligned texture's dark (opening) pixels now land within 1-2px of the opening's own silhouette, markedly
        // better than before the shift
        const afterShare = darkInsideShare(r.aligned, o, 2);
        expect(afterShare).toBeGreaterThan(0.85);
        expect(afterShare).toBeGreaterThan(beforeShare + 0.2);
        expect(r.chamferPx).toBeLessThan(2);
        expect(r.why).toContain('corrective shift');
    });

    it('returns the texture unchanged when there are no read openings, or the plate saw none of them', () => {
        const use = new Uint8Array(W * H).fill(1);
        const tex = new Uint8Array(W * H * 4).fill(255);
        const none = alignTextureToOpenings(tex, W, H, use, [], frame, PIXEL_M);
        expect(none).toMatchObject({ dx: 0, dy: 0, coveredOpenings: 0, aligned: tex });

        const o = opening(3.2, 3.2);
        const unseen = new Uint8Array(W * H); // the plate saw nothing of this wall
        const r = alignTextureToOpenings(tex, W, H, unseen, [o], frame, PIXEL_M);
        expect(r).toMatchObject({ dx: 0, dy: 0, coveredOpenings: 0, aligned: tex });
        expect(r.why).toMatch(/none of the read openings/);
    });
});
