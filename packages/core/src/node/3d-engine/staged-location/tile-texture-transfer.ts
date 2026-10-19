/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Tier 2 of the staged-location texture pass (docs/processes/staged_location_texture_pass_design.md, section 5):
 * transfer of the Google tile photogrammetric texture (the getGoogle3DTilesFullTexture GLB, leaf LOD, ~0.154 m texel)
 * onto a layer's UV atlas.
 *
 *   tile GLB -> TileTextureSurface: triangles in the tile frame (node transforms applied), per-primitive TEXCOORD_0
 *               and baseColor image decoded in memory (PNG in-process, JPEG with jpeg-js; no temp files), a BVH.
 *   sample(P, n, dMax): nearest tile surface point to P among triangles whose geometric normal agrees with n
 *               (angle <= maxNormalAngleDeg, so back faces and the far skin of a thin wall never answer), within
 *               dMax; bilinear in the tile's own UV, in linear RGB; de-lit with the shared photogrammetric de-light
 *               (common/spatial/photogrammetric-delight.ts, the browser shader's numbers).
 *   transferTilePhoto: per atlas texel (covered, not gutter) one sample; weight capped at TILE_CONFIDENCE_CAP (0.5),
 *               scaled by normal agreement and distance; rung 2 ('tile photo transfer'); provenance
 *               'tile-photo-transfer', label 'photo-inferred'.
 *
 * Fusion with tier 1 (`existing`), the StreetViewTextureFusion rule at texel level: the tile never replaces a
 * multi-view texel (rung 0), never one whose weight is at least the tile's, and never one that is locally sharper
 * than the tile would be (Sobel energy of the 3x3 luma neighbourhood): the tile never softens a sharper texel. It
 * fills uncovered texels and lower-weight, softer single-view texels. The output holds only the texels the tile
 * filled (alpha 255, confidence covered); mergeBakedPlanes composes it over `existing`.
 *
 * Texels nothing covers stay uncovered for the next rung, with a degradation entry (tile_surface_out_of_range).
 */

import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import {
    packConfidenceTexel, unpackConfidenceTexel,
    type BakedTexturePlanes, type ConfidencePlane, type TexelProvenance, type TexturePassDegradation,
    type TileTransferInput, type TransferTilePhoto
} from '../../../common/spatial/texture-pass-contracts';
import {
    delightLinearPlane, delightLinearRgb, linearToSrgb255, PHOTOGRAMMETRIC_DELIGHT, SRGB8_TO_LINEAR, TEXTURE_LIFT_CAP,
    type DelightPlaneReport, type PhotogrammetricDelightParams
} from '../../../common/spatial/photogrammetric-delight';
import { decodePng } from '../../texture-processing';
import { decodeJpegInMemory } from './photo-palette';

/** The tile's confidence relative to tier 1 (design section 5). */
export const TILE_CONFIDENCE_CAP = 0.5;
/** Rung of a transferred texel in TEXTURE_LADDER_RUNGS. */
export const TILE_TRANSFER_RUNG = 2;
/** Rung below the tile: measured palette colour. */
const NEXT_RUNG = 3;

// =============================================================================
// Images (in memory)
// =============================================================================

export interface RgbaImage8 { width: number; height: number; rgba: Uint8Array }

/** Decodes PNG or JPEG bytes in memory (no temp files, no subprocess). Throws on anything else. */
export function decodeImageInMemory(bytes: Uint8Array): RgbaImage8 {
    if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
        const d = decodePng(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        return { width: d.width, height: d.height, rgba: new Uint8Array(d.rgba.buffer, d.rgba.byteOffset, d.rgba.byteLength) };
    }
    if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
        const d = decodeJpegInMemory(bytes);
        return { width: d.width, height: d.height, rgba: d.data };
    }
    throw new Error('tile texture is neither PNG nor JPEG; it cannot be decoded in memory');
}

// =============================================================================
// Tile GLB -> textured triangles
// =============================================================================

interface TileTexture { width: number; height: number; linear: Float32Array; repeatS: boolean; repeatT: boolean }

/** Flat triangle soup of the tile in the tile frame. */
export interface TileTriangles {
    /** 9 floats per triangle. */
    positions: Float32Array;
    /** 6 floats per triangle. */
    uvs: Float32Array;
    /** Unit geometric normal (winding), 3 floats per triangle. */
    normals: Float32Array;
    /** Index into `textures`, -1 for a primitive with no texture (uses `flatLinear`). */
    texture: Int32Array;
    /** Linear RGB baseColorFactor of untextured primitives, 3 floats per triangle. */
    flatLinear: Float32Array;
    textures: TileTexture[];
}

const COMPONENT_SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNT: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(json: any, bin: Uint8Array, index: number): Float64Array {
    const acc = json.accessors[index];
    const n = TYPE_COUNT[acc.type], count = acc.count;
    const out = new Float64Array(count * n);
    if (acc.bufferView === undefined) return out;
    const view = json.bufferViews[acc.bufferView];
    const size = COMPONENT_SIZE[acc.componentType];
    if (!size) throw new Error(`tile GLB accessor ${index}: unsupported component type ${acc.componentType}`);
    const stride = view.byteStride || size * n;
    const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const norm = !!acc.normalized;
    for (let i = 0; i < count; i++) {
        for (let k = 0; k < n; k++) {
            const o = base + i * stride + k * size;
            let v: number;
            switch (acc.componentType) {
                case 5126: v = dv.getFloat32(o, true); break;
                case 5125: v = dv.getUint32(o, true); break;
                case 5123: v = dv.getUint16(o, true); if (norm) v /= 65535; break;
                case 5122: v = dv.getInt16(o, true); if (norm) v = Math.max(v / 32767, -1); break;
                case 5121: v = dv.getUint8(o); if (norm) v /= 255; break;
                default: v = dv.getInt8(o); if (norm) v = Math.max(v / 127, -1);
            }
            out[i * n + k] = v;
        }
    }
    return out;
}

type Mat4 = number[];
const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a: Mat4, b: Mat4): Mat4 {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return o;
}
function nodeMatrix(node: any): Mat4 {
    if (Array.isArray(node.matrix)) return node.matrix.slice();
    const [tx, ty, tz] = node.translation || [0, 0, 0];
    const [qx, qy, qz, qw] = node.rotation || [0, 0, 0, 1];
    const [sx, sy, sz] = node.scale || [1, 1, 1];
    return [
        (1 - 2 * (qy * qy + qz * qz)) * sx, 2 * (qx * qy + qz * qw) * sx, 2 * (qx * qz - qy * qw) * sx, 0,
        2 * (qx * qy - qz * qw) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy, 2 * (qy * qz + qx * qw) * sy, 0,
        2 * (qx * qz + qy * qw) * sz, 2 * (qy * qz - qx * qw) * sz, (1 - 2 * (qx * qx + qy * qy)) * sz, 0,
        tx, ty, tz, 1
    ];
}

/** Parses a textured tile GLB into world-frame triangles with UVs and decoded baseColor textures (linear RGB). */
export function readTileTriangles(glb: Uint8Array): TileTriangles {
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    if (glb.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error('tile is not a binary glTF (missing glTF magic)');
    let json: any, bin: Uint8Array = new Uint8Array(0);
    for (let o = 12; o + 8 <= glb.byteLength;) {
        const len = dv.getUint32(o, true), type = dv.getUint32(o + 4, true);
        const data = glb.subarray(o + 8, o + 8 + len);
        if (type === 0x4e4f534a) json = JSON.parse(Buffer.from(data).toString('utf8'));
        else if (type === 0x004e4942) bin = data;
        o += 8 + len;
    }
    if (!json) throw new Error('tile GLB has no JSON chunk');

    const textures: TileTexture[] = [];
    const textureOfGltfTexture = new Map<number, number>();
    const textureFor = (texIndex: number): number => {
        const known = textureOfGltfTexture.get(texIndex);
        if (known !== undefined) return known;
        const tex = json.textures?.[texIndex];
        const image = tex !== undefined ? json.images?.[tex.source] : undefined;
        if (!image || image.bufferView === undefined) throw new Error(`tile texture ${texIndex} has no embedded image`);
        const view = json.bufferViews[image.bufferView];
        const bytes = bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
        const img = decodeImageInMemory(bytes);
        const linear = new Float32Array(img.width * img.height * 3);
        for (let i = 0; i < img.width * img.height; i++) {
            linear[i * 3] = SRGB8_TO_LINEAR[img.rgba[i * 4]];
            linear[i * 3 + 1] = SRGB8_TO_LINEAR[img.rgba[i * 4 + 1]];
            linear[i * 3 + 2] = SRGB8_TO_LINEAR[img.rgba[i * 4 + 2]];
        }
        const sampler = tex.sampler !== undefined ? json.samplers?.[tex.sampler] : undefined;
        textures.push({ width: img.width, height: img.height, linear, repeatS: (sampler?.wrapS ?? 10497) !== 33071, repeatT: (sampler?.wrapT ?? 10497) !== 33071 });
        textureOfGltfTexture.set(texIndex, textures.length - 1);
        return textures.length - 1;
    };

    const pos: number[] = [], uv: number[] = [], nrm: number[] = [], texIdx: number[] = [], flat: number[] = [];
    const visit = (nodeIndex: number, parent: Mat4): void => {
        const node = json.nodes[nodeIndex];
        const m = mul(parent, nodeMatrix(node));
        if (node.mesh !== undefined) {
            for (const prim of json.meshes[node.mesh].primitives) {
                if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
                const P = readAccessor(json, bin, prim.attributes.POSITION);
                const hasUv = prim.attributes.TEXCOORD_0 !== undefined;
                const T = hasUv ? readAccessor(json, bin, prim.attributes.TEXCOORD_0) : undefined;
                const nv = P.length / 3;
                const idx = prim.indices !== undefined ? readAccessor(json, bin, prim.indices) : Float64Array.from({ length: nv }, (_, i) => i);
                const mat = prim.material !== undefined ? json.materials?.[prim.material] : undefined;
                const pbr = mat?.pbrMetallicRoughness;
                const texInfo = pbr?.baseColorTexture;
                const ti = hasUv && texInfo && (texInfo.texCoord ?? 0) === 0 ? textureFor(texInfo.index) : -1;
                const f = pbr?.baseColorFactor || [1, 1, 1, 1];
                if (ti < 0 && !pbr?.baseColorFactor) continue; // no colour information: not a photo surface
                const W = new Float64Array(nv * 3);
                for (let i = 0; i < nv; i++) {
                    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
                    W[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
                    W[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
                    W[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
                }
                for (let t = 0; t + 2 < idx.length; t += 3) {
                    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
                    const ax = W[a * 3], ay = W[a * 3 + 1], az = W[a * 3 + 2];
                    const e1x = W[b * 3] - ax, e1y = W[b * 3 + 1] - ay, e1z = W[b * 3 + 2] - az;
                    const e2x = W[c * 3] - ax, e2y = W[c * 3 + 1] - ay, e2z = W[c * 3 + 2] - az;
                    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
                    const l = Math.hypot(nx, ny, nz);
                    if (!(l > 1e-12)) continue; // degenerate
                    nx /= l; ny /= l; nz /= l;
                    for (const v of [a, b, c]) pos.push(W[v * 3], W[v * 3 + 1], W[v * 3 + 2]);
                    if (T) for (const v of [a, b, c]) uv.push(T[v * 2], T[v * 2 + 1]);
                    else uv.push(0, 0, 0, 0, 0, 0);
                    nrm.push(nx, ny, nz);
                    texIdx.push(ti);
                    flat.push(f[0], f[1], f[2]);
                }
            }
        }
        for (const child of node.children || []) visit(child, m);
    };
    const scene = json.scenes?.[json.scene ?? 0];
    const roots: number[] = scene?.nodes ?? (json.nodes || []).map((_: unknown, i: number) => i);
    for (const r of roots) visit(r, IDENTITY);
    return {
        positions: Float32Array.from(pos), uvs: Float32Array.from(uv), normals: Float32Array.from(nrm),
        texture: Int32Array.from(texIdx), flatLinear: Float32Array.from(flat), textures
    };
}

// =============================================================================
// BVH and nearest-surface sampling
// =============================================================================

/** Closest point on triangle (a, b, c) to p (Ericson, Real-Time Collision Detection 5.1.5): barycentrics (v, w) of b and c. */
function closestOnTriangle(p: Float32Array | number[], tri: Float32Array, t: number, out: Float64Array): void {
    const o = t * 9;
    const ax = tri[o], ay = tri[o + 1], az = tri[o + 2];
    const abx = tri[o + 3] - ax, aby = tri[o + 4] - ay, abz = tri[o + 5] - az;
    const acx = tri[o + 6] - ax, acy = tri[o + 7] - ay, acz = tri[o + 8] - az;
    const apx = p[0] - ax, apy = p[1] - ay, apz = p[2] - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    let v: number, w: number;
    if (d1 <= 0 && d2 <= 0) { v = 0; w = 0; } else {
        const bpx = p[0] - tri[o + 3], bpy = p[1] - tri[o + 4], bpz = p[2] - tri[o + 5];
        const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
        const cpx = p[0] - tri[o + 6], cpy = p[1] - tri[o + 7], cpz = p[2] - tri[o + 8];
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
        if (d3 >= 0 && d4 <= d3) { v = 1; w = 0; }
        else if (vc <= 0 && d1 >= 0 && d3 <= 0) { v = d1 / (d1 - d3); w = 0; }
        else if (d6 >= 0 && d5 <= d6) { v = 0; w = 1; }
        else if (vb <= 0 && d2 >= 0 && d6 <= 0) { v = 0; w = d2 / (d2 - d6); }
        else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); v = 1 - w; }
        else { const den = 1 / (va + vb + vc); v = vb * den; w = vc * den; }
    }
    out[0] = ax + abx * v + acx * w; out[1] = ay + aby * v + acy * w; out[2] = az + abz * v + acz * w;
    out[3] = v; out[4] = w;
}

/** The tile's nearest-surface hierarchy (typed arrays only, so it can be shared with a worker thread). */
export interface TileBvh { nodeMin: Float32Array; nodeMax: Float32Array; left: Int32Array; start: Int32Array; count: Int32Array; order: Int32Array; nodes: number }

function buildBvh(tri: Float32Array, n: number, leafSize = 8): TileBvh {
    const cent = new Float32Array(n * 3), tmin = new Float32Array(n * 3), tmax = new Float32Array(n * 3);
    for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) {
        const a = tri[t * 9 + k], b = tri[t * 9 + 3 + k], c = tri[t * 9 + 6 + k];
        tmin[t * 3 + k] = Math.min(a, b, c); tmax[t * 3 + k] = Math.max(a, b, c); cent[t * 3 + k] = (a + b + c) / 3;
    }
    const cap = 2 * n + 1;
    const nodeMin = new Float32Array(cap * 3), nodeMax = new Float32Array(cap * 3);
    const left = new Int32Array(cap).fill(-1), start = new Int32Array(cap), count = new Int32Array(cap);
    const order = Int32Array.from({ length: n }, (_, i) => i);
    let nodes = 0;
    const right: number[] = [];
    const buildWithRight = (s: number, e: number): number => {
        const id = nodes++;
        let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
        const cmn = [Infinity, Infinity, Infinity], cmx = [-Infinity, -Infinity, -Infinity];
        for (let i = s; i < e; i++) {
            const t = order[i];
            mnx = Math.min(mnx, tmin[t * 3]); mny = Math.min(mny, tmin[t * 3 + 1]); mnz = Math.min(mnz, tmin[t * 3 + 2]);
            mxx = Math.max(mxx, tmax[t * 3]); mxy = Math.max(mxy, tmax[t * 3 + 1]); mxz = Math.max(mxz, tmax[t * 3 + 2]);
            for (let k = 0; k < 3; k++) { cmn[k] = Math.min(cmn[k], cent[t * 3 + k]); cmx[k] = Math.max(cmx[k], cent[t * 3 + k]); }
        }
        nodeMin.set([mnx, mny, mnz], id * 3); nodeMax.set([mxx, mxy, mxz], id * 3);
        const ext = [cmx[0] - cmn[0], cmx[1] - cmn[1], cmx[2] - cmn[2]];
        if (e - s <= leafSize || Math.max(ext[0], ext[1], ext[2]) <= 0) { start[id] = s; count[id] = e - s; right[id] = -1; return id; }
        const axis = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
        const sub = Array.from(order.subarray(s, e)).sort((a, b) => cent[a * 3 + axis] - cent[b * 3 + axis] || a - b);
        order.set(sub, s);
        const mid = (s + e) >> 1;
        left[id] = buildWithRight(s, mid);
        right[id] = buildWithRight(mid, e);
        return id;
    };
    if (n > 0) buildWithRight(0, n);
    // Store the right child in `start` for interior nodes (count 0 marks interior).
    for (let id = 0; id < nodes; id++) if (left[id] >= 0) { start[id] = right[id]; count[id] = 0; }
    return { nodeMin, nodeMax, left, start, count, order, nodes };
}

function boxDistSq(b: TileBvh, id: number, p: Vec3): number {
    let d = 0;
    for (let k = 0; k < 3; k++) {
        const lo = b.nodeMin[id * 3 + k], hi = b.nodeMax[id * 3 + k];
        const v = p[k] < lo ? lo - p[k] : p[k] > hi ? p[k] - hi : 0;
        d += v * v;
    }
    return d;
}

export interface TileSurfaceOptions {
    /** De-light parameters; false keeps the photogrammetric colour as lit (tests only). Default: the shader's. */
    delight?: PhotogrammetricDelightParams | false;
    /** Largest angle between the query normal and a tile triangle's normal. Default 60 degrees. */
    maxNormalAngleDeg?: number;
    /**
     * Largest sideways (tangential) offset of the sampled point from the query, in metres, beyond `tangentSlope` times the
     * offset along the query normal. Default TILE_SAMPLE_MAX_TANGENT_M / TILE_SAMPLE_TANGENT_SLOPE; Infinity = nearest point.
     */
    maxTangentM?: number;
    tangentSlope?: number;
}

/**
 * A texel samples the tile surface in front of or behind it, not beside it. A fitted face that stands off the tile and
 * runs past the tile's edge has its nearest tile point on that edge for a whole band of texels: the edge's few texels are
 * stretched across the band (live, Washington Square Arch: the back attic's right half, 0.3-1.5 m off the tile, smeared
 * into horizontal streaks). Allowed sideways: one tile texel, plus a 0.3 slope of the normal offset (a tile face up to ~17
 * degrees from the texel's own plane at that offset).
 */
export const TILE_SAMPLE_MAX_TANGENT_M = 0.15;
export const TILE_SAMPLE_TANGENT_SLOPE = 0.3;

export interface TileSample {
    rgb: Vec3; distanceM: number; cosNormal: number;
    /** The colour before de-lighting, linear 0..1 (the transfer re-de-lights the plane with the lift cap). Absent when the surface does not de-light. */
    litLinear?: Vec3;
}

/** A textured tile ready for nearest-surface lookups; its `sample` is the contract's `tileSample`. */
export interface TileTextureSurface {
    triangleCount: number;
    textureCount: number;
    /** Median tile texel size in metres (edge length / texel span), for reporting. */
    texelSizeM: number;
    maxNormalAngleDeg: number;
    delight: PhotogrammetricDelightParams | false;
    sample(position: Vec3, normal: Vec3, maxDistanceM: number): TileSample | undefined;
}

function sampleTexture(tex: TileTexture, u: number, v: number, out: Float64Array): void {
    const wrap = (x: number, n: number, rep: boolean): number => (rep ? ((x % n) + n) % n : Math.min(n - 1, Math.max(0, x)));
    const fx = u * tex.width - 0.5, fy = v * tex.height - 0.5; // glTF UV: v down the image
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const xa = wrap(x0, tex.width, tex.repeatS), xb = wrap(x0 + 1, tex.width, tex.repeatS);
    const ya = wrap(y0, tex.height, tex.repeatT), yb = wrap(y0 + 1, tex.height, tex.repeatT);
    const L = tex.linear, W = tex.width;
    for (let k = 0; k < 3; k++) {
        const a = L[(ya * W + xa) * 3 + k], b = L[(ya * W + xb) * 3 + k], c = L[(yb * W + xa) * 3 + k], d = L[(yb * W + xb) * 3 + k];
        out[k] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
}

/** What a tile surface is made of (typed arrays and plain values): enough to make the same surface in another thread. */
export interface TileSurfaceState { tris: TileTriangles; bvh: TileBvh; options: TileSurfaceOptions }

const SURFACE_STATE = new WeakMap<TileTextureSurface, TileSurfaceState>();

/** The state a surface was built from (absent for a surface not made by buildTileSurface, e.g. a test double). */
export function tileSurfaceState(surface: TileTextureSurface): TileSurfaceState | undefined {
    return SURFACE_STATE.get(surface);
}

/** The surface of a state (tileSurfaceState), without building its hierarchy again: samples bit-identical to the original's. */
export function tileSurfaceFromState(state: TileSurfaceState): TileTextureSurface {
    return buildTileSurface(state.tris, state.options, state.bvh);
}

/** Builds the BVH-backed surface of a parsed tile (`bvh`: one already built over these triangles). */
export function buildTileSurface(tris: TileTriangles, options: TileSurfaceOptions = {}, prebuilt?: TileBvh): TileTextureSurface {
    const n = tris.texture.length;
    const bvh = prebuilt ?? buildBvh(tris.positions, n);
    const maxAngle = options.maxNormalAngleDeg ?? 60;
    const minCos = Math.cos((maxAngle * Math.PI) / 180);
    const maxTangent = options.maxTangentM ?? TILE_SAMPLE_MAX_TANGENT_M, tangentSlope = options.tangentSlope ?? TILE_SAMPLE_TANGENT_SLOPE;
    const delight = options.delight === undefined ? PHOTOGRAMMETRIC_DELIGHT.defaults : options.delight;
    const cp = new Float64Array(5), best = new Float64Array(5), col = new Float64Array(3);
    const stack = new Int32Array(128);

    // Texel size: median over textured triangles of world edge length / UV edge length in texels.
    const sizes: number[] = [];
    for (let t = 0; t < n && sizes.length < 4096; t += Math.max(1, Math.floor(n / 4096))) {
        const ti = tris.texture[t];
        if (ti < 0) continue;
        const tex = tris.textures[ti], P = tris.positions, U = tris.uvs;
        const world = Math.hypot(P[t * 9 + 3] - P[t * 9], P[t * 9 + 4] - P[t * 9 + 1], P[t * 9 + 5] - P[t * 9 + 2]);
        const texels = Math.hypot((U[t * 6 + 2] - U[t * 6]) * tex.width, (U[t * 6 + 3] - U[t * 6 + 1]) * tex.height);
        if (texels > 1e-6) sizes.push(world / texels);
    }
    sizes.sort((a, b) => a - b);

    const surface: TileTextureSurface = {
        triangleCount: n,
        textureCount: tris.textures.length,
        texelSizeM: sizes.length ? sizes[sizes.length >> 1] : NaN,
        maxNormalAngleDeg: maxAngle,
        delight,
        sample(p: Vec3, nq: Vec3, maxDistanceM: number): TileSample | undefined {
            if (!n) return undefined;
            let bestD2 = maxDistanceM * maxDistanceM, bestT = -1, bestCos = 0;
            let sp = 0;
            stack[sp++] = 0;
            while (sp) {
                const id = stack[--sp];
                if (boxDistSq(bvh, id, p) > bestD2) continue;
                if (bvh.left[id] < 0) {
                    for (let i = bvh.start[id]; i < bvh.start[id] + bvh.count[id]; i++) {
                        const t = bvh.order[i];
                        const c = tris.normals[t * 3] * nq[0] + tris.normals[t * 3 + 1] * nq[1] + tris.normals[t * 3 + 2] * nq[2];
                        if (c < minCos) continue; // back face or far skin of a thin wall
                        closestOnTriangle(p, tris.positions, t, cp);
                        const ox = cp[0] - p[0], oy = cp[1] - p[1], oz = cp[2] - p[2];
                        const d2 = ox * ox + oy * oy + oz * oz;
                        if (maxTangent !== Infinity) {
                            const along = ox * nq[0] + oy * nq[1] + oz * nq[2];
                            const side = maxTangent + tangentSlope * Math.abs(along);
                            if (d2 - along * along > side * side) continue; // beside the texel, not in front of or behind it
                        }
                        if (d2 < bestD2 || (d2 === bestD2 && bestT >= 0 && t < bestT)) { bestD2 = d2; bestT = t; bestCos = c; best.set(cp); }
                    }
                } else {
                    const l = bvh.left[id], r = bvh.start[id];
                    const dl = boxDistSq(bvh, l, p), dr = boxDistSq(bvh, r, p);
                    if (sp + 2 > stack.length) throw new Error('tile BVH deeper than the traversal stack');
                    // Push the farther child first so the nearer one is visited first.
                    if (dl <= dr) { if (dr <= bestD2) stack[sp++] = r; if (dl <= bestD2) stack[sp++] = l; }
                    else { if (dl <= bestD2) stack[sp++] = l; if (dr <= bestD2) stack[sp++] = r; }
                }
            }
            if (bestT < 0) return undefined;
            const ti = tris.texture[bestT];
            if (ti >= 0) {
                const v = best[3], w = best[4], u0 = 1 - v - w, U = tris.uvs, o = bestT * 6;
                sampleTexture(tris.textures[ti], u0 * U[o] + v * U[o + 2] + w * U[o + 4], u0 * U[o + 1] + v * U[o + 3] + w * U[o + 5], col);
            } else {
                col[0] = tris.flatLinear[bestT * 3]; col[1] = tris.flatLinear[bestT * 3 + 1]; col[2] = tris.flatLinear[bestT * 3 + 2];
            }
            const lin = delight ? delightLinearRgb(col[0], col[1], col[2], delight) : [col[0], col[1], col[2]];
            return {
                rgb: [linearToSrgb255(lin[0]), linearToSrgb255(lin[1]), linearToSrgb255(lin[2])], distanceM: Math.sqrt(bestD2), cosNormal: bestCos,
                ...(delight ? { litLinear: [col[0], col[1], col[2]] as Vec3 } : {})
            };
        }
    };
    SURFACE_STATE.set(surface, { tris, bvh, options });
    return surface;
}

/** Reads a tile GLB (bytes in memory) and builds its sampling surface. */
export function loadTileSurface(glb: Uint8Array, options: TileSurfaceOptions = {}): TileTextureSurface {
    return buildTileSurface(readTileTriangles(glb), options);
}

// =============================================================================
// Transfer
// =============================================================================

/** Tuning beyond the contract's TileTransferInput (all optional). */
export interface TileTransferTuning {
    /** The surface the sampler came from, for the provenance method line. */
    surface?: Pick<TileTextureSurface, 'maxNormalAngleDeg' | 'delight' | 'texelSizeM'>;
    /** Minimum normal cosine the sampler accepts (for the weight ramp). Default cos 60 deg. */
    minCosNormal?: number;
    /**
     * Cap the de-light's shadow lift by local contrast (delightLinearPlane) so genuinely dark surfaces keep their
     * darkness. Default TEXTURE_LIFT_CAP; false = the sampler's per-texel de-light as is. Needs samples with litLinear.
     */
    liftCap?: { radiusM: number; contrastGain: number } | false;
    /** Match the tile's exposure to the Street View texels of `existing` where both cover (default true). */
    matchExposure?: boolean;
    /**
     * A correction of the de-lit tile candidates before the exposure match and the fusion (texture-lighting.ts: the model's
     * lighting estimate, detail-locked). It edits `rgb` (sRGB 0..255 floats, 3 per texel, where `has`) in place and returns
     * the texels it changed with their provenance entry, or undefined when it changed nothing.
     */
    correctCandidates?: (plane: { rgb: Float32Array; has: Uint8Array; width: number; height: number; existing?: BakedTexturePlanes }) => Promise<{ texels: Uint8Array; provenance: Omit<TexelProvenance, 'coverage'> } | undefined>;
}

/**
 * Largest widening of the distance gate by the move tile_refine recorded at a texel (TILE_REFINE_VERTEX_ATTRIBUTES): the
 * rectify / flatten moves measured on the bake-off places reach 0.45 m at the 99th percentile; past 1 m the nearest same-facing
 * tile surface is more likely another surface than the one the texel was moved from.
 */
export const MAX_MOVED_WIDENING_M = 1;

/** Overlap texels the exposure match needs. */
export const MIN_EXPOSURE_OVERLAP = 500;

const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Sobel energy (gx^2 + gy^2) of luma at texel i, over texels where `has` is set (missing neighbours take the centre). */
function sobelAt(L: Float32Array, has: Uint8Array, W: number, H: number, i: number): number {
    const x = i % W, y = (i / W) | 0;
    const c = L[i];
    const at = (dx: number, dy: number): number => {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) return c;
        const j = yy * W + xx;
        return has[j] ? L[j] : c;
    };
    const gx = at(1, -1) + 2 * at(1, 0) + at(1, 1) - at(-1, -1) - 2 * at(-1, 0) - at(-1, 1);
    const gy = at(-1, 1) + 2 * at(0, 1) + at(1, 1) - at(-1, -1) - 2 * at(0, -1) - at(1, -1);
    return gx * gx + gy * gy;
}

/** Mean of `E` over the 3x3 window of texel i, over texels where `has` is set. */
function windowMean(E: Float32Array, has: Uint8Array, W: number, H: number, i: number): number {
    const x = i % W, y = (i / W) | 0;
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const j = yy * W + xx;
        if (has[j]) { s += E[j]; n++; }
    }
    return n ? s / n : 0;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error('tile texture transfer was stopped'), { name: 'AbortError' });
}

/** TransferTilePhoto (contract D). */
export const transferTilePhoto: TransferTilePhoto = async (input: TileTransferInput & TileTransferTuning): Promise<BakedTexturePlanes> => {
    const { atlas, tileSample, maxDistanceM, existing, signal } = input;
    const W = atlas.width, H = atlas.height, N = W * H;
    if (existing && (existing.width !== W || existing.height !== H)) throw new Error(`existing planes are ${existing.width}x${existing.height}, the atlas is ${W}x${H}`);
    const minCos = input.minCosNormal ?? Math.cos(((input.surface?.maxNormalAngleDeg ?? 60) * Math.PI) / 180);

    // 1. One tile sample per texel the atlas covers (gutter excluded: it is filled by bleed).
    const cand = new Float32Array(N * 3), candW = new Float32Array(N), hasCand = new Uint8Array(N);
    let litLin: Float32Array | undefined;
    const hasLit = new Uint8Array(N);
    let wanted = 0, widened = 0;
    const movedM = atlas.texels.movedM;
    let liftReport: DelightPlaneReport | undefined;
    for (let y = 0; y < H; y++) {
        if ((y & 31) === 0) { throwIfAborted(signal); if (y) await new Promise<void>(r => setImmediate(r)); }
        for (let x = 0; x < W; x++) {
            const i = y * W + x;
            if (!atlas.texels.covered[i] || atlas.texels.gutter[i]) continue;
            wanted++;
            const P = atlas.texels.position, Nn = atlas.texels.normal;
            // a texel tile_refine moved off the scan (rectify, facade flatten, relief) finds the tile photo that much further away
            const moved = movedM ? Math.min(MAX_MOVED_WIDENING_M, movedM[i]) : 0;
            const gate = maxDistanceM + moved;
            const s = tileSample([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], [Nn[i * 3], Nn[i * 3 + 1], Nn[i * 3 + 2]], gate);
            if (!s) continue;
            if (s.distanceM > maxDistanceM) widened++;
            const cosN = 'cosNormal' in s ? (s as TileSample).cosNormal : 1;
            const agree = Math.min(1, Math.max(0, (cosN - minCos) / Math.max(1e-6, 1 - minCos)));
            // the distance ramp is measured past the move: a moved texel sampled exactly where the scan was is "near"
            const near = 1 - 0.5 * Math.min(1, Math.max(0, s.distanceM - moved) / Math.max(1e-6, maxDistanceM));
            cand[i * 3] = s.rgb[0]; cand[i * 3 + 1] = s.rgb[1]; cand[i * 3 + 2] = s.rgb[2];
            const lit = (s as TileSample).litLinear;
            if (lit) { if (!litLin) litLin = new Float32Array(N * 3); litLin[i * 3] = lit[0]; litLin[i * 3 + 1] = lit[1]; litLin[i * 3 + 2] = lit[2]; hasLit[i] = 1; }
            // Never zero for an accepted sample: the weight carries the cap and the two ramps, floor 1/255.
            candW[i] = Math.max(1 / 255, TILE_CONFIDENCE_CAP * (0.5 + 0.5 * agree) * near);
            hasCand[i] = 1;
        }
    }

    // 1b. Re-de-light the transferred plane with the lift capped by local contrast (a dark window opening stays dark).
    const delightParams = input.surface?.delight;
    const capOpt = input.liftCap === undefined ? TEXTURE_LIFT_CAP : input.liftCap;
    if (litLin && capOpt && delightParams) {
        const sizes: number[] = [];
        for (let i = 0; i < N; i += 61) if (hasLit[i]) sizes.push(atlas.texels.sizeM[i]);
        sizes.sort((a, b) => a - b);
        const texelM = sizes.length ? sizes[sizes.length >> 1] : 0.05;
        liftReport = delightLinearPlane(litLin, hasLit, W, H, delightParams, { radiusTexels: capOpt.radiusM / Math.max(1e-3, texelM), contrastGain: capOpt.contrastGain });
        for (let i = 0; i < N; i++) if (hasLit[i]) for (let c = 0; c < 3; c++) cand[i * 3 + c] = linearToSrgb255(litLin[i * 3 + c]);
    }

    // 1b'. The optional lighting correction of the candidates (before the exposure match, so the match sees the corrected tile).
    let corrected: { texels: Uint8Array; provenance: Omit<TexelProvenance, 'coverage'> } | undefined;
    if (input.correctCandidates) corrected = await input.correctCandidates({ rgb: cand, has: hasCand, width: W, height: H, ...(existing ? { existing } : {}) });
    throwIfAborted(signal);

    // 1c. Exposure match to tier 1: the tile photo and the Street View views were taken under different light and white
    //     balance, so a tile texel next to a Street View texel shows a colour step (a seam). Per channel, the median of
    //     the linear ratio Street View / tile over the texels both cover is applied to every tile texel (clamped to
    //     [0.5, 2]); needs MIN_EXPOSURE_OVERLAP texels of overlap, else the tile keeps its own exposure.
    let exposureGain: Vec3 | undefined;
    if (existing && input.matchExposure !== false) {
        const ratios: number[][] = [[], [], []];
        for (let i = 0; i < N; i++) {
            if (!hasCand[i] || !existing.albedo[i * 4 + 3]) continue;
            const e = unpackConfidenceTexel(existing.confidence, i);
            if (!e.covered || e.rung > 1) continue;
            for (let c = 0; c < 3; c++) {
                const t = SRGB8_TO_LINEAR[Math.round(Math.min(255, Math.max(0, cand[i * 3 + c])))];
                if (t > 0.02) ratios[c].push(SRGB8_TO_LINEAR[existing.albedo[i * 4 + c]] / t);
            }
        }
        if (ratios[0].length >= MIN_EXPOSURE_OVERLAP) {
            const med = (a: number[]) => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
            exposureGain = ratios.map(r => Math.min(2, Math.max(0.5, med(r)))) as Vec3;
            for (let i = 0; i < N; i++) {
                if (!hasCand[i]) continue;
                for (let c = 0; c < 3; c++) cand[i * 3 + c] = linearToSrgb255(SRGB8_TO_LINEAR[Math.round(Math.min(255, Math.max(0, cand[i * 3 + c])))] * exposureGain[c]);
            }
        }
    }

    // 2. Fusion rule against tier 1: fill uncovered texels; replace a single-view texel only when the tile is both
    //    more confident and at least as sharp there.
    const take = new Uint8Array(N);
    if (!existing) {
        take.set(hasCand);
    } else {
        const exL = new Float32Array(N), exHas = new Uint8Array(N), cdL = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            const e = unpackConfidenceTexel(existing.confidence, i);
            if (e.covered && existing.albedo[i * 4 + 3]) { exHas[i] = 1; exL[i] = luma(existing.albedo[i * 4], existing.albedo[i * 4 + 1], existing.albedo[i * 4 + 2]); }
            if (hasCand[i]) cdL[i] = luma(cand[i * 3], cand[i * 3 + 1], cand[i * 3 + 2]);
        }
        // The tile's neighbourhood as it would be after the fill: tile where it has a candidate, else tier 1.
        const mixL = new Float32Array(N), mixHas = new Uint8Array(N);
        for (let i = 0; i < N; i++) { if (hasCand[i]) { mixL[i] = cdL[i]; mixHas[i] = 1; } else if (exHas[i]) { mixL[i] = exL[i]; mixHas[i] = 1; } }
        // Local detail energy: Sobel energy averaged over the 3x3 window (one texel alone can sit on a flat stretch),
        // divided by the window's squared mean luma so the two sources compare as contrast, not as exposure: a brighter
        // tile is not "sharper" for being brighter.
        const exSob = new Float32Array(N), mixSob = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            if (exHas[i]) exSob[i] = sobelAt(exL, exHas, W, H, i);
            if (mixHas[i]) mixSob[i] = sobelAt(mixL, mixHas, W, H, i);
        }
        const contrastEnergy = (E: Float32Array, L: Float32Array, has: Uint8Array, i: number): number => {
            const m = windowMean(L, has, W, H, i);
            return windowMean(E, has, W, H, i) / Math.max(1, m * m);
        };
        for (let i = 0; i < N; i++) {
            if (!hasCand[i]) continue;
            if (!exHas[i]) { take[i] = 1; continue; }
            const e = unpackConfidenceTexel(existing.confidence, i);
            // a multi-view texel is never replaced
            if (e.rung <= 0) continue;
            // a Street View texel is kept unless the tile is BOTH more confident AND strictly sharper there
            if (!(e.weight01 < candW[i])) continue;
            if (!(contrastEnergy(mixSob, mixL, mixHas, i) > contrastEnergy(exSob, exL, exHas, i))) continue;
            take[i] = 1;
        }
    }

    // 3. Planes.
    const albedo = new Uint8Array(N * 4);
    const confidence: ConfidencePlane = { width: W, height: H, data: new Uint8Array(N * 4) };
    let filled = 0, filledCorrected = 0;
    for (let i = 0; i < N; i++) {
        if (!take[i]) continue;
        albedo[i * 4] = Math.round(cand[i * 3]); albedo[i * 4 + 1] = Math.round(cand[i * 3 + 1]); albedo[i * 4 + 2] = Math.round(cand[i * 3 + 2]); albedo[i * 4 + 3] = 255;
        const lit = !!corrected?.texels[i];
        packConfidenceTexel(confidence, i, lit ? 1 : 0, candW[i], TILE_TRANSFER_RUNG);
        filled++;
        if (lit) filledCorrected++;
    }
    const atlasTexels = countCovered(atlas.texels.covered);
    const d = input.surface?.delight;
    const exposureLine = `${exposureGain ? `, exposure matched to the Street View texels (linear gain ${exposureGain.map(g => g.toFixed(2)).join('/')})` : ''}`;
    const delightLine = d === false ? 'not de-lit' : `de-lit (shadowLift ${(d || PHOTOGRAMMETRIC_DELIGHT.defaults).shadowLift}, highlightCompress ${(d || PHOTOGRAMMETRIC_DELIGHT.defaults).highlightCompress}${liftReport ? `; lift capped by local contrast, ${Math.round(liftReport.meanLiftKept * 100)} percent of it kept on average` : ''})`;
    const provenance: TexelProvenance[] = [{
        source: 'tile-photo-transfer', label: 'photo-inferred',
        method: `nearest tile surface (BVH, <= ${round3(maxDistanceM)} m${movedM ? ` plus the distance tile_refine moved the surface at the texel, at most ${MAX_MOVED_WIDENING_M} m more (${widened} texels sampled past ${round3(maxDistanceM)} m)` : ''}, normal within ${round3(Math.acos(minCos) * 180 / Math.PI)} deg), bilinear in tile UV`
            + `${input.surface && Number.isFinite(input.surface.texelSizeM) ? ` (tile texel ${round3(input.surface.texelSizeM)} m)` : ''}, ${delightLine}${exposureLine}, confidence <= ${TILE_CONFIDENCE_CAP}`,
        coverage: atlasTexels ? (filled - filledCorrected) / atlasTexels : 0
    }];
    // the lighting-corrected texels: index 1, always present when a correction ran (so the indices stay fixed)
    if (corrected) provenance.push({ ...corrected.provenance, coverage: atlasTexels ? filledCorrected / atlasTexels : 0 });

    // 4. Degradations: texels that needed a fill and got none move on to the palette rung.
    const degradations: TexturePassDegradation[] = [];
    let unfilled = 0;
    for (let i = 0; i < N; i++) {
        if (!atlas.texels.covered[i] || atlas.texels.gutter[i] || take[i]) continue;
        const exCovered = existing ? unpackConfidenceTexel(existing.confidence, i).covered : false;
        if (!exCovered && !hasCand[i]) unfilled++;
    }
    if (unfilled && wanted) {
        degradations.push({
            stage: 'tile-transfer', reasonCode: 'tile_surface_out_of_range', layerKey: atlas.layerKey,
            fromRung: TILE_TRANSFER_RUNG, toRung: NEXT_RUNG, texelShare: atlasTexels ? unfilled / atlasTexels : 0,
            reason: `${unfilled} texels had no tile surface within ${round3(maxDistanceM)} m${movedM ? ' (plus the distance tile_refine moved the surface there)' : ''} facing the same way (within ${round3(Math.acos(minCos) * 180 / Math.PI)} degrees), so the tile photo cannot colour them.`
        });
    }
    return { layerKey: atlas.layerKey, width: W, height: H, albedo, confidence, provenance, degradations };
};

/** Counts of the fusion decisions, for reports and tests. */
export function fusionDecisionCounts(existing: BakedTexturePlanes, transfer: BakedTexturePlanes): { tileFilled: number; tierOneKept: number } {
    let tileFilled = 0, tierOneKept = 0;
    for (let i = 0; i < transfer.width * transfer.height; i++) {
        if (transfer.albedo[i * 4 + 3]) tileFilled++;
        else if (unpackConfidenceTexel(existing.confidence, i).covered) tierOneKept++;
    }
    return { tileFilled, tierOneKept };
}

function countCovered(covered: Uint8Array): number { let c = 0; for (let i = 0; i < covered.length; i++) if (covered[i]) c++; return c; }
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/**
 * Composes `over` (texels with alpha 255) onto `base`: provenance lists are concatenated (`over`'s indices shifted),
 * coverages kept (each is a share of the same atlas), degradations concatenated. Texels of `base` that `over` does
 * not hold stay byte-identical.
 */
export function mergeBakedPlanes(base: BakedTexturePlanes, over: BakedTexturePlanes): BakedTexturePlanes {
    if (base.width !== over.width || base.height !== over.height) throw new Error('mergeBakedPlanes: plane sizes differ');
    const N = base.width * base.height;
    const albedo = Uint8Array.from(base.albedo);
    const confidence: ConfidencePlane = { width: base.width, height: base.height, data: Uint8Array.from(base.confidence.data) };
    const shift = base.provenance.length;
    if (shift + over.provenance.length > 255) throw new Error('mergeBakedPlanes: more than 255 provenance entries');
    const replaced = new Array<number>(shift).fill(0);
    for (let i = 0; i < N; i++) {
        if (!over.albedo[i * 4 + 3]) continue;
        const b = unpackConfidenceTexel(base.confidence, i);
        if (b.covered && b.provenanceIndex < shift) replaced[b.provenanceIndex]++;
        albedo.set(over.albedo.subarray(i * 4, i * 4 + 4), i * 4);
        const o = unpackConfidenceTexel(over.confidence, i);
        packConfidenceTexel(confidence, i, o.provenanceIndex + shift, o.weight01, o.rung);
    }
    // A replaced base texel no longer belongs to its old entry: reduce that entry's coverage by the same share.
    const total = base.provenance.reduce((s, p) => s + p.coverage, 0);
    let baseTexels = 0;
    for (let i = 0; i < N; i++) if (unpackConfidenceTexel(base.confidence, i).covered) baseTexels++;
    const perTexel = baseTexels ? total / baseTexels : 0;
    const provenance = [
        ...base.provenance.map((p, k) => ({ ...p, coverage: Math.max(0, p.coverage - replaced[k] * perTexel) })),
        ...over.provenance
    ];
    return {
        layerKey: base.layerKey, width: base.width, height: base.height, albedo, confidence, provenance,
        degradations: [...base.degradations, ...over.degradations],
        ...(base.paletteDeltaE !== undefined ? { paletteDeltaE: base.paletteDeltaE } : {})
    };
}

/** Wires a tile GLB to the contract: parses it, builds the surface, and runs the transfer. */
export async function transferTilePhotoFromGlb(
    tileGlb: Uint8Array,
    input: Omit<TileTransferInput, 'tileSample'> & Pick<TileTransferTuning, 'liftCap' | 'minCosNormal'>,
    options: TileSurfaceOptions = {}
): Promise<{ planes: BakedTexturePlanes; surface: TileTextureSurface }> {
    const surface = loadTileSurface(tileGlb, options);
    const planes = await transferTilePhoto({ ...input, tileSample: surface.sample, surface } as TileTransferInput & TileTransferTuning);
    return { planes, surface };
}
