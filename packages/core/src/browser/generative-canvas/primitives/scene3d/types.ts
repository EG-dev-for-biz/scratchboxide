/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import type { TerrainManager } from '../../services/TerrainManager';

export type Scene3DRenderMode = 'wireframe' | 'solid' | 'shaded' | 'pbr' | 'clay';

/** Long-lived three.js objects created exactly once per mounted viewport. */
export interface RendererStack {
    container: HTMLElement;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    gridHelper: THREE.GridHelper;
    /** Disposes renderer + detaches canvas. Slices must dispose themselves first. */
    dispose: () => void;
}

/** Common shape returned by every per-slice sync helper. */
export interface SliceHandle {
    dispose: () => void;
}

export interface AtmosphereHandle extends SliceHandle {
    isSkySkybox: boolean;
    isSunset: boolean;
    sunPosition: THREE.Vector3;
    skyDomeObject: THREE.Mesh | null;
    skyDomeModule: any | null;
    aerialPerspective: any | null;
    terrainCloudShadows: any | null;
    godRays: any | null;
    terrainBiome: any | null;
    starsMesh: THREE.Points | null;
}

export interface TilesLayerHandle extends SliceHandle {
    tilesLayer: any | null;
    terrainManager: TerrainManager | null;
}

/** Which slice draws the scene's focal content; 'empty' when the scene data declares nothing to draw. */
export type SceneContentKind = 'script' | 'tiles' | 'custom-meshes' | 'objects' | 'empty';

export interface SceneContentHandle extends SliceHandle {
    kind: SceneContentKind;
    splatViewer: any | null;
    scriptHooks: { update?: (time: number, delta: number) => void; dispose?: () => void } | null;
    scriptError: string | null;
}

export interface WasmMeshHandle extends SliceHandle {
    mesh: THREE.Mesh;
    geometry: THREE.BufferGeometry;
    positionAttribute: THREE.BufferAttribute;
}

export interface VectorRoadmapHandle extends SliceHandle {
    blueprintMesh: THREE.Mesh | null;
}

/** Recursively frees geometries and materials under `root` (best-effort). */
export function disposeObject3D(root: THREE.Object3D | null | undefined): void {
    if (!root) return;
    root.traverse(obj => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry && typeof (mesh.geometry as any).dispose === 'function') {
            mesh.geometry.dispose();
        }
        const mat = (mesh as any).material;
        if (Array.isArray(mat)) {
            mat.forEach(m => m?.dispose?.());
        } else if (mat && typeof mat.dispose === 'function') {
            mat.dispose();
        }
    });
}

export function removeAndDispose(scene: THREE.Scene, obj: THREE.Object3D | null | undefined): void {
    if (!obj) return;
    if (obj.parent) obj.parent.remove(obj);
    else scene.remove(obj);
    disposeObject3D(obj);
}
