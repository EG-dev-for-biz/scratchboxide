/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';
import { ComfyUiPipelineAgent } from '../src/node/agent/comfyui-pipeline-agent';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';

describe('TaskCapabilityResolver (Two-Tier Problem-Solving Architecture)', () => {
    describe('classifyTaskDomain', () => {
        it('identifies 3D tasks', () => {
            expect(TaskCapabilityResolver.classifyTaskDomain('generate a procedural alpine mountain terrain with SDF marching cubes')).toBe('3d');
            expect(TaskCapabilityResolver.classifyTaskDomain('load photorealistic 3d tiles and convert to glb')).toBe('3d');
        });

        it('identifies VFX & video tasks', () => {
            expect(TaskCapabilityResolver.classifyTaskDomain('solve 6-DOF camera track and align solar ephemeris')).toBe('vfx');
            expect(TaskCapabilityResolver.classifyTaskDomain('multi-track video timeline with actor occlusion holdout matte')).toBe('vfx');
            expect(TaskCapabilityResolver.classifyTaskDomain('split clip at playhead and ripple delete')).toBe('vfx');
        });

        it('identifies deep generative tasks', () => {
            expect(TaskCapabilityResolver.classifyTaskDomain('reconstruct 3d mesh from single photo using trellis diffusion')).toBe('generative');
            expect(TaskCapabilityResolver.classifyTaskDomain('restyle video into cyberpunk anime with animatediff latent diffusion')).toBe('generative');
            expect(TaskCapabilityResolver.classifyTaskDomain('monocular depth estimation using marigold')).toBe('generative');
        });

        it('identifies coding tasks', () => {
            expect(TaskCapabilityResolver.classifyTaskDomain('refactor TypeScript class to improve lsp diagnostics')).toBe('code');
            expect(TaskCapabilityResolver.classifyTaskDomain('fix build error in api endpoint')).toBe('code');
        });

        it('falls back to general for conversational tasks', () => {
            expect(TaskCapabilityResolver.classifyTaskDomain('what is the capital of France?')).toBe('general');
        });
    });

    describe('Tier 1 Native Resolution (Look Through App Capabilities First)', () => {
        it('resolves procedural 3D terrain natively via C++20 Scratchbox Engine', () => {
            const res = TaskCapabilityResolver.resolveTaskCapability(
                'Create a procedural mountain terrain with FastNoise3D and Marching Cubes SDFs'
            );

            expect(res.recommendedResolutionRoute).toBe('tier1-native');
            expect(res.tier1Assessment.canSolveNatively).toBe(true);
            expect(res.tier1Assessment.primaryNativeEngine).toBe('cpp-3d-engine');
            expect(res.tier1Assessment.nativeCapabilitiesUsed).toEqual(
                expect.arrayContaining([
                    expect.stringContaining('Scratchbox C++20 3D Engine'),
                    expect.stringContaining('NativeCppCompilerService')
                ])
            );
            expect(res.tier1Assessment.suggestedNativeAction?.primitiveType).toBe('3d-scene');
            expect(res.tier2Fallback.needed).toBe(false);
        });

        it('resolves VFX plate matchmoving and solar ephemeris natively via VfxPlateMatchmoveService', () => {
            const res = TaskCapabilityResolver.resolveTaskCapability(
                'Interpolate 6-DOF camera solve track, Brown-Conrady lens distortion, and align sun via NOAA ephemeris'
            );

            expect(res.recommendedResolutionRoute).toBe('tier1-native');
            expect(res.tier1Assessment.canSolveNatively).toBe(true);
            expect(res.tier1Assessment.primaryNativeEngine).toBe('vfx-matchmove-nle');
            expect(res.tier1Assessment.nativeCapabilitiesUsed).toEqual(
                expect.arrayContaining([
                    expect.stringContaining('VfxPlateMatchmoveService'),
                    expect.stringContaining('NOAA Geodetic Ephemeris Solar Position Calculator')
                ])
            );
            expect(res.tier1Assessment.suggestedNativeAction?.primitiveType).toBe('video-timeline');
            expect(res.tier2Fallback.needed).toBe(false);
        });

        it('resolves multi-track NLE and anti-drift holdout mattes natively', () => {
            const res = TaskCapabilityResolver.resolveTaskCapability(
                'Assemble multi-track timeline with foreground actor holdout matte and destination-out occlusion'
            );

            expect(res.recommendedResolutionRoute).toBe('tier1-native');
            expect(res.tier1Assessment.canSolveNatively).toBe(true);
            expect(res.tier1Assessment.primaryNativeEngine).toBe('vfx-matchmove-nle');
            expect(res.tier1Assessment.nativeCapabilitiesUsed).toEqual(
                expect.arrayContaining([
                    expect.stringContaining('VideoTimelineSynthesizer'),
                    expect.stringContaining('Destination-Out Holdout Matte Compositor')
                ])
            );
            expect(res.tier2Fallback.needed).toBe(false);
        });

        it('resolves workspace coding and refactoring tasks natively', () => {
            const res = TaskCapabilityResolver.resolveTaskCapability(
                'Refactor videoTypes.ts and fix typescript compilation errors'
            );

            expect(res.recommendedResolutionRoute).toBe('tier1-native');
            expect(res.tier1Assessment.canSolveNatively).toBe(true);
            expect(res.tier1Assessment.primaryNativeEngine).toBe('workspace-coding');
            expect(res.tier2Fallback.needed).toBe(false);
        });

        it('resolves 3D scenes, urban environments, and architectural layouts natively in codebase with zero fallback to Trellis', () => {
            const res = TaskCapabilityResolver.resolveTaskCapability(
                'Generate an urban 3D scene with skyscraper blocks, street corridors, and architectural facades'
            );

            expect(res.recommendedResolutionRoute).toBe('tier1-native');
            expect(res.tier1Assessment.canSolveNatively).toBe(true);
            expect(res.tier1Assessment.primaryNativeEngine).toBe('cpp-3d-engine');
            expect(res.tier2Fallback.needed).toBe(false);
            expect(res.tier2Fallback.suggestedNodes).not.toContain('TrellisUrbanRemeshNode');
        });
    });

    describe('Tier 2 ComfyUI Fallback Resolution (Resort to ComfyUI if Incapable)', () => {
        it('resorts to ComfyUI Cloud Run GPU for neural image-to-3D mesh diffusion (Trellis)', () => {
            const res = TaskCapabilityResolver.resolveTaskCapability(
                'Reconstruct 3D mesh from single photo using Trellis image-to-3d diffusion model',
                { hasInputImage: true }
            );

            expect(res.recommendedResolutionRoute).toBe('tier2-comfyui');
            expect(res.tier1Assessment.canSolveNatively).toBe(false);
            expect(res.tier2Fallback.needed).toBe(true);
            expect(res.tier2Fallback.recommendedPipelineCategory).toBe('image-to-3d');
            expect(res.tier2Fallback.executionTarget).toBe('cloud-run');
            expect(res.tier2Fallback.suggestedNodes).toContain('TrellisImageTo3D');
            expect(res.tier2Fallback.suggestedNodes).toContain('SaveGLB');
            expect(res.tier2Fallback.requiresDynamicNodes).toBe(true);
            expect(res.tier2Fallback.suggestedDynamicClasses).toContain('SaveGLB');
        });

        it('resorts to ComfyUI Cloud Run GPU for neural video-to-video restyling (Omni / AnimateDiff)', () => {
            const res = TaskCapabilityResolver.resolveTaskCapability(
                'Restyle real drone video footage into a cyberpunk anime sequence using animatediff and controlnet',
                { hasInputVideo: true }
            );

            expect(res.recommendedResolutionRoute).toBe('tier2-comfyui');
            expect(res.tier1Assessment.canSolveNatively).toBe(false);
            expect(res.tier2Fallback.needed).toBe(true);
            expect(res.tier2Fallback.recommendedPipelineCategory).toBe('video-generation');
            expect(res.tier2Fallback.executionTarget).toBe('cloud-run');
            expect(res.tier2Fallback.suggestedNodes).toContain('AnimateDiffLoader');
        });

        it('resorts to ComfyUI for monocular dense depth estimation (Marigold)', () => {
            const res = TaskCapabilityResolver.resolveTaskCapability(
                'Extract high-resolution monocular depth map using Marigold depth estimation'
            );

            expect(res.recommendedResolutionRoute).toBe('tier2-comfyui');
            expect(res.tier1Assessment.canSolveNatively).toBe(false);
            expect(res.tier2Fallback.needed).toBe(true);
            expect(res.tier2Fallback.recommendedPipelineCategory).toBe('depth-estimation');
            expect(res.tier2Fallback.suggestedNodes).toContain('MarigoldDepthEstimation');
        });

        it('resorts to ComfyUI when user explicitly requests ComfyUI workflow', () => {
            const res = TaskCapabilityResolver.resolveTaskCapability(
                'Build a ComfyUI node graph pipeline with custom checkpoint loader',
                { forceComfyUi: true }
            );

            expect(res.recommendedResolutionRoute).toBe('tier2-comfyui');
            expect(res.tier1Assessment.canSolveNatively).toBe(false);
            expect(res.tier2Fallback.needed).toBe(true);
        });
    });

    describe('ComfyUiPipelineAgent Capability Integration', () => {
        it('agent exposes assessTaskCapability matching TaskCapabilityResolver', () => {
            const agent = new ComfyUiPipelineAgent({ mockExecution: true });
            const assessment = agent.assessTaskCapability(
                'Synthesize procedural flight corridor with C++20 engine and Marching Cubes'
            );

            expect(assessment.recommendedResolutionRoute).toBe('tier1-native');
            expect(assessment.tier1Assessment.canSolveNatively).toBe(true);
        });

        it('executeAndHeal records capabilityResolution in output', async () => {
            const agent = new ComfyUiPipelineAgent({ mockExecution: true });
            const result = await agent.executeAndHeal('photo to 3d mesh reconstruction with trellis', {
                mockExecution: true
            });

            expect(result.capabilityResolution).toBeDefined();
            expect(result.capabilityResolution.recommendedResolutionRoute).toBe('tier2-comfyui');
            expect(result.capabilityResolution.tier2Fallback.recommendedPipelineCategory).toBe('image-to-3d');
        });

        it('refuses to fall back to Trellis or external 3D services when native 3D scene generation encounters an error', async () => {
            const agent = new ComfyUiPipelineAgent({ mockExecution: true });
            const failingNativeExecutor = async () => {
                throw new Error('Simulated Clang compilation failure on urban scene generator');
            };

            const result = await agent.executeWithTwoTierFallback(
                'Synthesize procedural urban 3D scene with architectural facades and road corridors',
                failingNativeExecutor
            );

            // Scenes must NEVER fall back to Trellis or Tier 2 ComfyUI
            expect(result.tier).toBe('tier1-native');
            expect(result.success).toBe(false);
            expect(result.error).toContain('3D scenes and environments are created natively in codebase');
            expect(result.error).toContain('cannot fall back to Trellis or external 3D neural services');
        });
    });

    describe('Tool Registry resolve_task_capability tool', () => {
        it('registers resolve_task_capability tool in default registry', () => {
            const registry = createDefaultToolRegistry();
            expect(registry.getTool('resolve_task_capability')).toBeDefined();
        });

        it('executes resolve_task_capability via tool registry for native 3D task', async () => {
            const registry = createDefaultToolRegistry();
            const tool = registry.getTool('resolve_task_capability');
            expect(tool).toBeDefined();

            const response = await tool!.handler(
                { taskGoal: 'Generate an intricate 3D procedural terrain using C++20 and SIMD noise' },
                { workspaceRoot: process.cwd(), activeArtifacts: [] }
            );

            expect(response.resultPayload.recommendedResolutionRoute).toBe('tier1-native');
            expect(response.resultPayload.tier1Assessment.primaryNativeEngine).toBe('cpp-3d-engine');
            expect(response.summaryResult).toContain('Tier 1 Native Resolution recommended');
        });

        it('executes resolve_task_capability via tool registry for neural video restyling', async () => {
            const registry = createDefaultToolRegistry();
            const tool = registry.getTool('resolve_task_capability');
            expect(tool).toBeDefined();

            const response = await tool!.handler(
                { taskGoal: 'Restyle video to video with animatediff temporal restyling' },
                { workspaceRoot: process.cwd(), activeArtifacts: [] }
            );

            expect(response.resultPayload.recommendedResolutionRoute).toBe('tier2-comfyui');
            expect(response.resultPayload.tier2Fallback.recommendedPipelineCategory).toBe('video-generation');
            expect(response.summaryResult).toContain('Tier 2 ComfyUI Fallback required');
        });
    });
});
