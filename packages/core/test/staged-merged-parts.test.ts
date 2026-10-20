/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A staged layer of many small parts is merged into one mesh per material at load (mergeStagedParts.ts), and every part
 * keeps its identity. On the synthetic staged layers, and on a real pipeline E hero when one is cached on this machine:
 *  - geometry: one mesh per material, every part's triangles exactly its node's (same floats, same order), the range table
 *    maps every triangle to its node, its provenance and ids;
 *  - picking: a ray onto a part's triangle names that part; a part the staged build hides is not hit;
 *  - the real viewport (headless Chrome): draw calls before and after, and the frame merged against the frame unmerged
 *    from the same camera (clay; provenance view; the textured twin and the AI-enhanced plates for the E hero) is the same.
 * Screenshots: test-results/screenshots/viewport_cheap_steps/.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { StagedLayer } from '../src/common/spatial/staged-location-contracts';
import { MIN_PARTS, mergeStagedParts, mergedPartsOf, partAtTriangle, setPartVisibility, stagedPartOfHit } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/mergeStagedParts';
import { buildStagedFixture, fixtureLayer, fixtureState, glbCounts, objectIdOf, type FixtureLayerId, type StagedFixtureGlbs } from './helpers/staged-glb-fixture';
import { openStagedPage, serveFixture, stagedChrome, type StagedPage } from './helpers/staged-build-chrome';
import { stagedSceneData } from './helpers/staged-build-scene';
import { REPO_ROOT } from './helpers/requirements';

let fixture: StagedFixtureGlbs;
beforeAll(() => { fixture = buildStagedFixture(); });
const L = (l: FixtureLayerId, extra: Partial<StagedLayer> = {}) => fixtureLayer(l, fixture.counts, '/models', extra);
const SHOTS = path.join(REPO_ROOT, 'test-results', 'screenshots', 'viewport_cheap_steps');
const STEP = 16;

/** A pipeline E hero cached by an earlier staged build on this machine (this worktree's cache, or a sibling worktree's). */
function findEHero(): { dir: string } | undefined {
    const roots = [REPO_ROOT, path.resolve(REPO_ROOT, '..', '..', '..')];
    const caches: string[] = [];
    for (const r of roots) {
        caches.push(path.join(r, '.scratchbox', 'cache', 'staged_location', 'pipeline_e'));
        const wt = path.join(r, '.claude', 'worktrees');
        if (fs.existsSync(wt)) for (const d of fs.readdirSync(wt)) caches.push(path.join(wt, d, '.scratchbox', 'cache', 'staged_location', 'pipeline_e'));
    }
    for (const c of caches) {
        if (!fs.existsSync(c)) continue;
        for (const run of fs.readdirSync(c)) {
            const dir = path.join(c, run);
            const need = ['relief/massing_relief_clay.glb', 'relief/massing_relief_textured.glb', 'inference/massing_enhanced_clay.glb', 'inference/massing_enhanced_textured.glb'];
            if (need.every(f => fs.existsSync(path.join(dir, f)))) {
                // copied before use: the cache belongs to whoever built it
                const work = path.join(REPO_ROOT, 'test-results', 'staged-build', 'e-hero');
                fs.mkdirSync(work, { recursive: true });
                for (const f of need) fs.copyFileSync(path.join(dir, f), path.join(work, path.basename(f)));
                return { dir: work };
            }
        }
    }
    return undefined;
}
const eHero = findEHero();

async function parse(buf: Buffer): Promise<THREE.Object3D> {
    const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, '');
    return gltf.scene;
}

interface NodeTris { name: string; label?: string; tris: number[] }
/** Every staged node's triangles as world-space floats, in index order. */
function nodeTriangles(root: THREE.Object3D): Map<string, NodeTris> {
    root.updateMatrixWorld(true);
    const out = new Map<string, NodeTris>();
    const v = new THREE.Vector3();
    root.traverse(o => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const g = m.geometry as THREE.BufferGeometry;
        const pos = g.getAttribute('position');
        const sb = (m.userData as { sb?: { provenance?: { label?: string } } }).sb;
        const entry: NodeTris = { name: m.name, label: sb?.provenance?.label, tris: [] };
        const n = g.index ? g.index.count : pos.count;
        for (let k = 0; k < n; k++) { v.fromBufferAttribute(pos, g.index ? g.index.getX(k) : k).applyMatrix4(m.matrixWorld); entry.tris.push(v.x, v.y, v.z); }
        out.set(m.name, entry);
    });
    return out;
}

async function checkMerge(buf: Buffer, what: string): Promise<{ before: number; after: number; parts: number; triangles: number; picked: number }> {
    const original = nodeTriangles(await parse(buf));
    const root = await parse(buf);
    const report = mergeStagedParts(root);
    expect(report, `${what} is eligible`).toBeDefined();
    const merged: THREE.Mesh[] = [];
    root.traverse(o => { if ((o as THREE.Mesh).isMesh) merged.push(o as THREE.Mesh); });
    const materials = new Set(merged.map(m => (m.material as THREE.Material).uuid));
    expect(merged.length, `${what}: one mesh per material`).toBe(materials.size);
    expect(merged.every(m => mergedPartsOf(m))).toBe(true);
    let parts = 0, triangles = 0, picked = 0;
    const v = new THREE.Vector3();
    root.updateMatrixWorld(true);
    for (const m of merged) {
        const table = mergedPartsOf(m)!;
        const g = m.geometry as THREE.BufferGeometry;
        const pos = g.getAttribute('position');
        for (const p of table.parts) {
            parts++;
            const o = original.get(p.name)!;
            expect(o, `${p.name} was a node`).toBeDefined();
            expect(p.sb.provenance?.label).toBe(o.label);
            expect(p.triCount * 9).toBe(o.tris.length);
            // the same floats in the same order
            const got: number[] = [];
            for (let k = p.triStart * 3; k < (p.triStart + p.triCount) * 3; k++) { v.fromBufferAttribute(pos, g.index!.getX(k)).applyMatrix4(m.matrixWorld); got.push(v.x, v.y, v.z); }
            expect(got).toEqual(o.tris);
            for (let t = p.triStart; t < p.triStart + p.triCount; t++) expect(partAtTriangle(table, t)?.name).toBe(p.name);
            triangles += p.triCount;
            // a ray onto the part's largest triangle, from just in front of it: the hit names the part
            let best = -1, area = 0;
            const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
            for (let t = p.triStart; t < p.triStart + p.triCount; t++) {
                a.fromBufferAttribute(pos, g.index!.getX(3 * t)); b.fromBufferAttribute(pos, g.index!.getX(3 * t + 1)); c.fromBufferAttribute(pos, g.index!.getX(3 * t + 2));
                const ar = n.subVectors(b, a).cross(c.clone().sub(a)).length();
                if (ar > area) { area = ar; best = t; }
            }
            if (best < 0 || area < 1e-6) continue;
            a.fromBufferAttribute(pos, g.index!.getX(3 * best)); b.fromBufferAttribute(pos, g.index!.getX(3 * best + 1)); c.fromBufferAttribute(pos, g.index!.getX(3 * best + 2));
            const centre = a.clone().add(b).add(c).multiplyScalar(1 / 3).applyMatrix4(m.matrixWorld);
            const normal = n.subVectors(b, a).cross(c.clone().sub(a)).normalize().transformDirection(m.matrixWorld);
            const ray = new THREE.Raycaster(centre.clone().addScaledVector(normal, 0.002), normal.clone().negate(), 0, 0.01);
            const hit = ray.intersectObject(m, false)[0];
            if (hit && stagedPartOfHit(hit)?.name === p.name) picked++;
            // hidden by the staged build: not hit there any more
            setPartVisibility(m, i => i !== p.index);
            const again = ray.intersectObject(m, false).filter(h => stagedPartOfHit(h)?.name === p.name);
            expect(again, `${p.name} hidden is not picked`).toHaveLength(0);
            setPartVisibility(m, () => true);
        }
    }
    expect(parts).toBe(original.size);
    expect(triangles).toBe([...original.values()].reduce((s, n) => s + n.tris.length / 9, 0));
    return { before: original.size, after: merged.length, parts, triangles, picked };
}

describe('merging a staged layer per material keeps every part', () => {
    test('synthetic tiles and fitted body layers: same triangles per part, ranges map back, rays name the part', async () => {
        for (const l of ['l1', 'l3b'] as const) {
            const r = await checkMerge(fixture.glbs[l], l);
            expect(r.after).toBe(1);
            expect(r.parts).toBeGreaterThanOrEqual(MIN_PARTS);
            expect(r.picked / r.parts, `${l}: picked ${r.picked} of ${r.parts}`).toBeGreaterThanOrEqual(0.9);
        }
    });

    test('a model that is not a staged layer of plain parts is left untouched (per-vertex reveal timing, trees, too few parts)', async () => {
        expect(mergeStagedParts(await parse(fixture.glbs.l4)), 'l4 carries _reveal / outlines').toBeUndefined();
        const few = await parse(fixture.glbs.l2);
        const before: THREE.Object3D[] = [];
        few.traverse(o => before.push(o));
        expect(mergeStagedParts(few)).toBeUndefined();
        const after: THREE.Object3D[] = [];
        few.traverse(o => after.push(o));
        expect(after).toEqual(before);
        expect(mergeStagedParts(await parse(fixture.glbs.l5))).toBeUndefined();
    });

    test.skipIf(!eHero)('a real pipeline E hero (clay relief and enhanced layers): 94 meshes become one, nothing lost', async () => {
        for (const f of ['massing_relief_clay.glb', 'massing_enhanced_clay.glb']) {
            const buf = fs.readFileSync(path.join(eHero!.dir, f));
            const r = await checkMerge(buf, f);
            expect(r.before).toBe(glbCounts(buf).nodes - 1);    // every node but the root container
            expect(r.after).toBe(1);
            expect(r.triangles).toBe(glbCounts(buf).triangles);
            expect(r.picked / r.parts, `${f}: picked ${r.picked} of ${r.parts}`).toBeGreaterThanOrEqual(0.9);
        }
    });
});

interface Diff { max: number; differing: number; total: number; meanDiff: number }

describe.skipIf(!stagedChrome.ok)('the real viewport draws a merged layer as it drew its parts', () => {
    let page: StagedPage;
    beforeAll(async () => {
        page = await openStagedPage({ manualFrames: true, shotDir: SHOTS });
        serveFixture(page, fixture.glbs, objectIdOf, fixture.sidecar);
        if (eHero) for (const f of fs.readdirSync(eHero.dir)) page.serve(`ehero/${f}`, fs.readFileSync(path.join(eHero.dir, f)));
    });
    afterAll(async () => { await page?.close(); });

    /** Mounts `data` with merging on or off, waits for `ids` and settles; keeps the frame as `name`; returns draw calls. */
    async function frameOf(data: Record<string, unknown>, ids: string[], merge: boolean, name: string, after?: () => Promise<void>): Promise<{ calls: number; triangles: number }> {
        await page.eval(`localStorage.setItem('sb.mergeStagedParts', '${merge ? '1' : '0'}')`);
        await page.eval(`sbHarness.mount(${JSON.stringify(data)})`);
        await page.waitFor('sbHarness.ready()');
        for (const id of ids) await page.waitFor(`sbHarness.attached(${JSON.stringify(id)})`, 30_000, `${id} attached`);
        await page.step(40, STEP);
        if (after) await after();
        await page.step(10, STEP);
        const merged = await page.eval<number>(`(() => { let n = 0; for (const id of ${JSON.stringify(ids)}) window.__SB_3D_EXTERNAL_OBJECTS__.get(id)?.traverse(o => { if (o.userData?.sbMergedParts) n++; }); return n; })()`);
        expect(merged > 0, `${name}: merged ${merged}`).toBe(merge);
        await page.eval(`sbHarness.keepFrame(${JSON.stringify(name)})`);
        await page.screenshot(name);
        return page.eval<{ calls: number; triangles: number }>('sbHarness.renderInfo()');
    }

    test('synthetic fitted body and detail, clay and provenance view: fewer draw calls, the same pixels', async () => {
        const st = fixtureState([L('l3b'), L('l4')], { runState: 'finished', updatedAtMs: Date.now() - 60_000 });
        const data = stagedSceneData(st);
        const ids = [objectIdOf('l3b'), objectIdOf('l4')];
        const off = await frameOf(data, ids, false, 'merge_fixture_clay_unmerged');
        const on = await frameOf(data, ids, true, 'merge_fixture_clay_merged');
        const d = await page.eval<Diff>(`sbHarness.frameDiff('merge_fixture_clay_unmerged', 'merge_fixture_clay_merged')`);
        expect(on.calls, `draw calls ${off.calls} -> ${on.calls}`).toBeLessThan(off.calls);
        // parts the staged build hides (surfaces the detail layer recut) are collapsed to zero-area triangles: submitted, never drawn
        const collapsed = await page.eval<number>(`(() => { let n = 0; for (const id of ${JSON.stringify(ids)}) window.__SB_3D_EXTERNAL_OBJECTS__.get(id)?.traverse(o => { const t = o.userData?.sbMergedParts; if (t && o.visible) for (const p of t.parts) if (!t.visible[p.index]) n += p.triCount; }); return n; })()`);
        expect(on.triangles - collapsed).toBe(off.triangles);
        expect(d.differing / d.total, `clay: ${JSON.stringify(d)}`).toBeLessThan(0.001);
        const prov = async () => { await page.eval(`sbHarness.click('[data-testid="sb-staged-provenance-toggle"]')`); await page.step(20, STEP); };
        await frameOf(data, ids, false, 'merge_fixture_provenance_unmerged', prov);
        await frameOf(data, ids, true, 'merge_fixture_provenance_merged', prov);
        const p = await page.eval<Diff>(`sbHarness.frameDiff('merge_fixture_provenance_unmerged', 'merge_fixture_provenance_merged')`);
        expect(p.differing / p.total, `provenance: ${JSON.stringify(p)}`).toBeLessThan(0.001);
        expect(page.consoleErrors()).toEqual([]);
    });

    test.skipIf(!eHero)('a real pipeline E hero: clay, textured twin and the AI-enhanced plates draw the same from one camera, with a handful of draw calls', async () => {
        const camFor = (buf: Buffer) => {
            const json = JSON.parse(buf.toString('utf8', 20, 20 + buf.readUInt32LE(12)));
            const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
            for (const m of json.meshes) for (const pr of m.primitives) { const a = json.accessors[pr.attributes.POSITION]; for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], a.min[k]); max[k] = Math.max(max[k], a.max[k]); } }
            const c = [0, 1, 2].map(k => (min[k] + max[k]) / 2) as [number, number, number];
            const r = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
            return { position: [c[0] + 1.3 * r, c[1] + 0.5 * r, c[2] + 1.6 * r] as [number, number, number], target: c };
        };
        const results: Record<string, { unmerged: number; merged: number; diff: Diff }> = {};
        for (const kind of ['relief', 'enhanced'] as const) {
            const clay = `massing_${kind}_clay.glb`, tex = `massing_${kind}_textured.glb`;
            const clayBuf = fs.readFileSync(path.join(eHero!.dir, clay)), texBuf = fs.readFileSync(path.join(eHero!.dir, tex));
            const counts = glbCounts(clayBuf);
            const id = `stg-e0e0e0e0-${kind}`;
            const layer: StagedLayer = {
                ...L('l3b'), objectId: id, url: `/models/ehero/${clay}`, layer: 'l2r', supersedes: [], revealAfter: [], counts: { vertices: counts.vertices, triangles: counts.triangles },
                reveal: { durationMs: 600, stagger: 0.5, crossfadeFrom: [] },
                textured: { url: `/models/ehero/${tex}`, bytes: texBuf.length, ladderRung: 1, rungShares: [0, 1, 0, 0, 0, 0].slice(0, 6), provenance: [], confidenceChannels: 'R index, G weight, B rung, A produced', builtAtMs: Date.now() - 60_000, cached: true }
            };
            const camera = camFor(clayBuf);
            for (const mode of ['clay', 'textured'] as const) {
                const st = { ...fixtureState([layer], { runState: 'finished', updatedAtMs: Date.now() - 60_000 }), materialMode: mode };
                const data = stagedSceneData(st, { camera });
                const ids = mode === 'textured' ? [id, `${id}~tex`] : [id];
                const off = await frameOf(data, ids, false, `merge_ehero_${kind}_${mode}_unmerged`);
                const on = await frameOf(data, ids, true, `merge_ehero_${kind}_${mode}_merged`);
                const d = await page.eval<Diff>(`sbHarness.frameDiff('merge_ehero_${kind}_${mode}_unmerged', 'merge_ehero_${kind}_${mode}_merged')`);
                results[`${kind} ${mode}`] = { unmerged: off.calls, merged: on.calls, diff: d };
                expect(on.calls, `${kind} ${mode}: ${off.calls} -> ${on.calls}`).toBeLessThan(off.calls);
                expect(on.triangles).toBe(off.triangles);
                expect(d.differing / d.total, `${kind} ${mode}: ${JSON.stringify(d)}`).toBeLessThan(0.002);
                // the provenance view: clay shades each part by its label (vector-modelled, measured, photo-inferred, generated); textured by texel rung
                const prov = async () => { await page.eval(`sbHarness.click('[data-testid="sb-staged-provenance-toggle"]')`); await page.step(20, STEP); };
                const poff = await frameOf(data, ids, false, `merge_ehero_${kind}_${mode}_provenance_unmerged`, prov);
                const pon = await frameOf(data, ids, true, `merge_ehero_${kind}_${mode}_provenance_merged`, prov);
                const pd = await page.eval<Diff>(`sbHarness.frameDiff('merge_ehero_${kind}_${mode}_provenance_unmerged', 'merge_ehero_${kind}_${mode}_provenance_merged')`);
                results[`${kind} ${mode} provenance`] = { unmerged: poff.calls, merged: pon.calls, diff: pd };
                expect(pd.differing / pd.total, `${kind} ${mode} provenance: ${JSON.stringify(pd)}`).toBeLessThan(0.002);
            }
        }
        fs.writeFileSync(path.join(SHOTS, 'merge_ehero_results.json'), JSON.stringify(results, null, 2));
        expect(page.consoleErrors().filter(e => !/confidence texture/.test(e))).toEqual([]);
    });
});
