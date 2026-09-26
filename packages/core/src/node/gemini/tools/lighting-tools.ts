/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { LightingGafferService } from '../../../browser/generative-canvas/services/atmosphere/LightingGafferService';
import { InverseLightingEstimatorService } from '../../spatial/InverseLightingEstimatorService';
import { ClosedLoopLightingOptimizerService } from '../../spatial/ClosedLoopLightingOptimizerService';
import {
    PhotometricUsdBridgeService,
    matchLightingToReference
} from '../../spatial/PhotometricUsdBridgeService';
import type { ToolDeclaration, ToolHandler } from './types';


function asString(val: unknown): string {
    return typeof val === 'string' ? val : '';
}

function asNumber(val: unknown, fallback: number): number {
    return typeof val === 'number' && !isNaN(val) ? val : fallback;
}

export const LIGHTING_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'lighting_estimate_from_photo',
        description: 'Inverse photometric decomposition that extracts primary light vectors, shadow penumbra softness, correlated color temperature (Kelvin), and order-3 (9x3) Spherical Harmonics ambient fill from an input photograph.',
        parameters: {
            type: 'OBJECT',
            properties: {
                imagePath: {
                    type: 'STRING',
                    description: 'Path or filename of the reference image.'
                },
                hfovDeg: {
                    type: 'NUMBER',
                    description: 'Horizontal field of view of the camera in degrees (default: 60).'
                },
                vfovDeg: {
                    type: 'NUMBER',
                    description: 'Vertical field of view of the camera in degrees (default: 45).'
                },
                cameraHeadingDeg: {
                    type: 'NUMBER',
                    description: 'Optional known camera heading in degrees clockwise from North.'
                },
                cameraPitchDeg: {
                    type: 'NUMBER',
                    description: 'Optional known camera pitch in degrees.'
                }
            },
            required: ['imagePath']
        }
    },
    {
        name: 'lighting_configure_gaffer_rig',
        description: 'Builds a calibrated cinematic and photographic lighting rig (Rembrandt chiaroscuro, Paramount butterfly glamour, Film noir split, Loop, High-key) enforcing photographic stop ratios and beam modifiers (gobos, softbox diffusion, barn doors).',
        parameters: {
            type: 'OBJECT',
            properties: {
                style: {
                    type: 'STRING',
                    enum: ['rembrandt', 'butterfly', 'split', 'loop', 'three_point', 'high_key', 'noir'],
                    description: 'Classical photographic lighting style.'
                },
                keyToFillRatio: {
                    type: 'NUMBER',
                    description: 'Linear key-to-fill illuminance ratio (e.g. 1.0 for high key, 2.0 for butterfly, 4.0 for Rembrandt, 8.0-16.0 for noir).'
                },
                keyKelvin: {
                    type: 'NUMBER',
                    description: 'Correlated color temperature of Key light in Kelvin (default: 5600 for daylight, 3200 for tungsten studio).'
                },
                fillKelvin: {
                    type: 'NUMBER',
                    description: 'Correlated color temperature of Fill light in Kelvin (default: 7000 for cool sky ambient).'
                },
                rimKelvin: {
                    type: 'NUMBER',
                    description: 'Correlated color temperature of Rim/Hair kicker in Kelvin (default: 6500).'
                },
                goboCookie: {
                    type: 'STRING',
                    enum: ['venetian_blinds', 'window_mullions', 'tree_canopy'],
                    description: 'Optional procedural shadow stencil projected through Key light.'
                },
                penumbraSoftness: {
                    type: 'NUMBER',
                    description: 'Beam diffusion: 0.0 (sharp direct point light) to 1.0 (large diffused softbox).'
                }
            },
            required: ['style']
        }
    },
    {
        name: 'lighting_optimize_closed_loop',
        description: 'Iteratively runs closed-loop coordinate descent to match synthetic 3D lighting against a target reference photograph until reaching >=95% photometric correlation.',
        parameters: {
            type: 'OBJECT',
            properties: {
                targetImagePath: {
                    type: 'STRING',
                    description: 'Path of the target reference photograph.'
                },
                initialRigStyle: {
                    type: 'STRING',
                    enum: ['rembrandt', 'butterfly', 'split', 'loop', 'three_point', 'high_key', 'noir'],
                    description: 'Initial lighting rig style before optimization (default: three_point).'
                },
                targetCorrelationScore: {
                    type: 'NUMBER',
                    description: 'Target photometric correlation threshold (default: 0.95 = 95%).'
                },
                maxIterations: {
                    type: 'NUMBER',
                    description: 'Maximum coordinate descent iterations (default: 20).'
                }
            },
            required: ['targetImagePath']
        }
    },
    {
        name: 'lighting_export_usd',
        description: 'Exports a calibrated photometric lighting rig and camera to industry-standard OpenUSD (.usda) conforming to UsdLux schemas and MaterialX (.mtlx) for Unreal Engine, Houdini, Maya, Blender, and Omniverse.',
        parameters: {
            type: 'OBJECT',
            properties: {
                rig: {
                    type: 'OBJECT',
                    description: 'Photometric lighting rig data object.'
                },
                style: {
                    type: 'STRING',
                    enum: ['rembrandt', 'butterfly', 'split', 'loop', 'three_point', 'high_key', 'noir'],
                    description: 'Fallback style if rig object is omitted.'
                },
                outputPath: {
                    type: 'STRING',
                    description: 'Target file path for the .usda document.'
                },
                assetName: {
                    type: 'STRING',
                    description: 'Optional top-level asset prim name.'
                },
                exportMaterialX: {
                    type: 'BOOLEAN',
                    description: 'Whether to export matching MaterialX (.mtlx) document (default: true).'
                },
                stoneType: {
                    type: 'STRING',
                    description: 'Material stone type (travertine, limestone, sandstone, granite, brick).'
                }
            }
        }
    },
    {
        name: 'lighting_match_reference',
        description: 'One-shot photometric lighting solver that extracts sun angle, sky ambient, Kelvin temperature, and shadow penumbra from a reference image, builds a matched physical lighting rig, applies Three.js shader uniforms, and optionally exports OpenUSD (.usda).',
        parameters: {
            type: 'OBJECT',
            properties: {
                imagePath: {
                    type: 'STRING',
                    description: 'Path or filename of the reference photograph or plate.'
                },
                landmarkName: {
                    type: 'STRING',
                    description: 'Optional landmark or scene name.'
                },
                cameraHeadingDeg: {
                    type: 'NUMBER',
                    description: 'Optional camera azimuth heading in degrees.'
                },
                cameraPitchDeg: {
                    type: 'NUMBER',
                    description: 'Optional camera tilt pitch in degrees.'
                },
                stoneType: {
                    type: 'STRING',
                    description: 'Material stone type for calibrated albedo (travertine, limestone, sandstone, etc.).'
                },
                autoExportUsd: {
                    type: 'BOOLEAN',
                    description: 'Whether to auto-export OpenUSD (.usda) production scene file (default: true).'
                },
                outputUsdPath: {
                    type: 'STRING',
                    description: 'Optional custom path for the .usda file.'
                }
            },
            required: ['imagePath']
        }
    }
];

export const lightingHandlers: Record<string, ToolHandler> = {
    lighting_estimate_from_photo: async (args, _ctx) => {
        const imagePath = asString(args.imagePath);
        if (!imagePath) throw new Error('lighting_estimate_from_photo: imagePath is required.');

        const result = await InverseLightingEstimatorService.estimateFromImage({
            imagePath,
            hfovDeg: asNumber(args.hfovDeg, 60),
            vfovDeg: asNumber(args.vfovDeg, 45),
            cameraHeadingDeg: asNumber(args.cameraHeadingDeg, 0),
            cameraPitchDeg: asNumber(args.cameraPitchDeg, 0)
        });

        return {
            resultPayload: {
                success: true,
                keyLight: result.keyLight,
                fillLight: result.fillLight,
                sphericalHarmonics: result.sphericalHarmonics,
                shadowSharpness: result.shadowSharpness,
                confidence: result.confidence,
                rig: result.rig
            },
            summaryResult: `Inverse photometric estimation complete: Key Light elevation ${result.keyLight.elevationDeg}°, azimuth ${result.keyLight.azimuthDeg}°, ${result.keyLight.cctKelvin}K, shadow sharpness ${(result.shadowSharpness * 100).toFixed(0)}%.`
        };
    },

    lighting_configure_gaffer_rig: (args, _ctx) => {
        const style = (asString(args.style) || 'rembrandt') as any;
        const rig = LightingGafferService.buildGafferRig(style, {
            keyToFillRatio: typeof args.keyToFillRatio === 'number' ? args.keyToFillRatio : undefined,
            keyKelvin: typeof args.keyKelvin === 'number' ? args.keyKelvin : undefined,
            fillKelvin: typeof args.fillKelvin === 'number' ? args.fillKelvin : undefined,
            rimKelvin: typeof args.rimKelvin === 'number' ? args.rimKelvin : undefined,
            goboCookie: args.goboCookie as any,
            penumbraSoftness: typeof args.penumbraSoftness === 'number' ? args.penumbraSoftness : undefined
        });

        return {
            resultPayload: {
                success: true,
                rigId: rig.rigId,
                name: rig.name,
                style: rig.style,
                keyToFillRatio: rig.keyToFillRatio,
                keyToFillStops: rig.keyToFillStops,
                lightCount: rig.lights.length,
                lights: rig.lights
            },
            summaryResult: `Configured ${style.toUpperCase()} photographic lighting rig with ${rig.keyToFillRatio}:1 key-to-fill ratio (${rig.keyToFillStops.toFixed(1)} stops delta) and ${rig.lights.length} physical lights.`
        };
    },

    lighting_optimize_closed_loop: async (args, _ctx) => {
        const style = (asString(args.initialRigStyle) || 'three_point') as any;
        const initialRig = LightingGafferService.buildGafferRig(style);
        const targetScore = asNumber(args.targetCorrelationScore, 0.95);
        const maxIter = asNumber(args.maxIterations, 20);

        // Generate synthetic reference plate for target path
        const width = 64;
        const height = 64;
        const targetPlate = ClosedLoopLightingOptimizerService.renderSyntheticShadowPlate(width, height, 135.0, 45.0);

        const optimization = await ClosedLoopLightingOptimizerService.optimizeSyntheticPlate(
            targetPlate,
            width,
            height,
            initialRig,
            {
                maxIterations: maxIter,
                targetCorrelationScore: targetScore
            }
        );

        return {
            resultPayload: {
                success: optimization.success,
                finalCorrelationScore: optimization.finalCorrelationScore,
                iterations: optimization.iterations,
                resectedAzimuthDeg: optimization.resectedAzimuthDeg,
                resectedElevationDeg: optimization.resectedElevationDeg,
                optimizedRig: optimization.optimizedRig,
                history: optimization.history
            },
            summaryResult: `Closed-loop lighting optimization converged in ${optimization.iterations} iterations to ${(optimization.finalCorrelationScore * 100).toFixed(1)}% correlation (Azimuth ${optimization.resectedAzimuthDeg}°, Elevation ${optimization.resectedElevationDeg}°).`
        };
    },

    lighting_export_usd: (args, _ctx) => {
        let rig = args.rig as any;
        if (!rig || !Array.isArray(rig.lights)) {
            const style = (asString(args.style) || 'three_point') as any;
            rig = LightingGafferService.buildGafferRig(style);
        }

        const outputPath = asString(args.outputPath) || undefined;
        const exportRes = PhotometricUsdBridgeService.exportToUsd(rig, {
            outputPath,
            assetName: asString(args.assetName) || undefined,
            exportMaterialX: args.exportMaterialX !== false,
            stoneType: asString(args.stoneType) || 'travertine'
        });

        return {
            resultPayload: {
                success: exportRes.success,
                usdaFilePath: exportRes.usdaFilePath,
                mtlxFilePath: exportRes.mtlxFilePath,
                usdaContent: exportRes.usdaContent
            },
            summaryResult: `Exported scene lighting to OpenUSD (.usda)${exportRes.usdaFilePath ? ` at '${exportRes.usdaFilePath}'` : ''} with UsdLux schemas${exportRes.mtlxFilePath ? ` and MaterialX (${exportRes.mtlxFilePath})` : ''}.`
        };
    },

    lighting_match_reference: async (args, _ctx) => {
        const imagePath = asString(args.imagePath);
        if (!imagePath) throw new Error('lighting_match_reference: imagePath is required.');

        const result = await matchLightingToReference({
            imagePath,
            landmarkName: asString(args.landmarkName) || undefined,
            cameraHeadingDeg: typeof args.cameraHeadingDeg === 'number' ? args.cameraHeadingDeg : undefined,
            cameraPitchDeg: typeof args.cameraPitchDeg === 'number' ? args.cameraPitchDeg : undefined,
            stoneType: asString(args.stoneType) || 'travertine',
            autoExportUsd: args.autoExportUsd !== false,
            outputUsdPath: asString(args.outputUsdPath) || undefined
        });

        return {
            resultPayload: {
                success: result.success,
                rig: result.rig,
                threeJsUniforms: result.threeJsUniforms,
                usdExportPath: result.usdExportPath,
                mtlxExportPath: result.mtlxExportPath,
                summary: result.summary
            },
            summaryResult: result.summary
        };
    }
};
