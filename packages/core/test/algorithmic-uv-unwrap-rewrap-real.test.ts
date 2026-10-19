/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * UV unwrap / rewrap on real data (gitignored; the suite skips with a reason without it):
 * - SCRATCHBOX_UV_REAL_TEXTURED: a textured Google 3D Tiles scan (e.g. a staged-location run's tiles/<key>/textured.glb):
 *   rewrapped with its own texel density; renders before and after from the same cameras are compared.
 * - SCRATCHBOX_UV_REAL_ORGANIC: an organic or sculptural mesh without UVs (e.g. a staged run's figures/<key>/figures.glb):
 *   unwrapped; checked for overlaps and distortion and rendered with a UV checker.
 * Screenshots and metrics go to test-results/screenshots/uv_rewrap/.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import { AlgorithmicUvEngine } from '../src/node/spatial/AlgorithmicUvEngine';
import { renderGlb, orbitCamera, diffRenders, saveSideBySide, uvLayoutImage, measureDistortion, recordMetrics, buildFixtureGlb, uvOverlapTexels, type Rendered } from './helpers/uv-rewrap-fixtures';
import { parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { withReason, type Requirement } from './helpers/requirements';

function realFile(env: string, what: string): { path?: string; req: Requirement } {
    const p = process.env[env];
    if (p && fs.existsSync(p)) return { path: p, req: { ok: true, reason: '' } };
    return { req: { ok: false, reason: `set ${env} to ${what} (gitignored real data from a staged-location run)` } };
}

const textured = realFile('SCRATCHBOX_UV_REAL_TEXTURED', 'a textured Google 3D Tiles GLB');
const organic = realFile('SCRATCHBOX_UV_REAL_ORGANIC', 'an organic mesh GLB without UVs');

function heat(A: Rendered, B: Rendered): Rendered {
    const D: Rendered = { ...A, rgba: new Uint8Array(A.rgba.length) };
    for (let i = 0; i < A.mask.length; i++) {
        const d = Math.max(Math.abs(A.rgba[i * 4] - B.rgba[i * 4]), Math.abs(A.rgba[i * 4 + 1] - B.rgba[i * 4 + 1]), Math.abs(A.rgba[i * 4 + 2] - B.rgba[i * 4 + 2]));
        D.rgba.set([Math.min(255, d * 4), Math.min(255, d * 4), A.mask[i] ? 40 : 0, 255], i * 4);
    }
    return D;
}

/** Per-atlas overlap check of TEXCOORD `set`: each primitive's UVs rasterised on their own (atlases share [0,1]^2). */
function perPrimitiveOverlap(glb: Buffer, set: number): number {
    const g = parseGlbBytes(glb);
    let overlapping = 0;
    for (const m of g.json.meshes) for (const p of m.primitives) {
        if (p.attributes[`TEXCOORD_${set}`] === undefined) continue;
        const one = buildFixtureGlb({ primitives: [{ positions: Array.from(readAccessor(g, p.attributes.POSITION).data), indices: Array.from(readAccessor(g, p.indices).data), uvs: [Array.from(readAccessor(g, p.attributes[`TEXCOORD_${set}`]).data)] }] });
        overlapping += uvOverlapTexels(one, 0, 1024).overlapping;
    }
    return overlapping;
}

describe.skipIf(!textured.req.ok)(withReason('rewrap of a real textured Google 3D Tiles scan', textured.req), () => {
    // default: the source's own texel density and image format (JPEG re-encoded); and at twice the density, lossless
    const variants: Array<{ name: string; options: { texelDensityScale?: number; outputImageFormat?: 'png' }; maxMeanAbs: number }> = [
        { name: 'default', options: {}, maxMeanAbs: 4.5 },
        { name: 'x2_png', options: { texelDensityScale: 2, outputImageFormat: 'png' }, maxMeanAbs: 1.6 }
    ];
    for (const v of variants) {
        it(`rewraps every material and renders the same from four cameras (${v.name})`, async () => {
            const input = fs.readFileSync(textured.path!);
            const t0 = performance.now();
            const r = await AlgorithmicUvEngine.processGlb({ inputGlbBuffer: input, mode: 'rewrap', uvRewrap: v.options });
            const ms = performance.now() - t0;
            const rep = r.uvRewrap!;
            expect(r.success).toBe(true);
            expect(rep.texturesFailed).toEqual([]);
            expect(rep.overlappingTrianglePairs).toBe(0);
            expect(perPrimitiveOverlap(r.outputGlbBuffer!, 0)).toBe(0);
            const out = r.outputGlbBuffer!;
            const views: Array<[number, number]> = [[30, 35], [120, 25], [210, 45], [300, 20]];
            const diffs = views.map(([az, el], k) => {
                const cam = orbitCamera(input, az, el, 640, 1.3);
                const A = renderGlb(input, cam, 'albedo'), B = renderGlb(out, cam, 'albedo');
                saveSideBySide(`real_tile_rewrap_${v.name}_view${k}`, [A, B, heat(A, B)]);
                return diffRenders(A, B);
            });
            for (const d of diffs) {
                expect(d.maskMismatch).toBeLessThan(d.pixels * 0.001);
                expect(d.meanAbs).toBeLessThan(v.maxMeanAbs);
            }
            const biggest = [...rep.atlases].sort((a, b) => b.triangles - a.triangles)[0];
            const timings = ['unwrapMs', 'chartsMs', 'packMs', 'decodeMs', 'bakeMs', 'encodeMs'].reduce((o, k) => ({ ...o, [k]: rep.atlases.reduce((s, a) => s + (a.timings as unknown as Record<string, number>)[k], 0) }), {});
            recordMetrics(`real_tile_rewrap_${v.name}`, {
                ms, timings, inputBytes: input.length, outputBytes: out.length, atlases: rep.atlases.length, charts: rep.charts, lscmCharts: rep.lscmCharts,
                triangles: rep.atlases.reduce((s, a) => s + a.triangles, 0), distortion: rep.distortion, orthographic: rep.orthographicDistortion,
                texelDensity: rep.texelDensity, utilisation: rep.utilisation, textures: rep.texturesRebaked.length, diffs,
                biggest: { material: biggest.material, triangles: biggest.triangles, charts: biggest.charts, size: [biggest.width, biggest.height], textures: biggest.textures }
            });
            if (v.name === 'default') saveSideBySide('real_tile_rewrap_atlas', [uvLayoutImage(input, 0, 512), uvLayoutImage(out, 0, 512)]);
        }, 600_000);
    }
});

describe.skipIf(!organic.req.ok)(withReason('unwrap of a real organic mesh', organic.req), () => {
    it('unwraps sculpted figures without overlaps and with low distortion', async () => {
        const input = fs.readFileSync(organic.path!);
        const t0 = performance.now();
        const r = await AlgorithmicUvEngine.processGlb({ inputGlbBuffer: input, mode: 'unwrap', uvRewrap: { atlasSize: 4096 } });
        const ms = performance.now() - t0;
        const rep = r.uvRewrap!;
        expect(rep.overlappingTrianglePairs).toBe(0);
        expect(perPrimitiveOverlap(r.outputGlbBuffer!, 0)).toBe(0);
        const d = measureDistortion(r.outputGlbBuffer!, 0);
        expect(d.flipped).toBe(0);
        expect(d.stretchRms).toBeLessThan(1.25);
        expect(d.areaRms).toBeLessThan(1.5);
        const out = r.outputGlbBuffer!;
        const views: Array<[number, number]> = [[0, 10], [90, 20], [180, 10], [270, 30]];
        const shots = views.map(([az, el]) => renderGlb(out, orbitCamera(out, az, el, 480, 1.6), 'checker'));
        saveSideBySide('real_organic_unwrap_checker', shots);
        saveSideBySide('real_organic_unwrap_layout', [uvLayoutImage(out, 0, 768)]);
        recordMetrics('real_organic_unwrap', { ms, triangles: rep.atlases.reduce((s, a) => s + a.triangles, 0), charts: rep.charts, lscmCharts: rep.lscmCharts, distortion: rep.distortion, orthographic: rep.orthographicDistortion, independent: d, texelDensity: rep.texelDensity, utilisation: rep.utilisation, atlases: rep.atlases.map(a => ({ size: [a.width, a.height], charts: a.charts, lscm: a.lscmCharts, splits: a.splits, over: a.chartsOverThreshold, timings: a.timings })) });
    }, 600_000);
});
