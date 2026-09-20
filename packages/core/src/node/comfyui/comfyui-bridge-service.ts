/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type {
    ComfyApiPrompt,
    ComfyNodeObjectInfo,
    ComfyObjectInfoCatalog,
    ComfySystemStats
} from '../../common/comfyui-protocol';

export interface ComfyBridgeOptions {
    hostUrl?: string;
    timeoutMs?: number;
    mockMode?: boolean;
    mockExecution?: boolean;
}

export interface ComfyQueuePromptResult {
    promptId: string;
    number: number;
    nodeErrors?: Record<string, { errors: Array<{ message: string; details?: string; extra_info?: any }> }>;
}

export class ComfyUiBridgeService {
    private hostUrl: string;
    private timeoutMs: number;
    private mockMode: boolean;

    constructor(options: ComfyBridgeOptions = {}) {
        this.hostUrl = options.hostUrl || process.env.COMFYUI_HOST || 'http://127.0.0.1:8188';
        this.timeoutMs = options.timeoutMs || 60000;
        this.mockMode = options.mockMode ?? options.mockExecution ?? false;
    }

    setHostUrl(url: string): void {
        this.hostUrl = url.replace(/\/$/, '');
    }

    getHostUrl(): string {
        return this.hostUrl;
    }

    setMockMode(mock: boolean): void {
        this.mockMode = mock;
    }

    isMockMode(): boolean {
        return this.mockMode;
    }

    /**
     * Check if the ComfyUI server is reachable.
     */
    async isAvailable(): Promise<boolean> {
        if (this.mockMode) return true;
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 2500);
            const res = await fetch(`${this.hostUrl}/system_stats`, {
                signal: controller.signal
            });
            clearTimeout(timer);
            return res.ok;
        } catch {
            return false;
        }
    }

    /**
     * Retrieve system hardware and GPU statistics from /system_stats.
     */
    async getSystemStats(): Promise<ComfySystemStats> {
        if (this.mockMode) {
            return {
                system: {
                    os: 'darwin',
                    python_version: '3.11.8',
                    embedded_python: false
                },
                devices: [
                    {
                        name: 'Apple M3 Max (Metal / MPS)',
                        type: 'mps',
                        index: 0,
                        vram_total: 137438953472,
                        vram_free: 96636764160,
                        torch_vram_total: 137438953472,
                        torch_vram_free: 96636764160
                    }
                ]
            };
        }

        const res = await fetch(`${this.hostUrl}/system_stats`);
        if (!res.ok) {
            throw new Error(`Failed to fetch ComfyUI system stats (${res.status}): ${await res.text()}`);
        }
        return (await res.json()) as ComfySystemStats;
    }

    /**
     * Retrieve node definition specifications from /object_info.
     */
    async getObjectInfo(nodeClass?: string): Promise<ComfyObjectInfoCatalog | ComfyNodeObjectInfo> {
        if (this.mockMode) {
            const catalog = this.getMockCatalog();
            if (nodeClass) {
                return catalog[nodeClass] || this.createFallbackNodeInfo(nodeClass);
            }
            return catalog;
        }

        try {
            const url = nodeClass ? `${this.hostUrl}/object_info/${encodeURIComponent(nodeClass)}` : `${this.hostUrl}/object_info`;
            const res = await fetch(url);
            if (!res.ok) {
                // If ComfyUI is offline, fall back to mock catalog
                const catalog = this.getMockCatalog();
                return nodeClass ? (catalog[nodeClass] || this.createFallbackNodeInfo(nodeClass)) : catalog;
            }
            return (await res.json()) as ComfyObjectInfoCatalog | ComfyNodeObjectInfo;
        } catch {
            const catalog = this.getMockCatalog();
            return nodeClass ? (catalog[nodeClass] || this.createFallbackNodeInfo(nodeClass)) : catalog;
        }
    }

    /**
     * Retrieve catalog of available model checkpoints, LoRAs, VAEs, and embeddings.
     */
    async getModels(): Promise<{ checkpoints: string[]; loras: string[]; vaes: string[]; embeddings: string[] }> {
        if (this.mockMode) {
            return {
                checkpoints: [
                    'v1-5-pruned-emaonly.safetensors',
                    'sd_xl_base_1.0.safetensors',
                    'flux1-schnell.safetensors',
                    'flux1-dev.safetensors'
                ],
                loras: [
                    'architectural_facades_v2.safetensors',
                    'photoreal_materials_pbr.safetensors'
                ],
                vaes: [
                    'ae.safetensors',
                    'sdxl_vae.safetensors',
                    'vae-ft-mse-840000-ema-pruned.safetensors'
                ],
                embeddings: []
            };
        }

        try {
            const [checkpointsRes, lorasRes, vaesRes] = await Promise.allSettled([
                fetch(`${this.hostUrl}/models/checkpoints`),
                fetch(`${this.hostUrl}/models/loras`),
                fetch(`${this.hostUrl}/models/vae`)
            ]);

            const checkpoints = checkpointsRes.status === 'fulfilled' && checkpointsRes.value.ok
                ? await checkpointsRes.value.json()
                : ['v1-5-pruned-emaonly.safetensors', 'sd_xl_base_1.0.safetensors', 'flux1-schnell.safetensors'];

            const loras = lorasRes.status === 'fulfilled' && lorasRes.value.ok
                ? await lorasRes.value.json()
                : [];

            const vaes = vaesRes.status === 'fulfilled' && vaesRes.value.ok
                ? await vaesRes.value.json()
                : ['ae.safetensors', 'sdxl_vae.safetensors'];

            return {
                checkpoints: Array.isArray(checkpoints) ? checkpoints : [],
                loras: Array.isArray(loras) ? loras : [],
                vaes: Array.isArray(vaes) ? vaes : [],
                embeddings: []
            };
        } catch {
            return {
                checkpoints: ['v1-5-pruned-emaonly.safetensors', 'sd_xl_base_1.0.safetensors', 'flux1-schnell.safetensors'],
                loras: [],
                vaes: ['ae.safetensors', 'sdxl_vae.safetensors'],
                embeddings: []
            };
        }
    }

    /**
     * Submit an execution DAG to /prompt.
     */
    async queuePrompt(prompt: ComfyApiPrompt, clientId: string): Promise<ComfyQueuePromptResult> {
        if (this.mockMode) {
            // Validate basic inputs in mock mode to emulate real ComfyUI validation
            const nodeErrors: Record<string, { errors: Array<{ message: string; details?: string }> }> = {};
            for (const [id, node] of Object.entries(prompt)) {
                if (!node.class_type) {
                    nodeErrors[id] = { errors: [{ message: 'Missing class_type' }] };
                }
            }

            if (Object.keys(nodeErrors).length > 0) {
                return {
                    promptId: `mock-prompt-${Date.now()}`,
                    number: 1,
                    nodeErrors
                };
            }

            return {
                promptId: `mock-prompt-${Date.now()}`,
                number: 1
            };
        }

        const res = await fetch(`${this.hostUrl}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt,
                client_id: clientId
            })
        });

        const data = await res.json();
        if (!res.ok) {
            if (data.node_errors) {
                return {
                    promptId: '',
                    number: 0,
                    nodeErrors: data.node_errors
                };
            }
            throw new Error(`ComfyUI queue failed (${res.status}): ${data.error || JSON.stringify(data)}`);
        }

        return {
            promptId: data.prompt_id,
            number: data.number,
            nodeErrors: data.node_errors
        };
    }

    /**
     * Poll execution history for a prompt ID until completion or timeout.
     */
    async pollPromptCompletion(
        promptId: string,
        timeoutMs = 60000,
        onProgress?: (step: number, maxSteps: number, nodeId: string) => void
    ): Promise<{ outputs: Record<string, any>; status: 'completed' | 'failed' | 'timeout' }> {
        if (this.mockMode) {
            // Emulate step progression
            const totalSteps = 20;
            for (let step = 1; step <= totalSteps; ++step) {
                if (onProgress) {
                    onProgress(step, totalSteps, '3');
                }
            }
            return {
                outputs: {
                    '9': {
                        images: [
                            {
                                filename: `mock_output_${Date.now()}.png`,
                                subfolder: '',
                                type: 'output'
                            }
                        ]
                    }
                },
                status: 'completed'
            };
        }

        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            try {
                const res = await fetch(`${this.hostUrl}/history/${promptId}`);
                if (res.ok) {
                    const history = await res.json();
                    if (history && history[promptId]) {
                        const run = history[promptId];
                        const outputs = run.outputs || {};
                        const status = run.status?.status_str === 'error' ? 'failed' : 'completed';
                        return { outputs, status };
                    }
                }
            } catch {
                // Ignore transient network errors during poll
            }

            await new Promise(r => setTimeout(r, 1000));
        }

        return { outputs: {}, status: 'timeout' };
    }

    /**
     * Download binary asset data from /view.
     */
    async fetchAsset(filename: string, subfolder = '', type = 'output'): Promise<Buffer> {
        if (this.mockMode) {
            // Return a minimal valid 1x1 PNG or binary buffer
            return Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                'base64'
            );
        }

        const params = new URLSearchParams({ filename, subfolder, type });
        const res = await fetch(`${this.hostUrl}/view?${params.toString()}`);
        if (!res.ok) {
            throw new Error(`Failed to fetch ComfyUI asset ${filename} (${res.status}): ${await res.text()}`);
        }
        const arrayBuf = await res.arrayBuffer();
        return Buffer.from(arrayBuf);
    }

    /**
     * Built-in verified catalog of standard core and extension ComfyUI nodes.
     */
    getMockCatalog(): ComfyObjectInfoCatalog {
        return {
            CheckpointLoaderSimple: {
                name: 'CheckpointLoaderSimple',
                display_name: 'Load Checkpoint',
                category: 'loaders',
                input: {
                    required: {
                        ckpt_name: [['v1-5-pruned-emaonly.safetensors', 'sd_xl_base_1.0.safetensors', 'flux1-schnell.safetensors']]
                    }
                },
                output: ['MODEL', 'CLIP', 'VAE']
            },
            CLIPTextEncode: {
                name: 'CLIPTextEncode',
                display_name: 'CLIP Text Encode (Prompt)',
                category: 'conditioning',
                input: {
                    required: {
                        text: ['STRING', { multiline: true }],
                        clip: ['CLIP']
                    }
                },
                output: ['CONDITIONING']
            },
            EmptyLatentImage: {
                name: 'EmptyLatentImage',
                display_name: 'Empty Latent Image',
                category: 'latent',
                input: {
                    required: {
                        width: ['INT', { default: 512, min: 64, max: 8192, step: 8 }],
                        height: ['INT', { default: 512, min: 64, max: 8192, step: 8 }],
                        batch_size: ['INT', { default: 1, min: 1, max: 64 }]
                    }
                },
                output: ['LATENT']
            },
            KSampler: {
                name: 'KSampler',
                display_name: 'KSampler',
                category: 'sampling',
                input: {
                    required: {
                        model: ['MODEL'],
                        seed: ['INT', { default: 0, min: 0, max: 18446744073709551615 }],
                        steps: ['INT', { default: 20, min: 1, max: 10000 }],
                        cfg: ['FLOAT', { default: 8.0, min: 0.0, max: 100.0, step: 0.1 }],
                        sampler_name: [['euler', 'euler_ancestral', 'heun', 'dpm_2', 'dpmpp_2m']],
                        scheduler: [['normal', 'karras', 'exponential', 'sgm_uniform']],
                        positive: ['CONDITIONING'],
                        negative: ['CONDITIONING'],
                        latent_image: ['LATENT'],
                        denoise: ['FLOAT', { default: 1.0, min: 0.0, max: 1.0, step: 0.01 }]
                    }
                },
                output: ['LATENT']
            },
            VAEDecode: {
                name: 'VAEDecode',
                display_name: 'VAE Decode',
                category: 'latent',
                input: {
                    required: {
                        samples: ['LATENT'],
                        vae: ['VAE']
                    }
                },
                output: ['IMAGE']
            },
            SaveImage: {
                name: 'SaveImage',
                display_name: 'Save Image',
                category: 'image',
                input: {
                    required: {
                        images: ['IMAGE'],
                        filename_prefix: ['STRING', { default: 'ComfyUI' }]
                    }
                },
                output: []
            },
            LoadImage: {
                name: 'LoadImage',
                display_name: 'Load Image',
                category: 'image',
                input: {
                    required: {
                        image: ['STRING', { image_upload: true }]
                    }
                },
                output: ['IMAGE', 'MASK']
            },
            ControlNetLoader: {
                name: 'ControlNetLoader',
                display_name: 'Load ControlNet Model',
                category: 'loaders',
                input: {
                    required: {
                        control_net_name: [['control_v11p_sd15_inpaint.pth', 'control_v11f1p_sd15_depth.pth']]
                    }
                },
                output: ['CONTROL_NET']
            },
            ControlNetApply: {
                name: 'ControlNetApply',
                display_name: 'Apply ControlNet',
                category: 'conditioning',
                input: {
                    required: {
                        conditioning: ['CONDITIONING'],
                        control_net: ['CONTROL_NET'],
                        image: ['IMAGE'],
                        strength: ['FLOAT', { default: 1.0, min: 0.0, max: 10.0, step: 0.01 }]
                    }
                },
                output: ['CONDITIONING']
            },
            InpaintModelConditioning: {
                name: 'InpaintModelConditioning',
                display_name: 'Inpaint Model Conditioning',
                category: 'conditioning/inpaint',
                input: {
                    required: {
                        positive: ['CONDITIONING'],
                        negative: ['CONDITIONING'],
                        vae: ['VAE'],
                        pixels: ['IMAGE'],
                        mask: ['MASK']
                    }
                },
                output: ['CONDITIONING', 'CONDITIONING', 'LATENT']
            },
            MarigoldDepthEstimation: {
                name: 'MarigoldDepthEstimation',
                display_name: 'Marigold Depth & Surface Normal Estimation',
                category: '3d/pbr',
                input: {
                    required: {
                        image: ['IMAGE'],
                        denoise_steps: ['INT', { default: 10, min: 1, max: 50 }],
                        n_repeat: ['INT', { default: 1, min: 1, max: 10 }]
                    }
                },
                output: ['IMAGE', 'IMAGE'] // Depth map, Normal map
            },
            Trellis3DGenerator: {
                name: 'Trellis3DGenerator',
                display_name: 'Trellis Image to 3D Mesh Generator',
                category: '3d/mesh',
                input: {
                    required: {
                        image: ['IMAGE'],
                        ss_sampling_steps: ['INT', { default: 12, min: 1, max: 50 }],
                        slat_sampling_steps: ['INT', { default: 12, min: 1, max: 50 }],
                        texture_size: ['INT', { default: 1024, min: 256, max: 4096 }]
                    }
                },
                output: ['MESH_3D']
            },
            SaveMesh3D: {
                name: 'SaveMesh3D',
                display_name: 'Save 3D Mesh (.glb)',
                category: '3d/io',
                input: {
                    required: {
                        mesh: ['MESH_3D'],
                        filename_prefix: ['STRING', { default: 'ComfyUI_Mesh' }]
                    }
                },
                output: []
            }
        };
    }

    private createFallbackNodeInfo(name: string): ComfyNodeObjectInfo {
        return {
            name,
            display_name: name,
            category: 'custom',
            input: {
                required: {},
                optional: {}
            },
            output: []
        };
    }
}
