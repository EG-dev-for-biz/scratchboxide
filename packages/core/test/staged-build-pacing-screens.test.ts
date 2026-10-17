/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The paced early reveals in the REAL viewport (headless Chrome, real WebGL, stepped frame clock): six fast stages
 * committed at once play one after another, each on screen for at least the dwell, with a screenshot in the middle of
 * each reveal. Screenshots and the measured timeline: test-results/screenshots/stage_pacing/ (gitignored).
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PACED_REVEAL_DWELL_MS } from '../src/browser/generative-canvas/primitives/scene3d/stagedBuild/revealScheduler';
import { buildStagedFixture, fixtureLayer, fixtureState, objectIdOf, type FixtureLayerId, type StagedFixtureGlbs } from './helpers/staged-glb-fixture';
import { SHOT_DIR, openStagedPage, serveFixture, stagedChrome, type StagedPage } from './helpers/staged-build-chrome';
import { stagedSceneData } from './helpers/staged-build-scene';

const OUT = path.join(path.dirname(SHOT_DIR), 'stage_pacing');
let fixture: StagedFixtureGlbs;
beforeAll(() => { fixture = buildStagedFixture(); });
const IDS: FixtureLayerId[] = ['l1', 'l2', 'l3a', 'l3b', 'l4', 'l5'];
const STEP = 16;
type Frame = { phase: string; progress: number } | null;

describe.skipIf(!stagedChrome.ok)('paced early reveals in the real viewport', () => {
    let page: StagedPage;
    beforeAll(async () => {
        page = await openStagedPage({ manualFrames: true, shotDir: OUT });
        serveFixture(page, fixture.glbs, objectIdOf, fixture.sidecar);
    });
    afterAll(async () => { await page?.close(); });

    test('fast stages committed together reveal one after another, each on screen for at least the dwell', async () => {
        // Every layer is quick (0.3 s) and already loaded, as when the first stages finish within seconds.
        const layers = IDS.map(l => fixtureLayer(l, fixture.counts, '/models', { revealAfter: [], reveal: { durationMs: 300, stagger: 0, crossfadeFrom: [] } }));
        const st = fixtureState(layers, { running: [] });
        await page.eval(`sbHarness.mount(${JSON.stringify(stagedSceneData(st))})`);
        for (const l of IDS) await page.waitFor(`sbHarness.attached(${JSON.stringify(objectIdOf(l))})`, 30_000, `${l} attached`);

        const seen: Record<string, { from: number; to: number; shot?: boolean }> = {};
        let t = 0;
        for (let i = 0; i < 900 && Object.values(seen).filter(s => s.to < t - 100).length < IDS.length; i++) {
            await page.step(1, STEP);
            t += STEP;
            for (const l of IDS) {
                const f = await page.eval<Frame>(`sbHarness.layer(${JSON.stringify(objectIdOf(l))})`);
                if (f?.phase === 'revealing') {
                    const s = (seen[l] ??= { from: t, to: t });
                    s.to = t;
                    if (!s.shot && t - s.from >= PACED_REVEAL_DWELL_MS / 2) { s.shot = true; await page.screenshot(`reveal_${IDS.indexOf(l) + 1}_${l}_mid`); }
                }
            }
        }
        const timeline = IDS.map(l => ({ layer: l, startMs: seen[l]?.from, onScreenMs: seen[l] ? seen[l].to - seen[l].from + STEP : 0 }));
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify(timeline, null, 1));
        for (let i = 0; i < 5; i++) {
            expect(timeline[i].onScreenMs, `reveal ${i + 1} (${timeline[i].layer}): ${JSON.stringify(timeline)}`).toBeGreaterThanOrEqual(PACED_REVEAL_DWELL_MS - 100);
            if (i > 0) expect(timeline[i].startMs!).toBeGreaterThanOrEqual(timeline[i - 1].startMs! + timeline[i - 1].onScreenMs - 2 * STEP);
        }
        await page.screenshot('final_all_revealed');
    });
});
