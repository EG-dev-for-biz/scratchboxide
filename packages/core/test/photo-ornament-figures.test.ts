/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Figures: the measured detection of compact scanned blobs on a fitted pedestal, the crops, the one batched reading,
 * the build constrained to the blob, and the smoothed-scan rung under it. A synthetic statue blob, a fake reading.
 */
import { describe, it, expect } from 'vitest';
import {
    constrainFigure, detectFigureBlobs, figureContents, FIGURE_CRITERIA, FIGURE_SCALE_LIMITS, footprintAxis, parseFigureReply, planFigureViews, smoothLump, type FigureBlob
} from '../src/node/3d-engine/staged-location/figures';
import { parseGlbNodes } from '../src/node/3d-engine/staged-location/glb-nodes';
import { structureFit } from './helpers/staged-location-fixtures';
import { figureGlb, figureSpec, figuresReply, lumpMesh } from './helpers/photo-ornament-fixtures';
import { buildObjectFromSpec } from '../src/node/3d-engine/reference-object-builder';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';

const bounds = (p: Float32Array) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[i + k]); hi[k] = Math.max(hi[k], p[i + k]); }
    return { lo, hi };
};
/** A pass-through region record for a mesh. */
const region = (id: string, m: { positions: Float32Array; indices: Uint32Array }) => {
    const b = bounds(m.positions);
    return { id, triangles: m.indices.length / 3, areaM2: 3, aabbMin: b.lo as [number, number, number], aabbMax: b.hi as [number, number, number], reason: 'not box-like' };
};
const pedestal = (id: string, ox: number, y: number, oz: number, w: number, d: number) => ({
    ...structureFit().surfaces[0], id, chart: { plane: { origin: [ox, y, oz] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 0, 1] as [number, number, number], normal: [0, 1, 0] as [number, number, number], extentUv: [[0, 0], [w, d]] as Array<[number, number]> } }
});

// a statue lump 0.9 wide x 2.4 tall x 0.7 deep standing on a pedestal top at y = 1.4 near the north face
const statue = lumpMesh(-4, 1.4, -7.5, 0.9, 2.4, 0.7, 0.08, 5);
const detect = (extra: Array<{ id: string; mesh: ReturnType<typeof lumpMesh> }> = [], surfaces = [pedestal('s90', -5.5, 1.4, -9, 3, 3)]) => {
    const fit = { ...structureFit(), surfaces: [...structureFit().surfaces, ...surfaces] };
    const all = [{ id: 'r2', mesh: statue }, ...extra];
    fit.passThrough = { ...fit.passThrough, regions: all.map(x => region(x.id, x.mesh)) };
    return detectFigureBlobs(fit, all.map(x => ({ name: x.id, positions: x.mesh.positions, indices: x.mesh.indices })));
};

describe('detecting figures by a measured criterion', () => {
    it('finds the compact scanned blob that stands on a fitted pedestal, with its measured bounds, pedestal and orientation', () => {
        const d = detect();
        expect(d.figures.map(f => f.regionId)).toEqual(['r2']);
        const f = d.figures[0];
        expect(f.heightM).toBeCloseTo(2.4, 1);
        expect(f.pedestal).toMatchObject({ surfaceId: 's90' });
        expect(f.pedestal.contactM).toBeLessThan(0.05);
        expect(f.baseAboveGroundM).toBeCloseTo(1.4, 1);
        expect(f.alongM).toBeGreaterThanOrEqual(f.acrossM);
        expect(f.centre[0]).toBeCloseTo(-4, 1);
    });

    it('a lump whose lower part is the pedestal\'s own top (the real arch: lump from 1.45 m, pedestal top at 2.53 m) is a figure from the pedestal top up', () => {
        const lump = lumpMesh(-5.2, 1.45, -8.45, 1.5, 4.3, 0.9, 0.05, 7); // spans y 1.45 .. 5.75
        const fit = { ...structureFit(), surfaces: [...structureFit().surfaces, pedestal('s101', -5.53, 2.53, -9.7, 1.2, 1.9)] };
        fit.passThrough = { ...fit.passThrough, regions: [region('x11', lump)] };
        const out = detectFigureBlobs(fit, [{ name: 'x11', positions: lump.positions, indices: lump.indices }]);
        expect(out.rejected).toEqual([]);
        const f = out.figures[0];
        expect(f.pedestal).toMatchObject({ surfaceId: 's101' });
        expect(f.min[1]).toBeCloseTo(2.53, 2);                       // the figure stands on the pedestal's top
        expect(f.heightM).toBeCloseTo(5.75 - 2.53, 1);                // and is what rises above it
        expect(f.baseAboveGroundM).toBeCloseTo(2.53, 1);
    });

    it('rejects, with the measured reason, what is too big, too squat, floating, at ground level, or not on a pedestal', () => {
        const tooBig = lumpMesh(8, 1.4, -7.5, 6, 3, 6, 0, 2);
        const squat = lumpMesh(-3, 1.4, -7, 3.4, 1.0, 3.4, 0, 3);
        const floating = lumpMesh(-4.2, 3.9, -7.5, 0.9, 2.4, 0.7, 0, 4);
        const onGround = lumpMesh(-4, 0, -7.5, 0.9, 2.4, 0.7, 0, 5);
        const noPedestal = lumpMesh(5, 1.4, 5, 0.9, 2.4, 0.7, 0, 6);
        const d = detect([{ id: 'big', mesh: tooBig }, { id: 'squat', mesh: squat }, { id: 'float', mesh: floating }, { id: 'ground', mesh: onGround }, { id: 'nopeds', mesh: noPedestal }], [pedestal('s90', -5.5, 1.4, -9, 3, 3), pedestal('sbig', 4, 1.4, -11, 8, 8), pedestal('ssq', -5, 1.4, -9, 4, 4)]);
        expect(d.figures.map(f => f.regionId)).toEqual(['r2']);
        const why = Object.fromEntries(d.rejected.map(r => [r.regionId, r.why]));
        expect(why.big).toMatch(/footprint 6\.\d+ m is outside/);
        expect(why.squat).toMatch(/not standing/);
        expect(why.float).toMatch(/does not stand on the top of a fitted surface/);
        expect(why.ground).toMatch(/base is 0\.\d+ m above the fitted ground/);
        expect(why.nopeds).toMatch(/does not stand on the top of a fitted surface/);
    });

    it('keeps at most four, the most detailed first, and uses no name or keyword anywhere in the criterion', () => {
        const six = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, mesh: lumpMesh(-5 + (i % 3) * 1, 1.4, -8.4 + Math.floor(i / 3) * 1.2, 0.5, 1.6, 0.4, 0.05, 10 + i) }));
        const d = detect(six, [pedestal('p', -6, 1.4, -9, 6, 3)]);
        expect(d.figures.length).toBe(FIGURE_CRITERIA.maxFigures);
        expect(d.rejected.some(r => /more than 4 figures/.test(r.why))).toBe(true);
        expect(JSON.stringify(FIGURE_CRITERIA)).not.toMatch(/statue|person|human|sculpture|figure(?!s)/i);
    });

    it('measures a footprint\'s principal axis and extents', () => {
        // an elongated footprint along a 30 degree compass bearing
        const pts: number[] = [];
        const a = 30 * Math.PI / 180;
        for (let i = -10; i <= 10; i++) for (const w of [-0.2, 0.2]) pts.push(3 + Math.sin(a) * i * 0.1 - Math.cos(a) * w, 0, 5 - Math.cos(a) * i * 0.1 - Math.sin(a) * w);
        const ax = footprintAxis(Float32Array.from(pts));
        expect(ax.axisDeg).toBeCloseTo(30, 0);
        expect(ax.alongM).toBeCloseTo(2.0, 1);
        expect(ax.acrossM).toBeCloseTo(0.4, 1);
    });
});

describe('the crops, the one reading and the constrained build', () => {
    const blob = (): FigureBlob => detect().figures[0];
    const GROUND = { cellIndex: () => -1, groundAt: () => 0 };
    const STRUCT = { cells: new Set<string>(), groundY: 0 };
    const pano = (id: string, x: number, z: number) => ({ panoId: id, lat: 0, lng: 0, x, z, date: '2025-06', copyright: '© Google' });

    it('takes the nearest pano that sees it (8-60 m), aimed up at the figure, fov 30-45, portrait; reports a figure no pano sees', () => {
        const { views, skipped } = planFigureViews([blob()], [pano('N1', -4, -33), pano('NEAR', -4, -9), pano('FAR', -4, -90)], STRUCT, GROUND, new Float32Array(0));
        expect(skipped).toEqual([]);
        expect(views).toHaveLength(1);
        expect(views[0]).toMatchObject({ regionId: 'r2', panoId: 'N1', aspectRatio: 'RATIO_3X4' });
        expect(views[0].fovDeg).toBeGreaterThanOrEqual(30); expect(views[0].fovDeg).toBeLessThanOrEqual(45);
        expect(views[0].pitchDeg).toBeGreaterThan(0);
        expect(planFigureViews([blob()], [pano('FAR', -4, -90)], STRUCT, GROUND, new Float32Array(0)).skipped[0].reason).toMatch(/no Google panorama between 8 and 60 m/);
    });

    it('asks for all figures in ONE prompt with the repo\'s spec conventions, the scan\'s bounds per figure and no names', () => {
        const b = blob();
        const view = planFigureViews([b], [pano('N1', -4, -33)], STRUCT, GROUND, new Float32Array(0)).views[0];
        const contents = figureContents([{ index: 0, blob: b, view, bytes: Buffer.from('x'), mimeType: 'image/jpeg', widthPx: 960, heightPx: 1280 }, { index: 1, blob: b, view, bytes: Buffer.from('y'), mimeType: 'image/jpeg', widthPx: 960, heightPx: 1280 }]);
        expect(contents).toHaveLength(1);
        const text = (contents[0].parts as any[]).filter(p => p.text).map(p => p.text).join('\n');
        expect((contents[0].parts as any[]).filter(p => p.inlineData)).toHaveLength(2);
        expect(text).toMatch(/Conventions/);
        expect(text).toMatch(/Metres\. \+Y up/);
        expect(text).toMatch(/lump for this figure measures 0\.\d+ × 0\.\d+ m on the ground and 2\.4\d? m tall/);
        expect(text).toMatch(/"figures"/);
    });

    it('parses a batched reply: a valid spec per image, a bad one reported for that image only', () => {
        const ok = parseFigureReply(JSON.stringify(figuresReply([0, 1])), 'STOP', 2);
        expect([...ok.readings.keys()]).toEqual([0, 1]);
        const bad = parseFigureReply(JSON.stringify({ figures: [{ image: 0, confidence: 80, spec: figureSpec() }, { image: 1, confidence: 80, spec: { nothing: true } }] }), 'STOP', 2);
        expect([...bad.readings.keys()]).toEqual([0]);
        expect(bad.problems.get(1)!.length).toBeGreaterThan(0);
        expect(() => parseFigureReply('{"figures":[', 'MAX_TOKENS', 1)).toThrow(/cut off/);
        expect(() => parseFigureReply('{}', 'STOP', 1)).toThrow(/no "figures" list/);
    });

    it('sets the built figure on the blob: its bounding box becomes the blob\'s, standing on the pedestal, front toward the camera', () => {
        const b = blob();
        const built = parseGlbNodes(figureGlb())[0];
        const eye: [number, number, number] = [-4, 2.5, -33];
        const f = constrainFigure(built, b, eye);
        expect(f.fits.min[1]).toBeCloseTo(b.min[1], 4);
        expect(f.fits.max[1] - f.fits.min[1]).toBeCloseTo(b.heightM, 1);
        const cx = (f.fits.min[0] + f.fits.max[0]) / 2, cz = (f.fits.min[2] + f.fits.max[2]) / 2;
        expect(cx).toBeCloseTo(b.centre[0], 1); expect(cz).toBeCloseTo(b.centre[2], 1);
        // the footprint extents are the blob's along/across, in some order
        const dims = [f.fits.max[0] - f.fits.min[0], f.fits.max[2] - f.fits.min[2]].sort();
        expect(dims[0]).toBeCloseTo(Math.min(b.alongM, b.acrossM), 0);
        // the front (+Z of the built figure, where it bulges toward a viewer) faces the camera: the eye is north, so the front points to -z
        expect(f.yawDeg === 0 || f.yawDeg === 180 || f.yawDeg > 0).toBe(true);
        for (const s of f.scale) { expect(s).toBeGreaterThanOrEqual(FIGURE_SCALE_LIMITS[0]); expect(s).toBeLessThanOrEqual(FIGURE_SCALE_LIMITS[1]); }
    });

    it('is a rotation, not a reflection: winding is kept and a nub on the figure\'s right stays on the viewer\'s right', () => {
        // a closed tetrahedron whose apex nub sits at local +x
        const positions = Float32Array.from([-1, 0, -1, -1, 0, 1, -1, 2, 0, 1, 0.5, 0]);
        const indices = Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]);
        const volume = (p: ArrayLike<number>, ix: Uint32Array): number => {
            let v = 0;
            for (let t = 0; t < ix.length; t += 3) {
                const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
                v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
            }
            return v / 6;
        };
        const b: FigureBlob = { ...blob(), axisDeg: 0, alongM: 1, acrossM: 1.5, heightM: 2, centre: [10, 1, 10], min: [9.25, 0, 9.5], max: [10.75, 2, 10.5] };
        const eye: [number, number, number] = [10, 1, 30]; // south of the figure, looking north (-z): the viewer's right is world +x
        const f = constrainFigure({ positions, indices }, b, eye);
        const before = volume(positions, indices), after = volume(f.positions, f.indices);
        expect(Math.abs(before)).toBeGreaterThan(0.1);
        expect(Math.sign(after)).toBe(Math.sign(before));
        // the nub (vertex 3) lies to the viewer's right of the figure's centre, which is world +x here
        expect(f.positions[9] - b.centre[0]).toBeGreaterThan(0.1);
    });

    it('rejects a spec that disagrees with the scan by more than a factor of two', () => {
        const b = { ...blob(), heightM: 7.0, min: [-4.5, 1.4, -7.9] as [number, number, number], max: [-3.5, 8.4, -7.1] as [number, number, number] };
        expect(() => constrainFigure(parseGlbNodes(figureGlb())[0], b, [-4, 2.5, -33])).toThrow(/spec disagrees with the scan/);
    });
});

describe('the rung under a figure: the scanned lump, smoothed inside the scan tolerance', () => {
    it('smooths a rough lump, moves no vertex further than the tolerance, and keeps its place on the pedestal', () => {
        const rough = lumpMesh(-4, 1.4, -7.5, 0.9, 2.4, 0.7, 0.3, 9);
        const roughness = (m: Float32Array) => {
            // deviation of each ring's radius from the mean radius of its ring
            let sum = 0, n = 0;
            const segs = 16;
            for (let i = 0; i < m.length / 3; i += segs) {
                const r = Array.from({ length: segs }, (_, j) => Math.hypot(m[(i + j) * 3] + 4, m[(i + j) * 3 + 2] + 7.5));
                const mean = r.reduce((a, b) => a + b, 0) / segs;
                for (const v of r) { sum += (v - mean) ** 2; n++; }
            }
            return Math.sqrt(sum / n);
        };
        const tol = 0.12;
        const s = smoothLump(rough, tol);
        expect(s.maxMoveM).toBeLessThanOrEqual(tol + 1e-6);
        let worst = 0;
        // the welded vertex order is the soup's first-seen order, which for an indexed grid is the grid's own
        for (let i = 0; i < rough.positions.length / 3; i++) worst = Math.max(worst, Math.hypot(s.positions[i * 3] - rough.positions[i * 3], s.positions[i * 3 + 1] - rough.positions[i * 3 + 1], s.positions[i * 3 + 2] - rough.positions[i * 3 + 2]));
        expect(worst).toBeLessThanOrEqual(tol + 1e-5);
        expect(roughness(s.positions)).toBeLessThan(roughness(rough.positions));
        const b = bounds(s.positions);
        expect(b.lo[1]).toBeGreaterThan(1.4 - tol - 1e-4);
    });

    it('a mesh with no connected surface cannot be smoothed and says so', () => {
        expect(() => smoothLump({ positions: new Float32Array([0, 0, 0]), indices: new Uint32Array([]) }, 0.1)).toThrow(/no connected surface/);
    });
});

describe('the default figure builder: the repo\'s native object build (real engine, no fake)', () => {
    const engineReady = (() => { try { return NativePythonRunnerService.getInstance().isNativeModuleFresh(); } catch { return false; } })();
    it.skipIf(!engineReady)('builds a figure spec natively and the result sets onto a blob\'s bounds', async () => {
        const built = await buildObjectFromSpec(figureSpec(), {});
        const nodes = parseGlbNodes(built.glb);
        expect(nodes.length).toBeGreaterThan(0);
        const positions = Float32Array.from(nodes.flatMap(n => Array.from(n.positions)));
        const indices = Uint32Array.from(nodes.flatMap((n, k) => { const off = nodes.slice(0, k).reduce((a, m) => a + m.positions.length / 3, 0); return Array.from(n.indices ?? [], v => v + off); }));
        expect(built.checks.connectivity.passed).toBe(true);
        const b = detect().figures[0];
        const f = constrainFigure({ positions, indices }, b, [-4, 2.5, -33]);
        expect(f.fits.min[1]).toBeCloseTo(b.min[1], 3);
        expect(f.fits.max[1] - f.fits.min[1]).toBeCloseTo(b.heightM, 1);
        expect(indices.length / 3).toBeGreaterThan(1000);
    }, 600_000);
});
