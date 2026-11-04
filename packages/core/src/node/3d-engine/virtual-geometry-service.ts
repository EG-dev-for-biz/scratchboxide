/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags, hashIncludeClosure } from './native-build-cache';
import { NativeCppCompilerService } from './native-compiler-service';
import { parseSbvgHeader, SBVG_HEADER_BYTES, SBVG_VERSION } from '../../browser/generative-canvas/services/virtual-geometry/sbvg-format';

/**
 * Driver for `scratchbox_virtual_geometry.hpp`: GLB in, streamable cluster LOD DAG (.sbvg) out,
 * build statistics as one JSON line on stdout.
 */
export const VIRTUAL_GEOMETRY_BUILDER_SOURCE = `
#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_lod_retexture.hpp"
#include "scratchbox_virtual_geometry.hpp"
#include <chrono>
#include <cstdio>
using namespace scratchbox::vgeo;

int main(int argc, char** argv) {
    if (argc < 3) { std::fprintf(stderr, "usage: sbvg_builder <input.glb> <output.sbvg> [atlas stem]\\n"); return 2; }
    const std::string atlasStem = argc > 3 ? argv[3] : "";
    try {
        auto t0 = std::chrono::steady_clock::now();
        SourceMesh src = GlbSceneLoader::loadFile(argv[1]);
        WeldedMesh mesh = weld(src);
        auto t1 = std::chrono::steady_clock::now();
        // With materials, every coarse level is re-textured into an atlas of its own, so its
        // simplification may cross UV seams and material borders.
        scratchbox::gltf::GltfScene scene;
        RetextureOptions retex;
        const RetextureOptions* retexPtr = nullptr;
        if (mesh.materialCount > 0) {
            scene = scratchbox::gltf::GlbSceneReader::readFile(argv[1]);
            if (!scene.ok) throw std::runtime_error("materials: " + scene.error);
            retex.sampleLevel0 = [&scene](uint32_t material, const F2& uv) {
                if (material >= scene.materials.size()) return F3(1, 1, 1);
                const auto& m = scene.materials[material];
                F3 base(m.baseColorFactor.x, m.baseColorFactor.y, m.baseColorFactor.z);
                if (m.baseColorImage >= 0 && m.baseColorImage < static_cast<int>(scene.images.size()) && scene.images[static_cast<size_t>(m.baseColorImage)].decoded) {
                    const F3 t = retex::sampleImageLinear(scene.images[static_cast<size_t>(m.baseColorImage)].pixels, uv, m.wrapS, m.wrapT);
                    base = F3(base.x * t.x, base.y * t.y, base.z * t.z);
                }
                return base;
            };
            retex.sampleEmissionLevel0 = [&scene](uint32_t material, const F2& uv) {
                if (material >= scene.materials.size()) return F3(0, 0, 0);
                const auto& m = scene.materials[material];
                F3 e(m.emissiveFactor.x, m.emissiveFactor.y, m.emissiveFactor.z);
                if (e.x <= 0.0f && e.y <= 0.0f && e.z <= 0.0f) return F3(0, 0, 0);
                if (m.emissiveImage >= 0 && m.emissiveImage < static_cast<int>(scene.images.size()) && scene.images[static_cast<size_t>(m.emissiveImage)].decoded) {
                    const F3 t = retex::sampleImageLinear(scene.images[static_cast<size_t>(m.emissiveImage)].pixels, uv, m.emissiveWrapS, m.emissiveWrapT);
                    e = F3(e.x * t.x, e.y * t.y, e.z * t.z);
                }
                return e;
            };
            retex.bake = retex::bakeAtlas;
            for (const auto& m : scene.materials) retex.materialFactors.push_back({m.metallicFactor, m.roughnessFactor});
            retex.minTexelWorld = retex::sourceTexelWorld(mesh, scene);
            retex.maxAtlasSize = 4096;
            retexPtr = &retex;
        }
        ClusterDag dag = buildClusterDag(std::move(mesh), 24, retexPtr);
        auto t2 = std::chrono::steady_clock::now();
        SbvgSummary s = writeSbvg(dag, argv[2], src.skippedPrimitives, atlasStem);
        auto ms = [](auto a, auto b) { return std::chrono::duration<double, std::milli>(b - a).count(); };
        std::printf("{\\"sourceTriangles\\":%u,\\"weldedVertices\\":%zu,\\"droppedDegenerate\\":%u,\\"skippedPrimitives\\":%u,"
                    "\\"vertexCount\\":%u,\\"clusterCount\\":%u,\\"triangleCount\\":%llu,\\"leafTriangleCount\\":%llu,\\"levelCount\\":%u,"
                    "\\"fileBytes\\":%llu,\\"atlasCount\\":%u,\\"atlasBytes\\":%llu,\\"loadMs\\":%.1f,\\"dagMs\\":%.1f,\\"levels\\":[",
                    dag.mesh.sourceTriangles, dag.mesh.positions.size(), dag.mesh.droppedDegenerate, src.skippedPrimitives,
                    s.vertexCount, s.clusterCount, (unsigned long long)s.triangleCount, (unsigned long long)s.leafTriangleCount, s.levelCount,
                    (unsigned long long)s.fileBytes, s.atlasCount, (unsigned long long)s.atlasBytes, ms(t0, t1), ms(t1, t2));
        for (size_t i = 0; i < dag.levels.size(); ++i) {
            const auto& l = dag.levels[i];
            std::printf("%s{\\"level\\":%u,\\"clusters\\":%u,\\"triangles\\":%u,\\"groups\\":%u,\\"stuckGroups\\":%u,\\"mergedGroups\\":%u,\\"maxError\\":%g}",
                        i ? "," : "", l.level, l.clusters, l.triangles, l.groups, l.stuckGroups, l.mergedGroups, (double)l.maxError);
        }
        std::printf("],\\"atlases\\":[");
        for (size_t i = 0; i < dag.atlases.size(); ++i) {
            const auto& a = dag.atlases[i];
            std::printf("%s{\\"level\\":%u,\\"materialId\\":%u,\\"width\\":%u,\\"height\\":%u,\\"cells\\":%u,\\"pairedCells\\":%u,\\"texels\\":%llu,\\"texelWorld\\":%g,\\"missed\\":%u,\\"bakeMs\\":%.1f}",
                        i ? "," : "", a.level, a.materialId, a.image.width, a.image.height, a.cells, a.pairedCells, (unsigned long long)a.texels, (double)a.texelWorld, a.missed, a.bakeMs);
        }
        std::printf("]}\\n");
        return 0;
    } catch (const std::exception& e) {
        std::fprintf(stderr, "sbvg_builder: %s\\n", e.what());
        return 1;
    }
}
`;

/**
 * -ffp-contract=off: no fused multiply-adds, so arm64 (where clang contracts by default) and x86-64
 * compute the same floats and the builder writes the same bytes on every host.
 */
const BUILDER_FLAGS = defaultNativeFlags(['-ffp-contract=off']);
/** The GLB reader inflates PNG textures and the atlases are written as PNG: zlib. */
const BUILDER_LIBS = ['-lz'];

export interface VirtualGeometryLevelStats {
    level: number;
    clusters: number;
    triangles: number;
    groups: number;
    /** Groups whose locked borders left too little to simplify even after merging; carried up unchanged. */
    stuckGroups: number;
    /** Stuck groups that joined a neighbouring group before simplification was retried. */
    mergedGroups: number;
    maxError: number;
}

export interface VirtualGeometryBuildStats {
    sourceTriangles: number;
    weldedVertices: number;
    droppedDegenerate: number;
    /** Primitives without a surface (points, lines) or without POSITION: not in the build. */
    skippedPrimitives: number;
    vertexCount: number;
    clusterCount: number;
    triangleCount: number;
    leafTriangleCount: number;
    levelCount: number;
    fileBytes: number;
    /** Re-textured coarse levels, each with an atlas PNG next to the file. */
    atlasCount: number;
    atlasBytes: number;
    loadMs: number;
    dagMs: number;
    levels: VirtualGeometryLevelStats[];
    atlases: Array<{ level: number; materialId: number; width: number; height: number; cells: number; pairedCells: number; texels: number; texelWorld: number; missed: number; bakeMs: number }>;
}

export interface VirtualGeometryBuildResult {
    sbvgPath: string;
    stats: VirtualGeometryBuildStats;
    compileMs: number;
    buildMs: number;
}

export interface ServedVirtualGeometry {
    /** URL the app serves the file at (VIRTUAL_GEOMETRY_URL_PREFIX/<content hash>-<builder hash>.sbvg). */
    sbvgUrl: string;
    sbvgPath: string;
    /** True when a file for the same GLB bytes and builder already existed; full stats are only known for a fresh build. */
    cached: boolean;
    /** Read from the file's header, so known for cached builds too. */
    summary: { sourceTriangles: number; leafTriangles: number; clusterCount: number; levelCount: number; fileBytes: number; skippedPrimitives: number; droppedDegenerate: number; atlasCount: number };
    stats?: VirtualGeometryBuildStats;
    buildMs?: number;
}

export interface VirtualGeometryBuildOptions {
    timeoutMs?: number;
    /** Aborting kills the builder process; the call rejects with an AbortError. */
    signal?: AbortSignal;
}

/** URL prefix the desktop server serves virtualGeometryServeDir() at. */
export const VIRTUAL_GEOMETRY_URL_PREFIX = '/build/3d-virtual-geometry';

/**
 * Directory built .sbvg files are cached in and served from: SCRATCHBOX_VIRTUAL_GEOMETRY_CACHE, default
 * <tmpdir>/scratchbox-virtual-geometry. Bounded by pruneVirtualGeometryCache.
 */
export function virtualGeometryServeDir(): string {
    return path.resolve(process.env.SCRATCHBOX_VIRTUAL_GEOMETRY_CACHE || path.join(os.tmpdir(), 'scratchbox-virtual-geometry'));
}

export class VirtualGeometryBuildError extends Error {
    constructor(message: string, readonly output?: string) {
        super(message);
        this.name = 'VirtualGeometryBuildError';
    }
}

function abortError(): Error {
    const err = new Error('Virtual geometry build stopped');
    err.name = 'AbortError';
    return err;
}

/**
 * Hash of everything that decides the builder's output besides the GLB: the .sbvg format version,
 * the driver source, the compile flags and the text of every header it includes.
 */
export function virtualGeometryBuilderHash(includeDir: string): string {
    const closure = hashIncludeClosure({ text: VIRTUAL_GEOMETRY_BUILDER_SOURCE }, [includeDir]);
    return crypto.createHash('sha256')
        .update(`sbvg-builder|format ${SBVG_VERSION}|${BUILDER_FLAGS.join(' ')}|${closure.hash}|`)
        .update(VIRTUAL_GEOMETRY_BUILDER_SOURCE)
        .digest('hex')
        .slice(0, 16);
}

export interface VirtualGeometryCachePruneOptions {
    dir?: string;
    /** Least recently used files go until the cache is within this size (default SCRATCHBOX_VIRTUAL_GEOMETRY_CACHE_MAX_MB or 8 GiB). */
    maxBytes?: number;
    /** Files unused for longer go (default SCRATCHBOX_VIRTUAL_GEOMETRY_CACHE_MAX_AGE_DAYS or 30 days). */
    maxAgeMs?: number;
    /** Files used more recently than this are kept whatever the bounds (default 10 min): a viewport may be streaming them. */
    minIdleMs?: number;
    nowMs?: number;
    /** File names never removed (builds this process holds). */
    keep?: Set<string>;
}

function envNumber(name: string): number | undefined {
    const v = Number(process.env[name]);
    return process.env[name] !== undefined && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * Bounds the .sbvg cache. A file's last use is its mtime (a cache hit touches it). Files unused for longer
 * than maxAgeMs go, then the least recently used until the directory is within maxBytes; nothing used within
 * minIdleMs is removed. Temp files of builds that are no longer running go after a day.
 */
/** The atlas PNGs written next to an .sbvg (`<stem>.atlas<level>.png`), whether or not they exist. */
export function atlasSiblings(sbvgPath: string): string[] {
    const dir = path.dirname(sbvgPath);
    const stem = path.basename(sbvgPath, '.sbvg');
    let names: string[] = [];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }
    const re = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(atlas|normal)\\d+\\.png$`);
    return names.filter(n => re.test(n)).map(n => path.join(dir, n));
}

export function pruneVirtualGeometryCache(options: VirtualGeometryCachePruneOptions = {}): { removed: string[]; bytesBefore: number; bytesAfter: number } {
    const dir = options.dir ?? virtualGeometryServeDir();
    const mb = envNumber('SCRATCHBOX_VIRTUAL_GEOMETRY_CACHE_MAX_MB');
    const days = envNumber('SCRATCHBOX_VIRTUAL_GEOMETRY_CACHE_MAX_AGE_DAYS');
    const maxBytes = options.maxBytes ?? (mb !== undefined ? mb * 1048576 : 8192 * 1048576);
    const maxAgeMs = options.maxAgeMs ?? (days !== undefined ? days * 86400_000 : 30 * 86400_000);
    const minIdleMs = options.minIdleMs ?? 10 * 60_000;
    const now = options.nowMs ?? Date.now();
    const result = { removed: [] as string[], bytesBefore: 0, bytesAfter: 0 };
    if (!fs.existsSync(dir)) return result;
    const files: { name: string; bytes: number; used: number }[] = [];
    for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        let st: fs.Stats;
        try {
            st = fs.statSync(file);
        } catch {
            continue;
        }
        if (!st.isFile()) continue;
        if (name.includes('.tmp-')) {
            if (now - st.mtimeMs > 86400_000) fs.rmSync(file, { force: true });
            continue;
        }
        if (!name.endsWith('.sbvg')) continue;
        // A file's atlas PNGs live and die with it.
        let bytes = st.size;
        for (const sibling of atlasSiblings(file)) {
            try { bytes += fs.statSync(sibling).size; } catch { /* gone */ }
        }
        files.push({ name, bytes, used: st.mtimeMs });
        result.bytesBefore += bytes;
    }
    files.sort((a, b) => a.used - b.used || (a.name < b.name ? -1 : 1));
    let total = result.bytesBefore;
    for (const f of files) {
        const expired = now - f.used > maxAgeMs;
        if (!expired && total <= maxBytes) continue;
        if (now - f.used < minIdleMs || options.keep?.has(f.name)) continue;
        for (const sibling of atlasSiblings(path.join(dir, f.name))) fs.rmSync(sibling, { force: true });
        fs.rmSync(path.join(dir, f.name), { force: true });
        total -= f.bytes;
        result.removed.push(f.name);
    }
    result.bytesAfter = total;
    return result;
}

function summaryFromFile(file: string): ServedVirtualGeometry['summary'] {
    const fd = fs.openSync(file, 'r');
    try {
        const head = Buffer.alloc(SBVG_HEADER_BYTES);
        fs.readSync(fd, head, 0, SBVG_HEADER_BYTES, 0);
        const tableBytes = head.readUInt32LE(8);
        const all = Buffer.alloc(Math.max(tableBytes, SBVG_HEADER_BYTES));
        fs.readSync(fd, all, 0, all.length, 0);
        const h = parseSbvgHeader(new Uint8Array(all.buffer, all.byteOffset, all.byteLength));
        return {
            sourceTriangles: h.sourceTriangleCount, leafTriangles: h.leafTriangleCount, clusterCount: h.clusterCount,
            levelCount: h.levelCount, fileBytes: h.fileBytes, skippedPrimitives: h.skippedPrimitives, droppedDegenerate: h.droppedDegenerate,
            atlasCount: h.atlasCount
        };
    } finally {
        fs.closeSync(fd);
    }
}

interface SharedJob {
    promise: Promise<ServedVirtualGeometry>;
    controller: AbortController;
    waiters: number;
}

/**
 * Builds `.sbvg` virtual geometry (cluster LOD DAG) files from GLB scenes with the native C++20
 * builder. The builder binary is compiled on first use and kept in the shared native build cache.
 */
export class VirtualGeometryBuildService {
    private binary: Promise<string> | null = null;
    private compileMs = 0;
    private served = new Map<string, SharedJob>();
    private hashMemo = new Map<string, { sig: string; hash: string }>();
    private builderHashValue: string | null = null;
    private readonly cacheDir?: string;

    constructor(
        private readonly compiler: NativeCppCompilerService = NativeCppCompilerService.getInstance(),
        options: { cacheDir?: string } = {}
    ) {
        this.cacheDir = options.cacheDir;
    }

    /** Directory this service caches served builds in. */
    serveDir(): string {
        return this.cacheDir ? path.resolve(this.cacheDir) : virtualGeometryServeDir();
    }

    builderHash(): string {
        this.builderHashValue ??= virtualGeometryBuilderHash(this.compiler.getSdkIncludePath());
        return this.builderHashValue;
    }

    private ensureBinary(): Promise<string> {
        if (!this.binary) {
            this.binary = (async () => {
                try {
                    const result = await compileNativeCached({
                        sourceCode: VIRTUAL_GEOMETRY_BUILDER_SOURCE,
                        includeDirs: [this.compiler.getSdkIncludePath()],
                        flags: BUILDER_FLAGS,
                        libs: BUILDER_LIBS,
                        name: 'sbvg_builder'
                    });
                    this.compileMs = result.cacheHit ? 0 : result.compileMs;
                    return result.binaryPath;
                } catch (err: any) {
                    throw new VirtualGeometryBuildError('Compiling the virtual geometry builder failed', err?.compilerOutput ?? String(err?.message ?? err));
                }
            })();
            this.binary.catch(() => { this.binary = null; });
        }
        return this.binary;
    }

    /** Builds `outputSbvgPath` from `inputGlbPath`. Throws VirtualGeometryBuildError with the builder's message on failure. */
    async build(inputGlbPath: string, outputSbvgPath: string, options: VirtualGeometryBuildOptions = {}): Promise<VirtualGeometryBuildResult> {
        const { timeoutMs = 10 * 60_000, signal } = options;
        if (signal?.aborted) throw abortError();
        if (!fs.existsSync(inputGlbPath)) throw new VirtualGeometryBuildError(`Input GLB not found: ${inputGlbPath}`);
        const binary = await this.ensureBinary();
        if (signal?.aborted) throw abortError();
        fs.mkdirSync(path.dirname(outputSbvgPath), { recursive: true });
        const tmp = `${outputSbvgPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        // Atlas PNGs land next to the file under its final name; they are complete before the rename makes the file visible.
        const atlasStem = path.basename(outputSbvgPath, '.sbvg');
        const start = Date.now();
        try {
            const stdout = await new Promise<string>((resolve, reject) => {
                execFile(binary, [inputGlbPath, tmp, atlasStem], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, signal, killSignal: 'SIGKILL' }, (err, out, stderr) => {
                    if (err) {
                        (err as any).stderr = stderr;
                        reject(err);
                    } else {
                        resolve(out);
                    }
                });
            });
            const stats = JSON.parse(stdout.trim().split('\n').pop() || '{}') as VirtualGeometryBuildStats;
            fs.renameSync(tmp, outputSbvgPath);
            return { sbvgPath: outputSbvgPath, stats, compileMs: this.compileMs, buildMs: Date.now() - start };
        } catch (err: any) {
            fs.rmSync(tmp, { force: true });
            for (const sibling of atlasSiblings(outputSbvgPath)) fs.rmSync(sibling, { force: true });
            if (err instanceof VirtualGeometryBuildError) throw err;
            if (signal?.aborted || err?.name === 'AbortError') throw abortError();
            if (err?.killed) throw new VirtualGeometryBuildError(`Virtual geometry build timed out after ${Math.round(timeoutMs / 1000)} s`, err?.stderr);
            const detail = (err?.stderr || err?.message || String(err)).toString().trim();
            throw new VirtualGeometryBuildError(`Virtual geometry build failed: ${detail}`, err?.stderr);
        }
    }

    /** sha256 of the GLB's bytes, memoised by (inode, size, mtime, ctime). */
    private contentHash(file: string): string {
        const st = fs.statSync(file);
        const sig = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
        const memo = this.hashMemo.get(file);
        if (memo && memo.sig === sig) return memo.hash;
        const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 32);
        this.hashMemo.set(file, { sig, hash });
        return hash;
    }

    /**
     * Builds `inputGlbPath` into the served directory, keyed by the GLB's content hash and the builder hash,
     * so a model is built once per builder version and keeps a stable URL; a changed GLB or builder gets a new
     * URL. Concurrent calls for the same key share one build, which is killed once every caller has aborted.
     */
    async buildServed(inputGlbPath: string, options: VirtualGeometryBuildOptions = {}): Promise<ServedVirtualGeometry> {
        if (!fs.existsSync(inputGlbPath)) throw new VirtualGeometryBuildError(`Input GLB not found: ${inputGlbPath}`);
        const { signal } = options;
        if (signal?.aborted) throw abortError();
        const key = `${this.contentHash(inputGlbPath)}-${this.builderHash()}`;
        const name = `${key}.sbvg`;
        const sbvgPath = path.join(this.serveDir(), name);
        const sbvgUrl = `${VIRTUAL_GEOMETRY_URL_PREFIX}/${name}`;
        if (fs.existsSync(sbvgPath)) {
            try {
                const now = new Date();
                fs.utimesSync(sbvgPath, now, now); // last use, for pruning
                return { sbvgUrl, sbvgPath, cached: true, summary: summaryFromFile(sbvgPath) };
            } catch {
                // removed meanwhile, or unreadable: build it again
            }
        }
        let job = this.served.get(key);
        if (!job) {
            const controller = new AbortController();
            const promise = this.build(inputGlbPath, sbvgPath, { timeoutMs: options.timeoutMs, signal: controller.signal })
                .then(r => ({ sbvgUrl, sbvgPath, cached: false, summary: summaryFromFile(sbvgPath), stats: r.stats, buildMs: r.buildMs }));
            const created: SharedJob = { promise, controller, waiters: 0 };
            job = created;
            this.served.set(key, created);
            promise
                .then(() => {
                    pruneVirtualGeometryCache({ dir: this.serveDir(), keep: new Set([...this.served.keys()].map(k => `${k}.sbvg`).concat(name)) });
                }, () => undefined)
                .finally(() => { if (this.served.get(key) === created) this.served.delete(key); });
        }
        const shared = job;
        shared.waiters++;
        if (!signal) return shared.promise.finally(() => { shared.waiters--; });
        return new Promise<ServedVirtualGeometry>((resolve, reject) => {
            let settled = false;
            const onAbort = () => {
                if (settled) return;
                settled = true;
                if (--shared.waiters === 0) shared.controller.abort();
                reject(abortError());
            };
            signal.addEventListener('abort', onAbort, { once: true });
            shared.promise.then(
                v => { if (!settled) { settled = true; shared.waiters--; signal.removeEventListener('abort', onAbort); resolve(v); } },
                e => { if (!settled) { settled = true; shared.waiters--; signal.removeEventListener('abort', onAbort); reject(e); } }
            );
        });
    }
}

let shared: VirtualGeometryBuildService | null = null;
/** Process-wide service, so the HTTP route and the agent tool share one compiled builder and one build queue. */
export function getVirtualGeometryBuildService(): VirtualGeometryBuildService {
    shared ??= new VirtualGeometryBuildService();
    return shared;
}
