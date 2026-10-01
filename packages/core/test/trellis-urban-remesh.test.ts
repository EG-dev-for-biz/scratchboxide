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

describe('TRELLIS Urban Remeshing Suite (GCP Training & Cloud Run Serving)', () => {
    const testOutputDir = path.join(__dirname, 'temp_trellis_urban_outputs');

    beforeEach(async () => {
        await fs.ensureDir(testOutputDir);
    });

    afterEach(async () => {
        await fs.remove(testOutputDir);
    });

    it('should resolve urban tile remeshing prompts to Tier 2 ComfyUI Cloud Run GPU with TrellisUrbanRemeshNode', () => {
        const res = TaskCapabilityResolver.resolveTaskCapability(
            'Remesh noisy Google Maps 3D tile with building footprint vector map using tuned trellis diffusion model'
        );

        expect(res.tier1Assessment.canSolveNatively).toBe(false);
        expect(res.tier2Fallback.needed).toBe(true);
        expect(res.tier2Fallback.recommendedPipelineCategory).toBe('image-to-3d');
        expect(res.tier2Fallback.executionTarget).toBe('cloud-run');
        expect(res.tier2Fallback.suggestedNodes).toContain('TrellisUrbanRemeshNode');
        expect(res.tier2Fallback.suggestedNodes).toContain('SaveMesh3D');
    });

    it('should author a valid pipeline blueprint with trellis-urban-remesh.safetensors checkpoint', async () => {
        const agent = new ComfyUiPipelineAgent({ mockExecution: true });
        const blueprint = await agent.researchPipeline(
            'Remesh urban building tile using Google Vector footprint and tuned trellis model'
        );

        expect(blueprint.category).toBe('image-to-3d');
        expect(blueprint.requiredModels[0].name).toBe('trellis-urban-remesh.safetensors');
        expect(blueprint.requiredCustomNodes).toContain('TrellisUrbanRemeshNode');

        const remeshNode = blueprint.nodes.find(n => n.classType === 'TrellisUrbanRemeshNode');
        expect(remeshNode).toBeDefined();
        expect(remeshNode?.inputs.planar_regularization).toBe(0.85);
        expect(remeshNode?.inputs.building_category).toBe('commercial_highrise');
    });

    it('should report trellis-urban-remesh.safetensors in Cloud Run available models and execute remotely', async () => {
        const service = new ComfyUiCloudRunService({ mockExecution: true });
        const status = await service.getServiceStatus();

        expect(status.availableModels).toContain('trellis-urban-remesh.safetensors');

        const agent = new ComfyUiPipelineAgent({ mockExecution: true });
        const blueprint = await agent.researchPipeline(
            'Remesh urban building tile using Google Vector footprint and tuned trellis model'
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
