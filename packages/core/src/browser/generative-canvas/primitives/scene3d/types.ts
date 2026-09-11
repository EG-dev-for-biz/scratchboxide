/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from 'three';
import type { TerrainManager } from '../../services/TerrainManager';

export type Scene3DRenderMode = 'wireframe' | 'solid' | 'shaded' | 'pbr';

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

export interface SceneContentHandle extends SliceHandle {
    proceduralSceneGroup: THREE.Group | null;
    airplane: THREE.Group | null;
    contrails: any | null;
    sculptTarget: THREE.Mesh | null;
    splatViewer: any | null;
    scriptHooks: { update?: (time: number, delta: number) => void; dispose?: () => void } | null;
    scriptError: string | null;
}

export interface WasmMeshHandle extends SliceHandle {
    mesh: THREE.Mesh;
    geometry: THREE.BufferGeometry;
    positionAttribute: THREE.BufferAttribute;
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
