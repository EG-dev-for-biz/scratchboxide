/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The reveal through the REAL loader (design §7.2, §11.3), in headless Chrome with real WebGL: the loader swaps every
 * mesh to fresh clay right after attaching a model, so the per-frame guard must patch before projection.
 *  - In clay mode, the first frame after the loader attaches a layer covers 0 pixels; coverage then never decreases
 *    over progress 0.25, 0.5, 1.0, and at 1.0 equals a plain (unstaged) render of the same layer within 0.5%.
 *  - Toggling clay/shaded in mid-reveal never draws a frame at full coverage.
 *  - After a user orbit, the camera does not move across the next three layer attaches.
 *  - Stage patches applied from streamed StageEvents name the running stage and its source in the overlay.
 * Screenshots go to test-results/screenshots/staged/ (gitignored).
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildStagedFixture, fixtureLayer, fixtureState, objectIdOf, FIXTURE_RUN_ID, type StagedFixtureGlbs } from './helpers/staged-glb-fixture';
import { openStagedPage, serveFixture, stagedChrome, type StagedPage } from './helpers/staged-build-chrome';
import { stagedSceneData } from './helpers/staged-build-scene';
import { PACED_REVEAL_DWELL_MS } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/revealScheduler';
import type { StageEvent } from '../src/common/spatial/staged-location-contracts';

let fixture: StagedFixtureGlbs;
beforeAll(() => { fixture = buildStagedFixture(); });

const BASE = '/models';
const L = (l: Parameters<typeof fixtureLayer>[0], extra = {}) => fixtureLayer(l, fixture.counts, BASE, extra);
const STEP = 16;

async function coverage(page: StagedPage): Promise<number> {
    return (await page.eval<{ covered: number }>('sbHarness.coverage()')).covered;
}

/** Frames until the layer's root is attached by the loader (the frame loop itself must run for that). */
async function untilAttached(page: StagedPage, id: string): Promise<void> {
    await page.waitFor(`sbHarness.attached(${JSON.stringify(id)})`, 30_000, `${id} attached`);
}

describe.skipIf(!stagedChrome.ok)('staged reveal through the real loader', () => {
    let page: StagedPage;
    afterAll(async () => { await page?.close(); });

    test('clay: 0 pixels on the first frame after attach, monotone coverage, end state equals the plain render', async () => {
        page = await openStagedPage({ manualFrames: true });
        const served = serveFixture(page, fixture.glbs, objectIdOf, fixture.sidecar, ['l1', 'sidecar']);
        const state = fixtureState([L('l1')], { running: ['remesh'] });
        await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(state))})`);
        await page.waitFor('sbHarness.ready()');
        await page.step(6, STEP);
        await page.eval('sbHarness.setReference()');
        await page.screenshot('loader_path_reference_empty');
        expect(await coverage(page)).toBe(0);

        served.l1.release();
        // The loader attaches the model asynchronously, between frames.
        await untilAttached(page, objectIdOf('l1'));
        await page.step(1, STEP);
        const first = await coverage(page);
        await page.screenshot('loader_path_first_frame_after_attach');
        expect(first, 'the first frame after the loader attached the layer covers no pixels').toBe(0);
        // Its download-order sidecar is still on its way: the layer waits hidden, never drawn unpatched.
        await page.step(30, STEP);
        expect(await coverage(page), 'attached but waiting for its order sidecar').toBe(0);
        served.sidecar.release();
        await page.waitFor(`fetch('/models/${objectIdOf('l1')}.order.json').then(r => r.ok)`, 10_000, 'the sidecar');
        await page.step(1, STEP);
        expect(await coverage(page), 'the reveal starts at progress 0').toBe(0);

        // Reveal: 800 ms for tiles, held to the pacing dwell as the first reveal. Progress counts from the frame the layer became ready.
        const at = async (p: number) => { await page.step(Math.round((Math.max(800, PACED_REVEAL_DWELL_MS) * p) / STEP), STEP); return coverage(page); };
        const c0 = await coverage(page);
        const c25 = await at(0.25);
        await page.screenshot('loader_path_tiles_025');
        const c50 = await at(0.25);
        await page.screenshot('loader_path_tiles_050');
        const c100 = await at(0.6);
        await page.screenshot('loader_path_tiles_100');
        expect(c25).toBeGreaterThanOrEqual(c0);
        expect(c50).toBeGreaterThanOrEqual(c25);
        expect(c100).toBeGreaterThanOrEqual(c50);
        expect(c25).toBeGreaterThan(0);
        expect(c50).toBeLessThan(c100);
        const states = await page.eval<Array<{ staged: string | null; visible: boolean }>>(`sbHarness.meshStates(${JSON.stringify(objectIdOf('l1'))})`);
        await page.step(4, STEP);
        // the remesh stage is still running: the revealed tiles wear the work sweep (a staged material), every leaf showing
        const sweeping = await page.eval<Array<{ staged: string | null; visible: boolean }>>(`sbHarness.meshStates(${JSON.stringify(objectIdOf('l1'))})`);
        expect(sweeping.every(s => s.staged !== null && s.visible), 'while a stage runs the revealed layer carries the work sweep').toBe(true);
        // the band itself: pixels of the accent (#A5B4FC, mixed into the clay) appear on the model, and move between frames
        const accent: number[] = [];
        const moved: number[] = [];
        for (let i = 0; i < 12; i++) {
            accent.push(await page.eval<number>('sbHarness.tinted(165, 180, 252, 14)'));
            await page.eval(`sbHarness.keepFrame('sweep-${i}')`);
            if (i > 0) moved.push((await page.eval<{ differing: number } | null>(`sbHarness.frameDiff('sweep-${i - 1}', 'sweep-${i}', 8)`))?.differing ?? -1);
            await page.step(4, STEP);
        }
        const uniforms = JSON.stringify((await page.eval<unknown[]>(`sbHarness.workUniforms(${JSON.stringify(objectIdOf('l1'))})`)).slice(0, 2));
        expect(Math.max(...accent), `accent pixels per frame: ${accent.join(', ')}; changed: ${moved.join(', ')}; uniforms: ${uniforms}`).toBeGreaterThan(50);
        expect(Math.max(...moved), `the band moves: pixels changed between frames ${moved.join(', ')}`).toBeGreaterThan(50);
        await page.screenshot('loader_path_tiles_work_sweep');
        // no stage running any more: the original clay is back
        await page.eval(`sbHarness.update(${JSON.stringify(stagedSceneData(fixtureState([L('l1')], { runState: 'running' })))})`);
        await page.step(4, STEP);
        const after = await page.eval<Array<{ staged: string | null; visible: boolean }>>(`sbHarness.meshStates(${JSON.stringify(objectIdOf('l1'))})`);
        expect(after.every(s => s.staged === null && s.visible), 'after the reveal, with no stage running, the original clay is back and every leaf shows').toBe(true);
        expect(states.length).toBe(after.length);

        // The same layer as a plain scene (no staged build): the static render, against an empty scene's frame.
        await page.eval('sbHarness.unmount()');
        await page.eval(`sbHarness.mount(${JSON.stringify({ ...stagedSceneData(state, { plain: true }), objects: [] })})`);
        await page.waitFor('sbHarness.ready()');
        await page.step(6, STEP);
        await page.eval('sbHarness.setReference()');
        await page.eval(`sbHarness.update(${JSON.stringify(stagedSceneData(state, { plain: true }))})`);
        await untilAttached(page, objectIdOf('l1'));
        await page.step(4, STEP);
        const plain = await coverage(page);
        await page.screenshot('loader_path_tiles_plain_static');
        expect(Math.abs(c100 - plain) / plain, `staged end state ${c100} px vs plain ${plain} px`).toBeLessThanOrEqual(0.005);
    });

    test('toggling clay and shaded mid-reveal never draws a frame at full coverage', async () => {
        await page.eval('sbHarness.unmount()');
        const state = fixtureState([L('l1'), L('l2'), L('l5', { revealAfter: [] })], { runState: 'running' });
        const empty = { ...stagedSceneData(state), objects: [] };
        await page.eval(`sbHarness.mount(${JSON.stringify(empty)})`);
        await page.waitFor('sbHarness.ready()');
        await page.step(6, STEP);
        await page.eval('sbHarness.setReference()');
        // Trees alone (no dependency), 1500 ms reveal; first the full coverage of the plain trees.
        const trees = fixtureState([L('l5', { revealAfter: [] })], { runState: 'running' });
        await page.eval(`sbHarness.update(${JSON.stringify(stagedSceneData(trees, { plain: true }))})`);
        await untilAttached(page, objectIdOf('l5'));
        await page.step(4, STEP);
        const full = await coverage(page);
        expect(full).toBeGreaterThan(500);
        await page.eval('sbHarness.unmount()');
        await page.eval(`sbHarness.mount(${JSON.stringify(empty)})`);
        await page.waitFor('sbHarness.ready()');
        await page.step(6, STEP);
        await page.eval('sbHarness.setReference()');
        await page.eval(`sbHarness.update(${JSON.stringify(stagedSceneData(trees))})`);
        await untilAttached(page, objectIdOf('l5'));
        const seen: number[] = [];
        for (let i = 0; i < 40; i++) {
            if (i === 10 || i === 22) {
                const mode = i === 10 ? 'shaded' : 'clay';
                await page.eval(`sbHarness.update(${JSON.stringify(stagedSceneData(trees, { renderMode: mode }))})`);
            }
            await page.step(1, STEP);
            seen.push(await coverage(page));
            if (i === 12) await page.screenshot('loader_path_trees_after_shaded_toggle');
        }
        // Progress after 40 frames of 16 ms is 640/1500 = 0.43: no frame may reach the full tree coverage.
        expect(Math.max(...seen), `frames ${seen.join(',')}`).toBeLessThan(full * 0.9);
        // Between toggles the trees only grow (a toggle changes their colour, so its frame is not compared).
        for (let i = 1; i < seen.length; i++) if (i !== 10 && i !== 22) expect(seen[i], `frame ${i}`).toBeGreaterThanOrEqual(seen[i - 1] * 0.995);
    });

    test('toggling provenance mid-reveal keeps the reveal: every drawn mesh is patched, no frame reaches full coverage', async () => {
        // The remesh alone (no crossfade source), fading in as one unit over 1.5 s: a patched provenance material must keep fading.
        const SOLO = { revealAfter: [], supersedes: [], reveal: { durationMs: 1500, stagger: 0, crossfadeFrom: [] } };
        const TOGGLE = '[data-testid="sb-staged-provenance-toggle"]';
        const running = fixtureState([L('l2', SOLO)], { runState: 'running' });
        const stopped = fixtureState([L('l2', SOLO)], { runState: 'stopped' });
        const empty = { ...stagedSceneData(running), objects: [] };
        // The reference is the provenance background with no trees, so coverage can be read with provenance on.
        const reference = async () => {
            await page.eval('sbHarness.unmount()');
            await page.eval(`sbHarness.mount(${JSON.stringify(empty)})`);
            await page.waitFor('sbHarness.ready()');
            await page.eval(`sbHarness.click('${TOGGLE}')`);
            await page.step(4, STEP);
            await page.eval('sbHarness.setReference()');
        };
        // Full coverage with provenance on: the run stopped, so the trees show their end state at once.
        await reference();
        await page.eval(`sbHarness.update(${JSON.stringify(stagedSceneData(stopped))})`);
        await untilAttached(page, objectIdOf('l2'));
        await page.step(6, STEP);
        const full = await coverage(page);
        expect(full).toBeGreaterThan(500);

        // The running reveal, provenance switched on at frame 8 and off at frame 28.
        await reference();
        await page.eval(`sbHarness.click('${TOGGLE}')`);
        await page.step(4, STEP);
        await page.eval(`sbHarness.update(${JSON.stringify(stagedSceneData(running))})`);
        await untilAttached(page, objectIdOf('l2'));
        const on: number[] = [];
        for (let i = 0; i < 40; i++) {
            if (i === 8 || i === 28) await page.eval(`sbHarness.click('${TOGGLE}')`);
            await page.step(1, STEP);
            if (i >= 10 && i < 28) {
                on.push(await coverage(page));
                const unpatched = (await page.eval<Array<{ visible: boolean; staged: string | null }>>(`sbHarness.meshStates(${JSON.stringify(objectIdOf('l2'))})`)).filter(m => m.visible && m.staged === null);
                expect(unpatched.length, `frame ${i}: drawn meshes without the staged material`).toBe(0);
            }
            if (i === 18) await page.screenshot('loader_path_provenance_toggled_mid_reveal');
        }
        expect(Math.max(...on), `frames ${on.join(',')}`).toBeLessThan(full * 0.9);
        expect(on[0], 'the reveal has started').toBeGreaterThan(0);
        for (let i = 1; i < on.length; i++) expect(on[i], `frame ${i + 10}`).toBeGreaterThanOrEqual(on[i - 1] * 0.995);
        expect(await page.eval<string | null>('sbHarness.background()'), 'provenance off again: the background is back').not.toBe('#1c2026');
    });

    test('after a user orbit the camera stays put across the next three layer attaches; streamed events name the stage', async () => {
        await page.eval('sbHarness.unmount()');
        let state = fixtureState([L('l1')], { running: ['remesh'] });
        await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(state))})`);
        await page.waitFor('sbHarness.ready()');
        await untilAttached(page, objectIdOf('l1'));
        await page.step(60, STEP);
        const before = await page.eval<number[]>('sbHarness.camera()');
        await page.drag([700, 380], [560, 330]);
        await page.step(4, STEP);
        const orbited = await page.eval<number[]>('sbHarness.camera()');
        expect(Math.hypot(orbited[0] - before[0], orbited[2] - before[2]), 'the drag orbited the camera').toBeGreaterThan(0.5);

        // A running stage arrives as a StageEvent alone (no artifact): the overlay names it and its source.
        const ev: StageEvent = {
            schema: 'scratchbox.stage-event/2', runId: FIXTURE_RUN_ID, seq: 3, stage: 'remesh', order: 2, status: 'running',
            title: 'Remeshed scan', source: 'tile_refine: rectify and flatten 3,107 vertices', progress: 0.4, message: 'flattening facades',
            degradations: [], timings: { startedAtMs: Date.now(), cached: false }
        };
        await page.eval(`sbHarness.publishStageEvent(${JSON.stringify(ev)})`);
        await page.step(20, STEP);
        const current = await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-current"]')`);
        const source = await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-source"]')`);
        expect(current).toContain('Remeshed scan');
        expect(current).toContain('running');
        expect(source).toBe('tile_refine: rectify and flatten 3,107 vertices');
        expect(await page.eval<string>(`document.querySelector('[data-testid="sb-staged-overlay"]').innerText`)).toContain('40% · flattening facades');
        await page.screenshot('loader_path_running_stage_from_event');

        const cams: number[][] = [];
        for (const next of [['l1', 'l2'], ['l1', 'l2', 'l3a', 'l3b'], ['l1', 'l2', 'l3a', 'l3b', 'l5']] as const) {
            state = fixtureState(next.map(l => L(l)), { running: [] });
            await page.eval(`sbHarness.update(${JSON.stringify(stagedSceneData(state))})`);
            await untilAttached(page, objectIdOf(next[next.length - 1]));
            await page.step(30, STEP);
            cams.push(await page.eval<number[]>('sbHarness.camera()'));
        }
        for (const c of cams) expect(Math.hypot(c[0] - orbited[0], c[1] - orbited[1], c[2] - orbited[2])).toBeLessThan(1e-6);
        await page.step(200, STEP);
        await page.screenshot('loader_path_camera_after_three_attaches');
        expect(page.consoleErrors().filter(e => !/favicon|404|Failed to load resource/i.test(e))).toEqual([]);
    });
});
