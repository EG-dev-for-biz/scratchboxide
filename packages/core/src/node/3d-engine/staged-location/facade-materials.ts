/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The facade material reading of the texture pass: each region of a textured layer read as continuous material fields
 * (glass share and transmissive/reflective likelihood, roughness, metalness, base albedo, masonry course pitch and joint
 * width), from two sources gathered on the main thread (facade-material-evidence.ts):
 *
 *  - Street View masks, carried onto the texels like the colour (pose, warp, occluder and context depth, incidence);
 *  - the tile's frontal face masks (no pose: the tile texture is mapped to the mesh), carried by the face frame.
 *
 * The model proposes and the measurement decides. A candidate region (connected texels some source marked) is accepted
 * only when the evidence it was not drawn from agrees with it:
 *  - Street View: at least two distinct panos mark it and at least two thirds of the panos that see it do (each pano's
 *    mask is the held-out check of the others');
 *  - one pano and the tile agree (two independent captures);
 *  - the tile alone (a face no pano sees): the tile marks it AND the measured tile raster agrees with what glass looks like
 *    there: the region sits in a regular lattice of like regions on its face and is darker than the wall around it (its
 *    interior; more uniform alone is not enough: marble panels are). Lower confidence.
 * Anything else is rejected with the reason. Where the sources contradict each other the region is rejected unless three
 * or more panos mark it.
 *
 * Accepted glass texels are written as glass, not as the reflected photo: base colour the region's measured interior (the
 * darker end of its own photo texels), roughness of float glass, dielectric, so the viewer's environment gives the Fresnel
 * reflection. The projected photo is kept beside it as the fallback (photoAlbedo) and the provenance says so.
 *
 * Masonry: where the wall texels' photo luminance repeats along the height at one pitch in at least two panos (power
 * spectrum peak, prominence above the floor, the panos agreeing within 6 percent), the pitch, the joint width (the dark
 * trough of the folded profile) and the phase are recorded for the kernel's structured coursing pattern. Albedo is not
 * touched: its variation stays the photo's.
 *
 * Everything written is labelled photo-inferred with a per-region confidence. Nothing branches on a label: the decisions
 * read counts, shares and measured spectra. No invented detail: a region without agreeing evidence keeps the photo.
 */

import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import {
    packConfidenceTexel, unpackConfidenceTexel,
    type BakedTexturePlanes, type CourseReading, type DepthMap, type FacadeMaterialRecord, type FacadeMaterialRegion, type MaterialDecider,
    type ProjectionView, type TexelProvenance, type UvAtlas
} from '../../../common/spatial/texture-pass-contracts';
export type { CourseReading, FacadeMaterialFields, FacadeMaterialRecord, FacadeMaterialRegion, MaterialDecider } from '../../../common/spatial/texture-pass-contracts';
import { SRGB8_TO_LINEAR, linearToSrgb255 } from '../../../common/spatial/photogrammetric-delight';
import { MASK_UNREAD, MASK_YES, type MaterialEvidence, type SurfaceMaterialMask } from './facade-material-evidence';

export const FACADE_MATERIAL_SOURCE = 'facade-material-reading';
/** Roughness of float glass (a measured property of the material, not of the place) and of the walls the reading leaves. */
export const GLASS_ROUGHNESS = 0.05;
export const WALL_ROUGHNESS = 0.85;
/** Candidate regions smaller than this (m^2) are not read. */
export const MIN_REGION_M2 = 0.15;
/** Street View acceptance: distinct panos marking, and the share of seeing panos that mark. */
export const MIN_MARKING_PANOS = 2;
export const MIN_MARKING_SHARE = 2 / 3;
/**
 * Masonry: least spectral prominence (peak over the band's median power: the largest of ~700 periods of pure noise on one
 * strip reaches about 9), pano agreement, least period in pixels.
 */
export const COURSE_MIN_PROMINENCE = 12;
export const COURSE_AGREEMENT = 0.06;
export const COURSE_MIN_PERIOD_PX = 4;
export const COURSE_BIN_M = 0.005;
export const COURSE_PERIOD_RANGE_M: [number, number] = [0.04, 1.2];
/** A joint is at most this share of its pitch and this wide (mortar and ashlar joints are millimetres to a few centimetres). */
export const MAX_JOINT_SHARE = 0.25;
export const MAX_JOINT_WIDTH_M = 0.04;
/** Visibility tolerances for carrying a mask (as the projection's occluder test). */
const DEPTH_TOL_BASE_M = 0.2, DEPTH_TOL_PER_M = 0.02, MIN_COS = 0.375;

export interface FacadeMaterialResult {
    planes: BakedTexturePlanes;
    /** Per texel, 0..255: glass weight (the region's confidence) where read as glass. */
    glass: Uint8Array;
    /** Per texel roughness and metalness, 0..255. */
    roughness: Uint8Array;
    metalness: Uint8Array;
    /** Per texel: index + 1 into `record.courses`, 0 where no coursing was read. */
    course: Uint8Array;
    /** The photo albedo before the reading wrote glass (the fallback), RGBA8. */
    photoAlbedo: Uint8Array;
    /** Indices of the reading's entries in planes.provenance. */
    provenanceIndices: number[];
    record: FacadeMaterialRecord;
}

export interface FacadeMaterialInput {
    atlas: UvAtlas;
    planes: BakedTexturePlanes;
    views: ProjectionView[];
    evidence: MaterialEvidence;
    occluderDepth?: (v: ProjectionView) => DepthMap;
    contextDepth?: (v: ProjectionView) => DepthMap;
    /** Whether the projection de-lit its colour with a measured sun. */
    delit: boolean;
    /** Leave this pano's masks out (the leave-one-pano-out fit). */
    excludePano?: string;
    nodeNameOfMap?: (mapIndex: number) => string | undefined;
    signal?: AbortSignal;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

function aborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error('stopped'), { name: 'AbortError' });
}

function latticeAt(w: NonNullable<ProjectionView['warp']>, x: number, y: number, W: number, H: number): [number, number] {
    const fx = Math.min(w.gw - 1, Math.max(0, (x / W) * (w.gw - 1))), fy = Math.min(w.gh - 1, Math.max(0, (y / H) * (w.gh - 1)));
    const x0 = Math.min(w.gw - 2, Math.floor(fx)), y0 = Math.min(w.gh - 2, Math.floor(fy)), ax = fx - x0, ay = fy - y0, k = y0 * w.gw + x0;
    const bl = (a: Float32Array) => (a[k] * (1 - ax) + a[k + 1] * ax) * (1 - ay) + (a[k + w.gw] * (1 - ax) + a[k + w.gw + 1] * ax) * ay;
    return [bl(w.dx), bl(w.dy)];
}

/**
 * Calls `visit(texel, x, y, gsdM)` for every texel the view sees: in frame, facing it, not hidden by the occluder or the
 * context; (x, y) is the photo pixel through the pano's warp.
 */
export function forEachVisibleTexel(atlas: UvAtlas, view: ProjectionView, depths: Array<DepthMap | undefined>, visit: (t: number, x: number, y: number, gsdM: number) => void): void {
    const cam = view.camera;
    const { covered, gutter, position, normal } = atlas.texels;
    const W = cam.width, H = cam.height;
    const n = atlas.width * atlas.height;
    for (let t = 0; t < n; t++) {
        if (!covered[t] || gutter[t]) continue;
        const o = t * 3;
        const dx = position[o] - cam.eye[0], dy = position[o + 1] - cam.eye[1], dz = position[o + 2] - cam.eye[2];
        const z = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
        if (z <= 0.5) continue;
        let x = cam.cx + (cam.fx * (dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2])) / z;
        let y = cam.cy - (cam.fy * (dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2])) / z;
        if (!(x >= 1 && y >= 1 && x < W - 1 && y < H - 1)) continue;
        const dist = Math.hypot(dx, dy, dz);
        const cos = -(normal[o] * dx + normal[o + 1] * dy + normal[o + 2] * dz) / dist;
        if (cos < MIN_COS) continue;
        const pi = Math.floor(y) * W + Math.floor(x);
        const tol = DEPTH_TOL_BASE_M + DEPTH_TOL_PER_M * z;
        let hidden = false;
        for (const d of depths) {
            if (!d) continue;
            const v = d.depthM[pi];
            if (Number.isFinite(v) && v < 1e8 && v < z - tol) { hidden = true; break; }
        }
        if (hidden) continue;
        if (view.warp) { const w = latticeAt(view.warp, x, y, W, H); x = Math.min(W - 1.01, Math.max(0, x + w[0])); y = Math.min(H - 1.01, Math.max(0, y + w[1])); }
        visit(t, x, y, z / (cam.fx * cos));
    }
}

/** The tile face mask under a texel: 255 marked, 0 read and not marked, MASK_UNREAD otherwise. */
function tileVote(surfaces: SurfaceMaterialMask[], P: Vec3, N: Vec3, preferred?: number): { vote: number; face: number; c: number; r: number } {
    let best = -1, bestD = 0.45, bc = 0, br = 0;
    const tryFace = (k: number) => {
        const s = surfaces[k];
        const cosN = N[0] * s.normal[0] + N[1] * s.normal[1] + N[2] * s.normal[2];
        if (cosN < 0.85) return;
        const q: Vec3 = [P[0] - s.origin[0], P[1] - s.origin[1], P[2] - s.origin[2]];
        const d = Math.abs(q[0] * s.normal[0] + q[1] * s.normal[1] + q[2] * s.normal[2]);
        if (d > bestD) return;
        const a = q[0] * s.h[0] + q[1] * s.h[1] + q[2] * s.h[2], b = q[0] * s.w[0] + q[1] * s.w[1] + q[2] * s.w[2];
        const c = Math.floor((a - s.a0) / s.mppM), r = Math.floor((s.b1 - b) / s.mppM);
        if (c < 0 || r < 0 || c >= s.width || r >= s.height) return;
        best = k; bestD = d; bc = c; br = r;
    };
    if (preferred !== undefined && preferred >= 0) tryFace(preferred);
    if (best < 0) for (let k = 0; k < surfaces.length; k++) tryFace(k);
    if (best < 0) return { vote: MASK_UNREAD, face: -1, c: 0, r: 0 };
    return { vote: surfaces[best].mask[br * surfaces[best].width + bc], face: best, c: bc, r: br };
}

/** Power of a profile (zero-mean bins) at a period, by direct DFT; also the phase (radians) of the fundamental. */
function powerAt(profile: Float32Array, binM: number, periodM: number): { power: number; phase: number } {
    // phase referred to the profile's middle bin, so a pitch a hair off does not carry the phase far
    const k = (2 * Math.PI * binM) / periodM, c0 = profile.length >> 1;
    const ck = Math.cos(k), sk = Math.sin(k);
    let c = Math.cos(-k * c0), s = Math.sin(-k * c0), re = 0, im = 0;
    for (let i = 0; i < profile.length; i++) {
        const v = profile[i];
        if (v !== 0) { re += v * c; im += v * s; }
        const c2 = c * ck - s * sk; s = s * ck + c * sk; c = c2;
    }
    return { power: re * re + im * im, phase: Math.atan2(im, re) };
}

/**
 * The course reading of one set of vertical strip profiles (zero-mean luminance in COURSE_BIN_M bins from world height
 * `y0`): the period of the strongest repeat within [minPeriod, max], its prominence, and the joint width and phase from the
 * profile folded at that period. Undefined when nothing repeats above the floor.
 */
export function readCourses(strips: Float32Array[], binM: number, y0: number, minPeriodM: number): { pitchM: number; prominence: number; jointWidthM: number; phaseM: number } | undefined {
    // the strips with most samples (at most 12), each covering at least 1.2 m of height
    const counted = strips.map(s => { let n = 0; for (let i = 0; i < s.length; i++) if (s[i] !== 0) n++; return { s, n }; }).filter(x => x.n * binM >= 1.2);
    const usable = counted.sort((a, b) => b.n - a.n).slice(0, 12).map(x => x.s);
    if (!usable.length) return undefined;
    const lo = Math.max(COURSE_PERIOD_RANGE_M[0], minPeriodM), hi = COURSE_PERIOD_RANGE_M[1];
    if (lo >= hi) return undefined;
    // log-spaced periods, 0.5 percent apart; power summed over strips (phase-free, so a pose roll does not smear it)
    const periods: number[] = [];
    for (let p = lo; p <= hi; p *= 1.005) periods.push(p);
    const power = periods.map(p => usable.reduce((s, st) => s + powerAt(st, binM, p).power, 0));
    let bi = 0;
    for (let i = 1; i < power.length; i++) if (power[i] > power[bi]) bi = i;
    if (bi === 0 || bi === power.length - 1) return undefined; // the band's edge: no peak inside it
    const sorted = [...power].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 1e-12;
    const prominence = power[bi] / median;
    // a peak that is the harmonic of a stronger repeat at twice the period is that repeat's (a course read at half its pitch)
    let pitch = periods[bi];
    const twice = periods.findIndex(p => p >= 2 * pitch);
    if (twice > 0 && power[twice] >= 0.7 * power[bi]) pitch = periods[twice];
    // fold every strip at the pitch, aligned on its own phase (the joint is the dark trough)
    const FOLD = 40;
    const fold = new Float64Array(FOLD), cnt = new Float64Array(FOLD);
    // the world phase from the strongest strip (strips' phases differ by the pose's roll; they are not averaged)
    let refPhase = 0, refPower = -1, refMid = 0;
    for (const st of usable) {
        const { phase, power: pw } = powerAt(st, binM, pitch);
        if (pw > refPower) { refPower = pw; refPhase = phase; refMid = st.length >> 1; }
        for (let i = 0; i < st.length; i++) {
            if (st[i] === 0) continue;
            const f = (((((i - (st.length >> 1)) * binM) / pitch) - phase / (2 * Math.PI)) % 1 + 1) % 1;
            const k = Math.min(FOLD - 1, Math.floor(f * FOLD));
            fold[k] += st[i]; cnt[k]++;
        }
    }
    const prof = Array.from(fold, (v, i) => (cnt[i] ? v / cnt[i] : 0));
    let mi = 0;
    for (let i = 1; i < FOLD; i++) if (prof[i] < prof[mi]) mi = i;
    const sortedP = [...prof].sort((a, b) => a - b);
    const med = sortedP[FOLD >> 1];
    const half = (prof[mi] + med) / 2;
    // the trough's extent below half depth on each side of its lowest bin; its centre is the joint's (a flat-bottomed
    // trough's lowest bin may be at one end of it)
    let right = 0, left = 0;
    for (let d = 1; d < FOLD / 2; d++) { if (prof[(mi + d) % FOLD] < half) right++; else break; }
    for (let d = 1; d < FOLD / 2; d++) { if (prof[(mi - d + FOLD) % FOLD] < half) left++; else break; }
    const w = 1 + left + right;
    const centre = mi + (right - left) / 2;
    const jointWidthM = (w / FOLD) * pitch;
    // world height of a joint centre: fold coordinate f = i*bin/pitch - phase/2pi; the trough at f = (mi + 0.5)/FOLD
    // bin i holds heights [i, i + 1) * binM: its centre is half a bin up
    const phaseM = y0 + (refMid + 0.5) * binM + (((centre + 0.5) / FOLD + refPhase / (2 * Math.PI)) * pitch);
    return { pitchM: r3(pitch), prominence: Math.round(prominence * 10) / 10, jointWidthM: r3(jointWidthM), phaseM: r3(((phaseM % pitch) + pitch) % pitch) };
}

/**
 * A strip's luminance profile (bin sums and counts) as relative contrast against its own 1.5 m moving average: the albedo's
 * and the light's slow change along the height is removed, the repeats under ~1.2 m stay. 0 where the bin has no sample.
 */
export function detrendProfile(sum: Float64Array, cnt: Uint32Array, binM: number, windowM = 1.5): Float32Array {
    const n = sum.length, half = Math.max(1, Math.round(windowM / binM / 2));
    const cs = new Float64Array(n + 1), cc = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { cs[i + 1] = cs[i] + sum[i]; cc[i + 1] = cc[i] + cnt[i]; }
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        if (!cnt[i]) continue;
        const a = Math.max(0, i - half), b = Math.min(n, i + half + 1);
        const m = (cs[b] - cs[a]) / Math.max(1, cc[b] - cc[a]);
        if (!(m > 1e-5)) continue;
        out[i] = (sum[i] / cnt[i] - m) / m + 1e-9;
    }
    return out;
}

/** The reading (see the file comment). Never throws for a source with nothing in it: the region keeps the photo. */
export function readFacadeMaterials(input: FacadeMaterialInput): FacadeMaterialResult {
    const t0 = Date.now();
    const timingsMs: Record<string, number> = {};
    const { atlas, evidence } = input;
    const W = atlas.width, H = atlas.height, N = W * H;
    const { covered, gutter, mapIndex, position, normal, sizeM } = atlas.texels;
    const isTarget = (t: number) => covered[t] && !gutter[t];

    // ---- Street View, pass 1: per texel, the panos that read it and the panos that marked it ----
    let t = Date.now();
    const maskOfView = new Map(evidence.views.map(m => [m.viewIndex, m]));
    const byPano = new Map<string, number[]>();
    input.views.forEach((v, i) => {
        if (!maskOfView.has(i) || v.panoId === input.excludePano || !(v.poseQuality > 0)) return;
        const l = byPano.get(v.panoId) ?? []; l.push(i); byPano.set(v.panoId, l);
    });
    const panoIds = [...byPano.keys()];
    const depthsOf = (v: ProjectionView) => [input.occluderDepth?.(v), input.contextDepth?.(v)];
    const svSeen = new Uint8Array(N), svMark = new Uint8Array(N);
    const state = new Uint8Array(N);
    /** state per pano: 1 read and not marked, 2 marked (a pano marks a texel any of its views marks). */
    const panoState = (pano: string, fill: Uint8Array) => {
        fill.fill(0);
        for (const vi of byPano.get(pano)!) {
            const v = input.views[vi], m = maskOfView.get(vi)!;
            const depths = depthsOf(v);
            forEachVisibleTexel(atlas, v, depths, (tx, x, y) => {
                const mv = m.mask[Math.floor(y) * m.width + Math.floor(x)];
                if (mv === MASK_UNREAD) return;
                const s = mv === MASK_YES ? 2 : 1;
                if (s > fill[tx]) fill[tx] = s;
            });
        }
    };
    for (const p of panoIds) {
        aborted(input.signal);
        panoState(p, state);
        for (let i = 0; i < N; i++) if (state[i]) { svSeen[i] = Math.min(255, svSeen[i] + 1); if (state[i] === 2) svMark[i] = Math.min(255, svMark[i] + 1); }
    }
    timingsMs.streetView = Date.now() - t;

    // ---- tile faces: per texel, read / marked ----
    t = Date.now();
    const surfaces = evidence.surfaces;
    const faceOfMap = new Map<number, number>();
    atlas.maps.forEach((m, i) => { const k = surfaces.findIndex(s => s.surfaceId === m.chartId); if (k >= 0) faceOfMap.set(i, k); });
    const tileState = new Uint8Array(N); // 0 none, 1 read no, 2 read yes
    const tileFace = new Int16Array(N).fill(-1);
    const tileRC = new Uint32Array(N);
    if (surfaces.length) {
        for (let i = 0; i < N; i++) {
            if (!isTarget(i)) continue;
            const o = i * 3;
            const v = tileVote(surfaces, [position[o], position[o + 1], position[o + 2]], [normal[o], normal[o + 1], normal[o + 2]], faceOfMap.get(mapIndex[i]));
            if (v.vote === MASK_UNREAD) continue;
            tileState[i] = v.vote === MASK_YES ? 2 : 1;
            tileFace[i] = v.face;
            tileRC[i] = v.r * 65536 + v.c;
        }
    }
    timingsMs.tile = Date.now() - t;

    // ---- candidate regions: connected marked texels on one map ----
    t = Date.now();
    const region = new Int32Array(N).fill(-1);
    const regions: Array<{ texels: number[]; map: number }> = [];
    // a candidate texel: at least half the panos that read it mark it, or the tile marks it (a mask leaking over a whole
    // facade in one pano does not join the window two other panos mark into one region with it)
    const cand = (i: number) => isTarget(i) && ((svMark[i] > 0 && 2 * svMark[i] >= svSeen[i]) || tileState[i] === 2);
    const stack: number[] = [];
    for (let i = 0; i < N; i++) {
        if (region[i] >= 0 || !cand(i)) continue;
        const id = regions.length, list: number[] = [];
        region[i] = id; stack.push(i);
        while (stack.length) {
            const j = stack.pop()!; list.push(j);
            const x = j % W, y = (j - x) / W;
            for (const k of [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, y > 0 ? j - W : -1, y < H - 1 ? j + W : -1]) {
                if (k >= 0 && region[k] < 0 && mapIndex[k] === mapIndex[i] && cand(k)) { region[k] = id; stack.push(k); }
            }
        }
        regions.push({ texels: list, map: mapIndex[i] });
    }
    const areaOf = (list: number[]) => list.reduce((s, j) => s + sizeM[j] * sizeM[j], 0);
    const live = regions.map(r => areaOf(r.texels) >= MIN_REGION_M2);
    timingsMs.regions = Date.now() - t;

    // ---- Street View, pass 2: per region, which panos see it and which mark it ----
    t = Date.now();
    const R = regions.length;
    const seenBy = regions.map(() => new Set<string>()), markedBy = regions.map(() => new Set<string>());
    const rs = new Float64Array(R), rm = new Float64Array(R);
    for (const p of panoIds) {
        aborted(input.signal);
        panoState(p, state);
        rs.fill(0); rm.fill(0);
        for (let r = 0; r < R; r++) {
            if (!live[r]) continue;
            for (const j of regions[r].texels) if (state[j]) { rs[r]++; if (state[j] === 2) rm[r]++; }
        }
        for (let r = 0; r < R; r++) {
            if (!live[r] || rs[r] < 0.5 * regions[r].texels.length) continue;
            seenBy[r].add(p);
            if (rm[r] >= 0.5 * rs[r]) markedBy[r].add(p);
        }
    }
    timingsMs.streetViewRegions = Date.now() - t;

    // ---- tile lattice and look, for tile-only regions ----
    const centroid = (list: number[], face: number): [number, number] | undefined => {
        let a = 0, b = 0, n = 0;
        for (const j of list) if (tileFace[j] === face) { a += tileRC[j] & 0xffff; b += tileRC[j] >>> 16; n++; }
        return n ? [a / n, b / n] : undefined;
    };
    const faceStats = new Map<number, { wallMean: number; wallCv: number }>();
    const statsOfFace = (k: number) => {
        let s = faceStats.get(k);
        if (s) return s;
        const f = surfaces[k];
        const vals: number[] = [];
        for (let i = 0; i < f.luminance.length; i++) if (f.mask[i] === 0 && Number.isFinite(f.luminance[i])) vals.push(f.luminance[i]);
        const m = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
        const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) * (b - m), 0) / Math.max(1, vals.length));
        s = { wallMean: m, wallCv: m > 0 ? sd / m : 0 };
        faceStats.set(k, s);
        return s;
    };

    // ---- decide ----
    const decided: FacadeMaterialRegion[] = [];
    const acceptedRegion = new Int32Array(R).fill(-1);
    const tileMarkedRegions = new Map<number, Array<{ r: number; c: [number, number]; n: number }>>();
    for (let r = 0; r < R; r++) {
        if (!live[r]) continue;
        const list = regions[r].texels;
        let read = 0, marked = 0, face = -1;
        for (const j of list) if (tileState[j]) { read++; if (tileState[j] === 2) marked++; if (face < 0) face = tileFace[j]; }
        if (read >= 0.5 * list.length && marked >= 0.5 * read && face >= 0) {
            const c = centroid(list, face);
            if (c) { const l = tileMarkedRegions.get(face) ?? []; l.push({ r, c, n: list.length }); tileMarkedRegions.set(face, l); }
        }
    }
    for (let r = 0; r < R; r++) {
        if (!live[r]) continue;
        const list = regions[r].texels;
        const see = seenBy[r].size, mark = markedBy[r].size;
        let read = 0, marked = 0, face = -1;
        for (const j of list) if (tileState[j]) { read++; if (tileState[j] === 2) marked++; if (face < 0) face = tileFace[j]; }
        const tileReadShare = read / list.length, tileMarked = read ? marked / read : null;
        const tileSupports = tileReadShare >= 0.5 && (tileMarked ?? 0) >= 0.5;
        const tileContradicts = tileReadShare >= 0.5 && (tileMarked ?? 1) < 0.2;
        const svShare = see ? mark / see : 0;
        const svSupports = mark >= MIN_MARKING_PANOS && svShare >= MIN_MARKING_SHARE;
        const svContradicts = see >= 2 && svShare < 1 / 3;
        let accepted = false, decidedBy: MaterialDecider = 'none', confidence = 0, reason = '';
        let lattice: FacadeMaterialRegion['evidence']['lattice'];
        if (svSupports && !tileContradicts) {
            accepted = true; decidedBy = tileSupports ? 'both' : 'street-view';
            confidence = svShare * (1 - Math.pow(0.5, mark)) + (tileSupports ? 0.15 : 0);
            reason = `${mark} of the ${see} panos that see it mark it${tileSupports ? ', and the tile does' : read ? ', the tile is not decisive' : ', the tile does not reach it'}`;
        } else if (svSupports && tileContradicts) {
            if (mark >= 3) { accepted = true; decidedBy = 'street-view'; confidence = 0.5 * svShare; reason = `${mark} of ${see} panos mark it; the tile does not (${Math.round((tileMarked ?? 0) * 100)}% of its read texels), so the confidence is halved`; }
            else reason = `${mark} of ${see} panos mark it but the tile does not (${Math.round((tileMarked ?? 0) * 100)}% of its read texels): the sources disagree`;
        } else if (mark === 1 && tileSupports && !svContradicts) {
            accepted = true; decidedBy = 'both'; confidence = 0.6 * (tileMarked ?? 0) * (see ? svShare : 1);
            reason = `one pano and the tile mark it (two independent captures)`;
        } else if (see === 0 && tileSupports) {
            // the tile alone: the measured raster must agree with what glass looks like on the face
            const c = face >= 0 ? centroid(list, face) : undefined;
            const others = (tileMarkedRegions.get(face) ?? []).filter(o => o.r !== r);
            let lum = 0, ln = 0, l2 = 0;
            const f = face >= 0 ? surfaces[face] : undefined;
            if (f) for (const j of list) if (tileFace[j] === face) { const v = f.luminance[(tileRC[j] >>> 16) * f.width + (tileRC[j] & 0xffff)]; if (Number.isFinite(v)) { lum += v; l2 += v * v; ln++; } }
            const mean = ln ? lum / ln : 0, cv = ln && mean > 0 ? Math.sqrt(Math.max(0, l2 / ln - mean * mean)) / mean : 0;
            const ws = face >= 0 ? statsOfFace(face) : { wallMean: 0, wallCv: 0 };
            const agree = latticeGlassAgreement({ centre: c, texels: list.length, others, tolPx: 0.3 / (face >= 0 ? surfaces[face].mppM : 1), mean, cv, ...ws });
            const { neighbours, darker, uniform } = agree;
            lattice = { neighbours, darker, uniform };
            if (agree.accepted) {
                accepted = true; decidedBy = 'tiles'; confidence = 0.5 * (tileMarked ?? 0) * (uniform ? 1 : 0.8);
                reason = `no pano sees it; the tile marks it, it sits in a row or column with ${neighbours} like regions and is darker${uniform ? ' and more uniform' : ''} than the face's wall`;
            } else reason = `no pano sees it; the tile marks it but the raster does not agree (${neighbours} like regions in line, ${darker ? 'darker' : 'not darker'}, ${uniform ? 'uniform' : 'not more uniform'} than the wall)`;
        } else {
            reason = see ? `${mark} of ${see} panos mark it${read ? `, the tile ${tileSupports ? 'does' : 'does not'}` : ''}: fewer than ${MIN_MARKING_PANOS} agreeing views` : read ? 'no pano sees it and the tile does not mark it' : 'no source read it';
        }
        confidence = Math.max(0, Math.min(1, confidence));
        if (accepted) acceptedRegion[r] = decided.length;
        decided.push({
            id: `m${regions[r].map}:g${r}`, mapIndex: regions[r].map, ...(input.nodeNameOfMap?.(regions[r].map) ? { nodeName: input.nodeNameOfMap(regions[r].map) } : {}),
            label: 'glass', texels: list.length, areaM2: r3(areaOf(list)),
            fields: { glassFraction: accepted ? 1 : 0, transmissiveLikelihood: accepted ? r3(confidence) : 0, roughness: accepted ? GLASS_ROUGHNESS : WALL_ROUGHNESS, metalness: 0, albedoLinear: [0, 0, 0], delit: input.delit },
            decidedBy, accepted, confidence: r3(confidence), reason,
            evidence: { panosSeeing: see, panosMarking: mark, panoIds: [...markedBy[r]], tileReadShare: r3(tileReadShare), tileMarkedShare: tileMarked === null ? null : r3(tileMarked), ...(lattice ? { lattice } : {}) }
        });
    }

    // ---- write glass: the measured interior, glass roughness, dielectric; provenance per decider ----
    t = Date.now();
    const planes: BakedTexturePlanes = { ...input.planes, albedo: Uint8Array.from(input.planes.albedo), confidence: { ...input.planes.confidence, data: Uint8Array.from(input.planes.confidence.data) }, provenance: [...input.planes.provenance] };
    const photoAlbedo = input.planes.albedo;
    const glass = new Uint8Array(N), roughness = new Uint8Array(N).fill(Math.round(WALL_ROUGHNESS * 255)), metalness = new Uint8Array(N);
    const entryOf = new Map<string, number>();
    const provenanceIndices: number[] = [];
    const lin = (v: number) => SRGB8_TO_LINEAR[v];
    for (let r = 0; r < R; r++) {
        const k = acceptedRegion[r];
        if (k < 0) continue;
        const reg = decided[k];
        const list = regions[r].texels.filter(j => planes.albedo[j * 4 + 3]);
        if (!list.length) { reg.accepted = false; reg.reason += '; no photo colour under it to measure the interior from'; acceptedRegion[r] = -1; continue; }
        // interior: the 10th percentile by luminance of the region's own photo texels (the least reflection the photos caught)
        const byLum = list.map(j => ({ j, l: 0.2126 * lin(photoAlbedo[j * 4]) + 0.7152 * lin(photoAlbedo[j * 4 + 1]) + 0.0722 * lin(photoAlbedo[j * 4 + 2]) })).sort((a, b) => a.l - b.l);
        const q = byLum[Math.floor((byLum.length - 1) * 0.1)].j;
        const interior: Vec3 = [lin(photoAlbedo[q * 4]), lin(photoAlbedo[q * 4 + 1]), lin(photoAlbedo[q * 4 + 2])];
        reg.fields.albedoLinear = interior.map(r3) as Vec3;
        const key = String(reg.decidedBy);
        let e = entryOf.get(key);
        if (e === undefined) {
            if (planes.provenance.length >= 255) { reg.accepted = false; reg.reason += '; the provenance list is full'; acceptedRegion[r] = -1; continue; }
            const panos = new Set<string>();
            for (const d of decided) if (d.accepted && d.decidedBy === reg.decidedBy) for (const p of d.evidence.panoIds) panos.add(p);
            planes.provenance.push({
                source: FACADE_MATERIAL_SOURCE, label: 'photo-inferred',
                method: `${evidence.target} read by open-vocabulary masks (${reg.decidedBy === 'both' ? 'Street View and the tile agreeing' : reg.decidedBy === 'tiles' ? 'the tile alone, in a measured lattice' : 'two or more Street View panos agreeing'}), drawn as glass: base colour the region's measured interior (its 10th-percentile photo texel), roughness ${GLASS_ROUGHNESS}, dielectric (the scene's environment gives the Fresnel reflection); the projected photo is kept as the fallback (photoAlbedo)`,
                ...(panos.size ? { panoIds: [...panos] } : {}), coverage: 0
            });
            e = planes.provenance.length - 1;
            entryOf.set(key, e);
            provenanceIndices.push(e);
        }
        const sr = [Math.round(linearToSrgb255(interior[0])), Math.round(linearToSrgb255(interior[1])), Math.round(linearToSrgb255(interior[2]))];
        // per texel, the sources that decided must agree there too: Street View by two panos (one where the tile also marks
        // it), the tile where it decided; a texel the tile read and did not mark is never written as glass
        const writes = (j: number): boolean => {
            if (tileState[j] === 1) return false;
            if (reg.decidedBy === 'tiles') return tileState[j] === 2;
            if (reg.decidedBy === 'both') return svMark[j] >= 2 || (svMark[j] >= 1 && tileState[j] === 2) || (svSeen[j] === 0 && tileState[j] === 2);
            return svMark[j] >= 2;
        };
        let written = 0;
        for (const j of regions[r].texels) {
            if (!planes.albedo[j * 4 + 3] || !writes(j)) continue;
            written++;
            planes.albedo[j * 4] = sr[0]; planes.albedo[j * 4 + 1] = sr[1]; planes.albedo[j * 4 + 2] = sr[2];
            const c = unpackConfidenceTexel(planes.confidence, j);
            packConfidenceTexel(planes.confidence, j, e, reg.confidence, c.rung);
            glass[j] = Math.max(1, Math.round(reg.confidence * 255));
            roughness[j] = Math.round(GLASS_ROUGHNESS * 255);
        }
        reg.fields.glassFraction = r3(written / regions[r].texels.length);
        if (!written) { reg.accepted = false; reg.reason += '; no texel has the sources agreeing on it'; }
    }
    timingsMs.write = Date.now() - t;

    // ---- masonry coursing on the walls (not glass) of each map ----
    t = Date.now();
    const course = new Uint8Array(N);
    const courses: CourseReading[] = [];
    const coursesRejected: FacadeMaterialRecord['coursesRejected'] = [];
    const mapTexels = new Map<number, number[]>();
    for (let i = 0; i < N; i++) {
        if (!isTarget(i) || glass[i] || region[i] >= 0) continue;
        const o = i * 3;
        if (Math.abs(normal[o + 1]) > 0.3) continue; // walls only: courses run along the height
        const l = mapTexels.get(mapIndex[i]) ?? []; l.push(i); mapTexels.set(mapIndex[i], l);
    }
    const wallRegions: FacadeMaterialRegion[] = [];
    for (const [m, list] of mapTexels) {
        aborted(input.signal);
        if (areaOf(list) < 4) continue;
        let yMin = Infinity, yMax = -Infinity;
        for (const j of list) { yMin = Math.min(yMin, position[j * 3 + 1] - sizeM[j]); yMax = Math.max(yMax, position[j * 3 + 1] + sizeM[j]); }
        const perPano: CourseReading['panos'] = [];
        for (const p of panoIds) {
            // the pano's finest view of this map
            let best: { vi: number; gsd: number } | undefined;
            for (const vi of byPano.get(p)!) {
                const v = input.views[vi];
                let g = 0, n = 0;
                const probe = list.filter((_, k) => k % Math.max(1, Math.floor(list.length / 200)) === 0);
                for (const j of probe) {
                    const o = j * 3, cam = v.camera;
                    const dx = position[o] - cam.eye[0], dy = position[o + 1] - cam.eye[1], dz = position[o + 2] - cam.eye[2];
                    const z = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
                    if (z <= 0.5) continue;
                    const x = cam.cx + (cam.fx * (dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2])) / z, y = cam.cy - (cam.fy * (dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2])) / z;
                    if (x < 0 || y < 0 || x >= cam.width || y >= cam.height) continue;
                    const cos = -(normal[o] * dx + normal[o + 1] * dy + normal[o + 2] * dz) / Math.hypot(dx, dy, dz);
                    if (cos < MIN_COS) continue;
                    g += z / (cam.fx * cos); n++;
                }
                if (n >= 0.3 * probe.length && n > 0 && (!best || g / n < best.gsd)) best = { vi, gsd: g / n };
            }
            if (!best) continue;
            const v = input.views[best.vi];
            const img = v.image;
            // bins of an eighth of the least readable period (5 mm at the finest)
            const binM = Math.max(COURSE_BIN_M, (COURSE_MIN_PERIOD_PX * best.gsd) / 8);
            const bins = Math.ceil((yMax - yMin) / binM) + 1;
            const nrm: Vec3 = [normal[list[0] * 3], 0, normal[list[0] * 3 + 2]];
            const hl = Math.hypot(nrm[0], nrm[2]) || 1;
            const hx = -nrm[2] / hl, hz = nrm[0] / hl; // horizontal along the wall
            const strips = new Map<number, { sum: Float64Array; cnt: Uint32Array }>();
            const lumAt = (x: number, y: number) => {
                const xi = Math.floor(x), yi = Math.floor(y), k = (yi * img.width + xi) * 4;
                return 0.2126 * SRGB8_TO_LINEAR[img.rgba[k]] + 0.7152 * SRGB8_TO_LINEAR[img.rgba[k + 1]] + 0.0722 * SRGB8_TO_LINEAR[img.rgba[k + 2]];
            };
            const inList = new Uint8Array(N);
            for (const j of list) inList[j] = 1;
            const cam = v.camera;
            forEachVisibleTexel(atlas, v, depthsOf(v), (j) => {
                if (!inList[j]) return;
                const o = j * 3;
                const strip = Math.floor((position[o] * hx + position[o + 2] * hz) / 1.0);
                let prof = strips.get(strip);
                if (!prof) { prof = { sum: new Float64Array(bins), cnt: new Uint32Array(bins) }; strips.set(strip, prof); }
                // sub-samples up the texel at the bin step, from the photo at its own resolution
                const K = Math.max(2, Math.round(sizeM[j] / binM));
                for (let k = 0; k < K; k++) {
                    const yy = position[o + 1] + ((k + 0.5) / K - 0.5) * sizeM[j];
                    const dx = position[o] - cam.eye[0], dy = yy - cam.eye[1], dz = position[o + 2] - cam.eye[2];
                    const z = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
                    let x = cam.cx + (cam.fx * (dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2])) / z, y = cam.cy - (cam.fy * (dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2])) / z;
                    if (v.warp) { const w = latticeAt(v.warp, x, y, cam.width, cam.height); x += w[0]; y += w[1]; }
                    if (!(x >= 0 && y >= 0 && x < img.width - 1 && y < img.height - 1)) continue;
                    const bi = Math.floor((yy - yMin) / binM);
                    if (bi >= 0 && bi < bins) { prof.sum[bi] += lumAt(x, y); prof.cnt[bi]++; }
                }
            });
            const c = readCourses([...strips.values()].map(st => detrendProfile(st.sum, st.cnt, binM)), binM, yMin, COURSE_MIN_PERIOD_PX * best.gsd);
            if (c && c.prominence >= COURSE_MIN_PROMINENCE) perPano.push({ panoId: p, pitchM: c.pitchM, prominence: c.prominence, jointWidthM: c.jointWidthM, phaseM: c.phaseM });
        }
        // the tile face, at its own resolution (only repeats of four texels or more)
        let tileCourse: CourseReading['tile'];
        const face = faceOfMap.get(m);
        if (face !== undefined) {
            const f = surfaces[face];
            const strips: Float32Array[] = [];
            const tileMin = COURSE_MIN_PERIOD_PX * Math.max(f.mppM, 0.15), binT = tileMin / 8;
            const binsT = Math.ceil((yMax - yMin) / binT) + 1;
            const step = Math.max(1, Math.round(1.0 / f.mppM));
            for (let c0 = 0; c0 < f.width; c0 += step) {
                const sum = new Float64Array(binsT), cnt = new Uint32Array(binsT);
                for (let r = 0; r < f.height; r++) for (let c = c0; c < Math.min(f.width, c0 + step); c++) {
                    const v = f.luminance[r * f.width + c];
                    if (!Number.isFinite(v) || f.mask[r * f.width + c] === MASK_YES) continue;
                    const y = f.origin[1] + f.w[1] * (f.b1 - (r + 0.5) * f.mppM);
                    const b = Math.floor((y - yMin) / binT);
                    if (b >= 0 && b < binsT) { sum[b] += v; cnt[b]++; }
                }
                strips.push(detrendProfile(sum, cnt, binT));
            }
            const c = readCourses(strips, binT, yMin, tileMin);
            if (c && c.prominence >= COURSE_MIN_PROMINENCE) tileCourse = { pitchM: c.pitchM, prominence: c.prominence };
        }
        // decide: two panos within the agreement, or one pano and the tile
        const pitches = perPano.map(p => p.pitchM).sort((a, b) => a - b);
        const med = pitches.length ? pitches[Math.floor(pitches.length / 2)] : 0;
        const agree = perPano.filter(p => Math.abs(p.pitchM - med) <= COURSE_AGREEMENT * med);
        const tileAgrees = !!tileCourse && med > 0 && Math.abs(tileCourse.pitchM - med) <= COURSE_AGREEMENT * med;
        let decidedBy: MaterialDecider = 'none';
        if (agree.length >= 2) decidedBy = tileAgrees ? 'both' : 'street-view';
        else if (agree.length === 1 && tileAgrees) decidedBy = 'both';
        const wallReg: FacadeMaterialRegion = {
            id: `m${m}:wall`, mapIndex: m, ...(input.nodeNameOfMap?.(m) ? { nodeName: input.nodeNameOfMap(m) } : {}), label: 'wall', texels: list.length, areaM2: r3(areaOf(list)),
            fields: { glassFraction: 0, transmissiveLikelihood: 0, roughness: WALL_ROUGHNESS, metalness: 0, albedoLinear: meanLinear(photoAlbedo, list), delit: input.delit },
            decidedBy, accepted: decidedBy !== 'none', confidence: 0, reason: '',
            evidence: { panosSeeing: perPano.length, panosMarking: agree.length, panoIds: agree.map(a => a.panoId), tileReadShare: face !== undefined ? 1 : 0, tileMarkedShare: null }
        };
        if (decidedBy === 'none') {
            const why = !perPano.length && !tileCourse ? 'no pano or tile view resolves a repeat along the height above the floor' : `the readings do not agree (${perPano.map(p => `${p.pitchM} m`).join(', ') || 'no pano'}${tileCourse ? `, tile ${tileCourse.pitchM} m` : ''})`;
            coursesRejected.push({ mapIndex: m, reason: why });
            wallReg.reason = `no coursing: ${why}`;
            wallRegions.push(wallReg);
            continue;
        }
        // a joint is thin against its unit: a dark band wider than that is a moulding, a string course or a shadow line
        const jwMean = agree.reduce((s2, a) => s2 + a.jointWidthM, 0) / agree.length;
        const pitchMean = agree.reduce((s2, a) => s2 + a.pitchM, 0) / agree.length;
        if (jwMean > Math.min(MAX_JOINT_SHARE * pitchMean, MAX_JOINT_WIDTH_M)) {
            const why = `the repeat every ${r3(pitchMean)} m has a dark band ${Math.round(jwMean * 1000)} mm wide: wider than a joint (at most ${Math.round(MAX_JOINT_SHARE * 100)}% of the pitch and ${Math.round(MAX_JOINT_WIDTH_M * 1000)} mm), so it is not drawn as coursing`;
            coursesRejected.push({ mapIndex: m, reason: why });
            wallReg.decidedBy = 'none'; wallReg.accepted = false; wallReg.reason = `no coursing: ${why}`;
            wallRegions.push(wallReg);
            continue;
        }
        const bestP = [...agree].sort((a, b) => b.prominence - a.prominence)[0];
        const pitch = r3(agree.reduce((s, a) => s + a.pitchM, 0) / agree.length);
        const jw = r3(Math.min(0.5 * pitch, agree.reduce((s, a) => s + a.jointWidthM, 0) / agree.length));
        const conf = r3(Math.min(1, agree.length / Math.max(1, perPano.length)) * (1 - Math.pow(0.5, agree.length + (tileAgrees ? 1 : 0))));
        const id = `c${courses.length}`;
        courses.push({ id, mapIndices: [m], pitchM: pitch, jointWidthM: jw, jointDepthM: r3(jw / 2), phaseM: bestP.phaseM, decidedBy, panos: agree, ...(tileCourse ? { tile: tileCourse } : {}), confidence: conf });
        if (courses.length <= 254) for (const j of list) course[j] = courses.length;
        wallReg.fields.coursePitchM = pitch; wallReg.fields.jointWidthM = jw; wallReg.confidence = conf;
        wallReg.reason = `courses every ${pitch} m (${agree.length} pano${agree.length === 1 ? '' : 's'}${tileAgrees ? ' and the tile' : ''} agree within ${Math.round(COURSE_AGREEMENT * 100)}%), joints ${Math.round(jw * 1000)} mm`;
        wallRegions.push(wallReg);
    }
    // a coursed texel keeps its colour's provenance entry (the albedo is the photo's); the coursing is in the record and the extras
    timingsMs.courses = Date.now() - t;

    const accepted = decided.filter(d => d.accepted);
    const byDecider: Record<string, number> = {};
    for (const d of accepted) byDecider[d.decidedBy] = (byDecider[d.decidedBy] ?? 0) + 1;
    let glassTexels = 0, total = 0, courseTexels = 0;
    for (let i = 0; i < N; i++) if (isTarget(i)) { total++; if (glass[i]) glassTexels++; if (course[i]) courseTexels++; }
    timingsMs.total = Date.now() - t0;
    return {
        planes, glass, roughness, metalness, course, photoAlbedo, provenanceIndices,
        record: {
            target: evidence.target, regions: [...wallRegions, ...decided], courses, coursesRejected,
            totals: { glassTexels, glassShare: total ? r3(glassTexels / total) : 0, candidates: decided.length, accepted: accepted.length, rejected: decided.length - accepted.length, byDecider, courseTexels },
            sources: { views: input.views.length, viewMasks: evidence.views.length, tileFaces: evidence.surfaces.length, unavailable: evidence.unavailable, models: evidence.models, calls: evidence.calls, failedCalls: evidence.failedCalls, gatherMs: evidence.ms },
            timingsMs
        }
    };
}

function meanLinear(rgba: Uint8Array, list: number[]): Vec3 {
    let r = 0, g = 0, b = 0, n = 0;
    for (const j of list) { if (!rgba[j * 4 + 3]) continue; r += SRGB8_TO_LINEAR[rgba[j * 4]]; g += SRGB8_TO_LINEAR[rgba[j * 4 + 1]]; b += SRGB8_TO_LINEAR[rgba[j * 4 + 2]]; n++; }
    return n ? [r3(r / n), r3(g / n), r3(b / n)] : [0, 0, 0];
}

/**
 * Whether a tile-only glass candidate agrees with what glass looks like on its face: at least two like regions (half to
 * twice its size) in its row or column (centres within tolPx), and darker than the face's wall (its interior). Darker is
 * required: on Washington Square Arch the masks proposed uniform marble panels in rows as glass (not darker than the
 * stone); glass in the tile's blended photos shows its dark interior. Local to this (non-K) reading: pipeline K's
 * `material-regions.ts` gets its openings from `window-fit.ts` and does not call this function.
 */
export function latticeGlassAgreement(o: { centre: [number, number] | undefined; texels: number; others: Array<{ c: [number, number]; n: number }>; tolPx: number; mean: number; cv: number; wallMean: number; wallCv: number }): { neighbours: number; darker: boolean; uniform: boolean; accepted: boolean } {
    const c = o.centre;
    const neighbours = c ? o.others.filter(x => (Math.abs(x.c[0] - c[0]) < o.tolPx || Math.abs(x.c[1] - c[1]) < o.tolPx) && x.n >= 0.5 * o.texels && x.n <= 2 * o.texels).length : 0;
    const darker = o.mean < 0.8 * o.wallMean, uniform = o.cv < 0.8 * o.wallCv;
    return { neighbours, darker, uniform, accepted: neighbours >= 2 && darker };
}

/** Per-texel material parameters for the viewer (RGBA8, sampled nearest): R glass weight, G coursing index + 1, B metalness, A 255. */
export function materialParamsImage(res: Pick<FacadeMaterialResult, 'glass' | 'course' | 'metalness'>): Uint8Array {
    const n = res.glass.length;
    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) { out[i * 4] = res.glass[i]; out[i * 4 + 1] = res.course[i]; out[i * 4 + 2] = res.metalness[i]; out[i * 4 + 3] = 255; }
    return out;
}

/** The record's provenance entries' coverage is recomputed by the pass (measurePlanes); this lists the reading's own. */
export function materialProvenance(planes: BakedTexturePlanes, indices: number[]): TexelProvenance[] {
    return indices.map(i => planes.provenance[i]).filter(Boolean);
}
