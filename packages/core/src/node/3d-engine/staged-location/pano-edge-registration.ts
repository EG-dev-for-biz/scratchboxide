/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Geometric pano registration: each Street View pano is posed against the scan itself, not against the stone's texture.
 *
 * The box registration (pano-registration.ts) poses the panos from pairs of vision-model boxes, good to about a metre, and the
 * per-chart texture alignment cannot do better on a facade of repeated coursing: a shift by one whole course matches as well as
 * the true one. The scan's own geometry has no such period. Here, per pano, the full photogrammetric tile mesh (the real
 * opening, statues, trees and the buildings behind) is rendered from the pose (HeadlessMeshSilhouetteRenderer, through
 * renderFrameDepth): its silhouette against empty space, its occluding contours (depth discontinuities) and its long straight
 * creases are matched against the photo's sky boundary and structural line segments through truncated, orientation-binned
 * distance transforms (a chamfer cost: StreetViewPoseRegistrar). The photo side is read at the scale of structural features:
 * the image is reduced, blurred and only long, strong segments are kept, so the joints between courses barely register.
 * The search is local around the box registration's pose (one metre, one degree) with the pose prior of the box solve.
 *
 * Whether the edge pose replaces the box pose is decided per pano by a measure neither pose was fitted to: the inter-view
 * agreement of image gradients through the scan (a point of the scan seen by two panos must show the same gradient in both).
 * The edge cost the edge pose minimised and the survey-box pairs the box pose minimised are both reported, never used to choose.
 */

import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import type { RenderMesh3D } from '../../spatial/HeadlessMeshSilhouetteRenderer';
import {
    gaussianBlur, luminance, projectToFrame, renderFrameDepth, sobel, StreetViewPoseRegistrar, TEXTURING_GATES, ZERO_CORRECTION,
    type CreaseSampleSet, type FrameCamera, type PanoRegistrationResult, type PoseCorrection, type RgbaImage
} from '../../spatial/StreetViewPoseRegistrar';
import { pairResidualM, type Correspondence, type Registration, type RegView } from './pano-registration';
import { decodeJpegInMemory } from './photo-palette';
import { castCamera, type CastFace } from './survey-casting';

/** One image of a pano, decoded, with the pose it was asked for. */
export interface EdgeRegFrame { key: string; view: RegView; image: RgbaImage }

/** The evidence stage's allowance for the geometric registration (about 1 s per pano live; the rest is left as it was). */
export const EDGE_REGISTRATION_BUDGET_MS = 90_000;
/** Images are registered at this width at most (the structural edges survive; the course joints blur out). */
export const EDGE_REG_MAX_WIDTH_PX = 900;
/** An edge pose must agree with the other panos better than the box pose by this much inter-view gradient NCC. */
export const EDGE_NCC_MARGIN = 0.01;
/** Blur of the luminance before the inter-view gradient agreement (px at the registration width): tolerant of the scan's coarse surface. */
export const INTER_VIEW_GRADIENT_SIGMA_PX = 3;
/**
 * Only views at least this wide register a pano (and judge it): a narrow close-up of a carved face shows little sky and
 * few structural edges, and live it left the fit at the truncation. The close-ups take their pano's pose.
 */
export const EDGE_REG_MIN_FOV_DEG = 50;
/** An edge pose whose median residual stays above this (px at the registration width) did not lock onto the scan. */
export const EDGE_MAX_RESIDUAL_PX = 5;
/** A pano's edge residual in metres is never stated below this: the edges pin the image, not the depth along the view. */
export const EDGE_RESIDUAL_FLOOR_M = 0.25;

const EMPTY_DEPTH = 1e8;

export interface EdgePanoOutcome {
    panoId: string;
    frames: number;
    prior: PoseCorrection;
    edge?: PoseCorrection;
    chosen: 'edges' | 'boxes';
    reason: string;
    /** Median edge residual (silhouette, else contour/crease), px at the registration width, at the prior and the edge pose. */
    edgeResidualPx: { prior: number | null; edge: number | null };
    /** The edge residual at the edge pose in metres at the frames' surface distance (floored at EDGE_RESIDUAL_FLOOR_M). */
    edgeResidualM?: number;
    skyIoU: { prior: number | null; edge: number | null };
    /** Held out: inter-view gradient NCC of this pano's frames with the other panos', and the box pairs' RMS that name it. */
    heldOut: { ncc: { boxes: number | null; edges: number | null }; boxRmsM: { boxes: number | null; edges: number | null }; nccSamples: number; boxPairs: number };
    atBound: string[];
    ms: number;
    /** The registrar's own gates (silhouette and sky IoU sanity checks), reported only. */
    gateReasons: string[];
}

export interface EdgeRegistrationResult {
    /** The box registration with every pano whose edge pose won replaced by it (same shape, so the consumers are unchanged). */
    registration: Registration;
    panos: EdgePanoOutcome[];
    /** Inter-view gradient NCC over all frame pairs, with the box poses and with the chosen poses. */
    ncc: { boxes: number | null; chosen: number | null; pairs: number };
    /** RMS of the box registration's used pairs with the box poses and with the chosen poses (held out for the edge poses). */
    boxRmsM: { boxes: number; chosen: number };
    ms: number;
    /** Panos not registered because the time ran out. */
    skipped: string[];
}

export interface EdgeRegistrationInput {
    frames: EdgeRegFrame[];
    /** The full photogrammetric tile mesh (tile frame). */
    mesh: RenderMesh3D;
    /** The box registration; its corrections are the start poses and the fallback. */
    prior?: Registration;
    correspondences?: Correspondence[];
    faces?: CastFace[];
    maxWidthPx?: number;
    budgetMs?: number;
    creases?: CreaseSampleSet;
    now?: () => number;
    log?: (m: string) => void;
}

/** Box-filtered reduction of an RGBA image to at most `maxW` wide (the same field of view, so the pinhole model holds). */
export function downscaleRgba(img: RgbaImage, maxW: number): RgbaImage {
    if (img.width <= maxW) return img;
    const s = img.width / maxW;
    const w = maxW, h = Math.max(1, Math.round(img.height / s));
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
        const y0 = Math.floor(y * s), y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * s)));
        for (let x = 0; x < w; x++) {
            const x0 = Math.floor(x * s), x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * s)));
            let r = 0, g = 0, b = 0, a = 0, n = 0;
            for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
                const k = (yy * img.width + xx) * 4;
                r += img.rgba[k]; g += img.rgba[k + 1]; b += img.rgba[k + 2]; a += img.rgba[k + 3]; n++;
            }
            const o = (y * w + x) * 4;
            out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
        }
    }
    return { width: w, height: h, rgba: out };
}

const camOf = (f: EdgeRegFrame, corr: PoseCorrection): FrameCamera => castCamera({ ...f.view, widthPx: f.image.width, heightPx: f.image.height, correction: corr });

/**
 * A correction from StreetViewPoseRegistrar is defined about its pano's first frame heading; it is stamped with that heading so
 * every frame of the pano is rendered with the same rigid rotation (castCamera reads it).
 */
function stamped(c: PoseCorrection, referenceHeadingDeg: number): PoseCorrection {
    return { dx: c.dx, dy: c.dy, dz: c.dz, dyawDeg: c.dyawDeg, dpitchDeg: c.dpitchDeg, drollDeg: c.drollDeg, referenceHeadingDeg };
}

interface GradFrame { f: EdgeRegFrame; grad: Float32Array }

/** Gradient magnitude of the blurred luminance, the quantity the inter-view agreement compares. */
function gradientOf(img: RgbaImage, sigma: number): Float32Array {
    return sobel(gaussianBlur(luminance(img.rgba, img.width, img.height), img.width, img.height, sigma), img.width, img.height).mag;
}

function bilinear(a: Float32Array, w: number, h: number, x: number, y: number): number {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) return NaN;
    const fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return a[i] * (1 - fx) * (1 - fy) + a[i + 1] * fx * (1 - fy) + a[i + w] * (1 - fx) * fy + a[i + w + 1] * fx * fy;
}

/**
 * Samples of the gradient agreement of frame `a` seen from frame `b` through the scan: every `stride`-th pixel of `a` that the
 * scan covers is lifted to the scan, projected into `b`, and kept when `b` sees that same point (its depth agrees).
 */
function pairSamples(a: GradFrame, camA: FrameCamera, depthA: Float32Array, b: GradFrame, camB: FrameCamera, depthB: Float32Array, stride: number, out: { x: number[]; y: number[] }): void {
    const wA = camA.width, hA = camA.height, wB = camB.width, hB = camB.height;
    const p: Vec3 = [0, 0, 0];
    for (let y = 1; y < hA - 1; y += stride) for (let x = 1; x < wA - 1; x += stride) {
        const d = depthA[y * wA + x];
        if (!(d > 0) || d >= EMPTY_DEPTH) continue;
        const u = (x + 0.5 - camA.cx) / camA.fx, v = (y + 0.5 - camA.cy) / camA.fy;
        for (let k = 0; k < 3; k++) p[k] = camA.eye[k] + d * (camA.fwd[k] + u * camA.right[k] - v * camA.up[k]);
        const q = projectToFrame(camB, p);
        if (!q) continue;
        const ub = q[0] - 0.5, vb = q[1] - 0.5;
        const ix = Math.round(ub), iy = Math.round(vb);
        if (ix < 1 || iy < 1 || ix >= wB - 1 || iy >= hB - 1) continue;
        const db = depthB[iy * wB + ix];
        if (!(db < EMPTY_DEPTH) || Math.abs(db - q[2]) > 0.03 * q[2] + 0.2) continue;
        const gb = bilinear(b.grad, wB, hB, ub, vb);
        if (!Number.isFinite(gb)) continue;
        out.x.push(a.grad[y * wA + x]); out.y.push(gb);
    }
}

function ncc(x: number[], y: number[]): number | null {
    const n = x.length;
    if (n < 200) return null;
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    mx /= n; my /= n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Inter-view gradient agreement through the scan, per pair of frames of different panos, under a set of corrections. */
export class InterViewAgreement {
    private readonly depth = new Map<string, Float32Array>();
    readonly frames: GradFrame[];
    constructor(frames: EdgeRegFrame[], private readonly mesh: RenderMesh3D, private readonly stride = 3, sigma = INTER_VIEW_GRADIENT_SIGMA_PX) {
        this.frames = frames.map(f => ({ f, grad: gradientOf(f.image, sigma) }));
    }
    private depthOf(g: GradFrame, corr: PoseCorrection): { cam: FrameCamera; depth: Float32Array } {
        const cam = camOf(g.f, corr);
        const key = `${g.f.key}|${corr.dx},${corr.dy},${corr.dz},${corr.dyawDeg},${corr.dpitchDeg},${corr.drollDeg},${corr.referenceHeadingDeg ?? ''}`;
        let d = this.depth.get(key);
        if (!d) { d = renderFrameDepth(this.mesh, cam); this.depth.set(key, d); }
        return { cam, depth: d };
    }
    /** NCC of the pairs that involve `panoId` (all pairs when undefined), and the sample count. */
    score(corr: (panoId: string) => PoseCorrection, panoId?: string): { ncc: number | null; samples: number; pairs: number } {
        let wsum = 0, nsum = 0, pairs = 0, samples = 0;
        for (let i = 0; i < this.frames.length; i++) for (let j = i + 1; j < this.frames.length; j++) {
            const a = this.frames[i], b = this.frames[j];
            if (a.f.view.panoId === b.f.view.panoId) continue;
            if (panoId && a.f.view.panoId !== panoId && b.f.view.panoId !== panoId) continue;
            const A = this.depthOf(a, corr(a.f.view.panoId)), B = this.depthOf(b, corr(b.f.view.panoId));
            const s = { x: [] as number[], y: [] as number[] };
            pairSamples(a, A.cam, A.depth, b, B.cam, B.depth, this.stride, s);
            pairSamples(b, B.cam, B.depth, a, A.cam, A.depth, this.stride, s);
            const r = ncc(s.x, s.y);
            if (r === null) continue;
            const w = Math.min(s.x.length, 5000);
            wsum += w; nsum += w * r; pairs++; samples += s.x.length;
        }
        return { ncc: wsum ? nsum / wsum : null, samples, pairs };
    }
}

const median = (v: number[]) => { if (!v.length) return NaN; const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const rms = (v: number[]) => (v.length ? Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length) : 0);
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Median edge residual of a pano's frames from the registrar's report (silhouette when measured, else line features). */
function edgeResidual(r: PanoRegistrationResult, which: 'initial' | 'final'): number | null {
    const v = r.frames.map(f => f[which].silhouetteMedianPx ?? f[which].creaseMedianPx).filter((x): x is number => x !== null && Number.isFinite(x));
    return v.length ? r3(median(v)) : null;
}
function skyIoUOf(r: PanoRegistrationResult, which: 'initial' | 'final'): number | null {
    const v = r.frames.map(f => f[which].skyIoU).filter((x): x is number => x !== null && Number.isFinite(x));
    return v.length ? r3(median(v)) : null;
}

/** The registrar's settings for structural edges at the registration width. */
export function edgeRegistrar(mesh: RenderMesh3D, creases?: CreaseSampleSet, log?: (m: string) => void): StreetViewPoseRegistrar {
    return new StreetViewPoseRegistrar(mesh, {
        bounds: { horizontalMeters: 5, verticalMeters: 0.7, yawDeg: 5, pitchDeg: 3, rollDeg: 1.5 },
        priors: { horizontalSigmaMeters: 2, verticalSigmaMeters: 0.5, angleSigmaDeg: 2 },
        gates: { ...TEXTURING_GATES, crossViewMedianPx: null, crossViewP75Px: null },
        classShares: { silhouette: 0.5, contour: 0.3, crease: 0.2 },
        // structural scale: blurred, long and strong segments only (course joints are short-period and weak)
        photo: { blurSigma: 2, magnitudeThreshold: 6, minLength: 30 },
        truncationPx: 12, coarseTruncationPx: 24,
        ...(log ? { log } : {})
    }, creases);
}

/**
 * Registers every pano of `frames` against the scan by its edges, then keeps per pano the pose (edge or box) that agrees better
 * with the other panos on the held-out measures.
 */
export function registerPanosByEdges(input: EdgeRegistrationInput): EdgeRegistrationResult {
    const now = input.now ?? Date.now;
    const t0 = now();
    const budget = input.budgetMs ?? 90_000;
    const maxW = input.maxWidthPx ?? EDGE_REG_MAX_WIDTH_PX;
    const frames = input.frames.filter(f => f.view.fovDeg >= EDGE_REG_MIN_FOV_DEG).map(f => ({ ...f, image: downscaleRgba(f.image, maxW) }));
    const prior = input.prior;
    const priorCorr = (id: string): PoseCorrection => prior?.corrections.get(id) ?? ZERO_CORRECTION;
    const registrar = edgeRegistrar(input.mesh, input.creases, input.log);
    const panoIds = [...new Set(frames.map(f => f.view.panoId))].sort();
    const edge = new Map<string, { res: PanoRegistrationResult; corr: PoseCorrection; ms: number }>();
    const skipped: string[] = [];
    for (const id of panoIds) {
        if (now() - t0 > budget) { skipped.push(id); continue; }
        const mine = frames.filter(f => f.view.panoId === id);
        const ts = now();
        const start = priorCorr(id);
        const res = registrar.registerPano({
            panoId: id, nominalEye: [mine[0].view.eye[0], mine[0].view.eye[1], mine[0].view.eye[2]],
            frames: mine.map(f => ({ key: f.key, image: f.image, headingDeg: f.view.headingDeg, pitchDeg: f.view.pitchDeg, fovDeg: f.view.fovDeg })),
            // the box pose seeds a local search (1 m, 1°); a pano the box solve set aside (or never saw) is searched from its stated pose
            ...(prior?.corrections.has(id) && !prior.setAside.some(s => s.panoId === id) ? { initialCorrection: { ...start } } : {})
        });
        edge.set(id, { res, corr: stamped(res.correction, mine[0].view.headingDeg), ms: now() - ts });
    }

    // held out: inter-view gradient agreement and the box pairs
    const agree = new InterViewAgreement(frames, input.mesh);
    const corrs = input.correspondences ?? [];
    const faces = input.faces ?? [];
    const usedPairs = prior ? corrs.filter(c => prior.pairs.find(p => p.id === c.id)?.used) : [];
    const chosen = new Map<string, PoseCorrection>();
    for (const id of panoIds) chosen.set(id, priorCorr(id));
    if (prior) for (const [id, c] of prior.corrections) if (!chosen.has(id)) chosen.set(id, c);
    const asMap = (over?: [string, PoseCorrection]) => { const m = new Map(chosen); if (over) m.set(over[0], over[1]); return m; };
    const boxRmsFor = (id: string, m: Map<string, PoseCorrection>): { rms: number | null; n: number } => {
        const mine = usedPairs.filter(c => c.a.view.panoId === id || c.b.view.panoId === id);
        const v = mine.map(c => pairResidualM(c, m, faces)).filter(Number.isFinite);
        return { rms: v.length ? r3(rms(v)) : null, n: v.length };
    };
    const outcomes = new Map<string, EdgePanoOutcome>();
    // the sweep starts from every edge pose that ended no worse than it started: a pano is judged against partners that are
    // themselves posed against the scan, not against the box poses the sweep is testing
    const usable = (id: string) => {
        const e = edge.get(id);
        if (!e) return false;
        const before = edgeResidual(e.res, 'initial'), after = edgeResidual(e.res, 'final');
        return after !== null && after <= EDGE_MAX_RESIDUAL_PX && !(before !== null && after >= before);
    };
    for (const id of panoIds) if (usable(id)) chosen.set(id, edge.get(id)!.corr);
    for (let sweep = 0; sweep < 2; sweep++) {
        for (const id of panoIds) {
            const e = edge.get(id);
            if (!e) continue;
            const boxC = priorCorr(id);
            const sBox = agree.score(p => (p === id ? boxC : chosen.get(p) ?? ZERO_CORRECTION), id);
            const sEdge = agree.score(p => (p === id ? e.corr : chosen.get(p) ?? ZERO_CORRECTION), id);
            const bBox = boxRmsFor(id, asMap([id, boxC])), bEdge = boxRmsFor(id, asMap([id, e.corr]));
            const before = edgeResidual(e.res, 'initial'), after = edgeResidual(e.res, 'final');
            let reason: string;
            let take = false;
            // chosen by the inter-view agreement alone: the box pairs are what the box pose was fitted to, so they are reported, not used
            if (!usable(id)) reason = `the edge search did not lock onto the scan (median residual ${before ?? 'n/a'} → ${after ?? 'n/a'} px; at most ${EDGE_MAX_RESIDUAL_PX} px and better than the start is required)`;
            else if (sEdge.ncc === null || sBox.ncc === null) reason = 'no other pano sees the same scan surface, so the edge pose cannot be checked; the box pose stands';
            else if (sEdge.ncc < sBox.ncc + EDGE_NCC_MARGIN) reason = `the edge pose does not agree better with the other panos (gradient NCC ${sBox.ncc.toFixed(3)} with the box pose, ${sEdge.ncc.toFixed(3)} with the edge pose)`;
            else { take = true; reason = `the edge pose agrees better with the other panos (gradient NCC ${sBox.ncc.toFixed(3)} → ${sEdge.ncc.toFixed(3)})`; }
            chosen.set(id, take ? e.corr : boxC);
            // metres of the edge residual at the frames' distance: px / fx * median surface depth
            let edgeResidualM: number | undefined;
            if (after !== null) {
                const ms = frames.filter(f => f.view.panoId === id).map(f => {
                    const cam = camOf(f, e.corr);
                    const d = renderFrameDepth(input.mesh, cam);
                    const ds: number[] = []; for (let i = 0; i < d.length; i += 97) if (d[i] < EMPTY_DEPTH) ds.push(d[i]);
                    return ds.length ? (after / cam.fx) * median(ds) : NaN;
                }).filter(Number.isFinite);
                if (ms.length) edgeResidualM = r3(Math.max(EDGE_RESIDUAL_FLOOR_M, median(ms)));
            }
            outcomes.set(id, {
                panoId: id, frames: frames.filter(f => f.view.panoId === id).length, prior: boxC, edge: e.corr, chosen: take ? 'edges' : 'boxes', reason,
                edgeResidualPx: { prior: before, edge: after }, ...(edgeResidualM !== undefined ? { edgeResidualM } : {}),
                skyIoU: { prior: skyIoUOf(e.res, 'initial'), edge: skyIoUOf(e.res, 'final') },
                heldOut: { ncc: { boxes: sBox.ncc === null ? null : r3(sBox.ncc), edges: sEdge.ncc === null ? null : r3(sEdge.ncc) }, boxRmsM: { boxes: bBox.rms, edges: bEdge.rms }, nccSamples: sEdge.samples, boxPairs: bEdge.n },
                atBound: e.res.atBound, ms: e.ms, gateReasons: [...new Set(e.res.frames.flatMap(f => f.reasons))]
            });
        }
    }
    const allBox = agree.score(p => priorCorr(p));
    const allChosen = agree.score(p => chosen.get(p) ?? ZERO_CORRECTION);
    const finalMap = asMap();
    const boxAll = usedPairs.map(c => pairResidualM(c, prior?.corrections ?? new Map(), faces)).filter(Number.isFinite);
    const chosenAll = usedPairs.map(c => pairResidualM(c, finalMap, faces)).filter(Number.isFinite);
    const registration = mergedRegistration(prior, finalMap, [...outcomes.values()], usedPairs, faces);
    return {
        registration, panos: [...outcomes.values()],
        ncc: { boxes: allBox.ncc === null ? null : r3(allBox.ncc), chosen: allChosen.ncc === null ? null : r3(allChosen.ncc), pairs: allChosen.pairs },
        boxRmsM: { boxes: prior ? prior.afterRmsM : r3(rms(boxAll)), chosen: r3(rms(chosenAll)) },
        ms: now() - t0, skipped
    };
}

/** The box registration's shape with the chosen poses: the corrections, each pano's numbers, and the overall residual of the pairs. */
function mergedRegistration(prior: Registration | undefined, corrections: Map<string, PoseCorrection>, outcomes: EdgePanoOutcome[], usedPairs: Correspondence[], faces: CastFace[]): Registration {
    const edgeIds = new Set(outcomes.filter(o => o.chosen === 'edges').map(o => o.panoId));
    const base: Registration = prior ?? { corrections: new Map(), perPano: [], setAside: [], pairs: [], beforeRmsM: 0, afterRmsM: 0, used: 0, rejected: 0 };
    const perPano = base.perPano.map(p => ({ ...p }));
    for (const o of outcomes) {
        if (o.chosen !== 'edges') continue;
        const c = corrections.get(o.panoId)!;
        const mine = usedPairs.filter(x => x.a.view.panoId === o.panoId || x.b.view.panoId === o.panoId).map(x => pairResidualM(x, corrections, faces)).filter(Number.isFinite);
        const entry = { panoId: o.panoId, dxM: r3(c.dx), dzM: r3(c.dz), dyawDeg: Math.round(c.dyawDeg * 100) / 100, dpitchDeg: Math.round(c.dpitchDeg * 100) / 100, method: 'edges' as const, ...(o.edgeResidualM !== undefined ? { edgeResidualM: o.edgeResidualM } : {}) };
        const k = perPano.findIndex(p => p.panoId === o.panoId);
        if (k >= 0) perPano[k] = { ...perPano[k], ...entry, afterRmsM: mine.length ? r3(rms(mine)) : perPano[k].afterRmsM };
        else perPano.push({ ...entry, pairs: 0, beforeRmsM: NaN, afterRmsM: NaN });
    }
    const pairs = base.pairs.map(p => {
        const c = usedPairs.find(x => x.id === p.id);
        return c && (edgeIds.has(c.a.view.panoId) || edgeIds.has(c.b.view.panoId)) ? { ...p, residualM: r3(pairResidualM(c, corrections, faces)) } : p;
    });
    const used = pairs.filter(p => p.used && Number.isFinite(p.residualM));
    return {
        ...base, corrections, perPano, pairs,
        setAside: base.setAside.filter(s => !edgeIds.has(s.panoId)),
        afterRmsM: used.length ? r3(rms(used.map(p => p.residualM))) : base.afterRmsM
    };
}

/** An image the run holds in memory (survey, ring or close-up), with the pose it was asked for. */
export interface HeldImage {
    id: string;
    bytes: Buffer | Uint8Array;
    widthPx: number;
    heightPx: number;
    view: { panoId: string; eye: Vec3; headingDeg: number; pitchDeg: number; fovDeg: number };
}

/** Decoded registration frames of the images in hand (each image once; one that does not decode is left out). */
export function edgeFramesFromImages(images: HeldImage[]): EdgeRegFrame[] {
    const seen = new Set<string>();
    const out: EdgeRegFrame[] = [];
    for (const im of images) {
        if (seen.has(im.id)) continue;
        seen.add(im.id);
        try {
            const d = decodeJpegInMemory(im.bytes instanceof Buffer ? im.bytes : Buffer.from(im.bytes));
            out.push({
                key: im.id,
                view: { panoId: im.view.panoId, eye: im.view.eye, headingDeg: im.view.headingDeg, pitchDeg: im.view.pitchDeg, fovDeg: im.view.fovDeg, widthPx: d.width, heightPx: d.height },
                image: { width: d.width, height: d.height, rgba: Buffer.from(d.data.buffer, d.data.byteOffset, d.data.byteLength) }
            });
        } catch {
            // an image that does not decode cannot be registered; its pano keeps the box pose
        }
    }
    return out;
}

/** The geometric registration in words for the stage panel. */
export function describeEdgeRegistration(r: EdgeRegistrationResult): string {
    const taken = r.panos.filter(p => p.chosen === 'edges');
    const px = (v: number | null) => (v === null ? 'n/a' : `${v.toFixed(1)} px`);
    const per = r.panos.map(p => `${p.panoId.slice(0, 6)}: ${p.chosen} (edge residual ${px(p.edgeResidualPx.prior)} -> ${px(p.edgeResidualPx.edge)}, gradient NCC ${p.heldOut.ncc.boxes ?? 'n/a'} -> ${p.heldOut.ncc.edges ?? 'n/a'})`).join('; ');
    return `geometric registration: ${taken.length} of ${r.panos.length} panos posed against the scan's silhouette and edges in ${(r.ms / 1000).toFixed(1)} s; inter-view gradient NCC ${r.ncc.boxes ?? 'n/a'} with the box poses, ${r.ncc.chosen ?? 'n/a'} with the chosen ones over ${r.ncc.pairs} view pairs; the matched boxes disagree by ${r.boxRmsM.boxes.toFixed(2)} m RMS at the box poses (fitted to them), ${r.boxRmsM.chosen.toFixed(2)} m at the chosen ones${r.skipped.length ? `; ${r.skipped.length} panos not registered in the time` : ''}. Per pano ${per}`;
}
