/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import type { Scene3DData } from '../../canvas-types';

export type OperatorCategory =
    | 'inspect'
    | 'transform'
    | 'mesh_edit'
    | 'modifiers'
    | 'materials_pbr'
    | 'lighting_camera'
    | 'physics_animation'
    | 'particle_simulation'
    | 'scene_assembly'
    | 'nature_atmosphere'
    | 'state_history';

export interface OperatorResult<T = any> {
    success: boolean;
    operator: string;
    data?: T;
    error?: string;
    executionTimeMs?: number;
    timestamp?: number;
}

export interface BatchCommand {
    operator: string;
    params?: any;
}

export interface BatchExecutionOptions {
    atomic?: boolean;
    recordHistory?: boolean;
}

export interface BatchExecutionResult {
    success: boolean;
    results: OperatorResult[];
    totalExecutionTimeMs: number;
    error?: string;
}

export interface IOperatorContext {
    getSceneData(): Scene3DData;
    setSceneData(data: Scene3DData): void;
    getThreeScene(): THREE.Scene | undefined;
    attachThreeScene(scene: THREE.Scene): void;
    getObject(id: string): any;
    getThreeObject(id: string): THREE.Object3D | undefined;
    findObject(id: string): { type: 'customMesh' | 'media4d' | 'threeObject'; object: any; threeObject?: THREE.Object3D } | undefined;
    registerMaterial(material: any): void;
    getMaterial(materialId: string): any;
    recordState(description?: string): void;
    undo(): boolean;
    redo(): boolean;
    resetScene(initialData?: Partial<Scene3DData>): void;
}

export interface OperatorDefinition<TParams = any, TResult = any> {
    name: string;
    category: OperatorCategory;
    description: string;
    parametersSchema?: Record<string, any>;
    execute: (context: IOperatorContext, params: TParams) => TResult | Promise<TResult>;
}

// ============================================================================
// Helper Geometry Calculations
// ============================================================================

export function createGeometryForType(type: string, scale: [number, number, number] = [1, 1, 1], geometryMeta?: any): THREE.BufferGeometry {
    const segments = geometryMeta?.iterations ? Math.pow(2, geometryMeta.iterations) : 1;
    switch (type) {
        case 'box':
            return new THREE.BoxGeometry(scale[0], scale[1], scale[2], segments, segments, segments);
        case 'sphere':
            return new THREE.SphereGeometry(Math.max(scale[0], scale[1], scale[2]) / 2, 24 * segments, 24 * segments);
        case 'cylinder':
            return new THREE.CylinderGeometry(scale[0] / 2, scale[0] / 2, scale[1], 24 * segments);
        case 'plane':
            return new THREE.PlaneGeometry(scale[0], scale[2] || scale[1], segments, segments);
        case 'torus':
            return new THREE.TorusGeometry(scale[0] / 2, scale[1] / 4, 16 * segments, 32 * segments);
        default:
            return new THREE.BoxGeometry(scale[0], scale[1], scale[2], segments, segments, segments);
    }
}

export function computeMeshStatsFromGeometry(geometry: THREE.BufferGeometry, scale: [number, number, number] = [1, 1, 1]) {
    const posAttr = geometry.attributes.position as THREE.BufferAttribute;
    const vertexCount = posAttr ? posAttr.count : 0;
    
    let faceCount = 0;
    if (geometry.index) {
        faceCount = geometry.index.count / 3;
    } else if (posAttr) {
        faceCount = posAttr.count / 3;
    }

    geometry.computeBoundingBox();
    const bb = geometry.boundingBox || new THREE.Box3();
    const min: [number, number, number] = [bb.min.x * scale[0], bb.min.y * scale[1], bb.min.z * scale[2]];
    const max: [number, number, number] = [bb.max.x * scale[0], bb.max.y * scale[1], bb.max.z * scale[2]];
    const size: [number, number, number] = [
        Math.abs(max[0] - min[0]),
        Math.abs(max[1] - min[1]),
        Math.abs(max[2] - min[2])
    ];
    const center: [number, number, number] = [
        (min[0] + max[0]) / 2,
        (min[1] + max[1]) / 2,
        (min[2] + max[2]) / 2
    ];

    // Compute surface area & volume
    let surfaceArea = 0;
    let volume = 0;

    const p1 = new THREE.Vector3();
    const p2 = new THREE.Vector3();
    const p3 = new THREE.Vector3();
    const edge1 = new THREE.Vector3();
    const edge2 = new THREE.Vector3();
    const cross = new THREE.Vector3();

    const getVertex = (idx: number, target: THREE.Vector3) => {
        target.set(
            posAttr.getX(idx) * scale[0],
            posAttr.getY(idx) * scale[1],
            posAttr.getZ(idx) * scale[2]
        );
    };

    if (geometry.index) {
        const idx = geometry.index;
        for (let i = 0; i < idx.count; i += 3) {
            getVertex(idx.getX(i), p1);
            getVertex(idx.getX(i + 1), p2);
            getVertex(idx.getX(i + 2), p3);

            edge1.subVectors(p2, p1);
            edge2.subVectors(p3, p1);
            cross.crossVectors(edge1, edge2);
            surfaceArea += cross.length() * 0.5;

            // Signed volume of tetrahedron from origin
            volume += p1.dot(cross) / 6.0;
        }
    } else if (posAttr) {
        for (let i = 0; i < posAttr.count; i += 3) {
            getVertex(i, p1);
            getVertex(i + 1, p2);
            getVertex(i + 2, p3);

            edge1.subVectors(p2, p1);
            edge2.subVectors(p3, p1);
            cross.crossVectors(edge1, edge2);
            surfaceArea += cross.length() * 0.5;

            volume += p1.dot(cross) / 6.0;
        }
    }

    volume = Math.abs(volume);
    if (volume < 0.00001 && size[0] > 0 && size[1] > 0 && size[2] > 0) {
        volume = size[0] * size[1] * size[2];
    }
    if (surfaceArea < 0.00001 && size[0] > 0 && size[1] > 0) {
        surfaceArea = 2 * (size[0] * size[1] + size[1] * size[2] + size[2] * size[0]);
    }

    const edgeCount = Math.round(faceCount * 1.5);

    return {
        vertexCount,
        faceCount,
        edgeCount,
        boundingBox: { min, max, size, center },
        surfaceArea: Number(surfaceArea.toFixed(4)),
        volume: Number(volume.toFixed(4)),
        isWatertight: true
    };
}
