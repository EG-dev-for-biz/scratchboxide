/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The texture-stage fixtures of the staged build tests: a fake extraction rewritten as a photo-textured GLB (planar UVs,
 * a striped stone photo) and a scan fitter whose fitted body is the scanned box. No network, no model calls.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ScanFitDeps } from '../../src/node/3d-engine/staged-location/orchestrator';
import { encodePng } from '../../src/node/texture-processing';
import { building, readTris, writeTris, type Tri } from './staged-synthetic-world';
import { structureFit } from './staged-location-fixtures';
import { writeStagedGlbFile } from '../../src/node/3d-engine/staged-location/staged-glb-writer';
import { area, lump, noise, patch } from './redundant-scan-fixtures';

/** Rewrites a fake extraction's triangles as a photo-textured GLB: planar UVs by dominant axis, a striped stone photo. */
export function photoTexture(file: string): void {
    const tris: Tri[] = readTris(file);
    const pos = new Float32Array(tris.length * 9), uv = new Float32Array(tris.length * 6);
    tris.forEach((t, k) => {
        pos.set(t, k * 9);
        const e1 = [t[3] - t[0], t[4] - t[1], t[5] - t[2]], e2 = [t[6] - t[0], t[7] - t[1], t[8] - t[2]];
        const n = [Math.abs(e1[1] * e2[2] - e1[2] * e2[1]), Math.abs(e1[2] * e2[0] - e1[0] * e2[2]), Math.abs(e1[0] * e2[1] - e1[1] * e2[0])];
        const axis = n[0] >= n[1] && n[0] >= n[2] ? 0 : n[1] >= n[2] ? 1 : 2;
        for (let j = 0; j < 3; j++) {
            const p = [t[j * 3], t[j * 3 + 1], t[j * 3 + 2]];
            const [a, b] = axis === 0 ? [p[2], p[1]] : axis === 1 ? [p[0], p[2]] : [p[0], p[1]];
            uv[k * 6 + j * 2] = a / 8; uv[k * 6 + j * 2 + 1] = 1 - b / 8;
        }
    });
    const W = 128, rgba = new Uint8Array(W * W * 4);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        const course = ((y >> 3) & 1) ? 0 : 6, mortar = (y & 7) === 0 || ((x + course) & 15) === 0;
        const c = mortar ? [120, 112, 100] : [196 + ((x * 7 + y * 3) % 9), 184, 160];
        rgba.set([c[0], c[1], c[2], 255], (y * W + x) * 4);
    }
    const png = encodePng(W, W, Buffer.from(rgba));
    const chunks = [Buffer.from(pos.buffer), Buffer.from(uv.buffer), png];
    const views: any[] = [];
    let off = 0;
    const parts: Buffer[] = [];
    for (const c of chunks) { views.push({ buffer: 0, byteOffset: off, byteLength: c.length }); const pad = (4 - (c.length % 4)) % 4; parts.push(c, Buffer.alloc(pad)); off += c.length + pad; }
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let q = 0; q < 3; q++) { mn[q] = Math.min(mn[q], pos[i + q]); mx[q] = Math.max(mx[q], pos[i + q]); }
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'leaf', mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
        accessors: [{ bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: mn, max: mx }, { bufferView: 1, componentType: 5126, count: uv.length / 2, type: 'VEC2' }],
        bufferViews: views, buffers: [{ byteLength: off }], images: [{ bufferView: 2, mimeType: 'image/png' }], samplers: [{ wrapS: 10497, wrapT: 10497 }],
        textures: [{ source: 0, sampler: 0 }], materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 } }]
    };
    let j = Buffer.from(JSON.stringify(json));
    j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
    const bin = Buffer.concat(parts);
    const h = Buffer.alloc(12); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(28 + j.length + bin.length, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(j.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
    fs.writeFileSync(file, Buffer.concat([h, jh, j, bh, bin]));
}

/** A scan fitter whose fitted body is the scanned box (so the tile photo lies on it); refit and ornament are not used here. */
export function fitter(dir: string, opts: { delayMs?: number; redundantPassThrough?: boolean } = {}): ScanFitDeps {
    fs.mkdirSync(dir, { recursive: true });
    return {
        fit: async () => {
            if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
            const f = structureFit();
            f.outputs.fittedGlb = writeTris(path.join(dir, 'fit_fitted.glb'), building(-13, 13, -6, 5, 22));
            f.outputs.outlinesGlb = writeTris(path.join(dir, 'fit_outlines.glb'), building(-13, 13, -6, 5, 0.1));
            f.outputs.passThroughGlb = undefined;
            f.passThrough.regions = [];
            if (opts.redundantPassThrough) {
                // a noisy scan copy of the north face 5 cm in front of it, a lump 1.3 m proud of it, a fragment past its edge
                const pieces = REDUNDANT_PIECES();
                f.outputs.passThroughGlb = path.join(dir, 'fit_pass.glb');
                writeStagedGlbFile(f.outputs.passThroughGlb, pieces);
                f.passThrough.regions = pieces.map(n => ({ id: n.name, triangles: n.indices!.length / 3, areaM2: area(n), aabbMin: [0, 0, 0], aabbMax: [1, 1, 1], reason: 'not box-like' }));
                f.passThrough.areaM2 = pieces.reduce((a, n) => a + area(n), 0);
            }
            f.outputs.reportJson = path.join(dir, 'fit_structure_fit.json');
            fs.writeFileSync(f.outputs.reportJson, JSON.stringify(f));
            return { value: f, path: f.outputs.reportJson, dir, key: '7c1e04aa'.padEnd(64, '0'), binarySha256: 'b', cached: false, builtAtMs: Date.now(), ms: 30, waitedForEngineMs: 0 } as any;
        },
        refit: async () => { throw new Error('not used'); },
        ornament: async () => { throw new Error('not used'); },
        flatten: async () => { throw new Error('not used'); }
    };
}

/** Pass-through pieces against the fitted north face (z = -6, x -13..13, y 0..22). */
export const REDUNDANT_PIECES = () => [
    patch('r0', -10, 10, 2, 18, 0.5, (x, y) => -6.05 + noise(x, y)),
    lump('r1', [0, 8, -7.3], 0.6),
    patch('r2', 14, 16, 4, 6, 0.5, (x, y) => -6.05 + noise(x, y))
];

