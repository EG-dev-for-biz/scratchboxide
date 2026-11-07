/**
 * Blob graph prototype (dev tool, not shipped), step 6: one record of the test.
 *
 *   node -r ts-node/register scripts/dev/blob-graph/assemble.ts --out <dir> [--spot <spot.json>]
 *
 * Joins the split (blobs, edges, measures), the selection, every reading (district brief, building readers with their
 * children's readings, blob readers, judges), the spot checks when given, and the model-call reports into
 * <dir>/blob_graph.json. Nothing is asked of a model here.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { BlobRecord } from './split';

function arg(name: string, fallback?: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
}

const readJson = (f: string) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : undefined);

function main(): void {
    const out = path.resolve(arg('out')!);
    const split = readJson(path.join(out, 'split', 'blobs.json'));
    const sel = readJson(path.join(out, 'selection.json'));
    const rd = path.join(out, 'readings');
    const brief = readJson(path.join(rd, 'brief.json'));
    const spot = arg('spot') ? readJson(path.resolve(arg('spot')!)) : undefined;
    const blobs: Array<BlobRecord & Record<string, unknown>> = split.blobs;
    const selected = new Set<number>([...sel.always, ...sel.others]);
    // the building readers' words for their numbered children
    const childWords = new Map<number, { description: string; confidence: number; building: number }>();
    for (const b of blobs) {
        const r = readJson(path.join(rd, `${b.index}.building.json`));
        if (r?.childReadings) for (const c of r.childReadings) childWords.set(c.blob, { description: c.description, confidence: c.confidence, building: b.index });
    }
    const spotBy = new Map<number, unknown>((spot?.items ?? []).map((s: { blob: number }) => [s.blob, s]));
    let read = 0, judged = 0, agreed = 0, asksMore = 0, errors = 0;
    for (const b of blobs) {
        const isB = b.group === 'building';
        const r = readJson(path.join(rd, `${b.index}.${isB ? 'building' : 'reader'}.json`));
        const j = readJson(path.join(rd, `${b.index}.judge.json`));
        if (fs.existsSync(path.join(rd, `${b.index}.${isB ? 'building' : 'reader'}.error`))) errors++;
        b.selected = selected.has(b.index);
        if (r) {
            read++;
            const { _model, _cached, children, childReadings, ...rest } = r;
            void _cached; void children;
            b.reading = { ...rest, model: _model, ...(childReadings ? { childReadings } : {}) };
            if ((r.extraViews ?? []).length) asksMore++;
        }
        const cw = childWords.get(b.index);
        if (cw) b.buildingReaderReading = cw;
        if (j) {
            judged++;
            if (j.agree === true) agreed++;
            const { _model, _cached, ...rest } = j;
            void _cached;
            b.judge = { ...rest, model: _model };
            if (r && j.agree !== true && typeof (b.reading as { confidence?: number }).confidence === 'number') (b.reading as Record<string, unknown>).confidenceAfterJudge = Math.round(((b.reading as { confidence: number }).confidence * 0.5) * 100) / 100;
        }
        if (spotBy.has(b.index)) b.spotCheck = spotBy.get(b.index);
    }
    const calls = fs.readdirSync(rd).filter(f => f.startsWith('calls_')).map(f => readJson(path.join(rd, f)));
    const usd = calls.reduce((s, c) => s + (c?.calls?.estimatedUsd ?? 0), 0);
    const requests = calls.reduce((s, c) => s + (c?.calls?.requests ?? 0), 0);
    const graph = {
        schema: 'scratchbox.blob-graph-prototype/1',
        date: new Date().toISOString(),
        note: 'Prototype of docs/research/2026-11-06-blob-graph-plan.md §5.1-5.3 (split, measure, read). Readings are labels only; no geometry was changed. Wrap and refine were not run.',
        source: split.source,
        params: split.params,
        counts: { ...split.counts, read, judged, judgeAgreed: agreed, readersAskedMore: asksMore, readerErrors: errors, selected: selected.size, selectionRule: sel.rule },
        brief,
        modelCalls: { runs: calls.length, requests, estimatedUsd: Math.round(usd * 1e4) / 1e4, reports: calls.map(c => c?.calls) },
        spotCheck: spot ? { method: spot.method, summary: spot.summary } : undefined,
        timingsMs: { split: split.ms },
        blobs,
        edges: split.edges
    };
    fs.writeFileSync(path.join(out, 'blob_graph.json'), JSON.stringify(graph, null, 1));
    console.log(JSON.stringify({ ...graph.counts, modelCalls: { requests, usd } }, null, 1));
}

main();
