/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The set-fit regressor's data and fit (pipeline-k/material-set-fit.ts), from the finished textured buildings.
 *
 *   npx vite-node scripts/material_set_fit.ts find   --roots <dir>[,<dir>...] --out <runs.json>
 *   npx vite-node scripts/material_set_fit.ts dataset --runs <runs.json> --out <rows.jsonl>     (resumable: a run done is skipped)
 *   npx vite-node scripts/material_set_fit.ts train  --rows <rows.jsonl> [--runs <runs.json>] [--write]   (scores leave-one-building-out by
 *                                                    the runs file's buildings; --write saves the model)
 *
 * find: every run note pipeline_k_materials.json under the roots whose classes were shown candidates by the pick by
 * appearance, paired with the finished twin its pipeline_k_model.json names, when that file is still on disk.
 * dataset: per such run, the twin's facade photos decoded; each class's texture energy as they show it and its repeat
 * size measured (material-regions.ts classPhotoTextures, classRepeatSizes); per candidate, the library's measured
 * statistics and its texture energy at the class's texel; one row per class and candidate, labelled by the pick.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseGlbBytes } from '../packages/core/src/node/3d-engine/staged-location/glb-bytes';
import { decodeImageInMemory, type RgbaImage8 } from '../packages/core/src/node/3d-engine/staged-location/tile-texture-transfer';
import { classPhotoTextures, classRepeatSizes, type RegionClass } from '../packages/core/src/node/3d-engine/staged-location/pipeline-k/material-regions';
import { libraryTextureEnergy } from '../packages/core/src/node/3d-engine/staged-location/pipeline-k/material-harvest';
import { libraryColourPreview, loadTextureLibraryIndex } from '../packages/core/src/node/3d-engine/texture-library';
import { fitSetFit, SET_FIT_FEATURES, SET_FIT_MODEL_FILE, SET_FIT_VERSION, setFitFeatures, type SetFitModel } from '../packages/core/src/node/3d-engine/staged-location/pipeline-k/material-set-fit';

const REPO = path.resolve(__dirname, '..');
/** Places this close (degrees, about 400 m) are one building when buildings are held out. */
const PLACE_JOIN_DEG = 0.004;
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };

interface Row { run: string; building: string; cls: number; candidate: string; x: number[]; y: number; w: number; picked: boolean }

function findRuns(roots: string[]): Array<{ note: string; twin: string; building: string }> {
    const out: Array<{ note: string; twin: string; building: string }> = [];
    const walk = (dir: string, depth: number) => {
        if (depth > 9) return;
        let ents: fs.Dirent[] = [];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
            if (e.isDirectory() && !['node_modules', '.git', 'public', 'tiles_cache'].includes(e.name)) walk(path.join(dir, e.name), depth + 1);
            else if (e.name === 'pipeline_k_materials.json') {
                const note = path.join(dir, e.name);
                try {
                    const d = JSON.parse(fs.readFileSync(note, 'utf8'));
                    if (!d.classes?.some((c: any) => c.choice?.candidates?.length)) continue;
                    const model = JSON.parse(fs.readFileSync(path.join(dir, 'pipeline_k_model.json'), 'utf8'));
                    // a run kept by the benchmark (<out>/<side>/<place>/run) names its checkout in the result beside it
                    let checkout: string | undefined;
                    try { checkout = JSON.parse(fs.readFileSync(path.join(dir, '..', 'result.json'), 'utf8')).checkout; } catch { /* not a benchmark run */ }
                    const root = checkout ?? (note.includes('/.scratchbox/') ? note.split('/.scratchbox/')[0] : path.dirname(path.dirname(dir)));
                    const glbs = [...JSON.stringify(model).matchAll(/"(\/[^"]+\.glb)"/g)].map(m => m[1]);
                    const twin = glbs.flatMap(g => [g, path.join(root, 'public', g)]).find(f => fs.existsSync(f));
                    if (!twin) continue;
                    // the building: its place's coordinates (stages.json), rounded to about 150 m, so one building asked for by
                    // different names is one group when buildings are held out
                    const st = fs.existsSync(path.join(dir, 'stages.json')) ? fs.readFileSync(path.join(dir, 'stages.json'), 'utf8') : '';
                    const lat = /"lat"\s*:\s*(-?[\d.]+)/.exec(st)?.[1], lng = /"lng"\s*:\s*(-?[\d.]+)/.exec(st)?.[1];
                    const building = lat && lng ? `${(Math.round(Number(lat) * 750) / 750).toFixed(4)},${(Math.round(Number(lng) * 750) / 750).toFixed(4)}` : path.basename(twin);
                    out.push({ note, twin, building });
                } catch { /* no model note or twin */ }
            }
        }
    };
    for (const r of roots) walk(r, 0);
    return out;
}

/** The twin's photos by image index (the rebuilt facades' only: what the classes are measured on). */
function facadePhotos(g: ReturnType<typeof parseGlbBytes>, json: any): Map<number, RgbaImage8> {
    const images = new Map<number, RgbaImage8>();
    for (const mesh of json.meshes ?? []) {
        if (!/^facade_lattice_\d+$/.test(mesh.name ?? '')) continue;
        for (const p of mesh.primitives ?? []) {
            const t = json.materials?.[p.material]?.pbrMetallicRoughness?.baseColorTexture, src = t ? json.textures?.[t.index]?.source : undefined;
            if (src === undefined || images.has(src)) continue;
            const v = json.bufferViews[json.images[src].bufferView];
            images.set(src, decodeImageInMemory(g.bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)));
        }
    }
    return images;
}

async function dataset(runsFile: string, outFile: string): Promise<void> {
    const runs = JSON.parse(fs.readFileSync(runsFile, 'utf8')) as Array<{ note: string; twin: string; building: string }>;
    const done = new Set<string>();
    if (fs.existsSync(outFile)) for (const l of fs.readFileSync(outFile, 'utf8').split('\n')) if (l) done.add((JSON.parse(l) as Row).run);
    const index = loadTextureLibraryIndex(REPO);
    if (!index) throw new Error('no texture library index');
    const byId = new Map(index.sets.map(e => [e.id, e]));
    for (const [i, r] of runs.entries()) {
        if (done.has(r.note)) continue;
        const t0 = Date.now();
        const d = JSON.parse(fs.readFileSync(r.note, 'utf8'));
        const g = parseGlbBytes(fs.readFileSync(r.twin)), json: any = g.json;
        const images = facadePhotos(g, json);
        const classes: RegionClass[] = d.classes.map((c: any) => ({ index: c.index, meanLab: c.meanLab, meanLinear: [0, 0, 0], spreadLab: [0, 0, 0], share: c.share, wall: !!c.wall, openings: !!c.openings }));
        classPhotoTextures(g, json, images, classes);
        classRepeatSizes(g, json, images, classes);
        const rows: Row[] = [];
        for (const [k, c] of d.classes.entries()) {
            const ch = c.choice;
            if (!ch?.candidates?.length) continue;
            const picked = ch.by === 'appearance' ? ch.candidates.indexOf(c.set) : -1, conf = typeof ch.conf === 'number' ? ch.conf / 100 : 0.7;
            const read = c.finish?.read && c.finish.read.conf >= 50 ? { roughness: c.finish.read.roughness, metalness: c.finish.read.metalness } : undefined;
            const fc = { meanLab: c.meanLab as [number, number, number], openings: !!c.openings, ...(classes[k].photoTexture ? { photoEnergy: classes[k].photoTexture!.energy } : {}), ...(classes[k].repeatM ? { repeatM: classes[k].repeatM } : {}), ...(read ? { read } : {}) };
            for (const [rank, id] of (ch.candidates as string[]).entries()) {
                const e = byId.get(id);
                if (!e) continue;
                let energy: number[] | undefined;
                if (e.realSizeM && classes[k].photoTexture) {
                    const bytes = await libraryColourPreview(e, REPO).catch(() => undefined);
                    if (bytes) energy = libraryTextureEnergy(decodeImageInMemory(bytes), e.realSizeM, classes[k].photoTexture!.texelM).energy;
                }
                const x = setFitFeatures(fc, { rank, ...(e.colour?.meanLab ? { colourLab: e.colour.meanLab as [number, number, number] } : {}), ...(e.roughnessMean !== undefined ? { roughness: e.roughnessMean } : {}), ...(e.metallic !== undefined ? { metallic: e.metallic } : {}), ...(e.normalTiltRmsDeg !== undefined ? { normalTiltDeg: e.normalTiltRmsDeg } : {}), ...(e.realSizeM ? { tileM: e.realSizeM } : {}), ...(energy ? { energy } : {}) });
                rows.push({ run: r.note, building: r.building, cls: k, candidate: id, x, y: rank === picked ? conf : 0, w: 1, picked: rank === picked });
            }
        }
        fs.appendFileSync(outFile, rows.map(x => JSON.stringify(x)).join('\n') + (rows.length ? '\n' : ''));
        if (!rows.length) fs.appendFileSync(outFile, JSON.stringify({ run: r.note, building: r.building, cls: -1, candidate: '', x: [], y: 0, w: 0, picked: false }) + '\n');
        console.log(`${i + 1}/${runs.length} ${r.building}: ${rows.length} rows, ${Math.round((Date.now() - t0) / 1000)} s`);
    }
}

/** Per class, the candidate the model ranks first is the pick (top1); the ranking's first is the baseline (rankTop1); and the AUC of picked against not. */
function score(rows: Row[], p: (r: Row) => number): { top1: number; rankTop1: number; auc: number; classes: number } {
    const byClass = new Map<string, Row[]>();
    for (const r of rows) { const k = `${r.run}#${r.cls}`; (byClass.get(k) ?? byClass.set(k, []).get(k)!).push(r); }
    let top = 0, rankTop = 0, n = 0;
    for (const rs of byClass.values()) {
        if (!rs.some(r => r.picked)) continue;
        n++;
        const best = rs.reduce((a, b) => (p(b) > p(a) ? b : a));
        if (best.picked) top++;
        if (rs[0].picked) rankTop++;
    }
    const pos = rows.filter(r => r.picked).map(p), neg = rows.filter(r => !r.picked).map(p);
    let wins = 0;
    for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
    return { top1: n ? top / n : NaN, rankTop1: n ? rankTop / n : NaN, auc: pos.length && neg.length ? wins / (pos.length * neg.length) : NaN, classes: n };
}

function train(rowsFile: string, write: boolean, runsFile?: string): void {
    const all = fs.readFileSync(rowsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Row).filter(r => r.w > 0 && r.x.length === SET_FIT_FEATURES.length);
    // one decision per building and class: a building rebuilt many times repeats its classes' picks (same colour, same
    // candidates, same pick), which would weigh it by how often it was built
    const byClass = new Map<string, Row[]>();
    // the buildings as a runs file (find) names them now, when given
    if (runsFile) { const by = new Map((JSON.parse(fs.readFileSync(runsFile, 'utf8')) as Array<{ note: string; building: string }>).map(r => [r.note, r.building])); for (const r of all) r.building = by.get(r.run) ?? r.building; }
    // places within PLACE_JOIN_DEG of each other (single linkage) are one building: one asked for by different names or
    // corners resolves to points a few hundred metres apart
    const keys = [...new Set(all.map(r => r.building))], ll = keys.map(k => k.split(',').map(Number));
    const parent = keys.map((_, i) => i), find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
        const [a, b] = [ll[i], ll[j]];
        if (a.length === 2 && b.length === 2 && a.every(Number.isFinite) && b.every(Number.isFinite) && Math.hypot(a[0] - b[0], a[1] - b[1]) <= PLACE_JOIN_DEG) parent[find(i)] = find(j);
    }
    const group = new Map(keys.map((k, i) => [k, keys[find(i)]]));
    for (const r of all) r.building = group.get(r.building)!;
    for (const r of all) { const k = `${r.run}#${r.cls}`; (byClass.get(k) ?? byClass.set(k, []).get(k)!).push(r); }
    const seen = new Set<string>(), rows: Row[] = [];
    for (const rs of byClass.values()) {
        const key = `${rs[0].building}|${rs.map(r => `${r.candidate}${r.picked ? '*' : ''}`).join(',')}|${rs[0].x.slice(1, 4).map(v => v.toFixed(1)).join(',')}`;
        if (seen.has(key)) continue;
        seen.add(key); rows.push(...rs);
    }
    const buildings = [...new Set(rows.map(r => r.building))];
    console.log(`${rows.length} rows, ${rows.filter(r => r.picked).length} picks, ${buildings.length} buildings: ${buildings.join(', ')}`);
    // leave one building out: each building scored by a model fitted on the others
    const held: Row[] = [], heldP = new Map<Row, number>();
    for (const b of buildings) {
        const tr = rows.filter(r => r.building !== b), te = rows.filter(r => r.building === b);
        if (!tr.some(r => r.picked) || !te.length) continue;
        const fit = fitSetFit(tr);
        const m: SetFitModel = { version: SET_FIT_VERSION, features: [...SET_FIT_FEATURES], ...fit, trainedOn: { rows: tr.length, classes: 0, buildings: 0, atIso: '' }, pickedMedian: 1 };
        for (const r of te) { held.push(r); heldP.set(r, sigmoidOf(m, r.x)); }
        const s = score(te, r => heldP.get(r)!);
        console.log(`  held out ${b}: top-1 ${pct(s.top1)} (ranking ${pct(s.rankTop1)}), AUC ${s.auc.toFixed(3)}, ${s.classes} picked classes`);
    }
    const s = score(held, r => heldP.get(r)!);
    console.log(`leave-one-building-out: top-1 ${pct(s.top1)} against the ranking's ${pct(s.rankTop1)}, AUC ${s.auc.toFixed(3)} over ${s.classes} picked classes`);
    const fit = fitSetFit(rows);
    const model: SetFitModel = {
        version: SET_FIT_VERSION, features: [...SET_FIT_FEATURES], ...fit,
        trainedOn: { rows: rows.length, classes: new Set(rows.map(r => `${r.run}#${r.cls}`)).size, buildings: buildings.length, atIso: new Date().toISOString() },
        heldOut: { top1: round3(s.top1), rankTop1: round3(s.rankTop1), auc: round3(s.auc), buildings: buildings.length }, pickedMedian: 1
    };
    const picked = rows.filter(r => r.picked).map(r => sigmoidOf(model, r.x)).sort((a, b) => a - b);
    model.pickedMedian = round6(picked[picked.length >> 1] ?? 1);
    console.log('weights:', SET_FIT_FEATURES.map((f, i) => `${f} ${model.weights[i].toFixed(2)}`).join(', '));
    if (write) { fs.writeFileSync(path.join(REPO, SET_FIT_MODEL_FILE), JSON.stringify(model, null, 1) + '\n'); console.log(`wrote ${SET_FIT_MODEL_FILE}`); }
}

const sigmoidOf = (m: SetFitModel, x: number[]) => { let z = m.bias; for (let i = 0; i < x.length; i++) z += m.weights[i] * ((x[i] - m.mean[i]) / m.scale[i]); return 1 / (1 + Math.exp(-z)); };
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;
const round3 = (v: number) => Math.round(v * 1000) / 1000, round6 = (v: number) => Math.round(v * 1e6) / 1e6;

const cmd = process.argv[2];
(async () => {
    if (cmd === 'find') { const runs = findRuns(arg('roots')!.split(',')); fs.writeFileSync(arg('out')!, JSON.stringify(runs, null, 1)); console.log(`${runs.length} runs with a twin on disk`); }
    else if (cmd === 'dataset') await dataset(arg('runs')!, arg('out')!);
    else if (cmd === 'train') train(arg('rows')!, process.argv.includes('--write'), arg('runs'));
    else { console.error('usage: find | dataset | train (see the file comment)'); process.exit(2); }
})();
