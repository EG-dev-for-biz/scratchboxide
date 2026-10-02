/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as http from 'http';
import { SurveyApi, createSurveyRouter, createNodeHttpHandler } from '../src/node/spatial/survey-router';

const ANCHOR = { lat: -33.8568, lng: 151.2153, elevationMeters: 12, headingDeg: 0 };
const GLB = path.resolve(process.cwd(), 'build/test_survey_render/box_ground.glb'); // written by survey-station-render.test.ts

describe('Survey Synthesis HTTP API (/api/3d/survey)', () => {
    let server: http.Server; let base = '';
    const clayCalls: any[] = [];

    beforeAll(async () => {
        const api = new SurveyApi({
            workspaceRoot: process.cwd(),
            fetchClayGlb: async (q, o) => { clayCalls.push({ q, o }); return { glbPath: GLB, mesh: { vertexCount: 42 }, resolvedAddress: 'mock' }; }
        });
        // Framework-free adapter (express is a desktop-app dependency; the router factory is exercised there)
        expect(typeof createSurveyRouter).toBe('function');
        server = http.createServer(createNodeHttpHandler(api, '/api/3d/survey'));
        await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
        base = `http://127.0.0.1:${(server.address() as any).port}/api/3d/survey`;
    });
    afterAll(() => server?.close());

    const post = async (p: string, body: any) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };

    it('GET /status reports capabilities', async () => {
        const r = await (await fetch(base + '/status')).json();
        expect(r.success).toBe(true); expect(r.clay).toBe(true); expect(r.beautify).toBe(false);
    });

    it('POST /synthesize returns stations + GeoJSON; refuses to run without an anchor (zero presets)', async () => {
        const ok = await post('/synthesize', { anchor: ANCHOR, config: { type: 'orbital-multi-tier', targetRadiusMeters: 140, cameraCount: 12, focalLengthMm: 28 } });
        expect(ok.status).toBe(200);
        expect(ok.json.poses).toHaveLength(12);
        expect(ok.json.enriched).toBe(false);
        expect(ok.json.geoJson.features.length).toBe(12 + 12 + 1);
        const bad = await post('/synthesize', { config: { type: 'orbital-multi-tier', targetRadiusMeters: 140, cameraCount: 12 } });
        expect(bad.status).toBe(400);
        expect(bad.json.error).toMatch(/anchor/);
    });

    it('POST /synthesize with glbPath enriches and ranks stations against the mesh', async () => {
        if (!fs.existsSync(GLB)) return; // render suite not run yet
        const r = await post('/synthesize', { anchor: ANCHOR, config: { type: 'orbital-multi-tier', targetRadiusMeters: 40, cameraCount: 6, focalLengthMm: 28, lookAtOffsetLocalENU: [0, 10, 0] }, glbPath: GLB, isoDate: '2026-06-21T02:00:00Z', rankMaxCount: 4 });
        expect(r.status).toBe(200);
        expect(r.json.enriched).toBe(true);
        expect(r.json.poses[0].beautify.solar.isoDate).toBe('2026-06-21T02:00:00Z');
        expect(typeof r.json.poses[0].beautify.skyFraction).toBe('number');
        expect(r.json.rankedStationIds).toHaveLength(4);
    });

    it('POST /export-colmap emits cameras.txt / images.txt', async () => {
        const s = await post('/synthesize', { anchor: ANCHOR, config: { type: 'street-corridor', targetRadiusMeters: 60, cameraCount: 4, cameraHeightMeters: 1.7 } });
        const e = await post('/export-colmap', { poses: s.json.poses });
        expect(e.json.camerasText).toMatch(/PINHOLE 1920 1080/);
        expect(e.json.imagesText.split('\n').filter((l: string) => /^\d+ /.test(l))).toHaveLength(4);
    });

    it('POST /clay delegates to the injected tile fetcher (fixes the dock 404)', async () => {
        const r = await post('/clay', { anchor: ANCHOR, options: { radiusMeters: 120 } });
        expect(r.status).toBe(200);
        expect(r.json.glbPath).toBe(GLB);
        expect(clayCalls.length).toBe(1);
        expect(clayCalls[0].q.lat).toBe(ANCHOR.lat);
    });

    it('POST /render-station returns a PNG and pinhole intrinsics; rejects GLBs outside the workspace', async () => {
        if (!fs.existsSync(GLB)) return;
        const s = await post('/synthesize', { anchor: ANCHOR, config: { type: 'orbital-multi-tier', targetRadiusMeters: 40, cameraCount: 3, focalLengthMm: 28, lookAtOffsetLocalENU: [0, 10, 0] } });
        const r = await post('/render-station', { glbPath: GLB, station: s.json.poses[0], width: 320 });
        expect(r.status).toBe(200);
        expect(r.json.width).toBe(320); expect(r.json.height).toBe(180);
        expect(Buffer.from(r.json.pngBase64, 'base64').subarray(1, 4).toString()).toBe('PNG');
        expect(r.json.intrinsics.fx).toBeGreaterThan(100);
        expect(r.json.depthStats.filledFraction).toBeGreaterThan(0.2);
        const bad = await post('/render-station', { glbPath: '/etc/passwd', station: s.json.poses[0] });
        expect(bad.status).toBe(400);
    });

    it('POST /plan-adaptive synthesizes scene-conformal poses grounded on GLB geometry', async () => {
        if (!fs.existsSync(GLB)) return;
        const res = await post('/plan-adaptive', {
            glbPath: GLB,
            anchor: ANCHOR,
            cameraBudget: 12,
            targetResolutionMm: 5.0
        });
        expect(res.status).toBe(200);
        expect(res.json.success).toBe(true);
        expect(res.json.poses).toHaveLength(12);
        expect(res.json.geoJson.type).toBe('FeatureCollection');
        expect(res.json.tiers.length).toBeGreaterThanOrEqual(1);
        for (const pose of res.json.poses) {
            expect(pose.positionLocalENU[1]).toBeGreaterThanOrEqual(res.json.groundDatumY + 1.8);
            expect(pose.maxDepth).toBeLessThan(150.0);
        }
    });

    it('beautify endpoints report unavailable until later phases register them', async () => {
        const r = await post('/beautify-station', { stationId: 1 });
        expect(r.status).toBe(400);
        expect(r.json.error).toMatch(/not available/);
    });
});
