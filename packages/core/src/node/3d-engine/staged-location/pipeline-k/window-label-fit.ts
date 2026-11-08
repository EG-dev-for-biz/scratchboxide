/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The consumer of the window check's labels (window-check.ts): every labels.jsonl found is read, the trusted rows (both
 * control images answered right) are joined to the evidence the window array recorded for their site (window-array.ts
 * SITE_EVIDENCE_FIELDS, by each row's own `fields`, so a row written by another version of the array is read by name), a
 * site decision is fitted on them, and it is scored against the rule the array uses today.
 *
 * The fit is a logistic regression on the standardised evidence fields (FIT_FEATURE_FIELDS, with one indicator for a
 * contrast the photo could not read), L2 regularised, solved by Newton's method; no dependency. It is scored out of
 * sample: leave-one-source-out when the labels come from at least two buildings (a building never scores itself), else
 * leave-one-row-out. The current rule is replayed from the recorded decision: a site the array added or kept (added,
 * behind, continued) is predicted a window, one it left outside or withheld a wall.
 *
 * Under WINDOW_LABEL_FIT_PARAMS.minTrusted trusted rows, or with fewer than minPerClass of either answer, the gate fails:
 * the counts and the current rule's score are reported and no fitted weights are published. Nothing here writes into
 * the label store and nothing changes the array's behaviour: the fitted rule's use behind a switch is the next step.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SITE_DECISION } from './window-array';
import { WINDOW_LABELS_FILE } from './window-check';

export const WINDOW_LABEL_FIT_VERSION = 'window-label-fit/1';
export const WINDOW_LABEL_FIT_FILE = 'window_label_fit.json';

export const WINDOW_LABEL_FIT_PARAMS = {
    /** Fewer trusted rows than this: counts and the current rule's score only, no weights published. */
    minTrusted: 30,
    /** Fewer trusted rows of either answer than this: the same. */
    minPerClass: 5,
    /** The L2 penalty on the weights (not the bias), in standardised units. */
    l2: 1.0,
    /** Newton's method: at most this many steps, stopped when the step's largest change is under tol. */
    newtonIters: 50, tol: 1e-9,
    /** A probability is clipped to [eps, 1 - eps] before the log loss; the current rule's hard answer is scored at 1 - eps and eps. */
    eps: 0.05,
    /** Label files are searched under a folder given at most this deep. */
    maxDepth: 8
} as const;
export type WindowLabelFitParams = typeof WINDOW_LABEL_FIT_PARAMS;

/** The evidence fields the fit reads, by name (SITE_EVIDENCE_FIELDS less the box and the decision). */
export const FIT_FEATURE_FIELDS = ['contrast', 'covered', 'occluded', 'rowContrast', 'colContrast', 'rowBoxes', 'colBoxes'] as const;
/** The indicator feature: 1 where the site's contrast was read, 0 where the photo could not be read there (its contrast then stands at the mean). */
export const CONTRAST_READ_FEATURE = 'contrastRead';
/** Every feature the fitted weights are over, in order. */
export const FIT_FEATURES = [...FIT_FEATURE_FIELDS, CONTRAST_READ_FEATURE] as const;
/** The fields a row must carry to be read (the fit's fields and the decision the current rule is replayed from). */
export const REQUIRED_FIELDS = ['decision', ...FIT_FEATURE_FIELDS] as const;

/** One label as the window check wrote it (window-check.ts WindowCheckService.answer). */
export interface LabelLine {
    version?: string; key: string; at?: string; check?: string; source: string; facadeId: number; box: number[];
    window: boolean; trusted: boolean; evidence?: Array<number | null>; fields?: string[];
}

/** A label joined to its evidence by field name. */
export interface LabelRow {
    key: string; file: string; source: string; sourceGroup: string; facadeId: number; box: number[]; window: boolean; trusted: boolean; version?: string;
    /** Every evidence value by its field's name (the row's own `fields`); extra fields are kept here and ignored by the fit. */
    values: Record<string, number | null>;
    decision: number;
}

export interface SkippedLine { file: string; line: number; reason: string }

export interface Metrics { n: number; tp: number; fp: number; tn: number; fn: number; accuracy: number; precision: number | null; recall: number | null; logLoss: number }

export interface LogisticModel { features: string[]; means: number[]; scales: number[]; weights: number[]; bias: number; l2: number; iterations: number; converged: boolean }

export interface LabelCounts {
    files: Array<{ file: string; rows: number }>;
    rows: number; trusted: number; untrusted: number; skipped: number; skippedReasons: Record<string, number>;
    /** Per source building (the tile_refine key of the ortho folder's parent, else the source path), over every row read. */
    bySource: Array<{ source: string; rows: number; trusted: number; trustedWindows: number }>;
    /** Per decision the array made at the site, over the trusted rows. */
    byDecision: Array<{ decision: string; rows: number; windows: number }>;
    /** The trusted rows' answers. */
    trustedWindows: number; trustedWalls: number;
    versions: Record<string, number>;
}

export interface WindowLabelFitReport {
    version: string; at: string; params: WindowLabelFitParams;
    counts: LabelCounts;
    gate: { minTrusted: number; minPerClass: number; trusted: number; windows: number; walls: number; passed: boolean; reason?: string };
    /** The current rule (the array's recorded decision) scored on the trusted rows. */
    current: Metrics | null;
    /** The fitted rule, published only when the gate passed: its out-of-sample score, how it was scored, and the model fitted on every trusted row. */
    fitted?: { crossValidation: 'leave-one-source-out' | 'leave-one-out'; folds: number; metrics: Metrics; model: LogisticModel };
    summary: string;
}

/** Every labels.jsonl among the paths: a file is taken as it is, a folder searched for WINDOW_LABELS_FILE up to P.maxDepth deep; absent paths are left out. */
export function findLabelFiles(paths: string[], P: WindowLabelFitParams = WINDOW_LABEL_FIT_PARAMS): string[] {
    const out = new Set<string>();
    const walk = (dir: string, depth: number) => {
        let ents: fs.Dirent[];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
            const p = path.join(dir, e.name);
            if (e.isFile() && e.name === WINDOW_LABELS_FILE) out.add(p);
            else if (e.isDirectory() && depth < P.maxDepth && !e.name.startsWith('.') && e.name !== 'node_modules') walk(p, depth + 1);
        }
    };
    for (const p of paths) {
        let st: fs.Stats;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.isFile()) out.add(p);
        else if (st.isDirectory()) { if (fs.existsSync(path.join(p, WINDOW_LABELS_FILE))) out.add(path.join(p, WINDOW_LABELS_FILE)); else walk(p, 0); }
    }
    return [...out].sort();
}

/** The building a source folder belongs to: a relief_orthos_k_* folder's parent (its tile_refine key), else the source itself. */
export function sourceGroup(source: string): string {
    const base = path.basename(source);
    return base.startsWith('relief_orthos_k_') ? path.basename(path.dirname(source)) : source;
}

/**
 * The rows of one labels file, each joined to its evidence by its own `fields`. A line is skipped, with its reason, when it
 * is not JSON, lacks a key, source or boolean answer, carries no evidence or fields, its evidence and fields differ in
 * length, or its fields lack one of REQUIRED_FIELDS (an older array's row); a row with fields beyond those is kept.
 */
export function readLabelFile(file: string): { rows: LabelRow[]; skipped: SkippedLine[] } {
    const rows: LabelRow[] = [], skipped: SkippedLine[] = [];
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        let l: LabelLine;
        try { l = JSON.parse(line) as LabelLine; } catch { skipped.push({ file, line: i + 1, reason: 'not JSON' }); continue; }
        if (typeof l?.key !== 'string' || typeof l.source !== 'string' || typeof l.window !== 'boolean') { skipped.push({ file, line: i + 1, reason: 'no key, source or answer' }); continue; }
        if (!Array.isArray(l.evidence) || !Array.isArray(l.fields)) { skipped.push({ file, line: i + 1, reason: 'no evidence or fields' }); continue; }
        if (l.evidence.length !== l.fields.length) { skipped.push({ file, line: i + 1, reason: 'evidence and fields differ in length' }); continue; }
        const missing = REQUIRED_FIELDS.filter(f => !l.fields!.includes(f));
        if (missing.length) { skipped.push({ file, line: i + 1, reason: `fields missing: ${missing.join(', ')}` }); continue; }
        const values: Record<string, number | null> = {};
        let bad = false;
        l.fields.forEach((f, k) => { const v = l.evidence![k]; if (v !== null && typeof v !== 'number') bad = true; values[f] = v; });
        if (bad || typeof values.decision !== 'number') { skipped.push({ file, line: i + 1, reason: 'evidence not numbers' }); continue; }
        rows.push({ key: l.key, file, source: l.source, sourceGroup: sourceGroup(l.source), facadeId: l.facadeId, box: l.box ?? [], window: l.window, trusted: l.trusted === true, version: l.version, values, decision: values.decision });
    }
    return { rows, skipped };
}

/** Every file's rows together; a key answered twice is kept once (the later line wins, as the check never asks a key twice). */
export function readLabelFiles(files: string[]): { rows: LabelRow[]; skipped: SkippedLine[]; perFile: Array<{ file: string; rows: number }> } {
    const byKey = new Map<string, LabelRow>(), skipped: SkippedLine[] = [], perFile: Array<{ file: string; rows: number }> = [];
    for (const f of files) {
        const r = readLabelFile(f);
        perFile.push({ file: f, rows: r.rows.length });
        skipped.push(...r.skipped);
        for (const row of r.rows) byKey.set(row.key, row);
    }
    return { rows: [...byKey.values()], skipped, perFile };
}

const DECISION_NAME: Record<number, string> = Object.fromEntries(Object.entries(SITE_DECISION).map(([k, v]) => [v, k]));

export function countLabels(rows: LabelRow[], skipped: SkippedLine[], perFile: Array<{ file: string; rows: number }>): LabelCounts {
    const trusted = rows.filter(r => r.trusted);
    const bySource = new Map<string, { source: string; rows: number; trusted: number; trustedWindows: number }>();
    for (const r of rows) {
        const s = bySource.get(r.sourceGroup) ?? { source: r.sourceGroup, rows: 0, trusted: 0, trustedWindows: 0 };
        s.rows++; if (r.trusted) { s.trusted++; if (r.window) s.trustedWindows++; }
        bySource.set(r.sourceGroup, s);
    }
    const byDecision = new Map<number, { decision: string; rows: number; windows: number }>();
    for (const r of trusted) {
        const d = byDecision.get(r.decision) ?? { decision: DECISION_NAME[r.decision] ?? `decision ${r.decision}`, rows: 0, windows: 0 };
        d.rows++; if (r.window) d.windows++;
        byDecision.set(r.decision, d);
    }
    const skippedReasons: Record<string, number> = {}, versions: Record<string, number> = {};
    for (const s of skipped) skippedReasons[s.reason] = (skippedReasons[s.reason] ?? 0) + 1;
    for (const r of rows) { const v = r.version ?? 'none'; versions[v] = (versions[v] ?? 0) + 1; }
    return {
        files: perFile, rows: rows.length, trusted: trusted.length, untrusted: rows.length - trusted.length, skipped: skipped.length, skippedReasons,
        bySource: [...bySource.values()].sort((a, b) => b.rows - a.rows), byDecision: [...byDecision.values()].sort((a, b) => b.rows - a.rows),
        trustedWindows: trusted.filter(r => r.window).length, trustedWalls: trusted.filter(r => !r.window).length, versions
    };
}

/** The array's rule today, replayed from the decision it recorded: a site it added or kept is a window, one it left outside or withheld a wall. */
export function currentRulePredicts(decision: number): boolean {
    return decision === SITE_DECISION.added || decision === SITE_DECISION.behind || decision === SITE_DECISION.continued;
}

/** A row's raw feature vector (FIT_FEATURES): the fields' values with null where unread, and the contrast indicator. */
export function featureVector(r: LabelRow): Array<number | null> {
    return [...FIT_FEATURE_FIELDS.map(f => r.values[f] ?? null), r.values.contrast === null || r.values.contrast === undefined ? 0 : 1];
}

const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Standardisation over the training rows: each feature's mean and scale (1 where constant); a null takes the mean (0 standardised). */
function standardiser(X: Array<Array<number | null>>, nF: number): { means: number[]; scales: number[] } {
    const means = new Array<number>(nF).fill(0), scales = new Array<number>(nF).fill(1);
    for (let j = 0; j < nF; j++) {
        const v = X.map(x => x[j]).filter((a): a is number => a !== null);
        if (!v.length) continue;
        const m = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
        means[j] = m; scales[j] = sd > 1e-9 ? sd : 1;
    }
    return { means, scales };
}

function standardise(x: Array<number | null>, means: number[], scales: number[]): number[] {
    return x.map((v, j) => (v === null ? 0 : (v - means[j]) / scales[j]));
}

/** Solves A x = b (A symmetric positive definite here) by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
    const n = b.length, M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
        let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
        [M[c], M[p]] = [M[p], M[c]];
        const d = M[c][c]; if (Math.abs(d) < 1e-12) throw new Error('the Newton step is singular');
        for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / d; if (!f) continue; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((row, i) => row[n] / row[i]);
}

/**
 * L2-regularised logistic regression by Newton's method on the standardised features (the bias unpenalised). Each step
 * solves (H + l2 I) d = g; stopped when the largest change is under P.tol or after P.newtonIters steps.
 */
export function fitLogistic(X: Array<Array<number | null>>, y: boolean[], features: readonly string[], P: WindowLabelFitParams = WINDOW_LABEL_FIT_PARAMS): LogisticModel {
    const nF = features.length, { means, scales } = standardiser(X, nF);
    const Z = X.map(x => [...standardise(x, means, scales), 1]);
    const w = new Array<number>(nF + 1).fill(0);
    let iterations = 0, converged = false;
    for (; iterations < P.newtonIters; iterations++) {
        const g = new Array<number>(nF + 1).fill(0), H = Array.from({ length: nF + 1 }, () => new Array<number>(nF + 1).fill(0));
        for (let i = 0; i < Z.length; i++) {
            const z = Z[i], p = sigmoid(z.reduce((a, v, j) => a + v * w[j], 0)), r = p - (y[i] ? 1 : 0), s = p * (1 - p);
            for (let j = 0; j <= nF; j++) { g[j] += r * z[j]; for (let k = 0; k <= nF; k++) H[j][k] += s * z[j] * z[k]; }
        }
        for (let j = 0; j < nF; j++) { g[j] += P.l2 * w[j]; H[j][j] += P.l2; }
        H[nF][nF] += 1e-9;
        const d = solve(H, g);
        let maxStep = 0; for (let j = 0; j <= nF; j++) { w[j] -= d[j]; maxStep = Math.max(maxStep, Math.abs(d[j])); }
        if (maxStep < P.tol) { iterations++; converged = true; break; }
    }
    return { features: [...features], means, scales, weights: w.slice(0, nF), bias: w[nF], l2: P.l2, iterations, converged };
}

/** The fitted probability that a site is a window. */
export function predictLogistic(m: LogisticModel, x: Array<number | null>): number {
    const z = standardise(x, m.means, m.scales);
    return sigmoid(z.reduce((a, v, j) => a + v * m.weights[j], m.bias));
}

/** Accuracy, precision, recall and log loss of probabilities against answers; precision and recall null where undefined. */
export function scoreMetrics(p: number[], y: boolean[], eps: number = WINDOW_LABEL_FIT_PARAMS.eps): Metrics {
    let tp = 0, fp = 0, tn = 0, fn = 0, ll = 0;
    for (let i = 0; i < y.length; i++) {
        const q = Math.min(1 - eps, Math.max(eps, p[i])), pred = p[i] >= 0.5;
        if (pred && y[i]) tp++; else if (pred) fp++; else if (y[i]) fn++; else tn++;
        ll -= y[i] ? Math.log(q) : Math.log(1 - q);
    }
    const n = y.length;
    return { n, tp, fp, tn, fn, accuracy: n ? (tp + tn) / n : 0, precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null, logLoss: n ? ll / n : 0 };
}

/**
 * The fitted rule scored out of sample: by source building when there are at least two (each building scored by a model
 * fitted on the others), else one row out at a time. A training fold with one answer only predicts that answer's share.
 */
export function crossValidate(rows: LabelRow[], P: WindowLabelFitParams = WINDOW_LABEL_FIT_PARAMS): { scheme: 'leave-one-source-out' | 'leave-one-out'; folds: number; metrics: Metrics } {
    const groups = [...new Set(rows.map(r => r.sourceGroup))];
    const scheme = groups.length >= 2 ? 'leave-one-source-out' : 'leave-one-out';
    const foldOf = scheme === 'leave-one-source-out' ? (r: LabelRow, _i: number) => groups.indexOf(r.sourceGroup) : (_r: LabelRow, i: number) => i;
    const nFolds = scheme === 'leave-one-source-out' ? groups.length : rows.length;
    const p = new Array<number>(rows.length).fill(0.5);
    for (let f = 0; f < nFolds; f++) {
        const train = rows.filter((r, i) => foldOf(r, i) !== f), test = rows.map((r, i) => i).filter(i => foldOf(rows[i], i) === f);
        if (!test.length) continue;
        const pos = train.filter(r => r.window).length;
        if (!train.length || pos === 0 || pos === train.length) { const q = (pos + 1) / (train.length + 2); for (const i of test) p[i] = q; continue; }
        const m = fitLogistic(train.map(featureVector), train.map(r => r.window), FIT_FEATURES, P);
        for (const i of test) p[i] = predictLogistic(m, featureVector(rows[i]));
    }
    return { scheme, folds: nFolds, metrics: scoreMetrics(p, rows.map(r => r.window), P.eps) };
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const m3 = (v: number | null) => (v === null ? 'n/a' : v.toFixed(3));

/** The whole report over the files: counts, the gate, the current rule's score, and the fitted rule where the gate passed. */
export function fitWindowLabels(files: string[], P: WindowLabelFitParams = WINDOW_LABEL_FIT_PARAMS, now: () => number = Date.now): WindowLabelFitReport {
    const { rows, skipped, perFile } = readLabelFiles(files);
    const counts = countLabels(rows, skipped, perFile);
    const trusted = rows.filter(r => r.trusted);
    const y = trusted.map(r => r.window);
    const current = trusted.length ? scoreMetrics(trusted.map(r => (currentRulePredicts(r.decision) ? 1 - P.eps : P.eps)), y, P.eps) : null;
    const windows = counts.trustedWindows, walls = counts.trustedWalls;
    let reason: string | undefined;
    if (trusted.length < P.minTrusted) reason = `${trusted.length} trusted rows, under the floor of ${P.minTrusted}`;
    else if (Math.min(windows, walls) < P.minPerClass) reason = `${windows} trusted windows and ${walls} trusted walls, under ${P.minPerClass} of one answer`;
    const gate = { minTrusted: P.minTrusted, minPerClass: P.minPerClass, trusted: trusted.length, windows, walls, passed: !reason, ...(reason ? { reason } : {}) };
    let fitted: WindowLabelFitReport['fitted'];
    if (gate.passed) {
        const cv = crossValidate(trusted, P);
        const model = fitLogistic(trusted.map(featureVector), y, FIT_FEATURES, P);
        fitted = { crossValidation: cv.scheme, folds: cv.folds, metrics: cv.metrics, model };
    }
    const where = `${files.length} label file${files.length === 1 ? '' : 's'}`;
    const nB = counts.bySource.length, nTB = counts.bySource.filter(s => s.trusted > 0).length;
    const buildings = `${nB} building${nB === 1 ? '' : 's'}${nTB !== nB ? ` (${nTB} with trusted rows)` : ''}`;
    let summary = `Read ${counts.rows} window-check labels from ${where} (${counts.skipped} lines skipped): ${counts.trusted} trusted (${windows} windows, ${walls} walls) and ${counts.untrusted} untrusted, from ${buildings}.`;
    if (current) summary += ` The array's current rule gets ${pct(current.accuracy)} of the trusted answers right (precision ${m3(current.precision)}, recall ${m3(current.recall)}, log loss ${m3(current.logLoss)}).`;
    if (!gate.passed) summary += ` Too few labels for any conclusion about a fitted rule: ${reason}; no weights are published. The floor needs at least ${P.minTrusted} trusted rows with ${P.minPerClass} or more of each answer, from more than one building for the fit to be scored across buildings.`;
    else if (fitted) {
        const f = fitted.metrics, better = f.accuracy > (current?.accuracy ?? 0);
        summary += ` A logistic fit on the evidence fields, scored ${fitted.crossValidation} over ${fitted.folds} folds, gets ${pct(f.accuracy)} right (precision ${m3(f.precision)}, recall ${m3(f.recall)}, log loss ${m3(f.logLoss)}): ${better ? 'better than' : 'no better than'} the current rule out of sample.`;
        const top = fitted.model.features.map((n, j) => ({ n, w: fitted!.model.weights[j] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, 3);
        summary += ` Its strongest standardised weights: ${top.map(t => `${t.n} ${t.w >= 0 ? '+' : ''}${t.w.toFixed(2)}`).join(', ')}.`;
        if (fitted.crossValidation === 'leave-one-out') summary += ' Every label is from one building, so the score says nothing about another building yet.';
    }
    return { version: WINDOW_LABEL_FIT_VERSION, at: new Date(now()).toISOString(), params: P, counts, gate, current, ...(fitted ? { fitted } : {}), summary };
}

/** The report written as WINDOW_LABEL_FIT_FILE under `outDir`; the path written. */
export function writeWindowLabelFitReport(report: WindowLabelFitReport, outDir: string): string {
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, WINDOW_LABEL_FIT_FILE);
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    return file;
}
