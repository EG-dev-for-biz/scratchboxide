/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Blueprint outlines: the side, plan and front outlines of a real object, in metres, read from orthographic views an
 * image model draws, and the same outlines read from a built GLB, so the two can be compared. This is the blueprint
 * method of hand modelling (place every point against side, top and front drawings at scale) done by measurement.
 *
 *   1. Draw: the side elevation first (front to the right), then the plan from above and the front elevation, each
 *      shown the side view so all three draw the same object; every view on one flat background colour.
 *   2. Silhouette: the background is flood-filled in from the image border (colour distance to the border's median
 *      colour), so only background that touches the border is removed; the largest remaining piece is the object.
 *   3. Scale: the side and front silhouettes are stretched to the object's overall size (width, height, length, as
 *      given), axis by axis; the plan is scaled by the length alone, since a drawn overall width leans on how big
 *      the protrusions (a car's mirrors) were drawn. How far the drawn proportions were off is reported per view.
 *   4. Outlines, in the object build frame (+Y up from the ground, +Z the object's front, X across, origin at the
 *      middle of its length and width): side top and bottom line per station along Z, plan half width per station
 *      along Z (from the top view), front half width per station up Y (from the front view).
 *   5. Ground contacts: where the side bottom line touches the ground along the length (a car's tyres, a table's
 *      legs), with their centres, so a drawing whose contacts disagree with a published dimension can be caught.
 *
 * The outlines of a GLB come from the triangles themselves (each triangle cut by the station planes), in the same
 * frame, so a build can be compared with its blueprint station by station. The drawings are generated: the outlines
 * read from them are labelled generated, scaled to the given size, and never called measured.
 */

import type { GenerateContentClient, ReferenceObjectBuilderDeps } from './reference-object-builder';
import { REFERENCE_IMAGE_MODEL } from './reference-object-builder';
import { finalImagePart } from '../google-media-generation-service';
import { classifyMediaGenerationError } from '../../common/media-generation-protocol';
import { isModelNotFoundError } from '../gemini/gemini-client';
import type { RgbaImage } from '../image-codec-ffmpeg';
import type { TriangleSoup } from './part-connectivity';

import type { FrontStation, ObjectOutlines, PlanStation, SideStation, Vec3 } from '../../common/spatial/blueprint-loft';

export type { FrontStation, ObjectOutlines, PlanStation, SideStation, Vec3 };

/** The model the views are drawn with first; REFERENCE_IMAGE_MODEL stands in when it is not served. */
export const BLUEPRINT_IMAGE_MODEL = 'gemini-3.1-flash-image';
/** Stations along the length (side and plan) and up the height (front). */
export const LENGTH_STATIONS = 81;
export const HEIGHT_STATIONS = 21;
/** RGB distance from the background colour under which a border-connected pixel is background. */
export const BACKGROUND_TOLERANCE = 60;
/** A drawn view whose proportions are off by more than this is reported as not to scale. */
export const ASPECT_WARNING = 0.12;
/** Horizontal runs thinner than this many pixel rows are not part of the object: a drawn ground line, anti-aliased (6 rows on a 1376 px Golf side view). */
export const OPEN_PX = 9;
/** The side bottom line counts as touching the ground below this share of the height. */
const CONTACT_SHARE = 0.03;
const DEFAULT_BACKGROUND = { name: 'magenta', hex: '#FF00FF' };

export type BlueprintViewName = 'side' | 'top' | 'front';

export interface Silhouette {
    width: number;
    height: number;
    /** 1 where the object is, row-major. */
    mask: Uint8Array;
    /** Bounding box of the object, pixels inclusive. */
    box: { x0: number; y0: number; x1: number; y1: number };
    background: [number, number, number];
    /** Share of the image the object covers. */
    coverage: number;
}

export interface BlueprintView {
    view: BlueprintViewName;
    image: { data: Buffer; mimeType: string };
    model: string;
    silhouette: Silhouette;
    /** Drawn width/height over the real one, less 1 (0 = drawn to scale). */
    aspectError: number;
}

// ---------------------------------------------------------------------------
// Silhouettes
// ---------------------------------------------------------------------------

/** The object's silhouette in a view drawn on a flat background: background flood-filled in from the border. */
export function silhouetteOf(image: RgbaImage, tolerance = BACKGROUND_TOLERANCE): Silhouette {
    const { width: w, height: h, rgba: data } = image;
    const n = w * h;
    const border: number[][] = [[], [], []];
    const pushBorder = (i: number) => { for (let c = 0; c < 3; c++) border[c].push(data[i * 4 + c]); };
    for (let x = 0; x < w; x++) { pushBorder(x); pushBorder((h - 1) * w + x); }
    for (let y = 1; y < h - 1; y++) { pushBorder(y * w); pushBorder(y * w + w - 1); }
    const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]; };
    const bg: [number, number, number] = [median(border[0]), median(border[1]), median(border[2])];
    const tol2 = tolerance * tolerance;
    const isBackground = (i: number) => {
        const dr = data[i * 4] - bg[0], dg = data[i * 4 + 1] - bg[1], db = data[i * 4 + 2] - bg[2];
        return dr * dr + dg * dg + db * db <= tol2;
    };

    // what is not background-coloured, less every horizontal run thinner than OPEN_PX rows (a vertical opening): a drawn
    // ground line joining the tyres would otherwise close off the gap under the object and fill it in
    const solid = new Uint8Array(n);
    for (let i = 0; i < n; i++) solid[i] = isBackground(i) ? 0 : 1;
    const r = OPEN_PX >> 1;
    const eroded = new Uint8Array(n);
    for (let y = r; y < h - r; y++) {
        for (let x = 0; x < w; x++) {
            let all = 1;
            for (let k = -r; k <= r && all; k++) all = solid[(y + k) * w + x];
            eroded[y * w + x] = all;
        }
    }
    const kept = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!eroded[y * w + x]) continue;
            for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) kept[yy * w + x] = 1; }
        }
    }

    // flood the background in from the border through everything not kept
    const outside = new Uint8Array(n);
    const queue = new Int32Array(n);
    let head = 0, tail = 0;
    const seed = (i: number) => { if (!outside[i] && !kept[i]) { outside[i] = 1; queue[tail++] = i; } };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (head < tail) {
        const i = queue[head++];
        const x = i % w, y = (i / w) | 0;
        if (x > 0) seed(i - 1);
        if (x < w - 1) seed(i + 1);
        if (y > 0) seed(i - w);
        if (y < h - 1) seed(i + w);
    }

    // the largest 8-connected piece of what is left is the object
    const label = new Int32Array(n);
    let best = 0, bestSize = 0, next = 0;
    for (let s = 0; s < n; s++) {
        if (outside[s] || label[s]) continue;
        next++;
        head = 0; tail = 0;
        label[s] = next; queue[tail++] = s;
        while (head < tail) {
            const i = queue[head++];
            const x = i % w, y = (i / w) | 0;
            for (let dy = -1; dy <= 1; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= h) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const xx = x + dx;
                    if (xx < 0 || xx >= w) continue;
                    const j = yy * w + xx;
                    if (!outside[j] && !label[j]) { label[j] = next; queue[tail++] = j; }
                }
            }
        }
        if (tail > bestSize) { bestSize = tail; best = next; }
    }
    if (!bestSize) throw new Error('The view shows no object: the whole image reads as background.');

    const mask = new Uint8Array(n);
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let i = 0; i < n; i++) {
        if (label[i] !== best) continue;
        mask[i] = 1;
        const x = i % w, y = (i / w) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { width: w, height: h, mask, box: { x0, y0, x1, y1 }, background: bg, coverage: bestSize / n };
}

/** First and last object pixel in a column (or row), or undefined when it holds none. */
function columnExtent(s: Silhouette, x: number): [number, number] | undefined {
    let first = -1, last = -1;
    for (let y = s.box.y0; y <= s.box.y1; y++) {
        if (s.mask[y * s.width + x]) { if (first < 0) first = y; last = y; }
    }
    return first < 0 ? undefined : [first, last];
}

function rowExtent(s: Silhouette, y: number): [number, number] | undefined {
    let first = -1, last = -1;
    for (let x = s.box.x0; x <= s.box.x1; x++) {
        if (s.mask[y * s.width + x]) { if (first < 0) first = x; last = x; }
    }
    return first < 0 ? undefined : [first, last];
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const stationsAlong = (from: number, to: number, count: number) => Array.from({ length: count }, (_, i) => from + (to - from) * i / (count - 1));

/**
 * The outlines of the three silhouettes, scaled to sizeMeters [width, height, length]: the side view stretched to the
 * length and height, the front view to the width and height, the top view by the length alone (its width is the
 * drawing's own). The side and top views have the front to the right; the front view is seen head on.
 */
export function outlinesFromSilhouettes(views: { side: Silhouette; top: Silhouette; front: Silhouette }, sizeMeters: Vec3, warp?: LengthWarp): ObjectOutlines {
    const [W, H, L] = sizeMeters;
    const { side, top, front } = views;
    const span = (b: Silhouette['box']) => ({ w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 });

    // a station's column: z runs from -L/2 at the box's left edge to +L/2 at its right edge (the front), read through
    // the length warp when there is one (the build-frame z mapped to where the drawing has it)
    const drawnZ = warp ? (z: number) => warpZ(warp.knots, z, 'z', 'drawnZ') : (z: number) => z;
    const colAt = (s: Silhouette, z: number) => Math.min(s.box.x1, Math.max(s.box.x0, Math.round(s.box.x0 + (drawnZ(z) / L + 0.5) * (span(s.box).w - 1))));
    const sideBox = span(side.box);
    const yOf = (row: number, edge: 'top' | 'bottom') => (side.box.y1 - row + (edge === 'top' ? 1 : 0)) / sideBox.h * H;

    const sideStations: SideStation[] = [];
    for (const z of stationsAlong(L / 2, -L / 2, LENGTH_STATIONS)) {
        const ext = columnExtent(side, colAt(side, z));
        if (ext) sideStations.push({ z: round3(z), top: round3(yOf(ext[0], 'top')), bottom: round3(Math.max(0, yOf(ext[1], 'bottom'))) });
    }
    // the plan is scaled by the length alone: stretched to the overall width, a top view that draws the mirrors small
    // reads the whole body too wide (on a Golf GTI against its production model: 4.6 cm mean error stretched, 2.3 uniform)
    const metresPerPlanPixel = L / span(top.box).w;
    const plan: PlanStation[] = [];
    for (const z of stationsAlong(L / 2, -L / 2, LENGTH_STATIONS)) {
        const ext = columnExtent(top, colAt(top, z));
        if (ext) plan.push({ z: round3(z), halfWidth: round3((ext[1] - ext[0] + 1) * metresPerPlanPixel / 2) });
    }
    const frontBox = span(front.box);
    const frontStations: FrontStation[] = [];
    for (const y of stationsAlong(0, H, HEIGHT_STATIONS)) {
        const row = Math.min(front.box.y1, Math.max(front.box.y0, Math.round(front.box.y1 - (y / H) * (frontBox.h - 1))));
        const ext = rowExtent(front, row);
        if (ext) frontStations.push({ y: round3(y), halfWidth: round3((ext[1] - ext[0] + 1) / frontBox.w * W / 2) });
    }
    return { sizeMeters, side: sideStations, plan, front: frontStations, groundContacts: groundContacts(sideStations, H), ...(warp ? { lengthWarp: warp } : {}) };
}

export type LengthWarp = NonNullable<ObjectOutlines['lengthWarp']>;
type Knot = LengthWarp['knots'][number];

/** Piecewise linear through the knots (sorted by both z and drawnZ), from one coordinate to the other. */
export function warpZ(knots: Knot[], v: number, from: keyof Knot, to: keyof Knot): number {
    for (let i = 1; i < knots.length; i++) {
        const a = knots[i - 1], b = knots[i];
        if (v <= b[from] || i === knots.length - 1) {
            const t = (v - a[from]) / (b[from] - a[from] || 1);
            return a[to] + t * (b[to] - a[to]);
        }
    }
    return v;
}

/** How far a drawn contact spacing may be from the target spacing before the drawing is judged wrong, not stretched. */
export const MAX_AXLE_STRETCH = 0.12;

/**
 * The stretch along the length that puts a drawing's outermost ground contacts (read from its unwarped outlines)
 * at the given positions, the ends staying at the ends: three linear pieces, tail to rear contact, between the
 * contacts, front contact to nose. Refused, with the reason, when fewer than two contacts were read, when a target
 * lies outside the length, or when the drawn spacing is more than MAX_AXLE_STRETCH off the target spacing (that
 * drawing is wrong, not merely out of scale).
 */
export function axleWarp(outlines: ObjectOutlines, axleZ: [number, number]): { warp: LengthWarp } | { reason: string } {
    const L = outlines.sizeMeters[2];
    const [front, rear] = axleZ[0] > axleZ[1] ? axleZ : [axleZ[1], axleZ[0]];
    const c = outlines.groundContacts;
    if (c.length < 2) return { reason: `only ${c.length} ground contact${c.length === 1 ? ' was' : 's were'} read from the side view` };
    if (!(rear > -L / 2 && front < L / 2)) return { reason: `the axles (z ${front}, ${rear}) are not inside the length (${L} m)` };
    const drawnFront = c[0].zCentre, drawnRear = c[c.length - 1].zCentre;
    const stretch = (front - rear) / (drawnFront - drawnRear) - 1;
    if (!(drawnFront > drawnRear) || Math.abs(stretch) > MAX_AXLE_STRETCH) {
        return { reason: `the drawn contacts are ${round3(drawnFront - drawnRear)} m apart for ${round3(front - rear)} m (more than ${MAX_AXLE_STRETCH * 100} % off): the drawing is wrong, not merely out of scale` };
    }
    const knots = [{ z: -L / 2, drawnZ: -L / 2 }, { z: rear, drawnZ: drawnRear }, { z: front, drawnZ: drawnFront }, { z: L / 2, drawnZ: L / 2 }]
        .map(k => ({ z: round3(k.z), drawnZ: round3(k.drawnZ) }));
    return { warp: { knots, note: `side and plan stretched along the length so the drawn ground contacts (z ${drawnFront}, ${drawnRear}) land on the given axles (z ${round3(front)}, ${round3(rear)}): the wheelbase ${round3(stretch * 100)} %, the overhangs to match; generated` } };
}

/** Runs of side stations whose bottom line touches the ground, front first. */
export function groundContacts(side: SideStation[], height: number): ObjectOutlines['groundContacts'] {
    const runs: ObjectOutlines['groundContacts'] = [];
    let run: SideStation[] = [];
    const close = () => {
        if (run.length) runs.push({ zFrom: run[0].z, zTo: run[run.length - 1].z, zCentre: round3((run[0].z + run[run.length - 1].z) / 2) });
        run = [];
    };
    for (const s of side) {
        if (s.bottom <= CONTACT_SHARE * height) run.push(s); else close();
    }
    close();
    return runs;
}

/** Drawn proportions against the real ones, per view, less 1. */
export function aspectErrors(views: { side: Silhouette; top: Silhouette; front: Silhouette }, sizeMeters: Vec3): Record<BlueprintViewName, number> {
    const [W, H, L] = sizeMeters;
    const ratio = (s: Silhouette) => (s.box.x1 - s.box.x0 + 1) / (s.box.y1 - s.box.y0 + 1);
    return {
        side: round3(ratio(views.side) / (L / H) - 1),
        top: round3(ratio(views.top) / (L / W) - 1),
        front: round3(ratio(views.front) / (W / H) - 1)
    };
}

// ---------------------------------------------------------------------------
// Outlines of a build
// ---------------------------------------------------------------------------

/**
 * The outlines of a triangle soup in the object build frame, at the stations of `like` when given (so a build is
 * read where its blueprint was, a station it does not reach read as empty), else at evenly spaced ones. X and Z are centred on the soup's own bounds; Y is
 * measured from its lowest point.
 */
export function outlinesFromTriangles(soup: TriangleSoup, like?: ObjectOutlines): ObjectOutlines {
    const p = soup.positions;
    const idx = soup.indices;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
        if (p[i] < minX) minX = p[i]; if (p[i] > maxX) maxX = p[i];
        if (p[i + 1] < minY) minY = p[i + 1]; if (p[i + 1] > maxY) maxY = p[i + 1];
        if (p[i + 2] < minZ) minZ = p[i + 2]; if (p[i + 2] > maxZ) maxZ = p[i + 2];
    }
    if (!(maxX > minX)) throw new Error('The model has no triangles to read outlines from.');
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const W = maxX - minX, H = maxY - minY, L = maxZ - minZ;
    const zs = like ? like.side.map(s => s.z) : stationsAlong(L / 2, -L / 2, LENGTH_STATIONS);
    const zPlan = like ? like.plan.map(s => s.z) : zs;
    const ys = like ? like.front.map(s => s.y) : stationsAlong(0, H, HEIGHT_STATIONS);

    // every station plane a triangle crosses: extend that station's extents by the triangle's cut there
    const cutAlong = (stations: number[], axis: 0 | 1 | 2, offset: number, visit: (k: number, a: number[], b: number[]) => void) => {
        const sorted = stations.map((v, k) => ({ v: v + offset, k })).sort((a, b) => a.v - b.v);
        const vals = sorted.map(s => s.v);
        const v = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (let t = 0; t < idx.length; t += 3) {
            for (let c = 0; c < 3; c++) {
                const o = idx[t + c] * 3;
                v[c][0] = p[o]; v[c][1] = p[o + 1]; v[c][2] = p[o + 2];
            }
            const lo = Math.min(v[0][axis], v[1][axis], v[2][axis]);
            const hi = Math.max(v[0][axis], v[1][axis], v[2][axis]);
            let s = lowerBound(vals, lo);
            for (; s < vals.length && vals[s] <= hi; s++) {
                const plane = vals[s];
                const pts: number[][] = [];
                for (let e = 0; e < 3; e++) {
                    const a = v[e], b = v[(e + 1) % 3];
                    const da = a[axis] - plane, db = b[axis] - plane;
                    if (da === 0) pts.push(a);
                    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
                        const f = da / (da - db);
                        pts.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
                    }
                }
                if (pts.length) visit(sorted[s].k, pts[0], pts[pts.length - 1]);
            }
        }
    };

    const top = zs.map(() => -Infinity), bottom = zs.map(() => Infinity);
    cutAlong(zs, 2, cz, (k, a, b) => {
        top[k] = Math.max(top[k], a[1], b[1]);
        bottom[k] = Math.min(bottom[k], a[1], b[1]);
    });
    const half = zPlan.map(() => -Infinity);
    cutAlong(zPlan, 2, cz, (k, a, b) => { half[k] = Math.max(half[k], Math.abs(a[0] - cx), Math.abs(b[0] - cx)); });
    const frontHalf = ys.map(() => -Infinity);
    cutAlong(ys, 1, minY, (k, a, b) => { frontHalf[k] = Math.max(frontHalf[k], Math.abs(a[0] - cx), Math.abs(b[0] - cx)); });

    // read at a blueprint's stations, a station the model does not reach is kept as empty (0), so it is compared
    const keep = (v: number) => v > -Infinity || like !== undefined;
    const side: SideStation[] = [];
    zs.forEach((z, k) => { if (keep(top[k])) side.push(top[k] > -Infinity ? { z: round3(z), top: round3(top[k] - minY), bottom: round3(bottom[k] - minY) } : { z: round3(z), top: 0, bottom: 0 }); });
    const plan: PlanStation[] = [];
    zPlan.forEach((z, k) => { if (keep(half[k])) plan.push({ z: round3(z), halfWidth: half[k] > -Infinity ? round3(half[k]) : 0 }); });
    const front: FrontStation[] = [];
    ys.forEach((y, k) => { if (keep(frontHalf[k])) front.push({ y: round3(y), halfWidth: frontHalf[k] > -Infinity ? round3(frontHalf[k]) : 0 }); });
    return { sizeMeters: [round3(W), round3(H), round3(L)], side, plan, front, groundContacts: groundContacts(side, H) };
}

function lowerBound(sorted: number[], value: number): number {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < value) lo = mid + 1; else hi = mid; }
    return lo;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export interface OutlineDifference {
    /** Which outline: the side top or bottom line, the plan half width or the front half width. */
    outline: 'side top' | 'side bottom' | 'plan half width' | 'front half width';
    /** The span of stations the difference covers (z along the length, or y up the height). */
    along: 'z' | 'y';
    from: number;
    to: number;
    /** Built minus blueprint at the station where they differ most, metres. */
    worstMeters: number;
    built: number;
    blueprint: number;
}

export interface OutlineComparison {
    /** Mean absolute difference of each outline, metres. */
    meanAbsMeters: Record<OutlineDifference['outline'], number>;
    /** Spans where the build is off by more than the tolerance, largest first. */
    differences: OutlineDifference[];
    toleranceMeters: number;
}

/**
 * Station-by-station differences of a build from its blueprint, grouped into spans where the build is off by more
 * than `toleranceShare` of the object's largest dimension (in the same direction along the span).
 */
export function compareOutlines(blueprint: ObjectOutlines, built: ObjectOutlines, toleranceShare = 0.015): OutlineComparison {
    const tolerance = round3(toleranceShare * Math.max(...blueprint.sizeMeters));
    const spans: OutlineDifference[] = [];
    const mean: Partial<OutlineComparison['meanAbsMeters']> = {};
    const run = (outline: OutlineDifference['outline'], along: 'z' | 'y', pairs: Array<{ at: number; b: number; m: number }>) => {
        let sum = 0;
        let open: OutlineDifference | undefined;
        const flush = () => { if (open) spans.push(open); open = undefined; };
        for (const { at, b, m } of pairs) {
            const d = m - b;
            sum += Math.abs(d);
            if (Math.abs(d) <= tolerance) { flush(); continue; }
            if (open && Math.sign(open.worstMeters) === Math.sign(d)) {
                open.to = at;
                if (Math.abs(d) > Math.abs(open.worstMeters)) Object.assign(open, { worstMeters: round3(d), built: m, blueprint: b });
            } else {
                flush();
                open = { outline, along, from: at, to: at, worstMeters: round3(d), built: m, blueprint: b };
            }
        }
        flush();
        mean[outline] = pairs.length ? round3(sum / pairs.length) : 0;
    };
    const byZ = <T extends { z: number }>(a: T[], b: T[], get: (s: T) => number) => {
        const other = new Map(b.map(s => [s.z, s]));
        return a.flatMap(s => { const o = other.get(s.z); return o ? [{ at: s.z, b: get(s), m: get(o) }] : []; });
    };
    run('side top', 'z', byZ(blueprint.side, built.side, s => s.top));
    run('side bottom', 'z', byZ(blueprint.side, built.side, s => s.bottom));
    run('plan half width', 'z', byZ(blueprint.plan, built.plan, s => s.halfWidth));
    const frontBuilt = new Map(built.front.map(s => [s.y, s]));
    run('front half width', 'y', blueprint.front.flatMap(s => { const o = frontBuilt.get(s.y); return o ? [{ at: s.y, b: s.halfWidth, m: o.halfWidth }] : []; }));
    spans.sort((a, b) => Math.abs(b.worstMeters) - Math.abs(a.worstMeters));
    return { meanAbsMeters: mean as OutlineComparison['meanAbsMeters'], differences: spans, toleranceMeters: tolerance };
}

/** One line per difference, in words the spec reader and the chat can act on. */
export function describeDifferences(c: OutlineComparison, limit = 12): string[] {
    return c.differences.slice(0, limit).map(d => {
        const span = d.from === d.to ? `at ${d.along} ${d.from}` : `${d.along} ${d.from} to ${d.to}`;
        const what = d.outline.startsWith('side') ? (d.worstMeters > 0 ? 'higher' : 'lower') : (d.worstMeters > 0 ? 'wider' : 'narrower');
        return `${d.outline}, ${span} m: the build is ${Math.abs(d.worstMeters).toFixed(3)} m ${what} than the blueprint (built ${d.built.toFixed(3)}, blueprint ${d.blueprint.toFixed(3)})`;
    });
}

/** The outlines as compact text for buildNotes: every fourth station along the length, every other up the height, metres, in the build frame. */
export function outlinesAsNotes(o: ObjectOutlines): string {
    const every = <T>(a: T[], k: number) => a.filter((_, i) => i % k === 0 || i === a.length - 1);
    return [
        `Blueprint outlines (generated drawings scaled to ${o.sizeMeters.join(' x ')} m, width x height x length; frame +Z front, origin on the ground at mid-length):`,
        `side, z: top/bottom: ${every(o.side, 4).map(s => `${s.z}: ${s.top}/${s.bottom}`).join('; ')}`,
        `plan, z: half width: ${every(o.plan, 4).map(s => `${s.z}: ${s.halfWidth}`).join('; ')}`,
        `front, y: half width: ${every(o.front, 2).map(s => `${s.y}: ${s.halfWidth}`).join('; ')}`,
        o.groundContacts.length ? `ground contacts along z (from/to, centre): ${o.groundContacts.map(c => `${c.zFrom}/${c.zTo} (${c.zCentre})`).join('; ')}` : 'ground contacts: none read',
        ...(o.lengthWarp ? [o.lengthWarp.note] : [])
    ].join('\n');
}

// ---------------------------------------------------------------------------
// Drawing the views
// ---------------------------------------------------------------------------

export function blueprintViewPrompt(view: BlueprintViewName, subject: string, background = DEFAULT_BACKGROUND): string {
    const how: Record<BlueprintViewName, string> = {
        side: `A precise orthographic side elevation of: ${subject}. The camera is exactly level with the object and square to its side; the object's front faces RIGHT.`,
        top: `A precise orthographic plan view, from directly above, of the same object as in the image: ${subject}. The camera looks straight down; the object's front faces RIGHT, exactly as in the image.`,
        front: `A precise orthographic front elevation of the same object as in the image: ${subject}. The camera is exactly level with the object and looks straight at its front.`
    };
    return [
        how[view],
        'True orthographic projection, as in a manufacturer\'s blueprint: no perspective, no foreshortening, no tilt.',
        'Show the whole object, uncropped and centred, filling the frame with a small even margin on every side.',
        `Draw it as a clean, evenly lit rendering in its real colours on a perfectly flat, uniform ${background.name} (${background.hex}) background that fills everything around it.`,
        'No ground, ground line, floor line, shadow, reflection, text, dimension lines, labels, logos or any other object: the object alone, nothing drawn under or around it.'
    ].join('\n');
}

export interface DrawBlueprintOptions {
    subject: string;
    sizeMeters: Vec3;
    /** Image model to draw with; omitted, BLUEPRINT_IMAGE_MODEL then REFERENCE_IMAGE_MODEL. */
    model?: string;
    signal?: AbortSignal;
    reportProgress?: (message: string, fraction?: number) => void;
    decode: (data: Buffer) => Promise<RgbaImage>;
    sleep?: ReferenceObjectBuilderDeps['sleep'];
}

const ASPECT_RATIOS: Record<BlueprintViewName, string> = { side: '16:9', top: '16:9', front: '1:1' };
const EMPTY_IMAGE_ATTEMPTS = 3;
const TRANSIENT_RETRIES = 3;

async function drawView(client: GenerateContentClient, models: string[], prompt: string, aspectRatio: string, reference: { data: Buffer; mimeType: string } | undefined, options: DrawBlueprintOptions): Promise<{ data: Buffer; mimeType: string; model: string }> {
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    const skipped: string[] = [];
    for (const model of models) {
        try {
            for (let empty = 0; empty < EMPTY_IMAGE_ATTEMPTS; empty++) {
                let response;
                for (let attempt = 0; ; attempt++) {
                    if (options.signal?.aborted) throw new Error('Stopped while drawing the blueprint.');
                    try {
                        response = await client.models.generateContent({
                            model,
                            contents: [{ role: 'user', parts: [...(reference ? [{ inlineData: { data: reference.data.toString('base64'), mimeType: reference.mimeType } }] : []), { text: prompt }] }],
                            config: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio }, abortSignal: options.signal }
                        });
                        break;
                    } catch (err) {
                        const c = classifyMediaGenerationError(err, model);
                        if ((c.code === 'transient' || c.code === 'quota') && attempt < TRANSIENT_RETRIES && !options.signal?.aborted) {
                            await sleep(1000 * 2 ** attempt);
                            continue;
                        }
                        throw err;
                    }
                }
                const blocked = response.promptFeedback?.blockReason;
                if (blocked) throw new Error(`${model} refused the request (${blocked}).`);
                const part = finalImagePart(response.candidates?.[0]?.content?.parts);
                if (part?.inlineData?.data) return { data: Buffer.from(part.inlineData.data, 'base64'), mimeType: part.inlineData.mimeType || 'image/png', model: response.modelVersion || model };
            }
            throw new Error(`${model} returned no image in ${EMPTY_IMAGE_ATTEMPTS} attempts.`);
        } catch (err) {
            if (!isModelNotFoundError(err)) throw err;
            skipped.push(`${model} is not served`);
        }
    }
    throw new Error(`No image model drew the blueprint: ${skipped.join('; ')}.`);
}

/** Draws the side view, then the top and front views shown it, and reads each one's silhouette. */
export async function drawBlueprintViews(client: GenerateContentClient, options: DrawBlueprintOptions): Promise<BlueprintView[]> {
    const models = options.model ? [options.model] : [BLUEPRINT_IMAGE_MODEL, REFERENCE_IMAGE_MODEL];
    const read = async (view: BlueprintViewName, drawn: { data: Buffer; mimeType: string; model: string }): Promise<Omit<BlueprintView, 'aspectError'>> => {
        const silhouette = silhouetteOf(await options.decode(drawn.data));
        return { view, image: { data: drawn.data, mimeType: drawn.mimeType }, model: drawn.model, silhouette };
    };
    options.reportProgress?.('Drawing the side elevation', 0.1);
    const sideDrawn = await drawView(client, models, blueprintViewPrompt('side', options.subject), ASPECT_RATIOS.side, undefined, options);
    const side = await read('side', sideDrawn);
    options.reportProgress?.('Drawing the plan and front elevation from the side view', 0.4);
    const [top, front] = await Promise.all((['top', 'front'] as const).map(async view =>
        read(view, await drawView(client, models, blueprintViewPrompt(view, options.subject), ASPECT_RATIOS[view], side.image, options))));
    const errors = aspectErrors({ side: side.silhouette, top: top.silhouette, front: front.silhouette }, options.sizeMeters);
    return [side, top, front].map(v => ({ ...v, aspectError: errors[v.view] }));
}

/** The view's image with the read outline drawn in (object edge in yellow, box in cyan), as RGBA. */
export function overlayOf(image: RgbaImage, s: Silhouette): RgbaImage {
    const out = Buffer.from(image.rgba);
    const put = (x: number, y: number, rgb: [number, number, number]) => {
        if (x < 0 || y < 0 || x >= s.width || y >= s.height) return;
        const i = (y * s.width + x) * 4;
        out[i] = rgb[0]; out[i + 1] = rgb[1]; out[i + 2] = rgb[2]; out[i + 3] = 255;
    };
    for (let y = 0; y < s.height; y++) {
        for (let x = 0; x < s.width; x++) {
            const i = y * s.width + x;
            if (!s.mask[i]) continue;
            const edge = x === 0 || y === 0 || x === s.width - 1 || y === s.height - 1 || !s.mask[i - 1] || !s.mask[i + 1] || !s.mask[i - s.width] || !s.mask[i + s.width];
            if (edge) { put(x, y, [255, 230, 0]); put(x + 1, y, [255, 230, 0]); }
        }
    }
    for (let x = s.box.x0; x <= s.box.x1; x++) { put(x, s.box.y0, [0, 220, 255]); put(x, s.box.y1, [0, 220, 255]); }
    for (let y = s.box.y0; y <= s.box.y1; y++) { put(s.box.x0, y, [0, 220, 255]); put(s.box.x1, y, [0, 220, 255]); }
    return { width: s.width, height: s.height, rgba: out };
}
