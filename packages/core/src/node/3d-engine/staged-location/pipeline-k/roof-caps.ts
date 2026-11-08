/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Seal caps over a roof, out of the textured twin. The seal (lattice-stitch.ts fillOpenLoops) closes every open loop left,
 * a rebuilt facade's top rim included, with a flat cap in its best-fitting plane. Where that cap faces up and a roof (any
 * other surface facing up) lies close beneath it, the cap closes no visible hole: the roof under it already does, with its
 * photo. Drawn in the twin it hides that photo under an untextured lid (Lever House, 2026-11-08: 222 m² of clay cap over
 * the shaft's roof, seen from every raised view). Such caps are left out of the textured twin; the clay keeps every
 * triangle, so the shell stays closed. The seal's own skin test (skinM) leaves out fill within half a metre of a surface;
 * this reads further down, and only straight down, for caps facing up.
 */

import { accessorLayout, assembleGlb, nodeWorldMatrices, parseGlbBytes, readAccessor, transformPoint } from '../glb-bytes';

export const ROOF_CAPS_VERSION = 'roof-caps/1';

export const ROOF_CAPS_PARAMS = {
    /** A triangle faces up when its normal's vertical component is at least this. */
    upMin: 0.7,
    /** A roof this far below a cap (m), or less, lies under it; nearer than skinM the seal's own test already left it out. */
    belowM: 3,
    /** A cap is over a roof when at least this share of its probes (its centroid and its edges' midpoints) is. */
    share: 0.75,
    /** The plan grid's cell (m). */
    cellM: 1
};
export type RoofCapsParams = typeof ROOF_CAPS_PARAMS;

export interface RoofCapsReport { version: string; capsDropped: number; areaM2: number; capsKept: number }

type V = [number, number, number];

/** The seal's caps over a roof made degenerate in the textured twin; every other triangle as it was. */
export function dropRoofCaps(bytes: Uint8Array, P: RoofCapsParams = ROOF_CAPS_PARAMS): { glb: Buffer; report: RoofCapsReport } {
    const report: RoofCapsReport = { version: ROOF_CAPS_VERSION, capsDropped: 0, areaM2: 0, capsKept: 0 };
    const g = parseGlbBytes(Buffer.from(bytes)), json = g.json, world = nodeWorldMatrices(json);
    const dv = new DataView(g.bin.buffer, g.bin.byteOffset, g.bin.byteLength);
    const nodes: any[] = json.nodes ?? [];
    if (!nodes.some(n => n.name === 'Seal')) return { glb: Buffer.from(bytes), report };
    // every other surface facing up, by plan cell
    const roofs: V[][] = [], grid = new Map<string, number[]>();
    const cell = (x: number, z: number) => `${Math.floor(x / P.cellM)},${Math.floor(z / P.cellM)}`;
    const trianglesOf = (n: any, ni: number, each: (tri: V[], t: number, prim: any) => void) => {
        for (const p of json.meshes?.[n.mesh]?.primitives ?? []) {
            if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined) continue;
            const X = readAccessor(g, p.attributes.POSITION).data, idx = p.indices !== undefined ? readAccessor(g, p.indices).data : Float64Array.from({ length: X.length / 3 }, (_, i) => i);
            for (let t = 0; t + 2 < idx.length; t += 3) each([0, 1, 2].map(k => transformPoint(world[ni], X[idx[t + k] * 3], X[idx[t + k] * 3 + 1], X[idx[t + k] * 3 + 2]) as V), t, p);
        }
    };
    const normalOf = (q: V[]) => { const a = [q[1][0] - q[0][0], q[1][1] - q[0][1], q[1][2] - q[0][2]], b = [q[2][0] - q[0][0], q[2][1] - q[0][1], q[2][2] - q[0][2]]; const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; const l = Math.hypot(c[0], c[1], c[2]); return { n: l > 0 ? [c[0] / l, c[1] / l, c[2] / l] : [0, 0, 0], area: l / 2 }; };
    nodes.forEach((n, ni) => {
        if (n.mesh === undefined || n.name === 'Seal') return;
        trianglesOf(n, ni, q => {
            if (normalOf(q).n[1] < P.upMin) return;
            const id = roofs.push(q) - 1;
            const x0 = Math.min(q[0][0], q[1][0], q[2][0]), x1 = Math.max(q[0][0], q[1][0], q[2][0]), z0 = Math.min(q[0][2], q[1][2], q[2][2]), z1 = Math.max(q[0][2], q[1][2], q[2][2]);
            if ((x1 - x0) * (z1 - z0) > 4000 * P.cellM * P.cellM) return;
            for (let x = Math.floor(x0 / P.cellM); x <= Math.floor(x1 / P.cellM); x++) for (let z = Math.floor(z0 / P.cellM); z <= Math.floor(z1 / P.cellM); z++) { const k = `${x},${z}`; const l = grid.get(k); if (l) l.push(id); else grid.set(k, [id]); }
        });
    });
    // a roof straight below a point, within belowM: the point inside its plan, its height there below the point's
    const roofBelow = (p: V): boolean => {
        for (const id of grid.get(cell(p[0], p[2])) ?? []) {
            const [a, b, c] = roofs[id];
            const d = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]);
            if (Math.abs(d) < 1e-12) continue;
            const w1 = ((b[0] - p[0]) * (c[2] - p[2]) - (c[0] - p[0]) * (b[2] - p[2])) / d, w2 = ((c[0] - p[0]) * (a[2] - p[2]) - (a[0] - p[0]) * (c[2] - p[2])) / d, w3 = 1 - w1 - w2;
            if (w1 < -1e-9 || w2 < -1e-9 || w3 < -1e-9) continue;
            const dy = p[1] - (w1 * a[1] + w2 * b[1] + w3 * c[1]);
            if (dy > 0 && dy <= P.belowM) return true;
        }
        return false;
    };
    nodes.forEach((n, ni) => {
        if (n.name !== 'Seal' || n.mesh === undefined) return;
        for (const p of json.meshes?.[n.mesh]?.primitives ?? []) {
            if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined || p.indices === undefined) continue;
            const X = readAccessor(g, p.attributes.POSITION).data, il = accessorLayout(json, p.indices);
            const size = il.componentType === 5125 ? 4 : il.componentType === 5123 ? 2 : 1;
            const rd = (i: number) => (size === 4 ? dv.getUint32(il.base + i * il.stride, true) : size === 2 ? dv.getUint16(il.base + i * il.stride, true) : dv.getUint8(il.base + i * il.stride));
            const wr = (i: number, v: number) => { if (size === 4) dv.setUint32(il.base + i * il.stride, v, true); else if (size === 2) dv.setUint16(il.base + i * il.stride, v, true); else dv.setUint8(il.base + i * il.stride, v); };
            for (let t = 0; t + 2 < il.count; t += 3) {
                const v = [rd(t), rd(t + 1), rd(t + 2)];
                if (v[0] === v[1] && v[1] === v[2]) continue;
                const q = v.map(i => transformPoint(world[ni], X[i * 3], X[i * 3 + 1], X[i * 3 + 2]) as V);
                const { n: nrm, area } = normalOf(q);
                if (nrm[1] < P.upMin) continue;
                const mid = (a: V, b: V): V => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
                const probes: V[] = [[(q[0][0] + q[1][0] + q[2][0]) / 3, (q[0][1] + q[1][1] + q[2][1]) / 3, (q[0][2] + q[1][2] + q[2][2]) / 3], mid(q[0], q[1]), mid(q[1], q[2]), mid(q[2], q[0])];
                if (probes.filter(roofBelow).length >= P.share * probes.length) { wr(t + 1, v[0]); wr(t + 2, v[0]); report.capsDropped++; report.areaM2 += area; }
                else report.capsKept++;
            }
        }
    });
    report.areaM2 = Math.round(report.areaM2 * 10) / 10;
    return { glb: report.capsDropped ? assembleGlb(json, g.bin) : Buffer.from(bytes), report };
}
