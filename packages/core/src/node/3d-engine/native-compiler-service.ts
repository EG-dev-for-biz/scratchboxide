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
import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
    CompilationAsset,
    CppCompilationResult,
    CppCompilerDiagnostic,
    CppExecutionResult,
    Streamed3DChunk
} from '../../common/3d-engine-protocol';
import {
    compileNativeCached,
    compilerIdentity,
    hashIncludeClosure,
    NativeBuildError,
    placeCachedBinary,
    type NativeCompileResult,
    type NativeCompileSpec
} from './native-build-cache';

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
     * Path of the Scratchbox C++20 precompiled header, keyed by the compiler identity and the content of
     * scratchbox_engine.hpp and every header it includes (recursively), so any header edit yields a fresh PCH.
     */
    getPchPath(): string {
        const hasher = crypto.createHash('sha256')
            .update(process.platform)
            .update(process.arch)
            .update(this.sdkIncludePath);
        const headerPath = path.join(this.sdkIncludePath, 'scratchbox_engine.hpp');
        try {
            hasher.update(compilerIdentity(this.compilerBinary));
            hasher.update(hashIncludeClosure({ file: headerPath }, [this.sdkIncludePath]).hash);
        } catch {
            // Missing header or compiler: the PCH build fails and compiles go without it.
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
     *
     * Builds go through the shared native build cache (native-build-cache.ts): keyed on the content of the source and
     * of every header it includes, the flags and the compiler, shared across processes, never rewritten once built.
     * The binary is placed at `<outputDir>/<outputBinaryName>` (a hard link to the cache entry), so a cache hit
     * writes nothing but that link. Assets are staged in outputDir (each written to a temp name and renamed); without
     * an explicit outputDir a call with assets gets its own directory, so concurrent calls never overwrite each
     * other's assets.
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
        const randSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const binName = options.outputBinaryName || `generator_${randSuffix}`;
        const baseDir = path.resolve(process.cwd(), 'build/3d-native');
        const hasAssets = Boolean(options.assets && options.assets.length > 0);
        const outputDir = options.outputDir || (hasAssets ? path.join(baseDir, 'runs', binName) : baseDir);
        fs.mkdirSync(outputDir, { recursive: true });

        // Stage external assets (e.g., downloaded photorealistic 3D tile GLBs or geodetic anchors)
        for (const asset of options.assets ?? []) {
            // Asset names come from request bodies and tool args: keep them inside outputDir.
            const assetPath = resolveWithinRoot(outputDir, asset.name);
            let bytes: Buffer | undefined;
            if (typeof asset.content === 'string') {
                bytes = asset.encoding === 'base64' ? Buffer.from(asset.content, 'base64') : Buffer.from(asset.content, 'utf8');
            } else if (asset.content instanceof Uint8Array) {
                bytes = Buffer.from(asset.content);
            }
            if (bytes) {
                fs.mkdirSync(path.dirname(assetPath), { recursive: true });
                const tmp = `${assetPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
                fs.writeFileSync(tmp, bytes);
                fs.renameSync(tmp, assetPath);
            }
        }

        const binaryPath = path.join(outputDir, binName);
        const optFlag = options.optimization || '-O3';
        const extraFlags = options.extraFlags || [];
        // -l / -L arguments are linker inputs: they go after the source.
        const libs = extraFlags.filter(f => /^-[lL]/.test(f));
        const flags = ['-std=c++20', optFlag, ...extraFlags.filter(f => !/^-[lL]/.test(f))];
        if (process.platform === 'darwin') {
            const macSdk = '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk';
            if (fs.existsSync(macSdk)) {
                flags.push('-isysroot', macSdk);
            }
        }

        // The PCH is built at -O3; -O0 would trip clang's __OPTIMIZE__ PCH mismatch check.
        const usePch = optFlag !== '-O0' && await this.ensurePrecompiledHeader();
        const spec: NativeCompileSpec = {
            sourceCode,
            sourceDir: outputDir,
            includeDirs: [this.sdkIncludePath],
            flags,
            libs,
            pchPath: usePch ? this.getPchPath() : undefined,
            name: binName,
            compiler: this.compilerBinary,
            timeoutMs: 180000
        };

        const finish = (result: NativeCompileResult): CppCompilationResult => {
            placeCachedBinary(result.binaryPath, binaryPath);
            return {
                success: true,
                binaryPath,
                cacheHit: result.cacheHit,
                diagnostics: this.parseDiagnostics(result.compilerOutput),
                compilerOutput: result.cacheHit ? `Hit compilation cache (${result.key})` : result.compilerOutput,
                compilationTimeMs: Date.now() - startTime
            };
        };
        const failure = (err: unknown): CppCompilationResult => {
            const combined = err instanceof NativeBuildError ? (err.compilerOutput || err.message) : String((err as Error)?.message ?? err);
            return {
                success: false,
                diagnostics: this.parseDiagnostics(combined),
                compilerOutput: combined.trim(),
                compilationTimeMs: Date.now() - startTime
            };
        };

        try {
            return finish(await compileNativeCached(spec));
        } catch (err) {
            // A PCH from another target/architecture is rejected by clang: compile the same source without it.
            const output = err instanceof NativeBuildError ? err.compilerOutput : '';
            if (usePch && /precompiled|PCH/i.test(output)) {
                try {
                    return finish(await compileNativeCached({ ...spec, pchPath: undefined }));
                } catch (retryErr) {
                    return failure(retryErr);
                }
            }
            return failure(err);
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
