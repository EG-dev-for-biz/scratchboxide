/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GeminiService } from '../src/node/gemini-service';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';
import type { GeminiGenerateRequest } from '../src/common/gemini-protocol';
import { requireAsset, withReason } from './helpers/requirements';

const colosseumGroundedGlb = requireAsset('public/models/colosseum_grounded.glb');

describe('Google 3D Tiles Agent Tools & Capability Resolution', () => {
    // Mock-mode tile ingestion writes a GLB; keep it out of the repo (default output is public/models/).
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-google-3d-tiles-agent-tools-'));
    afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }));

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
                mockExecution: true,
                outputGlbPath: path.join(outDir, 'full_texture.glb')
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
                mockExecution: true,
                outputGlbPath: path.join(outDir, 'clay.glb')
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

