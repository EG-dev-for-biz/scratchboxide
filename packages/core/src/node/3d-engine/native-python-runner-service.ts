/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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

    /**
     * Resolve the directory containing compiled scratchbox_native extension and scratchbox package.
     */
    private resolveModuleDirectory(): string {
        const repoRoot = this.resolveRepoRoot();
        const baseDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
        const candidateDirs = [
            path.resolve(repoRoot, 'packages/core/src/native/3d-engine/build_py'),
            path.resolve(repoRoot, 'packages/core/src/python/scratchbox'),
            path.resolve(repoRoot, 'packages/core/src/native/3d-engine/scratchbox'),
            path.resolve(process.cwd(), 'packages/core/src/native/3d-engine/build_py'),
            path.resolve(process.cwd(), 'packages/core/src/native/3d-engine/scratchbox'),
            path.resolve(baseDir, '../../native/3d-engine/build_py'),
            path.resolve(baseDir, '../../native/3d-engine/scratchbox'),
            path.resolve(baseDir, '../../../src/native/3d-engine/build_py'),
            path.resolve(baseDir, '../../../src/native/3d-engine/scratchbox')
        ];

        for (const dir of candidateDirs) {
            if (fs.existsSync(dir)) {
                const files = fs.readdirSync(dir);
                if (files.some(f => f.startsWith('scratchbox_native') && (f.endsWith('.so') || f.endsWith('.pyd') || f.endsWith('.dylib')))) {
                    return dir;
                }
            }
        }

        return candidateDirs[0];
    }

    public getPythonExecutable(): string {
        return this.pythonExecutable;
    }

    public getModuleDirectory(): string {
        return this.moduleDirectory;
    }

    /**
     * Ensure the nanobind module is compiled. If missing, compiles it automatically via CMake.
     */
    public async ensureNativeModule(): Promise<boolean> {
        if (fs.existsSync(this.moduleDirectory)) {
            const files = fs.readdirSync(this.moduleDirectory);
            if (files.some(f => f.startsWith('scratchbox_native') && (f.endsWith('.so') || f.endsWith('.pyd') || f.endsWith('.dylib')))) {
                return true;
            }
        }

        const repoRoot = this.resolveRepoRoot();
        const engineDir = path.resolve(repoRoot, 'packages/core/src/native/3d-engine');
        const buildDir = path.join(engineDir, 'build_py');

        try {
            await execAsync(
                `cmake -B "${buildDir}" -S "${engineDir}" -DPython_EXECUTABLE="${this.pythonExecutable}" && cmake --build "${buildDir}" -j8`,
                { cwd: engineDir, timeout: 120000 }
            );
            this.moduleDirectory = buildDir;
            return true;
        } catch (err: any) {
            console.error('[NativePythonRunnerService] Failed to auto-compile nanobind module:', err);
            return false;
        }
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
                const assetPath = path.join(outputDir, asset.name);
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

        // Build PYTHONPATH
        const pythonPaths = [
            options.env?.PYTHONPATH,
            path.resolve(repoRoot, 'packages/core/src/python'),
            this.moduleDirectory,
            path.dirname(this.moduleDirectory),
            path.resolve(repoRoot, 'packages/core/src/native/3d-engine/build_py'),
            path.resolve(repoRoot, 'packages/core/src/native/3d-engine/scratchbox'),
            path.resolve(repoRoot, 'packages/core/src/native/3d-engine'),
            process.env.PYTHONPATH
        ].filter(Boolean).join(path.delimiter);

        const env = {
            ...process.env,
            ...options.env,
            PYTHONPATH: pythonPaths,
            PYTHONUNBUFFERED: '1'
        };

        const argsStr = (options.args || []).map(a => `"${a}"`).join(' ');
        const cmd = `"${this.pythonExecutable}" "${scriptPath}" ${argsStr}`.trim();

        try {
            const { stdout, stderr } = await execAsync(cmd, {
                cwd,
                timeout,
                maxBuffer: 64 * 1024 * 1024,
                env
            });

            // Inspect output for generated GLB
            let glbPath: string | undefined;
            let glbBase64: string | undefined;

            if (options.outputGlbPath && fs.existsSync(options.outputGlbPath)) {
                glbPath = options.outputGlbPath;
                glbBase64 = fs.readFileSync(glbPath).toString('base64');
            } else {
                // Check if a .glb with the script name was written
                const scriptBaseGlb = path.join(cwd, `${path.basename(scriptPath, '.py')}.glb`);
                const genericGlb = path.join(cwd, 'output.glb');

                if (fs.existsSync(scriptBaseGlb)) {
                    glbPath = scriptBaseGlb;
                    glbBase64 = fs.readFileSync(glbPath).toString('base64');
                } else if (fs.existsSync(genericGlb)) {
                    glbPath = genericGlb;
                    glbBase64 = fs.readFileSync(genericGlb).toString('base64');
                }
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

        // Build PYTHONPATH
        const pythonPaths = [
            options.env?.PYTHONPATH,
            path.resolve(repoRoot, 'packages/core/src/python'),
            this.moduleDirectory,
            path.dirname(this.moduleDirectory),
            path.resolve(repoRoot, 'packages/core/src/native/3d-engine/build_py'),
            path.resolve(repoRoot, 'packages/core/src/native/3d-engine/scratchbox'),
            path.resolve(repoRoot, 'packages/core/src/native/3d-engine'),
            process.env.PYTHONPATH
        ].filter(Boolean).join(path.delimiter);

        const env = {
            ...process.env,
            ...options.env,
            PYTHONPATH: pythonPaths,
            PYTHONUNBUFFERED: '1'
        };

        const argsStr = (options.args || []).map(a => `"${a}"`).join(' ');
        const cmd = `"${this.pythonExecutable}" "${scriptPath}" ${argsStr}`.trim();

        try {
            const stdout = execSync(cmd, {
                cwd,
                timeout,
                maxBuffer: 64 * 1024 * 1024,
                env,
                encoding: 'utf8'
            });

            // Inspect output for generated GLB
            let glbPath: string | undefined;
            let glbBase64: string | undefined;

            if (options.outputGlbPath && fs.existsSync(options.outputGlbPath)) {
                glbPath = options.outputGlbPath;
                glbBase64 = fs.readFileSync(glbPath).toString('base64');
            } else {
                const scriptBaseGlb = path.join(cwd, `${path.basename(scriptPath, '.py')}.glb`);
                const genericGlb = path.join(cwd, 'output.glb');

                if (fs.existsSync(scriptBaseGlb)) {
                    glbPath = scriptBaseGlb;
                    glbBase64 = fs.readFileSync(glbPath).toString('base64');
                } else if (fs.existsSync(genericGlb)) {
                    glbPath = genericGlb;
                    glbBase64 = fs.readFileSync(genericGlb).toString('base64');
                }
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
