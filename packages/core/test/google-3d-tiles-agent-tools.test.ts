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
import { requireAsset, withReason } from './helpers/requirements';

const colosseumGroundedGlb = requireAsset('public/models/colosseum_grounded.glb');

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

    it('offers the model no mock mode for google_3d_tiles_get_full_texture or google_3d_tiles_get_clay', () => {
        // Mock mode returned synthetic placeholder tiles that were mounted as Google 3D Tiles; the handlers now also
        // refuse a mock extraction result (tile-tools-do-what-was-asked.test.ts covers that with a stubbed extraction).
        const registry = createDefaultToolRegistry();
        for (const name of ['google_3d_tiles_get_full_texture', 'google_3d_tiles_get_clay']) {
            const props = (registry.get(name)!.declaration.parameters as any).properties;
            expect(props.mockExecution).toBeUndefined();
            expect(props.query).toBeDefined();
        }
    });

    it('TaskCapabilityResolver routes real-world 3D tiles queries to Tier 1 native engine and points to 3D tiles APIs', () => {
        const resolution = TaskCapabilityResolver.resolveTaskCapability(
            'Ingest photorealistic 3D tiles for Midtown Manhattan coordinates 40.748400, -73.985700'
        );

        expect(resolution.canSolveNatively).toBe(true);
        expect(resolution.tier1Assessment.primaryNativeEngine).toBe('cpp-3d-engine');
        expect(resolution.tier1Assessment.nativeCapabilitiesUsed.some(c => c.includes('Google Photorealistic 3D Tiles'))).toBe(true);
        expect(resolution.tier1Assessment.suggestedNativeAction?.serviceOrTool).toMatch(/getGoogle3DTilesFullTexture|getGoogle3DTilesClay/);
        expect(resolution.tier1Assessment.suggestedNativeAction?.primitiveType).toBe('3d-scene');
    });

    it('exposes plan_adaptive_survey_rig in tool declarations', () => {
        const geminiService = new GeminiService();
        const request: GeminiGenerateRequest = {
            prompt: 'Plan an adaptive photogrammetric survey rig for the Colosseum 3D model',
            enableWorkspaceTools: true
        };

        const toolDeclarations = (geminiService as any).buildToolDeclarations(request);
        const fnDeclsContainer = toolDeclarations.find((t: any) => t.functionDeclarations);
        const fnDecls: any[] = fnDeclsContainer.functionDeclarations;
        const adaptiveRigTool = fnDecls.find((d: any) => d.name === 'plan_adaptive_survey_rig');
        expect(adaptiveRigTool).toBeDefined();
        expect(adaptiveRigTool.parameters.required).toContain('glbPath');
        expect(adaptiveRigTool.description).toMatch(/Adaptive Scene-Aware Survey Rig Planning/i);
    });

    it.skipIf(!colosseumGroundedGlb.ok)(withReason('dispatches plan_adaptive_survey_rig with real GLB', colosseumGroundedGlb), async () => {
        const registry = createDefaultToolRegistry();
        const glbPath = 'public/models/colosseum_grounded.glb';
        const outcome = await registry.dispatch(
            'plan_adaptive_survey_rig',
            {
                glbPath,
                cameraBudget: 12,
                mode: 'multitier-complete',
                focusCentroid: [-43.42, 24.0, 62.54],
                cropRadius: 120.0
            },
            {} as any
        );

        expect(outcome.exec.status).toBe('completed');
        const payload: any = outcome.resultPayload;
        expect(payload.success).toBe(true);
        expect(payload.stationCount).toBe(12);
        expect(payload.obb).toBeDefined();
        expect(payload.groundDatumY).toBeGreaterThan(20.0);
        expect(payload.stations).toHaveLength(12);
        for (const stn of payload.stations) {
            expect(stn.positionLocalENU[1]).toBeGreaterThanOrEqual(payload.groundDatumY + 1.8);
            expect(stn.dropSky).toBe(true);
        }
    });
});

