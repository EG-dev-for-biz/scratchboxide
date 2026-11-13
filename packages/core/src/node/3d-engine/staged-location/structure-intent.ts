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
 *  5. Evidence of absence, not absence of evidence. With the facade photo and pipeline K's masks (uncovered, occluded,
 *     featureless), every empty site a repeat or a mirror would fill is judged first: the photo shows a window there,
 *     reads plain wall there (withheld: never filled), something stood in front of it, or the photo never reached it.
 *     Only a site read as wall is closed to inference. Without the photo nothing is carried past what was read.
 *  6. To the wall's ends. A repeating band's lattice is carried on past its last read column, column by column, while
 *     the photo does not read the column as wall, to a window's width from the facade's edge (a column the photo never
 *     reached at all only within extendUnreadCols of the last one with evidence).
 *  7. Stacked through gaps. Two repeating bands of one lattice (pitch, phase and window size agreeing) are one shaft:
 *     the rows between them are laid at the shaft's row pitch (the band's own, else the building's storey) where the
 *     photo does not read wall.
 *  8. The frame. Each repeating band's piers (between each two columns, merged down a shaft through its spandrels) and
 *     floor lines (between its rows) are inferred with the windows: the structure the openings sit in.
 *  9. The setback tier. The faces of one tier (pipeline K's wall grammar, else faces of one top height) share a
 *     pattern: the column pitch its repeating bands carry most, with their window size and row pitch. A face holding
 *     under poorShare of the sites that pattern lays over it takes the pattern, phased to its own read windows, only
 *     when those windows sit on it; a face whose windows do not is its own design (and is reported as such).
 * 11. Top-down, the burden of proof on the exception (faceLattice). A designed face repeats unless something shows
 *     otherwise, so each face is first proposed as one lattice: its bay from the photo's whole-face period (pipeline K's
 *     rectify: periodM at NCC latticeNcc or more, else the bay most faces' photos carry), the windows within a bay from
 *     the read boxes folded at it, its rows on the building's storey. Every site is tested by the photo (and by the
 *     scan's depth where the scan resolves a window's recess; Google's tiles do not, so there it only says where the
 *     face's surface is). Contradicted sites are a detail only when coherent (a run over two rows or three columns,
 *     backed by both channels, or twice the size where only one channel speaks); isolated ones are noise the pattern
 *     overrides (flagged). A bay column contradicted down most of the face is dropped as folded wrongly. The lattice
 *     replaces the bottom-up reading only when it explains latticeExplained of the windows read and overrides at most
 *     latticeMaxNoise of its sites; reads off the lattice stay as read. Facades of one wall (pipeline K's wall grammar,
 *     else overlapping on one plane) are fitted as one lattice from all their windows and share it (wallLattices), so
 *     overlapping readings draw one grid; a facade whose own windows mostly disagree keeps its own. A wall is first split
 *     into sub-walls: one plane (a pier face and the bays recessed behind it are two designs) and overlapping extents.
 * 10. The plan's symmetry. Under a plan mirror or rotation scoring planScore or more, a poorly read face whose mapped
 *     partner coincides with it (normal, plane, extent) takes the partner's windows (its own reading and its own rules'
 *     inferences, never what other faces lent it). Tier and plan windows are vetted by the face's photo like any other.
 * Every element carries its provenance (measured: read by the capture; repeat, mirror, twin: inferred, with the region's
 * decision and score, and what the photo said at its site) and every region its decision with the scores that made it.
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
    /** The facade photo's luma and masks: when given, an empty site is filled only where the photo does not read it as wall (see SiteEvidence). */
    evidence?: FacadeEvidence;
    /** The setback tier the facade belongs to (pipeline K's wall grammar); absent: facades are grouped by their top height. */
    tier?: number;
    /** The straightened photo's column period over the whole face (pipeline K's rectify: periodM, periodNcc). */
    period?: { m: number; ncc: number };
    /** The wall the facade belongs to (pipeline K's wall grammar: facades of one wall overlap or touch on one plane); absent: grouped by plane. */
    wall?: number;
}

export type IntentSource = 'measured' | 'repeat' | 'mirror' | 'twin' | 'tier' | 'plan' | 'pattern';
export type RegionDecision = 'repeat' | 'symmetric' | 'neither' | 'blank';

export interface IntentWindow { rect: Rect; panes: number; source: IntentSource; family: number; region: number; /** For an inferred window: what the photo said at its site (window: it shows one; unread or occluded: it could not tell). */ evidence?: SiteEvidence; /** A pattern site the evidence contradicted in isolation (noise the pattern overrides). */ overridden?: true }
export interface IntentRegion {
    /** The band, in the facade photo's pixel rows. */
    y0: number; y1: number;
    decision: RegionDecision;
    /** Share of the band's columns and rows on their lattice (0 when too few to judge), and of its windows whose mirror lands on a window. */
    scores: { columns: number; rows: number; mirror: number };
    pitchPx?: [number, number]; axisPx?: number;
    readWindows: number; added: number;
    /** Sites the repeat or the mirror would have filled where the photo reads wall. */
    withheld?: number;
    reason: string;
}
export interface IntentFacade {
    facadeId: number; regions: IntentRegion[]; windows: IntentWindow[]; families: Array<{ id: number; w: number; h: number; panes: number }>; twinsFrom: number[];
    /** The frame the windows sit in: each pier between two columns of a repeating band ([x0, y0, x1, y1], merged down a shaft) and each floor line between its rows (y), in the photo's pixels. */
    structure?: { piers: Rect[]; floors: number[] };
    /** Whether the photo's evidence judged the empty sites, and what it did: sites withheld as wall, columns carried toward the wall's ends, windows laid through gaps between matching bands. */
    evidence?: { used: boolean; withheld: number; extended: number; stacked: number };
    /** The face read top-down as one lattice (see faceLattice): tried, and whether it explained the evidence well enough to stand. */
    lattice?: FaceLattice;
}

/**
 * A face's top-down hypothesis: one lattice over the whole face (the bay from the photo's whole-face period, the
 * windows within a bay from the read boxes folded at it, the rows on the building's storey), every site tested by two
 * independent channels (the photo; the scan's depth: a window is a recess), contradictions sorted into coherent details
 * (kept: no window) and isolated noise (overridden by the pattern), and the hypothesis kept only when it explains the
 * windows read and overrides little.
 */
export interface FaceLattice {
    accepted: boolean; reason: string;
    bayM: number; bayFrom: 'photo' | 'building' | 'wall'; offsetsM: number[]; /** The rows' phase as a world height (a window row's centre). */ rowPhaseY?: number; /** The wall's facades when the lattice is the wall's, shared by all of them. */ wall?: number[]; /** Window columns of the bay dropped: the evidence contradicted them down the face. */ droppedColumns: number; windowM: [number, number]; rowPitchM: number;
    sites: number; yes: number; no: number; unknown: number; noiseOverridden: number; detailSites: number;
    details: Array<{ sites: number; rows: [number, number]; cols: [number, number]; twoSource: number }>;
    /** Share of the windows read (inside the lattice's extent) that sit on a lattice site. */
    explained: number;
    depth: { learned: boolean; recessM?: number };
}
export interface TierPattern { tier: number; facades: number[]; pitchM: number; windowM: [number, number]; rowPitchM: number; yRange: [number, number]; bands: number; filled: Array<{ facadeId: number; added: number; withheld: number }>; skipped: Array<{ facadeId: number; reason: string }> }
export interface PlanFill { to: number; from: number; transform: string; score: number; added: number; withheld: number }
export interface StructureIntent { version: string; params: IntentParams; facades: IntentFacade[]; /** Each setback tier's pattern (the consensus of its repeating bands) and the poorly read faces that took it. */ tiers?: TierPattern[]; /** Faces filled from their partner under the plan's mirror or rotation. */ planFills?: PlanFill[]; /** The building's storey (world y, m): one floor-to-floor height and a datum every repeating band's rows sit on when they agree. */ storey?: { pitchM: number; datumY: number; bands: number; snapped: number }; twins: Array<{ a: number; b: number; agree: number; used: boolean; reason: string }> }

export const STRUCTURE_INTENT_PARAMS = {
    /** Window centres within this share of the median window's size are one column (or row). */
    moduleTol: 0.35,
    /** Two consecutive rows are one band when the smaller one's columns are mostly (bandOverlap) the larger one's (a window the capture missed does not make a new band) and their heights differ by under bandHeightTol. */
    bandOverlap: 0.6, bandHeightTol: 0.25,
    /** A band repeats along an axis when at least latticeShare of its columns (rows) fall within latticeTol of the pitch's sites, over at least minRepeat of them, and (without the photo's evidence to vet each site) they hold at least latticeOccupancy of the sites between the first and the last. */
    latticeShare: 0.75, latticeTol: 0.2, minRepeat: 3, latticeOccupancy: 0.75,
    /** A band is symmetric when at least mirrorShare of its windows (3 or more) mirror onto a window (IoU >= mirrorIoU). */
    mirrorShare: 0.7, mirrorIoU: 0.4,
    /** The facade's own axis (pipeline K's reading) is used at this NCC or more. */
    facadeAxisNcc: 0.75,
    /** Twins share windows when they agree on at least agreeShare of the poorer one's windows (3 or more). */
    agreeShare: 0.6,
    /** The building's storey: the row pitch (m) carrying the most repeating bands' rows, its datum their weighted phase; a band whose own row pitch is within storeyTol of it takes it (its rows on the building's floor lines). */
    storeyTol: 0.08,
    /** An opening at least stripHeights x the median window's height is a strip (split into its stacked panes when it has them); a window has at most maxPanes side by side. */
    stripHeights: 3, maxPanes: 8,
    /** A site reads as a window when its contrast with the wall around it is at least siteWindowShare of the read windows' typical contrast (same sign); the read windows must show a typical contrast of siteMinContrast (luma, 0-1) for the evidence to be used. */
    siteWindowShare: 0.33, siteMinContrast: 0.02,
    /** Carrying a repeat on: a column stops where at least extendWallShare of its sites the photo read are wall, a window's width (edgeMarginW) from the facade's edge, or past extendUnreadCols columns the photo never read. */
    extendWallShare: 0.5, edgeMarginW: 0.5, extendUnreadCols: 6,
    /** Stacking: two bands are one shaft when their column pitch agrees within stackPitchTol, their phase within stackPhaseTol of a pitch and their window size within stackSizeTol; at most stackMaxRows rows are laid between. */
    stackPitchTol: 0.05, stackPhaseTol: 0.15, stackSizeTol: 0.2, stackMaxRows: 40,
    /** A pier is drawn between two columns at least pierMinW of a window's width apart. */
    pierMinW: 0.2,
    /** Tier sharing: a tier's pattern is the column pitch most of its repeating bands' windows carry (within tierPitchTol); a face holding under poorShare of the sites that pattern lays over it takes the pattern when at least tierOnShare of its read windows (tierMinRead or more) sit on it and their width is within tierSizeTol of the tier's. Faces group by their top height within tierTopM when no tier is given. */
    tierPitchTol: 0.08, poorShare: 0.5, tierOnShare: 0.6, tierMinRead: 3, tierSizeTol: 0.3, tierTopM: 3,
    /** Plan symmetry: a transform of the plan scoring planScore or more maps a well read face (planRichRatio times the windows, at least planMinWindows) onto a poorly read one when the mapped face's normal agrees (planNormalCos), its plane lies within planOffsetM and its extent overlaps the face's by planExtentIoU. */
    planScore: 0.9, planRichRatio: 2, planMinWindows: 10, planNormalCos: 0.95, planOffsetM: 1.5, planExtentIoU: 0.7,
    /**
     * The face lattice: the photo's period stands when its NCC is latticeNcc or more (else the building's consensus bay:
     * the period most faces' photos carry, within tierPitchTol); a fold peak holding latticePeakShare of the strongest
     * (and at least 3 windows) is a window column within the bay. A site's depth votes window when it is recessed by
     * half the read windows' typical recess, wall when under recessFlatShare of it; the depth is learned when the read
     * windows recess by recessMinM or more (65% of them). A run of contradicted sites is a detail when it holds
     * detailMinSites or more over two rows or three columns and both channels contradicted at least half of it; else
     * each is noise the pattern overrides. The lattice stands when it explains latticeExplained of the windows read and
     * overrides at most latticeMaxNoise of its sites. The scan's surface must lie within depthBandM of the face's plane
     * at a site for it to be part of the face.
     */
    latticeNcc: 0.5, latticePeakShare: 0.2, recessMinM: 0.04, recessFlatShare: 0.15, detailMinSites: 4,
    latticeExplained: 0.6, latticeMaxNoise: 0.15, depthBandM: 1.5,
    /** A window column of the bay contradicted on columnNoShare of its sites down the face is dropped from the lattice (folded wrongly), not kept as a detail. */
    columnNoShare: 0.6,
    /** A facade takes its wall's lattice when at least wallMemberExplained of its own windows read (6 or more) sit on it. */
    wallMemberExplained: 0.4,
    /** Sub-walls: facades of one wall within subWallPlaneM of one plane whose extents overlap by subWallOverlap of the smaller. */
    subWallPlaneM: 0.15, subWallOverlap: 0.3
};
export type IntentParams = typeof STRUCTURE_INTENT_PARAMS;
export const STRUCTURE_INTENT_VERSION = 'structure-intent/4';

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

/**
 * What the photo says at a site: 'window' (it shows an opening there: the site's contrast with the wall around it at
 * least siteWindowShare of the read windows' typical contrast, the same sign), 'wall' (the photo reached the site, saw
 * it plainly, and it reads as the wall around it), 'occluded' (something stood in front when it was photographed) or
 * 'unread' (the photo never reached it, or reached it as a smear). Only a 'wall' site is closed to inference: absence of
 * evidence is not evidence of absence.
 */
export type SiteEvidence = 'window' | 'wall' | 'unread' | 'occluded';

/** A facade photo's luma and masks (1 = the photo reached the texel unblocked; occluded and featureless: 1 where set). */
export interface FacadeEvidence { W: number; H: number; luma: Float32Array; valid: Uint8Array; occluded?: Uint8Array; featureless?: Uint8Array }

/** Summed-area tables over a facade's evidence, for any rectangle's luma, coverage, occlusion and smear in O(1). */
export class EvidenceReader {
    private readonly W: number; private readonly H: number;
    private readonly sL: Float64Array; private readonly sV: Float64Array; private readonly sO: Float64Array; private readonly sF: Float64Array;
    private sign = 1; private typ = 0;
    /** Whether learn() found what a window looks like here. */
    learned = false;
    constructor(e: FacadeEvidence, private readonly P: IntentParams) {
        this.W = e.W; this.H = e.H;
        const n = (e.W + 1) * (e.H + 1);
        this.sL = new Float64Array(n); this.sV = new Float64Array(n); this.sO = new Float64Array(n); this.sF = new Float64Array(n);
        for (let y = 0; y < e.H; y++) {
            let rl = 0, rv = 0, ro = 0, rf = 0;
            for (let x = 0; x < e.W; x++) {
                const i = y * e.W + x, v = e.valid[i] ? 1 : 0;
                rl += v * e.luma[i]; rv += v; ro += e.occluded?.[i] ? 1 : 0; rf += e.featureless?.[i] ? 1 : 0;
                const j = (y + 1) * (e.W + 1) + x + 1, up = y * (e.W + 1) + x + 1;
                this.sL[j] = this.sL[up] + rl; this.sV[j] = this.sV[up] + rv; this.sO[j] = this.sO[up] + ro; this.sF[j] = this.sF[up] + rf;
            }
        }
    }
    private sum(t: Float64Array, r: number[]): number {
        const x0 = Math.max(0, Math.min(this.W, Math.round(r[0]))), x1 = Math.max(0, Math.min(this.W, Math.round(r[2]))), y0 = Math.max(0, Math.min(this.H, Math.round(r[1]))), y1 = Math.max(0, Math.min(this.H, Math.round(r[3])));
        if (x1 <= x0 || y1 <= y0) return 0;
        const w = this.W + 1;
        return t[y1 * w + x1] - t[y0 * w + x1] - t[y1 * w + x0] + t[y0 * w + x0];
    }
    private area(r: number[]) { return Math.max(0, Math.min(this.W, Math.round(r[2])) - Math.max(0, Math.round(r[0]))) * Math.max(0, Math.min(this.H, Math.round(r[3])) - Math.max(0, Math.round(r[1]))); }
    /** The site's mean luma minus its ring's (the wall around it: half its width each side, half its height above and below), over the texels the photo reached unblocked; undefined when either is too thinly read. */
    contrast(r: number[]): number | undefined {
        const w = r[2] - r[0], h = r[3] - r[1], ring = [r[0] - 0.5 * w, r[1] - 0.5 * h, r[2] + 0.5 * w, r[3] + 0.5 * h];
        const vIn = this.sum(this.sV, r), vAll = this.sum(this.sV, ring), vRing = vAll - vIn;
        if (vIn < 0.5 * Math.max(1, this.area(r)) || vRing < 0.3 * Math.max(1, this.area(ring) - this.area(r))) return undefined;
        const lIn = this.sum(this.sL, r), lRing = this.sum(this.sL, ring) - lIn;
        return lIn / vIn - lRing / vRing;
    }
    /** Learn what a window looks like here from the windows the capture read: the sign and the median size of their contrast. False when they do not agree on one (too few, or no clear contrast). */
    learn(read: number[][]): boolean {
        const c = read.map(r => this.contrast(r)).filter((v): v is number => v !== undefined);
        if (c.length < 3) return false;
        const pos = c.filter(v => v > 0).length;
        this.sign = pos >= c.length / 2 ? 1 : -1;
        this.typ = med(c.filter(v => Math.sign(v) === this.sign).map(Math.abs));
        this.learned = this.typ >= this.P.siteMinContrast && Math.max(pos, c.length - pos) >= 0.65 * c.length;
        return this.learned;
    }
    /** What the photo allows at a site: with a learned window, its reading; without one, only whether the photo saw the site at all ('seen': it did, and cannot say whether it is a window, so the site is closed). */
    vet(r: number[]): SiteEvidence | 'seen' {
        if (this.learned) return this.site(r);
        const a = Math.max(1, this.area(r));
        if (this.sum(this.sO, r) >= 0.5 * a) return 'occluded';
        if (this.sum(this.sV, r) < 0.5 * a || this.sum(this.sF, r) >= 0.5 * a) return 'unread';
        return 'seen';
    }
    site(r: number[]): SiteEvidence {
        const a = Math.max(1, this.area(r));
        if (this.sum(this.sO, r) >= 0.5 * a) return 'occluded';
        if (this.sum(this.sV, r) < 0.5 * a || this.sum(this.sF, r) >= 0.5 * a) return 'unread';
        const c = this.contrast(r);
        if (c === undefined) return 'unread';
        return this.sign * c >= this.P.siteWindowShare * this.typ ? 'window' : 'wall';
    }
}

/** One repeating band's lattice as the frame and the stacking read it. */
interface BandLattice { region: number; family: number; pitch: number; phase: number; first: number; last: number; ys: number[]; rowPitch?: number; bw: number; bh: number; pn: number }

function infer(fc: IntentFacadeInput, axisPx: number | undefined, P: IntentParams, storey?: { pitchM: number; datumY: number }, onSnap?: () => void, reader?: EvidenceReader): IntentFacade {
    const R = splitStrips(fc.rects, fc.panes, P);
    const out: IntentFacade = { facadeId: fc.facadeId, regions: [], windows: [], families: [], twinsFrom: [], structure: { piers: [], floors: [] }, evidence: { used: false, withheld: 0, extended: 0, stacked: 0 } };
    if (!R.length) { out.regions.push({ y0: 0, y1: fc.frame.height, decision: 'blank', scores: { columns: 0, rows: 0, mirror: 0 }, readWindows: 0, added: 0, reason: 'no windows read on this facade: a blank wall, or a wall the capture never resolved; nothing inferred' }); return out; }
    // the photo's evidence: what a window looks like here, learned from the windows read; without it every empty site is unread
    const ev = reader ?? (fc.evidence ? new EvidenceReader(fc.evidence, P) : undefined);
    const useEv = !!ev && ev.learn(R);
    out.evidence!.used = useEv;
    const siteOf = (r: Rect): SiteEvidence => (useEv ? ev!.site(r) : 'unread');
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

    const lattices: BandLattice[] = [];
    const occupiedBy = (r: Rect) => out.windows.some(w => rectIoU(w.rect, r) > 0.1);
    const place = (site: Rect, b: BandLattice, src: IntentSource, region: IntentRegion): boolean => {
        const e = siteOf(site);
        if (e === 'wall') { region.withheld = (region.withheld ?? 0) + 1; out.evidence!.withheld++; return false; }
        out.windows.push({ rect: site, panes: b.pn, source: src, family: b.family, region: b.region, evidence: e });
        region.added++;
        return true;
    };
    let family = 0;
    bands.forEach((band, bi) => {
        const members = R.map((_, i) => i).filter(i => band.includes(rows.id[i]));
        const rects = members.map(i => R[i]);
        const y0 = Math.min(...rects.map(r => r[1])), y1 = Math.max(...rects.map(r => r[3]));
        const colCentres = [...new Set(members.map(i => cols.id[i]))].map(c => cols.at[c]);
        const rowCentres = band.map(q => rows.at[q]);
        const lc = fitLattice(colCentres, P.latticeTol, P.minRepeat), lr = fitLattice(rowCentres, P.latticeTol, P.minRepeat);
        // without the photo to vet each site, a lattice must also hold most of its sites (a sparse reading is not a repeat); with it, the photo withholds the sites it reads as wall
        const occupied = (l: NonNullable<typeof lc>, n: number) => useEv || n / (l.last - l.first + 1) >= P.latticeOccupancy;
        const colOk = !!lc && lc.share >= P.latticeShare && occupied(lc, colCentres.length), rowOk = !!lr && lr.share >= P.latticeShare && occupied(lr, rowCentres.length) || rowCentres.length <= 2;
        const bw = med(rects.map(r => r[2] - r[0])), bh = med(rects.map(r => r[3] - r[1]));
        const pn = Math.max(1, med(rects.map(panesIn)));
        // the axis: the facade's own (K's reading) when its mirror holds over this band, else the band's own centre
        const cands = [axisPx, (Math.min(...rects.map(r => r[0])) + Math.max(...rects.map(r => r[2]))) / 2].filter((a): a is number => a !== undefined);
        let axis = cands[0], ms = -1;
        for (const a of cands) { const s2 = mirrorShare(rects, a, P.mirrorIoU); if (s2 > ms) { ms = s2; axis = a; } }
        const symOk = rects.length >= 3 && ms >= P.mirrorShare;
        const fam = family++;
        out.families.push({ id: fam, w: bw, h: bh, panes: pn });
        const region: IntentRegion = { y0, y1, decision: 'neither', scores: { columns: lc?.share ?? 0, rows: lr?.share ?? (rowCentres.length <= 2 ? 1 : 0), mirror: Math.max(0, ms) }, readWindows: rects.length, added: 0, reason: '' };
        if (colOk && lc && (rowOk || !lr)) {
            // repetition: every site of the lattice inside the band's read extent holds the module, unless the photo saw wall there
            region.decision = 'repeat'; region.pitchPx = [lc.pitch, lr?.pitch ?? 0];
            let ys = lr && lr.share >= P.latticeShare ? Array.from({ length: lr.last - lr.first + 1 }, (_, k) => lr.phase + (lr.first + k) * lr.pitch) : rowCentres;
            let rowPitch = lr && lr.share >= P.latticeShare ? lr.pitch : undefined;
            // the building's floors: rows whose pitch agrees with the building's storey sit on its floor lines (each row moved to the nearest one)
            if (storey && lr && Math.abs(lr.pitch * fc.frame.pixel - storey.pitchM) <= P.storeyTol * storey.pitchM) {
                const snapY = (y: number) => { const wy = rowToY(fc.frame, y), k = Math.round((wy - storey.datumY) / storey.pitchM); return yToRow(fc.frame, storey.datumY + k * storey.pitchM); };
                const moved = ys.map(snapY);
                if (Math.max(...ys.map((y, i) => Math.abs(y - moved[i]))) * fc.frame.pixel <= 0.5 * storey.pitchM) { ys = [...new Set(moved.map(y => Math.round(y * 10) / 10))]; rowPitch = storey.pitchM / fc.frame.pixel; region.pitchPx = [lc.pitch, rowPitch]; onSnap?.(); }
            }
            const b: BandLattice = { region: bi, family: fam, pitch: lc.pitch, phase: lc.phase, first: lc.first, last: lc.last, ys, rowPitch, bw, bh, pn };
            const siteAt = (k: number, cy: number): Rect => { const cx = lc.phase + k * lc.pitch; return [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2]; };
            for (const cy of ys) for (let k = lc.first; k <= lc.last; k++) {
                const site = siteAt(k, cy);
                if (rects.some(r => rectIoU(r, site) >= 0.2)) out.windows.push({ rect: site, panes: pn, source: 'measured', family: fam, region: bi });
                else place(site, b, 'repeat', region);
            }
            // carried on to the wall's ends: a column past the last read one is laid while the photo does not read it as wall (most of its read sites wall) and it stays a window's width inside the facade
            let extended = 0;
            // without the photo's evidence an empty column cannot be told from a blank wall: nothing is carried on
            if (useEv) for (const dir of [-1, 1] as const) {
                for (let k = dir < 0 ? lc.first - 1 : lc.last + 1; ; k += dir) {
                    const cx = lc.phase + k * lc.pitch;
                    if (cx - bw / 2 < P.edgeMarginW * bw || cx + bw / 2 > fc.frame.width - P.edgeMarginW * bw) break;
                    const sites = ys.map(cy => siteAt(k, cy)), evs = sites.map(siteOf);
                    const known = evs.filter(e2 => e2 === 'window' || e2 === 'wall').length, walls = evs.filter(e2 => e2 === 'wall').length;
                    if (known && walls >= P.extendWallShare * known) break;
                    // a column the photo never read at all is carried only while it stays within extendUnreadCols of the last column with evidence
                    if (!known && Math.abs(k - (dir < 0 ? lc.first : lc.last)) > P.extendUnreadCols) break;
                    let any = false;
                    sites.forEach(site => { if (!occupiedBy(site) && place(site, b, 'repeat', region)) any = true; });
                    if (!any) break;
                    if (dir < 0) b.first = k; else b.last = k;
                    extended++;
                }
            }
            out.evidence!.extended += extended;
            lattices.push(b);
            region.reason = `windows repeat at ${lc.pitch.toFixed(1)} px across (${Math.round(lc.share * 100)}% of columns on it)${rowPitch ? ` and ${rowPitch.toFixed(1)} px up` : ''}: every site in the band holds the module, ${region.added} inferred from the repeat${extended ? ` (${extended} columns carried on toward the wall's ends)` : ''}${region.withheld ? `, ${region.withheld} withheld where the photo reads wall` : ''}`;
        } else if (symOk) {
            region.decision = 'symmetric'; region.axisPx = axis;
            const placed: Rect[] = [];
            for (const r of rects) {
                const m: Rect = [2 * axis - r[2], r[1], 2 * axis - r[0], r[3]], pair = rects.find(o => rectIoU(o, m) >= P.mirrorIoU);
                // a pair averaged: each side is the mean of itself and its partner's mirror
                const a: Rect = pair ? [(r[0] + 2 * axis - pair[2]) / 2, (r[1] + pair[1]) / 2, (r[2] + 2 * axis - pair[0]) / 2, (r[3] + pair[3]) / 2] : r;
                if (!placed.some(o => rectIoU(o, a) >= 0.5)) { placed.push(a); out.windows.push({ rect: a, panes: pn, source: 'measured', family: fam, region: bi }); }
                if (!pair && m[0] >= 0 && m[2] <= fc.frame.width && !placed.some(o => rectIoU(o, m) > 0.1)) {
                    const e = siteOf(m);
                    if (e === 'wall') { region.withheld = (region.withheld ?? 0) + 1; out.evidence!.withheld++; continue; }
                    placed.push(m); out.windows.push({ rect: m, panes: pn, source: 'mirror', family: fam, region: bi, evidence: e }); region.added++;
                }
            }
            region.reason = `${Math.round(ms * 100)}% of the band's windows mirror about x = ${axis.toFixed(0)} px${axis === axisPx ? " (the facade's own axis)" : ''}: pairs averaged, ${region.added} inferred from the mirror${region.withheld ? `, ${region.withheld} withheld where the photo reads wall` : ''}`;
        } else {
            for (const r of rects) out.windows.push({ rect: r, panes: Math.max(1, panesIn(r)), source: 'measured', family: fam, region: bi });
            region.reason = `neither: columns ${lc ? `${Math.round(lc.share * 100)}% on a lattice` : `too few (${colCentres.length})`}, mirror ${Math.round(Math.max(0, ms) * 100)}%; the windows stand as read`;
        }
        out.regions.push(region);
    });

    // stacked through gaps: two repeating bands with one lattice (pitch, phase and window size agreeing) are one shaft; the rows between them are laid at the shaft's row pitch where the photo does not read wall
    const byY = [...lattices].sort((a, b) => a.ys[0] - b.ys[0]);
    // a band of one or two rows has no row pitch of its own: the building's storey stands in, else the facade's typical one
    const ownPitches = lattices.map(b => b.rowPitch).filter((v): v is number => !!v);
    const fallbackPitch = storey ? storey.pitchM / fc.frame.pixel : ownPitches.length ? med(ownPitches) : undefined;
    for (let i = 0; i + 1 < byY.length; i++) {
        const A = byY[i], B = byY[i + 1];
        const pitchOk = Math.abs(A.pitch - B.pitch) <= P.stackPitchTol * A.pitch;
        const dphase = Math.abs(((B.phase - A.phase) / A.pitch) - Math.round((B.phase - A.phase) / A.pitch));
        const sizeOk = Math.abs(A.bw - B.bw) <= P.stackSizeTol * A.bw && Math.abs(A.bh - B.bh) <= P.stackSizeTol * A.bh;
        const rp = A.rowPitch ?? B.rowPitch ?? fallbackPitch;
        if (!pitchOk || dphase > P.stackPhaseTol || !sizeOk || !rp) continue;
        const top = Math.max(...A.ys), bottom = Math.min(...B.ys), nGap = Math.round((bottom - top) / rp) - 1;
        if (nGap < 1 || nGap > P.stackMaxRows) continue;
        // B's columns expressed on A's lattice
        const off = Math.round((B.phase - A.phase) / A.pitch), k0 = Math.max(A.first, B.first + off), k1 = Math.min(A.last, B.last + off);
        if (k1 < k0) continue;
        const region = out.regions[A.region];
        let n = 0;
        for (let g = 1; g <= nGap; g++) {
            const cy = top + ((bottom - top) * g) / (nGap + 1);
            for (let k = k0; k <= k1; k++) {
                const cx = A.phase + k * A.pitch, site: Rect = [cx - A.bw / 2, cy - A.bh / 2, cx + A.bw / 2, cy + A.bh / 2];
                if (!occupiedBy(site) && place(site, A, 'repeat', region)) n++;
            }
            A.ys.push(cy);
        }
        if (n) { out.evidence!.stacked += n; region.reason += `; ${n} laid through the ${nGap}-row gap to the matching band below (one shaft)`; }
    }

    // the frame: a pier between each two columns of a repeating band, over its rows (merged down a shaft where they line up), and the floor lines between its rows
    const piers: Array<[number, number, number, number]> = [];
    for (const b of lattices) {
        const yTop = Math.min(...b.ys) - b.bh / 2, yBot = Math.max(...b.ys) + b.bh / 2;
        for (let k = b.first; k < b.last; k++) {
            const x0 = b.phase + k * b.pitch + b.bw / 2, x1 = b.phase + (k + 1) * b.pitch - b.bw / 2;
            if (x1 - x0 < P.pierMinW * b.bw) continue;
            piers.push([x0, yTop, x1, yBot]);
        }
        const rp = b.rowPitch ?? fallbackPitch;
        if (rp) { const ys = [...b.ys].sort((p, q) => p - q); for (let i = 0; i + 1 < ys.length; i++) if (ys[i + 1] - ys[i] <= 1.5 * rp) out.structure!.floors.push(Math.round(((ys[i] + ys[i + 1]) / 2) * 10) / 10); }
    }
    piers.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const p of piers) {
        // a pier runs on through the spandrel between two bands: pieces a storey or less apart are one
        const reach = fallbackPitch ?? 2 * mh;
        const last = out.structure!.piers.find(q => Math.abs(q[0] - p[0]) <= 0.15 * mw && Math.abs(q[2] - p[2]) <= 0.15 * mw && p[1] - q[3] <= reach && q[1] - p[3] <= reach);
        if (last) { last[0] = Math.min(last[0], p[0]); last[2] = Math.max(last[2], p[2]); last[1] = Math.min(last[1], p[1]); last[3] = Math.max(last[3], p[3]); }
        else out.structure!.piers.push([...p]);
    }
    out.structure!.floors = [...new Set(out.structure!.floors)].sort((a, b) => a - b);
    return out;
}

/** A plan transform (mirror or rotation about a centre, in x, z) as a 2x2 matrix, the way the symmetry reading builds it. */
function planMatrix(t: PlanTransform): { c: [number, number]; m: [number, number, number, number] } {
    const r = t.kind === 'mirror' ? (2 * t.angleDeg * Math.PI) / 180 : (t.angleDeg * Math.PI) / 180;
    return { c: t.centre, m: t.kind === 'mirror' ? [Math.cos(r), Math.sin(r), Math.sin(r), -Math.cos(r)] : [Math.cos(r), -Math.sin(r), Math.sin(r), Math.cos(r)] };
}

/** Facade `from`'s pixels mapped onto facade `to`'s through the plan transform (and its shift); inverse: the transform's inverse. Also the transform's linear part, for normals. */
function planMap(from: IntentFacadeInput, to: IntentFacadeInput, t: PlanTransform, shift: [number, number], inverse: boolean): { map: (x: number, y: number) => [number, number]; lin: [number, number, number, number]; world: (p: number[]) => number[] } {
    const { c, m } = planMatrix(t);
    let [a, b, cc, d] = m;
    if (inverse) { const det = a * d - b * cc; [a, b, cc, d] = [d / det, -b / det, -cc / det, a / det]; }
    const F = from.frame, T = to.frame;
    const world = (p: number[]) => { const qx = p[0] - c[0], qz = p[2] - c[1]; return [c[0] + a * qx + b * qz, p[1], c[1] + cc * qx + d * qz]; };
    const map = (x: number, y: number): [number, number] => {
        const s0 = F.orthoSMin + x * F.pixel, tt = F.orthoTMax - y * F.pixel;
        const q = world([F.centroid[0] + s0 * F.axisS[0] + tt * F.axisT[0], F.centroid[1] + s0 * F.axisS[1] + tt * F.axisT[1], F.centroid[2] + s0 * F.axisS[2] + tt * F.axisT[2]]);
        const v = [q[0] - T.centroid[0], q[1] - T.centroid[1], q[2] - T.centroid[2]];
        const sb = v[0] * T.axisS[0] + v[1] * T.axisS[1] + v[2] * T.axisS[2] + (inverse ? -shift[0] : shift[0]), tb = v[0] * T.axisT[0] + v[1] * T.axisT[1] + v[2] * T.axisT[2] + (inverse ? -shift[1] : shift[1]);
        return [(sb - T.orthoSMin) / T.pixel, (T.orthoTMax - tb) / T.pixel];
    };
    return { map, lin: [a, b, cc, d], world };
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
export function inferStructureIntent(facades: IntentFacadeInput[], symmetry?: SymmetryReport, P: IntentParams = STRUCTURE_INTENT_PARAMS, opts: { /** The scan (triangle soup, the facades' frame): the depth channel and where each face's surface is. */ scan?: Float32Array | Float64Array } = {}): StructureIntent {
    const byId = new Map(facades.map(f => [f.facadeId, f]));
    const axisOf = (fc: IntentFacadeInput) => {
        const rd = symmetry?.facades.find(f => f.facadeId === fc.facadeId);
        return rd && rd.detected && !rd.periodic && rd.axisS !== undefined && (rd.ncc ?? 0) >= P.facadeAxisNcc ? (rd.axisS - fc.frame.orthoSMin) / fc.frame.pixel : undefined;
    };
    // each facade's photo evidence, read once
    const readers = new Map(facades.filter(fc => fc.evidence).map(fc => [fc.facadeId, new EvidenceReader(fc.evidence!, P)]));
    // first pass: each facade alone; its repeating bands' rows give the building's storey; second pass: those bands on the building's floors
    const first = facades.map(fc => infer(fc, axisOf(fc), P, undefined, undefined, readers.get(fc.facadeId)));
    const rowsSeen = first.flatMap((fi, k) => fi.regions.filter(r => r.decision === 'repeat' && r.pitchPx && r.pitchPx[1] > 0).map(r => {
        const f = facades[k].frame, pitchM = r.pitchPx![1] * f.pixel;
        const ys = fi.windows.filter(w => fi.regions[w.region] === r).map(w => rowToY(f, (w.rect[1] + w.rect[3]) / 2));
        return { pitchM, phaseY: ys.length ? ys[0] : 0, rows: Math.round((r.y1 - r.y0) / r.pitchPx![1]) };
    }));
    const st = buildingStorey(rowsSeen, P.storeyTol);
    let snapped = 0;
    const intent: StructureIntent = { version: STRUCTURE_INTENT_VERSION, params: P, facades: st ? facades.map(fc => infer(fc, axisOf(fc), P, st, () => snapped++, readers.get(fc.facadeId))) : first, twins: [] };
    if (st) intent.storey = { ...st, snapped };
    // top-down: each face as one lattice, kept where it explains the evidence better than the bottom-up reading
    const bays = facades.filter(f => f.period && f.period.ncc >= P.latticeNcc).map(f => ({ m: f.period!.m, w: f.period!.ncc * f.frame.width * f.frame.height * f.frame.pixel * f.frame.pixel }));
    let buildingBay: number | undefined, bw = 0;
    for (const b of bays) { const near = bays.filter(o => Math.abs(o.m - b.m) <= P.tierPitchTol * b.m), w = near.reduce((a, o) => a + o.w, 0); if (w > bw) { bw = w; buildingBay = near.reduce((a, o) => a + o.m * o.w, 0) / w; } }
    const specs = wallLattices(facades, st, buildingBay, P);
    intent.facades = intent.facades.map((I, k) => {
        const fc = facades[k], spec = specs.get(fc.facadeId);
        if (spec) { const w = faceLattice(structuredClone(I), fc, readers.get(fc.facadeId), opts.scan, st, buildingBay, P, spec); if (w.lattice?.accepted) return w; }
        return faceLattice(I, fc, readers.get(fc.facadeId), opts.scan, st, buildingBay, P);
    });
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
    shareTiers(intent, facades, readers, st, P);
    fillByPlan(intent, facades, readers, symmetry, P);
    return intent;
}

/** Lay windows on a facade from outside its own reading: each site vetted by its photo (a site read as wall, or seen without a learned window, is withheld). */
function layOn(I: IntentFacade, fc: IntentFacadeInput, reader: EvidenceReader | undefined, sites: Rect[], source: IntentSource, family: number, panes: number): { added: number; withheld: number } {
    let added = 0, withheld = 0;
    for (const r of sites) {
        if (r[0] < 0 || r[1] < 0 || r[2] > fc.frame.width || r[3] > fc.frame.height) continue;
        if (I.windows.some(w => rectIoU(w.rect, r) > 0.1)) continue;
        const e = reader ? reader.vet(r) : 'unread';
        if (e === 'wall' || e === 'seen') { withheld++; continue; }
        I.windows.push({ rect: r, panes, source, family, region: -1, evidence: e });
        added++;
    }
    if (I.evidence) I.evidence.withheld += withheld;
    return { added, withheld };
}

/** The sites a facade's own windows and its full extent would hold under a lattice (centre spacing pitchPx across, rows at rowsPx). */
const latticeSites = (fc: IntentFacadeInput, phasePx: number, pitchPx: number, rowsPx: number[], w: number, h: number, edge: number): Rect[] => {
    const out: Rect[] = [];
    for (let k = Math.ceil((edge + w / 2 - phasePx) / pitchPx); phasePx + k * pitchPx + w / 2 <= fc.frame.width - edge; k++) {
        const cx = phasePx + k * pitchPx;
        for (const cy of rowsPx) out.push([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]);
    }
    return out;
};
const circularPhase = (pos: number[], pitch: number) => { let cx = 0, cy = 0; for (const p of pos) { const a = (2 * Math.PI * p) / pitch; cx += Math.cos(a); cy += Math.sin(a); } return ((((Math.atan2(cy, cx) / (2 * Math.PI)) * pitch) % pitch) + pitch) % pitch; };

/**
 * Tier sharing: the faces of one setback tier share a pattern. The tier's is the column pitch (m) its repeating bands'
 * windows carry most, with their window size and row pitch; a face holding under poorShare of the sites that pattern lays
 * over it takes the pattern when its own read windows sit on it (the pattern's phase fitted to them), each site vetted
 * by the face's photo.
 */
function shareTiers(intent: StructureIntent, facades: IntentFacadeInput[], readers: Map<number, EvidenceReader>, storey: { pitchM: number; datumY: number } | undefined, P: IntentParams): void {
    const byId = new Map(facades.map(f => [f.facadeId, f])), intentOf = new Map(intent.facades.map(f => [f.facadeId, f]));
    // the tiers: the wall grammar's, else facades grouped by their top height
    const tops = facades.map(f => ({ id: f.facadeId, top: rowToY(f.frame, 0) })).sort((a, b) => a.top - b.top);
    const topTier = new Map<number, number>(); let tk = -1, last = -Infinity;
    for (const t of tops) { if (t.top - last > P.tierTopM) tk++; topTier.set(t.id, 1000 + tk); last = t.top; }
    const tierOf = (f: IntentFacadeInput) => f.tier ?? topTier.get(f.facadeId)!;
    const tiers = new Map<number, IntentFacadeInput[]>();
    for (const f of facades) { const k = tierOf(f); (tiers.get(k) ?? tiers.set(k, []).get(k)!).push(f); }
    intent.tiers = [];
    for (const [tier, members] of tiers) {
        // the pattern: every repeating band of the tier's faces, in metres, weighted by the windows it read
        const bands = members.flatMap(f => { const I = intentOf.get(f.facadeId)!; return I.regions.map((r, k) => ({ r, k, f, I })).filter(x => x.r.decision === 'repeat' && x.r.pitchPx && x.r.readWindows >= P.tierMinRead); })
            .map(x => ({ pitchM: x.r.pitchPx![0] * x.f.frame.pixel, rowM: x.r.pitchPx![1] * x.f.frame.pixel, wM: x.I.families[x.k].w * x.f.frame.pixel, hM: x.I.families[x.k].h * x.f.frame.pixel, w: x.r.readWindows, y: [rowToY(x.f.frame, x.r.y1), rowToY(x.f.frame, x.r.y0)] as [number, number] }));
        if (!bands.length) continue;
        let best: typeof bands = [], bw = 0;
        for (const b of bands) { const near = bands.filter(o => Math.abs(o.pitchM - b.pitchM) <= P.tierPitchTol * b.pitchM), w = near.reduce((a, o) => a + o.w, 0); if (w > bw) { bw = w; best = near; } }
        const wmed = (v: Array<[number, number]>) => { const a = [...v].sort((p, q) => p[0] - q[0]), tot = a.reduce((s2, x) => s2 + x[1], 0); let acc = 0; for (const x of a) { acc += x[1]; if (acc >= tot / 2) return x[0]; } return a[a.length - 1]?.[0] ?? 0; };
        const pitchM = best.reduce((a, o) => a + o.pitchM * o.w, 0) / bw, wM = wmed(best.map(o => [o.wM, o.w])), hM = wmed(best.map(o => [o.hM, o.w]));
        const ownRow = wmed(best.filter(o => o.rowM > 0).map(o => [o.rowM, o.w]));
        const rowPitchM = storey && (!ownRow || Math.abs(ownRow - storey.pitchM) <= P.storeyTol * storey.pitchM) ? storey.pitchM : ownRow;
        const yRange: [number, number] = [Math.min(...best.map(o => o.y[0])), Math.max(...best.map(o => o.y[1]))];
        const pat: TierPattern = { tier, facades: members.map(f => f.facadeId), pitchM, windowM: [wM, hM], rowPitchM, yRange, bands: best.length, filled: [], skipped: [] };
        intent.tiers.push(pat);
        if (!(rowPitchM > 0)) continue;
        const datumY = storey && rowPitchM === storey.pitchM ? storey.datumY : circularPhase(members.flatMap(f => intentOf.get(f.facadeId)!.windows.filter(w => w.source === 'measured').map(w => rowToY(f.frame, (w.rect[1] + w.rect[3]) / 2))), rowPitchM);
        for (const f of members) {
            const I = intentOf.get(f.facadeId)!, px = f.frame.pixel, pitchPx = pitchM / px, w = wM / px, h = hM / px;
            // the rows the tier's pattern spans on this face
            const rowsPx: number[] = [];
            for (let k = Math.ceil((yRange[0] - datumY) / rowPitchM); datumY + k * rowPitchM <= yRange[1]; k++) { const y = yToRow(f.frame, datumY + k * rowPitchM); if (y - h / 2 >= 0 && y + h / 2 <= f.frame.height) rowsPx.push(y); }
            const expected = Math.max(0, Math.floor((f.frame.width - w) / pitchPx) + 1) * rowsPx.length;
            if (!expected) continue;
            const own = I.windows.filter(x => x.source !== 'twin');
            if (own.length >= P.poorShare * expected) continue;
            const read = splitStrips(f.rects, f.panes, P);
            if (read.length < P.tierMinRead) { pat.skipped.push({ facadeId: f.facadeId, reason: `only ${read.length} windows read: no phase to lay the tier's pattern at (left to the plan's symmetry)` }); continue; }
            const xs = read.map(r => (r[0] + r[2]) / 2), phase = circularPhase(xs, pitchPx);
            const on = xs.filter(x => { const d = Math.abs(((x - phase) / pitchPx) - Math.round((x - phase) / pitchPx)); return d <= 0.2; }).length / xs.length;
            const wRead = med(read.map(r => r[2] - r[0]));
            if (on < P.tierOnShare || Math.abs(wRead - w) > P.tierSizeTol * w) { pat.skipped.push({ facadeId: f.facadeId, reason: `its windows do not sit on the tier's pattern (${Math.round(on * 100)}% on its columns, width ${(wRead * px).toFixed(2)} m against ${wM.toFixed(2)} m): its own design` }); continue; }
            const fam = I.families.length; I.families.push({ id: fam, w, h, panes: 1 });
            const r = layOn(I, f, readers.get(f.facadeId), latticeSites(f, phase, pitchPx, rowsPx, w, h, P.edgeMarginW * w), 'tier', fam, 1);
            if (r.added || r.withheld) pat.filled.push({ facadeId: f.facadeId, ...r });
        }
    }
}

/**
 * Plan symmetry: a face the capture barely read is the image of its partner under the plan's mirror or rotation, when
 * the partner was read well and the mapped partner coincides with the face (normal, plane, extent). The partner's
 * windows (its own reading and what its own rules inferred, not what other faces lent it) are carried over, each site
 * vetted by the face's photo.
 */
function fillByPlan(intent: StructureIntent, facades: IntentFacadeInput[], readers: Map<number, EvidenceReader>, symmetry: SymmetryReport | undefined, P: IntentParams): void {
    const ts = (symmetry?.transforms ?? []).filter(t => t.score >= P.planScore);
    if (!ts.length) return;
    const intentOf = new Map(intent.facades.map(f => [f.facadeId, f]));
    const ownWindows = (I: IntentFacade) => I.windows.filter(w => w.source === 'measured' || w.source === 'repeat' || w.source === 'mirror');
    intent.planFills = [];
    for (const A of facades) {
        const IA = intentOf.get(A.facadeId)!;
        let best: { B: IntentFacadeInput; t: PlanTransform; inv: boolean; n: number } | undefined;
        for (const B of facades) {
            if (B === A) continue;
            const IB = intentOf.get(B.facadeId)!, n = ownWindows(IB).length;
            if (n < P.planMinWindows || n < P.planRichRatio * Math.max(1, IA.windows.length)) continue;
            for (const t of ts) for (const inv of t.kind === 'mirror' ? [false] : [false, true]) {
                const pm = planMap(B, A, t, [0, 0], inv);
                // the mapped partner's normal, plane and extent against the face's
                const nB = B.frame.normal, nm = [pm.lin[0] * nB[0] + pm.lin[1] * nB[2], nB[1], pm.lin[2] * nB[0] + pm.lin[3] * nB[2]];
                if (nm[0] * A.frame.normal[0] + nm[1] * A.frame.normal[1] + nm[2] * A.frame.normal[2] < P.planNormalCos) continue;
                const cB = pm.world(B.frame.centroid), off = Math.abs((cB[0] - A.frame.centroid[0]) * A.frame.normal[0] + (cB[1] - A.frame.centroid[1]) * A.frame.normal[1] + (cB[2] - A.frame.centroid[2]) * A.frame.normal[2]);
                if (off > P.planOffsetM) continue;
                const cs = [pm.map(0, 0), pm.map(B.frame.width, 0), pm.map(0, B.frame.height), pm.map(B.frame.width, B.frame.height)];
                const box = [Math.min(...cs.map(q => q[0])), Math.min(...cs.map(q => q[1])), Math.max(...cs.map(q => q[0])), Math.max(...cs.map(q => q[1]))];
                if (rectIoU(box, [0, 0, A.frame.width, A.frame.height]) < P.planExtentIoU) continue;
                if (!best || n > best.n) best = { B, t, inv, n };
            }
        }
        if (!best) continue;
        const IB = intentOf.get(best.B.facadeId)!, pm = planMap(best.B, A, best.t, [0, 0], best.inv);
        const sites = ownWindows(IB).map(w => { const p = pm.map(w.rect[0], w.rect[1]), q = pm.map(w.rect[2], w.rect[3]); return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])] as Rect; });
        const fam = IA.families.length, wMed = med(sites.map(r => r[2] - r[0])), hMed = med(sites.map(r => r[3] - r[1]));
        IA.families.push({ id: fam, w: wMed, h: hMed, panes: 1 });
        const r = layOn(IA, A, readers.get(A.facadeId), sites, 'plan', fam, 1);
        intent.planFills.push({ to: A.facadeId, from: best.B.facadeId, transform: `${best.t.kind} ${best.t.angleDeg.toFixed(1)} deg${best.inv ? ' (inverse)' : ''}`, score: best.t.score, ...r });
    }
}

/** The scan as seen along a face's normal: per cell (2 photo pixels), the signed distance (m, outward +) of the front-most surface facing out within depthBandM x 2 of the plane; NaN where none. */
export function faceDepth(scan: Float32Array | Float64Array, f: IntentFacadeInput['frame'], band: number): { W: number; H: number; cell: number; d: Float32Array } {
    const cell = f.pixel * 2, W = Math.ceil(f.width / 2), H = Math.ceil(f.height / 2), d = new Float32Array(W * H).fill(NaN);
    const c = f.centroid, n = f.normal, S = f.axisS, T = f.axisT, nTri = scan.length / 9;
    const ps = [0, 0, 0], pt = [0, 0, 0], pd = [0, 0, 0];
    for (let t = 0; t < nTri; t++) {
        const o = 9 * t;
        let near = false;
        for (let k = 0; k < 3; k++) {
            const x = scan[o + 3 * k] - c[0], y = scan[o + 3 * k + 1] - c[1], z = scan[o + 3 * k + 2] - c[2];
            pd[k] = x * n[0] + y * n[1] + z * n[2]; ps[k] = x * S[0] + y * S[1] + z * S[2]; pt[k] = x * T[0] + y * T[1] + z * T[2];
            if (Math.abs(pd[k]) <= 2 * band) near = true;
        }
        if (!near) continue;
        // facing out along the face's normal (a reveal's side or a ceiling is not the face)
        const e1 = [ps[1] - ps[0], pt[1] - pt[0], pd[1] - pd[0]], e2 = [ps[2] - ps[0], pt[2] - pt[0], pd[2] - pd[0]];
        const nz = e1[0] * e2[1] - e1[1] * e2[0], len = Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], nz);
        if (!(len > 0) || Math.abs(nz) / len < 0.5) continue;
        const xs = ps.map(v => (v - f.orthoSMin) / cell), ys = pt.map(v => (f.orthoTMax - v) / cell);
        const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(W - 1, Math.ceil(Math.max(...xs))), y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(H - 1, Math.ceil(Math.max(...ys)));
        const area = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0]);
        if (!(Math.abs(area) > 1e-9)) continue;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const px = x + 0.5, py = y + 0.5;
            const w0 = ((xs[1] - px) * (ys[2] - py) - (xs[2] - px) * (ys[1] - py)) / area, w1 = ((xs[2] - px) * (ys[0] - py) - (xs[0] - px) * (ys[2] - py)) / area, w2 = 1 - w0 - w1;
            if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
            const v = w0 * pd[0] + w1 * pd[1] + w2 * pd[2];
            if (Math.abs(v) > 2 * band) continue;
            const i = y * W + x;
            if (!(v <= d[i])) d[i] = v; // NaN compares false: the first surface, else the front-most
        }
    }
    return { W, H, cell, d };
}

/** Median of a depth raster over a rectangle (photo pixels), and the share of its cells holding a surface. */
function depthIn(D: { W: number; H: number; d: Float32Array }, r: number[]): { med: number; cover: number } {
    const x0 = Math.max(0, Math.floor(r[0] / 2)), x1 = Math.min(D.W, Math.ceil(r[2] / 2)), y0 = Math.max(0, Math.floor(r[1] / 2)), y1 = Math.min(D.H, Math.ceil(r[3] / 2));
    const v: number[] = []; let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { n++; const z = D.d[y * D.W + x]; if (Number.isFinite(z)) v.push(z); }
    return { med: v.length ? med(v) : NaN, cover: n ? v.length / n : 0 };
}
const ringOf = (r: number[]): number[] => { const w = r[2] - r[0], h = r[3] - r[1]; return [r[0] - 0.5 * w, r[1] - 0.5 * h, r[2] + 0.5 * w, r[3] + 0.5 * h]; };
const shrink = (r: number[], k: number): number[] => { const w = r[2] - r[0], h = r[3] - r[1]; return [r[0] + k * w, r[1] + k * h, r[2] - k * w, r[3] - k * h]; };

/** The face read top-down as one lattice (see FaceLattice); returns the facade's intent, replaced by the lattice's where it stands. */
/** A lattice fixed from outside the face (its wall's), in the face's own pixels. */
interface LatticeSpec { bay: number; offs: number[]; rowPitchPx: number; rowPhase: number; w: number; h: number; wall: number[] }

function faceLattice(I: IntentFacade, fc: IntentFacadeInput, reader: EvidenceReader | undefined, scan: Float32Array | Float64Array | undefined, storey: { pitchM: number; datumY: number } | undefined, buildingBay: number | undefined, P: IntentParams, spec?: LatticeSpec): IntentFacade {
    const f = fc.frame, px = f.pixel;
    const read = splitStrips(fc.rects, fc.panes, P);
    if (!spec && read.length < 6) return I;
    const wRead = spec ? spec.w : med(read.map(r => r[2] - r[0])), hRead = spec ? spec.h : med(read.map(r => r[3] - r[1]));
    // the rows: the building's storey, else the face's own (its read rows' lattice)
    let rowPitchPx: number | undefined, rowPhase: number;
    const yc = read.map(r => (r[1] + r[3]) / 2);
    if (spec) { rowPitchPx = spec.rowPitchPx; }
    else if (storey) { rowPitchPx = storey.pitchM / px; }
    else { const rows = cluster1(yc, 0.35 * hRead).at, l = fitLattice(rows, P.latticeTol, P.minRepeat); if (l && l.share >= P.latticeShare) rowPitchPx = l.pitch; }
    if (!rowPitchPx) { I.lattice = { accepted: false, reason: 'no row pitch: no building storey and the face\'s rows do not repeat', bayM: 0, bayFrom: 'photo', offsetsM: [], droppedColumns: 0, windowM: [wRead * px, hRead * px], rowPitchM: 0, sites: 0, yes: 0, no: 0, unknown: 0, noiseOverridden: 0, detailSites: 0, details: [], explained: 0, depth: { learned: false } }; return I; }
    rowPhase = spec ? spec.rowPhase : circularPhase(yc, rowPitchPx);
    // the depth channel: learned from the read windows (a recess against the wall around them)
    const D = scan ? faceDepth(scan, f, P.depthBandM) : undefined;
    let recess: number | undefined;
    if (D) {
        const rs = read.map(r => { const a = depthIn(D, shrink(r, 0.2)), b = depthIn(D, ringOf(r)); return a.cover > 0.5 && b.cover > 0.3 ? b.med - a.med : NaN; }).filter(Number.isFinite);
        if (rs.length >= 6 && med(rs) >= P.recessMinM && rs.filter(v => v > 0).length >= 0.65 * rs.length) recess = med(rs);
    }
    // the bay: the photo's period when it is clear, else the building's; whichever explains more of the windows read
    const cands: Array<{ m: number; from: 'photo' | 'building' }> = [];
    if (!spec && fc.period && fc.period.ncc >= P.latticeNcc) cands.push({ m: fc.period.m, from: 'photo' });
    if (!spec && buildingBay && !cands.some(c => Math.abs(c.m - buildingBay) <= P.tierPitchTol * c.m)) cands.push({ m: buildingBay, from: 'building' });
    if (!spec && !cands.length) return I;
    const xc = read.map(r => (r[0] + r[2]) / 2);
    let bestL: { bay: number; from: 'photo' | 'building' | 'wall'; offs: number[]; explained: number } | undefined;
    if (spec) {
        // the wall's lattice: only how much of this face's own reading it explains is measured here (a face that read nothing defers to its wall)
        const onCol = (x: number) => spec.offs.some(o => { const d = Math.abs((((x - o) % spec.bay) + spec.bay) % spec.bay); return Math.min(d, spec.bay - d) <= 0.35 * wRead; });
        const onRow = (y: number) => { const d = Math.abs((((y - rowPhase) % rowPitchPx!) + rowPitchPx!) % rowPitchPx!); return Math.min(d, rowPitchPx! - d) <= 0.35 * hRead; };
        bestL = { bay: spec.bay, from: 'wall', offs: spec.offs, explained: read.length ? read.filter((_, i) => onCol(xc[i]) && onRow(yc[i])).length / read.length : 1 };
    }
    for (const c of cands) {
        const bay = c.m / px;
        if (bay < 1.2 * wRead) continue;
        // fold the read windows at the bay: peaks of the histogram (bins a tenth of a window wide) are the window columns within it
        const bin = Math.max(1, wRead / 10), nb = Math.ceil(bay / bin), h = new Float64Array(nb);
        for (const x of xc) h[Math.floor((((x % bay) + bay) % bay) / bin) % nb] += 1;
        const sm = new Float64Array(nb); const R = Math.max(1, Math.round(0.3 * wRead / bin));
        for (let i = 0; i < nb; i++) for (let j = -R; j <= R; j++) sm[i] += h[(i + j + nb) % nb];
        const top = Math.max(...sm), offs: number[] = [];
        for (let i = 0; i < nb; i++) if (sm[i] >= Math.max(3, P.latticePeakShare * top) && sm[i] >= sm[(i + 1) % nb] && sm[i] > sm[(i - 1 + nb) % nb]) offs.push((i + 0.5) * bin);
        // peaks closer than 0.8 window widths are one column
        const merged: number[] = [];
        for (const o of offs.sort((a, b) => a - b)) if (!merged.length || o - merged[merged.length - 1] > 0.8 * wRead) merged.push(o);
        if (merged.length > 1 && merged[0] + bay - merged[merged.length - 1] <= 0.8 * wRead) merged.pop();
        if (!merged.length) continue;
        // each column at the mean of the windows folded near it (a flat-topped peak's first bin is not its centre)
        for (let m = 0; m < merged.length; m++) {
            const near = xc.map(x => { const d = ((((x - merged[m]) % bay) + bay * 1.5) % bay) - bay / 2; return d; }).filter(d => Math.abs(d) <= 0.5 * wRead);
            if (near.length) merged[m] = (((merged[m] + near.reduce((a, b) => a + b, 0) / near.length) % bay) + bay) % bay;
        }
        const onCol = (x: number) => merged.some(o => { const d = Math.abs((((x - o) % bay) + bay) % bay); return Math.min(d, bay - d) <= 0.35 * wRead; });
        const onRow = (y: number) => { const d = Math.abs((((y - rowPhase) % rowPitchPx!) + rowPitchPx!) % rowPitchPx!); return Math.min(d, rowPitchPx! - d) <= 0.35 * hRead; };
        const explained = read.filter((_, i) => onCol(xc[i]) && onRow(yc[i])).length / read.length;
        if (!bestL || explained > bestL.explained) bestL = { bay, from: c.from, offs: merged, explained };
    }
    const base: FaceLattice = { accepted: false, reason: '', bayM: (bestL?.bay ?? 0) * px, bayFrom: bestL?.from ?? 'photo', offsetsM: (bestL?.offs ?? []).map(o => o * px), rowPhaseY: rowToY(f, rowPhase), ...(spec ? { wall: spec.wall } : {}), droppedColumns: 0, windowM: [wRead * px, hRead * px], rowPitchM: rowPitchPx * px, sites: 0, yes: 0, no: 0, unknown: 0, noiseOverridden: 0, detailSites: 0, details: [], explained: bestL?.explained ?? 0, depth: { learned: recess !== undefined, ...(recess !== undefined ? { recessM: recess } : {}) } };
    // a member of a wall is held to a lower bar (its windows were already counted in fitting the wall's lattice), but one whose own windows mostly disagree keeps its own design
    if (!bestL || bestL.explained < (spec ? (read.length >= 6 ? P.wallMemberExplained : 0) : P.latticeExplained)) { I.lattice = { ...base, reason: `the lattice explains only ${Math.round((bestL?.explained ?? 0) * 100)}% of the windows read: the face is not one pattern` }; return I; }
    // every site of the lattice on the face's surface
    const { bay } = bestL;
    let offs = bestL.offs;
    let colsX: number[] = [], colOff: number[] = [];
    const buildCols = () => {
        const cs: Array<[number, number]> = [];
        for (let k = -1; k * bay <= f.width + bay; k++) offs.forEach((o, oi) => { const cx = k * bay + o; if (cx - wRead / 2 >= 0 && cx + wRead / 2 <= f.width) cs.push([cx, oi]); });
        cs.sort((a, b) => a[0] - b[0]); colsX = cs.map(c => c[0]); colOff = cs.map(c => c[1]);
    };
    buildCols();
    const rowsY: number[] = [];
    for (let k = Math.ceil((hRead / 2 - rowPhase) / rowPitchPx); rowPhase + k * rowPitchPx + hRead / 2 <= f.height; k++) rowsY.push(rowPhase + k * rowPitchPx);
    let nC = colsX.length; const nR = rowsY.length;
    // the read extent bounds the face where there is no scan to say where its surface is
    const yMin = read.length ? Math.min(...read.map(r => r[1])) - rowPitchPx : 0, yMax = read.length ? Math.max(...read.map(r => r[3])) + rowPitchPx : f.height;
    type Vote = -2 | -1 | 0 | 1 | 2; // -2 off the face; -1 no; 0 unknown; 1 yes; 2 read
    let vote = new Int8Array(nC * nR), twoNo = new Uint8Array(nC * nR);
    const siteRect = (c: number, r: number): Rect => [colsX[c] - wRead / 2, rowsY[r] - hRead / 2, colsX[c] + wRead / 2, rowsY[r] + hRead / 2];
    let droppedCols = 0;
    for (let pass = 0; pass < 2; pass++) {
    vote = new Int8Array(nC * nR); twoNo = new Uint8Array(nC * nR);
    for (let r = 0; r < nR; r++) for (let c = 0; c < nC; c++) {
        const site = siteRect(c, r), i = r * nC + c;
        if (D) { const ring = depthIn(D, ringOf(site)); if (ring.cover < 0.5 || Math.abs(ring.med) > P.depthBandM) { vote[i] = -2; continue; } }
        else if (rowsY[r] < yMin || rowsY[r] > yMax) { vote[i] = -2; continue; }
        if (read.some(q => rectIoU(q, site) >= 0.2)) { vote[i] = 2; continue; }
        const pe = reader?.learned ? reader.site(site) : undefined;
        const ph = pe === 'window' ? 1 : pe === 'wall' ? -1 : 0;
        let dv = 0;
        if (D && recess !== undefined) { const a = depthIn(D, shrink(site, 0.2)), b = depthIn(D, ringOf(site)); if (a.cover > 0.5 && b.cover > 0.3) { const rr = b.med - a.med; dv = rr >= 0.5 * recess ? 1 : rr <= P.recessFlatShare * recess ? -1 : 0; } }
        const v = ph + dv;
        vote[i] = (v >= 1 ? 1 : v <= -1 ? -1 : 0) as Vote;
        if (ph < 0 && dv < 0) twoNo[i] = 1;
    }
    // a window column of the bay that the evidence contradicts down most of the face was folded wrongly: it is not a detail but no column at all; dropped, the votes taken again
    if (pass || offs.length < 2) break;
    const bad = offs.map((_, oi) => { let n = 0, no = 0; for (let c = 0; c < nC; c++) if (colOff[c] === oi) for (let r = 0; r < nR; r++) { const v = vote[r * nC + c]; if (v === -2) continue; n++; if (v === -1) no++; } return n > 0 && no / n >= P.columnNoShare; });
    if (!bad.some(Boolean) || bad.every(Boolean)) break;
    droppedCols = bad.filter(Boolean).length;
    offs = offs.filter((_, oi) => !bad[oi]);
    buildCols(); nC = colsX.length;
    }
    // the contradicted sites: coherent runs are details, isolated ones noise
    const seen = new Uint8Array(nC * nR), detail = new Uint8Array(nC * nR);
    const details: FaceLattice['details'] = [];
    let noise = 0;
    for (let i = 0; i < nC * nR; i++) {
        if (vote[i] !== -1 || seen[i]) continue;
        const comp: number[] = [], stack = [i]; seen[i] = 1;
        while (stack.length) { const j = stack.pop()!; comp.push(j); const c = j % nC, r = (j - c) / nC; for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const cc = c + dc, rr = r + dr; if (cc < 0 || rr < 0 || cc >= nC || rr >= nR) continue; const k = rr * nC + cc; if (!seen[k] && vote[k] === -1) { seen[k] = 1; stack.push(k); } } }
        const cs = comp.map(j => j % nC), rs2 = comp.map(j => Math.floor(j / nC));
        const spanR = Math.max(...rs2) - Math.min(...rs2) + 1, spanC = Math.max(...cs) - Math.min(...cs) + 1, two = comp.filter(j => twoNo[j]).length / comp.length;
        const coherent = comp.length >= P.detailMinSites && (spanR >= 2 || spanC >= 3) && (two >= 0.5 || (recess === undefined && comp.length >= 2 * P.detailMinSites));
        if (coherent) { for (const j of comp) detail[j] = 1; details.push({ sites: comp.length, rows: [Math.min(...rs2), Math.max(...rs2)], cols: [Math.min(...cs), Math.max(...cs)], twoSource: Math.round(two * 100) / 100 }); }
        else noise += comp.length;
    }
    const onFace = [...vote].filter(v => v !== -2).length;
    const counts = { yes: [...vote].filter(v => v >= 1).length, no: [...vote].filter(v => v === -1).length, unknown: [...vote].filter(v => v === 0).length };
    const lat: FaceLattice = { ...base, offsetsM: offs.map(o => o * px), droppedColumns: droppedCols, sites: onFace, ...counts, noiseOverridden: noise, detailSites: details.reduce((a, d) => a + d.sites, 0), details };
    if (!onFace || noise > P.latticeMaxNoise * onFace) { I.lattice = { ...lat, reason: `the pattern would override ${noise} of ${onFace} sites the evidence contradicts in isolation: too much to call noise` }; return I; }
    // it stands: the face's windows are the lattice's, every site on the face but the details; reads off the lattice stay as read (a detail the photo showed)
    // each window split as the read windows are (their panes side by side, the median)
    const sideBySide = (r: Rect) => (fc.panes ?? []).filter(p => p[3] - p[1] >= 0.6 * (r[3] - r[1]) && Math.max(0, Math.min(r[2], p[2]) - Math.max(r[0], p[0])) * Math.max(0, Math.min(r[3], p[3]) - Math.max(r[1], p[1])) >= 0.6 * Math.max(1e-9, (p[2] - p[0]) * (p[3] - p[1]))).length;
    const fam = 0, pn = Math.min(P.maxPanes, Math.max(1, read.length ? med(read.map(sideBySide)) : 1));
    const windows: IntentWindow[] = [];
    for (let r = 0; r < nR; r++) for (let c = 0; c < nC; c++) {
        const i = r * nC + c; if (vote[i] === -2 || detail[i]) continue;
        const site = siteRect(c, r);
        windows.push({ rect: site, panes: pn, source: vote[i] === 2 ? 'measured' : 'pattern', family: fam, region: 0, ...(vote[i] === 2 ? {} : { evidence: (reader ? (reader.vet(site) === 'seen' ? 'unread' : reader.vet(site)) : 'unread') as SiteEvidence }), ...(vote[i] === -1 ? { overridden: true as const } : {}) });
    }
    const offLattice = read.filter(q => !windows.some(w => rectIoU(w.rect, q) > 0.1));
    for (const q of offLattice) windows.push({ rect: q, panes: 1, source: 'measured', family: 1, region: 1 });
    const out: IntentFacade = {
        ...I,
        windows,
        families: [{ id: 0, w: wRead, h: hRead, panes: pn }, { id: 1, w: med(offLattice.map(q => q[2] - q[0])) || wRead, h: med(offLattice.map(q => q[3] - q[1])) || hRead, panes: 1 }],
        regions: [
            { y0: Math.min(...rowsY) - hRead / 2, y1: Math.max(...rowsY) + hRead / 2, decision: 'repeat', scores: { columns: bestL.explained, rows: 1, mirror: 0 }, pitchPx: [bay, rowPitchPx], readWindows: read.length, added: windows.filter(w => w.source === 'pattern').length, reason: `one lattice over the face: a ${(bay * px).toFixed(2)} m bay (${bestL.from === 'photo' ? "the photo's own period" : bestL.from === 'wall' ? `its wall's, shared with facades ${spec!.wall.filter(x => x !== fc.facadeId).join(', ')}` : "the building's"}) holding ${offs.length} window column${offs.length > 1 ? 's' : ''}, rows ${(rowPitchPx * px).toFixed(2)} m apart; it explains ${Math.round(bestL.explained * 100)}% of the windows read; ${details.length} coherent details kept, ${noise} isolated contradictions overridden` },
            { y0: 0, y1: f.height, decision: 'neither', scores: { columns: 0, rows: 0, mirror: 0 }, readWindows: offLattice.length, added: 0, reason: `${offLattice.length} windows read off the lattice: kept as read (details the photo showed)` }
        ],
        structure: { piers: [], floors: rowsY.slice(1).map((y, k) => Math.round(((y + rowsY[k]) / 2) * 10) / 10) },
        lattice: { ...lat, accepted: true, reason: 'the face is one pattern with its details' }
    };
    // piers between each two adjacent window columns, over the lattice's rows on the face
    const rowsOn = rowsY.filter((_, r) => colsX.some((__, c) => vote[r * nC + c] !== -2));
    if (rowsOn.length) for (let c = 0; c + 1 < nC; c++) { const x0 = colsX[c] + wRead / 2, x1 = colsX[c + 1] - wRead / 2; if (x1 - x0 >= P.pierMinW * wRead) out.structure!.piers.push([x0, Math.min(...rowsOn) - hRead / 2, x1, Math.max(...rowsOn) + hRead / 2]); }
    return out;
}

/**
 * One lattice per wall: facades that overlap or touch on one plane (pipeline K's wall grammar, else grouped by plane) are
 * one wall and one design. Their read windows are put together in one frame and the wall's lattice found from all of
 * them (its bay from the members' photo periods, else the building's), then given back to each member in its own
 * pixels, so overlapping readings draw the same grid instead of two slightly different ones side by side.
 */
function wallLattices(facades: IntentFacadeInput[], storey: { pitchM: number; datumY: number } | undefined, buildingBay: number | undefined, P: IntentParams): Map<number, LatticeSpec> {
    const out = new Map<number, LatticeSpec>();
    const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const sub = (a: ArrayLike<number>, b: ArrayLike<number>) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    // the walls: the grammar's, else facades on one plane whose extents overlap or touch
    const groups = new Map<string, IntentFacadeInput[]>();
    const parent = facades.map((_, i) => i), root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
    const extent = (f: IntentFacadeInput) => ({ s0: f.frame.orthoSMin, s1: f.frame.orthoSMin + f.frame.width * f.frame.pixel, t0: f.frame.orthoTMax - f.frame.height * f.frame.pixel, t1: f.frame.orthoTMax });
    for (let i = 0; i < facades.length; i++) for (let j = i + 1; j < facades.length; j++) {
        const a = facades[i], b = facades[j];
        if (a.wall !== undefined || b.wall !== undefined) { if (a.wall !== undefined && a.wall === b.wall) parent[root(j)] = root(i); continue; }
        if (dot(a.frame.normal, b.frame.normal) < 0.98 || Math.abs(dot(sub(b.frame.centroid, a.frame.centroid), a.frame.normal)) > 0.5) continue;
        // b's extent in a's frame
        const ea = extent(a), off = sub(b.frame.centroid, a.frame.centroid), eb = extent(b), su = dot(b.frame.axisS, a.frame.axisS);
        const bs = [dot(off, a.frame.axisS) + su * eb.s0, dot(off, a.frame.axisS) + su * eb.s1].sort((x, y) => x - y), bt = [dot(off, a.frame.axisT) + eb.t0, dot(off, a.frame.axisT) + eb.t1];
        if (bs[0] > ea.s1 + 1 || bs[1] < ea.s0 - 1 || bt[0] > ea.t1 || bt[1] < ea.t0) continue;
        parent[root(j)] = root(i);
    }
    facades.forEach((f, i) => { const k = String(root(i)); (groups.get(k) ?? groups.set(k, []).get(k)!).push(f); });
    // a wall's sub-walls: one plane (within subWallPlaneM: a pier face and the bays recessed behind it are two designs) and
    // overlapping (by subWallOverlap of the smaller facade: facades that only touch, or cover other heights, keep their own)
    const subWalls: IntentFacadeInput[][] = [];
    for (const g of groups.values()) {
        if (g.length < 2) continue;
        const par = g.map((_, i) => i), rt = (i: number): number => (par[i] === i ? i : (par[i] = rt(par[i])));
        for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
            const a = g[i], b = g[j];
            if (Math.abs(dot(sub(b.frame.centroid, a.frame.centroid), a.frame.normal)) > P.subWallPlaneM) continue;
            const ea = extent(a), off = sub(b.frame.centroid, a.frame.centroid), eb = extent(b), su = dot(b.frame.axisS, a.frame.axisS);
            const bs = [dot(off, a.frame.axisS) + su * eb.s0, dot(off, a.frame.axisS) + su * eb.s1].sort((x, y) => x - y), bt = [dot(off, a.frame.axisT) + eb.t0, dot(off, a.frame.axisT) + eb.t1];
            const ov = Math.max(0, Math.min(ea.s1, bs[1]) - Math.max(ea.s0, bs[0])) * Math.max(0, Math.min(ea.t1, bt[1]) - Math.max(ea.t0, bt[0]));
            const smaller = Math.min((ea.s1 - ea.s0) * (ea.t1 - ea.t0), (eb.s1 - eb.s0) * (eb.t1 - eb.t0));
            if (ov >= P.subWallOverlap * smaller) par[rt(j)] = rt(i);
        }
        const by = new Map<number, IntentFacadeInput[]>();
        g.forEach((f, i) => { const k = rt(i); (by.get(k) ?? by.set(k, []).get(k)!).push(f); });
        for (const m of by.values()) if (m.length >= 2) subWalls.push(m);
    }
    for (const members of subWalls) {
        if (members.length < 2) continue;
        const reads = members.map(m => ({ m, r: splitStrips(m.rects, m.panes, P) }));
        if (reads.reduce((a, x) => a + x.r.length, 0) < 6) continue;
        // the reference: the member with the most windows read; every member's windows in its frame, the frame grown to hold them all
        const ref = reads.reduce((a, b) => (b.r.length > a.r.length ? b : a)).m, F = ref.frame;
        const toRef = (m: IntentFacadeInput, x: number, y: number): [number, number] => {
            const g = m.frame, s0 = g.orthoSMin + x * g.pixel, t0 = g.orthoTMax - y * g.pixel;
            const p = [g.centroid[0] + s0 * g.axisS[0] + t0 * g.axisT[0], g.centroid[1] + s0 * g.axisS[1] + t0 * g.axisT[1], g.centroid[2] + s0 * g.axisS[2] + t0 * g.axisT[2]];
            const v = sub(p, F.centroid);
            return [(dot(v, F.axisS) - F.orthoSMin) / F.pixel, (F.orthoTMax - dot(v, F.axisT)) / F.pixel];
        };
        const all: Rect[] = [];
        let minX = 0, minY = 0, maxX = F.width, maxY = F.height;
        for (const m of members) {
            const g = m.frame;
            for (const [x, y] of [[0, 0], [g.width, 0], [0, g.height], [g.width, g.height]]) { const q = toRef(m, x, y); minX = Math.min(minX, q[0]); maxX = Math.max(maxX, q[0]); minY = Math.min(minY, q[1]); maxY = Math.max(maxY, q[1]); }
        }
        for (const { m, r } of reads) for (const q of r) { const a = toRef(m, q[0], q[1]), b = toRef(m, q[2], q[3]); all.push([Math.min(a[0], b[0]) - minX, Math.min(a[1], b[1]) - minY, Math.max(a[0], b[0]) - minX, Math.max(a[1], b[1]) - minY]); }
        // one window per site: overlapping readings of one window count once
        const uniq: Rect[] = [];
        for (const q of all.sort((a, b) => a[0] - b[0])) if (!uniq.some(o => rectIoU(o, q) > 0.3)) uniq.push(q);
        const virt: IntentFacadeInput = { facadeId: -1, frame: { ...F, orthoSMin: F.orthoSMin + minX * F.pixel, orthoTMax: F.orthoTMax - minY * F.pixel, width: Math.ceil(maxX - minX), height: Math.ceil(maxY - minY) }, rects: uniq };
        // every member's photo period is a candidate for the wall's bay (and the building's, inside faceLattice): the one that explains most of the wall's windows stands
        const periods = [...new Map(members.filter(m => m.period && m.period.ncc >= P.latticeNcc).map(m => [Math.round(m.period!.m * 20), m.period!])).values()];
        let joint: FaceLattice | undefined;
        for (const pd of periods.length ? periods : [undefined]) {
            const blank: IntentFacade = { facadeId: -1, regions: [], windows: [], families: [], twinsFrom: [] };
            const l = faceLattice(blank, { ...virt, ...(pd ? { period: pd } : {}) }, undefined, undefined, storey, buildingBay, P).lattice;
            if (l?.accepted && (!joint || l.explained > joint.explained)) joint = l;
        }
        if (!joint?.accepted || joint.rowPhaseY === undefined) continue;
        // the wall's lattice in world terms, then in each member's pixels (the members share the plane, so the map is affine along it)
        const V = virt.frame, bayV = joint.bayM / V.pixel, offsV = joint.offsetsM.map(o => o / V.pixel);
        for (const m of members) {
            const g = m.frame, B = (V.pixel * dot(V.axisS, g.axisS)) / g.pixel, A = (dot(sub([V.centroid[0] + V.orthoSMin * V.axisS[0], V.centroid[1] + V.orthoSMin * V.axisS[1], V.centroid[2] + V.orthoSMin * V.axisS[2]], g.centroid), g.axisS) - g.orthoSMin) / g.pixel;
            const bay = Math.abs(B) * bayV, rowPitchPx = joint.rowPitchM / g.pixel;
            out.set(m.facadeId, {
                bay, offs: offsV.map(o => ((((A + B * o) % bay) + bay) % bay)), rowPitchPx,
                rowPhase: ((yToRow(g, joint.rowPhaseY) % rowPitchPx) + rowPitchPx) % rowPitchPx,
                w: (joint.windowM[0] / g.pixel), h: (joint.windowM[1] / g.pixel), wall: members.map(x => x.facadeId)
            });
        }
    }
    return out;
}
