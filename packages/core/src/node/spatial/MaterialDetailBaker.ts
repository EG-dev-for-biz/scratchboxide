/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Material detail baker: the texture agent's apply step.
 *
 * Given a textured scan (glTF, one baseColor atlas per primitive) and a material library harvested from Street View
 * (StreetViewMaterialHarvester), it adds real material micro-detail to the scan's own texture at true metric scale,
 * with no per-pixel registration between photos and mesh:
 *
 *   CLASSIFY  The mesh is split into plane clusters (region growing over welded triangle adjacency). Each cluster is
 *             described by continuous fields: tile colour statistics (CIELAB), tilt, height above terrain, extent.
 *             Each library sample carries the same fields measured on the tile at its source surface, so the match
 *             compares tile with tile. Ambiguous large clusters can be resolved by a multimodal model on an
 *             orthographic render of the cluster's tile texture. Unknown -> no material (tile kept).
 *   BAKE      Per atlas: bicubic upscale by s (2 or 4, within a total byte budget), then for every texel on an assigned
 *             cluster, planar projection onto the cluster plane gives metric (u, v); the swatch luminance ratio
 *             R = D_f / L(D) (D_f prefiltered to the upscaled texel footprint, L a low-pass at the tile's Nyquist) is
 *             sampled there, and   out = T + alpha * g * L(T) * (R - 1)   which equals L(T) * R + (T - L(T)) where the
 *             detail applies fully: the material supplies only the band the tile cannot carry, and the tile's own high
 *             band is always kept. g fades the material out where the tile's local high-band energy already exceeds
 *             the material's (the tile is sharper there), and a per-block check reverts any block whose Laplacian
 *             energy would drop, so local sharpness never decreases. alpha is the cluster confidence times a per-texel
 *             colour likelihood against each candidate's source tile colour (windows and stone on one facade plane
 *             pick different swatches, or none).
 *
 * Output: plain glTF (JPEG q90 replaced images), materials untouched (unlit kept, never metallic), and every primitive
 * whose image is not replaced byte-identical. Behaviour is driven by measured continuous fields; material labels are
 * open strings used only for reporting and for asking the multimodal model.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { AlgorithmicUvEngine } from './AlgorithmicUvEngine';
import { GltfBinaryPacker } from '../3d-engine/gltf-binary-packer';
import { decodePng, encodePng } from '../texture-processing';
import { decodeImageToRgba, encodeRgbaToJpeg } from '../image-codec-ffmpeg';
import { readGlbScene, type GeminiContentClient, STREETVIEW_GEMINI_MODEL } from './StreetViewPoseRegistrar';
import { upsampleBicubic3, normalizedGaussian3 } from './StreetViewTextureFusion';
import { linearRgbToLab, ciede2000, luminance8, laplacianVariance } from './StreetViewStage3Metrics';
import { planeAxes, srgb8ToLinear, linearToSrgb8, withTimeout, geminiTimeoutMs, type MaterialLibrary, type MaterialLibrarySample, type Vec3 } from './StreetViewMaterialHarvester';

// ============================================================================================
// Base scan
// ============================================================================================

export interface BasePrimitive {
    /** Index in readGlbScene order. */
    index: number;
    meshIndex: number;
    primitiveIndex: number;
    materialIndex: number | null;
    imageIndex: number | null;
    /** World space. */
    positions: Float32Array;
    indices: Uint32Array;
    uvs: Float32Array | null;
    /** First global triangle index of this primitive. */
    triOffset: number;
}

export interface BaseScan {
    json: any;
    bin: Buffer;
    prims: BasePrimitive[];
    triCount: number;
    /** Encoded bytes of every image (by image index). */
    imageBytes: Array<Buffer | null>;
}

function imageIndexOf(json: any, materialIndex: number | null): number | null {
    if (materialIndex === null) return null;
    const tex = json.materials?.[materialIndex]?.pbrMetallicRoughness?.baseColorTexture;
    const src = tex ? json.textures?.[tex.index]?.source : undefined;
    return typeof src === 'number' ? src : null;
}

/** Reads a glTF binary with world-space triangle primitives (node transforms applied) and their baseColor image indices. */
export function loadBaseScan(glbPath: string): BaseScan {
    const buf = fs.readFileSync(glbPath);
    const { json, bin } = AlgorithmicUvEngine.parseGlb(buf);
    const scene = readGlbScene(glbPath);
    // Same traversal as readGlbScene: nodes in index order (first instance wins), meshes when no node has one.
    const order: Array<{ meshIndex: number; primitiveIndex: number }> = [];
    const nodes: any[] = json.nodes ?? [];
    const meshList: number[] = [];
    nodes.forEach(n => { if (n.mesh !== undefined && json.meshes?.[n.mesh]) meshList.push(n.mesh); });
    if (!meshList.length) (json.meshes ?? []).forEach((_: any, i: number) => meshList.push(i));
    for (const mi of meshList) (json.meshes[mi].primitives ?? []).forEach((p: any, pi: number) => {
        if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined) return;
        order.push({ meshIndex: mi, primitiveIndex: pi });
    });
    if (order.length !== scene.length) throw new Error(`${glbPath}: primitive order mismatch (${order.length} vs ${scene.length})`);
    let tri = 0;
    const prims: BasePrimitive[] = scene.map((p, i) => {
        const out: BasePrimitive = {
            index: i, meshIndex: order[i].meshIndex, primitiveIndex: order[i].primitiveIndex, materialIndex: p.materialIndex,
            imageIndex: imageIndexOf(json, p.materialIndex), positions: p.positions, indices: p.indices, uvs: p.uvs, triOffset: tri
        };
        tri += p.indices.length / 3;
        return out;
    });
    const imageBytes: Array<Buffer | null> = (json.images ?? []).map((img: any) => {
        if (img.bufferView === undefined) return null;
        const v = json.bufferViews[img.bufferView];
        return bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength);
    });
    return { json, bin, prims, triCount: tri, imageBytes };
}

// ============================================================================================
// Plane clusters
// ============================================================================================

export interface PlaneCluster {
    id: number;
    normal: Vec3;
    offset: number;
    origin: Vec3;
    uAxis: Vec3;
    vAxis: Vec3;
    area: number;
    triCount: number;
    tiltDeg: number;
    /** World AABB. */
    min: Vec3;
    max: Vec3;
    /** Area-weighted RMS distance of triangle centroids to the plane. */
    planarityRmsMeters: number;
    /** Filled by describeClusters. */
    tile?: { lab: { mean: Vec3; std: Vec3 }; texelMeters: number; samples: number };
    heightAboveGround?: { p05: number; p50: number; p95: number } | null;
}

export interface ClusterOptions {
    /** Maximum angle between a triangle and its cluster's plane normal. Default 12 deg. */
    angleDeg?: number;
    /** Maximum distance of a triangle centroid from the cluster plane. Default 0.4 m. */
    distanceMeters?: number;
    /** Vertex welding tolerance. Default 0.01 m. */
    weldMeters?: number;
}

/** Region growing over welded triangle adjacency into near-planar clusters. Returns the cluster of every global triangle (-1 = degenerate). */
export function buildPlaneClusters(scan: BaseScan, opts: ClusterOptions = {}): { triCluster: Int32Array; clusters: PlaneCluster[] } {
    const cosT = Math.cos((opts.angleDeg ?? 12) * Math.PI / 180), dTol = opts.distanceMeters ?? 0.4, weld = opts.weldMeters ?? 0.01;
    const nt = scan.triCount;
    const vid = new Map<string, number>();
    const triV = new Int32Array(nt * 3);
    const tN = new Float64Array(nt * 3), tC = new Float64Array(nt * 3), tA = new Float64Array(nt);
    for (const p of scan.prims) {
        const P = p.positions;
        const local = new Int32Array(P.length / 3);
        for (let v = 0; v < local.length; v++) {
            const key = `${Math.round(P[v * 3] / weld)},${Math.round(P[v * 3 + 1] / weld)},${Math.round(P[v * 3 + 2] / weld)}`;
            let id = vid.get(key);
            if (id === undefined) { id = vid.size; vid.set(key, id); }
            local[v] = id;
        }
        for (let t = 0; t < p.indices.length / 3; t++) {
            const g = p.triOffset + t;
            const a = p.indices[t * 3], b = p.indices[t * 3 + 1], c = p.indices[t * 3 + 2];
            triV[g * 3] = local[a]; triV[g * 3 + 1] = local[b]; triV[g * 3 + 2] = local[c];
            const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
            const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const l = Math.hypot(nx, ny, nz);
            tA[g] = 0.5 * l;
            if (l > 1e-12) { tN[g * 3] = nx / l; tN[g * 3 + 1] = ny / l; tN[g * 3 + 2] = nz / l; }
            for (let k = 0; k < 3; k++) tC[g * 3 + k] = (P[a * 3 + k] + P[b * 3 + k] + P[c * 3 + k]) / 3;
        }
    }
    // edge adjacency
    const edgeTris = new Map<string, number[]>();
    for (let g = 0; g < nt; g++) for (let k = 0; k < 3; k++) {
        const a = triV[g * 3 + k], b = triV[g * 3 + ((k + 1) % 3)];
        if (a === b) continue;
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        const l = edgeTris.get(key);
        if (l) l.push(g); else edgeTris.set(key, [g]);
    }
    const nbr: number[][] = Array.from({ length: nt }, () => []);
    for (const l of edgeTris.values()) for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) { nbr[l[i]].push(l[j]); nbr[l[j]].push(l[i]); }
    const triCluster = new Int32Array(nt).fill(-1);
    const order = Array.from({ length: nt }, (_, i) => i).sort((a, b) => tA[b] - tA[a]);
    const clusters: PlaneCluster[] = [];
    for (const seed of order) {
        if (triCluster[seed] >= 0 || !(tA[seed] > 1e-6)) continue;
        const id = clusters.length;
        let sn: Vec3 = [tN[seed * 3] * tA[seed], tN[seed * 3 + 1] * tA[seed], tN[seed * 3 + 2] * tA[seed]];
        let sc: Vec3 = [tC[seed * 3] * tA[seed], tC[seed * 3 + 1] * tA[seed], tC[seed * 3 + 2] * tA[seed]];
        let area = tA[seed];
        let n: Vec3 = [tN[seed * 3], tN[seed * 3 + 1], tN[seed * 3 + 2]];
        let d = n[0] * tC[seed * 3] + n[1] * tC[seed * 3 + 1] + n[2] * tC[seed * 3 + 2];
        triCluster[seed] = id;
        const queue = [seed];
        const members = [seed];
        for (let qi = 0; qi < queue.length; qi++) {
            for (const t of nbr[queue[qi]]) {
                if (triCluster[t] >= 0 || !(tA[t] > 1e-6)) continue;
                const c = n[0] * tN[t * 3] + n[1] * tN[t * 3 + 1] + n[2] * tN[t * 3 + 2];
                if (Math.abs(c) < cosT) continue;
                const dist = Math.abs(n[0] * tC[t * 3] + n[1] * tC[t * 3 + 1] + n[2] * tC[t * 3 + 2] - d);
                if (dist > dTol) continue;
                triCluster[t] = id;
                queue.push(t); members.push(t);
                const sg = c < 0 ? -1 : 1;
                sn = [sn[0] + sg * tN[t * 3] * tA[t], sn[1] + sg * tN[t * 3 + 1] * tA[t], sn[2] + sg * tN[t * 3 + 2] * tA[t]];
                sc = [sc[0] + tC[t * 3] * tA[t], sc[1] + tC[t * 3 + 1] * tA[t], sc[2] + tC[t * 3 + 2] * tA[t]];
                area += tA[t];
                const l = Math.hypot(sn[0], sn[1], sn[2]) || 1;
                n = [sn[0] / l, sn[1] / l, sn[2] / l];
                d = (n[0] * sc[0] + n[1] * sc[1] + n[2] * sc[2]) / area;
            }
        }
        const origin: Vec3 = [sc[0] / area, sc[1] / area, sc[2] / area];
        const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
        let rss = 0;
        for (const t of members) {
            for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], tC[t * 3 + k]); max[k] = Math.max(max[k], tC[t * 3 + k]); }
            const r = n[0] * tC[t * 3] + n[1] * tC[t * 3 + 1] + n[2] * tC[t * 3 + 2] - d;
            rss += r * r * tA[t];
        }
        const { uAxis, vAxis } = planeAxes(n, [1, 0, 0]);
        clusters.push({
            id, normal: n, offset: d, origin, uAxis, vAxis, area, triCount: members.length,
            tiltDeg: Math.acos(Math.min(1, Math.abs(n[1]))) * 180 / Math.PI, min, max, planarityRmsMeters: Math.sqrt(rss / area)
        });
    }
    return { triCluster, clusters };
}

/** Decoded linear-RGB baseColor images by image index (lazily). */
export class LinearImageCache {
    private cache = new Map<number, { width: number; height: number; srgb: Buffer; lin: Float32Array }>();
    constructor(private readonly scan: BaseScan) {}
    async get(imageIndex: number): Promise<{ width: number; height: number; srgb: Buffer; lin: Float32Array } | null> {
        const hit = this.cache.get(imageIndex);
        if (hit) return hit;
        const bytes = this.scan.imageBytes[imageIndex];
        if (!bytes) return null;
        const img = await decodeImageToRgba(bytes);
        const lin = new Float32Array(img.width * img.height * 3);
        for (let i = 0; i < img.width * img.height; i++) for (let c = 0; c < 3; c++) lin[i * 3 + c] = srgb8ToLinear(img.rgba[i * 4 + c]);
        const out = { width: img.width, height: img.height, srgb: img.rgba, lin };
        this.cache.set(imageIndex, out);
        return out;
    }
}

/** Tile colour (CIELAB of linear texels sampled inside each triangle), texel size and height above terrain per cluster. */
export async function describeClusters(scan: BaseScan, triCluster: Int32Array, clusters: PlaneCluster[], images: LinearImageCache, groundHeightAt?: (x: number, z: number) => number): Promise<void> {
    const nC = clusters.length;
    const sw = new Float64Array(nC), sL = new Float64Array(nC * 3), sL2 = new Float64Array(nC * 3);
    const texel: Array<Array<[number, number]>> = Array.from({ length: nC }, () => []);
    const hag: Array<Array<[number, number]>> = Array.from({ length: nC }, () => []);
    const BARY: Array<[number, number, number]> = [[1 / 3, 1 / 3, 1 / 3], [2 / 3, 1 / 6, 1 / 6], [1 / 6, 2 / 3, 1 / 6], [1 / 6, 1 / 6, 2 / 3]];
    for (const p of scan.prims) {
        if (p.imageIndex === null || !p.uvs) continue;
        const img = await images.get(p.imageIndex);
        if (!img) continue;
        const { width: W, height: H, lin } = img;
        const P = p.positions, U = p.uvs;
        for (let t = 0; t < p.indices.length / 3; t++) {
            const g = p.triOffset + t, c = triCluster[g];
            if (c < 0) continue;
            const a = p.indices[t * 3], b = p.indices[t * 3 + 1], cc = p.indices[t * 3 + 2];
            const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
            const vx = P[cc * 3] - P[a * 3], vy = P[cc * 3 + 1] - P[a * 3 + 1], vz = P[cc * 3 + 2] - P[a * 3 + 2];
            const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
            const auv = 0.5 * Math.abs((U[b * 2] - U[a * 2]) * (U[cc * 2 + 1] - U[a * 2 + 1]) - (U[b * 2 + 1] - U[a * 2 + 1]) * (U[cc * 2] - U[a * 2])) * W * H;
            if (!(area > 1e-6)) continue;
            if (auv > 1e-9) texel[c].push([Math.sqrt(area / auv), area]);
            const wEach = area / BARY.length;
            for (const [wa, wb, wc] of BARY) {
                const u = (U[a * 2] * wa + U[b * 2] * wb + U[cc * 2] * wc) * W - 0.5, v = (U[a * 2 + 1] * wa + U[b * 2 + 1] * wb + U[cc * 2 + 1] * wc) * H - 0.5;
                const xi = Math.min(W - 1, Math.max(0, Math.round(u))), yi = Math.min(H - 1, Math.max(0, Math.round(v)));
                const k = (yi * W + xi) * 3;
                const lab = linearRgbToLab(lin[k], lin[k + 1], lin[k + 2]);
                sw[c] += wEach;
                for (let q = 0; q < 3; q++) { sL[c * 3 + q] += lab[q] * wEach; sL2[c * 3 + q] += lab[q] * lab[q] * wEach; }
            }
            if (groundHeightAt) {
                const x = (P[a * 3] + P[b * 3] + P[cc * 3]) / 3, y = (P[a * 3 + 1] + P[b * 3 + 1] + P[cc * 3 + 1]) / 3, z = (P[a * 3 + 2] + P[b * 3 + 2] + P[cc * 3 + 2]) / 3;
                const gh = groundHeightAt(x, z);
                if (Number.isFinite(gh)) hag[c].push([y - gh, area]);
            }
        }
    }
    const wq = (list: Array<[number, number]>, q: number): number => {
        if (!list.length) return NaN;
        const s = list.slice().sort((x, y) => x[0] - y[0]);
        const tot = s.reduce((acc, v) => acc + v[1], 0);
        let acc = 0;
        for (const [v, w] of s) { acc += w; if (acc >= q * tot) return v; }
        return s[s.length - 1][0];
    };
    for (let c = 0; c < nC; c++) {
        if (sw[c] > 0) {
            const mean: Vec3 = [sL[c * 3] / sw[c], sL[c * 3 + 1] / sw[c], sL[c * 3 + 2] / sw[c]];
            const std: Vec3 = [0, 1, 2].map(q => Math.sqrt(Math.max(0, sL2[c * 3 + q] / sw[c] - mean[q] ** 2))) as Vec3;
            clusters[c].tile = { lab: { mean, std }, texelMeters: wq(texel[c], 0.5), samples: Math.round(sw[c] > 0 ? texel[c].length : 0) };
        }
        clusters[c].heightAboveGround = hag[c].length ? { p05: wq(hag[c], 0.05), p50: wq(hag[c], 0.5), p95: wq(hag[c], 0.95) } : null;
    }
}

// ============================================================================================
// Classification
// ============================================================================================

export interface ClassificationOptions {
    /** Colour scale of the cluster-to-sample tile colour match (CIEDE2000). Default 8. */
    sigmaColour?: number;
    /** Tilt scale (deg). Default 15. */
    sigmaTiltDeg?: number;
    /** Height scale (|ln((h+3)/(h_src+3))|) for horizontal and vertical surfaces (interpolated by sin(tilt)). Defaults 0.5, 1.5. */
    sigmaHeightLogHorizontal?: number;
    sigmaHeightLogVertical?: number;
    /** Distance scale of the source-proximity prior (m). Default 120. */
    proximityMeters?: number;
    /** Scores below this are "unknown". Default 0.25. */
    minScore?: number;
    /** Scores at or above this give full confidence. Default 0.6. */
    confidentScore?: number;
    /** Minimum swatch resolution gain over the cluster's tile texel. Default 2. */
    minResolutionGain?: number;
    /** Ignore clusters smaller than this (m^2). Default 0.5. */
    minClusterArea?: number;
    /** Candidates kept per cluster. Default 3. */
    maxCandidates?: number;
    /** Top-2 score ratio above which distinct candidates count as ambiguous. Default 0.8. */
    ambiguityRatio?: number;
}

export interface ClusterAssignment {
    cluster: number;
    /** Candidate library samples (indices) with their scores, best first. */
    candidates: Array<{ sample: number; score: number }>;
    /** Cluster-level confidence in [0, 1]. */
    confidence: number;
    ambiguous: boolean;
    decidedBy: 'fields' | 'multimodal' | 'multimodal-none';
}

const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function boxDistance(p: Vec3, min: Vec3, max: Vec3): number {
    let s = 0;
    for (let k = 0; k < 3; k++) { const d = Math.max(min[k] - p[k], 0, p[k] - max[k]); s += d * d; }
    return Math.sqrt(s);
}

/** Continuous match score of a library sample for a cluster (0..1). */
export function sampleClusterScore(c: PlaneCluster, m: MaterialLibrarySample, o: Required<ClassificationOptions>): number {
    if (!c.tile || !m.tile) return 0;
    const dE = ciede2000(c.tile.lab.mean, m.tile.lab.mean);
    const dTilt = Math.abs(c.tiltDeg - m.plane.tiltDeg);
    let dh = 0;
    const hc = c.heightAboveGround?.p50, hs = m.geometry.heightAboveGround;
    if (hc !== undefined && hs) {
        const clampH = Math.min(Math.max(hc, hs.p05), hs.p95);
        dh = Math.abs(Math.log((Math.max(0, hc) + 3) / (Math.max(0, clampH) + 3)));
    }
    const sinT = Math.sin(c.tiltDeg * Math.PI / 180);
    const sh = o.sigmaHeightLogHorizontal + (o.sigmaHeightLogVertical - o.sigmaHeightLogHorizontal) * sinT;
    const attr = Math.exp(-0.5 * ((dE / o.sigmaColour) ** 2 + (dTilt / o.sigmaTiltDeg) ** 2 + (dh / sh) ** 2));
    const prox = Math.exp(-boxDistance(m.source.centreWorld, c.min, c.max) / o.proximityMeters);
    return attr * (0.6 + 0.4 * prox) * (0.75 + 0.25 * Math.min(1, Math.max(0, m.quality.score) * 4));
}

const normLabel = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Two samples are distinct materials when their labels differ or their swatch / source-tile colours differ clearly. */
function distinctSamples(a: MaterialLibrarySample, b: MaterialLibrarySample): boolean {
    if (normLabel(a.label) !== normLabel(b.label)) return true;
    return ciede2000(a.albedo.lab.mean, b.albedo.lab.mean) > 10 || (!!a.tile && !!b.tile && ciede2000(a.tile.lab.mean, b.tile.lab.mean) > 8);
}

export function classifyClusters(clusters: PlaneCluster[], library: MaterialLibrary, opts: ClassificationOptions = {}): ClusterAssignment[] {
    const o: Required<ClassificationOptions> = {
        sigmaColour: 8, sigmaTiltDeg: 15, sigmaHeightLogHorizontal: 0.5, sigmaHeightLogVertical: 1.5, proximityMeters: 120,
        minScore: 0.25, confidentScore: 0.6, minResolutionGain: 2, minClusterArea: 0.5, maxCandidates: 3, ambiguityRatio: 0.8, ...opts
    };
    const out: ClusterAssignment[] = [];
    for (const c of clusters) {
        if (c.area < o.minClusterArea || !c.tile) continue;
        const scored: Array<{ sample: number; score: number }> = [];
        library.samples.forEach((m, i) => {
            const mpp = Math.max(m.metresPerPixel.u, m.metresPerPixel.v);
            if (!(c.tile!.texelMeters / mpp >= o.minResolutionGain)) return;
            const s = sampleClusterScore(c, m, o);
            if (s >= o.minScore * 0.5) scored.push({ sample: i, score: s });
        });
        scored.sort((a, b) => b.score - a.score);
        if (!scored.length || scored[0].score < o.minScore) continue;
        // keep the best few, one per distinct material
        const kept: Array<{ sample: number; score: number }> = [];
        for (const s of scored) {
            if (kept.length >= o.maxCandidates) break;
            if (kept.every(k => distinctSamples(library.samples[k.sample], library.samples[s.sample]))) kept.push(s);
        }
        const ambiguous = kept.length > 1 && kept[1].score >= o.ambiguityRatio * kept[0].score;
        out.push({ cluster: c.id, candidates: kept, confidence: smoothstep(o.minScore, o.confidentScore, kept[0].score), ambiguous, decidedBy: 'fields' });
    }
    return out;
}

// ============================================================================================
// Multimodal disambiguation on orthographic cluster renders
// ============================================================================================

/** Orthographic render of a cluster's tile texture on its plane (sRGB RGBA, transparent where empty). */
export async function renderClusterOrtho(scan: BaseScan, triCluster: Int32Array, cluster: PlaneCluster, images: LinearImageCache, maxPx = 256): Promise<{ rgba: Buffer; width: number; height: number; metresPerPixel: number } | null> {
    // extent in plane coordinates
    let sMin = Infinity, sMax = -Infinity, tMin = Infinity, tMax = -Infinity;
    const tris: Array<{ p: BasePrimitive; t: number }> = [];
    for (const p of scan.prims) for (let t = 0; t < p.indices.length / 3; t++) {
        if (triCluster[p.triOffset + t] !== cluster.id) continue;
        tris.push({ p, t });
        for (let k = 0; k < 3; k++) {
            const v = p.indices[t * 3 + k];
            const d: Vec3 = [p.positions[v * 3] - cluster.origin[0], p.positions[v * 3 + 1] - cluster.origin[1], p.positions[v * 3 + 2] - cluster.origin[2]];
            const s = d[0] * cluster.uAxis[0] + d[1] * cluster.uAxis[1] + d[2] * cluster.uAxis[2], tt = d[0] * cluster.vAxis[0] + d[1] * cluster.vAxis[1] + d[2] * cluster.vAxis[2];
            sMin = Math.min(sMin, s); sMax = Math.max(sMax, s); tMin = Math.min(tMin, tt); tMax = Math.max(tMax, tt);
        }
    }
    if (!tris.length || !(sMax > sMin) || !(tMax > tMin)) return null;
    const mpp = Math.max((sMax - sMin) / maxPx, (tMax - tMin) / maxPx, 0.05);
    const W = Math.max(1, Math.ceil((sMax - sMin) / mpp)), H = Math.max(1, Math.ceil((tMax - tMin) / mpp));
    const rgba = Buffer.alloc(W * H * 4);
    for (const { p, t } of tris) {
        if (p.imageIndex === null || !p.uvs) continue;
        const img = await images.get(p.imageIndex);
        if (!img) continue;
        const q: Array<[number, number]> = [], uv: Array<[number, number]> = [];
        for (let k = 0; k < 3; k++) {
            const v = p.indices[t * 3 + k];
            const d: Vec3 = [p.positions[v * 3] - cluster.origin[0], p.positions[v * 3 + 1] - cluster.origin[1], p.positions[v * 3 + 2] - cluster.origin[2]];
            q.push([((d[0] * cluster.uAxis[0] + d[1] * cluster.uAxis[1] + d[2] * cluster.uAxis[2]) - sMin) / mpp, (tMax - (d[0] * cluster.vAxis[0] + d[1] * cluster.vAxis[1] + d[2] * cluster.vAxis[2])) / mpp]);
            uv.push([p.uvs[v * 2], p.uvs[v * 2 + 1]]);
        }
        const area = (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[1][1] - q[0][1]) * (q[2][0] - q[0][0]);
        if (Math.abs(area) < 1e-9) continue;
        const x0 = Math.max(0, Math.floor(Math.min(q[0][0], q[1][0], q[2][0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(q[0][0], q[1][0], q[2][0])));
        const y0 = Math.max(0, Math.floor(Math.min(q[0][1], q[1][1], q[2][1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(q[0][1], q[1][1], q[2][1])));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const px = x + 0.5, py = y + 0.5;
            const w0 = ((q[1][0] - px) * (q[2][1] - py) - (q[1][1] - py) * (q[2][0] - px)) / area;
            const w1 = ((q[2][0] - px) * (q[0][1] - py) - (q[2][1] - py) * (q[0][0] - px)) / area;
            const w2 = 1 - w0 - w1;
            if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
            const u = (uv[0][0] * w0 + uv[1][0] * w1 + uv[2][0] * w2) * img.width - 0.5, v = (uv[0][1] * w0 + uv[1][1] * w1 + uv[2][1] * w2) * img.height - 0.5;
            const xi = Math.min(img.width - 1, Math.max(0, Math.round(u))), yi = Math.min(img.height - 1, Math.max(0, Math.round(v)));
            const k = (yi * img.width + xi) * 4, o = (y * W + x) * 4;
            rgba[o] = img.srgb[k]; rgba[o + 1] = img.srgb[k + 1]; rgba[o + 2] = img.srgb[k + 2]; rgba[o + 3] = 255;
        }
    }
    return { rgba, width: W, height: H, metresPerPixel: mpp };
}

export interface OrthoQuestion {
    cluster: number;
    png: Buffer;
    widthMeters: number;
    heightMeters: number;
    tiltDeg: number;
    heightAboveGroundMeters: number | null;
    candidates: Array<{ label: string; description: string }>;
}
export interface OrthoAnswer { cluster: number; choice: string | null; confidence: number }
export type OrthoClassifier = (questions: OrthoQuestion[]) => Promise<OrthoAnswer[]>;

export const ORTHO_PROMPT_VERSION = 1;

function orthoPrompt(qs: OrthoQuestion[]): string {
    const lines = qs.map((q, i) => `Image ${i}: ${q.widthMeters.toFixed(1)} m x ${q.heightMeters.toFixed(1)} m surface, tilt ${q.tiltDeg.toFixed(0)} deg ` +
        `(0 = horizontal, 90 = vertical)${q.heightAboveGroundMeters !== null ? `, about ${q.heightAboveGroundMeters.toFixed(0)} m above the street` : ''}. ` +
        `Candidates: ${q.candidates.map(c => JSON.stringify(c.label)).join(', ')}.`);
    return 'Each image is an orthographic view of one flat surface of a photogrammetric 3D city scan, showing the scan\'s own (blurry) ' +
        'texture. For each image choose which candidate material best describes the DOMINANT surface material, or "none" if no ' +
        'candidate fits (for example the surface is a roof, a tree, a vehicle, glass when no glazing candidate exists, or a different ' +
        `material).\n${lines.join('\n')}\nRespond with JSON only: {"answers":[{"image":number,"choice":string,"confidence":number}]}`;
}

/** Ortho classifier on Gemini with an on-disk cache keyed by the request content. */
export function geminiOrthoClassifier(client: GeminiContentClient | null, cacheDir: string, opts: { model?: string; allowNetwork?: boolean; batchSize?: number; concurrency?: number } = {}): OrthoClassifier {
    const model = opts.model ?? STREETVIEW_GEMINI_MODEL, batch = opts.batchSize ?? 6;
    return async (questions: OrthoQuestion[]) => {
        const batches: OrthoQuestion[][] = [];
        for (let b = 0; b < questions.length; b += batch) batches.push(questions.slice(b, b + batch));
        const results: OrthoAnswer[][] = new Array(batches.length);
        let next = 0;
        const worker = async () => { for (let k = next++; k < batches.length; k = next++) results[k] = await askBatch(batches[k]); };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 6, batches.length)) }, worker));
        return results.flat();
    };
    async function askBatch(qs: OrthoQuestion[]): Promise<OrthoAnswer[]> {
        const answers: OrthoAnswer[] = [];
        const prompt = orthoPrompt(qs);
        const h = createHash('sha256').update(String(ORTHO_PROMPT_VERSION)).update(model).update(prompt);
        for (const q of qs) h.update(q.png);
        const file = path.join(cacheDir, `${h.digest('hex').slice(0, 24)}.json`);
        let raw: any = null;
        if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8')).raw;
        else if (client && opts.allowNetwork !== false) {
            for (let a = 1; a <= 3 && raw === null; a++) {
                try {
                    const parts: any[] = [];
                    qs.forEach((q, i) => { parts.push({ text: `Image ${i}:` }); parts.push({ inlineData: { mimeType: 'image/png', data: q.png.toString('base64') } }); });
                    parts.push({ text: prompt });
                    const res = await withTimeout(client.models.generateContent({ model, contents: [{ role: 'user', parts }], config: { responseMimeType: 'application/json', temperature: a === 1 ? 0 : 0.2 } }), geminiTimeoutMs(), 'ortho classification');
                    const t = (res.text ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
                    raw = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
                } catch { raw = null; }
            }
            if (raw !== null) {
                fs.mkdirSync(cacheDir, { recursive: true });
                fs.writeFileSync(file, JSON.stringify({ model, promptVersion: ORTHO_PROMPT_VERSION, raw }, null, 1));
            }
        }
        for (let i = 0; i < qs.length; i++) {
            const a = Array.isArray(raw?.answers) ? raw.answers.find((x: any) => Number(x?.image) === i) : undefined;
            const choice = a && typeof a.choice === 'string' ? a.choice : null;
            answers.push({ cluster: qs[i].cluster, choice, confidence: Number.isFinite(Number(a?.confidence)) ? Number(a.confidence) : 0 });
        }
        return answers;
    }
}

/** Resolves ambiguous large clusters with the ortho classifier (in place). Returns the number of questions asked. */
export async function disambiguateClusters(
    scan: BaseScan, triCluster: Int32Array, clusters: PlaneCluster[], library: MaterialLibrary, assignments: ClusterAssignment[],
    images: LinearImageCache, classifier: OrthoClassifier, opts: { minAreaM2?: number; maxQuestions?: number } = {}
): Promise<number> {
    const minArea = opts.minAreaM2 ?? 25, maxQ = opts.maxQuestions ?? 120;
    const todo = assignments.filter(a => a.ambiguous && clusters[a.cluster].area >= minArea).sort((a, b) => clusters[b.cluster].area - clusters[a.cluster].area).slice(0, maxQ);
    const questions: OrthoQuestion[] = [];
    for (const a of todo) {
        const c = clusters[a.cluster];
        const r = await renderClusterOrtho(scan, triCluster, c, images);
        if (!r) continue;
        questions.push({
            cluster: c.id, png: encodePng(r.width, r.height, r.rgba), widthMeters: r.width * r.metresPerPixel, heightMeters: r.height * r.metresPerPixel,
            tiltDeg: c.tiltDeg, heightAboveGroundMeters: c.heightAboveGround?.p50 ?? null,
            candidates: a.candidates.map(k => ({ label: library.samples[k.sample].label, description: library.samples[k.sample].description }))
        });
    }
    if (!questions.length) return 0;
    const answers = await classifier(questions);
    const byCluster = new Map(assignments.map(a => [a.cluster, a] as const));
    for (const ans of answers) {
        const a = byCluster.get(ans.cluster);
        if (!a || ans.choice === null) continue;
        if (normLabel(ans.choice) === 'none') {
            a.candidates = []; a.confidence = 0; a.decidedBy = 'multimodal-none';
            continue;
        }
        const keep = a.candidates.filter(k => normLabel(library.samples[k.sample].label) === normLabel(ans.choice!));
        if (keep.length) {
            a.candidates = keep;
            a.confidence = Math.max(a.confidence, Math.min(1, Math.max(0.5, ans.confidence)));
            a.ambiguous = false;
            a.decidedBy = 'multimodal';
        }
    }
    return questions.length;
}

// ============================================================================================
// Detail maps (tileable swatch -> band-limited luminance ratio)
// ============================================================================================

/** Separable Gaussian with wrap-around boundaries (tileable images), independent sigmas per axis. */
export function blurWrap(src: Float32Array, W: number, H: number, sigmaX: number, sigmaY: number): Float32Array {
    const pass = (inp: Float32Array, sigma: number, horizontal: boolean): Float32Array => {
        if (sigma < 0.05) return Float32Array.from(inp);
        const r = Math.max(1, Math.ceil(3 * sigma));
        const k = new Float32Array(2 * r + 1);
        let ks = 0;
        for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); ks += k[i + r]; }
        for (let i = 0; i < k.length; i++) k[i] /= ks;
        const out = new Float32Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            let s = 0;
            for (let d = -r; d <= r; d++) {
                const xx = horizontal ? ((x + d) % W + W) % W : x, yy = horizontal ? y : ((y + d) % H + H) % H;
                s += k[d + r] * inp[yy * W + xx];
            }
            out[y * W + x] = s;
        }
        return out;
    };
    return pass(pass(src, sigmaX, true), sigmaY, false);
}

export interface DetailMap {
    sample: number;
    width: number;
    height: number;
    mppU: number;
    mppV: number;
    /** Band-limited luminance ratio, clamped. */
    ratio: Float32Array;
    /**
     * Relative contrast of the swatch's structures the TILE can already resolve (periods between ~2 and ~8 tile texels,
     * e.g. a window grid inside a composite facade swatch). Their sharp edges would land out of phase with the tile's own
     * copy of those structures (a doubled grid), so the swatch's weight falls with this contrast.
     */
    resolvableStructureContrast: number;
    /** exp(-0.5 (contrast / structureContrastScale)^2): multiplies the swatch's per-texel weight. */
    structureWeight: number;
}

/**
 * R = D_f / L(D): D_f is the swatch luminance prefiltered to the upscaled texel footprint (t / s), L a low-pass at the
 * tile Nyquist (sigma = `lowPassSigmaTexels` tile texels). Wrap-around (the swatch tiles).
 */
export function buildDetailMap(
    lumLinear: Float32Array, W: number, H: number, mppU: number, mppV: number, tileTexelMeters: number, scale: number,
    opts: { lowPassSigmaTexels?: number; ratioRange?: [number, number]; sample?: number; structureContrastScale?: number } = {}
): DetailMap {
    const lp = opts.lowPassSigmaTexels ?? 0.42;
    const [lo, hi] = opts.ratioRange ?? [0.45, 1.9];
    const f = tileTexelMeters / scale;
    const Df = blurWrap(lumLinear, W, H, 0.5 * f / mppU, 0.5 * f / mppV);
    const L = blurWrap(lumLinear, W, H, lp * tileTexelMeters / mppU, lp * tileTexelMeters / mppV);
    const ratio = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) ratio[i] = Math.min(hi, Math.max(lo, L[i] > 1e-5 ? Df[i] / L[i] : 1));
    // band the tile resolves: L (periods >= ~2 texels) minus a 1.5-texel Gaussian (periods >= ~8 texels)
    const Lc = blurWrap(lumLinear, W, H, 1.5 * tileTexelMeters / mppU, 1.5 * tileTexelMeters / mppV);
    let mean = 0, v = 0;
    for (let i = 0; i < W * H; i++) mean += lumLinear[i];
    mean /= W * H;
    for (let i = 0; i < W * H; i++) v += (L[i] - Lc[i]) ** 2;
    const contrast = mean > 1e-6 ? Math.sqrt(v / (W * H)) / mean : 0;
    const k = opts.structureContrastScale ?? 0.1;
    return { sample: opts.sample ?? -1, width: W, height: H, mppU, mppV, ratio, resolvableStructureContrast: contrast, structureWeight: Math.exp(-0.5 * (contrast / k) ** 2) };
}

function sampleWrap(m: DetailMap, s: number, t: number): number {
    const x = s / m.mppU - 0.5, y = -t / m.mppV - 0.5;
    const W = m.width, H = m.height;
    const xf = Math.floor(x), yf = Math.floor(y), fx = x - xf, fy = y - yf;
    const x0 = ((xf % W) + W) % W, y0 = ((yf % H) + H) % H, x1 = (x0 + 1) % W, y1 = (y0 + 1) % H;
    const r = m.ratio;
    return (r[y0 * W + x0] * (1 - fx) + r[y0 * W + x1] * fx) * (1 - fy) + (r[y1 * W + x0] * (1 - fx) + r[y1 * W + x1] * fx) * fy;
}

// ============================================================================================
// Bake
// ============================================================================================

export interface BakeOptions {
    /** Upscale factors considered (powers of two). Default [2, 4]. */
    maxScale?: number;
    /** Total output budget in bytes. Default 45 MB. */
    budgetBytes?: number;
    jpegQuality?: number;
    /** Tile low-pass sigma in tile texels (the tile Nyquist). Default 0.42. */
    lowPassSigmaTexels?: number;
    /** Ratio clamp. Default [0.45, 1.9]. */
    ratioRange?: [number, number];
    /** Per-texel colour likelihood scale (CIE76 units) added to each candidate's source-tile colour spread. Default 8. */
    texelColourSigma?: number;
    /** Scale of the resolvable-structure contrast penalty (see DetailMap.structureWeight). Default 0.1. */
    structureContrastScale?: number;
    /** Gutter dilation (upscaled texels) beyond chart edges. Default 2 * s + 2. */
    gutterTexels?: number;
    /** Exponent on the per-texel candidate weights before mixing their detail (1 = linear blend). Default 4. */
    candidateMixSharpness?: number;
    /** An atlas is replaced only when the Laplacian variance over its detail texels grows at least this much. Default 1.1. */
    minSharpnessGain?: number;
    /**
     * Largest fraction of textured blocks (above the flat-block energy floor) allowed to lose more than 3% Laplacian energy
     * after encoding; above it the next fallback quality is tried, then the atlas is kept. Default 0.005.
     */
    maxLossBlockFraction?: number;
    /** JPEG qualities tried after `jpegQuality` when encoding loses local sharpness. Default [95]. */
    fallbackJpegQualities?: number[];
    /** Report only: write nothing but the plan. */
    dryRun?: boolean;
    log?: (msg: string) => void;
}

export interface PrimitiveBakeReport {
    imageIndex: number;
    primitives: number[];
    sourceSize: [number, number];
    scale: number;
    outputSize: [number, number];
    replaced: boolean;
    reason?: string;
    tileTexelMeters: number;
    areaM2: number;
    /** Area of triangles on assigned clusters, and the alpha-weighted area (m^2). */
    assignedAreaM2: number;
    coveredAreaM2: number;
    coverageFraction: number;
    /** Texels on charts with alpha > 0.1 (upscaled grid). */
    detailTexels: number;
    /** Laplacian variance (8-bit luma) of output vs the bicubic-upscaled tile over detail texels. */
    sharpness: { before: number; after: number; ratio: number } | null;
    /** Same over every chart texel of the image. */
    sharpnessAllTexels: { before: number; after: number; ratio: number } | null;
    /**
     * Textured blocks (4 tile texels square, Laplacian energy above the flat floor) whose energy after encoding fell more
     * than 3% below the displayed original (bilinear magnification) or below the same-quality re-encode of the upscaled
     * tile: sharpness lost because of the method, out of `blocksChecked`.
     */
    blocksWithSharpnessLoss: number;
    blocksChecked: number;
    /** Textured blocks more than 3% below the exact (unencoded) bicubic upscale; includes the JPEG container's own loss. */
    blocksBelowBicubic: number;
    jpegQuality?: number;
    blocksReverted: number;
    materials: Array<{ label: string; sample: string; areaM2: number }>;
    /** Swatches considered for this atlas with their resolvable-structure contrast and resulting weight. */
    swatches: Array<{ sample: string; resolvableStructureContrast: number; structureWeight: number }>;
    bytesBefore: number;
    bytesAfter: number;
}

export interface BakeResult {
    glb: Buffer;
    reports: PrimitiveBakeReport[];
    totals: { images: number; replaced: number; areaM2: number; coveredAreaM2: number; bytesIn: number; bytesOut: number };
}

interface TexelRaster { tri: Int32Array; b0: Float32Array; b1: Float32Array; chart: Uint8Array }

/** Bilinear magnification (centre-aligned, edge-clamped) of interleaved linear RGB: what a GPU shows for the original atlas. */
export function upsampleBilinear3(src: Float32Array, w: number, h: number, s: number): Float32Array {
    const W = w * s, H = h * s, out = new Float32Array(W * H * 3);
    for (let y = 0; y < H; y++) {
        const v = Math.min(h - 1, Math.max(0, (y + 0.5) / s - 0.5)), y0 = Math.floor(v), y1 = Math.min(h - 1, y0 + 1), fy = v - y0;
        for (let x = 0; x < W; x++) {
            const u = Math.min(w - 1, Math.max(0, (x + 0.5) / s - 0.5)), x0 = Math.floor(u), x1 = Math.min(w - 1, x0 + 1), fx = u - x0;
            for (let c = 0; c < 3; c++) {
                out[(y * W + x) * 3 + c] = (src[(y0 * w + x0) * 3 + c] * (1 - fx) + src[(y0 * w + x1) * 3 + c] * fx) * (1 - fy)
                    + (src[(y1 * w + x0) * 3 + c] * (1 - fx) + src[(y1 * w + x1) * 3 + c] * fx) * fy;
            }
        }
    }
    return out;
}

/** Rasterises triangles into an atlas at W x H (texel centres at +0.5) with barycentrics; gutters dilated from the nearest chart texel. */
function rasterizeAtlas(prims: BasePrimitive[], W: number, H: number, gutter: number): TexelRaster {
    const tri = new Int32Array(W * H).fill(-1), b0 = new Float32Array(W * H), b1 = new Float32Array(W * H), chart = new Uint8Array(W * H);
    for (const p of prims) {
        if (!p.uvs) continue;
        const U = p.uvs;
        for (let t = 0; t < p.indices.length / 3; t++) {
            const a = p.indices[t * 3], b = p.indices[t * 3 + 1], c = p.indices[t * 3 + 2];
            const ax = U[a * 2] * W, ay = U[a * 2 + 1] * H, bx = U[b * 2] * W, by = U[b * 2 + 1] * H, cx = U[c * 2] * W, cy = U[c * 2 + 1] * H;
            const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
            if (Math.abs(area) < 1e-12) continue;
            const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
            const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
            const g = p.triOffset + t;
            for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                const i = y * W + x;
                if (tri[i] >= 0) continue;
                const px = x + 0.5, py = y + 0.5;
                const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
                const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
                if (w0 < -1e-7 || w1 < -1e-7 || 1 - w0 - w1 < -1e-7) continue;
                tri[i] = g; b0[i] = w0; b1[i] = w1; chart[i] = 1;
            }
        }
    }
    // gutters: breadth-first from chart texels; extrapolated barycentrics of the source triangle
    const uvOf = new Map<number, { p: BasePrimitive; t: number }>();
    for (const p of prims) for (let t = 0; t < p.indices.length / 3; t++) uvOf.set(p.triOffset + t, { p, t });
    let frontier: number[] = [];
    for (let i = 0; i < W * H; i++) if (tri[i] >= 0) frontier.push(i);
    for (let step = 0; step < gutter && frontier.length; step++) {
        const next: number[] = [];
        for (const i of frontier) {
            const x = i % W, y = (i / W) | 0;
            for (const j of [x > 0 ? i - 1 : -1, x + 1 < W ? i + 1 : -1, y > 0 ? i - W : -1, y + 1 < H ? i + W : -1]) {
                if (j < 0 || tri[j] >= 0) continue;
                const g = tri[i];
                const ref = uvOf.get(g)!;
                const U = ref.p.uvs!, a = ref.p.indices[ref.t * 3], b = ref.p.indices[ref.t * 3 + 1], c = ref.p.indices[ref.t * 3 + 2];
                const ax = U[a * 2] * W, ay = U[a * 2 + 1] * H, bx = U[b * 2] * W, by = U[b * 2 + 1] * H, cx = U[c * 2] * W, cy = U[c * 2 + 1] * H;
                const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
                const px = (j % W) + 0.5, py = ((j / W) | 0) + 0.5;
                tri[j] = g;
                b0[j] = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
                b1[j] = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
                next.push(j);
            }
        }
        frontier = next;
    }
    return { tri, b0, b1, chart };
}

interface GroupPlan {
    imageIndex: number;
    prims: BasePrimitive[];
    width: number;
    height: number;
    tileTexel: number;
    areaM2: number;
    assignedArea: number;
    priority: number;
    maxUsefulScale: number;
    scale: number;
}

const lumaLin = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Linear [0, 1] -> sRGB8 through a 16-bit table (max error < 0.1 level; the encode loops touch 10^7 values). */
const LIN_TO_SRGB8 = (() => { const t = new Uint8Array(65536); for (let i = 0; i < 65536; i++) t[i] = linearToSrgb8(i / 65535); return t; })();
const toSrgb8Fast = (v: number): number => LIN_TO_SRGB8[v <= 0 ? 0 : v >= 1 ? 65535 : (v * 65535 + 0.5) | 0];

function lapEnergyBlocks(Y: Float32Array, W: number, H: number, B: number, mask: Uint8Array): Float64Array {
    const bw = Math.ceil(W / B), bh = Math.ceil(H / B);
    const e = new Float64Array(bw * bh);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (!mask[i]) continue;
        const l = Y[i - 1] + Y[i + 1] + Y[i - W] + Y[i + W] - 4 * Y[i];
        e[((y / B) | 0) * bw + ((x / B) | 0)] += l * l;
    }
    return e;
}

/**
 * Bakes library material detail into the scan's atlases. `assignments` come from classifyClusters (optionally
 * refined by disambiguateClusters); `library` swatch files are resolved against `libraryDir`.
 */
export async function bakeMaterialDetail(
    scan: BaseScan, triCluster: Int32Array, clusters: PlaneCluster[], assignments: ClusterAssignment[],
    library: MaterialLibrary, libraryDir: string, images: LinearImageCache, opts: BakeOptions = {}
): Promise<BakeResult> {
    const log = opts.log ?? (() => undefined);
    const maxScale = opts.maxScale ?? 4, budget = opts.budgetBytes ?? 45 * 1024 * 1024, q = opts.jpegQuality ?? 90;
    const lp = opts.lowPassSigmaTexels ?? 0.42;
    const sigmaPx0 = opts.texelColourSigma ?? 8;
    const minGain = opts.minSharpnessGain ?? 1.1;
    const mixSharpness = opts.candidateMixSharpness ?? 4;
    const maxLossFraction = opts.maxLossBlockFraction ?? 0.005;
    const assignOf = new Map<number, ClusterAssignment>();
    for (const a of assignments) if (a.candidates.length && a.confidence > 0) assignOf.set(a.cluster, a);
    const assignArr: Array<ClusterAssignment | undefined> = clusters.map(c => assignOf.get(c.id));

    // ---------------- group primitives by image, plan scales ----------------
    const groups = new Map<number, GroupPlan>();
    const triArea = (p: BasePrimitive, t: number) => {
        const P = p.positions, a = p.indices[t * 3], b = p.indices[t * 3 + 1], c = p.indices[t * 3 + 2];
        const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
        const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
        return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    };
    for (const p of scan.prims) {
        if (p.imageIndex === null || !p.uvs) continue;
        let g = groups.get(p.imageIndex);
        if (!g) {
            const img = await images.get(p.imageIndex);
            if (!img) continue;
            g = { imageIndex: p.imageIndex, prims: [], width: img.width, height: img.height, tileTexel: 0, areaM2: 0, assignedArea: 0, priority: 0, maxUsefulScale: 1, scale: 1 };
            groups.set(p.imageIndex, g);
        }
        g.prims.push(p);
    }
    const texelLists = new Map<number, Array<[number, number]>>();
    const mppLists = new Map<number, Array<[number, number]>>();
    for (const g of groups.values()) {
        const tl: Array<[number, number]> = [], ml: Array<[number, number]> = [];
        for (const p of g.prims) {
            const U = p.uvs!;
            for (let t = 0; t < p.indices.length / 3; t++) {
                const A = triArea(p, t);
                g.areaM2 += A;
                const a = p.indices[t * 3], b = p.indices[t * 3 + 1], c = p.indices[t * 3 + 2];
                const auv = 0.5 * Math.abs((U[b * 2] - U[a * 2]) * (U[c * 2 + 1] - U[a * 2 + 1]) - (U[b * 2 + 1] - U[a * 2 + 1]) * (U[c * 2] - U[a * 2])) * g.width * g.height;
                if (auv > 1e-9 && A > 1e-6) tl.push([Math.sqrt(A / auv), A]);
                const as = assignOf.get(triCluster[p.triOffset + t]);
                if (as) {
                    g.assignedArea += A * as.confidence;
                    const m = library.samples[as.candidates[0].sample];
                    ml.push([Math.max(m.metresPerPixel.u, m.metresPerPixel.v), A]);
                }
            }
        }
        texelLists.set(g.imageIndex, tl); mppLists.set(g.imageIndex, ml);
    }
    const wmed = (l: Array<[number, number]>) => {
        if (!l.length) return NaN;
        const s = l.slice().sort((a, b) => a[0] - b[0]);
        const tot = s.reduce((acc, v) => acc + v[1], 0);
        let acc = 0;
        for (const [v, w] of s) { acc += w; if (acc >= tot / 2) return v; }
        return s[s.length - 1][0];
    };
    const plans: GroupPlan[] = [];
    for (const g of groups.values()) {
        g.tileTexel = wmed(texelLists.get(g.imageIndex)!);
        const mpp = wmed(mppLists.get(g.imageIndex)!);
        if (!(g.assignedArea > 0) || !Number.isFinite(mpp) || !Number.isFinite(g.tileTexel)) continue;
        const useful = g.tileTexel / mpp;
        g.maxUsefulScale = useful >= 4 ? 4 : useful >= 2 ? 2 : 1;
        g.scale = Math.min(maxScale, g.maxUsefulScale);
        if (g.scale < 2) continue;
        g.priority = g.assignedArea * Math.log2(useful);
        plans.push(g);
    }
    plans.sort((a, b) => b.priority - a.priority);
    const originalBytes = (g: GroupPlan) => scan.imageBytes[g.imageIndex]?.length ?? 0;
    const glbBytesIn = scan.bin.length + Buffer.byteLength(JSON.stringify(scan.json)) + 64;
    const estimate = (g: GroupPlan, s: number) => Math.round(g.width * s * g.height * s * 0.22); // bytes at q90 (measured ~1.7 bit/texel)
    const total = () => glbBytesIn + plans.reduce((acc, g) => acc + (g.scale >= 2 ? estimate(g, g.scale) - originalBytes(g) : 0), 0);
    // downgrade lowest-priority 4x first, then drop lowest-priority groups
    for (let i = plans.length - 1; i >= 0 && total() > budget; i--) if (plans[i].scale > 2) plans[i].scale = 2;
    for (let i = plans.length - 1; i >= 0 && total() > budget; i--) plans[i].scale = 1;

    // ---------------- per-image bake ----------------
    const swatchLum = new Map<number, { W: number; H: number; Y: Float32Array }>();
    const loadSwatch = (si: number) => {
        let s = swatchLum.get(si);
        if (s) return s;
        const m = library.samples[si];
        const png = decodePng(fs.readFileSync(path.resolve(libraryDir, m.files.albedo)));
        const Y = new Float32Array(png.width * png.height);
        for (let i = 0; i < Y.length; i++) Y[i] = lumaLin(srgb8ToLinear(png.rgba[i * 4]), srgb8ToLinear(png.rgba[i * 4 + 1]), srgb8ToLinear(png.rgba[i * 4 + 2]));
        s = { W: png.width, H: png.height, Y };
        swatchLum.set(si, s);
        return s;
    };
    const replacements = new Map<number, Buffer>();
    const reports: PrimitiveBakeReport[] = [];
    for (const g of [...groups.values()].sort((a, b) => a.imageIndex - b.imageIndex)) {
        const rep: PrimitiveBakeReport = {
            imageIndex: g.imageIndex, primitives: g.prims.map(p => p.index), sourceSize: [g.width, g.height], scale: 1, outputSize: [g.width, g.height],
            replaced: false, tileTexelMeters: Number.isFinite(g.tileTexel) ? +g.tileTexel.toFixed(4) : 0, areaM2: +g.areaM2.toFixed(1),
            assignedAreaM2: 0, coveredAreaM2: 0, coverageFraction: 0, detailTexels: 0, sharpness: null, sharpnessAllTexels: null,
            blocksWithSharpnessLoss: 0, blocksChecked: 0, blocksBelowBicubic: 0, blocksReverted: 0, materials: [], swatches: [], bytesBefore: originalBytes(g), bytesAfter: originalBytes(g)
        };
        reports.push(rep);
        if (!plans.includes(g) || g.scale < 2) { rep.reason = g.assignedArea > 0 ? 'no resolution benefit or over budget' : 'no assigned material'; continue; }
        if (opts.dryRun) { rep.scale = g.scale; rep.reason = 'dry run'; continue; }
        const s = g.scale, W = g.width * s, H = g.height * s, n = W * H;
        const img = (await images.get(g.imageIndex))!;
        const Tup = upsampleBicubic3(img.lin, img.width, img.height, s);
        for (let i = 0; i < Tup.length; i++) Tup[i] = Tup[i] < 0 ? 0 : Tup[i] > 1 ? 1 : Tup[i];
        const ras = rasterizeAtlas(g.prims, W, H, opts.gutterTexels ?? 2 * s + 2);
        const covered = new Uint8Array(n);
        for (let i = 0; i < n; i++) covered[i] = ras.tri[i] >= 0 ? 1 : 0;
        const Lt = normalizedGaussian3(Tup, covered, W, H, lp * s);
        // detail maps for the candidates used by this image
        const detailOf = new Map<number, DetailMap>();
        const triPrimIdx = new Int32Array(scan.triCount).fill(-1);
        g.prims.forEach((p, pi) => { for (let t = 0; t < p.indices.length / 3; t++) triPrimIdx[p.triOffset + t] = pi; });
        const alpha = new Float32Array(n), R = new Float32Array(n).fill(1);
        const matArea = new Map<number, number>();
        // per-texel colour reference: the swatch in tile radiometry when known, else the tile at the source surface
        const refOf = (m: MaterialLibrarySample) => m.tileDomain?.lab ?? m.tile?.lab ?? null;
        const sigmaOf = (m: MaterialLibrarySample) => { const r = refOf(m); return Math.hypot(sigmaPx0, r ? Math.hypot(...r.std) : 0); };
        for (let i = 0; i < n; i++) {
            const gt = ras.tri[i];
            if (gt < 0) continue;
            const as = assignArr[triCluster[gt]];
            if (!as) continue;
            const c = clusters[triCluster[gt]];
            const p = g.prims[triPrimIdx[gt]], t = gt - p.triOffset;
            const a = p.indices[t * 3], b = p.indices[t * 3 + 1], cc = p.indices[t * 3 + 2];
            const w0 = ras.b0[i], w1 = ras.b1[i], w2 = 1 - w0 - w1;
            const P = p.positions;
            const dx = P[a * 3] * w0 + P[b * 3] * w1 + P[cc * 3] * w2 - c.origin[0];
            const dy = P[a * 3 + 1] * w0 + P[b * 3 + 1] * w1 + P[cc * 3 + 1] * w2 - c.origin[1];
            const dz = P[a * 3 + 2] * w0 + P[b * 3 + 2] * w1 + P[cc * 3 + 2] * w2 - c.origin[2];
            const su = dx * c.uAxis[0] + dy * c.uAxis[1] + dz * c.uAxis[2], tv = dx * c.vAxis[0] + dy * c.vAxis[1] + dz * c.vAxis[2];
            const texLab = linearRgbToLab(Math.max(0, Lt[i * 3]), Math.max(0, Lt[i * 3 + 1]), Math.max(0, Lt[i * 3 + 2]));
            let wsum = 0, rsum = 0, wmax = 0, best = -1, bestW = 0;
            for (const k of as.candidates) {
                const m = library.samples[k.sample];
                const ref = refOf(m);
                if (!ref) continue;
                const dE = Math.hypot(texLab[0] - ref.mean[0], texLab[1] - ref.mean[1], texLab[2] - ref.mean[2]);
                const wt = Math.exp(-0.5 * (dE / sigmaOf(m)) ** 2);
                if (wt < 1e-3) continue;
                let dm = detailOf.get(k.sample);
                if (!dm) {
                    const sw = loadSwatch(k.sample);
                    dm = buildDetailMap(sw.Y, sw.W, sw.H, m.metresPerPixel.u, m.metresPerPixel.v, g.tileTexel, s, { lowPassSigmaTexels: lp, ratioRange: opts.ratioRange, sample: k.sample, structureContrastScale: opts.structureContrastScale });
                    detailOf.set(k.sample, dm);
                }
                // sharpened mixture: one surface carries one material, so the best-matching swatch dominates (averaging
                // unrelated swatches would only cancel their detail) while transitions stay continuous
                const pw = Math.pow(wt * k.score * dm.structureWeight, mixSharpness);
                if (pw < 1e-8) continue;
                rsum += pw * sampleWrap(dm, su, tv); wsum += pw;
                if (wt * dm.structureWeight > wmax) wmax = wt * dm.structureWeight;
                if (pw > bestW) { bestW = pw; best = k.sample; }
            }
            if (wsum <= 0) continue;
            alpha[i] = as.confidence * wmax;
            R[i] = rsum / wsum;
            if (ras.chart[i] && best >= 0) matArea.set(best, (matArea.get(best) ?? 0) + alpha[i]);
        }
        // smooth alpha inside charts (no hard steps at cluster or colour boundaries), and the tile's local high-band
        // energy, in one pass (channels: alpha, tile high band^2)
        const YL = new Float32Array(n), pack = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            YL[i] = lumaLin(Lt[i * 3], Lt[i * 3 + 1], Lt[i * 3 + 2]);
            const hT = lumaLin(Tup[i * 3], Tup[i * 3 + 1], Tup[i * 3 + 2]) - YL[i];
            pack[i * 3] = alpha[i]; pack[i * 3 + 1] = hT * hT;
        }
        const packS = normalizedGaussian3(pack, covered, W, H, s);
        const EM2 = new Float32Array(n * 3), ET2s = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            alpha[i] = covered[i] ? packS[i * 3] : 0;
            ET2s[i * 3] = packS[i * 3 + 1];
            const dm = alpha[i] * YL[i] * (R[i] - 1);
            EM2[i * 3] = dm * dm;
        }
        const EM2s = normalizedGaussian3(EM2, covered, W, H, s);
        const delta = new Float32Array(n * 3);
        let detailTexels = 0;
        for (let i = 0; i < n; i++) {
            if (!(alpha[i] > 0) || R[i] === 1) continue;
            const em = EM2s[i * 3], et = ET2s[i * 3];
            const gte = em > 1e-12 ? Math.min(1, Math.max(0, 1 - et / em)) : 0;
            const k = alpha[i] * gte * (R[i] - 1);
            if (k === 0) continue;
            for (let c = 0; c < 3; c++) delta[i * 3 + c] = Lt[i * 3 + c] * k;
            if (alpha[i] > 0.1 && ras.chart[i]) detailTexels++;
        }
        // per-block guarantee: Laplacian energy (display luma) never below the upscaled tile's
        const B = 4 * s, bw = Math.ceil(W / B), bh = Math.ceil(H / B);
        const lumaSrgb = (buf: Float32Array, add?: Float32Array, kmap?: Float32Array) => {
            const Y = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                const kk = kmap ? kmap[i] : 1;
                const r = buf[i * 3] + (add ? add[i * 3] * kk : 0), gg = buf[i * 3 + 1] + (add ? add[i * 3 + 1] * kk : 0), b2 = buf[i * 3 + 2] + (add ? add[i * 3 + 2] * kk : 0);
                Y[i] = 0.2126 * toSrgb8Fast(r) + 0.7152 * toSrgb8Fast(gg) + 0.0722 * toSrgb8Fast(b2);
            }
            return Y;
        };
        const chartMask = ras.chart;
        const eBase = lapEnergyBlocks(lumaSrgb(Tup), W, H, B, chartMask);
        const blockK = new Float32Array(bw * bh).fill(1);
        const kmap = new Float32Array(n).fill(1);
        let reverted = 0;
        for (let iter = 0; iter < 3; iter++) {
            const eOut = lapEnergyBlocks(lumaSrgb(Tup, delta, kmap), W, H, B, chartMask);
            let changed = 0;
            for (let k = 0; k < bw * bh; k++) if (eBase[k] > 0 && eOut[k] < eBase[k] * 0.995 && blockK[k] > 0) { blockK[k] = 0; changed++; }
            if (!changed) break;
            reverted += changed;
            // a reverted block also zeroes its texels' kmap (hard, so the check is exact for that block)
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) kmap[y * W + x] = blockK[((y / B) | 0) * bw + ((x / B) | 0)];
        }
        // compose and encode
        const outRgba = Buffer.alloc(n * 4);
        for (let i = 0; i < n; i++) {
            for (let c = 0; c < 3; c++) outRgba[i * 4 + c] = toSrgb8Fast(Tup[i * 3 + c] + delta[i * 3 + c] * kmap[i]);
            outRgba[i * 4 + 3] = 255;
        }
        // Measurements on the encoded result. Three baselines for local sharpness (per block of 4 tile texels):
        //   display  - the original atlas magnified bilinearly, i.e. what a viewer shows for the base today;
        //   reencode - the bicubic-upscaled tile through the same JPEG encoder and quality (container loss only);
        //   bicubic  - the exact bicubic-upscaled tile (strictest, reported).
        // A block counts as a method-caused loss when it falls more than 3% below the display or the re-encode baseline.
        const baseRgba = Buffer.alloc(n * 4);
        for (let i = 0; i < n; i++) { for (let c = 0; c < 3; c++) baseRgba[i * 4 + c] = toSrgb8Fast(Tup[i * 3 + c]); baseRgba[i * 4 + 3] = 255; }
        const Yb = luminance8(baseRgba, n);
        const eB2 = lapEnergyBlocks(Yb, W, H, B, chartMask);
        const Bl = upsampleBilinear3(img.lin, img.width, img.height, s);
        const dispRgba = Buffer.alloc(n * 4);
        for (let i = 0; i < n; i++) { for (let c = 0; c < 3; c++) dispRgba[i * 4 + c] = toSrgb8Fast(Bl[i * 3 + c]); dispRgba[i * 4 + 3] = 255; }
        const eDisp = lapEnergyBlocks(luminance8(dispRgba, n), W, H, B, chartMask);
        // blocks below this Laplacian energy (2 levels RMS per texel) are flat: 8-bit / JPEG noise, not sharpness
        const floor = 4 * B * B;
        let jpeg: Buffer = Buffer.alloc(0), Yo: Float32Array = new Float32Array(0), checked = 0, lossBlocks = 0, lossVsBicubic = 0, usedQuality = q;
        for (const qq of [q, ...(opts.fallbackJpegQualities ?? [95])].filter((v, i, arr) => v >= q && arr.indexOf(v) === i)) {
            jpeg = await encodeRgbaToJpeg(outRgba, W, H, { quality: qq });
            Yo = luminance8((await decodeImageToRgba(jpeg)).rgba, n);
            const eEnc = lapEnergyBlocks(Yo, W, H, B, chartMask);
            const eRe = lapEnergyBlocks(luminance8((await decodeImageToRgba(await encodeRgbaToJpeg(baseRgba, W, H, { quality: qq }))).rgba, n), W, H, B, chartMask);
            checked = 0; lossBlocks = 0; lossVsBicubic = 0; usedQuality = qq;
            for (let k = 0; k < bw * bh; k++) {
                if (!(Math.max(eB2[k], eDisp[k]) > floor)) continue;
                checked++;
                if (eEnc[k] < 0.97 * eDisp[k] || eEnc[k] < 0.97 * eRe[k]) lossBlocks++;
                if (eEnc[k] < 0.97 * eB2[k]) lossVsBicubic++;
            }
            if (lossBlocks <= maxLossFraction * checked) break;
        }
        const detailMask = new Uint8Array(n);
        let cov = 0;
        for (let i = 0; i < n; i++) if (chartMask[i] && alpha[i] > 0.1 && kmap[i] > 0) { detailMask[i] = 1; }
        const lb = laplacianVariance(Yb, W, H, detailMask), la = laplacianVariance(Yo, W, H, detailMask);
        const lbAll = laplacianVariance(Yb, W, H, chartMask), laAll = laplacianVariance(Yo, W, H, chartMask);
        // coverage in m^2: alpha-weighted chart texels times their surface area
        let chartTexels = 0;
        for (let i = 0; i < n; i++) if (chartMask[i]) { chartTexels++; cov += alpha[i] * kmap[i]; }
        const texelArea = g.areaM2 / Math.max(1, chartTexels);
        let assignedTexels = 0;
        for (let i = 0; i < n; i++) if (chartMask[i] && assignOf.has(triCluster[ras.tri[i]])) assignedTexels++;
        rep.scale = s; rep.outputSize = [W, H];
        rep.detailTexels = detailTexels;
        rep.assignedAreaM2 = +(assignedTexels * texelArea).toFixed(1);
        rep.coveredAreaM2 = +(cov * texelArea).toFixed(1);
        rep.coverageFraction = +(cov / Math.max(1, chartTexels)).toFixed(4);
        rep.sharpness = lb.pixels ? { before: +lb.variance.toFixed(3), after: +la.variance.toFixed(3), ratio: +(la.variance / Math.max(1e-9, lb.variance)).toFixed(3) } : null;
        rep.sharpnessAllTexels = lbAll.pixels ? { before: +lbAll.variance.toFixed(3), after: +laAll.variance.toFixed(3), ratio: +(laAll.variance / Math.max(1e-9, lbAll.variance)).toFixed(3) } : null;
        rep.blocksChecked = checked; rep.blocksWithSharpnessLoss = lossBlocks; rep.blocksBelowBicubic = lossVsBicubic; rep.blocksReverted = reverted;
        rep.materials = [...matArea.entries()].sort((a, b) => b[1] - a[1]).map(([si, a]) => ({ label: library.samples[si].label, sample: library.samples[si].id, areaM2: +(a * texelArea).toFixed(1) }));
        rep.swatches = [...detailOf.values()].map(d => ({ sample: library.samples[d.sample].id, resolvableStructureContrast: +d.resolvableStructureContrast.toFixed(4), structureWeight: +d.structureWeight.toFixed(4) }));
        rep.jpegQuality = usedQuality;
        const skip = (reason: string) => { rep.reason = reason; log(`image ${g.imageIndex}: kept (${reason})`); };
        if (detailTexels === 0) { skip('no texel received detail'); continue; }
        if (!rep.sharpness || rep.sharpness.ratio < minGain) { skip(`no measurable sharpness gain (x${rep.sharpness?.ratio ?? '-'} < ${minGain})`); continue; }
        if (lossBlocks > maxLossFraction * checked) { skip(`re-encoding would reduce local sharpness in ${lossBlocks} of ${checked} blocks`); continue; }
        replacements.set(g.imageIndex, jpeg);
        rep.replaced = true; rep.bytesAfter = jpeg.length;
        log(`image ${g.imageIndex}: ${img.width}x${img.height} -> ${W}x${H}, covered ${rep.coveredAreaM2} m2 (${(100 * rep.coverageFraction).toFixed(1)}%), sharpness x${rep.sharpness?.ratio ?? '-'}, loss blocks ${lossBlocks}/${checked}, q${usedQuality}, ${(jpeg.length / 1024).toFixed(0)} KB`);
    }
    // ---------------- budget after encoding ----------------
    const assembled = () => assembleGlb(scan, replacements);
    let glb = assembled();
    const byPriority = plans.slice().reverse();
    for (const g of byPriority) {
        if (glb.length <= budget) break;
        if (!replacements.has(g.imageIndex)) continue;
        replacements.delete(g.imageIndex);
        const rep = reports.find(r => r.imageIndex === g.imageIndex)!;
        rep.replaced = false; rep.reason = 'dropped for the byte budget'; rep.bytesAfter = rep.bytesBefore;
        glb = assembled();
    }
    let area = 0, covered = 0;
    for (const r of reports) { area += r.areaM2; if (r.replaced) covered += r.coveredAreaM2; }
    return { glb, reports, totals: { images: reports.length, replaced: replacements.size, areaM2: +area.toFixed(1), coveredAreaM2: +covered.toFixed(1), bytesIn: scan.bin.length, bytesOut: glb.length } };
}

/** Re-packs the GLB with replaced image bytes; every other buffer view is copied byte-for-byte; JSON otherwise unchanged. */
export function assembleGlb(scan: BaseScan, replacements: Map<number, Buffer>): Buffer {
    const json = JSON.parse(JSON.stringify(scan.json));
    const viewOfImage = new Map<number, number>();
    (json.images ?? []).forEach((img: any, i: number) => { if (img.bufferView !== undefined) viewOfImage.set(img.bufferView, i); });
    const views: Buffer[] = (json.bufferViews ?? []).map((v: any, vi: number) => {
        const ii = viewOfImage.get(vi);
        if (ii !== undefined && replacements.has(ii)) return replacements.get(ii)!;
        return scan.bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength);
    });
    for (const [ii] of replacements) if (json.images[ii]) json.images[ii].mimeType = 'image/jpeg';
    return GltfBinaryPacker.packGlb(json, views, true).glbBuffer;
}
