/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { AgentVerificationService } from '../src/node/gemini/agent-verification-service';
import { LspDiagnosticFeedbackService } from '../src/node/lsp-diagnostic-feedback-service';
import { ContainerSandboxService } from '../src/node/container-sandbox-service';
import { LongRunningAgentService } from '../src/node/long-running-agent-service';
import { LongRunning3DGeneratorAgent } from '../src/node/agent/long-running-3d-agent';
import { SubagentPoolService, SubagentBlackboard } from '../src/node/subagent-pool-service';
import type { AgentStreamEvent } from '../src/common/agent-checkpoint-protocol';

describe('Unified Long-Running Agent & Multi-Domain Verification Suite', () => {
    it('should verify code, visual fidelity, and geometric topology through AgentVerificationService', async () => {
        const lsp = new LspDiagnosticFeedbackService();
        const sandbox = new ContainerSandboxService();
        const verifier = new AgentVerificationService(lsp, sandbox);

        // 1. Code verification pass
        const codeResult = await verifier.verify({
            workspaceRoot: process.cwd(),
            modifiedFiles: [],
            runTests: false
        });
        expect(codeResult.passed).toBe(true);
        expect(codeResult.summary).toContain('passed cleanly');

        // 2. Visual verification domain pass with 8-dimension rubric
        const visualResult = await verifier.verifyVisual({
            screenshotPath: 'public/test_viewport.png',
            promptContext: 'Photorealistic cyberpunk neon skyscraper scene',
            minPassingScore: 8.5,
            mockEvaluation: {
                geometricDefinition: 9.0,
                pixelSplatDensity: 8.8,
                materialMicroSurface: 8.6,
                environmentalGrounding: 8.9,
                radiometricLighting: 8.7,
                colorTemperature: 8.8,
                volumetricDepth: 8.9,
                photographicRealism: 9.0
            }
        });

        expect(visualResult.passed).toBe(true);
        expect(visualResult.visualVerification?.overallScore).toBeGreaterThanOrEqual(8.5);
        expect(visualResult.visualVerification?.dimensionAudits.geometricDefinition.score).toBe(9.0);

        // 3. Visual verification fail when score is below threshold
        const visualFailResult = await verifier.verifyVisual({
            screenshotPath: 'public/test_blurry.png',
            promptContext: 'Melting deformed mesh with void background',
            minPassingScore: 8.5,
            mockEvaluation: {
                geometricDefinition: 5.0, // Failed silhouette
                pixelSplatDensity: 4.0,
                materialMicroSurface: 6.0,
                environmentalGrounding: 3.0, // Void background violation
                radiometricLighting: 5.0,
                colorTemperature: 5.0,
                volumetricDepth: 4.0,
                photographicRealism: 4.5
            }
        });

        expect(visualFailResult.passed).toBe(false);
        expect(visualFailResult.visualVerification?.overallScore).toBeLessThan(8.5);
        expect(visualFailResult.visualVerification?.remediationRecipe?.actionDirectives.length).toBeGreaterThan(0);

        // 4. Geometry verification for 3D meshes
        const geomPass = verifier.verifyGeometry({
            vertexCount: 15000,
            triangleCount: 8000,
            bounds: { min: [-10, 0, -10], max: [10, 40, 10] },
            enforcePositiveYMax: true,
            isManifold: true
        });
        expect(geomPass.passed).toBe(true);

        const geomFail = verifier.verifyGeometry({
            vertexCount: 0,
            triangleCount: 0,
            bounds: { min: [0, 0, 0], max: [0, 0, 0] },
            enforcePositiveYMax: true,
            isManifold: false
        });
        expect(geomFail.passed).toBe(false);
        expect(geomFail.geometryVerification?.warnings.length).toBeGreaterThan(0);
    });

    it('should coordinate subagent tasks through SubagentPoolService with Blackboard integration', async () => {
        const pool = new SubagentPoolService({
            maxConcurrentWorkers: 4,
            workerModel: 'gemini-3.5-flash-lite'
        });

        const blackboard = new SubagentBlackboard();
        blackboard.set('scene_bounds', {
            authorRole: 'explorer',
            confidence: 0.95,
            data: { min: [-50, 0, -50], max: [50, 120, 50] }
        });

        const entry = blackboard.get('scene_bounds');
        expect(entry).toBeDefined();
        expect(entry?.authorRole).toBe('explorer');
        expect(entry?.data.max[1]).toBe(120);

        const plan = {
            planId: `dag_plan_${Date.now()}`,
            orchestratorModel: 'gemini-3.8-flash',
            goal: 'Deconstruct architectural geometry and audit lighting',
            tasks: [
                {
                    id: 'task-1',
                    role: 'explorer' as const,
                    description: 'Explore building geometry bounds',
                    dependencies: [],
                    status: 'pending' as const,
                    execute: async (ctx: any) => {
                        ctx.blackboard.set('mesh_id', {
                            authorRole: 'explorer',
                            confidence: 0.98,
                            data: 'hero_tower_01'
                        });
                        return { meshId: 'hero_tower_01' };
                    }
                },
                {
                    id: 'task-2',
                    role: 'reviewer' as const,
                    description: 'Review mesh topology and visual compliance',
                    dependencies: ['task-1'],
                    status: 'pending' as const,
                    execute: async (ctx: any) => {
                        const prevMesh = ctx.dependencyResults['task-1']?.meshId;
                        return { verified: true, targetMesh: prevMesh };
                    }
                }
            ]
        };

        const result = await pool.executePlanDAG(plan);
        expect(result.status).toBe('completed');
        expect(result.completedTaskCount).toBe(2);
        expect(result.results['task-2'].targetMesh).toBe('hero_tower_01');
    });

    it('should execute 3D agent long-running pipeline with Phase 5 visual verification & checkpoint rollback', async () => {
        const agent = new LongRunning3DGeneratorAgent();
        const progressEvents: any[] = [];

        // 1. Run pipeline with standard generation
        const result = await agent.executeFullPipeline('Futuristic vertical cyber tower', {
            targetPolygonBudget: 40000,
            onProgress: (event) => progressEvents.push(event)
        });

        expect(result.success).toBe(true);
        expect(result.totalVertices).toBeGreaterThan(500);
        expect(result.checkpoints.length).toBeGreaterThanOrEqual(2);

        // Verify visual QA was triggered
        const visionEvent = progressEvents.find(e => e.phase === 'viewport_vision_qa');
        expect(visionEvent).toBeDefined();
        expect(visionEvent.visualFidelityScore).toBeDefined();
        expect(visionEvent.visualFidelityScore).toBeGreaterThanOrEqual(8.5);
    }, 180000);

    it('should trigger checkpoint rollback on degenerate 3D geometry in long-running agent', async () => {
        const agent = new LongRunning3DGeneratorAgent();

        // Simulate degenerate mesh audit
        const audit = agent.auditSpatialGeometry({
            chunks: [],
            totalVertices: 0,
            totalTriangles: 0
        });

        expect(audit.passed).toBe(false);
        expect(audit.reason).toContain('0 vertices');
    });
});
