/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { createStandaloneServer } from '../server/app';

interface MockResponse {
    statusCode: number;
    data: any;
}

function handlePost(app: any, path: string, body: any, token: string): Promise<MockResponse> {
    return new Promise((resolve) => {
        const req: any = {
            method: 'POST',
            url: path,
            headers: {
                'x-scratchbox-token': token,
                'content-type': 'application/json'
            },
            body
        };

        const res: any = {
            statusCode: 200,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(data: any) {
                this.data = data;
                resolve({ statusCode: this.statusCode, data });
                return this;
            },
            send(data: any) {
                this.data = data;
                resolve({ statusCode: this.statusCode, data });
                return this;
            },
            setHeader() {
                return this;
            }
        };

        app.handle(req, res);
    });
}

describe('Standalone Server ARCore Geospatial Endpoints (/api/3d/ar)', () => {
    const app = createStandaloneServer({ port: 0, toolsPort: 3998 });
    const token = app.locals.launchToken;

    it('should reject requests without a valid geodetic anchor', async () => {
        const result = await handlePost(app, '/api/3d/ar/compile', { entities: [] }, token);

        expect(result.statusCode).toBe(400);
        expect(result.data.success).toBe(false);
        expect(result.data.error).toContain('Missing or invalid geodetic anchor');
    });

    it('should compile entities into a valid GeoAnchorDeploymentContract', async () => {
        const payload = {
            anchor: {
                lat: 40.7484405,
                lng: -73.9856644,
                alt: 15.0
            },
            entities: [
                {
                    id: 'portal-splat-01',
                    name: 'Midtown Gaussian Portal',
                    space: {
                        localTransform: {
                            position: [25.0, 0.0, -10.0]
                        }
                    },
                    time: { startMs: 0, durationMs: 0 },
                    environment: {},
                    content: {
                        type: 'gaussian-splat',
                        durableUri: 'https://vault.scratchbox.dev/splats/portal.spz',
                        metadata: { pointCount: 150000 }
                    },
                    behavior: {},
                    lineage: { worldBranchId: 'earth/main', version: 1 }
                }
            ],
            splatConfig: {
                maxSplatBudgetMobile: 350000,
                lodDistanceVoxelizeMeters: 15.0,
                depthOcclusionEnabled: true
            },
            weather: false
        };

        const result = await handlePost(app, '/api/3d/ar/compile', payload, token);

        expect(result.statusCode).toBe(200);
        expect(result.data.success).toBe(true);
        expect(result.data.contract).toBeDefined();
        expect(result.data.contract.frameContract).toBe('sbox-enu-yup-v1');
        expect(result.data.contract.placements).toHaveLength(1);

        const placement = result.data.contract.placements[0];
        expect(placement.entityId).toBe('portal-splat-01');
        expect(placement.asset.assetType).toBe('gaussian-splat');
        expect(placement.asset.durableSplatUri).toBe('https://vault.scratchbox.dev/splats/portal.spz');
        expect(placement.asset.splatFormat).toBe('spz');
        expect(placement.asset.splatCount).toBe(150000);

        expect(result.data.contract.splatRenderingConfig?.maxSplatBudgetMobile).toBe(350000);
        expect(result.data.validation.valid).toBe(true);
    });
});
