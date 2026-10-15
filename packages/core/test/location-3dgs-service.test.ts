/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as os from 'os';
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
import { GoogleMediaCredentialsService } from '../src/node/google-media-credentials-service';
import { SurveySplatPipelineService } from '../src/node/spatial/SurveySplatPipelineService';
import { Google3DTileBlockoutPipelineService } from '../src/node/spatial/Google3DTileBlockoutPipelineService';
import { TileExtractionError } from '../src/common/errors/pipeline-errors';
import { fakeImageModelClient } from './helpers/fake-image-model';
import { injectTileExtraction } from './helpers/inject-tile-extraction';
import { uvCubeMesh, writeFixtureGlb } from './helpers/mesh-glb-fixtures';

const OUT_TEST_DIR = path.resolve(process.cwd(), 'build/test_location_3dgs_service');
// The injected extraction writes a synthetic tile under <workspace>/public/models; a temp workspace keeps those
// fixtures out of the checkout's public/models, where the app would serve them.
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-location-3dgs-'));

describe('Location3DGaussianSplatService (Canonical Location 3DGS Service)', () => {
    beforeAll(async () => {
        // Station images come from a fake image-model client (it echoes the blockout, recoloured); no real model is
        // called, and production code has no stand-in generator.
        vi.spyOn(GoogleMediaCredentialsService.prototype, 'createClient').mockResolvedValue(fakeImageModelClient([], { modelVersion: 'gemini-3.1-flash-image' }) as any);
        await fs.emptyDir(OUT_TEST_DIR);
    });
    afterAll(() => {
        vi.restoreAllMocks();
        fs.removeSync(WORKSPACE);
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
            const service = new Location3DGaussianSplatService({ workspaceRoot: WORKSPACE });
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

            // The clay tiles were extracted at the given coordinates and named by them, not by the request text
            expect(extraction).toHaveBeenCalledTimes(1);
            const [anchor, mode, options] = extraction.mock.calls[0] as any[];
            expect(mode).toBe('clay');
            expect([anchor.lat, anchor.lng, anchor.elevation]).toEqual([41.8902, 12.4922, 22.0]);
            expect(options.outputGlbPath).toBe(path.join(WORKSPACE, 'public/models', `41.89020_12.49220_r${Math.round(options.radiusMeters)}_clay.glb`));
            expect(result.glbPath).toBe(options.outputGlbPath);

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

        it('renders the place\'s own fresh clay tiles, never a model found on disk by the place\'s name or a canned stand-in', async () => {
            // Decoys a name lookup or the old stand-in list would pick: a cube named after the place, and the survey box.
            const models = path.join(WORKSPACE, 'public/models');
            writeFixtureGlb(path.join(models, 'eiffel_tower_clay.glb'), uvCubeMesh(10));
            writeFixtureGlb(path.join(models, 'survey_box_ground.glb'), uvCubeMesh(10));
            const run = vi.spyOn(SurveySplatPipelineService.prototype, 'run');
            extraction = injectTileExtraction();
            try {
                const result = await generateLocation3DGS({
                    location: 'Eiffel Tower',
                    lat: 48.8584,
                    lng: 2.2945,
                    elevation: 35,
                    cameraCount: 3,
                    width: 320,
                    bakeStride: 2,
                    outDir: path.join(OUT_TEST_DIR, 'eiffel_tower'),
                    forceRebake: true,
                    workspaceRoot: WORKSPACE
                });
                expect(extraction).toHaveBeenCalledTimes(1);
                const renderedGlb = (run.mock.calls[0][0] as any).glbPath;
                expect(renderedGlb).toBe((extraction.mock.calls[0][2] as any).outputGlbPath);
                expect(path.basename(renderedGlb)).not.toMatch(/eiffel_tower_clay|survey_box_ground/);
                expect(result.glbPath).toBe(renderedGlb);
                expect(result.success).toBe(true);
                expect(result.geoAnchor.lat).toBeCloseTo(48.8584, 3);
                expect(result.scene3DData.sceneType).toBe('gaussian_splat');
            } finally {
                run.mockRestore();
            }
        }, 120000);

        it('fails when the clay extraction fails, instead of synthesizing tiles or using another model', async () => {
            const failing = vi.spyOn(Google3DTileBlockoutPipelineService.prototype, 'fetch3DObject').mockRejectedValue(new TileExtractionError('crawl', 'the Map Tiles API answered 403'));
            const run = vi.spyOn(SurveySplatPipelineService.prototype, 'run');
            try {
                await expect(generateLocation3DGS({
                    location: 'Grand Army Plaza', lat: 40.7648, lng: -73.9733, elevation: 20, cameraCount: 3, width: 320,
                    outDir: path.join(OUT_TEST_DIR, 'gap_no_tiles'), workspaceRoot: WORKSPACE
                })).rejects.toThrow(/Tile extraction failed at crawl: the Map Tiles API answered 403/);
                expect(run).not.toHaveBeenCalled();
            } finally {
                failing.mockRestore();
                run.mockRestore();
            }
        });

        it('uses a clay GLB the caller passes, and refuses one that does not exist', async () => {
            const given = writeFixtureGlb(path.join(WORKSPACE, 'given', 'plaza_clay.glb'), uvCubeMesh(30));
            const run = vi.spyOn(SurveySplatPipelineService.prototype, 'run').mockResolvedValue({
                success: false, stations: [], fusedSplatPath: '', fusedSplatCount: 0, tilesetPath: '', metaPath: '', cropBox: { min: [0, 0, 0], max: [0, 0, 0] }, durationMs: 1, error: 'stopped here'
            } as any);
            extraction = injectTileExtraction();
            try {
                await expect(generateLocation3DGS({ location: 'Plaza', lat: 40.7648, lng: -73.9733, elevation: 20, glbPath: given, cameraCount: 3, outDir: path.join(OUT_TEST_DIR, 'given'), workspaceRoot: WORKSPACE }))
                    .rejects.toThrow(/stopped here/);
                expect((run.mock.calls[0][0] as any).glbPath).toBe(given);
                expect(extraction).not.toHaveBeenCalled();
                await expect(generateLocation3DGS({ location: 'Plaza', lat: 40.7648, lng: -73.9733, glbPath: path.join(WORKSPACE, 'missing.glb'), workspaceRoot: WORKSPACE }))
                    .rejects.toThrow(/location_generate_3dgs needs glbPath: .*missing\.glb does not exist/);
            } finally {
                run.mockRestore();
            }
        });
    });

    describe('2. Gemini Tool Declaration & Dispatch (location_generate_3dgs)', () => {
        it('registers location_generate_3dgs in SPATIAL_TOOL_DECLARATIONS', () => {
            const decl = SPATIAL_TOOL_DECLARATIONS.find(d => d.name === 'location_generate_3dgs');
            expect(decl).toBeDefined();
            expect(decl?.description).toContain('3D Gaussian Splat');
            expect(decl?.parameters.properties.location).toBeDefined();
            expect(decl?.parameters.properties.glbPath).toBeDefined();
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
            }, { workspaceRoot: WORKSPACE } as any);

            expect(res).toBeDefined();
            expect(res.summaryResult).toContain('Grand Army Plaza');
            expect(res.resultPayload).toBeDefined();
            const payload = res.resultPayload as any;
            expect(payload.success).toBe(true);
            expect(payload.splatUrl).toBeDefined();
            expect(payload.scene3DData).toBeDefined();
            expect(payload.modelsUsed).toEqual(['gemini-3.1-flash-image']);
            expect(res.summaryResult).toContain('gemini-3.1-flash-image');
            expect(res.summaryResult).toContain(`clay tiles ${payload.glbPath}`);
        }, 120000);

        it('fails the tool when the survey pipeline fails, instead of reporting a built splat world', async () => {
            extraction = injectTileExtraction();
            const run = vi.spyOn(SurveySplatPipelineService.prototype, 'run').mockResolvedValue({
                success: false, stations: [], fusedSplatPath: '/splats/x.splat', fusedSplatCount: 0, tilesetPath: '/splats/tileset.json',
                metaPath: '/splats/x.meta.json', cropBox: { min: [0, 0, 0], max: [0, 0, 0] }, durationMs: 1200, error: 'station_to_splats baker crashed'
            } as any);
            try {
                await expect(spatialHandlers.location_generate_3dgs({
                    location: 'Grand Army Plaza', lat: 40.7648, lng: -73.9733, elevation: 20.0, cameraCount: 3, width: 320, bakeStride: 2, outDir: path.join(OUT_TEST_DIR, 'gap_failed')
                }, { workspaceRoot: WORKSPACE } as any)).rejects.toThrow(/failed: station_to_splats baker crashed/);
            } finally {
                run.mockRestore();
            }
        });
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
