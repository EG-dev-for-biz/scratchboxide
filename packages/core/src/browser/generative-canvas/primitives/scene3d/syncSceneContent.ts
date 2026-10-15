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
import type { Media4DObject, Scene3DData } from '../../canvas-types';
import type { RendererStack, Scene3DRenderMode, SceneContentHandle, SceneContentKind, WasmMeshHandle } from './types';
import { removeAndDispose } from './types';

/**
 * Which content sources the scene data declares. The viewport draws only these; it never adds geometry of its own
 * (no placeholder sculpt mesh, no aircraft or figures picked from the title).
 */
export interface SceneContentInput {
    hasActiveScript: boolean;
    has3DTiles: boolean;
    hasCustomMeshes: boolean;
    /**
     * The scene loads content of its own: objects the viewport's loader draws (a .glb / .gltf model or a splat), or
     * a splat file (splatUrl, which the viewport loads as an object). See hasNonFallbackObjectContent.
     */
    hasNonFallbackObjects: boolean;
    hasCppGenerator?: boolean;
    hasPythonGenerator?: boolean;
}

/** Everything the primitive supplies so this module never imports from the primitive. */
export interface SceneContentFactories {
    createSplatViewer: () => { group: THREE.Object3D; loadSplatObservation: (g: BakedGaussian[]) => void; dispose: () => void };
    /** Runs the user's dynamic three.js script. */
    executeScript?: () => {
        update?: (time: number, delta: number) => void;
        dispose?: () => void;
        error?: string | null;
    } | null;
}

/** glTF models the viewport's object loader draws (objects[].content.durableUri), with any query or fragment. */
const GLTF_MODEL_URI = /\.(glb|gltf)($|[?#])/i;
/** Gaussian splat files the loader draws. */
const SPLAT_URI = /\.(splat|spz)($|[?#])/i;

/**
 * How the viewport's object loader reads a durableUri: as a splat (typed gaussian-splat, or a .splat / .spz file),
 * as a glTF model (.glb / .gltf), or not at all (null). The loader and the drawability checks (the viewport notices
 * and the mount) share this, so a URI counted as drawable is one the loader loads.
 */
export function drawableModelKind(uri: string | undefined, contentType?: string): 'splat' | 'gltf' | null {
    if (!uri) return null;
    if (contentType === 'gaussian-splat' || SPLAT_URI.test(uri)) return 'splat';
    if (GLTF_MODEL_URI.test(uri)) return 'gltf';
    return null;
}

/**
 * Placeholders the app itself seeds into scenes it opens or creates (the file opener's `internal:mesh`, and the
 * `internal:grid` / `internal:sunlight` older "New 4D Scene" workspaces were saved with). They draw nothing and were
 * never asked for, so they are neither content nor an error; any other URI the loader cannot read is reported.
 */
const APP_SEEDED_PLACEHOLDER_URIS = new Set(['internal:mesh', 'internal:grid', 'internal:sunlight']);

/** A placeholder the app seeded next to (or instead of) real objects; it draws nothing. */
export function isPlaceholderObject(o: Media4DObject | undefined): boolean {
    const uri = o?.content?.durableUri;
    return typeof uri === 'string' && APP_SEEDED_PLACEHOLDER_URIS.has(uri);
}

/** A `map-3d` object asks for live 3D tiles at its own anchor; the tiles layer draws it (and reports its errors). */
export function isTilesObject(o: Media4DObject | undefined): boolean {
    return o?.content?.type === 'map-3d';
}

/**
 * True when the viewport's object loader draws this object: its durableUri is a .glb / .gltf model or a .splat /
 * .spz splat (or it is typed gaussian-splat with a file). Other URIs (internal:plane, images, .obj) are skipped.
 */
export function isDrawableSceneObject(o: Media4DObject | undefined): boolean {
    const uri = o?.content?.durableUri;
    if (!uri || isPlaceholderObject(o) || isTilesObject(o)) return false;
    return drawableModelKind(uri, o?.content?.type) !== null;
}

/** A declared object the viewport cannot draw, and why. */
export interface UndrawableSceneObject {
    id: string;
    reason: string;
}

/**
 * The declared objects the viewport would skip without a word: neither a model or splat file the loader draws,
 * nor a placeholder or a tiles object. A scene that holds them says so instead of looking empty or complete.
 *
 * The placeholder URIs are exempt only in scenes the app opened or restored (the default). Objects the model sends
 * (a mount payload: `appPlaceholdersExempt: false`) are the model's content, so an `internal:sunlight` there is
 * reported like any other URI the loader cannot read rather than dropped while the mount reports success.
 */
export function undrawableSceneObjects(
    scene: Pick<Scene3DData, 'objects'>,
    options: { appPlaceholdersExempt?: boolean } = {}
): UndrawableSceneObject[] {
    if (!Array.isArray(scene.objects)) return [];
    const exempt = options.appPlaceholdersExempt !== false;
    return scene.objects
        .filter(o => !(exempt && isPlaceholderObject(o)) && !isTilesObject(o) && !isDrawableSceneObject(o))
        .map((o, i) => {
            const uri = o?.content?.durableUri;
            return {
                id: o?.id || `objects[${i}]`,
                reason: uri ? `${uri} is not a .glb, .gltf, .splat or .spz file` : 'it has no content.durableUri'
            };
        });
}

/**
 * True when the scene loads content of its own: an object the loader draws (see isDrawableSceneObject), or a splat
 * file (splatUrl). A placeholder never hides the real objects beside it, and an object the loader skips (an image,
 * internal:plane) is not content.
 */
export function hasNonFallbackObjectContent(scene: Pick<Scene3DData, 'objects' | 'splatUrl'>): boolean {
    if (scene.splatUrl) return true;
    return Array.isArray(scene.objects) && scene.objects.some(isDrawableSceneObject);
}

/**
 * Which slice draws the scene's focal content. 'empty' means the data declares nothing to draw; the viewport then
 * says "No geometry" instead of drawing a placeholder.
 */
export function classifySceneContent(input: SceneContentInput): SceneContentKind {
    if (input.hasActiveScript) return 'script';
    if (input.has3DTiles) return 'tiles';
    if (input.hasCppGenerator || input.hasPythonGenerator) return 'objects';
    if (input.hasCustomMeshes) return 'custom-meshes';
    if (input.hasNonFallbackObjects) return 'objects';
    return 'empty';
}

/**
 * Builds the focal content that has no slice of its own: the splat viewer and the dynamic script hooks.
 * Runs whenever the content fingerprint changes; never touches the renderer stack.
 */
export function syncSceneContent(
    stack: RendererStack,
    input: SceneContentInput,
    factories: SceneContentFactories
): SceneContentHandle {
    const { scene } = stack;

    // Splat viewer. A splat scene's file (splatUrl) is loaded as a scene object; a splat world with no file
    // and no objects shows nothing rather than a made-up colonnade and dome of splats.
    const splatViewer = factories.createSplatViewer();
    scene.add(splatViewer.group);

    let scriptHooks: SceneContentHandle['scriptHooks'] = null;
    let scriptError: string | null = null;
    if (input.hasActiveScript && factories.executeScript) {
        const result = factories.executeScript();
        if (result) {
            if (result.error) {
                scriptError = result.error;
            } else {
                scriptHooks = { update: result.update, dispose: result.dispose };
            }
        }
    }

    return {
        kind: classifySceneContent(input),
        splatViewer,
        scriptHooks,
        scriptError,
        dispose: () => {
            scriptHooks?.dispose?.();
            splatViewer.dispose();
            if (splatViewer.group.parent) splatViewer.group.parent.remove(splatViewer.group);
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
