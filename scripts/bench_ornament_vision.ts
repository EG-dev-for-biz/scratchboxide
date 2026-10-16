/**
 * Benchmark of the facade-detail vision call (BILLED: every call is a paid Gemini call).
 *
 * It reads one evidence pack with the staged build's own reader (readOrnament) N times per model and writes the
 * measurements to docs/benchmarks/ornament-vision-<date>.md: time to first token, total time, output and thinking
 * tokens, decode rate (output tokens / (total - first token)), finishReason, whether the reply was usable, what the
 * validator kept and dropped, and, when the pack has a hand annotation, agreement on which slots hold detail (F1).
 *
 * It makes no call unless --yes-billed is given. Without it, it only prints what it would do.
 *
 *   npx ts-node --transpile-only scripts/bench_ornament_vision.ts --pack <dir> [--models gemini-4-argon,gemini-3.8-flash]
 *       [--calls 10] [--out docs/benchmarks] --yes-billed
 *
 * The pack directory holds:
 *   structure_fit.json   a StructureFit written by scan_fit (its outputs.orthos paths are read as written)
 *   annotation.json      optional: { "<slotId>": <number of elements a person sees>, ... }
 *   views.json           optional: [{ panoId, headingDeg, pitchDeg, fovDeg, distanceM, aspectRatio }] Street View views, fetched
 *                        ONCE through StreetViewGroundingImageService into this process's memory (never written to disk)
 *
 * The rule the report applies when it names a model (design 5.4): the lower p50 total time, unless its slot F1 is more
 * than 0.05 below the other's, its replies are not 100% usable, or any call ended at MAX_TOKENS. With 10 calls the
 * p90 is the 9th value; no p95 is claimed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { GeminiClient } from '../packages/core/src/node/gemini/gemini-client';
import { VisionModelChain } from '../packages/core/src/node/gemini/vision-model-chain';
import { createStreetViewGroundingImageService } from '../packages/core/src/node/spatial/StreetViewGroundingImageService';
import { orthoCaption, orthoRef, readOrnament, streetViewCaption, VisionStageError, type EvidenceInput } from '../packages/core/src/node/3d-engine/staged-location/ornament-vision';
import { sha256File } from '../packages/core/src/node/3d-engine/staged-location/stage-cache';
import { readJpegSize } from '../packages/core/src/node/spatial/StreetViewPoseRegistrar';
import type { EvidenceImageRef, StructureFit } from '../packages/core/src/common/spatial/staged-location-contracts';
import * as crypto from 'crypto';

interface CallRecord {
    model: string;
    ok: boolean;
    error?: string;
    totalMs: number;
    ttftMs?: number;
    outputTokens?: number;
    thinkingTokens?: number;
    decodeTokensPerS?: number;
    finishReason?: string;
    revisionPass: boolean;
    kept: number;
    dropped: number;
    slotsWithDetail: string[];
}

function arg(name: string, fallback?: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
}

function percentile(values: number[], p: number): number | undefined {
    if (!values.length) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function f1(predicted: Set<string>, truth: Set<string>): number {
    if (!predicted.size && !truth.size) return 1;
    const tp = [...predicted].filter(s => truth.has(s)).length;
    const precision = predicted.size ? tp / predicted.size : 0;
    const recall = truth.size ? tp / truth.size : 0;
    return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

async function main(): Promise<void> {
    const pack = arg('pack');
    if (!pack) throw new Error('give --pack <directory> (see the header of this script)');
    const models = (arg('models', 'gemini-4-argon,gemini-3.8-flash') as string).split(',').map(m => m.trim()).filter(Boolean);
    const calls = Math.max(1, parseInt(arg('calls', '10') as string, 10));
    const outDir = path.resolve(arg('out', 'docs/benchmarks') as string);
    const billed = process.argv.includes('--yes-billed');

    const fitPath = path.join(pack, 'structure_fit.json');
    const fit = JSON.parse(fs.readFileSync(fitPath, 'utf8')) as StructureFit;
    const fitSha = sha256File(fitPath);
    const annotationPath = path.join(pack, 'annotation.json');
    const annotation: Record<string, number> | undefined = fs.existsSync(annotationPath) ? JSON.parse(fs.readFileSync(annotationPath, 'utf8')) : undefined;
    const viewsPath = path.join(pack, 'views.json');
    const views: Array<{ panoId: string; headingDeg: number; pitchDeg: number; fovDeg: number; distanceM: number; aspectRatio?: string }> =
        fs.existsSync(viewsPath) ? JSON.parse(fs.readFileSync(viewsPath, 'utf8')) : [];

    console.log(`pack ${pack}: ${fit.surfaces.length} surfaces, ${fit.slots.length} slots, ${fit.outputs.orthos.length} orthos, ${views.length} Street View views`);
    console.log(`plan: ${models.length} models x ${calls} calls = ${models.length * calls} billed vision calls${views.length ? `, plus ${views.length} grounding image fetches` : ''}`);
    if (!billed) {
        console.log('dry run: nothing was called. Add --yes-billed to make the billed calls.');
        return;
    }

    const gemini = new GeminiClient();
    const client = await gemini.getGenAIClient();
    if (!client) throw new Error('no Gemini credentials are configured');

    // the evidence, built once: orthos from the pack, Street View images fetched once, in memory only
    const evidence: EvidenceInput[] = [];
    for (const o of fit.outputs.orthos) {
        const bytes = fs.readFileSync(o.path);
        const ref = orthoRef(o, evidence.length, fit, bytes);
        evidence.push({ ref, bytes, mimeType: 'image/png', caption: orthoCaption(ref, fit) });
    }
    if (views.length) {
        if (!gemini.ensureAuth()) throw new Error('Street View images need the Google Cloud service account (Maps Imagery Grounding API)');
        const grounding = createStreetViewGroundingImageService(gemini);
        for (const v of views) {
            const shot = await grounding.retrieveGroundingImage({
                panoId: v.panoId, headingDegree: v.headingDeg, pitchDegree: v.pitchDeg, fovDegree: v.fovDeg, aspectRatio: v.aspectRatio as never
            });
            const size = readJpegSize(shot.image) ?? { width: 0, height: 0 };
            const ref: EvidenceImageRef = {
                id: `sv:${v.panoId}:${Math.round(v.headingDeg)}:${Math.round(v.pitchDeg)}:${Math.round(v.fovDeg)}`, index: evidence.length, kind: 'streetview-grounding',
                widthPx: size.width, heightPx: size.height, sha256: crypto.createHash('sha256').update(shot.image).digest('hex'),
                nativeSampleM: size.width ? (v.distanceM * (v.fovDeg * Math.PI) / 180) / size.width : 0, panoId: v.panoId, copyright: '© Google',
                headingDeg: v.headingDeg, pitchDeg: v.pitchDeg, fovDeg: v.fovDeg, distanceM: v.distanceM, slotsShown: []
            } as EvidenceImageRef;
            evidence.push({ ref, bytes: shot.image, mimeType: shot.mimeType, caption: streetViewCaption(ref) });
        }
    }

    const records: CallRecord[] = [];
    for (const model of models) {
        for (let i = 0; i < calls; i++) {
            const chain = new VisionModelChain<string>({ client: client as never, candidates: [model] });
            const started = Date.now();
            try {
                const reading = await readOrnament({ fit, fitSha256: fitSha, evidence, chain });
                const m = reading.spec.model;
                const totalMs = Date.now() - started;
                records.push({
                    model, ok: true, totalMs, ttftMs: m.ttftMs, outputTokens: m.outputTokens, thinkingTokens: m.thinkingTokens, finishReason: m.finishReason,
                    decodeTokensPerS: m.outputTokens && m.ttftMs !== undefined && totalMs > m.ttftMs ? m.outputTokens / ((totalMs - m.ttftMs) / 1000) : undefined,
                    revisionPass: reading.spec.revision.passes === 1, kept: reading.spec.elements.length, dropped: reading.spec.dropped.length,
                    slotsWithDetail: [...new Set(reading.spec.elements.map(e => e.slotId))]
                });
            } catch (err) {
                const model = err instanceof VisionStageError ? err.model : undefined;
                records.push({
                    model: model?.used ?? models[0], ok: false, error: (err as Error).message, totalMs: Date.now() - started, ttftMs: model?.ttftMs,
                    outputTokens: model?.outputTokens, thinkingTokens: model?.thinkingTokens, finishReason: model?.finishReason, revisionPass: false, kept: 0, dropped: 0, slotsWithDetail: []
                });
            }
            console.log(`${model} call ${i + 1}/${calls}: ${records[records.length - 1].ok ? 'ok' : `failed (${records[records.length - 1].error})`} in ${(records[records.length - 1].totalMs / 1000).toFixed(1)} s`);
        }
    }

    // the report
    const truth = annotation ? new Set(Object.entries(annotation).filter(([, n]) => n > 0).map(([id]) => id)) : undefined;
    const rows = models.map(model => {
        const mine = records.filter(r => r.model === model || (r.model !== model && models.length === 1));
        const totals = mine.map(r => r.totalMs / 1000);
        const f1s = truth ? mine.filter(r => r.ok).map(r => f1(new Set(r.slotsWithDetail), truth)) : [];
        return {
            model, calls: mine.length, usable: mine.filter(r => r.ok).length,
            p50: percentile(totals, 0.5), p90: percentile(totals, 0.9), max: Math.max(...totals),
            ttftP50: percentile(mine.map(r => r.ttftMs).filter((v): v is number => v !== undefined).map(v => v / 1000), 0.5),
            decodeP50: percentile(mine.map(r => r.decodeTokensPerS).filter((v): v is number => v !== undefined), 0.5),
            outputTokensP50: percentile(mine.map(r => r.outputTokens).filter((v): v is number => v !== undefined), 0.5),
            thinkingTokensP50: percentile(mine.map(r => r.thinkingTokens).filter((v): v is number => v !== undefined), 0.5),
            maxTokens: mine.filter(r => r.finishReason === 'MAX_TOKENS').length,
            revisions: mine.filter(r => r.revisionPass).length,
            keptP50: percentile(mine.map(r => r.kept), 0.5), droppedP50: percentile(mine.map(r => r.dropped), 0.5),
            f1: f1s.length ? f1s.reduce((a, b) => a + b, 0) / f1s.length : undefined
        };
    });
    const eligible = rows.filter(r => r.usable === r.calls && r.maxTokens === 0);
    const best = [...eligible].sort((a, b) => (a.p50 ?? Infinity) - (b.p50 ?? Infinity))[0];
    const date = new Date().toISOString().slice(0, 10);
    const fmt = (v: number | undefined, d = 1) => (v === undefined ? 'n/a' : v.toFixed(d));
    const md = [
        `# Ornament vision benchmark, ${date}`,
        '',
        `Pack: ${path.basename(pack)} (${fit.surfaces.length} surfaces, ${fit.slots.length} slots, ${fit.outputs.orthos.length} tile orthos, ${views.length} Street View images). ${calls} calls per model. p90 is the ${Math.ceil(0.9 * calls)}th value of ${calls}; no p95 is claimed.`,
        '',
        '| model | calls | usable | p50 s | p90 s | max s | first token p50 s | decode tok/s p50 | output tok p50 | thinking tok p50 | MAX_TOKENS | revisions | kept p50 | dropped p50 | slot F1 |',
        '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
        ...rows.map(r => `| ${r.model} | ${r.calls} | ${r.usable} | ${fmt(r.p50)} | ${fmt(r.p90)} | ${fmt(r.max)} | ${fmt(r.ttftP50)} | ${fmt(r.decodeP50, 0)} | ${fmt(r.outputTokensP50, 0)} | ${fmt(r.thinkingTokensP50, 0)} | ${r.maxTokens} | ${r.revisions} | ${fmt(r.keptP50, 0)} | ${fmt(r.droppedP50, 0)} | ${fmt(r.f1, 2)} |`),
        '',
        best ? `Lower p50 total time among the models whose replies were all usable and none ended at MAX_TOKENS: **${best.model}** (${fmt(best.p50)} s). Compare slot F1 before adopting it (the rule: not more than 0.05 below the other).` : 'No model had all replies usable with no MAX_TOKENS.',
        '',
        '## Failed calls',
        ...(records.filter(r => !r.ok).map(r => `- ${r.model}: ${r.error}`).concat(records.some(r => !r.ok) ? [] : ['none']))
    ].join('\n');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `ornament-vision-${date}.md`);
    fs.writeFileSync(outFile, `${md}\n`);
    console.log(`wrote ${outFile}`);
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
