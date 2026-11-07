/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The building's bay grammar read per wall, not per facade (pipeline K, after the window fit). A facade of relief_orthos is
 * one plane tile_refine fitted; one physical wall is often several of them (the ESB's tower centre: four overlapping planes
 * within half a metre), each seeing part of it. Here:
 * 1. walls: facades facing the same way (normals within wallCos), their planes within wallBandM, and overlapping or
 *    touching (within joinGapM) along the wall and up it, are one wall, in one frame (u along the wall, y up);
 * 2. the wall's evidence: every facade's photo laid on the wall at cellM, each cell covered (the photo reached it) and a
 *    window (inside one of the window fit's windows on that facade);
 * 3. its columns: a column is a bay where windows hold at least voteMin of its covered cells; runs of bay columns joined
 *    across mullions (gaps under mullionMaxM) and split again where a light stretch as wide as the wall's own piers
 *    (pierShare of their median width) crosses the run, leaving both pieces at least pierShare of its median bay wide,
 *    kept from minBayM wide; columns the photo barely reached (under
 *    minCoverage) are unknown, and an unknown span continues the wall's own bay rhythm (median pitch and width) where it
 *    has at least two bays (generated);
 * 4. each bay's height, from the photos themselves (one facade's window fit may miss what another's photo shows): a row of
 *    the bay is bay where its luminance is under the midpoint between the wall's piers and bays (each read from the
 *    columns above, so a shaded wall is judged by its own light), wall where over it (a band); runs joined across wall
 *    rows up to maxGapM and across rows the photo never reached, kept from minRunM tall, but not a run crossed by
 *    punchedBands or more wall bands holding punchedShare of its height (read by light, or by the window fit: covered rows from
 *    bandM tall between its windows holding none, since light alone misses a shaded wall; a stack of punched windows in stone, one per storey: no bay, its windows left to the window fit); a continued bay takes the runs
 *    of the nearest bay read from the photo;
 * 5. tiers: walls whose tops and bottoms lie within tierM of each other are one tier (a setback level), and the tier has one
 *    grammar, fitted jointly from every wall's read bays (`fitTierGrammar`): bay width, bay pitch (the median of the gaps
 *    between neighbouring read bays, a gap a whole number of pitches counting as that many), and the window rows (the
 *    sill and head runs the read bays share). Each wall lays the grammar along its length (`applyTierGrammar`), its phase
 *    from its own read bays, else centred on the wall (a facade is laid out about its middle), and gains every grammar
 *    bay it lacks (generated). A grammar bay over columns the photo shows as wall (vetoShare of them, state 0) is not
 *    drawn, and a wall the photo covers from silentCoverage with no bays read gets none: the photo has the veto. With under minTierBays read bays the tier has no grammar and keeps step 3's.
 * The bays are written per wall and, in each facade's own frame, per facade (wall_grammar.json beside the orthos), each
 * labelled by where it came from: photo-inferred (read), generated (continued or borrowed).
 *
 * Steps 2 to 4 (each wall's evidence and bays) run natively by default, one wall a task (scratchbox_wall_grammar.hpp
 * through remesh-polish-native.ts), giving these functions' results bit for bit; SCRATCHBOX_K_NATIVE without
 * `wall-grammar` runs them here. The walls and the tiers' grammars are worked out here either way.
 */

import * as fs from 'fs';
import * as path from 'path';
import { kNative } from './pipeline-k/native/native-switch';
import { OCCLUSION_PARAMS, readOccluded, unreadMask } from './pipeline-k/occlusion';
import { nativePolishThreads, runNativeWallGrammar } from './remesh-polish-native';
import type { WindowFitFile, WindowRect } from './window-fit';
import { windowStrips } from './window-strips';

export const WALL_GRAMMAR_VERSION = 'wall-grammar/4';

export const WALL_GRAMMAR_PARAMS = {
    /** One wall: normals within this cosine, planes within this (m), extents overlapping or within joinGapM (m). */
    wallCos: 0.98, wallBandM: 0.6, joinGapM: 1.0,
    /** The wall's evidence grid (m). */
    cellM: 0.1,
    /** A column is a bay where windows hold at least this share of its covered cells; unknown under minCoverage covered. */
    voteMin: 0.15, minCoverage: 0.1,
    /** Bay columns joined across gaps under this (m: a mullion; a pier is wider), and kept from this wide (m); a joined run is split again at a light stretch at least pierShare of the wall's median pier wide. */
    mullionMaxM: 0.7, minBayM: 0.8, pierShare: 0.6,
    /** A bay's rows joined across wall rows up to maxGapM (m), kept from minRunM tall (m). */
    maxGapM: 2.5, minRunM: 5.0,
    /** A row run crossed by at least punchedBands wall bands (each from bandM tall, m) holding punchedShare of its height is punched windows, not a bay. */
    punchedBands: 3, punchedShare: 0.2, bandM: 0.5,
    /** Tiers: walls whose tops and bottoms lie within this (m). A tier's grammar needs minTierBays read bays; a bay's pitch gap within pitchTol of the tier's pitch counts toward it, a grammar bay is vetoed where vetoShare of its columns the photo shows as wall, and a wall covered from silentCoverage with no bays read gets none. */
    tierM: 3.0, minTierBays: 3, pitchTol: 0.2, vetoShare: 0.2, silentCoverage: 0.5
};
export type WallGrammarParams = typeof WALL_GRAMMAR_PARAMS;

/** The native wall grammar's parameters (scratchbox_wall_grammar.hpp Params): P's reading fields in order, and the occlusion mask's threshold code. */
export function wallGrammarParamVector(P: WallGrammarParams = WALL_GRAMMAR_PARAMS): number[] {
    return [P.cellM, P.voteMin, P.minCoverage, P.mullionMaxM, P.minBayM, P.pierShare, P.maxGapM, P.minRunM, P.punchedBands, P.punchedShare, P.bandM, Math.round(OCCLUSION_PARAMS.minBlocked * 255)];
}

/** A facade's frame, as relief_orthos/facades.json gives it. */
export interface GrammarFacade {
    facadeId: number; image: string; centroid: number[]; normal: number[]; axisS: number[]; axisT: number[];
    sMin: number; sMax: number; tMin: number; tMax: number; pixel: number; width: number; height: number; orthoSMin: number; orthoTMax: number;
    uncoveredMask?: string;
    occludedMask?: string;
}

export type BayFrom = 'photo-inferred' | 'generated';
/** A bay on a wall: u0..u1 along it, y0..y1 up it (m, world height). */
export interface WallBay { u0: number; u1: number; y0: number; y1: number; from: BayFrom }
export interface Wall {
    wallId: number; facades: number[]; normal: number[]; axisU: number[]; offset: number;
    u0: number; u1: number; y0: number; y1: number; coverage: number; tier: number; bays: WallBay[];
}
export interface WallGrammarFile {
    /** One window grammar per tier (see the file comment, 5). */
    tiers?: TierGrammar[];
    version: string; params: WallGrammarParams; walls: Wall[];
    /** Per facade id, its bays in its own frame: [s0, t0, s1, t1, from (0 photo-inferred, 1 generated)]. */
    facades: Record<string, Array<[number, number, number, number, number]>>;
    /** Per facade id the facade reader drew: the strips its single windows made for the column vote (voteRects). */
    readerStrips?: Record<string, number>;
}

/**
 * The window rects a facade's columns are voted on: the window fit's as they are (its strips run the column's height),
 * and where the facade reader drew the plane (single windows, one per opening, in place of the fit's strips) also the
 * strips those windows make in the plane's frame (window-strips.ts), so a column of windows a storey apart votes as a bay
 * the way a strip does. Without them the Seagram's shaft (18 panes a storey, 36 storeys) read no bay at all and was
 * built flat, 2026-11-07. Returns the rects and how many strips were added.
 */
export function voteRects(f: Pick<GrammarFacade, 'pixel' | 'orthoSMin' | 'orthoTMax'>, e: { rects: WindowRect[]; reader?: string }): { rects: WindowRect[]; strips: number } {
    if (!e.reader || !e.rects.length) return { rects: e.rects, strips: 0 };
    const plane = e.rects.map(([x0, y0, x1, y1]): [number, number, number, number] => [f.orthoSMin + x0 * f.pixel, f.orthoTMax - y1 * f.pixel, f.orthoSMin + x1 * f.pixel, f.orthoTMax - y0 * f.pixel]);
    const strips = windowStrips(plane).map(([s0, t0, s1, t1]): WindowRect => [Math.round((s0 - f.orthoSMin) / f.pixel), Math.round((f.orthoTMax - t1) / f.pixel), Math.round((s1 - f.orthoSMin) / f.pixel), Math.round((f.orthoTMax - t0) / f.pixel)]);
    return { rects: [...e.rects, ...strips], strips: strips.length };
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };

/** Walls: facades of one plane, overlapping or touching (see the file comment), by union-find. */
export function groupWalls(facades: GrammarFacade[], P: WallGrammarParams = WALL_GRAMMAR_PARAMS): number[][] {
    const n = facades.length, parent = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const ext = facades.map(f => {
        const ys = [f.centroid[1] + f.tMin * f.axisT[1], f.centroid[1] + f.tMax * f.axisT[1]];
        return { y0: Math.min(...ys), y1: Math.max(...ys) };
    });
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const a = facades[i], b = facades[j];
        if (dot(a.normal, b.normal) < P.wallCos) continue;
        if (Math.abs(dot(a.centroid, a.normal) - dot(b.centroid, a.normal)) > P.wallBandM) continue;
        // along the wall: each one's s range in a's frame
        const ua = [dot(a.centroid, a.axisS) + a.sMin, dot(a.centroid, a.axisS) + a.sMax];
        const sb = dot(b.axisS, a.axisS), cb = dot(b.centroid, a.axisS);
        const ub = [cb + sb * b.sMin, cb + sb * b.sMax].sort((x, y) => x - y);
        const gapU = Math.max(ub[0] - ua[1], ua[0] - ub[1]), gapY = Math.max(ext[j].y0 - ext[i].y1, ext[i].y0 - ext[j].y1);
        if (gapU <= P.joinGapM && gapY <= P.joinGapM) parent[find(i)] = find(j);
    }
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), i]); }
    return [...groups.values()];
}

/** A facade photo's unread texels: its uncovered mask (its file, else the ortho's exact grey 128 or transparent texels), and its occluded texels. */
function uncoveredOf(dir: string, f: GrammarFacade, rgba: Uint8Array | Buffer, decode: (b: Buffer) => { rgba: Uint8Array; width: number; height: number }): Uint8Array {
    const file = f.uncoveredMask ? path.join(dir, f.uncoveredMask) : undefined;
    const unc = file && fs.existsSync(file) ? (() => { const m = decode(fs.readFileSync(file)); return Uint8Array.from({ length: m.width * m.height }, (_, k) => (m.rgba[k * 4] >= 128 ? 1 : 0)); })()
        : Uint8Array.from({ length: rgba.length / 4 }, (_, k) => (rgba[k * 4 + 3] === 0 || (rgba[k * 4] === 128 && rgba[k * 4 + 1] === 128 && rgba[k * 4 + 2] === 128) ? 1 : 0));
    // what stood in front of the facade when it was photographed is not read: the wall's rhythm continues over it
    const occ = readOccluded(dir, f, f.width, f.height, decode);
    return occ && occ.length === unc.length ? unreadMask(unc, occ, unc.length) : unc;
}

/** One wall's evidence on its grid (see the file comment, 2). */
export interface WallEvidence { u0: number; y0: number; nu: number; ny: number; cellM: number; covered: Uint8Array; window: Uint8Array; /** Mean luminance (0-255) of the photos laid on each cell, NaN where none reached. */ lum: Float32Array }

/**
 * A wall's bays from its evidence (see the file comment, 3 and 4), in wall metres. Also the columns' state (1 bay, 0 wall,
 * -1 unknown), for the tier's reconciliation.
 */
export function readWallBays(e: WallEvidence, P: WallGrammarParams = WALL_GRAMMAR_PARAMS): { bays: WallBay[]; state: Int8Array } {
    const { nu, ny, cellM } = e;
    const state = new Int8Array(nu);
    for (let x = 0; x < nu; x++) {
        let cov = 0, win = 0;
        for (let y = 0; y < ny; y++) { const k = y * nu + x; if (e.covered[k]) { cov++; if (e.window[k]) win++; } }
        state[x] = cov < P.minCoverage * ny ? -1 : win >= P.voteMin * cov ? 1 : 0;
    }
    // the wall's piers and bays in its own light (each from the columns' states), the midpoint between them telling bay from wall
    // the median luminance of a column state's cells, by a 256-bin histogram (a wall holds millions of cells)
    const colLum = (want: number) => {
        const h = new Float64Array(256);
        let n = 0;
        for (let x = 0; x < nu; x++) if (state[x] === want) for (let y = 0; y < ny; y++) { const l = e.lum[y * nu + x]; if (Number.isFinite(l)) { h[Math.min(255, Math.max(0, Math.round(l)))]++; n++; } }
        if (!n) return NaN;
        let c = 0;
        for (let i = 0; i < 256; i++) { c += h[i]; if (c >= n / 2) return i; }
        return 255;
    };
    const pierLum = colLum(0), bayLum = colLum(1), mid = (pierLum + bayLum) / 2;
    // bay runs across mullions
    const runs: Array<[number, number]> = [];
    for (let x = 0; x < nu;) {
        if (state[x] !== 1) { x++; continue; }
        let end = x; while (end < nu && state[end] === 1) end++;
        const last = runs[runs.length - 1];
        if (last && (x - last[1]) * cellM < P.mullionMaxM && state.subarray(last[1], x).every(v => v === 0 || v === 1)) last[1] = end; else runs.push([x, end]);
        x = end;
    }
    // a run of bay columns crossed by a light stretch as wide as the wall's own piers (pierShare of their median width) is
    // two bays, not one: the window fit's columns joined across a pier it read as a mullion
    const colL = Float64Array.from({ length: nu }, (_, x) => { let sum = 0, n = 0; for (let y = 0; y < ny; y++) { const l = e.lum[y * nu + x]; if (Number.isFinite(l)) { sum += l; n++; } } return n ? sum / n : NaN; });
    const piers: number[] = [];
    for (let i = 1; i < runs.length; i++) if (state.subarray(runs[i - 1][1], runs[i][0]).every(v => v === 0)) piers.push(runs[i][0] - runs[i - 1][1]);
    const pierCells = piers.length ? Math.max(2, Math.round(P.pierShare * median(piers))) : Infinity;
    // ...and both pieces at least pierShare of the wall's median bay wide (a light patch inside one bay is no pier)
    const bayCells = median(runs.map(([a, b]) => b - a)) * P.pierShare;
    const split: Array<[number, number]> = [];
    for (const [a, b] of runs) {
        let start = a;
        for (let x = a; x < b;) {
            if (!(colL[x] > mid)) { x++; continue; }
            let end = x; while (end < b && colL[end] > mid) end++;
            if (end - x >= pierCells && x - start >= bayCells && b - end >= bayCells) { split.push([start, x]); start = end; }
            x = end;
        }
        if (b > start) split.push([start, b]);
    }
    const cols = split.filter(([a, b]) => (b - a) * cellM >= P.minBayM);
    // the window fit's wall bands in rows r0..r1 of columns a..b: runs of covered rows with no window, from bandM tall, between windows
    const fitBands = (a: number, b: number, r0: number, r1: number) => {
        let bands = 0, rows = 0, gap = 0, seen = false;
        const minRows = Math.max(1, Math.round(P.bandM / cellM));
        for (let y = r0; y < r1; y++) {
            let cov = 0, win = 0;
            for (let x = a; x < b; x++) { const k = y * nu + x; if (e.covered[k]) { cov++; if (e.window[k]) win++; } }
            if (!cov) continue;
            if (win >= P.voteMin * cov) { if (seen && gap >= minRows) { bands++; rows += gap; } seen = true; gap = 0; } else gap++;
        }
        return { bands, rows };
    };
    const rowRuns = (a: number, b: number): Array<[number, number]> => {
        const row = new Int8Array(ny); // 1 bay row, 0 wall row, -1 unknown
        for (let y = 0; y < ny; y++) {
            let sum = 0, n = 0;
            for (let x = a; x < b; x++) { const l = e.lum[y * nu + x]; if (Number.isFinite(l)) { sum += l; n++; } }
            row[y] = n < 0.3 * (b - a) || !Number.isFinite(mid) || !(pierLum > bayLum) ? -1 : sum / n < mid ? 1 : 0;
        }
        const out: Array<[number, number]> = [];
        let start = -1, lastBay = -1, gapWall = 0, wallIn = 0, bands = 0;
        for (let y = 0; y <= ny; y++) {
            const v = y < ny ? row[y] : 0;
            if (v === 1) { if (start < 0) { start = y; wallIn = 0; bands = 0; } if (gapWall) { wallIn += gapWall; bands++; } lastBay = y; gapWall = 0; continue; }
            if (start < 0) continue;
            if (v === 0) gapWall++;
            // a wall stretch longer than maxGapM, or the end: close the run at its last bay row
            if (y === ny || gapWall * cellM > P.maxGapM) {
                const len = lastBay + 1 - start;
                // a run crossed by a wall band storey after storey is a stack of punched windows in stone, not a bay: bands
                // read by light, or by the window fit (covered rows between its windows holding none; light alone misses a
                // shaded wall)
                const fitted = fitBands(a, b, start, lastBay + 1);
                const punched = Math.max(bands, fitted.bands) >= P.punchedBands && Math.max(wallIn, fitted.rows) >= P.punchedShare * len;
                if (len * cellM >= P.minRunM && !punched) out.push([start, lastBay + 1]);
                start = -1; gapWall = 0;
            }
        }
        return out;
    };
    const bays: WallBay[] = [];
    const read = cols.map(([a, b]) => ({ a, b, rows: rowRuns(a, b) }));
    for (const c of read) for (const [r0, r1] of c.rows) bays.push({ u0: e.u0 + c.a * cellM, u1: e.u0 + c.b * cellM, y0: e.y0 + r0 * cellM, y1: e.y0 + r1 * cellM, from: 'photo-inferred' });
    // unknown spans continue the wall's rhythm
    const withRows = read.filter(c => c.rows.length);
    if (withRows.length >= 2) {
        const pitch = median(withRows.slice(1).map((c, i) => c.a - withRows[i].a)), width = median(withRows.map(c => c.b - c.a));
        for (let x = 0; x < nu;) {
            if (state[x] !== -1) { x++; continue; }
            let end = x; while (end < nu && state[end] === -1) end++;
            // the rhythm's phase from the nearest bay read
            const near = withRows.reduce((m, c) => (Math.abs(c.a - x) < Math.abs(m.a - x) ? c : m));
            let a0 = near.a + Math.ceil((x - near.a) / pitch) * pitch;
            for (; a0 + width <= end; a0 += pitch) {
                if (a0 < x) continue;
                for (const [r0, r1] of near.rows) bays.push({ u0: e.u0 + a0 * cellM, u1: e.u0 + (a0 + width) * cellM, y0: e.y0 + r0 * cellM, y1: e.y0 + r1 * cellM, from: 'generated' });
            }
            x = end;
        }
    }
    return { bays, state };
}

/** A wall's evidence (see the file comment, 2): its facades' photos laid on its grid, each cell covered and a window. */
export function wallEvidence(orthosDir: string, fs0: GrammarFacade[], windowsOf: Map<number, WindowRect[]>, U: number[], u0: number, y0: number, u1: number, y1: number, decode: (b: Buffer) => { rgba: Uint8Array; width: number; height: number }, P: WallGrammarParams = WALL_GRAMMAR_PARAMS): WallEvidence {
    const nu = Math.max(1, Math.ceil((u1 - u0) / P.cellM)), ny = Math.max(1, Math.ceil((y1 - y0) / P.cellM));
    const covered = new Uint8Array(nu * ny), window = new Uint8Array(nu * ny), lumSum = new Float32Array(nu * ny), lumN = new Uint16Array(nu * ny);
    for (const f of fs0) {
        const img = decode(fs.readFileSync(path.join(orthosDir, f.image)));
        const unc = uncoveredOf(orthosDir, f, img.rgba, decode), wins = windowsOf.get(f.facadeId) ?? [];
        const inWin = new Uint8Array(img.width * img.height);
        for (const [xa, ya, xb, yb] of wins) for (let y = Math.max(0, ya); y < Math.min(img.height, yb); y++) inWin.fill(1, y * img.width + Math.max(0, xa), y * img.width + Math.min(img.width, xb));
        const step = Math.max(1, Math.round(P.cellM / f.pixel / 2));
        // u and y are affine in the photo's x and y: u = cu0 + x du_x + y du_y, height = cy0 + x dy_x + y dy_y
        const us = dot(f.axisS, U), ut = dot(f.axisT, U), uc = dot(f.centroid, U);
        for (let y = 0; y < img.height; y += step) for (let x = 0; x < img.width; x += step) {
            const k = y * img.width + x;
            if (unc[k] || !img.rgba[k * 4 + 3]) continue;
            const s = f.orthoSMin + (x + 0.5) * f.pixel, t = f.orthoTMax - (y + 0.5) * f.pixel;
            const cu = Math.floor((uc + s * us + t * ut - u0) / P.cellM), cy = Math.floor((f.centroid[1] + s * f.axisS[1] + t * f.axisT[1] - y0) / P.cellM);
            if (cu < 0 || cy < 0 || cu >= nu || cy >= ny) continue;
            covered[cy * nu + cu] = 1;
            if (inWin[k]) window[cy * nu + cu] = 1;
            lumSum[cy * nu + cu] += 0.2126 * img.rgba[k * 4] + 0.7152 * img.rgba[k * 4 + 1] + 0.0722 * img.rgba[k * 4 + 2]; lumN[cy * nu + cu]++;
        }
    }
    const lum = Float32Array.from(lumSum, (v, k) => (lumN[k] ? v / lumN[k] : NaN));
    return { u0, y0, nu, ny, cellM: P.cellM, covered, window, lum };
}

/** Reads every wall's bay grammar from the orthos and the window fit (see the file comment) and writes wall_grammar.json beside them. */
export function readWallGrammar(orthosDir: string, fit: WindowFitFile, decode: (b: Buffer) => { rgba: Uint8Array; width: number; height: number }, P: WallGrammarParams = WALL_GRAMMAR_PARAMS, opts: { /** The native reading's threads (every core when none). It changes how fast, not what, is read. */ threads?: number } = {}): { file: string; grammar: WallGrammarFile } {
    const facades = (JSON.parse(fs.readFileSync(path.join(orthosDir, 'facades.json'), 'utf8')).facades as GrammarFacade[]).filter(f => fs.existsSync(path.join(orthosDir, f.image)));
    const windowsOf = new Map<number, WindowRect[]>(), readerStrips: Record<string, number> = {};
    for (const e of fit.facades) {
        if ('error' in e) continue;
        const f = facades.find(x => x.facadeId === e.facadeId);
        const v = f ? voteRects(f, e as { rects: WindowRect[]; reader?: string }) : { rects: e.rects, strips: 0 };
        windowsOf.set(e.facadeId, v.rects);
        if (v.strips) readerStrips[String(e.facadeId)] = v.strips;
    }
    const walls: Wall[] = [], evidence: Array<Pick<WallEvidence, 'u0' | 'cellM' | 'nu'>> = [], states: Int8Array[] = [];
    const frames = groupWalls(facades, P).map(members => {
        const fs0 = members.map(i => facades[i]);
        const ref = fs0.reduce((m, f) => ((f.sMax - f.sMin) * (f.tMax - f.tMin) > (m.sMax - m.sMin) * (m.tMax - m.tMin) ? f : m));
        const U = ref.axisS, N = ref.normal;
        // the wall's extent: every member's corners in (u, y)
        const corners = fs0.flatMap(f => [[f.sMin, f.tMin], [f.sMax, f.tMin], [f.sMin, f.tMax], [f.sMax, f.tMax]].map(([s, t]) => {
            const p = [0, 1, 2].map(k => f.centroid[k] + s * f.axisS[k] + t * f.axisT[k]);
            return [dot(p, U), p[1]];
        }));
        const u0 = Math.min(...corners.map(c => c[0])), u1 = Math.max(...corners.map(c => c[0])), y0 = Math.min(...corners.map(c => c[1])), y1 = Math.max(...corners.map(c => c[1]));
        return { fs0, ref, U, N, u0, u1, y0, y1 };
    });
    const wallOf = (wi: number, x: (typeof frames)[number], cov: number, cells: number, bays: WallBay[]): Wall => ({ wallId: wi, facades: x.fs0.map(f => f.facadeId), normal: x.N, axisU: x.U, offset: dot(x.ref.centroid, x.N), u0: x.u0, u1: x.u1, y0: x.y0, y1: x.y1, coverage: cov / cells, tier: -1, bays });
    if (kNative('wall-grammar')) {
        // natively: every wall's evidence and bays, one wall a task
        const file = (name?: string) => { const p = name ? path.join(orthosDir, name) : undefined; return p && fs.existsSync(p) ? p : undefined; };
        const read = runNativeWallGrammar(wallGrammarParamVector(P), frames.map(x => ({ u0: x.u0, y0: x.y0, u1: x.u1, y1: x.y1, U: x.U, members: x.fs0.map(f => ({ facadeId: f.facadeId, centroid: f.centroid, axisS: f.axisS, axisT: f.axisT, pixel: f.pixel, orthoSMin: f.orthoSMin, orthoTMax: f.orthoTMax, width: f.width, height: f.height, image: path.join(orthosDir, f.image), uncovered: file(f.uncoveredMask), occluded: file(f.occludedMask), windows: windowsOf.get(f.facadeId) ?? [] })) })), opts.threads ?? nativePolishThreads());
        frames.forEach((x, wi) => {
            const r = read[wi];
            walls.push(wallOf(wi, x, r.covered, r.nu * r.ny, r.bays.map(b => ({ u0: b.u0, u1: b.u1, y0: b.y0, y1: b.y1, from: b.generated ? 'generated' : 'photo-inferred' }))));
            evidence.push({ u0: x.u0, cellM: P.cellM, nu: r.nu }); states.push(r.state);
        });
    } else frames.forEach((x, wi) => {
        const e = wallEvidence(orthosDir, x.fs0, windowsOf, x.U, x.u0, x.y0, x.u1, x.y1, decode, P);
        const covered = e.covered;
        let cov = 0; for (let k = 0; k < covered.length; k++) cov += covered[k];
        const r = readWallBays(e, P);
        walls.push(wallOf(wi, x, cov, covered.length, r.bays));
        evidence.push(e); states.push(r.state);
    });
    // tiers, each with one grammar fitted from its walls' read bays and laid along every wall of it (the file comment, 5)
    let tier = 0;
    for (const w of walls) {
        if (w.tier >= 0) continue;
        for (const o of walls) if (o.tier < 0 && Math.abs(o.y1 - w.y1) <= P.tierM && Math.abs(o.y0 - w.y0) <= P.tierM) o.tier = tier;
        tier++;
    }
    const tiers: TierGrammar[] = [];
    for (let t = 0; t < tier; t++) {
        const idx = walls.flatMap((w, i) => (w.tier === t ? [i] : []));
        const g = fitTierGrammar(idx.map(i => walls[i]), P);
        if (!g) continue;
        tiers.push(g);
        for (const i of idx) applyTierGrammar(walls[i], evidence[i], states[i], g, P);
    }
    // per facade, in its own frame
    const perFacade: WallGrammarFile['facades'] = {};
    for (const w of walls) for (const id of w.facades) {
        const f = facades.find(x => x.facadeId === id)!;
        const su = dot(f.axisS, w.axisU), cu = dot(f.centroid, w.axisU), ty = f.axisT[1];
        if (Math.abs(su) < 0.5 || Math.abs(ty) < 0.5) continue;
        const out: Array<[number, number, number, number, number]> = [];
        for (const b of w.bays) {
            const sA = (b.u0 - cu) / su, sB = (b.u1 - cu) / su, tA = (b.y0 - f.centroid[1]) / ty, tB = (b.y1 - f.centroid[1]) / ty;
            const s0 = Math.max(f.sMin, Math.min(sA, sB)), s1 = Math.min(f.sMax, Math.max(sA, sB)), t0 = Math.max(f.tMin, Math.min(tA, tB)), t1 = Math.min(f.tMax, Math.max(tA, tB));
            if (s1 - s0 >= 0.5 && t1 - t0 >= 1.0) out.push([s0, t0, s1, t1, b.from === 'generated' ? 1 : 0]);
        }
        perFacade[String(id)] = out;
    }
    const grammar: WallGrammarFile = { version: WALL_GRAMMAR_VERSION, params: P, walls, tiers, facades: perFacade, ...(Object.keys(readerStrips).length ? { readerStrips } : {}) };
    const file = path.join(orthosDir, WALL_GRAMMAR_FILE);
    fs.writeFileSync(file, JSON.stringify(grammar));
    return { file, grammar };
}

export const WALL_GRAMMAR_FILE = 'wall_grammar.json';

/** One tier's window grammar (see the file comment, 5), in metres. */
export interface TierGrammar { tier: number; walls: number[]; pitch: number; width: number; rows: Array<[number, number]>; readBays: number }

/** A tier's grammar from its walls' read bays, undefined when they hold under minTierBays or no consistent pitch. */
export function fitTierGrammar(walls: Wall[], P: WallGrammarParams = WALL_GRAMMAR_PARAMS): TierGrammar | undefined {
    const read = walls.map(w => w.bays.filter(b => b.from === 'photo-inferred'));
    const all = read.flat();
    if (all.length < P.minTierBays) return undefined;
    const width = median(all.map(b => b.u1 - b.u0));
    // the gaps between neighbouring columns of read bays, on every wall; the shortest common gap is the pitch, and a gap of k pitches votes k times
    const gaps: number[] = [];
    for (const bs of read) {
        const starts = [...new Set(bs.map(b => Math.round(b.u0 * 10) / 10))].sort((a, b) => a - b);
        for (let i = 1; i < starts.length; i++) if (starts[i] - starts[i - 1] >= width) gaps.push(starts[i] - starts[i - 1]);
    }
    if (!gaps.length) return undefined;
    const base = median(gaps.filter(g => g <= Math.min(...gaps) * (1 + P.pitchTol) * 1.5));
    const votes: number[] = [];
    for (const g of gaps) { const k = Math.max(1, Math.round(g / base)); if (Math.abs(g / k - base) <= P.pitchTol * base) for (let i = 0; i < k; i++) votes.push(g / k); }
    if (votes.length < P.minTierBays - 1) return undefined;
    const pitch = median(votes);
    // the rows: each read bay's run, the runs the tier shares (by start and end rounded to cellM) at least twice, else all
    const key = (b: WallBay) => `${Math.round(b.y0 / P.cellM)}:${Math.round(b.y1 / P.cellM)}`;
    const count = new Map<string, WallBay>(), n = new Map<string, number>();
    for (const b of all) { const k = key(b); count.set(k, b); n.set(k, (n.get(k) ?? 0) + 1); }
    let rows = [...count.entries()].filter(([k]) => n.get(k)! >= 2).map(([, b]) => [b.y0, b.y1] as [number, number]);
    if (!rows.length) rows = [...count.values()].map(b => [b.y0, b.y1] as [number, number]);
    // overlapping runs are one (the widest)
    rows.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const r of rows) { const l = merged[merged.length - 1]; if (l && r[0] < l[1]) l[1] = Math.max(l[1], r[1]); else merged.push([...r]); }
    return { tier: walls[0].tier, walls: walls.map(w => w.wallId), pitch, width, rows: merged, readBays: all.length };
}

/** Lays a tier's grammar along one wall (see the file comment, 5): every grammar bay the wall lacks, generated, but none the photo vetoes. */
export function applyTierGrammar(w: Wall, e: Pick<WallEvidence, 'u0' | 'cellM' | 'nu'>, state: Int8Array, g: TierGrammar, P: WallGrammarParams = WALL_GRAMMAR_PARAMS): number {
    const own = w.bays.filter(b => b.from === 'photo-inferred');
    // a wall the photo reads well and finds no bays on has none: the grammar never puts bays on a plain wall
    if (!own.length && w.coverage >= P.silentCoverage) return 0;
    // the phase: the circular mean of the wall's own read bays' starts modulo the pitch, else the bays centred on the wall
    let phase: number;
    if (own.length) {
        let sx = 0, sy = 0;
        for (const b of own) { const a = (2 * Math.PI * b.u0) / g.pitch; sx += Math.cos(a); sy += Math.sin(a); }
        phase = ((Math.atan2(sy, sx) / (2 * Math.PI)) * g.pitch + g.pitch) % g.pitch;
    } else phase = ((((w.u0 + w.u1) / 2 - g.width / 2) % g.pitch) + g.pitch) % g.pitch;
    let added = 0;
    for (let a = w.u0 + ((phase - w.u0) % g.pitch + g.pitch) % g.pitch; a + g.width <= w.u1 + 1e-6; a += g.pitch) {
        const c = a + g.width;
        const xa = Math.max(0, Math.floor((a - e.u0) / e.cellM)), xb = Math.min(e.nu, Math.ceil((c - e.u0) / e.cellM));
        if (xb <= xa) continue;
        let wall = 0; for (let x = xa; x < xb; x++) if (state[x] === 0) wall++;
        if (wall >= P.vetoShare * (xb - xa)) continue;
        for (const [r0, r1] of g.rows) {
            const y0 = Math.max(w.y0, r0), y1 = Math.min(w.y1, r1);
            if (y1 - y0 < P.minRunM) continue;
            if (w.bays.some(o => o.u0 < c && o.u1 > a && o.y0 < y1 && o.y1 > y0)) continue;
            w.bays.push({ u0: a, u1: c, y0, y1, from: 'generated' });
            added++;
        }
    }
    return added;
}

/** A facade's bays from the wall grammar in its own frame ([s0, t0, s1, t1] each), undefined when the grammar does not cover it. */
export function grammarBays(grammar: WallGrammarFile | undefined, facadeId: number): Array<[number, number, number, number]> | undefined {
    const b = grammar?.facades[String(facadeId)];
    return b ? b.map(([s0, t0, s1, t1]) => [s0, t0, s1, t1]) : undefined;
}
