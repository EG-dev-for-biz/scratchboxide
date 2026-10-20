/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Superseded staged layers are freed (layerEviction.ts) and load again on demand. Pure rules first, then the real
 * viewport in headless Chrome (Scene3DPrimitive, its loader, the staged-build hook, the cost probe): the fixture's remesh
 * (l2) supersedes its tiles (l1); once l1 has been hidden for EVICT_AFTER_MS its model is released (renderer geometries,
 * the probe's geometry bytes), the frame is unchanged, "Show replaced layers" loads it again as a ghost, turning that off
 * frees it again, and "Replay build" loads and reveals it. Screenshots go to test-results/screenshots/viewport_cheap_steps/.
 */

import * as path from 'path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { StagedBuildState, StagedLayer } from '../src/common/spatial/staged-location-contracts';
import { EVICT_AFTER_MS, evictionCandidates, stepEviction } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/layerEviction';
import { buildStagedFixture, fixtureLayer, fixtureState, objectIdOf, type FixtureLayerId, type StagedFixtureGlbs } from './helpers/staged-glb-fixture';
import { openStagedPage, serveFixture, stagedChrome, type StagedPage } from './helpers/staged-build-chrome';
import { stagedSceneData } from './helpers/staged-build-scene';
import { REPO_ROOT } from './helpers/requirements';

let fixture: StagedFixtureGlbs;
beforeAll(() => { fixture = buildStagedFixture(); });
const L = (l: FixtureLayerId, extra: Partial<StagedLayer> = {}) => fixtureLayer(l, fixture.counts, '/models', extra);
const SHOTS = path.join(REPO_ROOT, 'test-results', 'screenshots', 'viewport_cheap_steps');
const STEP = 16;

type Phase = 'loading' | 'held' | 'queued' | 'revealing' | 'revealed' | 'retired';
const frameOf = (layers: Array<{ objectId: string; phase: Phase; hidden: boolean; loadFailed?: boolean }>, animating = false) => ({ layers, animating });

describe('which superseded layers are freed', () => {
    const state = (): StagedBuildState => fixtureState([L('l1'), L('l2'), L('l3a'), L('l3b')], { runState: 'finished' });
    const id = objectIdOf;

    test('a layer hidden under a revealed replacement is a candidate; a showing layer, or one whose replacement is still revealing, is not', () => {
        const st = state();
        const c = evictionCandidates({
            state: st, engaged: new Map(), showReplaced: false, replaying: false,
            frame: frameOf([
                { objectId: id('l1'), phase: 'revealed', hidden: true },
                { objectId: id('l2'), phase: 'revealed', hidden: true },
                { objectId: id('l3a'), phase: 'revealed', hidden: false },
                { objectId: id('l3b'), phase: 'revealed', hidden: false }
            ])
        });
        expect([...c].sort()).toEqual([id('l1'), id('l2')].sort());
        const midway = evictionCandidates({
            state: st, engaged: new Map(), showReplaced: false, replaying: false,
            frame: frameOf([
                { objectId: id('l1'), phase: 'revealed', hidden: true },
                { objectId: id('l2'), phase: 'revealed', hidden: false },
                { objectId: id('l3b'), phase: 'revealing', hidden: false }
            ], true)
        });
        expect(midway.size, 'nothing is freed while anything reveals').toBe(0);
        const replacerNotDone = evictionCandidates({
            state: st, engaged: new Map(), showReplaced: false, replaying: false,
            frame: frameOf([
                { objectId: id('l1'), phase: 'revealed', hidden: true },
                { objectId: id('l2'), phase: 'queued', hidden: false }
            ])
        });
        expect(replacerNotDone.size, 'a layer whose replacement has not revealed is kept').toBe(0);
    });

    test('opt-in views keep every layer: Show replaced layers, Replay build; an engaged twin layer and a swap layer are never freed', () => {
        const st = state();
        const frame = frameOf([{ objectId: id('l1'), phase: 'revealed', hidden: true }, { objectId: id('l2'), phase: 'revealed', hidden: false }]);
        expect(evictionCandidates({ state: st, frame, engaged: new Map(), showReplaced: true, replaying: false }).size).toBe(0);
        expect(evictionCandidates({ state: st, frame, engaged: new Map(), showReplaced: false, replaying: true }).size).toBe(0);
        expect(evictionCandidates({ state: st, frame, engaged: new Map([[id('l1'), {}]]), showReplaced: false, replaying: false }).size).toBe(0);
        // only a clay <-> textured swap layer replaces l2 here: the clay copy under its twin stays loaded
        const swap = { ...L('l2'), objectId: `${id('l2')}~tex#1`, layer: 'l2~tex', supersedes: [id('l2')], reveal: { ...L('l2').reveal, crossfadeFrom: [id('l2')] } };
        const st2: StagedBuildState = { ...st, layers: [L('l2'), swap] };
        const c = evictionCandidates({ state: st2, engaged: new Map(), showReplaced: false, replaying: false, frame: frameOf([{ objectId: id('l2'), phase: 'revealed', hidden: true }, { objectId: swap.objectId, phase: 'revealed', hidden: false }]) });
        expect(c.size).toBe(0);
        const failed = evictionCandidates({ state: st, engaged: new Map(), showReplaced: false, replaying: false, frame: frameOf([{ objectId: id('l1'), phase: 'revealed', hidden: true, loadFailed: true }, { objectId: id('l2'), phase: 'revealed', hidden: false }]) });
        expect(failed.size).toBe(0);
    });

    test('a candidate is freed only after it has been one for the delay; leaving the candidates resets its clock', () => {
        const since = new Map<string, number>();
        const c = new Set(['a', 'b']);
        expect(stepEviction(c, since, 1000).evict.size).toBe(0);
        expect(stepEviction(c, since, 1000).nextCheckMs).toBe(1000 + EVICT_AFTER_MS);
        expect([...stepEviction(new Set(['a']), since, 1000 + EVICT_AFTER_MS - 1).evict]).toEqual([]);
        expect([...stepEviction(new Set(['a']), since, 1000 + EVICT_AFTER_MS).evict]).toEqual(['a']);
        expect(since.has('b'), 'b left the candidates').toBe(false);
        expect(stepEviction(new Set(['a', 'b']), since, 1000 + EVICT_AFTER_MS + 5).evict.has('b'), 'b starts its delay again').toBe(false);
    });
});

interface Breakdown { groups: Array<{ key: string; geometryBytes: number; triangles: number; drawCalls: number }>; total: { geometryBytes: number }; rendererInfo: { geometries: number; textures: number }; evictedLayers: string[] }

describe.skipIf(!stagedChrome.ok)('the real viewport frees the superseded tiles and loads them again on demand', () => {
    let page: StagedPage;
    beforeAll(async () => {
        page = await openStagedPage({ manualFrames: true, shotDir: SHOTS });
        serveFixture(page, fixture.glbs, objectIdOf, fixture.sidecar);
        await page.eval(`localStorage.setItem('sb.viewportCost', '1')`);
    });
    afterAll(async () => { await page?.close(); });

    const l1 = () => objectIdOf('l1');
    const breakdown = () => page.eval<Breakdown>('window.__SB_VIEWPORT_COST__.breakdown()');
    const loaded = (id: string) => page.eval<boolean>(`!!window.__SB_3D_EXTERNAL_OBJECTS__?.get(${JSON.stringify(id)})`);
    const layerFrame = (id: string) => page.eval<{ phase: string; hidden: boolean } | null>(`sbHarness.layer(${JSON.stringify(id)})`);
    const tilesBytes = (b: Breakdown) => b.groups.filter(g => g.key.startsWith('tiles:l1')).reduce((a, g) => a + g.geometryBytes, 0);
    /** Steps the page clock past the eviction delay and waits for the loader to drop or re-add `id`. */
    async function settle(id: string, wantLoaded: boolean): Promise<void> {
        for (let i = 0; i < 80 && (await loaded(id)) !== wantLoaded; i++) {
            await page.step(4, 100);
            await new Promise(r => setTimeout(r, 30));
        }
        expect(await loaded(id), `${id} ${wantLoaded ? 'loaded' : 'released'}`).toBe(wantLoaded);
    }

    test('l1 is released once l2 has replaced it; the frame is unchanged; Show replaced layers and Replay build load it again', async () => {
        const st = fixtureState([L('l1'), L('l2')], { runState: 'finished', updatedAtMs: Date.now() - 60_000 });
        await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(st))})`);
        await page.waitFor('sbHarness.ready()');
        await page.waitFor(`sbHarness.attached(${JSON.stringify(objectIdOf('l2'))}) && sbHarness.attached(${JSON.stringify(l1())})`, 30_000, 'both layers attached');
        await page.step(10, STEP);
        expect(await layerFrame(l1())).toMatchObject({ phase: 'revealed', hidden: true });
        const before = await breakdown();
        const beforeMean = await page.eval<{ r: number; g: number; b: number; pixels: number }>('sbHarness.meanColor()');
        expect(tilesBytes(before), 'the hidden tiles hold geometry before eviction').toBeGreaterThan(50_000);
        await page.screenshot('evict_before');

        await settle(l1(), false);
        await page.step(4, STEP);
        const after = await breakdown();
        const afterMean = await page.eval<{ r: number; g: number; b: number; pixels: number }>('sbHarness.meanColor()');
        await page.screenshot('evict_after');
        expect(after.evictedLayers).toEqual([l1()]);
        expect(tilesBytes(after), 'no geometry of the tiles is left').toBe(0);
        expect(before.total.geometryBytes - after.total.geometryBytes).toBe(tilesBytes(before));
        // a settled scene never drew the hidden tiles, so they held CPU arrays only; nothing of them is on the GPU either way
        expect(after.rendererInfo.geometries, 'no GPU buffers left behind').toBeLessThanOrEqual(before.rendererInfo.geometries);
        expect(afterMean.pixels, 'the drawn frame is unchanged').toBe(beforeMean.pixels);
        for (const c of ['r', 'g', 'b'] as const) expect(Math.abs(afterMean[c] - beforeMean[c]), 'the drawn frame is unchanged').toBeLessThan(0.5);
        expect(await layerFrame(l1()), 'still revealed and hidden: nothing waits for it').toMatchObject({ phase: 'revealed', hidden: true });
        expect(await page.eval<boolean>(`!!document.querySelector('[data-testid="sb-staged-overlay"]')`)).toBe(true);

        // Show replaced layers: loaded again, drawn as a ghost.
        await page.eval(`sbHarness.click('[data-testid="sb-staged-show-replaced"]')`);
        await settle(l1(), true);
        await page.waitFor(`sbHarness.attached(${JSON.stringify(l1())})`, 30_000, 'the ghost attached');
        await page.step(20, STEP);
        const ghost = await page.eval<Array<{ visible: boolean; staged: string | null }>>(`sbHarness.meshStates(${JSON.stringify(l1())})`);
        expect(ghost.length).toBeGreaterThan(0);
        expect(ghost.some(m => m.visible && m.staged !== null), 'the reloaded layer is drawn as a ghost').toBe(true);
        expect(tilesBytes(await breakdown())).toBe(tilesBytes(before));
        await page.screenshot('evict_reloaded_ghost');

        // Off again: freed again after the delay.
        await page.eval(`sbHarness.click('[data-testid="sb-staged-show-replaced"]')`);
        await settle(l1(), false);

        // Replay build: loaded, revealed under l2 again, then freed again.
        await page.eval(`sbHarness.click('[data-testid="sb-staged-replay"]')`);
        await settle(l1(), true);
        for (let i = 0; i < 400; i++) {
            const f = await layerFrame(objectIdOf('l2'));
            if (f?.phase === 'revealed') break;
            await page.step(2, 50);
        }
        expect(await layerFrame(objectIdOf('l2'))).toMatchObject({ phase: 'revealed' });
        await page.screenshot('evict_replayed');
        await settle(l1(), false);
        expect(page.consoleErrors().filter(e => !/favicon/i.test(e))).toEqual([]);
    });
});
