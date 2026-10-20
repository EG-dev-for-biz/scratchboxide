/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Version F (experiment), step 3: render-compare. The procedural model and the tile are rendered from the same cameras in
 * the tile frame and compared:
 *
 *   - obliques (45 deg down, four azimuths) and top-down, orthographic: silhouette IoU and depth agreement against the
 *     isolated scan;
 *   - each seen wall's own orthographic camera (the native tool's face frame): depth agreement against the tile's ortho
 *     depth, and window-line alignment: the correlation of the model's openings with where the tile photo is darker than
 *     the wall round it (window NCC), and the mean distance from the model's opening borders to the photo's nearest strong
 *     edge (edge distance, metres).
 *
 * A small software rasterizer (depth only) does the rendering; nothing here calls a model.
 */

import type { MassingFace, MassingNode } from '../pipeline-e/native-massing';
import { faceToPixel } from '../pipeline-e/native-massing';
import type { OpeningItem, SweepItem, FaceSweepItem } from '../pipeline-e/massing-spec';

export type V3 = [number, number, number];

/** An orthographic camera: pixel (x, y) = ((p - origin) . right, -(p - origin) . up) / pixel; depth (p - origin) . fwd. */
export interface OrthoCam { origin: V3; right: V3; up: V3; fwd: V3; pixel: number; width: number; height: number }

const dot = (a: ArrayLike<number>, o: number, b: V3, c: V3) => (a[o] - c[0]) * b[0] + (a[o + 1] - c[1]) * b[1] + (a[o + 2] - c[2]) * b[2];

/** Triangle soup (9 floats per triangle) of native nodes, optionally filtered by node. */
export function nodesToSoup(nodes: MassingNode[], keep: (n: MassingNode) => boolean = () => true): Float32Array {
    let n = 0;
    for (const nd of nodes) if (keep(nd)) n += nd.indices.length;
    const out = new Float32Array(n * 3);
    let o = 0;
    for (const nd of nodes) {
        if (!keep(nd)) continue;
        for (let i = 0; i < nd.indices.length; i++) { const v = nd.indices[i] * 3; out[o++] = nd.positions[v]; out[o++] = nd.positions[v + 1]; out[o++] = nd.positions[v + 2]; }
    }
    return out;
}

/**
 * Nearest depth per pixel (NaN where nothing) of a triangle soup through an orthographic camera; depths outside
 * [near, far] are ignored (the wall cameras' slab).
 */
export function rasterOrtho(tris: Float32Array, cam: OrthoCam, near = -Infinity, far = Infinity): Float32Array {
    const W = cam.width, H = cam.height;
    const depth = new Float32Array(W * H).fill(Infinity);
    const X = [0, 0, 0], Y = [0, 0, 0], Z = [0, 0, 0];
    for (let t = 0; t + 8 < tris.length; t += 9) {
        for (let k = 0; k < 3; k++) {
            X[k] = dot(tris, t + 3 * k, cam.right, cam.origin) / cam.pixel;
            Y[k] = -dot(tris, t + 3 * k, cam.up, cam.origin) / cam.pixel;
            Z[k] = dot(tris, t + 3 * k, cam.fwd, cam.origin);
        }
        if (Math.max(Z[0], Z[1], Z[2]) < near || Math.min(Z[0], Z[1], Z[2]) > far) continue;
        const area = (X[1] - X[0]) * (Y[2] - Y[0]) - (X[2] - X[0]) * (Y[1] - Y[0]);
        if (Math.abs(area) < 1e-9) continue;
        const x0 = Math.max(0, Math.floor(Math.min(X[0], X[1], X[2]))), x1 = Math.min(W - 1, Math.ceil(Math.max(X[0], X[1], X[2])));
        const y0 = Math.max(0, Math.floor(Math.min(Y[0], Y[1], Y[2]))), y1 = Math.min(H - 1, Math.ceil(Math.max(Y[0], Y[1], Y[2])));
        for (let py = y0; py <= y1; py++) {
            const yc = py + 0.5;
            for (let px = x0; px <= x1; px++) {
                const xc = px + 0.5;
                const w0 = ((X[1] - xc) * (Y[2] - yc) - (X[2] - xc) * (Y[1] - yc)) / area;
                const w1 = ((X[2] - xc) * (Y[0] - yc) - (X[0] - xc) * (Y[2] - yc)) / area;
                const w2 = 1 - w0 - w1;
                if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
                const z = w0 * Z[0] + w1 * Z[1] + w2 * Z[2];
                if (z < near || z > far) continue;
                const i = py * W + px;
                if (z < depth[i]) depth[i] = z;
            }
        }
    }
    for (let i = 0; i < depth.length; i++) if (depth[i] === Infinity) depth[i] = NaN;
    return depth;
}

const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Bounds (x, y, z) of a soup. */
export function soupBounds(t: Float32Array): { lo: V3; hi: V3 } {
    const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < t.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], t[i + k]); hi[k] = Math.max(hi[k], t[i + k]); }
    return { lo, hi };
}

/** Four 45-degree obliques (azimuths 45, 135, 225, 315 from north, clockwise) and a top-down camera framing `bounds`. */
export function comparisonCameras(bounds: { lo: V3; hi: V3 }, maxSide = 480): Array<{ id: string; cam: OrthoCam }> {
    const c: V3 = [(bounds.lo[0] + bounds.hi[0]) / 2, (bounds.lo[1] + bounds.hi[1]) / 2, (bounds.lo[2] + bounds.hi[2]) / 2];
    const corners: V3[] = [];
    for (const x of [bounds.lo[0], bounds.hi[0]]) for (const y of [bounds.lo[1], bounds.hi[1]]) for (const z of [bounds.lo[2], bounds.hi[2]]) corners.push([x, y, z]);
    const make = (id: string, fwd: V3, upHint: V3): { id: string; cam: OrthoCam } => {
        const f = norm(fwd), r = norm(cross(f, upHint)), u = cross(r, f);
        let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
        for (const p of corners) { const a = (p[0] - c[0]) * r[0] + (p[1] - c[1]) * r[1] + (p[2] - c[2]) * r[2], b = (p[0] - c[0]) * u[0] + (p[1] - c[1]) * u[1] + (p[2] - c[2]) * u[2]; a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); }
        const pad = 2;
        a0 -= pad; a1 += pad; b0 -= pad; b1 += pad;
        const pixel = Math.max(a1 - a0, b1 - b0) / maxSide;
        const back = 500;
        const origin: V3 = [c[0] + r[0] * a0 + u[0] * b1 - f[0] * back, c[1] + r[1] * a0 + u[1] * b1 - f[1] * back, c[2] + r[2] * a0 + u[2] * b1 - f[2] * back];
        return { id, cam: { origin, right: r, up: u, fwd: f, pixel, width: Math.ceil((a1 - a0) / pixel), height: Math.ceil((b1 - b0) / pixel) } };
    };
    const out = [45, 135, 225, 315].map(az => {
        const a = (az * Math.PI) / 180;
        // looking towards the building from azimuth `az` (north = -z, east = +x), 45 degrees down
        const toward: V3 = [-Math.sin(a), 0, Math.cos(a)];
        return make(`oblique${az}`, [toward[0] * Math.SQRT1_2, -Math.SQRT1_2, toward[2] * Math.SQRT1_2], [0, 1, 0]);
    });
    out.push(make('top', [0, -1, 0], [0, 0, -1]));
    return out;
}

export interface SilhouetteCompare { id: string; iou: number; depthMedianM: number; depthWithin05: number; modelPixels: number; tilePixels: number }

/** Silhouette IoU and depth agreement of two soups through one camera. */
export function compareSilhouette(id: string, model: Float32Array, tile: Float32Array, cam: OrthoCam): SilhouetteCompare {
    const a = rasterOrtho(model, cam), b = rasterOrtho(tile, cam);
    let inter = 0, uni = 0, na = 0, nb = 0;
    const diffs: number[] = [];
    for (let i = 0; i < a.length; i++) {
        const ha = Number.isFinite(a[i]), hb = Number.isFinite(b[i]);
        if (ha) na++;
        if (hb) nb++;
        if (ha || hb) uni++;
        if (ha && hb) { inter++; diffs.push(Math.abs(a[i] - b[i])); }
    }
    diffs.sort((p, q) => p - q);
    return { id, iou: uni ? inter / uni : 0, depthMedianM: diffs.length ? diffs[diffs.length >> 1] : NaN, depthWithin05: diffs.length ? diffs.filter(d => d <= 0.5).length / diffs.length : 0, modelPixels: na, tilePixels: nb };
}

/** A wall's own orthographic camera (its ortho frame); depth is minus the offset along the face normal. */
export function wallCamera(f: MassingFace): OrthoCam {
    const origin: V3 = [f.origin[0] + f.axisS[0] * f.orthoSMin + f.axisT[0] * f.orthoTMax, f.origin[1] + f.axisS[1] * f.orthoSMin + f.axisT[1] * f.orthoTMax, f.origin[2] + f.axisS[2] * f.orthoSMin + f.axisT[2] * f.orthoTMax];
    return { origin, right: f.axisS as V3, up: f.axisT as V3, fwd: [-f.normal[0], -f.normal[1], -f.normal[2]], pixel: f.pixel, width: f.width, height: f.height };
}

/** The tile's side of a wall comparison: its ortho photo's luminance (NaN uncovered) and depth (offset, NaN uncovered). */
export interface WallTile { face: MassingFace; luma: Float32Array; depth: Float32Array }

export function wallTileFromOrtho(face: MassingFace, rgba: Uint8Array, depth: Float32Array): WallTile {
    const n = face.width * face.height, luma = new Float32Array(n);
    for (let i = 0; i < n; i++) luma[i] = rgba[i * 4 + 3] < 128 ? NaN : 0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2];
    return { face, luma, depth };
}

/** The same wall comparison at a coarser pixel (k x k blocks, NaN-aware means): the adjustment's fast path. */
export function downsampleWallTile(t: WallTile, k: number): WallTile {
    if (k <= 1) return t;
    const f = t.face, W = Math.floor(f.width / k), H = Math.floor(f.height / k);
    const luma = new Float32Array(W * H), depth = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let sl = 0, nl = 0, sd = 0, nd = 0;
        for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) {
            const i = (y * k + dy) * f.width + x * k + dx;
            if (Number.isFinite(t.luma[i])) { sl += t.luma[i]; nl++; }
            if (Number.isFinite(t.depth[i])) { sd += t.depth[i]; nd++; }
        }
        luma[y * W + x] = nl * 2 >= k * k ? sl / nl : NaN;
        depth[y * W + x] = nd * 2 >= k * k ? sd / nd : NaN;
    }
    return { face: { ...f, width: W, height: H, pixel: f.pixel * k }, luma, depth };
}

function boxBlur(src: Float32Array, W: number, H: number, r: number): Float32Array {
    // NaN-aware separable mean
    const tmpS = new Float32Array(W * H), tmpN = new Float32Array(W * H), out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
        let s = 0, n = 0;
        for (let x = -r; x < W + r; x++) {
            const xa = x + r, xr = x - r - 1;
            if (xa >= 0 && xa < W) { const v = src[y * W + xa]; if (Number.isFinite(v)) { s += v; n++; } }
            if (xr >= 0 && xr < W) { const v = src[y * W + xr]; if (Number.isFinite(v)) { s -= v; n--; } }
            if (x >= 0 && x < W) { tmpS[y * W + x] = s; tmpN[y * W + x] = n; }
        }
    }
    for (let x = 0; x < W; x++) {
        let s = 0, n = 0;
        for (let y = -r; y < H + r; y++) {
            const ya = y + r, yr = y - r - 1;
            if (ya >= 0 && ya < H) { s += tmpS[ya * W + x]; n += tmpN[ya * W + x]; }
            if (yr >= 0 && yr < H) { s -= tmpS[yr * W + x]; n -= tmpN[yr * W + x]; }
            if (y >= 0 && y < H) out[y * W + x] = n > 0 ? s / n : NaN;
        }
    }
    return out;
}

/** Per wall: where the photo is darker than the wall round it (box of ~2 m), and its strong edges (Sobel, top 15 %). */
export interface WallEvidence { tile: WallTile; dark: Float32Array; edgeDist: Float32Array }

export function wallEvidence(tile: WallTile): WallEvidence {
    const f = tile.face, W = f.width, H = f.height;
    const r = Math.max(2, Math.round(1.0 / f.pixel));
    const local = boxBlur(tile.luma, W, H, r);
    const dark = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) dark[i] = Number.isFinite(tile.luma[i]) && Number.isFinite(local[i]) ? local[i] - tile.luma[i] : NaN;
    // strong edges
    const sm = boxBlur(tile.luma, W, H, 1);
    const mag = new Float32Array(W * H).fill(NaN);
    const vals: number[] = [];
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const g = (dx: number, dy: number) => sm[(y + dy) * W + x + dx];
        const gx = g(1, -1) + 2 * g(1, 0) + g(1, 1) - g(-1, -1) - 2 * g(-1, 0) - g(-1, 1);
        const gy = g(-1, 1) + 2 * g(0, 1) + g(1, 1) - g(-1, -1) - 2 * g(0, -1) - g(1, -1);
        const m = Math.hypot(gx, gy);
        if (Number.isFinite(m)) { mag[y * W + x] = m; vals.push(m); }
    }
    vals.sort((a, b) => a - b);
    const thr = vals.length ? vals[Math.floor(0.85 * (vals.length - 1))] : Infinity;
    const edge = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) edge[i] = mag[i] >= thr ? 1 : 0;
    return { tile, dark, edgeDist: distanceTransform(edge, W, H) };
}

/** Chamfer (3-4) distance in pixels to the nearest set pixel. */
export function distanceTransform(mask: Uint8Array, W: number, H: number): Float32Array {
    const d = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) d[i] = mask[i] ? 0 : 1e9;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 3);
        if (y > 0) { d[i] = Math.min(d[i], d[i - W] + 3); if (x > 0) d[i] = Math.min(d[i], d[i - W - 1] + 4); if (x < W - 1) d[i] = Math.min(d[i], d[i - W + 1] + 4); }
    }
    for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
        const i = y * W + x;
        if (x < W - 1) d[i] = Math.min(d[i], d[i + 1] + 3);
        if (y < H - 1) { d[i] = Math.min(d[i], d[i + W] + 3); if (x < W - 1) d[i] = Math.min(d[i], d[i + W + 1] + 4); if (x > 0) d[i] = Math.min(d[i], d[i + W - 1] + 4); }
    }
    for (let i = 0; i < W * H; i++) d[i] /= 3;
    return d;
}

export interface WallCompare { face: number; key: string; areaM2: number; windowNcc: number; edgeDistM: number; depthMaeM: number; depthWithin015: number; openingShare: number }

/**
 * Compares a model's offset map on a wall (metres along the normal, NaN where the model is not) with the tile: window NCC
 * (openings = offset below -0.05 m against the photo's darkness), edge distance (the openings' border pixels to the
 * photo's strong edges, metres) and depth agreement (the offsets against the tile's ortho depth, both clamped to the slab).
 */
export function compareWall(ev: WallEvidence, offset: Float32Array): WallCompare {
    const f = ev.tile.face, W = f.width, H = f.height;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0, open = 0, cover = 0;
    const errs: number[] = [];
    const isOpen = (i: number) => Number.isFinite(offset[i]) && offset[i] < -0.05;
    for (let i = 0; i < W * H; i++) {
        if (!Number.isFinite(offset[i])) continue;
        cover++;
        const m = isOpen(i) ? 1 : 0;
        open += m;
        const dk = ev.dark[i];
        if (Number.isFinite(dk)) { sx += m; sy += dk; sxx += m * m; syy += dk * dk; sxy += m * dk; n++; }
        const td = ev.tile.depth[i];
        if (Number.isFinite(td)) errs.push(Math.abs(Math.max(-1.5, Math.min(0.8, offset[i])) - Math.max(-1.5, Math.min(0.8, td))));
    }
    const vx = sxx / Math.max(1, n) - (sx / Math.max(1, n)) ** 2, vy = syy / Math.max(1, n) - (sy / Math.max(1, n)) ** 2;
    const ncc = n > 10 && vx > 1e-9 && vy > 1e-9 ? (sxy / n - (sx / n) * (sy / n)) / Math.sqrt(vx * vy) : 0;
    // border pixels of the openings
    let dsum = 0, dn = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (!isOpen(i)) continue;
        if (isOpen(i - 1) && isOpen(i + 1) && isOpen(i - W) && isOpen(i + W)) continue;
        if (!Number.isFinite(ev.tile.luma[i])) continue;
        dsum += Math.min(ev.edgeDist[i], 40); dn++;
    }
    errs.sort((a, b) => a - b);
    return {
        face: f.index, key: f.key, areaM2: f.area, windowNcc: ncc, edgeDistM: dn ? (dsum / dn) * f.pixel : NaN,
        depthMaeM: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : NaN, depthWithin015: errs.length ? errs.filter(e => e <= 0.15).length / errs.length : 0,
        openingShare: cover ? open / cover : 0
    };
}

/** The model's offset on a wall from its rendered mesh (the outermost surface within the slab). */
export function renderedWallOffset(model: Float32Array, f: MassingFace): Float32Array {
    const d = rasterOrtho(model, wallCamera(f), -0.8, 1.5);
    for (let i = 0; i < d.length; i++) d[i] = Number.isFinite(d[i]) ? -d[i] : NaN;
    return d;
}

/**
 * The same offset map drawn straight from the program (the adjustment's fast path): the wall 0, its openings at minus their
 * recess, swept bands and face sweeps at their projection over their rows or columns. It matches renderedWallOffset to
 * within a pixel at the program's edges (checked in the test).
 */
export function programWallOffset(f: MassingFace, openings: OpeningItem[], sweeps: SweepItem[], faceSweeps: FaceSweepItem[], inside?: Uint8Array): Float32Array {
    const W = f.width, H = f.height, d = new Float32Array(W * H).fill(NaN);
    if (inside) { for (let i = 0; i < W * H; i++) if (inside[i]) d[i] = 0; }
    else {
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const s = f.orthoSMin + (x + 0.5) * f.pixel, t = f.orthoTMax - (y + 0.5) * f.pixel;
            if (s >= f.sMin && s <= f.sMax && t >= f.tBottom && t <= f.tMax) d[y * W + x] = 0;
        }
    }
    const rect = (s0: number, s1: number, t0: number, t1: number, v: number, max: boolean) => {
        const [xa, ya] = faceToPixel(f, s0, t1), [xb, yb] = faceToPixel(f, s1, t0);
        for (let y = Math.max(0, Math.round(ya)); y < Math.min(H, Math.round(yb)); y++) for (let x = Math.max(0, Math.round(xa)); x < Math.min(W, Math.round(xb)); x++) {
            const i = y * W + x;
            if (!Number.isFinite(d[i])) continue;
            d[i] = max ? Math.max(d[i], v) : v;
        }
    };
    for (const o of openings) if (o.face === f.key) rect(o.s0, o.s1, o.t0, o.t1, -o.depth, false);
    for (const sw of sweeps) if (sw.faces.includes(f.key) && !sw.relativeToTop) {
        const ys = sw.profile.map(q => q[1]), proj = Math.max(...sw.profile.map(q => q[0]));
        if (proj > 0) rect(f.sMin, f.sMax, Math.min(...ys), Math.max(...ys), Math.min(0.8, proj), true);
    }
    for (const fs of faceSweeps) if (fs.face === f.key && fs.axis === 1) {
        const cs = fs.profile.map(q => q[1]), proj = Math.max(...fs.profile.map(q => q[0]));
        for (const [a0, a1, dc] of fs.placements) rect(dc + Math.min(...cs), dc + Math.max(...cs), a0, a1, Math.min(0.8, proj), true);
    }
    return d;
}

/** Area-weighted means of wall comparisons. */
export function summariseWalls(walls: WallCompare[]): { walls: number; windowNcc: number; edgeDistM: number; depthMaeM: number; depthWithin015: number } {
    const w = walls.filter(c => Number.isFinite(c.depthMaeM));
    const A = w.reduce((a, c) => a + c.areaM2, 0) || 1;
    const mean = (k: (c: WallCompare) => number) => w.filter(c => Number.isFinite(k(c))).reduce((a, c) => a + k(c) * c.areaM2, 0) / (w.filter(c => Number.isFinite(k(c))).reduce((a, c) => a + c.areaM2, 0) || A);
    return { walls: w.length, windowNcc: mean(c => c.windowNcc), edgeDistM: mean(c => c.edgeDistM), depthMaeM: mean(c => c.depthMaeM), depthWithin015: mean(c => c.depthWithin015) };
}
