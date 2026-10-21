/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Version F (experiment), step 2: the facade program. The read parameters (facade-parameters.ts) become the native solid
 * builder's operators on the measured massing, the same rules on every wall, seen or not:
 *
 *   - openings (normal relief): an affine lattice per wall, storey lines from the storey heights, bays at the read spacing
 *     centred on the wall (each wall's pitch and phase may be adjusted, adjust.ts), recessed by the read depth; none where a
 *     neighbour's building stands against the wall (measured from the full tile);
 *   - bands, plinth, cornice and parapet (curve sweeps): profiles swept, mitred, along runs of consecutive walls that reach
 *     their height;
 *   - piers (face sweeps): a profile swept up each bay boundary;
 *   - roof: planes from the read pitch and ridge direction at the eave the scan measures; raised roof volumes as small
 *     parts at the read footprint and the scan's height.
 *
 * Everything is labelled: openings and sweeps on walls the tile sees `photo-inferred`, on walls it hardly sees
 * `generated`. No scan triangle reaches the output (the native residual is off, see version-f.ts).
 */

import type { Vec2 } from '../../../../common/spatial/staged-location-contracts';
import type { MassingPart, OpeningItem, RoofPlaneSpec, SweepItem, FaceSweepItem } from '../pipeline-e/massing-spec';
import { inLoops, roofAt } from '../pipeline-e/massing-spec';
import type { MassingFace } from '../pipeline-e/native-massing';
import { bandProfile, parapetProfile } from '../pipeline-e/band-infer';
import { eavePlanes } from '../pipeline-e/roof-infer';
import { storeyLines, type BuildingParameters, type OpeningParameters } from './facade-parameters';

/** A wall at or above this share of tile coverage counts as seen (pipeline E's LOW_COVERAGE). */
export const SEEN_COVERAGE = 0.35;
/** Below this pitch a read roof is built flat. */
export const MIN_PITCH_DEG = 8;
export const PARAPET_THICKNESS_M = 0.3;
/** An opening keeps at least this much wall above it and beside the wall's ends (m). */
export const OPENING_CLEARANCE_M = 0.15;

export const LABEL = { inferred: 'photo-inferred', generated: 'generated', vector: 'vector-modelled', measured: 'measured' } as const;

/** Per wall (face index) adjustments of the bay lattice. */
export interface WallLatticeAdjust {
    pitchScale: number; phaseM: number;
    /** Round 2: the wall's storey lines moved up (m) and its upper storeys scaled. */
    storeyShiftM?: number; storeyScale?: number;
}

export interface TopDown { x0: number; z0: number; pixel: number; width: number; rows: number; height: Float32Array }

export interface ProgramInput {
    faces: MassingFace[];
    parts: MassingPart[];
    groundY: number;
    params: BuildingParameters;
    /** The neighbouring structure's top (absolute y) just outside a wall at `s` (its frame), -Infinity where open. */
    neighbourTop?: (face: MassingFace, s: number) => number;
    perWall?: Map<number, WallLatticeAdjust>;
    /** The scan seen from above (the native top-down height map): eave and ridge heights, raised volumes' heights. */
    topdown?: TopDown;
    /** Round 1's program exactly (no arch heads, bands of openings, per-wall storeys or the volume placement fix). */
    legacy?: boolean;
}

export interface WallPlan { face: number; key: string; seen: boolean; bays: number; pitchM: number; centres: number[]; openings: number; abuttedShare: number }

export interface FacadeProgram {
    parts: MassingPart[];
    openings: OpeningItem[];
    sweeps: SweepItem[];
    faceSweeps: FaceSweepItem[];
    walls: WallPlan[];
    /** Part ids whose roof planes come from the read pitch. */
    pitchedParts: string[];
    /** Part ids added for raised roof volumes. */
    volumeParts: string[];
    notes: string[];
}

/** An extruded wall (`wall`: its top polyline, sweepable) or a vertical facet of a modelled volume (openings and piers only). */
const isFacade = (f: MassingFace) => f.kind === 'wall' && f.width > 0 && f.sMax > f.sMin && Math.abs(f.normal[1]) < 0.15 && f.axisT[1] > 0.95;
const isWall = (f: MassingFace) => isFacade(f) && f.wall;
/** A face's t is height above its origin (axisT up): absolute y = origin y + t. */
const oy = (f: MassingFace) => f.origin[1];
/** Absolute bottom and top (at s) of a facade face. */
const bottomAbs = (f: MassingFace) => (f.wall ? f.tBottom : f.tMin) + oy(f);
const topAbsAt = (f: MassingFace, s: number) => (f.wall ? topAt(f, s) : f.tMax) + oy(f);

/** The wall's top at s (its top polyline), else tMax. */
export function topAt(f: Pick<MassingFace, 'top' | 'tMax'>, s: number): number {
    const p = f.top;
    if (!p?.length) return f.tMax;
    if (s <= p[0][0]) return p[0][1];
    for (let i = 1; i < p.length; i++) if (s <= p[i][0]) { const [s0, t0] = p[i - 1], [s1, t1] = p[i]; return s1 > s0 ? t0 + (t1 - t0) * (s - s0) / (s1 - s0) : Math.min(t0, t1); }
    return p[p.length - 1][1];
}
const minTop = (f: MassingFace) => (f.wall && f.top?.length ? Math.min(...f.top.map(q => q[1])) : f.tMax) + oy(f);
const maxTop = (f: MassingFace) => (f.wall && f.top?.length ? Math.max(...f.top.map(q => q[1])) : f.tMax) + oy(f);

/** The neighbour's highest top over [s0, s1] (5 samples). */
function abutment(inp: ProgramInput, f: MassingFace, s0: number, s1: number): number {
    if (!inp.neighbourTop) return -Infinity;
    let m = -Infinity;
    for (let k = 0; k <= 4; k++) m = Math.max(m, inp.neighbourTop(f, s0 + (s1 - s0) * k / 4));
    return m;
}

/** The bay centres of a wall (s), the lattice's pitch and count. */
export function bayCentres(f: Pick<MassingFace, 'sMin' | 'sMax'>, p: Pick<BuildingParameters, 'bayWidthM' | 'edgeMarginM' | 'window'>, adj?: WallLatticeAdjust): { centres: number[]; pitch: number } {
    const L = f.sMax - f.sMin;
    const pitch = p.bayWidthM * (adj?.pitchScale ?? 1);
    const margin = Math.min(p.edgeMarginM, Math.max(0, (L - p.window.widthM) / 2 - OPENING_CLEARANCE_M));
    const usable = L - 2 * margin;
    if (L < p.window.widthM + 2 * OPENING_CLEARANCE_M) return { centres: [], pitch };
    const n = Math.max(1, Math.round(usable / pitch));
    const start = f.sMin + margin + (usable - n * pitch) / 2 + pitch / 2 + (adj?.phaseM ?? 0);
    return { centres: Array.from({ length: n }, (_, i) => start + i * pitch), pitch };
}

/**
 * The half-width (share of the opening's half-width) of an arch head at `u` (0 at the springing, 1 at the apex): two arcs
 * whose centres lie `sharpness` half-widths apart from the axis (0: one centre, a semicircle; 1: an equilateral pointed
 * arch), the curve then scaled to the read rise (under one half-width: a flattened, segment-like head).
 */
export function archHalfWidth(u: number, sharpness: number): number {
    const d = Math.max(0, Math.min(1, sharpness)), R = 1 + d, H = Math.sqrt(R * R - d * d);
    const y = Math.max(0, Math.min(1, u)) * H;
    return Math.max(0, Math.sqrt(Math.max(0, R * R - y * y)) - d);
}

/**
 * One opening as the native tool's rectangles: the body up to the springing, then the head as stacked slices (about `sliceM`
 * each, at most 8; a modelled volume's facet takes openings no lower than 0.15 m) whose widths follow archHalfWidth: normal relief only, the reveal stepped in plan.
 */
export function openingRects(o: Pick<OpeningParameters, 'archRiseRatio' | 'apexSharpness'>, s0: number, s1: number, t0: number, t1: number, sliceM = 0.1): Array<[number, number, number, number]> {
    const hw = (s1 - s0) / 2, c = (s0 + s1) / 2;
    const rise = Math.min((o.archRiseRatio ?? 0) * hw, 0.6 * (t1 - t0));
    if (rise < 0.08) return [[s0, s1, t0, t1]];
    const spring = t1 - rise;
    const out: Array<[number, number, number, number]> = [[s0, s1, t0, spring]];
    const k = Math.max(2, Math.min(8, Math.ceil(rise / sliceM)));
    for (let j = 0; j < k; j++) {
        const w = hw * archHalfWidth((j + 0.5) / k, o.apexSharpness ?? 0);
        if (w < 0.04) break;
        out.push([c - w, c + w, spring + (rise * j) / k, spring + (rise * (j + 1)) / k]);
    }
    return out;
}

/** The wall's storey lines (absolute y): its own read storeys where it has them, then its adjustment. */
export function wallStoreyLines(inp: ProgramInput, f: MassingFace): number[] {
    const p = inp.params;
    const own = inp.legacy ? undefined : (p.wallStoreys ?? []).find(w => w.faceKey === f.key);
    const adj = inp.perWall?.get(f.index);
    const g = (own ?? p).groundStoreyM + (adj?.storeyShiftM ?? 0), up = (own ?? p).upperStoreysM.map(x => x * (adj?.storeyScale ?? 1));
    return storeyLines({ groundStoreyM: Math.max(2, g), upperStoreysM: up }, maxTop(f) - inp.groundY).map(y => inp.groundY + y);
}

/** The openings of one wall: storeys x bays (grouped in the facade's bands), clipped to the wall, none against a neighbour. */
export function wallOpenings(inp: ProgramInput, f: MassingFace, seen: boolean): { openings: OpeningItem[]; plan: WallPlan } {
    const p = inp.params;
    const { centres, pitch } = bayCentres(f, p, inp.perWall?.get(f.index));
    const out: OpeningItem[] = [];
    const prov = seen ? LABEL.inferred : LABEL.generated;
    const conf = Math.max(0.05, Math.min(1, p.confidence * (seen ? 1 : 0.6)));
    const lines = inp.legacy ? storeyLines(p, maxTop(f) - inp.groundY).map(y => inp.groundY + y) : wallStoreyLines(inp, f);
    const bands = inp.legacy ? [] : (p.facadeBands ?? []);
    let abutted = 0, tried = 0, families = 0;
    const bandOf = (y: number) => bands.find(b => y >= b.bottomM - 0.3 && y < b.topM - 0.5);
    lines.forEach((floor, k) => {
        const band = bandOf(floor - inp.groundY);
        // the storeys of a band are grouped from its first storey; a storey inside a group (not its first) places nothing
        if (band) {
            const first = lines.findIndex(y => bandOf(y - inp.groundY) === band);
            const sg = Math.max(1, Math.round(band.storeyGroup));
            if ((k - first) % sg !== 0) return;
        }
        const o = band ? band.opening : k === 0 ? p.groundOpening : p.window;
        const t0 = floor + o.sillM, t1 = t0 + o.heightM;
        if (t0 < bottomAbs(f) + 0.05) return;
        const bg = band ? Math.max(1, Math.round(band.bayGroup)) : 1;
        const groups: number[] = [];
        if (bg > 1 && centres.length >= bg) for (let b = 0; b + bg <= centres.length; b += bg) groups.push(centres.slice(b, b + bg).reduce((a, x) => a + x, 0) / bg);
        else groups.push(...centres);
        groups.forEach((c, b) => {
            const s0 = Math.max(f.sMin + OPENING_CLEARANCE_M, c - o.widthM / 2), s1 = Math.min(f.sMax - OPENING_CLEARANCE_M, c + o.widthM / 2);
            if (s1 - s0 < 0.6 * o.widthM) return;
            const top = Math.min(topAbsAt(f, s0), topAbsAt(f, s1)) - OPENING_CLEARANCE_M - (p.cornice.thicknessM > 0 ? p.cornice.thicknessM : 0);
            if (t1 > top) return;
            tried++;
            if (abutment(inp, f, s0, s1) > t0 - 0.3) { abutted++; return; }
            families++;
            const id = `f${f.index}_${k}_${b}`;
            const rects = inp.legacy ? [[s0, s1, t0, t1] as [number, number, number, number]] : openingRects(o, s0, s1, t0, t1, f.wall ? 0.1 : 0.18);
            rects.forEach(([a0, a1, b0, b1], j) => out.push({ id: j ? `${id}_h${j}` : id, face: f.key, s0: a0, s1: a1, t0: b0 - oy(f), t1: b1 - oy(f), depth: o.recessM, scanned: false, confidence: conf, provenance: prov }));
        });
    });
    return { openings: out, plan: { face: f.index, key: f.key, seen, bays: centres.length, pitchM: pitch, centres, openings: families, abuttedShare: tried ? abutted / tried : 0 } };
}

/** A wall's plan endpoints (y = 0). */
function ends(f: MassingFace): [Vec2, Vec2] {
    const at = (s: number): Vec2 => [f.origin[0] + f.axisS[0] * s, f.origin[2] + f.axisS[2] * s];
    return [at(f.sMin), at(f.sMax)];
}

/** Walls of each (part, loop) in loop order (edge, then the split index in the key). */
export function wallLoops(faces: MassingFace[]): MassingFace[][] {
    const groups = new Map<string, MassingFace[]>();
    for (const f of faces) if (isWall(f)) { const k = `${f.part}|${f.loop}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(f); }
    const sub = (f: MassingFace) => { const m = /:(\d+):(\d+)$/.exec(f.key); return m && Number(m[1]) === f.edge ? Number(m[2]) : 0; };
    return [...groups.values()].map(g => g.sort((a, b) => a.edge - b.edge || sub(a) - sub(b)));
}

/**
 * Runs of consecutive walls (touching end to start) on which `ok` holds, from walls in loop order; a run that goes all the
 * way round starts where the loop does.
 */
export function chains(loop: MassingFace[], ok: (f: MassingFace) => boolean): MassingFace[][] {
    const out: MassingFace[][] = [];
    let cur: MassingFace[] = [];
    const touches = (a: MassingFace, b: MassingFace) => { const [, ae] = ends(a), [bs] = ends(b); return Math.hypot(ae[0] - bs[0], ae[1] - bs[1]) < 0.05; };
    for (const f of loop) {
        if (ok(f) && (!cur.length || touches(cur[cur.length - 1], f))) cur.push(f);
        else { if (cur.length) out.push(cur); cur = ok(f) ? [f] : []; }
    }
    if (cur.length) out.push(cur);
    // join the last run onto the first when they meet round the loop's start
    if (out.length > 1 && out[0][0] === loop[0] && out[out.length - 1][out[out.length - 1].length - 1] === loop[loop.length - 1] && touches(loop[loop.length - 1], loop[0])) {
        const last = out.pop()!;
        out[0] = [...last, ...out[0]];
    }
    return out;
}

function sweepLabel(run: MassingFace[]): { provenance: string; seenShare: number } {
    const len = run.reduce((a, f) => a + (f.sMax - f.sMin), 0) || 1;
    const seen = run.reduce((a, f) => a + (f.coverage >= SEEN_COVERAGE ? f.sMax - f.sMin : 0), 0) / len;
    return { provenance: seen >= 0.5 ? LABEL.inferred : LABEL.generated, seenShare: seen };
}

/** The scan's median top inside a plan box (m), NaN without a top-down map or samples. */
function medianTopIn(td: TopDown | undefined, x0: number, z0: number, x1: number, z1: number): number {
    if (!td) return NaN;
    const v: number[] = [];
    for (let z = z0; z <= z1; z += td.pixel * 2) for (let x = x0; x <= x1; x += td.pixel * 2) {
        const c = Math.floor((x - td.x0) / td.pixel), r = Math.floor((z - td.z0) / td.pixel);
        if (c < 0 || r < 0 || c >= td.width || r >= td.rows) continue;
        const h = td.height[r * td.width + c];
        if (Number.isFinite(h)) v.push(h);
    }
    if (!v.length) return NaN;
    v.sort((a, b) => a - b);
    return v[v.length >> 1];
}

/** The scan's eave (median top within 1 m inside the outer loop) and ridge (97th percentile inside) for a part. */
function eaveAndRidge(td: TopDown | undefined, part: MassingPart): { eave: number; ridge: number } {
    if (!td) return { eave: NaN, ridge: NaN };
    const rim: number[] = [], inner: number[] = [];
    const outer = part.loops[0];
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of outer) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    for (let z = z0; z <= z1; z += 0.5) for (let x = x0; x <= x1; x += 0.5) {
        if (!inLoops(x, z, part.loops)) continue;
        const c = Math.floor((x - td.x0) / td.pixel), r = Math.floor((z - td.z0) / td.pixel);
        if (c < 0 || r < 0 || c >= td.width || r >= td.rows) continue;
        const h = td.height[r * td.width + c];
        if (!Number.isFinite(h)) continue;
        let d = Infinity;
        for (let i = 0; i < outer.length; i++) {
            const a = outer[i], b = outer[(i + 1) % outer.length], ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez || 1e-9;
            const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / L2));
            d = Math.min(d, Math.hypot(x - a[0] - t * ex, z - a[1] - t * ez));
        }
        (d <= 1 ? rim : inner).push(h);
    }
    const q = (v: number[], f: number) => { if (!v.length) return NaN; const s = [...v].sort((a, b) => a - b); return s[Math.floor(f * (s.length - 1))]; };
    return { eave: q(rim, 0.5), ridge: q(inner, 0.97) };
}

/** The whole facade program for one building. */
export function facadeProgram(inp: ProgramInput): FacadeProgram {
    const p = inp.params;
    const notes: string[] = [];
    const openings: OpeningItem[] = [];
    const walls: WallPlan[] = [];
    for (const f of inp.faces) {
        if (!isFacade(f) || f.sMax - f.sMin < 0.8 || maxTop(f) - bottomAbs(f) < 2) continue;
        const r = wallOpenings(inp, f, f.coverage >= SEEN_COVERAGE);
        openings.push(...r.openings);
        walls.push(r.plan);
    }
    const loops = wallLoops(inp.faces);
    const sweeps: SweepItem[] = [];
    const conf = Math.max(0.05, Math.min(1, p.confidence));
    const notAbutted = (f: MassingFace, y: number) => abutment(inp, f, f.sMin, f.sMax) < y;
    const addSweep = (id: string, run: MassingFace[], profile: Array<[number, number]>, relativeToTop = false) => {
        const { provenance } = sweepLabel(run);
        sweeps.push({ id, confidence: provenance === LABEL.inferred ? conf : conf * 0.6, provenance, profile, faces: run.map(f => f.key), ...(relativeToTop ? { relativeToTop: true } : {}) });
    };
    loops.forEach((loop, li) => {
        // bands at their heights
        p.bands.forEach((b, bi) => {
            const y = inp.groundY + b.heightM, y0 = y - b.thicknessM / 2, y1 = y + b.thicknessM / 2;
            chains(loop, f => f.tBottom <= y0 - 0.05 && minTop(f) >= y1 + 0.05 && notAbutted(f, y0)).forEach((run, ri) => addSweep(`band${bi}_${li}_${ri}`, run, bandProfile(y0, y1, b.projectionM)));
        });
        // plinth on walls that stand on the ground
        if (p.plinth.heightM > 0.05 && p.plinth.projectionM > 0.01) {
            chains(loop, f => Math.abs(f.tBottom - inp.groundY) <= 0.6 && minTop(f) >= f.tBottom + p.plinth.heightM + 0.3).forEach((run, ri) => {
                const b0 = Math.min(...run.map(f => f.tBottom)), b1 = inp.groundY + p.plinth.heightM;
                addSweep(`plinth_${li}_${ri}`, run, [[0, b0], [p.plinth.projectionM, b0], [p.plinth.projectionM, b1], [0, b1 + Math.min(0.05, p.plinth.projectionM)]]);
            });
        }
        // cornice and parapet at each run of walls sharing a flat top
        const flatTop = (f: MassingFace) => maxTop(f) - minTop(f) <= 0.25;
        const tops = [...new Set(loop.filter(flatTop).map(f => Math.round(maxTop(f) * 4) / 4))];
        for (const top of tops) {
            const same = (f: MassingFace) => flatTop(f) && Math.abs(maxTop(f) - top) <= 0.3 && notAbutted(f, top - 0.5);
            chains(loop, f => same(f) && top - f.tBottom >= Math.max(2, 2 * p.cornice.thicknessM)).forEach((run, ri) => {
                const id = `${li}_${String(top).replace('.', 'p')}_${ri}`;
                if (p.cornice.thicknessM > 0.05 && p.cornice.projectionM > 0.02) addSweep(`cornice_${id}`, run, bandProfile(top - p.cornice.thicknessM, top, p.cornice.projectionM));
                if (p.parapet.heightM > 0.1) addSweep(`parapet_${id}`, run, parapetProfile(p.parapet.heightM, PARAPET_THICKNESS_M), true);
            });
        }
    });
    // piers up each bay boundary
    const faceSweeps: FaceSweepItem[] = [];
    if (p.piers.widthM >= 0.1 && p.piers.projectionM >= 0.03) {
        const hw = p.piers.widthM / 2, e = Math.min(0.03, hw / 4);
        for (const w of walls) {
            const f = inp.faces[w.face];
            if (!f || w.bays < 1) continue;
            const t0 = Math.max(bottomAbs(f), inp.groundY + p.plinth.heightM);
            const placements: Array<[number, number, number]> = [];
            const bounds = [...w.centres.map(c => c - w.pitchM / 2), w.centres[w.centres.length - 1] + w.pitchM / 2];
            for (const sb of bounds) {
                if (sb - hw < f.sMin - 0.01 || sb + hw > f.sMax + 0.01) continue;
                const top = Math.min(topAbsAt(f, sb - hw), topAbsAt(f, sb + hw)) - (p.cornice.thicknessM > 0.05 ? p.cornice.thicknessM : 0);
                const a0 = Math.max(t0, abutment(inp, f, sb - hw, sb + hw) + 0.3);
                if (top - a0 >= 1) placements.push([a0 - oy(f), top - oy(f), sb]);
            }
            if (!placements.length) continue;
            const seen = f.coverage >= SEEN_COVERAGE;
            faceSweeps.push({ id: `pier_${f.index}`, confidence: seen ? conf : conf * 0.6, provenance: seen ? LABEL.inferred : LABEL.generated, face: f.key, axis: 1, profile: [[0, -hw], [p.piers.projectionM, -hw + e], [p.piers.projectionM, hw - e], [0, hw]], placements });
        }
    }
    // roof: the read pitch on extruded parts, at the eave the scan measures
    const parts = inp.parts.map(q => ({ ...q, loops: q.loops.map(l => l.map(v => [v[0], v[1]] as Vec2)), planes: [...q.planes] }));
    const pitchedParts: string[] = [];
    if (p.roof.pitchDeg >= MIN_PITCH_DEG) {
        for (const part of parts) {
            if (part.planes.length) continue;
            const { eave, ridge } = eaveAndRidge(inp.topdown, part);
            const eaveY = Number.isFinite(eave) ? eave : part.topY;
            const planes: RoofPlaneSpec[] = eavePlanes(part, p.roof.pitchDeg, p.roof.ridgeAzimuthDeg, p.roof.hipped, eaveY).map(pl => ({ ...pl, tag: `f-${pl.tag}` }));
            if (!planes.length) continue;
            part.planes = planes;
            part.topY = Math.max(Number.isFinite(ridge) ? ridge : part.topY, eaveY + 0.5);
            pitchedParts.push(part.id);
        }
        notes.push(`roof pitch ${p.roof.pitchDeg.toFixed(1)} deg on ${pitchedParts.length} of ${parts.length} parts`);
    }
    // raised roof volumes: the read footprint, the scan's height there (or the read height)
    const volumeParts: string[] = [];
    if (inp.topdown) {
        const td = inp.topdown;
        p.rooftopVolumes.forEach((v, k) => {
            let x0 = td.x0 + (v.box[0] / 1000) * td.width * td.pixel, x1 = td.x0 + (v.box[2] / 1000) * td.width * td.pixel;
            let z0 = td.z0 + (v.box[1] / 1000) * td.rows * td.pixel, z1 = td.z0 + (v.box[3] / 1000) * td.rows * td.pixel;
            if (x1 - x0 < 0.8 || z1 - z0 < 0.8) return;
            let cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
            let host = parts.find(q => inLoops(cx, cz, q.loops));
            if (!inp.legacy) {
                // the part under most of the box hosts it, and it shrinks towards the middle of what lies on that part
                const counts = new Map<MassingPart, { n: number; sx: number; sz: number }>();
                for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) {
                    const x = x0 + ((i + 0.5) / 12) * (x1 - x0), z = z0 + ((j + 0.5) / 12) * (z1 - z0);
                    const q = parts.find(pp => !volumeParts.includes(pp.id) && inLoops(x, z, pp.loops));
                    if (!q) continue;
                    const c = counts.get(q) ?? { n: 0, sx: 0, sz: 0 };
                    c.n++; c.sx += x; c.sz += z; counts.set(q, c);
                }
                const best = [...counts.entries()].sort((a, b) => b[1].n - a[1].n)[0];
                if (best) { host = best[0]; cx = best[1].sx / best[1].n; cz = best[1].sz / best[1].n; }
            }
            if (!host) return;
            const hostPart = host;
            // a raised volume stands on its host's roof: shrunk about its centre until it lies 0.4 m inside the host's plan
            // (a box reaching past the walls would cut them, the native tool trimming a wall to what stands outside it)
            const insideHost = (a: number, b: number, c: number, d: number) => {
                for (let i = 0; i <= 4; i++) for (const [x, z] of [[a + (c - a) * i / 4, b], [a + (c - a) * i / 4, d], [a, b + (d - b) * i / 4], [c, b + (d - b) * i / 4]]) {
                    for (const [ox, oz] of [[0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4]]) if (!inLoops(x + ox, z + oz, hostPart.loops)) return false;
                }
                return true;
            };
            let k2 = 1;
            while (k2 > 0.2 && !insideHost(cx - (cx - x0) * k2, cz - (cz - z0) * k2, cx + (x1 - cx) * k2, cz + (z1 - cz) * k2)) k2 -= 0.05;
            if (k2 <= 0.2) { notes.push(`raised volume ${k} dropped: it does not fit inside the roof it stands on`); return; }
            x0 = cx - (cx - x0) * k2; x1 = cx + (x1 - cx) * k2; z0 = cz - (cz - z0) * k2; z1 = cz + (z1 - cz) * k2;
            if (x1 - x0 < 0.8 || z1 - z0 < 0.8) return;
            const roof = roofAt(hostPart, cx, cz);
            const scanTop = medianTopIn(td, x0, z0, x1, z1);
            const topY = Number.isFinite(scanTop) && scanTop - roof >= 0.5 ? scanTop : roof + v.heightM;
            const id = `f-volume-${k}`;
            parts.push({ id, baseY: roof - 0.3, topY, loops: [[[x0, z0], [x1, z0], [x1, z1], [x0, z1]]], planes: [], heightSource: Number.isFinite(scanTop) && scanTop - roof >= 0.5 ? 'scan' : 'photo', heights: { scanY: scanTop }, provenance: LABEL.inferred });
            volumeParts.push(id);
        });
    }
    const seenWalls = walls.filter(w => w.seen).length;
    notes.push(`${openings.length} openings on ${walls.filter(w => w.openings).length} walls (${seenWalls} seen, ${walls.length - seenWalls} hidden), ${sweeps.length} swept bands/cornices/parapets/plinths, ${faceSweeps.length} walls with piers, ${volumeParts.length} raised roof volumes`);
    return { parts, openings, sweeps, faceSweeps, walls, pitchedParts, volumeParts, notes };
}
