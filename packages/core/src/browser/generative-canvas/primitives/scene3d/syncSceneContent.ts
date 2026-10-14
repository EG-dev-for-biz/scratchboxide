/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import type { BakedGaussian } from '../../../../common/geospatial-4d-protocol';
import type { Scene3DData } from '../../canvas-types';
import { createSculptableGeometry } from '../../services/mesh-sculpting-engine';
import { createArticulatedAircraft } from '../../services/mesh/aircraft';
import type { TerrainManager } from '../../services/TerrainManager';
import type { RendererStack, Scene3DRenderMode, SceneContentHandle, WasmMeshHandle } from './types';
import { removeAndDispose } from './types';
import { isGroundSnapTarget } from './syncTilesLayer';
import { createHistoricalBattlefieldScene } from '../../procedural-3d-synthesizer';

const BATTLEFIELD_KEYWORDS = /battlefield|redcoat|minutemen|historic|revolutionary/i;

export type SculptableShape = 'sphere' | 'plane' | 'box' | 'cylinder' | 'torus';

export interface SceneContentInput {
    sceneType?: string;
    title?: string;
    worldBranch: string;
    isAirplane: boolean;
    hasContrails: boolean;
    hasActiveScript: boolean;
    has3DTiles: boolean;
    hasCustomMeshes: boolean;
    /**
     * The scene loads content of its own: objects other than the `internal:mesh` fallback placeholder, or a splat
     * (splatUrl / splatTilesetUrl, which the viewport loads as an object). See hasNonFallbackObjectContent.
     */
    hasNonFallbackObjects: boolean;
    hasCppGenerator?: boolean;
    hasPythonGenerator?: boolean;
    selectedShape: SculptableShape;
    sculptWireframe: boolean;
}

/** Everything the primitive supplies so this module never imports from the primitive. */
export interface SceneContentFactories {
    createDynamicContrails: (scene: THREE.Scene, maxPoints?: number) => any;
    createSplatViewer: () => { group: THREE.Object3D; loadSplatObservation: (g: BakedGaussian[]) => void; dispose: () => void };
    /** Runs the user's dynamic three.js script against the freshly built content. */
    executeScript?: (env: { aircraft: THREE.Group | null; proceduralGroup: THREE.Group | null; contrails: any | null }) => {
        update?: (time: number, delta: number) => void;
        dispose?: () => void;
        error?: string | null;
    } | null;
}

/** True when the scene loads content of its own, so no fallback content (sculpt mesh, aircraft) is drawn for it. */
export function hasNonFallbackObjectContent(scene: Pick<Scene3DData, 'objects' | 'splatUrl' | 'splatTilesetUrl'>): boolean {
    if (scene.splatUrl || scene.splatTilesetUrl) return true;
    return Array.isArray(scene.objects) && scene.objects.length > 0 && !scene.objects.some(o => o.content?.durableUri === 'internal:mesh');
}

export function classifySceneContent(input: SceneContentInput): 'script' | 'tiles' | 'aircraft' | 'custom-meshes' | 'objects' | 'spatial' {
    // 1. Structured Types First (Always honor explicit typed geometry and engines)
    const hasActiveScript = input.hasActiveScript ?? !!(input as any).customScript;
    const has3DTiles = input.has3DTiles ?? !!(input as any).geoAnchor?.active;
    const hasCppGenerator = input.hasCppGenerator ?? !!(input as any).cppGenerator;
    const hasPythonGenerator = input.hasPythonGenerator ?? !!(input as any).pythonGenerator;
    const hasCustomMeshes = input.hasCustomMeshes ?? ((input as any).customMeshes && (input as any).customMeshes.length > 0);
    const hasNonFallbackObjects = input.hasNonFallbackObjects ?? ((input as any).objects && (input as any).objects.length > 0);

    if (hasActiveScript) return 'script';
    if (has3DTiles) return 'tiles';
    if (hasCppGenerator || hasPythonGenerator) return 'objects';
    if (hasCustomMeshes) return 'custom-meshes';
    if (hasNonFallbackObjects) return 'objects';
    if (input.isAirplane) return 'aircraft';

    // 2. Adaptive Domain Architecture Default (Zero closed taxonomies / zero keyword regexes)
    return 'spatial';
}

/**
 * Builds the focal content of the scene: procedural theme group, articulated aircraft +
 * contrails, splat viewer, sculptable mesh, terrain grounding and the dynamic script hooks.
 * Runs whenever the content fingerprint changes; never touches the renderer stack.
 */
export function syncSceneContent(
    stack: RendererStack,
    input: SceneContentInput,
    terrainManager: TerrainManager | null,
    factories: SceneContentFactories
): SceneContentHandle {
    const { scene } = stack;
    const worldBranch = (input.worldBranch || '').toLowerCase();
    const sceneTitle = (input.title || '').toLowerCase();
    const haystack = `${worldBranch} ${sceneTitle}`;

    let proceduralSceneGroup: THREE.Group | null = null;
    let airplane: THREE.Group | null = null;
    let contrails: any | null = null;
    let sculptTarget: THREE.Mesh | null = null;
    let ownedSculptMesh: THREE.Mesh | null = null;

    const kind = classifySceneContent(input);
    switch (kind) {
        case 'script':
            // The dynamic script synthesises and animates the scene itself.
            break;
        case 'tiles':
            // Real-world tiles are the foundation; only add grounded thematic figures.
            if (input.sceneType === 'battlefield' || BATTLEFIELD_KEYWORDS.test(haystack)) {
                proceduralSceneGroup = createHistoricalBattlefieldScene(scene, THREE, {
                    ground: false,
                    tavern: false,
                    meetinghouse: false,
                    stoneWalls: false,
                    trees: false,
                    minutemenCount: 16,
                    redcoatCount: 20,
                    smokeParticles: true
                });
            }
            break;
        case 'aircraft': {
            const articulated = createArticulatedAircraft();
            airplane = articulated.group;
            airplane.position.set(0, 3.5, 0);
            scene.add(airplane);
            if (input.hasContrails) {
                contrails = factories.createDynamicContrails(scene, 350);
            }
            break;
        }
        case 'custom-meshes':
        case 'objects':
            // Custom meshes / objects are synchronised by their own slices.
            break;
        case 'spatial':
        default:
            // Neutral studio baseline. Zero client-side Three.js primitives.
            // Procedural geometry is authored in C++20 / Python SDK and streamed as GLB.
            proceduralSceneGroup = null;
            break;
    }

    // Ground procedural figures onto the terrain (tiles or procedural).
    if (proceduralSceneGroup && terrainManager) {
        proceduralSceneGroup.updateMatrixWorld(true);
        const groundTargets: THREE.Object3D[] = [];
        proceduralSceneGroup.traverse(child => {
            if (isGroundSnapTarget(child)) groundTargets.push(child);
        });
        if (groundTargets.length > 0) {
            for (const target of groundTargets) terrainManager.snapObjectToGround(target, 0);
        } else if (input.has3DTiles) {
            terrainManager.snapObjectToGround(proceduralSceneGroup, 0);
        }
    }

    // Splat viewer. A splat scene's file (splatUrl) is loaded as a scene object; a splat world with no file
    // and no objects shows nothing rather than a made-up colonnade and dome of splats.
    const splatViewer = factories.createSplatViewer();
    scene.add(splatViewer.group);

    // Sculptable focal mesh (only for unconfigured blank general scenes with no procedural content)
    const hasGenerators = input.hasCppGenerator || input.hasPythonGenerator;
    if (!hasGenerators && !input.isAirplane && !input.has3DTiles && !input.hasCustomMeshes && !input.hasActiveScript && !input.hasNonFallbackObjects && input.sceneType !== 'glass_shatter' && (!proceduralSceneGroup && (input.sceneType === 'general' || !input.sceneType))) {
        const sGeo = createSculptableGeometry(input.selectedShape, { radius: 3.5, width: 12, height: 12, segments: 64 });
        const sMat = new THREE.MeshStandardMaterial({
            color: 0x60a5fa,
            roughness: 0.35,
            metalness: 0.2,
            side: THREE.DoubleSide,
            wireframe: input.sculptWireframe
        });
        ownedSculptMesh = new THREE.Mesh(sGeo, sMat);
        ownedSculptMesh.position.set(0, 0, 0);
        ownedSculptMesh.name = 'sb-sculptable-mesh';
        scene.add(ownedSculptMesh);
        sculptTarget = ownedSculptMesh;
    } else if (proceduralSceneGroup) {
        const candidate = proceduralSceneGroup.getObjectByProperty('type', 'Mesh') as THREE.Mesh | undefined;
        if (candidate && candidate.geometry) sculptTarget = candidate;
    }

    // Dynamic script execution (after content exists so the script can reference it)
    let scriptHooks: SceneContentHandle['scriptHooks'] = null;
    let scriptError: string | null = null;
    if (input.hasActiveScript && factories.executeScript) {
        const result = factories.executeScript({ aircraft: airplane, proceduralGroup: proceduralSceneGroup, contrails });
        if (result) {
            if (result.error) {
                scriptError = result.error;
            } else {
                scriptHooks = { update: result.update, dispose: result.dispose };
            }
        }
    }

    return {
        proceduralSceneGroup,
        airplane,
        contrails,
        sculptTarget,
        splatViewer,
        scriptHooks,
        scriptError,
        dispose: () => {
            scriptHooks?.dispose?.();
            contrails?.dispose?.();
            splatViewer.dispose();
            if (splatViewer.group.parent) splatViewer.group.parent.remove(splatViewer.group);
            if (airplane) removeAndDispose(scene, airplane);
            if (proceduralSceneGroup) removeAndDispose(scene, proceduralSceneGroup);
            if (ownedSculptMesh) removeAndDispose(scene, ownedSculptMesh);
        }
    };
}

/** Physics wave deformer mesh; its own slice so WASM toggles do not rebuild the scene. */
export function syncWasmMesh(stack: RendererStack, renderMode: Scene3DRenderMode): WasmMeshHandle {
    const { scene } = stack;
    const wasmGeo = new THREE.BufferGeometry();
    const wasmVertices = new Float32Array(3000 * 3);
    for (let i = 0; i < 3000; i++) {
        const idx = i * 3;
        wasmVertices[idx] = ((i % 50) - 25) * 0.4;
        wasmVertices[idx + 1] = -1.2;
        wasmVertices[idx + 2] = (Math.floor(i / 50) - 30) * 0.4;
    }
    const wasmPosAttr = new THREE.BufferAttribute(wasmVertices, 3);
    wasmGeo.setAttribute('position', wasmPosAttr);
    wasmGeo.computeVertexNormals();

    let wasmMeshMat: THREE.Material;
    if (renderMode === 'wireframe') {
        wasmMeshMat = new THREE.MeshBasicMaterial({ color: 0x00ffcc, wireframe: true });
    } else if (renderMode === 'solid') {
        wasmMeshMat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
    } else if (renderMode === 'shaded') {
        wasmMeshMat = new THREE.MeshLambertMaterial({ color: 0x0a4a66, side: THREE.DoubleSide });
    } else {
        wasmMeshMat = new THREE.MeshStandardMaterial({
            color: 0x0b253a,
            roughness: 0.4,
            metalness: 0.9,
            emissive: 0x00f3ff,
            emissiveIntensity: 0.1,
            side: THREE.DoubleSide
        });
    }
    const mesh = new THREE.Mesh(wasmGeo, wasmMeshMat);
    mesh.name = 'sb-wasm-wave-mesh';
    scene.add(mesh);

    return {
        mesh,
        geometry: wasmGeo,
        positionAttribute: wasmPosAttr,
        dispose: () => removeAndDispose(scene, mesh)
    };
}
