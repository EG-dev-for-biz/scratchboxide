/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { LongRunning3DGeneratorAgent } from '../src/node/agent/long-running-3d-agent';
import type { LongRunning3DProgressEvent } from '../src/common/3d-engine-protocol';

describe('LongRunning3DGeneratorAgent (Astra-grade 3D Generation)', () => {
    it('should formulate an architectural spatial blueprint DAG', () => {
        const agent = new LongRunning3DGeneratorAgent();
        const blueprint = agent.planBlueprint('Create a futuristic cyberpunk metropolis with neon skyways', 150000);

        expect(blueprint.id).toBeDefined();
        expect(blueprint.goal).toContain('cyberpunk');
        expect(blueprint.biomes.length).toBeGreaterThan(0);
        expect(blueprint.landmarks.length).toBeGreaterThan(0);
        expect(blueprint.cppModules.length).toBe(2);
        expect(blueprint.cppModules.map(m => m.name)).toEqual(['foundation', 'structures']);
        expect(blueprint.targetPolygonBudget).toBe(150000);
    });

    it('should author valid C++20 geometry generator code for foundation and structures', () => {
        const agent = new LongRunning3DGeneratorAgent();
        const blueprint = agent.planBlueprint('Alpine mountain sanctuary with crystal spires');

        const foundationSrc = agent.authorCppModuleSource('foundation', blueprint);
        expect(foundationSrc).toContain('#include "scratchbox_engine.hpp"');
        expect(foundationSrc).toContain('math::FastNoise3D');
        expect(foundationSrc).toContain('io::GlbWriter::streamChunk');

        const structuresSrc = agent.authorCppModuleSource('structures', blueprint);
        expect(structuresSrc).toContain('geometry::MarchingCubes');
        expect(structuresSrc).toContain('sdf::sdRoundBox');
        expect(structuresSrc).toContain('io::GlbWriter::streamChunk');
    });

    it('should execute full 5-phase long-running pipeline autonomously', async () => {
        const agent = new LongRunning3DGeneratorAgent();
        const progressEvents: LongRunning3DProgressEvent[] = [];

        const result = await agent.executeFullPipeline('Cyberpunk Neo-Tokyo with elevated highway', {
            targetPolygonBudget: 50000,
            onProgress: (event) => {
                progressEvents.push(event);
            }
        });

        if (!result.success) {
            console.error('PIPELINE ERROR:', result.error);
        }

        expect(result.success).toBe(true);
        expect(result.chunks.length).toBeGreaterThanOrEqual(2);
        expect(result.totalVertices).toBeGreaterThan(1000);
        expect(result.totalTriangles).toBeGreaterThan(500);
        expect(result.checkpoints.length).toBe(2);

        // Verify progress events progressed through all 5 phases
        const phases = progressEvents.map(e => e.phase);
        expect(phases).toContain('blueprint_planning');
        expect(phases).toContain('cpp_authoring');
        expect(phases).toContain('sandboxed_compilation');
        expect(phases).toContain('progressive_streaming');
        expect(phases).toContain('viewport_vision_qa');
        expect(phases).toContain('completed');
    }, 90000);
});
