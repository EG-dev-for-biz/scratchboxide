/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type { ToolDeclaration, ToolHandler, ToolResultPayload } from './types';
import { ImageToAdaptivePbrService, type ImageToPbrPlaneOptions } from '../../3d-engine/image-to-adaptive-pbr-service';

function asString(val: unknown): string | undefined {
    return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
}

function asBoolean(val: unknown, fallback: boolean): boolean {
    return typeof val === 'boolean' ? val : fallback;
}

function asNumber(val: unknown, fallback?: number): number | undefined {
    return typeof val === 'number' && !isNaN(val) ? val : fallback;
}

export const IMAGE_TO_PBR_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'image_to_adaptive_pbr_plane',
        description: 'Transform any 2D image (photograph, architectural facade, stone, tile, timber, fabric, wall, ground) into a physically grounded, displaced 3D PBR plane (.glb) with 100% offline native execution (< 150ms). Synthesizes de-lighted diffuse albedo, multi-frequency Scharr tangent normals, 8-directional radial horizon cavity ambient occlusion (HBAO), biophysical Laplacian curvature roughness, and conduction/metallicity separation into standard glTF 2.0 packed ORM textures. Eliminates Hugging Face network queues, camera-perspective depth distortion, and hardcoded glass hacks.',
        parameters: {
            type: 'OBJECT',
            properties: {
                imagePath: {
                    type: 'STRING',
                    description: 'Path on disk to the input source photograph or texture image (JPEG, PNG, WebP, TIFF).'
                },
                outputGlbPath: {
                    type: 'STRING',
                    description: 'Destination file path for the generated binary glTF 2.0 (.glb) model.'
                },
                planeWidthMeters: {
                    type: 'NUMBER',
                    description: 'Physical metric width of the 3D plane in meters (default: 2.0m). Height is automatically solved to lock exact aspect ratio with 0.000px stretch.'
                },
                subdivisions: {
                    type: 'NUMBER',
                    description: 'Number of geometric subdivisions along the primary axis for metric displacement (default: 64, aspect-conformal).'
                },
                displacementScaleMeters: {
                    type: 'NUMBER',
                    description: 'Physical surface relief displacement amplitude in meters (default: 0.04m / 4cm). Set to 0.0 for pure tangent normal bump.'
                },
                reliefMultiplier: {
                    type: 'NUMBER',
                    description: 'Normal map relief intensity multiplier (default: 1.20).'
                },
                edgeDampingFactor: {
                    type: 'NUMBER',
                    description: 'Gradient bandwidth edge damping factor to prevent specular bevel lines on high-contrast borders (default: 0.45).'
                },
                conductionBias: {
                    type: 'NUMBER',
                    description: 'Conduction / metallicity scale factor [0..1] (default: 1.0, auto-detects conductive metals from photometric signals).'
                },
                prompt: {
                    type: 'STRING',
                    description: 'Optional open-domain material prompt or physical hint (e.g. "classical travertine marble with deep cavitation", "weathered oak timber", "oxidized bronze").'
                },
                saveDiagnosticMaps: {
                    type: 'BOOLEAN',
                    description: 'Whether to save standalone diagnostic maps (Albedo, Normal, ORM, Height) alongside the GLB for visual inspection (default: false).'
                }
            },
            required: ['imagePath']
        }
    }
];

export const imageToPbrHandlers: Record<string, ToolHandler> = {
    image_to_adaptive_pbr_plane: async (args, _ctx) => {
        const imagePath = asString(args.imagePath);
        if (!imagePath) {
            return {
                resultPayload: { success: false, error: 'imagePath is required' } as unknown as ToolResultPayload,
                summaryResult: 'Image-to-PBR error: imagePath is required.'
            };
        }

        const options: ImageToPbrPlaneOptions = {
            imagePath,
            outputGlbPath: asString(args.outputGlbPath),
            planeWidthMeters: asNumber(args.planeWidthMeters, 2.0),
            subdivisions: asNumber(args.subdivisions, 64),
            displacementScaleMeters: asNumber(args.displacementScaleMeters, 0.04),
            reliefMultiplier: asNumber(args.reliefMultiplier, 1.20),
            edgeDampingFactor: asNumber(args.edgeDampingFactor, 0.45),
            conductionBias: asNumber(args.conductionBias, 1.0),
            prompt: asString(args.prompt),
            saveDiagnosticMaps: asBoolean(args.saveDiagnosticMaps, false)
        };

        const result = await ImageToAdaptivePbrService.processImageToPbrPlane(options);

        return {
            resultPayload: result as unknown as ToolResultPayload,
            summaryResult: `Adaptive Image-to-PBR Plane generated successfully in ${result.executionTimeMs}ms! Aspect ratio: ${result.aspectRatio.toFixed(3)} (${result.planeDimensionsMeters.width.toFixed(2)}m x ${result.planeDimensionsMeters.height.toFixed(2)}m, max displacement: ${(result.planeDimensionsMeters.displacementMax * 100).toFixed(1)}cm). Mesh: ${result.meshStats.vertexCount.toLocaleString()} vertices, ${result.meshStats.triangleCount.toLocaleString()} triangles (${result.meshStats.subdivisionsX}x${result.meshStats.subdivisionsY} grid). Intrinsic Metrics: Porosity ${result.metrics.microPorosityEnergy.toFixed(3)}, Conduction ${result.metrics.conductionIndex.toFixed(3)}, Cavity Depth ${result.metrics.averageCavityDepth.toFixed(3)}. Output: ${result.outputGlbPath || 'in-memory buffer'}.`
        };
    }
};
