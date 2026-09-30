/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from 'three';
import type { BakedGaussian } from '../../../../common/geospatial-4d-protocol';
import {
    createHistoricalBattlefieldScene,
    createProceduralCityScene,
    createHighwayOverpassScene,
    createAlpineMatterhornScene,
    createBabylonianZigguratScene,
    createSolarSystemScene,
    createMolecularPhysicsScene,
    createArchitecturalRoomScene,
    createProceduralSpatialScene,
    createWorldBuilderScene
} from '../../procedural-3d-synthesizer';
import { createSculptableGeometry } from '../../services/mesh-sculpting-engine';
import { createArticulatedAircraft } from '../../services/mesh/aircraft';
import type { TerrainManager } from '../../services/TerrainManager';
import type { RendererStack, Scene3DRenderMode, SceneContentHandle, WasmMeshHandle } from './types';
import { removeAndDispose } from './types';
import { isGroundSnapTarget } from './syncTilesLayer';

const BATTLEFIELD_KEYWORDS = /lexington|concord|1776|battle|revolution|minuteman|redcoat/i;
const WORLD_KEYWORDS = /world|terrain|mountain|alpine|canyon|desert|valley|island|citadel|outpost/i;
const CITY_KEYWORDS = /city|metropolis|urban|cyberpunk-city|skyline/i;
const SPACE_KEYWORDS = /solar|planet|space|orbit|celestial/i;
const MOLECULAR_KEYWORDS = /molecular|physics|atom|dna|quantum|chemistry/i;
const ARCHITECTURE_KEYWORDS = /room|building|interior|blueprint|pavilion/i;

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
    /** Objects exist and are not merely the `internal:mesh` fallback placeholder. */
    hasNonFallbackObjects: boolean;
    hasCppGenerator?: boolean;
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

export function classifySceneContent(input: SceneContentInput): 'script' | 'tiles' | 'aircraft' | 'worldbuilder' | 'battlefield' | 'city' | 'highway_overpass' | 'alpine_valley' | 'ziggurat' | 'solar-system' | 'molecular' | 'architecture' | 'custom-meshes' | 'objects' | 'spatial' {
    const worldBranch = (input.worldBranch || '').toLowerCase();
    const sceneTitle = (input.title || '').toLowerCase();
    const haystack = `${worldBranch} ${sceneTitle}`;
    const t = input.sceneType;
    if (input.hasActiveScript) return 'script';
    if (input.has3DTiles) return 'tiles';
    if (input.isAirplane) return 'aircraft';
    if (t === 'highway_overpass' || /highway|overpass|viaduct|interchange/i.test(haystack)) return 'highway_overpass';
    if (t === 'alpine_valley' || /matterhorn|alpine|chalet/i.test(haystack)) return 'alpine_valley';
    if (t === 'ziggurat' || /ziggurat|mesopotamia|etemenanki|babylon/i.test(haystack)) return 'ziggurat';
    if (input.hasCppGenerator) return 'objects';
    if (t === 'solar-system' || SPACE_KEYWORDS.test(haystack)) return 'solar-system';
    if (t === 'molecular' || MOLECULAR_KEYWORDS.test(haystack)) return 'molecular';
    if (t === 'architecture' || ARCHITECTURE_KEYWORDS.test(haystack)) return 'architecture';
    if (input.hasCustomMeshes) return 'custom-meshes';
    if (input.hasNonFallbackObjects) return 'objects';
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
        case 'worldbuilder':
            proceduralSceneGroup = createWorldBuilderScene(scene, THREE, {
                prompt: input.title || 'Scenic mountain valley with architectural settlements',
                resolution: 32,
                seed: 1337
            });
            break;
        case 'battlefield':
            proceduralSceneGroup = createHistoricalBattlefieldScene(scene, THREE, {
                tavern: true,
                meetinghouse: true,
                stoneWalls: true,
                minutemenCount: 12,
                redcoatCount: 16,
                smokeParticles: true
            });
            break;
        case 'city':
            proceduralSceneGroup = createProceduralCityScene(scene, THREE, {
                buildingCount: 28,
                animatedVehicles: true,
                cyberpunk: worldBranch.includes('cyberpunk') || sceneTitle.includes('cyberpunk')
            });
            break;
        case 'highway_overpass':
            proceduralSceneGroup = createHighwayOverpassScene(scene, THREE);
            break;
        case 'alpine_valley':
            proceduralSceneGroup = createAlpineMatterhornScene(scene, THREE);
            break;
        case 'ziggurat':
            proceduralSceneGroup = createBabylonianZigguratScene(scene, THREE);
            break;
        case 'solar-system':
            proceduralSceneGroup = createSolarSystemScene(scene, THREE, { includeAsteroidBelt: true, includeMoons: true });
            break;
        case 'molecular':
            proceduralSceneGroup = createMolecularPhysicsScene(scene, THREE, {
                latticeType: /dna|helix/i.test(sceneTitle) ? 'dna' : 'caffeine',
                showElectronCloud: true
            });
            break;
        case 'architecture':
            proceduralSceneGroup = createArchitecturalRoomScene(scene, THREE);
            break;
        case 'custom-meshes':
        case 'objects':
            // Custom meshes / objects are synchronised by their own slices.
            break;
        case 'spatial':
        default:
            proceduralSceneGroup = createProceduralSpatialScene(scene, THREE);
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

    // Splat viewer (procedural observation only for splat/gaussian branches)
    const splatViewer = factories.createSplatViewer();
    scene.add(splatViewer.group);
    if ((worldBranch.includes('splat') || worldBranch.includes('gaussian')) && !input.hasNonFallbackObjects) {
        const proceduralSplats: BakedGaussian[] = [];
        // Colonnade pillars (16 pillars around circle radius 4.5m)
        const pillarCount = 16;
        for (let p = 0; p < pillarCount; p++) {
            const angle = (p / pillarCount) * Math.PI * 2;
            const px = Math.cos(angle) * 4.5;
            const pz = Math.sin(angle) * 4.5;
            for (let y = 0; y <= 5.0; y += 0.08) {
                for (let r = 0; r < 6; r++) {
                    const ra = (r / 6) * Math.PI * 2;
                    proceduralSplats.push({
                        position: [px + Math.cos(ra) * 0.28, y, pz + Math.sin(ra) * 0.28],
                        scale: [0.08, 0.08, 0.08],
                        quaternion: [0, 0, 0, 1],
                        colorRgb: [220 + Math.floor(Math.random() * 25), 210 + Math.floor(Math.random() * 25), 195 + Math.floor(Math.random() * 25)],
                        opacity: 0.85
                    });
                }
            }
        }
        // Entablature and dome arch ring
        for (let a = 0; a < 250; a++) {
            const angle = (a / 250) * Math.PI * 2;
            for (let dy = 5.0; dy <= 5.6; dy += 0.1) {
                proceduralSplats.push({
                    position: [Math.cos(angle) * 4.5, dy, Math.sin(angle) * 4.5],
                    scale: [0.12, 0.1, 0.12],
                    quaternion: [0, 0, 0, 1],
                    colorRgb: [230, 222, 205],
                    opacity: 0.9
                });
            }
        }
        // Hemispherical dome
        for (let i = 0; i < 3000; i++) {
            const u = Math.random();
            const v = Math.random();
            const theta = u * 2.0 * Math.PI;
            const phi = Math.acos(1.0 - v);
            const rad = 4.5;
            proceduralSplats.push({
                position: [
                    rad * Math.sin(phi) * Math.cos(theta),
                    5.6 + rad * Math.cos(phi),
                    rad * Math.sin(phi) * Math.sin(theta)
                ],
                scale: [0.12, 0.12, 0.12],
                quaternion: [0, 0, 0, 1],
                colorRgb: [210 + Math.floor(Math.random() * 30), 200 + Math.floor(Math.random() * 30), 180 + Math.floor(Math.random() * 30)],
                opacity: 0.8
            });
        }
        // Stepped stylobate base
        for (let step = 0; step < 3; step++) {
            const rStep = 4.8 + step * 0.4;
            const yStep = -step * 0.18;
            for (let a = 0; a < 200; a++) {
                const angle = (a / 200) * Math.PI * 2;
                proceduralSplats.push({
                    position: [Math.cos(angle) * rStep, yStep, Math.sin(angle) * rStep],
                    scale: [0.15, 0.08, 0.15],
                    quaternion: [0, 0, 0, 1],
                    colorRgb: [180 + Math.floor(Math.random() * 20), 175 + Math.floor(Math.random() * 20), 165 + Math.floor(Math.random() * 20)],
                    opacity: 0.9
                });
            }
        }
        splatViewer.loadSplatObservation(proceduralSplats);
    }

    // Sculptable focal mesh (general / custom scenes) or first procedural mesh as sculpt target
    if (!input.hasCppGenerator && !input.isAirplane && !input.has3DTiles && !input.hasCustomMeshes && !input.hasActiveScript && !input.hasNonFallbackObjects && input.sceneType !== 'glass_shatter' && (!proceduralSceneGroup || input.sceneType === 'general' || input.sceneType === 'custom')) {
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
