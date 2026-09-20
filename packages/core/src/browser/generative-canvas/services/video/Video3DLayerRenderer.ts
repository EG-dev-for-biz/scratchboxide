/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Scene3DData, Media4DObject } from '../../canvas-types';
import type {
    TimelineElement,
    ThreeCameraConfig,
    ThreeLightConfig,
    CameraSolveTrack,
    GeodeticEphemerisAnchor,
    VfxPlateConfig
} from './videoTypes';
import {
    VfxPlateMatchmoveService,
    type InterpolatedCameraPose,
    type SolarLightingResult
} from './VfxPlateMatchmoveService';
import { LensDistortionEffect } from '../optics/LensDistortionEffect';
import { CinematicBokehPass } from '../optics/CinematicBokehPass';
import { PhysicalCameraModel } from '../../../../common/optics/PhysicalCameraModel';
import type {
    PhysicalCameraConfig,
    FocusTargetDefinition
} from '../../../../common/optics/physical-camera-protocol';

export interface Video3DLayerConfig {
    width?: number;
    height?: number;
    renderer?: THREE.WebGLRenderer;
}

/**
 * Offscreen 3D scene layer renderer for VideoTimelinePrimitive.
 * Composites actual project 3D scenes (Scene3DData), glTF models (.glb),
 * and skeletal/morph animations into the video timeline without presets.
 */
export class Video3DLayerRenderer {
    private width: number;
    private height: number;
    private renderer: THREE.WebGLRenderer;
    private ownsRenderer: boolean;

    private scene: THREE.Scene;
    private camera: THREE.PerspectiveCamera;
    private renderTarget: THREE.WebGLRenderTarget;

    // Lighting group for dynamic or scene lights
    private lightGroup: THREE.Group;

    // Model and Scene Caches (keyed by asset path, url, or artifact ID)
    private loadedScenes = new Map<string, THREE.Group>();
    private loadedModels = new Map<string, THREE.Object3D>();
    private mixerCache = new Map<string, THREE.AnimationMixer>();
    private clipNamesCache = new Map<string, string[]>();

    // Active object and mixer
    private currentRoot: THREE.Object3D | null = null;
    private currentMixer: THREE.AnimationMixer | null = null;

    // Material override for wireframe preview
    private wireframeMaterial: THREE.MeshBasicMaterial;

    // Material override for foreground depth holdout
    private holdoutMaterial: THREE.MeshBasicMaterial;

    // Optical Lens Distortion post-processing effect and composite target
    private lensDistortionEffect: LensDistortionEffect | null = null;
    private distortedRenderTarget: THREE.WebGLRenderTarget | null = null;

    // Cinematic Depth-of-Field and Bokeh post-processing pass
    private cinematicBokehPass: CinematicBokehPass | null = null;
    private bokehedRenderTarget: THREE.WebGLRenderTarget | null = null;
    private activePhysicalCameraConfig: PhysicalCameraConfig | null = null;
    private currentFocusDistanceMeters: number = 5.0;
    private focusTargetPosition: [number, number, number] | null = null;

    constructor(config: Video3DLayerConfig = {}) {
        this.width = config.width || 1280;
        this.height = config.height || 720;

        if (config.renderer) {
            this.renderer = config.renderer;
            this.ownsRenderer = false;
        } else {
            const canvas = typeof document !== 'undefined'
                ? document.createElement('canvas')
                : ({} as any);
            this.renderer = new THREE.WebGLRenderer({
                canvas,
                alpha: true,
                antialias: true,
                preserveDrawingBuffer: true,
                powerPreference: 'high-performance'
            });
            this.renderer.setSize(this.width, this.height, false);
            this.ownsRenderer = true;
        }

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(45, this.width / this.height, 0.1, 1000);
        this.camera.position.set(0, 2, 5);

        // Alpha render target with hardware depth attachment
        this.renderTarget = new THREE.WebGLRenderTarget(this.width, this.height, {
            format: THREE.RGBAFormat,
            type: THREE.UnsignedByteType,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            depthBuffer: true,
            stencilBuffer: false
        });
        this.renderTarget.depthTexture = new THREE.DepthTexture(this.width, this.height);

        this.lightGroup = new THREE.Group();
        this.scene.add(this.lightGroup);

        this.wireframeMaterial = new THREE.MeshBasicMaterial({
            color: 0x38bdf8,
            wireframe: true,
            transparent: true,
            opacity: 0.8
        });

        this.holdoutMaterial = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: false
        });

        // Set default neutral direct light parameters
        this.applyDirectLighting({
            ambientColor: '#ffffff',
            ambientIntensity: 1.0,
            directionalColor: '#ffffff',
            directionalIntensity: 2.0,
            directionalPosition: [5, 10, 7]
        });
    }

    /**
     * Resizes the offscreen render target and camera aspect ratio.
     */
    public resize(width: number, height: number): void {
        if (this.width === width && this.height === height) return;
        this.width = width;
        this.height = height;
        if (this.ownsRenderer) {
            this.renderer.setSize(width, height, false);
        }
        this.renderTarget.setSize(width, height);
        if (this.distortedRenderTarget) {
            this.distortedRenderTarget.setSize(width, height);
        }
        if (this.bokehedRenderTarget) {
            this.bokehedRenderTarget.setSize(width, height);
        }
        if (this.lensDistortionEffect) {
            this.lensDistortionEffect.setAspectRatio(width / height);
        }
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
    }

    /**
     * Configures lighting using continuous, parametric values (colors, intensities, vectors).
     */
    public applyDirectLighting(config?: ThreeLightConfig): void {
        while (this.lightGroup.children.length > 0) {
            this.lightGroup.remove(this.lightGroup.children[0]);
        }

        const ambColor = new THREE.Color(config?.ambientColor || '#ffffff');
        const ambIntensity = config?.ambientIntensity ?? 1.0;
        const ambLight = new THREE.AmbientLight(ambColor, ambIntensity);

        const dirColor = new THREE.Color(config?.directionalColor || '#ffffff');
        const dirIntensity = config?.directionalIntensity ?? 2.0;
        const dirLight = new THREE.DirectionalLight(dirColor, dirIntensity);

        if (config?.directionalPosition) {
            dirLight.position.set(...config.directionalPosition);
        } else {
            dirLight.position.set(5, 10, 7);
        }

        this.lightGroup.add(ambLight, dirLight);
    }

    /**
     * Loads and builds an actual project Scene3DData scene.
     */
    public loadProjectScene(sceneId: string, sceneData: Scene3DData): THREE.Group {
        if (this.loadedScenes.has(sceneId)) {
            const cached = this.loadedScenes.get(sceneId)!;
            this.setActiveRoot(cached, this.mixerCache.get(sceneId) || null);
            return cached;
        }

        const group = new THREE.Group();
        group.name = `scene-${sceneId}`;

        // Construct actual objects from Scene3DData
        if (sceneData.objects && Array.isArray(sceneData.objects)) {
            for (const obj of sceneData.objects) {
                const mesh = this.buildObjectMesh(obj);
                if (mesh) group.add(mesh);
            }
        }

        // Apply scene's own camera if defined
        if (sceneData.camera) {
            this.applyCameraConfig({
                fov: sceneData.camera.fov || 45,
                position: sceneData.camera.position || [0, 2, 5],
                target: sceneData.camera.target || [0, 0, 0]
            });
        }

        // Apply scene's own environment lighting
        if (sceneData.environment) {
            while (this.lightGroup.children.length > 0) {
                this.lightGroup.remove(this.lightGroup.children[0]);
            }
            const ambIntensity = sceneData.environment.ambientIntensity ?? 0.8;
            const amb = new THREE.AmbientLight(0xffffff, ambIntensity);
            const sun = new THREE.DirectionalLight(0xfffaed, 2.5);
            sun.position.set(5, 10, 5);
            this.lightGroup.add(amb, sun);
        }

        this.loadedScenes.set(sceneId, group);
        this.setActiveRoot(group, null);
        return group;
    }

    private buildObjectMesh(obj: Media4DObject): THREE.Object3D | null {
        try {
            const geom = new THREE.BoxGeometry(1, 1, 1);
            const mat = new THREE.MeshStandardMaterial({
                color: 0x94a3b8,
                roughness: 0.4,
                metalness: 0.2
            });

            const mesh = new THREE.Mesh(geom, mat);
            if (obj.space?.spatial3d) {
                const s3d = obj.space.spatial3d;
                mesh.position.set(s3d.x, s3d.y, s3d.z);
                if (s3d.pitch !== undefined || s3d.yaw !== undefined || s3d.roll !== undefined) {
                    mesh.rotation.set(s3d.pitch || 0, s3d.yaw || 0, s3d.roll || 0);
                }
            } else if (obj.space?.position) {
                const p = obj.space.position;
                mesh.position.set(p.x, p.y, (p.zIndex ?? 0));
            } else {
                const rawSpace = obj.space as any;
                if (Array.isArray(rawSpace?.position)) {
                    mesh.position.set(rawSpace.position[0] || 0, rawSpace.position[1] || 0, rawSpace.position[2] || 0);
                }
                if (Array.isArray(rawSpace?.rotation)) {
                    mesh.rotation.set(rawSpace.rotation[0] || 0, rawSpace.rotation[1] || 0, rawSpace.rotation[2] || 0);
                }
                if (Array.isArray(rawSpace?.scale)) {
                    mesh.scale.set(rawSpace.scale[0] ?? 1, rawSpace.scale[1] ?? 1, rawSpace.scale[2] ?? 1);
                }
            }
            return mesh;
        } catch {
            return null;
        }
    }

    /**
     * Loads a project .glb / .gltf file, extracting its actual embedded animation tracks.
     */
    public async loadProjectModel(assetPath: string): Promise<{ object: THREE.Object3D; clipNames: string[] }> {
        if (this.loadedModels.has(assetPath)) {
            const cached = this.loadedModels.get(assetPath)!;
            const clipNames = this.clipNamesCache.get(assetPath) || [];
            this.setActiveRoot(cached, this.mixerCache.get(assetPath) || null);
            return { object: cached, clipNames };
        }

        return new Promise((resolve, reject) => {
            const loader = new GLTFLoader();
            loader.load(
                assetPath,
                (gltf) => {
                    const object = gltf.scene;
                    let mixer: THREE.AnimationMixer | null = null;
                    const clipNames: string[] = [];

                    if (gltf.animations && gltf.animations.length > 0) {
                        mixer = new THREE.AnimationMixer(object);
                        for (const anim of gltf.animations) {
                            clipNames.push(anim.name);
                            const action = mixer.clipAction(anim);
                            action.play();
                        }
                    }

                    this.loadedModels.set(assetPath, object);
                    this.clipNamesCache.set(assetPath, clipNames);
                    if (mixer) this.mixerCache.set(assetPath, mixer);

                    this.setActiveRoot(object, mixer);
                    resolve({ object, clipNames });
                },
                undefined,
                (err) => reject(err)
            );
        });
    }

    /**
     * Sets the active 3D root object and animation mixer.
     */
    public setActiveRoot(object: THREE.Object3D, mixer: THREE.AnimationMixer | null): void {
        if (this.currentRoot && this.currentRoot !== object) {
            this.scene.remove(this.currentRoot);
        }
        this.currentRoot = object;
        this.currentMixer = mixer;
        this.scene.add(object);
    }

    /**
     * Directly configures camera coordinates and field-of-view,
     * with optional physical camera optics and sensor modeling.
     */
    public applyCameraConfig(config?: ThreeCameraConfig): void {
        const pos = config?.position || [0, 2, 5];
        this.camera.position.set(pos[0], pos[1], pos[2]);

        const target = config?.target || [0, 0, 0];
        this.camera.lookAt(target[0], target[1], target[2]);

        if (config?.physicalCamera) {
            this.activePhysicalCameraConfig = config.physicalCamera;
            const dist = this.camera.position.distanceTo(new THREE.Vector3(target[0], target[1], target[2]));
            PhysicalCameraModel.applyToPerspectiveCamera(this.camera, config.physicalCamera, dist);
            this.currentFocusDistanceMeters = dist;
        } else {
            const fov = config?.fov || 45;
            if (this.camera.fov !== fov) {
                this.camera.fov = fov;
                this.camera.updateProjectionMatrix();
            }
        }
    }


    /**
     * Applies an exact 6-DOF camera pose solve with sub-frame quaternion rotation and FOV.
     * Guarantees that synthetic and 3D layers lock rigidly to live-action VFX plates.
     */
    public applyCameraPose(pose: InterpolatedCameraPose): void {
        if (Math.abs(this.camera.fov - pose.fovDegrees) > 0.001) {
            this.camera.fov = pose.fovDegrees;
            this.camera.updateProjectionMatrix();
        }
        this.camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
        this.camera.quaternion.set(
            pose.rotationQuaternion[0],
            pose.rotationQuaternion[1],
            pose.rotationQuaternion[2],
            pose.rotationQuaternion[3]
        );
    }

    /**
     * Locks scene directional lighting and ambient skylight to the physical astronomical
     * solar position calculated from the live-action plate's GPS coordinates and timestamp.
     */
    public applyAstronomicalSunLighting(anchor: GeodeticEphemerisAnchor): SolarLightingResult {
        const lighting = VfxPlateMatchmoveService.computeSolarLighting(anchor);
        this.applyDirectLighting({
            ambientColor: lighting.ambientColor,
            ambientIntensity: lighting.ambientIntensity,
            directionalColor: lighting.directionalColor,
            directionalIntensity: lighting.directionalIntensity,
            directionalPosition: [
                lighting.directionVector[0] * 20,
                lighting.directionVector[1] * 20,
                lighting.directionVector[2] * 20
            ]
        });
        return lighting;
    }

    /**
     * Renders the 3D scene at the specified timeline time into the offscreen render target.
     * Returns the resulting THREE.Texture with alpha channel preserved.
    /**
     * Enables cinematic depth-of-field mode with the specified physical camera configuration.
     */
    public enableCinematicDoF(config?: PhysicalCameraConfig): void {
        if (config) {
            this.activePhysicalCameraConfig = {
                ...config,
                enableDepthOfField: true
            };
        } else if (this.activePhysicalCameraConfig) {
            this.activePhysicalCameraConfig.enableDepthOfField = true;
        } else {
            this.activePhysicalCameraConfig = {
                sensorFormat: 'full_frame_35mm',
                focalLengthMm: 50,
                apertureFStop: 2.8,
                enableDepthOfField: true
            };
        }
        if (typeof this.activePhysicalCameraConfig.focusDistanceMeters === 'number') {
            this.currentFocusDistanceMeters = this.activePhysicalCameraConfig.focusDistanceMeters;
        }
        if (!this.cinematicBokehPass) {
            this.cinematicBokehPass = new CinematicBokehPass({
                width: this.width,
                height: this.height,
                camera: this.camera
            });
        }
        this.cinematicBokehPass.setEnabled(true);
    }

    /**
     * Disables cinematic depth-of-field mode.
     */
    public disableCinematicDoF(): void {
        if (this.activePhysicalCameraConfig) {
            this.activePhysicalCameraConfig.enableDepthOfField = false;
        }
        if (this.cinematicBokehPass) {
            this.cinematicBokehPass.setEnabled(false);
        }
    }

    /**
     * Returns true if depth-of-field post-processing is currently active.
     */
    public isDepthOfFieldEnabled(): boolean {
        return this.activePhysicalCameraConfig?.enableDepthOfField ?? false;
    }

    /**
     * Sets a 3D focus target point in world coordinates for dynamic rack-focus tracking.
     */
    public setFocusTarget(targetPosition: [number, number, number]): void {
        this.focusTargetPosition = targetPosition;
    }

    /**
     * Returns the current focus distance in meters.
     */
    public getCurrentFocusDistance(): number {
        return this.currentFocusDistanceMeters;
    }

    /**
     * Returns the active physical camera configuration.
     */
    public getPhysicalCameraConfig(): PhysicalCameraConfig | null {
        return this.activePhysicalCameraConfig ? { ...this.activePhysicalCameraConfig } : null;
    }

    /**
     * Renders the 3D scene at the specified timeline time into the offscreen render target.
     * Returns the resulting THREE.Texture with alpha channel preserved.
     */
    public renderAtTime(elementOrTime: TimelineElement | number, timeOrElement?: number | TimelineElement): THREE.Texture {
        let element: TimelineElement;
        let timeSec: number;

        if (typeof elementOrTime === 'number') {
            timeSec = elementOrTime;
            element = timeOrElement as TimelineElement;
        } else {
            element = elementOrTime as TimelineElement;
            timeSec = typeof timeOrElement === 'number' ? timeOrElement : 0;
        }

        if (!element) {
            return this.renderTarget.texture;
        }

        const startTime = element.startTime ?? (element as any).startSec ?? 0;
        const localTime = Math.max(0, (timeSec - startTime) * (element.animationSpeed || element.speed || 1.0)) + (element.trimStart ?? 0);

        // 1. Advance the asset's actual Animation Mixer
        if (this.currentMixer) {
            this.currentMixer.setTime(localTime);
        }

        // 2. VFX Plate Anti-Drift: Apply astronomical sun lighting if sun lock is active
        if (element.vfxPlate?.geodeticAnchor?.sunLockActive) {
            this.applyAstronomicalSunLighting(element.vfxPlate.geodeticAnchor);
        } else if (!element.useSceneLighting && element.lightingConfig) {
            // Apply parametric custom lighting
            this.applyDirectLighting(element.lightingConfig);
        }

        // 3. VFX Plate Matchmove: Apply 6-DOF camera solve if present, otherwise fallback to cameraConfig
        const sceneCam = element.cameraConfig || (element as any).content?.sceneData?.camera;
        if (element.vfxPlate?.cameraSolve && element.vfxPlate.cameraSolve.frames?.length > 0) {
            const pose = VfxPlateMatchmoveService.interpolateCameraSolve(
                element.vfxPlate.cameraSolve,
                timeSec
            );
            this.applyCameraPose(pose);
        } else if (sceneCam) {
            this.applyCameraConfig(sceneCam);
        }

        // 3b. Physical Camera & Dynamic Focus Tracking
        const physCam = element.physicalCamera || sceneCam?.physicalCamera || this.activePhysicalCameraConfig;
        if (physCam) {
            this.activePhysicalCameraConfig = {
                ...(this.activePhysicalCameraConfig || {}),
                ...physCam
            };

            let targetPos: [number, number, number] | null = this.focusTargetPosition;
            if (!targetPos && sceneCam?.target) {
                targetPos = [sceneCam.target[0], sceneCam.target[1], sceneCam.target[2]];
            }

            if (targetPos) {
                const damping = physCam.focusTarget?.dampingFactor ?? 5.0;
                const dt = 0.033;
                const tracking = PhysicalCameraModel.updateDynamicFocusTracking(
                    [this.camera.position.x, this.camera.position.y, this.camera.position.z],
                    targetPos,
                    this.currentFocusDistanceMeters,
                    dt,
                    damping
                );
                this.currentFocusDistanceMeters = tracking.currentFocusDistanceMeters;
            } else if (physCam.focusDistanceMeters !== undefined) {
                this.currentFocusDistanceMeters = physCam.focusDistanceMeters;
            }

            if (this.activePhysicalCameraConfig) {
                PhysicalCameraModel.applyToPerspectiveCamera(this.camera, this.activePhysicalCameraConfig, this.currentFocusDistanceMeters);
            }
        }

        // 4. Handle wireframe toggle
        if (element.wireframe) {
            this.scene.overrideMaterial = this.wireframeMaterial;
        } else if (!this.scene.overrideMaterial) {
            this.scene.overrideMaterial = null;
        }

        // 5. Render offscreen with alpha transparency
        const prevTarget = this.renderer.getRenderTarget();
        this.renderer.setRenderTarget(this.renderTarget);
        this.renderer.setClearColor(0x000000, 0.0);
        this.renderer.clear(true, true, true);

        this.renderer.render(this.scene, this.camera);

        // Restore target
        this.renderer.setRenderTarget(prevTarget);
        if (element.wireframe) {
            this.scene.overrideMaterial = null;
        }

        let currentTexture: THREE.Texture = this.renderTarget.texture;

        // 6. Optional Cinematic Depth-of-Field & Bokeh post-processing pass
        const dofActive = this.activePhysicalCameraConfig?.enableDepthOfField ?? false;
        if (dofActive) {
            if (!this.cinematicBokehPass) {
                this.cinematicBokehPass = new CinematicBokehPass({
                    width: this.width,
                    height: this.height,
                    camera: this.camera
                });
            } else {
                this.cinematicBokehPass.setSize(this.width, this.height);
                this.cinematicBokehPass.setCamera(this.camera);
            }

            if (this.activePhysicalCameraConfig) {
                this.cinematicBokehPass.updateFromConfig(this.activePhysicalCameraConfig, this.camera, this.currentFocusDistanceMeters);
            }

            if (!this.bokehedRenderTarget) {
                this.bokehedRenderTarget = new THREE.WebGLRenderTarget(this.width, this.height, {
                    minFilter: THREE.LinearFilter,
                    magFilter: THREE.LinearFilter,
                    format: THREE.RGBAFormat
                });
            }

            this.cinematicBokehPass.render(
                this.renderer,
                this.renderTarget.texture,
                this.renderTarget.depthTexture!,
                this.width,
                this.height,
                this.bokehedRenderTarget
            );
            currentTexture = this.bokehedRenderTarget.texture;
        }

        // 7. Optional Brown-Conrady Optical Lens Distortion post-processing pass
        if (element.vfxPlate?.applyLensDistortion) {
            if (!this.lensDistortionEffect) {
                this.lensDistortionEffect = new LensDistortionEffect({
                    aspectRatio: this.width / this.height,
                    edgeMode: 'transparent'
                });
            }

            const lp = element.vfxPlate.lensDistortion;
            if (lp) {
                this.lensDistortionEffect.setDistortion(
                    lp.k1,
                    lp.k2,
                    lp.p1 ?? 0,
                    lp.p2 ?? 0,
                    lp.k3 ?? 0,
                    lp.k4 ?? 0
                );
                const squeeze = lp.squeezeFactor ?? lp.anamorphicSqueeze;
                if (squeeze !== undefined) {
                    this.lensDistortionEffect.setAnamorphicSqueeze(squeeze);
                }
                if (lp.opticalCenter) {
                    this.lensDistortionEffect.setOpticalCenter(lp.opticalCenter[0], lp.opticalCenter[1]);
                }
            }

            const mode = element.vfxPlate.lensDistortionMode ?? 'redistort';
            this.lensDistortionEffect.setMode(mode === 'undistort' ? 'undistort' : 'redistort');
            this.lensDistortionEffect.setEdgeMode('transparent');

            if (!this.distortedRenderTarget) {
                this.distortedRenderTarget = new THREE.WebGLRenderTarget(this.width, this.height, {
                    minFilter: THREE.LinearFilter,
                    magFilter: THREE.LinearFilter,
                    format: THREE.RGBAFormat
                });
            }

            this.lensDistortionEffect.render(this.renderer, currentTexture, this.distortedRenderTarget);
            return this.distortedRenderTarget.texture;
        }

        return currentTexture;
    }

    /**
     * Renders a depth holdout silhouette pass where meshes write solid white
     * against transparent black, for compositing live-action foreground actors against 3D layers.
     */
    public renderDepthHoldout(element: TimelineElement, timeSec: number): THREE.Texture {
        const prevOverride = this.scene.overrideMaterial;
        this.scene.overrideMaterial = this.holdoutMaterial;
        const tex = this.renderAtTime(element, timeSec);
        this.scene.overrideMaterial = prevOverride;
        return tex;
    }

    public getRenderTarget(): THREE.WebGLRenderTarget {
        return this.renderTarget;
    }

    public getAvailableAnimationClips(assetPath: string): string[] {
        return this.clipNamesCache.get(assetPath) || [];
    }

    public dispose(): void {
        this.renderTarget.dispose();
        if (this.distortedRenderTarget) {
            this.distortedRenderTarget.dispose();
        }
        if (this.bokehedRenderTarget) {
            this.bokehedRenderTarget.dispose();
        }
        if (this.cinematicBokehPass) {
            this.cinematicBokehPass.dispose();
        }
        if (this.lensDistortionEffect) {
            this.lensDistortionEffect.dispose();
        }
        this.wireframeMaterial.dispose();
        this.holdoutMaterial.dispose();
        if (this.ownsRenderer) {
            this.renderer.dispose();
        }
        this.loadedScenes.clear();
        this.loadedModels.clear();
        this.mixerCache.clear();
        this.clipNamesCache.clear();
    }
}
