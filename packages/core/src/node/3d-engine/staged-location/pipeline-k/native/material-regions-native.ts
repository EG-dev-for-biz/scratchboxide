/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's material regions on the native kernel (when SCRATCHBOX_K_NATIVE runs `regions`, the default; native-switch.ts, material-regions-pool.ts): the per-texel work of
 * material-regions.ts (the appearance k-means, the harvest's texel classes, and planMaterialJob's masks, classes, tiles,
 * feathering and maps) runs in C++ (scratchbox_material_regions.hpp behind scripts/material_regions_native.cpp), built
 * through the native build cache. The GLB JSON, the triangles' plane choice, the band responses, the classes' formatting
 * and the report stay here, so each wrapper returns exactly what its TypeScript counterpart does. A failed build or run
 * throws; there is no fallback.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags, NativeBuildError } from '../../../native-build-cache';
import { readAccessor, type ParsedGlb } from '../../glb-bytes';
import type { RgbaImage8 } from '../../tile-texture-transfer';
import { GLASS_ROUGHNESS } from '../../facade-materials';
import type { FittedPlane } from '../../window-fit';
import { bandResponses, TEXTURE_BANDS_M } from '../material-harvest';
import {
    MATERIAL_REGIONS_PARAMS, materialPlanContext, materialPlanJobs, mergeMaterialPlan,
    type MaterialPlanContext, type MaterialPlanJob, type MaterialPlanPiece, type MaterialRegionsParams, type MaterialRegionsPlan, type RegionClass, type RegionSet
} from '../material-regions';

export type MaterialRegionsNativeErrorCode = 'build_failed' | 'run_failed' | 'invalid_output';

export class MaterialRegionsNativeError extends Error {
    constructor(public readonly code: MaterialRegionsNativeErrorCode, message: string) {
        super(message);
        this.name = 'MaterialRegionsNativeError';
    }
}

export interface MaterialRegionsNativeOptions {
    /** Kernel threads (default 0: every core). */
    threads?: number;
    /** Longest one run may take, not counting a first-use build (default 600 s). */
    timeoutMs?: number;
}

const CLI_SOURCE = path.join('scripts', 'material_regions_native.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const MAGIC = 0x524d4253, VERSION = 1;
const MODE = { tables: 0, classes: 1, harvest: 2, plan: 3 } as const;

/** The repository root: the first directory up from here (or the working directory) holding the CLI driver. */
export function findMaterialRegionsRepoRoot(): string {
    for (const start of [__dirname, process.cwd()]) {
        let dir = path.resolve(start);
        while (true) {
            if (fs.existsSync(path.join(dir, CLI_SOURCE))) return dir;
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    throw new MaterialRegionsNativeError('build_failed', `${CLI_SOURCE} not found above ${__dirname} or ${process.cwd()}`);
}

let building: Promise<string> | undefined;

/** The kernel's binary, built through the native build cache when its sources changed. */
export function ensureMaterialRegionsNativeBinary(repoRoot?: string): Promise<string> {
    if (building) return building;
    building = (async () => {
        const root = repoRoot ?? findMaterialRegionsRepoRoot();
        try {
            const built = await compileNativeCached({ sourcePath: path.join(root, CLI_SOURCE), includeDirs: [path.join(root, INCLUDE_DIR)], flags: defaultNativeFlags(), name: 'material_regions_native', timeoutMs: 300_000 });
            return built.binaryPath;
        } catch (err) {
            building = undefined;
            throw new MaterialRegionsNativeError('build_failed', `could not build material_regions_native: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
        }
    })();
    return building;
}

// ---- the request and result files (layout: scripts/material_regions_native.cpp) ----

/** A request written as a list of byte chunks (the photos are passed through, never concatenated). */
class RequestWriter {
    private parts: Uint8Array[] = [];
    private head = new DataView(new ArrayBuffer(1 << 16));
    private at = 0;
    private flush(): void { if (this.at) { this.parts.push(new Uint8Array(this.head.buffer.slice(0, this.at))); this.at = 0; } }
    private room(n: number): void { if (this.at + n > this.head.byteLength) this.flush(); }
    u8(v: number): this { this.room(1); this.head.setUint8(this.at, v); this.at += 1; return this; }
    u32(v: number): this { this.room(4); this.head.setUint32(this.at, v >>> 0, true); this.at += 4; return this; }
    f64(v: number): this { this.room(8); this.head.setFloat64(this.at, v, true); this.at += 8; return this; }
    bytes(b: Uint8Array): this { this.flush(); this.parts.push(b); return this; }
    f64s(v: ArrayLike<number>): this { return this.bytes(new Uint8Array(Float64Array.from(v).buffer)); }
    i32s(v: Int32Array): this { return this.bytes(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)); }
    rects(v: ArrayLike<number>): this { return this.u32(v.length).f64s(v); }
    image(img: RgbaImage8): this {
        if (img.rgba.length !== img.width * img.height * 4) throw new MaterialRegionsNativeError('run_failed', `an image's pixels (${img.rgba.length} bytes) do not match its ${img.width} x ${img.height} size`);
        return this.u32(img.width).u32(img.height).bytes(img.rgba);
    }
    async writeTo(file: string): Promise<void> {
        this.flush();
        const fh = await fs.promises.open(file, 'w');
        try { for (const p of this.parts) await fh.write(p); } finally { await fh.close(); }
    }
}

class ResultReader {
    private dv: DataView;
    at = 0;
    constructor(private buf: Buffer) { this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }
    private need(n: number): void { if (this.at + n > this.buf.length) throw new MaterialRegionsNativeError('invalid_output', `material_regions_native wrote a result truncated at byte ${this.at}`); }
    u8(): number { this.need(1); return this.dv.getUint8(this.at++); }
    u32(): number { this.need(4); const v = this.dv.getUint32(this.at, true); this.at += 4; return v; }
    f64(): number { this.need(8); const v = this.dv.getFloat64(this.at, true); this.at += 8; return v; }
    /** A copy of the next n bytes, in a buffer of its own. */
    bytes(n: number): Uint8Array { this.need(n); const out = new Uint8Array(n); out.set(this.buf.subarray(this.at, this.at + n)); this.at += n; return out; }
    f64s(n: number): Float64Array { return new Float64Array(this.bytes(n * 8).buffer); }
    f32s(n: number): Float32Array { return new Float32Array(this.bytes(n * 4).buffer); }
    i8s(n: number): Int8Array { return new Int8Array(this.bytes(n).buffer); }
    done(): void { if (this.at !== this.buf.length) throw new MaterialRegionsNativeError('invalid_output', `material_regions_native wrote ${this.buf.length - this.at} unread bytes`); }
}

/** Runs one request; returns a reader over its result, past the header. */
async function run(mode: number, body: (w: RequestWriter) => void, opts: MaterialRegionsNativeOptions = {}): Promise<ResultReader> {
    if (os.endianness() !== 'LE') throw new MaterialRegionsNativeError('run_failed', 'the native material regions layout is little-endian');
    const bin = await ensureMaterialRegionsNativeBinary();
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-material-regions-'));
    try {
        const req = path.join(dir, 'request.bin'), res = path.join(dir, 'result.bin');
        const w = new RequestWriter().u32(MAGIC).u32(VERSION).u32(mode).u32(Math.max(0, Math.floor(opts.threads ?? 0)));
        body(w);
        await w.writeTo(req);
        await new Promise<void>((resolve, reject) => {
            execFile(bin, [req, res], { timeout: opts.timeoutMs ?? 600_000, maxBuffer: 1 << 20, windowsHide: true }, (err, _stdout, stderr) => {
                if (err) reject(new MaterialRegionsNativeError('run_failed', `material_regions_native failed: ${String(stderr || err.message).trim().slice(-1500)}`));
                else resolve();
            });
        });
        const r = new ResultReader(await fs.promises.readFile(res));
        if (r.u32() !== MAGIC || r.u32() !== VERSION || r.u32() !== mode) throw new MaterialRegionsNativeError('invalid_output', 'material_regions_native wrote a result with the wrong header');
        return r;
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
}

/** Indexes the distinct images a request carries. */
function imageTable(): { add: (img: RgbaImage8) => number; list: RgbaImage8[] } {
    const index = new Map<RgbaImage8, number>(), list: RgbaImage8[] = [];
    return { list, add: img => { let i = index.get(img); if (i === undefined) { i = list.length; list.push(img); index.set(img, i); } return i; } };
}

// ---- the GLB, as material-regions.ts reads it ----

const REBUILT_FACADE = /^facade_lattice_\d+$/;
const dot3 = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function photoOf(json: any, material: number | undefined): { image: number; texCoord: number } | undefined {
    if (material === undefined) return undefined;
    const t = json.materials?.[material]?.pbrMetallicRoughness?.baseColorTexture;
    const image = t ? json.textures?.[t.index]?.source : undefined;
    return image === undefined ? undefined : { image, texCoord: t.texCoord ?? 0 };
}

function photoMaterials(json: any): { rebuilt: Map<number, string>; other: Set<number> } {
    const rebuilt = new Map<number, string>(), other = new Set<number>();
    for (const mesh of json.meshes ?? []) for (const prim of mesh.primitives ?? []) {
        if (prim.material === undefined || !photoOf(json, prim.material)) continue;
        if (REBUILT_FACADE.test(mesh.name ?? '')) rebuilt.set(prim.material, mesh.name); else other.add(prim.material);
    }
    for (const mi of rebuilt.keys()) other.delete(mi);
    return { rebuilt, other };
}

function forEachTriangleOf(g: ParsedGlb, json: any, material: number, fn: (p: Float64Array, uv: Float64Array) => void): void {
    const p = new Float64Array(9), q = new Float64Array(6);
    for (const mesh of json.meshes ?? []) for (const prim of mesh.primitives ?? []) {
        if ((prim.mode ?? 4) !== 4 || prim.material !== material || prim.attributes?.POSITION === undefined) continue;
        const photo = photoOf(json, material);
        const uvAcc = photo ? prim.attributes[`TEXCOORD_${photo.texCoord}`] : undefined;
        if (uvAcc === undefined) continue;
        const pos = readAccessor(g, prim.attributes.POSITION).data, uv = readAccessor(g, uvAcc).data;
        const idx = prim.indices !== undefined ? readAccessor(g, prim.indices).data : undefined;
        const n = idx ? idx.length : pos.length / 3;
        for (let t = 0; t + 2 < n; t += 3) {
            for (let k = 0; k < 3; k++) {
                const i = idx ? idx[t + k] : t + k;
                p[k * 3] = pos[i * 3]; p[k * 3 + 1] = pos[i * 3 + 1]; p[k * 3 + 2] = pos[i * 3 + 2]; q[k * 2] = uv[i * 2]; q[k * 2 + 1] = uv[i * 2 + 1];
            }
            fn(p, q);
        }
    }
}

function texelMetres(g: ParsedGlb, json: any, material: number, img: RgbaImage8): number {
    let world = 0, texels = 0;
    forEachTriangleOf(g, json, material, (p, uv) => {
        const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
        world += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        texels += 0.5 * Math.abs((uv[2] - uv[0]) * img.width * (uv[5] - uv[1]) * img.height - (uv[4] - uv[0]) * img.width * (uv[3] - uv[1]) * img.height);
    });
    return texels > 0 ? Math.sqrt(world / texels) : 0;
}

/** One of a rebuilt facade's lattice extras (sbFacadeLattice): `windows.uv`, `windows.panes`, `structure.uv` or `structure.bays`. */
function latticeRects(json: any, meshName: string, group: 'windows' | 'structure', key: string, allowEmpty: boolean): number[] | undefined {
    const mi = (json.meshes ?? []).findIndex((m: any) => m.name === meshName);
    const uv = (json.nodes ?? []).find((n: any) => n.mesh === mi && n.extras?.sbFacadeLattice?.[group])?.extras.sbFacadeLattice[group][key];
    return Array.isArray(uv) && uv.length % 4 === 0 && (allowEmpty || uv.length) ? uv : undefined;
}
const fittedWindows = (json: any, mesh: string) => latticeRects(json, mesh, 'windows', 'uv', true);
const fittedPanes = (json: any, mesh: string) => latticeRects(json, mesh, 'windows', 'panes', false);
const structureRuns = (json: any, mesh: string) => latticeRects(json, mesh, 'structure', 'uv', false);
const structureBays = (json: any, mesh: string) => latticeRects(json, mesh, 'structure', 'bays', false);

// ---- readRegionClasses ----

/** labOf's tables as the kernel computes them: SRGB8_TO_LINEAR and the 32768 CIELAB buckets (key (r>>3)<<10 | (g>>3)<<5 | b>>3). */
export async function materialRegionsNativeColourTables(opts: MaterialRegionsNativeOptions = {}): Promise<{ srgb8ToLinear: Float32Array; lab: Float64Array }> {
    const r = await run(MODE.tables, () => undefined, opts);
    const out = { srgb8ToLinear: r.f32s(256), lab: r.f64s(32768 * 3) };
    r.done();
    return out;
}

/** readRegionClasses (material-regions.ts) with its sampling, k-means and harvest texels on the native kernel: the same classes. */
export async function readRegionClassesNative(json: any, images: Map<number, RgbaImage8>, P: MaterialRegionsParams = MATERIAL_REGIONS_PARAMS, harvest?: { g: ParsedGlb }, opts: MaterialRegionsNativeOptions = {}): Promise<RegionClass[] | undefined> {
    const { rebuilt } = photoMaterials(json);
    const excludedRects = new Map<number, number[]>();
    if (harvest) for (const [mi, mesh] of rebuilt) if (images.get(photoOf(json, mi)!.image)) excludedRects.set(mi, [...(fittedWindows(json, mesh) ?? []), ...(fittedPanes(json, mesh) ?? [])]);
    const table = imageTable(), photos: Array<{ image: number; ex?: number[] }> = [];
    for (const mi of rebuilt.keys()) {
        const img = images.get(photoOf(json, mi)!.image);
        if (!img) continue;
        photos.push({ image: table.add(img), ex: excludedRects.get(mi) });
    }
    const wL = harvest ? 0.5 : 1, K = P.classes;
    const r = await run(MODE.classes, w => {
        w.u32(table.list.length);
        for (const img of table.list) w.image(img);
        w.u32(photos.length);
        for (const ph of photos) w.u32(ph.image).u8(ph.ex ? 1 : 0).rects(ph.ex ?? []);
        w.u32(P.samplesPerPhoto).u32(P.seed >>> 0).u32(K).u32(P.iterations).f64(wL);
    }, opts);
    const n = r.u32(), ok = r.u8() === 1;
    if (!ok) { r.done(); return undefined; }
    const Cf = r.f64s(K * 3), count = r.f64s(K), sdf = r.f64s(K * 3);
    r.done();
    const C = Array.from({ length: K }, (_, k) => [Cf[k * 3], Cf[k * 3 + 1], Cf[k * 3 + 2]]);
    // the classes' formatting, as readRegionClasses does it
    const idx = C.map((_, k) => k).sort((a, b) => C[a][0] - C[b][0]);
    const classes: RegionClass[] = idx.map((k, rank) => {
        const cnt = count[k], sd = [sdf[k * 3], sdf[k * 3 + 1], sdf[k * 3 + 2]];
        const [L, a, b] = C[k];
        const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
        const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
        const Xw = inv(fx) * 0.95047, Yw = inv(fy), Zw = inv(fz) * 1.08883;
        const lin: [number, number, number] = [3.2406 * Xw - 1.5372 * Yw - 0.4986 * Zw, -0.9689 * Xw + 1.8758 * Yw + 0.0415 * Zw, 0.0557 * Xw - 0.204 * Yw + 1.057 * Zw].map(v => Math.max(0, Math.min(1, v))) as [number, number, number];
        const r2 = (v: number) => Math.round(v * 100) / 100;
        return {
            index: rank, meanLab: [r2(L), r2(a), r2(b)], meanLinear: lin.map(r2) as [number, number, number],
            spreadLab: sd.map(v => r2(Math.sqrt(v / Math.max(1, cnt)))) as [number, number, number],
            share: Math.round((cnt / n) * 1000) / 1000, wall: rank === K - 1
        };
    });
    if (harvest) await harvestTexturesNative(harvest.g, json, images, rebuilt, excludedRects, classes, wL, opts);
    return classes;
}

/** The harvest's texture per class (readRegionClasses' harvestTextures): the texels' classes native, the band responses here. */
async function harvestTexturesNative(g: ParsedGlb, json: any, images: Map<number, RgbaImage8>, rebuilt: Map<number, string>, excludedRects: Map<number, number[]>, classes: RegionClass[], wL: number, opts: MaterialRegionsNativeOptions): Promise<void> {
    const K = classes.length, B = TEXTURE_BANDS_M.length;
    const sq = Array.from({ length: K }, () => new Float64Array(B)), lum = Array.from({ length: K }, () => new Float64Array(B)), cnt = Array.from({ length: K }, () => new Float64Array(B));
    const texelSum = new Float64Array(K), texelN = new Float64Array(K), facades = new Int32Array(K);
    const table = imageTable(), photos: Array<{ img: RgbaImage8; image: number; texelM: number; ex?: number[] }> = [];
    for (const [mi] of rebuilt) {
        const img = images.get(photoOf(json, mi)!.image);
        if (!img) continue;
        const texelM = texelMetres(g, json, mi, img);
        if (!(texelM > 0)) continue;
        photos.push({ img, image: table.add(img), texelM, ex: excludedRects.get(mi) });
    }
    if (photos.length) {
        const r = await run(MODE.harvest, w => {
            w.u32(table.list.length);
            for (const img of table.list) w.image(img);
            w.u32(K).f64s(classes.flatMap(c => c.meanLab)).f64(wL);
            w.u32(photos.length);
            for (const ph of photos) w.u32(ph.image).u8(ph.ex ? 1 : 0).rects(ph.ex ?? []);
        }, opts);
        if (r.u32() !== photos.length) throw new MaterialRegionsNativeError('invalid_output', 'material_regions_native returned the wrong number of harvest photos');
        const read = photos.map(ph => {
            const N = r.u32();
            if (N !== ph.img.width * ph.img.height) throw new MaterialRegionsNativeError('invalid_output', 'material_regions_native returned a harvest photo of the wrong size');
            return { valid: r.bytes(N), L: r.f32s(N), cls: r.i8s(N) };
        });
        r.done();
        photos.forEach((ph, p) => {
            const { valid, L, cls } = read[p], N = valid.length, share = new Float64Array(K);
            for (let i = 0; i < N; i++) if (cls[i] >= 0) share[cls[i]]++;
            const total = share.reduce((a, b) => a + b, 0);
            if (!total) return;
            for (let k = 0; k < K; k++) if (share[k] / total >= 0.05) facades[k]++;
            const rs = bandResponses(L, ph.img.width, ph.img.height, ph.texelM, valid);
            for (let i = 0; i < N; i++) {
                const k = cls[i];
                if (k < 0) continue;
                texelSum[k] += ph.texelM; texelN[k]++;
                for (let b = 0; b < B; b++) if (Number.isFinite(rs[b][i])) { sq[k][b] += rs[b][i] * rs[b][i]; lum[k][b] += L[i]; cnt[k][b]++; }
            }
        });
    }
    classes.forEach((c, k) => {
        if (!texelN[k]) return;
        c.texture = { texelM: Math.round((texelSum[k] / texelN[k]) * 1e4) / 1e4, energy: Array.from({ length: B }, (_, b) => { if (!cnt[k][b]) return NaN; const m = lum[k][b] / cnt[k][b]; return m > 0 ? Math.round((sq[k][b] / cnt[k][b] / (m * m)) * 1e6) / 1e6 : NaN; }) };
        c.facades = facades[k];
    });
}

// ---- planMaterialJob ----

type PlaneRaster = ReturnType<MaterialPlanContext['rasters']>[number];

interface PreparedJob {
    /** The job's place in the batch. */
    at: number; job: MaterialPlanJob; img: RgbaImage8; image: number; texelM: number;
    rebuilt?: { fitted: number[]; panes: number[]; runs: number[]; bays: number[] };
    scan?: { tris: Float64Array; plane: Uint32Array; count: number; used: Set<number> };
}

/** A scan piece's triangles on their nearest fitted plane (planMaterialJob's choice), with their corners' plane coordinates. */
function scanTriangles(job: MaterialPlanJob, ctx: MaterialPlanContext, rasters: PlaneRaster[]): NonNullable<PreparedJob['scan']> {
    const { g, json, P } = ctx, used = new Set<number>();
    const tris: number[] = [], plane: number[] = [];
    if (rasters.length) forEachTriangleOf(g, json, job.material, (p, uv) => {
        const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
        const nn = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], nl = Math.hypot(nn[0], nn[1], nn[2]);
        if (!(nl > 0)) return;
        const c = [(p[0] + p[3] + p[6]) / 3, (p[1] + p[4] + p[7]) / 3, (p[2] + p[5] + p[8]) / 3];
        let best = -1, bd = Infinity;
        for (let ri = 0; ri < rasters.length; ri++) {
            const r = rasters[ri];
            if (dot3(nn, r.pl.normal) / nl < P.planeCos) continue;
            const d = Math.abs(dot3(c, r.pl.normal) - r.off);
            if (d > P.planeBandM || d >= bd) continue;
            const sc = dot3(c, r.pl.axisS) - dot3(r.pl.centroid, r.pl.axisS), tc = dot3(c, r.pl.axisT) - dot3(r.pl.centroid, r.pl.axisT);
            if (sc < r.pl.orthoSMin || sc > r.pl.orthoSMin + r.pl.width * r.pl.pixel || tc > r.pl.orthoTMax || tc < r.pl.orthoTMax - r.pl.height * r.pl.pixel) continue;
            best = ri; bd = d;
        }
        if (best < 0) return;
        const { pl } = rasters[best];
        used.add(pl.facadeId);
        const s0 = dot3(pl.centroid, pl.axisS), t0 = dot3(pl.centroid, pl.axisT);
        plane.push(best);
        tris.push(uv[0], uv[1], uv[2], uv[3], uv[4], uv[5],
            dot3([p[0], p[1], p[2]], pl.axisS) - s0, dot3([p[3], p[4], p[5]], pl.axisS) - s0, dot3([p[6], p[7], p[8]], pl.axisS) - s0,
            dot3([p[0], p[1], p[2]], pl.axisT) - t0, dot3([p[3], p[4], p[5]], pl.axisT) - t0, dot3([p[6], p[7], p[8]], pl.axisT) - t0);
    });
    return { tris: Float64Array.from(tris), plane: Uint32Array.from(plane), count: plane.length, used };
}

/** planMaterialJob (material-regions.ts) for a batch of jobs in one native run: the same pieces, in the jobs' order. */
export async function planMaterialJobsNative(jobs: MaterialPlanJob[], ctx: MaterialPlanContext, opts: MaterialRegionsNativeOptions = {}): Promise<MaterialPlanPiece[]> {
    const { g, json, images, classes, sets, P } = ctx;
    const K = classes.length;
    const pieces: MaterialPlanPiece[] = jobs.map(() => ({ withWindows: false, panesOnStone: 0, baysOnStone: 0, texels: { total: 0, glass: 0 } }));
    const table = imageTable(), prepared: Array<PreparedJob | undefined> = [];
    let rasters: PlaneRaster[] | undefined;
    for (const [at, job] of jobs.entries()) {
        const img = images.get(photoOf(json, job.material)!.image)!;
        if (job.kind === 'rebuilt') {
            const texelM = texelMetres(g, json, job.material, img);
            if (!(texelM > 0)) { prepared.push(undefined); continue; }
            const mesh = job.mesh!;
            prepared.push({ at, job, img, image: table.add(img), texelM, rebuilt: { fitted: fittedWindows(json, mesh) ?? [], panes: fittedPanes(json, mesh) ?? [], runs: structureRuns(json, mesh) ?? [], bays: structureBays(json, mesh) ?? [] } });
        } else {
            rasters ??= ctx.rasters();
            prepared.push({ at, job, img, image: table.add(img), texelM: texelMetres(g, json, job.material, img), scan: scanTriangles(job, ctx, rasters) });
        }
    }
    const work = prepared.filter((p): p is PreparedJob => !!p);
    if (!work.length) return pieces;
    const planes = work.some(p => p.scan?.count) ? rasters! : [];
    const r = await run(MODE.plan, w => {
        w.u32(table.list.length);
        for (const img of table.list) w.image(img);
        w.u32(K).f64s(classes.flatMap(c => c.meanLab));
        for (let k = 0; k < K; k++) w.f64(sets[k].realSizeM[0]).f64(sets[k].realSizeM[1]).image(sets[k].normal).image(sets[k].orm);
        w.f64s(ctx.setMeans.slice(0, K).map(m => m[1])).f64(ctx.wallMean[1]);
        w.f64(P.paneWallShare).f64(P.glassFeatherM).f64(P.paneGlassWeight).f64(GLASS_ROUGHNESS);
        w.u32(planes.length);
        for (const ra of planes) {
            const { pl } = ra;
            w.u32(pl.width).u32(pl.height).f64(pl.orthoSMin).f64(pl.orthoTMax).f64(pl.pixel).u8(ra.storey ? 1 : 0).f64(ra.storey?.pitch ?? 0).f64(ra.storey?.phase ?? 0);
            w.bytes(ra.win).i32s(ra.bay).i32s(ra.pane).u32(ra.panedBays.size).i32s(Int32Array.from(ra.panedBays));
        }
        w.u32(work.length);
        for (const p of work) {
            w.u32(p.rebuilt ? 0 : 1).u32(p.image).f64(p.texelM);
            if (p.rebuilt) w.rects(p.rebuilt.fitted).rects(p.rebuilt.panes).rects(p.rebuilt.runs).rects(p.rebuilt.bays);
            else {
                // per triangle: u32 plane, f64 uv[6], sv[3], tv[3]
                const s = p.scan!, buf = new DataView(new ArrayBuffer(s.count * 100));
                for (let t = 0; t < s.count; t++) {
                    buf.setUint32(t * 100, s.plane[t], true);
                    for (let c = 0; c < 12; c++) buf.setFloat64(t * 100 + 4 + c * 8, s.tris[t * 12 + c], true);
                }
                w.u32(s.count).bytes(new Uint8Array(buf.buffer));
            }
        }
    }, opts);
    if (r.u32() !== work.length) throw new MaterialRegionsNativeError('invalid_output', 'material_regions_native returned the wrong number of jobs');
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    for (const p of work) {
        const kind = r.u32(), W = r.u32(), H = r.u32(), frameClass = r.u32(), N = W * H;
        if (kind !== (p.rebuilt ? 0 : 1) || W !== p.img.width || H !== p.img.height || frameClass >= K) throw new MaterialRegionsNativeError('invalid_output', 'material_regions_native returned a job that does not match its request');
        const piece = pieces[p.at];
        if (p.rebuilt) {
            const [windowN, stoneN, paneN, panesOnStone, baysOnStone, texels, glass] = Array.from({ length: 7 }, () => r.f64());
            const orm = { width: W, height: H, rgba: r.bytes(N * 4) }, normal = { width: W, height: H, rgba: r.bytes(N * 4) }, params = { width: W, height: H, rgba: r.bytes(N * 4) };
            const { fitted, bays } = p.rebuilt, mesh = p.job.mesh!;
            piece.panesOnStone += panesOnStone; piece.baysOnStone += baysOnStone;
            piece.texels.total += texels; piece.texels.glass += glass;
            piece.withWindows = windowN > 0;
            piece.facade = {
                mesh, texelM: Math.round(p.texelM * 1e4) / 1e4, fittedWindows: fitted.length / 4, bays: bays.length / 4,
                windowShare: r3(windowN / N), glassShare: r3(paneN / N), structureShare: r3(stoneN / N), frameSet: sets[frameClass].name
            };
            piece.planned = { material: p.job.material, orm, normal, params, rebuilt: true, glass: paneN > 0 };
        } else {
            const [onPlane, inWindows, inPanes, texels, glass, panesOnStone, baysOnStone, anyGlass] = Array.from({ length: 8 }, () => r.f64());
            const orm = { width: W, height: H, rgba: r.bytes(N * 4) }, params = { width: W, height: H, rgba: r.bytes(N * 4) };
            piece.baysOnStone += baysOnStone; piece.panesOnStone += panesOnStone;
            piece.texels.total += texels; piece.texels.glass += glass;
            piece.planned = { material: p.job.material, orm, params, rebuilt: false, glass: anyGlass === 1 };
            piece.scan = { texels: N, onPlane, inWindows, inPanes, planes: [...p.scan!.used] };
        }
    }
    r.done();
    return pieces;
}

/** planMaterialJob (material-regions.ts) on the native kernel: the same piece. */
export async function planMaterialJobNative(job: MaterialPlanJob, ctx: MaterialPlanContext, opts: MaterialRegionsNativeOptions = {}): Promise<MaterialPlanPiece> {
    return (await planMaterialJobsNative([job], ctx, opts))[0];
}

/** planMaterialRegions (material-regions.ts) with every job in one native run: the same plan, its report's ms the wall time. */
export async function planMaterialRegionsNative(g: ParsedGlb, json: any, images: Map<number, RgbaImage8>, classes: RegionClass[], sets: RegionSet[], planes: FittedPlane[] = [], P: MaterialRegionsParams = MATERIAL_REGIONS_PARAMS, opts: MaterialRegionsNativeOptions = {}): Promise<MaterialRegionsPlan> {
    const t0 = Date.now();
    const ctx = materialPlanContext(g, json, images, classes, sets, planes, P);
    const pieces = await planMaterialJobsNative(materialPlanJobs(json, images), ctx, opts);
    return mergeMaterialPlan(json, classes, sets, pieces, Date.now() - t0);
}
