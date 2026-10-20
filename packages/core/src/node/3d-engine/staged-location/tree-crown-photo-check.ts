/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Checks the planted trees' crowns against Street View photos, and turns what the photos show into a crown correction.
 *
 * A tree's crown here is the ellipsoid the trees writer fits to its delivered leaves (GLB extras `sbTree.crown`). From a
 * registered photo camera, the ellipsoid is projected into the image (its outline and box), and the real crown's box (read
 * from the photo) is lifted back onto the vertical plane through the tree's stem that faces the camera. Both are then
 * measured there in metres: width, height, the crown base and the crown top above the ground the trunk stands on. The
 * ratios do not depend on the distance (both boxes stand at the same depth), the heights do, so a pose error moves the
 * heights a little and the ratios hardly at all.
 *
 * The correction (`scratchbox.crown-correction/1`) scales each crown horizontally about its centre by the width ratio and
 * moves its base to the base the photo shows; the top stays as the tiles measured it. A tree seen in a photo takes its own
 * reading; every other tree takes the district median. It is labelled `photo-inferred`.
 */

import type { FrameCamera } from '../../spatial/StreetViewPoseRegistrar';
import { projectToFrame } from '../../spatial/StreetViewPoseRegistrar';

export type V3 = [number, number, number];

/** sbTree.crown: centre, radii (radii[0] along the horizontal axis at yawRad from +x toward +z, radii[1] up, radii[2] the other). */
export interface CrownEllipsoid {
    centre: V3;
    radii: V3;
    yawRad: number;
}

export interface CheckedTree {
    id: number;
    crown: CrownEllipsoid;
    /** The stem's x, z in the tile frame. */
    stem: [number, number];
    /** The ground the trunk stands on (crowns.json supportY). */
    groundY: number;
}

export interface ImageBox { x0: number; y0: number; x1: number; y1: number }

/** Points on the ellipsoid's surface (tile frame), `nu` around × `nv` from bottom to top. */
export function ellipsoidSurface(c: CrownEllipsoid, nu = 48, nv = 24): V3[] {
    const cy = Math.cos(c.yawRad), sy = Math.sin(c.yawRad);
    const out: V3[] = [];
    for (let j = 0; j <= nv; j++) {
        const v = -Math.PI / 2 + (Math.PI * j) / nv;
        const cv = Math.cos(v), svv = Math.sin(v);
        for (let i = 0; i < nu; i++) {
            const u = (2 * Math.PI * i) / nu;
            const a = c.radii[0] * cv * Math.cos(u), b = c.radii[2] * cv * Math.sin(u);
            out.push([c.centre[0] + a * cy - b * sy, c.centre[1] + c.radii[1] * svv, c.centre[2] + a * sy + b * cy]);
        }
    }
    return out;
}

/** The projected ellipsoid's box in the image (pixels, unclipped), or null when any of it lies behind the camera. */
export function ellipsoidImageBox(cam: FrameCamera, c: CrownEllipsoid): ImageBox | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of ellipsoidSurface(c)) {
        const q = projectToFrame(cam, p);
        if (!q) return null;
        x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
    }
    return { x0, y0, x1, y1 };
}

/** The projected ellipsoid as a filled mask (w × h, 1 inside): the convex hull of its projected surface points, scanline-filled. */
export function ellipsoidImageMask(cam: FrameCamera, c: CrownEllipsoid): Uint8Array {
    const mask = new Uint8Array(cam.width * cam.height);
    const pts: Array<[number, number]> = [];
    for (const p of ellipsoidSurface(c, 64, 32)) {
        const q = projectToFrame(cam, p);
        if (q) pts.push([q[0], q[1]]);
    }
    const hull = convexHull(pts);
    if (hull.length < 3) return mask;
    for (let y = 0; y < cam.height; y++) {
        const yc = y + 0.5;
        let lo = Infinity, hi = -Infinity;
        for (let k = 0; k < hull.length; k++) {
            const [ax, ay] = hull[k], [bx, by] = hull[(k + 1) % hull.length];
            if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) {
                const x = ax + ((yc - ay) / (by - ay)) * (bx - ax);
                lo = Math.min(lo, x); hi = Math.max(hi, x);
            }
        }
        if (!(hi > lo)) continue;
        const a = Math.max(0, Math.ceil(lo - 0.5)), b = Math.min(cam.width - 1, Math.floor(hi - 0.5));
        for (let x = a; x <= b; x++) mask[y * cam.width + x] = 1;
    }
    return mask;
}

export function convexHull(points: Array<[number, number]>): Array<[number, number]> {
    const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower: Array<[number, number]> = [], upper: Array<[number, number]> = [];
    for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
    upper.pop(); lower.pop();
    return lower.concat(upper);
}

/**
 * The vertical plane through the stem that faces the camera: a pixel's ray meets it at a point, measured as
 * (along: metres to the right of the stem as the camera sees it, y: height in the tile frame).
 */
export function liftToStemPlane(cam: FrameCamera, stem: [number, number], px: number, py: number): { along: number; y: number } | null {
    const xc = (px - cam.cx) / cam.fx, yc = -(py - cam.cy) / cam.fy;
    const d: V3 = [
        cam.fwd[0] + cam.right[0] * xc + cam.up[0] * yc,
        cam.fwd[1] + cam.right[1] * xc + cam.up[1] * yc,
        cam.fwd[2] + cam.right[2] * xc + cam.up[2] * yc
    ];
    // the plane's normal: the horizontal direction from the eye to the stem
    let nx = stem[0] - cam.eye[0], nz = stem[1] - cam.eye[2];
    const nl = Math.hypot(nx, nz);
    if (nl < 1e-6) return null;
    nx /= nl; nz /= nl;
    const den = d[0] * nx + d[2] * nz;
    if (den <= 1e-6) return null;
    const t = nl / den;
    const hx = cam.eye[0] + d[0] * t - stem[0], hz = cam.eye[2] + d[2] * t - stem[1];
    // to the right of the stem as seen from the eye: the normal turned clockwise (x east, z south)
    return { along: hx * -nz + hz * nx, y: cam.eye[1] + d[1] * t };
}

/** A box lifted onto the stem plane: left, right, base and top, metres (heights in the tile frame). */
export function liftBox(cam: FrameCamera, stem: [number, number], box: ImageBox): { left: number; right: number; baseY: number; topY: number } | null {
    const mx = 0.5 * (box.x0 + box.x1), my = 0.5 * (box.y0 + box.y1);
    const l = liftToStemPlane(cam, stem, box.x0, my), r = liftToStemPlane(cam, stem, box.x1, my);
    const b = liftToStemPlane(cam, stem, mx, box.y1), t = liftToStemPlane(cam, stem, mx, box.y0);
    if (!l || !r || !b || !t) return null;
    return { left: l.along, right: r.along, baseY: b.y, topY: t.y };
}

export interface CrownPhotoReading {
    treeId: number;
    /** Real crown width / model crown width, on the stem plane. */
    widthRatio: number;
    /** Real crown height (top - base) / the model's. */
    heightRatio: number;
    /** Above the trunk's ground, metres. */
    photoBaseM: number;
    modelBaseM: number;
    photoTopM: number;
    modelTopM: number;
    photoWidthM: number;
    modelWidthM: number;
    distanceM: number;
}

/** One tree's reading from one photo: the model box (projected ellipsoid) against the photo's crown box. */
export function readCrown(cam: FrameCamera, tree: CheckedTree, photoBox: ImageBox): CrownPhotoReading | null {
    const modelBox = ellipsoidImageBox(cam, tree.crown);
    if (!modelBox) return null;
    const m = liftBox(cam, tree.stem, modelBox), p = liftBox(cam, tree.stem, photoBox);
    if (!m || !p) return null;
    const mw = m.right - m.left, pw = p.right - p.left, mh = m.topY - m.baseY, ph = p.topY - p.baseY;
    if (!(mw > 0 && pw > 0 && mh > 0 && ph > 0)) return null;
    return {
        treeId: tree.id,
        widthRatio: pw / mw, heightRatio: ph / mh,
        photoBaseM: p.baseY - tree.groundY, modelBaseM: m.baseY - tree.groundY,
        photoTopM: p.topY - tree.groundY, modelTopM: m.topY - tree.groundY,
        photoWidthM: pw, modelWidthM: mw,
        distanceM: Math.hypot(tree.stem[0] - cam.eye[0], tree.stem[1] - cam.eye[2])
    };
}

export function quantile(values: number[], q: number): number {
    if (!values.length) return Number.NaN;
    const v = [...values].sort((a, b) => a - b);
    const f = q * (v.length - 1), i = Math.floor(f), j = Math.min(v.length - 1, i + 1);
    return v[i] + (v[j] - v[i]) * (f - i);
}

export interface Distribution { n: number; p10: number; p25: number; median: number; p75: number; p90: number }

export function distribution(values: number[]): Distribution {
    return { n: values.length, p10: quantile(values, 0.1), p25: quantile(values, 0.25), median: quantile(values, 0.5), p75: quantile(values, 0.75), p90: quantile(values, 0.9) };
}

/** Per tree: the median of its readings over the photos that saw it. */
export function perTreeReadings(readings: CrownPhotoReading[]): CrownPhotoReading[] {
    const by = new Map<number, CrownPhotoReading[]>();
    for (const r of readings) { const a = by.get(r.treeId) ?? []; a.push(r); by.set(r.treeId, a); }
    return [...by.entries()].map(([treeId, rs]) => {
        const med = (k: keyof CrownPhotoReading) => quantile(rs.map(r => r[k] as number), 0.5);
        return {
            treeId, widthRatio: med('widthRatio'), heightRatio: med('heightRatio'), photoBaseM: med('photoBaseM'), modelBaseM: med('modelBaseM'),
            photoTopM: med('photoTopM'), modelTopM: med('modelTopM'), photoWidthM: med('photoWidthM'), modelWidthM: med('modelWidthM'), distanceM: med('distanceM')
        };
    }).sort((a, b) => a.treeId - b.treeId);
}

// ---------------------------------------------------------------------------------------------------------------------
// what a reading must pass
// ---------------------------------------------------------------------------------------------------------------------

/** What the vision model answered for one tree in one photo (pixels of the full photo). */
export interface PhotoCrownAnswer {
    found: boolean;
    box?: ImageBox;
    /** Where it saw the tree's trunk meet the ground. */
    trunk?: { x: number; y: number };
    separable?: 'clear' | 'partly' | 'merged' | (string & {});
    topVisible?: boolean;
    occludedShare?: number;
}

export const CROWN_READING_GATES = {
    /** The trunk it found lies within this share of the crown box's width of the trunk marked (or 60 px). */
    trunkOffsetShare: 0.25, trunkOffsetMinPx: 60,
    maxOccludedShare: 0.4,
    /**
     * The crown it read reaches at least this share of the measured crown top. The tiles measure the top from above
     * (the readings agree with it: median photo / model top 1.07 over 58 readings at Washington Square); a box that stops far below it is a shrub or a smaller
     * tree under the crown, not the crown.
     */
    minTopShare: 0.6
} as const;

/** Why a reading is not used (undefined: it is used). */
export function rejectReading(a: PhotoCrownAnswer, foot: { x: number; y: number }, r: CrownPhotoReading | null): string | undefined {
    const G = CROWN_READING_GATES;
    if (!a.found || !a.box) return 'no tree found at the marked trunk';
    if (!r) return 'the boxes do not lift onto the stem plane';
    if (a.separable !== 'clear' && a.separable !== 'partly') return 'its crown merges with its neighbours';
    if (a.topVisible === false) return 'its top is not in the photo';
    if ((a.occludedShare ?? 0) > G.maxOccludedShare) return 'it is mostly hidden';
    if (!a.trunk) return 'no trunk point';
    const w = a.box.x1 - a.box.x0;
    if (Math.abs(a.trunk.x - foot.x) > Math.max(G.trunkOffsetMinPx, G.trunkOffsetShare * w)) return 'the trunk it found is not the one marked';
    if (r.photoTopM < G.minTopShare * r.modelTopM) return 'the crown it read stops far below the measured top';
    return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// the correction
// ---------------------------------------------------------------------------------------------------------------------

export const CROWN_CORRECTION_SCHEMA = 'scratchbox.crown-correction/1';

/**
 * One crown's correction: the native plant applies it to the measured crown before growing (scratchbox_tile_vegetation.hpp
 * CrownCorrection). The crown top is not corrected: the tiles measure it from above.
 */
export interface CrownCorrectionEntry {
    /** Horizontal scale about the crown's centre. */
    widthScale: number;
    /** The crown base's height above the trunk's ground, as a share of the tree's measured height. */
    crownBaseRatio: number;
    /** 'photo' (this tree's own readings) or 'district-median'. */
    source: 'photo' | 'district-median' | (string & {});
    photos?: number;
}

export interface CrownCorrection {
    schema: typeof CROWN_CORRECTION_SCHEMA;
    provenance: 'photo-inferred';
    method: string;
    /** The crowns.json the correction was measured for (sha256 of the file). */
    crownsSha256?: string;
    median: { widthScale: number; crownBaseRatio: number; trees: number; readings: number };
    trees: Record<string, CrownCorrectionEntry>;
}

/** The limits a correction is held to: a reading outside them is more likely a misread box than a crown that size. */
export const CROWN_CORRECTION_LIMITS = { widthScale: [0.7, 2.0], crownBaseRatio: [0.08, 0.6] } as const;

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.max(lo, Math.min(hi, v));

/**
 * The correction from the per-tree readings (perTreeReadings of the accepted ones). Only the crown's size changes, never
 * where it stands or how tall it is: width by the width ratio, the crown base to the photo's base as a share of the tree's
 * measured height (`heightOf`). `allTreeIds` are the planted trees; those without a reading take the median of those with one.
 */
export function crownCorrectionFromReadings(
    perTree: CrownPhotoReading[], allTreeIds: number[], heightOf: (id: number) => number, photosPerTree: Map<number, number> = new Map(), readings = perTree.length
): CrownCorrection {
    const L = CROWN_CORRECTION_LIMITS;
    const own = perTree.map(r => ({
        id: r.treeId,
        e: { widthScale: clamp(r.widthRatio, L.widthScale), crownBaseRatio: clamp(r.photoBaseM / Math.max(0.5, heightOf(r.treeId)), L.crownBaseRatio) }
    }));
    const med = { widthScale: quantile(own.map(o => o.e.widthScale), 0.5), crownBaseRatio: quantile(own.map(o => o.e.crownBaseRatio), 0.5) };
    const trees: Record<string, CrownCorrectionEntry> = {};
    const seen = new Map(own.map(o => [o.id, o.e]));
    for (const id of allTreeIds) {
        const e = seen.get(id);
        trees[String(id)] = e ? { ...e, source: 'photo', photos: photosPerTree.get(id) ?? 1 } : { ...med, source: 'district-median' };
    }
    return {
        schema: CROWN_CORRECTION_SCHEMA, provenance: 'photo-inferred',
        method: 'crown boxes read (vision, LOW thinking) from registered Street View photos (Maps Imagery Grounding API) against the planted crown ellipsoids, lifted onto the stem plane; trees not seen take the district median',
        median: { ...med, trees: own.length, readings }, trees
    };
}
