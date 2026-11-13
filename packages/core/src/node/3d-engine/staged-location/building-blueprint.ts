/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A staged building drawn as an architect's blueprint: white line work on blueprint blue, four elevations square to its
 * walls and a roof plan, each with a grid, its levels, overall dimensions, a scale bar and a title block. Built from what
 * the pipeline reads, not from a photo's edges:
 *
 *  - the outline: the scan's silhouette and crease edges (building-line-drawing.ts), hidden lines removed, only those
 *    running along the view's axes (within axisDeg): a wall, a setback, a ledge or a pier side runs along them, a fold
 *    between the scan's large triangles runs any way. Measured.
 *  - the windows: each facade's windows as pipeline K read them (window_fit.json: the facade reader's openings and the
 *    window arrays, in each straightened photo's pixels), each a crisp rectangle mapped through its facade's frame onto the
 *    elevation that faces it, drawn where the facade is the surface the viewer sees. Photo-inferred.
 *  - symmetry (pipeline-k/symmetry.ts): each facade's own mirror axis (a facade whose photo matches its mirror at
 *    mirrorNcc or more, and does not merely repeat) drawn as a centre line, and every window mirrored about it into a site
 *    no window touches drawn dashed (generated: inferred from the symmetry); the building's plan mirrors
 *    (scoring planMirrorScore or more) drawn as centre lines on the elevations that see them edge on and across the plan.
 *  - levels: the heights where horizontal outline edges run across levelShare of the elevation's width or more (the
 *    setbacks and parapets; levels within levelMergeM of each other one), each a dashed line labelled with its height
 *    above the scan's lowest point. Measured.
 * The legend says which line is which and where it comes from.
 */

import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import { drawText } from './photo-match-eval';
import { CARDINAL_VIEWS, classifyEdges, FACING_EPS, turned, wallAzimuthDeg, weld, type LineDrawingView, type Mesh, type PlaneOrthoFrame } from './building-line-drawing';
import type { SymmetryReport } from './pipeline-k/symmetry';

/** One facade's windows as pipeline K read them, in its straightened photo's pixels ([x0, y0, x1, y1], y down from its top). */
export interface BlueprintFacade { facadeId: number; frame: PlaneOrthoFrame & { tMin?: number; tMax?: number }; rects: Array<[number, number, number, number]> }

export interface BlueprintInputs {
    facades?: BlueprintFacade[];
    symmetry?: SymmetryReport;
    /** The title block's first line (the building's name or address). */
    title?: string;
    /** A date or run id for the title block. */
    note?: string;
}

export const BLUEPRINT_PARAMS = {
    pixelM: 0.1, maxDimPx: 4096, creaseDeg: 25, minEdgeLenM: 0.3, depthEpsM: 0.08,
    /** Outline edges kept within this angle (degrees) of the view's axes. */
    axisDeg: 3,
    /** A facade faces a view when its normal is within this angle (degrees) of the view's back direction. */
    facingDeg: 25,
    /** A window is drawn when its centre stands at most this far behind the surface the viewer sees there (the facade's frame is its fitted plane, the scan around it). */
    windowDepthM: 1.5,
    /** A facade's mirror axis is drawn (and its windows mirrored) when its photo matches its mirror at this NCC or more. */
    mirrorNcc: 0.75,
    /** A plan mirror is drawn when it scores this or more; on an elevation, when its plane is within planMirrorDeg of the view direction. */
    planMirrorScore: 0.9, planMirrorDeg: 5,
    /** A level is a height where horizontal outline runs across this share of the elevation's width or more. */
    levelShare: 0.35, levelBinM: 0.5,
    /** Levels nearer each other than this (m) are one: the higher kept. */
    levelMergeM: 3,
    gridM: 10, marginPx: 150, titlePx: 170
};
export type BlueprintParams = typeof BLUEPRINT_PARAMS;

export interface BlueprintReport {
    version: string; params: BlueprintParams; wallAzimuthDeg: number;
    views: Array<{
        name: string; label: string; width: number; height: number; pixelM: number; originU: number; originV: number; right: Vec3; up: Vec3; forward: Vec3;
        outlineEdges: number; facades: number; windows: number; mirroredWindows: number; facadeAxes: number; planAxes: number;
        levels: number[]; extentM: [number, number];
    }>;
    ms: number;
}

export const BLUEPRINT_VERSION = 'building-blueprint/1';

const BLUE: Vec3 = [24, 60, 116], INK: Vec3 = [236, 243, 255];

interface Sheet { W: number; H: number; rgb: Uint8Array }
function ink(c: Sheet, x: number, y: number, a: number, r = 0): void {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const xi = Math.round(x) + dx, yi = Math.round(y) + dy;
        if (xi < 0 || yi < 0 || xi >= c.W || yi >= c.H) continue;
        const o = (yi * c.W + xi) * 3;
        for (let k = 0; k < 3; k++) c.rgb[o + k] = Math.round(c.rgb[o + k] * (1 - a) + INK[k] * a);
    }
}
/** A line, optionally dashed (dash pattern in pixels: [on, off] or [on, off, dot-on, off] for a centre line). */
function line(c: Sheet, x0: number, y0: number, x1: number, y1: number, a: number, r = 0, pattern?: number[]): void {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    const period = pattern ? pattern.reduce((p, q) => p + q, 0) : 0;
    for (let i = 0; i <= n; i++) {
        if (pattern) { let ph = i % period, on = true; for (const seg of pattern) { if (ph < seg) break; ph -= seg; on = !on; } if (!on) continue; }
        ink(c, x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, a, r);
    }
}
function text(c: Sheet, x: number, y: number, s: string, scale: number): void { drawText(c.rgb, c.W, c.H, Math.round(x), Math.round(y), s, scale, INK); }
const textW = (s: string, scale: number) => s.length * 6 * scale;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The depth (along forward) of the nearest front-facing triangle at each pixel. */
function depthBuffer(m: Mesh, view: LineDrawingView, W: number, H: number, col: (u: number) => number, row: (v: number) => number): Float32Array {
    const { forward, right, up } = view, buf = new Float32Array(W * H).fill(Infinity);
    const u = (i: number) => m.P[3 * i] * right[0] + m.P[3 * i + 1] * right[1] + m.P[3 * i + 2] * right[2];
    const v = (i: number) => m.P[3 * i] * up[0] + m.P[3 * i + 1] * up[1] + m.P[3 * i + 2] * up[2];
    const d = (i: number) => m.P[3 * i] * forward[0] + m.P[3 * i + 1] * forward[1] + m.P[3 * i + 2] * forward[2];
    for (let t = 0; t < m.triCount; t++) {
        if (m.normal[3 * t] * forward[0] + m.normal[3 * t + 1] * forward[1] + m.normal[3 * t + 2] * forward[2] >= -FACING_EPS) continue;
        const a = m.tris[3 * t], b = m.tris[3 * t + 1], cc = m.tris[3 * t + 2];
        const ca = col(u(a)), ra = row(v(a)), cb = col(u(b)), rb = row(v(b)), c2 = col(u(cc)), r2 = row(v(cc));
        const x0 = Math.max(0, Math.floor(Math.min(ca, cb, c2))), x1 = Math.min(W - 1, Math.ceil(Math.max(ca, cb, c2)));
        const y0 = Math.max(0, Math.floor(Math.min(ra, rb, r2))), y1 = Math.min(H - 1, Math.ceil(Math.max(ra, rb, r2)));
        if (x1 < x0 || y1 < y0) continue;
        const area = (cb - ca) * (r2 - ra) - (c2 - ca) * (rb - ra);
        if (!(Math.abs(area) > 1e-9)) continue;
        const da = d(a), db = d(b), dc = d(cc);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const px = x + 0.5, py = y + 0.5;
            const w0 = ((cb - px) * (r2 - py) - (c2 - px) * (rb - py)) / area, w1 = ((c2 - px) * (ra - py) - (ca - px) * (r2 - py)) / area, w2 = 1 - w0 - w1;
            if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
            const dd = w0 * da + w1 * db + w2 * dc, i = y * W + x;
            if (dd < buf[i]) buf[i] = dd;
        }
    }
    return buf;
}

const iou = (a: number[], b: number[]) => { const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])), i = ix * iy; return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i || 1); };

function renderSheet(m: Mesh, view: LineDrawingView, label: string, inputs: BlueprintInputs, P: BlueprintParams, azimuth: number, groundY: number): { png: Sheet; stats: BlueprintReport['views'][number] } {
    const { forward, right, up } = view, isPlan = Math.abs(forward[1]) > 0.9;
    const u = (i: number) => m.P[3 * i] * right[0] + m.P[3 * i + 1] * right[1] + m.P[3 * i + 2] * right[2];
    const v = (i: number) => m.P[3 * i] * up[0] + m.P[3 * i + 1] * up[1] + m.P[3 * i + 2] * up[2];
    const d = (i: number) => m.P[3 * i] * forward[0] + m.P[3 * i + 1] * forward[1] + m.P[3 * i + 2] * forward[2];
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (let i = 0; i < m.P.length / 3; i++) { const uu = u(i), vv = v(i); if (uu < uMin) uMin = uu; if (uu > uMax) uMax = uu; if (vv < vMin) vMin = vv; if (vv > vMax) vMax = vv; }
    let pixelM = P.pixelM;
    const long = Math.max(uMax - uMin, vMax - vMin);
    if (long / pixelM > P.maxDimPx) pixelM = long / P.maxDimPx;
    const dw = Math.ceil((uMax - uMin) / pixelM) + 1, dh = Math.ceil((vMax - vMin) / pixelM) + 1;
    const M = P.marginPx, W = dw + 2 * M, H = dh + 2 * M + P.titlePx;
    const sheet: Sheet = { W, H, rgb: new Uint8Array(W * H * 3) };
    for (let i = 0; i < W * H; i++) sheet.rgb.set(BLUE, i * 3);
    // drawing pixels (local to the drawing area) and sheet pixels
    const col = (uu: number) => (uu - uMin) / pixelM, row = (vv: number) => (vMax - vv) / pixelM;
    const X = (uu: number) => M + col(uu), Y = (vv: number) => M + row(vv);
    const ts = Math.max(1, Math.min(3, Math.round(Math.min(W, H * 0.6) / 700))), lw = Math.max(0, Math.round(Math.max(dw, dh) / 3000));
    const depth = depthBuffer(m, view, dw, dh, col, row);
    const visibleAt = (uu: number, vv: number, dd: number, eps: number) => { const x = Math.round(col(uu)), y = Math.round(row(vv)); if (x < 0 || y < 0 || x >= dw || y >= dh) return false; let best = Infinity; for (let k = -1; k <= 1; k++) for (let j = -1; j <= 1; j++) { const xx = x + j, yy = y + k; if (xx >= 0 && yy >= 0 && xx < dw && yy < dh) best = Math.min(best, depth[yy * dw + xx]); } return dd <= best + eps; };

    // the grid: every gridM metres, faint, over the drawing area
    for (let g = Math.ceil(uMin / P.gridM) * P.gridM; g <= uMax; g += P.gridM) line(sheet, X(g), M, X(g), M + dh, 0.07);
    const gBase = isPlan ? Math.ceil(vMin / P.gridM) * P.gridM : groundY;
    for (let g = gBase; g <= vMax; g += P.gridM) if (g >= vMin) line(sheet, M, Y(g), M + dw, Y(g), 0.07);
    // the frame
    for (let k = 0; k <= lw; k++) { line(sheet, 12 + k, 12 + k, W - 13 - k, 12 + k, 0.9); line(sheet, 12 + k, H - 13 - k, W - 13 - k, H - 13 - k, 0.9); line(sheet, 12 + k, 12 + k, 12 + k, H - 13 - k, 0.9); line(sheet, W - 13 - k, 12 + k, W - 13 - k, H - 13 - k, 0.9); }

    // the outline: silhouettes and creases along the view's axes, hidden lines removed; horizontal runs tallied into levels
    const sinAxis = Math.sin((P.axisDeg * Math.PI) / 180);
    const edges = classifyEdges(m, forward, Math.cos((P.creaseDeg * Math.PI) / 180), P.minEdgeLenM).filter(e => e.kind !== 'boundary');
    const levelBins = new Map<number, number>();
    let outlineEdges = 0;
    for (const e of edges) {
        const ua = u(e.a), va = v(e.a), ub = u(e.b), vb = v(e.b), len = Math.hypot(ub - ua, vb - va);
        if (!(len > 0) || Math.min(Math.abs(ub - ua), Math.abs(vb - va)) / len > sinAxis) continue;
        const da = d(e.a), db = d(e.b), n = Math.max(1, Math.round((len / pixelM) * 1.3));
        let drawnPx = 0;
        for (let s = 0; s <= n; s++) {
            const f = s / n, uu = ua + (ub - ua) * f, vv = va + (vb - va) * f;
            if (!visibleAt(uu, vv, da + (db - da) * f, P.depthEpsM)) continue;
            ink(sheet, X(uu), Y(vv), e.kind === 'silhouette' ? 1 : 0.7, e.kind === 'silhouette' ? lw : 0);
            drawnPx++;
        }
        if (!drawnPx) continue;
        outlineEdges++;
        if (!isPlan && Math.abs(vb - va) <= sinAxis * len) { const bin = Math.round(((va + vb) / 2) / P.levelBinM); levelBins.set(bin, (levelBins.get(bin) ?? 0) + (drawnPx / (n + 1)) * len); }
    }

    // the windows: each facade facing this view, its rects mapped through its frame; mirrored about its axis where symmetric
    const cosFacing = Math.cos((P.facingDeg * Math.PI) / 180);
    let facadesDrawn = 0, windows = 0, mirrored = 0, facadeAxes = 0;
    const readingOf = (id: number) => inputs.symmetry?.facades.find(f => f.facadeId === id);
    if (!isPlan) for (const fc of inputs.facades ?? []) {
        const f = fc.frame;
        if (-dot(f.normal, forward) < cosFacing) continue;
        const world = (s: number, t: number): Vec3 => [f.centroid[0] + s * f.axisS[0] + t * f.axisT[0], f.centroid[1] + s * f.axisS[1] + t * f.axisT[1], f.centroid[2] + s * f.axisS[2] + t * f.axisT[2]];
        const toS = (x: number) => f.orthoSMin + x * f.pixel, toT = (y: number) => f.orthoTMax - y * f.pixel;
        const drawRect = (r: number[], pattern?: number[]): boolean => {
            const s0 = toS(r[0]), s1 = toS(r[2]), t0 = toT(r[3]), t1 = toT(r[1]);
            const cw = world((s0 + s1) / 2, (t0 + t1) / 2);
            if (!visibleAt(dot(cw, right), dot(cw, up), dot(cw, forward), P.windowDepthM)) return false;
            const q = [world(s0, t0), world(s1, t0), world(s1, t1), world(s0, t1)].map(p => [X(dot(p, right)), Y(dot(p, up))]);
            for (let k = 0; k < 4; k++) line(sheet, q[k][0], q[k][1], q[(k + 1) % 4][0], q[(k + 1) % 4][1], pattern ? 0.55 : 0.75, 0, pattern);
            return true;
        };
        let any = false;
        for (const r of fc.rects) if (drawRect(r)) { windows++; any = true; }
        // the facade's own mirror: its axis, and each window's mirror where none stands
        const rd = readingOf(fc.facadeId);
        if (rd && rd.detected && !rd.periodic && rd.axisS !== undefined && (rd.ncc ?? 0) >= P.mirrorNcc) {
            const a = rd.axisS, toX = (s: number) => (s - f.orthoSMin) / f.pixel;
            for (const r of fc.rects) {
                const mr = [toX(2 * a - toS(r[2])), r[1], toX(2 * a - toS(r[0])), r[3]];
                if (mr[0] < 0 || mr[2] > f.width) continue;
                if (fc.rects.some(o => iou(o, mr) > 0)) continue; // only into a site no window touches
                if (drawRect(mr, [4, 3])) { mirrored++; any = true; }
            }
            const tTop = f.tMax ?? f.orthoTMax, tBot = f.tMin ?? f.orthoTMax - f.height * f.pixel;
            const p0 = world(a, tBot), p1 = world(a, tTop);
            const mid = world(a, (tBot + tTop) / 2);
            if (visibleAt(dot(mid, right), dot(mid, up), dot(mid, forward), P.windowDepthM)) { line(sheet, X(dot(p0, right)), Y(dot(p0, up)), X(dot(p1, right)), Y(dot(p1, up)), 0.6, 0, [14, 4, 3, 4]); facadeAxes++; }
        }
        if (any) facadesDrawn++;
    }

    // the building's plan mirrors: on an elevation, the ones whose plane holds the view direction (seen edge on); on the
    // plan, every one, across the drawing
    let planAxes = 0;
    const mirrors = inputs.symmetry ? [inputs.symmetry.plan.massing.best, ...inputs.symmetry.plan.massing.mirrors].filter((q, i, all) => q && q.score >= P.planMirrorScore && all.findIndex(o => Math.abs(o.angleDeg - q.angleDeg) < 1) === i) : [];
    for (const mi of mirrors) {
        const dir: Vec3 = [mi.dir[0], 0, mi.dir[1]], pt: Vec3 = [mi.point[0], 0, mi.point[1]];
        if (isPlan) {
            const L = Math.max(uMax - uMin, vMax - vMin);
            const a: Vec3 = [pt[0] - dir[0] * L, 0, pt[2] - dir[2] * L], b: Vec3 = [pt[0] + dir[0] * L, 0, pt[2] + dir[2] * L];
            line(sheet, X(dot(a, right)), Y(dot(a, up)), X(dot(b, right)), Y(dot(b, up)), 0.55, 0, [18, 5, 3, 5]);
            planAxes++;
            continue;
        }
        const fh = Math.hypot(forward[0], forward[2]);
        const ang = (Math.acos(Math.min(1, Math.abs(dir[0] * forward[0] + dir[2] * forward[2]) / (fh || 1))) * 180) / Math.PI;
        if (ang > P.planMirrorDeg) continue;
        const uc = dot(pt, right);
        if (uc < uMin || uc > uMax) continue;
        line(sheet, X(uc), M - 30, X(uc), M + dh + 30, 0.6, 0, [18, 5, 3, 5]);
        text(sheet, X(uc) - textW('CL', ts) / 2, M - 30 - 9 * ts, 'CL', ts);
        planAxes++;
    }

    // the levels: heights where horizontal outline runs across levelShare of the width, labelled above the lowest point
    const levels: number[] = [];
    if (!isPlan) {
        const minRun = P.levelShare * (uMax - uMin);
        const bins = [...levelBins.entries()].sort((a, b) => a[0] - b[0]);
        for (let i = 0; i < bins.length; i++) {
            let k = i, sum = bins[i][1], best = bins[i];
            while (k + 1 < bins.length && bins[k + 1][0] === bins[k][0] + 1) { k++; sum += bins[k][1]; if (bins[k][1] > best[1]) best = bins[k]; }
            if (sum >= minRun) { const lv = best[0] * P.levelBinM; if (levels.length && lv - levels[levels.length - 1] < P.levelMergeM) levels[levels.length - 1] = lv; else levels.push(lv); }
            i = k;
        }
        for (const lv of levels) {
            line(sheet, M - 20, Y(lv), M + dw + 20, Y(lv), 0.35, 0, [10, 6]);
            const s = `+${(lv - groundY).toFixed(1)}`;
            text(sheet, M + dw + 24, Y(lv) - 3.5 * ts, s, ts);
        }
    }

    // overall dimensions: the width below, the height (or the plan's depth) to the left, with ticks and figures
    const wM = uMax - uMin, hM = vMax - vMin, yDim = M + dh + 40, xDim = M - 50;
    line(sheet, M, yDim, M + dw, yDim, 0.9, lw);
    for (const x of [M, M + dw]) line(sheet, x, yDim - 10, x, yDim + 10, 0.9, lw);
    const wText = `${wM.toFixed(1)} M`;
    text(sheet, M + dw / 2 - textW(wText, ts) / 2, yDim + 8, wText, ts);
    line(sheet, xDim, M, xDim, M + dh, 0.9, lw);
    for (const y of [M, M + dh]) line(sheet, xDim - 10, y, xDim + 10, y, 0.9, lw);
    const hText = `${hM.toFixed(1)} M`;
    text(sheet, Math.max(16, xDim - textW(hText, ts) - 6), M + dh / 2, hText, ts);

    // the scale bar and the title block, along the bottom
    const yb = H - P.titlePx + 30, bx = M;
    const step = 10 / pixelM;
    for (let k = 0; k < 5; k++) { const x0 = bx + k * step; if (k % 2 === 0) for (let y = yb; y < yb + 8; y++) line(sheet, x0, y, x0 + step, y, 0.9); else { line(sheet, x0, yb, x0 + step, yb, 0.9); line(sheet, x0, yb + 7, x0 + step, yb + 7, 0.9); } }
    for (const k of [0, 1, 2, 5]) text(sheet, bx + Math.min(k, 5) * step - 3 * ts, yb + 14, k === 5 ? '50 M' : `${k * 10}`, ts);
    const tbW = Math.min(W - 2 * M - 5 * step - 40, Math.max(420, Math.round(W * 0.55))), tbX = W - 24 - tbW, tbY = H - P.titlePx - 2, tbH = P.titlePx - 16;
    for (const [a, b, c2, dd] of [[tbX, tbY, tbX + tbW, tbY], [tbX, tbY + tbH, tbX + tbW, tbY + tbH], [tbX, tbY, tbX, tbY + tbH], [tbX + tbW, tbY, tbX + tbW, tbY + tbH], [tbX, tbY + 14 * ts + 6, tbX + tbW, tbY + 14 * ts + 6]]) line(sheet, a, b, c2, dd, 0.9, lw);
    const wrapTo = (str: string, chars: number) => { const out: string[] = []; let r = ''; for (const w of str.split(' ')) { if (r && r.length + 1 + w.length > chars) { out.push(r); r = ''; } r = r ? `${r} ${w}` : w; } if (r) out.push(r); return out; };
    const rows = [
        `${(inputs.title ?? 'BUILDING').toUpperCase()}  -  ${label}`,
        `GRID ${P.gridM} M.  1 PX = ${pixelM.toFixed(3)} M.  VIEWS SQUARE TO THE WALLS (${azimuth.toFixed(1)} DEG).${inputs.note ? `  ${inputs.note.toUpperCase()}` : ''}`,
        'SOLID: SCAN OUTLINE AND CREASES (MEASURED). WINDOWS: FACADE READER AND WINDOW ARRAYS (PHOTO-INFERRED).',
        'DASHED: A WINDOW MIRRORED ABOUT ITS FACADE\'S AXIS (GENERATED). DASH-DOT: AXIS OF SYMMETRY. LEVELS: METRES ABOVE THE LOWEST POINT.'
    ];
    const small = Math.max(1, ts - 1), chars = Math.floor((tbW - 20) / (6 * small));
    text(sheet, tbX + 10, tbY + 6, wrapTo(rows[0], Math.floor((tbW - 20) / (6 * ts)))[0], ts);
    rows.slice(1).flatMap(r => wrapTo(r, chars)).slice(0, Math.floor((tbH - 14 * ts - 16) / (10 * small))).forEach((r, i) => text(sheet, tbX + 10, tbY + 14 * ts + 12 + i * 10 * small, r, small));
    return {
        png: sheet,
        stats: { name: view.name, label, width: W, height: H, pixelM, originU: uMin - M * pixelM, originV: vMax + M * pixelM, right, up, forward, outlineEdges, facades: facadesDrawn, windows, mirroredWindows: mirrored, facadeAxes, planAxes, levels: levels.map(l => Math.round((l - groundY) * 10) / 10), extentM: [Math.round(wM * 10) / 10, Math.round(hM * 10) / 10] }
    };
}

/**
 * The blueprint sheets of a scan (a triangle soup in the frame its facades and symmetry are read in): four elevations
 * square to its walls (A to D) and the roof plan, with the windows, mirrors and centre lines `inputs` gives.
 */
export function renderBlueprints(positions: Float32Array | Float64Array, inputs: BlueprintInputs = {}, P: BlueprintParams = BLUEPRINT_PARAMS): { report: BlueprintReport; pngs: Array<{ name: string; width: number; height: number; rgb: Uint8Array }> } {
    const t0 = Date.now();
    const m = weld(positions);
    const azimuth = wallAzimuthDeg(m);
    let groundY = Infinity;
    for (let i = 1; i < m.P.length; i += 3) if (m.P[i] < groundY) groundY = m.P[i];
    const labels: Record<string, string> = { north: 'ELEVATION A', east: 'ELEVATION B', south: 'ELEVATION C', west: 'ELEVATION D', plan: 'ROOF PLAN' };
    const views = CARDINAL_VIEWS.map(v => turned(v, azimuth));
    const pngs: Array<{ name: string; width: number; height: number; rgb: Uint8Array }> = [], stats: BlueprintReport['views'] = [];
    for (const view of views) {
        const { png, stats: s } = renderSheet(m, view, labels[view.name] ?? view.name.toUpperCase(), inputs, P, azimuth, groundY);
        pngs.push({ name: view.name, width: png.W, height: png.H, rgb: png.rgb });
        stats.push(s);
    }
    return { report: { version: BLUEPRINT_VERSION, params: P, wallAzimuthDeg: azimuth, views: stats, ms: Date.now() - t0 }, pngs };
}
