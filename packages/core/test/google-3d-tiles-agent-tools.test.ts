/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { GeminiService } from '../src/node/gemini-service';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';
import type { GeminiGenerateRequest } from '../src/common/gemini-protocol';

describe('Google 3D Tiles Agent Tools & Capability Resolution', () => {
    it('exposes google_3d_tiles_get_full_texture and google_3d_tiles_get_clay in Gemini tool declarations', () => {
        const geminiService = new GeminiService();
        const request: GeminiGenerateRequest = {
            prompt: 'Ingest Google 3D Tiles for coordinates 40.748400, -73.985700 at leaf LOD',
            enableWorkspaceTools: true
        };

        const toolDeclarations = (geminiService as any).buildToolDeclarations(request);
        expect(toolDeclarations).toBeDefined();

        const fnDeclsContainer = toolDeclarations.find((t: any) => t.functionDeclarations);
        expect(fnDeclsContainer).toBeDefined();

        const fnDecls: any[] = fnDeclsContainer.functionDeclarations;
        const toolNames = fnDecls.map((d: any) => d.name);

        expect(toolNames).toContain('google_3d_tiles_get_full_texture');
        expect(toolNames).toContain('google_3d_tiles_get_clay');

        const fullTextureTool = fnDecls.find((d: any) => d.name === 'google_3d_tiles_get_full_texture');
        expect(fullTextureTool.parameters.required).toContain('query');
        expect(fullTextureTool.description).toMatch(/photorealistic|full-texture|3D GLB/i);

        const clayTool = fnDecls.find((d: any) => d.name === 'google_3d_tiles_get_clay');
        expect(clayTool.parameters.required).toContain('query');
        expect(clayTool.description).toMatch(/studio grey clay|3D GLB/i);
    });

    it('executes google_3d_tiles_get_full_texture via tool registry in mock mode', async () => {
        const registry = createDefaultToolRegistry();
        const outcome = await registry.dispatch(
            'google_3d_tiles_get_full_texture',
            {
                query: '40.748400, -73.985700',
                mockExecution: true
            },
            {} as any
        );

        expect(outcome.exec.status).toBe('completed');
        const payload: any = outcome.resultPayload;
        expect(payload.success).toBe(true);
        expect(payload.mode).toBe('full-texture');
        expect(payload.glbPath).toBeDefined();
        const mesh = payload.mesh;
        expect(mesh.vertexCount).toBeGreaterThan(0);
        expect(mesh.triangleCount).toBeGreaterThan(0);
        expect(outcome.exec.summaryResult).toMatch(/Google 3D Tiles ingested in full texture/i);
    });

    it('executes google_3d_tiles_get_clay via tool registry in mock mode', async () => {
        const registry = createDefaultToolRegistry();
        const outcome = await registry.dispatch(
            'google_3d_tiles_get_clay',
            {
                query: '40.748400, -73.985700',
                mockExecution: true
            },
            {} as any
        );

        expect(outcome.exec.status).toBe('completed');
        const payload: any = outcome.resultPayload;
        expect(payload.success).toBe(true);
        expect(payload.mode).toBe('clay');
        expect(payload.glbPath).toBeDefined();
        const mesh = payload.mesh;
        expect(mesh.vertexCount).toBeGreaterThan(0);
        expect(mesh.triangleCount).toBeGreaterThan(0);
        expect(outcome.exec.summaryResult).toMatch(/Google 3D Tiles ingested in studio grey clay/i);
    });

    it('TaskCapabilityResolver routes real-world 3D tiles queries to Tier 1 native engine and points to 3D tiles APIs', () => {
        const resolution = TaskCapabilityResolver.resolveTaskCapability(
            'Ingest photorealistic 3D tiles for Midtown Manhattan coordinates 40.748400, -73.985700'
        );

        expect(resolution.recommendedResolutionRoute).toBe('tier1-native');
        expect(resolution.tier1Assessment.primaryNativeEngine).toBe('cpp-3d-engine');
        expect(resolution.tier1Assessment.nativeCapabilitiesUsed.some(c => c.includes('Google Photorealistic 3D Tiles'))).toBe(true);
        expect(resolution.tier1Assessment.suggestedNativeAction?.serviceOrTool).toMatch(/getGoogle3DTilesFullTexture|getGoogle3DTilesClay/);
        expect(resolution.tier1Assessment.suggestedNativeAction?.primitiveType).toBe('3d-scene');
    });
});
