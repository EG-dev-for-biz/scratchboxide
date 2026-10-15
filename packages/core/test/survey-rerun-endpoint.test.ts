/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import { SurveyApi, createNodeHttpHandler, resolveSurveyPreset } from '../src/node/spatial/survey-router';
import { LocationUnresolvedError, MissingInputError } from '../src/common/errors/pipeline-errors';

describe('Survey Splat Pipeline Rerun Endpoint & Presets', () => {
    let server: http.Server;
    let base = '';
    let api: SurveyApi;
    const mockRerunCalls: any[] = [];

    beforeAll(async () => {
        api = new SurveyApi({
            workspaceRoot: process.cwd(),
            rerunPipeline: async (body, report) => {
                mockRerunCalls.push(body);
                report(0.25, 'Unprojecting mock stations...');
                await new Promise(r => setTimeout(r, 20));
                report(0.75, 'Sub-centimeter octree voxel fusion...');
                await new Promise(r => setTimeout(r, 20));
                return {
                    success: true,
                    tilesetPath: `${process.cwd()}/public/tilesets/colosseum/tileset.json`,
                    tilesetUrl: '/tilesets/colosseum/tileset.json',
                    fusedSplatCount: 884000
                };
            }
        });

        server = http.createServer(createNodeHttpHandler(api, '/api/3d/survey'));
        await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
        base = `http://127.0.0.1:${(server.address() as any).port}/api/3d/survey`;
    });

    afterAll(() => server?.close());

    it('resolveSurveyPreset has no location presets: names are geocoded, unresolvable ones throw, and no GLB is picked by name', async () => {
        const root = process.cwd();
        const geocodeCalls: any[] = [];
        const lookup = {
            geocode: async (q: any) => {
                geocodeCalls.push(q);
                if (typeof q === 'string' && /colosseum/i.test(q)) {
                    return { lat: 41.8902, lng: 12.4922, formattedAddress: 'Colosseum, Piazza del Colosseo, 1, 00184 Roma RM, Italy' };
                }
                throw new LocationUnresolvedError(String(q), 'Google Places found no place for this text');
            },
            elevation: async () => 22.5
        };

        // A place name is geocoded (here: injected Places result) and the ground height comes from the Elevation API
        const colosseum = await resolveSurveyPreset({ location: 'colosseum' }, root, lookup);
        expect(colosseum.anchor.lat).toBeCloseTo(41.8902, 4);
        expect(colosseum.anchor.elevationMeters).toBe(22.5);
        expect(colosseum.anchor.formattedAddress).toContain('Piazza del Colosseo');
        expect(colosseum.stations.length).toBe(16);
        // No GLB is chosen from public/models by name: the caller passes the extracted GLB
        expect(colosseum.glbPath).toBeUndefined();
        expect(geocodeCalls).toEqual(['colosseum']);

        // An unresolvable place throws instead of continuing at (0, 0)
        await expect(resolveSurveyPreset({ location: 'esb_clay' }, root, lookup)).rejects.toBeInstanceOf(LocationUnresolvedError);
        await expect(resolveSurveyPreset({ anchor: { lat: 0, lng: 0, elevationMeters: 0 } }, root, lookup)).rejects.toBeInstanceOf(LocationUnresolvedError);
        await expect(resolveSurveyPreset({}, root, lookup)).rejects.toBeInstanceOf(MissingInputError);

        // Explicit anchor + GLB pass straight through
        const explicit = await resolveSurveyPreset({ anchor: { lat: 40.7648, lng: -73.9733, elevationMeters: 20 }, glbPath: 'public/models/gap_clay.glb', cameraCount: 6 }, root, lookup);
        expect(explicit.anchor.lat).toBe(40.7648);
        expect(explicit.glbPath).toBe('public/models/gap_clay.glb');
        expect(explicit.stations.length).toBe(6);
    });

    it('POST /rerun-pipeline enqueues job and returns job ID', async () => {
        const handler = createNodeHttpHandler(api, '/api/3d/survey');

        let statusCode = 0;
        let responseHeaders: any = {};
        let responseBody = '';

        const mockRes: any = {
            writeHead: (status: number, headers: any) => {
                statusCode = status;
                responseHeaders = headers;
            },
            end: (data: string) => {
                responseBody = data;
            }
        };

        const postPayload = JSON.stringify({
            location: 'colosseum_clay',
            sigmaScale: 0.65,
            voxelSizeMeters: 0.04,
            reusePlates: true
        });

        // Simulate async iterable req stream
        const mockReq: any = {
            method: 'POST',
            url: '/api/3d/survey/rerun-pipeline',
            async *[Symbol.asyncIterator]() {
                yield Buffer.from(postPayload);
            }
        };

        await handler(mockReq, mockRes);

        expect(statusCode).toBe(200);
        const data = JSON.parse(responseBody);
        expect(data.success).toBe(true);
        expect(data.job).toBeDefined();
        expect(data.job.id).toMatch(/^rerun-pipeline-/);
        expect(data.job.kind).toBe('rerun-pipeline');

        // Wait for job completion in memory
        let job = api.job(data.job.id);
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 20));
            job = api.job(data.job.id);
            if (job && job.status === 'done') break;
        }

        expect(job?.status).toBe('done');
        expect(job?.progress).toBe(1);
        expect(job?.result.fusedSplatCount).toBe(884000);
        expect(mockRerunCalls.length).toBe(1);
        expect(mockRerunCalls[0].location).toBe('colosseum_clay');
        expect(mockRerunCalls[0].sigmaScale).toBe(0.65);

        // Test GET /jobs/:id via handler
        let getStatusCode = 0;
        let getResponseBody = '';
        const mockGetRes: any = {
            writeHead: (s: number) => { getStatusCode = s; },
            end: (d: string) => { getResponseBody = d; }
        };
        const mockGetReq: any = {
            method: 'GET',
            url: `/api/3d/survey/jobs/${data.job.id}`
        };
        await handler(mockGetReq, mockGetRes);
        expect(getStatusCode).toBe(200);
        const getData = JSON.parse(getResponseBody);
        expect(getData.success).toBe(true);
        expect(getData.job.id).toBe(data.job.id);
        expect(getData.job.status).toBe('done');
    });
});
