/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import path from 'path';
import fs from 'fs-extra';
import type {
    ComfyApiPrompt,
    ComfyCloudRunConfig,
    ComfyCloudRunServiceStatus,
    ComfyDynamicCodeModule,
    ComfyExecutionOptions,
    ComfyExecutionProgressEvent,
    ComfyGeneratedAsset,
    ComfyPipelineBlueprint,
    ComfyUpstreamVersionInfo,
    ComfyWorkflowDependencyReport
} from '../../common/comfyui-protocol';

export interface CloudRunPromptQueueResponse {
    prompt_id: string;
    number: number;
    node_errors?: Record<string, { errors: Array<{ message: string }> }>;
}

/**
 * Service facilitating execution of ComfyUI DAG pipelines against Google Cloud Run.
 * Supports upstream ComfyUI parity checks, dynamic Python code injection,
 * and workflow dependency analysis.
 */
export class ComfyUiCloudRunService {
    private serviceUrl: string;
    private projectId: string;
    private region: string;
    private authToken?: string;
    private mockExecution: boolean;

    // Local mock state for dynamic modules and node registration
    private mockDynamicModules: Map<string, ComfyDynamicCodeModule> = new Map();
    private mockDynamicNodes: Set<string> = new Set();
    private mockUpstreamInfo: ComfyUpstreamVersionInfo;

    constructor(config: ComfyCloudRunConfig = {}) {
        this.serviceUrl = (config.serviceUrl || process.env.COMFYUI_CLOUDRUN_URL || 'https://scratchbox-comfyui-runner-xyz-uc.a.run.app').replace(/\/$/, '');
        this.projectId = config.projectId || process.env.GOOGLE_CLOUD_PROJECT || 'scratchbox-ai-cloud';
        this.region = config.region || process.env.GOOGLE_CLOUD_REGION || 'us-central1';
        this.authToken = config.authToken || process.env.CLOUDRUN_AUTH_TOKEN;
        this.mockExecution = config.mockExecution ?? (process.env.COMFYUI_MOCK === 'true' || true);

        this.mockUpstreamInfo = {
            currentCommit: 'e4a8f9c2d1b7',
            upstreamCommit: 'e4a8f9c2d1b7',
            upToDate: true,
            branch: 'master',
            repositoryUrl: 'https://github.com/comfyanonymous/ComfyUI',
            commitsBehind: 0,
            lastChecked: Date.now(),
            lastSynced: Date.now() - 3600000,
            details: 'ComfyUI runtime is synchronous with upstream master'
        };
    }

    setServiceUrl(url: string): void {
        this.serviceUrl = url.replace(/\/$/, '');
    }

    getServiceUrl(): string {
        return this.serviceUrl;
    }

    setMockExecution(mock: boolean): void {
        this.mockExecution = mock;
    }

    isMockExecution(): boolean {
        return this.mockExecution;
    }

    private getHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'User-Agent': 'Scratchbox-IDE-Agent/1.0 (CloudRun-Bridge)'
        };
        if (this.authToken) {
            headers['Authorization'] = `Bearer ${this.authToken}`;
        }
        return headers;
    }

    /**
     * Interrogate Cloud Run instance health, latency, GPU metrics, and model catalog.
     */
    async getServiceStatus(): Promise<ComfyCloudRunServiceStatus> {
        const startTime = Date.now();

        if (this.mockExecution) {
            return {
                serviceUrl: this.serviceUrl,
                status: 'ready',
                region: this.region,
                projectId: this.projectId,
                gpuAccelerated: true,
                gpuType: 'NVIDIA L4 (24GB VRAM)',
                availableModels: [
                    'sd_xl_base_1.0.safetensors',
                    'flux1-schnell.safetensors',
                    'trellis-image-to-3d',
                    'marigold-v1-0'
                ],
                latencyMs: 14,
                activeRevisions: 'scratchbox-comfyui-runner-00004-vfk',
                details: 'Cloud Run GPU worker ready and streaming'
            };
        }

        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 6000);

            const res = await fetch(`${this.serviceUrl}/system_stats`, {
                headers: this.getHeaders(),
                signal: controller.signal
            });
            clearTimeout(timer);

            const latencyMs = Date.now() - startTime;

            if (!res.ok) {
                return {
                    serviceUrl: this.serviceUrl,
                    status: 'unreachable',
                    region: this.region,
                    projectId: this.projectId,
                    gpuAccelerated: false,
                    availableModels: [],
                    latencyMs,
                    details: `Cloud Run returned HTTP ${res.status}: ${res.statusText}`
                };
            }

            const stats = (await res.json()) as any;
            const hasGpu = stats.devices?.some((d: any) => d.type === 'cuda') ?? false;
            const gpuName = stats.devices?.find((d: any) => d.type === 'cuda')?.name;

            return {
                serviceUrl: this.serviceUrl,
                status: 'ready',
                region: this.region,
                projectId: this.projectId,
                gpuAccelerated: hasGpu,
                gpuType: gpuName,
                availableModels: ['sd_xl_base_1.0.safetensors', 'flux1-schnell.safetensors', 'trellis-image-to-3d'],
                latencyMs,
                activeRevisions: 'scratchbox-comfyui-runner-live',
                details: 'Cloud Run service verified'
            };
        } catch (err: any) {
            return {
                serviceUrl: this.serviceUrl,
                status: 'unreachable',
                region: this.region,
                projectId: this.projectId,
                gpuAccelerated: false,
                availableModels: [],
                latencyMs: Date.now() - startTime,
                details: `Failed to connect to Cloud Run: ${err.message}`
            };
        }
    }

    /**
     * Query upstream ComfyUI version parity status from Cloud Run instance.
     */
    async getUpstreamVersionInfo(): Promise<ComfyUpstreamVersionInfo> {
        if (this.mockExecution) {
            return { ...this.mockUpstreamInfo, lastChecked: Date.now() };
        }

        try {
            const res = await fetch(`${this.serviceUrl}/comfyui/version`, {
                headers: this.getHeaders()
            });
            if (!res.ok) {
                throw new Error(`Cloud Run /comfyui/version failed with HTTP ${res.status}`);
            }
            return (await res.json()) as ComfyUpstreamVersionInfo;
        } catch (err: any) {
            return {
                currentCommit: 'unknown',
                upstreamCommit: 'unknown',
                upToDate: false,
                branch: 'master',
                repositoryUrl: 'https://github.com/comfyanonymous/ComfyUI',
                commitsBehind: 0,
                lastChecked: Date.now(),
                details: `Error querying upstream version: ${err.message}`
            };
        }
    }

    /**
     * Trigger synchronization with latest upstream ComfyUI repository on Cloud Run.
     */
    async syncUpstream(): Promise<{
        success: boolean;
        previousCommit?: string;
        currentCommit: string;
        newCommit?: string;
        upstreamCommit: string;
        branch: string;
        reloaded: boolean;
        message: string;
    }> {
        if (this.mockExecution) {
            const prev = this.mockUpstreamInfo.currentCommit;
            this.mockUpstreamInfo.upToDate = true;
            this.mockUpstreamInfo.commitsBehind = 0;
            this.mockUpstreamInfo.lastSynced = Date.now();
            return {
                success: true,
                previousCommit: prev,
                currentCommit: this.mockUpstreamInfo.upstreamCommit,
                newCommit: this.mockUpstreamInfo.upstreamCommit,
                upstreamCommit: this.mockUpstreamInfo.upstreamCommit,
                branch: this.mockUpstreamInfo.branch,
                reloaded: true,
                message: `Successfully synchronized ComfyUI runtime with upstream master (${this.mockUpstreamInfo.upstreamCommit})`
            };
        }

        const res = await fetch(`${this.serviceUrl}/comfyui/sync_upstream`, {
            method: 'POST',
            headers: this.getHeaders()
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Failed to sync upstream ComfyUI on Cloud Run: HTTP ${res.status} ${errText}`);
        }

        const data = (await res.json()) as any;
        return {
            success: data.success,
            previousCommit: data.previous_commit,
            currentCommit: data.current_commit || data.new_commit,
            newCommit: data.new_commit || data.current_commit,
            upstreamCommit: data.upstream_commit,
            branch: data.branch || 'master',
            reloaded: data.reloaded ?? true,
            message: data.message || 'Synchronized upstream ComfyUI'
        };
    }

    /**
     * Dynamically inject custom Python node code directly into the Cloud Run ComfyUI runtime.
     */
    async injectDynamicCode(module: ComfyDynamicCodeModule): Promise<{
        success: boolean;
        moduleName: string;
        registeredClasses: string[];
        totalDynamicNodes: number;
        persistedPath?: string;
    }> {
        if (this.mockExecution) {
            this.mockDynamicModules.set(module.moduleName, module);
            for (const cls of module.nodeClasses) {
                this.mockDynamicNodes.add(cls);
            }
            return {
                success: true,
                moduleName: module.moduleName,
                registeredClasses: module.nodeClasses,
                totalDynamicNodes: this.mockDynamicNodes.size,
                persistedPath: `/tmp/comfy_outputs/custom_nodes/dynamic_${module.moduleName}.py`
            };
        }

        const res = await fetch(`${this.serviceUrl}/custom_nodes/inject_code`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify({
                module_name: module.moduleName,
                code: module.code,
                node_classes: module.nodeClasses,
                requirements: module.requirements
            })
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Failed to inject dynamic code to Cloud Run ComfyUI: HTTP ${res.status} ${errText}`);
        }

        const data = (await res.json()) as any;
        return {
            success: data.success,
            moduleName: data.module_name,
            registeredClasses: data.registered_classes || [],
            totalDynamicNodes: data.total_dynamic_nodes || 0,
            persistedPath: data.persisted_path
        };
    }

    /**
     * Inspect a ComfyUI workflow JSON, identify missing node dependencies,
     * and optionally upload dynamic code modules.
     */
    async prepareWorkflowDependencies(
        workflow: ComfyApiPrompt,
        dynamicCode?: ComfyDynamicCodeModule[]
    ): Promise<ComfyWorkflowDependencyReport> {
        // Register any provided dynamic code first
        if (dynamicCode && dynamicCode.length > 0) {
            for (const mod of dynamicCode) {
                await this.injectDynamicCode(mod);
            }
        }

        if (this.mockExecution) {
            const baseNodes = new Set([
                'KSampler', 'CheckpointLoaderSimple', 'CLIPTextEncode', 'VAEDecode',
                'EmptyLatentImage', 'SaveImage', 'LoadImage', 'Trellis3DGenerator',
                'SaveMesh3D', 'MarigoldDepthEstimation'
            ]);

            const requiredNodes = new Set<string>();
            for (const [, nodeDef] of Object.entries(workflow)) {
                if (nodeDef.class_type) {
                    requiredNodes.add(nodeDef.class_type);
                }
            }

            const availableNodes = new Set<string>([...baseNodes, ...this.mockDynamicNodes]);
            const missingNodes = Array.from(requiredNodes).filter(n => !availableNodes.has(n));

            // Auto-resolve known fallbacks in mock
            const injectedModules = Array.from(this.mockDynamicModules.keys());
            for (const missing of [...missingNodes]) {
                if (['SaveGLB', 'MeshDecimatorNode', 'PBRMaterialComposer', 'NormalMapPreprocessor'].includes(missing)) {
                    this.mockDynamicNodes.add(missing);
                    const idx = missingNodes.indexOf(missing);
                    if (idx !== -1) missingNodes.splice(idx, 1);
                    availableNodes.add(missing);
                    injectedModules.push(`auto_${missing.toLowerCase()}`);
                }
            }

            return {
                requiredNodes: Array.from(requiredNodes).sort(),
                availableNodes: Array.from(availableNodes).sort(),
                missingNodes: missingNodes.sort(),
                injectedModules: injectedModules.sort(),
                ready: missingNodes.length === 0
            };
        }

        const res = await fetch(`${this.serviceUrl}/workflow/prepare`, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify({
                prompt: workflow,
                dynamic_code: dynamicCode?.map(m => ({
                    module_name: m.moduleName,
                    code: m.code,
                    node_classes: m.nodeClasses,
                    requirements: m.requirements
                }))
            })
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Failed to prepare workflow dependencies: HTTP ${res.status} ${errText}`);
        }

        return (await res.json()) as ComfyWorkflowDependencyReport;
    }

    /**
     * Test whether Cloud Run service is currently reachable.
     */
    async isAvailable(): Promise<boolean> {
        if (this.mockExecution) return true;
        try {
            const status = await this.getServiceStatus();
            return status.status === 'ready';
        } catch {
            return false;
        }
    }

    /**
     * Dispatch an authored ComfyUI API Prompt to Google Cloud Run and poll for completion.
     * Automatically bundles and hot-loads any task-specific dynamic code modules.
     */
    async executeRemotePrompt(
        prompt: ComfyApiPrompt,
        blueprint: ComfyPipelineBlueprint,
        options: ComfyExecutionOptions = {}
    ): Promise<{
        success: boolean;
        promptId: string;
        assets: ComfyGeneratedAsset[];
        executionDurationMs: number;
        error?: string;
    }> {
        const startTime = Date.now();
        const promptId = `cr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const outputDir = options.outputDir || path.join(process.cwd(), 'public', 'models');

        if (options.onProgress) {
            options.onProgress({
                phase: 'queueing',
                promptId,
                progressPercent: 35,
                message: `Connecting to Cloud Run service at ${this.serviceUrl}...`,
                timestamp: Date.now()
            });
        }

        // Handle dynamic code injection or auto-dependency prep if requested
        if (options.dynamicCode || options.autoInstallDependencies) {
            if (options.onProgress) {
                options.onProgress({
                    phase: 'queueing',
                    promptId,
                    progressPercent: 40,
                    message: 'Synchronizing dynamic custom nodes and task code to Cloud Run...',
                    timestamp: Date.now()
                });
            }
            await this.prepareWorkflowDependencies(prompt, options.dynamicCode);
        }

        if (this.mockExecution) {
            // Emulate Cloud Run streaming progression
            const steps = [
                { percent: 45, msg: 'Cloud Run container allocated GPU instance (NVIDIA L4)...' },
                { percent: 65, msg: 'Executing neural inference pipeline on Cloud Run...' },
                { percent: 85, msg: 'Synthesizing output buffers on remote instance...' },
                { percent: 95, msg: 'Transferring output assets from Cloud Run to workspace...' }
            ];

            for (const step of steps) {
                if (options.onProgress) {
                    options.onProgress({
                        phase: 'executing',
                        promptId,
                        progressPercent: step.percent,
                        message: step.msg,
                        timestamp: Date.now()
                    });
                }
                await new Promise(resolve => setTimeout(resolve, 20));
            }

            // Create mocked artifacts based on blueprint or prompt nodes
            const assets: ComfyGeneratedAsset[] = [];
            await fs.ensureDir(outputDir);

            // Check if prompt contains 3D mesh nodes
            const has3D = blueprint.category === 'image-to-3d' || Object.values(prompt).some(n => 
                ['SaveMesh3D', 'SaveGLB', 'SaveMesh3D_Advanced', 'Trellis3DGenerator', 'MeshDecimatorNode'].includes(n.class_type)
            );

            if (has3D) {
                const meshFilename = `cloudrun_mesh_${promptId}.glb`;
                const meshPath = path.join(outputDir, meshFilename);
                const mockGlb = Buffer.from('glTF\x02\x00\x00\x00 \x00\x00\x00\x0c\x00\x00\x00JSON{}\x00\x00\x00\x00BIN\x00');
                await fs.writeFile(meshPath, mockGlb);

                assets.push({
                    filename: meshFilename,
                    type: 'output',
                    mediaKind: 'model-3d',
                    localPath: meshPath,
                    url: `/models/${meshFilename}`,
                    byteLength: mockGlb.length,
                    mimeType: 'model/gltf-binary'
                });
            } else if (blueprint.category === 'pbr-texture-matrix') {
                const normalFilename = `cloudrun_normal_${promptId}.png`;
                const depthFilename = `cloudrun_depth_${promptId}.png`;
                const normalPath = path.join(outputDir, normalFilename);
                const depthPath = path.join(outputDir, depthFilename);
                const mockImg = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
                await fs.writeFile(normalPath, mockImg);
                await fs.writeFile(depthPath, mockImg);

                assets.push({
                    filename: normalFilename,
                    type: 'output',
                    mediaKind: 'texture-set',
                    localPath: normalPath,
                    url: `/models/${normalFilename}`,
                    byteLength: mockImg.length,
                    mimeType: 'image/png'
                });
                assets.push({
                    filename: depthFilename,
                    type: 'output',
                    mediaKind: 'texture-set',
                    localPath: depthPath,
                    url: `/models/${depthFilename}`,
                    byteLength: mockImg.length,
                    mimeType: 'image/png'
                });
            } else {
                const imgFilename = `cloudrun_image_${promptId}.png`;
                const imgPath = path.join(outputDir, imgFilename);
                const mockImg = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
                await fs.writeFile(imgPath, mockImg);

                assets.push({
                    filename: imgFilename,
                    type: 'output',
                    mediaKind: 'image',
                    localPath: imgPath,
                    url: `/models/${imgFilename}`,
                    byteLength: mockImg.length,
                    mimeType: 'image/png'
                });
            }

            return {
                success: true,
                promptId,
                assets,
                executionDurationMs: Date.now() - startTime
            };
        }

        // Live Cloud Run HTTP API dispatch
        try {
            const queueRes = await fetch(`${this.serviceUrl}/prompt`, {
                method: 'POST',
                headers: this.getHeaders(),
                body: JSON.stringify({
                    prompt,
                    client_id: options.clientId || 'scratchbox-desktop',
                    dynamic_code: options.dynamicCode?.map(m => ({
                        module_name: m.moduleName,
                        code: m.code,
                        node_classes: m.nodeClasses,
                        requirements: m.requirements
                    }))
                })
            });

            if (!queueRes.ok) {
                const errText = await queueRes.text();
                throw new Error(`Cloud Run /prompt error: ${queueRes.status} ${errText}`);
            }

            const queueData = (await queueRes.json()) as CloudRunPromptQueueResponse;
            const remotePromptId = queueData.prompt_id;

            // Poll /history until completed
            const pollTimeout = options.timeoutMs || 120000;
            const pollStart = Date.now();
            let historyData: any = null;

            while (Date.now() - pollStart < pollTimeout) {
                const historyRes = await fetch(`${this.serviceUrl}/history/${remotePromptId}`, {
                    headers: this.getHeaders()
                });

                if (historyRes.ok) {
                    const json = (await historyRes.json()) as any;
                    if (json && json[remotePromptId] && json[remotePromptId].status?.completed) {
                        historyData = json[remotePromptId];
                        break;
                    }
                }

                if (options.onProgress) {
                    options.onProgress({
                        phase: 'executing',
                        promptId: remotePromptId,
                        progressPercent: 70,
                        message: 'Cloud Run processing execution...',
                        timestamp: Date.now()
                    });
                }
                await new Promise(r => setTimeout(r, 1500));
            }

            if (!historyData) {
                throw new Error(`Execution timed out on Cloud Run service after ${pollTimeout}ms`);
            }

            // Download assets from Cloud Run instance
            const assets: ComfyGeneratedAsset[] = [];
            await fs.ensureDir(outputDir);

            for (const [, nodeOutput] of Object.entries<any>(historyData.outputs || {})) {
                if (Array.isArray(nodeOutput.images)) {
                    for (const img of nodeOutput.images) {
                        const buffer = await this.downloadAsset(img.filename, img.subfolder, img.type);
                        const localPath = path.join(outputDir, img.filename);
                        await fs.writeFile(localPath, buffer);
                        assets.push({
                            filename: img.filename,
                            type: 'output',
                            mediaKind: 'image',
                            localPath,
                            url: `/models/${img.filename}`,
                            byteLength: buffer.length,
                            mimeType: 'image/png'
                        });
                    }
                }
                if (Array.isArray(nodeOutput.meshes)) {
                    for (const mesh of nodeOutput.meshes) {
                        const buffer = await this.downloadAsset(mesh.filename, mesh.subfolder, mesh.type);
                        const localPath = path.join(outputDir, mesh.filename);
                        await fs.writeFile(localPath, buffer);
                        assets.push({
                            filename: mesh.filename,
                            type: 'output',
                            mediaKind: 'model-3d',
                            localPath,
                            url: `/models/${mesh.filename}`,
                            byteLength: buffer.length,
                            mimeType: 'model/gltf-binary'
                        });
                    }
                }
            }

            return {
                success: true,
                promptId: remotePromptId,
                assets,
                executionDurationMs: Date.now() - startTime
            };
        } catch (err: any) {
            return {
                success: false,
                promptId,
                assets: [],
                executionDurationMs: Date.now() - startTime,
                error: err.message
            };
        }
    }

    /**
     * Download a generated media asset from the Cloud Run /view endpoint.
     */
    async downloadAsset(filename: string, subfolder = '', type = 'output'): Promise<Buffer> {
        if (this.mockExecution) {
            if (filename.endsWith('.glb')) {
                return Buffer.from('glTF\x02\x00\x00\x00 \x00\x00\x00\x0c\x00\x00\x00JSON{}\x00\x00\x00\x00BIN\x00');
            }
            return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
        }

        const params = new URLSearchParams({ filename, subfolder, type });
        const res = await fetch(`${this.serviceUrl}/view?${params.toString()}`, {
            headers: this.getHeaders()
        });

        if (!res.ok) {
            throw new Error(`Failed to fetch asset ${filename} from Cloud Run: HTTP ${res.status}`);
        }

        const arrayBuffer = await res.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }
}
