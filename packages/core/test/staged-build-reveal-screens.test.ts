/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Every stage of a staged build, revealed in its real build order in the REAL viewport (headless Chrome, real WebGL,
 * the real Scene3DPrimitive loader), with screenshots at reveal progress 0.25, 0.5 and 1.0 (§11.3) and pixel checks:
 * tiles appear leaf by leaf in their recorded download order; the remesh crossfades over them without a hole; the
 * outlines appear per primitive in fit order; the fitted body crossfades in surface by surface; coffers appear cell by
 * cell and sink, the molding runs along its carrier, the relief panel rises; the trees grow from trunk to tips in plant
 * order, after the remesh. Then the provenance toggle (every part shaded by how it was made, legend, background), Stop,
 * an interrupted run, reduced motion, and a failed tree stage putting the scanned trees back.
 * Screenshots: test-results/screenshots/staged/ (gitignored).
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PROVENANCE_BACKGROUND, PROVENANCE, type DegradationRecord, type StagedBuildState } from '../src/common/spatial/staged-location-contracts';
import { hexToRgb01 } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/provenanceShading';
import { buildStagedFixture, fixtureLayer, fixtureState, objectIdOf, FIXTURE_RUN_ID, type FixtureLayerId, type StagedFixtureGlbs } from './helpers/staged-glb-fixture';
import { openStagedPage, serveFixture, stagedChrome, type StagedPage } from './helpers/staged-build-chrome';
import { stagedSceneData } from './helpers/staged-build-scene';

let fixture: StagedFixtureGlbs;
beforeAll(() => { fixture = buildStagedFixture(); });
const L = (l: FixtureLayerId, extra = {}) => fixtureLayer(l, fixture.counts, '/models', extra);
const STEP = 16;

type LayerFrame = { objectId: string; phase: string; progress: number; presence: number; hidden: boolean } | null;

async function layerFrame(page: StagedPage, l: FixtureLayerId): Promise<LayerFrame> {
    return page.eval<LayerFrame>(`sbHarness.layer(${JSON.stringify(objectIdOf(l))})`);
}

/** Steps frames until the layer has reached `p` of its reveal (or finished). */
async function advanceTo(page: StagedPage, l: FixtureLayerId, p: number): Promise<LayerFrame> {
    for (let i = 0; i < 600; i++) {
        const f = await layerFrame(page, l);
        if (f && (f.phase === 'revealed' || (f.phase === 'revealing' && f.progress >= p))) return f;
        await page.step(1, STEP);
    }
    throw new Error(`${l} never reached ${p}: ${JSON.stringify(await layerFrame(page, l))}`);
}

const coverage = async (page: StagedPage) => (await page.eval<{ covered: number }>('sbHarness.coverage()')).covered;
const meshStates = (page: StagedPage, l: FixtureLayerId) => page.eval<Array<{ name: string; visible: boolean; staged: string | null }>>(`sbHarness.meshStates(${JSON.stringify(objectIdOf(l))})`);

async function commit(page: StagedPage, state: StagedBuildState, wait: FixtureLayerId[]): Promise<void> {
    await page.eval(`sbHarness.update(${JSON.stringify(stagedSceneData(state))})`);
    for (const l of wait) await page.waitFor(`sbHarness.attached(${JSON.stringify(objectIdOf(l))})`, 30_000, `${l} attached`);
}

/**
 * Three frames of one layer's reveal (0.25, 0.5, 1.0). A layer that adds geometry never loses coverage on the way; a
 * crossfade (`crossfade`) may end below where it started (it replaces the scanned canopy) but no frame may fall below
 * both ends: that would be a hole where neither layer draws.
 */
async function revealFrames(page: StagedPage, l: FixtureLayerId, name: string, opts: { tolerance?: number; crossfade?: boolean } = {}): Promise<number[]> {
    const tolerance = opts.tolerance ?? 0.005;
    const before = await coverage(page);
    const out: number[] = [];
    for (const p of [0.25, 0.5, 1.0]) {
        await advanceTo(page, l, p);
        if (p === 1.0) await page.step(2, STEP);
        out.push(await coverage(page));
        await page.screenshot(`${name}_${String(Math.round(p * 100)).padStart(3, '0')}`);
    }
    if (opts.crossfade) {
        const floor = Math.min(before, out[2]) * (1 - tolerance);
        for (const c of out) expect(c, `${name}: coverage ${before} → ${out.join(' → ')} (no hole)`).toBeGreaterThanOrEqual(floor);
    } else {
        for (let i = 1; i < out.length; i++) expect(out[i], `${name}: coverage ${out.join(' → ')}`).toBeGreaterThanOrEqual(out[i - 1] * (1 - tolerance));
    }
    return out;
}

function hue(rgb: [number, number, number]): number {
    const [r, g, b] = rgb.map(v => v / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d < 1e-6) return -1;
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
}
const hueDistance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

describe.skipIf(!stagedChrome.ok)('every stage revealed in its real build order (synthetic GLBs built to the contracts)', () => {
    let page: StagedPage;
    beforeAll(async () => {
        page = await openStagedPage({ manualFrames: true });
        serveFixture(page, fixture.glbs, objectIdOf, fixture.sidecar);
    });
    afterAll(async () => { await page?.close(); });

    test('tiles → remesh → outlines → fitted body → detail → trees, then provenance', async () => {
        const empty = fixtureState([], { running: ['tiles'] });
        await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(empty))})`);
        await page.waitFor('sbHarness.ready()');
        await page.step(8, STEP);
        await page.eval('sbHarness.setReference()');
        await page.screenshot('stage0_running_tiles_empty');

        // L1: leaf by leaf, in the recorded download order (the sidecar), not the build (distance) order.
        await commit(page, fixtureState([L('l1')], { running: ['remesh', 'trees-measure'] }), ['l1']);
        await advanceTo(page, 'l1', 0.3);
        const shown = (await meshStates(page, 'l1')).filter(m => m.visible).map(m => m.name);
        const byArrival = Object.entries(fixture.sidecar).sort((a, b) => a[1] - b[1]).map(([leaf]) => leaf);
        expect(shown.length).toBeGreaterThan(0);
        expect(shown.length).toBeLessThan(byArrival.length);
        expect(new Set(shown), `leaves showing ${shown.join(',')} vs arrival order ${byArrival.join(',')}`).toEqual(new Set(byArrival.slice(0, shown.length)));
        await page.eval(`sbHarness.update(${JSON.stringify(stagedSceneData(fixtureState([L('l1')], { running: ['remesh'] })))})`);
        const tiles = await revealFrames(page, 'l1', 'stage1_tiles');
        expect(tiles[0]).toBeGreaterThan(0);
        expect(tiles[0]).toBeLessThan(tiles[2]);

        // L2: the remesh crossfades over the tiles; the complementary dither leaves no hole.
        await commit(page, fixtureState([L('l1'), L('l2')], { running: ['fit', 'trees'] }), ['l2']);
        await revealFrames(page, 'l2', 'stage2_remesh_crossfade', { crossfade: true });
        expect((await meshStates(page, 'l1')).every(m => !m.visible), 'the tiles are hidden once the remesh revealed').toBe(true);
        expect((await layerFrame(page, 'l1'))!.hidden).toBe(true);

        // L3a then L3b: outlines per primitive in fit order, then the fitted body crossfades in surface by surface.
        await commit(page, fixtureState([L('l1'), L('l2'), L('l3a'), L('l3b')], { running: ['vision', 'trees'] }), ['l3a', 'l3b']);
        await page.step(1, STEP);
        expect((await layerFrame(page, 'l3b'))!.phase, 'the body waits for its outlines').toMatch(/held|queued|loading/);
        await revealFrames(page, 'l3a', 'stage3a_outlines', { tolerance: 0.01 });
        await revealFrames(page, 'l3b', 'stage3b_fitted_body', { crossfade: true });
        expect((await meshStates(page, 'l2')).every(m => !m.visible), 'the remesh is hidden under the fitted body').toBe(true);

        // L4: detail. Frame the arch closely to see coffers sink, the molding sweep and the panel rise.
        // From the south and below: the attic panel, the archivolt and up into the soffit's coffers.
        await page.eval(`sbHarness.setCameraView([0, 12.5, 2], { theta: 0.322, phi: 1.96, distance: 17.1 })`);
        await page.step(2, STEP);
        await commit(page, fixtureState([L('l1'), L('l2'), L('l3a'), L('l3b'), L('l4')], { running: ['trees'] }), ['l4']);
        await page.step(1, STEP);
        await page.eval('sbHarness.setReference()');   // detail is measured against the body it lands on
        const detail = await revealFrames(page, 'l4', 'stage4_detail', { crossfade: true, tolerance: 1 });
        expect(detail[2], 'detail changes pixels on the body').toBeGreaterThan(0);
        const soffit = (await meshStates(page, 'l3b')).find(m => m.name === 's-soffit');
        expect(soffit?.visible, 'the soffit the coffers recut is hidden once they revealed').toBe(false);

        // L5: trees grow after the remesh, trunk to tips, staggered in plant order.
        await page.eval(`sbHarness.setCameraView([0, 5, 0], { theta: ${Math.PI / 4}, phi: ${Math.PI / 3.1}, distance: 52 })`);
        await page.step(2, STEP);
        await page.eval('sbHarness.setReference()');
        await commit(page, fixtureState([L('l1'), L('l2'), L('l3a'), L('l3b'), L('l4'), L('l5')], { runState: 'finished' }), ['l5']);
        const trees = await revealFrames(page, 'l5', 'stage5_trees_grow');
        expect(trees[0]).toBeGreaterThan(0);
        expect(trees[0]).toBeLessThan(trees[2] * 0.85);
        await page.step(30, STEP);
        await page.screenshot('stage6_finished');
        const replayButton = await page.eval<boolean>(`!!document.querySelector('[data-testid="sb-staged-replay"]')`);
        expect(replayButton, 'Replay build is offered once the run is over').toBe(true);

        // Provenance: every part shaded by how it was made.
        await page.eval(`sbHarness.click('[data-testid="sb-staged-provenance-toggle"]')`);
        await page.step(4, STEP);
        expect(await page.eval<string | null>('sbHarness.background()')).toBe(PROVENANCE_BACKGROUND.toLowerCase());
        await page.screenshot('provenance_on_synthetic_overview');
        const legendText = await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-legend"]')`);
        expect(legendText).toContain('grown to the measured crown');
        expect(legendText).toContain('fitted');
        const expectHue = async (l: FixtureLayerId, label: string, hex: string) => {
            const nodes = await page.eval<Array<{ node: string; label?: string; samples: Array<{ rgb: [number, number, number] }> }>>(`sbHarness.sampleNodes(${JSON.stringify(objectIdOf(l))})`);
            const mine = nodes.filter(n => (n.label ?? label) === label);
            expect(mine.length, `${label} nodes visible in ${l}`).toBeGreaterThan(0);
            const want = hue(hexToRgb01(hex).map(v => v * 255) as [number, number, number]);
            // Per node, the median hue of points facing the camera, under the scene's lighting.
            const medians = mine.map(n => {
                const hs = n.samples.map(s => hue(s.rgb)).filter(h => h >= 0).sort((a, b) => hueDistance(a, want) - hueDistance(b, want));
                return hs[Math.floor(hs.length / 2)];
            }).filter(h => h !== undefined);
            const near = medians.filter(h => hueDistance(h, want) <= 20).length;
            expect(near / Math.max(1, medians.length), `${label}: node hues ${medians.map(h => h.toFixed(0)).join(',')} vs legend ${want.toFixed(0)}`).toBeGreaterThanOrEqual(0.8);
        };
        await expectHue('l5', PROVENANCE.grownToMeasuredCrown, '#009E73');
        await expectHue('l3b', PROVENANCE.fitted, '#0072B2');
        await page.eval(`sbHarness.setCameraView([0, 12.5, 2], { theta: 0.322, phi: 1.96, distance: 17.1 })`);
        await page.step(3, STEP);
        await page.screenshot('provenance_on_synthetic_detail');
        await expectHue('l4', PROVENANCE.photoInferred, '#CC79A7');

        await page.eval(`sbHarness.click('[data-testid="sb-staged-provenance-toggle"]')`);
        await page.step(4, STEP);
        expect(await page.eval<string | null>('sbHarness.background()')).not.toBe(PROVENANCE_BACKGROUND.toLowerCase());
        for (const l of ['l3b', 'l4', 'l5'] as const) expect((await meshStates(page, l)).every(m => m.staged === null), `${l}: original materials restored`).toBe(true);
        await page.screenshot('provenance_off_synthetic_detail');
    });

    test('the remesh in provenance: displacement bands, relief-inferred and kept-as-scanned vertices', async () => {
        const st = fixtureState([L('l1'), L('l2')], { runState: 'finished' });
        st.layers[1] = { ...st.layers[1], vertexProvenance: { schema: 'scratchbox.vertex-provenance/1', attributes: ['_RECTIFY_DISPLACEMENT', '_PROUD_BLOCK', '_RELIEF_HEIGHT'], vertices: fixture.counts.l2.vertices, rectifyDisplacement: { maxM: 0.09, bands: [{ band: 'untouched', minM: 0, maxM: 0.01, vertices: 1 }, { band: 'moved', minM: 0.01, maxM: 0.05, vertices: 1 }, { band: 'reshaped', minM: 0.05, vertices: 1 }] }, proudBlocks: { keptAsScannedVertices: 1, snappedVertices: 1 }, relief: { carvedVertices: 1, maxAbsHeightM: 0.06 } } };
        await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(st))})`);
        await page.waitFor('sbHarness.ready()');
        for (const l of ['l1', 'l2'] as const) await page.waitFor(`sbHarness.attached(${JSON.stringify(objectIdOf(l))})`);
        await page.step(80, STEP);
        // Close on the south face: the keystone (kept as scanned), the carved attic panel (relief-inferred) and the
        // facade vertices in their displacement bands.
        await page.eval(`sbHarness.setCameraView([0, 12, 4], { theta: 0.42, phi: 1.45, distance: 21 })`);
        await page.eval(`sbHarness.click('[data-testid="sb-staged-provenance-toggle"]')`);
        await page.step(4, STEP);
        await page.screenshot('provenance_remesh_bands_relief_proud');
        const legendText = await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-legend"]')`);
        for (const words of ['untouched', 'moved', 'reshaped', 'relief-inferred', 'kept as scanned']) expect(legendText).toContain(words);
        const nodes = await page.eval<Array<{ samples: Array<{ rgb: [number, number, number] }> }>>(`sbHarness.sampleNodes(${JSON.stringify(objectIdOf('l2'))}, 40)`);
        const hues = nodes.flatMap(n => n.samples.map(s => hue(s.rgb))).filter(h => h >= 0);
        const remeshHue = hue([0x56, 0xb4, 0xe9]), photoHue = hue([0xcc, 0x79, 0xa7]);
        expect(hues.filter(h => hueDistance(h, remeshHue) < 22).length, 'remeshed vertices are in the remeshed hue').toBeGreaterThan(0);
        expect(hues.filter(h => hueDistance(h, photoHue) < 22).length + hues.filter(h => hueDistance(h, remeshHue) < 22).length).toBeGreaterThanOrEqual(hues.length * 0.8);
    });

    test('an entity nobody planned for: an unlisted stage, layer code, kind and label reveal and shade with no code change', async () => {
        // The trees GLB with its stage, reveal kind and provenance label replaced by words no code or legend knows.
        const buf = fixture.glbs.l5;
        const jl = buf.readUInt32LE(12);
        const json = JSON.parse(buf.toString('utf8', 20, 20 + jl));
        const bin = buf.subarray(20 + jl + 8, 20 + jl + 8 + buf.readUInt32LE(20 + jl));
        let changed = 0;
        for (const n of json.nodes ?? []) {
            const sb = n.extras?.sb;
            if (!sb) continue;
            sb.stage = 'geothermal-spore-towers'; sb.revealKind = 'bloom'; sb.provenance.label = 'methane-geyser-inferred';
            changed++;
        }
        expect(changed, 'the fixture trees carry staged node extras').toBeGreaterThan(0);
        let j = Buffer.from(JSON.stringify(json));
        j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
        const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8);
        const jh = Buffer.alloc(8); jh.writeUInt32LE(j.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
        const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
        const alien = Buffer.concat([head, jh, j, bh, bin]);

        const id = objectIdOf('l5');
        const st = fixtureState([L('l5', { revealAfter: [], url: '/models/alien.glb' })], { runState: 'running' });
        const label = 'methane-geyser-inferred', stage = 'geothermal-spore-towers';
        st.layers = st.layers.map(l => ({ ...l, stage, layer: 'l9', provenance: { ...l.provenance, label }, provenanceLabels: [label] }));
        st.stages = st.stages.map(x => (x.stage === 'trees' ? { ...x, stage, title: 'Geothermal spore towers', source: 'grown from the crown measured in the scan' } : x));
        page.serve('alien.glb', alien);
        await page.eval(`sbHarness.mount(${JSON.stringify({ ...stagedSceneData(st), objects: [] })})`);
        await page.waitFor('sbHarness.ready()');
        await page.step(6, STEP);
        await page.eval('sbHarness.setReference()');
        await page.eval(`sbHarness.update(${JSON.stringify(stagedSceneData(st))})`);
        await page.waitFor(`sbHarness.attached(${JSON.stringify(id)})`, 30_000, 'alien layer attached');
        expect(await coverage(page), 'nothing on the first frame after attach').toBe(0);
        const cov: number[] = [];
        for (const p of [0.25, 0.5, 1]) {
            for (let i = 0; i < 400; i++) {
                const f = await page.eval<{ phase: string; progress: number } | null>(`sbHarness.layer(${JSON.stringify(id)})`);
                if (f && (f.phase === 'revealed' || (f.phase === 'revealing' && f.progress >= p))) break;
                await page.step(1, STEP);
            }
            cov.push(await coverage(page));
            await page.screenshot(`alien_entity_grow_${String(Math.round(p * 100)).padStart(3, '0')}`);
        }
        expect(cov[0], `coverage ${cov.join(' → ')}`).toBeGreaterThan(0);
        expect(cov[0]).toBeLessThan(cov[2] * 0.9);
        expect(await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-current"]')`)).toContain('Geothermal spore towers');

        await page.eval(`sbHarness.click('[data-testid="sb-staged-provenance-toggle"]')`);
        await page.step(4, STEP);
        await page.screenshot('alien_entity_provenance');
        const legend = await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-legend"]')`);
        expect(legend, 'an unlisted label gets its own legend row').toContain(label);
        const nodes = await page.eval<Array<{ samples: Array<{ rgb: [number, number, number] }> }>>(`sbHarness.sampleNodes(${JSON.stringify(id)}, 40)`);
        const rgbs = nodes.flatMap(n => n.samples.map(x => x.rgb));
        expect(rgbs.length).toBeGreaterThan(20);
        const neutral = rgbs.filter(([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) < 28).length;
        expect(neutral / rgbs.length, 'an unlisted label is shaded neutral grey').toBeGreaterThanOrEqual(0.9);
    });

    test('a retired layer is out of the scene; Show replaced layers and Replay build bring it back, and both release it again', async () => {
        // The district case: L1 is superseded by the remesh and, being large, left out of the scene at finish (retired).
        const st = fixtureState([L('l1'), L('l2')], { runState: 'finished' });
        st.layers[0] = { ...st.layers[0], retired: true };
        const id1 = objectIdOf('l1'), id2 = objectIdOf('l2');
        expect(stagedSceneData(st).objects, 'the retired layer is not among the scene objects').toHaveLength(1);
        await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(st))})`);
        await page.waitFor('sbHarness.ready()');
        await page.waitFor(`sbHarness.attached(${JSON.stringify(id2)})`);
        await advanceTo(page, 'l2', 1);
        await page.step(4, STEP);
        expect(await page.eval<boolean>(`sbHarness.attached(${JSON.stringify(id1)})`), 'the retired layer was never loaded').toBe(false);
        expect(await page.eval<boolean>(`!!document.querySelector('[data-testid="sb-staged-show-replaced"]')`), 'Show replaced layers is offered').toBe(true);
        await page.screenshot('retired_layer_out_of_scene');

        // Show replaced layers: the retired layer is loaded again and drawn as a ghost under the remesh.
        await page.eval(`sbHarness.click('[data-testid="sb-staged-show-replaced"]')`);
        await page.waitFor(`sbHarness.attached(${JSON.stringify(id1)})`, 30_000, 'retired layer re-added');
        await page.step(60, STEP);
        const ghost = await layerFrame(page, 'l1');
        expect(ghost!.hidden, 'a superseded layer stays superseded').toBe(true);
        const states = await meshStates(page, 'l1');
        expect(states.some(m => m.visible), 'the ghost is drawn').toBe(true);
        expect(states.filter(m => m.visible).every(m => m.staged !== null), 'the ghost carries the staged material').toBe(true);
        await page.screenshot('retired_layer_ghost');

        // Off again: the layer leaves the scene (the loader releases it) and the remesh is untouched.
        await page.eval(`sbHarness.click('[data-testid="sb-staged-show-replaced"]')`);
        await page.step(30, STEP);
        await page.waitFor(`!sbHarness.attached(${JSON.stringify(id1)})`, 30_000, 'retired layer released');
        expect((await layerFrame(page, 'l2'))!.phase).toBe('revealed');

        // Replay build re-adds it too, reveals every layer from 0 again, and releases it when the replay is over.
        await page.eval(`sbHarness.click('[data-testid="sb-staged-replay"]')`);
        await page.waitFor(`sbHarness.attached(${JSON.stringify(id1)})`, 30_000, 'retired layer re-added for replay');
        const trace: string[] = [];
        for (let i = 0; i < 6; i++) { await page.step(1, STEP); const a = await layerFrame(page, 'l1'), b = await layerFrame(page, 'l2'); trace.push(`${a?.phase}/${a?.progress.toFixed(2)} ${b?.phase}/${b?.progress.toFixed(2)}`); }
        const replaying = await layerFrame(page, 'l2');
        expect(replaying!.phase, `the replay starts the remesh again: ${trace.join(' | ')}`).toMatch(/revealing|queued|held/);
        await page.screenshot('retired_layer_replay_start');
        await advanceTo(page, 'l2', 1);
        await page.step(200, STEP);
        await page.waitFor(`!sbHarness.attached(${JSON.stringify(id1)})`, 30_000, 'retired layer released after the replay');
        expect((await layerFrame(page, 'l2'))!.phase).toBe('revealed');
    });

    test('Stop, an interrupted run and a failed tree stage that puts the scanned trees back', async () => {
        // A run stopped after the fit: every committed layer at its end state at once, nothing animating.
        const stopped = fixtureState([L('l1'), L('l2'), L('l3a'), L('l3b')], { runState: 'stopped', stageStatus: { vision: 'stopped', detail: 'stopped', trees: 'stopped' } });
        await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(stopped))})`);
        await page.waitFor('sbHarness.ready()');
        for (const l of ['l1', 'l2', 'l3a', 'l3b'] as const) await page.waitFor(`sbHarness.attached(${JSON.stringify(objectIdOf(l))})`);
        await page.step(2, STEP);
        for (const l of ['l2', 'l3a', 'l3b'] as const) expect((await layerFrame(page, l))!.phase).toBe('revealed');
        const runText = await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-runstate"]')`);
        expect(runText).toMatch(/^Stopped\. .*Scan-fitted rebuild.* stay in the scene\. Not built: .*Trees/);
        await page.screenshot('state_stopped_after_fit');

        // Interrupted: a running state saved before this page loaded (a reload after a crash).
        const interrupted = fixtureState([L('l1'), L('l2')], { runState: 'running', updatedAtMs: Date.now() - 3_600_000, running: ['fit'] });
        await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(interrupted))})`);
        for (const l of ['l1', 'l2'] as const) await page.waitFor(`sbHarness.attached(${JSON.stringify(objectIdOf(l))})`);
        await page.step(2, STEP);
        expect((await layerFrame(page, 'l2'))!.phase).toBe('revealed');
        expect(await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-runstate"]')`)).toMatch(/^Interrupted\./);
        await page.screenshot('state_interrupted_reloaded');

        // The tree stage failed: the scanned crowns are put back (l5x, as scanned), listed with their reason.
        const trees: DegradationRecord = {
            id: 'd-trees', stage: 'trees', part: { description: 'the 5 measured trees around the structure', objectId: objectIdOf('l5x') },
            intended: 'trees grown to the measured crown', fellTo: 'the scanned trees put back', provenanceAfter: PROVENANCE.asScanned,
            reasonCode: 'trees_failed', reason: 'tile_vegetation plant exited with code 134; the scanned trees were put back as scanned.',
            transient: true, retry: { tool: 'google_3d_tiles_get_clay', args: { retryRunId: FIXTURE_RUN_ID, retryStage: 'trees' }, reuses: ['tiles', 'remesh'] }, atMs: Date.now()
        };
        const degraded = fixtureState([L('l1'), L('l2'), L('l3a'), L('l3b'), L('l5x')], { runState: 'finished', degradations: [trees], stageStatus: { trees: 'degraded', vision: 'skipped', detail: 'skipped' } });
        await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(degraded))})`);
        for (const l of ['l2', 'l3b', 'l5x'] as const) await page.waitFor(`sbHarness.attached(${JSON.stringify(objectIdOf(l))})`);
        // To the end state (a screenshot of a half-faded layer would show the dither, not the put-back trees).
        await advanceTo(page, 'l5x', 1);
        await page.step(4, STEP);
        expect((await layerFrame(page, 'l5x'))!.phase, 'the put-back trees are fully revealed').toBe('revealed');
        await page.eval(`sbHarness.click('[data-testid="sb-staged-degraded-toggle"]')`);
        await page.step(2, STEP);
        const list = await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-degraded-list"]')`);
        expect(list).toContain('the 5 measured trees around the structure → the scanned trees put back');
        expect(list).toContain('exited with code 134');
        await page.screenshot('state_trees_failed_scanned_put_back');
        await page.eval(`sbHarness.click('[data-testid="sb-staged-provenance-toggle"]')`);
        await page.step(4, STEP);
        await page.screenshot('state_trees_failed_provenance');
        const put = await page.eval<Array<{ node: string; label?: string; samples: Array<{ rgb: [number, number, number] }> }>>(`sbHarness.sampleNodes(${JSON.stringify(objectIdOf('l5x'))}, 30)`);
        const hues = put.flatMap(n => n.samples.map(s => hue(s.rgb))).filter(h => h >= 0);
        const asScanned = hue([0xe6, 0x9f, 0x00]), vermillion = hue([0xd5, 0x5e, 0x00]);
        expect(hues.length).toBeGreaterThan(0);
        expect(hues.filter(h => hueDistance(h, asScanned) < 18 || hueDistance(h, vermillion) < 12).length / hues.length, `hues ${hues.map(h => h.toFixed(0))}`).toBeGreaterThanOrEqual(0.8);
        // Retry sends the exact args of the record as a chat prompt.
        await page.eval(`(() => { const b = [...document.querySelectorAll('[data-testid="sb-staged-overlay"] button')].find(x => x.textContent.startsWith('Retry')); b && b.click(); })()`);
        await page.step(1, STEP);
        const prompts = await page.eval<string[]>('sbHarness.prompts()');
        expect(prompts.at(-1)).toBe(`Retry the Trees stage: call google_3d_tiles_get_clay with {"retryRunId":"${FIXTURE_RUN_ID}","retryStage":"trees"}`);
    });
});

describe.skipIf(!stagedChrome.ok)('reduced motion', () => {
    test('every committed layer shows its end state at once (end frame only)', async () => {
        const page = await openStagedPage({ manualFrames: true, reducedMotion: true });
        try {
            serveFixture(page, fixture.glbs, objectIdOf, fixture.sidecar);
            const st = fixtureState([L('l1'), L('l2'), L('l3a'), L('l3b'), L('l4'), L('l5')], { running: [] });
            await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(st))})`);
            for (const l of ['l1', 'l2', 'l3a', 'l3b', 'l4', 'l5'] as const) await page.waitFor(`sbHarness.attached(${JSON.stringify(objectIdOf(l))})`);
            await page.step(2, STEP);
            for (const l of ['l2', 'l3a', 'l3b', 'l4', 'l5'] as const) {
                const f = await layerFrame(page, l);
                expect(f!.phase, `${l}`).toBe('revealed');
            }
            await page.screenshot('state_reduced_motion_end_frame');
        } finally {
            await page.close();
        }
    });
});
