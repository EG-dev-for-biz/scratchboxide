/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Generation of the scratchbox Python API stubs (scripts/gen_sb_stubs.py) from the live module: builds the native
 * scratchbox_native module when its sources changed, then runs the generator with the package and the module on the
 * path. Used by `npm run stubs:sb` (writes the committed stubs) and by the drift test (writes to a temp dir).
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { NativePythonRunnerService } from './native-python-runner-service';
import { repoPath } from '../process/repo-python';

const execFileAsync = promisify(execFile);

/** The committed stubs: scratchbox/ and scratchbox_native/ .pyi packages. */
export function sbStubsDir(): string {
    return repoPath('packages', 'core', 'src', 'python', 'typings');
}

/** The committed TypeScript module with the API summary, index and version (SB_API_VERSION). */
export function sbApiModulePath(): string {
    return repoPath('packages', 'core', 'src', 'node', '3d-engine', 'sb-api.generated.ts');
}

export interface SbStubGenerationReport {
    version: string;
    stubFiles: number;
    probes: number;
    inferredReturnsApplied: number;
    fullSummaryChars: number;
    coreSummaryChars: number;
    /** Repairs the generator made where introspection fell short (C++ types it could not name, and the like). */
    patches: string[];
    /** Python callables whose return type stayed unknown (the stubs leave them unannotated). */
    unknownReturns: string[];
}

/**
 * Regenerates the stubs into `outDir` and the TypeScript module into `summaryTs` (the committed locations by default).
 * Throws with the generator's output when the native module cannot be built or the generator fails.
 */
export async function generateSbStubs(opts: { outDir?: string; summaryTs?: string } = {}): Promise<SbStubGenerationReport> {
    const runner = NativePythonRunnerService.getInstance();
    const buildError = await runner.ensureNativeModule();
    if (buildError) throw new Error(`scratchbox_native could not be built, so the stubs cannot be generated: ${buildError}`);
    const python = runner.getPythonExecutable();
    const outDir = opts.outDir ?? sbStubsDir();
    const summaryTs = opts.summaryTs ?? sbApiModulePath();
    fs.mkdirSync(outDir, { recursive: true });
    const env = {
        ...process.env,
        PYTHONPATH: [repoPath('packages', 'core', 'src', 'python'), runner.getModuleDirectory()].join(path.delimiter),
        PYTHONDONTWRITEBYTECODE: '1'
    };
    try {
        const { stdout } = await execFileAsync(python, [repoPath('scripts', 'gen_sb_stubs.py'), '--out', outDir, '--summary-ts', summaryTs],
            { env, cwd: repoPath(), timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
        const last = stdout.trim().split('\n').pop() || '{}';
        return JSON.parse(last) as SbStubGenerationReport;
    } catch (err: any) {
        throw new Error(`gen_sb_stubs.py failed: ${String(err?.stderr || err?.stdout || err?.message || err).slice(-4000)}`);
    }
}

/** Every file under `dir`, relative paths (forward slashes) to contents. */
export function readTree(dir: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (d: string) => {
        if (!fs.existsSync(d)) return;
        for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) walk(full);
            else out.set(path.relative(dir, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8'));
        }
    };
    walk(dir);
    return out;
}
