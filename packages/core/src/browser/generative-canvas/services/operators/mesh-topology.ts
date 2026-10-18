/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Topology edits on an existing triangle mesh in the viewport: subdivision (midpoint and Loop), Laplacian
 * smoothing and repair. They work on the mesh they are given and never build geometry of their own.
 */

import * as THREE from 'three';

/** Triangle corner indices of a geometry, indexed or not. */
function triangleIndices(geometry: THREE.BufferGeometry): Uint32Array {
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    if (geometry.index) return Uint32Array.from(geometry.index.array as ArrayLike<number>);
    const out = new Uint32Array(pos.count - (pos.count % 3));
    for (let i = 0; i < out.length; i++) out[i] = i;
    return out;
}

/** Maps every vertex to a welded id: vertices whose positions agree within `epsilon` share an id. */
export function weldPositions(pos: THREE.BufferAttribute, epsilon = 1e-5): { ids: Uint32Array; count: number } {
    const map = new Map<string, number>();
    const ids = new Uint32Array(pos.count);
    const q = (v: number) => Math.round(v / epsilon);
    for (let i = 0; i < pos.count; i++) {
        const key = `${q(pos.getX(i))},${q(pos.getY(i))},${q(pos.getZ(i))}`;
        let id = map.get(key);
        if (id === undefined) {
            id = map.size;
            map.set(key, id);
        }
        ids[i] = id;
    }
    return { ids, count: map.size };
}

function edgeKey(a: number, b: number, n: number): number {
    return a < b ? a * n + b : b * n + a;
}

function scaleGroups(source: THREE.BufferGeometry, target: THREE.BufferGeometry, factor: number): void {
    for (const g of source.groups) target.addGroup(g.start * factor, g.count * factor, g.materialIndex);
}

export interface SubdivisionResult {
    geometry: THREE.BufferGeometry;
    vertexCount: number;
    faceCount: number;
    /** Attributes the result does not carry (Loop subdivision rebuilds vertices from the welded surface). */
    droppedAttributes: string[];
}

/**
 * One level of midpoint subdivision: every triangle splits into four at its edge midpoints. The surface keeps its
 * shape, and every float attribute (uv, color, ...) is interpolated at the new vertices.
 */
function midpointOnce(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
    const tris = triangleIndices(geometry);
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    const n = pos.count;
    const mid = new Map<number, number>();
    const pairs: Array<[number, number]> = [];
    const midpoint = (a: number, b: number) => {
        const key = edgeKey(a, b, n);
        let id = mid.get(key);
        if (id === undefined) {
            id = n + pairs.length;
            mid.set(key, id);
            pairs.push([a, b]);
        }
        return id;
    };
    const index = new Uint32Array(tris.length * 4);
    for (let t = 0, o = 0; t < tris.length; t += 3) {
        const a = tris[t], b = tris[t + 1], c = tris[t + 2];
        const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
        index.set([a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca], o);
        o += 12;
    }
    const out = new THREE.BufferGeometry();
    for (const name of Object.keys(geometry.attributes)) {
        const attr = geometry.getAttribute(name) as THREE.BufferAttribute;
        if (!(attr as any).isBufferAttribute) continue;
        const size = attr.itemSize;
        const data = new Float32Array((n + pairs.length) * size);
        for (let i = 0; i < n; i++) for (let k = 0; k < size; k++) data[i * size + k] = attr.getComponent(i, k);
        pairs.forEach(([a, b], j) => {
            for (let k = 0; k < size; k++) data[(n + j) * size + k] = 0.5 * (attr.getComponent(a, k) + attr.getComponent(b, k));
        });
        out.setAttribute(name, new THREE.BufferAttribute(data, size, attr.normalized));
    }
    out.setIndex(new THREE.BufferAttribute(index, 1));
    scaleGroups(geometry, out, 4);
    return out;
}

/**
 * One level of Loop subdivision (Loop 1987) on the welded surface: edge points 3/8-3/8-1/8-1/8 (1/2-1/2 on a
 * boundary), original points moved by Warren's beta (3/4-1/8-1/8 on a boundary).
 */
function loopOnce(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    const weld = weldPositions(pos);
    const n = weld.count;
    const P = new Float64Array(n * 3);
    for (let i = 0; i < pos.count; i++) {
        const w = weld.ids[i];
        P[w * 3] = pos.getX(i); P[w * 3 + 1] = pos.getY(i); P[w * 3 + 2] = pos.getZ(i);
    }
    const raw = triangleIndices(geometry);
    const tris: number[] = [];
    for (let t = 0; t < raw.length; t += 3) {
        const a = weld.ids[raw[t]], b = weld.ids[raw[t + 1]], c = weld.ids[raw[t + 2]];
        if (a !== b && b !== c && a !== c) tris.push(a, b, c);
    }
    // Edge -> opposite corners.
    const opposite = new Map<number, number[]>();
    const neighbours: Array<Set<number>> = Array.from({ length: n }, () => new Set<number>());
    for (let t = 0; t < tris.length; t += 3) {
        for (let k = 0; k < 3; k++) {
            const u = tris[t + k], v = tris[t + (k + 1) % 3], w = tris[t + (k + 2) % 3];
            const key = edgeKey(u, v, n);
            const list = opposite.get(key);
            if (list) list.push(w); else opposite.set(key, [w]);
            neighbours[u].add(v); neighbours[v].add(u);
        }
    }
    const boundaryNbrs: Array<number[]> = Array.from({ length: n }, () => []);
    for (const [key, opp] of opposite) {
        if (opp.length !== 1) continue;
        const u = Math.floor(key / n), v = key % n;
        boundaryNbrs[u].push(v); boundaryNbrs[v].push(u);
    }
    const out: number[] = new Array(n * 3).fill(0);
    for (let i = 0; i < n; i++) {
        const b = boundaryNbrs[i];
        if (b.length >= 2) {
            for (let k = 0; k < 3; k++) out[i * 3 + k] = 0.75 * P[i * 3 + k] + 0.125 * (P[b[0] * 3 + k] + P[b[1] * 3 + k]);
            continue;
        }
        const nb = Array.from(neighbours[i]);
        const m = nb.length;
        if (m === 0) { for (let k = 0; k < 3; k++) out[i * 3 + k] = P[i * 3 + k]; continue; }
        const beta = m === 3 ? 3 / 16 : 3 / (8 * m);
        for (let k = 0; k < 3; k++) {
            let sum = 0;
            for (const j of nb) sum += P[j * 3 + k];
            out[i * 3 + k] = (1 - m * beta) * P[i * 3 + k] + beta * sum;
        }
    }
    const edgeVertex = new Map<number, number>();
    const edgePoint = (u: number, v: number) => {
        const key = edgeKey(u, v, n);
        let id = edgeVertex.get(key);
        if (id !== undefined) return id;
        id = out.length / 3;
        edgeVertex.set(key, id);
        const opp = opposite.get(key) ?? [];
        for (let k = 0; k < 3; k++) {
            out.push(opp.length === 2
                ? 0.375 * (P[u * 3 + k] + P[v * 3 + k]) + 0.125 * (P[opp[0] * 3 + k] + P[opp[1] * 3 + k])
                : 0.5 * (P[u * 3 + k] + P[v * 3 + k]));
        }
        return id;
    };
    const index: number[] = [];
    for (let t = 0; t < tris.length; t += 3) {
        const a = tris[t], b = tris[t + 1], c = tris[t + 2];
        const ab = edgePoint(a, b), bc = edgePoint(b, c), ca = edgePoint(c, a);
        index.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    }
    const result = new THREE.BufferGeometry();
    result.setAttribute('position', new THREE.BufferAttribute(new Float32Array(out), 3));
    result.setIndex(index);
    if (tris.length === raw.length) scaleGroups(geometry, result, 4);
    result.computeVertexNormals();
    return result;
}

/** Subdivides `geometry` `iterations` times; `scheme` 'loop' smooths the surface, 'midpoint' keeps its shape. */
export function subdivideGeometry(geometry: THREE.BufferGeometry, iterations: number, scheme: 'loop' | 'midpoint'): SubdivisionResult {
    const source = Object.keys(geometry.attributes);
    let current = geometry;
    for (let i = 0; i < iterations; i++) {
        const next = scheme === 'loop' ? loopOnce(current) : midpointOnce(current);
        if (current !== geometry) current.dispose();
        current = next;
    }
    if (scheme === 'midpoint' && !current.getAttribute('normal')) current.computeVertexNormals();
    if (scheme === 'midpoint' && geometry.getAttribute('normal')) current.computeVertexNormals();
    const kept = new Set(Object.keys(current.attributes));
    const pos = current.getAttribute('position') as THREE.BufferAttribute;
    return {
        geometry: current,
        vertexCount: pos.count,
        faceCount: current.index ? current.index.count / 3 : pos.count / 3,
        droppedAttributes: source.filter(a => !kept.has(a))
    };
}

/**
 * Laplacian (umbrella-operator) smoothing in place: each interior welded vertex moves `factor` of the way to the
 * mean of its neighbours, `iterations` times. Boundary vertices stay put so open edges keep their outline. Seam
 * copies of a vertex move together, so UVs and other attributes stay valid. Returns the vertices moved.
 */
export function laplacianSmoothGeometry(geometry: THREE.BufferGeometry, factor: number, iterations: number): { movedVertices: number; maxDisplacement: number } {
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    const weld = weldPositions(pos);
    const n = weld.count;
    let P = new Float64Array(n * 3);
    for (let i = 0; i < pos.count; i++) {
        const w = weld.ids[i];
        P[w * 3] = pos.getX(i); P[w * 3 + 1] = pos.getY(i); P[w * 3 + 2] = pos.getZ(i);
    }
    const start = P.slice();
    const raw = triangleIndices(geometry);
    const nbrs: Array<Set<number>> = Array.from({ length: n }, () => new Set<number>());
    const edgeUse = new Map<number, number>();
    for (let t = 0; t < raw.length; t += 3) {
        const c = [weld.ids[raw[t]], weld.ids[raw[t + 1]], weld.ids[raw[t + 2]]];
        if (c[0] === c[1] || c[1] === c[2] || c[0] === c[2]) continue;
        for (let k = 0; k < 3; k++) {
            const u = c[k], v = c[(k + 1) % 3];
            nbrs[u].add(v); nbrs[v].add(u);
            const key = edgeKey(u, v, n);
            edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
        }
    }
    const fixed = new Uint8Array(n);
    for (const [key, uses] of edgeUse) {
        if (uses !== 1) continue;
        fixed[Math.floor(key / n)] = 1;
        fixed[key % n] = 1;
    }
    for (let it = 0; it < iterations; it++) {
        const next = P.slice();
        for (let i = 0; i < n; i++) {
            if (fixed[i] || nbrs[i].size === 0) continue;
            for (let k = 0; k < 3; k++) {
                let sum = 0;
                for (const j of nbrs[i]) sum += P[j * 3 + k];
                const avg = sum / nbrs[i].size;
                next[i * 3 + k] = P[i * 3 + k] + factor * (avg - P[i * 3 + k]);
            }
        }
        P = next;
    }
    let moved = 0;
    let maxDisplacement = 0;
    for (let i = 0; i < n; i++) {
        const d = Math.hypot(P[i * 3] - start[i * 3], P[i * 3 + 1] - start[i * 3 + 1], P[i * 3 + 2] - start[i * 3 + 2]);
        if (d > 1e-12) moved++;
        maxDisplacement = Math.max(maxDisplacement, d);
    }
    for (let i = 0; i < pos.count; i++) {
        const w = weld.ids[i];
        pos.setXYZ(i, P[w * 3], P[w * 3 + 1], P[w * 3 + 2]);
    }
    pos.needsUpdate = true;
    return { movedVertices: moved, maxDisplacement };
}

export interface RepairResult {
    degenerateFacesRemoved: number;
    duplicateFacesRemoved: number;
    facesFlipped: number;
    faceCount: number;
}

/**
 * Repairs the triangle list in place: drops faces that collapse when positions within `weldEpsilon` are welded
 * (or have zero area), drops repeated faces, and makes winding consistent across each connected surface (flipping
 * a closed surface whose normals point inward). Vertex attributes are kept; normals are recomputed by the caller.
 */
export function repairGeometry(geometry: THREE.BufferGeometry, weldEpsilon: number, removeDegenerates: boolean): RepairResult {
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    const weld = weldPositions(pos, weldEpsilon);
    const n = weld.count;
    const raw = triangleIndices(geometry);
    const kept: number[] = [];
    let degenerate = 0;
    let duplicate = 0;
    const seen = new Set<string>();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let t = 0; t < raw.length; t += 3) {
        const i0 = raw[t], i1 = raw[t + 1], i2 = raw[t + 2];
        const w = [weld.ids[i0], weld.ids[i1], weld.ids[i2]];
        if (removeDegenerates) {
            a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
            const area = b.sub(a).cross(c.sub(a)).length() * 0.5;
            if (w[0] === w[1] || w[1] === w[2] || w[0] === w[2] || area <= weldEpsilon * weldEpsilon) {
                degenerate++;
                continue;
            }
        }
        const key = [...w].sort((x, y) => x - y).join(',');
        if (seen.has(key)) { duplicate++; continue; }
        seen.add(key);
        kept.push(i0, i1, i2);
    }
    // Consistent winding: neighbouring faces must traverse their shared edge in opposite directions.
    const faces = kept.length / 3;
    const W = (f: number, k: number) => weld.ids[kept[f * 3 + k]];
    const byEdge = new Map<number, number[]>();
    for (let f = 0; f < faces; f++) {
        for (let k = 0; k < 3; k++) {
            const key = edgeKey(W(f, k), W(f, (k + 1) % 3), n);
            const list = byEdge.get(key);
            if (list) list.push(f); else byEdge.set(key, [f]);
        }
    }
    const hasDirected = (f: number, u: number, v: number) => {
        for (let k = 0; k < 3; k++) if (W(f, k) === u && W(f, (k + 1) % 3) === v) return true;
        return false;
    };
    const flip = (f: number) => {
        const tmp = kept[f * 3 + 1];
        kept[f * 3 + 1] = kept[f * 3 + 2];
        kept[f * 3 + 2] = tmp;
    };
    const visited = new Uint8Array(faces);
    let flipped = 0;
    for (let seed = 0; seed < faces; seed++) {
        if (visited[seed]) continue;
        const component: number[] = [];
        const queue = [seed];
        visited[seed] = 1;
        let componentFlips = 0;
        while (queue.length) {
            const f = queue.pop()!;
            component.push(f);
            for (let k = 0; k < 3; k++) {
                const u = W(f, k), v = W(f, (k + 1) % 3);
                const list = byEdge.get(edgeKey(u, v, n))!;
                if (list.length !== 2) continue; // boundary or non-manifold edge: no orientation constraint
                const g = list[0] === f ? list[1] : list[0];
                if (visited[g]) continue;
                visited[g] = 1;
                if (hasDirected(g, u, v)) { flip(g); componentFlips++; }
                queue.push(g);
            }
        }
        // A closed component wound inward (negative signed volume) is turned outward.
        let closed = true;
        let volume = 0;
        for (const f of component) {
            for (let k = 0; k < 3; k++) if (byEdge.get(edgeKey(W(f, k), W(f, (k + 1) % 3), n))!.length !== 2) closed = false;
            a.fromBufferAttribute(pos, kept[f * 3]); b.fromBufferAttribute(pos, kept[f * 3 + 1]); c.fromBufferAttribute(pos, kept[f * 3 + 2]);
            volume += a.dot(b.clone().cross(c)) / 6;
        }
        if (closed && volume < 0) {
            for (const f of component) flip(f);
            componentFlips = component.length - componentFlips;
        }
        flipped += componentFlips;
    }
    geometry.setIndex(kept);
    geometry.clearGroups();
    return { degenerateFacesRemoved: degenerate, duplicateFacesRemoved: duplicate, facesFlipped: flipped, faceCount: faces };
}
