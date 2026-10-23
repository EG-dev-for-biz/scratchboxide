/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Grass detection (grass-detect.ts) on a scene with known truth: a green lawn on the terrain is grass; a grey plaza,
 * a green crown standing 8 m above the terrain, a one-cell green speck and a green pond inside a vector water area are not.
 */

import { describe, expect, it } from 'vitest';
import { detectGrass, grassOverlay } from '../src/node/3d-engine/staged-location/grass-detect';
import type { GroundModel } from '../src/node/spatial/StreetViewSurveyPlanner';
import type { TopDownPhoto } from '../src/node/3d-engine/staged-location/top-down-photo';

const N = 40, CELL = 1, TEXEL = 0.25;
type Rect = [number, number, number, number];
const inRect = (x: number, z: number, [x0, z0, x1, z1]: Rect) => x >= x0 && x < x1 && z >= z0 && z < z1;
const LAWN: Rect = [2, 2, 18, 18], PLAZA: Rect = [22, 2, 38, 18], CROWN: Rect = [2, 22, 18, 38], SPECK: Rect = [30, 30, 31, 31], POND: Rect = [22, 22, 34, 28];

function scene(): { photo: TopDownPhoto; ground: GroundModel } {
    const top = new Float32Array(N * N), groundH = new Float32Array(N * N);
    for (let k = 0; k < N; k++) for (let i = 0; i < N; i++) {
        groundH[k * N + i] = 10;
        top[k * N + i] = inRect(i + 0.5, k + 0.5, CROWN) ? 18 : 10.05;
    }
    const px = N / TEXEL, rgba = new Uint8Array(px * px * 4);
    for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
        const wx = (x + 0.5) * TEXEL, wz = (y + 0.5) * TEXEL, o = (y * px + x) * 4;
        // texel noise so the lit-colour measure sees a real spread
        const n = ((x * 7 + y * 13) % 9) - 4;
        const green = inRect(wx, wz, LAWN) || inRect(wx, wz, CROWN) || inRect(wx, wz, SPECK) || inRect(wx, wz, POND);
        const c = green ? [70 + n, 130 + n, 45 + n] : inRect(wx, wz, PLAZA) ? [150 + n, 148 + n, 142 + n] : [120 + n, 112 + n, 100 + n];
        rgba.set([c[0], c[1], c[2], 255], o);
    }
    const ground = {
        cellMeters: CELL, x0: 0, z0: 0, nx: N, nz: N, top, ground: groundH, open: new Uint8Array(N * N), terrainMethod: 'walkable-surface',
        cellIndex: (x: number, z: number) => Math.floor(z) * N + Math.floor(x), groundAt: () => 10, topAt: (x: number, z: number) => top[Math.floor(z) * N + Math.floor(x)]
    } as unknown as GroundModel;
    return { photo: { width: px, height: px, rgba, texelM: TEXEL, triangles: 0 } as TopDownPhoto, ground };
}

describe('grass detection', () => {
    const { photo, ground } = scene();
    const frame = { x0: 0, z0: 0, widthM: N, heightM: N };
    const water = new Uint8Array(N * N);
    for (let k = 0; k < N; k++) for (let i = 0; i < N; i++) if (inRect(i + 0.5, k + 0.5, POND)) water[k * N + i] = 1;
    const g = detectGrass(photo, frame, ground, undefined, { water });
    const at = (x: number, z: number) => g.mask[Math.floor(z) * N + Math.floor(x)];

    it('finds the lawn on the terrain, whole', () => {
        expect(at(10, 10)).toBe(1);
        expect(g.patches[0].areaM2).toBeGreaterThan(16 * 16 * 0.85);
        expect(g.patches[0].meanConfidence).toBeGreaterThan(0.5);
        expect(g.provenance.label).toBe('photo-inferred');
    });

    it('never takes a grey plaza, a green crown above the terrain, or a speck', () => {
        expect(at(30, 10)).toBe(0);
        expect(at(10, 30)).toBe(0);
        expect(at(30.5, 30.5)).toBe(0);
        expect(g.stats.tooHigh).toBeGreaterThanOrEqual(16 * 16);
        expect(g.patches).toHaveLength(1);
    });

    it('never takes a green pond inside a vector water area, which it would take without one', () => {
        expect(at(28, 25)).toBe(0);
        expect(g.stats.water).toBeGreaterThanOrEqual(12 * 6);
        expect(g.provenance.method).toContain('water');
        const blind = detectGrass(photo, frame, ground);
        expect(blind.mask[25 * N + 28]).toBe(1);
        expect(blind.patches).toHaveLength(2);
    });

    it('draws an overlay of the photo size that tints only the grass', () => {
        const ov = grassOverlay(photo, frame, g);
        expect(ov.length).toBe(photo.rgba.length);
        const px = (x: number, z: number) => { const o = (Math.floor(z / TEXEL) * photo.width + Math.floor(x / TEXEL)) * 4; return [ov[o], ov[o + 1], ov[o + 2]]; };
        const lawn = px(10, 10), plaza = px(30, 10);
        expect(lawn[1]).toBeGreaterThan(lawn[0] + 60);
        expect(plaza[1]).toBeLessThan(150 * 0.6);
    });
});
