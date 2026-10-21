/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * residual-tile-delight.ts: de-lights the raw Google tile photo residual ("as-scanned") clusters render with, so a
 * baked cast shadow (which against blue sky skews dark surfaces blue-purple) is lifted the same way every other texel
 * in the scene already is, while a genuinely dark local feature stays dark (the lift cap, photogrammetric-delight.ts).
 */
import { describe, expect, it } from 'vitest';
import { decodeImageInMemory } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { delightTileImageBytes } from '../src/node/3d-engine/staged-location/pipeline-e/residual-tile-delight';

const W = 64, H = 64;
// a lit brick wall (warm, mid-bright) on the left, a cast shadow (dark and blue-purple, as shade under open sky
// skews a warm surface) on the right, and a small genuinely dark window inset in the lit half
// chosen so the shadow ramp (shadowFactor = clamp(1 - lumaLinear * 2.2, 0, 1)) is 0 for LIT and near its full 0.60 for
// SHADOW and WINDOW: sRGB bytes go through SRGB8_TO_LINEAR before the ramp, which drops a mid-grey well below it
const LIT: [number, number, number] = [220, 205, 195];
const SHADOW: [number, number, number] = [60, 46, 72];
const WINDOW: [number, number, number] = [28, 30, 38];

function scene(): Uint8Array {
    const out = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const inWindow = x >= 10 && x < 18 && y >= 24 && y < 40;
        const c = x >= W / 2 ? SHADOW : inWindow ? WINDOW : LIT;
        out.set([...c, 255], i * 4);
    }
    return out;
}

describe('residual tile photo de-light', () => {
    it('lifts a shadow-cast patch toward neutral and off its blue-purple cast, keeps a lit wall and a dark window close to unchanged', () => {
        const png = new Uint8Array(encodePng(W, H, Buffer.from(scene()), 4));
        const out = delightTileImageBytes(png);
        const img = decodeImageInMemory(out);
        expect(img.width).toBe(W);
        expect(img.height).toBe(H);

        const at = (x: number, y: number) => img.rgba.subarray((y * W + x) * 4, (y * W + x) * 4 + 4);
        const shadow = at(48, 32), lit = at(10, 10), win = at(14, 32);

        // alpha is carried through untouched
        expect(shadow[3]).toBe(255);

        // the shadow lifts: brighter, and its blue-purple cast (b and r both above g) narrows
        const origCastShadow = (SHADOW[2] - SHADOW[1]) + (SHADOW[0] - SHADOW[1]);
        const newCastShadow = (shadow[2] - shadow[1]) + (shadow[0] - shadow[1]);
        const lumaOf = (c: Uint8Array | [number, number, number]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
        expect(lumaOf(shadow)).toBeGreaterThan(lumaOf(SHADOW) + 15);
        expect(Math.abs(newCastShadow)).toBeLessThan(Math.abs(origCastShadow));

        // the lit wall (well above the shadow ramp) is close to unchanged
        expect(Math.abs(lumaOf(lit) - lumaOf(LIT))).toBeLessThan(5);

        // the window, a genuinely dark local feature inside the lit half, keeps most of its own darkness (the lift cap)
        expect(lumaOf(win)).toBeLessThan(lumaOf(WINDOW) + 20);
    });

    it('is idempotent-shaped: a flat image already above the shadow ramp is left close to itself', () => {
        const flat = new Uint8Array(W * H * 4);
        for (let i = 0; i < W * H; i++) flat.set([190, 190, 190, 255], i * 4);
        const out = decodeImageInMemory(delightTileImageBytes(new Uint8Array(encodePng(W, H, Buffer.from(flat), 4))));
        const c = out.rgba.subarray(0, 4);
        expect(Math.abs(c[0] - 190)).toBeLessThan(5);
        expect(Math.abs(c[1] - 190)).toBeLessThan(5);
        expect(Math.abs(c[2] - 190)).toBeLessThan(5);
    });
});
