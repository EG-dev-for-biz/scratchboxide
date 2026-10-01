/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import {
    type OperatorDefinition,
    createGeometryForType,
    computeMeshStatsFromGeometry
} from './types';

export const INSPECT_OPERATORS: OperatorDefinition[] = [
    {
        name: 'sb_list_objects',
        category: 'inspect',
        description: 'Lists all 3D mesh assets, media objects, and scene children with transforms and types.',
        execute: (ctx, params: { type?: string; regex?: string; visibleOnly?: boolean }) => {
            const scene = ctx.getSceneData();
            const objects: any[] = [];

            if (scene.customMeshes) {
                for (const m of scene.customMeshes) {
                    if (params.type && m.type !== params.type) continue;
                    if (params.regex && !new RegExp(params.regex, 'i').test(m.name || m.id)) continue;
                    objects.push({
                        id: m.id,
                        name: m.name || m.id,
                        type: m.type || 'box',
                        position: m.position || [0, 0, 0],
                        rotation: m.rotation || [0, 0, 0],
                        scale: m.scale || [1, 1, 1],
                        material: m.material,
                        source: 'customMeshes'
                    });
                }
            }

            if (scene.objects) {
                for (const obj of scene.objects) {
                    const objType = obj.content?.type || 'media4d';
                    if (params.type && objType !== params.type) continue;
                    if (params.regex && !new RegExp(params.regex, 'i').test(obj.id)) continue;
                    const s3d = obj.space?.spatial3d;
                    objects.push({
                        id: obj.id,
                        name: obj.id,
                        type: objType,
                        position: s3d ? [s3d.x, s3d.y, s3d.z] : [0, 0, 0],
                        rotation: s3d ? [s3d.pitch || 0, s3d.yaw || 0, s3d.roll || 0] : [0, 0, 0],
                        scale: [1, 1, 1],
                        source: 'objects'
                    });
                }
            }

            return { count: objects.length, objects };
        }
    },
    {
        name: 'sb_inspect_object',
        category: 'inspect',
        description: 'Returns comprehensive topology, material, modifier, and transform properties of an object.',
        execute: (ctx, params: { objectId: string }) => {
            if (!params.objectId) throw new Error("Parameter 'objectId' is required.");
            const found = ctx.findObject(params.objectId);
            if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

            const obj = found.object;
            const pos = obj.position || (obj.space?.spatial3d ? [obj.space.spatial3d.x, obj.space.spatial3d.y, obj.space.spatial3d.z] : [0, 0, 0]);
            const rot = obj.rotation || (obj.space?.spatial3d ? [obj.space.spatial3d.pitch || 0, obj.space.spatial3d.yaw || 0, obj.space.spatial3d.roll || 0] : [0, 0, 0]);
            const scl = obj.scale || [1, 1, 1];

            return {
                id: obj.id,
                name: obj.name || obj.id,
                type: obj.type || obj.content?.type || 'box',
                position: pos,
                rotation: rot,
                scale: scl,
                material: obj.material || { color: 0xcccccc },
                modifiers: (obj as any).modifiers || [],
                physics: (obj as any).physics || undefined,
                keyframes: (obj as any).keyframes || undefined,
                geometry: obj.geometry || undefined
            };
        }
    },
    {
        name: 'sb_inspect_scene',
        category: 'inspect',
        description: 'Returns high-level statistics and metadata for the entire 3D scene.',
        execute: (ctx) => {
            const scene = ctx.getSceneData();
            const customMeshCount = scene.customMeshes?.length || 0;
            const media4DCount = scene.objects?.length || 0;
            const totalObjects = customMeshCount + media4DCount;

            return {
                title: scene.title,
                subtitle: scene.subtitle,
                worldBranch: scene.worldBranch,
                renderMode: scene.renderMode || 'pbr',
                cameraMode: scene.cameraMode || 'orbit',
                totalObjects,
                customMeshCount,
                media4DCount,
                camera: scene.camera || { position: [10, 10, 10], target: [0, 0, 0] },
                environment: scene.environment,
                features: scene.features,
                particleSystems: (scene as any).particleSystems || [],
                sceneData: scene
            };
        }
    },
    {
        name: 'sb_get_mesh_stats',
        category: 'inspect',
        description: 'Computes topological statistics (vertex count, faces, bounding box, volume, area) for a mesh.',
        execute: (ctx, params: { objectId: string }) => {
            if (!params.objectId) throw new Error("Parameter 'objectId' is required.");
            const found = ctx.findObject(params.objectId);
            if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

            const obj = found.object;
            const scale: [number, number, number] = obj.scale || [1, 1, 1];
            let geo: THREE.BufferGeometry;

            if (found.threeObject && (found.threeObject as THREE.Mesh).geometry) {
                geo = (found.threeObject as THREE.Mesh).geometry;
            } else {
                geo = createGeometryForType(obj.type || 'box', scale, obj.geometry);
            }

            return computeMeshStatsFromGeometry(geo, scale);
        }
    }
];
