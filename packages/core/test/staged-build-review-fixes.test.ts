/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The review of the staged-build viewport, one test group per finding:
 *  1. every streamed StageEvent re-renders the viewport (not only the first of a run);
 *  2. the scene artifact is the authority over older streamed events (a retired layer stays retired);
 *  3. every degraded part is placed on what is drawn, and the overlay says when it is not;
 *  4. Retry is offered only when the run is over;
 *  5. the finished-run sentence and the stage chips say what fell, what was skipped and why.
 * The Chrome groups mount the real Scene3DPrimitive with its loader and the staged-build hook and look at pixels.
 * Screenshots go to test-results/screenshots/staged/ (gitignored).
 */

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PROVENANCE, type DegradationRecord, type StageEvent, type StageStatus, type StagedBuildState, type StagedLayer } from '../src/common/spatial/staged-location-contracts';
import { StagedBuildOverlay, type StagedBuildOverlayProps } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/StagedBuildOverlay';
import { placeDegradations, type PlacementRoot } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/degradationPlacement';
import { legendRows, resolveLegend } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/provenanceShading';
import { publishStageEvent, stageEventsFor, subscribeStageEvents, withStreamedEvents } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/stagedBuildState';
import { visionModelUse } from './helpers/staged-location-fixtures';
import { buildStagedFixture, fixtureLayer, fixtureState, objectIdOf, FIXTURE_RUN_ID, type FixtureLayerId, type StagedFixtureGlbs } from './helpers/staged-glb-fixture';
import { openStagedPage, serveFixture, stagedChrome, type StagedPage } from './helpers/staged-build-chrome';
import { stagedSceneData } from './helpers/staged-build-scene';
import { patchGlbJson } from './helpers/staged-glb-patch';

let fixture: StagedFixtureGlbs;
beforeAll(() => { fixture = buildStagedFixture(); });
const L = (l: FixtureLayerId, extra: Partial<StagedLayer> = {}) => fixtureLayer(l, fixture.counts, '/models', extra);
const STEP = 16;

/** The state of a run with its own id, so events published by one test never reach another's viewport. */
const runOf = (runId: string, state: StagedBuildState): StagedBuildState => ({ ...state, runId, artifactId: `scene-stg-${runId}` });

const T0 = Date.now();

function event(runId: string, seq: number, stage: string, status: StageStatus, extra: Partial<StageEvent> = {}): StageEvent {
    const s = fixtureState([]).stages.find(x => x.stage === stage)!;
    return {
        schema: 'scratchbox.stage-event/2', runId, seq, stage, order: s.order, status, title: s.title, source: s.source,
        degradations: [], timings: { startedAtMs: T0 + seq, cached: false, ...(status === 'running' ? {} : { endedAtMs: T0 + seq + 1000, ms: 1000 }) }, ...extra
    };
}

const degradation = (id: string, over: Partial<DegradationRecord> & Pick<DegradationRecord, 'stage' | 'part'>): DegradationRecord => ({
    intended: 'photo-inferred detail', fellTo: 'the flat fitted face', provenanceAfter: PROVENANCE.fitted, reasonCode: 'vision_unavailable',
    reason: `reason of ${id}`, transient: false, atMs: Date.now(), id, ...over
});

// -------------------------------------------------------------------------------------------------------------------
// 1. Every streamed event reaches the viewport
// -------------------------------------------------------------------------------------------------------------------

describe('finding 1: every streamed StageEvent re-renders the viewport', () => {
    test('each event is a new list, so React state holding the previous one changes five times for five events', () => {
        const runId = 'feed0001';
        let held = stageEventsFor(runId);
        let changes = 0;
        const off = subscribeStageEvents(e => {
            if (e.runId !== runId) return;
            const next = stageEventsFor(runId);
            if (!Object.is(next, held)) { changes++; held = next; }
        });
        const snapshots: Array<readonly StageEvent[]> = [];
        for (let i = 1; i <= 5; i++) {
            publishStageEvent(event(runId, i, 'remesh', 'running', { progress: i / 5, message: `step ${i}` }));
            snapshots.push(stageEventsFor(runId));
        }
        off();
        expect(changes, 'React bails out of a state update whose value is the same array').toBe(5);
        expect(snapshots.map(s => s.length), 'an earlier list is never written to afterwards').toEqual([1, 2, 3, 4, 5]);
        expect(new Set(snapshots).size).toBe(5);
    });
});

// -------------------------------------------------------------------------------------------------------------------
// 2. The artifact is the authority over older events
// -------------------------------------------------------------------------------------------------------------------

describe('finding 2: streamed events fill in only what the scene artifact does not hold', () => {
    const run = 'feed0002';
    const finished = (): StagedBuildState => {
        const st = runOf(run, fixtureState([L('l1'), L('l2')], { runState: 'finished' }));
        st.layers[0] = { ...st.layers[0], retired: true };
        return st;
    };

    test('a commit event\'s older copy of a layer does not un-retire the layer the finish artifact retired', () => {
        const events = [
            event(run, 2, 'tiles', 'committed', { layers: [L('l1')], patch: { upsertObjects: [objectIdOf('l1')], removeObjects: [], supersede: [] } }),
            event(run, 4, 'remesh', 'committed', { layers: [L('l2')], patch: { upsertObjects: [objectIdOf('l2')], removeObjects: [], supersede: [] } })
        ];
        const effective = withStreamedEvents(finished(), events);
        expect(effective.layers.find(l => l.objectId === objectIdOf('l1'))!.retired, 'the artifact says retired').toBe(true);
        expect(effective.layers.filter(l => l.retired).map(l => l.objectId)).toEqual([objectIdOf('l1')]);
        expect(effective.layers).toHaveLength(2);
    });

    test('an event that leads its artifact still adds the layer, the stage and the degradation the artifact lacks', () => {
        const artifact = runOf(run, fixtureState([L('l1')], { runState: 'running', running: ['remesh'] }));
        const dropped = degradation('d-lead', { stage: 'remesh', part: { description: 'the structure' } });
        const lead = event(run, 5, 'remesh', 'degraded', { layers: [L('l2')], degradations: [dropped], message: 'the raw scan flattened instead', patch: { upsertObjects: [objectIdOf('l2')], removeObjects: [], supersede: [] } });
        const effective = withStreamedEvents(artifact, [lead]);
        expect(effective.layers.map(l => l.objectId)).toEqual([objectIdOf('l1'), objectIdOf('l2')]);
        expect(effective.stages.find(s => s.stage === 'remesh')).toMatchObject({ status: 'degraded', reason: 'the raw scan flattened instead', degradationIds: ['d-lead'] });
        expect(effective.degradations.map(d => d.id)).toEqual(['d-lead']);
    });

    test('a stage the artifact already ended is not rewritten by an event of the same rank; a degradation it holds keeps its copy', () => {
        const held = degradation('d-held', { stage: 'vision', part: { description: 'facade detail' }, reason: 'the newer artifact\'s reason' });
        const artifact = runOf(run, fixtureState([L('l1'), L('l2')], { runState: 'finished', degradations: [held], stageStatus: { vision: 'degraded' } }));
        const olderCopy = event(run, 3, 'vision', 'degraded', { degradations: [{ ...held, reason: 'an older reason' }], message: 'older message', title: 'An older title' });
        const effective = withStreamedEvents(artifact, [olderCopy]);
        expect(effective.degradations.find(d => d.id === 'd-held')!.reason).toBe('the newer artifact\'s reason');
        expect(effective.stages.find(s => s.stage === 'vision')!.title).toBe('Reading the photos');
        expect(effective).toEqual(artifact);
    });

    test('a running event still refreshes a running stage; a stale running event never undoes a commit; the artifact\'s vision model wins', () => {
        const artifact = runOf(run, fixtureState([L('l1')], { runState: 'running', running: ['remesh'], visionModel: visionModelUse('answered') }));
        const tick = event(run, 6, 'remesh', 'running', { progress: 0.7, message: 'flattening', source: 'tile_refine: flattening 70%', model: { ...visionModelUse('answered'), used: 'an older model' } });
        const refreshed = withStreamedEvents(artifact, [tick]);
        expect(refreshed.stages.find(s => s.stage === 'remesh')!.source).toBe('tile_refine: flattening 70%');
        expect(refreshed.visionModel!.used, 'the artifact\'s own model record').toBe(visionModelUse('answered').used);
        const committed = runOf(run, fixtureState([L('l1'), L('l2')], { runState: 'running' }));
        expect(withStreamedEvents(committed, [event(run, 2, 'remesh', 'running', { progress: 0.1 })]).stages.find(s => s.stage === 'remesh')!.status).toBe('committed');
    });

    test('an event\'s removal never takes away a layer the artifact holds', () => {
        const artifact = finished();
        const removal = event(run, 8, 'tiles', 'running', { patch: { upsertObjects: [], removeObjects: [objectIdOf('l1')], supersede: [] } });
        // The tiles stage is committed in the artifact, so the running event does not apply at all; a later-ranked one removes nothing it holds.
        const later = event(run, 9, 'fit', 'committed', { patch: { upsertObjects: [], removeObjects: [objectIdOf('l1')], supersede: [] } });
        expect(withStreamedEvents(artifact, [removal, later]).layers.map(l => l.objectId)).toEqual([objectIdOf('l1'), objectIdOf('l2')]);
    });
});

// -------------------------------------------------------------------------------------------------------------------
// 3. Where a degraded part is
// -------------------------------------------------------------------------------------------------------------------

describe('finding 3: a degraded part is placed on the nodes that show it', () => {
    interface N { name: string; ids: PlacementRoot['nodes'][number]['ids']; provenance: { label: string } }
    const node = (name: string, label: string, ids: N['ids'] = {}): N => ({ name, ids, provenance: { label } });
    const root = (l: FixtureLayerId, nodes: N[], extra: Partial<PlacementRoot<N>> = {}): PlacementRoot<N> => ({ layer: L(l), showing: true, nodes, ...extra }) as PlacementRoot<N>;
    const fitted = () => root('l3b', [node('s-attic', PROVENANCE.fitted, { surfaceId: 's-attic', primitiveId: 'p-attic' }), node('s-soffit', PROVENANCE.fitted, { surfaceId: 's-soffit', primitiveId: 'p-vault' })]);
    const detail = () => root('l4', [node('e001', PROVENANCE.photoInferred, { elementId: 'e001', slotId: 'S03', surfaceId: 's-soffit' }), node('e002', PROVENANCE.photoInferred, { elementId: 'e002', slotId: 'S07' })]);
    const names = (roots: Array<PlacementRoot<N>>, d: DegradationRecord) => placeDegradations(roots, [d]).get(d.id)!.nodes.map(n => (n as unknown as N).name);

    test('a node that names the record is the part, whatever ids the record carries', () => {
        const outline = node('outline-slot', PROVENANCE.fitted, { slotId: 'S09', degradationId: 'd-el-e014' });
        const d = degradation('d-el-e014', { stage: 'detail', part: { description: 'element e014', elementId: 'e014' } });
        const p = placeDegradations([root('l3a', [outline, node('outline-other', PROVENANCE.fitted, { slotId: 'S10' })]), detail()], [d]).get(d.id)!;
        expect(p).toMatchObject({ tier: 'degradation-id', scope: 'part' });
        expect(p.nodes).toEqual([outline]);
    });

    test('a record that names a layer shades that layer; one that names ids shades the nodes carrying them all', () => {
        expect(names([fitted(), detail()], degradation('d-l', { stage: 'detail', part: { description: 'the detail', objectId: objectIdOf('l4') } }))).toEqual(['e001', 'e002']);
        expect(names([fitted(), detail()], degradation('d-i', { stage: 'detail', part: { description: 'e002', elementId: 'e002', slotId: 'S07' } }))).toEqual(['e002']);
        expect(placeDegradations([fitted()], [degradation('d-missing-layer', { stage: 'detail', part: { description: 'x', objectId: 'not-loaded' } })]).get('d-missing-layer')!.tier).toBe('unplaced');
    });

    test('a dropped element is shown by the flat face it would have sat on, not by a healthy element on the same surface', () => {
        const d = degradation('d-drop', { stage: 'detail', part: { description: 'element e014', elementId: 'e014', slotId: 'S03', surfaceId: 's-soffit' } });
        const p = placeDegradations([fitted(), detail()], [d]).get('d-drop')!;
        expect(p.tier).toBe('coarser-ids');
        expect(p.nodes.map(n => (n as unknown as N).name)).toEqual(['s-soffit']);
    });

    test('a part that names specific ids no node carries is unplaced, never spread over a layer', () => {
        const kept = root('l5', [node('tree-11', PROVENANCE.grownToMeasuredCrown, { crownId: 11 }), node('kept-ring-31', PROVENANCE.asScanned, { crownId: 31 })]);
        const d = degradation('d-crown', { stage: 'trees', part: { description: 'one measured tree', crownId: 99 }, provenanceAfter: PROVENANCE.asScanned, fellTo: 'that tree kept as scanned' });
        const p = placeDegradations([kept], [d]).get('d-crown')!;
        expect(p).toMatchObject({ tier: 'unplaced', scope: 'none', nodes: [] });
    });

    test('a description-only part is the layer of its own stage that shows the rung, else every showing node with that label', () => {
        const trees = root('l5x', [node('t1', PROVENANCE.asScanned), node('t2', PROVENANCE.asScanned)]);
        const dTrees = degradation('d-trees', { stage: 'trees', part: { description: 'the measured trees' }, provenanceAfter: PROVENANCE.asScanned, fellTo: 'the scanned trees put back' });
        expect(placeDegradations([root('l2', [node('scan', PROVENANCE.remeshed)]), trees], [dTrees]).get('d-trees')).toMatchObject({ tier: 'stage', scope: 'layer', layerIds: [objectIdOf('l5x')] });
        // The fit stage drew nothing (rejected): the remeshed scan shows in its place.
        const scan = root('l2', [node('scan', PROVENANCE.remeshed)]);
        const dFit = degradation('d-fit', { stage: 'fit', part: { description: 'the structure' }, provenanceAfter: PROVENANCE.remeshed, fellTo: 'the remeshed scan' });
        expect(placeDegradations([root('l1', [node('raw', PROVENANCE.asScanned)]), scan], [dFit]).get('d-fit')).toMatchObject({ tier: 'label', scope: 'layer', layerIds: [objectIdOf('l2')] });
        // A building named: only that building's layers.
        const other = root('l3b', [node('f', PROVENANCE.fitted)], { buildingId: 'other' });
        const mine = root('l3a', [node('o', PROVENANCE.fitted)], { buildingId: 'mine' });
        const dVision = degradation('d-vis', { stage: 'vision', part: { description: 'facade detail', buildingId: 'mine' } });
        expect(placeDegradations([other, mine], [dVision]).get('d-vis')!.layerIds).toEqual([objectIdOf('l3a')]);
    });

    test('a layer that is no longer showing (the raw scan under its remesh) is not where a fallen part is seen', () => {
        const hidden = root('l2', [node('scan', PROVENANCE.remeshed)], { showing: false });
        const d = degradation('d-fit', { stage: 'fit', part: { description: 'the structure' }, provenanceAfter: PROVENANCE.remeshed });
        expect(placeDegradations([hidden], [d]).get('d-fit')!.tier).toBe('unplaced');
    });
});

// -------------------------------------------------------------------------------------------------------------------
// 4 and 5. The overlay: Retry after the run, reasons in the sentence and on the chips
// -------------------------------------------------------------------------------------------------------------------

function props(state: StagedBuildState, extra: Partial<StagedBuildOverlayProps> = {}): StagedBuildOverlayProps {
    const noop = () => undefined;
    return {
        state, interrupted: false, layers: [], progress: new Map(), nowMs: 0, wallNowMs: Date.now(), announcement: '',
        provenanceOn: false, onToggleProvenance: noop, legend: legendRows(state, resolveLegend(state)), showReplaced: false,
        onToggleShowReplaced: noop, onReplay: noop, onRetry: noop, onHighlight: noop, bottomInsetPx: 16, ...extra
    };
}
const markup = (p: StagedBuildOverlayProps) => renderToStaticMarkup(React.createElement(StagedBuildOverlay, p));
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

const visionFailure = (): DegradationRecord => degradation('d-vision', {
    stage: 'vision', part: { description: 'facade detail of the structure', buildingId: '3fa9c2d1e07b5a44' },
    reason: 'gemini-4-argon (thinking LOW) returned 503 twice; the fitted faces stay flat.', transient: true,
    retry: { tool: 'google_3d_tiles_get_clay', args: { retryRunId: FIXTURE_RUN_ID, retryStage: 'vision' }, reuses: ['tiles', 'remesh', 'fit', 'evidence'] }
});

describe('finding 4: Retry is offered only when the run is over', () => {
    test('a transient degraded stage mid-run shows no Retry (it would send a message that aborts the build); once finished, it does', () => {
        const running = fixtureState([L('l1'), L('l2'), L('l3a'), L('l3b')], { runState: 'running', running: ['detail'], degradations: [visionFailure()], stageStatus: { vision: 'degraded' } });
        expect(markup(props(running))).not.toContain('Retry');
        const finished = { ...running, runState: 'finished' as const };
        expect(markup(props(finished))).toContain('aria-label="Retry the Reading the photos stage"');
        const stopped = { ...running, runState: 'stopped' as const };
        expect(markup(props(stopped))).toContain('aria-label="Retry the Reading the photos stage"');
        // A saved running state reopened after the stream died is interrupted: over.
        expect(markup(props(running, { interrupted: true }))).toContain('aria-label="Retry the Reading the photos stage"');
    });
});

describe('finding 5: the run sentence and the chips say what fell, what was skipped and why', () => {
    const degradedRun = () => fixtureState([L('l1'), L('l2'), L('l3a'), L('l3b')], {
        runState: 'finished', degradations: [visionFailure()], stageStatus: { vision: 'degraded', detail: 'skipped', trees: 'committed' },
        stageReason: { detail: 'no photo-read elements to build' }
    });

    test('a degraded stage is not listed as in the scene; it is listed with its reason, and so is a skipped one', () => {
        const sentence = text(markup(props(degradedRun())));
        expect(sentence).toContain('Finished: Google 3D Tiles, Remeshed scan, Scan-fitted rebuild in the scene.');
        expect(sentence).not.toMatch(/Finished:[^.]*Reading the photos/);
        expect(sentence).toContain('Fell to simpler real data: Reading the photos (gemini-4-argon (thinking LOW) returned 503 twice; the fitted faces stay flat.).');
        expect(sentence).toContain('Skipped: Facade detail (no photo-read elements to build).');
    });

    test('a stage with no layer and nothing built is not "in the scene"', () => {
        const st = fixtureState([L('l1'), L('l2')], { runState: 'finished' });
        st.stages.find(s => s.stage === 'vision')!.status = 'committed';
        const sentence = text(markup(props(st)));
        expect(sentence).toContain('Finished: Google 3D Tiles, Remeshed scan in the scene.');
        expect(sentence).toContain('Also done: Reading the photos.');
    });

    test('the chips of failed, skipped, degraded and stopped stages carry the reason in words, visible and in the label', () => {
        const html = markup(props(degradedRun()));
        expect((html.match(/data-testid="sb-staged-stage-reason"/g) ?? []).length, 'degraded and skipped').toBe(2);
        expect(html).toContain('no photo-read elements to build');
        expect(html).toMatch(/aria-label="Facade detail: skipped[^"]*\. no photo-read elements to build"/);
        // A skipped stage that has no layer and no order (not a chip before) is mentioned too.
        const skippedOnly = fixtureState([L('l1')], { runState: 'finished', stageStatus: { vision: 'skipped' }, stageReason: { vision: 'no Street View and no tile photos resolve this face' } });
        expect(text(markup(props(skippedOnly)))).toContain('Reading the photos skipped');
        expect(markup(props(skippedOnly))).toContain('no Street View and no tile photos resolve this face');
    });

    test('a failed run says why', () => {
        const st = fixtureState([], { runState: 'failed', stageStatus: { tiles: 'failed' }, stageReason: { tiles: 'No Photorealistic 3D Tiles coverage at this place.' } });
        const sentence = text(markup(props(st)));
        expect(sentence).toContain('Failed. Not built: Google 3D Tiles (No Photorealistic 3D Tiles coverage at this place.).');
    });
});

// -------------------------------------------------------------------------------------------------------------------
// The real viewport
// -------------------------------------------------------------------------------------------------------------------

type LayerFrame = { objectId: string; phase: string; progress: number; presence: number; hidden: boolean } | null;
/** A fixture layer by its code, or any layer by its object id. */
const idOf = (l: FixtureLayerId | string): string => (l.includes('-') ? l : objectIdOf(l as FixtureLayerId));
const layerFrame = (page: StagedPage, l: FixtureLayerId | string) => page.eval<LayerFrame>(`sbHarness.layer(${JSON.stringify(idOf(l))})`);
const attached = (page: StagedPage, l: FixtureLayerId) => page.eval<boolean>(`sbHarness.attached(${JSON.stringify(objectIdOf(l))})`);
const overlayText = (page: StagedPage) => page.eval<string>(`document.querySelector('[data-testid="sb-staged-overlay"]').innerText`);
const publish = (page: StagedPage, e: StageEvent) => page.eval(`sbHarness.publishStageEvent(${JSON.stringify(e)})`);

async function advanceTo(page: StagedPage, l: FixtureLayerId | string, p: number): Promise<LayerFrame> {
    for (let i = 0; i < 600; i++) {
        const f = await layerFrame(page, l);
        if (f && (f.phase === 'revealed' || (f.phase === 'revealing' && f.progress >= p))) return f;
        await page.step(1, STEP);
    }
    throw new Error(`${l} never reached ${p}: ${JSON.stringify(await layerFrame(page, l))}`);
}

describe.skipIf(!stagedChrome.ok)('the real viewport (Scene3DPrimitive, its loader and the staged-build hook)', () => {
    let page: StagedPage;
    beforeAll(async () => {
        page = await openStagedPage({ manualFrames: true });
        serveFixture(page, fixture.glbs, objectIdOf, fixture.sidecar);
    });
    afterAll(async () => { await page?.close(); });

    test('finding 1: three running events in a row each update the overlay\'s stage line, progress and message', async () => {
        const run = 'beef0001';
        const st = runOf(run, fixtureState([L('l1')], { runState: 'running', running: ['remesh'], degradations: [visionFailure()], stageStatus: { vision: 'degraded' } }));
        await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(st))})`);
        await page.waitFor('sbHarness.ready()');
        await page.waitFor(`sbHarness.attached(${JSON.stringify(objectIdOf('l1'))})`, 30_000, 'tiles attached');
        await page.step(30, STEP);
        expect(await page.eval<boolean>(`!![...document.querySelectorAll('[data-testid="sb-staged-overlay"] button')].find(b => b.textContent.startsWith('Retry'))`), 'no Retry while the run is running').toBe(false);
        const seen: string[] = [];
        for (const [i, [progress, message, source]] of ([[0.1, 'alpha', 'tile_refine: rectify'], [0.5, 'beta', 'tile_refine: flatten 50%'], [0.9, 'gamma', 'tile_refine: relief']] as const).entries()) {
            await publish(page, event(run, 10 + i, 'remesh', 'running', { progress, message, source }));
            await page.step(6, STEP);
            const t = await overlayText(page);
            seen.push(t);
            expect(t, `after event ${i + 1}`).toContain(`${Math.round(progress * 100)}% · ${message}`);
            expect(await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-source"]')`)).toBe(source);
        }
        await page.screenshot('review_streamed_progress_third_event');
        expect(new Set(seen).size, 'the overlay changed with every event').toBe(3);
        // The run is over: Retry appears for the transient degraded stage.
        await page.eval(`sbHarness.update(${JSON.stringify(stagedSceneData({ ...st, runState: 'finished' as const }))})`);
        await page.step(6, STEP);
        expect(await page.eval<boolean>(`!![...document.querySelectorAll('[data-testid="sb-staged-overlay"] button')].find(b => b.textContent.startsWith('Retry'))`), 'Retry once the run is over').toBe(true);
    });

    test('finding 2: a retired layer stays retired after the stream; Show replaced layers and Replay build load it and release it', async () => {
        const run = 'beef0002';
        const l1 = objectIdOf('l1'), id2 = objectIdOf('l2');
        // The stream, as the chat publishes it: a commit event per stage, each carrying its layer without `retired`.
        const stream = [
            event(run, 1, 'tiles', 'running'),
            event(run, 2, 'tiles', 'committed', { layers: [L('l1')], patch: { upsertObjects: [l1], removeObjects: [], supersede: [] } }),
            event(run, 3, 'remesh', 'running', { progress: 0.5 }),
            event(run, 4, 'remesh', 'committed', { layers: [L('l2')], patch: { upsertObjects: [id2], removeObjects: [], supersede: [{ objectId: l1, by: id2 }] } })
        ];
        for (const e of stream) await publish(page, e);
        // The finish artifact: the district's large L1 is retired and out of objects[].
        const fin = runOf(run, fixtureState([L('l1'), L('l2')], { runState: 'finished' }));
        fin.layers[0] = { ...fin.layers[0], retired: true };
        expect(stagedSceneData(fin).objects, 'the retired layer is not among the scene objects').toHaveLength(1);
        await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(fin))})`);
        await page.waitFor('sbHarness.ready()');
        await page.waitFor(`sbHarness.attached(${JSON.stringify(id2)})`, 30_000, 'remesh attached');
        await advanceTo(page, 'l2', 1);
        await page.step(6, STEP);
        expect(await attached(page, 'l1'), 'the retired layer was never loaded').toBe(false);
        expect(await layerFrame(page, 'l1'), 'the retired layer is not waited for').toMatchObject({ phase: 'retired' });
        await page.screenshot('review_retired_layer_after_stream');

        await page.eval(`sbHarness.click('[data-testid="sb-staged-show-replaced"]')`);
        await page.waitFor(`sbHarness.attached(${JSON.stringify(l1)})`, 30_000, 'Show replaced layers loads the retired layer');
        await page.step(120, STEP);
        const ghost = await layerFrame(page, 'l1');
        expect(ghost!.hidden, 'a superseded layer stays superseded').toBe(true);
        const meshes = await page.eval<Array<{ visible: boolean; staged: string | null }>>(`sbHarness.meshStates(${JSON.stringify(l1)})`);
        expect(meshes.some(m => m.visible && m.staged !== null), 'the ghost is drawn with the staged material').toBe(true);
        await page.screenshot('review_retired_layer_ghost_after_stream');
        await page.eval(`sbHarness.click('[data-testid="sb-staged-show-replaced"]')`);
        await page.step(30, STEP);
        await page.waitFor(`!sbHarness.attached(${JSON.stringify(l1)})`, 30_000, 'the retired layer is released again');

        // Replay build reveals everything again and, being over, stops the guard and the loop.
        await page.eval(`sbHarness.click('[data-testid="sb-staged-replay"]')`);
        await page.waitFor(`sbHarness.attached(${JSON.stringify(l1)})`, 30_000, 'Replay build loads the retired layer');
        await advanceTo(page, 'l2', 1);
        await page.step(240, STEP);
        await page.waitFor(`!sbHarness.attached(${JSON.stringify(l1)})`, 30_000, 'the retired layer is released after the replay');
        expect((await layerFrame(page, 'l2'))!.phase).toBe('revealed');
        await page.eval('sbHarness.resetStats()');
        await page.step(30, STEP);
        expect((await page.eval<{ guardMs: number[] }>('sbHarness.stats()')).guardMs.length, 'the per-frame guard is off once the replay is over').toBe(0);
    });

    test('finding 3: degraded parts are shaded where the data places them, and the list says when there is nothing to shade', async () => {
        const run = 'beef0003';
        // The detail layer, one element node of which says it is the part that degraded (NATIVE writes one such node per degraded slot).
        const L4 = 'stg-b3d1e9c1-l4d';
        const detail = patchGlbJson(fixture.glbs.l4, json => {
            for (const n of json.nodes ?? []) if (n.name === 'e003-panel') n.extras.sb.ids.degradationId = 'd-el-e014';
        });
        page.serve('l4d.glb', detail);
        const l4 = L('l4', { objectId: L4, url: '/models/l4d.glb' });
        const records = [
            degradation('d-el-e014', { stage: 'detail', part: { description: 'element e014 on slot S11', elementId: 'e014' } }),
            degradation('d-crown-99', { stage: 'trees', part: { description: 'the tree at crown 99', crownId: 99 }, provenanceAfter: PROVENANCE.asScanned, fellTo: 'that tree kept as scanned', reason: 'its crown could not be regrown' }),
            degradation('d-vision', { stage: 'vision', part: { description: 'facade detail of the structure' }, provenanceAfter: PROVENANCE.fitted, fellTo: 'the flat fitted face', reason: 'the vision model returned 503' })
        ];
        const st = runOf(run, fixtureState([L('l1'), L('l2'), L('l3a'), L('l3b'), l4], { runState: 'finished', degradations: records, stageStatus: { detail: 'degraded', trees: 'degraded', vision: 'degraded' } }));
        await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(st))})`);
        await page.waitFor('sbHarness.ready()');
        for (const id of [objectIdOf('l3b'), L4]) await page.waitFor(`sbHarness.attached(${JSON.stringify(id)})`, 30_000, `${id} attached`);
        await advanceTo(page, L4, 1);
        await page.step(30, STEP);

        // Every record is in the list; the ones that shade the whole layer or nothing say so.
        await page.eval(`sbHarness.click('[data-testid="sb-staged-degraded-toggle"]')`);
        await page.step(4, STEP);
        const list = await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-degraded-list"]')`);
        expect(list).toContain('No separate part to highlight in the viewport.');
        expect(list).toMatch(/Highlights the whole of Scan-fitted rebuild/);
        expect(list.match(/Highlights|No separate/g)!.length, 'the exact part (a node names it) needs no note').toBe(2);
        await page.screenshot('review_degraded_list_placements');

        const hatchShare = async (id: string) => {
            const nodes = await page.eval<Array<{ node: string; samples: Array<{ rgb: [number, number, number] }> }>>(`sbHarness.sampleNodes(${JSON.stringify(id)}, 60)`);
            const out: Record<string, number> = {};
            for (const n of nodes) out[n.node] = n.samples.filter(s => Math.abs(s.rgb[0] - 0xd5) < 10 && Math.abs(s.rgb[1] - 0x5e) < 10 && s.rgb[2] < 12).length / Math.max(1, n.samples.length);
            return out;
        };
        // Click the element's entry: the node that names it is hatched, the other elements are not.
        const entry = (label: string) => `(() => { const b = [...document.querySelectorAll('[data-testid="sb-staged-degraded-list"] button')].find(x => x.textContent.includes(${JSON.stringify(label)})); b && b.click(); })()`;
        await page.eval(entry('element e014'));
        await page.step(6, STEP);
        const hi = await hatchShare(L4);
        await page.screenshot('review_degraded_highlight_from_list');
        expect(Object.keys(hi).sort()).toEqual(['e001-coffers', 'e002-archivolt', 'e003-panel']);
        expect(hi['e003-panel'], `the named node is hatched: ${JSON.stringify(hi)}`).toBeGreaterThan(0.1);
        expect(hi['e001-coffers']).toBeLessThan(0.03);
        expect(hi['e002-archivolt']).toBeLessThan(0.03);
        // The tree entry has no node: clicking it shades nothing, and nothing else gets shaded for it.
        await page.eval(entry('crown 99'));
        await page.step(6, STEP);
        const none = await hatchShare(L4);
        expect(Math.max(...Object.values(none)), `nothing is shaded for a part no node carries: ${JSON.stringify(none)}`).toBeLessThan(0.03);

        // Provenance on: the exact part and the fitted body (the vision record's whole layer) are marked; the rest are not.
        await page.eval(`sbHarness.click('[data-testid="sb-staged-provenance-toggle"]')`);
        await page.step(8, STEP);
        await page.screenshot('review_degraded_provenance_marks');
        const prov = await hatchShare(L4);
        expect(prov['e003-panel'], JSON.stringify(prov)).toBeGreaterThan(0.1);
        expect(prov['e001-coffers']).toBeLessThan(0.03);
        const body = await hatchShare(objectIdOf('l3b'));
        const bodyMean = Object.values(body).reduce((a, b) => a + b, 0) / Math.max(1, Object.keys(body).length);
        expect(bodyMean, `the fitted faces carry the hatch of the vision record: ${JSON.stringify(body)}`).toBeGreaterThan(0.08);
    });

    test('finding 5 on screen: the finished sentence and the stage chips give the reasons', async () => {
        const run = 'beef0005';
        const st = runOf(run, fixtureState([L('l1'), L('l2'), L('l3a'), L('l3b')], {
            runState: 'finished', degradations: [visionFailure()], stageStatus: { vision: 'degraded', detail: 'skipped', trees: 'committed' },
            stageReason: { detail: 'no photo-read elements to build' }
        }));
        await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(st))})`);
        await page.waitFor('sbHarness.ready()');
        await page.waitFor(`sbHarness.attached(${JSON.stringify(objectIdOf('l3b'))})`, 30_000, 'fit attached');
        await advanceTo(page, 'l3b', 1);
        await page.step(30, STEP);
        const sentence = await page.eval<string>(`sbHarness.text('[data-testid="sb-staged-runstate"]')`);
        expect(sentence).toContain('Finished: Google 3D Tiles, Remeshed scan, Scan-fitted rebuild in the scene.');
        expect(sentence).toContain('Fell to simpler real data: Reading the photos (gemini-4-argon (thinking LOW) returned 503 twice; the fitted faces stay flat.).');
        expect(sentence).toContain('Skipped: Facade detail (no photo-read elements to build).');
        await page.screenshot('review_overlay_finished_degraded_reasons');
        expect(page.consoleErrors().filter(e => !/favicon|404|Failed to load resource/i.test(e))).toEqual([]);
    });
});
