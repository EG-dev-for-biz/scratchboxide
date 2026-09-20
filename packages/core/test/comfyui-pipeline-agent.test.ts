/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect, vi } from 'vitest';
import { ComfyUiBridgeService } from '../src/node/comfyui/comfyui-bridge-service';
import { ComfyUiPipelineAgent } from '../src/node/agent/comfyui-pipeline-agent';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import type { ComfyExecutionProgressEvent } from '../src/common/comfyui-protocol';

describe('ComfyUiBridgeService (Connectivity & REST API Bridge)', () => {
    it('should query system stats and mock device acceleration', async () => {
        const bridge = new ComfyUiBridgeService({ mockExecution: true });
        const stats = await bridge.getSystemStats();

        expect(stats.system.os).toBeDefined();
        expect(stats.devices.length).toBeGreaterThan(0);
        expect(stats.devices[0].vram_total).toBeGreaterThan(0);
        expect(stats.devices[0].type).toMatch(/mps|cuda|cpu/);
    });

    it('should fetch object info definitions for registered node classes', async () => {
        const bridge = new ComfyUiBridgeService({ mockExecution: true });
        const objectInfo = await bridge.getObjectInfo();

        expect(objectInfo['KSampler']).toBeDefined();
        expect(objectInfo['CheckpointLoaderSimple']).toBeDefined();
        expect(objectInfo['VAEDecode']).toBeDefined();
        expect(objectInfo['SaveImage']).toBeDefined();

        // Inspect inputs and outputs of KSampler
        const ksampler = objectInfo['KSampler'];
        expect(ksampler.input.required['model']).toBeDefined();
        expect(ksampler.input.required['steps']).toBeDefined();
        expect(ksampler.output).toContain('LATENT');
    });

    it('should query available model checkpoints and LoRAs', async () => {
        const bridge = new ComfyUiBridgeService({ mockExecution: true });
        const models = await bridge.getModels();

        expect(models.checkpoints.length).toBeGreaterThan(0);
        expect(models.checkpoints.some(c => c.includes('sd_xl_base'))).toBe(true);
        expect(models.loras.length).toBeGreaterThan(0);
    });
});

describe('ComfyUiPipelineAgent (Research, DAG Blueprint & Execution)', () => {
    it('should dynamically research and plan a text-to-image DAG pipeline', async () => {
        const agent = new ComfyUiPipelineAgent({ mockExecution: true });
        const blueprint = await agent.researchPipeline('Generate a high-tech robotic exoskeleton standing in neon rain');

        expect(blueprint.id).toBeDefined();
        expect(blueprint.category).toBe('text-to-image');
        expect(blueprint.nodes.length).toBeGreaterThanOrEqual(5);

        const nodeClasses = blueprint.nodes.map(n => n.classType);
        expect(nodeClasses).toContain('CheckpointLoaderSimple');
        expect(nodeClasses).toContain('CLIPTextEncode');
        expect(nodeClasses).toContain('KSampler');
        expect(nodeClasses).toContain('VAEDecode');
        expect(nodeClasses).toContain('SaveImage');
    });

    it('should dynamically research and plan a PBR texture extraction pipeline', async () => {
        const agent = new ComfyUiPipelineAgent({ mockExecution: true });
        const blueprint = await agent.researchPipeline('Extract PBR surface roughness and normal maps from brick wall photo');

        expect(blueprint.id).toBeDefined();
        expect(blueprint.category).toBe('pbr-texture-matrix');
        const nodeClasses = blueprint.nodes.map(n => n.classType);
        expect(nodeClasses).toContain('MarigoldDepthEstimation');
        expect(nodeClasses).toContain('SaveImage');
    });

    it('should dynamically research and plan a 3D mesh reconstruction pipeline', async () => {
        const agent = new ComfyUiPipelineAgent({ mockExecution: true });
        const blueprint = await agent.researchPipeline('Convert reference spaceship sketch into a 3D mesh model with materials');

        expect(blueprint.id).toBeDefined();
        expect(blueprint.category).toBe('image-to-3d');
        const nodeClasses = blueprint.nodes.map(n => n.classType);
        expect(nodeClasses).toContain('Trellis3DGenerator');
        expect(nodeClasses).toContain('SaveMesh3D');
    });

    it('should author valid ComfyUI API Prompt format', async () => {
        const agent = new ComfyUiPipelineAgent({ mockExecution: true });
        const blueprint = await agent.researchPipeline('Surreal dreamscape with floating islands');
        const apiPrompt = agent.authorApiPrompt(blueprint);

        expect(typeof apiPrompt).toBe('object');
        for (const [nodeId, node] of Object.entries(apiPrompt)) {
            expect(node.class_type).toBeDefined();
            expect(typeof node.inputs).toBe('object');
            // If connection is present, it must be [targetNodeId, outputIndex] tuple
            for (const [inputName, inputValue] of Object.entries(node.inputs)) {
                if (Array.isArray(inputValue)) {
                    expect(inputValue.length).toBe(2);
                    expect(typeof inputValue[0]).toBe('string');
                    expect(typeof inputValue[1]).toBe('number');
                }
            }
        }
    });

    it('should project blueprint into native Scratchbox NodeGraphData primitive', async () => {
        const agent = new ComfyUiPipelineAgent({ mockExecution: true });
        const blueprint = await agent.researchPipeline('Cybernetic samurai concept art');
        const apiPrompt = agent.authorApiPrompt(blueprint);
        const nodeGraphData = agent.convertToNodeGraphData(blueprint, apiPrompt);

        expect(nodeGraphData.title).toBeDefined();
        expect(nodeGraphData.nodes.length).toBe(blueprint.nodes.length);
        expect(nodeGraphData.edges.length).toBeGreaterThan(0);

        // Check node schema
        for (const node of nodeGraphData.nodes) {
            expect(node.id).toBeDefined();
            expect(node.label).toBeDefined();
            expect(node.category).toBeDefined();
            expect(node.x).toBeTypeOf('number');
            expect(node.y).toBeTypeOf('number');
        }

        // Check edge schema
        for (const edge of nodeGraphData.edges) {
            expect(edge.source).toBeDefined();
            expect(edge.target).toBeDefined();
            expect(edge.style).toBe('animated');
        }
    });

    it('should diagnose and heal node validation errors autonomously', async () => {
        const agent = new ComfyUiPipelineAgent({ mockExecution: true });
        const blueprint = await agent.researchPipeline('Generate fantasy castle');
        const apiPrompt = agent.authorApiPrompt(blueprint);

        // Intentionally simulate invalid checkpoint error
        const simulatedNodeErrors = {
            '1': {
                errors: [
                    { message: 'Value not in list: ckpt_name: "invalid_model.safetensors" not in [sd_xl_base_1.0.safetensors]' }
                ]
            }
        };

        const healed = await agent.healPromptWithDiagnostics(apiPrompt, simulatedNodeErrors);
        expect(healed.repairedNodeIds).toContain('1');
        expect(healed.repairedPrompt['1'].inputs['ckpt_name']).toContain('sd_xl');
        expect(healed.fixDescription).toContain('CheckpointLoaderSimple');
    });

    it('should execute pipeline end-to-end and produce assets', async () => {
        const agent = new ComfyUiPipelineAgent({ mockExecution: true });
        const progressHistory: ComfyExecutionProgressEvent[] = [];

        const result = await agent.executeAndHeal('Cinematic photorealistic portrait of an astronomer', {
            onProgress: (event) => {
                progressHistory.push(event);
            }
        });

        expect(result.success).toBe(true);
        expect(result.promptId).toBeDefined();
        expect(result.assets.length).toBeGreaterThan(0);
        expect(result.nodeGraphData.nodes.length).toBeGreaterThan(0);

        // Verify progress events were emitted across research, queue, execution, and download
        const phases = progressHistory.map(e => e.phase);
        expect(phases).toContain('research');
        expect(phases).toContain('queueing');
        expect(phases).toContain('executing');
        expect(phases).toContain('completed');
    });

    it('should execute natively (Tier 1) when native executor succeeds', async () => {
        const agent = new ComfyUiPipelineAgent({ mockExecution: true });
        const mockNativeExecutor = vi.fn().mockResolvedValue({
            meshId: 'procedural-terrain-01',
            vertices: 4096
        });

        const result = await agent.executeWithTwoTierFallback(
            'Generate 3D procedural terrain using SIMD noise',
            mockNativeExecutor
        );

        expect(result.tier).toBe('tier1-native');
        expect(result.success).toBe(true);
        expect(result.result).toEqual({ meshId: 'procedural-terrain-01', vertices: 4096 });
        expect(mockNativeExecutor).toHaveBeenCalledTimes(1);
    });

    it('should transactionally fall back to ComfyUI (Tier 2) when Tier 1 fails', async () => {
        const agent = new ComfyUiPipelineAgent({ mockExecution: true });
        const mockFailingNativeExecutor = vi.fn().mockRejectedValue(new Error('Clang compilation failed: missing header'));

        const result = await agent.executeWithTwoTierFallback(
            'Generate 3D procedural terrain',
            mockFailingNativeExecutor
        );

        expect(result.tier).toBe('tier2-comfyui');
        expect(result.success).toBe(true);
        expect(result.comfyResult).toBeDefined();
        expect(result.comfyResult?.assets.length).toBeGreaterThan(0);
        expect(mockFailingNativeExecutor).toHaveBeenCalledTimes(1);
    });

    it('should directly route to ComfyUI (Tier 2) when task is incapable of Tier 1 native execution', async () => {
        const agent = new ComfyUiPipelineAgent({ mockExecution: true });
        const mockNativeExecutor = vi.fn().mockResolvedValue({ unused: true });

        const result = await agent.executeWithTwoTierFallback(
            'Neural image-to-3D diffusion model using Trellis and TripoSR checkpoints',
            mockNativeExecutor
        );

        expect(result.tier).toBe('tier2-comfyui');
        expect(result.success).toBe(true);
        expect(result.comfyResult).toBeDefined();
        expect(mockNativeExecutor).not.toHaveBeenCalled();
    });
});

describe('Tool Registry Integration (Gemini Tool Declarations)', () => {
    it('should register ComfyUI tools in the default tool registry', () => {
        const registry = createDefaultToolRegistry();
        const declarations = registry.declarations();
        const toolNames = declarations.map(d => d.name);

        expect(toolNames).toContain('comfyui_get_status');
        expect(toolNames).toContain('comfyui_research_pipeline');
        expect(toolNames).toContain('comfyui_execute_pipeline');
    });

    it('should dispatch comfyui_get_status through the tool registry', async () => {
        const registry = createDefaultToolRegistry();
        const outcome = await registry.dispatch('comfyui_get_status', {}, {
            request: {} as any,
            workspaceRoot: process.cwd(),
            sandbox: {} as any,
            lsp: {} as any,
            contextGraph: {} as any,
            browserProxy: {} as any,
            lens: {} as any
        });

        expect(outcome.exec.status).toBe('completed');
        expect(outcome.resultPayload.status).toBeDefined();
    });

    it('should dispatch comfyui_research_pipeline through the tool registry', async () => {
        const registry = createDefaultToolRegistry();
        const outcome = await registry.dispatch('comfyui_research_pipeline', {
            goal: 'Cyberpunk flying drone delivery vehicle'
        }, {
            request: {} as any,
            workspaceRoot: process.cwd(),
            sandbox: {} as any,
            lsp: {} as any,
            contextGraph: {} as any,
            browserProxy: {} as any,
            lens: {} as any
        });

        expect(outcome.exec.status).toBe('completed');
        expect(outcome.resultPayload.status).toBe('success');
        expect(outcome.resultPayload.blueprint).toBeDefined();
        expect(outcome.resultPayload.nodeGraphData).toBeDefined();
    });
});
