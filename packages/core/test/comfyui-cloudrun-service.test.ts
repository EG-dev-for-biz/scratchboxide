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
import { ToolRegistry, createDefaultToolRegistry } from '../src/node/gemini/tool-registry';

describe('ComfyUiCloudRunService & Remote Execution Suite', () => {
    const testOutputDir = path.join(__dirname, 'temp_cloudrun_outputs');

    beforeEach(async () => {
        await fs.ensureDir(testOutputDir);
    });

    afterEach(async () => {
        await fs.remove(testOutputDir);
    });

    describe('ComfyUiCloudRunService Client', () => {
        it('should report ready status, NVIDIA L4 GPU acceleration, and low latency in mock mode', async () => {
            const service = new ComfyUiCloudRunService({ mockExecution: true });
            const status = await service.getServiceStatus();

            expect(status.status).toBe('ready');
            expect(status.gpuAccelerated).toBe(true);
            expect(status.gpuType).toContain('NVIDIA L4');
            expect(status.latencyMs).toBeGreaterThan(0);
            expect(status.availableModels).toContain('trellis-image-to-3d');
            expect(await service.isAvailable()).toBe(true);
        });

        it('should execute 3D mesh reconstruction pipeline remotely and generate binary GLB asset', async () => {
            const service = new ComfyUiCloudRunService({ mockExecution: true });
            const agent = new ComfyUiPipelineAgent({ mockExecution: true });
            const blueprint = await agent.researchPipeline('Generate 3D game mesh asset from reference photo');
            const prompt = agent.authorApiPrompt(blueprint);

            const result = await service.executeRemotePrompt(prompt, blueprint, {
                outputDir: testOutputDir,
                mockExecution: true
            });

            expect(result.success).toBe(true);
            expect(result.promptId).toContain('cr-');
            expect(result.assets.length).toBeGreaterThanOrEqual(1);

            const meshAsset = result.assets.find(a => a.mediaKind === 'model-3d');
            expect(meshAsset).toBeDefined();
            expect(meshAsset!.filename).toMatch(/\.glb$/);
            expect(meshAsset!.mimeType).toBe('model/gltf-binary');
            expect(await fs.pathExists(meshAsset!.localPath!)).toBe(true);
        });

        it('should download assets directly from the remote service view endpoint', async () => {
            const service = new ComfyUiCloudRunService({ mockExecution: true });
            const buffer = await service.downloadAsset('cloudrun_asset_test.glb');

            expect(buffer).toBeInstanceOf(Buffer);
            expect(buffer.length).toBeGreaterThan(0);
            expect(buffer.toString('utf8', 0, 4)).toBe('glTF');
        });

        it('should query upstream parity info and report commits behind', async () => {
            const service = new ComfyUiCloudRunService({ mockExecution: true });
            const info = await service.getUpstreamVersionInfo();

            expect(info).toBeDefined();
            expect(info.repositoryUrl).toContain('comfyanonymous/ComfyUI');
            expect(info.branch).toBe('master');
            expect(info.currentCommit).toBeDefined();
            expect(info.upstreamCommit).toBeDefined();
            expect(typeof info.upToDate).toBe('boolean');
            expect(typeof info.commitsBehind).toBe('number');
        });

        it('should perform hot-sync with upstream comfyanonymous/ComfyUI repository', async () => {
            const service = new ComfyUiCloudRunService({ mockExecution: true });
            const syncRes = await service.syncUpstream();

            expect(syncRes.success).toBe(true);
            expect(syncRes.message).toContain('upstream');
            expect(syncRes.previousCommit).toBeDefined();
            expect(syncRes.newCommit).toBeDefined();
        });

        it('should inject dynamic Python custom node code into Cloud Run runtime', async () => {
            const service = new ComfyUiCloudRunService({ mockExecution: true });
            const dynamicModule = {
                moduleName: 'custom_spatial_filter',
                code: `
class SpatialVoxelFilter:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {"mesh": ("MESH_3D",), "voxel_size": ("FLOAT", {"default": 0.05})}}
    RETURN_TYPES = ("MESH_3D",)
    FUNCTION = "filter_voxels"
    CATEGORY = "3d/geometry"

    def filter_voxels(self, mesh, voxel_size=0.05):
        return (mesh,)

NODE_CLASS_MAPPINGS = {"SpatialVoxelFilter": SpatialVoxelFilter}
`,
                nodeClasses: ['SpatialVoxelFilter'],
                description: 'Spatial 3D Voxel filtering node'
            };

            const result = await service.injectDynamicCode(dynamicModule);
            expect(result.success).toBe(true);
            expect(result.registeredClasses).toContain('SpatialVoxelFilter');
            expect(result.persistedPath).toContain('dynamic_custom_spatial_filter.py');
        });

        it('should analyze provided workflow JSON and auto-synthesize missing node dependencies', async () => {
            const service = new ComfyUiCloudRunService({ mockExecution: true });
            const rawWorkflowPrompt = {
                '1': {
                    class_type: 'CheckpointLoaderSimple',
                    inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' }
                },
                '2': {
                    class_type: 'MeshDecimatorNode',
                    inputs: { mesh: ['1', 0], target_faces: 5000 }
                },
                '3': {
                    class_type: 'SaveGLB',
                    inputs: { mesh: ['2', 0], filename_prefix: 'Decimated_Mesh' }
                }
            };

            const report = await service.prepareWorkflowDependencies(rawWorkflowPrompt);
            expect(report).toBeDefined();
            expect(report.requiredNodes).toContain('MeshDecimatorNode');
            expect(report.requiredNodes).toContain('SaveGLB');
            expect(report.ready).toBe(true);
        });
    });

    describe('ComfyUiPipelineAgent Cloud Run Routing & Dynamic Synthesis', () => {
        it('should route execution to Cloud Run when targetEnvironment is "cloud-run"', async () => {
            const agent = new ComfyUiPipelineAgent({
                mockExecution: true,
                outputDir: testOutputDir,
                cloudRun: { mockExecution: true }
            });

            const progressEvents: string[] = [];
            const result = await agent.executeAndHeal('Photorealistic architectural facade rendering', {
                targetEnvironment: 'cloud-run',
                outputDir: testOutputDir,
                mockExecution: true,
                onProgress: evt => progressEvents.push(evt.message)
            });

            expect(result.success).toBe(true);
            expect(result.assets.length).toBeGreaterThanOrEqual(1);
            expect(result.nodeGraphData).toBeDefined();
            expect(result.nodeGraphData!.nodes.length).toBeGreaterThan(0);

            // Verify progress messaging contained Cloud Run routing notification
            const routedToCloudRun = progressEvents.some(msg => msg.toLowerCase().includes('cloud run'));
            expect(routedToCloudRun).toBe(true);
        });

        it('should automatically offload 3D mesh reconstruction to Cloud Run in auto mode', async () => {
            const agent = new ComfyUiPipelineAgent({
                mockExecution: true,
                outputDir: testOutputDir,
                cloudRun: { mockExecution: true }
            });

            // "image-to-3d" category is heavy and should be routed to Cloud Run in auto mode
            const result = await agent.executeAndHeal('Reconstruct 3D quad-topology mesh from concept art', {
                targetEnvironment: 'cloud-run',
                outputDir: testOutputDir,
                mockExecution: true
            });

            expect(result.success).toBe(true);
            expect(result.blueprint.category).toBe('image-to-3d');
            const glbAsset = result.assets.find(a => a.mediaKind === 'model-3d');
            expect(glbAsset).toBeDefined();
        });

        it('should synthesize valid ComfyUI Python custom node code dynamically for specific tasks', async () => {
            const agent = new ComfyUiPipelineAgent({ mockExecution: true });

            const glbModule = agent.synthesizeCustomNodeCode('SaveGLB', 'Export 3D model to binary glTF');
            expect(glbModule.nodeClasses).toContain('SaveGLB');
            expect(glbModule.code).toContain('class SaveGLB:');
            expect(glbModule.code).toContain('NODE_CLASS_MAPPINGS = {"SaveGLB": SaveGLB}');

            const decimatorModule = agent.synthesizeCustomNodeCode('MeshDecimatorNode', 'Reduce mesh polygon count');
            expect(decimatorModule.nodeClasses).toContain('MeshDecimatorNode');
            expect(decimatorModule.code).toContain('class MeshDecimatorNode:');
            expect(decimatorModule.code).toContain('target_faces');

            const pbrModule = agent.synthesizeCustomNodeCode('PBRMaterialComposer', 'Assemble PBR textures');
            expect(pbrModule.nodeClasses).toContain('PBRMaterialComposer');
            expect(pbrModule.code).toContain('class PBRMaterialComposer:');
        });

        it('should execute arbitrary provided JSON workflow directly and auto-inject dependencies', async () => {
            const agent = new ComfyUiPipelineAgent({
                mockExecution: true,
                outputDir: testOutputDir,
                cloudRun: { mockExecution: true }
            });

            const workflow = {
                '1': {
                    class_type: 'CheckpointLoaderSimple',
                    inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' }
                },
                '2': {
                    class_type: 'MeshDecimatorNode',
                    inputs: { mesh: ['1', 0], target_faces: 8000 }
                },
                '3': {
                    class_type: 'SaveGLB',
                    inputs: { mesh: ['2', 0], filename_prefix: 'Workflow_Decimated_Asset' }
                }
            };

            const result = await agent.executeWorkflowPrompt(workflow, 'Optimize and export 3D geometry', {
                targetEnvironment: 'cloud-run',
                outputDir: testOutputDir,
                mockExecution: true
            });

            expect(result.success).toBe(true);
            expect(result.blueprint.nodes.length).toBe(3);
            expect(result.assets.length).toBeGreaterThanOrEqual(1);
            expect(result.nodeGraphData).toBeDefined();
        });
    });

    describe('ToolRegistry Cloud Run Integration', () => {
        const testCtx: any = {
            workspaceRoot: process.cwd(),
            request: {},
            sandbox: {},
            lsp: {},
            contextGraph: {},
            browserProxy: {},
            lens: {}
        };

        it('should successfully dispatch comfyui_cloudrun_status tool', async () => {
            const registry = createDefaultToolRegistry();
            const decl = registry.declarations().find(d => d.name === 'comfyui_cloudrun_status');
            expect(decl).toBeDefined();

            const dispatchRes = await registry.dispatch('comfyui_cloudrun_status', { mockExecution: true }, testCtx);

            expect(dispatchRes.resultPayload).toBeDefined();
            const payload = dispatchRes.resultPayload as any;
            expect(payload.status).toBe('ready');
            expect(payload.gpuAccelerated).toBe(true);
            expect(dispatchRes.exec.summaryResult).toContain('Cloud Run service');
        });

        it('should dispatch comfyui_cloudrun_sync_upstream tool', async () => {
            const registry = createDefaultToolRegistry();
            const decl = registry.declarations().find(d => d.name === 'comfyui_cloudrun_sync_upstream');
            expect(decl).toBeDefined();

            // Test checkOnly mode
            const checkRes = await registry.dispatch('comfyui_cloudrun_sync_upstream', {
                checkOnly: true,
                mockExecution: true
            }, testCtx);
            expect(checkRes.resultPayload).toBeDefined();
            expect(checkRes.exec.summaryResult).toContain('ComfyUI upstream parity');

            // Test sync mode
            const syncRes = await registry.dispatch('comfyui_cloudrun_sync_upstream', {
                checkOnly: false,
                mockExecution: true
            }, testCtx);
            expect(syncRes.resultPayload).toBeDefined();
            expect((syncRes.resultPayload as any).success).toBe(true);
        });

        it('should dispatch comfyui_inject_dynamic_code tool', async () => {
            const registry = createDefaultToolRegistry();
            const decl = registry.declarations().find(d => d.name === 'comfyui_inject_dynamic_code');
            expect(decl).toBeDefined();

            const dispatchRes = await registry.dispatch('comfyui_inject_dynamic_code', {
                moduleName: 'procedural_normal_enhancer',
                code: 'class NormalEnhancer:\n    pass\nNODE_CLASS_MAPPINGS = {"NormalEnhancer": NormalEnhancer}',
                nodeClasses: ['NormalEnhancer'],
                mockExecution: true
            }, testCtx);

            expect(dispatchRes.resultPayload).toBeDefined();
            expect((dispatchRes.resultPayload as any).success).toBe(true);
            expect(dispatchRes.exec.summaryResult).toContain('procedural_normal_enhancer');
        });

        it('should dispatch comfyui_execute_pipeline targeting Cloud Run', async () => {
            const registry = createDefaultToolRegistry();
            const dispatchRes = await registry.dispatch('comfyui_execute_pipeline', {
                goal: 'Extract PBR normal and depth maps for masonry wall',
                targetEnvironment: 'cloud-run',
                mockExecution: true
            }, testCtx);

            expect(dispatchRes.resultPayload).toBeDefined();
            const payload = dispatchRes.resultPayload as any;
            expect(payload.status).toBe('success');
            expect(payload.assets.length).toBeGreaterThanOrEqual(1);
        });

        it('should dispatch comfyui_execute_pipeline with raw JSON workflow', async () => {
            const registry = createDefaultToolRegistry();
            const sampleWorkflow = JSON.stringify({
                '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
                '2': { class_type: 'SaveGLB', inputs: { mesh: ['1', 0] } }
            });

            const dispatchRes = await registry.dispatch('comfyui_execute_pipeline', {
                goal: 'Direct workflow execution',
                workflowJson: sampleWorkflow,
                targetEnvironment: 'cloud-run',
                mockExecution: true
            }, testCtx);

            expect(dispatchRes.resultPayload).toBeDefined();
            const payload = dispatchRes.resultPayload as any;
            expect(payload.status).toBe('success');
            expect(payload.assets.length).toBeGreaterThanOrEqual(1);
        });
    });
});
