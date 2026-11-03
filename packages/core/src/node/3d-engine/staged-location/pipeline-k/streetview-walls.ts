/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K: the survey's Street View photos (© Google) laid on the facade planes, as evidence beside the orthos
 * (docs/research/2026-11-02-street-view-fusion-for-pipeline-k.md, step 1, Stage B; preregistered in
 * docs/processes/2026-11-03-k-streetview-walls-prereg.md). Report-only: nothing in the build reads what this writes.
 *
 *   - the views are the survey's own images, registered against the full tile mesh (edges, then jointly: the evidence
 *     stage's registration job, run on them) with the registered correction and warp on each camera; a view left at its
 *     nominal pose (about ±2 m) is written but refused, as pipeline E refuses it;
 *   - every view is resampled into each facade's ortho frame (facades.json: orthoSMin, orthoTMax, pixel), with three masks:
 *     coverage (the plane point lands in the photo, on the wall's front side), visibility (the full tile mesh rendered from
 *     the camera puts no nearer surface there) and ownership (streetview-ownership.ts: the photo shows this building), and
 *     per point the ground resolution (one photo pixel on the wall, m) and the angle off the wall's normal;
 *   - a view takes part on a wall only through pipeline E's agreement gate (street-view-texels.ts: sharper than the tile
 *     ortho by MIN_SHARPER within MAX_INCIDENCE_DEG of the normal, band-passed structure agreeing with the tile ortho at the
 *     best shift within MAX_SHIFT_M), and a phase check: on a repeating wall a pose a bay off agrees almost as well as the
 *     true one at zero shift, so the agreement is also searched further along each axis and the view refused where a
 *     farther shift agrees better;
 *   - per passing wall and view, its pier lines against the tile ortho's (ortho-rectify.ts traceLines), and two decoys: the
 *     view's eye moved one repeat of the wall each way, gated again (each must be refused).
 *
 * The capture date is never read. Nothing is generated: the rectified images are photo pixels on measured planes
 * (photo-inferred).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DecodedImage, PinholeCamera, ProjectionView } from '../../../../common/spatial/texture-pass-contracts';
import type { RenderMesh3D } from '../../../spatial/HeadlessMeshSilhouetteRenderer';
import { renderFrameDepth } from '../../../spatial/StreetViewPoseRegistrar';
import { decodePng } from '../../../texture-processing';
import type { ReliefFacade } from '../facade-lattice';
import { encodePng } from '../png-encode';
import { DEPTH_TOLERANCE_M } from '../pipeline-e/plate-streetview';
import { bandPass, labPlanes } from '../pipeline-e/plate-audit';
import { ERODE_M, MAX_INCIDENCE_DEG, MAX_SHIFT_M, MIN_AGREEMENT_NCC, MIN_AGREEMENT_TEXELS, MIN_SHARPER, MIN_TEXELS, structuralAgreement } from '../pipeline-e/street-view-texels';
import { runPanoRegistrationOffThread, type PanoRegistrationJob, type PanoRegistrationOutcome } from '../pano-registration-run';
import type { Registration } from '../pano-registration';
import type { SurveyResult } from '../face-survey';
import { dilateMask, maskIou, ownershipPrompts, ownViews, type OwnershipSegmenter, type ViewOwnershipRecord } from '../streetview-ownership';
import { trustedRegisteredPose } from '../streetview-registered-views';
import { projectionViewFromRegistered } from '../texture-projection-views';
import { axisPeriod, ORTHO_RECTIFY_PARAMS, traceLines, type Rgba, type TracedLine } from './ortho-rectify';

export const STREETVIEW_WALLS_VERSION = 'streetview-walls/1';

export const STREETVIEW_WALLS_PARAMS = {
    /** Pipeline E's gate (street-view-texels.ts), reused. */
    minSharper: MIN_SHARPER, maxIncidenceDeg: MAX_INCIDENCE_DEG, erodeM: ERODE_M, minTexels: MIN_TEXELS,
    minAgreementNcc: MIN_AGREEMENT_NCC, maxShiftM: MAX_SHIFT_M, minAgreementTexels: MIN_AGREEMENT_TEXELS,
    /** Visibility: the first surface along the ray lies within this of the plane point (pipeline E's DEPTH_TOLERANCE_M). */
    depthToleranceM: DEPTH_TOLERANCE_M,
    /** The phase check: the agreement searched at every pixel beyond the near search, to this reach along each axis (m, and at most this share of the wall's extent). */
    phaseReachM: 6, phaseReachShare: 1 / 3,
    /** A farther shift counts only where its overlap keeps this share of the overlap at the best near shift. */
    phaseMinOverlapShare: 0.5,
    /** Pier lines: a view line matches the tile line starting nearest it within this (m), sharing at least this many edge samples. */
    pierMatchM: 0.5, pierMinSamples: 4,
    /** The decoys' repeat is searched in this range (m) along the wall's width. */
    decoyPeriodMinM: 1.2, decoyPeriodMaxM: 10,
    /** Ground resolution in the _res PNG: grey levels per cm/px (capped at 255). */
    resLevelsPerCm: 4
};
export type StreetViewWallsParams = typeof STREETVIEW_WALLS_PARAMS;

/** Off unless SCRATCHBOX_K_STREETVIEW_WALLS=1 (the node graph's `remesh.streetViewWalls` turns it on for one build): report-only until judged. */
export const streetViewWallsByDefault = (env: NodeJS.ProcessEnv = process.env): boolean => env.SCRATCHBOX_K_STREETVIEW_WALLS?.trim() === '1';

/** A survey view as this step reads it: the photo, its registered camera and warp, what the tile mesh shows first, and its ownership mask. */
export interface WallView {
    id: string; panoId: string; camera: PinholeCamera; image: DecodedImage; warp?: ProjectionView['warp'];
    /** The full tile mesh rendered from the camera (distance along its forward axis); absent: nothing is visible. */
    depth?: Float32Array;
    /** 1 where the photo shows the structure (streetview-ownership.ts); absent: no pixel is owned. */
    ownerMask?: Uint8Array;
    registration: { method: string; residualM: number | null };
    ownership?: Pick<ViewOwnershipRecord, 'status' | 'prompts' | 'iou' | 'reason'>;
}

/** One view resampled into one facade's ortho frame. */
export interface RectifiedWall {
    width: number; height: number;
    /** The photo's colour where covered (alpha 255), else alpha 0. */
    rgba: Uint8Array;
    covered: Uint8Array; visible: Uint8Array; owned: Uint8Array;
    /** Photo pixels per metre on the wall (fx / z x cos), and the cosine of the angle off the normal; 0 where not covered. */
    pxPerM: Float32Array; cos: Float32Array;
    counts: { covered: number; visible: number; owned: number };
}

export interface PierLineReading {
    viewLines: number; tileLines: number; matched: number;
    /** The median over matched lines of each line's median |view - tile| (ortho px); null with no match. */
    medianPx: number | null;
    lines: Array<{ viewAt: number; tileAt: number; medianPx: number; samples: number }>;
}

export interface WallGate {
    pass: boolean; reason: string;
    /** Pipeline E's verdict alone (no phase check), for comparison. */
    ePass: boolean;
    qualifying: number;
    agreement: { ncc: number; dx: number; dy: number; texels: number } | null;
    phase?: { reachPx: [number, number]; bestFar: { ncc: number; dx: number; dy: number; texels: number } | null; refused: boolean };
}

export interface WallViewRecord {
    facadeId: number; view: string; panoId: string; registration: WallView['registration']; ownership?: WallView['ownership'];
    /** The images beside this file, for the walls and views the gate judged (at least minTexels qualifying points); null otherwise. */
    files: { image: string; masks: string; resolution: string } | null;
    counts: RectifiedWall['counts'] & { qualifying: number };
    /** What kept covered points from qualifying (each point counted once, by the first test it fails). */
    rejected: { owner: number; depth: number; incidence: number; coarse: number };
    /** Ground resolution (m per photo pixel) over the covered points: median, 10th and 90th percentile; the median angle off the normal (deg). */
    resolutionM: { p10: number; median: number; p90: number } | null; angleDeg: number | null;
    /** The tile ortho's resolution (m per pixel) for comparison. */
    tileM: number;
    gate: WallGate;
    /** Pier lines against the tile ortho's, after the gate's shift and before it (passing views only). */
    pierLines?: { shifted: PierLineReading; unshifted: PierLineReading };
    decoys?: Array<{ shiftM: number; gate: WallGate; ownershipIou: number | null }>;
}

export interface StreetViewWallsFile {
    version: string; params: StreetViewWallsParams; label: 'photo-inferred'; dir: string; runId?: string;
    views: Array<{ id: string; panoId: string; registration: WallView['registration']; ownership?: WallView['ownership'] }>;
    walls: WallViewRecord[];
    summary: { facades: number; pairs: number; passing: number; refusedBy: Record<string, number>; decoys: number; decoysPassing: number; ePassingDecoys: number; pierLines: { matched: number; medianPx: number | null } };
    ms: number;
}

const median = (a: number[]) => { if (!a.length) return NaN; const v = [...a].sort((x, y) => x - y), m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

/** The view resampled into the facade's ortho frame: colour, the three masks, and per point the resolution and the angle (see the file comment). */
export function rectifyOntoFacade(f: ReliefFacade, v: Pick<WallView, 'camera' | 'image' | 'warp' | 'depth' | 'ownerMask'>, P: StreetViewWallsParams = STREETVIEW_WALLS_PARAMS): RectifiedWall {
    const W = f.width, H = f.height, N = W * H, cam = v.camera, img = v.image;
    const rgba = new Uint8Array(N * 4), covered = new Uint8Array(N), visible = new Uint8Array(N), owned = new Uint8Array(N);
    const pxPerM = new Float32Array(N), cosA = new Float32Array(N);
    const counts = { covered: 0, visible: 0, owned: 0 };
    const c = f.centroid, aS = f.axisS, aT = f.axisT, n = f.normal, e = cam.eye;
    for (let y = 0; y < H; y++) {
        const t = f.orthoTMax - (y + 0.5) * f.pixel;
        for (let x = 0; x < W; x++) {
            const s = f.orthoSMin + (x + 0.5) * f.pixel;
            const px = c[0] + aS[0] * s + aT[0] * t, py = c[1] + aS[1] * s + aT[1] * t, pz = c[2] + aS[2] * s + aT[2] * t;
            const tx = e[0] - px, ty = e[1] - py, tz = e[2] - pz, dist = Math.hypot(tx, ty, tz);
            const cos = (tx * n[0] + ty * n[1] + tz * n[2]) / dist;
            if (!(cos > 0)) continue;
            const dx = -tx, dy = -ty, dz = -tz;
            const z = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
            if (z < 0.5) continue;
            const u0 = cam.cx + (cam.fx * (dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2])) / z;
            const w0 = cam.cy - (cam.fy * (dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2])) / z;
            if (!(u0 >= 1 && w0 >= 1 && u0 < cam.width - 2 && w0 < cam.height - 2)) continue;
            let u = u0, w = w0;
            if (v.warp) {
                const g = v.warp, gx = Math.max(0, Math.min(g.gw - 1, (u / cam.width) * (g.gw - 1))), gy = Math.max(0, Math.min(g.gh - 1, (w / cam.height) * (g.gh - 1)));
                const i0 = Math.min(g.gw - 2, Math.floor(gx)), j0 = Math.min(g.gh - 2, Math.floor(gy)), a = gx - i0, b = gy - j0;
                const lerp = (arr: Float32Array) => (1 - a) * (1 - b) * arr[j0 * g.gw + i0] + a * (1 - b) * arr[j0 * g.gw + i0 + 1] + (1 - a) * b * arr[(j0 + 1) * g.gw + i0] + a * b * arr[(j0 + 1) * g.gw + i0 + 1];
                u = Math.max(0, Math.min(cam.width - 1.001, u + lerp(g.dx))); w = Math.max(0, Math.min(cam.height - 1.001, w + lerp(g.dy)));
            }
            const i = y * W + x;
            covered[i] = 1; counts.covered++;
            pxPerM[i] = (cam.fx / z) * cos; cosA[i] = cos;
            // visibility is read where the pose puts the point (the depth is rendered from the pose), ownership and colour where the photo shows it
            if (v.depth && Math.abs(v.depth[Math.floor(w0) * cam.width + Math.floor(u0)] - z) < P.depthToleranceM) { visible[i] = 1; counts.visible++; }
            if (v.ownerMask?.[Math.floor(w) * cam.width + Math.floor(u)]) { owned[i] = 1; counts.owned++; }
            const x0 = Math.floor(u), y0 = Math.floor(w), fx = u - x0, fy = w - y0, iw = img.width;
            for (let k = 0; k < 3; k++) {
                const p = (xx: number, yy: number) => img.rgba[(yy * iw + xx) * 4 + k];
                rgba[i * 4 + k] = Math.round((p(x0, y0) * (1 - fx) + p(x0 + 1, y0) * fx) * (1 - fy) + (p(x0, y0 + 1) * (1 - fx) + p(x0 + 1, y0 + 1) * fx) * fy);
            }
            rgba[i * 4 + 3] = 255;
        }
    }
    return { width: W, height: H, rgba, covered, visible, owned, pxPerM, cos: cosA, counts };
}

/** 1 where a tile ortho pixel is the photo's (not transparent, not tile_refine's uncovered grey). */
export function tileCovered(tile: Rgba): Uint8Array {
    const N = tile.width * tile.height, out = new Uint8Array(N);
    for (let i = 0; i < N; i++) out[i] = tile.rgba[i * 4 + 3] > 0 && !(tile.rgba[i * 4] === 128 && tile.rgba[i * 4 + 1] === 128 && tile.rgba[i * 4 + 2] === 128) ? 1 : 0;
    return out;
}

/** The tile ortho's band-passed luma over its covered pixels (the agreement's reference, once per facade). */
export function tileBandPass(tile: Rgba, use: Uint8Array, pixelM: number): Float32Array {
    return bandPass(labPlanes(tile.rgba, tile.width * tile.height)[0], use, tile.width, tile.height, pixelM);
}

/** The points a view may be read at: covered, visible, owned, within the incidence limit and sharper than the tile, eroded (pipeline E's rule). */
export function qualifyingMask(f: Pick<ReliefFacade, 'pixel'>, r: RectifiedWall, P: StreetViewWallsParams = STREETVIEW_WALLS_PARAMS): { mask: Uint8Array; rejected: { owner: number; depth: number; incidence: number; coarse: number } } {
    const N = r.width * r.height, raw = new Uint8Array(N), minCos = Math.cos((P.maxIncidenceDeg * Math.PI) / 180), minPpm = P.minSharper / f.pixel;
    const rejected = { owner: 0, depth: 0, incidence: 0, coarse: 0 };
    for (let i = 0; i < N; i++) {
        if (!r.covered[i]) continue;
        if (r.cos[i] < minCos) { rejected.incidence++; continue; }
        if (!r.visible[i]) { rejected.depth++; continue; }
        if (!r.owned[i]) { rejected.owner++; continue; }
        if (r.pxPerM[i] < minPpm) { rejected.coarse++; continue; }
        raw[i] = 1;
    }
    // eroded by its own edge (the mask's edge, the texel's own blur); the frame's border is not an edge
    const rad = Math.max(1, Math.round(P.erodeM / f.pixel)), inv = new Uint8Array(N);
    for (let i = 0; i < N; i++) inv[i] = raw[i] ? 0 : 1;
    const grown = dilateMask(inv, r.width, r.height, rad), mask = new Uint8Array(N);
    for (let i = 0; i < N; i++) mask[i] = raw[i] && !grown[i] ? 1 : 0;
    return { mask, rejected };
}

/**
 * Band-passed luma NCC of the photo against the tile over the overlap at one shift (photo texel (x, y) against tile texel
 * (x + dx, y + dy), as structuralAgreement pairs them), over `samples`: the photo's qualifying texels on every other row
 * and column (each counts for four).
 */
function nccAt(bp: Float32Array, samples: Int32Array, bw: Float32Array, use: Uint8Array, W: number, H: number, dx: number, dy: number): { ncc: number; texels: number } {
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let k = 0; k < samples.length; k++) {
        const j = samples[k], x = (j % W) + dx, y = ((j / W) | 0) + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x;
        if (!use[i]) continue;
        const a = bw[i], b = bp[j];
        n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
    }
    if (!n) return { ncc: -1, texels: 0 };
    const va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
    return { ncc: va > 1e-6 && vb > 1e-6 ? (sab / n - (sa / n) * (sb / n)) / Math.sqrt(va * vb) : -1, texels: n * 4 };
}

/**
 * Pipeline E's agreement gate for one wall and view, and the phase check (file comment). `registered`: the view's pose was
 * registered against the tile mesh; a nominal pose is refused whatever it agrees.
 */
export function gateWall(f: Pick<ReliefFacade, 'pixel' | 'sMin' | 'sMax' | 'tMin' | 'tMax'>, tile: Rgba, use: Uint8Array, r: RectifiedWall, qual: Uint8Array, registered: boolean, P: StreetViewWallsParams = STREETVIEW_WALLS_PARAMS, tileBand?: Float32Array): WallGate {
    const W = r.width, H = r.height;
    let qualifying = 0;
    for (let i = 0; i < qual.length; i++) qualifying += qual[i];
    const refuse = (reason: string, extra: Partial<WallGate> = {}): WallGate => ({ pass: false, ePass: false, reason, qualifying, agreement: null, ...extra });
    if (qualifying < P.minTexels) return refuse(`${qualifying} points qualify (covered, visible, owned, within ${P.maxIncidenceDeg} degrees of the normal and ${P.minSharper}x sharper than the tile; at least ${P.minTexels} needed)`);
    const ag = structuralAgreement(r.rgba, qual, tile.rgba, use, W, H, f.pixel);
    if (!ag) return refuse(`too little overlap with the tile ortho's own pixels to check it against them (under ${P.minAgreementTexels})`);
    const R = Math.max(1, Math.round(P.maxShiftM / f.pixel));
    const atLimit = Math.abs(ag.dx) >= R || Math.abs(ag.dy) >= R;
    const ePass = ag.ncc >= P.minAgreementNcc && !atLimit;
    const eWhy = atLimit ? `its best agreement with the wall (${ag.ncc.toFixed(2)}) lies at the ${P.maxShiftM} m limit of the shift search (${ag.dx}, ${ag.dy} px)`
        : ag.ncc < P.minAgreementNcc ? `its structure correlates ${ag.ncc.toFixed(2)} with the tile ortho's over ${ag.texels} pixels (at least ${P.minAgreementNcc} needed)` : '';
    // the phase check: along each axis (the other held at the best near shift), every pixel beyond the near search, to the reach
    const bp = bandPass(labPlanes(r.rgba, W * H)[0], qual, W, H, f.pixel), bw = tileBand ?? tileBandPass(tile, use, f.pixel);
    const pick: number[] = [];
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (qual[y * W + x]) pick.push(y * W + x);
    const samples = Int32Array.from(pick);
    const near = nccAt(bp, samples, bw, use, W, H, ag.dx, ag.dy);
    const reachPx: [number, number] = [
        Math.round(Math.min(P.phaseReachM, P.phaseReachShare * (f.sMax - f.sMin)) / f.pixel),
        Math.round(Math.min(P.phaseReachM, P.phaseReachShare * (f.tMax - f.tMin)) / f.pixel)
    ];
    const minOverlap = Math.max(P.minAgreementTexels, P.phaseMinOverlapShare * near.texels);
    let bestFar: { ncc: number; dx: number; dy: number; texels: number } | null = null;
    for (const axis of [0, 1] as const) {
        for (let d = R + 1; d <= reachPx[axis]; d++) for (const sgn of [-1, 1]) {
            const dx = axis === 0 ? ag.dx + sgn * d : ag.dx, dy = axis === 1 ? ag.dy + sgn * d : ag.dy;
            const c = nccAt(bp, samples, bw, use, W, H, dx, dy);
            if (c.texels < minOverlap) continue;
            if (!bestFar || c.ncc > bestFar.ncc) bestFar = { ncc: c.ncc, dx, dy, texels: c.texels };
        }
    }
    const phaseRefused = !!bestFar && bestFar.ncc > near.ncc;
    if (bestFar) bestFar.ncc = round(bestFar.ncc);
    const phase = { reachPx, bestFar, refused: phaseRefused };
    const agreement = { ncc: ag.ncc, dx: ag.dx, dy: ag.dy, texels: ag.texels };
    if (!registered) return { pass: false, ePass, reason: 'a nominal pose (about ±2 m): never used (pipeline E\'s rule)', qualifying, agreement, phase };
    if (!ePass) return { pass: false, ePass, reason: eWhy, qualifying, agreement, phase };
    if (phaseRefused) return { pass: false, ePass, reason: `the wall agrees better (${bestFar!.ncc.toFixed(2)} against ${near.ncc.toFixed(2)}) at a shift of ${round(Math.hypot(bestFar!.dx, bestFar!.dy) * f.pixel, 2)} m: the pose may be a repeat or more off`, qualifying, agreement, phase };
    return { pass: true, ePass, reason: `agrees ${ag.ncc.toFixed(2)} at a shift of (${ag.dx}, ${ag.dy}) px; no farther shift agrees better (best ${bestFar ? bestFar.ncc.toFixed(2) : 'none'})`, qualifying, agreement, phase };
}

/** `a` moved by (dx, dy) texels: out(x, y) = a(x - dx, y - dy), `ch` channels per texel; zero where nothing moves in. */
export function shiftPlane<T extends Uint8Array | Float32Array>(a: T, W: number, H: number, dx: number, dy: number, ch: number): T {
    const out = new (a.constructor as new (n: number) => T)(a.length);
    for (let y = 0; y < H; y++) {
        const sy = y - dy;
        if (sy < 0 || sy >= H) continue;
        for (let x = 0; x < W; x++) {
            const sx = x - dx;
            if (sx < 0 || sx >= W) continue;
            for (let c = 0; c < ch; c++) out[(y * W + x) * ch + c] = a[(sy * W + sx) * ch + c];
        }
    }
    return out;
}

/** The view's pier lines (vertical lines, traceLines) against the tile ortho's: each view line matched to the tile line starting nearest it. */
export function pierLineOffsets(tile: Rgba, view: Rgba, pixelM: number, P: StreetViewWallsParams = STREETVIEW_WALLS_PARAMS, tileLines?: TracedLine[]): PierLineReading {
    const TP = { ...ORTHO_RECTIFY_PARAMS, traceHorizontal: false };
    const tl = tileLines ?? traceLines(tile, pixelM, TP), vl = traceLines(view, pixelM, TP);
    const maxPx = P.pierMatchM / pixelM, lines: PierLineReading['lines'] = [];
    for (const l of vl) {
        let best: TracedLine | undefined;
        for (const t of tl) if (Math.abs(t.at - l.at) <= maxPx && (!best || Math.abs(t.at - l.at) < Math.abs(best.at - l.at))) best = t;
        if (!best) continue;
        const d: number[] = [];
        // both traces sample the same rows (the same image height and step)
        for (let k = 0; k < Math.min(l.along.length, best.along.length); k++) if (l.weight[k] > 0 && best.weight[k] > 0) d.push(Math.abs(l.across[k] - best.across[k]));
        if (d.length < P.pierMinSamples) continue;
        lines.push({ viewAt: l.at, tileAt: best.at, medianPx: round(median(d), 2), samples: d.length });
    }
    return { viewLines: vl.length, tileLines: tl.length, matched: lines.length, medianPx: lines.length ? round(median(lines.map(x => x.medianPx)), 2) : null, lines };
}

/** The view with only its qualifying points kept (the rest transparent, so traceLines reads nothing there), moved by the gate's shift. */
function qualifiedImage(r: RectifiedWall, qual: Uint8Array, dx: number, dy: number): Rgba {
    const out = new Uint8Array(r.rgba);
    for (let i = 0; i < qual.length; i++) if (!qual[i]) out[i * 4 + 3] = 0;
    return { width: r.width, height: r.height, rgba: dx || dy ? shiftPlane(out, r.width, r.height, dx, dy, 4) : out };
}

/** The camera with its eye moved `m` metres along `axis`. */
export function movedCamera(cam: PinholeCamera, axis: ArrayLike<number>, m: number): PinholeCamera {
    return { ...cam, eye: [cam.eye[0] + axis[0] * m, cam.eye[1] + axis[1] * m, cam.eye[2] + axis[2] * m] };
}

/** Whether any of a coarse grid of the facade's points lands in the view's frame, in front of the camera, on the wall's front side. */
function mayCover(f: ReliefFacade, cam: PinholeCamera): boolean {
    const e = cam.eye;
    for (let a = 0; a <= 8; a++) for (let b = 0; b <= 8; b++) {
        const s = f.sMin + ((f.sMax - f.sMin) * a) / 8, t = f.tMin + ((f.tMax - f.tMin) * b) / 8;
        const p = [0, 1, 2].map(k => f.centroid[k] + f.axisS[k] * s + f.axisT[k] * t);
        const d = [p[0] - e[0], p[1] - e[1], p[2] - e[2]];
        if (-(d[0] * f.normal[0] + d[1] * f.normal[1] + d[2] * f.normal[2]) <= 0) continue;
        const z = d[0] * cam.fwd[0] + d[1] * cam.fwd[1] + d[2] * cam.fwd[2];
        if (z < 0.5) continue;
        const u = cam.cx + (cam.fx * (d[0] * cam.right[0] + d[1] * cam.right[1] + d[2] * cam.right[2])) / z, v = cam.cy - (cam.fy * (d[0] * cam.up[0] + d[1] * cam.up[1] + d[2] * cam.up[2])) / z;
        if (u >= 0 && v >= 0 && u < cam.width && v < cam.height) return true;
    }
    return false;
}

const fileId = (s: string) => s.replace(/[^\w-]/g, '_');

/**
 * Lays every view on every facade of tile_refine's orthos (`tileOrthosDir`: facades.json and the facade images as it wrote
 * them), gates each wall and view, reads the passing ones' pier lines and decoys, and writes the images and
 * streetview_walls.json into `outDir` (emptied first). `tileMesh` renders the decoys' depth, `structure` their ownership
 * agreement; without `tileMesh` no decoy is made.
 */
export async function streetViewWalls(input: {
    tileOrthosDir: string; outDir: string; views: WallView[]; tileMesh?: RenderMesh3D; structure?: RenderMesh3D;
    params?: StreetViewWallsParams; runId?: string; signal?: AbortSignal; onProgress?: (m: string) => void;
}): Promise<StreetViewWallsFile> {
    const t0 = Date.now(), P = input.params ?? STREETVIEW_WALLS_PARAMS;
    const facades = (JSON.parse(fs.readFileSync(path.join(input.tileOrthosDir, 'facades.json'), 'utf8')) as { facades: ReliefFacade[] }).facades;
    fs.rmSync(input.outDir, { recursive: true, force: true });
    fs.mkdirSync(input.outDir, { recursive: true });
    const walls: WallViewRecord[] = [];
    const refusedBy: Record<string, number> = {};
    let done = 0;
    for (const f of facades) {
        // a facade at a time, the thread let go between them (the build's other stages keep their calls answered)
        await new Promise(res => setImmediate(res));
        if (input.signal?.aborted) throw input.signal.reason ?? new Error('stopped');
        const file = path.join(input.tileOrthosDir, f.image);
        const seen = input.views.filter(v => mayCover(f, v.camera));
        if (!seen.length || !fs.existsSync(file)) continue;
        const d = decodePng(fs.readFileSync(file));
        const tile: Rgba = { width: d.width, height: d.height, rgba: new Uint8Array(d.rgba) };
        if (tile.width !== f.width || tile.height !== f.height) continue;
        const use = tileCovered(tile);
        let tileLines: TracedLine[] | undefined, tileBand: Float32Array | undefined, period: number | null | undefined;
        for (const v of seen) {
            const r = rectifyOntoFacade(f, v, P);
            if (!r.counts.covered) continue;
            const N = r.width * r.height, ppm: number[] = [], ang: number[] = [];
            for (let i = 0; i < N; i += 7) if (r.covered[i]) { ppm.push(1 / r.pxPerM[i]); ang.push((Math.acos(Math.min(1, r.cos[i])) * 180) / Math.PI); }
            ppm.sort((a, b) => a - b);
            const registered = v.registration.method === 'edges' || v.registration.method === 'joint';
            const q = qualifyingMask(f, r, P);
            let qualifying = 0;
            for (let i = 0; i < N; i++) qualifying += q.mask[i];
            if (qualifying >= P.minTexels) tileBand ??= tileBandPass(tile, use, f.pixel);
            const gate = gateWall(f, tile, use, r, q.mask, registered, P, tileBand);
            // the images, for the walls and views the gate judges (a view that resolves no part of the wall finer than the tile, or
            // sees none of it clear and owned, carries no evidence for it: its counts and reasons are recorded, without images)
            let files: WallViewRecord['files'] = null;
            if (qualifying >= P.minTexels) {
                const stem = `sv_${f.facadeId}_${fileId(v.id)}`;
                files = { image: `${stem}.png`, masks: `${stem}_masks.png`, resolution: `${stem}_res.png` };
                const masks = new Uint8Array(N * 3), res = new Uint8Array(N);
                for (let i = 0; i < N; i++) {
                    masks[i * 3] = r.covered[i] * 255; masks[i * 3 + 1] = r.visible[i] * 255; masks[i * 3 + 2] = r.owned[i] * 255;
                    if (r.covered[i]) res[i] = Math.min(255, Math.max(1, Math.round((100 / r.pxPerM[i]) * P.resLevelsPerCm)));
                }
                fs.writeFileSync(path.join(input.outDir, files.image), encodePng(r.width, r.height, r.rgba, 4));
                fs.writeFileSync(path.join(input.outDir, files.masks), encodePng(r.width, r.height, masks, 3));
                fs.writeFileSync(path.join(input.outDir, files.resolution), encodePng(r.width, r.height, res, 1));
            }
            const key = gate.pass ? 'passed' : !registered ? 'nominal pose' : gate.qualifying < P.minTexels ? `too few qualifying points (${(Object.entries(q.rejected).sort((a, b) => b[1] - a[1])[0] ?? ['none'])[0]})` : !gate.agreement ? 'no overlap' : !gate.ePass ? 'agreement' : 'phase check';
            refusedBy[key] = (refusedBy[key] ?? 0) + 1;
            const rec: WallViewRecord = {
                facadeId: f.facadeId, view: v.id, panoId: v.panoId, registration: v.registration, ...(v.ownership ? { ownership: v.ownership } : {}), files, counts: { ...r.counts, qualifying }, rejected: q.rejected,
                resolutionM: ppm.length ? { p10: round(quantile(ppm, 0.1)), median: round(quantile(ppm, 0.5)), p90: round(quantile(ppm, 0.9)) } : null, angleDeg: ang.length ? round(median(ang), 1) : null,
                tileM: round(f.pixel, 4), gate
            };
            if (gate.pass && gate.agreement) {
                tileLines ??= traceLines(tile, f.pixel, { ...ORTHO_RECTIFY_PARAMS, traceHorizontal: false });
                rec.pierLines = {
                    shifted: pierLineOffsets(tile, qualifiedImage(r, q.mask, gate.agreement.dx, gate.agreement.dy), f.pixel, P, tileLines),
                    unshifted: pierLineOffsets(tile, qualifiedImage(r, q.mask, 0, 0), f.pixel, P, tileLines)
                };
                // the decoys: the eye moved one repeat of the wall each way, everything else the view's own (its ownership mask too)
                if (input.tileMesh) {
                    if (period === undefined) { const p = axisPeriod(tile, f.pixel, 'x', P.decoyPeriodMinM, P.decoyPeriodMaxM); period = p ? p.periodPx * f.pixel : null; }
                    if (period) {
                        rec.decoys = [-1, 1].map(sgn => {
                            const cam = movedCamera(v.camera, f.axisS, sgn * period!);
                            const depth = renderFrameDepth(input.tileMesh!, cam);
                            const dr = rectifyOntoFacade(f, { camera: cam, image: v.image, ...(v.warp ? { warp: v.warp } : {}), depth, ...(v.ownerMask ? { ownerMask: v.ownerMask } : {}) }, P);
                            const dq = qualifyingMask(f, dr, P);
                            let iou: number | null = null;
                            if (input.structure && v.ownerMask) iou = round(maskIou(v.ownerMask, ownershipPrompts(renderFrameDepth(input.structure, cam), depth, cam.width, cam.height).target));
                            return { shiftM: round(sgn * period!, 2), gate: gateWall(f, tile, use, dr, dq.mask, true, P, tileBand), ownershipIou: iou };
                        });
                    }
                }
            }
            walls.push(rec);
        }
        input.onProgress?.(`Street View on the facade planes: ${++done} facades laid`);
    }
    const passing = walls.filter(w => w.gate.pass), decoys = walls.flatMap(w => w.decoys ?? []);
    const allLines = passing.flatMap(w => w.pierLines?.shifted.lines ?? []);
    return {
        version: STREETVIEW_WALLS_VERSION, params: P, label: 'photo-inferred', dir: input.outDir, ...(input.runId ? { runId: input.runId } : {}),
        views: input.views.map(v => ({ id: v.id, panoId: v.panoId, registration: v.registration, ...(v.ownership ? { ownership: v.ownership } : {}) })),
        walls,
        summary: {
            facades: new Set(walls.map(w => w.facadeId)).size, pairs: walls.length, passing: passing.length, refusedBy,
            decoys: decoys.length, decoysPassing: decoys.filter(d => d.gate.pass).length, ePassingDecoys: decoys.filter(d => d.gate.ePass).length,
            pierLines: { matched: allLines.length, medianPx: allLines.length ? round(median(allLines.map(l => l.medianPx)), 2) : null }
        },
        ms: Date.now() - t0
    };
}

/** One sentence of what the step found, for the build's legend. */
export function describeStreetViewWalls(r: StreetViewWallsFile): string {
    const s = r.summary, regd = r.views.filter(v => v.registration.method === 'edges' || v.registration.method === 'joint').length;
    const refused = Object.entries(s.refusedBy).filter(([k]) => k !== 'passed').map(([k, n]) => `${n} ${k}`).join(', ');
    return `Street View on the facade planes (${STREETVIEW_WALLS_VERSION}, report-only, © Google): ${r.views.length} survey photos, ${regd} registered against the tile mesh; ${s.pairs} walls and views laid, ${s.passing} through the agreement gate${refused ? ` (refused: ${refused})` : ''}`
        + `${s.pierLines.matched ? `; their pier lines ${s.pierLines.medianPx} px from the tile ortho's at the median over ${s.pierLines.matched}` : ''}${s.decoys ? `; ${s.decoysPassing} of ${s.decoys} decoys a repeat off passed` : ''}; nothing in the build reads them`;
}

/**
 * The survey's photos as WallViews: registered against the full tile mesh (`register`, default the evidence stage's job in
 * its worker; edges then jointly), the correction and warp on each camera, what the tile mesh shows first from it, and the
 * ownership masks (ownViews: the description only where the pose is not trusted). A registration that fails leaves the
 * nominal poses, said per view; no segmenter leaves no pixel owned.
 */
export async function surveyWallViews(input: {
    survey: Pick<SurveyResult, 'read'>; bytesOf: (imageIndex: number) => Buffer | undefined; tileGlb: string; tileMesh: RenderMesh3D; structure: RenderMesh3D;
    segment?: OwnershipSegmenter | false; target?: string;
    register?: (job: PanoRegistrationJob, opts: { signal?: AbortSignal; log?: (m: string) => void }) => Promise<PanoRegistrationOutcome>;
    signal?: AbortSignal; onProgress?: (m: string) => void;
}): Promise<{ views: WallView[]; registrationError?: string; ownership: ViewOwnershipRecord[] }> {
    const held = input.survey.read.flatMap(rd => {
        const bytes = input.bytesOf(rd.imageIndex);
        return bytes ? [{ id: `survey:${rd.imageIndex}`, bytes, widthPx: rd.widthPx, heightPx: rd.heightPx, view: rd.view }] : [];
    });
    if (!held.length) return { views: [], ownership: [] };
    let registration: Registration | undefined, registrationError: string | undefined;
    try {
        input.onProgress?.(`registering ${held.length} survey photos against the tile mesh`);
        registration = (await (input.register ?? runPanoRegistrationOffThread)({ images: held, meshFiles: [input.tileGlb], correspondences: [], faces: [] }, { ...(input.signal ? { signal: input.signal } : {}), ...(input.onProgress ? { log: input.onProgress } : {}) })).registration;
    } catch (err) {
        if (input.signal?.aborted) throw err;
        registrationError = err instanceof Error ? err.message : String(err);
    }
    let pviews: ProjectionView[] = held.map(h => {
        const correction = registration?.corrections.get(h.view.panoId);
        return projectionViewFromRegistered({
            view: { panoId: h.view.panoId, eye: h.view.eye, headingDeg: h.view.headingDeg, pitchDeg: h.view.pitchDeg, fovDeg: h.view.fovDeg, widthPx: h.widthPx, heightPx: h.heightPx, ...(correction ? { correction } : {}) },
            jpeg: h.bytes, ...(registration ? { registration } : {})
        });
    });
    let ownership: ViewOwnershipRecord[] = [];
    if (input.segment) {
        const own = await ownViews({
            views: pviews, structure: input.structure, context: input.tileMesh, segment: input.segment, concurrency: 4, ...(input.target ? { target: input.target } : {}),
            describe: v => !trustedRegisteredPose(registration, v.panoId), ...(input.signal ? { signal: input.signal } : {}), ...(input.onProgress ? { onProgress: input.onProgress } : {})
        });
        pviews = own.views;
        ownership = own.records;
    }
    const views = pviews.map((v, k): WallView => {
        const per = registration?.perPano.find(p => p.panoId === v.panoId);
        const rec = ownership[k];
        const h = held[k].view;
        return {
            id: `${v.panoId}_h${Math.round(h.headingDeg)}_p${Math.round(h.pitchDeg)}`, panoId: v.panoId, camera: v.camera, image: v.image, ...(v.warp ? { warp: v.warp } : {}),
            depth: renderFrameDepth(input.tileMesh, v.camera), ...(v.ownerMask ? { ownerMask: v.ownerMask } : {}),
            registration: { method: per?.method ?? 'nominal', residualM: per?.edgeResidualM ?? null },
            ...(rec ? { ownership: { status: rec.status, prompts: rec.prompts, ...(rec.iou !== undefined ? { iou: rec.iou } : {}), ...(rec.reason ? { reason: rec.reason } : {}) } } : {})
        };
    });
    return { views, ...(registrationError ? { registrationError } : {}), ownership };
}
