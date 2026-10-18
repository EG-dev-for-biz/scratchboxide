/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import { type OperatorDefinition, OperatorUnavailableError, requireLiveMesh } from './types';
import { TerrainManager } from '../TerrainManager';

/** One ground sampler per viewport scene, reused across snaps instead of being rebuilt per call. */
const terrainManagers = new WeakMap<THREE.Scene, TerrainManager>();

export const TRANSFORM_OPERATORS: OperatorDefinition[] = [
    {
        name: 'sb_set_transform',
        category: 'transform',
        description: 'Directly sets absolute position, rotation (Euler), and scale for a target object.',
        execute: (ctx, params: { objectId: string; position?: [number, number, number]; rotation?: [number, number, number]; scale?: [number, number, number] }) => {
            // An unknown id fails: setting a transform never creates an object to put it on.
            const found = ctx.findObject(params.objectId);
            if (!found) throw new Error(`sb_set_transform: object '${params.objectId}' not found.`);

            const obj = found.object;
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
        name: 'sb_set_origin',
        category: 'transform',
        description: 'Moves the pivot of the live viewport mesh to its bounding-box center, bottom or top center, or a custom point in its local coordinates, shifting the geometry and the object position together so the mesh stays where it is in the world. Needs the live 3D viewport.',
        execute: (ctx, params: { objectId: string; originType?: 'center' | 'bottom' | 'top' | 'custom' | (string & {}); customOrigin?: [number, number, number] }) => {
            const { mesh, record } = requireLiveMesh(ctx, params.objectId, 'sb_set_origin');
            const originType = params.originType || 'center';
            const geo = mesh.geometry;
            geo.computeBoundingBox();
            const bb = geo.boundingBox!;
            const pivot = bb.getCenter(new THREE.Vector3());
            if (originType === 'bottom') pivot.y = bb.min.y;
            else if (originType === 'top') pivot.y = bb.max.y;
            else if (originType === 'custom') {
                if (!Array.isArray(params.customOrigin)) throw new Error("sb_set_origin: originType 'custom' needs customOrigin [x, y, z] in the mesh's local coordinates.");
                pivot.set(params.customOrigin[0], params.customOrigin[1], params.customOrigin[2]);
            } else if (originType !== 'center') {
                throw new Error(`sb_set_origin: originType must be center, bottom, top or custom (got '${originType}').`);
            }
            // The geometry moves by -pivot in local space; the object moves by the same vector in its parent's space.
            geo.translate(-pivot.x, -pivot.y, -pivot.z);
            const shift = pivot.clone().multiply(mesh.scale).applyQuaternion(mesh.quaternion);
            mesh.position.add(shift);
            mesh.updateMatrixWorld(true);
            record.position = [mesh.position.x, mesh.position.y, mesh.position.z];
            if (record.space?.spatial3d) {
                record.space.spatial3d.x = mesh.position.x;
                record.space.spatial3d.y = mesh.position.y;
                record.space.spatial3d.z = mesh.position.z;
            }
            return { objectId: params.objectId, originType, localPivot: pivot.toArray(), position: record.position };
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


            return { geoAnchor: scene.geoAnchor };
        }
    },
    {
        name: 'sb_snap_to_terrain',
        category: 'transform',
        description: 'Accurately calculates ground elevation and snaps 3D object(s) onto terrain surface.',
        execute: (ctx, params?: { objectId?: string; offset?: number; spreadM?: number }) => {
            const threeScene = ctx.getThreeScene();
            if (!threeScene) throw new OperatorUnavailableError('sb_snap_to_terrain raycasts the ground in the live 3D viewport, and no viewport is attached here.');
            let terrainManager = terrainManagers.get(threeScene);
            if (!terrainManager) {
                terrainManager = new TerrainManager({ scene: threeScene });
                terrainManagers.set(threeScene, terrainManager);
            }
            const offset = params?.offset ?? 0;
            const spreadM = params?.spreadM ?? 4;
            const snappedObjects: Array<{ id: string; previousY: number; newY: number }> = [];

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
                        newY
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


            return {
                snappedCount: snappedObjects.length,
                snappedObjects
            };
        }
    }
];
