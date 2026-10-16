/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Figures: the compact scanned blobs standing on a fitted pedestal, read from a Street View crop into a continuous
 * figure spec and built inside the scan blob's own bounds.
 *
 * DETECTION is a measured criterion, never a name or a keyword: a region the fit kept as scanned (pass-through) whose
 * footprint is compact (0.35-4 m), whose height is 0.8-6 m and not squat against its footprint, that stands on the top
 * of a fitted surface (its lowest point within 0.5 m of that surface's plane, its footprint centre inside that surface's
 * extent) at a height above the fitted ground. Up to four. The survey's own inventory may corroborate: an element whose
 * box in a survey image holds the blob's projected centre is recorded beside it.
 *
 * READING is one batched call: each figure's crop (one pano, aimed at the blob, fov 30-45) and the scan's measurements
 * of its blob, and for each a spec in the repo's ObjectBuildSpec form (the same conventions and schema the reference
 * object builder uses, with the Street View crop as the reference image, in memory only).
 *
 * BUILDING is constrained to the blob: the built figure is turned to the blob's own axes (its footprint's principal
 * axis; its front toward the camera that saw it), scaled per axis to the blob's bounding box (a factor outside 0.5-2 is
 * rejected as the spec disagreeing with the scan), and set on the pedestal where the blob stood. A figure that cannot be
 * read or built falls one rung, to the scanned lump smoothed (Taubin) with no vertex moved further than the scan's own
 * tolerance, labelled 'smoothed-scan' with the reason. Nothing is invented.
 */

import type { Content, Part } from '@google/genai';
import {
    MAX_STREET_VIEW_IMAGES_PER_BUILDING, PROVENANCE,
    type FigureRecord, type FittedSurface, type PassThroughRegion, type ProvenanceRecord, type StagedNodeExtras, type StructureFit, type Vec3, type VisionModelUse
} from '../../../common/spatial/staged-location-contracts';
import { OBJECT_BUILD_SPEC_JSON_SCHEMA, validateObjectBuildSpec, type ObjectBuildSpec } from '../../../common/spatial/object-build-spec';
import { specConventions } from '../reference-object-builder';
import type { VisionModelChain } from '../../gemini/vision-model-chain';
import type { GroundModel } from '../../spatial/StreetViewSurveyPlanner';
import { projectToFrame } from '../../spatial/StreetViewPoseRegistrar';
import type { StructurePickResult } from './extraction-sizing';
import { MIN_VIEW_DISTANCE_M, pointHidden } from './evidence-aim';
import type { GlbNode } from './glb-nodes';
import { ORNAMENT_MAX_OUTPUT_TOKENS, ORNAMENT_THINKING_BUDGET, visionUse, VisionStageError } from './ornament-vision';
import type { SurveyResult } from './face-survey';
import { castCamera } from './survey-casting';
import { bearingDeg, STREET_VIEW_EYE_HEIGHT_M, type PanoCandidate, type SelectedView } from './streetview-evidence';
import { vertexNormals, type StagedGlbNode } from './staged-glb-writer';

const DEG = Math.PI / 180;
/** The measured criterion, in one place. */
export const FIGURE_CRITERIA = {
    footprintM: [0.35, 4.0] as const,
    heightM: [0.8, 6.0] as const,
    /** Height over the larger footprint side: standing, not lying or squat. */
    minSlenderness: 0.8,
    /** How far below the lump's base a fitted surface's plane may be and still hold it. */
    pedestalContactM: 0.5,
    /** The pedestal's top plane may cut the lump anywhere in this share of its height above its base: below it is the pedestal's own top, which the fit holds. */
    pedestalDepthShare: 0.6,
    /** Height of the blob's base above the fitted ground. */
    baseAboveGroundM: [0.05, 14] as const,
    maxFigures: MAX_STREET_VIEW_IMAGES_PER_BUILDING
};
export const FIGURE_VISION_TIMEOUT_MS = 150_000;
export const FIGURE_FOV_MIN_DEG = 30;
export const FIGURE_FOV_MAX_DEG = 45;
/** A built figure may differ from its blob's bounds by at most this factor per axis; beyond it the spec disagrees with the scan. */
export const FIGURE_SCALE_LIMITS = [0.5, 2] as const;
export const TAUBIN = { lambda: 0.5, mu: -0.53, iterations: 12 } as const;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// ----------------------------------------------------------------------------------------------------------------
// detection
// ----------------------------------------------------------------------------------------------------------------

export interface FigureBlob {
    /** The pass-through region's id ("r1"). */
    regionId: string;
    triangles: number;
    min: Vec3;
    max: Vec3;
    centre: Vec3;
    /** Footprint principal axis (degrees clockwise from north, 0-180) and the extents along it and across it, metres. */
    axisDeg: number;
    alongM: number;
    acrossM: number;
    heightM: number;
    pedestal: { surfaceId: string; topY: number; contactM: number };
    baseAboveGroundM: number;
    /** What in the survey corroborates it: an element box that holds the blob's centre in a survey image. */
    corroboratedBy?: { faceId: string; kind: string; confidence: number };
}

export interface FigureDetection { figures: FigureBlob[]; rejected: Array<{ regionId: string; why: string }> }

function topPlanes(surfaces: FittedSurface[]): Array<{ id: string; y: (x: number, z: number) => number; contains: (x: number, z: number) => boolean }> {
    const out: ReturnType<typeof topPlanes> = [];
    for (const s of surfaces) {
        if (!('plane' in s.chart)) continue;
        const pl = s.chart.plane;
        const nl = Math.hypot(pl.normal[0], pl.normal[1], pl.normal[2]) || 1;
        const n: Vec3 = [pl.normal[0] / nl, pl.normal[1] / nl, pl.normal[2] / nl];
        if (n[1] < 0.8) continue;
        const uv = (x: number, z: number): [number, number] => {
            const d: Vec3 = [x - pl.origin[0], 0, z - pl.origin[2]];
            // (u, v) from the in-plane axes: least squares over the two horizontal components is enough for near-horizontal planes
            const det = pl.u[0] * pl.v[2] - pl.u[2] * pl.v[0] || 1e-9;
            return [(d[0] * pl.v[2] - d[2] * pl.v[0]) / det, (pl.u[0] * d[2] - pl.u[2] * d[0]) / det];
        };
        out.push({
            id: s.id,
            y: (x, z) => pl.origin[1] - ((x - pl.origin[0]) * n[0] + (z - pl.origin[2]) * n[2]) / n[1],
            contains: (x, z) => {
                const [u, v] = uv(x, z);
                const us = pl.extentUv.map(p => p[0]), vs = pl.extentUv.map(p => p[1]);
                return !us.length || (u >= Math.min(...us) - 0.3 && u <= Math.max(...us) + 0.3 && v >= Math.min(...vs) - 0.3 && v <= Math.max(...vs) + 0.3);
            }
        });
    }
    return out;
}

/** Principal axis (deg from north, 0-180) and extents along/across it, from the region's vertices on the ground plane. */
export function footprintAxis(positions: Float32Array): { axisDeg: number; alongM: number; acrossM: number; cx: number; cz: number } {
    let n = 0, cx = 0, cz = 0;
    for (let i = 0; i < positions.length; i += 3) { cx += positions[i]; cz += positions[i + 2]; n++; }
    cx /= n || 1; cz /= n || 1;
    let sxx = 0, szz = 0, sxz = 0;
    for (let i = 0; i < positions.length; i += 3) { const dx = positions[i] - cx, dz = positions[i + 2] - cz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; }
    const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz); // angle of the principal axis from +x toward +z
    const ax = Math.cos(theta), az = Math.sin(theta);
    let lo = Infinity, hi = -Infinity, clo = Infinity, chi = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
        const dx = positions[i] - cx, dz = positions[i + 2] - cz;
        const a = dx * ax + dz * az, c = -dx * az + dz * ax;
        lo = Math.min(lo, a); hi = Math.max(hi, a); clo = Math.min(clo, c); chi = Math.max(chi, c);
    }
    // compass heading of the axis direction (x east, z south): bearing = atan2(east, north) with north = -z
    const axisDeg = ((Math.atan2(ax, -az) / DEG) % 180 + 180) % 180;
    return { axisDeg, alongM: hi - lo, acrossM: chi - clo, cx, cz };
}

/**
 * The regions of the fit's pass-through layer that are compact scanned figures standing on a fitted pedestal.
 * `nodes` are the pass-through layer's nodes by region id (the scan's own triangles).
 */
export function detectFigureBlobs(
    fit: Pick<StructureFit, 'surfaces' | 'ground'> & { passThrough: { regions: PassThroughRegion[] } },
    nodes: GlbNode[],
    survey?: Pick<SurveyResult, 'faces' | 'read'>
): FigureDetection {
    const C = FIGURE_CRITERIA;
    const planes = topPlanes(fit.surfaces);
    const byId = new Map(nodes.map(n => [n.name, n]));
    const found: Array<FigureBlob & { score: number }> = [];
    const rejected: FigureDetection['rejected'] = [];
    for (const region of fit.passThrough.regions) {
        const node = byId.get(region.id);
        const min = region.aabbMin, max = region.aabbMax;
        const reject = (why: string) => { rejected.push({ regionId: region.id, why }); };
        if (!node || !node.positions.length) { reject('its triangles are not in the pass-through layer'); continue; }
        const lumpHeight = max[1] - min[1];
        const baseAbove = min[1] - fit.ground.baseY;
        if (baseAbove < C.baseAboveGroundM[0] || baseAbove > C.baseAboveGroundM[1]) { reject(`its base is ${baseAbove.toFixed(2)} m above the fitted ground, outside ${C.baseAboveGroundM[0]}-${C.baseAboveGroundM[1]} m`); continue; }
        // the footprint centre of the whole lump decides which fitted surface it can stand on
        const whole = footprintAxis(node.positions);
        // it stands on the highest fitted up-facing surface whose plane cuts the lump between its base (less the contact tolerance) and the first
        // C.pedestalDepthShare of its height: the lump's lower part is the pedestal's own top, which the fit already holds
        let pedestal: FigureBlob['pedestal'] | undefined;
        for (const p of planes) {
            if (!p.contains(whole.cx, whole.cz)) continue;
            const topY = p.y(whole.cx, whole.cz);
            if (topY < min[1] - C.pedestalContactM || topY > min[1] + C.pedestalDepthShare * lumpHeight) continue;
            if (!pedestal || topY > pedestal.topY) pedestal = { surfaceId: p.id, topY, contactM: Math.abs(min[1] - topY) };
        }
        if (!pedestal) { reject('it does not stand on the top of a fitted surface'); continue; }
        // the figure is what stands above the pedestal's top
        const baseY = Math.max(min[1], pedestal.topY);
        const above: number[] = [];
        for (let i = 0; i < node.positions.length; i += 3) if (node.positions[i + 1] >= baseY - 0.02) above.push(node.positions[i], node.positions[i + 1], node.positions[i + 2]);
        if (above.length < 9) { reject('nothing of it stands above the pedestal top'); continue; }
        const ax = footprintAxis(Float32Array.from(above));
        const heightM = max[1] - baseY;
        const footprintMax = Math.max(ax.alongM, ax.acrossM);
        if (footprintMax > C.footprintM[1] || footprintMax < C.footprintM[0]) { reject(`footprint ${footprintMax.toFixed(2)} m is outside ${C.footprintM[0]}-${C.footprintM[1]} m`); continue; }
        if (heightM < C.heightM[0] || heightM > C.heightM[1]) { reject(`height ${heightM.toFixed(2)} m is outside ${C.heightM[0]}-${C.heightM[1]} m`); continue; }
        if (heightM / footprintMax < C.minSlenderness) { reject(`not standing: height ${heightM.toFixed(2)} m over footprint ${footprintMax.toFixed(2)} m is under ${C.minSlenderness}`); continue; }
        let lo: Vec3 = [Infinity, baseY, Infinity], hi: Vec3 = [-Infinity, max[1], -Infinity];
        for (let i = 0; i < above.length; i += 3) { lo[0] = Math.min(lo[0], above[i]); hi[0] = Math.max(hi[0], above[i]); lo[2] = Math.min(lo[2], above[i + 2]); hi[2] = Math.max(hi[2], above[i + 2]); }
        const centre: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
        found.push({
            regionId: region.id, triangles: region.triangles, min: lo, max: hi, centre, axisDeg: Math.round(ax.axisDeg * 10) / 10, alongM: Math.round(ax.alongM * 100) / 100, acrossM: Math.round(ax.acrossM * 100) / 100,
            heightM: Math.round(heightM * 100) / 100, pedestal: { ...pedestal, topY: Math.round(pedestal.topY * 1000) / 1000, contactM: Math.round(pedestal.contactM * 1000) / 1000 },
            baseAboveGroundM: Math.round((baseY - fit.ground.baseY) * 100) / 100, score: region.triangles
        });
    }
    found.sort((a, b) => b.score - a.score || a.regionId.localeCompare(b.regionId));
    const figures = found.slice(0, C.maxFigures).map(({ score: _s, ...b }) => b);
    for (const f of found.slice(C.maxFigures)) rejected.push({ regionId: f.regionId, why: `more than ${C.maxFigures} figures; the larger ones are kept` });
    if (survey) for (const f of figures) f.corroboratedBy = corroborate(f, survey);
    return { figures, rejected };
}

function corroborate(blob: FigureBlob, survey: Pick<SurveyResult, 'faces' | 'read'>): FigureBlob['corroboratedBy'] | undefined {
    for (const r of survey.read) {
        const face = survey.faces.find(f => f.faceId === r.view.faceId);
        if (!face) continue;
        const cam = castCamera({ eye: r.view.eye, headingDeg: r.view.headingDeg, pitchDeg: r.view.pitchDeg, fovDeg: r.view.fovDeg, widthPx: r.widthPx, heightPx: r.heightPx });
        const q = projectToFrame(cam, blob.centre);
        if (!q) continue;
        const x = (q[0] / r.widthPx) * 1000, y = (q[1] / r.heightPx) * 1000;
        const hit = face.elements.find(e => y >= e.box[0] && y <= e.box[2] && x >= e.box[1] && x <= e.box[3]);
        if (hit) return { faceId: face.faceId, kind: hit.kind, confidence: hit.confidence };
    }
    return undefined;
}

// ----------------------------------------------------------------------------------------------------------------
// the crops
// ----------------------------------------------------------------------------------------------------------------

export interface FigureView extends SelectedView { regionId: string }

/** One crop per figure from the best pano: the nearest that sees the blob's centre (8-60 m), aimed at it, fov 30-45, portrait. */
export function planFigureViews(
    blobs: FigureBlob[],
    panos: PanoCandidate[],
    structure: Pick<StructurePickResult, 'cells' | 'groundY'>,
    ground: Pick<GroundModel, 'cellIndex' | 'groundAt'>,
    top: Float32Array
): { views: FigureView[]; skipped: Array<{ regionId: string; reason: string }> } {
    const views: FigureView[] = [];
    const skipped: Array<{ regionId: string; reason: string }> = [];
    for (const b of blobs) {
        let best: { p: PanoCandidate; eye: Vec3; d: number } | undefined;
        for (const p of panos) {
            const g = ground.groundAt(p.x, p.z);
            const eye: Vec3 = [p.x, (g === g ? g : structure.groundY) + STREET_VIEW_EYE_HEIGHT_M, p.z];
            const d = Math.hypot(b.centre[0] - eye[0], b.centre[2] - eye[2]);
            if (d < Math.max(MIN_VIEW_DISTANCE_M, 8) || d > 60) continue;
            if (pointHidden(eye, b.centre, structure, ground, top)) continue;
            if (!best || d < best.d || (d === best.d && p.panoId < best.p.panoId)) best = { p, eye, d };
        }
        if (!best) { skipped.push({ regionId: b.regionId, reason: 'no Google panorama between 8 and 60 m sees it' }); continue; }
        const dh = Math.hypot(b.centre[0] - best.eye[0], b.centre[2] - best.eye[2]);
        const elevationDeg = Math.max(-20, Math.min(60, Math.atan2(b.centre[1] - best.eye[1], Math.max(0.1, dh)) / DEG));
        const size = Math.max(b.alongM, b.acrossM, b.heightM);
        const need = (2 * Math.atan((size * 1.7) / 2 / Math.max(1, dh))) / DEG;
        views.push({
            regionId: b.regionId, panoId: best.p.panoId, date: best.p.date, copyright: best.p.copyright, eye: best.eye, facadeHeadingDeg: Math.round(bearingDeg(best.eye[0], best.eye[2], b.centre[0], b.centre[2])),
            headingDeg: Math.round(bearingDeg(best.eye[0], best.eye[2], b.centre[0], b.centre[2]) * 10) / 10, pitchDeg: Math.round(elevationDeg * 10) / 10,
            fovDeg: Math.round(Math.max(FIGURE_FOV_MIN_DEG, Math.min(FIGURE_FOV_MAX_DEG, need)) * 10) / 10, aspectRatio: 'RATIO_3X4',
            distanceM: Math.round(Math.hypot(dh, b.centre[1] - best.eye[1]) * 100) / 100, score: 1
        });
    }
    return { views, skipped };
}

// ----------------------------------------------------------------------------------------------------------------
// the one batched reading
// ----------------------------------------------------------------------------------------------------------------

export interface FigureImage { index: number; blob: FigureBlob; view: FigureView; bytes: Buffer; mimeType: string; widthPx: number; heightPx: number }
export interface FigureReading { index: number; spec: ObjectBuildSpec; confidence: number }

export function figurePrompt(images: Array<{ index: number; blob: FigureBlob; view: FigureView; widthPx: number; heightPx: number }>): { preamble: string; captions: string[]; closing: string } {
    const preamble = `You are reading standing figures that sit on pedestals, each from one Google Street View crop, so that each can be built as a clean model. The 3D scan only holds each as a rough lump, whose measured bounds are given. For every image, describe the ONE figure at the middle of the crop as a build spec. Everything you give is labelled "photo-inferred".`;
    const captions = images.map(i => `[${i.index}] Google Street View crop (© Google, ${i.view.date ?? 'date unknown'}), looking ${Math.round(i.view.headingDeg)}° from about ${Math.round(i.view.distanceM)} m, field of view ${Math.round(i.view.fovDeg)}°, ${i.widthPx} × ${i.heightPx} px. The scan's lump for this figure measures ${i.blob.acrossM.toFixed(2)} × ${i.blob.alongM.toFixed(2)} m on the ground and ${i.blob.heightM.toFixed(2)} m tall; build the figure to those overall bounds (width ${i.blob.acrossM.toFixed(2)} m, height ${i.blob.heightM.toFixed(2)} m, depth ${i.blob.alongM.toFixed(2)} m).`);
    const rules = [
        'Rules:',
        '1. Build only the figure itself, not the pedestal it stands on, not the wall or sky behind it, not people, birds or trees.',
        '2. Follow the spec conventions below exactly (they are the same for every figure). The origin is the centre of where the figure meets its pedestal; nothing goes below y = 0.',
        '3. Describe the whole figure including sides the crop hides: infer them from symmetry and from how such figures are made. Pose, proportions, drapery and held objects are what the crop shows; do not add what you cannot see.',
        '4. "confidence" is 0..100: how well the crop lets you read the figure.',
        '5. If an image shows no figure at its middle, leave it out of the list.',
        '',
        specConventions()
    ].join('\n');
    const schema = JSON.stringify({ type: 'object', required: ['figures'], properties: { figures: { type: 'array', maxItems: FIGURE_CRITERIA.maxFigures, items: { type: 'object', required: ['image', 'confidence', 'spec'], properties: { image: { type: 'integer' }, confidence: { type: 'integer' }, spec: OBJECT_BUILD_SPEC_JSON_SCHEMA } } } } });
    return { preamble, captions, closing: `${rules}\n\nReply with JSON only, matching this schema, one entry per figure with "image" the index of its crop: ${schema}` };
}

export function figureContents(images: FigureImage[]): Content[] {
    const { preamble, captions, closing } = figurePrompt(images);
    const parts: Part[] = [{ text: preamble }];
    images.forEach((im, k) => { parts.push({ inlineData: { mimeType: im.mimeType, data: im.bytes.toString('base64') } }); parts.push({ text: captions[k] }); });
    parts.push({ text: closing });
    return [{ role: 'user', parts }];
}

export interface ParsedFigures { readings: Map<number, FigureReading>; problems: Map<number, string[]> }

export function parseFigureReply(text: string, finishReason: string | undefined, imageCount: number): ParsedFigures {
    if (finishReason && finishReason !== 'STOP') throw new Error(finishReason === 'MAX_TOKENS' ? 'the reply was cut off (MAX_TOKENS)' : `the reply ended with ${finishReason}, not STOP`);
    let value: any;
    try { value = JSON.parse(text.trim()); } catch (err) { throw new Error(`the reply is not valid JSON (${(err as Error).message})`); }
    if (!value || !Array.isArray(value.figures)) throw new Error('the reply has no "figures" list');
    const readings = new Map<number, FigureReading>();
    const problems = new Map<number, string[]>();
    for (const f of value.figures) {
        if (!f || !Number.isInteger(f.image) || f.image < 0 || f.image >= imageCount) continue;
        if (readings.has(f.image)) continue;
        const errors = validateObjectBuildSpec(f.spec);
        if (errors.length) { problems.set(f.image, errors.slice(0, 4)); continue; }
        readings.set(f.image, { index: f.image, spec: f.spec as ObjectBuildSpec, confidence: Math.max(0, Math.min(100, Number(f.confidence) || 0)) });
    }
    return { readings, problems };
}

export interface ReadFiguresInput { images: FigureImage[]; chain: VisionModelChain<string>; signal?: AbortSignal; onProgress?: (m: string) => void; timeoutMs?: number }

export async function readFigures(input: ReadFiguresInput): Promise<{ parsed: ParsedFigures; model: VisionModelUse }> {
    const timeoutMs = input.timeoutMs ?? FIGURE_VISION_TIMEOUT_MS;
    const own = new AbortController();
    const timer = setTimeout(() => own.abort(Object.assign(new Error(`the vision call took longer than ${Math.round(timeoutMs / 1000)} s`), { name: 'TimeoutError' })), timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, own.signal]) : own.signal;
    let usage: Partial<VisionModelUse> = {};
    try {
        input.onProgress?.(`reading ${input.images.length} figure${input.images.length === 1 ? '' : 's'} with ${input.chain.current}`);
        const r = await input.chain.generate({
            contents: figureContents(input.images),
            config: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: ORNAMENT_MAX_OUTPUT_TOKENS, abortSignal: signal }
        }, { stage: 'figures', thinkingBudget: ORNAMENT_THINKING_BUDGET, stream: true, onFirstToken: ms => input.onProgress?.(`reading the figures (first token after ${(ms / 1000).toFixed(1)} s)`) });
        const u = r.response.usageMetadata;
        const finishReason = r.response.candidates?.[0]?.finishReason as string | undefined;
        usage = { ...(u?.promptTokenCount !== undefined ? { promptTokens: u.promptTokenCount } : {}), ...(u?.candidatesTokenCount !== undefined ? { outputTokens: u.candidatesTokenCount } : {}), ...(finishReason ? { finishReason } : {}) };
        const text = (r.response.candidates?.[0]?.content?.parts ?? []).filter(p => !(p as { thought?: boolean }).thought).map(p => p.text ?? '').join('');
        const parsed = parseFigureReply(text, finishReason, input.images.length);
        const thinking = input.chain.attempts.length ? input.chain.attempts[input.chain.attempts.length - 1].thinking : undefined;
        return { parsed, model: visionUse(input.chain, 'answered', { ...usage, ...(thinking ? { thinking } : {}) }) };
    } catch (err) {
        if (input.signal?.aborted) throw err;
        const timedOut = own.signal.aborted;
        const message = timedOut ? `the vision call took longer than ${Math.round(timeoutMs / 1000)} s` : (err as Error).message;
        throw new VisionStageError(message, visionUse(input.chain, 'failed', { ...usage, error: message }), timedOut || /transient|quota|429|5\d\d|network|fetch failed/.test(message), 'figures_unreadable');
    } finally {
        clearTimeout(timer);
    }
}

// ----------------------------------------------------------------------------------------------------------------
// the constrained build
// ----------------------------------------------------------------------------------------------------------------

export interface ConstrainedFigure {
    positions: Float32Array;
    indices: Uint32Array;
    /** Per-axis factor applied to the built figure to reach the blob's bounds (1 = the spec was already that size). */
    scale: Vec3;
    yawDeg: number;
    fits: { min: Vec3; max: Vec3 };
}

/**
 * Turns, scales and sets a built figure (metres, +Y up, front +Z, origin at the centre of its base) into its blob: the
 * footprint's principal axis becomes the figure's width axis, its front is the axis direction that faces the camera
 * that saw it, and per-axis scale makes its bounding box the blob's (along × height × across). Throws when a factor
 * leaves FIGURE_SCALE_LIMITS: the spec disagrees with the scan.
 */
export function constrainFigure(built: { positions: Float32Array; indices?: Uint32Array }, blob: FigureBlob, eye: Vec3): ConstrainedFigure {
    const p = built.positions;
    let lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[i + k]); hi[k] = Math.max(hi[k], p[i + k]); }
    const size = sub(hi, lo);
    if (!(size[0] > 1e-6 && size[1] > 1e-6 && size[2] > 1e-6)) throw new Error('the built figure has no volume');
    // the blob's frame: u along the principal axis, w across it. Two orientations are possible for the figure: its depth along the axis
    // (front looking along it) or across it (front looking across); the one whose per-axis scale is nearest 1 is taken, and of the two
    // directions the one that faces the camera that saw it
    const ax = Math.sin(blob.axisDeg * DEG), az = -Math.cos(blob.axisDeg * DEG);
    const toEye: [number, number] = [eye[0] - blob.centre[0], eye[2] - blob.centre[2]];
    const options = [
        { dir: [ax, az] as [number, number], target: [blob.acrossM, blob.heightM, blob.alongM] as Vec3 },
        { dir: [-az, ax] as [number, number], target: [blob.alongM, blob.heightM, blob.acrossM] as Vec3 }
    ].map(o => {
        const s: Vec3 = [o.target[0] / size[0], o.target[1] / size[1], o.target[2] / size[2]];
        return { ...o, scale: s, distortion: Math.max(...s.map(v => Math.abs(Math.log(v)))) };
    });
    const chosen = options[0].distortion <= options[1].distortion ? options[0] : options[1];
    const front = chosen.dir[0] * toEye[0] + chosen.dir[1] * toEye[1] >= 0 ? 1 : -1;
    const frontDir: [number, number] = [chosen.dir[0] * front, chosen.dir[1] * front];
    const rightDir: [number, number] = [-frontDir[1], frontDir[0]]; // the figure's +x in the world: its front turned a quarter clockwise seen from above
    const scale = chosen.scale;
    for (const s of scale) if (s < FIGURE_SCALE_LIMITS[0] || s > FIGURE_SCALE_LIMITS[1]) {
        throw new Error(`the built figure differs from the scan's bounds by a factor of ${s.toFixed(2)} (allowed ${FIGURE_SCALE_LIMITS[0]}-${FIGURE_SCALE_LIMITS[1]}): the spec disagrees with the scan`);
    }
    const cx = (lo[0] + hi[0]) / 2, cz = (lo[2] + hi[2]) / 2;
    const out = new Float32Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
        const x = (p[i] - cx) * scale[0], y = (p[i + 1] - lo[1]) * scale[1], z = (p[i + 2] - cz) * scale[2];
        out[i] = blob.centre[0] + rightDir[0] * x + frontDir[0] * z;
        out[i + 1] = blob.min[1] + y;
        out[i + 2] = blob.centre[2] + rightDir[1] * x + frontDir[1] * z;
    }
    const idx = built.indices ?? Uint32Array.from({ length: p.length / 3 }, (_, i) => i);
    // a reflection (negative determinant) would flip the winding: x -> right, z -> front is a rotation, so none is needed
    let min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < out.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], out[i + k]); max[k] = Math.max(max[k], out[i + k]); }
    return { positions: out, indices: idx, scale: [Math.round(scale[0] * 1000) / 1000, Math.round(scale[1] * 1000) / 1000, Math.round(scale[2] * 1000) / 1000], yawDeg: Math.round(((Math.atan2(frontDir[0], -frontDir[1]) / DEG) + 360) % 360), fits: { min, max } };
}

// ----------------------------------------------------------------------------------------------------------------
// the fallback rung: the scanned lump, smoothed inside the scan's tolerance
// ----------------------------------------------------------------------------------------------------------------

export interface SmoothedLump { positions: Float32Array; indices: Uint32Array; maxMoveM: number; iterations: number; vertices: number }

/**
 * Taubin (lambda | mu) smoothing of the lump's welded mesh, with no vertex allowed to end further than `toleranceM` from
 * where the scan put it. Smoothing a mesh that has no neighbours (a degenerate region) throws.
 */
export function smoothLump(node: Pick<GlbNode, 'positions' | 'indices'>, toleranceM: number, opts: { lambda?: number; mu?: number; iterations?: number } = {}): SmoothedLump {
    const lambda = opts.lambda ?? TAUBIN.lambda, mu = opts.mu ?? TAUBIN.mu, iterations = opts.iterations ?? TAUBIN.iterations;
    const src = node.positions;
    const tri = node.indices ?? Uint32Array.from({ length: src.length / 3 }, (_, i) => i);
    // weld by position (1 mm), so the triangle soup becomes a connected mesh
    const key = (i: number) => `${Math.round(src[i * 3] * 1000)},${Math.round(src[i * 3 + 1] * 1000)},${Math.round(src[i * 3 + 2] * 1000)}`;
    const welded = new Map<string, number>();
    const map = new Uint32Array(src.length / 3);
    const pos: number[] = [];
    for (let i = 0; i < map.length; i++) {
        const k = key(i);
        let w = welded.get(k);
        if (w === undefined) { w = pos.length / 3; welded.set(k, w); pos.push(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]); }
        map[i] = w;
    }
    const n = pos.length / 3;
    const neighbours: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
    const faces = new Uint32Array(tri.length);
    for (let t = 0; t < tri.length; t += 3) {
        const a = map[tri[t]], b = map[tri[t + 1]], c = map[tri[t + 2]];
        faces[t] = a; faces[t + 1] = b; faces[t + 2] = c;
        neighbours[a].add(b); neighbours[a].add(c); neighbours[b].add(a); neighbours[b].add(c); neighbours[c].add(a); neighbours[c].add(b);
    }
    if (!neighbours.some(s => s.size >= 2)) throw new Error('the lump has no connected surface to smooth');
    const orig = Float64Array.from(pos);
    let cur = Float64Array.from(pos);
    const step = (f: number) => {
        const next = Float64Array.from(cur);
        for (let v = 0; v < n; v++) {
            const nb = neighbours[v];
            if (!nb.size) continue;
            let x = 0, y = 0, z = 0;
            for (const u of nb) { x += cur[u * 3]; y += cur[u * 3 + 1]; z += cur[u * 3 + 2]; }
            next[v * 3] = cur[v * 3] + f * (x / nb.size - cur[v * 3]);
            next[v * 3 + 1] = cur[v * 3 + 1] + f * (y / nb.size - cur[v * 3 + 1]);
            next[v * 3 + 2] = cur[v * 3 + 2] + f * (z / nb.size - cur[v * 3 + 2]);
        }
        cur = next;
    };
    for (let it = 0; it < iterations; it++) { step(lambda); step(mu); }
    // the scan's own tolerance: nothing ends further from where the scan put it
    let maxMove = 0;
    for (let v = 0; v < n; v++) {
        const dx = cur[v * 3] - orig[v * 3], dy = cur[v * 3 + 1] - orig[v * 3 + 1], dz = cur[v * 3 + 2] - orig[v * 3 + 2];
        const d = Math.hypot(dx, dy, dz);
        if (d > toleranceM) { const f = toleranceM / d; cur[v * 3] = orig[v * 3] + dx * f; cur[v * 3 + 1] = orig[v * 3 + 1] + dy * f; cur[v * 3 + 2] = orig[v * 3 + 2] + dz * f; maxMove = Math.max(maxMove, toleranceM); }
        else maxMove = Math.max(maxMove, d);
    }
    return { positions: Float32Array.from(cur), indices: faces, maxMoveM: Math.round(maxMove * 10000) / 10000, iterations, vertices: n };
}

// ----------------------------------------------------------------------------------------------------------------
// the nodes of the layer
// ----------------------------------------------------------------------------------------------------------------

export const SMOOTHED_SCAN_LABEL = PROVENANCE.smoothedScan;

export function figureProvenance(kind: 'photo-inferred' | 'smoothed-scan', args: { confidence?: number; method: string; sourceId: string; note?: string }): ProvenanceRecord {
    return kind === 'photo-inferred'
        ? { label: PROVENANCE.photoInferred, measuredGeometry: false, confidence: Math.max(0, Math.min(1, args.confidence ?? 0)), method: args.method, sources: [{ kind: 'streetview-grounding', id: args.sourceId }], ...(args.note ? { note: args.note } : {}) }
        : { label: SMOOTHED_SCAN_LABEL, measuredGeometry: true, method: args.method, sources: [{ kind: 'stage-output', id: args.sourceId }], ...(args.note ? { note: args.note } : {}) };
}

export function figureNode(args: { id: string; positions: Float32Array; indices: Uint32Array; provenance: ProvenanceRecord; order: number; count: number; regionId: string }): StagedGlbNode {
    const extras: StagedNodeExtras = {
        sb: {
            schema: 'scratchbox.staged-node/2', stage: 'figures', provenance: args.provenance, buildOrder: args.order, buildCount: Math.max(1, args.count), revealKind: 'rise',
            reveal: { attribute: null, displacement: null, durationShare: 1 / Math.max(1, args.count) }, ids: { elementId: args.id },
            counts: { vertices: args.positions.length / 3, triangles: args.indices.length / 3 }
        }
    };
    return { name: args.id, positions: args.positions, indices: args.indices, normals: vertexNormals(args.positions, args.indices), extras: { regionId: args.regionId, ...extras } };
}

/** The record the result carries for one figure. */
export function figureRecord(blob: FigureBlob, outcome: FigureRecord['outcome'], extra: Partial<FigureRecord> = {}): FigureRecord {
    return { id: `fig-${blob.regionId}`, outcome, boundsM: { min: blob.min, max: blob.max }, ...extra };
}
