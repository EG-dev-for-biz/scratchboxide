/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type { ToolDeclaration, ToolHandler, ToolResultPayload } from './types';
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

export const LOCAL_SF3D_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'generate_local_sf3d_organic_prop',
        description: 'Generate high-speed, 100% local 3D organic props and small objects (mushrooms, coral, fruits, rocks, shells, bones, statuettes, ornaments, biomorphic flora) from a single 2D image using local Stable Fast 3D (SF3D) with no_pbr geometry extraction. Runs locally on desktop (Apple Silicon Metal/MPS, CUDA, or CPU) in < 500ms, bypassing texture baking for pure 18% Studio Grey Clay geometry with metric scale grounding and flat contact planes.',
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
                    description: 'Whether to bypass UV unwrapping and neural texture baking, generating pure 18% Studio Grey Clay geometry in ~400ms (default: true).'
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
    generate_local_sf3d_organic_prop: async (args, _ctx): Promise<ToolResultPayload> => {
        const imagePath = asString(args.imagePath);
        if (!imagePath) {
            return {
                status: 'error',
                summary: 'Missing required argument: imagePath',
                output: 'Please provide a valid file path to an input photograph or image.'
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
                summary,
                output: `${summary}\nGLB Output: ${result.glbPath}\nDimensions: ${bbox.dimensions.map(d => d.toFixed(3) + 'm').join(' x ')}`,
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
                },
                resultPayload: {
                    success: true,
                    glbPath: result.glbPath,
                    mode: result.mode,
                    device: result.device,
                    vertexCount: result.vertexCount,
                    triangleCount: result.triangleCount,
                    executionTimeMs: result.executionTimeMs,
                    targetScaleMeters: result.targetScaleMeters,
                    overallBoundingBox: bbox
                }
            };
        } catch (err: any) {
            return {
                status: 'error',
                summary: `Failed to generate local SF3D organic prop: ${err.message}`,
                output: err.stack || err.message
            };
        }
    }
};
