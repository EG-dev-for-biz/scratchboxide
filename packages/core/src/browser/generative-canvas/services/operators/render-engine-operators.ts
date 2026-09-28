/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { OperatorDefinition } from './types';

export const RENDER_ENGINE_OPERATORS: OperatorDefinition[] = [
    {
        name: 'sb_ai_render_viewport',
        category: 'lighting_camera',
        description: 'Initiates a viewport AI render pass, capturing depth, clay, and normal maps, and beautifying with Nano Banana.',
        execute: (ctx, params: { prompt: string; stylePreset?: string }) => {
            const scene = ctx.getSceneData() as any;
            scene.metadata = {
                ...scene.metadata,
                pendingAiRender: {
                    prompt: params.prompt,
                    stylePreset: params.stylePreset,
                    timestamp: Date.now()
                }
            };
            ctx.setSceneData(scene);
            return {
                success: true,
                operator: 'sb_ai_render_viewport',
                data: scene.metadata.pendingAiRender
            };
        }
    },
    {
        name: 'sb_spatial_inpaint_point',
        category: 'mesh_edit',
        description: 'Places a 3D smart point pin and schedules a localized inpaint generation.',
        execute: (ctx, params: { smartPoint: [number, number, number]; prompt: string; radiusPx?: number }) => {
            const scene = ctx.getSceneData() as any;
            if (!scene.pins) scene.pins = [];
            
            const newPin = {
                id: `smart-pin-${Date.now()}`,
                label: params.prompt,
                position: params.smartPoint,
                metadata: {
                    inpaintRadiusPx: params.radiusPx || 20,
                    inpaintPrompt: params.prompt,
                    inpaintStatus: 'pending'
                }
            };
            scene.pins.push(newPin);
            ctx.setSceneData(scene);

            return {
                success: true,
                operator: 'sb_spatial_inpaint_point',
                data: newPin
            };
        }
    },
    {
        name: 'sb_keyframe_interpolate_video',
        category: 'lighting_camera',
        description: 'Creates a camera flight keyframe pair for Omni 1.1 video interpolation.',
        execute: (ctx, params: { startPose: any; endPose: any; prompt: string; durationSeconds?: number }) => {
            const scene = ctx.getSceneData() as any;
            scene.cameraTrajectory = {
                type: 'keyframe_interpolation',
                startPose: params.startPose,
                endPose: params.endPose,
                prompt: params.prompt,
                durationSeconds: params.durationSeconds || 6
            };
            ctx.setSceneData(scene);

            return {
                success: true,
                operator: 'sb_keyframe_interpolate_video',
                data: scene.cameraTrajectory
            };
        }
    },
    {
        name: 'sb_bake_mesh_textures',
        category: 'materials_pbr',
        description: 'Triggers cardinal multi-view AI texture baking on a custom mesh using Nano Banana.',
        execute: (ctx, params: { targetId: string; stylePrompt: string }) => {
            const scene = ctx.getSceneData() as any;
            if (!scene.customMeshes) scene.customMeshes = [];
            const mesh = scene.customMeshes.find((m: any) => m.id === params.targetId) as any;
            if (!mesh) throw new Error(`Mesh with id '${params.targetId}' not found.`);

            mesh.material = {
                ...mesh.material,
                bakedAiTexture: {
                    stylePrompt: params.stylePrompt,
                    status: 'pending',
                    timestamp: Date.now()
                }
            };
            ctx.setSceneData(scene);

            return {
                success: true,
                operator: 'sb_bake_mesh_textures',
                data: mesh.material.bakedAiTexture
            };
        }
    }
];
