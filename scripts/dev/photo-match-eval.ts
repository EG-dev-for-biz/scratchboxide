/**
 * Photo-match evaluator (dev tool): renders each arm of a build from held-out Street View poses, has a vision model judge the
 * renders blind against the real photos, and writes a report and one labelled grid per view.
 * The maths lives in packages/core/src/node/3d-engine/staged-location/photo-match-eval.ts.
 *
 *   SCRATCHBOX_REPLAY_DIR=<rec> node -r ts-node/register -r ./scripts/dev/staged-replay.ts scripts/dev/photo-match-eval.ts <manifest.json>
 *   (ts-node options as in staged-replay.ts; --no-judge renders, scores and grids only)
 *
 * Manifest:
 * {
 *   "place": "Puck Building, 295 Lafayette St, New York",   // named to the judge
 *   "slug": "puck", "outDir": "...", "gridDir": "...", "repeats": 3, "maskArm": "A",
 *   "excludePanos": ["..."],                                  // panos any arm used: a view on one of them is refused
 *   "views": [{ "id": "...", "label": "far 85 m", "photo": "x.jpg", "camera": PinholeCamera }
 *          or { ..., "pose": { "panoId", "eye", "headingDeg", "pitchDeg", "fovDeg", "widthPx", "heightPx", "correction"? } }],
 *   "arms": [{ "id": "A", "label": "A raw tile", "glbs": ["a.glb"], "keepNear"?: "iso.glb" }],
 *   "occluder"?: "geometry.glb",                              // the full tile mesh: what stands in front hides every arm alike
 *   "context"?: { "glb": "textured.glb", "cut": "raw_clay.glb" | ["raw_clay.glb", "removed_trees.glb"] },  // in context: every arm drawn in the same street (below)
 *   "clay"?: true                                             // also every arm in uniform clay from the same pose, judged for shape only
 * }
 * With `clay`, each view also gets `<id>_<arm>_clay.png`, a clay grid `<slug>_<view>_clay.png` and `clayJudge` (shape only).
 * With `context`, every arm is rendered in its place: the photo-textured tile with the target's own triangles (those within
 * 1 cm of `cut`'s, the isolate tile_refine wrote) taken out, identical for every arm, drawn and depth-tested with the arm and lit
 * the same. Each arm replaces only the target, so the judge compares a street with a street. `occluder` is not used then (the
 * context hides what stands in front). The metrics' mask is still the target (the arm's own coverage).
 * `keepNear` keeps only the triangles of the arm's GLBs whose centroid lies within 1 cm of a triangle centroid of that GLB
 * (e.g. the photo-textured tile cut to the isolated scan tile_refine wrote). Every arm must be in the tile frame.
 */
import * as fs from 'fs';
import * as path from 'path';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const core = (p: string) => require(path.join(__dirname, '../../packages/core/src/node', p));
const pm = core('3d-engine/staged-location/photo-match-eval');
const { readTileTriangles } = core('3d-engine/staged-location/tile-texture-transfer');
const { castCamera } = core('3d-engine/staged-location/survey-casting');
const { decodeImageInMemory } = core('3d-engine/staged-location/tile-texture-transfer');
const { readGlbScene, sceneToRenderMesh, renderFrameDepth } = core('spatial/StreetViewPoseRegistrar');

function centroids(t: Json): Float32Array {
    const n = t.texture.length, c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[i * 3 + k] = (t.positions[i * 9 + k] + t.positions[i * 9 + 3 + k] + t.positions[i * 9 + 6 + k]) / 3;
    return c;
}

/** Triangles of `t` whose centroid is within `tol` of one of `ref`'s centroids (a 1 cm hash grid); `drop` keeps the others. */
function keepNear(t: Json, ref: Json, tol = 0.01, drop = false): Json {
    const grid = new Map<string, number[]>();
    const rc = centroids(ref), key = (x: number, y: number, z: number) => `${Math.floor(x / tol)},${Math.floor(y / tol)},${Math.floor(z / tol)}`;
    for (let i = 0; i < rc.length; i += 3) { const k = key(rc[i], rc[i + 1], rc[i + 2]); (grid.get(k) ?? grid.set(k, []).get(k)!).push(i); }
    const tc = centroids(t), keep: number[] = [];
    for (let i = 0; i < t.texture.length; i++) {
        const x = tc[i * 3], y = tc[i * 3 + 1], z = tc[i * 3 + 2];
        let hit = false;
        for (let dx = -1; dx <= 1 && !hit; dx++) for (let dy = -1; dy <= 1 && !hit; dy++) for (let dz = -1; dz <= 1 && !hit; dz++) {
            const g = grid.get(`${Math.floor(x / tol) + dx},${Math.floor(y / tol) + dy},${Math.floor(z / tol) + dz}`);
            if (g?.some(j => Math.hypot(rc[j] - x, rc[j + 1] - y, rc[j + 2] - z) <= tol)) hit = true;
        }
        if (hit !== drop) keep.push(i);
    }
    const pick = (a: Float32Array | Int32Array, w: number) => { const o = new (a.constructor as Json)(keep.length * w); keep.forEach((s, d) => o.set(a.subarray(s * w, s * w + w), d * w)); return o; };
    return { positions: pick(t.positions, 9), uvs: pick(t.uvs, 6), normals: pick(t.normals, 3), texture: pick(t.texture, 1), flatLinear: pick(t.flatLinear, 3), textures: t.textures };
}

async function judgeClient(): Promise<Json> {
    const { GeminiClient, FALLBACK_GEMINI_MODELS } = core('gemini/gemini-client');
    const { VisionModelChain } = core('gemini/vision-model-chain');
    const gemini = new GeminiClient();
    const client = await gemini.getGenAIClient();
    if (!client) throw new Error('no Gemini credentials are configured for the judge');
    // the strongest served model first, then the chat's fallbacks (a model not served moves on, and is recorded)
    return new VisionModelChain({ client, candidates: [...new Set(['gemini-4-argon', ...FALLBACK_GEMINI_MODELS])] });
}

async function main(): Promise<void> {
    const file = process.argv[2];
    const noJudge = process.argv.includes('--no-judge');
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    const outDir = m.outDir ?? path.join(path.dirname(file), m.slug);
    const gridDir = m.gridDir ?? outDir;
    fs.mkdirSync(outDir, { recursive: true }); fs.mkdirSync(gridDir, { recursive: true });
    const exclude = new Set<string>(m.excludePanos ?? []);
    // arms, loaded once
    const arms = m.arms.map((a: Json) => {
        let meshes = a.glbs.map((g: string) => readTileTriangles(fs.readFileSync(g)));
        if (a.keepNear) { const ref = readTileTriangles(fs.readFileSync(a.keepNear)); meshes = meshes.map((t: Json) => keepNear(t, ref)); }
        const tris = meshes.reduce((s: number, t: Json) => s + t.texture.length, 0);
        console.log(`[photo-match] arm ${a.id}: ${tris} triangles from ${a.glbs.length} GLBs${a.keepNear ? ' (kept near the isolate)' : ''}`);
        return { ...a, meshes, tris };
    });
    let context: Json[] | undefined;
    if (m.context) {
        const full = readTileTriangles(fs.readFileSync(m.context.glb));
        // `cut` may name several GLBs (the target's isolate, and e.g. the scanned trees an arm regrows): each is taken out
        let cut = full;
        for (const c of ([] as string[]).concat(m.context.cut)) cut = keepNear(cut, readTileTriangles(fs.readFileSync(c)), 0.01, true);
        context = [cut];
        console.log(`[photo-match] context: ${cut.texture.length} of ${full.texture.length} tile triangles (the target cut out)`);
    }
    const occluder = !context && m.occluder ? sceneToRenderMesh(readGlbScene(m.occluder)) : undefined;
    const chain = noJudge ? undefined : await judgeClient();
    const report: Json = { place: m.place, slug: m.slug, inContext: !!m.context, arms: arms.map((a: Json) => ({ id: a.id, label: a.label, glbs: a.glbs, triangles: a.tris })), views: [] };
    for (const v of m.views) {
        if (exclude.has(v.panoId ?? v.pose?.panoId)) throw new Error(`view ${v.id}: pano ${v.panoId ?? v.pose?.panoId} was used by an arm; it cannot be held out`);
        const bytes = fs.readFileSync(v.photo);
        const img = decodeImageInMemory(bytes);
        const photo = { width: img.width, height: img.height, rgba: img.rgba };
        const camera = v.camera ?? castCamera({ ...v.pose, widthPx: img.width, heightPx: img.height });
        if (camera.width !== img.width || camera.height !== img.height) throw new Error(`view ${v.id}: the camera is ${camera.width}x${camera.height}, the photo ${img.width}x${img.height}`);
        const occluderDepth = occluder ? renderFrameDepth(occluder, camera) : undefined;
        const renders = arms.map((a: Json) => ({ arm: a, r: pm.renderTriangles(a.meshes, camera, { ...(occluderDepth ? { occluderDepth } : {}), ...(context ? { context } : {}) }) }));
        const maskSrc = renders.find((x: Json) => x.arm.id === (m.maskArm ?? arms[0].id))!.r;
        const mask = pm.coverageMask(maskSrc);
        const perceptual: Json = {};
        for (const { arm, r } of renders) {
            perceptual[arm.id] = pm.perceptualScores(photo, r, mask);
            fs.writeFileSync(path.join(outDir, `${v.id}_${arm.id}.png`), pm.renderPng(r));
        }
        let judge: Json;
        if (chain) {
            const runs = await pm.judgeView({ client: chain, place: m.place, photo: { bytes, mimeType: 'image/jpeg' }, renders: renders.map((x: Json) => ({ armId: x.arm.id, png: pm.renderPng(x.r) })), repeats: m.repeats ?? 3, seed: `${m.slug}:${v.id}` });
            judge = { runs, stats: pm.aggregateRuns(runs, arms.map((a: Json) => a.id)) };
        }
        const tiles = [{ image: photo, label: `REAL PHOTO ${v.label ?? ''}`, sublabel: (v.panoId ?? v.pose?.panoId ?? '').slice(0, 10) }, ...renders.map(({ arm, r }: Json) => ({
            image: r, label: arm.label,
            sublabel: judge ? `JUDGE ${judge.stats[arm.id].overall.mean.toFixed(1)} +- ${judge.stats[arm.id].overall.sd.toFixed(1)}  SSIM ${perceptual[arm.id].ssim ?? '-'}` : `SSIM ${perceptual[arm.id].ssim ?? '-'} EDGE ${perceptual[arm.id].edgeChamferPx ?? '-'}`
        }))];
        let clayJudge: Json;
        let clayGrid: string | undefined;
        if (m.clay) {
            const clayRenders = arms.map((a: Json) => ({ arm: a, r: pm.renderTriangles(a.meshes, camera, { clay: true, ...(occluderDepth ? { occluderDepth } : {}), ...(context ? { context } : {}) }) }));
            for (const { arm, r } of clayRenders) fs.writeFileSync(path.join(outDir, `${v.id}_${arm.id}_clay.png`), pm.renderPng(r));
            if (chain) {
                const runs = await pm.judgeViewClay({ client: chain, place: m.place, photo: { bytes, mimeType: 'image/jpeg' }, renders: clayRenders.map((x: Json) => ({ armId: x.arm.id, png: pm.renderPng(x.r) })), repeats: m.repeats ?? 3, seed: `${m.slug}:${v.id}:clay` });
                const agg = pm.aggregateRuns(runs, arms.map((a: Json) => a.id));
                clayJudge = { runs, stats: Object.fromEntries(arms.map((a: Json) => [a.id, { shape: agg[a.id].shape }])) };
            }
            clayGrid = path.join(gridDir, `${m.slug}_${v.id}_clay.png`);
            fs.writeFileSync(clayGrid, pm.composeGrid([{ image: photo, label: `REAL PHOTO ${v.label ?? ''}`, sublabel: (v.panoId ?? v.pose?.panoId ?? '').slice(0, 10) }, ...clayRenders.map(({ arm, r }: Json) => ({
                image: r, label: `${arm.label} CLAY`, sublabel: clayJudge ? `SHAPE ${clayJudge.stats[arm.id].shape.mean.toFixed(1)} +- ${clayJudge.stats[arm.id].shape.sd.toFixed(1)}` : 'NOT JUDGED'
            }))], { tileWidth: 560, columns: Math.min(4, arms.length + 1), title: `${m.place} - ${v.label ?? v.id} - CLAY, SHAPE ONLY` }));
        }
        const grid = path.join(gridDir, `${m.slug}_${v.id}.png`);
        fs.writeFileSync(grid, pm.composeGrid(tiles, { tileWidth: 560, columns: Math.min(4, tiles.length), title: `${m.place} - ${v.label ?? v.id}${context ? ' - IN CONTEXT' : ''}` }));
        report.views.push({ id: v.id, label: v.label, panoId: v.panoId ?? v.pose?.panoId, size: [img.width, img.height], maskPixels: mask.reduce((s: number, x: number) => s + x, 0), perceptual, ...(judge ? { judge } : {}), ...(clayJudge ? { clayJudge } : {}), ...(clayGrid ? { clayGrid } : {}), grid, renderMs: Object.fromEntries(renders.map((x: Json) => [x.arm.id, x.r.ms])) });
        console.log(`[photo-match] ${m.slug} ${v.id}: ${arms.map((a: Json) => `${a.id} ${judge ? judge.stats[a.id].overall.mean : '-'}${clayJudge ? ` clay ${clayJudge.stats[a.id].shape.mean}` : ''} (ssim ${perceptual[a.id].ssim}, edge ${perceptual[a.id].edgeChamferPx}, dE ${perceptual[a.id].colourDeltaE}, cov ${perceptual[a.id].coverage})`).join(' | ')} -> ${grid}`);
        fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
    }
    if (chain) report.judgeModel = { requested: chain.requested, answered: chain.answeredModel, skipped: chain.skipped };
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
}

main().then(() => process.exit(0), err => { console.error('[photo-match] FAILED', err); process.exit(1); });
