/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's street band (opt-in): the lowest storeys of every rebuilt facade (facade-lattice.ts's FacadeLattice_<id>
 * nodes in the twin) textured from registered Street View photos, at a finer texel than the tile photo's.
 *
 * From the air the tile photo is about 15 cm a texel and, at street level, grazing, occluded (vehicles, sheds, trees) and
 * smeared; a Street View photo sees that band at 1-3 cm. So:
 *
 *  1. The band: each lattice primitive is cut at bandTopM above the structure's foot (triangles split exactly on that
 *     height, every attribute interpolated). The part below becomes a primitive of its own whose material is the facade's
 *     with every map cropped to the band's rectangle of the photo's UVs (the same frame the lattice uses), the base colour
 *     enlarged by an integer factor to about pixelM a texel; its UVs are the lattice's, mapped into that rectangle. The part
 *     above keeps the facade's own material and maps.
 *  2. Each band texel's point and normal on the built mesh, rasterised from its triangles in UV space; each photo projected
 *     there through its registered pose and warp (refined poses only: 'edges' or 'joint' within maxResidualM). A texel is
 *     taken from a photo only where the photo truly sees it: the pixel is the structure's (the ownership mask: nothing in
 *     front), the built mesh with its context is the nearest surface there (depthToleranceM), the incidence is within
 *     maxIncidenceDeg and the photo resolves it at least minSharper times finer than the tile photo. The photo must also
 *     show this facade: its band-passed structure against the tile photo's (pipeline E's structuralAgreement, at the best
 *     shift within a metre, which is applied); a pose that projects another bay, the sky or a neighbour fails and gives
 *     nothing. Capture dates are never a reason to refuse: an older or newer photo is stitched in and its date labelled.
 *  3. The photos blend per texel by weight: incidence (cos^2), resolution, distance and recency (half every
 *     recencyHalfLifeYears behind the newest), sharpened by `sharpen` so the best photo leads and a slightly misregistered
 *     second one does not blur it; each eroded at its mask's edge and feathered. Exposure is matched to the tile photo (the
 *     median linear ratio per channel), then the low frequencies are matched to the tile photo near the band's top (over
 *     seamM, fading downward) and the photo faded into the tile over topFeatherM, so there is no seam with the facade above.
 *  4. Where no photo sees a texel clear, a photo's obstruction-free copy (streetview-clean.ts: people and vehicles in front
 *     of the structure filled by the image model) may give it (labelled generated); else it keeps the tile photo, enlarged.
 *
 * Labels: each band primitive's node extras carry sbStreetBand (the panos used with their capture dates and texels, the
 * refusals and why, the shares) and a source texture per texel (R = index + 1 into panos, 0 the tile photo; G = 1 one
 * photo, 2 two photos that agree, 3 an obstruction-free copy (generated); B = the blend weight). Texels from a photo are
 * photo-inferred; the twin's provenance gains one entry.
 *
 * Kept: only the projected texels (the photo layer in the band's frame, never a Street View image) in the model readings
 * store (`street-band/<sha256>` over the band's geometry, its factor, the panos near and the parameters), so a rebuild
 * whose band and panos are unchanged reads them back without asking for any image; the place store carries them with the
 * other readings.
 */

import * as crypto from 'crypto';
import type { RenderMesh3D } from '../../../spatial/HeadlessMeshSilhouetteRenderer';
import { renderFrameDepth } from '../../../spatial/StreetViewPoseRegistrar';
import { SRGB8_TO_LINEAR } from '../../../../common/spatial/photogrammetric-delight';
import { assembleGlb, parseGlbBytes, readAccessor } from '../glb-bytes';
import { encodePng } from '../png-encode';
import { decodeImageInMemory, type RgbaImage8 } from '../tile-texture-transfer';
import { linearToSrgb8, project } from '../pipeline-e/colour-transfer';
import { warpAt, type GuideView } from '../pipeline-e/plate-streetview';
import { erode, exposureGain, insideDistance, structuralAgreement, MAX_SHIFT_M, MIN_AGREEMENT_NCC } from '../pipeline-e/street-view-texels';
import { readingKey, type ModelReadingStore } from './model-readings';

export const STREET_BAND_VERSION = 'street-band/1';

export const STREET_BAND_PARAMS = {
    /** The band: from the structure's foot up to this height (m). */
    bandTopM: 12,
    /** The band's base colour texel, about (m): the tile photo's texel divided by an integer factor. */
    pixelM: 0.025,
    /** That factor at most, and the band image's side and texels at most (the viewer's texture limit, memory). */
    maxFactor: 8, maxSidePx: 8192, maxTexels: 8192 * 1024,
    /** Refined poses only: registered against the tile mesh ('edges' or 'joint') to at most this residual (m). */
    maxResidualM: 0.6,
    /** Beyond this incidence (degrees from the surface's normal) a photo smears over it and is not taken. */
    maxIncidenceDeg: 70,
    /** The photo must resolve the surface at least this many times finer than the tile photo. */
    minSharper: 1.5,
    /** The built mesh (with its context) must be the nearest surface at the pixel within this (m). */
    depthToleranceM: 0.5,
    /** A photo's region eroded by this at its mask's edge and feathered over this into the others (m). */
    erodeM: 0.08, featherM: 0.3,
    /** The resolution weight saturates at this many photo pixels a metre; the distance weight halves at this distance (m). */
    targetPxPerM: 80, distanceM: 25,
    /** The recency weight halves every this many years behind the newest photo; a photo without a date counts as this old. */
    recencyHalfLifeYears: 4, undatedYears: 4,
    /** The weights of the photos at a texel raised to this before they blend (the best photo leads). */
    sharpen: 4,
    /** Two photos agree on a texel within this CIE76 distance, about (the two-photo label). */
    agreeDeltaE: 15,
    /** The low frequencies matched to the tile photo near the band's top: over this height, fading downward (m), at this blur (m). */
    seamM: 3, seamBlurM: 1,
    /** The photo faded into the tile photo over this height below the band's top (m). */
    topFeatherM: 0.5,
    /** A photo that qualifies on fewer texels than this gives none to the band (a few texels are not a texture). */
    minTexels: 400,
    /** Texels no photo sees clear may come from a photo's obstruction-free copy (generated). */
    cleanFill: true
};

export type StreetBandParams = typeof STREET_BAND_PARAMS;

/** The time a build's budget grows by when the street band is on: the survey (discovery, images, registration, masks, clean) and the projection. */
export const STREET_BAND_EXTRA_MS = 10 * 60_000;

/** Whether a build asks for the street band: the node graph's switch when set, else SCRATCHBOX_K_STREET_BAND=1. */
export function streetBandAsked(steps: Record<string, unknown> | undefined): boolean {
    const asked = steps?.['twin.streetBand'];
    return typeof asked === 'boolean' ? asked : process.env.SCRATCHBOX_K_STREET_BAND?.trim() === '1';
}

/** A view the band reads: a registered Street View photo in memory (streetview-registered-views.ts RegisteredView). */
export type StreetBandView = GuideView & { registration?: { method: string; residualM: number | null } };

export interface StreetBandPano { panoId: string; date?: string; method: string; residualM: number | null; texels: number; agreement: number; shiftPx: [number, number]; gain: [number, number, number] | null; pxPerM: number }

export interface StreetBandFacade {
    facadeId: number; node: string; primitive: number;
    /** The band's image (px), its factor over the tile photo, its texel (m), and its texels on the built surface. */
    size?: [number, number]; factor?: number; pixelM?: number; texels?: number;
    /** Texels from one photo, from two that agree, and from an obstruction-free copy (generated); the tile photo keeps the rest. */
    photoTexels?: number; multiTexels?: number; cleanTexels?: number;
    panos?: StreetBandPano[];
    refused?: Array<{ panoId: string; why: string }>;
    /** The projected texels read back from the model readings store (no image needed for this band). */
    stored?: boolean;
    skipped?: string;
}

export interface StreetBandReport {
    version: string; facades: number; banded: number;
    /** The band's surface (m^2), and the share of it textured from Street View (photo-inferred) and from the obstruction-free copies (generated). */
    bandAreaM2: number; photoShare: number; cleanShare: number;
    /** Views offered, those with a refined pose, and the panos whose texels were used, with their capture dates. */
    views: number; refinedViews: number; panosUsed: Array<{ panoId: string; date?: string; texels: number }>;
    /** Bands read back from the store, and bands projected now. */
    stored: number; projected: number;
    perFacade: StreetBandFacade[];
    skipped?: string;
}

// ----------------------------------------------------------------------------------------------------------------------
// the band of a lattice primitive: its triangles cut at the band's top, its rectangle in the photo's UVs

type V3 = [number, number, number];
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

interface Attr { name: string; comps: number; data: number[] }

/** A primitive's float attributes and triangles, cut at y = yTop: the vertices (old ones first, cut ones after) and the triangles on each side. */
export interface CutPrimitive { attrs: Attr[]; count: number; above: number[]; band: number[] }

/** Splits every triangle of a primitive at y = yTop (POSITION's y), every attribute interpolated (NORMAL renormalised). */
export function cutAtHeight(attrs: Attr[], count: number, tris: ArrayLike<number>, yTop: number): CutPrimitive {
    const pos = attrs.find(a => a.name === 'POSITION')!;
    const out: CutPrimitive = { attrs: attrs.map(a => ({ ...a, data: a.data.slice() })), count, above: [], band: [] };
    const s = (i: number) => out.attrs.find(a => a.name === 'POSITION')!.data[i * 3 + 1] - yTop;
    const edgeVertex = new Map<string, number>();
    const cutVertex = (i: number, j: number) => {
        const key = i < j ? `${i},${j}` : `${j},${i}`;
        const had = edgeVertex.get(key);
        if (had !== undefined) return had;
        const a = Math.min(i, j), b = Math.max(i, j), sa = pos.data[a * 3 + 1] - yTop, sb = pos.data[b * 3 + 1] - yTop, t = sa / (sa - sb);
        for (const at of out.attrs) {
            const v: number[] = [];
            for (let c = 0; c < at.comps; c++) v.push(at.data[a * at.comps + c] * (1 - t) + at.data[b * at.comps + c] * t);
            if (at.name === 'NORMAL') { const l = Math.hypot(v[0], v[1], v[2]) || 1; for (let c = 0; c < 3; c++) v[c] /= l; }
            at.data.push(...v);
        }
        const k = out.count++;
        edgeVertex.set(key, k);
        return k;
    };
    for (let t = 0; t + 2 < tris.length; t += 3) {
        const v = [tris[t], tris[t + 1], tris[t + 2]], d = v.map(s);
        if (d.every(x => x <= 0)) { out.band.push(...v); continue; }
        if (d.every(x => x >= 0)) { out.above.push(...v); continue; }
        // one plane through the triangle: each side a polygon of three or four vertices, fanned
        const below: number[] = [], over: number[] = [];
        for (let k = 0; k < 3; k++) {
            const i = v[k], j = v[(k + 1) % 3], di = d[k], dj = d[(k + 1) % 3];
            if (di <= 0) below.push(i);
            if (di >= 0) over.push(i);
            if ((di < 0 && dj > 0) || (di > 0 && dj < 0)) { const c = cutVertex(i, j); below.push(c); over.push(c); }
        }
        for (let k = 1; k + 1 < below.length; k++) out.band.push(below[0], below[k], below[k + 1]);
        for (let k = 1; k + 1 < over.length; k++) out.above.push(over[0], over[k], over[k + 1]);
    }
    return out;
}

/** The band's rectangle in the image's texels (px0 <= x < px1), from its triangles' UVs, a texel of margin. */
export function bandRect(uv: number[], tris: number[], W: number, H: number): [number, number, number, number] | undefined {
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const i of tris) { const u = uv[i * 2], v = uv[i * 2 + 1]; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    if (!(u1 > u0) || !(v1 > v0)) return undefined;
    const px0 = Math.max(0, Math.floor(u0 * W) - 1), px1 = Math.min(W, Math.ceil(u1 * W) + 1), py0 = Math.max(0, Math.floor(v0 * H) - 1), py1 = Math.min(H, Math.ceil(v1 * H) + 1);
    return px1 > px0 && py1 > py0 ? [px0, py0, px1, py1] : undefined;
}

/** The tile photo's texel (m): the median over the band's triangles of sqrt(surface area / UV area in texels). */
export function photoTexelM(pos: number[], uv: number[], tris: number[], W: number, H: number): number {
    const r: number[] = [];
    for (let t = 0; t + 2 < tris.length; t += 3) {
        const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
        const e1 = [0, 1, 2].map(k => pos[b * 3 + k] - pos[a * 3 + k]), e2 = [0, 1, 2].map(k => pos[c * 3 + k] - pos[a * 3 + k]);
        const area = 0.5 * Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
        const uvArea = 0.5 * Math.abs((uv[b * 2] - uv[a * 2]) * W * (uv[c * 2 + 1] - uv[a * 2 + 1]) * H - (uv[c * 2] - uv[a * 2]) * W * (uv[b * 2 + 1] - uv[a * 2 + 1]) * H);
        if (area > 1e-4 && uvArea > 0.5) r.push(Math.sqrt(area / uvArea));
    }
    r.sort((x, y) => x - y);
    return r.length ? r[r.length >> 1] : 0;
}

/** The band's grid: each texel's point and normal on the built surface (rasterised in UV space, larger triangles first). */
export interface BandGrid { W: number; H: number; pixelM: number; yTop: number; has: Uint8Array; point: Float32Array; normal: Float32Array }

export function rasterBand(pos: number[], uvBand: number[], tris: number[], W: number, H: number, pixelM: number, yTop: number): BandGrid {
    const N = W * H, has = new Uint8Array(N), point = new Float32Array(N * 3), normal = new Float32Array(N * 3);
    const order: Array<{ t: number; area: number; n: V3 }> = [];
    for (let t = 0; t + 2 < tris.length; t += 3) {
        const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
        const area = (uvBand[b * 2] - uvBand[a * 2]) * W * (uvBand[c * 2 + 1] - uvBand[a * 2 + 1]) * H - (uvBand[c * 2] - uvBand[a * 2]) * W * (uvBand[b * 2 + 1] - uvBand[a * 2 + 1]) * H;
        if (Math.abs(area) < 1e-6) continue;
        const e1 = [0, 1, 2].map(k => pos[b * 3 + k] - pos[a * 3 + k]), e2 = [0, 1, 2].map(k => pos[c * 3 + k] - pos[a * 3 + k]);
        const n: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const l = Math.hypot(n[0], n[1], n[2]);
        if (!(l > 1e-9)) continue;
        order.push({ t, area: Math.abs(area), n: [n[0] / l, n[1] / l, n[2] / l] });
    }
    order.sort((x, y) => y.area - x.area);
    for (const { t, n } of order) {
        const vs = [tris[t], tris[t + 1], tris[t + 2]], X = vs.map(i => uvBand[i * 2] * W), Y = vs.map(i => uvBand[i * 2 + 1] * H);
        const den = (Y[1] - Y[2]) * (X[0] - X[2]) + (X[2] - X[1]) * (Y[0] - Y[2]);
        const x0 = Math.max(0, Math.floor(Math.min(...X))), x1 = Math.min(W - 1, Math.ceil(Math.max(...X))), y0 = Math.max(0, Math.floor(Math.min(...Y))), y1 = Math.min(H - 1, Math.ceil(Math.max(...Y)));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const i = y * W + x;
            if (has[i]) continue;
            const px = x + 0.5, py = y + 0.5;
            const l0 = ((Y[1] - Y[2]) * (px - X[2]) + (X[2] - X[1]) * (py - Y[2])) / den, l1 = ((Y[2] - Y[0]) * (px - X[2]) + (X[0] - X[2]) * (py - Y[2])) / den, l2 = 1 - l0 - l1;
            if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
            for (let k = 0; k < 3; k++) { point[i * 3 + k] = l0 * pos[vs[0] * 3 + k] + l1 * pos[vs[1] * 3 + k] + l2 * pos[vs[2] * 3 + k]; normal[i * 3 + k] = n[k]; }
            has[i] = 1;
        }
    }
    // the triangle's own winding may face either way: each texel's normal turned toward the facade's own outward side
    // (the mean of the primitive's NORMAL is not read here; the caller orients by the vertex normals, see orientNormals)
    return { W, H, pixelM, yTop, has, point, normal };
}

/** Turns each texel's normal to agree with `outward` (the facade's mean vertex normal). */
export function orientNormals(g: BandGrid, outward: V3): void {
    for (let i = 0; i < g.W * g.H; i++) if (g.has[i] && dot(g.normal.subarray(i * 3, i * 3 + 3), outward) < 0) for (let k = 0; k < 3; k++) g.normal[i * 3 + k] = -g.normal[i * 3 + k];
}

// ----------------------------------------------------------------------------------------------------------------------
// the photos projected onto the band

/** A photo's capture date in years (2024-06 -> 2024.42), undefined when it has none. */
export function captureYears(date?: string): number | undefined {
    const m = date?.match(/^(\d{4})(?:-(\d{1,2}))?/);
    return m ? Number(m[1]) + (m[2] ? (Number(m[2]) - 0.5) / 12 : 0.5) : undefined;
}

/** Whether a view's pose is refined: registered against the tile mesh (edges or jointly) to at most maxResidualM. */
export function refinedPose(v: Pick<StreetBandView, 'registration'>, P: StreetBandParams = STREET_BAND_PARAMS): boolean {
    const r = v.registration;
    return !!r && (r.method === 'edges' || r.method === 'joint') && r.residualM !== null && Number.isFinite(r.residualM) && r.residualM <= P.maxResidualM;
}

interface Projected { rgba: Uint8Array; valid: Uint8Array; weight: Float32Array; ppm: Float32Array; rejected: Record<'facing' | 'frame' | 'owner' | 'depth' | 'coarse', number> }

/**
 * One photo resampled onto the band where it truly sees it (see the file comment, 2), from `image` (the photo as captured,
 * through `owner`) or, for the obstruction-free copy, from `cleanImage` through its filled mask. The weight is incidence,
 * resolution and distance; recency is applied by the caller.
 */
export function projectView(g: BandGrid, v: StreetBandView, depth: Float32Array | undefined, tilePixelM: number, P: StreetBandParams, clean = false): Projected {
    const N = g.W * g.H, cam = v.camera, img = clean ? v.cleanImage! : v.image, mask = clean ? v.cleanFilledMask : v.ownerMask;
    const rgba = new Uint8Array(N * 4), valid = new Uint8Array(N), weight = new Float32Array(N), ppm = new Float32Array(N);
    const rejected = { facing: 0, frame: 0, owner: 0, depth: 0, coarse: 0 };
    const minCos = Math.cos((P.maxIncidenceDeg * Math.PI) / 180), minPpm = P.minSharper / tilePixelM;
    const p: V3 = [0, 0, 0];
    for (let i = 0; i < N; i++) {
        if (!g.has[i]) continue;
        p[0] = g.point[i * 3]; p[1] = g.point[i * 3 + 1]; p[2] = g.point[i * 3 + 2];
        const tx = cam.eye[0] - p[0], ty = cam.eye[1] - p[1], tz = cam.eye[2] - p[2], dist = Math.hypot(tx, ty, tz);
        const cos = (tx * g.normal[i * 3] + ty * g.normal[i * 3 + 1] + tz * g.normal[i * 3 + 2]) / dist;
        if (cos < minCos) { rejected.facing++; continue; }
        const q = project(cam, p);
        if (!q) { rejected.frame++; continue; }
        let u = q.u, w = q.v;
        if (u < 1 || w < 1 || u >= cam.width - 2 || w >= cam.height - 2) { rejected.frame++; continue; }
        const pi = Math.floor(w) * cam.width + Math.floor(u);
        if (!mask || !mask[pi]) { rejected.owner++; continue; }
        if (depth && !(Math.abs(depth[pi] - q.z) < P.depthToleranceM)) { rejected.depth++; continue; }
        const res = (cam.fx / q.z) * cos;
        if (res < minPpm) { rejected.coarse++; continue; }
        if (v.warp) { const d = warpAt(v.warp, cam.width, cam.height, u, w); u = Math.max(0, Math.min(cam.width - 1.001, u + d[0])); w = Math.max(0, Math.min(cam.height - 1.001, w + d[1])); }
        const x0 = Math.floor(u), y0 = Math.floor(w), fx = u - x0, fy = w - y0, iw = img.width, o = (y0 * iw + x0) * 4;
        for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.round((1 - fx) * (1 - fy) * img.rgba[o + c] + fx * (1 - fy) * img.rgba[o + 4 + c] + (1 - fx) * fy * img.rgba[o + iw * 4 + c] + fx * fy * img.rgba[o + iw * 4 + 4 + c]);
        rgba[i * 4 + 3] = 255;
        valid[i] = 1;
        ppm[i] = res;
        weight[i] = cos * cos * Math.min(1, res / P.targetPxPerM) / (1 + (dist / P.distanceM) ** 2);
    }
    return { rgba, valid, weight, ppm, rejected };
}

function shifted<T extends Uint8Array | Float32Array>(a: T, W: number, H: number, dx: number, dy: number, ch: number): T {
    if (!dx && !dy) return a;
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

/** The photo layer of a band: its colour, how much of it each texel takes (0..1), and where each texel's colour came from. */
export interface BandLayer {
    W: number; H: number;
    /** RGBA; alpha 0 where no photo gives the texel. */
    rgba: Uint8Array;
    /** The blend weight at the texel (0..255), the pano (index + 1 into panos, 0 none) and the kind (1 one photo, 2 two that agree, 3 an obstruction-free copy). */
    weight: Uint8Array; pano: Uint8Array; kind: Uint8Array;
    panos: StreetBandPano[];
    refused: Array<{ panoId: string; why: string }>;
}

/**
 * The band's photo layer (see the file comment, 2 to 4) from `views` against the tile photo enlarged (`base`, RGBA at the
 * band's grid). `depthOf` gives a view's depth of the built mesh with its context (rendered once a view, by the caller).
 */
export function projectBand(g: BandGrid, base: Uint8Array, views: StreetBandView[], depthOf: (v: StreetBandView) => Float32Array | undefined, tilePixelM: number, P: StreetBandParams = STREET_BAND_PARAMS): BandLayer {
    const W = g.W, H = g.H, N = W * H;
    const layer: BandLayer = { W, H, rgba: new Uint8Array(N * 4), weight: new Uint8Array(N), pano: new Uint8Array(N), kind: new Uint8Array(N), panos: [], refused: [] };
    const years = views.map(v => captureYears(v.captureDate));
    const newest = Math.max(...years.filter((y): y is number => y !== undefined), -Infinity);
    const erodePx = Math.max(1, Math.round(P.erodeM / g.pixelM)), featherPx = Math.max(1, Math.round(P.featherM / g.pixelM)), R = Math.max(1, Math.round(MAX_SHIFT_M / g.pixelM));
    type Taken = Projected & { k: number; feather: Float32Array; recency: number; agreement: number; shiftPx: [number, number]; gain: [number, number, number] | null };
    const taken: Taken[] = [];
    const lin = (v: number) => SRGB8_TO_LINEAR[v];
    views.forEach((v, k) => {
        if (!refinedPose(v, P)) { layer.refused.push({ panoId: v.panoId, why: `its pose is not refined (${v.registration?.method ?? 'nominal'}${v.registration?.residualM !== null && v.registration?.residualM !== undefined ? `, ${v.registration.residualM.toFixed(2)} m` : ''}; edges or joint within ${P.maxResidualM} m needed)` }); return; }
        const depth = depthOf(v);
        const r0 = projectView(g, v, depth, tilePixelM, P);
        let valid = erode(r0.valid, W, H, erodePx), n = 0;
        for (let i = 0; i < N; i++) n += valid[i];
        if (n < P.minTexels) return;
        // the photo must show this facade: its structure against the tile photo's, at the best shift (the pose's residual)
        const ag = structuralAgreement(r0.rgba, valid, base, g.has, W, H, g.pixelM);
        const atLimit = !!ag && (Math.abs(ag.dx) >= R || Math.abs(ag.dy) >= R);
        if (!ag || ag.ncc < MIN_AGREEMENT_NCC || atLimit) {
            layer.refused.push({ panoId: v.panoId, why: !ag ? 'too little overlap with the tile photo to check it against' : atLimit ? `its best agreement with the tile photo (${ag.ncc.toFixed(2)}) lies at the ${MAX_SHIFT_M} m limit of the shift search: the pose is further off than a shift can mend` : `its structure correlates ${ag.ncc.toFixed(2)} with the tile photo's (under ${MIN_AGREEMENT_NCC}): the pose projects something else onto this facade` });
            return;
        }
        const r: Projected = { rgba: shifted(r0.rgba, W, H, ag.dx, ag.dy, 4), valid: shifted(r0.valid, W, H, ag.dx, ag.dy, 1), weight: shifted(r0.weight, W, H, ag.dx, ag.dy, 1), ppm: shifted(r0.ppm, W, H, ag.dx, ag.dy, 1), rejected: r0.rejected };
        valid = shifted(valid, W, H, ag.dx, ag.dy, 1);
        for (let i = 0; i < N; i++) if (!g.has[i]) valid[i] = 0;
        const gain = exposureGain(r.rgba, valid, base, g.has);
        if (gain) for (let i = 0; i < N; i++) if (valid[i]) for (let c = 0; c < 3; c++) r.rgba[i * 4 + c] = linearToSrgb8(lin(r.rgba[i * 4 + c]) * gain[c]);
        const d = insideDistance(valid, W, H, featherPx), feather = new Float32Array(N);
        for (let i = 0; i < N; i++) feather[i] = valid[i] ? Math.min(1, d[i] / featherPx) : 0;
        const age = years[k] !== undefined && Number.isFinite(newest) ? newest - years[k]! : P.undatedYears;
        taken.push({ ...r, valid, k, feather, recency: Math.pow(0.5, age / P.recencyHalfLifeYears), agreement: ag.ncc, shiftPx: [ag.dx, ag.dy], gain });
    });
    const counts = new Map<number, number>();
    const acc = [0, 0, 0];
    for (let i = 0; i < N; i++) {
        let wsum = 0, best = -1, bestW = 0, second = -1, f = 0;
        acc[0] = acc[1] = acc[2] = 0;
        for (let t = 0; t < taken.length; t++) {
            const r = taken[t];
            if (!r.valid[i]) continue;
            const w = Math.pow(r.feather[i] * r.weight[i] * r.recency, P.sharpen);
            if (!(w > 0)) continue;
            wsum += w;
            for (let c = 0; c < 3; c++) acc[c] += w * lin(r.rgba[i * 4 + c]);
            if (w > bestW) { second = best; best = t; bestW = w; } else if (second < 0) second = t;
            f = Math.max(f, r.feather[i]);
        }
        if (!(wsum > 0)) continue;
        for (let c = 0; c < 3; c++) layer.rgba[i * 4 + c] = linearToSrgb8(acc[c] / wsum);
        layer.rgba[i * 4 + 3] = Math.round(255 * f);
        layer.weight[i] = Math.round(255 * f);
        let agree = false;
        if (second >= 0) {
            const a = taken[best].rgba, b = taken[second].rgba;
            agree = Math.hypot(a[i * 4] - b[i * 4], a[i * 4 + 1] - b[i * 4 + 1], a[i * 4 + 2] - b[i * 4 + 2]) * 0.4 <= P.agreeDeltaE;
        }
        layer.kind[i] = agree ? 2 : 1;
        layer.pano[i] = taken[best].k + 1;
        counts.set(taken[best].k, (counts.get(taken[best].k) ?? 0) + 1);
    }
    // what no photo sees clear: the photos' obstruction-free copies (generated), exposure matched as their photo was
    if (P.cleanFill) for (const r of taken) {
        const v = views[r.k];
        if (!v.cleanImage || !v.cleanFilledMask) continue;
        const c0 = projectView(g, v, depthOf(v), tilePixelM, P, true);
        const cv = shifted(c0.valid, W, H, r.shiftPx[0], r.shiftPx[1], 1), crgba = shifted(c0.rgba, W, H, r.shiftPx[0], r.shiftPx[1], 4);
        for (let i = 0; i < N; i++) {
            if (!cv[i] || !g.has[i] || layer.rgba[i * 4 + 3] === 255) continue;
            // a texel a photo covers in part keeps that part; the copy fills the rest
            const a = layer.rgba[i * 4 + 3] / 255;
            for (let c = 0; c < 3; c++) { const x = r.gain ? linearToSrgb8(lin(crgba[i * 4 + c]) * r.gain[c]) : crgba[i * 4 + c]; layer.rgba[i * 4 + c] = Math.round(a * layer.rgba[i * 4 + c] + (1 - a) * x); }
            layer.rgba[i * 4 + 3] = 255;
            layer.weight[i] = 255;
            if (!layer.kind[i]) { layer.kind[i] = 3; layer.pano[i] = r.k + 1; }
        }
    }
    // the panos reported in the views' order; the layer's indices renumbered into that list
    const index = new Map<number, number>();
    for (const r of taken) {
        const v = views[r.k], ppm: number[] = [];
        for (let i = 0; i < N; i += 17) if (r.valid[i]) ppm.push(r.ppm[i]);
        ppm.sort((a, b) => a - b);
        index.set(r.k, layer.panos.length + 1);
        layer.panos.push({ panoId: v.panoId, ...(v.captureDate ? { date: v.captureDate } : {}), method: v.registration!.method, residualM: v.registration!.residualM, texels: counts.get(r.k) ?? 0, agreement: +r.agreement.toFixed(3), shiftPx: r.shiftPx, gain: r.gain ? r.gain.map(x => +x.toFixed(3)) as [number, number, number] : null, pxPerM: Math.round(ppm.length ? ppm[ppm.length >> 1] : 0) });
    }
    for (let i = 0; i < N; i++) if (layer.pano[i]) layer.pano[i] = index.get(layer.pano[i] - 1) ?? 0;
    return layer;
}

/** A box mean of radius r over the masked texels of a W x H x 3 float field (separable, the mask's weight carried). */
function maskedBox3(f: Float32Array, m: Float32Array, W: number, H: number, r: number): Float32Array {
    const tmp = new Float32Array(W * H * 4), out = new Float32Array(W * H * 3);
    for (let y = 0; y < H; y++) {
        const s = [0, 0, 0, 0];
        const add = (x: number, sign: number) => { const i = y * W + x; s[0] += sign * f[i * 3] * m[i]; s[1] += sign * f[i * 3 + 1] * m[i]; s[2] += sign * f[i * 3 + 2] * m[i]; s[3] += sign * m[i]; };
        for (let x = 0; x <= Math.min(W - 1, r); x++) add(x, 1);
        for (let x = 0; x < W; x++) {
            const o = (y * W + x) * 4;
            tmp[o] = s[0]; tmp[o + 1] = s[1]; tmp[o + 2] = s[2]; tmp[o + 3] = s[3];
            if (x + r + 1 < W) add(x + r + 1, 1);
            if (x - r >= 0) add(x - r, -1);
        }
    }
    for (let x = 0; x < W; x++) {
        const s = [0, 0, 0, 0];
        const add = (y: number, sign: number) => { const o = (y * W + x) * 4; for (let c = 0; c < 4; c++) s[c] += sign * tmp[o + c]; };
        for (let y = 0; y <= Math.min(H - 1, r); y++) add(y, 1);
        for (let y = 0; y < H; y++) {
            const i = y * W + x;
            if (s[3] > 1e-6) for (let c = 0; c < 3; c++) out[i * 3 + c] = s[c] / s[3];
            if (y + r + 1 < H) add(y + r + 1, 1);
            if (y - r >= 0) add(y - r, -1);
        }
    }
    return out;
}

/**
 * The band's texture: the photo layer over the tile photo, the layer's low frequencies matched to the tile photo near the
 * band's top (over seamM, fading downward) and the layer faded out over topFeatherM below the top (see the file comment, 3).
 * Edits nothing; returns RGBA.
 */
export function finishBand(g: BandGrid, base: Uint8Array, layer: BandLayer, P: StreetBandParams = STREET_BAND_PARAMS): Uint8Array {
    const N = g.W * g.H, out = Uint8Array.from(base);
    const lin = (v: number) => SRGB8_TO_LINEAR[v];
    const L = new Float32Array(N * 3), T = new Float32Array(N * 3), mL = new Float32Array(N), mT = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        if (!g.has[i]) continue;
        for (let c = 0; c < 3; c++) { L[i * 3 + c] = lin(layer.rgba[i * 4 + c]); T[i * 3 + c] = lin(base[i * 4 + c]); }
        mL[i] = layer.rgba[i * 4 + 3] / 255; mT[i] = 1;
    }
    const r = Math.max(1, Math.round(P.seamBlurM / g.pixelM));
    const bl = maskedBox3(L, mL, g.W, g.H, r), bt = maskedBox3(T, mT, g.W, g.H, r);
    for (let i = 0; i < N; i++) {
        const a = layer.rgba[i * 4 + 3] / 255;
        if (!g.has[i] || !(a > 0)) continue;
        const below = g.yTop - g.point[i * 3 + 1];
        const seam = Math.max(0, Math.min(1, 1 - below / P.seamM)), fade = Math.max(0, Math.min(1, below / P.topFeatherM));
        const w = a * fade;
        for (let c = 0; c < 3; c++) {
            const x = L[i * 3 + c] + seam * (bt[i * 3 + c] - bl[i * 3 + c]);
            out[i * 4 + c] = linearToSrgb8(w * Math.max(0, x) + (1 - w) * T[i * 3 + c]);
        }
    }
    return out;
}

// ----------------------------------------------------------------------------------------------------------------------
// images: crops and enlargements in the photo's frame

/** A crop of `img` covering texels [px0, px1) x [py0, py1) of a W x H frame, at `scale` times the frame's resolution over img's own (bilinear when `smooth`, else nearest). */
export function cropAt(img: RgbaImage8, frameW: number, frameH: number, rect: [number, number, number, number], outW: number, outH: number, smooth: boolean): Uint8Array {
    const [px0, py0, px1, py1] = rect, out = new Uint8Array(outW * outH * 4);
    const sx = img.width / frameW, sy = img.height / frameH;
    for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
        // the output texel's centre in the frame's texels, then in the image's
        const fx = (px0 + ((x + 0.5) / outW) * (px1 - px0)) * sx, fy = (py0 + ((y + 0.5) / outH) * (py1 - py0)) * sy, o = (y * outW + x) * 4;
        if (!smooth) {
            const ix = Math.min(img.width - 1, Math.max(0, Math.floor(fx))), iy = Math.min(img.height - 1, Math.max(0, Math.floor(fy)));
            out.set(img.rgba.subarray((iy * img.width + ix) * 4, (iy * img.width + ix) * 4 + 4), o);
            continue;
        }
        const ax = Math.max(0, Math.min(img.width - 1, fx - 0.5)), ay = Math.max(0, Math.min(img.height - 1, fy - 0.5));
        const x0 = Math.floor(ax), y0 = Math.floor(ay), x1 = Math.min(img.width - 1, x0 + 1), y1 = Math.min(img.height - 1, y0 + 1), tx = ax - x0, ty = ay - y0;
        for (let c = 0; c < 4; c++) {
            const at = (xx: number, yy: number) => img.rgba[(yy * img.width + xx) * 4 + c];
            out[o + c] = Math.round((at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty);
        }
    }
    return out;
}

const pngOf = (W: number, H: number, rgba: Uint8Array): Buffer => {
    const opaque = rgba.every((v, i) => i % 4 !== 3 || v === 255);
    if (!opaque) return encodePng(W, H, rgba, 4);
    const rgb = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H; i++) { rgb[i * 3] = rgba[i * 4]; rgb[i * 3 + 1] = rgba[i * 4 + 1]; rgb[i * 3 + 2] = rgba[i * 4 + 2]; }
    return encodePng(W, H, rgb, 3);
};

// ----------------------------------------------------------------------------------------------------------------------
// the twin

/** The texture references of a material that read the lattice's UVs: their holders and keys, so a band copy can repoint them. */
function textureRefs(mat: any): Array<{ holder: any; key: string; texCoord: number; transformed: boolean }> {
    const out: Array<{ holder: any; key: string; texCoord: number; transformed: boolean }> = [];
    const info = (holder: any, key: string) => { const t = holder?.[key]; if (t && typeof t.index === 'number') out.push({ holder, key, texCoord: t.texCoord ?? 0, transformed: !!t.extensions?.KHR_texture_transform }); };
    info(mat.pbrMetallicRoughness, 'baseColorTexture'); info(mat.pbrMetallicRoughness, 'metallicRoughnessTexture');
    info(mat, 'normalTexture'); info(mat, 'occlusionTexture'); info(mat, 'emissiveTexture');
    for (const ext of Object.values(mat.extensions ?? {})) for (const [k, v] of Object.entries(ext as Record<string, any>)) if (v && typeof v === 'object' && typeof v.index === 'number') info(ext, k);
    return out;
}

/** A band ready to project: the lattice primitive cut, its grid, the tile photo enlarged, and its key in the readings store. */
export interface PlannedBand {
    row: StreetBandFacade; node: any; prim: any; cut: CutPrimitive; rect: [number, number, number, number];
    image: number; imageSize: [number, number]; F: number; grid: BandGrid; base: Uint8Array; tilePixelM: number; uvBand: number[]; key: string;
}

/**
 * The bands of a twin's rebuilt facades (step 1 of the file comment), each with its readings key (`street-band/<sha256>`
 * over the band's geometry, its factor, `panoSet` (the panos near, sorted) and the parameters). Nothing is changed.
 */
export function planStreetBands(twin: Uint8Array, groundY: number, panoSet: string[], P: StreetBandParams = STREET_BAND_PARAMS): { glb: ReturnType<typeof parseGlbBytes>; bands: PlannedBand[]; perFacade: StreetBandFacade[] } {
    const g = parseGlbBytes(twin), json = g.json;
    const perFacade: StreetBandFacade[] = [], bands: PlannedBand[] = [];
    const yTop = groundY + P.bandTopM;
    const decoded = new Map<number, RgbaImage8>();
    const viewBytes = (v: number) => { const bv = json.bufferViews[v]; return g.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength); };
    const imageOf = (k: number) => { let d = decoded.get(k); if (!d) { d = decodeImageInMemory(viewBytes(json.images[k].bufferView)); decoded.set(k, d); } return d; };
    const paramsKey = crypto.createHash('sha256').update(JSON.stringify(P)).digest('hex').slice(0, 16);
    const panosKey = [...panoSet].sort().join(',');
    for (const node of json.nodes ?? []) {
        const name: string = node.name ?? '';
        if (!name.startsWith('FacadeLattice_') || node.mesh === undefined) continue;
        const facadeId: number = node.extras?.sbFacadeLattice?.facadeId ?? Number(name.slice('FacadeLattice_'.length));
        (json.meshes[node.mesh].primitives as any[]).forEach((prim, pk) => {
            const row: StreetBandFacade = { facadeId, node: name, primitive: pk };
            perFacade.push(row);
            if (node.matrix || node.translation || node.rotation || node.scale) { row.skipped = 'its node is transformed (the lattice writes its facades in the scene\'s frame)'; return; }
            if ((prim.mode ?? 4) !== 4) { row.skipped = 'not a triangle list'; return; }
            const mat = prim.material !== undefined ? json.materials?.[prim.material] : undefined;
            const refs = mat ? textureRefs(mat) : [];
            const baseRef = refs.find(r => r.key === 'baseColorTexture');
            if (!baseRef) { row.skipped = 'no base colour texture'; return; }
            if (refs.some(r => r.texCoord !== 0 || r.transformed)) { row.skipped = 'a map reads another UV set or a texture transform (the band crops maps in the lattice\'s own UVs only)'; return; }
            const attrs: Attr[] = [];
            for (const [an, ai] of Object.entries(prim.attributes as Record<string, number>)) {
                const acc = json.accessors[ai];
                if (acc.componentType !== 5126 || acc.sparse) { row.skipped = `its ${an} is not plain float data`; return; }
                const r = readAccessor(g, ai);
                attrs.push({ name: an, comps: r.comps, data: Array.from(r.data) });
            }
            if (!attrs.some(a => a.name === 'POSITION') || !attrs.some(a => a.name === 'TEXCOORD_0')) { row.skipped = 'no positions or UVs'; return; }
            const count = json.accessors[prim.attributes.POSITION].count;
            const tris = prim.indices !== undefined ? Array.from(readAccessor(g, prim.indices).data) : Array.from({ length: count }, (_, i) => i);
            const cut = cutAtHeight(attrs, count, tris, yTop);
            if (!cut.band.length) { row.skipped = `no surface below ${P.bandTopM} m above the foot`; return; }
            const texIndex = baseRef.holder[baseRef.key].index, image = json.textures[texIndex].source;
            const img = imageOf(image);
            const uv = cut.attrs.find(a => a.name === 'TEXCOORD_0')!.data, pos = cut.attrs.find(a => a.name === 'POSITION')!.data;
            const rect = bandRect(uv, cut.band, img.width, img.height);
            if (!rect) { row.skipped = 'its band has no extent in the photo'; return; }
            const tilePixelM = photoTexelM(pos, uv, cut.band, img.width, img.height);
            if (!(tilePixelM > 0)) { row.skipped = 'the photo\'s texel could not be measured on the band'; return; }
            const rw = rect[2] - rect[0], rh = rect[3] - rect[1];
            let F = Math.max(1, Math.min(P.maxFactor, Math.round(tilePixelM / P.pixelM)));
            while (F > 1 && (rw * F > P.maxSidePx || rh * F > P.maxSidePx || rw * rh * F * F > P.maxTexels)) F--;
            if (F < 2) { row.skipped = `its band cannot be drawn finer than the tile photo (${rw} x ${rh} px at ${tilePixelM.toFixed(3)} m a texel) within ${P.maxSidePx} px a side`; return; }
            const BW = rw * F, BH = rh * F;
            const uvBand = new Array(uv.length);
            for (let i = 0; i < uv.length; i += 2) { uvBand[i] = (uv[i] * img.width - rect[0]) / rw; uvBand[i + 1] = (uv[i + 1] * img.height - rect[1]) / rh; }
            const grid = rasterBand(pos, uvBand, cut.band, BW, BH, tilePixelM / F, yTop);
            // outward: the primitive's mean vertex normal over the band
            const nrm = cut.attrs.find(a => a.name === 'NORMAL')?.data;
            const out: V3 = [0, 0, 0];
            if (nrm) for (const i of cut.band) for (let k = 0; k < 3; k++) out[k] += nrm[i * 3 + k];
            if (Math.hypot(...out) > 1e-6) orientNormals(grid, out);
            const base = cropAt(img, img.width, img.height, rect, BW, BH, true);
            const geomBytes = new Float32Array(cut.band.length * 5);
            cut.band.forEach((i, k) => geomBytes.set([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], uv[i * 2], uv[i * 2 + 1]], k * 5));
            const geom = crypto.createHash('sha256').update(new Uint8Array(geomBytes.buffer));
            const key = readingKey('street-band', [STREET_BAND_VERSION, paramsKey, `${BW}x${BH}`, geom.digest('hex'), panosKey]);
            Object.assign(row, { size: [BW, BH], factor: F, pixelM: +(tilePixelM / F).toFixed(4), texels: grid.has.reduce((a, x) => a + x, 0) });
            bands.push({ row, node, prim, cut, rect, image, imageSize: [img.width, img.height], F, grid, base, tilePixelM, uvBand, key });
        });
    }
    return { glb: g, bands, perFacade };
}

/** The layer as the readings store keeps it: its texels as PNGs (base64), never a photo. */
interface StoredLayer { W: number; H: number; rgba: string; labels: string; panos: StreetBandPano[]; refused: BandLayer['refused'] }

function storeLayer(l: BandLayer): StoredLayer {
    const labels = new Uint8Array(l.W * l.H * 4);
    for (let i = 0; i < l.W * l.H; i++) { labels[i * 4] = l.pano[i]; labels[i * 4 + 1] = l.kind[i]; labels[i * 4 + 2] = l.weight[i]; labels[i * 4 + 3] = 255; }
    return { W: l.W, H: l.H, rgba: encodePng(l.W, l.H, l.rgba, 4).toString('base64'), labels: encodePng(l.W, l.H, labels, 4).toString('base64'), panos: l.panos, refused: l.refused };
}

function loadLayer(s: StoredLayer): BandLayer {
    const rgba = decodeImageInMemory(Buffer.from(s.rgba, 'base64')).rgba, lab = decodeImageInMemory(Buffer.from(s.labels, 'base64')).rgba, N = s.W * s.H;
    const out: BandLayer = { W: s.W, H: s.H, rgba: Uint8Array.from(rgba), weight: new Uint8Array(N), pano: new Uint8Array(N), kind: new Uint8Array(N), panos: s.panos, refused: s.refused };
    for (let i = 0; i < N; i++) { out.pano[i] = lab[i * 4]; out.kind[i] = lab[i * 4 + 1]; out.weight[i] = lab[i * 4 + 2]; }
    return out;
}

/** The provenance entry the twin gains. */
export const streetBandProvenance = (report: Pick<StreetBandReport, 'photoShare' | 'panosUsed'>) => {
    const dates = [...new Set(report.panosUsed.map(p => p.date).filter(Boolean))].sort();
    return {
        source: 'street-band', label: 'photo-inferred' as const,
        method: `the rebuilt facades' lowest storeys from registered Street View photos (${report.panosUsed.length} panos${dates.length ? `, captured ${dates[0]}${dates.length > 1 ? ` to ${dates[dates.length - 1]}` : ''}` : ''}), only where a photo truly sees the surface (ownership, depth, incidence and resolution gates; structure checked against the tile photo), exposure and low frequencies matched to the tile photo; where none sees it clear, a photo's obstruction-free copy (generated) or the tile photo`,
        coverage: report.photoShare
    };
};

/**
 * Textures the street band of a twin's rebuilt facades (see the file comment). `views` is asked only when a band's texels
 * are not in the store; `depthMesh` is the built mesh with its context, for the visibility test. Never throws for a facade;
 * an abort propagates.
 */
export async function textureStreetBand(twin: Uint8Array, opts: {
    groundY: number; panoSet: string[]; views?: () => Promise<StreetBandView[]>; depthMesh?: RenderMesh3D;
    store?: ModelReadingStore; signal?: AbortSignal; progress?: (m: string) => void;
}, P: StreetBandParams = STREET_BAND_PARAMS): Promise<{ glb: Buffer; report: StreetBandReport }> {
    const plan = planStreetBands(twin, opts.groundY, opts.panoSet, P);
    const { glb: g, bands } = plan, json = g.json;
    const report: StreetBandReport = { version: STREET_BAND_VERSION, facades: plan.perFacade.length, banded: 0, bandAreaM2: 0, photoShare: 0, cleanShare: 0, views: 0, refinedViews: 0, panosUsed: [], stored: 0, projected: 0, perFacade: plan.perFacade };
    const unchanged = (skipped: string) => ({ glb: Buffer.from(twin), report: { ...report, skipped } });
    if (!plan.perFacade.length) return unchanged('no rebuilt facade in this model');
    if (!bands.length) return unchanged(plan.perFacade.find(f => f.skipped)?.skipped ?? 'no band to texture');
    // the layers: read back from the store, else projected from the views (asked once, only when some band needs them)
    const layers = new Map<PlannedBand, BandLayer>();
    for (const b of bands) {
        const kept = opts.store ? await opts.store.get<StoredLayer>(b.key) : undefined;
        if (kept && kept.W === b.grid.W && kept.H === b.grid.H) { layers.set(b, loadLayer(kept)); b.row.stored = true; report.stored++; }
    }
    const todo = bands.filter(b => !layers.has(b));
    if (todo.length) {
        if (!opts.views) { for (const b of todo) b.row.skipped = 'no Street View source in this build'; }
        else {
            const views = await opts.views();
            if (opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error('street band: stopped');
            report.views = views.length; report.refinedViews = views.filter(v => refinedPose(v, P)).length;
            const depths = new Map<StreetBandView, Float32Array | undefined>();
            const depthOf = (v: StreetBandView) => {
                if (!opts.depthMesh) return undefined;
                if (!depths.has(v)) depths.set(v, renderFrameDepth(opts.depthMesh, v.camera as never));
                return depths.get(v);
            };
            for (const b of todo) {
                if (opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error('street band: stopped');
                // only the views that face this band and are near enough to resolve it
                const c: V3 = [0, 0, 0], n: V3 = [0, 0, 0];
                let k = 0;
                for (let i = 0; i < b.grid.W * b.grid.H; i += 53) if (b.grid.has[i]) { for (let a = 0; a < 3; a++) { c[a] += b.grid.point[i * 3 + a]; n[a] += b.grid.normal[i * 3 + a]; } k++; }
                if (k) for (let a = 0; a < 3; a++) c[a] /= k;
                const facing = views.filter(v => dot([v.camera.eye[0] - c[0], v.camera.eye[1] - c[1], v.camera.eye[2] - c[2]], n) > 0);
                const layer = projectBand(b.grid, b.base, facing, depthOf, b.tilePixelM, P);
                layers.set(b, layer);
                report.projected++;
                opts.store?.put(b.key, storeLayer(layer));
                opts.progress?.(`street band: ${b.row.node}: ${layer.panos.filter(p => p.texels).length} photos give its lowest ${P.bandTopM} m${layer.refused.length ? `, ${layer.refused.length} refused` : ''}`);
            }
        }
    }
    // the twin rewritten: each band's primitive cut, the band's part a primitive of its own with its cropped maps
    const newViews: Uint8Array[] = [];
    const addView = (bytes: Uint8Array, target?: number) => { newViews.push(bytes); json.bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: bytes.byteLength, ...(target ? { target } : {}), __new: newViews.length - 1 }); return json.bufferViews.length - 1; };
    const addAccessor = (data: ArrayLike<number>, comps: number, kind: 'float' | 'index', minmax = false) => {
        const type = ({ 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4' } as Record<number, string>)[comps];
        const arr = kind === 'float' ? Float32Array.from(data) : Uint32Array.from(data);
        const acc: any = { bufferView: addView(new Uint8Array(arr.buffer), kind === 'float' ? 34962 : 34963), componentType: kind === 'float' ? 5126 : 5125, count: arr.length / comps, type };
        if (minmax) { const mn = new Array(comps).fill(Infinity), mx = new Array(comps).fill(-Infinity); for (let i = 0; i < arr.length; i++) { mn[i % comps] = Math.min(mn[i % comps], arr[i]); mx[i % comps] = Math.max(mx[i % comps], arr[i]); } acc.min = mn; acc.max = mx; }
        json.accessors.push(acc);
        return json.accessors.length - 1;
    };
    const addImage = (W: number, H: number, rgba: Uint8Array, sampler: number | undefined) => {
        json.images.push({ bufferView: addView(pngOf(W, H, rgba)), mimeType: 'image/png' });
        json.textures.push({ source: json.images.length - 1, ...(sampler !== undefined ? { sampler } : {}) });
        return json.textures.length - 1;
    };
    const decoded = new Map<number, RgbaImage8>();
    const viewBytes = (v: number) => { const bv = json.bufferViews[v]; return g.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength); };
    const imageOf = (k: number) => { let d = decoded.get(k); if (!d) { d = decodeImageInMemory(viewBytes(json.images[k].bufferView)); decoded.set(k, d); } return d; };
    json.samplers ??= [];
    json.samplers.push({ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 });
    const nearest = json.samplers.length - 1;
    const used = new Map<string, { date?: string; texels: number }>();
    const bandPrims = new Map<any, any>();
    let area = 0, photoArea = 0, cleanArea = 0;
    for (const b of bands) {
        const layer = layers.get(b);
        if (!layer) continue;
        const { grid, row } = b, N = grid.W * grid.H, texelArea = grid.pixelM * grid.pixelM;
        let photo = 0, multi = 0, clean = 0, bandTexels = 0;
        for (let i = 0; i < N; i++) { if (!grid.has[i]) continue; bandTexels++; if (layer.kind[i] === 1) photo++; else if (layer.kind[i] === 2) { photo++; multi++; } else if (layer.kind[i] === 3) clean++; }
        area += bandTexels * texelArea;
        Object.assign(row, { photoTexels: photo, multiTexels: multi, cleanTexels: clean, panos: layer.panos, refused: layer.refused });
        if (!photo && !clean) { row.skipped = layer.panos.length ? 'no photo texel kept' : layer.refused.length ? `every photo refused (${layer.refused[0].why})` : 'no registered photo sees its band'; continue; }
        photoArea += photo * texelArea; cleanArea += clean * texelArea;
        for (const p of layer.panos) { const u = used.get(p.panoId) ?? { ...(p.date ? { date: p.date } : {}), texels: 0 }; u.texels += p.texels; used.set(p.panoId, u); }
        const texture = finishBand(grid, b.base, layer, P);
        // the band's material: the facade's, each map cropped to the band's rectangle, the base colour the band's own
        const mat = json.materials[b.prim.material], bandMat = JSON.parse(JSON.stringify(mat));
        const [W0, H0] = b.imageSize, rw = b.rect[2] - b.rect[0], rh = b.rect[3] - b.rect[1];
        const crops = new Map<number, number>();
        const cropTexture = (tex: number, nearestOnly: boolean) => {
            if (crops.has(tex)) return crops.get(tex)!;
            const img = imageOf(json.textures[tex].source), sx = img.width / W0, sy = img.height / H0;
            const ow = Math.max(1, Math.round(rw * sx)), oh = Math.max(1, Math.round(rh * sy));
            const k = addImage(ow, oh, cropAt(img, W0, H0, b.rect, ow, oh, false), nearestOnly ? nearest : json.textures[tex].sampler);
            crops.set(tex, k);
            return k;
        };
        for (const r of textureRefs(bandMat)) {
            if (r.key === 'baseColorTexture') r.holder[r.key] = { ...r.holder[r.key], index: addImage(grid.W, grid.H, texture, json.textures[r.holder[r.key].index].sampler) };
            else r.holder[r.key] = { ...r.holder[r.key], index: cropTexture(r.holder[r.key].index, false) };
        }
        if (typeof bandMat.extras?.sbMaterial?.paramsTexture === 'number') bandMat.extras.sbMaterial.paramsTexture = cropTexture(bandMat.extras.sbMaterial.paramsTexture, true);
        // the band's rectangle in the photo's UVs, so a reader of the lattice's UV extras (the viewer's recess) maps back
        const uvRect = [b.rect[0] / W0, b.rect[1] / H0, b.rect[2] / W0, b.rect[3] / H0].map(x => +x.toFixed(6));
        bandMat.name = `${mat.name ?? 'facade'}_streetBand`;
        bandMat.extras = { ...(bandMat.extras ?? {}), sbStreetBand: { uvRect } };
        json.materials.push(bandMat);
        // the labels per texel
        const labels = new Uint8Array(N * 4);
        for (let i = 0; i < N; i++) { labels[i * 4] = layer.pano[i]; labels[i * 4 + 1] = layer.kind[i]; labels[i * 4 + 2] = layer.weight[i]; labels[i * 4 + 3] = 255; }
        const sourceTexture = addImage(grid.W, grid.H, labels, nearest);
        // the vertices (the old ones and the cut ones), shared by both parts; the band's UVs into its rectangle
        const attributes: Record<string, number> = {};
        for (const a of b.cut.attrs) attributes[a.name] = addAccessor(a.data, a.comps, 'float', a.name === 'POSITION');
        const above = { ...b.prim, attributes: { ...attributes }, indices: addAccessor(b.cut.above, 1, 'index') };
        const bandUv = b.cut.attrs.find(a => a.name === 'TEXCOORD_0')!.data.map((x, i) => (i % 2 ? (x * H0 - b.rect[1]) / rh : (x * W0 - b.rect[0]) / rw));
        const bandPrim = { ...b.prim, attributes: { ...attributes, TEXCOORD_0: addAccessor(bandUv, 2, 'float') }, indices: addAccessor(b.cut.band, 1, 'index'), material: json.materials.length - 1 };
        const prims = json.meshes[b.node.mesh].primitives as any[];
        prims[b.row.primitive] = b.cut.above.length ? above : null;
        prims.push(bandPrim);
        bandPrims.set(bandPrim, b.node);
        const panosUsed = layer.panos.filter(p => p.texels);
        const dates = [...new Set(panosUsed.map(p => p.date).filter(Boolean))].sort();
        b.node.extras = { ...(b.node.extras ?? {}), sbStreetBand: [...(b.node.extras?.sbStreetBand ?? []), {
            version: STREET_BAND_VERSION, label: 'photo-inferred', primitive: bandPrim, bandTopM: P.bandTopM, yTop: +grid.yTop.toFixed(3), pixelM: row.pixelM, size: row.size, uvRect,
            panos: panosUsed.map(p => ({ panoId: p.panoId, date: p.date ?? null, method: p.method, residualM: p.residualM, texels: p.texels, agreement: p.agreement })),
            ...(dates.length ? { captured: dates.length > 1 ? `${dates[0]} to ${dates[dates.length - 1]}` : dates[0] } : {}),
            refused: layer.refused,
            shares: { photo: +(photo / Math.max(1, bandTexels)).toFixed(4), twoPhotos: +(multi / Math.max(1, bandTexels)).toFixed(4), generated: +(clean / Math.max(1, bandTexels)).toFixed(4) },
            sourceTexture, sourceChannels: 'R = index + 1 into panos (0 = the tile photo), G = 1 one photo, 2 two photos that agree (both photo-inferred), 3 a photo\'s obstruction-free copy (generated), B = the blend weight 0..255',
            method: streetBandProvenance({ photoShare: 0, panosUsed: panosUsed.map(p => ({ panoId: p.panoId, ...(p.date ? { date: p.date } : {}), texels: p.texels })) }).method
        }] };
        report.banded++;
    }
    for (const m of json.meshes) m.primitives = (m.primitives as any[]).filter(p => p !== null);
    // each band's entry names its primitive by index, now that the emptied ones are gone
    for (const [prim, node] of bandPrims) for (const e of node.extras.sbStreetBand) if (e.primitive === prim) e.primitive = json.meshes[node.mesh].primitives.indexOf(prim);
    report.bandAreaM2 = Math.round(area);
    report.photoShare = area ? +(photoArea / area).toFixed(4) : 0;
    report.cleanShare = area ? +(cleanArea / area).toFixed(4) : 0;
    report.panosUsed = [...used].map(([panoId, u]) => ({ panoId, ...u })).filter(p => p.texels);
    if (!report.banded) return { glb: Buffer.from(twin), report: { ...report, skipped: plan.perFacade.find(f => f.skipped)?.skipped ?? 'no band textured' } };
    return { glb: compactGlb(json, g.bin, newViews), report };
}

/**
 * The GLB written with only what is still referenced: accessors from the meshes, skins and animations, buffer views from
 * those accessors and the images. A view marked __new takes its bytes from `fresh`, every other one from `bin`.
 */
export function compactGlb(json: any, bin: Uint8Array, fresh: Uint8Array[]): Buffer {
    const usedAcc = new Set<number>();
    for (const m of json.meshes ?? []) for (const p of m.primitives ?? []) {
        for (const a of Object.values(p.attributes ?? {}) as number[]) usedAcc.add(a);
        if (p.indices !== undefined) usedAcc.add(p.indices);
        for (const t of p.targets ?? []) for (const a of Object.values(t) as number[]) usedAcc.add(a);
    }
    for (const s of json.skins ?? []) if (s.inverseBindMatrices !== undefined) usedAcc.add(s.inverseBindMatrices);
    for (const an of json.animations ?? []) for (const s of an.samplers ?? []) { usedAcc.add(s.input); usedAcc.add(s.output); }
    const accMap = new Map<number, number>(), accessors: any[] = [];
    (json.accessors ?? []).forEach((a: any, i: number) => { if (usedAcc.has(i)) { accMap.set(i, accessors.length); accessors.push(a); } });
    const usedView = new Set<number>();
    for (const a of accessors) { if (a.bufferView !== undefined) usedView.add(a.bufferView); if (a.sparse) { usedView.add(a.sparse.indices.bufferView); usedView.add(a.sparse.values.bufferView); } }
    for (const im of json.images ?? []) if (im.bufferView !== undefined) usedView.add(im.bufferView);
    const viewMap = new Map<number, number>(), views: any[] = [], chunks: Uint8Array[] = [];
    let len = 0;
    (json.bufferViews ?? []).forEach((bv: any, i: number) => {
        if (!usedView.has(i)) return;
        const { __new, ...rest } = bv;
        const bytes = __new !== undefined ? fresh[__new] : bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
        const pad = (4 - (len % 4)) % 4;
        if (pad) { chunks.push(new Uint8Array(pad)); len += pad; }
        viewMap.set(i, views.length);
        views.push({ ...rest, buffer: 0, byteOffset: len, byteLength: bytes.byteLength });
        chunks.push(bytes); len += bytes.byteLength;
    });
    const pad = (4 - (len % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); len += pad; }
    const out = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    for (const a of accessors) { if (a.bufferView !== undefined) a.bufferView = viewMap.get(a.bufferView); if (a.sparse) { a.sparse.indices.bufferView = viewMap.get(a.sparse.indices.bufferView); a.sparse.values.bufferView = viewMap.get(a.sparse.values.bufferView); } }
    for (const im of json.images ?? []) if (im.bufferView !== undefined) im.bufferView = viewMap.get(im.bufferView);
    for (const m of json.meshes ?? []) for (const p of m.primitives ?? []) {
        for (const k of Object.keys(p.attributes ?? {})) p.attributes[k] = accMap.get(p.attributes[k]);
        if (p.indices !== undefined) p.indices = accMap.get(p.indices);
        for (const t of p.targets ?? []) for (const k of Object.keys(t)) t[k] = accMap.get(t[k]);
    }
    for (const s of json.skins ?? []) if (s.inverseBindMatrices !== undefined) s.inverseBindMatrices = accMap.get(s.inverseBindMatrices);
    for (const an of json.animations ?? []) for (const s of an.samplers ?? []) { s.input = accMap.get(s.input); s.output = accMap.get(s.output); }
    json.accessors = accessors; json.bufferViews = views;
    json.buffers = [{ ...(json.buffers?.[0] ?? {}), byteLength: len }];
    return assembleGlb(json, out);
}
