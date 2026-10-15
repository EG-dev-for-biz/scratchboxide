/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import * as THREE from 'three';
import type {
    CanvasArtifact,
    Media4DObject,
    Scene3DData,
    SculptBrushType,
    SculptFalloffType,
    SculptSymmetry,
    SculptSettings,
    TransformGizmoMode,
    TransformGizmoSpace,
    ViewportToolMode,
    GroundTileMode
} from '../canvas-types';
import { VideoTimelineTracks } from './video/VideoTimelineTracks';
import type { TimelineTrack, VideoTimelineData, NleTool } from '../services/video/videoTypes';
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
    createHighwayOverpassScene,
    createAlpineMatterhornScene,
    createBabylonianZigguratScene,
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
import { liveTilesAnchor, syncTilesLayer } from './scene3d/syncTilesLayer';
import { groundDatumBadge, projectRoutePoint } from './scene3d/geoAnchorLabels';
import type { TilesLayerInput } from './scene3d/syncTilesLayer';
import { drawsProceduralBiomeTerrain, syncAtmosphere } from './scene3d/syncAtmosphere';
import type { AtmosphereInput } from './scene3d/syncAtmosphere';
import { classifySceneContent, hasNonFallbackObjectContent, syncSceneContent, syncWasmMesh, undrawableSceneObjects } from './scene3d/syncSceneContent';
import { ViewportNotice, resolveViewportNotice } from './scene3d/ViewportNotice';
import { fromInput, generatorErrorForScene, generatorRequestFailure, generatorRunFailure, type GeneratorRunError } from './scene3d/generatorRun';
import type { SceneContentInput, SceneContentFactories } from './scene3d/syncSceneContent';
import { syncCustomMeshes, disposeCustomMeshes } from './scene3d/syncCustomMeshes';
import type { CustomMeshRegistry, CustomMeshDefinition } from './scene3d/syncCustomMeshes';
import { syncCustomShaders, tickCustomShaders } from './scene3d/syncCustomShaders';
import type { CustomShaderDefinition } from './scene3d/syncCustomShaders';
import { tickObjectAnimations } from './scene3d/objectAnimationRuntime';
import type { PhysicsRuntimeState } from './scene3d/objectAnimationRuntime';
import { attachViewportControls, readWorldPose, stepCamera } from './scene3d/attachViewportControls';
import { syncVectorRoadmapBlueprint } from './scene3d/syncVectorRoadmapBlueprint';
import { VectorRoadmapHUD } from './scene3d/VectorRoadmapHUD';
import { NumericPrecisionInspector } from './scene3d/NumericPrecisionInspector';
import { computeSceneGeometryBounds, calculateStandoffCamera } from './scene3d/autoFraming';
import type { RendererStack, AtmosphereHandle, TilesLayerHandle, SceneContentHandle, WasmMeshHandle, VectorRoadmapHandle, Scene3DRenderMode } from './scene3d/types';
import { applyClayRenderMode } from './scene3d/clayRenderMode';
import { disposeObject3DDeep, releaseObject3D } from './scene3d/disposeObject';
import {
    resolveSelectableObject,
    extractSceneOutlinerItems,
    findExternalObjectRoot,
    externalObjectIdOf,
    isAttachedTo,
    summarizeObjectGeometry,
    EXTERNAL_OBJECT_ROOT_PREFIX
} from './scene3d/selection';
import { groupVariantSets, resolveActiveVariants, variantSetKeyOf } from './scene3d/variantSets';
import type { VectorRoadmapConfig } from '../canvas-types';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CINEMATIC_RIGS, computeSceneBudgetTelemetry } from './scene3d/lightingRigs';
import type { SceneBudgetTelemetry } from './scene3d/lightingRigs';

// Aircraft helpers live in services/mesh/aircraft.ts (single source of truth, shared with the
// transformer engine's sandbox template); re-exported here to keep the public API stable.
export { createArticulatedAircraft, createAirplaneMesh, updateFlightPhysics, animateAircraftFrame };
export type { ArticulatedAircraftComponents };
// Pick / outliner resolution lives in scene3d/selection.ts (unit-tested there); re-exported for API stability.
export { resolveSelectableObject, extractSceneOutlinerItems };
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
    onCaptureReady?: (captureFn: () => string | null) => void;
    onVisualVerification?: (screenshotDataUrl: string) => void;
}

/**
 * Captures a visual screenshot of the current Three.js WebGL frame as a PNG data URL, or null when no frame can be
 * read (no renderer, or the canvas refuses toDataURL). Callers must not substitute an image for null.
 */
export function captureSceneScreenshot(
    renderer?: THREE.WebGLRenderer | null,
    scene?: THREE.Scene | null,
    camera?: THREE.Camera | null
): string | null {
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
                // A tainted or lost canvas cannot be read; report no frame.
            }
        }
    }
    return null;
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
    createHighwayOverpassScene?: typeof createHighwayOverpassScene;
    createAlpineMatterhornScene?: typeof createAlpineMatterhornScene;
    createBabylonianZigguratScene?: typeof createBabylonianZigguratScene;
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
    _scene: THREE.Scene,
    _biomeType: string = 'alpine',
    _renderMode: string = 'pbr',
    _isSunset: boolean = false
) => {
    // Purged: In accordance with the Anti-JS-Primitives directive, procedural terrains
    // and biomes are generated via the native C++20 engine (scratchbox_infiniti.hpp / sb.World.add_terrain)
    // and streamed as binary glTF 2.0 (.glb).
    const emptyGroup = new THREE.Group();
    return {
        group: emptyGroup,
        terrainMesh: undefined,
        cloudGroup: undefined,
        update: () => {},
        dispose: () => {}
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
import { loadServedGeneratorGlb } from '../../../common/strip-embedded-glb';
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

/** True when a scene object already loads the generator's output file (objects[].content.durableUri). */
export function generatorFileIsObject(gen: { glbPath?: string } | undefined, objects: Scene3DData['objects']): boolean {
    const file = gen?.glbPath?.split('/').pop();
    return !!file && !!objects?.some(o => o.content?.durableUri?.split('/').pop() === file);
}

/** Per-object load state for externally referenced models (objects[].content.durableUri). */
interface ExternalLoadStatus {
    phase: 'download' | 'parse' | 'ready' | 'error';
    loaded: number;
    /** 0 when the server sends no Content-Length. */
    total: number;
    error?: string;
}

/** Request URL for an objects[] durableUri: bare '/<file>.glb' paths are served from /models/. */
function resolveExternalModelUri(rawUri: string): string {
    if (rawUri.startsWith('/') && !rawUri.startsWith('/models/') && !rawUri.startsWith('/tiles/') && !rawUri.startsWith('/api/') && !rawUri.startsWith('/panoramas/')) {
        const fileName = rawUri.split('/').pop();
        if (fileName && (fileName.endsWith('.glb') || fileName.endsWith('.gltf'))) return `/models/${fileName}`;
    }
    return rawUri;
}

/** Objects sourced from a ground-tile service are only shown in the ground mode matching their source. */
function isVisibleForGroundMode(obj: Media4DObject, groundTileMode: GroundTileMode, hasExplicit3DTileObject: boolean): boolean {
    const source = (obj.content?.metadata?.source || '').toLowerCase();
    if (source === 'googlevectortileservice' || source === 'google_vector_tile_service') {
        return groundTileMode === 'vector-world-clay';
    }
    if (source === 'google3dtilesclay' || source === 'google_3d_tiles_clay') {
        return groundTileMode === 'photoreal-clay' || hasExplicit3DTileObject;
    }
    if (source === 'google3dtilesfulltexture' || source === 'google_3d_tiles_full_texture') {
        return groundTileMode === 'photoreal-textured' || hasExplicit3DTileObject;
    }
    return true;
}

const formatLoadStatus = (status: ExternalLoadStatus | undefined): string => {
    if (!status || status.phase === 'ready') return '';
    if (status.phase === 'error') return '!';
    if (status.phase === 'parse') return 'parsing';
    if (status.total > 0) return `${Math.min(99, Math.floor((status.loaded / status.total) * 100))}%`;
    return status.loaded > 0 ? `${(status.loaded / 1048576).toFixed(0)} MB` : '…';
};

/** Shared look of the viewport HUD pills (mirrors .sb-3d-minimal-badge in unified-ui.css). */
const HUD_PILL_STYLE: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    maxWidth: '100%',
    boxSizing: 'border-box',
    background: 'rgba(18, 18, 22, 0.8)',
    backdropFilter: 'blur(24px) saturate(180%)',
    WebkitBackdropFilter: 'blur(24px) saturate(180%)',
    // Longhands only: variants override borderColor, and React warns when shorthand and longhand mix.
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
    color: '#f4f4f5',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 10.5,
    pointerEvents: 'auto',
    userSelect: 'none'
};
const HUD_COLUMN_STYLE: React.CSSProperties = {
    position: 'absolute',
    top: 48,
    right: 14,
    zIndex: 20,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 6,
    maxWidth: 'calc(100% - 72px)',
    pointerEvents: 'none'
};
const HUD_SEGMENT_STYLE: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '3px 9px',
    borderRadius: 9999,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    background: 'transparent',
    color: '#d4d4d8',
    font: 'inherit',
    whiteSpace: 'nowrap',
    cursor: 'pointer'
};
const HUD_SEGMENT_ACTIVE_STYLE: React.CSSProperties = {
    background: 'rgba(37, 99, 235, 0.4)',
    borderColor: 'rgba(59, 130, 246, 0.55)',
    color: '#dbeafe'
};

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
        // Every field the data holds (geoAnchor, splatUrl, vectorRoadmap, ...), so the first frame and the
        // "No geometry" notice reflect the scene as sent; the fields below only normalise.
        ...data,
        title: data?.title || '4D Scene Workspace',
        subtitle: data?.subtitle || 'Interactive 4D spatial viewport with temporal simulation solver',
        objects: data?.objects || [],
        camera: data?.camera || { position: [15, 12, 15], target: [0, 0, 0] },
        environment: data?.environment || { skybox: 'studio', lighting: 'studio', ground: true },
        features: data?.features,
        // Carried so onUpdate round-trips (selection, gizmo edits) keep the authored render mode.
        renderMode: data?.renderMode,
        customScript: data?.customScript || data?.code,
        pythonGenerator: data?.pythonGenerator,
        // Only the generator the scene data holds; the viewport never supplies one of its own.
        cppGenerator: data?.cppGenerator,
        shaders: data?.shaders,
        customMeshes: (() => {
            if (data?.customMeshes && data.customMeshes.length > 0) return data.customMeshes;
            return [];
        })()
    }));

    // Rendering options: Default strictly to Studio Grey Clay mode
    const [renderMode, setRenderMode] = React.useState<Scene3DRenderMode>(data?.renderMode || 'clay');
    const renderModeRef = useLatest(renderMode);
    const [cameraMode, setCameraMode] = React.useState<'orbit' | 'fps'>('orbit');
    const [worldBranch, setWorldBranch] = React.useState<string>(data?.worldBranch || 'earth/main');
    const [hasGeoCoordinates, setHasGeoCoordinates] = React.useState<boolean>(false);
    // The scene's anchor as last synced from its data: empty until the scene has one (no default place).
    const [lat, setLat] = React.useState<string>('');
    const [lng, setLng] = React.useState<string>('');
    const [scriptError, setScriptError] = React.useState<string | null>(null);
    // Failures of the scene's own content sources, shown in the viewport (never swapped for other geometry).
    const [generatorError, setGeneratorError] = React.useState<GeneratorRunError | null>(null);
    const [tilesError, setTilesError] = React.useState<string | null>(null);
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
    const [isInspectorOpen, setIsInspectorOpen] = React.useState<boolean>(false);
    const [outlinerSearchQuery, setOutlinerSearchQuery] = React.useState<string>('');
    const [sceneEntities, setSceneEntities] = React.useState<Array<{ id: string; name: string; type: string; object: THREE.Object3D; visible: boolean }>>([]);
    const selectionBoxRef = React.useRef<THREE.BoxHelper | null>(null);

    // Variant sets: objects sharing an open `content.metadata.variantSet` key are alternatives of
    // which exactly one is in the scene. The choice is viewer state, kept outside sceneData because
    // the props sync rebuilds sceneData on every parent render.
    const [variantChoice, setVariantChoice] = React.useState<Record<string, string>>({});
    const variantSets = React.useMemo(() => groupVariantSets(sceneData.objects), [sceneData.objects]);
    const activeVariantIds = React.useMemo(() => resolveActiveVariants(variantSets, variantChoice), [variantSets, variantChoice]);
    const activeVariantIdsRef = useLatest(activeVariantIds);
    const [externalLoadStatus, setExternalLoadStatus] = React.useState<Record<string, ExternalLoadStatus>>({});
    // Bumped to re-run the loader for objects whose last load failed (nothing else changes then).
    const [externalLoadRetryNonce, setExternalLoadRetryNonce] = React.useState(0);
    // Object id -> URL of the request in flight; survives StrictMode / HMR effect re-runs so a model
    // is never fetched and parsed twice, while a changed URL for the same id still starts a new load.
    const pendingExternalLoadsRef = React.useRef<Map<string, string>>(new Map());
    const loadProgressStampRef = React.useRef<Record<string, number>>({});
    // Selecting outside sculpt mode skips the (multi-MB) history snapshot; it is taken when sculpt mode is entered.
    const historyBaselinePendingRef = React.useRef<THREE.Mesh | null>(null);

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
    // Drone-route pins come only from the scene's droneRoute; without them no route is drawn.
    const [pinALat, setPinALat] = React.useState<string>('');
    const [pinALng, setPinALng] = React.useState<string>('');
    const [pinBLat, setPinBLat] = React.useState<string>('');
    const [pinBLng, setPinBLng] = React.useState<string>('');
    const [isRoutingActive, setIsRoutingActive] = React.useState<boolean>(false);

    // High-performance animation refs for routing
    const pinALatRef = useLatest(pinALat);
    const pinALngRef = useLatest(pinALng);
    const pinBLatRef = useLatest(pinBLat);
    const pinBLngRef = useLatest(pinBLng);
    const isRoutingActiveRef = useLatest(isRoutingActive);

    // 4D Timeline & Playback States
    const [currentTimeMs, setCurrentTimeMs] = React.useState<number>(data.timeline?.currentTimeMs || 0);
    const [durationMs, setDurationMs] = React.useState<number>(data.timeline?.durationMs || 10000);
    const [isPlaying, setIsPlaying] = React.useState<boolean>(data.timeline?.isPlaying || false);
    const [playbackSpeed, setPlaybackSpeed] = React.useState<number>(data.timeline?.playbackSpeed || data.timeline?.speed || 1.0);
    const [isTimelineDrawerOpen, setIsTimelineDrawerOpen] = React.useState<boolean>(false);
    const [timelineActiveTool] = React.useState<NleTool>('select');
    const [timelineSnapping, setTimelineSnapping] = React.useState<boolean>(true);
    const [timelineZoom, setTimelineZoom] = React.useState<number>(50);
    const [selectedClipId, setSelectedClipId] = React.useState<string | undefined>(undefined);

    const currentTimeMsRef = React.useRef<number>(0);
    const isPlayingRef = useLatest(isPlaying);
    const playbackSpeedRef = useLatest(playbackSpeed);
    const durationMsRef = useLatest(durationMs);
    const lastStateUpdateRef = React.useRef<number>(0);

    // WebGL unavailable: the viewport shows this error and draws nothing.
    const [webglError, setWebglError] = React.useState<string | null>(null);
    const [generatedContentRadius, setGeneratedContentRadius] = React.useState<number | null>(null);
    const [isWasmActive, setIsWasmActive] = React.useState<boolean>(false);


    // Vector ROADMAP Reference & Cloud-Based Map Styling States
    const [isVectorRoadmapHUDOpen, setIsVectorRoadmapHUDOpen] = React.useState<boolean>(false);
    const [cameraHeading, setCameraHeading] = React.useState<number>(0);
    const isVectorRoadmapHUDOpenRef = useLatest(isVectorRoadmapHUDOpen);
    const vectorRoadmapHandleRef = React.useRef<VectorRoadmapHandle | null>(null);

    // Viewport & Three.js Refs
    const viewportRef = React.useRef<HTMLDivElement>(null);
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

    // Dynamic Engine Hook Refs
    const skyDomeModuleRef = React.useRef<any | null>(null);
    const aerialPerspectiveRef = React.useRef<any | null>(null);
    const terrainCloudShadowsRef = React.useRef<any | null>(null);
    const godRaysRef = React.useRef<any | null>(null);
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

    // Sync external data prop updates into sceneData
    React.useEffect(() => {
        if (!data) return;
        setSceneData(prev => {
            const hasNewPython = data.pythonGenerator && data.pythonGenerator.sourceCode !== prev.pythonGenerator?.sourceCode;
            const hasNewCpp = data.cppGenerator && data.cppGenerator.sourceCode !== prev.cppGenerator?.sourceCode;
            const hasNewObjects = data.objects && data.objects !== prev.objects;
            const hasNewTitle = data.title && data.title !== prev.title;
            const hasNewGlb = (data.pythonGenerator?.glbBase64 && data.pythonGenerator.glbBase64 !== prev.pythonGenerator?.glbBase64) ||
                              (data.cppGenerator?.glbBase64 && data.cppGenerator.glbBase64 !== prev.cppGenerator?.glbBase64);
            if (!hasNewPython && !hasNewCpp && !hasNewObjects && !hasNewTitle && !hasNewGlb) {
                return prev;
            }
            return {
                ...prev,
                ...data,
                pythonGenerator: data.pythonGenerator
                    ? {
                        ...prev.pythonGenerator,
                        ...data.pythonGenerator,
                        glbBase64: data.pythonGenerator.glbBase64 || prev.pythonGenerator?.glbBase64
                      }
                    : prev.pythonGenerator,
                cppGenerator: data.cppGenerator
                    ? {
                        ...prev.cppGenerator,
                        ...data.cppGenerator,
                        glbBase64: data.cppGenerator.glbBase64 || prev.cppGenerator?.glbBase64
                      }
                    : prev.cppGenerator,
                objects: data.objects ?? prev.objects,
                customMeshes: data.customMeshes ?? prev.customMeshes
            };
        });
    }, [data]);

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
                // The baseline copies the whole position buffer (tens of MB on scan-scale meshes), so
                // outside sculpt mode it is deferred until sculpt mode is entered.
                if (toolModeRef.current === 'sculpt') {
                    historyStackRef.current.pushState(meshCandidate.geometry);
                    historyBaselinePendingRef.current = null;
                } else {
                    historyBaselinePendingRef.current = meshCandidate;
                }
                setCanUndo(false);
                setCanRedo(false);
            }

            // Update gizmo transform immediately (world pose: the selection may be a part nested in a
            // moved model root, while the gizmo is a scene-level group)
            if (transformGizmoGroupRef.current && gizmoEngineRef.current && threeCameraRef.current) {
                const worldPos = new THREE.Vector3();
                const worldQuat = new THREE.Quaternion();
                readWorldPose(targetObj, worldPos, worldQuat);
                gizmoEngineRef.current.updateGizmoTransform(
                    transformGizmoGroupRef.current,
                    worldPos,
                    worldQuat,
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

    /** Re-centres the orbit on `targetObj` and pulls the camera to a distance that frames it. */
    const frameObject = React.useCallback((targetObj: THREE.Object3D) => {
        if (!targetObj || !threeCameraRef.current) return;
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
    }, []);

    const handleFocusObject = React.useCallback((targetObj: THREE.Object3D) => {
        if (!targetObj || !threeCameraRef.current) return;
        selectObject(targetObj);
        frameObject(targetObj);
    }, [selectObject, frameObject]);

    // Entering sculpt mode with a selection made elsewhere takes the deferred history baseline.
    React.useEffect(() => {
        const pending = historyBaselinePendingRef.current;
        if (toolMode !== 'sculpt' || !pending) return;
        historyBaselinePendingRef.current = null;
        if (sculptMeshRef.current !== pending || !pending.geometry) return;
        historyStackRef.current.clear();
        historyStackRef.current.pushState(pending.geometry);
        setCanUndo(false);
        setCanRedo(false);
    }, [toolMode]);

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
    const captureFrame = React.useCallback((): string | null => {
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
            // A scene shows only the geometry and settings its data holds. Nothing is added, dropped or re-themed
            // from words in the title (that rebuilt keyword templates next to, or instead of, the real objects).
            const effectiveWorldBranch = data.worldBranch;

            setSceneData({
                // Carry every field the data holds (splatUrl, vectorRoadmap, groundTileMode, ...); dropping them
                // left splat scenes without their splat and made a populated scene look empty.
                ...data,
                title: data.title || '4D Scene Workspace',
                subtitle: data.subtitle || 'Interactive 4D spatial viewport with temporal simulation solver',
                objects: data.objects || [],
                sceneType: data.sceneType,
                worldBranch: effectiveWorldBranch,
                camera: data.camera || { position: [15, 12, 15], target: [0, 0, 0] },
                environment: data.environment || { skybox: 'studio', lighting: 'studio', ground: true },
                features: data.features,
                customScript: data.customScript || data.code,
                pythonGenerator: data.pythonGenerator,
                cppGenerator: data.cppGenerator,
                shaders: data.shaders,
                customMeshes: data.customMeshes,
                timeline: data.timeline,
                animation: data.animation,
                geoAnchor: data.geoAnchor,
                droneRoute: data.droneRoute,
                renderMode: data.renderMode
            });

            if (effectiveWorldBranch) setWorldBranch(effectiveWorldBranch);
            if (data.renderMode) setRenderMode(data.renderMode);
            if (data.clayPreset) {
                if (threeSceneRef.current) {
                    TileClayProcessor.applyClayMaterial(threeSceneRef.current, data.clayPreset as any);
                }
            }
            if (data.cameraMode) setCameraMode(data.cameraMode);
            if (data.toolMode) setToolMode(data.toolMode);
            if (data.sculptSettings) setSculptSettings(prev => ({ ...prev, ...data.sculptSettings }));
            if (data.transformMode) setTransformMode(data.transformMode);
            if (data.transformSpace) setTransformSpace(data.transformSpace);

            // The anchor (and route) of this scene only: nothing carries over from a previous scene.
            if (data.geoAnchor && data.geoAnchor.lat !== undefined && data.geoAnchor.lng !== undefined) {
                setHasGeoCoordinates(data.geoAnchor.active !== false);
                setLat(String(data.geoAnchor.lat));
                setLng(String(data.geoAnchor.lng));
            } else if (data.geoAnchor && data.geoAnchor.active === false) {
                setHasGeoCoordinates(false);
            } else {
                const geoObj = data.objects?.find(o => o.space?.geoAnchor && o.space.geoAnchor.lat !== undefined && o.space.geoAnchor.lng !== undefined);
                setHasGeoCoordinates(!!geoObj?.space?.geoAnchor);
                setLat(geoObj?.space?.geoAnchor ? String(geoObj.space.geoAnchor.lat) : '');
                setLng(geoObj?.space?.geoAnchor ? String(geoObj.space.geoAnchor.lng) : '');
            }

            const route = data.droneRoute;
            const pinText = (v: unknown) => (v === undefined || v === null ? '' : String(v));
            setPinALat(pinText(route?.pinA?.lat));
            setPinALng(pinText(route?.pinA?.lng));
            setPinBLat(pinText(route?.pinB?.lat));
            setPinBLng(pinText(route?.pinB?.lng));
            setIsRoutingActive(!!(route?.pinA && route?.pinB && route.active));
            if (route?.pinA && route?.pinB && route.active) setIsPlaying(true);

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
                if (data.timeline.durationMs !== undefined) {
                    setDurationMs(data.timeline.durationMs);
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
    // A route pin on the ground plane, offset from the scene's anchor; null when either has no coordinates.
    const projectCoords = React.useCallback((latitude: unknown, longitude: unknown): THREE.Vector3 | null => {
        const p = projectRoutePoint({ lat, lng }, { lat: latitude, lng: longitude });
        return p ? new THREE.Vector3(p.x, 0, p.z) : null;
    }, [lat, lng]);

    const updatePinsAndRoute = React.useCallback(() => {
        if (!threeSceneRef.current || !geoGroupRef.current) return;
        const geoGroup = geoGroupRef.current;

        if (pinAMeshRef.current) { geoGroup.remove(pinAMeshRef.current); pinAMeshRef.current = null; }
        if (pinBMeshRef.current) { geoGroup.remove(pinBMeshRef.current); pinBMeshRef.current = null; }
        if (routePathMeshRef.current) { geoGroup.remove(routePathMeshRef.current); routePathMeshRef.current = null; }
        if (droneMeshRef.current) { geoGroup.remove(droneMeshRef.current); droneMeshRef.current = null; }

        if (!hasGeoCoordinates || !isRoutingActive) return;

        const pinAPos = projectCoords(pinALat, pinALng);
        const pinBPos = projectCoords(pinBLat, pinBLng);
        if (!pinAPos || !pinBPos) return;

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
            const py = 0.25 + heightArc;
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

        const drone = createDroneMesh();
        drone.position.copy(pinAPos);
        geoGroup.add(drone);
        droneMeshRef.current = drone;
    }, [hasGeoCoordinates, pinALat, pinALng, pinBLat, pinBLng, isRoutingActive, projectCoords]);

    React.useEffect(() => {
        updatePinsAndRoute();
    }, [updatePinsAndRoute]);

    // ---------------------------------------------------------
    // Geospatial Routing & Pins Management (Mock terrain removed)
    // ---------------------------------------------------------
    React.useEffect(() => {
        if (!threeSceneRef.current) return;
        if (hasGeoCoordinates && isRoutingActive) {
            if (!geoGroupRef.current) {
                const geoGroup = new THREE.Group();
                geoGroupRef.current = geoGroup;
                threeSceneRef.current.add(geoGroup);
            }
            updatePinsAndRoute();
        } else {
            if (geoGroupRef.current) {
                threeSceneRef.current.remove(geoGroupRef.current);
                geoGroupRef.current = null;
            }
            if (customGridHelperRef.current) {
                customGridHelperRef.current.visible = true;
            }
        }
    }, [hasGeoCoordinates, isRoutingActive, updatePinsAndRoute]);

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
    // In-flight external loads live in pendingExternalLoadsRef (declared with the variant/load state above).
    const pendingGeneratedGlbParsesRef = React.useRef(0);

    // Lets background visual verification wait for models to finish loading before it screenshots.
    React.useEffect(() => {
        if (typeof window === 'undefined') return;
        const pendingLoads = () => pendingExternalLoadsRef.current.size + pendingGeneratedGlbParsesRef.current;
        (window as any).__scratchbox_active_3d_scene_pending_loads = pendingLoads;
        return () => {
            if ((window as any).__scratchbox_active_3d_scene_pending_loads === pendingLoads) {
                delete (window as any).__scratchbox_active_3d_scene_pending_loads;
            }
        };
    }, []);
    const physicsRuntimeStateRef = React.useRef<PhysicsRuntimeState>(new Map());
    const activeSplatMeshesRef = React.useRef<Map<string, PhotorealGaussianSplatMesh>>(new Map());

    // Latest-value mirrors so the rAF loop / listeners never need to be re-bound
    const cameraModeRef = useLatest(cameraMode);
    const hasGeoCoordinatesRef = useLatest(hasGeoCoordinates);
    const isWasmActiveRef = useLatest(isWasmActive);
    const projectCoordsRef = useLatest(projectCoords);
    const selectObjectRef = useLatest(selectObject);
    const mutateSceneDataRef = useLatest(mutateSceneData);
    const dataRef = useLatest(data);
    // sceneDataRef is declared next to mutateSceneData above.

    // ---- Slice fingerprints -------------------------------------------------------
    const has3DTiles = React.useMemo(() => !!(
        (sceneData.geoAnchor && sceneData.geoAnchor.active !== false) ||
        sceneData.objects?.some(o => o.content?.type === 'map-3d')
    ), [sceneData.geoAnchor, sceneData.objects]);

    const effectiveGroundTileMode: GroundTileMode = React.useMemo(() => {
        if (sceneData.groundTileMode) return sceneData.groundTileMode;
        if (sceneData.environment?.groundTileMode) return sceneData.environment.groundTileMode;
        if (sceneData.vectorRoadmap?.groundTileMode) return sceneData.vectorRoadmap.groundTileMode;
        if (sceneData.vectorRoadmap?.groundBlueprint) return 'vector-roadmap-blueprint';
        if (sceneData.objects?.some(o => {
            const s = (o.content?.metadata?.source || '').toLowerCase();
            return s === 'googlevectortileservice' || s === 'google_vector_tile_service';
        })) return 'vector-world-clay';
        if (sceneData.objects?.some(o => {
            const s = (o.content?.metadata?.source || '').toLowerCase();
            return s === 'google3dtilesclay' || s === 'google_3d_tiles_clay';
        })) return 'photoreal-clay';
        if (sceneData.objects?.some(o => {
            const s = (o.content?.metadata?.source || '').toLowerCase();
            return s === 'google3dtilesfulltexture' || s === 'google_3d_tiles_full_texture';
        })) return 'photoreal-textured';
        if (has3DTiles) return renderMode === 'pbr' || renderMode === 'shaded' ? 'photoreal-textured' : 'photoreal-clay';
        return 'none';
    }, [
        sceneData.groundTileMode,
        sceneData.environment?.groundTileMode,
        sceneData.vectorRoadmap?.groundTileMode,
        sceneData.vectorRoadmap?.groundBlueprint,
        sceneData.objects,
        has3DTiles,
        renderMode
    ]);

    const hasExplicit3DTileObject = React.useMemo(() => Boolean(
        sceneData.objects?.some(o => {
            const s = (o.content?.metadata?.source || '').toLowerCase();
            return s === 'google3dtilesclay' || s === 'google_3d_tiles_clay' || s === 'google3dtilesfulltexture' || s === 'google_3d_tiles_full_texture';
        })
    ), [sceneData.objects]);

    const tilesAnchor = React.useMemo(() => liveTilesAnchor(sceneData), [sceneData.geoAnchor, sceneData.objects]);

    const tilesInput = React.useMemo<TilesLayerInput>(() => ({
        has3DTiles: !hasExplicit3DTileObject && has3DTiles && (effectiveGroundTileMode === 'photoreal-textured' || effectiveGroundTileMode === 'photoreal-clay'),
        geoAnchor: tilesAnchor,
        renderMode,
        groundTileMode: hasExplicit3DTileObject ? 'none' : effectiveGroundTileMode
    }), [hasExplicit3DTileObject, has3DTiles, tilesAnchor, renderMode, effectiveGroundTileMode]);
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
        terrainBiomes: sceneData.features?.terrainBiomes,
        contentRadiusMeters: generatedContentRadius ?? undefined
    }), [
        sceneData.environment?.skybox, sceneData.environment?.lighting, sceneData.environment?.ambientIntensity, sceneData.environment?.cinematicRig,
        sceneData.environment?.lightingKelvin, sceneData.environment?.ground, sceneData.environment?.fog,
        worldBranch, renderMode, hasGeoCoordinates, has3DTiles,
        sceneData.features?.atmosphericScattering, (sceneData as any).atmosphere, sceneData.features?.godRays, sceneData.features?.terrainBiomes,
        generatedContentRadius
    ]);
    const atmosphereFingerprint = React.useMemo(() => JSON.stringify(atmosphereInput), [atmosphereInput]);
    const atmosphereInputRef = useLatest(atmosphereInput);

    const cameraFingerprint = React.useMemo(() => JSON.stringify(sceneData.camera ?? null), [sceneData.camera]);

    const activeScript = sceneData.customScript || sceneData.code;
    const hasActiveScript = !!(activeScript && activeScript.trim().length > 0);
    const contentInput = React.useMemo<SceneContentInput>(() => ({
        hasActiveScript,
        // Live tiles count as content only when they are actually drawn: an anchor whose ground mode suppresses
        // them ('none', the vector modes) draws nothing, so such a scene can still be empty.
        has3DTiles: tilesInput.has3DTiles,
        hasCustomMeshes: Array.isArray(sceneData.customMeshes) && sceneData.customMeshes.length > 0,
        hasNonFallbackObjects: hasNonFallbackObjectContent(sceneData),
        hasCppGenerator: !!sceneData.cppGenerator?.glbBase64 || !!(sceneData.cppGenerator?.sourceCode && sceneData.cppGenerator.sourceCode.trim().length > 0),
        hasPythonGenerator: !!sceneData.pythonGenerator?.glbBase64 || !!(sceneData.pythonGenerator?.sourceCode && sceneData.pythonGenerator.sourceCode.trim().length > 0)
    }), [
        hasActiveScript, tilesInput.has3DTiles, sceneData.customMeshes, sceneData.objects, sceneData.splatUrl,
        sceneData.cppGenerator?.glbBase64, sceneData.cppGenerator?.sourceCode,
        sceneData.pythonGenerator?.glbBase64, sceneData.pythonGenerator?.sourceCode
    ]);
    const sceneContentKind = React.useMemo(() => classifySceneContent(contentInput), [contentInput]);
    const contentFingerprint = React.useMemo(() => JSON.stringify({
        ...contentInput,
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
    // execute_3d_python_script records its GLB both as the generator output (drawn by effect 5b) and as a
    // hero object pointing at the same file; drawing both stacked two copies of every generated model.
    const generatorGlbFile = React.useMemo(() => {
        const gen = sceneData.pythonGenerator?.glbBase64 ? sceneData.pythonGenerator
            : sceneData.cppGenerator?.glbBase64 ? sceneData.cppGenerator : undefined;
        return gen?.glbPath ? gen.glbPath.split('/').pop() : undefined;
    }, [sceneData.pythonGenerator?.glbBase64, sceneData.pythonGenerator?.glbPath, sceneData.cppGenerator?.glbBase64, sceneData.cppGenerator?.glbPath]);

    const externalObjectsFingerprint = React.useMemo(() => {
        const objs = (sceneData.objects?.map(o => ({
            id: o.id,
            uri: o.content?.durableUri,
            type: o.content?.type,
            space: o.space?.spatial3d,
            source: o.content?.metadata?.source,
            variantSet: variantSetKeyOf(o),
            prefetch: !!o.content?.metadata?.prefetch
        })) || []);
        if (sceneData.splatUrl) {
            objs.push({ id: '__primary_splat__', uri: sceneData.splatUrl, type: 'gaussian-splat', space: undefined, source: 'splatUrl', variantSet: undefined, prefetch: false });
        }
        return JSON.stringify({ objs, splatOptions: sceneData.splatOptions, effectiveGroundTileMode, activeVariants: activeVariantIds, retry: externalLoadRetryNonce, generatorGlbFile });
    }, [sceneData.objects, sceneData.splatUrl, sceneData.splatOptions, effectiveGroundTileMode, activeVariantIds, externalLoadRetryNonce, generatorGlbFile]);

    // ---- 1. Renderer stack, overlays, controls and the render loop (mount once) ----
    React.useEffect(() => {
        if (!viewportRef.current) return;
        const container = viewportRef.current;

        let stack: RendererStack;
        try {
            stack = createRendererStack({ container, cameraPosition: sceneDataRef.current.camera?.position });
        } catch (err: any) {
            console.error('WebGL Renderer Creation Failed:', err);
            setWebglError(`The 3D viewport could not start WebGL: ${err?.message || String(err)}`);
            return;
        }
        stackRef.current = stack;
        const { scene, camera, renderer } = stack;
        // Zero Default Fog: Atmosphere and fog are only applied when explicitly configured.
        scene.fog = null;
        threeSceneRef.current = scene;
        threeCameraRef.current = camera;
        threeRendererRef.current = renderer;
        customGridHelperRef.current = stack.gridHelper;
        (window as any).__SB_THREE__ = THREE;
        (window as any).__SB_TERRAIN_MANAGER__ = terrainManagerRef.current;
        (window as any).__SB_3D_CAMERA__ = camera;
        (window as any).__SB_3D_SCENE__ = scene;
        (window as any).__SB_3D_STACK__ = stack;
        (window as any).__SB_3D_SCENE_DATA__ = sceneData;
        (window as any).__SB_3D_CAMERA_TARGET__ = cameraTargetRef;
        (window as any).__SB_3D_CAMERA_ROTATION__ = cameraRotationRef;
        // Loaded models by object id, including detached (inactive variant) ones kept for instant switching.
        (window as any).__SB_3D_EXTERNAL_OBJECTS__ = externalObjectsMapRef.current;
        (window as any).__SB_SET_CAMERA_VIEW__ = (target: [number, number, number], rot: { theta: number; phi: number; distance: number }) => {
            if (cameraTargetRef.current) cameraTargetRef.current.set(target[0], target[1], target[2]);
            if (cameraRotationRef.current) {
                cameraRotationRef.current.theta = rot.theta;
                cameraRotationRef.current.phi = rot.phi;
                cameraRotationRef.current.distance = rot.distance;
            }
            stepCamera(camera, cameraModeRef.current, cameraRotationRef.current, cameraTargetRef.current, keysPressedRef.current);
        };

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
            target: cameraTargetRef,
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
        // Core Animation Loop
        // ---------------------------------------------------------
        let lastTickTime = performance.now();
        let lastHeadingUpdateTime = 0;
        const gizmoWorldPos = new THREE.Vector3();
        const gizmoWorldQuat = new THREE.Quaternion();

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
                const atmosphere = atmosphereRef.current;

                // 1–2. Sky dome, cloud shadows, aerial perspective, god rays
                skyDomeModuleRef.current?.update?.(t, deltaSec);
                terrainCloudShadowsRef.current?.update(t, skyDomeModuleRef.current?.sunDirection);
                aerialPerspectiveRef.current?.update(t, deltaSec);
                godRaysRef.current?.update?.(t, deltaSec);

                // Biome terrain dynamics
                terrainBiomeRef.current?.update?.(t, deltaSec);

                // 4. Custom shader uniforms
                tickCustomShaders(customShaderMaterialsRef.current, t, camera.position);

                // 5. Dynamic script hook
                dynamicScriptHooksRef.current?.update?.(t, deltaSec);

                // 6. Starfield rotation
                if (atmosphere?.starsMesh) {
                    atmosphere.starsMesh.rotation.y = t * 0.05;
                }

                // 7. 3D tiles streaming
                if (tilesRendererRef.current) {
                    tilesRendererRef.current.update(camera, renderer);
                }

                // 8. Drone flight telemetry
                const pinAPos = droneMeshRef.current ? projectCoordsRef.current(pinALatRef.current, pinALngRef.current) : null;
                const pinBPos = droneMeshRef.current ? projectCoordsRef.current(pinBLatRef.current, pinBLngRef.current) : null;
                if (hasGeoCoordinatesRef.current && isRoutingActiveRef.current && droneMeshRef.current && pinAPos && pinBPos) {
                    const progress = currentTimeMsRef.current / durationMsRef.current;
                    const tNorm = Math.max(0, Math.min(1, progress));
                    const ppx = pinAPos.x + tNorm * (pinBPos.x - pinAPos.x);
                    const ppz = pinAPos.z + tNorm * (pinBPos.z - pinAPos.z);
                    const heightArc = Math.sin(tNorm * Math.PI) * 4.0;
                    droneMeshRef.current.position.set(ppx, 0.25 + heightArc, ppz);
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

                // 9.5. Physics bodies (sb_add_physics) & property keyframes (sb_insert_keyframe)
                tickObjectAnimations(
                    sceneDataRef.current,
                    customMeshRegistryRef.current,
                    externalObjectsMapRef.current,
                    physicsRuntimeStateRef.current,
                    currentTimeMsRef.current,
                    deltaSec
                );

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

                // 12. Transform gizmo (hidden without a selection, e.g. after a variant switch cleared it;
                // a gizmo with no target is inert and would float over nothing)
                if (transformGizmoGroupRef.current) {
                    transformGizmoGroupRef.current.visible = toolModeRef.current === 'transform' && !!selectedObjectRef.current;
                    if (transformGizmoGroupRef.current.visible && selectedObjectRef.current) {
                        readWorldPose(selectedObjectRef.current, gizmoWorldPos, gizmoWorldQuat);
                        gizmoEngineRef.current.updateGizmoTransform(
                            transformGizmoGroupRef.current,
                            gizmoWorldPos,
                            gizmoWorldQuat,
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
                    // Detached (inactive variant) splats are not drawn, so skip their CPU sort.
                    if (splatMesh.parent && typeof splatMesh.updateDepthSort === 'function') {
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
            // Free loaded models (attached or detached variants) before the GL context goes away.
            // Every splat mesh is also registered in the external-object map, so this releases it
            // exactly once (through its own dispose()).
            externalObjectsMapRef.current.forEach(obj3d => releaseObject3D(obj3d));
            externalObjectsMapRef.current.clear();
            activeSplatMeshesRef.current.clear();
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
        setTilesError(null);
        const handle = syncTilesLayer(stack, tilesInputRef.current, {
            onLayerReady: (tilesLayer, terrainManager) => {
                tilesRendererRef.current = tilesLayer;
                terrainManagerRef.current = terrainManager;
            },
            onError: message => setTilesError(message),
            onRecovered: () => setTilesError(null),
            onTileLoaded: (terrainManager) => {
                const cppRoot = stack.scene?.getObjectByName('scratchbox-cpp-generated-root');
                if (cppRoot) {
                    terrainManager.snapObjectToGround(cppRoot, 0);
                }
                externalObjectsMapRef.current.forEach((model, id) => {
                    // Cached inactive variants are detached; they are seated when re-attached.
                    if (!model.parent) return;
                    const def = (sceneDataRef.current.objects || []).find(o => o.id === id);
                    const role = def?.content?.metadata?.role;
                    const source = (def?.content?.metadata?.source || '').toLowerCase();
                    const isEnv = role === 'environment' || def?.content?.metadata?.isGround || source.includes('google3dtiles') || source.includes('googlevectortile');
                    if (!isEnv) {
                        const s = def?.space?.spatial3d;
                        const offset = (s?.y !== undefined && s.y !== 0) ? s.y : 0;
                        terrainManager.snapObjectToGround(model, offset);
                    }
                });
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
            geoAnchor: sceneData.geoAnchor,
            groundTileMode: effectiveGroundTileMode
        });
        vectorRoadmapHandleRef.current = handle;
        return () => {
            handle.dispose();
            vectorRoadmapHandleRef.current = null;
        };
    }, [
        effectiveGroundTileMode,
        sceneData.vectorRoadmap?.enabled,
        sceneData.vectorRoadmap?.groundBlueprint,
        sceneData.vectorRoadmap?.groundBlueprintOpacity,
        sceneData.vectorRoadmap?.groundBlueprintSize,
        sceneData.vectorRoadmap?.groundElevationOffset,
        sceneData.vectorRoadmap?.mapId,
        sceneData.geoAnchor?.lat,
        sceneData.geoAnchor?.lng,
        sceneData.geoAnchor?.elevation,
        sceneData.geoAnchor?.elevationSource,
        sceneData.geoAnchor?.datum
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

        const bounds = computeSceneGeometryBounds(stack.scene);
        const autoFrame = calculateStandoffCamera(bounds, cameraDef, { fovDegrees: stack.camera.fov });

        if (autoFrame) {
            cameraTargetRef.current.set(autoFrame.target[0], autoFrame.target[1], autoFrame.target[2]);
            cameraRotationRef.current = { theta: autoFrame.theta, phi: autoFrame.phi, distance: autoFrame.distance };
            stack.camera.position.set(autoFrame.position[0], autoFrame.position[1], autoFrame.position[2]);
            stack.camera.lookAt(cameraTargetRef.current);
        } else {
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
        }
    }, [cameraFingerprint, tilesFingerprint]);

    // ---- 5. Focal content: splats / dynamic script ----
    React.useEffect(() => {
        const stack = stackRef.current;
        if (!stack) return;

        const executeScript: SceneContentFactories['executeScript'] = () => {
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
                aircraft: null,
                terrain: atmosphere?.terrainBiome?.terrainMesh,
                skyDome: atmosphere?.skyDomeObject ?? null,
                aerialPerspective: atmosphere?.aerialPerspective,
                cloudShadows: atmosphere?.terrainCloudShadows,
                godRays: atmosphere?.godRays?.group,
                contrails: null,
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
                createHighwayOverpassScene,
                createAlpineMatterhornScene,
                createBabylonianZigguratScene,
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
            contentInputRef.current,
            { createSplatViewer: () => new InHouseSplatViewer(), executeScript }
        );
        contentRef.current = handle;
        splatViewerRef.current = handle.splatViewer as InHouseSplatViewer;
        dynamicScriptHooksRef.current = handle.scriptHooks;
        setScriptError(handle.scriptError);

        // Rebuilt content: no sculpt target or selection carries over, and the sculpt history starts empty.
        sculptMeshRef.current = null;
        selectedObjectRef.current = null;
        historyStackRef.current.clear();
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

        // Auto-frame camera to procedural geometry bounds if initial camera or clipping
        const bounds = computeSceneGeometryBounds(stack.scene);
        const autoFrame = calculateStandoffCamera(bounds, sceneDataRef.current.camera, { fovDegrees: stack.camera.fov });
        if (autoFrame && autoFrame.autoFramed) {
            cameraTargetRef.current.set(autoFrame.target[0], autoFrame.target[1], autoFrame.target[2]);
            cameraRotationRef.current = { theta: autoFrame.theta, phi: autoFrame.phi, distance: autoFrame.distance };
            stack.camera.position.set(autoFrame.position[0], autoFrame.position[1], autoFrame.position[2]);
            stack.camera.lookAt(cameraTargetRef.current);
        }

        return () => {
            if (selectionBoxRef.current) selectionBoxRef.current.visible = false;
            handle.dispose();
            contentRef.current = null;
            splatViewerRef.current = null;
            dynamicScriptHooksRef.current = null;
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

    // ---- 5a-bis. Load or rebuild the Procedural Python Script's GLB if missing ----
    React.useEffect(() => {
        const pyGen = sceneData.pythonGenerator;
        if (!pyGen?.sourceCode || pyGen.glbBase64) return;
        // Saved scenes drop the base64 copy and keep the model as a file object; that object draws it.
        if (generatorFileIsObject(pyGen, sceneData.objects)) return;
        let isCancelled = false;
        const adopt = (patch: { glbBase64: string; glbPath?: string; lastCompiledTimeMs?: number }) => setSceneData(prev => ({
            ...prev,
            pythonGenerator: { ...prev.pythonGenerator, ...pyGen, ...patch }
        }));
        setGeneratorError(null);
        // Or they keep it as the runner's output file, served by the app; rebuild from the source only when it is gone.
        loadServedGeneratorGlb(pyGen.glbPath)
            .then(async saved => {
                if (isCancelled) return;
                if (saved) {
                    adopt({ glbBase64: saved });
                    return;
                }
                const res = await fetch('/3d/python/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ script: pyGen.sourceCode })
                });
                const resData = await res.json();
                if (isCancelled) return;
                const failure = generatorRunFailure('python', res.status, resData);
                if (failure) {
                    setGeneratorError(fromInput(failure, 'source', pyGen.sourceCode!));
                    return;
                }
                adopt({ glbBase64: resData.glbBase64, glbPath: resData.glbPath, lastCompiledTimeMs: Date.now() });
            })
            .catch(err => {
                if (!isCancelled) setGeneratorError(fromInput(generatorRequestFailure('python', err), 'source', pyGen.sourceCode!));
            });
        return () => { isCancelled = true; };
    }, [sceneData.pythonGenerator?.sourceCode]);

    // ---- 5a-ter. Auto-compile Procedural C++20 Script if GLB missing ----
    React.useEffect(() => {
        const cppGen = sceneData.cppGenerator;
        if (!cppGen?.sourceCode || cppGen.glbBase64) return;
        if (generatorFileIsObject(cppGen, sceneData.objects)) return;
        let isCancelled = false;
        setGeneratorError(null);
        fetch('/3d/compile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sourceCode: cppGen.sourceCode })
        })
            .then(async res => ({ status: res.status, resData: await res.json() }))
            .then(({ status, resData }) => {
                if (isCancelled) return;
                const failure = generatorRunFailure('cpp', status, resData);
                if (failure) {
                    setGeneratorError(fromInput(failure, 'source', cppGen.sourceCode!));
                    return;
                }
                setSceneData(prev => ({
                    ...prev,
                    cppGenerator: {
                        ...prev.cppGenerator,
                        ...cppGen,
                        glbBase64: resData.glbBase64,
                        glbPath: resData.glbPath,
                        vertexCount: resData.vertexCount,
                        triangleCount: resData.triangleCount,
                        lastCompiledTimeMs: Date.now()
                    }
                }));
            })
            .catch(err => {
                if (!isCancelled) setGeneratorError(fromInput(generatorRequestFailure('cpp', err), 'source', cppGen.sourceCode!));
            });
        return () => { isCancelled = true; };
    }, [sceneData.cppGenerator?.sourceCode]);

    // ---- 5b. Native C++ / Python Generated GLB Ingestion (Streaming 3D AST) ---------------
    React.useEffect(() => {
        const stack = stackRef.current;
        const glbBase64 = sceneData.pythonGenerator?.glbBase64 || sceneData.cppGenerator?.glbBase64;
        if (!stack || !glbBase64) return;
        const engine = sceneData.pythonGenerator?.glbBase64 ? 'python' : 'cpp';
        const reportUnreadable = (err: unknown) => setGeneratorError(fromInput({
            engine,
            message: `The generated model (GLB) could not be read: ${err instanceof Error ? err.message : String(err)}`
        }, 'glb', glbBase64));
        try {
            const b64 = glbBase64;
            const binaryStr = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) {
                bytes[i] = binaryStr.charCodeAt(i);
            }
            const loader = new GLTFLoader();
            pendingGeneratedGlbParsesRef.current++;
            loader.parse(bytes.buffer, '', (gltf) => {
                pendingGeneratedGlbParsesRef.current--;
                const scene = stack.scene;
                if (!scene) return;
                const existing = scene.getObjectByName('scratchbox-cpp-generated-root');
                if (existing) {
                    scene.remove(existing);
                }
                gltf.scene.name = 'scratchbox-cpp-generated-root';
                scene.add(gltf.scene);
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
                applyClayRenderMode([gltf.scene], renderModeRef.current === 'clay');
                // Shared metric ground logic: snap procedural geometry to terrain or 3D tile surface
                if (terrainManagerRef.current) {
                    terrainManagerRef.current.snapObjectToGround(gltf.scene, 0);
                }
                const generatedSphere = new THREE.Box3().setFromObject(gltf.scene).getBoundingSphere(new THREE.Sphere());
                if (Number.isFinite(generatedSphere.radius) && generatedSphere.radius > 0) {
                    setGeneratedContentRadius(Number(generatedSphere.radius.toPrecision(2)));
                }
                // Automatically frame camera around generated procedural geometry using calculateStandoffCamera
                const bounds = computeSceneGeometryBounds(stack.scene);
                const autoFrame = calculateStandoffCamera(bounds, sceneDataRef.current.camera, {
                    fovDegrees: stack.camera.fov,
                    force: true
                });
                if (autoFrame && stack.camera) {
                    cameraTargetRef.current.set(autoFrame.target[0], autoFrame.target[1], autoFrame.target[2]);
                    cameraRotationRef.current = { theta: autoFrame.theta, phi: autoFrame.phi, distance: autoFrame.distance };
                    stack.camera.position.set(autoFrame.position[0], autoFrame.position[1], autoFrame.position[2]);
                    stack.camera.lookAt(cameraTargetRef.current);
                    stack.camera.far = Math.max(stack.camera.far, autoFrame.distance * 5, 20000);
                    stack.camera.updateProjectionMatrix();
                }
                refreshEntities();
            }, (err) => {
                pendingGeneratedGlbParsesRef.current--;
                reportUnreadable(err);
            });
        } catch (e) {
            reportUnreadable(e);
        }
    }, [sceneData.pythonGenerator?.glbBase64, sceneData.cppGenerator?.glbBase64]);

    // ---- 5c. External Model & Gaussian Splat Objects Ingestion (sceneData.objects[].content.durableUri, sceneData.splatUrl) ----
    // Models load lazily: an object is fetched the first time it is shown, or up front when its
    // metadata sets `prefetch`. Inactive variants are DETACHED from the scene but stay cached in
    // externalObjectsMapRef, so picking, ground snapping, auto-framing and the outliner skip them
    // while switching back is instant (no re-download, GPU resources retained).
    const groundTileModeRef = useLatest({ effectiveGroundTileMode, hasExplicit3DTileObject });
    React.useEffect(() => {
        const stack = stackRef.current;
        if (!stack) return;
        const scene = stack.scene;
        if (!scene) return;

        const rawObjects = (sceneData.objects || []).filter(o =>
            !generatorGlbFile || o.content?.durableUri?.split('/').pop() !== generatorGlbFile);
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
        const pending = pendingExternalLoadsRef.current;
        const activeIds = new Set<string>();
        /** Set when a cached model is attached, detached or released here (loads refresh on their own). */
        let membershipChanged = false;

        // Async callbacks re-read the latest declarations: the data may change while a model downloads.
        const latestDef = (obj: Media4DObject): Media4DObject =>
            (sceneDataRef.current.objects || []).find(o => o.id === obj.id) || obj;
        /** True while `id` is still declared AND still points at `uri` (a result for an old URL is stale). */
        const isCurrentSource = (id: string, uri: string): boolean => {
            const def = (sceneDataRef.current.objects || []).find(o => o.id === id);
            const raw = def?.content?.durableUri ?? (id === 'primary-location-splat' ? sceneDataRef.current.splatUrl : undefined);
            return !!raw && resolveExternalModelUri(raw) === uri;
        };
        /** Detaches, frees and forgets a loaded model (attached or cached). */
        const releaseLoaded = (id: string, obj3d: THREE.Object3D) => {
            if (obj3d.parent) membershipChanged = true;
            activeSplatMeshesRef.current.delete(id);
            releaseObject3D(obj3d);
            currentMap.delete(id);
        };
        const isActiveNow = (obj: Media4DObject): boolean => {
            const key = variantSetKeyOf(obj);
            return !key || activeVariantIdsRef.current[key] === obj.id;
        };
        const setStatus = (id: string, status: ExternalLoadStatus) =>
            setExternalLoadStatus(prev => ({ ...prev, [id]: status }));
        /**
         * What a model's pose derives from: its authored transform and the ground it was seated on.
         * A ground-mode switch swaps the surface under a snapped hero (tiles torn down or replaced), so
         * it must fall back to its authored transform; re-runs that change neither (a variant switch,
         * a retry) must not undo a ground snap.
         */
        const seatKeyOf = (s: Media4DObject['space']['spatial3d'] | undefined): string =>
            JSON.stringify([s ?? null, groundTileModeRef.current]);
        const applySpatial = (target: THREE.Object3D, s: Media4DObject['space']['spatial3d'] | undefined) => {
            target.userData.sbSeatKey = seatKeyOf(s);
            if (!s) return;
            target.position.set(s.x ?? 0, s.y ?? 0, s.z ?? 0);
            if (s.pitch !== undefined) target.rotation.x = (s.pitch * Math.PI) / 180;
            if (s.yaw !== undefined) target.rotation.y = (s.yaw * Math.PI) / 180;
            if (s.roll !== undefined) target.rotation.z = (s.roll * Math.PI) / 180;
        };
        const isEnvironmentDef = (def: Media4DObject | undefined): boolean => {
            const role = def?.content?.metadata?.role;
            const src = (def?.content?.metadata?.source || '').toLowerCase();
            return role === 'environment' || !!def?.content?.metadata?.isGround || src.includes('google3dtiles') || src.includes('googlevectortile');
        };
        /**
         * Seats a model as it is attached (snapping is absolute, so re-seating is idempotent):
         * environment layers re-ground every attached hero; heroes snap onto the ground beneath them.
         */
        const settleOnGround = (model: THREE.Object3D, def: Media4DObject, liveScene: THREE.Scene) => {
            const terrainManager = terrainManagerRef.current;
            if (!terrainManager) return;
            if (isEnvironmentDef(def)) {
                const cppRoot = liveScene.getObjectByName('scratchbox-cpp-generated-root');
                if (cppRoot) terrainManager.snapObjectToGround(cppRoot, 0);
                currentMap.forEach((otherModel, otherId) => {
                    if (otherId === def.id || !otherModel.parent) return;
                    const otherDef = (sceneDataRef.current.objects || []).find(o => o.id === otherId);
                    if (isEnvironmentDef(otherDef)) return;
                    const os = otherDef?.space?.spatial3d;
                    terrainManager.snapObjectToGround(otherModel, (os?.y !== undefined && os.y !== 0) ? os.y : 0);
                });
            } else {
                const s = def.space?.spatial3d;
                if (s?.y === 0 || s?.y === undefined) terrainManager.snapObjectToGround(model, 0);
            }
        };
        const autoFrameIfNeeded = (force = false) => {
            const live = stackRef.current;
            if (!live) return;
            const bounds = computeSceneGeometryBounds(live.scene);
            const autoFrame = calculateStandoffCamera(bounds, sceneDataRef.current.camera, { fovDegrees: live.camera.fov, force });
            if (autoFrame && autoFrame.autoFramed) {
                cameraTargetRef.current.set(autoFrame.target[0], autoFrame.target[1], autoFrame.target[2]);
                cameraRotationRef.current = { theta: autoFrame.theta, phi: autoFrame.phi, distance: autoFrame.distance };
                live.camera.position.set(autoFrame.position[0], autoFrame.position[1], autoFrame.position[2]);
                live.camera.lookAt(cameraTargetRef.current);
            }
        };

        const loader = new GLTFLoader();

        objects.forEach(obj => {
            const rawUri = obj.content?.durableUri;
            if (!rawUri) return;
            const uri = resolveExternalModelUri(rawUri);
            const isSplat = obj.content?.type === 'gaussian-splat' || !!uri.match(/\.(splat|spz)($|\?)/i);
            const isGltf = !!uri.match(/\.(glb|gltf)($|\?)/i);
            if (!isSplat && !isGltf) return;
            activeIds.add(obj.id);

            const visibleForGroundMode = isVisibleForGroundMode(obj, effectiveGroundTileMode, hasExplicit3DTileObject);
            const variantKey = variantSetKeyOf(obj);
            const isActiveVariant = !variantKey || activeVariantIds[variantKey] === obj.id;

            const existing = currentMap.get(obj.id);
            // The object now points at another file: drop the stale model and load the new one below.
            if (existing && existing.userData.sbSourceUri !== uri) releaseLoaded(obj.id, existing);
            else if (existing) {
                existing.visible = visibleForGroundMode;
                const s = obj.space?.spatial3d;
                if (existing.userData.sbSeatKey !== seatKeyOf(s)) applySpatial(existing, s);
                if (isActiveVariant && existing.parent !== scene) {
                    scene.add(existing);
                    membershipChanged = true;
                    // Splats are never seated by their own load (only GLBs are), so a re-attach must
                    // not seat them either or they would jump on every re-activation.
                    if (!isSplat) settleOnGround(existing, obj, scene);
                } else if (!isActiveVariant && existing.parent) {
                    existing.parent.remove(existing);
                    membershipChanged = true;
                }
                return;
            }

            // Lazy: an inactive variant is fetched on first activation unless it opts into prefetch.
            if (!isActiveVariant && !obj.content?.metadata?.prefetch) return;
            // In-flight dedupe: fingerprint changes and StrictMode / HMR re-runs must not fetch or parse
            // the same file twice. A different URL for the id supersedes the request in flight.
            if (pending.get(obj.id) === uri) return;
            pending.set(obj.id, uri);
            /** Ends this request's claim on the id; false when a newer request for the id superseded it. */
            const settlePending = (): boolean => {
                if (pending.get(obj.id) !== uri) return false;
                pending.delete(obj.id);
                return true;
            };
            setStatus(obj.id, { phase: 'download', loaded: 0, total: 0 });

            if (isSplat) {
                PhotorealGaussianSplatMesh.fromUrl(uri, {
                    splatScale: sceneData.splatOptions?.splatScale ?? 1.0,
                    contactShadow: sceneData.splatOptions?.contactShadow ?? true,
                    enableRTC: sceneData.splatOptions?.enableRTC ?? true
                }).then(splatMesh => {
                    settlePending();
                    const liveScene = stackRef.current?.scene;
                    if (!liveScene || !isCurrentSource(obj.id, uri) || currentMap.has(obj.id)) {
                        splatMesh.dispose();
                        return;
                    }
                    const def = latestDef(obj);
                    splatMesh.name = `external-splat-${obj.id}`;
                    splatMesh.userData.sbSourceUri = uri;
                    applySpatial(splatMesh, def.space?.spatial3d);
                    if (isActiveNow(def)) liveScene.add(splatMesh);
                    currentMap.set(obj.id, splatMesh);
                    activeSplatMeshesRef.current.set(obj.id, splatMesh);
                    setStatus(obj.id, { phase: 'ready', loaded: 0, total: 0 });
                    refreshEntities();
                    if (splatMesh.parent) autoFrameIfNeeded();
                }).catch(err => {
                    if (settlePending()) setStatus(obj.id, { phase: 'error', loaded: 0, total: 0, error: String(err?.message ?? err) });
                    console.warn(`[External Splat Loader Error] Failed to load ${uri}:`, err);
                });
                return;
            }

            loader.load(
                uri,
                (gltf) => {
                    settlePending();
                    const model = gltf.scene;
                    // Use the LIVE stack: under StrictMode / HMR the scene captured by this effect run
                    // can belong to an already disposed renderer stack.
                    const liveStack = stackRef.current;
                    const liveScene = liveStack?.scene;
                    if (!liveStack || !liveScene || !isCurrentSource(obj.id, uri) || currentMap.has(obj.id)) {
                        disposeObject3DDeep(model);
                        return;
                    }
                    const def = latestDef(obj);
                    model.name = `${EXTERNAL_OBJECT_ROOT_PREFIX}${obj.id}`;
                    model.userData.sbSourceUri = uri;
                    model.userData.sbEnvironment = isEnvironmentDef(def);
                    applySpatial(model, def.space?.spatial3d);

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

                    const ground = groundTileModeRef.current;
                    model.visible = isVisibleForGroundMode(def, ground.effectiveGroundTileMode, ground.hasExplicit3DTileObject);
                    const attach = isActiveNow(def);
                    if (attach) liveScene.add(model);
                    model.updateMatrixWorld(true);
                    applyClayRenderMode([model], renderModeRef.current === 'clay');
                    currentMap.set(obj.id, model);
                    setStatus(obj.id, { phase: 'ready', loaded: 0, total: 0 });

                    if (attach) {
                        settleOnGround(model, def, liveScene);
                    } else {
                        // Prefetched but inactive (seated when first attached): compile its programs and
                        // upload its textures now so that first switch does not stall.
                        const renderer = liveStack.renderer;
                        renderer.compileAsync?.(model, liveStack.camera, liveScene).catch(() => undefined);
                        model.traverse(child => {
                            const mats = (child as THREE.Mesh).material;
                            for (const mat of Array.isArray(mats) ? mats : mats ? [mats] : []) {
                                for (const value of Object.values(mat)) {
                                    if (value && (value as THREE.Texture).isTexture) renderer.initTexture(value as THREE.Texture);
                                }
                            }
                        });
                    }

                    refreshEntities();
                    // A generated model's hero file is that model: frame and light it as effect 5b does for
                    // its base64 copy, since saved scenes keep only the file.
                    const isGeneratedHero = def.content?.metadata?.role === 'hero';
                    if (attach && isGeneratedHero) {
                        const sphere = new THREE.Box3().setFromObject(model).getBoundingSphere(new THREE.Sphere());
                        if (Number.isFinite(sphere.radius) && sphere.radius > 0) setGeneratedContentRadius(Number(sphere.radius.toPrecision(2)));
                    }
                    if (attach) autoFrameIfNeeded(isGeneratedHero);
                },
                (evt: ProgressEvent) => {
                    if (pending.get(obj.id) !== uri) return; // superseded by a newer URL
                    const now = performance.now();
                    const total = evt.lengthComputable ? evt.total : 0;
                    const downloaded = total > 0 && evt.loaded >= total;
                    if (!downloaded && now - (loadProgressStampRef.current[obj.id] || 0) < 200) return;
                    loadProgressStampRef.current[obj.id] = now;
                    setStatus(obj.id, { phase: downloaded ? 'parse' : 'download', loaded: evt.loaded, total });
                },
                (err) => {
                    if (settlePending()) setStatus(obj.id, { phase: 'error', loaded: 0, total: 0, error: String((err as any)?.message ?? err) });
                    console.warn(`[External Model Loader Error] Failed to load ${uri}:`, err);
                }
            );
        });

        // Cleanup removed objects (attached or detached). An in-flight load for a removed object no
        // longer counts as pending; its result is discarded when it lands (isCurrentSource fails).
        for (const id of [...pending.keys()]) {
            if (!activeIds.has(id)) pending.delete(id);
        }
        for (const [id, obj3d] of Array.from(currentMap.entries())) {
            if (!activeIds.has(id)) releaseLoaded(id, obj3d);
        }
        // Keep the outliner entities in step with what is actually in the scene after a cached switch.
        if (membershipChanged) refreshEntities();
        setExternalLoadStatus(prev => {
            const stale = Object.keys(prev).filter(id => !activeIds.has(id));
            if (stale.length === 0) return prev;
            const next = { ...prev };
            stale.forEach(id => delete next[id]);
            return next;
        });

        // A selection inside a model that was just detached or removed would leave the box helper
        // and gizmo floating over nothing.
        const selected = selectedObjectRef.current;
        if (selected && !isAttachedTo(selected, scene)) selectObjectRef.current(null);
        // Same for the sculpt target and its undo snapshots: the brush would hover invisible geometry,
        // S would snapshot a mesh that is not in the scene, and the copies (tens of MB on scan-scale
        // meshes) would stay pinned until the next selection.
        const pendingBaseline = historyBaselinePendingRef.current;
        if (pendingBaseline && findExternalObjectRoot(pendingBaseline) && !isAttachedTo(pendingBaseline, scene)) {
            historyBaselinePendingRef.current = null;
        }
        const sculptTarget = sculptMeshRef.current;
        if (sculptTarget && findExternalObjectRoot(sculptTarget) && !isAttachedTo(sculptTarget, scene)) {
            sculptMeshRef.current = null;
            historyStackRef.current.clear();
            setCanUndo(false);
            setCanRedo(false);
            if (brushCursorMeshRef.current) brushCursorMeshRef.current.visible = false;
        }
    }, [externalObjectsFingerprint]);

    React.useEffect(() => {
        const currentMap = externalObjectsMapRef.current;
        return () => {
            // Normally already emptied by the renderer-stack cleanup; kept as a safety net. The
            // pending-load map is deliberately NOT cleared: a load landing after a StrictMode / HMR
            // remount must still count as in flight (its onLoad re-checks the live stack).
            currentMap.forEach(obj3d => releaseObject3D(obj3d));
            currentMap.clear();
            activeSplatMeshesRef.current.clear();
        };
    }, []);

    // ---- 6. Custom meshes from schema (id-diffed, updated in place) ---------------
    React.useEffect(() => {
        const stack = stackRef.current;
        if (!stack) return;
        // Strict Tier-0 ban: suppress client-side toy primitives if native C++ or Python engine is configured
        const hasNativeEngine = !!(sceneData.pythonGenerator?.glbBase64 || sceneData.cppGenerator?.glbBase64 || sceneData.pythonGenerator?.sourceCode || sceneData.cppGenerator?.sourceCode);
        const meshesToSync = hasNativeEngine ? [] : (customMeshesRef.current as CustomMeshDefinition[] | undefined);
        syncCustomMeshes(stack, meshesToSync, customMeshRegistryRef.current, {
            terrainManager: terrainManagerRef.current,
            has3DTiles: tilesInputRef.current.has3DTiles
        });
        applyClayRenderMode(Array.from(customMeshRegistryRef.current.values(), e => e.mesh), renderModeRef.current === 'clay');
        refreshEntities();

        const bounds = computeSceneGeometryBounds(stack.scene);
        const autoFrame = calculateStandoffCamera(bounds, sceneDataRef.current.camera, { fovDegrees: stack.camera.fov });
        if (autoFrame && autoFrame.autoFramed) {
            cameraTargetRef.current.set(autoFrame.target[0], autoFrame.target[1], autoFrame.target[2]);
            cameraRotationRef.current = { theta: autoFrame.theta, phi: autoFrame.phi, distance: autoFrame.distance };
            stack.camera.position.set(autoFrame.position[0], autoFrame.position[1], autoFrame.position[2]);
            stack.camera.lookAt(cameraTargetRef.current);
        }
    }, [customMeshesFingerprint, tilesFingerprint]);

    React.useEffect(() => {
        const scene = stackRef.current?.scene;
        if (!scene) return;
        applyClayRenderMode([
            scene.getObjectByName('scratchbox-cpp-generated-root'),
            ...Array.from(customMeshRegistryRef.current.values(), e => e.mesh),
            ...Array.from(externalObjectsMapRef.current.values())
        ], renderMode === 'clay');
    }, [renderMode]);

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

    const handleScrubChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = parseFloat(e.target.value);
        currentTimeMsRef.current = val;
        setCurrentTimeMs(val);
    };

    const handleTogglePlay = () => {
        setIsPlaying(!isPlaying);
    };

    const handleTimelineSeek = React.useCallback((timeSec: number) => {
        const timeMs = Math.round(timeSec * 1000);
        currentTimeMsRef.current = timeMs;
        setCurrentTimeMs(timeMs);
    }, []);

    const handleUpdateTimelineTracks = React.useCallback((newTracks: TimelineTrack[]) => {
        mutateSceneData(prev => ({
            ...prev,
            timeline: {
                ...prev.timeline,
                tracks: newTracks
            }
        }), { operator: 'timeline_update_tracks', params: { trackCount: newTracks.length } });
    }, [mutateSceneData]);

    const timelineData: VideoTimelineData = React.useMemo(() => {
        const fps = 30;
        const durSec = durationMs / 1000;
        const curSec = currentTimeMs / 1000;

        if (sceneData.timeline?.tracks && sceneData.timeline.tracks.length > 0) {
            return {
                title: sceneData.title || '3D Scene Timeline',
                fps,
                duration: durSec,
                currentTime: curSec,
                isPlaying,
                zoom: timelineZoom,
                aspectRatio: '16:9',
                mediaAssets: [],
                tracks: sceneData.timeline.tracks
            };
        }

        const defaultTracks: TimelineTrack[] = [
            {
                id: 'track-3d-scene',
                name: '3D Scene & Camera',
                type: '3d',
                visible: true,
                locked: false,
                elements: [
                    {
                        id: 'clip-3d-main',
                        trackId: 'track-3d-scene',
                        name: sceneData.title || 'Main 3D Scene',
                        type: '3d',
                        startTime: 0,
                        duration: durSec,
                        trimStart: 0,
                        trimEnd: durSec,
                        keyframes: {
                            'camera.position': [
                                { id: 'kf-cam-0', time: 0, value: 0 },
                                { id: 'kf-cam-1', time: durSec * 0.5, value: 1 },
                                { id: 'kf-cam-2', time: durSec, value: 2 }
                            ],
                            'camera.fov': [
                                { id: 'kf-fov-0', time: 0, value: 45 },
                                { id: 'kf-fov-1', time: durSec, value: 60 }
                            ]
                        }
                    }
                ]
            }
        ];

        return {
            title: sceneData.title || '3D Scene Timeline',
            fps,
            duration: durSec,
            currentTime: curSec,
            isPlaying,
            zoom: timelineZoom,
            aspectRatio: '16:9',
            mediaAssets: [],
            tracks: defaultTracks
        };
    }, [sceneData.timeline?.tracks, sceneData.title, durationMs, currentTimeMs, isPlaying, timelineZoom]);

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
            groundTileMode: updated.groundTileMode !== undefined ? updated.groundTileMode : prev.groundTileMode,
            vectorRoadmap: {
                ...prev.vectorRoadmap,
                enabled: true,
                ...updated
            }
        }), { operator: 'UPDATE_VECTOR_ROADMAP', params: updated });
    }, [mutateSceneData]);

    const handleSelectGroundTileMode = React.useCallback((mode: GroundTileMode) => {
        mutateSceneData(prev => ({
            ...prev,
            groundTileMode: mode,
            vectorRoadmap: {
                ...prev.vectorRoadmap,
                groundTileMode: mode,
                groundBlueprint: mode === 'vector-roadmap-blueprint' ? true : prev.vectorRoadmap?.groundBlueprint
            }
        }), { operator: 'SET_GROUND_TILE_MODE', params: { groundTileMode: mode } });
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

    const handleApplyClayPresetToScene = React.useCallback((preset: ClayPresetId) => {
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

    // Fit Viewport to Scene Geometry (Frame All)
    const handleFitToView = React.useCallback(() => {
        const stack = stackRef.current;
        if (!stack?.scene) return;
        const bounds = computeSceneGeometryBounds(stack.scene);
        const autoFrame = calculateStandoffCamera(bounds, undefined, {
            fovDegrees: stack.camera.fov,
            force: true
        });
        if (autoFrame) {
            cameraTargetRef.current.set(autoFrame.target[0], autoFrame.target[1], autoFrame.target[2]);
            cameraRotationRef.current = { theta: autoFrame.theta, phi: autoFrame.phi, distance: autoFrame.distance };
            stack.camera.far = Math.max(stack.camera.far, autoFrame.distance * 5, 20000);
            stack.camera.updateProjectionMatrix();
            stack.camera.position.set(autoFrame.position[0], autoFrame.position[1], autoFrame.position[2]);
            stack.camera.lookAt(cameraTargetRef.current);
        }
    }, []);

    React.useEffect(() => {
        const onFit = () => handleFitToView();
        window.addEventListener('sb-3d-fit-to-view', onFit);
        return () => window.removeEventListener('sb-3d-fit-to-view', onFit);
    }, [handleFitToView]);

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
                if (toolMode === 'sculpt') {
                    setSculptSettings(s => ({ ...s, brush: 'flatten' }));
                } else {
                    e.preventDefault();
                    // Frame the selection when there is a visible one, otherwise the whole scene.
                    const selected = selectedObjectRef.current;
                    if (selected && selectionBoxRef.current?.visible) frameObject(selected);
                    else handleFitToView();
                }
            }
        };

        window.addEventListener('keydown', handleGlobalKeyDown);
        return () => {
            window.removeEventListener('keydown', handleGlobalKeyDown);
        };
    }, [handleUndo, handleRedo, cameraMode, toolMode, handleFitToView, frameObject]);

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

    // Selection readout: recomputed when the selected object changes (name/id state is set alongside the ref).
    const selectedUuid = selectedObjectRef.current?.uuid;
    const selectionSummary = React.useMemo(
        () => (selectedObjectId ? summarizeObjectGeometry(selectedObjectRef.current) : null),
        [selectedObjectId, selectedObjectName, selectedUuid]
    );
    // Loaded-model root of the selection: a click picks parts, so the chip offers the whole model
    // (the same as alt-click) and names a selected root by its objects[] label instead of its node name.
    const selectedModelRoot = selectedObjectId ? findExternalObjectRoot(selectedObjectRef.current) : null;
    const selectedModelLabel = React.useMemo(() => {
        if (!selectedModelRoot) return '';
        const objectId = externalObjectIdOf(selectedModelRoot);
        const def = sceneData.objects?.find(o => o.id === objectId);
        return String(def?.content?.metadata?.variantLabel ?? objectId);
    }, [selectedModelRoot, sceneData.objects]);
    const isModelRootSelected = !!selectedModelRoot && selectedModelRoot === selectedObjectRef.current;
    const selectionChipLabel = isModelRootSelected ? selectedModelLabel : (selectedObjectName || selectedObjectId || '');
    const switchableVariantSets = React.useMemo(() => variantSets.filter(set => set.members.length >= 2), [variantSets]);

    // Active Feature Chips for Glass Badge
    const activeFeatureBadges = React.useMemo(() => {
        const badges: string[] = [];
        if (sceneData.features?.godRays) badges.push('God Rays');
        if (sceneData.features?.controlSurfaces) badges.push('Articulated');
        if (sceneData.features?.contrails) badges.push('Contrails');
        if (sceneData.features?.terrainBiomes) badges.push('Biomes');
        if (sceneData.features?.atmosphericScattering) badges.push('Atmosphere');
        if (sceneData.customScript || sceneData.code) badges.push('Dynamic Script');
        return badges;
    }, [sceneData.features, sceneData.customScript, sceneData.code]);

    // Only an error about the scene's current generator source or model; a later version that fixed it clears it.
    const currentGeneratorError = generatorErrorForScene(generatorError, sceneData);
    // Objects the loader skips (an image, internal:plane) and models that failed to download or parse are said in
    // the viewport, not only in the console or the variant switcher.
    const undrawableObjects = React.useMemo(() => undrawableSceneObjects(sceneData), [sceneData.objects]);
    const objectLoadErrors = React.useMemo(() => {
        const declared = new Set((sceneData.objects || []).map(o => o.id));
        if (sceneData.splatUrl) declared.add('primary-location-splat');
        return Object.entries(externalLoadStatus)
            .filter(([id, st]) => st.phase === 'error' && declared.has(id))
            .map(([id, st]) => ({ id, error: st.error || 'the file could not be loaded' }));
    }, [externalLoadStatus, sceneData.objects, sceneData.splatUrl]);
    const drawsBiomeTerrain = drawsProceduralBiomeTerrain({ renderMode, terrainBiomes: sceneData.features?.terrainBiomes, hasGeoCoordinates, has3DTiles });
    const viewportNotices = React.useMemo(() => resolveViewportNotice({
        webglError,
        generatorError: currentGeneratorError,
        tilesError,
        contentKind: sceneContentKind,
        hasAuxiliaryContent: !!sceneData.vectorRoadmap?.groundBlueprint || wantsWasmMesh || drawsBiomeTerrain,
        objectLoadErrors,
        undrawableObjects
    }), [webglError, currentGeneratorError, tilesError, sceneContentKind, sceneData.vectorRoadmap?.groundBlueprint, wantsWasmMesh, drawsBiomeTerrain, objectLoadErrors, undrawableObjects]);

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
        <div className="sb-scene3d-primitive-container relative w-full h-full bg-[#b0b8c4] text-zinc-100 overflow-hidden select-none">
            {/* CONTAINERIZED 3D VIEWPORT CANVAS - Full-Bleed 100% */}
            <div className="sb-3d-viewport-frame absolute inset-0 w-full h-full bg-[#b0b8c4] overflow-hidden">
                {!webglError && (
                    <div
                        ref={viewportRef}
                        className="sb-3d-viewport-canvas-container absolute inset-0 w-full h-full block cursor-grab active:cursor-grabbing"
                        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%' }}
                    />
                )}
                <ViewportNotice notices={viewportNotices} />
            </div>

            {/* Precision Creative Vertical Tool Strip (Left Docked - 50% Compact Scale) */}
            <div className="sb-3d-toolstrip absolute top-16 left-3 z-20 flex flex-col items-center gap-0.5 p-1 rounded-xl bg-[#121216]/85 backdrop-blur-2xl border border-white/10 shadow-2xl pointer-events-auto select-none animate-fadeIn">
                {/* 1. Selection / Orbit Camera (V) */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md transition-all ${
                        toolMode === 'view'
                            ? 'sb-3d-toolstrip-btn-active bg-blue-600/30 text-blue-300 border border-blue-500/50 shadow-md shadow-blue-900/30'
                            : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5 border border-transparent'
                    }`}
                    onClick={() => setToolMode('view')}
                    title="Selection / Camera Orbit (V)"
                >
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 3l7 18 3-7 7-3L3 3z" />
                    </svg>
                </button>

                {/* Fit to View / Frame All (F) */}
                <button
                    type="button"
                    className="sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-white/5 border border-transparent transition-all"
                    onClick={handleFitToView}
                    title="Fit Viewport to Scene / Frame All (F)"
                >
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                    </svg>
                </button>

                {/* 2. Translate / Move (W) */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md transition-all ${
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
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20" />
                    </svg>
                </button>

                {/* 3. Rotate (E) */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md transition-all ${
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
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                    </svg>
                </button>

                {/* 4. Scale (R) */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md transition-all ${
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
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                    </svg>
                </button>

                {/* Divider */}
                <div className="sb-3d-toolstrip-divider w-3.5 h-[1px] bg-white/10 my-0.5" />

                {/* 5. Sculpt Draw (B) */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md transition-all ${
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
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18.375 2.625a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.375-9.375z" />
                        <path d="M14 6l4 4" />
                    </svg>
                </button>

                {/* 6. Sculpt Grab (G) */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md transition-all ${
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
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v4" />
                        <path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v6" />
                        <path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8" />
                        <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
                    </svg>
                </button>

                {/* 7. Sculpt Clay Strips (C) */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md transition-all ${
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
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="4" width="18" height="4" rx="1" />
                        <rect x="3" y="10" width="18" height="4" rx="1" />
                        <rect x="3" y="16" width="18" height="4" rx="1" />
                    </svg>
                </button>

                {/* 8. Sculpt Smooth (S) */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md transition-all ${
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
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
                    </svg>
                </button>

                {/* 9. Sculpt Inflate (I) */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md transition-all ${
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
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="6" />
                        <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                    </svg>
                </button>

                {/* 10. Sculpt Pinch (P) */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md transition-all ${
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
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M7 17l5-5-5-5M17 17l-5-5 5-5" />
                    </svg>
                </button>

                {/* 11. Sculpt Flatten (F) */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md transition-all ${
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
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 18h16M7 14l5-8 5 8H7z" />
                    </svg>
                </button>

                {/* Divider */}
                <div className="sb-3d-toolstrip-divider w-3.5 h-[1px] bg-white/10 my-0.5" />

                {/* 12. Wireframe Toggle */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md transition-all ${
                        sculptSettings.wireframeOverlay
                            ? 'sb-3d-toolstrip-btn-active bg-blue-600/30 text-blue-300 border border-blue-500/50 shadow-md shadow-blue-900/30'
                            : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5 border border-transparent'
                    }`}
                    onClick={() => setSculptSettings(s => ({ ...s, wireframeOverlay: !s.wireframeOverlay }))}
                    title="Toggle Wireframe Overlay"
                >
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2l10 6.5v7L12 22 2 15.5v-7L12 2z" />
                        <path d="M12 22V12M2 8.5l10 3.5 10-3.5" />
                    </svg>
                </button>

                {/* 13. Undo (⌘Z) */}
                <button
                    type="button"
                    disabled={!canUndo}
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md transition-all ${
                        canUndo
                            ? 'text-zinc-300 hover:text-white hover:bg-white/10 border border-transparent'
                            : 'text-zinc-600 cursor-not-allowed border border-transparent opacity-40'
                    }`}
                    onClick={handleUndo}
                    title="Undo Stroke (⌘Z / Ctrl+Z)"
                >
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 7v6h6M3 13a9 9 0 1 1 3 7.7" />
                    </svg>
                </button>

                {/* 14. Redo (⌘⇧Z) */}
                <button
                    type="button"
                    disabled={!canRedo}
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md transition-all ${
                        canRedo
                            ? 'text-zinc-300 hover:text-white hover:bg-white/10 border border-transparent'
                            : 'text-zinc-600 cursor-not-allowed border border-transparent opacity-40'
                    }`}
                    onClick={handleRedo}
                    title="Redo Stroke (⌘⇧Z / Ctrl+Y)"
                >
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 7v6h-6M21 13a9 9 0 1 0-3 7.7" />
                    </svg>
                </button>

                {/* Divider */}
                <div className="sb-3d-toolstrip-divider w-3.5 h-[1px] bg-white/10 my-0.5" />

                {/* 15. Inspector / Properties Toggle */}
                <button
                    type="button"
                    className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md transition-all ${
                        isInspectorOpen
                            ? 'sb-3d-toolstrip-btn-active bg-blue-600/30 text-blue-300 border border-blue-500/50 shadow-md shadow-blue-900/30'
                            : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5 border border-transparent'
                    }`}
                    onClick={() => setIsInspectorOpen(!isInspectorOpen)}
                    title="Toggle Numeric Precision Inspector & Hierarchy"
                >
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="4" y1="21" x2="4" y2="14" />
                        <line x1="4" y1="10" x2="4" y2="3" />
                        <line x1="12" y1="21" x2="12" y2="12" />
                        <line x1="12" y1="8" x2="12" y2="3" />
                        <line x1="20" y1="21" x2="20" y2="16" />
                        <line x1="20" y1="12" x2="20" y2="3" />
                        <line x1="1" y1="14" x2="7" y2="14" />
                        <line x1="9" y1="8" x2="15" y2="8" />
                        <line x1="17" y1="16" x2="23" y2="16" />
                    </svg>
                </button>
            </div>

            {/* Ultra-Minimalist Floating Top-Right Controls */}
            <div className="sb-3d-minimal-badge-container absolute top-3 right-3 z-20 flex items-center gap-2 pointer-events-auto select-none animate-fadeIn">
                <button
                    type="button"
                    onClick={handleFitToView}
                    className="sb-3d-minimal-badge flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#121216]/80 hover:bg-[#1f1f28] backdrop-blur-md border border-white/10 text-[10px] font-mono text-zinc-300 hover:text-white transition-all shadow-md cursor-pointer"
                    title="Fit Viewport to Scene Geometry (Press 'F')"
                >
                    <svg className="w-3 h-3 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                    </svg>
                    <span>Fit to View (F)</span>
                </button>
                <div className="sb-3d-minimal-badge flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#121216]/80 backdrop-blur-md border border-white/10 text-[10px] font-mono text-zinc-300 shadow-md">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                    <span>3D Scene</span>
                </div>
                {(() => {
                    const badge = sceneData.geoAnchor && sceneData.geoAnchor.active !== false ? groundDatumBadge(sceneData.geoAnchor) : null;
                    return badge && (
                        <div
                            data-testid="sb-ground-datum-badge"
                            className="sb-3d-minimal-badge flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#121216]/80 backdrop-blur-md border border-cyan-500/30 text-[10px] font-mono text-cyan-300 shadow-md"
                            title={badge.title}
                        >
                            <span className="text-cyan-400">🌐</span>
                            <span>{badge.text}</span>
                        </div>
                    );
                })()}
                {scriptError && (
                    <div className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-950/70 border border-amber-500/40 text-[10px] text-amber-200 shrink-0">
                        <span className="text-amber-400">⚠</span>
                        <span className="font-mono truncate max-w-[120px]">{scriptError}</span>
                    </div>
                )}
            </div>

            {/* Variant switchers + selection readout. Own column under the badge row (which unified-ui.css
                caps in width and keeps on one line); styled inline because packages/core is not run
                through Tailwind. */}
            {(switchableVariantSets.length > 0 || (selectedObjectId && selectionSummary)) && (
                <div className="sb-3d-variant-hud" style={HUD_COLUMN_STYLE}>
                    {switchableVariantSets.map(set => (
                        <div
                            key={set.key}
                            data-testid="sb-3d-variant-switcher"
                            data-variant-set={set.key}
                            role="group"
                            aria-label={set.key}
                            style={{ ...HUD_PILL_STYLE, flexWrap: 'wrap', justifyContent: 'flex-end', gap: 2, padding: 2, borderRadius: 14 }}
                        >
                            {set.members.map(member => {
                                const isActive = activeVariantIds[set.key] === member.id;
                                const status = externalLoadStatus[member.id];
                                const statusText = formatLoadStatus(status);
                                const label = String(member.content?.metadata?.variantLabel ?? member.id);
                                return (
                                    <button
                                        className="sb-hud-segment"
                                        key={member.id}
                                        type="button"
                                        data-variant-object-id={member.id}
                                        aria-pressed={isActive}
                                        onClick={() => {
                                            setVariantChoice(prev => ({ ...prev, [set.key]: member.id }));
                                            // Choosing a variant whose load failed retries it (the choice alone may not change).
                                            if (status?.phase === 'error') setExternalLoadRetryNonce(n => n + 1);
                                        }}
                                        title={status?.phase === 'error' ? `${label}: failed to load (${status.error}). Click to retry.` : label}
                                        style={isActive ? { ...HUD_SEGMENT_STYLE, ...HUD_SEGMENT_ACTIVE_STYLE } : HUD_SEGMENT_STYLE}
                                    >
                                        <span>{label}</span>
                                        {statusText && (
                                            <span style={{ color: status?.phase === 'error' ? '#fbbf24' : '#a1a1aa', fontVariantNumeric: 'tabular-nums' }}>{statusText}</span>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    ))}
                    {selectedObjectId && selectionSummary && (
                        <div
                            data-testid="sb-3d-selection-chip"
                            title={`${selectionChipLabel} · ${selectionSummary.meshes} mesh(es) · ${selectionSummary.vertices.toLocaleString()} vertices · ${selectionSummary.triangles.toLocaleString()} triangles (F frames it)`}
                            style={{ ...HUD_PILL_STYLE, gap: 6, padding: '3px 4px 3px 10px', borderRadius: 9999, borderColor: 'rgba(34, 211, 238, 0.35)' }}
                        >
                            <span style={{ width: 6, height: 6, borderRadius: 9999, background: '#22d3ee', flexShrink: 0 }} />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{selectionChipLabel}</span>
                            {selectionSummary.meshes > 0 && (
                                <span style={{ color: '#a1a1aa', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                                    {selectionSummary.vertices.toLocaleString()} v · {selectionSummary.triangles.toLocaleString()} tris
                                </span>
                            )}
                            {selectedModelRoot && !isModelRootSelected && (
                                <button
                                    className="sb-hud-segment"
                                    type="button"
                                    data-testid="sb-3d-select-model-root"
                                    onClick={() => selectObject(selectedModelRoot)}
                                    title={`Select the whole model: ${selectedModelLabel} (Alt-click)`}
                                    aria-label="Select the whole model"
                                    style={{ ...HUD_SEGMENT_STYLE, height: 16, padding: '0 6px', borderColor: 'rgba(255, 255, 255, 0.18)' }}
                                >
                                    Whole model
                                </button>
                            )}
                            <button
                                className="sb-hud-segment"
                                type="button"
                                onClick={() => selectObject(null)}
                                title="Clear selection"
                                aria-label="Clear selection"
                                style={{ ...HUD_SEGMENT_STYLE, width: 16, height: 16, padding: 0, justifyContent: 'center' }}
                            >
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                                    <path d="M18 6L6 18M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                    )}
                </div>
            )}

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

            {/* Numeric Precision Inspector & Scene Hierarchy Drawer */}
            <NumericPrecisionInspector
                isOpen={isInspectorOpen}
                onToggleOpen={() => setIsInspectorOpen(false)}
                selectedObjectId={selectedObjectId}
                selectedObjectName={selectedObjectName}
                sceneData={sceneData}
                mutateSceneData={mutateSceneData}
                onSelectObject={(id) => {
                    if (id && threeSceneRef.current) {
                        const target = threeSceneRef.current.getObjectByName(id) ||
                                       customMeshRegistryRef.current.get(id)?.mesh ||
                                       // an objects[] id resolves to its loaded-model root
                                       threeSceneRef.current.getObjectByName(`${EXTERNAL_OBJECT_ROOT_PREFIX}${id}`) || null;
                        selectObject(target);
                    } else {
                        selectObject(null);
                    }
                }}
                threeObject={selectedObjectRef.current}
            />

            {/* Ultra-Sleek Floating Bottom Scrubber Pill */}
            <div className={`sb-3d-timeline-scrubber absolute ${isTimelineDrawerOpen ? 'bottom-[255px]' : 'bottom-4'} left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 px-4 py-2 rounded-full bg-[#121216]/85 backdrop-blur-2xl border border-white/10 shadow-2xl select-none transition-all duration-300 animate-fadeIn`}>
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
                <button
                    type="button"
                    onClick={() => setIsTimelineDrawerOpen(!isTimelineDrawerOpen)}
                    className={`sb-3d-tracks-btn ${isTimelineDrawerOpen ? 'active' : ''}`}
                    title={isTimelineDrawerOpen ? 'Collapse Animation Timeline' : 'Open Animation Timeline Tracks'}
                >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="2" y="4" width="20" height="16" rx="2" />
                        <path d="M10 4v16M2 12h20" />
                    </svg>
                    <span>{isTimelineDrawerOpen ? 'Hide Tracks' : 'Tracks'}</span>
                </button>
            </div>

            {/* Docked Animation Sequencer (Reusing VideoTimelineTracks) */}
            {isTimelineDrawerOpen && (
                <div className="sb-3d-docked-timeline absolute bottom-0 left-0 right-0 z-30 flex flex-col bg-zinc-950/95 backdrop-blur-xl border-t border-zinc-800 shadow-2xl h-[245px] overflow-hidden animate-slideUp">
                    {/* Top Control Bar */}
                    <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900/90 border-b border-zinc-800 text-xs text-zinc-300 select-none shrink-0">
                        <div className="flex items-center gap-2">
                            <span className="font-semibold text-zinc-100 flex items-center gap-1.5 text-[11.5px]">
                                <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                                3D Animation Sequencer
                            </span>
                            <span className="text-[10px] text-zinc-400 font-mono">
                                ({(currentTimeMs / 1000).toFixed(2)}s / {(durationMs / 1000).toFixed(2)}s)
                            </span>
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => setTimelineSnapping(!timelineSnapping)}
                                className={`sb-btn sb-segment-btn px-2 py-0.5 rounded text-[10.5px] font-medium border transition-colors ${
                                    timelineSnapping
                                        ? 'bg-blue-600/30 text-blue-300 border-blue-500/40'
                                        : 'bg-zinc-800 text-zinc-400 border-zinc-700'
                                }`}
                                title="Toggle magnetic snapping"
                            >
                                Snap {timelineSnapping ? 'ON' : 'OFF'}
                            </button>
                            <div className="flex items-center gap-1 text-[10.5px] text-zinc-400">
                                <span>Zoom</span>
                                <input
                                    type="range"
                                    min="20"
                                    max="120"
                                    value={timelineZoom}
                                    onChange={e => setTimelineZoom(Number(e.target.value))}
                                    className="w-14 h-1 bg-zinc-800 rounded accent-blue-500 cursor-pointer"
                                />
                            </div>
                            <button
                                type="button"
                                onClick={() => setIsTimelineDrawerOpen(false)}
                                className="sb-btn sb-icon-button p-0.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
                                title="Close Timeline Drawer"
                            >
                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M18 6L6 18M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                    </div>

                    {/* Reused VideoTimelineTracks Canvas */}
                    <div className="flex-1 overflow-hidden relative">
                        <VideoTimelineTracks
                            data={timelineData}
                            onUpdateTracks={handleUpdateTimelineTracks}
                            onSeek={handleTimelineSeek}
                            onSelectClip={(clipId) => setSelectedClipId(clipId)}
                            selectedClipId={selectedClipId}
                            activeTool={timelineActiveTool}
                            snappingEnabled={timelineSnapping}
                            zoom={timelineZoom}
                        />
                    </div>
                </div>
            )}
        </div>
    );
};
