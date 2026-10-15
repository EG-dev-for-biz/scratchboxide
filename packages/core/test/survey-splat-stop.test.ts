/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A Stop (or the tool's time limit) ends location_generate_3dgs and survey_beautify_to_splats all the way down: the
 * tool's ctx.signal reaches the image model's call, no further station is generated (each one is a billed image-model
 * call, plus rerolls), and nothing is baked or written after it. The image model is a fake client (no model is called).
 */

import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { SurveySynthesisEngine } from '../src/common/spatial/SurveySynthesisEngine';
import { SurveySplatPipelineService } from '../src/node/spatial/SurveySplatPipelineService';
import { GoogleMediaCredentialsService } from '../src/node/google-media-credentials-service';
import { spatialHandlers } from '../src/node/gemini/tools/spatial-tools';
import { decodePng, encodePng } from '../src/node/texture-processing';
import type { StationImageGenerator } from '../src/node/spatial/BeautifyStationService';
import type { GeodeticAnchor } from '../src/common/spatial/colmap-vector-reference-types';
import { fakeImageModelClient } from './helpers/fake-image-model';
import { writeFixtureGlb, type FixtureMesh } from './helpers/mesh-glb-fixtures';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-splat-stop-'));
afterAll(() => fs.removeSync(WORK));
afterEach(() => vi.restoreAllMocks());
const ANCHOR: GeodeticAnchor = { lat: 40.7648, lng: -73.9733, elevationMeters: 20, headingDeg: 0, formattedAddress: 'Grand Army Plaza' };

/** A 20 m box on a ground grid. */
function boxOnGround(): FixtureMesh {
    const positions: number[] = [], indices: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[]) => {
        const base = positions.length / 3;
        positions.push(...a, ...b, ...c, ...d);
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const [x0, y0, z0, x1, y1, z1] = [-10, 0, -10, 10, 20, 10];
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]);
    quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
    quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
    const g = 100, n = 10, cell = (2 * g) / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const xa = -g + i * cell, xb = xa + cell, za = -g + j * cell, zb = za + cell;
        quad([xa, 0, zb], [xb, 0, zb], [xb, 0, za], [xa, 0, za]);
    }
    return { positions, indices };
}

const stations = () => new SurveySynthesisEngine().synthesize(ANCHOR, {
    type: 'orbital-multi-tier', targetRadiusMeters: 45, cameraCount: 3, focalLengthMm: 28,
    lookAtOffsetLocalENU: [0, 10, 0], altitudeTiersMeters: [ANCHOR.elevationMeters + 8]
});

/** Files the run left in `dir` (recursively), other than the blockouts it rendered before stopping. */
function writtenOutputs(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    const walk = (d: string) => fs.readdirSync(d).forEach(f => {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (!f.endsWith('_blockout.png')) out.push(path.relative(dir, p));
    });
    walk(dir);
    return out;
}

/** A fake image-model client that records each call's abort signal and presses Stop during the first call. */
function stoppingClient(stop: AbortController, signals: Array<AbortSignal | undefined>) {
    const inner = fakeImageModelClient([], { modelVersion: 'gemini-3.1-flash-image' });
    return {
        models: {
            generateContent: async (req: any) => {
                signals.push(req.config?.abortSignal);
                stop.abort();
                return inner.models.generateContent(req);
            }
        }
    };
}

describe('Stop ends the 3DGS station pipeline all the way down', () => {
    it('SurveySplatPipelineService.run stops inside the first station: no reroll, no further station, nothing baked', async () => {
        const glbPath = writeFixtureGlb(path.join(WORK, 'run', 'box.glb'), boxOnGround());
        const outDir = path.join(WORK, 'run', 'splats');
        const stop = new AbortController();
        const seen: Array<AbortSignal | undefined> = [];
        // Answers with a flat image (it fails geometry QC, so without the Stop the station would be rerolled twice).
        const generator: StationImageGenerator = {
            name: 'stop-during-first',
            async generate(args) {
                seen.push(args.signal);
                stop.abort();
                const b = decodePng(args.blockoutPng);
                return { png: encodePng(b.width, b.height, Buffer.alloc(b.rgba.length, 128)), modelUsed: 'gemini-3.1-flash-image' };
            }
        };
        const err = await new SurveySplatPipelineService({ generator }).run({
            glbPath, anchor: ANCHOR, stations: stations(), outDir, beautify: { locationName: 'Stop Test' },
            renderWidth: 320, mode: 'fanout', bakeStride: 2, maxRerolls: 2, forceRebake: true, signal: stop.signal
        }).catch(e => e);
        expect(err?.name).toBe('AbortError');
        expect(seen).toEqual([stop.signal]);
        expect(writtenOutputs(outDir)).toEqual([]);
    }, 300000);

    it('survey_beautify_to_splats passes ctx.signal to the image model and stops after the first station', async () => {
        const dir = path.join(WORK, 'tool');
        const glbPath = writeFixtureGlb(path.join(dir, 'box.glb'), boxOnGround());
        const stationsJsonPath = path.join(dir, 'stations.json');
        fs.outputJsonSync(stationsJsonPath, { anchor: ANCHOR, poses: stations() });
        const stop = new AbortController();
        const signals: Array<AbortSignal | undefined> = [];
        vi.spyOn(GoogleMediaCredentialsService.prototype, 'createClient').mockResolvedValue(stoppingClient(stop, signals) as any);
        const outDir = path.join(dir, 'splats');

        const err = await spatialHandlers.survey_beautify_to_splats(
            { stationsJsonPath, glbPath, outDir, width: 320, mode: 'fanout', bakeStride: 2, maxRerolls: 2, forceRebake: true },
            { workspaceRoot: dir, signal: stop.signal } as any
        ).then(() => undefined, e => e);
        expect(err?.name).toBe('AbortError');
        // One image-model call, made with the tool's own signal (so the SDK cancels it), and nothing after it.
        expect(signals).toEqual([stop.signal]);
        expect(writtenOutputs(outDir)).toEqual([]);
    }, 300000);

    it('location_generate_3dgs passes ctx.signal to the image model and stops after the first station', async () => {
        const dir = path.join(WORK, 'location');
        const glbPath = writeFixtureGlb(path.join(dir, 'plaza_clay.glb'), boxOnGround());
        const stop = new AbortController();
        const signals: Array<AbortSignal | undefined> = [];
        vi.spyOn(GoogleMediaCredentialsService.prototype, 'createClient').mockResolvedValue(stoppingClient(stop, signals) as any);
        const outDir = path.join(dir, 'splats');

        const err = await spatialHandlers.location_generate_3dgs(
            { location: 'Grand Army Plaza', lat: ANCHOR.lat, lng: ANCHOR.lng, elevation: 20, glbPath, cameraCount: 3, width: 320, bakeStride: 2, outDir, forceRebake: true },
            { workspaceRoot: dir, signal: stop.signal } as any
        ).then(() => undefined, e => e);
        expect(err?.name).toBe('AbortError');
        expect(signals).toEqual([stop.signal]);
        expect(writtenOutputs(outDir)).toEqual([]);

        // Stopped before it starts: nothing is extracted, generated or run.
        const run = vi.spyOn(SurveySplatPipelineService.prototype, 'run');
        const before = signals.length;
        const already = new AbortController();
        already.abort();
        const early = await spatialHandlers.location_generate_3dgs(
            { location: 'Grand Army Plaza', lat: ANCHOR.lat, lng: ANCHOR.lng, glbPath, cameraCount: 3, outDir },
            { workspaceRoot: dir, signal: already.signal } as any
        ).then(() => undefined, e => e);
        expect(early?.name).toBe('AbortError');
        expect(run).not.toHaveBeenCalled();
        expect(signals.length).toBe(before);
    }, 300000);
});
