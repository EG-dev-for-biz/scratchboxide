/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A tree layer written by the NATIVE staged writer (not a fixture built in TypeScript) grows in the real viewport.
 * The writer's GLB is quantised (KHR_mesh_quantization: 16-bit positions with a per-node transform, 8-bit normals) and
 * carries `_REVEAL` as normalised unsigned 16-bit pairs and `extras.sb` on its crown node, so this is the check that
 * the viewport reads the real encoding: no fragment before the first frame's progress, coverage that only grows,
 * trunk before tips, and provenance shading in the legend's "grown to the measured crown" hue.
 *
 * The file is read from the staged-native worktree's tile_vegetation cache (a copy goes under test-results/). Skipped,
 * with the reason, when no such file exists. No network.
 */

import { afterAll, describe, expect, test } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PROVENANCE, type StagedLayer } from '../src/common/spatial/staged-location-contracts';
import { fixtureState } from './helpers/staged-glb-fixture';
import { openStagedPage, stagedChrome, type StagedPage } from './helpers/staged-build-chrome';
import { stagedSceneData } from './helpers/staged-build-scene';
import { REPO_ROOT } from './helpers/requirements';

const NATIVE_CACHE = '/Users/eligreen/Dev/scratchbox-ide-master/.claude/worktrees/staged-native/.scratchbox/cache/tile_vegetation';
const WORK = path.join(REPO_ROOT, 'test-results', 'staged-build', 'native-trees');

interface Found { file: string; buf: Buffer; json: any }

/** The newest cached trees.glb that carries the staged writer's `_REVEAL` and node extras. */
function findNativeTrees(): Found | undefined {
    if (!fs.existsSync(NATIVE_CACHE)) return undefined;
    const files = fs.readdirSync(NATIVE_CACHE).map(d => path.join(NATIVE_CACHE, d, 'trees.glb')).filter(f => fs.existsSync(f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const file of files) {
        const buf = fs.readFileSync(file);
        const jl = buf.readUInt32LE(12);
        const json = JSON.parse(buf.toString('utf8', 20, 20 + jl));
        const staged = (json.nodes ?? []).some((n: any) => n.extras?.sb?.schema === 'scratchbox.staged-node/2');
        const reveal = (json.meshes ?? []).some((m: any) => m.primitives.some((p: any) => p.attributes._REVEAL !== undefined));
        if (staged && reveal) return { file, buf, json };
    }
    return undefined;
}

const found = findNativeTrees();

function counts(json: any): { vertices: number; triangles: number } {
    let vertices = 0, triangles = 0;
    for (const m of json.meshes ?? []) for (const p of m.primitives) {
        vertices += json.accessors[p.attributes.POSITION].count;
        triangles += p.indices !== undefined ? json.accessors[p.indices].count / 3 : 0;
    }
    return { vertices, triangles };
}

const hue = (rgb: [number, number, number]) => {
    const [r, g, b] = rgb.map(v => v / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d < 0.08) return -1;
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
};

describe.skipIf(!stagedChrome.ok || !found)(`a tree layer from the native staged writer${found ? '' : ' (no staged trees.glb in the staged-native cache)'}`, () => {
    let page: StagedPage | undefined;
    afterAll(async () => { await page?.close(); });

    test('the quantised _REVEAL grows the tree trunk to tips, and provenance shades it', async () => {
        const { buf, json, file } = found!;
        fs.mkdirSync(WORK, { recursive: true });
        fs.writeFileSync(path.join(WORK, 'native_trees.glb'), buf);
        // The encoding under test: normalised u16 _REVEAL, quantised positions, a crown node with staged extras.
        const prim = json.meshes[0].primitives[0];
        expect(json.extensionsRequired, 'KHR_mesh_quantization').toContain('KHR_mesh_quantization');
        expect(json.accessors[prim.attributes._REVEAL]).toMatchObject({ componentType: 5123, type: 'VEC2', normalized: true });
        expect(json.accessors[prim.attributes.POSITION]).toMatchObject({ componentType: 5122, normalized: true });

        const id = 'stg-a597faf3-l5';
        const c = counts(json);
        const layer: StagedLayer = {
            objectId: id, stage: 'trees', layer: 'l5', order: 5, url: '/models/native_trees.glb', bytes: buf.length, cached: false, builtAtMs: Date.now() - 1000,
            counts: c, supersedes: [], revealAfter: [], reveal: { durationMs: 1500, stagger: 0.3, crossfadeFrom: [] },
            provenance: { label: PROVENANCE.grownToMeasuredCrown, measuredGeometry: true, method: 'SB-Veggie', sources: [{ kind: 'stage-output', id: 'trees:native' }] },
            provenanceLabels: [PROVENANCE.grownToMeasuredCrown]
        };
        const st = fixtureState([layer], { runState: 'running' });
        const camera = { position: [14, 9, 20] as [number, number, number], target: [0, 4.4, 0] as [number, number, number] };
        page = await openStagedPage({ manualFrames: true });
        page.serve('native_trees.glb', buf);
        await page.eval(`sbHarness.mount(${JSON.stringify({ ...stagedSceneData(st, { camera }), objects: [] })})`);
        await page.waitFor('sbHarness.ready()');
        await page.step(6, 16);
        await page.eval('sbHarness.setReference()');
        await page.eval(`sbHarness.update(${JSON.stringify(stagedSceneData(st, { camera }))})`);
        await page.waitFor(`sbHarness.attached(${JSON.stringify(id)})`, 30_000, 'native trees attached');
        expect((await page.eval<{ covered: number }>('sbHarness.coverage()')).covered, 'nothing of the tree on the first frame after attach').toBe(0);

        const cov: number[] = [];
        for (const p of [0.25, 0.5, 1]) {
            for (let i = 0; i < 400; i++) {
                const f = await page.eval<{ phase: string; progress: number } | null>(`sbHarness.layer(${JSON.stringify(id)})`);
                if (f && (f.phase === 'revealed' || (f.phase === 'revealing' && f.progress >= p))) break;
                await page.step(1, 16);
            }
            if (p === 1) await page.step(2, 16);
            cov.push((await page.eval<{ covered: number }>('sbHarness.coverage()')).covered);
            await page.screenshot(`real_native_tree_grow_${String(Math.round(p * 100)).padStart(3, '0')}`);
        }
        expect(cov[0], `coverage ${cov.join(' → ')}`).toBeGreaterThan(0);
        expect(cov[1]).toBeGreaterThanOrEqual(cov[0]);
        expect(cov[2]).toBeGreaterThanOrEqual(cov[1]);
        expect(cov[0], `the tree grows: ${cov.join(' → ')}`).toBeLessThan(cov[2] * 0.85);
        fs.writeFileSync(path.join(WORK, 'native_trees_report.json'), JSON.stringify({ source: file, counts: c, coverage: cov }, null, 2));

        await page.eval(`sbHarness.click('[data-testid="sb-staged-provenance-toggle"]')`);
        await page.step(4, 16);
        await page.screenshot('real_native_tree_provenance');
        const nodes = await page.eval<Array<{ label?: string; samples: Array<{ rgb: [number, number, number] }> }>>(`sbHarness.sampleNodes(${JSON.stringify(id)}, 60)`);
        const hues = nodes.flatMap(n => n.samples.map(s => hue(s.rgb))).filter(h => h >= 0);
        const green = hue([0x00, 0x9e, 0x73]);
        expect(hues.length).toBeGreaterThan(20);
        const near = hues.filter(h => Math.min(Math.abs(h - green), 360 - Math.abs(h - green)) <= 20).length;
        expect(near / hues.length, `${near} of ${hues.length} samples in the "grown to the measured crown" hue`).toBeGreaterThanOrEqual(0.9);
    }, 120_000);
});
