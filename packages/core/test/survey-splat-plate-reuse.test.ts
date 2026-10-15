/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A station image that fails geometry QC is never baked, now or in a later run that reuses what is on disk: it is
 * kept under its own _rejected name, and a plate (or the splat baked from it) found on disk is reused only after it
 * passes the same QC against the mesh again. The mesh is a self-contained box on a ground grid; the image model is a
 * test generator (no model is called).
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { SurveySynthesisEngine } from '../src/common/spatial/SurveySynthesisEngine';
import { SurveySplatPipelineService } from '../src/node/spatial/SurveySplatPipelineService';
import { decodePng, encodePng } from '../src/node/texture-processing';
import type { StationImageGenerator } from '../src/node/spatial/BeautifyStationService';
import type { GeodeticAnchor } from '../src/common/spatial/colmap-vector-reference-types';
import { writeFixtureGlb, type FixtureMesh } from './helpers/mesh-glb-fixtures';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-plate-reuse-'));
afterAll(() => fs.removeSync(WORK));
const ANCHOR: GeodeticAnchor = { lat: -33.8568, lng: 151.2153, elevationMeters: 12, headingDeg: 0, formattedAddress: 'test' };

/** A 20 m box standing on a 200 m ground grid (finely tessellated, like a tile mesh). */
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
    const g = 100, n = 20, cell = (2 * g) / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const xa = -g + i * cell, xb = xa + cell, za = -g + j * cell, zb = za + cell;
        quad([xa, 0, zb], [xb, 0, zb], [xb, 0, za], [xa, 0, za]);
    }
    return { positions, indices };
}

/** Recolours the blockout (geometry untouched, so QC passes), or answers flat when `fails` says so; records calls. */
function recolourGenerator(calls: string[], fails?: () => boolean): StationImageGenerator {
    return {
        name: 'test-recolour',
        async generate(args) {
            calls.push(args.prompt);
            const b = decodePng(args.blockoutPng);
            const out = Buffer.alloc(b.rgba.length);
            const flat = fails?.() === true;
            for (let i = 0; i < b.rgba.length; i += 4) {
                // A flat answer has none of the mesh's edges: geometry QC rejects it.
                out[i] = flat ? 128 : Math.min(255, b.rgba[i] * 1.1 + 15);
                out[i + 1] = flat ? 128 : b.rgba[i + 1] * 0.95;
                out[i + 2] = flat ? 128 : b.rgba[i + 2] * 0.75;
                out[i + 3] = 255;
            }
            return { png: encodePng(b.width, b.height, out), modelUsed: 'gemini-3.1-flash-image' };
        }
    };
}

describe('SurveySplatPipelineService: QC-failed station images are never baked, in this run or a later one', () => {
    it('keeps a rejected image aside, re-checks plates and splats on disk before reuse, and regenerates what fails', async () => {
        const glbPath = writeFixtureGlb(path.join(WORK, 'box_ground.glb'), boxOnGround());
        const outDir = path.join(WORK, 'splats');
        const stations = new SurveySynthesisEngine().synthesize(ANCHOR, {
            type: 'orbital-multi-tier', targetRadiusMeters: 45, cameraCount: 3, focalLengthMm: 28,
            lookAtOffsetLocalENU: [0, 10, 0], altitudeTiersMeters: [ANCHOR.elevationMeters + 8]
        });
        const [a, b, c] = stations.map(s => s.id);
        const stationFile = (id: number, suffix: string) => path.join(outDir, 'stations', `station_${String(id).padStart(3, '0')}${suffix}`);
        const request = { glbPath, anchor: ANCHOR, stations, outDir, beautify: { locationName: 'Test Box' }, renderWidth: 320, mode: 'fanout' as const, bakeStride: 2, maxRerolls: 0 };

        // Run 1: the second station's image (one attempt each, no rerolls) fails QC.
        const calls1: string[] = [];
        const first = await new SurveySplatPipelineService({ generator: recolourGenerator(calls1, () => calls1.length === 2) }).run({ ...request, forceRebake: true });
        const rejected = first.stations.find(s => !s.accepted)!;
        expect(rejected).toBeDefined();
        expect(first.stations.filter(s => s.accepted)).toHaveLength(2);
        // An image without edges cannot be checked against the mesh, so it fails instead of passing by default.
        expect(rejected.qc.reason).toContain('no edges to check the image against the mesh');
        const rejectedId = rejected.stationId;
        expect(rejected.imagePath).toBe(stationFile(rejectedId, '_rejected.png'));
        expect(fs.existsSync(stationFile(rejectedId, '_rejected.png'))).toBe(true);
        expect(fs.existsSync(stationFile(rejectedId, '_beautified.png'))).toBe(false);
        expect(fs.existsSync(stationFile(rejectedId, '.splat'))).toBe(false);

        // A stale plate that no longer matches the mesh, as an earlier run (or older code) could have left it.
        const stale = [a, b, c].find(id => id !== rejectedId)!;
        const kept = [a, b, c].find(id => id !== rejectedId && id !== stale)!;
        const plate = decodePng(fs.readFileSync(stationFile(stale, '_beautified.png')));
        fs.writeFileSync(stationFile(stale, '_beautified.png'), encodePng(plate.width, plate.height, Buffer.alloc(plate.rgba.length, 128)));

        // Run 2 reuses what is on disk: only plates that pass QC again; the rejected and the stale station are made afresh.
        const calls2: string[] = [];
        const second = await new SurveySplatPipelineService({ generator: recolourGenerator(calls2) }).run({ ...request, forceRebake: false });
        expect(second.stations.every(s => s.accepted)).toBe(true);
        expect(calls2).toHaveLength(2);
        const keptReport = second.stations.find(s => s.stationId === kept)!;
        expect(keptReport.attempts).toBe(0);
        expect(keptReport.qc.passed).toBe(true);
        expect(Number.isFinite(keptReport.qc.overlapPercent)).toBe(true);
        expect(keptReport.imageSource).toMatch(/passed geometry QC again/);
        for (const id of [rejectedId, stale]) {
            const rep = second.stations.find(s => s.stationId === id)!;
            expect(rep.attempts).toBe(1);
            expect(rep.imageSource).not.toMatch(/Reused/);
            expect(fs.existsSync(stationFile(id, '_beautified.png'))).toBe(true);
        }
        expect(fs.existsSync(stationFile(rejectedId, '_rejected.png'))).toBe(false);
    }, 600000);
});
