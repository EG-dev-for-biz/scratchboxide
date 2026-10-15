/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Service wrapper for the native tile vegetation pipeline (scratchbox_tile_vegetation.hpp + scripts/tile_vegetation.cpp):
 *
 * - strip: a photo-textured tile GLB in; the devegetated tile GLB (measured tree crowns removed, holes closed), the
 *   crown list (crowns.json) and stats out.
 * - plant: crowns.json in; one SB-Veggie tree per measured crown (space colonisation, studio clay) within a triangle
 *   budget, as one GLB in the tile frame.
 *
 * Paths are confined to the workspace root. The binary is built with clang++ on first use and rebuilt when one of
 * its sources (clang's -MMD list) is newer; a failed build is an error, never an older binary. It runs through
 * execFile (no shell) with a timeout. Results are cached under
 * <root>/.scratchbox/cache/tile_vegetation/<sha256(binary + inputs + params)>/.
 */

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { resolveWithinRoot } from '../security/path-guard';

/** Continuous strip parameters (metres, ratios); every one maps to a CLI flag of the same name in kebab case. */
export interface TileVegetationStripParams {
    cell?: number;
    terrainCell?: number;
    terrainRadius?: number;
    exgMin?: number;
    exgrMin?: number;
    darkGuard?: number;
    roughnessRadius?: number;
    roughnessMin?: number;
    planarAngle?: number;
    planarOffset?: number;
    planarArea?: number;
    canopyMinHeight?: number;
    minTreeHeight?: number;
    minCrownArea?: number;
    windowBase?: number;
    windowSlope?: number;
    windowMin?: number;
    windowMax?: number;
    climbLimit?: number;
    supportStep?: number;
    supportSearch?: number;
    footprintDilation?: number;
    drapeReach?: number;
    clearance?: number;
    supportBand?: number;
    skirtMin?: number;
    fragmentMaxArea?: number;
    capGrid?: number;
    seamGap?: number;
    sampleSpacing?: number;
}

/** Continuous plant parameters. crownBaseRatio and trunkRadiusPerHeight are not observed by a scan: inferred. */
export interface TileVegetationPlantParams {
    minTrianglesPerTree?: number;
    crownBaseRatio?: number;
    trunkRadiusPerHeight?: number;
    woodShare?: number;
    shellDepth?: number;
    supportTolerance?: number;
}

export interface TileVegetationStripRequest {
    /** Photo-textured tile GLB, relative to the workspace root or absolute inside it. */
    tilePath: string;
    params?: TileVegetationStripParams;
    /** Also write a top-down PNG of the measurement. */
    topDown?: boolean;
    threads?: number;
    timeoutMs?: number;
    /** Stops this request (it rejects with an AbortError); the native run is killed once no request waits on it. */
    signal?: AbortSignal;
}

export interface TileVegetationStripResult {
    devegetatedGlb: string;
    crownsJson: string;
    topDownPng?: string;
    stats: Record<string, any>;
    /** sha256 of the input tile (hex), used to seed planting deterministically. */
    tileSha256: string;
    cached: boolean;
    ms: number;
    cacheKey: string;
}

export interface TileVegetationPlantRequest {
    crownsPath: string;
    /** Total triangles all trees may use (> 0). */
    triangleBudget: number;
    /** Hex seed (1-16 digits), mixed with each crown id. */
    seed: string;
    /** Isolate requests: plant only crowns whose trunk base lies on this mesh. */
    supportMeshPath?: string;
    params?: TileVegetationPlantParams;
    /** Copy the trees GLB to public/models/<publishAs> (a plain *.glb name). */
    publishAs?: string;
    threads?: number;
    timeoutMs?: number;
    /** Stops this request (it rejects with an AbortError); the native run is killed once no request waits on it. */
    signal?: AbortSignal;
}

export interface TileVegetationPlantResult {
    treesGlb: string;
    stats: Record<string, any>;
    cached: boolean;
    ms: number;
    cacheKey: string;
    published?: { path: string; url: string; backup?: string };
}

export type TileVegetationErrorCode =
    | 'bad_request' | 'not_found' | 'timeout' | 'failed' | 'build_failed'
    | 'bad_input' | 'texture_decode' | 'no_photo_texture' | 'budget_too_small' | 'budget_exceeded' | 'plant_failed' | 'io';

export class TileVegetationError extends Error {
    constructor(readonly code: TileVegetationErrorCode, message: string, readonly detail?: string) {
        super(message);
        this.name = 'TileVegetationError';
    }
}

export interface TileVegetationServiceOptions {
    workspaceRoot: string;
    /** Where scripts/tile_vegetation.cpp and the engine headers live (default: discovered from this file, else cwd). */
    repoRoot?: string;
    /** A prebuilt binary to run instead of building one. */
    binaryPath?: string;
    cacheDir?: string;
    defaultTimeoutMs?: number;
}

const CLI_SOURCE = path.join('scripts', 'tile_vegetation.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const BINARY = path.join('build', '3d-native', 'tile_vegetation');
const CACHE_VERSION = 'tile_vegetation/v2';
const PUBLISH_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\.glb$/;
const KNOWN_CODES = new Set<TileVegetationErrorCode>(['bad_request', 'not_found', 'timeout', 'failed', 'build_failed', 'bad_input', 'texture_decode', 'no_photo_texture', 'budget_too_small', 'budget_exceeded', 'plant_failed', 'io']);

/** The checkout that holds scripts/tile_vegetation.cpp: walks up from this file, then from cwd. */
export function findTileVegetationRepoRoot(): string {
    for (const start of [__dirname, process.cwd()]) {
        let dir = path.resolve(start);
        while (true) {
            if (fs.existsSync(path.join(dir, CLI_SOURCE))) return dir;
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    return process.cwd();
}

function sha256File(file: string, hash: crypto.Hash): void {
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.allocUnsafe(1 << 20);
        let n: number;
        while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
    } finally {
        fs.closeSync(fd);
    }
}

function fileSha256(file: string): string {
    const h = crypto.createHash('sha256');
    sha256File(file, h);
    return h.digest('hex');
}

function mtimeMs(file: string): number {
    try {
        return fs.statSync(file).mtimeMs;
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

function readDepFile(file: string): string[] {
    const text = fs.readFileSync(file, 'utf8').replace(/\\\r?\n/g, ' ');
    const colon = text.indexOf(': ');
    if (colon < 0) return [];
    return text.slice(colon + 2).split(/(?<!\\)\s+/).filter(Boolean).map(p => p.replace(/\\ /g, ' '));
}

function kebab(name: string): string {
    return name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
}

/** Flags from a parameter object: only finite numbers, in key order (part of the cache key). */
function paramFlags(params: object | undefined): { flags: string[]; key: Record<string, number> } {
    const flags: string[] = [];
    const key: Record<string, number> = {};
    for (const [k, v] of Object.entries(params ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        if (v === undefined) continue;
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new TileVegetationError('bad_request', `${k} must be a finite number`);
        flags.push(`--${kebab(k)}`, String(v));
        key[k] = v;
    }
    return { flags, key };
}

/** "ERROR <code>: <message>" from the CLI's stderr, as a typed error. */
function cliError(stderr: string, fallbackMessage: string): TileVegetationError {
    const line = stderr.split('\n').reverse().find(l => l.startsWith('ERROR '));
    const m = line?.match(/^ERROR ([a-z_]+): (.*)$/);
    if (m && KNOWN_CODES.has(m[1] as TileVegetationErrorCode)) return new TileVegetationError(m[1] as TileVegetationErrorCode, m[2], stderr.slice(-2000));
    return new TileVegetationError('failed', fallbackMessage, stderr.slice(-2000));
}

/** The error a stopped request rejects with (name 'AbortError', as the chat's own cancellation uses). */
function stoppedError(): Error {
    return Object.assign(new Error('Stopped by the chat before it finished'), { name: 'AbortError' });
}

/** Runs the binary; `signal` kills it (SIGKILL) and rejects with an AbortError when the request is stopped. */
function runFile(file: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(stoppedError());
            return;
        }
        const started = Date.now();
        execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...(signal ? { signal } : {}) }, (err, stdout, stderr) => {
            if (!err) {
                resolve({ stdout: String(stdout), stderr: String(stderr) });
                return;
            }
            if (signal?.aborted || (err as Error).name === 'AbortError') {
                reject(stoppedError());
                return;
            }
            const e = err as NodeJS.ErrnoException & { killed?: boolean };
            const tail = String(stderr || stdout || e.message);
            if (e.killed && Date.now() - started >= timeoutMs - 50) {
                reject(new TileVegetationError('timeout', `${path.basename(file)} timed out after ${timeoutMs} ms`, tail.slice(-2000)));
            } else {
                reject(cliError(tail, `${path.basename(file)} failed: ${tail.split('\n').filter(Boolean).pop() ?? e.message}`));
            }
        });
    });
}

export class TileVegetationService {
    readonly workspaceRoot: string;
    readonly repoRoot: string;
    readonly cacheDir: string;
    private readonly binaryOverride?: string;
    private readonly defaultTimeoutMs: number;
    private building?: Promise<string>;
    private binaryHash?: { key: string; hex: string };
    /**
     * Identical runs in progress, shared by every request that asks for them. A run has its own AbortController: it
     * is stopped only when every request waiting on it has been stopped, and each request rejects with its own stop.
     */
    private readonly inFlight = new Map<string, { promise: Promise<unknown>; controller: AbortController; waiters: number; settled: boolean }>();

    constructor(options: TileVegetationServiceOptions) {
        this.workspaceRoot = resolveWithinRoot(options.workspaceRoot, '.');
        this.repoRoot = path.resolve(options.repoRoot ?? findTileVegetationRepoRoot());
        this.cacheDir = options.cacheDir
            ? resolveWithinRoot(this.workspaceRoot, options.cacheDir)
            : resolveWithinRoot(this.workspaceRoot, path.join('.scratchbox', 'cache', 'tile_vegetation'));
        this.binaryOverride = options.binaryPath ? path.resolve(options.binaryPath) : undefined;
        this.defaultTimeoutMs = options.defaultTimeoutMs ?? 300_000;
    }

    /** Builds build/3d-native/tile_vegetation when it is missing or older than any of its sources. */
    ensureBinary(): Promise<string> {
        if (this.binaryOverride) {
            if (!fs.existsSync(this.binaryOverride)) return Promise.reject(new TileVegetationError('not_found', `tile_vegetation binary not found: ${this.binaryOverride}`));
            return Promise.resolve(this.binaryOverride);
        }
        if (!this.building) this.building = this.buildIfStale().finally(() => { this.building = undefined; });
        return this.building;
    }

    private async buildIfStale(): Promise<string> {
        const bin = path.join(this.repoRoot, BINARY);
        const depFile = `${bin}.d`;
        const source = path.join(this.repoRoot, CLI_SOURCE);
        const include = path.join(this.repoRoot, INCLUDE_DIR);
        if (!fs.existsSync(source)) throw new TileVegetationError('not_found', `tile_vegetation source not found: ${source}`);
        const deps = fs.existsSync(depFile)
            ? readDepFile(depFile)
            : [source, ...fs.readdirSync(include).filter(f => f.endsWith('.hpp') || f.endsWith('.h')).map(f => path.join(include, f))];
        const binTime = fs.existsSync(bin) ? fs.statSync(bin).mtimeMs : -1;
        const stale = binTime < 0 || !fs.existsSync(depFile) || deps.some(d => mtimeMs(d) > binTime);
        if (!stale) return bin;

        fs.mkdirSync(path.dirname(bin), { recursive: true });
        const tag = `${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
        const tmpBin = `${bin}.tmp-${tag}`;
        const tmpDep = `${depFile}.tmp-${tag}`;
        const args = ['-std=c++20', '-O3', '-pthread'];
        if (process.env.SCRATCHBOX_NATIVE_ARCH === '1') args.push('-march=native');
        args.push('-I', include, source, '-o', tmpBin, '-MMD', '-MF', tmpDep, '-lz');
        try {
            await runFile(process.env.CXX || 'clang++', args, 600_000);
            fs.renameSync(tmpBin, bin);
            fs.renameSync(tmpDep, depFile);
            return bin;
        } catch (err) {
            for (const f of [tmpBin, tmpDep]) fs.rmSync(f, { force: true });
            const detail = err instanceof TileVegetationError ? err.detail : String(err);
            throw new TileVegetationError('build_failed', 'could not build tile_vegetation', detail);
        }
    }

    private hashBinary(bin: string): string {
        const st = fs.statSync(bin);
        const key = `${bin}:${st.size}:${st.mtimeMs}`;
        if (this.binaryHash?.key !== key) this.binaryHash = { key, hex: fileSha256(bin) };
        return this.binaryHash.hex;
    }

    private resolveInput(rel: string | undefined, what: string, ext: string): string {
        if (typeof rel !== 'string' || !rel.trim()) throw new TileVegetationError('bad_request', `${what} is required`);
        const file = resolveWithinRoot(this.workspaceRoot, rel.trim());
        if (!file.toLowerCase().endsWith(ext)) throw new TileVegetationError('bad_request', `${what} must be a ${ext} file`);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new TileVegetationError('not_found', `${what} not found: ${rel}`);
        return file;
    }

    /**
     * Runs `produce` into a fresh temp dir and renames it into the cache entry, unless the entry exists. Concurrent
     * identical requests share one run; `signal` stops only this request's wait (and the run, once nobody waits).
     */
    private cached<T>(key: string, outputs: string[], produce: (dir: string, signal: AbortSignal) => Promise<void>, result: (dir: string, cached: boolean) => T, signal?: AbortSignal): Promise<T> {
        const dir = path.join(this.cacheDir, key);
        const done = path.join(dir, 'done.json');
        if (fs.existsSync(done)) return Promise.resolve(result(dir, true));
        if (signal?.aborted) return Promise.reject(stoppedError());
        let entry = this.inFlight.get(key);
        if (!entry) {
            const controller = new AbortController();
            const run = (async () => {
                fs.mkdirSync(this.cacheDir, { recursive: true });
                const tmp = path.join(this.cacheDir, `${key}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
                fs.mkdirSync(tmp);
                try {
                    await produce(tmp, controller.signal);
                    for (const f of outputs) {
                        if (!fs.existsSync(path.join(tmp, f))) throw new TileVegetationError('failed', `tile_vegetation did not write ${f}`);
                    }
                    fs.writeFileSync(path.join(tmp, 'done.json'), JSON.stringify({ at: new Date().toISOString() }));
                    fs.rmSync(dir, { recursive: true, force: true });
                    fs.renameSync(tmp, dir);
                } catch (err) {
                    fs.rmSync(tmp, { recursive: true, force: true });
                    if (fs.existsSync(done)) return result(dir, true);
                    throw err;
                }
                return result(dir, false);
            })();
            const created: { promise: Promise<unknown>; controller: AbortController; waiters: number; settled: boolean } = { promise: run, controller, waiters: 0, settled: false };
            entry = created;
            run.then(() => undefined, () => undefined).finally(() => {
                created.settled = true;
                if (this.inFlight.get(key) === created) this.inFlight.delete(key);
            });
            this.inFlight.set(key, created);
        }
        const shared = entry;
        shared.waiters++;
        return new Promise<T>((resolve, reject) => {
            let left = false;
            const leave = () => {
                if (left) return false;
                left = true;
                signal?.removeEventListener('abort', onAbort);
                shared.waiters--;
                return true;
            };
            const onAbort = () => {
                if (!leave()) return;
                if (shared.waiters === 0 && !shared.settled) {
                    // nobody waits any more: stop the run, and let the next identical request start its own
                    if (this.inFlight.get(key) === shared) this.inFlight.delete(key);
                    shared.controller.abort();
                }
                reject(stoppedError());
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            (shared.promise as Promise<T>).then(
                v => { if (leave()) resolve(v); },
                e => { if (leave()) reject(e); }
            );
        });
    }

    async strip(req: TileVegetationStripRequest): Promise<TileVegetationStripResult> {
        const t0 = Date.now();
        const input = this.resolveInput(req.tilePath, 'tilePath', '.glb');
        const { flags, key: keyParams } = paramFlags(req.params);
        const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
        const bin = await this.ensureBinary();
        const tileSha256 = fileSha256(input);
        const key = crypto.createHash('sha256').update(CACHE_VERSION).update('\0strip\0').update(this.hashBinary(bin)).update('\0')
            .update(tileSha256).update('\0').update(JSON.stringify({ ...keyParams, topDown: !!req.topDown })).digest('hex');
        const outputs = ['devegetated.glb', 'crowns.json', 'stats.json', ...(req.topDown ? ['topdown.png'] : [])];
        const res = await this.cached(key, outputs, async (dir, signal) => {
            const args = ['strip', '--input', input, '--out', path.join(dir, 'devegetated.glb'), '--crowns', path.join(dir, 'crowns.json'),
                '--stats', path.join(dir, 'stats.json'), ...flags];
            if (req.topDown) args.push('--topdown', path.join(dir, 'topdown.png'));
            if (req.threads !== undefined) args.push('--threads', String(req.threads));
            await runFile(bin, args, timeoutMs, signal);
        }, (dir, cached) => ({
            devegetatedGlb: path.join(dir, 'devegetated.glb'),
            crownsJson: path.join(dir, 'crowns.json'),
            topDownPng: req.topDown ? path.join(dir, 'topdown.png') : undefined,
            stats: JSON.parse(fs.readFileSync(path.join(dir, 'stats.json'), 'utf8')),
            tileSha256,
            cached,
            ms: 0,
            cacheKey: key
        }), req.signal);
        return { ...res, ms: Date.now() - t0 };
    }

    async plant(req: TileVegetationPlantRequest): Promise<TileVegetationPlantResult> {
        const t0 = Date.now();
        const crowns = this.resolveInput(req.crownsPath, 'crownsPath', '.json');
        const support = req.supportMeshPath !== undefined ? this.resolveInput(req.supportMeshPath, 'supportMeshPath', '.glb') : undefined;
        if (!Number.isFinite(req.triangleBudget) || req.triangleBudget <= 0) throw new TileVegetationError('bad_request', 'triangleBudget must be a number > 0');
        if (typeof req.seed !== 'string' || !/^[0-9a-fA-F]{1,16}$/.test(req.seed)) throw new TileVegetationError('bad_request', 'seed must be 1-16 hex digits');
        const publishTarget = req.publishAs === undefined ? undefined : this.resolvePublishTarget(req.publishAs);
        const { flags, key: keyParams } = paramFlags(req.params);
        const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
        const bin = await this.ensureBinary();
        const hash = crypto.createHash('sha256').update(CACHE_VERSION).update('\0plant\0').update(this.hashBinary(bin)).update('\0');
        sha256File(crowns, hash);
        hash.update('\0');
        if (support) sha256File(support, hash);
        hash.update('\0').update(JSON.stringify({ ...keyParams, triangleBudget: Math.floor(req.triangleBudget), seed: req.seed.toLowerCase() }));
        const key = hash.digest('hex');
        const res = await this.cached(key, ['trees.glb', 'stats.json'], async (dir, signal) => {
            const args = ['plant', '--crowns', crowns, '--out', path.join(dir, 'trees.glb'), '--stats', path.join(dir, 'stats.json'),
                '--triangle-budget', String(Math.floor(req.triangleBudget)), '--seed', req.seed, ...flags];
            if (support) args.push('--support-mesh', support);
            if (req.threads !== undefined) args.push('--threads', String(req.threads));
            await runFile(bin, args, timeoutMs, signal);
        }, (dir, cached) => ({
            treesGlb: path.join(dir, 'trees.glb'),
            stats: JSON.parse(fs.readFileSync(path.join(dir, 'stats.json'), 'utf8')),
            cached,
            ms: 0,
            cacheKey: key
        }), req.signal);
        const out: TileVegetationPlantResult = { ...res, ms: 0 };
        if (publishTarget) out.published = this.publish(res.treesGlb, publishTarget);
        out.ms = Date.now() - t0;
        return out;
    }

    private resolvePublishTarget(name: string): string {
        if (typeof name !== 'string' || !PUBLISH_FILE.test(name)) throw new TileVegetationError('bad_request', 'publishAs must be a plain *.glb file name');
        return resolveWithinRoot(resolveWithinRoot(this.workspaceRoot, path.join('public', 'models')), name);
    }

    private publish(source: string, target: string): { path: string; url: string; backup?: string } {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        let backup: string | undefined;
        if (fs.existsSync(target) && fileSha256(target) !== fileSha256(source)) {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const dest = resolveWithinRoot(this.workspaceRoot, path.join('.scratchbox', 'backup', 'pre_tile_vegetation', stamp, path.basename(target)));
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(target, dest);
            backup = path.relative(this.workspaceRoot, dest);
        }
        const tmp = `${target}.tmp-${process.pid}`;
        fs.copyFileSync(source, tmp);
        fs.renameSync(tmp, target);
        const publicDir = resolveWithinRoot(this.workspaceRoot, 'public');
        return { path: path.relative(this.workspaceRoot, target), url: '/' + path.relative(publicDir, target).split(path.sep).join('/'), ...(backup ? { backup } : {}) };
    }
}

const services = new Map<string, TileVegetationService>();

/** One service per workspace root, so concurrent identical requests share a run and a build. */
export function getTileVegetationService(workspaceRoot: string): TileVegetationService {
    const root = resolveWithinRoot(workspaceRoot, '.');
    let svc = services.get(root);
    if (!svc) {
        svc = new TileVegetationService({ workspaceRoot: root });
        services.set(root, svc);
    }
    return svc;
}
