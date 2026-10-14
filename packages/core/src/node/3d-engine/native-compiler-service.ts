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
import { resolveWithinRoot } from '../security/path-guard';
import { buildScrubbedEnv } from '../security/sandbox-policy';
import * as crypto from 'crypto';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import type {
    CompilationAsset,
    CppCompilationResult,
    CppCompilerDiagnostic,
    CppExecutionResult,
    Streamed3DChunk
} from '../../common/3d-engine-protocol';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const pchBuilds = new Map<string, Promise<boolean>>();

/**
 * Environment for executing generated binaries: the sandbox allowlist (PATH, HOME, TMPDIR, ...)
 * plus non-secret SCRATCHBOX_* engine settings such as SCRATCHBOX_HUMAN_ASSETS_DIR.
 */
export function buildGeneratedBinaryEnv(hostEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const engineVars: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(hostEnv)) {
        if (name.startsWith('SCRATCHBOX_')) engineVars[name] = value;
    }
    return buildScrubbedEnv(hostEnv, engineVars);
}

export class NativeCppCompilerService {
    private static instance?: NativeCppCompilerService;
    private sdkIncludePath: string;
    private compilerBinary: string = process.env.CXX || 'clang++';

    public static getInstance(customIncludePath?: string): NativeCppCompilerService {
        if (!NativeCppCompilerService.instance || customIncludePath) {
            NativeCppCompilerService.instance = new NativeCppCompilerService(customIncludePath);
        }
        return NativeCppCompilerService.instance;
    }

    constructor(customIncludePath?: string) {
        if (customIncludePath) {
            this.sdkIncludePath = customIncludePath;
        } else {
            // Locate packages/core/src/native/3d-engine/include relative to runtime, package root, or project
            let fromPackageJson: string | undefined;
            try {
                const corePkg = require.resolve('@scratchbox/core/package.json');
                fromPackageJson = path.resolve(path.dirname(corePkg), 'src/native/3d-engine/include');
            } catch {
                // fall back
            }

            const candidatePaths = [
                fromPackageJson,
                path.resolve(__dirname, '../../native/3d-engine/include'),
                path.resolve(__dirname, '../native/3d-engine/include'),
                path.resolve(__dirname, '../../../src/native/3d-engine/include'),
                path.resolve(__dirname, '../../core/src/native/3d-engine/include'),
                path.resolve(__dirname, '../../../packages/core/src/native/3d-engine/include'),
                path.resolve(process.cwd(), 'packages/core/src/native/3d-engine/include'),
                path.resolve(process.cwd(), '../packages/core/src/native/3d-engine/include')
            ].filter((p): p is string => Boolean(p));

            this.sdkIncludePath = candidatePaths.find(p => fs.existsSync(p)) || candidatePaths[0];
        }
    }

    /**
     * Get the detected SDK include directory.
     */
    getSdkIncludePath(): string {
        return this.sdkIncludePath;
    }

    /**
     * Set the compiler binary (default: 'clang++').
     */
    setCompilerBinary(binary: string): void {
        this.compilerBinary = binary;
    }

    /**
     * Path of the Scratchbox C++20 precompiled header, keyed by compiler and every SDK header's mtime/size
     * so any header edit yields a fresh PCH instead of a stale one.
     */
    getPchPath(): string {
        const hasher = crypto.createHash('sha256')
            .update(this.compilerBinary)
            .update(process.platform)
            .update(process.arch)
            .update(this.sdkIncludePath);
        try {
            for (const hFile of fs.readdirSync(this.sdkIncludePath).sort()) {
                if (hFile.endsWith('.hpp') || hFile.endsWith('.h')) {
                    const stat = fs.statSync(path.join(this.sdkIncludePath, hFile));
                    hasher.update(`${hFile}:${stat.mtimeMs}:${stat.size}`);
                }
            }
        } catch {
            // Missing include dir: the PCH simply never validates.
        }
        return path.join(os.tmpdir(), 'scratchbox-native-pch', `scratchbox_engine_${hasher.digest('hex').slice(0, 24)}.pch`);
    }

    /**
     * Build the scratchbox_engine.hpp precompiled header if it does not exist yet.
     * Cold -O3 compiles re-parse ~60k header lines per generator; the PCH cuts that roughly 3x.
     */
    async ensurePrecompiledHeader(forceRebuild = false): Promise<boolean> {
        const pchPath = this.getPchPath();
        const headerPath = path.join(this.sdkIncludePath, 'scratchbox_engine.hpp');
        if (!fs.existsSync(headerPath)) {
            return false;
        }
        if (!forceRebuild && fs.existsSync(pchPath)) {
            return true;
        }
        const inFlight = pchBuilds.get(pchPath);
        if (inFlight && !forceRebuild) {
            return inFlight;
        }

        const build = (async () => {
            fs.mkdirSync(path.dirname(pchPath), { recursive: true });
            // Write to a unique temp file and rename so concurrent processes never observe a partial PCH.
            const tmpPath = `${pchPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
            const pchArgs = ['-std=c++20', '-O3', '-x', 'c++-header', headerPath, '-o', tmpPath];
            if (process.platform === 'darwin') {
                const macSdk = '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk';
                if (fs.existsSync(macSdk)) {
                    pchArgs.push('-isysroot', macSdk);
                }
            }
            try {
                await execFileAsync(this.compilerBinary, pchArgs, { cwd: this.sdkIncludePath, timeout: 180000 });
                fs.renameSync(tmpPath, pchPath);
                return true;
            } catch {
                fs.rmSync(tmpPath, { force: true });
                return false;
            } finally {
                pchBuilds.delete(pchPath);
            }
        })();
        pchBuilds.set(pchPath, build);
        return build;
    }

    /**
     * Parse Clang / GCC compiler stderr into structured AST diagnostic entries.
     */
    parseDiagnostics(stderrText: string): CppCompilerDiagnostic[] {
        const diagnostics: CppCompilerDiagnostic[] = [];
        // Format: /path/to/file.cpp:14:5: error: use of undeclared identifier 'foo'
        const regex = /^(.*?):(\d+):(\d+):\s+(fatal error|error|warning|note):\s+(.*)$/gm;
        let match: RegExpExecArray | null;

        while ((match = regex.exec(stderrText)) !== null) {
            diagnostics.push({
                file: path.basename(match[1]),
                line: parseInt(match[2], 10),
                column: parseInt(match[3], 10),
                severity: match[4] as any,
                message: match[5].trim()
            });
        }

        return diagnostics;
    }

    /**
     * Compile a standalone C++20 source string against the Scratchbox native 3D engine SDK headers.
     */
    async compileSource(
        sourceCode: string,
        options: {
            outputDir?: string;
            outputBinaryName?: string;
            optimization?: '-O0' | '-O1' | '-O2' | '-O3';
            extraFlags?: string[];
            assets?: CompilationAsset[];
        } = {}
    ): Promise<CppCompilationResult> {
        const startTime = Date.now();
        const outputDir = options.outputDir || path.resolve(process.cwd(), 'build/3d-native');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Stage external assets (e.g., downloaded photorealistic 3D tile GLBs or geodetic anchors)
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
        const binName = options.outputBinaryName || `generator_${randSuffix}`;
        const sourcePath = path.join(outputDir, `${binName}.cpp`);
        const binaryPath = path.join(outputDir, binName);

        fs.writeFileSync(sourcePath, sourceCode, 'utf8');

        const optFlag = options.optimization || '-O3';
        const extraFlags = options.extraFlags || [];

        // The PCH is built at -O3; -O0 would trip clang's __OPTIMIZE__ PCH mismatch check.
        const pchPath = this.getPchPath();
        const usePch = optFlag !== '-O0' && await this.ensurePrecompiledHeader();

        // High-performance compilation cache: SHA-256 binary replay with SDK header mtime validation
        const cacheDir = path.join(outputDir, '.cache');
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        const hasher = crypto.createHash('sha256')
            .update(sourceCode)
            .update(optFlag)
            .update(extraFlags.join(' '))
            .update(this.sdkIncludePath)
            .update(usePch ? `pch:${pchPath}` : 'no-pch');

        try {
            if (fs.existsSync(this.sdkIncludePath)) {
                const headerFiles = fs.readdirSync(this.sdkIncludePath);
                for (const hFile of headerFiles) {
                    if (hFile.endsWith('.hpp') || hFile.endsWith('.h')) {
                        const stat = fs.statSync(path.join(this.sdkIncludePath, hFile));
                        hasher.update(`${hFile}:${stat.mtimeMs}:${stat.size}`);
                    }
                }
            }
        } catch {
            // Non-fatal if header stat fails
        }

        const sourceHash = hasher.digest('hex');
        const cachedBinaryPath = path.join(cacheDir, `bin_${sourceHash}`);

        if (fs.existsSync(cachedBinaryPath)) {
            return {
                success: true,
                binaryPath: cachedBinaryPath,
                diagnostics: [],
                compilerOutput: 'Hit compilation cache (0ms)',
                compilationTimeMs: Date.now() - startTime
            };
        }

        // Construct argument vector for execFile (zero shell expansion)
        const compileArgs = [
            '-std=c++20',
            optFlag,
            `-I${this.sdkIncludePath}`
        ];

        if (process.platform === 'darwin') {
            const macSdk = '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk';
            if (fs.existsSync(macSdk)) {
                compileArgs.push('-isysroot', macSdk);
            }
        }

        if (usePch) {
            compileArgs.push('-include-pch', pchPath);
        }

        if (extraFlags.length > 0) {
            compileArgs.push(...extraFlags);
        }

        compileArgs.push('-o', binaryPath, sourcePath);

        try {
            const { stdout, stderr } = await execFileAsync(this.compilerBinary, compileArgs, {
                cwd: outputDir,
                timeout: 180000,
                maxBuffer: 32 * 1024 * 1024
            });

            // Populate compilation cache for instant replay
            try {
                fs.copyFileSync(binaryPath, cachedBinaryPath);
            } catch {
                // Non-fatal cache write error
            }

            const diagnostics = this.parseDiagnostics(stderr);
            return {
                success: true,
                binaryPath,
                diagnostics,
                compilerOutput: stderr || stdout,
                compilationTimeMs: Date.now() - startTime
            };
        } catch (err: any) {
            const initialStderr = err.stderr || '';

            // Automatic fallback if PCH had mismatched target/architecture
            if (usePch && /precompiled|PCH/i.test(initialStderr)) {
                try {
                    const fallbackArgs = compileArgs.filter((arg, idx) => arg !== '-include-pch' && compileArgs[idx - 1] !== '-include-pch');
                    const { stdout, stderr } = await execFileAsync(this.compilerBinary, fallbackArgs, {
                        cwd: outputDir,
                        timeout: 180000,
                        maxBuffer: 32 * 1024 * 1024
                    });

                    try {
                        fs.copyFileSync(binaryPath, cachedBinaryPath);
                    } catch {
                        // Non-fatal
                    }

                    return {
                        success: true,
                        binaryPath,
                        diagnostics: this.parseDiagnostics(stderr),
                        compilerOutput: stderr || stdout,
                        compilationTimeMs: Date.now() - startTime
                    };
                } catch (fallbackErr: any) {
                    const combined = (fallbackErr.stderr || '') + '\n' + (fallbackErr.stdout || '') + '\n' + (fallbackErr.message || '');
                    return {
                        success: false,
                        diagnostics: this.parseDiagnostics(combined),
                        compilerOutput: combined.trim(),
                        compilationTimeMs: Date.now() - startTime
                    };
                }
            }

            const combinedOutput = (err.stderr || '') + '\n' + (err.stdout || '') + '\n' + (err.message || '');
            const diagnostics = this.parseDiagnostics(combinedOutput);

            return {
                success: false,
                diagnostics,
                compilerOutput: combinedOutput.trim(),
                compilationTimeMs: Date.now() - startTime
            };
        }
    }

    /**
     * Execute a compiled 3D generator binary and collect generated glTF / streamed chunks.
     * Uses execFile (zero shell injection) and disk-level fallback recovery for massive scenes.
     */
    async executeBinary(
        binaryPath: string,
        args: string[] = [],
        executionDir?: string
    ): Promise<CppExecutionResult> {
        const startTime = Date.now();
        const cwd = executionDir || path.dirname(binaryPath);
        const binaryArgs = [...args];
        const possibleGlb = path.join(cwd, `${path.basename(binaryPath, path.extname(binaryPath))}.glb`);

        try {
            const { stdout, stderr } = await execFileAsync(binaryPath, binaryArgs, {
                cwd,
                // Generated binaries run model-authored code: never hand them host secrets
                // (GEMINI_API_KEY, GOOGLE_MAPS_API_KEY, GOOGLE_APPLICATION_CREDENTIALS, ...).
                env: buildGeneratedBinaryEnv(),
                timeout: 60000,
                maxBuffer: 100 * 1024 * 1024 // 100MB buffer for heavy mesh streams
            });

            const chunks = this.extractStreamedChunks(stdout);
            
            // Check if binary wrote a default .glb file in the cwd
            let glbPath: string | undefined;
            let glbBase64: string | undefined;

            if (fs.existsSync(possibleGlb)) {
                glbPath = possibleGlb;
                glbBase64 = fs.readFileSync(possibleGlb).toString('base64');
            } else if (chunks.length > 0 && chunks[0].glbBase64) {
                glbBase64 = chunks[0].glbBase64;
            }

            return {
                success: true,
                exitCode: 0,
                stdout,
                stderr,
                executionTimeMs: Date.now() - startTime,
                glbPath,
                glbBase64,
                chunks
            };
        } catch (err: any) {
            // Robust Recovery: If stdout buffer exceeded OR error occurred but binary wrote valid .glb before exiting, recover it!
            if (fs.existsSync(possibleGlb)) {
                try {
                    const glbStat = fs.statSync(possibleGlb);
                    if (glbStat.size > 0) {
                        return {
                            success: true,
                            exitCode: 0,
                            stdout: err.stdout || '',
                            stderr: err.stderr || '',
                            executionTimeMs: Date.now() - startTime,
                            glbPath: possibleGlb,
                            glbBase64: fs.readFileSync(possibleGlb).toString('base64'),
                            chunks: this.extractStreamedChunks(err.stdout || '')
                        };
                    }
                } catch {
                    // Fall through to standard error return
                }
            }

            return {
                success: false,
                exitCode: err.code || 1,
                stdout: err.stdout || '',
                stderr: err.stderr || err.message,
                executionTimeMs: Date.now() - startTime,
                chunks: []
            };
        }
    }

    /**
     * Extract streamed chunks delimited by ===SCRATCHBOX_3D_CHUNK_START=== ... ===SCRATCHBOX_3D_CHUNK_END===
     */
    private extractStreamedChunks(stdoutText: string): Streamed3DChunk[] {
        const chunks: Streamed3DChunk[] = [];
        const pattern = /===SCRATCHBOX_3D_CHUNK_START===([\s\S]*?)===SCRATCHBOX_3D_CHUNK_END===/g;

        let match: RegExpExecArray | null;
        while ((match = pattern.exec(stdoutText)) !== null) {
            try {
                const chunkJson = JSON.parse(match[1].trim());
                chunks.push(chunkJson);
            } catch {
                // Ignore malformed chunk json
            }
        }

        return chunks;
    }
}
