/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A line drawing of the scan, the way an elevation or a plan draws a building: its silhouette and its crease edges,
 * hidden-line removed, from four cardinal directions and from above. This is the whole-building complement to pipeline
 * K's per-facade rectify overlay (rectify-overlay.ts, `<ortho>_lines.png`): that one shows what the straightening read
 * on one wall's photo; this one shows what the scan's own geometry is, measured, on every surface at once, including the
 * roofs, terraces and setbacks no facade ortho covers. Diagnostic and reference only: nothing downstream reads it yet.
 *
 * Method (classic hidden-line removal, no model call, geometry only):
 *  1. The scan's triangles are welded by position (a shared vertex gets one id) and their face normals computed. The
 *     views are turned to face the building's own walls: the walls' dominant direction (each wall triangle's horizontal
 *     normal angle, folded to a quarter turn and weighted by its area, the peak of a smoothed 1-degree histogram), so an
 *     elevation looks straight at a facade instead of foreshortening it (Manhattan's grid stands 29 degrees off east).
 *  2. Every edge is classified by its 1-2 (or, at a weld seam, more) adjacent triangles' facing toward the view and the
 *     dihedral angle between them: a boundary edge of a front-facing triangle, or one whose triangles face opposite ways,
 *     is a silhouette edge; one whose two front-facing triangles meet at creaseDeg or more is a crease edge (a cornice,
 *     a setback, a pier's corner). Edges under minEdgeLenM are dropped (mesh noise, not an architectural edge).
 *  3. Every front-facing triangle is rasterised into a depth buffer in the view's own orthographic frame (right, up,
 *     forward; no perspective, as an elevation has none).
 *  4. Each classified edge is sampled along its length; a sample is drawn only where its own depth is at or in front of
 *     the depth buffer there (within depthEpsM), so a line behind the surface facing the viewer is not drawn. Silhouettes
 *     are drawn black, creases dark grey and open boundary edges light grey (the scan's own holes, tile cuts and ground
 *     fringe are real edges, drawn, but read after the building's outline).
 *  5. With the textured scan (its photo), the facade detail the geometry is too coarse to hold (windows, bands,
 *     spandrels, mullions: Google's mesh is flat at that scale) is drawn from the photo: the textured triangles rendered
 *     into a luminance image in the same frame (their own depth test), its gradient thinned to one pixel across the edge
 *     and kept above photoEdgeQuantile of the view's covered gradients, drawn mid grey under the geometry's lines.
 * The geometry's lines are measured; the photo's are photo-inferred (an edge in the photo: a window, or a shadow or a
 * smear), and the two are drawn and counted apart.
 */

import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import { drawText } from './photo-match-eval';
import type { TileTriangles } from './tile-texture-transfer';

export interface LineDrawingParams {
    /** World metres per pixel, coarsened automatically so no view's long side passes maxDimPx. */
    pixelM: number;
    maxDimPx: number;
    /** Two front-facing triangles meeting at this angle (degrees) or more are a crease. */
    creaseDeg: number;
    /** An edge shorter than this (its real 3D length) is mesh noise, not drawn. */
    minEdgeLenM: number;
    /** A sample is visible when its own depth is at most this far behind the nearest surface there. */
    depthEpsM: number;
    /** Samples per pixel of an edge's projected length. */
    samplesPerPx: number;
    /** With the photo: a photo pixel is an edge when its gradient passes this quantile of the view's covered pixels' and is a local maximum across the edge. */
    photoEdgeQuantile: number;
}

export const LINE_DRAWING_PARAMS: LineDrawingParams = { pixelM: 0.1, maxDimPx: 4096, creaseDeg: 25, minEdgeLenM: 0.3, depthEpsM: 0.08, samplesPerPx: 1.3, photoEdgeQuantile: 0.85 };

/** forward: the view direction (into the screen); right, up: the screen's axes (both unit, both perpendicular to forward). */
export interface LineDrawingView { name: string; forward: Vec3; right: Vec3; up: Vec3 }

/** North, east, south and west elevations (each the frame before turned -90 degrees about the vertical about the last) and the roof plan from above. */
export const CARDINAL_VIEWS: LineDrawingView[] = [
    { name: 'north', forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0] },
    { name: 'east', forward: [1, 0, 0], right: [0, 0, 1], up: [0, 1, 0] },
    { name: 'south', forward: [0, 0, 1], right: [-1, 0, 0], up: [0, 1, 0] },
    { name: 'west', forward: [-1, 0, 0], right: [0, 0, -1], up: [0, 1, 0] },
    { name: 'plan', forward: [0, -1, 0], right: [1, 0, 0], up: [0, 0, -1] }
];

export interface LineDrawingReport {
    version: string;
    params: LineDrawingParams;
    /** The turn (degrees, about the vertical) the cardinal views were given to face the building's walls; 0 when views were given. */
    wallAzimuthDeg: number;
    triangles: number; weldedVertices: number; edges: number;
    views: Array<{
        name: string; width: number; height: number; pixelM: number;
        /** The world point at the image's top-left pixel, and the axes, so a pixel maps back to the scan's frame. */
        originU: number; originV: number; right: Vec3; up: Vec3; forward: Vec3;
        frontFacingTriangles: number;
        /** Candidates found and samples actually drawn, by class. */
        silhouette: { candidates: number; drawn: number }; crease: { candidates: number; drawn: number }; boundary: { candidates: number; drawn: number };
        /** With the photo: its pixels drawn (covered by the textured scan) and those drawn as photo edges (photo-inferred). */
        photo?: { covered: number; edgePixels: number; threshold: number };
        ms: number;
    }>;
    ms: number;
}

export const LINE_DRAWING_VERSION = 'building-line-drawing/3';

// --- geometry -----------------------------------------------------------------------------------------------------

/** A triangle faces the view only when its normal points back at it by more than this (an edge-on face, seen exactly side on, is not front-facing: rounding would otherwise draw its far edge over its near one). */
const FACING_EPS = 1e-3;

interface Mesh { P: Float64Array; tris: Int32Array; normal: Float64Array; triCount: number }

/** Welds a triangle soup (9 floats per triangle) by position (1 mm grid); drops degenerate triangles. */
function weld(positions: Float32Array | Float64Array, gridM = 0.001): Mesh {
    const key = (x: number, y: number, z: number) => `${Math.round(x / gridM)},${Math.round(y / gridM)},${Math.round(z / gridM)}`;
    const id = new Map<string, number>();
    const px: number[] = [], py: number[] = [], pz: number[] = [];
    const vid = (x: number, y: number, z: number) => {
        const k = key(x, y, z);
        let v = id.get(k);
        if (v === undefined) { v = px.length; id.set(k, v); px.push(x); py.push(y); pz.push(z); }
        return v;
    };
    const nTri = Math.floor(positions.length / 9);
    const tris: number[] = [], normal: number[] = [];
    for (let t = 0; t < nTri; t++) {
        const o = 9 * t;
        const a = vid(positions[o], positions[o + 1], positions[o + 2]);
        const b = vid(positions[o + 3], positions[o + 4], positions[o + 5]);
        const c = vid(positions[o + 6], positions[o + 7], positions[o + 8]);
        if (a === b || b === c || a === c) continue;
        const abx = px[b] - px[a], aby = py[b] - py[a], abz = pz[b] - pz[a];
        const acx = px[c] - px[a], acy = py[c] - py[a], acz = pz[c] - pz[a];
        const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
        const len = Math.hypot(nx, ny, nz);
        if (!(len > 1e-9)) continue; // a sliver with no area: no normal, no facing, no edges of its own
        tris.push(a, b, c); normal.push(nx / len, ny / len, nz / len);
    }
    const P = new Float64Array(px.length * 3);
    for (let i = 0; i < px.length; i++) { P[3 * i] = px[i]; P[3 * i + 1] = py[i]; P[3 * i + 2] = pz[i]; }
    return { P, tris: Int32Array.from(tris), normal: Float64Array.from(normal), triCount: tris.length / 3 };
}

interface EdgeClass { a: number; b: number; kind: 'silhouette' | 'crease' | 'boundary' }

/** Every edge of `m` facing `forward` (dot(normal, forward) < 0) that is a silhouette, crease or front-facing boundary, at least minEdgeLenM long. */
function classifyEdges(m: Mesh, forward: Vec3, creaseCos: number, minEdgeLenM: number): EdgeClass[] {
    const faces = new Map<number, number[]>(); // edge key -> triangle indices (usually 1-2; more at a weld seam)
    const key = (a: number, b: number) => (a < b ? a * 0x100000 + b : b * 0x100000 + a);
    for (let t = 0; t < m.triCount; t++) {
        const a = m.tris[3 * t], b = m.tris[3 * t + 1], c = m.tris[3 * t + 2];
        for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
            const k = key(u, v);
            (faces.get(k) ?? faces.set(k, []).get(k)!).push(t);
        }
    }
    const front = (t: number) => m.normal[3 * t] * forward[0] + m.normal[3 * t + 1] * forward[1] + m.normal[3 * t + 2] * forward[2] < -FACING_EPS;
    const out: EdgeClass[] = [];
    for (const [k, tris] of faces) {
        const a = Math.floor(k / 0x100000), b = k % 0x100000;
        const dx = m.P[3 * a] - m.P[3 * b], dy = m.P[3 * a + 1] - m.P[3 * b + 1], dz = m.P[3 * a + 2] - m.P[3 * b + 2];
        if (Math.hypot(dx, dy, dz) < minEdgeLenM) continue;
        if (tris.length === 1) { if (front(tris[0])) out.push({ a, b, kind: 'boundary' }); continue; }
        let silhouette = false, maxCreaseCos = 1;
        for (let i = 0; i < tris.length; i++) for (let j = i + 1; j < tris.length; j++) {
            const fi = front(tris[i]), fj = front(tris[j]);
            if (fi !== fj) { silhouette = true; continue; }
            if (!fi) continue; // both back-facing: not visible from here
            const dot = m.normal[3 * tris[i]] * m.normal[3 * tris[j]] + m.normal[3 * tris[i] + 1] * m.normal[3 * tris[j] + 1] + m.normal[3 * tris[i] + 2] * m.normal[3 * tris[j] + 2];
            maxCreaseCos = Math.min(maxCreaseCos, dot);
        }
        if (silhouette) out.push({ a, b, kind: 'silhouette' });
        else if (maxCreaseCos <= creaseCos) out.push({ a, b, kind: 'crease' });
    }
    return out;
}

// --- rasterising and the drawing -----------------------------------------------------------------------------------

interface Canvas { W: number; H: number; rgb: Uint8Array }
function put(c: Canvas, x: number, y: number, a: number): void {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= c.W || y >= c.H) return;
    const o = (y * c.W + x) * 3, v = Math.round(255 * (1 - a));
    for (let k = 0; k < 3; k++) c.rgb[o + k] = Math.min(c.rgb[o + k], v);
}

/**
 * The photo's edges in a view's frame (see the file comment, 5): the textured triangles' luminance rendered with their own
 * depth test (bilinear texels, perceptual lightness so shade does not hide an edge), its Sobel gradient, and the pixels
 * that pass the quantile and are a local maximum across the gradient. Returns the edge mask and its counts.
 */
function photoEdges(photo: TileTriangles, view: LineDrawingView, W: number, H: number, col: (u: number) => number, row: (v: number) => number, P: LineDrawingParams): { edge: Uint8Array; covered: number; edgePixels: number; threshold: number } {
    const { forward, right, up } = view;
    const N = W * H, depth = new Float32Array(N).fill(Infinity), lum = new Float32Array(N).fill(NaN);
    const nTri = photo.positions.length / 9, rgb = new Float64Array(3);
    const sample = (ti: number, u: number, v: number): number => {
        const k = photo.texture[ti];
        if (k < 0) { const f = photo.flatLinear; rgb[0] = f[3 * ti]; rgb[1] = f[3 * ti + 1]; rgb[2] = f[3 * ti + 2]; }
        else {
            const tex = photo.textures[k], wrap = (x: number, n: number, rep: boolean) => (rep ? ((x % n) + n) % n : Math.min(n - 1, Math.max(0, x)));
            const fx = u * tex.width - 0.5, fy = v * tex.height - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
            const xa = wrap(x0, tex.width, tex.repeatS), xb = wrap(x0 + 1, tex.width, tex.repeatS), ya = wrap(y0, tex.height, tex.repeatT), yb = wrap(y0 + 1, tex.height, tex.repeatT);
            for (let c = 0; c < 3; c++) { const L = tex.linear; rgb[c] = (L[(ya * tex.width + xa) * 3 + c] * (1 - tx) + L[(ya * tex.width + xb) * 3 + c] * tx) * (1 - ty) + (L[(yb * tex.width + xa) * 3 + c] * (1 - tx) + L[(yb * tex.width + xb) * 3 + c] * tx) * ty; }
        }
        return Math.cbrt(Math.max(0, 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]));
    };
    const dot3 = (o: number, a: Vec3) => photo.positions[o] * a[0] + photo.positions[o + 1] * a[1] + photo.positions[o + 2] * a[2];
    for (let t = 0; t < nTri; t++) {
        if (photo.normals[3 * t] * forward[0] + photo.normals[3 * t + 1] * forward[1] + photo.normals[3 * t + 2] * forward[2] >= -FACING_EPS) continue;
        if (photo.fill && photo.fill[t]) continue; // a fill a stage laid where the photo did not reach: not the photo's edge
        const o = 9 * t, cs = [0, 1, 2].map(k => col(dot3(o + 3 * k, right))), rs = [0, 1, 2].map(k => row(dot3(o + 3 * k, up))), ds = [0, 1, 2].map(k => dot3(o + 3 * k, forward));
        const x0 = Math.max(0, Math.floor(Math.min(...cs))), x1 = Math.min(W - 1, Math.ceil(Math.max(...cs))), y0 = Math.max(0, Math.floor(Math.min(...rs))), y1 = Math.min(H - 1, Math.ceil(Math.max(...rs)));
        if (x1 < x0 || y1 < y0) continue;
        const area = (cs[1] - cs[0]) * (rs[2] - rs[0]) - (cs[2] - cs[0]) * (rs[1] - rs[0]);
        if (!(Math.abs(area) > 1e-9)) continue;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const px = x + 0.5, py = y + 0.5;
            const w0 = ((cs[1] - px) * (rs[2] - py) - (cs[2] - px) * (rs[1] - py)) / area, w1 = ((cs[2] - px) * (rs[0] - py) - (cs[0] - px) * (rs[2] - py)) / area, w2 = 1 - w0 - w1;
            if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
            const d = w0 * ds[0] + w1 * ds[1] + w2 * ds[2], i = y * W + x;
            if (d >= depth[i]) continue;
            depth[i] = d;
            const uv = photo.uvs, q = 6 * t;
            lum[i] = sample(t, w0 * uv[q] + w1 * uv[q + 2] + w2 * uv[q + 4], w0 * uv[q + 1] + w1 * uv[q + 3] + w2 * uv[q + 5]);
        }
    }
    // Sobel, only where all eight neighbours are covered (a photo's edge against the background is the silhouette's job)
    const gx = new Float32Array(N), gy = new Float32Array(N), mag = new Float32Array(N);
    const mags: number[] = [];
    let covered = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (!Number.isFinite(lum[i])) continue;
        ++covered;
        let ok = true;
        for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) if (!Number.isFinite(lum[i + dy * W + dx])) { ok = false; break; }
        if (!ok) continue;
        const a = (dx: number, dy: number) => lum[i + dy * W + dx];
        gx[i] = (a(1, -1) + 2 * a(1, 0) + a(1, 1)) - (a(-1, -1) + 2 * a(-1, 0) + a(-1, 1));
        gy[i] = (a(-1, 1) + 2 * a(0, 1) + a(1, 1)) - (a(-1, -1) + 2 * a(0, -1) + a(1, -1));
        mag[i] = Math.hypot(gx[i], gy[i]);
        mags.push(mag[i]);
    }
    const edge = new Uint8Array(N);
    if (!mags.length) return { edge, covered, edgePixels: 0, threshold: 0 };
    mags.sort((a, b) => a - b);
    const threshold = mags[Math.min(mags.length - 1, Math.floor(mags.length * P.photoEdgeQuantile))];
    let edgePixels = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x, g = mag[i];
        if (!(g > threshold)) continue;
        // a local maximum across the edge (the gradient's direction, to the nearest of four)
        const ang = Math.atan2(gy[i], gx[i]), q = ((Math.round(ang / (Math.PI / 4)) % 4) + 4) % 4;
        const [dx, dy] = [[1, 0], [1, 1], [0, 1], [-1, 1]][q];
        if (g < mag[i + dy * W + dx] || g < mag[i - dy * W - dx]) continue;
        edge[i] = 1; ++edgePixels;
    }
    return { edge, covered, edgePixels, threshold: Math.round(threshold * 1e4) / 1e4 };
}

/** A view's image fixed in advance (a plane's ortho frame): its top-left in the view's axes, its pixel and size. */
interface FixedFrame { uMin: number; vMax: number; pixelM: number; W: number; H: number }

function renderView(m: Mesh, view: LineDrawingView, edges: EdgeClass[], P: LineDrawingParams, t0: number, photo?: TileTriangles, fixed?: FixedFrame, caption = true): { png: { width: number; height: number; rgb: Uint8Array }; stats: LineDrawingReport['views'][number] } {
    const { forward, right, up } = view;
    const u = (i: number) => m.P[3 * i] * right[0] + m.P[3 * i + 1] * right[1] + m.P[3 * i + 2] * right[2];
    const v = (i: number) => m.P[3 * i] * up[0] + m.P[3 * i + 1] * up[1] + m.P[3 * i + 2] * up[2];
    const d = (i: number) => m.P[3 * i] * forward[0] + m.P[3 * i + 1] * forward[1] + m.P[3 * i + 2] * forward[2];
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity, pixelM = P.pixelM, W: number, H: number;
    if (fixed) ({ uMin, vMax, pixelM, W, H } = fixed);
    else {
        for (let i = 0; i < m.P.length / 3; i++) { const uu = u(i), vv = v(i); if (uu < uMin) uMin = uu; if (uu > uMax) uMax = uu; if (vv < vMin) vMin = vv; if (vv > vMax) vMax = vv; }
        const long = Math.max(uMax - uMin, vMax - vMin);
        if (long / pixelM > P.maxDimPx) pixelM = long / P.maxDimPx;
        W = Math.max(2, Math.ceil((uMax - uMin) / pixelM) + 2); H = Math.max(2, Math.ceil((vMax - vMin) / pixelM) + 2);
    }
    const col = (uu: number) => (uu - uMin) / pixelM, row = (vv: number) => (vMax - vv) / pixelM; // row 0 at the top (vMax)

    const depthBuf = new Float32Array(W * H).fill(Infinity);
    let frontFacing = 0;
    for (let t = 0; t < m.triCount; t++) {
        const a = m.tris[3 * t], b = m.tris[3 * t + 1], c = m.tris[3 * t + 2];
        if (m.normal[3 * t] * forward[0] + m.normal[3 * t + 1] * forward[1] + m.normal[3 * t + 2] * forward[2] >= -FACING_EPS) continue; // backface or edge-on: not an occluder
        ++frontFacing;
        const ca = col(u(a)), ra = row(v(a)), cb = col(u(b)), rb = row(v(b)), cc = col(u(c)), rc = row(v(c));
        const x0 = Math.max(0, Math.floor(Math.min(ca, cb, cc))), x1 = Math.min(W - 1, Math.ceil(Math.max(ca, cb, cc)));
        const y0 = Math.max(0, Math.floor(Math.min(ra, rb, rc))), y1 = Math.min(H - 1, Math.ceil(Math.max(ra, rb, rc)));
        if (x1 < x0 || y1 < y0) continue;
        const area = (cb - ca) * (rc - ra) - (cc - ca) * (rb - ra);
        if (!(Math.abs(area) > 1e-9)) continue;
        const da = d(a), db = d(b), dc = d(c);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const px = x + 0.5, py = y + 0.5;
            const w0 = ((cb - px) * (rc - py) - (cc - px) * (rb - py)) / area;
            const w1 = ((cc - px) * (ra - py) - (ca - px) * (rc - py)) / area;
            const w2 = 1 - w0 - w1;
            if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
            const depth = w0 * da + w1 * db + w2 * dc, i = y * W + x;
            if (depth < depthBuf[i]) depthBuf[i] = depth;
        }
    }

    const canvas: Canvas = { W, H, rgb: new Uint8Array(W * H * 3).fill(255) };
    // the photo's edges first, mid grey: the geometry's lines are drawn over them
    let photoStats: { covered: number; edgePixels: number; threshold: number } | undefined;
    if (photo) {
        const pe = photoEdges(photo, view, W, H, col, row, P);
        for (let i = 0; i < W * H; i++) if (pe.edge[i]) put(canvas, i % W, Math.floor(i / W), 0.5);
        photoStats = { covered: pe.covered, edgePixels: pe.edgePixels, threshold: pe.threshold };
    }
    const stats = { silhouette: { candidates: 0, drawn: 0 }, crease: { candidates: 0, drawn: 0 }, boundary: { candidates: 0, drawn: 0 } };
    const ink = { silhouette: 1, crease: 0.7, boundary: 0.3 } as const; // the share of black each class is drawn with
    for (const e of edges) {
        stats[e.kind].candidates++;
        const ca = col(u(e.a)), ra = row(v(e.a)), cb = col(u(e.b)), rb = row(v(e.b)), da = d(e.a), db = d(e.b);
        const pxLen = Math.hypot(cb - ca, rb - ra), n = Math.max(1, Math.round(pxLen * P.samplesPerPx));
        let any = false;
        for (let s = 0; s <= n; s++) {
            const f = s / n, x = ca + (cb - ca) * f, y = ra + (rb - ra) * f, depth = da + (db - da) * f;
            const xi = Math.round(x), yi = Math.round(y);
            if (xi < 0 || yi < 0 || xi >= W || yi >= H) continue;
            if (depth <= depthBuf[yi * W + xi] + P.depthEpsM) { put(canvas, x, y, ink[e.kind]); any = true; }
        }
        if (any) stats[e.kind].drawn++;
    }
    const captionText = `${view.name.toUpperCase()}  ${Math.round(pixelM * 1000) / 1000} M/PX  SILHOUETTE ${stats.silhouette.drawn}/${stats.silhouette.candidates}  CREASE ${stats.crease.drawn}/${stats.crease.candidates}  BOUNDARY ${stats.boundary.drawn}/${stats.boundary.candidates}${photoStats ? `  PHOTO EDGES ${photoStats.edgePixels} PX` : ''}`;
    if (caption) drawText(canvas.rgb, canvas.W, canvas.H, 4, 4, captionText, 1, [0, 0, 0]);
    return {
        png: { width: W, height: H, rgb: canvas.rgb },
        stats: { name: view.name, width: W, height: H, pixelM, originU: uMin, originV: vMax, right: view.right, up: view.up, forward: view.forward, frontFacingTriangles: frontFacing, ...stats, ...(photoStats ? { photo: photoStats } : {}), ms: Date.now() - t0 }
    };
}

/** The walls' dominant direction (degrees in [0, 90)): each near-vertical triangle's horizontal normal angle folded to a quarter turn, weighted by area; the peak of a 1-degree histogram smoothed over 5 degrees, refined to the area-weighted mean of the angles within 4 degrees of it. */
export function wallAzimuthDeg(m: { normal: Float64Array; P: Float64Array; tris: Int32Array; triCount: number }): number {
    const hist = new Float64Array(90), angles: number[] = [], areas: number[] = [];
    for (let t = 0; t < m.triCount; t++) {
        const nx = m.normal[3 * t], ny = m.normal[3 * t + 1], nz = m.normal[3 * t + 2];
        if (Math.abs(ny) > 0.3) continue;
        const a = m.tris[3 * t], b = m.tris[3 * t + 1], c = m.tris[3 * t + 2];
        const abx = m.P[3 * b] - m.P[3 * a], aby = m.P[3 * b + 1] - m.P[3 * a + 1], abz = m.P[3 * b + 2] - m.P[3 * a + 2];
        const acx = m.P[3 * c] - m.P[3 * a], acy = m.P[3 * c + 1] - m.P[3 * a + 1], acz = m.P[3 * c + 2] - m.P[3 * a + 2];
        const area = Math.hypot(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx) / 2;
        let deg = (Math.atan2(nz, nx) * 180) / Math.PI;
        deg = ((deg % 90) + 90) % 90;
        hist[Math.min(89, Math.floor(deg))] += area;
        angles.push(deg); areas.push(area);
    }
    let best = 0, bestV = -1;
    for (let i = 0; i < 90; i++) { let v = 0; for (let k = -2; k <= 2; k++) v += hist[(i + k + 90) % 90]; if (v > bestV) { bestV = v; best = i; } }
    // refine: the weighted mean of the angles near the peak, each taken on the peak's side of the quarter-turn wrap
    const peak = best + 0.5;
    let sum = 0, wsum = 0;
    for (let i = 0; i < angles.length; i++) {
        let d = angles[i] - peak;
        d -= 90 * Math.round(d / 90);
        if (Math.abs(d) > 4) continue;
        sum += (peak + d) * areas[i]; wsum += areas[i];
    }
    const mean = wsum > 0 ? sum / wsum : peak;
    return Math.round((((mean % 90) + 90) % 90) * 100) / 100;
}

/** A view turned by deg about the vertical (its forward, right and up all turned). */
function turned(v: LineDrawingView, deg: number): LineDrawingView {
    const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    const rot = (p: Vec3): Vec3 => [p[0] * c - p[2] * s, p[1], p[0] * s + p[2] * c];
    return { name: v.name, forward: rot(v.forward), right: rot(v.right), up: rot(v.up) };
}

/**
 * The scan's silhouette and crease, hidden-line removed, from each view (default: north, east, south, west and the
 * roof plan). `positions` is a triangle soup (9 floats a triangle) in the frame the result is reported in (the scan's
 * own, untransformed, as `clay.glb` carries no node transforms).
 */
export function renderBuildingLineDrawings(positions: Float32Array | Float64Array, views?: LineDrawingView[], P: LineDrawingParams = LINE_DRAWING_PARAMS, photo?: TileTriangles): { report: LineDrawingReport; pngs: Array<{ name: string; width: number; height: number; rgb: Uint8Array }> } {
    const t0 = Date.now();
    const m = weld(positions);
    // with no views given, the cardinal ones turned to face the building's walls
    const azimuth = views ? 0 : wallAzimuthDeg(m);
    const useViews = views ?? CARDINAL_VIEWS.map(v => turned(v, azimuth));
    const creaseCos = Math.cos((P.creaseDeg * Math.PI) / 180);
    const pngs: Array<{ name: string; width: number; height: number; rgb: Uint8Array }> = [];
    const viewReports: LineDrawingReport['views'] = [];
    let edgeTotal = 0;
    for (const view of useViews) {
        const tv = Date.now();
        const edges = classifyEdges(m, view.forward, creaseCos, P.minEdgeLenM);
        edgeTotal += edges.length;
        const { png, stats } = renderView(m, view, edges, P, tv, photo);
        pngs.push({ name: view.name, ...png });
        viewReports.push(stats);
    }
    return {
        report: { version: LINE_DRAWING_VERSION, params: P, wallAzimuthDeg: azimuth, triangles: m.triCount, weldedVertices: m.P.length / 3, edges: edgeTotal, views: viewReports, ms: Date.now() - t0 },
        pngs
    };
}

/** A plane's ortho frame as facades.json and planes.json carry it: world = centroid + s axisS + t axisT; pixel x at s = orthoSMin + x pixel, y at t = orthoTMax - y pixel. */
export interface PlaneOrthoFrame { centroid: Vec3; normal: Vec3; axisS: Vec3; axisT: Vec3; orthoSMin: number; orthoTMax: number; pixel: number; width: number; height: number }

/** How near the plane a triangle must lie (its centroid, along the plane's normal) to be drawn on the plane's sheet. */
export const PLANE_LINES_BAND_M = 2.5;
/**
 * A plane sheet keeps only edges within this angle (degrees) of the plane's axes: a change of structure on a wall or roof
 * (a setback, a ledge, a pier's side) runs along them, where a fold between the scan's large triangles runs any way.
 */
export const PLANE_LINES_AXIS_DEG = 3;

/**
 * The scan's lines on one plane, in the plane's own ortho frame and pixel grid (scaled by `scale`), for a reader to lay
 * beside the plane's photo: the silhouette and crease edges of the scan within PLANE_LINES_BAND_M of the plane and over
 * its rectangle (1 m margin), seen straight on from in front of it, hidden lines removed, no caption; only edges within
 * PLANE_LINES_AXIS_DEG of the plane's axes, and no open edges (the scan's tile cuts and holes are no structure).
 * Geometry only: measured. Returns undefined when no triangle of the scan lies on the plane.
 */
export function renderPlaneLines(positions: Float32Array | Float64Array, f: PlaneOrthoFrame, scale = 1, P: LineDrawingParams = LINE_DRAWING_PARAMS): { width: number; height: number; rgb: Uint8Array; drawn: number } | undefined {
    const n = f.normal, s = f.axisS, t = f.axisT, c = f.centroid;
    const sMax = f.orthoSMin + f.width * f.pixel, tMin = f.orthoTMax - f.height * f.pixel;
    // a point on the plane's sheet: within the band of the plane and over its rectangle (1 m margin)
    const onSheet = (px: number, py: number, pz: number) => {
        const x = px - c[0], y = py - c[1], z = pz - c[2];
        if (Math.abs(x * n[0] + y * n[1] + z * n[2]) > PLANE_LINES_BAND_M) return false;
        const ss = x * s[0] + y * s[1] + z * s[2], tt = x * t[0] + y * t[1] + z * t[2];
        return ss >= f.orthoSMin - 1 && ss <= sMax + 1 && tt >= tMin - 1 && tt <= f.orthoTMax + 1;
    };
    // every triangle touching the sheet (a corner on it), so an edge on the sheet keeps both its triangles (the roof
    // beside a wall's top edge stands mostly off the sheet, but makes that edge a silhouette, not an open edge)
    const keep: number[] = [];
    for (let k = 0; k + 8 < positions.length; k += 9) {
        if (!onSheet(positions[k], positions[k + 1], positions[k + 2]) && !onSheet(positions[k + 3], positions[k + 4], positions[k + 5]) && !onSheet(positions[k + 6], positions[k + 7], positions[k + 8])) continue;
        for (let q = 0; q < 9; q++) keep.push(positions[k + q]);
    }
    if (!keep.length) return undefined;
    const m = weld(Float64Array.from(keep));
    const view: LineDrawingView = { name: 'plane', forward: [-n[0], -n[1], -n[2]], right: s, up: t };
    const sinAxis = Math.sin((PLANE_LINES_AXIS_DEG * Math.PI) / 180);
    const edges = classifyEdges(m, view.forward, Math.cos((P.creaseDeg * Math.PI) / 180), P.minEdgeLenM).filter(e => {
        if (e.kind === 'boundary') return false;
        if (!onSheet(m.P[3 * e.a], m.P[3 * e.a + 1], m.P[3 * e.a + 2]) || !onSheet(m.P[3 * e.b], m.P[3 * e.b + 1], m.P[3 * e.b + 2])) return false;
        const dx = m.P[3 * e.b] - m.P[3 * e.a], dy = m.P[3 * e.b + 1] - m.P[3 * e.a + 1], dz = m.P[3 * e.b + 2] - m.P[3 * e.a + 2];
        const es = dx * s[0] + dy * s[1] + dz * s[2], et = dx * t[0] + dy * t[1] + dz * t[2], len = Math.hypot(es, et);
        return len > 0 && Math.min(Math.abs(es), Math.abs(et)) / len <= sinAxis;
    });
    const dotC = (a: Vec3) => c[0] * a[0] + c[1] * a[1] + c[2] * a[2];
    const W = Math.max(2, Math.round(f.width * scale)), H = Math.max(2, Math.round(f.height * scale));
    const { png, stats } = renderView(m, view, edges, P, Date.now(), undefined, { uMin: dotC(s) + f.orthoSMin, vMax: dotC(t) + f.orthoTMax, pixelM: f.pixel / scale, W, H }, false);
    return { ...png, drawn: stats.silhouette.drawn + stats.crease.drawn + stats.boundary.drawn };
}
