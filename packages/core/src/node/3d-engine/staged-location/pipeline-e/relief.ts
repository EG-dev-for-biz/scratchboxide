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
/** The label of what this stage keeps. */
export const MEASURED_AVERAGED_LABEL = 'measured by averaging the scan';
/** The node provenance token of it (no spaces in the native spec). */
export const MEASURED_AVERAGED_TOKEN = 'measured-averaged';

/** A feature is kept when its averaged depth is at least K_SIGMA standard errors... */
export const K_SIGMA = 3;
/** ...and MIN_DEPTH_M... */
export const MIN_DEPTH_M = 0.05;
/** ...from at least MIN_BLOCKS blocks of BLOCK_M (a band's length, a vertical element's height)... */
export const MIN_BLOCKS = 6;
export const BLOCK_M = 0.5;
/** ...or at least MIN_OPENINGS openings of one lattice group. */
export const MIN_OPENINGS = 4;

/** The native averaging's parameters (scratchbox_relief_average.hpp Params). */
export const RELIEF_PARAMS = { k: K_SIGMA, block: BLOCK_M, trim: 0.2, minDepth: MIN_DEPTH_M, consistency: 0.7, minBlocks: MIN_BLOCKS, minOpenings: MIN_OPENINGS, margin: 0.5, shift: 0.15, detrendWindow: 4 };

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
        method: `pipeline E relief: ${what}, its profile the robust (trimmed) mean of the scan's relief map over ${samples} ${unit}, kept at >= ${K_SIGMA} standard errors and >= ${MIN_DEPTH_M} m from >= ${unit === 'openings' ? MIN_OPENINGS : MIN_BLOCKS} ${unit}`,
        sources: [{ kind: 'tile-extraction', id: 'isolate' }, { kind: 'stage-output', id: 'pipeline-e-relief' }],
        note: `depth ${r3(depth)} m +- ${r3(se)} m (standard error), ${samples} ${unit}${extra}`
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
            const feature: ReliefFeature = { id: `relief_band_${f.index}_${k}`, face: f.index, faceKey: f.key, axis: 's', role: `a band ${lf.fullLength ? 'along the whole face' : 'along part of the face'} at ${r3(profile[0][1])}-${r3(profile[profile.length - 1][1])} m`, accepted: lf.accepted, built: false, why: lf.why, depthM: lf.depth, seM: lf.se, samples: lf.blocks, profile: simplifyProfile(profile), extent: [r3(s0), r3(s1)] };
            features.push(feature);
            if (lf.accepted) accBands.push({ face: f, lf, profile, feature });
        });
        fr.verticals.forEach((lf, k) => {
            const profile = lineProfile(f, lf);
            const tTop = Math.min(f.tMax, f.orthoTMax - lf.i0 * f.pixel), tBot = Math.max(f.wall ? f.tBottom : f.tMin, f.orthoTMax - lf.i1 * f.pixel);
            const id = `relief_vert_${f.index}_${k}`;
            const feature: ReliefFeature = { id, face: f.index, faceKey: f.key, axis: 't', role: `an element running up the face, ${r3(profile[profile.length - 1][1] - profile[0][1])} m wide, ${r3(tBot)}-${r3(tTop)} m`, accepted: lf.accepted, built: false, why: lf.why, depthM: lf.depth, seM: lf.se, samples: lf.blocks, profile: simplifyProfile(profile), extent: [r3(tBot), r3(tTop)] };
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
            const rf: ReliefFeature = { id: `${base}_reveal`, face: f.index, faceKey: f.key, axis: 'unit', role: `the reveal of ${unitRole}`, accepted: rv.accepted, built: false, why: rv.why, depthM: rv.depth, seM: rv.se, samples: rv.n };
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
                const feat: ReliefFeature = { id, face: f.index, faceKey: f.key, axis: 'unit', role: `the projection ${sd.key === 'below' || sd.key === 'above' ? sd.key : `to the ${sd.key} of`} ${unitRole}`, accepted: u2.accepted, built: false, why: u2.why, depthM: u2.depth, seM: u2.se, samples: u2.n };
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
    return { sweeps: [...keptSweeps, ...sweeps], faceSweeps, openings, features, replacedSweeps, provenance, builds };
}

// ------------------------------------------------------------------------------------------------ the photo-match gate

export interface PhotoGateResult {
    ran: boolean;
    kept: boolean;
    why: string;
    views: number;
    repeats: number;
    /** Mean judge scores per criterion over views and runs: before (the layer refined) and after (with the relief). */
    before?: Record<string, number>;
    after?: Record<string, number>;
    perView?: Array<{ panoId: string; before: number; after: number }>;
}

/**
 * The layer gate: the layer before and after the relief, rendered from each Street View photo's registered camera (what
 * stands in front in the full tile hides both alike) and judged blind against the photo (photo-match-eval.ts judgeView,
 * shuffled). Kept unless the overall score after is lower than before.
 */
export async function photoMatchGate(input: {
    views: ProjectionView[]; beforeGlb: string; afterGlb: string; judge: JudgeClient; place: string;
    occluder?: RenderMesh3D; repeats?: number; maxViews?: number; dir?: string; signal?: AbortSignal;
}): Promise<PhotoGateResult> {
    const repeats = input.repeats ?? 3;
    const views = input.views.filter(v => v.poseQuality > 0).slice(0, input.maxViews ?? 4);
    if (!views.length) return { ran: false, kept: true, why: 'no registered Street View photo to judge against', views: 0, repeats };
    const before = [readTileTriangles(fs.readFileSync(input.beforeGlb))], after = [readTileTriangles(fs.readFileSync(input.afterGlb))];
    const runsAll: JudgeRun[] = [];
    const perView: NonNullable<PhotoGateResult['perView']> = [];
    await Promise.all(views.map(async (v, k) => {
        const occ = input.occluder ? renderFrameDepth(input.occluder, v.camera as never) : undefined;
        const rb = renderTriangles(before, v.camera, occ ? { occluderDepth: occ } : {});
        const ra = renderTriangles(after, v.camera, occ ? { occluderDepth: occ } : {});
        const pb = renderPng(rb), pa = renderPng(ra);
        const photo = encodePng(v.image.width, v.image.height, Buffer.from(v.image.rgba), 4);
        if (input.dir) {
            fs.mkdirSync(input.dir, { recursive: true });
            fs.writeFileSync(path.join(input.dir, `gate_${k}_before.png`), pb);
            fs.writeFileSync(path.join(input.dir, `gate_${k}_after.png`), pa);
        }
        if (input.signal?.aborted) throw new Error('aborted');
        const runs = await judgeView({ client: input.judge, place: input.place, photo: { bytes: photo, mimeType: 'image/png' }, renders: [{ armId: 'before', png: pb }, { armId: 'after', png: pa }], repeats, seed: `relief-gate:${v.panoId}` });
        runsAll.push(...runs);
        const st = aggregateRuns(runs, ['before', 'after']);
        perView.push({ panoId: v.panoId, before: st.before.overall.mean, after: st.after.overall.mean });
    }));
    const agg = aggregateRuns(runsAll, ['before', 'after']);
    const pick = (a: 'before' | 'after') => Object.fromEntries(Object.entries(agg[a]).map(([c, s]) => [c, s.mean]));
    const b = agg.before.overall.mean, a = agg.after.overall.mean;
    const kept = a >= b;
    return { ran: true, kept, why: `overall ${a} with the relief against ${b} without it, ${views.length} photos x ${repeats} blind runs${kept ? '' : ': worse, so the relief layer is not used'}`, views: views.length, repeats, before: pick('before'), after: pick('after'), perView };
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
    const geometry = reliefGeometry(input.run, report, { sweeps: input.build.sweeps, openings: input.build.openings, grammars: grammarOf });
    const counts = {
        bands: countFeatures(geometry.features, f => f.axis === 's'),
        verticals: countFeatures(geometry.features, f => f.axis === 't'),
        reveals: countFeatures(geometry.features, f => f.axis === 'unit' && f.id.endsWith('_reveal')),
        projections: countFeatures(geometry.features, f => f.axis === 'unit' && !f.id.endsWith('_reveal'))
    };
    progress(`kept: bands ${counts.bands.accepted} of ${counts.bands.proposed}, vertical elements ${counts.verticals.accepted} of ${counts.verticals.proposed}, window reveals ${counts.reveals.accepted} of ${counts.reveals.proposed}, projections beside openings ${counts.projections.accepted} of ${counts.projections.proposed}`);
    // 3. the solid again with them
    t = Date.now();
    const run2 = await runNativeMassing({ parts: input.build.parts, meshes: input.massing.meshes }, {
        tilePath: input.tilePath, isolateGlb: input.isolateGlb, dir: path.join(input.dir, 'native'), sweeps: geometry.sweeps, openings: geometry.openings, faceSweeps: geometry.faceSweeps,
        params: { snapMaxM: 0, sections: 0, topdown: 0 }, ...(input.signal ? { signal: input.signal } : {})
    });
    timingsMs.native = Date.now() - t;
    for (const id of run2.report.rejectedSweeps) for (const fid of geometry.builds.get(id) ?? []) {
        const feat = geometry.features.find(f => f.id === fid);
        if (feat) { feat.built = false; feat.why += '; the native tool found no face for it'; }
    }
    // a measured recess whose opening did not fit its wall is not built
    for (const id of run2.report.rejectedOpenings) if (geometry.provenance.has(`opening:${id}`)) geometry.provenance.delete(`opening:${id}`);
    // 4. textures: the refined layer's, onto the new faces
    t = Date.now();
    const textures = new Map<number, FaceTexture>();
    const plain = plainTextures(run2).textures;
    for (const f2 of run2.report.faces) {
        const f1 = input.base.run.report.faces.find(f => f.key === f2.key);
        const t1 = f1 ? input.base.textures.get(f1.index) : undefined;
        if (t1 && f1 && f2.width) textures.set(f2.index, reframeTexture(t1, f1, f2));
        else if (plain.has(f2.index)) textures.set(f2.index, plain.get(f2.index)!);
    }
    const files = writeMassingLayer(run2, input.massing, textures, input.base.legend, input.dir, input.stage, input.stageKey, 'massing_relief', (n: MassingNode) => geometry.provenance.get(n.name));
    timingsMs.glb = Date.now() - t;
    fs.writeFileSync(path.join(input.dir, 'relief.json'), JSON.stringify({ version: RELIEF_VERSION, params: RELIEF_PARAMS, counts, features: geometry.features, replacedSweeps: geometry.replacedSweeps, maps, timingsMs, nativeMs: report.ms }, null, 1));
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
    return { files, run: run2, report, geometry, counts, maps, timingsMs };
}
