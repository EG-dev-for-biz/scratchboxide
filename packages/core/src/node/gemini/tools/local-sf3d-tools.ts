/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type { ToolDeclaration, ToolHandler, ToolHandlerOutcome, ToolResultPayload } from './types';
import { LocalSf3DService, type LocalSf3DOptions } from '../../3d-engine/local-sf3d-service';

function asString(val: unknown): string | undefined {
    return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
}

function asBoolean(val: unknown, fallback: boolean): boolean {
    return typeof val === 'boolean' ? val : fallback;
}

function asNumber(val: unknown, fallback?: number): number | undefined {
    return typeof val === 'number' && !isNaN(val) ? val : fallback;
}

/**
 * Neural image-to-3D (Stable Fast 3D) runs only when the user asks for SF3D by name on an image they supply
 * (AGENTS.md: no neural reconstruction unless asked). It is registered but not offered by default; the capability
 * resolver adds it to a request that names it. Objects asked for in words go to build_3d_object_from_reference.
 */
export const LOCAL_SF3D_OFFERED_BY_DEFAULT = false;

export const LOCAL_SF3D_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'generate_local_sf3d_organic_prop',
        description: 'Reconstruct a mesh from an image file the user supplies with local Stable Fast 3D (SF3D), in no_pbr clay mode, on Apple Silicon MPS, CUDA or CPU. Use it only when the user explicitly asks for SF3D / Stable Fast 3D on their own image; never to build an object described in words (use build_3d_object_from_reference) and never as a substitute when another tool fails.',
        parameters: {
            type: 'OBJECT',
            properties: {
                imagePath: {
                    type: 'STRING',
                    description: 'Path on disk to the input photograph or 2D image of the organic prop or object.'
                },
                outputGlbPath: {
                    type: 'STRING',
                    description: 'Optional destination file path for the generated binary glTF 2.0 (.glb) model.'
                },
                noPbr: {
                    type: 'BOOLEAN',
                    description: 'Keep only SF3D\'s geometry and repack it in 18% Studio Grey Clay, dropping its baked texture (default: true). false exports SF3D\'s textured mesh.'
                },
                targetScaleMeters: {
                    type: 'NUMBER',
                    description: 'Metric physical bounding scale of the object in meters (default: 0.35m / 35cm for small desktop props).'
                },
                groundCut: {
                    type: 'BOOLEAN',
                    description: 'Whether to snap and ground the base of the mesh to Y=0 with a flat contact plane for stable staging (default: true).'
                },
                remeshOption: {
                    type: 'STRING',
                    enum: ['none', 'triangle', 'quad'],
                    description: 'Optional topology remeshing optimization: "none" (fastest, raw geometry), "triangle" (Botsch isotropic), or "quad" (Instant Field-Aligned 4-RoSy quads).'
                },
                device: {
                    type: 'STRING',
                    enum: ['auto', 'mps', 'cuda', 'cpu'],
                    description: 'Compute device target (default: "auto", selects MPS on Apple Silicon or CUDA on NVIDIA).'
                },
                promptHint: {
                    type: 'STRING',
                    description: 'Optional descriptive label or semantic hint for the organic prop (e.g. "chanterelle mushroom", "rough quartz crystal", "seashell").'
                }
            },
            required: ['imagePath']
        }
    }
];

export const localSf3DHandlers: Record<string, ToolHandler> = {
    generate_local_sf3d_organic_prop: async (args, _ctx): Promise<ToolHandlerOutcome> => {
        const imagePath = asString(args.imagePath);
        if (!imagePath) {
            return {
                status: 'failed',
                summaryResult: 'Missing required argument: imagePath',
                resultPayload: {
                    status: 'error',
                    summary: 'Missing required argument: imagePath',
                    output: 'Please provide a valid file path to an input photograph or image.'
                }
            };
        }

        const outputGlbPath = asString(args.outputGlbPath);
        const noPbr = asBoolean(args.noPbr, true);
        const targetScaleMeters = asNumber(args.targetScaleMeters, 0.35);
        const groundCut = asBoolean(args.groundCut, true);
        const remeshOption = (asString(args.remeshOption) as 'none' | 'triangle' | 'quad') || 'none';
        const device = (asString(args.device) as 'auto' | 'mps' | 'cuda' | 'cpu') || 'auto';
        const promptHint = asString(args.promptHint);

        try {
            const service = LocalSf3DService.getInstance();
            const result = await service.generateOrganicProp({
                imagePath,
                outputGlbPath,
                noPbr,
                targetScaleMeters,
                groundCut,
                remeshOption,
                device,
                promptHint
            });

            // Dynamic camera calculation to perfectly frame the prop in the viewport
            const bbox = result.overallBoundingBox;
            const radius = bbox.radius > 0 ? bbox.radius : (targetScaleMeters || 0.35) * 0.5;
            const camDistance = Math.max(radius * 2.8, 0.6);
            const cameraPos: [number, number, number] = [
                bbox.center[0] + camDistance * 0.6,
                bbox.center[1] + camDistance * 0.45,
                bbox.center[2] + camDistance * 0.8
            ];
            const targetPos: [number, number, number] = [
                bbox.center[0],
                bbox.center[1],
                bbox.center[2]
            ];

            const summary = `Generated local SF3D organic prop (${result.mode}) with ${result.vertexCount.toLocaleString()} vertices in ${result.executionTimeMs}ms on ${result.device}. Metric scale: ${result.targetScaleMeters}m.`;

            return {
                status: 'completed',
                summaryResult: summary,
                resultPayload: {
                    success: true,
                    summary,
                    output: `${summary}\nGLB Output: ${result.glbPath}\nDimensions: ${bbox.dimensions.map(d => d.toFixed(3) + 'm').join(' x ')}`,
                    glbPath: result.glbPath,
                    mode: result.mode,
                    device: result.device,
                    vertexCount: result.vertexCount,
                    triangleCount: result.triangleCount,
                    executionTimeMs: result.executionTimeMs,
                    targetScaleMeters: result.targetScaleMeters,
                    overallBoundingBox: bbox,
                    artifact: {
                        type: '3d-scene',
                        data: {
                            modelUrl: result.glbPath,
                            format: 'glb',
                            renderMode: result.mode === 'no_pbr_clay' ? 'clay' : 'pbr',
                            camera: {
                                position: cameraPos,
                                target: targetPos,
                                fov: 45
                            },
                            environment: {
                                skybox: 'studio',
                                lighting: 'studio',
                                ground: true
                            },
                            bounds: bbox,
                            telemetry: result.telemetry
                        }
                    }
                }
            };
        } catch (err: any) {
            return {
                status: 'failed',
                summaryResult: `Failed to generate local SF3D organic prop: ${err.message}`,
                resultPayload: {
                    status: 'error',
                    ...(typeof err?.code === 'string' ? { code: err.code } : {}),
                    summary: `Failed to generate local SF3D organic prop: ${err.message}`,
                    output: err.stack || err.message
                }
            };
        }
    }
};
