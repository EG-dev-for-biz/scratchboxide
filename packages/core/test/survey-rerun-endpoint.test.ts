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

    it('resolveSurveyPreset accurately resolves Colosseum, ESB, and GAP presets', () => {
        const root = process.cwd();
        const colosseum = resolveSurveyPreset({ location: 'colosseum' }, root);
        expect(colosseum.beautify.locationName).toMatch(/Colosseum/i);
        expect(colosseum.stations.length).toBe(24);
        expect(colosseum.sigmaScale).toBe(0.5);
        expect(colosseum.voxelSizeMeters).toBe(0.05);

        const colosseum112 = resolveSurveyPreset({ location: 'colosseum', surveyPreset: 'watertight-112' }, root);
        expect(colosseum112.stations.length).toBe(112);
        expect(colosseum112.stations.some((s: any) => s.name?.includes('TIER_4_ARENA'))).toBe(true);
        expect(colosseum112.stations.some((s: any) => s.name?.includes('TIER_5_CAVEA'))).toBe(true);

        const colosseum40 = resolveSurveyPreset({ location: 'colosseum', surveyPreset: 'interior-pilot-40' }, root);
        expect(colosseum40.stations.length).toBe(40);
        expect(colosseum40.stations.some((s: any) => s.name?.includes('TIER_4_ARENA'))).toBe(true);

        const esb = resolveSurveyPreset({ location: 'esb_clay' }, root);
        expect(esb.beautify.locationName).toMatch(/Empire State/i);
        expect(esb.stations.length).toBe(24);
        expect(esb.sigmaScale).toBe(0.8);
        expect(esb.voxelSizeMeters).toBe(0.15);

        const gap = resolveSurveyPreset({ location: 'gap_clay' }, root);
        expect(gap.beautify.locationName).toMatch(/Grand Army/i);
        expect(gap.stations.length).toBe(18);
        expect(gap.sigmaScale).toBe(0.5);
        expect(gap.voxelSizeMeters).toBe(0.08);
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
