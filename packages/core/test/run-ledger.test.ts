/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The run ledger (run-ledger.ts): a build result and a photo-match report turned into one durable row each, the
 * numbers they carry (provenance shares, fit residuals, per-arm pixel measurements) read back off disk, and the three
 * properties the ledger exists for — it lives outside the stage cache, a stand-in judgement is marked as one, and a
 * torn line costs one row rather than the file.
 *
 * The judge fixture mirrors the shape photo_match_evaluate really writes (verified against
 * .scratchbox/cache/photo_match/<evalId>/report.json): scores[arm][criterion].mean, pixelMetrics.mean[arm], arms[].runId.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { StagedLocationResult } from '../src/common/spatial/staged-location-contracts';
import {
    appendBuildRow, appendJudgeRow, buildArm, buildRowFromFailure, buildRowFromResult, defaultLedgerTarget,
    flattenForAnalysis, JUDGE_CRITERIA, judgeRowFromReport, LEDGER_FILES, ledgerDir, readBuildRows, readJudgeRows,
    RUN_LEDGER_SCHEMA_BUILD, RUN_LEDGER_SCHEMA_JUDGE, type JudgeReportLike
} from '../src/node/3d-engine/staged-location/run-ledger';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ledger-'));

const REQUEST = { query: 'Empire State Building', isolate: true, trees: false, pipeline: 'k', relief: true };

/** A result with the fields the ledger reads; everything else a build returns is irrelevant to a row. */
function result(over: Partial<StagedLocationResult> = {}): StagedLocationResult {
    return {
        success: true,
        status: 'complete',
        place: { query: 'Empire State Building', resolvedAddress: '20 W 34th St., New York, NY 10001, USA', lat: 40.748441, lng: -73.985664 },
        structure: { seed: [0, 0], geocodeToStructureM: 12.3456, footprintAreaM2: 8361.274, extractionRadiusM: 180, containmentRounds: 2, isolateIoU: 0.91, isolateAgreement: 0.84, vectorFootprintIoU: 0.88 },
        extraction: { radiusM: 180, sizedTo: 'structure', leafTiles: 412, cached: false, geometricErrorM: 2.0064, texelM: 0.154, attribution: ['Map data ©Google'] },
        stages: [
            { stage: 'resolve', order: 0, title: 'Resolve', source: 'Google Places', status: 'committed', layerIds: [], timings: { startedAtMs: 0, cached: false }, degradationIds: [] },
            { stage: 'tiles', order: 1, title: 'Tiles', source: '412 leaves', status: 'committed', layerIds: ['l1'], timings: { startedAtMs: 0, cached: false }, degradationIds: [] },
            { stage: 'remesh', order: 2, title: 'Remesh', source: 'tile_refine', status: 'degraded', reason: 'the relief carve found no contrast step', layerIds: ['l3'], timings: { startedAtMs: 0, cached: false }, degradationIds: ['d-relief'] },
            { stage: 'textures', order: 3, title: 'Textures', source: '', status: 'skipped', reason: 'no texture pass was asked for', layerIds: [], timings: { startedAtMs: 0, cached: false }, degradationIds: [] }
        ],
        degradations: [{
            id: 'd-relief', stage: 'remesh', part: { description: 'the north facade' }, intended: 'carved relief',
            fellTo: 'the flat fitted face', provenanceAfter: 'fitted', reasonCode: 'no_contrast_step',
            reason: 'the photo shows no step to carve', transient: false, atMs: 0
        }],
        provenance: [
            { label: 'as-scanned', objects: 2, triangles: 60_000, areaM2: 12_000.5 },
            { label: 'remeshed', objects: 1, triangles: 20_000, areaM2: 4_000.25 },
            { label: 'photo-inferred', objects: 1, triangles: 15_000, areaM2: 2_500 },
            { label: 'generated', objects: 1, triangles: 5_000, areaM2: 500 }
        ],
        structureFit: {
            buildingId: 'b1', accepted: true, primitives: 23, scanToFitRmsM: 0.032, fitToScanRmsM: 0.041, coverage: 0.93,
            passThroughAreaM2: 120.5, unobservedFaceAreaM2: 44.2, reportPath: '/w/.scratchbox/cache/scan_fit/abc/report.json',
            corrections: [],
            gates: [
                { gate: 'scan→fit rms', value: 0.032, threshold: 0.05, comparison: '<=', passed: true, unit: 'm' },
                { gate: 'coverage', value: 0.93, threshold: 0.95, comparison: '>=', passed: false, unit: 'ratio' }
            ]
        },
        complexityGate: { passed: true, totalVertices: 520_000, totalTriangles: 100_000, violations: [], exemptions: ['measured geometry'] },
        sourceLimits: { leafGeometricErrorM: 2.0064, meshEdgeP50M: 0.69, meshResolvableM: 0.69, texelM: 0.154, photoResolvableM: 0.31 },
        timingsMs: { total: 184_000, firstVisual: 21_000, byStage: { tiles: 40_000 } },
        cache: { resolve: 'miss', tiles: 'miss', remesh: 'miss' },
        artifact: null,
        digest: 'built',
        summary: 'built',
        ...over
    } as StagedLocationResult;
}

const JUDGE_REPORT: JudgeReportLike = {
    evalId: 'empire_state_building_20_w_34th__20261031T190547_779e',
    place: 'Empire State Building, 20 W 34th St., New York, NY 10001, USA',
    origin: { lat: 40.748441, lng: -73.985664, heightMeters: -18.657 },
    reference: 'staged run 7f594cd6 (its seam-welded scan)',
    inContext: true,
    runsPerView: 1,
    judgeModel: { requested: 'gemini-4-argon', answered: 'gemini-4-argon', skipped: [] },
    arms: [
        { id: 'raw', label: 'RAW SCAN (CUT TO TARGET)', scope: 'target', triangles: 95_646, baseline: true },
        { id: 'K', label: 'PIPELINE K HERO', scope: 'target', triangles: 941_198, runId: 'deadbeef' }
    ],
    scores: {
        raw: { shape: { mean: 9.75, viewSd: 0.43, runSd: 0 }, materials: { mean: 9.5 }, detail: { mean: 9 }, errors: { mean: 9.75 }, overall: { mean: 9.75, viewSd: 0.43, runSd: 0 }, realism: { mean: null }, identity: { mean: null } },
        K: { shape: { mean: 7.25, viewSd: 1.1, runSd: 0.2 }, materials: { mean: 6 }, detail: { mean: 6.5 }, errors: { mean: 7 }, overall: { mean: 6.75, viewSd: 1.1, runSd: 0.2 }, realism: { mean: 6.25 }, identity: { mean: 8 } }
    },
    pixelMetrics: {
        mean: {
            raw: { coverage: 1, ssim: 0.99, edgeChamferPx: 0.309, colourDeltaE: 0.263 },
            K: { coverage: 0.991, ssim: 0.353, edgeChamferPx: 9.361, colourDeltaE: 53.823 }
        }
    },
    heldOut: { panosNear: 71, usedByBuild: 16, candidates: 31, fetched: 8, registered: 6, unregistered: [{}, {}], judged: 4 },
    grids: ['/w/out/view1.jpg', '/w/out/view2.jpg'],
    outDir: '/w/out'
};

describe('run ledger: where it lives', () => {
    it('is outside the stage cache, so clearing caches before an uncached build keeps it', () => {
        const dir = ledgerDir({});
        expect(dir.endsWith(path.join('.scratchbox', 'ledger'))).toBe(true);
        expect(dir).not.toContain(`${path.sep}cache${path.sep}`);
        expect(ledgerDir({ SCRATCHBOX_LEDGER_DIR: '/Volumes/Scratchbox/ledger' })).toBe('/Volumes/Scratchbox/ledger');
    });

    it('writes nothing to the real ledger from a test run, so fixtures never enter the dataset', () => {
        // the suite's own builds and stand-in judgements would otherwise be read back as evidence
        expect(defaultLedgerTarget({ VITEST: 'true' })).toBeUndefined();
        expect(defaultLedgerTarget({ VITEST: 'true', SCRATCHBOX_LEDGER_DIR: '/tmp/ledger' })).toBe('/tmp/ledger');
        expect(defaultLedgerTarget({})).toBe(ledgerDir({}));
        // this very suite runs under VITEST: an append that names no directory is a no-op
        const before = readJudgeRows(ledgerDir()).rows.length;
        appendJudgeRow(judgeRowFromReport(JUDGE_REPORT));
        expect(readJudgeRows(ledgerDir()).rows.length).toBe(before);
    });
});

describe('run ledger: the build row', () => {
    it('reads the arm from the request and the environment, request first', () => {
        expect(buildArm(REQUEST, { SCRATCHBOX_STAGED_BUILDING_PIPELINE: 'j', SCRATCHBOX_STAGED_DISTRICT: 'scan' }))
            .toMatchObject({ pipeline: 'k', district: 'scan', modelService: 'trellis', isolate: true, trees: false, relief: true });
        expect(buildArm({ query: 'x', isolate: true, trees: false }, { SCRATCHBOX_STAGED_BUILDING_PIPELINE: 'j', SCRATCHBOX_STAGED_MODEL_SERVICE: 'trellis' }))
            .toMatchObject({ pipeline: 'j', modelService: 'trellis', district: 'massing' });
        expect(buildArm({ query: 'x', isolate: true, trees: false, steps: { 'twin.roofShadow': false, 'remesh.occlusion': true } }, {}).stepOverrides)
            .toEqual(['remesh.occlusion', 'twin.roofShadow']);
    });

    it('turns a result into measurements: provenance shares, fit residuals, failed gates', () => {
        const row = buildRowFromResult({ runId: 'deadbeef', request: REQUEST, result: result(), runRecord: '/w/runs/deadbeef/stages.json', artifactId: 'scene-stg-deadbeef', env: {}, now: () => 1_700_000_000_000 });

        expect(row.schema).toBe(RUN_LEDGER_SCHEMA_BUILD);
        expect(row.outcome).toBe('complete');
        expect(row.atIso).toBe('2023-11-14T22:13:20.000Z');

        // 15,000 photo-inferred + 5,000 generated of 100,000 provenance triangles
        expect(row.features!.generatedTriangleShare).toBe(0.2);
        expect(row.features!.trianglesByLabel['as-scanned']).toBe(60_000);
        expect(row.features!.areaM2ByLabel!['as-scanned']).toBe(12_000.5);
        expect(row.features!.meshResolvableM).toBe(0.69);
        expect(row.features!.photoResolvableM).toBe(0.31);
        expect(row.features!.fitCoverage).toBe(0.93);
        expect(row.features!.fitScanToFitRmsM).toBe(0.032);
        expect(row.features!.geocodeToStructureM).toBe(12.35);
        expect(row.features!.footprintAreaM2).toBe(8361.27);
        expect(row.features!.totalTriangles).toBe(100_000);
        expect(row.features!.firstVisualMs).toBe(21_000);

        expect(row.decision.stages).toEqual({ committed: 2, degraded: 1, skipped: 1 });
        expect(row.decision.committed).toEqual(['resolve', 'tiles']);
        expect(row.decision.degraded).toEqual(['remesh']);
        expect(row.decision.degradations).toEqual([{ stage: 'remesh', reasonCode: 'no_contrast_step', transient: false, provenanceAfter: 'fitted' }]);
        expect(row.decision.gatesFailed).toEqual([{ gate: 'coverage', value: 0.93, threshold: 0.95, unit: 'ratio' }]);
        expect(row.decision.uncached).toBe(true);
        expect(row.proof).toEqual({ runRecord: '/w/runs/deadbeef/stages.json', fitReport: '/w/.scratchbox/cache/scan_fit/abc/report.json', artifactId: 'scene-stg-deadbeef' });
    });

    it('marks a row whose stages came from the cache, so it is not read as evidence about current code', () => {
        const row = buildRowFromResult({ runId: 'deadbeef', request: REQUEST, result: result({ cache: { tiles: 'hit', remesh: 'miss' } }), env: {} });
        expect(row.decision.uncached).toBe(false);
        expect(row.decision.cache).toEqual({ tiles: 'hit', remesh: 'miss' });
    });

    it('records a failed build, with the stages it had reached and no features', () => {
        const row = buildRowFromFailure({
            runId: 'cafebabe', request: REQUEST, outcome: 'failed', reason: 'the tiles do not cover it',
            stages: result().stages, degradations: result().degradations, cache: { resolve: 'miss' }, env: {}
        });
        expect(row.outcome).toBe('failed');
        expect(row.reason).toBe('the tiles do not cover it');
        expect(row.features).toBeUndefined();
        expect(row.decision.degradations).toHaveLength(1);
        expect(row.place).toEqual({ query: 'Empire State Building', resolvedAddress: '', lat: 0, lng: 0 });
    });

    it('carries a degraded build\'s reason', () => {
        const row = buildRowFromResult({ runId: 'deadbeef', request: REQUEST, result: result({ status: 'degraded' }), env: {} });
        expect(row.outcome).toBe('degraded');
        expect(row.reason).toBe('the relief carve found no contrast step');
    });
});

describe('run ledger: the judge row', () => {
    it('keeps every criterion as a column, nulls included, with each arm\'s pixel measurements', () => {
        const row = judgeRowFromReport(JUDGE_REPORT, { reportJson: '/w/out/report.json', now: () => 1_700_000_000_000 });

        expect(row.schema).toBe(RUN_LEDGER_SCHEMA_JUDGE);
        expect(row.judge).toEqual({ requested: 'gemini-4-argon', answered: 'gemini-4-argon', skipped: [], standIn: false });
        expect(row.arms.map(a => a.id)).toEqual(['raw', 'K']);

        const k = row.arms.find(a => a.id === 'K')!;
        expect(Object.keys(k.scores)).toEqual([...JUDGE_CRITERIA]);
        expect(k.scores.overall).toBe(6.75);
        expect(k.scores.identity).toBe(8);
        expect(k.overallViewSd).toBe(1.1);
        expect(k.overallRunSd).toBe(0.2);
        expect(k.pixel).toEqual({ coverage: 0.991, ssim: 0.353, edgeChamferPx: 9.361, colourDeltaE: 53.823 });
        expect(k.runId).toBe('deadbeef');
        expect(k.triangles).toBe(941_198);

        const raw = row.arms.find(a => a.id === 'raw')!;
        expect(raw.baseline).toBe(true);
        expect(raw.scores.realism).toBeNull();

        expect(row.heldOut).toEqual({ panosNear: 71, usedByBuild: 16, candidates: 31, fetched: 8, registered: 6, unregistered: 2, judged: 4 });
        expect(row.proof.grids).toHaveLength(2);
    });

    it('marks a stand-in judgement, so its scores are never read as a model\'s', () => {
        expect(judgeRowFromReport({ ...JUDGE_REPORT, judgeModel: { requested: 'stand-in', answered: 'stand-in', skipped: ['gemini-4-argon'] } }).judge)
            .toEqual({ requested: 'stand-in', answered: 'stand-in', skipped: ['gemini-4-argon'], standIn: true });
        expect(judgeRowFromReport({ ...JUDGE_REPORT, judgeModel: undefined }).judge.standIn).toBe(true);
    });
});

describe('run ledger: appending and reading back', () => {
    it('appends one line per row and reads the numbers back off disk', () => {
        const dir = tmp();
        appendBuildRow(buildRowFromResult({ runId: 'deadbeef', request: REQUEST, result: result(), env: {} }), dir);
        appendBuildRow(buildRowFromFailure({ runId: 'cafebabe', request: REQUEST, outcome: 'stopped', reason: 'stopped by the chat', stages: [], degradations: [], env: {} }), dir);
        appendJudgeRow(judgeRowFromReport(JUDGE_REPORT), dir);

        const text = fs.readFileSync(path.join(dir, LEDGER_FILES.builds), 'utf8');
        expect(text.trimEnd().split('\n')).toHaveLength(2);
        expect(text.endsWith('\n')).toBe(true);

        const builds = readBuildRows(dir);
        expect(builds.skipped).toBe(0);
        expect(builds.rows.map(r => r.outcome)).toEqual(['complete', 'stopped']);
        expect(builds.rows[0].features!.generatedTriangleShare).toBe(0.2);
        expect(readJudgeRows(dir).rows[0].arms).toHaveLength(2);
    });

    it('skips a torn line instead of failing the file', () => {
        const dir = tmp();
        appendBuildRow(buildRowFromResult({ runId: 'deadbeef', request: REQUEST, result: result(), env: {} }), dir);
        fs.appendFileSync(path.join(dir, LEDGER_FILES.builds), '{"schema":"scratchbox.run-ledger.bui\n');
        appendBuildRow(buildRowFromFailure({ runId: 'cafebabe', request: REQUEST, outcome: 'failed', reason: 'x', stages: [], degradations: [], env: {} }), dir);

        const read = readBuildRows(dir);
        expect(read.rows).toHaveLength(2);
        expect(read.skipped).toBe(1);
    });

    it('never throws when the ledger cannot be written, and says so in ledger-errors.log', () => {
        const dir = tmp();
        // a file where the directory must go: mkdir fails, so the append must fail quietly
        const blocked = path.join(dir, 'blocked');
        fs.writeFileSync(blocked, 'not a directory');
        expect(() => appendBuildRow(buildRowFromResult({ runId: 'deadbeef', request: REQUEST, result: result(), env: {} }), path.join(blocked, 'ledger'))).not.toThrow();
        expect(readBuildRows(path.join(blocked, 'ledger')).rows).toEqual([]);
    });

    it('joins each judged arm to its build row for analysis, and counts only model-scored arms as labelled', () => {
        const dir = tmp();
        appendBuildRow(buildRowFromResult({ runId: 'deadbeef', request: REQUEST, result: result(), env: {} }), dir);
        appendJudgeRow(judgeRowFromReport(JUDGE_REPORT), dir);
        appendJudgeRow(judgeRowFromReport({ ...JUDGE_REPORT, evalId: 'other', place: 'Haughwout Building', judgeModel: { answered: 'stand-in', skipped: [] } }), dir);

        const flat = flattenForAnalysis(dir);
        expect(flat.rows).toHaveLength(4);
        expect(flat.places).toBe(2);
        // two arms of the model-scored judgement; the stand-in's two are rows but not labels
        expect(flat.labelled).toBe(2);

        const joined = flat.rows.filter(r => r.features);
        expect(joined).toHaveLength(2);
        expect(joined[0].arm!.pipeline).toBe('k');
        expect(joined[0].features!.fitCoverage).toBe(0.93);
        expect(joined.every(r => r.armId === 'K')).toBe(true);
    });
});
