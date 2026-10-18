/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import { SurveySynthesisEngine } from '../src/common/spatial/SurveySynthesisEngine';
import { SurveySplatPipelineService } from '../src/node/spatial/SurveySplatPipelineService';
import { HeadlessMeshSilhouetteRenderer } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { SplatService } from '../src/node/3d-engine/splat-service';
import { decodePng, encodePng } from '../src/node/texture-processing';
import type { StationImageGenerator } from '../src/node/spatial/BeautifyStationService';
import type { GeodeticAnchor } from '../src/common/spatial/colmap-vector-reference-types';

const ANCHOR: GeodeticAnchor = { lat: -33.8568, lng: 151.2153, elevationMeters: 12, headingDeg: 0, formattedAddress: 'test' };
const GLB = path.resolve(process.cwd(), 'build/test_survey_render/box_ground.glb'); // written by survey-station-render.test.ts
const OUT = path.resolve(process.cwd(), 'build/test_survey_splats');

/** Mock beautifier: blockout recoloured (box brick-red, ground sand, sky left as is). Geometry untouched. */
const recolour: StationImageGenerator = {
    name: 'mock-recolour',
    async generate(args) {
        const b = decodePng(args.blockoutPng);
        const out = Buffer.alloc(b.rgba.length);
        for (let i = 0; i < b.rgba.length; i += 4) {
            const r = b.rgba[i], g = b.rgba[i + 1], bl = b.rgba[i + 2];
            const isSky = bl > 170 && r < 140;
            if (isSky) { out[i] = 135; out[i + 1] = 170; out[i + 2] = 215; }
            else if (Math.abs(r - g) < 6 && r < 150) { out[i] = 170; out[i + 1] = 70; out[i + 2] = 50; }   // darker shaded faces = box
            else { out[i] = 200; out[i + 1] = 170; out[i + 2] = 120; }                                       // ground
            out[i + 3] = 255;
        }
        return encodePng(b.width, b.height, out);
    }
};

/** Distance from a point to the nearest triangle of the mesh (brute force; test meshes are tiny). */
function distanceToMesh(p: number[], mesh: { vertices: ArrayLike<number>; indices: ArrayLike<number> }): number {
    let best = Infinity;
    const v = mesh.vertices, idx = mesh.indices;
    for (let t = 0; t < idx.length; t += 3) {
        const a = [v[idx[t] * 3], v[idx[t] * 3 + 1], v[idx[t] * 3 + 2]];
        const b = [v[idx[t + 1] * 3], v[idx[t + 1] * 3 + 1], v[idx[t + 1] * 3 + 2]];
        const c = [v[idx[t + 2] * 3], v[idx[t + 2] * 3 + 1], v[idx[t + 2] * 3 + 2]];
        best = Math.min(best, pointTriangleDistance(p, a, b, c));
        if (best < 1e-4) break;
    }
    return best;
}
function pointTriangleDistance(p: number[], a: number[], b: number[], c: number[]): number {
    // Ericson, Real-Time Collision Detection 5.1.5
    const sub = (x: number[], y: number[]) => [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
    const dot = (x: number[], y: number[]) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
    const d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return Math.hypot(...ap);
    const bp = sub(p, b); const d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return Math.hypot(...bp);
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const t = d1 / (d1 - d3); return Math.hypot(...sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t])); }
    const cp = sub(p, c); const d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return Math.hypot(...cp);
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); return Math.hypot(...sub(p, [a[0] + ac[0] * t, a[1] + ac[1] * t, a[2] + ac[2] * t])); }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { const t = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return Math.hypot(...sub(p, [b[0] + (c[0] - b[0]) * t, b[1] + (c[1] - b[1]) * t, b[2] + (c[2] - b[2]) * t])); }
    const denom = 1 / (va + vb + vc); const vv = vb * denom, ww = vc * denom;
    return Math.hypot(...sub(p, [a[0] + ab[0] * vv + ac[0] * ww, a[1] + ab[1] * vv + ac[1] * ww, a[2] + ab[2] * vv + ac[2] * ww]));
}

describe('SurveySplatPipelineService: stations -> beautify -> bake -> fuse -> 3D Tiles', () => {
    let result: Awaited<ReturnType<SurveySplatPipelineService['run']>>;

    beforeAll(async () => {
        await fs.emptyDir(OUT);
        const engine = new SurveySynthesisEngine();
        const stations = engine.synthesize(ANCHOR, { type: 'orbital-multi-tier', targetRadiusMeters: 45, cameraCount: 6, focalLengthMm: 28, lookAtOffsetLocalENU: [0, 10, 0], altitudeTiersMeters: [ANCHOR.elevationMeters + 8, ANCHOR.elevationMeters + 20] });
        const svc = new SurveySplatPipelineService({ generator: recolour });
        const progress: string[] = [];
        result = await svc.run({
            glbPath: GLB, anchor: ANCHOR, stations, outDir: OUT,
            beautify: { locationName: 'Test Box', moodPromptContext: 'Clear noon. ' },
            renderWidth: 480, mode: 'chained', bakeStride: 2, isoDate: '2026-06-21T02:00:00Z',
            clean: true, forceRebake: true
        }, (p, msg) => progress.push(`${(p * 100).toFixed(0)}% ${msg}`));
        expect(progress.length).toBeGreaterThan(5);
    }, 300000);

    it('beautifies every ranked station with the mock model and bakes each accepted one', () => {
        expect(result.success).toBe(true);
        expect(result.stations.length).toBe(6);
        expect(result.stations.every(s => s.accepted)).toBe(true);
        expect(result.stations.every(s => s.splatCount > 1000)).toBe(true);
        // chained: stations after the first receive a warped reference
        expect(result.stations.slice(1).every(s => s.usedReference)).toBe(true);
        expect(result.stations[0].usedReference).toBe(false);
    });

    it('fused splats lie on the mesh surface (<= 5 cm) and carry the beautified colours, not clay grey', async () => {
        const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(GLB);
        const splats = SplatService.parseSplatBuffer(await fs.readFile(result.fusedSplatPath));
        expect(splats.length).toBeGreaterThan(5000);
        expect(splats.length).toBeLessThan(result.stations.reduce((a, s) => a + s.splatCount, 0)); // fusion removed duplicates
        let offSurface = 0, grey = 0;
        const sample = splats.filter((_, i) => i % 97 === 0);
        for (const s of sample) {
            if (distanceToMesh(s.position, mesh) > 0.05) offSurface++;
            const [r, g, b] = s.colorRgb;
            if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) grey++;
        }
        expect(offSurface / sample.length).toBeLessThan(0.02);
        expect(grey / sample.length).toBeLessThan(0.05);
    });

    it('emits a KHR_gaussian_splatting 3D Tiles tileset placed at the anchor, with a crop volume and provenance meta', async () => {
        const tileset = await fs.readJson(result.tilesetPath);
        expect(tileset.root.transform).toHaveLength(16);
        expect(tileset.extensions['3DTILES_content_gltf'].extensionsUsed).toContain('KHR_gaussian_splatting_compression_spz_2');
        const meta = await fs.readJson(result.metaPath);
        expect(meta.anchor.lat).toBe(ANCHOR.lat);
        expect(meta.stations).toHaveLength(6);
        expect(meta.stations[0].prompt).toContain('Camera lock');
        expect(meta.stations[0].qc.passed).toBe(true);
        expect(meta.cropBox.min).toHaveLength(3);
        expect(meta.cropBox.max[1]).toBeGreaterThan(meta.cropBox.min[1]);
        // crop box is inside the mesh extent (box + 200 m ground)
        expect(meta.cropBox.min[0]).toBeGreaterThanOrEqual(-101);
        expect(meta.cropBox.max[0]).toBeLessThanOrEqual(101);
        expect(meta.generator).toBe('mock-recolour');
        expect(meta.mode).toBe('chained');
    });
});

describe('SurveySplatPipelineService fanout: independent stations run at once', () => {
    it('beautifies fanout stations concurrently (bounded), reports them in station order, and bakes each', async () => {
        const out = path.resolve(process.cwd(), 'build/test_survey_splats_fanout');
        await fs.emptyDir(out);
        const engine = new SurveySynthesisEngine();
        const stations = engine.synthesize(ANCHOR, { type: 'orbital-multi-tier', targetRadiusMeters: 45, cameraCount: 4, focalLengthMm: 28, lookAtOffsetLocalENU: [0, 10, 0], altitudeTiersMeters: [ANCHOR.elevationMeters + 8] });
        let inFlight = 0, maxInFlight = 0;
        const delayed: StationImageGenerator = {
            name: 'mock-recolour-delayed',
            async generate(args) {
                inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
                try {
                    await new Promise(r => setTimeout(r, 300));
                    return await recolour.generate(args);
                } finally { inFlight--; }
            }
        };
        const svc = new SurveySplatPipelineService({ generator: delayed });
        const res = await svc.run({
            glbPath: GLB, anchor: ANCHOR, stations, outDir: out,
            beautify: { locationName: 'Test Box', moodPromptContext: 'Clear noon. ' },
            renderWidth: 320, mode: 'fanout', fanoutConcurrency: 2, bakeStride: 2, isoDate: '2026-06-21T02:00:00Z',
            maxRerolls: 0, clean: true, forceRebake: true
        });
        expect(res.error).toBeUndefined();
        expect(maxInFlight).toBe(2);
        expect(res.stations.map(s => s.stationId)).toEqual(stations.map(s => s.id));
        expect(res.stations.every(s => !s.usedReference)).toBe(true);
    }, 300000);
});
