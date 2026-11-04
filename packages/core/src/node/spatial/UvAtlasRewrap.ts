/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * UV unwrap and texture rewrap of a GLB (AlgorithmicUvEngine modes 'unwrap' and 'rewrap').
 *
 * One atlas per material (primitives without a material form one atlas). For each atlas:
 * - unwrap: the native unwrapper (scratchbox_uv_rewrap.hpp via scripts/uv_rewrap.cpp, built with clang++ on first use,
 *   run through a pipe) clusters charts, measures their distortion, re-parameterizes the ones the orthographic
 *   projection distorts with LSCM, splits what still fails, and packs the charts with gutters at one texel density.
 * - 'unwrap' writes the new chart UVs as a new TEXCOORD set (TEXCOORD_0 when the primitive had none); the materials'
 *   textures keep sampling their own UV sets, untouched.
 * - 'rewrap' replaces TEXCOORD_0 with the atlas and rebakes every texture the material samples (every textureInfo in
 *   the material, extensions included) into it. Geometry is unchanged, so each atlas texel maps to its own triangle and
 *   barycentrics, then to the old UV (KHR_texture_transform applied), where the old image is sampled bilinearly with
 *   its sampler's wrap modes. Normal maps are converted from the old tangent frame (TANGENT, or tangents built from the
 *   old UVs) to the new one, and TANGENT is rewritten for the new UVs.
 * - With `transferSource`, 'rewrap' bakes from another mesh instead (e.g. the textured scan a remesh came from): the
 *   nearest source surface point (optional distance and normal gates) answers each texel, the source materials'
 *   factors are baked into the texels and the target material's factors are set to 1.
 * - A texture that cannot be rebaked (external uri, undecodable image, sparse or compressed accessors) leaves its whole
 *   atlas untouched (the UVs of a material are shared by all its textures) and is reported with the reason.
 * - Vertices are split only at chart seams; every vertex attribute is copied byte for byte (positions are never
 *   re-rounded). Accessors, textures, images, samplers and buffer views no longer referenced are dropped.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFile } from 'child_process';
import { assembleGlb, gatherElements, nodeWorldMatrices, parseGlbBytes, readAccessor, type Mat4, type ParsedGlb } from '../3d-engine/staged-location/glb-bytes';
import { findUvAtlasRepoRoot } from '../3d-engine/staged-location/texture-uv';
import { decodeImageInMemory } from '../3d-engine/staged-location/tile-texture-transfer';
import { decodeImageToRgba, encodeRgbaToJpeg, readImageDimensions } from '../image-codec-ffmpeg';
import { encodePng } from '../texture-processing';

// =============================================================================
// Public contract
// =============================================================================

export type UvRewrapMode = 'unwrap' | 'rewrap';

export interface UvRewrapOptions {
    /** Normal tolerance (degrees) charts are grown with before distortion splits them (default 60). */
    chartNormalToleranceDeg?: number;
    /** Accepted area-weighted RMS of the angle stretch sigma1 / sigma2 per chart (default 1.25). */
    maxAngleStretch?: number;
    /** Accepted area-weighted RMS of the area ratio max(r, 1/r) per chart (default 1.5). */
    maxAreaDistortion?: number;
    /** Conformal (LSCM) re-parameterization of charts the orthographic projection distorts (default true). */
    conformal?: boolean;
    /** Charts under this share of the atlas's surface area merge into a neighbour when their normals allow (default 0.0005). */
    minChartAreaFraction?: number;
    /** Requested texel density (texels per metre). */
    texelsPerMeter?: number;
    /** Requested atlas size in texels: the largest density that fits is used. */
    atlasSize?: number | [number, number];
    /** With neither texelsPerMeter nor atlasSize: multiplier on the source texture's measured density (default 1). */
    texelDensityScale?: number;
    /** Largest atlas side when the density decides the size (default 8192). */
    maxAtlasSide?: number;
    /** Gutter texels around every chart (default 2). */
    gutterTexels?: number;
    /** 90 degree chart rotations while packing (default true). */
    allowRotation?: boolean;
    /** Rebaked colour images: 'source' (default: JPEG where the source image was JPEG, else PNG), 'png' or 'jpeg'. Normal maps are always PNG. */
    outputImageFormat?: 'source' | 'png' | 'jpeg';
    jpegQuality?: number;
    /** 'rewrap' from another mesh (nearest surface) instead of the input's own textures. */
    transferSource?: { glb: Buffer | Uint8Array; maxDistanceM?: number; maxNormalAngleDeg?: number };
    /** Meshes left exactly as they are (reported in primitivesSkipped with this reason). */
    leaveMeshes?: { meshes: number[]; reason: string };
    native?: { binaryPath?: string; repoRoot?: string; timeoutMs?: number; threads?: number };
    signal?: AbortSignal;
}

export interface UvDistortionStats {
    /** Area-weighted RMS and max of sigma1 / sigma2 (1 = conformal). */
    stretchRms: number;
    stretchMax: number;
    /** Area-weighted RMS and max of max(r, 1/r), r = local area scale over its chart's (1 = equiareal). */
    areaRms: number;
    areaMax: number;
    flippedTriangles: number;
}

export interface UvChartReport extends UvDistortionStats {
    method: 'orthographic' | 'lscm';
    primitive: number;
    triangles: number;
    splitDepth: number;
    /** Kept although it fails the thresholds (a single triangle, or no smaller tolerance splits it). */
    overThreshold: boolean;
    lscmIterations: number;
    /** What the orthographic projection of this chart measured (the LSCM charts improved on it). */
    orthographic: UvDistortionStats;
    area3DM2: number;
    widthM: number;
    heightM: number;
    /** Packed rect in texels, gutter included. */
    rect: [number, number, number, number];
    rotated: boolean;
}

export interface UvTexelDensityStats {
    meanTexelsPerMeter: number;
    /** Coefficient of variation (area weighted) of per-triangle density; 0 = perfectly uniform. */
    cv: number;
    p5: number;
    p95: number;
    min: number;
    max: number;
    /** p5 / p95 (1 = uniform). */
    uniformity: number;
}

export interface UvRebakedTexture {
    /** JSON path of the textureInfo(s) in the material, e.g. "pbrMetallicRoughness.baseColorTexture". */
    slots: string[];
    kind: 'color-srgb' | 'linear' | 'tangent-space-normal';
    sourceTexture?: number;
    sourceImage?: number;
    sourceSize?: [number, number];
    outputTexture: number;
    outputImage: number;
    outputSize: [number, number];
    outputBytes: number;
    mimeType: string;
}

export interface UvTextureFailure { slot: string; texture?: number; image?: number; reason: string }

export interface UvAtlasReport {
    material: number | null;
    materialName?: string;
    status: 'unwrapped' | 'rewrapped' | 'skipped';
    /** Why the atlas was skipped (left as it was). */
    skippedReason?: string;
    primitives: number;
    triangles: number;
    verticesIn: number;
    verticesOut: number;
    width: number;
    height: number;
    texelsPerMeter: number;
    densitySource: 'requested-density' | 'requested-atlas-size' | 'source-texture-density' | 'default-atlas-size';
    texCoordWritten?: string;
    charts: number;
    lscmCharts: number;
    orthographicCharts: number;
    lscmAttempts: number;
    splits: number;
    chartsOverThreshold: number;
    distortion: UvDistortionStats;
    /** Distortion the orthographic projection of the same charts would have had. */
    orthographicDistortion: UvDistortionStats;
    texelDensity: UvTexelDensityStats;
    /** UV triangle area / atlas area. */
    utilisation: number;
    overlappingTrianglePairs: number;
    chartDetails: UvChartReport[];
    textures: UvRebakedTexture[];
    failures: UvTextureFailure[];
    bake?: { interiorTexels: number; edgeTexels: number; dilatedTexels: number; emptyTexels: number; unresolvedTexels: number; meanTransferDistanceM?: number; maxTransferDistanceM?: number; ms: number };
    timings: { unwrapMs: number; chartsMs: number; packMs: number; decodeMs: number; bakeMs: number; encodeMs: number };
}

export interface UvRewrapReport {
    mode: UvRewrapMode;
    atlases: UvAtlasReport[];
    charts: number;
    lscmCharts: number;
    distortion: UvDistortionStats;
    orthographicDistortion: UvDistortionStats;
    texelDensity: UvTexelDensityStats;
    utilisation: number;
    overlappingTrianglePairs: number;
    texturesRebaked: UvRebakedTexture[];
    texturesFailed: UvTextureFailure[];
    /** Primitives left untouched (not triangles, compressed, ...), with the reason. */
    primitivesSkipped: Array<{ mesh: number; primitive: number; reason: string }>;
    /** Meshes drawn by several nodes: measured with the first node's transform. */
    instancedMeshes: number[];
    transfer?: { sourceTriangles: number; sourceMaterials: number };
    native: { binary: string; built: boolean };
    totalMs: number;
}

export interface UvRewrapResult { glb: Buffer; report: UvRewrapReport }

// =============================================================================
// Native binary
// =============================================================================

const CLI_SOURCE = path.join('scripts', 'uv_rewrap.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const HEADERS = ['scratchbox_uv_rewrap.hpp', 'scratchbox_uv_atlas.hpp'].map(h => path.join(INCLUDE_DIR, h));
const BINARY = path.join('build', '3d-native', 'uv_rewrap');

const building = new Map<string, Promise<{ path: string; built: boolean }>>();

/** Builds build/3d-native/uv_rewrap when missing or older than its source or headers (atomic rename). */
export function ensureUvRewrapBinary(repoRoot = findUvAtlasRepoRoot()): Promise<{ path: string; built: boolean }> {
    const bin = path.join(repoRoot, BINARY);
    const pending = building.get(bin);
    if (pending) return pending;
    const job = (async () => {
        const deps = [path.join(repoRoot, CLI_SOURCE), ...HEADERS.map(h => path.join(repoRoot, h))];
        const binTime = fs.existsSync(bin) ? fs.statSync(bin).mtimeMs : -1;
        if (binTime >= 0 && deps.every(d => fs.existsSync(d) && fs.statSync(d).mtimeMs <= binTime)) return { path: bin, built: false };
        fs.mkdirSync(path.dirname(bin), { recursive: true });
        const tmp = `${bin}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        const args = ['-std=c++20', '-O3'];
        if (process.env.SCRATCHBOX_NATIVE_ARCH === '1') args.push('-march=native');
        args.push('-I', path.join(repoRoot, INCLUDE_DIR), deps[0], '-o', tmp, '-pthread');
        await new Promise<void>((resolve, reject) => {
            execFile(process.env.CXX || 'clang++', args, { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 }, (err, _out, stderr) => {
                if (err) { fs.rmSync(tmp, { force: true }); reject(new Error(`could not build the UV rewrap engine: ${String(stderr || err.message).slice(-1500)}`)); } else resolve();
            });
        });
        fs.renameSync(tmp, bin);
        return { path: bin, built: true };
    })().finally(() => building.delete(bin));
    building.set(bin, job);
    return job;
}

function runNative(binary: string, request: Buffer[], timeoutMs: number, signal?: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const proc = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const chunks: Buffer[] = [];
        let err = '';
        const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`the UV rewrap engine timed out after ${timeoutMs} ms`)); }, timeoutMs);
        const onAbort = () => { clearTimeout(timer); proc.kill('SIGKILL'); reject(signal!.reason instanceof Error ? signal!.reason : Object.assign(new Error('the UV rewrap engine was stopped'), { name: 'AbortError' })); };
        if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
        proc.on('close', () => signal?.removeEventListener('abort', onAbort));
        proc.stdout.on('data', (c: Buffer) => chunks.push(c));
        proc.stderr.on('data', (c: Buffer) => { err += c.toString(); });
        proc.on('error', e => { clearTimeout(timer); reject(e); });
        proc.on('close', code => {
            clearTimeout(timer);
            if (code !== 0) reject(new Error(`the UV rewrap engine exited ${code}: ${err.trim().slice(-800)}`));
            else resolve(Buffer.concat(chunks));
        });
        proc.stdin.on('error', () => { /* reported through close */ });
        for (const b of request) proc.stdin.write(b);
        proc.stdin.end();
    });
}

const u32 = (...v: number[]) => { const b = Buffer.alloc(v.length * 4); v.forEach((x, i) => b.writeUInt32LE(x >>> 0, i * 4)); return b; };
const i32 = (v: number) => { const b = Buffer.alloc(4); b.writeInt32LE(v, 0); return b; };
const f64 = (...v: number[]) => { const b = Buffer.alloc(v.length * 8); v.forEach((x, i) => b.writeDoubleLE(x, i * 8)); return b; };
const f32 = (...v: number[]) => { const b = Buffer.alloc(v.length * 4); v.forEach((x, i) => b.writeFloatLE(x, i * 4)); return b; };
const view = (a: Float32Array | Uint32Array | Uint8Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

class Reader {
    o = 0;
    constructor(private readonly b: Buffer, what: string, magic: string) {
        if (b.length < 4 || b.toString('latin1', 0, 4) !== magic) throw new Error(`the UV rewrap engine returned no ${magic} reply for ${what}`);
        this.o = 4;
    }
    private need(n: number) { if (this.o + n > this.b.length) throw new Error('the UV rewrap engine reply is truncated'); }
    u32(): number { this.need(4); const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
    u64(): number { this.need(8); const v = Number(this.b.readBigUInt64LE(this.o)); this.o += 8; return v; }
    f64(): number { this.need(8); const v = this.b.readDoubleLE(this.o); this.o += 8; return v; }
    take<A extends Uint32Array | Float32Array | Float64Array | Uint8Array>(Ctor: { new(b: ArrayBuffer): A; BYTES_PER_ELEMENT: number }, n: number): A {
        const bytes = n * Ctor.BYTES_PER_ELEMENT;
        this.need(bytes);
        const a = new Ctor(this.b.buffer.slice(this.b.byteOffset + this.o, this.b.byteOffset + this.o + bytes) as ArrayBuffer);
        this.o += bytes;
        return a;
    }
}

interface NativeUnwrap {
    sourceVertex: Uint32Array; uv: Float32Array; indices: Uint32Array; triangleChart: Uint32Array;
    width: number; height: number; lscmAttempts: number; lscmAccepted: number; splits: number;
    texelsPerMeter: number; utilisation: number; overlappingPairs: number; msCharts: number; msPack: number;
    charts: Float64Array; // 24 per chart
}

interface UnwrapParamsNative {
    chartNormalToleranceDeg: number; minIslandAreaM2: number; maxAngleStretch: number; maxAreaDistortion: number;
    conformal: boolean; texelsPerMeter: number; atlasWidth: number; atlasHeight: number; maxSide: number; gutter: number; allowRotation: boolean;
}

async function nativeUnwrap(binary: string, positions: Float32Array, indices: Uint32Array, groups: Uint32Array, p: UnwrapParamsNative, timeoutMs: number, signal?: AbortSignal): Promise<NativeUnwrap> {
    const V = positions.length / 3, T = indices.length / 3;
    const out = await runNative(binary, [
        Buffer.from('SBUW', 'latin1'), u32(1, V, T),
        f64(p.chartNormalToleranceDeg, p.minIslandAreaM2, p.maxAngleStretch, p.maxAreaDistortion, 0.6, 1.0, p.conformal ? 1 : 0, 4000, 1e-9,
            p.texelsPerMeter, p.atlasWidth, p.atlasHeight, p.maxSide, p.gutter, p.allowRotation ? 1 : 0),
        view(positions), view(indices), view(groups)
    ], timeoutMs, signal);
    const r = new Reader(out, 'unwrap', 'SBUO');
    if (r.u32() !== 1) throw new Error('unsupported SBUO version');
    const outV = r.u32(), t = r.u32(), C = r.u32(), width = r.u32(), height = r.u32(), lscmAttempts = r.u32(), lscmAccepted = r.u32(), splits = r.u32();
    if (t !== T) throw new Error(`the UV rewrap engine returned ${t} triangles for ${T}`);
    const texelsPerMeter = r.f64(); r.f64(); const utilisation = r.f64(), overlappingPairs = r.f64(), msCharts = r.f64(), msPack = r.f64();
    return {
        sourceVertex: r.take(Uint32Array, outV), uv: r.take(Float32Array, outV * 2), indices: r.take(Uint32Array, T * 3), triangleChart: r.take(Uint32Array, T),
        charts: r.take(Float64Array, C * 24),
        width, height, lscmAttempts, lscmAccepted, splits, texelsPerMeter, utilisation, overlappingPairs, msCharts, msPack
    };
}

const SLOT_KIND = { linear: 0, srgb: 1, normal: 2 } as const;

interface BakeRequest {
    width: number; height: number; gutter: number; transfer: boolean; threads: number;
    maxDistance: number; maxNormalAngleDeg: number;
    slotKinds: number[];
    target: { uvPx: Float32Array; pos: Float32Array; nrm?: Float32Array; tan?: Float32Array; idx: Uint32Array };
    /** Same-mesh: per target vertex. Transfer: the source mesh. */
    source: { pos?: Float32Array; nrm?: Float32Array; tan?: Float32Array; uv: Float32Array; idx?: Uint32Array; triMaterial: Uint32Array };
    materials: Array<Array<{ image: number; wrapS: number; wrapT: number; factor: [number, number, number, number] }>>;
    images: Array<{ width: number; height: number; rgba: Uint8Array }>;
}

interface BakeReply {
    slots: Uint8Array[]; interior: number; edge: number; dilated: number; empty: number; unresolved: number;
    meanDistance: number; maxDistance: number; ms: number;
}

async function nativeBake(binary: string, q: BakeRequest, timeoutMs: number, signal?: AbortSignal): Promise<BakeReply> {
    const S = q.slotKinds.length;
    const parts: Buffer[] = [
        Buffer.from('SBRB', 'latin1'),
        u32(1, q.width, q.height, q.gutter, q.transfer ? 1 : 0, S, q.materials.length, q.images.length, q.threads),
        f64(1.5, q.maxDistance, q.maxNormalAngleDeg),
        u32(...q.slotKinds)
    ];
    const Vt = q.target.pos.length / 3, Tt = q.target.idx.length / 3;
    parts.push(u32(Vt, Tt, q.target.nrm ? 1 : 0, q.target.tan ? 1 : 0), view(q.target.uvPx), view(q.target.pos));
    if (q.target.nrm) parts.push(view(q.target.nrm));
    if (q.target.tan) parts.push(view(q.target.tan));
    parts.push(view(q.target.idx));
    if (q.transfer) {
        const s = q.source;
        parts.push(u32(s.pos!.length / 3, s.idx!.length / 3, s.nrm ? 1 : 0, s.tan ? 1 : 0), view(s.pos!));
        if (s.nrm) parts.push(view(s.nrm));
        if (s.tan) parts.push(view(s.tan));
        parts.push(view(s.uv), view(s.idx!), view(s.triMaterial));
    } else {
        parts.push(u32(q.source.tan ? 1 : 0));
        if (q.source.tan) parts.push(view(q.source.tan));
        parts.push(view(q.source.uv), view(q.source.triMaterial));
    }
    for (const m of q.materials) for (const s of m) parts.push(i32(s.image), u32(s.wrapS, s.wrapT), f32(...s.factor));
    for (const im of q.images) parts.push(u32(im.width, im.height), view(im.rgba));
    const out = await runNative(binary, parts, timeoutMs, signal);
    const r = new Reader(out, 'bake', 'SBRO');
    if (r.u32() !== 1) throw new Error('unsupported SBRO version');
    const s = r.u32(), W = r.u32(), H = r.u32();
    if (s !== S || W !== q.width || H !== q.height) throw new Error('the UV rewrap engine baked a different atlas than requested');
    const interior = r.u64(), edge = r.u64(), dilated = r.u64(), empty = r.u64(), unresolved = r.u64();
    const meanDistance = r.f64(), maxDistance = r.f64(), msRaster = r.f64(), msShade = r.f64(), msDilate = r.f64(), msBvh = r.f64();
    const slots: Uint8Array[] = [];
    for (let k = 0; k < S; k++) slots.push(r.take(Uint8Array, W * H * 4));
    return { slots, interior, edge, dilated, empty, unresolved, meanDistance, maxDistance, ms: msRaster + msShade + msDilate + msBvh };
}

// =============================================================================
// GLB reading helpers
// =============================================================================

/** Accessor as floats with glTF normalisation applied to normalised integer components. */
function readFloats(glb: ParsedGlb, index: number): { data: Float64Array; comps: number; count: number } {
    const a = glb.json.accessors[index];
    const r = readAccessor(glb, index);
    if (a.normalized) {
        const scale = ({ 5121: 255, 5123: 65535, 5120: 127, 5122: 32767 } as Record<number, number>)[a.componentType];
        if (scale) for (let i = 0; i < r.data.length; i++) r.data[i] = Math.max(r.data[i] / scale, -1);
    }
    return r;
}

const sub3 = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a: number[]) => Math.hypot(a[0], a[1], a[2]);

function xform(m: Mat4, x: number, y: number, z: number, w: number): [number, number, number] {
    return [m[0] * x + m[4] * y + m[8] * z + m[12] * w, m[1] * x + m[5] * y + m[9] * z + m[13] * w, m[2] * x + m[6] * y + m[10] * z + m[14] * w];
}

/** Inverse-transpose of the upper 3x3 (normals). */
function normalMatrix(m: Mat4): number[] {
    const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
    const det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[3] * (a[1] * a[8] - a[2] * a[7]) + a[6] * (a[1] * a[5] - a[2] * a[4]);
    const id = Math.abs(det) > 1e-30 ? 1 / det : 0;
    // columns of the inverse transpose
    return [
        (a[4] * a[8] - a[5] * a[7]) * id, (a[5] * a[6] - a[3] * a[8]) * id, (a[3] * a[7] - a[4] * a[6]) * id,
        (a[2] * a[7] - a[1] * a[8]) * id, (a[0] * a[8] - a[2] * a[6]) * id, (a[1] * a[6] - a[0] * a[7]) * id,
        (a[1] * a[5] - a[2] * a[4]) * id, (a[2] * a[3] - a[0] * a[5]) * id, (a[0] * a[4] - a[1] * a[3]) * id
    ];
}

/** Triangle-list indices of a primitive (strips and fans converted); undefined for non-surface modes. */
function triangleIndices(glb: ParsedGlb, prim: any, vertexCount: number): Uint32Array | undefined {
    const mode = prim.mode ?? 4;
    const raw = prim.indices !== undefined ? Uint32Array.from(readAccessor(glb, prim.indices).data) : Uint32Array.from({ length: vertexCount }, (_, i) => i);
    if (mode === 4) return raw.subarray(0, raw.length - (raw.length % 3));
    if (mode === 5) {
        const out: number[] = [];
        for (let i = 0; i + 2 < raw.length; i++) {
            const [a, b, c] = i % 2 === 0 ? [raw[i], raw[i + 1], raw[i + 2]] : [raw[i + 1], raw[i], raw[i + 2]];
            if (a !== b && b !== c && a !== c) out.push(a, b, c);
        }
        return Uint32Array.from(out);
    }
    if (mode === 6) {
        const out: number[] = [];
        for (let i = 1; i + 1 < raw.length; i++) out.push(raw[0], raw[i], raw[i + 1]);
        return Uint32Array.from(out);
    }
    return undefined;
}

/**
 * Per-vertex tangents (xyz, w) for a UV set, glTF convention: xyz along +u, bitangent = cross(N, T) * w along -v (the
 * image's up, which the normal map's +Y means). Triangle directions are area weighted; T is Gram-Schmidt'd on N.
 */
export function computeTangents(pos: ArrayLike<number>, nrm: ArrayLike<number> | undefined, uv: ArrayLike<number>, idx: ArrayLike<number>, vertexCount: number): Float32Array {
    const tAcc = new Float64Array(vertexCount * 3), bAcc = new Float64Array(vertexCount * 3), nAcc = new Float64Array(vertexCount * 3);
    for (let t = 0; t + 2 < idx.length; t += 3) {
        const i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2];
        const p0 = [pos[i0 * 3], pos[i0 * 3 + 1], pos[i0 * 3 + 2]], p1 = [pos[i1 * 3], pos[i1 * 3 + 1], pos[i1 * 3 + 2]], p2 = [pos[i2 * 3], pos[i2 * 3 + 1], pos[i2 * 3 + 2]];
        const e1 = sub3(p1, p0), e2 = sub3(p2, p0);
        const fn = cross3(e1, e2);
        const area = 0.5 * len3(fn);
        if (!(area > 0)) continue;
        const du1 = uv[i1 * 2] - uv[i0 * 2], dv1 = uv[i1 * 2 + 1] - uv[i0 * 2 + 1], du2 = uv[i2 * 2] - uv[i0 * 2], dv2 = uv[i2 * 2 + 1] - uv[i0 * 2 + 1];
        const r = du1 * dv2 - du2 * dv1;
        for (const v of [i0, i1, i2]) for (let k = 0; k < 3; k++) nAcc[v * 3 + k] += fn[k];
        if (Math.abs(r) < 1e-20) continue;
        const sdir = [(e1[0] * dv2 - e2[0] * dv1) / r, (e1[1] * dv2 - e2[1] * dv1) / r, (e1[2] * dv2 - e2[2] * dv1) / r];
        const tdir = [(e2[0] * du1 - e1[0] * du2) / r, (e2[1] * du1 - e1[1] * du2) / r, (e2[2] * du1 - e1[2] * du2) / r];
        const ls = len3(sdir) || 1, lt = len3(tdir) || 1;
        for (const v of [i0, i1, i2]) for (let k = 0; k < 3; k++) { tAcc[v * 3 + k] += sdir[k] / ls * area; bAcc[v * 3 + k] += tdir[k] / lt * area; }
    }
    const out = new Float32Array(vertexCount * 4);
    for (let v = 0; v < vertexCount; v++) {
        let n = nrm ? [nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]] : [nAcc[v * 3], nAcc[v * 3 + 1], nAcc[v * 3 + 2]];
        const ln = len3(n);
        n = ln > 0 ? n.map(x => x / ln) : [0, 0, 1];
        const tt = [tAcc[v * 3], tAcc[v * 3 + 1], tAcc[v * 3 + 2]];
        const d = dot3(tt, n);
        let tv = [tt[0] - n[0] * d, tt[1] - n[1] * d, tt[2] - n[2] * d];
        let lt = len3(tv);
        if (!(lt > 1e-12)) { tv = cross3(Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], n); lt = len3(tv); }
        tv = tv.map(x => x / lt);
        const b = [bAcc[v * 3], bAcc[v * 3 + 1], bAcc[v * 3 + 2]];
        // the normal map's +Y is the image's up, which is -v in glTF UV space
        const w = dot3(cross3(n, tv), b) > 0 ? -1 : 1;
        out[v * 4] = tv[0]; out[v * 4 + 1] = tv[1]; out[v * 4 + 2] = tv[2]; out[v * 4 + 3] = w;
    }
    return out;
}

/** KHR_texture_transform of a textureInfo applied to a UV array (in place); returns the texCoord set it reads. */
function textureTransform(info: any): { texCoord: number; apply?: (u: number, v: number) => [number, number] } {
    const tt = info?.extensions?.KHR_texture_transform;
    const texCoord = (tt && typeof tt.texCoord === 'number') ? tt.texCoord : (info?.texCoord ?? 0);
    if (!tt) return { texCoord };
    const [ox, oy] = tt.offset ?? [0, 0], rot = tt.rotation ?? 0, [sx, sy] = tt.scale ?? [1, 1];
    const c = Math.cos(rot), s = Math.sin(rot);
    return { texCoord, apply: (u, v) => [c * sx * u + s * sy * v + ox, -s * sx * u + c * sy * v + oy] };
}

export interface SlotRef { path: string; holder: any; key: string; info: any }

/** Every textureInfo of a material (objects with a numeric `index` under a key ending in "Texture"), extensions included. */
export function materialSlots(material: any): SlotRef[] {
    const out: SlotRef[] = [];
    const walk = (obj: any, prefix: string) => {
        if (!obj || typeof obj !== 'object') return;
        for (const key of Object.keys(obj)) {
            const v = obj[key];
            if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
            const p = prefix ? `${prefix}.${key}` : key;
            if (/texture$/i.test(key) && typeof v.index === 'number') out.push({ path: p, holder: obj, key, info: v });
            else walk(v, p);
        }
    };
    walk(material, '');
    return out;
}

/** Tangent-space normal slots are the textureInfos named for normals (core normalTexture, clearcoatNormalTexture, ...). */
const isNormalSlot = (key: string) => /normaltexture$/i.test(key);

/**
 * The factor a texture slot is multiplied by, read structurally: `<name>Factor` next to `<name>Texture` (vector = colour,
 * sRGB texture; scalar = one linear channel), and the metallic / roughness pair for metallicRoughnessTexture.
 */
function slotFactor(ref: SlotRef): { factor: [number, number, number, number]; srgb: boolean; reset: () => void } {
    const base = ref.key.replace(/Texture$/i, '');
    const fk = `${base}Factor`;
    const h = ref.holder;
    const v = h[fk];
    if (Array.isArray(v) && v.length >= 3) {
        return { factor: [v[0], v[1], v[2], v.length > 3 ? v[3] : 1], srgb: true, reset: () => { h[fk] = v.length > 3 ? [1, 1, 1, 1] : [1, 1, 1]; } };
    }
    if (typeof v === 'number') return { factor: [v, 1, 1, 1], srgb: false, reset: () => { h[fk] = 1; } };
    if (ref.key === 'metallicRoughnessTexture') {
        const m = typeof h.metallicFactor === 'number' ? h.metallicFactor : 1, r = typeof h.roughnessFactor === 'number' ? h.roughnessFactor : 1;
        return { factor: [1, r, m, 1], srgb: false, reset: () => { h.metallicFactor = 1; h.roughnessFactor = 1; } };
    }
    // no factor: the default factor is 1, and resampling at factor 1 is the same in sRGB and linear
    return { factor: [1, 1, 1, 1], srgb: false, reset: () => undefined };
}

export function imageOfTexture(json: any, textureIndex: number): number | undefined {
    const tex = json.textures?.[textureIndex];
    if (!tex) return undefined;
    if (typeof tex.source === 'number') return tex.source;
    for (const ext of Object.values(tex.extensions ?? {}) as any[]) if (ext && typeof ext.source === 'number') return ext.source;
    return undefined;
}

// =============================================================================
// GLB writer with compaction
// =============================================================================

/** A copy of a GLB's JSON to edit, new binary data appended to it, and `finish` to write it compacted. */
export class GlbWriter {
    readonly json: any;
    private readonly newViews = new Map<number, Uint8Array>();
    constructor(private readonly src: ParsedGlb) {
        this.json = JSON.parse(JSON.stringify(src.json));
        this.json.accessors ??= [];
        this.json.bufferViews ??= [];
    }
    addView(bytes: Uint8Array, target?: number): number {
        const i = this.json.bufferViews.length;
        this.json.bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
        this.newViews.set(i, bytes);
        return i;
    }
    addAccessor(bytes: Uint8Array, componentType: number, type: string, count: number, extra: Record<string, unknown> = {}, target?: number): number {
        const bv = this.addView(bytes, target);
        this.json.accessors.push({ bufferView: bv, componentType, type, count, ...extra });
        return this.json.accessors.length - 1;
    }
    addImage(bytes: Uint8Array, mimeType: string, name?: string): number {
        const bv = this.addView(bytes);
        this.json.images ??= [];
        this.json.images.push({ bufferView: bv, mimeType, ...(name ? { name } : {}) });
        return this.json.images.length - 1;
    }

    /** Drops what nothing references any more and repacks the binary chunk. */
    finish(): Buffer {
        const j = this.json;
        // accessors
        const accRefs = new Set<number>();
        for (const m of j.meshes ?? []) for (const p of m.primitives ?? []) {
            for (const a of Object.values(p.attributes ?? {})) accRefs.add(a as number);
            if (p.indices !== undefined) accRefs.add(p.indices);
            for (const t of p.targets ?? []) for (const a of Object.values(t)) accRefs.add(a as number);
        }
        for (const s of j.skins ?? []) if (s.inverseBindMatrices !== undefined) accRefs.add(s.inverseBindMatrices);
        for (const an of j.animations ?? []) for (const s of an.samplers ?? []) { accRefs.add(s.input); accRefs.add(s.output); }
        for (const n of j.nodes ?? []) for (const a of Object.values(n.extensions?.EXT_mesh_gpu_instancing?.attributes ?? {})) accRefs.add(a as number);
        const accMap = new Map<number, number>();
        const accessors: any[] = [];
        (j.accessors as any[]).forEach((a, i) => { if (accRefs.has(i)) { accMap.set(i, accessors.length); accessors.push(a); } });
        j.accessors = accessors;
        for (const m of j.meshes ?? []) for (const p of m.primitives ?? []) {
            for (const k of Object.keys(p.attributes ?? {})) p.attributes[k] = accMap.get(p.attributes[k]);
            if (p.indices !== undefined) p.indices = accMap.get(p.indices);
            for (const t of p.targets ?? []) for (const k of Object.keys(t)) t[k] = accMap.get(t[k]);
        }
        for (const s of j.skins ?? []) if (s.inverseBindMatrices !== undefined) s.inverseBindMatrices = accMap.get(s.inverseBindMatrices);
        for (const an of j.animations ?? []) for (const s of an.samplers ?? []) { s.input = accMap.get(s.input); s.output = accMap.get(s.output); }
        for (const n of j.nodes ?? []) {
            const at = n.extensions?.EXT_mesh_gpu_instancing?.attributes;
            if (at) for (const k of Object.keys(at)) at[k] = accMap.get(at[k]);
        }
        // textures (referenced from materials), images and samplers (referenced from textures)
        const texRefs = new Set<number>();
        for (const m of j.materials ?? []) for (const s of materialSlots(m)) texRefs.add(s.info.index);
        const texMap = new Map<number, number>();
        const textures: any[] = [];
        ((j.textures ?? []) as any[]).forEach((t, i) => { if (texRefs.has(i)) { texMap.set(i, textures.length); textures.push(t); } });
        for (const m of j.materials ?? []) for (const s of materialSlots(m)) s.info.index = texMap.get(s.info.index);
        const imgRefs = new Set<number>(), smpRefs = new Set<number>();
        for (const t of textures) {
            if (typeof t.source === 'number') imgRefs.add(t.source);
            for (const e of Object.values(t.extensions ?? {}) as any[]) if (e && typeof e.source === 'number') imgRefs.add(e.source);
            if (typeof t.sampler === 'number') smpRefs.add(t.sampler);
        }
        const imgMap = new Map<number, number>(), smpMap = new Map<number, number>();
        const images: any[] = [], samplers: any[] = [];
        ((j.images ?? []) as any[]).forEach((im, i) => { if (imgRefs.has(i)) { imgMap.set(i, images.length); images.push(im); } });
        ((j.samplers ?? []) as any[]).forEach((s, i) => { if (smpRefs.has(i)) { smpMap.set(i, samplers.length); samplers.push(s); } });
        for (const t of textures) {
            if (typeof t.source === 'number') t.source = imgMap.get(t.source);
            for (const e of Object.values(t.extensions ?? {}) as any[]) if (e && typeof e.source === 'number') e.source = imgMap.get(e.source);
            if (typeof t.sampler === 'number') t.sampler = smpMap.get(t.sampler);
        }
        if (j.textures) j.textures = textures;
        if (j.images) j.images = images;
        if (j.samplers) j.samplers = samplers;
        for (const k of ['textures', 'images', 'samplers']) if (Array.isArray(j[k]) && j[k].length === 0) delete j[k];

        // buffer views: every `bufferView` key left anywhere in the document (accessors, sparse, images, extensions)
        const views: any[] = j.bufferViews;
        delete j.bufferViews;
        const viewRefs = new Set<number>();
        const scan = (o: any) => {
            if (!o || typeof o !== 'object') return;
            if (Array.isArray(o)) { for (const x of o) scan(x); return; }
            for (const k of Object.keys(o)) { if (k === 'bufferView' && typeof o[k] === 'number') viewRefs.add(o[k]); else scan(o[k]); }
        };
        scan(j);
        const viewMap = new Map<number, number>();
        const kept: any[] = [];
        const chunks: Uint8Array[] = [];
        let offset = 0;
        views.forEach((v, i) => {
            if (!viewRefs.has(i)) return;
            const bytes = this.newViews.get(i) ?? this.src.bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
            const pad = (8 - (offset % 8)) % 8;
            if (pad) { chunks.push(new Uint8Array(pad)); offset += pad; }
            viewMap.set(i, kept.length);
            kept.push({ ...v, buffer: 0, byteOffset: offset });
            chunks.push(bytes);
            offset += bytes.byteLength;
        });
        const remap = (o: any) => {
            if (!o || typeof o !== 'object') return;
            if (Array.isArray(o)) { for (const x of o) remap(x); return; }
            for (const k of Object.keys(o)) { if (k === 'bufferView' && typeof o[k] === 'number') o[k] = viewMap.get(o[k]); else remap(o[k]); }
        };
        remap(j);
        j.bufferViews = kept;
        const bin = new Uint8Array(offset);
        let o = 0;
        for (const c of chunks) { bin.set(c, o); o += c.byteLength; }
        j.buffers = [{ byteLength: bin.byteLength }];
        if (!kept.length) { delete j.bufferViews; delete j.buffers; }
        return assembleGlb(j, bin);
    }
}

// =============================================================================
// Main
// =============================================================================

interface Prim {
    mesh: number; primitive: number; def: any;
    positions: Float32Array;     // local
    indices: Uint32Array;        // triangle list into local vertices
    world: Mat4;
    vertexCount: number;
}

function emptyStats(): UvDistortionStats { return { stretchRms: 1, stretchMax: 1, areaRms: 1, areaMax: 1, flippedTriangles: 0 }; }

function mergeStats(parts: Array<{ s: UvDistortionStats; w: number }>): UvDistortionStats {
    const W = parts.reduce((a, p) => a + p.w, 0);
    if (!(W > 0)) return emptyStats();
    return {
        stretchRms: Math.sqrt(parts.reduce((a, p) => a + p.w * p.s.stretchRms ** 2, 0) / W),
        stretchMax: Math.max(...parts.map(p => p.s.stretchMax)),
        areaRms: Math.sqrt(parts.reduce((a, p) => a + p.w * p.s.areaRms ** 2, 0) / W),
        areaMax: Math.max(...parts.map(p => p.s.areaMax)),
        flippedTriangles: parts.reduce((a, p) => a + p.s.flippedTriangles, 0)
    };
}

function densityStats(samples: Array<{ d: number; w: number }>): UvTexelDensityStats {
    const s = samples.filter(x => Number.isFinite(x.d) && x.w > 0).sort((a, b) => a.d - b.d);
    const W = s.reduce((a, x) => a + x.w, 0);
    if (!s.length || !(W > 0)) return { meanTexelsPerMeter: 0, cv: 0, p5: 0, p95: 0, min: 0, max: 0, uniformity: 0 };
    const mean = s.reduce((a, x) => a + x.w * x.d, 0) / W;
    const varc = s.reduce((a, x) => a + x.w * (x.d - mean) ** 2, 0) / W;
    const q = (f: number) => { let acc = 0; for (const x of s) { acc += x.w; if (acc >= f * W) return x.d; } return s[s.length - 1].d; };
    const p5 = q(0.05), p95 = q(0.95);
    return { meanTexelsPerMeter: mean, cv: mean > 0 ? Math.sqrt(varc) / mean : 0, p5, p95, min: s[0].d, max: s[s.length - 1].d, uniformity: p95 > 0 ? p5 / p95 : 0 };
}

interface DecodedImage { width: number; height: number; rgba: Uint8Array }

/** Reads the source of a transfer: every textured triangle of the source GLB in world space, with its material slots. */
async function readTransferSource(glb: ParsedGlb, slotPaths: string[], decode: (glb: ParsedGlb, image: number) => Promise<DecodedImage>) {
    const json = glb.json;
    const world = nodeWorldMatrices(json);
    const pos: number[] = [], nrm: number[] = [], tan: number[] = [], idx: number[] = [], triMat: number[] = [];
    const uvs: number[][] = slotPaths.map(() => []);
    const materialKeys = new Map<number, number>();
    const materialSlotsOut: BakeRequest['materials'] = [];
    const images: DecodedImage[] = [];
    const imageIndex = new Map<number, number>();
    const unlit: boolean[] = [];
    let hasNormals = true;
    for (const [nodeIndex, node] of (json.nodes ?? []).entries() as Iterable<[number, any]>) {
        if (node.mesh === undefined) continue;
        const M = world[nodeIndex], NM = normalMatrix(M);
        for (const prim of json.meshes[node.mesh].primitives ?? []) {
            if (prim.attributes?.POSITION === undefined) continue;
            const p = readFloats(glb, prim.attributes.POSITION);
            const tris = triangleIndices(glb, prim, p.count);
            if (!tris || !tris.length) continue;
            const matIndex = prim.material ?? -1;
            const material = matIndex >= 0 ? json.materials[matIndex] : {};
            if (!materialKeys.has(matIndex)) {
                materialKeys.set(matIndex, materialSlotsOut.length);
                unlit.push(!!material.extensions?.KHR_materials_unlit);
                const refs = materialSlots(material);
                const row: BakeRequest['materials'][number] = [];
                for (const sp of slotPaths) {
                    const ref = refs.find(r => r.path === sp);
                    const factorRef = ref ?? (() => {
                        // the factor of a slot this material has no texture for (e.g. baseColorFactor alone)
                        const parts = sp.split('.');
                        let holder: any = material;
                        for (const k of parts.slice(0, -1)) holder = holder?.[k];
                        return holder ? { path: sp, holder, key: parts[parts.length - 1], info: {} } as SlotRef : undefined;
                    })();
                    const f = factorRef ? slotFactor(factorRef) : { factor: [1, 1, 1, 1] as [number, number, number, number] };
                    let image = -1, wrapS = 10497, wrapT = 10497;
                    if (ref) {
                        const src = imageOfTexture(json, ref.info.index);
                        if (src !== undefined) {
                            if (!imageIndex.has(src)) { imageIndex.set(src, images.length); images.push(await decode(glb, src)); }
                            image = imageIndex.get(src)!;
                            const smp = json.samplers?.[json.textures[ref.info.index].sampler];
                            wrapS = smp?.wrapS ?? 10497; wrapT = smp?.wrapT ?? 10497;
                        }
                    }
                    row.push({ image, wrapS, wrapT, factor: f.factor });
                }
                materialSlotsOut.push(row);
            }
            const mi = materialKeys.get(matIndex)!;
            const base = pos.length / 3;
            const n = prim.attributes.NORMAL !== undefined ? readFloats(glb, prim.attributes.NORMAL) : undefined;
            if (!n) hasNormals = false;
            const t = prim.attributes.TANGENT !== undefined ? readFloats(glb, prim.attributes.TANGENT) : undefined;
            for (let v = 0; v < p.count; v++) {
                pos.push(...xform(M, p.data[v * 3], p.data[v * 3 + 1], p.data[v * 3 + 2], 1));
                if (n) {
                    const x = n.data[v * 3], y = n.data[v * 3 + 1], z = n.data[v * 3 + 2];
                    const w = [NM[0] * x + NM[3] * y + NM[6] * z, NM[1] * x + NM[4] * y + NM[7] * z, NM[2] * x + NM[5] * y + NM[8] * z];
                    const l = len3(w) || 1;
                    nrm.push(w[0] / l, w[1] / l, w[2] / l);
                } else nrm.push(0, 0, 0);
            }
            // per-slot UVs (transform applied) for this primitive
            const refs = materialSlots(material);
            let normalUv: Float64Array | undefined;
            slotPaths.forEach((sp, s) => {
                const ref = refs.find(r => r.path === sp);
                const tr = ref ? textureTransform(ref.info) : { texCoord: 0 };
                const acc = prim.attributes[`TEXCOORD_${tr.texCoord}`];
                const data = acc !== undefined && ref ? readFloats(glb, acc).data : undefined;
                for (let v = 0; v < p.count; v++) {
                    let u = data ? data[v * 2] : 0, w = data ? data[v * 2 + 1] : 0;
                    if (data && tr.apply) [u, w] = tr.apply(u, w);
                    uvs[s].push(u, w);
                }
                if (ref && isNormalSlot(ref.key) && data) normalUv = Float64Array.from(uvs[s].slice(base * 2));
            });
            // source tangents in world space
            const localTan = t ? Float32Array.from(t.data) : (normalUv ? computeTangents(p.data, n?.data, normalUv, tris, p.count) : undefined);
            for (let v = 0; v < p.count; v++) {
                if (localTan) {
                    const d = xform(M, localTan[v * 4], localTan[v * 4 + 1], localTan[v * 4 + 2], 0);
                    const l = len3(d) || 1;
                    tan.push(d[0] / l, d[1] / l, d[2] / l, localTan[v * 4 + 3] < 0 ? -1 : 1);
                } else tan.push(0, 0, 0, 1);
            }
            for (const i of tris) idx.push(i + base);
            for (let k = 0; k < tris.length / 3; k++) triMat.push(mi);
        }
    }
    if (!idx.length) throw new Error('the transfer source GLB has no triangles');
    const uvFlat = new Float32Array(slotPaths.length * pos.length / 3 * 2);
    const V = pos.length / 3;
    slotPaths.forEach((_, s) => uvFlat.set(uvs[s], s * V * 2));
    return {
        source: { pos: Float32Array.from(pos), nrm: hasNormals ? Float32Array.from(nrm) : undefined, tan: Float32Array.from(tan), uv: uvFlat, idx: Uint32Array.from(idx), triMaterial: Uint32Array.from(triMat) },
        materials: materialSlotsOut, images, allUnlit: unlit.length > 0 && unlit.every(Boolean), triangles: idx.length / 3
    };
}

/**
 * Unwraps (and for 'rewrap', rebakes the textures of) every triangle primitive of a GLB. See the module comment.
 */
export async function unwrapRewrapGlb(mode: UvRewrapMode, input: Buffer | Uint8Array, options: UvRewrapOptions = {}): Promise<UvRewrapResult> {
    const t0 = performance.now();
    const glb = parseGlbBytes(input instanceof Uint8Array ? input : new Uint8Array(input));
    const json = glb.json;
    for (const b of json.buffers ?? []) if (b.uri !== undefined) throw new Error('the GLB references an external buffer uri; only GLBs with an embedded binary chunk can be rewritten');
    const compressed = (json.extensionsUsed ?? []).filter((e: string) => /draco|meshopt|quantiz/i.test(e));
    const opts = {
        chartNormalToleranceDeg: options.chartNormalToleranceDeg ?? 60,
        maxAngleStretch: options.maxAngleStretch ?? 1.25,
        maxAreaDistortion: options.maxAreaDistortion ?? 1.5,
        conformal: options.conformal ?? true,
        minChartAreaFraction: options.minChartAreaFraction ?? 0.0005,
        maxAtlasSide: Math.max(64, Math.min(16384, options.maxAtlasSide ?? 8192)),
        gutter: Math.max(1, Math.round(options.gutterTexels ?? 2)),
        allowRotation: options.allowRotation ?? true,
        timeoutMs: options.native?.timeoutMs ?? 600_000,
        threads: options.native?.threads ?? 0
    };
    const nativeBin = options.native?.binaryPath ? { path: options.native.binaryPath, built: false } : await ensureUvRewrapBinary(options.native?.repoRoot);
    const world = nodeWorldMatrices(json);

    // first node drawing each mesh
    const meshNode = new Map<number, number>();
    const meshUses = new Map<number, number>();
    (json.nodes ?? []).forEach((n: any, i: number) => {
        if (n.mesh === undefined) return;
        if (!meshNode.has(n.mesh)) meshNode.set(n.mesh, i);
        meshUses.set(n.mesh, (meshUses.get(n.mesh) ?? 0) + 1);
    });
    const identity = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

    const report: UvRewrapReport = {
        mode, atlases: [], charts: 0, lscmCharts: 0, distortion: emptyStats(), orthographicDistortion: emptyStats(),
        texelDensity: densityStats([]), utilisation: 0, overlappingTrianglePairs: 0, texturesRebaked: [], texturesFailed: [],
        primitivesSkipped: [], instancedMeshes: [...meshUses.entries()].filter(([, n]) => n > 1).map(([m]) => m),
        native: { binary: nativeBin.path, built: nativeBin.built }, totalMs: 0
    };

    // primitives by material
    const atlases = new Map<number, Prim[]>();
    const left = new Set(options.leaveMeshes?.meshes ?? []);
    (json.meshes ?? []).forEach((mesh: any, meshIndex: number) => {
        (mesh.primitives ?? []).forEach((def: any, primitive: number) => {
            const skip = (reason: string) => report.primitivesSkipped.push({ mesh: meshIndex, primitive, reason });
            if (left.has(meshIndex)) return skip(options.leaveMeshes!.reason);
            if (def.attributes?.POSITION === undefined) return skip('no POSITION attribute');
            if (def.extensions && Object.keys(def.extensions).some(k => /draco|meshopt/i.test(k))) return skip(`compressed primitive (${Object.keys(def.extensions).join(', ')}) is not decoded here`);
            if (compressed.length && /quantiz/i.test(compressed.join())) {
                const pa = json.accessors[def.attributes.POSITION];
                if (pa.componentType !== 5126) return skip('quantized POSITION (KHR_mesh_quantization) is not supported');
            }
            const allAcc = [...Object.values(def.attributes ?? {}), ...(def.indices !== undefined ? [def.indices] : []), ...((def.targets ?? []) as any[]).flatMap(t => Object.values(t))] as number[];
            const sparse = allAcc.find(a => json.accessors[a]?.sparse || json.accessors[a]?.bufferView === undefined);
            if (sparse !== undefined) return skip(`accessor ${sparse} is sparse or has no bufferView; its elements cannot be copied per vertex`);
            const pa = json.accessors[def.attributes.POSITION];
            if (pa.componentType !== 5126 || pa.type !== 'VEC3') return skip('POSITION is not float32 VEC3');
            const positions = Float32Array.from(readAccessor(glb, def.attributes.POSITION).data);
            const vertexCount = positions.length / 3;
            const indices = triangleIndices(glb, def, vertexCount);
            if (!indices) return skip(`mode ${def.mode} has no surface to unwrap (points or lines)`);
            if (indices.length < 3) return skip('no triangles');
            const nodeIndex = meshNode.get(meshIndex);
            const key = def.material ?? -1;
            if (!atlases.has(key)) atlases.set(key, []);
            atlases.get(key)!.push({ mesh: meshIndex, primitive, def, positions, indices, world: nodeIndex !== undefined ? world[nodeIndex] : identity, vertexCount });
        });
    });
    if (!atlases.size) throw new Error('the GLB has no triangle primitives to unwrap');

    // decoded images (cached per image index)
    const decoded = new Map<string, Promise<DecodedImage>>();
    const decodeImage = (g: ParsedGlb, image: number, tag: string): Promise<DecodedImage> => {
        const key = `${tag}:${image}`;
        let p = decoded.get(key);
        if (!p) {
            p = (async () => {
                const im = g.json.images?.[image];
                if (!im) throw new Error(`image ${image} does not exist`);
                if (im.bufferView === undefined) throw new Error(`image ${image} is not embedded in the GLB (uri images are not read)`);
                const bv = g.json.bufferViews[im.bufferView];
                const bytes = g.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
                // PNG and JPEG in process (no subprocess per image); anything else (WebP) through ffmpeg
                let d: { width: number; height: number; rgba: Uint8Array };
                try { d = decodeImageInMemory(bytes); } catch { d = await decodeImageToRgba(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)); }
                if (d.rgba.length !== d.width * d.height * 4) throw new Error(`decoder returned ${d.rgba.length} bytes for ${d.width}x${d.height}`);
                return { width: d.width, height: d.height, rgba: new Uint8Array(d.rgba.buffer, d.rgba.byteOffset, d.rgba.byteLength) };
            })();
            decoded.set(key, p);
        }
        return p;
    };

    // transfer source (read once): slot paths are the union of the source materials' textureInfos
    let transfer: Awaited<ReturnType<typeof readTransferSource>> | undefined;
    let transferSlots: string[] = [];
    let transferSlotKinds: number[] = [];
    if (mode === 'rewrap' && options.transferSource) {
        const transferGlb = parseGlbBytes(options.transferSource.glb instanceof Uint8Array ? options.transferSource.glb : new Uint8Array(options.transferSource.glb));
        const paths = new Map<string, number>();
        for (const m of transferGlb.json.materials ?? []) for (const r of materialSlots(m)) {
            if (paths.has(r.path)) continue;
            paths.set(r.path, isNormalSlot(r.key) ? SLOT_KIND.normal : slotFactor(r).srgb ? SLOT_KIND.srgb : SLOT_KIND.linear);
        }
        transferSlots = [...paths.keys()];
        transferSlotKinds = [...paths.values()];
        if (!transferSlots.length) throw new Error('the transfer source GLB has no textured material to bake from');
        transfer = await readTransferSource(transferGlb, transferSlots, (g, i) => decodeImage(g, i, 'transfer'));
        report.transfer = { sourceTriangles: transfer.triangles, sourceMaterials: transfer.materials.length };
    }

    const writer = new GlbWriter(glb);
    const out = writer.json;
    let clampSampler: number | undefined;
    const densityAll: Array<{ d: number; w: number }> = [];
    let uvAreaAll = 0, atlasAreaAll = 0;

    for (const [materialKey, prims] of atlases) {
        const material = materialKey >= 0 ? json.materials?.[materialKey] : undefined;
        const at: UvAtlasReport = {
            material: materialKey >= 0 ? materialKey : null, ...(material?.name ? { materialName: material.name } : {}),
            status: 'skipped', primitives: prims.length, triangles: prims.reduce((a, p) => a + p.indices.length / 3, 0),
            verticesIn: prims.reduce((a, p) => a + p.vertexCount, 0), verticesOut: 0, width: 0, height: 0, texelsPerMeter: 0,
            densitySource: 'default-atlas-size', charts: 0, lscmCharts: 0, orthographicCharts: 0, lscmAttempts: 0, splits: 0, chartsOverThreshold: 0,
            distortion: emptyStats(), orthographicDistortion: emptyStats(), texelDensity: densityStats([]), utilisation: 0, overlappingTrianglePairs: 0,
            chartDetails: [], textures: [], failures: [], timings: { unwrapMs: 0, chartsMs: 0, packMs: 0, decodeMs: 0, bakeMs: 0, encodeMs: 0 }
        };
        report.atlases.push(at);
        const slots = mode === 'rewrap' && !transfer && material ? materialSlots(material) : [];
        if (transfer && material) {
            // a target texture the source has no slot for would keep sampling UVs that no longer exist
            const orphan = materialSlots(material).filter(r => !transferSlots.includes(r.path));
            if (orphan.length) {
                for (const r of orphan) at.failures.push({ slot: r.path, texture: r.info.index, reason: 'the transfer source has no texture for this slot, so it cannot be baked into the new UVs' });
                at.skippedReason = 'a texture of this material has no counterpart in the transfer source, so its UVs were left unchanged';
                report.texturesFailed.push(...at.failures);
                continue;
            }
        }

        // world-space geometry of the atlas
        const nv = prims.reduce((a, p) => a + p.vertexCount, 0), nt = at.triangles;
        const wpos = new Float32Array(nv * 3), widx = new Uint32Array(nt * 3), groups = new Uint32Array(nt);
        const vOff: number[] = [], tOff: number[] = [];
        let ov = 0, ot = 0, area3D = 0;
        prims.forEach((p, g) => {
            vOff.push(ov); tOff.push(ot);
            for (let v = 0; v < p.vertexCount; v++) wpos.set(xform(p.world, p.positions[v * 3], p.positions[v * 3 + 1], p.positions[v * 3 + 2], 1), (ov + v) * 3);
            for (let k = 0; k < p.indices.length; k++) widx[ot * 3 + k] = p.indices[k] + ov;
            groups.fill(g, ot, ot + p.indices.length / 3);
            ov += p.vertexCount; ot += p.indices.length / 3;
        });
        const triArea3D = new Float64Array(nt);
        for (let t = 0; t < nt; t++) {
            const a = [wpos[widx[t * 3] * 3], wpos[widx[t * 3] * 3 + 1], wpos[widx[t * 3] * 3 + 2]];
            const b = [wpos[widx[t * 3 + 1] * 3], wpos[widx[t * 3 + 1] * 3 + 1], wpos[widx[t * 3 + 1] * 3 + 2]];
            const c = [wpos[widx[t * 3 + 2] * 3], wpos[widx[t * 3 + 2] * 3 + 1], wpos[widx[t * 3 + 2] * 3 + 2]];
            triArea3D[t] = 0.5 * len3(cross3(sub3(b, a), sub3(c, a)));
            area3D += triArea3D[t];
        }

        // old UVs per slot (rewrap of the input's own textures): check every slot can be rebaked before anything moves
        interface SlotJob { refs: SlotRef[]; kind: number; texture: number; image: number; texCoord: number; apply?: (u: number, v: number) => [number, number]; wrapS: number; wrapT: number; img?: DecodedImage }
        const jobs: SlotJob[] = [];
        if (slots.length) {
            const td = performance.now();
            const byKey = new Map<string, SlotJob>();
            for (const ref of slots) {
                const tr = textureTransform(ref.info);
                const kind = isNormalSlot(ref.key) ? SLOT_KIND.normal : slotFactor(ref).srgb ? SLOT_KIND.srgb : SLOT_KIND.linear;
                const key = `${ref.info.index}|${tr.texCoord}|${JSON.stringify(ref.info.extensions?.KHR_texture_transform ?? null)}|${kind === SLOT_KIND.normal}`;
                const ex = byKey.get(key);
                if (ex) { ex.refs.push(ref); continue; }
                const image = imageOfTexture(json, ref.info.index);
                const fail = (reason: string) => at.failures.push({ slot: ref.path, texture: ref.info.index, ...(image !== undefined ? { image } : {}), reason });
                if (image === undefined) { fail(`texture ${ref.info.index} has no image source`); continue; }
                const missing = prims.find(p => p.def.attributes[`TEXCOORD_${tr.texCoord}`] === undefined);
                if (missing) { fail(`mesh ${missing.mesh} primitive ${missing.primitive} has no TEXCOORD_${tr.texCoord} for this texture`); continue; }
                const smp = json.samplers?.[json.textures[ref.info.index].sampler];
                const job: SlotJob = { refs: [ref], kind, texture: ref.info.index, image, texCoord: tr.texCoord, apply: tr.apply, wrapS: smp?.wrapS ?? 10497, wrapT: smp?.wrapT ?? 10497 };
                try { job.img = await decodeImage(glb, image, 'input'); } catch (e) { fail(`image ${image} could not be decoded: ${(e as Error).message}`); continue; }
                byKey.set(key, job);
                jobs.push(job);
            }
            at.timings.decodeMs = performance.now() - td;
            if (at.failures.length) {
                at.skippedReason = `${at.failures.length} texture slot(s) of this material cannot be rebaked, so its UVs were left unchanged (every texture of a material shares its UVs)`;
                report.texturesFailed.push(...at.failures);
                continue;
            }
        }

        // density: requested, atlas size, the source texture's measured density, or a default atlas
        let texelsPerMeter = 0, atlasW = 0, atlasH = 0;
        const sz = options.atlasSize;
        if (options.texelsPerMeter && options.texelsPerMeter > 0) { texelsPerMeter = options.texelsPerMeter; at.densitySource = 'requested-density'; }
        else if (sz) { [atlasW, atlasH] = Array.isArray(sz) ? sz : [sz, sz]; at.densitySource = 'requested-atlas-size'; }
        else {
            // measured on the input's own textures: the first colour slot (or any slot), old UVs in texels per metre
            let job: { texCoord: number; apply?: (u: number, v: number) => [number, number]; img?: { width: number; height: number } } | undefined = jobs.find(j => j.kind === SLOT_KIND.srgb) ?? jobs[0];
            if (!job && material) {
                // 'unwrap' decodes nothing: the image size comes from its header
                for (const ref of materialSlots(material)) {
                    const image = imageOfTexture(json, ref.info.index);
                    const im = image !== undefined ? json.images?.[image] : undefined;
                    if (!im || im.bufferView === undefined) continue;
                    const bv = json.bufferViews[im.bufferView];
                    const dims = readImageDimensions(glb.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength));
                    const tr = textureTransform(ref.info);
                    if (dims && prims.every(p => p.def.attributes[`TEXCOORD_${tr.texCoord}`] !== undefined)) { job = { texCoord: tr.texCoord, apply: tr.apply, img: dims }; break; }
                }
            }
            let uvPx = 0;
            if (job?.img) {
                prims.forEach(p => {
                    const uv = readFloats(glb, p.def.attributes[`TEXCOORD_${job.texCoord}`]).data;
                    const at2 = (v: number): [number, number] => job.apply ? job.apply(uv[v * 2], uv[v * 2 + 1]) : [uv[v * 2], uv[v * 2 + 1]];
                    for (let k = 0; k < p.indices.length; k += 3) {
                        const [a, b, c] = [at2(p.indices[k]), at2(p.indices[k + 1]), at2(p.indices[k + 2])];
                        uvPx += 0.5 * Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) * job.img!.width * job.img!.height;
                    }
                });
            }
            if (uvPx > 0 && area3D > 0) { texelsPerMeter = Math.sqrt(uvPx / area3D) * (options.texelDensityScale ?? 1); at.densitySource = 'source-texture-density'; }
            else if (transfer && area3D > 0) {
                // transfer without an own texture: match the source's density over the whole source
                let srcUvPx = 0, srcA = 0;
                const s = transfer.source, V = s.pos!.length / 3;
                const firstImageSlot = transferSlots.findIndex((_, k) => transfer!.materials.some(m => m[k].image >= 0));
                for (let t = 0; t < s.idx!.length / 3; t++) {
                    const m = transfer.materials[s.triMaterial[t]][firstImageSlot];
                    if (!m || m.image < 0) continue;
                    const im = transfer.images[m.image];
                    const i0 = s.idx![t * 3], i1 = s.idx![t * 3 + 1], i2 = s.idx![t * 3 + 2];
                    const uvo = firstImageSlot * V * 2;
                    const A = [s.uv[uvo + i0 * 2], s.uv[uvo + i0 * 2 + 1]], B = [s.uv[uvo + i1 * 2], s.uv[uvo + i1 * 2 + 1]], C = [s.uv[uvo + i2 * 2], s.uv[uvo + i2 * 2 + 1]];
                    srcUvPx += 0.5 * Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])) * im.width * im.height;
                    const P = (i: number) => [s.pos![i * 3], s.pos![i * 3 + 1], s.pos![i * 3 + 2]];
                    srcA += 0.5 * len3(cross3(sub3(P(i1), P(i0)), sub3(P(i2), P(i0))));
                }
                if (srcUvPx > 0 && srcA > 0) { texelsPerMeter = Math.sqrt(srcUvPx / srcA) * (options.texelDensityScale ?? 1); at.densitySource = 'source-texture-density'; }
            }
            if (!(texelsPerMeter > 0)) { atlasW = atlasH = 2048; at.densitySource = 'default-atlas-size'; }
        }

        // unwrap + pack
        const tu = performance.now();
        const nat = await nativeUnwrap(nativeBin.path, wpos, widx, groups, {
            chartNormalToleranceDeg: opts.chartNormalToleranceDeg, minIslandAreaM2: opts.minChartAreaFraction * area3D,
            maxAngleStretch: opts.maxAngleStretch, maxAreaDistortion: opts.maxAreaDistortion, conformal: opts.conformal,
            texelsPerMeter, atlasWidth: atlasW, atlasHeight: atlasH, maxSide: opts.maxAtlasSide, gutter: opts.gutter, allowRotation: opts.allowRotation
        }, opts.timeoutMs, options.signal);
        at.timings.unwrapMs = performance.now() - tu;
        at.timings.chartsMs = nat.msCharts; at.timings.packMs = nat.msPack;
        at.width = nat.width; at.height = nat.height; at.texelsPerMeter = nat.texelsPerMeter;
        at.utilisation = nat.utilisation; at.overlappingTrianglePairs = nat.overlappingPairs;
        at.lscmAttempts = nat.lscmAttempts; at.splits = nat.splits;
        const C = nat.charts.length / 24;
        const parts: Array<{ s: UvDistortionStats; w: number }> = [], orthoParts: Array<{ s: UvDistortionStats; w: number }> = [];
        for (let c = 0; c < C; c++) {
            const r = nat.charts.subarray(c * 24, c * 24 + 24);
            const ortho: UvDistortionStats = { stretchRms: r[6], stretchMax: r[7], areaRms: r[8], areaMax: r[9], flippedTriangles: r[10] };
            const fin: UvDistortionStats = { stretchRms: r[11], stretchMax: r[12], areaRms: r[13], areaMax: r[14], flippedTriangles: r[15] };
            at.chartDetails.push({
                method: r[0] === 1 ? 'lscm' : 'orthographic', primitive: r[1], triangles: r[2], splitDepth: r[3], overThreshold: r[4] === 1, lscmIterations: r[5],
                orthographic: ortho, ...fin, area3DM2: r[16], widthM: r[17], heightM: r[18], rect: [r[19], r[20], r[21], r[22]], rotated: r[23] === 1
            });
            parts.push({ s: fin, w: r[16] }); orthoParts.push({ s: ortho, w: r[16] });
        }
        at.charts = C;
        at.lscmCharts = at.chartDetails.filter(c => c.method === 'lscm').length;
        at.orthographicCharts = C - at.lscmCharts;
        at.chartsOverThreshold = at.chartDetails.filter(c => c.overThreshold).length;
        at.distortion = mergeStats(parts);
        at.orthographicDistortion = mergeStats(orthoParts);

        // texel density per triangle in the new atlas
        const dens: Array<{ d: number; w: number }> = [];
        for (let t = 0; t < nt; t++) {
            const i0 = nat.indices[t * 3], i1 = nat.indices[t * 3 + 1], i2 = nat.indices[t * 3 + 2];
            const ax = nat.uv[i0 * 2] * nat.width, ay = nat.uv[i0 * 2 + 1] * nat.height;
            const bx = nat.uv[i1 * 2] * nat.width, by = nat.uv[i1 * 2 + 1] * nat.height;
            const cx = nat.uv[i2 * 2] * nat.width, cy = nat.uv[i2 * 2 + 1] * nat.height;
            const a2 = 0.5 * Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
            if (triArea3D[t] > 1e-12) dens.push({ d: Math.sqrt(a2 / triArea3D[t]), w: triArea3D[t] });
        }
        at.texelDensity = densityStats(dens);
        densityAll.push(...dens);
        uvAreaAll += nat.utilisation * nat.width * nat.height; atlasAreaAll += nat.width * nat.height;

        // per primitive: output vertices in first-use order
        const perPrim = prims.map((p, g) => {
            const local = new Map<number, number>();
            const sourceVertex: number[] = [], uv: number[] = [];
            const idx = new Uint32Array(p.indices.length);
            for (let k = 0; k < p.indices.length; k++) {
                const o = nat.indices[tOff[g] * 3 + k];
                let l = local.get(o);
                if (l === undefined) {
                    l = sourceVertex.length;
                    local.set(o, l);
                    sourceVertex.push(nat.sourceVertex[o] - vOff[g]);
                    uv.push(nat.uv[o * 2], nat.uv[o * 2 + 1]);
                }
                idx[k] = l;
            }
            return { sourceVertex: Uint32Array.from(sourceVertex), uv: Float32Array.from(uv), idx };
        });
        at.verticesOut = perPrim.reduce((a, p) => a + p.sourceVertex.length, 0);

        // bake
        let newTangents: Float32Array[] | undefined;
        let bakedImages: Array<{ job?: SlotJob; slotIndex: number; kind: number; refs: SlotRef[]; data: Uint8Array }> = [];
        const bakeSlots = transfer ? transferSlots.map((p, s) => ({ kind: transferSlotKinds[s], path: p })) : jobs.map(j => ({ kind: j.kind, path: j.refs[0].path }));
        if (mode === 'rewrap' && bakeSlots.length) {
            const needsTangents = bakeSlots.some(s => s.kind === SLOT_KIND.normal) || prims.some(p => p.def.attributes.TANGENT !== undefined);
            // target arrays (new vertices); same-mesh in local space, transfer in world space
            const Vt = at.verticesOut;
            const tUv = new Float32Array(Vt * 2), tPos = new Float32Array(Vt * 3), tIdx = new Uint32Array(nt * 3);
            const hasNormals = prims.every(p => p.def.attributes.NORMAL !== undefined);
            const tNrm = hasNormals ? new Float32Array(Vt * 3) : undefined;
            const tTan = needsTangents ? new Float32Array(Vt * 4) : undefined;
            const sUv = new Float32Array(bakeSlots.length * Vt * 2);
            const sTan = !transfer && needsTangents ? new Float32Array(Vt * 4) : undefined;
            newTangents = needsTangents ? [] : undefined;
            let vb = 0, tb = 0;
            for (const [g, p] of prims.entries()) {
                const pp = perPrim[g];
                const n = pp.sourceVertex.length;
                const M = transfer ? p.world : identity, NM = normalMatrix(M);
                const nrmSrc = hasNormals ? readFloats(glb, p.def.attributes.NORMAL).data : undefined;
                const posLocal = new Float32Array(n * 3), nrmLocal = nrmSrc ? new Float32Array(n * 3) : undefined;
                for (let v = 0; v < n; v++) {
                    const s = pp.sourceVertex[v];
                    posLocal.set([p.positions[s * 3], p.positions[s * 3 + 1], p.positions[s * 3 + 2]], v * 3);
                    if (nrmLocal && nrmSrc) nrmLocal.set([nrmSrc[s * 3], nrmSrc[s * 3 + 1], nrmSrc[s * 3 + 2]], v * 3);
                    tUv[(vb + v) * 2] = pp.uv[v * 2] * nat.width; tUv[(vb + v) * 2 + 1] = pp.uv[v * 2 + 1] * nat.height;
                    tPos.set(xform(M, posLocal[v * 3], posLocal[v * 3 + 1], posLocal[v * 3 + 2], 1), (vb + v) * 3);
                    if (tNrm && nrmLocal) {
                        const x = nrmLocal[v * 3], y = nrmLocal[v * 3 + 1], z = nrmLocal[v * 3 + 2];
                        const w = [NM[0] * x + NM[3] * y + NM[6] * z, NM[1] * x + NM[4] * y + NM[7] * z, NM[2] * x + NM[5] * y + NM[8] * z];
                        const l = len3(w) || 1;
                        tNrm.set([w[0] / l, w[1] / l, w[2] / l], (vb + v) * 3);
                    }
                }
                for (let k = 0; k < pp.idx.length; k++) tIdx[tb * 3 + k] = pp.idx[k] + vb;
                if (tTan) {
                    const nt2 = computeTangents(posLocal, nrmLocal, pp.uv, pp.idx, n);
                    newTangents!.push(nt2);
                    for (let v = 0; v < n; v++) {
                        const d = xform(M, nt2[v * 4], nt2[v * 4 + 1], nt2[v * 4 + 2], 0);
                        const l = len3(d) || 1;
                        tTan.set([d[0] / l, d[1] / l, d[2] / l, nt2[v * 4 + 3]], (vb + v) * 4);
                    }
                }
                if (!transfer) {
                    // old UVs per slot and old tangents, gathered per new vertex
                    jobs.forEach((job, s) => {
                        const uv = readFloats(glb, p.def.attributes[`TEXCOORD_${job.texCoord}`]).data;
                        for (let v = 0; v < n; v++) {
                            const sv = pp.sourceVertex[v];
                            let [u, w] = [uv[sv * 2], uv[sv * 2 + 1]];
                            if (job.apply) [u, w] = job.apply(u, w);
                            sUv[s * Vt * 2 + (vb + v) * 2] = u; sUv[s * Vt * 2 + (vb + v) * 2 + 1] = w;
                        }
                    });
                    if (sTan) {
                        let old: ArrayLike<number>;
                        if (p.def.attributes.TANGENT !== undefined) old = readFloats(glb, p.def.attributes.TANGENT).data;
                        else {
                            const nj = jobs.find(j => j.kind === SLOT_KIND.normal) ?? jobs[0];
                            const uv = readFloats(glb, p.def.attributes[`TEXCOORD_${nj.texCoord}`]).data;
                            const tuv = new Float64Array(uv.length);
                            for (let v = 0; v < uv.length / 2; v++) { const [u, w] = nj.apply ? nj.apply(uv[v * 2], uv[v * 2 + 1]) : [uv[v * 2], uv[v * 2 + 1]]; tuv[v * 2] = u; tuv[v * 2 + 1] = w; }
                            old = computeTangents(p.positions, nrmSrc, tuv, p.indices, p.vertexCount);
                        }
                        for (let v = 0; v < n; v++) { const sv = pp.sourceVertex[v]; sTan.set([old[sv * 4], old[sv * 4 + 1], old[sv * 4 + 2], old[sv * 4 + 3]], (vb + v) * 4); }
                    }
                }
                vb += n; tb += pp.idx.length / 3;
            }
            const req: BakeRequest = transfer ? {
                width: nat.width, height: nat.height, gutter: opts.gutter, transfer: true, threads: opts.threads,
                maxDistance: options.transferSource?.maxDistanceM ?? 0, maxNormalAngleDeg: options.transferSource?.maxNormalAngleDeg ?? 0,
                slotKinds: transferSlotKinds, target: { uvPx: tUv, pos: tPos, nrm: tNrm, tan: tTan, idx: tIdx },
                source: transfer.source, materials: transfer.materials, images: transfer.images
            } : {
                width: nat.width, height: nat.height, gutter: opts.gutter, transfer: false, threads: opts.threads, maxDistance: 0, maxNormalAngleDeg: 0,
                slotKinds: jobs.map(j => j.kind), target: { uvPx: tUv, pos: tPos, nrm: tNrm, tan: tTan, idx: tIdx },
                source: { uv: sUv, tan: sTan, triMaterial: new Uint32Array(nt) },
                materials: [jobs.map((j, s) => ({ image: s, wrapS: j.wrapS, wrapT: j.wrapT, factor: [1, 1, 1, 1] as [number, number, number, number] }))],
                images: jobs.map(j => j.img!)
            };
            const tbk = performance.now();
            let reply: BakeReply;
            try {
                reply = await nativeBake(nativeBin.path, req, opts.timeoutMs, options.signal);
            } catch (e) {
                for (const s of bakeSlots) at.failures.push({ slot: s.path, reason: `bake failed: ${(e as Error).message}` });
                at.skippedReason = 'the bake failed, so the UVs were left unchanged';
                report.texturesFailed.push(...at.failures);
                continue;
            }
            at.timings.bakeMs = performance.now() - tbk;
            at.bake = {
                interiorTexels: reply.interior, edgeTexels: reply.edge, dilatedTexels: reply.dilated, emptyTexels: reply.empty, unresolvedTexels: reply.unresolved, ms: reply.ms,
                ...(transfer ? { meanTransferDistanceM: reply.meanDistance, maxTransferDistanceM: reply.maxDistance } : {})
            };
            bakedImages = bakeSlots.map((s, k) => ({ job: transfer ? undefined : jobs[k], slotIndex: k, kind: s.kind, refs: transfer ? [] : jobs[k].refs, data: reply.slots[k] }));
        }

        // write: geometry (vertices split at seams), UVs, tangents; then materials
        const texCoordName = (p: Prim) => {
            if (mode === 'rewrap') return 'TEXCOORD_0';
            let k = 0;
            while (p.def.attributes[`TEXCOORD_${k}`] !== undefined) k++;
            return `TEXCOORD_${k}`;
        };
        at.texCoordWritten = [...new Set(prims.map(texCoordName))].join(', ');
        prims.forEach((p, g) => {
            const pp = perPrim[g];
            const dst = out.meshes[p.mesh].primitives[p.primitive];
            const n = pp.sourceVertex.length;
            const gatherAcc = (acc: number, name: string): number => {
                const a = json.accessors[acc];
                const bytes = gatherElements(glb, acc, pp.sourceVertex);
                const extra: Record<string, unknown> = {};
                if (a.normalized) extra.normalized = true;
                if (name === 'POSITION' && a.componentType === 5126) {
                    const f = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
                    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
                    for (let v = 0; v < n; v++) for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], f[v * 3 + c]); mx[c] = Math.max(mx[c], f[v * 3 + c]); }
                    extra.min = mn; extra.max = mx;
                }
                return writer.addAccessor(bytes, a.componentType, a.type, n, extra, 34962);
            };
            const attrs: Record<string, number> = {};
            for (const [name, acc] of Object.entries(p.def.attributes as Record<string, number>)) {
                if (mode === 'rewrap' && name === 'TEXCOORD_0') continue;
                if (name === 'TANGENT' && newTangents) continue;
                attrs[name] = gatherAcc(acc, name);
            }
            attrs[texCoordName(p)] = writer.addAccessor(new Uint8Array(pp.uv.buffer.slice(0)), 5126, 'VEC2', n, {}, 34962);
            if (newTangents) attrs.TANGENT = writer.addAccessor(new Uint8Array(newTangents[g].buffer.slice(0)), 5126, 'VEC4', n, {}, 34962);
            const big = n > 65535;
            const ib = big ? new Uint8Array(pp.idx.buffer.slice(0)) : new Uint8Array(Uint16Array.from(pp.idx).buffer);
            dst.attributes = attrs;
            dst.indices = writer.addAccessor(ib, big ? 5125 : 5123, 'SCALAR', pp.idx.length, {}, 34963);
            delete dst.mode;
            if (p.def.targets) dst.targets = (p.def.targets as any[]).map(t => Object.fromEntries(Object.entries(t as Record<string, number>).map(([name, acc]) => [name, gatherAcc(acc, name)])));
        });

        if (mode === 'rewrap' && bakedImages.length) {
            const te = performance.now();
            if (clampSampler === undefined) {
                out.samplers ??= [];
                out.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 });
                clampSampler = out.samplers.length - 1;
            }
            // target material: its own (rewrap), or one created / reused (transfer)
            let dstMatIndex = materialKey;
            if (transfer) {
                out.materials ??= [];
                if (dstMatIndex < 0) {
                    out.materials.push({ name: 'uv_rewrap_transfer', pbrMetallicRoughness: {} });
                    dstMatIndex = out.materials.length - 1;
                    for (const p of prims) out.meshes[p.mesh].primitives[p.primitive].material = dstMatIndex;
                }
            }
            const dstMat = out.materials[dstMatIndex];
            for (const b of bakedImages) {
                const isNormal = b.kind === SLOT_KIND.normal;
                const fmt = options.outputImageFormat ?? 'source';
                const sourceMime = b.job ? json.images?.[b.job.image]?.mimeType : undefined;
                const usePng = isNormal || fmt === 'png' || (fmt === 'source' && sourceMime !== 'image/jpeg');
                const rgba = Buffer.from(b.data.buffer, b.data.byteOffset, b.data.byteLength);
                const bytes = usePng ? encodePng(nat.width, nat.height, rgba) : await encodeRgbaToJpeg(rgba, nat.width, nat.height, { quality: options.jpegQuality ?? 95, chroma: '444' });
                const mime = usePng ? 'image/png' : 'image/jpeg';
                const imgIndex = writer.addImage(bytes, mime, `uv_rewrap_${materialKey >= 0 ? materialKey : 'none'}_${b.slotIndex}`);
                out.textures ??= [];
                out.textures.push({ sampler: clampSampler, source: imgIndex });
                const texIndex = out.textures.length - 1;
                const paths: string[] = [];
                if (transfer) {
                    const sp = transferSlots[b.slotIndex];
                    const keys = sp.split('.');
                    let holder: any = dstMat;
                    for (const k of keys.slice(0, -1)) { holder[k] ??= {}; holder = holder[k]; }
                    const key = keys[keys.length - 1];
                    holder[key] = { index: texIndex };
                    slotFactor({ path: sp, holder, key, info: holder[key] }).reset();
                    paths.push(sp);
                } else {
                    // the same textureInfo objects in the output JSON (same paths)
                    for (const ref of b.refs) {
                        const dstRef = materialSlots(dstMat).find(r => r.path === ref.path)!;
                        dstRef.info.index = texIndex;
                        delete dstRef.info.texCoord;
                        if (dstRef.info.extensions) {
                            delete dstRef.info.extensions.KHR_texture_transform;
                            if (!Object.keys(dstRef.info.extensions).length) delete dstRef.info.extensions;
                        }
                        paths.push(ref.path);
                    }
                }
                const job = b.job;
                const rep: UvRebakedTexture = {
                    slots: paths, kind: isNormal ? 'tangent-space-normal' : b.kind === SLOT_KIND.srgb ? 'color-srgb' : 'linear',
                    ...(job ? { sourceTexture: job.texture, sourceImage: job.image, sourceSize: [job.img!.width, job.img!.height] as [number, number] } : {}),
                    outputTexture: texIndex, outputImage: imgIndex, outputSize: [nat.width, nat.height], outputBytes: bytes.length, mimeType: mime
                };
                at.textures.push(rep);
            }
            if (transfer && transfer.allUnlit) {
                dstMat.extensions ??= {};
                dstMat.extensions.KHR_materials_unlit = {};
                out.extensionsUsed = [...new Set([...(out.extensionsUsed ?? []), 'KHR_materials_unlit'])];
            }
            at.timings.encodeMs = performance.now() - te;
            report.texturesRebaked.push(...at.textures);
        }
        at.status = bakedImages.length ? 'rewrapped' : 'unwrapped';
    }

    // KHR_texture_transform may no longer be used
    const usesTransform = JSON.stringify(out.materials ?? []).includes('KHR_texture_transform');
    if (!usesTransform) {
        for (const k of ['extensionsUsed', 'extensionsRequired']) {
            if (Array.isArray(out[k])) { out[k] = out[k].filter((e: string) => e !== 'KHR_texture_transform'); if (!out[k].length) delete out[k]; }
        }
    }

    const done = report.atlases.filter(a => a.status !== 'skipped');
    report.charts = done.reduce((a, x) => a + x.charts, 0);
    report.lscmCharts = done.reduce((a, x) => a + x.lscmCharts, 0);
    report.distortion = mergeStats(done.flatMap(a => a.chartDetails.map(c => ({ s: c as UvDistortionStats, w: c.area3DM2 }))));
    report.orthographicDistortion = mergeStats(done.flatMap(a => a.chartDetails.map(c => ({ s: c.orthographic, w: c.area3DM2 }))));
    report.texelDensity = densityStats(densityAll);
    report.utilisation = atlasAreaAll > 0 ? uvAreaAll / atlasAreaAll : 0;
    report.overlappingTrianglePairs = done.reduce((a, x) => a + x.overlappingTrianglePairs, 0);
    const glbOut = writer.finish();
    report.totalMs = performance.now() - t0;
    return { glb: glbOut, report };
}
