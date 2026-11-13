/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A staged building drawn as an architect's elevation set: four elevations square to its walls and a roof plan, black
 * line work on white (or white on blueprint blue), each with its levels, overall dimensions, a scale bar and a title
 * block. Constructed from what the pipeline infers about the building, not traced from a photo:
 *
 *  - structure: each wall's recessed bays as pipeline K's wall grammar read them (wall_grammar.json: bays per wall in its
 *    own frame, the tiers' bay rhythm), each drawn as a recessed panel with its reveal; the piers stand between them.
 *    Photo-inferred (where the grammar laid them by its rhythm: generated, as it labels them).
 *  - openings: each facade's windows (window_fit.json: the facade reader's openings and the window arrays), each with its
 *    frame, its mullions where the reading split it into panes, and its sill; between two windows stacked in one column,
 *    the spandrel as a panel. Photo-inferred.
 *  - the outline: the scan's silhouettes and creases along the view's axes (building-line-drawing.ts), hidden lines
 *    removed; where it runs horizontal for 2 m or more it is drawn doubled, as the ledge or cornice band it is (the scan
 *    measures the step, not the band's depth: the second line is drawn ledgeM below). Measured.
 *  - symmetry (pipeline-k/symmetry.ts): each facade's mirror axis as a centre line, a window mirrored about it into a
 *    site no window touches drawn dashed (generated), and the building's plan mirrors as centre lines.
 *  - levels: the heights where horizontal outline runs across levelShare of the width, each with a datum mark and its
 *    height above the lowest point. Measured.
 *  - detail: with the textured scan, the photo's strongest edges as the lightest hairlines under everything (the
 *    ornament, frames and texture no reading holds). Photo-inferred.
 * The design, not the evidence: with snapToModule each facade's windows are redrawn on its module (one width per column,
 * one height per row, on their clusters' lines, mullions evenly split), and with `structure` (the measured twin's clean
 * shell) the outline is drawn from that geometry instead of the scan's folds. Every sheet is also written as SVG.
 * Where several facade readings cover one stretch of wall, each window and bay is drawn once: facades nearest the viewer
 * first, then those with the most windows, and an element landing mostly on one already drawn is skipped.
 * Line weights follow the hierarchy an architect draws with: the silhouette heaviest, the structure (bays, ledges)
 * medium, the openings fine, the panes and spandrels finest. The legend says which line comes from where.
 */

import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import { drawText } from './photo-match-eval';
import { CARDINAL_VIEWS, classifyEdges, FACING_EPS, LINE_DRAWING_PARAMS, photoEdges, turned, wallAzimuthDeg, weld, type LineDrawingView, type Mesh, type PlaneOrthoFrame } from './building-line-drawing';
import type { TileTriangles } from './tile-texture-transfer';
import { encodePng } from './png-encode';
import type { SymmetryReport } from './pipeline-k/symmetry';

type Rect = [number, number, number, number];

/** One facade's windows and panes as pipeline K read them, in its straightened photo's pixels ([x0, y0, x1, y1], y down from its top). */
export interface BlueprintFacade { facadeId: number; frame: PlaneOrthoFrame & { tMin?: number; tMax?: number }; rects: Rect[]; panes?: Rect[] }

/** One wall's recessed bays as the wall grammar read them: the wall's plane (normal, offset along it), its horizontal axis, and each bay's span along it (u, m) and height (y, world m). */
export interface BlueprintWall { wallId: number; normal: Vec3; axisU: Vec3; offset: number; bays: Array<{ u0: number; u1: number; y0: number; y1: number; from?: string }> }

export interface BlueprintInputs {
    facades?: BlueprintFacade[];
    walls?: BlueprintWall[];
    symmetry?: SymmetryReport;
    /** Clean geometry of the building (the measured twin's shell: massing, slender top, ledge profiles, roof detail): the outline and the depth test are drawn from it in place of the raw scan, so the lines are the design's, not the scan's folds. Same frame as the scan. */
    structure?: Float32Array | Float64Array;
    /** With `structure`: geometry that closes its openings (the twin's panes and reveals), added to the depth test only, so an inferred window lies on its pane rather than over a hole; never drawn as outline. */
    structureFill?: Float32Array | Float64Array;
    /** The textured scan: its photo's strongest edges drawn as the lightest layer, under the constructed lines (detail the readings do not hold: ornament, frames, texture). Photo-inferred. */
    photo?: TileTriangles;
    title?: string;
    note?: string;
}

export const BLUEPRINT_PARAMS = {
    pixelM: 0.1, maxDimPx: 4096, creaseDeg: 25, minEdgeLenM: 0.3, depthEpsM: 0.08,
    /** Outline edges kept within this angle (degrees) of the view's axes. */
    axisDeg: 3,
    /** A facade or wall faces a view when its normal is within this angle (degrees) of the view's back direction. */
    facingDeg: 25,
    /** An element is drawn when it stands at most this far behind the surface the viewer sees there. */
    windowDepthM: 1.5,
    /** A facade's mirror axis is drawn (and its windows mirrored) when its photo matches its mirror at this NCC or more. */
    mirrorNcc: 0.75,
    planMirrorScore: 0.9, planMirrorDeg: 5,
    levelShare: 0.35, levelBinM: 0.5, levelMergeM: 3,
    /** A bay's reveal: its inner line this far inside its outline (m). */
    revealM: 0.25,
    /** A sill runs this far past its window on each side (m). */
    sillM: 0.15,
    /** Two windows in one column with a gap of spandrelMinM to spandrelMaxM (m) between them have a spandrel panel there, inset spandrelInsetM. */
    spandrelMinM: 0.4, spandrelMaxM: 3, spandrelInsetM: 0.15,
    /** A horizontal outline run of ledgeMinM or more is drawn doubled, its second line ledgeM below. */
    ledgeMinM: 2, ledgeM: 0.35,
    /** Each facade's windows snapped to its module: columns and rows clustered (centres within moduleTol of the median window's size), every window at its column's median width and row's median height on the clusters' lines, mullions as even splits at the column's median pane count. */
    snapToModule: true, moduleTol: 0.35,
    /** 'ink': black on white; 'blueprint': white on blue. */
    scheme: 'ink' as 'ink' | 'blueprint',
    gridM: 10, marginPx: 150, titlePx: 170
};
export type BlueprintParams = typeof BLUEPRINT_PARAMS;

export interface BlueprintReport {
    version: string; params: BlueprintParams; wallAzimuthDeg: number;
    views: Array<{
        name: string; label: string; width: number; height: number; pixelM: number; originU: number; originV: number; right: Vec3; up: Vec3; forward: Vec3;
        outlineEdges: number; ledges: number; walls: number; bays: number; facades: number; windows: number; panes: number; sills: number; spandrels: number;
        /** Windows and bays not drawn because another facade's reading had already drawn one on the same spot. */
        duplicatesSkipped: number; photoEdgePixels: number;
        mirroredWindows: number; facadeAxes: number; planAxes: number; levels: number[]; extentM: [number, number];
    }>;
    ms: number;
}

export const BLUEPRINT_VERSION = 'building-blueprint/4';

const SCHEMES = { ink: { bg: [255, 255, 255] as Vec3, ink: [16, 16, 16] as Vec3 }, blueprint: { bg: [24, 60, 116] as Vec3, ink: [236, 243, 255] as Vec3 } };

interface Sheet { W: number; H: number; rgb: Uint8Array; inkC: Vec3; vec: string[] }
function ink(c: Sheet, x: number, y: number, a: number, r = 0): void {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const xi = Math.round(x) + dx, yi = Math.round(y) + dy;
        if (xi < 0 || yi < 0 || xi >= c.W || yi >= c.H) continue;
        const o = (yi * c.W + xi) * 3;
        for (let k = 0; k < 3; k++) c.rgb[o + k] = Math.round(c.rgb[o + k] * (1 - a) + c.inkC[k] * a);
    }
}
/** A line of weight r (a square brush), optionally dashed ([on, off] or [on, off, dot, off] for a centre line). */
/** The same stroke as a vector: a brush of radius r is 2r + 1 pixels wide. */
function vline(c: Sheet, x0: number, y0: number, x1: number, y1: number, a: number, r = 0, pattern?: number[]): void {
    const f = (v: number) => (Math.round(v * 10) / 10).toString();
    c.vec.push(`<line x1="${f(x0)}" y1="${f(y0)}" x2="${f(x1)}" y2="${f(y1)}" stroke-width="${2 * r + 1}"${a < 0.999 ? ` stroke-opacity="${Math.round(a * 100) / 100}"` : ''}${pattern ? ` stroke-dasharray="${pattern.join(' ')}"` : ''}/>`);
}
function line(c: Sheet, x0: number, y0: number, x1: number, y1: number, a: number, r = 0, pattern?: number[]): void {
    vline(c, x0, y0, x1, y1, a, r, pattern);
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    const period = pattern ? pattern.reduce((p, q) => p + q, 0) : 0;
    for (let i = 0; i <= n; i++) {
        if (pattern) { let ph = i % period, on = true; for (const seg of pattern) { if (ph < seg) break; ph -= seg; on = !on; } if (!on) continue; }
        ink(c, x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, a, r);
    }
}
function text(c: Sheet, x: number, y: number, s: string, scale: number): void {
    drawText(c.rgb, c.W, c.H, Math.round(x), Math.round(y), s, scale, c.inkC);
    const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    c.vec.push(`<text x="${Math.round(x)}" y="${Math.round(y + 7 * scale)}" font-size="${8 * scale}" stroke="none">${esc}</text>`);
}
const textW = (s: string, scale: number) => s.length * 6 * scale;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const iou = (a: number[], b: number[]) => { const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])), i = ix * iy; return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i || 1); };

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

/**
 * A facade's windows on its module: their centres clustered into columns and rows (a gap under moduleTol of the median
 * window's width or height starts a new one), each window redrawn at its column's median width and its row's median
 * height on the clusters' mean lines; two windows landing on one site are one. Each window's pane count is its column's
 * median (the panes the reading split it into, those lying 60% inside it).
 */
function moduleOf(fc: BlueprintFacade, tol = BLUEPRINT_PARAMS.moduleTol): { rects: Rect[]; panes: number[] } {
    const R = fc.rects, med = (v: number[]) => { const a = [...v].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
    if (!R.length) return { rects: [], panes: [] };
    const mw = med(R.map(r => r[2] - r[0])), mh = med(R.map(r => r[3] - r[1]));
    const cluster = (vals: number[], gap: number): number[] => {
        const order = vals.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]), id = new Array<number>(vals.length);
        let k = -1, last = -Infinity;
        for (const [v, i] of order) { if (v - last > gap) k++; id[i] = k; last = v; }
        return id;
    };
    const colOf = cluster(R.map(r => (r[0] + r[2]) / 2), tol * mw), rowOf = cluster(R.map(r => (r[1] + r[3]) / 2), tol * mh);
    const nCols = Math.max(...colOf) + 1, nRows = Math.max(...rowOf) + 1;
    const colX = Array.from({ length: nCols }, (_, c) => { const v = R.filter((_, i) => colOf[i] === c).map(r => (r[0] + r[2]) / 2); return v.reduce((a, b) => a + b, 0) / v.length; });
    const colW = Array.from({ length: nCols }, (_, c) => med(R.filter((_, i) => colOf[i] === c).map(r => r[2] - r[0])));
    const rowY = Array.from({ length: nRows }, (_, q) => { const v = R.filter((_, i) => rowOf[i] === q).map(r => (r[1] + r[3]) / 2); return v.reduce((a, b) => a + b, 0) / v.length; });
    const rowH = Array.from({ length: nRows }, (_, q) => med(R.filter((_, i) => rowOf[i] === q).map(r => r[3] - r[1])));
    const panesIn = (r: Rect) => (fc.panes ?? []).filter(p => { const ix = Math.max(0, Math.min(r[2], p[2]) - Math.max(r[0], p[0])), iy = Math.max(0, Math.min(r[3], p[3]) - Math.max(r[1], p[1])); return ix * iy >= 0.6 * Math.max(1e-9, (p[2] - p[0]) * (p[3] - p[1])); }).length;
    const colPanes = Array.from({ length: nCols }, (_, c) => Math.max(1, med(R.filter((_, i) => colOf[i] === c).map(panesIn))));
    const seen = new Set<string>(), rects: Rect[] = [], panes: number[] = [];
    R.forEach((_, i) => {
        const c = colOf[i], q = rowOf[i], key = `${c},${q}`;
        if (seen.has(key)) return;
        seen.add(key);
        rects.push([colX[c] - colW[c] / 2, rowY[q] - rowH[q] / 2, colX[c] + colW[c] / 2, rowY[q] + rowH[q] / 2]);
        panes.push(colPanes[c]);
    });
    return { rects, panes };
}

/** A sheet's vectors as an SVG document: the background, then every stroke and label in the ink colour. */
function svgOf(sheet: Sheet, bg: Vec3): string {
    const rgb = (c: Vec3) => `rgb(${c[0]},${c[1]},${c[2]})`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.W}" height="${sheet.H}" viewBox="0 0 ${sheet.W} ${sheet.H}">`
        + `<rect width="100%" height="100%" fill="${rgb(bg)}"/>`
        + `<g stroke="${rgb(sheet.inkC)}" fill="${rgb(sheet.inkC)}" stroke-linecap="square" font-family="monospace">${sheet.vec.join('')}</g></svg>`;
}

function renderSheet(m: Mesh, view: LineDrawingView, label: string, inputs: BlueprintInputs, P: BlueprintParams, azimuth: number, groundY: number, depthMesh: Mesh = m): { png: Sheet; stats: BlueprintReport['views'][number] } {
    const { forward, right, up } = view, isPlan = Math.abs(forward[1]) > 0.9, sc = SCHEMES[P.scheme];
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
    const sheet: Sheet = { W, H, rgb: new Uint8Array(W * H * 3), inkC: sc.ink, vec: [] };
    for (let i = 0; i < W * H; i++) sheet.rgb.set(sc.bg, i * 3);
    const col = (uu: number) => (uu - uMin) / pixelM, row = (vv: number) => (vMax - vv) / pixelM;
    const X = (uu: number) => M + col(uu), Y = (vv: number) => M + row(vv);
    const ts = Math.max(1, Math.min(3, Math.round(Math.min(W, H * 0.6) / 700)));
    // weights: the silhouette heaviest (a 3 px brush), everything else one pixel, told apart by its tone (alpha)
    const heavy = 1, medium = 0;
    const TONE = { structure: 1, opening: 0.85, fine: 0.5, photo: 0.22 };
    const depth = depthBuffer(depthMesh, view, dw, dh, col, row);
    const visibleAt = (uu: number, vv: number, dd: number, eps: number) => { const x = Math.round(col(uu)), y = Math.round(row(vv)); if (x < 0 || y < 0 || x >= dw || y >= dh) return false; let best = Infinity; for (let k = -1; k <= 1; k++) for (let j = -1; j <= 1; j++) { const xx = x + j, yy = y + k; if (xx >= 0 && yy >= 0 && xx < dw && yy < dh) best = Math.min(best, depth[yy * dw + xx]); } return dd <= best + eps; };
    // an inferred element (a bay, a window) lies on the surface the viewer sees: within eps of it, in front or behind (never over empty background)
    const onSurface = (uu: number, vv: number, dd: number, eps: number) => { const x = Math.round(col(uu)), y = Math.round(row(vv)); if (x < 0 || y < 0 || x >= dw || y >= dh) return false; const b = depth[y * dw + x]; return Number.isFinite(b) && Math.abs(dd - b) <= eps; };
    const seg = (a: Vec3, b: Vec3, alpha: number, r: number, pattern?: number[]) => line(sheet, X(dot(a, right)), Y(dot(a, up)), X(dot(b, right)), Y(dot(b, up)), alpha, r, pattern);
    const quad = (q: Vec3[], alpha: number, r: number, pattern?: number[]) => { for (let k = 0; k < 4; k++) seg(q[k], q[(k + 1) % 4], alpha, r, pattern); };
    const seen = (p: Vec3) => onSurface(dot(p, right), dot(p, up), dot(p, forward), P.windowDepthM);

    if (P.scheme === 'blueprint') {
        for (let g = Math.ceil(uMin / P.gridM) * P.gridM; g <= uMax; g += P.gridM) line(sheet, X(g), M, X(g), M + dh, 0.07);
        for (let g = isPlan ? Math.ceil(vMin / P.gridM) * P.gridM : groundY; g <= vMax; g += P.gridM) if (g >= vMin) line(sheet, M, Y(g), M + dw, Y(g), 0.07);
    }
    for (let k = 0; k <= 1; k++) { line(sheet, 12 + k, 12 + k, W - 13 - k, 12 + k, 0.9); line(sheet, 12 + k, H - 13 - k, W - 13 - k, H - 13 - k, 0.9); line(sheet, 12 + k, 12 + k, 12 + k, H - 13 - k, 0.9); line(sheet, W - 13 - k, 12 + k, W - 13 - k, H - 13 - k, 0.9); }

    // 0. the photo's detail, lightest and under everything
    let photoEdgePixels = 0;
    if (inputs.photo && !isPlan) {
        const pe = photoEdges(inputs.photo, view, dw, dh, col, row, LINE_DRAWING_PARAMS);
        const layer = new Uint8Array(dw * dh * 4);
        for (let i = 0; i < dw * dh; i++) if (pe.edge[i]) { ink(sheet, M + (i % dw), M + Math.floor(i / dw), TONE.photo); photoEdgePixels++; layer.set([...sc.ink, Math.round(255 * TONE.photo)], 4 * i); }
        // in the SVG the hairlines are one image under the vectors (a vector a pixel would be no drawing)
        if (photoEdgePixels) sheet.vec.push(`<image x="${M}" y="${M}" width="${dw}" height="${dh}" href="data:image/png;base64,${encodePng(dw, dh, layer, 4).toString('base64')}"/>`);
    }
    // what is already drawn, in sheet pixels: a later element landing mostly (share) on one of the same kind is a duplicate
    const CELL = 32, claims = new Map<string, Map<number, number[][]>>();
    const boxOf = (q: Vec3[]) => { const xs = q.map(p => X(dot(p, right))), ys = q.map(p => Y(dot(p, up))); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
    const taken = (kind: string, b: number[], share: number) => {
        const grid = claims.get(kind); if (!grid) return false;
        const area = Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
        for (let gy = Math.floor(b[1] / CELL); gy <= Math.floor(b[3] / CELL); gy++) for (let gx = Math.floor(b[0] / CELL); gx <= Math.floor(b[2] / CELL); gx++) for (const o of grid.get(gy * 100000 + gx) ?? []) {
            const ix = Math.max(0, Math.min(b[2], o[2]) - Math.max(b[0], o[0])), iy = Math.max(0, Math.min(b[3], o[3]) - Math.max(b[1], o[1]));
            if (ix * iy >= share * Math.min(area, Math.max(1, (o[2] - o[0]) * (o[3] - o[1])))) return true;
        }
        return false;
    };
    const claim = (kind: string, b: number[]) => { const grid = claims.get(kind) ?? claims.set(kind, new Map()).get(kind)!; for (let gy = Math.floor(b[1] / CELL); gy <= Math.floor(b[3] / CELL); gy++) for (let gx = Math.floor(b[0] / CELL); gx <= Math.floor(b[2] / CELL); gx++) { const k = gy * 100000 + gx; (grid.get(k) ?? grid.set(k, []).get(k)!).push(b); } };
    let duplicatesSkipped = 0;

    // 1. structure: each facing wall's recessed bays, a panel with its reveal (the piers stand between them)
    const cosFacing = Math.cos((P.facingDeg * Math.PI) / 180);
    let walls = 0, bays = 0;
    if (!isPlan) for (const w of inputs.walls ?? []) {
        if (-dot(w.normal, forward) < cosFacing) continue;
        const at = (uu: number, y: number): Vec3 => [w.normal[0] * w.offset + w.axisU[0] * uu, y, w.normal[2] * w.offset + w.axisU[2] * uu];
        let any = false;
        for (const b of w.bays) {
            if (!seen(at((b.u0 + b.u1) / 2, (b.y0 + b.y1) / 2))) continue;
            const bq = [at(b.u0, b.y0), at(b.u1, b.y0), at(b.u1, b.y1), at(b.u0, b.y1)], bb = boxOf(bq);
            if (taken('bay', bb, 0.5)) { duplicatesSkipped++; continue; }
            claim('bay', bb);
            quad(bq, TONE.structure, medium);
            const r = Math.min(P.revealM, (b.u1 - b.u0) / 4);
            quad([at(b.u0 + r, b.y0), at(b.u1 - r, b.y0), at(b.u1 - r, b.y1 - r), at(b.u0 + r, b.y1 - r)], TONE.fine, 0);
            bays++; any = true;
        }
        if (any) walls++;
    }

    // 2. openings: each facing facade's windows with their frames, mullions (its panes), sills and the spandrels between
    let facadesDrawn = 0, windows = 0, panes = 0, sills = 0, spandrels = 0, mirrored = 0, facadeAxes = 0;
    const readingOf = (id: number) => inputs.symmetry?.facades.find(f => f.facadeId === id);
    // nearest the viewer first, then the most windows: the reading that is seen is the one drawn
    const ordered = [...(inputs.facades ?? [])].sort((a, b) => dot(a.frame.centroid, forward) - dot(b.frame.centroid, forward) || b.rects.length - a.rects.length);
    if (!isPlan) for (const fc of ordered) {
        const f = fc.frame;
        if (-dot(f.normal, forward) < cosFacing) continue;
        const world = (s: number, t: number): Vec3 => [f.centroid[0] + s * f.axisS[0] + t * f.axisT[0], f.centroid[1] + s * f.axisS[1] + t * f.axisT[1], f.centroid[2] + s * f.axisS[2] + t * f.axisT[2]];
        const toS = (x: number) => f.orthoSMin + x * f.pixel, toT = (y: number) => f.orthoTMax - y * f.pixel;
        const rectWorld = (r: number[]) => { const s0 = toS(r[0]), s1 = toS(r[2]), t0 = toT(r[3]), t1 = toT(r[1]); return { s0, s1, t0, t1, q: [world(s0, t0), world(s1, t0), world(s1, t1), world(s0, t1)] }; };
        const visibleRect = (r: number[]) => { const g = rectWorld(r); return seen(world((g.s0 + g.s1) / 2, (g.t0 + g.t1) / 2)) ? g : undefined; };
        let any = false;
        const drawn: Array<{ s0: number; s1: number; t0: number; t1: number }> = [];
        const mine: number[][] = [];
        const mod = P.snapToModule ? moduleOf(fc) : undefined;
        for (const r of mod ? mod.rects : fc.rects) {
            const g = visibleRect(r);
            if (!g) continue;
            const wb = boxOf(g.q);
            if (taken('window', wb, 0.3)) { duplicatesSkipped++; continue; }
            claim('window', wb); mine.push(wb);
            quad(g.q, TONE.opening, 0);
            line(sheet, X(dot(world(g.s0 - P.sillM, g.t0), right)), Y(dot(world(g.s0 - P.sillM, g.t0), up)), X(dot(world(g.s1 + P.sillM, g.t0), right)), Y(dot(world(g.s1 + P.sillM, g.t0), up)), TONE.opening, 0);
            windows++; sills++; any = true; drawn.push(g);
        }
        // the mullions: with the module, each window split evenly at its column's pane count; else the reading's panes
        if (mod) for (const [r, nPanes] of mod.rects.map((r, k) => [r, mod.panes[k]] as const)) {
            if (nPanes < 2) continue;
            const g = rectWorld(r), b = boxOf(g.q);
            if (!mine.some(o => o[0] === b[0] && o[1] === b[1] && o[2] === b[2] && o[3] === b[3])) continue;
            for (let k = 1; k < nPanes; k++) { const sx = g.s0 + ((g.s1 - g.s0) * k) / nPanes; seg(world(sx, g.t0), world(sx, g.t1), TONE.fine, 0); }
            panes += nPanes;
        }
        else for (const p of fc.panes ?? []) {
            const g = visibleRect(p); if (!g) continue;
            // only inside a window this facade drew (a duplicate's panes go with it)
            const pb = boxOf(g.q), pa = Math.max(1, (pb[2] - pb[0]) * (pb[3] - pb[1]));
            if (!mine.some(o => Math.max(0, Math.min(pb[2], o[2]) - Math.max(pb[0], o[0])) * Math.max(0, Math.min(pb[3], o[3]) - Math.max(pb[1], o[1])) >= 0.6 * pa)) continue;
            quad(g.q, TONE.fine, 0); panes++;
        }
        // the spandrels: between two windows of one column (overlapping in s by half) with a gap of spandrelMinM..spandrelMaxM
        const byCol = [...drawn].sort((a, b) => a.s0 - b.s0 || b.t1 - a.t1);
        for (let i = 0; i < byCol.length; i++) {
            const a = byCol[i];
            let below: typeof a | undefined;
            for (const b of byCol) {
                if (b === a || b.t1 > a.t0) continue;
                const ov = Math.min(a.s1, b.s1) - Math.max(a.s0, b.s0);
                if (ov < 0.5 * Math.min(a.s1 - a.s0, b.s1 - b.s0)) continue;
                if (!below || b.t1 > below.t1) below = b;
            }
            if (!below) continue;
            const gap = a.t0 - below.t1;
            if (gap < P.spandrelMinM || gap > P.spandrelMaxM) continue;
            const s0 = Math.max(a.s0, below.s0) + P.spandrelInsetM, s1 = Math.min(a.s1, below.s1) - P.spandrelInsetM, t0 = below.t1 + P.spandrelInsetM, t1 = a.t0 - P.spandrelInsetM;
            if (s1 - s0 < 0.2 || t1 - t0 < 0.15) continue;
            quad([world(s0, t0), world(s1, t0), world(s1, t1), world(s0, t1)], TONE.fine, 0);
            spandrels++;
        }
        // the facade's own mirror: its axis, and each window's mirror into a site no window touches
        const rd = readingOf(fc.facadeId);
        if (rd && rd.detected && !rd.periodic && rd.axisS !== undefined && (rd.ncc ?? 0) >= P.mirrorNcc) {
            const a = rd.axisS, toX = (s: number) => (s - f.orthoSMin) / f.pixel;
            for (const r of fc.rects) {
                const mr = [toX(2 * a - toS(r[2])), r[1], toX(2 * a - toS(r[0])), r[3]];
                if (mr[0] < 0 || mr[2] > f.width || fc.rects.some(o => iou(o, mr) > 0)) continue;
                const g = visibleRect(mr);
                if (!g) continue;
                const mb = boxOf(g.q);
                if (taken('window', mb, 0.1)) continue;
                claim('window', mb);
                quad(g.q, 0.6, 0, [4, 3]);
                mirrored++; any = true;
            }
            const tTop = f.tMax ?? f.orthoTMax, tBot = f.tMin ?? f.orthoTMax - f.height * f.pixel;
            if (seen(world(a, (tBot + tTop) / 2))) { seg(world(a, tBot), world(a, tTop), 0.55, 0, [14, 4, 3, 4]); facadeAxes++; }
        }
        if (any) facadesDrawn++;
    }

    // 3. the outline: silhouettes heaviest, creases medium, along the view's axes; long horizontal runs doubled as ledges
    const sinAxis = Math.sin((P.axisDeg * Math.PI) / 180);
    const edges = classifyEdges(m, forward, Math.cos((P.creaseDeg * Math.PI) / 180), P.minEdgeLenM).filter(e => e.kind !== 'boundary');
    const levelBins = new Map<number, number>();
    let outlineEdges = 0, ledges = 0;
    for (const e of edges) {
        const ua = u(e.a), va = v(e.a), ub = u(e.b), vb = v(e.b), len = Math.hypot(ub - ua, vb - va);
        if (!(len > 0) || Math.min(Math.abs(ub - ua), Math.abs(vb - va)) / len > sinAxis) continue;
        const da = d(e.a), db = d(e.b), n = Math.max(1, Math.round((len / pixelM) * 1.3));
        const horizontal = !isPlan && Math.abs(vb - va) <= sinAxis * len;
        let drawnPx = 0, run = -1;
        const flush = (endS: number) => {
            if (run < 0) return;
            const f0 = run / n, f1 = endS / n, x0 = X(ua + (ub - ua) * f0), y0 = Y(va + (vb - va) * f0), x1 = X(ua + (ub - ua) * f1), y1 = Y(va + (vb - va) * f1);
            vline(sheet, x0, y0, x1, y1, 1, e.kind === 'silhouette' ? heavy : medium);
            if (horizontal && len >= P.ledgeMinM) vline(sheet, x0, y0 + P.ledgeM / pixelM, x1, y1 + P.ledgeM / pixelM, TONE.opening, 0);
            run = -1;
        };
        for (let s = 0; s <= n; s++) {
            const f = s / n, uu = ua + (ub - ua) * f, vv = va + (vb - va) * f;
            if (!visibleAt(uu, vv, da + (db - da) * f, P.depthEpsM)) { flush(s - 1); continue; }
            if (run < 0) run = s;
            ink(sheet, X(uu), Y(vv), 1, e.kind === 'silhouette' ? heavy : medium);
            if (horizontal && len >= P.ledgeMinM) ink(sheet, X(uu), Y(vv - P.ledgeM), TONE.opening, 0);
            drawnPx++;
        }
        flush(n);
        if (!drawnPx) continue;
        outlineEdges++;
        if (horizontal && len >= P.ledgeMinM) ledges++;
        if (horizontal) { const bin = Math.round(((va + vb) / 2) / P.levelBinM); levelBins.set(bin, (levelBins.get(bin) ?? 0) + (drawnPx / (n + 1)) * len); }
    }

    // 4. the building's plan mirrors as centre lines
    let planAxes = 0;
    const mirrors = inputs.symmetry ? [inputs.symmetry.plan.massing.best, ...inputs.symmetry.plan.massing.mirrors].filter((q, i, all) => q && q.score >= P.planMirrorScore && all.findIndex(o => Math.abs(o.angleDeg - q.angleDeg) < 1) === i) : [];
    for (const mi of mirrors) {
        const dir: Vec3 = [mi.dir[0], 0, mi.dir[1]], pt: Vec3 = [mi.point[0], 0, mi.point[1]];
        if (isPlan) {
            const L = Math.max(uMax - uMin, vMax - vMin);
            seg([pt[0] - dir[0] * L, 0, pt[2] - dir[2] * L], [pt[0] + dir[0] * L, 0, pt[2] + dir[2] * L], 0.6, 0, [18, 5, 3, 5]);
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

    // 5. levels: a datum mark and its height at each, the line itself only past the building's edges
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
            const y = Y(lv), xe = M + dw + 16;
            line(sheet, M + dw + 2, y, xe + 36, y, 0.8, 0);
            for (let k = 0; k <= 7; k++) line(sheet, xe + 8 - k, y - k, xe + 8 + k, y - k, 0.9, 0); // the datum triangle
            text(sheet, xe + 40, y - 3.5 * ts, `+${(lv - groundY).toFixed(1)}`, ts);
        }
    }

    // 6. dimensions, scale bar, title block
    const wM = uMax - uMin, hM = vMax - vMin, yDim = M + dh + 40, xDim = M - 50;
    line(sheet, M, yDim, M + dw, yDim, 0.9, 0);
    for (const x of [M, M + dw]) { line(sheet, x, yDim - 10, x, yDim + 10, 0.9, 0); line(sheet, x - 6, yDim + 6, x + 6, yDim - 6, 0.9, 0); }
    const wText = `${wM.toFixed(1)} M`;
    text(sheet, M + dw / 2 - textW(wText, ts) / 2, yDim + 8, wText, ts);
    line(sheet, xDim, M, xDim, M + dh, 0.9, 0);
    for (const y of [M, M + dh]) { line(sheet, xDim - 10, y, xDim + 10, y, 0.9, 0); line(sheet, xDim - 6, y + 6, xDim + 6, y - 6, 0.9, 0); }
    const hText = `${hM.toFixed(1)} M`;
    text(sheet, Math.max(16, xDim - textW(hText, ts) - 6), M + dh / 2, hText, ts);
    const yb = H - P.titlePx + 30, bx = M, step = 10 / pixelM;
    for (let k = 0; k < 5; k++) { const x0 = bx + k * step; if (k % 2 === 0) for (let y = yb; y < yb + 8; y++) line(sheet, x0, y, x0 + step, y, 0.9); else { line(sheet, x0, yb, x0 + step, yb, 0.9); line(sheet, x0, yb + 7, x0 + step, yb + 7, 0.9); } }
    for (const k of [0, 1, 2, 5]) text(sheet, bx + k * step - 3 * ts, yb + 14, k === 5 ? '50 M' : `${k * 10}`, ts);
    const tbW = Math.min(W - 2 * M - 5 * step - 40, Math.max(420, Math.round(W * 0.55))), tbX = W - 24 - tbW, tbY = H - P.titlePx - 2, tbH = P.titlePx - 16;
    for (const [a, b, c2, dd] of [[tbX, tbY, tbX + tbW, tbY], [tbX, tbY + tbH, tbX + tbW, tbY + tbH], [tbX, tbY, tbX, tbY + tbH], [tbX + tbW, tbY, tbX + tbW, tbY + tbH], [tbX, tbY + 14 * ts + 6, tbX + tbW, tbY + 14 * ts + 6]]) line(sheet, a, b, c2, dd, 0.9, 0);
    const wrapTo = (str: string, chars: number) => { const out: string[] = []; let r = ''; for (const w of str.split(' ')) { if (r && r.length + 1 + w.length > chars) { out.push(r); r = ''; } r = r ? `${r} ${w}` : w; } if (r) out.push(r); return out; };
    const rows = [
        `${(inputs.title ?? 'BUILDING').toUpperCase()}  -  ${label}`,
        `1 PX = ${pixelM.toFixed(3)} M. VIEWS SQUARE TO THE WALLS (${azimuth.toFixed(1)} DEG). LEVELS IN METRES ABOVE THE LOWEST POINT.${inputs.note ? ` ${inputs.note.toUpperCase()}` : ''}`,
        'HEAVY: SILHOUETTE. FULL TONE: CREASES, LEDGES (DOUBLED) AND RECESSED BAYS. LIGHTER: WINDOWS AND SILLS. LIGHTEST: REVEALS, MULLIONS, SPANDREL PANELS.',
        'OUTLINE AND LEVELS MEASURED FROM THE SCAN. BAYS, WINDOWS, PANES AND SPANDRELS INFERRED FROM THE FACADE PHOTOS, AND THE FAINT HAIRLINES TRACED FROM THEM (PHOTO-INFERRED). DASHED: A WINDOW MIRRORED ABOUT ITS FACADE\'S AXIS (GENERATED). DASH-DOT: AXIS OF SYMMETRY.'
    ];
    const small = Math.max(1, ts - 1), chars = Math.floor((tbW - 20) / (6 * small));
    text(sheet, tbX + 10, tbY + 6, wrapTo(rows[0], Math.floor((tbW - 20) / (6 * ts)))[0], ts);
    rows.slice(1).flatMap(r => wrapTo(r, chars)).slice(0, Math.floor((tbH - 14 * ts - 16) / (10 * small))).forEach((r, i) => text(sheet, tbX + 10, tbY + 14 * ts + 12 + i * 10 * small, r, small));
    return {
        png: sheet,
        stats: { name: view.name, label, width: W, height: H, pixelM, originU: uMin - M * pixelM, originV: vMax + M * pixelM, right, up, forward, outlineEdges, ledges, walls, bays, facades: facadesDrawn, windows, panes, sills, spandrels, duplicatesSkipped, photoEdgePixels, mirroredWindows: mirrored, facadeAxes, planAxes, levels: levels.map(l => Math.round((l - groundY) * 10) / 10), extentM: [Math.round(wM * 10) / 10, Math.round(hM * 10) / 10] }
    };
}

/**
 * The elevation set of a scan (a triangle soup in the frame its facades, walls and symmetry are read in): four
 * elevations square to its walls (A to D) and the roof plan, constructed from what `inputs` gives.
 */
export function renderBlueprints(positions: Float32Array | Float64Array, inputs: BlueprintInputs = {}, P: BlueprintParams = BLUEPRINT_PARAMS): { report: BlueprintReport; pngs: Array<{ name: string; width: number; height: number; rgb: Uint8Array; svg: string }> } {
    const t0 = Date.now();
    const m = weld(inputs.structure ?? positions);
    // the depth the elements and the outline are tested against: the structure with its openings closed, when given
    let depthMesh = m;
    if (inputs.structure && inputs.structureFill && inputs.structureFill.length) { const both = new Float64Array(inputs.structure.length + inputs.structureFill.length); both.set(inputs.structure); both.set(inputs.structureFill, inputs.structure.length); depthMesh = weld(both); }
    const azimuth = wallAzimuthDeg(m);
    let groundY = Infinity;
    for (let i = 1; i < m.P.length; i += 3) if (m.P[i] < groundY) groundY = m.P[i];
    const labels: Record<string, string> = { north: 'ELEVATION A', east: 'ELEVATION B', south: 'ELEVATION C', west: 'ELEVATION D', plan: 'ROOF PLAN' };
    const views = CARDINAL_VIEWS.map(v => turned(v, azimuth));
    const pngs: Array<{ name: string; width: number; height: number; rgb: Uint8Array; svg: string }> = [], stats: BlueprintReport['views'] = [];
    for (const view of views) {
        const { png, stats: s } = renderSheet(m, view, labels[view.name] ?? view.name.toUpperCase(), inputs, P, azimuth, groundY, depthMesh);
        pngs.push({ name: view.name, width: png.W, height: png.H, rgb: png.rgb, svg: svgOf(png, SCHEMES[P.scheme].bg) });
        stats.push(s);
    }
    return { report: { version: BLUEPRINT_VERSION, params: P, wallAzimuthDeg: azimuth, views: stats, ms: Date.now() - t0 }, pngs };
}
