/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Reprojection accept gate for photo-read detail.
 *
 * A vision model reads an element from a Street View image and cites where it saw it (a box in that image); the element is
 * then built in its host chart. Built, it can be checked against what was cited: its mesh is rendered through the registered
 * camera of every Street View image it cites (behind the structure where the structure hides it), and the box of what shows
 * is compared with the cited box by IoU and Dice (as in reprojection-consistency checks of single-view reconstruction). An
 * element whose built form lands somewhere else in every image it cites was not where the model said it saw it: it is
 * invented or misplaced, and it is rejected with that reason. An element cited only in tile orthos is not gated (no camera).
 */

import type { Box1000, OrnamentElement } from '../../../common/spatial/staged-location-contracts';
import type { RenderMesh3D } from '../../spatial/HeadlessMeshSilhouetteRenderer';
import { renderFrameDepth, type FrameCamera } from '../../spatial/StreetViewPoseRegistrar';
import type { GlbNode } from './glb-nodes';

/**
 * An element is kept when its best cited image's IoU reaches this. Calibrated on the live arch (round 4, staged location
 * findings doc): the elements that match features of the real arch sit well above it; the invented ones below.
 */
export const DETAIL_REPROJECTION_MIN_IOU = 0.15;
/** Width the elements are rendered at (the boxes are read to about 1 % of the frame). */
const RENDER_WIDTH_PX = 320;
const EMPTY = 1e8;

export interface ElementViewReprojection {
    imageId: string;
    cited: Box1000;
    /** Box of the built element as it shows in the image (0..1000, [y0, x0, y1, x1]), absent when none of it shows. */
    rendered?: Box1000;
    /** IoU and Dice of `rendered` with `cited`. */
    iou: number;
    dice: number;
}

export interface ElementReprojection {
    elementId: string;
    slotId: string;
    label?: string;
    views: ElementViewReprojection[];
    /** The best IoU over the cited Street View images; null when the element cites none with a camera. */
    iou: number | null;
    dice: number | null;
    accepted: boolean;
    reason: string;
}

/** A camera reduced to `width` pixels (same field of view). */
function scaled(cam: FrameCamera, width: number): FrameCamera {
    const s = width / cam.width;
    if (s >= 1) return cam;
    return { ...cam, fx: cam.fx * s, fy: cam.fy * s, cx: cam.cx * s, cy: cam.cy * s, width: Math.round(cam.width * s), height: Math.max(1, Math.round(cam.height * s)) };
}

function boxIoU(a: Box1000, b: Box1000): number {
    const iy = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), ix = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const inter = ix * iy;
    const area = (q: Box1000) => Math.max(0, q[2] - q[0]) * Math.max(0, q[3] - q[1]);
    const uni = area(a) + area(b) - inter;
    return uni > 0 ? inter / uni : 0;
}

function meshOf(node: GlbNode): RenderMesh3D {
    const n = node.positions.length / 3;
    return { vertices: node.positions, indices: node.indices ?? Uint32Array.from({ length: n - (n % 3) }, (_, i) => i) };
}

/** The box (0..1000) of what of `mesh` shows through `cam`, hidden where `scene` is nearer by more than 0.3 m. */
export function renderedBox(mesh: RenderMesh3D, cam: FrameCamera, sceneDepth?: Float32Array): Box1000 | undefined {
    const d = renderFrameDepth(mesh, cam);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let y = 0; y < cam.height; y++) for (let x = 0; x < cam.width; x++) {
        const i = y * cam.width + x, z = d[i];
        if (!(z < EMPTY)) continue;
        if (sceneDepth && sceneDepth[i] < EMPTY && sceneDepth[i] < z - 0.3) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!Number.isFinite(x0)) return undefined;
    const r = (v: number, n: number) => Math.round((v / n) * 1000);
    return [r(y0, cam.height), r(x0, cam.width), r(y1 + 1, cam.height), r(x1 + 1, cam.width)];
}

/**
 * Renders each built element through the cameras of the images it cites and compares with the cited boxes. `cameraFor`
 * gives the registered camera of a Street View image id (undefined for a tile ortho or an image not in hand); `occluder`
 * (the fitted structure) hides the parts of an element the structure stands in front of.
 */
export function reprojectDetail(nodes: GlbNode[], elements: OrnamentElement[], cameraFor: (imageId: string) => FrameCamera | undefined,
    opts: { occluder?: RenderMesh3D; minIoU?: number; widthPx?: number } = {}): ElementReprojection[] {
    const minIoU = opts.minIoU ?? DETAIL_REPROJECTION_MIN_IOU;
    const width = opts.widthPx ?? RENDER_WIDTH_PX;
    const byName = new Map(nodes.map(n => [n.name, n]));
    const sceneCache = new Map<string, Float32Array>();
    const rendered = new Map<string, Array<{ imageId: string; cited: Box1000; rendered?: Box1000 }>>();
    for (const e of elements) {
        const node = byName.get(e.id);
        if (!node || !(node.positions.length >= 9)) continue;
        const mesh = meshOf(node);
        const list: Array<{ imageId: string; cited: Box1000; rendered?: Box1000 }> = [];
        for (const ev of e.evidence) {
            const full = cameraFor(ev.imageId);
            if (!full) continue;
            const cam = scaled(full, width);
            let scene: Float32Array | undefined;
            if (opts.occluder) {
                scene = sceneCache.get(ev.imageId);
                if (!scene) { scene = renderFrameDepth(opts.occluder, cam); sceneCache.set(ev.imageId, scene); }
            }
            const r = renderedBox(mesh, cam, scene);
            list.push({ imageId: ev.imageId, cited: ev.box1000, ...(r ? { rendered: r } : {}) });
        }
        rendered.set(e.id, list);
    }
    const out: ElementReprojection[] = [];
    for (const e of elements) {
        const base = { elementId: e.id, slotId: e.slotId, ...(e.label ? { label: e.label } : {}) };
        const list = rendered.get(e.id);
        if (!list) {
            out.push({ ...base, views: [], iou: null, dice: null, accepted: true, reason: 'not built, so there is nothing to check' });
            continue;
        }
        const views: ElementViewReprojection[] = list.map(v => {
            const iou = v.rendered ? boxIoU(v.rendered, v.cited) : 0;
            return { imageId: v.imageId, cited: v.cited, ...(v.rendered ? { rendered: v.rendered } : {}), iou: Math.round(iou * 1000) / 1000, dice: Math.round(((2 * iou) / (1 + iou)) * 1000) / 1000 };
        });
        if (!views.length) {
            out.push({ ...base, views, iou: null, dice: null, accepted: true, reason: 'cites no Street View image with a registered camera (tile orthos only), so it is not gated' });
            continue;
        }
        const best = views.reduce((a, b) => (b.iou > a.iou ? b : a));
        const accepted = best.iou >= minIoU;
        const reason = accepted
            ? `built where it was read: IoU ${best.iou.toFixed(2)} with the box cited in ${best.imageId}`
            : best.rendered
                ? `built away from where it was read: at best IoU ${best.iou.toFixed(2)} (below ${minIoU}) between the built element as it shows in ${best.imageId} and the box the model cited there`
                : `none of the built element shows in the ${views.length} image${views.length === 1 ? '' : 's'} it was read from`;
        out.push({ ...base, views, iou: best.iou, dice: best.dice, accepted, reason });
    }
    return out;
}
