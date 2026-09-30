import { test, describe, it, expect, beforeAll, afterAll } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import http from 'http';
import { createStandaloneServer } from '../server/app';

describe('Trained Models API Endpoints (/api/models)', () => {
    let server: http.Server;
    let baseUrl: string;
    let token: string;

    beforeAll(async () => {
        const app = createStandaloneServer({ port: 0, toolsPort: 3998 });
        token = app.locals.launchToken;
        server = http.createServer(app);

        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', () => resolve());
        });

        const address = server.address() as { port: number; address: string };
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
    });

    const authedFetch = (endpoint: string) => {
        return fetch(`${baseUrl}${endpoint}`, {
            headers: {
                'X-Scratchbox-Token': token,
                'Connection': 'close'
            }
        });
    };

    it('1. should return 200 and full catalog on GET /api/models', async () => {
        const res = await authedFetch('/api/models');
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.summary).toBeDefined();
        expect(data.summary.totalModels).toBeGreaterThan(0);
        expect(Array.isArray(data.models)).toBe(true);
        expect(data.models.length).toBeGreaterThan(0);
    });

    it('2. should return status and readiness on GET /api/models/status', async () => {
        const res = await authedFetch('/api/models/status');
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.status).toBe('ready');
        expect(data.summary.totalModels).toBeGreaterThan(0);
    });

    it('3. should list 4DGS humanoid avatars on GET /api/models/performer/demos', async () => {
        const res = await authedFetch('/api/models/performer/demos');
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.count).toBeGreaterThan(0);
        expect(Array.isArray(data.demos)).toBe(true);
    });

    it('4. should retrieve specific avatar manifest on GET /api/models/performer/demos/2785536', async () => {
        const res = await authedFetch('/api/models/performer/demos/2785536');
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.avatar).toBeDefined();
        expect(data.avatar.id).toBe('2785536');
        expect(data.avatar.plyPath).toBeDefined();
        expect(data.avatar.splatPath).toBeDefined();
        expect(data.avatar.glbPath).toBeDefined();
    });

    it('5. should list SMPL-X parametric models on GET /api/models/smplx', async () => {
        const res = await authedFetch('/api/models/smplx');
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.models.length).toBe(3);
        const readyModels = data.models.filter((m: any) => m.status === 'ready');
        expect(readyModels.length).toBe(3);
    });

    it('5b. should list native SB-Human parametric models on GET /api/models/sbhuman', async () => {
        const res = await authedFetch('/api/models/sbhuman');
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.models.length).toBe(3);
        const readyModels = data.models.filter((m: any) => m.status === 'ready');
        expect(readyModels.length).toBe(3);
        expect(readyModels.every((m: any) => m.family === 'sbhuman')).toBe(true);
    });

    it('6. should list OmniRoam camera checkpoints on GET /api/models/omniroam', async () => {
        const res = await authedFetch('/api/models/omniroam');
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.models.length).toBe(2);
        const readyModels = data.models.filter((m: any) => m.status === 'ready');
        expect(readyModels.length).toBe(2);
    });

    it('7. should list GeoBox vision-location models on GET /api/models/geobox', async () => {
        const res = await authedFetch('/api/models/geobox');
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.models.length).toBeGreaterThanOrEqual(2);
        const readyModels = data.models.filter((m: any) => m.status === 'ready');
        expect(readyModels.length).toBeGreaterThanOrEqual(2);
    });
});
