/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';
import { buildSystemInstruction } from '../src/node/gemini/prompt-builder';
import { DEFAULT_SKILLS_CATALOG } from '../src/browser/generative-canvas/canvas-types';

describe('In-App Universal 3D Structure & Animation Agent Infrastructure', () => {
    const registry = createDefaultToolRegistry();

    const mockToolContext: any = {
        request: { prompt: 'Test universal 3d structure' },
        workspaceRoot: process.cwd(),
        sandbox: {} as any,
        lsp: {} as any,
        contextGraph: {} as any,
        browserProxy: {} as any,
        lens: {} as any
    };

    it('registers all 4 universal 3D structure tools in the default tool registry', () => {
        const declarations = registry.declarations();
        const names = declarations.map(d => d.name);

        expect(names).toContain('universal_3d_structure_create');
        expect(names).toContain('universal_3d_structure_export');
        expect(names).toContain('universal_3d_structure_animate');
        expect(names).toContain('universal_3d_structure_get_collision_hull');
    });

    it('executes universal_3d_structure_create to synthesize a canonical foundation', async () => {
        const result = await registry.dispatch(
            'universal_3d_structure_create',
            {
                name: 'test_pyramid',
                proceduralType: 'box',
                scale: 15.0,
                numViews: 12,
                pointDensity: 500,
                anchor: { lat: 45.9763, lng: 7.6586, elevationMeters: 4478 }
            },
            mockToolContext
        );

        expect(result.exec.status).toBe('completed');
        expect(result.resultPayload.success).toBe(true);
        const structure = result.resultPayload.structure as any;
        expect(structure.name).toBe('test_pyramid');
        expect(structure.vertexCount).toBeGreaterThan(0);
        expect(structure.pointCount).toBe(500);
        expect(structure.cameraCount).toBe(12);
        expect(structure.collisionHull.vertexCount).toBeGreaterThan(0);
        expect(structure.anchor.lat).toBe(45.9763);
    });

    it('executes universal_3d_structure_get_collision_hull', async () => {
        const result = await registry.dispatch(
            'universal_3d_structure_get_collision_hull',
            {
                name: 'test_pyramid'
            },
            mockToolContext
        );

        expect(result.exec.status).toBe('completed');
        expect(result.resultPayload.success).toBe(true);
        const hull = result.resultPayload.collisionHull as any;
        expect(hull.dimensions[0]).toBeGreaterThan(0);
        expect(hull.radius).toBeGreaterThan(0);
        expect(hull.convexVertices.length).toBeGreaterThan(0);
        expect(hull.indices.length).toBeGreaterThan(0);
    });

    it('executes universal_3d_structure_animate and mounts to Video Timeline NLE primitive', async () => {
        const result = await registry.dispatch(
            'universal_3d_structure_animate',
            {
                name: 'test_pyramid',
                clipName: 'Drone Orbit Survey',
                durationSeconds: 5.0,
                fps: 30,
                cameraTrajectory: 'orbit',
                mountToVideoTimeline: true,
                timelineStartTime: 2.0
            },
            mockToolContext
        );

        expect(result.exec.status).toBe('completed');
        expect(result.resultPayload.success).toBe(true);
        expect(result.resultPayload.clipName).toBe('Drone Orbit Survey');
        expect(result.resultPayload.durationSeconds).toBe(5.0);

        const el = result.resultPayload.timelineElement as any;
        expect(el).toBeDefined();
        expect(el.type).toBe('3d');
        expect(el.startTime).toBe(2.0);
        expect(el.duration).toBe(5.0);
        expect(el.keyframes).toBeDefined();
        // Check that keyframes contain diamond markers
        const keys = Object.keys(el.keyframes);
        expect(keys.length).toBeGreaterThan(0);
        const firstTrackKeyframes = el.keyframes[keys[0]];
        expect(firstTrackKeyframes.length).toBeGreaterThan(1);
    });

    it('executes universal_3d_structure_export to glTF 2.0, COLMAP, Nerfstudio, and all formats', async () => {
        // Single glb export
        const glbResult = await registry.dispatch(
            'universal_3d_structure_export',
            {
                name: 'test_pyramid',
                format: 'glb'
            },
            mockToolContext
        );
        expect(glbResult.exec.status).toBe('completed');
        expect(glbResult.resultPayload.success).toBe(true);
        expect((glbResult.resultPayload.details as any).byteLength).toBeGreaterThan(0);

        // Export all formats
        const allResult = await registry.dispatch(
            'universal_3d_structure_export',
            {
                name: 'test_pyramid',
                format: 'all'
            },
            mockToolContext
        );
        expect(allResult.exec.status).toBe('completed');
        expect(allResult.resultPayload.success).toBe(true);
        expect((allResult.resultPayload as any).glbBytes).toBeGreaterThan(0);
        expect((allResult.resultPayload as any).colmapImagesCount).toBeGreaterThan(0);
        expect((allResult.resultPayload as any).nerfstudioTransformsFrames).toBeGreaterThan(0);
        expect((allResult.resultPayload as any).collisionHullVertices).toBeGreaterThan(0);
        expect((allResult.resultPayload as any).geoJsonFeatures).toBeGreaterThan(0);
    });

    it('TaskCapabilityResolver classifies universal 3D structure and animation requests as Tier 1 Native', () => {
        const resolution1 = TaskCapabilityResolver.resolveTaskCapability({
            userGoal: 'Synthesize a canonical universal 3D structure and export to COLMAP and Nerfstudio 3DGS'
        });

        expect(resolution1.canSolveNatively).toBe(true);
        expect(resolution1.canSolveNatively).toBe(true);
        expect(resolution1.tier1Assessment.primaryNativeEngine).toBe('cpp-3d-engine');
        expect(resolution1.tier1Assessment.nativeCapabilitiesUsed.join(' ')).toContain('Universal 3D Structure Foundation');
        expect(resolution1.tier1Assessment.nativeCapabilitiesUsed.join(' ')).toContain('In-App Agent Tools');

        const resolution2 = TaskCapabilityResolver.resolveTaskCapability({
            userGoal: 'Animate a continuous 3D camera arc with keyframe diamonds on the video timeline'
        });

        expect(resolution2.canSolveNatively).toBe(true);
        expect(resolution2.canSolveNatively).toBe(true);
        expect(resolution2.tier1Assessment.nativeCapabilitiesUsed.join(' ')).toContain('Universal Continuous-Time Animation Engine');
    });

    it('buildSystemInstruction teaches the in-app Gemini agent the Universal 3D Structure directives and tools', async () => {
        const systemPrompt = await buildSystemInstruction({
            prompt: 'Create 3D asset',
            mode: 'coding'
        });

        expect(systemPrompt).toContain('Universal 3D Structure & Continuous Animation');
        expect(systemPrompt).toContain('Universal3DStructureFoundation');
        expect(systemPrompt).toContain('universal_3d_structure_create');
        expect(systemPrompt).toContain('universal_3d_structure_export');
        expect(systemPrompt).toContain('universal_3d_structure_animate');
        expect(systemPrompt).toContain('universal_3d_structure_get_collision_hull');
    });

    it('DEFAULT_SKILLS_CATALOG contains Universal 3D Structure and Universal Animation skills in the in-app catalog', () => {
        const skill3D = DEFAULT_SKILLS_CATALOG.find(s => s.id === 'skill-universal-3d-structure');
        expect(skill3D).toBeDefined();
        expect(skill3D?.name).toBe('Universal 3D Structure Foundation');
        expect(skill3D?.category).toBe('Engineering');
        expect(skill3D?.tags).toContain('Universal 3D');
        expect(skill3D?.rawContent).toContain('UNIVERSAL 3D STRUCTURE FOUNDATION DIRECTIVE');
        expect(skill3D?.promptStarters.length).toBeGreaterThan(0);

        const skillAnim = DEFAULT_SKILLS_CATALOG.find(s => s.id === 'skill-universal-animation-timeline');
        expect(skillAnim).toBeDefined();
        expect(skillAnim?.name).toBe('Universal Animation & Timeline NLE');
        expect(skillAnim?.category).toBe('Design');
        expect(skillAnim?.tags).toContain('Continuous Time');
        expect(skillAnim?.rawContent).toContain('UNIVERSAL ANIMATION & TIMELINE NLE DIRECTIVE');
        expect(skillAnim?.promptStarters.length).toBeGreaterThan(0);
    });
});
