import { test, describe, it, expect, beforeAll, afterAll } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { createStandaloneServer } from '../server/app';
import {
    REPO_ROOT,
    Requirement,
    requireAll,
    requireAssets,
    withReason
} from '../../packages/core/test/helpers/requirements';

// The catalog serves gitignored local model artifacts; a clean checkout has none of them.
const PERFORMER_PRODUCER = 'scripts/regenerate_5_demos.ts (GVHMR body via scripts/run_gvhmr.py)';
const sbhuman = requireAssets(['neutral', 'male', 'female'].map(v => `public/models/sbhuman_${v}.sbhuman`));
const geobox = requireAll(
    requireAssets(['build/geobox_checkpoints/geobox_real_trained.pt'], 'GeoBox training (tools/geobox/train_vertex.py)'),
    requireAssets(['build/geobox_checkpoints/coordinates_100K.npy'], 'tools/geobox/model/gps_gallery/download_100k_gallery.py')
);
const avatar2785536 = requireAll(
    requireAssets(['models/performer_4dgs/demos/2785536/human_4dgs.ply'], PERFORMER_PRODUCER),
    requireAssets(['public/models/humanoid_2785536.glb'], 'scripts/build_performer_surfaces.ts'),
    requireAssets(['public/models/humanoid_2785536.splat'])
);

/** Local helper: at least one performer avatar (demo PLY or converted humanoid_*.splat/.glb) is installed. */
function performerAvatarFiles(): string[] {
    const found: string[] = [];
    const demos = path.join(REPO_ROOT, 'models/performer_4dgs/demos');
    if (fs.existsSync(demos)) {
        for (const id of fs.readdirSync(demos)) {
            if (fs.existsSync(path.join(demos, id, 'human_4dgs.ply'))) found.push(id);
        }
    }
    const publicModels = path.join(REPO_ROOT, 'public/models');
    if (fs.existsSync(publicModels)) {
        found.push(...fs.readdirSync(publicModels).filter(f => /^humanoid_.*\.(splat|glb)$/.test(f)));
    }
    return found;
}
const anyPerformer: Requirement = performerAvatarFiles().length > 0
    ? { ok: true, reason: '' }
    : { ok: false, reason: `no performer avatar installed (models/performer_4dgs/demos/<id>/human_4dgs.ply or public/models/humanoid_<id>.splat/.glb; gitignored; regenerate with ${PERFORMER_PRODUCER})` };

/** Local helper: the catalog has at least one ready model of any family. */
const anyModel: Requirement = sbhuman.ok || geobox.ok || anyPerformer.ok
    || ['neutral', 'male', 'female'].some(v => fs.existsSync(path.join(REPO_ROOT, `public/models/sbhuman_${v}.sbhuman`)))
    || ['geobox_real_trained.pt', 'coordinates_100K.npy'].some(f => fs.existsSync(path.join(REPO_ROOT, 'build/geobox_checkpoints', f)))
    ? { ok: true, reason: '' }
    : { ok: false, reason: `no trained model installed (${[sbhuman.reason, geobox.reason, anyPerformer.reason].join('; ')})` };

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

    it.skipIf(!anyModel.ok)(withReason('1. should return 200 and full catalog on GET /api/models', anyModel), async () => {
        const res = await authedFetch('/api/models');
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.summary).toBeDefined();
        expect(data.summary.totalModels).toBeGreaterThan(0);
        expect(Array.isArray(data.models)).toBe(true);
        expect(data.models.length).toBeGreaterThan(0);
    });

    it.skipIf(anyModel.ok)('2b. should report an empty catalog on GET /api/models/status when no model is installed', async () => {
        const res = await authedFetch('/api/models/status');
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.status).toBe('empty');
        expect(data.summary.totalModels).toBe(0);
    });

    it.skipIf(!anyModel.ok)(withReason('2. should return status and readiness on GET /api/models/status', anyModel), async () => {
        const res = await authedFetch('/api/models/status');
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.status).toBe('ready');
        expect(data.summary.totalModels).toBeGreaterThan(0);
    });

    it.skipIf(!anyPerformer.ok)(withReason('3. should list 4DGS humanoid avatars on GET /api/models/performer/demos', anyPerformer), async () => {
        const res = await authedFetch('/api/models/performer/demos');
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.count).toBeGreaterThan(0);
        expect(Array.isArray(data.demos)).toBe(true);
    });

    it.skipIf(!avatar2785536.ok)(withReason('4. should retrieve specific avatar manifest on GET /api/models/performer/demos/2785536', avatar2785536), async () => {
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

    it.skipIf(!sbhuman.ok)(withReason('5. should list native SB-Human parametric models on GET /api/models/sbhuman', sbhuman), async () => {
        const res = await authedFetch('/api/models/sbhuman');
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.models.length).toBe(3);
        const readyModels = data.models.filter((m: any) => m.status === 'ready');
        expect(readyModels.length).toBe(3);
        expect(readyModels.every((m: any) => m.family === 'sbhuman')).toBe(true);
    });

    it.skipIf(!geobox.ok)(withReason('7. should list GeoBox vision-location models on GET /api/models/geobox', geobox), async () => {
        const res = await authedFetch('/api/models/geobox');
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.models.length).toBeGreaterThanOrEqual(2);
        const readyModels = data.models.filter((m: any) => m.status === 'ready');
        expect(readyModels.length).toBeGreaterThanOrEqual(2);
    });
});
