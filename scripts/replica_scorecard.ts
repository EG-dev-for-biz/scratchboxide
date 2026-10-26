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
 *     --out docs/screenshots/replica/<run> [--no-judge] [--repeats 3] [--concurrency 6] [--supersample 2] \
 *     [--light headlight|lit|both] [--sun <azimuthDeg>,<elevationDeg>] \
 *     [--grounded] [--grounded-dir <dir>] [--baseline <old report.json>]
 *
 * --procedural-ground layers are part of the textured arm; in the clay arm they are drawn as the lighter context clay so the
 * structure reads against them. The structure mask comes from --structure-scan's ground model (StreetViewSurveyPlanner's
 * buildGroundModel, 1 m cells) applied to the reference's triangles; pass the tree-stripped scan so canopy is not structure.
 *
 * --light: `headlight` (the default, the original flat light: comparable with every earlier report), `lit` (the lit mode:
 * one sun with cast shadows and ambient occlusion, PHOTO_MATCH_LIT, so relief of the wall's own colour is visible), or `both`
 * (the headlight block stays where it was in report.json; the lit block is `views[].lit`). --sun overrides the default sun
 * (photo-match-eval defaultSunForLatitude of the camera set's anchor, or the camera set's own `sun`).
 *
 * --grounded: for every view, search-grounded reference images of the place from roughly that view (fetchGroundedReferences:
 * Gemini image models with Google Search; generated, never measurements), cached in --grounded-dir (default <out>/grounded,
 * reused when present), shown to an extra replica judgement beside the tiles; that judgement also scores realism and identity
 * and judges the tiles render as an arm too (so a rebuild can be seen to beat the scan). It uses the lit renders when lit.
 *
 * --baseline: an earlier report.json; report.json gains `deltas` (per view, arm and criterion: the change, its standard
 * error from both runs' spreads, and whether it is clear of the judge's noise) for the headlight and lit blocks.
 * Real model calls are made unless --no-judge (tests never run this script).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as pm from '../packages/core/src/node/3d-engine/staged-location/photo-match-eval';
import * as rs from '../packages/core/src/node/3d-engine/staged-location/replica-scorecard';
import { decodeImageInMemory, readTileTriangles, type TileTriangles } from '../packages/core/src/node/3d-engine/staged-location/tile-texture-transfer';
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
const ARMS = ['procedural', 'procedural_clay'] as const;
type Light = 'headlight' | 'lit';

/** The search-grounded references of one view: cached files when present, else fetched and written. */
async function groundedFor(dir: string, place: string, v: rs.ReplicaView, groundY: number | undefined, client: () => Promise<Json>): Promise<Json[]> {
    const vd = path.join(dir, v.id);
    const meta = path.join(vd, 'references.json');
    if (fs.existsSync(meta)) return JSON.parse(fs.readFileSync(meta, 'utf8')).references.map((r: Json) => ({ ...r, file: path.join(vd, r.file) }));
    const { fetchGroundedReferences } = await import('../packages/core/src/node/spatial/search-grounded-reference');
    const request = { place, subject: `the view along ${v.label}`, view: rs.groundedViewPhrase(v, groundY), aspectRatio: '16:9' };
    const res = await fetchGroundedReferences(await client(), request);
    fs.mkdirSync(vd, { recursive: true });
    const refs = res.references.map((r, k) => {
        const file = `${k}_${r.model}.${r.image!.mimeType.includes('jpeg') ? 'jpg' : 'png'}`;
        fs.writeFileSync(path.join(vd, file), r.image!.data);
        return { file, model: r.model, modelVersion: r.modelVersion, mimeType: r.image!.mimeType, account: r.account, queries: r.queries, sources: r.sources };
    });
    fs.writeFileSync(meta, JSON.stringify({ request, prompt: res.prompt, provenance: res.provenance, skipped: res.skipped, references: refs }, null, 1));
    console.log(`[replica] ${v.id}: ${refs.length} grounded reference(s) (${refs.map(r => r.model).join(', ')})${res.skipped.length ? `; skipped ${res.skipped.map(s => s.model).join(', ')}` : ''}`);
    return refs.map(r => ({ ...r, file: path.join(vd, r.file) }));
}

function summarise(views: Json[], pick: (v: Json) => Json, arms: readonly string[]): Json {
    const summary: Json = {};
    for (const id of ['tiles', ...arms]) {
        const vs = views.map(pick).filter(Boolean);
        const per = (k: string) => rs.stat(vs.map(x => x.perceptual?.[id]?.[k]).filter((n: unknown): n is number => typeof n === 'number'));
        summary[id] = {
            believability: rs.stat(vs.flatMap(x => (x.believability?.[id]?.runs ?? []).map((r: Json) => r.believability))),
            ...(id === 'tiles' ? {} : {
                replica: Object.fromEntries(rs.REPLICA_CRITERIA.map(c => [c, rs.stat(vs.flatMap(x => (x.replica?.runs ?? []).map((r: Json) => r.scores[id]?.[c])).filter((n: unknown): n is number => typeof n === 'number'))])),
                ssim: per('ssim'), edgeChamferPx: per('edgeChamferPx'), colourDeltaE: per('colourDeltaE'), coverage: per('coverage')
            })
        };
    }
    return summary;
}

async function main(): Promise<void> {
    const camsPath = arg('cameras', path.join(__dirname, 'replica-scorecard/federation-square.cameras.json'))!;
    const camsJson = JSON.parse(fs.readFileSync(path.resolve(camsPath), 'utf8'));
    const cams = rs.validateCameraSet(camsJson);
    const reference = arg('reference');
    const procedural = list(arg('procedural'));
    if (!reference || !procedural.length) throw new Error('--reference and --procedural are required');
    const proceduralGround = list(arg('procedural-ground'));
    const outDir = path.resolve(arg('out', `docs/screenshots/replica/${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`)!);
    const noJudge = process.argv.includes('--no-judge');
    const repeats = Number(arg('repeats', '3'));
    const ss = Number(arg('supersample', '2'));
    const only = new Set(list(arg('views')));
    const lightArg = arg('light', 'headlight')!;
    if (!['headlight', 'lit', 'both'].includes(lightArg)) throw new Error(`--light must be headlight, lit or both (got ${lightArg})`);
    const lights: Light[] = lightArg === 'both' ? ['headlight', 'lit'] : [lightArg as Light];
    const sunArg = list(arg('sun')).map(Number);
    const sun = sunArg.length === 2 && sunArg.every(Number.isFinite) ? { azimuthDeg: sunArg[0], elevationDeg: sunArg[1] }
        : camsJson.sun?.azimuthDeg !== undefined ? camsJson.sun : pm.defaultSunForLatitude(cams.frame.geoAnchor.lat);
    const litOptions: pm.LitOptions = { sunDir: pm.sunDirection(sun.azimuthDeg, sun.elevationDeg) };
    const grounded = process.argv.includes('--grounded');
    const groundedDir = path.resolve(arg('grounded-dir', path.join(outDir, 'grounded'))!);
    const baselinePath = arg('baseline');
    fs.mkdirSync(outDir, { recursive: true });

    const t0 = Date.now();
    const [ref] = load([reference]);
    const structureScan = arg('structure-scan', reference)!;
    const ground = buildGroundModel(loadScanMesh(structureScan), { cellMeters: 1 });
    const flags = rs.classifyStructure(ref, ground);
    const split = rs.splitStructure(ref, flags);
    console.log(`[replica] structure: ${split.structure.texture.length} of ${ref.texture.length} reference triangles (ground model of ${path.basename(structureScan)}, ${ground.terrainMethod})`);
    const procMeshes = load(procedural), procGround = load(proceduralGround);
    console.log(`[replica] loaded in ${Date.now() - t0} ms; light ${lights.join(' + ')}${lights.includes('lit') ? ` (sun azimuth ${sun.azimuthDeg}, elevation ${sun.elevationDeg})` : ''}${grounded ? '; grounded references' : ''}`);
    const groundAt = (x: number, z: number): number | undefined => {
        const i = Math.floor((x - ground.x0) / ground.cellMeters), k = Math.floor((z - ground.z0) / ground.cellMeters);
        const g = i >= 0 && k >= 0 && i < ground.nx && k < ground.nz ? ground.ground[k * ground.nx + i] : NaN;
        return g === g ? g : undefined;
    };

    const chain = noJudge ? undefined : await judgeClient();
    let mediaClient: Json;
    const getMediaClient = async () => {
        if (!mediaClient) {
            const { GoogleMediaCredentialsService } = await import('../packages/core/src/node/google-media-credentials-service');
            mediaClient = await new GoogleMediaCredentialsService().createVertexClient();
        }
        return mediaClient;
    };
    const limit = limiter(Number(arg('concurrency', '6')));
    const LABEL: Record<string, string> = { tiles: 'A PHOTO TILES (REFERENCE)', procedural: 'B PROCEDURAL', procedural_clay: 'C PROCEDURAL CLAY' };
    const views = cams.views.filter(v => !only.size || only.has(v.id));
    const report: Json = {
        schema: 'scratchbox.replica-scorecard/2', place: cams.place, createdAt: new Date().toISOString(), size: [cams.width, cams.height], supersample: ss,
        inputs: { reference, structureScan, procedural, proceduralGround, cameras: arg('cameras') ?? 'scripts/replica-scorecard/federation-square.cameras.json' },
        structureParams: rs.STRUCTURE_PARAMS, judged: !noJudge, repeats, light: lights,
        ...(lights.includes('lit') ? { lit: { sun, sunDir: litOptions.sunDir, params: pm.PHOTO_MATCH_LIT } } : {}),
        views: [] as Json[]
    };
    const save = () => fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
    const pending: Array<Promise<void>> = [];
    const sheets: Array<{ image: Json; label: string; sublabel?: string }> = [];
    for (const v of views) {
        const camera = rs.replicaCamera(v, cams.width, cams.height);
        const mask = rs.structureMask(split, camera);
        const maskPixels = mask.reduce((s, x) => s + x, 0);
        const entry: Json = { id: v.id, kind: v.kind, label: v.label, maskShare: Math.round((maskPixels / mask.length) * 1e4) / 1e4 };
        report.views.push(entry);
        const blocks: Partial<Record<Light, { block: Json; renders: Record<string, pm.ArmRender>; pngs: Record<string, Buffer> }>> = {};
        for (const light of lights) {
            const lit = light === 'lit' ? litOptions : undefined;
            const suffix = light === 'lit' ? '_lit' : '';
            const rRef = pm.renderTriangles([ref], camera, { supersample: ss, lit });
            const rProc = pm.renderTriangles([...procMeshes, ...procGround], camera, { supersample: ss, lit });
            const rClay = pm.renderTriangles(procMeshes, camera, { supersample: ss, clay: true, context: procGround, lit });
            const renders: Record<string, pm.ArmRender> = { tiles: rRef, procedural: rProc, procedural_clay: rClay };
            const pngs: Record<string, Buffer> = {};
            for (const [id, r] of Object.entries(renders)) { pngs[id] = pm.renderPng(r); fs.writeFileSync(path.join(outDir, `${v.id}_${id}${suffix}.png`), pngs[id]); }
            const perceptual: Json = {};
            for (const id of ARMS) perceptual[id] = maskPixels >= 200 ? pm.perceptualScores(rs.asImage(rRef), renders[id], mask) : null;
            const block: Json = light === 'lit' ? (entry.lit = {}) : entry;
            block.perceptual = perceptual;
            block.renderMs = { tiles: rRef.ms, procedural: rProc.ms, procedural_clay: rClay.ms };
            blocks[light] = { block, renders, pngs };
            console.log(`[replica] ${v.id} ${light}: mask ${(entry.maskShare * 100).toFixed(1)}%; ${ARMS.map(a => `${a} ssim ${perceptual[a]?.ssim} edge ${perceptual[a]?.edgeChamferPx} dE ${perceptual[a]?.colourDeltaE} cov ${perceptual[a]?.coverage}`).join(' | ')}; render ${rRef.ms + rProc.ms + rClay.ms} ms`);
        }
        const groundedRefs: Json[] = [];
        const writeSheet = () => {
            const tiles: Array<{ image: Json; label: string; sublabel?: string }> = [];
            for (const light of lights) {
                const { block, renders } = blocks[light]!;
                const tag = light === 'lit' ? ' LIT' : '';
                const head = (id: string, short: string) => { const p = block.perceptual[id]; return p ? `${short}${tag} SSIM ${p.ssim ?? '-'} DE ${p.colourDeltaE == null ? '-' : Math.round(p.colourDeltaE)}` : `${short}${tag}`; };
                const sub = (id: string) => {
                    const j = block.replica?.stats?.[id], b = block.believability?.[id], g = entry.grounded?.light === light ? entry.grounded.replica?.stats?.[id] : undefined;
                    return [j ? `REPLICA ${f1(j.overall)}` : '', b ? `BELIEVE ${f1(b.stat)}` : '', g ? `GR ${f1(g.overall)} REAL ${f1(g.realism)} ID ${f1(g.identity)}` : ''].filter(Boolean).join('  ') || 'NOT JUDGED';
                };
                tiles.push(
                    { image: renders.tiles, label: `${LABEL.tiles}${tag}`.slice(0, 35), sublabel: [block.believability?.tiles ? `BELIEVE ${f1(block.believability.tiles.stat)}` : 'REFERENCE', entry.grounded?.light === light && entry.grounded.replica?.stats?.tiles ? `GR REAL ${f1(entry.grounded.replica.stats.tiles.realism)} ID ${f1(entry.grounded.replica.stats.tiles.identity)}` : ''].filter(Boolean).join('  ') },
                    { image: renders.procedural, label: head('procedural', 'B PROC'), sublabel: sub('procedural') },
                    { image: renders.procedural_clay, label: head('procedural_clay', 'C CLAY'), sublabel: sub('procedural_clay') }
                );
                if (light === lights[0]) tiles.push({ image: rs.maskOverlay(renders.tiles, mask), label: 'STRUCTURE MASK', sublabel: `${(entry.maskShare * 100).toFixed(1)}% OF VIEW` });
                else tiles.push({ image: groundedRefs[0]?.image ?? rs.maskOverlay(renders.tiles, mask), label: groundedRefs[0] ? `G1 ${groundedRefs[0].model}`.slice(0, 35).toUpperCase() : 'STRUCTURE MASK', sublabel: groundedRefs[0] ? 'GENERATED, SEARCH-GROUNDED' : '' });
            }
            if (lights.length === 1) groundedRefs.slice(0, 2).forEach((g, k) => tiles.push({ image: g.image, label: `G${k + 1} ${g.model}`.slice(0, 35).toUpperCase(), sublabel: 'GENERATED, SEARCH-GROUNDED' }));
            else if (groundedRefs[1]) tiles.push({ image: groundedRefs[1].image, label: `G2 ${groundedRefs[1].model}`.slice(0, 35).toUpperCase(), sublabel: 'GENERATED, SEARCH-GROUNDED' });
            fs.writeFileSync(path.join(outDir, `${v.id}.png`), pm.composeGrid(tiles, { tileWidth: 640, columns: lights.length === 2 ? 4 : 2, title: `${v.id} - ${v.label}`.slice(0, 70) }));
        };
        writeSheet();
        if (chain) {
            for (const light of lights) {
                const { block, pngs } = blocks[light]!;
                const lit = light === 'lit';
                pending.push((async () => {
                    const [replicaRuns, ...bel] = await Promise.all([
                        limit(() => rs.judgeReplicaView({ client: chain, place: cams.place, reference: pngs.tiles, renders: ARMS.map(a => ({ armId: a, png: pngs[a] })), repeats, seed: `replica:${v.id}`, lit })),
                        ...(['tiles', ...ARMS] as string[]).map(id => limit(() => rs.judgeBelievability({ client: chain, png: pngs[id], repeats, lit })))
                    ]);
                    block.replica = { runs: replicaRuns, stats: rs.aggregateReplicaRuns(replicaRuns, [...ARMS]) };
                    block.believability = Object.fromEntries((['tiles', ...ARMS] as string[]).map((id, k) => [id, { runs: bel[k], stat: rs.stat(bel[k].map(x => x.believability)) }]));
                    writeSheet();
                    console.log(`[replica] ${v.id} ${light} judged: ${ARMS.map(a => `${a} replica ${f1(block.replica.stats[a].overall)} believe ${f1(block.believability[a].stat)}`).join(' | ')} | tiles believe ${f1(block.believability.tiles.stat)}`);
                    save();
                })().catch(err => { block.judgeError = String(err?.message ?? err); console.error(`[replica] ${v.id} ${light}: judge failed: ${block.judgeError}`); }));
            }
        }
        if (grounded) {
            const light: Light = lights.includes('lit') ? 'lit' : 'headlight';
            const { pngs } = blocks[light]!;
            pending.push((async () => {
                const refs = await groundedFor(groundedDir, cams.place, v, groundAt(v.eye[0], v.eye[2]), getMediaClient);
                for (const r of refs) {
                    const bytes = fs.readFileSync(r.file);
                    groundedRefs.push({ ...r, bytes, image: decodeImageInMemory(new Uint8Array(bytes)) });
                }
                entry.grounded = { light, references: refs.map(r => ({ file: path.relative(outDir, r.file), model: r.model, queries: r.queries, sources: r.sources, account: r.account })), provenance: { label: 'generated', basis: 'search-grounded reference' } };
                writeSheet();
                if (!chain) return;
                // the tiles render is judged as an arm here: against the real place's look, the rebuild may beat the scan
                const armIds = ['tiles', ...ARMS];
                const runs = await limit(() => rs.judgeReplicaView({
                    client: chain, place: cams.place, reference: pngs.tiles, renders: armIds.map(a => ({ armId: a, png: pngs[a] })), repeats, seed: `grounded:${v.id}`,
                    lit: light === 'lit', grounded: groundedRefs.map(g => ({ bytes: new Uint8Array(g.bytes), mimeType: g.mimeType }))
                }));
                entry.grounded.replica = { runs, stats: rs.aggregateReplicaRuns(runs, armIds) };
                writeSheet();
                console.log(`[replica] ${v.id} grounded judged: ${armIds.map(a => `${a} overall ${f1(entry.grounded.replica.stats[a].overall)} realism ${f1(entry.grounded.replica.stats[a].realism)} identity ${f1(entry.grounded.replica.stats[a].identity)}`).join(' | ')}`);
                save();
            })().catch(err => { entry.groundedError = String(err?.message ?? err); console.error(`[replica] ${v.id}: grounded failed: ${entry.groundedError}`); }));
        }
        const first = blocks[lights[0]]!.renders;
        sheets.push({ image: first.tiles, label: `${v.id} A TILES` }, { image: first.procedural, label: `${v.id} B PROC` }, { image: first.procedural_clay, label: `${v.id} C CLAY` });
        if (lights.length === 2) { const l = blocks.lit!.renders; sheets.push({ image: l.tiles, label: `${v.id} A LIT` }, { image: l.procedural, label: `${v.id} B LIT` }, { image: l.procedural_clay, label: `${v.id} C LIT` }); }
        save();
    }
    await Promise.all(pending);
    // summary: every arm's means over the views, per light
    if (lights.includes('headlight')) report.summary = summarise(report.views, x => x, ARMS);
    if (lights.includes('lit')) report.summaryLit = summarise(report.views, x => x.lit, ARMS);
    if (grounded) {
        const armIds = ['tiles', ...ARMS];
        report.summaryGrounded = Object.fromEntries(armIds.map(a => [a, Object.fromEntries(rs.REPLICA_GROUNDED_CRITERIA.map(c => [c, rs.stat((report.views as Json[]).flatMap(x => (x.grounded?.replica?.runs ?? []).map((r: Json) => r.scores[a]?.[c])).filter((n: unknown): n is number => typeof n === 'number'))]))]));
    }
    // every defect the judge named for the procedural arms, most severe first
    report.defects = (report.views as Json[]).flatMap(x => lights.flatMap(light => {
        const b = light === 'lit' ? x.lit : x;
        return [
            ...(b?.replica?.runs ?? []).flatMap((r: Json) => ARMS.flatMap(a => (r.scores[a]?.defects ?? []).map((d: Json) => ({ view: x.id, light, arm: a, judge: 'replica', ...d })))),
            ...ARMS.flatMap(a => (b?.believability?.[a]?.runs ?? []).flatMap((r: Json) => r.defects.map((d: Json) => ({ view: x.id, light, arm: a, judge: 'believability', ...d }))))
        ];
    })).sort((a: Json, b: Json) => b.severity - a.severity);
    if (baselinePath) {
        const base = JSON.parse(fs.readFileSync(path.resolve(baselinePath), 'utf8'));
        report.deltas = { baseline: path.resolve(baselinePath) } as Json;
        if (lights.includes('headlight')) report.deltas.headlight = rs.compareJudgedBlocks(base.views, report.views);
        if (lights.includes('lit') && base.views.some((x: Json) => x.lit)) report.deltas.lit = rs.compareJudgedBlocks(base.views.map((x: Json) => ({ id: x.id, ...x.lit })), report.views.map((x: Json) => ({ id: x.id, ...x.lit })));
        for (const d of (report.deltas.headlight ?? []).filter((x: Json) => x.criterion === 'overall' || x.criterion === 'believability')) {
            console.log(`[replica] delta ${d.view} ${d.arm} ${d.criterion}: ${d.d.baseline.mean} -> ${d.d.current.mean} (${d.d.delta >= 0 ? '+' : ''}${d.d.delta} +- ${d.d.se}${d.d.clear ? ', clear' : ', within noise'})`);
        }
    }
    if (chain) report.judgeModel = { requested: chain.requested, answered: chain.answeredModel, skipped: chain.skipped };
    save();
    fs.writeFileSync(path.join(outDir, 'summary.png'), pm.composeGrid(sheets, { tileWidth: 420, columns: 3, title: `${cams.place} - replica scorecard` }));
    for (const [k, summary] of [['headlight', report.summary], ['lit', report.summaryLit]] as const) {
        if (summary) console.log(`[replica] summary ${k} ${JSON.stringify(Object.fromEntries(Object.entries(summary).map(([a, s]: [string, Json]) => [a, { believe: s.believability.mean, replica: s.replica?.overall.mean, ssim: s.ssim?.mean, dE: s.colourDeltaE?.mean }])))}`);
    }
    if (report.summaryGrounded) console.log(`[replica] summary grounded ${JSON.stringify(Object.fromEntries(Object.entries(report.summaryGrounded).map(([a, s]: [string, Json]) => [a, { overall: s.overall.mean, realism: s.realism.mean, identity: s.identity.mean }])))}`);
    console.log(`[replica] wrote ${outDir} in ${Math.round((Date.now() - t0) / 1000)} s`);
}

main().then(() => process.exit(0), err => { console.error('[replica] FAILED', err); process.exit(1); });
