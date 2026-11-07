/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Cleanup for generated meshes (a Trellis model in pipeline J, a generated object): a watertight voxel remesh, a
 * field-aligned quad remesh, Catmull-Clark subdivision and the source's detail projected back
 * (scratchbox_generated_cleanup.hpp, run by scripts/generated_mesh_cleanup.cpp), then the source's textures baked onto
 * the new surface by the UV rewrap's transfer. The result is labelled generated. Measured geometry is refused: a scan is
 * judged by its fit and never remeshed (AGENTS.md section 3.3).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { buildNativeIfStale } from './native-build';
import { readGlbScene } from '../spatial/StreetViewPoseRegistrar';
import { unwrapRewrapGlb, type UvRewrapReport } from '../spatial/UvAtlasRewrap';

export interface GeneratedMeshCleanupOptions {
    /** Must be 'generated': the caller states what the mesh is; anything else is refused. */
    provenance: 'generated' | (string & {});
    /** Quads of the remesh before subdivision (default 6000). */
    targetQuads?: number;
    /** Catmull-Clark steps (default 1). */
    subdivisions?: number;
    /** Gap closing radius in voxels (default 2). */
    closeRadius?: number;
    /** Voxels along the diagonal at most (default 768). */
    maxVoxelResolution?: number;
    /** Bake the source's textures onto the result (default true when the source has any). */
    transferTextures?: boolean;
    threads?: number;
    timeoutMs?: number;
    workDir?: string;
    /** Also write the subdivided quad mesh ('SBQP' polygons) to workDir/quads.sbqp, for inspection. */
    keepQuads?: boolean;
    /**
     * Fidelity gate: the result is refused when its 95th-percentile distance to the model, either way, passes this
     * share of the model's diagonal (default 0.005). On the benchmark buildings a clean model lands at 0.05-0.3%; an
     * open model full of thin sheets (the Flatiron's, 1.0-1.3%) came out lumpy and blotchy, so it is kept as built.
     */
    maxP95Fraction?: number;
}

export interface CleanupTopology {
    vertices: number; triangles: number; openEdges: number; nonManifoldEdges: number; nonManifoldVertices: number;
    misorientedEdges: number; degenerateTriangles: number; components: number; euler: number; genus: number; watertight: boolean;
}
export interface CleanupDistance { max: number; mean: number; rms: number; p95: number; samples: number }

export interface GeneratedMeshCleanupReport {
    ok: boolean;
    report: {
        voxel: { voxelSize: number; dims: number[]; blocks: number; surfaceVoxels: number; signEdges: number; hermiteRay: number; hermiteFallback: number; multiSheetCells: number; quads: number };
        quad: { spacing: number; quads: number; polygons: number; singularities: number; fieldSingularities: number; flowSupply: number; flowUnmet: number; flipped: number; holesClosed: number; meanAngleDeviationDeg: number; meanScaledJacobian: number; minScaledJacobian: number };
        subdividedFaces: number;
        projection: { distance: number; vertices: number; hits: number; nearest: number; misses: number; meanMove: number; maxMove: number };
        ms: { voxel: number; quad: number; subdivide: number; project: number };
        failure: string;
    };
    before: CleanupTopology;
    /** Welded by position (coincident points merged). */
    after?: CleanupTopology;
    /** The result's own connectivity (no weld): a fold where two sheets touch shows in `after` only. */
    afterIndexed?: CleanupTopology;
    hausdorff?: { max: number; diagonal: number; resultToSource: CleanupDistance; sourceToResult: CleanupDistance };
}

export interface GeneratedMeshCleanupResult {
    glb: Buffer;
    /** Geometry before the texture bake (world space, one primitive). */
    geometryGlb: Buffer;
    report: GeneratedMeshCleanupReport;
    rewrap?: UvRewrapReport;
    provenance: 'generated';
    totalMs: number;
}

const PROVENANCE_REFUSED = /^(measured|vector-modelled|photo-inferred)$/;

/** Throws unless the caller says generated and nothing in the GLB's own extras says otherwise. */
export function assertGeneratedSource(glb: Buffer, provenance: string): void {
    if (provenance !== 'generated') {
        throw new Error(`generated mesh cleanup refused: the mesh is labelled '${provenance}', and only generated content is remeshed (measured geometry is judged by its fit, never remeshed or padded)`);
    }
    if (glb.length < 20 || glb.readUInt32LE(0) !== 0x46546c67) throw new Error('generated mesh cleanup: not a binary glTF');
    const jsonLen = glb.readUInt32LE(12);
    const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
    const labels: string[] = [];
    const visit = (o: any) => {
        if (!o || typeof o !== 'object') return;
        const ex = o.extras;
        if (ex && typeof ex === 'object') {
            for (const key of ['provenance', 'sbProvenance']) if (typeof ex[key] === 'string') labels.push(ex[key]);
            if (ex.sb && typeof ex.sb.provenance === 'string') labels.push(ex.sb.provenance);
        }
    };
    for (const list of ['nodes', 'meshes', 'materials', 'scenes']) for (const o of json[list] ?? []) visit(o);
    visit(json.asset);
    const refused = labels.filter(l => PROVENANCE_REFUSED.test(l));
    if (refused.length) throw new Error(`generated mesh cleanup refused: the GLB labels parts ${[...new Set(refused)].join(', ')}; only generated content is remeshed`);
}

function repoRoot(): string {
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
        if (fs.existsSync(path.join(dir, 'scripts', 'generated_mesh_cleanup.cpp'))) return dir;
        dir = path.dirname(dir);
    }
    return process.cwd();
}

/** Builds build/3d-native/generated_mesh_cleanup when its sources changed. */
export function ensureGeneratedCleanupBinary(root = repoRoot()): Promise<string> {
    return buildNativeIfStale({
        source: path.join(root, 'scripts', 'generated_mesh_cleanup.cpp'),
        binary: path.join(root, 'build', '3d-native', 'generated_mesh_cleanup'),
        includeDir: path.join(root, 'packages', 'core', 'src', 'native', '3d-engine', 'include')
    });
}

/** Every triangle of the GLB in world space, as the native input ('u32 V, u32 T, f32 positions, u32 indices'). */
export function flattenGlbToBin(glbPath: string): { bin: Buffer; triangles: number; textured: boolean } {
    const prims = readGlbScene(glbPath);
    let nv = 0, ni = 0, textured = false;
    for (const p of prims) { nv += p.positions.length / 3; ni += p.indices.length; if (p.image) textured = true; }
    if (!ni) throw new Error('generated mesh cleanup: the GLB has no triangles');
    const bin = Buffer.alloc(8 + nv * 12 + ni * 4);
    bin.writeUInt32LE(nv, 0);
    bin.writeUInt32LE(ni / 3, 4);
    const pos = new Float32Array(nv * 3);
    const idx = new Uint32Array(ni);
    let ov = 0, oi = 0;
    for (const p of prims) {
        pos.set(p.positions, ov * 3);
        for (let i = 0; i < p.indices.length; i++) idx[oi + i] = p.indices[i] + ov;
        ov += p.positions.length / 3;
        oi += p.indices.length;
    }
    Buffer.from(pos.buffer).copy(bin, 8);
    Buffer.from(idx.buffer).copy(bin, 8 + nv * 12);
    return { bin, triangles: ni / 3, textured };
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise(resolve => {
        execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
            const code = err ? ((err as any).code ?? 1) : 0;
            resolve({ stdout: String(stdout), stderr: String(stderr), code: typeof code === 'number' ? code : 1 });
        });
    });
}

/**
 * Cleans a generated GLB. Throws with the stage's reason when the cleanup cannot produce a closed surface (the caller
 * keeps the model as built and reports why); never substitutes other geometry.
 */
export async function cleanupGeneratedGlb(input: string | Buffer, options: GeneratedMeshCleanupOptions): Promise<GeneratedMeshCleanupResult> {
    const t0 = Date.now();
    const glb = typeof input === 'string' ? fs.readFileSync(input) : input;
    assertGeneratedSource(glb, options.provenance);
    const work = options.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sb-gen-cleanup-'));
    fs.mkdirSync(work, { recursive: true });
    const srcPath = path.join(work, 'source.glb');
    if (typeof input !== 'string' || path.resolve(input) !== path.resolve(srcPath)) fs.writeFileSync(srcPath, glb);
    const flat = flattenGlbToBin(srcPath);
    const binPath = path.join(work, 'source.bin'), outPath = path.join(work, 'cleaned_geometry.glb');
    fs.writeFileSync(binPath, flat.bin);
    const exe = await ensureGeneratedCleanupBinary();
    const args = ['--in', binPath, '--out', outPath,
        '--quads', String(options.targetQuads ?? 6000), '--subdivisions', String(options.subdivisions ?? 1),
        '--close-radius', String(options.closeRadius ?? 2), '--max-voxel-resolution', String(options.maxVoxelResolution ?? 768)];
    if (options.threads) args.push('--threads', String(options.threads));
    if (options.keepQuads) args.push('--quads-out', path.join(work, 'quads.sbqp'));
    const r = await run(exe, args, options.timeoutMs ?? 10 * 60_000);
    const line = r.stdout.trim().split('\n').pop() ?? '';
    let report: GeneratedMeshCleanupReport;
    try { report = JSON.parse(line); } catch { throw new Error(`generated mesh cleanup failed (exit ${r.code}): ${r.stderr.trim() || 'no report'}`); }
    if (!report.ok) throw new Error(`generated mesh cleanup could not close the model: ${report.report.failure}`);
    const h = report.hausdorff;
    const gate = options.maxP95Fraction ?? 0.005;
    if (h && h.diagonal > 0) {
        const worst = Math.max(h.resultToSource.p95, h.sourceToResult.p95) / h.diagonal;
        if (worst > gate) throw new Error(`generated mesh cleanup refused its own result: 95% of the surface within ${(100 * worst).toFixed(2)}% of the diagonal, over the ${(100 * gate).toFixed(2)}% limit (the model is too open or thin to remesh faithfully)`);
    }
    const geometryGlb: Buffer = fs.readFileSync(outPath);
    let out: Buffer = geometryGlb;
    let rewrap: UvRewrapReport | undefined;
    if ((options.transferTextures ?? true) && flat.textured) {
        const baked = await unwrapRewrapGlb('rewrap', geometryGlb, { transferSource: { glb } });
        out = baked.glb;
        rewrap = baked.report;
    }
    out = labelGenerated(out, report);
    return { glb: out, geometryGlb, report, ...(rewrap ? { rewrap } : {}), provenance: 'generated', totalMs: Date.now() - t0 };
}

/** Writes provenance 'generated' and the cleanup's measures into every mesh's and material's extras. */
export function labelGenerated(glb: Buffer, report: GeneratedMeshCleanupReport): Buffer {
    const jsonLen = glb.readUInt32LE(12);
    const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
    const sbCleanup = {
        method: 'voxel+quad+subdivision+projection',
        watertight: report.after?.watertight ?? false,
        hausdorff: report.hausdorff?.max,
        singularities: report.report.quad.singularities
    };
    for (const list of ['meshes', 'materials']) for (const o of json[list] ?? []) o.extras = { ...(o.extras ?? {}), provenance: 'generated', sbCleanup };
    let text = JSON.stringify(json);
    while (Buffer.byteLength(text) % 4) text += ' ';
    const jsonBuf = Buffer.from(text, 'utf8');
    const rest = glb.subarray(20 + jsonLen);
    const head = Buffer.alloc(20);
    head.writeUInt32LE(0x46546c67, 0);
    head.writeUInt32LE(2, 4);
    head.writeUInt32LE(20 + jsonBuf.length + rest.length, 8);
    head.writeUInt32LE(jsonBuf.length, 12);
    head.writeUInt32LE(0x4e4f534a, 16);
    return Buffer.concat([head, jsonBuf, rest]);
}
