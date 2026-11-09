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
 *
 * Step 2, symmetry as evidence (with the reading; SCRATCHBOX_K_SYMMETRY_FILL=0 / SCRATCHBOX_K_SYMMETRY_WINDOWS=0 turn a
 * part off): mirrorFillOrthos fills each facade's unread texels from its mirror before the repeat fill stands, and
 * mirrorWindows lets the facade reader's windows confirm or fill their mirror sites and flags reader phase errors. The
 * mirror never overrides what the photo measured: only unread texels and unread sites take anything from it.
 */

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags, NativeBuildError, placeCachedBinary, type NativeCompileSpec } from '../../native-build-cache';
import { findTileRefineRepoRoot } from '../../tile-refine-service';
import type { ReliefFacade } from '../facade-lattice';
import { assembleGlb, parseGlbBytes } from '../glb-bytes';
import { NCC_GATE } from '../texture-repeat';
import { WINDOW_FIT_FILE, type WindowFitFile, type WindowRect } from '../window-fit';
import { decodePng } from '../../../texture-processing';
import { OCCLUSION_PARAMS } from './occlusion';
import { nativeTwinThreads } from './native/twin-texels-native';

export const SYMMETRY_VERSION = 'k-symmetry-3';

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
    /** The mirror fill (step 2), when asked for: per facade with unread texels, how many its own mirror and its twins filled. */
    fills?: MirrorFill[];
    ms: { plan: number; facades: number; twins: number; fill?: number };
}

export interface MirrorFill {
    facadeId: number; unread: number; fromMirror: number; axisS: number; axisNcc: number;
    /** (twin facade id, texels). */
    fromTwins: Array<[number, number]>;
    regions: number; regionsFilled: number; regionsRefused: number;
    largest: Array<{ texels: number; filled: number; ringNcc: number; ringPairs: number; source: string }>;
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
export async function detectSymmetry(input: SymmetryInput, opts: { params?: SymmetryParams; threads?: number; timeoutMs?: number; heightmapFile?: string; signal?: AbortSignal; /** The mirror fill's output folder (a clone of the orthos' folder): the filled orthos and their masks are written there. */ fillDir?: string } = {}): Promise<SymmetryReport> {
    const P = opts.params ?? SYMMETRY_PARAMS;
    const facades: ReliefFacade[] = input.orthosDir && fs.existsSync(path.join(input.orthosDir, 'facades.json'))
        ? (JSON.parse(fs.readFileSync(path.join(input.orthosDir, 'facades.json'), 'utf8')) as { facades: ReliefFacade[] }).facades.filter(f => fs.existsSync(path.join(input.orthosDir!, f.image)))
        : [];
    const bin = await ensureSymmetryBinary();
    const threads = nativeTwinThreads(opts.threads);
    const args = [...(threads ? ['--threads', String(threads)] : []), ...(opts.heightmapFile ? ['--heightmap', opts.heightmapFile] : []), ...(opts.fillDir ? ['--fill', opts.fillDir] : [])];
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

// ---------------------------------------------------------------------------------------------------------------------
// step 2: symmetry as evidence

/** Whether the mirror fill and the mirror windows run with the reading (both on with SCRATCHBOX_K_SYMMETRY=1 unless turned off). */
export const symmetryFillOn = (env: NodeJS.ProcessEnv = process.env): boolean => symmetryOn(env) && env.SCRATCHBOX_K_SYMMETRY_FILL?.trim() !== '0';
export const symmetryWindowsOn = (env: NodeJS.ProcessEnv = process.env): boolean => symmetryOn(env) && env.SCRATCHBOX_K_SYMMETRY_WINDOWS?.trim() !== '0';

export const mirrorMaskName = (image: string) => image.replace(/\.png$/i, '') + '_mirror.png';

export interface MirrorFilledOrthos { orthosDir: string; key: string; report: SymmetryReport; cached: boolean; ms: number }

/**
 * The straightened orthos with their unread texels (never reached, occluded, a smear) filled from the symmetry the
 * building shows (generated): a facade's own mirror first, then an accepted twin's, each region only where the read ring
 * around it agrees with its image at the gate; a read texel is never written. The repeat and region fills the rectifier
 * already made read only real photo, so taking the mirror's texel over theirs wherever the mirror has one is the same as
 * running it before them. Written to a clone of the orthos' folder (the orthos, their masks, facades.json; no later
 * stage's files), keyed by the orthos' key and this step's version and parameters; each filled facade names its mask
 * (`mirrorMask`) and carries what filled it in facades.json and in its textureFill's method. Returns the reading too.
 */
export async function mirrorFillOrthos(orthosDir: string, orthosKey: string, input: Omit<SymmetryInput, 'orthosDir'>, opts: { params?: SymmetryParams; threads?: number; signal?: AbortSignal } = {}): Promise<MirrorFilledOrthos> {
    const t0 = Date.now();
    const P = opts.params ?? SYMMETRY_PARAMS;
    const key = crypto.createHash('sha256').update(JSON.stringify({ v: SYMMETRY_VERSION, orthosKey, P, scan: input.scanGlb, groundY: input.groundY, footprint: input.footprint })).digest('hex').slice(0, 16);
    const outDir = `${orthosDir}_sym_${key}`;
    const reportFile = path.join(outDir, 'symmetry.json');
    if (fs.existsSync(reportFile)) return { orthosDir: outDir, key, report: JSON.parse(fs.readFileSync(reportFile, 'utf8')) as SymmetryReport, cached: true, ms: Date.now() - t0 };
    const tmp = `${outDir}.tmp-${process.pid}-${Date.now()}`;
    fs.mkdirSync(tmp, { recursive: true });
    try {
        // the orthos, their masks and frames only: a later stage's file (window_fit.json) is keyed by its own version, not
        // by the pixels, and would be read back as if fitted on these
        for (const name of fs.readdirSync(orthosDir)) {
            if (!(name.endsWith('.png') || name === 'facades.json' || name === 'rectify.json')) continue;
            const from = path.join(orthosDir, name);
            if (!fs.statSync(from).isFile()) continue;
            fs.copyFileSync(from, path.join(tmp, name), fs.constants.COPYFILE_FICLONE);
        }
        const report = await detectSymmetry({ ...input, orthosDir }, { params: P, ...(opts.threads ? { threads: opts.threads } : {}), ...(opts.signal ? { signal: opts.signal } : {}), fillDir: tmp });
        const fj = JSON.parse(fs.readFileSync(path.join(tmp, 'facades.json'), 'utf8')) as { facades: ReliefFacade[] };
        for (const f of fj.facades) {
            const fill = report.fills?.find(x => x.facadeId === f.facadeId);
            const twins = fill ? fill.fromTwins.reduce((a, [, n]) => a + n, 0) : 0;
            if (!fill || !(fill.fromMirror + twins) || !fs.existsSync(path.join(tmp, mirrorMaskName(f.image)))) continue;
            const m = report.facades.find(x => x.facadeId === f.facadeId);
            const what = `${fill.fromMirror ? `${fill.fromMirror} texels from the facade's own mirror about s = ${r2(fill.axisS)} m (NCC ${r2(fill.axisNcc)})` : ''}${fill.fromMirror && twins ? ', ' : ''}${twins ? `${twins} from twin facade${fill.fromTwins.length > 1 ? 's' : ''} ${fill.fromTwins.map(([id, n]) => `${id} (${n})`).join(', ')} across the plan's symmetry` : ''}`;
            const rec = f as ReliefFacade & { mirrorMask?: string; mirrorFill?: Record<string, unknown> };
            rec.mirrorMask = mirrorMaskName(f.image);
            rec.mirrorFill = { version: SYMMETRY_VERSION, label: 'generated', fromMirror: fill.fromMirror, fromTwins: fill.fromTwins, axisS: r2(fill.axisS), axisNcc: r2(fill.axisNcc), ...(m?.contrast !== undefined ? { contrast: r2(m.contrast) } : {}), regionsFilled: fill.regionsFilled, regionsRefused: fill.regionsRefused };
            if (f.textureFill) f.textureFill = { ...f.textureFill, method: `${f.textureFill.method}; then, in place of those fills, ${what}, each region only where the photo around it agrees with its mirror (generated)` };
            else f.textureFill = { label: 'generated', texels: fill.fromMirror + twins, share: Math.round((fill.fromMirror + twins) / Math.max(1, f.width * f.height) * 10000) / 10000, method: `${what}, each region only where the photo around it agrees with its mirror (generated)` };
        }
        fs.writeFileSync(path.join(tmp, 'facades.json'), JSON.stringify(fj));
        fs.writeFileSync(path.join(tmp, 'symmetry.json'), JSON.stringify(report));
        if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
        fs.renameSync(tmp, outDir);
        return { orthosDir: outDir, key, report, cached: false, ms: Date.now() - t0 };
    } catch (err) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw err;
    }
}

/** One line for the build's notes. */
export function describeMirrorFill(rep: SymmetryReport): string {
    const fills = rep.fills ?? [];
    const self = fills.reduce((a, f) => a + f.fromMirror, 0), twin = fills.reduce((a, f) => a + f.fromTwins.reduce((b, [, n]) => b + n, 0), 0), unread = fills.reduce((a, f) => a + f.unread, 0);
    const facades = fills.filter(f => f.fromMirror || f.fromTwins.length).length;
    return `mirror fill (${SYMMETRY_VERSION}): ${(self + twin).toLocaleString('en-US')} of ${unread.toLocaleString('en-US')} unread texels on ${facades} facades filled from the symmetry (generated: ${self.toLocaleString('en-US')} from a facade's own mirror, ${twin.toLocaleString('en-US')} from a twin facade), ${fills.reduce((a, f) => a + f.regionsRefused, 0)} regions refused where the photo around them breaks the symmetry; the rest keep the repeat fill`;
}

export const MIRROR_WINDOW_PARAMS = {
    /** A mirrored window confirms a box it overlaps by at least this IoU. */
    confirmIoU: 0.5,
    /** A mirror site is unread when at least this share of it is unread (never reached, occluded, a smear): only there is a window added. */
    unreadShare: 0.5,
    /** An added window may overlap an existing box by at most this share of its own area. */
    maxOverlap: 0.1,
    /** A mirrored window pairs with a box in its row (vertical overlap at least this share of its height) within one box width. */
    rowOverlap: 0.5,
    /** A phase error: at least minPairs pairs on read texels, their median offset at least this share of the median box width and at least minOffsetM (three of the axis's working texels: below that the axis itself is unsure), and this share of them on one side. */
    minPairs: 4, phaseShare: 0.25, minOffsetM: 0.6, sameSide: 0.7,
    /** The halves disagree when at least this share of the reader's mirror sites on read texels hold no box. */
    missingShare: 0.3,
    /**
     * The photo's axis must hold for the windows before they are used across it: at least this share of the reader's mirror
     * sites that the photo read hold a box there (confirmed, or within one box width). Below it the axis is the texture's,
     * not the windows' (a facade frame wider than its window field, a stepped wall): nothing is added and nothing flagged.
     */
    minHolds: 0.5
};

export interface MirrorWindowFacade {
    facadeId: number; axisS: number; axisNcc: number; readerBoxes: number;
    /** Reader boxes whose mirror site holds a box, mirror sites filled (unread, empty: generated), and on read texels: paired with an offset or holding nothing. */
    confirmed: number; added: number; paired: number; missing: number;
    /** Of the reader's mirror sites the photo read, the share holding a box (confirmed or paired): whether the axis holds for the windows (minHolds). */
    holds: number; axisHoldsForWindows: boolean;
    /** A phase error flagged: the median offset (m) of the boxes on one half from the reader's mirrored boxes, or the halves disagreeing. */
    flag?: { kind: 'phase' | 'halves-disagree'; offsetM?: number; pairs: number; missingShare: number; why: string };
}
export interface MirrorWindowReport { version: string; params: typeof MIRROR_WINDOW_PARAMS; facades: MirrorWindowFacade[]; ms: number }

type FitEntryLike = { facadeId: number; width: number; height: number; rects: WindowRect[]; generated?: WindowRect[]; reader?: string; structural?: { rects: WindowRect[] }; mirror?: Record<string, unknown> };

const area = (r: WindowRect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
const inter = (a: WindowRect, b: WindowRect) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const iou = (a: WindowRect, b: WindowRect) => { const i = inter(a, b); return i > 0 ? i / (area(a) + area(b) - i) : 0; };

/**
 * The facade reader's accepted windows used as evidence across each facade's mirror (a facade whose mirror was detected):
 * a reader window whose mirror site holds a box confirms it; a mirror site the photo did not read (never reached,
 * occluded, a smear) and no box stands on gets the mirrored window (generated, labelled with the axis and its NCC); on
 * read texels nothing is added or moved (the mirror never overrides what the photo measured), and where the boxes there
 * sit off the reader's mirrored windows by a steady offset, or are missing from too many mirror sites, the facade is
 * flagged as a reader phase error for review. All of it only where the photo's axis holds for the windows (minHolds):
 * the axis comes from the texture, and on a facade whose frame is wider than its window field it is not the windows'. Edits `fit` in place (the window_fit.json beside the orthos rewritten).
 */
export function mirrorWindows(orthosDir: string, fit: WindowFitFile, rep: SymmetryReport, P = MIRROR_WINDOW_PARAMS): MirrorWindowReport {
    const t0 = Date.now();
    const frames = (JSON.parse(fs.readFileSync(path.join(orthosDir, 'facades.json'), 'utf8')) as { facades: ReliefFacade[] }).facades;
    const out: MirrorWindowFacade[] = [];
    for (const entry of fit.facades) {
        if ('error' in entry) continue;
        const e = entry as FitEntryLike;
        const m = rep.facades.find(x => x.facadeId === e.facadeId);
        const f = frames.find(x => x.facadeId === e.facadeId);
        if (!m?.detected || m.axisS === undefined || !f || f.width !== e.width || f.height !== e.height) continue;
        // the reader's boxes: the merged rects the window fit's own reading does not hold (as window-array.ts reads them)
        const own = new Set((e.structural?.rects ?? []).map(r => r.join(',')));
        const reader = e.reader ? e.rects.filter(r => !own.has(r.join(','))) : [];
        if (!reader.length) continue;
        const N = f.width * f.height, unread = new Uint8Array(N);
        const markFrom = (name: string | undefined, at: number) => {
            if (!name || !fs.existsSync(path.join(orthosDir, name))) return;
            const d = decodePng(fs.readFileSync(path.join(orthosDir, name)));
            if (d.width !== f.width || d.height !== f.height) return;
            const ch = d.rgba.length / N;
            for (let k = 0; k < N; k++) if (d.rgba[k * ch] >= at) unread[k] = 1;
        };
        markFrom(f.uncoveredMask, 128);
        markFrom(f.occludedMask, Math.round(OCCLUSION_PARAMS.minBlocked * 255));
        markFrom(f.image.replace(/\.png$/i, '_featureless.png'), 128);
        const unreadShare = (r: WindowRect) => {
            let n = 0, u = 0;
            for (let y = Math.max(0, Math.floor(r[1])); y < Math.min(f.height, Math.ceil(r[3])); y++) for (let x = Math.max(0, Math.floor(r[0])); x < Math.min(f.width, Math.ceil(r[2])); x++) { n++; u += unread[y * f.width + x]; }
            return n ? u / n : 1;
        };
        const cx = (m.axisS - f.orthoSMin) / f.pixel;
        const rec: MirrorWindowFacade = { facadeId: e.facadeId, axisS: r2(m.axisS), axisNcc: r2(m.ncc!), readerBoxes: reader.length, confirmed: 0, added: 0, paired: 0, missing: 0, holds: 0, axisHoldsForWindows: false };
        const offsets: number[] = [], widths: number[] = [];
        const added: WindowRect[] = [];
        for (const r of reader) {
            const mr: WindowRect = [2 * cx - r[2], r[1], 2 * cx - r[0], r[3]];
            if (mr[0] < 0 || mr[2] > f.width) continue;
            // the box itself, mirrored onto itself (a window on the axis), says nothing
            if (iou(mr, r) >= P.confirmIoU) continue;
            const best = Math.max(0, ...e.rects.map(b => iou(mr, b)));
            if (best >= P.confirmIoU) { rec.confirmed++; continue; }
            if (unreadShare(mr) >= P.unreadShare) {
                const overlap = Math.max(0, ...[...e.rects, ...added].map(b => inter(mr, b))) / Math.max(1e-9, area(mr));
                if (overlap <= P.maxOverlap) { added.push(mr.map(v => Math.round(v * 100) / 100) as WindowRect); rec.added++; }
                continue;
            }
            // on read texels: the box in the mirrored window's row, if any, within one box width
            const w = r[2] - r[0], h = r[3] - r[1];
            widths.push(w);
            let bestDx: number | undefined;
            for (const b of e.rects) {
                const v = Math.max(0, Math.min(mr[3], b[3]) - Math.max(mr[1], b[1]));
                if (v < P.rowOverlap * h) continue;
                const dx = (b[0] + b[2]) / 2 - (mr[0] + mr[2]) / 2;
                if (Math.abs(dx) <= w && (bestDx === undefined || Math.abs(dx) < Math.abs(bestDx))) bestDx = dx;
            }
            if (bestDx === undefined) rec.missing++;
            else { rec.paired++; offsets.push(bestDx); }
        }
        // the axis holds for the windows when most of the reader's read mirror sites hold a box; only then is anything used
        const seen = rec.confirmed + rec.paired + rec.missing;
        rec.holds = seen ? r2((rec.confirmed + rec.paired) / seen) : 0;
        rec.axisHoldsForWindows = seen >= P.minPairs && rec.holds >= P.minHolds;
        if (!rec.axisHoldsForWindows) { rec.added = 0; added.length = 0; }
        if (added.length) {
            e.rects = [...e.rects, ...added];
            e.generated = [...(e.generated ?? []), ...added];
        }
        const onRead = rec.paired + rec.missing;
        const missingShare = onRead ? rec.missing / onRead : 0;
        if (rec.axisHoldsForWindows && offsets.length >= P.minPairs) {
            const sorted = [...offsets].sort((a, b) => a - b), med = sorted[sorted.length >> 1];
            const wMed = [...widths].sort((a, b) => a - b)[widths.length >> 1];
            const side = offsets.filter(d => Math.sign(d) === Math.sign(med) && d !== 0).length / offsets.length;
            if (Math.abs(med) >= P.phaseShare * wMed && Math.abs(med) * f.pixel >= P.minOffsetM && side >= P.sameSide) rec.flag = { kind: 'phase', offsetM: r2(med * f.pixel), pairs: offsets.length, missingShare: r2(missingShare), why: `the boxes on the far half sit ${r2(Math.abs(med) * f.pixel)} m ${med > 0 ? 'right' : 'left'} of the reader's windows mirrored about s = ${r2(m.axisS)} m (median of ${offsets.length}, ${Math.round(side * 100)}% on one side)` };
        }
        if (rec.axisHoldsForWindows && !rec.flag && onRead >= P.minPairs && missingShare >= P.missingShare) rec.flag = { kind: 'halves-disagree', pairs: offsets.length, missingShare: r2(missingShare), why: `${rec.missing} of ${onRead} mirror sites of the reader's windows on read photo hold no box` };
        e.mirror = { version: SYMMETRY_VERSION, axisS: rec.axisS, axisNcc: rec.axisNcc, confirmed: rec.confirmed, holds: rec.holds, axisHoldsForWindows: rec.axisHoldsForWindows, added: added, ...(rec.flag ? { flag: rec.flag } : {}), label: "added windows: generated (the reader's window mirrored about the facade's axis onto a site the photo did not read)" };
        out.push(rec);
    }
    fs.writeFileSync(path.join(orthosDir, WINDOW_FIT_FILE), JSON.stringify(fit));
    return { version: SYMMETRY_VERSION, params: P, facades: out, ms: Date.now() - t0 };
}

/** One line for the build's notes. */
export function describeMirrorWindows(r: MirrorWindowReport): string {
    const sum = (k: 'confirmed' | 'added' | 'paired' | 'missing') => r.facades.reduce((a, f) => a + f[k], 0);
    const flags = r.facades.filter(f => f.flag);
    const held = r.facades.filter(f => f.axisHoldsForWindows).length;
    return `mirror windows (${r.version}): the photo's axis holds for the reader's windows on ${held} of ${r.facades.length} mirror-symmetric facades (the rest left alone); there they confirm ${sum('confirmed')} mirror sites and fill ${sum('added')} the photo did not read (generated); ${flags.length ? `${flags.length} flagged for a reader phase error (${flags.slice(0, 4).map(f => `facade ${f.facadeId}: ${f.flag!.kind}${f.flag!.offsetM !== undefined ? ` ${f.flag!.offsetM} m` : ''}`).join('; ')})` : 'no reader phase error flagged'}; nothing on read photo added or moved`;
}

/** The report without the sweeps (the GLB's asset.extras.sbSymmetry): every reading's score, share and axis. */
export function symmetryExtras(rep: SymmetryReport): Record<string, unknown> {
    const field = (f: FieldSymmetry) => ({ centroid: f.centroid.map(r2), best: { angleDeg: r2(f.best.angleDeg), score: r2(f.best.score), share: r2(f.best.share) }, mirrors: f.mirrors.map(m => ({ angleDeg: r2(m.angleDeg), point: m.point.map(r2), score: r2(m.score), share: r2(m.share) })), rotation: { order: f.rotation.order, score: r2(f.rotation.score) } });
    return {
        schema: 'scratchbox.symmetry-extras/1', version: SYMMETRY_VERSION, frame: rep.frame, label: 'scores read from the scan and the photos; the fills they drove are generated (fills)',
        plan: { massing: field(rep.plan.massing), tiers: rep.plan.tiers.map(t => ({ levelM: r2(t.levelM), ...field(t.outline) })), ...(rep.plan.footprint ? { footprint: field(rep.plan.footprint) } : {}) },
        facades: rep.facades.filter(f => f.read).map(f => ({ facadeId: f.facadeId, axisS: r2(f.axisS!), axisPoint: f.axisPoint!.map(r2), ncc: r2(f.ncc!), share: r2(f.share!), contrast: r2(f.contrast!), periodic: !!f.periodic, detected: !!f.detected })),
        twins: rep.twins.map(t => ({ a: t.a, b: t.b, kind: t.transform.kind, angleDeg: r2(t.transform.angleDeg), centre: t.transform.centre.map(r2), ncc: r2(t.ncc), share: r2(t.share), accepted: t.accepted })),
        ...(rep.fills ? { fills: rep.fills.filter(f => f.fromMirror || f.fromTwins.length).map(f => ({ facadeId: f.facadeId, label: 'generated', fromMirror: f.fromMirror, fromTwins: f.fromTwins, axisS: r2(f.axisS), axisNcc: r2(f.axisNcc), regionsRefused: f.regionsRefused })) } : {})
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
