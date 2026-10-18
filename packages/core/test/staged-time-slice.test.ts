/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { Box1000, OrnamentElement } from '../src/common/spatial/staged-location-contracts';
import { renderedBox, reprojectDetail, reprojectDetailAsync } from '../src/node/3d-engine/staged-location/detail-reprojection';
import type { GlbNode } from '../src/node/3d-engine/staged-location/glb-nodes';
import { castCamera } from '../src/node/3d-engine/staged-location/survey-casting';
import { computeSlotOffer, computeSlotOfferAsync, readFittedShells } from '../src/node/3d-engine/staged-location/slot-exposure';
import { timeSlicer } from '../src/node/3d-engine/staged-location/time-slice';
import { findArchFit } from './helpers/real-arch-data';

/** The longest gap between ticks of a 2 ms timer while `work` runs (how long the thread was held in one block). */
async function longestBlock(work: () => Promise<unknown> | unknown): Promise<number> {
    let last = performance.now(), worst = 0;
    const t = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last); last = n; }, 2);
    await new Promise(r => setTimeout(r, 10));
    last = performance.now();
    await work();
    await new Promise(r => setTimeout(r, 10));
    clearInterval(t);
    return worst;
}

function boxNode(name: string, lo: [number, number, number], hi: [number, number, number]): GlbNode {
    const v: number[] = [], ix: number[] = [];
    for (let k = 0; k < 8; k++) v.push(k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]);
    for (const [a, b, c, d] of [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]) ix.push(a, b, c, a, c, d);
    return { name, positions: Float32Array.from(v), indices: Uint32Array.from(ix) };
}

const element = (id: string, evidence: Array<{ imageId: string; box1000: Box1000 }>): OrnamentElement => ({
    id, slotId: 'S01', label: id, spec: {} as OrnamentElement['spec'], confidence: 0.9, depthBasis: '', evidence,
    checks: { slotOverlap: 1, minFeatureM: 0.1, nativeSampleM: 0.02 }, provenance: { label: 'photo-inferred', measuredGeometry: false, confidence: 0.9 } as OrnamentElement['provenance'], buildOrder: 0
});

describe('time-sliced main-thread work of the vision stage', () => {
    it('a slicer yields only once its slice is spent', async () => {
        let t = 0;
        const s = timeSlicer(8, () => t);
        expect(s.due()).toBeUndefined();
        t = 9;
        await s.due();
        expect(s.yields).toBe(1);
        expect(s.due()).toBeUndefined();
    });

    it('the reprojection gate gives the same result time-sliced, and lets the thread go between renders', async () => {
        // a heavy occluder (a finely tessellated wall) and many elements cited in several views: the renders add up
        const wallV: number[] = [], wallI: number[] = [];
        const N = 260;
        for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) wallV.push(-12 + (24 * i) / N, (14 * j) / N, -0.05 * Math.sin(i * 0.7) * Math.cos(j * 0.5));
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = j * (N + 1) + i; wallI.push(a, a + 1, a + N + 2, a, a + N + 2, a + N + 1); }
        const occluder = { vertices: Float32Array.from(wallV), indices: Uint32Array.from(wallI) };
        const cams = new Map(Array.from({ length: 6 }, (_, k) => [`sv:${k}`, castCamera({ eye: [-6 + 2.4 * k, 2.5, 16], headingDeg: -10 + 4 * k, pitchDeg: 8, fovDeg: 60, widthPx: 1920, heightPx: 1280 })]));
        const nodes: GlbNode[] = [], elements: OrnamentElement[] = [];
        for (let k = 0; k < 48; k++) {
            const x = -9 + 0.375 * k, y = 2 + (k % 5) * 2;
            const n = boxNode(`e${k}`, [x, y, 0], [x + 0.5, y + 0.6, 0.25]);
            nodes.push(n);
            const cited = renderedBox({ vertices: n.positions, indices: n.indices! }, { ...cams.get('sv:0')!, width: 640, height: 427, fx: cams.get('sv:0')!.fx / 3, fy: cams.get('sv:0')!.fy / 3, cx: cams.get('sv:0')!.cx / 3, cy: cams.get('sv:0')!.cy / 3 }) ?? [0, 0, 10, 10];
            elements.push(element(`e${k}`, [...cams.keys()].map(imageId => ({ imageId, box1000: cited as Box1000 }))));
        }
        let sync: ReturnType<typeof reprojectDetail> = [];
        const blockSync = await longestBlock(() => { sync = reprojectDetail(nodes, elements, id => cams.get(id), { occluder }); });
        let sliced: ReturnType<typeof reprojectDetail> = [];
        const blockSliced = await longestBlock(async () => { sliced = await reprojectDetailAsync(nodes, elements, id => cams.get(id), { occluder }); });
        expect(sliced).toEqual(sync);
        expect(sync.some(g => g.accepted)).toBe(true);
        expect(blockSync).toBeGreaterThan(60);
        expect(blockSliced).toBeLessThan(blockSync / 3);
    });

    const arch = findArchFit();
    it.skipIf(!arch)('the slot offer on the real arch fit is the same time-sliced, in blocks of one slot at most', async () => {
        const fit = JSON.parse(fs.readFileSync(arch!.fitPath, 'utf8'));
        fit.outputs = { ...fit.outputs, fittedGlb: path.join(arch!.dir, 'fitted.glb'), passThroughGlb: path.join(arch!.dir, 'passthrough.glb') };
        const solid = readFittedShells(fit);
        expect(solid).toBeDefined();
        const sync = computeSlotOffer(fit, [], solid);
        let sliced: typeof sync | undefined;
        const block = await longestBlock(async () => { sliced = await computeSlotOfferAsync(fit, [], solid); });
        expect([...sliced!.offeredIds]).toEqual([...sync.offeredIds]);
        expect(sliced!.entries).toEqual(sync.entries);
        expect(sliced!.hidden).toBe(sync.hidden);
        expect(sync.covers.size).toBeGreaterThan(0);
        // one slot's cover took 13 ms at most here; the whole offer ~150 ms (0.5 s live, in one block before)
        expect(block).toBeLessThan(60);
    });
});
