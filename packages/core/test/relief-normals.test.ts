/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Relief normals (scratchbox_relief_normals.hpp behind scripts/relief_normals.cpp): a height map to a normal map and
 * back, no model involved. Not wired into any build yet; kept for checking a learned model's normals against the scan.
 *   1. the self-test round trip (a 10 cm recess and a 2 cm wave at 2 cm texels) comes back within millimetres;
 *   2. a plane tilted 1 in 10 along x gives one normal everywhere, leaning against the slope;
 *   3. integrating that normal map gives the plane back (zero mean).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { decodePng } from '../src/node/texture-processing';

const REPO = path.resolve(__dirname, '../../..');
const WORK = path.join(REPO, 'test-results', 'relief_normals');
const BIN = path.join(REPO, 'build', '3d-native', 'relief_normals_test');

describe('relief normals', () => {
    beforeAll(() => {
        fs.mkdirSync(WORK, { recursive: true });
        fs.mkdirSync(path.dirname(BIN), { recursive: true });
        const include = path.join(REPO, 'packages/core/src/native/3d-engine/include');
        execFileSync(process.env.CXX || 'clang++', ['-std=c++20', '-O2', '-I', include, path.join(REPO, 'scripts/relief_normals.cpp'), '-o', BIN, '-lz'], { stdio: 'pipe', timeout: 600_000 });
    });

    it('round-trips a synthetic relief through normals and back within millimetres', () => {
        const r = JSON.parse(execFileSync(BIN, ['--selftest']).toString());
        expect(r.ok).toBe(true);
        expect(r.rmsM).toBeLessThan(0.004);
        expect(r.maxM).toBeLessThan(0.02);
    });

    it('turns a tilted plane into one normal and integrates it back to the plane', () => {
        const W = 64, H = 48, texel = 0.05;
        const h = new Float32Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) h[y * W + x] = 0.1 * x * texel;
        const hf = path.join(WORK, 'tilt.f32'), npng = path.join(WORK, 'tilt.png'), back = path.join(WORK, 'tilt_back.f32');
        fs.writeFileSync(hf, Buffer.from(h.buffer));
        execFileSync(BIN, ['--height', hf, '--width', String(W), '--rows', String(H), '--texel', String(texel), '--out', npng]);
        const d = decodePng(fs.readFileSync(npng));
        expect([d.width, d.height]).toEqual([W, H]);
        // slope 0.1 up along +x: normal (-0.1, 0, 1) normalised, encoded (n + 1) / 2
        const o = (24 * W + 32) * 4, nx = d.rgba[o] / 255 * 2 - 1, ny = d.rgba[o + 1] / 255 * 2 - 1, nz = d.rgba[o + 2] / 255 * 2 - 1;
        expect(nx).toBeCloseTo(-0.1 / Math.hypot(0.1, 1), 1);
        expect(ny).toBeCloseTo(0, 1);
        expect(nz).toBeGreaterThan(0.98);
        execFileSync(BIN, ['--normal', npng, '--texel', String(texel), '--out', back]);
        const b = new Float32Array(fs.readFileSync(back).buffer.slice(0));
        const mean = h.reduce((a, v) => a + v, 0) / h.length;
        // away from the borders, within 2.5 cm of the plane over its 3.2 m: one step of an 8-bit normal is a slope error
        // of about 0.4 %, which adds up across the patch (zero mean)
        for (const [x, y] of [[16, 12], [32, 24], [48, 36]]) expect(Math.abs(b[y * W + x] - (h[y * W + x] - mean))).toBeLessThan(0.025);
    });
});
