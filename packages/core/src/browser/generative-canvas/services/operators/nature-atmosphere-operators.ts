/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import type { OperatorDefinition } from './types';
import {
    getPresetLightingState,
    calculateNOAASolarPosition,
    computeDiurnalLightingProfile,
    getSunVectorFromAngles,
    createVolumetricGodRays
} from '../atmosphere';
import {
    SbTerrainGroundEngine,
    type SlopeMaterialStop
} from '../spatial/SbTerrainGroundEngine';
import { findViewportMeshes } from './mesh-edit-operators';

export const NATURE_ATMOSPHERE_OPERATORS: OperatorDefinition[] = [
    {
        name: 'sb_apply_triplanar_material',
        category: 'materials_pbr',
        description: 'Applies seamless UV-free triplanar projection and procedural texture synthesis (rock, wood, concrete, rust, moss).',
        execute: (ctx, params: {
            targetMeshId?: string;
            materialType?: 'wood_oak' | 'rock_strata' | 'concrete_weathered' | 'rust_patina' | 'moss_overgrowth';
            sharpness?: number;
            scale?: number;
            blendNormals?: boolean;
        }) => {
            const target = params.targetMeshId ? ctx.getObject(params.targetMeshId) : null;
            const matType = params.materialType || 'rock_strata';
            const triplanarConfig = {
                enabled: true,
                materialType: matType,
                sharpness: params.sharpness || 5.0,
                scale: params.scale || 1.5,
                blendNormals: params.blendNormals !== false,
                appliedTimeMs: Date.now()
            };

            if (target) {
                if (!target.material) target.material = {};
                target.material.triplanar = triplanarConfig;
            }

            return {
                success: true,
                targetMeshId: params.targetMeshId || 'global',
                triplanar: triplanarConfig
            };
        }
    },
    {
        name: 'sb_set_subsurface_scattering',
        category: 'materials_pbr',
        description: 'Configures Burley Normalized Diffusion Subsurface Scattering (SSS) and backscatter translucency for organic materials.',
        execute: (ctx, params: {
            targetMeshId?: string;
            profile?: 'human_skin' | 'green_leaf' | 'white_marble' | 'candle_wax' | 'jade';
            scatterRadius?: [number, number, number];
            transmissionTint?: string;
            scatteringWeight?: number;
            thickness?: number;
        }) => {
            const target = params.targetMeshId ? ctx.getObject(params.targetMeshId) : null;
            const profile = params.profile || 'green_leaf';

            const sssConfig = {
                enabled: true,
                profile,
                scatterRadius: params.scatterRadius || (profile === 'human_skin' ? [3.67, 1.37, 0.68] : [0.85, 2.8, 0.45]),
                transmissionTint: params.transmissionTint || (profile === 'human_skin' ? '#ea4726' : '#7adc1f'),
                scatteringWeight: params.scatteringWeight !== undefined ? params.scatteringWeight : 0.85,
                thickness: params.thickness !== undefined ? params.thickness : 0.25,
                appliedTimeMs: Date.now()
            };

            if (target) {
                if (!target.material) target.material = {};
                target.material.subsurface = sssConfig;
            }

            return {
                success: true,
                targetMeshId: params.targetMeshId || 'global',
                subsurface: sssConfig
            };
        }
    },
    {
        name: 'sb_add_volumetric_fog',
        category: 'lighting_camera',
        description: 'Enables participating media volumetric fog with Henyey-Greenstein forward Mie scattering for cinematic god rays.',
        execute: (ctx, params: {
            density?: number;
            scatteringColor?: string;
            anisotropy?: number;
            heightScale?: number;
            groundLevel?: number;
            godRaysEnabled?: boolean;
        }) => {
            const scene = ctx.getSceneData();
            if (!scene.environment) scene.environment = {};

            const volumetricConfig = {
                enabled: true,
                density: params.density !== undefined ? params.density : 0.035,
                scatteringColor: params.scatteringColor || '#f2e1b8',
                anisotropy: params.anisotropy !== undefined ? params.anisotropy : 0.72,
                heightScale: params.heightScale !== undefined ? params.heightScale : 4.0,
                groundLevel: params.groundLevel !== undefined ? params.groundLevel : 0.0,
                godRaysEnabled: params.godRaysEnabled !== false,
                updatedTimeMs: Date.now()
            };

            (scene.environment as any).volumetricFog = volumetricConfig;

            return {
                success: true,
                volumetricFog: volumetricConfig
            };
        }
    },
    {
        name: 'sb_generate_l_system_vegetation',
        category: 'nature_atmosphere',
        description: 'Synthesizes stochastic L-System procedural trees and foliage using Leonardo da Vinci branch radius conservation.',
        execute: (ctx, params: {
            treeType?: 'oak' | 'pine' | 'bonsai' | 'willow';
            position?: [number, number, number];
            maxDepth?: number;
            initialLength?: number;
            initialRadius?: number;
            branchAngle?: number;
            childrenPerNode?: number;
            leafSize?: number;
            seed?: number;
        }) => {
            const scene = ctx.getSceneData();
            if (!scene.customMeshes) scene.customMeshes = [];

            const treeId = `tree_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
            const treeType = params.treeType || 'oak';
            const pos = params.position || [0, 0, 0];

            const treeMesh: any = {
                id: treeId,
                name: `LSystem_Tree_${treeType}`,
                type: 'custom',
                position: pos,
                rotation: [0, Math.random() * Math.PI * 2, 0],
                scale: [1, 1, 1],
                tier: 'primary',
                generator: {
                    algorithm: 'l_system',
                    treeType,
                    maxDepth: params.maxDepth || 4,
                    initialLength: params.initialLength || 3.2,
                    initialRadius: params.initialRadius || 0.32,
                    branchAngle: params.branchAngle || 30.0,
                    childrenPerNode: params.childrenPerNode || 3,
                    leafSize: params.leafSize || 0.45,
                    seed: params.seed || 42
                },
                material: {
                    color: '#4a3525',
                    roughness: 0.85,
                    metalness: 0.0,
                    subsurface: {
                        enabled: true,
                        profile: 'green_leaf'
                    }
                }
            };

            scene.customMeshes.push(treeMesh);

            return {
                success: true,
                treeId,
                treeMesh
            };
        }
    },
    {
        name: 'sb_generate_biome_terrain',
        category: 'nature_atmosphere',
        description: 'Generates procedural stratified terrain with slope-angle material masking (cliff strata, grass, sediment).',
        execute: (ctx, params: {
            width?: number;
            depth?: number;
            resolution?: number;
            maxElevation?: number;
            rockSlopeThreshold?: number;
            seed?: number;
        }) => {
            const scene = ctx.getSceneData();
            if (!scene.customMeshes) scene.customMeshes = [];

            const terrainId = `terrain_biome_${Date.now()}`;
            const terrainMesh: any = {
                id: terrainId,
                name: 'Stratified_Biome_Terrain',
                type: 'custom',
                position: [0, 0, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
                tier: 'primary',
                terrainParams: {
                    width: params.width || 20.0,
                    depth: params.depth || 20.0,
                    resolution: params.resolution || 48,
                    maxElevation: params.maxElevation || 3.8,
                    rockSlopeThreshold: params.rockSlopeThreshold || 35.0,
                    seed: params.seed || 123
                },
                material: {
                    triplanar: {
                        enabled: true,
                        materialType: 'rock_strata'
                    },
                    slopeStratification: true
                }
            };

            scene.customMeshes.push(terrainMesh);

            return {
                success: true,
                terrainId,
                terrainMesh
            };
        }
    },
    {
        name: 'sb_transfer_foliage_normals',
        category: 'nature_atmosphere',
        description: 'Transfers smooth shading directions from envelope volumes onto foliage mesh vertices (Blender Data Transfer technique for soft plant cards).',
        execute: (ctx, params: {
            targetMeshId?: string;
            mixFactor?: number;
            upwardBias?: number;
            helpers?: Array<{ center: [number, number, number]; radius: number; eccentricity?: [number, number, number] }>;
        }) => {
            const scene = ctx.getSceneData();
            const meshes = scene.customMeshes || [];
            let targets = meshes.filter((m: any) => params.targetMeshId && m.id === params.targetMeshId);
            if (targets.length === 0) {
                targets = meshes.filter((m: any) => m.name?.toLowerCase().includes('tree') || m.name?.toLowerCase().includes('foliage'));
            }
            if (targets.length === 0 && meshes.length > 0) {
                targets = [meshes[meshes.length - 1]];
            }

            for (const mesh of targets) {
                mesh.normalTransfer = {
                    enabled: true,
                    mixFactor: params.mixFactor ?? 1.0,
                    upwardBias: params.upwardBias ?? 0.2,
                    helpers: params.helpers || [{ center: [0, 2, 0], radius: 1.5 }]
                };
            }

            return {
                success: true,
                targetMeshId: params.targetMeshId || (targets[0]?.id ?? 'default'),
                affectedMeshes: targets.length,
                normalTransfer: targets[0]?.normalTransfer || {
                    enabled: true,
                    mixFactor: params.mixFactor ?? 1.0,
                    upwardBias: params.upwardBias ?? 0.2
                }
            };
        }
    },
    {
        name: 'sb_generate_detailed_foliage',
        category: 'nature_atmosphere',
        description: 'Synthesizes multi-clump detailed foliage cards with thin-wall subsurface scattering and custom envelope normals.',
        execute: (ctx, params: {
            parentTreeId?: string;
            clumpCount?: number;
            leafSize?: number;
            thinWall?: boolean;
            subsurfaceWeight?: number;
        }) => {
            const scene = ctx.getSceneData();
            if (!scene.customMeshes) scene.customMeshes = [];

            const foliageId = `foliage_${Date.now()}`;
            const foliageMesh: any = {
                id: foliageId,
                name: 'Detailed_Foliage_Cards',
                type: 'custom',
                tier: 'primary',
                parentTreeId: params.parentTreeId,
                foliageParams: {
                    clumpCount: params.clumpCount || 6,
                    leafSize: params.leafSize || 0.45,
                    thinWall: params.thinWall !== false,
                    subsurfaceWeight: params.subsurfaceWeight ?? 1.0
                },
                material: {
                    subsurface: {
                        enabled: true,
                        profile: 'green_leaf',
                        thinWall: true,
                        weight: params.subsurfaceWeight ?? 1.0
                    }
                }
            };

            scene.customMeshes.push(foliageMesh);

            return {
                success: true,
                foliageId,
                foliageMesh
            };
        }
    },
    {
        name: 'sb_configure_atmospheric_scattering',
        category: 'nature_atmosphere',
        description: 'Configures Rayleigh/Mie physical atmospheric scattering, turbidity, and 3D volumetric raymarched cloud layers.',
        execute: (ctx, params: {
            enabled?: boolean;
            rayleigh?: number;
            mie?: number;
            turbidity?: number;
            mieDirectionalG?: number;
            cloudCoverage?: number;
            cloudDensity?: number;
            cloudAltitude?: number;
            volumetricClouds?: boolean;
            wavelengthDispersion?: [number, number, number];
        }) => {
            const scene = ctx.getSceneData();
            if (!scene.features) scene.features = {};

            const currentAtm = typeof scene.features.atmosphericScattering === 'object' && scene.features.atmosphericScattering !== null
                ? scene.features.atmosphericScattering
                : {};

            const updatedAtm: any = {
                ...currentAtm,
                enabled: params.enabled !== undefined ? params.enabled : (currentAtm.enabled ?? true)
            };

            if (params.rayleigh !== undefined) updatedAtm.rayleigh = params.rayleigh;
            if (params.mie !== undefined) updatedAtm.mie = params.mie;
            if (params.turbidity !== undefined) updatedAtm.turbidity = params.turbidity;
            if (params.mieDirectionalG !== undefined) updatedAtm.mieDirectionalG = params.mieDirectionalG;
            if (params.cloudCoverage !== undefined) updatedAtm.cloudCoverage = params.cloudCoverage;
            if (params.cloudDensity !== undefined) updatedAtm.cloudDensity = params.cloudDensity;
            if (params.cloudAltitude !== undefined) updatedAtm.cloudAltitude = params.cloudAltitude;
            if (params.volumetricClouds !== undefined) updatedAtm.volumetricClouds = params.volumetricClouds;
            if (params.wavelengthDispersion) updatedAtm.wavelengthDispersion = params.wavelengthDispersion;

            scene.features.atmosphericScattering = updatedAtm;

            ctx.recordState('Configure Atmospheric Scattering & Clouds');

            return {
                success: true,
                atmosphericScattering: updatedAtm
            };
        }
    },
    {
        name: 'sb_set_diurnal_time_of_day',
        category: 'nature_atmosphere',
        description: 'Sets diurnal time of day (0.0-24.0h), NOAA geographic coordinates, or diurnal presets (golden_hour, sunset, midday, blue_hour, night), automatically recomputing sun elevation and photometric profile.',
        execute: (ctx, params: {
            timeOfDay?: number;
            preset?: string;
            latitude?: number;
            longitude?: number;
            isoDate?: string;
            sunElevation?: number;
            sunAzimuth?: number;
        }) => {
            const scene = ctx.getSceneData();
            if (!scene.features) scene.features = {};

            const currentAtm = typeof scene.features.atmosphericScattering === 'object' && scene.features.atmosphericScattering !== null
                ? scene.features.atmosphericScattering
                : {};

            let elevation = params.sunElevation ?? currentAtm.sunElevation ?? 45.0;
            let azimuth = params.sunAzimuth ?? currentAtm.sunAzimuth ?? 180.0;
            let timeOfDay = params.timeOfDay ?? currentAtm.timeOfDay ?? 12.0;

            if (params.preset) {
                const presetState = getPresetLightingState(params.preset as any);
                if (presetState) {
                    elevation = presetState.elevationDeg;
                    azimuth = presetState.azimuthDeg;
                }
            } else if (params.latitude !== undefined && params.longitude !== undefined) {
                const date = params.isoDate ? new Date(params.isoDate) : new Date();
                const ephemeris = calculateNOAASolarPosition(date, params.latitude, params.longitude);
                elevation = ephemeris.elevationDeg;
                azimuth = ephemeris.azimuthDeg;
            }

            const diurnalProfile = computeDiurnalLightingProfile(elevation);
            const sunDir = getSunVectorFromAngles(elevation, azimuth);

            const updatedAtm: any = {
                ...currentAtm,
                enabled: currentAtm.enabled ?? true,
                timeOfDay,
                sunElevation: elevation,
                sunAzimuth: azimuth,
                sunPosition: [sunDir.x * 100, sunDir.y * 100, sunDir.z * 100],
                latitude: params.latitude ?? currentAtm.latitude,
                longitude: params.longitude ?? currentAtm.longitude
            };

            scene.features.atmosphericScattering = updatedAtm;

            if (!scene.environment) scene.environment = {};
            scene.environment.timeOfDay = timeOfDay;
            scene.environment.sunElevation = elevation;
            scene.environment.sunAzimuth = azimuth;

            ctx.recordState(`Set Diurnal Time of Day: ${diurnalProfile.phase}`);

            return {
                success: true,
                timeOfDay,
                elevation,
                azimuth,
                phase: diurnalProfile.phase,
                diurnalProfile,
                sunPosition: updatedAtm.sunPosition
            };
        }
    },
    {
        name: 'sb_configure_aerial_perspective',
        category: 'nature_atmosphere',
        description: 'Configures full-screen aerial perspective depth inscattering and Beer-Lambert extinction post-processing.',
        execute: (ctx, params: {
            enabled?: boolean;
            inscatteringIntensity?: number;
            aerialPerspectiveRange?: number;
            fogDensity?: number;
            fogBaseAltitude?: number;
            fogHeight?: number;
            albedoScale?: number;
        }) => {
            const scene = ctx.getSceneData();
            if (!scene.features) scene.features = {};

            const currentAtm = typeof scene.features.atmosphericScattering === 'object' && scene.features.atmosphericScattering !== null
                ? scene.features.atmosphericScattering
                : {};

            const updatedAtm: any = {
                ...currentAtm,
                aerialPerspectiveEnabled: params.enabled !== undefined ? params.enabled : true,
                inscatteringIntensity: params.inscatteringIntensity ?? currentAtm.inscatteringIntensity ?? 0.65,
                aerialPerspectiveRange: params.aerialPerspectiveRange ?? currentAtm.aerialPerspectiveRange ?? 8000.0,
                fogDensity: params.fogDensity ?? currentAtm.fogDensity ?? 0.0003,
                fogBaseAltitude: params.fogBaseAltitude ?? currentAtm.fogBaseAltitude ?? 0.0,
                fogHeight: params.fogHeight ?? currentAtm.fogHeight ?? 120.0,
                albedoScale: params.albedoScale ?? currentAtm.albedoScale ?? 0.85
            };

            scene.features.atmosphericScattering = updatedAtm;

            ctx.recordState('Configure Aerial Perspective Post-Processing');

            return {
                success: true,
                aerialPerspective: {
                    enabled: updatedAtm.aerialPerspectiveEnabled,
                    inscatteringIntensity: updatedAtm.inscatteringIntensity,
                    aerialPerspectiveRange: updatedAtm.aerialPerspectiveRange,
                    fogDensity: updatedAtm.fogDensity
                }
            };
        }
    },
    {
        name: 'sb_configure_terrain_cloud_shadows',
        category: 'nature_atmosphere',
        description: 'Configures moving procedural fBm terrain cloud shadow projections and atmospheric attenuation.',
        execute: (ctx, params: {
            enabled?: boolean;
            cloudShadowIntensity?: number;
            cloudShadowScale?: number;
            atmosphereShadowLength?: number;
            windVector?: [number, number];
        }) => {
            const scene = ctx.getSceneData();
            if (!scene.features) scene.features = {};

            const currentAtm = typeof scene.features.atmosphericScattering === 'object' && scene.features.atmosphericScattering !== null
                ? scene.features.atmosphericScattering
                : {};

            const updatedAtm: any = {
                ...currentAtm,
                cloudShadowsEnabled: params.enabled !== undefined ? params.enabled : true,
                cloudShadowIntensity: params.cloudShadowIntensity ?? currentAtm.cloudShadowIntensity ?? 0.45,
                cloudShadowScale: params.cloudShadowScale ?? currentAtm.cloudShadowScale ?? 180.0,
                atmosphereShadowLength: params.atmosphereShadowLength ?? currentAtm.atmosphereShadowLength ?? 400.0,
                windVector: params.windVector ?? currentAtm.windVector ?? [0.03, 0.015]
            };

            scene.features.atmosphericScattering = updatedAtm;

            ctx.recordState('Configure Terrain Cloud Shadows');

            return {
                success: true,
                cloudShadows: {
                    enabled: updatedAtm.cloudShadowsEnabled,
                    cloudShadowIntensity: updatedAtm.cloudShadowIntensity,
                    cloudShadowScale: updatedAtm.cloudShadowScale,
                    windVector: updatedAtm.windVector
                }
            };
        }
    },
    {
        name: 'sb_add_volumetric_god_rays',
        category: 'nature_atmosphere',
        description: 'Deploys view-dependent volumetric sunbeams and god ray light shafts with atmospheric shimmer.',
        execute: (ctx, params: {
            enabled?: boolean;
            intensity?: number;
            color?: string | number;
            spreadRadius?: number;
            rayCount?: number;
        }) => {
            const scene = ctx.getSceneData();
            if (!scene.features) scene.features = {};

            const enabled = params.enabled !== false;
            const intensity = params.intensity ?? 0.28;
            const color = params.color ?? '#fffae0';

            scene.features.godRays = {
                enabled,
                intensity,
                color
            };

            const threeScene = ctx.getThreeScene();
            if (threeScene && enabled) {
                const sunPos = new THREE.Vector3(40, 60, 40);
                if (typeof scene.features.atmosphericScattering === 'object' && scene.features.atmosphericScattering?.sunPosition) {
                    sunPos.set(...scene.features.atmosphericScattering.sunPosition);
                }
                createVolumetricGodRays(threeScene, sunPos, false, {
                    intensity,
                    color,
                    spreadRadius: params.spreadRadius,
                    rayCount: params.rayCount
                });
            }

            ctx.recordState('Deploy Volumetric God Rays');

            return {
                success: true,
                godRays: scene.features.godRays
            };
        }
    },
    {
        name: 'sb_apply_slope_materials',
        category: 'materials_pbr',
        description: 'Gives the terrain mesh(es) named by targetMeshId in the live viewport a PBR material by their slope, measured in scene space (+Y up) through each mesh\'s whole parent chain: stops is a ramp of { slopeDeg, color: [r, g, b] sRGB 0..1, roughness 0..1, metalness 0..1 } that you choose for this ground, interpolated linearly between stops. Each mesh keeps its place, geometry and transform; the result reports its measured slope and the material it got. Fails when the mesh is not in the scene or the ramp is invalid; it never picks meshes by name keywords or builds demo terrain.',
        execute: (ctx, params: {
            targetMeshId?: string;
            stops?: SlopeMaterialStop[];
        }) => {
            // The terrain is the mesh(es) the caller names in the live viewport; nothing is picked by name keywords
            // and no demo planes are built when none is found.
            const meshes = findViewportMeshes(ctx.getThreeScene(), params.targetMeshId, 'sb_apply_slope_materials');
            const result = new SbTerrainGroundEngine().applySlopeMaterials(meshes, { stops: params.stops as SlopeMaterialStop[] });

            ctx.recordState(`SB-Terrain: Slope Materials (${result.meshes.length} mesh${result.meshes.length === 1 ? '' : 'es'} named ${params.targetMeshId})`);

            return {
                success: true,
                targetMeshId: params.targetMeshId,
                meshes: result.meshes
            };
        }
    },
    {
        name: 'sb_set_cpp_generator',
        category: 'state_history',
        description: 'Sets or updates the native C++20 procedural generator module for the 3D scene (C/C++ first directive).',
        execute: (ctx, params: { sourceCode: string; filename?: string; enabled?: boolean; vertexCount?: number; triangleCount?: number; glbBase64?: string }) => {
            if (!params.sourceCode) throw new Error("Parameter 'sourceCode' is required.");
            const scene = ctx.getSceneData();
            scene.cppGenerator = {
                enabled: params.enabled !== false,
                sourceCode: params.sourceCode,
                filename: params.filename || 'world_generator.cpp',
                vertexCount: params.vertexCount,
                triangleCount: params.triangleCount,
                glbBase64: params.glbBase64,
                lastCompiledTimeMs: Date.now()
            };
            return { success: true, cppGenerator: scene.cppGenerator };
        }
    }
];
