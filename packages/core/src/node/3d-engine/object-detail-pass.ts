/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Weathering and decals on a generated object, part by part (object_detail_pass). Two native steps, no image model:
 *   1. the UV rewrap (UvAtlasRewrap.ts 'rewrap') gives every material its own atlas on TEXCOORD_0 at one texel density
 *      across the object, and rebakes into it whatever maps the material already has;
 *   2. the detail bake (scratchbox_object_detail.hpp via scripts/object_detail_bake.cpp, built through the native build
 *      cache, run through a pipe) composites wear and decals onto each material's own base colour and
 *      metallic-roughness, texel by texel, from masks read off the geometry: edge wear on the part's convex edges,
 *      grime in cavities and creases, streaks under overhangs, dust on up-facing surfaces, sun fade by exposure.
 * Each material keeps its name, factors it does not hold in the new maps (emission, transmission, clearcoat, ior,
 * alpha), every extension and every other map (normal, occlusion, emissive); its base colour and metallic-roughness
 * factors move into the new maps, and the factors it had are kept in its extras with the pass's record, labelled
 * generated. No two parts' materials are ever merged. Geometry is unchanged (vertices are split only at chart seams).
 * Left as they are: SB-Veggie trees (their own library textures) and decal skins an earlier asset_decal baked.
 */

import * as path from 'path';
import { spawn } from 'child_process';
import { compileNativeCached, defaultNativeFlags, NativeBuildError } from './native-build-cache';
import { findUvAtlasRepoRoot } from './staged-location/texture-uv';
import { assembleGlb, nodeWorldMatrices, parseGlbBytes, readAccessor, type Mat4, type ParsedGlb } from './staged-location/glb-bytes';
import { decodeImageInMemory, type RgbaImage8 } from './staged-location/tile-texture-transfer';
import { isSbVeggieNode } from './part-connectivity';
import { GlbWriter, unwrapRewrapGlb, type UvRewrapReport } from '../spatial/UvAtlasRewrap';
import { encodeRgbaToJpeg } from '../image-codec-ffmpeg';
import { encodePng } from '../texture-processing';

/** The pass's version: part of every version's input hash, so a change to what the pass draws makes new versions. */
export const OBJECT_DETAIL_PASS_VERSION = 'object-detail-pass/1';
/** Texels the whole object's atlases share by default (about a 2K map's worth, at one density across every part). */
export const OBJECT_DETAIL_TARGET_TEXELS = 2048 * 2048 * 0.55;

export type Rgb = [number, number, number];
export type Xyz = [number, number, number];

/** The wear, every value continuous; an omitted one takes its default (scales from the object's own size). */
export interface ObjectWear {
    /** Strengths, 0..1 (0 turns a layer off). */
    edgeWear?: number;
    grime?: number;
    streaks?: number;
    dust?: number;
    sunFade?: number;
    /** Large-scale patchiness of every layer, 0..1. */
    variation?: number;
    /** How far edge wear reaches from a sharp convex edge, metres. */
    edgeWidthM?: number;
    /** How far grime reaches from a concave crease, metres. */
    creaseWidthM?: number;
    /** How near a surface must be to darken a cavity, metres. */
    aoRadiusM?: number;
    /** How far run-off streaks reach below an overhang, metres. */
    streakReachM?: number;
    /** Linear RGB of the layers. */
    grimeColor?: Rgb;
    streakColor?: Rgb;
    dustColor?: Rgb;
    seed?: number;
}

/** One part's share of the wear (multipliers on the strengths) and the finish its worn edges show. */
export interface PartWearOverride {
    /** The part: its node name (an object build's part id). */
    part: string;
    edgeWear?: number;
    grime?: number;
    streaks?: number;
    dust?: number;
    sunFade?: number;
    /** What a worn edge shows (linear RGB, roughness, metalness): e.g. bare metal under paint. Default: the part's own colour lightened and polished. */
    edgeColor?: Rgb;
    edgeRoughness?: number;
    edgeMetalness?: number;
}

/** A decal projected onto named parts, never onto any other. */
export interface ObjectDecal {
    parts: string[];
    /** Straight alpha, sRGB colour. */
    image: RgbaImage8;
    /** The direction the decal faces out of the surface (object frame: x right, y up, z front). */
    facing: Xyz;
    /** The image's up (default +y, or -z on a surface facing up or down). */
    up?: Xyz;
    /** Its centre as fractions across and up the parts seen from `facing` (default [0.5, 0.5]); or `centerM`. */
    at?: [number, number];
    centerM?: Xyz;
    sizeM: [number, number];
    opacity?: number;
    /** Faces turned further than this from `facing` get none (default 75). */
    maxAngleDeg?: number;
    /** The decal's own finish (paint on metal, a printed label); absent: the part's finish shows through. */
    roughness?: number;
    metalness?: number;
    label: 'generated' | 'photo-inferred';
    method: string;
}

export interface ObjectDetailOptions {
    /** The wear; null for decals only. */
    wear?: ObjectWear | null;
    parts?: PartWearOverride[];
    decals?: ObjectDecal[];
    /** Texels the object's atlases share (default OBJECT_DETAIL_TARGET_TEXELS). */
    targetTexels?: number;
    /** The new maps' encoding: 'jpeg' (default; PNG where a base colour has alpha) or 'png' (lossless). */
    imageFormat?: 'jpeg' | 'png';
    /** Also return each atlas's masks (tests, review sheets). */
    masks?: boolean;
    native?: { binaryPath?: string; repoRoot?: string; timeoutMs?: number; threads?: number };
    signal?: AbortSignal;
}

export interface PartDetailReport {
    part: string;
    node: number;
    material?: string;
    texels: number;
    /** Mean of each mask over the part's texels (before strengths). */
    edgeWear: number;
    grime: number;
    streaks: number;
    dust: number;
    exposure: number;
    decal: number;
}

export interface ObjectDetailReport {
    version: string;
    label: 'generated';
    wear: Required<Omit<ObjectWear, 'seed'>> & { seed: number; patchScaleM: number; streakColumnM: number } | null;
    objectSizeM: Xyz;
    texelsPerMeter: number;
    materials: Array<{ material: number; name?: string; width: number; height: number; texels: number; weathered: boolean; reason?: string }>;
    parts: PartDetailReport[];
    decals: Array<{ parts: string[]; texels: number; sizeM: [number, number]; label: string; method: string }>;
    left: Array<{ mesh: number; primitive: number; reason: string }>;
    featureEdges: { convex: number; concave: number; open: number };
    timings: { rewrapMs: number; bakeMs: number; encodeMs: number; totalMs: number; native: { edges: number; bvh: number; masks: number; composite: number; dilate: number } };
    rewrap: Pick<UvRewrapReport, 'charts' | 'lscmCharts' | 'utilisation' | 'overlappingTrianglePairs'>;
}

export interface ObjectDetailMasks { material: number; width: number; height: number; wear: Uint8Array; light: Uint8Array }

export interface ObjectDetailResult { glb: Buffer; report: ObjectDetailReport; masks?: ObjectDetailMasks[] }

// =============================================================================
// Native binary
// =============================================================================

const CLI_SOURCE = path.join('scripts', 'object_detail_bake.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');

let building: Promise<string> | undefined;

/** The detail bake's binary, built through the native build cache when its source or any header it includes changed. */
export function ensureObjectDetailBinary(repoRoot = findUvAtlasRepoRoot()): Promise<string> {
    if (process.env.SCRATCHBOX_OBJECT_DETAIL_BIN) return Promise.resolve(process.env.SCRATCHBOX_OBJECT_DETAIL_BIN);
    building ??= (async () => {
        try {
            const built = await compileNativeCached({ sourcePath: path.join(repoRoot, CLI_SOURCE), includeDirs: [path.join(repoRoot, INCLUDE_DIR)], flags: defaultNativeFlags(['-pthread']), name: 'object_detail_bake', timeoutMs: 600_000 });
            return built.binaryPath;
        } catch (err) {
            throw new Error(`could not build the object detail bake: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : (err as Error).message}`);
        }
    })().finally(() => { building = undefined; });
    return building;
}

function runNative(binary: string, request: Buffer[], timeoutMs: number, signal?: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const proc = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const chunks: Buffer[] = [];
        let err = '';
        const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`the object detail bake timed out after ${timeoutMs} ms`)); }, timeoutMs);
        const onAbort = () => { clearTimeout(timer); proc.kill('SIGKILL'); reject(signal!.reason instanceof Error ? signal!.reason : Object.assign(new Error('the object detail bake was stopped'), { name: 'AbortError' })); };
        if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
        proc.stdout.on('data', (c: Buffer) => chunks.push(c));
        proc.stderr.on('data', (c: Buffer) => { err += c.toString(); });
        proc.on('error', e => { clearTimeout(timer); reject(e); });
        proc.on('close', code => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            if (code !== 0) reject(new Error(`the object detail bake exited ${code}: ${err.trim().slice(-800)}`));
            else resolve(Buffer.concat(chunks));
        });
        proc.stdin.on('error', () => { /* reported through close */ });
        for (const b of request) proc.stdin.write(b);
        proc.stdin.end();
    });
}

const u32 = (...v: number[]) => { const b = Buffer.alloc(v.length * 4); v.forEach((x, i) => b.writeUInt32LE(x >>> 0, i * 4)); return b; };
const f32 = (...v: number[]) => { const b = Buffer.alloc(v.length * 4); v.forEach((x, i) => b.writeFloatLE(x, i * 4)); return b; };
const f64 = (...v: number[]) => { const b = Buffer.alloc(v.length * 8); v.forEach((x, i) => b.writeDoubleLE(x, i * 8)); return b; };
const view = (a: Float32Array | Uint32Array | Uint8Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

class Reader {
    o = 4;
    constructor(private readonly b: Buffer) {
        if (b.length < 4 || b.toString('latin1', 0, 4) !== 'SBOO') throw new Error('the object detail bake returned no SBOO reply');
    }
    private need(n: number) { if (this.o + n > this.b.length) throw new Error('the object detail bake reply is truncated'); }
    u32(): number { this.need(4); const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
    f64(): number { this.need(8); const v = this.b.readDoubleLE(this.o); this.o += 8; return v; }
    bytes(n: number): Uint8Array { this.need(n); const a = new Uint8Array(this.b.buffer.slice(this.b.byteOffset + this.o, this.b.byteOffset + this.o + n)); this.o += n; return a; }
}

// =============================================================================
// Geometry
// =============================================================================

function triangleIndices(glb: ParsedGlb, def: any, vertexCount: number): Uint32Array | undefined {
    const mode = def.mode ?? 4;
    if (mode !== 4) return undefined;
    if (def.indices === undefined) return Uint32Array.from({ length: vertexCount - (vertexCount % 3) }, (_, i) => i);
    return Uint32Array.from(readAccessor(glb, def.indices).data);
}

function normalMatrix(m: Mat4): number[] {
    const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C || 1;
    // inverse transpose of the upper 3x3, column-major
    return [A / det, B / det, C / det, -(b * i - c * h) / det, (a * i - c * g) / det, -(a * h - b * g) / det, (b * f - c * e) / det, -(a * f - c * d) / det, (a * e - b * d) / det];
}

const xf = (m: Mat4, x: number, y: number, z: number): Xyz => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];

interface Prim { mesh: number; primitive: number; node: number; def: any; world: Mat4 }

/** Every drawn primitive with its node (each instance), and the first node drawing each mesh. */
function drawnPrimitives(json: any): { all: Prim[]; firstNodeOfMesh: Map<number, number>; meshUses: Map<number, number> } {
    const world = nodeWorldMatrices(json);
    const all: Prim[] = [];
    const firstNodeOfMesh = new Map<number, number>(), meshUses = new Map<number, number>();
    (json.nodes ?? []).forEach((n: any, node: number) => {
        if (n.mesh === undefined) return;
        if (!firstNodeOfMesh.has(n.mesh)) firstNodeOfMesh.set(n.mesh, node);
        meshUses.set(n.mesh, (meshUses.get(n.mesh) ?? 0) + 1);
        (json.meshes?.[n.mesh]?.primitives ?? []).forEach((def: any, primitive: number) => all.push({ mesh: n.mesh, primitive, node, def, world: world[node] }));
    });
    return { all, firstNodeOfMesh, meshUses };
}

/** A node is left as it is when it is an SB-Veggie tree or a decal skin, or hangs under one. */
function leftNodes(json: any): Map<number, string> {
    const out = new Map<number, string>();
    const visit = (i: number, reason: string | undefined) => {
        const n = json.nodes[i];
        const own = isSbVeggieNode(String(n.name ?? '')) ? 'an SB-Veggie tree keeps its own library textures'
            : n.extras?.decal === true ? 'a decal skin (asset_decal) stays as it was laid' : undefined;
        const r = reason ?? own;
        if (r) out.set(i, r);
        for (const c of n.children ?? []) visit(c, r);
    };
    const nodes: any[] = json.nodes ?? [];
    const roots = new Set<number>(nodes.map((_, i) => i));
    for (const n of nodes) for (const c of n.children ?? []) roots.delete(c);
    for (const r of roots) visit(r, undefined);
    return out;
}

function partName(json: any, node: number): string {
    const n = json.nodes?.[node];
    return String(n?.name || json.meshes?.[n?.mesh]?.name || `node_${node}`);
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const finiteOr = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function frame(facing: Xyz, up?: Xyz): { N: Xyz; R: Xyz; U: Xyz } {
    const nl = Math.hypot(...facing);
    if (!(nl > 1e-9)) throw new Error('a decal needs a facing direction');
    const N: Xyz = [facing[0] / nl, facing[1] / nl, facing[2] / nl];
    let u: Xyz = up ?? [0, 1, 0];
    const cr = (a: Xyz, b: Xyz): Xyz => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    if (Math.hypot(...cr(u, N)) < 1e-4 * Math.max(1e-6, Math.hypot(...u))) u = Math.abs(N[1]) > 0.9 ? [0, 0, -1] : [0, 1, 0];
    const r = cr(u, N), rl = Math.hypot(...r);
    const R: Xyz = [r[0] / rl, r[1] / rl, r[2] / rl];
    return { N, R, U: cr(N, R) };
}

/**
 * The GLB with every POSITION accessor's min/max measured from its data (the JSON alone changes). The engine's GLB
 * writer rounds them to six significant digits, which glTF validators and the scene object store's check refuse.
 */
export function exactPositionBounds(input: Buffer | Uint8Array): Buffer {
    const glb = parseGlbBytes(input instanceof Uint8Array ? input : new Uint8Array(input));
    let changed = false;
    const done = new Set<number>();
    for (const mesh of glb.json.meshes ?? []) for (const p of mesh.primitives ?? []) {
        const ai = p.attributes?.POSITION;
        const a = ai !== undefined ? glb.json.accessors?.[ai] : undefined;
        if (!a || done.has(ai) || a.type !== 'VEC3' || a.componentType !== 5126 || a.sparse || a.bufferView === undefined) continue;
        done.add(ai);
        const data = readAccessor(glb, ai).data;
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < data.length; i++) { const c = i % 3; if (data[i] < min[c]) min[c] = data[i]; if (data[i] > max[c]) max[c] = data[i]; }
        if (!data.length || (JSON.stringify(a.min) === JSON.stringify(min) && JSON.stringify(a.max) === JSON.stringify(max))) continue;
        a.min = min; a.max = max;
        changed = true;
    }
    return changed ? assembleGlb(glb.json, glb.bin) : Buffer.from(input);
}

// =============================================================================
// Main
// =============================================================================

export async function runObjectDetailPass(rawInput: Buffer | Uint8Array, options: ObjectDetailOptions = {}): Promise<ObjectDetailResult> {
    const t0 = performance.now();
    const input = exactPositionBounds(rawInput);
    const src = parseGlbBytes(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
    const srcJson = src.json;
    if (!(srcJson.meshes ?? []).length) throw new Error('the GLB has no meshes to weather');
    const left = leftNodes(srcJson);
    const { all: srcPrims, firstNodeOfMesh } = drawnPrimitives(srcJson);
    // a mesh drawn by a left node is left everywhere it is drawn (its UVs are shared)
    const leftMeshes = new Set<number>();
    for (const node of left.keys()) { const m = srcJson.nodes[node].mesh; if (m !== undefined) leftMeshes.add(m); }
    if (!srcPrims.some(p => !leftMeshes.has(p.mesh))) throw new Error('the GLB has no part the pass can weather (only trees or decal skins)');

    // the object's extent and surface area (world), and the density every atlas shares
    let area = 0;
    const lo: Xyz = [Infinity, Infinity, Infinity], hi: Xyz = [-Infinity, -Infinity, -Infinity];
    for (const p of srcPrims) {
        if (p.def.attributes?.POSITION === undefined) continue;
        const pos = readAccessor(src, p.def.attributes.POSITION).data;
        const idx = triangleIndices(src, p.def, pos.length / 3);
        if (!idx) continue;
        const w = (v: number) => xf(p.world, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
        for (let k = 0; k + 2 < idx.length; k += 3) {
            const a = w(idx[k]), b = w(idx[k + 1]), c = w(idx[k + 2]);
            for (const q of [a, b, c]) for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], q[j]); hi[j] = Math.max(hi[j], q[j]); }
            if (leftMeshes.has(p.mesh)) continue;
            const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            area += 0.5 * Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
        }
    }
    if (!(area > 0)) throw new Error('the GLB has no triangle surface to weather');
    const size: Xyz = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const diag = Math.hypot(...size);
    const texelsPerMeter = Math.sqrt(Math.max(64 * 64, options.targetTexels ?? OBJECT_DETAIL_TARGET_TEXELS) / area);
    const texelM = 1 / texelsPerMeter;

    // 1. every material its own atlas (its own maps rebaked into it)
    const tr = performance.now();
    const rewrap = await unwrapRewrapGlb('rewrap', input, {
        texelsPerMeter, gutterTexels: 4, maxAtlasSide: 4096, outputImageFormat: 'png',
        leaveMeshes: { meshes: [...leftMeshes], reason: 'a tree or decal skin, left as it is' },
        native: { ...(options.native?.repoRoot ? { repoRoot: options.native.repoRoot } : {}), ...(options.native?.threads ? { threads: options.native.threads } : {}), ...(options.native?.timeoutMs ? { timeoutMs: options.native.timeoutMs } : {}) },
        ...(options.signal ? { signal: options.signal } : {})
    });
    const rewrapMs = performance.now() - tr;
    const glb = parseGlbBytes(new Uint8Array(rewrap.glb));
    const json = glb.json;
    const { all: prims } = drawnPrimitives(json);

    // 2. the wear, with defaults scaled to the object
    const wearIn = options.wear === null ? null : options.wear ?? {};
    const edgeWidthM = finiteOr(wearIn?.edgeWidthM, Math.max(2.5 * texelM, 0.0025 * diag));
    const wear = wearIn === null ? null : {
        edgeWear: clamp01(finiteOr(wearIn.edgeWear, 0.6)), grime: clamp01(finiteOr(wearIn.grime, 0.5)), streaks: clamp01(finiteOr(wearIn.streaks, 0.3)),
        dust: clamp01(finiteOr(wearIn.dust, 0.25)), sunFade: clamp01(finiteOr(wearIn.sunFade, 0.15)), variation: clamp01(finiteOr(wearIn.variation, 0.35)),
        edgeWidthM: Math.max(texelM, edgeWidthM), creaseWidthM: Math.max(texelM, finiteOr(wearIn.creaseWidthM, 2 * edgeWidthM)),
        aoRadiusM: Math.max(4 * texelM, finiteOr(wearIn.aoRadiusM, 0.08 * diag)), streakReachM: Math.max(4 * texelM, finiteOr(wearIn.streakReachM, 0.25 * Math.max(size[1], 1e-3))),
        grimeColor: (wearIn.grimeColor ?? [0.045, 0.038, 0.03]).map(clamp01) as Rgb,
        streakColor: (wearIn.streakColor ?? [0.06, 0.05, 0.04]).map(clamp01) as Rgb,
        dustColor: (wearIn.dustColor ?? [0.42, 0.39, 0.34]).map(clamp01) as Rgb,
        seed: Math.round(finiteOr(wearIn.seed, 7)) >>> 0,
        patchScaleM: 0.25 * diag, streakColumnM: Math.max(2 * texelM, 0.012 * diag)
    };

    // parts (groups) and their overrides
    const groupOfNode = new Map<number, number>();
    const groupNames: string[] = [];
    for (const p of prims) {
        if (leftMeshes.has(p.mesh) || groupOfNode.has(p.node)) continue;
        groupOfNode.set(p.node, groupNames.length);
        groupNames.push(partName(json, p.node));
    }
    const needPart = (name: string, what: string): number[] => {
        const gs = groupNames.flatMap((n, g) => (n === name ? [g] : []));
        if (!gs.length) throw new Error(`${what}: no part "${name}" in the object (its parts: ${[...new Set(groupNames)].join(', ')})`);
        return gs;
    };
    const partWear = groupNames.map(() => ({ edgeWear: 1, grime: 1, streaks: 1, dust: 1, sunFade: 1, edgeColor: undefined as Rgb | undefined, edgeRoughness: -1, edgeMetalness: -1 }));
    for (const o of options.parts ?? []) {
        for (const g of needPart(o.part, 'parts')) {
            const w = partWear[g];
            w.edgeWear = Math.max(0, finiteOr(o.edgeWear, 1)); w.grime = Math.max(0, finiteOr(o.grime, 1)); w.streaks = Math.max(0, finiteOr(o.streaks, 1));
            w.dust = Math.max(0, finiteOr(o.dust, 1)); w.sunFade = Math.max(0, finiteOr(o.sunFade, 1));
            if (o.edgeColor) w.edgeColor = o.edgeColor.map(clamp01) as Rgb;
            if (o.edgeRoughness !== undefined) w.edgeRoughness = clamp01(o.edgeRoughness);
            if (o.edgeMetalness !== undefined) w.edgeMetalness = clamp01(o.edgeMetalness);
        }
    }

    // atlases: the materials the rewrap gave an atlas, with the primitives drawn with them
    interface AtlasJob { material: number; width: number; height: number; base?: Uint8Array; mr?: Uint8Array; factor: [number, number, number, number]; roughness: number; metalness: number; transmission: number; prims: Prim[] }
    const jobs: AtlasJob[] = [];
    const materialsReport: ObjectDetailReport['materials'] = [];
    const decodeTexture = (texIndex: number | undefined, W: number, H: number): Uint8Array | undefined => {
        if (texIndex === undefined) return undefined;
        const tex = json.textures?.[texIndex];
        const im = tex !== undefined ? json.images?.[tex.source] : undefined;
        if (!im || im.bufferView === undefined) throw new Error(`texture ${texIndex} has no embedded image`);
        const bv = json.bufferViews[im.bufferView];
        const img = decodeImageInMemory(glb.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength));
        if (img.width !== W || img.height !== H) throw new Error(`texture ${texIndex} is ${img.width} x ${img.height}, not its atlas's ${W} x ${H}`);
        return img.rgba;
    };
    for (const at of rewrap.report.atlases) {
        const mi = at.material;
        const atlasPrims = prims.filter(p => !leftMeshes.has(p.mesh) && (p.def.material ?? -1) === (mi ?? -1) && firstNodeOfMesh.get(p.mesh) === p.node);
        if (at.status === 'skipped' || mi === null) {
            materialsReport.push({ material: mi ?? -1, ...(mi !== null && json.materials?.[mi]?.name ? { name: json.materials[mi].name } : {}), width: 0, height: 0, texels: 0, weathered: false, reason: mi === null ? 'its primitives have no material to carry the maps' : at.skippedReason ?? 'not unwrapped' });
            continue;
        }
        const m = json.materials[mi];
        const pbr = m.pbrMetallicRoughness ?? {};
        jobs.push({
            material: mi, width: at.width, height: at.height,
            base: decodeTexture(pbr.baseColorTexture?.index, at.width, at.height), mr: decodeTexture(pbr.metallicRoughnessTexture?.index, at.width, at.height),
            factor: (pbr.baseColorFactor ?? [1, 1, 1, 1]) as [number, number, number, number], roughness: finiteOr(pbr.roughnessFactor, 1), metalness: finiteOr(pbr.metallicFactor, 1),
            transmission: finiteOr(m.extensions?.KHR_materials_transmission?.transmissionFactor, 0), prims: atlasPrims
        });
    }
    if (!jobs.length) throw new Error(`no material of the object could be given an atlas: ${materialsReport.map(r => r.reason).join('; ')}`);

    // surfaces (object space, atlas UVs in texels) and every triangle as an occluder
    const surfaceBufs: Buffer[] = [];
    let surfaceCount = 0;
    const occ: number[] = [];
    for (const p of prims) {
        if (p.def.attributes?.POSITION === undefined) continue;
        const pos = readAccessor(glb, p.def.attributes.POSITION).data;
        const idx = triangleIndices(glb, p.def, pos.length / 3);
        if (!idx) continue;
        for (let k = 0; k + 2 < idx.length; k += 3) for (let j = 0; j < 3; j++) occ.push(...xf(p.world, pos[idx[k + j] * 3], pos[idx[k + j] * 3 + 1], pos[idx[k + j] * 3 + 2]));
    }
    jobs.forEach((job, a) => {
        for (const p of job.prims) {
            const V = json.accessors[p.def.attributes.POSITION].count;
            const pos = readAccessor(glb, p.def.attributes.POSITION).data;
            const nrm = p.def.attributes.NORMAL !== undefined ? readAccessor(glb, p.def.attributes.NORMAL).data : undefined;
            const uv = readAccessor(glb, p.def.attributes.TEXCOORD_0).data;
            const idx = triangleIndices(glb, p.def, V)!;
            const NM = normalMatrix(p.world);
            const wp = new Float32Array(V * 3), wn = nrm ? new Float32Array(V * 3) : undefined, px = new Float32Array(V * 2);
            for (let v = 0; v < V; v++) {
                wp.set(xf(p.world, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]), v * 3);
                if (wn && nrm) {
                    const x = nrm[v * 3], y = nrm[v * 3 + 1], z = nrm[v * 3 + 2];
                    const n = [NM[0] * x + NM[3] * y + NM[6] * z, NM[1] * x + NM[4] * y + NM[7] * z, NM[2] * x + NM[5] * y + NM[8] * z];
                    const l = Math.hypot(n[0], n[1], n[2]) || 1;
                    wn.set([n[0] / l, n[1] / l, n[2] / l], v * 3);
                }
                px[v * 2] = uv[v * 2] * job.width; px[v * 2 + 1] = uv[v * 2 + 1] * job.height;
            }
            surfaceBufs.push(u32(a, groupOfNode.get(p.node)!, V, idx.length / 3, wn ? 1 : 0), view(wp), ...(wn ? [view(wn)] : []), view(px), view(idx));
            surfaceCount++;
        }
    });

    // decals: their parts, frame and box
    const decalBufs: Buffer[] = [];
    const decalReport: ObjectDetailReport['decals'] = [];
    for (const d of options.decals ?? []) {
        if (!d.parts?.length) throw new Error('a decal names the parts it lies on');
        const groups = [...new Set(d.parts.flatMap(n => needPart(n, 'decal')))];
        const { N, R, U } = frame(d.facing, d.up);
        // the parts' extent seen from the decal
        let mnR = Infinity, mxR = -Infinity, mnU = Infinity, mxU = -Infinity, mnN = Infinity, mxN = -Infinity;
        for (const job of jobs) for (const p of job.prims) {
            if (!groups.includes(groupOfNode.get(p.node)!)) continue;
            const pos = readAccessor(glb, p.def.attributes.POSITION).data;
            for (let v = 0; v < pos.length / 3; v++) {
                const q = xf(p.world, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
                const r = q[0] * R[0] + q[1] * R[1] + q[2] * R[2], u = q[0] * U[0] + q[1] * U[1] + q[2] * U[2], n = q[0] * N[0] + q[1] * N[1] + q[2] * N[2];
                mnR = Math.min(mnR, r); mxR = Math.max(mxR, r); mnU = Math.min(mnU, u); mxU = Math.max(mxU, u); mnN = Math.min(mnN, n); mxN = Math.max(mxN, n);
            }
        }
        if (!Number.isFinite(mnR)) throw new Error(`a decal on ${d.parts.join(', ')}: those parts have no surface the pass weathers`);
        const [ax, ay] = d.at ?? [0.5, 0.5];
        const midN = 0.5 * (mnN + mxN);
        const c: Xyz = d.centerM ?? [0, 1, 2].map(k => R[k] * (mnR + ax * (mxR - mnR)) + U[k] * (mnU + ay * (mxU - mnU)) + N[k] * midN) as Xyz;
        const cN = c[0] * N[0] + c[1] * N[1] + c[2] * N[2];
        const depth = Math.max(mxN - cN, cN - mnN, 0) + 0.01 * diag;
        const [w, h] = d.sizeM;
        if (!(w > 0) || !(h > 0)) throw new Error('a decal needs a positive sizeM');
        if (d.image.rgba.length !== d.image.width * d.image.height * 4) throw new Error('a decal image is not RGBA');
        const hasFinish = d.roughness !== undefined || d.metalness !== undefined;
        decalBufs.push(u32(groups.length, ...groups), f32(...c, ...N, ...U, w, h, depth, clamp01(finiteOr(d.opacity, 1)), finiteOr(d.maxAngleDeg, 75),
            clamp01(finiteOr(d.roughness, 0.5)), clamp01(finiteOr(d.metalness, 0)), hasFinish ? 1 : 0), u32(d.image.width, d.image.height), Buffer.from(d.image.rgba.buffer, d.image.rgba.byteOffset, d.image.rgba.byteLength));
        decalReport.push({ parts: d.parts, texels: 0, sizeM: [w, h], label: d.label, method: d.method });
    }

    // 3. the bake
    const W = wear ?? { edgeWear: 0, grime: 0, streaks: 0, dust: 0, sunFade: 0, variation: 0, edgeWidthM, creaseWidthM: 2 * edgeWidthM, aoRadiusM: 0.08 * diag, streakReachM: 0.25 * Math.max(size[1], 1e-3), grimeColor: [0, 0, 0], streakColor: [0, 0, 0], dustColor: [0, 0, 0], seed: 7, patchScaleM: 0.25 * diag, streakColumnM: 0.012 * diag };
    const params = f64(W.edgeWear, W.grime, W.streaks, W.dust, W.sunFade, W.variation, W.edgeWidthM, W.creaseWidthM, W.aoRadiusM, W.streakReachM, W.streakColumnM,
        W.patchScaleM, 0.8 * W.edgeWidthM, 0.5, 0.9, ...W.grimeColor, ...W.streakColor, ...W.dustColor, 0.85, 0.75, 0.95,
        16, lo[1], Math.max(1e-6, 1e-5 * diag), Math.max(1e-5, 2e-5 * diag), W.seed);
    const atlasBufs: Buffer[] = [];
    for (const job of jobs) {
        atlasBufs.push(u32(job.width, job.height, 4, job.base ? 1 : 0, job.mr ? 1 : 0), f32(...job.factor, job.roughness, job.metalness, job.transmission, texelM));
        if (job.base) atlasBufs.push(Buffer.from(job.base.buffer, job.base.byteOffset, job.base.byteLength));
        if (job.mr) atlasBufs.push(Buffer.from(job.mr.buffer, job.mr.byteOffset, job.mr.byteLength));
    }
    const partBufs = partWear.map(w => Buffer.concat([f32(w.edgeWear, w.grime, w.streaks, w.dust, w.sunFade), u32(w.edgeColor ? 1 : 0), f32(...(w.edgeColor ?? [0, 0, 0]), w.edgeRoughness, w.edgeMetalness)]));
    const binary = options.native?.binaryPath ?? await ensureObjectDetailBinary(options.native?.repoRoot);
    const tb = performance.now();
    const reply = await runNative(binary, [
        Buffer.from('SBOD', 'latin1'),
        u32(1, jobs.length, surfaceCount, groupNames.length, decalReport.length, occ.length / 9, (options.masks ? 1 : 0) | 2, options.native?.threads ?? 0),
        params, ...atlasBufs, ...partBufs, ...surfaceBufs, view(Float32Array.from(occ)), ...decalBufs
    ], options.native?.timeoutMs ?? 600_000, options.signal);
    const bakeMs = performance.now() - tb;
    const r = new Reader(reply);
    if (r.u32() !== 1) throw new Error('the object detail bake replied with an unknown version');
    const A = r.u32(), G = r.u32(), D = r.u32();
    if (A !== jobs.length || G !== groupNames.length || D !== decalReport.length) throw new Error('the object detail bake reply does not match its request');
    const edgeCounts = { convex: r.u32(), concave: r.u32(), open: r.u32() };
    const nativeMs = { edges: r.f64(), bvh: r.f64(), masks: r.f64(), composite: r.f64(), dilate: r.f64() };
    const baked: Array<{ base: Uint8Array; mr: Uint8Array; texels: number }> = [];
    const masks: ObjectDetailMasks[] = [];
    for (const job of jobs) {
        const w = r.u32(), h = r.u32(), hasMasks = r.u32();
        const stats = [r.f64(), r.f64(), r.f64(), r.f64(), r.f64(), r.f64(), r.f64()];
        const n = w * h * 4;
        const base = r.bytes(n), mr = r.bytes(n);
        if (hasMasks) masks.push({ material: job.material, width: w, height: h, wear: r.bytes(n), light: r.bytes(n) });
        baked.push({ base, mr, texels: stats[0] });
    }
    const partStats = groupNames.map(() => [r.f64(), r.f64(), r.f64(), r.f64(), r.f64(), r.f64(), r.f64()]);
    for (const d of decalReport) d.texels = r.f64();

    // 4. the maps on each material: its own, with its pre-pass factors kept in its extras
    const te = performance.now();
    const writer = new GlbWriter(glb);
    const out = writer.json;
    out.samplers ??= [];
    out.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 });
    const sampler = out.samplers.length - 1;
    const usesOutside = (mi: number, inside: Prim[]) => (out.meshes as any[]).some((mesh, m) => (mesh.primitives ?? []).some((def: any, k: number) => (def.material ?? -1) === mi && !inside.some(p => p.mesh === m && p.primitive === k)));
    const layers = wear ? { edgeWear: wear.edgeWear, grime: wear.grime, streaks: wear.streaks, dust: wear.dust, sunFade: wear.sunFade } : undefined;
    // the maps encoded a few at a time (JPEG goes through ffmpeg; PNG where a base colour has alpha, or asked for)
    const jpeg = (options.imageFormat ?? 'jpeg') === 'jpeg';
    const encoded: Array<{ base: { bytes: Uint8Array; mime: string }; mr: { bytes: Uint8Array; mime: string } }> = new Array(jobs.length);
    const enc = async (rgba: Uint8Array, width: number, height: number, lossy: boolean) => lossy
        ? { bytes: await encodeRgbaToJpeg(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height, { quality: 92, chroma: '444' }), mime: 'image/jpeg' }
        : { bytes: encodePng(width, height, Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength)), mime: 'image/png' };
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, async () => {
        for (let a; (a = next++) < jobs.length;) {
            const { width, height } = jobs[a];
            let opaque = true;
            for (let i = 3; i < baked[a].base.length; i += 4) if (baked[a].base[i] < 255) { opaque = false; break; }
            encoded[a] = { base: await enc(baked[a].base, width, height, jpeg && opaque), mr: await enc(baked[a].mr, width, height, jpeg) };
        }
    }));
    for (const [a, job] of jobs.entries()) {
        let mi = job.material;
        // a material also drawn by a primitive outside its atlas (a left tree, a second instance) is split, never merged
        if (usesOutside(mi, job.prims)) {
            out.materials.push(JSON.parse(JSON.stringify(out.materials[mi])));
            const clone = out.materials.length - 1;
            for (const p of job.prims) out.meshes[p.mesh].primitives[p.primitive].material = clone;
            mi = clone;
        }
        const m = out.materials[mi];
        const pbr = (m.pbrMetallicRoughness ??= {});
        const before = { baseColorFactor: [...job.factor], roughnessFactor: job.roughness, metallicFactor: job.metalness, hadBaseColorTexture: !!job.base, hadMetallicRoughnessTexture: !!job.mr };
        const { width, height } = job;
        const { base: baseImg, mr: mrImg } = encoded[a];
        const name = String(m.name ?? `material_${mi}`);
        out.textures ??= [];
        out.textures.push({ sampler, source: writer.addImage(baseImg.bytes, baseImg.mime, `${name}_detail_base`) });
        pbr.baseColorTexture = { index: out.textures.length - 1 };
        out.textures.push({ sampler, source: writer.addImage(mrImg.bytes, mrImg.mime, `${name}_detail_mr`) });
        pbr.metallicRoughnessTexture = { index: out.textures.length - 1 };
        pbr.baseColorFactor = [1, 1, 1, job.factor[3] ?? 1];
        pbr.roughnessFactor = 1;
        pbr.metallicFactor = 1;
        m.extras = {
            ...(m.extras ?? {}),
            sbDetailPass: {
                label: 'generated', version: OBJECT_DETAIL_PASS_VERSION,
                method: 'geometry-driven wear and projected decals composited onto this material\'s own base colour and metallic-roughness (object_detail_pass)',
                ...(layers ? { layers } : {}), decals: decalReport.filter(d => d.parts.some(n => job.prims.some(p => partName(json, p.node) === n))).length,
                before
            }
        };
        materialsReport.push({ material: mi, ...(m.name ? { name: m.name } : {}), width, height, texels: baked[a].texels, weathered: true });
    }
    out.extras = {
        ...(out.extras ?? {}),
        sbDetailPass: { label: 'generated', version: OBJECT_DETAIL_PASS_VERSION, ...(wear ? { wear } : {}), decals: decalReport.map(d => ({ parts: d.parts, sizeM: d.sizeM, label: d.label, method: d.method })) }
    };
    const glbOut = writer.finish();
    const encodeMs = performance.now() - te;

    const partsReport: PartDetailReport[] = groupNames.map((name, g) => {
        const s = partStats[g], n = Math.max(1, s[0]);
        const node = [...groupOfNode.entries()].find(([, gg]) => gg === g)![0];
        const prim = prims.find(p => p.node === node);
        const mat = prim?.def.material !== undefined ? out.materials?.[out.meshes[prim.mesh].primitives[prim.primitive].material]?.name : undefined;
        return { part: name, node, ...(mat ? { material: mat } : {}), texels: s[0], edgeWear: s[1] / n, grime: s[2] / n, streaks: s[3] / n, dust: s[4] / n, exposure: s[5] / n, decal: s[6] / n };
    });
    const report: ObjectDetailReport = {
        version: OBJECT_DETAIL_PASS_VERSION, label: 'generated', wear, objectSizeM: size, texelsPerMeter, materials: materialsReport, parts: partsReport, decals: decalReport,
        left: rewrap.report.primitivesSkipped, featureEdges: edgeCounts,
        timings: { rewrapMs, bakeMs, encodeMs, totalMs: performance.now() - t0, native: nativeMs },
        rewrap: { charts: rewrap.report.charts, lscmCharts: rewrap.report.lscmCharts, utilisation: rewrap.report.utilisation, overlappingTrianglePairs: rewrap.report.overlappingTrianglePairs }
    };
    return { glb: glbOut, report, ...(options.masks ? { masks } : {}) };
}
