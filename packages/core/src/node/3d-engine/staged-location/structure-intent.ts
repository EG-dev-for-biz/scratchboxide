/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The exterior's design intent, inferred from what the capture read: the blueprint and the material ID map are drawn
 * from this, not from the readings directly. The capture is a partial, noisy view of a designed thing (windows smeared,
 * occluded, foreshortened, unread where the photo never reached); the intent is what the designer laid out.
 *
 * Reasoning like a builder, per facade:
 *  1. Regions. A facade is split bottom to top into bands where its window rows change pattern (a row's columns, their
 *     widths and its window height): a base, a shaft, a crown each read as its own band. A band with no windows is a
 *     region too (a blank wall, a parapet).
 *  2. Organisation, decided per band from evidence, never assumed:
 *     - repetition: the band's window columns sit on one pitch (consensus over every gap; a share of columns on the
 *       lattice) and its rows on one storey pitch. Then every lattice site inside the band's extent holds the module
 *       (sites the capture missed are inferred from the repeat), every window at the module's size.
 *     - symmetry: the band's windows mirror about the facade's axis (pipeline K's symmetry reading, a detected,
 *       non-periodic mirror) or about the band's own centre, at least mirrorShare of them landing on a window. Then each
 *       pair is averaged and an unpaired window gains its mirror (inferred from the mirror).
 *     - neither: the windows stand as read, nothing added or moved (a one-off entrance, an irregular crown). This is an
 *       answer, not a failure.
 *  3. Across facades: two facades the symmetry reading accepted as twins (one maps onto the other by the plan's mirror
 *     or rotation at an NCC the repeat gate passes) are one design: where they agree on what both read (agreeShare of the
 *     poorer one's windows matched), each takes the other's windows where it read none (inferred from the twin).
 *  4. Families. Windows of one size (within moduleTol) on one facade are one family; repeats, mirrors and twins share
 *     their source's family, so the material ID map gives them one material.
 * Every element carries its provenance (measured: read by the capture; repeat, mirror, twin: inferred, with the region's
 * decision and score) and every region its decision with the scores that made it.
 */

import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import type { SymmetryReport, PlanTransform } from './pipeline-k/symmetry';

type Rect = [number, number, number, number];

export interface IntentFacadeInput {
    facadeId: number;
    frame: { centroid: Vec3; normal: Vec3; axisS: Vec3; axisT: Vec3; orthoSMin: number; orthoTMax: number; pixel: number; width: number; height: number };
    /** Windows as read, in the facade photo's pixels [x0, y0, x1, y1], y down. */
    rects: Rect[];
    panes?: Rect[];
}

export type IntentSource = 'measured' | 'repeat' | 'mirror' | 'twin';
export type RegionDecision = 'repeat' | 'symmetric' | 'neither' | 'blank';

export interface IntentWindow { rect: Rect; panes: number; source: IntentSource; family: number; region: number }
export interface IntentRegion {
    /** The band, in the facade photo's pixel rows. */
    y0: number; y1: number;
    decision: RegionDecision;
    /** Share of the band's columns and rows on their lattice (0 when too few to judge), and of its windows whose mirror lands on a window. */
    scores: { columns: number; rows: number; mirror: number };
    pitchPx?: [number, number]; axisPx?: number;
    readWindows: number; added: number;
    reason: string;
}
export interface IntentFacade { facadeId: number; regions: IntentRegion[]; windows: IntentWindow[]; families: Array<{ id: number; w: number; h: number; panes: number }>; twinsFrom: number[] }
export interface StructureIntent { version: string; params: IntentParams; facades: IntentFacade[]; /** The building's storey (world y, m): one floor-to-floor height and a datum every repeating band's rows sit on when they agree. */ storey?: { pitchM: number; datumY: number; bands: number; snapped: number }; twins: Array<{ a: number; b: number; agree: number; used: boolean; reason: string }> }

export const STRUCTURE_INTENT_PARAMS = {
    /** Window centres within this share of the median window's size are one column (or row). */
    moduleTol: 0.35,
    /** Two consecutive rows are one band when the smaller one's columns are mostly (bandOverlap) the larger one's (a window the capture missed does not make a new band) and their heights differ by under bandHeightTol. */
    bandOverlap: 0.6, bandHeightTol: 0.25,
    /** A band repeats along an axis when at least latticeShare of its columns (rows) fall within latticeTol of the pitch's sites, over at least minRepeat of them, and they hold at least latticeOccupancy of the sites between the first and the last. */
    latticeShare: 0.75, latticeTol: 0.12, minRepeat: 3, latticeOccupancy: 0.6,
    /** A band is symmetric when at least mirrorShare of its windows (3 or more) mirror onto a window (IoU >= mirrorIoU). */
    mirrorShare: 0.7, mirrorIoU: 0.4,
    /** The facade's own axis (pipeline K's reading) is used at this NCC or more. */
    facadeAxisNcc: 0.75,
    /** Twins share windows when they agree on at least agreeShare of the poorer one's windows (3 or more). */
    agreeShare: 0.6,
    /** The building's storey: the row pitch (m) carrying the most repeating bands' rows, its datum their weighted phase; a band whose own row pitch is within storeyTol of it takes it (its rows on the building's floor lines). */
    storeyTol: 0.08,
    /** An opening at least stripHeights x the median window's height is a strip (split into its stacked panes when it has them); a window has at most maxPanes side by side. */
    stripHeights: 3, maxPanes: 8
};
export type IntentParams = typeof STRUCTURE_INTENT_PARAMS;
export const STRUCTURE_INTENT_VERSION = 'structure-intent/1';

const med = (v: number[]) => { const a = [...v].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
export const rectIoU = (a: number[], b: number[]) => { const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])), i = ix * iy; return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i || 1); };

/** Cluster values: sorted, a new cluster where the gap exceeds `gap`. Returns each value's cluster id and the clusters' means. */
function cluster1(vals: number[], gap: number): { id: number[]; at: number[] } {
    const order = vals.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]), id = new Array<number>(vals.length), sums: number[][] = [];
    let k = -1, last = -Infinity;
    for (const [v, i] of order) { if (v - last > gap) { k++; sums.push([]); } id[i] = k; sums[k].push(v); last = v; }
    return { id, at: sums.map(mean) };
}

/**
 * The lattice positions sit on: the pitch (the median of the gaps no larger than 1.6 x the smallest clear gap, refined by
 * least squares over every position's index) and the share of positions within tol x pitch of a site. Undefined with
 * fewer than minRepeat positions.
 */
export function fitLattice(pos: number[], tol: number, minRepeat: number): { pitch: number; phase: number; share: number; first: number; last: number } | undefined {
    const p = [...pos].sort((a, b) => a - b);
    if (p.length < minRepeat) return undefined;
    const gaps = p.slice(1).map((v, i) => v - p[i]).filter(g => g > 1e-6);
    if (!gaps.length) return undefined;
    const g0 = med(gaps.filter(g => g <= 1.6 * Math.min(...gaps)));
    if (!(g0 > 0)) return undefined;
    // index every position by its distance from the first in pitches; least squares on (index, position)
    const idx = p.map(v => Math.round((v - p[0]) / g0));
    const n = p.length, si = idx.reduce((a, b) => a + b, 0), sp = p.reduce((a, b) => a + b, 0), sii = idx.reduce((a, b) => a + b * b, 0), sip = idx.reduce((a, b, i) => a + b * p[i], 0);
    const den = n * sii - si * si;
    const pitch = den > 0 ? (n * sip - si * sp) / den : g0, phase = den > 0 ? (sp - pitch * si) / n : p[0];
    if (!(pitch > 0)) return undefined;
    const on = p.filter(v => { const k = Math.round((v - phase) / pitch); return Math.abs(v - (phase + k * pitch)) <= tol * pitch; }).length;
    return { pitch, phase, share: on / n, first: Math.round((p[0] - phase) / pitch), last: Math.round((p[n - 1] - phase) / pitch) };
}

/** The share of `rects` whose mirror about x = axis lands on one of them (IoU >= iou); a window standing on the axis is its own mirror. */
export function mirrorShare(rects: Rect[], axis: number, iou: number): number {
    if (!rects.length) return 0;
    let hit = 0;
    for (const r of rects) { const m: Rect = [2 * axis - r[2], r[1], 2 * axis - r[0], r[3]]; if (rects.some(o => rectIoU(o, m) >= iou)) hit++; }
    return hit / rects.length;
}

/** The world height of a facade pixel row (y down from the photo's top). */
const rowToY = (f: IntentFacadeInput['frame'], y: number) => f.centroid[1] + (f.orthoTMax - y * f.pixel) * f.axisT[1];
const yToRow = (f: IntentFacadeInput['frame'], wy: number) => (f.orthoTMax - (wy - f.centroid[1]) / (f.axisT[1] || 1)) / f.pixel;

/** Each repeating band's rows (pitch in m, phase as a world height) over the whole building: the pitch the most rows carry, within tol, its datum the rows' weighted phase. */
export function buildingStorey(rows: Array<{ pitchM: number; phaseY: number; rows: number }>, tol: number): { pitchM: number; datumY: number; bands: number } | undefined {
    const ok = rows.filter(r => r.pitchM > 2 && r.pitchM < 8 && r.rows >= 3);
    let best: { pitchM: number; datumY: number; bands: number; w: number } | undefined;
    for (const c of ok) {
        const near = ok.filter(o => Math.abs(o.pitchM - c.pitchM) <= tol * c.pitchM), w = near.reduce((a, o) => a + o.rows, 0);
        if (best && w <= best.w) continue;
        const pitch = near.reduce((a, o) => a + o.pitchM * o.rows, 0) / w;
        // the datum: circular mean of the phases modulo the pitch
        let cx = 0, cy = 0; for (const o of near) { const a = (2 * Math.PI * o.phaseY) / pitch; cx += o.rows * Math.cos(a); cy += o.rows * Math.sin(a); }
        best = { pitchM: pitch, datumY: (((Math.atan2(cy, cx) / (2 * Math.PI)) * pitch) % pitch + pitch) % pitch, bands: near.length, w };
    }
    return best && best.bands >= 2 ? { pitchM: best.pitchM, datumY: best.datumY, bands: best.bands } : undefined;
}

/**
 * A strip (an opening several windows tall) whose panes stack one above another is a column of windows: each pane is a
 * window (as read). Panes side by side stay a window's mullions; a strip with no stacked panes stays one opening.
 */
export function splitStrips(rects: Rect[], panes: Rect[] | undefined, P: IntentParams): Rect[] {
    const ok = rects.filter(r => r[2] > r[0] && r[3] > r[1]);
    if (!ok.length) return ok;
    const mh = med(ok.map(r => r[3] - r[1]));
    return ok.flatMap(r => {
        if (r[3] - r[1] < P.stripHeights * mh || !panes?.length) return [r];
        const w = r[2] - r[0];
        const stacked = panes.filter(p => p[0] >= r[0] - 0.1 * w && p[2] <= r[2] + 0.1 * w && p[1] >= r[1] - 1 && p[3] <= r[3] + 1 && p[2] - p[0] >= 0.6 * w && p[3] - p[1] < 0.5 * (r[3] - r[1]));
        return stacked.length >= 3 ? stacked.map(p => [Math.max(r[0], p[0]), p[1], Math.min(r[2], p[2]), p[3]] as Rect) : [r];
    });
}

function infer(fc: IntentFacadeInput, axisPx: number | undefined, P: IntentParams, storey?: { pitchM: number; datumY: number }, onSnap?: () => void): IntentFacade {
    const R = splitStrips(fc.rects, fc.panes, P);
    const out: IntentFacade = { facadeId: fc.facadeId, regions: [], windows: [], families: [], twinsFrom: [] };
    if (!R.length) { out.regions.push({ y0: 0, y1: fc.frame.height, decision: 'blank', scores: { columns: 0, rows: 0, mirror: 0 }, readWindows: 0, added: 0, reason: 'no windows read on this facade: a blank wall, or a wall the capture never resolved; nothing inferred' }); return out; }
    const mw = med(R.map(r => r[2] - r[0])), mh = med(R.map(r => r[3] - r[1]));
    const cols = cluster1(R.map(r => (r[0] + r[2]) / 2), P.moduleTol * mw), rows = cluster1(R.map(r => (r[1] + r[3]) / 2), P.moduleTol * mh);
    // a window's mullions: the panes lying in it side by side (each at least 60% of its height); stacked panes are windows of their own (splitStrips)
    const panesIn = (r: Rect) => Math.min(P.maxPanes, Math.max(1, (fc.panes ?? []).filter(p => p[3] - p[1] >= 0.6 * (r[3] - r[1]) && Math.max(0, Math.min(r[2], p[2]) - Math.max(r[0], p[0])) * Math.max(0, Math.min(r[3], p[3]) - Math.max(r[1], p[1])) >= 0.6 * Math.max(1e-9, (p[2] - p[0]) * (p[3] - p[1]))).length));
    // rows bottom to top would read naturally; the photo's y is down, so walk rows by y and band consecutive similar rows
    const rowIds = rows.at.map((_, q) => q).sort((a, b) => rows.at[a] - rows.at[b]);
    const rowCols = new Map<number, Set<number>>(), rowH = new Map<number, number>();
    for (const q of rowIds) { const mine = R.map((_, i) => i).filter(i => rows.id[i] === q); rowCols.set(q, new Set(mine.map(i => cols.id[i]))); rowH.set(q, med(mine.map(i => R[i][3] - R[i][1]))); }
    const bands: number[][] = [];
    for (const q of rowIds) {
        const b = bands[bands.length - 1], prev = b?.[b.length - 1];
        if (b && prev !== undefined) {
            const A = rowCols.get(prev)!, B = rowCols.get(q)!, inter = [...A].filter(c => B.has(c)).length, uni = Math.min(A.size, B.size);
            const hA = rowH.get(prev)!, hB = rowH.get(q)!;
            if (inter / uni >= P.bandOverlap && Math.abs(hA - hB) <= P.bandHeightTol * Math.max(hA, hB)) { b.push(q); continue; }
        }
        bands.push([q]);
    }
    // a run of single-row bands that only differ by a column or two would fragment a repeating wall: merge a single row into its neighbour when that neighbour holds all its columns
    for (let i = bands.length - 1; i > 0; i--) if (bands[i].length === 1 && [...rowCols.get(bands[i][0])!].every(c => bands[i - 1].some(q => rowCols.get(q)!.has(c)))) { bands[i - 1].push(...bands[i]); bands.splice(i, 1); }

    let family = 0;
    bands.forEach((band, bi) => {
        const members = R.map((_, i) => i).filter(i => band.includes(rows.id[i]));
        const rects = members.map(i => R[i]);
        const y0 = Math.min(...rects.map(r => r[1])), y1 = Math.max(...rects.map(r => r[3]));
        const colCentres = [...new Set(members.map(i => cols.id[i]))].map(c => cols.at[c]);
        const rowCentres = band.map(q => rows.at[q]);
        const lc = fitLattice(colCentres, P.latticeTol, P.minRepeat), lr = fitLattice(rowCentres, P.latticeTol, P.minRepeat);
        const occupied = (l: NonNullable<typeof lc>, n: number) => n / (l.last - l.first + 1) >= P.latticeOccupancy;
        const colOk = !!lc && lc.share >= P.latticeShare && occupied(lc, colCentres.length), rowOk = !!lr && lr.share >= P.latticeShare && occupied(lr, rowCentres.length) || rowCentres.length <= 2;
        const bw = med(rects.map(r => r[2] - r[0])), bh = med(rects.map(r => r[3] - r[1]));
        const pn = Math.max(1, med(rects.map(panesIn)));
        // the axis: the facade's own (K's reading) when its mirror holds over this band, else the band's own centre
        const cands = [axisPx, (Math.min(...rects.map(r => r[0])) + Math.max(...rects.map(r => r[2]))) / 2].filter((a): a is number => a !== undefined);
        let axis = cands[0], ms = -1;
        for (const a of cands) { const s = mirrorShare(rects, a, P.mirrorIoU); if (s > ms) { ms = s; axis = a; } }
        const symOk = rects.length >= 3 && ms >= P.mirrorShare;
        const fam = family++;
        out.families.push({ id: fam, w: bw, h: bh, panes: pn });
        const region: IntentRegion = { y0, y1, decision: 'neither', scores: { columns: lc?.share ?? 0, rows: lr?.share ?? (rowCentres.length <= 2 ? 1 : 0), mirror: Math.max(0, ms) }, readWindows: rects.length, added: 0, reason: '' };
        if (colOk && lc && (rowOk || !lr)) {
            // repetition: every site of the lattice inside the band's read extent holds the module
            region.decision = 'repeat'; region.pitchPx = [lc.pitch, lr?.pitch ?? 0];
            let ys = lr && lr.share >= P.latticeShare ? Array.from({ length: lr.last - lr.first + 1 }, (_, k) => lr.phase + (lr.first + k) * lr.pitch) : rowCentres;
            // the building's floors: rows whose pitch agrees with the building's storey sit on its floor lines (each row moved to the nearest one)
            if (storey && lr && Math.abs(lr.pitch * fc.frame.pixel - storey.pitchM) <= P.storeyTol * storey.pitchM) {
                const snapY = (y: number) => { const wy = rowToY(fc.frame, y), k = Math.round((wy - storey.datumY) / storey.pitchM); return yToRow(fc.frame, storey.datumY + k * storey.pitchM); };
                const moved = ys.map(snapY);
                if (Math.max(...ys.map((y, i) => Math.abs(y - moved[i]))) * fc.frame.pixel <= 0.5 * storey.pitchM) { ys = [...new Set(moved.map(y => Math.round(y * 10) / 10))]; region.pitchPx = [lc.pitch, storey.pitchM / fc.frame.pixel]; onSnap?.(); }
            }
            for (const cy of ys) for (let k = lc.first; k <= lc.last; k++) {
                const cx = lc.phase + k * lc.pitch, site: Rect = [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2];
                const read = rects.some(r => rectIoU(r, site) >= 0.2);
                if (!read) region.added++;
                out.windows.push({ rect: site, panes: pn, source: read ? 'measured' : 'repeat', family: fam, region: bi });
            }
            region.reason = `windows repeat at ${lc.pitch.toFixed(1)} px across (${Math.round(lc.share * 100)}% of columns on it)${lr && lr.share >= P.latticeShare ? ` and ${lr.pitch.toFixed(1)} px up` : ''}: every site in the band holds the module, ${region.added} inferred from the repeat`;
        } else if (symOk) {
            region.decision = 'symmetric'; region.axisPx = axis;
            const placed: Rect[] = [];
            for (const r of rects) {
                const m: Rect = [2 * axis - r[2], r[1], 2 * axis - r[0], r[3]], pair = rects.find(o => rectIoU(o, m) >= P.mirrorIoU);
                // a pair averaged: each side is the mean of itself and its partner's mirror
                const a: Rect = pair ? [(r[0] + 2 * axis - pair[2]) / 2, (r[1] + pair[1]) / 2, (r[2] + 2 * axis - pair[0]) / 2, (r[3] + pair[3]) / 2] : r;
                if (!placed.some(o => rectIoU(o, a) >= 0.5)) { placed.push(a); out.windows.push({ rect: a, panes: pn, source: 'measured', family: fam, region: bi }); }
                if (!pair && m[0] >= 0 && m[2] <= fc.frame.width && !placed.some(o => rectIoU(o, m) > 0.1)) { placed.push(m); out.windows.push({ rect: m, panes: pn, source: 'mirror', family: fam, region: bi }); region.added++; }
            }
            region.reason = `${Math.round(ms * 100)}% of the band's windows mirror about x = ${axis.toFixed(0)} px${axis === axisPx ? " (the facade's own axis)" : ''}: pairs averaged, ${region.added} inferred from the mirror`;
        } else {
            for (const r of rects) out.windows.push({ rect: r, panes: Math.max(1, panesIn(r)), source: 'measured', family: fam, region: bi });
            region.reason = `neither: columns ${lc ? `${Math.round(lc.share * 100)}% on a lattice` : `too few (${colCentres.length})`}, mirror ${Math.round(Math.max(0, ms) * 100)}%; the windows stand as read`;
        }
        out.regions.push(region);
    });
    return out;
}

/** A plan transform (mirror or rotation about a centre, in x, z) as a 2x2 matrix, the way the symmetry reading builds it. */
function planMatrix(t: PlanTransform): { c: [number, number]; m: [number, number, number, number] } {
    const r = t.kind === 'mirror' ? (2 * t.angleDeg * Math.PI) / 180 : (t.angleDeg * Math.PI) / 180;
    return { c: t.centre, m: t.kind === 'mirror' ? [Math.cos(r), Math.sin(r), Math.sin(r), -Math.cos(r)] : [Math.cos(r), -Math.sin(r), Math.sin(r), Math.cos(r)] };
}

/** The windows of facade `from` carried onto facade `to` through the transform (and its shift), in `to`'s pixels; inverse: `to` -> `from` direction of the transform. */
function carry(rects: Rect[], from: IntentFacadeInput, to: IntentFacadeInput, t: PlanTransform, shift: [number, number], inverse: boolean): Rect[] {
    const { c, m } = planMatrix(t);
    let [a, b, cc, d] = m;
    if (inverse) { const det = a * d - b * cc; [a, b, cc, d] = [d / det, -b / det, -cc / det, a / det]; }
    const F = from.frame, T = to.frame;
    const map = (x: number, y: number): [number, number] => {
        const s = F.orthoSMin + x * F.pixel, tt = F.orthoTMax - y * F.pixel;
        const p = [F.centroid[0] + s * F.axisS[0] + tt * F.axisT[0], F.centroid[1] + s * F.axisS[1] + tt * F.axisT[1], F.centroid[2] + s * F.axisS[2] + tt * F.axisT[2]];
        const qx = p[0] - c[0], qz = p[2] - c[1];
        const v = [c[0] + a * qx + b * qz - T.centroid[0], p[1] - T.centroid[1], c[1] + cc * qx + d * qz - T.centroid[2]];
        const sb = v[0] * T.axisS[0] + v[1] * T.axisS[1] + v[2] * T.axisS[2] + (inverse ? -shift[0] : shift[0]), tb = v[0] * T.axisT[0] + v[1] * T.axisT[1] + v[2] * T.axisT[2] + (inverse ? -shift[1] : shift[1]);
        return [(sb - T.orthoSMin) / T.pixel, (T.orthoTMax - tb) / T.pixel];
    };
    return rects.map(r => { const p = map(r[0], r[1]), q = map(r[2], r[3]); return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])] as Rect; })
        .filter(r => r[0] >= 0 && r[1] >= 0 && r[2] <= T.width && r[3] <= T.height);
}

/** The design intent of every facade (see the module comment). `symmetry`: pipeline K's symmetry reading (facade axes and twins). */
export function inferStructureIntent(facades: IntentFacadeInput[], symmetry?: SymmetryReport, P: IntentParams = STRUCTURE_INTENT_PARAMS): StructureIntent {
    const byId = new Map(facades.map(f => [f.facadeId, f]));
    const axisOf = (fc: IntentFacadeInput) => {
        const rd = symmetry?.facades.find(f => f.facadeId === fc.facadeId);
        return rd && rd.detected && !rd.periodic && rd.axisS !== undefined && (rd.ncc ?? 0) >= P.facadeAxisNcc ? (rd.axisS - fc.frame.orthoSMin) / fc.frame.pixel : undefined;
    };
    // first pass: each facade alone; its repeating bands' rows give the building's storey; second pass: those bands on the building's floors
    const first = facades.map(fc => infer(fc, axisOf(fc), P));
    const rowsSeen = first.flatMap((fi, k) => fi.regions.filter(r => r.decision === 'repeat' && r.pitchPx && r.pitchPx[1] > 0).map(r => {
        const f = facades[k].frame, pitchM = r.pitchPx![1] * f.pixel;
        const ys = fi.windows.filter(w => fi.regions[w.region] === r).map(w => rowToY(f, (w.rect[1] + w.rect[3]) / 2));
        return { pitchM, phaseY: ys.length ? ys[0] : 0, rows: Math.round((r.y1 - r.y0) / r.pitchPx![1]) };
    }));
    const st = buildingStorey(rowsSeen, P.storeyTol);
    let snapped = 0;
    const intent: StructureIntent = { version: STRUCTURE_INTENT_VERSION, params: P, facades: st ? facades.map(fc => infer(fc, axisOf(fc), P, st, () => snapped++)) : first, twins: [] };
    if (st) intent.storey = { ...st, snapped };
    const intentOf = new Map(intent.facades.map(f => [f.facadeId, f]));
    // across facades: accepted twins that agree on what both read share their windows
    for (const tw of symmetry?.twins ?? []) {
        if (!tw.accepted) continue;
        const A = byId.get(tw.a), B = byId.get(tw.b), IA = intentOf.get(tw.a), IB = intentOf.get(tw.b);
        if (!A || !B || !IA || !IB) continue;
        const aOnB = carry(A.rects, A, B, tw.transform, tw.shiftM, false), bOnA = carry(B.rects, B, A, tw.transform, tw.shiftM, true);
        const poorer = A.rects.length <= B.rects.length ? { own: A.rects, other: bOnA } : { own: B.rects, other: aOnB };
        const agree = poorer.own.length ? poorer.own.filter(r => poorer.other.some(o => rectIoU(o, r) >= P.mirrorIoU)).length / poorer.own.length : 0;
        const used = poorer.own.length >= 3 && agree >= P.agreeShare;
        intent.twins.push({ a: tw.a, b: tw.b, agree, used, reason: used ? `the twins agree on ${Math.round(agree * 100)}% of the poorer one's windows: each takes the other's windows where it read none` : poorer.own.length < 3 ? 'too few windows read on the poorer twin to check they agree' : `the twins agree on only ${Math.round(agree * 100)}% of the poorer one's windows: one design not assumed` });
        if (!used) continue;
        for (const [I, carried, src] of [[IB, aOnB, tw.a], [IA, bOnA, tw.b]] as const) {
            let n = 0;
            for (const r of carried) {
                if (I.windows.some(w => rectIoU(w.rect, r) > 0.1)) continue;
                const fam = I.families.reduce((best, f) => Math.abs(f.w - (r[2] - r[0])) + Math.abs(f.h - (r[3] - r[1])) < Math.abs(best.w - (r[2] - r[0])) + Math.abs(best.h - (r[3] - r[1])) ? f : best, I.families[0] ?? { id: 0, w: 0, h: 0, panes: 1 });
                I.windows.push({ rect: r, panes: fam.panes, source: 'twin', family: fam.id, region: -1 }); n++;
            }
            if (n && !I.twinsFrom.includes(src)) I.twinsFrom.push(src);
        }
    }
    return intent;
}
