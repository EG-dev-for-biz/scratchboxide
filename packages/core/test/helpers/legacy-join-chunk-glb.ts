/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The chunk join as it ran on the laptop's main thread until the cut moved into the chunk job (district-chunks.ts
 * joinChunkGlb at main 01a171db), frozen verbatim: the parity tests hold the job's cut, the laptop's placement and the
 * compaction to the geometry, placement and extras this gave. Never edited; never imported by the app.
 */

import { assembleGlb, nodeWorldMatrices, parseGlbBytes, readAccessor, transformPoint, type Mat4 } from '../../src/node/3d-engine/staged-location/glb-bytes';

const multiply = (a: Mat4, b: Mat4): Mat4 => {
    const o: Mat4 = new Float64Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; }
    return o;
};

export interface LegacyJoinReport { keptTriangles: number; removedTriangles: number; pieces?: { kept: number; removed: number } }

export function legacyJoinChunkGlb(bytes: Uint8Array, transform: Mat4, keep: (x: number, z: number) => boolean, opts: { whole?: boolean; /** false: the transform on a root node, the vertices as they were. */ bake?: boolean } = {}): { glb: Buffer } & LegacyJoinReport {
    const glb = parseGlbBytes(bytes);
    const json = glb.json;
    const local = nodeWorldMatrices(json);
    const extra: Uint8Array[] = [];
    let binLength = glb.bin.byteLength + ((4 - (glb.bin.byteLength % 4)) % 4);
    let removed = 0, kept = 0, piecesKept = 0, piecesRemoved = 0;
    // a mesh drawn by several nodes is cut once, by the first node that draws it
    const done = new Set<number>();
    (json.nodes ?? []).forEach((node: any, ni: number) => {
        if (node.mesh === undefined || done.has(node.mesh)) return;
        done.add(node.mesh);
        const m = multiply(transform, local[ni]);
        for (const prim of json.meshes?.[node.mesh]?.primitives ?? []) {
            if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
            const pos = readAccessor(glb, prim.attributes.POSITION).data;
            const idx = prim.indices !== undefined ? readAccessor(glb, prim.indices).data : undefined;
            const count = idx ? idx.length : pos.length / 3;
            const vi = (t: number) => (idx ? idx[t] : t);
            const keepTri = new Uint8Array(count / 3);
            if (opts.whole) {
                // connected pieces (shared vertices), each kept or cut as one, by its middle
                const parent = new Int32Array(pos.length / 3).map((_, i) => i);
                const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
                for (let t = 0; t + 2 < count; t += 3) { const r = find(vi(t)); parent[find(vi(t + 1))] = r; parent[find(vi(t + 2))] = r; }
                const sum = new Map<number, [number, number, number]>();
                for (let t = 0; t + 2 < count; t += 3) {
                    const r = find(vi(t)), s = sum.get(r) ?? [0, 0, 0];
                    for (let k = 0; k < 3; k++) { const v = vi(t + k); s[0] += pos[v * 3]; s[1] += pos[v * 3 + 2]; }
                    s[2] += 3; sum.set(r, s);
                }
                const verdict = new Map<number, boolean>();
                for (const [r, s] of sum) {
                    const w = transformPoint(m, s[0] / s[2], 0, s[1] / s[2]);
                    const k = keep(w[0], w[2]);
                    verdict.set(r, k);
                    if (k) piecesKept++; else piecesRemoved++;
                }
                for (let t = 0; t + 2 < count; t += 3) keepTri[t / 3] = verdict.get(find(vi(t))) ? 1 : 0;
            } else {
                // a triangle that reaches what `keep` gives (its middle or any corner) is kept whole: a long one whose middle lies
                // past the band but which covers ground the chunk keeps would otherwise leave a hole there that only the
                // neighbour covered; the seam stage cuts what lies past the line (district-seams.ts)
                const corner = new Int8Array(pos.length / 3).fill(-1);
                const kept = (v: number) => { if (corner[v] < 0) { const w = transformPoint(m, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); corner[v] = keep(w[0], w[2]) ? 1 : 0; } return corner[v] === 1; };
                for (let t = 0; t + 2 < count; t += 3) {
                    const a = vi(t), b = vi(t + 1), c = vi(t + 2);
                    const w = transformPoint(m, (pos[a * 3] + pos[b * 3] + pos[c * 3]) / 3, (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1]) / 3, (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3);
                    keepTri[t / 3] = keep(w[0], w[2]) || kept(a) || kept(b) || kept(c) ? 1 : 0;
                }
            }
            const out: number[] = [];
            for (let t = 0; t + 2 < count; t += 3) if (keepTri[t / 3]) out.push(vi(t), vi(t + 1), vi(t + 2));
            const cut = count / 3 - out.length / 3;
            removed += cut; kept += out.length / 3;
            if (!cut) continue;
            const data = new Uint8Array(new Uint32Array(out).buffer);
            json.bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: data.byteLength, target: 34963 });
            json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5125, count: out.length, type: 'SCALAR' });
            prim.indices = json.accessors.length - 1;
            extra.push(data);
            binLength += data.byteLength + ((4 - (data.byteLength % 4)) % 4);
        }
    });
    // the district's frame: baked into the vertices when every mesh is drawn by one node (the seam weld reads positions,
    // never node transforms), else on a new root over the scene's roots (instanced meshes: trees, never welded)
    const users = new Map<number, number>();
    for (const n of json.nodes ?? []) if (n.mesh !== undefined) users.set(n.mesh, (users.get(n.mesh) ?? 0) + 1);
    const bake = opts.bake !== false && [...users.values()].every(c => c === 1);
    const scene = json.scenes?.[json.scene ?? 0];
    if (bake) {
        const baked = new Map<string, number>();
        (json.nodes ?? []).forEach((node: any, ni: number) => {
            if (node.mesh === undefined) return;
            const m = multiply(transform, local[ni]);
            for (const prim of json.meshes?.[node.mesh]?.primitives ?? []) for (const attr of ['POSITION', 'NORMAL'] as const) {
                const acc = prim.attributes?.[attr];
                if (acc === undefined) continue;
                const key = `${attr}:${acc}:${ni}`;
                if (baked.has(key)) { prim.attributes[attr] = baked.get(key); continue; }
                const src = readAccessor(glb, acc).data, out = new Float32Array(src.length);
                const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
                for (let v = 0; v + 2 < src.length; v += 3) {
                    let q: number[];
                    if (attr === 'POSITION') q = transformPoint(m, src[v], src[v + 1], src[v + 2]);
                    else {
                        // a rigid transform: the normal turns by its rotation
                        q = [m[0] * src[v] + m[4] * src[v + 1] + m[8] * src[v + 2], m[1] * src[v] + m[5] * src[v + 1] + m[9] * src[v + 2], m[2] * src[v] + m[6] * src[v + 1] + m[10] * src[v + 2]];
                        const l = Math.hypot(q[0], q[1], q[2]) || 1; q = q.map(x => x / l);
                    }
                    for (let k = 0; k < 3; k++) { out[v + k] = q[k]; lo[k] = Math.min(lo[k], q[k]); hi[k] = Math.max(hi[k], q[k]); }
                }
                const data = new Uint8Array(out.buffer);
                json.bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: data.byteLength, target: 34962 });
                json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5126, count: out.length / 3, type: 'VEC3', ...(attr === 'POSITION' ? { min: lo, max: hi } : {}) });
                prim.attributes[attr] = json.accessors.length - 1;
                baked.set(key, json.accessors.length - 1);
                extra.push(data);
                binLength += data.byteLength + ((4 - (data.byteLength % 4)) % 4);
            }
        });
        for (const n of json.nodes ?? []) { delete n.matrix; delete n.translation; delete n.rotation; delete n.scale; }
    } else if (scene) {
        json.nodes.push({ name: 'district_frame', matrix: Array.from(transform), children: scene.nodes ?? [] });
        scene.nodes = [json.nodes.length - 1];
    }
    const bin = new Uint8Array(binLength);
    bin.set(glb.bin, 0);
    let o = glb.bin.byteLength + ((4 - (glb.bin.byteLength % 4)) % 4);
    for (const e of extra) { bin.set(e, o); o += e.byteLength + ((4 - (e.byteLength % 4)) % 4); }
    if (json.buffers?.[0]) json.buffers[0].byteLength = binLength;
    return { glb: assembleGlb(json, bin), keptTriangles: kept, removedTriangles: removed, ...(opts.whole ? { pieces: { kept: piecesKept, removed: piecesRemoved } } : {}) };
}
