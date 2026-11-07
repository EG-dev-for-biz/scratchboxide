/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The dome draws the weather's multiple-scattering sky: a config with skyModel 'multiple-scattering' asks the server's
 * route for the table (here the route's handler on the real native runner, reached through a local fetch), swaps it in
 * when it arrives and relights from it; a config without it keeps the spectral sky; a native failure is named.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { createAtmosphericSkyDome } from '../src/browser/generative-canvas/services/atmosphere/AtmosphericSkyDome';
import { buildPhysicalSkyLut } from '../src/browser/generative-canvas/services/atmosphere/physical-sky';
import { createSkyRouter } from '../../../desktop-app/server/routes/skyRoutes';

let server: Server;
let base = '';
const realFetch = globalThis.fetch;

beforeEach(async () => {
    const app = express();
    app.use('/api/sky', createSkyRouter({ sendError: (res: any, err: any) => res.status(500).json({ success: false, error: String(err?.message ?? err) }) } as any));
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => realFetch(url.startsWith('/') ? base + url : url, init));
});
afterEach(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>(resolve => server.close(() => resolve()));
});

const table = (dome: ReturnType<typeof createAtmosphericSkyDome>) =>
    ((dome.skyMaterial.uniforms.uSkyLut.value as THREE.DataTexture).image.data as Float32Array);

describe('the sky dome under the weather\'s multiple-scattering sky', () => {
    it('swaps in the native table for its sun and relights from it', async () => {
        const dome = createAtmosphericSkyDome(new THREE.Scene(), false, { skyModel: 'multiple-scattering', sunElevation: 20, sunAzimuth: 226, turbidity: 3.6 });
        // the first frame, before the table is in: the spectral sky, named as such
        expect(dome.skyModel).toBe('spectral');
        const spectralHemi = dome.hemiLight.color.clone();
        await dome.whenSkyReady!();
        expect(dome.skyModel).toBe('multiple-scattering');
        expect(dome.skyModelError).toBeUndefined();
        // the texture holds the native table (RGBA from its RGB), not the spectral one
        const spectral = buildPhysicalSkyLut({ sunElevationDeg: 20, turbidity: 3.6 });
        const drawn = table(dome);
        let diff = 0;
        for (let i = 0; i < 64 * 48; i++) diff += Math.abs(drawn[i * 4 + 2] - spectral.data[i * 3 + 2]);
        expect(diff).toBeGreaterThan(0);
        // and its light colour comes from the new table
        expect(dome.hemiLight.color.equals(spectralHemi)).toBe(false);
        // a new sun is asked for and drawn too
        dome.setSunCoordinates(-4, 250);
        await dome.whenSkyReady!();
        expect(dome.skyModel).toBe('multiple-scattering');
        dome.dispose();
    }, 120_000);

    it('keeps the spectral sky when the config asks for no model (a scene the weather never touched)', async () => {
        const dome = createAtmosphericSkyDome(new THREE.Scene(), false, { sunElevation: 20, sunAzimuth: 226, turbidity: 3.6 });
        await dome.whenSkyReady!();
        expect(dome.skyModel).toBe('spectral');
        dome.dispose();
    });

    it('names a native failure and keeps drawing the spectral sky', async () => {
        vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ success: false, error: 'clang++ not found' }), { status: 500 }));
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        // a haze no other test asks for, so no table is cached for it
        const dome = createAtmosphericSkyDome(new THREE.Scene(), false, { skyModel: 'multiple-scattering', sunElevation: 12.35, sunAzimuth: 200, turbidity: 4.17 });
        await expect(dome.whenSkyReady!()).rejects.toThrow(/clang\+\+ not found/);
        expect(dome.skyModel).toBe('spectral');
        expect(dome.skyModelError).toMatch(/clang\+\+ not found/);
        expect(errors).toHaveBeenCalled();
        errors.mockRestore();
        dome.dispose();
    });
});
