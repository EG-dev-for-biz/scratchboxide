/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect, beforeAll } from 'vitest';
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

const OUT_TEST_DIR = path.resolve(process.cwd(), 'build/test_location_3dgs_service');

describe('Location3DGaussianSplatService (Canonical Location 3DGS Service)', () => {
    beforeAll(async () => {
        process.env.SCRATCHBOX_STATION_IMAGE_GENERATOR = 'mock';
        await fs.emptyDir(OUT_TEST_DIR);
    });

    describe('1. Service Facade & generateLocation3DGS', () => {
        it('instantiates Location3DGaussianSplatService and exposes generateLocation3DGS', () => {
            const service = new Location3DGaussianSplatService();
            expect(service).toBeDefined();
            expect(typeof service.generate).toBe('function');
            expect(typeof generateLocation3DGS).toBe('function');
        });

        it('synthesizes location 3DGS for a recognized landmark (Rome Colosseum)', async () => {
            const service = new Location3DGaussianSplatService();
            const request: Location3DGSRequest = {
                location: 'Rome Colosseum',
                cameraCount: 3,
                width: 320,
                bakeStride: 2,
                outDir: path.join(OUT_TEST_DIR, 'colosseum'),
                forceRebake: true
            };

            const result = await service.generate(request);

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

        it('synthesizes location 3DGS for unfamiliar global landmark without pre-packaged profile (Eiffel Tower)', async () => {
            const result = await generateLocation3DGS({
                location: 'Eiffel Tower',
                cameraCount: 3,
                width: 320,
                bakeStride: 2,
                outDir: path.join(OUT_TEST_DIR, 'eiffel_tower'),
                forceRebake: true
            });

            expect(result.success).toBe(true);
            expect(result.locationName).toContain('Eiffel Tower');
            // Must NOT fall back to lat: 0, lng: 0 or survey_box_ground!
            expect(result.geoAnchor.lat).toBeCloseTo(48.8584, 2);
            expect(result.geoAnchor.lng).toBeCloseTo(2.2945, 2);
            expect(result.splatPath).toBeDefined();
            expect(result.splatCount).toBeGreaterThan(50);
            expect(result.scene3DData.sceneType).toBe('gaussian_splat');
            expect(result.scene3DData.geoAnchor?.landmarkName).toContain('Eiffel Tower');
        }, 120000);
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

            const res = await handler({
                location: 'Grand Army Plaza',
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
            expect(res.tier).toBe('tier1-native');
            expect(res.suggestedNativeAction?.serviceOrTool).toContain('location_generate_3dgs');
        });
    });
});
