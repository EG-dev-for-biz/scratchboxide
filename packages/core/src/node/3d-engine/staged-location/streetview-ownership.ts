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
import type { RenderMesh3D } from '../../spatial/HeadlessMeshSilhouetteRenderer';
import { encodePng } from './png-encode';
import { decodeImageInMemory } from './tile-texture-transfer';
import { parseStreetReply } from './street-identify';
import { capImageSide } from './ornament-batches';
import { ORNAMENT_THINKING_BUDGET } from './ornament-vision';
import type { VisionModelChain } from '../../gemini/vision-model-chain';

/** Part of the texture cache key: a change to the ownership step is a new version. */
export const OWNERSHIP_VERSION = 6;
/**
 * Agreement between the cut-out and the structure's projection at which the pose is trusted. With geometry prompts (no
 * description) the outline depends on the pose, and below this the view vouches for no pixel; with the description the
 * outline is the segmenter's own and this is only a flag on the pose (ViewOwnershipRecord.poseAgrees).
 */
export const OWNERSHIP_MIN_IOU = 0.3;
/** A described cut-out sharing less than this with the projection is somewhere else entirely: the view is refused. */
export const OWNERSHIP_SANITY_IOU = 0.05;
/** The outline obstructions are looked for in: the described cut-out grown by this share of the view's longer side (an occluder leaves a gap in it). */
export const OCCLUDER_OUTLINE_GROW_SHARE = 0.03;
/** One obstruction instance may cover at most this share of the outline (larger is the building itself or a neighbour). */
export const OCCLUDER_INSTANCE_MAX_SHARE = 0.25;
/** All obstruction instances together may cover at most this share of the outline (the smallest are kept first). */
export const OCCLUDER_UNION_MAX_SHARE = 0.4;
/** An instance counts when at least this share of it lies inside the outline. */
export const OCCLUDER_MIN_INSIDE_SHARE = 0.5;
/** Holes in the described cut-out fully enclosed by it and at most this share of the view are closed (a window it missed). */
export const OUTLINE_HOLE_MAX_SHARE = 0.01;
/** A crossing line runs over at least this share of the outline's extent along it... */
export const LINE_MIN_INSIDE_SHARE = 0.2;
/** ...and continues at least this share of the view's side outside the outline (a facade's own pilasters and cornices stop at its edge). */
export const LINE_MIN_OUTSIDE_SHARE = 0.03;
/** The structure needs this share of the view's pixels for a cut-out to be asked for. */
export const OWNERSHIP_MIN_TARGET_SHARE = 0.01;
/** Pixels the mask is grown by (the segmenter's edge and the texel footprint's own blur). */
export const OWNERSHIP_DILATE_PX = 2;

type NormPoint = [number, number];
type NormBox = [number, number, number, number];

export interface OwnershipPrompts {
    /** 1 where the structure is the nearest surface in the view. */
    target: Uint8Array;
    /** 1 where the structure is in the view but the tile mesh puts something nearer (the depth test's occluders). */
    hidden: Uint8Array;
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

/** Grows a binary mask by `r` pixels (square structuring element, separable; nothing outside the image is set). */
export function dilateMask(mask: Uint8Array, W: number, H: number, r: number): Uint8Array {
    if (r <= 0) return mask.slice();
    const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        let last = -Infinity;
        for (let x = 0; x < W; x++) { if (mask[y * W + x]) last = x; if (x - last <= r) tmp[y * W + x] = 1; }
        last = Infinity;
        for (let x = W - 1; x >= 0; x--) { if (mask[y * W + x]) last = x; if (last - x <= r) tmp[y * W + x] = 1; }
    }
    for (let x = 0; x < W; x++) {
        let last = -Infinity;
        for (let y = 0; y < H; y++) { if (tmp[y * W + x]) last = y; if (y - last <= r) out[y * W + x] = 1; }
        last = Infinity;
        for (let y = H - 1; y >= 0; y--) { if (tmp[y * W + x]) last = y; if (last - y <= r) out[y * W + x] = 1; }
    }
    return out;
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
    const target = new Uint8Array(W * H), other = new Uint8Array(W * H), hidden = new Uint8Array(W * H);
    let n = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let i = 0; i < W * H; i++) {
        const c = contextDepth ? contextDepth[i] : Infinity;
        if (nearest(targetDepth[i], c)) {
            target[i] = 1; n++;
            const x = i % W, y = (i / W) | 0;
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        } else if (Number.isFinite(c) && c < 1e8) {
            other[i] = 1;
            if (Number.isFinite(targetDepth[i]) && targetDepth[i] < 1e8) hidden[i] = 1;
        }
    }
    if (!n) return { target, hidden, targetPixels: 0, box: [0, 0, 1, 1], positive: [], negative: [] };
    const pad = 0.03 * Math.max(W, H);
    const bx0 = Math.max(0, x0 - pad), by0 = Math.max(0, y0 - pad), bx1 = Math.min(W, x1 + 1 + pad), by1 = Math.min(H, y1 + 1 + pad);
    const r = Math.max(2, Math.round(0.03 * Math.min(W, H)));
    let inner = erode(target, W, H, r);
    if (!inner.some(v => v)) inner = erode(target, W, H, 1);
    const otherInner = erode(other, W, H, r);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x < bx0 || x >= bx1 || y < by0 || y >= by1) otherInner[y * W + x] = 0;
    return {
        target, hidden, targetPixels: n, box: [bx0 / W, by0 / H, bx1 / W, by1 / H],
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
export type OwnershipSegmenter = (image: { width: number; height: number; rgba: Uint8Array }, prompts: { box?: NormBox; positive: NormPoint[]; negative: NormPoint[]; target?: string }, signal?: AbortSignal) => Promise<Uint8Array>;

/** The segmenter's vision model did not find the described structure in the photo. */
export class OwnershipTargetNotFound extends Error {
    constructor(readonly reason: string) { super(reason); this.name = 'OwnershipTargetNotFound'; }
}

export interface ViewOwnershipRecord {
    panoId: string;
    /** 'segmented': the mask stands; 'refused': no pixel of the view is vouched for (why in `reason`). */
    status: 'segmented' | 'refused';
    /**
     * How the segmenter was prompted: the description with the geometry's box as a hint, the geometry alone (no description
     * given), or the geometry alone because the view's registered pose holds (`describe` said so: no vision call spent).
     */
    prompts: 'description' | 'geometry' | 'geometry (registered pose)';
    reason?: string;
    targetPixels: number;
    maskPixels: number;
    /** Agreement of the cut-out with where the geometry puts the structure. */
    iou?: number;
    /** Whether that agreement reaches OWNERSHIP_MIN_IOU (the pose puts the structure where the photo shows it). */
    poseAgrees?: boolean;
    /**
     * What stands in front of the structure, taken out of the cut-out: pixels by the depth test (the tile mesh nearer), by
     * the segmenter's occluder cut-out, grown along thin vertical structures, and in all after the dilation (each a count of
     * pixels inside the structure's cut-out). `segmenter` says what the segmenter answered.
     */
    occluders?: { depthPixels: number; segmentedPixels: number; thinPixels?: number; grownPixels: number; removedPixels: number; segmenter: string; instances?: Array<{ label: string; pixels: number; kept: boolean; why?: string }> };
    ms: number;
}

/** The open-vocabulary occluder prompt: whatever stands between the camera and the structure's surface. No class list. */
export function occluderDescription(target: string): string {
    return `anything standing in front of the facade of ${target}, between the camera and the building's own surface`;
}

/**
 * The second, open-vocabulary occluder prompt for what the first one misses: long thin things crossing in front of the facade.
 * A prompt, not a class list: nothing is gated on these words.
 */
export function thinOccluderDescription(target: string): string {
    return `long thin structures crossing in front of the facade of ${target}: poles, overhead signal arms, wires, lamp posts, banner poles, sign posts`;
}

/** The structure's silhouette is grown by this share of the image's longest side before it bounds the occluders (overhanging crowns, arms). */
export const OCCLUDER_SILHOUETTE_GROW_SHARE = 0.012;

/** Pixels the occluder mask is grown by (as a share of the image's longest side): thin poles and railings are a weak case. */
export const OCCLUDER_DILATE_SHARE = 0.005;

/**
 * Thin vertical structures the segmenter caught only part of (a sign on its pole, a lamp's head): from every occluder pixel the
 * mask is grown up and down its column while the photo there is a thin line: luma differing by at least `contrast` in the same
 * direction from both pixels `halfWidthPx` to either side (a pole against the wall behind it). Gaps up to 2 px are crossed.
 */
export function growThinVertical(seed: Uint8Array, image: { width: number; height: number; rgba: Uint8Array }, within: Uint8Array, opts: { halfWidthPx?: number; contrast?: number } = {}): Uint8Array {
    const W = image.width, H = image.height, w = opts.halfWidthPx ?? Math.max(3, Math.round(0.004 * W)), k = opts.contrast ?? 18;
    const L = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) L[i] = 0.299 * image.rgba[i * 4] + 0.587 * image.rgba[i * 4 + 1] + 0.114 * image.rgba[i * 4 + 2];
    const line = (x: number, y: number): boolean => {
        if (x - w < 0 || x + w >= W) return false;
        const c = L[y * W + x], a = L[y * W + x - w], b = L[y * W + x + w];
        return (c - a > k && c - b > k) || (a - c > k && b - c > k);
    };
    const out = seed.slice();
    for (let x = 0; x < W; x++) {
        for (const dir of [1, -1]) {
            let gap = 0, growing = false;
            for (let y = dir > 0 ? 0 : H - 1; y >= 0 && y < H; y += dir) {
                const i = y * W + x;
                if (seed[i]) { growing = true; gap = 0; continue; }
                if (!growing) continue;
                if (within[i] && line(x, y)) { out[i] = 1; gap = 0; } else if (++gap > 2) growing = false;
            }
        }
    }
    return out;
}

/**
 * The horizontal twin of growThinVertical: a mast arm or a wire the segmenter caught part of is grown left and right along
 * its row while the photo there is a thin line (luma contrast against the pixels `halfWidthPx` above and below).
 */
export function growThinHorizontal(seed: Uint8Array, image: { width: number; height: number; rgba: Uint8Array }, within: Uint8Array, opts: { halfWidthPx?: number; contrast?: number } = {}): Uint8Array {
    const W = image.width, H = image.height, w = opts.halfWidthPx ?? Math.max(3, Math.round(0.004 * H)), k = opts.contrast ?? 18;
    const L = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) L[i] = 0.299 * image.rgba[i * 4] + 0.587 * image.rgba[i * 4 + 1] + 0.114 * image.rgba[i * 4 + 2];
    const line = (x: number, y: number): boolean => {
        if (y - w < 0 || y + w >= H) return false;
        const c = L[y * W + x], a = L[(y - w) * W + x], b = L[(y + w) * W + x];
        return (c - a > k && c - b > k) || (a - c > k && b - c > k);
    };
    const out = seed.slice();
    for (let y = 0; y < H; y++) {
        for (const dir of [1, -1]) {
            let gap = 0, growing = false;
            for (let x = dir > 0 ? 0 : W - 1; x >= 0 && x < W; x += dir) {
                const i = y * W + x;
                if (seed[i]) { growing = true; gap = 0; continue; }
                if (!growing) continue;
                if (within[i] && line(x, y)) { out[i] = 1; gap = 0; } else if (++gap > 2) growing = false;
            }
        }
    }
    return out;
}

/** The structure's whole projected silhouette in a view (where it is nearest or hidden behind something), grown a little. */
export function structureSilhouette(p: Pick<OwnershipPrompts, 'target' | 'hidden'>, W: number, H: number): Uint8Array {
    const s = new Uint8Array(W * H);
    for (let i = 0; i < s.length; i++) if (p.target[i] || p.hidden[i]) s[i] = 1;
    return dilateMask(s, W, H, Math.max(2, Math.round(OCCLUDER_SILHOUETTE_GROW_SHARE * Math.max(W, H))));
}

/**
 * The described cut-out with its small holes closed: a morphological close (a few pixels), then every hole fully enclosed
 * by the cut-out and at most OUTLINE_HOLE_MAX_SHARE of the view filled (a window or shadow the segmenter left out).
 */
export function closeOutline(raw: Uint8Array, W: number, H: number): Uint8Array {
    const r = Math.max(1, Math.round(0.004 * Math.max(W, H)));
    const closed = erode(dilateMask(raw, W, H, r), W, H, r);
    for (let i = 0; i < closed.length; i++) if (raw[i]) closed[i] = 1;
    const seen = new Uint8Array(W * H), stack: number[] = [], comp: number[] = [], max = OUTLINE_HOLE_MAX_SHARE * W * H;
    for (let s0 = 0; s0 < W * H; s0++) {
        if (closed[s0] || seen[s0]) continue;
        let border = false; comp.length = 0; stack.push(s0); seen[s0] = 1;
        while (stack.length) {
            const i = stack.pop()!, x = i % W, y = (i / W) | 0;
            comp.push(i);
            if (x === 0 || y === 0 || x === W - 1 || y === H - 1) border = true;
            for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) if (j >= 0 && !closed[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
        }
        if (!border && comp.length <= max) for (const i of comp) closed[i] = 1;
    }
    return closed;
}

/**
 * Long thin dark lines crossing the structure's outline (poles, mast arms, wires), by columns and rows: a run of pixels
 * darker than both sides `halfWidthPx` away that covers LINE_MIN_INSIDE_SHARE of the outline's extent along it AND
 * continues LINE_MIN_OUTSIDE_SHARE of the view's side outside the outline. The structure's own pilasters, mullions and
 * cornices stop at its edge, so they are not taken. Returns the runs' pixels inside the outline.
 */
export function crossingLines(image: { width: number; height: number; rgba: Uint8Array }, outline: Uint8Array, opts: { halfWidthPx?: number; contrast?: number } = {}): Uint8Array {
    const W = image.width, H = image.height, w = opts.halfWidthPx ?? Math.max(3, Math.round(0.004 * Math.max(W, H))), k = opts.contrast ?? 18;
    const L = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) L[i] = 0.299 * image.rgba[i * 4] + 0.587 * image.rgba[i * 4 + 1] + 0.114 * image.rgba[i * 4 + 2];
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let i = 0; i < W * H; i++) if (outline[i]) { const x = i % W, y = (i / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const out = new Uint8Array(W * H);
    if (x1 < 0) return out;
    // one scan direction: `n` lines of `len` pixels; at(line, t) is the pixel index, dark(line, t) the thin-line test across it
    const scan = (n: number, len: number, at: (l: number, t: number) => number, dark: (l: number, t: number) => boolean, extent: number) => {
        for (let l = 0; l < n; l++) {
            let t = 0;
            while (t < len) {
                if (!dark(l, t)) { t++; continue; }
                const run: number[] = [];
                let gap = 0, u = t;
                for (; u < len && gap <= 2; u++) { if (dark(l, u)) { run.push(at(l, u)); gap = 0; } else gap++; }
                let inside = 0, outside = 0;
                for (const i of run) { if (outline[i]) inside++; else outside++; }
                if (inside >= LINE_MIN_INSIDE_SHARE * extent && outside >= LINE_MIN_OUTSIDE_SHARE * len) for (const i of run) if (outline[i]) out[i] = 1;
                t = u;
            }
        }
    };
    scan(W, H, (x, y) => y * W + x, (x, y) => x - w >= 0 && x + w < W && L[y * W + x] < L[y * W + x - w] - k && L[y * W + x] < L[y * W + x + w] - k, y1 - y0 + 1);
    scan(H, W, (y, x) => y * W + x, (y, x) => y - w >= 0 && y + w < H && L[y * W + x] < L[(y - w) * W + x] - k && L[y * W + x] < L[(y + w) * W + x] - k, x1 - x0 + 1);
    return out;
}

/** One obstruction a vision model listed in a photo: what it is, and its box, normalised [x0, y0, x1, y1]. */
export interface ObstructionBox { label: string; box: NormBox }
/** Lists what stands in front of the structure in a photo (one box per thing). */
export type ObstructionLister = (image: { width: number; height: number; rgba: Uint8Array }, target: string, signal?: AbortSignal) => Promise<ObstructionBox[]>;

/** The vision question behind visionObstructionLister: every separate thing in front of the structure's facade, one box each (street-identify's box_2d pattern). */
export function obstructionPrompt(target: string): string {
    return [
        `This is a street photo of ${target}. List every separate thing that stands between the camera and the facade of ${target} and hides part of it:`,
        'poles and what they carry, traffic signal heads and their arms, signs, banners, lamps, wires, trees and other plants, vehicles, people, scaffolding, kiosks, or anything else standing in front of it.',
        'Leave out the building itself, its own windows, cornices, fire escapes and shopfronts, and the buildings beside it.',
        'For each thing give "label" (what it is, in a few plain words) and "box_2d": [ymin, xmin, ymax, xmax] on a 0-1000 scale, the whole thing (a pole from its foot to its top, with what it carries).',
        'List each thing once, the nearest first, at most 30.',
        'Reply with JSON only: {"objects": [ ... ]}'
    ].join('\n');
}

/** The reply's boxes (street-identify's parser), as normalised [x0, y0, x1, y1]. */
export function parseObstructionReply(text: string): ObstructionBox[] {
    return parseStreetReply(text).map(r => ({ label: r.label, box: [r.box[1] / 1000, r.box[0] / 1000, r.box[3] / 1000, r.box[2] / 1000] as NormBox }));
}

/** An ObstructionLister on a vision model chain (one call per photo). */
export function visionObstructionLister(chain: VisionModelChain<string>): ObstructionLister {
    return async (image, target, signal) => {
        const rgb = new Uint8Array(image.width * image.height * 3);
        for (let i = 0; i < image.width * image.height; i++) { rgb[i * 3] = image.rgba[i * 4]; rgb[i * 3 + 1] = image.rgba[i * 4 + 1]; rgb[i * 3 + 2] = image.rgba[i * 4 + 2]; }
        const sent = await capImageSide(Buffer.from(encodePng(image.width, image.height, rgb, 3)), 'image/png', image.width, image.height, 1280);
        const r = await chain.generate({
            contents: [{ role: 'user', parts: [{ inlineData: { mimeType: sent.mimeType, data: sent.bytes.toString('base64') } }, { text: obstructionPrompt(target) }] }],
            config: { responseMimeType: 'application/json', temperature: 0, ...(signal ? { abortSignal: signal } : {}) }
        }, { stage: 'obstructions', thinkingBudget: ORNAMENT_THINKING_BUDGET });
        const text = (r.response.candidates?.[0]?.content?.parts ?? []).filter(p => !(p as { thought?: boolean }).thought).map(p => p.text ?? '').join('');
        const boxes = parseObstructionReply(text);
        r.remember();
        return boxes;
    };
}

/**
 * What stands in front of the structure in a photo, kept only inside `within` (the structure's outline) and grown along
 * thin vertical and horizontal lines. With `list`: a vision model lists each obstruction with a box, the segmenter cuts
 * each out from its box, and an instance is kept when it lies mostly inside the outline and is small beside it (each
 * instance, and all of them together, capped against `outlinePixels`). Without: the open-vocabulary "anything in front"
 * and thin-structure cut-outs. Used by ownViews and to check a cleaned photo (nothing may be left standing in what was filled).
 */
export async function detectOccluders(image: { width: number; height: number; rgba: Uint8Array }, segment: OwnershipSegmenter, target: string, box: NormBox | undefined, within: Uint8Array, signal?: AbortSignal, opts: { list?: ObstructionLister; outlinePixels?: number } = {}): Promise<{ mask: Uint8Array; segmentedPixels: number; thinPixels: number; grownPixels: number; notes: string[]; instances?: Array<{ label: string; pixels: number; kept: boolean; why?: string }> }> {
    const W = image.width, H = image.height, mask = new Uint8Array(W * H), notes: string[] = [];
    let segmentedPixels = 0, thinPixels = 0, grownPixels = 0;
    let instances: Array<{ label: string; pixels: number; kept: boolean; why?: string }> | undefined;
    if (opts.list) {
        let outline = opts.outlinePixels ?? 0;
        if (!outline) for (let i = 0; i < within.length; i++) outline += within[i];
        let boxes: ObstructionBox[] = [];
        try { boxes = await opts.list(image, target, signal); notes.push(`listed ${boxes.length} obstruction(s)`); } catch (err) {
            if (signal?.aborted) throw err;
            notes.push(`the obstruction list failed (${err instanceof Error ? err.message : String(err)})`);
        }
        const cut: Array<{ label: string; m: Uint8Array; inside: number; pixels: number }> = [];
        instances = [];
        for (const b of boxes) {
            try {
                const o = await segment(image, { box: b.box, positive: [], negative: [] }, signal);
                if (o.length !== W * H) throw new Error(`the segmenter returned ${o.length} pixels for a ${W}x${H} view`);
                let pixels = 0, inside = 0;
                for (let i = 0; i < o.length; i++) if (o[i]) { pixels++; if (within[i]) inside++; }
                if (!pixels || inside < OCCLUDER_MIN_INSIDE_SHARE * pixels) { instances.push({ label: b.label, pixels: inside, kept: false, why: 'mostly outside the structure' }); continue; }
                if (inside > OCCLUDER_INSTANCE_MAX_SHARE * outline) { instances.push({ label: b.label, pixels: inside, kept: false, why: `covers ${(100 * inside / outline).toFixed(0)} percent of the structure` }); continue; }
                cut.push({ label: b.label, m: o, inside, pixels });
            } catch (err) {
                if (signal?.aborted) throw err;
                instances.push({ label: b.label, pixels: 0, kept: false, why: `the segmenter failed (${err instanceof Error ? err.message : String(err)})` });
            }
        }
        // the smallest first, while the union stays under its cap
        cut.sort((a, b) => a.inside - b.inside);
        for (const c of cut) {
            let add = 0;
            for (let i = 0; i < c.m.length; i++) if (c.m[i] && within[i] && !mask[i]) add++;
            if (segmentedPixels + add > OCCLUDER_UNION_MAX_SHARE * outline) { instances.push({ label: c.label, pixels: c.inside, kept: false, why: 'over the cap for all obstructions together' }); continue; }
            for (let i = 0; i < c.m.length; i++) if (c.m[i] && within[i]) mask[i] = 1;
            segmentedPixels += add;
            instances.push({ label: c.label, pixels: c.inside, kept: true });
        }
        // long thin lines crossing the outline that no box caught (mast arms, wires, poles), under the same union cap
        const lines = crossingLines(image, within);
        let add = 0;
        for (let i = 0; i < lines.length; i++) if (lines[i] && !mask[i]) add++;
        if (add && segmentedPixels + thinPixels + add <= OCCLUDER_UNION_MAX_SHARE * outline) {
            for (let i = 0; i < lines.length; i++) if (lines[i]) mask[i] = 1;
            thinPixels += add;
            notes.push(`${add} px of thin lines crossing the outline`);
        } else if (add) notes.push(`${add} px of thin lines crossing the outline not taken (over the cap for all obstructions together)`);
    } else {
        for (const [desc, which] of [[occluderDescription(target), 'front'], [thinOccluderDescription(target), 'thin']] as const) {
            try {
                const o = await segment(image, { ...(box ? { box } : {}), positive: [], negative: [], target: desc }, signal);
                if (o.length !== W * H) throw new Error(`the segmenter returned ${o.length} pixels for a ${W}x${H} view`);
                for (let i = 0; i < o.length; i++) if (o[i] && within[i] && !mask[i]) { mask[i] = 1; if (which === 'front') segmentedPixels++; else thinPixels++; }
                notes.push(`${which}: cut out`);
            } catch (err) {
                if (signal?.aborted) throw err;
                notes.push(`${which}: ${err instanceof OwnershipTargetNotFound ? `nothing found (${err.reason.slice(0, 120)})` : `failed (${err instanceof Error ? err.message : String(err)})`}`);
            }
        }
    }
    const gv = growThinVertical(mask, image, within), gh = growThinHorizontal(gv, image, within);
    for (let i = 0; i < mask.length; i++) if (gh[i] && !mask[i]) { mask[i] = 1; grownPixels++; }
    return { mask, segmentedPixels, thinPixels, grownPixels, notes, ...(instances ? { instances } : {}) };
}

/** The check streetview-clean.ts runs after a fill: detectOccluders on the cleaned copy, inside the filled pixels (grown a little). */
export function occluderVerifier(segment: OwnershipSegmenter, target: string, signal?: AbortSignal, list?: ObstructionLister) {
    return async (cleaned: { width: number; height: number; rgba: Uint8Array }, filled: Uint8Array): Promise<Uint8Array> => {
        const W = cleaned.width, H = cleaned.height;
        let x0 = W, y0 = H, x1 = -1, y1 = -1;
        for (let i = 0; i < filled.length; i++) if (filled[i]) { const x = i % W, y = (i / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        if (x1 < 0) return new Uint8Array(W * H);
        const within = dilateMask(filled, W, H, 2);
        return (await detectOccluders(cleaned, segment, target, [x0 / W, y0 / H, (x1 + 1) / W, (y1 + 1) / H], within, signal, list ? { list } : {})).mask;
    };
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
    /**
     * Per view, whether the structure's cut-out is prompted with the description (a vision call that places the points and
     * refuses a photo that does not show the structure) or from the geometry alone. Default: the description whenever there
     * is one. A view whose pose was registered against the tile mesh to a few decimetres needs no vision call: the geometry
     * says where the structure is, and the cut-out's agreement with it (OWNERSHIP_MIN_IOU) still judges the photo. The
     * occluder cut-out keeps the description either way.
     */
    describe?: (view: ProjectionView, index: number) => boolean;
    /** Writes one overlay PNG per view here (diagnostics): the photo dimmed outside the cut-out, the projection's edge in red. */
    debugDir?: string;
    /**
     * Called for each view the cut-out stands for, with its final mask (`owner`, the view's ownerMask) and what was taken out
     * of it as standing in front of the structure (`occluders`, dilated), both 1 per pixel at the image's size. Read only.
     */
    onMasks?: (index: number, masks: { owner: Uint8Array; occluders: Uint8Array }) => void;
    /** Lists the obstructions in a photo (a vision model): the occluders are then cut out one instance per box. Absent: the open-vocabulary cut-outs. */
    listObstructions?: ObstructionLister;
}): Promise<{ views: ProjectionView[]; records: ViewOwnershipRecord[] }> {
    const out: ProjectionView[] = input.views.slice();
    const records: ViewOwnershipRecord[] = new Array(input.views.length);
    let next = 0, done = 0;
    const work = async () => {
        for (let k; (k = next++) < input.views.length;) {
            const v = input.views[k];
            const t0 = Date.now();
            const W = v.camera.width, H = v.camera.height;
            const described = !!input.target && (input.describe ? input.describe(v, k) : true);
            const prompts: ViewOwnershipRecord['prompts'] = described ? 'description' : input.target ? 'geometry (registered pose)' : 'geometry';
            const refuse = (reason: string, targetPixels: number, extra: Partial<ViewOwnershipRecord> = {}) => {
                out[k] = { ...v, ownerMask: new Uint8Array(W * H) };
                records[k] = { panoId: v.panoId, status: 'refused', prompts, reason, targetPixels, maskPixels: 0, ms: Date.now() - t0, ...extra };
            };
            try {
                if (input.signal?.aborted) throw input.signal.reason ?? new Error('stopped');
                const p = ownershipPrompts(renderFrameDepth(input.structure, v.camera), input.context ? renderFrameDepth(input.context, v.camera) : undefined, W, H);
                if (p.targetPixels < OWNERSHIP_MIN_TARGET_SHARE * W * H || !p.positive.length) {
                    refuse(`the structure covers ${(100 * p.targetPixels / (W * H)).toFixed(1)} percent of the view, too little to cut out`, p.targetPixels);
                    continue;
                }
                // with the description the outline is the segmenter's own, found pose-free (the vision model locates the structure
                // in the photo with no hint from the geometry, which a weak pose puts on a neighbour); the projection only checks it
                let raw: Uint8Array;
                try {
                    raw = await input.segment(v.image, described ? { positive: [], negative: [], target: input.target } : { box: p.box, positive: p.positive, negative: p.negative }, input.signal);
                } catch (err) {
                    if (!(err instanceof OwnershipTargetNotFound)) throw err;
                    refuse(`the structure is not in this photo (${err.reason})`, p.targetPixels);
                    continue;
                }
                if (raw.length !== W * H) throw new Error(`the segmenter returned ${raw.length} pixels for a ${W}x${H} view`);
                const iou = maskIou(raw, p.target);
                if (input.debugDir) writeOverlay(path.join(input.debugDir, `${String(k).padStart(2, '0')}_${v.panoId}_iou${Math.round(iou * 100)}.png`), v.image, raw, p);
                if (iou < (described ? OWNERSHIP_SANITY_IOU : OWNERSHIP_MIN_IOU)) {
                    refuse(`the cut-out agrees with the structure's projection on ${(100 * iou).toFixed(0)} percent (intersection over union, at least ${100 * (described ? OWNERSHIP_SANITY_IOU : OWNERSHIP_MIN_IOU)} needed): the photo there shows something else, or the pose is far off`, p.targetPixels, { iou: Math.round(iou * 1000) / 1000 });
                    continue;
                }
                // a described cut-out is the outline itself: its small enclosed holes (a window it left out) are closed
                if (described) raw = closeOutline(raw, W, H);
                const mask = dilateMask(raw, W, H, OWNERSHIP_DILATE_PX);
                // what stands in front of the structure: an occluder is something BETWEEN the camera and the structure's own surface,
                // so only pixels inside the structure's outline count, and a neighbour beside it is never one. The outline is the
                // described cut-out grown a little (an occluder leaves a gap in it), or, with geometry prompts, the projected
                // silhouette. Within it, the segmenter's obstruction instances (or its open-vocabulary cut-outs), grown along thin
                // lines. Depth alone never makes an occluder; depthPixels counts the occluders the depth test agrees are in front.
                const sil = described ? dilateMask(raw, W, H, Math.max(2, Math.round(OCCLUDER_OUTLINE_GROW_SHARE * Math.max(W, H)))) : structureSilhouette(p, W, H);
                const occ = new Uint8Array(W * H);
                let depthPx = 0, segPx = 0, grownPx = 0, removed = 0, thinPx = 0, outlinePx = 0;
                for (let i = 0; i < sil.length; i++) outlinePx += sil[i];
                let segNote = 'not asked (no description of the structure)';
                let instances: NonNullable<ViewOwnershipRecord['occluders']>['instances'];
                if (input.target) {
                    const d = await detectOccluders(v.image, input.segment, input.target, described ? undefined : p.box, sil, input.signal, { ...(input.listObstructions ? { list: input.listObstructions } : {}), outlinePixels: outlinePx });
                    for (let i = 0; i < occ.length; i++) if (d.mask[i]) { occ[i] = 1; if (mask[i]) segPx++; if (p.hidden[i]) depthPx++; }
                    thinPx = d.thinPixels; grownPx = d.grownPixels; instances = d.instances;
                    segNote = d.notes.join('; ');
                }
                const occD = dilateMask(occ, W, H, Math.max(2, Math.round(OCCLUDER_DILATE_SHARE * Math.max(W, H))));
                for (let i = 0; i < occD.length; i++) if (!sil[i]) occD[i] = 0;
                let m = 0;
                for (let i = 0; i < mask.length; i++) { if (mask[i] && occD[i]) { mask[i] = 0; removed++; } m += mask[i]; }
                if (input.debugDir) writeOverlay(path.join(input.debugDir, `${String(k).padStart(2, '0')}_${v.panoId}_owned.png`), v.image, mask, p, occD);
                out[k] = { ...v, ownerMask: mask };
                input.onMasks?.(k, { owner: mask, occluders: occD });
                records[k] = { panoId: v.panoId, status: 'segmented', prompts, targetPixels: p.targetPixels, maskPixels: m, iou: Math.round(iou * 1000) / 1000, poseAgrees: iou >= OWNERSHIP_MIN_IOU,
                    occluders: { depthPixels: depthPx, segmentedPixels: segPx, thinPixels: thinPx, grownPixels: grownPx, removedPixels: removed, segmenter: segNote, ...(instances ? { instances } : {}) }, ms: Date.now() - t0 };
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
function writeOverlay(file: string, image: { width: number; height: number; rgba: Uint8Array }, mask: Uint8Array, p: OwnershipPrompts, occluders?: Uint8Array): void {
    const W = image.width, H = image.height, rgb = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = mask[i] ? image.rgba[i * 4 + c] : image.rgba[i * 4 + c] >> 2;
    // occluders taken out of the cut-out: tinted orange
    if (occluders) for (let i = 0; i < W * H; i++) if (occluders[i] && !mask[i]) { rgb[i * 3] = Math.min(255, 120 + (image.rgba[i * 4] >> 1)); rgb[i * 3 + 1] = 60 + (image.rgba[i * 4 + 1] >> 2); rgb[i * 3 + 2] = image.rgba[i * 4 + 2] >> 3; }
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
            svc = new ObjectSegmenterService({ ...(options.pythonBinary ? { pythonBinary: options.pythonBinary } : {}), ...(options.modelSource ? { modelSource: options.modelSource } : {}) });
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
