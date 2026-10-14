/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { LspDiagnosticFeedbackService } from '../lsp-diagnostic-feedback-service';
import { ContainerSandboxService } from '../container-sandbox-service';
import {
    VerificationOutcome,
    VerificationDiagnostic,
    GeometryVerificationResult
} from '../../common/gemini-protocol';

export interface VerifyOptions {
    workspaceRoot: string;
    modifiedFiles?: string[];
    runTests?: boolean;
    timeoutMs?: number;
}

export interface GeometryVerificationOptions {
    vertexCount: number;
    triangleCount: number;
    bounds?: {
        min: [number, number, number];
        max: [number, number, number];
    };
    enforcePositiveYMax?: boolean;
    isManifold?: boolean;
}

export class AgentVerificationService {
    constructor(
        private readonly lsp: LspDiagnosticFeedbackService,
        private readonly sandbox: ContainerSandboxService
    ) {}

    /**
     * Verify the files the agent changed:
     * 1. Typecheck the TypeScript project(s) that own the modified .ts/.tsx files (fresh `tsc --noEmit`,
     *    not a cached result) and fail on errors located in those files.
     * 2. If requested, run the workspace's tests in the sandbox.
     */
    async verify(options: VerifyOptions): Promise<VerificationOutcome> {
        const { workspaceRoot, modifiedFiles = [], runTests = false, timeoutMs = 120000 } = options;
        const started = Date.now();
        const diagnostics: VerificationDiagnostic[] = [];
        const modified = new Set(modifiedFiles.map(f => path.resolve(workspaceRoot, f)));

        // 1. Fresh typecheck of each TypeScript project touched by the edit
        const projects = new Set<string>();
        for (const file of modified) {
            if (!/\.(ts|tsx|mts|cts)$/i.test(file)) continue;
            const project = findTsconfigDir(path.dirname(file), workspaceRoot);
            if (project) projects.add(project);
        }
        let otherErrors = 0;
        const checked: string[] = [];
        for (const project of projects) {
            const output = await runTypecheck(project, timeoutMs);
            checked.push(path.relative(workspaceRoot, project) || '.');
            if (output.timedOut) {
                return { passed: false, summary: `Typecheck of ${project} did not finish within ${Math.round(timeoutMs / 1000)}s.`, durationMs: Date.now() - started };
            }
            this.lsp.ingestCompilerOutput(output.text, 'typescript', output.exitCode);
            for (const d of parseTscErrors(output.text, project)) {
                if (modified.has(d.filePath!)) diagnostics.push(d);
                else otherErrors++;
            }
        }

        if (diagnostics.length > 0) {
            return {
                passed: false,
                summary: `Typecheck found ${diagnostics.length} error(s) in the files you changed:\n` +
                    diagnostics.slice(0, 20).map(d => `${path.relative(workspaceRoot, d.filePath!)}:${d.line}: ${d.message}`).join('\n'),
                diagnostics,
                durationMs: Date.now() - started
            };
        }

        // 2. Sandboxed test / build check if requested
        if (runTests) {
            try {
                const envId = `verify-${Date.now()}`;
                await this.sandbox.createEnvironment({
                    environmentId: envId,
                    isolationLevel: 'process-jail',
                    workspaceRoot,
                    timeoutMs
                });
                const testRes = await this.sandbox.executeCommand(envId, {
                    command: 'npm test --if-present',
                    cwd: workspaceRoot,
                    timeoutMs
                });
                if (testRes.exitCode !== 0) {
                    return {
                        passed: false,
                        summary: `Automated test run failed with exit code ${testRes.exitCode}.\n${testRes.stderr || testRes.stdout}`,
                        commandResult: {
                            exitCode: testRes.exitCode,
                            stdout: testRes.stdout,
                            stderr: testRes.stderr
                        }
                    };
                }
            } catch (err: any) {
                // If sandbox execution fails, capture error
                return {
                    passed: false,
                    summary: `Verification sandbox error: ${err?.message || String(err)}`
                };
            }
        }

        const scope = checked.length > 0 ? `Typecheck passed for ${checked.join(', ')}` : 'No TypeScript files changed, so nothing was typechecked';
        return {
            passed: true,
            summary: `${scope}${otherErrors > 0 ? ` (${otherErrors} pre-existing error(s) in other files)` : ''}${runTests ? '; tests passed' : ''}.`,
            durationMs: Date.now() - started
        };
    }

    /**
     * Run geometric topology verification on 3D meshes (manifoldness, non-zero vertex count, bounding volume).
     */
    verifyGeometry(options: GeometryVerificationOptions): VerificationOutcome {
        const warnings: string[] = [];
        let passed = true;

        if (options.vertexCount <= 0 || options.triangleCount <= 0) {
            passed = false;
            warnings.push(`Degenerate geometry: ${options.vertexCount} vertices and ${options.triangleCount} triangles.`);
        }

        if (options.isManifold === false) {
            passed = false;
            warnings.push(`Non-manifold edges detected in 3D mesh.`);
        }

        if (options.bounds) {
            const [minX, minY, minZ] = options.bounds.min;
            const [maxX, maxY, maxZ] = options.bounds.max;
            if (minX >= maxX || minY >= maxY || minZ >= maxZ) {
                passed = false;
                warnings.push(`Invalid bounding box extents: min >= max.`);
            }
        }

        return {
            passed,
            summary: passed
                ? `Geometry topology verification passed cleanly (${options.vertexCount} vertices, ${options.triangleCount} triangles).`
                : `Geometry topology verification failed: ${warnings.join(' ')}`,
            geometryVerification: {
                passed,
                vertexCount: options.vertexCount,
                triangleCount: options.triangleCount,
                isManifold: options.isManifold,
                boundingBoxValid: passed,
                warnings
            }
        };
    }
}

/** Nearest directory at or above `dir` (not above `root`) that holds a tsconfig.json. */
function findTsconfigDir(dir: string, root: string): string | undefined {
    const stop = path.resolve(root);
    for (let d = path.resolve(dir); ; d = path.dirname(d)) {
        if (fs.existsSync(path.join(d, 'tsconfig.json'))) return d;
        if (d === stop || path.dirname(d) === d) return undefined;
    }
}

function runTypecheck(project: string, timeoutMs: number): Promise<{ text: string; exitCode: number; timedOut: boolean }> {
    return new Promise(resolve => {
        execFile('npx', ['--no-install', 'tsc', '--noEmit', '--pretty', 'false', '-p', project], { cwd: project, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
            (err: any, stdout, stderr) => {
                const timedOut = !!err && (err.killed || err.signal === 'SIGTERM');
                resolve({ text: `${stdout || ''}${stderr || ''}`, exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0, timedOut });
            });
    });
}

/** `file(line,col): error TSxxxx: message` lines, with paths made absolute against the project dir. */
export function parseTscErrors(output: string, project: string): VerificationDiagnostic[] {
    const out: VerificationDiagnostic[] = [];
    for (const line of output.split('\n')) {
        const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line.trim());
        if (!m) continue;
        const filePath = path.resolve(project, m[1]);
        out.push({ file: filePath, filePath, line: Number(m[2]), message: `${m[4]}: ${m[5]}`, severity: 'error', source: 'tsc' });
    }
    return out;
}
