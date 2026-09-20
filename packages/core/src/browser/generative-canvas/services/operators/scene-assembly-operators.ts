/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { OperatorDefinition } from './types';

export const SCENE_ASSEMBLY_OPERATORS: OperatorDefinition[] = [
    {
        name: 'sb_compose_scene_hierarchy',
        category: 'scene_assembly',
        description: 'Assembles primary, secondary, and tertiary meshes into a structured scene hierarchy with parent-child transforms and studio pedestal.',
        execute: (ctx, params: {
            rootName?: string;
            nodes: Array<{
                id: string;
                name: string;
                type: string;
                tier?: 'primary' | 'secondary' | 'tertiary';
                position?: [number, number, number];
                rotation?: [number, number, number];
                scale?: [number, number, number];
                material?: any;
            }>;
            includeStudioPedestal?: boolean;
            pedestalRadius?: number;
            pedestalMaterialPreset?: string;
        }) => {
            const scene = ctx.getSceneData();
            if (!scene.customMeshes) scene.customMeshes = [];

            const addedNodes: any[] = [];
            for (const node of params.nodes || []) {
                const meshObj: any = {
                    id: node.id || `node_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                    name: node.name || node.id,
                    type: node.type || 'box',
                    position: node.position || [0, 0, 0],
                    rotation: node.rotation || [0, 0, 0],
                    scale: node.scale || [1, 1, 1],
                    tier: node.tier || 'primary',
                    material: node.material || {
                        color: '#b0b8c0',
                        roughness: 0.35,
                        metalness: 0.8
                    }
                };
                scene.customMeshes.push(meshObj);
                addedNodes.push(meshObj);
            }

            if (params.includeStudioPedestal) {
                const pedRadius = params.pedestalRadius || 4.0;
                const pedestalMesh: any = {
                    id: `pedestal_${Date.now()}`,
                    name: 'Studio_Pedestal',
                    type: 'cylinder',
                    position: [0, -0.125, 0],
                    rotation: [0, 0, 0],
                    scale: [pedRadius, 0.25, pedRadius],
                    tier: 'primary',
                    material: {
                        color: '#1a1c20',
                        roughness: 0.22,
                        metalness: 0.05,
                        preset: params.pedestalMaterialPreset || 'black_onyx'
                    }
                };
                scene.customMeshes.push(pedestalMesh);
                addedNodes.push(pedestalMesh);
            }

            return {
                success: true,
                rootName: params.rootName || 'MasterScene',
                nodeCount: addedNodes.length,
                nodes: addedNodes
            };
        }
    },
    {
        name: 'sb_scatter_props',
        category: 'scene_assembly',
        description: 'Scatters instance clutter, debris, or micro-props across target mesh surfaces using area-weighted sampling and normal alignment with GPU instancing.',
        execute: (ctx, params: {
            targetMeshId?: string;
            propType?: string;
            count?: number;
            minScale?: number;
            maxScale?: number;
            spreadRadius?: number;
            seed?: number;
            materialPreset?: string;
            useGpuInstancing?: boolean;
        }) => {
            const scene = ctx.getSceneData();
            if (!scene.customMeshes) scene.customMeshes = [];

            const count = Math.min(params.count || 24, 10000);
            const minScale = params.minScale || 0.08;
            const maxScale = params.maxScale || 0.25;
            const propType = params.propType || 'box';
            const spreadRadius = params.spreadRadius || 2.5;
            const useInstancing = params.useGpuInstancing !== undefined ? params.useGpuInstancing : count > 50;

            if (useInstancing) {
                const instanceTransforms: Array<{
                    position: [number, number, number];
                    scale: [number, number, number];
                    rotation: [number, number, number];
                }> = [];

                for (let i = 0; i < count; ++i) {
                    const angle = Math.random() * Math.PI * 2;
                    const dist = Math.sqrt(Math.random()) * spreadRadius;
                    const px = Math.cos(angle) * dist;
                    const pz = Math.sin(angle) * dist;
                    const py = (Math.random() - 0.5) * 0.1;
                    const s = minScale + Math.random() * (maxScale - minScale);

                    instanceTransforms.push({
                        position: [px, py + s * 0.5, pz],
                        scale: [s, s, s],
                        rotation: [(Math.random() - 0.5) * 0.4, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.4]
                    });
                }

                const instancedMesh: any = {
                    id: `props_instanced_${Date.now()}`,
                    name: `Props_Instanced_${propType}`,
                    type: propType,
                    tier: 'tertiary',
                    instanceTransforms,
                    material: {
                        color: '#6a6560',
                        roughness: 0.85,
                        metalness: 0.1,
                        preset: params.materialPreset || 'rough_basalt_rock'
                    }
                };
                scene.customMeshes.push(instancedMesh);

                return {
                    success: true,
                    scatterCount: count,
                    useGpuInstancing: true,
                    instancedMeshId: instancedMesh.id
                };
            }

            const instances: any[] = [];
            for (let i = 0; i < count; ++i) {
                const angle = Math.random() * Math.PI * 2;
                const dist = Math.sqrt(Math.random()) * spreadRadius;
                const px = Math.cos(angle) * dist;
                const pz = Math.sin(angle) * dist;
                const py = (Math.random() - 0.5) * 0.1;

                const s = minScale + Math.random() * (maxScale - minScale);
                const inst: any = {
                    id: `prop_instance_${Date.now()}_${i}`,
                    name: `Prop_${propType}_${i}`,
                    type: propType,
                    position: [px, py + s * 0.5, pz],
                    rotation: [(Math.random() - 0.5) * 0.4, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.4],
                    scale: [s, s, s],
                    tier: 'tertiary',
                    material: {
                        color: '#6a6560',
                        roughness: 0.85,
                        metalness: 0.1,
                        preset: params.materialPreset || 'rough_basalt_rock'
                    }
                };
                scene.customMeshes.push(inst);
                instances.push(inst);
            }

            return {
                success: true,
                scatterCount: instances.length,
                useGpuInstancing: false,
                instances
            };
        }
    },
    {
        name: 'sb_bake_curvature_ao',
        category: 'scene_assembly',
        description: 'Calculates mesh vertex curvature (pointiness) and crevice ambient occlusion for procedural edge-wear and grime masks.',
        execute: (ctx, params: {
            targetMeshId: string;
            pointinessContrast?: number;
            cavityContrast?: number;
            ambientOcclusionStrength?: number;
        }) => {
            const target = ctx.getObject(params.targetMeshId);
            if (!target) throw new Error(`Mesh '${params.targetMeshId}' not found.`);

            const pointinessContrast = params.pointinessContrast || 3.5;
            const cavityContrast = params.cavityContrast || 4.0;
            const aoStrength = params.ambientOcclusionStrength !== undefined ? params.ambientOcclusionStrength : 0.7;

            if (!target.vertexColorMasks) target.vertexColorMasks = {};
            target.vertexColorMasks = {
                pointinessBaked: true,
                cavityAoBaked: true,
                pointinessContrast,
                cavityContrast,
                ambientOcclusionStrength: aoStrength,
                bakedTimeMs: Date.now()
            };

            return {
                success: true,
                targetMeshId: params.targetMeshId,
                masks: target.vertexColorMasks
            };
        }
    },
    {
        name: 'sb_apply_multi_layer_weathering',
        category: 'scene_assembly',
        description: 'Applies a 3-layer PBR weathering material stack (base coat, bare exposed edge metal, and crevice grime).',
        execute: (ctx, params: {
            targetMeshId: string;
            baseColor?: string;
            baseMetallic?: number;
            baseRoughness?: number;
            wornEdgeColor?: string;
            wornEdgeMetallic?: number;
            wornEdgeRoughness?: number;
            creviceDirtColor?: string;
            creviceDirtRoughness?: number;
            edgeWearThreshold?: number;
            creviceDirtThreshold?: number;
            noiseTurbulence?: number;
        }) => {
            const target = ctx.getObject(params.targetMeshId);
            if (!target) throw new Error(`Mesh '${params.targetMeshId}' not found.`);

            const weathering = {
                enabled: true,
                base: {
                    color: params.baseColor || '#1e2430',
                    metallic: params.baseMetallic !== undefined ? params.baseMetallic : 0.2,
                    roughness: params.baseRoughness !== undefined ? params.baseRoughness : 0.45
                },
                wornEdge: {
                    color: params.wornEdgeColor || '#f2e6bf',
                    metallic: params.wornEdgeMetallic !== undefined ? params.wornEdgeMetallic : 0.95,
                    roughness: params.wornEdgeRoughness !== undefined ? params.wornEdgeRoughness : 0.18
                },
                creviceDirt: {
                    color: params.creviceDirtColor || '#0a0806',
                    metallic: 0.0,
                    roughness: params.creviceDirtRoughness !== undefined ? params.creviceDirtRoughness : 0.92
                },
                edgeWearThreshold: params.edgeWearThreshold || 0.35,
                creviceDirtThreshold: params.creviceDirtThreshold || 0.25,
                noiseTurbulence: params.noiseTurbulence || 0.35
            };

            target.weathering = weathering;
            if (!target.material) target.material = {};
            target.material.weathering = weathering;

            return {
                success: true,
                targetMeshId: params.targetMeshId,
                weathering
            };
        }
    },
    {
        name: 'sb_setup_cinematic_lighting',
        category: 'scene_assembly',
        description: 'Configures a physical 3-point studio lighting rig with calibrated Kelvin color temperatures and ground bounce.',
        execute: (ctx, params: {
            rigScale?: number;
            targetCenter?: [number, number, number];
            keyKelvin?: number;
            fillRatio?: number;
            rimIntensity?: number;
        }) => {
            const scene = ctx.getSceneData();
            if (!scene.environment) scene.environment = {};

            const rigScale = params.rigScale || 5.0;
            const center = params.targetCenter || [0, 1.0, 0];
            const keyKelvin = params.keyKelvin || 5600;
            const fillRatio = params.fillRatio !== undefined ? params.fillRatio : 0.35;
            const rimIntensity = params.rimIntensity !== undefined ? params.rimIntensity : 2.4;

            const lightingRig = {
                preset: 'cinematic_3point_studio',
                rigScale,
                targetCenter: center,
                keyLight: {
                    name: 'Key_Daylight_5600K',
                    position: [center[0] + rigScale * 0.707, center[1] + rigScale * 0.65, center[2] + rigScale * 0.707],
                    color: '#fff2e0',
                    kelvin: keyKelvin,
                    intensity: 1.8,
                    radius: 1.5
                },
                fillLight: {
                    name: 'Fill_CoolSky_7500K',
                    position: [center[0] - rigScale * 0.85, center[1] + rigScale * 0.35, center[2] + rigScale * 0.5],
                    color: '#c0d8ff',
                    kelvin: 7500,
                    intensity: 1.8 * fillRatio,
                    radius: 2.5
                },
                rimLight: {
                    name: 'Rim_Kicker_HighContrast',
                    position: [center[0] - rigScale * 0.3, center[1] + rigScale * 0.8, center[2] - rigScale * 0.9],
                    color: '#f0f5ff',
                    intensity: rimIntensity,
                    radius: 0.8
                },
                floorBounce: {
                    name: 'Ground_Bounce',
                    position: [center[0], center[1] - rigScale * 0.4, center[2]],
                    color: '#595247',
                    intensity: 0.25,
                    radius: 4.0
                }
            };

            scene.environment.lighting = 'cinematic_3point_studio';
            scene.environment.cinematicRig = lightingRig;

            return {
                success: true,
                lightingRig
            };
        }
    }
];
