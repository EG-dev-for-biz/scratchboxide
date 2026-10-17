/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * "Change the whole arch model to bright red" on a staged location (stg-* layers, scene renderMode clay): the agent's
 * sb_set_material_pbr must draw red in the REAL viewport (headless Chrome, real WebGL, the real Scene3DPrimitive), over the
 * clay default and over provenance shading, and removing it (undo) must bring the clay back. A tool that cannot change
 * anything must say so. Screenshots: test-results/screenshots/staged_material/ (gitignored).
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DirectDispatchOperatorEngine } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import { buildStagedFixture, fixtureLayer, fixtureState, objectIdOf, type FixtureLayerId, type StagedFixtureGlbs } from './helpers/staged-glb-fixture';
import { openStagedPage, serveFixture, SHOT_DIR, stagedChrome, type StagedPage } from './helpers/staged-build-chrome';
import { stagedSceneData } from './helpers/staged-build-scene';

let fixture: StagedFixtureGlbs;
beforeAll(() => { fixture = buildStagedFixture(); });
const LAYERS: FixtureLayerId[] = ['l1', 'l2', 'l3a', 'l3b', 'l4', 'l5'];
const L = (l: FixtureLayerId) => fixtureLayer(l, fixture.counts, '/models');
const STEP = 16;
const stagedState = () => fixtureState(LAYERS.map(L), { runState: 'finished' });
const ids = () => LAYERS.map(objectIdOf);

/** The scene as the node-side tool hands it back: the same staged scene run through the real operator engine. */
function dispatch(scene: Record<string, unknown>, operator: string, params: Record<string, unknown>) {
    const engine = new DirectDispatchOperatorEngine(JSON.parse(JSON.stringify(scene)));
    const result = engine.executeBatch([{ operator, params }], { atomic: true });
    return { result, scene: engine.getSceneData() as unknown as Record<string, unknown> };
}

describe('sb_set_material_pbr on staged-location layers: honest results', () => {
    const scene = () => stagedSceneData(stagedState());

    test('red on every stg layer lands on each object (and nothing else)', () => {
        let s = scene();
        for (const id of ids()) {
            const r = dispatch(s, 'sb_set_material_pbr', { objectId: id, color: '#ff0000', roughness: 0.5 });
            expect(r.result.success).toBe(true);
            s = r.scene;
        }
        const objects = s.objects as Array<{ id: string; material?: { color: string } }>;
        expect(objects.map(o => o.material?.color)).toEqual(ids().map(() => '#ff0000'));
    });

    test('an object that is not in the scene is a typed failure, not a success', () => {
        const r = dispatch(scene(), 'sb_set_material_pbr', { objectId: 'stg-deadbeef-nope', color: '#ff0000' });
        expect(r.result.success).toBe(false);
        expect(r.result.results[0].error).toMatch(/no object with id "stg-deadbeef-nope"/);
    });

    test('neither a materialId nor an objectId, or a colour that is no colour, fail without changing the scene', () => {
        const none = dispatch(scene(), 'sb_set_material_pbr', { color: '#ff0000' });
        expect(none.result.success).toBe(false);
        expect(none.result.results[0].error).toMatch(/needs a materialId or an objectId/);
        const bad = dispatch(scene(), 'sb_set_material_pbr', { objectId: objectIdOf('l1'), color: 'bright reddish' });
        expect(bad.result.success).toBe(false);
        expect(bad.result.results[0].error).toMatch(/not a colour/);
        expect((bad.scene.objects as Array<{ material?: unknown }>).every(o => o.material === undefined)).toBe(true);
    });
});

describe.skipIf(!stagedChrome.ok)('an explicit material on staged layers is drawn (real viewport, headless Chrome)', () => {
    let page: StagedPage;
    const shotDir = path.join(SHOT_DIR, '..', 'staged_material');
    beforeAll(async () => {
        page = await openStagedPage({ manualFrames: true, shotDir });
        serveFixture(page, fixture.glbs, objectIdOf, fixture.sidecar);
    });
    afterAll(async () => { await page?.close(); });

    const mean = () => page.eval<{ r: number; g: number; b: number; pixels: number; redPixels: number }>('sbHarness.meanColor()');
    const withMaterial = (material: Record<string, unknown> | undefined, scene = stagedSceneData(stagedState())) => ({
        ...scene,
        objects: (scene.objects as Array<Record<string, unknown>>).map(o => {
            const { material: _old, ...rest } = o;
            return material ? { ...rest, material } : rest;
        })
    });

    test('red over clay, red over provenance shading, and the clay comes back when the material is removed', async () => {
        const base = stagedSceneData(stagedState());
        await page.eval(`sbHarness.mount(${JSON.stringify(base)})`);
        await page.waitFor('sbHarness.ready()');
        for (const id of ids()) await page.waitFor(`sbHarness.attached(${JSON.stringify(id)})`, 30_000, `${id} attached`);
        for (let i = 0; i < 400; i++) {
            const done = await page.eval<boolean>(`${JSON.stringify(ids())}.every(id => { const f = sbHarness.layer(id); return f && (f.phase === 'revealed' || f.phase === 'retired' || f.hidden); })`);
            if (done) break;
            await page.step(1, STEP);
        }
        await page.step(6, STEP);
        const clay = await mean();
        await page.screenshot('1_clay_default');
        expect(clay.pixels, 'the arch is drawn').toBeGreaterThan(2000);
        expect(Math.abs(clay.r - clay.g) + Math.abs(clay.g - clay.b), `clay is grey (${clay.r.toFixed(0)},${clay.g.toFixed(0)},${clay.b.toFixed(0)})`).toBeLessThan(40);
        expect(clay.redPixels).toBeLessThan(clay.pixels * 0.02);

        // The agent's tool result: the same scene run through sb_set_material_pbr on every layer.
        let edited: Record<string, unknown> = base;
        for (const id of ids()) edited = dispatch(edited, 'sb_set_material_pbr', { objectId: id, color: '#ff0000', roughness: 0.5, metalness: 0 }).scene;
        await page.eval(`sbHarness.update(${JSON.stringify(edited)})`);
        await page.step(10, STEP);
        const red = await mean();
        await page.screenshot('2_red_over_clay');
        expect(red.redPixels, `red pixels ${red.redPixels} of ${red.pixels}; mean (${red.r.toFixed(0)},${red.g.toFixed(0)},${red.b.toFixed(0)})`).toBeGreaterThan(red.pixels * 0.5);
        expect(red.r).toBeGreaterThan(red.g * 2.2);
        expect(red.r).toBeGreaterThan(red.b * 2.2);
        // No staged-reveal or provenance material left over the overridden meshes.
        const mats = await page.eval<string[]>(`${JSON.stringify(ids())}.flatMap(id => sbHarness.meshStates(id).filter(m => m.visible).map(m => m.material))`);
        expect(new Set(mats.filter(m => !/^Line/.test(m)))).toEqual(new Set(['MeshPhysicalMaterial']));

        // Provenance shading would paint the parts by how they were made; the explicit material is not shaded over.
        await page.eval(`sbHarness.click('[data-testid="sb-staged-provenance-toggle"]')`);
        await page.step(6, STEP);
        const prov = await mean();
        await page.screenshot('3_red_with_provenance_on');
        expect(prov.redPixels, 'still red with provenance on').toBeGreaterThan(prov.pixels * 0.5);
        await page.eval(`sbHarness.click('[data-testid="sb-staged-provenance-toggle"]')`);
        await page.step(6, STEP);

        // Undo: the scene data loses the material; clay returns, not the raw GLB look and not a stale red.
        await page.eval(`sbHarness.update(${JSON.stringify(withMaterial(undefined, edited))})`);
        await page.step(10, STEP);
        const back = await mean();
        await page.screenshot('4_undo_clay_restored');
        expect(back.redPixels).toBeLessThan(back.pixels * 0.02);
        expect(Math.abs(back.r - clay.r) + Math.abs(back.g - clay.g) + Math.abs(back.b - clay.b), 'same clay look as before the edit').toBeLessThan(25);

        // Redo, then a different colour edit on top (partial update keeps the object's other fields).
        await page.eval(`sbHarness.update(${JSON.stringify(withMaterial({ color: '#1e90ff', roughness: 0.3 }, edited))})`);
        await page.step(10, STEP);
        const blue = await mean();
        await page.screenshot('5_blue');
        expect(blue.b).toBeGreaterThan(blue.r * 1.5);
        expect(page.consoleErrors().filter(e => !/favicon/.test(e))).toEqual([]);
    }, 240_000);
});

describe('StagedBuildOverlay button style', () => {
    test('the shared button style does not mix the border shorthand with border longhands (React warns on the update that sets borderColor)', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/StagedBuildOverlay.tsx'), 'utf8');
        const button = src.slice(src.indexOf('const BUTTON: React.CSSProperties'), src.indexOf('const HIDDEN'));
        expect(button).not.toMatch(/\bborder:/);
        expect(button).toMatch(/borderColor:/);
        // The two places that override it set borderColor only.
        expect(src).toMatch(/\.\.\.BUTTON, width: '100%', \.\.\.\(props\.highlightedId === d\.id \? \{ borderColor:/);
    });
});
