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
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GeneratorFailedError } from '../../common/errors/pipeline-errors';

const execFileAsync = promisify(execFile);

/** The newest modification time among the source file and the engine headers it can include. */
function newestSourceMtime(sourcePath: string, includeDir: string): number {
    let newest = fs.statSync(sourcePath).mtimeMs;
    if (fs.existsSync(includeDir)) {
        for (const name of fs.readdirSync(includeDir)) {
            if (/\.(h|hpp)$/.test(name)) {
                newest = Math.max(newest, fs.statSync(path.join(includeDir, name)).mtimeMs);
            }
        }
    }
    return newest;
}

/**
 * Returns a native pipeline binary built from the current source: it is (re)compiled when it is missing or older
 * than its source or any engine header, so a stale binary never runs an old contract (for example one that still
 * builds a stand-in mesh when --input is missing). `-march=native` only with SCRATCHBOX_NATIVE_ARCH=1. A compile
 * failure is a GeneratorFailedError carrying the compiler output.
 */
export async function ensurePipelineBinary(options: { binaryPath: string; sourcePath: string; includeDir: string }): Promise<string> {
    const { binaryPath, sourcePath, includeDir } = options;
    if (!fs.existsSync(sourcePath)) {
        if (fs.existsSync(binaryPath)) return binaryPath;
        throw new GeneratorFailedError('cpp', `neither the pipeline binary ${binaryPath} nor its source ${sourcePath} exists`);
    }
    if (fs.existsSync(binaryPath) && fs.statSync(binaryPath).mtimeMs >= newestSourceMtime(sourcePath, includeDir)) {
        return binaryPath;
    }
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    // Compile to a private name and rename into place, so concurrent callers never run a half-written binary.
    const tmp = `${binaryPath}.build-${process.pid}-${Date.now()}`;
    const args = ['-std=c++20', '-O3', ...(process.env.SCRATCHBOX_NATIVE_ARCH === '1' ? ['-march=native'] : []), '-I', includeDir, sourcePath, '-o', tmp];
    try {
        await execFileAsync(process.env.CXX || 'clang++', args, { maxBuffer: 1024 * 1024 * 16 });
    } catch (err: any) {
        fs.rmSync(tmp, { force: true });
        throw new GeneratorFailedError('cpp', `compiling ${path.basename(sourcePath)} failed: ${err?.stderr || err?.message || err}`);
    }
    fs.renameSync(tmp, binaryPath);
    return binaryPath;
}

/** Runs a pipeline binary without a shell. Exit code 2 is the binary's "invalid input" code. */
export async function runPipelineBinary(binary: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileAsync(binary, args, { maxBuffer: 1024 * 1024 * 64 });
    return { stdout: String(stdout), stderr: String(stderr) };
}

/** Reads `key=value` pairs from the binary's `[TELEMETRY]` line; throws when the line is missing. */
export function parseTelemetryLine(stdout: string, what: string): Map<string, string> {
    const line = stdout.match(/\[TELEMETRY\]\s+(.+)/);
    if (!line) {
        throw new GeneratorFailedError('cpp', `${what} reported no telemetry. ${stdout.trim().slice(-1500)}`);
    }
    const values = new Map<string, string>();
    for (const m of line[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)=(\S+)/g)) {
        values.set(m[1], m[2]);
    }
    return values;
}
