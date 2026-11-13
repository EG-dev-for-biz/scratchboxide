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
import type { StructureIntent, IntentSource } from './structure-intent';

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
    /** The whole building's material map (building-material-map.ts): its samples drawn from each view (front-most, on the surface the depth test sees), one colour a material, in a sheet of its own. */
    surfaceMap?: { p: Float32Array; material: Int32Array; spacingM: number; colours: Array<[number, number, number]> };
    /** The design intent (structure-intent.ts): when given, each facade's windows are drawn from it (repeats, mirrors and twins inferred, each region's organisation decided) in place of the module snap. */
    intent?: StructureIntent;
    title?: string;
    note?: string;
}

export const BLUEPRINT_PARAMS = {
    pixelM: 0.1, maxDimPx: 4096, creaseDeg: 25, minEdgeLenM: 0.3, depthEpsM: 0.08,
    /** Outline edges kept within this angle (degrees) of the view's axes. */
    axisDeg: 3,
    /** An outline line is not drawn where another already runs within this many pixels beside it (a silhouette, drawn with a wider brush, within 2 more): flutes, ribs and louvres closer than the drawing can show read as the surface, not as lines. Silhouettes are drawn first. */
    creaseCrowdPx: 2,
    /** A facade or wall faces a view when its normal is within this angle (degrees) of the view's back direction: an oblique face (a wedge plan's long sides) is drawn foreshortened, as an elevation shows it; a face nearer edge-on is left to the view square to it. */
    facingDeg: 70,
    /** An element is drawn when it stands at most this far behind the surface the viewer sees there. */
    windowDepthM: 1.5,
    /** A window overlapping one already drawn by windowDupShare of the smaller is the same window read twice; a bay edge within baySnapM of the windows it holds is drawn on their edge. */
    windowDupShare: 0.1, baySnapM: 0.4, coverGrow: 0.35,
    /** A material map sample is drawn when it lies at most surfaceDepthM behind the surface the view sees. */
    surfaceDepthM: 0.5,
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
    gridM: 10, marginPx: 150, titlePx: 170,
    /** The material ID map: a window's frame this wide (m) around its glass and along its mullions; the bare surface judged in blocks of matBlockM, each block taking its neighbourhood's majority; element groups of one role within matDeltaE (CIELAB) are one material, the bare surface's within matDeltaESurface; a material under matMinShare of its role's area joins its nearest. */
    /**
     * The street and the base's loose fill are not the building: a triangle facing up (normal y above streetUpNy) within
     * streetM of the ground goes, and so does any triangle wholly below footprintAboveM whose centroid lies outside the
     * building's footprint (the plan the scan covers above footprintAboveM, on a footprintCellM grid, grown by
     * footprintMarginM).
     */
    streetM: 1, streetUpNy: 0.7, footprintAboveM: 3, footprintCellM: 0.5, footprintMarginM: 1.5,
    frameM: 0.08, matBlockM: 1, matDeltaE: 6, matDeltaESurface: 7, matMinShare: 0.03,
    /** Lightness counts this much against chroma (taken relative to lightness) in the material distance: shade and exposure change a material's lightness, a different material its hue (the lighting reads as one material lit differently); a 50-unit lightness step still splits. */
    matLightWeight: 0.15,
    /** The bare surface's majority vote: over a (2r + 1)^2 block neighbourhood, this many passes. */
    matSmoothR: 2, matSmoothPasses: 3
};
export type BlueprintParams = typeof BLUEPRINT_PARAMS;

export interface BlueprintReport {
    version: string; params: BlueprintParams; wallAzimuthDeg: number;
    /** Area of street and loose base fill left out (withoutStreet). */
    streetDroppedM2?: number;
    views: Array<{
        name: string; label: string; width: number; height: number; pixelM: number; originU: number; originV: number; right: Vec3; up: Vec3; forward: Vec3;
        outlineEdges: number; ledges: number; walls: number; bays: number; facades: number; windows: number; panes: number; sills: number; spandrels: number;
        /** Windows and bays not drawn because another facade's reading had already drawn one on the same spot. */
        duplicatesSkipped: number; photoEdgePixels: number;
        mirroredWindows: number; facadeAxes: number; planAxes: number; levels: number[]; extentM: [number, number];
        /** Windows drawn by provenance (with an intent). */
        bySource?: Partial<Record<IntentSource, number>>;
        /** Piers drawn from the intent's frame. */
        piers?: number;
    }>;
    /** The material ID map's materials, one table for every view (the same ID is the same material in each). */
    materials?: MaterialEntry[];
    ms: number;
}

export const BLUEPRINT_VERSION = 'building-blueprint/5';

/** One material of the ID map: its role in the drawing (the element kind it fills: wall, roof, bay, spandrel, glass, frame; open labels), its colour in the ID map, its mean colour in the photo (sRGB, the albedo estimate; absent where the photo never reached), and how it was assigned. */
export interface MaterialEntry { id: number; role: string; idColor: [number, number, number]; photoColor?: [number, number, number]; lab?: [number, number, number]; areaM2: number; groups: number; provenance: 'photo-inferred' | 'generated'; reason: string }

/** An element instance the ID map is built from: its role, the group it shares a material with (a facade's window family, a wall's bays, a surface block), and its photo colour sums. */
interface MatInstance { role: string; group: string; n: number; c: number; L: number; A: number; B: number }
interface MatSheet { inst: Int32Array; dw: number; dh: number; M: number; pixelM: number; groups: MatInstance[]; blocks: { bw: number; bh: number; px: number; group: Int32Array } }

const linearToSrgb8 = (c: number) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));
function linToLab(r: number, g: number, b: number): [number, number, number] {
    const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, y = 0.2126 * r + 0.7152 * g + 0.0722 * b, z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
function labToLin(L: number, a: number, b: number): [number, number, number] {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200, inv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
    const x = inv(fx) * 0.95047, y = inv(fy), z = inv(fz) * 1.08883;
    return [3.2406 * x - 1.5372 * y - 0.4986 * z, -0.9689 * x + 1.8758 * y + 0.0415 * z, 0.0557 * x - 0.204 * y + 1.057 * z];
}

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

function renderSheet(m: Mesh, view: LineDrawingView, label: string, inputs: BlueprintInputs, P: BlueprintParams, azimuth: number, groundY: number, depthMesh: Mesh = m): { png: Sheet; stats: BlueprintReport['views'][number]; mat: MatSheet; surface?: Uint8Array } {
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
    // the material ID map's raster: each drawing pixel's element group (a facade family's glass or frame, a wall's bays, a surface block), painted in drawing order
    const inst = new Int32Array(dw * dh).fill(-1), groups: MatInstance[] = [], groupIx = new Map<string, number>();
    const groupOf = (role: string, key: string) => { const k = `${role}:${key}`; let g = groupIx.get(k); if (g === undefined) { g = groups.length; groups.push({ role, group: k, n: 0, c: 0, L: 0, A: 0, B: 0 }); groupIx.set(k, g); } return g; };
    const fillQuad = (q: Vec3[], g: number) => {
        const xs = q.map(p => col(dot(p, right))), ys = q.map(p => row(dot(p, up)));
        const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(dw - 1, Math.ceil(Math.max(...xs))), y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(dh - 1, Math.ceil(Math.max(...ys)));
        const sgn = Math.sign((xs[1] - xs[0]) * (ys[2] - ys[0]) - (ys[1] - ys[0]) * (xs[2] - xs[0])) || 1;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const px = x + 0.5, py = y + 0.5;
            let inside = true;
            for (let k = 0; k < q.length && inside; k++) { const a = k, b = (k + 1) % q.length; if (sgn * ((xs[b] - xs[a]) * (py - ys[a]) - (ys[b] - ys[a]) * (px - xs[a])) < -1e-6) inside = false; }
            if (inside && Number.isFinite(depth[y * dw + x])) inst[y * dw + x] = g;
        }
    };
    const rgbPhoto = inputs.photo ? new Float32Array(dw * dh * 3) : undefined;
    // each pixel's facade region (a band of one design, from the intent): the bare wall takes its material per region, not per block
    const regionAt = new Int32Array(dw * dh).fill(-1), regionKeys: string[] = [];
    const fillRegion = (q: Vec3[], id: number) => {
        const xs = q.map(p => col(dot(p, right))), ys = q.map(p => row(dot(p, up))), ds = q.map(p => dot(p, forward));
        const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(dw - 1, Math.ceil(Math.max(...xs))), y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(dh - 1, Math.ceil(Math.max(...ys)));
        for (const tri of [[0, 1, 2], [0, 2, 3]]) {
            const [a, b, c2] = tri, area = (xs[b] - xs[a]) * (ys[c2] - ys[a]) - (xs[c2] - xs[a]) * (ys[b] - ys[a]);
            if (!(Math.abs(area) > 1e-9)) continue;
            for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                const i = y * dw + x; if (regionAt[i] >= 0 || !Number.isFinite(depth[i])) continue;
                const px = x + 0.5, py = y + 0.5;
                const w0 = ((xs[b] - px) * (ys[c2] - py) - (xs[c2] - px) * (ys[b] - py)) / area, w1 = ((xs[c2] - px) * (ys[a] - py) - (xs[a] - px) * (ys[c2] - py)) / area, w2 = 1 - w0 - w1;
                if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
                if (Math.abs(w0 * ds[a] + w1 * ds[b] + w2 * ds[c2] - depth[i]) <= P.windowDepthM) regionAt[i] = id;
            }
        }
    };
    const bySource: Partial<Record<IntentSource, number>> = {};

    if (P.scheme === 'blueprint') {
        for (let g = Math.ceil(uMin / P.gridM) * P.gridM; g <= uMax; g += P.gridM) line(sheet, X(g), M, X(g), M + dh, 0.07);
        for (let g = isPlan ? Math.ceil(vMin / P.gridM) * P.gridM : groundY; g <= vMax; g += P.gridM) if (g >= vMin) line(sheet, M, Y(g), M + dw, Y(g), 0.07);
    }
    for (let k = 0; k <= 1; k++) { line(sheet, 12 + k, 12 + k, W - 13 - k, 12 + k, 0.9); line(sheet, 12 + k, H - 13 - k, W - 13 - k, H - 13 - k, 0.9); line(sheet, 12 + k, 12 + k, 12 + k, H - 13 - k, 0.9); line(sheet, W - 13 - k, 12 + k, W - 13 - k, H - 13 - k, 0.9); }

    // 0. the photo's detail, lightest and under everything
    let photoEdgePixels = 0;
    if (inputs.photo && isPlan) photoEdges(inputs.photo, view, dw, dh, col, row, LINE_DRAWING_PARAMS, rgbPhoto);
    if (inputs.photo && !isPlan) {
        const pe = photoEdges(inputs.photo, view, dw, dh, col, row, LINE_DRAWING_PARAMS, rgbPhoto);
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
    // the area each facade's drawn windows cover (each window grown by coverGrow of its size each way): another facade's window centred there is a conflicting second grid (a centre within 0.85 of a window of one drawn), while a neighbouring column a pier away stands
    const cover = new Map<number, Array<[number, number, number, number, number]>>();
    const coverBox = (b: number[], id: number) => { const w = (b[2] - b[0]) * P.coverGrow, h = (b[3] - b[1]) * P.coverGrow, e: [number, number, number, number, number] = [b[0] - w, b[1] - h, b[2] + w, b[3] + h, id]; for (let gy = Math.floor(e[1] / CELL); gy <= Math.floor(e[3] / CELL); gy++) for (let gx = Math.floor(e[0] / CELL); gx <= Math.floor(e[2] / CELL); gx++) { const k = gy * 100000 + gx; (cover.get(k) ?? cover.set(k, []).get(k)!).push(e); } };
    const coveredByOther = (x: number, y: number, id: number) => (cover.get(Math.floor(y / CELL) * 100000 + Math.floor(x / CELL)) ?? []).some(e => e[4] !== id && x >= e[0] && x <= e[2] && y >= e[1] && y <= e[3]);

    const cosFacing = Math.cos((P.facingDeg * Math.PI) / 180);
    // 0a. the facade regions, nearest facade first: each band spans its facade's width, from halfway to the band above to halfway to the band below
    if (!isPlan && inputs.intent) for (const fc of [...(inputs.facades ?? [])].sort((a, b) => dot(a.frame.centroid, forward) - dot(b.frame.centroid, forward))) {
        const f = fc.frame, fi = inputs.intent.facades.find(x => x.facadeId === fc.facadeId);
        if (!fi?.regions.length || -dot(f.normal, forward) < Math.cos((P.facingDeg * Math.PI) / 180)) continue;
        const world = (x: number, y: number): Vec3 => { const s0 = f.orthoSMin + x * f.pixel, t0 = f.orthoTMax - y * f.pixel; return [f.centroid[0] + s0 * f.axisS[0] + t0 * f.axisT[0], f.centroid[1] + s0 * f.axisS[1] + t0 * f.axisT[1], f.centroid[2] + s0 * f.axisS[2] + t0 * f.axisT[2]]; };
        const regs = fi.regions.map((r, k) => ({ r, k })).sort((a, b) => a.r.y0 - b.r.y0);
        regs.forEach(({ r, k }, j) => {
            const top = j === 0 ? 0 : (regs[j - 1].r.y1 + r.y0) / 2, bot = j === regs.length - 1 ? f.height : (r.y1 + regs[j + 1].r.y0) / 2;
            const id = regionKeys.length; regionKeys.push(`${fc.facadeId}.${k}`);
            fillRegion([world(0, bot), world(f.width, bot), world(f.width, top), world(0, top)], id);
        });
    }
    // 0b. the frame the intent inferred: each pier between two window columns, its two edges one continuous line down the shaft (structure); drawn first so the measured bays and the windows paint over it in the ID map
    let piers = 0;
    if (!isPlan && inputs.intent) for (const fc of [...(inputs.facades ?? [])].sort((a, b) => dot(a.frame.centroid, forward) - dot(b.frame.centroid, forward))) {
        const f = fc.frame, fi = inputs.intent.facades.find(x => x.facadeId === fc.facadeId);
        if (!fi?.structure?.piers.length || -dot(f.normal, forward) < cosFacing) continue;
        const world = (x: number, y: number): Vec3 => { const s0 = f.orthoSMin + x * f.pixel, t0 = f.orthoTMax - y * f.pixel; return [f.centroid[0] + s0 * f.axisS[0] + t0 * f.axisT[0], f.centroid[1] + s0 * f.axisS[1] + t0 * f.axisT[1], f.centroid[2] + s0 * f.axisS[2] + t0 * f.axisT[2]]; };
        for (const pr of fi.structure.piers) {
            const q = [world(pr[0], pr[3]), world(pr[2], pr[3]), world(pr[2], pr[1]), world(pr[0], pr[1])];
            if (!seen(world((pr[0] + pr[2]) / 2, (pr[1] + pr[3]) / 2))) continue;
            const pb = boxOf(q);
            if (taken('pier', pb, 0.5)) continue;
            claim('pier', pb);
            fillQuad(q, groupOf('pier', `${fc.facadeId}`));
            seg(q[0], q[3], TONE.structure, medium); seg(q[1], q[2], TONE.structure, medium);
            piers++;
        }
    }
    // 1. structure: each facing wall's recessed bays, a panel with its reveal (the piers stand between them)
    let walls = 0, bays = 0;
    // the bays' lines wait for the windows: a bay edge that runs just beside the windows it holds is the same line (snapped to them), else it would read doubled
    const pendingBays: Array<{ bb: number[]; reveal: Vec3[] }> = [];
    if (!isPlan) for (const w of inputs.walls ?? []) {
        if (-dot(w.normal, forward) < cosFacing) continue;
        const at = (uu: number, y: number): Vec3 => [w.normal[0] * w.offset + w.axisU[0] * uu, y, w.normal[2] * w.offset + w.axisU[2] * uu];
        let any = false;
        for (const b of w.bays) {
            if (!seen(at((b.u0 + b.u1) / 2, (b.y0 + b.y1) / 2))) continue;
            const bq = [at(b.u0, b.y0), at(b.u1, b.y0), at(b.u1, b.y1), at(b.u0, b.y1)], bb = boxOf(bq);
            if (taken('bay', bb, 0.5)) { duplicatesSkipped++; continue; }
            claim('bay', bb);
            fillQuad(bq, groupOf('bay', `wall${w.wallId}`));
            const r = Math.min(P.revealM, (b.u1 - b.u0) / 4);
            pendingBays.push({ bb, reveal: [at(b.u0 + r, b.y0), at(b.u1 - r, b.y0), at(b.u1 - r, b.y1 - r), at(b.u0 + r, b.y1 - r)] });
            bays++; any = true;
        }
        if (any) walls++;
    }

    // 2. openings: each facing facade's windows with their frames, mullions (its panes), sills and the spandrels between
    let facadesDrawn = 0, windows = 0, panes = 0, sills = 0, spandrels = 0, mirrored = 0, facadeAxes = 0;
    const readingOf = (id: number) => inputs.symmetry?.facades.find(f => f.facadeId === id);
    // the fullest reading first (where two readings conflict, the one with more windows claims the area), then the nearest; the depth test already hides what stands behind
    const windowsOf = (fc: BlueprintFacade) => inputs.intent?.facades.find(x => x.facadeId === fc.facadeId)?.windows.length ?? fc.rects.length;
    const ordered = [...(inputs.facades ?? [])].sort((a, b) => windowsOf(b) - windowsOf(a) || dot(a.frame.centroid, forward) - dot(b.frame.centroid, forward));
    if (!isPlan) for (const fc of ordered) {
        const f = fc.frame;
        if (-dot(f.normal, forward) < cosFacing) continue;
        const world = (s: number, t: number): Vec3 => [f.centroid[0] + s * f.axisS[0] + t * f.axisT[0], f.centroid[1] + s * f.axisS[1] + t * f.axisT[1], f.centroid[2] + s * f.axisS[2] + t * f.axisT[2]];
        const toS = (x: number) => f.orthoSMin + x * f.pixel, toT = (y: number) => f.orthoTMax - y * f.pixel;
        const rectWorld = (r: number[]) => { const s0 = toS(r[0]), s1 = toS(r[2]), t0 = toT(r[3]), t1 = toT(r[1]); return { s0, s1, t0, t1, q: [world(s0, t0), world(s1, t0), world(s1, t1), world(s0, t1)] }; };
        const visibleRect = (r: number[]) => { const g = rectWorld(r); return seen(world((g.s0 + g.s1) / 2, (g.t0 + g.t1) / 2)) ? g : undefined; };
        let any = false;
        const drawn: Array<{ s0: number; s1: number; t0: number; t1: number; family: number }> = [];
        const mine: number[][] = [];
        // the windows: from the design intent when given (each region's organisation decided, repeats, mirrors and twins inferred), else the module snap, else as read
        const fi = inputs.intent?.facades.find(x => x.facadeId === fc.facadeId);
        const mod = !fi && P.snapToModule ? moduleOf(fc) : undefined;
        const items: Array<{ r: number[]; panes: number; family: number; source: IntentSource }> = fi ? fi.windows.map(w => ({ r: w.rect, panes: w.panes, family: w.family, source: w.source }))
            : mod ? mod.rects.map((r, k) => ({ r, panes: mod.panes[k], family: 0, source: 'measured' as IntentSource })) : fc.rects.map(r => ({ r, panes: 0, family: 0, source: 'measured' as IntentSource }));
        const frameS = (g: { s0: number; s1: number; t0: number; t1: number }) => Math.min(P.frameM, (g.s1 - g.s0) / 4, (g.t1 - g.t0) / 4);
        for (const it of items) {
            const r = it.r;
            const g = visibleRect(r);
            if (!g) continue;
            const wb = boxOf(g.q);
            // real neighbouring windows never overlap: any overlap of windowDupShare is the same window read twice
            if (taken('window', wb, P.windowDupShare)) { duplicatesSkipped++; continue; }
            // a second reading's grid interleaved with one already drawn: its window's centre inside the area another facade's windows cover
            const cx = (wb[0] + wb[2]) / 2, cy = (wb[1] + wb[3]) / 2;
            if (coveredByOther(cx, cy, fc.facadeId)) { duplicatesSkipped++; continue; }
            claim('window', wb); mine.push(wb); coverBox(wb, fc.facadeId);
            const fr = frameS(g);
            fillQuad(g.q, groupOf('frame', `${fc.facadeId}.${it.family}`));
            fillQuad([world(g.s0 + fr, g.t0 + fr), world(g.s1 - fr, g.t0 + fr), world(g.s1 - fr, g.t1 - fr), world(g.s0 + fr, g.t1 - fr)], groupOf('glass', `${fc.facadeId}.${it.family}`));
            bySource[it.source] = (bySource[it.source] ?? 0) + 1;
            quad(g.q, TONE.opening, 0);
            line(sheet, X(dot(world(g.s0 - P.sillM, g.t0), right)), Y(dot(world(g.s0 - P.sillM, g.t0), up)), X(dot(world(g.s1 + P.sillM, g.t0), right)), Y(dot(world(g.s1 + P.sillM, g.t0), up)), TONE.opening, 0);
            windows++; sills++; any = true; drawn.push({ ...g, family: it.family });
        }
        // the mullions: with the module, each window split evenly at its column's pane count; else the reading's panes
        if (fi || mod) for (const it of items) {
            const nPanes = it.panes;
            if (nPanes < 2) continue;
            const g = rectWorld(it.r), b = boxOf(g.q);
            if (!mine.some(o => o[0] === b[0] && o[1] === b[1] && o[2] === b[2] && o[3] === b[3])) continue;
            const fr = frameS(g), fg = groupOf('frame', `${fc.facadeId}.${it.family}`);
            for (let k = 1; k < nPanes; k++) { const sx = g.s0 + ((g.s1 - g.s0) * k) / nPanes; seg(world(sx, g.t0), world(sx, g.t1), TONE.fine, 0); fillQuad([world(sx - fr / 2, g.t0), world(sx + fr / 2, g.t0), world(sx + fr / 2, g.t1), world(sx - fr / 2, g.t1)], fg); }
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
            fillQuad([world(s0, t0), world(s1, t0), world(s1, t1), world(s0, t1)], groupOf('spandrel', `${fc.facadeId}.${a.family}`));
            spandrels++;
        }
        // the facade's own mirror: its axis, and each window's mirror into a site no window touches
        const rd = readingOf(fc.facadeId);
        if (rd && rd.detected && !rd.periodic && rd.axisS !== undefined && (rd.ncc ?? 0) >= P.mirrorNcc) {
            const a = rd.axisS, toX = (s: number) => (s - f.orthoSMin) / f.pixel;
            if (!fi) for (const r of fc.rects) {
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

    // 2b. the bays' lines: each edge within baySnapM of the windows inside the bay is drawn on the windows' edge; the reveal only where the windows leave the bay mostly open
    const snapPx = P.baySnapM / pixelM, winGrid = claims.get('window');
    for (const { bb, reveal } of pendingBays) {
        const inside: number[][] = [];
        if (winGrid) for (let gy = Math.floor(bb[1] / CELL); gy <= Math.floor(bb[3] / CELL); gy++) for (let gx = Math.floor(bb[0] / CELL); gx <= Math.floor(bb[2] / CELL); gx++) for (const o of winGrid.get(gy * 100000 + gx) ?? []) {
            if (inside.includes(o)) continue;
            const ix = Math.max(0, Math.min(bb[2], o[2]) - Math.max(bb[0], o[0])), iy = Math.max(0, Math.min(bb[3], o[3]) - Math.max(bb[1], o[1]));
            if (ix * iy >= 0.5 * Math.max(1, (o[2] - o[0]) * (o[3] - o[1]))) inside.push(o);
        }
        const e = [...bb];
        let covered = 0;
        if (inside.length) {
            const wx0 = Math.min(...inside.map(o => o[0])), wy0 = Math.min(...inside.map(o => o[1])), wx1 = Math.max(...inside.map(o => o[2])), wy1 = Math.max(...inside.map(o => o[3]));
            if (Math.abs(e[0] - wx0) <= snapPx) e[0] = wx0; if (Math.abs(e[2] - wx1) <= snapPx) e[2] = wx1;
            if (Math.abs(e[1] - wy0) <= snapPx) e[1] = wy0; if (Math.abs(e[3] - wy1) <= snapPx) e[3] = wy1;
            covered = inside.reduce((a, o) => a + (o[2] - o[0]) * (o[3] - o[1]), 0) / Math.max(1, (bb[2] - bb[0]) * (bb[3] - bb[1]));
        }
        for (const [x0, y0, x1, y1] of [[e[0], e[1], e[2], e[1]], [e[2], e[1], e[2], e[3]], [e[2], e[3], e[0], e[3]], [e[0], e[3], e[0], e[1]]]) line(sheet, x0, y0, x1, y1, TONE.structure, medium);
        if (covered < 0.5) quad(reveal, TONE.fine, 0);
    }

    // 3. the outline: silhouettes heaviest, creases medium, along the view's axes; long horizontal runs doubled as ledges
    const sinAxis = Math.sin((P.axisDeg * Math.PI) / 180);
    const edges = classifyEdges(m, forward, Math.cos((P.creaseDeg * Math.PI) / 180), P.minEdgeLenM).filter(e => e.kind !== 'boundary');
    const levelBins = new Map<number, number>();
    let outlineEdges = 0, ledges = 0;
    // silhouettes first, so a crease crowding one gives way to it; each drawn pixel remembers its edge
    edges.sort((a, b) => (a.kind === 'silhouette' ? 0 : 1) - (b.kind === 'silhouette' ? 0 : 1));
    const outEdge = new Int32Array(dw * dh).fill(-1);
    const crowded = (uu: number, vv: number, vertical: boolean, e: number, r: number) => {
        const x = Math.round(col(uu)), y = Math.round(row(vv));
        for (let k = -r; k <= r; k++) { if (!k) continue; const xx = vertical ? x + k : x, yy = vertical ? y : y + k; if (xx < 0 || yy < 0 || xx >= dw || yy >= dh) continue; const o = outEdge[yy * dw + xx]; if (o >= 0 && o !== e) return true; }
        return false;
    };
    for (let ei = 0; ei < edges.length; ei++) {
        const e = edges[ei];
        const ua = u(e.a), va = v(e.a), ub = u(e.b), vb = v(e.b), len = Math.hypot(ub - ua, vb - va);
        if (!(len > 0) || Math.min(Math.abs(ub - ua), Math.abs(vb - va)) / len > sinAxis) continue;
        const da = d(e.a), db = d(e.b), n = Math.max(1, Math.round((len / pixelM) * 1.3));
        const horizontal = !isPlan && Math.abs(vb - va) <= sinAxis * len;
        let drawnPx = 0, visPx = 0, run = -1;
        const flush = (endS: number) => {
            if (run < 0) return;
            const f0 = run / n, f1 = endS / n, x0 = X(ua + (ub - ua) * f0), y0 = Y(va + (vb - va) * f0), x1 = X(ua + (ub - ua) * f1), y1 = Y(va + (vb - va) * f1);
            vline(sheet, x0, y0, x1, y1, 1, e.kind === 'silhouette' ? heavy : medium);
            if (horizontal && len >= P.ledgeMinM) vline(sheet, x0, y0 + P.ledgeM / pixelM, x1, y1 + P.ledgeM / pixelM, TONE.opening, 0);
            run = -1;
        };
        for (let s = 0; s <= n; s++) {
            const f = s / n, uu = ua + (ub - ua) * f, vv = va + (vb - va) * f;
            const vis = visibleAt(uu, vv, da + (db - da) * f, P.depthEpsM);
            if (vis) visPx++;
            // the crowding is the drawing's (what a line can show); the levels below count every visible run, crowded or not
            if (!vis || crowded(uu, vv, !horizontal, ei, e.kind === 'silhouette' ? P.creaseCrowdPx + 2 : P.creaseCrowdPx)) { flush(s - 1); continue; }
            if (run < 0) run = s;
            { const x = Math.round(col(uu)), y = Math.round(row(vv)); if (x >= 0 && y >= 0 && x < dw && y < dh) outEdge[y * dw + x] = ei; }
            ink(sheet, X(uu), Y(vv), 1, e.kind === 'silhouette' ? heavy : medium);
            if (horizontal && len >= P.ledgeMinM) ink(sheet, X(uu), Y(vv - P.ledgeM), TONE.opening, 0);
            drawnPx++;
        }
        flush(n);
        if (horizontal && visPx) { const bin = Math.round(((va + vb) / 2) / P.levelBinM); levelBins.set(bin, (levelBins.get(bin) ?? 0) + (visPx / (n + 1)) * len); }
        if (!drawnPx) continue;
        outlineEdges++;
        if (horizontal && len >= P.ledgeMinM) ledges++;
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
        'HEAVY: SILHOUETTE. FULL TONE: CREASES, LEDGES (DOUBLED), RECESSED BAYS AND PIERS. LIGHTER: WINDOWS AND SILLS. LIGHTEST: REVEALS, MULLIONS, SPANDREL PANELS.',
        'OUTLINE AND LEVELS MEASURED FROM THE SCAN. BAYS, WINDOWS, PANES AND SPANDRELS INFERRED FROM THE FACADE PHOTOS, AND THE FAINT HAIRLINES TRACED FROM THEM (PHOTO-INFERRED). ' + (inputs.intent ? 'WINDOWS DRAWN FROM THE DESIGN INTENT: EACH REGION REPEATING, SYMMETRIC OR NEITHER, WHAT THE PHOTOS MISSED INFERRED FROM THE REPEAT, THE MIRROR OR A TWIN FACADE (SEE STRUCTURE_INTENT.JSON). DASH-DOT: AXIS OF SYMMETRY.' : 'DASHED: A WINDOW MIRRORED ABOUT ITS FACADE\'S AXIS (GENERATED). DASH-DOT: AXIS OF SYMMETRY.')
    ];
    const small = Math.max(1, ts - 1), chars = Math.floor((tbW - 20) / (6 * small));
    text(sheet, tbX + 10, tbY + 6, wrapTo(rows[0], Math.floor((tbW - 20) / (6 * ts)))[0], ts);
    rows.slice(1).flatMap(r => wrapTo(r, chars)).slice(0, Math.floor((tbH - 14 * ts - 16) / (10 * small))).forEach((r, i) => text(sheet, tbX + 10, tbY + 14 * ts + 12 + i * 10 * small, r, small));
    // the bare surface in blocks: each block its own group (the materials stage merges them by colour and smooths them by neighbourhood)
    const bpx = Math.max(1, Math.round(P.matBlockM / pixelM)), bw = Math.ceil(dw / bpx), bh = Math.ceil(dh / bpx), blockGroup = new Int32Array(bw * bh).fill(-1);
    const surfaceRole = isPlan ? 'roof' : 'wall';
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
        const i = y * dw + x;
        if (inst[i] >= 0 || !Number.isFinite(depth[i])) continue;
        // inside a facade region: the region's wall, one group (one material) for the whole band; elsewhere a block
        if (regionAt[i] >= 0) { inst[i] = groupOf(surfaceRole, `region.${regionKeys[regionAt[i]]}`); continue; }
        const b = Math.floor(y / bpx) * bw + Math.floor(x / bpx);
        if (blockGroup[b] < 0) blockGroup[b] = groupOf(surfaceRole, `${view.name}.${b}`);
        inst[i] = blockGroup[b];
    }
    for (let i = 0; i < dw * dh; i++) {
        const g = inst[i]; if (g < 0) continue;
        const G = groups[g]; G.n++;
        if (rgbPhoto && Number.isFinite(rgbPhoto[3 * i])) { const [L, A, B] = linToLab(rgbPhoto[3 * i], rgbPhoto[3 * i + 1], rgbPhoto[3 * i + 2]); G.c++; G.L += L; G.A += A; G.B += B; }
    }
    // the whole building's material map from this view: each sample a splat of its spacing, the front-most per pixel, only on the surface the depth test sees
    let surface: Uint8Array | undefined;
    if (inputs.surfaceMap) {
        const sm = inputs.surfaceMap, zb = new Float32Array(dw * dh).fill(Infinity), mid = new Int32Array(dw * dh), r = Math.max(0, Math.round(sm.spacingM / pixelM / 2));
        for (let i = 0; i < sm.material.length; i++) {
            const mm = sm.material[i]; if (!mm) continue;
            const q: Vec3 = [sm.p[3 * i], sm.p[3 * i + 1], sm.p[3 * i + 2]], uu = dot(q, right), vv = dot(q, up), dd = dot(q, forward);
            const x = Math.round(col(uu)), y = Math.round(row(vv));
            if (x < 0 || y < 0 || x >= dw || y >= dh) continue;
            const b = depth[y * dw + x]; if (!Number.isFinite(b) || dd > b + P.surfaceDepthM) continue;
            for (let yy = Math.max(0, y - r); yy <= Math.min(dh - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(dw - 1, x + r); xx++) { const k = yy * dw + xx; if (dd < zb[k]) { zb[k] = dd; mid[k] = mm; } }
        }
        surface = new Uint8Array(W * H * 3).fill(255);
        for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) { const mm = mid[y * dw + x]; if (!mm || !Number.isFinite(depth[y * dw + x])) continue; const c = sm.colours[mm - 1] ?? [128, 128, 128]; surface.set(c, ((y + M) * W + x + M) * 3); }
    }
    return {
        ...(surface ? { surface } : {}),
        mat: { inst, dw, dh, M, pixelM, groups, blocks: { bw, bh, px: bpx, group: blockGroup } },
        png: sheet,
        stats: { name: view.name, label, width: W, height: H, pixelM, originU: uMin - M * pixelM, originV: vMax + M * pixelM, right, up, forward, outlineEdges, ledges, walls, bays, facades: facadesDrawn, windows, panes, sills, spandrels, duplicatesSkipped, photoEdgePixels, mirroredWindows: mirrored, facadeAxes, planAxes, levels: levels.map(l => Math.round((l - groundY) * 10) / 10), extentM: [Math.round(wM * 10) / 10, Math.round(hM * 10) / 10], ...(inputs.intent ? { bySource, piers } : {}) }
    };
}

/**
 * The material ID map's materials, over every view at once (one ID is one material in each): each role's element groups
 * merged by colour (CIELAB, leader clustering, the best-photographed first), a material too small to stand joins its
 * nearest, groups the photo never reached take their role's largest material (generated), and the bare surface's blocks
 * take their neighbourhood's majority, so a stain or a shadow inside a wall is the wall's material, not its own.
 */
function assignMaterials(mats: MatSheet[], P: BlueprintParams): { entries: MaterialEntry[]; perView: Int32Array[] } {
    type Mat = { id: number; role: string; L: number; A: number; B: number; w: number; n: number; groups: number; px: number };
    const mats2: Mat[] = [], gMat = mats.map(m => new Int32Array(m.groups.length).fill(-1));
    const all = mats.flatMap((m, v) => m.groups.map((g, k) => ({ v, k, g, px: m.pixelM * m.pixelM })));
    // chroma relative to lightness: a material in shade keeps its hue and its chroma's share of its lightness, both shrinking together
    const rel = (c: number, L: number) => (c * 60) / Math.max(15, L);
    const de = (a: { L: number; A: number; B: number }, b: { L: number; A: number; B: number }) => Math.hypot(P.matLightWeight * (a.L - b.L), rel(a.A, a.L) - rel(b.A, b.L), rel(a.B, a.L) - rel(b.B, b.L));
    const roles = [...new Set(all.map(x => x.g.role))];
    for (const role of roles) {
        const surface = role === 'wall' || role === 'roof', thr = surface ? P.matDeltaESurface : P.matDeltaE;
        const mine = all.filter(x => x.g.role === role), lit = mine.filter(x => x.g.c >= Math.max(1, 0.2 * x.g.n)).sort((a, b) => b.g.c - a.g.c);
        const roleMats: Mat[] = [];
        for (const x of lit) {
            const c = { L: x.g.L / x.g.c, A: x.g.A / x.g.c, B: x.g.B / x.g.c };
            let best: Mat | undefined, bd = Infinity;
            for (const m of roleMats) { const d = de(m, c); if (d < bd) { bd = d; best = m; } }
            if (!best || bd > thr) { best = { id: -1, role, L: c.L, A: c.A, B: c.B, w: 0, n: 0, groups: 0, px: 0 }; roleMats.push(best); }
            const w = x.g.c; best.L = (best.L * best.w + c.L * w) / (best.w + w); best.A = (best.A * best.w + c.A * w) / (best.w + w); best.B = (best.B * best.w + c.B * w) / (best.w + w); best.w += w;
            best.n += x.g.n; best.px += x.g.n * x.px; best.groups++;
            gMat[x.v][x.k] = roleMats.indexOf(best);
        }
        const into = roleMats.map((_, i) => i);
        const root = (i: number): number => (into[i] === i ? i : (into[i] = root(into[i])));
        // the leader pass's centres drift as members join: two that end within the threshold are one material (closest pair first)
        for (;;) {
            let bi = -1, bj = -1, bd = thr;
            for (let i = 0; i < roleMats.length; i++) if (root(i) === i && roleMats[i].n) for (let j = i + 1; j < roleMats.length; j++) if (root(j) === j && roleMats[j].n) { const d = de(roleMats[i], roleMats[j]); if (d < bd) { bd = d; bi = i; bj = j; } }
            if (bi < 0) break;
            const a = roleMats[bi], b = roleMats[bj], w = a.w + b.w || 1;
            a.L = (a.L * a.w + b.L * b.w) / w; a.A = (a.A * a.w + b.A * b.w) / w; a.B = (a.B * a.w + b.B * b.w) / w; a.w += b.w; a.n += b.n; a.px += b.px; a.groups += b.groups; b.n = 0; into[bj] = bi;
        }
        // too small to stand: joins its nearest (the indices into roleMats are remapped below)
        const total = roleMats.reduce((a, m) => a + m.n, 0);
        for (let i = 0; i < roleMats.length; i++) {
            if (root(i) !== i || roleMats[i].n >= P.matMinShare * total) continue;
            let best = -1, bd = Infinity;
            roleMats.forEach((o, j) => { if (j !== i && root(j) === j && o.n >= P.matMinShare * total) { const d = de(o, roleMats[i]); if (d < bd) { bd = d; best = j; } } });
            if (best >= 0) { into[i] = best; const o = roleMats[best]; o.n += roleMats[i].n; o.px += roleMats[i].px; o.groups += roleMats[i].groups; roleMats[i].n = 0; }
        }
        const largest = roleMats.length ? roleMats.reduce((bi, m, i, a) => (m.n > a[bi].n ? i : bi), 0) : -1;
        let unlit: Mat | undefined;
        for (const x of mine) {
            let ix = gMat[x.v][x.k];
            if (ix >= 0) ix = root(ix);
            else if (!surface) {
                // the photo never reached it: its role's largest material, else one unlit material for the role
                if (largest >= 0) ix = largest;
                else { if (!unlit) { unlit = { id: -1, role, L: NaN, A: NaN, B: NaN, w: 0, n: 0, groups: 0, px: 0 }; roleMats.push(unlit); } ix = roleMats.indexOf(unlit); }
                roleMats[ix].groups++; roleMats[ix].n += x.g.n; roleMats[ix].px += x.g.n * x.px;
            }
            gMat[x.v][x.k] = ix >= 0 ? mats2.length + ix : -1;
        }
        mats2.push(...roleMats);
    }
    // the bare surface: each block takes its neighbourhood's majority (matSmoothR, matSmoothPasses), an unlit block the majority around it, else its role's largest
    mats.forEach((m, v) => {
        const { bw, bh, group } = m.blocks;
        for (let pass = 0; pass < P.matSmoothPasses; pass++) {
            const next = new Int32Array(bw * bh).fill(-1);
            for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
                const g = group[y * bw + x]; if (g < 0) continue;
                const votes = new Map<number, number>();
                for (let j = -P.matSmoothR; j <= P.matSmoothR; j++) for (let i = -P.matSmoothR; i <= P.matSmoothR; i++) { const xx = x + i, yy = y + j; if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue; const gg = group[yy * bw + xx]; if (gg < 0) continue; const mi = gMat[v][gg]; if (mi >= 0) votes.set(mi, (votes.get(mi) ?? 0) + (i === 0 && j === 0 ? 1.5 : 1)); }
                let best = -1, bv = 0; for (const [mi, c] of votes) if (c > bv) { bv = c; best = mi; }
                next[y * bw + x] = best;
            }
            for (let b = 0; b < bw * bh; b++) if (group[b] >= 0 && next[b] >= 0) gMat[v][group[b]] = next[b];
        }
        for (let b = 0; b < bw * bh; b++) {
            const g = group[b]; if (g < 0 || gMat[v][g] >= 0) continue;
            const role = m.groups[g].role, cand = mats2.map((mm, i) => [mm, i] as const).filter(([mm]) => mm.role === role).sort((a, b2) => b2[0].n - a[0].n)[0];
            gMat[v][g] = cand ? cand[1] : -1;
        }
    });
    // number the materials that hold area, and colour them apart (golden-angle hues)
    const used = new Set<number>(); gMat.forEach(a => a.forEach(i => { if (i >= 0) used.add(i); }));
    const order = [...used].sort((a, b) => mats2[a].role.localeCompare(mats2[b].role) || mats2[b].n - mats2[a].n);
    const entries: MaterialEntry[] = [], idOf = new Map<number, number>();
    order.forEach((mi, k) => {
        const mm = mats2[mi], id = k + 1, h = (k * 137.508) % 360, sat = 0.55, val = 0.92 - 0.25 * ((k >> 2) % 2);
        const f = (n: number) => { const kk = (n + h / 60) % 6; return Math.round(255 * (val - val * sat * Math.max(0, Math.min(kk, 4 - kk, 1)))); };
        const lit = Number.isFinite(mm.L);
        const lin = lit ? labToLin(mm.L, mm.A, mm.B) : undefined;
        idOf.set(mi, id);
        entries.push({ id, role: mm.role, idColor: [f(5), f(3), f(1)], ...(lin ? { photoColor: [linearToSrgb8(lin[0]), linearToSrgb8(lin[1]), linearToSrgb8(lin[2])] as [number, number, number], lab: [Math.round(mm.L * 10) / 10, Math.round(mm.A * 10) / 10, Math.round(mm.B * 10) / 10] as [number, number, number] } : {}), areaM2: Math.round(mm.px * 10) / 10, groups: mm.groups, provenance: lit ? 'photo-inferred' : 'generated', reason: lit ? `the ${mm.role} elements whose photo colours fall within ${mm.role === 'wall' || mm.role === 'roof' ? P.matDeltaESurface : P.matDeltaE} of each other (CIELAB, lightness weighted ${P.matLightWeight}: one material lit differently), each element read as a whole` : `no photo reached these ${mm.role} elements: one material assumed for the role` });
    });
    return { entries, perView: gMat.map(a => Int32Array.from(a, i => (i >= 0 ? idOf.get(i) ?? 0 : 0))) };
}

/** The building alone: the street and the base's loose fill outside the building's footprint left out (see BLUEPRINT_PARAMS.streetM). */
export function withoutStreet(soup: Float32Array | Float64Array, P: BlueprintParams = BLUEPRINT_PARAMS): { soup: Float32Array | Float64Array; droppedM2: number } {
    let gy = Infinity;
    for (let i = 1; i < soup.length; i += 3) if (soup[i] < gy) gy = soup[i];
    if (!Number.isFinite(gy)) return { soup, droppedM2: 0 };
    // the footprint: the plan the building above footprintAboveM traces (every edge of its triangles walked at half a
    // cell, every triangle's plan filled), closed: a cell the outside cannot reach by flood is inside the building
    const c = P.footprintCellM, nTri = soup.length / 9;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < soup.length; i += 3) { minX = Math.min(minX, soup[i]); maxX = Math.max(maxX, soup[i]); minZ = Math.min(minZ, soup[i + 2]); maxZ = Math.max(maxZ, soup[i + 2]); }
    const pad = 2, gw = Math.ceil((maxX - minX) / c) + 1 + 2 * pad, gh = Math.ceil((maxZ - minZ) / c) + 1 + 2 * pad;
    const cx = (x: number) => Math.floor((x - minX) / c) + pad, cz = (z: number) => Math.floor((z - minZ) / c) + pad;
    const traced = new Uint8Array(gw * gh);
    let any = false;
    for (let t = 0; t < nTri; t++) {
        const o = 9 * t;
        if (Math.min(soup[o + 1], soup[o + 4], soup[o + 7]) - gy < P.footprintAboveM) continue;
        any = true;
        const X = [soup[o], soup[o + 3], soup[o + 6]], Z = [soup[o + 2], soup[o + 5], soup[o + 8]];
        for (let k = 0; k < 3; k++) {
            const x0 = X[k], z0 = Z[k], x1 = X[(k + 1) % 3], z1 = Z[(k + 1) % 3], n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / (c / 2)));
            for (let j = 0; j <= n; j++) traced[cz(z0 + ((z1 - z0) * j) / n) * gw + cx(x0 + ((x1 - x0) * j) / n)] = 1;
        }
        const area = (X[1] - X[0]) * (Z[2] - Z[0]) - (X[2] - X[0]) * (Z[1] - Z[0]);
        if (Math.abs(area) < c * c) continue;
        for (let gz = cz(Math.min(...Z)); gz <= cz(Math.max(...Z)); gz++) for (let gx = cx(Math.min(...X)); gx <= cx(Math.max(...X)); gx++) {
            const px = minX + (gx - pad + 0.5) * c, pz = minZ + (gz - pad + 0.5) * c;
            const w0 = ((X[1] - px) * (Z[2] - pz) - (X[2] - px) * (Z[1] - pz)) / area, w1 = ((X[2] - px) * (Z[0] - pz) - (X[0] - px) * (Z[2] - pz)) / area;
            if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) traced[gz * gw + gx] = 1;
        }
    }
    if (!any) return { soup, droppedM2: 0 };
    // grow the traced cells by the margin, then flood the outside from the grid's border
    const grow = Math.ceil(P.footprintMarginM / c), wall = new Uint8Array(gw * gh);
    for (let z = 0; z < gh; z++) for (let x = 0; x < gw; x++) if (traced[z * gw + x]) for (let j = -grow; j <= grow; j++) for (let i = -grow; i <= grow; i++) { const xx = x + i, zz = z + j; if (xx >= 0 && zz >= 0 && xx < gw && zz < gh) wall[zz * gw + xx] = 1; }
    const outside = new Uint8Array(gw * gh), stack: number[] = [];
    for (let x = 0; x < gw; x++) stack.push(x, (gh - 1) * gw + x);
    for (let z = 0; z < gh; z++) stack.push(z * gw, z * gw + gw - 1);
    while (stack.length) {
        const i = stack.pop()!;
        if (outside[i] || wall[i]) continue;
        outside[i] = 1;
        const x = i % gw, z = (i - x) / gw;
        if (x > 0) stack.push(i - 1); if (x < gw - 1) stack.push(i + 1); if (z > 0) stack.push(i - gw); if (z < gh - 1) stack.push(i + gw);
    }
    const inFoot = (x: number, z: number) => !outside[cz(z) * gw + cx(x)];
    const keep: number[] = [];
    let dropped = 0;
    for (let t = 0; t < nTri; t++) {
        const o = 9 * t;
        const e1 = [soup[o + 3] - soup[o], soup[o + 4] - soup[o + 1], soup[o + 5] - soup[o + 2]], e2 = [soup[o + 6] - soup[o], soup[o + 7] - soup[o + 1], soup[o + 8] - soup[o + 2]];
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], len = Math.hypot(n[0], n[1], n[2]);
        const ymax = Math.max(soup[o + 1], soup[o + 4], soup[o + 7]) - gy;
        const street = len > 0 && n[1] / len > P.streetUpNy && ymax <= P.streetM;
        const loose = ymax < P.footprintAboveM && !inFoot((soup[o] + soup[o + 3] + soup[o + 6]) / 3, (soup[o + 2] + soup[o + 5] + soup[o + 8]) / 3);
        if (street || loose) { dropped += len / 2; continue; }
        keep.push(t);
    }
    if (keep.length === nTri) return { soup, droppedM2: 0 };
    const out = new Float32Array(keep.length * 9);
    keep.forEach((t, i) => { for (let k = 0; k < 9; k++) out[9 * i + k] = soup[9 * t + k]; });
    return { soup: out, droppedM2: dropped };
}

/**
 * The elevation set of a scan (a triangle soup in the frame its facades, walls and symmetry are read in): four
 * elevations square to its walls (A to D) and the roof plan, constructed from what `inputs` gives, each with its
 * material ID map in the same pixels (`material`: each drawn region one material's colour, the table in
 * report.materials; `overlay`: the drawing's lines over it).
 */
export function renderBlueprints(positions: Float32Array | Float64Array, inputs: BlueprintInputs = {}, P: BlueprintParams = BLUEPRINT_PARAMS): { report: BlueprintReport; pngs: Array<{ name: string; width: number; height: number; rgb: Uint8Array; svg: string; material: Uint8Array; overlay: Uint8Array; surface?: Uint8Array; surfaceOverlay?: Uint8Array }> } {
    const t0 = Date.now();
    // the building alone: the street and the base's loose fill left out of the outline, the depth and the ID map
    const shell = withoutStreet(inputs.structure ?? positions, P);
    const m = weld(shell.soup);
    // the depth the elements and the outline are tested against: the structure with its openings closed, when given
    let depthMesh = m;
    if (inputs.structure && inputs.structureFill && inputs.structureFill.length) { const both = new Float64Array(shell.soup.length + inputs.structureFill.length); both.set(shell.soup); both.set(inputs.structureFill, shell.soup.length); depthMesh = weld(both); }
    const azimuth = wallAzimuthDeg(m);
    let groundY = Infinity;
    for (let i = 1; i < m.P.length; i += 3) if (m.P[i] < groundY) groundY = m.P[i];
    const labels: Record<string, string> = { north: 'ELEVATION A', east: 'ELEVATION B', south: 'ELEVATION C', west: 'ELEVATION D', plan: 'ROOF PLAN' };
    const views = CARDINAL_VIEWS.map(v => turned(v, azimuth));
    const sheets: Array<{ png: Sheet; mat: MatSheet; surface?: Uint8Array }> = [], stats: BlueprintReport['views'] = [];
    for (const view of views) {
        const { png, stats: s, mat, surface } = renderSheet(m, view, labels[view.name] ?? view.name.toUpperCase(), inputs, P, azimuth, groundY, depthMesh);
        sheets.push({ png, mat, ...(surface ? { surface } : {}) }); stats.push(s);
    }
    const { entries, perView } = assignMaterials(sheets.map(s => s.mat), P);
    const colorOf = new Map(entries.map(e => [e.id, e.idColor]));
    const pngs = sheets.map(({ png, mat, surface }, v) => {
        const material = new Uint8Array(png.W * png.H * 3).fill(255), overlay = new Uint8Array(png.W * png.H * 3);
        for (let y = 0; y < mat.dh; y++) for (let x = 0; x < mat.dw; x++) {
            const g = mat.inst[y * mat.dw + x]; if (g < 0) continue;
            const c = colorOf.get(perView[v][g]); if (!c) continue;
            material.set(c, ((y + mat.M) * png.W + x + mat.M) * 3);
        }
        // the drawing over the map: each pixel the map's colour darkened by the drawing's ink
        for (let i = 0; i < png.W * png.H; i++) { const k = (png.rgb[3 * i] + png.rgb[3 * i + 1] + png.rgb[3 * i + 2]) / 765; for (let c = 0; c < 3; c++) overlay[3 * i + c] = Math.round(material[3 * i + c] * k); }
        let surfaceOverlay: Uint8Array | undefined;
        if (surface) { surfaceOverlay = new Uint8Array(png.W * png.H * 3); for (let i = 0; i < png.W * png.H; i++) { const k = (png.rgb[3 * i] + png.rgb[3 * i + 1] + png.rgb[3 * i + 2]) / 765; for (let c = 0; c < 3; c++) surfaceOverlay[3 * i + c] = Math.round(surface[3 * i + c] * k); } }
        return { name: views[v].name, width: png.W, height: png.H, rgb: png.rgb, svg: svgOf(png, SCHEMES[P.scheme].bg), material, overlay, ...(surface ? { surface, surfaceOverlay } : {}) };
    });
    return { report: { version: BLUEPRINT_VERSION, params: P, wallAzimuthDeg: azimuth, streetDroppedM2: Math.round(shell.droppedM2), views: stats, materials: entries, ms: Date.now() - t0 }, pngs };
}
