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
    | 'nature_atmosphere'
    | 'state_history';

export interface OperatorResult<T = any> {
    success: boolean;
    operator: string;
    data?: T;
    error?: string;
    /** Set when the operator could not run here, e.g. 'not_available_here' (it needs the live 3D viewport). */
    errorCode?: OperatorErrorCode;
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

/** Diagnostic code on a failed operator result; the message says what was missing. */
export type OperatorErrorCode = 'not_available_here' | (string & {});

/**
 * Thrown when an operator cannot do its work where it runs, e.g. a geometry edit dispatched on the server, where
 * no Three.js viewport is attached. The dispatch fails with `errorCode: 'not_available_here'`; nothing is recorded
 * as done.
 */
export class OperatorUnavailableError extends Error {
    readonly code: OperatorErrorCode = 'not_available_here';
    constructor(message: string) {
        super(message);
        this.name = 'OperatorUnavailableError';
    }
}

/**
 * The live viewport mesh an operator edits, named by `id`. Throws when the object is not in the scene, and
 * OperatorUnavailableError when it has no Three.js mesh geometry here (no viewport attached, or not a mesh), so a
 * geometry operator never reports work it could not do.
 */
export function requireLiveMesh(ctx: IOperatorContext, id: string | undefined, operator: string): { mesh: THREE.Mesh; record: any } {
    if (!id) throw new Error(`${operator} needs the id or name of the mesh to work on.`);
    const found = ctx.findObject(id);
    if (!found) throw new Error(`${operator}: object '${id}' not found.`);
    const three = found.threeObject as THREE.Mesh | undefined;
    if (!three) {
        throw new OperatorUnavailableError(`${operator} works on the mesh geometry in the live 3D viewport, and no viewport mesh for '${id}' is attached here.`);
    }
    if (!three.isMesh || !three.geometry || !three.geometry.getAttribute('position')) {
        const meshes: string[] = [];
        three.traverse(n => { if ((n as THREE.Mesh).isMesh && n.name) meshes.push(n.name); });
        throw new OperatorUnavailableError(`${operator}: '${id}' is not a single mesh with geometry${meshes.length ? ` (its meshes: ${meshes.slice(0, 10).join(', ')})` : ''}.`);
    }
    return { mesh: three, record: found.object };
}

// ============================================================================
// Mesh statistics
// ============================================================================

/**
 * Undirected edges of the triangle mesh after welding coincident positions (UV and normal seams split vertices
 * without opening the surface). Returns the edge count and how many edges are not shared by exactly two faces.
 */
export function analyzeMeshEdges(geometry: THREE.BufferGeometry, weldEpsilon = 1e-5): { edgeCount: number; boundaryEdges: number; nonManifoldEdges: number } {
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    if (!pos) return { edgeCount: 0, boundaryEdges: 0, nonManifoldEdges: 0 };
    const weld = new Map<string, number>();
    const welded = new Uint32Array(pos.count);
    const q = (v: number) => Math.round(v / weldEpsilon);
    for (let i = 0; i < pos.count; i++) {
        const key = `${q(pos.getX(i))},${q(pos.getY(i))},${q(pos.getZ(i))}`;
        let id = weld.get(key);
        if (id === undefined) { id = weld.size; weld.set(key, id); }
        welded[i] = id;
    }
    const triCount = geometry.index ? geometry.index.count / 3 : pos.count / 3;
    const corner = (t: number, k: number) => welded[geometry.index ? geometry.index.getX(t * 3 + k) : t * 3 + k];
    const edges = new Map<number, number>();
    const n = weld.size;
    for (let t = 0; t < triCount; t++) {
        const a = corner(t, 0), b = corner(t, 1), c = corner(t, 2);
        if (a === b || b === c || a === c) continue; // degenerate after welding
        for (const [u, v] of [[a, b], [b, c], [c, a]]) {
            const key = u < v ? u * n + v : v * n + u;
            edges.set(key, (edges.get(key) ?? 0) + 1);
        }
    }
    let boundaryEdges = 0;
    let nonManifoldEdges = 0;
    for (const count of edges.values()) {
        if (count === 1) boundaryEdges++;
        else if (count > 2) nonManifoldEdges++;
    }
    return { edgeCount: edges.size, boundaryEdges, nonManifoldEdges };
}

/**
 * Measured statistics of a triangle mesh: counts, bounding box, surface area, and (for a closed surface) the
 * enclosed volume. `scale` is applied to positions before measuring. `isWatertight` is true only when every
 * welded edge is shared by exactly two faces; `volume` is null otherwise, since an open surface encloses none.
 */
export function computeMeshStatsFromGeometry(geometry: THREE.BufferGeometry, scale: [number, number, number] = [1, 1, 1]) {
    const posAttr = geometry.attributes.position as THREE.BufferAttribute;
    const vertexCount = posAttr ? posAttr.count : 0;
    const faceCount = geometry.index ? geometry.index.count / 3 : vertexCount / 3;

    geometry.computeBoundingBox();
    const bb = geometry.boundingBox || new THREE.Box3();
    const min: [number, number, number] = [bb.min.x * scale[0], bb.min.y * scale[1], bb.min.z * scale[2]];
    const max: [number, number, number] = [bb.max.x * scale[0], bb.max.y * scale[1], bb.max.z * scale[2]];
    const size: [number, number, number] = [Math.abs(max[0] - min[0]), Math.abs(max[1] - min[1]), Math.abs(max[2] - min[2])];
    const center: [number, number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];

    let surfaceArea = 0;
    let signedVolume = 0;
    const p1 = new THREE.Vector3();
    const p2 = new THREE.Vector3();
    const p3 = new THREE.Vector3();
    const edge1 = new THREE.Vector3();
    const edge2 = new THREE.Vector3();
    const cross = new THREE.Vector3();
    const getVertex = (idx: number, target: THREE.Vector3) => {
        target.set(posAttr.getX(idx) * scale[0], posAttr.getY(idx) * scale[1], posAttr.getZ(idx) * scale[2]);
    };
    for (let t = 0; t < faceCount; t++) {
        const i0 = geometry.index ? geometry.index.getX(t * 3) : t * 3;
        const i1 = geometry.index ? geometry.index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = geometry.index ? geometry.index.getX(t * 3 + 2) : t * 3 + 2;
        getVertex(i0, p1);
        getVertex(i1, p2);
        getVertex(i2, p3);
        edge1.subVectors(p2, p1);
        edge2.subVectors(p3, p1);
        cross.crossVectors(edge1, edge2);
        surfaceArea += cross.length() * 0.5;
        signedVolume += p1.dot(cross) / 6.0;
    }

    const edgesInfo = analyzeMeshEdges(geometry);
    const isWatertight = faceCount > 0 && edgesInfo.boundaryEdges === 0 && edgesInfo.nonManifoldEdges === 0;

    return {
        vertexCount,
        faceCount,
        edgeCount: edgesInfo.edgeCount,
        boundaryEdgeCount: edgesInfo.boundaryEdges,
        nonManifoldEdgeCount: edgesInfo.nonManifoldEdges,
        boundingBox: { min, max, size, center },
        surfaceArea: Number(surfaceArea.toFixed(4)),
        volume: isWatertight ? Number(Math.abs(signedVolume).toFixed(4)) : null,
        isWatertight
    };
}
