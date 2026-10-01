/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import type {
    SculptBrushType,
    SculptFalloffType,
    SculptSymmetry
} from '../canvas-types';

export type { SculptBrushType, SculptFalloffType, SculptSymmetry };

export interface SculptBrushOptions {
    brush: SculptBrushType;
    falloff: SculptFalloffType;
    radius: number;
    strength: number;
    symmetry: SculptSymmetry;
    mouseDelta?: THREE.Vector3;
    clayOffset?: number;
    accumulate?: boolean;
    wireframeOverlay?: boolean;
}

export interface InfluencedVertex {
    index: number;
    distance: number;
    originalPos: THREE.Vector3;
    normal: THREE.Vector3;
}

/**
 * Evaluates Blender-grade falloff curves for sculpting brushes.
 * Returns a scalar weight in [0, 1] given distance from stroke center.
 */
export function evaluateFalloff(
    distance: number,
    radius: number,
    falloffType: SculptFalloffType = 'gaussian'
): number {
    if (radius <= 0.00001) return 0;
    if (distance > radius) return 0;

    const d = Math.max(0, Math.min(1, distance / radius));

    switch (falloffType) {
        case 'gaussian': {
            // Normalized Gaussian: f(0)=1, f(1)=0
            // (e^(-4 * d^2) - e^(-4)) / (1 - e^(-4))
            const e4 = 0.01831563888; // exp(-4)
            const val = Math.exp(-4 * d * d);
            return Math.max(0, Math.min(1, (val - e4) / (1 - e4)));
        }

        case 'smoothstep': {
            // Hermite smoothstep curve: 2d^3 - 3d^2 + 1
            return 2 * d * d * d - 3 * d * d + 1;
        }

        case 'spherical': {
            // Spherical falloff curve: sqrt(1 - d^2)
            return Math.sqrt(Math.max(0, 1 - d * d));
        }

        case 'linear': {
            // Linear ramp from 1 to 0
            return 1 - d;
        }

        case 'constant': {
            // Constant weight across entire brush radius
            return 1.0;
        }

        case 'sharp': {
            // Sharp localized peak: (1 - d^2)^2
            const oneMinusDSq = 1 - d * d;
            return oneMinusDSq * oneMinusDSq;
        }

        default:
            return 1 - d;
    }
}

/**
 * Finds all vertex indices within radius from world/local hit point.
 */
export function findVerticesInRadius(
    geometry: THREE.BufferGeometry,
    center: THREE.Vector3,
    radius: number
): InfluencedVertex[] {
    const posAttr = geometry.attributes.position as THREE.BufferAttribute;
    const normAttr = geometry.attributes.normal as THREE.BufferAttribute | undefined;
    if (!posAttr) return [];

    const count = posAttr.count;
    const influenced: InfluencedVertex[] = [];
    const tempPos = new THREE.Vector3();
    const tempNorm = new THREE.Vector3();

    for (let i = 0; i < count; i++) {
        tempPos.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
        const dist = tempPos.distanceTo(center);

        if (dist <= radius) {
            if (normAttr) {
                tempNorm.set(normAttr.getX(i), normAttr.getY(i), normAttr.getZ(i));
            } else {
                tempNorm.set(0, 1, 0);
            }

            influenced.push({
                index: i,
                distance: dist,
                originalPos: tempPos.clone(),
                normal: tempNorm.clone()
            });
        }
    }

    return influenced;
}

/**
 * Recomputes normals and bounds for a modified Three.js BufferGeometry.
 */
export function recomputeGeometryNormals(geometry: THREE.BufferGeometry): void {
    if (geometry.attributes.position) {
        geometry.attributes.position.needsUpdate = true;
    }
    geometry.computeVertexNormals();
    if (geometry.attributes.normal) {
        geometry.attributes.normal.needsUpdate = true;
    }
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
}

/**
 * Executes Laplacian smoothing on influenced vertices.
 */
export function computeLaplacianSmoothing(
    geometry: THREE.BufferGeometry,
    influenced: InfluencedVertex[],
    strength: number,
    falloff: SculptFalloffType,
    radius: number
): void {
    const posAttr = geometry.attributes.position as THREE.BufferAttribute;
    if (!posAttr || influenced.length === 0) return;

    const count = posAttr.count;
    const indexAttr = geometry.index;
    
    // Build adjacency list for influenced vertices
    const adjMap = new Map<number, number[]>();
    influenced.forEach(v => adjMap.set(v.index, []));

    if (indexAttr) {
        const idxArray = indexAttr.array;
        for (let i = 0; i < idxArray.length; i += 3) {
            const a = idxArray[i];
            const b = idxArray[i + 1];
            const c = idxArray[i + 2];

            if (adjMap.has(a)) {
                adjMap.get(a)!.push(b, c);
            }
            if (adjMap.has(b)) {
                adjMap.get(b)!.push(a, c);
            }
            if (adjMap.has(c)) {
                adjMap.get(c)!.push(a, b);
            }
        }
    } else {
        // Fallback for unindexed or grid-like meshes: spatial neighbors within local micro-radius
        const localDistThreshold = (radius / Math.sqrt(influenced.length)) * 2.5;
        for (let i = 0; i < influenced.length; i++) {
            const a = influenced[i];
            const neighbors: number[] = [];
            for (let j = 0; j < influenced.length; j++) {
                if (i !== j) {
                    const b = influenced[j];
                    if (a.originalPos.distanceTo(b.originalPos) <= localDistThreshold) {
                        neighbors.push(b.index);
                    }
                }
            }
            adjMap.set(a.index, neighbors);
        }
    }

    // Compute new positions
    const newPositions = new Map<number, THREE.Vector3>();
    const tempP = new THREE.Vector3();
    const neighborP = new THREE.Vector3();

    for (const v of influenced) {
        const idx = v.index;
        const neighbors = adjMap.get(idx) || [];
        tempP.set(posAttr.getX(idx), posAttr.getY(idx), posAttr.getZ(idx));

        if (neighbors.length === 0) {
            continue;
        }

        const centroid = new THREE.Vector3(0, 0, 0);
        let validNeighbors = 0;

        for (const nIdx of neighbors) {
            if (nIdx >= 0 && nIdx < count) {
                neighborP.set(posAttr.getX(nIdx), posAttr.getY(nIdx), posAttr.getZ(nIdx));
                centroid.add(neighborP);
                validNeighbors++;
            }
        }

        if (validNeighbors > 0) {
            centroid.divideScalar(validNeighbors);
            const weight = evaluateFalloff(v.distance, radius, falloff) * strength;
            const smoothed = tempP.clone().lerp(centroid, Math.min(1.0, weight));
            newPositions.set(idx, smoothed);
        }
    }

    // Write back
    newPositions.forEach((pos, idx) => {
        posAttr.setXYZ(idx, pos.x, pos.y, pos.z);
    });
}

/**
 * Generates symmetric mirrored origins based on symmetry settings.
 */
export function getSymmetricHitPoints(
    hitPoint: THREE.Vector3,
    hitNormal: THREE.Vector3,
    symmetry: SculptSymmetry = {}
): Array<{ point: THREE.Vector3; normal: THREE.Vector3 }> {
    const list: Array<{ point: THREE.Vector3; normal: THREE.Vector3 }> = [
        { point: hitPoint.clone(), normal: hitNormal.clone() }
    ];

    const useX = !!symmetry.x;
    const useY = !!symmetry.y;
    const useZ = !!symmetry.z;

    if (!useX && !useY && !useZ) {
        return list;
    }

    const xFactors = useX ? [1, -1] : [1];
    const yFactors = useY ? [1, -1] : [1];
    const zFactors = useZ ? [1, -1] : [1];

    list.length = 0; // reset to generate full symmetry combinations

    for (const fx of xFactors) {
        for (const fy of yFactors) {
            for (const fz of zFactors) {
                const pt = new THREE.Vector3(hitPoint.x * fx, hitPoint.y * fy, hitPoint.z * fz);
                const nm = new THREE.Vector3(hitNormal.x * fx, hitNormal.y * fy, hitNormal.z * fz);
                list.push({ point: pt, normal: nm });
            }
        }
    }

    return list;
}

/**
 * Core Sculpting Algorithm: Applies a sculpting brush stroke to a Three.js BufferGeometry.
 */
export function applySculptStroke(
    geometry: THREE.BufferGeometry,
    hitPoint: THREE.Vector3,
    hitNormal: THREE.Vector3,
    options: SculptBrushOptions
): void {
    const posAttr = geometry.attributes.position as THREE.BufferAttribute;
    if (!posAttr) return;

    const {
        brush = 'draw',
        falloff = 'gaussian',
        radius = 2.0,
        strength = 0.5,
        symmetry = {},
        mouseDelta = new THREE.Vector3(0, 0, 0),
        clayOffset = 0.5
    } = options;

    const strokePoints = getSymmetricHitPoints(hitPoint, hitNormal, symmetry);

    for (const stroke of strokePoints) {
        const pt = stroke.point;
        const nm = stroke.normal;
        const influenced = findVerticesInRadius(geometry, pt, radius);
        if (influenced.length === 0) continue;

        if (brush === 'smooth') {
            computeLaplacianSmoothing(geometry, influenced, strength, falloff, radius);
            continue;
        }

        const vPos = new THREE.Vector3();

        for (const v of influenced) {
            const idx = v.index;
            vPos.set(posAttr.getX(idx), posAttr.getY(idx), posAttr.getZ(idx));
            const weight = evaluateFalloff(v.distance, radius, falloff);
            if (weight <= 0) continue;

            const effectiveStrength = strength * weight;

            switch (brush) {
                case 'draw': {
                    // Displace along local normal or stroke normal
                    const normalToUse = v.normal.lengthSq() > 0.01 ? v.normal : nm;
                    const displacement = normalToUse.clone().multiplyScalar(effectiveStrength);
                    vPos.add(displacement);
                    break;
                }

                case 'grab': {
                    // Translate towards 3D mouse delta
                    const displacement = mouseDelta.clone().multiplyScalar(effectiveStrength);
                    vPos.add(displacement);
                    break;
                }

                case 'clay': {
                    // Layer surface with depth capping
                    const maxCap = clayOffset;
                    const targetPlanePoint = pt.clone().add(nm.clone().multiplyScalar(maxCap));
                    const toTarget = targetPlanePoint.clone().sub(vPos);
                    const distAlongNormal = toTarget.dot(nm);
                    const clampedDist = Math.max(-maxCap, Math.min(maxCap, distAlongNormal));
                    const displacement = nm.clone().multiplyScalar(clampedDist * effectiveStrength * 0.8);
                    vPos.add(displacement);
                    break;
                }

                case 'inflate': {
                    // Displace outward (inflate) or inward (deflate)
                    const normalToUse = v.normal.lengthSq() > 0.01 ? v.normal : nm;
                    const displacement = normalToUse.clone().multiplyScalar(effectiveStrength * (radius * 0.25));
                    vPos.add(displacement);
                    break;
                }

                case 'pinch': {
                    // Pull vertices radially towards brush center (or push away if negative)
                    const toCenter = pt.clone().sub(vPos);
                    const dist = toCenter.length();
                    if (dist > 0.0001) {
                        const dir = toCenter.normalize();
                        const pinchAmount = Math.min(dist * 0.5, effectiveStrength * (radius * 0.25));
                        vPos.add(dir.multiplyScalar(pinchAmount));
                    }
                    break;
                }

                case 'flatten': {
                    // Project vertex onto tangent hit plane defined by pt and nm
                    const diff = vPos.clone().sub(pt);
                    const heightAbovePlane = diff.dot(nm);
                    const flattenDisplacement = nm.clone().multiplyScalar(-heightAbovePlane * effectiveStrength);
                    vPos.add(flattenDisplacement);
                    break;
                }
            }

            posAttr.setXYZ(idx, vPos.x, vPos.y, vPos.z);
        }
    }

    recomputeGeometryNormals(geometry);
}

/**
 * Undo/Redo History Stack for mesh vertex positions.
 */
export class MeshHistoryStack {
    private undoStack: Float32Array[] = [];
    private redoStack: Float32Array[] = [];
    private maxHistory: number;

    constructor(maxHistory: number = 30) {
        this.maxHistory = Math.max(2, maxHistory);
    }

    pushState(geometry: THREE.BufferGeometry): void {
        const posAttr = geometry.attributes.position as THREE.BufferAttribute;
        if (!posAttr) return;

        const snapshot = new Float32Array(posAttr.array);
        this.undoStack.push(snapshot);

        if (this.undoStack.length > this.maxHistory) {
            this.undoStack.shift();
        }

        // Clear redo stack on new action
        this.redoStack = [];
    }

    undo(geometry: THREE.BufferGeometry): boolean {
        if (this.undoStack.length <= 1) {
            return false;
        }

        const currentState = this.undoStack.pop()!;
        this.redoStack.push(currentState);

        const previousState = this.undoStack[this.undoStack.length - 1];
        this.restoreState(geometry, previousState);
        return true;
    }

    redo(geometry: THREE.BufferGeometry): boolean {
        if (this.redoStack.length === 0) {
            return false;
        }

        const nextState = this.redoStack.pop()!;
        this.undoStack.push(nextState);

        this.restoreState(geometry, nextState);
        return true;
    }

    canUndo(): boolean {
        return this.undoStack.length > 1;
    }

    canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    clear(): void {
        this.undoStack = [];
        this.redoStack = [];
    }

    private restoreState(geometry: THREE.BufferGeometry, state: Float32Array): void {
        const posAttr = geometry.attributes.position as THREE.BufferAttribute;
        if (!posAttr || posAttr.array.length !== state.length) return;

        (posAttr.array as Float32Array).set(state);
        recomputeGeometryNormals(geometry);
    }
}

/**
 * Factory for creating high-density, cleanly indexed sculptable 3D meshes.
 */
export function createSculptableGeometry(
    type: 'sphere' | 'plane' | 'box' | 'cylinder' | 'torus' = 'sphere',
    options: any = {}
): THREE.BufferGeometry {
    let geo: THREE.BufferGeometry;

    switch (type) {
        case 'plane': {
            const width = options.width || 12;
            const height = options.height || 12;
            const segments = options.segments || 64;
            geo = new THREE.PlaneGeometry(width, height, segments, segments);
            geo.rotateX(-Math.PI / 2); // Lay flat on XZ ground
            break;
        }

        case 'sphere': {
            const radius = options.radius || 4;
            const segments = options.segments || 64;
            geo = new THREE.SphereGeometry(radius, segments, segments);
            break;
        }

        case 'box': {
            const size = options.size || 6;
            const segments = options.segments || 32;
            geo = new THREE.BoxGeometry(size, size, size, segments, segments, segments);
            break;
        }

        case 'cylinder': {
            const radiusTop = options.radiusTop || 3;
            const radiusBottom = options.radiusBottom || 3;
            const height = options.height || 8;
            const segments = options.segments || 48;
            geo = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments, segments);
            break;
        }

        case 'torus': {
            const radius = options.radius || 4;
            const tube = options.tube || 1.5;
            const radialSegments = options.radialSegments || 32;
            const tubularSegments = options.tubularSegments || 64;
            geo = new THREE.TorusGeometry(radius, tube, radialSegments, tubularSegments);
            break;
        }

        default:
            geo = new THREE.SphereGeometry(4, 64, 64);
    }

    recomputeGeometryNormals(geo);
    return geo;
}
