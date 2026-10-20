/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The shape program trial's stage (SCRATCHBOX_STAGED_SHAPE_PROGRAM; pipeline E's massing replaced, everything after it
 * unchanged):
 *
 *   1. Trees out first. The strip's measured crowns (crowns.json: stem, apex, support, sector radii, plan polygon) are kept
 *      as measurements; each crown's base height is read from the strip's removed triangles under it. The isolated scan
 *      (already cut from the devegetated tile) is split by the native tool into building, ground and tree triangles (a
 *      tree triangle lies in a crown's plan between its base and top, outside the vector footprint); everything removed is
 *      listed: the strip's removed triangles near the building (and those inside its footprint, to check), and the
 *      isolate's tree triangles per crown.
 *   2. Height-map tiers (no model): the native scan analysis (frame, 0.25 m height grid, tier levels, squared outlines).
 *   3. Shape program: one vision call on a contact sheet (the height map with the measured outline and its dimensions, four
 *      oblique clay views of the tree-free scan) answers a program in SHAPE_PROGRAM_JSON_SCHEMA.
 *   4. Fit: the native coordinate descent snaps the program's handles to the height grid and the oblique silhouettes and
 *      depths; at most one correction call with the difference images when the fit leaves the silhouettes or heights off.
 *   5. The massing (prisms as parts, the rest as solids) goes to the native massing kernel like the vector massing does;
 *      the trees are regrown by the build's own tree stage from the same crowns.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Vec2 } from '../../../../common/spatial/staged-location-contracts';
import { drawText } from '../photo-match-eval';
import { encodePng } from '../png-encode';
import { readTileTriangles } from '../tile-texture-transfer';
import type { VisionModelChain } from '../../../gemini/vision-model-chain';
import { checkMassing, inLoops, ringArea, type Massing, type MassingMesh, type MassingPart } from './massing-spec';
import { SHAPE_PROGRAM_TOKEN, SHAPE_TIERS_TOKEN } from './pipeline-e';
import { applyHandles, elementHandles, ensureShapeBinary, programSpecText, readF32, readU8, runShapeTool, SHAPE_PROGRAM_JSON_SCHEMA, validateProgram, type ParameterRecord, type ScanTargets, type ShapeProgram, type UV } from './shape-program';

export const SHAPE_STAGE_VERSION = 'shape-program/v5';
/** Thinking budget of the program call: under 1,024 tokens is LOW on Gemini 4. */
export const SHAPE_THINKING_BUDGET = 512;
/** A fit leaving more than this silhouette disagreement (1 - IoU, mean of the views) or height error (share of the building's height) asks for one correction. */
export const CORRECTION_SILHOUETTE = 0.12;
export const CORRECTION_HEIGHT = 0.08;
/** One program call's time limit and its output limit. */
export const SHAPE_CALL_TIMEOUT_MS = 120_000;
export const SHAPE_MAX_OUTPUT_TOKENS = 12_000;

/** The vision call (a VisionModelChain). */
export type ShapeVisionClient = Pick<VisionModelChain<string>, 'generate'>;

export interface ShapeStageInput {
    mode: 'tiers' | 'program';
    isolateGlb: string;
    groundY: number;
    /** The vector footprint loops (tile x, z) when Google has one near the structure; may be empty. */
    footprintLoops: Vec2[][];
    crownsJson?: string;
    removedTreesGlb?: string;
    scanTop: (x: number, z: number) => number;
    cells: ReadonlySet<string>;
    place: string;
    vision?: ShapeVisionClient;
    outDir: string;
    signal?: AbortSignal;
}

export interface TreeMeasurement {
    id: number; status: string; stem: Vec2; supportY: number; heightM: number; crownWidthM: number; crownBaseM: number;
    crownBaseSource: 'removed-triangles' | 'estimated'; sectorRadiiM: number[]; nearBuilding: boolean;
}

export interface TreeReport {
    crowns: TreeMeasurement[];
    stripRemovedNear: { triangles: number; areaM2: number };
    stripRemovedInsideFootprint: { triangles: number; areaM2: number };
    isolate: Record<string, unknown>;
}

export interface ShapeStageResult {
    massing: Massing;
    timingsMs: Record<string, number>;
    notes: string[];
    trees: TreeReport;
    scan: Record<string, unknown>;
    program?: { model?: string; raw: unknown; validated: ShapeProgram; problems: string[]; fitted: ShapeProgram; parameters: ParameterRecord[]; fit: Record<string, unknown>; correction?: Record<string, unknown> };
    files: Record<string, string>;
}

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

// ------------------------------------------------------------------------------------------------
// images
// ------------------------------------------------------------------------------------------------

function heightColour(h: number, max: number): [number, number, number] {
    if (!Number.isFinite(h) || h < 0.5) return [18, 18, 22];
    const t = Math.max(0, Math.min(1, h / Math.max(1, max)));
    // dark blue -> teal -> yellow -> white
    const stops: Array<[number, number, number]> = [[30, 50, 120], [30, 150, 150], [230, 210, 60], [255, 120, 90]];
    const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
    return [0, 1, 2].map(k => Math.round(stops[i][k] * (1 - f) + stops[i + 1][k] * f)) as [number, number, number];
}

class Canvas {
    rgb: Uint8Array;
    constructor(readonly W: number, readonly H: number, bg = 30) { this.rgb = new Uint8Array(W * H * 3).fill(bg); }
    set(x: number, y: number, c: readonly number[]): void { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= this.W || y >= this.H) return; const o = (y * this.W + x) * 3; this.rgb[o] = c[0]; this.rgb[o + 1] = c[1]; this.rgb[o + 2] = c[2]; }
    line(x0: number, y0: number, x1: number, y1: number, c: readonly number[], w = 1): void {
        const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))) + 1;
        for (let i = 0; i <= n; i++) { const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * i) / n; for (let d = -Math.floor(w / 2); d <= Math.floor((w - 1) / 2); d++) { this.set(x + d, y, c); this.set(x, y + d, c); } }
    }
    text(x: number, y: number, s: string, scale: number, c: [number, number, number]): void { drawText(this.rgb, this.W, this.H, Math.round(x), Math.round(y), s, scale, c); }
    blit(x0: number, y0: number, w: number, h: number, px: (x: number, y: number) => readonly number[]): void { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) this.set(x0 + x, y0 + y, px(x, y)); }
    png(): Buffer { return encodePng(this.W, this.H, this.rgb, 3); }
}

interface ScanDoc {
    frame: { ox: number; oz: number; theta: number; groundY: number; directionSupport: number };
    grid: { u0: number; v0: number; cell: number; nu: number; nv: number };
    classes: Json; footprintAgreement: number | null; outlineSource: string;
    levels: Array<{ h: number; areaM2: number }>;
    tiers: Array<{ baseY: number; topY: number; areaM2: number; loops: Array<Array<[number, number]>>; loopsUV: Array<Array<[number, number]>> }>;
    outlineUV: Array<Array<[number, number]>>;
    box: { lo: number[]; hi: number[] };
    cameras: Array<{ eye: number[]; fwd: number[]; right: number[]; up: number[]; focal: number; W: number; H: number }>;
    notes: string[]; timingsMs: Record<string, number>;
}

const VIEW_NAMES = ['FROM +U SIDE', 'FROM +V SIDE', 'FROM -U SIDE', 'FROM -V SIDE'];

/** The contact sheet the program is read from: the height map in the frame with the measured outline and its size, and the four oblique clay views. */
export function contactSheet(scanDir: string, scan: ScanDoc, measured: UV[], footprintUV: UV[][]): Buffer {
    const g = scan.grid;
    const h = readF32(path.join(scanDir, 'height.f32'));
    let maxH = 1;
    for (const v of h) if (Number.isFinite(v)) maxH = Math.max(maxH, v);
    const panel = 760;
    const s = Math.min((panel - 80) / (g.nu * g.cell), (panel - 120) / (g.nv * g.cell));  // px per metre
    const vw = scan.cameras[0].W, vh = scan.cameras[0].H;
    const W = panel + 2 * vw + 30, H = Math.max(panel + 90, 2 * vh + 120);
    const c = new Canvas(W, H, 28);
    c.text(10, 8, 'TREE-FREE SCAN OF THE STRUCTURE. FRAME: U ALONG THE DOMINANT WALL DIRECTION, V ACROSS, H = METRES ABOVE THE STREET', 2, [255, 255, 255]);
    const ox = 60, oy = 80;
    const X = (u: number) => ox + (u - g.u0) * s, Y = (v: number) => oy + (v - g.v0) * s;
    c.blit(ox, oy, Math.round(g.nu * g.cell * s), Math.round(g.nv * g.cell * s), (x, y) => {
        const i = Math.floor(x / s / g.cell), j = Math.floor(y / s / g.cell);
        return heightColour(i < g.nu && j < g.nv ? h[j * g.nu + i] : NaN, maxH);
    });
    // metre grid every 5 m with labels
    const step = (g.nu * g.cell > 120 || g.nv * g.cell > 120) ? 10 : 5;
    for (let u = Math.ceil(g.u0 / step) * step; u <= g.u0 + g.nu * g.cell; u += step) { c.line(X(u), oy, X(u), Y(g.v0 + g.nv * g.cell), u === 0 ? [255, 120, 120] : [70, 70, 80]); c.text(X(u) - 8, oy - 18, `${u}`, 2, [220, 220, 220]); }
    for (let v = Math.ceil(g.v0 / step) * step; v <= g.v0 + g.nv * g.cell; v += step) { c.line(ox, Y(v), X(g.u0 + g.nu * g.cell), Y(v), v === 0 ? [255, 120, 120] : [70, 70, 80]); c.text(ox - 46, Y(v) - 6, `${v}`, 2, [220, 220, 220]); }
    c.text(ox, oy - 40, 'U (M) TO THE RIGHT, V (M) DOWNWARD', 2, [255, 150, 150]);
    for (const loop of footprintUV) for (let k = 0; k < loop.length; k++) { const a = loop[k], b = loop[(k + 1) % loop.length]; c.line(X(a[0]), Y(a[1]), X(b[0]), Y(b[1]), [80, 220, 255], 1); }
    for (let k = 0; k < measured.length; k++) {
        const a = measured[k], b = measured[(k + 1) % measured.length];
        c.line(X(a[0]), Y(a[1]), X(b[0]), Y(b[1]), [255, 255, 255], 2);
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len >= 3) c.text((X(a[0]) + X(b[0])) / 2 + 3, (Y(a[1]) + Y(b[1])) / 2 + 3, `${len.toFixed(1)}`, 2, [255, 255, 255]);
    }
    // height legend
    const lx = ox, ly = H - 34;
    for (let x = 0; x < 300; x++) { const col = heightColour((x / 300) * maxH + 0.6, maxH); for (let y = 0; y < 10; y++) c.set(lx + x, ly + y, col); }
    c.text(lx, ly + 14, `0`, 2, [230, 230, 230]); c.text(lx + 250, ly + 14, `${maxH.toFixed(1)} M`, 2, [230, 230, 230]);
    c.text(lx + 330, ly - 6, 'WHITE: MEASURED OUTLINE', 2, [255, 255, 255]);
    c.text(lx + 330, ly + 14, footprintUV.length ? 'CYAN: MAP FOOTPRINT' : 'EDGE LENGTHS IN M', 2, footprintUV.length ? [80, 220, 255] : [255, 255, 255]);
    // views
    for (let k = 0; k < Math.min(4, scan.cameras.length); k++) {
        const sh = readU8(path.join(scanDir, `v${k}.shade.u8`));
        const x0 = panel + 10 + (k % 2) * (vw + 10), y0 = 60 + Math.floor(k / 2) * (vh + 34);
        c.text(x0, y0 - 18, `VIEW ${k + 1}: ${VIEW_NAMES[k]} (15 DEG OFF)`, 2, [255, 236, 160]);
        c.blit(x0, y0, vw, vh, (x, y) => { const t = sh[y * vw + x]; return t ? [t, t, t] : [80, 84, 92]; });
    }
    return c.png();
}

/** Scan (red) against program (blue), overlap grey, per view; and the height difference (program minus scan). */
export function fitOverlay(scanDir: string, fitDir: string, scan: ScanDoc, tags: string[]): Buffer {
    const g = scan.grid;
    const vw = scan.cameras[0].W, vh = scan.cameras[0].H;
    const sc = 0.5, tw = Math.round(vw * sc), th = Math.round(vh * sc);
    const hs = Math.min(th / (g.nv), tw / (g.nu));
    const W = 10 + 5 * (tw + 10), H = 30 + tags.length * (th + 30);
    const c = new Canvas(W, H, 24);
    const scanH = readF32(path.join(scanDir, 'height.f32'));
    tags.forEach((tag, r) => {
        const y0 = 30 + r * (th + 30);
        c.text(10, y0 - 16, `${tag.toUpperCase()}: RED SCAN ONLY, BLUE PROGRAM ONLY, GREY BOTH; LAST: HEIGHT PROGRAM MINUS SCAN (RED HIGHER, BLUE LOWER, 4 M FULL)`, 1, [255, 236, 160]);
        for (let k = 0; k < 4; k++) {
            const sd = readF32(path.join(scanDir, `v${k}.depth.f32`)), pd = readF32(path.join(fitDir, `prog_${tag}_v${k}.depth.f32`));
            const ps = readU8(path.join(fitDir, `prog_${tag}_v${k}.shade.u8`)), ss = readU8(path.join(scanDir, `v${k}.shade.u8`));
            c.blit(10 + k * (tw + 10), y0, tw, th, (x, y) => {
                const i = Math.min(vh - 1, Math.floor(y / sc)) * vw + Math.min(vw - 1, Math.floor(x / sc));
                const a = Number.isFinite(sd[i]), b = Number.isFinite(pd[i]);
                if (a && b) return [ps[i], ps[i], ps[i]];
                if (a) return [Math.max(120, ss[i]), 40, 40];
                if (b) return [40, 70, Math.max(150, ps[i])];
                return [60, 62, 68];
            });
        }
        const ph = readF32(path.join(fitDir, `prog_${tag}_h.f32`));
        c.blit(10 + 4 * (tw + 10), y0, Math.round(g.nu * hs), Math.round(g.nv * hs), (x, y) => {
            const k = Math.min(g.nv - 1, Math.floor(y / hs)) * g.nu + Math.min(g.nu - 1, Math.floor(x / hs));
            const a = Number.isFinite(ph[k]) ? Math.max(0, ph[k]) : 0, b = Number.isFinite(scanH[k]) ? Math.max(0, scanH[k]) : 0;
            if (a < 0.5 && b < 0.5) return [20, 20, 24];
            const d = Math.max(-1, Math.min(1, (a - b) / 4));
            return d >= 0 ? [Math.round(120 + 135 * d), Math.round(120 * (1 - d)), Math.round(120 * (1 - d))] : [Math.round(120 * (1 + d)), Math.round(120 * (1 + d)), Math.round(120 - 135 * d)];
        });
    });
    return c.png();
}

// ------------------------------------------------------------------------------------------------
// trees
// ------------------------------------------------------------------------------------------------

function inPoly(x: number, z: number, r: Vec2[]): boolean { return inLoops(x, z, [r]); }

/** The strip's crowns as measurements, each crown's base read from the removed triangles under it. */
export function measureTrees(crownsJson: string | undefined, removedTreesGlb: string | undefined, near: (x: number, z: number) => boolean, insideFootprint: (x: number, z: number) => boolean): { report: TreeReport; crownLines: string[]; maskPoints: Array<{ x: number; z: number; inside: boolean }> } {
    const report: TreeReport = { crowns: [], stripRemovedNear: { triangles: 0, areaM2: 0 }, stripRemovedInsideFootprint: { triangles: 0, areaM2: 0 }, isolate: {} };
    const crownLines: string[] = [];
    const maskPoints: Array<{ x: number; z: number; inside: boolean }> = [];
    if (!crownsJson || !fs.existsSync(crownsJson)) return { report, crownLines, maskPoints };
    const doc = JSON.parse(fs.readFileSync(crownsJson, 'utf8'));
    const crowns: Json[] = (doc.crowns ?? []).filter((c: Json) => Array.isArray(c.footprint) && c.footprint.length >= 3);
    const removed = removedTreesGlb && fs.existsSync(removedTreesGlb) ? readTileTriangles(fs.readFileSync(removedTreesGlb)) : undefined;
    const ys: number[][] = crowns.map(() => []);
    if (removed) {
        const P = removed.positions;
        for (let t = 0; t < removed.texture.length; t++) {
            const x = (P[t * 9] + P[t * 9 + 3] + P[t * 9 + 6]) / 3, y = (P[t * 9 + 1] + P[t * 9 + 4] + P[t * 9 + 7]) / 3, z = (P[t * 9 + 2] + P[t * 9 + 5] + P[t * 9 + 8]) / 3;
            const ux = P[t * 9 + 3] - P[t * 9], uy = P[t * 9 + 4] - P[t * 9 + 1], uz = P[t * 9 + 5] - P[t * 9 + 2];
            const vx = P[t * 9 + 6] - P[t * 9], vy = P[t * 9 + 7] - P[t * 9 + 1], vz = P[t * 9 + 8] - P[t * 9 + 2];
            const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
            crowns.forEach((c, k) => { if (inPoly(x, z, c.footprint)) ys[k].push(y); });
            if (near(x, z)) {
                report.stripRemovedNear.triangles++; report.stripRemovedNear.areaM2 += area;
                const inside = insideFootprint(x, z);
                if (inside) { report.stripRemovedInsideFootprint.triangles++; report.stripRemovedInsideFootprint.areaM2 += area; }
                if (t % 3 === 0) maskPoints.push({ x, z, inside });
            }
        }
    }
    crowns.forEach((c, k) => {
        const support = Number(c.supportY ?? c.terrainY ?? 0);
        const heightM = Number(c.apexAboveSupport ?? (c.apex?.[1] ?? support) - support);
        const radii: number[] = (c.sectorRadii ?? []).map(Number).filter(Number.isFinite);
        const width = radii.length ? 2 * radii.reduce((a, b) => a + b, 0) / radii.length : 2 * Math.sqrt(Math.abs(ringArea(c.footprint)) / Math.PI);
        const y = ys[k].sort((a, b) => a - b);
        const base = y.length >= 8 ? y[Math.floor(0.05 * y.length)] - support : NaN;
        const crownBaseM = Number.isFinite(base) && base > 0.3 && base < heightM ? base : 0.35 * heightM;
        const stem: Vec2 = Array.isArray(c.stem) ? [Number(c.stem[0]), Number(c.stem[1])] : [c.apex[0], c.apex[2]];
        const nearB = c.footprint.some((p: Vec2) => near(p[0], p[1]));
        report.crowns.push({ id: c.id, status: String(c.status), stem, supportY: support, heightM, crownWidthM: width, crownBaseM, crownBaseSource: Number.isFinite(base) && base > 0.3 && base < heightM ? 'removed-triangles' : 'estimated', sectorRadiiM: radii, nearBuilding: nearB });
        if (nearB) crownLines.push(`crown ${c.id} ${support + crownBaseM} ${support + heightM} ${c.footprint.length} ${c.footprint.map((p: Vec2) => `${p[0]} ${p[1]}`).join(' ')}`);
    });
    report.stripRemovedNear.areaM2 = Math.round(report.stripRemovedNear.areaM2 * 10) / 10;
    report.stripRemovedInsideFootprint.areaM2 = Math.round(report.stripRemovedInsideFootprint.areaM2 * 10) / 10;
    return { report, crownLines, maskPoints };
}

// ------------------------------------------------------------------------------------------------
// the stage
// ------------------------------------------------------------------------------------------------

/** Loops (tile frame) grouped into parts: each outer loop with the loops directly inside it as holes. */
function groupLoops(loops: Vec2[][]): Vec2[][][] {
    const sorted = [...loops].filter(l => l.length >= 3).sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
    const groups: Vec2[][][] = [];
    for (const l of sorted) {
        const host = groups.find(g => inLoops(l[0][0], l[0][1], g));
        if (host && host.length >= 1 && inLoops(l[0][0], l[0][1], [host[0]])) host.push(l);
        else groups.push([l]);
    }
    return groups;
}

function textOf(r: { response: { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> } }): string {
    return (r.response.candidates?.[0]?.content?.parts ?? []).filter(p => !p.thought && p.text).map(p => p.text).join('');
}

const PROGRAM_PROMPT = (place: string, scan: ScanDoc, measured: UV[], extent: { u: number[]; v: number[]; maxH: number }) => `You are reading the shape of one real structure, ${place}, from a contact sheet of its 3D scan with the trees removed (left: the scan's top seen from above, coloured by height, in a metric frame; right: four oblique clay views of the same scan). The scan is reliable for overall massing but melted in detail; read its intended form.

Write a shape program: a short list of solids whose union is the structure, each one continuous geometric operator, in the frame of the sheet (u metres along +U, v metres along +V as drawn, heights h in metres above the street):
- prism: a plan outline (a polygon of [u, v] points, an axis-aligned rect, or the measured outline inset by a distance) extruded from baseM to topM, with an optional roof rising roofRiseM above topM along a ridge at roofRidgeAngleDeg (from +U toward +V); roofHipShare 0 gives vertical gable ends, 1 slopes the ends over the whole half length. Stack prisms for setbacks; a prism with baseM above 0 floats on what is below it (a span over an opening is a prism with a raised base between two others).
- revolve: a radial profile [[height above baseM, radius], ...] about a vertical axis at (centerU, centerV), with sides (4 square, 8 octagonal, 32+ round), harmonic lobes and twist: spires, drums, domes, columns, finials.
- sweep: a closed planar profile [[x across, y up, optional bulge]] swept along a path of [u, v, h] points: arches (a profile swept along an arc), curved walls, rails, bands that follow a curve. Bulge = tan(arc angle / 4) makes the edge to the next point an arc.
- relief: a band of a prism's walls standing out by outM between fromM and toM (cornices, belt courses, a plinth).
- repeat on any element: count copies, each moved by (stepU, stepV, stepH): rows of columns, bays, pinnacles.

Measured numbers you can rely on (from the scan): the plan spans u ${extent.u[0].toFixed(1)}..${extent.u[1].toFixed(1)} m and v ${extent.v[0].toFixed(1)}..${extent.v[1].toFixed(1)} m; the top reaches ${extent.maxH.toFixed(1)} m; flat levels found at ${scan.levels.map(l => `${l.h.toFixed(1)} m (${Math.round(l.areaM2)} m2)`).join(', ') || 'none'}. The measured outline (white on the sheet) is [${measured.map(p => `[${p[0].toFixed(1)}, ${p[1].toFixed(1)}]`).join(', ')}].

Rules: use the fewest elements that capture the silhouette, setbacks, roof form, towers or spires, openings through the structure, and the larger repeated or projecting features you can see; leave out details under about 0.5 m. Every number is in metres in this frame. Openings that pass through the structure are made by leaving them empty between solids, not by subtracting. The numbers will be fitted to the scan afterwards, so get the structure right and the numbers close.`;

const CORRECTION_PROMPT = (program: ShapeProgram, loss: Json) => `Here is your shape program after its numbers were fitted to the scan, and how it still differs from the scan (the image: per oblique view, red = the scan only, blue = the program only, grey = both; the last panel is the height difference seen from above, red = the program higher, blue = lower). Mean silhouette disagreement ${(loss.silhouette * 100).toFixed(0)}% per view; mean height error ${(loss.height * 100).toFixed(0)}% of the building's height.

Program: ${JSON.stringify(program)}

Answer the corrected program in full (same frame, same rules): fix missing or extra masses, wrong roof forms, missing towers or openings. Keep what already agrees.`;

export async function runShapeStage(input: ShapeStageInput): Promise<ShapeStageResult> {
    const timingsMs: Record<string, number> = {};
    const notes: string[] = [];
    const files: Record<string, string> = {};
    fs.mkdirSync(input.outDir, { recursive: true });
    let t = Date.now();
    // ---- 1. trees out first
    const fpLoops = input.footprintLoops.filter(l => l.length >= 3);
    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    const isoTris = readTileTriangles(fs.readFileSync(input.isolateGlb));
    for (let i = 0; i < isoTris.positions.length; i += 3) { bx0 = Math.min(bx0, isoTris.positions[i]); bx1 = Math.max(bx1, isoTris.positions[i]); bz0 = Math.min(bz0, isoTris.positions[i + 2]); bz1 = Math.max(bz1, isoTris.positions[i + 2]); }
    const near = (x: number, z: number) => x >= bx0 - 3 && x <= bx1 + 3 && z >= bz0 - 3 && z <= bz1 + 3;
    const insideFp = (x: number, z: number) => fpLoops.length > 0 && inLoops(x, z, fpLoops);
    const trees = measureTrees(input.crownsJson, input.removedTreesGlb, near, insideFp);
    timingsMs.treeMeasure = Date.now() - t;
    // ---- 2. the native scan analysis (tree split, frame, height grid, tiers, views)
    t = Date.now();
    await ensureShapeBinary();
    timingsMs.nativeBinaryCheck = Date.now() - t;
    t = Date.now();
    const scanDir = path.join(input.outDir, 'scan');
    const spec = ['mode scan', `out ${scanDir}`, `isolate ${input.isolateGlb}`, `ground ${input.groundY}`, ...fpLoops.map(l => `footprint ${l.length} ${l.map(p => `${p[0]} ${p[1]}`).join(' ')}`), ...trees.crownLines].join('\n') + '\n';
    const scanRun = await runShapeTool(spec, scanDir, { ...(input.signal ? { signal: input.signal } : {}) });
    const scan = JSON.parse(fs.readFileSync(path.join(scanDir, 'scan.json'), 'utf8')) as ScanDoc;
    timingsMs.scanNative = scanRun.ms;
    timingsMs.treeSeparation = timingsMs.treeMeasure + (scan.timingsMs.classify ?? 0);
    timingsMs.heightMap = (scan.timingsMs.tiers ?? 0) - (scan.timingsMs.classify ?? 0);
    trees.report.isolate = scan.classes;
    fs.writeFileSync(path.join(input.outDir, 'trees.json'), JSON.stringify(trees.report, null, 1));
    files.trees = path.join(input.outDir, 'trees.json');
    // the tree-removal mask (top-down): building height grey, removed tree triangles green (inside the footprint: red), crowns outlined
    t = Date.now();
    {
        const g = scan.grid, fr = scan.frame;
        const toUV = (x: number, z: number): UV => { const c = Math.cos(fr.theta), s = Math.sin(fr.theta), dx = x - fr.ox, dz = z - fr.oz; return [c * dx + s * dz, -s * dx + c * dz]; };
        const S = Math.max(1, Math.floor(900 / Math.max(g.nu, g.nv)));
        const cv = new Canvas(g.nu * S, g.nv * S + 40, 20);
        const hh = readF32(path.join(scanDir, 'height.f32'));
        cv.blit(0, 40, g.nu * S, g.nv * S, (x, y) => { const v = hh[Math.floor(y / S) * g.nu + Math.floor(x / S)]; return Number.isFinite(v) && v > 0.5 ? [90 + Math.min(120, v * 4), 90 + Math.min(120, v * 4), 90 + Math.min(120, v * 4)] : [20, 20, 24]; });
        const P = (x: number, z: number) => { const [u, v] = toUV(x, z); return [(u - g.u0) / g.cell * S, 40 + (v - g.v0) / g.cell * S]; };
        for (const m of trees.maskPoints) { const [px, py] = P(m.x, m.z); cv.set(px, py, m.inside ? [255, 40, 40] : [40, 220, 60]); cv.set(px + 1, py, m.inside ? [255, 40, 40] : [40, 220, 60]); }
        const doc = input.crownsJson && fs.existsSync(input.crownsJson) ? JSON.parse(fs.readFileSync(input.crownsJson, 'utf8')) : { crowns: [] };
        for (const c of doc.crowns ?? []) {
            if (!Array.isArray(c.footprint)) continue;
            for (let k = 0; k < c.footprint.length; k++) { const [a0, a1] = P(c.footprint[k][0], c.footprint[k][1]), [b0, b1] = P(c.footprint[(k + 1) % c.footprint.length][0], c.footprint[(k + 1) % c.footprint.length][1]); cv.line(a0, a1, b0, b1, [255, 220, 60]); }
        }
        for (const l of fpLoops) for (let k = 0; k < l.length; k++) { const [a0, a1] = P(l[k][0], l[k][1]), [b0, b1] = P(l[(k + 1) % l.length][0], l[(k + 1) % l.length][1]); cv.line(a0, a1, b0, b1, [80, 220, 255]); }
        cv.text(6, 6, `TREES OUT: STRIP REMOVED ${trees.report.stripRemovedNear.triangles} TRIS ${trees.report.stripRemovedNear.areaM2} M2 NEAR (GREEN), ${trees.report.stripRemovedInsideFootprint.triangles} INSIDE FOOTPRINT (RED)`, 1, [255, 255, 255]);
        cv.text(6, 20, `ISOLATE: ${scan.classes.building.triangles} BUILDING, ${scan.classes.ground.triangles} GROUND, ${scan.classes.tree.triangles} TREE TRIS; YELLOW CROWNS, CYAN FOOTPRINT`, 1, [255, 255, 255]);
        files.treeMask = path.join(input.outDir, 'tree_mask.png');
        fs.writeFileSync(files.treeMask, cv.png());
    }
    timingsMs.treeMaskImage = Date.now() - t;
    const checkInputs = { groundY: input.groundY, scanTop: input.scanTop, cells: input.cells };
    const scanRecord = { frame: scan.frame, grid: scan.grid, levels: scan.levels, tiers: scan.tiers.map(x => ({ baseY: x.baseY, topY: x.topY, areaM2: x.areaM2, loops: x.loops.length })), footprintAgreement: scan.footprintAgreement, outlineSource: scan.outlineSource, notes: scan.notes, timingsMs: scan.timingsMs };
    notes.push(`outline: ${scan.outlineSource}${scan.footprintAgreement !== null && scan.footprintAgreement >= 0 ? ` (the height map covers ${Math.round(scan.footprintAgreement * 100)}% of the vector footprint)` : ''}`);
    // ---- 2b. the height-map tiers
    const tierParts: MassingPart[] = [];
    scan.tiers.forEach((tr, i) => groupLoops(tr.loops as Vec2[][]).forEach((loops, j) => {
        tierParts.push({ id: `tier${i}_${j}`, baseY: tr.baseY, topY: tr.topY, loops, planes: [], heightSource: 'scan-tier', heights: { scanY: tr.topY }, provenance: SHAPE_TIERS_TOKEN });
    }));
    if (input.mode === 'tiers') {
        const check = { ...checkMassing(tierParts, [], checkInputs), ok: tierParts.length > 0 };
        return { massing: { parts: tierParts, meshes: [], check, solar: { segments: 0, inside: 0, pitchedKept: 0, pitchedRejected: 0, flatUsed: 0 }, notes: [`shape program trial: ${tierParts.length} height-map tier parts`, ...notes] }, timingsMs, notes, trees: trees.report, scan: scanRecord, files };
    }
    // ---- 3. the shape program
    if (!input.vision) throw new Error('the shape program needs a vision model (none is configured)');
    const fr = scan.frame;
    const toUV = (x: number, z: number): UV => { const c = Math.cos(fr.theta), s = Math.sin(fr.theta), dx = x - fr.ox, dz = z - fr.oz; return [c * dx + s * dz, -s * dx + c * dz]; };
    const measured: UV[] = (scan.outlineUV.slice().sort((a, b) => Math.abs(ringArea(b as Vec2[])) - Math.abs(ringArea(a as Vec2[])))[0] ?? []) as UV[];
    const fpUV = fpLoops.map(l => l.map(p => toUV(p[0], p[1])));
    t = Date.now();
    const sheet = contactSheet(scanDir, scan, measured, fpUV);
    files.contactSheet = path.join(input.outDir, 'contact_sheet.png');
    fs.writeFileSync(files.contactSheet, sheet);
    timingsMs.contactSheet = Date.now() - t;
    const extent = { u: [scan.box.lo[0], scan.box.hi[0]], v: [scan.box.lo[2], scan.box.hi[2]], maxH: scan.box.hi[1] };
    const bounds = { minU: extent.u[0], maxU: extent.u[1], minV: extent.v[0], maxV: extent.v[1], maxH: extent.maxH };
    const ask = async (parts: unknown[], stage: string) => {
        const t0 = Date.now();
        // a call that has not answered in SHAPE_CALL_TIMEOUT_MS is given up (a stalled stream held a build past its stage limit)
        let timer: NodeJS.Timeout | undefined;
        const r = await Promise.race([
            input.vision!.generate({ contents: [{ role: 'user', parts: parts as Json }], config: { responseMimeType: 'application/json', responseJsonSchema: SHAPE_PROGRAM_JSON_SCHEMA, temperature: 0.2, maxOutputTokens: SHAPE_MAX_OUTPUT_TOKENS } }, { stage, thinkingBudget: SHAPE_THINKING_BUDGET }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`the ${stage} call did not answer within ${SHAPE_CALL_TIMEOUT_MS / 1000} s`)), SHAPE_CALL_TIMEOUT_MS); })
        ]).finally(() => clearTimeout(timer));
        const text = textOf(r);
        let raw: unknown;
        try { raw = JSON.parse(text); } catch { throw new Error(`the ${stage} answer is not JSON: ${text.slice(0, 200)}`); }
        r.remember?.();
        return { raw, model: r.model, ms: Date.now() - t0, cached: !!r.cached };
    };
    t = Date.now();
    const first = await ask([{ text: PROGRAM_PROMPT(input.place, scan, measured, extent) }, { inlineData: { mimeType: 'image/png', data: sheet.toString('base64') } }], 'shape-program');
    timingsMs.gemini = first.ms;
    fs.writeFileSync(path.join(input.outDir, 'program_raw.json'), JSON.stringify(first.raw, null, 1));
    const v1 = validateProgram(first.raw, bounds);
    if (!v1.program) throw new Error(`the shape program could not be used: ${v1.problems.join('; ')}`);
    // ---- 4. fit
    const targets: ScanTargets = { dir: scanDir, frame: scan.frame, grid: scan.grid, cameras: scan.cameras, buildingH: Math.max(3, extent.maxH) };
    const fitOnce = async (prog: ShapeProgram, tag: string) => {
        const dir = path.join(input.outDir, tag);
        const run = await runShapeTool(programSpecText(prog, { outDir: dir, measuredOutline: measured, scan: targets, fit: { passes: 5, maxEvals: 3000 } }), dir, { ...(input.signal ? { signal: input.signal } : {}) });
        const fit = JSON.parse(fs.readFileSync(path.join(dir, 'fit.json'), 'utf8'));
        const free = prog.elements.map(e => elementHandles(e, true).map(h => h.step > 0));
        const applied = applyHandles(prog, fit.handles, free, measured);
        return { dir, fit, ms: run.ms, ...applied };
    };
    t = Date.now();
    let best = await fitOnce(v1.program, 'fit');
    timingsMs.fit = Date.now() - t;
    files.fitOverlay = path.join(input.outDir, 'fit_overlay.png');
    fs.writeFileSync(files.fitOverlay, fitOverlay(scanDir, best.dir, scan, ['before', 'after']));
    let correction: Record<string, unknown> | undefined;
    let validated = v1.program, problems = v1.problems, rawUsed = first.raw;
    if (best.fit.after.silhouette > CORRECTION_SILHOUETTE || best.fit.after.height > CORRECTION_HEIGHT) {
        t = Date.now();
        try {
            const diff = fitOverlay(scanDir, best.dir, scan, ['after']);
            const second = await ask([{ text: PROGRAM_PROMPT(input.place, scan, measured, extent) }, { inlineData: { mimeType: 'image/png', data: sheet.toString('base64') } }, { text: CORRECTION_PROMPT(best.program, best.fit.after) }, { inlineData: { mimeType: 'image/png', data: diff.toString('base64') } }], 'shape-program-correction');
            timingsMs.geminiCorrection = second.ms;
            fs.writeFileSync(path.join(input.outDir, 'program_correction_raw.json'), JSON.stringify(second.raw, null, 1));
            const v2 = validateProgram(second.raw, bounds);
            if (v2.program) {
                const t1 = Date.now();
                const again = await fitOnce(v2.program, 'fit_correction');
                timingsMs.fitCorrection = Date.now() - t1;
                const kept = again.fit.after.total < best.fit.after.total;
                correction = { asked: true, lossBefore: best.fit.after, lossAfter: again.fit.after, kept, problems: v2.problems };
                if (kept) { best = again; validated = v2.program; problems = v2.problems; rawUsed = second.raw; fs.writeFileSync(path.join(input.outDir, 'fit_overlay_correction.png'), fitOverlay(scanDir, again.dir, scan, ['before', 'after'])); files.fitOverlayCorrection = path.join(input.outDir, 'fit_overlay_correction.png'); }
            } else correction = { asked: true, kept: false, problems: v2.problems };
        } catch (err) {
            correction = { asked: true, kept: false, error: err instanceof Error ? err.message : String(err) };
        }
        timingsMs.correction = Date.now() - t;
    } else correction = { asked: false, reason: `the fit left silhouette ${best.fit.after.silhouette.toFixed(3)} and height ${best.fit.after.height.toFixed(3)} (limits ${CORRECTION_SILHOUETTE}, ${CORRECTION_HEIGHT})` };
    fs.writeFileSync(path.join(input.outDir, 'program.json'), JSON.stringify({ model: first.model, summary: validated.summary, validated, problems, fitted: best.program, parameters: best.parameters, fit: best.fit, correction }, null, 1));
    files.program = path.join(input.outDir, 'program.json');
    // ---- 5. the massing
    const geom = JSON.parse(fs.readFileSync(path.join(best.dir, 'geometry.json'), 'utf8'));
    // a part the native kernel cannot close (a degenerate plan: under 0.05 m^2, or a non-finite number) is left out and said
    const usable = (p: Json) => JSON.stringify(p).indexOf('null') < 0 && p.loops.every((l: Vec2[]) => Math.abs(ringArea(l)) >= 0.05);
    const dropped = (geom.parts as Json[]).filter(p => !usable(p)).map((p: Json) => p.id);
    if (dropped.length) notes.push(`degenerate program parts left out: ${dropped.join(', ')}`);
    const parts: MassingPart[] = (geom.parts as Json[]).filter(usable).map((p: Json) => ({ id: p.id, baseY: p.baseY, topY: p.topY, loops: p.loops, planes: (p.planes as Json[]).map((q: Json, k: number) => ({ a: q.a, b: q.b, c: q.c, tag: `program:${p.id}:${k}` })), heightSource: 'shape-program', heights: {}, provenance: SHAPE_PROGRAM_TOKEN }));
    const meshes: MassingMesh[] = (geom.meshes as Json[]).filter((m: Json) => m.indices.length >= 12).map((m: Json) => ({ id: `program_${m.id}`, vertices: m.vertices, indices: m.indices, provenance: SHAPE_PROGRAM_TOKEN }));
    const check = { ...checkMassing(parts, meshes, checkInputs), ok: parts.length + meshes.length > 0 };
    const measuredCount = best.parameters.filter(p => p.provenance === 'measured').length;
    notes.push(`shape program (${first.model}${first.cached ? ', a recorded answer' : ''}): ${validated.elements.length} elements (${problems.length} problems), ${parts.length} prism parts and ${meshes.length} solids; ${measuredCount} of ${best.parameters.length} parameters fitted to the scan (loss ${best.fit.before.total.toFixed(3)} -> ${best.fit.after.total.toFixed(3)}, ${best.fit.evals} evaluations)`);
    return {
        massing: { parts, meshes, check, solar: { segments: 0, inside: 0, pitchedKept: 0, pitchedRejected: 0, flatUsed: 0 }, notes: [...notes] },
        timingsMs, notes, trees: trees.report, scan: scanRecord, files,
        program: { model: first.model, raw: rawUsed, validated, problems, fitted: best.program, parameters: best.parameters, fit: best.fit, ...(correction ? { correction } : {}) }
    };
}
