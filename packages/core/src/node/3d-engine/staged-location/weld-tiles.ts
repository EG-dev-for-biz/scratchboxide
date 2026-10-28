/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The tile extraction welded at its seams, as soon as it arrives. Google's leaf tiles come as separate meshes whose edges meet
 * without sharing vertices: the clay shows a dark crack along every tile edge and a band of shading where each tile averaged
 * its normals on its own. Here:
 *  - every tile's triangles are taken into one mesh in the scene's frame (node transforms applied);
 *  - vertices within weldM are one (a grid hash with its neighbouring cells), and triangles that collapse are dropped;
 *  - normals are averaged across the old seams but not across a crease: at each corner, the area-weighted normals of the
 *    faces around the vertex that turn less than creaseDeg from the corner's own face.
 * Geometry is moved by at most weldM: the welded copy stays the measured scan (the raw extraction is kept as it came).
 */

import { assembleGlb, nodeWorldMatrices, parseGlbBytes, readAccessor, transformPoint } from './glb-bytes';

export const WELD_TILES_VERSION = 'weld-tiles/1';

export const WELD_TILES = { weldM: 0.01, creaseDeg: 30 };

export interface WeldTilesReport { version: string; meshesIn: number; verticesIn: number; verticesWelded: number; trianglesIn: number; trianglesOut: number; weldM: number }

export function weldTilesGlb(bytes: Uint8Array, P = WELD_TILES): { glb: Buffer; report: WeldTilesReport } {
    const glb = parseGlbBytes(bytes);
    const json = glb.json;
    const world = nodeWorldMatrices(json);
    const report: WeldTilesReport = { version: WELD_TILES_VERSION, meshesIn: 0, verticesIn: 0, verticesWelded: 0, trianglesIn: 0, trianglesOut: 0, weldM: P.weldM };
    // the welded vertices, found by a grid hash of cell weldM (a match within weldM lies in this or a neighbouring cell)
    const pos: number[] = [];
    const grid = new Map<string, number[]>();
    const cell = (v: number) => Math.floor(v / P.weldM);
    const weld = (p: [number, number, number]): number => {
        const cx = cell(p[0]), cy = cell(p[1]), cz = cell(p[2]);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
            for (const i of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) if (Math.hypot(pos[i * 3] - p[0], pos[i * 3 + 1] - p[1], pos[i * 3 + 2] - p[2]) <= P.weldM) return i;
        }
        const i = pos.length / 3;
        pos.push(p[0], p[1], p[2]);
        const k = `${cx},${cy},${cz}`;
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
        return i;
    };
    const tris: number[] = [];
    (json.nodes ?? []).forEach((n: any, ni: number) => {
        if (n.mesh === undefined) return;
        const m = world[ni];
        const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
        for (const pr of json.meshes[n.mesh]?.primitives ?? []) {
            if ((pr.mode ?? 4) !== 4 || pr.attributes?.POSITION === undefined) continue;
            report.meshesIn++;
            const P3 = readAccessor(glb, pr.attributes.POSITION).data;
            const I = pr.indices !== undefined ? readAccessor(glb, pr.indices).data : Float64Array.from({ length: P3.length / 3 }, (_, i) => i);
            report.verticesIn += P3.length / 3;
            const ids = Array.from({ length: P3.length / 3 }, (_, v) => weld(transformPoint(m, P3[v * 3], P3[v * 3 + 1], P3[v * 3 + 2]) as [number, number, number]));
            for (let t = 0; t + 2 < I.length; t += 3) {
                report.trianglesIn++;
                // a mirroring transform turns the winding over
                const [a, b, c] = det < 0 ? [ids[I[t]], ids[I[t + 2]], ids[I[t + 1]]] : [ids[I[t]], ids[I[t + 1]], ids[I[t + 2]]];
                if (a !== b && b !== c && a !== c) tris.push(a, b, c);
            }
        }
    });
    report.verticesWelded = pos.length / 3;
    // face normals (area-weighted: the cross product's length is twice the area)
    const nf = tris.length / 3, fn = new Float64Array(nf * 3);
    const around: number[][] = Array.from({ length: pos.length / 3 }, () => []);
    for (let f = 0; f < nf; f++) {
        const [a, b, c] = [tris[f * 3], tris[f * 3 + 1], tris[f * 3 + 2]];
        const u = [pos[b * 3] - pos[a * 3], pos[b * 3 + 1] - pos[a * 3 + 1], pos[b * 3 + 2] - pos[a * 3 + 2]], v = [pos[c * 3] - pos[a * 3], pos[c * 3 + 1] - pos[a * 3 + 1], pos[c * 3 + 2] - pos[a * 3 + 2]];
        fn.set([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], f * 3);
        around[a].push(f); around[b].push(f); around[c].push(f);
    }
    const unit = (x: number, y: number, z: number) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
    const cosCrease = Math.cos((P.creaseDeg * Math.PI) / 180);
    // corners: one output vertex per welded vertex and smoothing group, shared by corners whose normals agree
    const outPos: number[] = [], outNrm: number[] = [], outIdx: number[] = [];
    const corner = new Map<string, number>();
    for (let f = 0; f < nf; f++) {
        const own = unit(fn[f * 3], fn[f * 3 + 1], fn[f * 3 + 2]);
        for (let k = 0; k < 3; k++) {
            const v = tris[f * 3 + k];
            let x = 0, y = 0, z = 0;
            for (const g of around[v]) {
                const n = unit(fn[g * 3], fn[g * 3 + 1], fn[g * 3 + 2]);
                if (n[0] * own[0] + n[1] * own[1] + n[2] * own[2] >= cosCrease) { x += fn[g * 3]; y += fn[g * 3 + 1]; z += fn[g * 3 + 2]; }
            }
            const n = unit(x, y, z);
            const key = `${v}|${Math.round(n[0] * 1000)},${Math.round(n[1] * 1000)},${Math.round(n[2] * 1000)}`;
            let o = corner.get(key);
            if (o === undefined) { o = outPos.length / 3; corner.set(key, o); outPos.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); outNrm.push(n[0], n[1], n[2]); }
            outIdx.push(o);
        }
    }
    report.trianglesOut = nf;
    // one node, one mesh, one primitive; the source's first material kept when it has one
    const P32 = Float32Array.from(outPos), N32 = Float32Array.from(outNrm), I32 = Uint32Array.from(outIdx);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P32.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], P32[i + k]); max[k] = Math.max(max[k], P32[i + k]); }
    const parts = [P32, N32, I32].map(a => new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    const bin = new Uint8Array(parts.reduce((s, b) => s + b.length, 0));
    let o = 0;
    const views = parts.map((b, i) => { bin.set(b, o); const v = { buffer: 0, byteOffset: o, byteLength: b.length, target: i < 2 ? 34962 : 34963 }; o += b.length; return v; });
    const material = json.materials?.[0];
    const out = {
        asset: json.asset ?? { version: '2.0' }, scene: 0,
        scenes: [{ nodes: [0], ...(json.scenes?.[json.scene ?? 0]?.extras ? { extras: json.scenes[json.scene ?? 0].extras } : {}) }],
        nodes: [{ name: 'TilesWelded', mesh: 0, extras: { sbWeldTiles: report } }],
        meshes: [{ name: 'tiles_welded', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, mode: 4, ...(material ? { material: 0 } : {}) }] }],
        ...(material ? { materials: [material] } : {}),
        accessors: [
            { bufferView: 0, componentType: 5126, count: P32.length / 3, type: 'VEC3', min, max },
            { bufferView: 1, componentType: 5126, count: N32.length / 3, type: 'VEC3' },
            { bufferView: 2, componentType: 5125, count: I32.length, type: 'SCALAR' }
        ],
        bufferViews: views, buffers: [{ byteLength: bin.length }]
    };
    return { glb: assembleGlb(out, bin), report };
}
