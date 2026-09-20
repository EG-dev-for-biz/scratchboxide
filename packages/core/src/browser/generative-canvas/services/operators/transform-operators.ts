/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from 'three';
import type { OperatorDefinition } from './types';
import { recomputeGeometryNormals } from '../mesh-sculpting-engine';
import { TerrainManager } from '../TerrainManager';

export const TRANSFORM_OPERATORS: OperatorDefinition[] = [
    {
        name: 'sb_set_transform',
        category: 'transform',
        description: 'Directly sets absolute position, rotation (Euler), and scale for a target object.',
        execute: (ctx, params: { objectId: string; name?: string; type?: string; position?: [number, number, number]; rotation?: [number, number, number]; scale?: [number, number, number] }) => {
            let found = ctx.findObject(params.objectId);
            if (!found) {
                const scene = ctx.getSceneData();
                if (!scene.customMeshes) scene.customMeshes = [];
                const newMesh = {
                    id: params.objectId,
                    name: params.name || params.objectId,
                    type: (params.type || 'box') as any,
                    position: params.position ? [...params.position] as [number, number, number] : [0, 0, 0] as [number, number, number],
                    rotation: params.rotation ? [...params.rotation] as [number, number, number] : [0, 0, 0] as [number, number, number],
                    scale: params.scale ? [...params.scale] as [number, number, number] : [1, 1, 1] as [number, number, number]
                };
                scene.customMeshes.push(newMesh);
                found = ctx.findObject(params.objectId);
            }
            if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

            const obj = found.object;
            if (params.name && !obj.name) obj.name = params.name;
            if (params.type && !obj.type) obj.type = params.type;
            if (params.position) {
                obj.position = [...params.position];
                if (obj.space?.spatial3d) {
                    obj.space.spatial3d.x = params.position[0];
                    obj.space.spatial3d.y = params.position[1];
                    obj.space.spatial3d.z = params.position[2];
                }
                if (found.threeObject) found.threeObject.position.set(params.position[0], params.position[1], params.position[2]);
            }
            if (params.rotation) {
                obj.rotation = [...params.rotation];
                if (obj.space?.spatial3d) {
                    obj.space.spatial3d.pitch = params.rotation[0];
                    obj.space.spatial3d.yaw = params.rotation[1];
                    obj.space.spatial3d.roll = params.rotation[2];
                }
                if (found.threeObject) found.threeObject.rotation.set(params.rotation[0], params.rotation[1], params.rotation[2]);
            }
            if (params.scale) {
                obj.scale = [...params.scale];
                if (found.threeObject) found.threeObject.scale.set(params.scale[0], params.scale[1], params.scale[2]);
            }

            return { objectId: params.objectId, position: obj.position, rotation: obj.rotation, scale: obj.scale };
        }
    },
    {
        name: 'sb_translate',
        category: 'transform',
        description: 'Applies relative 3D translation delta to target object.',
        execute: (ctx, params: { objectId: string; delta: [number, number, number] | { x: number; y: number; z: number } }) => {
            const found = ctx.findObject(params.objectId);
            if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

            const dx = Array.isArray(params.delta) ? params.delta[0] : params.delta.x;
            const dy = Array.isArray(params.delta) ? params.delta[1] : params.delta.y;
            const dz = Array.isArray(params.delta) ? params.delta[2] : params.delta.z;

            const obj = found.object;
            if (!obj.position) obj.position = [0, 0, 0];
            obj.position[0] += dx;
            obj.position[1] += dy;
            obj.position[2] += dz;

            if (obj.space?.spatial3d) {
                obj.space.spatial3d.x = (obj.space.spatial3d.x || 0) + dx;
                obj.space.spatial3d.y = (obj.space.spatial3d.y || 0) + dy;
                obj.space.spatial3d.z = (obj.space.spatial3d.z || 0) + dz;
            }

            if (found.threeObject) {
                found.threeObject.position.x += dx;
                found.threeObject.position.y += dy;
                found.threeObject.position.z += dz;
            }

            return { objectId: params.objectId, position: obj.position };
        }
    },
    {
        name: 'sb_rotate',
        category: 'transform',
        description: 'Applies relative rotation delta (Euler angles in radians) to target object.',
        execute: (ctx, params: { objectId: string; delta: [number, number, number] }) => {
            const found = ctx.findObject(params.objectId);
            if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

            const obj = found.object;
            if (!obj.rotation) obj.rotation = [0, 0, 0];
            obj.rotation[0] += params.delta[0];
            obj.rotation[1] += params.delta[1];
            obj.rotation[2] += params.delta[2];

            if (found.threeObject) {
                found.threeObject.rotation.x += params.delta[0];
                found.threeObject.rotation.y += params.delta[1];
                found.threeObject.rotation.z += params.delta[2];
            }

            return { objectId: params.objectId, rotation: obj.rotation };
        }
    },
    {
        name: 'sb_scale',
        category: 'transform',
        description: 'Applies scale factors or uniform scale multiplier to target object.',
        execute: (ctx, params: { objectId: string; scale?: [number, number, number] | { x: number; y: number; z: number }; factor?: number | [number, number, number] | { x: number; y: number; z: number } }) => {
            const found = ctx.findObject(params.objectId);
            if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

            const obj = found.object;
            if (!obj.scale) obj.scale = [1, 1, 1];

            if (Array.isArray(params.scale)) {
                obj.scale[0] *= params.scale[0];
                obj.scale[1] *= params.scale[1];
                obj.scale[2] *= params.scale[2];
            } else if (params.scale && typeof params.scale === 'object') {
                obj.scale[0] *= (params.scale as any).x ?? 1;
                obj.scale[1] *= (params.scale as any).y ?? 1;
                obj.scale[2] *= (params.scale as any).z ?? 1;
            } else if (Array.isArray(params.factor)) {
                obj.scale[0] *= params.factor[0];
                obj.scale[1] *= params.factor[1];
                obj.scale[2] *= params.factor[2];
            } else if (params.factor && typeof params.factor === 'object') {
                obj.scale[0] *= (params.factor as any).x ?? 1;
                obj.scale[1] *= (params.factor as any).y ?? 1;
                obj.scale[2] *= (params.factor as any).z ?? 1;
            } else if (typeof params.factor === 'number') {
                obj.scale[0] *= params.factor;
                obj.scale[1] *= params.factor;
                obj.scale[2] *= params.factor;
            }

            if (found.threeObject) {
                found.threeObject.scale.set(obj.scale[0], obj.scale[1], obj.scale[2]);
            }

            return { objectId: params.objectId, scale: obj.scale };
        }
    },
    {
        name: 'sb_apply_transforms',
        category: 'transform',
        description: 'Bakes/freezes object position, rotation, and scale transformations directly into vertex geometry.',
        execute: (ctx, params: { objectId: string }) => {
            const found = ctx.findObject(params.objectId);
            if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

            const obj = found.object;
            const pos = obj.position || [0, 0, 0];
            const rot = obj.rotation || [0, 0, 0];
            const scl = obj.scale || [1, 1, 1];

            // Build transformation matrix
            const matrix = new THREE.Matrix4();
            const position = new THREE.Vector3(pos[0], pos[1], pos[2]);
            const euler = new THREE.Euler(rot[0], rot[1], rot[2]);
            const quaternion = new THREE.Quaternion().setFromEuler(euler);
            const scale = new THREE.Vector3(scl[0], scl[1], scl[2]);
            matrix.compose(position, quaternion, scale);

            if (found.threeObject && (found.threeObject as THREE.Mesh).geometry) {
                const geo = (found.threeObject as THREE.Mesh).geometry;
                geo.applyMatrix4(matrix);
                recomputeGeometryNormals(geo);
            }

            // Reset object transform properties to identity
            obj.position = [0, 0, 0];
            obj.rotation = [0, 0, 0];
            obj.scale = [1, 1, 1];

            if (found.threeObject) {
                found.threeObject.position.set(0, 0, 0);
                found.threeObject.rotation.set(0, 0, 0);
                found.threeObject.scale.set(1, 1, 1);
            }

            return { objectId: params.objectId, applied: true, position: obj.position, scale: obj.scale };
        }
    },
    {
        name: 'sb_set_origin',
        category: 'transform',
        description: 'Shifts object local origin/pivot point (center, bottom, top) while keeping world-space visual position unchanged.',
        execute: (ctx, params: { objectId: string; originType?: 'center' | 'bottom' | 'top' | 'geometry_center' | 'custom'; customOrigin?: [number, number, number] }) => {
            const found = ctx.findObject(params.objectId);
            if (!found) throw new Error(`Object with id '${params.objectId}' not found.`);

            const obj = found.object;
            const originType = params.originType || 'center';
            const scale = obj.scale || [1, 1, 1];
            const offset = new THREE.Vector3(0, 0, 0);

            if (originType === 'bottom') {
                offset.set(0, scale[1] / 2, 0);
            } else if (originType === 'top') {
                offset.set(0, -scale[1] / 2, 0);
            } else if (originType === 'custom' && params.customOrigin) {
                offset.set(params.customOrigin[0], params.customOrigin[1], params.customOrigin[2]);
            }

            if (found.threeObject && (found.threeObject as THREE.Mesh).geometry) {
                const geo = (found.threeObject as THREE.Mesh).geometry;
                geo.translate(-offset.x, -offset.y, -offset.z);
                recomputeGeometryNormals(geo);
            }

            (obj as any).originType = originType;

            return { objectId: params.objectId, originType, offset: [offset.x, offset.y, offset.z] };
        }
    },
    {
        name: 'sb_set_tile_anchor',
        category: 'transform',
        description: 'Sets or updates the geodetic anchor coordinates (lat, lng, elevation, landmark) of the 3D scene.',
        execute: (ctx, params: {
            lat: number;
            lng: number;
            elevation?: number;
            landmarkName?: string;
            active?: boolean;
        }) => {
            const scene = ctx.getSceneData();
            scene.geoAnchor = {
                lat: params.lat,
                lng: params.lng,
                elevation: params.elevation ?? 0,
                landmarkName: params.landmarkName,
                active: params.active !== false
            };

            if (scene.environment) {
                scene.environment.latitude = params.lat;
                scene.environment.longitude = params.lng;
            }

            ctx.recordState(`Set Tile Anchor (${params.landmarkName || `${params.lat.toFixed(3)}, ${params.lng.toFixed(3)}`})`);

            return { geoAnchor: scene.geoAnchor };
        }
    },
    {
        name: 'sb_snap_to_terrain',
        category: 'transform',
        description: 'Accurately calculates ground elevation and snaps 3D object(s) onto terrain surface.',
        execute: (ctx, params?: { objectId?: string; offset?: number; spreadM?: number }) => {
            const threeScene = ctx.getThreeScene();
            const terrainManager = new TerrainManager({ scene: threeScene });
            const offset = params?.offset ?? 0;
            const spreadM = params?.spreadM ?? 4;
            const snappedObjects: Array<{ id: string; previousY: number; newY: number; groundElevation: number }> = [];

            const snapTarget = (targetId: string) => {
                const found = ctx.findObject(targetId);
                if (!found) return;

                const obj = found.object;
                const prevY = obj.position ? obj.position[1] : 0;

                let newY: number | null = null;

                if (found.threeObject) {
                    newY = terrainManager.snapObjectToGround(found.threeObject, offset, spreadM);
                } else if (obj.position) {
                    const groundH = terrainManager.sampleGroundHeight(obj.position[0], obj.position[2], spreadM)
                        ?? terrainManager.sampleHeight(obj.position[0], obj.position[2]);
                    if (groundH !== null) {
                        newY = groundH + offset;
                    }
                }

                if (newY !== null) {
                    if (!obj.position) obj.position = [0, 0, 0];
                    obj.position[1] = newY;
                    if (obj.space?.spatial3d) {
                        obj.space.spatial3d.y = newY;
                    }
                    if (found.threeObject) {
                        found.threeObject.position.y = newY;
                        found.threeObject.updateMatrixWorld(true);
                    }
                    snappedObjects.push({
                        id: targetId,
                        previousY: prevY,
                        newY,
                        groundElevation: newY - offset
                    });
                }
            };

            if (params?.objectId && params.objectId !== 'all' && params.objectId !== '*') {
                snapTarget(params.objectId);
            } else {
                const sceneData = ctx.getSceneData();
                if (Array.isArray(sceneData.customMeshes)) {
                    for (const mesh of sceneData.customMeshes) {
                        if (mesh.id) snapTarget(mesh.id);
                    }
                }
                if (Array.isArray(sceneData.objects)) {
                    for (const obj of sceneData.objects) {
                        if (obj.id) snapTarget(obj.id);
                    }
                }
            }

            ctx.recordState(`Snap ${snappedObjects.length} object(s) to terrain`);

            return {
                snappedCount: snappedObjects.length,
                snappedObjects
            };
        }
    }
];
