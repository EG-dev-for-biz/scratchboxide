/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The surface infill (surface-infill.ts) on synthetic scanned surfaces (surface-infill-fixtures.ts) with their ground
 * truth: the geometry rebuilt from the ring (grade, camber, a kerb kept sharp, a closed loop watertight), every rung of the
 * texture ladder chosen by what the surface measures (a lane line and its dashes continued in phase, paving joints kept on
 * their lattice, gravel synthesised from its own grain, a registered view taken when it sees the surface clear and refused
 * when it does not, the library, the inpaint, the membrane), the seam gate's bars, and the GLB written back.
 */

import { describe, expect, it } from 'vitest';
import { ProColorGradeMatchingService as Colour } from '../src/node/image/ProColorGradeMatchingService';
import { parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { decodeImageInMemory, readTileTriangles } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { applyInfillToGlb, cellsToTriangles, infillExtras, infillRegions, INFILL_LABEL, type InfillInpainter, type InfillRegionSpec, type InfillView, type RegionInfill } from '../src/node/3d-engine/staged-location/surface-infill';
import { closeLoop, fitChart, fitSurfaceModel, resurfacePoint, toChart } from '../src/node/3d-engine/staged-location/surface-infill-geometry';
import { seamGate } from '../src/node/3d-engine/staged-location/surface-infill-gates';
import { gravelPark, HALF, isDash, isJoint, KERB_RISE, KERB_Z, kerbStreet, laneStreet, lumpHole, lumpRing, luma, noise, pavingPlaza, sceneGlb, type Lump, type Scene } from './surface-infill-fixtures';

const PAD = 0.4;
const regionOf = (s: Scene, l: Lump, id: number): InfillRegionSpec => ({ id, what: `the lump ${id}`, hole: lumpHole(s, l, PAD), ring: lumpRing(s, l, PAD) });

/** Each target texel's world plan position, fill colour and ground truth. */
function targetTexels(r: RegionInfill, s: Scene): Array<{ x: number; z: number; fill: [number, number, number]; truth: [number, number, number]; label: number }> {
    const c = r.chart, out = [];
    for (let k = 0; k < c.height; k++) for (let i = 0; i < c.width; i++) {
        const p = k * c.width + i;
        if (!r.target[p]) continue;
        const x = c.origin[0] + (i + 0.5) * c.texelM, z = c.origin[2] + (k + 0.5) * c.texelM;
        out.push({ x, z, fill: [r.rgb[p * 3], r.rgb[p * 3 + 1], r.rgb[p * 3 + 2]] as [number, number, number], truth: s.truth(x, z), label: r.label[p] });
    }
    return out;
}
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))); };
const accepted = (r: RegionInfill) => r.attempts.filter(a => a.accepted).map(a => a.rung);

describe('surface infill: geometry', () => {
    const ringOf = (f: (x: number, z: number) => number, r0: number, r1: number) => { const out: number[] = []; for (let z = -4; z <= 4; z += 0.25) for (let x = -4; x <= 4; x += 0.25) { const d = Math.hypot(x, z); if (d >= r0 && d <= r1) out.push(x, f(x, z), z); } return Float32Array.from(out); };
    const holeDisc = (r: number) => { const out: number[] = []; for (let z = -r; z < r; z += 0.1) for (let x = -r; x < r; x += 0.1) if (Math.hypot(x + 0.05, z + 0.05) < r) out.push(x, 0, z, x, 0, z + 0.1, x + 0.1, 0, z, x + 0.1, 0, z, x, 0, z + 0.1, x + 0.1, 0, z + 0.1); return Float32Array.from(out); };

    it('keeps grade and camber from the ring: one surface, heights within a centimetre under the hole', () => {
        const f = (x: number, z: number) => 0.03 * x - 0.008 * z * z + 5;
        const ring = ringOf(f, 2.2, 3.5);
        const chart = fitChart({ ring, hole: holeDisc(2), texelM: 0.05, marginM: 2 });
        const m = fitSurfaceModel(ring, chart);
        expect(chart.plan).toBe(true);
        expect(m.kind).toBe('surface');
        let worst = 0;
        for (const [x, z] of [[0, 0], [1, 1], [-1.5, 0.5], [0.5, -1.7]]) { const p = resurfacePoint(m, x, 99, z); worst = Math.max(worst, Math.abs(p[1] - f(x, z))); expect(p[0]).toBeCloseTo(x, 6); expect(p[2]).toBeCloseTo(z, 6); }
        expect(worst).toBeLessThan(0.012);
        expect(m.ringRmsM).toBeLessThan(0.01);
    });

    it('keeps a kerb sharp: two levels split by a straight breakline, each its own surface', () => {
        const f = (x: number, z: number) => 0.01 * x + (z > 0.6 ? 0.15 : 0);
        const ring = ringOf(f, 2.2, 3.5);
        const chart = fitChart({ ring, hole: holeDisc(2), texelM: 0.05, marginM: 2 });
        const m = fitSurfaceModel(ring, chart);
        expect(m.kind).toBe('stepped');
        expect(m.levels).toHaveLength(2);
        expect(m.breakline?.accuracy).toBeGreaterThanOrEqual(0.92);
        const h = (x: number, z: number) => resurfacePoint(m, x, 0, z)[1];
        expect(Math.abs(h(0, -1) - f(0, -1))).toBeLessThan(0.01);
        expect(Math.abs(h(0, 1.5) - f(0, 1.5))).toBeLessThan(0.01);
        // across the kerb within 0.3 m: the full step, not a ramp
        expect(h(0.5, 0.85) - h(0.5, 0.35)).toBeGreaterThan(0.13);
        expect(m.levels[1].meanW - m.levels[0].meanW).toBeCloseTo(0.15, 1);
    });

    it('does not cut a smooth camber into levels', () => {
        const f = (x: number, z: number) => -0.04 * z * z;
        const ring = ringOf(f, 2.2, 3.8);
        const m = fitSurfaceModel(ring, fitChart({ ring, hole: holeDisc(2), texelM: 0.05, marginM: 2 }));
        expect(m.kind).toBe('surface');
    });

    it('charts a wall in its own plane, facing the way it was seen from', () => {
        const ring: number[] = [];
        for (let y = 0; y <= 6; y += 0.25) for (let z = -3; z <= 3; z += 0.25) if (Math.hypot(y - 3, z) > 1.5) ring.push(5 + 0.002 * z, y, z);
        const hole: number[] = [4.99, 2, -1, 4.99, 4, -1, 4.99, 2, 1, 4.99, 2, 1, 4.99, 4, -1, 4.99, 4, 1];
        const chart = fitChart({ ring: Float32Array.from(ring), hole: Float32Array.from(hole), texelM: 0.05, marginM: 1, normalHint: [-1, 0, 0] });
        expect(chart.plan).toBe(false);
        expect(chart.n[0]).toBeLessThan(-0.99);
        const m = fitSurfaceModel(Float32Array.from(ring), chart);
        const p = resurfacePoint(m, 4.6, 3, 0);
        expect(p[0]).toBeCloseTo(5, 2);
    });

    it('closes an open loop watertight: its rim edges used once, its rim heights kept, its inside on the model', () => {
        const f = (x: number, z: number) => 0.05 * x + 0.02 * z + 1;
        const loop: number[] = [];
        for (let j = 0; j < 40; j++) { const t = (j / 40) * 2 * Math.PI, r = 2 + 0.4 * Math.cos(3 * t); const x = r * Math.cos(t), z = r * Math.sin(t); loop.push(x, f(x, z) + 0.004 * Math.sin(7 * t), z); }
        const ringPts = ringOf(f, 2.6, 3.5);
        const chart = fitChart({ ring: ringPts, hole: Float32Array.from(loop), texelM: 0.05, marginM: 1 });
        const m = fitSurfaceModel(ringPts, chart);
        const c = closeLoop(Float32Array.from(loop), m, 0.3)!;
        expect(c).toBeDefined();
        expect(c.watertight).toBe(true);
        expect(c.loopVertices).toBe(40);
        expect(c.interiorVertices).toBeGreaterThan(40);
        for (let j = 0; j < 40 * 3; j++) expect(c.positions[j]).toBe(Math.fround(loop[j]));
        let worst = 0;
        for (let v = 40; v < c.positions.length / 3; v++) worst = Math.max(worst, Math.abs(c.positions[v * 3 + 1] - f(c.positions[v * 3], c.positions[v * 3 + 2])));
        expect(worst).toBeLessThan(0.01);
        // every triangle faces up (the chart's normal), none degenerate
        for (let t = 0; t < c.indices.length; t += 3) {
            const P = (k: number) => [c.positions[c.indices[t + k] * 3], c.positions[c.indices[t + k] * 3 + 1], c.positions[c.indices[t + k] * 3 + 2]];
            const [a, b, d] = [P(0), P(1), P(2)];
            const ny = (b[2] - a[2]) * (d[0] - a[0]) - (b[0] - a[0]) * (d[2] - a[2]);
            expect(ny).toBeGreaterThan(1e-6);
        }
    });

    it('refuses a loop that folds over itself seen along the normal', () => {
        const ring = ringOf(() => 0, 2.5, 3.5);
        const m = fitSurfaceModel(ring, fitChart({ ring, hole: holeDisc(2), texelM: 0.05, marginM: 2 }));
        const bow = Float32Array.from([-1, 0, -1, 1, 0, 1, 1, 0, -1, -1, 0, 1]);
        expect(closeLoop(bow, m, 0.3)).toBeUndefined();
    });
});

describe('surface infill: the seam gate', () => {
    const W = 120, H = 120;
    const base = () => { const rgb = new Float32Array(W * H * 3); for (let k = 0; k < H; k++) for (let i = 0; i < W; i++) { const g = 30 * noise(i * 0.05, k * 0.05, 0.05, 5) + 15 * noise(i * 0.05, k * 0.05, 0.2, 6); rgb.set([120 + g, 110 + g, 100 + g], (k * W + i) * 3); } return rgb; };
    const disc = () => { const fill = new Uint8Array(W * H), ref = new Uint8Array(W * H); for (let p = 0; p < W * H; p++) { const i = p % W, k = (p - i) / W; if (Math.hypot(i - 60, k - 60) < 30) fill[p] = 1; else ref[p] = 1; } return { fill, ref }; };

    it('passes the surface itself and fails a flat smear, a colour step and a tiled copy, each with its reason', () => {
        const { fill, ref } = disc();
        const truth = seamGate({ width: W, height: H, texelM: 0.05, rgb: base(), fill, ref });
        expect(truth.pass).toBe(true);
        expect(truth.metrics.rim!.median).toBeLessThan(3);
        // smear: the fill one flat mean colour
        const flat = base();
        for (let p = 0; p < W * H; p++) if (fill[p]) flat.set([120, 110, 100], p * 3);
        const s = seamGate({ width: W, height: H, texelM: 0.05, rgb: flat, fill, ref });
        expect(s.pass).toBe(false);
        expect(s.failures.join(' ')).toMatch(/smeared|flatter/);
        // a step: the right texture, 40 levels too light
        const step = base();
        for (let p = 0; p < W * H; p++) if (fill[p]) for (let j = 0; j < 3; j++) step[p * 3 + j] += 40;
        const st = seamGate({ width: W, height: H, texelM: 0.05, rgb: step, fill, ref });
        expect(st.pass).toBe(false);
        expect(st.failures.join(' ')).toMatch(/join shows/);
        expect(st.metrics.rim!.median).toBeGreaterThan(8);
        // a tiled copy: one 9 x 9 patch of the surface repeated over the fill
        const tiled = base(), b = base();
        for (let p = 0; p < W * H; p++) if (fill[p]) { const i = p % W, k = (p - i) / W, q = (5 + (k % 9)) * W + (5 + (i % 9)); for (let j = 0; j < 3; j++) tiled[p * 3 + j] = b[q * 3 + j]; }
        const t = seamGate({ width: W, height: H, texelM: 0.05, rgb: tiled, fill, ref });
        expect(t.pass).toBe(false);
        expect(t.failures.join(' ')).toMatch(/visible repeat/);
        expect(t.metrics.repeat!.fillPeak).toBeGreaterThan(0.7);
    });
});

describe('surface infill: the texture ladder', () => {
    it('continues a lane line and its dashes in phase along the measured direction (photo-inferred), seams under the bar', async () => {
        const s = laneStreet, glb = sceneGlb(s), scan = readTileTriangles(glb);
        const out = await infillRegions({ scan, regions: s.lumps.map((l, k) => regionOf(s, l, k)) });
        const [car, box] = out.regions;
        for (const r of [car, box]) {
            expect(accepted(r)).toEqual(['directional continuation']);
            expect(r.gatePassed).toBe(true);
            expect(r.shares['photo-inferred']).toBe(1);
            const d = r.attempts.find(a => a.rung === 'directional continuation')!;
            expect(d.gate!.metrics.rim!.median).toBeLessThan(4);
            expect(r.structure.coherence).toBeGreaterThan(0.25);
            expect(Math.min(r.structure.angleDeg, 180 - r.structure.angleDeg)).toBeLessThan(3);
        }
        // the solid line under the car continues: bright on it, asphalt beside it
        const t = targetTexels(car, s);
        const onLine = t.filter(q => Math.abs(q.z) < 0.04).map(q => luma(q.fill)), beside = t.filter(q => Math.abs(q.z) > 0.3 && Math.abs(q.z) < 0.7);
        expect(mean(onLine)).toBeGreaterThan(200);
        expect(mean(beside.map(q => luma(q.fill)))).toBeGreaterThan(70);
        expect(mean(beside.map(q => luma(q.fill)))).toBeLessThan(100);
        // the asphalt keeps its grain (no smear): the fill's spread against the truth's
        const ratio = sd(beside.map(q => luma(q.fill))) / sd(beside.map(q => luma(q.truth)));
        expect(ratio).toBeGreaterThan(0.6);
        expect(ratio).toBeLessThan(1.6);
        // no car colour left
        expect(t.filter(q => q.fill[0] > 150 && q.fill[1] < 80).length).toBe(0);
        // the dashes under the box: bright where a dash is, dark in the gaps
        const b = targetTexels(box, s).filter(q => Math.abs(q.z - 3) < 0.04);
        const agree = b.filter(q => (luma(q.fill) > 160) === isDash(q.x)).length / b.length;
        expect(b.length).toBeGreaterThan(100);
        expect(agree).toBeGreaterThan(0.85);
        expect(box.structure.along?.pitchM).toBeCloseTo(3, 0);
    }, 300_000);

    it('keeps paving joints on their measured lattice when no single direction holds (periodic, photo-inferred)', async () => {
        const s = pavingPlaza, scan = readTileTriangles(sceneGlb(s));
        const out = await infillRegions({ scan, regions: [regionOf(s, s.lumps[0], 0)] });
        const r = out.regions[0];
        expect(r.attempts.find(a => a.rung === 'directional continuation')!.reason).toMatch(/no measured direction/);
        expect(accepted(r)).toEqual(['periodic continuation']);
        expect(r.structure.along?.pitchM ?? r.structure.across?.pitchM).toBeCloseTo(0.5, 1);
        const t = targetTexels(r, s);
        const joints = t.filter(q => isJoint(q.x, q.z)).map(q => luma(q.fill)), tiles = t.filter(q => !isJoint(q.x - 0.06, q.z - 0.06) && !isJoint(q.x, q.z) && !isJoint(q.x + 0.06, q.z + 0.06)).map(q => luma(q.fill));
        expect(mean(tiles) - mean(joints)).toBeGreaterThan(30);
        expect(r.attempts.find(a => a.accepted)!.gate!.metrics.rim!.median).toBeLessThan(4);
    }, 300_000);

    it('synthesises gravel from its own grain when it has neither direction nor repeat (generated), no smear, no visible repeat', async () => {
        const s = gravelPark, scan = readTileTriangles(sceneGlb(s));
        const r = (await infillRegions({ scan, regions: [regionOf(s, s.lumps[0], 0)] })).regions[0];
        expect(accepted(r)).toEqual(['stochastic synthesis']);
        expect(r.shares.generated).toBe(1);
        const g = r.attempts.find(a => a.accepted)!.gate!;
        expect(g.metrics.hfRatio!).toBeGreaterThan(0.6);
        expect(g.metrics.rim!.median).toBeLessThan(4);
        if (g.metrics.repeat) expect(g.metrics.repeat.fillPeak).toBeLessThan(0.5);
        const t = targetTexels(r, s);
        const lab = (c: number[]) => Colour.srgbToLab(c[0], c[1], c[2]);
        const mf = [0, 1, 2].map(j => mean(t.map(q => q.fill[j]))), mt = [0, 1, 2].map(j => mean(t.map(q => q.truth[j])));
        expect(Colour.calculateDeltaE00(lab(mf), lab(mt))).toBeLessThan(3);
        expect(sd(t.map(q => luma(q.fill))) / sd(t.map(q => luma(q.truth)))).toBeGreaterThan(0.7);
    }, 300_000);

    /** A pinhole 25 m above the street looking straight down, its photo the street's truth (nothing on it). */
    function topView(s: Scene, image: (x: number, z: number) => [number, number, number], id: string): InfillView {
        const Wd = 900, f = 900 / (2 * Math.tan((50 * Math.PI) / 360));
        const eye: [number, number, number] = [0, 25, 1.5];
        const rgba = new Uint8Array(Wd * Wd * 4), depth = new Float32Array(Wd * Wd);
        for (let k = 0; k < Wd; k++) for (let i = 0; i < Wd; i++) {
            // ray: fwd (0,-1,0), right (1,0,0), up (0,0,-1)
            const dx = (i + 0.5 - Wd / 2) / f, dz = (k + 0.5 - Wd / 2) / f;
            let t = 25;
            for (let it = 0; it < 4; it++) t = eye[1] - s.ground(eye[0] + dx * t, eye[2] + dz * t);
            const x = eye[0] + dx * t, z = eye[2] + dz * t;
            const c = image(x, z);
            rgba.set([c[0], c[1], c[2], 255], (k * Wd + i) * 4);
            depth[k * Wd + i] = t;
        }
        return { id, camera: { eye, right: [1, 0, 0], up: [0, 0, -1], fwd: [0, -1, 0], fx: f, fy: f, cx: Wd / 2, cy: Wd / 2, width: Wd, height: Wd }, image: { width: Wd, height: Wd, rgba }, depth, quality: 1 };
    }

    it('takes a registered view that sees the surface clear (measured), and refuses one that does not match (falls to the next rung)', async () => {
        const s = laneStreet, scan = readTileTriangles(sceneGlb(s));
        const truthView = topView(s, (x, z) => { const c = s.truth(x, z); return [c[0] * 0.9, c[1] * 0.9, c[2] * 0.9]; }, 'clear');
        const good = (await infillRegions({ scan, regions: [regionOf(s, s.lumps[0], 0)], views: [truthView] })).regions[0];
        expect(accepted(good)).toEqual(['real view']);
        expect(good.shares.measured).toBe(1);
        const t = targetTexels(good, s);
        const de = t.filter((_, j) => j % 17 === 0).map(q => Colour.calculateDeltaE00(Colour.srgbToLab(q.fill[0], q.fill[1], q.fill[2]), Colour.srgbToLab(q.truth[0], q.truth[1], q.truth[2])));
        expect(de.sort((a, b) => a - b)[de.length >> 1]).toBeLessThan(3);
        // a view of something else (a different, coarser surface): the gate rejects it and the line is continued instead
        const wrong = topView(s, (x, z) => { const g = 110 * noise(x, z, 0.4, 77); return [130 + g, 130 + g, 130 + g]; }, 'mismatched');
        const r = (await infillRegions({ scan, regions: [regionOf(s, s.lumps[0], 0)], views: [wrong] })).regions[0];
        const v = r.attempts.find(a => a.rung === 'real view')!;
        expect(v.accepted).toBe(false);
        expect(v.reason).toMatch(/rejected by the seam gate/);
        expect(accepted(r)).toEqual(['directional continuation']);
    }, 300_000);

    it('falls to the library at real size tinted to the measured colour, then to the inpaint, then to the membrane, each with its reason', async () => {
        const s = gravelPark, scan = readTileTriangles(sceneGlb(s));
        const lump = s.lumps[0];
        const noContinuation = { minSources: 1e9 };
        // a library gravel, the wrong colour (grey): tinted to the ring's
        const Wt = 128, lib = new Uint8Array(Wt * Wt * 4);
        for (let k = 0; k < Wt; k++) for (let i = 0; i < Wt; i++) { const c = gravelPark.truth(i * 0.05 + 40, k * 0.05 + 40); const g = luma(c); lib.set([g, g, g, 255], (k * Wt + i) * 4); }
        const lr = (await infillRegions({ scan, regions: [regionOf(s, lump, 0)], params: noContinuation, library: [{ id: 'grey-gravel', width: Wt, height: Wt, rgba: lib, realSizeM: [6.4, 6.4] }] })).regions[0];
        expect(lr.attempts.find(a => a.rung === 'stochastic synthesis')!.reason).toMatch(/clear texels of the surface/);
        expect(accepted(lr)).toEqual(['library material']);
        const t = targetTexels(lr, s);
        const mf = [0, 1, 2].map(j => mean(t.map(q => q.fill[j]))), mt = [0, 1, 2].map(j => mean(t.map(q => q.truth[j])));
        expect(Colour.calculateDeltaE00(Colour.srgbToLab(mf[0], mf[1], mf[2]), Colour.srgbToLab(mt[0], mt[1], mt[2]))).toBeLessThan(4);
        // the inpaint: given the chart, the stand-in inpainter answers with the surface's truth (a perfect model)
        const spec = regionOf(s, lump, 1);
        const chart = fitChart({ ring: spec.ring, hole: spec.hole, texelM: 0.05, marginM: 6 });
        let crop0: [number, number] | undefined;
        const perfect: InfillInpainter = async c => {
            // the crop's place in the chart: found by matching its kept texels (the stand-in knows the scene, not the crop's offset)
            const rgba = Uint8Array.from(c.rgba);
            for (let oy = 0; oy <= chart.height - c.height && !crop0; oy++) for (let ox = 0; ox <= chart.width - c.width && !crop0; ox++) {
                let ok = true;
                for (let q = 0; q < c.width * c.height && ok; q += 97) { if (!c.keep[q]) continue; const i = q % c.width, k = (q - i) / c.width; const tr = s.truth(chart.origin[0] + (ox + i + 0.5) * 0.05, chart.origin[2] + (oy + k + 0.5) * 0.05); ok = Math.abs(tr[0] - c.rgba[q * 4]) <= 2; }
                if (ok) crop0 = [ox, oy];
            }
            if (!crop0) return { refused: 'could not place the crop' };
            for (let q = 0; q < c.width * c.height; q++) if (c.hole[q]) { const i = q % c.width, k = (q - i) / c.width; const tr = s.truth(chart.origin[0] + (crop0[0] + i + 0.5) * 0.05, chart.origin[2] + (crop0[1] + k + 0.5) * 0.05); rgba.set(tr, q * 4); }
            return { rgba, model: 'stand-in (scene truth)' };
        };
        const ir = (await infillRegions({ scan, regions: [{ ...spec, chart }], params: noContinuation, inpaint: perfect })).regions[0];
        expect(ir.attempts.find(a => a.rung === 'library material')!.reason).toMatch(/no library material/);
        expect(accepted(ir)).toEqual(['generative inpaint']);
        expect(ir.shares.generated).toBe(1);
        // nothing at all: the membrane, honestly reported as not passing
        const refused: InfillInpainter = async () => ({ refused: 'the image model is not configured' });
        const mr = (await infillRegions({ scan, regions: [regionOf(s, lump, 2)], params: noContinuation, inpaint: refused })).regions[0];
        expect(mr.gatePassed).toBe(false);
        expect(mr.attempts.map(a => a.rung)).toContain('membrane fill');
        expect(mr.attempts.find(a => a.rung === 'generative inpaint')!.reason).toMatch(/not configured/);
        expect(mr.shares.generated).toBe(1);
        expect(mr.reason).toMatch(/no rung that passed/);
    }, 300_000);
});

describe('surface infill: the GLB', () => {
    it('settles the lump onto the rebuilt street, keeps the kerb and every vertex outside, repaints the texels, and opens no edge', async () => {
        const s = kerbStreet, glb = sceneGlb(s), scan = readTileTriangles(glb);
        const lump = s.lumps[0];
        const out = await infillRegions({ scan, regions: [regionOf(s, lump, 0)] });
        const r = out.regions[0];
        expect(r.model.kind).toBe('stepped');
        const { glb: written, stats } = applyInfillToGlb(glb, out.regions, { moveVertices: true, paint: true, extras: infillExtras(out.regions, 'test') });
        expect(stats.movedVertices).toBeGreaterThan(50);
        expect(stats.paintedTexels).toBeGreaterThan(1000);
        const before = parseGlbBytes(glb), after = parseGlbBytes(written);
        const P0 = readAccessor(before, 0).data, P1 = readAccessor(after, 0).data;
        const I0 = readAccessor(before, 3).data, I1 = readAccessor(after, 3).data;
        expect(Array.from(I1)).toEqual(Array.from(I0));
        let insideWorst = 0, kept = 0, changedOutside = 0;
        for (let v = 0; v < P0.length / 3; v++) {
            const x = P0[v * 3], z = P0[v * 3 + 2];
            const [a, b] = toChart(r.chart, x, 0, z), i = Math.floor(a / r.chart.texelM), k = Math.floor(b / r.chart.texelM);
            const inside = i >= 0 && k >= 0 && i < r.chart.width && k < r.chart.height && r.target[k * r.chart.width + i] === 1;
            if (inside) {
                // the kerb itself (a vertex within a grid step of it) is the mesh's own slope; elsewhere the level it stands on
                if (Math.abs(z - KERB_Z) > 0.3) insideWorst = Math.max(insideWorst, Math.abs(P1[v * 3 + 1] - s.ground(x, z)));
            } else { kept++; if (P1[v * 3 + 1] !== P0[v * 3 + 1] || P1[v * 3] !== P0[v * 3]) changedOutside++; }
        }
        expect(insideWorst).toBeLessThan(0.03);
        expect(changedOutside).toBe(0);
        expect(kept).toBeGreaterThan(10_000);
        // the kerb under the van: road one side, sidewalk the other, the full rise between
        const at = (x: number, z: number) => { let best = Infinity, y = NaN; for (let v = 0; v < P1.length / 3; v++) { const d = Math.hypot(P1[v * 3] - x, P1[v * 3 + 2] - z); if (d < best) { best = d; y = P1[v * 3 + 1]; } } return y; };
        expect(at(0, 2.5) - at(0, 1.5)).toBeGreaterThan(KERB_RISE - 0.03);
        // no van colour left in the texture over the region
        const img = decodeImageInMemory(after.bin.subarray(after.json.bufferViews[after.json.images[0].bufferView].byteOffset, after.json.bufferViews[after.json.images[0].bufferView].byteOffset + after.json.bufferViews[after.json.images[0].bufferView].byteLength));
        let white = 0;
        for (let k = 0; k < img.height; k++) for (let i = 0; i < img.width; i++) {
            const x = -HALF + ((i + 0.5) / img.width) * 2 * HALF, z = -HALF + ((k + 0.5) / img.height) * 2 * HALF;
            if (((x - lump.cx) / lump.ax) ** 2 + ((z - lump.cz) / lump.az) ** 2 >= 1) continue;
            const q = (k * img.width + i) * 4;
            if (img.rgba[q] > 215 && img.rgba[q + 2] > 225) white++;
        }
        expect(white).toBe(0);
        expect(after.json.extras.sbInfill.regions[0].geometry.label).toBe('generated');
        expect(after.json.extras.sbInfill.regions[0].texture.shares).toEqual(r.shares);
        expect(r.label.some(v => v === INFILL_LABEL.photoInferred || v === INFILL_LABEL.generated)).toBe(true);
    }, 300_000);

    it('turns a plan cell mask into hole triangles on the surface', () => {
        const t = cellsToTriangles([0, 3, 5], 4, 10, 20, 0.5, (x, z) => x + z);
        expect(t.length).toBe(3 * 18);
        expect(t[0]).toBe(10); expect(t[2]).toBe(20); expect(t[1]).toBe(30);
    });
});
