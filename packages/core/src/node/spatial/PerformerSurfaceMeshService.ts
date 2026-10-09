/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { decodeGaussianPly } from '../../common/gaussian-ply-codec';
import { SBHUMAN22_PARENTS, CANONICAL_22_JOINT_NAMES, DEFAULT_CANONICAL_JOINTS } from '../../common/humanoid-skinning';
import { GvhmrBody, GvhmrBodyService } from './GvhmrBodyService';

type Vec3 = [number, number, number];

/** Indexed triangle mesh with 4-bone LBS weights, in the avatar's canonical (rest) frame. */
export interface SurfaceMesh {
    positions: Float32Array;
    indices: Uint32Array;
    skinIndices: Uint8Array;
    skinWeights: Float32Array;
    normals?: Float32Array;
    /** Linear RGB per vertex (glTF COLOR_0 convention). */
    colors?: Float32Array;
    /** UV texture coordinates [u, v] per vertex (glTF TEXCOORD_0 convention). */
    uvs?: Float32Array;
    /** Camera-space positions at hero frame 0 for optical texture projection. */
    camPositions?: Float32Array;
}

export interface SurfaceSplat {
    position: Vec3;
    /** Display (sRGB) color as stored in the 3DGS PLY. */
    colorRgb: Vec3;
    opacity: number;
    /** Primary skinning bone; when present a vertex only draws from splats on its own or adjacent bones. */
    bone?: number;
}

export interface SurfaceFitOptions {
    /** Largest outward displacement toward the splat shell, meters (clothing, hair). */
    maxOffset?: number;
    /** Splats below this opacity are ignored. */
    minOpacity?: number;
    /** Convert sRGB splat colors to linear for COLOR_0. Defaults to true. */
    linearizeColors?: boolean;
    /** Per-bone displacement caps, blended by skin weight (defaults keep SB-Human fingers and face anatomical). */
    boneMaxOffset?: Record<number, number>;
    /** Optional high-resolution hero frame RGB24 buffer for optical facial and cloth texture projection. */
    heroImageRgb?: Buffer | Uint8Array;
    heroImageWidth?: number;
    heroImageHeight?: number;
    K?: number[][];
}

const DEFAULT_BONE_MAX_OFFSET: Record<number, number> = {
    15: 0.00, // Head: 100% anatomical lock to SB-Human facial features
    20: 0.00, // Left wrist/hand: 100% anatomical lock to fingers
    21: 0.00  // Right wrist/hand: 100% anatomical lock to fingers
};

export interface SurfaceBuildOptions extends SurfaceFitOptions {
    subdivisionLevels?: number;
}

const BONE_ADJACENCY: number[] = SBHUMAN22_PARENTS.map((parent, j) => {
    let mask = 1 << j;
    if (parent >= 0) mask |= 1 << parent;
    SBHUMAN22_PARENTS.forEach((p, c) => { if (p === j) mask |= 1 << c; });
    return mask;
});

/** Bitmask of bones a vertex may draw splats from: its weighted bones plus their parents and children. */
function vertexBoneMask(mesh: SurfaceMesh, i: number): number {
    let mask = 0;
    for (let k = 0; k < 4; k++) {
        const b = mesh.skinIndices[i * 4 + k];
        if (mesh.skinWeights[i * 4 + k] > 0.01 && b < BONE_ADJACENCY.length) mask |= BONE_ADJACENCY[b];
    }
    return mask;
}

function splatAllowed(s: SurfaceSplat, mask: number): boolean {
    return s.bone === undefined || mask === 0 || (mask & (1 << s.bone)) !== 0;
}

function srgbToLinear(c: number): number {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export interface EncodeGlbOptions {
    /**
     * Whether to embed glTF 2.0 skinning (skin object, inverseBindMatrices accessor,
     * and bone node hierarchy). Defaults to true.
     */
    includeSkin?: boolean;
    /** Canonical rest joint positions (22 Vec3). Defaults to DEFAULT_CANONICAL_JOINTS. */
    canonicalJoints?: Array<[number, number, number]>;
    /** Joint parent indices (22 ints). Defaults to SBHUMAN22_PARENTS. */
    jointParents?: number[];
    /** Joint names. Defaults to CANONICAL_22_JOINT_NAMES. */
    jointNames?: readonly string[] | string[];
    /** PBR Metallic-Roughness material options. */
    material?: {
        name?: string;
        baseColorFactor?: [number, number, number, number];
        metallicFactor?: number;
        roughnessFactor?: number;
        doubleSided?: boolean;
    };
    /** Include UV coordinates in glTF primitive if available. Defaults to true. */
    includeUvs?: boolean;
}

/**
 * Builds the "Photoreal Surface" mesh for an avatar: the fitted SB-Human rest mesh, subdivided,
 * pushed out to the trained splats' outer shell (clothing/hair volume) and colored from them.
 * The result shares the splats' canonical frame and bone weights, so the viewer skins both identically.
 */
export class PerformerSurfaceMeshService {

    static fromBody(body: GvhmrBody): SurfaceMesh {
        const n = body.rest_vertices.length;
        const mesh: SurfaceMesh = {
            positions: new Float32Array(n * 3),
            indices: new Uint32Array(body.faces.length * 3),
            skinIndices: new Uint8Array(n * 4),
            skinWeights: new Float32Array(n * 4)
        };
        body.rest_vertices.forEach((v, i) => mesh.positions.set(v, i * 3));
        body.faces.forEach((f, i) => mesh.indices.set(f, i * 3));
        body.skin_indices.forEach((s, i) => mesh.skinIndices.set(s, i * 4));
        body.skin_weights.forEach((w, i) => mesh.skinWeights.set(w, i * 4));
        if (body.hero_incam_vertices && body.hero_incam_vertices.length === n) {
            mesh.camPositions = new Float32Array(n * 3);
            body.hero_incam_vertices.forEach((v, i) => mesh.camPositions!.set(v, i * 3));
        }
        return mesh;
    }

    /** 1-to-4 midpoint subdivision (shape preserving); edge midpoints blend the endpoint skin weights. */
    static subdivideMidpoint(mesh: SurfaceMesh, levels: number): SurfaceMesh {
        let cur = mesh;
        for (let l = 0; l < levels; l++) cur = PerformerSurfaceMeshService.subdivideOnce(cur);
        return cur;
    }

    private static subdivideOnce(mesh: SurfaceMesh): SurfaceMesh {
        const nv = mesh.positions.length / 3;
        const nf = mesh.indices.length / 3;
        const edgeMid = new Map<number, number>();
        const newPos: number[] = Array.from(mesh.positions);
        const newSkinI: number[] = Array.from(mesh.skinIndices);
        const newSkinW: number[] = Array.from(mesh.skinWeights);
        const newCamPos: number[] | null = mesh.camPositions ? Array.from(mesh.camPositions) : null;
        const midpoint = (a: number, b: number): number => {
            const key = a < b ? a * nv + b : b * nv + a;
            const hit = edgeMid.get(key);
            if (hit !== undefined) return hit;
            const idx = newPos.length / 3;
            for (let k = 0; k < 3; k++) newPos.push((mesh.positions[a * 3 + k] + mesh.positions[b * 3 + k]) / 2);
            if (newCamPos && mesh.camPositions) {
                for (let k = 0; k < 3; k++) newCamPos.push((mesh.camPositions[a * 3 + k] + mesh.camPositions[b * 3 + k]) / 2);
            }
            const blend = new Map<number, number>();
            for (const v of [a, b]) {
                for (let k = 0; k < 4; k++) {
                    const w = mesh.skinWeights[v * 4 + k];
                    if (w > 0) blend.set(mesh.skinIndices[v * 4 + k], (blend.get(mesh.skinIndices[v * 4 + k]) || 0) + w / 2);
                }
            }
            const top = [...blend.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4);
            const sum = top.reduce((s, [, w]) => s + w, 0) || 1;
            for (let k = 0; k < 4; k++) {
                newSkinI.push(top[k] ? top[k][0] : 0);
                newSkinW.push(top[k] ? top[k][1] / sum : 0);
            }
            edgeMid.set(key, idx);
            return idx;
        };
        const indices = new Uint32Array(nf * 12);
        for (let f = 0; f < nf; f++) {
            const a = mesh.indices[f * 3], b = mesh.indices[f * 3 + 1], c = mesh.indices[f * 3 + 2];
            const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
            indices.set([a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca], f * 12);
        }
        return {
            positions: new Float32Array(newPos),
            indices,
            skinIndices: new Uint8Array(newSkinI),
            skinWeights: new Float32Array(newSkinW),
            camPositions: newCamPos ? new Float32Array(newCamPos) : undefined
        };
    }

    static computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
        const normals = new Float32Array(positions.length);
        for (let f = 0; f < indices.length; f += 3) {
            const a = indices[f] * 3, b = indices[f + 1] * 3, c = indices[f + 2] * 3;
            const e1 = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
            const e2 = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
            const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
            for (const v of [a, b, c]) { normals[v] += nx; normals[v + 1] += ny; normals[v + 2] += nz; }
        }
        for (let i = 0; i < normals.length; i += 3) {
            const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
            normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l;
        }
        return normals;
    }

    private static neighbors(nv: number, indices: Uint32Array): number[][] {
        const adj: Set<number>[] = Array.from({ length: nv }, () => new Set<number>());
        for (let f = 0; f < indices.length; f += 3) {
            const t = [indices[f], indices[f + 1], indices[f + 2]];
            for (let k = 0; k < 3; k++) { adj[t[k]].add(t[(k + 1) % 3]); adj[t[k]].add(t[(k + 2) % 3]); }
        }
        return adj.map(s => [...s]);
    }

    private static smooth(values: Float32Array, adj: number[][], iterations: number): Float32Array {
        let cur = values;
        for (let it = 0; it < iterations; it++) {
            const next = new Float32Array(cur.length);
            for (let i = 0; i < cur.length; i++) {
                let s = cur[i], n = 1;
                for (const j of adj[i]) { s += cur[j]; n++; }
                next[i] = s / n;
            }
            cur = next;
        }
        return cur;
    }

    /**
     * Nearest mesh vertex for every splat within one grid cell of reach (-1 if none, or if the splat's
     * bone is unrelated to that vertex). Voronoi ownership keeps neighbouring fingers, limbs and the
     * far side of thin parts from claiming each other's splats.
     */
    private static assignSplats(mesh: SurfaceMesh, positions: Float32Array, splats: SurfaceSplat[], cell: number): Int32Array {
        const nv = positions.length / 3;
        const key = (x: number, y: number, z: number) => ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
        const grid = new Map<number, number[]>();
        for (let i = 0; i < nv; i++) {
            const k = key(Math.floor(positions[i * 3] / cell), Math.floor(positions[i * 3 + 1] / cell), Math.floor(positions[i * 3 + 2] / cell));
            let bucket = grid.get(k);
            if (!bucket) grid.set(k, bucket = []);
            bucket.push(i);
        }
        const masks = new Int32Array(nv).map((_, i) => vertexBoneMask(mesh, i));
        const owner = new Int32Array(splats.length).fill(-1);
        splats.forEach((s, si) => {
            const [x, y, z] = s.position;
            const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
            let best = -1, bestD = cell * cell;
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
                const bucket = grid.get(key(cx + dx, cy + dy, cz + dz));
                if (!bucket) continue;
                for (const v of bucket) {
                    const ex = positions[v * 3] - x, ey = positions[v * 3 + 1] - y, ez = positions[v * 3 + 2] - z;
                    const d = ex * ex + ey * ey + ez * ez;
                    if (d < bestD) { bestD = d; best = v; }
                }
            }
            if (best >= 0 && splatAllowed(s, masks[best])) owner[si] = best;
        });
        return owner;
    }

    /** Per-vertex lists of owned splat indices (CSR layout). */
    private static ownedLists(owner: Int32Array, nv: number): { start: Int32Array; items: Int32Array } {
        const start = new Int32Array(nv + 1);
        for (const o of owner) if (o >= 0) start[o + 1]++;
        for (let i = 0; i < nv; i++) start[i + 1] += start[i];
        const fill = start.slice(0, nv);
        const items = new Int32Array(start[nv]);
        owner.forEach((o, si) => { if (o >= 0) items[fill[o]++] = si; });
        return { start, items };
    }

    /**
     * Signed distance along each vertex normal to the outer opaque splat layer, from the splats owned by the
     * vertex and its 1-ring. The 85th percentile tracks the outermost layer rather than interior splats.
     */
    private static shellOffsets(
        positions: Float32Array, normals: Float32Array, splats: SurfaceSplat[],
        owned: { start: Int32Array; items: Int32Array }, adj: number[][], minT: number, maxT: number
    ): Float32Array {
        const nv = positions.length / 3;
        const offsets = new Float32Array(nv);
        const ts: number[] = [];
        for (let i = 0; i < nv; i++) {
            const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
            const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
            ts.length = 0;
            for (const v of [i, ...adj[i]]) {
                for (let k = owned.start[v]; k < owned.start[v + 1]; k++) {
                    const sp = splats[owned.items[k]].position;
                    const t = (sp[0] - px) * nx + (sp[1] - py) * ny + (sp[2] - pz) * nz;
                    if (t >= minT && t <= maxT) ts.push(t);
                }
            }
            if (ts.length < 3) { offsets[i] = NaN; continue; }
            ts.sort((a, b) => a - b);
            offsets[i] = ts[Math.min(ts.length - 1, Math.floor(ts.length * 0.85))];
        }
        return offsets;
    }

    /** Per-channel median over each vertex's 1-ring, removing isolated off-color specks. */
    private static medianFilter(colors: Float32Array, adj: number[][]): Float32Array {
        const out = new Float32Array(colors.length);
        const vals: number[] = [];
        for (let i = 0; i < adj.length; i++) {
            for (let c = 0; c < 3; c++) {
                vals.length = 0;
                vals.push(colors[i * 3 + c]);
                for (const j of adj[i]) vals.push(colors[j * 3 + c]);
                vals.sort((a, b) => a - b);
                out[i * 3 + c] = vals[vals.length >> 1];
            }
        }
        return out;
    }

    /**
     * Weighted geometric median with inlier rejection: selects the consensus color among nearby splats
     * and discards rogue floaters (e.g. bright cyan/red speckles on a black suit, or orange strap on ear).
     */
    private static robustConsensusColor(candR: number[], candG: number[], candB: number[], candW: number[]): [number, number, number] {
        const m = candR.length;
        if (m === 0) return [0.5, 0.5, 0.5];
        if (m <= 2) {
            let r = 0, g = 0, b = 0, ws = 0;
            for (let k = 0; k < m; k++) {
                const w = candW[k];
                r += w * candR[k]; g += w * candG[k]; b += w * candB[k]; ws += w;
            }
            return ws > 0 ? [r / ws, g / ws, b / ws] : [candR[0], candG[0], candB[0]];
        }
        let bestIdx = 0, bestCost = Infinity;
        for (let j = 0; j < m; j++) {
            let cost = 0;
            const rj = candR[j], gj = candG[j], bj = candB[j];
            for (let k = 0; k < m; k++) {
                const dr = rj - candR[k], dg = gj - candG[k], db = bj - candB[k];
                cost += candW[k] * Math.hypot(dr, dg, db);
            }
            if (cost < bestCost) { bestCost = cost; bestIdx = j; }
        }
        const medR = candR[bestIdx], medG = candG[bestIdx], medB = candB[bestIdx];
        const radiusSq = 0.22 * 0.22;
        let r = 0, g = 0, b = 0, ws = 0;
        for (let k = 0; k < m; k++) {
            const dr = medR - candR[k], dg = medG - candG[k], db = medB - candB[k];
            if (dr * dr + dg * dg + db * db <= radiusSq) {
                const w = candW[k];
                r += w * candR[k]; g += w * candG[k]; b += w * candB[k]; ws += w;
            }
        }
        return ws > 0 ? [r / ws, g / ws, b / ws] : [medR, medG, medB];
    }

    private static fillMissing(values: Float32Array, stride: number, valid: Uint8Array, adj: number[][], fallback: number[]): void {
        const n = valid.length;
        for (let pass = 0; pass < 64; pass++) {
            let changed = false;
            for (let i = 0; i < n; i++) {
                if (valid[i]) continue;
                const acc = new Array(stride).fill(0);
                let c = 0;
                for (const j of adj[i]) {
                    if (!valid[j]) continue;
                    for (let k = 0; k < stride; k++) acc[k] += values[j * stride + k];
                    c++;
                }
                if (c > 0) {
                    for (let k = 0; k < stride; k++) values[i * stride + k] = acc[k] / c;
                    valid[i] = 2;
                    changed = true;
                }
            }
            for (let i = 0; i < n; i++) if (valid[i] === 2) valid[i] = 1;
            if (!changed) break;
        }
        for (let i = 0; i < n; i++) if (!valid[i]) for (let k = 0; k < stride; k++) values[i * stride + k] = fallback[k];
    }

    /** Displaces the mesh onto the splat shell and bakes per-vertex color from the splats at that shell. */
    fitToSplats(mesh: SurfaceMesh, splats: SurfaceSplat[], options: SurfaceFitOptions = {}): SurfaceMesh {
        const maxOffset = options.maxOffset ?? 0.08;
        const opaque = splats.filter(s => s.opacity >= (options.minOpacity ?? 0.25));
        const nv = mesh.positions.length / 3;
        const adj = PerformerSurfaceMeshService.neighbors(nv, mesh.indices);
        const normals0 = PerformerSurfaceMeshService.computeNormals(mesh.positions, mesh.indices);

        const reach = Math.max(maxOffset, 0.02);
        const owner0 = PerformerSurfaceMeshService.assignSplats(mesh, mesh.positions, opaque, reach);
        const raw = PerformerSurfaceMeshService.shellOffsets(
            mesh.positions, normals0, opaque, PerformerSurfaceMeshService.ownedLists(owner0, nv), adj, -0.02, maxOffset);
        const valid = new Uint8Array(nv).map((_, i) => (Number.isNaN(raw[i]) ? 0 : 1));
        PerformerSurfaceMeshService.fillMissing(raw, 1, valid, adj, [0]);
        const offsets = PerformerSurfaceMeshService.smooth(raw, adj, 4);

        const positions = new Float32Array(mesh.positions);
        const caps = options.boneMaxOffset ?? DEFAULT_BONE_MAX_OFFSET;
        for (let i = 0; i < nv; i++) {
            let cap = 0;
            for (let k = 0; k < 4; k++) {
                const b = mesh.skinIndices[i * 4 + k];
                cap += mesh.skinWeights[i * 4 + k] * Math.min(maxOffset, caps[b] ?? maxOffset);
            }
            const minOffset = -Math.min(0.01, cap);
            const o = Math.max(minOffset, Math.min(cap, offsets[i]));
            for (let k = 0; k < 3; k++) positions[i * 3 + k] += normals0[i * 3 + k] * o;
        }
        const normals = PerformerSurfaceMeshService.computeNormals(positions, mesh.indices);

        let edgeSum = 0;
        for (let f = 0; f < mesh.indices.length; f += 3) {
            const a = mesh.indices[f] * 3, b = mesh.indices[f + 1] * 3;
            edgeSum += Math.hypot(positions[a] - positions[b], positions[a + 1] - positions[b + 1], positions[a + 2] - positions[b + 2]);
        }
        const sigma = Math.max(0.004, edgeSum / Math.max(1, mesh.indices.length / 3));
        const owned = PerformerSurfaceMeshService.ownedLists(
            PerformerSurfaceMeshService.assignSplats(mesh, positions, opaque, Math.max(0.02, 4 * sigma)), nv);
        const colors = new Float32Array(nv * 3);
        const colored = new Uint8Array(nv);
        const linear = options.linearizeColors !== false;
        const toOut = (c: number) => (linear ? srgbToLinear(Math.min(1, Math.max(0, c))) : c);

        if (options.heroImageRgb && mesh.camPositions && options.K) {
            const heroRgb = options.heroImageRgb;
            const width = options.heroImageWidth || 1080;
            const height = options.heroImageHeight || 1920;
            const Vc = mesh.camPositions;
            const Nc = PerformerSurfaceMeshService.computeNormals(Vc, mesh.indices);
            const [[fx, , cx], [, fy, cy]] = options.K;

            // Rasterize coarse depth buffer (downsampled by D=2)
            const D = 2;
            const dw = Math.ceil(width / D), dh = Math.ceil(height / D);
            const depth = new Float32Array(dw * dh).fill(Infinity);
            const pv: Array<[number, number, number] | null> = new Array(nv);
            for (let i = 0; i < nv; i++) {
                const z = Vc[i * 3 + 2];
                if (z > 0.05) {
                    pv[i] = [fx * Vc[i * 3] / z + cx, fy * Vc[i * 3 + 1] / z + cy, z];
                } else {
                    pv[i] = null;
                }
            }
            for (let f = 0; f < mesh.indices.length; f += 3) {
                const a = mesh.indices[f], b = mesh.indices[f + 1], c = mesh.indices[f + 2];
                const A = pv[a], B = pv[b], C = pv[c];
                if (!A || !B || !C) continue;
                const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]) / D));
                const x1 = Math.min(dw - 1, Math.ceil(Math.max(A[0], B[0], C[0]) / D));
                const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]) / D));
                const y1 = Math.min(dh - 1, Math.ceil(Math.max(A[1], B[1], C[1]) / D));
                const det = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
                if (Math.abs(det) < 1e-9) continue;
                for (let y = y0; y <= y1; y++) {
                    for (let x = x0; x <= x1; x++) {
                        const px = (x + 0.5) * D, py = (y + 0.5) * D;
                        const l0 = ((B[1] - C[1]) * (px - C[0]) + (C[0] - B[0]) * (py - C[1])) / det;
                        const l1 = ((C[1] - A[1]) * (px - C[0]) + (A[0] - C[0]) * (py - C[1])) / det;
                        const l2 = 1 - l0 - l1;
                        if (l0 < 0 || l1 < 0 || l2 < 0) continue;
                        const z = l0 * A[2] + l1 * B[2] + l2 * C[2];
                        const idx = y * dw + x;
                        if (z < depth[idx]) depth[idx] = z;
                    }
                }
            }

            for (let i = 0; i < nv; i++) {
                const z = Vc[i * 3 + 2];
                if (z <= 0.05) continue;
                const nx = Nc[i * 3], ny = Nc[i * 3 + 1], nz = Nc[i * 3 + 2];
                const lenP = Math.hypot(Vc[i * 3], Vc[i * 3 + 1], z) || 1;
                const facing = (nx * Vc[i * 3] + ny * Vc[i * 3 + 1] + nz * z) / lenP;
                const u = fx * Vc[i * 3] / z + cx;
                const v = fy * Vc[i * 3 + 1] / z + cy;
                const inBounds = u >= 0 && v >= 0 && u < width - 1 && v < height - 1;
                const isFacing = facing < -0.05;
                const unoccluded = inBounds && z <= depth[Math.floor(v / D) * dw + Math.floor(u / D)] + 0.035;

                if (isFacing && unoccluded) {
                    const x0 = Math.floor(u), y0 = Math.floor(v);
                    const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
                    const fx_t = u - x0, fy_t = v - y0;
                    for (let ch = 0; ch < 3; ch++) {
                        const c00 = heroRgb[(y0 * width + x0) * 3 + ch] / 255.0;
                        const c10 = heroRgb[(y0 * width + x1) * 3 + ch] / 255.0;
                        const c01 = heroRgb[(y1 * width + x0) * 3 + ch] / 255.0;
                        const c11 = heroRgb[(y1 * width + x1) * 3 + ch] / 255.0;
                        const val = (1 - fx_t) * (1 - fy_t) * c00 + fx_t * (1 - fy_t) * c10 + (1 - fx_t) * fy_t * c01 + fx_t * fy_t * c11;
                        colors[i * 3 + ch] = linear ? srgbToLinear(val) : val;
                    }
                    colored[i] = 1;
                }
            }

            // Fill back-facing / occluded vertices with grounded colors
            for (let i = 0; i < nv; i++) {
                if (colored[i]) continue;
                const bone = mesh.skinIndices[i * 4];
                if (bone === 15) {
                    // Hair on back of head: dark espresso/black
                    colors[i * 3] = linear ? srgbToLinear(0.06) : 0.06;
                    colors[i * 3 + 1] = linear ? srgbToLinear(0.05) : 0.05;
                    colors[i * 3 + 2] = linear ? srgbToLinear(0.05) : 0.05;
                    colored[i] = 1;
                } else if (bone === 20 || bone === 21) {
                    // Back of hands: natural skin tone
                    colors[i * 3] = linear ? srgbToLinear(0.50) : 0.50;
                    colors[i * 3 + 1] = linear ? srgbToLinear(0.37) : 0.37;
                    colors[i * 3 + 2] = linear ? srgbToLinear(0.31) : 0.31;
                    colored[i] = 1;
                } else {
                    // Black suit fabric (jacket, trousers, boots)
                    colors[i * 3] = linear ? srgbToLinear(0.025) : 0.025;
                    colors[i * 3 + 1] = linear ? srgbToLinear(0.025) : 0.025;
                    colors[i * 3 + 2] = linear ? srgbToLinear(0.025) : 0.025;
                    colored[i] = 1;
                }
            }
        } else {
            const candR: number[] = [], candG: number[] = [], candB: number[] = [], candW: number[] = [];
            for (let i = 0; i < nv; i++) {
                const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
                const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
                candR.length = 0; candG.length = 0; candB.length = 0; candW.length = 0;
                for (const v of [i, ...adj[i]]) {
                    for (let k = owned.start[v]; k < owned.start[v + 1]; k++) {
                        const s = opaque[owned.items[k]];
                        const dx = s.position[0] - px, dy = s.position[1] - py, dz = s.position[2] - pz;
                        // Splats under the visible surface are occluded in the splat render; keep them out of the color.
                        if (dx * nx + dy * ny + dz * nz < -0.006) continue;
                        const d2 = dx * dx + dy * dy + dz * dz;
                        const w = s.opacity * s.opacity * Math.exp(-d2 / (2 * sigma * sigma));
                        candR.push(toOut(s.colorRgb[0]));
                        candG.push(toOut(s.colorRgb[1]));
                        candB.push(toOut(s.colorRgb[2]));
                        candW.push(w);
                    }
                }
                if (candR.length > 0) {
                    const [r, g, b] = PerformerSurfaceMeshService.robustConsensusColor(candR, candG, candB, candW);
                    colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
                    colored[i] = 1;
                }
            }
        }
        const mean = [0, 0, 0];
        let nc = 0;
        for (let i = 0; i < nv; i++) if (colored[i]) { for (let k = 0; k < 3; k++) mean[k] += colors[i * 3 + k]; nc++; }
        PerformerSurfaceMeshService.fillMissing(colors, 3, colored, adj, nc ? mean.map(m => m / nc) : [0.5, 0.5, 0.5]);

        return { ...mesh, positions, normals, colors: PerformerSurfaceMeshService.medianFilter(colors, adj) };
    }

    build(body: GvhmrBody, splats: SurfaceSplat[], options: SurfaceBuildOptions = {}): SurfaceMesh {
        const base = PerformerSurfaceMeshService.fromBody(body);
        const coarseFit = this.fitToSplats(base, splats, { ...options, maxOffset: options.maxOffset ?? 0.08 });
        const sub = PerformerSurfaceMeshService.subdivideMidpoint(
            {
                positions: coarseFit.positions,
                indices: base.indices,
                skinIndices: base.skinIndices,
                skinWeights: base.skinWeights,
                camPositions: base.camPositions
            },
            options.subdivisionLevels ?? 2
        );
        return this.fitToSplats(sub, splats, { ...options, maxOffset: 0.025 });
    }

    /** Rebuilds public/models/humanoid_<id>.glb from models/performer_4dgs/demos/<id>/{gvhmr_body.json,human_4dgs.ply}. */
    buildForDemo(demoDir: string, outGlbPath: string, options: SurfaceBuildOptions = {}): { vertices: number; triangles: number } {
        const body: GvhmrBody = JSON.parse(fs.readFileSync(path.join(demoDir, 'gvhmr_body.json'), 'utf-8'));
        const { gaussians } = decodeGaussianPly(fs.readFileSync(path.join(demoDir, 'human_4dgs.ply'), 'utf-8'));

        let buildOptions: SurfaceBuildOptions = { ...options };
        const heroCandidates = ['hero_frame.png', 'canonical_frame.jpg', 'hero_frame.jpg'];
        let heroImgPath: string | null = null;
        for (const c of heroCandidates) {
            const p = path.join(demoDir, c);
            if (fs.existsSync(p)) { heroImgPath = p; break; }
        }
        if (heroImgPath && body.hero_incam_vertices && body.K) {
            const gvhmr = new GvhmrBodyService();
            const w = body.width || 1080, h = body.height || 1920;
            try {
                const heroBuf = gvhmr.readRgb(heroImgPath, w, h);
                buildOptions = {
                    ...buildOptions,
                    heroImageRgb: heroBuf,
                    heroImageWidth: w,
                    heroImageHeight: h,
                    K: body.K
                };
            } catch (err) {
                console.warn('[PerformerSurfaceMeshService] could not read hero frame for texture projection:', err);
            }
        }

        const mesh = this.build(body, gaussians.map(g => ({
            position: g.position,
            colorRgb: g.colorRgb,
            opacity: g.opacity,
            bone: g.boneIndices && g.boneWeights ? g.boneIndices[g.boneWeights.indexOf(Math.max(...g.boneWeights))] : undefined
        })), buildOptions);
        fs.mkdirSync(path.dirname(outGlbPath), { recursive: true });
        fs.writeFileSync(outGlbPath, PerformerSurfaceMeshService.encodeGlb(mesh));
        const staleSkinning = outGlbPath.replace(/\.glb$/, '_skinning.json');
        if (fs.existsSync(staleSkinning)) fs.unlinkSync(staleSkinning);
        return { vertices: mesh.positions.length / 3, triangles: mesh.indices.length / 3 };
    }

    static encodeGlb(mesh: SurfaceMesh, options: EncodeGlbOptions = {}): Buffer {
        const normals = mesh.normals || PerformerSurfaceMeshService.computeNormals(mesh.positions, mesh.indices);
        const nv = mesh.positions.length / 3;
        const colors = mesh.colors || new Float32Array(nv * 3).fill(0.5);
        const chunks: Buffer[] = [];
        const views: any[] = [];
        let offset = 0;
        const addView = (data: ArrayBufferView, target: number) => {
            const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
            const pad = (4 - (buf.length % 4)) % 4;
            views.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target });
            chunks.push(buf, Buffer.alloc(pad));
            offset += buf.length + pad;
            return views.length - 1;
        };
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], mesh.positions[i * 3 + k]);
            max[k] = Math.max(max[k], mesh.positions[i * 3 + k]);
        }
        const ARRAY = 34962, ELEMENTS = 34963;
        const accessors: any[] = [
            { bufferView: addView(mesh.positions, ARRAY), componentType: 5126, count: nv, type: 'VEC3', min, max },
            { bufferView: addView(normals, ARRAY), componentType: 5126, count: nv, type: 'VEC3' },
            { bufferView: addView(colors, ARRAY), componentType: 5126, count: nv, type: 'VEC3' },
            { bufferView: addView(mesh.skinIndices, ARRAY), componentType: 5121, count: nv, type: 'VEC4' },
            { bufferView: addView(mesh.skinWeights, ARRAY), componentType: 5126, count: nv, type: 'VEC4' },
            { bufferView: addView(mesh.indices, ELEMENTS), componentType: 5125, count: mesh.indices.length, type: 'SCALAR' }
        ];

        const attributes: Record<string, number> = {
            POSITION: 0,
            NORMAL: 1,
            COLOR_0: 2,
            JOINTS_0: 3,
            WEIGHTS_0: 4
        };

        if (mesh.uvs && options.includeUvs !== false) {
            const uvView = addView(mesh.uvs, ARRAY);
            accessors.push({ bufferView: uvView, componentType: 5126, count: nv, type: 'VEC2' });
            attributes.TEXCOORD_0 = accessors.length - 1;
        }

        const includeSkin = options.includeSkin !== false;
        let skins: any[] | undefined = undefined;
        let nodes: any[] = [];
        let sceneNodes: number[] = [0];

        if (includeSkin) {
            const canonicalJoints = options.canonicalJoints || DEFAULT_CANONICAL_JOINTS;
            const jointParents = options.jointParents || SBHUMAN22_PARENTS;
            const jointNames = options.jointNames || CANONICAL_22_JOINT_NAMES;
            const K = canonicalJoints.length;

            const invBind = new Float32Array(K * 16);
            for (let j = 0; j < K; j++) {
                const c = canonicalJoints[j];
                const off = j * 16;
                invBind[off + 0] = 1; invBind[off + 1] = 0; invBind[off + 2] = 0; invBind[off + 3] = 0;
                invBind[off + 4] = 0; invBind[off + 5] = 1; invBind[off + 6] = 0; invBind[off + 7] = 0;
                invBind[off + 8] = 0; invBind[off + 9] = 0; invBind[off + 10] = 1; invBind[off + 11] = 0;
                invBind[off + 12] = -c[0]; invBind[off + 13] = -c[1]; invBind[off + 14] = -c[2]; invBind[off + 15] = 1;
            }
            const invBindView = addView(invBind, 0);
            accessors.push({ bufferView: invBindView, componentType: 5126, count: K, type: 'MAT4' });
            const invBindAccessor = accessors.length - 1;

            nodes.push({ mesh: 0, skin: 0, name: 'PerformerSurface' });

            const rootBones: number[] = [];
            for (let j = 0; j < K; j++) {
                const parent = jointParents[j];
                const c = canonicalJoints[j];
                const pC = parent >= 0 ? canonicalJoints[parent] : null;
                const localT = pC ? [c[0] - pC[0], c[1] - pC[1], c[2] - pC[2]] : [c[0], c[1], c[2]];

                const children: number[] = [];
                for (let cIdx = 0; cIdx < K; cIdx++) {
                    if (jointParents[cIdx] === j) children.push(cIdx + 1);
                }

                const boneNode: any = {
                    name: jointNames[j] || `joint_${j}`,
                    translation: localT
                };
                if (children.length > 0) boneNode.children = children;
                nodes.push(boneNode);

                if (parent < 0) {
                    rootBones.push(j + 1);
                }
            }

            sceneNodes = [0, ...rootBones];
            skins = [{
                name: 'PerformerSkin',
                inverseBindMatrices: invBindAccessor,
                joints: Array.from({ length: K }, (_, i) => i + 1),
                skeleton: rootBones[0] || 1
            }];
        } else {
            nodes = [{ mesh: 0, name: 'PerformerSurface' }];
            sceneNodes = [0];
        }

        const mat = options.material || {};
        const materials = [{
            name: mat.name || 'PerformerSurfacePBR',
            pbrMetallicRoughness: {
                baseColorFactor: mat.baseColorFactor || [1, 1, 1, 1],
                metallicFactor: mat.metallicFactor !== undefined ? mat.metallicFactor : 0.05,
                roughnessFactor: mat.roughnessFactor !== undefined ? mat.roughnessFactor : 0.6
            },
            doubleSided: mat.doubleSided !== undefined ? mat.doubleSided : true
        }];

        const bin = Buffer.concat(chunks);
        const gltf: any = {
            asset: { version: '2.0', generator: 'Scratchbox PerformerSurfaceMeshService' },
            scene: 0,
            scenes: [{ nodes: sceneNodes }],
            nodes,
            meshes: [{
                name: 'PerformerSurface',
                primitives: [{
                    attributes,
                    indices: 5,
                    material: 0
                }]
            }],
            materials,
            accessors,
            bufferViews: views,
            buffers: [{ byteLength: bin.length }]
        };
        if (skins) gltf.skins = skins;

        let json = Buffer.from(JSON.stringify(gltf), 'utf-8');
        json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
        const header = Buffer.alloc(12);
        header.writeUInt32LE(0x46546c67, 0);
        header.writeUInt32LE(2, 4);
        header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
        const jsonHead = Buffer.alloc(8);
        jsonHead.writeUInt32LE(json.length, 0);
        jsonHead.writeUInt32LE(0x4e4f534a, 4);
        const binHead = Buffer.alloc(8);
        binHead.writeUInt32LE(bin.length, 0);
        binHead.writeUInt32LE(0x004e4942, 4);
        return Buffer.concat([header, jsonHead, json, binHead, bin]);
    }
}

/** Reads back a GLB written by PerformerSurfaceMeshService.encodeGlb. */
export function decodeSurfaceGlb(glb: Buffer): SurfaceMesh {
    const jsonLen = glb.readUInt32LE(12);
    const gltf = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf-8'));
    const binStart = 20 + jsonLen + 8;
    const read = (accessorIndex: number) => {
        const acc = gltf.accessors[accessorIndex];
        const view = gltf.bufferViews[acc.bufferView];
        const bytes = glb.subarray(binStart + (view.byteOffset || 0), binStart + (view.byteOffset || 0) + view.byteLength);
        const copy = new Uint8Array(bytes).buffer;
        switch (acc.componentType) {
            case 5126: return new Float32Array(copy);
            case 5125: return new Uint32Array(copy);
            case 5123: return new Uint16Array(copy);
            case 5121: return new Uint8Array(copy);
            default: throw new Error(`unsupported componentType ${acc.componentType}`);
        }
    };
    const prim = gltf.meshes[0].primitives[0];
    return {
        positions: read(prim.attributes.POSITION) as Float32Array,
        normals: prim.attributes.NORMAL !== undefined ? read(prim.attributes.NORMAL) as Float32Array : undefined,
        colors: prim.attributes.COLOR_0 !== undefined ? read(prim.attributes.COLOR_0) as Float32Array : undefined,
        uvs: prim.attributes.TEXCOORD_0 !== undefined ? read(prim.attributes.TEXCOORD_0) as Float32Array : undefined,
        skinIndices: read(prim.attributes.JOINTS_0) as Uint8Array,
        skinWeights: read(prim.attributes.WEIGHTS_0) as Float32Array,
        indices: read(prim.indices) as Uint32Array
    };
}
