/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import type {
    CompilationAsset,
    CppCompilationResult,
    CppCompilerDiagnostic,
    CppExecutionResult,
    Streamed3DChunk
} from '../../common/3d-engine-protocol';

const execAsync = promisify(exec);

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
                path.resolve(process.cwd(), 'packages/core/src/native/3d-engine/include')
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
        const binName = options.outputBinaryName || `generator_${randSuffix}`;
        const sourcePath = path.join(outputDir, `${binName}.cpp`);
        const binaryPath = path.join(outputDir, binName);

        fs.writeFileSync(sourcePath, sourceCode, 'utf8');

        const optFlag = options.optimization || '-O3';
        const extra = (options.extraFlags || []).join(' ');

        // Cursor-grade compilation cache: SHA-256 binary replay with SDK header mtime validation
        const cacheDir = path.join(outputDir, '.cache');
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        const hasher = crypto.createHash('sha256')
            .update(sourceCode)
            .update(optFlag)
            .update(extra)
            .update(this.sdkIncludePath);

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

        const compileCmd = `${this.compilerBinary} -std=c++20 ${optFlag} -I"${this.sdkIncludePath}" ${extra} -o "${binaryPath}" "${sourcePath}"`;

        try {
            const { stdout, stderr } = await execAsync(compileCmd, {
                cwd: outputDir,
                timeout: 180000,
                maxBuffer: 16 * 1024 * 1024
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
     */
    async executeBinary(
        binaryPath: string,
        args: string[] = [],
        executionDir?: string
    ): Promise<CppExecutionResult> {
        const startTime = Date.now();
        const safeArgs = args.map(arg => {
            if (/^[a-zA-Z0-9_\-./=]+$/.test(arg)) return arg;
            return `"${arg.replace(/(["\\$`])/g, '\\$1')}"`;
        }).join(' ');
        const cmd = `"${binaryPath}" ${safeArgs}`;
        const cwd = executionDir || path.dirname(binaryPath);

        try {
            const { stdout, stderr } = await execAsync(cmd, {
                cwd,
                timeout: 45000,
                maxBuffer: 50 * 1024 * 1024 // 50MB buffer for heavy mesh streams
            });

            const chunks = this.extractStreamedChunks(stdout);
            
            // Check if binary wrote a default .glb file in the cwd
            let glbPath: string | undefined;
            let glbBase64: string | undefined;

            const possibleGlb = path.join(cwd, `${path.basename(binaryPath, path.extname(binaryPath))}.glb`);
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
