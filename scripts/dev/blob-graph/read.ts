/**
 * Blob graph prototype (dev tool, not shipped), step 5: vision readers (plan §5.3). Makes billed model calls: run on
 * purpose, never under a test runner.
 *
 *   node -r ts-node/register scripts/dev/blob-graph/read.ts --out <dir> --place "<place words>" [--concurrency 6] [--limit N]
 *
 * With the app's Gemini client and vision chain (the facade reader's model first: gemini-3.8-flash at a low thinking
 * budget, the app's other vision models behind it), every request metered (model-call-budget.ts):
 *   1. a district brief from the overviews;
 *   2. per building, its sheet with its child blobs numbered (roof objects and wall attachments together), told the brief;
 *   3. per selected non-building blob, its reader sheet (photo x4, clay x4, outlined context), told the brief, where it
 *      stands and its measurements; an unsure reader may ask for up to four more views (closer, lower, other light,
 *      neighbour), rendered on demand, and answers again;
 *   4. per read blob, an independent judge shown only the held-out view and the description: agree or not.
 * Answers are kept in a model readings store (pipeline-k/model-readings.ts) keyed by the blob's geometry hash, the
 * images' bytes and the prompt version, so a rerun asks nothing it has asked before.
 * The readings are labels only: nothing here changes a blob's geometry or group.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { GeminiClient } from '../../../packages/core/src/node/gemini/gemini-client';
import { VisionModelChain, VISION_CALL_POLICY } from '../../../packages/core/src/node/gemini/vision-model-chain';
import { budgetedClient, ModelCallMeter } from '../../../packages/core/src/node/gemini/model-call-budget';
import { fileReadingStore, readingKey } from '../../../packages/core/src/node/3d-engine/staged-location/pipeline-k/model-readings';
import { FACADE_READER_MODEL } from '../../../packages/core/src/node/3d-engine/staged-location/pipeline-k/facade-reader';
import type { BlobRecord } from './split';

const PROMPT_VERSION = 'blob-reader/1';

function arg(name: string, fallback?: string): string {
    const i = process.argv.indexOf(`--${name}`);
    const v = i >= 0 ? process.argv[i + 1] : fallback;
    if (v === undefined) throw new Error(`--${name} is required`);
    return v;
}

const sha = (b: crypto.BinaryLike) => crypto.createHash('sha256').update(b).digest('hex');

function parseJson(text: string): any { // eslint-disable-line @typescript-eslint/no-explicit-any
    const t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try { return JSON.parse(t); } catch { /* fall through */ }
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error(`not JSON: ${t.slice(0, 200)}`);
}

function limiter(n: number): <T>(f: () => Promise<T>) => Promise<T> {
    let active = 0; const queue: Array<() => void> = [];
    return async <T>(f: () => Promise<T>) => {
        if (active >= n) await new Promise<void>(r => queue.push(r));
        active++;
        try { return await f(); } finally { active--; queue.shift()?.(); }
    };
}

function describeMeasures(m: Record<string, any>): string { // eslint-disable-line @typescript-eslint/no-explicit-any
    const s = m.sizeM as number[];
    return `size ${s[0].toFixed(1)} x ${s[2].toFixed(1)} m in plan, ${s[1].toFixed(1)} m tall; surface ${Number(m.areaM2).toFixed(1)} m2; ` +
        `its lowest point ${Number(m.heightAboveSupportM).toFixed(1)} m above what it stands on; verticality ${m.verticality}, planarity ${m.planarity}, ` +
        `axial symmetry about a vertical axis ${m.axialSymmetry}, elongation ${m.elongation}; mean colour sRGB ${(m.meanSrgb as number[]).join(',')}`;
}

function whereItStands(b: BlobRecord, blobs: BlobRecord[], buildingWords: Map<number, string>): string {
    const host = b.parent ?? b.attachedTo;
    const hostWords = host !== undefined ? buildingWords.get(host) : undefined;
    const g = b.group;
    if (g === 'roof-object') return `It stands on the roof of a building${hostWords ? ` (read as: ${hostWords})` : ''}, proud of the roof's fitted plane.`;
    if (g === 'wall-attachment') return `It stands proud of a building's wall${hostWords ? ` (read as: ${hostWords})` : ''}, off the wall's fitted plane or outside its footprint above the street.`;
    if (g === 'tree') return 'It stands in the street area, on cells the tree classifier marked as canopy by colour and roughness.';
    if (g === 'transient-candidate') return 'It stands on the street surface, on a vehicle-sized proud lump of the carriageway.';
    if (g === 'ground') return 'It is the ground surface of the district.';
    void blobs;
    return 'It stands on the street surface, apart from the buildings.';
}

const BLOB_JSON = `Answer JSON only:
{"description": "an open description in under 20 words of what this is (say 'scan artefact' or 'unclear fragment' if it is not a real thing)",
 "manufactured": 0..1 (0 organic, 1 manufactured), "permanence": 0..1 (0 passes by in minutes, 1 permanent), "symmetry": 0..1,
 "material": "likely material", "roughness": 0..1, "metalness": 0..1,
 "rebuildNote": "one sentence on what to keep in mind when rebuilding it",
 "confidence": 0..1,
 "moreViews": [] or up to 4 of "closer", "lower", "other-light", "neighbour" — ask only if you are unsure (confidence under 0.6)}`;

async function main(): Promise<void> {
    const out = path.resolve(arg('out'));
    const place = arg('place');
    const concurrency = Number(arg('concurrency', '6'));
    const limit = Number(arg('limit', '100000'));
    const graph = JSON.parse(fs.readFileSync(path.join(out, 'split', 'blobs.json'), 'utf8')) as { blobs: BlobRecord[] };
    const blobs = graph.blobs;
    const sel = JSON.parse(fs.readFileSync(path.join(out, 'selection.json'), 'utf8')) as { always: number[]; others: number[] };
    const store = fileReadingStore(path.join(out, 'model_readings'));
    const meter = new ModelCallMeter();
    const gemini = new GeminiClient();
    const raw = await gemini.getGenAIClient();
    if (!raw) throw new Error('no Gemini credentials');
    const client = budgetedClient(raw as never, { meter });
    const candidates = [...new Set([FACADE_READER_MODEL.model, ...gemini.getModelCandidates()])];
    const chain = new VisionModelChain<string>({ client: client as never, candidates });
    const replyText = (res: any) => (res.candidates?.[0]?.content?.parts ?? []).filter((q: any) => !q.thought).map((q: any) => q.text ?? '').join(''); // eslint-disable-line @typescript-eslint/no-explicit-any
    const slot = limiter(concurrency);
    let asked = 0, cached = 0;
    const ask = async (kind: string, keyParts: unknown[], images: Buffer[], prompt: string): Promise<any> => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const key = readingKey(kind, [PROMPT_VERSION, ...keyParts, ...images.map(sha), prompt]);
        const kept = await store.get<{ text: string; model: string }>(key);
        if (kept) { cached++; return { ...parseJson(kept.text), _model: kept.model, _cached: true }; }
        return slot(async () => {
            const res = await chain.generate({ contents: [{ role: 'user', parts: [...images.map(p => ({ inlineData: { mimeType: 'image/png', data: p.toString('base64') } })), { text: prompt }] }], config: { responseMimeType: 'application/json', temperature: 0 } },
                { stage: 'grammar', ...VISION_CALL_POLICY.grammar, thinkingBudget: FACADE_READER_MODEL.thinkingBudget, valid: x => { try { parseJson(replyText(x)); return true; } catch { return false; } } });
            const text = replyText(res.response);
            res.remember();
            asked++;
            const model = (res as any).model ?? candidates[0]; // eslint-disable-line @typescript-eslint/no-explicit-any
            store.put(key, { text, model });
            return { ...parseJson(text), _model: model };
        });
    };
    const t0 = Date.now();
    const readDir = path.join(out, 'readings');
    fs.mkdirSync(readDir, { recursive: true });

    // 1. the district brief
    const overviews = ['overview_oblique.png', 'overview_oblique_n.png', 'overview_photo.png'].map(f => fs.readFileSync(path.join(out, f)));
    const brief = await ask('blob-brief', [place], overviews, `These are renders of a photogrammetry scan of one city district: ${place}. Two oblique views from opposite sides, then a top-down view (north up). ` +
        `Write a short brief for readers who will identify every object in the scan: the place, its era(s), its street pattern, the kinds of building and what stands in its streets and on its roofs. ` +
        `Answer JSON only: {"place": "...", "era": "...", "streets": "...", "buildingKinds": ["..."], "streetscape": "...", "roofscape": "...", "brief": "the brief in under 120 words"}`);
    fs.writeFileSync(path.join(readDir, 'brief.json'), JSON.stringify(brief, null, 1));
    const briefText = String(brief.brief ?? '');
    console.log(`brief: ${briefText}`);

    // 2. buildings, each with its children numbered
    const buildingWords = new Map<number, string>();
    const buildingIdx = sel.always.filter(i => blobs[i].group === 'building').slice(0, limit);
    await Promise.all(buildingIdx.map(async bi => {
        const dir = path.join(out, 'views', String(bi));
        if (!fs.existsSync(path.join(dir, 'building_sheet.png'))) return;
        const children: number[] = JSON.parse(fs.readFileSync(path.join(dir, 'building_children.json'), 'utf8'));
        const m = blobs[bi].measures as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        const prompt = `District brief: ${briefText}\n\nThe first image shows one building of this district from the photogrammetry scan, from two sides, with its ${children.length} child blobs ` +
            `(things standing proud of its roof or walls, found by geometry) numbered in yellow on black at their centres. The second image is the building's reader sheet: four photo-textured views, the same four in clay, and the building outlined in its context. ` +
            `Building measurements: ${describeMeasures(m)}.\nSay what the building is and what each numbered child is, consistently. ` +
            `Answer JSON only: {"description": "under 25 words", "use": "...", "era": "...", "facadeMaterial": "...", "roof": "...", "confidence": 0..1, ` +
            `"children": [{"n": 1, "description": "under 15 words", "confidence": 0..1}, ...]}`;
        try {
            const r = await ask('blob-building', [blobs[bi].id, blobs[bi].triangles], [fs.readFileSync(path.join(dir, 'building_sheet.png')), fs.readFileSync(path.join(dir, 'sheet.png'))], prompt);
            buildingWords.set(bi, String(r.description ?? ''));
            const childReadings = (Array.isArray(r.children) ? r.children : []).map((c: any) => ({ blob: children[Number(c.n) - 1], description: c.description, confidence: c.confidence })).filter((c: any) => c.blob !== undefined); // eslint-disable-line @typescript-eslint/no-explicit-any
            fs.writeFileSync(path.join(readDir, `${bi}.building.json`), JSON.stringify({ ...r, childReadings }, null, 1));
        } catch (err) { fs.writeFileSync(path.join(readDir, `${bi}.building.error`), String(err)); }
    }));
    console.log(`buildings read: ${buildingWords.size} (${asked} asked, ${cached} cached, ${Date.now() - t0} ms)`);

    // 3. blob readers (non-buildings), with more views on request
    let sceneMod: typeof import('./views') | undefined, scene: import('./views').Scene | undefined;
    const sceneLock = limiter(1);
    const extra = async (bi: number, kinds: string[]): Promise<Buffer[]> => sceneLock(async () => {
        sceneMod ??= await import('./views');
        scene ??= sceneMod.loadScene(out, blobs.length);
        return kinds.map(k => sceneMod!.png(sceneMod!.extraView(scene!, bi, k as never)));
    });
    const blobIdx = [...sel.always, ...sel.others].filter(i => blobs[i].group !== 'building').slice(0, limit);
    await Promise.all(blobIdx.map(async bi => {
        const dir = path.join(out, 'views', String(bi));
        if (!fs.existsSync(path.join(dir, 'sheet.png'))) return;
        const b = blobs[bi];
        const sheet = fs.readFileSync(path.join(dir, 'sheet.png'));
        const base = `District brief: ${briefText}\n\nThe image is a reader sheet of one blob (one connected piece) of the district's photogrammetry scan: the blob alone from four sides with the scan's photo texture (top row), ` +
            `the same four views in plain clay (second row; trust clay for shape, the photo for material), and the blob outlined in magenta in its surroundings. ` +
            `${whereItStands(b, blobs, buildingWords)} Measurements: ${describeMeasures(b.measures as never)}.\nWhat is it?\n${BLOB_JSON}`;
        try {
            let r = await ask('blob-reader', [b.id], [sheet], base);
            const views: string[] = [];
            const asks = Array.isArray(r.moreViews) ? r.moreViews.filter((k: string) => ['closer', 'lower', 'other-light', 'neighbour'].includes(k)).slice(0, 4) : [];
            if (Number(r.confidence) < 0.6 && asks.length) {
                const imgs = await extra(bi, asks);
                imgs.forEach((im, k) => fs.writeFileSync(path.join(dir, `extra_${asks[k]}.png`), im));
                views.push(...asks);
                const first = r;
                r = await ask('blob-reader-more', [b.id, asks], [sheet, ...imgs], `${base}\n\nYou asked for more views; they follow the sheet, in this order: ${asks.join(', ')} ` +
                    `(other-light is clay lit by a low sun from another side; neighbour is a wider context with the blob outlined). Your first answer was: ${JSON.stringify({ description: first.description, confidence: first.confidence })}. ` +
                    `Answer again; do not ask for more views ("moreViews": []).`);
                r.firstAnswer = { description: first.description, confidence: first.confidence };
            }
            fs.writeFileSync(path.join(readDir, `${bi}.reader.json`), JSON.stringify({ ...r, extraViews: views }, null, 1));
        } catch (err) { fs.writeFileSync(path.join(readDir, `${bi}.reader.error`), String(err)); }
    }));
    console.log(`blobs read (${asked} asked, ${cached} cached, ${Date.now() - t0} ms)`);

    // 4. judges: the held-out view and the description only
    const judged = [...sel.always, ...sel.others].slice(0, limit * 2);
    await Promise.all(judged.map(async bi => {
        const dir = path.join(out, 'views', String(bi));
        const b = blobs[bi];
        const f = b.group === 'building' ? path.join(readDir, `${bi}.building.json`) : path.join(readDir, `${bi}.reader.json`);
        if (!fs.existsSync(f) || !fs.existsSync(path.join(dir, 'heldout.png'))) return;
        const reading = JSON.parse(fs.readFileSync(f, 'utf8'));
        const s = (b.measures.sizeM as number[]);
        const prompt = `The image is one piece of a photogrammetry scan of a city (${place}), rendered alone with its photo texture from above at an angle. It measures ${s[0].toFixed(1)} x ${s[2].toFixed(1)} m in plan and ${s[1].toFixed(1)} m tall. ` +
            `Another reader described it as: "${reading.description}". Judge independently whether that description fits what you see. ` +
            `Answer JSON only: {"agree": true or false, "fit": 0..1, "own": "your own description in under 15 words", "why": "under 20 words"}`;
        try {
            const j = await ask('blob-judge', [b.id, reading.description], [fs.readFileSync(path.join(dir, 'heldout.png'))], prompt);
            fs.writeFileSync(path.join(readDir, `${bi}.judge.json`), JSON.stringify(j, null, 1));
        } catch (err) { fs.writeFileSync(path.join(readDir, `${bi}.judge.error`), String(err)); }
    }));
    const report = { asked, cached, ms: Date.now() - t0, calls: meter.report(), store: { ...store.report(), used: undefined, writtenKeys: undefined } };
    fs.writeFileSync(path.join(readDir, `calls_${Date.now()}.json`), JSON.stringify(report, null, 1));
    console.log(JSON.stringify(report.calls, null, 1));
    console.log(`done: ${asked} asked, ${cached} cached in ${Date.now() - t0} ms`);
}

main().catch(err => { console.error(err); process.exit(1); });
