/**
 * Version F (experiment) dev driver: rebuilds one building procedurally from a pipeline E build's measured massing, the
 * tile used only as a reference (packages/core/src/node/3d-engine/staged-location/version-f/version-f.ts).
 *
 *   SCRATCHBOX_REPLAY_DIR=<rec> node -r ts-node/register -r ./scripts/dev/staged-replay.ts scripts/dev/version-f.ts \
 *       <pipelineEDir> "<place>" <outDir> [--runs <staged_location/runs dir>] [--reading <params.json>] [--rounds 3]
 *   (ts-node options as in staged-replay.ts)
 *
 * <pipelineEDir> is the E build's `.scratchbox/cache/staged_location/pipeline_e/<key>` (massing.json and native/spec.txt
 * give the massing, the photo tile and the isolated scan). With --runs, the Street View photos that build already used (its
 * ownership note's panos, answered from the replay recordings) are shown to the reader; no other pano is fetched.
 * Writes <outDir>/version_f.json and the layer GLBs (version_f_clay.glb, version_f_textured.glb).
 */
import * as fs from 'fs';
import * as path from 'path';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const core = (p: string) => require(path.join(__dirname, '../../packages/core/src', p));

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
}

/** The Street View photos the E build used: its ownership note's panos, read from the replay recordings. */
function streetViewPhotos(eKey: string, runsDir: string | undefined, recDir: string | undefined): Array<{ bytes: Uint8Array; caption: string }> {
    if (!runsDir || !recDir) return [];
    let note: Json;
    for (const r of fs.readdirSync(runsDir)) {
        try {
            const st = JSON.parse(fs.readFileSync(path.join(runsDir, r, 'stages.json'), 'utf8'));
            if (String(st.keys?.remesh ?? '').startsWith(eKey) && fs.existsSync(path.join(runsDir, r, 'pipeline_e_ownership.json'))) note = JSON.parse(fs.readFileSync(path.join(runsDir, r, 'pipeline_e_ownership.json'), 'utf8'));
        } catch { /* not a run */ }
    }
    const panos: string[] = [...new Set<string>((note?.records ?? []).filter((x: Json) => x.status === 'segmented' && (x.iou ?? 0) >= 0.5).map((x: Json) => x.panoId))];
    const g = path.join(recDir, 'grounding');
    const out: Array<{ bytes: Uint8Array; caption: string }> = [];
    for (const pano of panos) {
        const hits = fs.readdirSync(g).filter(f => f.endsWith('.json')).map(f => ({ f, j: JSON.parse(fs.readFileSync(path.join(g, f), 'utf8')) })).filter(x => x.j.panoId === pano && fs.existsSync(path.join(g, x.f.replace(/\.json$/, '.bin'))));
        hits.sort((a, b) => Math.abs(a.j.pitchDegree - 10) - Math.abs(b.j.pitchDegree - 10) || b.j.fovDegree - a.j.fovDegree);
        if (!hits.length) continue;
        const h = hits[0];
        out.push({ bytes: fs.readFileSync(path.join(g, h.f.replace(/\.json$/, '.bin'))), caption: `A Street View photo of the building from its street (camera heading ${Math.round(h.j.headingDegree)} deg, pitch ${Math.round(h.j.pitchDegree)} deg, field of view ${Math.round(h.j.fovDegree)} deg).` });
        if (out.length >= 2) break;
    }
    return out;
}

async function visionChain(): Promise<Json> {
    const { GeminiClient } = core('node/gemini/gemini-client');
    const { VisionModelChain } = core('node/gemini/vision-model-chain');
    const { STAGED_VISION_MODEL_DEFAULT } = core('common/spatial/staged-location-contracts');
    const gemini = new GeminiClient();
    const client = await gemini.getGenAIClient();
    if (!client) throw new Error('no Gemini credentials are configured');
    return new VisionModelChain({ client, candidates: [...new Set([STAGED_VISION_MODEL_DEFAULT.model, ...gemini.getModelCandidates()])] });
}

(async () => {
    const [eDir, place, outDir] = process.argv.slice(2);
    if (!eDir || !place || !outDir) throw new Error('usage: version-f.ts <pipelineEDir> "<place>" <outDir> [--runs dir] [--reading params.json] [--rounds n]');
    try {
        const sec = JSON.parse(fs.readFileSync(path.join(process.env.SCRATCHBOX_ROOT ?? process.cwd(), 'secrets.json'), 'utf8'));
        for (const k of ['GOOGLE_MAPS_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_AI_API_KEY', 'GOOGLE_CLOUD_API_KEY']) if (sec[k] && !process.env[k]) process.env[k] = sec[k];
    } catch { /* no secrets file: the chain says so */ }
    const massing = JSON.parse(fs.readFileSync(path.join(eDir, 'massing.json'), 'utf8'));
    const spec = fs.readFileSync(path.join(eDir, 'native', 'spec.txt'), 'utf8');
    const line = (k: string) => spec.split('\n').find(l => l.startsWith(`${k} `))?.slice(k.length + 1).trim();
    const tilePath = line('tile'), isolateGlb = line('isolate');
    if (!tilePath || !isolateGlb) throw new Error('the E build\'s spec names no tile or isolate');
    const { runVersionF } = core('node/3d-engine/staged-location/version-f/version-f');
    const readingFile = arg('--reading');
    const t0 = Date.now();
    const res = await runVersionF({
        place, massing, tilePath, isolateGlb, outDir,
        ...(readingFile ? { reading: JSON.parse(fs.readFileSync(readingFile, 'utf8')) } : { chain: await visionChain() }),
        streetViewPhotos: streetViewPhotos(path.basename(eDir), arg('--runs'), process.env.SCRATCHBOX_REPLAY_DIR),
        rounds: Number(arg('--rounds') ?? 3),
        onProgress: (m: string) => console.log('[f]', m)
    });
    fs.writeFileSync(path.join(outDir, 'version_f.json'), JSON.stringify({ place, eDir, ...res, wallClockMs: Date.now() - t0 }, null, 1));
    const s = (c: Json) => `sil ${c.summary.silhouetteIou.toFixed(3)} top ${c.summary.topIou.toFixed(3)} ncc ${c.summary.windowNcc.toFixed(3)} edge ${c.summary.edgeDistM.toFixed(3)} m depth ${c.summary.wallDepthMaeM.toFixed(3)} m`;
    console.log(`[f] ${place}: ${((Date.now() - t0) / 1000).toFixed(1)} s; before ${s(res.before)}; after ${s(res.after)}; nodes ${JSON.stringify(res.nodes.byLabel)} residual ${res.nodes.residual}`);
    console.log('[f] timings', JSON.stringify(res.timingsMs));
})().then(() => process.exit(0), e => { console.error('[f] FAILED', e); process.exit(1); });
