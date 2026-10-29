/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's roof cast-shadow lift: the sun each roof photo was taken under, fitted from the building's own geometry, and
 * the shadow the building casts on its roofs in that photo taken out.
 *
 * Google's aerial roof photos carry the capture's sun (the Empire State Building's upper decks lie in the tower's shadow),
 * but the tiles blend many captures, so there is no one sun per building (sky-delight.ts): the fit is per photo.
 *
 *  1. Roof cells: every photo's roof texels on a grid every `cellTexels` texels, each with its 3D point and colour (its own
 *     texel: a block mean would mix the atlas's neighbouring charts). Roof is decided here, not by texture-harmonize.ts's
 *     classes: an up-facing triangle's point that a filled shadow map from straight above (`aboveMapM`) sees. The harmonise
 *     classes come from a corner height map at 0.5 m and, on the ESB's overlapping-box scan, call most of the 86th-floor
 *     deck hidden (310-320 m: 410 of 2,996 m2 roof).
 *  2. Planes: the cells grouped by height (`planeBinM` bins; a peak of at least `minPlaneCells` takes the cells within
 *     `planeTolM`). A deck is fitted as one surface across all its photos: within one photo a deck is a few slivers of an
 *     atlas, and a shadow's edge on a deck around a tower is two short diagonals, too little for an edge statistic.
 *  3. Candidate suns: an orthographic shadow map of the whole mesh toward each (azimuth every `coarseAzDeg`, elevations
 *     `coarseElDeg`), at `coarseMapM` a pixel; a cell is in shadow when something stands `biasM` (plus the map's slope)
 *     nearer the sun. A sun is scored on a plane by the ratio of its lit cells' mean log luminance to its shadowed ones'
 *     (the lit-to-shadow ratio is (sun + sky) / sky, the same for every material), with between `minShare` and `maxShare`
 *     of the plane in shadow. The best coarse sun per plane is refined (`refineDeg`, `refineSteps` each way).
 *  4. A plane's sun is accepted when its ratio is a shadow's (`minRatio` .. `maxRatio`), clearly beats the plane's median
 *     candidate (`overMedian` times: a deck whose materials happen to split along some sun's line does not pass), and holds
 *     in both halves of the plane (`halfBlockM` checkerboard blocks; `minHalfRatio`), with no channel stepping more than
 *     `maxChannelSpread` times another: before harmonising a shadow is bluer than the lit deck (the ESB's 295.5 m deck,
 *     R 2.46x, B 1.67x: 1.47), while two materials step far more (R 3.16x, B 1.02x; or R 2.99x, G 1.90x, B 2.41x: 1.57)
 *     and pass every other test.
 *  5. The rule for every terrace: the sun belongs to a photo's capture, not to a deck, so each photo takes the sun (and the
 *     lit-to-shadow ratio, the capture's (sun + sky) / sky, the same on every surface) of the accepted deck it shows most
 *     of (`minPhotoCells`), once its own cells on that deck confirm it (`minTerraceSide` each side, `minTerraceRatio`):
 *     a photo from another capture than the deck's fit does not borrow its sun. Each terrace of that photo (its roof cells at one height, `terraceBinM`, any size from
 *     `minTerraceCells`) is checked against that sun's shadow: one with `minTerraceSide` cells both lit and shadowed is
 *     lifted only if its shadowed part really is darker (`minTerraceRatio`) and not by a colour change
 *     (`maxChannelSpread`); one lying wholly in the shadow is lifted on the geometry's word. Small terraces no deck fit
 *     could read (on the ESB the setbacks' narrow strips along the walls) are resolved this way. A photo that confirms no
 *     deck's sun (another capture, or too little of a deck) is fitted on its own terraces at every height: each coarse sun
 *     scored by the weighted mean step across all of the photo's terraces that it splits (`minTerraceSide` each side),
 *     accepted under the deck gates (`minRatio`, `overMedian`, `maxChannelSpread`) and when most of those terraces agree
 *     (`minTerraceRatio`, `minAgreeShare`; one terrace alone must hold in both checkerboard halves), from
 *     `minPhotoFitCells` roof cells.
 *  6. A terrace as one surface across photos: the atlas splits a terrace into fragments of many photos (on the ESB the
 *     263 m and 111 m setbacks: 14 to 196 roof cells a photo), too small to fit alone, and a strip along a wall lies wholly
 *     in shadow with no lit part of its own. So the roof cells are joined into terraces (one height bin, connected on a
 *     `componentGridM` grid) whatever their photo, and a terrace holding `minComponentNoSun` cells of photos with no sun
 *     is fitted on the suns already found on the building (few candidates: a small terrace cannot overfit 144): the lit
 *     parts in any photo are the reference for the shadowed ones, under the deck gates (`minRatio`, `maxChannelSpread`,
 *     `minHalfRatio`, `overMedian` against the other known suns). Its no-sun fragments take its sun and measured ratio.
 *  7. The lift, one sun at a time (a finer shadow map, `fineMapM`, made and dropped per sun): each roof texel of an
 *     accepted terrace in its sun's shadow (a soft fraction at the edge, from the map's four nearest pixels) is
 *     multiplied by its photo's ratio (or its terrace's), per channel, in linear light, but never above its terrace's lit
 *     level (mean log luminance of the terrace's lit cells; for a terrace wholly in shadow, of all lit cells under its
 *     sun): a texel the mesh puts in shadow that the photo shows lit (a scan edge a few centimetres off the photo's, a
 *     vent, a railing) is left as it is instead of glowing.
 *
 * The occluders are the twin and, when given, its neighbours (`context`, the tile extraction in the same frame, less what
 * stands over the twin's own footprint: the raw scan of the building itself would shade the rebuilt one): in a street
 * canyon the lower terraces lie mostly in the neighbours' shadows, which the isolated mesh cannot cast. Only a gain is
 * applied, only on roof texels of an accepted terrace in the shadow of a fitted sun. The colour stays the photo's
 * (photo-inferred). Off by default (SCRATCHBOX_K_ROOF_SHADOW=1 on), for pipeline K's building and a district's twin alike.
 *
 * The audit, from straight above: every roof cell of every photo, at every height, put on an `auditCellM` grid as
 * lifted (in a fitted sun's shadow, lifted), rejected (in shadow on a terrace that failed its check), no sun (its photo
 * and terrace have none) or lit, with the area of each (`audit`, and roofShadowAuditPng for the picture): what the rule
 * missed shows on one map, for one building or a district.
 */

import type { ParsedGlb } from '../glb-bytes';
import { SRGB8_TO_LINEAR, linearToSrgb255 } from '../../../../common/spatial/photogrammetric-delight';
import type { RgbaImage8 } from '../tile-texture-transfer';
import { TEXEL_NONE } from './texture-harmonize';
import { collect, type Soup } from './view-relight';
import { encodePng } from '../png-encode';

export const ROOF_SHADOW_VERSION = 'roof-shadow/9';

export const ROOF_SHADOW_PARAMS = {
    /** Coarse suns: azimuth step and elevations (degrees); the coarse map's pixel (m). */
    coarseAzDeg: 15, coarseElDeg: [20, 30, 40, 50, 60, 70], coarseMapM: 0.4,
    /** Refinement around a plane's best coarse sun: step (degrees) and steps each way. */
    refineDeg: 5, refineSteps: 1,
    /** The lift's map pixel (m); in shadow when an occluder stands this much nearer the sun (m, plus the map's slope). */
    fineMapM: 0.15, biasM: 0.5,
    /** Roof cells: one every this many texels. */
    cellTexels: 3,
    /** Planes: height bins (m), cells a plane needs, and how far from its height a cell or texel belongs to it (m). */
    planeBinM: 0.5, minPlaneCells: 1500, planeTolM: 0.75,
    /** Acceptance: the share of the plane in shadow, the ratio's range, its multiple of the plane's median candidate, the halves. */
    minShare: 0.1, maxShare: 0.9, minRatio: 1.2, maxRatio: 6, overMedian: 1.12, halfBlockM: 4, minHalfRatio: 1.12,
    /** The rule for every terrace: cells a photo needs on a deck to take its sun; a terrace's height bin (m) and least cells;
     *  the cells each side a terrace needs to be checked, and the step it must then show. */
    minPhotoCells: 40, terraceBinM: 1, minTerraceCells: 12, minTerraceSide: 15, minTerraceRatio: 1.1,
    /** A photo fitted on its own terraces: its least roof cells, and the share of its split terraces that must agree. */
    minPhotoFitCells: 200, minAgreeShare: 0.66,
    /** A terrace across photos: its plan grid (m), and the cells of photos with no sun it must hold to be fitted. */
    componentGridM: 2, minComponentNoSun: 20,
    /** The audit's grid from above (m). */
    auditCellM: 0.5,
    /** A shadow is lit by the sky, so red may step more than blue, but not by a material's margin: the largest channel ratio at most this times the smallest. */
    maxChannelSpread: 1.5,
    /** Neighbours: context triangles within this of the twin's centre (m), and off its plan grown by this (m). */
    contextRadiusM: 250, footprintGrowM: 1,
    /** A roof triangle's normal: |y| above this; the map from straight above that decides what is roof (m a pixel). */
    flatNy: 0.7, aboveMapM: 0.25
};
export type RoofShadowParams = typeof ROOF_SHADOW_PARAMS;

export interface RoofShadowPlane {
    /** Height (m, model y) and cells. */
    y: number; cells: number;
    /** The best sun, degrees: azimuth in the model's x-z plane (0 along +x, 90 along +z) and elevation; the share in its shadow. */
    sunAzDeg?: number; sunElDeg?: number; shadowShare?: number;
    /** Lit-to-shadow luminance ratio, the plane's median candidate's, per channel, and the two halves'. */
    ratio?: number; medianRatio?: number; rgb?: [number, number, number]; halves?: [number, number];
    accepted: boolean; why: string; texelsLifted: number;
}

export interface RoofShadowReport {
    applied: boolean; why: string;
    /** Roof cells, planes fitted, planes accepted, texels lifted, photos changed. */
    cells: number; planes: number; fitted: number; texelsLifted: number; photosChanged: number;
    /** From straight above: roof area (m2) lifted, in shadow but rejected, with no sun, and lit; and the grid (not in the run note). */
    audit?: { lifted: number; rejected: number; noSun: number; lit: number };
    auditGrid?: { cellM: number; x0: number; z0: number; w: number; h: number; classes: Uint8Array };
    /** Context triangles casting shadows besides the twin's (0: the twin alone). */
    contextTriangles: number;
    /** The rule's terraces: photos given a sun; terraces lifted (checked, or wholly in shadow), rejected, lit throughout; and the rejections. */
    terraces: { photos: number; unconfirmed: number; ownFit: number; lifted: number; liftedWhollyInShadow: number; rejected: number; lit: number; components: number; componentsLifted: number; rejections: Array<{ img: number; y: number; cells: number; why: string }> };
    /** Every photo with roof cells: its sun (from a deck, its own terraces, or none) and each terrace's outcome. */
    photoRecords: Array<{ img: number; cells: number; sun?: { from: 'deck' | 'own'; azDeg: number; elDeg: number }; ownFit?: string; terraces: Array<{ y: number; cells: number; outcome: 'lifted' | 'lifted-whole' | 'rejected' | 'lit' | 'small' | 'no-sun' | 'terrace' }> }>;
    candidates: number; ms: number;
    records: RoofShadowPlane[];
}

const DEG = Math.PI / 180;

/** The audit's classes, in the order a pixel two share takes the worse: lit, lifted, rejected, no sun (0: no roof). */
const AUDIT_LIT = 1, AUDIT_LIFTED = 2, AUDIT_REJECTED = 3, AUDIT_NO_SUN = 4;

/** The audit from above as a PNG (rows along the model's +z): lifted green, rejected orange, no sun magenta, lit grey, no roof white. */
export function roofShadowAuditPng(grid: NonNullable<RoofShadowReport['auditGrid']>): Uint8Array {
    const colours: Array<[number, number, number]> = [[255, 255, 255], [200, 200, 200], [40, 170, 70], [240, 140, 20], [210, 40, 200]];
    const rgba = new Uint8Array(grid.w * grid.h * 4);
    for (let g = 0; g < grid.w * grid.h; g++) { const [r, gg, b] = colours[grid.classes[g]]; rgba[g * 4] = r; rgba[g * 4 + 1] = gg; rgba[g * 4 + 2] = b; rgba[g * 4 + 3] = 255; }
    return new Uint8Array(encodePng(grid.w, grid.h, rgba, 4));
}
const sunDir = (azDeg: number, elDeg: number) => [Math.cos(elDeg * DEG) * Math.cos(azDeg * DEG), Math.sin(elDeg * DEG), Math.cos(elDeg * DEG) * Math.sin(azDeg * DEG)];

/** The topmost surface toward the sun over a plane perpendicular to it: per pixel the largest p . s of any triangle. */
interface ShadowMap { s: number[]; r: number[]; u: number[]; X0: number; Y1: number; W: number; H: number; mpp: number; slope: number; top: Float32Array }

/** Triangles that cast shadows: flat corners, nine floats a triangle. */
interface Occluders { P: Float32Array; n: number }

/**
 * The twin's triangles and the context's that stand off its footprint (a 1 m grid of the twin's plan, grown by footprintGrowM)
 * within contextRadiusM of its centre.
 */
function occludersOf(soup: Soup, context: { vertices: ArrayLike<number>; indices: ArrayLike<number> } | undefined, P: RoofShadowParams): Occluders {
    if (!context) return { P: soup.P, n: soup.n };
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < soup.P.length; i += 3) { x0 = Math.min(x0, soup.P[i]); x1 = Math.max(x1, soup.P[i]); z0 = Math.min(z0, soup.P[i + 2]); z1 = Math.max(z1, soup.P[i + 2]); }
    const g = P.footprintGrowM, W = Math.ceil(x1 - x0 + 2 * g) + 1, H = Math.ceil(z1 - z0 + 2 * g) + 1, X0 = x0 - g, Z0 = z0 - g;
    // the twin's plan: every triangle filled into a 1 m grid (its corners too, so a wall seen edge-on marks its line), then grown
    const core = new Uint8Array(W * H);
    for (let t = 0; t < soup.n; t++) {
        const a = t * 9, xs = [soup.P[a] - X0, soup.P[a + 3] - X0, soup.P[a + 6] - X0], zs = [soup.P[a + 2] - Z0, soup.P[a + 5] - Z0, soup.P[a + 8] - Z0];
        for (let k = 0; k < 3; k++) core[Math.min(H - 1, Math.floor(zs[k])) * W + Math.min(W - 1, Math.floor(xs[k]))] = 1;
        const det = (xs[1] - xs[0]) * (zs[2] - zs[0]) - (xs[2] - xs[0]) * (zs[1] - zs[0]);
        if (Math.abs(det) < 1e-9) continue;
        for (let z = Math.max(0, Math.floor(Math.min(...zs))); z <= Math.min(H - 1, Math.floor(Math.max(...zs))); z++)
            for (let x = Math.max(0, Math.floor(Math.min(...xs))); x <= Math.min(W - 1, Math.floor(Math.max(...xs))); x++) {
                const px = x + 0.5, pz = z + 0.5;
                const b1 = ((px - xs[0]) * (zs[2] - zs[0]) - (xs[2] - xs[0]) * (pz - zs[0])) / det, b2 = ((xs[1] - xs[0]) * (pz - zs[0]) - (px - xs[0]) * (zs[1] - zs[0])) / det;
                if (b1 >= 0 && b2 >= 0 && b1 + b2 <= 1) core[z * W + x] = 1;
            }
    }
    const plan = new Uint8Array(W * H), r = Math.ceil(g);
    for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
        if (!core[z * W + x]) continue;
        for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) { const zz = z + dz, xx = x + dx; if (zz >= 0 && xx >= 0 && zz < H && xx < W) plan[zz * W + xx] = 1; }
    }
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, out: number[] = [];
    const V = context.vertices, I = context.indices;
    for (let t = 0; t + 2 < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const mx = (V[a] + V[b] + V[c]) / 3, mz = (V[a + 2] + V[b + 2] + V[c + 2]) / 3;
        if (Math.hypot(mx - cx, mz - cz) > P.contextRadiusM) continue;
        const px = Math.floor(mx - X0), pz = Math.floor(mz - Z0);
        if (px >= 0 && pz >= 0 && px < W && pz < H && plan[pz * W + px]) continue;
        out.push(V[a], V[a + 1], V[a + 2], V[b], V[b + 1], V[b + 2], V[c], V[c + 1], V[c + 2]);
    }
    const all = new Float32Array(soup.P.length + out.length);
    all.set(soup.P); all.set(out, soup.P.length);
    return { P: all, n: soup.n + out.length / 9 };
}

function shadowMap(soup: Occluders, azDeg: number, elDeg: number, mpp: number): ShadowMap {
    const s = sunDir(azDeg, elDeg);
    // a horizontal axis across the sun, and the third one
    const r0 = [-s[2], 0, s[0]], rl = Math.hypot(r0[0], r0[2]) || 1;
    const r = [r0[0] / rl, 0, r0[2] / rl];
    const u = [s[1] * r[2] - s[2] * r[1], s[2] * r[0] - s[0] * r[2], s[0] * r[1] - s[1] * r[0]];
    const P = soup.P;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < P.length; i += 3) {
        const x = P[i] * r[0] + P[i + 1] * r[1] + P[i + 2] * r[2], y = P[i] * u[0] + P[i + 1] * u[1] + P[i + 2] * u[2];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const W = Math.ceil((x1 - x0) / mpp) + 3, H = Math.ceil((y1 - y0) / mpp) + 3, X0 = x0 - mpp, Y1 = y1 + mpp;
    const top = new Float32Array(W * H).fill(-Infinity);
    const sx = [0, 0, 0], sy = [0, 0, 0], st = [0, 0, 0];
    for (let t = 0; t < soup.n; t++) {
        const a = t * 9;
        for (let k = 0; k < 3; k++) {
            const px = P[a + k * 3], py = P[a + k * 3 + 1], pz = P[a + k * 3 + 2];
            sx[k] = (px * r[0] + py * r[1] + pz * r[2] - X0) / mpp;
            sy[k] = (Y1 - (px * u[0] + py * u[1] + pz * u[2])) / mpp;
            st[k] = px * s[0] + py * s[1] + pz * s[2];
        }
        const area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0]);
        const bx0 = Math.max(0, Math.floor(Math.min(sx[0], sx[1], sx[2]))), bx1 = Math.min(W - 1, Math.floor(Math.max(sx[0], sx[1], sx[2])));
        const by0 = Math.max(0, Math.floor(Math.min(sy[0], sy[1], sy[2]))), by1 = Math.min(H - 1, Math.floor(Math.max(sy[0], sy[1], sy[2])));
        if (Math.abs(area) < 1e-9) {
            // edge-on to the sun (a wall along the light): its highest corner over the pixels it crosses
            const tm = Math.max(st[0], st[1], st[2]);
            for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) if (tm > top[y * W + x]) top[y * W + x] = tm;
            continue;
        }
        const inv = 1 / area;
        for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
            const cx = x + 0.5, cy = y + 0.5;
            const w0 = ((sx[1] - cx) * (sy[2] - cy) - (sx[2] - cx) * (sy[1] - cy)) * inv;
            const w1 = ((sx[2] - cx) * (sy[0] - cy) - (sx[0] - cx) * (sy[2] - cy)) * inv;
            const w2 = 1 - w0 - w1;
            if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
            const tt = w0 * st[0] + w1 * st[1] + w2 * st[2], i = y * W + x;
            if (tt > top[i]) top[i] = tt;
        }
    }
    // a horizontal roof under one pixel spans mpp * cot(elevation) toward the sun
    return { s, r, u, X0, Y1, W, H, mpp, slope: mpp / Math.max(0.1, Math.tan(elDeg * DEG)), top };
}

/** 1 when something of the mesh stands between the point and the sun (nearest pixel). */
function shadowedAt(m: ShadowMap, x: number, y: number, z: number, biasM: number): boolean {
    const px = Math.floor((x * m.r[0] + y * m.r[1] + z * m.r[2] - m.X0) / m.mpp), py = Math.floor((m.Y1 - (x * m.u[0] + y * m.u[1] + z * m.u[2])) / m.mpp);
    if (px < 0 || py < 0 || px >= m.W || py >= m.H) return false;
    return m.top[py * m.W + px] > x * m.s[0] + y * m.s[1] + z * m.s[2] + biasM + m.slope;
}

/** The shadowed share of a point, from the four map pixels around it (a soft edge one pixel wide). */
function shadowFraction(m: ShadowMap, x: number, y: number, z: number, biasM: number): number {
    const fx = (x * m.r[0] + y * m.r[1] + z * m.r[2] - m.X0) / m.mpp - 0.5, fy = (m.Y1 - (x * m.u[0] + y * m.u[1] + z * m.u[2])) / m.mpp - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0, t = x * m.s[0] + y * m.s[1] + z * m.s[2] + biasM + m.slope;
    let f = 0;
    for (const [dx, dy, w] of [[0, 0, (1 - ax) * (1 - ay)], [1, 0, ax * (1 - ay)], [0, 1, (1 - ax) * ay], [1, 1, ax * ay]] as const) {
        const px = x0 + dx, py = y0 + dy;
        if (px < 0 || py < 0 || px >= m.W || py >= m.H) continue;
        if (m.top[py * m.W + px] > t) f += w;
    }
    return f;
}

/** Roof cells over all photos: photo, 3D point, log linear colour. */
interface Cells { n: number; img: Int32Array; p: Float32Array; c: Float32Array }

function roofCells(soup: Soup, photos: Map<number, RgbaImage8>, surfaces: Map<number, Uint8Array>, above: ShadowMap, P: RoofShadowParams): Cells {
    const G = P.cellTexels;
    const img: number[] = [], p: number[] = [], c: number[] = [];
    const taken = new Map<number, Set<number>>();
    for (let t = 0; t < soup.n; t++) {
        const im = soup.img[t];
        if (im < 0 || Math.abs(soup.N[t * 3 + 1]) < P.flatNy) continue;
        const photo = photos.get(im), mask = surfaces.get(im);
        if (!photo || !mask) continue;
        const W = photo.width, H = photo.height, gw = Math.ceil(W / G);
        let seen = taken.get(im);
        if (!seen) taken.set(im, (seen = new Set()));
        const a = t * 9, q = t * 6;
        const ax = (soup.UV[q] * W) / G, ay = (soup.UV[q + 1] * H) / G, bx = (soup.UV[q + 2] * W) / G, by = (soup.UV[q + 3] * H) / G, cx = (soup.UV[q + 4] * W) / G, cy = (soup.UV[q + 5] * H) / G;
        const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
        if (Math.abs(det) < 1e-12) continue;
        const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(gw - 1, Math.ceil(Math.max(ax, bx, cx)));
        const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(Math.ceil(H / G) - 1, Math.ceil(Math.max(ay, by, cy)));
        for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
            const px = gx + 0.5, py = gy + 0.5;
            const b1 = ((px - ax) * (cy - ay) - (cx - ax) * (py - ay)) / det, b2 = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) / det, b0 = 1 - b1 - b2;
            if (b0 < 0 || b1 < 0 || b2 < 0) continue;
            const key = gy * gw + gx;
            if (seen.has(key)) continue;
            const tx = Math.min(W - 1, Math.floor(px * G)), ty = Math.min(H - 1, Math.floor(py * G)), i = ty * W + tx;
            if (mask[i] === TEXEL_NONE) continue;
            const x = b0 * soup.P[a] + b1 * soup.P[a + 3] + b2 * soup.P[a + 6], y = b0 * soup.P[a + 1] + b1 * soup.P[a + 4] + b2 * soup.P[a + 7], z = b0 * soup.P[a + 2] + b1 * soup.P[a + 5] + b2 * soup.P[a + 8];
            if (shadowedAt(above, x, y, z, P.biasM)) continue;
            seen.add(key);
            img.push(im); p.push(x, y, z);
            for (let k = 0; k < 3; k++) c.push(Math.log(1e-4 + SRGB8_TO_LINEAR[photo.rgba[i * 4 + k]]));
        }
    }
    return { n: img.length, img: Int32Array.from(img), p: Float32Array.from(p), c: Float32Array.from(c) };
}

/** The planes: peaks of the cells' height histogram, each with the cells within planeTolM of it (each cell to its nearest peak). */
function planesOf(cells: Cells, P: RoofShadowParams): Array<{ y: number; idx: Int32Array }> {
    const bins = new Map<number, number>();
    for (let i = 0; i < cells.n; i++) { const b = Math.round(cells.p[i * 3 + 1] / P.planeBinM); bins.set(b, (bins.get(b) ?? 0) + 1); }
    const peaks: number[] = [];
    for (const [b, n] of bins) {
        const around = (bins.get(b - 1) ?? 0) + n + (bins.get(b + 1) ?? 0);
        if (around >= P.minPlaneCells && n >= (bins.get(b - 1) ?? 0) && n > (bins.get(b + 1) ?? 0)) peaks.push(b * P.planeBinM);
    }
    peaks.sort((a, b) => a - b);
    const members = peaks.map(() => [] as number[]);
    for (let i = 0; i < cells.n; i++) {
        const y = cells.p[i * 3 + 1];
        let best = -1, bd = P.planeTolM;
        peaks.forEach((py, k) => { const d = Math.abs(y - py); if (d <= bd) { bd = d; best = k; } });
        if (best >= 0) members[best].push(i);
    }
    return peaks.map((y, k) => ({ y, idx: Int32Array.from(members[k]) })).filter(pl => pl.idx.length >= P.minPlaneCells);
}

const lum = (c: Float32Array, i: number) => 0.2126 * c[i * 3] + 0.7152 * c[i * 3 + 1] + 0.0722 * c[i * 3 + 2];

/** A sun on a plane: the share in shadow, the lit-to-shadow luminance ratio, per channel, and each checkerboard half's. */
function planeScore(cells: Cells, idx: Int32Array, m: ShadowMap, P: RoofShadowParams): { share: number; ratio: number; rgb: [number, number, number]; halves: [number, number] } {
    const sum = [[0, 0, 0, 0], [0, 0, 0, 0]], n = [0, 0], hs = [[0, 0], [0, 0]], hn = [[0, 0], [0, 0]];
    for (const i of idx) {
        const sh = shadowedAt(m, cells.p[i * 3], cells.p[i * 3 + 1], cells.p[i * 3 + 2], P.biasM) ? 1 : 0;
        n[sh]++;
        for (let k = 0; k < 3; k++) sum[sh][k] += cells.c[i * 3 + k];
        const L = lum(cells.c, i);
        sum[sh][3] += L;
        const half = (Math.floor(cells.p[i * 3] / P.halfBlockM) + Math.floor(cells.p[i * 3 + 2] / P.halfBlockM)) & 1;
        hs[half][sh] += L; hn[half][sh]++;
    }
    const share = n[1] / Math.max(1, n[0] + n[1]);
    if (!n[0] || !n[1]) return { share, ratio: 0, rgb: [1, 1, 1], halves: [0, 0] };
    const step = (k: number) => Math.exp(sum[0][k] / n[0] - sum[1][k] / n[1]);
    const half = (h: number) => (hn[h][0] && hn[h][1] ? Math.exp(hs[h][0] / hn[h][0] - hs[h][1] / hn[h][1]) : 0);
    return { share, ratio: step(3), rgb: [step(0), step(1), step(2)], halves: [half(0), half(1)] };
}

/**
 * Fits a sun per roof deck and lifts the shadow the mesh casts on it (`photos` edited in place). `surfaces` is
 * texture-harmonize.ts surfaceClassMasks, read only to skip texels no triangle uses; roof is the map from above's.
 */
export async function roofShadowLift(g: ParsedGlb, json: any, photos: Map<number, RgbaImage8>, surfaces: Map<number, Uint8Array>, opts: { context?: { vertices: ArrayLike<number>; indices: ArrayLike<number> }; progress?: (message: string) => void; params?: Partial<RoofShadowParams> } = {}): Promise<RoofShadowReport> {
    const P = { ...ROOF_SHADOW_PARAMS, ...(opts.params ?? {}) };
    const t0 = Date.now();
    const soup = collect(g, json);
    const above = shadowMap(soup, 0, 89.9, P.aboveMapM);
    const occ = occludersOf(soup, opts.context, P);
    const cells = roofCells(soup, photos, surfaces, above, P);
    const planes = planesOf(cells, P);
    const report: RoofShadowReport = { applied: false, why: '', cells: cells.n, planes: planes.length, fitted: 0, texelsLifted: 0, photosChanged: 0, contextTriangles: occ.n - soup.n, photoRecords: [], terraces: { photos: 0, unconfirmed: 0, ownFit: 0, lifted: 0, liftedWhollyInShadow: 0, rejected: 0, lit: 0, components: 0, componentsLifted: 0, rejections: [] }, candidates: 0, ms: 0, records: [] };
    const done = (why: string) => { report.why = why; report.ms = Date.now() - t0; return report; };
    if (!planes.length) return done(`no roof deck has ${P.minPlaneCells} cells to fit a sun on (${cells.n} roof cells)`);

    // 3: coarse suns on every plane, then each plane's best refined
    type Cand = { az: number; el: number };
    type Scored = Cand & ReturnType<typeof planeScore>;
    const scored: Scored[][] = planes.map(() => []);
    const valid = (s: Scored) => s.share >= P.minShare && s.share <= P.maxShare && s.ratio > 0;
    // every roof cell's shadow under each coarse sun, kept for the photos fitted on their own terraces
    const coarseBits: Array<{ cand: Cand; bits: Uint8Array }> = [];
    const evaluate = async (cand: Cand, which: number[], keep = false) => {
        const m = shadowMap(occ, cand.az, cand.el, P.coarseMapM);
        report.candidates++;
        for (const k of which) scored[k].push({ ...cand, ...planeScore(cells, planes[k].idx, m, P) });
        if (keep) {
            const bits = new Uint8Array(cells.n);
            for (let i = 0; i < cells.n; i++) bits[i] = shadowedAt(m, cells.p[i * 3], cells.p[i * 3 + 1], cells.p[i * 3 + 2], P.biasM) ? 1 : 0;
            coarseBits.push({ cand, bits });
        }
        await new Promise(r => setImmediate(r));
    };
    const all = planes.map((_, k) => k);
    const coarse: Cand[] = [];
    for (const el of P.coarseElDeg) for (let az = 0; az < 360; az += P.coarseAzDeg) coarse.push({ az, el });
    opts.progress?.(`roof shadows: scoring ${coarse.length} candidate suns on ${planes.length} roof decks (${cells.n} roof cells)`);
    for (const cand of coarse) await evaluate(cand, all, true);
    const medians = scored.map(list => { const r = list.filter(valid).map(s => s.ratio).sort((a, b) => a - b); return r.length ? r[Math.floor(r.length / 2)] : 0; });
    for (let k = 0; k < planes.length; k++) {
        const v = scored[k].filter(valid);
        if (!v.length) continue;
        const best = v.reduce((a, b) => (b.ratio > a.ratio ? b : a));
        for (let da = -P.refineSteps; da <= P.refineSteps; da++) for (let de = -P.refineSteps; de <= P.refineSteps; de++) {
            const el = best.el + de * P.refineDeg;
            if ((da || de) && el >= 5 && el <= 85) await evaluate({ az: (best.az + da * P.refineDeg + 360) % 360, el }, [k]);
        }
    }

    // 4: acceptance per plane
    const accepted: Array<{ k: number; best: Scored }> = [];
    planes.forEach((pl, k) => {
        const rec: RoofShadowPlane = { y: +pl.y.toFixed(2), cells: pl.idx.length, accepted: false, why: '', texelsLifted: 0 };
        report.records.push(rec);
        const v = scored[k].filter(valid);
        if (!v.length) { rec.why = `no sun puts between ${Math.round(100 * P.minShare)} and ${Math.round(100 * P.maxShare)} percent of the deck in the mesh's shadow`; return; }
        const best = v.reduce((a, b) => (b.ratio > a.ratio ? b : a));
        Object.assign(rec, { sunAzDeg: best.az, sunElDeg: best.el, shadowShare: +best.share.toFixed(3), ratio: +best.ratio.toFixed(3), medianRatio: +medians[k].toFixed(3), rgb: best.rgb.map(x => +x.toFixed(3)), halves: best.halves.map(x => +x.toFixed(3)) });
        if (best.ratio < P.minRatio || best.ratio > P.maxRatio) rec.why = `the deck's lit part is ${best.ratio.toFixed(2)}x its shadowed part under the best sun, not a shadow's (${P.minRatio}..${P.maxRatio})`;
        else if (best.ratio < P.overMedian * medians[k]) rec.why = `the best sun (${best.ratio.toFixed(2)}x) is not clearly better than the deck's median candidate (${medians[k].toFixed(2)}x): its materials, not a shadow, split it`;
        else if (Math.max(...best.rgb) > P.maxChannelSpread * Math.min(...best.rgb)) rec.why = `the step is a colour change, not a shadow's (lit/shadow ${best.rgb.map(x => x.toFixed(2)).join(' / ')} R/G/B): two materials split the deck`;
        else if (Math.min(...best.halves) < P.minHalfRatio) rec.why = `the two halves of the deck disagree (${best.halves.map(x => x.toFixed(2)).join(' and ')})`;
        else {
            rec.accepted = true;
            rec.why = `sun at azimuth ${best.az} deg, elevation ${best.el} deg: ${Math.round(100 * best.share)} percent of the deck in the mesh's shadow, lit ${best.ratio.toFixed(2)}x the shadow (median candidate ${medians[k].toFixed(2)}x), halves ${best.halves.map(x => x.toFixed(2)).join(' and ')}`;
            accepted.push({ k, best });
        }
    });
    report.fitted = accepted.length;
    // no deck matched: photos may still be fitted on their own terraces below

    // 5: each photo's sun, from the accepted deck it shows most of; then every terrace of that photo checked against it
    const photoSun = new Map<number, { k: number; best: Scored; ratio: number[] }>();
    const countBy = new Map<number, Map<number, number>>();
    for (const { k } of accepted) for (const i of planes[k].idx) {
        const im = cells.img[i];
        let m = countBy.get(im); if (!m) countBy.set(im, (m = new Map()));
        m.set(k, (m.get(k) ?? 0) + 1);
    }
    const coarseMaps = new Map<string, ShadowMap>();
    const mapOf = (b: Scored, mpp: number, cache: Map<string, ShadowMap>) => { const key = `${b.az},${b.el}`; let m = cache.get(key); if (!m) cache.set(key, (m = shadowMap(occ, b.az, b.el, mpp))); return m; };
    for (const [im, m] of countBy) {
        const [k, n] = [...m].reduce((a, b) => (b[1] > a[1] ? b : a));
        if (n < P.minPhotoCells) continue;
        const best = accepted.find(a => a.k === k)!.best, sm = mapOf(best, P.coarseMapM, coarseMaps);
        // the photo's own cells on the deck must show the deck's shadow
        let ns = 0, nl = 0, ls = 0, ll = 0;
        for (const i of planes[k].idx) {
            if (cells.img[i] !== im) continue;
            if (shadowedAt(sm, cells.p[i * 3], cells.p[i * 3 + 1], cells.p[i * 3 + 2], P.biasM)) { ns++; ls += lum(cells.c, i); } else { nl++; ll += lum(cells.c, i); }
        }
        if (ns < P.minTerraceSide || nl < P.minTerraceSide || Math.exp(ll / nl - ls / ns) < P.minTerraceRatio) { report.terraces.unconfirmed++; continue; }
        photoSun.set(im, { k, best, ratio: best.rgb.map(x => Math.min(P.maxRatio, Math.max(1, x))) });
    }
    // photos no deck's sun was confirmed in: fitted on their own terraces
    const ownFitWhy = new Map<number, string>();
    const byPhoto = new Map<number, number[]>();
    for (let i = 0; i < cells.n; i++) if (!photoSun.has(cells.img[i])) { const l = byPhoto.get(cells.img[i]); if (l) l.push(i); else byPhoto.set(cells.img[i], [i]); }
    for (const [im, list] of byPhoto) {
        if (list.length < P.minPhotoFitCells) { ownFitWhy.set(im, `${list.length} roof cells (${P.minPhotoFitCells} needed)`); continue; }
        const groups = new Map<number, number[]>();
        for (const i of list) { const b = Math.round(cells.p[i * 3 + 1] / P.terraceBinM); const l = groups.get(b); if (l) l.push(i); else groups.set(b, [i]); }
        const terraces = [...groups.values()].filter(g => g.length >= 2 * P.minTerraceSide);
        if (!terraces.length) { ownFitWhy.set(im, `no terrace of ${2 * P.minTerraceSide} cells`); continue; }
        let best: { cand: Cand; score: number; rgb: number[]; agree: number; split: number; halves: number[] } | undefined;
        const scores: number[] = [];
        for (const { cand, bits } of coarseBits) {
            let wsum = 0, ssum = 0, agree = 0, split = 0;
            const rgbSum = [0, 0, 0], hs = [[0, 0], [0, 0]], hn = [[0, 0], [0, 0]];
            for (const g of terraces) {
                let ns = 0, nl = 0;
                const sum = [[0, 0, 0, 0], [0, 0, 0, 0]];
                for (const i of g) {
                    const sh = bits[i];
                    if (sh) ns++; else nl++;
                    for (let q = 0; q < 3; q++) sum[sh][q] += cells.c[i * 3 + q];
                    const L = lum(cells.c, i);
                    sum[sh][3] += L;
                    const half = (Math.floor(cells.p[i * 3] / P.halfBlockM) + Math.floor(cells.p[i * 3 + 2] / P.halfBlockM)) & 1;
                    hs[half][sh] += L; hn[half][sh]++;
                }
                if (ns < P.minTerraceSide || nl < P.minTerraceSide) continue;
                const d = sum[0][3] / nl - sum[1][3] / ns, w = Math.min(ns, nl);
                split++; if (Math.exp(d) >= P.minTerraceRatio) agree++;
                wsum += w; ssum += w * d;
                for (let q = 0; q < 3; q++) rgbSum[q] += w * (sum[0][q] / nl - sum[1][q] / ns);
            }
            if (!split) continue;
            const score = ssum / wsum;
            scores.push(score);
            if (!best || score > best.score) {
                const half = (h: number) => (hn[h][0] && hn[h][1] ? Math.exp(hs[h][0] / hn[h][0] - hs[h][1] / hn[h][1]) : 0);
                best = { cand, score, rgb: rgbSum.map(x => Math.exp(x / wsum)), agree, split, halves: [half(0), half(1)] };
            }
        }
        if (!best) { ownFitWhy.set(im, 'no sun splits a terrace'); continue; }
        scores.sort((a, b) => a - b);
        const ratio = Math.exp(best.score), median = Math.exp(scores[Math.floor(scores.length / 2)]);
        const ok = ratio >= P.minRatio && ratio <= P.maxRatio && ratio >= P.overMedian * median
            && Math.max(...best.rgb) <= P.maxChannelSpread * Math.min(...best.rgb)
            && (best.split >= 2 ? best.agree / best.split >= P.minAgreeShare : Math.min(...best.halves) >= P.minHalfRatio);
        if (!ok) { ownFitWhy.set(im, `best az ${best.cand.az} el ${best.cand.el}: ${ratio.toFixed(2)}x (median ${median.toFixed(2)}x), R/G/B ${best.rgb.map(x => x.toFixed(2)).join('/')}, ${best.agree} of ${best.split} terraces agree, halves ${best.halves.map(x => x.toFixed(2)).join('/')}`); continue; }
        const sc: Scored = { az: best.cand.az, el: best.cand.el, share: 0, ratio, rgb: best.rgb as [number, number, number], halves: best.halves as [number, number] };
        photoSun.set(im, { k: -1, best: sc, ratio: best.rgb.map(x => Math.min(P.maxRatio, Math.max(1, x))) });
        report.terraces.ownFit++;
    }
    report.terraces.photos = photoSun.size;
    // terraces: per photo with a sun, its roof cells by height bin
    const terr = new Map<string, number[]>();
    for (let i = 0; i < cells.n; i++) {
        if (!photoSun.has(cells.img[i])) continue;
        const key = `${cells.img[i]}:${Math.round(cells.p[i * 3 + 1] / P.terraceBinM)}`;
        const l = terr.get(key); if (l) l.push(i); else terr.set(key, [i]);
    }
    const liftTerrace = new Set<string>();
    /** A lifted terrace's lit level (mean log luminance of its lit cells), by its key or, for one wholly in shadow, its sun. */
    const litLevel = new Map<string, number>();
    const outcome = new Map<string, 'lifted' | 'lifted-whole' | 'rejected' | 'lit' | 'small'>();
    for (const [key, idx] of terr) {
        if (idx.length < P.minTerraceCells) { outcome.set(key, 'small'); continue; }
        const im = Number(key.split(':')[0]), sun = photoSun.get(im)!, m = mapOf(sun.best, P.coarseMapM, coarseMaps);
        let ns = 0, nl = 0;
        const sum = [[0, 0, 0, 0], [0, 0, 0, 0]];
        for (const i of idx) {
            const sh = shadowedAt(m, cells.p[i * 3], cells.p[i * 3 + 1], cells.p[i * 3 + 2], P.biasM) ? 1 : 0;
            if (sh) ns++; else nl++;
            for (let q = 0; q < 3; q++) sum[sh][q] += cells.c[i * 3 + q];
            sum[sh][3] += lum(cells.c, i);
        }
        if (!ns) { report.terraces.lit++; outcome.set(key, 'lit'); continue; }
        const y = +(Number(key.split(':')[1]) * P.terraceBinM).toFixed(1);
        if (nl < P.minTerraceSide || ns < P.minTerraceSide) {
            if (nl < P.minTerraceSide) { liftTerrace.add(key); report.terraces.lifted++; report.terraces.liftedWhollyInShadow++; outcome.set(key, 'lifted-whole'); }
            else { report.terraces.lit++; outcome.set(key, 'lit'); }
            continue;
        }
        const step = (q: number) => Math.exp(sum[0][q] / nl - sum[1][q] / ns);
        const r = step(3), rgb = [step(0), step(1), step(2)];
        let why = '';
        if (r < P.minTerraceRatio) why = `its part in the sun's shadow is not darker (${r.toFixed(2)}x)`;
        else if (Math.max(...rgb) > P.maxChannelSpread * Math.min(...rgb)) why = `the step is a colour change (${rgb.map(x => x.toFixed(2)).join(' / ')} R/G/B)`;
        if (why) { report.terraces.rejected++; report.terraces.rejections.push({ img: im, y, cells: idx.length, why }); outcome.set(key, 'rejected'); continue; }
        liftTerrace.add(key); report.terraces.lifted++; outcome.set(key, 'lifted');
        litLevel.set(key, sum[0][3] / nl);
    }
    report.terraces.rejections = report.terraces.rejections.slice(0, 40);
    // the record per photo: its sun and its terraces (a photo with no sun lists its terraces' heights only)
    const perPhoto = new Map<number, Map<number, number>>();
    for (let i = 0; i < cells.n; i++) {
        const im = cells.img[i], b = Math.round(cells.p[i * 3 + 1] / P.terraceBinM);
        let m = perPhoto.get(im); if (!m) perPhoto.set(im, (m = new Map()));
        m.set(b, (m.get(b) ?? 0) + 1);
    }
    for (const [im, m] of perPhoto) {
        const sun = photoSun.get(im);
        report.photoRecords.push({
            img: im, cells: [...m.values()].reduce((a, b) => a + b, 0),
            ...(sun ? { sun: { from: sun.k >= 0 ? 'deck' as const : 'own' as const, azDeg: sun.best.az, elDeg: sun.best.el } } : {}),
            ...(ownFitWhy.has(im) ? { ownFit: ownFitWhy.get(im)! } : {}),
            terraces: [...m].filter(([, n]) => n >= P.minTerraceCells).sort((a, b) => a[0] - b[0]).map(([b, n]) => ({ y: +(b * P.terraceBinM).toFixed(1), cells: n, outcome: outcome.get(`${im}:${b}`) ?? (sun ? 'lit' : 'no-sun') }))
        });
    }
    // 6: terraces as surfaces across photos, for the fragments of photos with no sun
    const known = new Map<string, Scored>();
    for (const v of photoSun.values()) known.set(`${v.best.az},${v.best.el}`, v.best);
    const gridKey = (x: number, y: number, z: number) => `${Math.round(y / P.terraceBinM)}:${Math.floor(x / P.componentGridM)}:${Math.floor(z / P.componentGridM)}`;
    const parent = new Map<string, string>();
    const find = (k: string): string => { let r = k; while (parent.get(r) !== r) r = parent.get(r)!; let c = k; while (c !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; } return r; };
    const gridOf = new Int32Array(cells.n);
    const keys: string[] = [];
    const keyIndex = new Map<string, number>();
    for (let i = 0; i < cells.n; i++) {
        const k = gridKey(cells.p[i * 3], cells.p[i * 3 + 1], cells.p[i * 3 + 2]);
        let j = keyIndex.get(k);
        if (j === undefined) { j = keys.length; keys.push(k); keyIndex.set(k, j); parent.set(k, k); }
        gridOf[i] = j;
    }
    for (const k of keys) {
        const [b, gx, gz] = k.split(':').map(Number);
        for (const [dx, dz] of [[1, 0], [0, 1]]) { const n = `${b}:${gx + dx}:${gz + dz}`; if (parent.has(n)) { const ra = find(k), rb = find(n); if (ra !== rb) parent.set(ra, rb); } }
    }
    const comps = new Map<string, number[]>();
    for (let i = 0; i < cells.n; i++) { const r = find(keys[gridOf[i]]); const l = comps.get(r); if (l) l.push(i); else comps.set(r, [i]); }
    const compSun = new Map<string, { best: Scored; ratio: number[]; lit: number }>();
    if (known.size) for (const [root, idx] of comps) {
        if (idx.filter(i => !photoSun.has(cells.img[i])).length < P.minComponentNoSun) continue;
        report.terraces.components++;
        const tried: Array<{ sun: Scored; ratio: number; rgb: number[]; halves: number[]; lit: number }> = [];
        for (const sun of known.values()) {
            const m = mapOf(sun, P.coarseMapM, coarseMaps);
            let ns = 0, nl = 0;
            const sum = [[0, 0, 0, 0], [0, 0, 0, 0]], hs = [[0, 0], [0, 0]], hn = [[0, 0], [0, 0]];
            for (const i of idx) {
                const sh = shadowedAt(m, cells.p[i * 3], cells.p[i * 3 + 1], cells.p[i * 3 + 2], P.biasM) ? 1 : 0;
                if (sh) ns++; else nl++;
                for (let q = 0; q < 3; q++) sum[sh][q] += cells.c[i * 3 + q];
                const L = lum(cells.c, i);
                sum[sh][3] += L;
                const half = (Math.floor(cells.p[i * 3] / P.halfBlockM) + Math.floor(cells.p[i * 3 + 2] / P.halfBlockM)) & 1;
                hs[half][sh] += L; hn[half][sh]++;
            }
            if (ns < P.minTerraceSide || nl < P.minTerraceSide) continue;
            const step = (q: number) => Math.exp(sum[0][q] / nl - sum[1][q] / ns);
            const half = (h: number) => (hn[h][0] && hn[h][1] ? Math.exp(hs[h][0] / hn[h][0] - hs[h][1] / hn[h][1]) : 0);
            tried.push({ sun, ratio: step(3), rgb: [step(0), step(1), step(2)], halves: [half(0), half(1)], lit: sum[0][3] / nl });
        }
        if (!tried.length) continue;
        const best = tried.reduce((a, b) => (b.ratio > a.ratio ? b : a));
        const others = tried.filter(t => t !== best).map(t => t.ratio).sort((a, b) => a - b);
        const median = others.length ? others[Math.floor(others.length / 2)] : 0;
        // a half the checkerboard leaves empty (a narrow strip) does not count against the terrace
        const halves = best.halves.filter(h => h > 0);
        const ok = best.ratio >= P.minRatio && best.ratio <= P.maxRatio && Math.max(...best.rgb) <= P.maxChannelSpread * Math.min(...best.rgb)
            && (!halves.length || Math.min(...halves) >= P.minHalfRatio) && (others.length < 2 || best.ratio >= P.overMedian * median);
        if (!ok) continue;
        compSun.set(root, { best: best.sun, ratio: best.rgb.map(x => Math.min(P.maxRatio, Math.max(1, x))), lit: best.lit });
        report.terraces.componentsLifted++;
    }
    const compOfKey = (x: number, y: number, z: number): { best: Scored; ratio: number[]; lit: number } | undefined => {
        const k = gridKey(x, y, z);
        return parent.has(k) ? compSun.get(find(k)) : undefined;
    };
    for (const rec of report.photoRecords) if (!rec.sun) {
        for (const t of rec.terraces) if (t.outcome === 'no-sun') {
            const i = (() => { for (let j = 0; j < cells.n; j++) if (cells.img[j] === rec.img && Math.round(cells.p[j * 3 + 1] / P.terraceBinM) === Math.round(t.y / P.terraceBinM)) return j; return -1; })();
            if (i >= 0 && compSun.has(find(keys[gridOf[i]]))) (t as { outcome: string }).outcome = 'terrace';
        }
    }
    if (!liftTerrace.size && !compSun.size) return done(`${accepted.length} of ${planes.length} decks matched a sun and ${report.terraces.ownFit} photos were fitted on their own terraces, but no terrace passed its check`);

    // the lit level under each sun, for terraces wholly in its shadow: all cells of the photos with that sun, lit under it
    const sunLit = new Map<string, number>();
    {
        const acc = new Map<string, [number, number]>();
        for (let i = 0; i < cells.n; i++) {
            const sun = photoSun.get(cells.img[i]);
            if (!sun) continue;
            const key = `${sun.best.az},${sun.best.el}`;
            if (shadowedAt(mapOf(sun.best, P.coarseMapM, coarseMaps), cells.p[i * 3], cells.p[i * 3 + 1], cells.p[i * 3 + 2], P.biasM)) continue;
            const e = acc.get(key) ?? [0, 0]; e[0] += lum(cells.c, i); e[1]++; acc.set(key, e);
        }
        for (const [k, [sum, n]] of acc) if (n) sunLit.set(k, sum / n);
    }

    // 7: the lift, one sun at a time
    const bySun = new Map<string, Scored>();
    for (const v of photoSun.values()) bySun.set(`${v.best.az},${v.best.el}`, v.best);
    for (const v of compSun.values()) bySun.set(`${v.best.az},${v.best.el}`, v.best);
    opts.progress?.(`roof shadows: lifting the cast shadow on ${liftTerrace.size} photo terraces and ${compSun.size} terraces across photos, under ${bySun.size} suns`);
    const changed = new Map<number, Uint8Array>();
    const planeLifted = new Map<number, number>();
    for (const [sunKey, sunScored] of bySun) {
        const m = shadowMap(occ, sunScored.az, sunScored.el, P.fineMapM);
        for (let t = 0; t < soup.n; t++) {
            const im = soup.img[t];
            if (im < 0 || Math.abs(soup.N[t * 3 + 1]) < P.flatNy) continue;
            const sun = photoSun.get(im);
            if (sun ? `${sun.best.az},${sun.best.el}` !== sunKey : !compSun.size) continue;
            const photo = photos.get(im), mask = surfaces.get(im);
            if (!photo || !mask) continue;
            const a = t * 9, q = t * 6, W = photo.width, H = photo.height;
            const ax = soup.UV[q] * W, ay = soup.UV[q + 1] * H, bx = soup.UV[q + 2] * W, by = soup.UV[q + 3] * H, cx = soup.UV[q + 4] * W, cy = soup.UV[q + 5] * H;
            const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
            if (Math.abs(det) < 1e-12) continue;
            let out = changed.get(im);
            const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
            const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
            for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                const i = y * W + x;
                if (mask[i] === TEXEL_NONE) continue;
                const px = x + 0.5, py = y + 0.5;
                const b1 = ((px - ax) * (cy - ay) - (cx - ax) * (py - ay)) / det, b2 = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) / det, b0 = 1 - b1 - b2;
                if (b0 < 0 || b1 < 0 || b2 < 0) continue;
                const wx = b0 * soup.P[a] + b1 * soup.P[a + 3] + b2 * soup.P[a + 6], wy = b0 * soup.P[a + 1] + b1 * soup.P[a + 4] + b2 * soup.P[a + 7], wz = b0 * soup.P[a + 2] + b1 * soup.P[a + 5] + b2 * soup.P[a + 8];
                let ratio: number[], lit: number | undefined;
                if (sun) {
                    const key = `${im}:${Math.round(wy / P.terraceBinM)}`;
                    if (!liftTerrace.has(key)) continue;
                    ratio = sun.ratio; lit = litLevel.get(key) ?? sunLit.get(sunKey);
                } else {
                    const cs = compOfKey(wx, wy, wz);
                    if (!cs || `${cs.best.az},${cs.best.el}` !== sunKey) continue;
                    ratio = cs.ratio; lit = cs.lit;
                }
                if (shadowedAt(above, wx, wy, wz, P.biasM)) continue;
                let f = shadowFraction(m, wx, wy, wz, P.biasM);
                if (f <= 0) continue;
                // never above the terrace's lit level: the share of the lift this texel's own darkness asks for
                if (lit !== undefined) {
                    const L = 0.2126 * Math.log(1e-4 + SRGB8_TO_LINEAR[photo.rgba[i * 4]]) + 0.7152 * Math.log(1e-4 + SRGB8_TO_LINEAR[photo.rgba[i * 4 + 1]]) + 0.0722 * Math.log(1e-4 + SRGB8_TO_LINEAR[photo.rgba[i * 4 + 2]]);
                    const full = f * Math.log(0.2126 * ratio[0] + 0.7152 * ratio[1] + 0.0722 * ratio[2]);
                    if (full > 0) f *= Math.max(0, Math.min(1, (lit - L) / full));
                    if (f <= 0.01) continue;
                }
                if (!out) changed.set(im, (out = Uint8Array.from(photo.rgba)));
                report.texelsLifted++;
                if (sun && sun.k >= 0) planeLifted.set(sun.k, (planeLifted.get(sun.k) ?? 0) + 1);
                for (let k2 = 0; k2 < 3; k2++) out[i * 4 + k2] = Math.round(linearToSrgb255(SRGB8_TO_LINEAR[photo.rgba[i * 4 + k2]] * Math.pow(ratio[k2], f)));
            }
            if ((t & 0xffff) === 0) await new Promise(r => setImmediate(r));
        }
    }
    for (const [k, n] of planeLifted) report.records[k].texelsLifted = n;

    // the audit from above: each roof cell's class on a grid (the worse class wins a pixel: no sun, rejected, lifted, lit)
    {
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
        for (let i = 0; i < cells.n; i++) { x0 = Math.min(x0, cells.p[i * 3]); x1 = Math.max(x1, cells.p[i * 3]); z0 = Math.min(z0, cells.p[i * 3 + 2]); z1 = Math.max(z1, cells.p[i * 3 + 2]); }
        const c = P.auditCellM, w = Math.max(1, Math.ceil((x1 - x0) / c) + 1), h = Math.max(1, Math.ceil((z1 - z0) / c) + 1);
        const classes = new Uint8Array(w * h);
        for (let i = 0; i < cells.n; i++) {
            const im = cells.img[i], x = cells.p[i * 3], y = cells.p[i * 3 + 1], z = cells.p[i * 3 + 2];
            const sun = photoSun.get(im);
            let cls = AUDIT_LIT;
            if (sun) {
                const key = `${im}:${Math.round(y / P.terraceBinM)}`, o = outcome.get(key);
                const shaded = shadowedAt(mapOf(sun.best, P.coarseMapM, coarseMaps), x, y, z, P.biasM);
                cls = !shaded ? AUDIT_LIT : liftTerrace.has(key) ? AUDIT_LIFTED : o === 'rejected' ? AUDIT_REJECTED : AUDIT_LIT;
            } else {
                const cs = compOfKey(x, y, z);
                cls = !cs ? AUDIT_NO_SUN : shadowedAt(mapOf(cs.best, P.coarseMapM, coarseMaps), x, y, z, P.biasM) ? AUDIT_LIFTED : AUDIT_LIT;
            }
            const g = Math.floor((z - z0) / c) * w + Math.floor((x - x0) / c);
            if (cls > classes[g]) classes[g] = cls;
        }
        const area = [0, 0, 0, 0, 0];
        for (let g = 0; g < w * h; g++) area[classes[g]] += c * c;
        report.audit = { lifted: Math.round(area[AUDIT_LIFTED]), rejected: Math.round(area[AUDIT_REJECTED]), noSun: Math.round(area[AUDIT_NO_SUN]), lit: Math.round(area[AUDIT_LIT]) };
        report.auditGrid = { cellM: c, x0, z0, w, h, classes };
    }
    for (const [im, rgba] of changed) { const ph = photos.get(im)!; photos.set(im, { width: ph.width, height: ph.height, rgba }); }
    report.photosChanged = changed.size;
    report.applied = report.texelsLifted > 0;
    const T = report.terraces;
    return done(`${accepted.length} of ${planes.length} roof decks matched a sun (${accepted.map(a => `${planes[a.k].y.toFixed(1)} m: az ${a.best.az} el ${a.best.el}, ${a.best.ratio.toFixed(2)}x`).join('; ')}); `
        + `from above: ${report.audit!.lifted} m2 lifted, ${report.audit!.rejected} m2 in shadow but rejected, ${report.audit!.noSun} m2 with no sun, ${report.audit!.lit} m2 lit; `
        + `suns in ${T.photos} photos (${T.photos - T.ownFit} from a deck, ${T.ownFit} fitted on their own terraces; ${T.unconfirmed} did not confirm a deck's), whose terraces were checked: ${T.lifted} lifted (${T.liftedWhollyInShadow} wholly in shadow), ${T.rejected} rejected, ${T.lit} lit; ${T.componentsLifted} of ${T.components} terraces across photos fitted for the rest; ${report.texelsLifted} texels lifted in ${changed.size} photos`);
}
