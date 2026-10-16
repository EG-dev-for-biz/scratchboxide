/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The staged reveal and the provenance view on REAL data (design §11.3), in the real viewport:
 *  - Washington Square Arch: the devegetated extraction from the integration-behaviour cache (copied) is remeshed
 *    with the real tile_refine (TileRefineService.refine, isolate, relief on as the user decided), so the remesh
 *    carries tile_refine's own _RECTIFY_DISPLACEMENT, _PROUD_BLOCK and _RELIEF_HEIGHT. The isolated raw scan
 *    reveals, the remesh crossfades over it (frames at 0.25, 0.5, 1.0), and the provenance view shades the remesh
 *    by those attributes, read in the contract's bands, with the run's own counts in the legend.
 *  - Central Park: the real remesh (with its per-vertex provenance) and the real 1,043 SB-Veggie trees, revealed after
 *    the remesh, frames at 0.25, 0.5 and 1.0, then provenance.
 * Skipped, with the reason, when the cached real data is absent. No network: tile_refine runs locally on a copy.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PROUD_BLOCK_BANDS, PROVENANCE, RECTIFY_DISPLACEMENT_BANDS, RELIEF_HEIGHT_CARVED_MIN_M, type StagedBuildState, type StagedLayer, type VertexProvenanceSummary } from '../src/common/spatial/staged-location-contracts';
import { TileRefineService } from '../src/node/3d-engine/tile-refine-service';
import { fixtureState } from './helpers/staged-glb-fixture';
import { openStagedPage, stagedChrome, type StagedPage } from './helpers/staged-build-chrome';
import { stagedSceneData } from './helpers/staged-build-scene';
import { REPO_ROOT } from './helpers/requirements';

const BEHAVIOUR = '/Users/eligreen/Dev/scratchbox-ide-master/.claude/worktrees/integration-behaviour';
const ARCH_INPUT = path.join(BEHAVIOUR, '.scratchbox', 'cache', 'tile_vegetation', '5d6c8896ba091e6a8cbf69e83b0bd20b8fc1ff3619cafddde1e60c687ba7cafa', 'devegetated.glb');
const CP_TREES = path.join(BEHAVIOUR, 'public', 'models', 'central_park_40_78256_-73_96558_r250_textured_48a83729_sbveggie_trees.glb');
const CP_REMESH = path.join(BEHAVIOUR, 'public', 'models', 'central_park_40_78256_-73_96558_r250_textured_48a83729_sbveggie_refined_clay.glb');
const WORK = path.join(REPO_ROOT, 'test-results', 'staged-build', 'realdata');
const archReady = fs.existsSync(ARCH_INPUT);
const cpReady = fs.existsSync(CP_TREES) && fs.existsSync(CP_REMESH);

function readFloatAttribute(buf: Buffer, name: string): Float32Array[] {
    const jl = buf.readUInt32LE(12);
    const json = JSON.parse(buf.toString('utf8', 20, 20 + jl));
    const binStart = 20 + jl + 8;
    const out: Float32Array[] = [];
    for (const m of json.meshes ?? []) for (const p of m.primitives) {
        const a = p.attributes[name];
        if (a === undefined) continue;
        const acc = json.accessors[a];
        const view = json.bufferViews[acc.bufferView];
        const off = binStart + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
        const arr = new Float32Array(acc.count);
        for (let i = 0; i < acc.count; i++) arr[i] = buf.readFloatLE(off + i * (view.byteStride ?? 4));
        out.push(arr);
    }
    return out;
}

/** What the server reports per remesh layer: tile_refine's per-vertex provenance counted in the contract's bands. */
function vertexProvenanceOf(buf: Buffer): VertexProvenanceSummary {
    const disp = readFloatAttribute(buf, '_RECTIFY_DISPLACEMENT');
    const proud = readFloatAttribute(buf, '_PROUD_BLOCK');
    const relief = readFloatAttribute(buf, '_RELIEF_HEIGHT');
    const all = (xs: Float32Array[]) => xs.flatMap(x => Array.from(x));
    const d = all(disp), b = all(proud), r = all(relief);
    const inBand = (v: number, lo: number, hi?: number) => v >= lo && (hi === undefined || v < hi);
    return {
        schema: 'scratchbox.vertex-provenance/1',
        attributes: [...(d.length ? ['_RECTIFY_DISPLACEMENT'] : []), ...(b.length ? ['_PROUD_BLOCK'] : []), ...(r.length ? ['_RELIEF_HEIGHT'] : [])],
        vertices: d.length || b.length || r.length,
        ...(d.length ? { rectifyDisplacement: { maxM: Math.max(...d.map(Math.abs)), bands: RECTIFY_DISPLACEMENT_BANDS.map(x => ({ band: x.band, minM: x.minM, ...(x.maxM !== undefined ? { maxM: x.maxM } : {}), vertices: d.filter(v => inBand(Math.abs(v), x.minM, x.maxM)).length })) } } : {}),
        ...(b.length ? { proudBlocks: { keptAsScannedVertices: b.filter(v => inBand(v, PROUD_BLOCK_BANDS[0].minM, PROUD_BLOCK_BANDS[0].maxM)).length, snappedVertices: b.filter(v => inBand(v, PROUD_BLOCK_BANDS[1].minM, PROUD_BLOCK_BANDS[1].maxM)).length } } : {}),
        ...(r.length ? { relief: { carvedVertices: r.filter(v => Math.abs(v) >= RELIEF_HEIGHT_CARVED_MIN_M).length, maxAbsHeightM: Math.max(0, ...r.map(Math.abs)) } } : {})
    };
}

function counts(buf: Buffer): { vertices: number; triangles: number } {
    const jl = buf.readUInt32LE(12);
    const json = JSON.parse(buf.toString('utf8', 20, 20 + jl));
    let vertices = 0, triangles = 0;
    for (const m of json.meshes ?? []) for (const p of m.primitives) { vertices += json.accessors[p.attributes.POSITION].count; triangles += p.indices !== undefined ? json.accessors[p.indices].count / 3 : 0; }
    return { vertices, triangles };
}

function layer(objectId: string, stage: string, l: string, order: number, url: string, buf: Buffer, label: string, extra: Partial<StagedLayer> = {}): StagedLayer {
    return {
        objectId, stage, layer: l, order, url, bytes: buf.length, cached: false, builtAtMs: Date.now() - 60_000, counts: counts(buf),
        provenance: { label, measuredGeometry: true, method: stage, sources: [{ kind: 'stage-output', id: `${stage}:${objectId.slice(4, 12)}` }] },
        provenanceLabels: [label], supersedes: [], revealAfter: [], reveal: { durationMs: 800, stagger: 0, crossfadeFrom: [] }, ...extra
    };
}

const STEP = 16;
async function advanceTo(page: StagedPage, id: string, p: number): Promise<void> {
    for (let i = 0; i < 800; i++) {
        const f = await page.eval<{ phase: string; progress: number } | null>(`sbHarness.layer(${JSON.stringify(id)})`);
        if (f && (f.phase === 'revealed' || (f.phase === 'revealing' && f.progress >= p))) return;
        await page.step(1, STEP);
    }
    throw new Error(`${id} never reached ${p}`);
}

const hue = (rgb: [number, number, number]) => {
    const [r, g, b] = rgb.map(v => v / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d < 0.08) return -1;
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
};
const near = (a: number, b: number, tol: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b)) <= tol;

describe.skipIf(!stagedChrome.ok || !archReady)('Washington Square Arch: remesh by the real tile_refine, revealed and shaded by provenance', () => {
    let page: StagedPage;
    let rawBuf: Buffer, clayBuf: Buffer, vp: VertexProvenanceSummary, stats: Record<string, any>;
    beforeAll(async () => {
        const ws = path.join(WORK, 'arch-ws');
        fs.mkdirSync(ws, { recursive: true });
        const input = path.join(ws, 'arch_devegetated.glb');
        if (!fs.existsSync(input) || fs.statSync(input).size !== fs.statSync(ARCH_INPUT).size) fs.copyFileSync(ARCH_INPUT, input);
        const service = new TileRefineService({ workspaceRoot: ws, repoRoot: REPO_ROOT });
        const result = await service.refine({ tilePath: 'arch_devegetated.glb', isolate: true });
        rawBuf = fs.readFileSync(result.rawClayGlb!);
        clayBuf = fs.readFileSync(result.clayGlb);
        stats = result.stats;
        vp = vertexProvenanceOf(clayBuf);
        page = await openStagedPage({ manualFrames: true });
        page.serve('arch_raw_clay.glb', rawBuf);
        page.serve('arch_remesh_clay.glb', clayBuf);
    }, 600_000);
    afterAll(async () => { await page?.close(); });

    test('the remesh carries tile_refine per-vertex provenance; it crossfades over the raw scan and shades by band', async () => {
        expect(vp.attributes, 'tile_refine wrote its per-vertex attributes').toContain('_RECTIFY_DISPLACEMENT');
        const bands = vp.rectifyDisplacement!.bands;
        expect(bands.reduce((a, b) => a + b.vertices, 0)).toBe(vp.vertices);
        fs.writeFileSync(path.join(WORK, 'arch_vertex_provenance.json'), JSON.stringify({ vp, rectify: stats.rectify ?? null, relief: stats.relief ?? null }, null, 2));

        const raw = layer('stg-300dd401-l1', 'tiles', 'l1', 1, '/models/arch_raw_clay.glb', rawBuf, PROVENANCE.asScanned, { reveal: { durationMs: 800, stagger: 1, crossfadeFrom: [] } });
        const remesh = layer('stg-cec31de8-l2', 'remesh', 'l2', 2, '/models/arch_remesh_clay.glb', clayBuf, PROVENANCE.remeshed, {
            provenanceLabels: [PROVENANCE.remeshed, PROVENANCE.asScanned, PROVENANCE.photoInferred], vertexProvenance: vp,
            provenance: { label: PROVENANCE.remeshed, measuredGeometry: true, method: 'tile_refine: rectify, flatten, photometric relief (inferred)', sources: [{ kind: 'stage-output', id: 'remesh:cec31de8' }], note: `rectify moved ${(100 * (1 - bands[0].vertices / vp.vertices)).toFixed(0)}% of vertices 1 cm or more (max ${(vp.rectifyDisplacement!.maxM * 100).toFixed(1)} cm)` },
            supersedes: ['stg-300dd401-l1'], reveal: { durationMs: 600, stagger: 0, crossfadeFrom: ['stg-300dd401-l1'] }
        });
        const st0: StagedBuildState = { ...fixtureState([raw], { running: ['remesh'] }), requestKey: 'washington square arch|isolate' };
        st0.place = { query: 'Washington Square Arch', resolvedAddress: 'Washington Square N, New York, NY 10011', lat: 40.73122, lng: -73.99709 };
        const camera = { position: [32, 26, 40] as [number, number, number], target: [0, 9, 0] as [number, number, number] };
        await page.eval(`sbHarness.mount(${JSON.stringify({ ...stagedSceneData(st0, { camera }), objects: [] })})`);
        await page.waitFor('sbHarness.ready()');
        await page.step(6, STEP);
        await page.eval('sbHarness.setReference()');
        await page.eval(`sbHarness.update(${JSON.stringify(stagedSceneData(st0, { camera }))})`);
        await page.waitFor(`sbHarness.attached('stg-300dd401-l1')`);
        for (const p of [0.25, 0.5, 1]) { await advanceTo(page, 'stg-300dd401-l1', p); await page.screenshot(`real_arch_raw_scan_${Math.round(p * 100)}`); }

        const st1 = { ...st0, layers: [raw, remesh], stages: st0.stages.map(s => (s.stage === 'remesh' ? { ...s, status: 'committed' as const, layerIds: [remesh.objectId] } : s)) };
        const before = (await page.eval<{ covered: number }>('sbHarness.coverage()')).covered;
        await page.eval(`sbHarness.update(${JSON.stringify(stagedSceneData(st1, { camera }))})`);
        await page.waitFor(`sbHarness.attached('stg-cec31de8-l2')`);
        const cov: number[] = [];
        for (const p of [0.25, 0.5, 1]) {
            await advanceTo(page, 'stg-cec31de8-l2', p);
            cov.push((await page.eval<{ covered: number }>('sbHarness.coverage()')).covered);
            await page.screenshot(`real_arch_remesh_crossfade_${Math.round(p * 100)}`);
        }
        const floor = Math.min(before, cov[2]) * 0.99;
        for (const c of cov) expect(c, `crossfade coverage ${before} → ${cov.join(' → ')}`).toBeGreaterThanOrEqual(floor);

        await page.eval(`sbHarness.click('[data-testid="sb-staged-provenance-toggle"]')`);
        await page.step(3, STEP);
        await page.screenshot('real_arch_remesh_provenance');
        const legend = await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-legend"]')`);
        expect(legend).toContain(`untouched: moved under 1 cm by rectify and facade flatten (${bands[0].vertices.toLocaleString('en-US')} vert`);
        const nodes = await page.eval<Array<{ samples: Array<{ rgb: [number, number, number] }> }>>(`sbHarness.sampleNodes('stg-cec31de8-l2', 200)`);
        const hues = nodes.flatMap(n => n.samples.map(s => hue(s.rgb))).filter(h => h >= 0);
        const remeshed = hues.filter(h => near(h, 202, 20)).length;
        const scanned = hues.filter(h => near(h, 41, 15)).length;
        const photo = hues.filter(h => near(h, 327, 20)).length;
        fs.writeFileSync(path.join(WORK, 'arch_provenance_pixels.json'), JSON.stringify({ samples: hues.length, remeshed, asScanned: scanned, photoInferred: photo }, null, 2));
        expect(hues.length).toBeGreaterThan(50);
        expect((remeshed + scanned + photo) / hues.length, `remeshed ${remeshed}, as-scanned ${scanned}, photo-inferred ${photo} of ${hues.length}`).toBeGreaterThanOrEqual(0.9);
        expect(remeshed).toBeGreaterThan(0);
        if ((vp.relief?.carvedVertices ?? 0) === 0) expect(photo, 'no carved vertex, no photo-inferred pixel').toBe(0);
    }, 300_000);
});

describe.skipIf(!stagedChrome.ok || !cpReady)('Central Park: the real remesh and 1,043 trees revealed after it', () => {
    test('trees grow after the remesh (0.25, 0.5, 1.0), then provenance', async () => {
        fs.mkdirSync(WORK, { recursive: true });
        for (const f of [CP_TREES, CP_REMESH]) {
            const dst = path.join(WORK, path.basename(f));
            if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(f).size) fs.copyFileSync(f, dst);
        }
        const treesBuf = fs.readFileSync(path.join(WORK, path.basename(CP_TREES)));
        const remeshBuf = fs.readFileSync(path.join(WORK, path.basename(CP_REMESH)));
        const page = await openStagedPage({ manualFrames: true, width: 1280, height: 800 });
        try {
            page.serve('cp_remesh.glb', remeshBuf);
            page.serve('cp_trees.glb', treesBuf);
            const remesh = layer('stg-ca5b9855-l2', 'remesh', 'l2', 2, '/models/cp_remesh.glb', remeshBuf, PROVENANCE.remeshed, { vertexProvenance: vertexProvenanceOf(remeshBuf), reveal: { durationMs: 600, stagger: 0, crossfadeFrom: [] } });
            const trees = layer('stg-788091ff-l5', 'trees', 'l5', 5, '/models/cp_trees.glb', treesBuf, PROVENANCE.grownToMeasuredCrown, { revealAfter: [remesh.objectId], reveal: { durationMs: 2500, stagger: 0.3, crossfadeFrom: [] } });
            const st = fixtureState([remesh, trees], { runState: 'running' });
            await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(st))})`);
            for (const id of [remesh.objectId, trees.objectId]) await page.waitFor(`sbHarness.attached(${JSON.stringify(id)})`, 120_000);
            await page.eval(`sbHarness.setCameraView([-30, 0, 10], { theta: -0.55, phi: 0.95, distance: 330 })`);
            await advanceTo(page, remesh.objectId, 1);
            const trianglesAt: number[] = [];
            for (const p of [0.25, 0.5, 1]) {
                await advanceTo(page, trees.objectId, p);
                await page.step(1, STEP);
                trianglesAt.push((await page.eval<{ triangles: number }>('sbHarness.renderInfo()')).triangles);
                await page.screenshot(`real_cp_trees_grow_${Math.round(p * 100)}`);
            }
            for (let i = 1; i < trianglesAt.length; i++) expect(trianglesAt[i], `drawn triangles ${trianglesAt.join(' → ')}`).toBeGreaterThanOrEqual(trianglesAt[i - 1]);
            await page.eval(`sbHarness.click('[data-testid="sb-staged-provenance-toggle"]')`);
            await page.step(3, STEP);
            await page.screenshot('real_cp_provenance');
            const legend = await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-legend"]')`);
            expect(legend).toContain('reshaped: moved more than 5 cm');
            expect(legend).toContain('grown to the measured crown');
        } finally {
            await page.close();
        }
    }, 300_000);
});
