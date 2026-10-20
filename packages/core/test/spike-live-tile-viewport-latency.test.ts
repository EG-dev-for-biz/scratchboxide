/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Phase-0 de-risking spike for `docs/processes/beautify_chained_tiles_world_pipeline.md`.
 *
 * The pipeline doc assumes a live-moving user can get a per-pose textured tile capture cheaply
 * because "the tiles are already resident in a live WebGL viewport for display anyway." That is
 * not true of the existing `Google3DTileBlockoutPipelineService` (its only entry points walk a
 * fixed, precomputed camera path start-to-finish and tear the browser down) — this spike measures
 * whether `LiveTileViewportCaptureService`, a resident-viewport capture service built for this
 * review, makes the premise true: does leaf-LOD settle stay cheap for a small move once nearby
 * tiles are warm, or does every new pose re-pay close to the cold-start cost?
 *
 * Needs real credentials and a real network path to Google's tile servers: this is not a mock and
 * must not become one (AGENTS.md: "no fallbacks or fabrication"). It skips cleanly, with a reason,
 * when a Maps/Tiles API key is not configured.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { requireAnyEnv, withReason } from './helpers/requirements';
import { LiveTileViewportCaptureService, type LivePose } from '../src/node/spatial/LiveTileViewportCaptureService';

const mapsKey = requireAnyEnv(
    ['GOOGLE_MAPS_API_KEY', 'MAP_TILES_API_KEY'],
    'measuring real per-pose 3D Tiles settle latency for the Beautify Chain Service movement-pipeline spike'
);

/** Empire State Building anchor, reused from google-3d-tiles-blockout-pipeline.test.ts. */
const ANCHOR = { lat: 40.7484405, lng: -73.9856644, landmarkName: 'Empire State Building Midtown Manhattan' };

/** A short simulated walk: five ~2m forward steps, then one larger turn (a corner), to separate
 * "small move, tiles already warm" settle cost from "new facade enters view" settle cost. */
function buildWalkPoses(): LivePose[] {
    const poses: LivePose[] = [];
    const startDist = 140, alt = 35, stepM = 2.0;
    for (let i = 0; i < 6; i++) {
        const dist = startDist - i * stepM;
        poses.push({
            id: `walk-${i}`,
            position: [dist, alt, 0],
            target: [0, 20, 0],
            up: [0, 1, 0],
            fov: 60
        });
    }
    // Turn to face a different facade from roughly the same spot — a "corner turn", not a small move.
    poses.push({ id: 'turn-corner', position: [startDist - 5 * stepM, alt, 0], target: [0, 20, 60], up: [0, 1, 0], fov: 60 });
    return poses;
}

describe('Live tile viewport capture latency spike (movement-pipeline de-risking)', () => {
    let service: LiveTileViewportCaptureService | null = null;
    afterAll(async () => { await service?.stop(); });

    it.skipIf(!mapsKey.ok)(withReason('settle latency stays measurable across a resident-viewport walk', mapsKey), async () => {
        service = new LiveTileViewportCaptureService();
        await service.start({ geoAnchor: ANCHOR, mode: 'textured' });

        const poses = buildWalkPoses();
        const results = await service.captureWalk(poses, { timeoutMs: 40000 });

        expect(results.length).toBe(poses.length);

        console.log('\nLive tile viewport capture spike — per-pose settle latency:');
        console.log('id            settleMs  roundTripMs  tilesLoaded  timedOut  jpegBytes');
        for (const r of results) {
            console.log(
                `${r.id.padEnd(13)} ${String(r.settleTimeMs).padStart(8)}  ${String(r.roundTripMs).padStart(11)}  ${String(r.tilesLoaded).padStart(11)}  ${String(r.timedOut).padStart(8)}  ${r.jpeg.length}`
            );
            expect(typeof r.settleTimeMs).toBe('number');
            expect(typeof r.tilesLoaded).toBe('number');
        }

        const [cold, ...rest] = results;
        const warmSteps = rest.slice(0, 4); // the five small forward steps after the first
        const cornerTurn = rest[rest.length - 1];
        const avgWarm = warmSteps.reduce((a, r) => a + r.settleTimeMs, 0) / Math.max(1, warmSteps.length);
        console.log(`\ncold first pose: ${cold.settleTimeMs}ms | avg warm small-step: ${avgWarm.toFixed(0)}ms | corner turn: ${cornerTurn.settleTimeMs}ms`);
        console.log(
            avgWarm < cold.settleTimeMs * 0.5
                ? '=> small moves settle meaningfully faster once warm: the resident-viewport premise holds here.'
                : '=> small moves do NOT settle much faster once warm: every pose is paying close to the cold-start cost.'
        );
    }, 180_000);
});
