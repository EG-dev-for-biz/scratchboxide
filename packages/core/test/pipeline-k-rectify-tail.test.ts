/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The straightened orthos' tail (pipeline-k/rectify-tail.ts) on its worker thread writes the very files it writes on the
 * main thread: two facades facing the same way, the first with a smear two storeys tall across its whole width (a hole
 * inside it), so the featureless continuation and the re-encode run.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { rectifyReliefOrthos } from '../src/node/3d-engine/staged-location/pipeline-k/pipeline-k';

const PX = 0.075, W = 240, H = 480;
const PITCH = 3 / PX, STOREY = 3.5 / PX;

/** A facade of piers and bays, every column shifted by wobble(y) px. */
function facade(wobble: (y: number) => number, seed: number): Uint8Array {
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const xs = x - wobble(y), u = ((xs % PITCH) + PITCH) % PITCH, v = y % STOREY;
        let L = u < 0.9 / PX ? 200 : v < 0.4 / PX ? 150 : Math.abs(u - (0.9 + 1.05) / PX) < 1 ? 110 : 60;
        L += 6 * Math.sin(xs * 0.37 + y * 0.9 + seed);
        const i = (y * W + x) * 4;
        rgba[i] = Math.round(L * 1.05); rgba[i + 1] = Math.round(L); rgba[i + 2] = Math.round(L * 0.92); rgba[i + 3] = 255;
    }
    return rgba;
}

function orthos(dir: string): string {
    const src = path.join(dir, 'relief_orthos');
    fs.mkdirSync(src, { recursive: true });
    const a = facade(y => 3 * Math.sin(y / 60), 0), b = facade(y => 2 * Math.sin(y / 45 + 1), 2);
    // facade 0: two storeys across its whole width a smear (one flat colour, no feature), and a hole inside it the photo
    // never reached
    for (let y = 200; y < 200 + 2 * STOREY; y++) for (let x = 0; x < W; x++) a.set(x > 100 && x < 140 && y > 220 && y < 250 ? [128, 128, 128, 255] : [131, 125, 116, 255], (y * W + x) * 4);
    fs.writeFileSync(path.join(src, 'facade_0.png'), encodePng(W, H, a, 4));
    fs.writeFileSync(path.join(src, 'facade_1.png'), encodePng(W, H, b, 4));
    const base = { normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], sMin: 0, sMax: W * PX, tMin: 0, tMax: H * PX, pixel: PX, width: W, height: H, orthoSMin: 0, orthoTMax: H * PX, coverage: 0.9 };
    fs.writeFileSync(path.join(src, 'facades.json'), JSON.stringify({ schema: 'test', facades: [
        { ...base, facadeId: 0, image: 'facade_0.png', centroid: [0, 0, 0] },
        { ...base, facadeId: 1, image: 'facade_1.png', centroid: [40, 0, 0] }
    ] }));
    return src;
}

const files = (dir: string) => fs.readdirSync(dir).filter(f => !fs.statSync(path.join(dir, f)).isDirectory()).sort();
const untimed = (text: string) => text.replace(/"ms": ?[0-9.]+/g, '"ms":0');

describe('pipeline K: the orthos\' tail on a worker thread', () => {
    it('writes the same orthos, masks and reports as on the main thread', async () => {
        const inline = await rectifyReliefOrthos(orthos(fs.mkdtempSync(path.join(os.tmpdir(), 'k-tail-a-'))), { threads: 1, inlineTail: true });
        const worker = await rectifyReliefOrthos(orthos(fs.mkdtempSync(path.join(os.tmpdir(), 'k-tail-b-'))), { threads: 1 });
        expect(files(worker.orthosDir)).toEqual(files(inline.orthosDir));
        for (const f of files(inline.orthosDir)) {
            const a = fs.readFileSync(path.join(inline.orthosDir, f)), b = fs.readFileSync(path.join(worker.orthosDir, f));
            if (f === 'rectify.json') expect(untimed(b.toString())).toBe(untimed(a.toString()));
            else expect(b.equals(a), f).toBe(true);
        }
        expect(JSON.stringify(worker.reports).replace(/"ms":[0-9.]+/g, '')).toBe(JSON.stringify(inline.reports).replace(/"ms":[0-9.]+/g, ''));
        // the tail did its work: the band was refilled, from the other facade or smoothly, and no report carries pixels
        const holes = inline.reports[0].report!.holes as { featureless?: number; continued?: { texels: number } };
        expect(holes.continued?.texels ?? 0).toBeGreaterThan(0);
        expect(JSON.stringify(worker.reports)).not.toContain('pixels');
    }, 120_000);
});
