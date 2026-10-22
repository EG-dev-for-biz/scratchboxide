/**
 * The replica scorecard (dev tool): renders the photogrammetry tiles (the reference) and a procedural rebuild of the same
 * district (textured, and the same geometry in clay) from a fixed camera set, scores every view (structure-masked SSIM,
 * edge chamfer, CIEDE2000 against the tiles; a blind vision judge of each arm as a replica of the reference; a believability
 * judge of each render alone) and writes a contact sheet per view, a summary sheet and report.json.
 * The maths lives in packages/core/src/node/3d-engine/staged-location/replica-scorecard.ts and photo-match-eval.ts.
 *
 *   npx tsx --env-file=.env scripts/replica_scorecard.ts \
 *     --reference <tiles textured.glb> [--structure-scan <tree-stripped tiles .glb>] \
 *     --procedural <massing.glb[,more.glb]> [--procedural-ground <ground.glb,roads.glb>] \
 *     [--cameras scripts/replica-scorecard/federation-square.cameras.json] [--views id,id] \
 *     --out docs/screenshots/replica/<run> [--no-judge] [--repeats 2] [--concurrency 6] [--supersample 2]
 *
 * --procedural-ground layers are part of the textured arm; in the clay arm they are drawn as the lighter context clay so the
 * structure reads against them. The structure mask comes from --structure-scan's ground model (StreetViewSurveyPlanner's
 * buildGroundModel, 1 m cells) applied to the reference's triangles; pass the tree-stripped scan so canopy is not structure.
 * Real model calls are made unless --no-judge (tests never run this script).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as pm from '../packages/core/src/node/3d-engine/staged-location/photo-match-eval';
import * as rs from '../packages/core/src/node/3d-engine/staged-location/replica-scorecard';
import { readTileTriangles, type TileTriangles } from '../packages/core/src/node/3d-engine/staged-location/tile-texture-transfer';
import { buildGroundModel, loadScanMesh } from '../packages/core/src/node/spatial/StreetViewSurveyPlanner';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function arg(name: string, fallback?: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const list = (s?: string) => (s ? s.split(',').map(x => x.trim()).filter(Boolean) : []);

async function judgeClient(): Promise<Json> {
    const { GeminiClient, FALLBACK_GEMINI_MODELS } = await import('../packages/core/src/node/gemini/gemini-client');
    const { VisionModelChain } = await import('../packages/core/src/node/gemini/vision-model-chain');
    const client = await new GeminiClient().getGenAIClient();
    if (!client) throw new Error('no Gemini credentials are configured for the judge');
    return new VisionModelChain({ client, candidates: [...new Set(['gemini-4-argon', ...FALLBACK_GEMINI_MODELS])] } as Json);
}

/** Runs promise factories with at most `n` in flight. */
function limiter(n: number): <T>(f: () => Promise<T>) => Promise<T> {
    let active = 0;
    const queue: Array<() => void> = [];
    const next = () => { if (active < n && queue.length) { active++; queue.shift()!(); } };
    return <T>(f: () => Promise<T>) => new Promise<T>((resolve, reject) => {
        queue.push(() => f().then(resolve, reject).finally(() => { active--; next(); }));
        next();
    });
}

function load(glbs: string[]): TileTriangles[] {
    return glbs.map(g => {
        const t = readTileTriangles(new Uint8Array(fs.readFileSync(g)));
        console.log(`[replica] ${path.basename(g)}: ${t.texture.length} triangles, ${t.textures.length} textures`);
        return t;
    });
}

const f1 = (s: rs.Stat | undefined) => (s && s.n ? s.mean.toFixed(1) : '-');

async function main(): Promise<void> {
    const cams = rs.validateCameraSet(JSON.parse(fs.readFileSync(path.resolve(arg('cameras', path.join(__dirname, 'replica-scorecard/federation-square.cameras.json'))!), 'utf8')));
    const reference = arg('reference');
    const procedural = list(arg('procedural'));
    if (!reference || !procedural.length) throw new Error('--reference and --procedural are required');
    const proceduralGround = list(arg('procedural-ground'));
    const outDir = path.resolve(arg('out', `docs/screenshots/replica/${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`)!);
    const noJudge = process.argv.includes('--no-judge');
    const repeats = Number(arg('repeats', '2'));
    const ss = Number(arg('supersample', '2'));
    const only = new Set(list(arg('views')));
    fs.mkdirSync(outDir, { recursive: true });

    const t0 = Date.now();
    const [ref] = load([reference]);
    const structureScan = arg('structure-scan', reference)!;
    const ground = buildGroundModel(loadScanMesh(structureScan), { cellMeters: 1 });
    const flags = rs.classifyStructure(ref, ground);
    const split = rs.splitStructure(ref, flags);
    console.log(`[replica] structure: ${split.structure.texture.length} of ${ref.texture.length} reference triangles (ground model of ${path.basename(structureScan)}, ${ground.terrainMethod})`);
    const procMeshes = load(procedural), procGround = load(proceduralGround);
    console.log(`[replica] loaded in ${Date.now() - t0} ms`);

    const chain = noJudge ? undefined : await judgeClient();
    const limit = limiter(Number(arg('concurrency', '6')));
    const ARMS = ['procedural', 'procedural_clay'] as const;
    const LABEL: Record<string, string> = { tiles: 'A PHOTO TILES (REFERENCE)', procedural: 'B PROCEDURAL', procedural_clay: 'C PROCEDURAL CLAY' };
    const views = cams.views.filter(v => !only.size || only.has(v.id));
    const report: Json = {
        schema: 'scratchbox.replica-scorecard/1', place: cams.place, createdAt: new Date().toISOString(), size: [cams.width, cams.height], supersample: ss,
        inputs: { reference, structureScan, procedural, proceduralGround, cameras: arg('cameras') ?? 'scripts/replica-scorecard/federation-square.cameras.json' },
        structureParams: rs.STRUCTURE_PARAMS, judged: !noJudge, repeats, views: [] as Json[]
    };
    const pending: Array<Promise<void>> = [];
    const sheets: Array<{ image: Json; label: string; sublabel?: string }> = [];
    for (const v of views) {
        const camera = rs.replicaCamera(v, cams.width, cams.height);
        const rRef = pm.renderTriangles([ref], camera, { supersample: ss });
        const rProc = pm.renderTriangles([...procMeshes, ...procGround], camera, { supersample: ss });
        const rClay = pm.renderTriangles(procMeshes, camera, { supersample: ss, clay: true, context: procGround });
        const mask = rs.structureMask(split, camera);
        const maskPixels = mask.reduce((s, x) => s + x, 0);
        const renders: Record<string, pm.ArmRender> = { tiles: rRef, procedural: rProc, procedural_clay: rClay };
        const pngs: Record<string, Buffer> = {};
        for (const [id, r] of Object.entries(renders)) { pngs[id] = pm.renderPng(r); fs.writeFileSync(path.join(outDir, `${v.id}_${id}.png`), pngs[id]); }
        const perceptual: Json = {};
        for (const id of ARMS) perceptual[id] = maskPixels >= 200 ? pm.perceptualScores(rs.asImage(rRef), renders[id], mask) : null;
        const entry: Json = { id: v.id, kind: v.kind, label: v.label, maskShare: Math.round((maskPixels / mask.length) * 1e4) / 1e4, perceptual, renderMs: { tiles: rRef.ms, procedural: rProc.ms, procedural_clay: rClay.ms } };
        report.views.push(entry);
        console.log(`[replica] ${v.id}: mask ${(entry.maskShare * 100).toFixed(1)}%; ${ARMS.map(a => `${a} ssim ${perceptual[a]?.ssim} edge ${perceptual[a]?.edgeChamferPx} dE ${perceptual[a]?.colourDeltaE} cov ${perceptual[a]?.coverage}`).join(' | ')}`);
        const writeSheet = () => {
            // two short lines per tile (35 characters fit at this width): the metrics with the label, the judges below
            const head = (id: string, short: string) => { const p = perceptual[id]; return p ? `${short} SSIM ${p.ssim ?? '-'} DE ${p.colourDeltaE == null ? '-' : Math.round(p.colourDeltaE)}` : short; };
            const sub = (id: string) => {
                const j = entry.replica?.stats?.[id], b = entry.believability?.[id];
                return [j ? `REPLICA ${f1(j.overall)}` : '', b ? `BELIEVE ${f1(b.stat)}` : ''].filter(Boolean).join('  ') || 'NOT JUDGED';
            };
            const tiles = [
                { image: rRef, label: LABEL.tiles, sublabel: entry.believability?.tiles ? `BELIEVE ${f1(entry.believability.tiles.stat)}` : 'REFERENCE' },
                { image: rProc, label: head('procedural', 'B PROCEDURAL'), sublabel: sub('procedural') },
                { image: rClay, label: head('procedural_clay', 'C CLAY'), sublabel: sub('procedural_clay') },
                { image: rs.maskOverlay(rRef, mask), label: 'STRUCTURE MASK', sublabel: `${(entry.maskShare * 100).toFixed(1)}% OF VIEW` }
            ];
            fs.writeFileSync(path.join(outDir, `${v.id}.png`), pm.composeGrid(tiles, { tileWidth: 640, columns: 2, title: `${v.id} - ${v.label}`.slice(0, 70) }));
            return tiles;
        };
        writeSheet();
        if (chain) {
            pending.push((async () => {
                const [replicaRuns, ...bel] = await Promise.all([
                    limit(() => rs.judgeReplicaView({ client: chain, place: cams.place, reference: pngs.tiles, renders: ARMS.map(a => ({ armId: a, png: pngs[a] })), repeats, seed: `replica:${v.id}` })),
                    ...(['tiles', ...ARMS] as string[]).map(id => limit(() => rs.judgeBelievability({ client: chain, png: pngs[id], repeats })))
                ]);
                entry.replica = { runs: replicaRuns, stats: rs.aggregateReplicaRuns(replicaRuns, [...ARMS]) };
                entry.believability = Object.fromEntries((['tiles', ...ARMS] as string[]).map((id, k) => [id, { runs: bel[k], stat: rs.stat(bel[k].map(x => x.believability)) }]));
                writeSheet();
                console.log(`[replica] ${v.id} judged: ${ARMS.map(a => `${a} replica ${f1(entry.replica.stats[a].overall)} believe ${f1(entry.believability[a].stat)}`).join(' | ')} | tiles believe ${f1(entry.believability.tiles.stat)}`);
                fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
            })().catch(err => { entry.judgeError = String(err?.message ?? err); console.error(`[replica] ${v.id}: judge failed: ${entry.judgeError}`); }));
        }
        sheets.push({ image: rRef, label: `${v.id} A TILES` }, { image: rProc, label: `${v.id} B PROC` }, { image: rClay, label: `${v.id} C CLAY` });
        fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
    }
    await Promise.all(pending);
    // summary: every arm's means over the views
    const summary: Json = {};
    for (const id of ['tiles', ...ARMS]) {
        const vs = report.views as Json[];
        const per = (k: string) => rs.stat(vs.map(x => x.perceptual?.[id]?.[k]).filter((n: unknown): n is number => typeof n === 'number'));
        summary[id] = {
            believability: rs.stat(vs.flatMap(x => (x.believability?.[id]?.runs ?? []).map((r: Json) => r.believability))),
            ...(id === 'tiles' ? {} : {
                replica: Object.fromEntries(rs.REPLICA_CRITERIA.map(c => [c, rs.stat(vs.flatMap(x => (x.replica?.runs ?? []).map((r: Json) => r.scores[id]?.[c])).filter((n: unknown): n is number => typeof n === 'number'))])),
                ssim: per('ssim'), edgeChamferPx: per('edgeChamferPx'), colourDeltaE: per('colourDeltaE'), coverage: per('coverage')
            })
        };
    }
    report.summary = summary;
    // every defect the judge named for the procedural arms, most severe first
    report.defects = (report.views as Json[]).flatMap(x => [
        ...(x.replica?.runs ?? []).flatMap((r: Json) => ARMS.flatMap(a => (r.scores[a]?.defects ?? []).map((d: Json) => ({ view: x.id, arm: a, judge: 'replica', ...d })))),
        ...ARMS.flatMap(a => (x.believability?.[a]?.runs ?? []).flatMap((r: Json) => r.defects.map((d: Json) => ({ view: x.id, arm: a, judge: 'believability', ...d }))))
    ]).sort((a: Json, b: Json) => b.severity - a.severity);
    if (chain) report.judgeModel = { requested: chain.requested, answered: chain.answeredModel, skipped: chain.skipped };
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
    fs.writeFileSync(path.join(outDir, 'summary.png'), pm.composeGrid(sheets, { tileWidth: 420, columns: 3, title: `${cams.place} - replica scorecard` }));
    console.log(`[replica] summary ${JSON.stringify(Object.fromEntries(Object.entries(summary).map(([k, s]: [string, Json]) => [k, { believe: s.believability.mean, replica: s.replica?.overall.mean, ssim: s.ssim?.mean, dE: s.colourDeltaE?.mean }])))}`);
    console.log(`[replica] wrote ${outDir} in ${Math.round((Date.now() - t0) / 1000)} s`);
}

main().then(() => process.exit(0), err => { console.error('[replica] FAILED', err); process.exit(1); });
