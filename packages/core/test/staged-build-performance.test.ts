/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Interaction stays smooth while the Central Park trees reveal (design §7.7; 1,043 SB-Veggie trees, 1.43 M triangles,
 * real data from the integration-behaviour worktree, copied before use). In headless Chrome with real WebGL and the real
 * clock, three runs over the same scene and camera, frame times measured:
 *  - baseline: the remesh and the trees as a plain scene (no staged build);
 *  - the trees as the tile_vegetation GLB writes them today (no _REVEAL: one fade per tree, staggered in plant order);
 *  - the same trees with a growth order derived from the real geometry (_REVEAL.x = plant rank, .y = vertex order in
 *    each tree, a test-only stand-in for the native creation order) revealing trunk to tips.
 * Checked: the per-frame cap on new staged materials holds, the guard's own cost stays small, unstarted trees are not
 * drawn (the reveal is chunked), frustum culling per tree node cuts the drawn triangles when the camera sees part of
 * the park, and the reveal's frame time is reported against the baseline. Numbers go to
 * test-results/staged-build/performance.json; screenshots to test-results/screenshots/staged/.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PROVENANCE, type StagedBuildState, type StagedLayer } from '../src/common/spatial/staged-location-contracts';
import { fixtureState } from './helpers/staged-glb-fixture';
import { openStagedPage, stagedChrome, type StagedPage } from './helpers/staged-build-chrome';
import { stagedSceneData } from './helpers/staged-build-scene';
import { REPO_ROOT } from './helpers/requirements';
import { MAX_NEW_MATERIALS_PER_FRAME } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/useStagedBuild';

const SOURCE = path.join(REPO_ROOT, '..', 'integration-behaviour', 'public', 'models');
const SOURCE_ALT = '/Users/eligreen/Dev/scratchbox-ide-master/.claude/worktrees/integration-behaviour/public/models';
const TREES = 'central_park_40_78256_-73_96558_r250_textured_48a83729_sbveggie_trees.glb';
const REMESH = 'central_park_40_78256_-73_96558_r250_textured_48a83729_sbveggie_refined_clay.glb';
const srcDir = [SOURCE, SOURCE_ALT].find(d => fs.existsSync(path.join(d, TREES)) && fs.existsSync(path.join(d, REMESH)));
const WORK = path.join(REPO_ROOT, 'test-results', 'staged-build', 'realdata');
const CAMERA = { position: [-120, 190, 230] as [number, number, number], target: [-20, 0, 0] as [number, number, number] };

function parseGlb(buf: Buffer): { json: any; bin: Buffer } {
    const jl = buf.readUInt32LE(12);
    const json = JSON.parse(buf.toString('utf8', 20, 20 + jl));
    const bh = 20 + jl;
    return { json, bin: buf.subarray(bh + 8, bh + 8 + buf.readUInt32LE(bh)) };
}

function writeGlb(json: any, bin: Buffer): Buffer {
    let j = Buffer.from(JSON.stringify(json));
    j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
    const b = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
    const h = Buffer.alloc(12); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + j.length + 8 + b.length, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(j.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(b.length, 0); bh.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([h, jh, j, bh, b]);
}

/**
 * The trees GLB with a growth order on its own vertices (test-only): x = the tree's plant rank (node order), y = the
 * vertex's position in its tree (wood first, then foliage, as the file stores them). Nothing else changes.
 */
function withDerivedGrowthOrder(buf: Buffer): Buffer {
    const { json, bin } = parseGlb(buf);
    const trees: number[] = json.nodes[json.scenes[0].nodes[0]].children;
    const parts: Buffer[] = [bin];
    let offset = bin.length;
    trees.forEach((nodeIndex, rank) => {
        const mesh = json.meshes[json.nodes[nodeIndex].mesh];
        const total = mesh.primitives.reduce((a: number, p: any) => a + json.accessors[p.attributes.POSITION].count, 0);
        let base = 0;
        for (const p of mesh.primitives) {
            const count = json.accessors[p.attributes.POSITION].count;
            const data = Buffer.alloc(count * 4);
            const x = Math.round((rank / Math.max(1, trees.length - 1)) * 65535);
            for (let v = 0; v < count; v++) {
                data.writeUInt16LE(x, v * 4);
                data.writeUInt16LE(Math.round(((base + v) / Math.max(1, total - 1)) * 65535), v * 4 + 2);
            }
            const pad = (4 - (offset % 4)) % 4;
            if (pad) { parts.push(Buffer.alloc(pad)); offset += pad; }
            json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length, target: 34962 });
            json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5123, normalized: true, count, type: 'VEC2' });
            p.attributes._REVEAL = json.accessors.length - 1;
            parts.push(data);
            offset += data.length;
            base += count;
        }
    });
    const out = Buffer.concat(parts);
    json.buffers[0].byteLength = out.length;
    return writeGlb(json, out);
}

function counts(buf: Buffer): { vertices: number; triangles: number } {
    const { json } = parseGlb(buf);
    let vertices = 0, triangles = 0;
    for (const m of json.meshes) for (const p of m.primitives) { vertices += json.accessors[p.attributes.POSITION].count; triangles += json.accessors[p.indices].count / 3; }
    return { vertices, triangles };
}

const pct = (xs: number[], p: number) => { if (xs.length === 0) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const summary = (xs: number[]) => ({ n: xs.length, p50: +pct(xs, 0.5).toFixed(2), p95: +pct(xs, 0.95).toFixed(2), max: +Math.max(...xs).toFixed(2) });
const intervals = (ts: number[]) => ts.slice(1).map((t, i) => t - ts[i]);

describe.skipIf(!stagedChrome.ok || !srcDir)('Central Park trees: reveal performance on real data', () => {
    let page: StagedPage;
    let treesBuf: Buffer, remeshBuf: Buffer, growthBuf: Buffer;
    const report: Record<string, unknown> = {};

    beforeAll(async () => {
        fs.mkdirSync(WORK, { recursive: true });
        for (const f of [TREES, REMESH]) fs.copyFileSync(path.join(srcDir!, f), path.join(WORK, f));
        treesBuf = fs.readFileSync(path.join(WORK, TREES));
        remeshBuf = fs.readFileSync(path.join(WORK, REMESH));
        growthBuf = withDerivedGrowthOrder(treesBuf);
        page = await openStagedPage({ manualFrames: false, width: 1280, height: 800 });
        page.serve('cp_remesh.glb', remeshBuf);
        page.serve('cp_trees.glb', treesBuf);
        page.serve('cp_trees_growth.glb', growthBuf);
    }, 120_000);

    afterAll(async () => {
        await page?.close();
        fs.mkdirSync(path.dirname(path.join(WORK, '..', 'performance.json')), { recursive: true });
        fs.writeFileSync(path.join(WORK, '..', 'performance.json'), JSON.stringify(report, null, 2));
        // eslint-disable-next-line no-console
        console.log('[staged-build performance]', JSON.stringify(report, null, 2));
    });

    function layers(treesUrl: string, treesCounts: { vertices: number; triangles: number }): StagedLayer[] {
        const remeshCounts = counts(remeshBuf);
        const common = { bytes: 0, cached: false, builtAtMs: Date.now() - 60_000, supersedes: [], provenanceLabels: [] };
        return [
            { ...common, objectId: 'stg-ca5b9855-l2', stage: 'remesh', layer: 'l2', order: 2, url: '/models/cp_remesh.glb', counts: remeshCounts,
              provenance: { label: PROVENANCE.remeshed, measuredGeometry: true, method: 'tile_refine', sources: [{ kind: 'stage-output', id: 'remesh:ca5b9855' }] },
              revealAfter: [], reveal: { durationMs: 600, stagger: 0, crossfadeFrom: [] } },
            { ...common, objectId: 'stg-788091ff-l5', stage: 'trees', layer: 'l5', order: 5, url: treesUrl, counts: treesCounts,
              provenance: { label: PROVENANCE.grownToMeasuredCrown, measuredGeometry: true, method: 'SB-Veggie space colonisation grown to the measured crown', sources: [{ kind: 'stage-output', id: 'trees:788091ff' }] },
              revealAfter: ['stg-ca5b9855-l2'], reveal: { durationMs: 2500, stagger: 0.3, crossfadeFrom: [] } }
        ];
    }

    async function mountAndWait(state: StagedBuildState, plain = false): Promise<void> {
        await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(state, { plain, camera: CAMERA }))})`);
        for (const id of ['stg-ca5b9855-l2', 'stg-788091ff-l5']) await page.waitFor(`sbHarness.attached(${JSON.stringify(id)})`, 120_000, id);
        // The same user view for every run: most of the park, filling the viewport.
        await page.eval(`sbHarness.setCameraView([-30, 0, 10], { theta: -0.55, phi: 0.95, distance: 330 })`);
    }

    async function frameRun(ms: number): Promise<{ intervals: number[]; renderMs: number[]; gpuMs: number[]; triangles: number[] }> {
        await page.eval('sbHarness.startFrameLog()');
        await new Promise(r => setTimeout(r, ms));
        const log = await page.eval<{ times: number[]; renderMs: number[]; gpuMs: number[]; triangles: number[] }>('sbHarness.stopFrameLog()');
        return { intervals: intervals(log.times), renderMs: log.renderMs, gpuMs: log.gpuMs, triangles: log.triangles };
    }

    test('baseline, staggered fade and growth: frame times, chunking, the material cap and culling', async () => {
        const trees = counts(treesBuf);
        expect(trees.triangles).toBeGreaterThan(1_400_000);
        report.input = { trees, treeNodes: parseGlb(treesBuf).json.nodes.length - 1, remesh: counts(remeshBuf), source: srcDir };

        // Baseline: the same objects, no staged build.
        await mountAndWait({ ...fixtureState([]), layers: layers('/models/cp_trees.glb', trees) }, true);
        report.gpu = await page.eval('sbHarness.gpuInfo()');
        await new Promise(r => setTimeout(r, 1500));
        const base = await frameRun(2500);
        report.baseline = { frameIntervalMs: summary(base.intervals), renderCpuMs: summary(base.renderMs), gpuMs: base.gpuMs.length ? summary(base.gpuMs) : 'timer query unavailable', trianglesDrawn: summary(base.triangles) };
        await page.screenshot('perf_cp_baseline_plain');

        for (const variant of [{ name: 'fade', url: '/models/cp_trees.glb', c: trees }, { name: 'growth', url: '/models/cp_trees_growth.glb', c: counts(growthBuf) }]) {
            const st = fixtureState(layers(variant.url, variant.c), { runState: 'running' });
            await page.eval('sbHarness.resetStats()');
            await mountAndWait(st);
            // Wait for the trees to start (the remesh reveals first: 600 ms), then log the whole trees reveal.
            await page.waitFor(`(sbHarness.layer('stg-788091ff-l5') || {}).phase === 'revealing'`, 30_000, 'trees revealing');
            const early = await page.eval<number[]>('sbHarness.stats().drawnStagedMeshes.slice(-1)');
            await page.screenshot(`perf_cp_${variant.name}_early`);
            const run = await frameRun(2700);
            await page.screenshot(`perf_cp_${variant.name}_end`);
            const stats = await page.eval<{ guardMs: number[]; newMaterials: number[]; drawnStagedMeshes: number[] }>('sbHarness.stats()');
            const phase = await page.eval<{ phase: string }>(`sbHarness.layer('stg-788091ff-l5')`);
            expect(phase.phase, `${variant.name}: the reveal finished within its 2.5 s`).toBe('revealed');
            expect(Math.max(...stats.newMaterials), `${variant.name}: new staged materials per frame`).toBeLessThanOrEqual(MAX_NEW_MATERIALS_PER_FRAME);
            const meshesTotal = 2086 + 1;
            const firstFrames = stats.drawnStagedMeshes.filter(n => n > 0).slice(0, 5);
            report[variant.name] = {
                frameIntervalMs: summary(run.intervals),
                renderCpuMs: summary(run.renderMs),
                gpuMs: run.gpuMs.length ? summary(run.gpuMs) : 'timer query unavailable',
                guardMs: summary(stats.guardMs),
                newMaterialsPerFrameMax: Math.max(...stats.newMaterials),
                drawnStagedMeshes: { firstFrames, early: early[0], max: Math.max(...stats.drawnStagedMeshes), of: meshesTotal },
                trianglesDrawn: summary(run.triangles)
            };
            // Chunked: the first frames of the trees reveal draw only the trees that have started.
            expect(Math.min(...firstFrames), `${variant.name}: first frames ${firstFrames.join(',')}`).toBeLessThan(meshesTotal * 0.5);
            expect(pct(stats.guardMs, 0.95), `${variant.name}: guard p95 ms`).toBeLessThan(4);
            // Smooth: the reveal costs no more than a few ms a frame over the same scene drawn plainly.
            expect(pct(run.intervals, 0.5), `${variant.name}: median frame interval vs baseline ${pct(base.intervals, 0.5)}`).toBeLessThanOrEqual(pct(base.intervals, 0.5) * 1.5 + 4);
        }

        // Provenance on the real remesh (displacement bands, kept-as-scanned blocks) and trees.
        await page.eval(`sbHarness.click('[data-testid="sb-staged-provenance-toggle"]')`);
        await new Promise(r => setTimeout(r, 600));
        await page.screenshot('perf_cp_provenance_on');
        await page.eval('sbHarness.resetStats()');
        const prov = await frameRun(1500);
        const provStats = await page.eval<{ guardMs: number[] }>('sbHarness.stats()');
        report.provenanceOn = { frameIntervalMs: summary(prov.intervals), renderCpuMs: summary(prov.renderMs), gpuMs: prov.gpuMs.length ? summary(prov.gpuMs) : 'timer query unavailable', guardMs: summary(provStats.guardMs) };
        expect(pct(prov.intervals, 0.5), 'provenance median frame interval vs baseline').toBeLessThanOrEqual(pct(base.intervals, 0.5) * 1.5 + 4);
        const legend = await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-legend"]')`);
        expect(legend).toContain('grown to the measured crown');

        // Frustum culling per tree node: close over one corner of the park, far fewer triangles are drawn.
        const all = pct(base.triangles, 0.5);
        await page.eval(`sbHarness.setCameraView([-180, 10, -200], { theta: 0.6, phi: 1.2, distance: 60 })`);
        await new Promise(r => setTimeout(r, 500));
        const near = await frameRun(600);
        report.culling = { wholeParkTrianglesDrawn: all, cornerTrianglesDrawn: pct(near.triangles, 0.5) };
        await page.screenshot('perf_cp_corner_culled');
        expect(pct(near.triangles, 0.5)).toBeLessThan(all * 0.6);
    }, 300_000);
});
