/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The run ledger's cloud copy (run-ledger-sync.ts), run end to end against a real DirectoryCloudBucket — the same
 * CloudBucket interface GcsCloudBucket implements, so the objects, keys and merge are the real ones and only the
 * transport differs. The four properties it has to hold:
 *   - rows roll up by machine and UTC day, under ledger/<kind>/<host>/<date>.jsonl;
 *   - a second sync adds nothing (union-merged by row identity), and a truncated local file cannot shrink the object;
 *   - another machine's rows are never touched, and a pull reads every machine's;
 *   - a row's absolute proof paths under the workspace leave as workspace-relative, and paths elsewhere are untouched.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DirectoryCloudBucket } from '../src/node/cloud-store/cloud-bucket';
import type { StagedLocationResult } from '../src/common/spatial/staged-location-contracts';
import { appendBuildRow, appendJudgeRow, buildRowFromResult, judgeRowFromReport, LEDGER_FILES, readBuildRows, type JudgeReportLike } from '../src/node/3d-engine/staged-location/run-ledger';
import {
    describeLedgerSync, fetchAllLedgerRows, ledgerHostKey, ledgerKey, relativisePaths, resolveLedgerBucketName,
    rowDate, rowIdentity, syncLedger
} from '../src/node/3d-engine/staged-location/run-ledger-sync';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ledger-sync-'));
const ROOT = '/w/checkout';
const REQUEST = { query: 'Empire State Building', isolate: true, trees: false, pipeline: 'k' };

function result(over: Partial<StagedLocationResult> = {}): StagedLocationResult {
    return {
        success: true, status: 'complete',
        place: { query: 'Empire State Building', resolvedAddress: '20 W 34th St.', lat: 40.748441, lng: -73.985664 },
        extraction: { radiusM: 180, sizedTo: 'structure', leafTiles: 412, cached: false, geometricErrorM: 2.0064, texelM: 0.154, attribution: [] },
        stages: [], degradations: [],
        provenance: [{ label: 'as-scanned', objects: 1, triangles: 80_000 }, { label: 'generated', objects: 1, triangles: 20_000 }],
        structureFit: {
            buildingId: 'b1', accepted: true, primitives: 23, scanToFitRmsM: 0.032, fitToScanRmsM: 0.041, coverage: 0.93,
            passThroughAreaM2: 0, unobservedFaceAreaM2: 0, gates: [], corrections: [],
            reportPath: `${ROOT}/.scratchbox/cache/scan_fit/abc/report.json`
        },
        complexityGate: { passed: true, totalVertices: 500_000, totalTriangles: 100_000, violations: [], exemptions: [] },
        sourceLimits: { leafGeometricErrorM: 2.0064, meshEdgeP50M: 0.69, meshResolvableM: 0.69, texelM: 0.154, photoResolvableM: 0.31 },
        timingsMs: { total: 180_000, firstVisual: 20_000, byStage: {} },
        cache: { tiles: 'miss' }, artifact: null, digest: 'd', summary: 's',
        ...over
    } as StagedLocationResult;
}

/** A build row written at a chosen instant, so the roll-up by day can be tested. */
function buildAt(runId: string, iso: string, dir: string, over: Partial<StagedLocationResult> = {}): void {
    const at = Date.parse(iso);
    appendBuildRow(buildRowFromResult({ runId, request: REQUEST, result: result(over), runRecord: `${ROOT}/.scratchbox/cache/staged_location/runs/${runId}/stages.json`, env: {}, now: () => at }), dir);
}

const JUDGE: JudgeReportLike = {
    evalId: 'esb_20261102T120000_aaaa', place: 'Empire State Building',
    judgeModel: { requested: 'gemini-4-argon', answered: 'gemini-4-argon', skipped: [] },
    arms: [{ id: 'K', label: 'PIPELINE K', triangles: 941_198, runId: 'deadbeef' }],
    scores: { K: { overall: { mean: 6.75 } } },
    pixelMetrics: { mean: { K: { coverage: 0.99, ssim: 0.35, edgeChamferPx: 9.4, colourDeltaE: 53.8 } } },
    outDir: `${ROOT}/.scratchbox/cache/photo_match/esb_aaaa`,
    grids: [`${ROOT}/.scratchbox/cache/photo_match/esb_aaaa/view1.jpg`, '/Volumes/Scratchbox/elsewhere/view2.jpg']
};

describe('ledger sync: the bucket it uses', () => {
    it('takes trainingBucket from cloud-store.json, and the env wins; "off" turns it off', () => {
        const home = tmp();
        fs.writeFileSync(path.join(home, 'cloud-store.json'), JSON.stringify({ trainingBucket: 'scoutscan-building-training', worldCacheBucket: 'scoutscan-splat-worlds' }));
        expect(resolveLedgerBucketName({}, home)).toBe('scoutscan-building-training');
        expect(resolveLedgerBucketName({ SCRATCHBOX_LEDGER_BUCKET: 'other' }, home)).toBe('other');
        expect(resolveLedgerBucketName({ SCRATCHBOX_LEDGER_BUCKET: 'off' }, home)).toBeUndefined();
        // the generic `bucket` key is not the ledger's: a machine may have one without meaning the ledger to leave it
        const bare = tmp();
        fs.writeFileSync(path.join(bare, 'cloud-store.json'), JSON.stringify({ bucket: 'some-other-bucket' }));
        expect(resolveLedgerBucketName({}, bare)).toBeUndefined();
        expect(resolveLedgerBucketName({}, tmp())).toBeUndefined();
    });

    it('reports, rather than throws, when no bucket is configured', async () => {
        const dir = tmp();
        buildAt('deadbeef', '2026-11-02T10:00:00Z', dir);
        const report = await syncLedger({ dir, host: 'mac', workspaceRoot: ROOT, bucket: undefined, tmpDir: tmp() });
        expect(report.bucket).toBeUndefined();
        expect(report.skipped).toContain('no ledger bucket is configured');
        expect(report.rowsAdded).toBe(0);
        expect(describeLedgerSync(report)).toContain('not synced');
    });
});

describe('ledger sync: keys, identity and dates', () => {
    it('keys an object by kind, machine and UTC day', () => {
        expect(ledgerKey('judgements', 'elis-mac', '2026-11-02')).toBe('ledger/judgements/elis-mac/2026-11-02.jsonl');
    });

    it('reduces a hostname to one key segment, and the env can name it', () => {
        expect(ledgerHostKey({}, () => 'Elis MacBook Pro.local')).toBe('elis-macbook-pro.local');
        expect(ledgerHostKey({ SCRATCHBOX_LEDGER_HOST: 'lane-K' }, () => 'x')).toBe('lane-k');
        expect(ledgerHostKey({}, () => '')).toBe('unknown-host');
        expect(ledgerHostKey({}, () => '!!!')).toBe('unknown-host');
    });

    it('identifies a build by its run and instant, a judgement by its evalId', () => {
        const dir = tmp();
        buildAt('deadbeef', '2026-11-02T10:00:00Z', dir);
        const row = readBuildRows(dir).rows[0];
        expect(rowIdentity(row)).toBe(`build:deadbeef:${Date.parse('2026-11-02T10:00:00Z')}`);
        expect(rowDate(row)).toBe('2026-11-02');
        expect(rowIdentity(judgeRowFromReport(JUDGE))).toBe('judge:esb_20261102T120000_aaaa');
    });
});

describe('ledger sync: paths that travel', () => {
    it('makes a workspace path relative and leaves a path elsewhere alone', () => {
        const row = judgeRowFromReport(JUDGE, { reportJson: `${ROOT}/.scratchbox/cache/photo_match/esb_aaaa/report.json` });
        const out = relativisePaths(row, ROOT);
        expect(out.proof.reportJson).toBe('.scratchbox/cache/photo_match/esb_aaaa/report.json');
        expect(out.proof.outDir).toBe('.scratchbox/cache/photo_match/esb_aaaa');
        expect(out.proof.grids![0]).toBe('.scratchbox/cache/photo_match/esb_aaaa/view1.jpg');
        // a file on a volume is not under the workspace: shortening it would say something untrue
        expect(out.proof.grids![1]).toBe('/Volumes/Scratchbox/elsewhere/view2.jpg');
        // the numbers are untouched
        expect(out.arms[0].scores.overall).toBe(6.75);
        expect(out.arms[0].pixel!.ssim).toBe(0.35);
    });
});

describe('ledger sync: end to end against a real bucket', () => {
    it('rolls up by day, stores NDJSON with metadata, and adds nothing on a second run', async () => {
        const dir = tmp(), store = tmp();
        const bucket = new DirectoryCloudBucket(store);
        buildAt('aaaaaaaa', '2026-11-01T09:00:00Z', dir);
        buildAt('bbbbbbbb', '2026-11-02T10:00:00Z', dir);
        buildAt('cccccccc', '2026-11-02T18:30:00Z', dir);
        appendJudgeRow(judgeRowFromReport(JUDGE, { now: () => Date.parse('2026-11-02T12:00:00Z') }), dir);

        const first = await syncLedger({ dir, host: 'mac', workspaceRoot: ROOT, bucket, tmpDir: tmp() });
        expect(first.bucket).toBe(`dir://${path.resolve(store)}`);
        expect(first.rowsAdded).toBe(4);
        expect(first.objectsUploaded).toBe(3);
        expect(first.days.map(d => d.key)).toEqual([
            'ledger/builds/mac/2026-11-01.jsonl',
            'ledger/builds/mac/2026-11-02.jsonl',
            'ledger/judgements/mac/2026-11-02.jsonl'
        ]);
        expect(first.days.find(d => d.date === '2026-11-02' && d.kind === 'builds')!.added).toBe(2);

        // the object is one JSON row per line, oldest first, with its paths made relative
        const objects = await bucket.list('ledger/');
        expect(objects).toHaveLength(3);
        const day2 = objects.find(o => o.key === 'ledger/builds/mac/2026-11-02.jsonl')!;
        expect(day2.metadata).toMatchObject({ kind: 'builds', host: 'mac', date: '2026-11-02', rows: '2' });
        const got = path.join(tmp(), 'got.jsonl');
        expect(await bucket.download(day2.key, got)).toBe(true);
        const lines = fs.readFileSync(got, 'utf8').trimEnd().split('\n').map(l => JSON.parse(l));
        expect(lines.map(r => r.runId)).toEqual(['bbbbbbbb', 'cccccccc']);
        expect(lines[0].proof.fitReport).toBe('.scratchbox/cache/scan_fit/abc/report.json');
        expect(lines[0].features.generatedTriangleShare).toBe(0.2);

        // run again: every local row is already there
        const second = await syncLedger({ dir, host: 'mac', workspaceRoot: ROOT, bucket, tmpDir: tmp() });
        expect(second.rowsAdded).toBe(0);
        expect(second.objectsUploaded).toBe(0);
        expect(second.days.every(d => d.state === 'unchanged')).toBe(true);
        expect((await bucket.list('ledger/')).length).toBe(3);
    });

    it('adds only the new rows of a day the object already holds', async () => {
        const dir = tmp(), store = tmp();
        const bucket = new DirectoryCloudBucket(store);
        buildAt('aaaaaaaa', '2026-11-02T09:00:00Z', dir);
        await syncLedger({ dir, host: 'mac', workspaceRoot: ROOT, bucket, tmpDir: tmp() });

        buildAt('bbbbbbbb', '2026-11-02T11:00:00Z', dir);
        const again = await syncLedger({ dir, host: 'mac', workspaceRoot: ROOT, bucket, tmpDir: tmp() });
        expect(again.rowsAdded).toBe(1);
        expect(again.days[0]).toMatchObject({ local: 2, remote: 1, added: 1, state: 'uploaded' });

        const got = path.join(tmp(), 'got.jsonl');
        await bucket.download('ledger/builds/mac/2026-11-02.jsonl', got);
        expect(fs.readFileSync(got, 'utf8').trimEnd().split('\n').map(l => JSON.parse(l).runId)).toEqual(['aaaaaaaa', 'bbbbbbbb']);
    });

    it('cannot shrink the cloud copy when the local ledger is cleared', async () => {
        const dir = tmp(), store = tmp();
        const bucket = new DirectoryCloudBucket(store);
        buildAt('aaaaaaaa', '2026-11-02T09:00:00Z', dir);
        buildAt('bbbbbbbb', '2026-11-02T11:00:00Z', dir);
        await syncLedger({ dir, host: 'mac', workspaceRoot: ROOT, bucket, tmpDir: tmp() });

        // the stage caches were cleared too enthusiastically and took the ledger with them
        fs.writeFileSync(path.join(dir, LEDGER_FILES.builds), '');
        buildAt('cccccccc', '2026-11-02T14:00:00Z', dir);
        const after = await syncLedger({ dir, host: 'mac', workspaceRoot: ROOT, bucket, tmpDir: tmp() });
        expect(after.rowsAdded).toBe(1);

        const got = path.join(tmp(), 'got.jsonl');
        await bucket.download('ledger/builds/mac/2026-11-02.jsonl', got);
        const runIds = fs.readFileSync(got, 'utf8').trimEnd().split('\n').map(l => JSON.parse(l).runId);
        expect(runIds).toEqual(['aaaaaaaa', 'bbbbbbbb', 'cccccccc']);
    });

    it('never touches another machine\'s rows, and a pull reads every machine', async () => {
        const store = tmp();
        const bucket = new DirectoryCloudBucket(store);
        const macDir = tmp(), laneDir = tmp();
        buildAt('aaaaaaaa', '2026-11-02T09:00:00Z', macDir);
        buildAt('bbbbbbbb', '2026-11-02T10:00:00Z', laneDir);

        await syncLedger({ dir: macDir, host: 'mac', workspaceRoot: ROOT, bucket, tmpDir: tmp() });
        await syncLedger({ dir: laneDir, host: 'lane-k', workspaceRoot: ROOT, bucket, tmpDir: tmp() });
        // and the first machine syncs again: it must not disturb the second's object
        await syncLedger({ dir: macDir, host: 'mac', workspaceRoot: ROOT, bucket, tmpDir: tmp() });

        expect((await bucket.list('ledger/builds/')).map(o => o.key).sort()).toEqual([
            'ledger/builds/lane-k/2026-11-02.jsonl', 'ledger/builds/mac/2026-11-02.jsonl'
        ]);
        const all = await fetchAllLedgerRows('builds', { bucket, tmpDir: tmp() });
        expect(all.objects).toBe(2);
        expect(all.hosts).toEqual(['lane-k', 'mac']);
        expect(all.rows.map(r => (r as { runId: string }).runId)).toEqual(['aaaaaaaa', 'bbbbbbbb']);
    });

    it('reports a day it could not write and leaves the rest of the sync alone', async () => {
        const dir = tmp(), store = tmp();
        buildAt('aaaaaaaa', '2026-11-01T09:00:00Z', dir);
        buildAt('bbbbbbbb', '2026-11-02T09:00:00Z', dir);
        const real = new DirectoryCloudBucket(store);
        const bucket = {
            label: real.label,
            list: real.list.bind(real),
            download: real.download.bind(real),
            remove: real.remove.bind(real),
            putFile: async (key: string, file: string) => {
                if (key.endsWith('2026-11-01.jsonl')) throw new Error('permission denied');
                return real.putFile(key, file);
            }
        };
        const report = await syncLedger({ dir, host: 'mac', workspaceRoot: ROOT, bucket, tmpDir: tmp() });
        expect(report.skipped).toContain('permission denied');
        expect(report.rowsAdded).toBe(1);
        expect(report.objectsUploaded).toBe(1);
        expect((await real.list('ledger/')).map(o => o.key)).toEqual(['ledger/builds/mac/2026-11-02.jsonl']);
    });
});
