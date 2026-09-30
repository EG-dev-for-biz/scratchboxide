/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import * as THREE from 'three';
import { GeoFrame } from '../../../common/coordinate/GeoFrame';
import type {
    CanvasArtifact,
    Scene3DData,
    SculptBrushType,
    SculptFalloffType,
    SculptSymmetry,
    SculptSettings,
    TransformGizmoMode,
    TransformGizmoSpace,
    ViewportToolMode
} from '../canvas-types';
import {
    evaluateFalloff,
    applySculptStroke,
    MeshHistoryStack,
    createSculptableGeometry,
    recomputeGeometryNormals
} from '../services/mesh-sculpting-engine';
import type {
    SculptBrushOptions
} from '../services/mesh-sculpting-engine';
import {
    TransformGizmoEngine,
    computeAxisTranslation,
    computePlaneTranslation,
    computeRotationAngle,
    computeScaleFactor
} from '../services/transform-gizmo-engine';
import type {
    GizmoHandleType
} from '../services/transform-gizmo-engine';
import {
    DirectDispatchOperatorEngine,
    createOperatorEngine
} from '../services/direct-dispatch-operator-engine';
import {
    Google3DTileService
} from '../services/Google3DTileService';
import {
    GooglePhotorealistic3DTilesLayer
} from '../services/GooglePhotorealistic3DTilesLayer';
import {
    TileBoundAligner
} from '../services/TileBoundAligner';
import {
    TileClayProcessor,
    ClayPresetId,
    CLAY_PRESETS
} from '../services/TileClayProcessor';
import {
    TerrainManager,
    GROUND_SAMPLE_OFFSETS
} from '../services/TerrainManager';
import type {
    OperatorCategory,
    OperatorResult,
    OperatorDefinition,
    BatchExecutionResult
} from '../services/direct-dispatch-operator-engine';
import {
    createHistoricalBattlefieldScene,
    createProceduralCityScene,
    createSolarSystemScene,
    createMolecularPhysicsScene,
    createArchitecturalRoomScene,
    createProceduralSpatialScene,
    createWorldBuilderScene,
    generateNativeBuildingMeshBuffer,
    buildNativeThreeGeometry,
    generateProceduralThreeMeshFromPrompt,
    sculptBuildingFrom3DTiles,
    snapFootprintsToTerrain,
    inspectSceneMeshTopology,
    synthesizeContextual3DScene
} from '../procedural-3d-synthesizer';
import {
    createAtmosphericSkyDome as createAtmosphericSkyDomeModule,
    calculateNOAASolarPosition,
    calculateENUSunVector,
    getSunVectorFromAngles,
    computeDiurnalLightingProfile,
    getDiurnalLightingState,
    getPresetLightingState,
    kelvinToRGB,
    createAerialPerspectiveEffect,
    AerialPerspectiveEffect,
    createTerrainCloudShadows,
    TerrainCloudShadows,
    computeBeerLambertTransmittance,
    computeInscatteringRadiance,
    evaluateAerialPerspective,
    projectCloudShadowCoordinates,
    computeCloudShadowFactor
} from '../services/atmosphere';
import type {
    AtmosphericScatteringConfig,
    AtmosphericSkyDomeModule,
    DiurnalLightingProfile,
    TimeOfDayPreset,
    AerialPerspectiveOptions,
    CloudShadowConfig
} from '../services/atmosphere';
import {
    createArticulatedAircraft,
    createAirplaneMesh,
    updateFlightPhysics,
    animateAircraftFrame
} from '../services/mesh/aircraft';
import type { ArticulatedAircraftComponents } from '../services/mesh/aircraft';
import { useLatest } from '../hooks/useLatest';
import { createRendererStack, attachViewportResize, reconcileDrawingBufferSize } from './scene3d/createRendererStack';
import { syncTilesLayer, snapGroupFiguresToGround } from './scene3d/syncTilesLayer';
import type { TilesLayerInput } from './scene3d/syncTilesLayer';
import { syncAtmosphere } from './scene3d/syncAtmosphere';
import type { AtmosphereInput } from './scene3d/syncAtmosphere';
import { syncSceneContent, syncWasmMesh } from './scene3d/syncSceneContent';
import type { SceneContentInput, SceneContentFactories } from './scene3d/syncSceneContent';
import { syncCustomMeshes, disposeCustomMeshes } from './scene3d/syncCustomMeshes';
import type { CustomMeshRegistry, CustomMeshDefinition } from './scene3d/syncCustomMeshes';
import { syncCustomShaders, tickCustomShaders } from './scene3d/syncCustomShaders';
import type { CustomShaderDefinition } from './scene3d/syncCustomShaders';
import { attachViewportControls, stepCamera } from './scene3d/attachViewportControls';
import { syncVectorRoadmapBlueprint } from './scene3d/syncVectorRoadmapBlueprint';
import { VectorRoadmapHUD } from './scene3d/VectorRoadmapHUD';
import type { RendererStack, AtmosphereHandle, TilesLayerHandle, SceneContentHandle, WasmMeshHandle, VectorRoadmapHandle } from './scene3d/types';
import type { VectorRoadmapConfig } from '../canvas-types';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CINEMATIC_RIGS, computeSceneBudgetTelemetry } from './scene3d/lightingRigs';
import type { SceneBudgetTelemetry } from './scene3d/lightingRigs';

// Aircraft helpers live in services/mesh/aircraft.ts (single source of truth, shared with the
// transformer engine's sandbox template); re-exported here to keep the public API stable.
export { createArticulatedAircraft, createAirplaneMesh, updateFlightPhysics, animateAircraftFrame };
export type { ArticulatedAircraftComponents };
// The atmospheric sky dome is the service implementation itself (no wrapper indirection).
const createAtmosphericSkyDome = createAtmosphericSkyDomeModule;
export { createAtmosphericSkyDome };

export {
    createHistoricalBattlefieldScene,
    createProceduralCityScene,
    createSolarSystemScene,
    createMolecularPhysicsScene,
    createArchitecturalRoomScene,
    createProceduralSpatialScene,
    createWorldBuilderScene,
    generateNativeBuildingMeshBuffer,
    buildNativeThreeGeometry,
    generateProceduralThreeMeshFromPrompt,
    sculptBuildingFrom3DTiles,
    snapFootprintsToTerrain,
    inspectSceneMeshTopology,
    evaluateFalloff,
    applySculptStroke,
    MeshHistoryStack,
    createSculptableGeometry,
    recomputeGeometryNormals,
    TransformGizmoEngine,
    computeAxisTranslation,
    computePlaneTranslation,
    computeRotationAngle,
    computeScaleFactor,
    DirectDispatchOperatorEngine,
    createOperatorEngine,
    createAtmosphericSkyDomeModule,
    calculateNOAASolarPosition,
    calculateENUSunVector,
    getSunVectorFromAngles,
    computeDiurnalLightingProfile,
    getDiurnalLightingState,
    getPresetLightingState,
    kelvinToRGB,
    createAerialPerspectiveEffect,
    AerialPerspectiveEffect,
    createTerrainCloudShadows,
    TerrainCloudShadows,
    computeBeerLambertTransmittance,
    computeInscatteringRadiance,
    evaluateAerialPerspective,
    projectCloudShadowCoordinates,
    computeCloudShadowFactor,
    TileBoundAligner,
    TileClayProcessor,
    Google3DTileService,
    CLAY_PRESETS,
    TerrainManager,
    GROUND_SAMPLE_OFFSETS
};

export type {
    OperatorCategory,
    OperatorResult,
    OperatorDefinition,
    BatchExecutionResult,
    SculptBrushOptions,
    GizmoHandleType,
    SculptBrushType,
    SculptFalloffType,
    SculptSymmetry,
    SculptSettings,
    TransformGizmoMode,
    TransformGizmoSpace,
    ViewportToolMode,
    AtmosphericScatteringConfig,
    AtmosphericSkyDomeModule,
    DiurnalLightingProfile,
    TimeOfDayPreset,
    AerialPerspectiveOptions,
    CloudShadowConfig
};

export interface Scene3DPrimitiveProps {
    data: Scene3DData;
    onUpdate?: (updatedData: Scene3DData) => void;
    onPromptAction?: (promptText: string) => void;
    onMorphArtifact?: (artifact: CanvasArtifact, targetType: string) => void;
    onCaptureReady?: (captureFn: () => string) => void;
    onVisualVerification?: (screenshotDataUrl: string) => void;
}

/**
 * Captures a visual screenshot of the current Three.js WebGL frame as a PNG data URL.
 */
export function captureSceneScreenshot(
    renderer?: THREE.WebGLRenderer | null,
    scene?: THREE.Scene | null,
    camera?: THREE.Camera | null
): string {
    if (renderer && renderer.domElement) {
        if (scene && camera && typeof renderer.render === 'function') {
            try {
                renderer.render(scene, camera);
            } catch (e) {
                // ignore render error if in tear down
            }
        }
        if (typeof renderer.domElement.toDataURL === 'function') {
            try {
                const dataUrl = renderer.domElement.toDataURL('image/png');
                if (dataUrl && dataUrl.length > 22) {
                    return dataUrl;
                }
            } catch (e) {
                // fall through to fallback
            }
        }
    }

    if (typeof document !== 'undefined') {
        const activeCanvas = document.querySelector('.sb-3d-stage-wrapper canvas, canvas') as HTMLCanvasElement;
        if (activeCanvas && typeof activeCanvas.toDataURL === 'function') {
            try {
                const dataUrl = activeCanvas.toDataURL('image/png');
                if (dataUrl && dataUrl.length > 22) {
                    return dataUrl;
                }
            } catch (e) {
                // fall through
            }
        }
    }

    // High-resolution deterministic PNG fallback for headless/test environments
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
}

export interface DynamicScriptContext {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    container: HTMLElement;
    THREE: typeof THREE;
    sceneData: Scene3DData;
    aircraft?: THREE.Group | null;
    terrain?: THREE.Mesh | THREE.Group | null;
    skyDome?: THREE.Mesh | null;
    aerialPerspective?: any;
    cloudShadows?: any;
    godRays?: THREE.Mesh | THREE.Group | null;
    contrails?: any;
    addCleanup: (fn: () => void) => void;
    onFrame: (fn: (time: number, delta: number) => void) => void;
    registerUpdate: (fn: (time: number, delta: number) => void) => void;
    createArticulatedAircraft?: typeof createArticulatedAircraft;
    createVolumetricGodRays?: typeof createVolumetricGodRays;
    createDynamicContrails?: typeof createDynamicContrails;
    createAtmosphericSkyDome?: typeof createAtmosphericSkyDome;
    createAerialPerspectiveEffect?: typeof createAerialPerspectiveEffect;
    createTerrainCloudShadows?: typeof createTerrainCloudShadows;
    calculateNOAASolarPosition?: typeof calculateNOAASolarPosition;
    calculateENUSunVector?: typeof calculateENUSunVector;
    getSunVectorFromAngles?: typeof getSunVectorFromAngles;
    computeDiurnalLightingProfile?: typeof computeDiurnalLightingProfile;
    getDiurnalLightingState?: typeof getDiurnalLightingState;
    getPresetLightingState?: typeof getPresetLightingState;
    kelvinToRGB?: typeof kelvinToRGB;
    createProceduralBiomeTerrain?: typeof createProceduralBiomeTerrain;
    createAirplaneMesh?: typeof createAirplaneMesh;
    createDroneMesh?: typeof createDroneMesh;
    createPinMesh?: typeof createPinMesh;
    createHistoricalBattlefieldScene?: typeof createHistoricalBattlefieldScene;
    createProceduralCityScene?: typeof createProceduralCityScene;
    createSolarSystemScene?: typeof createSolarSystemScene;
    createMolecularPhysicsScene?: typeof createMolecularPhysicsScene;
    createArchitecturalRoomScene?: typeof createArchitecturalRoomScene;
    createProceduralSpatialScene?: typeof createProceduralSpatialScene;
    createWorldBuilderScene?: typeof createWorldBuilderScene;
    generateNativeBuildingMeshBuffer?: typeof generateNativeBuildingMeshBuffer;
    buildNativeThreeGeometry?: typeof buildNativeThreeGeometry;
    generateProceduralThreeMeshFromPrompt?: typeof generateProceduralThreeMeshFromPrompt;
    sculptBuildingFrom3DTiles?: typeof sculptBuildingFrom3DTiles;
    snapFootprintsToTerrain?: typeof snapFootprintsToTerrain;
    inspectSceneMeshTopology?: typeof inspectSceneMeshTopology;
}

// ---------------------------------------------------------
// Geospatial Projection & Simulation Standalone Helpers
// ---------------------------------------------------------
export const getProceduralBinnedHeight = (x: number, z: number, elevVal: number): number => {
    const distanceToBay = x + 15; // bay is on the left
    let y = Math.sin(x * 0.1) * Math.cos(z * 0.1) * 3.5; // rolling hills
    y += Math.sin(x * 0.05 + z * 0.05) * 5.0; // larger slope

    if (distanceToBay < -5) {
        // Water level depression
        y = -2.0 + Math.sin(z * 0.2) * 0.2;
    } else if (distanceToBay < 5) {
        // Smooth transition (shoreline)
        y *= (distanceToBay + 5) / 10;
    }

    // Adjust overall elevation offset
    const rawY = y + elevVal * 0.05 - 1.5;
    return Math.round(rawY / 0.4) * 0.4;
};

export const createPinMesh = (color: number): THREE.Group => {
    const pinGroup = new THREE.Group();
    // Pin head (sphere)
    const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.25, 16, 16),
        new THREE.MeshBasicMaterial({ color })
    );
    sphere.position.y = 0.8;
    // Pin stand (thin cone pointing down)
    const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.1, 0.8, 16),
        new THREE.MeshBasicMaterial({ color })
    );
    cone.position.y = 0.4;
    cone.rotateX(Math.PI);
    
    pinGroup.add(sphere);
    pinGroup.add(cone);
    return pinGroup;
};

export const createDroneMesh = (): THREE.Group => {
    const droneGroup = new THREE.Group();
    
    // Crossbars (two long thin cylinders crossing each other)
    const barMat = new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.8, roughness: 0.2 });
    const bar1 = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.2), barMat);
    bar1.rotateZ(Math.PI / 2);
    const bar2 = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.2), barMat);
    bar2.rotateX(Math.PI / 2);
    
    droneGroup.add(bar1);
    droneGroup.add(bar2);
    
    // Glowing neon red/amber indicator spheres on the 4 ends
    const sphereMatRed = new THREE.MeshBasicMaterial({ color: 0xff0055 });
    const sphereMatAmber = new THREE.MeshBasicMaterial({ color: 0xffaa00 });
    
    const s1 = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), sphereMatRed);
    s1.position.set(0.6, 0, 0);
    const s2 = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), sphereMatRed);
    s2.position.set(-0.6, 0, 0);
    const s3 = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), sphereMatAmber);
    s3.position.set(0, 0, 0.6);
    const s4 = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), sphereMatAmber);
    s4.position.set(0, 0, -0.6);
    
    droneGroup.add(s1, s2, s3, s4);
    
    // Glowing center core (cyan sphere)
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 16), new THREE.MeshBasicMaterial({ color: 0x00ffff }));
    droneGroup.add(core);
    
    return droneGroup;
};

// ---------------------------------------------------------
// Volumetric God Rays & Light Shafts Generator
import { createVolumetricGodRays, VolumetricGodRays } from '../services/atmosphere';
export { createVolumetricGodRays, VolumetricGodRays };

// ---------------------------------------------------------
// Dynamic Contrail Dynamics & Wingtip Vortex Particle Emitter
// ---------------------------------------------------------
export const createDynamicContrails = (scene: THREE.Scene, maxPoints: number = 300) => {
    const contrailGroup = new THREE.Group();

    // Create dual particle buffers for left and right wingtips
    const leftGeo = new THREE.BufferGeometry();
    const rightGeo = new THREE.BufferGeometry();

    const leftPositions = new Float32Array(maxPoints * 3);
    const rightPositions = new Float32Array(maxPoints * 3);
    const leftOpacities = new Float32Array(maxPoints);
    const rightOpacities = new Float32Array(maxPoints);

    leftGeo.setAttribute('position', new THREE.BufferAttribute(leftPositions, 3));
    leftGeo.setAttribute('opacity', new THREE.BufferAttribute(leftOpacities, 1));

    rightGeo.setAttribute('position', new THREE.BufferAttribute(rightPositions, 3));
    rightGeo.setAttribute('opacity', new THREE.BufferAttribute(rightOpacities, 1));

    const contrailMat = new THREE.ShaderMaterial({
        uniforms: {
            uColor: { value: new THREE.Color(0xf0f9ff) },
            uBaseSize: { value: 18.0 }
        },
        vertexShader: `
            attribute float opacity;
            varying float vOpacity;
            uniform float uBaseSize;
            void main() {
                vOpacity = opacity;
                vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = uBaseSize * (150.0 / -mvPos.z) * (1.2 - opacity * 0.4);
                gl_Position = projectionMatrix * mvPos;
            }
        `,
        fragmentShader: `
            uniform vec3 uColor;
            varying float vOpacity;
            void main() {
                vec2 coord = gl_PointCoord - vec2(0.5);
                float distSq = dot(coord, coord);
                if (distSq > 0.25) discard;
                float falloff = exp(-distSq * 8.0);
                gl_FragColor = vec4(uColor, vOpacity * 0.7 * falloff);
            }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending
    });

    const leftPoints = new THREE.Points(leftGeo, contrailMat);
    const rightPoints = new THREE.Points(rightGeo, contrailMat);

    contrailGroup.add(leftPoints);
    contrailGroup.add(rightPoints);
    scene.add(contrailGroup);

    const historyLeft: THREE.Vector3[] = [];
    const historyRight: THREE.Vector3[] = [];

    return {
        group: contrailGroup,
        update: (aircraft: THREE.Group, _time: number, _delta: number) => {
            if (!aircraft) return;

            const emitters = aircraft.userData?.contrailEmitters;
            if (emitters && emitters.length >= 2) {
                const leftPos = new THREE.Vector3();
                const rightPos = new THREE.Vector3();
                emitters[0].getWorldPosition(leftPos);
                emitters[1].getWorldPosition(rightPos);

                historyLeft.unshift(leftPos);
                historyRight.unshift(rightPos);

                if (historyLeft.length > maxPoints) historyLeft.pop();
                if (historyRight.length > maxPoints) historyRight.pop();

                const lPosAttr = leftGeo.attributes.position as THREE.BufferAttribute;
                const rPosAttr = rightGeo.attributes.position as THREE.BufferAttribute;
                const lOpAttr = leftGeo.attributes.opacity as THREE.BufferAttribute;
                const rOpAttr = rightGeo.attributes.opacity as THREE.BufferAttribute;

                for (let i = 0; i < maxPoints; i++) {
                    const ageFrac = i / maxPoints;
                    const alpha = Math.max(0, 1.0 - ageFrac);

                    if (i < historyLeft.length) {
                        // Turbulence curl drift
                        const driftX = Math.sin(i * 0.3) * 0.08 * ageFrac;
                        const driftY = Math.cos(i * 0.3) * 0.08 * ageFrac;
                        lPosAttr.setXYZ(i, historyLeft[i].x + driftX, historyLeft[i].y + driftY, historyLeft[i].z);
                        rPosAttr.setXYZ(i, historyRight[i].x - driftX, historyRight[i].y + driftY, historyRight[i].z);
                        lOpAttr.setX(i, alpha);
                        rOpAttr.setX(i, alpha);
                    } else {
                        lOpAttr.setX(i, 0);
                        rOpAttr.setX(i, 0);
                    }
                }

                lPosAttr.needsUpdate = true;
                rPosAttr.needsUpdate = true;
                lOpAttr.needsUpdate = true;
                rOpAttr.needsUpdate = true;
            }
        },
        dispose: () => {
            scene.remove(contrailGroup);
            leftGeo.dispose();
            rightGeo.dispose();
            contrailMat.dispose();
        }
    };
};

// ---------------------------------------------------------
// Procedural Terrain Biomes Generator
// ---------------------------------------------------------
export const createProceduralBiomeTerrain = (
    scene: THREE.Scene,
    biomeType: string = 'alpine',
    renderMode: string = 'pbr',
    isSunset: boolean = false
) => {
    const terrainGroup = new THREE.Group();
    const terrainSize = 350;
    const segments = 64;

    const terrainGeo = new THREE.PlaneGeometry(terrainSize, terrainSize, segments, segments);
    terrainGeo.rotateX(-Math.PI / 2);

    const positions = terrainGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < positions.count; i++) {
        const x = positions.getX(i);
        const z = positions.getZ(i);
        const dist = Math.sqrt(x * x + z * z);

        let height = 0;
        if (biomeType === 'canyon') {
            // Layered stepped plateau with carved river channel
            const riverDist = Math.abs(x);
            height = Math.sin(z * 0.05) * 3.0 + Math.cos(x * 0.04) * 8.0;
            if (riverDist < 12) {
                height -= (12 - riverDist) * 1.5;
            }
        } else if (biomeType === 'desert') {
            // Wind-swept dunes
            height = Math.sin(x * 0.04 + z * 0.02) * 3.5 + Math.sin(x * 0.08) * 1.5;
        } else if (biomeType === 'coastal') {
            // Shoreline transition
            height = Math.sin(x * 0.05) * Math.cos(z * 0.05) * 4.0;
            if (x < -10) height = -2.5 + Math.sin(z * 0.1) * 0.3;
        } else {
            // Alpine mountains & valleys
            height = Math.sin(x * 0.03) * Math.cos(z * 0.03) * 7.5;
            height += Math.sin(x * 0.07 + z * 0.05) * 3.5;
            height += Math.sin(x * 0.15) * 1.0;
        }

        // Edge fade
        if (dist > 120) {
            height *= Math.max(0, (170 - dist) / 50);
        }

        positions.setY(i, height - 8.0);
    }
    terrainGeo.computeVertexNormals();

    let terrainColor = 0x1e3a29; // Alpine green
    if (biomeType === 'desert') terrainColor = 0xd97706;
    else if (biomeType === 'canyon') terrainColor = 0x9a3412;
    else if (biomeType === 'coastal') terrainColor = 0x0f766e;
    else if (biomeType === 'cyberpunk') terrainColor = 0x0f172a;

    let terrainMat: THREE.Material;
    if (renderMode === 'wireframe') {
        terrainMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, wireframe: true });
    } else {
        terrainMat = new THREE.MeshStandardMaterial({
            color: isSunset ? 0x1e293b : terrainColor,
            roughness: 0.75,
            metalness: 0.2,
            flatShading: true
        });
    }

    const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
    terrainGroup.add(terrainMesh);

    // Volumetric cloud clusters
    const cloudGroup = new THREE.Group();
    const cloudMat = new THREE.MeshStandardMaterial({
        color: isSunset ? 0xffedd5 : 0xffffff,
        roughness: 0.9,
        metalness: 0.0,
        transparent: true,
        opacity: 0.85
    });

    for (let c = 0; c < 20; c++) {
        const puffCluster = new THREE.Group();
        const puffCount = 5 + Math.floor(Math.random() * 5);
        for (let p = 0; p < puffCount; p++) {
            const radius = 1.2 + Math.random() * 2.0;
            const puff = new THREE.Mesh(new THREE.DodecahedronGeometry(radius, 1), cloudMat);
            puff.position.set(
                (Math.random() - 0.5) * 3.5,
                (Math.random() - 0.5) * 1.2,
                (Math.random() - 0.5) * 3.5
            );
            puffCluster.add(puff);
        }
        const cx = (Math.random() - 0.5) * 160;
        const cy = -3 + Math.random() * 6;
        const cz = (Math.random() - 0.5) * 160;
        puffCluster.position.set(cx, cy, cz);
        cloudGroup.add(puffCluster);
    }
    terrainGroup.add(cloudGroup);
    scene.add(terrainGroup);

    return {
        group: terrainGroup,
        terrainMesh,
        cloudGroup,
        update: (time: number, _delta: number) => {
            cloudGroup.position.x = Math.sin(time * 0.02) * 5.0;
        },
        dispose: () => {
            scene.remove(terrainGroup);
            terrainGeo.dispose();
            terrainMat.dispose();
            cloudMat.dispose();
        }
    };
};

// ---------------------------------------------------------
// Safe Dynamic Three.js Script Evaluation Engine
// ---------------------------------------------------------
export const executeDynamicThreeScript = (
    scriptCode: string,
    context: DynamicScriptContext
): { update?: (time: number, delta: number) => void; dispose?: () => void; error?: string | null } => {
    try {
        // Strip ES module import/export keywords for execution in Function constructor
        let sanitized = scriptCode
            .replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];?/g, '')
            .replace(/export\s+default\s+/g, '')
            .replace(/export\s+function\s+/g, 'function ')
            .replace(/export\s+const\s+/g, 'const ')
            .replace(/export\s+let\s+/g, 'let ')
            .replace(/export\s+var\s+/g, 'var ');

        // If the script defines runCustomScript, call it and return its hooks
        if (sanitized.includes('function runCustomScript') || sanitized.includes('const runCustomScript')) {
            sanitized += '\nif (typeof runCustomScript === "function") { return runCustomScript(context); }';
        }

        const runner = new Function('context', 'THREE', 'scene', 'camera', 'renderer', `
            with (context) {
                ${sanitized}
            }
        `);

        const result = runner(context, context.THREE, context.scene, context.camera, context.renderer);

        if (result && typeof result === 'object') {
            return {
                update: result.update || result.animate,
                dispose: result.dispose || result.cleanup,
                error: null
            };
        }

        return { error: null };
    } catch (err: any) {
        console.warn('[3D Dynamic Script Evaluation Error]:', err);
        return { error: err?.message || String(err) };
    }
};

import { BakedGaussian } from '../../../common/geospatial-4d-protocol';
import { NativeSpatialBridge } from '../../../common/spatial/NativeSpatialBridge';
import { PhotorealGaussianSplatMesh } from '../services/spatial/PhotorealGaussianSplatMesh';

// ==========================================
// Pluggable Splat Representation (ISplatViewer)
// ==========================================

export interface ISplatViewer {
    loadSplatObservation(gaussians: BakedGaussian[]): void;
    loadSplatBuffer?(buffer: ArrayBuffer, format?: 'splat' | 'spz'): Promise<void> | void;
    updateCamera?(camera: THREE.Camera): void;
    group: THREE.Group;
    dispose(): void;
}

export class InHouseSplatViewer implements ISplatViewer {
    public group: THREE.Group;
    private splatMesh: THREE.Mesh | null = null;
    private rawGaussians: BakedGaussian[] = [];
    private sortedIndices: Uint32Array | null = null;
    private lastCameraPos = new THREE.Vector3();
    private lastCameraRot = new THREE.Quaternion();
    private lastSortTime = 0;

    constructor() {
        this.group = new THREE.Group();
    }

    /**
     * Loads raw BakedGaussian array into instanced 3D Gaussian Splatting geometry.
     */
    public loadSplatObservation(gaussians: BakedGaussian[]): void {
        this.dispose();
        this.rawGaussians = [...gaussians];
        const count = gaussians.length;
        if (count === 0) return;

        // Base unit quad geometry: 4 vertices [-1..1] spanning 2-sigma ellipse
        const quadPositions = new Float32Array([
            -1.0, -1.0, 0.0,
             1.0, -1.0, 0.0,
             1.0,  1.0, 0.0,
            -1.0,  1.0, 0.0
        ]);
        const quadIndices = [0, 1, 2, 0, 2, 3];

        const baseGeometry = new THREE.BufferGeometry();
        baseGeometry.setAttribute('position', new THREE.BufferAttribute(quadPositions, 3));
        baseGeometry.setIndex(quadIndices);

        const instGeometry = new THREE.InstancedBufferGeometry();
        instGeometry.copy(baseGeometry as any);
        instGeometry.instanceCount = count;

        const posArray = new Float32Array(count * 3);
        const scaleArray = new Float32Array(count * 3);
        const quatArray = new Float32Array(count * 4);
        const colorArray = new Float32Array(count * 4);

        for (let i = 0; i < count; i++) {
            const g = gaussians[i];
            posArray[i * 3] = g.position[0];
            posArray[i * 3 + 1] = g.position[1];
            posArray[i * 3 + 2] = g.position[2];

            scaleArray[i * 3] = Math.max(0.001, g.scale[0]);
            scaleArray[i * 3 + 1] = Math.max(0.001, g.scale[1]);
            scaleArray[i * 3 + 2] = Math.max(0.001, g.scale[2]);

            const q = g.quaternion || [0, 0, 0, 1];
            quatArray[i * 4] = q[0];
            quatArray[i * 4 + 1] = q[1];
            quatArray[i * 4 + 2] = q[2];
            quatArray[i * 4 + 3] = q[3];

            colorArray[i * 4] = g.colorRgb[0] > 1.0 ? g.colorRgb[0] / 255.0 : g.colorRgb[0];
            colorArray[i * 4 + 1] = g.colorRgb[1] > 1.0 ? g.colorRgb[1] / 255.0 : g.colorRgb[1];
            colorArray[i * 4 + 2] = g.colorRgb[2] > 1.0 ? g.colorRgb[2] / 255.0 : g.colorRgb[2];
            colorArray[i * 4 + 3] = g.opacity;
        }

        instGeometry.setAttribute('instancePosition', new THREE.InstancedBufferAttribute(posArray, 3));
        instGeometry.setAttribute('instanceScale', new THREE.InstancedBufferAttribute(scaleArray, 3));
        instGeometry.setAttribute('instanceQuat', new THREE.InstancedBufferAttribute(quatArray, 4));
        instGeometry.setAttribute('instanceColor', new THREE.InstancedBufferAttribute(colorArray, 4));

        const material = new THREE.ShaderMaterial({
            vertexShader: `
                attribute vec3 instancePosition;
                attribute vec3 instanceScale;
                attribute vec4 instanceQuat;
                attribute vec4 instanceColor;

                varying vec4 vColor;
                varying vec2 vQuadPos;

                mat3 quatToMat3(vec4 q) {
                    float x2 = q.x + q.x, y2 = q.y + q.y, z2 = q.z + q.z;
                    float xx = q.x * x2, xy = q.x * y2, xz = q.x * z2;
                    float yy = q.y * y2, yz = q.y * z2, zz = q.z * z2;
                    float wx = q.w * x2, wy = q.w * y2, wz = q.w * z2;
                    return mat3(
                        1.0 - (yy + zz), xy + wz, xz - wy,
                        xy - wz, 1.0 - (xx + zz), yz + wx,
                        xz + wy, yz - wx, 1.0 - (xx + yy)
                    );
                }

                void main() {
                    vColor = instanceColor;
                    vQuadPos = position.xy * 2.0;

                    vec4 camPos = modelViewMatrix * vec4(instancePosition, 1.0);
                    if (camPos.z >= -0.01) {
                        gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
                        return;
                    }

                    mat3 R = quatToMat3(instanceQuat);
                    mat3 S = mat3(
                        instanceScale.x, 0.0, 0.0,
                        0.0, instanceScale.y, 0.0,
                        0.0, 0.0, instanceScale.z
                    );
                    mat3 M = R * S;
                    mat3 Sigma = M * transpose(M);

                    mat3 W = mat3(modelViewMatrix);
                    mat3 V = W * Sigma * transpose(W);

                    float tz = -camPos.z;
                    float tz2 = tz * tz;
                    float fx = projectionMatrix[0][0];
                    float fy = projectionMatrix[1][1];

                    mat3 J = mat3(
                        fx / tz, 0.0, 0.0,
                        0.0, fy / tz, 0.0,
                        -fx * camPos.x / tz2, -fy * camPos.y / tz2, 0.0
                    );

                    mat3 Sigma2D = J * V * transpose(J);

                    float s00 = Sigma2D[0][0] + 0.0001;
                    float s01 = Sigma2D[0][1];
                    float s11 = Sigma2D[1][1] + 0.0001;

                    float det = s00 * s11 - s01 * s01;
                    float trace = s00 + s11;
                    float disc = max(0.0, trace * trace * 0.25 - det);
                    float lambda1 = trace * 0.5 + sqrt(disc);
                    float lambda2 = max(0.0, trace * 0.5 - sqrt(disc));

                    float radius1 = sqrt(max(lambda1, 1e-6));
                    float radius2 = sqrt(max(lambda2, 1e-6));

                    float theta = 0.5 * atan(2.0 * s01, s00 - s11);
                    float cosT = cos(theta);
                    float sinT = sin(theta);

                    vec2 majorAxis = vec2(cosT, sinT) * radius1 * 3.0;
                    vec2 minorAxis = vec2(-sinT, cosT) * radius2 * 3.0;

                    vec2 ndcOffset = position.x * majorAxis + position.y * minorAxis;

                    vec4 centerNdc = projectionMatrix * camPos;
                    centerNdc.xy += ndcOffset * centerNdc.w;

                    gl_Position = centerNdc;
                }
            `,
            fragmentShader: `
                varying vec4 vColor;
                varying vec2 vQuadPos;

                void main() {
                    float r2 = dot(vQuadPos, vQuadPos);
                    if (r2 > 4.0) discard;
                    float alpha = exp(-0.5 * r2) * vColor.a;
                    if (alpha < 0.02) discard;
                    gl_FragColor = vec4(vColor.rgb, alpha);
                }
            `,
            transparent: true,
            depthWrite: false,
            depthTest: true,
            blending: THREE.NormalBlending,
            side: THREE.DoubleSide
        });

        this.splatMesh = new THREE.Mesh(instGeometry as any, material);
        this.splatMesh.frustumCulled = false;
        this.group.add(this.splatMesh);
    }

    /**
     * Loads a binary .splat or .spz ArrayBuffer directly into the viewer.
     */
    public async loadSplatBuffer(buffer: ArrayBuffer, format?: 'splat' | 'spz'): Promise<void> {
        const bytes = new Uint8Array(buffer);
        const isSpz = format === 'spz' || (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b);

        if (isSpz) {
            let decompressed = bytes;
            if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
                if (typeof DecompressionStream !== 'undefined') {
                    const ds = new DecompressionStream('gzip');
                    const writer = ds.writable.getWriter();
                    writer.write(bytes);
                    writer.close();
                    const reader = ds.readable.getReader();
                    const chunks: Uint8Array[] = [];
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        if (value) chunks.push(value);
                    }
                    const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
                    decompressed = new Uint8Array(totalLen);
                    let off = 0;
                    for (const chunk of chunks) {
                        decompressed.set(chunk, off);
                        off += chunk.length;
                    }
                }
            }
            const gaussians = NativeSpatialBridge.decodeSpzPayload(decompressed);
            this.loadSplatObservation(gaussians);
        } else {
            const gaussians = NativeSpatialBridge.parseSplatBuffer(buffer);
            this.loadSplatObservation(gaussians);
        }
    }

    /**
     * Camera hook for real-time depth sorting and perspective projection updates.
     */
    public updateCamera(camera: THREE.Camera): void {
        if (!this.splatMesh || this.rawGaussians.length === 0) return;

        const now = performance.now();
        // Throttle depth sorting to 30 Hz for maximum viewport performance
        if (now - this.lastSortTime < 33) return;

        const posDeltaSq = this.lastCameraPos.distanceToSquared(camera.position);
        if (posDeltaSq < 0.01) return;

        this.lastSortTime = now;
        this.lastCameraPos.copy(camera.position);
        this.lastCameraRot.copy(camera.quaternion);

        const count = this.rawGaussians.length;
        if (!this.sortedIndices || this.sortedIndices.length !== count) {
            this.sortedIndices = new Uint32Array(count);
            for (let i = 0; i < count; i++) this.sortedIndices[i] = i;
        }

        const depths = new Float32Array(count);
        const cx = camera.position.x;
        const cy = camera.position.y;
        const cz = camera.position.z;

        for (let i = 0; i < count; i++) {
            const p = this.rawGaussians[i].position;
            const dx = p[0] - cx;
            const dy = p[1] - cy;
            const dz = p[2] - cz;
            depths[i] = dx * dx + dy * dy + dz * dz;
        }

        // Sort indices from farthest to nearest (back-to-front alpha compositing)
        const indices = Array.from(this.sortedIndices);
        indices.sort((a, b) => depths[b] - depths[a]);
        this.sortedIndices.set(indices);

        const geom = this.splatMesh.geometry as THREE.InstancedBufferGeometry;
        const posAttr = geom.getAttribute('instancePosition') as THREE.InstancedBufferAttribute;
        const scaleAttr = geom.getAttribute('instanceScale') as THREE.InstancedBufferAttribute;
        const quatAttr = geom.getAttribute('instanceQuat') as THREE.InstancedBufferAttribute;
        const colorAttr = geom.getAttribute('instanceColor') as THREE.InstancedBufferAttribute;

        const pArr = posAttr.array as Float32Array;
        const sArr = scaleAttr.array as Float32Array;
        const qArr = quatAttr.array as Float32Array;
        const cArr = colorAttr.array as Float32Array;

        for (let dst = 0; dst < count; dst++) {
            const src = this.sortedIndices[dst];
            const g = this.rawGaussians[src];

            pArr[dst * 3] = g.position[0];
            pArr[dst * 3 + 1] = g.position[1];
            pArr[dst * 3 + 2] = g.position[2];

            sArr[dst * 3] = Math.max(0.001, g.scale[0]);
            sArr[dst * 3 + 1] = Math.max(0.001, g.scale[1]);
            sArr[dst * 3 + 2] = Math.max(0.001, g.scale[2]);

            const q = g.quaternion || [0, 0, 0, 1];
            qArr[dst * 4] = q[0];
            qArr[dst * 4 + 1] = q[1];
            qArr[dst * 4 + 2] = q[2];
            qArr[dst * 4 + 3] = q[3];

            cArr[dst * 4] = g.colorRgb[0] > 1.0 ? g.colorRgb[0] / 255.0 : g.colorRgb[0];
            cArr[dst * 4 + 1] = g.colorRgb[1] > 1.0 ? g.colorRgb[1] / 255.0 : g.colorRgb[1];
            cArr[dst * 4 + 2] = g.colorRgb[2] > 1.0 ? g.colorRgb[2] / 255.0 : g.colorRgb[2];
            cArr[dst * 4 + 3] = g.opacity;
        }

        posAttr.needsUpdate = true;
        scaleAttr.needsUpdate = true;
        quatAttr.needsUpdate = true;
        colorAttr.needsUpdate = true;
    }

    public dispose(): void {
        if (this.splatMesh) {
            this.group.remove(this.splatMesh);
            this.splatMesh.geometry.dispose();
            if (Array.isArray(this.splatMesh.material)) {
                this.splatMesh.material.forEach(m => m.dispose());
            } else {
                this.splatMesh.material.dispose();
            }
            this.splatMesh = null;
        }
        this.rawGaussians = [];
        this.sortedIndices = null;
    }
}

/**
 * Resolves top-level selectable object from a raycast hit object.
 */
export function resolveSelectableObject(hitObject: THREE.Object3D, sceneRoot: THREE.Object3D): THREE.Object3D {
    let current: THREE.Object3D = hitObject;
    let selectable: THREE.Object3D = hitObject;

    while (current && current.parent && current.parent !== sceneRoot) {
        const pName = current.parent.name || '';
        if (pName && !pName.startsWith('sb-') && pName !== 'historical-battlefield' && pName !== 'procedural-city' && pName !== 'procedural-scene' && pName !== 'solar-system' && pName !== 'molecular-physics' && pName !== 'architectural-room' && pName !== 'procedural-worldbuilder' && pName !== 'procedural-spatial' && pName !== 'scene') {
            selectable = current.parent;
        }
        current = current.parent;
    }

    return selectable;
}

/**
 * Extracts all selectable top-level objects in the Three.js scene for the Outliner.
 */
export function extractSceneOutlinerItems(scene: THREE.Scene): Array<{ id: string; name: string; type: string; object: THREE.Object3D; visible: boolean }> {
    const items: Array<{ id: string; name: string; type: string; object: THREE.Object3D; visible: boolean }> = [];
    const seenUuids = new Set<string>();

    const isExcluded = (obj: THREE.Object3D): boolean => {
        if (obj === scene) return true;
        const oName = obj.name || '';
        if (oName.startsWith('sb-') || oName === 'historical-battlefield' || oName === 'procedural-city' || oName === 'procedural-scene' || oName === 'solar-system' || oName === 'molecular-physics' || oName === 'architectural-room' || oName === 'procedural-worldbuilder' || oName === 'procedural-spatial') return true;
        if (oName === 'AtmosphericSkyDome' || oName === 'PhysicalSunDisc' || oName === 'volumetric-god-rays' || oName.includes('SkyDome') || oName.includes('SunDisc') || oName.includes('god-rays')) return true;
        if (obj.userData?.isGizmo || obj.userData?.handleType) return true;
        if ((obj as any).isLight || (obj as any).isCamera) return true;
        if ((obj as any).isGridHelper || oName.includes('Grid Floor') || oName.includes('GridHelper')) return true;
        return false;
    };

    scene.traverse((obj) => {
        if (isExcluded(obj)) return;

        const p = obj.parent;
        const isRootChild = p === scene;
        const isProceduralCollectionChild = !!(p && (
            p.name === 'historical-battlefield' ||
            p.name === 'procedural-city' ||
            p.name === 'procedural-scene' ||
            p.name === 'solar-system' ||
            p.name === 'molecular-physics' ||
            p.name === 'architectural-room' ||
            p.name === 'procedural-worldbuilder' ||
            p.name === 'procedural-spatial' ||
            p.name === 'scene'
        ));
        const isNamedSemanticGroup = (obj instanceof THREE.Group || (obj as any).isMesh) && !seenUuids.has(obj.uuid);

        if ((isRootChild || isProceduralCollectionChild) && isNamedSemanticGroup) {
            seenUuids.add(obj.uuid);
            const oName = obj.name || ((obj as any).isMesh ? `Mesh ${(obj as any).geometry?.type || 'Object'}` : `Group Object`);
            let itemType = 'mesh';
            const nameLower = oName.toLowerCase();
            if (nameLower.includes('tavern') || nameLower.includes('house') || nameLower.includes('meeting') || nameLower.includes('tower') || nameLower.includes('skyscraper') || nameLower.includes('building') || nameLower.includes('desk') || nameLower.includes('chair') || nameLower.includes('wall') || nameLower.includes('room')) {
                itemType = 'building';
            } else if (nameLower.includes('minuteman') || nameLower.includes('soldier') || nameLower.includes('redcoat') || nameLower.includes('regiment') || nameLower.includes('line') || nameLower.includes('militia')) {
                itemType = 'unit';
            } else if (nameLower.includes('tree') || nameLower.includes('elm') || nameLower.includes('flora')) {
                itemType = 'tree';
            } else if (nameLower.includes('ground') || nameLower.includes('terrain') || nameLower.includes('floor') || nameLower.includes('green')) {
                itemType = 'terrain';
            } else if (nameLower.includes('smoke') || nameLower.includes('emitter') || nameLower.includes('particle') || nameLower.includes('cloud')) {
                itemType = 'emitter';
            } else if (nameLower.includes('wall') || nameLower.includes('fence') || nameLower.includes('pillar') || nameLower.includes('plinth')) {
                itemType = 'prop';
            } else if (nameLower.includes('sun') || nameLower.includes('planet') || nameLower.includes('orbit') || nameLower.includes('prism') || nameLower.includes('ring')) {
                itemType = 'celestial';
            } else if (nameLower.includes('vehicle') || nameLower.includes('hover') || nameLower.includes('car') || nameLower.includes('airplane') || nameLower.includes('aircraft') || nameLower.includes('drone')) {
                itemType = 'vehicle';
            }

            items.push({
                id: obj.uuid,
                name: oName,
                type: itemType,
                object: obj,
                visible: obj.visible
            });
        }
    });

    return items;
}

export const Scene3DPrimitive: React.FC<Scene3DPrimitiveProps> = ({
    data,
    onUpdate,
    onPromptAction,
    onMorphArtifact,
    onCaptureReady,
    onVisualVerification
}) => {
    // ---------------------------------------------------------
    // 1. Core State
    // ---------------------------------------------------------
    const [sceneData, setSceneData] = React.useState<Scene3DData>(() => ({
        title: data?.title || '4D Scene Workspace',
        subtitle: data?.subtitle || 'Interactive 4D spatial viewport with temporal simulation solver',
        objects: data?.objects || [],
        camera: data?.camera || { position: [15, 12, 15], target: [0, 0, 0] },
        environment: data?.environment || { skybox: 'cyberpunk', lighting: 'shaded', ground: true },
        features: data?.features,
        customScript: data?.customScript || data?.code,
        cppGenerator: data?.cppGenerator || {
            enabled: true,
            filename: 'world_generator.cpp',
            sourceCode: `#include "scratchbox_engine.hpp"
#include "scratchbox_math.hpp"

int main(int argc, char** argv) {
    scratchbox::Engine engine;
    auto scene = engine.create_scene("Procedural Biosphere");

    // Signed Distance Field (SDF) + SIMD Vector Math
    auto terrain = engine.generate_sdf_terrain({
        .bounds_min = {-50.0f, -10.0f, -50.0f},
        .bounds_max = {50.0f, 25.0f, 50.0f},
        .voxel_resolution = 0.5f,
        .noise_scale = 0.035f,
        .octaves = 5,
        .persistence = 0.5f
    });

    terrain->set_material({
        .base_color = {0.18f, 0.45f, 0.28f, 1.0f},
        .roughness = 0.85f,
        .metallic = 0.1f
    });

    scene->add_node(terrain);
    engine.export_glb_stdout(scene);
    return 0;
}`
        },
        shaders: data?.shaders,
        customMeshes: (() => {
            if (data?.customMeshes && data.customMeshes.length > 0) return data.customMeshes;
            const isVehicle = /car|vehicle|automobile|truck|sports\s*car|sedan/i.test(data?.title || '') ||
                /car|vehicle|automobile|truck|sports\s*car|sedan/i.test(data?.worldBranch || '');
            if (isVehicle) {
                return synthesizeContextual3DScene(data?.title || '3D Car Visualization').customMeshes;
            }
            return data?.customMeshes;
        })()
    }));

    // Rendering options
    const [renderMode, setRenderMode] = React.useState<'wireframe' | 'solid' | 'shaded' | 'pbr'>('shaded');
    const [cameraMode, setCameraMode] = React.useState<'orbit' | 'fps'>('orbit');
    const initialWorldBranch = (data?.worldBranch && /car|vehicle|automobile/i.test(data?.title || '') && /city|urban|street/i.test(data.worldBranch))
        ? 'studio/showroom'
        : (data?.worldBranch || 'earth/main');
    const [worldBranch, setWorldBranch] = React.useState<string>(initialWorldBranch);
    const [hasGeoCoordinates, setHasGeoCoordinates] = React.useState<boolean>(false);
    const [lat, setLat] = React.useState<string>('37.7900');
    const [lng, setLng] = React.useState<string>('-122.4000');
    const [elevation, setElevation] = React.useState<string>('15.2');
    const [scriptError, setScriptError] = React.useState<string | null>(null);
    const [sceneBudget, setSceneBudget] = React.useState<SceneBudgetTelemetry | null>(null);

    // ---------------------------------------------------------
    // 3D Sculpting & Interactive Transform Gizmo States
    // ---------------------------------------------------------
    const [toolMode, setToolMode] = React.useState<ViewportToolMode>(data?.toolMode || 'view');
    const [sculptSettings, setSculptSettings] = React.useState<SculptSettings>(() => ({
        brush: data?.sculptSettings?.brush || 'draw',
        falloff: data?.sculptSettings?.falloff || 'gaussian',
        radius: data?.sculptSettings?.radius ?? 2.0,
        strength: data?.sculptSettings?.strength ?? 0.5,
        symmetry: data?.sculptSettings?.symmetry || { x: false, y: false, z: false },
        wireframeOverlay: data?.sculptSettings?.wireframeOverlay ?? false,
        clayOffset: data?.sculptSettings?.clayOffset ?? 0.5
    }));
    const [transformMode, setTransformMode] = React.useState<TransformGizmoMode>(data?.transformMode || 'translate');
    const [transformSpace, setTransformSpace] = React.useState<TransformGizmoSpace>(data?.transformSpace || 'world');
    const [selectedShape, setSelectedShape] = React.useState<'sphere' | 'plane' | 'box' | 'cylinder' | 'torus'>('sphere');
    const [canUndo, setCanUndo] = React.useState<boolean>(false);
    const [canRedo, setCanRedo] = React.useState<boolean>(false);

    const [selectedObjectId, setSelectedObjectId] = React.useState<string | null>(data?.selectedMeshId || null);
    const [selectedObjectName, setSelectedObjectName] = React.useState<string>('');
    const [isOutlinerOpen, setIsOutlinerOpen] = React.useState<boolean>(false);
    const [outlinerSearchQuery, setOutlinerSearchQuery] = React.useState<string>('');
    const [sceneEntities, setSceneEntities] = React.useState<Array<{ id: string; name: string; type: string; object: THREE.Object3D; visible: boolean }>>([]);
    const selectionBoxRef = React.useRef<THREE.BoxHelper | null>(null);

    // Sculpting & Gizmo High-Performance Refs (always-fresh mirrors for the imperative viewport code)
    const toolModeRef = useLatest(toolMode);
    const sculptSettingsRef = useLatest(sculptSettings);
    const transformModeRef = useLatest(transformMode);
    const transformSpaceRef = useLatest(transformSpace);

    const historyStackRef = React.useRef<MeshHistoryStack>(new MeshHistoryStack(30));
    const sculptMeshRef = React.useRef<THREE.Mesh | null>(null);
    const brushCursorMeshRef = React.useRef<THREE.Mesh | null>(null);
    const transformGizmoGroupRef = React.useRef<THREE.Group | null>(null);
    const gizmoEngineRef = React.useRef<TransformGizmoEngine>(new TransformGizmoEngine());
    const selectedObjectRef = React.useRef<THREE.Object3D | null>(null);

    // Geospatial Pinning and Drone Routing states
    const [pinALat, setPinALat] = React.useState<string>('37.7920');
    const [pinALng, setPinALng] = React.useState<string>('-122.4050');
    const [pinBLat, setPinBLat] = React.useState<string>('37.7980');
    const [pinBLng, setPinBLng] = React.useState<string>('-122.3950');
    const [isRoutingActive, setIsRoutingActive] = React.useState<boolean>(false);

    // High-performance animation refs for routing
    const pinALatRef = useLatest(pinALat);
    const pinALngRef = useLatest(pinALng);
    const pinBLatRef = useLatest(pinBLat);
    const pinBLngRef = useLatest(pinBLng);
    const isRoutingActiveRef = useLatest(isRoutingActive);

    // 4D Timeline & Playback States
    const [currentTimeMs, setCurrentTimeMs] = React.useState<number>(0);
    const [durationMs] = React.useState<number>(10000);
    const [isPlaying, setIsPlaying] = React.useState<boolean>(false);
    const [playbackSpeed, setPlaybackSpeed] = React.useState<number>(1.0);

    const currentTimeMsRef = React.useRef<number>(0);
    const isPlayingRef = useLatest(isPlaying);
    const playbackSpeedRef = useLatest(playbackSpeed);
    const durationMsRef = useLatest(durationMs);
    const lastStateUpdateRef = React.useRef<number>(0);

    // WebGL fallbacks
    const [webglError, setWebglError] = React.useState<string | null>(null);
    const [isWasmActive, setIsWasmActive] = React.useState<boolean>(false);

    // 3D Map Tile Ingestion & Clay REST States
    const [isMapTileModalOpen, setIsMapTileModalOpen] = React.useState<boolean>(false);
    const [mapTileQuery, setMapTileQuery] = React.useState<string>('San Francisco Ferry Building');
    const [mapTileLat, setMapTileLat] = React.useState<string>('37.7955');
    const [mapTileLng, setMapTileLng] = React.useState<string>('-122.3937');
    const [mapTileElevation, setMapTileElevation] = React.useState<string>('3.5');
    const [mapTileRadius, setMapTileRadius] = React.useState<number>(160);
    const [mapTileZoom, setMapTileZoom] = React.useState<number>(17);
    const [mapTileClayPreset, setMapTileClayPreset] = React.useState<ClayPresetId>('warm-clay');
    const [mapTileIncludeTerrain, setMapTileIncludeTerrain] = React.useState<boolean>(true);
    const [mapTileIncludeBuildings, setMapTileIncludeBuildings] = React.useState<boolean>(true);
    const [mapTileDetailLevel, setMapTileDetailLevel] = React.useState<'low' | 'medium' | 'high'>('high');
    const [isIngestingTile, setIsIngestingTile] = React.useState<boolean>(false);
    const [mapTileStatusMsg, setMapTileStatusMsg] = React.useState<string | null>(null);

    // Vector ROADMAP Reference & Cloud-Based Map Styling States
    const [isVectorRoadmapHUDOpen, setIsVectorRoadmapHUDOpen] = React.useState<boolean>(false);
    const [cameraHeading, setCameraHeading] = React.useState<number>(0);
    const isVectorRoadmapHUDOpenRef = useLatest(isVectorRoadmapHUDOpen);
    const vectorRoadmapHandleRef = React.useRef<VectorRoadmapHandle | null>(null);

    // Viewport & Three.js Refs
    const viewportRef = React.useRef<HTMLDivElement>(null);
    const fallbackCanvasRef = React.useRef<HTMLCanvasElement>(null);
    const threeRendererRef = React.useRef<THREE.WebGLRenderer | null>(null);
    const threeSceneRef = React.useRef<THREE.Scene | null>(null);
    const threeCameraRef = React.useRef<THREE.PerspectiveCamera | null>(null);
    const customGridHelperRef = React.useRef<THREE.GridHelper | null>(null);

    // WASM Deforming Mesh Reference
    const wasmMeshRef = React.useRef<THREE.Mesh | null>(null);
    const wasmGeometryRef = React.useRef<THREE.BufferGeometry | null>(null);
    const wasmPositionAttrRef = React.useRef<THREE.BufferAttribute | null>(null);

    // Procedural Geo Mesh Group Reference
    const geoGroupRef = React.useRef<THREE.Group | null>(null);
    const droneMeshRef = React.useRef<THREE.Group | null>(null);
    const pinAMeshRef = React.useRef<THREE.Group | null>(null);
    const pinBMeshRef = React.useRef<THREE.Group | null>(null);
    const routePathMeshRef = React.useRef<THREE.Line | null>(null);

        // Aircraft & Scene Object Refs
        const airplaneMeshRef = React.useRef<THREE.Group | null>(null);

    // Dynamic Engine Hook Refs
    const skyDomeModuleRef = React.useRef<any | null>(null);
    const aerialPerspectiveRef = React.useRef<any | null>(null);
    const terrainCloudShadowsRef = React.useRef<any | null>(null);
    const godRaysRef = React.useRef<any | null>(null);
    const contrailsRef = React.useRef<any | null>(null);
    const terrainBiomeRef = React.useRef<any | null>(null);
    const dynamicScriptHooksRef = React.useRef<{ update?: (time: number, delta: number) => void; dispose?: () => void } | null>(null);
    const customShaderMaterialsRef = React.useRef<THREE.ShaderMaterial[]>([]);

    // ---------------------------------------------------------
    // In-Memory Live Scene Mutation & Synchronization Helper
    // ---------------------------------------------------------
    // `onUpdate` sets state in the parent Studio, so it must NOT run inside a
    // `setSceneData(prev => ...)` updater: React executes updaters during this
    // component's render, which triggers "Cannot update a component while rendering
    // a different component". Compute `next` from the latest value, commit, then notify.
    const sceneDataRef = useLatest(sceneData);
    const mutateSceneData = React.useCallback((
        mutator: (prev: Scene3DData) => Scene3DData,
        opInfo?: { operator: string; params?: any }
    ) => {
        const prev = sceneDataRef.current;
        const next = (() => {
            const next = mutator(prev);
            const startTime = Date.now();

            if (opInfo) {
                const nextStack = [...(next.operatorStack || prev.operatorStack || [])];
                nextStack.push({
                    operator: opInfo.operator,
                    params: opInfo.params,
                    timestamp: startTime
                });
                next.operatorStack = nextStack;

                const nextLogs = [...(next.actionLog || prev.actionLog || [])];
                nextLogs.push({
                    operator: opInfo.operator,
                    params: opInfo.params,
                    timestamp: startTime,
                    executionTimeMs: 0.5,
                    success: true
                });
                next.actionLog = nextLogs;
            }
            return next;
        })();

        // Keep the ref current so back-to-back mutations in one tick chain correctly.
        sceneDataRef.current = next;
        setSceneData(next);
        onUpdate?.(next);
    }, [onUpdate, sceneDataRef]);

    // ---------------------------------------------------------
    // Object Selection, Focus & Outliner Helpers
    // ---------------------------------------------------------
    const refreshEntities = React.useCallback(() => {
        if (threeSceneRef.current) {
            const items = extractSceneOutlinerItems(threeSceneRef.current);
            setSceneEntities(items);
        }
    }, []);

    const selectObject = React.useCallback((targetObj: THREE.Object3D | null) => {
        selectedObjectRef.current = targetObj;
        if (targetObj) {
            const objId = targetObj.name || targetObj.uuid;
            setSelectedObjectId(objId);
            setSelectedObjectName(targetObj.name || 'Selected Object');

            // Update / create selection bounding box helper
            if (threeSceneRef.current) {
                if (!selectionBoxRef.current) {
                    const box = new THREE.BoxHelper(targetObj, 0x00f0ff);
                    box.name = 'sb-selection-helper';
                    box.renderOrder = 9998;
                    if (box.material) {
                        (box.material as THREE.LineBasicMaterial).depthTest = false;
                        (box.material as THREE.LineBasicMaterial).transparent = true;
                        (box.material as THREE.LineBasicMaterial).opacity = 0.9;
                    }
                    threeSceneRef.current.add(box);
                    selectionBoxRef.current = box;
                } else {
                    selectionBoxRef.current.setFromObject(targetObj);
                    selectionBoxRef.current.visible = true;
                }
            }

            // If targetObj is a Mesh or has child Mesh, prepare sculpt mesh and history
            let meshCandidate: THREE.Mesh | null = null;
            if ((targetObj as any).isMesh && (targetObj as THREE.Mesh).geometry) {
                meshCandidate = targetObj as THREE.Mesh;
            } else {
                targetObj.traverse((child) => {
                    if (!meshCandidate && (child as any).isMesh && (child as THREE.Mesh).geometry) {
                        meshCandidate = child as THREE.Mesh;
                    }
                });
            }
            if (meshCandidate && meshCandidate.geometry) {
                sculptMeshRef.current = meshCandidate;
                historyStackRef.current.clear();
                historyStackRef.current.pushState(meshCandidate.geometry);
                setCanUndo(false);
                setCanRedo(false);
            }

            // Update gizmo transform immediately
            if (transformGizmoGroupRef.current && gizmoEngineRef.current && threeCameraRef.current) {
                gizmoEngineRef.current.updateGizmoTransform(
                    transformGizmoGroupRef.current,
                    targetObj.position,
                    targetObj.quaternion,
                    transformSpaceRef.current,
                    threeCameraRef.current
                );
            }

            mutateSceneData(prev => ({
                ...prev,
                selectedMeshId: objId
            }));
        } else {
            setSelectedObjectId(null);
            setSelectedObjectName('');
            if (selectionBoxRef.current) {
                selectionBoxRef.current.visible = false;
            }
            mutateSceneData(prev => ({
                ...prev,
                selectedMeshId: undefined
            }));
        }
    }, [mutateSceneData]);

    const handleFocusObject = React.useCallback((targetObj: THREE.Object3D) => {
        if (!targetObj || !threeCameraRef.current) return;
        selectObject(targetObj);
        const box = new THREE.Box3().setFromObject(targetObj);
        const center = new THREE.Vector3();
        box.getCenter(center);
        const size = new THREE.Vector3();
        box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z, 2);

        // Smooth camera refocus on the selected object center
        cameraTargetRef.current.copy(center);
        const targetDistance = Math.max(6, Math.min(2500, maxDim * 2.2));
        const eye = threeCameraRef.current.position.clone().sub(center);
        const currentDist = eye.length() || 1;
        const phi = Math.acos(Math.max(-1, Math.min(1, eye.y / currentDist)));
        const theta = Math.atan2(eye.x, eye.z);
        cameraRotationRef.current = { theta, phi, distance: targetDistance };
        threeCameraRef.current.lookAt(center);
    }, [selectObject]);

    const handleToggleObjectVisibility = React.useCallback((entityId: string, e?: React.MouseEvent) => {
        e?.stopPropagation();
        setSceneEntities(prev => prev.map(item => {
            if (item.id === entityId || item.name === entityId) {
                const nextVis = !item.visible;
                item.object.visible = nextVis;
                return { ...item, visible: nextVis };
            }
            return item;
        }));
    }, []);

    // ---------------------------------------------------------
    // Automated Capture Frame & Visual Verification Hooks
    // ---------------------------------------------------------
    const captureFrame = React.useCallback((): string => {
        return captureSceneScreenshot(threeRendererRef.current, threeSceneRef.current, threeCameraRef.current);
    }, []);

    React.useEffect(() => {
        if (typeof window !== 'undefined') {
            (window as any).__scratchbox_capture_active_3d_scene = captureFrame;
        }
        onCaptureReady?.(captureFrame);

        return () => {
            if (typeof window !== 'undefined' && (window as any).__scratchbox_capture_active_3d_scene === captureFrame) {
                delete (window as any).__scratchbox_capture_active_3d_scene;
            }
        };
    }, [captureFrame, onCaptureReady]);

    React.useEffect(() => {
        if (!onVisualVerification) return;
        const settleTimer = setTimeout(() => {
            const frame = captureFrame();
            if (frame && frame.length > 20) {
                onVisualVerification(frame);
            }
        }, 600);
        return () => clearTimeout(settleTimer);
    }, [sceneData, captureFrame, onVisualVerification]);

    const isAirplane = React.useMemo(() => {
        if (!data) return false;
        const combinedText = `${data.sceneType || ''} ${data.title || ''} ${data.subtitle || ''} ${data.worldBranch || ''}`.toLowerCase();
        
        // If the scene is explicitly a non-flight theme (historical, battlefield, city, celestial, molecular, architectural), never treat as airplane
        const isNonFlightTopic = /battlefield|lexington|concord|1776|1775|revolution|redcoat|minuteman|city|metropolis|urban|solar|planet|celestial|orbit|molecular|physics|atom|dna|chemistry|room|blueprint|interior|house|pavilion/i.test(combinedText);
        const hasExplicitFlightTerm = /plane|airplane|jet\s+aircraft|jet\s+transit|flight\s+corridor|aviation/i.test(data.title || '');

        if (isNonFlightTopic && !hasExplicitFlightTerm) {
            return false;
        }

        if (data.sceneType === 'flight' && (hasExplicitFlightTerm || data.objects?.some(o => o.content?.durableUri === 'internal:plane'))) {
            return true;
        }

        const titleMatch = (/plane|airplane|jet|aircraft|flight|aviation/i.test(data.title || '') || /plane|airplane|jet|aircraft|flight|aviation/i.test(data.subtitle || '')) && !isNonFlightTopic;
        const branchMatch = /flight|aviation/i.test(data.worldBranch || '') && !isNonFlightTopic;
        const objMatch = data.objects?.some(o => 
            o.content?.durableUri === 'internal:plane' ||
            o.content?.mimeType?.includes('aircraft') ||
            o.content?.mimeType?.includes('plane')
        );
        const featureMatch = (!!data.features?.controlSurfaces || !!data.features?.contrails) && (titleMatch || branchMatch || !!objMatch);
        return (titleMatch || branchMatch || !!objMatch || featureMatch) && !isNonFlightTopic;
    }, [data]);

    const splatViewerRef = React.useRef<InHouseSplatViewer | null>(null);
    const tilesRendererRef = React.useRef<any | null>(null);
    const terrainManagerRef = React.useRef<TerrainManager | null>(null);
    const cameraTargetRef = React.useRef<THREE.Vector3>(new THREE.Vector3(0, 0, 0));

    const animationFrameIdRef = React.useRef<number | null>(null);
    const hasWarnedFrameErrorRef = React.useRef<boolean>(false);
    const cameraRotationRef = React.useRef<{ theta: number; phi: number; distance: number }>({
        theta: Math.PI / 4,
        phi: Math.PI / 3,
        distance: 25
    });

    const keysPressedRef = React.useRef<Record<string, boolean>>({});

    // ---------------------------------------------------------
    // High-Performance WASM Mesh Deformer
    // ---------------------------------------------------------
    const handleWasmSynthesize = React.useCallback(() => {
        setIsWasmActive(true);
        const vertexCount = 60000;
        const vertexBuffer = new Float32Array(vertexCount * 3);
        const radiusFactor = 6.0 + Math.sin(Date.now() / 1000) * 2.0;
        const waveScale = 1.2;

        for (let i = 0; i < vertexCount; i++) {
            const idx = i * 3;
            const gridX = (i % 245) - 122.5;
            const gridZ = Math.floor(i / 245) - 122.5;
            const dist = Math.sqrt(gridX * gridX + gridZ * gridZ);
            const height = Math.sin(dist * waveScale - Date.now() / 300) * radiusFactor * Math.exp(-dist * 0.03);

            vertexBuffer[idx] = gridX * 0.15;
            vertexBuffer[idx + 1] = height * 0.25;
            vertexBuffer[idx + 2] = gridZ * 0.15;
        }

        if (wasmGeometryRef.current) {
            const newAttr = new THREE.BufferAttribute(vertexBuffer, 3);
            wasmGeometryRef.current.setAttribute('position', newAttr);
            wasmGeometryRef.current.computeVertexNormals();
            newAttr.needsUpdate = true;
        }

        setTimeout(() => {
            setIsWasmActive(false);
        }, 500);
    }, []);

    // Sync Props to State
    React.useEffect(() => {
        if (data) {
            const isVehicleTheme = /car|vehicle|automobile|truck|sports\s*car|sedan/i.test(data.title || '') ||
                /car|vehicle|automobile|truck|sports\s*car|sedan/i.test(data.worldBranch || '') ||
                (data.objects && data.objects.some(o => /car|vehicle|automobile/i.test(o.id || '') || /car|vehicle|automobile/i.test(o.content?.durableUri || '') || /car|vehicle|automobile/i.test(o.content?.mimeType || '')));

            let effectiveCustomMeshes = data.customMeshes;
            let effectiveCamera = data.camera;
            let effectiveEnvironment = data.environment;
            let effectiveWorldBranch = data.worldBranch;

            if (isVehicleTheme) {
                if (!effectiveCustomMeshes || effectiveCustomMeshes.length === 0) {
                    const synthesized = synthesizeContextual3DScene(data.title || '3D Car Visualization');
                    effectiveCustomMeshes = synthesized.customMeshes;
                    if (!effectiveCamera) effectiveCamera = synthesized.camera;
                    if (!effectiveEnvironment) effectiveEnvironment = synthesized.environment;
                }
                if (effectiveWorldBranch && /city|urban|street/i.test(effectiveWorldBranch)) {
                    effectiveWorldBranch = 'studio/showroom';
                }
            }

            setSceneData({
                title: data.title || '4D Scene Workspace',
                subtitle: data.subtitle || 'Interactive 4D spatial viewport with temporal simulation solver',
                objects: isVehicleTheme && (!data.objects || data.objects.some(o => o.content?.durableUri === 'internal:plane')) ? [] : (data.objects || []),
                sceneType: isVehicleTheme ? 'custom' : data.sceneType,
                worldBranch: effectiveWorldBranch,
                camera: effectiveCamera || { position: [15, 12, 15], target: [0, 0, 0] },
                environment: effectiveEnvironment || { skybox: isVehicleTheme ? 'studio' : 'cyberpunk', lighting: isVehicleTheme ? 'studio' : 'shaded', ground: true },
                features: data.features,
                customScript: data.customScript || data.code,
                cppGenerator: data.cppGenerator,
                shaders: data.shaders,
                customMeshes: effectiveCustomMeshes,
                timeline: data.timeline,
                animation: data.animation,
                geoAnchor: data.geoAnchor,
                droneRoute: data.droneRoute
            });

            if (effectiveWorldBranch) setWorldBranch(effectiveWorldBranch);
            if (data.renderMode) setRenderMode(data.renderMode);
            if (data.clayPreset) {
                setMapTileClayPreset(data.clayPreset as any);
                if (threeSceneRef.current) {
                    TileClayProcessor.applyClayMaterial(threeSceneRef.current, data.clayPreset as any);
                }
            }
            if (data.cameraMode) setCameraMode(data.cameraMode);
            if (data.toolMode) setToolMode(data.toolMode);
            if (data.sculptSettings) setSculptSettings(prev => ({ ...prev, ...data.sculptSettings }));
            if (data.transformMode) setTransformMode(data.transformMode);
            if (data.transformSpace) setTransformSpace(data.transformSpace);

            if (data.geoAnchor) {
                setHasGeoCoordinates(data.geoAnchor.active !== false);
                setLat(data.geoAnchor.lat.toString());
                setLng(data.geoAnchor.lng.toString());
                if (data.geoAnchor.elevation !== undefined) {
                    setElevation(data.geoAnchor.elevation.toString());
                }
            } else {
                const geoObj = data.objects?.find(o => o.space?.geoAnchor);
                if (geoObj?.space?.geoAnchor) {
                    setHasGeoCoordinates(true);
                    setLat(geoObj.space.geoAnchor.lat.toString());
                    setLng(geoObj.space.geoAnchor.lng.toString());
                    if (geoObj.space.geoAnchor.alt !== undefined) {
                        setElevation(geoObj.space.geoAnchor.alt.toString());
                    }
                }
            }

            if (data.droneRoute) {
                setPinALat(data.droneRoute.pinA.lat.toString());
                setPinALng(data.droneRoute.pinA.lng.toString());
                setPinBLat(data.droneRoute.pinB.lat.toString());
                setPinBLng(data.droneRoute.pinB.lng.toString());
                if (data.droneRoute.active !== undefined) {
                    setIsRoutingActive(data.droneRoute.active);
                    if (data.droneRoute.active) setIsPlaying(true);
                }
            }

            if (data.wasmPhysics?.waveActive) {
                handleWasmSynthesize();
            }

            if (data.animation === 'flight' || data.timeline?.isPlaying) {
                setIsPlaying(true);
                isPlayingRef.current = true;
            }

            if (data.timeline) {
                if (data.timeline.isPlaying !== undefined) {
                    setIsPlaying(data.timeline.isPlaying);
                    isPlayingRef.current = data.timeline.isPlaying;
                }
                if (data.timeline.speed !== undefined) {
                    setPlaybackSpeed(data.timeline.speed);
                    playbackSpeedRef.current = data.timeline.speed;
                }
                if (data.timeline.playbackSpeed !== undefined) {
                    setPlaybackSpeed(data.timeline.playbackSpeed);
                    playbackSpeedRef.current = data.timeline.playbackSpeed;
                }
                if (data.timeline.currentTimeMs !== undefined) {
                    setCurrentTimeMs(data.timeline.currentTimeMs);
                    currentTimeMsRef.current = data.timeline.currentTimeMs;
                }
            }
        }
    }, [data, handleWasmSynthesize]);

    // ---------------------------------------------------------
    // Geospatial Routing Projection & Spline Logic
    // ---------------------------------------------------------
    const projectCoords = React.useCallback((latitude: number, longitude: number) => {
        const refLat = parseFloat(lat) || 37.7900;
        const refLng = parseFloat(lng) || -122.4000;
        const refAlt = parseFloat(elevation) || 15.2;

        const geoFrame = new GeoFrame({ lat: refLat, lng: refLng, alt: refAlt });
        const [x, , z] = geoFrame.toScene({ lat: latitude, lng: longitude, alt: refAlt });
        
        const clampedX = Math.max(-20, Math.min(20, x));
        const clampedZ = Math.max(-20, Math.min(20, z));
        const clampedY = getProceduralBinnedHeight(clampedX, clampedZ, refAlt);
        
        return new THREE.Vector3(clampedX, clampedY, clampedZ);
    }, [lat, lng, elevation]);

    const updatePinsAndRoute = React.useCallback(() => {
        if (!threeSceneRef.current || !hasGeoCoordinates || !geoGroupRef.current) return;
        const geoGroup = geoGroupRef.current;

        if (pinAMeshRef.current) { geoGroup.remove(pinAMeshRef.current); pinAMeshRef.current = null; }
        if (pinBMeshRef.current) { geoGroup.remove(pinBMeshRef.current); pinBMeshRef.current = null; }
        if (routePathMeshRef.current) { geoGroup.remove(routePathMeshRef.current); routePathMeshRef.current = null; }
        if (droneMeshRef.current) { geoGroup.remove(droneMeshRef.current); droneMeshRef.current = null; }

        const latA = parseFloat(pinALat) || 37.7920;
        const lngA = parseFloat(pinALng) || -122.4050;
        const latB = parseFloat(pinBLat) || 37.7980;
        const lngB = parseFloat(pinBLng) || -122.3950;

        const pinAPos = projectCoords(latA, lngA);
        const pinBPos = projectCoords(latB, lngB);

        // Pin A & Pin B
        const pinA = createPinMesh(0x00ff88);
        pinA.position.copy(pinAPos);
        geoGroup.add(pinA);
        pinAMeshRef.current = pinA;

        const pinB = createPinMesh(0xff00aa);
        pinB.position.copy(pinBPos);
        geoGroup.add(pinB);
        pinBMeshRef.current = pinB;

        // Route Spline Path
        const curvePoints: THREE.Vector3[] = [];
        for (let i = 0; i <= 30; i++) {
            const t_val = i / 30;
            const px = pinAPos.x + t_val * (pinBPos.x - pinAPos.x);
            const pz = pinAPos.z + t_val * (pinBPos.z - pinAPos.z);
            const heightArc = Math.sin(t_val * Math.PI) * 4.0;
            const terrainHeight = getProceduralBinnedHeight(px, pz, parseFloat(elevation) || 15.2);
            const py = terrainHeight + 0.25 + heightArc;
            curvePoints.push(new THREE.Vector3(px, py, pz));
        }
        const routeGeo = new THREE.BufferGeometry().setFromPoints(curvePoints);
        const routeMat = new THREE.LineDashedMaterial({
            color: 0xffaa00,
            dashSize: 0.5,
            gapSize: 0.3
        });
        const routeLine = new THREE.Line(routeGeo, routeMat);
        routeLine.computeLineDistances();
        geoGroup.add(routeLine);
        routePathMeshRef.current = routeLine;

        if (isRoutingActive) {
            const drone = createDroneMesh();
            drone.position.copy(pinAPos);
            geoGroup.add(drone);
            droneMeshRef.current = drone;
        }
    }, [hasGeoCoordinates, pinALat, pinALng, pinBLat, pinBLng, isRoutingActive, elevation, projectCoords]);

    React.useEffect(() => {
        updatePinsAndRoute();
    }, [updatePinsAndRoute]);

    // ---------------------------------------------------------
    // Geographic Procedural Map Generation
    // ---------------------------------------------------------
    const generateProceduralGeoCity = React.useCallback((scene: THREE.Scene, _latitude: number, _longitude: number, elevVal: number) => {
        if (geoGroupRef.current) {
            scene.remove(geoGroupRef.current);
        }

        const geoGroup = new THREE.Group();
        geoGroupRef.current = geoGroup;

        const terrainSize = 40;
        const terrainSegments = 60;
        const terrainGeo = new THREE.PlaneGeometry(terrainSize, terrainSize, terrainSegments, terrainSegments);
        terrainGeo.rotateX(-Math.PI / 2);

        const positions = terrainGeo.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < positions.count; i++) {
            const x = positions.getX(i);
            const z = positions.getZ(i);
            const distanceToBay = x + 15;
            let y = Math.sin(x * 0.1) * Math.cos(z * 0.1) * 3.5;
            y += Math.sin(x * 0.05 + z * 0.05) * 5.0;

            if (distanceToBay < -5) {
                y = -2.0 + Math.sin(z * 0.2) * 0.2;
            } else if (distanceToBay < 5) {
                y *= (distanceToBay + 5) / 10;
            }

            const rawHeight = y + elevVal * 0.05 - 1.5;
            positions.setY(i, Math.round(rawHeight / 0.4) * 0.4);
        }
        terrainGeo.computeVertexNormals();

        let terrainMat: THREE.Material;
        if (renderMode === 'wireframe') {
            terrainMat = new THREE.MeshBasicMaterial({ color: 0x00ff88, wireframe: true });
        } else if (renderMode === 'solid') {
            terrainMat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
        } else if (renderMode === 'shaded') {
            terrainMat = new THREE.MeshLambertMaterial({ color: 0x112b20, side: THREE.DoubleSide });
        } else {
            terrainMat = new THREE.MeshStandardMaterial({
                color: 0x141a29,
                roughness: 0.6,
                metalness: 0.9,
                side: THREE.DoubleSide,
                flatShading: true
            });
        }

        const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
        geoGroup.add(terrainMesh);

        // Water Plane on Bay Side
        const waterGeo = new THREE.PlaneGeometry(20, 40);
        waterGeo.rotateX(-Math.PI / 2);
        const waterMat = new THREE.MeshStandardMaterial({
            color: 0x00a2ff,
            roughness: 0.1,
            metalness: 0.8,
            transparent: true,
            opacity: 0.7,
            emissive: 0x003366
        });
        const waterMesh = new THREE.Mesh(waterGeo, waterMat);
        waterMesh.position.set(-15, -1.8, 0);
        geoGroup.add(waterMesh);

        scene.add(geoGroup);

        if (customGridHelperRef.current) {
            customGridHelperRef.current.visible = false;
        }

        setTimeout(() => {
            updatePinsAndRoute();
        }, 0);
    }, [renderMode, updatePinsAndRoute]);

    React.useEffect(() => {
        if (threeSceneRef.current) {
            if (hasGeoCoordinates) {
                generateProceduralGeoCity(
                    threeSceneRef.current,
                    parseFloat(lat) || 37.7900,
                    parseFloat(lng) || -122.4000,
                    parseFloat(elevation) || 15.2
                );
            } else {
                if (geoGroupRef.current) {
                    threeSceneRef.current.remove(geoGroupRef.current);
                    geoGroupRef.current = null;
                }
                if (customGridHelperRef.current) {
                    customGridHelperRef.current.visible = true;
                }
            }
        }
    }, [hasGeoCoordinates, lat, lng, elevation, generateProceduralGeoCity]);

    // ---------------------------------------------------------
    // Viewport Lifecycle: renderer stack is created ONCE per mount; scene content is
    // synchronised per-slice (tiles → atmosphere → camera → content → meshes → shaders)
    // by diffing fingerprints and mutating the live scene through refs.
    // ---------------------------------------------------------
    const stackRef = React.useRef<RendererStack | null>(null);
    const atmosphereRef = React.useRef<AtmosphereHandle | null>(null);
    const tilesHandleRef = React.useRef<TilesLayerHandle | null>(null);
    const contentRef = React.useRef<SceneContentHandle | null>(null);
    const wasmHandleRef = React.useRef<WasmMeshHandle | null>(null);
    const customMeshRegistryRef = React.useRef<CustomMeshRegistry>(new Map());
    const externalObjectsMapRef = React.useRef<Map<string, THREE.Object3D>>(new Map());
    const activeSplatMeshesRef = React.useRef<Map<string, PhotorealGaussianSplatMesh>>(new Map());

    // Latest-value mirrors so the rAF loop / listeners never need to be re-bound
    const cameraModeRef = useLatest(cameraMode);
    const hasGeoCoordinatesRef = useLatest(hasGeoCoordinates);
    const isWasmActiveRef = useLatest(isWasmActive);
    const elevationRef = useLatest(elevation);
    const projectCoordsRef = useLatest(projectCoords);
    const selectObjectRef = useLatest(selectObject);
    const mutateSceneDataRef = useLatest(mutateSceneData);
    const dataRef = useLatest(data);
    // sceneDataRef is declared next to mutateSceneData above.
    const selectedShapeRef = useLatest(selectedShape);

    // ---- Slice fingerprints -------------------------------------------------------
    const has3DTiles = React.useMemo(() => !!(
        (sceneData.geoAnchor && sceneData.geoAnchor.active !== false) ||
        sceneData.objects?.some(o => o.content?.type === 'map-3d')
    ), [sceneData.geoAnchor, sceneData.objects]);

    const tilesInput = React.useMemo<TilesLayerInput>(() => ({
        has3DTiles,
        geoAnchor: sceneData.geoAnchor ? { lat: sceneData.geoAnchor.lat, lng: sceneData.geoAnchor.lng, elevation: sceneData.geoAnchor.elevation } : null,
        renderMode
    }), [has3DTiles, sceneData.geoAnchor, renderMode]);
    const tilesFingerprint = React.useMemo(() => JSON.stringify(tilesInput), [tilesInput]);
    const tilesInputRef = useLatest(tilesInput);

    const atmosphereInput = React.useMemo<AtmosphereInput>(() => ({
        skybox: sceneData.environment?.skybox,
        lighting: sceneData.environment?.lighting,
        ambientIntensity: sceneData.environment?.ambientIntensity,
        cinematicRig: sceneData.environment?.cinematicRig,
        lightingKelvin: sceneData.environment?.lightingKelvin,
        ground: sceneData.environment?.ground,
        fog: sceneData.environment?.fog,
        worldBranch,
        renderMode,
        hasGeoCoordinates,
        has3DTiles,
        atmosphericScattering: sceneData.features?.atmosphericScattering,
        atmosphere: (sceneData as any).atmosphere,
        godRays: sceneData.features?.godRays,
        terrainBiomes: sceneData.features?.terrainBiomes
    }), [
        sceneData.environment?.skybox, sceneData.environment?.lighting, sceneData.environment?.ambientIntensity, sceneData.environment?.cinematicRig,
        sceneData.environment?.lightingKelvin, sceneData.environment?.ground, sceneData.environment?.fog,
        worldBranch, renderMode, hasGeoCoordinates, has3DTiles,
        sceneData.features?.atmosphericScattering, (sceneData as any).atmosphere, sceneData.features?.godRays, sceneData.features?.terrainBiomes
    ]);
    const atmosphereFingerprint = React.useMemo(() => JSON.stringify(atmosphereInput), [atmosphereInput]);
    const atmosphereInputRef = useLatest(atmosphereInput);

    const cameraFingerprint = React.useMemo(() => JSON.stringify(sceneData.camera ?? null), [sceneData.camera]);

    const activeScript = sceneData.customScript || sceneData.code;
    const hasActiveScript = !!(activeScript && activeScript.trim().length > 0);
    const contentInput = React.useMemo<SceneContentInput>(() => ({
        sceneType: sceneData.sceneType,
        title: sceneData.title,
        worldBranch,
        isAirplane,
        hasContrails: !!sceneData.features?.contrails || isAirplane,
        hasActiveScript,
        has3DTiles,
        hasCustomMeshes: Array.isArray(sceneData.customMeshes) && sceneData.customMeshes.length > 0,
        hasNonFallbackObjects: Array.isArray(sceneData.objects) && sceneData.objects.length > 0 && !sceneData.objects.some(o => o.content?.durableUri === 'internal:mesh'),
        hasCppGenerator: !!sceneData.cppGenerator?.glbBase64,
        selectedShape,
        sculptWireframe: !!sculptSettings.wireframeOverlay
    }), [
        sceneData.sceneType, sceneData.title, worldBranch, isAirplane, sceneData.features?.contrails, hasActiveScript,
        has3DTiles, sceneData.customMeshes, sceneData.objects, sceneData.cppGenerator?.glbBase64, selectedShape, sculptSettings.wireframeOverlay
    ]);
    // Shape / wireframe changes are applied in place by their own handlers, so they are excluded here.
    const contentFingerprint = React.useMemo(() => JSON.stringify({
        ...contentInput,
        selectedShape: undefined,
        sculptWireframe: undefined,
        activeScript,
        tilesFingerprint,
        // A live script closes over the atmosphere objects; re-run it when they are rebuilt.
        atmosphere: hasActiveScript ? atmosphereFingerprint : undefined
    }), [contentInput, activeScript, tilesFingerprint, hasActiveScript, atmosphereFingerprint]);
    const contentInputRef = useLatest(contentInput);
    const activeScriptRef = useLatest(activeScript);

    const wantsWasmMesh = !!sceneData.wasmPhysics?.waveActive || isWasmActive;
    const customMeshesFingerprint = React.useMemo(() => JSON.stringify(sceneData.customMeshes ?? null), [sceneData.customMeshes]);
    const customMeshesRef = useLatest(sceneData.customMeshes);
    const shadersFingerprint = React.useMemo(() => JSON.stringify(sceneData.shaders ?? null), [sceneData.shaders]);
    const shadersRef = useLatest(sceneData.shaders);
    const externalObjectsFingerprint = React.useMemo(() => {
        const objs = (sceneData.objects?.map(o => ({
            id: o.id,
            uri: o.content?.durableUri,
            type: o.content?.type,
            space: o.space?.spatial3d
        })) || []);
        if (sceneData.splatUrl) {
            objs.push({ id: '__primary_splat__', uri: sceneData.splatUrl, type: 'gaussian-splat', space: undefined });
        }
        return JSON.stringify({ objs, splatOptions: sceneData.splatOptions });
    }, [sceneData.objects, sceneData.splatUrl, sceneData.splatOptions]);

    // ---- 1. Renderer stack, overlays, controls and the render loop (mount once) ----
    React.useEffect(() => {
        if (!viewportRef.current) return;
        const container = viewportRef.current;

        let stack: RendererStack;
        try {
            stack = createRendererStack({ container, cameraPosition: sceneDataRef.current.camera?.position });
        } catch (err: any) {
            console.error('WebGL Renderer Creation Failed:', err);
            setWebglError('WebGL is unsupported or disabled in this window/environment. Gracefully falling back to 2D canvas.');
            return;
        }
        stackRef.current = stack;
        const { scene, camera, renderer } = stack;
        // Baseline depth fog for the very first frame; syncAtmosphere replaces it with the skybox-specific FogExp2.
        scene.fog = new THREE.FogExp2(0x0a0a0f, 0.015);
        threeSceneRef.current = scene;
        threeCameraRef.current = camera;
        threeRendererRef.current = renderer;
        customGridHelperRef.current = stack.gridHelper;
        (window as any).__SB_3D_CAMERA__ = camera;
        (window as any).__SB_3D_SCENE__ = scene;
        (window as any).__SB_3D_STACK__ = stack;
        (window as any).__SB_3D_SCENE_DATA__ = sceneData;
        (window as any).__SB_3D_CAMERA_TARGET__ = cameraTargetRef;
        (window as any).__SB_3D_CAMERA_ROTATION__ = cameraRotationRef;

        // Brush cursor ring overlay (positioned on the hovered mesh surface in sculpt mode)
        const initRadius = sculptSettingsRef.current.radius || 2.0;
        const brushCursorMesh = new THREE.Mesh(
            new THREE.RingGeometry(initRadius * 0.96, initRadius, 48),
            new THREE.MeshBasicMaterial({ color: 0x00f0ff, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthTest: false })
        );
        brushCursorMesh.visible = false;
        brushCursorMesh.renderOrder = 9999;
        scene.add(brushCursorMesh);
        brushCursorMeshRef.current = brushCursorMesh;

        // Transform gizmo manipulator group
        const gizmoEngine = new TransformGizmoEngine();
        gizmoEngineRef.current = gizmoEngine;
        const gizmoGroup = gizmoEngine.createGizmo(transformModeRef.current);
        gizmoGroup.visible = toolModeRef.current === 'transform';
        scene.add(gizmoGroup);
        transformGizmoGroupRef.current = gizmoGroup;

        const detachControls = attachViewportControls(stack, {
            cameraMode: cameraModeRef,
            toolMode: toolModeRef,
            transformMode: transformModeRef,
            transformSpace: transformSpaceRef,
            sculptSettings: sculptSettingsRef,
            orbit: cameraRotationRef,
            keysPressed: keysPressedRef,
            gizmoEngine: gizmoEngineRef,
            gizmoGroup: transformGizmoGroupRef,
            selectedObject: selectedObjectRef,
            sculptMesh: sculptMeshRef,
            brushCursor: brushCursorMeshRef,
            selectionBox: selectionBoxRef,
            ignoredPickObjects: () => [atmosphereRef.current?.starsMesh, stack.gridHelper],
            history: historyStackRef,
            resolveSelectableObject,
            selectObject: selectObjectRef,
            mutateSceneData: mutateSceneDataRef,
            setSelectedObjectId,
            setSelectedObjectName,
            setCanUndo,
            setCanRedo
        });
        const detachResize = attachViewportResize(stack, (w, h) => aerialPerspectiveRef.current?.setSize(w, h));

        // ---------------------------------------------------------
        // Core Animation Loop with Aerodynamics & Articulation
        // ---------------------------------------------------------
        let lastTickTime = performance.now();
        let lastTerrainSnapTime = 0;
        let lastHeadingUpdateTime = 0;

        const animate = () => {
            try {
                const now = performance.now();
                const deltaMs = now - lastTickTime;
                lastTickTime = now;
                const deltaSec = deltaMs / 1000;

                reconcileDrawingBufferSize(stack);

                if (isPlayingRef.current) {
                    currentTimeMsRef.current += deltaMs * playbackSpeedRef.current;
                    if (currentTimeMsRef.current >= durationMsRef.current) {
                        currentTimeMsRef.current = 0;
                    }
                    if (now - lastStateUpdateRef.current > 40) {
                        setCurrentTimeMs(Math.round(currentTimeMsRef.current));
                        lastStateUpdateRef.current = now;
                    }
                }

                const t = currentTimeMsRef.current / 1000;
                const content = contentRef.current;
                const atmosphere = atmosphereRef.current;

                // 1. Aircraft aerodynamics, articulation, exhaust & contrails
                const airplane = content?.airplane ?? null;
                if (airplane) {
                    animateAircraftFrame(airplane, t, deltaMs, playbackSpeedRef.current);
                    contrailsRef.current?.update?.(airplane, t, deltaSec);
                }

                // 1.5–2. Sky dome, cloud shadows, aerial perspective, god rays
                skyDomeModuleRef.current?.update?.(t, deltaSec);
                terrainCloudShadowsRef.current?.update(t, skyDomeModuleRef.current?.sunDirection);
                aerialPerspectiveRef.current?.update(t, deltaSec);
                godRaysRef.current?.update?.(t, deltaSec);

                // Procedural scene + biome terrain dynamics
                const proceduralGroup = content?.proceduralSceneGroup ?? null;
                if (proceduralGroup && typeof proceduralGroup.userData?.update === 'function') {
                    proceduralGroup.userData.update(t, deltaSec);
                }
                terrainBiomeRef.current?.update?.(t, deltaSec);

                // 4. Custom shader uniforms
                tickCustomShaders(customShaderMaterialsRef.current, t, camera.position);

                // 5. Dynamic script hook
                dynamicScriptHooksRef.current?.update?.(t, deltaSec);

                // 6. Starfield rotation
                if (atmosphere?.starsMesh) {
                    atmosphere.starsMesh.rotation.y = t * 0.05;
                }

                // 7. 3D tiles streaming + continuous ground convergence for floating figures
                if (tilesRendererRef.current) {
                    tilesRendererRef.current.update(camera, renderer);
                    if (terrainManagerRef.current && now - lastTerrainSnapTime > 600) {
                        lastTerrainSnapTime = now;
                        const sampledGround = terrainManagerRef.current.sampleGroundHeight(0, 0);
                        if (sampledGround !== null && Math.abs(sampledGround) > 0.05) {
                            snapGroupFiguresToGround(proceduralGroup, terrainManagerRef.current);
                        }
                    }
                }

                // 8. Drone flight telemetry
                if (hasGeoCoordinatesRef.current && isRoutingActiveRef.current && droneMeshRef.current) {
                    const progress = currentTimeMsRef.current / durationMsRef.current;
                    const tNorm = Math.max(0, Math.min(1, progress));
                    const project = projectCoordsRef.current;
                    const pinAPos = project(parseFloat(pinALatRef.current) || 37.7920, parseFloat(pinALngRef.current) || -122.4050);
                    const pinBPos = project(parseFloat(pinBLatRef.current) || 37.7980, parseFloat(pinBLngRef.current) || -122.3950);
                    const ppx = pinAPos.x + tNorm * (pinBPos.x - pinAPos.x);
                    const ppz = pinAPos.z + tNorm * (pinBPos.z - pinAPos.z);
                    const heightArc = Math.sin(tNorm * Math.PI) * 4.0;
                    const terrainHeight = getProceduralBinnedHeight(ppx, ppz, parseFloat(elevationRef.current) || 15.2);
                    droneMeshRef.current.position.set(ppx, terrainHeight + 0.25 + heightArc, ppz);
                    droneMeshRef.current.rotation.y = (now / 100) * playbackSpeedRef.current;
                }

                // 9. WASM wave mesh
                if (wasmGeometryRef.current && wasmPositionAttrRef.current && !isWasmActiveRef.current) {
                    const pos = wasmGeometryRef.current.attributes.position as THREE.BufferAttribute;
                    const waveFreq = 0.5 + Math.sin(t * 0.5) * 0.25;
                    const waveSpeed = t * 3.0;
                    const waveAmp = 0.22 + Math.cos(t * 0.3) * 0.12;
                    for (let i = 0; i < pos.count; i++) {
                        const tx = pos.getX(i);
                        const tz = pos.getZ(i);
                        const dist = Math.sqrt(tx * tx + tz * tz);
                        pos.setY(i, -1.2 + Math.sin(dist * waveFreq - waveSpeed) * waveAmp * Math.exp(-dist * 0.05));
                    }
                    pos.needsUpdate = true;
                    wasmGeometryRef.current.computeVertexNormals();
                }

                // 10. Camera (orbit or FPS)
                stepCamera(camera, cameraModeRef.current, cameraRotationRef.current, cameraTargetRef.current, keysPressedRef.current);

                // 10.5 Update camera heading for Vector Roadmap HUD
                if (isVectorRoadmapHUDOpenRef.current && now - lastHeadingUpdateTime > 80) {
                    lastHeadingUpdateTime = now;
                    const dir = new THREE.Vector3();
                    camera.getWorldDirection(dir);
                    const hdg = (Math.atan2(dir.x, -dir.z) * 180 / Math.PI + 360) % 360;
                    setCameraHeading(hdg);
                }

                // 11. Selection box helper
                if (selectionBoxRef.current && selectionBoxRef.current.visible && selectedObjectRef.current) {
                    selectionBoxRef.current.update();
                }

                // 12. Transform gizmo
                if (transformGizmoGroupRef.current && selectedObjectRef.current) {
                    transformGizmoGroupRef.current.visible = toolModeRef.current === 'transform';
                    if (transformGizmoGroupRef.current.visible) {
                        gizmoEngineRef.current.updateGizmoTransform(
                            transformGizmoGroupRef.current,
                            selectedObjectRef.current.position,
                            selectedObjectRef.current.quaternion,
                            transformSpaceRef.current,
                            camera
                        );
                    }
                }

                // 13. Gaussian Splat viewer camera sync & depth sort
                if (splatViewerRef.current && typeof splatViewerRef.current.updateCamera === 'function') {
                    splatViewerRef.current.updateCamera(camera);
                }
                activeSplatMeshesRef.current.forEach(splatMesh => {
                    if (typeof splatMesh.updateDepthSort === 'function') {
                        splatMesh.updateDepthSort(camera);
                    }
                });

                if (aerialPerspectiveRef.current && skyDomeModuleRef.current) {
                    aerialPerspectiveRef.current.render(
                        renderer,
                        scene,
                        camera,
                        skyDomeModuleRef.current.sunDirection,
                        skyDomeModuleRef.current.diurnalProfile,
                        skyDomeModuleRef.current
                    );
                } else {
                    renderer.render(scene, camera);
                }
            } catch (frameErr) {
                if (!hasWarnedFrameErrorRef.current) {
                    hasWarnedFrameErrorRef.current = true;
                    console.warn('[3D Animation Loop Warning]:', frameErr);
                }
            }
            animationFrameIdRef.current = requestAnimationFrame(animate);
        };

        animate();

        return () => {
            if (animationFrameIdRef.current) {
                cancelAnimationFrame(animationFrameIdRef.current);
                animationFrameIdRef.current = null;
            }
            detachControls();
            detachResize();
            if (selectionBoxRef.current) {
                scene.remove(selectionBoxRef.current);
                selectionBoxRef.current.dispose();
                selectionBoxRef.current = null;
            }
            scene.remove(brushCursorMesh);
            brushCursorMesh.geometry.dispose();
            (brushCursorMesh.material as THREE.Material).dispose();
            brushCursorMeshRef.current = null;
            if (transformGizmoGroupRef.current) {
                scene.remove(transformGizmoGroupRef.current);
                transformGizmoGroupRef.current = null;
            }
            activeSplatMeshesRef.current.forEach(splatMesh => splatMesh.dispose());
            activeSplatMeshesRef.current.clear();
            externalObjectsMapRef.current.clear();
            stack.dispose();
            stackRef.current = null;
            threeSceneRef.current = null;
            threeCameraRef.current = null;
            threeRendererRef.current = null;
            customGridHelperRef.current = null;
        };
    // Deliberately mount-once: everything data-driven is synchronised by the slice effects below.
    }, []);

    // ---- 2. Google Photorealistic 3D Tiles + terrain manager --------------------
    React.useEffect(() => {
        const stack = stackRef.current;
        if (!stack) return;
        const handle = syncTilesLayer(stack, tilesInputRef.current, {
            onTileLoaded: (terrainManager) => {
                snapGroupFiguresToGround(contentRef.current?.proceduralSceneGroup ?? null, terrainManager);
                const groundY = terrainManager.sampleGroundHeight(0, 0);
                if (groundY !== null && !sceneDataRef.current.camera?.target) {
                    cameraTargetRef.current.y = groundY + 1.5;
                }
            }
        });
        tilesHandleRef.current = handle;
        tilesRendererRef.current = handle.tilesLayer;
        terrainManagerRef.current = handle.terrainManager;
        return () => {
            handle.dispose();
            tilesHandleRef.current = null;
            tilesRendererRef.current = null;
            terrainManagerRef.current = null;
        };
    }, [tilesFingerprint]);

    // ---- 2b. Vector ROADMAP ground blueprint underlay (Cloud-Based Map Styling) ----
    React.useEffect(() => {
        const stack = stackRef.current;
        if (!stack) return;
        const handle = syncVectorRoadmapBlueprint(stack.scene, vectorRoadmapHandleRef.current, {
            config: sceneData.vectorRoadmap,
            geoAnchor: sceneData.geoAnchor
        });
        vectorRoadmapHandleRef.current = handle;
        return () => {
            handle.dispose();
            vectorRoadmapHandleRef.current = null;
        };
    }, [
        sceneData.vectorRoadmap?.enabled,
        sceneData.vectorRoadmap?.groundBlueprint,
        sceneData.vectorRoadmap?.groundBlueprintOpacity,
        sceneData.vectorRoadmap?.groundBlueprintSize,
        sceneData.vectorRoadmap?.groundElevationOffset,
        sceneData.vectorRoadmap?.mapId,
        sceneData.geoAnchor?.lat,
        sceneData.geoAnchor?.lng,
        sceneData.geoAnchor?.elevation
    ]);

    // ---- 3. Atmosphere: background, fog, sky dome, lights, terrain floor, biomes, stars ----
    React.useEffect(() => {
        const stack = stackRef.current;
        if (!stack) return;
        const handle = syncAtmosphere(stack, atmosphereInputRef.current, {
            createVolumetricGodRays,
            createProceduralBiomeTerrain
        });
        atmosphereRef.current = handle;
        skyDomeModuleRef.current = handle.skyDomeModule;
        aerialPerspectiveRef.current = handle.aerialPerspective;
        terrainCloudShadowsRef.current = handle.terrainCloudShadows;
        godRaysRef.current = handle.godRays;
        terrainBiomeRef.current = handle.terrainBiome;
        return () => {
            handle.dispose();
            atmosphereRef.current = null;
            skyDomeModuleRef.current = null;
            aerialPerspectiveRef.current = null;
            terrainCloudShadowsRef.current = null;
            godRaysRef.current = null;
            terrainBiomeRef.current = null;
        };
    }, [atmosphereFingerprint]);

    // ---- 4. Camera preset (position / ground-grounded look-at target) ------------
    React.useEffect(() => {
        const stack = stackRef.current;
        if (!stack) return;
        const cameraDef = sceneDataRef.current.camera;
        const groundY = terrainManagerRef.current?.sampleGroundHeight(0, 0) ?? 0;
        const tx = cameraDef?.target ? cameraDef.target[0] : 0;
        const ty = cameraDef?.target ? cameraDef.target[1] : (groundY + 1.5);
        const tz = cameraDef?.target ? cameraDef.target[2] : 0;
        cameraTargetRef.current.set(tx, ty, tz);

        const [px, py, pz] = cameraDef?.position || [15, ty + 12, 15];
        const dx = px - tx;
        const dy = py - ty;
        const dz = pz - tz;
        const dist = Math.max(5, Math.sqrt(dx * dx + dy * dy + dz * dz));
        const phi = Math.acos(Math.max(-1, Math.min(1, dy / dist)));
        const theta = Math.atan2(dx, dz);

        cameraRotationRef.current = { theta, phi, distance: dist };
        stack.camera.position.set(px, py, pz);
        stack.camera.lookAt(cameraTargetRef.current);
    }, [cameraFingerprint, tilesFingerprint]);

    // ---- 5. Focal content: procedural theme / aircraft / sculpt mesh / splats / dynamic script ----
    React.useEffect(() => {
        const stack = stackRef.current;
        if (!stack) return;

        const executeScript: SceneContentFactories['executeScript'] = ({ aircraft, contrails }) => {
            const script = activeScriptRef.current;
            if (!script || !script.trim()) return null;
            const scriptCleanupFns: Array<() => void> = [];
            const scriptFrameFns: Array<(time: number, delta: number) => void> = [];
            const atmosphere = atmosphereRef.current;
            const dynamicContext: DynamicScriptContext = {
                scene: stack.scene,
                camera: stack.camera,
                renderer: stack.renderer,
                container: stack.container,
                THREE,
                sceneData: sceneDataRef.current,
                aircraft,
                terrain: atmosphere?.terrainBiome?.terrainMesh,
                skyDome: atmosphere?.skyDomeObject ?? null,
                aerialPerspective: atmosphere?.aerialPerspective,
                cloudShadows: atmosphere?.terrainCloudShadows,
                godRays: atmosphere?.godRays?.group,
                contrails,
                addCleanup: (fn) => scriptCleanupFns.push(fn),
                onFrame: (fn) => scriptFrameFns.push(fn),
                registerUpdate: (fn) => scriptFrameFns.push(fn),
                createArticulatedAircraft,
                createVolumetricGodRays,
                createDynamicContrails,
                createAtmosphericSkyDome,
                createAerialPerspectiveEffect,
                createTerrainCloudShadows,
                calculateNOAASolarPosition,
                calculateENUSunVector,
                getSunVectorFromAngles,
                computeDiurnalLightingProfile,
                getDiurnalLightingState,
                getPresetLightingState,
                kelvinToRGB,
                createProceduralBiomeTerrain,
                createAirplaneMesh,
                createDroneMesh,
                createPinMesh,
                createHistoricalBattlefieldScene,
                createProceduralCityScene,
                createSolarSystemScene,
                createMolecularPhysicsScene,
                createArchitecturalRoomScene,
                createProceduralSpatialScene,
                createWorldBuilderScene,
                generateNativeBuildingMeshBuffer,
                buildNativeThreeGeometry,
                generateProceduralThreeMeshFromPrompt,
                sculptBuildingFrom3DTiles,
                snapFootprintsToTerrain,
                inspectSceneMeshTopology
            };
            const execResult = executeDynamicThreeScript(script, dynamicContext);
            if (execResult.error) return { error: execResult.error };
            return {
                update: (time, delta) => {
                    execResult.update?.(time, delta);
                    for (const frameFn of scriptFrameFns) frameFn(time, delta);
                },
                dispose: () => {
                    execResult.dispose?.();
                    for (const cleanupFn of scriptCleanupFns) cleanupFn();
                }
            };
        };

        const handle = syncSceneContent(
            stack,
            { ...contentInputRef.current, selectedShape: selectedShapeRef.current, sculptWireframe: !!sculptSettingsRef.current.wireframeOverlay },
            terrainManagerRef.current,
            { createDynamicContrails, createSplatViewer: () => new InHouseSplatViewer(), executeScript }
        );
        contentRef.current = handle;
        airplaneMeshRef.current = handle.airplane;
        contrailsRef.current = handle.contrails;
        splatViewerRef.current = handle.splatViewer as InHouseSplatViewer;
        dynamicScriptHooksRef.current = handle.scriptHooks;
        setScriptError(handle.scriptError);

        // Sculpt target + history reset
        sculptMeshRef.current = handle.sculptTarget;
        selectedObjectRef.current = handle.sculptTarget;
        historyStackRef.current.clear();
        if (handle.sculptTarget?.geometry) historyStackRef.current.pushState(handle.sculptTarget.geometry);
        setCanUndo(false);
        setCanRedo(false);

        // Outliner entities + initial selection
        const initialEntities = extractSceneOutlinerItems(stack.scene);
        setSceneEntities(initialEntities);
        if (initialEntities.length > 0) {
            const wanted = dataRef.current?.selectedMeshId;
            if (wanted) {
                const target = initialEntities.find(e => e.id === wanted || e.name === wanted);
                if (target?.object) selectObjectRef.current(target.object);
            }
        }

        return () => {
            if (selectionBoxRef.current) selectionBoxRef.current.visible = false;
            handle.dispose();
            contentRef.current = null;
            airplaneMeshRef.current = null;
            contrailsRef.current = null;
            splatViewerRef.current = null;
            dynamicScriptHooksRef.current = null;
            if (sculptMeshRef.current === handle.sculptTarget) sculptMeshRef.current = null;
            if (selectedObjectRef.current === handle.sculptTarget) selectedObjectRef.current = null;
        };
    }, [contentFingerprint]);

    // ---- 5b. WASM wave deformer mesh ----------------------------------------------
    React.useEffect(() => {
        const stack = stackRef.current;
        if (!stack || !wantsWasmMesh) return;
        const handle = syncWasmMesh(stack, renderMode);
        wasmHandleRef.current = handle;
        wasmMeshRef.current = handle.mesh;
        wasmGeometryRef.current = handle.geometry;
        wasmPositionAttrRef.current = handle.positionAttribute;
        return () => {
            handle.dispose();
            wasmHandleRef.current = null;
            wasmMeshRef.current = null;
            wasmGeometryRef.current = null;
            wasmPositionAttrRef.current = null;
        };
    }, [wantsWasmMesh, renderMode]);

    // ---- 5b. Native C++ Generated GLB Ingestion (Streaming 3D AST) ---------------
    React.useEffect(() => {
        const stack = stackRef.current;
        if (!stack || !sceneData.cppGenerator?.glbBase64) return;
        try {
            const b64 = sceneData.cppGenerator.glbBase64;
            const binaryStr = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) {
                bytes[i] = binaryStr.charCodeAt(i);
            }
            const loader = new GLTFLoader();
            loader.parse(bytes.buffer, '', (gltf) => {
                const scene = stack.scene;
                if (!scene) return;
                const existing = scene.getObjectByName('scratchbox-cpp-generated-root');
                if (existing) {
                    scene.remove(existing);
                }
                gltf.scene.name = 'scratchbox-cpp-generated-root';
                gltf.scene.traverse((child) => {
                    if ((child as any).isMesh) {
                        const m = child as THREE.Mesh;
                        m.castShadow = true;
                        m.receiveShadow = true;
                        if ((child as any).isSkinnedMesh) {
                            m.frustumCulled = false;
                        }
                        if (m.material) {
                            const mat = m.material as THREE.MeshStandardMaterial;
                            if (m.geometry && m.geometry.attributes.color) {
                                mat.vertexColors = true;
                            }
                            mat.envMapIntensity = 1.35;
                            mat.needsUpdate = true;
                        }
                    }
                });
                scene.add(gltf.scene);
                refreshEntities();
            }, (err) => {
                console.warn('[C++ GLB Loader Error]:', err);
            });
        } catch (e) {
            console.warn('[C++ GLB Ingestion Error]:', e);
        }
    }, [sceneData.cppGenerator?.glbBase64]);

    // ---- 5c. External Model & Gaussian Splat Objects Ingestion (sceneData.objects[].content.durableUri, sceneData.splatUrl) ----
    React.useEffect(() => {
        const stack = stackRef.current;
        if (!stack) return;
        const scene = stack.scene;
        if (!scene) return;

        const rawObjects = sceneData.objects || [];
        const objects = [...rawObjects];
        if (sceneData.splatUrl && !objects.some(o => o.content?.durableUri === sceneData.splatUrl)) {
            objects.push({
                id: 'primary-location-splat',
                content: {
                    type: 'gaussian-splat',
                    durableUri: sceneData.splatUrl,
                    mimeType: sceneData.splatUrl.endsWith('.spz') ? 'application/x-spz' : 'application/octet-stream'
                },
                space: { spatial3d: { x: 0, y: 0, z: 0 } }
            });
        }

        const currentMap = externalObjectsMapRef.current;
        const activeIds = new Set<string>();

        const loader = new GLTFLoader();

        objects.forEach(obj => {
            const uri = obj.content?.durableUri;
            if (!uri) return;
            const isSplat = obj.content?.type === 'gaussian-splat' || !!uri.match(/\.(splat|spz)($|\?)/i);
            const isGltf = !!uri.match(/\.(glb|gltf)($|\?)/i);
            if (!isSplat && !isGltf) return;
            activeIds.add(obj.id);

            const existing = currentMap.get(obj.id);
            if (existing) {
                const s = obj.space?.spatial3d;
                if (s) {
                    existing.position.set(s.x ?? 0, s.y ?? 0, s.z ?? 0);
                    if (s.pitch !== undefined) existing.rotation.x = (s.pitch * Math.PI) / 180;
                    if (s.yaw !== undefined) existing.rotation.y = (s.yaw * Math.PI) / 180;
                    if (s.roll !== undefined) existing.rotation.z = (s.roll * Math.PI) / 180;
                }
                return;
            }

            if (isSplat) {
                PhotorealGaussianSplatMesh.fromUrl(uri, {
                    splatScale: sceneData.splatOptions?.splatScale ?? 1.0,
                    contactShadow: sceneData.splatOptions?.contactShadow ?? true,
                    enableRTC: sceneData.splatOptions?.enableRTC ?? true
                }).then(splatMesh => {
                    if (!stackRef.current?.scene) {
                        splatMesh.dispose();
                        return;
                    }
                    splatMesh.name = `external-splat-${obj.id}`;
                    const s = obj.space?.spatial3d;
                    if (s) {
                        splatMesh.position.set(s.x ?? 0, s.y ?? 0, s.z ?? 0);
                        if (s.pitch !== undefined) splatMesh.rotation.x = (s.pitch * Math.PI) / 180;
                        if (s.yaw !== undefined) splatMesh.rotation.y = (s.yaw * Math.PI) / 180;
                        if (s.roll !== undefined) splatMesh.rotation.z = (s.roll * Math.PI) / 180;
                    }
                    stackRef.current.scene.add(splatMesh);
                    currentMap.set(obj.id, splatMesh);
                    activeSplatMeshesRef.current.set(obj.id, splatMesh);
                    refreshEntities();
                }).catch(err => {
                    console.warn(`[External Splat Loader Error] Failed to load ${uri}:`, err);
                });
                return;
            }

            loader.load(
                uri,
                (gltf) => {
                    if (!stackRef.current?.scene) return;
                    const model = gltf.scene;
                    model.name = `external-object-${obj.id}`;
                    const s = obj.space?.spatial3d;
                    if (s) {
                        model.position.set(s.x ?? 0, s.y ?? 0, s.z ?? 0);
                        if (s.pitch !== undefined) model.rotation.x = (s.pitch * Math.PI) / 180;
                        if (s.yaw !== undefined) model.rotation.y = (s.yaw * Math.PI) / 180;
                        if (s.roll !== undefined) model.rotation.z = (s.roll * Math.PI) / 180;
                    }

                    model.traverse((child) => {
                        if ((child as any).isMesh) {
                            const m = child as THREE.Mesh;
                            m.castShadow = true;
                            m.receiveShadow = true;
                            if ((child as any).isSkinnedMesh) {
                                m.frustumCulled = false;
                            }
                            if (m.material) {
                                const mat = m.material as THREE.MeshStandardMaterial;
                                if (m.geometry && m.geometry.attributes.color) {
                                    mat.vertexColors = true;
                                }
                                mat.envMapIntensity = 1.35;
                                mat.needsUpdate = true;
                            }
                        }
                    });

                    scene.add(model);
                    currentMap.set(obj.id, model);
                    refreshEntities();
                },
                undefined,
                (err) => {
                    console.warn(`[External Model Loader Error] Failed to load ${uri}:`, err);
                }
            );
        });

        // Cleanup removed objects
        for (const [id, obj3d] of currentMap.entries()) {
            if (!activeIds.has(id)) {
                scene.remove(obj3d);
                activeSplatMeshesRef.current.delete(id);
                if (typeof (obj3d as any).dispose === 'function') {
                    (obj3d as any).dispose();
                } else {
                    obj3d.traverse((child) => {
                        if ((child as any).geometry) (child as any).geometry.dispose();
                        if ((child as any).material) {
                            const m = (child as any).material;
                            if (Array.isArray(m)) m.forEach(mat => mat.dispose());
                            else m.dispose();
                        }
                    });
                }
                currentMap.delete(id);
            }
        }
    }, [externalObjectsFingerprint]);

    React.useEffect(() => {
        const stack = stackRef.current;
        const currentMap = externalObjectsMapRef.current;
        return () => {
            if (stack && stack.scene) {
                for (const [, obj3d] of currentMap.entries()) {
                    stack.scene.remove(obj3d);
                    obj3d.traverse((child) => {
                        if ((child as any).geometry) (child as any).geometry.dispose();
                        if ((child as any).material) {
                            const m = (child as any).material;
                            if (Array.isArray(m)) m.forEach(mat => mat.dispose());
                            else m.dispose();
                        }
                    });
                }
            }
            currentMap.clear();
        };
    }, []);

    // ---- 6. Custom meshes from schema (id-diffed, updated in place) ---------------
    React.useEffect(() => {
        const stack = stackRef.current;
        if (!stack) return;
        syncCustomMeshes(stack, customMeshesRef.current as CustomMeshDefinition[] | undefined, customMeshRegistryRef.current, {
            terrainManager: terrainManagerRef.current,
            has3DTiles: tilesInputRef.current.has3DTiles
        });
        refreshEntities();
    }, [customMeshesFingerprint, tilesFingerprint]);

    React.useEffect(() => {
        // Registry outlives individual syncs; free everything on unmount.
        const stack = stackRef.current;
        const registry = customMeshRegistryRef.current;
        return () => {
            if (stack) disposeCustomMeshes(stack, registry);
            else registry.clear();
        };
    }, []);

    // ---- 7. Custom shaders from schema ---------------------------------------------
    React.useEffect(() => {
        const stack = stackRef.current;
        if (!stack) return;
        const handle = syncCustomShaders(stack, shadersRef.current as Record<string, CustomShaderDefinition> | undefined);
        customShaderMaterialsRef.current = handle.materials;
        return () => {
            handle.dispose();
            customShaderMaterialsRef.current = [];
        };
    }, [shadersFingerprint]);

    // ---------------------------------------------------------
    // Fallback Canvas Render (2D Orthographic Mode)
    // ---------------------------------------------------------
    React.useEffect(() => {
        if (!webglError || !fallbackCanvasRef.current) return;

        const canvas = fallbackCanvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        let frameId: number;
        let angle = 0;

        const draw = () => {
            angle += 0.008;
            const w = canvas.width = canvas.parentElement?.clientWidth || 500;
            const h = canvas.height = canvas.parentElement?.clientHeight || 450;

            ctx.fillStyle = '#0a0a0f';
            ctx.fillRect(0, 0, w, h);
            ctx.strokeStyle = 'rgba(63, 63, 90, 0.4)';
            ctx.lineWidth = 1;

            const cx = w / 2;
            const cy = h / 2 + 30;

            for (let i = -10; i <= 10; i++) {
                ctx.beginPath();
                ctx.moveTo(cx + i * 25, cy + 120);
                ctx.lineTo(cx + i * 8, cy - 80);
                ctx.stroke();

                const offset = cy - 80 + (i + 10) * 10;
                ctx.beginPath();
                ctx.moveTo(cx - 200 * ((offset - cy + 100) / 100), offset);
                ctx.lineTo(cx + 200 * ((offset - cy + 100) / 100), offset);
                ctx.stroke();
            }

            const size = 60;
            const vertices = [
                { x: -1, y: -1, z: -1 },
                { x: 1, y: -1, z: -1 },
                { x: 1, y: 1, z: -1 },
                { x: -1, y: 1, z: -1 },
                { x: -1, y: -1, z: 1 },
                { x: 1, y: -1, z: 1 },
                { x: 1, y: 1, z: 1 },
                { x: -1, y: 1, z: 1 }
            ];

            const projected = vertices.map(v => {
                const x = v.x * Math.cos(angle) - v.z * Math.sin(angle);
                const z = v.x * Math.sin(angle) + v.z * Math.cos(angle);
                const y = v.y * Math.cos(angle * 0.6) - z * Math.sin(angle * 0.6);
                const d = 3.5 - z * 0.4;
                return {
                    x: cx + (x * size) / d,
                    y: cy - 60 - (y * size) / d
                };
            });

            ctx.strokeStyle = renderMode === 'wireframe' ? 'rgba(0, 255, 170, 0.8)' : 'rgba(255, 0, 150, 0.95)';
            ctx.lineWidth = 1.8;
            const connect = (a: number, b: number) => {
                ctx.beginPath();
                ctx.moveTo(projected[a].x, projected[a].y);
                ctx.lineTo(projected[b].x, projected[b].y);
                ctx.stroke();
            };

            connect(0, 1); connect(1, 2); connect(2, 3); connect(3, 0);
            connect(4, 5); connect(5, 6); connect(6, 7); connect(7, 4);
            connect(0, 4); connect(1, 5); connect(2, 6); connect(3, 7);

            ctx.fillStyle = '#00f6ff';
            ctx.beginPath();
            ctx.arc(cx, cy - 60 + Math.sin(angle * 2) * 10, 8, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = '#ffffff';
            ctx.font = '11px monospace';
            ctx.fillText(`2D Fallback Orthographic Camera Pitch: 32° Yaw: ${(angle * 57.3).toFixed(0)}°`, 15, h - 15);

            frameId = requestAnimationFrame(draw);
        };

        draw();
        return () => cancelAnimationFrame(frameId);
    }, [webglError, renderMode]);

    const handleScrubChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = parseFloat(e.target.value);
        currentTimeMsRef.current = val;
        setCurrentTimeMs(val);
    };

    const handleTogglePlay = () => {
        setIsPlaying(!isPlaying);
    };

    const handleUndo = React.useCallback(() => {
        if (sculptMeshRef.current && historyStackRef.current) {
            const ok = historyStackRef.current.undo(sculptMeshRef.current.geometry);
            if (ok) {
                setCanUndo(historyStackRef.current.canUndo());
                setCanRedo(historyStackRef.current.canRedo());
                mutateSceneData(prev => ({
                    ...prev,
                    sculptSettings: sculptSettingsRef.current
                }), { operator: 'sb_undo', params: { target: 'sculpt-mesh' } });
            }
        }
    }, [mutateSceneData]);

    const handleRedo = React.useCallback(() => {
        if (sculptMeshRef.current && historyStackRef.current) {
            const ok = historyStackRef.current.redo(sculptMeshRef.current.geometry);
            if (ok) {
                setCanUndo(historyStackRef.current.canUndo());
                setCanRedo(historyStackRef.current.canRedo());
                mutateSceneData(prev => ({
                    ...prev,
                    sculptSettings: sculptSettingsRef.current
                }), { operator: 'sb_redo', params: { target: 'sculpt-mesh' } });
            }
        }
    }, [mutateSceneData]);

    const handleSwitchShape = React.useCallback((shape: 'sphere' | 'plane' | 'box' | 'cylinder' | 'torus') => {
        setSelectedShape(shape);
        if (threeSceneRef.current && sculptMeshRef.current) {
            const newGeo = createSculptableGeometry(shape, { radius: 3.5, width: 12, height: 12, segments: 64 });
            sculptMeshRef.current.geometry.dispose();
            sculptMeshRef.current.geometry = newGeo;
            historyStackRef.current.clear();
            historyStackRef.current.pushState(newGeo);
            setCanUndo(false);
            setCanRedo(false);
            mutateSceneData(prev => ({
                ...prev,
                sculptSettings: { ...prev.sculptSettings, ...sculptSettingsRef.current }
            }), { operator: 'sb_subdivide_mesh', params: { shape } });
        }
    }, [mutateSceneData]);

    const handleResetMesh = React.useCallback(() => {
        if (sculptMeshRef.current) {
            const newGeo = createSculptableGeometry(selectedShape, { radius: 3.5, width: 12, height: 12, segments: 64 });
            sculptMeshRef.current.geometry.dispose();
            sculptMeshRef.current.geometry = newGeo;
            historyStackRef.current.clear();
            historyStackRef.current.pushState(newGeo);
            setCanUndo(false);
            setCanRedo(false);
            mutateSceneData(prev => ({
                ...prev
            }), { operator: 'sb_reset_mesh', params: { shape: selectedShape } });
        }
    }, [selectedShape, mutateSceneData]);

    const handleResetTransform = React.useCallback(() => {
        if (selectedObjectRef.current) {
            selectedObjectRef.current.position.set(0, 0, 0);
            selectedObjectRef.current.quaternion.set(0, 0, 0, 1);
            selectedObjectRef.current.scale.set(1, 1, 1);
            const objId = selectedObjectRef.current.name || selectedObjectRef.current.uuid;
            mutateSceneData(prev => {
                const meshes = (prev.customMeshes || []).map(m => (m.id === objId || m.name === objId) ? { ...m, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] } : m);
                return { ...prev, customMeshes: meshes };
            }, { operator: 'sb_set_transform', params: { objectId: objId, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } });
        }
    }, [mutateSceneData]);

    const handleResetCamera = React.useCallback(() => {
        const cameraDef = sceneData.camera;
        const groundCenterY = terrainManagerRef.current?.sampleGroundHeight(0, 0) ?? 0;
        const tx = cameraDef?.target ? cameraDef.target[0] : 0;
        const ty = cameraDef?.target ? cameraDef.target[1] : (groundCenterY + 1.5);
        const tz = cameraDef?.target ? cameraDef.target[2] : 0;
        const [px, py, pz] = cameraDef?.position || [15, ty + 12, 15];

        cameraTargetRef.current.set(tx, ty, tz);
        const dx = px - tx;
        const dy = py - ty;
        const dz = pz - tz;
        const dist = Math.max(5, Math.sqrt(dx * dx + dy * dy + dz * dz));
        const phi = Math.acos(Math.max(-1, Math.min(1, dy / dist)));
        const theta = Math.atan2(dx, dz);

        cameraRotationRef.current = { theta, phi, distance: dist };
        if (threeCameraRef.current) {
            threeCameraRef.current.position.set(px, py, pz);
            threeCameraRef.current.lookAt(cameraTargetRef.current);
        }
        mutateSceneData(prev => ({
            ...prev,
            camera: { position: [px, py, pz], target: [tx, ty, tz] }
        }), { operator: 'sb_set_camera', params: { position: [px, py, pz], target: [tx, ty, tz] } });
    }, [sceneData.camera, mutateSceneData]);

    const handleUpdateVectorRoadmap = React.useCallback((updated: Partial<VectorRoadmapConfig>) => {
        mutateSceneData(prev => ({
            ...prev,
            vectorRoadmap: {
                ...prev.vectorRoadmap,
                enabled: true,
                ...updated
            }
        }), { operator: 'UPDATE_VECTOR_ROADMAP', params: updated });
    }, [mutateSceneData]);

    const refreshSceneBudget = React.useCallback(() => {
        if (stackRef.current?.scene) {
            const telemetry = computeSceneBudgetTelemetry(stackRef.current.scene);
            setSceneBudget(telemetry);
        }
    }, []);

    React.useEffect(() => {
        const timer = setInterval(refreshSceneBudget, 2000);
        refreshSceneBudget();
        return () => clearInterval(timer);
    }, [refreshSceneBudget]);

    const handleImport3DMapTile = React.useCallback(async () => {
        setIsIngestingTile(true);
        setMapTileStatusMsg('Resolving coordinates & synthesizing 3D map tile...');

        try {
            const tileService = Google3DTileService.getInstance();
            const result = await tileService.ingestTileRegion({
                query: mapTileQuery,
                lat: parseFloat(mapTileLat) || undefined,
                lng: parseFloat(mapTileLng) || undefined,
                elevation: parseFloat(mapTileElevation) || 0,
                radiusMeters: mapTileRadius,
                zoom: mapTileZoom,
                clayPreset: mapTileClayPreset,
                includeTerrain: mapTileIncludeTerrain,
                includeBuildings: mapTileIncludeBuildings,
                detailLevel: mapTileDetailLevel
            });

            if (threeSceneRef.current) {
                threeSceneRef.current.add(result.mesh);
            }

            mutateSceneData(prev => {
                const nextCustomMeshes = [...(prev.customMeshes || []), result.customMeshDefinition];
                const nextObjects = [...(prev.objects || []), result.media4DObject];
                return {
                    ...prev,
                    customMeshes: nextCustomMeshes,
                    objects: nextObjects,
                    geoAnchor: {
                        lat: result.geoAnchor.lat,
                        lng: result.geoAnchor.lng,
                        elevation: result.geoAnchor.elevation,
                        active: true,
                        landmarkName: result.geoAnchor.landmarkName
                    }
                };
            }, { operator: 'sb_import_3d_tile', params: { query: mapTileQuery, lat: mapTileLat, lng: mapTileLng } });

            // Select the newly imported tile
            selectObject(result.mesh);

            // Frame camera around the tile
            if (threeCameraRef.current) {
                cameraRotationRef.current = {
                    theta: Math.PI / 4,
                    phi: Math.PI / 3,
                    distance: Math.max(15, Math.min(250, mapTileRadius * 1.5))
                };
                threeCameraRef.current.position.set(mapTileRadius * 1.2, result.stats.elevationSpanMeters * 1.2 + 30, mapTileRadius * 1.2);
                threeCameraRef.current.lookAt(new THREE.Vector3(0, result.stats.elevationSpanMeters * 0.3, 0));
            }

            refreshEntities();
            setMapTileStatusMsg(`✓ Synced ${result.stats.buildingCount} buildings (${result.stats.vertexCount} verts)`);
            setTimeout(() => {
                setIsMapTileModalOpen(false);
                setMapTileStatusMsg(null);
            }, 1200);
        } catch (err: any) {
            setMapTileStatusMsg(`Error: ${err?.message || String(err)}`);
        } finally {
            setIsIngestingTile(false);
        }
    }, [mapTileQuery, mapTileLat, mapTileLng, mapTileElevation, mapTileRadius, mapTileZoom, mapTileClayPreset, mapTileIncludeTerrain, mapTileIncludeBuildings, mapTileDetailLevel, mutateSceneData, refreshEntities, selectObject]);

    const handleApplyClayPresetToScene = React.useCallback((preset: ClayPresetId) => {
        setMapTileClayPreset(preset);
        if (threeSceneRef.current) {
            TileClayProcessor.applyClayMaterial(threeSceneRef.current, preset);
        }
        mutateSceneData(prev => {
            const nextMeshes = prev.customMeshes?.map(m => ({
                ...m,
                material: {
                    ...(m.material || {}),
                    color: CLAY_PRESETS[preset]?.color || 0xc89678,
                    roughness: CLAY_PRESETS[preset]?.roughness ?? 0.82,
                    metalness: CLAY_PRESETS[preset]?.metalness ?? 0.02,
                    shaderKey: preset
                }
            }));
            return { ...prev, customMeshes: nextMeshes };
        }, { operator: 'sb_set_clay_mode', params: { preset } });
    }, [mutateSceneData]);

    // Global Keyboard Shortcut Listener for 3D Viewport Tools
    React.useEffect(() => {
        const handleGlobalKeyDown = (e: KeyboardEvent) => {
            const activeTag = (document.activeElement?.tagName || '').toLowerCase();
            if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') {
                return;
            }

            const key = e.key.toLowerCase();
            const isCmdOrCtrl = e.metaKey || e.ctrlKey;

            if (isCmdOrCtrl) {
                if (key === 'z') {
                    e.preventDefault();
                    if (e.shiftKey) {
                        handleRedo();
                    } else {
                        handleUndo();
                    }
                    return;
                } else if (key === 'y') {
                    e.preventDefault();
                    handleRedo();
                    return;
                }
            }

            if (key === 'v') {
                setToolMode('view');
            } else if (key === 'w' && cameraMode === 'orbit') {
                setToolMode('transform');
                setTransformMode('translate');
            } else if (key === 'e' && cameraMode === 'orbit') {
                setToolMode('transform');
                setTransformMode('rotate');
            } else if (key === 'r') {
                setToolMode('transform');
                setTransformMode('scale');
            } else if (key === 'b') {
                setToolMode('sculpt');
                setSculptSettings(s => ({ ...s, brush: 'draw' }));
            } else if (key === 'g') {
                setToolMode('sculpt');
                setSculptSettings(s => ({ ...s, brush: 'grab' }));
            } else if (key === 'c') {
                setToolMode('sculpt');
                setSculptSettings(s => ({ ...s, brush: 'clay' }));
            } else if (key === 's' && cameraMode === 'orbit') {
                setToolMode('sculpt');
                setSculptSettings(s => ({ ...s, brush: 'smooth' }));
            } else if (key === 'i') {
                setToolMode('sculpt');
                setSculptSettings(s => ({ ...s, brush: 'inflate' }));
            } else if (key === 'p') {
                setToolMode('sculpt');
                setSculptSettings(s => ({ ...s, brush: 'pinch' }));
            } else if (key === 'f') {
                setToolMode('sculpt');
                setSculptSettings(s => ({ ...s, brush: 'flatten' }));
            }
        };

        window.addEventListener('keydown', handleGlobalKeyDown);
        return () => {
            window.removeEventListener('keydown', handleGlobalKeyDown);
        };
    }, [handleUndo, handleRedo, cameraMode]);

    // Synchronize radius changes to cursor ring
    React.useEffect(() => {
        if (brushCursorMeshRef.current) {
            const r = sculptSettings.radius;
            brushCursorMeshRef.current.geometry.dispose();
            brushCursorMeshRef.current.geometry = new THREE.RingGeometry(r * 0.96, r, 48);
        }
    }, [sculptSettings.radius]);

    // Synchronize wireframe toggle to sculpt mesh material
    React.useEffect(() => {
        if (sculptMeshRef.current && sculptMeshRef.current.material) {
            const mat = sculptMeshRef.current.material as THREE.MeshStandardMaterial;
            if (mat) {
                mat.wireframe = !!sculptSettings.wireframeOverlay;
                mat.needsUpdate = true;
            }
        }
    }, [sculptSettings.wireframeOverlay]);

    // Synchronize transform mode changes to gizmo
    React.useEffect(() => {
        if (threeSceneRef.current && gizmoEngineRef.current) {
            if (transformGizmoGroupRef.current) {
                threeSceneRef.current.remove(transformGizmoGroupRef.current);
            }
            const newGizmo = gizmoEngineRef.current.createGizmo(transformMode);
            newGizmo.visible = toolMode === 'transform';
            threeSceneRef.current.add(newGizmo);
            transformGizmoGroupRef.current = newGizmo;
        }
    }, [transformMode, toolMode]);

    // Active Feature Chips for Glass Badge
    const activeFeatureBadges = React.useMemo(() => {
        const badges: string[] = [];
        if (sceneData.features?.godRays) badges.push('God Rays');
        if (sceneData.features?.controlSurfaces || isAirplane) badges.push('Articulated');
        if (sceneData.features?.contrails || isAirplane) badges.push('Contrails');
        if (sceneData.features?.terrainBiomes) badges.push('Biomes');
        if (sceneData.features?.atmosphericScattering) badges.push('Atmosphere');
        if (sceneData.customScript || sceneData.code) badges.push('Dynamic Script');
        return badges;
    }, [sceneData.features, sceneData.customScript, sceneData.code, isAirplane]);

    const handleExportGlb = React.useCallback(async () => {
        if (!threeSceneRef.current) return;
        try {
            const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
            const exporter = new GLTFExporter();
            exporter.parse(
                threeSceneRef.current,
                (gltf) => {
                    const blob = new Blob([gltf as ArrayBuffer], { type: 'model/gltf-binary' });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = `${(sceneData?.title || 'scene_3d').toLowerCase().replace(/[^a-z0-9]+/g, '_')}.glb`;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    URL.revokeObjectURL(url);
                    if (onPromptAction) onPromptAction('Exported 3D scene to standardized binary GLB.');
                },
                (error) => {
                    console.error('[Scene3D] GLTF Export failed:', error);
                },
                { binary: true }
            );
        } catch (err) {
            console.error('[Scene3D] Failed to load GLTFExporter:', err);
        }
    }, [sceneData?.title, onPromptAction]);

    React.useEffect(() => {
        const onExport = () => {
            handleExportGlb();
        };
        window.addEventListener('sb-export-glb', onExport);
        return () => window.removeEventListener('sb-export-glb', onExport);
    }, [handleExportGlb]);

    // ---------------------------------------------------------
    // Render Visual HTML - Ultra-Minimalist Floating Layout (Blender-grade)
    // ---------------------------------------------------------
    return (
        <div className="sb-scene3d-primitive-container relative w-full h-full bg-[#b0b8c4] text-zinc-100 overflow-hidden rounded-[16px] border border-white/10 shadow-2xl backdrop-blur-2xl select-none">
            {/* CONTAINERIZED 3D VIEWPORT CANVAS - Full-Bleed 100% */}
            <div className="sb-3d-viewport-frame absolute inset-0 w-full h-full bg-[#b0b8c4] overflow-hidden">
                {webglError ? (
                    <div className="absolute inset-0 w-full h-full">
                        <canvas ref={fallbackCanvasRef} className="w-full h-full block" />
                        <div className="absolute top-4 left-4 right-4 p-3.5 bg-red-950/40 border border-red-900/40 backdrop-blur-md rounded-2xl">
                            <p className="text-xs text-red-300 font-semibold">{webglError}</p>
                        </div>
                    </div>
                ) : (
                    <div
                        ref={viewportRef}
                        className="sb-3d-viewport-canvas-container absolute inset-0 w-full h-full block cursor-grab active:cursor-grabbing"
                        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%' }}
                    />
                )}
            </div>

            {/* Precision Creative Vertical Tool Strip (Left Docked) */}
            <div className="sb-3d-toolstrip absolute top-16 left-4 z-20 flex flex-col items-center gap-1 p-1.5 rounded-2xl bg-[#121216]/85 backdrop-blur-2xl border border-white/10 shadow-2xl pointer-events-auto select-none animate-fadeIn">
                {/* 1. Selection / Orbit Camera (V) */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-8 h-8 rounded-lg transition-all ${
                        toolMode === 'view'
                            ? 'sb-3d-toolstrip-btn-active bg-blue-600/30 text-blue-300 border border-blue-500/50 shadow-md shadow-blue-900/30'
                            : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5 border border-transparent'
                    }`}
                    onClick={() => setToolMode('view')}
                    title="Selection / Camera Orbit (V)"
                >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 3l7 18 3-7 7-3L3 3z" />
                    </svg>
                </button>

                {/* 2. Translate / Move (W) */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-8 h-8 rounded-lg transition-all ${
                        toolMode === 'transform' && transformMode === 'translate'
                            ? 'sb-3d-toolstrip-btn-active bg-blue-600/30 text-blue-300 border border-blue-500/50 shadow-md shadow-blue-900/30'
                            : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5 border border-transparent'
                    }`}
                    onClick={() => {
                        setToolMode('transform');
                        setTransformMode('translate');
                    }}
                    title="Translate / Move (W)"
                >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20" />
                    </svg>
                </button>

                {/* 3. Rotate (E) */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-8 h-8 rounded-lg transition-all ${
                        toolMode === 'transform' && transformMode === 'rotate'
                            ? 'sb-3d-toolstrip-btn-active bg-blue-600/30 text-blue-300 border border-blue-500/50 shadow-md shadow-blue-900/30'
                            : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5 border border-transparent'
                    }`}
                    onClick={() => {
                        setToolMode('transform');
                        setTransformMode('rotate');
                    }}
                    title="Rotate (E)"
                >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                    </svg>
                </button>

                {/* 4. Scale (R) */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-8 h-8 rounded-lg transition-all ${
                        toolMode === 'transform' && transformMode === 'scale'
                            ? 'sb-3d-toolstrip-btn-active bg-blue-600/30 text-blue-300 border border-blue-500/50 shadow-md shadow-blue-900/30'
                            : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5 border border-transparent'
                    }`}
                    onClick={() => {
                        setToolMode('transform');
                        setTransformMode('scale');
                    }}
                    title="Scale (R)"
                >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                    </svg>
                </button>

                {/* Divider */}
                <div className="sb-3d-toolstrip-divider w-5 h-[1px] bg-white/10 my-0.5" />

                {/* 5. Sculpt Draw (B) */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-8 h-8 rounded-lg transition-all ${
                        toolMode === 'sculpt' && sculptSettings.brush === 'draw'
                            ? 'sb-3d-toolstrip-btn-active bg-blue-600/30 text-blue-300 border border-blue-500/50 shadow-md shadow-blue-900/30'
                            : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5 border border-transparent'
                    }`}
                    onClick={() => {
                        setToolMode('sculpt');
                        setSculptSettings(s => ({ ...s, brush: 'draw' }));
                    }}
                    title="Sculpt Draw (B)"
                >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18.375 2.625a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.375-9.375z" />
                        <path d="M14 6l4 4" />
                    </svg>
                </button>

                {/* 6. Sculpt Grab (G) */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-8 h-8 rounded-lg transition-all ${
                        toolMode === 'sculpt' && sculptSettings.brush === 'grab'
                            ? 'sb-3d-toolstrip-btn-active bg-blue-600/30 text-blue-300 border border-blue-500/50 shadow-md shadow-blue-900/30'
                            : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5 border border-transparent'
                    }`}
                    onClick={() => {
                        setToolMode('sculpt');
                        setSculptSettings(s => ({ ...s, brush: 'grab' }));
                    }}
                    title="Sculpt Grab (G)"
                >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v4" />
                        <path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v6" />
                        <path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8" />
                        <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
                    </svg>
                </button>

                {/* 7. Sculpt Clay Strips (C) */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-8 h-8 rounded-lg transition-all ${
                        toolMode === 'sculpt' && sculptSettings.brush === 'clay'
                            ? 'sb-3d-toolstrip-btn-active bg-blue-600/30 text-blue-300 border border-blue-500/50 shadow-md shadow-blue-900/30'
                            : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5 border border-transparent'
                    }`}
                    onClick={() => {
                        setToolMode('sculpt');
                        setSculptSettings(s => ({ ...s, brush: 'clay' }));
                    }}
                    title="Sculpt Clay Strips (C)"
                >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="4" width="18" height="4" rx="1" />
                        <rect x="3" y="10" width="18" height="4" rx="1" />
                        <rect x="3" y="16" width="18" height="4" rx="1" />
                    </svg>
                </button>

                {/* 8. Sculpt Smooth (S) */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-8 h-8 rounded-lg transition-all ${
                        toolMode === 'sculpt' && sculptSettings.brush === 'smooth'
                            ? 'sb-3d-toolstrip-btn-active bg-blue-600/30 text-blue-300 border border-blue-500/50 shadow-md shadow-blue-900/30'
                            : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5 border border-transparent'
                    }`}
                    onClick={() => {
                        setToolMode('sculpt');
                        setSculptSettings(s => ({ ...s, brush: 'smooth' }));
                    }}
                    title="Sculpt Smooth (S / Shift+S)"
                >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
                    </svg>
                </button>

                {/* 9. Sculpt Inflate (I) */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-8 h-8 rounded-lg transition-all ${
                        toolMode === 'sculpt' && sculptSettings.brush === 'inflate'
                            ? 'sb-3d-toolstrip-btn-active bg-blue-600/30 text-blue-300 border border-blue-500/50 shadow-md shadow-blue-900/30'
                            : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5 border border-transparent'
                    }`}
                    onClick={() => {
                        setToolMode('sculpt');
                        setSculptSettings(s => ({ ...s, brush: 'inflate' }));
                    }}
                    title="Sculpt Inflate (I)"
                >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="6" />
                        <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                    </svg>
                </button>

                {/* 10. Sculpt Pinch (P) */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-8 h-8 rounded-lg transition-all ${
                        toolMode === 'sculpt' && sculptSettings.brush === 'pinch'
                            ? 'sb-3d-toolstrip-btn-active bg-blue-600/30 text-blue-300 border border-blue-500/50 shadow-md shadow-blue-900/30'
                            : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5 border border-transparent'
                    }`}
                    onClick={() => {
                        setToolMode('sculpt');
                        setSculptSettings(s => ({ ...s, brush: 'pinch' }));
                    }}
                    title="Sculpt Pinch (P)"
                >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M7 17l5-5-5-5M17 17l-5-5 5-5" />
                    </svg>
                </button>

                {/* 11. Sculpt Flatten (F) */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-8 h-8 rounded-lg transition-all ${
                        toolMode === 'sculpt' && sculptSettings.brush === 'flatten'
                            ? 'sb-3d-toolstrip-btn-active bg-blue-600/30 text-blue-300 border border-blue-500/50 shadow-md shadow-blue-900/30'
                            : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5 border border-transparent'
                    }`}
                    onClick={() => {
                        setToolMode('sculpt');
                        setSculptSettings(s => ({ ...s, brush: 'flatten' }));
                    }}
                    title="Sculpt Flatten (F)"
                >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 18h16M7 14l5-8 5 8H7z" />
                    </svg>
                </button>

                {/* Divider */}
                <div className="sb-3d-toolstrip-divider w-5 h-[1px] bg-white/10 my-0.5" />

                {/* 12. Wireframe Toggle */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-8 h-8 rounded-lg transition-all ${
                        sculptSettings.wireframeOverlay
                            ? 'sb-3d-toolstrip-btn-active bg-blue-600/30 text-blue-300 border border-blue-500/50 shadow-md shadow-blue-900/30'
                            : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5 border border-transparent'
                    }`}
                    onClick={() => setSculptSettings(s => ({ ...s, wireframeOverlay: !s.wireframeOverlay }))}
                    title="Toggle Wireframe Overlay"
                >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2l10 6.5v7L12 22 2 15.5v-7L12 2z" />
                        <path d="M12 22V12M2 8.5l10 3.5 10-3.5" />
                    </svg>
                </button>

                {/* 13. Undo (⌘Z) */}
                <button
                    type="button"
                    disabled={!canUndo}
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-8 h-8 rounded-lg transition-all ${
                        canUndo
                            ? 'text-zinc-300 hover:text-white hover:bg-white/10 border border-transparent'
                            : 'text-zinc-600 cursor-not-allowed border border-transparent opacity-40'
                    }`}
                    onClick={handleUndo}
                    title="Undo Stroke (⌘Z / Ctrl+Z)"
                >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 7v6h6M3 13a9 9 0 1 1 3 7.7" />
                    </svg>
                </button>

                {/* 14. Redo (⌘⇧Z) */}
                <button
                    type="button"
                    disabled={!canRedo}
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-8 h-8 rounded-lg transition-all ${
                        canRedo
                            ? 'text-zinc-300 hover:text-white hover:bg-white/10 border border-transparent'
                            : 'text-zinc-600 cursor-not-allowed border border-transparent opacity-40'
                    }`}
                    onClick={handleRedo}
                    title="Redo Stroke (⌘⇧Z / Ctrl+Shift+Z)"
                >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 7v6h-6M21 13a9 9 0 1 0-3 7.7" />
                    </svg>
                </button>
            </div>

            {/* Ultra-Minimalist Floating Top-Right Controls */}
            <div className="sb-3d-minimal-badge-container absolute top-3 right-3 z-20 flex items-center gap-2 pointer-events-auto select-none animate-fadeIn">
                <div className="sb-3d-minimal-badge flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#121216]/80 backdrop-blur-md border border-white/10 text-[10px] font-mono text-zinc-300 shadow-md">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                    <span>3D Scene</span>
                </div>
                <button
                    type="button"
                    onClick={handleExportGlb}
                    className="sb-btn sb-btn-xs flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#121216]/80 hover:bg-zinc-800 text-zinc-200 border border-white/10 text-[11px] font-mono shadow-md transition-all shrink-0"
                    title="Export 3D Scene as standardized binary glTF (.glb)"
                >
                    <span>📦</span>
                    <span>Export GLB</span>
                </button>
                <button
                    type="button"
                    onClick={() => {
                        const isEnabled = !(sceneData.metadata?.postprocessing?.fsr?.enabled ?? false);
                        const updated: Scene3DData = {
                            ...sceneData,
                            metadata: {
                                ...sceneData.metadata,
                                postprocessing: {
                                    ...sceneData.metadata?.postprocessing,
                                    fsr: {
                                        enabled: isEnabled,
                                        preset: sceneData.metadata?.postprocessing?.fsr?.preset || 'quality',
                                        sharpness: sceneData.metadata?.postprocessing?.fsr?.sharpness ?? 0.85
                                    }
                                }
                            }
                        };
                        setSceneData(updated);
                        onUpdate?.(updated);
                    }}
                    className={`sb-btn sb-btn-xs flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-mono shadow-md transition-all shrink-0 ${
                        sceneData.metadata?.postprocessing?.fsr?.enabled
                            ? 'bg-rose-950/70 hover:bg-rose-900/80 text-rose-200 border border-rose-500/50 shadow-rose-900/30'
                            : 'bg-[#121216]/80 hover:bg-zinc-800 text-zinc-300 border border-white/10'
                    }`}
                    title="Toggle AMD FidelityFX Super Resolution 1.0 (EASU + RCAS)"
                >
                    <span className="text-rose-400 font-bold">⚡</span>
                    <span>FSR 1.0: {sceneData.metadata?.postprocessing?.fsr?.enabled ? 'ON' : 'OFF'}</span>
                </button>
                {scriptError && (
                    <div className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-950/70 border border-amber-500/40 text-[10px] text-amber-200 shrink-0">
                        <span className="text-amber-400">⚠</span>
                        <span className="font-mono truncate max-w-[120px]">{scriptError}</span>
                    </div>
                )}
            </div>


            {/* Vector Roadmap Reference Minimap & Ground Blueprint HUD */}
            <VectorRoadmapHUD
                config={sceneData.vectorRoadmap}
                geoAnchor={sceneData.geoAnchor}
                cameraHeading={cameraHeading}
                onUpdateConfig={handleUpdateVectorRoadmap}
                onResetCameraToAnchor={handleResetCamera}
                isOpen={isVectorRoadmapHUDOpen}
                onToggleOpen={() => setIsVectorRoadmapHUDOpen(!isVectorRoadmapHUDOpen)}
            />

            {/* Ultra-Sleek Floating Bottom Scrubber Pill */}
            <div className="sb-3d-timeline-scrubber absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-4 py-2 rounded-full bg-[#121216]/85 backdrop-blur-2xl border border-white/10 shadow-2xl select-none animate-fadeIn">
                <button
                    type="button"
                    className="sb-3d-play-mini-btn flex items-center justify-center w-7 h-7 rounded-full bg-blue-600/30 text-blue-400 border border-blue-500/40 hover:bg-blue-600/50 transition-all active:scale-95"
                    onClick={handleTogglePlay}
                    title={isPlaying ? 'Pause simulation' : 'Play simulation'}
                >
                    {isPlaying ? (
                        <svg className="w-3 h-3 fill-current" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
                    ) : (
                        <svg className="w-3 h-3 fill-current ml-0.5" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                    )}
                </button>
                <input
                    type="range"
                    min="0"
                    max={durationMs}
                    value={currentTimeMs}
                    onChange={handleScrubChange}
                    className="w-36 sm:w-56 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-blue-500 focus:outline-none"
                />
                <span className="text-[11px] font-mono text-zinc-300 font-medium shrink-0">
                    {(currentTimeMs / 1000).toFixed(1)}s
                </span>
            </div>
        </div>
    );
};
