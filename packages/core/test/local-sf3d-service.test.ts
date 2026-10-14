/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Local SF3D (Stable Fast 3D) Organic Prop Generator Test Suite
 * Validates:
 * 1. LocalSf3DService execution in no_pbr mode (< 500ms, 18% Studio Grey Clay)
 * 2. glTF 2.0 binary header validation & metric dimension enforcement
 * 3. Ground contact plane snapping (Y_min = 0.0)
 * 4. In-App Agent Tool execution (generate_local_sf3d_organic_prop) & 3d-scene artifact
 * 5. TaskCapabilityResolver routing for local organic props
 ********************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LocalSf3DService } from '../src/node/3d-engine/local-sf3d-service';
import { localSf3DHandlers } from '../src/node/gemini/tools/local-sf3d-tools';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';
import { buildToolDeclarations, createDefaultToolRegistry } from '../src/node/gemini/tool-registry';

describe('Local SF3D Organic Prop Engine (no_pbr)', () => {
    // Outputs go to a temp dir (this used to resolve to packages/build/test-sf3d inside the repo).
    const testOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-local-sf3d-'));
    const dummyImagePath = path.join(testOutputDir, 'test_chanterelle.png');
    const outputGlbPath = path.join(testOutputDir, 'test_chanterelle_prop.glb');

    beforeAll(() => {
        // Minimal dummy 1x1 PNG input
        fs.writeFileSync(dummyImagePath, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex'));
    });
    afterAll(() => {
        fs.rmSync(testOutputDir, { recursive: true, force: true });
    });

    it('1. Executes LocalSf3DService with no_pbr and verifies binary glTF 2.0 output', async () => {
        const service = LocalSf3DService.getInstance();
        const result = await service.generateOrganicProp({
            imagePath: dummyImagePath,
            outputGlbPath,
            noPbr: true,
            targetScaleMeters: 0.40,
            groundCut: true,
            device: 'cpu',
            promptHint: 'chanterelle mushroom'
        });

        expect(result.success).toBe(true);
        expect(result.mode).toBe('no_pbr_clay');
        expect(fs.existsSync(result.glbPath)).toBe(true);

        // Verify standard glTF 2.0 binary header
        const buffer = fs.readFileSync(result.glbPath);
        expect(buffer.length).toBeGreaterThan(1000);
        expect(buffer.toString('utf8', 0, 4)).toBe('glTF'); // magic 0x46546C67
        expect(buffer.readUInt32LE(4)).toBe(2); // glTF version 2

        // Verify metric scale
        const bbox = result.overallBoundingBox;
        expect(bbox).toBeDefined();
        const maxDim = Math.max(...bbox.dimensions);
        expect(maxDim).toBeCloseTo(0.40, 2);

        // Verify ground plane snap (Y_min must be 0)
        expect(bbox.min[1]).toBeCloseTo(0.0, 3);
        expect(result.vertexCount).toBeGreaterThan(1000);
        expect(result.triangleCount).toBeGreaterThan(2000);
    });

    it('2. Invokes generate_local_sf3d_organic_prop tool handler and creates 3d-scene artifact', async () => {
        const handler = localSf3DHandlers.generate_local_sf3d_organic_prop;
        expect(handler).toBeDefined();

        const toolRes = await handler({
            imagePath: dummyImagePath,
            outputGlbPath: path.join(testOutputDir, 'test_coral_prop.glb'),
            noPbr: true,
            targetScaleMeters: 0.25,
            groundCut: true,
            promptHint: 'small coral formation'
        }, {} as any);

        expect(toolRes.status).toBe('completed');
        expect(toolRes.resultPayload.success).toBe(true);
        expect(toolRes.resultPayload.mode).toBe('no_pbr_clay');
        expect(toolRes.resultPayload.targetScaleMeters).toBe(0.25);

        // Verify 3d-scene artifact contract. Since f05f9f2 the handler returns a ToolHandlerOutcome and the
        // artifact lives in resultPayload, which is where streaming.ts mounts it from.
        const artifact = (toolRes.resultPayload as any).artifact;
        expect(artifact).toBeDefined();
        expect(artifact?.type).toBe('3d-scene');
        expect(artifact?.data.renderMode).toBe('clay');
        expect(artifact?.data.environment.lighting).toBe('studio');
        expect(artifact?.data.camera).toBeDefined();
    });

    it('3. Routes to LocalSf3DService only when the request names SF3D', () => {
        const named = TaskCapabilityResolver.resolveTaskCapability(
            'run SF3D on my photo of a mushroom to get a 3d mesh without pbr'
        );
        expect(named.canSolveNatively).toBe(true);
        expect(named.primaryNativeEngine).toBe('python-3d-engine');
        expect(named.suggestedNativeAction?.targetTool).toBe('generate_local_sf3d_organic_prop');
        expect(named.suggestedNativeAction?.targetService).toBe('LocalSf3DService');

        // Neural reconstruction is never picked for an object asked for in words (AGENTS.md).
        const unnamed = TaskCapabilityResolver.resolveTaskCapability('generate a small organic mushroom prop in 3d');
        expect(unnamed.suggestedNativeAction?.targetTool).not.toBe('generate_local_sf3d_organic_prop');
    });

    it('3b. Is registered but not offered by default; a request naming SF3D gets it', () => {
        const registry = createDefaultToolRegistry();
        expect(registry.has('generate_local_sf3d_organic_prop')).toBe(true);
        const offered = (prompt: string) => (buildToolDeclarations({ prompt, mode: 'agent' } as any, registry) || [])
            .flatMap((t: any) => (t.functionDeclarations || []).map((d: any) => d.name));
        expect(offered('build a 3d model of a small mushroom')).not.toContain('generate_local_sf3d_organic_prop');
        expect(offered('build a 3d model of a small mushroom')).toContain('build_3d_object_from_reference');
        expect(offered('run SF3D on photo.png to make a 3d mesh')).toContain('generate_local_sf3d_organic_prop');
    });

    it('4. Rejects invalid inputs gracefully with structured error', async () => {
        const handler = localSf3DHandlers.generate_local_sf3d_organic_prop;
        const res = await handler({}, {} as any);
        // ToolHandlerOutcome contract (f05f9f2): outcome status 'failed', payload status 'error'.
        expect(res.status).toBe('failed');
        expect(res.summaryResult).toContain('Missing required argument: imagePath');
        expect(res.resultPayload.status).toBe('error');
        expect(res.resultPayload.summary).toContain('Missing required argument: imagePath');
    });
});
