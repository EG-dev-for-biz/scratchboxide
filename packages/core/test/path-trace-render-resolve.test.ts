/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveRenderGlb, sceneSunAndHaze, virtualGeometryHandlers } from '../src/node/gemini/tools/virtual-geometry-tools';

// A scripted scene's model is published under <repo>/public/models while the chat's workspace is another folder
// (desktop-app): path_trace_render must still find it.
describe('path_trace_render model resolution', () => {
    let repo: string, workspace: string, published: string;
    const prevRoot = process.env.SCRATCHBOX_ROOT;
    beforeAll(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-render-resolve-'));
        workspace = path.join(repo, 'desktop-app');
        fs.mkdirSync(path.join(repo, 'public', 'models'), { recursive: true });
        fs.mkdirSync(workspace, { recursive: true });
        published = path.join(repo, 'public', 'models', 'scene_1_abc.glb');
        fs.writeFileSync(published, Buffer.from('glTF'));
        fs.writeFileSync(path.join(workspace, 'local.glb'), Buffer.from('glTF'));
        process.env.SCRATCHBOX_ROOT = repo;
    });
    afterAll(() => {
        if (prevRoot === undefined) delete process.env.SCRATCHBOX_ROOT; else process.env.SCRATCHBOX_ROOT = prevRoot;
        fs.rmSync(repo, { recursive: true, force: true });
    });
    const scene = () => ({ objects: [{ content: { type: '3d-model', durableUri: '/models/scene_1_abc.glb', metadata: { role: 'hero' } } }] }) as any;

    it('finds a file inside the workspace', () => {
        const r = resolveRenderGlb('local.glb', workspace, undefined);
        expect(r).toEqual({ file: fs.realpathSync(path.join(workspace, 'local.glb')), fromOpenScene: false });
    });

    it('finds a published model by its /models/ URL, its public/models path or its file name', () => {
        for (const ref of ['/models/scene_1_abc.glb', 'public/models/scene_1_abc.glb', 'scene_1_abc.glb']) {
            const r = resolveRenderGlb(ref, workspace, scene()) as { file: string; fromOpenScene: boolean };
            expect(fs.realpathSync(r.file)).toBe(fs.realpathSync(published));
            expect(r.fromOpenScene).toBe(true);
        }
    });

    it('renders the open scene\'s model when no path is given, and says what is missing otherwise', () => {
        const r = resolveRenderGlb('', workspace, scene()) as { file: string; fromOpenScene: boolean };
        expect(r.file).toBe(published);
        expect(r.fromOpenScene).toBe(true);
        expect(resolveRenderGlb('', workspace, undefined)).toEqual({ error: expect.stringContaining('glbPath is required') });
        expect(resolveRenderGlb('/models/missing.glb', workspace, undefined)).toEqual({ error: expect.stringContaining('among the published models') });
        expect(resolveRenderGlb('/models/../../etc/passwd.glb', workspace, undefined)).toEqual({ error: expect.any(String) });
    });

    it('refuses a moment of a camera move when the open scene has none', async () => {
        const ctx: any = { workspaceRoot: workspace, request: { activeArtifact: { type: '3d-scene', data: scene() } } };
        const out: any = await virtualGeometryHandlers.path_trace_render({ timeSeconds: 12 }, ctx);
        expect(out.status).toBe('failed');
        expect(out.resultPayload.error).toContain('sb.camera_move');
    });

    it('reads the sun and haze an open scene is lit with', () => {
        const lit: any = { features: { atmosphericScattering: { enabled: true, sunElevation: 33, sunAzimuth: 325, aerialPerspectiveEnabled: true, hazeVisibilityMeters: 1400, fogHeight: 55 } } };
        expect(sceneSunAndHaze(lit)).toEqual({ sun: { elevationDeg: 33, azimuthDeg: 325 }, haze: { visibilityMeters: 1400, scaleHeightMeters: 55 } });
        expect(sceneSunAndHaze({ features: { atmosphericScattering: { enabled: true, sunElevation: 10, sunAzimuth: 0 } } } as any)).toEqual({ sun: { elevationDeg: 10, azimuthDeg: 0 } });
        expect(sceneSunAndHaze({ features: { atmosphericScattering: { enabled: false, sunElevation: 10, sunAzimuth: 0 } } } as any)).toEqual({});
        expect(sceneSunAndHaze(undefined)).toEqual({});
    });
});
