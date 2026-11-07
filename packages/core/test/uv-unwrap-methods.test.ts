/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The 'slim' unwrap method (grown charts; LSCM -> ABF++ -> SLIM; mask packing) against the 'legacy' one, checked on the
 * written UVs with the independent reader of helpers/uv-rewrap-fixtures.ts:
 * - curved UV-less meshes (a bumpy torus, a cylinder, an icosphere, a saddle sheet) unwrap with no flipped triangle, no
 *   overlapping texel, angle stretch and area ratio under bounds tighter than the chart thresholds, and no more angle
 *   distortion than the legacy method;
 * - a SLIM chart reports at least one SLIM iteration and the per-chart flips stay zero;
 * - the legacy method is still selectable and reports no ABF++ / SLIM charts.
 * Real data (gitignored; skipped with a reason without it): SCRATCHBOX_UV_BENCH_K (a Pipeline K building GLB),
 * SCRATCHBOX_UV_BENCH_TILE (a Google 3D Tiles extraction GLB), SCRATCHBOX_UV_BENCH_OBJECT (a generated object GLB):
 * both methods on each, measured (angle and area distortion, flips, texel-density spread, utilisation, time) and
 * rendered with a UV checker to test-results/screenshots/uv_rewrap/methods_*.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
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

async function unwrap(glb: Buffer, method: 'slim' | 'legacy', extra: Record<string, unknown> = {}) {
    const r = await unwrapRewrapGlb('unwrap', glb, { atlasSize: 1024, unwrapMethod: method, ...extra });
    return r;
}

describe('slim unwrap method on curved meshes', () => {
    const cases: Array<[string, FixturePrimitive, { stretch: number; area: number }]> = [
        ['torus', bumpyTorus(), { stretch: 1.08, area: 1.12 }],
        ['cylinder', cylinderMesh(0.5, 2, 48, 12), { stretch: 1.05, area: 1.1 }],
        ['icosphere', icosphereMesh(1, 4), { stretch: 1.1, area: 1.15 }],
        ['saddle', saddle(), { stretch: 1.08, area: 1.2 }]
    ];
    for (const [name, mesh, bound] of cases) {
        it(`${name}: no flips, no overlap, distortion bounded and no worse than legacy`, async () => {
            const input = buildFixtureGlb({ primitives: [mesh] });
            const slim = await unwrap(input, 'slim');
            const legacy = await unwrap(input, 'legacy');
            const a = slim.report.atlases[0];
            expect(a.status).toBe('unwrapped');
            expect(a.unwrapMethod).toBe('slim');
            expect(slim.report.overlappingTrianglePairs).toBe(0);
            const ov = uvOverlapTexels(slim.glb, 0, 2048);
            expect(ov.covered).toBeGreaterThan(0);
            expect(ov.overlapping).toBe(0);
            const d = measureDistortion(slim.glb, 0);
            const dl = measureDistortion(legacy.glb, 0);
            expect(d.flipped).toBe(0);
            expect(d.stretchRms).toBeLessThanOrEqual(bound.stretch);
            expect(d.areaRms).toBeLessThanOrEqual(bound.area);
            expect(d.stretchRms).toBeLessThanOrEqual(dl.stretchRms + 1e-3);
            for (const c of a.chartDetails) expect(c.flippedTriangles).toBe(0);
            for (const c of a.chartDetails.filter(c => c.method === 'slim')) expect(c.slimIterations).toBeGreaterThan(0);
            recordMetrics(`methods_${name}`, { slim: { ...d, charts: a.charts, slimCharts: a.slimCharts, abfCharts: a.abfCharts, utilisation: a.utilisation }, legacy: { ...dl, charts: legacy.report.charts, utilisation: legacy.report.utilisation } });
            const cam = orbitCamera(input, 35, 30, 320);
            saveSideBySide(`methods_${name}_checker_legacy_vs_slim`, [renderGlb(legacy.glb, cam, 'checker'), renderGlb(slim.glb, cam, 'checker'), uvLayoutImage(legacy.glb, 0, 320), uvLayoutImage(slim.glb, 0, 320)]);
        }, 120_000);
    }

    it('a chart only the solvers can flatten is flattened, not split into pieces', async () => {
        const input = buildFixtureGlb({ primitives: [saddle()] });
        const slim = await unwrap(input, 'slim');
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
        const slim = await unwrap(input, 'slim');
        const a = slim.report.atlases[0];
        expect(a.charts).toBe(2000);
        expect(slim.report.overlappingTrianglePairs).toBe(0);
        expect(uvOverlapTexels(slim.glb, 0, 2048).overlapping).toBe(0);
        expect(measureDistortion(slim.glb, 0).flipped).toBe(0);
        const legacy = await unwrap(input, 'legacy');
        recordMetrics('methods_crumbs', { slim: { utilisation: a.utilisation, texelsPerMeter: a.texelsPerMeter }, legacy: { utilisation: legacy.report.utilisation, texelsPerMeter: legacy.report.atlases[0].texelsPerMeter } });
    }, 120_000);

    it('the legacy method is still selectable', async () => {
        const input = buildFixtureGlb({ primitives: [bumpyTorus(48, 20)] });
        const legacy = await unwrap(input, 'legacy');
        expect(legacy.report.unwrapMethod).toBe('legacy');
        expect(legacy.report.slimCharts).toBe(0);
        expect(legacy.report.abfCharts).toBe(0);
        expect(legacy.report.overlappingTrianglePairs).toBe(0);
        expect(uvOverlapTexels(legacy.glb, 0, 2048).overlapping).toBe(0);
    }, 120_000);
});

// =============================================================================
// Real data: old against new
// =============================================================================

function realFile(env: string, what: string): { path?: string; req: Requirement } {
    const p = process.env[env];
    if (p && fs.existsSync(p)) return { path: p, req: { ok: true, reason: '' } };
    return { req: { ok: false, reason: `set ${env} to ${what} (gitignored real data)` } };
}

interface MethodMetrics {
    method: string; triangles: number; charts: number; slimCharts: number; abfCharts: number; lscmCharts: number; splits: number;
    angleStretchMean: number; angleStretchRms: number; areaRatioRms: number; flipped: number; subTexelSlivers: number;
    texelDensityCv: number; texelDensityP5OverP95: number; utilisation: number; texelsPerMeter: number; atlas: string; ms: number; overlappingPairs: number;
}

/** The TEXCOORD set the unwrap wrote (an input that already has UVs keeps them as set 0 and gets a new set). */
function writtenSet(report: UvRewrapReport): number {
    const w = report.atlases.find(a => a.texCoordWritten)?.texCoordWritten ?? 'TEXCOORD_0';
    return Number(w.split('_')[1] ?? 0);
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

function metricsOf(method: string, report: UvRewrapReport, glb: Buffer): MethodMetrics {
    const atl = report.atlases.filter(a => a.status !== 'skipped');
    const d = measureTexels(glb, writtenSet(report), atl[0].width, atl[0].height);
    return {
        method, triangles: atl.reduce((s, a) => s + a.triangles, 0), charts: report.charts, slimCharts: report.slimCharts, abfCharts: report.abfCharts,
        lscmCharts: report.lscmCharts, splits: atl.reduce((s, a) => s + a.splits, 0),
        angleStretchMean: d.stretchMean, angleStretchRms: d.stretchRms, areaRatioRms: d.areaRms, flipped: d.flipped, subTexelSlivers: d.slivers,
        texelDensityCv: report.texelDensity.cv, texelDensityP5OverP95: report.texelDensity.uniformity, utilisation: report.utilisation,
        texelsPerMeter: atl.length ? atl[0].texelsPerMeter : 0, atlas: atl.map(a => `${a.width}x${a.height}`).slice(0, 3).join(','),
        ms: report.totalMs, overlappingPairs: report.overlappingTrianglePairs
    };
}

const REAL: Array<{ key: string; env: string; what: string }> = [
    { key: 'k_building', env: 'SCRATCHBOX_UV_BENCH_K', what: 'a Pipeline K building GLB' },
    { key: 'tile', env: 'SCRATCHBOX_UV_BENCH_TILE', what: 'a Google 3D Tiles extraction GLB' },
    { key: 'object', env: 'SCRATCHBOX_UV_BENCH_OBJECT', what: 'a generated object GLB' }
];

for (const r of REAL) {
    const f = realFile(r.env, r.what);
    describe.skipIf(!f.req.ok)(withReason(`unwrap methods on ${r.what}`, f.req), () => {
        it(`${r.key}: legacy and slim measured and rendered`, async () => {
            const input = fs.readFileSync(f.path!);
            // the same atlas size for both: the denser method packs better
            const atlasSize = Number(process.env[`SCRATCHBOX_UV_BENCH_ATLAS_${r.key.toUpperCase()}`] ?? process.env.SCRATCHBOX_UV_BENCH_ATLAS ?? 4096);
            const out: Record<string, MethodMetrics> = {};
            const glbs: Record<string, Buffer> = {};
            const sets: Record<string, number> = {};
            const nativeFlips: Record<string, number> = {};
            for (const method of ['legacy', 'slim'] as const) {
                const res = await unwrapRewrapGlb('unwrap', input, { atlasSize, unwrapMethod: method, native: { timeoutMs: 3_600_000 } });
                out[method] = metricsOf(method, res.report, res.glb);
                glbs[method] = res.glb;
                sets[method] = writtenSet(res.report);
                // the engine's own count, in double precision before the UVs are written as float32
                nativeFlips[method] = res.report.atlases.reduce((s, a) => s + a.chartDetails.reduce((t, c) => t + c.flippedTriangles, 0), 0);
            }
            recordMetrics(`methods_real_${r.key}`, out);
            const views: Array<[number, number]> = [[30, 25], [210, 35]];
            views.forEach(([az, el], k) => {
                const cam = orbitCamera(input, az, el, 640, 1.6);
                saveSideBySide(`methods_real_${r.key}_view${k}`, [renderGlb(glbs.legacy, cam, 'checker', { checkerSet: sets.legacy }), renderGlb(glbs.slim, cam, 'checker', { checkerSet: sets.slim })]);
            });
            saveSideBySide(`methods_real_${r.key}_layout`, [uvLayoutImage(glbs.legacy, sets.legacy, 640), uvLayoutImage(glbs.slim, sets.slim, 640)]);
            expect(out.slim.overlappingPairs).toBe(0);
            expect(nativeFlips.slim).toBe(0);
            // float32 UVs: a few near-sliver triangles of a very fine mesh can round to the other orientation (legacy too)
            expect(out.slim.flipped).toBeLessThanOrEqual(out.legacy.flipped);
        }, 3_600_000);
    });
}
