/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { availableToolNames } from '../src/node/gemini/tool-catalog';
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GeminiService } from '../src/node/gemini-service';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';
import { UTDRA_TOOL_DECLARATIONS } from '../src/node/gemini/tools/spatial-tools';
import { bridgeWithCurtainMesh, rewriteGlbJson, skyscraperMesh, writeFixtureGlb, type FixtureMesh } from './helpers/mesh-glb-fixtures';
import type { GeminiGenerateRequest } from '../src/common/gemini-protocol';

// Test inputs: synthetic tiles written to GLB files, which the tools read like any tile (they never build one).
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-utdra-fixtures-'));
const FIXTURES: Record<string, () => FixtureMesh> = {
    urban: () => skyscraperMesh(),
    slicer: () => skyscraperMesh(),
    bridge: () => bridgeWithCurtainMesh()
};
async function benchmarkGlb(name: keyof typeof FIXTURES): Promise<string> {
    const file = path.join(fixtureDir, `${name}.glb`);
    return fs.existsSync(file) ? file : writeFixtureGlb(file, FIXTURES[name]());
}
afterAll(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

describe('UTDRA / ULDRA Agent Tools & Capability Resolution', () => {
    it('exposes utdra_probe_tile, utdra_slice_elevation and utdra_carve_bridge_voids (no decompose tool) in Gemini tool declarations', () => {
        const geminiService = new GeminiService();
        const request: GeminiGenerateRequest = {
            prompt: 'Measure and slice a photogrammetric 3D tile with UTDRA / ULDRA',
            enableWorkspaceTools: true
        };

        const toolDeclarations = (geminiService as any).buildToolDeclarations(request);
        // Declared up front or loadable by name through load_tools (tool-catalog.ts).
        const toolNames = availableToolNames(toolDeclarations).all;
        // Their full declarations, as offered once loaded.
        const fnDecls: any[] = (geminiService as any).buildToolDeclarations({ ...request, loadedTools: toolNames }).find((t: any) => t.functionDeclarations).functionDeclarations;

        expect(toolNames).toContain('utdra_probe_tile');
        expect(toolNames).toContain('utdra_slice_elevation');
        expect(toolNames).toContain('utdra_carve_bridge_voids');
        expect(toolNames).not.toContain('utdra_decompose_tile');

        const probeTool = fnDecls.find((d: any) => d.name === 'utdra_probe_tile');
        expect(probeTool.description).toMatch(/does not classify the tile or report a confidence/i);

        const sliceTool = fnDecls.find((d: any) => d.name === 'utdra_slice_elevation');
        expect(sliceTool.parameters.required).toContain('cutoffY');
        expect(sliceTool.description).toMatch(/Sutherland-Hodgman/i);

        const bridgeTool = fnDecls.find((d: any) => d.name === 'utdra_carve_bridge_voids');
        expect(bridgeTool.parameters.required).toEqual(['inputGlbPath', 'span']);
        expect(bridgeTool.description).toMatch(/does not find bridges itself/i);
    });

    it('requires an existing input GLB: no benchmark mesh stands in for a missing one', async () => {
        const registry = createDefaultToolRegistry();
        for (const [tool, args] of [
            ['utdra_probe_tile', {}],
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

    it('refuses a tile whose node transforms the native reader would ignore, or whose textures a written tile would lose', async () => {
        const registry = createDefaultToolRegistry();
        const moved = rewriteGlbJson(writeFixtureGlb(path.join(fixtureDir, 'moved.glb'), skyscraperMesh()), g => { g.nodes[0].translation = [500, 0, 0]; });
        const probeMoved = await registry.dispatch('utdra_probe_tile', { inputGlbPath: moved }, {} as any);
        expect(probeMoved.exec.status).toBe('failed');
        expect(String((probeMoved.resultPayload as any).error)).toContain('places its mesh with translation [500,0,0]');

        const textured = rewriteGlbJson(writeFixtureGlb(path.join(fixtureDir, 'textured.glb'), skyscraperMesh()), g => {
            g.images = [{ uri: 'data:image/png;base64,AA==' }];
            g.textures = [{ source: 0 }];
        });
        const slice = await registry.dispatch('utdra_slice_elevation', { inputGlbPath: textured, cutoffY: 5 }, {} as any);
        expect(slice.exec.status).toBe('failed');
        expect(String((slice.resultPayload as any).error)).toContain('texture(s), which the native writer does not carry over');
    });

    it('utdra_probe_tile reports measurements, not a classification or a confidence (a 1 m prop is not an urban core)', async () => {
        const registry = createDefaultToolRegistry();
        const outcome = await registry.dispatch('utdra_probe_tile', { inputGlbPath: await benchmarkGlb('urban') }, {} as any);
        expect(outcome.exec.status).toBe('completed');
        const payload: any = outcome.resultPayload;
        expect(payload.mode).toBe('probe');
        expect(payload.telemetry).not.toHaveProperty('dominantDomain');
        expect(payload.telemetry).not.toHaveProperty('confidence');
        expect(payload.telemetry.reliefMeters).toBeCloseTo(180, 3);
        expect(outcome.exec.summaryResult).toContain('relief ΔY=180.00 m');
        expect(outcome.exec.summaryResult).toContain('These are measurements, not a classification.');
        expect(outcome.exec.summaryResult).not.toMatch(/UrbanHighRiseCore|confidence/);

        const prop = await registry.dispatch('utdra_probe_tile', { inputGlbPath: writeFixtureGlb(path.join(fixtureDir, 'prop.glb'), skyscraperMesh(1, 1, 1)) }, {} as any);
        expect(prop.exec.status).toBe('completed');
        expect(prop.exec.summaryResult).toContain('relief ΔY=1.00 m');
        expect(prop.exec.summaryResult).not.toMatch(/Urban|Suburban|Forest|Mountain/);
    });

    it('executes utdra_slice_elevation via tool registry', async () => {
        const registry = createDefaultToolRegistry();
        const outcome = await registry.dispatch('utdra_slice_elevation', { inputGlbPath: await benchmarkGlb('slicer'), cutoffY: 5.0 }, {} as any);
        expect(outcome.exec.status).toBe('completed');
        const payload: any = outcome.resultPayload;
        expect(payload.mode).toBe('slicer');
        expect(payload.telemetry.boundsMin[1]).toBeCloseTo(5, 4);
        expect(outcome.exec.summaryResult).toMatch(/Kept the part of .* above y=5 m/);
    });

    it('utdra_carve_bridge_voids needs a span; it removes the curtain inside it and leaves a tower with no bridge whole', async () => {
        const registry = createDefaultToolRegistry();
        const noSpan = await registry.dispatch('utdra_carve_bridge_voids', { inputGlbPath: await benchmarkGlb('bridge'), minVoidHeightMeters: 4.0 }, {} as any);
        expect(noSpan.exec.status).toBe('failed');
        expect(String((noSpan.resultPayload as any).error)).toContain('does not find bridges itself');

        const outcome = await registry.dispatch('utdra_carve_bridge_voids', {
            inputGlbPath: await benchmarkGlb('bridge'),
            span: { minX: -10, maxX: 10, minZ: -2, maxZ: 2, groundY: 0, deckY: 12 },
            minVoidHeightMeters: 4.0
        }, {} as any);
        expect(outcome.exec.status).toBe('completed');
        const payload: any = outcome.resultPayload;
        expect(payload.mode).toBe('bridge');
        expect(payload.removedTriangles).toBe(1);
        expect(outcome.exec.summaryResult).toMatch(/^Removed 1 near-vertical triangle\(s\) inside the span/);

        // The review's probe: a plain tower (no bridge) is no longer stripped to its roofs.
        const tower = await registry.dispatch('utdra_carve_bridge_voids', {
            inputGlbPath: await benchmarkGlb('urban'),
            span: { minX: 200, maxX: 260, minZ: -5, maxZ: 5, groundY: 0, deckY: 10 },
            minVoidHeightMeters: 3.5
        }, {} as any);
        expect(tower.exec.status).toBe('completed');
        expect((tower.resultPayload as any).telemetry.outputTriangles).toBe(30);
        expect(tower.exec.summaryResult).toMatch(/nothing was removed/);
    });

    it('TaskCapabilityResolver routes UTDRA and ULDRA queries to the measuring and editing tools', () => {
        const resolution = TaskCapabilityResolver.resolveTaskCapability(
            'Probe this photogrammetric 3D tile using UTDRA'
        );
        expect(resolution.canSolveNatively).toBe(true);
        expect(resolution.tier1Assessment.primaryNativeEngine).toBe('cpp-3d-engine');
        expect(resolution.tier1Assessment.nativeCapabilitiesUsed.some(c => c.includes('UTDRA / ULDRA'))).toBe(true);
        expect(resolution.tier1Assessment.suggestedNativeAction?.targetTool).toBe('utdra_probe_tile');
        expect(resolution.tier1Assessment.suggestedNativeAction?.primitiveType).toBe('3d-scene');
        expect(JSON.stringify(resolution.tier1Assessment)).not.toMatch(/DomainClassifier|rectif(y|ies) architectural shafts/);
    });
});
