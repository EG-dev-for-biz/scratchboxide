/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * face-textures.ts's textureFromOrtho now de-lights the tile ortho (photogrammetric-delight.ts's lift cap) before it
 * ever reaches inference.ts's grammar and relief renders: a baked cast shadow is lifted on the way in, not read as if
 * it were real geometric or facade detail, while a genuinely dark local feature (a window reveal) keeps its darkness.
 */
import { describe, expect, it } from 'vitest';
import { SRC, textureFromOrtho } from '../src/node/3d-engine/staged-location/pipeline-e/face-textures';
import type { FaceOrtho } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';

// wide enough that a sample deep in either half sits outside the lift cap's 30-texel neighbourhood (TEXTURE_LIFT_CAP's
// 1.5 m radius at 0.05 m/texel) of the other half, so neither contaminates the other's local-darkness estimate
const W = 160, H = 64;
const PIXEL_M = 0.05; // MASSING_PARAMS.pixel
// a lit wall on the left, a cast-shadow patch on the right (dark, blue-purple cast), a dark window reveal inset in the lit half
const LIT: [number, number, number] = [220, 205, 195];
const SHADOW: [number, number, number] = [60, 46, 72];
const WINDOW: [number, number, number] = [28, 30, 38];

function ortho(coverRight = true): FaceOrtho {
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const inWindow = x >= 10 && x < 18 && y >= 24 && y < 40;
        const covered = x < W / 2 || coverRight;
        const c = x >= W / 2 ? SHADOW : inWindow ? WINDOW : LIT;
        rgba.set([...c, covered ? 255 : 0], i * 4);
    }
    return { width: W, height: H, rgba, depth: new Float32Array(W * H), prot: new Float32Array(W * H) };
}

const lumaOf = (c: Uint8Array | [number, number, number]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

describe('pipeline E face textures: de-light before grammar and relief read them', () => {
    it('lifts a shadow-cast patch toward neutral, keeps a dark window reveal dark, and leaves the lit wall close to unchanged', () => {
        const t = textureFromOrtho(ortho(), PIXEL_M);
        const at = (x: number, y: number) => t.rgba.subarray((y * W + x) * 4, (y * W + x) * 4 + 4);
        const shadow = at(140, 32), lit = at(5, 5), win = at(14, 32);

        expect(lumaOf(shadow)).toBeGreaterThan(lumaOf(SHADOW) + 15);
        expect(Math.abs(lumaOf(lit) - lumaOf(LIT))).toBeLessThan(5);
        expect(lumaOf(win)).toBeLessThan(lumaOf(WINDOW) + 20);
    });

    it('only de-lights (and marks tileOrtho) texels the tile actually covers; an uncovered texel is left 255-marked, untouched', () => {
        const t = textureFromOrtho(ortho(false), PIXEL_M);
        for (let y = 0; y < H; y++) for (let x = Math.ceil(W / 2); x < W; x++) {
            const i = y * W + x;
            expect(t.source[i]).toBe(255);
            expect(t.rgba[i * 4 + 3]).toBe(0);
        }
        for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) expect(t.source[y * W + x]).toBe(SRC.tileOrtho);
    });
});
