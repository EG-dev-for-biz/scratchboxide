/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The window-label fit (pipeline-k/window-label-fit.ts): the window check's labels read from every labels.jsonl, the
 * trusted rows joined to their evidence by field name, a logistic site decision fitted and scored out of sample against
 * the array's current rule, and a gate that publishes no weights under the row floor.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { SITE_DECISION, SITE_EVIDENCE_FIELDS } from '../src/node/3d-engine/staged-location/pipeline-k/window-array';
import { WINDOW_LABELS_FILE } from '../src/node/3d-engine/staged-location/pipeline-k/window-check';
import { countLabels, currentRulePredicts, findLabelFiles, FIT_FEATURES, fitWindowLabels, readLabelFile, readLabelFiles, WINDOW_LABEL_FIT_FILE, WINDOW_LABEL_FIT_PARAMS, writeWindowLabelFitReport } from '../src/node/3d-engine/staged-location/pipeline-k/window-label-fit';

const F = Object.fromEntries(SITE_EVIDENCE_FIELDS.map((k, i) => [k, i])) as Record<(typeof SITE_EVIDENCE_FIELDS)[number], number>;

/** Mulberry32, so the synthetic labels are the same every run. */
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

interface Row { source: string; window: boolean; trusted?: boolean; evidence: Array<number | null>; fields?: string[]; key?: string }
function line(r: Row, i: number): string {
    return JSON.stringify({ version: 'window-check/1', key: r.key ?? `k${i.toString(16).padStart(6, '0')}`, at: '2026-11-08T00:00:00.000Z', check: 'c1', source: r.source, facadeId: 1, box: r.evidence.slice(0, 4), window: r.window, trusted: r.trusted ?? true, evidence: r.evidence, fields: r.fields ?? [...SITE_EVIDENCE_FIELDS] });
}
function writeLabels(dir: string, rows: Row[]): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, WINDOW_LABELS_FILE);
    fs.writeFileSync(file, rows.map((r, i) => line(r, i)).join('\n') + '\n');
    return file;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-window-label-fit-'));

/**
 * A site whose answer is a known function of two evidence fields plus noise: window when 3 x contrast - 2 x occluded +
 * noise > 0.6. The array's recorded decision is made deliberately poor (added or outside by a coin independent of the
 * answer), so the current rule scores near chance and the fit must beat it.
 */
function syntheticRows(n: number, sources: string[], seed: number): Row[] {
    const r = rng(seed), out: Row[] = [];
    for (let i = 0; i < n; i++) {
        const contrast = Math.round((0.1 + 0.6 * r()) * 100) / 100, occluded = Math.round(0.5 * r() * 100) / 100;
        const window = 3 * contrast - 2 * occluded + 0.3 * gauss(r) > 0.6;
        const decision = r() < 0.5 ? SITE_DECISION.added : SITE_DECISION.outside;
        const ev: Array<number | null> = [10 * i, 20, 10 * i + 8, 36, decision, contrast, 1, occluded, Math.round(r() * 100) / 100, Math.round(r() * 100) / 100, Math.round(r() * 100) / 100, Math.round(r() * 100) / 100];
        out.push({ source: `/cache/tile_refine/${sources[i % sources.length]}/relief_orthos_k_a`, window, evidence: ev });
    }
    return out;
}

describe('the window-label fit', () => {
    it('recovers the sign of a known rule on synthetic labels from three buildings and beats the current rule across buildings', () => {
        const root = tmp();
        const rows = syntheticRows(240, ['bldgA', 'bldgB', 'bldgC'], 7);
        const file = writeLabels(path.join(root, 'window_labels'), rows);
        const report = fitWindowLabels([file], WINDOW_LABEL_FIT_PARAMS, () => 0);
        expect(report.counts.rows).toBe(240);
        expect(report.counts.trusted).toBe(240);
        expect(report.counts.bySource.map(s => s.source).sort()).toEqual(['bldgA', 'bldgB', 'bldgC']);
        expect(report.gate.passed).toBe(true);
        expect(report.fitted).toBeDefined();
        const f = report.fitted!;
        expect(f.crossValidation).toBe('leave-one-source-out');
        expect(f.folds).toBe(3);
        // the fit reads contrast up and occlusion down, as the rule that made the answers
        const w = Object.fromEntries(f.model.features.map((n, j) => [n, f.model.weights[j]]));
        expect(w.contrast).toBeGreaterThan(0);
        expect(w.occluded).toBeLessThan(0);
        expect(Math.abs(w.contrast)).toBeGreaterThan(Math.abs(w.rowContrast));
        expect(Math.abs(w.contrast)).toBeGreaterThan(Math.abs(w.colBoxes));
        expect(f.model.converged).toBe(true);
        expect(f.model.features).toEqual([...FIT_FEATURES]);
        // the current rule was a coin here; the fit, scored on buildings it never saw, does much better
        expect(report.current!.accuracy).toBeLessThan(0.7);
        expect(f.metrics.accuracy).toBeGreaterThan(0.85);
        expect(f.metrics.accuracy).toBeGreaterThan(report.current!.accuracy);
        expect(f.metrics.logLoss).toBeLessThan(report.current!.logLoss);
        expect(f.metrics.n).toBe(240);
        expect(f.metrics.tp + f.metrics.fp + f.metrics.tn + f.metrics.fn).toBe(240);
        expect(report.summary).toContain('better than the current rule');
        // the report on disk carries the gate, both rules and the weights
        const written = writeWindowLabelFitReport(report, path.join(root, 'out'));
        expect(path.basename(written)).toBe(WINDOW_LABEL_FIT_FILE);
        const back = JSON.parse(fs.readFileSync(written, 'utf8'));
        expect(back.gate.passed).toBe(true);
        expect(back.fitted.model.weights.length).toBe(FIT_FEATURES.length);
        expect(back.fitted.model.means.length).toBe(FIT_FEATURES.length);
        expect(back.current.n).toBe(240);
        // and the label store is untouched
        expect(fs.readdirSync(path.join(root, 'window_labels'))).toEqual([WINDOW_LABELS_FILE]);
    });

    it('falls back to leave-one-out when every label is from one building, and says so', () => {
        const root = tmp();
        const file = writeLabels(root, syntheticRows(80, ['only'], 3));
        const report = fitWindowLabels([file], WINDOW_LABEL_FIT_PARAMS, () => 0);
        expect(report.gate.passed).toBe(true);
        expect(report.fitted!.crossValidation).toBe('leave-one-out');
        expect(report.fitted!.folds).toBe(80);
        expect(report.summary).toContain('one building');
    });

    it('under the row floor the gate fails: counts and the current rule only, no weights published', () => {
        const root = tmp();
        const rows = syntheticRows(20, ['bldgA', 'bldgB'], 11);
        rows[3].trusted = false; rows[7].trusted = false;
        const file = writeLabels(root, rows);
        const report = fitWindowLabels([file], WINDOW_LABEL_FIT_PARAMS, () => 0);
        expect(report.counts.rows).toBe(20);
        expect(report.counts.trusted).toBe(18);
        expect(report.counts.untrusted).toBe(2);
        expect(report.gate.passed).toBe(false);
        expect(report.gate.reason).toContain('under the floor of 30');
        expect(report.fitted).toBeUndefined();
        expect(report.current).not.toBeNull();
        expect(report.current!.n).toBe(18);
        // the current rule replayed from the recorded decision
        const trusted = rows.filter(r => r.trusted !== false);
        const tp = trusted.filter(r => r.window && currentRulePredicts(r.evidence[F.decision] as number)).length;
        expect(report.current!.tp).toBe(tp);
        expect(report.summary).toContain('Too few labels');
        expect(report.summary).toContain('no weights are published');
        expect(JSON.stringify(report)).not.toContain('"weights"');
    });

    it('the gate also fails when one answer is nearly absent, however many rows', () => {
        const root = tmp();
        const rows = syntheticRows(60, ['bldgA', 'bldgB'], 5).map((r, i) => ({ ...r, window: i < 2 }));
        const report = fitWindowLabels([writeLabels(root, rows)], WINDOW_LABEL_FIT_PARAMS, () => 0);
        expect(report.gate.passed).toBe(false);
        expect(report.gate.reason).toContain('2 trusted windows');
        expect(report.fitted).toBeUndefined();
    });

    it('tolerates version drift by the row\'s own fields: an extra field is kept, a missing one skipped with its reason, as are torn lines', () => {
        const root = tmp();
        const base = syntheticRows(6, ['bldgA'], 2);
        // a newer array's row: one more field at the end, read by name
        const extra: Row = { ...base[0], key: 'extra', fields: [...SITE_EVIDENCE_FIELDS, 'glare'], evidence: [...base[0].evidence, 0.3] };
        // an older array's row: no colBoxes
        const older: Row = { ...base[1], key: 'older', fields: SITE_EVIDENCE_FIELDS.slice(0, -1), evidence: base[1].evidence.slice(0, -1) };
        // a row whose fields and evidence disagree in length
        const torn: Row = { ...base[2], key: 'torn', evidence: base[2].evidence.slice(0, 5) };
        // the fields in another order: still read by name
        const reordered: Row = { ...base[3], key: 'reordered', fields: [...SITE_EVIDENCE_FIELDS].reverse(), evidence: [...base[3].evidence].reverse() };
        const file = writeLabels(root, [extra, older, torn, reordered, base[4]]);
        fs.appendFileSync(file, '{"version":"window-check/1","key":"half","source":"/x","win\n');
        const r = readLabelFile(file);
        expect(r.rows.map(x => x.key)).toEqual(['extra', 'reordered', base[4].key ?? 'k000004']);
        expect(r.skipped.map(s => s.reason)).toEqual(['fields missing: colBoxes', 'evidence and fields differ in length', 'not JSON']);
        expect(r.rows[0].values.glare).toBe(0.3);
        expect(r.rows[0].values.contrast).toBe(base[0].evidence[F.contrast]);
        expect(r.rows[1].values.contrast).toBe(base[3].evidence[F.contrast]);
        expect(r.rows[1].decision).toBe(base[3].evidence[F.decision]);
        const counts = countLabels(r.rows, r.skipped, [{ file, rows: r.rows.length }]);
        expect(counts.skipped).toBe(3);
        expect(counts.skippedReasons['not JSON']).toBe(1);
    });

    it('finds every labels.jsonl under the paths given, reads a key once across files, and groups by building', () => {
        const root = tmp();
        const a = writeLabels(path.join(root, 'one', 'window_labels'), syntheticRows(4, ['bldgA'], 1));
        const b = writeLabels(path.join(root, 'two', 'deeper', 'window_labels'), syntheticRows(4, ['bldgB'], 1).map((r, i) => ({ ...r, key: i === 0 ? 'k000000' : `b${i}` })));
        fs.writeFileSync(path.join(root, 'two', 'other.jsonl'), '{}\n');
        expect(findLabelFiles([root])).toEqual([a, b]);
        expect(findLabelFiles([a, path.join(root, 'two')])).toEqual([a, b]);
        expect(findLabelFiles([path.join(root, 'nowhere')])).toEqual([]);
        const all = readLabelFiles([a, b]);
        expect(all.rows.length).toBe(7);
        expect(all.perFile).toEqual([{ file: a, rows: 4 }, { file: b, rows: 4 }]);
        expect(all.rows.find(r => r.key === 'k000000')!.sourceGroup).toBe('bldgB');
    });

    it('reads the real rows of an earlier build on this machine (the k-height store, paths shortened): counts and the current rule', () => {
        const file = path.join(__dirname, 'fixtures', 'window-labels', 'labels.jsonl');
        const report = fitWindowLabels([file], WINDOW_LABEL_FIT_PARAMS, () => 0);
        expect(report.counts.rows).toBe(14);
        expect(report.counts.trusted).toBe(14);
        expect(report.counts.untrusted).toBe(0);
        expect(report.counts.skipped).toBe(0);
        expect(report.counts.trustedWindows).toBe(3);
        expect(report.counts.trustedWalls).toBe(11);
        expect(report.counts.versions).toEqual({ 'window-check/1': 14 });
        expect(report.counts.bySource).toEqual([{ source: '9bffd2e1691dfa66d54156dd434a83498d7ad6a2024d033557e0d91daa05eaa1', rows: 14, trusted: 14, trustedWindows: 3 }]);
        expect(report.counts.byDecision).toEqual([{ decision: 'outside', rows: 12, windows: 3 }, { decision: 'added', rows: 1, windows: 0 }, { decision: 'withheld', rows: 1, windows: 0 }]);
        // every row reads its contrast, two could not read a row contrast, one a column contrast
        const rows = readLabelFile(file).rows;
        expect(rows.filter(r => r.values.rowContrast === null).length).toBe(2);
        expect(rows.filter(r => r.values.colContrast === null).length).toBe(1);
        // the current rule: the one added site was a wall, the three windows were all outside the array
        expect(report.current).toEqual(expect.objectContaining({ n: 14, tp: 0, fp: 1, tn: 10, fn: 3 }));
        expect(report.current!.accuracy).toBeCloseTo(10 / 14, 6);
        expect(report.gate.passed).toBe(false);
        expect(report.fitted).toBeUndefined();
        expect(report.summary).toMatch(/14 trusted \(3 windows, 11 walls\)/);
    });
});
