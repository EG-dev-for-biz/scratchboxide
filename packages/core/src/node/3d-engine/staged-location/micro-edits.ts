/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Micro-edits: a building's saved plan of tiny geometry edits, replayed unchanged on every later run and added to a few at
 * a time, so the model of a place improves run by run without ever being rebuilt wholesale.
 *
 * **The plan** (one per building, kept in the place store beside its objects: place-store.ts loadMicroEditPlan /
 * saveMicroEditPlan) is a list of edits. Each edit is either one primitive built by one of the universal operators from
 * continuous parameters (a solid of revolution; a recess spliced into a revolution's top; an elliptical profile swept along
 * radial carriers and replicated about the axis; profiles swept along concentric carriers at a pitch) or a nudge to one
 * parameter of an edit already kept. Each records its anchor as WGS-84 latitude, longitude and ellipsoidal height (free of
 * any run's frame), its evidence (the scan's points and their digest, the tile photo's crop key and the measure read from
 * it) with a confidence, its provenance label (the weakest of its parameters' labels: measured, photo-inferred, generated),
 * the run that proposed it, and its metrics before and after.
 *
 * **Small by rule** (MICRO_EDIT_PARAMS): at most `maxEditsPerRun` edits kept a run; a nudge moves one parameter by at most
 * `maxNudgeM` and `maxNudgeRel` of its value (a count by one, an angle by `maxNudgeRad`); a new primitive changes at most
 * `maxChangedAreaM2` of surface by more than `changeTolM`, and moves the surface by at most `maxDisplacementM` (its 95th
 * percentile against the model before it). Each proposal is verified alone, against the model with the plan's kept edits:
 *  - the scan: the RMS distance of the unit's scan points to the model must fall; an edit that moves the surface by less
 *    than the scan resolves (`subResolutionM`) must not raise it by more than `subResolutionTolM`, and says so. A new
 *    solid must also explain its own scan (`maxFitRmsM`, `minWithin15`);
 *  - a held-out photo (top-down, never read by a proposal): the model drawn by its structure must not score worse in
 *    luminance SSIM or gradient correlation inside the unit's disc;
 *  - bounds: every vertex inside the building's footprint and under the scan's own top nearby (the scanned volume).
 * A proposal that fails is rejected and the reason recorded; it is not proposed again while its evidence is unchanged.
 *
 * **Stable keys.** An edit's key hashes its kind, its parent's key, its rung and its anchor rounded to `keyQuantumM`, so the
 * same change is never proposed as new; matching also allows `matchRootM` of drift between scans. The photo's crop key is
 * evidence, not identity: vision readings drift between builds, so they never re-key an edit.
 *
 * **Replay** is deterministic: each unit is built in its own anchor's frame (axis at the origin, base at y = 0) from the
 * kept edits' stored parameters with their kept nudges applied in order, by the native tool (scratchbox_micro_edit.hpp),
 * and only then placed in the run's frame. The bytes of the unit-frame meshes are hashed (`replaySha`): a run whose replay
 * of the previous run's kept edits does not give that run's hash reports drift.
 *
 * **Expiry.** Before proposing, every kept solid is checked against the new scan: when its points no longer sit on it
 * (`contradictRmsM`, `contradictWithin`) or the scan shows nothing standing there, it is retired with the numbers, and the
 * edits on it with it.
 *
 * **What is proposed, in order.** For every kept solid, the next rung of its detail ladder (a recess where the photo's
 * luminance steps across a ring; radial sweeps in the recess at the photo's strongest angular period; concentric sweeps at
 * its strongest radial period), one rung per run; then nudges where a kept parameter's own measurement has moved; then new
 * solids for round units the plan does not hold. Nothing names what a unit is: radii, heights, periods and contrasts only.
 * A parameter the photo or the scan cannot resolve is a labelled estimate (`generated`) with its reason.
 */

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { LocalTangentPlane } from '../../../common/coordinate/LocalTangentPlane';
import type { ObjectFrame } from '../../asset-store/scene-object-store';
import { compileNativeCached, defaultNativeFlags, NativeBuildError } from '../native-build-cache';
import { findTileRefineRepoRoot } from '../tile-refine-service';
import {
    angularPeriod, buildHeightMap, cropKey, drawModelTopDown, findRoundUnits, heldOutScore, pointsDigest, pointsNear, radialPeriod, sampleScanPoints,
    strongestRingStep, topNear, type HeightMap, type ModelPart, type RoundUnit, type ScanPoints, type TopDownCrop
} from './micro-edit-evidence';
import { writeStagedGlbFile, type StagedGlbNode } from './staged-glb-writer';

export const MICRO_EDIT_VERSION = 'micro-edits/1';
export const MICRO_EDIT_PLAN_SCHEMA = 'scratchbox.micro-edit-plan/1';

export const MICRO_EDIT_PARAMS = {
    /** Edits kept per run (1 to 3). */
    maxEditsPerRun: 1,
    /** Proposals verified per run at most (the rest wait for the next run). */
    maxProposalsPerRun: 4,
    // a nudge
    maxNudgeM: 0.1,
    maxNudgeRel: 0.1,
    /** A metric nudge may always move this far, however small the parameter. */
    nudgeFloorM: 0.01,
    maxNudgeRad: 0.1,
    /** A kept parameter is nudged when its own measurement now differs by more than this share and this much. */
    nudgeNoiseRel: 0.04,
    nudgeNoiseM: 0.02,
    // a new primitive
    maxChangedAreaM2: 4,
    changeTolM: 0.05,
    maxDisplacementM: 0.15,
    /** A new solid against the scan it replaces (its fit residual). */
    maxRootDisplacementM: 0.3,
    // the scan
    subResolutionM: 0.2,
    subResolutionTolM: 0.02,
    minGainM: 0.002,
    maxFitRmsM: 0.15,
    minWithin15: 0.7,
    // the held-out photo
    ssimTol: 0.005,
    gradientTol: 0.01,
    // the bounds
    volumeTolM: 0.1,
    volumeReachM: 0.4,
    // expiry
    contradictRmsM: 0.3,
    contradictWithin: 0.4,
    // keys and matching
    keyQuantumM: 0.5,
    matchRootM: 0.75,
    // photo evidence
    cropTexelM: 0.03,
    ringMinSnr: 3,
    ringMinStep: 6,
    periodMinSignificance: 4,
    // geometry
    sinkM: 0.05,
    segments: 96,
    scanSpacingM: 0.08
};
export type MicroEditParams = typeof MICRO_EDIT_PARAMS;

export type ProvenanceLabel = 'measured' | 'vector-modelled' | 'photo-inferred' | 'generated';
const LABEL_STRENGTH: Record<ProvenanceLabel, number> = { measured: 3, 'vector-modelled': 2, 'photo-inferred': 1, generated: 0 };

/** WGS-84 degrees and ellipsoidal height (m): a point free of any run's frame. */
export interface GeoAnchor { lat: number; lng: number; hM: number }

/**
 * The operator configurations a primitive edit can take (geometry, not what it depicts):
 *  - `revolution`: a solid of revolution about the anchor's vertical axis (radiusM, heightM, sinkM);
 *  - `revolution-recess`: a recess spliced into its parent revolution's top (radiusM, depthM, floorShare);
 *  - `radial-sweeps`: an elliptical profile swept along a radial carrier, replicated `count` times about the axis (count,
 *    innerRadiusM, outerRadiusM, halfWidthM, halfThicknessM, pitchRad, phaseRad, yM above the base);
 *  - `concentric-sweeps`: a round profile swept along circles at a radial pitch, with `spokes` radial carriers (pitchM,
 *    wireRadiusM, innerRadiusM, outerRadiusM, spokes, yM).
 */
export type MicroPrimitive = 'revolution' | 'revolution-recess' | 'radial-sweeps' | 'concentric-sweeps';

export interface EditMetrics {
    /** RMS distance (m) of the unit's scan points to the model, and the share within 15 cm. */
    scanRmsM: number;
    scanWithin15: number;
    scanPoints: number;
    /** Against the held-out photo (null when it could not be scored). */
    photoSsim: number | null;
    photoGradientNcc: number | null;
}

export interface MicroEditEvidence {
    scan?: { points: number; digest: string; rmsM?: number; rmsRel?: number; sectorShare?: number };
    photo?: { cropKey: string; texelM: number; measures: Record<string, number> };
    reasons: Record<string, string>;
}

export interface MicroEdit {
    key: string;
    kind: 'primitive' | 'nudge';
    primitive?: MicroPrimitive;
    /** The key of the edit this one sits on (a primitive) or changes (a nudge). */
    parent?: string;
    /** The rung of its solid's detail ladder (0 the solid itself); -1 for a nudge. */
    rung: number;
    anchor: GeoAnchor;
    params: Record<string, number>;
    nudge?: { param: string; from: number; to: number };
    paramProvenance: Record<string, ProvenanceLabel>;
    provenance: ProvenanceLabel;
    confidence: number;
    evidence: MicroEditEvidence;
    proposedBy: { runId: string; atMs: number; code: string };
    metrics: { before: EditMetrics; after: EditMetrics; changedAreaM2: number; displacementP95M: number; scanRule: 'improves' | 'within-resolution' };
    status: 'kept' | 'retired';
    retired?: { runId: string; atMs: number; reason: string };
}

export interface RejectedProposal {
    key: string;
    kind: MicroEdit['kind'];
    primitive?: MicroPrimitive;
    parent?: string;
    rung: number;
    params: Record<string, number>;
    nudge?: MicroEdit['nudge'];
    evidenceDigest: string;
    runId: string;
    atMs: number;
    reason: string;
    metrics?: Partial<MicroEdit['metrics']>;
}

export interface MicroEditRunRecord {
    runId: string;
    atMs: number;
    code: string;
    /** Kept edits replayed before this run proposed, and their unit-frame hash. */
    replayed: number;
    replaySha: string;
    /** The previous run's hash after it kept its edits; drift when it differs from replaySha (same code). */
    previousSha?: string;
    drift: boolean | null;
    proposed: string[];
    kept: string[];
    rejected: Array<{ key: string; reason: string }>;
    retired: Array<{ key: string; reason: string }>;
    skipped: Array<{ key: string; reason: string }>;
    afterSha: string;
    units: number;
}

export interface MicroEditPlan {
    schema: typeof MICRO_EDIT_PLAN_SCHEMA;
    buildingId: string;
    place?: string;
    edits: MicroEdit[];
    rejected: RejectedProposal[];
    runs: MicroEditRunRecord[];
    createdAtMs: number;
    updatedAtMs: number;
}

export function emptyPlan(buildingId: string, place?: string, now = Date.now()): MicroEditPlan {
    return { schema: MICRO_EDIT_PLAN_SCHEMA, buildingId, ...(place ? { place } : {}), edits: [], rejected: [], runs: [], createdAtMs: now, updatedAtMs: now };
}

// =============================================================================
// Frames, keys and the effective parameters
// =============================================================================

export function toAnchor(frame: ObjectFrame, x: number, y: number, z: number): GeoAnchor {
    const g = new LocalTangentPlane({ lat: frame.lat, lng: frame.lng, alt: frame.ellipsoidalHeightM ?? 0 }).toLatLng([x, y, z]);
    return { lat: round(g.lat, 9), lng: round(g.lng, 9), hM: round(g.alt ?? 0, 4) };
}

export function fromAnchor(frame: ObjectFrame, a: GeoAnchor): [number, number, number] {
    const p = new LocalTangentPlane({ lat: frame.lat, lng: frame.lng, alt: frame.ellipsoidalHeightM ?? 0 }).toLocal({ lat: a.lat, lng: a.lng, alt: a.hM });
    return [p[0], p[1], p[2]];
}

/** The anchor rounded to `quantumM` on a grid fixed to the earth (metres of latitude and of longitude at that latitude). */
export function quantisedAnchor(a: GeoAnchor, quantumM: number): [number, number, number] {
    const mLat = 111_320, mLng = 111_320 * Math.cos((a.lat * Math.PI) / 180);
    return [Math.round((a.lat * mLat) / quantumM), Math.round((a.lng * mLng) / quantumM), Math.round(a.hM / quantumM)];
}

/** An edit's stable key (see the file comment). */
export function editKey(e: Pick<MicroEdit, 'kind' | 'primitive' | 'parent' | 'rung' | 'anchor' | 'nudge'>, P: Pick<MicroEditParams, 'keyQuantumM'> = MICRO_EDIT_PARAMS): string {
    const id = [e.kind, e.primitive ?? '', e.parent ?? '', e.rung, quantisedAnchor(e.anchor, P.keyQuantumM), e.nudge ? [e.nudge.param, roundSig(e.nudge.to)] : null];
    return `${e.kind === 'nudge' ? 'n' : 'p'}-${crypto.createHash('sha256').update(JSON.stringify(id)).digest('hex').slice(0, 16)}`;
}

/** Parameters that shape only surface hidden below the support (a solid's sink into the roof): never shown, so not labelled into the edit's own label. */
export const HIDDEN_PARAMS: ReadonlySet<string> = new Set(['sinkM']);

/** The weakest label among a parameter set's labels. */
export function weakestLabel(labels: ProvenanceLabel[]): ProvenanceLabel {
    return labels.reduce<ProvenanceLabel>((w, l) => (LABEL_STRENGTH[l] < LABEL_STRENGTH[w] ? l : w), 'measured');
}

/** The kept edits in plan order. */
export function keptEdits(plan: MicroEditPlan): MicroEdit[] {
    return plan.edits.filter(e => e.status === 'kept');
}

/** A primitive's parameters with its kept nudges applied in the order they were kept. */
export function effectiveParams(plan: MicroEditPlan, edit: MicroEdit): Record<string, number> {
    const p = { ...edit.params };
    for (const n of keptEdits(plan)) if (n.kind === 'nudge' && n.parent === edit.key && n.nudge) p[n.nudge.param] = n.nudge.to;
    return p;
}

/** The root solid an edit belongs to (itself for a root; through parents and nudges otherwise). */
export function rootOf(plan: MicroEditPlan, edit: MicroEdit): MicroEdit | undefined {
    let e: MicroEdit | undefined = edit;
    const byKey = new Map(plan.edits.map(x => [x.key, x]));
    for (let guard = 0; e && e.parent && guard < 64; guard++) e = byKey.get(e.parent);
    return e && e.kind === 'primitive' && e.primitive === 'revolution' ? e : undefined;
}

// =============================================================================
// Step bounds
// =============================================================================

/** Whether a nudge from `from` to `to` of `param` is small by rule; the reason when it is not. */
export function nudgeWithinBounds(param: string, from: number, to: number, P: Pick<MicroEditParams, 'maxNudgeM' | 'maxNudgeRel' | 'nudgeFloorM' | 'maxNudgeRad'> = MICRO_EDIT_PARAMS): string | undefined {
    const d = Math.abs(to - from);
    if (!Number.isFinite(to)) return `${param}: not a number`;
    if (param === 'count' || param === 'spokes') return Number.isInteger(to) && d <= 1 ? undefined : `${param}: a count moves by one at most (asked ${from} -> ${to})`;
    if (param.endsWith('Rad')) return d <= Math.max(P.maxNudgeRad, P.maxNudgeRel * Math.abs(from)) + 1e-9 ? undefined : `${param}: ${d.toFixed(3)} rad is more than ${P.maxNudgeRad} rad (or ${P.maxNudgeRel * 100}%) a step`;
    const limit = Math.max(P.nudgeFloorM, Math.min(P.maxNudgeM, P.maxNudgeRel * Math.abs(from)));
    return d <= limit + 1e-9 ? undefined : `${param}: ${(d * 100).toFixed(1)} cm is more than ${(limit * 100).toFixed(1)} cm (${P.maxNudgeM * 100} cm or ${P.maxNudgeRel * 100}% of ${from.toFixed(3)}) a step`;
}

/** The nudge's target, clamped to the bound. */
export function clampNudge(param: string, from: number, wanted: number, P: Pick<MicroEditParams, 'maxNudgeM' | 'maxNudgeRel' | 'nudgeFloorM' | 'maxNudgeRad'> = MICRO_EDIT_PARAMS): number {
    if (param === 'count' || param === 'spokes') return from + Math.sign(Math.round(wanted) - from);
    const limit = param.endsWith('Rad') ? Math.max(P.maxNudgeRad, P.maxNudgeRel * Math.abs(from)) : Math.max(P.nudgeFloorM, Math.min(P.maxNudgeM, P.maxNudgeRel * Math.abs(from)));
    return round(from + Math.max(-limit, Math.min(limit, wanted - from)), 5);
}

// =============================================================================
// Composition: the plan as primitive lines, per unit, in the unit's own frame
// =============================================================================

export interface UnitLines { root: string; anchor: GeoAnchor; lines: string[]; edits: string[] }

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(6));

/** The kept edits as the native tool's lines, one unit per kept root, sorted by key; each unit in its anchor's frame. */
export function composeUnits(plan: MicroEditPlan, extra?: MicroEdit, P: Pick<MicroEditParams, 'segments'> = MICRO_EDIT_PARAMS): UnitLines[] {
    const kept = [...keptEdits(plan), ...(extra ? [extra] : [])];
    const view: MicroEditPlan = { ...plan, edits: kept.map(e => ({ ...e, status: 'kept' as const })) };
    const roots = kept.filter(e => e.kind === 'primitive' && e.primitive === 'revolution').sort((a, b) => (a.key < b.key ? -1 : 1));
    return roots.map(root => {
        const rp = effectiveParams(view, root);
        const children = kept.filter(e => e.kind === 'primitive' && e.parent === root.key).sort((a, b) => a.rung - b.rung || (a.key < b.key ? -1 : 1));
        const R = rp.radiusM, Hh = rp.heightM, sink = rp.sinkM ?? 0;
        const meridian: Array<[number, number]> = [[R, -sink], [R, Hh]];
        const recess = children.find(c => c.primitive === 'revolution-recess');
        if (recess) {
            const q = effectiveParams(view, recess);
            const rr = Math.min(q.radiusM, R - 0.01), floor = Hh - q.depthM;
            meridian.push([rr, Hh], [rr * (q.floorShare ?? 0.95), floor], [0, floor]);
        } else meridian.push([0, Hh]);
        const lines = [`part ${root.key}`, `rev 0 0 ${P.segments} 0 0 1 0 0 ${meridian.length} ${meridian.map(([r, y]) => `${fmt(r)} ${fmt(y)}`).join(' ')}`];
        const edits = [root.key, ...(recess ? [recess.key] : [])];
        for (const c of children) {
            const q = effectiveParams(view, c);
            if (c.primitive === 'radial-sweeps') {
                const ph = q.phaseRad ?? 0;
                const a = [q.innerRadiusM * Math.cos(ph), q.yM, q.innerRadiusM * Math.sin(ph)], b = [q.outerRadiusM * Math.cos(ph), q.yM, q.outerRadiusM * Math.sin(ph)];
                lines.push(`part ${c.key}`, `sweep ${fmt(q.halfWidthM)} ${fmt(q.halfThicknessM)} ${fmt(q.pitchRad)} ${fmt(q.pitchRad)} 0 8 0 1 0 2 ${a.map(fmt).join(' ')} ${b.map(fmt).join(' ')}`, `rep ${Math.round(q.count)} 0 0 0`);
                edits.push(c.key);
            } else if (c.primitive === 'concentric-sweeps') {
                lines.push(`part ${c.key}`);
                for (let r = q.innerRadiusM; r <= q.outerRadiusM + 1e-9; r += q.pitchM) {
                    const n = Math.max(16, Math.round((2 * Math.PI * r) / 0.05));
                    const pts: string[] = [];
                    for (let k = 0; k < n; k++) { const th = (2 * Math.PI * k) / n; pts.push(`${fmt(r * Math.cos(th))} ${fmt(q.yM)} ${fmt(r * Math.sin(th))}`); }
                    lines.push(`sweep ${fmt(q.wireRadiusM)} ${fmt(q.wireRadiusM)} 0 0 1 6 0 1 0 ${n} ${pts.join(' ')}`);
                }
                if (q.spokes >= 1) {
                    lines.push(`sweep ${fmt(q.wireRadiusM)} ${fmt(q.wireRadiusM)} 0 0 0 6 0 1 0 2 ${fmt(q.innerRadiusM)} ${fmt(q.yM)} 0 ${fmt(q.outerRadiusM)} ${fmt(q.yM)} 0`, `rep ${Math.round(q.spokes)} 0 0 0`);
                }
                edits.push(c.key);
            }
        }
        return { root: root.key, anchor: root.anchor, lines, edits };
    });
}

// =============================================================================
// The native build
// =============================================================================

const CLI_SOURCE = path.join('scripts', 'micro_edit_build.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
let building: Promise<string> | undefined;

/** Builds the tool through the native build cache (a failed build throws). */
export function ensureMicroEditBinary(repoRoot = findTileRefineRepoRoot()): Promise<string> {
    if (process.env.SCRATCHBOX_MICRO_EDIT_BIN) return Promise.resolve(process.env.SCRATCHBOX_MICRO_EDIT_BIN);
    building ??= (async () => {
        try {
            const built = await compileNativeCached({ sourcePath: path.join(repoRoot, CLI_SOURCE), includeDirs: [path.join(repoRoot, INCLUDE_DIR)], flags: defaultNativeFlags(), name: 'micro_edit_build', timeoutMs: 300_000 });
            return built.binaryPath;
        } catch (err) {
            throw new Error(`could not build micro_edit_build: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
        }
    })().finally(() => { building = undefined; });
    return building;
}

export interface BuiltPart extends ModelPart { areaM2: number }

/** Runs the tool on `lines` in `dir`; the parts in the lines' own frame. Throws with the tool's error. */
export async function buildPrimitives(lines: string[], dir: string): Promise<BuiltPart[]> {
    const binary = await ensureMicroEditBinary();
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, 'input.txt');
    fs.writeFileSync(input, lines.join('\n') + '\n');
    const out = await new Promise<string>((resolve, reject) => {
        execFile(binary, [input, dir], { timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 1 << 20 }, (err, stdout) => {
            const tail = String(stdout || '').trim().split('\n').pop() ?? '';
            if (err) {
                let msg = tail || err.message;
                try { msg = JSON.parse(tail).error ?? msg; } catch { /* not JSON */ }
                reject(new Error(`micro_edit_build failed: ${msg}`));
            } else resolve(tail);
        });
    });
    if (!JSON.parse(out).ok) throw new Error(`micro_edit_build failed: ${out}`);
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')) as { parts: Array<{ id: string; offset: number; vertices: number; indices: number; areaM2: number }> };
    const bin = fs.readFileSync(path.join(dir, 'mesh.bin'));
    const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
    return report.parts.map(p => ({
        id: p.id, areaM2: p.areaM2,
        positions: new Float32Array(ab.slice(p.offset, p.offset + p.vertices * 12)),
        normals: new Float32Array(ab.slice(p.offset + p.vertices * 12, p.offset + p.vertices * 24)),
        indices: new Uint32Array(ab.slice(p.offset + p.vertices * 24, p.offset + p.vertices * 24 + p.indices * 4))
    }));
}

export interface BuiltUnit { root: string; anchor: GeoAnchor; origin: [number, number, number]; parts: BuiltPart[]; sha: string }

/** Every unit built in its own frame (hashed there), then placed in the run's `frame` (translation only). */
export async function buildUnits(units: UnitLines[], frame: ObjectFrame, dir: string): Promise<BuiltUnit[]> {
    const out: BuiltUnit[] = [];
    for (const u of units) {
        const local = await buildPrimitives(u.lines, path.join(dir, u.root));
        const h = crypto.createHash('sha256');
        for (const p of local) { h.update(p.id); h.update(Buffer.from(p.positions.buffer)); h.update(Buffer.from(p.normals.buffer)); h.update(Buffer.from(p.indices.buffer)); }
        const o = fromAnchor(frame, u.anchor);
        const parts = local.map(p => {
            const pos = new Float32Array(p.positions.length);
            for (let i = 0; i < pos.length; i += 3) { pos[i] = p.positions[i] + o[0]; pos[i + 1] = p.positions[i + 1] + o[1]; pos[i + 2] = p.positions[i + 2] + o[2]; }
            return { ...p, positions: pos };
        });
        out.push({ root: u.root, anchor: u.anchor, origin: o, parts, sha: h.digest('hex') });
    }
    return out;
}

/** The hash of a replay: its units' unit-frame hashes in key order. */
export function replayHash(units: Array<Pick<BuiltUnit, 'root' | 'sha'>>): string {
    return crypto.createHash('sha256').update(units.map(u => `${u.root}:${u.sha}`).sort().join('\n')).digest('hex').slice(0, 24);
}

// =============================================================================
// Distances
// =============================================================================

function pointTriangleDistance2(px: number, py: number, pz: number, a: Float32Array, ia: number, ib: number, ic: number): number {
    const ax = a[ia], ay = a[ia + 1], az = a[ia + 2];
    const abx = a[ib] - ax, aby = a[ib + 1] - ay, abz = a[ib + 2] - az, acx = a[ic] - ax, acy = a[ic + 1] - ay, acz = a[ic + 2] - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    const q = (x: number, y: number, z: number) => (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2;
    if (d1 <= 0 && d2 <= 0) return q(ax, ay, az);
    const bpx = px - a[ib], bpy = py - a[ib + 1], bpz = pz - a[ib + 2];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) return q(a[ib], a[ib + 1], a[ib + 2]);
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return q(ax + v * abx, ay + v * aby, az + v * abz); }
    const cpx = px - a[ic], cpy = py - a[ic + 1], cpz = pz - a[ic + 2];
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) return q(a[ic], a[ic + 1], a[ic + 2]);
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return q(ax + w * acx, ay + w * acy, az + w * acz); }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return q(a[ib] + w * (a[ic] - a[ib]), a[ib + 1] + w * (a[ic + 1] - a[ib + 1]), a[ib + 2] + w * (a[ic + 2] - a[ib + 2])); }
    const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
    return q(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

/** A triangle soup (9 floats a triangle) with a uniform plan grid for nearest-surface queries. */
export class SurfaceIndex {
    private readonly cells = new Map<number, number[]>();
    constructor(readonly soup: Float32Array, readonly cellM = 0.25) {
        for (let t = 0; t < soup.length / 9; t++) {
            let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
            for (let k = 0; k < 3; k++) { x0 = Math.min(x0, soup[t * 9 + k * 3]); x1 = Math.max(x1, soup[t * 9 + k * 3]); z0 = Math.min(z0, soup[t * 9 + k * 3 + 2]); z1 = Math.max(z1, soup[t * 9 + k * 3 + 2]); }
            for (let iz = Math.floor(z0 / cellM); iz <= Math.floor(z1 / cellM); iz++) for (let ix = Math.floor(x0 / cellM); ix <= Math.floor(x1 / cellM); ix++) {
                const key = iz * 1_000_003 + ix;
                let l = this.cells.get(key);
                if (!l) this.cells.set(key, l = []);
                l.push(t);
            }
        }
    }
    /** Distance from p to the nearest triangle within `reachM` in plan (Infinity when none). */
    distance(px: number, py: number, pz: number, reachM = 1): number {
        const r = Math.ceil(reachM / this.cellM), ix = Math.floor(px / this.cellM), iz = Math.floor(pz / this.cellM);
        let best = Infinity;
        const seen = new Set<number>();
        for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
            for (const t of this.cells.get((iz + dz) * 1_000_003 + ix + dx) ?? []) {
                if (seen.has(t)) continue;
                seen.add(t);
                best = Math.min(best, pointTriangleDistance2(px, py, pz, this.soup, t * 9, t * 9 + 3, t * 9 + 6));
            }
        }
        return Math.sqrt(best);
    }
}

/** A part's indexed triangles as a soup. */
export function partSoup(parts: ModelPart[]): Float32Array {
    let n = 0;
    for (const p of parts) n += p.indices.length;
    const s = new Float32Array(n * 3);
    let o = 0;
    for (const p of parts) for (let i = 0; i < p.indices.length; i++) { const v = p.indices[i] * 3; s[o++] = p.positions[v]; s[o++] = p.positions[v + 1]; s[o++] = p.positions[v + 2]; }
    return s;
}

/** The scan points' distances to the model: its surfaces, or the support plane at `supportY` (the roof the unit stands on). */
export function scanDistances(points: ScanPoints, model: SurfaceIndex | undefined, supportY: number): Float64Array {
    const d = new Float64Array(points.count);
    for (let i = 0; i < points.count; i++) {
        const x = points.p[i * 3], y = points.p[i * 3 + 1], z = points.p[i * 3 + 2];
        d[i] = Math.min(Math.abs(y - supportY), model ? model.distance(x, y, z, 1.5) : Infinity);
    }
    return d;
}

export function rmsOf(d: ArrayLike<number>, w?: ArrayLike<number>): { rms: number; within15: number } {
    let s = 0, ws = 0, inn = 0;
    for (let i = 0; i < d.length; i++) { const wi = w ? w[i] : 1; s += wi * d[i] * d[i]; ws += wi; if (d[i] <= 0.15) inn += wi; }
    return { rms: ws ? round(Math.sqrt(s / ws), 5) : 0, within15: ws ? round(inn / ws, 4) : 0 };
}

/** How far the surface of `after` moved from `current` (area-weighted samples): area moved past tolM, and the 95th percentile. */
export function surfaceChange(after: ModelPart[], current: SurfaceIndex | undefined, tolM: number, spacingM = 0.05): { changedAreaM2: number; p95M: number } {
    const samples = sampleScanPoints(partSoup(after), spacingM);
    if (!current) {
        let a = 0;
        for (let i = 0; i < samples.count; i++) a += samples.a[i];
        return { changedAreaM2: round(a, 4), p95M: Infinity };
    }
    const d: Array<[number, number]> = [];
    let changed = 0;
    for (let i = 0; i < samples.count; i++) {
        const di = current.distance(samples.p[i * 3], samples.p[i * 3 + 1], samples.p[i * 3 + 2], 1);
        d.push([di, samples.a[i]]);
        if (di > tolM) changed += samples.a[i];
    }
    d.sort((p, q) => p[0] - q[0]);
    const total = d.reduce((s, x) => s + x[1], 0);
    let acc = 0, p95 = 0;
    for (const [di, a] of d) { acc += a; if (acc >= 0.95 * total) { p95 = di; break; } }
    return { changedAreaM2: round(changed, 4), p95M: round(p95, 4) };
}

// =============================================================================
// Bounds: footprint and scanned volume
// =============================================================================

/** A building's footprint: its parts, each loops (x, z) whose first is the outer and the rest holes. */
export type Footprint = Array<Array<Array<[number, number]>>>;

/** Even-odd inside test over loops (x, z): the first outer, the rest holes. */
export function insideLoops(loops: Array<Array<[number, number]>>, x: number, z: number): boolean {
    let inside = false;
    for (const loop of loops) for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
        const [xi, zi] = loop[i], [xj, zj] = loop[j];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
}

/** Inside any part of the footprint. */
export function insideFootprint(footprint: Footprint, x: number, z: number): boolean {
    return footprint.some(loops => insideLoops(loops, x, z));
}

/** The first vertex of `parts` outside the footprint or above the scan's top nearby, as a reason; undefined when all are in. */
export function outsideBounds(parts: ModelPart[], footprint: Footprint, heights: HeightMap, P: Pick<MicroEditParams, 'volumeTolM' | 'volumeReachM'> = MICRO_EDIT_PARAMS): string | undefined {
    for (const p of parts) for (let v = 0; v < p.positions.length; v += 3) {
        const x = p.positions[v], y = p.positions[v + 1], z = p.positions[v + 2];
        if (!insideFootprint(footprint, x, z)) return `a vertex at (${x.toFixed(2)}, ${z.toFixed(2)}) lies outside the footprint`;
        const top = topNear(heights, x, z, P.volumeReachM);
        if (!(top > -Infinity)) return `a vertex at (${x.toFixed(2)}, ${z.toFixed(2)}) stands where the scan has no surface`;
        if (y > top + P.volumeTolM) return `a vertex at (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}) stands ${(y - top).toFixed(2)} m above the scan's top within ${P.volumeReachM} m`;
    }
    return undefined;
}

// =============================================================================
// The pass
// =============================================================================

export interface MicroEditPassInput {
    plan: MicroEditPlan;
    runId: string;
    /** The run's frame (the extraction's ENU origin). */
    frame: ObjectFrame;
    /** The building's scan (tile frame triangle soup, 9 floats a triangle) and its tile photo seen straight down. */
    scan: Float32Array;
    tileCrop: (cx: number, cz: number, halfM: number, texelM: number, referenceY: number) => TopDownCrop;
    /** The held-out photo resampled onto a crop's grid (undefined: none, and nothing can be kept). */
    heldOut?: (grid: TopDownCrop) => Promise<TopDownCrop | undefined>;
    /** The building's footprint (tile frame). */
    footprint: Footprint;
    workDir: string;
    params?: Partial<MicroEditParams>;
    now?: () => number;
}

export interface UnitReport {
    root: string;
    axis: [number, number];
    radiusM: number;
    heightM: number;
    edits: Array<{ key: string; kind: string; primitive?: string; rung: number; provenance: ProvenanceLabel; confidence: number; params: Record<string, number> }>;
}

export interface MicroEditPassReport {
    version: string;
    run: MicroEditRunRecord;
    units: UnitReport[];
    candidates: { found: number; components: number; rejected: Record<string, number> };
    proposals: Array<{ key: string; kind: string; primitive?: string; rung: number; parent?: string; verdict: 'kept' | 'rejected' | 'skipped'; reason: string; metrics?: Partial<MicroEdit['metrics']> }>;
    ms: number;
}

interface Proposal extends Omit<MicroEdit, 'metrics' | 'status' | 'proposedBy' | 'key'> { key?: string }

function finishProposal(p: Proposal, P: MicroEditParams): Proposal & { key: string } {
    const key = editKey(p as MicroEdit, P);
    return { ...p, key, provenance: weakestLabel(Object.entries(p.paramProvenance).filter(([k]) => !HIDDEN_PARAMS.has(k)).map(([, l]) => l)) };
}

function evidenceDigest(e: MicroEditEvidence): string {
    return crypto.createHash('sha256').update(JSON.stringify([e.scan?.digest ?? '', e.photo?.cropKey ?? ''])).digest('hex').slice(0, 16);
}

/**
 * One run of the loop on one building: expire what the new scan contradicts, replay the rest (hashing it), propose the
 * next small edits in order, verify each alone, keep at most `maxEditsPerRun`, and return the plan with this run's
 * record (the input plan is not changed).
 */
export async function runMicroEditPass(input: MicroEditPassInput): Promise<{ plan: MicroEditPlan; report: MicroEditPassReport; units: BuiltUnit[] }> {
    const t0 = Date.now();
    const now = input.now ?? Date.now;
    const P: MicroEditParams = { ...MICRO_EDIT_PARAMS, ...(input.params ?? {}) };
    const plan: MicroEditPlan = JSON.parse(JSON.stringify(input.plan));
    const record: MicroEditRunRecord = { runId: input.runId, atMs: now(), code: MICRO_EDIT_VERSION, replayed: 0, replaySha: '', drift: null, proposed: [], kept: [], rejected: [], retired: [], skipped: [], afterSha: '', units: 0 };
    const proposals: MicroEditPassReport['proposals'] = [];
    fs.mkdirSync(input.workDir, { recursive: true });

    // the scan over the footprint
    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    for (const part of input.footprint) for (const loop of part) for (const [x, z] of loop) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z); }
    const pts = sampleScanPoints(input.scan, P.scanSpacingM, (x, _y, z) => x >= bx0 - 1 && x <= bx1 + 1 && z >= bz0 - 1 && z <= bz1 + 1);
    const heights = buildHeightMap(pts, { x0: bx0 - 1, z0: bz0 - 1, x1: bx1 + 1, z1: bz1 + 1 });
    const scanIndex = new SurfaceIndex(input.scan.length / 9 > 0 ? soupWithin(input.scan, bx0 - 2, bz0 - 2, bx1 + 2, bz1 + 2) : input.scan);
    const found = findRoundUnits(pts, heights, (x, z) => insideFootprint(input.footprint, x, z));

    // replay: the previous run's kept edits, unchanged
    let dirN = 0;
    const work = () => path.join(input.workDir, `b${dirN++}`);
    const replayed = await buildUnits(composeUnits(plan, undefined, P), input.frame, work());
    record.replayed = keptEdits(plan).length;
    record.replaySha = replayHash(replayed);
    const prev = plan.runs[plan.runs.length - 1];
    if (prev) { record.previousSha = prev.afterSha; record.drift = prev.code === MICRO_EDIT_VERSION ? prev.afterSha !== record.replaySha : null; }

    // expiry: a kept solid the new scan contradicts is retired, with the edits on it
    for (const u of replayed) {
        const root = plan.edits.find(e => e.key === u.root)!;
        const rp = effectiveParams(plan, root);
        const zone = pointsNear(pts, u.origin[0], u.origin[2], rp.radiusM + 0.3, u.origin[1] + 0.15 * rp.heightM);
        let reason: string | undefined;
        if (zone.count < 10) reason = `the new scan shows nothing standing here (${zone.count} points above 15% of its height within its radius)`;
        else {
            const m = rmsOf(scanDistances(zone, new SurfaceIndex(partSoup(u.parts)), -Infinity), zone.a);
            if (m.rms > P.contradictRmsM || m.within15 < P.contradictWithin) reason = `the new scan contradicts it: its points lie ${m.rms.toFixed(3)} m RMS from it, ${(m.within15 * 100).toFixed(0)}% within 15 cm (limits ${P.contradictRmsM} m, ${P.contradictWithin * 100}%)`;
        }
        if (!reason) continue;
        const retire = (e: MicroEdit, why: string) => { e.status = 'retired'; e.retired = { runId: input.runId, atMs: now(), reason: why }; record.retired.push({ key: e.key, reason: why }); };
        retire(root, reason);
        for (const e of plan.edits) if (e.status === 'kept' && rootOf(plan, e)?.key === root.key && e.key !== root.key) retire(e, `the solid it sits on (${root.key}) was retired: ${reason}`);
    }

    // the proposals, in order
    const crops = new Map<string, TopDownCrop>();
    const cropFor = (root: MicroEdit) => {
        let c = crops.get(root.key);
        if (!c) {
            const rp = effectiveParams(plan, root), o = fromAnchor(input.frame, root.anchor);
            c = input.tileCrop(o[0], o[2], rp.radiusM + 0.8, P.cropTexelM, o[1] + rp.heightM);
            crops.set(root.key, c);
        }
        return c;
    };
    const queue: Proposal[] = [];
    const roots = keptEdits(plan).filter(e => e.kind === 'primitive' && e.primitive === 'revolution').sort((a, b) => (a.key < b.key ? -1 : 1));
    for (const root of roots) {
        const next = nextRung(plan, root, cropFor(root), pts, input.frame, P);
        if (next) queue.push(next);
    }
    for (const root of roots) queue.push(...nudgesFor(plan, root, cropFor(root), found.units, input.frame, P));
    for (const u of found.units) {
        const anchor = toAnchor(input.frame, u.cx, u.baseY, u.cz);
        const near = plan.edits.some(e => e.kind === 'primitive' && e.primitive === 'revolution' && e.status === 'kept' && distanceM(e.anchor, anchor) <= P.matchRootM);
        if (near) continue;
        const zone = pointsNear(pts, u.cx, u.cz, u.r + 0.3, u.baseY + 0.05);
        queue.push({
            kind: 'primitive', primitive: 'revolution', rung: 0, anchor,
            params: { radiusM: round(u.r, 4), heightM: round(u.topY - u.baseY, 4), sinkM: P.sinkM },
            paramProvenance: { radiusM: 'measured', heightM: 'measured', sinkM: 'generated' },
            provenance: 'measured',
            confidence: round(Math.max(0, Math.min(1, (1 - u.rmsRel / Math.max(1e-6, ROUND_REL))) * u.sectorShare), 3),
            evidence: {
                scan: { points: zone.count, digest: pointsDigest(zone), rmsM: round(u.rmsM, 4), rmsRel: round(u.rmsRel, 4), sectorShare: round(u.sectorShare, 3) },
                reasons: { radiusM: 'a circle fitted to the scan\'s side points', heightM: 'the scan\'s 95th percentile height over its support', sinkM: `sunk ${P.sinkM * 100} cm into the roof so no gap shows (an estimate of surface that is never seen: not counted in the edit's label)` }
            }
        });
    }

    let kept = 0, tried = 0;
    for (const raw of queue) {
        if (kept >= P.maxEditsPerRun || tried >= P.maxProposalsPerRun) break;
        const prop = finishProposal(raw, P);
        const digest = evidenceDigest(prop.evidence);
        const already = plan.edits.find(e => e.key === prop.key && e.status === 'kept');
        if (already) { record.skipped.push({ key: prop.key, reason: 'kept already' }); proposals.push({ key: prop.key, kind: prop.kind, ...(prop.primitive ? { primitive: prop.primitive } : {}), rung: prop.rung, verdict: 'skipped', reason: 'kept already' }); continue; }
        const before = plan.rejected.find(r => r.key === prop.key && r.evidenceDigest === digest);
        if (before) { record.skipped.push({ key: prop.key, reason: `rejected in run ${before.runId} on the same evidence: ${before.reason}` }); proposals.push({ key: prop.key, kind: prop.kind, ...(prop.primitive ? { primitive: prop.primitive } : {}), rung: prop.rung, verdict: 'skipped', reason: `rejected before on the same evidence (${before.reason})` }); continue; }
        tried++;
        record.proposed.push(prop.key);
        const v = await verifyProposal({ plan, proposal: prop, frame: input.frame, pts, heights, scanIndex, footprint: input.footprint, cropFor, heldOut: input.heldOut, dir: work(), P });
        const base = { key: prop.key, kind: prop.kind, ...(prop.primitive ? { primitive: prop.primitive } : {}), rung: prop.rung, ...(prop.parent ? { parent: prop.parent } : {}) };
        if (v.reason) {
            plan.rejected.push({ key: prop.key, kind: prop.kind, ...(prop.primitive ? { primitive: prop.primitive } : {}), ...(prop.parent ? { parent: prop.parent } : {}), rung: prop.rung, params: prop.params, ...(prop.nudge ? { nudge: prop.nudge } : {}), evidenceDigest: digest, runId: input.runId, atMs: now(), reason: v.reason, ...(v.metrics ? { metrics: v.metrics } : {}) });
            record.rejected.push({ key: prop.key, reason: v.reason });
            proposals.push({ ...base, verdict: 'rejected', reason: v.reason, ...(v.metrics ? { metrics: v.metrics } : {}) });
            continue;
        }
        const edit: MicroEdit = { ...prop, metrics: v.metrics as MicroEdit['metrics'], status: 'kept', proposedBy: { runId: input.runId, atMs: now(), code: MICRO_EDIT_VERSION } };
        plan.edits.push(edit);
        record.kept.push(edit.key);
        proposals.push({ ...base, verdict: 'kept', reason: v.note, metrics: edit.metrics });
        kept++;
    }

    const after = await buildUnits(composeUnits(plan, undefined, P), input.frame, work());
    record.afterSha = replayHash(after);
    record.units = after.length;
    plan.runs.push(record);
    plan.updatedAtMs = now();
    const units: UnitReport[] = after.map(u => {
        const root = plan.edits.find(e => e.key === u.root)!;
        const rp = effectiveParams(plan, root);
        return {
            root: u.root, axis: [round(u.origin[0], 3), round(u.origin[2], 3)], radiusM: rp.radiusM, heightM: rp.heightM,
            edits: keptEdits(plan).filter(e => rootOf(plan, e)?.key === u.root).map(e => ({ key: e.key, kind: e.kind, ...(e.primitive ? { primitive: e.primitive } : {}), rung: e.rung, provenance: e.provenance, confidence: e.confidence, params: e.kind === 'nudge' ? { [e.nudge!.param]: e.nudge!.to } : effectiveParams(plan, e) }))
        };
    });
    return { plan, report: { version: MICRO_EDIT_VERSION, run: record, units, candidates: { found: found.units.length, components: found.components, rejected: found.rejected }, proposals, ms: Date.now() - t0 }, units: after };
}

const ROUND_REL = 0.05;

function soupWithin(soup: Float32Array, x0: number, z0: number, x1: number, z1: number): Float32Array {
    const keep: number[] = [];
    for (let t = 0; t < soup.length / 9; t++) {
        const cx = (soup[t * 9] + soup[t * 9 + 3] + soup[t * 9 + 6]) / 3, cz = (soup[t * 9 + 2] + soup[t * 9 + 5] + soup[t * 9 + 8]) / 3;
        if (cx >= x0 && cx <= x1 && cz >= z0 && cz <= z1) keep.push(t);
    }
    const out = new Float32Array(keep.length * 9);
    keep.forEach((t, k) => out.set(soup.subarray(t * 9, t * 9 + 9), k * 9));
    return out;
}

function distanceM(a: GeoAnchor, b: GeoAnchor): number {
    const mLat = 111_320, mLng = 111_320 * Math.cos((a.lat * Math.PI) / 180);
    return Math.hypot((a.lat - b.lat) * mLat, (a.lng - b.lng) * mLng, a.hM - b.hM);
}

/** The next rung of a kept solid's detail ladder, from the photo (and the scan where it resolves a depth); undefined when done. */
export function nextRung(plan: MicroEditPlan, root: MicroEdit, crop: TopDownCrop, pts: ScanPoints, frame: ObjectFrame, P: MicroEditParams = MICRO_EDIT_PARAMS): Proposal | undefined {
    const kids = keptEdits(plan).filter(e => e.kind === 'primitive' && e.parent === root.key);
    const rung = kids.reduce((m, e) => Math.max(m, e.rung), 0) + 1;
    const rp = effectiveParams(plan, root);
    const o = fromAnchor(frame, root.anchor);
    const [ax, ay, az] = o;
    const R = rp.radiusM, H = rp.heightM;
    const key = cropKey(crop, ax, az, R);
    const recess = kids.find(k => k.primitive === 'revolution-recess');
    const common = { kind: 'primitive' as const, parent: root.key, rung, anchor: root.anchor, provenance: 'generated' as ProvenanceLabel };
    if (rung === 1) {
        const step = strongestRingStep(crop, ax, az, 0.3 * R, Math.max(0.3 * R, R - 0.04));
        if (!step || step.snr < P.ringMinSnr || Math.abs(step.step) < P.ringMinStep) return undefined;
        const radiusM = round(step.radiusM, 4);
        // the scan's dish: its top points inside the ring against those on the rim
        const top = pointsNear(pts, ax, az, R, ay + 0.5 * H);
        const inner: number[] = [], rim: number[] = [];
        for (let i = 0; i < top.count; i++) {
            if (top.n[i * 3 + 1] < 0.8) continue;
            const r = Math.hypot(top.p[i * 3] - ax, top.p[i * 3 + 2] - az);
            if (r < 0.8 * radiusM) inner.push(top.p[i * 3 + 1]); else if (r > radiusM + 0.05 && r < R - 0.02) rim.push(top.p[i * 3 + 1]);
        }
        const dish = inner.length >= 5 && rim.length >= 5 ? mean(rim) - mean(inner) : NaN;
        // the scan's own roughness on the top: a dip smaller than twice it is one the scan can neither show nor rule out
        const sigma = inner.length + rim.length >= 10 ? stdev([...inner.map(y => y - mean(inner)), ...rim.map(y => y - mean(rim))]) : 0;
        const measured = Number.isFinite(dish) && dish >= Math.max(0.03, 2 * sigma);
        const depthM = round(Math.min(P.maxDisplacementM, measured ? dish : Math.max(0.02, Math.min(0.2 * radiusM, 2 * sigma))), 4);
        return {
            ...common, primitive: 'revolution-recess',
            params: { radiusM, depthM, floorShare: 0.95 },
            paramProvenance: { radiusM: 'photo-inferred', depthM: measured ? 'measured' : 'generated', floorShare: 'generated' },
            confidence: round(Math.min(1, step.snr / (3 * P.ringMinSnr)), 3),
            evidence: {
                photo: { cropKey: key, texelM: crop.texelM, measures: { ringRadiusM: radiusM, step: round(step.step, 2), snr: round(step.snr, 2), dishM: Number.isFinite(dish) ? round(dish, 4) : -1, topRoughnessM: round(sigma, 4) } },
                reasons: {
                    radiusM: `the tile photo's mean luminance steps by ${step.step.toFixed(1)} (${step.snr.toFixed(1)} x its noise) across this ring`,
                    depthM: measured ? `the scan's top dips ${dish.toFixed(3)} m inside the ring` : `the scan does not resolve a dip (${Number.isFinite(dish) ? `${(dish * 100).toFixed(1)} cm` : 'too few points'}, its top's roughness ${(sigma * 100).toFixed(1)} cm); an estimate: twice that roughness (the deepest dip the scan cannot rule out), at most a fifth of the ring's radius`,
                    floorShare: 'the recess wall slopes in by 5% of its radius (an estimate)'
                }
            }
        };
    }
    if (!recess) return undefined;
    const q = effectiveParams(plan, recess);
    const rr = q.radiusM, floorY = H - q.depthM;
    if (rung === 2) {
        const per = angularPeriod(crop, ax, az, 0.35 * rr, 0.85 * rr, 2, 12);
        if (!per) return undefined;
        const sig = per.significance >= P.periodMinSignificance;
        const rmid = 0.6 * rr, gap = (Math.PI * rmid) / per.count;
        const halfWidthM = round(Math.max(0.02, Math.min(0.8 * gap, per.duty * gap)), 4);
        // the pitch stays inside the recess: the profile's rise (half width x sin pitch) at most 40% of its depth
        const pitchRad = round(Math.min(0.45, Math.asin(Math.min(1, (0.4 * q.depthM) / halfWidthM))), 4);
        return {
            ...common, primitive: 'radial-sweeps',
            params: { count: per.count, innerRadiusM: round(Math.max(0.05, 0.18 * rr), 4), outerRadiusM: round(0.94 * rr, 4), halfWidthM, halfThicknessM: 0.006, pitchRad, phaseRad: round(per.phase, 5), yM: round(floorY + 0.4 * q.depthM, 4) },
            paramProvenance: { count: sig ? 'photo-inferred' : 'generated', phaseRad: sig ? 'photo-inferred' : 'generated', halfWidthM: sig ? 'photo-inferred' : 'generated', innerRadiusM: 'generated', outerRadiusM: 'generated', halfThicknessM: 'generated', pitchRad: 'generated', yM: 'generated' },
            confidence: round(Math.min(1, per.significance / (3 * P.periodMinSignificance)), 3),
            evidence: {
                photo: { cropKey: key, texelM: crop.texelM, measures: { count: per.count, phaseRad: round(per.phase, 4), significance: round(per.significance, 2), duty: round(per.duty, 3) } },
                reasons: {
                    count: sig ? `the photo's strongest angular period inside the recess (${per.significance.toFixed(1)} x the spectrum's median)` : `no angular period stands out (${per.significance.toFixed(1)} x the median, below ${P.periodMinSignificance}); the strongest count, an estimate`,
                    pitchRad: 'the photo straight down cannot show a pitch; an estimate of up to 26 degrees, as much as the recess holds',
                    innerRadiusM: 'an estimate: a hub of 18% of the recess radius',
                    halfThicknessM: 'an estimate below the scan\'s and the photo\'s resolution',
                    yM: 'an estimate: 40% of the way up the recess'
                }
            }
        };
    }
    if (rung === 3) {
        const per = radialPeriod(crop, ax, az, 0.15 * rr, 0.97 * rr, 0.025, 0.15);
        const sig = !!per && per.significance >= P.periodMinSignificance;
        const pitchM = round(sig ? per!.pitchM : 0.05, 4), wire = 0.004;
        return {
            ...common, primitive: 'concentric-sweeps',
            params: { pitchM, wireRadiusM: wire, innerRadiusM: round(Math.max(pitchM, 0.12 * rr), 4), outerRadiusM: round(0.97 * rr, 4), spokes: 4, yM: round(H + wire, 4) },
            paramProvenance: { pitchM: sig ? 'photo-inferred' : 'generated', wireRadiusM: 'generated', innerRadiusM: 'generated', outerRadiusM: 'generated', spokes: 'generated', yM: 'generated' },
            confidence: round(sig ? Math.min(1, per!.significance / (3 * P.periodMinSignificance)) : 0.2, 3),
            evidence: {
                photo: { cropKey: key, texelM: crop.texelM, measures: { pitchM: per ? round(per.pitchM, 4) : -1, significance: per ? round(per.significance, 2) : 0 } },
                reasons: {
                    pitchM: sig ? `the photo's strongest radial period over the recess (${per!.significance.toFixed(1)} x the median)` : `the photo resolves no radial period at ${crop.texelM} m a pixel; an estimate of 5 cm`,
                    wireRadiusM: 'an estimate below the photo\'s resolution', spokes: 'an estimate: four supports', yM: 'on the rim\'s plane'
                }
            }
        };
    }
    return undefined;
}

/** Nudges for a kept solid's measured parameters whose own measurement has moved (radius and height from the scan's round unit). */
export function nudgesFor(plan: MicroEditPlan, root: MicroEdit, _crop: TopDownCrop, units: RoundUnit[], frame: ObjectFrame, P: MicroEditParams = MICRO_EDIT_PARAMS): Proposal[] {
    const rp = effectiveParams(plan, root);
    const o = fromAnchor(frame, root.anchor);
    const u = units.find(x => Math.hypot(x.cx - o[0], x.cz - o[2]) <= P.matchRootM);
    if (!u) return [];
    const out: Proposal[] = [];
    for (const [param, measuredV] of [['radiusM', u.r], ['heightM', u.topY - u.baseY]] as Array<[string, number]>) {
        const cur = rp[param];
        if (Math.abs(measuredV - cur) <= Math.max(P.nudgeNoiseM, P.nudgeNoiseRel * Math.abs(cur))) continue;
        const to = clampNudge(param, cur, measuredV, P);
        out.push({
            kind: 'nudge', parent: root.key, rung: -1, anchor: root.anchor, params: {}, nudge: { param, from: cur, to },
            paramProvenance: { [param]: 'measured' }, provenance: 'measured', confidence: round(Math.max(0, 1 - u.rmsRel / ROUND_REL) * u.sectorShare, 3),
            evidence: { scan: { points: u.sidePoints, digest: `${round(u.r, 3)}:${round(u.topY - u.baseY, 3)}`, rmsM: round(u.rmsM, 4) }, reasons: { [param]: `the scan now measures ${measuredV.toFixed(3)} (kept ${cur.toFixed(3)}); moved by at most the step bound` } }
        });
    }
    return out;
}

interface VerifyInput {
    plan: MicroEditPlan;
    proposal: Proposal & { key: string };
    frame: ObjectFrame;
    pts: ScanPoints;
    heights: HeightMap;
    scanIndex: SurfaceIndex;
    footprint: Footprint;
    cropFor: (root: MicroEdit) => TopDownCrop;
    heldOut?: (grid: TopDownCrop) => Promise<TopDownCrop | undefined>;
    dir: string;
    P: MicroEditParams;
}

/** Verifies one proposal alone against the plan's kept edits (see the file comment). `reason` set: rejected. */
export async function verifyProposal(v: VerifyInput): Promise<{ reason?: string; note: string; metrics?: Partial<MicroEdit['metrics']> }> {
    const { plan, proposal: prop, P } = v;
    const asEdit = { ...prop, status: 'kept' as const, metrics: undefined as unknown as MicroEdit['metrics'], proposedBy: { runId: '', atMs: 0, code: MICRO_EDIT_VERSION } } as MicroEdit;
    // bounds by rule first
    if (prop.kind === 'nudge') {
        const why = nudgeWithinBounds(prop.nudge!.param, prop.nudge!.from, prop.nudge!.to, P);
        if (why) return { reason: `step too large: ${why}`, note: '' };
    }
    const view: MicroEditPlan = { ...plan, edits: [...plan.edits, asEdit] };
    const root = rootOf(view, asEdit);
    if (!root) return { reason: 'its solid is not in the plan', note: '' };
    const unitOf = (p: MicroEditPlan, extra?: MicroEdit) => composeUnits(p, extra, P).filter(u => u.root === root.key);
    const beforeLines = prop.rung === 0 ? [] : unitOf(plan);
    const [beforeUnit] = beforeLines.length ? await buildUnits(beforeLines, v.frame, path.join(v.dir, 'before')) : [undefined];
    const [afterUnit] = await buildUnits(unitOf(plan, asEdit), v.frame, path.join(v.dir, 'after'));
    if (!afterUnit) return { reason: 'the edit builds no geometry', note: '' };
    const o = afterUnit.origin;
    const rp = effectiveParams(view, root);
    // the bounds: footprint and scanned volume
    const out = outsideBounds(afterUnit.parts, v.footprint, v.heights, P);
    if (out) return { reason: `out of bounds: ${out}`, note: '' };
    // the step's size: surface moved against the current model (the scan where no edit stands yet)
    const beforeIndex = beforeUnit ? new SurfaceIndex(partSoup(beforeUnit.parts)) : undefined;
    const change = surfaceChange(afterUnit.parts, beforeIndex ?? v.scanIndex, P.changeTolM);
    const maxDisp = prop.rung === 0 ? P.maxRootDisplacementM : prop.kind === 'nudge' ? P.maxNudgeM + P.changeTolM : P.maxDisplacementM;
    const sizeMetrics = { changedAreaM2: change.changedAreaM2, displacementP95M: change.p95M };
    if (change.changedAreaM2 > P.maxChangedAreaM2) return { reason: `step too large: it moves ${change.changedAreaM2.toFixed(2)} m2 of surface by more than ${P.changeTolM * 100} cm (at most ${P.maxChangedAreaM2} m2)`, note: '', metrics: sizeMetrics };
    if (change.p95M > maxDisp) return { reason: `step too large: its surface moves ${change.p95M.toFixed(3)} m (95th percentile; at most ${maxDisp} m)`, note: '', metrics: sizeMetrics };
    // the scan
    const zone = pointsNear(v.pts, o[0], o[2], rp.radiusM + 0.3, o[1] - 0.3);
    if (zone.count < 10) return { reason: `the scan has ${zone.count} points here`, note: '', metrics: sizeMetrics };
    const sb = rmsOf(scanDistances(zone, beforeIndex, o[1]), zone.a);
    const sa = rmsOf(scanDistances(zone, new SurfaceIndex(partSoup(afterUnit.parts)), o[1]), zone.a);
    const subRes = beforeUnit !== undefined && change.p95M < P.subResolutionM;
    const scanRule: 'improves' | 'within-resolution' = subRes ? 'within-resolution' : 'improves';
    // the held-out photo
    const crop = v.cropFor(root);
    const held = await v.heldOut?.(crop);
    const support: ModelPart = supportDisc(o[0], o[1], o[2], rp.radiusM + 0.6);
    let pb: { ssim: number | null; gradientNcc: number | null } = { ssim: null, gradientNcc: null }, pa = pb;
    let heldPixels = 0;
    if (held) {
        const zoneR = rp.radiusM + 0.4;
        const b = heldOutScore(drawModelTopDown([support, ...(beforeUnit?.parts ?? [])], crop).image, held, o[0], o[2], zoneR);
        const a = heldOutScore(drawModelTopDown([support, ...afterUnit.parts], crop).image, held, o[0], o[2], zoneR);
        pb = b; pa = a; heldPixels = Math.min(a.pixels, b.pixels);
    }
    const metrics: MicroEdit['metrics'] = {
        before: { scanRmsM: sb.rms, scanWithin15: sb.within15, scanPoints: zone.count, photoSsim: pb.ssim, photoGradientNcc: pb.gradientNcc },
        after: { scanRmsM: sa.rms, scanWithin15: sa.within15, scanPoints: zone.count, photoSsim: pa.ssim, photoGradientNcc: pa.gradientNcc },
        ...sizeMetrics, scanRule
    };
    if (subRes) {
        if (sa.rms > sb.rms + P.subResolutionTolM) return { reason: `the scan: RMS ${sb.rms.toFixed(3)} -> ${sa.rms.toFixed(3)} m, more than ${P.subResolutionTolM} m worse for a step below the scan's resolution`, note: '', metrics };
    } else if (sa.rms > sb.rms - P.minGainM) return { reason: `the scan: RMS ${sb.rms.toFixed(3)} -> ${sa.rms.toFixed(3)} m, no better`, note: '', metrics };
    if (prop.rung === 0 && (sa.rms > P.maxFitRmsM || sa.within15 < P.minWithin15)) return { reason: `the scan: the solid explains its points to ${sa.rms.toFixed(3)} m RMS, ${(sa.within15 * 100).toFixed(0)}% within 15 cm (needs ${P.maxFitRmsM} m, ${P.minWithin15 * 100}%)`, note: '', metrics };
    if (!held) return { reason: 'no held-out photo to verify it against', note: '', metrics };
    if (heldPixels < 50) return { reason: `the held-out photo covers ${heldPixels} pixels of the unit`, note: '', metrics };
    // a model drawn flat has no variance: it correlates with nothing (0), not unscorable
    pb = { ssim: pb.ssim ?? 0, gradientNcc: pb.gradientNcc ?? 0 };
    pa = { ssim: pa.ssim ?? 0, gradientNcc: pa.gradientNcc ?? 0 };
    metrics.before.photoSsim = pb.ssim; metrics.before.photoGradientNcc = pb.gradientNcc;
    metrics.after.photoSsim = pa.ssim; metrics.after.photoGradientNcc = pa.gradientNcc;
    if (pa.ssim! < pb.ssim! - P.ssimTol) return { reason: `the held-out photo: SSIM ${pb.ssim!.toFixed(4)} -> ${pa.ssim!.toFixed(4)}, worse`, note: '', metrics };
    if (pa.gradientNcc! < pb.gradientNcc! - P.gradientTol) return { reason: `the held-out photo: gradient correlation ${pb.gradientNcc!.toFixed(4)} -> ${pa.gradientNcc!.toFixed(4)}, worse`, note: '', metrics };
    const note = `scan RMS ${sb.rms.toFixed(3)} -> ${sa.rms.toFixed(3)} m (${scanRule}); held-out SSIM ${pb.ssim!.toFixed(4)} -> ${pa.ssim!.toFixed(4)}, gradient ${pb.gradientNcc!.toFixed(4)} -> ${pa.gradientNcc!.toFixed(4)}; ${change.changedAreaM2.toFixed(2)} m2 moved, 95th percentile ${change.p95M.toFixed(3)} m`;
    return { note, metrics };
}

/** A flat disc on the support (the roof the unit stands on), drawn under the model so the zone is always the model's. */
export function supportDisc(cx: number, y: number, cz: number, r: number, n = 64): ModelPart {
    const positions = new Float32Array((n + 1) * 3), normals = new Float32Array((n + 1) * 3), indices = new Uint32Array(n * 3);
    positions.set([cx, y, cz], 0); normals.set([0, 1, 0], 0);
    for (let k = 0; k < n; k++) {
        const th = (2 * Math.PI * k) / n;
        positions.set([cx + r * Math.cos(th), y, cz + r * Math.sin(th)], (k + 1) * 3); normals.set([0, 1, 0], (k + 1) * 3);
        indices.set([0, k + 1, ((k + 1) % n) + 1], k * 3);
    }
    return { id: 'support', positions, normals, indices };
}

// =============================================================================
// The layer
// =============================================================================

/** The kept units as a staged GLB: one node per part, each in the median tile-photo colour it shows from above, labelled. */
export function writeMicroEditGlb(file: string, plan: MicroEditPlan, units: BuiltUnit[], colourOf: (part: ModelPart) => [number, number, number]): { path: string; bytes: number; nodes: number } {
    const byKey = new Map(plan.edits.map(e => [e.key, e]));
    const nodes: StagedGlbNode[] = [];
    for (const u of units) for (const p of u.parts) {
        const e = byKey.get(p.id)!;
        const linked = keptEdits(plan).filter(x => x.key === p.id || (x.kind === 'nudge' && x.parent === p.id) || (e.primitive === 'revolution' && x.primitive === 'revolution-recess' && x.parent === p.id));
        const [r, g, b] = colourOf(p).map(c => (c / 255) ** 2.2);
        const colors = new Float32Array(p.positions.length);
        for (let i = 0; i < colors.length; i += 3) { colors[i] = r; colors[i + 1] = g; colors[i + 2] = b; }
        nodes.push({
            name: `micro_edit_${p.id}`, positions: p.positions, normals: p.normals, indices: p.indices, colors,
            extras: {
                provenance: weakestLabel(linked.map(x => x.provenance)), confidence: Math.min(...linked.map(x => x.confidence)),
                method: `${MICRO_EDIT_VERSION}: saved micro-edits replayed from the building's plan, each one primitive or one parameter step, verified alone against the scan and a held-out photo`,
                colour: 'the median of the tile photo this part shows from above (photo-inferred)',
                edits: linked.map(x => ({ key: x.key, kind: x.kind, primitive: x.primitive, rung: x.rung, provenance: x.provenance, paramProvenance: x.paramProvenance, confidence: x.confidence, run: x.proposedBy.runId, reasons: x.evidence.reasons }))
            }
        });
    }
    const out = writeStagedGlbFile(file, nodes, { rootExtras: { sbMicroEdits: { version: MICRO_EDIT_VERSION, buildingId: plan.buildingId, kept: keptEdits(plan).length, runs: plan.runs.length } }, generator: 'scratchbox staged-location micro-edits' });
    return { ...out, nodes: nodes.length };
}

/** Is (x, y, z) inside a kept solid of the plan (grown by `marginM`)? The scan's own copy there is what the layer replaces. */
export function microEditContains(units: BuiltUnit[], plan: MicroEditPlan, x: number, y: number, z: number, marginM = 0.15): boolean {
    for (const u of units) {
        const root = plan.edits.find(e => e.key === u.root);
        if (!root) continue;
        const rp = effectiveParams(plan, root);
        if (y < u.origin[1] + 0.1 || y > u.origin[1] + rp.heightM + marginM) continue;
        if (Math.hypot(x - u.origin[0], z - u.origin[2]) <= rp.radiusM + marginM) return true;
    }
    return false;
}

function mean(v: number[]): number { return v.reduce((a, b) => a + b, 0) / Math.max(1, v.length); }
function stdev(v: number[]): number { const m = mean(v); return Math.sqrt(mean(v.map(x => (x - m) ** 2))); }
function round(v: number, d: number): number { return Math.round(v * 10 ** d) / 10 ** d; }
function roundSig(v: number): number { return Number(v.toPrecision(3)); }
