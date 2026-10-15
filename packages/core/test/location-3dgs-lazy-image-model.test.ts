/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * location_generate_3dgs with forceRebake: false reuses station plates already on disk, and paints the stations that
 * have none (or whose plate fails geometry QC again) with the image model. The image model's credentials are whatever
 * the credentials service resolves (a key saved in Settings, GOOGLE_AI_API_KEY, Vertex AI), not only an environment
 * key, and they are resolved only when a station needs a new image. The image model here is a fake client standing in
 * for credentials that resolve outside the environment; no real model is called.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { Location3DGaussianSplatService } from '../src/node/spatial/Location3DGaussianSplatService';
import { GoogleMediaCredentialsService } from '../src/node/google-media-credentials-service';
import { GeneratorFailedError } from '../src/common/errors/pipeline-errors';
import { decodePng, encodePng } from '../src/node/texture-processing';
import { fakeImageModelClient, type FakeImageCall } from './helpers/fake-image-model';
import { uvCubeMesh, writeFixtureGlb } from './helpers/mesh-glb-fixtures';

const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-location-3dgs-lazy-'));
afterAll(() => fs.removeSync(WORKSPACE));

const ENV_KEYS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_AI_API_KEY'];

describe('location_generate_3dgs with forceRebake: false paints what has no usable plate, with credentials found anywhere', () => {
    let saved: Record<string, string | undefined>;
    beforeEach(() => {
        // Nothing in the environment: whatever the image model uses comes from the credentials service.
        saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
        for (const k of ENV_KEYS) delete process.env[k];
    });
    afterEach(() => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        vi.restoreAllMocks();
    });

    const request = (outDir: string, glbPath: string) => ({
        location: 'Test Plaza', lat: 40.7648, lng: -73.9733, elevation: 20, glbPath, cameraCount: 3, width: 320, bakeStride: 2,
        outDir, workspaceRoot: WORKSPACE, forceRebake: false as const
    });

    it('paints new stations, reuses passing plates without asking for credentials, and repaints a plate that fails QC', async () => {
        const calls: FakeImageCall[] = [];
        const createClient = vi.spyOn(GoogleMediaCredentialsService.prototype, 'createClient')
            .mockResolvedValue(fakeImageModelClient(calls, { modelVersion: 'gemini-3.1-flash-image' }) as any);
        const glbPath = writeFixtureGlb(path.join(WORKSPACE, 'plaza_clay.glb'), uvCubeMesh(30));
        const outDir = path.join(WORKSPACE, 'out');
        const service = new Location3DGaussianSplatService({ workspaceRoot: WORKSPACE });

        // First run: no plate on disk, so every station is painted by the image model.
        const first = await service.generate(request(outDir, glbPath));
        expect(first.success).toBe(true);
        expect(first.acceptedStations).toBe(first.stationCount);
        expect(first.modelsUsed).toEqual(['gemini-3.1-flash-image']);
        expect(calls.length).toBeGreaterThanOrEqual(first.stationCount);
        expect((await fs.readJson(first.metaPath)).generator).toBe('google-nano-banana');

        // Second run: every plate passes QC again and is reused; the credentials are never resolved.
        const clientCallsBefore = createClient.mock.calls.length;
        const imageCallsBefore = calls.length;
        const second = await service.generate(request(outDir, glbPath));
        expect(second.success).toBe(true);
        expect(createClient.mock.calls.length).toBe(clientCallsBefore);
        expect(calls.length).toBe(imageCallsBefore);
        const secondMeta = await fs.readJson(second.metaPath);
        expect(secondMeta.generator).toBe('cached-beautified-plates');
        for (const st of secondMeta.stations) expect(st.imageSource).toMatch(/no image was generated/);

        // Third run: one plate no longer matches the mesh (a flat image). It is moved aside and the station is
        // painted afresh, instead of being dropped from the splat.
        const stale = secondMeta.stations[0];
        const plate = decodePng(await fs.readFile(stale.imagePath));
        await fs.writeFile(stale.imagePath, encodePng(plate.width, plate.height, Buffer.alloc(plate.rgba.length, 128)));
        const third = await service.generate(request(outDir, glbPath));
        expect(third.success).toBe(true);
        expect(third.acceptedStations).toBe(third.stationCount);
        expect(third.stationCount).toBe(first.stationCount);
        const thirdMeta = await fs.readJson(third.metaPath);
        const repainted = thirdMeta.stations.find((s: any) => s.stationId === stale.stationId);
        expect(repainted.accepted).toBe(true);
        expect(repainted.attempts).toBeGreaterThanOrEqual(1);
        expect(repainted.modelUsed).toBe('gemini-3.1-flash-image');
        expect(thirdMeta.generator).toBe('google-nano-banana');
    }, 600000);

    it('a station with no plate and no image-model credentials fails with the credential error, not a missing generator', async () => {
        vi.spyOn(GoogleMediaCredentialsService.prototype, 'createClient')
            .mockRejectedValue(Object.assign(new Error('Google media credentials are not configured'), { status: 401 }));
        const glbPath = writeFixtureGlb(path.join(WORKSPACE, 'nokey_clay.glb'), uvCubeMesh(30));
        const service = new Location3DGaussianSplatService({ workspaceRoot: WORKSPACE });

        const run = service.generate(request(path.join(WORKSPACE, 'nokey_out'), glbPath));
        await expect(run).rejects.toBeInstanceOf(GeneratorFailedError);
        await expect(run).rejects.toThrow(/Google media credentials are not configured/);
        await expect(run).rejects.not.toThrow(/no StationImageGenerator was supplied/);
    }, 600000);
});
