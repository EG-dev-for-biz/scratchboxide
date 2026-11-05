/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The remeshed scan turned to face outward before it is rebuilt or textured. A photogrammetric remesh leaves pieces wound
 * the wrong way: seen from outside, the viewer meets their back (the twin draws them double-sided, so the photo shows,
 * lit from behind, and pipeline K's outside check counts them as the building's inside showing through a hole).
 *
 * The scan is looked at as the outside check looks at it: orthographic views around it and from above, each a depth buffer
 * of the nearest triangle whichever way it faces. Per triangle, the pixels where it is the nearest surface seen from the
 * front and from behind. A triangle seen from behind and never (or hardly) from the front, and facing into the building
 * (a ray from it, the way it faces, meets the scan: a real outer surface seen through a hole faces open air and is left,
 * so a hole is never hidden by turning the wall behind it), is turned: its winding reversed, and its vertices' normals
 * with it when every triangle using them turns. One seen from both sides (a thin sheet, a
 * railing) or from neither (hidden) is left as it is. Nothing is moved or removed.
 *
 * The turns are found on the clay and applied to every GLB of the same remesh (the clay and tile_refine's textured twin,
 * the same surface split by photo material), matched by the triangle's corners.
 *
 * A rebuilt facade (pipeline K's FacadeLattice_* nodes) whose frame tile_refine measured facing out (its outward reading
 * decided, facade-lattice.ts ReliefFacade.outward) is built facing out cell by cell and is never turned: it still hides what
 * lies behind it in the views. Turning by these views took a strip of cells off a wall wherever its facing ray slipped past
 * the building (Penn 2: 1,012 m² of rebuilt facades left or made facing in).
 */

import { accessorLayout, assembleGlb, parseGlbBytes, readAccessor, type ParsedGlb } from './glb-bytes';

export const REMESH_ORIENT_VERSION = 'remesh-orient/5';

/** On unless SCRATCHBOX_STAGED_REMESH_ORIENT=0. */
export function remeshOrientEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STAGED_REMESH_ORIENT?.trim() !== '0';
}

export const REMESH_ORIENT_PARAMS = {
    /** Pixel size of the views (m), and at most this many pixels in a view (the pixel grows on a larger scan). */
    pixelM: 0.15, maxViewPixels: 4_000_000,
    /** Horizon views every this many degrees, the views from above at this elevation and these azimuths, and one straight down. */
    azimuthStepDeg: 45, aboveElevationDeg: 35, aboveAzimuthsDeg: [45, 135, 225, 315], topDown: true,
    /** Depths within this (m) are a tie: the front face wins (a shared edge, a closed corner). */
    tieM: 0.05,
    /** A triangle seen this close to edge-on (cosine of its normal to the view) counts neither way: its side is a rounding error. */
    minFacingCos: 0.1,
    /** A triangle is turned when seen from behind on at least this many pixels and from the front on at most this share of them. */
    minBackPixels: 3, maxFrontShare: 0.25,
    /** The facing ray starts this far off the triangle (m), so its own neighbours at a crease do not count as the building. */
    rayStartM: 0.2,
    /** Corners match across the GLBs to this (m). */
    matchM: 1e-4
};
export type RemeshOrientParams = typeof REMESH_ORIENT_PARAMS;

export interface RemeshOrientStats { triangles: number; turned: number; turnedAreaM2: number; /** Seen from behind but facing open air (a real outer surface, a hole's far side): left. */ facingOut: number; /** Triangles of rebuilt facades measured facing out: never turned. */ measuredOut: number; ms: number }

/**
 * A uniform grid over the soup's triangles (each listed in every cell its box touches), walked cell by cell along a ray
 * (Amanatides and Woo 1987): a ray test reads only the triangles near its path instead of the whole scan, which on a
 * district (a million and more triangles) took minutes.
 */
export interface RayGrid { pos: Float32Array; lo: [number, number, number]; cell: number; dims: [number, number, number]; start: Uint32Array; items: Uint32Array }

export function rayGrid(pos: Float32Array): RayGrid {
    const n = pos.length / 9;
    const lo: [number, number, number] = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], pos[i + k]); hi[k] = Math.max(hi[k], pos[i + k]); }
    if (!n) return { pos, lo: [0, 0, 0], cell: 1, dims: [1, 1, 1], start: new Uint32Array(2), items: new Uint32Array(0) };
    // about two triangles a cell over the box's volume, each side at most 256 cells
    const ext = [0, 1, 2].map(k => Math.max(hi[k] - lo[k], 1e-3));
    let cell = Math.cbrt((ext[0] * ext[1] * ext[2]) / Math.max(1, n / 2));
    cell = Math.max(cell, Math.max(...ext) / 256, 0.05);
    const dims = ext.map(e => Math.max(1, Math.ceil(e / cell))) as [number, number, number];
    const idx = (i: number, j: number, k: number) => (k * dims[1] + j) * dims[0] + i;
    const range = (t: number, ax: number) => {
        const a = t * 9 + ax, v0 = pos[a], v1 = pos[a + 3], v2 = pos[a + 6];
        return [Math.min(dims[ax] - 1, Math.max(0, Math.floor((Math.min(v0, v1, v2) - lo[ax]) / cell))), Math.min(dims[ax] - 1, Math.max(0, Math.floor((Math.max(v0, v1, v2) - lo[ax]) / cell)))];
    };
    // two passes: count, then fill (a district's lists outgrow nested arrays)
    const count = new Uint32Array(dims[0] * dims[1] * dims[2] + 1);
    for (let t = 0; t < n; t++) {
        const [x0, x1] = range(t, 0), [y0, y1] = range(t, 1), [z0, z1] = range(t, 2);
        for (let k = z0; k <= z1; k++) for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) count[idx(i, j, k) + 1]++;
    }
    for (let c = 1; c < count.length; c++) count[c] += count[c - 1];
    const start = Uint32Array.from(count), fill = Uint32Array.from(count), items = new Uint32Array(count[count.length - 1]);
    for (let t = 0; t < n; t++) {
        const [x0, x1] = range(t, 0), [y0, y1] = range(t, 1), [z0, z1] = range(t, 2);
        for (let k = z0; k <= z1; k++) for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) items[fill[idx(i, j, k)]++] = t;
    }
    return { pos, lo, cell, dims, start, items };
}

/** Does a ray from o along d meet triangle t beyond `from` (m)? Möller–Trumbore. */
function rayHitsTriangle(pos: Float32Array, t: number, o: number[], d: number[], from: number): boolean {
    const a = t * 9;
    const e1x = pos[a + 3] - pos[a], e1y = pos[a + 4] - pos[a + 1], e1z = pos[a + 5] - pos[a + 2];
    const e2x = pos[a + 6] - pos[a], e2y = pos[a + 7] - pos[a + 1], e2z = pos[a + 8] - pos[a + 2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) return false;
    const inv = 1 / det, sx = o[0] - pos[a], sy = o[1] - pos[a + 1], sz = o[2] - pos[a + 2];
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) return false;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < 0 || u + v > 1) return false;
    return (e2x * qx + e2y * qy + e2z * qz) * inv > from;
}

/** Does a ray from o (inside the grid's box) along d meet any triangle of the soup (but `self`) beyond `from` (m)? */
export function rayMeetsGrid(g: RayGrid, o: number[], d: number[], self: number, from: number): boolean {
    const { lo, cell, dims } = g;
    const c = [0, 1, 2].map(k => Math.min(dims[k] - 1, Math.max(0, Math.floor((o[k] - lo[k]) / cell))));
    const step = d.map(v => (v > 0 ? 1 : v < 0 ? -1 : 0));
    // the ray's distance to the next cell wall on each axis, and between walls
    const tMax = [0, 1, 2].map(k => (step[k] ? ((lo[k] + (c[k] + (step[k] > 0 ? 1 : 0)) * cell) - o[k]) / d[k] : Infinity));
    const tDelta = [0, 1, 2].map(k => (step[k] ? cell / Math.abs(d[k]) : Infinity));
    for (;;) {
        const ci = (c[2] * dims[1] + c[1]) * dims[0] + c[0];
        for (let q = g.start[ci]; q < g.start[ci + 1]; q++) { const t = g.items[q]; if (t !== self && rayHitsTriangle(g.pos, t, o, d, from)) return true; }
        const ax = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : tMax[1] < tMax[2] ? 1 : 2;
        c[ax] += step[ax];
        if (c[ax] < 0 || c[ax] >= dims[ax]) return false;
        tMax[ax] += tDelta[ax];
    }
}

/** Does a ray from o along d meet any triangle of the soup (but `self`) beyond `from` (m)? Möller–Trumbore, every triangle. */
export function rayMeets(pos: Float32Array, o: number[], d: number[], self: number, from: number): boolean {
    const n = pos.length / 9;
    for (let t = 0; t < n; t++) {
        if (t === self) continue;
        const a = t * 9;
        const e1x = pos[a + 3] - pos[a], e1y = pos[a + 4] - pos[a + 1], e1z = pos[a + 5] - pos[a + 2];
        const e2x = pos[a + 6] - pos[a], e2y = pos[a + 7] - pos[a + 1], e2z = pos[a + 8] - pos[a + 2];
        const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det, sx = o[0] - pos[a], sy = o[1] - pos[a + 1], sz = o[2] - pos[a + 2];
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        if ((e2x * qx + e2y * qy + e2z * qz) * inv > from) return true;
    }
    return false;
}

interface Soup { pos: Float32Array; /** Per triangle: 1 when it may not be turned (a rebuilt facade measured facing out). */ locked: Uint8Array }

/** A node's mesh is a rebuilt facade whose frame tile_refine measured facing out. */
function measuredOut(extras: any): boolean {
    return extras?.sbFacadeLattice?.outward?.decided === true;
}

/** Every triangle of a GLB (tile_refine writes no node transforms), in mesh and primitive order. */
function soupOf(g: ParsedGlb): Soup {
    const out: number[] = [], locked: number[] = [];
    const keep = new Set<number>();
    for (const n of g.json.nodes ?? []) if (n.mesh !== undefined && measuredOut(n.extras)) keep.add(n.mesh);
    // the infill's caps (sbSeal) are faced out by their own test (lattice-stitch.ts fillOpenLoops) and left out: a cap lying on a
    // scan piece wins its depth ties, so the piece would never be seen from behind and never turned
    const fill = new Set<number>();
    for (const n of g.json.nodes ?? []) if (n.mesh !== undefined && n.extras?.sbSeal) fill.add(n.mesh);
    for (const [mi, m] of (g.json.meshes ?? []).entries()) for (const p of fill.has(mi) ? [] : m.primitives ?? []) {
        if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined) continue;
        const P = readAccessor(g, p.attributes.POSITION).data, I = p.indices !== undefined ? readAccessor(g, p.indices).data : undefined;
        const n = I ? I.length : P.length / 3;
        for (let t = 0; t + 2 < n; t += 3) { locked.push(keep.has(mi) ? 1 : 0); for (let k = 0; k < 3; k++) { const v = I ? I[t + k] : t + k; out.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); } }
    }
    return { pos: Float32Array.from(out), locked: Uint8Array.from(locked) };
}

/** Per triangle, the pixels where it is the nearest surface seen from the front and from behind, in one view (added to `front`, `back`). */
function look(s: Soup, azimuthDeg: number, elevationDeg: number, P: RemeshOrientParams, front: Uint32Array, back: Uint32Array): void {
    const az = (azimuthDeg * Math.PI) / 180, el = (elevationDeg * Math.PI) / 180;
    // toward the viewer, and the image's right and up (straight down: right along x)
    const d = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
    const r0 = Math.abs(d[1]) > 0.999 ? [1, 0, 0] : [d[2], 0, -d[0]], rl = Math.hypot(r0[0], r0[2]) || 1, r = [r0[0] / rl, 0, r0[2] / rl];
    const u = [d[1] * r[2] - d[2] * r[1], d[2] * r[0] - d[0] * r[2], d[0] * r[1] - d[1] * r[0]];
    const n = s.pos.length / 3;
    const X = new Float32Array(n), Y = new Float32Array(n), Z = new Float32Array(n);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
        const px = s.pos[i * 3], py = s.pos[i * 3 + 1], pz = s.pos[i * 3 + 2];
        X[i] = px * r[0] + py * r[1] + pz * r[2]; Y[i] = px * u[0] + py * u[1] + pz * u[2]; Z[i] = px * d[0] + py * d[1] + pz * d[2];
        if (X[i] < x0) x0 = X[i]; if (X[i] > x1) x1 = X[i]; if (Y[i] < y0) y0 = Y[i]; if (Y[i] > y1) y1 = Y[i];
    }
    if (!(x1 >= x0)) return;
    const px = Math.max(P.pixelM, Math.sqrt(((x1 - x0) * (y1 - y0)) / P.maxViewPixels));
    const W = Math.ceil((x1 - x0) / px) + 1, H = Math.ceil((y1 - y0) / px) + 1;
    const zb = new Float32Array(W * H).fill(-Infinity), tri = new Int32Array(W * H).fill(-1), isBack = new Uint8Array(W * H);
    for (let t = 0; t < n / 3; t++) {
        const a = t * 3, b = a + 1, c = a + 2;
        const S = [(X[a] - x0) / px, (X[b] - x0) / px, (X[c] - x0) / px], T = [(Y[a] - y0) / px, (Y[b] - y0) / px, (Y[c] - y0) / px];
        const area = (S[1] - S[0]) * (T[2] - T[0]) - (S[2] - S[0]) * (T[1] - T[0]);
        if (Math.abs(area) < 1e-12) continue;
        // its true area in pixels: an edge-on triangle (the projection a sliver of it) is not seen from either side
        const ex = s.pos[b * 3] - s.pos[a * 3], ey = s.pos[b * 3 + 1] - s.pos[a * 3 + 1], ez = s.pos[b * 3 + 2] - s.pos[a * 3 + 2];
        const fx = s.pos[c * 3] - s.pos[a * 3], fy = s.pos[c * 3 + 1] - s.pos[a * 3 + 1], fz = s.pos[c * 3 + 2] - s.pos[a * 3 + 2];
        const full = Math.hypot(ey * fz - ez * fy, ez * fx - ex * fz, ex * fy - ey * fx) / (px * px);
        if (Math.abs(area) < P.minFacingCos * full) continue;
        // counter-clockwise in the image (x right, y up, toward the viewer) is the front
        const bk = area < 0;
        const sx0 = Math.max(0, Math.ceil(Math.min(S[0], S[1], S[2]))), sx1 = Math.min(W - 1, Math.floor(Math.max(S[0], S[1], S[2])));
        const sy0 = Math.max(0, Math.ceil(Math.min(T[0], T[1], T[2]))), sy1 = Math.min(H - 1, Math.floor(Math.max(T[0], T[1], T[2])));
        for (let y = sy0; y <= sy1; y++) for (let x = sx0; x <= sx1; x++) {
            const w1 = ((x - S[0]) * (T[2] - T[0]) - (S[2] - S[0]) * (y - T[0])) / area, w2 = ((S[1] - S[0]) * (y - T[0]) - (x - S[0]) * (T[1] - T[0])) / area, w0 = 1 - w1 - w2;
            if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
            const z = w0 * Z[a] + w1 * Z[b] + w2 * Z[c], o = y * W + x;
            // a back face must be nearer by more than the tie to win; a front face wins a tie with a back face
            if (tri[o] < 0 || (bk ? z > zb[o] + P.tieM : z > zb[o] || (isBack[o] === 1 && z > zb[o] - P.tieM))) { zb[o] = z; tri[o] = t; isBack[o] = bk ? 1 : 0; }
        }
    }
    // a pixel on the scan's outline counts neither way: there a back face only meets the front at their shared edge
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const o = y * W + x;
        if (tri[o] < 0 || tri[o - 1] < 0 || tri[o + 1] < 0 || tri[o - W] < 0 || tri[o + W] < 0) continue;
        (isBack[o] ? back : front)[tri[o]]++;
    }
}

/** The triangles to turn, keyed by their corners (sorted, rounded to matchM), found on the clay. */
export function findInwardTriangles(clayBytes: Uint8Array, P: RemeshOrientParams = REMESH_ORIENT_PARAMS): { keys: Set<string>; stats: RemeshOrientStats } {
    const t0 = Date.now();
    const s = soupOf(parseGlbBytes(clayBytes));
    const n = s.pos.length / 9;
    const front = new Uint32Array(n), back = new Uint32Array(n);
    for (let az = 0; az < 360; az += P.azimuthStepDeg) look(s, az, 0, P, front, back);
    for (const az of P.aboveAzimuthsDeg) look(s, az, P.aboveElevationDeg, P, front, back);
    if (P.topDown) look(s, 0, 90, P, front, back);
    const keys = new Set<string>();
    let area = 0, facingOut = 0, grid: RayGrid | undefined;
    const measured = s.locked.reduce((a, v) => a + v, 0);
    for (let t = 0; t < n; t++) {
        if (s.locked[t]) continue;
        if (back[t] < P.minBackPixels || front[t] > P.maxFrontShare * back[t]) continue;
        const p = s.pos.subarray(t * 9, t * 9 + 9);
        const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz);
        if (!(l > 0)) continue;
        // it faces into the building only when the way it faces is blocked by the scan
        const o = [(p[0] + p[3] + p[6]) / 3, (p[1] + p[4] + p[7]) / 3, (p[2] + p[5] + p[8]) / 3];
        grid ??= rayGrid(s.pos);
        if (!rayMeetsGrid(grid, o, [nx / l, ny / l, nz / l], t, P.rayStartM)) { facingOut++; continue; }
        keys.add(triKey(p, P.matchM));
        area += l / 2;
    }
    return { keys, stats: { triangles: n, turned: keys.size, turnedAreaM2: Math.round(area), facingOut, measuredOut: measured, ms: Date.now() - t0 } };
}

function triKey(p: ArrayLike<number>, m: number): string {
    const c = [0, 3, 6].map(i => `${Math.round(p[i] / m)},${Math.round(p[i + 1] / m)},${Math.round(p[i + 2] / m)}`);
    return c.sort().join('|');
}

/** One GLB with the given triangles turned: winding reversed in its index buffer, normals reversed where every user turns. */
export function turnTriangles(bytes: Uint8Array, keys: Set<string>, P: RemeshOrientParams = REMESH_ORIENT_PARAMS): { glb: Buffer; turned: number } {
    const g = parseGlbBytes(Buffer.from(bytes));
    if (!keys.size) return { glb: Buffer.from(bytes), turned: 0 };
    const json = g.json, dv = new DataView(g.bin.buffer, g.bin.byteOffset, g.bin.byteLength);
    let turned = 0;
    // the infill's caps keep their own facing (soupOf), and so do rebuilt facades measured facing out
    const fill = new Set<number>();
    for (const n of json.nodes ?? []) if (n.mesh !== undefined && (n.extras?.sbSeal || measuredOut(n.extras))) fill.add(n.mesh);
    for (const [mi, m] of (json.meshes ?? []).entries()) for (const p of fill.has(mi) ? [] : m.primitives ?? []) {
        if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined || p.indices === undefined) continue;
        const pos = readAccessor(g, p.attributes.POSITION).data;
        const il = accessorLayout(json, p.indices);
        const size = il.componentType === 5125 ? 4 : il.componentType === 5123 ? 2 : 1;
        const rd = (i: number) => size === 4 ? dv.getUint32(il.base + i * il.stride, true) : size === 2 ? dv.getUint16(il.base + i * il.stride, true) : dv.getUint8(il.base + i * il.stride);
        const wr = (i: number, v: number) => { if (size === 4) dv.setUint32(il.base + i * il.stride, v, true); else if (size === 2) dv.setUint16(il.base + i * il.stride, v, true); else dv.setUint8(il.base + i * il.stride, v); };
        const users = new Uint32Array(pos.length / 3), turnedUsers = new Uint32Array(pos.length / 3);
        const corner = new Float64Array(9);
        for (let t = 0; t + 2 < il.count; t += 3) {
            const a = rd(t), b = rd(t + 1), c = rd(t + 2);
            users[a]++; users[b]++; users[c]++;
            for (let k = 0; k < 3; k++) { corner[k] = pos[a * 3 + k]; corner[3 + k] = pos[b * 3 + k]; corner[6 + k] = pos[c * 3 + k]; }
            if (!keys.has(triKey(corner, P.matchM))) continue;
            wr(t + 1, c); wr(t + 2, b);
            turnedUsers[a]++; turnedUsers[b]++; turnedUsers[c]++;
            turned++;
        }
        // a vertex every one of whose triangles turned faces the other way too
        if (p.attributes.NORMAL !== undefined) {
            const nl = accessorLayout(json, p.attributes.NORMAL);
            if (nl.componentType === 5126) for (let v = 0; v < users.length; v++) {
                if (!users[v] || turnedUsers[v] !== users[v]) continue;
                for (let k = 0; k < 3; k++) { const o = nl.base + v * nl.stride + k * 4; dv.setFloat32(o, -dv.getFloat32(o, true), true); }
            }
        }
    }
    return { glb: assembleGlb(json, g.bin), turned };
}

/** The clay's inward triangles found and turned in the clay and in every other GLB of the same remesh. */
export function orientRemesh(clayBytes: Uint8Array, others: Uint8Array[], P: RemeshOrientParams = REMESH_ORIENT_PARAMS): { clay: Buffer; others: Buffer[]; stats: RemeshOrientStats } {
    const { keys, stats } = findInwardTriangles(clayBytes, P);
    return { clay: turnTriangles(clayBytes, keys, P).glb, others: others.map(b => turnTriangles(b, keys, P).glb), stats };
}
