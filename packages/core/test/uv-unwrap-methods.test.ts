/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The UV unwrap (grown charts; LSCM -> ABF++ -> SLIM; mask packing), checked on the written UVs with an independent
 * reader:
 * - solver unit tests on curved UV-less meshes (a bumpy torus, a cylinder, an icosphere, a saddle sheet): no flipped
 *   triangle, no overlapping texel, angle stretch and area ratio under bounds tighter than the chart thresholds; a mesh
 *   of crumbs packs through the bins with no overlap;
 * - real cached buildings (SCRATCHBOX_UV_BENCH_DIR: a benchmark folder of <building>/cache/tile_refine/<key>/raw_clay.glb,
 *   e.g. benchmarks/2026-11-06-main/main; gitignored, skipped with a reason without it): each raw scan unwrapped,
 *   measured (angle and area distortion, flips, texel-density spread, utilisation, time) and rendered with a UV checker
 *   to test-results/screenshots/uv_rewrap/real_*.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { unwrapRewrapGlb, type UvRewrapReport } from '../src/node/spatial/UvAtlasRewrap';
import { parseGlbBytes, readAccessor, nodeWorldMatrices, transformPoint } from '../src/node/3d-engine/staged-location/glb-bytes';
import {
    buildFixtureGlb, cylinderMesh, icosphereMesh, renderGlb, orbitCamera, saveSideBySide, uvLayoutImage, uvOverlapTexels,
    measureDistortion, recordMetrics, type FixturePrimitive
} from './helpers/uv-rewrap-fixtures';
import { withReason, type Requirement } from './helpers/requirements';

function bumpyTorus(nu = 96, nv = 40, R = 2, r = 0.7): FixturePrimitive {
    const positions: number[] = [], indices: number[] = [];
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
        const a = 2 * Math.PI * i / nu, b = 2 * Math.PI * j / nv, rr = r * (1 + 0.2 * Math.sin(3 * a + 2 * b));
        positions.push((R + rr * Math.cos(b)) * Math.cos(a), (R + rr * Math.cos(b)) * Math.sin(a), rr * Math.sin(b));
    }
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
        const a = i * nv + j, b = ((i + 1) % nu) * nv + j, c = ((i + 1) % nu) * nv + (j + 1) % nv, d = i * nv + (j + 1) % nv;
        indices.push(a, b, c, a, c, d);
    }
    return { positions, indices };
}

/** An open saddle sheet z = k (x^2 - y^2): one disk-topology chart that no plane projects isometrically. */
function saddle(n = 40, k = 0.6): FixturePrimitive {
    const positions: number[] = [], indices: number[] = [];
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
        const x = -1 + 2 * i / n, y = -1 + 2 * j / n;
        positions.push(x, k * (x * x - y * y), y);
    }
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const a = i * (n + 1) + j, b = (i + 1) * (n + 1) + j, c = (i + 1) * (n + 1) + j + 1, d = i * (n + 1) + j + 1;
        indices.push(a, c, b, a, d, c);
    }
    return { positions, indices };
}

async function unwrap(glb: Buffer) {
    return unwrapRewrapGlb('unwrap', glb, { atlasSize: 1024 });
}

describe('UV unwrap on curved meshes (solver unit tests)', () => {
    const cases: Array<[string, FixturePrimitive, { stretch: number; area: number }]> = [
        ['torus', bumpyTorus(), { stretch: 1.08, area: 1.12 }],
        ['cylinder', cylinderMesh(0.5, 2, 48, 12), { stretch: 1.05, area: 1.1 }],
        ['icosphere', icosphereMesh(1, 4), { stretch: 1.1, area: 1.15 }],
        ['saddle', saddle(), { stretch: 1.08, area: 1.2 }]
    ];
    for (const [name, mesh, bound] of cases) {
        it(`${name}: no flips, no overlap, distortion bounded`, async () => {
            const input = buildFixtureGlb({ primitives: [mesh] });
            const res = await unwrap(input);
            const a = res.report.atlases[0];
            expect(a.status).toBe('unwrapped');
            expect(res.report.overlappingTrianglePairs).toBe(0);
            const ov = uvOverlapTexels(res.glb, 0, 2048);
            expect(ov.covered).toBeGreaterThan(0);
            expect(ov.overlapping).toBe(0);
            const d = measureDistortion(res.glb, 0);
            expect(d.flipped).toBe(0);
            expect(d.stretchRms).toBeLessThanOrEqual(bound.stretch);
            expect(d.areaRms).toBeLessThanOrEqual(bound.area);
            for (const c of a.chartDetails) expect(c.flippedTriangles).toBe(0);
            for (const c of a.chartDetails.filter(c => c.method === 'slim')) expect(c.slimIterations).toBeGreaterThan(0);
            recordMetrics(`unwrap_${name}`, { ...d, charts: a.charts, slimCharts: a.slimCharts, abfCharts: a.abfCharts, utilisation: a.utilisation });
        }, 120_000);
    }

    it('a chart only the solvers can flatten is flattened, not split into pieces', async () => {
        const input = buildFixtureGlb({ primitives: [saddle()] });
        const slim = await unwrap(input);
        const a = slim.report.atlases[0];
        // the saddle is one disk: the grower keeps it whole and SLIM / ABF++ flatten it without a split
        expect(a.charts).toBeLessThanOrEqual(2);
        expect(a.slimCharts + a.abfCharts).toBeGreaterThanOrEqual(1);
        expect(a.splits).toBe(0);
    }, 120_000);

    it('a mesh of crumbs (2000 loose triangles: tiny charts packed in bins) packs with no overlap and no flips', async () => {
        const positions: number[] = [], indices: number[] = [];
        for (let i = 0; i < 2000; i++) {
            const x = (i % 50) * 0.3, z = Math.floor(i / 50) * 0.3, s = 0.05 + 0.1 * ((i * 37) % 11) / 11, y = 0.2 * Math.sin(i);
            const b = positions.length / 3;
            positions.push(x, y, z, x + s, y + 0.3 * s * ((i % 3) - 1), z, x + 0.3 * s, y, z + s);
            indices.push(b, b + 1, b + 2);
        }
        const input = buildFixtureGlb({ primitives: [{ positions, indices }] });
        const slim = await unwrap(input);
        const a = slim.report.atlases[0];
        expect(a.charts).toBe(2000);
        expect(slim.report.overlappingTrianglePairs).toBe(0);
        expect(uvOverlapTexels(slim.glb, 0, 2048).overlapping).toBe(0);
        expect(measureDistortion(slim.glb, 0).flipped).toBe(0);
    }, 120_000);
});

// =============================================================================
// Real cached buildings
// =============================================================================

interface Metrics {
    triangles: number; charts: number; slimCharts: number; abfCharts: number; splits: number;
    angleStretchMean: number; angleStretchRms: number; areaRatioRms: number; flipped: number; subTexelSlivers: number; nativeFlips: number;
    texelDensityCv: number; texelDensityP5OverP95: number; utilisation: number; texelsPerMeter: number; atlas: string; ms: number; overlappingPairs: number;
}

/**
 * Independent distortion of the written UVs in texel units, world positions (node transforms applied). A triangle whose
 * UV area is under 1e-3 texel^2 covers no texel and its float32 UVs cannot hold an orientation: it is counted as a
 * sub-texel sliver, not as a flip, and left out of the means.
 */
function measureTexels(glb: Buffer, set: number, W: number, H: number) {
    const g = parseGlbBytes(glb);
    const worlds = nodeWorldMatrices(g.json);
    const per: Array<{ a: number; st: number; det: number }> = [];
    let slivers = 0;
    (g.json.nodes ?? []).forEach((n: any, ni: number) => {
        if (n.mesh === undefined) return;
        for (const p of g.json.meshes[n.mesh].primitives) {
            const uvA = p.attributes[`TEXCOORD_${set}`];
            if (uvA === undefined || p.indices === undefined) continue;
            const pos = readAccessor(g, p.attributes.POSITION).data, uv = readAccessor(g, uvA).data, idx = readAccessor(g, p.indices).data;
            const P = (v: number) => transformPoint(worlds[ni], pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
            for (let t = 0; t < idx.length; t += 3) {
                const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
                const pa = P(a), pb = P(b), pc = P(c);
                const e1 = [0, 1, 2].map(k => pb[k] - pa[k]), e2 = [0, 1, 2].map(k => pc[k] - pa[k]);
                const nn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
                const area = Math.hypot(nn[0], nn[1], nn[2]) / 2;
                if (area < 1e-14) continue;
                const du1 = (uv[b * 2] - uv[a * 2]) * W, dv1 = (uv[b * 2 + 1] - uv[a * 2 + 1]) * H, du2 = (uv[c * 2] - uv[a * 2]) * W, dv2 = (uv[c * 2 + 1] - uv[a * 2 + 1]) * H;
                const uvArea = (du1 * dv2 - dv1 * du2) / 2;
                if (Math.abs(uvArea) < 1e-3) { slivers++; continue; }
                const l1 = Math.hypot(e1[0], e1[1], e1[2]);
                const x2 = (e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2]) / l1, y2 = (2 * area) / l1;
                const j00 = du1 / l1, j01 = (du2 - du1 * x2 / l1) / y2, j10 = dv1 / l1, j11 = (dv2 - dv1 * x2 / l1) / y2;
                const fro2 = j00 * j00 + j01 * j01 + j10 * j10 + j11 * j11, det = j00 * j11 - j01 * j10;
                const disc = Math.sqrt(Math.max(0, fro2 * fro2 / 4 - det * det));
                const s1 = Math.sqrt(fro2 / 2 + disc), s2 = Math.sqrt(Math.max(0, fro2 / 2 - disc));
                per.push({ a: area, st: s2 > 0 ? s1 / s2 : 1e6, det });
            }
        }
    });
    let A = 0, uvA2 = 0;
    for (const x of per) { A += x.a; uvA2 += Math.abs(x.det) * x.a; }
    const scale = uvA2 / A, sign = per.reduce((s, x) => s + x.det * x.a, 0) >= 0 ? 1 : -1;
    let sm = 0, s2 = 0, r2 = 0, flipped = 0;
    for (const x of per) {
        const r = Math.abs(x.det) / scale, ar = r > 1e-6 ? Math.max(r, 1 / r) : 1e6;
        sm += x.a * x.st; s2 += x.a * x.st * x.st; r2 += x.a * ar * ar;
        if (x.det * sign <= 0) flipped++;
    }
    return { stretchMean: sm / A, stretchRms: Math.sqrt(s2 / A), areaRms: Math.sqrt(r2 / A), flipped, slivers };
}

/** The TEXCOORD set the unwrap wrote (an input that already has UVs keeps them as set 0 and gets a new set). */
function writtenSet(report: UvRewrapReport): number {
    const w = report.atlases.find(a => a.texCoordWritten)?.texCoordWritten ?? 'TEXCOORD_0';
    return Number(w.split('_')[1] ?? 0);
}

const benchDir = process.env.SCRATCHBOX_UV_BENCH_DIR;
const benchReq: Requirement = benchDir && fs.existsSync(benchDir)
    ? { ok: true, reason: '' }
    : { ok: false, reason: 'set SCRATCHBOX_UV_BENCH_DIR to a benchmark folder of cached buildings (<building>/cache/tile_refine/<key>/raw_clay.glb)' };
const benchBuildings = benchReq.ok
    ? fs.readdirSync(benchDir!).filter(b => fs.existsSync(path.join(benchDir!, b, 'cache', 'tile_refine'))).slice(0, Number(process.env.SCRATCHBOX_UV_BENCH_LIMIT ?? 6))
    : [];
const rawScanOf = (b: string) => {
    const root = path.join(benchDir!, b, 'cache', 'tile_refine');
    const key = fs.readdirSync(root).sort().find(k => fs.existsSync(path.join(root, k, 'raw_clay.glb')));
    return key ? path.join(root, key, 'raw_clay.glb') : undefined;
};

describe.skipIf(!benchReq.ok)(withReason('UV unwrap of real cached buildings', benchReq), () => {
    for (const b of benchBuildings) {
        it(`${b}: raw scan unwrapped with no flip or overlap, measured and rendered`, async ctx => {
            const file = rawScanOf(b);
            if (!file) return ctx.skip();
            const input = fs.readFileSync(file);
            const res = await unwrapRewrapGlb('unwrap', input, { atlasSize: 4096, native: { timeoutMs: 3_600_000 } });
            const report = res.report;
            const atl = report.atlases.filter(a => a.status !== 'skipped');
            const set = writtenSet(report);
            const d = measureTexels(res.glb, set, atl[0].width, atl[0].height);
            const m: Metrics = {
                triangles: atl.reduce((s, a) => s + a.triangles, 0), charts: report.charts, slimCharts: report.slimCharts, abfCharts: report.abfCharts,
                splits: atl.reduce((s, a) => s + a.splits, 0), angleStretchMean: d.stretchMean, angleStretchRms: d.stretchRms, areaRatioRms: d.areaRms,
                flipped: d.flipped, subTexelSlivers: d.slivers,
                // the engine's own count, in double precision before the UVs are written as float32
                nativeFlips: atl.reduce((s, a) => s + a.chartDetails.reduce((t, c) => t + c.flippedTriangles, 0), 0),
                texelDensityCv: report.texelDensity.cv, texelDensityP5OverP95: report.texelDensity.uniformity, utilisation: report.utilisation,
                texelsPerMeter: atl[0].texelsPerMeter, atlas: `${atl[0].width}x${atl[0].height}`, ms: report.totalMs, overlappingPairs: report.overlappingTrianglePairs
            };
            recordMetrics(`real_${b}`, m);
            const cam = orbitCamera(input, 30, 25, 640, 1.6);
            saveSideBySide(`real_${b}`, [renderGlb(res.glb, cam, 'checker', { checkerSet: set }), uvLayoutImage(res.glb, set, 640)]);
            expect(m.overlappingPairs).toBe(0);
            expect(m.nativeFlips).toBe(0);
            // float32 UVs: a near-sliver triangle of a very fine mesh can round to the other orientation
            expect(m.flipped).toBeLessThanOrEqual(Math.ceil(m.triangles * 1e-3));
            expect(m.angleStretchMean).toBeLessThan(1.1);
        }, 3_600_000);
    }
});
