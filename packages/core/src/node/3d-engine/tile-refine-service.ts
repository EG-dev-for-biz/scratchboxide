/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Service wrapper for the native tile-refine pipeline (scratchbox_tile_refine.hpp + scripts/tile_refine.cpp):
 * a raw photogrammetric tile GLB in, a better-defined textured GLB + studio-clay GLB + stats JSON out.
 *
 * - Paths are confined to the workspace root (resolveWithinRoot).
 * - The binary is built through the native build cache (native-build-cache.ts): rebuilt only when the content of its
 *   source or of a header it includes changes; a failed build is an error. It runs through execFile (no shell) with
 *   a timeout.
 * - Results are cached under <root>/.scratchbox/cache/tile_refine/<sha256(binary + tile bytes + params)>/, so a
 *   repeat request returns without running anything.
 * - `publishAs` copies the results into <root>/public/models for the in-app viewer; a different file already there
 *   is backed up to <root>/.scratchbox/backup/pre_tile_refine/<stamp>/ first.
 * - `isolate` keeps only the structure under the anchor (whole, plus a ground apron) and runs every stage on it: a
 *   seconds-scale loop for testing one building; it also writes the isolated raw scan as clay (`rawClayGlb`).
 */

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { resolveWithinRoot } from '../security/path-guard';
import { compileNativeCached, defaultNativeFlags, NativeBuildError, placeCachedBinary } from './native-build-cache';

export interface TileRefineRequest {
    /** Tile GLB, relative to the workspace root or absolute inside it. `glbPath` is an alias. */
    tilePath?: string;
    glbPath?: string;
    /** Hero anchor in the tile frame (x = east, z = south), metres. Default: the tile origin. */
    anchor?: { x: number; z: number } | [number, number];
    /** Relief region of interest: the anchor's footprint grown by this many metres; < 0 = whole tile (default 60). */
    roiRadius?: number;
    /**
     * Photometric facade relief (default true): window recesses and shadowed bands read from the photo texture. Its
     * depths are inferred, not measured; the outputs label them (_RELIEF_HEIGHT per vertex, asset.extras).
     */
    relief?: boolean;
    /** false: the relief analyses (and writes reliefOrthos) but carves nothing (pipeline K carves on its rebuilt facades). */
    reliefCarve?: boolean;
    /** false (with reliefCarve false and reliefOrthos): the orthos are written and nothing is analysed (pipeline K reads its own windows). */
    reliefAnalyse?: boolean;
    /**
     * With reliefOrthos: an occlusion mask beside each ortho (facade_<id>_occluded.png, named in facades.json), the share
     * of a fan of rays from the facade toward where the capture stood that something in front of it blocks. true casts
     * against the scan as loaded (before isolation); a path (a .glb inside the workspace) against that scene instead: the
     * scan before something was taken out of it (the tree strip's input).
     */
    reliefOcclusion?: boolean | string;
    /**
     * Facade flatten: vertices within `band` metres of a detected wall plane move onto it (default on, band 0.10).
     * `false` turns it off; `{ band }` sets the band (0..0.5 m).
     */
    facadeFlatten?: boolean | { band?: number };
    /**
     * Tile-chunk seam weld (default on, tolerance 0.03): the first stage, before isolation, the raw clay write and
     * the rectifier's orientation vote. Boundary positions of adjacent tile pieces within the tolerance are welded and
     * the triangles the weld collapses are dropped (scratchbox_tile_seam_weld.hpp). `false` turns it off;
     * `{ toleranceM }` sets the tolerance (0..1 m).
     */
    seamWeld?: boolean | { toleranceM?: number };
    /**
     * Keep only the structure under the anchor (its whole connected footprint and everything above it, never cut)
     * plus a ground apron, and refine just that. `true`, or `{ apron }` to set the apron width in metres (default 4).
     */
    isolate?: boolean | { apron?: number };
    /**
     * Copy into public/models: a base name gives <name>_refined.glb + <name>_refined_clay.glb (+ <name>_raw_clay.glb
     * when isolating); or explicit file names (`rawClay` needs `isolate`).
     */
    publishAs?: string | { textured?: string; clay?: string; rawClay?: string };
    /**
     * Isolate only: multi-view mask voting. `masksDir` (inside the workspace) holds views.txt and <name>.mask.png for
     * registered views of the tile (renderOwnershipViews writes such views; 255 = the requested structure, 0 = everything
     * else). A raised triangle whose vote is decisive joins or leaves the structure; undecided ones keep the geometric rules.
     * The entry then also holds ownership.sbov (the vote of every kept triangle, for scan_fit) and ownership_debug/.
     */
    ownership?: { masksDir: string };
    /**
     * Isolate only: the shared structure pick (an SBIP file inside the workspace, extraction-sizing.ts writeIsolationPick).
     * tile_refine then isolates exactly that footprint on that terrain instead of applying a footprint rule of its own.
     */
    isolatePick?: string;
    /** Also write raw-vs-output thumbnails into the cache entry (adds ~1-2 s). */
    thumbnails?: boolean;
    /**
     * Also write each analysed facade's orthophoto and metric frame (relief_orthos/: facade_<id>.png, facades.json) into
     * the cache entry: the images a facade grammar is read from (facade-grammar.ts).
     */
    reliefOrthos?: boolean;
    /**
     * A facade grammar file (facade-grammar.ts grammarFileText; inside the workspace): each grammar is its facade's window
     * lattice in the relief. Photo-inferred; the outputs label its cells (_LATTICE_CELL 3 and 4, asset.extras.scratchbox.facadeGrammar).
     */
    facadeGrammar?: string;
    /** Worker threads (default: all cores). Not part of the cache key. */
    threads?: number;
    /** Timeout of the pipeline run itself, not counting a first-use build (default 300 s). */
    timeoutMs?: number;
}

export interface TileRefineServiceOptions {
    /** Every input/output path is confined to this root. */
    workspaceRoot: string;
    /** Where scripts/tile_refine.cpp and the engine headers live (default: discovered from this file, else cwd). */
    repoRoot?: string;
    /** A prebuilt binary to run instead of building one. */
    binaryPath?: string;
    /** Default: <workspaceRoot>/.scratchbox/cache/tile_refine */
    cacheDir?: string;
    defaultTimeoutMs?: number;
}

type PublishKind = 'textured' | 'clay' | 'rawClay';

export interface TileRefinePublished {
    textured?: string;
    clay?: string;
    rawClay?: string;
    /** Viewer URLs (public/ is served at the site root). */
    urls: { textured?: string; clay?: string; rawClay?: string };
    backups: string[];
}

export interface TileRefineResult {
    texturedGlb: string;
    clayGlb: string;
    /** The isolated raw scan as studio clay (isolate requests only). */
    rawClayGlb?: string;
    /** Ownership requests: the vote of every kept triangle by centroid (SBOV) and the owner-coloured diagnostics. */
    ownershipVotes?: string;
    ownershipDebugDir?: string;
    /** reliefOrthos requests: the facades' orthophotos and frames (facades.json). */
    reliefOrthosDir?: string;
    stats: Record<string, any>;
    cached: boolean;
    ms: number;
    cacheKey: string;
    thumbnailsDir?: string;
    published?: TileRefinePublished;
    binary: { path: string; built: boolean; buildMs?: number; warning?: string };
}

export type TileRefineErrorCode = 'bad_request' | 'not_found' | 'timeout' | 'failed' | 'build_failed';

export class TileRefineError extends Error {
    constructor(readonly code: TileRefineErrorCode, message: string, readonly detail?: string) {
        super(message);
        this.name = 'TileRefineError';
    }
}

const CLI_SOURCE = path.join('scripts', 'tile_refine.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const BINARY = path.join('build', '3d-native', 'tile_refine');
const CACHE_VERSION = 'tile_refine/v1';
const PUBLISH_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PUBLISH_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\.glb$/;
const PUBLISH_KINDS: readonly PublishKind[] = ['textured', 'clay', 'rawClay'];

/** The checkout that holds scripts/tile_refine.cpp: walks up from this file, then from cwd. */
export function findTileRefineRepoRoot(): string {
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

function sameBytes(a: string, b: string): boolean {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (sa.size !== sb.size) return false;
    const ha = crypto.createHash('sha256');
    const hb = crypto.createHash('sha256');
    sha256File(a, ha);
    sha256File(b, hb);
    return ha.digest('hex') === hb.digest('hex');
}

function runFile(file: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, windowsHide: true },
            (err, stdout, stderr) => {
                if (!err) {
                    resolve({ stdout: String(stdout), stderr: String(stderr) });
                    return;
                }
                const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
                const tail = String(stderr || stdout || e.message).slice(-2000);
                if (e.killed && Date.now() - started >= timeoutMs - 50) {
                    reject(new TileRefineError('timeout', `${path.basename(file)} timed out after ${timeoutMs} ms`, tail));
                } else {
                    reject(new TileRefineError('failed', `${path.basename(file)} failed: ${tail.split('\n').filter(Boolean).pop() ?? e.message}`, tail));
                }
            });
    });
}

export class TileRefineService {
    readonly workspaceRoot: string;
    readonly repoRoot: string;
    readonly cacheDir: string;
    private readonly binaryOverride?: string;
    private readonly defaultTimeoutMs: number;
    private building?: Promise<TileRefineResult['binary']>;
    private binaryHash?: { key: string; hex: string };
    private readonly inFlight = new Map<string, Promise<TileRefineResult>>();

    constructor(options: TileRefineServiceOptions) {
        this.workspaceRoot = resolveWithinRoot(options.workspaceRoot, '.');
        this.repoRoot = path.resolve(options.repoRoot ?? findTileRefineRepoRoot());
        this.cacheDir = options.cacheDir
            ? resolveWithinRoot(this.workspaceRoot, options.cacheDir)
            : resolveWithinRoot(this.workspaceRoot, path.join('.scratchbox', 'cache', 'tile_refine'));
        this.binaryOverride = options.binaryPath ? path.resolve(options.binaryPath) : undefined;
        this.defaultTimeoutMs = options.defaultTimeoutMs ?? 300_000;
    }

    /** Builds build/3d-native/tile_refine when it is missing or older than any of its sources. */
    ensureBinary(): Promise<TileRefineResult['binary']> {
        if (this.binaryOverride) {
            if (!fs.existsSync(this.binaryOverride)) {
                return Promise.reject(new TileRefineError('not_found', `tile_refine binary not found: ${this.binaryOverride}`));
            }
            return Promise.resolve({ path: this.binaryOverride, built: false });
        }
        if (!this.building) {
            this.building = this.buildIfStale().finally(() => { this.building = undefined; });
        }
        return this.building;
    }

    private async buildIfStale(): Promise<TileRefineResult['binary']> {
        const bin = path.join(this.repoRoot, BINARY);
        const source = path.join(this.repoRoot, CLI_SOURCE);
        const include = path.join(this.repoRoot, INCLUDE_DIR);
        if (!fs.existsSync(source)) throw new TileRefineError('not_found', `tile_refine source not found: ${source}`);
        const t0 = Date.now();
        try {
            const built = await compileNativeCached({
                sourcePath: source,
                includeDirs: [include],
                flags: defaultNativeFlags(['-pthread']),
                libs: ['-lz'],
                name: 'tile_refine',
                timeoutMs: 600_000
            });
            placeCachedBinary(built.binaryPath, bin);
            return built.cacheHit ? { path: bin, built: false } : { path: bin, built: true, buildMs: Date.now() - t0 };
        } catch (err) {
            // A failed build is an error: an older binary is never run in its place.
            throw new TileRefineError('build_failed', 'could not build tile_refine', err instanceof NativeBuildError ? err.compilerOutput : String(err));
        }
    }

    private hashBinary(bin: string): string {
        const st = fs.statSync(bin);
        const key = `${bin}:${st.size}:${st.mtimeMs}`;
        if (this.binaryHash?.key !== key) {
            const h = crypto.createHash('sha256');
            sha256File(bin, h);
            this.binaryHash = { key, hex: h.digest('hex') };
        }
        return this.binaryHash.hex;
    }

    /** Resolves and validates the request without touching the binary. Throws PathTraversalError / TileRefineError. */
    resolveRequest(req: TileRefineRequest): { input: string; cliArgs: string[]; keyParams: Record<string, unknown> } {
        const rel = req.tilePath ?? req.glbPath;
        if (typeof rel !== 'string' || !rel.trim()) throw new TileRefineError('bad_request', 'tilePath (or glbPath) is required');
        const input = resolveWithinRoot(this.workspaceRoot, rel.trim());
        if (!input.toLowerCase().endsWith('.glb')) throw new TileRefineError('bad_request', 'tilePath must be a .glb file');
        if (!fs.existsSync(input) || !fs.statSync(input).isFile()) throw new TileRefineError('not_found', `tile not found: ${rel}`);

        const cliArgs: string[] = [];
        const keyParams: Record<string, unknown> = {};
        if (req.anchor !== undefined) {
            const [x, z] = Array.isArray(req.anchor) ? req.anchor : [req.anchor?.x, req.anchor?.z];
            if (!Number.isFinite(x) || !Number.isFinite(z)) throw new TileRefineError('bad_request', 'anchor must be {x, z} or [x, z] in metres');
            cliArgs.push('--anchor', `${x},${z}`);
            keyParams.anchor = [x, z];
        }
        if (req.roiRadius !== undefined) {
            if (!Number.isFinite(req.roiRadius)) throw new TileRefineError('bad_request', 'roiRadius must be a number');
            cliArgs.push('--roi-radius', String(req.roiRadius));
            keyParams.roiRadius = req.roiRadius;
        }
        if (req.relief === false) {
            cliArgs.push('--no-relief');
            keyParams.relief = false;
        } else if (req.reliefCarve === false && req.reliefAnalyse === false) {
            cliArgs.push('--relief-export-only');
            keyParams.reliefCarve = false;
            keyParams.reliefAnalyse = false;
        } else if (req.reliefCarve === false) {
            cliArgs.push('--relief-no-carve');
            keyParams.reliefCarve = false;
        }
        if (req.reliefOcclusion !== undefined && req.reliefOcclusion !== false && req.relief !== false) {
            if (typeof req.reliefOcclusion === 'string') {
                const occ = resolveWithinRoot(this.workspaceRoot, req.reliefOcclusion);
                if (!occ.toLowerCase().endsWith('.glb') || !fs.existsSync(occ)) throw new TileRefineError('bad_request', 'reliefOcclusion must be true or an existing .glb inside the workspace');
                cliArgs.push('--relief-occluders', occ);
                const st = fs.statSync(occ);
                keyParams.reliefOcclusion = crypto.createHash('sha256').update(`${occ}\0${st.size}\0${st.mtimeMs}`).digest('hex');
            } else {
                cliArgs.push('--relief-occlusion');
                keyParams.reliefOcclusion = true;
            }
        }
        if (req.facadeFlatten === false) {
            cliArgs.push('--no-flatten');
            keyParams.facadeFlatten = false;
        } else if (req.facadeFlatten !== undefined && req.facadeFlatten !== true) {
            if (typeof req.facadeFlatten !== 'object' || req.facadeFlatten === null) throw new TileRefineError('bad_request', 'facadeFlatten must be a boolean or { band }');
            const band = req.facadeFlatten.band;
            if (band !== undefined) {
                if (!Number.isFinite(band) || band <= 0 || band > 0.5) throw new TileRefineError('bad_request', 'facadeFlatten.band must be a number of metres in (0, 0.5]');
                cliArgs.push('--flatten-band', String(band));
                keyParams.flattenBand = band;
            }
        }
        if (req.seamWeld === false) {
            cliArgs.push('--no-seam-weld');
            keyParams.seamWeld = false;
        } else if (req.seamWeld !== undefined && req.seamWeld !== true) {
            if (typeof req.seamWeld !== 'object' || req.seamWeld === null) throw new TileRefineError('bad_request', 'seamWeld must be a boolean or { toleranceM }');
            const tol = req.seamWeld.toleranceM;
            if (tol !== undefined) {
                if (!Number.isFinite(tol) || tol <= 0 || tol > 1) throw new TileRefineError('bad_request', 'seamWeld.toleranceM must be a number of metres in (0, 1]');
                cliArgs.push('--seam-weld-tolerance', String(tol));
                keyParams.seamWeldToleranceM = tol;
            }
        }
        if (req.isolate !== undefined && req.isolate !== false) {
            if (req.isolate !== true && (typeof req.isolate !== 'object' || req.isolate === null)) {
                throw new TileRefineError('bad_request', 'isolate must be true or { apron }');
            }
            cliArgs.push('--isolate');
            keyParams.isolate = true;
            const apron = req.isolate === true ? undefined : req.isolate.apron;
            if (apron !== undefined) {
                if (!Number.isFinite(apron) || apron < 0 || apron > 100) throw new TileRefineError('bad_request', 'isolate.apron must be a number of metres in 0..100');
                cliArgs.push('--apron', String(apron));
                keyParams.apron = apron;
            }
        }
        if (req.ownership !== undefined) {
            if (!keyParams.isolate) throw new TileRefineError('bad_request', 'ownership needs isolate');
            const masksDir = typeof req.ownership?.masksDir === 'string' ? resolveWithinRoot(this.workspaceRoot, req.ownership.masksDir) : '';
            if (!masksDir || !fs.existsSync(path.join(masksDir, 'views.txt'))) throw new TileRefineError('bad_request', 'ownership.masksDir must hold views.txt');
            cliArgs.push('--ownership-masks', masksDir);
            // the key is the evidence itself: the views and every mask
            const h = crypto.createHash('sha256');
            for (const f of fs.readdirSync(masksDir).filter(f => f === 'views.txt' || f.endsWith('.mask.png')).sort()) h.update(f).update('\0').update(fs.readFileSync(path.join(masksDir, f)));
            keyParams.ownership = h.digest('hex');
        }
        if (req.isolatePick !== undefined) {
            if (!keyParams.isolate) throw new TileRefineError('bad_request', 'isolatePick needs isolate');
            const pickFile = typeof req.isolatePick === 'string' ? resolveWithinRoot(this.workspaceRoot, req.isolatePick) : '';
            if (!pickFile || !fs.existsSync(pickFile)) throw new TileRefineError('bad_request', 'isolatePick must be an existing SBIP file');
            cliArgs.push('--isolate-pick', pickFile);
            keyParams.isolatePick = crypto.createHash('sha256').update(fs.readFileSync(pickFile)).digest('hex');
        }
        if (req.thumbnails) keyParams.thumbnails = true;
        if (req.reliefOrthos) keyParams.reliefOrthos = true;
        if (req.facadeGrammar !== undefined) {
            const file = typeof req.facadeGrammar === 'string' ? resolveWithinRoot(this.workspaceRoot, req.facadeGrammar) : '';
            if (!file || !fs.existsSync(file)) throw new TileRefineError('bad_request', 'facadeGrammar must be a grammar file inside the workspace');
            cliArgs.push('--facade-grammar', file);
            keyParams.facadeGrammar = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        }
        if (req.threads !== undefined) {
            if (!Number.isInteger(req.threads) || req.threads < 1 || req.threads > 256) throw new TileRefineError('bad_request', 'threads must be an integer in 1..256');
            cliArgs.push('--threads', String(req.threads));
        }
        return { input, cliArgs, keyParams };
    }

    async refine(req: TileRefineRequest): Promise<TileRefineResult> {
        const t0 = Date.now();
        const { input, cliArgs, keyParams } = this.resolveRequest(req);
        const publishTargets = req.publishAs === undefined ? undefined : this.resolvePublishTargets(req.publishAs, !!keyParams.isolate);
        const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TileRefineError('bad_request', 'timeoutMs must be > 0');

        const binary = await this.ensureBinary();
        const hash = crypto.createHash('sha256').update(CACHE_VERSION).update('\0').update(this.hashBinary(binary.path)).update('\0');
        sha256File(input, hash);
        hash.update('\0').update(JSON.stringify(keyParams));
        const key = hash.digest('hex');

        let pending = this.inFlight.get(key);
        if (!pending) {
            pending = this.runCached(key, input, cliArgs, !!keyParams.thumbnails, !!keyParams.isolate, binary, timeoutMs, !!keyParams.ownership, !!keyParams.reliefOrthos)
                .finally(() => this.inFlight.delete(key));
            this.inFlight.set(key, pending);
        }
        const result = { ...(await pending), ms: 0 };
        if (publishTargets) result.published = this.publish(result, publishTargets);
        result.ms = Date.now() - t0;
        return result;
    }

    /**
     * Writes registered views around the structure the geometric isolate finds (views.txt and <name>.png, the scan's own
     * texture, unlit) for segmentation, cached by the tile, the anchor and the binary. Returns the directory and the view names.
     */
    async renderOwnershipViews(req: Pick<TileRefineRequest, 'tilePath' | 'glbPath' | 'anchor' | 'isolate' | 'isolatePick' | 'timeoutMs'>): Promise<{ dir: string; views: string[]; cached: boolean; ms: number }> {
        const t0 = Date.now();
        const { input, cliArgs, keyParams } = this.resolveRequest({ ...req, isolate: req.isolate ?? true });
        const binary = await this.ensureBinary();
        const hash = crypto.createHash('sha256').update(CACHE_VERSION).update('\0ownership-render\0').update(this.hashBinary(binary.path)).update('\0');
        sha256File(input, hash);
        hash.update('\0').update(JSON.stringify(keyParams));
        const dir = path.join(this.cacheDir, `views_${hash.digest('hex')}`);
        const list = () => fs.readFileSync(path.join(dir, 'views.txt'), 'utf8').split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(' ')[0]);
        if (fs.existsSync(path.join(dir, 'done.json'))) return { dir, views: list(), cached: true, ms: Date.now() - t0 };
        const tmp = `${dir}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        fs.mkdirSync(tmp, { recursive: true });
        try {
            await runFile(binary.path, ['--input', input, '--ownership-render', tmp, '--stats', path.join(tmp, 'render_stats.json'), ...cliArgs], req.timeoutMs ?? this.defaultTimeoutMs);
            if (!fs.existsSync(path.join(tmp, 'views.txt'))) throw new TileRefineError('failed', 'tile_refine wrote no views.txt');
            fs.writeFileSync(path.join(tmp, 'done.json'), JSON.stringify({ input, cliArgs, at: new Date().toISOString() }));
            fs.rmSync(dir, { recursive: true, force: true });
            fs.renameSync(tmp, dir);
        } catch (err) {
            fs.rmSync(tmp, { recursive: true, force: true });
            if (!fs.existsSync(path.join(dir, 'done.json'))) throw err;
        }
        return { dir, views: list(), cached: false, ms: Date.now() - t0 };
    }

    private entryResult(dir: string, key: string, cached: boolean, binary: TileRefineResult['binary']): TileRefineResult {
        const thumbs = path.join(dir, 'thumbs');
        const rawClay = path.join(dir, 'raw_clay.glb');
        const votes = path.join(dir, 'ownership.sbov'), debug = path.join(dir, 'ownership_debug');
        const orthos = path.join(dir, 'relief_orthos');
        return {
            ...(fs.existsSync(path.join(orthos, 'facades.json')) ? { reliefOrthosDir: orthos } : {}),
            ...(fs.existsSync(votes) ? { ownershipVotes: votes } : {}),
            ...(fs.existsSync(debug) ? { ownershipDebugDir: debug } : {}),
            texturedGlb: path.join(dir, 'textured.glb'),
            clayGlb: path.join(dir, 'clay.glb'),
            rawClayGlb: fs.existsSync(rawClay) ? rawClay : undefined,
            stats: JSON.parse(fs.readFileSync(path.join(dir, 'stats.json'), 'utf8')),
            cached,
            ms: 0,
            cacheKey: key,
            thumbnailsDir: fs.existsSync(thumbs) ? thumbs : undefined,
            binary
        };
    }

    private async runCached(key: string, input: string, cliArgs: string[], thumbnails: boolean, isolate: boolean,
        binary: TileRefineResult['binary'], timeoutMs: number, ownership = false, reliefOrthos = false): Promise<TileRefineResult> {
        const dir = path.join(this.cacheDir, key);
        const done = path.join(dir, 'done.json');
        if (fs.existsSync(done)) return this.entryResult(dir, key, true, binary);

        fs.mkdirSync(this.cacheDir, { recursive: true });
        const tmp = path.join(this.cacheDir, `${key}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
        fs.mkdirSync(tmp);
        try {
            const args = ['--input', input,
                '--out-textured', path.join(tmp, 'textured.glb'),
                '--out-clay', path.join(tmp, 'clay.glb'),
                '--stats', path.join(tmp, 'stats.json'),
                ...cliArgs];
            if (thumbnails) args.push('--thumbs', path.join(tmp, 'thumbs'));
            if (isolate) args.push('--out-raw-clay', path.join(tmp, 'raw_clay.glb'));
            if (ownership) args.push('--ownership-out', path.join(tmp, 'ownership.sbov'), '--ownership-debug', path.join(tmp, 'ownership_debug'));
            if (reliefOrthos) args.push('--relief-orthos', path.join(tmp, 'relief_orthos'));
            const t0 = Date.now();
            await runFile(binary.path, args, timeoutMs);
            for (const f of ['textured.glb', 'clay.glb', 'stats.json', ...(isolate ? ['raw_clay.glb'] : [])]) {
                if (!fs.existsSync(path.join(tmp, f))) throw new TileRefineError('failed', `tile_refine did not write ${f}`);
            }
            // the stats name the files where they were written; point them at the final entry
            const statsFile = path.join(tmp, 'stats.json');
            const esc = (p: string) => JSON.stringify(p).slice(1, -1);
            fs.writeFileSync(statsFile, fs.readFileSync(statsFile, 'utf8').split(esc(tmp)).join(esc(dir)));
            fs.writeFileSync(path.join(tmp, 'done.json'), JSON.stringify({ input, cliArgs, runMs: Date.now() - t0, at: new Date().toISOString() }));
            fs.rmSync(dir, { recursive: true, force: true }); // an incomplete entry from an interrupted run
            fs.renameSync(tmp, dir);
        } catch (err) {
            fs.rmSync(tmp, { recursive: true, force: true });
            if (fs.existsSync(done)) return this.entryResult(dir, key, true, binary); // another process finished it
            throw err;
        }
        return this.entryResult(dir, key, false, binary);
    }

    private resolvePublishTargets(publishAs: TileRefineRequest['publishAs'], isolate: boolean): Partial<Record<PublishKind, string>> {
        let names: Partial<Record<PublishKind, string>>;
        if (typeof publishAs === 'string') {
            if (!PUBLISH_NAME.test(publishAs)) throw new TileRefineError('bad_request', 'publishAs must be a plain name ([A-Za-z0-9_-], up to 64 chars)');
            names = { textured: `${publishAs}_refined.glb`, clay: `${publishAs}_refined_clay.glb` };
            if (isolate) names.rawClay = `${publishAs}_raw_clay.glb`;
        } else if (publishAs && typeof publishAs === 'object') {
            names = { textured: publishAs.textured, clay: publishAs.clay, rawClay: publishAs.rawClay };
            for (const n of Object.values(names)) {
                if (n !== undefined && (typeof n !== 'string' || !PUBLISH_FILE.test(n))) {
                    throw new TileRefineError('bad_request', 'publishAs file names must be plain *.glb names');
                }
            }
            if (!names.textured && !names.clay && !names.rawClay) throw new TileRefineError('bad_request', 'publishAs needs textured, clay and/or rawClay');
            if (names.rawClay && !isolate) throw new TileRefineError('bad_request', 'publishAs.rawClay needs isolate');
        } else {
            throw new TileRefineError('bad_request', 'publishAs must be a name or { textured?, clay?, rawClay? }');
        }
        const models = resolveWithinRoot(this.workspaceRoot, path.join('public', 'models'));
        const targets: Partial<Record<PublishKind, string>> = {};
        for (const kind of PUBLISH_KINDS) {
            const n = names[kind];
            if (n) targets[kind] = resolveWithinRoot(models, n);
        }
        if (new Set(Object.values(targets)).size !== Object.keys(targets).length) {
            throw new TileRefineError('bad_request', 'publishAs file names must differ');
        }
        return targets;
    }

    private publish(result: TileRefineResult, targets: Partial<Record<PublishKind, string>>): TileRefinePublished {
        const out: TileRefinePublished = { urls: {}, backups: [] };
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const publicDir = resolveWithinRoot(this.workspaceRoot, 'public');
        const sources: Record<PublishKind, string | undefined> = { textured: result.texturedGlb, clay: result.clayGlb, rawClay: result.rawClayGlb };
        for (const kind of PUBLISH_KINDS) {
            const target = targets[kind];
            if (!target) continue;
            const source = sources[kind];
            if (!source) throw new TileRefineError('failed', `no ${kind} output to publish`);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            const existing = fs.existsSync(target);
            if (!existing || !sameBytes(source, target)) {
                if (existing) {
                    const backup = resolveWithinRoot(this.workspaceRoot, path.join('.scratchbox', 'backup', 'pre_tile_refine', stamp, path.basename(target)));
                    fs.mkdirSync(path.dirname(backup), { recursive: true });
                    fs.copyFileSync(target, backup);
                    out.backups.push(path.relative(this.workspaceRoot, backup));
                }
                const tmp = `${target}.tmp-${process.pid}`;
                fs.copyFileSync(source, tmp);
                fs.renameSync(tmp, target);
            }
            out[kind] = path.relative(this.workspaceRoot, target);
            out.urls[kind] = '/' + path.relative(publicDir, target).split(path.sep).join('/');
        }
        return out;
    }
}

const services = new Map<string, TileRefineService>();

/** One service per workspace root, so concurrent identical requests share a run and a build. */
export function getTileRefineService(workspaceRoot: string): TileRefineService {
    const root = resolveWithinRoot(workspaceRoot, '.');
    let svc = services.get(root);
    if (!svc) {
        svc = new TileRefineService({ workspaceRoot: root });
        services.set(root, svc);
    }
    return svc;
}

/** The headline numbers of a tile_refine stats JSON (the full JSON is ~10 KB). */
export function summarizeTileRefineStats(stats: Record<string, any>): Record<string, unknown> {
    return {
        totalMs: stats.totalMs,
        stagesMs: stats.stagesMs,
        triangles: stats.triangles,
        outputTriangles: stats.outputs?.triangles,
        seamWeld: stats.seamWeld?.enabled ? {
            toleranceM: stats.seamWeld.toleranceM,
            pieces: stats.seamWeld.pieces,
            contactsFound: stats.seamWeld.contactsFound,
            groupsWelded: stats.seamWeld.groupsWelded,
            groupsReverted: stats.seamWeld.groupsReverted,
            stripPiecesDropped: stats.seamWeld.stripPiecesDropped,
            trianglesDropped: stats.seamWeld.trianglesDropped,
            meanWeldDisplacementM: stats.seamWeld.meanWeldDisplacementM,
            maxWeldDisplacementM: stats.seamWeld.maxWeldDisplacementM
        } : undefined,
        isolate: stats.isolate?.enabled ? {
            triangles: stats.isolate.triangles,
            footprintBounds: stats.isolate.footprintBounds,
            height_m: stats.isolate.height_m,
            images: stats.isolate.images
        } : undefined,
        facadeFlatten: stats.flatten ? {
            planes: stats.flatten.planes,
            movedVertices: stats.flatten.movedVertices,
            displacementMax_m: stats.flatten.displacement_m?.max,
            guardSettled: stats.flatten.guardSettled
        } : undefined,
        relief: stats.relief?.enabled ? {
            provenance: stats.relief.provenance ?? (stats.relief.regionsTreated ? 'inferred' : 'none'),
            facadesTreated: stats.relief.regionsTreated,
            recessArea_m2: stats.relief.recessArea_m2,
            proudArea_m2: stats.relief.proudArea_m2,
            heightMin_m: stats.relief.heightMin_m,
            heightMax_m: stats.relief.heightMax_m,
            latticesRejected: stats.relief.latticesRejected,
            proudClampedDropped: stats.relief.proudClampedDropped
        } : undefined,
        proudFeatures: stats.proudFeatures ? {
            features: stats.proudFeatures.features,
            removed: stats.proudFeatures.removed,
            removedArea_m2: stats.proudFeatures.removedArea_m2,
            retainedVolumeShare: stats.proudFeatures.retainedVolumeShare,
            blocksKept: stats.rectify?.proudBlocks?.blocks
        } : undefined,
        rectifyFlips: stats.rectify?.flips,
        reliefFlips: stats.relief?.flips,
        openEdges: stats.openEdges?.final
    };
}
