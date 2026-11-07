/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * AlgorithmicUvEngine modes 'unwrap' and 'rewrap' (UvAtlasRewrap.ts + scratchbox_uv_rewrap.hpp), checked with an
 * independent reader, distortion measure, UV overlap rasteriser and software renderer (helpers/uv-rewrap-fixtures.ts):
 * - UV-less cube, cylinder and sphere unwrap with no overlapping texel and distortion under the thresholds;
 * - a checkerboard-textured sphere (KHR_texture_transform, REPEAT) renders the same before and after rewrap;
 * - a normal-mapped sphere shades the same after rewrap (tangent frames converted, TANGENT rewritten), with and without
 *   TANGENT on the input;
 * - a mesh whose UVs all overlap (every quad maps the whole image) gets non-overlapping UVs that render the same;
 * - a texture that cannot be rebaked is reported with its reason and its material keeps its UVs;
 * - nearest-surface transfer from another mesh;
 * - the agent tool reports the measured numbers.
 * Screenshots go to test-results/screenshots/uv_rewrap/.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AlgorithmicUvEngine } from '../src/node/spatial/AlgorithmicUvEngine';
import { algorithmicUvHandlers } from '../src/node/gemini/tools/algorithmic-uv-tools';
import {
    buildFixtureGlb, cubeMesh, cylinderMesh, icosphereMesh, uvSphereMesh, checkerPng, bumpNormalPng, pngOf,
    renderGlb, orbitCamera, diffRenders, saveSideBySide, uvLayoutImage, uvOverlapTexels, measureDistortion,
    baseColorImage, recordMetrics, type FixturePrimitive, type Rendered
} from './helpers/uv-rewrap-fixtures';

const VIEWS: Array<[number, number]> = [[0, 15], [120, 40], [240, -25]];

async function run(mode: 'unwrap' | 'rewrap', glb: Buffer, uvRewrap: Parameters<typeof AlgorithmicUvEngine.processGlb>[0]['uvRewrap'] = {}) {
    const r = await AlgorithmicUvEngine.processGlb({ inputGlbBuffer: glb, mode, uvRewrap });
    expect(r.mode).toBe(mode);
    expect(r.uvRewrap).toBeDefined();
    const out = r.outputGlbBuffer!;
    expect(out.readUInt32LE(0)).toBe(0x46546c67);
    expect(out.readUInt32LE(8)).toBe(out.length);
    return { result: r, report: r.uvRewrap!, glb: out };
}

function compareViews(name: string, before: Buffer, after: Buffer, shading: 'albedo' | 'lit' | 'normal', size = 320) {
    const diffs = VIEWS.map(([az, el], k) => {
        const cam = orbitCamera(before, az, el, size);
        const A = renderGlb(before, cam, shading), B = renderGlb(after, cam, shading);
        const D: Rendered = { ...A, rgba: new Uint8Array(A.rgba.length) };
        for (let i = 0; i < A.mask.length; i++) {
            const d = Math.max(Math.abs(A.rgba[i * 4] - B.rgba[i * 4]), Math.abs(A.rgba[i * 4 + 1] - B.rgba[i * 4 + 1]), Math.abs(A.rgba[i * 4 + 2] - B.rgba[i * 4 + 2]));
            D.rgba.set([Math.min(255, d * 4), Math.min(255, d * 4), A.mask[i] ? 40 : 0, 255], i * 4);
        }
        saveSideBySide(`${name}_${shading}_view${k}`, [A, B, D]);
        return diffRenders(A, B);
    });
    return diffs;
}

describe('UV unwrap of UV-less meshes', () => {
    const cases: Array<[string, FixturePrimitive]> = [['cube', cubeMesh(1)], ['cylinder', cylinderMesh(0.5, 2, 48, 12)], ['sphere', icosphereMesh(1, 4)]];
    for (const [name, mesh] of cases) {
        it(`${name}: non-overlapping charts with distortion under the thresholds`, async () => {
            const input = buildFixtureGlb({ primitives: [mesh] });
            const { report, glb } = await run('unwrap', input, { atlasSize: 1024 });
            const a = report.atlases[0];
            expect(a.status).toBe('unwrapped');
            expect(a.texCoordWritten).toBe('TEXCOORD_0');
            expect(a.width).toBe(1024);
            // independent checks on the written UVs
            const ov = uvOverlapTexels(glb, 0, 2048);
            expect(ov.covered).toBeGreaterThan(0);
            expect(ov.overlapping).toBe(0);
            expect(report.overlappingTrianglePairs).toBe(0);
            const d = measureDistortion(glb, 0);
            expect(d.flipped).toBe(0);
            expect(d.stretchRms).toBeLessThanOrEqual(1.25);
            expect(d.areaRms).toBeLessThanOrEqual(1.5);
            expect(Math.abs(d.stretchRms - report.distortion.stretchRms)).toBeLessThan(1e-3);
            expect(a.texelDensity.cv).toBeLessThan(0.15);
            expect(a.utilisation).toBeGreaterThan(0.3);
            recordMetrics(`unwrap_${name}`, { charts: a.charts, lscmCharts: a.lscmCharts, splits: a.splits, size: [a.width, a.height], utilisation: a.utilisation, distortion: a.distortion, orthographic: a.orthographicDistortion, independent: d, texelDensity: a.texelDensity, overlapTexels: ov, ms: report.totalMs, timings: a.timings });
            const cams = VIEWS.map(([az, el]) => renderGlb(glb, orbitCamera(glb, az, el, 320), 'checker'));
            saveSideBySide(`unwrap_${name}_checker`, [...cams, uvLayoutImage(glb, 0, 320)]);
        });
    }

    it('the sphere needs flattening: its charts (SLIM / ABF++) beat their orthographic projection', async () => {
        const input = buildFixtureGlb({ primitives: [icosphereMesh(1, 4)] });
        const on = await run('unwrap', input, { atlasSize: 1024 });
        expect(on.report.slimCharts + on.report.abfCharts).toBeGreaterThan(0);
        expect(on.report.distortion.stretchRms).toBeLessThan(on.report.orthographicDistortion.stretchRms);
        expect(measureDistortion(on.glb, 0).flipped).toBe(0);
        recordMetrics('unwrap_sphere_flattened', { charts: on.report.charts, slim: on.report.slimCharts, abf: on.report.abfCharts, d: on.report.distortion, ortho: on.report.orthographicDistortion });
    });

    it('unwrap keeps an existing textured UV set and appends the new one', async () => {
        const m = uvSphereMesh(1, 32, 16);
        m.material = 0;
        const input = buildFixtureGlb({ primitives: [m], materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }], textures: [{ source: 0 }], images: [checkerPng(64, 4)] });
        const { report, glb } = await run('unwrap', input, { atlasSize: 512 });
        expect(report.atlases[0].texCoordWritten).toBe('TEXCOORD_1');
        expect(uvOverlapTexels(glb, 1, 1024).overlapping).toBe(0);
        // textures still sample TEXCOORD_0: the render is unchanged
        const [d] = compareViews('unwrap_keeps_textured_set', input, glb, 'albedo').slice(0, 1);
        expect(d.maxAbs).toBe(0);
    });
});

describe('texture rewrap', () => {
    function texturedSphere(withTangents: boolean): Buffer {
        const m = uvSphereMesh(1, 64, 32);
        m.material = 0;
        // UVs tiled twice in u with REPEAT, and a KHR_texture_transform on the baseColor
        m.uvs = [m.uvs![0].map((x, i) => (i % 2 === 0 ? x * 2 : x))];
        if (!withTangents) delete m.tangents;
        return buildFixtureGlb({
            primitives: [m],
            materials: [{
                pbrMetallicRoughness: { baseColorTexture: { index: 0, extensions: { KHR_texture_transform: { offset: [0.1, 0.05], rotation: 0.3, scale: [1.5, 1.2] } } } },
                normalTexture: { index: 1 }
            }],
            textures: [{ source: 0, sampler: 0 }, { source: 1, sampler: 0 }],
            images: [checkerPng(256, 8), bumpNormalPng(256, 6)],
            samplers: [{ wrapS: 10497, wrapT: 10497 }],
            extensionsUsed: ['KHR_texture_transform']
        });
    }

    it('a checkerboard-textured sphere renders the same before and after rewrap', async () => {
        const input = texturedSphere(true);
        const { result, report, glb } = await run('rewrap', input, { texelDensityScale: 2 });
        expect(result.success).toBe(true);
        const a = report.atlases[0];
        expect(a.status).toBe('rewrapped');
        expect(report.texturesFailed).toEqual([]);
        expect(report.texturesRebaked.map(t => t.slots.join())).toEqual(['pbrMetallicRoughness.baseColorTexture', 'normalTexture']);
        for (const t of report.texturesRebaked) {
            expect(t.sourceSize).toEqual([256, 256]);
            expect(t.outputSize).toEqual([a.width, a.height]);
            expect(t.outputBytes).toBeGreaterThan(0);
        }
        expect(a.bake!.unresolvedTexels).toBe(0);
        expect(uvOverlapTexels(glb, 0, 2048).overlapping).toBe(0);
        const json = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
        expect(json.images).toHaveLength(2);            // old images dropped, two rebaked
        expect(JSON.stringify(json.materials)).not.toContain('KHR_texture_transform');
        expect(json.extensionsUsed ?? []).not.toContain('KHR_texture_transform');
        expect(json.meshes[0].primitives[0].attributes.TANGENT).toBeDefined();
        const diffs = compareViews('rewrap_checker_sphere', input, glb, 'albedo');
        recordMetrics('rewrap_checker_sphere', { diffs, size: [a.width, a.height], charts: a.charts, lscm: a.lscmCharts, distortion: a.distortion, texelDensity: a.texelDensity, utilisation: a.utilisation, bake: a.bake, timings: a.timings, ms: report.totalMs });
        for (const d of diffs) {
            expect(d.maskMismatch).toBe(0);
            expect(d.meanAbs).toBeLessThan(1.0);
            expect(d.p99).toBeLessThan(28);
        }
        const baked = baseColorImage(glb)!;
        saveSideBySide('rewrap_checker_sphere_atlas', [uvLayoutImage(glb, 0, 512, baked)]);
    });

    for (const withTangents of [true, false]) {
        it(`a normal-mapped sphere shades the same after rewrap (${withTangents ? 'TANGENT on the input' : 'tangents built from the UVs'})`, async () => {
            const input = texturedSphere(withTangents);
            const { glb } = await run('rewrap', input, { texelDensityScale: 2 });
            for (const shading of ['normal', 'lit'] as const) {
                const diffs = compareViews(`rewrap_normalmap_${withTangents ? 'tangent' : 'built'}`, input, glb, shading);
                recordMetrics(`rewrap_normalmap_${withTangents ? 'tangent' : 'built'}_${shading}`, diffs);
                for (const d of diffs) {
                    expect(d.maskMismatch).toBe(0);
                    expect(d.meanAbs).toBeLessThan(1.0);
                    // 'lit' multiplies in the checker albedo, whose resampled edges dominate its p99
                    expect(d.p99).toBeLessThan(shading === 'normal' ? 4 : 28);
                }
            }
        });
    }

    it('repairs overlapping UVs: every quad of a cylinder maps the whole image', async () => {
        const side = cylinderMesh(0.5, 2, 16, 4);
        // un-weld the side into quads, each mapped onto the full [0,1]^2 image
        const positions: number[] = [], normals: number[] = [], uv: number[] = [], indices: number[] = [];
        const segs = 16, rings = 4;
        for (let r = 0; r < rings; r++) for (let s = 0; s < segs; s++) {
            const b = positions.length / 3;
            const ids = [r * segs + s, r * segs + (s + 1) % segs, (r + 1) * segs + (s + 1) % segs, (r + 1) * segs + s];
            const quv = [[0, 1], [1, 1], [1, 0], [0, 0]];
            ids.forEach((v, k) => { positions.push(...side.positions.slice(v * 3, v * 3 + 3)); normals.push(...side.normals!.slice(v * 3, v * 3 + 3)); uv.push(...quv[k]); });
            indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
        }
        const input = buildFixtureGlb({
            primitives: [{ positions, normals, indices, uvs: [uv], material: 0 }],
            materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }], textures: [{ source: 0 }], images: [checkerPng(128, 4)]
        });
        expect(uvOverlapTexels(input, 0, 512).overlapping).toBeGreaterThan(1000);
        const { report, glb } = await run('rewrap', input, { texelDensityScale: 2 });
        expect(report.atlases[0].status).toBe('rewrapped');
        expect(uvOverlapTexels(glb, 0, 2048).overlapping).toBe(0);
        const diffs = compareViews('rewrap_overlapping_uvs', input, glb, 'albedo');
        recordMetrics('rewrap_overlapping_uvs', { inputOverlap: uvOverlapTexels(input, 0, 512), outputOverlap: uvOverlapTexels(glb, 0, 2048), diffs });
        for (const d of diffs) { expect(d.maskMismatch).toBe(0); expect(d.meanAbs).toBeLessThan(1.5); }
        saveSideBySide('rewrap_overlapping_uvs_layout', [uvLayoutImage(input, 0, 320, baseColorImage(input)), uvLayoutImage(glb, 0, 320, baseColorImage(glb))]);
    });

    it('reports a texture it cannot rebake and leaves that material\'s UVs as they were', async () => {
        const good = uvSphereMesh(1, 16, 8); good.material = 0;
        const bad = uvSphereMesh(0.5, 16, 8); bad.material = 1; bad.positions = bad.positions.map((x, i) => (i % 3 === 0 ? x + 3 : x));
        const patched = buildFixtureGlb({
            primitives: [good, bad],
            materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }, { pbrMetallicRoughness: { baseColorTexture: { index: 1 } }, emissiveTexture: { index: 0 } }],
            textures: [{ source: 0 }, { source: 1 }],
            images: [checkerPng(64, 4)]
        });
        // image 1 lives outside the GLB
        const pj = JSON.parse(patched.toString('utf8', 20, 20 + patched.readUInt32LE(12)));
        pj.images.push({ uri: 'not_embedded.png' });
        const jsonBuf = Buffer.from(JSON.stringify(pj));
        const pad = Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20);
        const binStart = 20 + patched.readUInt32LE(12);
        const J = Buffer.concat([jsonBuf, pad]);
        const head = Buffer.alloc(20);
        head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + J.length + (patched.length - binStart), 8); head.writeUInt32LE(J.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
        const glbIn = Buffer.concat([head, J, patched.subarray(binStart)]);

        const { result, report, glb } = await run('rewrap', glbIn, {});
        expect(result.success).toBe(false);
        const skipped = report.atlases.find(a => a.material === 1)!;
        expect(skipped.status).toBe('skipped');
        expect(skipped.failures.map(f => f.slot)).toEqual(['pbrMetallicRoughness.baseColorTexture']);
        expect(skipped.failures[0].reason).toMatch(/not embedded/);
        expect(report.texturesFailed).toHaveLength(1);
        expect(report.atlases.find(a => a.material === 0)!.status).toBe('rewrapped');
        // the skipped material's primitive keeps its UVs byte for byte
        const out = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
        const readUv = (g: Buffer, j: any, mesh: number) => {
            const acc = j.accessors[j.meshes[mesh].primitives[0].attributes.TEXCOORD_0], bv = j.bufferViews[acc.bufferView];
            const binOff = 20 + g.readUInt32LE(12) + 8;
            return g.subarray(binOff + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0), binOff + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0) + acc.count * 8);
        };
        expect(Buffer.compare(readUv(glb, out, 1), readUv(glbIn, pj, 1))).toBe(0);
    });

    it('bakes from another mesh by nearest surface (transfer onto a UV-less remesh)', async () => {
        const src = uvSphereMesh(1, 96, 48); src.material = 0; delete src.tangents;
        const source = buildFixtureGlb({ primitives: [src], materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, baseColorFactor: [1, 0.8, 0.8, 1] } }], textures: [{ source: 0 }], images: [checkerPng(256, 8)] });
        const target = buildFixtureGlb({ primitives: [{ ...icosphereMesh(1, 5), material: 0 }], materials: [{ pbrMetallicRoughness: { metallicFactor: 0 } }] });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uv-transfer-'));
        try {
            const srcPath = path.join(dir, 'source.glb');
            fs.writeFileSync(srcPath, source);
            const { report, glb } = await run('rewrap', target, { transferSourceGlbPath: srcPath, texelsPerMeter: 160 });
            const a = report.atlases[0];
            expect(a.status).toBe('rewrapped');
            expect(a.bake!.unresolvedTexels).toBe(0);
            expect(a.bake!.maxTransferDistanceM!).toBeLessThan(0.01);
            const out = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
            expect(out.materials[0].pbrMetallicRoughness.baseColorTexture.index).toBeDefined();
            expect(out.materials[0].pbrMetallicRoughness.baseColorFactor ?? [1, 1, 1, 1]).toEqual([1, 1, 1, 1]);   // the source factor is baked into the texels
            const diffs = compareViews('rewrap_transfer_remesh', source, glb, 'albedo');
            recordMetrics('rewrap_transfer_remesh', { diffs, bake: a.bake });
            for (const d of diffs) expect(d.meanAbs).toBeLessThan(3);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('algorithmic_uv_unwrap_rewrap tool', () => {
    it('rewraps a file and reports charts, distortion, density, utilisation and textures', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uv-tool-'));
        try {
            const m = uvSphereMesh(1, 48, 24); m.material = 0;
            const inPath = path.join(dir, 'in.glb');
            fs.writeFileSync(inPath, buildFixtureGlb({ primitives: [m], materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }], textures: [{ source: 0 }], images: [pngOf(128, 128, (x, y) => [x * 2, y * 2, 128])] }));
            const outcome = await algorithmicUvHandlers.algorithmic_uv_unwrap_rewrap({ inputGlbPath: 'in.glb', mode: 'rewrap', atlasSize: 512 }, { workspaceRoot: dir } as any);
            expect(outcome.status).toBe('completed');
            const outPath = path.join(dir, 'in_rewrap.glb');
            expect(fs.existsSync(outPath)).toBe(true);
            expect(outcome.summaryResult).toMatch(/charts \(\d+ SLIM, \d+ ABF\+\+, \d+ LSCM, \d+ orthographic\), 0 overlapping/);
            expect(outcome.summaryResult).toMatch(/angle stretch \d\.\d\d/);
            expect(outcome.summaryResult).toMatch(/atlas utilisation \d+\.\d%/);
            expect(outcome.summaryResult).toMatch(/Rebaked 1 textures \(pbrMetallicRoughness\.baseColorTexture 512x512\)/);
            const payload = outcome.resultPayload as any;
            expect(payload.uvRewrap.atlases[0].worstCharts.length).toBeGreaterThan(0);
            expect(payload.uvRewrap.atlases[0].chartDetails).toBeUndefined();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
