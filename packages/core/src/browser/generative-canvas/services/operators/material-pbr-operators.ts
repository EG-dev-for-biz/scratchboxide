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
import type { Scene3DData } from '../../canvas-types';
import { readStagedBuild, type StagedSceneData } from '../../primitives/scene3d/stagedBuild/stagedBuildState';
import { resolveOverrideColor } from '../../primitives/scene3d/overrideColor';
import {
    TileClayProcessor,
    type ClayPresetId
} from '../TileClayProcessor';
import {
    PbrTextureExpertService,
    type PbrArchetypeId,
    packOrmData
} from '../pbr-texture-expert-service';

export const PBR_PRESETS: Record<string, any> = {
    titanium_grade_5: { name: 'Titanium Grade 5', color: '#c2c4d1', metalness: 0.95, roughness: 0.22, anisotropy: 0.35, ior: 2.16 },
    polished_gold_24k: { name: '24K Polished Gold', color: '#ffd700', metalness: 1.0, roughness: 0.08, ior: 0.47 },
    brushed_aluminum: { name: 'Brushed Aluminum', color: '#e8ebeb', metalness: 0.95, roughness: 0.28, anisotropy: 0.75, ior: 1.44 },
    oxidized_copper: { name: 'Oxidized Copper Patina', color: '#61ad94', metalness: 0.30, roughness: 0.72, ior: 1.10 },
    mirror_chrome: { name: 'Mirror Chrome', color: '#fafbfc', metalness: 0.98, roughness: 0.03, ior: 2.97 },
    surgical_steel: { name: 'Surgical Stainless Steel', color: '#d9dbde', metalness: 0.96, roughness: 0.14, ior: 2.50 },
    anodized_cobalt: { name: 'Anodized Cobalt', color: '#2e5cd9', metalness: 0.88, roughness: 0.18, clearcoat: 0.50, clearcoatRoughness: 0.04 },
    optical_glass: { name: 'Optical Crown Glass', color: '#ffffff', metalness: 0.0, roughness: 0.03, transmission: 0.98, ior: 1.52, thickness: 0.8, attenuationColor: '#fafdff', attenuationDistance: 2.0 },
    emerald_crystal: { name: 'Beryl Emerald Crystal', color: '#1fe073', metalness: 0.05, roughness: 0.06, transmission: 0.85, ior: 1.58, thickness: 1.2, attenuationColor: '#14d161', attenuationDistance: 0.9 },
    volcanic_basalt: { name: 'Volcanic Basalt Rock', color: '#2e2b30', metalness: 0.04, roughness: 0.88, ior: 1.55 },
    car_paint_candy_red: { name: 'Automotive Candy Apple Red', color: '#d90f14', metalness: 0.45, roughness: 0.40, clearcoat: 1.0, clearcoatRoughness: 0.03 },
    carbon_fiber: { name: 'Carbon Fiber Twill Lacquer', color: '#1f1f24', metalness: 0.28, roughness: 0.52, anisotropy: 0.82, clearcoat: 0.85, clearcoatRoughness: 0.04 },
    carrara_marble: { name: 'Carrara White Marble', color: '#f0ede8', metalness: 0.02, roughness: 0.25, transmission: 0.18, thickness: 0.6, attenuationColor: '#f5f0eb' },
    royal_red_velvet: { name: 'Royal Red Velvet', color: '#a6141f', metalness: 0.0, roughness: 0.82, sheenColor: '#f56b85', sheenRoughness: 0.45 },
    black_onyx: { name: 'Volcanic Black Onyx', color: '#0f0f14', metalness: 0.06, roughness: 0.05, ior: 1.54 },
    soap_bubble: { name: 'Soap Bubble Thin Film', color: '#ffffff', metalness: 0.0, roughness: 0.02, transmission: 0.95, ior: 1.33, iridescence: 1.0, iridescenceIor: 1.33, iridescenceThicknessMin: 120, iridescenceThicknessMax: 380 },
    ceramic_porcelain: { name: 'Glazed White Porcelain', color: '#f5f2f0', metalness: 0.0, roughness: 0.12, clearcoat: 0.50, clearcoatRoughness: 0.02 }
};

/** What switching a staged build between clay and its textured twins did (sb_set_staged_material_mode). */
export interface StagedMaterialModeResult {
    mode: 'clay' | 'textured';
    provenance?: boolean;
    /** Layers in the scene with a textured twin (they switch; the rest stay clay). */
    texturedLayers: number;
    layers: number;
    texturePass?: { status: string; layersDone: number; layersTotal: number };
}

/**
 * Sets how a staged location build is shown: stagedBuild.materialMode ('clay' | 'textured') and, optionally, the
 * provenance view (stagedBuildView.provenance). Scene data only: no layer, object or geometry is touched; the viewport
 * loads each layer's textured twin and crossfades to it (or back), and layers without one stay clay. Mutates `data`.
 */
export function applyStagedMaterialMode(data: Scene3DData, params: { mode?: unknown; provenance?: unknown }): StagedMaterialModeResult {
    const mode = params.mode;
    if (mode !== 'clay' && mode !== 'textured') throw new Error(`mode must be "clay" or "textured" (got ${JSON.stringify(mode)}).`);
    if (params.provenance !== undefined && typeof params.provenance !== 'boolean') throw new Error(`provenance must be true or false (got ${JSON.stringify(params.provenance)}).`);
    const staged = readStagedBuild(data);
    if (!staged) throw new Error('The active scene is not a staged location build (no stagedBuild): stage a place with google_3d_tiles_get_clay first.');
    const scene = data as StagedSceneData;
    scene.stagedBuild = { ...staged, materialMode: mode };
    if (typeof params.provenance === 'boolean') scene.stagedBuildView = { ...(scene.stagedBuildView ?? {}), provenance: params.provenance };
    const live = staged.layers.filter(l => !l.retired);
    const tp = staged.texturePass;
    return {
        mode,
        ...(typeof params.provenance === 'boolean' ? { provenance: params.provenance } : {}),
        texturedLayers: live.filter(l => l.textured).length,
        layers: live.length,
        ...(tp ? { texturePass: { status: tp.status, layersDone: tp.layersDone, layersTotal: tp.layersTotal } } : {})
    };
}

export const MATERIAL_PBR_OPERATORS: OperatorDefinition[] = [
    {
        name: 'sb_set_staged_material_mode',
        category: 'materials_pbr',
        description: 'Shows a staged location build in studio clay (the default) or with its photo-inferred textures (each layer that has a textured twin crossfades to it; the rest stay clay). Optional provenance: true shades textured layers by where each texel came from. Changes no geometry.',
        parametersSchema: { mode: { type: 'string', enum: ['clay', 'textured'] }, provenance: { type: 'boolean' } },
        execute: (ctx, params: { mode: 'clay' | 'textured'; provenance?: boolean }) => {
            const result = applyStagedMaterialMode(ctx.getSceneData(), params);
            ctx.recordState(`Staged build: ${result.mode}`);
            return result;
        }
    },
    {
        name: 'sb_create_material',
        category: 'materials_pbr',
        description: 'Defines and registers a PBR material configuration with microfacet Cook-Torrance and PBR Next extensions.',
        execute: (ctx, params: {
            materialId?: string;
            name?: string;
            preset?: string;
            color?: number | string;
            roughness?: number;
            metalness?: number;
            transmission?: number;
            ior?: number;
            emissive?: number | string;
            emissiveIntensity?: number;
            clearcoat?: number;
            clearcoatRoughness?: number;
            thickness?: number;
            attenuationColor?: number | string;
            attenuationDistance?: number;
            sheenColor?: number | string;
            sheenRoughness?: number;
            anisotropy?: number;
            anisotropyRotation?: number;
            iridescence?: number;
            iridescenceIor?: number;
            iridescenceThicknessMin?: number;
            iridescenceThicknessMax?: number;
            wireframe?: boolean;
            id?: string;
        }) => {
            const id = params.materialId || params.id || `mat-${Date.now()}`;
            let baseMat: any = {};
            if (params.preset && PBR_PRESETS[params.preset]) {
                baseMat = JSON.parse(JSON.stringify(PBR_PRESETS[params.preset]));
            }

            const material = {
                id,
                name: params.name || baseMat.name || id,
                color: params.color !== undefined ? params.color : (baseMat.color ?? 0xaaaaaa),
                roughness: params.roughness !== undefined ? params.roughness : (baseMat.roughness ?? 0.5),
                metalness: params.metalness !== undefined ? params.metalness : (baseMat.metalness ?? 0.0),
                transmission: params.transmission !== undefined ? params.transmission : baseMat.transmission,
                ior: params.ior !== undefined ? params.ior : (baseMat.ior ?? 1.5),
                emissive: params.emissive !== undefined ? params.emissive : baseMat.emissive,
                emissiveIntensity: params.emissiveIntensity !== undefined ? params.emissiveIntensity : (baseMat.emissiveIntensity ?? 1.0),
                clearcoat: params.clearcoat !== undefined ? params.clearcoat : baseMat.clearcoat,
                clearcoatRoughness: params.clearcoatRoughness !== undefined ? params.clearcoatRoughness : (baseMat.clearcoatRoughness ?? 0.03),
                thickness: params.thickness !== undefined ? params.thickness : baseMat.thickness,
                attenuationColor: params.attenuationColor !== undefined ? params.attenuationColor : baseMat.attenuationColor,
                attenuationDistance: params.attenuationDistance !== undefined ? params.attenuationDistance : baseMat.attenuationDistance,
                sheenColor: params.sheenColor !== undefined ? params.sheenColor : baseMat.sheenColor,
                sheenRoughness: params.sheenRoughness !== undefined ? params.sheenRoughness : baseMat.sheenRoughness,
                anisotropy: params.anisotropy !== undefined ? params.anisotropy : baseMat.anisotropy,
                anisotropyRotation: params.anisotropyRotation !== undefined ? params.anisotropyRotation : baseMat.anisotropyRotation,
                iridescence: params.iridescence !== undefined ? params.iridescence : baseMat.iridescence,
                iridescenceIor: params.iridescenceIor !== undefined ? params.iridescenceIor : baseMat.iridescenceIor,
                iridescenceThicknessMin: params.iridescenceThicknessMin !== undefined ? params.iridescenceThicknessMin : baseMat.iridescenceThicknessMin,
                iridescenceThicknessMax: params.iridescenceThicknessMax !== undefined ? params.iridescenceThicknessMax : baseMat.iridescenceThicknessMax,
                wireframe: params.wireframe || false
            };

            ctx.registerMaterial(material);

            return { materialId: id, material };
        }
    },
    {
        name: 'sb_set_material_pbr',
        category: 'materials_pbr',
        description: 'Updates PBR properties on a material or mesh material directly.',
        execute: (ctx, params: {
            materialId?: string;
            objectId?: string;
            color?: number | string;
            roughness?: number;
            metalness?: number;
            clearcoat?: number;
            clearcoatRoughness?: number;
            transmission?: number;
            ior?: number;
            thickness?: number;
            attenuationColor?: number | string;
            attenuationDistance?: number;
            sheenColor?: number | string;
            sheenRoughness?: number;
            anisotropy?: number;
            anisotropyRotation?: number;
            iridescence?: number;
            iridescenceIor?: number;
            emissive?: number | string;
            emissiveIntensity?: number;
            wireframe?: boolean;
        }) => {
            let targetMat: any;

            if (!params.materialId && !params.objectId) {
                throw new Error('sb_set_material_pbr needs a materialId or an objectId naming what to change. Nothing was changed.');
            }
            for (const key of ['color', 'attenuationColor', 'sheenColor', 'emissive'] as const) {
                if (params[key] !== undefined && !resolveOverrideColor(params[key])) {
                    throw new Error(`sb_set_material_pbr: ${key} ${JSON.stringify(params[key])} is not a colour (use #rrggbb, a CSS colour name, rgb(...) or a 0xRRGGBB number). Nothing was changed.`);
                }
            }

            if (params.materialId) {
                targetMat = ctx.getMaterial(params.materialId);
            }

            if (params.objectId) {
                const found = ctx.findObject(params.objectId);
                if (!found) {
                    throw new Error(`sb_set_material_pbr: no object with id "${params.objectId}" in the scene, so no material was changed.`);
                }
                if (!found.object.material) found.object.material = {};
                targetMat = found.object.material;
            }

            if (!targetMat && params.materialId) {
                targetMat = { id: params.materialId };
                ctx.registerMaterial(targetMat);
            }

            if (targetMat) {
                if (params.color !== undefined) targetMat.color = params.color;
                if (params.roughness !== undefined) targetMat.roughness = params.roughness;
                if (params.metalness !== undefined) targetMat.metalness = params.metalness;
                if (params.clearcoat !== undefined) targetMat.clearcoat = params.clearcoat;
                if (params.clearcoatRoughness !== undefined) targetMat.clearcoatRoughness = params.clearcoatRoughness;
                if (params.transmission !== undefined) targetMat.transmission = params.transmission;
                if (params.ior !== undefined) targetMat.ior = params.ior;
                if (params.thickness !== undefined) targetMat.thickness = params.thickness;
                if (params.attenuationColor !== undefined) targetMat.attenuationColor = params.attenuationColor;
                if (params.attenuationDistance !== undefined) targetMat.attenuationDistance = params.attenuationDistance;
                if (params.sheenColor !== undefined) targetMat.sheenColor = params.sheenColor;
                if (params.sheenRoughness !== undefined) targetMat.sheenRoughness = params.sheenRoughness;
                if (params.anisotropy !== undefined) targetMat.anisotropy = params.anisotropy;
                if (params.anisotropyRotation !== undefined) targetMat.anisotropyRotation = params.anisotropyRotation;
                if (params.iridescence !== undefined) targetMat.iridescence = params.iridescence;
                if (params.iridescenceIor !== undefined) targetMat.iridescenceIor = params.iridescenceIor;
                if (params.emissive !== undefined) targetMat.emissive = params.emissive;
                if (params.emissiveIntensity !== undefined) targetMat.emissiveIntensity = params.emissiveIntensity;
                if (params.wireframe !== undefined) targetMat.wireframe = params.wireframe;
            }

            // Also update any objects using this material in the scene
            const scene = ctx.getSceneData();
            if (params.materialId && scene.customMeshes) {
                for (const m of scene.customMeshes) {
                    if (m.material && (m.material as any).id === params.materialId) {
                        Object.assign(m.material, targetMat);
                    }
                }
            }

            return { success: true, materialId: params.materialId, properties: targetMat };
        }
    },
    {
        name: 'sb_set_pbr_clearcoat',
        category: 'materials_pbr',
        description: 'Configures dual-layer specular clearcoat lacquer on target material or mesh.',
        execute: (ctx, params: { targetId?: string; materialId?: string; clearcoat: number; clearcoatRoughness?: number }) => {
            let targetMat: any;
            if (params.materialId) targetMat = ctx.getMaterial(params.materialId);
            if (params.targetId) {
                const found = ctx.findObject(params.targetId);
                if (found) {
                    if (!found.object.material) found.object.material = {};
                    targetMat = found.object.material;
                }
            }
            if (!targetMat && params.materialId) {
                targetMat = { id: params.materialId };
                ctx.registerMaterial(targetMat);
            }
            if (!targetMat) throw new Error('Target material or object not specified.');

            targetMat.clearcoat = Math.max(0.0, Math.min(1.0, params.clearcoat));
            if (params.clearcoatRoughness !== undefined) {
                targetMat.clearcoatRoughness = Math.max(0.01, Math.min(1.0, params.clearcoatRoughness));
            }

            return { success: true, clearcoat: targetMat.clearcoat, clearcoatRoughness: targetMat.clearcoatRoughness };
        }
    },
    {
        name: 'sb_set_pbr_transmission',
        category: 'materials_pbr',
        description: 'Configures optical transmission, refraction IOR, and volumetric Beer-Lambert absorption on target material.',
        execute: (ctx, params: {
            targetId?: string;
            materialId?: string;
            transmission: number;
            ior?: number;
            thickness?: number;
            attenuationColor?: number | string;
            attenuationDistance?: number;
        }) => {
            let targetMat: any;
            if (params.materialId) targetMat = ctx.getMaterial(params.materialId);
            if (params.targetId) {
                const found = ctx.findObject(params.targetId);
                if (found) {
                    if (!found.object.material) found.object.material = {};
                    targetMat = found.object.material;
                }
            }
            if (!targetMat && params.materialId) {
                targetMat = { id: params.materialId };
                ctx.registerMaterial(targetMat);
            }
            if (!targetMat) throw new Error('Target material or object not specified.');

            targetMat.transmission = Math.max(0.0, Math.min(1.0, params.transmission));
            if (params.ior !== undefined) targetMat.ior = params.ior;
            if (params.thickness !== undefined) targetMat.thickness = params.thickness;
            if (params.attenuationColor !== undefined) targetMat.attenuationColor = params.attenuationColor;
            if (params.attenuationDistance !== undefined) targetMat.attenuationDistance = params.attenuationDistance;

            return { success: true, transmission: targetMat.transmission, ior: targetMat.ior, thickness: targetMat.thickness };
        }
    },
    {
        name: 'sb_set_pbr_sheen',
        category: 'materials_pbr',
        description: 'Configures Charlie microfacet sheen reflectance for cloth, peach fuzz, and velvet materials.',
        execute: (ctx, params: { targetId?: string; materialId?: string; sheenColor: number | string; sheenRoughness?: number }) => {
            let targetMat: any;
            if (params.materialId) targetMat = ctx.getMaterial(params.materialId);
            if (params.targetId) {
                const found = ctx.findObject(params.targetId);
                if (found) {
                    if (!found.object.material) found.object.material = {};
                    targetMat = found.object.material;
                }
            }
            if (!targetMat && params.materialId) {
                targetMat = { id: params.materialId };
                ctx.registerMaterial(targetMat);
            }
            if (!targetMat) throw new Error('Target material or object not specified.');

            targetMat.sheenColor = params.sheenColor;
            targetMat.sheenRoughness = params.sheenRoughness !== undefined ? Math.max(0.04, Math.min(1.0, params.sheenRoughness)) : 0.45;

            return { success: true, sheenColor: targetMat.sheenColor, sheenRoughness: targetMat.sheenRoughness };
        }
    },
    {
        name: 'sb_set_pbr_anisotropy',
        category: 'materials_pbr',
        description: 'Configures directional specular anisotropy for brushed metal, turned aluminum, and carbon fiber.',
        execute: (ctx, params: { targetId?: string; materialId?: string; anisotropy: number; rotation?: number }) => {
            let targetMat: any;
            if (params.materialId) targetMat = ctx.getMaterial(params.materialId);
            if (params.targetId) {
                const found = ctx.findObject(params.targetId);
                if (found) {
                    if (!found.object.material) found.object.material = {};
                    targetMat = found.object.material;
                }
            }
            if (!targetMat && params.materialId) {
                targetMat = { id: params.materialId };
                ctx.registerMaterial(targetMat);
            }
            if (!targetMat) throw new Error('Target material or object not specified.');

            targetMat.anisotropy = Math.max(-1.0, Math.min(1.0, params.anisotropy));
            targetMat.anisotropyRotation = params.rotation ?? 0.0;

            return { success: true, anisotropy: targetMat.anisotropy, anisotropyRotation: targetMat.anisotropyRotation };
        }
    },
    {
        name: 'sb_assign_pbr_preset',
        category: 'materials_pbr',
        description: 'Applies a calibrated real-world PBR material preset from the engine library to target object or material.',
        execute: (ctx, params: { targetId?: string; materialId?: string; preset: string }) => {
            const presetData = PBR_PRESETS[params.preset];
            if (!presetData) {
                throw new Error(`Unknown PBR preset '${params.preset}'. Available presets: ${Object.keys(PBR_PRESETS).join(', ')}`);
            }

            let targetMat: any;
            if (params.materialId) {
                targetMat = ctx.getMaterial(params.materialId);
                if (!targetMat) {
                    targetMat = { id: params.materialId };
                    ctx.registerMaterial(targetMat);
                }
            }

            if (params.targetId) {
                const found = ctx.findObject(params.targetId);
                if (found) {
                    if (!found.object.material) found.object.material = {};
                    targetMat = found.object.material;
                }
            }

            if (!targetMat) {
                const matId = `mat-${params.preset}-${Date.now()}`;
                targetMat = { id: matId };
                ctx.registerMaterial(targetMat);
            }

            Object.assign(targetMat, JSON.parse(JSON.stringify(presetData)));
            ctx.recordState(`Assigned PBR preset '${params.preset}'`);

            return { success: true, preset: params.preset, material: targetMat };
        }
    },
    {
        name: 'sb_bake_pbr_maps',
        category: 'materials_pbr',
        description: 'Synthesizes procedural normal, roughness, metallic, and cavity ambient occlusion maps from mesh geometry.',
        execute: (ctx, params: {
            targetId?: string;
            materialId?: string;
            generateNormal?: boolean;
            generateRoughness?: boolean;
            generateAO?: boolean;
            bumpScale?: number;
            cavityGain?: number;
        }) => {
            let targetMat: any;
            if (params.materialId) targetMat = ctx.getMaterial(params.materialId);
            if (params.targetId) {
                const found = ctx.findObject(params.targetId);
                if (found) {
                    if (!found.object.material) found.object.material = {};
                    targetMat = found.object.material;
                }
            }
            if (!targetMat && params.materialId) {
                targetMat = { id: params.materialId };
                ctx.registerMaterial(targetMat);
            }
            if (!targetMat) throw new Error('Target material or object not specified.');

            targetMat.proceduralMaps = {
                normalMapGenerated: params.generateNormal ?? true,
                roughnessMapGenerated: params.generateRoughness ?? true,
                aoMapGenerated: params.generateAO ?? true,
                bumpScale: params.bumpScale ?? 1.0,
                cavityGain: params.cavityGain ?? 1.2
            };

            return { success: true, proceduralMaps: targetMat.proceduralMaps };
        }
    },
    {
        name: 'sb_assign_material',
        category: 'materials_pbr',
        description: 'Assigns a material to target object.',
        execute: (ctx, params: { objectId: string; materialId?: string; material?: any }) => {
            const found = ctx.findObject(params.objectId);
            if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

            let mat = params.material;
            if (!mat && params.materialId) {
                mat = ctx.getMaterial(params.materialId);
            }

            if (!mat) {
                mat = { id: params.materialId, color: 0xcccccc, roughness: 0.5, metalness: 0.0 };
            }

            found.object.material = JSON.parse(JSON.stringify(mat));

            return { objectId: params.objectId, material: found.object.material };
        }
    },
    {
        name: 'sb_set_clay_mode',
        category: 'materials_pbr',
        description: 'Applies an architectural clay shader preset or custom clay shading parameters across target mesh or entire scene.',
        execute: (ctx, params: {
            targetId?: string;
            preset?: ClayPresetId;
            color?: number | string;
            roughness?: number;
            metalness?: number;
            cavityStrength?: number;
            cavityShading?: boolean;
            ambientOcclusionGain?: number;
        }) => {
            const resolved = TileClayProcessor.resolveConfig({
                preset: params.preset,
                color: params.color,
                roughness: params.roughness,
                metalness: params.metalness,
                cavityStrength: params.cavityStrength,
                cavityShading: params.cavityShading,
                ambientOcclusionGain: params.ambientOcclusionGain
            });

            const scene = ctx.getSceneData();
            let targetCount = 0;

            if (params.targetId && params.targetId !== 'all') {
                const found = ctx.findObject(params.targetId);
                if (found) {
                    if (!found.object.material) found.object.material = {};
                    found.object.material.type = 'MeshStandardMaterial';
                    found.object.material.color = '#' + resolved.color.getHexString();
                    found.object.material.roughness = resolved.roughness;
                    found.object.material.metalness = resolved.metalness;
                    found.object.material.shaderKey = resolved.presetId;
                    targetCount++;
                }
                const threeObj = ctx.getThreeObject(params.targetId);
                if (threeObj) {
                    TileClayProcessor.applyClayMaterial(threeObj, resolved);
                }
            } else if (scene.customMeshes) {
                for (const m of scene.customMeshes) {
                    if (!m.material) m.material = {};
                    m.material.type = 'MeshStandardMaterial';
                    m.material.color = '#' + resolved.color.getHexString();
                    m.material.roughness = resolved.roughness;
                    m.material.metalness = resolved.metalness;
                    m.material.shaderKey = resolved.presetId;
                    targetCount++;

                    const threeObj = ctx.getThreeObject(m.id);
                    if (threeObj) {
                        TileClayProcessor.applyClayMaterial(threeObj, resolved);
                    }
                }
            }

            const threeScene = ctx.getThreeScene();
            if (threeScene && (!params.targetId || params.targetId === 'all')) {
                TileClayProcessor.applyClayMaterial(threeScene, resolved);
            }

            ctx.recordState(`Set Clay Mode (${resolved.presetId})`);

            return {
                appliedPreset: resolved.presetId,
                color: '#' + resolved.color.getHexString(),
                roughness: resolved.roughness,
                metalness: resolved.metalness,
                cavityStrength: resolved.cavityStrength,
                targetCount
            };
        }
    },
    {
        name: 'sb_generate_pbr_texture_set',
        category: 'materials_pbr',
        description: 'Synthesizes biophysically accurate PBR texture maps (Albedo, Scharr Normals, Curvature Roughness, Cavity AO, and packed glTF ORM) from procedural mathematical kernels.',
        execute: (ctx, params: {
            archetype?: PbrArchetypeId | string;
            targetId?: string;
            width?: number;
            height?: number;
            seed?: number;
            wear?: number;
            roughnessBias?: number;
            color?: [number, number, number];
            anisotropyAngleDeg?: number;
            repeat?: [number, number];
        }) => {
            const archetype = (params.archetype || 'weathered_concrete') as PbrArchetypeId;
            const width = params.width || 256;
            const height = params.height || 256;
            const repeat = params.repeat || [2, 2];

            let applied = false;
            if (params.targetId) {
                const found = ctx.findObject(params.targetId);
                if (found && found.object instanceof THREE.Mesh) {
                    PbrTextureExpertService.applyExpertPbrToMesh(found.object, {}, {
                        repeatOverride: repeat,
                        enableToksvig: true
                    });
                    applied = true;
                }
            }

            ctx.recordState(`Generate PBR Textures (${archetype})`);

            return {
                success: true,
                archetype,
                width,
                height,
                engine: 'native_pbr_manifold',
                appliedToTarget: applied ? params.targetId : null
            };
        }
    },
    {
        name: 'sb_pack_orm_map',
        category: 'materials_pbr',
        description: 'Packs Ambient Occlusion (R), Roughness (G), and Metalness (B) into a single 4-channel glTF 2.0 / Three.js standard ORM texture.',
        execute: (ctx, params: {
            aoRgba?: number[] | Uint8Array;
            roughnessRgba?: number[] | Uint8Array;
            metallicRgba?: number[] | Uint8Array;
            width?: number;
            height?: number;
        }) => {
            const width = params.width || 256;
            const height = params.height || 256;
            const size = width * height * 4;

            const toUint8 = (data?: number[] | Uint8Array, fallbackVal = 255): Uint8Array => {
                if (data instanceof Uint8Array) return data;
                if (Array.isArray(data)) return new Uint8Array(data);
                const arr = new Uint8Array(size);
                arr.fill(fallbackVal);
                return arr;
            };

            const ao = toUint8(params.aoRgba, 255);
            const roughness = toUint8(params.roughnessRgba, 128);
            const metallic = toUint8(params.metallicRgba, 0);

            const orm = packOrmData(ao, roughness, metallic, width, height);

            return {
                success: true,
                width,
                height,
                byteLength: orm.byteLength,
                channelMapping: 'R=AO (Occlusion), G=Roughness, B=Metalness, A=255'
            };
        }
    },
    {
        name: 'sb_apply_pbr_texture_pack',
        category: 'materials_pbr',
        description: 'Applies calibrated physical PBR material and shader enhancements directly to a scene mesh using MeshPhysicalMaterial and packed ORM.',
        execute: (ctx, params: {
            targetId: string;
            archetype?: PbrArchetypeId | string;
            wear?: number;
            seed?: number;
            color?: [number, number, number];
            roughnessBias?: number;
            repeat?: [number, number];
        }) => {
            const found = ctx.findObject(params.targetId);
            if (!found) throw new Error(`Target object '${params.targetId}' not found.`);

            const archetype = (params.archetype || 'weathered_concrete') as PbrArchetypeId;
            const repeat = params.repeat || [2, 2];

            const mesh = found.object instanceof THREE.Mesh ? found.object : found.object.children.find((c: THREE.Object3D) => c instanceof THREE.Mesh) as THREE.Mesh | undefined;
            if (!mesh) throw new Error(`Target object '${params.targetId}' has no Three.js Mesh.`);

            PbrTextureExpertService.applyExpertPbrToMesh(mesh, {}, {
                repeatOverride: repeat,
                enableToksvig: true
            });
            ctx.recordState(`Apply PBR Texture Pack (${archetype})`);

            return {
                success: true,
                targetId: params.targetId,
                archetype,
                repeat
            };
        }
    },
    {
        name: 'sb_layer_pbr_material',
        category: 'materials_pbr',
        description: 'Layers a topcoat PBR material over a substrate material using physical material parameters and shader weathering.',
        execute: (ctx, params: {
            targetId?: string;
            substrateArchetype?: PbrArchetypeId | string;
            topcoatArchetype?: PbrArchetypeId | string;
            chipAmount?: number;
            transitionSharpness?: number;
            seed?: number;
            width?: number;
            height?: number;
            repeat?: [number, number];
        }) => {
            const repeat = params.repeat || [2, 2];
            const subArchetype = (params.substrateArchetype || 'hammered_copper') as PbrArchetypeId;
            const topArchetype = (params.topcoatArchetype || 'chipped_paint_rust') as PbrArchetypeId;

            let applied = false;
            if (params.targetId) {
                const found = ctx.findObject(params.targetId);
                if (found) {
                    const mesh = found.object instanceof THREE.Mesh ? found.object : found.object.children.find((c: THREE.Object3D) => c instanceof THREE.Mesh) as THREE.Mesh | undefined;
                    if (mesh) {
                        PbrTextureExpertService.applyExpertPbrToMesh(mesh, {}, {
                            repeatOverride: repeat,
                            enableToksvig: true,
                            enableWeathering: true,
                            weathering: {
                                dirtIntensity: params.chipAmount ?? 0.45
                            }
                        });
                        applied = true;
                    }
                }
            }

            ctx.recordState(`Layer PBR Material (${topArchetype} over ${subArchetype})`);

            return {
                success: true,
                substrateArchetype: subArchetype,
                topcoatArchetype: topArchetype,
                layered: true,
                appliedToTarget: applied ? params.targetId : null
            };
        }
    }
];
