/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * What stands in the streets, named from Street View: the identification step of the scene inventory (scene-inventory.ts).
 *
 * Google panoramas along the streets of an area (metadata at points every PANO_SPACING_M along the road centrelines),
 * four level views from each (90° apart, square to the street), registered against the tile mesh as the survey registers
 * them (pano-registration-run.ts; the nominal pose stands when it cannot be). Each view is read once by the vision model:
 * every fixed object in or beside the street that is not a building, a plant, a person or a vehicle, with a box, a few
 * words of what it is, its size and its form. Each box's foot is cast into the tile mesh's depth seen from that camera,
 * which places it and measures its height and width at that distance; boxes from different views that land together and
 * say the same are one object; each object is matched to the inventory entity it stands on (a street cluster, a crown,
 * a building's footprint for something fixed to a wall), or is new where the scan has nothing there (a pole too thin for
 * the leaf tiles).
 *
 * Labels only, and honestly labelled: what the model says is photo-inferred, with its confidence and the views it rests
 * on; what was measured (where, how tall, how wide) is measured from the registered camera and the scan. Nothing here
 * builds geometry or selects how anything is built.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { GeodeticOrigin, GroundModel } from '../../spatial/StreetViewSurveyPlanner';
import * as crypto from 'crypto';
import { groundingRequestFovDeg, projectToFrame, renderFrameDepth, type FrameCamera, type PoseCorrection } from '../../spatial/StreetViewPoseRegistrar';
import type { RenderMesh3D } from '../../spatial/HeadlessMeshSilhouetteRenderer';
import type { Vec2, Vec3 } from '../../../common/spatial/staged-location-contracts';
import { SB_FEATURE_CODES, SB_FEATURE_PREFIX, reviewUnknownCodes, typesFromLabels, type SbFeature, type SbFeatureTypeLabel } from '../../../common/spatial/sb-feature-types';
import { castCamera, pixelRay } from './survey-casting';
import { bearingDeg, discoverPanosAt, fetchViews, knownRefusals, type EvidenceImage, type PanoCandidate, type SelectedView, type StreetViewEvidenceDeps } from './streetview-evidence';
import { runPanoRegistrationOffThread, type PanoRegistrationJob, type PanoRegistrationOutcome } from './pano-registration-run';
import type { HeldImage } from './pano-edge-registration';
import { capImageSide } from './ornament-batches';
import { decodeImageInMemory } from './tile-texture-transfer';
import { encodePng } from './png-encode';
import type { VisionModelChain } from '../../gemini/vision-model-chain';
import type { SceneInventory } from './scene-inventory';

export const STREET_IDENTIFY_VERSION = 'street-identify/1';

export const STREET_IDENTIFY_PARAMS = {
    /** Metadata points along the road centrelines, and the least spacing kept between two panos. */
    panoSpacingM: 12,
    maxPanos: 12,
    /** Four views per pano, 90° apart, square to the nearest street; level, a little up to take in what poles carry. */
    viewsPerPano: 4,
    fovDeg: 90,
    elevationDeg: 6,
    /** Images go to the model at most this many pixels on a side. */
    sendMaxSidePx: 1280,
    /** The depth image is rendered at this width (the tile mesh is coarse: a full-size depth adds time, not detail). */
    depthWidthPx: 640,
    /**
     * A box whose foot lands farther than this from the camera is not placed: a few pixels at the foot are metres on the
     * ground there (Flatiron: boxes seen from 30-40 m landed on other objects seen from 15 m). With panos 12 m apart every
     * street object has a nearer view.
     */
    maxRangeM: 25,
    /** Two views' boxes whose feet land within this (plan) and say the same are one object. */
    mergeRadiusM: 1.75,
    /**
     * Two views' boxes whose feet land within this and whose measured heights agree within `sameHeightRatio` are one object
     * whatever they are called (one view's "trash bin" is another's "round planter"); neighbours this close that differ in
     * height (a bike rack at a sign post's foot) stay apart. Measured on Flatiron: 96 of 334 boxes have a box from another
     * pano within 1 m.
     */
    sameSpotM: 1.0,
    sameHeightRatio: 1.5,
    /** The same-spot rule needs both views this close (placement is good to well under a metre there). */
    sameSpotMaxRangeM: 15,
    /** The label rule's radius grows with range: this share of the farther view's range, at least mergeRadiusM. */
    mergeRadiusPerRange: 0.06,
    /**
     * Reprojection: an object placed from some views is drawn into each other view that should see it (in frame, within
     * maxRangeM, not behind the tile mesh by more than `occlusionToleranceM`); a box there overlapping it by at least
     * `reprojectOverlap` on both axes (interval IoU, boxes at least `reprojectMinWidthPx` wide) is the same object. The model
     * rarely lists a thing again from the next pano under the same words, so the boxes, not the words, decide.
     */
    reprojectOverlap: 0.35,
    reprojectMinWidthPx: 24,
    occlusionToleranceM: 1.5,
    /** An object within this (plan) of an inventory entity's box stands on it. */
    matchRadiusM: 1.5,
    /** An object counts as fixed to a building only when its foot is this close to the footprint (a bin by a wall is not). */
    attachRadiusM: 0.5,
    concurrency: 10,
    /** The Street View Static API's largest standard image (4:3 at the same 90 degree field of view as the grounding views). */
    staticWidthPx: 640,
    staticHeightPx: 480,
    /** Naming what is in a street photo needs little reasoning: a small budget keeps each call to seconds. */
    thinkingBudget: 512,
    timeoutMs: 120_000
};

// ------------------------------------------------------------------------------------------------ planning

/** Points every `spacing` metres along the road centrelines, inside the area. */
export function streetPoints(roads: Vec2[][], inArea: (x: number, z: number) => boolean, spacing: number): Array<{ x: number; z: number }> {
    const out: Array<{ x: number; z: number }> = [];
    for (const r of roads) for (let i = 1; i < r.length; i++) {
        const a = r[i - 1], b = r[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n = Math.max(1, Math.round(L / spacing));
        for (let k = 0; k < n; k++) { const u = k / n; const p = { x: a[0] + u * (b[0] - a[0]), z: a[1] + u * (b[1] - a[1]) }; if (inArea(p.x, p.z)) out.push(p); }
    }
    return out;
}

/** The bearing of the road segment nearest (x, z), clockwise from north (0 when there is no road). */
export function streetBearing(roads: Vec2[][], x: number, z: number): number {
    let best = Infinity, h = 0;
    for (const r of roads) for (let i = 1; i < r.length; i++) {
        const a = r[i - 1], b = r[i], dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz;
        const u = L > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L)) : 0;
        const d = Math.hypot(x - a[0] - u * dx, z - a[1] - u * dz);
        if (d < best) { best = d; h = bearingDeg(a[0], a[1], b[0], b[1]); }
    }
    return h;
}

/** The panos kept: at least `spacing` apart, nearest the area's centre first, at most `max`. */
export function pickPanos(panos: PanoCandidate[], centre: { x: number; z: number }, spacing: number, max: number): PanoCandidate[] {
    const kept: PanoCandidate[] = [];
    for (const p of panos.slice().sort((a, b) => Math.hypot(a.x - centre.x, a.z - centre.z) - Math.hypot(b.x - centre.x, b.z - centre.z))) {
        if (kept.length >= max) break;
        if (kept.some(q => Math.hypot(q.x - p.x, q.z - p.z) < spacing)) continue;
        kept.push(p);
    }
    return kept;
}

export function viewsForPano(p: PanoCandidate, roads: Vec2[][], groundAt: (x: number, z: number) => number, P = STREET_IDENTIFY_PARAMS): SelectedView[] {
    const g = groundAt(p.x, p.z);
    const eye: Vec3 = [p.x, (Number.isFinite(g) ? g : 0) + 2.5, p.z];
    const h0 = streetBearing(roads, p.x, p.z);
    return Array.from({ length: P.viewsPerPano }, (_, k) => ({
        panoId: p.panoId, ...(p.date ? { date: p.date } : {}), ...(p.copyright ? { copyright: p.copyright } : {}),
        eye, facadeHeadingDeg: 0, headingDeg: Math.round(((h0 + (k * 360) / P.viewsPerPano) % 360) * 10) / 10, pitchDeg: P.elevationDeg, fovDeg: P.fovDeg,
        aspectRatio: 'RATIO_4X3' as const, distanceM: 0, score: 1
    }));
}

// ------------------------------------------------------------------------------------------------ the reading

export interface StreetReading {
    label: string;
    /** [y0, x0, y1, x1], 0..1000 of the image. */
    box: [number, number, number, number];
    code?: string;
    heightM?: number; widthM?: number; depthM?: number;
    /** Its form, in the model's words (parts, profile, how they join); never branched on. */
    shape?: string;
    baseVisible: boolean;
    /** Installed to stay (false: put out for a while, like a cone, an A-frame sign or a skip). */
    permanent: boolean;
    confidence: number;
}

const CODE_LIST = SB_FEATURE_CODES.filter(c => !c.deprecated && !/SCAN_|OCCLUDED|ROOF_OBJECT|WALL_SURFACE|ROOF_SURFACE|GROUND_SURFACE/.test(c.code))
    .map(c => `${c.code}: ${c.description}`).join('\n');

export function streetReadingPrompt(): string {
    return [
        'This is a Google Street View photo. List every fixed object that stands in or beside the street and is not a building (or part of one), a tree or other plant, a person or a vehicle: anything set into the ground or fixed to the street, a wall or another such object.',
        'For each object give:',
        '- "label": what it is, in a few plain words.',
        '- "box_2d": [ymin, xmin, ymax, xmax] on a 0-1000 scale, the whole object (for a pole, from its foot to its top, with what it carries).',
        '- "baseVisible": true when the point where it meets the ground (or what it is fixed to) is in the photo.',
        '- "permanent": true when it is installed to stay; false when it is put out for a while (a cone, an A-frame sign, a skip, a barrier for works).',
        '- "heightM", "widthM", "depthM": your estimate of its real size in metres.',
        '- "shape": one sentence on its form: its parts, their profiles and thicknesses, how they join (e.g. "a round pole tapering from 0.3 m to 0.2 m, with a straight arm out at the top").',
        '- "code": the code below that fits it best; if none fits, propose a new one starting SB_FEATURE_TYPE_.',
        '- "confidence": 0 to 1, how sure you are of the label.',
        'List each object once, the nearest and clearest first, at most 40. Leave out anything you cannot make out.',
        'Also say whether the photo is taken outdoors in or beside a street ("outdoors": true) or inside a building, a station or an arcade ("outdoors": false); when it is not outdoors, list no objects.',
        'Codes:',
        CODE_LIST,
        'Reply with JSON only: {"outdoors": true, "objects": [ ... ]}'
    ].join('\n');
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The reply's "outdoors" answer: false only when the model says the photo is not outdoors in a street. */
export function parseStreetOutdoors(text: string): boolean {
    try { return (JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) as { outdoors?: unknown })?.outdoors !== false; } catch { return true; }
}

export function parseStreetReply(text: string): StreetReading[] {
    let j: unknown;
    try { j = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return []; }
    const list = Array.isArray(j) ? j : Array.isArray((j as { objects?: unknown })?.objects) ? (j as { objects: unknown[] }).objects : [];
    const out: StreetReading[] = [];
    for (const o of list as Array<Record<string, unknown>>) {
        const b = o?.box_2d;
        if (!Array.isArray(b) || b.length !== 4 || !b.every(x => typeof x === 'number')) continue;
        const [y0, x0, y1, x1] = (b as number[]).map(v => Math.max(0, Math.min(1000, v)));
        if (y1 <= y0 || x1 <= x0 || typeof o.label !== 'string' || !o.label.trim()) continue;
        out.push({
            label: o.label.trim().slice(0, 80), box: [y0, x0, y1, x1], ...(typeof o.code === 'string' ? { code: o.code.trim() } : {}),
            ...(num(o.heightM) !== undefined ? { heightM: num(o.heightM) } : {}), ...(num(o.widthM) !== undefined ? { widthM: num(o.widthM) } : {}), ...(num(o.depthM) !== undefined ? { depthM: num(o.depthM) } : {}),
            ...(typeof o.shape === 'string' ? { shape: o.shape.slice(0, 300) } : {}),
            baseVisible: o.baseVisible !== false, permanent: o.permanent !== false, confidence: Math.max(0, Math.min(1, num(o.confidence) ?? 0.5))
        });
    }
    return out;
}

// ------------------------------------------------------------------------------------------------ casting

export interface CastReading { foot: Vec3; rangeM: number; heightM: number; widthM: number }

/**
 * A reading's box cast into the scene: its foot (the bottom-middle of the box) onto the tile mesh's depth; its height and
 * width where the box's top and sides meet the vertical through the foot. `depth` is view z at `depthCam`'s size.
 */
export function castReading(r: Pick<StreetReading, 'box'>, cam: FrameCamera, depth: Float32Array, depthCam: FrameCamera): CastReading | undefined {
    const [y0, x0, y1, x1] = r.box;
    const W = cam.width, H = cam.height;
    const fx = ((x0 + x1) / 2000) * W, fy = (y1 / 1000) * H - 1;
    // the nearest surface in a small window at the foot (a pole's foot is a few pixels wide)
    const sx = depthCam.width / W, sy = depthCam.height / H;
    const cx = Math.round(fx * sx), cy = Math.round(fy * sy);
    let z = Infinity;
    for (let dy = -2; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) {
        const px = cx + dx, py = cy + dy;
        if (px < 0 || py < 0 || px >= depthCam.width || py >= depthCam.height) continue;
        z = Math.min(z, depth[py * depthCam.width + px]);
    }
    if (!(z < 1e8)) return undefined;
    const ray = pixelRay(cam, fx, fy);
    const along = ray.dir[0] * cam.fwd[0] + ray.dir[1] * cam.fwd[1] + ray.dir[2] * cam.fwd[2];
    if (along <= 1e-3) return undefined;
    const t = z / along;
    const foot: Vec3 = [ray.origin[0] + ray.dir[0] * t, ray.origin[1] + ray.dir[1] * t, ray.origin[2] + ray.dir[2] * t];
    const plan = Math.hypot(foot[0] - cam.eye[0], foot[2] - cam.eye[2]);
    const at = (px: number, py: number): Vec3 => {
        const q = pixelRay(cam, px, py);
        const h = Math.hypot(q.dir[0], q.dir[2]);
        const s = h > 1e-6 ? plan / h : 0;
        return [q.origin[0] + q.dir[0] * s, q.origin[1] + q.dir[1] * s, q.origin[2] + q.dir[2] * s];
    };
    const top = at(fx, (y0 / 1000) * H), left = at((x0 / 1000) * W, fy), right = at((x1 / 1000) * W, fy);
    return { foot, rangeM: plan, heightM: Math.max(0, top[1] - foot[1]), widthM: Math.hypot(right[0] - left[0], right[2] - left[2]) };
}

// ------------------------------------------------------------------------------------------------ merging and matching

export interface StreetDetection extends StreetReading { view: number; cast?: CastReading; dropped?: string }

export interface StreetObject {
    id: string;
    label: string;
    labels: Array<{ label: string; votes: number; confidence: number }>;
    code: string;
    /** Measured: the median foot of its views' boxes, and the median height and width there. */
    foot: Vec3;
    heightM: number;
    widthM: number;
    /** The model's own size estimates (median). */
    estimated: { heightM?: number; widthM?: number; depthM?: number };
    shapes: string[];
    views: number[];
    detections: number[];
    confidence: number;
    /** Most of its views call it installed to stay. */
    permanent: boolean;
    match?: { entityId: string; relation: 'STANDS_AS' | 'ATTACHED_TO' | 'UNDER'; distanceM: number };
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !['the', 'and', 'with', 'for'].includes(w)));
const sameThing = (a: StreetDetection, b: StreetDetection) => (a.code && b.code && a.code === b.code) || [...words(a.label)].some(w => words(b.label).has(w));
const median = (a: number[]) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const r2 = (v: number) => Math.round(v * 100) / 100;

/** What the reprojection pass needs of each view: its camera, and the tile mesh's depth seen from it (view z). */
export interface ViewGeometry { cam: FrameCamera; depth: Float32Array; depthCam: FrameCamera }

const intervalIoU = (a0: number, a1: number, b0: number, b1: number) => { const i = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); const u = Math.max(a1, b1) - Math.min(a0, b0); return u > 0 ? i / u : 0; };

/** The box (0..1000) an upright object of this foot, height and width makes in `cam`, its foot's view z; undefined out of frame. */
export function projectObjectBox(cam: FrameCamera, foot: Vec3, heightM: number, widthM: number): { box: [number, number, number, number]; z: number } | undefined {
    const f = projectToFrame(cam, foot), t = projectToFrame(cam, [foot[0], foot[1] + Math.max(0.2, heightM), foot[2]]);
    if (!f || !t) return undefined;
    const half = (Math.max(0.15, widthM) / 2) * cam.fx / f[2];
    const x0 = Math.min(f[0], t[0]) - half, x1 = Math.max(f[0], t[0]) + half, y0 = Math.min(f[1], t[1]), y1 = Math.max(f[1], t[1]);
    if (x1 < 0 || x0 > cam.width || y1 < 0 || y0 > cam.height || f[0] < 0 || f[0] > cam.width || f[1] < 0 || f[1] > cam.height) return undefined;
    return { box: [(y0 / cam.height) * 1000, (x0 / cam.width) * 1000, (y1 / cam.height) * 1000, (x1 / cam.width) * 1000], z: f[2] };
}

/**
 * Detections from different views are one object when their feet land within `mergeRadiusM` (growing with range) and they
 * say the same, or land on the same spot at the same height from near views; then, with each view's geometry, when an
 * object drawn into another view that should see it overlaps a box there.
 */
export function mergeDetections(dets: StreetDetection[], P = STREET_IDENTIFY_PARAMS, geometry?: Array<ViewGeometry | undefined>): StreetObject[] {
    const cast = dets.map((d, i) => ({ d, i })).filter(x => x.d.cast);
    const group: number[] = cast.map((_, k) => k);
    const find = (k: number): number => (group[k] === k ? k : (group[k] = find(group[k])));
    for (let a = 0; a < cast.length; a++) for (let b = a + 1; b < cast.length; b++) {
        const A = cast[a].d, B = cast[b].d;
        if (A.view === B.view) continue;
        const d = Math.hypot(A.cast!.foot[0] - B.cast!.foot[0], A.cast!.foot[2] - B.cast!.foot[2]);
        const hA = Math.max(0.1, A.cast!.heightM), hB = Math.max(0.1, B.cast!.heightM);
        const far = Math.max(A.cast!.rangeM, B.cast!.rangeM);
        const labelRadius = Math.max(P.mergeRadiusM, P.mergeRadiusPerRange * far);
        const sameSpot = far <= P.sameSpotMaxRangeM && d <= P.sameSpotM && Math.max(hA, hB) / Math.min(hA, hB) <= P.sameHeightRatio;
        if ((d <= labelRadius && sameThing(A, B)) || sameSpot) group[find(a)] = find(b);
    }
    if (geometry) {
        const members = () => { const m = new Map<number, number[]>(); cast.forEach((_, k) => m.set(find(k), [...(m.get(find(k)) ?? []), k])); return m; };
        const byView = new Map<number, number[]>();
        cast.forEach((c, k) => byView.set(c.d.view, [...(byView.get(c.d.view) ?? []), k]));
        for (const ks of members().values()) {
            const ds = ks.map(k => cast[k].d);
            const foot = [0, 1, 2].map(j => median(ds.map(d => d.cast!.foot[j]))) as Vec3;
            const h = median(ds.map(d => d.cast!.heightM)), w = median(ds.map(d => d.cast!.widthM));
            const seen = new Set(ds.map(d => d.view));
            geometry.forEach((g, v) => {
                if (!g || seen.has(v)) return;
                const p = projectObjectBox(g.cam, foot, h, w);
                if (!p) return;
                const range = Math.hypot(foot[0] - g.cam.eye[0], foot[2] - g.cam.eye[2]);
                if (range > P.maxRangeM) return;
                // hidden behind the tile mesh from this camera: not expected in this view
                const fp = projectToFrame(g.depthCam, foot)!;
                const px = Math.min(g.depthCam.width - 1, Math.max(0, Math.round(fp[0]))), py = Math.min(g.depthCam.height - 1, Math.max(0, Math.round(fp[1]) - 2));
                if (g.depth[py * g.depthCam.width + px] < p.z - P.occlusionToleranceM) return;
                const minW = (P.reprojectMinWidthPx / g.cam.width) * 1000;
                const widen = (b: number[]) => { const c = (b[1] + b[3]) / 2, half = Math.max(b[3] - b[1], minW) / 2; return [c - half, c + half]; };
                const [px0, px1] = widen(p.box);
                let best: { k: number; score: number } | undefined;
                for (const k of byView.get(v) ?? []) {
                    const b = cast[k].d.box;
                    const [bx0, bx1] = widen(b);
                    const score = Math.min(intervalIoU(px0, px1, bx0, bx1), intervalIoU(p.box[0], p.box[2], b[0], b[2]));
                    if (score >= P.reprojectOverlap && (!best || score > best.score)) best = { k, score };
                }
                if (best) group[find(best.k)] = find(ks[0]);
            });
        }
    }
    const byRoot = new Map<number, number[]>();
    cast.forEach((_, k) => byRoot.set(find(k), [...(byRoot.get(find(k)) ?? []), k]));
    const objects: StreetObject[] = [];
    for (const members of byRoot.values()) {
        const ds = members.map(k => cast[k].d), idx = members.map(k => cast[k].i);
        const votes = new Map<string, { votes: number; confidence: number }>();
        for (const d of ds) { const k = d.label.toLowerCase(); const v = votes.get(k) ?? { votes: 0, confidence: 0 }; v.votes++; v.confidence += d.confidence; votes.set(k, v); }
        const labels = [...votes].map(([label, v]) => ({ label, votes: v.votes, confidence: r2(v.confidence / v.votes) })).sort((a, b) => b.votes - a.votes || b.confidence - a.confidence);
        const codes = new Map<string, number>();
        for (const d of ds) if (d.code) codes.set(d.code, (codes.get(d.code) ?? 0) + d.confidence);
        const code = [...codes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? SB_FEATURE_PREFIX + 'OBJECT';
        const views = [...new Set(ds.map(d => d.view))];
        // more views agreeing is surer; one view is the model's word alone
        const conf = Math.min(1, (ds.reduce((s, d) => s + d.confidence, 0) / ds.length) * (views.length >= 2 ? 1 : 0.7));
        objects.push({
            id: '', label: labels[0].label, labels, code,
            foot: [0, 1, 2].map(k => r2(median(ds.map(d => d.cast!.foot[k])))) as Vec3,
            heightM: r2(median(ds.map(d => d.cast!.heightM))), widthM: r2(median(ds.map(d => d.cast!.widthM))),
            estimated: { heightM: r2(median(ds.map(d => d.heightM ?? NaN))) || undefined, widthM: r2(median(ds.map(d => d.widthM ?? NaN))) || undefined, depthM: r2(median(ds.map(d => d.depthM ?? NaN))) || undefined },
            shapes: [...new Set(ds.map(d => d.shape).filter((s): s is string => !!s))].slice(0, 3), views, detections: idx, confidence: r2(conf),
            permanent: ds.filter(d => d.permanent).length * 2 >= ds.length
        });
    }
    objects.sort((a, b) => b.views.length - a.views.length || b.confidence - a.confidence);
    objects.forEach((o, k) => { o.id = `street/${k}`; });
    return objects;
}

const planDistToBox = (x: number, z: number, lo: number[], hi: number[]) => Math.hypot(Math.max(lo[0] - x, 0, x - hi[0]), Math.max(lo[2] - z, 0, z - hi[2]));

/** Each object's inventory entity: a street cluster it stands as, else a crown it stands under, else a building it is fixed to. */
export function matchToInventory(objects: StreetObject[], inv: Pick<SceneInventory, 'entities'>, P = STREET_IDENTIFY_PARAMS): void {
    const boxOf = (e: SbFeature) => e.geometry.boundingBox as { lo: number[]; hi: number[] } | undefined;
    const clusters = inv.entities.filter(e => e.id.startsWith('cluster/') && boxOf(e));
    const trees = inv.entities.filter(e => e.id.startsWith('tree/') && boxOf(e));
    const buildings = inv.entities.filter(e => e.id.startsWith('building/') && boxOf(e));
    for (const o of objects) {
        const [x, , z] = o.foot;
        const nearest = (list: SbFeature[], radius: number) => {
            let best: { e: SbFeature; d: number } | undefined;
            for (const e of list) { const b = boxOf(e)!; const d = planDistToBox(x, z, b.lo, b.hi); if (d <= radius && (!best || d < best.d)) best = { e, d }; }
            return best;
        };
        const c = nearest(clusters, P.matchRadiusM), t = nearest(trees, 0), b = nearest(buildings, P.attachRadiusM);
        if (c) o.match = { entityId: c.e.id, relation: 'STANDS_AS', distanceM: r2(c.d) };
        else if (b) o.match = { entityId: b.e.id, relation: 'ATTACHED_TO', distanceM: r2(b.d) };
        else if (t) o.match = { entityId: t.e.id, relation: 'UNDER', distanceM: 0 };
    }
}

// ------------------------------------------------------------------------------------------------ the step

export interface StreetIdentifyView {
    index: number; panoId: string; source: 'grounding' | 'static'; captureMonth?: string; headingDeg: number; registration: string; readings: number; error?: string;
    imagePath?: string; overlayPath?: string;
    /** The model said the photo is not outdoors in a street (an interior capture): its boxes are not used. */
    indoors?: boolean;
}

export interface StreetIdentifyResult {
    schema: 'scratchbox.street-identify/1';
    version: string;
    area: { centre: { x: number; z: number }; radiusM: number };
    panos: Array<{ panoId: string; x: number; z: number; date?: string }>;
    views: StreetIdentifyView[];
    detections: StreetDetection[];
    objects: StreetObject[];
    /** Codes the model proposed that the list does not have, for review (never added). */
    proposedCodes: string[];
    stats: { metadataCalls: number; panosFound: number; viewsFetched: number; viewsRegistered: number; readings: number; cast: number; objects: number; multiView: number; matched: number; newObjects: number; modelCalls: number; cachedCalls: number };
    notes: string[];
    elapsedMs: number;
}

export interface StreetIdentifyInput {
    origin: GeodeticOrigin;
    /** The area read: its centre and radius in the tile frame. */
    area: { centre: { x: number; z: number }; radiusM: number };
    roads: Vec2[][];
    ground: Pick<GroundModel, 'groundAt'>;
    /** The full tile mesh (trees and all: what the photos show) and its files, for depth and registration. */
    tileMesh: RenderMesh3D;
    tileMeshFiles: string[];
    inventory?: Pick<SceneInventory, 'entities'>;
    streetView: StreetViewEvidenceDeps;
    vision: VisionModelChain<string>;
    register?: (job: PanoRegistrationJob, opts: { signal?: AbortSignal; log?: (m: string) => void }) => Promise<PanoRegistrationOutcome>;
    /**
     * Where the photos come from: 'grounding' (the Maps Imagery Grounding API: US panoramas only), 'static' (the Street View
     * Static API, read for identification, user decision 2026-10-22), or 'auto' (default): the grounding API, and the
     * Static API when it refuses the area's panoramas.
     */
    source?: 'grounding' | 'static' | 'auto';
    /** When given, each view and its boxes are written here (for looking at; the build itself writes no grounding image). */
    imagesDir?: string;
    params?: Partial<typeof STREET_IDENTIFY_PARAMS>;
    signal?: AbortSignal;
    onProgress?: (m: string) => void;
}

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => { for (let i; (i = next++) < items.length;) out[i] = await fn(items[i], i); }));
    return out;
}

export async function identifyStreetObjects(input: StreetIdentifyInput): Promise<StreetIdentifyResult> {
    const t0 = Date.now();
    const P = { ...STREET_IDENTIFY_PARAMS, ...(input.params ?? {}) };
    const progress = input.onProgress ?? (() => undefined);
    if (!input.streetView.mapsApiKey) throw new Error('Street View not configured: no Google Maps API key for pano discovery');
    const wanted = input.source ?? 'auto';
    if (wanted === 'grounding' && !input.streetView.grounding) throw new Error(input.streetView.groundingUnavailable || 'no service account for the Maps Imagery Grounding API');
    const { centre, radiusM } = input.area;
    const inArea = (x: number, z: number) => Math.hypot(x - centre.x, z - centre.z) <= radiusM;
    const notes: string[] = [];

    // panos along the streets
    const points = streetPoints(input.roads, inArea, P.panoSpacingM);
    if (!points.length) throw new Error('no road centreline runs through the area: there is no street to read');
    progress(`looking for Street View panoramas at ${points.length} points along the streets`);
    const found = await discoverPanosAt(input.origin, points, input.streetView, input.signal, centre, undefined, wanted !== 'grounding');
    const panos = pickPanos(found.panos.filter(p => inArea(p.x, p.z)), centre, P.panoSpacingM, P.maxPanos);
    if (!panos.length) throw new Error(`no Google-captured panorama in the area (${found.panos.length} found nearby, ${found.rejectedNotGoogle} user photospheres left out)`);
    const planned = panos.flatMap(p => viewsForPano(p, input.roads, input.ground.groundAt, P));

    // the views: the grounding API (a pano at a time in batches: it is slow per image, not per batch), or the Static API
    const images: EvidenceImage[] = [];
    const sourceOf = new Map<string, 'grounding' | 'static'>();
    const fetchErrors: string[] = [];
    let source: 'grounding' | 'static' = wanted === 'static' || !input.streetView.grounding ? 'static' : 'grounding';
    const refusedBefore = knownRefusals(input.streetView);
    if (source === 'grounding' && wanted === 'auto' && refusedBefore.has(panos[0].panoId)) {
        notes.push(`the grounding API has refused this area's panoramas before (${refusedBefore.get(panos[0].panoId)}): the Street View Static API's images are read instead`);
        source = 'static';
    }
    if (source === 'grounding') {
        progress(`fetching ${planned.length} views from ${panos.length} panoramas through the grounding API`);
        for (let i = 0; i < planned.length; i += 12) {
            const got = await fetchViews(planned.slice(i, i + 12), input.streetView, input.signal);
            images.push(...got.images);
            for (const f of got.failures) fetchErrors.push(`${f.view.panoId} ${f.view.headingDeg}°: ${f.error}`);
            // every view of the first batch refused: the grounding API does not serve this area (it serves US panoramas)
            if (i === 0 && !got.images.length && got.failures.length && got.failures.every(f => f.refused) && wanted === 'auto') {
                notes.push(`the grounding API refused every panorama asked for here (${got.failures[0].error}): it serves US panoramas only, so the Street View Static API's images are read instead`);
                fetchErrors.length = 0;
                source = 'static';
                break;
            }
        }
    }
    if (source === 'static') {
        progress(`fetching ${planned.length} views from ${panos.length} panoramas through the Street View Static API`);
        const got = await fetchStaticViews(planned, input.streetView.mapsApiKey!, P, input.streetView.fetchImpl ?? fetch, input.signal);
        images.push(...got.images);
        fetchErrors.push(...got.failures);
    }
    for (const im of images) sourceOf.set(im.id, source);
    if (fetchErrors.length) notes.push(`${fetchErrors.length} view${fetchErrors.length === 1 ? '' : 's'} could not be fetched (${fetchErrors.slice(0, 3).join('; ')})`);
    if (!images.length) throw new Error(`every view failed (${fetchErrors.slice(0, 3).join('; ')})`);

    // registration against the tile mesh (the nominal pose, good to about 2 m and 2 degrees, when it cannot be registered)
    let reg: PanoRegistrationOutcome | undefined;
    try {
        const held: HeldImage[] = images.map(im => ({ id: im.id, bytes: im.bytes, widthPx: im.widthPx, heightPx: im.heightPx, view: im.view }));
        progress(`registering ${images.length} views against the 3D tiles`);
        reg = await (input.register ?? runPanoRegistrationOffThread)({ images: held, meshFiles: input.tileMeshFiles, correspondences: [], faces: [] }, { ...(input.signal ? { signal: input.signal } : {}), log: progress });
    } catch (err) {
        if (input.signal?.aborted) throw err;
        notes.push(`registration failed (${err instanceof Error ? err.message : String(err)}); the nominal poses stand`);
    }
    const corrections = reg?.registration?.corrections;
    if (reg) notes.push(`registration: ${reg.frames} frames of ${reg.panos} panos; ${reg.registration ? `${reg.registration.perPano.filter(p => p.method).length} panos took a registered pose (${[...new Set(reg.registration.perPano.map(p => p.method ?? 'none'))].join(', ')})` : 'no pose was kept, the nominal poses stand'}`);

    // each view read once, its boxes cast
    const detections: StreetDetection[] = [];
    const views: StreetIdentifyView[] = [];
    let modelCalls = 0, cachedCalls = 0;
    const proposed = new Set<string>();
    const geometry: Array<ViewGeometry | undefined> = [];
    if (input.imagesDir) fs.mkdirSync(input.imagesDir, { recursive: true });
    await mapConcurrent(images, P.concurrency, async (im, index) => {
        const v = im.view;
        const correction: PoseCorrection | undefined = corrections?.get(v.panoId);
        const per = reg?.registration?.perPano.find(p => p.panoId === v.panoId);
        const view: StreetIdentifyView = { index, panoId: v.panoId, source: sourceOf.get(im.id) ?? 'grounding', ...(v.date ? { captureMonth: v.date.slice(0, 7) } : {}), headingDeg: v.headingDeg, registration: per?.method ?? 'nominal', readings: 0 };
        views[index] = view;
        const cast = { eye: v.eye, headingDeg: v.headingDeg, pitchDeg: v.pitchDeg, fovDeg: v.fovDeg, ...(correction ? { correction } : {}) };
        const cam = castCamera({ ...cast, widthPx: im.widthPx, heightPx: im.heightPx });
        const dW = Math.min(P.depthWidthPx, im.widthPx), dH = Math.round((dW * im.heightPx) / im.widthPx);
        const depthCam = castCamera({ ...cast, widthPx: dW, heightPx: dH });
        let readings: StreetReading[] = [];
        try {
            const sent = await capImageSide(im.bytes, im.mimeType, im.widthPx, im.heightPx, P.sendMaxSidePx);
            const own = new AbortController();
            const timer = setTimeout(() => own.abort(new Error(`the vision call took longer than ${P.timeoutMs / 1000} s`)), P.timeoutMs);
            try {
                const r = await input.vision.generate({
                    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: sent.mimeType, data: sent.bytes.toString('base64') } }, { text: streetReadingPrompt() }] }],
                    config: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 8192, abortSignal: input.signal ? AbortSignal.any([input.signal, own.signal]) : own.signal }
                }, { stage: 'street-identify', thinkingBudget: P.thinkingBudget });
                modelCalls++;
                if (r.cached) cachedCalls++;
                const text = (r.response.candidates?.[0]?.content?.parts ?? []).filter(p => !(p as { thought?: boolean }).thought).map(p => p.text ?? '').join('');
                readings = parseStreetReply(text);
                if (!parseStreetOutdoors(text)) { view.indoors = true; readings = []; }
                r.remember();
            } finally { clearTimeout(timer); }
        } catch (err) {
            if (input.signal?.aborted) throw err;
            view.error = err instanceof Error ? err.message : String(err);
            return;
        }
        view.readings = readings.length;
        const depth = renderFrameDepth(input.tileMesh, depthCam);
        geometry[index] = { cam, depth, depthCam };
        for (const rd of readings) {
            if (rd.code) for (const c of reviewUnknownCodes([rd.code])) proposed.add(c);
            const d: StreetDetection = { ...rd, view: index };
            const c = rd.baseVisible ? castReading(rd, cam, depth, depthCam) : undefined;
            if (!rd.baseVisible) d.dropped = 'its foot is out of the photo';
            else if (!c) d.dropped = 'its foot meets no surface of the tile mesh';
            else if (c.rangeM > P.maxRangeM) d.dropped = `${Math.round(c.rangeM)} m away, too small to measure`;
            else d.cast = { foot: c.foot.map(r2) as Vec3, rangeM: r2(c.rangeM), heightM: r2(c.heightM), widthM: r2(c.widthM) };
            detections.push(d);
        }
        if (input.imagesDir) {
            const stem = `${v.panoId}_${Math.round(v.headingDeg)}`;
            view.imagePath = path.join(input.imagesDir, `${stem}.jpg`);
            fs.writeFileSync(view.imagePath, im.bytes);
            view.overlayPath = path.join(input.imagesDir, `${stem}_boxes.png`);
            fs.writeFileSync(view.overlayPath, overlay(im.bytes, detections.filter(x => x.view === index)));
        }
    });

    const objects = mergeDetections(detections, P, geometry);
    if (input.inventory) matchToInventory(objects, input.inventory, P);
    const cast = detections.filter(d => d.cast).length;
    const matched = objects.filter(o => o.match).length;
    notes.unshift(`street identification: ${views.length} views from ${panos.length} panoramas, ${detections.length} boxes read, ${cast} placed in the scene, ${objects.length} objects (${objects.filter(o => o.views.length >= 2).length} seen in two views or more); ${matched} stand on something the inventory has, ${objects.length - matched} the scan has nothing for`);
    const indoors = views.filter(v => v?.indoors).length;
    if (indoors) notes.push(`${indoors} view${indoors === 1 ? ' was' : 's were'} taken indoors (the model's answer): ${indoors === 1 ? 'its' : 'their'} boxes are not used`);
    if (proposed.size) notes.push(`codes the model proposed for review: ${[...proposed].join(', ')}`);
    return {
        schema: 'scratchbox.street-identify/1', version: STREET_IDENTIFY_VERSION, area: input.area,
        panos: panos.map(p => ({ panoId: p.panoId, x: r2(p.x), z: r2(p.z), ...(p.date ? { date: p.date } : {}) })), views, detections, objects, proposedCodes: [...proposed],
        stats: {
            metadataCalls: found.metadataCalls, panosFound: found.panos.length, viewsFetched: images.length, viewsRegistered: views.filter(v => v && v.registration !== 'nominal').length,
            readings: detections.length, cast, objects: objects.length, multiView: objects.filter(o => o.views.length >= 2).length, matched, newObjects: objects.length - matched, modelCalls, cachedCalls
        },
        notes, elapsedMs: Date.now() - t0
    };
}

/**
 * Views from the Street View Static API: the same pano, heading and elevation (its pitch is up-positive, the app's own
 * convention), at its largest standard size. Its fov is the image's true horizontal fov; the view records the grounding
 * request fov that gives the same true fov, so the cameras (survey-casting.ts) and the registration read it unchanged.
 */
export async function fetchStaticViews(views: SelectedView[], apiKey: string, P: Pick<typeof STREET_IDENTIFY_PARAMS, 'fovDeg' | 'staticWidthPx' | 'staticHeightPx'>, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<{ images: EvidenceImage[]; failures: string[] }> {
    const W = P.staticWidthPx, H = P.staticHeightPx;
    const equivalentFov = groundingRequestFovDeg(P.fovDeg, W / H);
    const failures: string[] = [];
    const got = await mapConcurrent(views, 8, async v => {
        const t0 = Date.now();
        const url = `https://maps.googleapis.com/maps/api/streetview?size=${W}x${H}&pano=${encodeURIComponent(v.panoId)}&heading=${v.headingDeg}&pitch=${v.pitchDeg}&fov=${P.fovDeg}&source=outdoor&return_error_code=true&key=${encodeURIComponent(apiKey)}`;
        try {
            const res = await fetchImpl(url, signal ? { signal } : {});
            const type = res.headers?.get?.('content-type') ?? '';
            if (!res.ok || !type.startsWith('image/')) throw new Error(`Street View Static API ${res.status}${type ? ` (${type})` : ''}`);
            const bytes = Buffer.from(await res.arrayBuffer());
            const view: SelectedView = { ...v, fovDeg: equivalentFov };
            return {
                view, bytes, mimeType: type.split(';')[0], widthPx: W, heightPx: H, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
                id: `svs:${v.panoId}:${v.headingDeg}:${v.pitchDeg}:${P.fovDeg}`, nativeSampleM: 0, fetchMs: Date.now() - t0
            } as EvidenceImage;
        } catch (err) {
            if (signal?.aborted) throw err;
            failures.push(`${v.panoId} ${v.headingDeg}°: ${err instanceof Error ? err.message : String(err)}`);
            return undefined;
        }
    });
    return { images: got.filter((x): x is EvidenceImage => !!x), failures };
}

/** The view with its boxes drawn (green placed, red dropped) and numbered by detection order: a PNG for looking at. */
function overlay(jpeg: Buffer, dets: StreetDetection[]): Buffer {
    const img = decodeImageInMemory(jpeg);
    const { width: W, height: H, rgba } = img;
    const put = (x: number, y: number, c: number[]) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255; };
    for (const d of dets) {
        const [y0, x0, y1, x1] = d.box.map((v, k) => Math.round((v / 1000) * (k % 2 === 0 ? H : W)));
        const c = d.cast ? [40, 230, 60] : [230, 40, 40];
        for (let t = 0; t < 3; t++) {
            for (let x = x0; x <= x1; x++) { put(x, y0 + t, c); put(x, y1 - t, c); }
            for (let y = y0; y <= y1; y++) { put(x0 + t, y, c); put(x1 - t, y, c); }
        }
    }
    return encodePng(W, H, rgba, 4);
}

// ------------------------------------------------------------------------------------------------ into the inventory

/**
 * The identifications into the inventory: a matched entity gains the model's label (photo-inferred, with the views it
 * rests on); an object the scan has nothing for becomes an entity of its own, placed and sized by measurement, named by
 * the model.
 */
export function applyStreetIdentification(inv: SceneInventory, r: StreetIdentifyResult): { labelled: number; added: number } {
    const byId = new Map(inv.entities.map(e => [e.id, e]));
    let labelled = 0, added = 0;
    const by = `vision model over ${STREET_IDENTIFY_VERSION}`;
    for (const o of r.objects) {
        const label: SbFeatureTypeLabel = { code: o.code, confidence: o.confidence, by };
        const words = `Street View (${o.views.length} view${o.views.length === 1 ? '' : 's'}): ${o.label}${o.shapes[0] ? `; ${o.shapes[0]}` : ''}`;
        const target = o.match && o.match.relation === 'STANDS_AS' ? byId.get(o.match.entityId) : undefined;
        if (target) {
            target.typeLabels = [...(target.typeLabels ?? []), label];
            target.types = typesFromLabels(target.typeLabels);
            target.description = `${words}. ${target.description ?? ''}`.trim();
            target.measurements = { ...target.measurements, streetViewHeightM: o.heightM, streetViewWidthM: o.widthM, streetViewViews: o.views.length };
            target.provenance = { ...target.provenance, sources: [...target.provenance.sources, { kind: 'street-view', id: o.id }] };
            labelled++;
            continue;
        }
        const half = Math.max(0.15, o.widthM / 2);
        inv.entities.push({
            schema: 'sb-feature/1', id: o.id, types: typesFromLabels([label]), typeLabels: [label], description: `${words}; the scan has no geometry here`,
            geometry: { boundingBox: { lo: [o.foot[0] - half, o.foot[1], o.foot[2] - half], hi: [o.foot[0] + half, o.foot[1] + o.heightM, o.foot[2] + half], frame: 'tile (x east, y up, z south), metres' } },
            measurements: { heightM: o.heightM, widthM: o.widthM, permanent: o.permanent ? 1 : 0, estimatedHeightM: o.estimated.heightM ?? null, estimatedWidthM: o.estimated.widthM ?? null, estimatedDepthM: o.estimated.depthM ?? null, views: o.views.length },
            provenance: { label: 'photo-inferred', confidence: o.confidence, sources: [{ kind: 'street-view', id: o.id }], method: `${STREET_IDENTIFY_VERSION}: named by the vision model; placed and sized from the registered camera and the tile mesh's depth` },
            ...(o.match ? { relations: [{ kind: o.match.relation, target: o.match.entityId, confidence: o.confidence }] } : {})
        });
        added++;
    }
    return { labelled, added };
}
