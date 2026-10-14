/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Texture agent, apply step: bake harvested material detail into a textured scan (Stage 3 without registration).
 *
 *   npx vite-node scripts/bake_material_detail_stage3.ts \
 *     --base-glb <textured scan.glb> --library <materials/library.json> --out <stage3.glb> [--render]
 *
 * Steps: plane clusters of the base mesh -> continuous-field classification against the library (tile colour at the
 * source surface, tilt, height above terrain, proximity) -> optional multimodal disambiguation of ambiguous large
 * clusters on orthographic renders (Gemini, cached under <library dir>/ortho_cache; --no-gemini for cache only) ->
 * per-atlas bake (2x/4x upscale within --budget-mb, planar metric projection of the swatch detail, sharpness-preserving
 * composite, JPEG q90) -> plain glTF with unlit materials untouched.
 *
 * Writes <out>, <out dir>/<name>_work/bake_report.json (per-primitive sharpness change and coverage, cluster
 * assignments) and, with --render, path-traced albedo comparisons (base | baked | detail) at the frames of
 * --views (a pose_report.json or plates.json; default <library dir>/../plates/pose_report.json) plus novel views,
 * to test-results/screenshots/<prefix>_*.png (gitignored) with screen-space sharpness numbers.
 *
 * Flags: --max-scale 2|4, --budget-mb N, --quality Q, --no-gemini, --max-questions N, --classify-only,
 *        --render, --renderer <bin>, --render-size PX, --render-spp N, --views <json>, --prefix <name>, --max-views N,
 *        --zoom F (telephoto re-render factor through the most-changed window, default 4),
 *        --look x,y,z:tx,ty,tz:vfovDeg (extra explicit view, repeatable).
 * Each render strip is: base | baked | base telephoto | baked telephoto.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
    loadBaseScan, buildPlaneClusters, describeClusters, classifyClusters, disambiguateClusters, bakeMaterialDetail,
    geminiOrthoClassifier, LinearImageCache, type ClusterAssignment, type PlaneCluster
} from '../packages/core/src/node/spatial/MaterialDetailBaker';
import type { MaterialLibrary } from '../packages/core/src/node/spatial/StreetViewMaterialHarvester';
import { createGeminiContentClient, plateRecordCamera, frameCameraToPose, type StreetViewPlateRecord } from '../packages/core/src/node/spatial/StreetViewPoseRegistrar';
import { loadScanMesh, buildGroundModel } from '../packages/core/src/node/spatial/StreetViewSurveyPlanner';
import { luminance8, laplacianVariance } from '../packages/core/src/node/spatial/StreetViewStage3Metrics';
import { decodePng, encodePng } from '../packages/core/src/node/texture-processing';

const REPO = path.resolve(__dirname, '..');
const SECRET_ENV = ['GOOGLE_MAPS_API_KEY', 'MAP_TILES_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY', 'GOOGLE_AI_API_KEY', 'GOOGLE_CLOUD_API_KEY'];

function loadDotEnv() {
    const p = path.join(REPO, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (!m || process.env[m[1]]) continue;
        process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
}
function redactSecrets(text: string): string {
    let out = text;
    for (const k of SECRET_ENV) { const v = process.env[k]; if (v && v.length >= 8) out = out.split(v).join('<redacted>'); }
    return out;
}
const log = (msg: string) => console.log(redactSecrets(msg));

interface Args {
    baseGlb: string; library: string; out: string; maxScale: number; budgetMb: number; quality: number;
    gemini: boolean; maxQuestions: number; classifyOnly: boolean;
    render: boolean; renderer: string; renderSize: number; renderSpp: number; views?: string; prefix: string; maxViews: number;
    looks: ViewSpec[]; zoom: number;
}

function usage(): never {
    console.error('usage: npx vite-node scripts/bake_material_detail_stage3.ts --base-glb <scan.glb> --library <library.json> --out <out.glb> [--max-scale 2|4] [--budget-mb N] [--quality Q] [--no-gemini] [--max-questions N] [--classify-only] [--render] [--renderer <bin>] [--render-size PX] [--render-spp N] [--views <json>] [--prefix <name>] [--max-views N]');
    process.exit(2);
}

function parseArgs(argv: string[]): Args {
    const a: Partial<Args> = {
        maxScale: 4, budgetMb: 45, quality: 90, gemini: true, maxQuestions: 120, classifyOnly: false,
        render: false, renderer: path.join(REPO, 'build/omnispatial/render_pt'), renderSize: 512, renderSpp: 16, prefix: 'material_detail_stage3', maxViews: 8,
        looks: [], zoom: 4
    };
    const num = (k: string, v: string | undefined, min: number, max: number): number => {
        const n = Number(v);
        if (v === undefined || v.startsWith('--') || !Number.isFinite(n) || n < min || n > max) throw new Error(`${k} needs a number in [${min}, ${max}] (got "${v}")`);
        return n;
    };
    const str = (k: string, v: string | undefined): string => { if (v === undefined || v.startsWith('--')) throw new Error(`${k} needs a value`); return v; };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        switch (k) {
            case '--base-glb': a.baseGlb = path.resolve(REPO, str(k, argv[++i])); break;
            case '--library': a.library = path.resolve(REPO, str(k, argv[++i])); break;
            case '--out': a.out = path.resolve(REPO, str(k, argv[++i])); break;
            case '--max-scale': a.maxScale = num(k, argv[++i], 2, 4); if (a.maxScale !== 2 && a.maxScale !== 4) throw new Error('--max-scale must be 2 or 4'); break;
            case '--budget-mb': a.budgetMb = num(k, argv[++i], 1, 2048); break;
            case '--quality': a.quality = num(k, argv[++i], 50, 100); break;
            case '--no-gemini': a.gemini = false; break;
            case '--max-questions': a.maxQuestions = num(k, argv[++i], 0, 10000); break;
            case '--classify-only': a.classifyOnly = true; break;
            case '--render': a.render = true; break;
            case '--renderer': a.renderer = path.resolve(REPO, str(k, argv[++i])); break;
            case '--render-size': a.renderSize = num(k, argv[++i], 64, 4096); break;
            case '--render-spp': a.renderSpp = num(k, argv[++i], 1, 4096); break;
            case '--views': a.views = path.resolve(REPO, str(k, argv[++i])); break;
            case '--prefix': a.prefix = str(k, argv[++i]).replace(/[^A-Za-z0-9_-]/g, '_'); break;
            case '--max-views': a.maxViews = num(k, argv[++i], 0, 200); break;
            case '--zoom': a.zoom = num(k, argv[++i], 1, 64); break;
            case '--look': {
                // x,y,z:tx,ty,tz:vfovDeg  (scan frame)
                const v = str(k, argv[++i]).split(':');
                const p3 = (t: string) => { const q = t.split(',').map(Number); if (q.length !== 3 || q.some(x => !Number.isFinite(x))) throw new Error(`--look: bad vector "${t}"`); return q; };
                if (v.length !== 3 || !Number.isFinite(Number(v[2]))) throw new Error('--look needs x,y,z:tx,ty,tz:vfovDeg');
                a.looks!.push({ id: `look${a.looks!.length}`, kind: 'look', position: p3(v[0]), target: p3(v[1]), up: [0, 1, 0], verticalFovDeg: Number(v[2]) });
                break;
            }
            case '-h': case '--help': usage();
            // eslint-disable-next-line no-fallthrough
            default: throw new Error(`unknown argument ${k}`);
        }
    }
    if (!a.baseGlb || !a.library || !a.out) usage();
    return a as Args;
}

// ============================================================================================
// Renders (path tracer albedo pass: what an unlit viewer shows, anti-aliased by the samples)
// ============================================================================================

interface ViewSpec { id: string; kind: string; position: number[]; target: number[]; up: number[]; verticalFovDeg: number }

function renderAlbedo(renderer: string, glb: string, v: ViewSpec, dir: string, size: number, spp: number): { rgba: Buffer; coverage: Uint8Array } {
    fs.mkdirSync(dir, { recursive: true });
    const cfg = {
        glbPath: glb, outputDir: dir, width: size, height: size, samplesPerPixel: spp, maxBounces: 1, threads: 8, groundPlane: false,
        shadingMode: 'baked', denoise: false, exposure: 0, sun: { elevationDeg: 50, azimuthDeg: 180 },
        camera: { position: v.position, target: v.target, up: v.up, verticalFovDeg: v.verticalFovDeg }
    };
    const cfgPath = path.join(dir, 'cfg.json');
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const r = spawnSync(renderer, [cfgPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 });
    if (r.status !== 0) throw new Error(`renderer failed (${r.status ?? r.signal}) for ${v.id}: ${(r.stderr || r.stdout || '').slice(-300)}`);
    const albedo = decodePng(fs.readFileSync(path.join(dir, 'albedo.png')));
    const depth = fs.readFileSync(path.join(dir, 'depth.f32'));
    const coverage = new Uint8Array(size * size);
    for (let i = 0; i < coverage.length; i++) coverage[i] = depth.readFloatLE(i * 4) > 0 ? 1 : 0;
    const rgba = Buffer.alloc(size * size * 4);
    const src = albedo.rgba, ch = src.length / (size * size);
    for (let i = 0; i < size * size; i++) { for (let c = 0; c < 3; c++) rgba[i * 4 + c] = src[i * ch + c]; rgba[i * 4 + 3] = 255; }
    return { rgba, coverage };
}

function hstack(images: Array<{ rgba: Buffer; width: number; height: number }>, gap = 6): { rgba: Buffer; width: number; height: number } {
    const H = Math.max(...images.map(i => i.height));
    const W = images.reduce((s, i) => s + i.width, 0) + gap * (images.length - 1);
    const out = Buffer.alloc(W * H * 4, 255);
    let x0 = 0;
    for (const im of images) {
        for (let y = 0; y < im.height; y++) im.rgba.copy(out, (y * W + x0) * 4, y * im.width * 4, (y + 1) * im.width * 4);
        x0 += im.width + gap;
    }
    return { rgba: out, width: W, height: H };
}

/** Telephoto view from the same eye through pixel (u, v) of a square view, with the field of view divided by `factor`. */
function zoomView(v: ViewSpec, u: number, w: number, size: number, factor: number): ViewSpec {
    const n3 = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    const cr = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const f = n3([v.target[0] - v.position[0], v.target[1] - v.position[1], v.target[2] - v.position[2]]);
    const r = n3(cr(f, v.up)), up = cr(r, f);
    const t = Math.tan(v.verticalFovDeg * Math.PI / 360);
    const x = ((u + 0.5) / size * 2 - 1) * t, y = (1 - (w + 0.5) / size * 2) * t;
    const d = n3([f[0] + r[0] * x + up[0] * y, f[1] + r[1] * x + up[1] * y, f[2] + r[2] * x + up[2] * y]);
    return {
        id: `${v.id}_zoom`, kind: v.kind, position: v.position, target: [v.position[0] + d[0] * 100, v.position[1] + d[1] * 100, v.position[2] + d[2] * 100],
        up: v.up, verticalFovDeg: 2 * Math.atan(t / factor) * 180 / Math.PI
    };
}

function viewsFromPoses(file: string): ViewSpec[] {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const recs: Array<{ plate: StreetViewPlateRecord; kind: string }> = [];
    if (Array.isArray(j.plates)) for (const p of j.plates) recs.push({ plate: p, kind: 'plate' });
    if (Array.isArray(j.panos)) for (const pano of j.panos) for (const f of pano.frames ?? []) if (f.plate?.pose) recs.push({ plate: f.plate, kind: f.acceptedActive ? 'plate' : 'held-out' });
    const seen = new Set<string>();
    return recs.filter(r => !seen.has(r.plate.id) && !!seen.add(r.plate.id)).map(r => {
        const p = frameCameraToPose(plateRecordCamera(r.plate));
        return { id: r.plate.id, kind: r.kind, position: [p.x, p.y, p.z], target: [p.targetX, p.targetY, p.targetZ], up: (p.up ?? [0, 1, 0]) as number[], verticalFovDeg: p.fov };
    });
}

/** Pedestrian, mid-distance and aerial views of the largest assigned vertical cluster. */
function novelViews(clusters: PlaneCluster[], assignments: ClusterAssignment[]): ViewSpec[] {
    const vertical = assignments.map(a => clusters[a.cluster]).filter(c => c.tiltDeg > 70).sort((a, b) => b.area - a.area);
    const c = vertical[0];
    if (!c) return [];
    const n = c.normal, centre = c.origin;
    const at = (dist: number, height: number, side: number) => {
        const p = [centre[0] + n[0] * dist + c.uAxis[0] * side, Math.max(height, (centre[1] - (c.max[1] - c.min[1]) / 2) + height), centre[2] + n[2] * dist + c.uAxis[2] * side];
        return p;
    };
    const base = c.min[1];
    return [
        { id: 'novel_pedestrian', kind: 'novel', position: [centre[0] + n[0] * 18 + c.uAxis[0] * 6, base + 1.7, centre[2] + n[2] * 18 + c.uAxis[2] * 6], target: [centre[0], base + 8, centre[2]], up: [0, 1, 0], verticalFovDeg: 50 },
        { id: 'novel_midrange', kind: 'novel', position: at(70, 25, -20), target: [centre[0], centre[1], centre[2]], up: [0, 1, 0], verticalFovDeg: 40 },
        { id: 'novel_aerial', kind: 'novel', position: [centre[0] + n[0] * 250, centre[1] + 250, centre[2] + n[2] * 250], target: [centre[0], centre[1], centre[2]], up: [0, 1, 0], verticalFovDeg: 35 }
    ];
}

// ============================================================================================
// Main
// ============================================================================================

async function main() {
    loadDotEnv();
    const args = parseArgs(process.argv.slice(2));
    const t0 = Date.now();
    const libDir = path.dirname(args.library);
    const work = path.join(path.dirname(args.out), `${path.basename(args.out, path.extname(args.out))}_work`);
    fs.mkdirSync(work, { recursive: true });
    const library: MaterialLibrary = JSON.parse(fs.readFileSync(args.library, 'utf8'));
    log(`library: ${library.samples.length} samples (${path.relative(REPO, args.library)})`);
    const baseBytes = fs.readFileSync(args.baseGlb);
    const scan = loadBaseScan(args.baseGlb);
    log(`base: ${scan.prims.length} primitives, ${scan.triCount} triangles, ${(baseBytes.length / 1e6).toFixed(2)} MB`);
    const ground = buildGroundModel(loadScanMesh(args.baseGlb));
    const tc = Date.now();
    const { triCluster, clusters } = buildPlaneClusters(scan);
    const images = new LinearImageCache(scan);
    await describeClusters(scan, triCluster, clusters, images, (x, z) => ground.groundAt(x, z));
    const assignments = classifyClusters(clusters, library);
    log(`clusters: ${clusters.length} (${((Date.now() - tc) / 1000).toFixed(1)} s); assigned ${assignments.length}, ambiguous ${assignments.filter(a => a.ambiguous).length}`);
    let questions = 0;
    if (args.maxQuestions > 0) {
        const client = args.gemini ? await createGeminiContentClient() : null;
        const classifier = geminiOrthoClassifier(client, path.join(libDir, 'ortho_cache'), { allowNetwork: args.gemini });
        questions = await disambiguateClusters(scan, triCluster, clusters, library, assignments, images, classifier, { maxQuestions: args.maxQuestions });
        log(`multimodal disambiguation: ${questions} clusters asked; ${assignments.filter(a => a.decidedBy === 'multimodal').length} resolved, ${assignments.filter(a => a.decidedBy === 'multimodal-none').length} set to none`);
    }
    const assignedArea = assignments.filter(a => a.candidates.length).reduce((s, a) => s + clusters[a.cluster].area, 0);
    const totalArea = clusters.reduce((s, c) => s + c.area, 0);
    log(`assigned area ${assignedArea.toFixed(0)} of ${totalArea.toFixed(0)} m2 (${(100 * assignedArea / totalArea).toFixed(1)}%)`);

    const result = await bakeMaterialDetail(scan, triCluster, clusters, assignments, library, libDir, images, {
        maxScale: args.maxScale, budgetBytes: args.budgetMb * 1024 * 1024, jpegQuality: args.quality, dryRun: args.classifyOnly, log
    });
    if (!args.classifyOnly) fs.writeFileSync(args.out, result.glb);

    // per-label area
    const labelArea = new Map<string, number>();
    for (const a of assignments) if (a.candidates.length) { const l = library.samples[a.candidates[0].sample].label; labelArea.set(l, (labelArea.get(l) ?? 0) + clusters[a.cluster].area); }
    const report: any = {
        createdAt: new Date().toISOString(), baseGlb: path.relative(REPO, args.baseGlb), library: path.relative(REPO, args.library), out: path.relative(REPO, args.out),
        options: { maxScale: args.maxScale, budgetMb: args.budgetMb, quality: args.quality, gemini: args.gemini },
        clusters: { count: clusters.length, assigned: assignments.filter(a => a.candidates.length).length, ambiguous: assignments.filter(a => a.ambiguous).length, multimodalQuestions: questions, assignedAreaM2: +assignedArea.toFixed(1), totalAreaM2: +totalArea.toFixed(1) },
        labelAreaM2: Object.fromEntries([...labelArea.entries()].sort((a, b) => b[1] - a[1]).map(([l, a]) => [l, +a.toFixed(1)])),
        totals: result.totals,
        primitives: result.reports,
        assignments: assignments.filter(a => a.candidates.length).sort((a, b) => clusters[b.cluster].area - clusters[a.cluster].area).slice(0, 300).map(a => ({
            cluster: a.cluster, areaM2: +clusters[a.cluster].area.toFixed(1), tiltDeg: +clusters[a.cluster].tiltDeg.toFixed(1),
            heightAboveGround: clusters[a.cluster].heightAboveGround?.p50 ?? null, confidence: +a.confidence.toFixed(3), decidedBy: a.decidedBy,
            candidates: a.candidates.map(k => ({ sample: library.samples[k.sample].id, label: library.samples[k.sample].label, score: +k.score.toFixed(3) }))
        }))
    };
    log(`bake: ${result.totals.replaced} of ${result.totals.images} images replaced; output ${(result.glb.length / 1e6).toFixed(2)} MB`);
    log('image  prims  scale  q   covered m2  coverage  sharpness(detail)  sharpness(all)  loss/checked  below-bicubic  materials | kept: reason');
    for (const r of result.reports) {
        const head = `  ${String(r.imageIndex).padStart(3)}  ${r.primitives.join(',').padStart(5)}  ${r.scale}x  ${String(r.jpegQuality ?? '-').padStart(3)}  ${String(r.coveredAreaM2).padStart(9)}  ${(100 * r.coverageFraction).toFixed(1).padStart(6)}%  ${String(r.sharpness?.ratio ?? '-').padStart(8)}x  ${String(r.sharpnessAllTexels?.ratio ?? '-').padStart(8)}x  ${`${r.blocksWithSharpnessLoss}/${r.blocksChecked}`.padStart(11)}  ${String(r.blocksBelowBicubic).padStart(6)}`;
        log(r.replaced ? `${head}  ${r.materials.slice(0, 2).map(m => m.label).join('; ')}` : `${head}  | kept: ${r.reason ?? ''}`);
    }

    // ---------------- renders ----------------
    if (args.render && !args.classifyOnly) {
        if (!fs.existsSync(args.renderer)) throw new Error(`renderer not found: ${args.renderer}`);
        const shots = path.join(REPO, 'test-results', 'screenshots');
        fs.mkdirSync(shots, { recursive: true });
        const viewsFile = args.views ?? path.join(libDir, '..', 'plates', 'pose_report.json');
        const candidates = (fs.existsSync(viewsFile) ? viewsFromPoses(viewsFile) : []).concat(novelViews(clusters, assignments), args.looks);
        const S = args.renderSize;
        const renders: any[] = [];
        // quick pass: rank frame views by changed pixels
        const scored: Array<{ v: ViewSpec; changed: number }> = [];
        for (const v of candidates) {
            if (v.kind === 'novel' || v.kind === 'look') { scored.push({ v, changed: Infinity }); continue; }
            const a = renderAlbedo(args.renderer, args.baseGlb, v, path.join(work, 'renders_rank', v.id, 'base'), 128, 2);
            const b = renderAlbedo(args.renderer, args.out, v, path.join(work, 'renders_rank', v.id, 'baked'), 128, 2);
            let ch = 0;
            for (let i = 0; i < 128 * 128; i++) if (Math.abs(a.rgba[i * 4] - b.rgba[i * 4]) + Math.abs(a.rgba[i * 4 + 1] - b.rgba[i * 4 + 1]) > 6) ch++;
            scored.push({ v, changed: ch });
        }
        scored.sort((x, y) => y.changed - x.changed);
        const chosen = scored.filter(s => s.changed > 0).slice(0, args.maxViews + 3);
        for (const { v } of chosen) {
            const base = renderAlbedo(args.renderer, args.baseGlb, v, path.join(work, 'renders', v.id, 'base'), S, args.renderSpp);
            const baked = renderAlbedo(args.renderer, args.out, v, path.join(work, 'renders', v.id, 'baked'), S, args.renderSpp);
            const n = S * S;
            const changed = new Uint8Array(n), mesh = new Uint8Array(n);
            for (let i = 0; i < n; i++) {
                mesh[i] = base.coverage[i];
                const d = Math.abs(base.rgba[i * 4] - baked.rgba[i * 4]) + Math.abs(base.rgba[i * 4 + 1] - baked.rgba[i * 4 + 1]) + Math.abs(base.rgba[i * 4 + 2] - baked.rgba[i * 4 + 2]);
                if (d > 3 && base.coverage[i]) changed[i] = 1;
            }
            // dilate the changed mask (texture detail is sparse) to the surrounding surface
            const region = new Uint8Array(n);
            const R = 4;
            for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (changed[y * S + x]) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
                const xx = x + dx, yy = y + dy;
                if (xx >= 0 && yy >= 0 && xx < S && yy < S && mesh[yy * S + xx]) region[yy * S + xx] = 1;
            }
            const Lb = luminance8(base.rgba, n), La = luminance8(baked.rgba, n);
            const lb = laplacianVariance(Lb, S, S, region), la = laplacianVariance(La, S, S, region);
            const lbAll = laplacianVariance(Lb, S, S, mesh), laAll = laplacianVariance(La, S, S, mesh);
            let regionPx = 0;
            for (let i = 0; i < n; i++) regionPx += region[i];
            // zoom on the densest changed 96 px window
            let best = { x: 0, y: 0, c: -1 };
            const Z = Math.min(96, S);
            for (let y = 0; y + Z <= S; y += 16) for (let x = 0; x + Z <= S; x += 16) {
                let c = 0;
                for (let yy = y; yy < y + Z; yy += 2) for (let xx = x; xx < x + Z; xx += 2) c += changed[yy * S + xx];
                if (c > best.c) best = { x, y, c };
            }
            // re-render (not pixel-zoom) a telephoto view through the centre of that window: magnified texels show the detail
            const zv = zoomView(v, best.x + Z / 2, best.y + Z / 2, S, args.zoom);
            const zb = renderAlbedo(args.renderer, args.baseGlb, zv, path.join(work, 'renders', v.id, 'base_zoom'), S, args.renderSpp);
            const zk = renderAlbedo(args.renderer, args.out, zv, path.join(work, 'renders', v.id, 'baked_zoom'), S, args.renderSpp);
            const zmesh = zb.coverage;
            const zlb = laplacianVariance(luminance8(zb.rgba, n), S, S, zmesh), zla = laplacianVariance(luminance8(zk.rgba, n), S, S, zmesh);
            const strip = hstack([{ rgba: base.rgba, width: S, height: S }, { rgba: baked.rgba, width: S, height: S }, { rgba: zb.rgba, width: S, height: S }, { rgba: zk.rgba, width: S, height: S }]);
            const file = path.join(shots, `${args.prefix}_${v.kind}_${v.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)}.png`);
            fs.writeFileSync(file, encodePng(strip.width, strip.height, strip.rgba));
            const rec = {
                view: v.id, kind: v.kind, regionPixels: regionPx, meshPixels: mesh.reduce((s, x) => s + x, 0),
                sharpnessRegion: lb.pixels ? +(la.variance / Math.max(1e-9, lb.variance)).toFixed(3) : null,
                sharpnessAllMesh: lbAll.pixels ? +(laAll.variance / Math.max(1e-9, lbAll.variance)).toFixed(3) : null,
                zoom: { factor: args.zoom, verticalFovDeg: +zv.verticalFovDeg.toFixed(3), meshPixels: zmesh.reduce((acc, x) => acc + x, 0), sharpness: zlb.pixels ? +(zla.variance / Math.max(1e-9, zlb.variance)).toFixed(3) : null },
                file: path.relative(REPO, file)
            };
            renders.push(rec);
            log(`render ${v.kind} ${v.id}: detail region ${regionPx} px, sharpness x${rec.sharpnessRegion} (region) x${rec.sharpnessAllMesh} (all mesh), zoom x${args.zoom} sharpness x${rec.zoom.sharpness} -> ${rec.file}`);
        }
        report.renders = renders;
    }
    report.elapsedMs = Date.now() - t0;
    fs.writeFileSync(path.join(work, 'bake_report.json'), JSON.stringify(report, null, 1));
    log(`report: ${path.relative(REPO, path.join(work, 'bake_report.json'))}; done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main().catch(e => { console.error(redactSecrets(String((e as Error)?.stack ?? e))); process.exit(1); });
