/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The symmetry pipeline K's source data implies, read and reported (step 1: detection only; nothing is built from it yet).
 * The kernels are native (scratchbox_symmetry.hpp behind scripts/symmetry_native.cpp, built through the native build
 * cache); this wrapper sends them the scan, the footprint and the straightened facade orthos, and reads the report back:
 *
 *  - plan symmetry: mirror axes and n-fold rotation of the massing (the scan's height map), of each tier's outline (tiers
 *    where flat roof area gathers) and of the footprint, scored sum min / sum max of the field and its image (Podolak et
 *    al. 2006's planar reflective symmetry, restricted to vertical planes; each peak over the angle a hypothesis, as in
 *    Mitra et al. 2006);
 *  - facade mirror symmetry: each ortho against its own mirror about every vertical axis, band-passed NCC over texels read
 *    on both sides (uncovered, occluded at OCCLUSION_PARAMS.minBlocked, transparent and smeared texels are not read);
 *  - twin facades: facades that are copies of each other under a plan symmetry, compared through it and gated at
 *    texture-repeat.ts NCC_GATE (the symmetric-facade pairing of Xue, Wu & Li, ISPRS XLIX-B2-2026 p.585, with the pairing
 *    measured on the photos rather than assumed from the massing).
 *
 * Every score is continuous and every reading carries the share of the area it covers and its axis; nothing is keyed to a
 * kind of building. Off by default: SCRATCHBOX_K_SYMMETRY=1 (or the node graph's remesh.symmetry) turns it on. The report
 * is a run note (pipeline_k_symmetry) and, without the sweeps, the GLB's asset.extras.sbSymmetry.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags, NativeBuildError, placeCachedBinary, type NativeCompileSpec } from '../../native-build-cache';
import { findTileRefineRepoRoot } from '../../tile-refine-service';
import type { ReliefFacade } from '../facade-lattice';
import { assembleGlb, parseGlbBytes } from '../glb-bytes';
import { NCC_GATE } from '../texture-repeat';
import { OCCLUSION_PARAMS } from './occlusion';
import { nativeTwinThreads } from './native/twin-texels-native';

export const SYMMETRY_VERSION = 'k-symmetry-1';

export const SYMMETRY_PARAMS = {
    /** Plan raster cell (m); heights at least minStructureM above the ground are the structure; a cell is flat within flatM of its neighbours. */
    cellM: 0.5, minStructureM: 3, flatM: 0.6,
    /** Tier levels: histogram bin (m), peaks merged within tierMergeM, a tier's least flat area (share of the structure, m2), an outline within tierSameShare of the one below is the same tier. */
    tierBinM: 0.5, tierMergeM: 2.5, tierMinShare: 0.015, tierMinAreaM2: 25, tierSameShare: 0.03,
    /** Mirror sweep and refinement (degrees), the least peak reported, peaks merged within peakSepDeg. */
    sweepDeg: 0.5, refineDeg: 0.05, peakFloor: 0.6, peakSepDeg: 4,
    /** A plan symmetry is detected (and carried into the twin search) at or above this score. */
    planGate: 0.9,
    /** Facades: the working texel (m), band-pass radius (m), coarse sweep texel (m), least share of read texels paired. */
    facadeCellM: 0.2, highPassM: 2, facadeCoarseM: 0.4, minPairShare: 0.3,
    /**
     * A facade mirror is detected at NCC >= nccGate over at least facadeShare of its read texels, its peak at least
     * minContrast above the median over every axis (a uniformly repeating wall matches its mirror about every half pitch:
     * its repetition, not a mirror).
     */
    facadeShare: 0.5, minContrast: 0.2,
    /** Twins: normals within twinNormalCos, planes within twinMaxOffsetM, extents overlapping by twinOverlapShare, shifts +-twinShiftM in twinShiftStepM. */
    twinNormalCos: 0.97, twinMaxOffsetM: 2, twinOverlapShare: 0.5, twinShiftM: 1, twinShiftStepM: 0.2,
    /** The NCC gate: texture-repeat.ts's, so a twin passes on the evidence a repeat does. */
    nccGate: NCC_GATE,
    maxTiers: 12, maxPeaks: 4, maxFold: 8
};
export type SymmetryParams = typeof SYMMETRY_PARAMS;

/** The order the driver reads them in (scripts/symmetry_native.cpp). */
const PARAM_ORDER: Array<keyof SymmetryParams> = [
    'cellM', 'minStructureM', 'flatM', 'tierBinM', 'tierMergeM', 'tierMinShare', 'tierMinAreaM2', 'tierSameShare',
    'sweepDeg', 'refineDeg', 'peakFloor', 'peakSepDeg', 'planGate', 'facadeCellM', 'highPassM', 'facadeCoarseM',
    'minPairShare', 'facadeShare', 'minContrast', 'twinNormalCos', 'twinMaxOffsetM', 'twinOverlapShare', 'twinShiftM', 'twinShiftStepM', 'nccGate',
    'maxTiers', 'maxPeaks', 'maxFold'
];

/** Whether the build reads its symmetry: SCRATCHBOX_K_SYMMETRY=1 (default off). */
export const symmetryOn = (env: NodeJS.ProcessEnv = process.env): boolean => ['1', 'on', 'true'].includes((env.SCRATCHBOX_K_SYMMETRY ?? '').trim().toLowerCase());

export interface PlanMirror { angleDeg: number; point: [number, number]; dir: [number, number]; score: number; share: number }
export interface FieldSymmetry {
    /** Area (m2) of an outline, volume (m3) of the height field. */
    mass: number; centroid: [number, number];
    best: PlanMirror; mirrors: PlanMirror[]; detectedMirrors: number;
    /** order: the largest n whose every rotation scores at least planGate (1: none); scores[n - 2] for n = 2..maxFold. */
    rotation: { order: number; score: number; scores: number[] };
}
export interface PlanTransform { kind: 'mirror' | 'rotation'; angleDeg: number; centre: [number, number]; from: string; score: number; order?: number; k?: number }
export interface FacadeMirrorReading {
    facadeId: number; read: boolean;
    axisS?: number; axisPoint?: [number, number, number]; ncc?: number; share?: number; medianNcc?: number; contrast?: number; outlineIoU?: number; centreOffsetM?: number;
    /** The median over every axis clears the gate: the wall repeats uniformly (its repetition, not a mirror). */
    periodic?: boolean; detected?: boolean;
    /** (axis s, NCC) over the coarse sweep. */
    profile?: Array<[number, number]>;
}
export interface TwinReading { a: number; b: number; transform: PlanTransform; ncc: number; share: number; shiftM: [number, number]; overlapShare: number; accepted: boolean }
export interface SymmetryReport {
    schema: 'scratchbox.symmetry/1'; frame: string;
    plan: { cellM: number; grid: [number, number]; origin: [number, number]; massing: FieldSymmetry; tiers: Array<{ levelM: number; roofAreaM2: number; outline: FieldSymmetry }>; footprint?: FieldSymmetry };
    facades: FacadeMirrorReading[]; transforms: PlanTransform[]; twins: TwinReading[];
    ms: { plan: number; facades: number; twins: number };
}

export interface SymmetryInput {
    /** The scan the plan is read from (tile frame, y up). */
    scanGlb: string;
    groundY: number;
    /** Footprint loops in plan (x, z); empty: the scan's own extent. */
    footprint: Array<Array<[number, number]>>;
    /** The straightened orthos' folder (facades.json beside them); absent: the plan alone. */
    orthosDir?: string;
}

const CLI_SOURCE = path.join('scripts', 'symmetry_native.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const BINARY = path.join('build', '3d-native', 'symmetry_native');
const REQUEST_VERSION = 1;

function compileSpec(repoRoot: string): NativeCompileSpec {
    return { sourcePath: path.join(repoRoot, CLI_SOURCE), includeDirs: [path.join(repoRoot, INCLUDE_DIR)], flags: defaultNativeFlags(['-pthread']), libs: ['-lz'], name: 'symmetry_native', timeoutMs: 300_000 };
}

let building: Promise<string> | undefined;

/** Builds build/3d-native/symmetry_native through the native build cache when its sources changed. */
export function ensureSymmetryBinary(repoRoot = findTileRefineRepoRoot()): Promise<string> {
    if (building) return building;
    building = (async () => {
        const bin = path.join(repoRoot, BINARY);
        try {
            placeCachedBinary((await compileNativeCached(compileSpec(repoRoot))).binaryPath, bin);
            return bin;
        } catch (err) {
            throw new Error(`could not build symmetry_native: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
        }
    })().finally(() => { building = undefined; });
    return building;
}

/** The request the driver reads (its comment lists the layout). */
export function encodeSymmetryRequest(input: SymmetryInput, facades: ReliefFacade[], P: SymmetryParams = SYMMETRY_PARAMS): Buffer {
    const parts: Buffer[] = [];
    const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); parts.push(b); };
    const i32 = (v: number) => { const b = Buffer.alloc(4); b.writeInt32LE(v, 0); parts.push(b); };
    const f64 = (v: number) => { const b = Buffer.alloc(8); b.writeDoubleLE(v, 0); parts.push(b); };
    const str = (s: string | undefined) => { const b = Buffer.from(s ?? '', 'utf8'); u32(b.length); parts.push(b); };
    parts.push(Buffer.from('SBSY', 'latin1'));
    u32(REQUEST_VERSION);
    for (const k of PARAM_ORDER) f64(P[k]);
    f64(OCCLUSION_PARAMS.minBlocked);
    f64(input.groundY);
    str(input.scanGlb);
    u32(input.footprint.length);
    for (const loop of input.footprint) { u32(loop.length); for (const [x, z] of loop) { f64(x); f64(z); } }
    str(input.orthosDir ?? '');
    u32(facades.length);
    for (const f of facades) {
        i32(f.facadeId);
        for (const v of [f.centroid, f.normal, f.axisS, f.axisT]) for (let k = 0; k < 3; k++) f64(v[k]);
        f64(f.orthoSMin); f64(f.orthoTMax); f64(f.pixel);
        const featureless = f.image.replace(/\.png$/, '_featureless.png');
        str(f.image); str(f.uncoveredMask); str(f.occludedMask); str(input.orthosDir && fs.existsSync(path.join(input.orthosDir, featureless)) ? featureless : '');
    }
    return Buffer.concat(parts);
}

/**
 * The building's symmetry from its scan, footprint and straightened facades, read natively. `heightmapFile` keeps the
 * plan's height map (for proof sheets). Throws when the driver cannot be built or fails; never answers with a guess.
 */
export async function detectSymmetry(input: SymmetryInput, opts: { params?: SymmetryParams; threads?: number; timeoutMs?: number; heightmapFile?: string; signal?: AbortSignal } = {}): Promise<SymmetryReport> {
    const P = opts.params ?? SYMMETRY_PARAMS;
    const facades: ReliefFacade[] = input.orthosDir && fs.existsSync(path.join(input.orthosDir, 'facades.json'))
        ? (JSON.parse(fs.readFileSync(path.join(input.orthosDir, 'facades.json'), 'utf8')) as { facades: ReliefFacade[] }).facades.filter(f => fs.existsSync(path.join(input.orthosDir!, f.image)))
        : [];
    const bin = await ensureSymmetryBinary();
    const threads = nativeTwinThreads(opts.threads);
    const args = [...(threads ? ['--threads', String(threads)] : []), ...(opts.heightmapFile ? ['--heightmap', opts.heightmapFile] : [])];
    const request = encodeSymmetryRequest(input, facades, P);
    const out = await new Promise<Buffer>((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const chunks: Buffer[] = [], errs: Buffer[] = [];
        const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 300_000);
        const onAbort = () => child.kill('SIGKILL');
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout.on('data', (b: Buffer) => chunks.push(b));
        child.stderr.on('data', (b: Buffer) => errs.push(b));
        child.on('error', err => { clearTimeout(timer); reject(new Error(`symmetry_native failed: ${err.message}`)); });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            opts.signal?.removeEventListener('abort', onAbort);
            if (code === 0) resolve(Buffer.concat(chunks));
            else reject(new Error(`symmetry_native failed: ${Buffer.concat(errs).toString().trim() || (signal ? `killed by ${signal}` : `exit code ${code}`)}`));
        });
        child.stdin.on('error', () => { /* the close handler reports why the driver stopped reading */ });
        child.stdin.end(request);
    });
    const report = JSON.parse(out.toString('utf8')) as SymmetryReport;
    if (report.schema !== 'scratchbox.symmetry/1') throw new Error('symmetry_native: not a symmetry report');
    return report;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** The report without the sweeps (the GLB's asset.extras.sbSymmetry): every reading's score, share and axis. */
export function symmetryExtras(rep: SymmetryReport): Record<string, unknown> {
    const field = (f: FieldSymmetry) => ({ centroid: f.centroid.map(r2), best: { angleDeg: r2(f.best.angleDeg), score: r2(f.best.score), share: r2(f.best.share) }, mirrors: f.mirrors.map(m => ({ angleDeg: r2(m.angleDeg), point: m.point.map(r2), score: r2(m.score), share: r2(m.share) })), rotation: { order: f.rotation.order, score: r2(f.rotation.score) } });
    return {
        schema: 'scratchbox.symmetry-extras/1', version: SYMMETRY_VERSION, frame: rep.frame, label: 'measured (a score on the scan and the photos; nothing built from it)',
        plan: { massing: field(rep.plan.massing), tiers: rep.plan.tiers.map(t => ({ levelM: r2(t.levelM), ...field(t.outline) })), ...(rep.plan.footprint ? { footprint: field(rep.plan.footprint) } : {}) },
        facades: rep.facades.filter(f => f.read).map(f => ({ facadeId: f.facadeId, axisS: r2(f.axisS!), axisPoint: f.axisPoint!.map(r2), ncc: r2(f.ncc!), share: r2(f.share!), contrast: r2(f.contrast!), periodic: !!f.periodic, detected: !!f.detected })),
        twins: rep.twins.map(t => ({ a: t.a, b: t.b, kind: t.transform.kind, angleDeg: r2(t.transform.angleDeg), centre: t.transform.centre.map(r2), ncc: r2(t.ncc), share: r2(t.share), accepted: t.accepted }))
    };
}

/** A copy of `glbFile` (beside it, `_sym` before the extension) with asset.extras.sbSymmetry set; returns its path. The cached original is left as it was. */
export function stampSymmetryGlb(glbFile: string, rep: SymmetryReport): string {
    const g = parseGlbBytes(fs.readFileSync(glbFile));
    g.json.asset = g.json.asset ?? { version: '2.0' };
    g.json.asset.extras = { ...(g.json.asset.extras ?? {}), sbSymmetry: symmetryExtras(rep) };
    const out = glbFile.replace(/(\.glb)?$/i, '_sym.glb');
    fs.writeFileSync(out, assembleGlb(g.json, g.bin));
    return out;
}

/** One line for the build's notes. */
export function describeSymmetry(rep: SymmetryReport, P: SymmetryParams = SYMMETRY_PARAMS): string {
    const m = rep.plan.massing;
    const axes = (f: FieldSymmetry) => f.mirrors.filter(x => x.score >= P.planGate);
    const fmt = (f: FieldSymmetry) => `${axes(f).length ? `${axes(f).length} mirror axes (${axes(f).map(x => `${Math.round(x.angleDeg)}° at ${x.score.toFixed(2)}`).join(', ')})` : `no mirror axis (best ${f.best.score.toFixed(2)} at ${Math.round(f.best.angleDeg)}°)`}${f.rotation.order > 1 ? `, ${f.rotation.order}-fold rotation at ${f.rotation.score.toFixed(2)}` : ''}`;
    const tiersSym = rep.plan.tiers.filter(t => axes(t.outline).length || t.outline.rotation.order > 1).length;
    const read = rep.facades.filter(f => f.read), det = read.filter(f => f.detected);
    const acc = rep.twins.filter(t => t.accepted);
    return `symmetry (${SYMMETRY_VERSION}, detection only): massing ${fmt(m)}; ${tiersSym} of ${rep.plan.tiers.length} tiers symmetric in plan${rep.plan.footprint ? `; footprint ${fmt(rep.plan.footprint)}` : ''}; ${det.length} of ${read.length} facades mirror-symmetric (NCC ≥ ${P.nccGate} over ≥ ${Math.round(100 * P.facadeShare)}% of their read texels, ≥ ${P.minContrast} above the wall's own repetition), ${read.filter(f => f.periodic && !f.detected).length} repeating uniformly with no distinct axis; ${acc.length} twin facade pairs of ${rep.twins.length} candidates under ${rep.transforms.length} plan symmetries`;
}
