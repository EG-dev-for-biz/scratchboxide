/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pixel ownership for the Street View projection: a photo pixel may texture the structure only if it shows the structure.
 *
 * The bake-off (docs/processes/staged_location_photo_match_bakeoff.md) found Street View painting the wrong building: a
 * neighbour's facade on St. Mark's front, a neighbouring storefront and a billboard across the Haughwout. The depth test
 * against the scan and the full tile mesh (texture-projection.ts) only knows where the geometry is; when the pose is off by
 * a metre, or the tile mesh is missing what stands in front, the pixel the texel projects to holds something else.
 *
 * For each registered view the structure is cut out of the photo itself with the repo's open-vocabulary segmenter
 * (ObjectSegmenterService: the MediaPipe interactive segmenter, then GrabCut on the edge), prompted from geometry only, no
 * vision model: the box and the positive points are where the registered structure (the isolated scan) is the nearest
 * surface in the view, the negative points where the full tile mesh shows something nearer or beside it (neighbours, what
 * stands in front). The mask is the photo's own say on which pixels are the structure, so it also catches a pose error.
 *
 * A view whose cut-out disagrees with where the geometry puts the structure (intersection over union below
 * OWNERSHIP_MIN_IOU) has no pixel it can vouch for: the segmenter took something else, or the pose is far off. All its pixels
 * fail. A view the segmenter cannot run on fails whole too. Failing pixels are not projected; their texels fall to the next
 * view or to the next rung (the tile photo), and the bake records how many samples were refused (ownership in its report).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ProjectionView } from '../../../common/spatial/texture-pass-contracts';
import { renderFrameDepth } from '../../spatial/StreetViewPoseRegistrar';
import { resolveRepoPython } from '../../process/repo-python';
import type { RenderMesh3D } from '../../spatial/HeadlessMeshSilhouetteRenderer';
import { encodePng } from './png-encode';
import { decodeImageInMemory } from './tile-texture-transfer';

/** Part of the texture cache key: a change to the ownership step is a new version. */
export const OWNERSHIP_VERSION = 1;
/** Below this agreement between the cut-out and the structure's projection, the view vouches for no pixel. */
export const OWNERSHIP_MIN_IOU = 0.3;
/** The structure needs this share of the view's pixels for a cut-out to be asked for. */
export const OWNERSHIP_MIN_TARGET_SHARE = 0.01;
/** Pixels the mask is grown by (the segmenter's edge and the texel footprint's own blur). */
export const OWNERSHIP_DILATE_PX = 2;

type NormPoint = [number, number];
type NormBox = [number, number, number, number];

export interface OwnershipPrompts {
    /** 1 where the structure is the nearest surface in the view. */
    target: Uint8Array;
    targetPixels: number;
    box: NormBox;
    positive: NormPoint[];
    negative: NormPoint[];
}

/** Where the structure is the nearest surface (camera z, Infinity or >= 1e8 = nothing), with a depth tolerance. */
const nearest = (t: number, c: number): boolean => Number.isFinite(t) && t < 1e8 && (!(Number.isFinite(c) && c < 1e8) || t <= c + 0.3 + 0.02 * t);

/** Erodes a binary mask by `r` pixels (square structuring element, separable). */
function erode(mask: Uint8Array, W: number, H: number, r: number): Uint8Array {
    if (r <= 0) return mask.slice();
    const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        let run = 0;
        const row = y * W;
        const left = new Int32Array(W);
        for (let x = 0; x < W; x++) { run = mask[row + x] ? run + 1 : 0; left[x] = run; }
        run = 0;
        for (let x = W - 1; x >= 0; x--) { run = mask[row + x] ? run + 1 : 0; tmp[row + x] = left[x] > r && run > r ? 1 : 0; }
    }
    for (let x = 0; x < W; x++) {
        let run = 0;
        const up = new Int32Array(H);
        for (let y = 0; y < H; y++) { run = tmp[y * W + x] ? run + 1 : 0; up[y] = run; }
        run = 0;
        for (let y = H - 1; y >= 0; y--) { run = tmp[y * W + x] ? run + 1 : 0; out[y * W + x] = up[y] > r && run > r ? 1 : 0; }
    }
    return out;
}

/** Grows a binary mask by `r` pixels. */
export function dilateMask(mask: Uint8Array, W: number, H: number, r: number): Uint8Array {
    const inv = new Uint8Array(W * H);
    for (let i = 0; i < inv.length; i++) inv[i] = mask[i] ? 0 : 1;
    const e = erode(inv, W, H, r);
    for (let i = 0; i < e.length; i++) e[i] = e[i] ? 0 : 1;
    return e;
}

/** Up to `k` pixels of `mask`, spread out (farthest-point sampling from the mask's most interior pixel), normalised. */
function spread(mask: Uint8Array, W: number, H: number, k: number): NormPoint[] {
    const pts: number[] = [];
    for (let i = 0; i < mask.length; i += 7) if (mask[i]) pts.push(i);
    if (!pts.length) return [];
    let sx = 0, sy = 0;
    for (const i of pts) { sx += i % W; sy += (i / W) | 0; }
    const cx = sx / pts.length, cy = sy / pts.length;
    let first = pts[0], best = Infinity;
    for (const i of pts) { const d = Math.hypot((i % W) - cx, ((i / W) | 0) - cy); if (d < best) { best = d; first = i; } }
    const chosen = [first];
    const dmin = pts.map(i => Math.hypot((i % W) - (first % W), ((i / W) | 0) - ((first / W) | 0)));
    while (chosen.length < k) {
        let far = -1, fd = 0;
        for (let j = 0; j < pts.length; j++) if (dmin[j] > fd) { fd = dmin[j]; far = j; }
        if (far < 0 || fd < 0.05 * Math.min(W, H)) break;
        chosen.push(pts[far]);
        for (let j = 0; j < pts.length; j++) dmin[j] = Math.min(dmin[j], Math.hypot((pts[j] % W) - (pts[far] % W), ((pts[j] / W) | 0) - ((pts[far] / W) | 0)));
    }
    return chosen.map(i => [((i % W) + 0.5) / W, (((i / W) | 0) + 0.5) / H]);
}

/**
 * The segmenter's prompts from the structure's and the place's depth in a view: the box around the structure, positive
 * points well inside it, negative points on what the tile mesh shows nearer or next to it inside the box.
 */
export function ownershipPrompts(targetDepth: Float32Array, contextDepth: Float32Array | undefined, W: number, H: number): OwnershipPrompts {
    const target = new Uint8Array(W * H), other = new Uint8Array(W * H);
    let n = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let i = 0; i < W * H; i++) {
        const c = contextDepth ? contextDepth[i] : Infinity;
        if (nearest(targetDepth[i], c)) {
            target[i] = 1; n++;
            const x = i % W, y = (i / W) | 0;
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        } else if (Number.isFinite(c) && c < 1e8) other[i] = 1;
    }
    if (!n) return { target, targetPixels: 0, box: [0, 0, 1, 1], positive: [], negative: [] };
    const pad = 0.03 * Math.max(W, H);
    const bx0 = Math.max(0, x0 - pad), by0 = Math.max(0, y0 - pad), bx1 = Math.min(W, x1 + 1 + pad), by1 = Math.min(H, y1 + 1 + pad);
    const r = Math.max(2, Math.round(0.03 * Math.min(W, H)));
    let inner = erode(target, W, H, r);
    if (!inner.some(v => v)) inner = erode(target, W, H, 1);
    const otherInner = erode(other, W, H, r);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x < bx0 || x >= bx1 || y < by0 || y >= by1) otherInner[y * W + x] = 0;
    return {
        target, targetPixels: n, box: [bx0 / W, by0 / H, bx1 / W, by1 / H],
        positive: spread(inner.some(v => v) ? inner : target, W, H, 5), negative: spread(otherInner, W, H, 4)
    };
}

/** Intersection over union of two binary masks. */
export function maskIou(a: Uint8Array, b: Uint8Array): number {
    let i = 0, u = 0;
    for (let k = 0; k < a.length; k++) { const x = a[k] ? 1 : 0, y = b[k] ? 1 : 0; i += x & y; u += x | y; }
    return u ? i / u : 0;
}

/**
 * The segmenter as the ownership step uses it: the photo and the prompts in, a binary mask (1 = the object) out. With a
 * `target` description it finds the structure by what it is (a vision model, the geometry's box as a hint) and throws
 * OwnershipTargetNotFound when the photo does not show it; without one it cuts out what the geometry's points lie on.
 */
export type OwnershipSegmenter = (image: { width: number; height: number; rgba: Uint8Array }, prompts: { box: NormBox; positive: NormPoint[]; negative: NormPoint[]; target?: string }, signal?: AbortSignal) => Promise<Uint8Array>;

/** The segmenter's vision model did not find the described structure in the photo. */
export class OwnershipTargetNotFound extends Error {
    constructor(readonly reason: string) { super(reason); this.name = 'OwnershipTargetNotFound'; }
}

export interface ViewOwnershipRecord {
    panoId: string;
    /** 'segmented': the mask stands; 'refused': no pixel of the view is vouched for (why in `reason`). */
    status: 'segmented' | 'refused';
    /** How the segmenter was prompted: the description with the geometry's box as a hint, or the geometry alone. */
    prompts: 'description+geometry' | 'geometry';
    reason?: string;
    targetPixels: number;
    maskPixels: number;
    /** Agreement of the cut-out with where the geometry puts the structure. */
    iou?: number;
    ms: number;
}

/**
 * Cuts the structure out of every view (`concurrency` at a time) and returns the views with `ownerMask` set, and a record
 * per view. A view that cannot be vouched for gets an all-zero mask (none of its pixels textures the structure).
 */
export async function ownViews(input: {
    views: ProjectionView[]; structure: RenderMesh3D; context?: RenderMesh3D; segment: OwnershipSegmenter;
    concurrency?: number; signal?: AbortSignal; onProgress?: (m: string) => void;
    /**
     * What the structure is, in words (the request's place): the segmenter then finds it by what it is, so a photo that
     * shows a neighbour where the pose puts the structure is caught. Absent: geometry prompts only (they cannot tell a
     * neighbour standing exactly where the structure projects from the structure).
     */
    target?: string;
    /** Writes one overlay PNG per view here (diagnostics): the photo dimmed outside the cut-out, the projection's edge in red. */
    debugDir?: string;
}): Promise<{ views: ProjectionView[]; records: ViewOwnershipRecord[] }> {
    const out: ProjectionView[] = input.views.slice();
    const records: ViewOwnershipRecord[] = new Array(input.views.length);
    let next = 0, done = 0;
    const work = async () => {
        for (let k; (k = next++) < input.views.length;) {
            const v = input.views[k];
            const t0 = Date.now();
            const W = v.camera.width, H = v.camera.height;
            const refuse = (reason: string, targetPixels: number, extra: Partial<ViewOwnershipRecord> = {}) => {
                out[k] = { ...v, ownerMask: new Uint8Array(W * H) };
                records[k] = { panoId: v.panoId, status: 'refused', prompts: input.target ? 'description+geometry' : 'geometry', reason, targetPixels, maskPixels: 0, ms: Date.now() - t0, ...extra };
            };
            try {
                if (input.signal?.aborted) throw input.signal.reason ?? new Error('stopped');
                const p = ownershipPrompts(renderFrameDepth(input.structure, v.camera), input.context ? renderFrameDepth(input.context, v.camera) : undefined, W, H);
                if (p.targetPixels < OWNERSHIP_MIN_TARGET_SHARE * W * H || !p.positive.length) {
                    refuse(`the structure covers ${(100 * p.targetPixels / (W * H)).toFixed(1)} percent of the view, too little to cut out`, p.targetPixels);
                    continue;
                }
                let raw: Uint8Array;
                try {
                    raw = await input.segment(v.image, { box: p.box, positive: p.positive, negative: p.negative, ...(input.target ? { target: input.target } : {}) }, input.signal);
                } catch (err) {
                    if (!(err instanceof OwnershipTargetNotFound)) throw err;
                    refuse(`the structure is not in this photo (${err.reason})`, p.targetPixels);
                    continue;
                }
                if (raw.length !== W * H) throw new Error(`the segmenter returned ${raw.length} pixels for a ${W}x${H} view`);
                const iou = maskIou(raw, p.target);
                if (input.debugDir) writeOverlay(path.join(input.debugDir, `${String(k).padStart(2, '0')}_${v.panoId}_iou${Math.round(iou * 100)}.png`), v.image, raw, p);
                if (iou < OWNERSHIP_MIN_IOU) {
                    refuse(`the cut-out agrees with the structure's projection on ${(100 * iou).toFixed(0)} percent (intersection over union, at least ${100 * OWNERSHIP_MIN_IOU} needed): the photo there shows something else, or the pose is far off`, p.targetPixels, { iou: Math.round(iou * 1000) / 1000 });
                    continue;
                }
                const mask = dilateMask(raw, W, H, OWNERSHIP_DILATE_PX);
                let m = 0;
                for (let i = 0; i < mask.length; i++) m += mask[i];
                out[k] = { ...v, ownerMask: mask };
                records[k] = { panoId: v.panoId, status: 'segmented', prompts: input.target ? 'description+geometry' : 'geometry', targetPixels: p.targetPixels, maskPixels: m, iou: Math.round(iou * 1000) / 1000, ms: Date.now() - t0 };
            } catch (err) {
                if (input.signal?.aborted) throw err;
                refuse(`the segmenter failed (${err instanceof Error ? err.message : String(err)})`, 0);
            } finally {
                input.onProgress?.(`cutting the structure out of the Street View photos: ${++done} of ${input.views.length}`);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(input.concurrency ?? 3, input.views.length)) }, work));
    return { views: out, records };
}

/** Diagnostics: the photo dimmed outside the cut-out, the projected structure's outline red, the prompts as dots. */
function writeOverlay(file: string, image: { width: number; height: number; rgba: Uint8Array }, mask: Uint8Array, p: OwnershipPrompts): void {
    const W = image.width, H = image.height, rgb = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = mask[i] ? image.rgba[i * 4 + c] : image.rgba[i * 4 + c] >> 2;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (p.target[i] && (!p.target[i - 1] || !p.target[i + 1] || !p.target[i - W] || !p.target[i + W])) rgb.set([255, 0, 0], i * 3);
    }
    const dot = (pt: NormPoint, c: [number, number, number]) => { const cx = Math.round(pt[0] * W), cy = Math.round(pt[1] * H); for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const x = cx + dx, y = cy + dy; if (x >= 0 && y >= 0 && x < W && y < H) rgb.set(c, (y * W + x) * 3); } };
    p.positive.forEach(q => dot(q, [0, 255, 0])); p.negative.forEach(q => dot(q, [0, 128, 255]));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, encodePng(W, H, rgb, 3));
}

/** The repo's segmenter (ObjectSegmenterService: MediaPipe interactive + GrabCut) as an OwnershipSegmenter. */
export function objectSegmenter(options: { pythonBinary?: string; modelSource?: { getGenAIClient(): Promise<unknown>; getModelCandidates(requested?: string): string[] } } = {}): OwnershipSegmenter {
    // loaded on first use: the service pulls in the video stack
    let svc: { segment(o: Record<string, unknown>): Promise<{ maskPaths: string[] }> } | undefined;
    return async (image, prompts, signal) => {
        if (!svc) {
            const { ObjectSegmenterService } = require('../../video/ObjectSegmenterService');
            svc = new ObjectSegmenterService({ pythonBinary: options.pythonBinary ?? resolveRepoPython('SCRATCHBOX_PYTHON', 'PYTHON_BIN'), ...(options.modelSource ? { modelSource: options.modelSource } : {}) });
        }
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-sv-own-'));
        try {
            const rgb = new Uint8Array(image.width * image.height * 3);
            for (let i = 0; i < image.width * image.height; i++) { rgb[i * 3] = image.rgba[i * 4]; rgb[i * 3 + 1] = image.rgba[i * 4 + 1]; rgb[i * 3 + 2] = image.rgba[i * 4 + 2]; }
            const imagePath = path.join(dir, 'view.png');
            fs.writeFileSync(imagePath, encodePng(image.width, image.height, rgb, 3));
            // with a description the vision model places the positive points (the geometry's box is its hint, the geometry's
            // negatives are added to its own); without one the geometry's points prompt the segmenter directly
            const described = !!prompts.target && !!options.modelSource;
            let r: { maskPaths: string[] };
            try {
                r = await svc!.segment({
                    imagePath, outputDir: path.join(dir, 'out'), box: prompts.box, negativePoints: prompts.negative, refine: true, ...(signal ? { signal } : {}),
                    ...(described ? { target: prompts.target } : { positivePoints: prompts.positive })
                });
            } catch (err) {
                if ((err as Error)?.name === 'SegmentTargetNotFoundError') throw new OwnershipTargetNotFound((err as { reason?: string }).reason ?? (err as Error).message);
                throw err;
            }
            const m = decodeImageInMemory(fs.readFileSync(r.maskPaths[0]));
            if (m.width !== image.width || m.height !== image.height) throw new Error(`the mask is ${m.width}x${m.height}, the photo ${image.width}x${image.height}`);
            const mask = new Uint8Array(m.width * m.height);
            for (let i = 0; i < mask.length; i++) mask[i] = m.rgba[i * 4] >= 128 ? 1 : 0;
            return mask;
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    };
}
