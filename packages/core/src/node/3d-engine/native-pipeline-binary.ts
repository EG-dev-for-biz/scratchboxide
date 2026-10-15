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

/** What the native GLB reader would get wrong about a GLB, by consequence. */
export interface RawMeshReadIssues {
    /** Placement the reader ignores (node transforms, instanced meshes): measured bounds and output would be wrong. */
    geometry: string[];
    /** Content the native writer cannot carry over (textures): the output would silently lose it. */
    content: string[];
}

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * The native pipelines read a GLB with GlbReader, which merges every mesh's raw vertex positions (ignoring node
 * transforms and instancing) and write it with GlbWriter, which carries no textures. This lists what that would get
 * wrong for `glb`, so callers can refuse the input instead of returning a moved, rescaled or untextured mesh as done.
 */
export function rawMeshReadIssues(glb: Buffer): RawMeshReadIssues {
    if (glb.length < 20 || glb.toString('utf8', 0, 4) !== 'glTF') {
        return { geometry: ['it is not a binary glTF (.glb) file'], content: [] };
    }
    const json = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
    const nodes: any[] = Array.isArray(json.nodes) ? json.nodes : [];
    const geometry: string[] = [];
    const hasMesh = (index: number, seen = new Set<number>()): boolean => {
        if (seen.has(index) || !nodes[index]) return false;
        seen.add(index);
        return nodes[index].mesh !== undefined || (nodes[index].children || []).some((c: number) => hasMesh(c, seen));
    };
    const near = (a: unknown, b: number[]) => Array.isArray(a) && a.length === b.length && a.every((v, i) => Math.abs(Number(v) - b[i]) < 1e-9);
    nodes.forEach((node, index) => {
        const moved = (node.matrix !== undefined && !near(node.matrix, IDENTITY_MATRIX))
            || (node.translation !== undefined && !near(node.translation, [0, 0, 0]))
            || (node.rotation !== undefined && !near(node.rotation, [0, 0, 0, 1]))
            || (node.scale !== undefined && !near(node.scale, [1, 1, 1]));
        if (moved && hasMesh(index)) {
            const parts = ['matrix', 'translation', 'rotation', 'scale'].filter(k => node[k] !== undefined).map(k => `${k} ${JSON.stringify(node[k])}`);
            geometry.push(`node ${node.name ? `"${node.name}"` : index} places its mesh with ${parts.join(', ')}`);
        }
    });
    const uses = new Map<number, number>();
    for (const node of nodes) if (node.mesh !== undefined) uses.set(node.mesh, (uses.get(node.mesh) || 0) + 1);
    for (const [mesh, count] of uses) if (count > 1) geometry.push(`mesh ${mesh} is instanced by ${count} nodes`);
    const textures = Array.isArray(json.textures) ? json.textures.length : 0;
    const content = textures > 0 ? [`it has ${textures} texture(s), which the native writer does not carry over`] : [];
    return { geometry, content };
}
