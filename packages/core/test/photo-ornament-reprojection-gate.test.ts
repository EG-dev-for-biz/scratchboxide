/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Reprojection accept gate: a built element that lands on the box the model cited is kept; one built somewhere else (an
 * element the model placed away from what it saw), or hidden behind the structure in every image it cites, is rejected with
 * the reason; an element read only from tile orthos is not gated.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { Box1000, OrnamentElement } from '../src/common/spatial/staged-location-contracts';
import { DETAIL_REPROJECTION_MIN_IOU, renderedBox, reprojectDetail } from '../src/node/3d-engine/staged-location/detail-reprojection';
import type { GlbNode } from '../src/node/3d-engine/staged-location/glb-nodes';
import { castCamera } from '../src/node/3d-engine/staged-location/survey-casting';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { renderFrameDepth } from '../src/node/spatial/StreetViewPoseRegistrar';

/** An axis-aligned box as a GLB node (12 triangles). */
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

describe('photo-read detail: reprojection accept gate', () => {
    it('keeps an element built where it was read and rejects one built elsewhere or hidden', () => {
        // a wall at z = 0 (front facing south), a camera 15 m south looking north at it
        const cam = castCamera({ eye: [0, 3, 15], headingDeg: 0, pitchDeg: 5, fovDeg: 60, widthPx: 1200, heightPx: 900 });
        const wall = boxNode('wall', [-8, 0, -1], [8, 10, 0]);
        const roundel = boxNode('e-real', [-3, 5, 0], [-1.6, 6.4, 0.3]);
        const invented = boxNode('e-invented', [3, 8, 0], [5, 9.5, 0.3]);
        const behind = boxNode('e-hidden', [0, 4, -1.6], [1, 5, -1.3]);
        const small = { width: 320, height: 240, fx: cam.fx * 320 / 1200, fy: cam.fy * 320 / 1200, cx: cam.cx * 320 / 1200, cy: cam.cy * 320 / 1200 };
        const at = (n: GlbNode) => renderedBox({ vertices: n.positions, indices: n.indices! }, { ...cam, ...small })!;
        // the model cites the roundel where it is, and the invented element at the roundel's place too (it saw the roundel)
        const roundelBox = at(roundel);
        const elements = [
            element('e-real', [{ imageId: 'sv:A', box1000: roundelBox }]),
            element('e-invented', [{ imageId: 'sv:A', box1000: roundelBox }]),
            element('e-hidden', [{ imageId: 'sv:A', box1000: [400, 450, 500, 520] }]),
            element('e-ortho', [{ imageId: 'ortho:s01', box1000: [0, 0, 100, 100] }])
        ];
        const nodes = [roundel, invented, behind, boxNode('e-ortho', [6, 1, 0], [7, 2, 0.2])];
        const gate = reprojectDetail(nodes, elements, id => (id === 'sv:A' ? cam : undefined), { occluder: { vertices: wall.positions, indices: wall.indices! } });
        const by = new Map(gate.map(g => [g.elementId, g]));
        expect(by.get('e-real')!.accepted).toBe(true);
        expect(by.get('e-real')!.iou!).toBeGreaterThan(0.9);
        expect(by.get('e-invented')!.accepted).toBe(false);
        expect(by.get('e-invented')!.iou!).toBeLessThan(DETAIL_REPROJECTION_MIN_IOU);
        expect(by.get('e-invented')!.reason).toMatch(/built away from where it was read/);
        expect(by.get('e-hidden')!.accepted).toBe(false);
        expect(by.get('e-hidden')!.reason).toMatch(/none of the built element shows/);
        expect(by.get('e-ortho')!.accepted).toBe(true);
        expect(by.get('e-ortho')!.iou).toBeNull();

        // screenshot: the wall's depth with the cited box (white) and the elements as built (grey levels)
        const W = 320, H = 240, img = new Uint8Array(W * H * 4).fill(255);
        const shade = (n: GlbNode, g: number) => {
            const d = renderFrameDepth({ vertices: n.positions, indices: n.indices! }, { ...cam, ...small });
            for (let i = 0; i < W * H; i++) if (d[i] < 1e8) img.set([g, g, g, 255], i * 4);
        };
        shade(wall, 200); shade(roundel, 90); shade(invented, 40);
        for (let x = Math.round(roundelBox[1] * W / 1000); x < roundelBox[3] * W / 1000; x++) for (const y of [Math.round(roundelBox[0] * H / 1000), Math.round(roundelBox[2] * H / 1000) - 1]) img.set([255, 0, 0, 255], (y * W + x) * 4);
        const out = path.resolve(__dirname, '../../../test-results/screenshots');
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, 'photo_ornament_reprojection_gate.png'), encodePng(W, H, img, 4));
    });
});
