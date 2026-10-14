/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Independent gate metrics for Street View texturing of a scan (plan F, Stage 3).
 *
 * Everything here is measured from what the pipeline wrote: the input and output GLB bytes, rendered
 * images, plate photos / masks, and (for the coverage gate) the per-texel confidence maps the fusion
 * reports. No code is shared with the editing path (StreetViewTextureFusion / SurveyTextureUnprojector):
 * the colour science, filters and GLB walking below are separate implementations, so a bug in the editor
 * cannot also hide itself in the measurement.
 */

import { createHash } from 'crypto';
import { AlgorithmicUvEngine } from './AlgorithmicUvEngine';
import { decodeImageToRgba } from '../image-codec-ffmpeg';

// ============================================================================================
// GLB walking
// ============================================================================================

export interface PrimitiveImageRef {
    /** Index in mesh order (meshes in index order, primitives with POSITION in order). */
    primitiveIndex: number;
    meshIndex: number;
    materialIndex: number | null;
    imageIndex: number | null;
    sha256: string | null;
    bytes: number;
    mimeType: string | null;
}

function imageBytes(json: any, bin: Buffer, imageIndex: number): Buffer | null {
    const img = json.images?.[imageIndex];
    if (!img || img.bufferView === undefined) return null;
    const bv = json.bufferViews?.[img.bufferView];
    if (!bv) return null;
    const off = bv.byteOffset || 0;
    return bin.subarray(off, off + bv.byteLength);
}

/** The baseColor image of every triangle-bearing primitive, in mesh order. */
export function listPrimitiveBaseColorImages(glb: Buffer): { json: any; bin: Buffer; prims: PrimitiveImageRef[] } {
    const { json, bin } = AlgorithmicUvEngine.parseGlb(glb);
    const prims: PrimitiveImageRef[] = [];
    (json.meshes || []).forEach((mesh: any, mi: number) => {
        for (const p of mesh.primitives || []) {
            if (!p.attributes || p.attributes.POSITION === undefined) continue;
            const mat = p.material !== undefined ? json.materials?.[p.material] : undefined;
            const texIndex = mat?.pbrMetallicRoughness?.baseColorTexture?.index;
            const imageIndex = texIndex !== undefined ? json.textures?.[texIndex]?.source ?? null : null;
            const bytes = imageIndex !== null ? imageBytes(json, bin, imageIndex) : null;
            prims.push({
                primitiveIndex: prims.length, meshIndex: mi, materialIndex: p.material ?? null, imageIndex,
                sha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null,
                bytes: bytes ? bytes.length : 0,
                mimeType: imageIndex !== null ? json.images?.[imageIndex]?.mimeType ?? null : null
            });
        }
    });
    return { json, bin, prims };
}

export interface ImageIdentityReport {
    primitives: number;
    /** Primitives whose baseColor image bytes differ from the input (or whose image appeared / vanished). */
    changed: number[];
    unchanged: number[];
    /** Changed primitives the caller did not declare as replaced (must be empty). */
    unexpectedChanges: number[];
    /** Declared-replaced primitives whose bytes did not change (must be empty). */
    declaredButIdentical: number[];
    /** Input image count / output image count (orphans removed = input - output when nothing is added). */
    inputImages: number;
    outputImages: number;
}

/**
 * Byte identity of every primitive's baseColor image between input and output. `declaredReplaced` is the
 * set the editor says it replaced; any other change is reported as unexpected.
 */
export function compareBaseColorImages(inputGlb: Buffer, outputGlb: Buffer, declaredReplaced: Iterable<number> = []): ImageIdentityReport {
    const a = listPrimitiveBaseColorImages(inputGlb), b = listPrimitiveBaseColorImages(outputGlb);
    if (a.prims.length !== b.prims.length) throw new Error(`compareBaseColorImages: primitive count differs (${a.prims.length} vs ${b.prims.length})`);
    const declared = new Set(declaredReplaced);
    const changed: number[] = [], unchanged: number[] = [];
    for (let i = 0; i < a.prims.length; i++) (a.prims[i].sha256 === b.prims[i].sha256 ? unchanged : changed).push(i);
    return {
        primitives: a.prims.length, changed, unchanged,
        unexpectedChanges: changed.filter(i => !declared.has(i)),
        declaredButIdentical: [...declared].filter(i => unchanged.includes(i)),
        inputImages: (a.json.images || []).length,
        outputImages: (b.json.images || []).length
    };
}

export interface MaterialAudit {
    materials: number;
    /**
     * Materials declaring metal: metallicFactor > 0 (the glTF default is 1) or a metallicRoughness texture, unlit or
     * not (an unlit material is still metallic for any viewer that ignores KHR_materials_unlit).
     */
    metallic: Array<{ index: number; metallicFactor: number; unlit: boolean }>;
    unlit: number;
    withMetallicRoughnessTexture: number;
}

export function auditMaterials(glb: Buffer): MaterialAudit {
    const { json } = AlgorithmicUvEngine.parseGlb(glb);
    const mats: any[] = json.materials || [];
    const out: MaterialAudit = { materials: mats.length, metallic: [], unlit: 0, withMetallicRoughnessTexture: 0 };
    mats.forEach((m, i) => {
        const unlit = !!m.extensions?.KHR_materials_unlit;
        if (unlit) out.unlit++;
        const pbr = m.pbrMetallicRoughness;
        const mf = pbr?.metallicFactor ?? 1;
        if (pbr?.metallicRoughnessTexture) out.withMetallicRoughnessTexture++;
        if (mf > 0 || pbr?.metallicRoughnessTexture) out.metallic.push({ index: i, metallicFactor: mf, unlit });
    });
    return out;
}

// ============================================================================================
// Colour (independent implementation: sRGB -> CIELAB D65, CIEDE2000)
// ============================================================================================

function srgbToLinear(v8: number): number {
    const c = v8 / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const LIN = (() => { const t = new Float64Array(256); for (let i = 0; i < 256; i++) t[i] = srgbToLinear(i); return t; })();

/** Linear RGB (0..1) to CIELAB (D65). */
export function linearRgbToLab(r: number, g: number, b: number): [number, number, number] {
    const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
    const Z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
    const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    const fx = f(X), fy = f(Y), fz = f(Z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 colour difference (Sharma, Wu, Dalal 2005). */
export function ciede2000(lab1: [number, number, number], lab2: [number, number, number]): number {
    const [L1, a1, b1] = lab1, [L2, a2, b2] = lab2;
    const rad = Math.PI / 180;
    const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
    const Cm = (C1 + C2) / 2, Cm7 = Math.pow(Cm, 7);
    const G = 0.5 * (1 - Math.sqrt(Cm7 / (Cm7 + Math.pow(25, 7))));
    const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
    const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
    const hp = (a: number, b: number) => { if (a === 0 && b === 0) return 0; const h = Math.atan2(b, a) / rad; return h < 0 ? h + 360 : h; };
    const h1p = hp(a1p, b1), h2p = hp(a2p, b2);
    const dLp = L2 - L1, dCp = C2p - C1p;
    let dhp = 0;
    if (C1p * C2p !== 0) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
    const Lpm = (L1 + L2) / 2, Cpm = (C1p + C2p) / 2;
    let hpm = h1p + h2p;
    if (C1p * C2p !== 0) {
        if (Math.abs(h1p - h2p) <= 180) hpm = (h1p + h2p) / 2;
        else hpm = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
    }
    const T = 1 - 0.17 * Math.cos((hpm - 30) * rad) + 0.24 * Math.cos(2 * hpm * rad) + 0.32 * Math.cos((3 * hpm + 6) * rad) - 0.2 * Math.cos((4 * hpm - 63) * rad);
    const dTheta = 30 * Math.exp(-(((hpm - 275) / 25) ** 2));
    const Cpm7 = Math.pow(Cpm, 7);
    const Rc = 2 * Math.sqrt(Cpm7 / (Cpm7 + Math.pow(25, 7)));
    const Sl = 1 + (0.015 * (Lpm - 50) ** 2) / Math.sqrt(20 + (Lpm - 50) ** 2);
    const Sc = 1 + 0.045 * Cpm, Sh = 1 + 0.015 * Cpm * T;
    const Rt = -Math.sin(2 * dTheta * rad) * Rc;
    const l = dLp / Sl, c = dCp / Sc, h = dHp / Sh;
    return Math.sqrt(l * l + c * c + h * h + Rt * c * h);
}

// ============================================================================================
// Texture-space audits of replaced images
// ============================================================================================

/** Bilinear, centre-aligned resample of an RGBA8 image to linear RGB at (W, H). */
function resampleLinear(rgba: Buffer, w: number, h: number, W: number, H: number): Float32Array {
    const out = new Float32Array(W * H * 3);
    for (let y = 0; y < H; y++) {
        const sy = Math.min(h - 1, Math.max(0, (y + 0.5) * h / H - 0.5));
        const y0 = Math.floor(sy), y1 = Math.min(h - 1, y0 + 1), fy = sy - y0;
        for (let x = 0; x < W; x++) {
            const sx = Math.min(w - 1, Math.max(0, (x + 0.5) * w / W - 0.5));
            const x0 = Math.floor(sx), x1 = Math.min(w - 1, x0 + 1), fx = sx - x0;
            for (let ch = 0; ch < 3; ch++) {
                const v00 = LIN[rgba[(y0 * w + x0) * 4 + ch]], v10 = LIN[rgba[(y0 * w + x1) * 4 + ch]];
                const v01 = LIN[rgba[(y1 * w + x0) * 4 + ch]], v11 = LIN[rgba[(y1 * w + x1) * 4 + ch]];
                out[(y * W + x) * 3 + ch] = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
            }
        }
    }
    return out;
}

/** Separable Gaussian normalised convolution of a 3-channel field over `mask` (mask texels only). */
function maskedGaussian3(src: Float32Array, mask: Uint8Array, W: number, H: number, sigma: number): Float32Array {
    const r = Math.max(1, Math.ceil(3 * sigma));
    const k = new Float64Array(2 * r + 1);
    for (let i = -r; i <= r; i++) k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    const tmp = new Float32Array(W * H * 4), out = new Float32Array(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let s0 = 0, s1 = 0, s2 = 0, sw = 0;
        for (let d = -r; d <= r; d++) {
            const xx = x + d;
            if (xx < 0 || xx >= W) continue;
            const j = y * W + xx;
            if (!mask[j]) continue;
            const w = k[d + r];
            s0 += w * src[j * 3]; s1 += w * src[j * 3 + 1]; s2 += w * src[j * 3 + 2]; sw += w;
        }
        const i = y * W + x;
        tmp[i * 4] = s0; tmp[i * 4 + 1] = s1; tmp[i * 4 + 2] = s2; tmp[i * 4 + 3] = sw;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let s0 = 0, s1 = 0, s2 = 0, sw = 0;
        for (let d = -r; d <= r; d++) {
            const yy = y + d;
            if (yy < 0 || yy >= H) continue;
            const j = yy * W + x, w = k[d + r];
            s0 += w * tmp[j * 4]; s1 += w * tmp[j * 4 + 1]; s2 += w * tmp[j * 4 + 2]; sw += w * tmp[j * 4 + 3];
        }
        const i = y * W + x;
        if (sw > 0) { out[i * 3] = s0 / sw; out[i * 3 + 1] = s1 / sw; out[i * 3 + 2] = s2 / sw; }
    }
    return out;
}

export interface ReplacedImageAudit {
    primitiveIndex: number;
    inputSize: string;
    outputSize: string;
    /** Output texels that look magenta (R, B >= 200, G <= 80) / the same count in the input. */
    magentaTexels: number;
    magentaTexelsInput: number;
    /** Area-weighted mean CIELAB shift (output - input) over chart texels with c >= 0.5. */
    meanDeltaL: number;
    meanDeltaA: number;
    meanDeltaB: number;
    confidentTexels: number;
    /** Control: area-weighted mean CIELAB shift over chart texels with c = 0 (pure re-encode / resampling shift). */
    controlDeltaL: number;
    controlDeltaA: number;
    controlDeltaB: number;
    controlTexels: number;
    /** Seam band: chart texels with 0 < c < 0.95, plus c = 0 chart texels within 2 s of a c > 0 texel. */
    seamBandTexels: number;
    /** CIEDE2000 between Gaussian low-passes (sigma 2 s texels) of output and input in the seam band. */
    seamDeltaE00Mean: number;
    seamDeltaE00P95: number;
}

/**
 * Audits one replaced baseColor image against the input image of the same primitive, using the fusion's
 * confidence / chart maps (map size W x H; `scale` = map size / input size). The output image is the encoded
 * file as written (JPEG generation loss included).
 */
export async function auditReplacedImage(
    primitiveIndex: number,
    inputEncoded: Buffer,
    outputEncoded: Buffer,
    maps: { width: number; height: number; confidence: Float32Array; coverage: Uint8Array; texelSizeMeters: Float32Array },
    scale: number
): Promise<ReplacedImageAudit> {
    const inp = await decodeImageToRgba(inputEncoded), outp = await decodeImageToRgba(outputEncoded);
    const W = maps.width, H = maps.height, N = W * H;
    const O = outp.width === W && outp.height === H ? (() => {
        const f = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) { f[i * 3] = LIN[outp.rgba[i * 4]]; f[i * 3 + 1] = LIN[outp.rgba[i * 4 + 1]]; f[i * 3 + 2] = LIN[outp.rgba[i * 4 + 2]]; }
        return f;
    })() : resampleLinear(outp.rgba, outp.width, outp.height, W, H);
    const I = resampleLinear(inp.rgba, inp.width, inp.height, W, H);
    let magenta = 0, magentaIn = 0;
    for (let i = 0, n = outp.width * outp.height; i < n; i++) if (outp.rgba[i * 4] >= 200 && outp.rgba[i * 4 + 2] >= 200 && outp.rgba[i * 4 + 1] <= 80) magenta++;
    for (let i = 0, n = inp.width * inp.height; i < n; i++) if (inp.rgba[i * 4] >= 200 && inp.rgba[i * 4 + 2] >= 200 && inp.rgba[i * 4 + 1] <= 80) magentaIn++;

    const c = maps.confidence, chart = maps.coverage;
    let dl = 0, da = 0, db = 0, wsum = 0, confident = 0;
    let kl = 0, ka = 0, kb = 0, kw = 0, control = 0;
    for (let i = 0; i < N; i++) {
        if (chart[i] !== 1) continue;
        const isConf = c[i] >= 0.5, isControl = !(c[i] > 0);
        if (!isConf && !isControl) continue;
        const a = maps.texelSizeMeters[i] ** 2 || 1;
        const lo = linearRgbToLab(O[i * 3], O[i * 3 + 1], O[i * 3 + 2]), li = linearRgbToLab(I[i * 3], I[i * 3 + 1], I[i * 3 + 2]);
        if (isConf) { dl += a * (lo[0] - li[0]); da += a * (lo[1] - li[1]); db += a * (lo[2] - li[2]); wsum += a; confident++; }
        else { kl += a * (lo[0] - li[0]); ka += a * (lo[1] - li[1]); kb += a * (lo[2] - li[2]); kw += a; control++; }
    }

    // Seam band
    const changed = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (chart[i] === 1 && c[i] > 0) changed[i] = 1;
    const near = chamferDistance(changed, W, H);
    const band: number[] = [];
    for (let i = 0; i < N; i++) {
        if (chart[i] !== 1) continue;
        if ((c[i] > 0 && c[i] < 0.95) || (!(c[i] > 0) && near[i] <= 2 * scale)) band.push(i);
    }
    const chartMask = new Uint8Array(N);
    for (let i = 0; i < N; i++) chartMask[i] = chart[i] === 1 ? 1 : 0;
    const des: number[] = [];
    if (band.length) {
        const LO = maskedGaussian3(O, chartMask, W, H, 2 * scale), LI = maskedGaussian3(I, chartMask, W, H, 2 * scale);
        for (const i of band) des.push(ciede2000(linearRgbToLab(LO[i * 3], LO[i * 3 + 1], LO[i * 3 + 2]), linearRgbToLab(LI[i * 3], LI[i * 3 + 1], LI[i * 3 + 2])));
        des.sort((x, y) => x - y);
    }
    return {
        primitiveIndex,
        inputSize: `${inp.width}x${inp.height}`,
        outputSize: `${outp.width}x${outp.height}`,
        magentaTexels: magenta,
        magentaTexelsInput: magentaIn,
        meanDeltaL: wsum ? dl / wsum : 0,
        meanDeltaA: wsum ? da / wsum : 0,
        meanDeltaB: wsum ? db / wsum : 0,
        confidentTexels: confident,
        controlDeltaL: kw ? kl / kw : 0,
        controlDeltaA: kw ? ka / kw : 0,
        controlDeltaB: kw ? kb / kw : 0,
        controlTexels: control,
        seamBandTexels: band.length,
        seamDeltaE00Mean: des.length ? des.reduce((s, v) => s + v, 0) / des.length : 0,
        seamDeltaE00P95: des.length ? des[Math.min(des.length - 1, Math.floor(0.95 * des.length))] : 0
    };
}

/** 3-4 chamfer distance (in pixels) to the nearest set pixel. */
function chamferDistance(src: Uint8Array, W: number, H: number): Float32Array {
    const INF = 1e9;
    const d = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) d[i] = src[i] ? 0 : INF;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        let v = d[i];
        if (x > 0) v = Math.min(v, d[i - 1] + 1);
        if (y > 0) { v = Math.min(v, d[i - W] + 1); if (x > 0) v = Math.min(v, d[i - W - 1] + 1.4142); if (x + 1 < W) v = Math.min(v, d[i - W + 1] + 1.4142); }
        d[i] = v;
    }
    for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
        const i = y * W + x;
        let v = d[i];
        if (x + 1 < W) v = Math.min(v, d[i + 1] + 1);
        if (y + 1 < H) { v = Math.min(v, d[i + W] + 1); if (x + 1 < W) v = Math.min(v, d[i + W + 1] + 1.4142); if (x > 0) v = Math.min(v, d[i + W - 1] + 1.4142); }
        d[i] = v;
    }
    return d;
}

// ============================================================================================
// Coverage of mesh-derived target samples by fused confidence
// ============================================================================================

export interface CoverageSamples {
    count: number;
    /** World positions (x, y, z) per sample. */
    pos: Float32Array;
    area: Float32Array;
    /** Global triangle index into the concatenation of `primitives` (in order). */
    triangle: Uint32Array;
    /** Grouping keys of each sample (e.g. facade side / height band); reported as given. */
    group: string[];
    /** Samples counted in the gate denominator (e.g. street-visible facade below a height). */
    inGate: Uint8Array;
}

export interface CoveragePrimitive {
    positions: Float32Array;
    indices: Uint32Array;
    uvs: Float32Array | null;
}

export interface CoverageResult {
    gateAreaM2: number;
    gateConfidentM2: number;
    gateFraction: number;
    byGroup: Array<{ group: string; areaM2: number; gateAreaM2: number; confidentM2: number; gateConfidentM2: number; gateFraction: number }>;
    samplesOutsideMaps: number;
}

/**
 * Area of samples whose texel confidence is >= threshold. Each sample is located on its triangle by
 * barycentric coordinates, its UV interpolated and the confidence read from the texel that contains it
 * (texel (i, j) covers [i / W, (i + 1) / W) x [j / H, (j + 1) / H)). Primitives without a map count as c = 0.
 */
export function confidenceCoverageAtSamples(
    samples: CoverageSamples,
    primitives: CoveragePrimitive[],
    maps: Map<number, { width: number; height: number; confidence: Float32Array }>,
    threshold = 0.5
): CoverageResult {
    const triOffset: number[] = [];
    let t = 0;
    for (const p of primitives) { triOffset.push(t); t += p.indices.length / 3; }
    const findPrim = (tri: number): number => {
        let lo = 0, hi = triOffset.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (triOffset[mid] <= tri) lo = mid; else hi = mid - 1; }
        return lo;
    };
    const groups = new Map<string, { areaM2: number; gateAreaM2: number; confidentM2: number; gateConfidentM2: number }>();
    let gateA = 0, gateC = 0, outside = 0;
    for (let s = 0; s < samples.count; s++) {
        const pi = findPrim(samples.triangle[s]);
        const prim = primitives[pi];
        const map = maps.get(pi);
        let conf = 0;
        if (map && prim.uvs) {
            const lt = samples.triangle[s] - triOffset[pi];
            const ia = prim.indices[lt * 3], ib = prim.indices[lt * 3 + 1], ic = prim.indices[lt * 3 + 2];
            const P = prim.positions;
            const w = barycentric(samples.pos[s * 3], samples.pos[s * 3 + 1], samples.pos[s * 3 + 2], P, ia, ib, ic);
            const u = w[0] * prim.uvs[ia * 2] + w[1] * prim.uvs[ib * 2] + w[2] * prim.uvs[ic * 2];
            const v = w[0] * prim.uvs[ia * 2 + 1] + w[1] * prim.uvs[ib * 2 + 1] + w[2] * prim.uvs[ic * 2 + 1];
            const x = Math.floor(u * map.width), y = Math.floor(v * map.height);
            if (x >= 0 && y >= 0 && x < map.width && y < map.height) conf = map.confidence[y * map.width + x];
            else outside++;
        }
        const a = samples.area[s];
        const g = groups.get(samples.group[s]) ?? { areaM2: 0, gateAreaM2: 0, confidentM2: 0, gateConfidentM2: 0 };
        g.areaM2 += a;
        const ok = conf >= threshold;
        if (ok) g.confidentM2 += a;
        if (samples.inGate[s]) { g.gateAreaM2 += a; gateA += a; if (ok) { g.gateConfidentM2 += a; gateC += a; } }
        groups.set(samples.group[s], g);
    }
    return {
        gateAreaM2: gateA, gateConfidentM2: gateC, gateFraction: gateA > 0 ? gateC / gateA : 0,
        byGroup: [...groups.entries()].map(([group, g]) => ({ group, ...g, gateFraction: g.gateAreaM2 > 0 ? g.gateConfidentM2 / g.gateAreaM2 : 0 }))
            .sort((x, y) => x.group.localeCompare(y.group, undefined, { numeric: true })),
        samplesOutsideMaps: outside
    };
}

function barycentric(px: number, py: number, pz: number, P: Float32Array, ia: number, ib: number, ic: number): [number, number, number] {
    const ax = P[ia * 3], ay = P[ia * 3 + 1], az = P[ia * 3 + 2];
    const v0x = P[ib * 3] - ax, v0y = P[ib * 3 + 1] - ay, v0z = P[ib * 3 + 2] - az;
    const v1x = P[ic * 3] - ax, v1y = P[ic * 3 + 1] - ay, v1z = P[ic * 3 + 2] - az;
    const v2x = px - ax, v2y = py - ay, v2z = pz - az;
    const d00 = v0x * v0x + v0y * v0y + v0z * v0z, d01 = v0x * v1x + v0y * v1y + v0z * v1z, d11 = v1x * v1x + v1y * v1y + v1z * v1z;
    const d20 = v2x * v0x + v2y * v0y + v2z * v0z, d21 = v2x * v1x + v2y * v1y + v2z * v1z;
    const den = d00 * d11 - d01 * d01;
    if (!(Math.abs(den) > 1e-18)) return [1 / 3, 1 / 3, 1 / 3];
    const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
    return [1 - v - w, v, w];
}

// ============================================================================================
// Screen-space metrics on renders and photos
// ============================================================================================

/** Rec. 709 luminance of 8-bit sRGB values (0..255 scale, display-referred). */
export function luminance8(rgba: Uint8Array | Buffer, n: number): Float32Array {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = 0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2];
    return out;
}

/** Variance of the 4-neighbour Laplacian over pixels whose 3x3 cross lies inside `mask`. */
export function laplacianVariance(lum: Float32Array, W: number, H: number, mask: Uint8Array): { pixels: number; variance: number } {
    let n = 0, s = 0, s2 = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (!mask[i] || !mask[i - 1] || !mask[i + 1] || !mask[i - W] || !mask[i + W]) continue;
        const l = lum[i - 1] + lum[i + 1] + lum[i - W] + lum[i + W] - 4 * lum[i];
        s += l; s2 += l * l; n++;
    }
    return { pixels: n, variance: n ? s2 / n - (s / n) ** 2 : 0 };
}

/**
 * Mean squared Sobel gradients (x: vertical edges, y: horizontal edges) over pixels whose 3x3 block lies inside
 * `mask`. A ratio of stage-3 to base energy below 1 means the change softened edges (e.g. limestone piers).
 */
export function sobelEnergy(lum: Float32Array, W: number, H: number, mask: Uint8Array): { pixels: number; x: number; y: number } {
    let n = 0, ex = 0, ey = 0;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (!mask[i] || !mask[i - 1] || !mask[i + 1] || !mask[i - W] || !mask[i + W] || !mask[i - W - 1] || !mask[i - W + 1] || !mask[i + W - 1] || !mask[i + W + 1]) continue;
        const gx = (lum[i - W + 1] + 2 * lum[i + 1] + lum[i + W + 1]) - (lum[i - W - 1] + 2 * lum[i - 1] + lum[i + W - 1]);
        const gy = (lum[i + W - 1] + 2 * lum[i + W] + lum[i + W + 1]) - (lum[i - W - 1] + 2 * lum[i - W] + lum[i - W + 1]);
        ex += gx * gx; ey += gy * gy; n++;
    }
    return { pixels: n, x: n ? ex / n : 0, y: n ? ey / n : 0 };
}

/** Pearson correlation of two images over `mask`. */
export function maskedNcc(a: Float32Array, b: Float32Array, mask: Uint8Array): { pixels: number; ncc: number | null } {
    let n = 0, sa = 0, sb = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) { sa += a[i]; sb += b[i]; n++; }
    if (n < 16) return { pixels: n, ncc: null };
    const ma = sa / n, mb = sb / n;
    let num = 0, va = 0, vb = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) { const da = a[i] - ma, db = b[i] - mb; num += da * db; va += da * da; vb += db * db; }
    return { pixels: n, ncc: va > 0 && vb > 0 ? num / Math.sqrt(va * vb) : null };
}

/** Separable Gaussian blur of a single-channel image. */
export function blur1(src: Float32Array, W: number, H: number, sigma: number): Float32Array {
    if (sigma <= 0) return Float32Array.from(src);
    const r = Math.max(1, Math.ceil(3 * sigma));
    const k = new Float32Array(2 * r + 1);
    let ks = 0;
    for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); ks += k[i + r]; }
    for (let i = 0; i < k.length; i++) k[i] /= ks;
    const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let s = 0;
        for (let d = -r; d <= r; d++) s += k[d + r] * src[y * W + Math.min(W - 1, Math.max(0, x + d))];
        tmp[y * W + x] = s;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let s = 0;
        for (let d = -r; d <= r; d++) s += k[d + r] * tmp[Math.min(H - 1, Math.max(0, y + d)) * W + x];
        out[y * W + x] = s;
    }
    return out;
}

/** Edge pixels: thinned (non-maximum suppressed) Sobel maxima above the `quantile` of magnitudes in `mask`. */
export function edgeMap(lum: Float32Array, W: number, H: number, mask: Uint8Array, quantile = 0.85, blurSigma = 1): Uint8Array {
    const L = blur1(lum, W, H, blurSigma);
    const gx = new Float32Array(W * H), gy = new Float32Array(W * H), mag = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const a = L[i - W - 1], b = L[i - W], c = L[i - W + 1], d = L[i - 1], f = L[i + 1], g = L[i + W - 1], h = L[i + W], k = L[i + W + 1];
        gx[i] = (c + 2 * f + k) - (a + 2 * d + g);
        gy[i] = (g + 2 * h + k) - (a + 2 * b + c);
        mag[i] = Math.hypot(gx[i], gy[i]);
    }
    const vals: number[] = [];
    for (let i = 0; i < W * H; i++) if (mask[i] && mag[i] > 0) vals.push(mag[i]);
    vals.sort((p, q) => p - q);
    const thr = vals.length ? vals[Math.min(vals.length - 1, Math.floor(quantile * vals.length))] : Infinity;
    const out = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (!mask[i] || mag[i] < thr) continue;
        const ax = Math.abs(gx[i]), ay = Math.abs(gy[i]);
        const [n1, n2] = ax > 2.414 * ay ? [i - 1, i + 1] : ay > 2.414 * ax ? [i - W, i + W] : (gx[i] * gy[i] > 0 ? [i - W - 1, i + W + 1] : [i - W + 1, i + W - 1]);
        if (mag[i] >= mag[n1] && mag[i] >= mag[n2]) out[i] = 1;
    }
    return out;
}

/** Exact Euclidean distance transform (Felzenszwalb-Huttenlocher) to the nearest set pixel. */
export function exactDistanceTransform(src: Uint8Array, W: number, H: number): Float32Array {
    const INF = 1e20;
    const f = new Float64Array(Math.max(W, H)), d = new Float64Array(Math.max(W, H)), z = new Float64Array(Math.max(W, H) + 1);
    const v = new Int32Array(Math.max(W, H));
    const grid = new Float64Array(W * H);
    for (let i = 0; i < W * H; i++) grid[i] = src[i] ? 0 : INF;
    const pass = (n: number) => {
        let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
        for (let q = 1; q < n; q++) {
            let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
            while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
            k++; v[k] = q; z[k] = s; z[k + 1] = INF;
        }
        k = 0;
        for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) ** 2 + f[v[k]]; }
    };
    for (let x = 0; x < W; x++) { for (let y = 0; y < H; y++) f[y] = grid[y * W + x]; pass(H); for (let y = 0; y < H; y++) grid[y * W + x] = d[y]; }
    for (let y = 0; y < H; y++) { for (let x = 0; x < W; x++) f[x] = grid[y * W + x]; pass(W); for (let x = 0; x < W; x++) grid[y * W + x] = d[x]; }
    const out = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) out[i] = Math.sqrt(grid[i]);
    return out;
}

/**
 * Edge residual of a render against a photo: for each render edge pixel inside `mask`, the distance to the
 * nearest photo edge pixel (photo edges inside `mask` only); median / p75, distances capped at `capPx`.
 */
export function edgeResidualPx(renderLum: Float32Array, photoLum: Float32Array, W: number, H: number, mask: Uint8Array, capPx = 20): { renderEdgePixels: number; medianPx: number | null; p75Px: number | null } {
    const er = edgeMap(renderLum, W, H, mask), ep = edgeMap(photoLum, W, H, mask);
    const dt = exactDistanceTransform(ep, W, H);
    const d: number[] = [];
    for (let i = 0; i < W * H; i++) if (er[i]) d.push(Math.min(capPx, dt[i]));
    if (!d.length) return { renderEdgePixels: 0, medianPx: null, p75Px: null };
    d.sort((a, b) => a - b);
    return { renderEdgePixels: d.length, medianPx: d[d.length >> 1], p75Px: d[Math.floor(0.75 * (d.length - 1))] };
}
