/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { LightingGafferService } from '../../../browser/generative-canvas/services/atmosphere/LightingGafferService';
import { InverseLightingEstimatorService } from '../../spatial/InverseLightingEstimatorService';
import {
    PhotometricUsdBridgeService,
    matchLightingToReference,
    matchImageAndLightingToLocation
} from '../../spatial/PhotometricUsdBridgeService';
import type { ToolDeclaration, ToolHandler } from './types';
import type { PhotometricLightingRigData } from '../../../common/spatial/photometric-units';
import type { CanvasArtifact, Scene3DData } from '../../../browser/generative-canvas/canvas-types';
import { CINEMATIC_RIGS, type SceneLightingRig } from '../../../browser/generative-canvas/primitives/scene3d/lightingRigs';
import { DirectDispatchOperatorEngine } from '../../../browser/generative-canvas/services/direct-dispatch-operator-engine';


function asString(val: unknown): string {
    return typeof val === 'string' ? val : '';
}

function asNumber(val: unknown, fallback: number): number {
    return typeof val === 'number' && !isNaN(val) ? val : fallback;
}

function asVec3(val: unknown): [number, number, number] | undefined {
    return Array.isArray(val) && val.length === 3 && val.every(v => typeof v === 'number' && Number.isFinite(v))
        ? [val[0], val[1], val[2]]
        : undefined;
}

/** { lat, lng, alt } as declared, or { lat, lng, altitudeMeters }; undefined when not given. */
function asGeodetic(val: unknown): { lat: number; lng: number; altitudeMeters?: number } | undefined {
    if (!val || typeof val !== 'object') return undefined;
    const v = val as Record<string, unknown>;
    if (typeof v.lat !== 'number' || typeof v.lng !== 'number') return undefined;
    const alt = typeof v.alt === 'number' ? v.alt : typeof v.altitudeMeters === 'number' ? v.altitudeMeters : undefined;
    return { lat: v.lat, lng: v.lng, ...(alt !== undefined ? { altitudeMeters: alt } : {}) };
}

/**
 * The viewport's exposure reference: the irradiance the default studio rig's key (a directional light, so its intensity is
 * its irradiance) puts on the content. A gaffer rig's key lands at this irradiance; every other light keeps its lux ratio
 * to the key, so the stop ratios hold while absolute lux (which the viewport has no exposure for) does not.
 */
function studioKeyIrradiance(): number {
    return CINEMATIC_RIGS.studio.lights[0].intensity;
}

/** A gaffer rig (built around a subject at the origin) as an explicit scene rig the viewport draws. */
export function gafferRigToSceneRig(rig: PhotometricLightingRigData, origin: [number, number, number]): SceneLightingRig {
    const key = rig.lights.find(l => l.role === 'key') ?? rig.lights[0];
    const keyLux = key?.intensityLux || 1;
    const eRef = studioKeyIrradiance();
    return {
        name: `gaffer_${rig.style}`,
        label: rig.name,
        description: `${rig.style} rig, ${rig.keyToFillRatio}:1 key-to-fill (lighting_configure_gaffer_rig)`,
        ambientColor: 0xffffff,
        ambientIntensity: 0,
        origin,
        lights: rig.lights.map(l => {
            const d = Math.hypot(l.position[0], l.position[1], l.position[2]);
            return {
                name: l.name,
                type: l.type === 'spot' || l.type === 'directional' ? l.type : 'point',
                position: [l.position[0], l.position[1], l.position[2]] as [number, number, number],
                ...(l.type !== 'point' ? { direction: [-l.position[0], -l.position[1], -l.position[2]] as [number, number, number] } : {}),
                kelvin: l.cctKelvin,
                // the same irradiance ratio to the key at the subject as the rig's lux ratio
                intensity: l.type === 'directional' ? eRef * ((l.intensityLux ?? 0) / keyLux) : eRef * ((l.intensityLux ?? 0) / keyLux) * d * d,
                range: 0,
                ...(l.beamInnerConeRad !== undefined ? { innerConeAngle: l.beamInnerConeRad } : {}),
                ...(l.beamOuterConeRad !== undefined ? { outerConeAngle: l.beamOuterConeRad } : {}),
                castShadow: l.castShadow,
                ...(l.shadowBias !== undefined ? { shadowBias: l.shadowBias } : {})
            };
        })
    };
}

export const LIGHTING_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'lighting_estimate_from_photo',
        description: 'Measures the lighting in a photograph: the sun direction (NOAA ephemeris when latitude, longitude and isoDate are given; otherwise a visible sun disc, otherwise a Preetham analytic sky fitted to the sky pixels, else a sun_not_found error), Preetham turbidity, lit/shadow colour temperatures and key-to-fill ratio (Otsu split, equal-albedo assumption), shadow edge sharpness, and a least-squares 9x3 spherical-harmonic fit of the visible radiance. Quantities the pixels cannot give (absolute lux) are listed as unmeasured.',
        parameters: {
            type: 'OBJECT',
            properties: {
                imagePath: {
                    type: 'STRING',
                    description: 'Path or filename of the reference image.'
                },
                hfovDeg: {
                    type: 'NUMBER',
                    description: 'Horizontal field of view in degrees. If omitted, 60 is assumed and reported in assumptions.'
                },
                vfovDeg: {
                    type: 'NUMBER',
                    description: 'Vertical field of view in degrees. Derived from hfovDeg and the aspect ratio when omitted.'
                },
                cameraHeadingDeg: {
                    type: 'NUMBER',
                    description: 'Camera heading in degrees clockwise from North. Without it image-derived azimuths are relative to the camera forward axis.'
                },
                cameraPitchDeg: {
                    type: 'NUMBER',
                    description: 'Camera pitch above the horizon in degrees. If omitted, a level camera is assumed and reported.'
                },
                latitude: { type: 'NUMBER', description: 'Latitude of the photo (with longitude and isoDate, the sun comes from NOAA ephemeris).' },
                longitude: { type: 'NUMBER', description: 'Longitude of the photo.' },
                isoDate: { type: 'STRING', description: 'ISO 8601 capture time of the photo.' }
            },
            required: ['imagePath']
        }
    },
    {
        name: 'lighting_configure_gaffer_rig',
        description: 'Lights the open 3D scene with a photographic rig (Rembrandt, butterfly, split, loop, three-point, high-key, noir): key, fill and rim lights at the style\'s angles around the scene\'s camera target, at their colour temperatures and the key-to-fill stop ratio, replacing the studio rig (and switching off a sun/sky atmosphere the scene had). The result says applied: true and returns the updated scene; with no 3D scene open it says NOT applied and changes nothing. Absolute lux is not reproduced (the viewport has no photometric exposure; the ratios are), and gobo cookies are computed only (the viewport projects none).',
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
        description: 'Builds a lighting rig measured from a reference image (sun from NOAA ephemeris when geodeticCoords and isoDate are given, else from the photo\'s sun disc or sky; key-to-fill ratio and colour temperatures from the lit/shadow split), with relative Three.js uniforms and optional OpenUSD (.usda) export. Fails with sun_not_found or lighting_unmeasured when the photo does not determine them.',
        parameters: {
            type: 'OBJECT',
            properties: {
                imagePath: {
                    type: 'STRING',
                    description: 'Path or filename of the reference photograph or plate.'
                },
                landmarkName: {
                    type: 'STRING',
                    description: 'Optional landmark or scene name (a label only; it is not geocoded here).'
                },
                geodeticCoords: {
                    type: 'OBJECT',
                    properties: { lat: { type: 'NUMBER' }, lng: { type: 'NUMBER' } },
                    description: 'Where the photo was taken; with isoDate the sun comes from NOAA ephemeris.'
                },
                isoDate: {
                    type: 'STRING',
                    description: 'ISO 8601 capture time of the photo.'
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
    },
    {
        name: 'lighting_match_image_to_location',
        description: 'Matches physical scene lighting (sun angle, Kelvin temperature, sky ambient) to a reference photograph taken at a location. The location is geodeticCoords, or locationName resolved with Google Places. The camera pose is not estimated from the photograph: pass cameraPosition and cameraTarget when they are known (for example from geobox_resect_image_location); without them the lighting is reported in the camera\'s own frame.',
        parameters: {
            type: 'OBJECT',
            properties: {
                imagePath: {
                    type: 'STRING',
                    description: 'Path of the provided reference photograph or plate.'
                },
                locationName: {
                    type: 'STRING',
                    description: 'Name of the matched location or landmark.'
                },
                isoDate: {
                    type: 'STRING',
                    description: 'ISO 8601 capture time of the photograph. The sun is computed from it by NOAA ephemeris at the location; required unless the photo itself shows the sun or a fittable sky.'
                },
                geodeticCoords: {
                    type: 'OBJECT',
                    properties: {
                        lat: { type: 'NUMBER' },
                        lng: { type: 'NUMBER' },
                        alt: { type: 'NUMBER' }
                    },
                    description: 'Optional geodetic coordinates of the matched location.'
                },
                cameraPosition: {
                    type: 'ARRAY',
                    items: { type: 'NUMBER' },
                    description: 'Optional camera position [x, y, z] in the scene (metres, Y up, -Z north).'
                },
                cameraTarget: {
                    type: 'ARRAY',
                    items: { type: 'NUMBER' },
                    description: 'Optional point [x, y, z] the camera looks at; required with cameraPosition.'
                },
                fovDeg: {
                    type: 'NUMBER',
                    description: 'Optional camera field of view in degrees (default 54) when cameraPosition is given.'
                },
                stoneType: {
                    type: 'STRING',
                    description: 'Material stone type (travertine, limestone, sandstone, granite, etc.).'
                },
                autoExportUsd: {
                    type: 'BOOLEAN',
                    description: 'Whether to export matched scene to OpenUSD (.usda) and MaterialX (.mtlx).'
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

        const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
        const lat = num(args.latitude), lng = num(args.longitude);
        const result = await InverseLightingEstimatorService.estimateFromImage({
            imagePath,
            hfovDeg: num(args.hfovDeg),
            vfovDeg: num(args.vfovDeg),
            cameraHeadingDeg: num(args.cameraHeadingDeg),
            cameraPitchDeg: num(args.cameraPitchDeg),
            knownCoords: lat !== undefined && lng !== undefined ? { lat, lng } : undefined,
            timestampIso: asString(args.isoDate) || undefined
        });

        const key = result.keyLight;
        const parts = [
            `sun elevation ${key.elevationDeg}°, azimuth ${key.azimuthDeg}° (${key.azimuthReference}, from ${key.source}${result.confidence !== undefined ? `, confidence ${result.confidence}` : ''})`,
            key.cctKelvin !== undefined ? `lit surfaces ${key.cctKelvin}K` : undefined,
            result.keyToFillRatio !== undefined ? `key:fill ${result.keyToFillRatio.toFixed(2)}:1` : undefined,
            result.turbidity !== undefined ? `turbidity ${result.turbidity}` : undefined,
            result.shadowSharpness !== undefined ? `shadow edge sharpness ${(result.shadowSharpness * 100).toFixed(0)}%` : undefined
        ].filter(Boolean);
        const notMeasured = Object.keys(result.unmeasured);
        return {
            resultPayload: { ...result },
            summaryResult: `Inverse photometric estimation: ${parts.join(', ')}.${notMeasured.length ? ` Not measured: ${notMeasured.join(', ')}.` : ''}${result.assumptions.length ? ` Assumed: ${result.assumptions.join('; ')}.` : ''}`
        };
    },

    lighting_configure_gaffer_rig: (args, ctx) => {
        const style = (asString(args.style) || 'rembrandt') as any;
        const rig = LightingGafferService.buildGafferRig(style, {
            // built around the origin; the scene rig is placed at the scene's camera target
            subjectPosition: [0, 0, 0],
            keyToFillRatio: typeof args.keyToFillRatio === 'number' ? args.keyToFillRatio : undefined,
            keyKelvin: typeof args.keyKelvin === 'number' ? args.keyKelvin : undefined,
            fillKelvin: typeof args.fillKelvin === 'number' ? args.fillKelvin : undefined,
            rimKelvin: typeof args.rimKelvin === 'number' ? args.rimKelvin : undefined,
            goboCookie: args.goboCookie as any,
            penumbraSoftness: typeof args.penumbraSoftness === 'number' ? args.penumbraSoftness : undefined
        });
        const rigText = `${String(style).toUpperCase()} rig, ${rig.keyToFillRatio}:1 key-to-fill (${rig.keyToFillStops.toFixed(1)} stops), ${rig.lights.length} lights (${rig.lights.map(l => `${l.role} ${l.type} ${Math.round(l.cctKelvin)} K`).join(', ')})`;
        const notAppliedParts = [
            ...(args.goboCookie ? [`the ${String(args.goboCookie)} gobo cookie (the viewport projects no cookie through a light)`] : []),
            'absolute lux (the viewport has no photometric exposure; the key is set to the studio key\'s brightness and the other lights keep their ratios to it)'
        ];
        const rigPayload = { rigId: rig.rigId, name: rig.name, style: rig.style, keyToFillRatio: rig.keyToFillRatio, keyToFillStops: rig.keyToFillStops, lightCount: rig.lights.length, lights: rig.lights };

        const active = ctx?.request?.activeArtifact;
        if (!active || active.type !== '3d-scene' || !active.data) {
            const why = 'no 3D scene is open, so nothing was lit';
            return {
                status: 'failed',
                resultPayload: { success: false, applied: false, notApplied: why, ...rigPayload },
                summaryResult: `NOT applied: computed only. ${why}. Computed: ${rigText}. Open a 3D scene and call this again to light it.`
            };
        }
        const data0 = active.data as Scene3DData;
        const t = data0.camera?.target;
        const origin: [number, number, number] = Array.isArray(t) && t.length === 3 && t.every(v => Number.isFinite(v)) ? [t[0], t[1], t[2]] : [0, 0, 0];
        const sceneRig = gafferRigToSceneRig(rig, origin);
        const engine = new DirectDispatchOperatorEngine(JSON.parse(JSON.stringify(data0)) as Scene3DData);
        const res = engine.dispatch('sb_set_explicit_lighting_rig', { rig: sceneRig });
        if (!res.success) {
            const why = res.error || 'the lighting operator failed';
            return {
                status: 'failed',
                resultPayload: { success: false, applied: false, notApplied: why, ...rigPayload },
                summaryResult: `NOT applied: computed only. ${why}. Computed: ${rigText}.`
            };
        }
        const switchedOff: string[] = res.data?.atmosphereSwitchedOff ?? [];
        const artifact = {
            ...active,
            data: engine.getSceneData(),
            summary: `Gaffer rig applied: ${String(style)} ${rig.keyToFillRatio}:1.`,
            version: ((active as { version?: number }).version || 1) + 1
        } as CanvasArtifact;
        return {
            resultPayload: {
                success: true,
                applied: true,
                appliedTo: active.id,
                operators: ['sb_set_explicit_lighting_rig'],
                ...rigPayload,
                sceneRig,
                atmosphereSwitchedOff: switchedOff,
                notAppliedParts,
                artifact
            },
            summaryResult: `Applied to the active 3D scene "${active.title || active.id}": ${rigText}, aimed at [${origin.map(v => +v.toFixed(2)).join(', ')}] and scaled with the content; it replaces the studio rig${switchedOff.length ? ', and the scene\'s sun/sky atmosphere was switched off' : ''}. Not reproduced: ${notAppliedParts.join('; ')}.`
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

        const coords = asGeodetic(args.geodeticCoords);
        const result = await matchLightingToReference({
            imagePath,
            landmarkName: asString(args.landmarkName) || undefined,
            geodeticCoords: coords ? { lat: coords.lat, lng: coords.lng } : undefined,
            timestampIso: asString(args.isoDate) || undefined,
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
    },

    lighting_match_image_to_location: async (args, _ctx) => {
        const imagePath = asString(args.imagePath);
        if (!imagePath) throw new Error('lighting_match_image_to_location: imagePath is required.');

        const result = await matchImageAndLightingToLocation({
            imagePath,
            locationName: asString(args.locationName) || undefined,
            geodeticCoords: asGeodetic(args.geodeticCoords),
            timestampIso: asString(args.isoDate) || undefined,
            cameraPosition: asVec3(args.cameraPosition),
            cameraTarget: asVec3(args.cameraTarget),
            fovDeg: typeof args.fovDeg === 'number' ? args.fovDeg : undefined,
            stoneType: asString(args.stoneType) || 'travertine',
            autoExportUsd: args.autoExportUsd !== false,
            outputUsdPath: asString(args.outputUsdPath) || undefined
        });

        return {
            resultPayload: {
                success: result.success,
                location: result.location,
                cameraPose: result.cameraPose,
                lightingRig: result.lightingRig,
                threeJsUniforms: result.threeJsUniforms,
                usdExportPath: result.usdExportPath,
                mtlxExportPath: result.mtlxExportPath,
                summary: result.summary
            },
            summaryResult: result.summary
        };
    }
};
