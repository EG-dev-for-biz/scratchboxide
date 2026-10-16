/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The staged-build overlay (design §7.3): its words, its accessibility (a polite live region for transitions only,
 * named chips, aria-pressed toggles, aria-expanded collapse and list, 12 px minimum text) and, in the real viewport in
 * headless Chrome, its placement: clear of the toolstrip, the HUD row, the scrubber and the open timeline, collapsed to
 * one chip below 560 px, Escape collapses it, a degraded part highlights its nodes. Screenshots of each state go to
 * test-results/screenshots/staged/.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { STAGED_VISION_MODEL_DEFAULT, PROVENANCE, type DegradationRecord, type StagedBuildState } from '../src/common/spatial/staged-location-contracts';
import { StagedBuildOverlay, type StagedBuildOverlayProps } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/StagedBuildOverlay';
import { legendRows, resolveLegend } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/provenanceShading';
import { visionModelUse } from './helpers/staged-location-fixtures';
import { buildStagedFixture, fixtureLayer, fixtureState, objectIdOf, FIXTURE_RUN_ID, type FixtureLayerId, type StagedFixtureGlbs } from './helpers/staged-glb-fixture';
import { openStagedPage, serveFixture, stagedChrome, type StagedPage } from './helpers/staged-build-chrome';
import { stagedSceneData } from './helpers/staged-build-scene';

let fixture: StagedFixtureGlbs;
beforeAll(() => { fixture = buildStagedFixture(); });
const L = (l: FixtureLayerId, extra = {}) => fixtureLayer(l, fixture.counts, '/models', extra);

const visionFailure = (): DegradationRecord => ({
    id: 'd-vision', stage: 'vision', part: { description: 'facade detail of the structure', buildingId: '3fa9c2d1e07b5a44' },
    intended: 'photo-inferred detail', fellTo: 'the flat fitted face', provenanceAfter: PROVENANCE.fitted,
    reasonCode: 'vision_unavailable', reason: 'gemini-4-argon (thinking LOW) returned 503 twice; the fitted faces stay flat.',
    model: visionModelUse('failed'), transient: true,
    retry: { tool: 'google_3d_tiles_get_clay', args: { retryRunId: FIXTURE_RUN_ID, retryStage: 'vision' }, reuses: ['tiles', 'remesh', 'fit', 'evidence'] },
    atMs: Date.now()
});

function props(state: StagedBuildState, extra: Partial<StagedBuildOverlayProps> = {}): StagedBuildOverlayProps {
    const noop = () => undefined;
    return {
        state, interrupted: false, layers: [], progress: new Map(), nowMs: 0, wallNowMs: Date.now(), announcement: '',
        provenanceOn: false, onToggleProvenance: noop, legend: legendRows(state, resolveLegend(state)), showReplaced: false,
        onToggleShowReplaced: noop, onReplay: noop, onRetry: noop, onHighlight: noop, bottomInsetPx: 16, ...extra
    };
}

const markup = (p: StagedBuildOverlayProps) => renderToStaticMarkup(React.createElement(StagedBuildOverlay, p));

describe('overlay words and accessibility', () => {
    test('stage chips in words with names; a polite live region; 12 px or larger text', () => {
        const st = fixtureState([L('l1'), L('l2', { cached: true })], { running: ['fit'] });
        st.stages.find(s => s.stage === 'remesh')!.timings = { startedAtMs: 1, endedAtMs: 901, ms: 900, cached: true, builtAtMs: Date.UTC(2026, 9, 14, 9) };
        const html = markup(props(st, { announcement: 'Remeshed scan committed' }));
        expect(html).toContain('role="status" aria-live="polite"');
        expect(html).toContain('>Remeshed scan committed<');
        expect(html).toContain('aria-label="Remeshed scan: committed, 0.9 seconds, cached (built 2026-10-14)"');
        expect(html).toMatch(/aria-label="Scan-fitted rebuild: running, \d+\.\d seconds"/);
        expect(html).toContain('✓ Google 3D Tiles committed');
        expect(html).toContain('● Scan-fitted rebuild running');
        expect(html).toContain('aria-pressed="false"');
        expect(html).toContain('aria-expanded="true"');
        expect(html).toContain('Structure 6.1 m from the geocoded point; extracted 31 m around it (1 round)');
        expect(html).toContain('Map data ©Google');
        const sizes = [...html.matchAll(/font-size:(\d+(?:\.\d+)?)px/g)].map(m => Number(m[1]));
        expect(sizes.length).toBeGreaterThan(0);
        expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12);
        // While the run is running there is no replay; the provenance toggle is always there.
        expect(html).not.toContain('Replay build');
        expect(html).toContain('Provenance');
    });

    test('a layer waiting for another names both; two layers of one stage carry their layer codes', () => {
        const st = fixtureState([L('l1'), L('l2'), L('l3a'), L('l3b')], { running: ['trees'] });
        const body = st.layers.find(l => l.layer === 'l3b')!;
        const outlines = st.layers.find(l => l.layer === 'l3a')!;
        expect(body.stage, 'the outlines and the body belong to one stage').toBe(outlines.stage);
        const held = { objectId: body.objectId, layer: body, phase: 'held' as const, progress: 0, presence: 1, overSource: false, hidden: false, heldBy: [outlines.objectId], durationMs: 900 };
        const html = markup(props(st, { layers: [held] }));
        expect(html).toContain('Scan-fitted rebuild (l3b) waits for Scan-fitted rebuild (l3a) to reveal');
        // A stage with one layer is named by its title alone.
        const remesh = st.layers.find(l => l.layer === 'l2')!;
        const heldRemesh = { ...held, objectId: remesh.objectId, layer: remesh, heldBy: [st.layers.find(l => l.layer === 'l1')!.objectId] };
        expect(markup(props(st, { layers: [heldRemesh] }))).toContain('Remeshed scan waits for Google 3D Tiles to reveal');
    });

    test('the vision line names the model, its thinking level and time, any fallback, and a failure', () => {
        const answered = fixtureState([L('l1')], { visionModel: visionModelUse('answered') });
        expect(markup(props(answered))).toContain(`Detail read by ${STAGED_VISION_MODEL_DEFAULT.model} (thinking low; first token 4.1 s, 12.4 s)`);
        const fallback = fixtureState([L('l1')], { visionModel: { ...visionModelUse('answered'), used: 'gemini-3.8-flash', skipped: [{ model: 'gemini-4-argon', reason: 'not served (404)' }] } });
        expect(markup(props(fallback))).toContain('Detail read by gemini-3.8-flash (thinking low; first token 4.1 s, 12.4 s) instead of gemini-4-argon: not served (404)');
        const failed = fixtureState([L('l1')], { visionModel: visionModelUse('failed') });
        expect(markup(props(failed))).toContain('Tried gemini-4-argon (thinking low): 503 UNAVAILABLE (twice)');
    });

    test('a stopped or interrupted run says what stays, what was not built and how to retry', () => {
        const st = fixtureState([L('l1'), L('l2'), L('l3a'), L('l3b')], { runState: 'stopped', stageStatus: { vision: 'stopped', detail: 'stopped', trees: 'stopped' } });
        const html = markup(props(st));
        expect(html).toContain('Stopped. Google 3D Tiles, Remeshed scan, Scan-fitted rebuild stay in the scene. Not built: Reading the photos, Facade detail, Trees.');
        expect(html).toContain('Replay build');
        expect(html).toMatch(/aria-pressed="false"[^>]*>Show replaced layers/);
        const interrupted = fixtureState([L('l1')], { runState: 'interrupted', stageStatus: { remesh: 'stopped' } });
        expect(markup(props(interrupted, { interrupted: true }))).toContain('Interrupted. Google 3D Tiles stay in the scene. Not built: Remeshed scan');
    });

    test('a failed run keeps what it built and names the stage that failed', () => {
        const st = fixtureState([L('l1')], { runState: 'failed', stageStatus: { remesh: 'failed' }, stageReason: { remesh: 'tile_refine exited with code 134' } });
        const html = markup(props(st));
        expect(html).toContain('Failed. Google 3D Tiles stay in the scene. Not built: Remeshed scan (tile_refine exited with code 134).');
        expect(html).toContain('✕ Remeshed scan failed');
    });

    test('degraded parts: a count, a list of what fell to what and why, and Retry with the record args', () => {
        const st = fixtureState([L('l1'), L('l2'), L('l3a'), L('l3b')], { runState: 'finished', degradations: [visionFailure()], stageStatus: { vision: 'degraded' } });
        const html = markup(props(st));
        expect(html).toContain('1 degraded part');
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain('aria-label="Retry the Reading the photos stage"');
    });

    test('the legend lists every label with the run description, the bands with their counts, and the scales', () => {
        const st = fixtureState([L('l1'), L('l2')], { runState: 'finished' });
        st.layers[1].vertexProvenance = {
            schema: 'scratchbox.vertex-provenance/1', attributes: ['_RECTIFY_DISPLACEMENT', '_PROUD_BLOCK', '_RELIEF_HEIGHT'], vertices: 3107,
            rectifyDisplacement: { maxM: 0.433, bands: [{ band: 'untouched', minM: 0, maxM: 0.01, vertices: 1522 }, { band: 'moved', minM: 0.01, maxM: 0.05, vertices: 932 }, { band: 'reshaped', minM: 0.05, vertices: 653 }] },
            proudBlocks: { keptAsScannedVertices: 64, snappedVertices: 12 }, relief: { carvedVertices: 214, maxAbsHeightM: 0.12 }
        };
        const rows = legendRows(st, resolveLegend(st));
        const text = rows.map(r => `${r.text}${r.count !== undefined ? ` [${r.count}]` : ''}`).join('\n');
        expect(text).toContain('remeshed: tile_refine: rectify moved 61% of vertices over 1 cm');
        expect(text).toContain('untouched: moved under 1 cm by rectify and facade flatten [1522]');
        expect(text).toContain('moved: moved 1–5 cm onto a rectified or flattened plane [932]');
        expect(text).toContain('reshaped: moved more than 5 cm: the remesh reshaped the scan here [653]');
        expect(text).toContain('as-scanned: a proud block tile_refine kept as scanned [64]');
        expect(text).toContain("relief-inferred: carved by tile_refine's photo relief: inferred from the photo, unrated (max 12.0 cm) [214]");
        expect(text).toContain('dots break a surface up by its uncertainty');
        const html = markup(props(st, { provenanceOn: true, legend: rows }));
        expect(html).toContain('aria-pressed="true"');
        expect(html).toContain('aria-label="Provenance legend"');
        expect(html).toContain('(1,522 vertices)');
    });
});

describe.skipIf(!stagedChrome.ok)('overlay placement and interaction in the real viewport', () => {
    let page: StagedPage;
    afterAll(async () => { await page?.close(); });

    const intersects = (a: { x: number; y: number; width: number; height: number } | null, b: { x: number; y: number; width: number; height: number } | null) =>
        !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

    async function checkClear(name: string): Promise<void> {
        const b = await page.eval<Record<string, { x: number; y: number; width: number; height: number } | null>>('sbHarness.boxes()');
        expect(b.overlay, `${name}: overlay shown`).not.toBeNull();
        for (const other of ['toolstrip', 'hud', 'scrubber', 'timeline']) {
            expect(intersects(b.overlay, b[other]), `${name}: overlay ${JSON.stringify(b.overlay)} vs ${other} ${JSON.stringify(b[other])}`).toBe(false);
        }
        const c = b.container!;
        expect(b.overlay!.x).toBeGreaterThanOrEqual(c.x);
        expect(b.overlay!.y).toBeGreaterThanOrEqual(c.y);
        expect(b.overlay!.x + b.overlay!.width).toBeLessThanOrEqual(c.x + c.width);
        expect(b.overlay!.y + b.overlay!.height).toBeLessThanOrEqual(c.y + c.height);
    }

    test('running, degraded with the list open, provenance legend, the timeline open; each clear of the viewport chrome', async () => {
        page = await openStagedPage({ manualFrames: true, width: 1100, height: 720 });
        serveFixture(page, fixture.glbs, objectIdOf, fixture.sidecar);
        const running = fixtureState([L('l1'), L('l2')], { running: ['fit', 'trees'], visionModel: visionModelUse('answered') });
        await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(running))})`);
        for (const l of ['l1', 'l2'] as const) await page.waitFor(`sbHarness.attached(${JSON.stringify(objectIdOf(l))})`);
        await page.step(120, 16);
        await page.screenshot('overlay_running');
        await checkClear('running');

        const degraded = fixtureState([L('l1'), L('l2'), L('l3a'), L('l3b')], { runState: 'finished', degradations: [visionFailure()], stageStatus: { vision: 'degraded', detail: 'skipped' }, visionModel: visionModelUse('failed') });
        await page.eval(`sbHarness.update(${JSON.stringify(stagedSceneData(degraded))})`);
        for (const l of ['l3a', 'l3b'] as const) await page.waitFor(`sbHarness.attached(${JSON.stringify(objectIdOf(l))})`);
        await page.step(150, 16);
        await page.eval(`sbHarness.click('[data-testid="sb-staged-degraded-toggle"]')`);
        await page.step(2, 16);
        expect(await page.eval<string>(`document.querySelector('[data-testid="sb-staged-degraded-toggle"]').getAttribute('aria-expanded')`)).toBe('true');
        await page.screenshot('overlay_degraded_list_open');
        await checkClear('degraded list open');

        // Picking a degraded part highlights its nodes: the fitted faces of that building get the vermillion hatch.
        await page.eval(`document.querySelector('[data-testid="sb-staged-degraded-list"] button').click()`);
        await page.step(3, 16);
        const states = await page.eval<Array<{ name: string; staged: string | null }>>(`sbHarness.meshStates(${JSON.stringify(objectIdOf('l3b'))})`);
        expect(states.filter(s => s.staged !== null).length, 'highlighted fitted faces wear the staged material').toBeGreaterThan(0);
        await page.screenshot('overlay_degraded_part_highlighted');

        await page.eval(`sbHarness.click('[data-testid="sb-staged-provenance-toggle"]')`);
        await page.step(3, 16);
        await page.screenshot('overlay_provenance_legend');
        await checkClear('provenance legend');

        // The docked timeline opens across the bottom: the overlay moves above it.
        await page.eval(`sbHarness.click('.sb-3d-tracks-btn')`);
        await page.step(3, 16);
        await page.screenshot('overlay_above_open_timeline');
        await checkClear('timeline open');

        // Escape collapses it to one chip.
        await page.eval(`document.querySelector('[data-testid="sb-staged-overlay"] button').focus()`);
        await page.key('Escape');
        await page.step(2, 16);
        expect(await page.eval<string>(`document.querySelector('[data-testid="sb-staged-overlay"]').dataset.collapsed`)).toBe('true');
        await page.screenshot('overlay_collapsed_by_escape');
    });

    test('below 560 px the overlay is one chip, still clear of the chrome', async () => {
        const narrow = await openStagedPage({ manualFrames: true, width: 520, height: 640 });
        try {
            serveFixture(narrow, fixture.glbs, objectIdOf, fixture.sidecar);
            const running = fixtureState([L('l1')], { running: ['remesh'] });
            await narrow.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(running))})`);
            await narrow.waitFor(`sbHarness.attached(${JSON.stringify(objectIdOf('l1'))})`);
            await narrow.step(60, 16);
            expect(await narrow.eval<string>(`document.querySelector('[data-testid="sb-staged-overlay"]').dataset.collapsed`)).toBe('true');
            const label = await narrow.eval<string>(`document.querySelector('[data-testid="sb-staged-overlay"] button').getAttribute('aria-label')`);
            expect(label).toBe('Staged build: Remeshed scan: running. Show details');
            await narrow.screenshot('overlay_narrow_chip');
        } finally {
            await narrow.close();
        }
    });
});
