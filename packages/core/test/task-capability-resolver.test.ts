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
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';

describe('TaskCapabilityResolver', () => {
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

    describe('Native resolution', () => {
        it('resolves procedural 3D terrain natively via C++20 Scratchbox Engine', () => {
            const res = TaskCapabilityResolver.resolveTaskCapability(
                'Create a procedural mountain terrain with FastNoise3D and Marching Cubes SDFs'
            );

            expect(res.canSolveNatively).toBe(true);
            expect(res.tier1Assessment.canSolveNatively).toBe(true);
            expect(res.tier1Assessment.primaryNativeEngine).toBe('cpp-3d-engine');
            expect(res.tier1Assessment.nativeCapabilitiesUsed).toEqual(
                expect.arrayContaining([
                    expect.stringContaining('Scratchbox C++20 3D Engine'),
                    expect.stringContaining('NativeCppCompilerService')
                ])
            );
            expect(res.tier1Assessment.suggestedNativeAction?.primitiveType).toBe('3d-scene');
        });

        it('resolves VFX plate matchmoving and solar ephemeris natively via VfxPlateMatchmoveService', () => {
            const res = TaskCapabilityResolver.resolveTaskCapability(
                'Interpolate 6-DOF camera solve track, Brown-Conrady lens distortion, and align sun via NOAA ephemeris'
            );

            expect(res.canSolveNatively).toBe(true);
            expect(res.tier1Assessment.canSolveNatively).toBe(true);
            expect(res.tier1Assessment.primaryNativeEngine).toBe('vfx-matchmove-nle');
            expect(res.tier1Assessment.nativeCapabilitiesUsed).toEqual(
                expect.arrayContaining([
                    expect.stringContaining('VfxPlateMatchmoveService'),
                    expect.stringContaining('NOAA Geodetic Ephemeris Solar Position Calculator')
                ])
            );
            expect(res.tier1Assessment.suggestedNativeAction?.primitiveType).toBe('video-timeline');
        });

        it('resolves multi-track NLE and anti-drift holdout mattes natively', () => {
            const res = TaskCapabilityResolver.resolveTaskCapability(
                'Assemble multi-track timeline with foreground actor holdout matte and destination-out occlusion'
            );

            expect(res.canSolveNatively).toBe(true);
            expect(res.tier1Assessment.canSolveNatively).toBe(true);
            expect(res.tier1Assessment.primaryNativeEngine).toBe('vfx-matchmove-nle');
            expect(res.tier1Assessment.nativeCapabilitiesUsed).toEqual(
                expect.arrayContaining([
                    expect.stringContaining('VideoTimelineSynthesizer'),
                    expect.stringContaining('Destination-Out Holdout Matte Compositor')
                ])
            );
        });

        it('resolves workspace coding and refactoring tasks natively', () => {
            const res = TaskCapabilityResolver.resolveTaskCapability(
                'Refactor videoTypes.ts and fix typescript compilation errors'
            );

            expect(res.canSolveNatively).toBe(true);
            expect(res.tier1Assessment.canSolveNatively).toBe(true);
            expect(res.tier1Assessment.primaryNativeEngine).toBe('workspace-coding');
        });

        it('resolves 3D scenes, urban environments, and architectural layouts natively in codebase', () => {
            const res = TaskCapabilityResolver.resolveTaskCapability(
                'Generate an urban 3D scene with skyscraper blocks, street corridors, and architectural facades'
            );

            expect(res.canSolveNatively).toBe(true);
            expect(res.tier1Assessment.canSolveNatively).toBe(true);
            expect(res.tier1Assessment.primaryNativeEngine).toBe('cpp-3d-engine');
        });

        it('resolves procedural buildings and architecture via Python 3D engine (Blender mental model)', () => {
            const res = TaskCapabilityResolver.resolveTaskCapability(
                'Create a procedural building with mansard roofs, rhythmic windows, and space-colonization trees using Python scripting'
            );

            expect(res.canSolveNatively).toBe(true);
            expect(res.tier1Assessment.canSolveNatively).toBe(true);
            expect(res.tier1Assessment.primaryNativeEngine).toBe('python-3d-engine');
            expect(res.tier1Assessment.nativeCapabilitiesUsed).toEqual(
                expect.arrayContaining([
                    expect.stringContaining('Procedural Python 3D Engine'),
                    expect.stringContaining('NativePythonRunnerService'),
                    expect.stringContaining('sb.create_building')
                ])
            );
            expect(res.tier1Assessment.suggestedNativeAction?.serviceOrTool).toContain('execute_3d_python_script');
        });
    });

    describe('Unsupported neural tasks', () => {
        it('reports neural image-to-3D mesh diffusion (Trellis) as not natively solvable', () => {
            const res = TaskCapabilityResolver.resolveTaskCapability(
                'Reconstruct 3D mesh from single photo using Trellis image-to-3d diffusion model',
                { hasInputImage: true }
            );

            expect(res.canSolveNatively).toBe(false);
            expect(res.tier1Assessment.primaryNativeEngine).toBe('none');
            expect(res.rationale).toMatch(/not natively supported/i);
        });

        it('reports neural video-to-video restyling (AnimateDiff) as not natively solvable', () => {
            const res = TaskCapabilityResolver.resolveTaskCapability(
                'Restyle real drone video footage into a cyberpunk anime sequence using animatediff and controlnet',
                { hasInputVideo: true }
            );

            expect(res.canSolveNatively).toBe(false);
            expect(res.rationale).toMatch(/not natively supported/i);
        });

        it('reports monocular dense depth estimation (Marigold) as not natively solvable', () => {
            const res = TaskCapabilityResolver.resolveTaskCapability(
                'Extract high-resolution monocular depth map using Marigold depth estimation'
            );

            expect(res.canSolveNatively).toBe(false);
            expect(res.rationale).toMatch(/not natively supported/i);
        });
    });

    describe('Tool registry', () => {
        it('no longer registers a resolve_task_capability agent tool', () => {
            const registry = createDefaultToolRegistry();
            expect(registry.getTool('resolve_task_capability')).toBeUndefined();
            expect(registry.getTool('comfyui_execute_pipeline')).toBeUndefined();
        });
    });
});
