/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Version F round 3: the cheap, local gates of a redrawn wall plate, framed by version F's own plan of the wall.
 *
 *   - **Lattice identity** (`latticeIdentity`): on a wall where F's fit to the tile is strong (window NCC at least
 *     STRONG_FIT_NCC after adjustment), the plate's storeys and bays are read against F's planned lattice instead of
 *     asking a vision model to count them (plate-identity.ts visionFacadeCounter, one call per plate). The plate's darkness
 *     (where it is darker than the wall round it, as render-compare.ts reads the tile) is correlated with F's openings
 *     (the lattice NCC; a redraw often lights the glazing the tile shows dark, so the better of the signed correlation and
 *     the correlation with the absolute deviation counts), and its row and column profiles (the mean absolute deviation
 *     from the local wall tone, sign-free) are read along F's storey rows and bay columns: a planned storey the plate
 *     shows no contrasting row for is missing, a contrasting row in a gap between storeys is an extra one; bays likewise.
 *     On ornate fronts (Haughwout's cast iron) the piers and spandrels contrast as much as the windows, so those counts are
 *     reported, not gated. The pass rule is sign-free: the magnitude of the lattice correlation at least LATTICE_NCC_SHARE
 *     of the tile's own NCC against F (and MIN_LATTICE_NCC), and the mean distance from F's opening borders to the plate's
 *     strong edges at most EDGE_DIST_SLACK times the tile's own (and MIN_EDGE_DIST_M): a plate of another wall, or one that
 *     paints bays over, has its edges elsewhere. A weak-fit wall keeps the vision count.
 *   - **Must-keep features** (`featureGuard`): the features the reading listed on the wall (open type codes as labels,
 *     never routing) get regions; a candidate plate that erases, replaces or recolours one is rejected: the plate's
 *     band-passed structure in the region must correlate with the tile's (within the audit's drift), keep its contrast, and
 *     keep its tone; a rectified Street View crop of the region, where one covers it, may vouch for the plate instead of
 *     the smeared tile.
 *   - **Best of n** (`pickCandidate`): the candidates that pass are ranked by local numbers only (lattice NCC, the Street
 *     View check's support, the audit's flagged share, the alignment chamfer); nothing waits on a serial retry.
 */

import { SRGB8_TO_LINEAR } from '../../../../common/spatial/photogrammetric-delight';
import { linearToLab } from '../texel-exposure';
import { maskedBlur } from '../pipeline-e/image-ops';
import type { MassingFace } from '../pipeline-e/native-massing';
import { AUDIT_DRIFT_M, AUDIT_DRIFT_STEP_M, DRIFT_NCC_PENALTY, ERASE_CONTRAST_RATIO, LIGHTNESS_WEIGHT, bandPass, labPlanes } from '../pipeline-e/plate-audit';
import { COUNT_TOLERANCE } from '../pipeline-e/plate-identity';
import { compareWall, wallEvidence, type WallTile } from './render-compare';
import type { ReadFeature } from './facade-parameters';

/** A wall whose adjusted window NCC against the tile is at least this has a strong F fit: its plate is gated locally. */
export const STRONG_FIT_NCC = 0.25;
/** The plate's lattice NCC against F must be at least this share of the tile's own NCC against F (the plate is crisper than the tile). */
export const LATTICE_NCC_SHARE = 0.6;
/** ... and at least this on its own. */
export const MIN_LATTICE_NCC = 0.15;
/** The plate's edge distance to F's opening borders may be at most this many times the tile's own (and MIN_EDGE_DIST_M). */
export const EDGE_DIST_SLACK = 2;
export const MIN_EDGE_DIST_M = 0.35;
/** A planned storey (bay) is shown when its row (column) contrast exceeds the neighbouring gaps' by this share (the local mean's blur spills into the gaps) plus PROFILE_MARGIN_ABS luma units. */
export const PROFILE_MARGIN = 0.15;
export const PROFILE_MARGIN_ABS = 1;
/** A gap whose darkness reaches this share of the typical shown row's is an extra storey (bay) the plate added. */
export const EXTRA_PROFILE_SHARE = 0.8;
/** A must-keep feature region keeps its structure when the plate's band-pass correlates with the tile's (or the photo's) at least this... */
export const FEATURE_KEEP_NCC = 0.3;
/** ... or at least this while keeping FEATURE_KEEP_CONTRAST of the tile's contrast and its tone (a crisp redraw of a smeared shopfront correlates weakly with the smear). */
export const FEATURE_WEAK_NCC = 0.1;
export const FEATURE_KEEP_CONTRAST = 0.6;
/** ... and its tone when the mean CIELAB distance (lightness weighted) is at most this. */
export const FEATURE_MAX_TONE_DE = 20;
/** The Street View crop vouches for a region when it covers at least this share of it. */
export const FEATURE_PHOTO_COVER = 0.5;
/** The width of the metric ruler the wall pictures carry at their left (version-f.ts wallWithRuler), px. */
export const WALL_PICTURE_RULER_PX = 56;

export interface ProfileCount { planned: number; shown: number; extra: number; passed: boolean }

export interface LatticeCheck {
    /** NCC of the plate's darkness with F's openings. */
    latticeNcc: number;
    /** The tile's own NCC against F on this wall (the fit's strength). */
    tileNcc: number;
    /** Mean distance from F's opening borders to the plate's strong edges (m), and the tile's own. */
    edgeDistM: number;
    tileEdgeDistM: number;
    storeys: ProfileCount;
    bays: ProfileCount;
    passed: boolean;
    why: string;
    /** The profiles read (diagnostics): planned opening share and the plate's contrast per row and per column. */
    profiles?: { rowOpen: number[]; rowDark: number[]; colOpen: number[]; colDark: number[] };
}

/** Maximal runs of `on`. */
function runs(on: Uint8Array): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let s = -1;
    for (let i = 0; i <= on.length; i++) {
        const v = i < on.length ? on[i] : 0;
        if (v && s < 0) s = i;
        if (!v && s >= 0) { out.push([s, i]); s = -1; }
    }
    return out;
}

/**
 * Reads a plate's darkness profile along F's planned bands (storey rows or bay columns): `open` is the planned share per line,
 * `dark` the plate's mean positive darkness per line. A planned band shows when its darkness exceeds the adjacent gaps' by
 * PROFILE_MARGIN; a gap holding a run as long as 40 % of the typical band whose darkness reaches EXTRA_PROFILE_SHARE of the
 * shown bands' is an extra band.
 */
export function profileCount(open: Float32Array, dark: Float32Array): ProfileCount {
    const on = Uint8Array.from(open, v => (v > 0.02 ? 1 : 0));
    const bands = runs(on);
    const mean = (a: number, b: number) => { let s = 0, n = 0; for (let i = Math.max(0, a); i < Math.min(dark.length, b); i++) if (Number.isFinite(dark[i])) { s += dark[i]; n++; } return n ? s / n : NaN; };
    const planned = bands.length;
    if (!planned) return { planned: 0, shown: 0, extra: 0, passed: true };
    const typical = bands.reduce((s, [a, b]) => s + (b - a), 0) / planned;
    let shown = 0;
    const shownLevels: number[] = [];
    bands.forEach(([a, b], k) => {
        const prevEnd = k ? bands[k - 1][1] : 0, nextStart = k + 1 < planned ? bands[k + 1][0] : dark.length;
        // a gap under 3 lines (the picture's border, a storey line cut by the frame) says nothing about the wall between storeys
        const gaps = [[prevEnd, a], [b, nextStart]].filter(([x, y]) => y - x >= 3).map(([x, y]) => mean(x, y)).filter(Number.isFinite);
        const own = mean(a, b);
        if (!Number.isFinite(own)) return;
        const around = gaps.length ? gaps.reduce((s, v) => s + v, 0) / gaps.length : 0;
        if (own > around * (1 + PROFILE_MARGIN) + PROFILE_MARGIN_ABS) { shown++; shownLevels.push(own); }
    });
    const level = shownLevels.length ? shownLevels.reduce((s, v) => s + v, 0) / shownLevels.length : Infinity;
    let extra = 0;
    const minRun = Math.max(2, Math.round(0.4 * typical));
    const gapsBetween: Array<[number, number]> = [];
    for (let k = 1; k < planned; k++) gapsBetween.push([bands[k - 1][1], bands[k][0]]);
    for (const [a, b] of gapsBetween) {
        const hot = new Uint8Array(b - a);
        for (let i = a; i < b; i++) hot[i - a] = Number.isFinite(dark[i]) && dark[i] >= EXTRA_PROFILE_SHARE * level ? 1 : 0;
        // a dark run touching a band is that band's edge, not an extra one
        extra += runs(hot).filter(([x, y]) => y - x >= minRun && x > 0 && y < b - a).length;
    }
    const tol = Math.max(1, Math.round(COUNT_TOLERANCE * planned));
    return { planned, shown, extra, passed: planned - shown <= tol && extra <= tol };
}

/**
 * The local identity check of a plate against F's planned offset map of the wall (`planned`, render-compare.ts
 * programWallOffset or structureGuidePng's offset; NaN outside the wall, below -0.05 m in an opening). `tileNcc` is the tile's
 * own window NCC against the same plan (the fit's strength: callers apply this check only when it is at least STRONG_FIT_NCC).
 */
export function latticeIdentity(plate: Uint8Array, f: MassingFace, use: Uint8Array, planned: Float32Array, tileNcc: number, tileEdgeDistM = MIN_EDGE_DIST_M): LatticeCheck {
    const W = f.width, H = f.height, n = W * H;
    const luma = new Float32Array(n), depth = new Float32Array(n).fill(NaN);
    for (let i = 0; i < n; i++) luma[i] = use[i] && Number.isFinite(planned[i]) ? 0.2126 * plate[i * 4] + 0.7152 * plate[i * 4 + 1] + 0.0722 * plate[i * 4 + 2] : NaN;
    const tile: WallTile = { face: f, luma, depth };
    const ev = wallEvidence(tile);
    const cmp = compareWall(ev, planned);
    const signed = cmp.windowNcc, edgeDistM = cmp.edgeDistM;
    const absDark = new Float32Array(ev.dark.length);
    for (let i = 0; i < absDark.length; i++) absDark[i] = Number.isFinite(ev.dark[i]) ? Math.abs(ev.dark[i]) : NaN;
    const unsigned = compareWall({ ...ev, dark: absDark }, planned).windowNcc;
    const latticeNcc = Math.max(Math.abs(signed), Math.abs(unsigned));
    // profiles: planned opening share and the plate's positive darkness per row and per column
    const rowOpen = new Float32Array(H), rowDark = new Float32Array(H), colOpen = new Float32Array(W), colDark = new Float32Array(W);
    const rowN = new Int32Array(H), colN = new Int32Array(W), rowD = new Int32Array(H), colD = new Int32Array(W);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!Number.isFinite(planned[i])) continue;
        const o = planned[i] < -0.05 ? 1 : 0;
        rowOpen[y] += o; rowN[y]++; colOpen[x] += o; colN[x]++;
        const d = absDark[i];
        if (Number.isFinite(d)) { rowDark[y] += d; rowD[y]++; colDark[x] += d; colD[x]++; }
    }
    for (let y = 0; y < H; y++) { rowOpen[y] = rowN[y] ? rowOpen[y] / rowN[y] : 0; rowDark[y] = rowD[y] ? rowDark[y] / rowD[y] : NaN; }
    for (let x = 0; x < W; x++) { colOpen[x] = colN[x] ? colOpen[x] / colN[x] : 0; colDark[x] = colD[x] ? colDark[x] / colD[x] : NaN; }
    const storeys = profileCount(rowOpen, rowDark), bays = profileCount(colOpen, colDark);
    const needNcc = Math.max(MIN_LATTICE_NCC, LATTICE_NCC_SHARE * tileNcc), needEdge = Math.max(MIN_EDGE_DIST_M, EDGE_DIST_SLACK * (Number.isFinite(tileEdgeDistM) ? tileEdgeDistM : MIN_EDGE_DIST_M));
    const nccOk = latticeNcc >= needNcc, edgeOk = Number.isFinite(edgeDistM) && edgeDistM <= needEdge;
    const passed = nccOk && edgeOk;
    const say = (k: string, c: ProfileCount) => `${k}: ${c.planned} planned, ${c.shown} with a contrasting row or column on the plate, ${c.extra} extra (reported)`;
    return { latticeNcc, tileNcc, edgeDistM, tileEdgeDistM, storeys, bays, passed, profiles: { rowOpen: [...rowOpen].map(v => Math.round(v * 100) / 100), rowDark: [...rowDark].map(v => Math.round(v * 10) / 10), colOpen: [...colOpen].map(v => Math.round(v * 100) / 100), colDark: [...colDark].map(v => Math.round(v * 10) / 10) }, why: `lattice correlation of the plate with F's openings ${latticeNcc.toFixed(3)} (signed ${signed.toFixed(3)}, unsigned ${unsigned.toFixed(3)}; the tile's ${tileNcc.toFixed(3)}; needs ${needNcc.toFixed(3)})${nccOk ? '' : ': the plate does not show F\'s lattice'}; edges ${Number.isFinite(edgeDistM) ? edgeDistM.toFixed(3) : 'n/a'} m from F's opening borders (the tile's ${Number.isFinite(tileEdgeDistM) ? tileEdgeDistM.toFixed(3) : 'n/a'} m; at most ${needEdge.toFixed(3)})${edgeOk ? '' : ': the plate\'s edges lie elsewhere'}; ${say('storeys', storeys)}; ${say('bays', bays)}` };
}

export interface FeatureRegionPx { label: string; types: string[]; confidence: number; x0: number; y0: number; x1: number; y1: number }

/** The reading's feature regions on one wall, from per-mille of its picture (ruler at the left) to the texture frame. */
export function featureRegionsOnWall(features: ReadFeature[] | undefined, f: MassingFace, rulerPx = WALL_PICTURE_RULER_PX): FeatureRegionPx[] {
    const out: FeatureRegionPx[] = [];
    const PW = f.width + rulerPx;
    for (const r of features ?? []) {
        if (r.faceKey !== f.key) continue;
        const x0 = Math.max(0, Math.round((r.box[0] / 1000) * PW) - rulerPx), x1 = Math.min(f.width, Math.round((r.box[2] / 1000) * PW) - rulerPx);
        const y0 = Math.max(0, Math.round((r.box[1] / 1000) * f.height)), y1 = Math.min(f.height, Math.round((r.box[3] / 1000) * f.height));
        if (x1 - x0 < 2 || y1 - y0 < 2) continue;
        out.push({ label: r.label, types: r.types, confidence: r.confidence, x0, y0, x1, y1 });
    }
    return out;
}

export interface FeatureVerdict extends FeatureRegionPx { ncc: number; nccPhoto?: number; contrastRatio: number; toneDe: number; photoCover: number; kept: boolean; why: string }

function boxNcc(a: Float32Array, b: Float32Array, use: Uint8Array, W: number, H: number, r: FeatureRegionPx, dx: number, dy: number): { ncc: number; ca: number; cb: number } {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) {
        const i = y * W + x, xs = Math.min(W - 1, Math.max(0, x + dx)), ys = Math.min(H - 1, Math.max(0, y + dy)), j = ys * W + xs;
        if (!use[i] || !use[j]) continue;
        const u = a[i], v = b[j];
        if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
        sa += u; sb += v; saa += u * u; sbb += v * v; sab += u * v; n++;
    }
    if (n < 16) return { ncc: NaN, ca: 0, cb: 0 };
    const ma = sa / n, mb = sb / n, va = Math.max(0, saa / n - ma * ma), vb = Math.max(0, sbb / n - mb * mb);
    return { ncc: va > 1e-6 && vb > 1e-6 ? (sab / n - ma * mb) / Math.sqrt(va * vb) : NaN, ca: Math.sqrt(va), cb: Math.sqrt(vb) };
}

/** Mean CIELAB over a box of blurred planes, lightness weighted, of the difference between two images. */
function boxToneDe(inLab: Float32Array[], outLab: Float32Array[], use: Uint8Array, W: number, r: FeatureRegionPx): number {
    const mi = [0, 0, 0], mo = [0, 0, 0];
    let n = 0;
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) {
        const i = y * W + x;
        if (!use[i]) continue;
        for (let c = 0; c < 3; c++) { mi[c] += inLab[c][i]; mo[c] += outLab[c][i]; }
        n++;
    }
    if (!n) return NaN;
    let s = 0;
    for (let c = 0; c < 3; c++) { const d = (mo[c] - mi[c]) / n * (c ? 1 : LIGHTNESS_WEIGHT); s += d * d; }
    return Math.sqrt(s);
}

/**
 * The must-keep feature guard: each region of the wall checked on the plate against the tile (and, where it covers the
 * region, the rectified Street View crop). The plate is rejected when any region is not kept.
 */
export function featureGuard(input: Uint8Array, plate: Uint8Array, W: number, H: number, use: Uint8Array, pixelM: number, regions: FeatureRegionPx[], photo?: { rgba: Uint8Array; valid: Uint8Array }): { kept: boolean; regions: FeatureVerdict[]; why: string } {
    if (!regions.length) return { kept: true, regions: [], why: 'no must-keep feature on this wall' };
    const [Li, Ai, Bi] = labPlanes(input, W * H), [Lo, Ao, Bo] = labPlanes(plate, W * H);
    const bi = bandPass(Li, use, W, H, pixelM), bo = bandPass(Lo, use, W, H, pixelM);
    const r = Math.max(2, Math.round(0.4 / pixelM));
    const inLab = [maskedBlur(Li, use, W, H, r), maskedBlur(Ai, use, W, H, r), maskedBlur(Bi, use, W, H, r)], outLab = [maskedBlur(Lo, use, W, H, r), maskedBlur(Ao, use, W, H, r), maskedBlur(Bo, use, W, H, r)];
    let photoBand: Float32Array | undefined;
    if (photo) {
        const Lp = new Float32Array(W * H);
        for (let i = 0; i < W * H; i++) { const l = linearToLab(SRGB8_TO_LINEAR[photo.rgba[i * 4]], SRGB8_TO_LINEAR[photo.rgba[i * 4 + 1]], SRGB8_TO_LINEAR[photo.rgba[i * 4 + 2]]); Lp[i] = l[0]; }
        photoBand = bandPass(Lp, photo.valid, W, H, pixelM);
    }
    const R = Math.round(AUDIT_DRIFT_M / pixelM), step = Math.max(1, Math.round(AUDIT_DRIFT_STEP_M / pixelM));
    const out: FeatureVerdict[] = [];
    for (const reg of regions) {
        let best = boxNcc(bi, bo, use, W, H, reg, 0, 0);
        let bestNcc = best.ncc;
        for (let dy = -R; dy <= R; dy += step) for (let dx = -R; dx <= R; dx += step) {
            if (!dx && !dy) continue;
            const c = boxNcc(bi, bo, use, W, H, reg, dx, dy);
            const v = c.ncc - DRIFT_NCC_PENALTY;
            if (Number.isFinite(v) && !(v <= bestNcc)) { bestNcc = v; best = { ...c, ncc: v }; }
        }
        const contrastRatio = best.ca > 1e-6 ? best.cb / best.ca : 1;
        const toneDe = boxToneDe(inLab, outLab, use, W, reg);
        let photoCover = 0, nccPhoto: number | undefined;
        if (photo && photoBand) {
            let n = 0, v = 0;
            for (let y = reg.y0; y < reg.y1; y++) for (let x = reg.x0; x < reg.x1; x++) { n++; if (photo.valid[y * W + x]) v++; }
            photoCover = n ? v / n : 0;
            if (photoCover >= FEATURE_PHOTO_COVER) {
                let bp = boxNcc(photoBand, bo, photo.valid, W, H, reg, 0, 0).ncc;
                for (let dy = -R; dy <= R; dy += step) for (let dx = -R; dx <= R; dx += step) { if (!dx && !dy) continue; const c = boxNcc(photoBand, bo, photo.valid, W, H, reg, dx, dy).ncc - DRIFT_NCC_PENALTY; if (Number.isFinite(c) && !(c <= bp)) bp = c; }
                nccPhoto = bp;
            }
        }
        const structure = Number.isFinite(bestNcc) ? bestNcc : NaN;
        const vouched = nccPhoto !== undefined && nccPhoto >= FEATURE_KEEP_NCC;
        const toneOk = !(toneDe > FEATURE_MAX_TONE_DE);
        const structureOk = vouched || structure >= FEATURE_KEEP_NCC || (structure >= FEATURE_WEAK_NCC && contrastRatio >= FEATURE_KEEP_CONTRAST && toneOk);
        const contrastOk = vouched || contrastRatio >= ERASE_CONTRAST_RATIO;
        const kept = structureOk && contrastOk && toneOk;
        const why = `${reg.label} [${reg.types.join(' > ')}]: structure NCC ${Number.isFinite(structure) ? structure.toFixed(2) : 'n/a'}${nccPhoto !== undefined ? ` (Street View ${nccPhoto.toFixed(2)}, covering ${(100 * photoCover).toFixed(0)}%)` : ''}, contrast x${contrastRatio.toFixed(2)}, tone ${Number.isFinite(toneDe) ? toneDe.toFixed(1) : 'n/a'} dE: ${kept ? 'kept' : !structureOk ? 'replaced by something else' : !contrastOk ? 'erased' : 'recoloured'}`;
        out.push({ ...reg, ncc: structure, ...(nccPhoto !== undefined ? { nccPhoto } : {}), contrastRatio, toneDe, photoCover, kept, why });
    }
    const lost = out.filter(x => !x.kept);
    return { kept: !lost.length, regions: out, why: lost.length ? `must-keep features lost: ${lost.map(x => x.why).join('; ')}` : `must-keep features kept: ${out.map(x => x.why).join('; ')}` };
}

/** What one candidate plate scored locally; `eligible` false carries why it is out. */
export interface CandidateScore {
    sample: number;
    eligible: boolean;
    why: string;
    latticeNcc?: number;
    photoSupport?: number;
    flaggedShare?: number;
    chamferPx?: number;
}

/** Ranks eligible candidates by local numbers only: lattice NCC, photo support, minus the audit's flagged share and the chamfer. */
export function candidateRank(c: CandidateScore): number {
    return (c.latticeNcc ?? 0) + 0.5 * (c.photoSupport ?? 0) - (c.flaggedShare ?? 0) - 0.1 * ((c.chamferPx ?? 0) / 6);
}

export function pickCandidate(cands: CandidateScore[]): { chosen?: CandidateScore; ranked: Array<CandidateScore & { rank: number }> } {
    const ranked = cands.map(c => ({ ...c, rank: c.eligible ? candidateRank(c) : -Infinity })).sort((a, b) => b.rank - a.rank || a.sample - b.sample);
    const chosen = ranked.find(c => c.eligible);
    return { ...(chosen ? { chosen } : {}), ranked };
}
