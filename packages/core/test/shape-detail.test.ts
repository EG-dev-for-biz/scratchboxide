/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { assembleGlb, parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { composeShapeDetail, keepTriangles, measureShapeFit, PointGrid, readTriangles, sampleTriangles, SHAPE_DETAIL_PARAMS } from '../src/node/3d-engine/staged-location/shape-detail';

type V3 = [number, number, number];
/** A mesh builder: flat panels meshed at 1 m, each wound so its normal is `n`. */
class Mesh {
    pos: number[] = []; idx: number[] = [];
    panel(o: V3, u: V3, v: V3, n: V3, skip?: (p: V3) => boolean): this {
        const lu = Math.hypot(...u), lv = Math.hypot(...v), nu = Math.max(1, Math.round(lu)), nv = Math.max(1, Math.round(lv));
        const cross: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], flip = cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2] < 0;
        for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
            const at = (a: number, b: number): V3 => [o[0] + (u[0] * a) / nu + (v[0] * b) / nv, o[1] + (u[1] * a) / nu + (v[1] * b) / nv, o[2] + (u[2] * a) / nu + (v[2] * b) / nv];
            if (skip?.(at(i + 0.5, j + 0.5))) continue;
            const base = this.pos.length / 3;
            for (const p of [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]) this.pos.push(...p);
            this.idx.push(...(flip ? [base, base + 2, base + 1, base, base + 3, base + 2] : [base, base + 1, base + 2, base, base + 2, base + 3]));
        }
        return this;
    }
    box(lo: V3, hi: V3, skip?: (p: V3) => boolean, bottom = false): this {
        const [x0, y0, z0] = lo, [x1, y1, z1] = hi;
        this.panel([x0, y0, z0], [0, 0, z1 - z0], [0, y1 - y0, 0], [-1, 0, 0], skip).panel([x1, y0, z0], [0, 0, z1 - z0], [0, y1 - y0, 0], [1, 0, 0], skip);
        this.panel([x0, y0, z0], [x1 - x0, 0, 0], [0, y1 - y0, 0], [0, 0, -1], skip).panel([x0, y0, z1], [x1 - x0, 0, 0], [0, y1 - y0, 0], [0, 0, 1], skip);
        this.panel([x0, y1, z0], [x1 - x0, 0, 0], [0, 0, z1 - z0], [0, 1, 0], skip);
        if (bottom) this.panel([x0, y0, z0], [x1 - x0, 0, 0], [0, 0, z1 - z0], [0, -1, 0], skip);
        return this;
    }
    glb(): Buffer {
        const P = new Float32Array(this.pos), I = new Uint32Array(this.idx), bin = new Uint8Array(P.byteLength + I.byteLength);
        bin.set(new Uint8Array(P.buffer), 0); bin.set(new Uint8Array(I.buffer), P.byteLength);
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < P.length; i++) { lo[i % 3] = Math.min(lo[i % 3], P[i]); hi[i % 3] = Math.max(hi[i % 3], P[i]); }
        return assembleGlb({
            asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'surface', mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
            accessors: [{ bufferView: 0, componentType: 5126, count: P.length / 3, type: 'VEC3', min: lo, max: hi }, { bufferView: 1, componentType: 5125, count: I.length, type: 'SCALAR' }],
            bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: P.byteLength }, { buffer: 0, byteOffset: P.byteLength, byteLength: I.byteLength }], buffers: [{ byteLength: bin.byteLength }]
        }, bin);
    }
}

// the clean shape: a block 20 x 10 m in plan, 30 m tall
const shape = () => new Mesh().box([0, 0, 0], [20, 30, 10]).glb();
// its scan: the same block 5 cm fat, with a slab standing 2 m out of one wall, a pocket 2 m deep in the opposite wall, and a
// cut face inside it that no one can see
const inPocket = (p: V3) => p[0] < 0.2 && p[2] > 3 && p[2] < 7 && p[1] > 5 && p[1] < 15;
const scan = () => {
    const m = new Mesh().box([-0.05, 0, -0.05], [20.05, 30.05, 10.05], inPocket);
    m.box([20, 10, 4], [22, 20, 6], p => p[0] < 20.2, true);                              // the slab (its face against the wall left out)
    m.panel([2, 5, 3], [0, 0, 4], [0, 10, 0], [-1, 0, 0]);                                // the pocket's back
    m.panel([0, 5, 3], [2, 0, 0], [0, 10, 0], [0, 0, 1]).panel([0, 5, 7], [2, 0, 0], [0, 10, 0], [0, 0, -1]);
    m.panel([0, 5, 3], [2, 0, 0], [0, 0, 4], [0, 1, 0]).panel([0, 15, 3], [2, 0, 0], [0, 0, 4], [0, -1, 0]);
    m.panel([4, 12, 1], [12, 0, 0], [0, 0, 8], [0, 1, 0]);                                 // a cut face deep inside
    return m.glb();
};

describe('detail from the scan on a clean shape', () => {
    it('samples evenly and finds the nearest point', () => {
        const t = readTriangles(shape());
        expect(t.count).toBe(2 * (2 * 10 * 30 + 2 * 20 * 30 + 20 * 10));
        const s = sampleTriangles(t, 0.5, 100);
        expect(s.count).toBe(t.count * 2);                                               // half a square metre a triangle, a quarter a sample
        const g = new PointGrid(s.p, s.count, 1);
        const q = g.nearest(-1, 15, 5, 3);
        expect(q.d).toBeGreaterThan(0.99); expect(q.d).toBeLessThan(1.3);
        expect(g.nearest(-10, 15, 5, 3).i).toBe(-1);
    });

    it('sorts the scan: explained by the shape, standing off it, and never seen', () => {
        const fit = measureShapeFit(scan(), shape());
        // the slab's 5 faces and the pocket's 5 stand off the shape; the cut face inside (96 m2) is buried, with a voxel's
        // width of the surfaces round the pocket's mouth
        expect(fit.buriedM2).toBeGreaterThan(90); expect(fit.buriedM2).toBeLessThan(125);
        expect(fit.nearShare).toBeGreaterThan(0.85); expect(fit.nearShare).toBeLessThan(0.97);
        expect(fit.geometryShare).toBeGreaterThan(0.03);
        expect(fit.bands.length).toBe(SHAPE_DETAIL_PARAMS.bands);
        expect(fit.bands.reduce((a, b) => a + b.seenM2, 0)).toBeGreaterThan(fit.seenM2 - 10);
        // the shape with nothing wrong with it explains all of itself
        const same = measureShapeFit(shape(), shape());
        expect(same.nearShare).toBe(1); expect(same.buriedM2).toBe(0); expect(same.supportedShare).toBe(1);
    });

    it('keeps the slab and the pocket as scanned, opens the shape over the pocket, and drops the rest of the scan', () => {
        const { glb, report } = composeShapeDetail(shape(), scan());
        expect(report.scanKept.outsideM2).toBeGreaterThan(50);                             // the slab: 4 faces of 20 m2 less its foot, and its top
        expect(report.scanKept.recessM2).toBeGreaterThan(40);                              // the pocket: its back (40 m2) and returns
        expect(report.scanDropped.buriedM2).toBeGreaterThan(80);
        expect(report.shapeRemoved.m2).toBeGreaterThan(25); expect(report.shapeRemoved.m2).toBeLessThanOrEqual(48);   // the wall over the pocket
        expect(report.reproducedShare).toBeGreaterThan(0.97);
        expect(report.reproducedShare).toBeGreaterThan(report.fit.nearShare);
        // the result holds the shape's kept triangles and the scan's kept ones, the scan's said to be measured
        const out = parseGlbBytes(glb), all = readTriangles(glb);
        expect(all.count).toBe(report.triangles);
        expect(out.json.nodes.some((n: any) => n.extras?.sb?.provenance === 'measured')).toBe(true);
        // a point on the slab's outer face and one on the pocket's back are in the result; the cut face inside is not
        const s = sampleTriangles(all, 0.4, 100), g = new PointGrid(s.p, s.count, 1);
        expect(g.nearest(22, 15, 5, 0.3).i).toBeGreaterThanOrEqual(0);
        expect(g.nearest(2, 10, 5, 0.3).i).toBeGreaterThanOrEqual(0);
        expect(g.nearest(10, 12, 5, 0.6).i).toBe(-1);
        // and the wall no longer stands in front of the pocket
        expect(g.nearest(0, 10, 5, 0.4).i).toBe(-1);
    });

    it('removes a plate of the shape standing proud of the scan, and keeps the shape across a hole in the scan', () => {
        // the shape carries a 6 x 6 m plate 2 m in front of its +x wall; the scan is the plain block with a 3 x 3 m hole in its -x wall
        const withPlate = new Mesh().box([0, 0, 0], [20, 30, 10]).panel([22, 10, 2], [0, 0, 6], [0, 6, 0], [1, 0, 0]).glb();
        const holed = new Mesh().box([0, 0, 0], [20, 30, 10], p => p[0] < 0.2 && p[1] > 20 && p[1] < 23 && p[2] > 3 && p[2] < 6).glb();
        const { report } = composeShapeDetail(withPlate, holed);
        expect(report.shapeRemoved.proudM2).toBeGreaterThan(30); expect(report.shapeRemoved.proudM2).toBeLessThanOrEqual(36.01);
        expect(report.shapeRemoved.m2).toBeCloseTo(report.shapeRemoved.proudM2, 1);
        expect(report.regions.cells).toBe(0);
    });
    it('leaves a shape that explains its scan untouched, and filters triangles by mask', () => {
        const { report } = composeShapeDetail(shape(), shape());
        expect(report.scanKept.triangles).toBe(0); expect(report.shapeRemoved.triangles).toBe(0); expect(report.reproducedShare).toBe(1);
        const t = readTriangles(shape()), mask = new Uint8Array(t.count); mask[0] = 1; mask[5] = 1;
        const cut = keepTriangles(shape(), mask);
        expect(cut.kept).toBe(2); expect(readTriangles(cut.glb).count).toBe(2);
        expect(keepTriangles(shape(), new Uint8Array(t.count)).kept).toBe(0);
    });
});
