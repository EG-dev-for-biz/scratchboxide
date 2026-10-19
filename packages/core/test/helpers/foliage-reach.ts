/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * What a planted tree's delivered leaves reach of its measured crown, read from the trees GLB itself (it shares no code
 * with the native measurement it checks). A tree node's last primitive is its foliage: `clumps` leaf masses of equal
 * vertex and triangle count, one after the other. A crown surface sample is reached when it lies inside a mass (along
 * the ray from the mass's vertex centroid, the masses being stars around it) or within `reach` of one of its triangles.
 */

import { parseGlb, readAccessor } from './clay-glb-render';

export interface TreeFoliage {
    crownId: number;
    extras: any;
    positions: Float32Array;
    indices: Uint32Array;
}

/**
 * Every tree node's foliage primitive (positions in the tile frame and indices). Tree nodes sit under an untransformed
 * root; a quantised file (KHR_mesh_quantization) gives each its own translation and scale, applied here, with its
 * normalised positions read as glTF defines them.
 */
export function readTreeFoliage(glb: Buffer): TreeFoliage[] {
    const { json, bin } = parseGlb(glb);
    const trees: TreeFoliage[] = [];
    for (const node of json.nodes ?? []) {
        if (node.extras?.crownId === undefined) continue;
        // a tree with levels (trees-lod/2 or /1) holds its blob leaf masses in its far (last) level child (the last primitive);
        // a tree without holds them in its own mesh
        let holder = node;
        if (Array.isArray(node.children) && node.children.length) {
            const kids = node.children.map((i: number) => json.nodes[i]).filter((c: any) => c.extras?.sbLod);
            holder = kids.reduce((a: any, c: any) => (!a || c.extras.sbLod.level > a.extras.sbLod.level ? c : a), undefined);
            if (!holder) continue;
        }
        if (holder.mesh === undefined) continue;
        if (holder.matrix || holder.rotation) throw new Error(`tree node ${holder.name} carries a rotation`);
        const prims = json.meshes[holder.mesh].primitives.filter((p: any) => (p.mode ?? 4) === 4);
        if (!prims.length) continue;
        const foliage = prims[prims.length - 1];
        const [tx, ty, tz] = holder.translation ?? [0, 0, 0];
        const [sx, sy, sz] = holder.scale ?? [1, 1, 1];
        const p = readAccessor(json, bin, foliage.attributes.POSITION).data;
        const positions = new Float32Array(p.length);
        for (let i = 0; i < p.length; i += 3) {
            positions[i] = tx + sx * p[i];
            positions[i + 1] = ty + sy * p[i + 1];
            positions[i + 2] = tz + sz * p[i + 2];
        }
        const indices = Uint32Array.from(readAccessor(json, bin, foliage.indices).data);
        trees.push({ crownId: node.extras.crownId, extras: node.extras, positions, indices });
    }
    return trees;
}

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V) => Math.hypot(a[0], a[1], a[2]);

/** Distance from p to the triangle abc (closest point by barycentric projection, else the nearest edge). */
function pointTriangle(p: V, a: V, b: V, c: V): number {
    const n = cross(sub(b, a), sub(c, a));
    const nn = dot(n, n);
    if (nn > 1e-18) {
        const t = dot(sub(p, a), n) / nn;
        const q: V = [p[0] - n[0] * t, p[1] - n[1] * t, p[2] - n[2] * t];
        const inside = dot(cross(sub(b, a), sub(q, a)), n) >= 0 && dot(cross(sub(c, b), sub(q, b)), n) >= 0 && dot(cross(sub(a, c), sub(q, c)), n) >= 0;
        if (inside) return Math.abs(t) * Math.sqrt(nn);
    }
    const seg = (u: V, v: V) => {
        const d = sub(v, u), l2 = dot(d, d);
        const s = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, u), d) / l2)) : 0;
        return len(sub(p, [u[0] + d[0] * s, u[1] + d[1] * s, u[2] + d[2] * s]));
    };
    return Math.min(seg(a, b), seg(b, c), seg(c, a));
}

/** Parameter t > 0 at which the ray o + t d meets triangle abc, or -1. */
function rayTriangle(o: V, d: V, a: V, b: V, c: V): number {
    const e1 = sub(b, a), e2 = sub(c, a), pv = cross(d, e2), det = dot(e1, pv);
    if (Math.abs(det) < 1e-12) return -1;
    const tv = sub(o, a), u = dot(tv, pv) / det;
    if (u < -1e-6 || u > 1 + 1e-6) return -1;
    const qv = cross(tv, e1), v = dot(d, qv) / det;
    if (v < -1e-6 || u + v > 1 + 1e-6) return -1;
    const t = dot(e2, qv) / det;
    return t > 0 ? t : -1;
}

/** Share of `samples` the foliage's leaf masses reach (see the file comment), and the foliage's highest point. */
export function foliageReach(f: TreeFoliage, clumps: number, samples: V[], reach: number): { share: number; topY: number } {
    const nv = f.positions.length / 3, nt = f.indices.length / 3;
    if (!clumps || nv % clumps || nt % clumps) throw new Error(`crown ${f.crownId}: ${nv} vertices and ${nt} triangles do not split into ${clumps} leaf masses`);
    const vpc = nv / clumps, tpc = nt / clumps;
    const vert = (i: number): V => [f.positions[3 * i], f.positions[3 * i + 1], f.positions[3 * i + 2]];
    let topY = -Infinity;
    const masses = Array.from({ length: clumps }, (_, k) => {
        const c: V = [0, 0, 0];
        for (let v = 0; v < vpc; v++) { const p = vert(k * vpc + v); c[0] += p[0] / vpc; c[1] += p[1] / vpc; c[2] += p[2] / vpc; topY = Math.max(topY, p[1]); }
        let extent = 0;
        for (let v = 0; v < vpc; v++) extent = Math.max(extent, len(sub(vert(k * vpc + v), c)));
        const tris: Array<[V, V, V]> = [];
        for (let t = 0; t < tpc; t++) {
            const o = 3 * (k * tpc + t);
            tris.push([vert(f.indices[o]), vert(f.indices[o + 1]), vert(f.indices[o + 2])]);
        }
        return { c, extent, tris };
    });
    let reached = 0;
    for (const s of samples) {
        if (masses.some(m => {
            if (len(sub(s, m.c)) > m.extent + reach) return false;
            let nearest = Infinity, along = -1;
            for (const [a, b, c] of m.tris) {
                nearest = Math.min(nearest, pointTriangle(s, a, b, c));
                along = Math.max(along, rayTriangle(m.c, sub(s, m.c), a, b, c));
            }
            return nearest <= reach || along >= 1;
        })) reached++;
    }
    return { share: samples.length ? reached / samples.length : 0, topY };
}

/** The crown surface samples a tree's leaves must reach: those above its inferred crown base (support + ratio x height). */
export function crownSurfaceAboveBase(crown: any, crownBaseRatio: number): V[] {
    const base = crown.supportY + crownBaseRatio * Math.max(0.5, crown.apex[1] - crown.supportY);
    return crown.samples.filter((s: V) => s[1] >= base);
}
