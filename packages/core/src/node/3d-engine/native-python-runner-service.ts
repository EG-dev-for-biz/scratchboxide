/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { resolveWithinRoot } from '../security/path-guard';
import { buildScrubbedEnv } from '../security/sandbox-policy';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const BUILD_STAMP = '.scratchbox-build-stamp';
const BUILD_LOCK_STALE_MS = 20 * 60 * 1000;
// One in-flight build per engine dir within this process; other processes are serialized by a lock directory.
const nativeBuilds = new Map<string, Promise<string | null>>();

/** Host variables a Python interpreter/venv legitimately needs beyond the sandbox allowlist. */
const PYTHON_HOST_ENV_PASSTHROUGH = ['VIRTUAL_ENV', 'CONDA_PREFIX', 'CONDA_DEFAULT_ENV', 'PYTHONHOME'];

/**
 * Builds the child environment for model-authored Python scripts: the scrubbed sandbox env
 * (PATH, HOME, TMPDIR, ... with no API keys or credentials) plus interpreter/venv variables,
 * non-secret SCRATCHBOX_* engine settings, the caller's explicit `options.env`, and the
 * runner-managed variables (PYTHONPATH, PYTHONUNBUFFERED, ...), which win last.
 */
export function buildPythonChildEnv(
    callerEnv: Record<string, string | undefined> | undefined,
    runnerEnv: Record<string, string>,
    hostEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
    const hostExtras: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(hostEnv)) {
        if (name.startsWith('SCRATCHBOX_') || PYTHON_HOST_ENV_PASSTHROUGH.includes(name)) hostExtras[name] = value;
    }
    const env = buildScrubbedEnv(hostEnv, hostExtras);
    // Variables the caller passes explicitly are deliberate inputs to the script; keep them verbatim.
    for (const [name, value] of Object.entries(callerEnv || {})) {
        if (typeof value === 'string') env[name] = value;
    }
    return { ...env, ...runnerEnv };
}

export interface PythonExecutionAsset {
    name: string;
    content: string | Uint8Array;
    encoding?: 'utf8' | 'base64';
}

export interface PythonExecutionOptions {
    outputDir?: string;
    outputGlbPath?: string;
    timeoutMs?: number;
    args?: string[];
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    assets?: PythonExecutionAsset[];
}

export interface PythonExecutionResult {
    success: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    executionTimeMs: number;
    glbPath?: string;
    glbBase64?: string;
    errorDetails?: string;
}

/** A file's identity at one moment: undefined when it does not exist. */
export interface GlbFileStamp {
    mtimeMs: number;
    ctimeMs: number;
    size: number;
    ino: number;
}

export function stampGlbFile(filePath: string): GlbFileStamp | undefined {
    try {
        const st = fs.statSync(filePath);
        return { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, ino: st.ino };
    } catch {
        return undefined;
    }
}

/**
 * The GLB file a run is expected to write: OUTPUT_GLB_PATH (unique per runScript call), else <script>.glb next to
 * the script. There is no shared fallback name such as output.glb in the working directory, which another run may
 * have written.
 */
export function expectedGlbFile(outputGlbPath: string | undefined, scriptPath: string): string {
    return outputGlbPath || path.join(path.dirname(scriptPath), `${path.basename(scriptPath, '.py')}.glb`);
}

/**
 * The expected GLB when this run wrote it: the file exists and did not exist, or differed, when `before` was taken
 * right before the script started. A previous run's file at that path is never reported as this run's model.
 */
export function findWrittenGlb(expected: string, before: GlbFileStamp | undefined): string | undefined {
    const after = stampGlbFile(expected);
    if (!after) return undefined;
    if (!before) return expected;
    const changed = after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || after.size !== before.size || after.ino !== before.ino;
    return changed ? expected : undefined;
}

/**
 * NativePythonRunnerService
 *
 * Executes Python 3D scene generation scripts powered by Scratchbox C++20 engine
 * nanobind bindings. Allows AI coding assistants (Codex, Claude, Antigravity)
 * to construct complex 3D scenes using high-level Python abstractions (mirroring Blender bpy)
 * while executing at native C++20 speed and streaming glTF 2.0 (.glb) into the canvas viewport.
 */
export class NativePythonRunnerService {
    private static instance?: NativePythonRunnerService;
    private pythonExecutable: string;
    private moduleDirectory: string;

    public static getInstance(): NativePythonRunnerService {
        if (!NativePythonRunnerService.instance) {
            NativePythonRunnerService.instance = new NativePythonRunnerService();
        }
        return NativePythonRunnerService.instance;
    }

    constructor(customPython?: string, customModuleDir?: string) {
        this.pythonExecutable = customPython || this.resolvePythonExecutable();
        this.moduleDirectory = customModuleDir || this.resolveModuleDirectory();
    }

    /**
     * Find the repository root dynamically (containing packages/core and package.json).
     */
    private resolveRepoRoot(): string {
        let cur = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
        while (cur && cur !== path.dirname(cur)) {
            if (fs.existsSync(path.join(cur, 'packages/core')) && fs.existsSync(path.join(cur, 'package.json'))) {
                return cur;
            }
            cur = path.dirname(cur);
        }
        return process.cwd();
    }

    /**
     * Locate the preferred Python interpreter (.venv first, then system).
     */
    private resolvePythonExecutable(): string {
        if (process.env.SCRATCHBOX_PYTHON && fs.existsSync(process.env.SCRATCHBOX_PYTHON)) {
            return process.env.SCRATCHBOX_PYTHON;
        }

        const repoRoot = this.resolveRepoRoot();
        const baseDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
        const candidatePaths = [
            path.resolve(repoRoot, '.venv/bin/python'),
            path.resolve(repoRoot, '.venv/bin/python3'),
            path.resolve(process.cwd(), '.venv/bin/python'),
            path.resolve(process.cwd(), '.venv/bin/python3'),
            path.resolve(baseDir, '../../../../../.venv/bin/python'),
            path.resolve(baseDir, '../../../../.venv/bin/python'),
            '/opt/homebrew/bin/python3',
            '/usr/local/bin/python3',
            'python3'
        ];

        for (const p of candidatePaths) {
            if (p.includes('/') && fs.existsSync(p)) {
                return p;
            }
        }
        return 'python3';
    }

    private resolveEngineDir(): string {
        return path.resolve(this.resolveRepoRoot(), 'packages/core/src/native/3d-engine');
    }

    /**
     * The compiled scratchbox_native module is a build product (never committed): it lives in the engine's build_py dir.
     */
    private resolveModuleDirectory(): string {
        return path.join(this.resolveEngineDir(), 'build_py');
    }

    public getPythonExecutable(): string {
        return this.pythonExecutable;
    }

    public getModuleDirectory(): string {
        return this.moduleDirectory;
    }

    /**
     * Hash of everything that goes into the native module, so any engine edit (or interpreter switch) triggers a rebuild.
     */
    private computeNativeSourceFingerprint(engineDir: string): string {
        const hasher = crypto.createHash('sha256').update(this.pythonExecutable).update(process.platform).update(process.arch);
        const walk = (dir: string) => {
            if (!fs.existsSync(dir)) return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else if (/\.(hpp|h|cpp|cc|cxx|inl)$/.test(entry.name)) {
                    hasher.update(path.relative(engineDir, full)).update(fs.readFileSync(full));
                }
            }
        };
        hasher.update(fs.readFileSync(path.join(engineDir, 'CMakeLists.txt')));
        for (const sub of ['include', 'bindings', 'src']) walk(path.join(engineDir, sub));
        return hasher.digest('hex');
    }

    private hasBuiltModule(dir: string): boolean {
        return fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.startsWith('scratchbox_native') && /\.(so|pyd)$/.test(f));
    }

    /**
     * True when build_py holds a module built from exactly the current engine sources.
     */
    public isNativeModuleFresh(): boolean {
        const buildDir = path.join(this.resolveEngineDir(), 'build_py');
        const stampPath = path.join(buildDir, BUILD_STAMP);
        return this.hasBuiltModule(buildDir) && fs.existsSync(stampPath) &&
            fs.readFileSync(stampPath, 'utf8') === this.computeNativeSourceFingerprint(this.resolveEngineDir());
    }

    /**
     * Ensure the nanobind module is built from the current engine sources, rebuilding via CMake when they change.
     * Returns null when the module is ready, or the build error otherwise.
     */
    public async ensureNativeModule(): Promise<string | null> {
        const engineDir = this.resolveEngineDir();
        const buildDir = path.join(engineDir, 'build_py');
        if (this.isNativeModuleFresh()) {
            this.moduleDirectory = buildDir;
            return null;
        }

        const inFlight = nativeBuilds.get(buildDir);
        if (inFlight) return inFlight;

        const build = (async (): Promise<string | null> => {
            const lockDir = `${buildDir}.lock`;
            const deadline = Date.now() + BUILD_LOCK_STALE_MS;
            // mkdir is atomic: whoever creates the lock builds, everyone else waits and then re-checks freshness.
            for (;;) {
                try {
                    fs.mkdirSync(lockDir);
                    break;
                } catch {
                    try {
                        if (Date.now() - fs.statSync(lockDir).mtimeMs > BUILD_LOCK_STALE_MS) fs.rmSync(lockDir, { recursive: true, force: true });
                    } catch { /* lock released between checks */ }
                    if (Date.now() > deadline) return 'Timed out waiting for another scratchbox_native build to finish';
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
            try {
                if (this.isNativeModuleFresh()) {
                    this.moduleDirectory = buildDir;
                    return null;
                }
                // A cache configured from another checkout (e.g. a copied build dir) makes CMake refuse to configure.
                const cachePath = path.join(buildDir, 'CMakeCache.txt');
                if (fs.existsSync(cachePath)) {
                    const home = /CMAKE_HOME_DIRECTORY:INTERNAL=(.*)/.exec(fs.readFileSync(cachePath, 'utf8'))?.[1]?.trim();
                    if (home && fs.realpathSync(home) !== fs.realpathSync(engineDir)) fs.rmSync(buildDir, { recursive: true, force: true });
                }
                const fingerprint = this.computeNativeSourceFingerprint(engineDir);
                console.log('[NativePythonRunnerService] Engine sources changed; building scratchbox_native (a cold build takes a few minutes)...');
                // `pip install cmake` into the interpreter's environment works without a system CMake on PATH.
                const venvCmake = path.join(path.dirname(this.pythonExecutable), 'cmake');
                const cmake = path.isAbsolute(venvCmake) && fs.existsSync(venvCmake) ? venvCmake : 'cmake';
                await execFileAsync(cmake, ['-B', buildDir, '-S', engineDir, '-DCMAKE_BUILD_TYPE=Release', `-DPython_EXECUTABLE=${this.pythonExecutable}`],
                    { cwd: engineDir, timeout: 5 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
                await execFileAsync(cmake, ['--build', buildDir, '-j', String(Math.max(2, os.cpus().length))],
                    { cwd: engineDir, timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
                if (!this.hasBuiltModule(buildDir)) return `CMake build finished but produced no scratchbox_native module in ${buildDir}`;
                fs.writeFileSync(path.join(buildDir, BUILD_STAMP), fingerprint);
                this.moduleDirectory = buildDir;
                return null;
            } catch (err: any) {
                const detail = String(err?.stderr || err?.stdout || err?.message || err).slice(-4000);
                return `Failed to build scratchbox_native (needs cmake and \`${this.pythonExecutable} -m pip install nanobind\`): ${detail}`;
            } finally {
                fs.rmSync(lockDir, { recursive: true, force: true });
            }
        })().finally(() => nativeBuilds.delete(buildDir));
        nativeBuilds.set(buildDir, build);
        return build;
    }

    /**
     * Execute a standalone Python scene generation script.
     * Automatically injects PYTHONPATH to include the scratchbox native bindings.
     */
    public async runScript(
        scriptSource: string,
        options: PythonExecutionOptions = {}
    ): Promise<PythonExecutionResult> {
        const startTime = Date.now();
        const repoRoot = this.resolveRepoRoot();
        const outputDir = options.outputDir || path.resolve(repoRoot, 'build/3d-python');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Stage external assets
        if (options.assets && options.assets.length > 0) {
            for (const asset of options.assets) {
                // Asset names come from request bodies and tool args: keep them inside outputDir.
                const assetPath = resolveWithinRoot(outputDir, asset.name);
                if (typeof asset.content === 'string') {
                    if (asset.encoding === 'base64') {
                        fs.writeFileSync(assetPath, Buffer.from(asset.content, 'base64'));
                    } else {
                        fs.writeFileSync(assetPath, asset.content, 'utf8');
                    }
                } else if (asset.content instanceof Uint8Array) {
                    fs.writeFileSync(assetPath, Buffer.from(asset.content));
                }
            }
        }

        const randSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const scriptFile = path.join(outputDir, `scene_${randSuffix}.py`);
        const expectedGlbPath = options.outputGlbPath || path.join(outputDir, `scene_${randSuffix}.glb`);

        // If the script doesn't explicitly assign OUTPUT_GLB_PATH, prepend it
        let preparedScript = scriptSource;
        if (!preparedScript.match(/^\s*OUTPUT_GLB_PATH\s*=/m)) {
            preparedScript = `import os\nos.environ["OUTPUT_GLB_PATH"] = r"${expectedGlbPath}"\nOUTPUT_GLB_PATH = r"${expectedGlbPath}"\n` + preparedScript;
        }

        fs.writeFileSync(scriptFile, preparedScript, 'utf8');

        return this.runScriptFile(scriptFile, {
            ...options,
            outputGlbPath: expectedGlbPath,
            cwd: options.cwd || outputDir
        }, startTime);
    }

    /**
     * Execute a Python script from file.
     */
    public async runScriptFile(
        scriptPath: string,
        options: PythonExecutionOptions = {},
        startTime: number = Date.now()
    ): Promise<PythonExecutionResult> {
        const cwd = options.cwd || path.dirname(scriptPath);
        const timeout = options.timeoutMs || 60000;
        const repoRoot = this.resolveRepoRoot();

        const buildError = await this.ensureNativeModule();
        if (buildError) {
            return { success: false, exitCode: -1, stdout: '', stderr: buildError, executionTimeMs: Date.now() - startTime, errorDetails: buildError };
        }

        // Build PYTHONPATH
        const pythonPaths = [
            options.env?.PYTHONPATH,
            path.resolve(repoRoot, 'packages/core/src/python'),
            this.moduleDirectory,
            process.env.PYTHONPATH
        ].filter(Boolean).join(path.delimiter);

        // Scripts are model-authored: start from the scrubbed sandbox env (no API keys/credentials).
        const glbFile = expectedGlbFile(options.outputGlbPath, scriptPath);
        const env = buildPythonChildEnv(options.env, {
            PYTHONPATH: pythonPaths,
            PYTHONUNBUFFERED: '1',
            SCRATCHBOX_HUMAN_ASSETS_DIR: path.resolve(repoRoot, 'packages/core/assets/models'),
            // sb.io writes here when a script names no path, instead of a shared output.glb in the working directory.
            OUTPUT_GLB_PATH: glbFile
        });

        // Argument array, no shell: args may carry model- or user-supplied text.
        const argv = [scriptPath, ...(options.args || []).map(String)];
        const glbBefore = stampGlbFile(glbFile);

        try {
            const { stdout, stderr } = await execFileAsync(this.pythonExecutable, argv, {
                cwd,
                timeout,
                maxBuffer: 64 * 1024 * 1024,
                env
            });

            // Inspect output for generated GLB
            let glbPath: string | undefined;
            let glbBase64: string | undefined;

            const written = findWrittenGlb(glbFile, glbBefore);
            if (written) {
                glbPath = written;
                glbBase64 = fs.readFileSync(written).toString('base64');
            }

            return {
                success: true,
                exitCode: 0,
                stdout,
                stderr,
                executionTimeMs: Date.now() - startTime,
                glbPath,
                glbBase64
            };
        } catch (err: any) {
            return {
                success: false,
                exitCode: err.code || 1,
                stdout: err.stdout || '',
                stderr: err.stderr || err.message || '',
                executionTimeMs: Date.now() - startTime,
                errorDetails: err.stderr || err.message
            };
        }
    }

    /**
     * Execute a Python script string synchronously and return the generated GLB and output.
     */
    public runScriptSync(
        scriptSource: string,
        options: PythonExecutionOptions = {}
    ): PythonExecutionResult {
        const startTime = Date.now();
        const outputDir = options.outputDir || path.resolve(process.cwd(), 'build/3d-python');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const randSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const scriptFile = path.join(outputDir, `scene_${randSuffix}.py`);
        const expectedGlbPath = options.outputGlbPath || path.join(outputDir, `scene_${randSuffix}.glb`);

        let preparedScript = scriptSource;
        if (!preparedScript.match(/^\s*OUTPUT_GLB_PATH\s*=/m)) {
            preparedScript = `OUTPUT_GLB_PATH = r"${expectedGlbPath}"\n` + preparedScript;
        }

        fs.writeFileSync(scriptFile, preparedScript, 'utf8');

        return this.runScriptFileSync(scriptFile, {
            ...options,
            outputGlbPath: expectedGlbPath,
            cwd: options.cwd || outputDir
        }, startTime);
    }

    /**
     * Execute a Python script from file synchronously.
     */
    public runScriptFileSync(
        scriptPath: string,
        options: PythonExecutionOptions = {},
        startTime: number = Date.now()
    ): PythonExecutionResult {
        const cwd = options.cwd || path.dirname(scriptPath);
        const timeout = options.timeoutMs || 60000;
        const repoRoot = this.resolveRepoRoot();

        // A multi-minute build can't block a synchronous caller: start it in the background and report why this run can't proceed.
        if (!this.isNativeModuleFresh()) {
            void this.ensureNativeModule();
            const msg = 'scratchbox_native is missing or out of date with the engine sources; a rebuild has started. Retry once it finishes, or call ensureNativeModule() first.';
            return { success: false, exitCode: -1, stdout: '', stderr: msg, executionTimeMs: Date.now() - startTime, errorDetails: msg };
        }

        // Build PYTHONPATH
        const pythonPaths = [
            options.env?.PYTHONPATH,
            path.resolve(repoRoot, 'packages/core/src/python'),
            this.moduleDirectory,
            process.env.PYTHONPATH
        ].filter(Boolean).join(path.delimiter);

        const glbFile = expectedGlbFile(options.outputGlbPath, scriptPath);
        const env = buildPythonChildEnv(options.env, {
            PYTHONPATH: pythonPaths,
            PYTHONUNBUFFERED: '1',
            OUTPUT_GLB_PATH: glbFile
        });

        // Argument array, no shell: args may carry model- or user-supplied text.
        const argv = [scriptPath, ...(options.args || []).map(String)];
        const glbBefore = stampGlbFile(glbFile);

        try {
            const stdout = execFileSync(this.pythonExecutable, argv, {
                cwd,
                timeout,
                maxBuffer: 64 * 1024 * 1024,
                env,
                encoding: 'utf8'
            });

            // Inspect output for generated GLB
            let glbPath: string | undefined;
            let glbBase64: string | undefined;

            const written = findWrittenGlb(glbFile, glbBefore);
            if (written) {
                glbPath = written;
                glbBase64 = fs.readFileSync(written).toString('base64');
            }

            return {
                success: true,
                exitCode: 0,
                stdout: String(stdout || ''),
                stderr: '',
                executionTimeMs: Date.now() - startTime,
                glbPath,
                glbBase64
            };
        } catch (err: any) {
            return {
                success: false,
                exitCode: err.status || err.code || 1,
                stdout: err.stdout ? String(err.stdout) : '',
                stderr: err.stderr ? String(err.stderr) : (err.message || ''),
                executionTimeMs: Date.now() - startTime,
                errorDetails: err.stderr ? String(err.stderr) : err.message
            };
        }
    }
}
