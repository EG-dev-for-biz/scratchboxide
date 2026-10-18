/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Service wrapper for the scan fitter (scratchbox_scan_fit.hpp), the facade orthos (scratchbox_scan_ortho.hpp) and the
 * ornament builder (scratchbox_ornament.hpp), all behind scripts/scan_fit.cpp:
 *
 * - fit: an isolated scan in; a StructureFit (the measured rebuild: primitives, surfaces, slots, residuals, gates), the
 *   fitted surfaces (one node per surface), the outlines (one LINES node per primitive), what the fit does not explain (kept
 *   as scanned) and one ortho PNG per fitted surface out. A failed gate is a result (accepted: false), not an error.
 * - refit: the same fit with parameter overrides, by (primitive id, fitParams index); ids stay, the corrected primitives
 *   are photo-corrected.
 * - ornament: a StructureFit and an OrnamentSpec in; the detail layer (the four operators built through the fitted charts)
 *   and what was built or dropped, with the checks that dropped it, out.
 * - flatten: a scan, optionally isolated by a footprint, with every vertex that lies within a band of a fitted plane (and all
 *   of whose triangles belong to that plane) moved onto it.
 *
 * Paths are confined to the workspace root. The binary is built with clang++ on first use and rebuilt when one of its
 * sources is newer, once across processes (native-build); the time a call waits for a build is reported
 * (waitedForEngineMs). It runs without a shell, with the call's AbortSignal (SIGKILL) and a timeout, and its progress
 * lines ("PROGRESS <0..1> <message>") reach onProgress. Results are cached under
 * <root>/.scratchbox/cache/scan_fit/<sha256(binary + inputs + params)>/ (a temp directory, a rename, done.json) and every
 * output is checked against its contract. A failure that no retry can change (an unreadable input, no structure) is
 * remembered under the same key; one that a retry may fix (a failed build, a timeout, a stop) is not.
 */

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    SCAN_FIT_ERROR_TRANSIENT,
    validateContract,
    type FlattenStats,
    type OrnamentBuildReport,
    type ScanFitCall,
    type ScanFitErrorCode,
    type ScanFitFitRequest,
    type ScanFitFitResult,
    type ScanFitFlattenRequest,
    type ScanFitFlattenResult,
    type ScanFitOrnamentRequest,
    type ScanFitOrnamentResult,
    type ScanFitOutput,
    type ScanFitRefitRequest,
    type StructureFit
} from '../../common/spatial/staged-location-contracts';
import { resolveWithinRoot } from '../security/path-guard';
import { buildNativeIfStale } from './native-build';

export class ScanFitError extends Error {
    readonly transient: boolean;
    constructor(readonly code: ScanFitErrorCode, message: string, readonly detail?: string) {
        super(message);
        this.name = 'ScanFitError';
        const known = (SCAN_FIT_ERROR_TRANSIENT as Record<string, boolean>)[code];
        this.transient = known === undefined ? true : known;
    }
}

export interface ScanFitServiceOptions {
    workspaceRoot: string;
    /** Where scripts/scan_fit.cpp and the engine headers live (default: discovered from this file, else cwd). */
    repoRoot?: string;
    /** A prebuilt binary to run instead of building one. */
    binaryPath?: string;
    cacheDir?: string;
    defaultTimeoutMs?: number;
}

const CLI_SOURCE = path.join('scripts', 'scan_fit.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const BINARY = path.join('build', '3d-native', 'scan_fit');
const CACHE_VERSION = 'scan_fit/v1';

/** The checkout that holds scripts/scan_fit.cpp: walks up from this file, then from cwd. */
export function findScanFitRepoRoot(): string {
    for (const start of [__dirname, process.cwd()]) {
        let dir = path.resolve(start);
        for (;;) {
            if (fs.existsSync(path.join(dir, CLI_SOURCE))) return dir;
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    return process.cwd();
}

function fileSha256(file: string): string {
    const h = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.allocUnsafe(1 << 20);
        let n: number;
        while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
    } finally {
        fs.closeSync(fd);
    }
    return h.digest('hex');
}

const stoppedError = (): ScanFitError => new ScanFitError('aborted', 'Stopped by the chat before it finished');

interface RunOutcome { stdout: string; stderr: string }

/**
 * Runs the binary without a shell. `onProgress` gets the "PROGRESS <fraction> <message>" lines as they arrive; `signal`
 * kills it (SIGKILL). The CLI's own failure is the JSON line on stdout ({"ok":false,"code","message"}).
 */
function runCli(file: string, args: string[], timeoutMs: number, onProgress?: ScanFitCall['onProgress'], signal?: AbortSignal): Promise<RunOutcome> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(stoppedError()); return; }
        const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '';
        let stderr = '';
        let tail = '';
        let timedOut = false;
        let stopped = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
        const onAbort = () => { stopped = true; child.kill('SIGKILL'); };
        signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout.on('data', d => { stdout += String(d); if (stdout.length > 32 * 1024 * 1024) stdout = stdout.slice(-1024 * 1024); });
        child.stderr.on('data', d => {
            const text = String(d);
            stderr = (stderr + text).slice(-64 * 1024);
            tail += text;
            let at: number;
            while ((at = tail.indexOf('\n')) >= 0) {
                const line = tail.slice(0, at);
                tail = tail.slice(at + 1);
                const m = line.match(/^PROGRESS ([0-9.eE+-]+) (.*)$/);
                if (m && onProgress) { try { onProgress(Math.min(1, Math.max(0, Number(m[1]))), m[2]); } catch { /* a listener's failure does not stop the run */ } }
            }
        });
        child.on('error', err => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(new ScanFitError('crashed', `could not run ${path.basename(file)}: ${err.message}`)); });
        child.on('close', (code, sig) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            if (stopped) { reject(stoppedError()); return; }
            if (timedOut) { reject(new ScanFitError('timeout', `${path.basename(file)} timed out after ${timeoutMs} ms`, stderr.slice(-2000))); return; }
            if (code === 0) { resolve({ stdout, stderr }); return; }
            const last = stdout.trim().split('\n').filter(Boolean).pop();
            if (last) {
                try {
                    const j = JSON.parse(last);
                    if (j && j.ok === false && typeof j.code === 'string') { reject(new ScanFitError(j.code, String(j.message ?? j.code), stderr.slice(-2000))); return; }
                } catch { /* not the CLI's own failure line */ }
            }
            reject(new ScanFitError('crashed', `${path.basename(file)} ${sig ? `was killed by ${sig}` : `exited with ${code}`}`, (stderr || stdout).slice(-2000)));
        });
    });
}

export class ScanFitService {
    readonly workspaceRoot: string;
    readonly repoRoot: string;
    readonly cacheDir: string;
    private readonly binaryOverride?: string;
    private readonly defaultTimeoutMs: number;
    private building?: Promise<string>;
    private binaryHash?: { key: string; hex: string };

    constructor(options: ScanFitServiceOptions) {
        this.workspaceRoot = resolveWithinRoot(options.workspaceRoot, '.');
        this.repoRoot = path.resolve(options.repoRoot ?? findScanFitRepoRoot());
        this.cacheDir = options.cacheDir
            ? resolveWithinRoot(this.workspaceRoot, options.cacheDir)
            : resolveWithinRoot(this.workspaceRoot, path.join('.scratchbox', 'cache', 'scan_fit'));
        this.binaryOverride = options.binaryPath ? path.resolve(options.binaryPath) : undefined;
        this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
    }

    /** Builds build/3d-native/scan_fit when it is missing or older than any of its sources (public, for the warm-up). */
    ensureBinary(): Promise<string> {
        if (this.binaryOverride) {
            if (!fs.existsSync(this.binaryOverride)) return Promise.reject(new ScanFitError('build_failed', `scan_fit binary not found: ${this.binaryOverride}`));
            return Promise.resolve(this.binaryOverride);
        }
        if (!this.building) this.building = this.buildIfStale().finally(() => { this.building = undefined; });
        return this.building;
    }

    private async buildIfStale(): Promise<string> {
        const source = path.join(this.repoRoot, CLI_SOURCE);
        if (!fs.existsSync(source)) throw new ScanFitError('build_failed', `scan_fit source not found: ${source}`);
        try {
            return await buildNativeIfStale({ source, binary: path.join(this.repoRoot, BINARY), includeDir: path.join(this.repoRoot, INCLUDE_DIR), flags: ['-pthread'], libs: ['-lz'], timeoutMs: 900_000 });
        } catch (err) {
            throw new ScanFitError('build_failed', 'could not build scan_fit', (err as Error).message);
        }
    }

    /** The binary, how long this call waited for it to be built, and when the binary was built. */
    private async engine(): Promise<{ bin: string; waitedMs: number; builtAtMs: number; sha: string }> {
        const t0 = Date.now();
        const bin = await this.ensureBinary();
        const waitedMs = Date.now() - t0;
        const st = fs.statSync(bin);
        const key = `${bin}:${st.size}:${st.mtimeMs}`;
        if (this.binaryHash?.key !== key) this.binaryHash = { key, hex: fileSha256(bin) };
        return { bin, waitedMs: waitedMs < 50 ? 0 : waitedMs, builtAtMs: Math.floor(st.mtimeMs), sha: this.binaryHash.hex };
    }

    private input(p: string | undefined, what: string, ext: string): string {
        if (typeof p !== 'string' || !p.trim()) throw new ScanFitError('input_unreadable', `${what} is required`);
        const file = resolveWithinRoot(this.workspaceRoot, p.trim());
        if (!file.toLowerCase().endsWith(ext)) throw new ScanFitError('input_unreadable', `${what} must be a ${ext} file`);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new ScanFitError('input_unreadable', `${what} not found: ${p}`);
        return file;
    }

    /**
     * Runs `produce` into a fresh temp directory and renames it into the cache entry, unless the entry exists. A
     * non-transient failure is written beside it and thrown again by the next identical request.
     */
    private async cached<T>(key: string, outputs: string[], call: ScanFitCall, produce: (dir: string, signal?: AbortSignal) => Promise<void>, result: (dir: string) => T): Promise<{ value: T; dir: string; cached: boolean }> {
        const dir = path.join(this.cacheDir, key);
        const done = path.join(dir, 'done.json');
        const failed = path.join(this.cacheDir, `${key}.failed.json`);
        if (fs.existsSync(done)) return { value: result(dir), dir, cached: true };
        if (fs.existsSync(failed)) {
            const f = JSON.parse(fs.readFileSync(failed, 'utf8'));
            throw new ScanFitError(f.code, f.message, f.detail);
        }
        if (call.signal?.aborted) throw stoppedError();
        fs.mkdirSync(this.cacheDir, { recursive: true });
        const tmp = path.join(this.cacheDir, `${key}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
        fs.mkdirSync(tmp);
        try {
            await produce(tmp, call.signal);
            for (const f of outputs) if (!fs.existsSync(path.join(tmp, f))) throw new ScanFitError('invalid_output', `scan_fit did not write ${f}`);
            fs.writeFileSync(path.join(tmp, 'done.json'), JSON.stringify({ at: new Date().toISOString() }));
            fs.rmSync(dir, { recursive: true, force: true });
            fs.renameSync(tmp, dir);
        } catch (err) {
            fs.rmSync(tmp, { recursive: true, force: true });
            if (fs.existsSync(done)) return { value: result(dir), dir, cached: true };
            if (err instanceof ScanFitError && !err.transient) fs.writeFileSync(failed, JSON.stringify({ code: err.code, message: err.message, detail: err.detail }));
            throw err;
        }
        return { value: result(dir), dir, cached: false };
    }

    private envelope<T>(value: T, dir: string, file: string, key: string, engine: { sha: string; builtAtMs: number; waitedMs: number }, cached: boolean, t0: number): ScanFitOutput<T> {
        return { value, path: path.join(dir, file), dir, key, binarySha256: engine.sha, cached, builtAtMs: engine.builtAtMs, ms: Date.now() - t0, waitedForEngineMs: engine.waitedMs };
    }

    /** Reads a JSON output and refuses it unless it is the contract's. */
    private readContract<T>(file: string, name: 'StructureFit' | 'OrnamentBuildReport' | 'FlattenStats'): T {
        // a binary that exits cleanly having written nothing, or something that is not JSON, is an invalid output, not an untyped fault
        if (!fs.existsSync(file)) throw new ScanFitError('invalid_output', `scan_fit did not write ${path.basename(file)}`);
        let value: unknown;
        try {
            value = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (err) {
            throw new ScanFitError('invalid_output', `scan_fit wrote ${path.basename(file)} and it is not JSON: ${(err as Error).message}`);
        }
        const problems = validateContract(name, value);
        if (problems.length) throw new ScanFitError('invalid_output', `scan_fit wrote a ${name} that does not validate: ${problems.slice(0, 6).join('; ')}`);
        // the contract holds the footprint's shape; a polygon that encloses nothing is a placeholder, and a consumer would isolate or size by it
        if (name === 'StructureFit') {
            const fp = (value as { footprint?: { outer: number[][]; areaM2: number } }).footprint;
            let a = 0;
            if (fp) for (let i = 0; i < fp.outer.length; i++) { const p = fp.outer[i], q = fp.outer[(i + 1) % fp.outer.length]; a += p[0] * q[1] - q[0] * p[1]; }
            if (!fp || !(Math.abs(a) / 2 > 1e-6) || !(fp.areaM2 > 0)) throw new ScanFitError('invalid_output', `scan_fit wrote a StructureFit whose footprint encloses no area (${fp ? fp.areaM2 : 'missing'} m2)`);
        }
        return value as T;
    }

    /** The StructureFit with the output names made absolute, as the contract describes them. */
    private absoluteOutputs(fit: StructureFit, dir: string): StructureFit {
        const o = fit.outputs;
        return {
            ...fit,
            outputs: {
                ...o,
                fittedGlb: path.join(dir, o.fittedGlb),
                outlinesGlb: path.join(dir, o.outlinesGlb),
                ...(o.passThroughGlb ? { passThroughGlb: path.join(dir, o.passThroughGlb) } : {}),
                orthos: o.orthos.map(x => ({ ...x, path: path.join(dir, x.path) })),
                reportJson: path.join(dir, o.reportJson)
            }
        };
    }

    async fit(req: ScanFitFitRequest): Promise<ScanFitFitResult> {
        const t0 = Date.now();
        const scan = this.input(req.scanGlb, 'scanGlb', '.glb');
        const textured = req.texturedGlb ? this.input(req.texturedGlb, 'texturedGlb', '.glb') : undefined;
        const remesh = req.remeshGlb ? this.input(req.remeshGlb, 'remeshGlb', '.glb') : undefined;
        const votes = req.ownershipVotes ? this.input(req.ownershipVotes, 'ownershipVotes', '.sbov') : undefined;
        const a = req.anchor;
        if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.z)) throw new ScanFitError('input_unreadable', 'anchor must be finite metres { x, z } in the tile frame');
        const limits = req.sourceLimits;
        if (!limits || !(limits.leafGeometricErrorM > 0)) throw new ScanFitError('input_unreadable', 'sourceLimits.leafGeometricErrorM must be > 0');
        const engine = await this.engine();
        const scanSha = fileSha256(scan);
        const texturedSha = textured ? fileSha256(textured) : '';
        const remeshSha = remesh ? fileSha256(remesh) : '';
        const key = crypto.createHash('sha256').update(CACHE_VERSION).update('\0fit\0').update(engine.sha)
            .update(JSON.stringify([scanSha, texturedSha, remeshSha, [a.x, a.z], limits.leafGeometricErrorM, limits.texelM, ...(votes ? [fileSha256(votes)] : [])])).digest('hex');
        const res = await this.cached(key, ['structure_fit.json', 'fitted.glb', 'outlines.glb'], req, async (dir, signal) => {
            fs.writeFileSync(path.join(dir, 'source_limits.json'), JSON.stringify({ leafGeometricErrorM: limits.leafGeometricErrorM, ...(limits.texelM ? { texelM: limits.texelM } : {}) }));
            const args = ['fit', '--scan', scan, '--anchor', `${a.x},${a.z}`, '--source-limits-json', path.join(dir, 'source_limits.json'), '--scan-sha256', scanSha,
                '--scan-source', path.basename(scan), '--stage-key', key, '--out-dir', dir];
            if (textured) args.push('--textured', textured, '--textured-sha256', texturedSha);
            if (remesh) args.push('--remesh', remesh);
            if (votes) args.push('--ownership', votes);
            await runCli(engine.bin, args, req.timeoutMs ?? this.defaultTimeoutMs, req.onProgress, signal);
            // what a refit needs again (the inputs it re-reads)
            fs.writeFileSync(path.join(dir, 'inputs.json'), JSON.stringify({ scan, textured, remesh, ...(votes ? { ownership: votes } : {}), anchor: [a.x, a.z], leafGeometricErrorM: limits.leafGeometricErrorM, texelM: limits.texelM ?? null, scanSha256: scanSha }));
            this.readContract<StructureFit>(path.join(dir, 'structure_fit.json'), 'StructureFit');
        }, dir => this.absoluteOutputs(this.readContract<StructureFit>(path.join(dir, 'structure_fit.json'), 'StructureFit'), dir));
        return this.envelope(res.value, res.dir, 'structure_fit.json', key, engine, res.cached, t0);
    }

    async refit(req: ScanFitRefitRequest): Promise<ScanFitFitResult> {
        const t0 = Date.now();
        const fitFile = this.input(req.fitPath, 'fitPath', '.json');
        const scan = this.input(req.scanGlb, 'scanGlb', '.glb');
        if (!Array.isArray(req.set) || !req.set.length) throw new ScanFitError('input_unreadable', 'set must name at least one parameter');
        for (const s of req.set) {
            if (typeof s.primitiveId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(s.primitiveId) || !Number.isInteger(s.param) || s.param < 0 || !Number.isFinite(s.value)) {
                throw new ScanFitError('input_unreadable', 'every override is a primitive id, a parameter index and a finite value');
            }
        }
        const engine = await this.engine();
        const inputsFile = path.join(path.dirname(fitFile), 'inputs.json');
        const inputs = fs.existsSync(inputsFile) ? JSON.parse(fs.readFileSync(inputsFile, 'utf8')) : {};
        const fitSha = fileSha256(fitFile);
        const scanSha = fileSha256(scan);
        const set = req.set.map(s => `${s.primitiveId}:${s.param}=${s.value}`).sort();
        const key = crypto.createHash('sha256').update(CACHE_VERSION).update('\0refit\0').update(engine.sha).update(JSON.stringify([fitSha, scanSha, set])).digest('hex');
        const res = await this.cached(key, ['structure_fit.json', 'fitted.glb', 'outlines.glb'], req, async (dir, signal) => {
            const args = ['refit', '--fit', fitFile, '--scan', scan, '--scan-sha256', scanSha, '--refit-of', fitSha, '--stage-key', key, '--out-dir', dir];
            for (const s of set) args.push('--set', s);
            if (typeof inputs.textured === 'string' && fs.existsSync(inputs.textured)) args.push('--textured', inputs.textured, '--textured-sha256', fileSha256(inputs.textured));
            if (typeof inputs.remesh === 'string' && fs.existsSync(inputs.remesh)) args.push('--remesh', inputs.remesh);
            if (typeof inputs.ownership === 'string' && fs.existsSync(inputs.ownership)) args.push('--ownership', inputs.ownership);
            await runCli(engine.bin, args, req.timeoutMs ?? this.defaultTimeoutMs, req.onProgress, signal);
            fs.writeFileSync(path.join(dir, 'inputs.json'), JSON.stringify(inputs));
            this.readContract<StructureFit>(path.join(dir, 'structure_fit.json'), 'StructureFit');
        }, dir => this.absoluteOutputs(this.readContract<StructureFit>(path.join(dir, 'structure_fit.json'), 'StructureFit'), dir));
        return this.envelope(res.value, res.dir, 'structure_fit.json', key, engine, res.cached, t0);
    }

    async ornament(req: ScanFitOrnamentRequest): Promise<ScanFitOrnamentResult> {
        const t0 = Date.now();
        const fitFile = this.input(req.fitPath, 'fitPath', '.json');
        const textured = this.input(req.texturedGlb, 'texturedGlb', '.glb');
        const problems = validateContract('OrnamentSpec', req.spec);
        if (problems.length) throw new ScanFitError('input_unreadable', `the ornament spec is not an OrnamentSpec: ${problems.slice(0, 6).join('; ')}`);
        const fitted = path.join(path.dirname(fitFile), 'fitted.glb');
        if (!fs.existsSync(fitted)) throw new ScanFitError('input_unreadable', `the fit's fitted.glb is missing beside ${path.basename(fitFile)}`);
        const engine = await this.engine();
        const specText = JSON.stringify(req.spec);
        const key = crypto.createHash('sha256').update(CACHE_VERSION).update('\0ornament\0').update(engine.sha)
            .update(JSON.stringify([fileSha256(fitFile), fileSha256(fitted), fileSha256(textured)])).update(specText).digest('hex');
        const res = await this.cached(key, ['detail.glb', 'build_report.json'], req, async (dir, signal) => {
            fs.writeFileSync(path.join(dir, 'ornament_spec.json'), specText);
            await runCli(engine.bin, ['ornament', '--fit', fitFile, '--fitted', fitted, '--spec', path.join(dir, 'ornament_spec.json'), '--textured', textured, '--stage-key', key, '--out-dir', dir],
                req.timeoutMs ?? this.defaultTimeoutMs, req.onProgress, signal);
            this.readContract<OrnamentBuildReport>(path.join(dir, 'build_report.json'), 'OrnamentBuildReport');
        }, dir => this.readContract<OrnamentBuildReport>(path.join(dir, 'build_report.json'), 'OrnamentBuildReport'));
        return { ...this.envelope(res.value, res.dir, 'build_report.json', key, engine, res.cached, t0), detailGlb: path.join(res.dir, 'detail.glb') };
    }

    async flatten(req: ScanFitFlattenRequest): Promise<ScanFitFlattenResult> {
        const t0 = Date.now();
        const input = this.input(req.inputGlb, 'inputGlb', '.glb');
        if (req.bandM !== undefined && !(Number.isFinite(req.bandM) && req.bandM > 0 && req.bandM <= 1)) throw new ScanFitError('input_unreadable', 'bandM must be in (0, 1] metres');
        if (req.footprint && (req.footprint.length < 3 || req.footprint.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)))) throw new ScanFitError('input_unreadable', 'footprint must be at least three [x, z] points in metres');
        const engine = await this.engine();
        const band = req.bandM ?? 0.1;
        const key = crypto.createHash('sha256').update(CACHE_VERSION).update('\0flatten\0').update(engine.sha).update(JSON.stringify([fileSha256(input), req.footprint ?? null, band])).digest('hex');
        const res = await this.cached(key, ['flattened.glb', 'stats.json'], req, async (dir, signal) => {
            const args = ['flatten', '--input', input, '--band', String(band), '--stage-key', key, '--out', path.join(dir, 'flattened.glb'), '--stats', path.join(dir, 'stats.json')];
            if (req.footprint) {
                fs.writeFileSync(path.join(dir, 'footprint.json'), JSON.stringify({ polygon: req.footprint }));
                args.push('--footprint-json', path.join(dir, 'footprint.json'));
            }
            await runCli(engine.bin, args, req.timeoutMs ?? this.defaultTimeoutMs, req.onProgress, signal);
            this.readContract<FlattenStats>(path.join(dir, 'stats.json'), 'FlattenStats');
        }, dir => this.readContract<FlattenStats>(path.join(dir, 'stats.json'), 'FlattenStats'));
        return { ...this.envelope(res.value, res.dir, 'stats.json', key, engine, res.cached, t0), glb: path.join(res.dir, 'flattened.glb') };
    }
}

const services = new Map<string, ScanFitService>();

/** One service per workspace root, so every caller shares one build. */
export function getScanFitService(workspaceRoot: string): ScanFitService {
    const root = resolveWithinRoot(workspaceRoot, '.');
    let svc = services.get(root);
    if (!svc) {
        svc = new ScanFitService({ workspaceRoot: root });
        services.set(root, svc);
    }
    return svc;
}
