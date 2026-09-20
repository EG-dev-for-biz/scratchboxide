/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { GeminiService } from '../src/node/gemini-service';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';
import type { GeminiGenerateRequest } from '../src/common/gemini-protocol';

describe('UTDRA / ULDRA Agent Tools & Capability Resolution', () => {
    it('exposes utdra_probe_tile, utdra_decompose_tile, utdra_slice_elevation, and utdra_carve_bridge_voids in Gemini tool declarations', () => {
        const geminiService = new GeminiService();
        const request: GeminiGenerateRequest = {
            prompt: 'Decompose and rectify photogrammetric 3D tile with UTDRA / ULDRA',
            enableWorkspaceTools: true
        };

        const toolDeclarations = (geminiService as any).buildToolDeclarations(request);
        expect(toolDeclarations).toBeDefined();

        const fnDeclsContainer = toolDeclarations.find((t: any) => t.functionDeclarations);
        expect(fnDeclsContainer).toBeDefined();

        const fnDecls: any[] = fnDeclsContainer.functionDeclarations;
        const toolNames = fnDecls.map((d: any) => d.name);

        expect(toolNames).toContain('utdra_probe_tile');
        expect(toolNames).toContain('utdra_decompose_tile');
        expect(toolNames).toContain('utdra_slice_elevation');
        expect(toolNames).toContain('utdra_carve_bridge_voids');

        const probeTool = fnDecls.find((d: any) => d.name === 'utdra_probe_tile');
        expect(probeTool.description).toMatch(/classify a 3D tile/i);

        const sliceTool = fnDecls.find((d: any) => d.name === 'utdra_slice_elevation');
        expect(sliceTool.parameters.required).toContain('cutoffY');
        expect(sliceTool.description).toMatch(/Sutherland-Hodgman/i);

        const bridgeTool = fnDecls.find((d: any) => d.name === 'utdra_carve_bridge_voids');
        expect(bridgeTool.description).toMatch(/bridge/i);
    });

    it('executes utdra_probe_tile via tool registry', async () => {
        const registry = createDefaultToolRegistry();
        const outcome = await registry.dispatch(
            'utdra_probe_tile',
            { benchmark: 'urban' },
            {} as any
        );

        expect(outcome.exec.status).toBe('completed');
        const payload: any = outcome.resultPayload;
        expect(payload.success).toBe(true);
        expect(payload.mode).toBe('probe');
        expect(payload.telemetry.dominantDomain).toBe('UrbanHighRiseCore');
        expect(payload.telemetry.confidence).toBeGreaterThan(0.7);
        expect(outcome.exec.summaryResult).toMatch(/UTDRA probe classified tile as UrbanHighRiseCore/i);
    });

    it('executes utdra_decompose_tile via tool registry with hybrid benchmark', async () => {
        const registry = createDefaultToolRegistry();
        const outcome = await registry.dispatch(
            'utdra_decompose_tile',
            {
                benchmark: 'hybrid',
                mode: 'full'
            },
            {} as any
        );

        expect(outcome.exec.status).toBe('completed');
        const payload: any = outcome.resultPayload;
        expect(payload.success).toBe(true);
        expect(payload.mode).toBe('full');
        expect(payload.telemetry.inputTriangles).toBeGreaterThan(0);
        expect(payload.telemetry.outputTriangles).toBeGreaterThan(0);
        expect(outcome.exec.summaryResult).toMatch(/UTDRA decomposed tile in/i);
    });

    it('executes utdra_slice_elevation via tool registry', async () => {
        const registry = createDefaultToolRegistry();
        const outcome = await registry.dispatch(
            'utdra_slice_elevation',
            {
                benchmark: 'slicer',
                cutoffY: 5.0
            },
            {} as any
        );

        expect(outcome.exec.status).toBe('completed');
        const payload: any = outcome.resultPayload;
        expect(payload.success).toBe(true);
        expect(payload.mode).toBe('slicer');
        expect(payload.telemetry.outputTriangles).toBeGreaterThan(0);
        expect(outcome.exec.summaryResult).toMatch(/Sutherland-Hodgman non-destructive slicer clipped tile at y=5/i);
    });

    it('executes utdra_carve_bridge_voids via tool registry', async () => {
        const registry = createDefaultToolRegistry();
        const outcome = await registry.dispatch(
            'utdra_carve_bridge_voids',
            {
                benchmark: 'bridge',
                minVoidHeightMeters: 4.0
            },
            {} as any
        );

        expect(outcome.exec.status).toBe('completed');
        const payload: any = outcome.resultPayload;
        expect(payload.success).toBe(true);
        expect(payload.mode).toBe('bridge');
        expect(['CivilInfrastructure', 'IndustrialLogisticsPort']).toContain(payload.telemetry.dominantDomain);
        expect(outcome.exec.summaryResult).toMatch(/Multi-level void carver excised false underpass curtain walls/i);
    });

    it('TaskCapabilityResolver routes UTDRA and ULDRA queries to Tier 1 native engine', () => {
        const resolution = TaskCapabilityResolver.resolveTaskCapability(
            'Decompose this photogrammetric 3D tile and rectify building facades and crowns using UTDRA'
        );

        expect(resolution.recommendedResolutionRoute).toBe('tier1-native');
        expect(resolution.tier1Assessment.primaryNativeEngine).toBe('cpp-3d-engine');
        expect(resolution.tier1Assessment.nativeCapabilitiesUsed.some(c => c.includes('UTDRA / ULDRA'))).toBe(true);
        expect(resolution.tier1Assessment.suggestedNativeAction?.serviceOrTool).toMatch(/utdra_decompose_tile/);
        expect(resolution.tier1Assessment.suggestedNativeAction?.primitiveType).toBe('3d-scene');

        const uldraResolution = TaskCapabilityResolver.resolveTaskCapability(
            'Carve bridge void underpass curtain walls with ULDRA multi-level void carver'
        );
        expect(uldraResolution.recommendedResolutionRoute).toBe('tier1-native');
        expect(uldraResolution.tier1Assessment.primaryNativeEngine).toBe('cpp-3d-engine');
        expect(uldraResolution.tier1Assessment.nativeCapabilitiesUsed.some(c => c.includes('UTDRA / ULDRA'))).toBe(true);
    });
});
