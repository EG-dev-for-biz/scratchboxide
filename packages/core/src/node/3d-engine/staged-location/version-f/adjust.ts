/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Version F (experiment), step 4: adjust the read parameters to reduce the render-compare disagreement on the seen walls.
 *
 * A bounded search (two grids, then a fixed number of coordinate rounds, the step halved each round) over the continuous
 * parameters the wall cameras can see: storey heights, opening sizes and sills, bay spacing and margin, recess, plinth, bands, cornice
 * and piers; then, per seen wall, the bay lattice's pitch and phase. The objective per wall is (1 - window NCC) / 2 plus
 * half the depth disagreement in metres (DEPTH_WEIGHT), area-weighted over the seen walls; it is evaluated on the program's own offset map
 * (render-compare.ts programWallOffset), the same picture the rendered model gives, so a step costs milliseconds. Each
 * round's numbers are recorded; a change is kept only when it lowers the objective.
 */

import { PARAMETER_BOUNDS, type BuildingParameters } from './facade-parameters';
import { facadeProgram, wallOpenings, wallPiers, type FacadeProgram, type ProgramInput, type WallLatticeAdjust } from './facade-program';
import { wallRects, type CompareJob, type NativeCompare, type OffsetRect, type WallScore } from './native-compare';
import { compareWall, programWallOffset, type WallEvidence } from './render-compare';

export interface AdjustRound { round: number; objective: number; windowNcc: number; depthMaeM: number; changed: string[] }
export interface AdjustResult { params: BuildingParameters; perWall: Map<number, WallLatticeAdjust>; rounds: AdjustRound[]; evaluations: number; ms: number }

/** Metres of depth disagreement worth one unit of (1 - NCC) / 2: the tile's ortho depth is a noisy scan, the photo's darkness the sharper signal. */
export const DEPTH_WEIGHT = 0.5;

const clone = (p: BuildingParameters): BuildingParameters => JSON.parse(JSON.stringify(p));

interface Knob { name: string; get: (p: BuildingParameters) => number; set: (p: BuildingParameters, v: number) => void; step: number; lo: number; hi: number; enabled?: (p: BuildingParameters) => boolean }

/** The global knobs, each a continuous dimension with its starting step and bounds. */
export function knobs(params?: BuildingParameters, shapes = false): Knob[] {
    const B = PARAMETER_BOUNDS;
    const k = (name: string, get: Knob['get'], set: Knob['set'], step: number, [lo, hi]: readonly [number, number], enabled?: Knob['enabled']): Knob => ({ name, get, set, step, lo, hi, ...(enabled ? { enabled } : {}) });
    return [
        k('groundStoreyM', p => p.groundStoreyM, (p, v) => { p.groundStoreyM = v; }, 0.4, B.storeyM),
        k('upperStoreyScale', p => p.upperStoreysM[0], (p, v) => { const s = v / p.upperStoreysM[0]; p.upperStoreysM = p.upperStoreysM.map(x => Math.max(B.storeyM[0], Math.min(B.storeyM[1], x * s))); }, 0.2, B.storeyM),
        k('window.heightM', p => p.window.heightM, (p, v) => { p.window.heightM = v; }, 0.3, B.openingHeightM),
        k('window.widthM', p => p.window.widthM, (p, v) => { p.window.widthM = v; }, 0.2, B.openingWidthM),
        k('window.sillM', p => p.window.sillM, (p, v) => { p.window.sillM = v; }, 0.2, B.sillM),
        k('groundOpening.heightM', p => p.groundOpening.heightM, (p, v) => { p.groundOpening.heightM = v; }, 0.4, B.openingHeightM),
        k('groundOpening.widthM', p => p.groundOpening.widthM, (p, v) => { p.groundOpening.widthM = v; }, 0.3, B.openingWidthM),
        k('bayWidthM', p => p.bayWidthM, (p, v) => { p.bayWidthM = v; }, 0.2, B.bayWidthM),
        k('edgeMarginM', p => p.edgeMarginM, (p, v) => { p.edgeMarginM = v; }, 0.3, B.edgeMarginM),
        k('window.recessM', p => p.window.recessM, (p, v) => { p.window.recessM = v; p.groundOpening.recessM = Math.max(B.recessM[0], v); }, 0.08, B.recessM),
        k('cornice.thicknessM', p => p.cornice.thicknessM, (p, v) => { p.cornice.thicknessM = v; }, 0.2, [0, 3], p => p.cornice.projectionM > 0.02),
        k('cornice.projectionM', p => p.cornice.projectionM, (p, v) => { p.cornice.projectionM = v; }, 0.15, B.projectionM, p => p.cornice.thicknessM > 0.05),
        k('plinth.heightM', p => p.plinth.heightM, (p, v) => { p.plinth.heightM = v; }, 0.2, B.plinthHeightM, p => p.plinth.projectionM > 0.01),
        k('piers.widthM', p => p.piers.widthM, (p, v) => { p.piers.widthM = v; }, 0.1, B.pierWidthM, p => p.piers.projectionM >= 0.03),
        k('piers.projectionM', p => p.piers.projectionM, (p, v) => { p.piers.projectionM = v; }, 0.05, B.projectionM, p => p.piers.widthM >= 0.1),
        // round 2: the heads' shape and each band's openings, all continuous
        ...(shapes ? [
            k('window.archRiseRatio', p => p.window.archRiseRatio ?? 0, (p, v) => { p.window.archRiseRatio = v; }, 0.25, B.archRiseRatio),
            k('window.apexSharpness', p => p.window.apexSharpness ?? 0, (p, v) => { p.window.apexSharpness = v; }, 0.25, B.apexSharpness, p => (p.window.archRiseRatio ?? 0) > 0.2),
            k('groundOpening.archRiseRatio', p => p.groundOpening.archRiseRatio ?? 0, (p, v) => { p.groundOpening.archRiseRatio = v; }, 0.25, B.archRiseRatio),
            ...(params?.facadeBands ?? []).flatMap((_, i) => [
                k(`band${i}.widthM`, p => p.facadeBands[i].opening.widthM, (p, v) => { p.facadeBands[i].opening.widthM = v; }, 0.25, B.openingWidthM),
                k(`band${i}.heightM`, p => p.facadeBands[i].opening.heightM, (p, v) => { p.facadeBands[i].opening.heightM = v; }, 0.3, B.openingHeightM),
                k(`band${i}.sillM`, p => p.facadeBands[i].opening.sillM, (p, v) => { p.facadeBands[i].opening.sillM = v; }, 0.2, B.sillM),
                k(`band${i}.archRiseRatio`, p => p.facadeBands[i].opening.archRiseRatio ?? 0, (p, v) => { p.facadeBands[i].opening.archRiseRatio = v; }, 0.25, B.archRiseRatio),
                k(`band${i}.apexSharpness`, p => p.facadeBands[i].opening.apexSharpness ?? 0, (p, v) => { p.facadeBands[i].opening.apexSharpness = v; }, 0.25, B.apexSharpness, p => (p.facadeBands[i].opening.archRiseRatio ?? 0) > 0.2),
                k(`band${i}.bottomM`, p => p.facadeBands[i].bottomM, (p, v) => { p.facadeBands[i].bottomM = v; }, 0.5, [0, 400])
            ])
        ] : [])
    ];
}

/** Evaluates one parameter set on the seen walls: the objective, its parts and per-wall numbers. */
export function evaluate(base: ProgramInput, params: BuildingParameters, perWall: Map<number, WallLatticeAdjust>, evidence: WallEvidence[], inside: Map<number, Uint8Array>): { objective: number; windowNcc: number; depthMaeM: number; perWallObjective: Map<number, number> } {
    const prog = facadeProgram({ ...base, params, perWall });
    let J = 0, ncc = 0, mae = 0, A = 0;
    const perWallObjective = new Map<number, number>();
    for (const ev of evidence) {
        const f = ev.tile.face;
        const off = programWallOffset(f, prog.openings, prog.sweeps, prog.faceSweeps, inside.get(f.index));
        const c = compareWall(ev, off);
        const d = Number.isFinite(c.depthMaeM) ? c.depthMaeM : 0.5;
        const j = (1 - c.windowNcc) / 2 + DEPTH_WEIGHT * d;
        perWallObjective.set(f.index, j);
        J += j * f.area; ncc += c.windowNcc * f.area; mae += d * f.area; A += f.area;
    }
    A = A || 1;
    return { objective: J / A, windowNcc: ncc / A, depthMaeM: mae / A, perWallObjective };
}

/**
 * The bounded search: (a) a grid over the ground storey and a common scale of the upper storeys (the storey lines are the
 * reading's least reliable numbers and a local step cannot cross a whole storey); (b) per seen wall, a grid over the bay
 * lattice's pitch and phase, that wall alone compared; (c) `rounds` rounds of coordinate steps on every knob and again on
 * each wall's pitch and phase, the step halved each round. A change is kept only when it lowers the objective.
 */
export function adjustParameters(base: ProgramInput, evidence: WallEvidence[], inside: Map<number, Uint8Array>, rounds = 3, options: { shapes?: boolean } = {}): AdjustResult {
    const t0 = Date.now();
    let params = clone(base.params);
    const perWall = new Map<number, WallLatticeAdjust>();
    let evaluations = 0;
    const ev = (p: BuildingParameters, pw: Map<number, WallLatticeAdjust>, only?: WallEvidence[]) => { evaluations++; return evaluate(base, p, pw, only ?? evidence, inside); };
    let cur = ev(params, perWall);
    const out: AdjustRound[] = [{ round: 0, objective: cur.objective, windowNcc: cur.windowNcc, depthMaeM: cur.depthMaeM, changed: [] }];
    const B = PARAMETER_BOUNDS;
    // (a) storey grid
    {
        const g0 = params.groundStoreyM, u0 = [...params.upperStoreysM];
        let best = { g: g0, k: 1, e: cur };
        for (let dg = -1; dg <= 1.0001; dg += 0.2) for (let k = 0.85; k <= 1.1501; k += 0.025) {
            const g = Math.max(B.storeyM[0], Math.min(B.storeyM[1], g0 + dg));
            const trial = clone(params);
            trial.groundStoreyM = g;
            trial.upperStoreysM = u0.map(x => Math.max(B.storeyM[0], Math.min(B.storeyM[1], x * k)));
            const e = ev(trial, perWall);
            if (e.objective < best.e.objective - 1e-4) best = { g, k, e };
        }
        const changed: string[] = [];
        if (best.e !== cur) {
            params.groundStoreyM = best.g;
            params.upperStoreysM = u0.map(x => Math.max(B.storeyM[0], Math.min(B.storeyM[1], x * best.k)));
            cur = best.e;
            changed.push(`groundStoreyM ${g0.toFixed(2)}->${best.g.toFixed(2)}`, `upper storeys x${best.k.toFixed(3)}`);
        }
        out.push({ round: 1, objective: cur.objective, windowNcc: cur.windowNcc, depthMaeM: cur.depthMaeM, changed });
    }
    // (b) per-wall lattice grid
    {
        const changed: string[] = [];
        for (const e of evidence) {
            const fi = e.tile.face.index;
            const own = [e];
            let bestA: WallLatticeAdjust = { pitchScale: 1, phaseM: 0 };
            let bestJ = ev(params, perWall, own).objective;
            for (let ps = 0.88; ps <= 1.1201; ps += 0.02) for (let q = -6; q < 6; q++) {
                const a = { pitchScale: ps, phaseM: (q / 12) * params.bayWidthM * ps };
                const j = ev(params, new Map(perWall).set(fi, a), own).objective;
                if (j < bestJ - 1e-4) { bestJ = j; bestA = a; }
            }
            if (bestA.pitchScale !== 1 || bestA.phaseM !== 0) { perWall.set(fi, bestA); changed.push(`wall ${fi} pitch x${bestA.pitchScale.toFixed(2)} phase ${bestA.phaseM.toFixed(2)} m`); }
        }
        // round 2: each seen wall's own storey lines (a double-height ground floor, a penthouse), that wall alone compared
        if (options.shapes) for (const e of evidence) {
            const fi = e.tile.face.index, own = [e];
            const a0 = perWall.get(fi) ?? { pitchScale: 1, phaseM: 0 };
            let best = a0, bestJ = ev(params, perWall, own).objective;
            for (let sh = -1.5; sh <= 1.5001; sh += 0.25) for (let sc = 0.9; sc <= 1.1001; sc += 0.025) {
                const a = { ...a0, storeyShiftM: sh, storeyScale: sc };
                const j = ev(params, new Map(perWall).set(fi, a), own).objective;
                if (j < bestJ - 2e-3) { bestJ = j; best = a; }
            }
            if (best !== a0) { perWall.set(fi, best); changed.push(`wall ${fi} storeys ${(best.storeyShiftM ?? 0) >= 0 ? '+' : ''}${(best.storeyShiftM ?? 0).toFixed(2)} m x${(best.storeyScale ?? 1).toFixed(3)}`); }
        }
        cur = ev(params, perWall);
        out.push({ round: 2, objective: cur.objective, windowNcc: cur.windowNcc, depthMaeM: cur.depthMaeM, changed });
    }
    // (c) coordinate rounds
    const K = knobs(params, !!options.shapes);
    for (let r = 1; r <= rounds; r++) {
        const changed: string[] = [];
        const scale = Math.pow(0.5, r - 1);
        for (const k of K) {
            if (k.enabled && !k.enabled(params)) continue;
            for (const dir of [1, -1]) {
                const v0 = k.get(params), v = Math.max(k.lo, Math.min(k.hi, v0 + dir * k.step * scale));
                if (Math.abs(v - v0) < 1e-6) continue;
                const trial = clone(params);
                k.set(trial, v);
                const e = ev(trial, perWall);
                if (e.objective < cur.objective - 1e-4) { params = trial; cur = e; changed.push(`${k.name} ${v0.toFixed(2)}->${v.toFixed(2)}`); break; }
            }
        }
        for (const e of evidence) {
            const fi = e.tile.face.index;
            const pitch = params.bayWidthM;
            for (const [field, step] of [['phaseM', pitch * 0.08 * scale], ['pitchScale', 0.01 * scale]] as const) {
                for (const dir of [1, -1]) {
                    const a = perWall.get(fi) ?? { pitchScale: 1, phaseM: 0 };
                    const next = { ...a, [field]: a[field] + dir * step };
                    if (Math.abs(next.phaseM) > pitch / 2 || Math.abs(next.pitchScale - 1) > 0.15) continue;
                    const pw = new Map(perWall).set(fi, next);
                    const t = ev(params, pw);
                    if (t.objective < cur.objective - 1e-4) { perWall.set(fi, next); cur = t; changed.push(`wall ${fi} ${field} ${a[field].toFixed(2)}->${next[field].toFixed(2)}`); break; }
                }
            }
        }
        out.push({ round: 2 + r, objective: cur.objective, windowNcc: cur.windowNcc, depthMaeM: cur.depthMaeM, changed });
        if (!changed.length) break;
    }
    return { params, perWall, rounds: out, evaluations, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------------------------------------------------------------
// Round 3: the same search on the native kernel (native-compare.ts), in batches. Every candidate of a step is scored at once,
// each wall on its own core; a wall whose rectangles a candidate did not change is answered from memory. The per-wall steps
// (lattice pitch and phase, storey shift and scale) are independent between walls (the objective is a sum over walls), so
// every wall's whole grid goes in one batch and each wall keeps its own best. The global knobs are searched best-first: all
// the knobs' trials in one batch, the best improving one applied, again until none improves (at most MAX_PASSES per round).
// ---------------------------------------------------------------------------------------------------------------------


/** Best-first passes over the global knobs per coordinate round. */
export const MAX_PASSES = 6;

const wallObjective = (s: WallScore) => (1 - s.ncc) / 2 + DEPTH_WEIGHT * (Number.isFinite(s.depthMaeM) ? s.depthMaeM : 0.5);

interface Candidate { params: BuildingParameters; perWall: Map<number, WallLatticeAdjust> }

/** The rectangles of every seen wall for a whole program. */
function programRects(prog: Pick<FacadeProgram, 'openings' | 'sweeps' | 'faceSweeps'>, evidence: WallEvidence[]): Map<number, OffsetRect[]> {
    const out = new Map<number, OffsetRect[]>();
    for (const ev of evidence) out.set(ev.tile.face.index, wallRects(ev.tile.face, prog.openings, prog.sweeps, prog.faceSweeps));
    return out;
}

/** One wall's rectangles for a candidate that moves that wall only (its openings and piers; the sweeps from the base program). */
function wallOnlyRects(base: ProgramInput, c: Candidate, ev: WallEvidence, sweeps: FacadeProgram['sweeps']): OffsetRect[] {
    const f = ev.tile.face;
    const inp: ProgramInput = { ...base, params: c.params, perWall: c.perWall };
    const r = wallOpenings(inp, f, true);
    const pier = wallPiers(inp, f, r.plan);
    return wallRects(f, r.openings, sweeps, pier ? [pier] : []);
}

/** Area-weighted objective of per-wall scores. */
function combine(scores: Map<number, WallScore>, evidence: WallEvidence[]): { objective: number; windowNcc: number; depthMaeM: number } {
    let J = 0, ncc = 0, mae = 0, A = 0;
    for (const ev of evidence) {
        const s = scores.get(ev.tile.face.index);
        if (!s) continue;
        const a = ev.tile.face.area;
        J += wallObjective(s) * a; ncc += s.ncc * a; mae += (Number.isFinite(s.depthMaeM) ? s.depthMaeM : 0.5) * a; A += a;
    }
    A = A || 1;
    return { objective: J / A, windowNcc: ncc / A, depthMaeM: mae / A };
}

export interface NativeAdjustResult extends AdjustResult { batches: number; sentJobs: number; keptJobs: number }

/**
 * The bounded search of adjustParameters on the native kernel. `compare` holds the evidence of the seen walls (`evidence`,
 * the same objects, give the faces and areas). A change is kept only when it lowers the objective, as before.
 */
export async function adjustParametersNative(base: ProgramInput, evidence: WallEvidence[], compare: NativeCompare, rounds = 3, options: { shapes?: boolean; onProgress?: (m: string) => void } = {}): Promise<NativeAdjustResult> {
    const t0 = Date.now();
    const B = PARAMETER_BOUNDS;
    let params = clone(base.params);
    const perWall = new Map<number, WallLatticeAdjust>();
    let evaluations = 0;
    const faces = evidence.map(e => e.tile.face.index);
    /** Scores whole candidates (every wall) in one batch. */
    const scoreFull = async (cands: Candidate[]): Promise<Array<ReturnType<typeof combine>>> => {
        const jobs: CompareJob[] = [];
        const progs = cands.map(c => facadeProgram({ ...base, params: c.params, perWall: c.perWall }));
        for (const prog of progs) for (const [face, rects] of programRects(prog, evidence)) jobs.push({ face, rects });
        evaluations += cands.length;
        const scores = await compare.score(jobs);
        return cands.map((_, k) => { const m = new Map<number, WallScore>(); faces.forEach((face, i) => m.set(face, scores[k * faces.length + i])); return combine(m, evidence); });
    };
    let cur = (await scoreFull([{ params, perWall }]))[0];
    const out: AdjustRound[] = [{ round: 0, objective: cur.objective, windowNcc: cur.windowNcc, depthMaeM: cur.depthMaeM, changed: [] }];
    // (a) storey grid, one batch
    {
        const g0 = params.groundStoreyM, u0 = [...params.upperStoreysM];
        const cands: Array<Candidate & { g: number; k: number }> = [];
        for (let dg = -1; dg <= 1.0001; dg += 0.2) for (let k = 0.85; k <= 1.1501; k += 0.025) {
            const g = Math.max(B.storeyM[0], Math.min(B.storeyM[1], g0 + dg));
            const trial = clone(params);
            trial.groundStoreyM = g;
            trial.upperStoreysM = u0.map(x => Math.max(B.storeyM[0], Math.min(B.storeyM[1], x * k)));
            cands.push({ params: trial, perWall, g, k });
        }
        options.onProgress?.(`adjusting: storey grid, ${cands.length} candidates on ${faces.length} walls`);
        const res = await scoreFull(cands);
        let best = -1;
        res.forEach((r, i) => { if (r.objective < (best < 0 ? cur.objective : res[best].objective) - 1e-4) best = i; });
        const changed: string[] = [];
        if (best >= 0) { params = cands[best].params; cur = res[best]; changed.push(`groundStoreyM ${g0.toFixed(2)}->${cands[best].g.toFixed(2)}`, `upper storeys x${cands[best].k.toFixed(3)}`); }
        out.push({ round: 1, objective: cur.objective, windowNcc: cur.windowNcc, depthMaeM: cur.depthMaeM, changed });
    }
    // (b) per-wall grids, every wall's whole grid in one batch (walls independent); the sweeps are the base program's
    const sweeps = facadeProgram({ ...base, params, perWall }).sweeps;
    const perWallGrid = async (grid: (fi: number, a0: WallLatticeAdjust) => WallLatticeAdjust[], tol: number, label: (a: WallLatticeAdjust) => string): Promise<string[]> => {
        const jobs: CompareJob[] = [];
        const index: Array<{ ev: WallEvidence; cands: WallLatticeAdjust[] }> = [];
        for (const ev of evidence) {
            const fi = ev.tile.face.index, a0 = perWall.get(fi) ?? { pitchScale: 1, phaseM: 0 };
            const cands = [a0, ...grid(fi, a0)];
            index.push({ ev, cands });
            for (const a of cands) jobs.push({ face: fi, rects: wallOnlyRects(base, { params, perWall: new Map(perWall).set(fi, a) }, ev, sweeps) });
        }
        evaluations += jobs.length;
        const scores = await compare.score(jobs);
        const changed: string[] = [];
        let k = 0;
        for (const { ev, cands } of index) {
            const fi = ev.tile.face.index;
            let bestJ = wallObjective(scores[k]), best = cands[0];
            for (let i = 1; i < cands.length; i++) { const j = wallObjective(scores[k + i]); if (j < bestJ - tol) { bestJ = j; best = cands[i]; } }
            k += cands.length;
            if (best !== cands[0]) { perWall.set(fi, best); changed.push(`wall ${fi} ${label(best)}`); }
        }
        return changed;
    };
    {
        options.onProgress?.(`adjusting: each wall's bay lattice and storeys, in parallel`);
        const changed = await perWallGrid((_, a0) => {
            const c: WallLatticeAdjust[] = [];
            for (let ps = 0.88; ps <= 1.1201; ps += 0.02) for (let q = -6; q < 6; q++) c.push({ ...a0, pitchScale: ps, phaseM: (q / 12) * params.bayWidthM * ps });
            return c;
        }, 1e-4, a => `pitch x${a.pitchScale.toFixed(2)} phase ${a.phaseM.toFixed(2)} m`);
        if (options.shapes) changed.push(...await perWallGrid((_, a0) => {
            const c: WallLatticeAdjust[] = [];
            for (let sh = -1.5; sh <= 1.5001; sh += 0.25) for (let sc = 0.9; sc <= 1.1001; sc += 0.025) c.push({ ...a0, storeyShiftM: sh, storeyScale: sc });
            return c;
        }, 2e-3, a => `storeys ${(a.storeyShiftM ?? 0) >= 0 ? '+' : ''}${(a.storeyShiftM ?? 0).toFixed(2)} m x${(a.storeyScale ?? 1).toFixed(3)}`));
        cur = (await scoreFull([{ params, perWall }]))[0];
        out.push({ round: 2, objective: cur.objective, windowNcc: cur.windowNcc, depthMaeM: cur.depthMaeM, changed });
    }
    // (c) coordinate rounds: best-first over all knobs, then each wall's pitch and phase at the round's scale
    const K = knobs(params, !!options.shapes);
    for (let r = 1; r <= rounds; r++) {
        const changed: string[] = [];
        const scale = Math.pow(0.5, r - 1);
        for (let pass = 0; pass < MAX_PASSES; pass++) {
            const cands: Array<Candidate & { what: string }> = [];
            for (const k of K) {
                if (k.enabled && !k.enabled(params)) continue;
                for (const dir of [1, -1]) {
                    const v0 = k.get(params), v = Math.max(k.lo, Math.min(k.hi, v0 + dir * k.step * scale));
                    if (Math.abs(v - v0) < 1e-6) continue;
                    const trial = clone(params);
                    k.set(trial, v);
                    cands.push({ params: trial, perWall, what: `${k.name} ${v0.toFixed(2)}->${v.toFixed(2)}` });
                }
            }
            if (!cands.length) break;
            options.onProgress?.(`adjusting: round ${r} pass ${pass + 1}, ${cands.length} knob trials`);
            const res = await scoreFull(cands);
            let best = -1;
            res.forEach((x, i) => { if (x.objective < (best < 0 ? cur.objective : res[best].objective) - 1e-4) best = i; });
            if (best < 0) break;
            params = cands[best].params; cur = res[best]; changed.push(cands[best].what);
        }
        const sweepsR = facadeProgram({ ...base, params, perWall }).sweeps;
        const pitch = params.bayWidthM;
        const jobs: CompareJob[] = [];
        const index: Array<{ ev: WallEvidence; cands: WallLatticeAdjust[]; what: string[] }> = [];
        for (const ev of evidence) {
            const fi = ev.tile.face.index, a = perWall.get(fi) ?? { pitchScale: 1, phaseM: 0 };
            const cands: WallLatticeAdjust[] = [a], what = [''];
            for (const [field, step] of [['phaseM', pitch * 0.08 * scale], ['pitchScale', 0.01 * scale]] as const) for (const dir of [1, -1]) {
                const next = { ...a, [field]: a[field] + dir * step };
                if (Math.abs(next.phaseM) > pitch / 2 || Math.abs(next.pitchScale - 1) > 0.15) continue;
                cands.push(next); what.push(`wall ${fi} ${field} ${a[field].toFixed(2)}->${next[field].toFixed(2)}`);
            }
            index.push({ ev, cands, what });
            for (const c of cands) jobs.push({ face: fi, rects: wallOnlyRects(base, { params, perWall: new Map(perWall).set(fi, c) }, ev, sweepsR) });
        }
        evaluations += jobs.length;
        const scores = await compare.score(jobs);
        let k = 0;
        for (const { ev, cands, what } of index) {
            let bestJ = wallObjective(scores[k]), best = 0;
            for (let i = 1; i < cands.length; i++) { const j = wallObjective(scores[k + i]); if (j < bestJ - 1e-4) { bestJ = j; best = i; } }
            k += cands.length;
            if (best) { perWall.set(ev.tile.face.index, cands[best]); changed.push(what[best]); }
        }
        cur = (await scoreFull([{ params, perWall }]))[0];
        out.push({ round: 2 + r, objective: cur.objective, windowNcc: cur.windowNcc, depthMaeM: cur.depthMaeM, changed });
        if (!changed.length) break;
    }
    return { params, perWall, rounds: out, evaluations, ms: Date.now() - t0, batches: compare.counts.batches, sentJobs: compare.counts.sent, keptJobs: compare.counts.kept };
}

/**
 * Round 3, step 8: the per-wall lattice and storeys of `walls` searched again on other evidence of those walls (a rectified
 * Street View crop where one exists: sharper than the tile), the rest of the program as adjusted. `compare` holds that
 * evidence. Returns the walls moved and the per-wall objective before and after on the new evidence.
 */
export async function refineWallsNative(base: ProgramInput, params: BuildingParameters, perWall: Map<number, WallLatticeAdjust>, evidence: WallEvidence[], compare: NativeCompare): Promise<{ perWall: Map<number, WallLatticeAdjust>; moved: Array<{ face: number; before: number; after: number; what: string }> }> {
    const outPw = new Map(perWall);
    const sweeps = facadeProgram({ ...base, params, perWall }).sweeps;
    const jobs: CompareJob[] = [];
    const index: Array<{ ev: WallEvidence; cands: WallLatticeAdjust[] }> = [];
    for (const ev of evidence) {
        const fi = ev.tile.face.index, a0 = perWall.get(fi) ?? { pitchScale: 1, phaseM: 0 };
        const cands: WallLatticeAdjust[] = [a0];
        for (let ps = 0.9; ps <= 1.1001; ps += 0.02) for (let q = -6; q < 6; q++) for (const sh of [-0.5, -0.25, 0, 0.25, 0.5]) cands.push({ ...a0, pitchScale: (a0.pitchScale ?? 1) * ps, phaseM: (a0.phaseM ?? 0) + (q / 12) * params.bayWidthM, storeyShiftM: (a0.storeyShiftM ?? 0) + sh });
        index.push({ ev, cands });
        for (const a of cands) jobs.push({ face: fi, rects: wallOnlyRects(base, { params, perWall: new Map(perWall).set(fi, a) }, ev, sweeps) });
    }
    const scores = await compare.score(jobs);
    const moved: Array<{ face: number; before: number; after: number; what: string }> = [];
    let k = 0;
    for (const { ev, cands } of index) {
        const j0 = wallObjective(scores[k]);
        let bestJ = j0, best = 0;
        for (let i = 1; i < cands.length; i++) { const j = wallObjective(scores[k + i]); if (j < bestJ - 2e-3) { bestJ = j; best = i; } }
        k += cands.length;
        if (best) { const a = cands[best]; outPw.set(ev.tile.face.index, a); moved.push({ face: ev.tile.face.index, before: j0, after: bestJ, what: `pitch x${a.pitchScale.toFixed(2)} phase ${a.phaseM.toFixed(2)} m storeys ${(a.storeyShiftM ?? 0) >= 0 ? '+' : ''}${(a.storeyShiftM ?? 0).toFixed(2)} m` }); }
    }
    return { perWall: outPw, moved };
}
