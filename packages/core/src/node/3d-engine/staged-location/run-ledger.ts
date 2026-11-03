/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The run ledger: one durable, machine-readable row per staged build and per photo-match judgement, appended to
 * <workspace>/.scratchbox/ledger/ — deliberately NOT under .scratchbox/cache/, so clearing the stage caches before an
 * uncached test build never takes the record of the builds already run.
 *
 * Each row says four things and nothing else:
 *   - the arm: what was being chosen (building pipeline, model service, district mode, and the request's own switches);
 *   - the features: what the build already measured, as continuous numbers (leaf tiles, source limits, triangles and
 *     vertices, fit residuals and coverage, provenance shares by triangle and area, timings);
 *   - the decision: which stages committed, degraded, were skipped or stopped, each degradation's reason code, and
 *     which gates failed;
 *   - the proof: the files that back it, as paths only (the run record, the fit report, the judge's report.json).
 *
 * It is a record, not a gate. Every write is wrapped: a failure is appended to ledger-errors.log and the build carries
 * on. Nothing here stores image bytes, model replies or credentials — paths and numbers only, like SourceRef.
 *
 * Why these fields: the judge's report already carries the cheap per-arm measurements (mask coverage, SSIM, edge
 * chamfer, colour deltaE) beside the scores it was given, and names the build runId each arm came from. A ledger of
 * those across many places is therefore the dataset any later calibration would need, assembled from work we already
 * do. It is kept honest by `judge.standIn`: a run the stand-in scored is marked as such, so its scores are never read
 * back as a model's.
 *
 * Concurrency: rows are appended with one `appendFileSync` of one line, and the files are opened O_APPEND, so two app
 * instances sharing a checkout interleave rows but not bytes. Readers skip any line that will not parse rather than
 * failing, so a torn line costs one row, never the file.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
    DegradationRecord, GateResult, ProvenanceLabel, SourceLimits, StageSummary, StagedLocationResult
} from '../../../common/spatial/staged-location-contracts';
import { stagedWorkspaceRoot } from './stage-cache';
import { stagedDistrictMode, stagedModelService, type StagedDistrictMode, type StagedModelService } from './staged-switches';

export const RUN_LEDGER_SCHEMA_BUILD = 'scratchbox.run-ledger.build/1' as const;
export const RUN_LEDGER_SCHEMA_JUDGE = 'scratchbox.run-ledger.judge/1' as const;

export const LEDGER_FILES = {
    builds: 'builds.jsonl',
    judgements: 'judgements.jsonl',
    errors: 'ledger-errors.log'
} as const;

/**
 * Where the ledger lives: SCRATCHBOX_LEDGER_DIR when set (a volume that outlives the checkout), else
 * <workspace>/.scratchbox/ledger. Never inside the stage cache, which is deleted before test builds.
 */
export function ledgerDir(env: NodeJS.ProcessEnv = process.env): string {
    const asked = (env.SCRATCHBOX_LEDGER_DIR ?? '').trim();
    return asked ? path.resolve(asked) : path.join(stagedWorkspaceRoot(), '.scratchbox', 'ledger');
}

// ----------------------------------------------------------------------------------------------------------------
// rows
// ----------------------------------------------------------------------------------------------------------------

/** How the build was configured: the switches whose effect a later comparison would want to hold constant. */
export interface BuildArm {
    /** 'j' or 'k' as the run resolved it; the request's value verbatim when it is neither. */
    pipeline: string;
    /** Pipeline J's model service; recorded whatever the pipeline, since the switch is independent of it. */
    modelService: StagedModelService;
    district: StagedDistrictMode;
    isolate: boolean;
    trees: boolean;
    /** Undefined when the request left it to the default; ignored by an isolate build. */
    radiusM?: number;
    relief?: boolean;
    enhance?: boolean;
    procedural?: boolean;
    /** How many steps the node graph overrode for this build (the keys, so a comparison can exclude them). */
    stepOverrides?: string[];
}

/** Continuous measurements the build already computed. Every field is a number or absent — never a category. */
export interface BuildFeatures {
    leafTiles: number;
    /** The radius the tiles really reach, which the leaf cap may cut short of the request. */
    radiusM: number;
    sizedTo: string;
    leafGeometricErrorM: number;
    meshEdgeP50M: number;
    meshResolvableM: number;
    texelM: number;
    photoResolvableM: number;
    totalTriangles: number;
    totalVertices: number;
    /** Triangles and area by provenance label, and the share of each that is not scan measurement. */
    trianglesByLabel: Partial<Record<string, number>>;
    areaM2ByLabel?: Partial<Record<string, number>>;
    generatedTriangleShare: number;
    /** The structure fit, when one ran. */
    fitCoverage?: number;
    fitScanToFitRmsM?: number;
    fitToScanRmsM?: number;
    fitUnobservedFaceAreaM2?: number;
    fitPassThroughAreaM2?: number;
    fitPrimitives?: number;
    /** The isolate's agreement with the pick, when a structure was isolated. */
    isolateIoU?: number;
    isolateAgreement?: number;
    geocodeToStructureM?: number;
    footprintAreaM2?: number;
    vectorFootprintIoU?: number;
    totalMs: number;
    firstVisualMs: number;
}

export interface BuildDecision {
    /** Stage counts by status, so a row is comparable without reading every summary. */
    stages: Partial<Record<string, number>>;
    /** Stages that committed, in order: the spine of what this build actually did. */
    committed: string[];
    degraded: string[];
    skipped: string[];
    /** One entry per degradation: enough to group rows by cause without the user-facing prose. */
    degradations: Array<{ stage: string; reasonCode: string; transient: boolean; provenanceAfter: ProvenanceLabel }>;
    /** Gates the structure fit failed, with the number that missed its threshold. */
    gatesFailed: Array<{ gate: string; value: number; threshold: number; unit: string }>;
    complexityGatePassed: boolean;
    complexityViolations: number;
    /** Stage cache verdicts: a row built from cache is not evidence about the current code. */
    cache: Record<string, string>;
    /** True when no stage was served from the cache: the only kind of row a comparison should trust. */
    uncached: boolean;
}

export interface BuildLedgerRow {
    schema: typeof RUN_LEDGER_SCHEMA_BUILD;
    atMs: number;
    atIso: string;
    runId: string;
    /** 'complete' | 'degraded' | 'stopped' as the result reports it; 'failed' when the call threw. */
    outcome: string;
    /** Why it is not complete, one sentence; absent on a complete build. */
    reason?: string;
    place: { query: string; resolvedAddress: string; lat: number; lng: number };
    arm: BuildArm;
    features?: BuildFeatures;
    decision: BuildDecision;
    /** Paths only. */
    proof: { runRecord?: string; fitReport?: string; artifactId?: string };
}

/** One arm of one judgement: the features it was scored on beside the scores it was given. */
export interface JudgeLedgerArm {
    id: string;
    label: string;
    scope?: string;
    triangles?: number;
    baseline?: boolean;
    /** The build this arm came from, when the judge could name one: joins this row to a build row. */
    runId?: string;
    /** Secondary pixel measurements inside the target mask, averaged over the judged views. */
    pixel?: { coverage: number | null; ssim: number | null; edgeChamferPx: number | null; colourDeltaE: number | null };
    /** Mean score per criterion; null where the judge returned none. */
    scores: Partial<Record<string, number | null>>;
    /** Spread of the overall score across views and across repeat runs: how settled the label is. */
    overallViewSd?: number;
    overallRunSd?: number;
}

export interface JudgeLedgerRow {
    schema: typeof RUN_LEDGER_SCHEMA_JUDGE;
    atMs: number;
    atIso: string;
    evalId: string;
    place: string;
    origin?: { lat: number; lng: number; heightMeters?: number };
    /**
     * Which judge answered. `standIn` is true when no model scored it: those scores are a stand-in's and must never be
     * read back as a model's judgement.
     */
    judge: { requested?: string; answered?: string; skipped: string[]; standIn: boolean };
    runsPerView?: number;
    inContext?: boolean;
    /** The build or scan the arms were judged against, in words. */
    reference?: string;
    /** How much held-out evidence the judgement actually rested on. */
    heldOut?: { panosNear?: number; usedByBuild?: number; candidates?: number; fetched?: number; registered?: number; unregistered?: number; judged?: number };
    arms: JudgeLedgerArm[];
    proof: { reportJson?: string; outDir?: string; grids?: string[] };
}

export type LedgerRow = BuildLedgerRow | JudgeLedgerRow;

// ----------------------------------------------------------------------------------------------------------------
// building the rows (pure: no fs, so a test asserts the numbers)
// ----------------------------------------------------------------------------------------------------------------

/** The request fields the arm is read from; a subset of StagedLocationRequest, so callers need not pass the whole thing. */
export interface BuildArmRequest {
    query: string;
    isolate: boolean;
    trees: boolean;
    radiusM?: number;
    relief?: boolean;
    enhance?: boolean;
    procedural?: boolean;
    pipeline?: string;
    modelService?: string;
    steps?: Record<string, boolean>;
}

/** The arm as the run resolved it: the request's own value when it names one, else the environment's default. */
export function buildArm(request: BuildArmRequest, env: NodeJS.ProcessEnv = process.env): BuildArm {
    const asked = (request.pipeline ?? '').trim().toLowerCase();
    const envPipeline = (env.SCRATCHBOX_STAGED_BUILDING_PIPELINE ?? '').trim().toLowerCase();
    const steps = Object.keys(request.steps ?? {});
    return {
        pipeline: asked || envPipeline || (request.procedural ? 'j' : 'k'),
        modelService: stagedModelService(request, env),
        district: stagedDistrictMode(env),
        isolate: !!request.isolate,
        trees: !!request.trees,
        ...(request.radiusM !== undefined ? { radiusM: request.radiusM } : {}),
        ...(request.relief !== undefined ? { relief: request.relief } : {}),
        ...(request.enhance !== undefined ? { enhance: request.enhance } : {}),
        ...(request.procedural !== undefined ? { procedural: request.procedural } : {}),
        ...(steps.length ? { stepOverrides: steps.sort() } : {})
    };
}

/** Which labels are not scan measurement, by name (NON_MEASURED_PROVENANCE_LABELS plus the fills that only appear in a summary). */
const NON_MEASURED_LABEL_NAMES = new Set<string>(['generated', 'photo-inferred', 'photo-corrected', 'fitted-unobserved']);

function round(v: number, places: number): number {
    const f = 10 ** places;
    return Math.round(v * f) / f;
}

function stageTally(stages: readonly StageSummary[]): BuildDecision['stages'] {
    const out: Record<string, number> = {};
    for (const s of stages) out[s.status] = (out[s.status] ?? 0) + 1;
    return out;
}

function ofStatus(stages: readonly StageSummary[], status: string): string[] {
    return stages.filter(s => s.status === status).map(s => s.stage);
}

function decisionOf(
    stages: readonly StageSummary[],
    degradations: readonly DegradationRecord[],
    gates: readonly GateResult[],
    complexity: { passed: boolean; violations: readonly string[] } | undefined,
    cache: Record<string, string>
): BuildDecision {
    return {
        stages: stageTally(stages),
        committed: ofStatus(stages, 'committed'),
        degraded: ofStatus(stages, 'degraded'),
        skipped: ofStatus(stages, 'skipped'),
        degradations: degradations.map(d => ({ stage: d.stage, reasonCode: d.reasonCode, transient: d.transient, provenanceAfter: d.provenanceAfter })),
        gatesFailed: gates.filter(g => !g.passed).map(g => ({ gate: g.gate, value: g.value, threshold: g.threshold, unit: g.unit })),
        complexityGatePassed: complexity?.passed ?? false,
        complexityViolations: complexity?.violations.length ?? 0,
        cache: { ...cache },
        uncached: Object.values(cache).every(v => v !== 'hit')
    };
}

function featuresOf(result: StagedLocationResult): BuildFeatures {
    const limits: SourceLimits = result.sourceLimits;
    const trianglesByLabel: Record<string, number> = {};
    const areaByLabel: Record<string, number> = {};
    let total = 0;
    let nonMeasured = 0;
    let anyArea = false;
    for (const p of result.provenance) {
        const label = String(p.label);
        trianglesByLabel[label] = (trianglesByLabel[label] ?? 0) + p.triangles;
        total += p.triangles;
        if (NON_MEASURED_LABEL_NAMES.has(label)) nonMeasured += p.triangles;
        if (typeof p.areaM2 === 'number') { areaByLabel[label] = round((areaByLabel[label] ?? 0) + p.areaM2, 2); anyArea = true; }
    }
    const fit = result.structureFit;
    const st = result.structure;
    return {
        leafTiles: result.extraction.leafTiles,
        radiusM: result.extraction.radiusM,
        sizedTo: result.extraction.sizedTo,
        leafGeometricErrorM: limits.leafGeometricErrorM,
        meshEdgeP50M: limits.meshEdgeP50M,
        meshResolvableM: limits.meshResolvableM,
        texelM: limits.texelM,
        photoResolvableM: limits.photoResolvableM,
        totalTriangles: result.complexityGate.totalTriangles,
        totalVertices: result.complexityGate.totalVertices,
        trianglesByLabel,
        ...(anyArea ? { areaM2ByLabel: areaByLabel } : {}),
        generatedTriangleShare: total > 0 ? round(nonMeasured / total, 4) : 0,
        ...(fit ? {
            fitCoverage: fit.coverage, fitScanToFitRmsM: fit.scanToFitRmsM, fitToScanRmsM: fit.fitToScanRmsM,
            fitUnobservedFaceAreaM2: fit.unobservedFaceAreaM2, fitPassThroughAreaM2: fit.passThroughAreaM2, fitPrimitives: fit.primitives
        } : {}),
        ...(st?.isolateIoU !== undefined ? { isolateIoU: st.isolateIoU } : {}),
        ...(st?.isolateAgreement !== undefined ? { isolateAgreement: st.isolateAgreement } : {}),
        ...(st ? { geocodeToStructureM: round(st.geocodeToStructureM, 2), footprintAreaM2: round(st.footprintAreaM2, 2) } : {}),
        ...(st?.vectorFootprintIoU !== undefined ? { vectorFootprintIoU: st.vectorFootprintIoU } : {}),
        totalMs: result.timingsMs.total,
        firstVisualMs: result.timingsMs.firstVisual
    };
}

/** The row for a build that returned a result (complete, degraded or stopped). */
export function buildRowFromResult(args: {
    runId: string;
    request: BuildArmRequest;
    result: StagedLocationResult;
    runRecord?: string;
    artifactId?: string;
    now?: () => number;
    env?: NodeJS.ProcessEnv;
}): BuildLedgerRow {
    const atMs = (args.now ?? Date.now)();
    const r = args.result;
    const reason = r.stages.find(s => s.status === 'degraded' || s.status === 'failed')?.reason;
    return {
        schema: RUN_LEDGER_SCHEMA_BUILD,
        atMs,
        atIso: new Date(atMs).toISOString(),
        runId: args.runId,
        outcome: r.status,
        ...(r.status !== 'complete' && reason ? { reason } : {}),
        place: { query: r.place.query, resolvedAddress: r.place.resolvedAddress, lat: r.place.lat, lng: r.place.lng },
        arm: buildArm(args.request, args.env),
        features: featuresOf(r),
        decision: decisionOf(r.stages, r.degradations, r.structureFit?.gates ?? [], r.complexityGate, r.cache),
        proof: {
            ...(args.runRecord ? { runRecord: args.runRecord } : {}),
            ...(r.structureFit?.reportPath ? { fitReport: r.structureFit.reportPath } : {}),
            ...(args.artifactId ? { artifactId: args.artifactId } : {})
        }
    };
}

/**
 * The row for a build that threw: a hard failure, an error nothing could degrade, or a Stop. It has no result, so it
 * carries the stage summaries the run had reached and the error — a failure is evidence too, and the commonest kind.
 */
export function buildRowFromFailure(args: {
    runId: string;
    request: BuildArmRequest;
    outcome: 'failed' | 'stopped';
    reason: string;
    place?: { query: string; resolvedAddress: string; lat: number; lng: number };
    stages: readonly StageSummary[];
    degradations: readonly DegradationRecord[];
    cache?: Record<string, string>;
    runRecord?: string;
    now?: () => number;
    env?: NodeJS.ProcessEnv;
}): BuildLedgerRow {
    const atMs = (args.now ?? Date.now)();
    return {
        schema: RUN_LEDGER_SCHEMA_BUILD,
        atMs,
        atIso: new Date(atMs).toISOString(),
        runId: args.runId,
        outcome: args.outcome,
        reason: args.reason,
        place: args.place ?? { query: args.request.query, resolvedAddress: '', lat: 0, lng: 0 },
        arm: buildArm(args.request, args.env),
        decision: decisionOf(args.stages, args.degradations, [], undefined, args.cache ?? {}),
        proof: { ...(args.runRecord ? { runRecord: args.runRecord } : {}) }
    };
}

/** The shape of photo_match_evaluate's report this row is read from; only the fields the ledger keeps. */
export interface JudgeReportLike {
    evalId?: string;
    place?: string;
    origin?: { lat: number; lng: number; heightMeters?: number };
    reference?: string;
    inContext?: boolean;
    runsPerView?: number;
    judgeModel?: { requested?: string; answered?: string; skipped?: unknown[] };
    arms?: Array<{ id?: string; label?: string; scope?: string; triangles?: number; baseline?: boolean; runId?: string }>;
    scores?: Record<string, Record<string, { mean?: number | null; viewSd?: number; runSd?: number } | undefined>>;
    pixelMetrics?: { mean?: Record<string, { coverage?: number | null; ssim?: number | null; edgeChamferPx?: number | null; colourDeltaE?: number | null } | undefined> };
    heldOut?: { panosNear?: number; usedByBuild?: number; candidates?: number; fetched?: number; registered?: number; unregistered?: unknown[]; judged?: number };
    grids?: unknown[];
    outDir?: string;
}

/** The criteria kept per arm, in a fixed order, so every row has the same columns. */
export const JUDGE_CRITERIA = ['shape', 'materials', 'detail', 'errors', 'overall', 'realism', 'identity'] as const;

/** The row for one photo-match judgement, read from the report it just wrote. */
export function judgeRowFromReport(report: JudgeReportLike, opts: { reportJson?: string; now?: () => number } = {}): JudgeLedgerRow {
    const atMs = (opts.now ?? Date.now)();
    const answered = report.judgeModel?.answered;
    const scores = report.scores ?? {};
    const pixel = report.pixelMetrics?.mean ?? {};
    const arms: JudgeLedgerArm[] = (report.arms ?? []).map(a => {
        const id = String(a.id ?? '');
        const s = scores[id] ?? {};
        const kept: Partial<Record<string, number | null>> = {};
        for (const c of JUDGE_CRITERIA) kept[c] = s[c]?.mean ?? null;
        const p = pixel[id];
        return {
            id,
            label: String(a.label ?? ''),
            ...(a.scope ? { scope: a.scope } : {}),
            ...(a.triangles !== undefined ? { triangles: a.triangles } : {}),
            ...(a.baseline ? { baseline: true } : {}),
            ...(a.runId ? { runId: a.runId } : {}),
            ...(p ? { pixel: { coverage: p.coverage ?? null, ssim: p.ssim ?? null, edgeChamferPx: p.edgeChamferPx ?? null, colourDeltaE: p.colourDeltaE ?? null } } : {}),
            scores: kept,
            ...(s.overall?.viewSd !== undefined ? { overallViewSd: s.overall.viewSd } : {}),
            ...(s.overall?.runSd !== undefined ? { overallRunSd: s.overall.runSd } : {})
        };
    });
    const h = report.heldOut;
    return {
        schema: RUN_LEDGER_SCHEMA_JUDGE,
        atMs,
        atIso: new Date(atMs).toISOString(),
        evalId: String(report.evalId ?? ''),
        place: String(report.place ?? ''),
        ...(report.origin ? { origin: report.origin } : {}),
        judge: {
            ...(report.judgeModel?.requested ? { requested: report.judgeModel.requested } : {}),
            ...(answered ? { answered } : {}),
            skipped: (report.judgeModel?.skipped ?? []).map(String),
            standIn: !answered || answered === 'stand-in'
        },
        ...(report.runsPerView !== undefined ? { runsPerView: report.runsPerView } : {}),
        ...(report.inContext !== undefined ? { inContext: report.inContext } : {}),
        ...(report.reference ? { reference: report.reference } : {}),
        ...(h ? {
            heldOut: {
                ...(h.panosNear !== undefined ? { panosNear: h.panosNear } : {}),
                ...(h.usedByBuild !== undefined ? { usedByBuild: h.usedByBuild } : {}),
                ...(h.candidates !== undefined ? { candidates: h.candidates } : {}),
                ...(h.fetched !== undefined ? { fetched: h.fetched } : {}),
                ...(h.registered !== undefined ? { registered: h.registered } : {}),
                ...(h.unregistered ? { unregistered: h.unregistered.length } : {}),
                ...(h.judged !== undefined ? { judged: h.judged } : {})
            }
        } : {}),
        arms,
        proof: {
            ...(opts.reportJson ? { reportJson: opts.reportJson } : {}),
            ...(report.outDir ? { outDir: report.outDir } : {}),
            ...(report.grids?.length ? { grids: report.grids.map(String) } : {})
        }
    };
}

// ----------------------------------------------------------------------------------------------------------------
// appending and reading
// ----------------------------------------------------------------------------------------------------------------

/** Appends one line to a ledger file. Never throws: a failure goes to ledger-errors.log, and that failure is swallowed too. */
function append(file: string, line: string, dir: string): void {
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, file), line);
    } catch (err) {
        try {
            fs.appendFileSync(path.join(dir, LEDGER_FILES.errors), `${new Date().toISOString()} ${file}: ${(err as Error)?.message ?? String(err)}\n`);
        } catch { /* the ledger is a record, never a reason a build fails */ }
    }
}

/** One line of JSON: no newlines inside a row, so one torn write costs one row. */
function lineOf(row: LedgerRow): string {
    return `${JSON.stringify(row).replace(/\n/g, ' ')}\n`;
}

/**
 * The ledger a caller that names no directory writes to: undefined under a test runner, so a fixture build or a
 * stand-in judgement from the suite never enters the dataset a later calibration would read. A test that means to
 * exercise the write path passes its own directory, and SCRATCHBOX_LEDGER_DIR overrides the guard.
 */
export function defaultLedgerTarget(env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (env.VITEST && !(env.SCRATCHBOX_LEDGER_DIR ?? '').trim()) return undefined;
    return ledgerDir(env);
}

export function appendBuildRow(row: BuildLedgerRow, dir?: string): void {
    const target = dir ?? defaultLedgerTarget();
    if (target) append(LEDGER_FILES.builds, lineOf(row), target);
}

export function appendJudgeRow(row: JudgeLedgerRow, dir?: string): void {
    const target = dir ?? defaultLedgerTarget();
    if (target) append(LEDGER_FILES.judgements, lineOf(row), target);
}

/** Every row of a ledger file, oldest first; lines that will not parse are skipped and counted. */
export function readLedger<T extends LedgerRow>(file: string, dir = ledgerDir()): { rows: T[]; skipped: number } {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) return { rows: [], skipped: 0 };
    const rows: T[] = [];
    let skipped = 0;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
            rows.push(JSON.parse(line) as T);
        } catch {
            skipped += 1;
        }
    }
    return { rows, skipped };
}

export function readBuildRows(dir = ledgerDir()): { rows: BuildLedgerRow[]; skipped: number } {
    return readLedger<BuildLedgerRow>(LEDGER_FILES.builds, dir);
}

export function readJudgeRows(dir = ledgerDir()): { rows: JudgeLedgerRow[]; skipped: number } {
    return readLedger<JudgeLedgerRow>(LEDGER_FILES.judgements, dir);
}

/**
 * The judgement rows flattened to one row per arm, each joined to its build row by runId where both exist: the table a
 * later calibration would read. `labelled` counts the arms a real model scored — the only ones whose scores are labels.
 */
export function flattenForAnalysis(dir = ledgerDir()): {
    rows: Array<{ evalId: string; place: string; armId: string; standIn: boolean; runId?: string; arm?: BuildArm; features?: BuildFeatures; pixel?: JudgeLedgerArm['pixel']; scores: JudgeLedgerArm['scores'] }>;
    labelled: number;
    places: number;
} {
    const builds = new Map(readBuildRows(dir).rows.map(b => [b.runId, b]));
    const rows: Array<{ evalId: string; place: string; armId: string; standIn: boolean; runId?: string; arm?: BuildArm; features?: BuildFeatures; pixel?: JudgeLedgerArm['pixel']; scores: JudgeLedgerArm['scores'] }> = [];
    const places = new Set<string>();
    let labelled = 0;
    for (const j of readJudgeRows(dir).rows) {
        places.add(j.place);
        for (const a of j.arms) {
            const b = a.runId ? builds.get(a.runId) : undefined;
            if (!j.judge.standIn) labelled += 1;
            rows.push({
                evalId: j.evalId, place: j.place, armId: a.id, standIn: j.judge.standIn,
                ...(a.runId ? { runId: a.runId } : {}),
                ...(b ? { arm: b.arm, ...(b.features ? { features: b.features } : {}) } : {}),
                ...(a.pixel ? { pixel: a.pixel } : {}),
                scores: a.scores
            });
        }
    }
    return { rows, labelled, places: places.size };
}
