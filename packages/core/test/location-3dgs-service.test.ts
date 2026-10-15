/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs-extra';
import {
    Location3DGaussianSplatService,
    generateLocation3DGS,
    type Location3DGSRequest
} from '../src/node/spatial/Location3DGaussianSplatService';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';
import { ToolRegistry } from '../src/node/gemini/tool-registry';
import { SPATIAL_TOOL_DECLARATIONS, spatialHandlers } from '../src/node/gemini/tools/spatial-tools';
import { LocationUnresolvedError } from '../src/common/errors/pipeline-errors';
import { injectTileExtraction } from './helpers/inject-tile-extraction';

const OUT_TEST_DIR = path.resolve(process.cwd(), 'build/test_location_3dgs_service');

describe('Location3DGaussianSplatService (Canonical Location 3DGS Service)', () => {
    beforeAll(async () => {
        process.env.SCRATCHBOX_STATION_IMAGE_GENERATOR = 'mock';
        await fs.emptyDir(OUT_TEST_DIR);
    });
    // The service extracts the place's clay tiles fresh; here that extraction is injected (no network).
    let extraction: ReturnType<typeof injectTileExtraction> | undefined;
    afterEach(() => extraction?.mockRestore());

    describe('1. Service Facade & generateLocation3DGS', () => {
        it('instantiates Location3DGaussianSplatService and exposes generateLocation3DGS', () => {
            const service = new Location3DGaussianSplatService();
            expect(service).toBeDefined();
            expect(typeof service.generate).toBe('function');
            expect(typeof generateLocation3DGS).toBe('function');
        });

        it('synthesizes location 3DGS for a landmark given with its coordinates (Rome Colosseum)', async () => {
            const service = new Location3DGaussianSplatService();
            const request: Location3DGSRequest = {
                location: 'Rome Colosseum',
                lat: 41.8902,
                lng: 12.4922,
                elevation: 22.0,
                cameraCount: 3,
                width: 320,
                bakeStride: 2,
                outDir: path.join(OUT_TEST_DIR, 'colosseum'),
                forceRebake: true
            };

            extraction = injectTileExtraction();
            const result = await service.generate(request);

            // The clay tiles were extracted at the given coordinates, not looked up by name on disk
            expect(extraction).toHaveBeenCalledTimes(1);
            const [anchor, mode, options] = extraction.mock.calls[0] as any[];
            expect(mode).toBe('clay');
            expect([anchor.lat, anchor.lng, anchor.elevation]).toEqual([41.8902, 12.4922, 22.0]);
            // Named by fetch3DObject from the place, radius and mode: not by the request text ("rome_colosseum_clay.glb")
            expect(options.outputGlbPath).toBeUndefined();
            expect(options.outputDir).toMatch(/public[\\/]models$/);

            expect(result.success).toBe(true);
            expect(result.locationName).toContain('Colosseum');
            expect(result.geoAnchor.lat).toBeCloseTo(41.8902, 2);
            expect(result.geoAnchor.lng).toBeCloseTo(12.4922, 2);
            expect(result.splatPath).toBeDefined();
            expect(result.splatUrl).toContain('.splat');
            expect(result.tilesetPath).toBeDefined();
            expect(result.tilesetUrl).toContain('tileset.json');
            expect(result.scene3DData).toBeDefined();
            expect(result.scene3DData.sceneType).toBe('gaussian_splat');
            expect(result.scene3DData.splatUrl).toBe(result.splatUrl);
            expect(result.scene3DData.splatTilesetUrl).toBe(result.tilesetUrl);
            expect(result.scene3DData.geoAnchor?.landmarkName).toContain('Colosseum');
            expect(result.splatCount).toBeGreaterThan(100);
        }, 120000);

        it('synthesizes location 3DGS via coordinates', async () => {
            extraction = injectTileExtraction();
            const result = await generateLocation3DGS({
                location: 'Custom Site',
                lat: 40.7484,
                lng: -73.9857,
                elevation: 15,
                cameraCount: 3,
                width: 320,
                bakeStride: 2,
                outDir: path.join(OUT_TEST_DIR, 'custom_site'),
                forceRebake: true
            });

            expect(result.success).toBe(true);
            expect(result.geoAnchor.lat).toBeCloseTo(40.7484, 2);
            expect(result.geoAnchor.lng).toBeCloseTo(-73.9857, 2);
            expect(result.scene3DData.sceneType).toBe('gaussian_splat');
        }, 120000);

        it('resolves a place name only through Google Places: without a Maps key it fails instead of using a preset', async () => {
            const saved = { g: process.env.GOOGLE_MAPS_API_KEY, m: process.env.MAP_TILES_API_KEY };
            delete process.env.GOOGLE_MAPS_API_KEY;
            delete process.env.MAP_TILES_API_KEY;
            try {
                await expect(generateLocation3DGS({
                    location: 'Eiffel Tower',
                    cameraCount: 3,
                    width: 320,
                    outDir: path.join(OUT_TEST_DIR, 'eiffel_tower')
                })).rejects.toBeInstanceOf(LocationUnresolvedError);
            } finally {
                if (saved.g !== undefined) process.env.GOOGLE_MAPS_API_KEY = saved.g;
                if (saved.m !== undefined) process.env.MAP_TILES_API_KEY = saved.m;
            }
        });
    });

    describe('2. Gemini Tool Declaration & Dispatch (location_generate_3dgs)', () => {
        it('registers location_generate_3dgs in SPATIAL_TOOL_DECLARATIONS', () => {
            const decl = SPATIAL_TOOL_DECLARATIONS.find(d => d.name === 'location_generate_3dgs');
            expect(decl).toBeDefined();
            expect(decl?.description).toContain('3D Gaussian Splat');
            expect(decl?.parameters.properties.location).toBeDefined();
        });

        it('dispatches location_generate_3dgs through tool handler', async () => {
            const handler = spatialHandlers.location_generate_3dgs;
            expect(handler).toBeDefined();
            extraction = injectTileExtraction();

            const res = await handler({
                location: 'Grand Army Plaza',
                lat: 40.7648,
                lng: -73.9733,
                elevation: 20.0,
                cameraCount: 3,
                width: 320,
                bakeStride: 2,
                outDir: path.join(OUT_TEST_DIR, 'gap_tool'),
                forceRebake: true
            }, { workspaceRoot: process.cwd() } as any);

            expect(res).toBeDefined();
            expect(res.summaryResult).toContain('Grand Army Plaza');
            expect(res.resultPayload).toBeDefined();
            const payload = res.resultPayload as any;
            expect(payload.success).toBe(true);
            expect(payload.splatUrl).toBeDefined();
            expect(payload.scene3DData).toBeDefined();
        }, 120000);
    });

    describe('3. TaskCapabilityResolver Integration', () => {
        it('resolves location 3dgs prompt to recommend location_generate_3dgs', () => {
            const res = TaskCapabilityResolver.resolveTaskCapability('Make a 3dgs of the Colosseum');
            expect(res.canSolveNatively).toBe(true);
            expect(res.canSolveNatively).toBe(true);
            expect(res.suggestedNativeAction?.serviceOrTool).toContain('location_generate_3dgs');
        });
    });
});
