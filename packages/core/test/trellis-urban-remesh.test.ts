/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs-extra';
import { ComfyUiCloudRunService } from '../src/node/cloudrun/comfyui-cloudrun-service';
import { ComfyUiPipelineAgent } from '../src/node/agent/comfyui-pipeline-agent';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';

describe('3D Scene vs Discrete Object Generation Policy (Native Codebase Scenes, Trellis Prop Only)', () => {
    const testOutputDir = path.join(__dirname, 'temp_trellis_urban_outputs');

    beforeEach(async () => {
        await fs.ensureDir(testOutputDir);
    });

    afterEach(async () => {
        await fs.remove(testOutputDir);
    });

    it('resolves 3D scenes, urban blocks, and architectural footprints natively in codebase with zero fallback to Trellis', () => {
        const res = TaskCapabilityResolver.resolveTaskCapability(
            'Remesh noisy Google Maps 3D tile with building footprint vector map and create urban architectural district'
        );

        // Scenes and environments MUST be created natively in codebase
        expect(res.tier1Assessment.canSolveNatively).toBe(true);
        expect(res.tier1Assessment.primaryNativeEngine).toBe('cpp-3d-engine');
        expect(res.tier2Fallback.needed).toBe(false);
        expect(res.tier2Fallback.suggestedNodes).not.toContain('TrellisUrbanRemeshNode');
    });

    it('allows Trellis strictly for discrete objects/props within a scene from a reference image', () => {
        const res = TaskCapabilityResolver.resolveTaskCapability(
            'Reconstruct 3D prop chair from photo using Trellis image-to-3d diffusion model',
            { hasInputImage: true }
        );

        // Discrete single-object props can use Trellis
        expect(res.tier1Assessment.canSolveNatively).toBe(false);
        expect(res.tier2Fallback.needed).toBe(true);
        expect(res.tier2Fallback.recommendedPipelineCategory).toBe('image-to-3d');
        expect(res.tier2Fallback.executionTarget).toBe('cloud-run');
        expect(res.tier2Fallback.suggestedNodes).toContain('TrellisImageTo3D');
    });

    it('authors a valid pipeline blueprint for discrete props with Trellis3DGenerator and SaveMesh3D', async () => {
        const agent = new ComfyUiPipelineAgent({ mockExecution: true });
        const blueprint = await agent.researchPipeline(
            'Reconstruct 3D antique bronze statue prop from single photo using Trellis'
        );

        expect(blueprint.category).toBe('image-to-3d');
        expect(blueprint.requiredModels[0].name).toBe('trellis-image-to-3d');
        expect(blueprint.requiredCustomNodes).toContain('Trellis3DGenerator');
        expect(blueprint.requiredCustomNodes).toContain('SaveMesh3D');

        const generatorNode = blueprint.nodes.find(n => n.classType === 'Trellis3DGenerator');
        expect(generatorNode).toBeDefined();
        expect(generatorNode?.inputs.ss_sampling_steps).toBe(12);
    });

    it('executes discrete prop 3D generation remotely on Cloud Run GPU and yields binary GLB', async () => {
        const service = new ComfyUiCloudRunService({ mockExecution: true });
        const agent = new ComfyUiPipelineAgent({ mockExecution: true });
        const blueprint = await agent.researchPipeline(
            'Reconstruct 3D decorative vase prop from single photo using Trellis'
        );
        const prompt = agent.authorApiPrompt(blueprint);

        const result = await service.executeRemotePrompt(prompt, blueprint, {
            outputDir: testOutputDir,
            mockExecution: true
        });

        expect(result.success).toBe(true);
        expect(result.assets.length).toBeGreaterThanOrEqual(1);

        const meshAsset = result.assets.find(a => a.mediaKind === 'model-3d');
        expect(meshAsset).toBeDefined();
        expect(meshAsset!.filename).toMatch(/\.glb$/);
        expect(await fs.pathExists(meshAsset!.localPath!)).toBe(true);
    });
});
