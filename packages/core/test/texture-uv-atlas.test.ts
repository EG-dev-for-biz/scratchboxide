/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Texture pass task B: the UV atlas (fitted charts + native scan islands) and the textured twin writer.
 * No network, no model call. The atlas is audited by code written here, independently of the implementation: UVs in
 * [0, 1], every triangle inside its packed rect's content area (so gutters hold), rects disjoint, no texel claimed in its
 * interior by two triangles, texel positions equal to the analytic surface (charts) or the barycentric point (islands),
 * and clay positions copied bit-for-bit into the twin. The twin is read back with a separate GLB reader and a separate
 * PNG decoder, then rendered by three.js in headless Chrome (which decodes the PNGs itself) for the screenshots in
 * test-results/screenshots/texture_uv/.
 */

import { describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { writeStagedGlb, writeTexturedTwin, writeTexturedTwinGlb } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { buildUvAtlas, type LaidOutUvAtlas } from '../src/node/3d-engine/staged-location/texture-uv';
import { packConfidenceTexel, type BakedTexturePlanes, type TexelProvenance } from '../src/common/spatial/texture-pass-contracts';
import type { FittedSurface, Vec3 } from '../src/common/spatial/staged-location-contracts';
import { FACADE, facadeAlbedo, emptyConfidencePlane } from './helpers/texture-pass-fixtures';
import { parseGlb, readAccessor } from './helpers/clay-glb-render';
import { decodePng } from './helpers/png-decode';
import { renderTwinInChrome, twinChrome } from './helpers/texture-twin-chrome';
import { findArchFit, findSizedArchData } from './helpers/real-arch-data';
import { REPO_ROOT } from './helpers/requirements';

const SHOTS = path.join(REPO_ROOT, 'test-results', 'screenshots', 'texture_uv');

// =============================================================================
// Fixtures: the analytic facade of texture-pass-fixtures, a half column, and a noisy scan lump
// =============================================================================

type Surf = Pick<FittedSurface, 'id' | 'chart'>;

function grid(nu: number, nv: number, at: (i: number, j: number) => Vec3, flip = false): { positions: Float32Array; indices: Uint32Array } {
    const positions = new Float32Array((nu + 1) * (nv + 1) * 3);
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) positions.set(at(i, j), (j * (nu + 1) + i) * 3);
    const idx: number[] = [];
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
        const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
        if (flip) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
    }
    return { positions, indices: Uint32Array.from(idx) };
}

const COLUMN = { axisOrigin: [13, 0, -1] as Vec3, radiusM: 0.6, heightM: 6 };

function fixtureScene(): { glb: Buffer; surfaces: Surf[] } {
    // facade: faces -z (toward the street), so its triangles wind against the chart's u x v (= +z): exercises the u flip
    const facade = grid(5, 3, (i, j) => [FACADE.origin[0] + (FACADE.widthM * i) / 5, FACADE.origin[1] + (FACADE.heightM * j) / 3, FACADE.origin[2]], true);
    // half column: theta 0..180 deg around +y from +x, y0 = axis x x0 = -z, so theta 90 faces the street
    const col = grid(12, 3, (i, j) => {
        const th = (Math.PI * i) / 12;
        return [COLUMN.axisOrigin[0] + COLUMN.radiusM * Math.cos(th), (COLUMN.heightM * j) / 3, COLUMN.axisOrigin[2] - COLUMN.radiusM * Math.sin(th)];
    });
    // scan lump: a noisy subdivided box, no chart (island path); vertices shared across faces at the cube edges
    const lump = noisyBox([20, 1, -1], 1.2, 6);
    const surfaces: Surf[] = [
        { id: 's00', chart: { plane: { origin: FACADE.origin, u: FACADE.u, v: FACADE.v, normal: FACADE.normal, extentUv: [[0, 0], [FACADE.widthM, 0], [FACADE.widthM, FACADE.heightM], [0, FACADE.heightM]] } } },
        { id: 's01', chart: { cylinder: { axisOrigin: COLUMN.axisOrigin, axisDir: [0, 1, 0], thetaZeroDir: [1, 0, 0], radiusM: COLUMN.radiusM, thetaDeg: [0, 180], zM: [0, COLUMN.heightM], normalSign: 1 } } }
    ];
    const sb = (surfaceId: string) => ({ sb: { schema: 'scratchbox.staged-node/2', stage: 'fit', ids: { surfaceId } } });
    const glb = writeStagedGlb([
        { name: 'facade-node', ...facade, extras: sb('s00') },
        { name: 's01', ...col, attributes: { _PROV: Float32Array.from({ length: col.positions.length / 3 }, (_, i) => i % 7) }, extras: sb('s01') },
        { name: 'x00', ...lump, extras: { regionId: 'x00' } }
    ], { rootExtras: { sb: { stage: 'fit' } } });
    return { glb, surfaces };
}

function noisyBox(c: Vec3, half: number, n: number): { positions: Float32Array; indices: Uint32Array } {
    const key = (p: Vec3) => p.map(x => x.toFixed(6)).join(',');
    const verts = new Map<string, number>();
    const pos: number[] = [], idx: number[] = [];
    const vid = (p: Vec3) => {
        const k = key(p);
        if (!verts.has(k)) {
            verts.set(k, pos.length / 3);
            const h = Math.sin(p[0] * 7.1 + p[1] * 3.3) * Math.cos(p[2] * 5.7 - p[1] * 2.1) * 0.04;   // deterministic relief
            const l = Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);
            pos.push(p[0] + ((p[0] - c[0]) / l) * h, p[1] + ((p[1] - c[1]) / l) * h, p[2] + ((p[2] - c[2]) / l) * h);
        }
        return verts.get(k)!;
    };
    const faces: Array<[Vec3, Vec3, Vec3]> = [ // origin corner, u, v with u x v outward
        [[-1, -1, 1], [2, 0, 0], [0, 2, 0]], [[1, -1, -1], [-2, 0, 0], [0, 2, 0]], [[1, -1, 1], [0, 0, -2], [0, 2, 0]],
        [[-1, -1, -1], [0, 0, 2], [0, 2, 0]], [[-1, 1, 1], [2, 0, 0], [0, 0, -2]], [[-1, -1, -1], [2, 0, 0], [0, 0, 2]]
    ];
    for (const [o, u, v] of faces) {
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
            const P = (a: number, b: number): Vec3 => [c[0] + half * (o[0] + (u[0] * a + v[0] * b) / n), c[1] + half * (o[1] + (u[1] * a + v[1] * b) / n), c[2] + half * (o[2] + (u[2] * a + v[2] * b) / n)];
            const A = vid(P(i, j)), B = vid(P(i + 1, j)), C = vid(P(i, j + 1)), D = vid(P(i + 1, j + 1));
            idx.push(A, B, C, B, D, C);
        }
    }
    return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

// =============================================================================
// Independent audit
// =============================================================================

interface Audit {
    uvOutOfRange: number; nonFinite: number; trianglesOutsideRect: number; rectOverlaps: number; rectsOutside: number;
    overlapTexels: number; contentTexels: number; gutterHoles: number; positionErrorM: number; claimed: Int32Array;
}

function audit(atlas: LaidOutUvAtlas, clay: Buffer): Audit {
    const { width: W, height: H } = atlas;
    const G = atlas.layout.gutterTexels;
    const R = atlas.layout.rects;
    const a: Audit = { uvOutOfRange: 0, nonFinite: 0, trianglesOutsideRect: 0, rectOverlaps: 0, rectsOutside: 0, overlapTexels: 0, contentTexels: 0, gutterHoles: 0, positionErrorM: 0, claimed: new Int32Array(W * H).fill(-1) };
    for (const r of R) if (r.x < 0 || r.y < 0 || r.x + r.width > W || r.y + r.height > H) a.rectsOutside++;
    for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) {
        const p = R[i], q = R[j];
        if (p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height) a.rectOverlaps++;
    }
    const { json, bin } = parseGlb(clay);
    let tri = 0;
    for (const L of atlas.layout.primitives) {
        const prim = json.meshes[L.meshIndex].primitives[L.primitiveIndex];
        const P = readAccessor(json, bin, prim.attributes.POSITION).data;
        for (const x of L.uv) { if (!Number.isFinite(x)) a.nonFinite++; else if (x < 0 || x > 1) a.uvOutOfRange++; }
        for (let t = 0; t < L.indices.length / 3; t++, tri++) {
            const r = R[L.rectOfTriangle[t]];
            const px = [0, 1, 2].map(k => [L.uv[L.indices[t * 3 + k] * 2] * W, L.uv[L.indices[t * 3 + k] * 2 + 1] * H]);
            if (px.some(([x, y]) => x < r.x + G - 1e-3 || x > r.x + r.width - G + 1e-3 || y < r.y + G - 1e-3 || y > r.y + r.height - G + 1e-3)) a.trianglesOutsideRect++;
            const [A, B, C] = px;
            const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
            if (Math.abs(den) < 1e-12) continue;
            const wp = [0, 1, 2].map(k => { const s = L.sourceVertex[L.indices[t * 3 + k]] * 3; return [P[s], P[s + 1], P[s + 2]]; });
            for (let y = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]))); y <= Math.min(H - 1, Math.ceil(Math.max(A[1], B[1], C[1]))); y++) {
                for (let x = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]))); x <= Math.min(W - 1, Math.ceil(Math.max(A[0], B[0], C[0]))); x++) {
                    const l0 = ((B[1] - C[1]) * (x + 0.5 - C[0]) + (C[0] - B[0]) * (y + 0.5 - C[1])) / den;
                    const l1 = ((C[1] - A[1]) * (x + 0.5 - C[0]) + (A[0] - C[0]) * (y + 0.5 - C[1])) / den;
                    const l2 = 1 - l0 - l1;
                    if (Math.min(l0, l1, l2) <= 1e-6) continue;
                    const i = y * W + x;
                    if (a.claimed[i] >= 0 && a.claimed[i] !== tri) a.overlapTexels++;
                    a.claimed[i] = tri;
                    if (!atlas.texels.covered[i] || atlas.texels.gutter[i]) { a.gutterHoles++; continue; }
                    if (atlas.maps[atlas.texels.mapIndex[i]]?.kind === 'atlas') {
                        // island texel: the barycentric point of this triangle (charts are checked against the analytic surface)
                        for (let c = 0; c < 3; c++) {
                            const e = Math.abs(atlas.texels.position[i * 3 + c] - (l0 * wp[0][c] + l1 * wp[1][c] + l2 * wp[2][c]));
                            a.positionErrorM = Math.max(a.positionErrorM, e);
                        }
                    }
                }
            }
        }
    }
    // gutter: every texel within G (Chebyshev) of a content texel is covered
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!atlas.texels.covered[i] || atlas.texels.gutter[i]) continue;
        a.contentTexels++;
        for (let dy = -G; dy <= G; dy++) for (let dx = -G; dx <= G; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < W && yy < H && !atlas.texels.covered[yy * W + xx]) a.gutterHoles++;
        }
    }
    return a;
}

/** The facade's UV as an affine function of (x, y), solved from its own vertices. */
function affineUv(L: LaidOutUvAtlas['layout']['primitives'][number], P: ArrayLike<number>): (x: number, y: number) => [number, number] {
    let lo = 0, hi = 0, bot = 0, top = 0;
    for (let k = 0; k < L.sourceVertex.length; k++) {
        const s = L.sourceVertex[k] * 3, sl = L.sourceVertex[lo] * 3, sh = L.sourceVertex[hi] * 3, sb = L.sourceVertex[bot] * 3, st = L.sourceVertex[top] * 3;
        if (P[s] < P[sl]) lo = k; if (P[s] > P[sh]) hi = k; if (P[s + 1] < P[sb + 1]) bot = k; if (P[s + 1] > P[st + 1]) top = k;
    }
    const x0 = P[L.sourceVertex[lo] * 3], x1 = P[L.sourceVertex[hi] * 3], y0 = P[L.sourceVertex[bot] * 3 + 1], y1 = P[L.sourceVertex[top] * 3 + 1];
    const ax = (L.uv[hi * 2] - L.uv[lo * 2]) / (x1 - x0), ay = (L.uv[top * 2 + 1] - L.uv[bot * 2 + 1]) / (y1 - y0);
    return (x, y) => [L.uv[lo * 2] + ax * (x - x0), L.uv[bot * 2 + 1] + ay * (y - y0)];
}

function expectValid(a: Audit): void {
    expect({ uvOutOfRange: a.uvOutOfRange, nonFinite: a.nonFinite, trianglesOutsideRect: a.trianglesOutsideRect, rectOverlaps: a.rectOverlaps, rectsOutside: a.rectsOutside, overlapTexels: a.overlapTexels, gutterHoles: a.gutterHoles })
        .toEqual({ uvOutOfRange: 0, nonFinite: 0, trianglesOutsideRect: 0, rectOverlaps: 0, rectsOutside: 0, overlapTexels: 0, gutterHoles: 0 });
}

/** UV checkerboard planes (8-texel checks, a hue per map) for the screenshots; confidence: entry 0, weight 1, rung 0. */
function checkerPlanes(atlas: LaidOutUvAtlas, check = 8): BakedTexturePlanes {
    const { width: W, height: H } = atlas;
    const albedo = new Uint8Array(W * H * 4), confidence = emptyConfidencePlane(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!atlas.texels.covered[i]) continue;
        const hue = ((atlas.texels.mapIndex[i] * 0.618034) % 1) * 6, on = ((Math.floor(x / check) + Math.floor(y / check)) & 1) === 1;
        const f = hue - Math.floor(hue), sector = Math.floor(hue) % 6;
        const rgb = [[1, f, 0], [1 - f, 1, 0], [0, 1, f], [0, 1 - f, 1], [f, 0, 1], [1, 0, 1 - f]][sector];
        const lo = on ? 0.55 : 0.18, span = on ? 0.4 : 0.3;
        for (let c = 0; c < 3; c++) albedo[i * 4 + c] = Math.round(255 * (lo + span * rgb[c]));
        albedo[i * 4 + 3] = 255;
        packConfidenceTexel(confidence, i, 0, 1, 0);
    }
    const provenance: TexelProvenance[] = [{ source: 'uv-checker', label: 'generated', method: 'UV checkerboard for the UV audit screenshot (test only)', coverage: 1 }];
    return { layerKey: atlas.layerKey, width: W, height: H, albedo, confidence, provenance, degradations: [] };
}

// =============================================================================
// Tests
// =============================================================================

describe('texture pass B: UV atlas', () => {
    const scene = fixtureScene();

    it('lays the analytic facade on its plane chart exactly: texels on the facade rectangle, UVs valid, gutters, coverage', async () => {
        const d = 6.4;
        const atlas = await buildUvAtlas({ layerKey: 'fit', clayGlb: scene.glb, densityTexelsPerMeter: d, maxSide: 2048, islandNormalToleranceDeg: 30, surfaces: scene.surfaces });
        const a = audit(atlas, scene.glb);
        expectValid(a);
        expect(atlas.layout.stats.overlapTexels).toBe(0);
        const fm = atlas.maps.findIndex(m => m.nodeName === 'facade-node');
        expect(atlas.maps[fm]).toMatchObject({ kind: 'chart-plane', chartId: 's00', texelsPerMeter: d });
        expect(atlas.maps.find(m => m.nodeName === 's01')).toMatchObject({ kind: 'chart-cylinder', chartId: 's01' });
        expect(atlas.maps.find(m => m.nodeName === 'x00')?.kind).toBe('atlas');
        // every facade content texel is a point of the facade rectangle, with the facade's street-facing normal
        let n = 0, worst = 0, normalOk = true;
        for (let i = 0; i < atlas.width * atlas.height; i++) {
            if (atlas.texels.mapIndex[i] !== fm || atlas.texels.gutter[i]) continue;
            n++;
            const [x, y, z] = [atlas.texels.position[i * 3], atlas.texels.position[i * 3 + 1], atlas.texels.position[i * 3 + 2]];
            worst = Math.max(worst, Math.abs(z), Math.max(0, -x, x - FACADE.widthM), Math.max(0, -y, y - FACADE.heightM));
            if (atlas.texels.normal[i * 3 + 2] > -0.999999) normalOk = false;
            expect(atlas.texels.sizeM[i]).toBeCloseTo(1 / d, 6);
        }
        expect(worst).toBeLessThan(1e-5);
        expect(normalOk).toBe(true);
        // coverage: 10 m x 6 m at 6.4 texels/m is 2457.6 texels; the edge rows may round either way
        expect(Math.abs(n - FACADE.widthM * FACADE.heightM * d * d)).toBeLessThanOrEqual(2 * (FACADE.widthM + FACADE.heightM) * d);
        // the texel -> UV inversion is exact: the facade's UVs are affine in (x, y); every content texel's position maps back to its own centre
        const L = atlas.layout.primitives.find(p => p.nodeName === 'facade-node')!;
        const { json, bin } = parseGlb(scene.glb);
        const P = readAccessor(json, bin, json.meshes[L.meshIndex].primitives[0].attributes.POSITION).data;
        const affine = affineUv(L, P);
        let worstTexel = 0;
        for (let i = 0; i < atlas.width * atlas.height; i++) {
            if (atlas.texels.mapIndex[i] !== fm || atlas.texels.gutter[i]) continue;
            const [X, Y] = affine(atlas.texels.position[i * 3], atlas.texels.position[i * 3 + 1]);
            worstTexel = Math.max(worstTexel, Math.abs(X * atlas.width - ((i % atlas.width) + 0.5)), Math.abs(Y * atlas.height - (Math.floor(i / atlas.width) + 0.5)));
        }
        expect(worstTexel).toBeLessThan(1e-3);
    });

    it('puts cylinder-chart texels on the cylinder itself (the analytic surface, not the 15-degree chords of the mesh)', async () => {
        const atlas = await buildUvAtlas({ layerKey: 'fit', clayGlb: scene.glb, densityTexelsPerMeter: 40, maxSide: 4096, islandNormalToleranceDeg: 30, surfaces: scene.surfaces });
        expectValid(audit(atlas, scene.glb));
        const cm = atlas.maps.findIndex(m => m.nodeName === 's01');
        let n = 0, worstR = 0, worstN = 0;
        for (let i = 0; i < atlas.width * atlas.height; i++) {
            if (atlas.texels.mapIndex[i] !== cm || atlas.texels.gutter[i]) continue;
            n++;
            const dx = atlas.texels.position[i * 3] - COLUMN.axisOrigin[0], dz = atlas.texels.position[i * 3 + 2] - COLUMN.axisOrigin[2];
            worstR = Math.max(worstR, Math.abs(Math.hypot(dx, dz) - COLUMN.radiusM));
            const r = Math.hypot(dx, dz);
            worstN = Math.max(worstN, 1 - (atlas.texels.normal[i * 3] * dx + atlas.texels.normal[i * 3 + 2] * dz) / r);
        }
        expect(n).toBeGreaterThan(Math.PI * COLUMN.radiusM * COLUMN.heightM * 40 * 40 * 0.9);
        // the chords sag up to r(1 - cos 7.5 deg) = 5.1 mm; the analytic texels sit on the cylinder to float precision
        expect(worstR).toBeLessThan(2e-5);
        expect(worstN).toBeLessThan(1e-6);
    });

    it('unwraps the scan lump into native islands: no overlap, UVs in [0,1], gutters, barycentric texels; clay positions referenced, never rewritten', async () => {
        const atlas = await buildUvAtlas({ layerKey: 'scan', clayGlb: scene.glb, densityTexelsPerMeter: 24, maxSide: 4096, islandNormalToleranceDeg: 25, surfaces: [] });
        const a = audit(atlas, scene.glb);
        expectValid(a);
        expect(a.positionErrorM).toBeLessThan(1e-4);
        expect(atlas.layout.stats.charts).toBe(0);
        // a noisy box at 25 deg: at least its six sides, no fan of singletons
        expect(atlas.layout.stats.islands).toBeGreaterThanOrEqual(6);
        expect(atlas.layout.stats.islands).toBeLessThan(80);
        expect(atlas.layout.stats.native).toBeDefined();
        // every clay triangle is in the twin, in the clay order, with the same source vertices
        const { json, bin } = parseGlb(scene.glb);
        for (const L of atlas.layout.primitives) {
            const prim = json.meshes[L.meshIndex].primitives[L.primitiveIndex];
            const I = readAccessor(json, bin, prim.indices).data;
            expect(L.indices.length).toBe(I.length);
            for (let k = 0; k < I.length; k++) expect(L.sourceVertex[L.indices[k]]).toBe(I[k]);
        }
        // islands of the lump are near-planar at 25 deg: the surface area per texel never exceeds 1/cos(25 + noise) of the plane's
        const lm = atlas.maps.findIndex(m => m.nodeName === 'x00');
        let worst = 0;
        for (let i = 0; i < atlas.width * atlas.height; i++) if (atlas.texels.mapIndex[i] === lm && !atlas.texels.gutter[i]) worst = Math.max(worst, atlas.texels.sizeM[i] * 24);
        expect(worst).toBeGreaterThanOrEqual(1);
        expect(worst).toBeLessThan(1 / Math.sqrt(Math.cos((40 * Math.PI) / 180)));
    });

    it('lowers the density for every chart and island when the layer does not fit in maxSide, and reports the measured density', async () => {
        const atlas = await buildUvAtlas({ layerKey: 'fit', clayGlb: scene.glb, densityTexelsPerMeter: 200, maxSide: 256, islandNormalToleranceDeg: 30, surfaces: scene.surfaces });
        expect(Math.max(atlas.width, atlas.height)).toBeLessThanOrEqual(256);
        expect(atlas.layout.stats.texelsPerMeter).toBeLessThan(200);
        for (const m of atlas.maps) expect(m.texelsPerMeter).toBe(atlas.layout.stats.texelsPerMeter);
        expectValid(audit(atlas, scene.glb));
    });
});

describe('texture pass B: textured twin', () => {
    const scene = fixtureScene();

    it('round-trips through a separate GLB reader: magic, accessor counts, clay bytes per vertex, TEXCOORD_0, images decode to the planes, extras kept', async () => {
        const d = 8;
        const atlas = await buildUvAtlas({ layerKey: 'fit', clayGlb: scene.glb, densityTexelsPerMeter: d, maxSide: 2048, islandNormalToleranceDeg: 30, surfaces: scene.surfaces });
        const { width: W, height: H } = atlas;
        // albedo: the facade's analytic albedo at each texel's world point (what a perfect bake produces); confidence: entry 0
        const albedo = new Uint8Array(W * H * 4), confidence = emptyConfidencePlane(W, H);
        for (let i = 0; i < W * H; i++) {
            if (!atlas.texels.covered[i] || atlas.texels.gutter[i]) continue;
            const rgb = facadeAlbedo(atlas.texels.position[i * 3], atlas.texels.position[i * 3 + 1]);
            albedo.set([Math.round(Math.min(255, Math.max(0, rgb[0]))), Math.round(Math.min(255, Math.max(0, rgb[1]))), Math.round(Math.min(255, Math.max(0, rgb[2]))), 255], i * 4);
            packConfidenceTexel(confidence, i, i % 2, 0.5 + (i % 3) / 6, i % 2);
        }
        const provenance: TexelProvenance[] = [
            { source: 'street-view-projection', label: 'photo-inferred', method: 'test plane', coverage: 0.5 },
            { source: 'tile-photo-transfer', label: 'photo-inferred', method: 'test plane', coverage: 0.5 }
        ];
        const planes: BakedTexturePlanes = { layerKey: 'fit', width: W, height: H, albedo, confidence, provenance, degradations: [], paletteDeltaE: 1.5 };
        const roughness = Uint8Array.from({ length: W * H }, (_, i) => i % 256);
        const out = await writeTexturedTwin({ clayGlb: scene.glb, atlas, planes, ...{ roughness } } as Parameters<typeof writeTexturedTwin>[0]);
        const glb = Buffer.from(out.glb);
        expect(glb.readUInt32LE(0)).toBe(0x46546c67);
        expect(glb.readUInt32LE(8)).toBe(glb.length);
        const twin = parseGlb(glb), clay = parseGlb(scene.glb);
        // nodes: same names, same extras plus sbTexture
        expect(twin.json.nodes.map((n: any) => n.name)).toEqual(clay.json.nodes.map((n: any) => n.name));
        for (const [k, n] of clay.json.nodes.entries()) {
            const { sbTexture, ...rest } = twin.json.nodes[k].extras ?? {};
            expect(rest).toEqual(n.extras ?? {});
            if (n.mesh !== undefined) expect(sbTexture?.provenance).toEqual(provenance);
        }
        expect(twin.json.asset.extras.sbTexture).toMatchObject({ layerKey: 'fit', width: W, height: H, paletteDeltaE: 1.5 });
        // per-texel provenance shares on each node sum to 1 (every content texel is labelled in this plane)
        for (const n of twin.json.nodes.filter((x: any) => x.mesh !== undefined)) {
            const s = n.extras.sbTexture.texelProvenance.reduce((acc: number, e: { share: number }) => acc + e.share, 0);
            expect(s).toBeCloseTo(1, 9);
            expect(n.extras.sbTexture.unproducedShare).toBe(0);
        }
        // geometry: every twin vertex carries the clay vertex's exact bytes; TEXCOORD_0 count = POSITION count
        const clayBytes = (acc: number) => { const a = clay.json.accessors[acc], v = clay.json.bufferViews[a.bufferView]; return clay.bin.subarray((v.byteOffset ?? 0) + (a.byteOffset ?? 0)); };
        const twinBytes = (acc: number) => { const a = twin.json.accessors[acc], v = twin.json.bufferViews[a.bufferView]; return { b: twin.bin.subarray((v.byteOffset ?? 0) + (a.byteOffset ?? 0)), stride: v.byteStride }; };
        for (const L of atlas.layout.primitives) {
            const tp = twin.json.meshes[L.meshIndex].primitives[L.primitiveIndex], cp = clay.json.meshes[L.meshIndex].primitives[L.primitiveIndex];
            const n = twin.json.accessors[tp.attributes.POSITION].count;
            expect(n).toBe(L.sourceVertex.length);
            expect(twin.json.accessors[tp.attributes.TEXCOORD_0].count).toBe(n);
            expect(twin.json.accessors[tp.attributes.NORMAL].count).toBe(n);
            expect(twin.json.accessors[tp.indices].count).toBe(clay.json.accessors[cp.indices].count);
            for (const attr of Object.keys(cp.attributes)) {
                const size = attr === '_PROV' ? 4 : 12;
                const cb = clayBytes(cp.attributes[attr]), { b: tb, stride } = twinBytes(tp.attributes[attr]);
                for (let k = 0; k < n; k++) {
                    const s = L.sourceVertex[k];
                    expect(Buffer.compare(tb.subarray(k * (stride ?? size), k * (stride ?? size) + size), cb.subarray(s * size, s * size + size))).toBe(0);
                }
            }
            const uv = readAccessor(twin.json, twin.bin, tp.attributes.TEXCOORD_0).data;
            for (const x of uv) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1); }
            expect(tp.material).toBe(twin.json.materials.findIndex((m: any) => m.name === 'StagedTexturedPhoto'));
        }
        // images: albedo (RGB), confidence (RGBA), roughness (G); decode with the test decoder and compare to the planes
        const mat = twin.json.materials.find((m: any) => m.name === 'StagedTexturedPhoto');
        const image = (tex: number) => {
            const img = twin.json.images[twin.json.textures[tex].source], v = twin.json.bufferViews[img.bufferView];
            expect(img.mimeType).toBe('image/png');
            return decodePng(twin.bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength));
        };
        const alb = image(mat.pbrMetallicRoughness.baseColorTexture.index), conf = image(mat.extras.sbTexture.confidenceTexture), rough = image(mat.pbrMetallicRoughness.metallicRoughnessTexture.index);
        expect([alb.width, alb.height, alb.channels, conf.channels, rough.channels]).toEqual([W, H, 3, 4, 3]);
        expect(Buffer.compare(Buffer.from(conf.pixels), Buffer.from(confidence.data))).toBe(0);
        let albedoDiff = 0, roughDiff = 0, gutterFilled = 0, gutterTexels = 0;
        for (let i = 0; i < W * H; i++) {
            if (rough.pixels[i * 3 + 1] !== roughness[i] || rough.pixels[i * 3 + 2] !== 0) roughDiff++;
            if (atlas.texels.gutter[i]) { gutterTexels++; if (alb.pixels[i * 3] || alb.pixels[i * 3 + 1] || alb.pixels[i * 3 + 2]) gutterFilled++; continue; }
            for (let c = 0; c < 3; c++) if (alb.pixels[i * 3 + c] !== albedo[i * 4 + c]) albedoDiff++;
        }
        expect(albedoDiff).toBe(0);
        expect(roughDiff).toBe(0);
        expect(gutterFilled).toBe(gutterTexels);   // gutters are bled from produced texels
        // sampling the twin at a facade triangle's centroid UV gives the facade's albedo at the centroid (within the half-texel gradient)
        const L = atlas.layout.primitives.find(p => p.nodeName === 'facade-node')!;
        const P = readAccessor(clay.json, clay.bin, clay.json.meshes[L.meshIndex].primitives[0].attributes.POSITION).data;
        for (let t = 0; t < L.indices.length; t += 3) {
            const vs = [0, 1, 2].map(k => L.indices[t + k]);
            const u = vs.reduce((acc, v) => acc + L.uv[v * 2], 0) / 3, v = vs.reduce((acc, x) => acc + L.uv[x * 2 + 1], 0) / 3;
            const x = vs.reduce((acc, q) => acc + P[L.sourceVertex[q] * 3], 0) / 3, y = vs.reduce((acc, q) => acc + P[L.sourceVertex[q] * 3 + 1], 0) / 3;
            const i = Math.floor(v * H) * W + Math.floor(u * W);
            expect(atlas.texels.gutter[i]).toBe(0);
            const want = facadeAlbedo(x, y);
            // albedo gradient is at most 15 per metre per channel; the texel centre is within half a texel diagonal
            for (let c = 0; c < 3; c++) expect(Math.abs(alb.pixels[i * 3 + c] - want[c])).toBeLessThanOrEqual(15 * (Math.SQRT1_2 / d) + 0.5);
        }
        expect(out.uv.map(m => m.nodeName).sort()).toEqual(['facade-node', 's01', 'x00']);
    });

    it('refuses an atlas laid out over another clay GLB, or one without a layout', async () => {
        const atlas = await buildUvAtlas({ layerKey: 'fit', clayGlb: scene.glb, densityTexelsPerMeter: 4, maxSide: 1024, islandNormalToleranceDeg: 30, surfaces: scene.surfaces });
        const planes = checkerPlanes(atlas);
        const other = writeStagedGlb([{ name: 'q', positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) }]);
        expect(() => writeTexturedTwinGlb({ clayGlb: other, atlas, planes })).toThrow(/different clay GLB/);
        const { layout: _l, ...bare } = atlas;
        expect(() => writeTexturedTwinGlb({ clayGlb: scene.glb, atlas: bare, planes })).toThrow(/no twin layout/);
    });

    it('leaves the clay writer byte-for-byte as it was', () => {
        const g = writeStagedGlb([
            { name: 'a', positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0.5]), indices: new Uint32Array([0, 1, 2, 2, 1, 3]), attributes: { _PROV: new Float32Array([1, 2, 3, 4]) }, extras: { sb: { stage: 'fit' } } },
            { name: 'b', positions: new Float32Array([0, 0, 1, 1, 0, 1, 0, 1, 1]) }
        ], { rootExtras: { sb: { stage: 'fit' } }, copyright: 'Google' });
        // sha256 of this input through writeStagedGlb at texture-contracts 338fb8f5 (before the twin writer was added)
        expect(crypto.createHash('sha256').update(g).digest('hex')).toBe('fb5c4a8c69fd43a49a8d3967806b851930148c381282d8bed0bed5ac67114e41');
    });

    it.skipIf(!twinChrome.ok)('renders the fixture twin with a UV checkerboard in three.js (Chrome decodes the PNGs)', async () => {
        const atlas = await buildUvAtlas({ layerKey: 'fit', clayGlb: scene.glb, densityTexelsPerMeter: 24, maxSide: 2048, islandNormalToleranceDeg: 25, surfaces: scene.surfaces });
        const { glb } = writeTexturedTwinGlb({ clayGlb: scene.glb, atlas, planes: checkerPlanes(atlas, 6) });
        const shot = await renderTwinInChrome(glb, path.join(SHOTS, 'fixture_uv_checker.png'), { bearingDeg: 200, elevationDeg: 18 });
        expect(shot.errors).toEqual([]);
        expect(shot.images).toEqual([{ uuid: expect.any(String), width: atlas.width, height: atlas.height }]);
        expect(shot.textured.every(t => t.hasUv && t.map)).toBe(true);
        expect(fs.statSync(shot.file).size).toBeGreaterThan(10_000);
    }, 120_000);
});

describe('texture pass B: real arch data (skipped when the gitignored scan_fit / tile_refine caches are absent)', () => {
    const fit = findArchFit();
    const sized = findSizedArchData();

    it.skipIf(!fit)('lays out the real arch fit: chart UVs for the fitted surfaces, islands for the rest, valid atlas; screenshot', async () => {
        const fitJson = JSON.parse(fs.readFileSync(fit!.fitPath, 'utf8'));
        const clay = fs.readFileSync(path.join(fit!.dir, fitJson.outputs?.fittedGlb ?? 'fitted.glb'));
        const t0 = Date.now();
        const atlas = await buildUvAtlas({ layerKey: 'fit', clayGlb: clay, densityTexelsPerMeter: 20, maxSide: 4096, islandNormalToleranceDeg: 30, surfaces: fitJson.surfaces });
        const ms = Date.now() - t0;
        expectValid(audit(atlas, clay));
        const meshNodes = parseGlb(clay).json.nodes.filter((n: any) => n.mesh !== undefined).length;
        expect(atlas.maps.length).toBe(meshNodes);
        // most fitted surfaces keep their exact chart; every rejected one names its measured reason
        expect(atlas.layout.stats.charts).toBeGreaterThan(0.9 * fitJson.surfaces.length);
        for (const r of atlas.layout.stats.chartsRejected) expect(r.reason.length).toBeGreaterThan(20);
        expect(atlas.layout.stats.texelsPerMeter).toBe(20);
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'arch_fit_atlas_stats.json'), JSON.stringify({ width: atlas.width, height: atlas.height, ...atlas.layout.stats, wallMs: ms }, null, 2));
        if (twinChrome.ok) {
            const { glb } = writeTexturedTwinGlb({ clayGlb: clay, atlas, planes: checkerPlanes(atlas, 8) });
            const shot = await renderTwinInChrome(glb, path.join(SHOTS, 'arch_fit_uv_checker.png'), { bearingDeg: 320, elevationDeg: 12, distanceScale: 1.05 });
            expect(shot.errors).toEqual([]);
            expect(shot.images[0]).toMatchObject({ width: atlas.width, height: atlas.height });
        }
    }, 300_000);

    it.skipIf(!fit)('unwraps the real arch pass-through scan regions into islands', async () => {
        const fitJson = JSON.parse(fs.readFileSync(fit!.fitPath, 'utf8'));
        const clay = fs.readFileSync(path.join(fit!.dir, fitJson.outputs?.passThroughGlb ?? 'passthrough.glb'));
        const atlas = await buildUvAtlas({ layerKey: 'l3c', clayGlb: clay, densityTexelsPerMeter: 20, maxSide: 4096, islandNormalToleranceDeg: 30 });
        expectValid(audit(atlas, clay));
        expect(atlas.layout.stats.islands).toBeGreaterThan(0);
    }, 300_000);

    it.skipIf(!sized)('unwraps the real remeshed arch scan (tile_refine clay) into islands with bit-identical clay positions; screenshot', async () => {
        const clay = fs.readFileSync(sized!.remeshClay);
        const t0 = Date.now();
        const atlas = await buildUvAtlas({ layerKey: 'remesh', clayGlb: clay, densityTexelsPerMeter: 20, maxSide: 4096, islandNormalToleranceDeg: 30 });
        const ms = Date.now() - t0;
        const a = audit(atlas, clay);
        expectValid(a);
        expect(a.positionErrorM).toBeLessThan(1e-3);
        const { glb } = writeTexturedTwinGlb({ clayGlb: clay, atlas, planes: checkerPlanes(atlas, 8) });
        // positions: the twin's POSITION bytes are the clay's, vertex by vertex
        const twin = parseGlb(glb), src = parseGlb(clay);
        let mismatched = 0;
        for (const L of atlas.layout.primitives) {
            const ta = twin.json.accessors[twin.json.meshes[L.meshIndex].primitives[L.primitiveIndex].attributes.POSITION];
            const ca = src.json.accessors[src.json.meshes[L.meshIndex].primitives[L.primitiveIndex].attributes.POSITION];
            const tv = twin.json.bufferViews[ta.bufferView], cv = src.json.bufferViews[ca.bufferView];
            const tb = twin.bin.subarray((tv.byteOffset ?? 0) + (ta.byteOffset ?? 0)), cb = src.bin.subarray((cv.byteOffset ?? 0) + (ca.byteOffset ?? 0));
            const cs = cv.byteStride ?? 12;
            for (let k = 0; k < L.sourceVertex.length; k++) if (Buffer.compare(tb.subarray(k * 12, k * 12 + 12), cb.subarray(L.sourceVertex[k] * cs, L.sourceVertex[k] * cs + 12))) mismatched++;
        }
        expect(mismatched).toBe(0);
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'arch_remesh_atlas_stats.json'), JSON.stringify({ width: atlas.width, height: atlas.height, ...atlas.layout.stats, wallMs: ms }, null, 2));
        if (twinChrome.ok) {
            const shot = await renderTwinInChrome(glb, path.join(SHOTS, 'arch_remesh_uv_checker.png'), { bearingDeg: 320, elevationDeg: 12, distanceScale: 1.05 });
            expect(shot.errors).toEqual([]);
        }
    }, 300_000);
});
