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
import { UTDRA_TOOL_DECLARATIONS } from '../src/node/gemini/tools/spatial-tools';
import { bridgeWithCurtainMesh, skyscraperMesh, writeFixtureGlb, type FixtureMesh } from './helpers/mesh-glb-fixtures';
import type { GeminiGenerateRequest } from '../src/common/gemini-protocol';

// Test inputs: synthetic tiles written to GLB files, which the tools read like any tile (they never build one).
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-utdra-fixtures-'));
const FIXTURES: Record<string, () => FixtureMesh> = {
    urban: () => skyscraperMesh(),
    hybrid: () => skyscraperMesh(50, 70, 220),
    slicer: () => skyscraperMesh(),
    bridge: () => bridgeWithCurtainMesh()
};
async function benchmarkGlb(name: keyof typeof FIXTURES): Promise<string> {
    const file = path.join(fixtureDir, `${name}.glb`);
    return fs.existsSync(file) ? file : writeFixtureGlb(file, FIXTURES[name]());
}
afterAll(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

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

    it('requires an existing input GLB: no benchmark mesh stands in for a missing one', async () => {
        const registry = createDefaultToolRegistry();
        for (const [tool, args] of [
            ['utdra_probe_tile', {}],
            ['utdra_decompose_tile', { benchmark: 'hybrid' }],
            ['utdra_slice_elevation', { cutoffY: 5 }],
            ['utdra_carve_bridge_voids', { benchmark: 'bridge' }]
        ] as const) {
            const outcome = await registry.dispatch(tool, args as any, {} as any);
            expect(outcome.exec.status, tool).toBe('failed');
            expect(String((outcome.resultPayload as any).error), tool).toContain(`${tool} needs inputGlbPath`);
        }
        const absent = await registry.dispatch('utdra_probe_tile', { inputGlbPath: path.join(os.tmpdir(), 'no-such-tile.glb') }, {} as any);
        expect(absent.exec.status).toBe('failed');
        expect(String((absent.resultPayload as any).error)).toContain('does not exist');
        const noCut = await registry.dispatch('utdra_slice_elevation', { inputGlbPath: await benchmarkGlb('slicer') }, {} as any);
        expect(noCut.exec.status).toBe('failed');
        expect(String((noCut.resultPayload as any).error)).toContain('cutoffY');
        for (const decl of UTDRA_TOOL_DECLARATIONS) {
            expect(decl.parameters.required, decl.name).toContain('inputGlbPath');
            expect(Object.keys(decl.parameters.properties || {}), decl.name).not.toContain('benchmark');
        }
    });

    it('executes utdra_probe_tile via tool registry', async () => {
        const registry = createDefaultToolRegistry();
        const outcome = await registry.dispatch(
            'utdra_probe_tile',
            { inputGlbPath: await benchmarkGlb('urban') },
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
                inputGlbPath: await benchmarkGlb('hybrid'),
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
                inputGlbPath: await benchmarkGlb('slicer'),
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
                inputGlbPath: await benchmarkGlb('bridge'),
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

        expect(resolution.canSolveNatively).toBe(true);
        expect(resolution.tier1Assessment.primaryNativeEngine).toBe('cpp-3d-engine');
        expect(resolution.tier1Assessment.nativeCapabilitiesUsed.some(c => c.includes('UTDRA / ULDRA'))).toBe(true);
        expect(resolution.tier1Assessment.suggestedNativeAction?.serviceOrTool).toMatch(/utdra_decompose_tile/);
        expect(resolution.tier1Assessment.suggestedNativeAction?.primitiveType).toBe('3d-scene');

        const uldraResolution = TaskCapabilityResolver.resolveTaskCapability(
            'Carve bridge void underpass curtain walls with ULDRA multi-level void carver'
        );
        expect(uldraResolution.canSolveNatively).toBe(true);
        expect(uldraResolution.tier1Assessment.primaryNativeEngine).toBe('cpp-3d-engine');
        expect(uldraResolution.tier1Assessment.nativeCapabilitiesUsed.some(c => c.includes('UTDRA / ULDRA'))).toBe(true);
    });
});
