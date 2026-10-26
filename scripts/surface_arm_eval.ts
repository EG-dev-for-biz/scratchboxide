/**
 * Per-surface arm selection (dev tool): for every surface of a manifest (scratchbox.surface-arms/1), renders each arm's
 * version of it in place inside the same scene, from every replica camera that sees it (the best `--max-views`), crops the
 * views to the surface, has a blind judge score realism, identity and errors against the tiles' crop and the surface's
 * search-grounded references, and keeps the base arm unless another passes the rule (surface-arm-selection.ts
 * decideSurfaceArm: realism up clearly, identity not down, errors not up). Writes a contact sheet per surface, and
 * selection.json with every verdict and its reason.
 *
 *   npx tsx --env-file=.env scripts/surface_arm_eval.ts --manifest <surface-arms.json> --reference <tiles textured.glb> \
 *     [--cameras scripts/replica-scorecard/federation-square.cameras.json] --out docs/screenshots/replica/<run>/surfaces \
 *     [--light lit|headlight] [--sun az,el] [--grounded] [--grounded-dir <dir>] [--repeats 3] [--max-views 2] [--no-judge]
 *
 * The base arm is the safety net (the tile photo transfer on rebuilt planes): every other arm must earn its place.
 * Lit (the default here) renders every arm under one sun with cast shadows and occlusion (photo-match-eval PHOTO_MATCH_LIT).
 * Real model calls are made unless --no-judge (tests never run this script).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as pm from '../packages/core/src/node/3d-engine/staged-location/photo-match-eval';
import * as rs from '../packages/core/src/node/3d-engine/staged-location/replica-scorecard';
import * as sa from '../packages/core/src/node/3d-engine/staged-location/surface-arm-selection';
import { encodePng } from '../packages/core/src/node/3d-engine/staged-location/png-encode';
import { decodeImageInMemory, readTileTriangles, type TileTriangles } from '../packages/core/src/node/3d-engine/staged-location/tile-texture-transfer';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function arg(name: string, fallback?: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const list = (s?: string) => (s ? s.split(',').map(x => x.trim()).filter(Boolean) : []);
const f1 = (s?: rs.Stat) => (s && s.n ? s.mean.toFixed(1) : '-');

async function main(): Promise<void> {
    const manifestPath = path.resolve(arg('manifest') ?? '');
    const manifest = sa.validateSurfaceArmManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    const rel = (p: string) => path.resolve(path.dirname(manifestPath), p);
    const camsJson = JSON.parse(fs.readFileSync(path.resolve(arg('cameras', path.join(__dirname, 'replica-scorecard/federation-square.cameras.json'))!), 'utf8'));
    const cams = rs.validateCameraSet(camsJson);
    const reference = arg('reference');
    if (!reference) throw new Error('--reference (the tiles textured.glb) is required');
    const outDir = path.resolve(arg('out', `docs/screenshots/replica/surfaces-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`)!);
    const lit = arg('light', 'lit') === 'lit';
    const sunArg = list(arg('sun')).map(Number);
    const sun = sunArg.length === 2 ? { azimuthDeg: sunArg[0], elevationDeg: sunArg[1] } : camsJson.sun?.azimuthDeg !== undefined ? camsJson.sun : pm.defaultSunForLatitude(cams.frame.geoAnchor.lat);
    const litOptions = lit ? { sunDir: pm.sunDirection(sun.azimuthDeg, sun.elevationDeg) } : undefined;
    const repeats = Number(arg('repeats', '3')), maxViews = Number(arg('max-views', '2')), ss = Number(arg('supersample', '2'));
    const noJudge = process.argv.includes('--no-judge'), grounded = process.argv.includes('--grounded');
    const groundedDir = path.resolve(arg('grounded-dir', path.join(outDir, 'grounded'))!);
    fs.mkdirSync(outDir, { recursive: true });

    const t0 = Date.now();
    const ref = readTileTriangles(new Uint8Array(fs.readFileSync(reference)));
    const context: TileTriangles[] = (manifest.context ?? []).map(g => readTileTriangles(new Uint8Array(fs.readFileSync(rel(g)))));
    const arms: Record<string, sa.NamedTriangles[]> = {};
    for (const [id, a] of Object.entries(manifest.arms)) {
        arms[id] = a.glbs.map(g => sa.readNamedTriangles(new Uint8Array(fs.readFileSync(rel(g)))));
        console.log(`[surfaces] arm ${id}: ${arms[id].reduce((s, l) => s + l.tris.texture.length, 0)} triangles`);
    }
    const armIds = Object.keys(arms);
    let chain: Json, media: Json;
    if (!noJudge) {
        const { GeminiClient, FALLBACK_GEMINI_MODELS } = await import('../packages/core/src/node/gemini/gemini-client');
        const { VisionModelChain } = await import('../packages/core/src/node/gemini/vision-model-chain');
        const client = await new GeminiClient().getGenAIClient();
        if (!client) throw new Error('no Gemini credentials are configured for the judge');
        chain = new VisionModelChain({ client, candidates: [...new Set(['gemini-4-argon', ...FALLBACK_GEMINI_MODELS])] } as Json);
    }
    console.log(`[surfaces] loaded in ${Date.now() - t0} ms; ${lit ? `lit (sun ${sun.azimuthDeg}/${sun.elevationDeg})` : 'headlight'}`);

    const result: Json = { schema: 'scratchbox.surface-arm-selection/1', place: manifest.place, manifest: manifestPath, base: manifest.base, light: lit ? { sun } : 'headlight', repeats, rule: sa.SURFACE_SELECTION_RULE, surfaces: [] as Json[] };
    const save = () => fs.writeFileSync(path.join(outDir, 'selection.json'), JSON.stringify(result, null, 1));
    for (const s of manifest.surfaces) {
        // per arm: the surface, and (for the base arm) the scene around it
        const parts: Record<string, TileTriangles[]> = {};
        const counts: Record<string, number> = {};
        let baseRest: TileTriangles[] = [];
        for (const id of armIds) {
            const splits = arms[id].map(l => sa.splitSurface(l, s));
            parts[id] = splits.map(x => x.surface);
            counts[id] = splits.reduce((n, x) => n + x.count, 0);
            if (id === manifest.base) baseRest = splits.map(x => x.rest);
        }
        const entry: Json = { id: s.id, subject: s.subject, triangles: counts, views: [] as Json[] };
        result.surfaces.push(entry);
        const missing = armIds.filter(id => !counts[id]);
        if (missing.length) console.log(`[surfaces] ${s.id}: no triangles in ${missing.join(', ')} (judged without them)`);
        const present = armIds.filter(id => counts[id]);
        // the views that see it best
        const candidates: Json[] = [];
        for (const v of cams.views.filter(v => !s.views?.length || s.views.includes(v.id))) {
            const camera = rs.replicaCamera(v, cams.width, cams.height);
            const renders: Record<string, pm.ArmRender> = {};
            for (const id of present) renders[id] = pm.renderTriangles(parts[id], camera, { supersample: ss, context: [...baseRest, ...context], lit: litOptions });
            const crop = sa.surfaceCrop(Object.values(renders));
            if (crop) candidates.push({ v, camera, renders, crop });
        }
        candidates.sort((a, b) => b.crop.pixels - a.crop.pixels);
        const chosenViews = candidates.slice(0, maxViews);
        if (!chosenViews.length) { entry.decision = { chosen: manifest.base, reason: 'no camera view sees the surface; kept the base arm' }; console.log(`[surfaces] ${s.id}: no view sees it`); save(); continue; }
        // grounded references of the surface (generated; cached)
        let refs: Array<{ bytes: Uint8Array; mimeType: string; model: string; file: string }> = [];
        if (grounded && s.subject) {
            const dir = path.join(groundedDir, s.id), meta = path.join(dir, 'references.json');
            if (!fs.existsSync(meta)) {
                if (!media) { const { GoogleMediaCredentialsService } = await import('../packages/core/src/node/google-media-credentials-service'); media = await new GoogleMediaCredentialsService().createVertexClient(); }
                const { fetchGroundedReferences } = await import('../packages/core/src/node/spatial/search-grounded-reference');
                const request = { place: manifest.place, subject: s.subject, view: rs.groundedViewPhrase(chosenViews[0].v), aspectRatio: '4:3' };
                const res = await fetchGroundedReferences(media, request);
                fs.mkdirSync(dir, { recursive: true });
                const files = res.references.map((r, k) => { const f = `${k}_${r.model}.${r.image!.mimeType.includes('jpeg') ? 'jpg' : 'png'}`; fs.writeFileSync(path.join(dir, f), r.image!.data); return { file: f, model: r.model, mimeType: r.image!.mimeType, account: r.account, queries: r.queries, sources: r.sources }; });
                fs.writeFileSync(meta, JSON.stringify({ request, prompt: res.prompt, provenance: res.provenance, skipped: res.skipped, references: files }, null, 1));
            }
            refs = JSON.parse(fs.readFileSync(meta, 'utf8')).references.map((r: Json) => ({ ...r, file: path.join(dir, r.file), bytes: new Uint8Array(fs.readFileSync(path.join(dir, r.file))) }));
            entry.grounded = refs.map(r => ({ file: path.relative(outDir, r.file), model: r.model }));
        }
        const runs: sa.SurfaceJudgeRun[] = [];
        const sheet: Array<{ image: Json; label: string; sublabel?: string; arm?: string }> = [];
        for (const c of chosenViews) {
            const refRender = pm.renderTriangles([ref], c.camera, { supersample: ss, lit: litOptions });
            const refCrop = sa.cropImage(refRender, c.crop.box, 512);
            const crops: Record<string, Json> = {};
            for (const id of present) crops[id] = sa.cropImage(c.renders[id], c.crop.box, 512);
            const png = (img: Json) => encodePng(img.width, img.height, img.rgba, 4);
            const stem = path.join(outDir, `${s.id}_${c.v.id}`);
            fs.writeFileSync(`${stem}_tiles.png`, png(refCrop));
            for (const id of present) fs.writeFileSync(`${stem}_${id}.png`, png(crops[id]));
            entry.views.push({ view: c.v.id, pixels: c.crop.pixels, box: c.crop.box });
            sheet.push({ image: refCrop, label: `${c.v.id} TILES`.slice(0, 30).toUpperCase(), sublabel: 'REFERENCE' }, ...present.map(id => ({ image: crops[id], arm: id, label: `${c.v.id} ${id}`.slice(0, 30).toUpperCase(), sublabel: id === manifest.base ? 'BASE' : '' })));
            if (chain) {
                runs.push(...await sa.judgeSurfaceView({
                    client: chain, place: manifest.place, view: c.v.id, reference: png(refCrop), lit, repeats, seed: `surface:${s.id}:${c.v.id}`,
                    renders: present.map(id => ({ armId: id, png: png(crops[id]) })), grounded: refs.map(r => ({ bytes: r.bytes, mimeType: r.mimeType }))
                }));
            }
        }
        if (chain) {
            const stats = sa.aggregateSurfaceRuns(runs, present);
            entry.runs = runs; entry.stats = stats;
            entry.decision = sa.decideSurfaceArm(stats, manifest.base);
            for (const t of sheet) {
                const id = t.arm;
                if (id) t.sublabel = `${id === manifest.base ? 'BASE ' : ''}REAL ${f1(stats[id].realism)} ID ${f1(stats[id].identity)} ERR ${f1(stats[id].errors)}${entry.decision.chosen === id ? ' CHOSEN' : ''}`;
            }
            console.log(`[surfaces] ${s.id}: ${present.map(a => `${a} realism ${f1(stats[a].realism)}+-${stats[a].realism.sd} identity ${f1(stats[a].identity)} errors ${f1(stats[a].errors)}`).join(' | ')} -> ${entry.decision.chosen} (${entry.decision.reason})`);
        }
        for (const r of refs.slice(0, 2)) sheet.push({ image: decodeImageInMemory(r.bytes), label: `G ${r.model}`.slice(0, 30).toUpperCase(), sublabel: 'GENERATED, SEARCH-GROUNDED' });
        fs.writeFileSync(path.join(outDir, `${s.id}.png`), pm.composeGrid(sheet, { tileWidth: 420, columns: present.length + 1, title: `${s.id} - per-surface arms${lit ? ' (lit)' : ''}`.slice(0, 70) }));
        save();
    }
    save();
    console.log(`[surfaces] wrote ${outDir} in ${Math.round((Date.now() - t0) / 1000)} s`);
}

main().then(() => process.exit(0), err => { console.error('[surfaces] FAILED', err); process.exit(1); });
