/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Steps, stairs and ramps as geometry, from the scan. The photo tiles melt a flight of steps into a smooth incline, so
 * the inclines are found first: regions of the scan's surface whose gradient is steeper than a street's grade, gentler
 * than a wall, coherent in direction, standing on the terrain (not a roof) and short along their slope (a street on a hill
 * is the road's own). Across each one, cross-sections along its slope on the scan's triangles give its foot and top
 * levels (level ground just past either end, rising as the incline itself does: a wall or a roof past the top is no
 * top), where it starts and ends, and the level runs on it (landings). Where the steps are resolved, the residual of the
 * profile about its own line is periodic: its pitch is the step's run, and the count follows from the measured rise.
 *
 * Where the scan cannot tell the steps apart, a gentle incline (up to 1:8) is a ramp, a plane through the measured slope. A
 * steeper one is a flight the scan melted, and its step count comes from Street View when a counter is given (a view of
 * the flight read by a vision model, in memory only). With no counter, the count is estimated from a plausible rise.
 *
 * The rebuild is one step profile repeated at the measured pitch along the measured slope (operator 3, the replicator):
 * riser, a nosing bevelled by the bevel rule, tread, with landings where the scan shows a level run. The flight's sides
 * are closed down to its foot level. Nothing here names a kind of stair.
 *
 * Labels: the extent, the levels and the slope are measured; each step's rise and run are measured where the scan
 * resolves them, photo-inferred where the count came from Street View, generated (estimated) otherwise; the nosings and
 * the sides are generated.
 */

import type { ScanMesh } from '../../spatial/StreetViewSurveyPlanner';
import { surfaceModel } from '../../spatial/StreetViewSurveyPlanner';
import { frontBevelM, type FootprintTri, type HeightAt } from './road-kerbs';
import type { RoadMeshPart } from './road-surfaces';
import { writeStagedGlbFile } from './staged-glb-writer';

export const GROUND_STEPS_VERSION = 'ground-steps/3';

/** SCRATCHBOX_STAGED_STEPS=1 rebuilds the steps and ramps the scan melted (and carves under them). Off until the user judges it. */
export function groundStepsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STAGED_STEPS?.trim() === '1';
}

export const GROUND_STEPS_PARAMS = {
    /** The surface model the inclines are found on (m). */
    cellM: 0.25,
    /** An incline: its gradient between these (rise over run); a street's grade and crossfall are gentler, a wall steeper. */
    minSlope: 0.06, maxSlope: 1.2,
    /** Neighbouring cells of an incline differ by at most this (m): more is a wall or an object's side. */
    maxCellJumpM: 0.35,
    /** An incline worth rebuilding: at least this area (m²) and rise (m), and this share of its cells sloping its way (within 35
     *  degrees; the cells beside its walls point elsewhere, a dome's or a berm's every way). */
    minAreaM2: 4, minRiseM: 0.3, minCoherence: 0.35,
    /** Its cells at least this share of its median slope. */
    steepShare: 0.5,
    /** Its foot within this of the terrain (m): an inclined roof is no flight. */
    maxFootAboveGroundM: 1.5,
    /** At most this long along its slope (m): longer is a street on a hill, the road's own. */
    maxLengthM: 40,
    /** Cross-sections every this across (m), each read every sectionStepM along, past each end by sectionPastM. */
    sectionSpacingM: 0.75, sectionStepM: 0.03, sectionPastM: 1.5,
    /** A section's foot and top: the walkable ground just past each end of the incline (levelFromM to levelToM past it, the
     *  top up to coverReachM further under a roof), level within levelSpreadM (10th to 90th percentile; a wall beside the
     *  incline, or a street climbing on, is not level), its rise within riseAgreeM or riseAgreeShare of the incline's own
     *  (plus what a run on under a roof adds), and the ends it fits within endSlackM of them. */
    levelFromM: 0.2, levelToM: 0.9, levelSpreadM: 0.12, riseAgreeM: 0.35, riseAgreeShare: 0.35, endSlackM: 1.0,
    /** How far a flight may run on past where the scan's top surface shows it, under a portico's roof or a canopy (m). */
    coverReachM: 6,
    /** An incline at least this wide (m), read on at least minSections sections. */
    minWidthM: 1.2, minSections: 2,
    /** A step: its run and its rise between these (m). */
    minRunM: 0.2, maxRunM: 0.7, minRiseEachM: 0.07, maxRiseEachM: 0.25,
    /** The steps are resolved where the profile's residual repeats at the step's pitch at least this well (its autocorrelation). */
    minPeriodicity: 0.3,
    /** Up to this slope a smooth incline is a ramp; steeper and smooth, a flight the scan melted. */
    rampMaxSlope: 0.125,
    /** A level run of at least this along an incline (m) is a landing, its slope under landingMaxSlope. */
    landingMinM: 1.0, landingMaxSlope: 0.035,
    /** Neither the scan nor Street View gives the count: steps of this rise (estimated, m). */
    estimateRiseM: 0.16,
    /** Melted flights counted on Street View at once. */
    countConcurrency: 4,
    /** The flight's foot: a strip this deep at the foot level in front of the first riser (m), so the carve's rim meets it there. */
    toeM: 0.03
};
export type GroundStepsParams = typeof GROUND_STEPS_PARAMS;

export type StepCountSource = 'measured' | 'photo-inferred' | 'generated';

/** What a step counter answers for one flight: a count and how it was read, or why it could not be. */
export type StepCount = { count: number; views: number; note: string } | { count?: undefined; reason: string };

/** Counts a melted flight's steps from elsewhere (Street View read by a vision model). */
export type StepCounter = (flight: InclineReading) => Promise<StepCount>;

/** One incline as read on the scan: its frame (uphill u, across v about a centre), its extent and its levels. */
export interface InclineReading {
    id: string;
    /** Plan centre, uphill unit and across unit (v = (-uz, ux)). */
    cx: number; cz: number; ux: number; uz: number; vx: number; vz: number;
    /** Along u: where the incline starts (its foot) and ends (its top) (m from the centre). Across v: its extent. */
    sFoot: number; sTop: number; bMin: number; bMax: number;
    /** The levels at its foot and at its top (m). */
    footY: number; topY: number;
    /** (top - foot) / (sTop - sFoot). */
    slope: number;
    /** Level runs on it (from, to along u; their level). */
    landings: Array<{ s0: number; s1: number; y: number }>;
    /** The cross-sections read, and those whose residual repeats at a step's pitch. */
    sections: number; periodic: number;
    /** The resolved pitch: the run and its periodicity (median over the periodic sections). */
    runM?: number; periodicity: number;
    areaM2: number;
}

export interface FlightModel extends InclineReading {
    kind: 'steps' | 'ramp';
    /** Steps: how many risers, and each one's rise and run (between landings, per segment); how the count was found. */
    count?: number; riseM?: number; runEachM?: number;
    countSource?: StepCountSource;
    countNote?: string;
}

function quantile(values: number[], p: number): number {
    if (!values.length) return NaN;
    const s = [...values].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

/** The inclines of a scan: coherent sloped regions on the terrain, short along their slope, off the carriageways. */
export function findInclines(scan: ScanMesh, opts: { groundAt?: (x: number, z: number) => number; exclude?: (x: number, z: number) => boolean } = {}, P: GroundStepsParams = GROUND_STEPS_PARAMS): Array<{ cells: number; areaM2: number; cx: number; cz: number; ux: number; uz: number; coherence: number; xs: Float64Array; zs: Float64Array; lo: number; hi: number }> {
    const cell = P.cellM, g = surfaceModel(scan, cell), { nx, nz, top, x0, z0 } = g;
    const at = (i: number, k: number) => (i < 0 || k < 0 || i >= nx || k >= nz ? NaN : top[k * nx + i]);
    const mask = new Uint8Array(nx * nz), gx = new Float32Array(nx * nz), gz = new Float32Array(nx * nz);
    for (let k = 2; k < nz - 2; k++) for (let i = 2; i < nx - 2; i++) {
        const c = k * nx + i;
        if (!(top[c] === top[c])) continue;
        const dx = (at(i + 2, k) - at(i - 2, k)) / (4 * cell), dz = (at(i, k + 2) - at(i, k - 2)) / (4 * cell), s = Math.hypot(dx, dz);
        if (!(s >= P.minSlope && s <= P.maxSlope)) continue;
        let jump = 0;
        for (const [a, b] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) jump = Math.max(jump, Math.abs(at(i + a, k + b) - top[c]));
        if (!(jump <= P.maxCellJumpM)) continue;
        const x = x0 + (i + 0.5) * cell, z = z0 + (k + 0.5) * cell;
        if (opts.exclude && opts.exclude(x, z)) continue;
        mask[c] = 1; gx[c] = dx; gz[c] = dz;
    }
    const seen = new Uint8Array(nx * nz), out: ReturnType<typeof findInclines> = [];
    for (let c0 = 0; c0 < nx * nz; c0++) {
        if (!mask[c0] || seen[c0]) continue;
        const q = [c0], cells: number[] = [];
        seen[c0] = 1;
        while (q.length) {
            const v = q.pop()!, i = v % nx, k = (v - i) / nx;
            cells.push(v);
            for (const [a, b] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
                const ii = i + a, kk = k + b, n = kk * nx + ii;
                if (ii >= 0 && kk >= 0 && ii < nx && kk < nz && mask[n] && !seen[n]) { seen[n] = 1; q.push(n); }
            }
        }
        if (cells.length * cell * cell < P.minAreaM2) continue;
        // its direction: the mean of the cells' unit gradients; the incline is the cells within 35 degrees of it (a cell whose
        // window reaches a wall beside it points elsewhere), and its coherence their share
        let ux0 = 0, uz0 = 0;
        for (const v of cells) { const m = Math.hypot(gx[v], gz[v]); ux0 += gx[v] / m; uz0 += gz[v] / m; }
        const ul = Math.hypot(ux0, uz0);
        if (!(ul > 0)) continue;
        ux0 /= ul; uz0 /= ul;
        const aligned = cells.filter(v => (gx[v] * ux0 + gz[v] * uz0) / Math.hypot(gx[v], gz[v]) >= Math.cos(35 * Math.PI / 180));
        // and as steep as the incline itself: a street's gentler cells joined to the foot of a flight are not the flight (a
        // uniform ramp keeps them all)
        const slopes = aligned.map(v => Math.hypot(gx[v], gz[v])).sort((a, b) => a - b);
        const medianSlope = slopes.length ? slopes[Math.floor(slopes.length / 2)] : 0;
        const kept = aligned.filter(v => Math.hypot(gx[v], gz[v]) >= P.steepShare * medianSlope);
        const coherence = aligned.length / cells.length, areaM2 = kept.length * cell * cell;
        if (coherence < P.minCoherence || areaM2 < P.minAreaM2) continue;
        let sx = 0, sz = 0, mx = 0, mz = 0, lo = Infinity, hi = -Infinity, footX = 0, footZ = 0;
        const xs = new Float64Array(kept.length), zs = new Float64Array(kept.length);
        kept.forEach((v, j) => {
            const i = v % nx, k = (v - i) / nx;
            xs[j] = x0 + (i + 0.5) * cell; zs[j] = z0 + (k + 0.5) * cell;
            sx += gx[v]; sz += gz[v]; mx += xs[j]; mz += zs[j];
            if (top[v] < lo) { lo = top[v]; footX = xs[j]; footZ = zs[j]; }
            hi = Math.max(hi, top[v]);
        });
        const n = kept.length;
        if (hi - lo < P.minRiseM) continue;
        if (opts.groundAt) { const gnd = opts.groundAt(footX, footZ); if (gnd === gnd && lo - gnd > P.maxFootAboveGroundM) continue; }
        const l = Math.hypot(sx, sz);
        out.push({ cells: n, areaM2, cx: mx / n, cz: mz / n, ux: sx / l, uz: sz / l, coherence, xs, zs, lo, hi });
    }
    return out;
}

/** The residual's autocorrelation at lags within [minRun, maxRun]: the best lag (m) and its correlation. */
function pitchOf(s: number[], r: number[], P: GroundStepsParams): { lag: number; rho: number } {
    const n = r.length, mean = r.reduce((a, b) => a + b, 0) / Math.max(1, n);
    const d = r.map(v => v - mean), var0 = d.reduce((a, b) => a + b * b, 0);
    if (!(var0 > 1e-9) || n < 8) return { lag: NaN, rho: 0 };
    const at = (k: number) => { let c = 0; for (let i = 0; i + k < n; i++) c += d[i] * d[i + k]; return (c / var0) * (n / (n - k)); };
    // a pitch is a peak of the autocorrelation inside the lags a step's run may take: a smooth residual (a ramp's, a lump's)
    // correlates most at the shortest lag tried, which is no pitch
    let best = { lag: NaN, rho: 0 };
    const k0 = Math.max(1, Math.round(P.minRunM / P.sectionStepM)), k1 = Math.min(Math.round(P.maxRunM / P.sectionStepM), n - 5);
    let prev = k0 - 1 >= 1 ? at(k0 - 1) : Infinity, cur = at(k0);
    for (let k = k0; k <= k1; k++) {
        const nextRho = at(k + 1);
        if (cur > prev && cur >= nextRho && cur > best.rho) best = { lag: k * P.sectionStepM, rho: cur };
        prev = cur; cur = nextRho;
    }
    // the first strong peak, not a multiple of it: a lag half the best with nearly its correlation is the pitch
    const half = Math.round(best.lag / 2 / P.sectionStepM);
    if (best.lag === best.lag && half * P.sectionStepM >= P.minRunM) {
        let c = 0;
        for (let i = 0; i + half < n; i++) c += d[i] * d[i + half];
        const rho = (c / var0) * (n / (n - half));
        if (rho >= 0.85 * best.rho) best = { lag: half * P.sectionStepM, rho };
    }
    void s;
    return best;
}

/** Reads one incline across: its foot and top levels and positions, landings, and the step's pitch where the scan resolves it. */
export function readIncline(id: string, inc: ReturnType<typeof findInclines>[number], h: HeightAt, P: GroundStepsParams = GROUND_STEPS_PARAMS): InclineReading | undefined {
    const ux = inc.ux, uz = inc.uz, vx = -uz, vz = ux;
    // its extent along and across, from the 2nd to the 98th percentile of its cells (a stray cell beside a wall is no extent)
    const as: number[] = [], bs: number[] = [];
    for (let j = 0; j < inc.xs.length; j++) { const dx = inc.xs[j] - inc.cx, dz = inc.zs[j] - inc.cz; as.push(dx * ux + dz * uz); bs.push(dx * vx + dz * vz); }
    const a0 = quantile(as, 0.02), a1 = quantile(as, 0.98), b0 = quantile(bs, 0.02) - P.cellM, b1 = quantile(bs, 0.98) + P.cellM;
    // its width: the cells' centres across, and one cell
    if (a1 - a0 > P.maxLengthM || quantile(bs, 0.98) - quantile(bs, 0.02) + P.cellM < P.minWidthM) return undefined;
    const ownRise = inc.hi - inc.lo;
    type Sec = { b: number; sFoot: number; sTop: number; foot: number; top: number; slope: number; lag: number; rho: number; s: number[]; h: number[] };
    const secs: Sec[] = [];
    const nb = Math.max(1, Math.floor((b1 - b0) / P.sectionSpacingM));
    for (let q = 0; q < nb; q++) {
        const b = nb === 1 ? (b0 + b1) / 2 : b0 + (b1 - b0) * (q + 0.5) / nb;
        // the walkable surface along the section: before the foot the surface nearest the foot's level, on the incline the
        // scan's top surface (where it was found; a sheet the scan has under a stair is not it), past it the surface nearest
        // the last sample, so a flight is read on under a portico's roof or a canopy; a jump of more than a riser (a wall, a
        // roof) is a gap
        const s: number[] = [], hs: number[] = [];
        let last = NaN;
        for (let a = a0 - P.sectionPastM; a <= a1 + P.sectionPastM + P.coverReachM + 1e-9; a += P.sectionStepM) {
            const x = inc.cx + ux * a + vx * b, z = inc.cz + uz * a + vz * b;
            const y = a < a0 ? h(x, z, inc.lo) : a <= a1 || !(last === last) ? h(x, z) : h(x, z, last);
            if (!(y === y) || (last === last && Math.abs(y - last) > P.maxRiseEachM + 0.1)) continue;
            s.push(a); hs.push(y); last = y;
        }
        const level = (from: number, to: number) => {
            const w = hs.filter((_, i) => s[i] >= from && s[i] <= to);
            return w.length >= 5 && quantile(w, 0.9) - quantile(w, 0.1) <= P.levelSpreadM ? quantile(w, 0.5) : NaN;
        };
        // the foot: level ground just before the incline; the top: the first level ground past where the incline still rose on
        // the scan's top surface (a1), within coverReachM more where it goes on under a roof
        const foot = level(a0 - P.levelToM, a0 - P.levelFromM);
        const win = P.levelToM - P.levelFromM;
        let top = NaN, topAt = NaN;
        for (let a = a1 + P.levelFromM; a <= a1 + P.levelFromM + P.coverReachM + 1e-9; a += 0.1) {
            const y = level(a, a + win);
            if (y === y && y > foot + P.minRiseM) { top = y; topAt = a; break; }
        }
        if (!(foot === foot) || !(top === top)) continue;
        const rise = top - foot, under = Math.max(0, topAt - (a1 + P.levelFromM));
        // its rise is the incline's own, more only by what the run on under a roof adds at the incline's own slope
        const ownSlope = ownRise / Math.max(0.5, a1 - a0), slack = Math.max(P.riseAgreeM, P.riseAgreeShare * ownRise);
        if (!(rise >= P.minRiseM) || rise < ownRise - slack || rise > ownRise + slack + 1.2 * ownSlope * under) continue;
        // the incline's line, through its middle 80 % of rise
        const mid = s.map((v, i) => [v, hs[i]]).filter(([, y]) => y > foot + 0.1 * rise && y < top - 0.1 * rise);
        if (mid.length < 6) continue;
        const ms = mid.reduce((t, p) => t + p[0], 0) / mid.length, my = mid.reduce((t, p) => t + p[1], 0) / mid.length;
        const sss = mid.reduce((t, p) => t + (p[0] - ms) ** 2, 0), beta = sss > 0 ? mid.reduce((t, p) => t + (p[0] - ms) * (p[1] - my), 0) / sss : 0;
        // an incline on this section, not a wall's single step beside it: sloped like one and at least half a metre long
        if (!(beta >= P.minSlope && beta <= P.maxSlope)) continue;
        const sFoot = ms + (foot - my) / beta, sTop = ms + (top - my) / beta;
        if (!(sTop - sFoot >= 0.5) || sFoot < a0 - P.endSlackM || sTop > topAt + P.endSlackM) continue;
        // the residual about the line inside the incline: a staircase the scan resolves repeats at the step's pitch
        const inner = s.map((v, i) => i).filter(i => s[i] > sFoot + 0.1 * (sTop - sFoot) && s[i] < sTop - 0.1 * (sTop - sFoot));
        const { lag, rho } = pitchOf(inner.map(i => s[i]), inner.map(i => hs[i] - (my + beta * (s[i] - ms))), P);
        secs.push({ b, sFoot, sTop, foot, top, slope: beta, lag, rho, s, h: hs });
    }
    if (!secs.length) return undefined;
    // the sections of one incline agree on its slope: one far off it crosses something else
    const midSlope = quantile(secs.map(x => x.slope), 0.5);
    for (let i = secs.length - 1; i >= 0; i--) if (Math.abs(secs[i].slope - midSlope) > 0.4 * midSlope) secs.splice(i, 1);
    if (secs.length < P.minSections) return undefined;
    const med = (f: (x: Sec) => number) => quantile(secs.map(f), 0.5);
    const sFoot = med(x => x.sFoot), sTop = med(x => x.sTop), footY = med(x => x.foot), topY = med(x => x.top);
    if (!(sTop - sFoot > 0.2)) return undefined;
    const periodic = secs.filter(x => x.rho >= P.minPeriodicity && x.lag === x.lag);
    const runM = periodic.length * 2 > secs.length ? quantile(periodic.map(x => x.lag), 0.5) : undefined;
    // landings: on the median profile (smoothed over 0.5 m), level runs inside the incline
    const grid: number[] = [];
    for (let a = sFoot; a <= sTop + 1e-9; a += 0.1) grid.push(a);
    const profile = grid.map(a => quantile(secs.map(x => { let best = NaN, bd = Infinity; for (let i = 0; i < x.s.length; i++) { const d = Math.abs(x.s[i] - a); if (d < bd) { bd = d; best = x.h[i]; } } return best; }).filter(v => v === v), 0.5));
    const smooth = profile.map((_, i) => { const w = profile.slice(Math.max(0, i - 2), i + 3).filter(v => v === v); return w.reduce((t, v) => t + v, 0) / Math.max(1, w.length); });
    const landings: InclineReading['landings'] = [];
    let start = -1;
    for (let i = 1; i <= smooth.length; i++) {
        const level = i < smooth.length && Math.abs(smooth[i] - smooth[i - 1]) / 0.1 < P.landingMaxSlope;
        if (level && start < 0) start = i - 1;
        if (!level && start >= 0) {
            // its ends widened back by the smoothing's half-window, which blurred them inward
            const s0 = grid[start] - 0.15, s1 = grid[i - 1] + 0.15;
            // inside the incline, not its foot or its top
            if (s1 - s0 >= P.landingMinM && s0 > sFoot + 0.3 && s1 < sTop - 0.3) landings.push({ s0, s1, y: quantile(smooth.slice(start, i), 0.5) });
            start = -1;
        }
    }
    const b = secs.map(x => x.b), half = (b1 - b0) / nb / 2;
    return {
        id, cx: inc.cx, cz: inc.cz, ux, uz, vx, vz, sFoot, sTop, bMin: Math.max(b0, Math.min(...b) - half), bMax: Math.min(b1, Math.max(...b) + half),
        footY, topY, slope: (topY - footY) / (sTop - sFoot), landings, sections: secs.length, periodic: periodic.length,
        ...(runM !== undefined ? { runM } : {}), periodicity: quantile(secs.map(x => x.rho), 0.5), areaM2: inc.areaM2
    };
}

/** What each incline is: steps (counted from the scan, Street View, or an estimate) or a ramp. */
export async function modelFlight(r: InclineReading, counter: StepCounter | undefined, P: GroundStepsParams = GROUND_STEPS_PARAMS): Promise<FlightModel> {
    const rise = r.topY - r.footY;
    const stepped = (r.sTop - r.sFoot) - r.landings.reduce((t, l) => t + (l.s1 - l.s0), 0);
    const finish = (count: number, countSource: StepCountSource, countNote: string): FlightModel => {
        const n = Math.max(1, count);
        return { ...r, kind: 'steps', count: n, riseM: rise / n, runEachM: stepped / n, countSource, countNote };
    };
    // the scan resolves the steps: the pitch is measured, and the count follows from the measured rise
    if (r.runM !== undefined) {
        const each = r.slope * r.runM, count = Math.round(rise / each);
        if (each >= P.minRiseEachM && each <= P.maxRiseEachM && count >= 1) return finish(count, 'measured', `the scan resolves the steps: a ${(r.runM * 100).toFixed(0)} cm pitch repeats on ${r.periodic} of ${r.sections} cross-sections`);
    }
    if (r.slope <= P.rampMaxSlope) return { ...r, kind: 'ramp' };
    // a flight the scan melted: counted from Street View, else estimated from a plausible rise; an estimate whose treads would be
    // longer than a step's is no flight anyone measured: the incline is drawn as the slope the scan measures
    const estimate = (why: string): FlightModel => {
        const n = Math.max(1, Math.round(rise / P.estimateRiseM));
        return stepped / n > P.maxRunM ? { ...r, kind: 'ramp' } : finish(n, 'generated', why);
    };
    if (counter) {
        const got = await counter(r);
        if (got.count !== undefined) {
            const each = rise / got.count;
            if (each >= P.minRiseEachM && each <= P.maxRiseEachM) return finish(got.count, 'photo-inferred', `${got.count} steps counted on ${got.views} Street View view${got.views === 1 ? '' : 's'} (${got.note}); the scan melts them into a ${(Math.atan(r.slope) * 180 / Math.PI).toFixed(0)}-degree incline`);
            return estimate(`Street View counted ${got.count} steps, a ${(each * 100).toFixed(0)} cm rise each, outside ${P.minRiseEachM * 100}-${P.maxRiseEachM * 100} cm: estimated at a ${P.estimateRiseM * 100} cm rise instead`);
        }
        return estimate(`the scan melts the steps and Street View gave no count (${got.reason}): estimated at a ${P.estimateRiseM * 100} cm rise`);
    }
    return estimate(`the scan melts the steps and no Street View count was asked: estimated at a ${P.estimateRiseM * 100} cm rise`);
}

// ---------------------------------------------------------------------------------------------------------------------
// the rebuild
// ---------------------------------------------------------------------------------------------------------------------

/** The parts the rebuild draws, each its own node with its own label. */
export type StepPart = 'riser' | 'tread' | 'nosing' | 'landing' | 'ramp' | 'side' | 'toe';

class Builder {
    positions: number[] = []; indices: number[] = [];
    vertex(p: [number, number, number]): number { this.positions.push(p[0], p[1], p[2]); return this.positions.length / 3 - 1; }
    /** A quad a b c d (in order round it), each triangle wound to face `want`. */
    quad(a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number], want: [number, number, number]): void {
        const ia = this.vertex(a), ib = this.vertex(b), ic = this.vertex(c), id = this.vertex(d);
        for (const [i, j, k] of [[ia, ib, ic], [ia, ic, id]]) {
            const P = this.positions, ux = P[j * 3] - P[i * 3], uy = P[j * 3 + 1] - P[i * 3 + 1], uz = P[j * 3 + 2] - P[i * 3 + 2];
            const vx = P[k * 3] - P[i * 3], vy = P[k * 3 + 1] - P[i * 3 + 1], vz = P[k * 3 + 2] - P[i * 3 + 2];
            const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
            if (!(Math.hypot(n[0], n[1], n[2]) > 1e-10)) continue;
            if (n[0] * want[0] + n[1] * want[1] + n[2] * want[2] >= 0) this.indices.push(i, j, k); else this.indices.push(i, k, j);
        }
    }
    part(): RoadMeshPart {
        // planar texture coordinates (x, z) are set by the caller's frame
        return { positions: Float32Array.from(this.positions), indices: Uint32Array.from(this.indices), uv: new Float32Array(this.positions.length / 3 * 2) };
    }
}

export interface StepsMesh {
    parts: Map<string, RoadMeshPart>;
    footprint: FootprintTri[];
    stats: { flights: number; ramps: number; steps: number; triangles: number; footprintM2: number };
}

/**
 * The rebuild: per flight one step profile (riser, bevelled nosing, tread) repeated at its pitch from the foot level to the
 * top (operator 3), split at its landings; per ramp a plane through its measured slope; each closed down to its foot level
 * at its sides. Planar texture coordinates into `uvFrame` when given.
 */
export function buildStepsMesh(flights: FlightModel[], P: GroundStepsParams = GROUND_STEPS_PARAMS, uvFrame?: { x0: number; z0: number; widthM: number; heightM: number }): StepsMesh {
    const parts = new Map<string, Builder>();
    const partOf = (part: StepPart, label: string) => { const k = `${part}:${label}`; let b = parts.get(k); if (!b) parts.set(k, b = new Builder()); return b; };
    const footprint: FootprintTri[] = [];
    let footprintM2 = 0, steps = 0;
    for (const f of flights) {
        const at = (s: number, b: number, y: number): [number, number, number] => [f.cx + f.ux * s + f.vx * b, y, f.cz + f.uz * s + f.vz * b];
        const up: [number, number, number] = [0, 1, 0], down: [number, number, number] = [-f.ux, 0, -f.uz];
        const b0 = f.bMin, b1 = f.bMax;
        // a level or sloped strip from s0 to s1 (levels y0, y1) across the flight: drawn, and its plan given to the carve
        const strip = (part: StepPart, label: string, s0: number, s1: number, y0: number, y1: number) => {
            if (!(s1 - s0 > 1e-6)) return;
            const a = at(s0, b0, y0), b = at(s0, b1, y0), c = at(s1, b1, y1), d = at(s1, b0, y1);
            partOf(part, label).quad(a, b, c, d, up);
            footprint.push([...a, ...b, ...c] as FootprintTri, [...a, ...c, ...d] as FootprintTri);
            footprintM2 += (s1 - s0) * (b1 - b0);
        };
        const face = (part: StepPart, label: string, s: number, y0: number, y1: number) => {
            if (!(y1 - y0 > 1e-6)) return;
            partOf(part, label).quad(at(s, b0, y0), at(s, b1, y0), at(s, b1, y1), at(s, b0, y1), down);
        };
        // the sides, closed down to the foot level under each tread
        const sides = (s0: number, s1: number, y0: number, y1: number) => {
            for (const [b, out] of [[b0, -1], [b1, 1]] as const) {
                if (!(Math.max(y0, y1) - f.footY > 1e-6) || !(s1 - s0 > 1e-6)) continue;
                partOf('side', 'generated').quad(at(s0, b, f.footY), at(s1, b, f.footY), at(s1, b, y1), at(s0, b, y0), [f.vx * out, 0, f.vz * out]);
            }
        };
        if (f.kind === 'ramp') {
            strip('ramp', 'measured', f.sFoot, f.sTop, f.footY, f.topY);
            sides(f.sFoot, f.sTop, f.footY, f.topY);
            continue;
        }
        const label = f.countSource ?? 'generated';
        // the flight's segments between landings: each its share of the count by its rise, at its own pitch
        const marks = [{ s: f.sFoot, y: f.footY }, ...f.landings.flatMap(l => [{ s: l.s0, y: l.y }, { s: l.s1, y: l.y }]), { s: f.sTop, y: f.topY }];
        const rise = f.topY - f.footY, total = f.count ?? Math.max(1, Math.round(rise / P.estimateRiseM));
        // the bevel rule: 1.5 % of the flight's smallest dimension (its rise, its length, its width), 1-5 cm
        const bevel = frontBevelM(Math.min(rise, f.sTop - f.sFoot, b1 - b0));
        strip('toe', 'generated', f.sFoot - P.toeM, f.sFoot, f.footY, f.footY);
        let left = total;
        for (let m = 0; m + 1 < marks.length; m += 2) {
            const a = marks[m], z = marks[m + 1], segRise = z.y - a.y;
            const isLast = m + 2 >= marks.length - 1;
            const n = isLast ? left : Math.max(1, Math.min(left - 1, Math.round(total * segRise / rise)));
            left -= n;
            const r = segRise / n, run = (z.s - a.s) / n, e = Math.min(bevel, r / 2, run / 2);
            for (let k = 0; k < n; k++) {
                // one step, the profile repeated at the pitch (run, r): riser, nosing, tread
                const s = a.s + k * run, y = a.y + k * r;
                face('riser', label, s, y, y + r - e);
                strip('nosing', 'generated', s, s + e, y + r - e, y + r);
                strip('tread', label, s + e, s + run, y + r, y + r);
                sides(s, s + run, y + r, y + r);
                steps++;
            }
            // the landing after this segment (when there is one)
            if (m + 2 < marks.length - 1) { const l = marks[m + 1], l2 = marks[m + 2]; strip('landing', 'measured', l.s, l2.s, l.y, l2.y); sides(l.s, l2.s, l.y, l2.y); }
        }
    }
    const out = new Map<string, RoadMeshPart>();
    let triangles = 0;
    for (const [k, b] of parts) {
        const p = b.part();
        if (!p.indices.length) continue;
        if (uvFrame) for (let i = 0; i * 3 < p.positions.length; i++) { p.uv[i * 2] = (p.positions[i * 3] - uvFrame.x0) / uvFrame.widthM; p.uv[i * 2 + 1] = (p.positions[i * 3 + 2] - uvFrame.z0) / uvFrame.heightM; }
        out.set(k, p);
        triangles += p.indices.length / 3;
    }
    return { parts: out, footprint, stats: { flights: flights.filter(f => f.kind === 'steps').length, ramps: flights.filter(f => f.kind === 'ramp').length, steps, triangles, footprintM2: Math.round(footprintM2 * 10) / 10 } };
}

/** Why each part carries its label (GLB extras and the layer's note). */
export const STEP_PART_METHOD: Record<string, string> = {
    'riser:measured': "a riser of the step the scan resolves: its rise from the flight's measured rise over the count its measured pitch gives",
    'tread:measured': 'a tread at the pitch the scan resolves (the replicated step profile)',
    'riser:photo-inferred': "a riser at the rise the Street View count gives over the flight's measured rise",
    'tread:photo-inferred': "a tread at the run the Street View count gives over the flight's measured length",
    'riser:generated': 'a riser at a plausible rise (no count was resolved by the scan or Street View): estimated',
    'tread:generated': 'a tread at the run that estimate gives: estimated',
    'nosing:generated': "a 45-degree chamfer on the step's front edge, 1.5 % of the flight's smallest dimension clamped to 1-5 cm",
    'landing:measured': 'a landing where the scan shows a level run on the incline',
    'ramp:measured': 'a ramp: a plane through the measured foot, top and slope',
    'side:generated': "the flight's sides closed down to its foot level",
    'toe:generated': "a 3 cm strip at the foot level before the first riser, where the scan's rim meets the flight"
};

/** Writes the steps and ramps as a staged GLB: one node per part and label, planar texture coordinates into `texture`. */
export function writeStepsGlb(file: string, mesh: StepsMesh, extras: Record<string, unknown>, texture?: { jpeg: Buffer; width: number; height: number }): { path: string; bytes: number } {
    const nodes = [...mesh.parts].map(([key, p]) => {
        const [part, label] = key.split(':');
        return { name: `${part}_${label}`, positions: p.positions, indices: p.indices, ...(texture ? { uv: p.uv } : {}), extras: { ...extras, part, provenance: label, method: STEP_PART_METHOD[key] ?? '' } };
    });
    return writeStagedGlbFile(file, nodes, {
        rootExtras: { sbSteps: { ...extras, version: GROUND_STEPS_VERSION, ...(texture ? { texture: { source: 'the tile photo seen from above', width: texture.width, height: texture.height } } : {}) } },
        generator: 'scratchbox staged-location ground-steps',
        ...(texture ? { texture: { bytes: texture.jpeg, mimeType: 'image/jpeg' } } : {})
    });
}

/** Finds, reads and models every incline of a scan. */
export async function measureSteps(scan: ScanMesh, h: HeightAt, opts: { groundAt?: (x: number, z: number) => number; exclude?: (x: number, z: number) => boolean; counter?: StepCounter } = {}, P: GroundStepsParams = GROUND_STEPS_PARAMS): Promise<{ flights: FlightModel[]; inclines: number; refused: Array<{ id: string; reason: string }> }> {
    const inclines = findInclines(scan, opts, P);
    const readings: InclineReading[] = [], refused: Array<{ id: string; reason: string }> = [];
    for (let i = 0; i < inclines.length; i++) {
        const id = `incline_${i}`;
        const r = readIncline(id, inclines[i], h, P);
        if (!r) { refused.push({ id, reason: 'not a flight: no two cross-sections show level ground at its foot and top that rise as the incline itself does, or it is narrower or longer than a flight' }); continue; }
        readings.push(r);
    }
    // the counts asked a few flights at a time (each waits on Street View and a model), in the readings' order
    const flights: FlightModel[] = new Array(readings.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(P.countConcurrency, readings.length) }, async () => {
        while (next < readings.length) { const j = next++; flights[j] = await modelFlight(readings[j], opts.counter, P); }
    }));
    return { flights, inclines: inclines.length, refused };
}
