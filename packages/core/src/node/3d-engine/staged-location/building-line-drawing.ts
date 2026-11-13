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
 *  1. The scan's triangles are welded by position (a shared vertex gets one id) and their face normals computed.
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
 * Every edge comes straight from the scan: the whole drawing is measured, never generated or inferred.
 */

import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import { drawText } from './photo-match-eval';

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
}

export const LINE_DRAWING_PARAMS: LineDrawingParams = { pixelM: 0.12, maxDimPx: 2400, creaseDeg: 25, minEdgeLenM: 0.3, depthEpsM: 0.08, samplesPerPx: 1.3 };

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
    triangles: number; weldedVertices: number; edges: number;
    views: Array<{
        name: string; width: number; height: number; pixelM: number;
        /** The world point at the image's top-left pixel, and the axes, so a pixel maps back to the scan's frame. */
        originU: number; originV: number; right: Vec3; up: Vec3; forward: Vec3;
        frontFacingTriangles: number;
        /** Candidates found and samples actually drawn, by class. */
        silhouette: { candidates: number; drawn: number }; crease: { candidates: number; drawn: number }; boundary: { candidates: number; drawn: number };
        ms: number;
    }>;
    ms: number;
}

export const LINE_DRAWING_VERSION = 'building-line-drawing/1';

// --- geometry -----------------------------------------------------------------------------------------------------

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
    const front = (t: number) => m.normal[3 * t] * forward[0] + m.normal[3 * t + 1] * forward[1] + m.normal[3 * t + 2] * forward[2] < 0;
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

function renderView(m: Mesh, view: LineDrawingView, edges: EdgeClass[], P: LineDrawingParams, t0: number): { png: { width: number; height: number; rgb: Uint8Array }; stats: LineDrawingReport['views'][number] } {
    const { forward, right, up } = view;
    const u = (i: number) => m.P[3 * i] * right[0] + m.P[3 * i + 1] * right[1] + m.P[3 * i + 2] * right[2];
    const v = (i: number) => m.P[3 * i] * up[0] + m.P[3 * i + 1] * up[1] + m.P[3 * i + 2] * up[2];
    const d = (i: number) => m.P[3 * i] * forward[0] + m.P[3 * i + 1] * forward[1] + m.P[3 * i + 2] * forward[2];
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (let i = 0; i < m.P.length / 3; i++) { const uu = u(i), vv = v(i); if (uu < uMin) uMin = uu; if (uu > uMax) uMax = uu; if (vv < vMin) vMin = vv; if (vv > vMax) vMax = vv; }
    let pixelM = P.pixelM;
    const long = Math.max(uMax - uMin, vMax - vMin);
    if (long / pixelM > P.maxDimPx) pixelM = long / P.maxDimPx;
    const W = Math.max(2, Math.ceil((uMax - uMin) / pixelM) + 2), H = Math.max(2, Math.ceil((vMax - vMin) / pixelM) + 2);
    const col = (uu: number) => (uu - uMin) / pixelM, row = (vv: number) => (vMax - vv) / pixelM; // row 0 at the top (vMax)

    const depthBuf = new Float32Array(W * H).fill(Infinity);
    let frontFacing = 0;
    for (let t = 0; t < m.triCount; t++) {
        const a = m.tris[3 * t], b = m.tris[3 * t + 1], c = m.tris[3 * t + 2];
        if (m.normal[3 * t] * forward[0] + m.normal[3 * t + 1] * forward[1] + m.normal[3 * t + 2] * forward[2] >= 0) continue; // backface: not an occluder
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
    const caption = `${view.name.toUpperCase()}  ${Math.round(pixelM * 1000) / 1000} M/PX  SILHOUETTE ${stats.silhouette.drawn}/${stats.silhouette.candidates}  CREASE ${stats.crease.drawn}/${stats.crease.candidates}  BOUNDARY ${stats.boundary.drawn}/${stats.boundary.candidates}`;
    drawText(canvas.rgb, canvas.W, canvas.H, 4, 4, caption, 1, [0, 0, 0]);
    return {
        png: { width: W, height: H, rgb: canvas.rgb },
        stats: { name: view.name, width: W, height: H, pixelM, originU: uMin, originV: vMax, right: view.right, up: view.up, forward: view.forward, frontFacingTriangles: frontFacing, ...stats, ms: Date.now() - t0 }
    };
}

/**
 * The scan's silhouette and crease, hidden-line removed, from each view (default: north, east, south, west and the
 * roof plan). `positions` is a triangle soup (9 floats a triangle) in the frame the result is reported in (the scan's
 * own, untransformed, as `clay.glb` carries no node transforms).
 */
export function renderBuildingLineDrawings(positions: Float32Array | Float64Array, views: LineDrawingView[] = CARDINAL_VIEWS, P: LineDrawingParams = LINE_DRAWING_PARAMS): { report: LineDrawingReport; pngs: Array<{ name: string; width: number; height: number; rgb: Uint8Array }> } {
    const t0 = Date.now();
    const m = weld(positions);
    const creaseCos = Math.cos((P.creaseDeg * Math.PI) / 180);
    const pngs: Array<{ name: string; width: number; height: number; rgb: Uint8Array }> = [];
    const viewReports: LineDrawingReport['views'] = [];
    let edgeTotal = 0;
    for (const view of views) {
        const tv = Date.now();
        const edges = classifyEdges(m, view.forward, creaseCos, P.minEdgeLenM);
        edgeTotal += edges.length;
        const { png, stats } = renderView(m, view, edges, P, tv);
        pngs.push({ name: view.name, ...png });
        viewReports.push(stats);
    }
    return {
        report: { version: LINE_DRAWING_VERSION, params: P, triangles: m.triCount, weldedVertices: m.P.length / 3, edges: edgeTotal, views: viewReports, ms: Date.now() - t0 },
        pngs
    };
}
