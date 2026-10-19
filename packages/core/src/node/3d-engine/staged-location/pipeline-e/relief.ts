/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E, the relief stage: measured geometric detail on the clean massing, by averaging the scan along what repeats.
 *
 *   1. Relief maps. For each face (walls, roof planes, modelled facets) the native massing tool already renders the scan's
 *      outermost surface through a slab about the face (`face_<i>.prot`, metres along the normal) and the face's own extent
 *      (`face_<i>.inside`). The map here is that height field, NaN where it is not a measurement of the face: outside the
 *      face, unseen, behind a tree crown or a box an occluder took (the inference's masks), or where the scanned residual
 *      already keeps what stands proud.
 *   2. Averaging (native, scratchbox_relief_average.hpp): rows along s (horizontal bands, robust trimmed mean over 0.5 m
 *      blocks, the profile's uncertainty from their spread), columns along t (vertical elements), and the facade grammar's
 *      lattice (when one was accepted): every opening co-registered and averaged (reveal depth, the projections below, above
 *      and beside it).
 *   3. Geometry. Bands become profiles swept along the wall (mitred round the corners where the next wall shows the same
 *      band), partial ones and vertical elements profiles swept along the face's own axis; lattice units set the openings'
 *      recess depth and add the measured projections at every lattice position.
 *   4. Gates. Each feature: depth >= K_SIGMA standard errors and >= MIN_DEPTH_M from >= MIN_BLOCKS blocks (lines) or
 *      >= MIN_OPENINGS openings (units). The layer: not worse on the photo-match judge than the layer it refines, on the
 *      Street View photos the build has (none of them is used by this stage), when a judge and photos are there.
 *
 * Kept features are labelled "measured by averaging the scan", with their depth and its standard error.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { ProvenanceRecord } from '../../../../common/spatial/staged-location-contracts';
import type { ProjectionView } from '../../../../common/spatial/texture-pass-contracts';
import { compileNativeCached, defaultNativeFlags, NativeBuildError, placeCachedBinary } from '../../native-build-cache';
import { findTileRefineRepoRoot } from '../../tile-refine-service';
import { grammarCells, type FacadeGrammar } from '../facade-grammar';
import { encodePng } from '../png-encode';
import { aggregateRuns, judgeView, renderPng, renderTriangles, type JudgeClient, type JudgeRun } from '../photo-match-eval';
import { readTileTriangles } from '../tile-texture-transfer';
import { renderFrameDepth } from '../../../spatial/StreetViewPoseRegistrar';
import type { RenderMesh3D } from '../../../spatial/HeadlessMeshSilhouetteRenderer';
import { crownMask, type Crown } from './occluders';
import type { FaceSweepItem, Massing, MassingPart, OpeningItem, SweepItem } from './massing-spec';
import type { FaceTexture, TexelSource } from './massing-glb';
import { type MassingFace, type MassingNode, type MassingRun } from './native-massing';
import { plainTextures, runNativeMassing, writeMassingLayer, LOW_COVERAGE, type MassingLayerFiles } from './pipeline-e';

export const RELIEF_VERSION = 'pipeline-e-relief/v1';
/** The label of what this stage measures (AGENTS.md: `measured`, here averaged from the scan along repeats). */
export const MEASURED_AVERAGED_LABEL = 'measured';
/** The label of a typical profile added where the facade clearly has a feature the averages cannot resolve. */
export const GENERATED_LABEL = 'generated';
export const GENERATED_TOKEN = 'generated';
/**
 * Typical depths of a generated feature, each clamped into the scan's evidence bounds [mean - k SE, mean + k SE] of the
 * averaged candidate it stands in for (continuous numbers; the band's height and extent are the candidate's own).
 */
export const TYPICAL_BAND_DEPTH_M = 0.12;
export const TYPICAL_CROWN_DEPTH_M = 0.35;
export const TYPICAL_REVEAL_DEPTH_M = 0.15;
/** A band within this of the face's top is its crowning band (a typical crown projects further). */
export const CROWN_REACH_M = 1.5;
/** The node provenance token of it (no spaces in the native spec). */
export const MEASURED_AVERAGED_TOKEN = 'measured-averaged';

/** A feature is kept when its averaged depth is at least K_SIGMA standard errors... */
export const K_SIGMA = 3;
/** ...and MIN_DEPTH_M... */
export const MIN_DEPTH_M = 0.05;
/** ...and at most MAX_DEPTH_M (deeper stands in front of the wall: the scanned residual keeps what is clearly proud)... */
export const MAX_DEPTH_M = 1.2;
/** ...from at least MIN_BLOCKS blocks of BLOCK_M (a band's length, a vertical element's height)... */
export const MIN_BLOCKS = 6;
export const BLOCK_M = 0.5;
/** ...or at least MIN_OPENINGS openings of one lattice group. */
export const MIN_OPENINGS = 4;

/** The native averaging's parameters (scratchbox_relief_average.hpp Params). */
export const RELIEF_PARAMS = { k: K_SIGMA, block: BLOCK_M, trim: 0.2, minDepth: MIN_DEPTH_M, maxDepth: MAX_DEPTH_M, consistency: 0.7, minBlocks: MIN_BLOCKS, minOpenings: MIN_OPENINGS, margin: 0.5, shift: 0.15, detrendWindow: 4 };

/** The judge the photo-match gate asks first (photo_match_evaluate's default; the chat's fallbacks follow). */
export const RELIEF_GATE_JUDGE = 'gemini-4-argon';

/** SCRATCHBOX_STAGED_PIPELINE_E_RELIEF=0 turns the relief stage off (on by default whenever pipeline E runs). */
export function pipelineERelief(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STAGED_PIPELINE_E_RELIEF !== '0';
}

// ------------------------------------------------------------------------------------------------ the native averaging

export interface LineFeature {
    /** 0: a run of rows (lines along s); 1: a run of columns (lines along t). */
    along: 0 | 1;
    l0: number; l1: number; i0: number; i1: number; fullLength: boolean;
    depth: number; se: number; maxSe: number; blocks: number; agree: number; accepted: boolean; why: string;
    lines: number[]; profile: number[]; profileSe: number[];
}
export interface UnitSide { proposed: boolean; accepted: boolean; why: string; depth: number; se: number; n: number; cross: number[]; offset: number[]; offsetSe: number[]; a0: number; a1: number }
export interface UnitResult {
    group: number; members: number[]; shifts: Array<[number, number]>; nccGain: number; widthM: number; heightM: number;
    pw: number; ph: number; mx: number; my: number; patch: string;
    reveal: UnitSide; below: UnitSide; above: UnitSide; left: UnitSide; right: UnitSide;
}
export interface FaceRelief { index: number; baseline: number; trendRms: number; valid: number; texels: number; bands: LineFeature[]; verticals: LineFeature[]; units: UnitResult[] }
export interface ReliefReport { schema: 'scratchbox.relief-average/1'; params: Record<string, number>; faces: FaceRelief[]; ms: number }

const CLI_SOURCE = path.join('scripts', 'relief_average.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const BINARY = path.join('build', '3d-native', 'relief_average');
let building: Promise<string> | undefined;

/** Builds build/3d-native/relief_average through the native build cache when its sources changed. */
export function ensureReliefBinary(repoRoot = findTileRefineRepoRoot()): Promise<string> {
    if (process.env.SCRATCHBOX_RELIEF_AVERAGE_BIN) return Promise.resolve(process.env.SCRATCHBOX_RELIEF_AVERAGE_BIN);
    building ??= (async () => {
        const bin = path.join(repoRoot, BINARY);
        try {
            const built = await compileNativeCached({ sourcePath: path.join(repoRoot, CLI_SOURCE), includeDirs: [path.join(repoRoot, INCLUDE_DIR)], flags: defaultNativeFlags(), libs: [], name: 'relief_average', timeoutMs: 300_000 });
            placeCachedBinary(built.binaryPath, bin);
            return bin;
        } catch (err) {
            throw new Error(`could not build relief_average: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
        }
    })().finally(() => { building = undefined; });
    return building;
}

export interface ReliefJobFace { face: MassingFace; relief: Float32Array; openings?: Array<{ group: number; x0: number; y0: number; x1: number; y1: number }> }

/** Runs the native averaging on the faces' relief maps; reads its report. */
export async function runReliefAverage(faces: ReliefJobFace[], dir: string, opts: { params?: Partial<typeof RELIEF_PARAMS>; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ReliefReport> {
    const bin = await ensureReliefBinary();
    fs.mkdirSync(dir, { recursive: true });
    const L = ['# scratchbox relief average job v1', `out ${dir}`];
    for (const [k, v] of Object.entries({ ...RELIEF_PARAMS, ...(opts.params ?? {}) })) L.push(`param ${k} ${v}`);
    for (const j of faces) {
        const file = path.join(dir, `relief_${j.face.index}.f32`);
        fs.writeFileSync(file, Buffer.from(j.relief.buffer, j.relief.byteOffset, j.relief.byteLength));
        L.push(`face ${j.face.index} ${j.face.width} ${j.face.height} ${j.face.pixel} ${file}`);
        for (const o of j.openings ?? []) L.push(`opening ${j.face.index} ${o.group} ${o.x0} ${o.y0} ${o.x1} ${o.y1}`);
    }
    const jobFile = path.join(dir, 'job.txt');
    fs.writeFileSync(jobFile, L.join('\n') + '\n');
    const out = await new Promise<string>((resolve, reject) => {
        execFile(bin, [jobFile], { timeout: opts.timeoutMs ?? 120_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, ...(opts.signal ? { signal: opts.signal } : {}) }, (err, stdout) => {
            if (err) {
                let msg = String(stdout || err.message).trim().split('\n').pop() ?? err.message;
                try { msg = JSON.parse(msg).error ?? msg; } catch { /* not JSON */ }
                reject(new Error(`relief_average failed: ${msg}`));
            } else resolve(String(stdout));
        });
    });
    const head = JSON.parse(out.trim().split('\n').pop() ?? '{}');
    if (!head.ok) throw new Error(`relief_average failed: ${head.error ?? 'no answer'}`);
    return JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')) as ReliefReport;
}

// ------------------------------------------------------------------------------------------------ relief maps

const f32 = (file: string) => { const b = fs.readFileSync(file); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

/**
 * A face's relief map: the scan's outermost surface along the normal (the native `.prot`), NaN where it is not a measurement
 * of this face: outside its own polygon, unseen, in `mask` (occluders), behind a measured tree crown, or inside the box of a
 * scanned residual cluster that stands proud of it (kept as scanned already).
 */
export function reliefMap(run: MassingRun, f: MassingFace, opts: { mask?: Uint8Array; crowns?: Crown[] } = {}): { relief: Float32Array; valid: number; masked: { outside: number; occluder: number; crown: number; residual: number } } | undefined {
    const base = path.join(run.dir, `face_${f.index}`);
    if (!fs.existsSync(`${base}.prot`)) return undefined;
    const prot = f32(`${base}.prot`);
    const N = f.width * f.height;
    if (prot.length !== N) return undefined;
    const inside = fs.existsSync(`${base}.inside`) ? new Uint8Array(fs.readFileSync(`${base}.inside`)) : undefined;
    const relief = new Float32Array(N);
    const masked = { outside: 0, occluder: 0, crown: 0, residual: 0 };
    const crown = opts.crowns?.length ? crownMask(f, opts.crowns).mask : undefined;
    // proud residual clusters projected onto the face: their (s, t) box, when they stand within reach in front of it
    const boxes: Array<[number, number, number, number]> = [];
    for (const c of run.report.residual.clusters) {
        if (c.opensFace) continue;
        let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity, h0 = Infinity, h1 = -Infinity;
        for (const x of [c.lo[0], c.hi[0]]) for (const y of [c.lo[1], c.hi[1]]) for (const z of [c.lo[2], c.hi[2]]) {
            const d = [x - f.origin[0], y - f.origin[1], z - f.origin[2]];
            const s = d[0] * f.axisS[0] + d[1] * f.axisS[1] + d[2] * f.axisS[2], t = d[0] * f.axisT[0] + d[1] * f.axisT[1] + d[2] * f.axisT[2], h = d[0] * f.normal[0] + d[1] * f.normal[1] + d[2] * f.normal[2];
            s0 = Math.min(s0, s); s1 = Math.max(s1, s); t0 = Math.min(t0, t); t1 = Math.max(t1, t); h0 = Math.min(h0, h); h1 = Math.max(h1, h);
        }
        if (h1 > 0.3 && h0 < 2.5) boxes.push([s0, s1, t0, t1]);
    }
    let valid = 0;
    for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
        const i = y * f.width + x;
        let v = prot[i];
        if (!Number.isFinite(v)) { relief[i] = NaN; continue; }
        if (inside && !inside[i]) { masked.outside++; v = NaN; }
        else if (opts.mask?.[i]) { masked.occluder++; v = NaN; }
        else if (crown?.[i]) { masked.crown++; v = NaN; }
        else if (boxes.length) {
            const s = f.orthoSMin + (x + 0.5) * f.pixel, t = f.orthoTMax - (y + 0.5) * f.pixel;
            if (boxes.some(b => s >= b[0] && s <= b[1] && t >= b[2] && t <= b[3])) { masked.residual++; v = NaN; }
        }
        relief[i] = v;
        if (Number.isFinite(v)) valid++;
    }
    return { relief, valid, masked };
}

// ------------------------------------------------------------------------------------------------ features to geometry

/** One measured feature, as built (or not) and reported. `role` is a diagnostic description, never branched on. */
export interface ReliefFeature {
    id: string;
    face: number;
    faceKey: string;
    /** The line's axis on the face: s (runs along the face), t (runs up it), or a lattice unit. */
    axis: 's' | 't' | 'unit';
    role: string;
    /** measured (averaged from the scan, passed its gate) or generated (a typical profile in the scan's evidence bounds). */
    label: string;
    accepted: boolean;
    built: boolean;
    why: string;
    depthM: number;
    seM: number;
    samples: number;
    /** The profile as built: [offset, cross] pairs (metres). */
    profile?: Array<[number, number]>;
    extent?: [number, number];
}

export interface ReliefGeometry {
    sweeps: SweepItem[];
    faceSweeps: FaceSweepItem[];
    /** Openings (all of the input's, those on measured lattice units with the measured recess). */
    openings: OpeningItem[];
    features: ReliefFeature[];
    /** Input sweeps a measured band replaced (photo-inferred bands at the same height on the same wall). */
    replacedSweeps: string[];
    /** Per built node id: its provenance record. */
    provenance: Map<string, ProvenanceRecord>;
    /** Per sweep or face sweep id: the features it builds. */
    builds: Map<string, string[]>;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const rowT = (f: MassingFace, y: number) => f.orthoTMax - (y + 0.5) * f.pixel;
const colS = (f: MassingFace, x: number) => f.orthoSMin + (x + 0.5) * f.pixel;

/** Douglas-Peucker on (offset, cross) samples ordered by cross; ends kept. */
export function simplifyProfile(p: Array<[number, number]>, tol = 0.01): Array<[number, number]> {
    if (p.length <= 2) return p.slice();
    const keep = new Uint8Array(p.length);
    keep[0] = keep[p.length - 1] = 1;
    const stack: Array<[number, number]> = [[0, p.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop()!;
        let best = -1, bi = -1;
        const [oa, ca] = p[a], [ob, cb] = p[b];
        for (let i = a + 1; i < b; i++) {
            const u = cb === ca ? 0 : (p[i][1] - ca) / (cb - ca);
            const d = Math.abs(p[i][0] - (oa + u * (ob - oa)));
            if (d > best) { best = d; bi = i; }
        }
        if (best > tol && bi > 0) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
    }
    return p.filter((_, i) => keep[i]);
}

/** A line feature's profile as (offset, cross) pairs at increasing cross (t for rows, s for columns). */
function lineProfile(f: MassingFace, lf: LineFeature): Array<[number, number]> {
    const pts: Array<[number, number]> = lf.lines.map((l, k) => [Math.max(0, lf.profile[k]), lf.along === 0 ? rowT(f, l) : colS(f, l)]);
    pts.sort((a, b) => a[1] - b[1]);
    return pts;
}

/** Resamples (offset, cross) profiles onto one grid and averages them by inverse variance (the chained walls' band). */
function combineProfiles(items: Array<{ profile: Array<[number, number]>; se: number }>, step: number): { profile: Array<[number, number]>; se: number } {
    const lo = Math.min(...items.map(i => i.profile[0][1])), hi = Math.max(...items.map(i => i.profile[i.profile.length - 1][1]));
    const at = (p: Array<[number, number]>, c: number) => {
        if (c < p[0][1] || c > p[p.length - 1][1]) return 0;
        for (let k = 0; k + 1 < p.length; k++) if (c >= p[k][1] && c <= p[k + 1][1]) { const u = p[k + 1][1] === p[k][1] ? 0 : (c - p[k][1]) / (p[k + 1][1] - p[k][1]); return p[k][0] + u * (p[k + 1][0] - p[k][0]); }
        return 0;
    };
    const out: Array<[number, number]> = [];
    let wsum = 0;
    for (const i of items) wsum += 1 / Math.max(1e-6, i.se) ** 2;
    for (let c = lo; c <= hi + 1e-9; c += step) {
        let s = 0;
        for (const i of items) s += at(i.profile, c) / Math.max(1e-6, i.se) ** 2;
        out.push([s / wsum, c]);
    }
    return { profile: out, se: 1 / Math.sqrt(wsum) };
}

function measuredRecord(what: string, depth: number, se: number, samples: number, unit: string, extra = ''): ProvenanceRecord {
    return {
        label: MEASURED_AVERAGED_LABEL, measuredGeometry: true,
        method: `pipeline E relief, measured by averaging the scan along repeats: ${what}, its profile the robust (trimmed) mean of the scan's relief map over ${samples} ${unit}, kept at >= ${K_SIGMA} standard errors and >= ${MIN_DEPTH_M} m from >= ${unit === 'openings' ? MIN_OPENINGS : MIN_BLOCKS} ${unit}`,
        sources: [{ kind: 'tile-extraction', id: 'isolate' }, { kind: 'stage-output', id: 'pipeline-e-relief' }],
        note: `depth ${r3(depth)} m +- ${r3(se)} m (standard error), ${samples} ${unit}${extra}`
    };
}

function generatedRecord(what: string, depth: number, lo: number, hi: number, evidence: string): ProvenanceRecord {
    return {
        label: GENERATED_LABEL, measuredGeometry: false, confidence: 0.5,
        method: `pipeline E relief, generated: ${what}; a typical profile where the facade clearly has the feature and the scan's average is too weak to measure it, its depth clamped into the scan's evidence bounds (mean +- ${K_SIGMA} standard errors)`,
        sources: [{ kind: 'stage-output', id: 'pipeline-e-relief' }],
        note: `depth ${r3(depth)} m, within the scan's bounds ${r3(lo)}-${r3(hi)} m; ${evidence}`
    };
}

/** Bands that overlap in height on consecutive walls of one plan loop are one band, mitred round the corner. */
function sameBand(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
    const a0 = a[0][1], a1 = a[a.length - 1][1], b0 = b[0][1], b1 = b[b.length - 1][1];
    const inter = Math.min(a1, b1) - Math.max(a0, b0), uni = Math.max(a1, b1) - Math.min(a0, b0);
    return uni > 0 && inter / uni >= 0.5;
}

/**
 * The measured features as geometry: bands (wall sweeps, mitred along the walls showing them, or face sweeps when partial),
 * vertical elements (face sweeps along t), lattice units (measured recess on their openings, face sweeps for what projects
 * beside them at every position).
 */
export function reliefGeometry(run: MassingRun, report: ReliefReport, input: {
    sweeps: SweepItem[]; openings: OpeningItem[];
    /** Per face index: the grammar the job's openings came from (cells in grammarCells order). */
    grammars: Map<number, FacadeGrammar>;
    /** Add typical profiles (labelled generated) where the facade clearly has a feature the averages could not resolve. */
    generated?: boolean;
}): ReliefGeometry {
    const faces = run.report.faces;
    const features: ReliefFeature[] = [];
    const sweeps: SweepItem[] = [];
    const faceSweeps: FaceSweepItem[] = [];
    const provenance = new Map<string, ProvenanceRecord>();
    const builds = new Map<string, string[]>();
    const accBands: Array<{ face: MassingFace; lf: LineFeature; profile: Array<[number, number]>; feature: ReliefFeature }> = [];
    for (const fr of report.faces) {
        const f = faces[fr.index];
        if (!f) continue;
        fr.bands.forEach((lf, k) => {
            const profile = lineProfile(f, lf);
            const s0 = Math.max(f.sMin, f.orthoSMin + lf.i0 * f.pixel), s1 = Math.min(f.sMax, f.orthoSMin + lf.i1 * f.pixel);
            const feature: ReliefFeature = { id: `relief_band_${f.index}_${k}`, face: f.index, faceKey: f.key, axis: 's', label: MEASURED_AVERAGED_LABEL, role: `a band ${lf.fullLength ? 'along the whole face' : 'along part of the face'} at ${r3(profile[0][1])}-${r3(profile[profile.length - 1][1])} m`, accepted: lf.accepted, built: false, why: lf.why, depthM: lf.depth, seM: lf.se, samples: lf.blocks, profile: simplifyProfile(profile), extent: [r3(s0), r3(s1)] };
            features.push(feature);
            if (lf.accepted) accBands.push({ face: f, lf, profile, feature });
        });
        fr.verticals.forEach((lf, k) => {
            const profile = lineProfile(f, lf);
            const tTop = Math.min(f.tMax, f.orthoTMax - lf.i0 * f.pixel), tBot = Math.max(f.wall ? f.tBottom : f.tMin, f.orthoTMax - lf.i1 * f.pixel);
            const id = `relief_vert_${f.index}_${k}`;
            const feature: ReliefFeature = { id, face: f.index, faceKey: f.key, axis: 't', label: MEASURED_AVERAGED_LABEL, role: `an element running up the face, ${r3(profile[profile.length - 1][1] - profile[0][1])} m wide, ${r3(tBot)}-${r3(tTop)} m`, accepted: lf.accepted, built: false, why: lf.why, depthM: lf.depth, seM: lf.se, samples: lf.blocks, profile: simplifyProfile(profile), extent: [r3(tBot), r3(tTop)] };
            features.push(feature);
            if (!lf.accepted || tTop - tBot < 2 * BLOCK_M) { if (lf.accepted) feature.why += '; its extent up the face is too short to build'; return; }
            faceSweeps.push({ id, confidence: 1, provenance: MEASURED_AVERAGED_TOKEN, face: f.key, axis: 1, profile: simplifyProfile(profile), placements: [[tBot, tTop, 0]] });
            builds.set(id, [id]);
            provenance.set(`facesweep:${id}`, measuredRecord(`an element running up the face (${feature.role})`, lf.depth, lf.se, lf.blocks, 'blocks'));
            feature.built = true;
        });
    }
    // bands: chains of consecutive walls of one loop showing the same band; partial ones and those on other faces alone
    const used = new Set<number>();
    const loopWalls = (f: MassingFace) => faces.filter(w => w.wall && w.part === f.part && w.loop === f.loop).sort((p, q) => p.edge - q.edge || p.key.localeCompare(q.key));
    const measuredOnFace = new Map<string, Array<[number, number]>>();
    accBands.forEach((a, ai) => {
        if (used.has(ai)) return;
        used.add(ai);
        const keep = (fs_: MassingFace, prof: Array<[number, number]>) => { const l = measuredOnFace.get(fs_.key) ?? []; l.push([prof[0][1], prof[prof.length - 1][1]]); measuredOnFace.set(fs_.key, l); };
        if (!a.face.wall || !a.lf.fullLength) {
            const s0 = a.feature.extent![0], s1 = a.feature.extent![1];
            if (s1 - s0 < 2 * BLOCK_M) { a.feature.why += '; its extent along the face is too short to build'; return; }
            const prof = simplifyProfile(a.profile);
            faceSweeps.push({ id: a.feature.id, confidence: 1, provenance: MEASURED_AVERAGED_TOKEN, face: a.face.key, axis: 0, profile: prof, placements: [[s0, s1, 0]] });
            builds.set(a.feature.id, [a.feature.id]);
            provenance.set(`facesweep:${a.feature.id}`, measuredRecord(`a band along part of a face (${a.feature.role})`, a.lf.depth, a.lf.se, a.lf.blocks, 'blocks'));
            a.feature.built = true;
            keep(a.face, prof);
            return;
        }
        const walls = loopWalls(a.face);
        const n = walls.length;
        const idxOf = (f: MassingFace) => walls.findIndex(w => w.key === f.key);
        const bandOn = (w: MassingFace) => accBands.findIndex((b, bi) => !used.has(bi) && b.face.key === w.key && b.face.wall && b.lf.fullLength && sameBand(b.profile, a.profile));
        const chain = [a];
        // forward, then backward, round the loop
        for (const dir of [1, -1]) {
            let i = idxOf(a.face);
            for (let step = 1; step < n; step++) {
                const w = walls[(i + dir + n) % n];
                const bi = bandOn(w);
                if (bi < 0) break;
                used.add(bi);
                if (dir > 0) chain.push(accBands[bi]); else chain.unshift(accBands[bi]);
                i = (i + dir + n) % n;
            }
        }
        const combined = combineProfiles(chain.map(c => ({ profile: c.profile, se: Math.max(1e-3, c.lf.se) })), a.face.pixel);
        const prof = simplifyProfile(combined.profile);
        // the wall sweep's profile is a closed outline in (offset, y): from the wall at the bottom, out, and back at the top
        const outline: Array<[number, number]> = [[0, prof[0][1]], ...prof.filter(p => p[0] > 0), [0, prof[prof.length - 1][1]]];
        const id = `relief_band_${a.face.index}_chain`;
        const depth = Math.max(...chain.map(c => c.lf.depth)), blocks = chain.reduce((s, c) => s + c.lf.blocks, 0);
        sweeps.push({ id, confidence: 1, provenance: MEASURED_AVERAGED_TOKEN, profile: outline, faces: chain.map(c => c.face.key) });
        builds.set(id, chain.map(c => c.feature.id));
        provenance.set(`sweep:${id}`, measuredRecord(`a band along ${chain.length} wall${chain.length > 1 ? 's, mitred at the corners where the next wall shows it' : ''} (${a.feature.role})`, depth, combined.se, blocks, 'blocks'));
        for (const c of chain) { c.feature.built = true; c.feature.why += chain.length > 1 ? `; swept with ${chain.length - 1} neighbouring wall${chain.length > 2 ? 's' : ''}` : ''; keep(c.face, prof); }
    });
    // the photo-inferred bands at the same height on the same walls are replaced by the measured ones
    const replacedSweeps: string[] = [];
    const keptSweeps = input.sweeps.filter(s => {
        if (s.provenance !== 'photo-inferred' || !s.id.startsWith('band_')) return true;
        const ys = s.profile.map(p => p[1]), y0 = Math.min(...ys), y1 = Math.max(...ys);
        const clash = s.faces.some(k => (measuredOnFace.get(k) ?? []).some(([a0, a1]) => Math.min(a1, y1) - Math.max(a0, y0) > 0));
        if (clash) replacedSweeps.push(s.id);
        return !clash;
    });
    // lattice units
    const openings = input.openings.map(o => ({ ...o }));
    for (const fr of report.faces) {
        const f = faces[fr.index], g = input.grammars.get(fr.index);
        if (!f || !g) continue;
        const cells = grammarCells(g);
        for (const u of fr.units) {
            const members = u.members.map(m => ({ m, c: cells[m] })).filter(x => !!x.c);
            const base = `relief_unit_${f.index}_${u.group}`;
            const unitRole = `${members.length} openings ${r3(u.widthM)} x ${r3(u.heightM)} m`;
            // the reveal: every opening of the group recessed by the measured depth
            const rv = u.reveal;
            const rf: ReliefFeature = { id: `${base}_reveal`, face: f.index, faceKey: f.key, axis: 'unit', label: MEASURED_AVERAGED_LABEL, role: `the reveal of ${unitRole}`, accepted: rv.accepted, built: false, why: rv.why, depthM: rv.depth, seM: rv.se, samples: rv.n };
            features.push(rf);
            if (rv.accepted) {
                let changed = 0;
                for (const { m, c } of members) {
                    const id = `win_${f.index}_${m}`;
                    const o = openings.find(x => x.id === id) ?? openings.find(x => x.face === f.key && Math.abs(x.s0 - c.s0) < 1e-6 && Math.abs(x.t0 - c.t0) < 1e-6 && Math.abs(x.s1 - c.s1) < 1e-6 && Math.abs(x.t1 - c.t1) < 1e-6);
                    if (o) {
                        o.depth = Math.min(1.2, Math.max(MIN_DEPTH_M, rv.depth)); o.provenance = MEASURED_AVERAGED_TOKEN; o.confidence = 1; changed++;
                        provenance.set(`opening:${o.id}`, measuredRecord(`the reveal of ${unitRole}: the lattice's openings co-registered and their scan relief averaged`, rv.depth, rv.se, rv.n, 'openings'));
                    } else {
                        const id2 = `${base}_o${m}`;
                        openings.push({ id: id2, face: f.key, s0: c.s0, s1: c.s1, t0: c.t0, t1: c.t1, depth: Math.min(1.2, Math.max(MIN_DEPTH_M, rv.depth)), scanned: false, confidence: 1, provenance: MEASURED_AVERAGED_TOKEN });
                        provenance.set(`opening:${id2}`, measuredRecord(`the reveal of ${unitRole}: the lattice's openings co-registered and their scan relief averaged`, rv.depth, rv.se, rv.n, 'openings'));
                        changed++;
                    }
                }
                rf.built = changed > 0;
            }
            // what projects beside the openings, at every position of the group
            const sides: Array<{ key: 'below' | 'above' | 'left' | 'right'; axis: 0 | 1; sign: number }> = [{ key: 'below', axis: 0, sign: -1 }, { key: 'above', axis: 0, sign: 1 }, { key: 'left', axis: 1, sign: -1 }, { key: 'right', axis: 1, sign: 1 }];
            for (const sd of sides) {
                const u2 = u[sd.key];
                if (!u2.proposed) continue;
                const id = `${base}_${sd.key}`;
                const feat: ReliefFeature = { id, face: f.index, faceKey: f.key, axis: 'unit', label: MEASURED_AVERAGED_LABEL, role: `the projection ${sd.key === 'below' || sd.key === 'above' ? sd.key : `to the ${sd.key} of`} ${unitRole}`, accepted: u2.accepted, built: false, why: u2.why, depthM: u2.depth, seM: u2.se, samples: u2.n };
                features.push(feat);
                if (!u2.accepted) continue;
                // profile in (offset, cross relative to the edge) at increasing cross
                const prof: Array<[number, number]> = u2.cross.map((c, k) => [Math.max(0, u2.offset[k]), sd.sign * c] as [number, number]).sort((p, q) => p[1] - q[1]);
                feat.profile = simplifyProfile(prof);
                const placements: Array<[number, number, number]> = members.map(({ c }) => sd.axis === 0
                    ? [c.s0 + u2.a0, c.s1 + u2.a1, sd.key === 'below' ? c.t0 : c.t1]
                    // along t: a0 is metres below the top edge (t1), a1 metres below the bottom edge (t0)
                    : [c.t0 - u2.a1, c.t1 - u2.a0, sd.key === 'left' ? c.s0 : c.s1]);
                faceSweeps.push({ id, confidence: 1, provenance: MEASURED_AVERAGED_TOKEN, face: f.key, axis: sd.axis, profile: feat.profile, placements });
                builds.set(id, [id]);
                provenance.set(`facesweep:${id}`, measuredRecord(feat.role, u2.depth, u2.se, u2.n, 'openings'));
                feat.built = true;
            }
        }
    }
    if (input.generated) addGenerated();
    return { sweeps: [...keptSweeps, ...sweeps], faceSweeps, openings, features, replacedSweeps, provenance, builds };

    /**
     * Generated, where the facade clearly has the feature and the scan's average is too weak to measure it:
     *  - a band: a candidate the averaging proposed (standing out, its blocks mostly agreeing) but refused only for its
     *    standard error or its block count, that the facade's own evidence places: at a wall's top (a crowning band) or
     *    at a storey line of the accepted grammar (within 0.6 m of a tier's top or bottom);
     *  - a reveal: a lattice group whose averaged recess was refused, the grammar having read the openings.
     * Its depth is the typical one clamped into the candidate's evidence bounds [mean - k SE, mean + k SE]; none when the
     * upper bound is under MIN_DEPTH_M (the scan says it does not stand out). Profiles: a sloped underside and a flat
     * front for a band; a plain recess for a reveal.
     */
    function addGenerated(): void {
        for (const fr of report.faces) {
            const f = faces[fr.index];
            if (!f) continue;
            const g = input.grammars.get(fr.index);
            const storeyLines = g ? g.tiers.flatMap(t => [t.t0, t.t1]) : [];
            fr.bands.forEach((lf, k) => {
                if (lf.accepted || !(lf.depth > 0) || lf.agree < 0.6 || lf.depth > RELIEF_PARAMS.maxDepth) return;
                const weakOnly = lf.depth < K_SIGMA * lf.se || lf.blocks < MIN_BLOCKS;
                if (!weakOnly) return;
                const t0 = rowT(f, lf.l1) - f.pixel / 2, t1 = rowT(f, lf.l0) + f.pixel / 2;
                // a crowning band is the top of a wall (the top of a modelled volume's facet is not the building's crown)
                const crown = f.wall && f.tMax - t1 <= CROWN_REACH_M;
                const storey = storeyLines.some(y => Math.abs(y - t0) <= 0.6 || Math.abs(y - t1) <= 0.6);
                if (!crown && !storey) return;
                const lo = Math.max(0, lf.depth - K_SIGMA * lf.se), hi = lf.depth + K_SIGMA * lf.se;
                const id = `relief_gen_band_${f.index}_${k}`;
                const feature: ReliefFeature = { id, face: f.index, faceKey: f.key, axis: 's', label: GENERATED_LABEL, role: `a ${crown ? 'crowning band' : 'band at a storey line'} at ${r3(t0)}-${r3(t1)} m (typical profile)`, accepted: false, built: false, why: lf.why, depthM: 0, seM: lf.se, samples: lf.blocks };
                features.push(feature);
                if (hi < MIN_DEPTH_M) { feature.why += '; generated: not added, the scan bounds it under the least depth'; return; }
                const depth = Math.min(hi, Math.max(lo, MIN_DEPTH_M, crown ? TYPICAL_CROWN_DEPTH_M : TYPICAL_BAND_DEPTH_M));
                const h = Math.max(0.2, t1 - t0), slope = Math.min(0.35 * h, depth);
                const s0 = Math.max(f.sMin, f.orthoSMin + lf.i0 * f.pixel), s1 = Math.min(f.sMax, f.orthoSMin + lf.i1 * f.pixel);
                const ext: [number, number] = lf.fullLength || s1 - s0 < 2 * BLOCK_M ? [f.sMin, f.sMax] : [s0, s1];
                const tb = (t0 + t1) / 2 - h / 2;
                const profile: Array<[number, number]> = [[0, tb], [depth, tb + slope], [depth, tb + h - 1e-3], [0, tb + h]];
                faceSweeps.push({ id, confidence: 0.5, provenance: GENERATED_TOKEN, face: f.key, axis: 0, profile, placements: [[ext[0], ext[1], 0]] });
                builds.set(id, [id]);
                provenance.set(`facesweep:${id}`, generatedRecord(feature.role, depth, lo, hi, `the averaged candidate stood ${r3(lf.depth)} m +- ${r3(lf.se)} m out over ${lf.blocks} blocks`));
                Object.assign(feature, { accepted: true, built: true, depthM: depth, profile, extent: [r3(ext[0]), r3(ext[1])] });
                feature.why += `; generated: typical profile ${r3(depth)} m deep within the scan's bounds ${r3(lo)}-${r3(hi)} m`;
            });
            if (!g) continue;
            const cells = grammarCells(g);
            for (const u of fr.units) {
                const rv = u.reveal;
                if (rv.accepted || !Number.isFinite(rv.depth)) continue;
                const lo = Math.max(0, rv.depth - K_SIGMA * (Number.isFinite(rv.se) ? rv.se : 0.1)), hi = rv.depth + K_SIGMA * (Number.isFinite(rv.se) ? rv.se : 0.1);
                const id = `relief_gen_unit_${f.index}_${u.group}_reveal`;
                const feature: ReliefFeature = { id, face: f.index, faceKey: f.key, axis: 'unit', label: GENERATED_LABEL, role: `the reveal of ${u.members.length} openings ${r3(u.widthM)} x ${r3(u.heightM)} m (typical depth)`, accepted: false, built: false, why: rv.why, depthM: 0, seM: rv.se, samples: rv.n };
                features.push(feature);
                if (hi < MIN_DEPTH_M) { feature.why += '; generated: not added, the scan bounds the recess under the least depth'; continue; }
                const depth = Math.min(hi, Math.max(lo, MIN_DEPTH_M, TYPICAL_REVEAL_DEPTH_M));
                let changed = 0;
                for (const m of u.members) {
                    const c = cells[m];
                    const o = c && (openings.find(x => x.id === `win_${f.index}_${m}`) ?? openings.find(x => x.face === f.key && Math.abs(x.s0 - c.s0) < 1e-6 && Math.abs(x.t0 - c.t0) < 1e-6));
                    if (!o) continue;
                    o.depth = depth; o.provenance = GENERATED_TOKEN; o.confidence = 0.5; changed++;
                    provenance.set(`opening:${o.id}`, generatedRecord(feature.role, depth, lo, hi, `the averaged recess was ${r3(rv.depth)} m +- ${r3(rv.se)} m over ${rv.n} openings`));
                }
                if (changed) { Object.assign(feature, { accepted: true, built: true, depthM: depth }); feature.why += `; generated: typical recess ${r3(depth)} m within the scan's bounds ${r3(lo)}-${r3(hi)} m on ${changed} openings`; }
            }
        }
    }
}

/**
 * The geometry onto the faces of the solid it is built on. The relief is measured on the first run's faces; the layer it
 * refines may have split a wall where a part was added (an inferred roof block): the split faces keep the plane and get
 * keys `<key>:<k>`, each with its own origin along the wall. Measured sweeps, face sweeps and openings on such a wall are
 * moved onto the pieces (s and t shifted by the piece's origin, clipped to its extent).
 */
export function retargetGeometry(g: ReliefGeometry, from: MassingFace[], to: MassingFace[]): ReliefGeometry {
    const toKeys = new Set(to.map(f => f.key));
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cache = new Map<string, Array<{ f: MassingFace; ds: number; dt: number }> | undefined>();
    const pieces = (key: string) => {
        if (toKeys.has(key)) return undefined;
        if (cache.has(key)) return cache.get(key);
        const f1 = from.find(f => f.key === key);
        const out = !f1 ? [] : to.filter(f => f.key.startsWith(`${key}:`) && dot(f.normal, f1.normal) > 0.999 && Math.abs(dot([f.origin[0] - f1.origin[0], f.origin[1] - f1.origin[1], f.origin[2] - f1.origin[2]], f1.normal)) < 0.01)
            .map(f => { const d = [f.origin[0] - f1.origin[0], f.origin[1] - f1.origin[1], f.origin[2] - f1.origin[2]]; return { f, ds: dot(d, f1.axisS), dt: dot(d, f1.axisT) }; })
            .sort((a, b) => a.ds + a.f.sMin - (b.ds + b.f.sMin));
        cache.set(key, out);
        return out;
    };
    const measured = (prov: string) => prov === MEASURED_AVERAGED_TOKEN || prov === GENERATED_TOKEN;
    const sweeps = g.sweeps.map(sw => !measured(sw.provenance) ? sw : { ...sw, faces: sw.faces.flatMap(k => pieces(k)?.map(p => p.f.key) ?? [k]) });
    const faceSweeps: FaceSweepItem[] = [];
    for (const fs_ of g.faceSweeps) {
        const ps = pieces(fs_.face);
        if (!ps) { faceSweeps.push(fs_); continue; }
        const cMid = (fs_.profile[0][1] + fs_.profile[fs_.profile.length - 1][1]) / 2;
        ps.forEach((p, k) => {
            const placements: Array<[number, number, number]> = [];
            for (const [a0, a1, dc] of fs_.placements) {
                if (fs_.axis === 0) {
                    const b0 = Math.max(a0 - p.ds, p.f.sMin), b1 = Math.min(a1 - p.ds, p.f.sMax);
                    if (b1 - b0 >= 0.2) placements.push([b0, b1, dc - p.dt]);
                } else {
                    const s = cMid + dc - p.ds;
                    if (s >= p.f.sMin && s <= p.f.sMax) placements.push([a0 - p.dt, a1 - p.dt, dc - p.ds]);
                }
            }
            if (!placements.length) return;
            const id = `${fs_.id}_p${k}`;
            faceSweeps.push({ ...fs_, id, face: p.f.key, placements });
            const rec = g.provenance.get(`facesweep:${fs_.id}`);
            if (rec) g.provenance.set(`facesweep:${id}`, rec);
            g.builds.set(id, g.builds.get(fs_.id) ?? []);
        });
    }
    const openings = g.openings.map(o => {
        const ps = measured(o.provenance) ? pieces(o.face) : undefined;
        if (!ps) return o;
        const sm = (o.s0 + o.s1) / 2;
        const p = ps.find(q => sm - q.ds >= q.f.sMin && sm - q.ds <= q.f.sMax);
        return p ? { ...o, face: p.f.key, s0: o.s0 - p.ds, s1: o.s1 - p.ds, t0: o.t0 - p.dt, t1: o.t1 - p.dt } : o;
    });
    return { ...g, sweeps, faceSweeps, openings };
}

// ------------------------------------------------------------------------------------------------ the photo-match gate

export interface PhotoGateArm { id: string; glb: string }
export interface PhotoGateResult {
    ran: boolean;
    why: string;
    views: number;
    repeats: number;
    /** Per arm: mean judge scores per criterion over views and runs. */
    scores?: Record<string, Record<string, number>>;
    perView?: Array<{ panoId: string; overall: Record<string, number> }>;
}

/**
 * The layer gate: each arm (the layer refined first, then the candidates) rendered from each Street View photo's registered
 * camera (what stands in front in the full tile hides all alike) and judged blind against the photo, shuffled
 * (photo-match-eval.ts judgeView). The caller decides from the scores.
 */
export async function photoMatchGate(input: {
    views: ProjectionView[]; arms: PhotoGateArm[]; judge: JudgeClient; place: string;
    occluder?: RenderMesh3D; repeats?: number; maxViews?: number; dir?: string; signal?: AbortSignal;
}): Promise<PhotoGateResult> {
    const repeats = input.repeats ?? 3;
    const views = input.views.filter(v => v.poseQuality > 0).slice(0, input.maxViews ?? 4);
    if (!views.length) return { ran: false, why: 'no registered Street View photo to judge against', views: 0, repeats };
    const meshes = input.arms.map(a => [readTileTriangles(fs.readFileSync(a.glb))]);
    const ids = input.arms.map(a => a.id);
    const runsAll: JudgeRun[] = [];
    const perView: NonNullable<PhotoGateResult['perView']> = [];
    await Promise.all(views.map(async (v, k) => {
        const occ = input.occluder ? renderFrameDepth(input.occluder, v.camera as never) : undefined;
        const pngs = meshes.map(m => renderPng(renderTriangles(m, v.camera, occ ? { occluderDepth: occ } : {})));
        const photo = encodePng(v.image.width, v.image.height, Buffer.from(v.image.rgba), 4);
        if (input.dir) {
            fs.mkdirSync(input.dir, { recursive: true });
            pngs.forEach((p, i) => fs.writeFileSync(path.join(input.dir!, `gate_${k}_${ids[i]}.png`), p));
        }
        if (input.signal?.aborted) throw new Error('aborted');
        const runs = await judgeView({ client: input.judge, place: input.place, photo: { bytes: photo, mimeType: 'image/png' }, renders: pngs.map((png, i) => ({ armId: ids[i], png })), repeats, seed: `relief-gate:${v.panoId}:${k}` });
        runsAll.push(...runs);
        const st = aggregateRuns(runs, ids);
        perView.push({ panoId: v.panoId, overall: Object.fromEntries(ids.map(id => [id, st[id].overall.mean])) });
    }));
    const agg = aggregateRuns(runsAll, ids);
    const scores = Object.fromEntries(ids.map(id => [id, Object.fromEntries(Object.entries(agg[id]).map(([c, x]) => [c, x.mean]))]));
    return { ran: true, why: `${views.length} photos x ${repeats} blind runs: ${ids.map(id => `${id} overall ${scores[id].overall}, shape ${scores[id].shape}, detail ${scores[id].detail}`).join('; ')}`, views: views.length, repeats, scores, perView };
}

/**
 * The decisions from the gate's scores. Overall (does it look like this place) and shape stand for identity; detail and
 * errors for realism. The measured layer is kept unless its overall falls below the layer it refines; the generated
 * additions are kept only when they lower neither overall nor shape against what they would be added to (identity), and
 * do not lower detail (realism).
 */
export function gateDecision(g: PhotoGateResult, base: string, measured: string, generated?: string): { measured: boolean; generated: boolean; why: string } {
    if (!g.ran || !g.scores) return { measured: true, generated: !!generated, why: `photo-match gate not run: ${g.why}` };
    const sc = g.scores;
    const m = sc[measured].overall >= sc[base].overall;
    const ref = m ? measured : base;
    const gen = !!generated && sc[generated].overall >= sc[ref].overall && sc[generated].shape >= sc[ref].shape && sc[generated].detail >= sc[ref].detail;
    return { measured: m, generated: gen, why: `photo-match gate (${g.why}): measured ${m ? 'kept' : 'not kept (lower overall)'}${generated ? `, generated ${gen ? 'kept' : 'not kept (lowers identity or realism)'}` : ''}` };
}

// ------------------------------------------------------------------------------------------------ the stage

export interface ReliefStageInput {
    massing: Pick<Massing, 'parts' | 'meshes' | 'check'>;
    /** The first native run (walls on the scanned facades): its relief maps are measured. */
    run: MassingRun;
    /** What the layer it refines was built from (the inference's, or the clean massing's snapped parts). */
    build: { parts: MassingPart[]; sweeps: SweepItem[]; openings: OpeningItem[] };
    /** That layer's run and textures (by its face index) and legend, reframed onto the relief layer's faces. */
    base: { run: MassingRun; textures: Map<number, FaceTexture>; legend: TexelSource[] };
    grammars: FacadeGrammar[];
    occluderMasks?: Map<number, Uint8Array>;
    crowns?: Crown[];
    tilePath: string;
    isolateGlb: string;
    dir: string;
    stage: string;
    stageKey: string;
    signal?: AbortSignal;
    onProgress?: (m: string) => void;
}

export interface ReliefCounts { proposed: number; accepted: number; built: number }
export interface ReliefOutcome {
    files: MassingLayerFiles;
    run: MassingRun;
    report: ReliefReport;
    geometry: ReliefGeometry;
    counts: { bands: ReliefCounts; verticals: ReliefCounts; reveals: ReliefCounts; projections: ReliefCounts };
    maps: Array<{ face: number; key: string; valid: number; masked: { outside: number; occluder: number; crown: number; residual: number } }>;
    timingsMs: Record<string, number>;
    /** The measured layer with the generated profiles added (labelled generated), when any was added. */
    generated?: { files: MassingLayerFiles; run: MassingRun; geometry: ReliefGeometry; counts: { bands: ReliefCounts; reveals: ReliefCounts } };
}

/** Reframes a texture from face `a`'s ortho frame to face `b`'s (same key), nearest by (s, t). */
function reframeTexture(t: FaceTexture, a: MassingFace, b: MassingFace): FaceTexture {
    if (a.width === b.width && a.height === b.height && Math.abs(a.orthoSMin - b.orthoSMin) < 1e-6 && Math.abs(a.orthoTMax - b.orthoTMax) < 1e-6 && a.pixel === b.pixel) return t;
    const out: FaceTexture = { width: b.width, height: b.height, rgba: new Uint8Array(b.width * b.height * 4), source: new Uint8Array(b.width * b.height).fill(255) };
    for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
        const xa = Math.min(a.width - 1, Math.max(0, Math.floor((b.orthoSMin + (x + 0.5) * b.pixel - a.orthoSMin) / a.pixel)));
        const ya = Math.min(a.height - 1, Math.max(0, Math.floor((a.orthoTMax - (b.orthoTMax - (y + 0.5) * b.pixel)) / a.pixel)));
        const i = y * b.width + x, j = ya * a.width + xa;
        out.rgba.set(t.rgba.subarray(j * 4, j * 4 + 4), i * 4);
        out.source[i] = t.source[j];
    }
    return out;
}

export function countFeatures(features: ReliefFeature[], pick: (f: ReliefFeature) => boolean): ReliefCounts {
    const fs_ = features.filter(pick);
    return { proposed: fs_.length, accepted: fs_.filter(f => f.accepted).length, built: fs_.filter(f => f.built).length };
}

export async function runReliefStage(input: ReliefStageInput): Promise<ReliefOutcome> {
    const timingsMs: Record<string, number> = {};
    const progress = (m: string) => input.onProgress?.(`pipeline E relief: ${m}`);
    fs.mkdirSync(input.dir, { recursive: true });
    let t = Date.now();
    // 1. relief maps of every face the tile sees (walls and roof planes and facets alike)
    const faces = input.run.report.faces.filter(f => f.width > 0 && f.kind !== 'base' && f.coverage >= LOW_COVERAGE);
    const grammarOf = new Map<number, FacadeGrammar>(input.grammars.map(g => [g.facadeId, g]));
    const job: ReliefJobFace[] = [];
    const maps: ReliefOutcome['maps'] = [];
    for (const f of faces) {
        const m = reliefMap(input.run, f, { ...(input.occluderMasks?.get(f.index) ? { mask: input.occluderMasks.get(f.index)! } : {}), ...(input.crowns ? { crowns: input.crowns } : {}) });
        if (!m || m.valid < 200) continue;
        maps.push({ face: f.index, key: f.key, valid: m.valid, masked: m.masked });
        const g = grammarOf.get(f.index);
        const openings = g ? grammarCells(g).map(c => ({ group: 0, x0: (c.s0 - f.orthoSMin) / f.pixel, x1: (c.s1 - f.orthoSMin) / f.pixel, y0: (f.orthoTMax - c.t1) / f.pixel, y1: (f.orthoTMax - c.t0) / f.pixel })) : undefined;
        job.push({ face: f, relief: m.relief, ...(openings ? { openings } : {}) });
    }
    timingsMs.maps = Date.now() - t;
    progress(`${job.length} relief maps (${job.filter(j => j.openings).length} with a window lattice); averaging along their repeats`);
    t = Date.now();
    const report = await runReliefAverage(job, path.join(input.dir, 'average'), { ...(input.signal ? { signal: input.signal } : {}) });
    timingsMs.average = Date.now() - t;
    // 2. features to geometry
    const geometry = retargetGeometry(reliefGeometry(input.run, report, { sweeps: input.build.sweeps, openings: input.build.openings, grammars: grammarOf }), input.run.report.faces, input.base.run.report.faces);
    const counts = {
        bands: countFeatures(geometry.features, f => f.axis === 's'),
        verticals: countFeatures(geometry.features, f => f.axis === 't'),
        reveals: countFeatures(geometry.features, f => f.axis === 'unit' && f.id.endsWith('_reveal')),
        projections: countFeatures(geometry.features, f => f.axis === 'unit' && !f.id.endsWith('_reveal'))
    };
    progress(`kept: bands ${counts.bands.accepted} of ${counts.bands.proposed}, vertical elements ${counts.verticals.accepted} of ${counts.verticals.proposed}, window reveals ${counts.reveals.accepted} of ${counts.reveals.proposed}, projections beside openings ${counts.projections.accepted} of ${counts.projections.proposed}`);
    // 3. the solid again with them: the measured layer, and (when any was added) the measured layer with the generated
    const built = await buildLayer(geometry, 'native', 'massing_relief');
    const genGeometry = retargetGeometry(reliefGeometry(input.run, report, { sweeps: input.build.sweeps, openings: input.build.openings, grammars: grammarOf, generated: true }), input.run.report.faces, input.base.run.report.faces);
    const genFeatures = genGeometry.features.filter(f => f.label === GENERATED_LABEL);
    let generated: ReliefOutcome['generated'];
    if (genFeatures.some(f => f.built)) {
        progress(`generated: ${genFeatures.filter(f => f.built).length} typical profiles where the facade clearly has the feature and the scan's average is too weak`);
        const g = await buildLayer(genGeometry, 'native_generated', 'massing_relief_generated');
        generated = { files: g.files, run: g.run, geometry: genGeometry, counts: { bands: countFeatures(genFeatures, f => f.axis === 's'), reveals: countFeatures(genFeatures, f => f.axis === 'unit') } };
    }
    fs.writeFileSync(path.join(input.dir, 'relief.json'), JSON.stringify({ version: RELIEF_VERSION, params: RELIEF_PARAMS, counts, features: geometry.features, generated: genFeatures, replacedSweeps: geometry.replacedSweeps, maps, timingsMs, nativeMs: report.ms }, null, 1));
    // diagnostics: per face with a kept feature, its relief map (blue in, red out of the wall's line)
    try {
        for (const fr of report.faces) {
            if (!geometry.features.some(x => x.face === fr.index && x.accepted)) continue;
            const j = job.find(x => x.face.index === fr.index)!;
            const W = j.face.width, H = j.face.height, rgb = new Uint8Array(W * H * 3);
            for (let i = 0; i < W * H; i++) {
                const v = j.relief[i] - fr.baseline;
                if (!Number.isFinite(v)) { rgb.set([60, 60, 60], i * 3); continue; }
                const a = Math.max(-1, Math.min(1, v / 0.5));
                rgb.set(a >= 0 ? [Math.round(235 - 40 * (1 - a)), Math.round(235 * (1 - a)), Math.round(235 * (1 - a))] : [Math.round(235 * (1 + a)), Math.round(235 * (1 + a)), 235], i * 3);
            }
            fs.writeFileSync(path.join(input.dir, `relief_map_${fr.index}.png`), encodePng(W, H, Buffer.from(rgb), 3));
        }
    } catch { /* diagnostics only */ }
    return { files: built.files, run: built.run, report, geometry, counts, maps, timingsMs, ...(generated ? { generated } : {}) };

    async function buildLayer(geom: ReliefGeometry, sub: string, name: string): Promise<{ files: MassingLayerFiles; run: MassingRun }> {
        let t2 = Date.now();
        const run2 = await runNativeMassing({ parts: input.build.parts, meshes: input.massing.meshes }, {
            tilePath: input.tilePath, isolateGlb: input.isolateGlb, dir: path.join(input.dir, sub), sweeps: geom.sweeps, openings: geom.openings, faceSweeps: geom.faceSweeps,
            params: { snapMaxM: 0, sections: 0, topdown: 0 }, ...(input.signal ? { signal: input.signal } : {})
        });
        timingsMs[sub] = Date.now() - t2;
        for (const id of run2.report.rejectedSweeps) for (const fid of geom.builds.get(id) ?? []) {
            const feat = geom.features.find(f => f.id === fid);
            if (feat) { feat.built = false; feat.why += '; the native tool found no face for it'; }
        }
        // a recess whose opening did not fit its wall (or found no wall) is not built; a unit none of whose openings was
        // built is not either
        const dropped = new Set(run2.report.rejectedOpenings);
        for (const id of dropped) geom.provenance.delete(`opening:${id}`);
        for (const f of geom.features) if (f.id.endsWith('_reveal') && f.built) {
            const token = f.label === GENERATED_LABEL ? GENERATED_TOKEN : MEASURED_AVERAGED_TOKEN;
            const own = geom.openings.filter(o => o.provenance === token && (o.face === f.faceKey || o.face.startsWith(`${f.faceKey}:`)));
            if (own.length && own.every(o => dropped.has(o.id))) { f.built = false; f.why += '; none of its openings fits its wall in this solid'; }
        }
        // textures: the refined layer's, onto the new faces
        t2 = Date.now();
        const textures = new Map<number, FaceTexture>();
        const plain = plainTextures(run2).textures;
        for (const f2 of run2.report.faces) {
            const f1 = input.base.run.report.faces.find(f => f.key === f2.key);
            const t1 = f1 ? input.base.textures.get(f1.index) : undefined;
            if (t1 && f1 && f2.width) textures.set(f2.index, reframeTexture(t1, f1, f2));
            else if (plain.has(f2.index)) textures.set(f2.index, plain.get(f2.index)!);
        }
        const files = writeMassingLayer(run2, input.massing, textures, input.base.legend, input.dir, input.stage, input.stageKey, name, (n: MassingNode) => geom.provenance.get(n.name));
        timingsMs[`${sub}_glb`] = Date.now() - t2;
        return { files, run: run2 };
    }
}
