/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * SB-Rig service: rigs any GLB with a geometry-derived joint tree and geodesic skin weights by
 * compiling and running the native runner (scripts/run_sb_rig_pipeline.cpp over
 * scratchbox_sb_rig.hpp). The output GLB keeps every image, UV and material of the input.
 */

import * as fs from 'fs';
import * as path from 'path';
import { NativeCppCompilerService } from './native-compiler-service';

export type Point3 = [number, number, number];

/** Dimensionless tuning parameters; names match SbRigParams in scratchbox_sb_rig.hpp. */
export interface SbRigParams {
    weldFrac?: number;
    refineEdgeMultiple?: number;
    agdSamples?: number;
    bandFrac?: number;
    bandEdgeMultiple?: number;
    loopContractRatio?: number;
    minNodeFrac?: number;
    minBranchFrac?: number;
    hubMergeFrac?: number;
    jointDeviationFrac?: number;
    radiusWeight?: number;
    bendThresholdRad?: number;
    minBoneFrac?: number;
    maxBoneFrac?: number;
    minLeafChainSegments?: number;
    blendScale?: number;
    emitTipJoints?: boolean;
}

const PARAM_NAMES: ReadonlyArray<keyof SbRigParams> = [
    'weldFrac', 'refineEdgeMultiple', 'agdSamples', 'bandFrac', 'bandEdgeMultiple', 'loopContractRatio', 'minNodeFrac',
    'minBranchFrac', 'hubMergeFrac', 'jointDeviationFrac', 'radiusWeight', 'bendThresholdRad', 'minBoneFrac', 'maxBoneFrac',
    'minLeafChainSegments', 'blendScale', 'emitTipJoints',
];

export interface SbRigOptions {
    inputGlbPath?: string;
    inputGlbBuffer?: Buffer;
    /** Defaults to `<input>_sbrig.glb` beside a path input, or `.scratchbox/artifacts/sb-rig/` for a buffer. */
    outputGlbPath?: string;
    params?: SbRigParams;
    /** World-space point near where the hierarchy should start (e.g. the cut end of a limb). */
    rootHint?: Point3;
    /** Extra chains for digits geometry cannot separate, each ordered base -> tip. */
    chainHints?: Point3[][];
    /** Applied in order: a chain name renames its joints to <to>1..n; any other key is an exact joint name. */
    rename?: Array<{ from: string; to: string }> | Record<string, string>;
    /** Include the skeleton tree over Reeb nodes in the report (diagnostics). */
    includeTree?: boolean;
}

export interface SbRigJoint {
    name: string;
    parent: string | null;
    position: Point3;
    tip: boolean;
}

export interface SbRigChainInfo {
    name: string;
    parentJoint: string | null;
    joints: string[];
    leaf: boolean;
    hinted: boolean;
    length: number;
    basePosition?: Point3;
    endPosition?: Point3;
}

export interface SbRigReport {
    generator: string;
    version: number;
    joints: SbRigJoint[];
    chains: SbRigChainInfo[];
    stats: Record<string, number | string>;
    timingsMs: Record<string, number>;
    warnings: string[];
    params: Record<string, unknown>;
    tree?: unknown[];
}

export interface SbRigResult {
    outputGlbPath: string;
    reportPath: string;
    glbBuffer: Buffer;
    report: SbRigReport;
    telemetry: Record<string, string>;
}

export class SbRigError extends Error {
    constructor(message: string, readonly kind: 'invalid-input' | 'internal' | 'compile', readonly details?: string) {
        super(message);
        this.name = 'SbRigError';
    }
}

function findRepoRoot(): string {
    let cur = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    while (cur && cur !== path.dirname(cur)) {
        if (fs.existsSync(path.join(cur, 'scripts/run_sb_rig_pipeline.cpp'))) return cur;
        cur = path.dirname(cur);
    }
    return process.cwd();
}

function formatPoint(p: Point3, label: string): string {
    if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) throw new SbRigError(`${label} must be three finite numbers`, 'invalid-input');
    return p.join(',');
}

/** Parses `[TELEMETRY] k=v ...`; a quoted `message="..."` value is JSON-decoded. */
export function parseSbRigTelemetry(stdout: string): Record<string, string> {
    const line = stdout.split('\n').reverse().find(l => l.startsWith('[TELEMETRY]'));
    if (!line) return {};
    const out: Record<string, string> = {};
    const body = line.slice('[TELEMETRY]'.length);
    const messageAt = body.indexOf(' message=');
    const head = messageAt >= 0 ? body.slice(0, messageAt) : body;
    for (const token of head.trim().split(/\s+/)) {
        const eq = token.indexOf('=');
        if (eq > 0) out[token.slice(0, eq)] = token.slice(eq + 1);
    }
    if (messageAt >= 0) {
        const raw = body.slice(messageAt + ' message='.length).trim();
        try {
            out.message = JSON.parse(raw);
        } catch {
            out.message = raw;
        }
    }
    return out;
}

/** Builds runner argv (pure argv, never a shell string). */
export function buildSbRigArgs(inputPath: string, outputPath: string, reportPath: string, options: SbRigOptions): string[] {
    const args = ['--input', inputPath, '--output', outputPath, '--report', reportPath];
    for (const [key, value] of Object.entries(options.params ?? {})) {
        if (value === undefined) continue;
        if (!PARAM_NAMES.includes(key as keyof SbRigParams)) throw new SbRigError(`unknown SB-Rig parameter '${key}'`, 'invalid-input');
        if (typeof value === 'boolean') args.push(`--param-${key}`, value ? 'true' : 'false');
        else if (typeof value === 'number' && Number.isFinite(value)) args.push(`--param-${key}`, String(value));
        else throw new SbRigError(`parameter ${key} must be a finite number`, 'invalid-input');
    }
    if (options.rootHint) args.push('--root-hint', formatPoint(options.rootHint, 'rootHint'));
    for (const [i, hint] of (options.chainHints ?? []).entries()) {
        if (!Array.isArray(hint) || hint.length < 2) throw new SbRigError(`chainHints[${i}] needs at least 2 points (base ... tip)`, 'invalid-input');
        args.push('--chain-hint', hint.map((p, k) => formatPoint(p, `chainHints[${i}][${k}]`)).join(';'));
    }
    const rename = Array.isArray(options.rename) ? options.rename : Object.entries(options.rename ?? {}).map(([from, to]) => ({ from, to }));
    for (const { from, to } of rename) {
        if (!from || !to || from.includes('=')) throw new SbRigError(`invalid rename '${from}' -> '${to}'`, 'invalid-input');
        args.push('--rename', `${from}=${to}`);
    }
    if (options.includeTree) args.push('--debug-tree');
    return args;
}

export class SbRigService {
    constructor(private readonly compiler: NativeCppCompilerService = new NativeCppCompilerService()) {}

    /** The runner, built from the current source through the native build cache (a warm check costs a few stats). */
    async ensureBinary(): Promise<string> {
        const sourcePath = path.join(findRepoRoot(), 'scripts/run_sb_rig_pipeline.cpp');
        if (!fs.existsSync(sourcePath)) throw new SbRigError(`SB-Rig runner source not found at ${sourcePath}`, 'compile');
        const extraFlags = process.env.SCRATCHBOX_NATIVE_ARCH === '1' ? ['-march=native'] : [];
        const compiled = await this.compiler.compileSource(fs.readFileSync(sourcePath, 'utf8'), { outputBinaryName: 'run_sb_rig_pipeline', extraFlags });
        if (!compiled.success || !compiled.binaryPath) {
            throw new SbRigError('SB-Rig runner failed to compile', 'compile', compiled.compilerOutput);
        }
        return compiled.binaryPath;
    }

    async rig(options: SbRigOptions): Promise<SbRigResult> {
        if (!!options.inputGlbPath === !!options.inputGlbBuffer) {
            throw new SbRigError('provide exactly one of inputGlbPath or inputGlbBuffer', 'invalid-input');
        }
        let inputPath = options.inputGlbPath ? path.resolve(options.inputGlbPath) : '';
        if (inputPath && !fs.existsSync(inputPath)) throw new SbRigError(`input GLB not found: ${inputPath}`, 'invalid-input');

        const artifacts = path.resolve(process.cwd(), '.scratchbox/artifacts/sb-rig');
        const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        let stagedInput: string | null = null;
        if (options.inputGlbBuffer) {
            fs.mkdirSync(artifacts, { recursive: true });
            stagedInput = path.join(artifacts, `input_${stamp}.glb`);
            fs.writeFileSync(stagedInput, options.inputGlbBuffer);
            inputPath = stagedInput;
        }
        const outputPath = path.resolve(
            options.outputGlbPath ??
                (options.inputGlbPath ? inputPath.replace(/\.glb$/i, '') + '_sbrig.glb' : path.join(artifacts, `sbrig_${stamp}.glb`))
        );
        const reportPath = outputPath.replace(/\.glb$/i, '') + '.sbrig.json';
        const args = buildSbRigArgs(inputPath, outputPath, reportPath, options);

        try {
            const binary = await this.ensureBinary();
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            const exec = await this.compiler.executeBinary(binary, args, path.dirname(outputPath));
            const telemetry = parseSbRigTelemetry(exec.stdout);
            if (exec.exitCode !== 0 || telemetry.status !== 'success') {
                const message = telemetry.message || exec.stderr.trim() || `SB-Rig exited with code ${exec.exitCode}`;
                throw new SbRigError(message, telemetry.kind === 'invalid-input' ? 'invalid-input' : 'internal', exec.stderr);
            }
            return {
                outputGlbPath: outputPath,
                reportPath,
                glbBuffer: fs.readFileSync(outputPath),
                report: JSON.parse(fs.readFileSync(reportPath, 'utf8')) as SbRigReport,
                telemetry,
            };
        } finally {
            if (stagedInput) fs.rmSync(stagedInput, { force: true });
        }
    }
}

/** Convenience wrapper: `await sbRigMesh({ inputGlbPath, rootHint, chainHints, rename })`. */
export async function sbRigMesh(options: SbRigOptions): Promise<SbRigResult> {
    return new SbRigService().rig(options);
}
