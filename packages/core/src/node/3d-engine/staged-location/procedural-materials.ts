/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The procedural district's surfaces in library materials (surface-materials.ts) instead of the tile photo:
 *   - the ground: split into regions by the colour of its lit texels (a lawn, a plaza, a footpath), one material each;
 *   - the streets: the carriageway and the kerbs, road-aligned UVs in metres, the lane markings as painted geometry;
 *   - the rebuilt buildings: per building, its walls and its roofs (and whatever the scan left standing on it), by each
 *     triangle's slope, never by a part's name.
 * The tile photo is measured (colours, and images the vision model reads to choose); none of its texels is drawn.
 */

import * as jpegJs from 'jpeg-js';
import type { ProvenanceRecord, StagedNodeExtras } from '../../../common/spatial/staged-location-contracts';
import type { SurfaceTextureEntry } from '../../../common/spatial/surface-texture-library';
import { rankSurfaceTextures, surfaceTint } from '../../../common/spatial/surface-texture-library';
import { writeStagedGlbFile, type StagedGlbNode } from './staged-glb-writer';
import type { TopDownPhoto, TopDownFrame } from './top-down-photo';
import type { RoadMesh, RoadMeshPart, RoadSurface } from './road-surfaces';
import type { GroundSurface } from './procedural-ground';
import type { MassingFace, MassingNode, MassingRun } from './pipeline-e/native-massing';
import { readFaceOrtho } from './pipeline-e/native-massing';
import { decodeImageInMemory } from './tile-texture-transfer';
import { isIdentity, nodeWorldMatrices, parseGlbBytes, readAccessor, transformPoint } from './glb-bytes';
import { renderTopDownPhoto } from './top-down-photo';
import type { VisionModelChain } from '../../gemini/vision-model-chain';
import type { LibraryFillSpec } from './texture-library-fill';
import { planarFrameUv, uniqueSurfaceMaterial, type UniqueSurfaceTexture } from './surface-overrides';
import {
    buildLibraryMaterials, chooseSurfaceMaterials, litColour, measuredColourField, COLOUR_FIELD_METHOD, COLOUR_FIELD_PARAMS, poolColours, scaleUv, surfaceMaterialLabel, triangleIsLevel, variationColors, worldUvMetres,
    SURFACE_MATERIALS_VERSION, type LibraryMaterialUse, type MeasuredColour, type SurfaceChoice, type SurfaceLibrary, type SurfaceSubject
} from './surface-materials';

export const PROCEDURAL_MATERIALS_VERSION = `procedural-materials/3+${SURFACE_MATERIALS_VERSION}`;

/**
 * The texture pass's distance gate on a procedural district's rebuilt surfaces (m): they stand off the scan by their fit
 * (walls snapped to facades, the ground a local median, the streets settled on it), so the tile photo is taken from the
 * scan surface within this, facing the same way (Federation Square, 2026-10-22: at 0.25 m only 2% of the streets' texels
 * found the scan).
 */
export const PROCEDURAL_TRANSFER_MAX_DISTANCE_M = 1.5;

/**
 * The texture pass's atlas side for a procedural district's layers: a district's walls at the tile photo's own texel
 * (~0.15 m) is some 14 million texels; at 2048 the pass shrank them to a third of that resolution and the facades read as
 * blurred camouflage beside the earlier photo pages (Federation Square, 2026-10-22).
 */
export const PROCEDURAL_ATLAS_MAX_SIDE = 4096;

const jpeg = (rgba: Uint8Array, width: number, height: number, q = 85): Uint8Array => new Uint8Array(jpegJs.encode({ data: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height }, q).data);

/** A square of the top-down photo around (x, z), `sizeM` across, as RGBA (rows toward +z). */
export function photoCrop(photo: TopDownPhoto, frame: TopDownFrame, x: number, z: number, sizeM: number): { rgba: Uint8Array; width: number; height: number } {
    const n = Math.max(8, Math.round(sizeM / photo.texelM));
    const px0 = Math.round((x - frame.x0) / photo.texelM - n / 2), py0 = Math.round((z - frame.z0) / photo.texelM - n / 2);
    const rgba = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) for (let xx = 0; xx < n; xx++) {
        const sx = Math.min(photo.width - 1, Math.max(0, px0 + xx)), sy = Math.min(photo.height - 1, Math.max(0, py0 + y));
        rgba.set(photo.rgba.subarray((sy * photo.width + sx) * 4, (sy * photo.width + sx) * 4 + 4), (y * n + xx) * 4);
        rgba[(y * n + xx) * 4 + 3] = 255;
    }
    return { rgba, width: n, height: n };
}

/** Up to four equal crops side by side (2 x 2), as one JPEG. */
export function mosaic(crops: Array<{ rgba: Uint8Array; width: number; height: number }>): { bytes: Uint8Array; width: number; height: number } {
    const c = crops.slice(0, 4), n = c[0].width, cols = c.length > 1 ? 2 : 1, rows = c.length > 2 ? 2 : 1;
    const W = n * cols, H = n * rows, out = new Uint8Array(W * H * 4).fill(255);
    c.forEach((im, k) => {
        const ox = (k % 2) * n, oy = Math.floor(k / 2) * n;
        for (let y = 0; y < Math.min(n, im.height); y++) out.set(im.rgba.subarray(y * im.width * 4, y * im.width * 4 + Math.min(n, im.width) * 4), ((oy + y) * W + ox) * 4);
    });
    return { bytes: jpeg(out, W, H), width: W, height: H };
}

// =============================================================================
// Ground regions
// =============================================================================

export const GROUND_REGION_PARAMS = {
    /** Cell of the segmentation (m): the ground mesh's own vertex spacing. */
    cellM: 2,
    /** Appearance clusters at most, and the CIELAB distance (lightness weighted down) under which two are one. */
    maxClusters: 5, lightnessWeight: 0.35, mergeDistance: 7, minShare: 0.02,
    /** A cell in shadow: darker than the lit cells around it by this much L* and bluer by this much b* (sky-lit shade). */
    shadowDarkerL: 10, shadowBluerB: 2.5, shadowWindowM: 24,
    /** Majority filter passes (5 x 5 cells). */
    majorityPasses: 2,
    /** A piece of ground smaller than this (m2) joins the nearest other piece within mergeReachM; at most this many pieces. */
    minRegionM2: 1500, maxRegions: 24, mergeReachM: 80,
    cropM: 20
};

export interface GroundRegions {
    x0: number; z0: number; nx: number; nz: number; cellM: number;
    /** Region per cell, -1 where none (outside, excluded or unmeasured). */
    region: Int16Array;
    regions: Array<{ measured: MeasuredColour; cells: number; centres: Array<[number, number]>; cluster: number; shadowedCells: number }>;
    stats: { cells: number; shadowedCells: number; clusters: number };
}

/**
 * The ground split by appearance into connected pieces (a lawn, a plaza, a footpath, a rail yard), each its own surface:
 *   - each cell's lit colour (litColour over its photo texels);
 *   - cells wholly in a cast shadow (darker and bluer than the lit cells around them) are not measured: they take the
 *     piece their lit neighbours belong to, so a building's shadow never becomes a material of its own;
 *   - k-means on CIELAB (lightness down-weighted), near clusters merged, a majority filter;
 *   - connected pieces of one cluster are separate regions (the same colour on a plaza and in a rail yard may be two
 *     materials), the small ones joined to their neighbour.
 * `include(x, z)` says which cells are ground to be measured (not a building, not a carriageway, inside the extraction).
 */
export function segmentGround(photo: TopDownPhoto, frame: TopDownFrame, include: (x: number, z: number) => boolean, P = GROUND_REGION_PARAMS): GroundRegions {
    const nx = Math.ceil(frame.widthM / P.cellM), nz = Math.ceil(frame.heightM / P.cellM), N = nx * nz;
    const region = new Int16Array(N).fill(-1);
    const colour: Array<MeasuredColour | undefined> = new Array(N);
    const inc = new Uint8Array(N);
    const per = Math.max(1, Math.round(P.cellM / photo.texelM));
    const buf = new Uint8Array(per * per * 4);
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        const cx = frame.x0 + (i + 0.5) * P.cellM, cz = frame.z0 + (k + 0.5) * P.cellM;
        if (!include(cx, cz)) continue;
        inc[k * nx + i] = 1;
        const px0 = Math.floor((cx - P.cellM / 2 - frame.x0) / photo.texelM), py0 = Math.floor((cz - P.cellM / 2 - frame.z0) / photo.texelM);
        let n = 0;
        for (let y = 0; y < per; y++) for (let x = 0; x < per; x++, n++) {
            const sx = px0 + x, sy = py0 + y;
            if (sx < 0 || sy < 0 || sx >= photo.width || sy >= photo.height) { buf[n * 4 + 3] = 0; continue; }
            buf.set(photo.rgba.subarray((sy * photo.width + sx) * 4, (sy * photo.width + sx) * 4 + 4), n * 4);
            buf[n * 4 + 3] = 255;
        }
        colour[k * nx + i] = litColour(buf, { stride: 1, minTexels: 20 });
    }
    // cast shadow: darker and bluer than the brighter cells within the window
    const shadow = new Uint8Array(N);
    const R = Math.max(1, Math.round(P.shadowWindowM / P.cellM / 2)), step = Math.max(1, Math.round(R / 4));
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        const c = colour[k * nx + i];
        if (!c) continue;
        const Ls: number[] = [], Bs: number[] = [];
        for (let dz = -R; dz <= R; dz += step) for (let dx = -R; dx <= R; dx += step) {
            const ii = i + dx, kk = k + dz;
            const o = ii >= 0 && kk >= 0 && ii < nx && kk < nz ? colour[kk * nx + ii] : undefined;
            if (o) { Ls.push(o.lab[0]); Bs.push(o.lab[2]); }
        }
        if (Ls.length < 6) continue;
        const order = Ls.map((_, q) => q).sort((p, q) => Ls[p] - Ls[q]).slice(Math.floor(Ls.length * 0.6));
        const refL = order.map(q => Ls[q]).sort((p, q) => p - q)[order.length >> 1], refB = order.map(q => Bs[q]).sort((p, q) => p - q)[order.length >> 1];
        if (c.lab[0] < refL - P.shadowDarkerL && c.lab[2] < refB - P.shadowBluerB) shadow[k * nx + i] = 1;
    }
    const lit: Array<{ i: number; f: [number, number, number] }> = [];
    for (let i = 0; i < N; i++) { const c = colour[i]; if (c && !shadow[i]) lit.push({ i, f: [c.lab[0] * P.lightnessWeight, c.lab[1], c.lab[2]] }); }
    const out: GroundRegions = { x0: frame.x0, z0: frame.z0, nx, nz, cellM: P.cellM, region, regions: [], stats: { cells: inc.reduce((a, v) => a + v, 0), shadowedCells: shadow.reduce((a, v) => a + v, 0), clusters: 0 } };
    if (!lit.length) return out;
    // k-means, farthest-point seeds (deterministic), on a sample when there are many cells
    const d2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    const sample = lit.length > 6000 ? lit.filter((_, q) => q % Math.ceil(lit.length / 6000) === 0) : lit;
    const meanF = sample.reduce((m, c) => [m[0] + c.f[0] / sample.length, m[1] + c.f[1] / sample.length, m[2] + c.f[2] / sample.length], [0, 0, 0]);
    let centres: number[][] = [sample.reduce((b, c) => (d2(c.f, meanF) < d2(b.f, meanF) ? c : b)).f.slice()];
    while (centres.length < P.maxClusters) {
        const far = sample.reduce((b, c) => (Math.min(...centres.map(z => d2(c.f, z))) > Math.min(...centres.map(z => d2(b.f, z))) ? c : b));
        if (Math.min(...centres.map(z => d2(far.f, z))) < P.mergeDistance ** 2) break;
        centres.push(far.f.slice());
    }
    const nearest = (f: number[]) => { let b = 0; centres.forEach((z, j) => { if (d2(f, z) < d2(f, centres[b])) b = j; }); return b; };
    for (let it = 0; it < 12; it++) {
        const sums = centres.map(() => [0, 0, 0, 0]);
        for (const c of sample) { const j = nearest(c.f); sums[j][0] += c.f[0]; sums[j][1] += c.f[1]; sums[j][2] += c.f[2]; sums[j][3]++; }
        centres = centres.map((z, j) => (sums[j][3] ? [sums[j][0] / sums[j][3], sums[j][1] / sums[j][3], sums[j][2] / sums[j][3]] : z));
    }
    for (let changed = true; changed;) {
        changed = false;
        const counts = centres.map(() => 0);
        for (const c of sample) counts[nearest(c.f)]++;
        const small = counts.findIndex(n => n < P.minShare * sample.length);
        let a = -1, b = -1;
        for (let p = 0; p < centres.length && a < 0; p++) for (let q = p + 1; q < centres.length; q++) if (d2(centres[p], centres[q]) < P.mergeDistance ** 2) { a = p; b = q; break; }
        if (small >= 0 && centres.length > 1) { centres.splice(small, 1); changed = true; }
        else if (a >= 0) { centres[a] = [0, 1, 2].map(q => (centres[a][q] * counts[a] + centres[b][q] * counts[b]) / Math.max(1, counts[a] + counts[b])); centres.splice(b, 1); changed = true; }
    }
    out.stats.clusters = centres.length;
    const cluster = new Int16Array(N).fill(-1);
    for (const c of lit) cluster[c.i] = nearest(c.f);
    // the shaded and unmeasured cells take their nearest lit neighbour's cluster (breadth first)
    let front = lit.map(c => c.i);
    while (front.length) {
        const next: number[] = [];
        for (const at of front) {
            const i = at % nx, k = (at - i) / nx;
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const ii = i + dx, kk = k + dz;
                if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
                const o = kk * nx + ii;
                if (!inc[o] || cluster[o] >= 0) continue;
                cluster[o] = cluster[at];
                next.push(o);
            }
        }
        front = next;
    }
    // majority filter (5 x 5)
    for (let pass = 0; pass < P.majorityPasses; pass++) {
        const next = Int16Array.from(cluster);
        const votes = new Int32Array(centres.length);
        for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
            const at = k * nx + i;
            if (cluster[at] < 0) continue;
            votes.fill(0);
            for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
                const ii = i + dx, kk = k + dz;
                if (ii >= 0 && kk >= 0 && ii < nx && kk < nz && cluster[kk * nx + ii] >= 0) votes[cluster[kk * nx + ii]]++;
            }
            let best = cluster[at];
            for (let j = 0; j < votes.length; j++) if (votes[j] > votes[best]) best = j;
            next[at] = best;
        }
        cluster.set(next);
    }
    // connected pieces of one cluster; then the smallest piece joins the nearest other piece (across a street or a
    // building if need be, its own cluster first at equal reach) until every piece is large enough and there are few enough
    const comp = new Int32Array(N).fill(-1), sizes: number[] = [];
    for (let s0 = 0; s0 < N; s0++) {
        if (cluster[s0] < 0 || comp[s0] >= 0) continue;
        const id = sizes.length, stack = [s0];
        comp[s0] = id;
        let n = 0;
        while (stack.length) {
            const at = stack.pop()!; n++;
            const i = at % nx, k = (at - i) / nx;
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const ii = i + dx, kk = k + dz;
                if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
                const o = kk * nx + ii;
                if (comp[o] < 0 && cluster[o] === cluster[at]) { comp[o] = id; stack.push(o); }
            }
        }
        sizes.push(n);
    }
    const parent = sizes.map((_, i) => i);
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const groupSize = new Map<number, number>(sizes.map((n, i) => [i, n]));
    const cellsOfComp: number[][] = sizes.map(() => []);
    for (let at = 0; at < N; at++) if (comp[at] >= 0) cellsOfComp[comp[at]].push(at);
    const minCells = Math.max(1, Math.round(P.minRegionM2 / (P.cellM * P.cellM)));
    const settled = new Set<number>();
    const reach = Math.round(P.mergeReachM / P.cellM);
    for (;;) {
        const open = [...groupSize].filter(([g]) => !settled.has(g)).sort((p, q) => p[1] - q[1]);
        if (!open.length) break;
        const [g, n] = open[0];
        if (n >= minCells && groupSize.size <= P.maxRegions) break;
        // the nearest cell of another group, breadth first from the group's own cells (through any cell)
        const seen = new Uint8Array(N);
        let front: number[] = [];
        for (const [c, root] of cellsOfComp.map((_, c) => [c, find(c)] as const)) if (root === g) for (const at of cellsOfComp[c]) { seen[at] = 1; front.push(at); }
        const myCluster = cluster[front[0]];
        let target = -1;
        for (let r = 0; r < reach && front.length && target < 0; r++) {
            const next: number[] = [];
            let other = -1;
            for (const at of front) {
                const i = at % nx, k = (at - i) / nx;
                for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const ii = i + dx, kk = k + dz;
                    if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
                    const o = kk * nx + ii;
                    if (seen[o]) continue;
                    seen[o] = 1;
                    if (comp[o] >= 0 && find(comp[o]) !== g) {
                        if (cluster[o] === myCluster) target = find(comp[o]); else if (other < 0) other = find(comp[o]);
                    }
                    next.push(o);
                }
            }
            if (target < 0 && other >= 0) target = other;
            front = next;
        }
        if (target < 0) { settled.add(g); continue; }
        parent[g] = target;
        groupSize.set(target, groupSize.get(target)! + n);
        groupSize.delete(g);
    }
    const groupOf = (at: number) => (comp[at] >= 0 ? find(comp[at]) : -1);
    // the regions: one per piece; its colour from its lit cells (at or above its median lightness), pooled
    const ids = [...groupSize.keys()].sort((p, q) => groupSize.get(q)! - groupSize.get(p)!);
    const idOf = new Map(ids.map((c, n) => [c, n]));
    for (let at = 0; at < N; at++) { const g = groupOf(at); if (g >= 0) region[at] = idOf.get(g)!; }
    out.regions = ids.map((c, n) => {
        const cellsOf: number[] = [];
        for (let at = 0; at < N; at++) if (region[at] === n) cellsOf.push(at);
        const litCells = cellsOf.filter(at => colour[at] && !shadow[at]);
        const pool = (litCells.length ? litCells : cellsOf.filter(at => colour[at]));
        const Ls = pool.map(at => colour[at]!.lab[0]).sort((p, q) => p - q), mid = Ls[Ls.length >> 1] ?? 0;
        const measured = poolColours(pool.filter(at => colour[at]!.lab[0] >= mid).map(at => colour[at]));
        // crop centres: the purest lit cells (most same-region cells in a 9 x 9), kept apart
        const purity = (at: number) => { const i = at % nx, k = (at - i) / nx; let q = 0; for (let dz = -4; dz <= 4; dz += 2) for (let dx = -4; dx <= 4; dx += 2) { const ii = i + dx, kk = k + dz; if (ii >= 0 && kk >= 0 && ii < nx && kk < nz && region[kk * nx + ii] === n) q++; } return q; };
        const ranked = (litCells.length ? litCells : cellsOf).map(at => ({ at, s: purity(at) })).sort((p, q) => q.s - p.s || p.at - q.at);
        const picks: Array<[number, number]> = [];
        for (const r of ranked) {
            const x = frame.x0 + ((r.at % nx) + 0.5) * P.cellM, z = frame.z0 + (Math.floor(r.at / nx) + 0.5) * P.cellM;
            if (picks.every(([px, pz]) => Math.hypot(px - x, pz - z) > P.cropM * 1.2)) picks.push([x, z]);
            if (picks.length >= 4) break;
        }
        return { measured: measured!, cells: cellsOf.length, centres: picks, cluster: cluster[cellsOf[0]], shadowedCells: cellsOf.filter(at => shadow[at]).length };
    }).filter(r => !!r.measured);
    return out;
}

/** The region of a point: its cell's, else the nearest measured cell's within `reach` cells, else the largest region. */
export function regionAt(g: GroundRegions, x: number, z: number, reach = 6): number {
    const i = Math.floor((x - g.x0) / g.cellM), k = Math.floor((z - g.z0) / g.cellM);
    const at = (ii: number, kk: number) => (ii >= 0 && kk >= 0 && ii < g.nx && kk < g.nz ? g.region[kk * g.nx + ii] : -1);
    if (at(i, k) >= 0) return at(i, k);
    for (let r = 1; r <= reach; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const v = at(i + dx, k + dz);
        if (v >= 0) return v;
    }
    let best = 0;
    g.regions.forEach((r, j) => { if (r.cells > g.regions[best].cells) best = j; });
    return best;
}

export function groundSubjects(g: GroundRegions, photo: TopDownPhoto, frame: TopDownFrame, P = GROUND_REGION_PARAMS): SurfaceSubject[] {
    return g.regions.map((r, j) => {
        const m = mosaic(r.centres.map(([x, z]) => photoCrop(photo, frame, x, z, P.cropM)));
        const tiles = Math.min(4, r.centres.length);
        return {
            key: `ground:${j}`, measured: r.measured,
            view: `open ground of the place seen straight down from above (${tiles} patch${tiles > 1 ? 'es' : ''} of ${P.cropM} x ${P.cropM} m from one connected piece of similar-looking ground, ${Math.round(r.cells * P.cellM * P.cellM)} m2 in all; the places where people walk, sit, wait or plant, not the roads; things standing on it, buildings at the edges and cast shadows are not the surface)`,
            image: { bytes: m.bytes, mimeType: 'image/jpeg', widthM: P.cropM * (tiles > 1 ? 2 : 1), heightM: P.cropM * (tiles > 2 ? 2 : 1) }
        };
    });
}

// =============================================================================
// Streets
// =============================================================================

/**
 * The carriageway's and the kerbs' subjects: lit colours sampled on the top-down photo (the carriageway kerb to kerb,
 * its outer tenth each side left out; the kerb a strip just outside each measured kerb line), and crops along the
 * longest runs for the vision model.
 */
export function roadSubjects(roads: RoadSurface[], photo: TopDownPhoto, frame: TopDownFrame, cropM = 16): { carriageway?: SurfaceSubject; kerbs?: SurfaceSubject } {
    const sample = (x: number, z: number, out: number[]) => {
        const px = Math.floor((x - frame.x0) / photo.texelM), py = Math.floor((z - frame.z0) / photo.texelM);
        if (px < 0 || py < 0 || px >= photo.width || py >= photo.height) return;
        const i = (py * photo.width + px) * 4;
        out.push(photo.rgba[i], photo.rgba[i + 1], photo.rgba[i + 2], 255);
    };
    const cw: number[] = [], kb: number[] = [];
    for (const r of roads) for (const s of r.stations) {
        const L = s.left.halfWidthM, R = s.right.halfWidthM;
        for (let t = 0.1; t <= 0.9; t += 0.05) { const d = -L + t * (L + R); sample(s.x + s.nx * d, s.z + s.nz * d, cw); }
        for (const [sd, sign] of [[s.left, -1], [s.right, 1]] as const) {
            if (sd.kerb !== 'measured') continue;
            for (const off of [0.1, 0.2]) { const d = sign * (sd.halfWidthM + off); sample(s.x + s.nx * d, s.z + s.nz * d, kb); }
        }
    }
    const longest = [...roads].sort((a, b) => b.lengthM - a.lengthM);
    const centres: Array<[number, number]> = [];
    for (const r of longest) {
        const s = r.stations[r.stations.length >> 1];
        if (s && centres.every(([x, z]) => Math.hypot(x - s.x, z - s.z) > cropM * 2)) centres.push([s.x, s.z]);
        if (centres.length >= 4) break;
    }
    if (!centres.length) return {};
    const m = mosaic(centres.map(([x, z]) => photoCrop(photo, frame, x, z, cropM)));
    const tiles = centres.length;
    const image = { bytes: m.bytes, mimeType: 'image/jpeg' as const, widthM: cropM * (tiles > 1 ? 2 : 1), heightM: cropM * (tiles > 2 ? 2 : 1) };
    const c = litColour(Uint8Array.from(cw), { minTexels: 50 }), k = litColour(Uint8Array.from(kb), { minTexels: 50 });
    return {
        ...(c ? { carriageway: { key: 'roads:carriageway', measured: c, image, view: `the driven surface of the streets seen straight down (${tiles} patches of ${cropM} x ${cropM} m centred on streets; the material between the kerbs, ignoring cars and painted lines)` } } : {}),
        ...(k ? { kerbs: { key: 'roads:kerbs', measured: k, image, view: `the kerbs: the edge stones along both sides of the streets, between the driven surface and the footpath (the same ${tiles} patches of ${cropM} x ${cropM} m seen straight down)` } } : {})
    };
}

// =============================================================================
// Writing the layers
// =============================================================================

function useOf(key: string, choice: SurfaceChoice, library: SurfaceLibrary, name: string): LibraryMaterialUse {
    const entry = library.entry(choice.entryId)!;
    return { name, entryId: choice.entryId, tint: surfaceTint(entry, choice.measured.linearRgb), extras: { ...surfaceMaterialLabel(choice, library, entry), surfaceKey: key } };
}

const sized = (e: SurfaceTextureEntry, uvM: Float32Array) => scaleUv(uvM, e.realSizeM);

/** What the ground and street writers lay under and over the library: the measured colour layer, and unique textures by surface key. */
export interface SurfaceLayers {
    /** The top-down tile photo and its frame: the measured colour layer (COLOR_0) is read from it. */
    field?: { photo: TopDownPhoto; frame: TopDownFrame };
    overrides?: Map<string, UniqueSurfaceTexture>;
}

/**
 * The ground GLB: the measured ground surface, one primitive per region, each in its library material at world scale over
 * the measured colour layer; a region with a unique texture gets that instead.
 */
export function writeLibraryGroundGlb(file: string, surf: GroundSurface, g: GroundRegions, choices: Map<string, SurfaceChoice>, library: SurfaceLibrary, extras: Record<string, unknown>, layers: SurfaceLayers = {}): { path: string; bytes: number; regions: Array<{ key: string; entryId: string; triangles: number; unique: boolean }>; field?: { measured: number; shadowed: number; unmeasured: number } } {
    const { positions, indices } = surf.mesh;
    const tris: number[][] = g.regions.map(() => []);
    for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
        tris[regionAt(g, (positions[a] + positions[b] + positions[c]) / 3, (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3)].push(indices[t], indices[t + 1], indices[t + 2]);
    }
    const used = g.regions.map((_, j) => j).filter(j => tris[j].length);
    const keyOf = (j: number) => `ground:${j}`;
    const library_ = used.filter(j => !layers.overrides?.has(keyOf(j)));
    const uses = library_.map(j => ({ ...useOf(keyOf(j), choices.get(keyOf(j))!, library, `Ground${j}_${choices.get(keyOf(j))!.entryId}`), ...(layers.field ? { variationMean: 1 / COLOUR_FIELD_PARAMS.headroom } : {}) }));
    const set = buildLibraryMaterials(library, uses);
    const materialOf = new Map<number, number>(library_.map((j, m) => [j, m]));
    for (const j of used) if (!materialOf.has(j)) { materialOf.set(j, set.materials.length); set.materials.push(uniqueSurfaceMaterial(layers.overrides!.get(keyOf(j))!, choices.get(keyOf(j)) ? { entryId: choices.get(keyOf(j))!.entryId } : undefined)); }
    // one UV per vertex: a vertex shared by two regions takes one tile size; split them so each region has its own
    const outPos: number[] = [], outUv: number[] = [], outRegion: number[] = [];
    const parts = used.map(j => {
        const o = layers.overrides?.get(keyOf(j));
        const e = o ? undefined : library.entry(choices.get(keyOf(j))!.entryId)!;
        const remap = new Map<number, number>(), idx: number[] = [];
        for (const v of tris[j]) {
            if (!remap.has(v)) {
                remap.set(v, outPos.length / 3);
                outPos.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
                outRegion.push(j);
                if (o) { const uv = planarFrameUv(o.frame, positions.subarray(v * 3, v * 3 + 3)); outUv.push(uv[0], uv[1]); }
                else outUv.push(positions[v * 3] / e!.realSizeM[0], positions[v * 3 + 2] / e!.realSizeM[1]);
            }
            idx.push(remap.get(v)!);
        }
        return { indices: Uint32Array.from(idx), material: materialOf.get(j)! };
    });
    const pos = Float32Array.from(outPos);
    // the measured colour layer under the library regions; a unique texture carries its own colour (COLOR_0 white there)
    const field = layers.field ? measuredColourField(layers.field.photo, layers.field.frame, pos, v => g.regions[outRegion[v]].measured) : undefined;
    const colors = field ? field.colors : variationColors(pos, 11);
    for (let v = 0; v < outRegion.length; v++) if (layers.overrides?.has(keyOf(outRegion[v]))) colors.fill(1, v * 3, v * 3 + 3);
    const fieldNote = field ? { colourLayer: { method: COLOUR_FIELD_METHOD, label: 'measured', measured: field.measured, shadowed: field.shadowed, unmeasured: field.unmeasured } } : {};
    const node: StagedGlbNode = { name: 'ground', positions: pos, uv: Float32Array.from(outUv), colors, parts, extras: { ...extras, ...fieldNote, surfaces: uses.map(u => ({ key: u.extras.surfaceKey, ...(u.extras.sbSurfaceMaterial as object) })) } };
    const w = writeStagedGlbFile(file, [node], { rootExtras: { sbGround: extras, sbSurfaceMaterials: { version: PROCEDURAL_MATERIALS_VERSION, bytesByEntry: set.bytesByEntry, ...fieldNote } }, generator: 'scratchbox staged-location procedural-ground (library materials)', materials: set.materials, extraImages: set.extraImages });
    return { ...w, regions: used.map(j => ({ key: keyOf(j), entryId: choices.get(keyOf(j))?.entryId ?? '', triangles: tris[j].length / 3, unique: !!layers.overrides?.has(keyOf(j)) })), ...(field ? { field: { measured: field.measured, shadowed: field.shadowed, unmeasured: field.unmeasured } } : {}) };
}

/**
 * The streets GLB: carriageways and kerbs in their library materials (the mesh built with metre UVs, buildRoadMesh(..,
 * 'metres')), the lane markings as painted ribbons in their measured colour.
 */
export function writeLibraryRoadsGlb(file: string, mesh: RoadMesh, markings: { positions: Float32Array; indices: Uint32Array; colors: Float32Array } | undefined, choices: { carriageway: SurfaceChoice; kerbs: SurfaceChoice }, library: SurfaceLibrary, extras: Record<string, unknown>, layers: SurfaceLayers = {}): { path: string; bytes: number; field?: { measured: number; shadowed: number; unmeasured: number } } {
    const cwKey = 'roads:carriageway', kbKey = 'roads:kerbs';
    const uses = [
        { ...useOf(cwKey, choices.carriageway, library, `Carriageway_${choices.carriageway.entryId}`), ...(layers.field ? { variationMean: 1 / COLOUR_FIELD_PARAMS.headroom } : {}) },
        useOf(kbKey, choices.kerbs, library, `Kerbs_${choices.kerbs.entryId}`)
    ];
    const set = buildLibraryMaterials(library, uses);
    const own = (key: string, k: number) => {
        const o = layers.overrides?.get(key);
        if (!o) return k;
        set.materials.push(uniqueSurfaceMaterial(o, { entryId: uses[k].entryId }));
        return set.materials.length - 1;
    };
    const cwMat = own(cwKey, 0), kbMat = own(kbKey, 1);
    const paint = set.materials.length;
    set.materials.push({
        name: 'LaneMarkingPaint', baseColorFactor: [1, 1, 1, 1], roughness: 0.55, metallic: 0,
        extras: {
            sbTexture: { confidenceTexture: '@image:confidence' },
            sbSurfaceMaterial: { schema: 'scratchbox.surface-material/1', version: SURFACE_MATERIALS_VERSION, provenance: 'vector-modelled', note: 'lane markings redrawn as geometry where the tile photo shows them (position, width, dash pattern and paint colour measured, COLOR_0 the paint colour); no photo texel is drawn', measuredColour: { label: 'measured', method: 'the median of the marking\'s painted samples on the top-down tile photo' } }
        }
    });
    const part = (p: RoadMeshPart, key: string, k: number) => {
        const o = layers.overrides?.get(key);
        return { ...p, uv: o ? planarFrameUv(o.frame, p.positions) : sized(library.entry(uses[k].entryId)!, Float32Array.from(p.uv)) };
    };
    const nodes: StagedGlbNode[] = [];
    const cw = part(mesh.carriageway, cwKey, 0), kb = part(mesh.kerbs, kbKey, 1);
    const field = layers.field && cw.indices.length && !layers.overrides?.has(cwKey) ? measuredColourField(layers.field.photo, layers.field.frame, cw.positions, () => choices.carriageway.measured) : undefined;
    const fieldNote = field ? { colourLayer: { method: COLOUR_FIELD_METHOD, label: 'measured', measured: field.measured, shadowed: field.shadowed, unmeasured: field.unmeasured } } : {};
    const white = (n: number) => new Float32Array(n * 3).fill(1);
    if (cw.indices.length) nodes.push({ name: 'carriageway', ...cw, colors: layers.overrides?.has(cwKey) ? white(cw.positions.length / 3) : field ? field.colors : variationColors(cw.positions, 21), material: cwMat, extras: { ...extras, part: 'carriageway', ...fieldNote, ...surfaceMaterialLabel(choices.carriageway, library) } });
    if (kb.indices.length) nodes.push({ name: 'kerbs', ...kb, colors: layers.overrides?.has(kbKey) ? white(kb.positions.length / 3) : variationColors(kb.positions, 22), material: kbMat, extras: { ...extras, part: 'kerbs', ...surfaceMaterialLabel(choices.kerbs, library) } });
    if (markings?.indices.length) nodes.push({ name: 'markings', positions: markings.positions, indices: markings.indices, colors: markings.colors, material: paint, extras: { ...extras, part: 'markings' } });
    const w = writeStagedGlbFile(file, nodes, { rootExtras: { sbRoads: extras, sbSurfaceMaterials: { version: PROCEDURAL_MATERIALS_VERSION, bytesByEntry: set.bytesByEntry, ...fieldNote } }, generator: 'scratchbox staged-location road-surfaces (library materials)', materials: set.materials, extraImages: set.extraImages });
    return { ...w, ...(field ? { field: { measured: field.measured, shadowed: field.shadowed, unmeasured: field.unmeasured } } : {}) };
}

// =============================================================================
// The buildings
// =============================================================================

function pointInLoop(loop: Array<[number, number]>, x: number, z: number): boolean {
    let inside = false;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
        const [xi, zi] = loop[i], [xj, zj] = loop[j];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi) inside = !inside;
    }
    return inside;
}

/**
 * Which building each node belongs to: a massing face's part (its id under the building's), or for what the scan left
 * (residual) the building whose part outlines hold most of its vertices, else the nearest outline.
 */
export function nodeBuildings(run: Pick<MassingRun, 'nodes' | 'report'>, buildingIds: string[]): Array<string | undefined> {
    const ids = [...buildingIds].sort((a, b) => b.length - a.length);
    const ofPart = (part: string) => ids.find(id => part === id || part.startsWith(`${id}/`));
    const faces = new Map(run.report.faces.map(f => [f.index, f]));
    const parts = run.report.parts.map(p => ({ b: ofPart(p.id), loops: p.loops }));
    return run.nodes.map(n => {
        const votes = new Map<string, number>();
        const nv = n.positions.length / 3, step = Math.max(1, Math.floor(nv / 64));
        for (let v = 0; v < nv; v += step) {
            const f = n.ref[v] >= 0 ? faces.get(n.ref[v]) : undefined;
            let b = f ? ofPart(f.part) : undefined;
            if (!b) {
                const x = n.positions[v * 3], z = n.positions[v * 3 + 2];
                b = parts.find(p => p.b && p.loops.some(l => pointInLoop(l, x, z)))?.b;
                if (!b) {
                    let best = Infinity;
                    for (const p of parts) for (const l of p.loops) for (const [px, pz] of l) { const d = Math.hypot(px - x, pz - z); if (d < best && p.b) { best = d; b = p.b; } }
                }
            }
            if (b) votes.set(b, (votes.get(b) ?? 0) + 1);
        }
        let best: string | undefined, bv = 0;
        for (const [b, v] of votes) if (v > bv) { best = b; bv = v; }
        return best;
    });
}

export interface BuildingSurfaceMeasure { building: string; walls?: MeasuredColour; roofs?: MeasuredColour; wallFace?: MassingFace; roofFace?: MassingFace }

/** Per building: the lit colour of its walls and of its roofs on their tile orthos, and the best-seen face of each for the vision model. */
export function measureBuildingSurfaces(run: Pick<MassingRun, 'dir' | 'report'>, buildingIds: string[]): BuildingSurfaceMeasure[] {
    const ids = [...buildingIds].sort((a, b) => b.length - a.length);
    const ofPart = (part: string) => ids.find(id => part === id || part.startsWith(`${id}/`));
    const by = new Map<string, { walls: MeasuredColour[]; roofs: MeasuredColour[]; wallFace?: MassingFace; roofFace?: MassingFace }>();
    for (const f of run.report.faces) {
        if (!f.width || !f.height || f.coverage <= 0) continue;
        const b = ofPart(f.part);
        if (!b) continue;
        const o = readFaceOrtho(run.dir, f);
        if (!o) continue;
        const c = litColour(o.rgba, { stride: 1, minTexels: 30 });
        if (!c) continue;
        const e = by.get(b) ?? { walls: [], roofs: [] };
        const level = Math.abs(f.normal[1]) >= 0.6;
        (level ? e.roofs : e.walls).push(c);
        const seen = (x?: MassingFace) => (x ? x.area * x.coverage : 0);
        if (level) { if (f.normal[1] > 0 && seen(f) > seen(e.roofFace)) e.roofFace = f; } else if (seen(f) > seen(e.wallFace)) e.wallFace = f;
        by.set(b, e);
    }
    return buildingIds.map(b => {
        const e = by.get(b);
        return { building: b, ...(e?.walls.length ? { walls: poolColours(e.walls) } : {}), ...(e?.roofs.length ? { roofs: poolColours(e.roofs) } : {}), ...(e?.wallFace ? { wallFace: e.wallFace } : {}), ...(e?.roofFace ? { roofFace: e.roofFace } : {}) };
    });
}

/** A face's tile ortho as a JPEG for the vision model (longest side at most `maxPx`), the uncovered texels grey. */
export function faceImage(run: Pick<MassingRun, 'dir'>, f: MassingFace, maxPx = 512): SurfaceSubject['image'] | undefined {
    const o = readFaceOrtho(run.dir, f);
    if (!o) return undefined;
    const s = Math.min(1, maxPx / Math.max(o.width, o.height));
    const W = Math.max(1, Math.round(o.width * s)), H = Math.max(1, Math.round(o.height * s));
    const out = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const si = (Math.min(o.height - 1, Math.floor(y / s)) * o.width + Math.min(o.width - 1, Math.floor(x / s))) * 4, di = (y * W + x) * 4;
        if (o.rgba[si + 3] >= 128) out.set(o.rgba.subarray(si, si + 3), di); else out.fill(128, di, di + 3);
        out[di + 3] = 255;
    }
    return { bytes: jpeg(out, W, H), mimeType: 'image/jpeg', widthM: o.width * f.pixel, heightM: o.height * f.pixel };
}

/** The vision subjects of the buildings (walls and roofs); a building whose surface was not seen borrows the district's pooled colour (labelled by the caller). */
export function buildingSubjects(run: Pick<MassingRun, 'dir'>, measures: BuildingSurfaceMeasure[]): { subjects: SurfaceSubject[]; borrowed: string[] } {
    const pooled = { walls: poolColours(measures.map(m => m.walls)), roofs: poolColours(measures.map(m => m.roofs)) };
    const subjects: SurfaceSubject[] = [], borrowed: string[] = [];
    for (const m of measures) for (const kind of ['walls', 'roofs'] as const) {
        const face = kind === 'walls' ? m.wallFace : m.roofFace;
        const measured = m[kind] ?? pooled[kind] ?? pooled.walls ?? pooled.roofs;
        if (!measured) continue;
        const image = face ? faceImage(run, face) : undefined;
        const key = `building:${m.building}:${kind}`;
        if (!m[kind]) borrowed.push(key);
        if (!image) continue;
        subjects.push({
            key, measured,
            view: kind === 'walls' ? 'one outside wall of a building, seen face-on (an orthographic projection of the aerial photo onto the wall; grey where the photo did not see it)' : 'the roof of a building seen from straight above (grey where the photo did not see it)',
            image
        });
    }
    return { subjects, borrowed };
}

export interface MassingMaterialPlan {
    /** Per building, the choice for its walls and for its roofs. */
    choices: Map<string, SurfaceChoice>;
}

/**
 * The rebuilt buildings' GLB: the native run's nodes as triangle soup (so each triangle has its own world-scale UVs),
 * each triangle drawn with its building's wall or roof material by its slope; node extras keep the massing's provenance
 * with the surface materials beside it.
 */
export function writeLibraryMassingGlb(file: string, run: Pick<MassingRun, 'nodes' | 'report'>, input: {
    buildingOf: Array<string | undefined>; choices: Map<string, SurfaceChoice>; fallback: { walls: SurfaceChoice; roofs: SurfaceChoice };
    library: SurfaceLibrary; provenanceOf: (n: MassingNode) => ProvenanceRecord; stage: string; stageKey: string;
    /** Unique textures by node name (one face each): they supersede the library on that node. */
    overrides?: Map<string, UniqueSurfaceTexture>;
}): { path: string; bytes: number; materials: number; triangles: number } {
    const keyOf = (b: string | undefined, kind: 'walls' | 'roofs') => (b && input.choices.has(`building:${b}:${kind}`) ? `building:${b}:${kind}` : `district:${kind}`);
    const choiceOf = (key: string) => input.choices.get(key) ?? (key.endsWith('walls') ? input.fallback.walls : input.fallback.roofs);
    const keys = new Set<string>();
    const tri = run.nodes.map((n, ni) => {
        const b = input.buildingOf[ni];
        const level = new Uint8Array(n.indices.length / 3);
        for (let t = 0; t < level.length; t++) { level[t] = triangleIsLevel(n.positions, n.indices, t * 3) ? 1 : 0; keys.add(keyOf(b, level[t] ? 'roofs' : 'walls')); }
        return level;
    });
    const keyList = [...keys];
    const matIndex = new Map(keyList.map((k, i) => [k, i]));
    const uses = keyList.map(k => useOf(k, choiceOf(k), input.library, k.replace(/[^\w]+/g, '_')));
    const set = buildLibraryMaterials(input.library, uses);
    let triangles = 0;
    const nodes: StagedGlbNode[] = run.nodes.map((n, ni) => {
        const T = n.indices.length / 3;
        const positions = new Float32Array(T * 9), normals = new Float32Array(T * 9);
        for (let k = 0; k < T * 3; k++) { const v = n.indices[k]; positions.set(n.positions.subarray(v * 3, v * 3 + 3), k * 3); normals.set(n.normals.subarray(v * 3, v * 3 + 3), k * 3); }
        const soup = Uint32Array.from({ length: T * 3 }, (_, i) => i);
        const b = input.buildingOf[ni];
        const o = input.overrides?.get(n.name);
        if (o) {
            // a unique texture made for this face supersedes the library on it
            triangles += T;
            set.materials.push(uniqueSurfaceMaterial(o, { building: b ?? null }));
            const extras = { sb: { schema: 'scratchbox.staged-node/2', stage: input.stage, provenance: input.provenanceOf(n), buildOrder: ni, buildCount: run.nodes.length, revealKind: n.kind === 'residual' ? 'appear' : 'rise', reveal: { attribute: null, displacement: null, durationShare: 1 / Math.max(1, run.nodes.length) }, ids: { surfaceId: n.name }, counts: { vertices: T * 3, triangles: T } }, ...(b ? { building: b } : {}), surfaceMaterials: [{ key: n.name, unique: true, provenance: 'generated' }] };
            return { name: n.name, positions, normals, uv: planarFrameUv(o.frame, positions), colors: new Float32Array(T * 9).fill(1), indices: soup, material: set.materials.length - 1, extras };
        }
        const uvM = worldUvMetres(positions, soup);
        const groups = new Map<number, number[]>();
        for (let t = 0; t < T; t++) {
            const m = matIndex.get(keyOf(b, tri[ni][t] ? 'roofs' : 'walls'))!;
            const e = input.library.entry(uses[m].entryId)!;
            for (let k = 0; k < 3; k++) { uvM[(t * 3 + k) * 2] /= e.realSizeM[0]; uvM[(t * 3 + k) * 2 + 1] /= e.realSizeM[1]; }
            const g = groups.get(m) ?? [];
            g.push(t * 3, t * 3 + 1, t * 3 + 2);
            groups.set(m, g);
        }
        triangles += T;
        const extras: StagedNodeExtras & Record<string, unknown> = {
            sb: {
                schema: 'scratchbox.staged-node/2', stage: input.stage, provenance: input.provenanceOf(n), buildOrder: ni, buildCount: run.nodes.length,
                revealKind: n.kind === 'residual' ? 'appear' : 'rise', reveal: { attribute: null, displacement: null, durationShare: 1 / Math.max(1, run.nodes.length) },
                ids: { surfaceId: n.name }, counts: { vertices: T * 3, triangles: T }
            },
            ...(b ? { building: b } : {}),
            surfaceMaterials: [...groups.keys()].map(m => ({ key: keyList[m], entryId: uses[m].entryId, provenance: 'generated' }))
        };
        return { name: n.name, positions, normals, uv: uvM, colors: variationColors(positions, 31), parts: [...groups].map(([material, idx]) => ({ indices: Uint32Array.from(idx), material })), extras };
    });
    const w = writeStagedGlbFile(file, nodes, {
        rootExtras: { sb: { schema: 'scratchbox.staged-glb/2', stage: input.stage, stageKey: input.stageKey, frame: 'tile frame: x east, y up, z south (metres)' }, sbSurfaceMaterials: { version: PROCEDURAL_MATERIALS_VERSION, bytesByEntry: set.bytesByEntry, note: 'every surface is a generated library texture tinted to the colour measured on the tile photo (walls and roofs per building, by each triangle\'s slope); what the scan left standing on a building keeps its scanned shape in its building\'s materials; no photo texel is drawn' } },
        generator: 'scratchbox staged-location district massing (library materials)', materials: set.materials, extraImages: set.extraImages
    });
    return { ...w, materials: set.materials.length, triangles };
}

/** The district's pooled colour as a choice for buildings not seen at all (the nearest entry; labelled). */
export function pooledChoice(key: string, measured: MeasuredColour, library: SurfaceLibrary, from: SurfaceChoice[]): SurfaceChoice {
    // the entry most of the district's own choices of that kind landed on
    const counts = new Map<string, number>();
    for (const c of from) counts.set(c.entryId, (counts.get(c.entryId) ?? 0) + 1);
    let entryId = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? library.index.surfaces[0].id;
    if (!library.entry(entryId)) entryId = library.index.surfaces[0].id;
    return { key, entryId, by: 'colour-rank', candidates: [entryId], measured, reason: 'the photo did not see this surface: the district\'s most chosen entry, tinted to the district\'s pooled measured colour' };
}

// =============================================================================
// The texture pass's fill (texture-library-fill.ts)
// =============================================================================

/** The fill spec as written beside the stage's files (the library maps are decoded again when it is read). */
export interface StoredFillSpec {
    version: string;
    entries: string[];
    uses: Array<LibraryFillSpec['uses'][number] & { measuredLinearRgb: [number, number, number]; measuredLab: [number, number, number] }>;
    byNode: LibraryFillSpec['byNode'];
    grids?: Record<string, { x0: number; z0: number; cellM: number; nx: number; nz: number; useBase64: string }>;
    fallback?: LibraryFillSpec['fallback'];
}

/**
 * The fill spec of a procedural district: one use per chosen surface (its entry and its tint), the massing nodes by
 * their building's walls and roofs, the streets' nodes, and the ground by its region grid.
 */
export function proceduralFillSpec(input: {
    library: SurfaceLibrary; choices: Map<string, SurfaceChoice>; fallback: { walls: SurfaceChoice; roofs: SurfaceChoice };
    massing?: { names: string[]; buildingOf: Array<string | undefined> }; ground?: GroundRegions; roads?: boolean;
}): StoredFillSpec {
    const entries: string[] = [], uses: StoredFillSpec['uses'] = [], useOf = new Map<string, number>();
    const use = (key: string, c: SurfaceChoice): number => {
        if (useOf.has(key)) return useOf.get(key)!;
        const e = input.library.entry(c.entryId)!;
        let ei = entries.indexOf(c.entryId);
        if (ei < 0) { entries.push(c.entryId); ei = entries.length - 1; }
        uses.push({ entry: ei, tint: surfaceTint(e, c.measured.linearRgb).map(v => Math.round(v * 1e4) / 1e4) as [number, number, number], key, measuredLinearRgb: c.measured.linearRgb, measuredLab: c.measured.lab });
        useOf.set(key, uses.length - 1);
        return uses.length - 1;
    };
    const fw = use('district:walls', input.fallback.walls), fl = use('district:roofs', input.fallback.roofs);
    const byNode: LibraryFillSpec['byNode'] = {};
    input.massing?.names.forEach((name, i) => {
        const b = input.massing!.buildingOf[i];
        const w = b && input.choices.get(`building:${b}:walls`), r = b && input.choices.get(`building:${b}:roofs`);
        byNode[name] = { wall: w ? use(`building:${b}:walls`, w) : fw, level: r ? use(`building:${b}:roofs`, r) : fl };
    });
    const cw = input.choices.get('roads:carriageway'), kb = input.choices.get('roads:kerbs') ?? cw;
    if (input.roads && cw) {
        byNode.carriageway = { wall: use('roads:kerbs', kb!), level: use('roads:carriageway', cw) };
        byNode.kerbs = { wall: use('roads:kerbs', kb!), level: use('roads:kerbs', kb!) };
    }
    let grids: StoredFillSpec['grids'];
    if (input.ground) {
        const g = input.ground;
        const map = g.regions.map((_, j) => { const c = input.choices.get(`ground:${j}`); return c ? use(`ground:${j}`, c) : -1; });
        const grid = new Int16Array(g.nx * g.nz).fill(-1);
        for (let i = 0; i < grid.length; i++) if (g.region[i] >= 0) grid[i] = map[g.region[i]] ?? -1;
        const first = map.find(m => m >= 0) ?? fl;
        byNode.ground = { wall: first, level: first };
        grids = { ground: { x0: g.x0, z0: g.z0, cellM: g.cellM, nx: g.nx, nz: g.nz, useBase64: Buffer.from(grid.buffer, grid.byteOffset, grid.byteLength).toString('base64') } };
    }
    return { version: PROCEDURAL_MATERIALS_VERSION, entries, uses, byNode, ...(grids ? { grids } : {}), fallback: { wall: fw, level: fl } };
}

/**
 * The stored spec with the library's colour maps decoded, ready for the texture pass. A use whose entry the library no
 * longer holds (it is being regenerated) takes the nearest entry by its measured colour, tinted to it again.
 */
export function loadFillSpec(stored: StoredFillSpec, library: SurfaceLibrary): LibraryFillSpec {
    const ids = [...stored.entries];
    const uses = stored.uses.map(u => {
        if (library.entry(ids[u.entry])) return u;
        const nearest = rankSurfaceTextures(library.index, { meanLab: u.measuredLab })[0]?.id;
        if (!nearest) return u;
        let ei = ids.indexOf(nearest);
        if (ei < 0) { ids.push(nearest); ei = ids.length - 1; }
        return { ...u, entry: ei, tint: surfaceTint(library.entry(nearest)!, u.measuredLinearRgb), key: `${u.key} (${stored.entries[u.entry]} missing from the library: ${nearest})` };
    });
    const entries = ids.map(id => {
        const e = library.entry(id);
        if (!e) return { id, width: 0, height: 0, rgba: new Uint8Array(0), realSizeM: [1, 1] as [number, number] };
        const img = decodeImageInMemory(library.readMap(e, 'color'));
        return { id, width: img.width, height: img.height, rgba: img.rgba, realSizeM: e.realSizeM };
    });
    const grids = stored.grids ? Object.fromEntries(Object.entries(stored.grids).map(([k, g]) => {
        const b = Buffer.from(g.useBase64, 'base64');
        return [k, { x0: g.x0, z0: g.z0, cellM: g.cellM, nx: g.nx, nz: g.nz, use: new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) }];
    })) : undefined;
    return { entries, uses, byNode: stored.byNode, ...(grids ? { grids } : {}), ...(stored.fallback ? { fallback: stored.fallback } : {}) };
}

/** A clay GLB of nodes (positions and indices only) for the texture pass to lay its atlas on. */
export function writeClayNodes(file: string, nodes: Array<{ name: string; positions: Float32Array; indices: Uint32Array; extras?: unknown }>, extras: Record<string, unknown>): { path: string; bytes: number } {
    return writeStagedGlbFile(file, nodes.filter(n => n.indices.length).map(n => ({ name: n.name, positions: n.positions, indices: n.indices, extras: n.extras ?? {} })), { rootExtras: extras, generator: 'scratchbox staged-location procedural (clay, for the texture pass)' });
}

/**
 * A surface cut into square blocks in plan (by each triangle's centre), one node each, named `<name>#<i>_<k>`: the texture
 * pass's atlas then holds one island per block, which its lighting correction relights as one photo (a whole district's
 * ground as one island was one 500 m image the model could not relight; Federation Square, 2026-10-22).
 */
export function splitByBlocks(name: string, positions: Float32Array, indices: Uint32Array, blockM = PROCEDURAL_RELIGHT_BLOCK_M): Array<{ name: string; positions: Float32Array; indices: Uint32Array }> {
    const groups = new Map<string, number[]>();
    for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
        const k = `${Math.floor((positions[a] + positions[b] + positions[c]) / 3 / blockM)}_${Math.floor((positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3 / blockM)}`;
        const g = groups.get(k) ?? [];
        g.push(indices[t], indices[t + 1], indices[t + 2]);
        groups.set(k, g);
    }
    return [...groups].map(([k, idx]) => {
        const remap = new Map<number, number>(), pos: number[] = [], out: number[] = [];
        for (const v of idx) { if (!remap.has(v)) { remap.set(v, pos.length / 3); pos.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]); } out.push(remap.get(v)!); }
        return { name: `${name}#${k}`, positions: Float32Array.from(pos), indices: Uint32Array.from(out) };
    });
}

/** The block a procedural surface is cut into for the texture pass (m). */
export const PROCEDURAL_RELIGHT_BLOCK_M = 48;

// =============================================================================
// The procedural district prepared for the texture pass, from its files
// =============================================================================

/** Every mesh node of a GLB as world-space positions and indices (node names kept; one entry per primitive). */
export function readGlbNodes(bytes: Uint8Array): Array<{ name: string; positions: Float32Array; indices: Uint32Array; extras?: unknown }> {
    const glb = parseGlbBytes(bytes);
    const world = nodeWorldMatrices(glb.json);
    const out: Array<{ name: string; positions: Float32Array; indices: Uint32Array; extras?: unknown }> = [];
    (glb.json.nodes ?? []).forEach((n: any, ni: number) => {
        if (n.mesh === undefined) return;
        const m = world[ni], id = isIdentity(m);
        for (const p of glb.json.meshes[n.mesh].primitives ?? []) {
            if (p.attributes?.POSITION === undefined || (p.mode ?? 4) !== 4) continue;
            const pos = readAccessor(glb, p.attributes.POSITION).data;
            const positions = new Float32Array(pos.length);
            for (let i = 0; i < pos.length; i += 3) {
                const q = id ? [pos[i], pos[i + 1], pos[i + 2]] : transformPoint(m, pos[i], pos[i + 1], pos[i + 2]);
                positions[i] = q[0]; positions[i + 1] = q[1]; positions[i + 2] = q[2];
            }
            const indices = p.indices !== undefined ? Uint32Array.from(readAccessor(glb, p.indices).data) : Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
            out.push({ name: String(n.name ?? `node_${ni}`), positions, indices, ...(n.extras !== undefined ? { extras: n.extras } : {}) });
        }
    });
    return out;
}

/** Cells (cellM) whose centres lie in any of the triangles: a plan raster of a surface (the carriageways under the ground). */
export function planRaster(nodes: Array<{ positions: Float32Array; indices: Uint32Array }>, cellM = 1): (x: number, z: number) => boolean {
    const cells = new Set<string>();
    for (const n of nodes) for (let t = 0; t < n.indices.length; t += 3) {
        const a = n.indices[t] * 3, b = n.indices[t + 1] * 3, c = n.indices[t + 2] * 3;
        const ax = n.positions[a], az = n.positions[a + 2], bx = n.positions[b], bz = n.positions[b + 2], cx = n.positions[c], cz = n.positions[c + 2];
        const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(d) < 1e-9) continue;
        for (let i = Math.floor(Math.min(ax, bx, cx) / cellM); i <= Math.floor(Math.max(ax, bx, cx) / cellM); i++) for (let k = Math.floor(Math.min(az, bz, cz) / cellM); k <= Math.floor(Math.max(az, bz, cz) / cellM); k++) {
            const px = (i + 0.5) * cellM, pz = (k + 0.5) * cellM;
            const l1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / d, l2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / d;
            if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) cells.add(`${i},${k}`);
        }
    }
    return (x, z) => cells.has(`${Math.floor(x / cellM)},${Math.floor(z / cellM)}`);
}

/** Lit colour of the photo at a set of plan points (one texel each), or undefined when too few. */
function litAt(photo: TopDownPhoto, frame: TopDownFrame, pts: Array<[number, number]>): MeasuredColour | undefined {
    const px: number[] = [];
    for (const [x, z] of pts) {
        const i = Math.floor((x - frame.x0) / photo.texelM), k = Math.floor((z - frame.z0) / photo.texelM);
        if (i < 0 || k < 0 || i >= photo.width || k >= photo.height) continue;
        const o = (k * photo.width + i) * 4;
        px.push(photo.rgba[o], photo.rgba[o + 1], photo.rgba[o + 2], 255);
    }
    return litColour(Uint8Array.from(px), { minTexels: 50 });
}

/** Building of a massing node by its name: the longest building id the name holds (face and part nodes name their part). */
export function buildingOfNodeName(name: string, buildingIds: string[]): string | undefined {
    let best: string | undefined;
    for (const id of buildingIds) if ((name.includes(`${id}/`) || name.endsWith(id)) && (!best || id.length > best.length)) best = id;
    return best;
}

export interface ProceduralTexturingSummary {
    chosen: Record<string, number>; byVision: number; byColour: number; borrowed: number; entries: Record<string, number>; model?: string;
    groundRegions: number; shadowedCells: number;
    /**
     * mode 'inferred': the layers written in their inferred materials (file names in the stage's folder), ready to show as
     * they are; no clay is written and the texture pass is not needed.
     */
    inferred?: { ground: string; roads?: string; massing: string };
}

/**
 * How the rebuilt surfaces get their look. 'photo' (the default, user decision 2026-10-22, the Haughwout scan-fitted
 * rebuild: "augmented vector data with the inferred shapes from 3d photo tiles, textures stamped on from the google photo
 * tiles") prepares clays for the texture pass: the tile photo transferred onto each surface's own atlas, its lighting
 * corrected, the library only where no photo reaches. 'inferred' writes each surface in the library material the vision
 * model inferred for it instead (tried as the default the same day: facades came out blank, the photo's windows and
 * ornament lost). SCRATCHBOX_STAGED_SURFACE_TEXTURES=inferred selects it.
 */
export type ProceduralSurfaceMode = 'inferred' | 'photo';
export function proceduralSurfaceMode(env: NodeJS.ProcessEnv = process.env): ProceduralSurfaceMode {
    return env.SCRATCHBOX_STAGED_SURFACE_TEXTURES?.trim().toLowerCase() === 'inferred' ? 'inferred' : 'photo';
}

/** Flat per-vertex normals of an indexed mesh (area-weighted face normals summed at each vertex). */
function vertexNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
    const n = new Float32Array(positions.length);
    for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
        const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
        const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        for (const v of [a, b, c]) { n[v] += nx; n[v + 1] += ny; n[v + 2] += nz; }
    }
    for (let v = 0; v < n.length; v += 3) { const l = Math.hypot(n[v], n[v + 1], n[v + 2]) || 1; n[v] /= l; n[v + 1] /= l; n[v + 2] /= l; }
    return n;
}

/** Nodes merged into one mesh part with planar metre UVs (x east, z south), as the library road writer expects. */
function metrePart(nodes: Array<{ positions: Float32Array; indices: Uint32Array }>): RoadMeshPart {
    const pos: number[] = [], idx: number[] = [];
    for (const n of nodes) { const base = pos.length / 3; for (const v of n.positions) pos.push(v); for (const i of n.indices) idx.push(base + i); }
    const positions = Float32Array.from(pos), uv = new Float32Array((positions.length / 3) * 2);
    for (let v = 0; v < positions.length / 3; v++) { uv[v * 2] = positions[v * 3]; uv[v * 2 + 1] = positions[v * 3 + 2]; }
    return { positions, indices: Uint32Array.from(idx), uv };
}

/**
 * Writes what the texture pass needs for a procedural district beside the stage's files: the clays it lays its atlas on
 * (ground_clay.glb and roads_clay.glb cut into blocks, massing_clay.glb from the final massing), the library choices for
 * its fill (materials.json, fill-spec.json). Reads the layers as written (the ground, the streets and the massing may have
 * come from the scene object store); a building massed now (run) has its walls and roofs measured on their tile orthos,
 * one taken from the store the district's own pooled choice.
 */
export async function prepareProceduralTexturing(input: {
    dir: string; tileBytes: Uint8Array; files: { ground: string; roads?: string; massing: string };
    buildingIds: string[]; run?: Pick<MassingRun, 'dir' | 'report' | 'nodes'>;
    include: (x: number, z: number) => boolean; library: SurfaceLibrary;
    chain?: Pick<VisionModelChain<string>, 'generate'>; unavailable?: string; signal?: AbortSignal; onProgress?: (m: string) => void;
    /** Default 'photo' (the texture pass); 'inferred' writes the layers in their inferred materials instead. */
    mode?: ProceduralSurfaceMode;
}): Promise<ProceduralTexturingSummary> {
    const say = input.onProgress ?? (() => undefined);
    const fs = await import('fs'), path = await import('path');
    const groundBytes = fs.readFileSync(input.files.ground);
    const groundNodes = readGlbNodes(groundBytes);
    const g0 = groundNodes[0];
    const gj = parseGlbBytes(groundBytes).json;
    const frame = (gj.nodes?.find((n: any) => n.extras?.uvFrame)?.extras?.uvFrame ?? gj.nodes?.[0]?.extras?.sbGround?.uvFrame) as TopDownFrame | undefined;
    if (!g0 || !frame) throw new Error('the ground layer carries no surface or no plan frame');
    say('rendering the tile photo from above to measure the surfaces');
    const photo = renderTopDownPhoto(input.tileBytes, frame, { texelM: 0.1, maxPx: 8192 });
    const roadNodes = input.files.roads && fs.existsSync(input.files.roads) ? readGlbNodes(fs.readFileSync(input.files.roads)) : [];
    const carriage = roadNodes.filter(n => n.name.split('#')[0] === 'carriageway'), kerbs = roadNodes.filter(n => n.name.split('#')[0] === 'kerbs');
    const onRoad = planRaster(carriage, 1);
    say('measuring the ground\'s appearance (lit texels; cast shadows set aside)');
    const regions = segmentGround(photo, frame, (x, z) => input.include(x, z) && !onRoad(x, z));
    // the streets: lit colour on the carriageway's triangle centres, the kerbs' top edges; crops along them
    const subjects: SurfaceSubject[] = [...groundSubjects(regions, photo, frame)];
    const centres = (ns: typeof carriage) => ns.flatMap(n => { const out: Array<[number, number]> = []; for (let t = 0; t < n.indices.length; t += 3) { const a = n.indices[t] * 3, b = n.indices[t + 1] * 3, c = n.indices[t + 2] * 3; out.push([(n.positions[a] + n.positions[b] + n.positions[c]) / 3, (n.positions[a + 2] + n.positions[b + 2] + n.positions[c + 2]) / 3]); } return out; });
    const cwPts = centres(carriage), kbPts = centres(kerbs);
    const cwColour = litAt(photo, frame, cwPts), kbColour = litAt(photo, frame, kbPts);
    if (cwColour && cwPts.length) {
        const picks: Array<[number, number]> = [];
        for (let i = 0; i < cwPts.length && picks.length < 4; i += Math.max(1, Math.floor(cwPts.length / 64))) if (picks.every(([x, z]) => Math.hypot(x - cwPts[i][0], z - cwPts[i][1]) > 40)) picks.push(cwPts[i]);
        const m = mosaic(picks.map(([x, z]) => photoCrop(photo, frame, x, z, 16)));
        const image = { bytes: m.bytes, mimeType: 'image/jpeg' as const, widthM: picks.length > 1 ? 32 : 16, heightM: picks.length > 2 ? 32 : 16 };
        subjects.push({ key: 'roads:carriageway', measured: cwColour, image, view: `the driven surface of the streets seen straight down (${picks.length} patches of 16 x 16 m centred on streets; the material between the kerbs, ignoring cars, shadows and painted lines)` });
        if (kbColour) subjects.push({ key: 'roads:kerbs', measured: kbColour, image, view: 'the kerbs: the edge stones along both sides of the streets, between the driven surface and the footpath (the same patches seen straight down)' });
    }
    // the buildings massed now: walls and roofs on their tile orthos
    let borrowed: string[] = [];
    if (input.run) {
        const measures = measureBuildingSurfaces(input.run, input.buildingIds);
        const b = buildingSubjects(input.run, measures);
        subjects.push(...b.subjects);
        borrowed = b.borrowed;
    }
    say(`choosing library materials for ${subjects.length} surfaces`);
    const chosen = await chooseSurfaceMaterials({ library: input.library.index, subjects, ...(input.chain ? { chain: input.chain } : {}), ...(input.unavailable ? { unavailable: input.unavailable } : {}), ...(input.signal ? { signal: input.signal } : {}), onProgress: say });
    if (!chosen.length) throw new Error('no rebuilt surface could be measured on the tile photo, so no library material could be chosen');
    const choices = new Map<string, SurfaceChoice>(chosen.map(c => [c.key, c]));
    const walls = chosen.filter(c => c.key.endsWith(':walls')), roofs = chosen.filter(c => c.key.endsWith(':roofs'));
    // a building not measured now (taken from the store, or unseen): the district's own most chosen entry at its pooled colour
    const pooled = (cs: SurfaceChoice[]) => poolColours(cs.map(c => c.measured)) ?? chosen[0].measured;
    const fallback = {
        walls: pooledChoice('district:walls', pooled(walls.length ? walls : chosen), input.library, walls.length ? walls : chosen),
        roofs: pooledChoice('district:roofs', pooled(roofs.length ? roofs : chosen), input.library, roofs.length ? roofs : chosen)
    };
    const massingNodes = readGlbNodes(fs.readFileSync(input.files.massing));
    const entries: Record<string, number> = {}, chosenBy: Record<string, number> = {};
    for (const c of chosen) { entries[c.entryId] = (entries[c.entryId] ?? 0) + 1; const k = c.key.startsWith('building:') ? 'buildings' : c.key.startsWith('ground:') ? 'ground' : c.key; chosenBy[k] = (chosenBy[k] ?? 0) + 1; }
    const model = chosen.find(c => c.model)?.model;
    const summary = { chosen: chosenBy, byVision: chosen.filter(c => c.by === 'vision').length, byColour: chosen.filter(c => c.by !== 'vision').length, borrowed: borrowed.length, entries, ...(model ? { model } : {}), groundRegions: regions.regions.length, shadowedCells: regions.stats.shadowedCells };
    fs.writeFileSync(path.join(input.dir, 'materials.json'), JSON.stringify({ version: PROCEDURAL_MATERIALS_VERSION, mode: input.mode ?? 'photo', library: input.library.source, choices: chosen, borrowed, fallback, groundStats: regions.stats }, null, 1));
    if (input.mode === 'inferred') {
        // each surface in the material inferred for it, over the measured lit-colour layer; no photo texel is drawn
        say('writing the rebuilt surfaces in their inferred materials');
        const field = { photo, frame };
        const groundSurface = { mesh: { positions: g0.positions, indices: g0.indices, uv: new Float32Array((g0.positions.length / 3) * 2) }, uvFrame: { x0: frame.x0, z0: frame.z0, widthM: frame.widthM, heightM: frame.heightM }, stats: { vertices: g0.positions.length / 3, triangles: g0.indices.length / 3, openVertices: 0, terrainVertices: 0, minY: 0, maxY: 0 } } as unknown as GroundSurface;
        const note = { surfaces: 'inferred per surface by the vision model from the library (generated), tinted to the colour measured on lit tile-photo texels' };
        writeLibraryGroundGlb(path.join(input.dir, 'ground_inferred.glb'), groundSurface, regions, choices, input.library, { ...note, uvFrame: frame }, { field });
        let roads: string | undefined;
        const cwChoice = choices.get('roads:carriageway'), kbChoice = choices.get('roads:kerbs') ?? cwChoice;
        if (carriage.length && cwChoice && kbChoice) {
            const mesh = { carriageway: metrePart(carriage), kerbs: metrePart(kerbs), sidewalks: metrePart([]) } as unknown as RoadMesh;
            writeLibraryRoadsGlb(path.join(input.dir, 'roads_inferred.glb'), mesh, undefined, { carriageway: cwChoice, kerbs: kbChoice }, input.library, note, { field });
            roads = 'roads_inferred.glb';
        }
        const runBuildings = input.run ? nodeBuildings(input.run, input.buildingIds) : [];
        const byRunName = new Map((input.run?.nodes ?? []).map((n, i) => [n.name, runBuildings[i]]));
        const nodes: MassingNode[] = massingNodes.map(n => {
            const sb = (n.extras as { sb?: { provenance?: { label?: string; confidence?: number } } } | undefined)?.sb;
            return { name: n.name, kind: /residual/.test(n.name) ? 'residual' : 'wall', provenance: sb?.provenance?.label ?? 'vector-modelled', confidence: sb?.provenance?.confidence ?? null, positions: n.positions, normals: vertexNormals(n.positions, n.indices), ref: new Int32Array(n.positions.length / 3), st: new Float32Array((n.positions.length / 3) * 2), indices: n.indices };
        });
        const provOf = new Map(massingNodes.map(n => [n.name, (n.extras as { sb?: { provenance?: ProvenanceRecord } } | undefined)?.sb?.provenance]));
        writeLibraryMassingGlb(path.join(input.dir, 'massing_inferred.glb'), { nodes, report: undefined as never }, {
            buildingOf: nodes.map(n => byRunName.get(n.name) ?? buildingOfNodeName(n.name, input.buildingIds)), choices, fallback, library: input.library,
            provenanceOf: n => provOf.get(n.name) ?? ({ label: 'vector-modelled', confidence: null } as unknown as ProvenanceRecord), stage: 'massing', stageKey: path.basename(input.dir)
        });
        return { ...summary, inferred: { ground: 'ground_inferred.glb', ...(roads ? { roads } : {}), massing: 'massing_inferred.glb' } };
    }
    // the clays the texture pass lays its atlas on
    const runBuildings = input.run ? nodeBuildings(input.run, input.buildingIds) : [];
    const byRunName = new Map((input.run?.nodes ?? []).map((n, i) => [n.name, runBuildings[i]]));
    const names = massingNodes.map(n => n.name);
    writeClayNodes(path.join(input.dir, 'massing_clay.glb'), massingNodes.map(n => ({ name: n.name, positions: n.positions, indices: n.indices, extras: n.extras })), { sbProcedural: { version: PROCEDURAL_MATERIALS_VERSION, from: path.basename(input.files.massing) } });
    writeClayNodes(path.join(input.dir, 'ground_clay.glb'), splitByBlocks('ground', g0.positions, g0.indices), { sbGround: { uvFrame: frame } });
    if (carriage.length) {
        const blocks = carriage.flatMap(n => splitByBlocks('carriageway', n.positions, n.indices));
        writeClayNodes(path.join(input.dir, 'roads_clay.glb'), [...blocks, ...kerbs.map(k => ({ name: 'kerbs', positions: k.positions, indices: k.indices }))], { sbRoads: { from: path.basename(input.files.roads!) } });
    }
    const spec = proceduralFillSpec({ library: input.library, choices, fallback, massing: { names, buildingOf: names.map(nm => byRunName.get(nm) ?? buildingOfNodeName(nm, input.buildingIds)) }, ground: regions, roads: carriage.length > 0 });
    fs.writeFileSync(path.join(input.dir, 'fill-spec.json'), JSON.stringify(spec));
    return summary;
}
