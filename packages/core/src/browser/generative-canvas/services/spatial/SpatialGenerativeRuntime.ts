/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import { CameraRelativeRTC } from '../../../../common/coordinate/CameraRelativeRTC';
import type {
  SpatialGeodeticAnchor,
  SpatialAffordance,
  GenerativeSpatialConditioning,
  GenerativeMediaPlacement,
  SpatialRuntimeConfig,
  SpatialRuntimeMetrics
} from '../../../../common/spatial/spatial-generative-protocol';
import { SpatialAffordanceExtractor } from './SpatialAffordanceExtractor';
import { SoftZDepthInterleaver } from './SoftZDepthInterleaver';
import { RadiometricSolarHarmonizer } from './RadiometricSolarHarmonizer';
import { DualPayloadOctreeStreamer } from './DualPayloadOctreeStreamer';
import { PhotorealGaussianSplatMesh, type SplatData } from './PhotorealGaussianSplatMesh';

/**
 * Next-Generation Spatial Generative Runtime & Engine.
 *
 * Competes directly with MapLibre, Cesium, and World Labs by physically grounding
 * generative media (3D Gaussian Splats, neural video plates, procedural meshes)
 * in relation to Google Photorealistic 3D Tiles with sub-millimeter precision,
 * organic soft-Z depth interleaving, and unified diurnal radiometric lighting.
 */
export class SpatialGenerativeRuntime {
  private config: SpatialRuntimeConfig;

  // Three.js Core Components
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  public renderer: THREE.WebGLRenderer | null = null;
  private canvas?: HTMLCanvasElement;

  // Scene sub-graphs
  public tileGroup: THREE.Group;
  public generativeMediaGroup: THREE.Group;

  // Proprietary Sub-Engines
  public rtcKernel: CameraRelativeRTC;
  public softZInterleaver: SoftZDepthInterleaver | null = null;
  public solarHarmonizer: RadiometricSolarHarmonizer;
  public dualStreamer: DualPayloadOctreeStreamer;

  // Active generative media registry
  private mediaPlacements: Map<string, { placement: GenerativeMediaPlacement; rootObject: THREE.Object3D }> = new Map();

  // Telemetry metrics
  private lastFrameTimestamp: number = performance.now();
  private lastFrameDurationMs: number = 16.6;
  private fps: number = 60;

  constructor(config: SpatialRuntimeConfig = {}) {
    this.config = config;

    const defaultOrigin: SpatialGeodeticAnchor = config.originAnchor ?? {
      latitude: 37.7749,
      longitude: -122.4194,
      altitudeMsl: 10
    };

    // 1. Initialize Scene & Cameras
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 10000);
    this.camera.position.set(0, 50, 100);
    this.camera.lookAt(0, 0, 0);

    this.tileGroup = new THREE.Group();
    this.tileGroup.name = 'Google3DTilesGroup';
    this.scene.add(this.tileGroup);

    this.generativeMediaGroup = new THREE.Group();
    this.generativeMediaGroup.name = 'GenerativeMediaGroup';
    this.scene.add(this.generativeMediaGroup);

    // 2. Initialize Camera-Relative RTC Kernel
    this.rtcKernel = new CameraRelativeRTC(defaultOrigin);
    this.rtcKernel.setCameraPositionGeodetic(defaultOrigin);

    // 3. Initialize Radiometric Solar Harmonizer
    this.solarHarmonizer = new RadiometricSolarHarmonizer(defaultOrigin);
    if (config.enableRadiometricHarmonization ?? true) {
      this.solarHarmonizer.attachToScene(this.scene);
    }

    // 4. Initialize Dual-Payload Octree Streamer
    this.dualStreamer = new DualPayloadOctreeStreamer({
      camera: this.camera,
      errorTarget: config.sseErrorTarget ?? 4.0,
      maxSplatBudget: config.maxSplatBudget ?? 2000000,
      targetFrameDurationMs: config.targetFrameDurationMs ?? 16.6
    });

    // 5. Initialize Renderer if canvas supplied
    if (config.canvas) {
      this.attachCanvas(config.canvas);
    }
  }

  /**
   * Binds the runtime to a DOM canvas element and initializes WebGL renderer and SoftZ depth buffers.
   */
  public attachCanvas(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    const width = canvas.clientWidth || 1280;
    const height = canvas.clientHeight || 720;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setSize(width, height, false);
    this.renderer.setPixelRatio(Math.min(window?.devicePixelRatio ?? 1, 2));

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    if (this.config.enableSoftZCompositing ?? true) {
      this.softZInterleaver = new SoftZDepthInterleaver({
        renderer: this.renderer,
        width,
        height,
        defaultEpsilonMeters: this.config.defaultSoftZEpsilonMeters ?? 0.05
      });
    }
  }

  /**
   * Resizes viewport buffers.
   */
  public resize(width: number, height: number): void {
    if (this.renderer) {
      this.renderer.setSize(width, height, false);
    }
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    if (this.softZInterleaver) {
      this.softZInterleaver.resize(width, height);
    }

    const vp = new THREE.Vector2(width, height);
    for (const { rootObject } of this.mediaPlacements.values()) {
      rootObject.traverse((child) => {
        if (child instanceof PhotorealGaussianSplatMesh) {
          child.setSoftZUniforms({ viewport: vp });
        }
      });
    }
  }

  /**
   * Sets the global world origin and re-centers all camera-relative calculations.
   */
  public setOrigin(anchor: SpatialGeodeticAnchor): void {
    this.rtcKernel.setOrigin(anchor);
    this.solarHarmonizer.setAnchor(anchor);
    this.repositionAnchoredEntities();
  }

  /**
   * Anchors a generative media entity (3DGS, neural video quad, or mesh)
   * at an exact real-world physical geodetic location.
   */
  public async anchorGenerativeMedia(placement: GenerativeMediaPlacement): Promise<THREE.Object3D> {
    // If existing entity with same ID, remove first
    if (this.mediaPlacements.has(placement.id)) {
      this.removeGenerativeMedia(placement.id);
    }

    // Convert geodetic location to Three.js camera-relative coordinates
    const localPos = this.rtcKernel.geodeticToCameraRelativeThree(placement.anchor);

    // Create container object
    const entityGroup = new THREE.Group();
    entityGroup.name = `GenerativeMedia_${placement.id}`;
    entityGroup.position.set(
      localPos[0] + (placement.offsetMeters?.[0] ?? 0),
      localPos[1] + (placement.offsetMeters?.[2] ?? 0), // Up is Y in Three.js
      localPos[2] - (placement.offsetMeters?.[1] ?? 0)  // North is -Z
    );

    // Apply orientation
    const [heading, pitch, roll] = placement.headingPitchRollDeg ?? [0, 0, 0];
    const rotMatrix = CameraRelativeRTC.computeOrientationMatrix(heading, pitch, roll);
    entityGroup.quaternion.setFromRotationMatrix(new THREE.Matrix4().fromArray(rotMatrix));

    // Apply scale
    const [sx, sy, sz] = placement.scaleMeters ?? [1, 1, 1];
    entityGroup.scale.set(sx, sz, sy); // Y is Up

    let mediaObj: THREE.Object3D;
    const isSplat =
      placement.sourceType === 'gaussian-splat-splat' ||
      placement.sourceType === 'gaussian-splat-spz' ||
      placement.buffer !== undefined ||
      (placement.url !== undefined && (placement.url.endsWith('.splat') || placement.url.endsWith('.spz')));

    if (isSplat) {
      let splatData: SplatData | undefined;
      try {
        if (placement.buffer) {
          if (placement.sourceType === 'gaussian-splat-spz' || (placement.url && placement.url.endsWith('.spz'))) {
            splatData = await PhotorealGaussianSplatMesh.parseSpzBuffer(placement.buffer);
          } else {
            splatData = PhotorealGaussianSplatMesh.parseSplatBuffer(placement.buffer);
          }
        } else if (placement.url && typeof fetch !== 'undefined') {
          const resp = await fetch(placement.url);
          const buf = await resp.arrayBuffer();
          if (placement.url.endsWith('.spz') || placement.sourceType === 'gaussian-splat-spz') {
            splatData = await PhotorealGaussianSplatMesh.parseSpzBuffer(buf);
          } else {
            splatData = PhotorealGaussianSplatMesh.parseSplatBuffer(buf);
          }
        }
      } catch (err) {
        console.warn(`[SpatialGenerativeRuntime] Failed to load splat from ${placement.url}:`, err);
      }

      if (splatData && splatData.count > 0) {
        const splatMesh = new PhotorealGaussianSplatMesh(splatData, {
          splatScale: 1.0,
          enableSoftZ: placement.enableSoftZ ?? (this.softZInterleaver !== null),
          softZEpsilonMeters: placement.softZEpsilonMeters ?? 0.25,
          tileDepthMap: this.softZInterleaver?.getDepthTexture(),
          tileDepthNear: this.camera.near,
          tileDepthFar: this.camera.far,
          viewportWidth: this.canvas?.clientWidth || 1920,
          viewportHeight: this.canvas?.clientHeight || 1080
        });
        mediaObj = splatMesh;
      } else {
        mediaObj = this.createMediaRepresentationMesh(placement);
      }
    } else {
      mediaObj = this.createMediaRepresentationMesh(placement);
    }

    entityGroup.add(mediaObj);

    // Apply Soft-Z Depth Interleaving if standard mesh and Soft-Z enabled
    if (placement.enableSoftZ && this.softZInterleaver && !(mediaObj instanceof PhotorealGaussianSplatMesh) && (mediaObj as THREE.Mesh).material) {
      this.softZInterleaver.injectSoftZUniforms(
        (mediaObj as THREE.Mesh).material as THREE.ShaderMaterial,
        this.camera,
        placement.softZEpsilonMeters
      );
    }

    this.generativeMediaGroup.add(entityGroup);
    this.mediaPlacements.set(placement.id, { placement: { ...placement }, rootObject: entityGroup });

    return entityGroup;
  }

  /**
   * Removes an anchored generative media entity by ID.
   */
  public removeGenerativeMedia(id: string): boolean {
    const entry = this.mediaPlacements.get(id);
    if (!entry) return false;

    this.generativeMediaGroup.remove(entry.rootObject);
    entry.rootObject.traverse((child) => {
      if ((child as THREE.Mesh).geometry) (child as THREE.Mesh).geometry.dispose();
      if ((child as THREE.Mesh).material) {
        const mat = (child as THREE.Mesh).material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
    });

    this.mediaPlacements.delete(id);
    return true;
  }

  public getGenerativeMedia(id: string): GenerativeMediaPlacement | undefined {
    return this.mediaPlacements.get(id)?.placement;
  }

  public getAllGenerativeMedia(): GenerativeMediaPlacement[] {
    return Array.from(this.mediaPlacements.values()).map((v) => v.placement);
  }

  /**
   * Extracts spatial affordances and conditions generative AI models.
   */
  public extractAffordance(anchor?: SpatialGeodeticAnchor, targetDate?: Date): SpatialAffordance {
    const targetAnchor = anchor ?? this.rtcKernel.getOrigin();
    return SpatialAffordanceExtractor.extractAffordance({
      anchor: targetAnchor,
      targetDate,
      tileMesh: this.tileGroup
    });
  }

  /**
   * Builds prompt conditioning for generative diffusion or multimodal models.
   */
  public buildGenerativePrompt(
    targetSubject: string,
    anchor?: SpatialGeodeticAnchor,
    aspectRatio: string = '16:9'
  ): GenerativeSpatialConditioning {
    const affordance = this.extractAffordance(anchor);
    return SpatialAffordanceExtractor.buildGenerativeSpatialConditioning(affordance, targetSubject, aspectRatio);
  }

  /**
   * Updates time of day and recalculates diurnal illumination.
   */
  public setDiurnalTime(date: Date): void {
    this.solarHarmonizer.setDate(date);
  }

  /**
   * Main per-frame animation and streaming update loop.
   */
  public update(nowMs: number = performance.now()): SpatialRuntimeMetrics {
    this.lastFrameDurationMs = Math.max(1, nowMs - this.lastFrameTimestamp);
    this.lastFrameTimestamp = nowMs;
    this.fps = 1000 / this.lastFrameDurationMs;

    // Report frame telemetry to adapt splat budget
    this.dualStreamer.reportFrameTelemetry(this.lastFrameDurationMs);

    // Update camera in RTC kernel
    const origin = this.rtcKernel.getOrigin();
    this.rtcKernel.setCameraPositionGeodetic({
      latitude: origin.latitude,
      longitude: origin.longitude,
      altitudeMsl: origin.altitudeMsl + this.camera.position.y
    });

    // Run dual-payload octree streaming refinement
    const viewportHeight = this.canvas?.clientHeight || 720;
    this.dualStreamer.update(viewportHeight);

    const radiometricState = this.solarHarmonizer.updateLighting();

    // Synchronize depth sorting and solar lighting on all anchored photoreal splats
    for (const { rootObject } of this.mediaPlacements.values()) {
      rootObject.traverse((child) => {
        if (child instanceof PhotorealGaussianSplatMesh) {
          child.updateDepthSort(this.camera);
          child.setLightingUniforms({
            sunDir: radiometricState.solarVector,
            sunColor: radiometricState.sunColor,
            sunIntensity: radiometricState.sunIntensity,
            skyAmbient: radiometricState.skyAmbientColor,
            exposureEV: 0.0
          });
        }
      });
    }

    return {
      fps: Math.round(this.fps),
      frameTimeMs: parseFloat(this.lastFrameDurationMs.toFixed(2)),
      activeTileCount: this.dualStreamer.getVisibleMeshCount(),
      activeSplatCount: this.dualStreamer.getVisibleSplatCount(),
      splatBudget: this.dualStreamer.getCurrentSplatBudget(),
      cameraAltitudeMeters: this.camera.position.y,
      currentSSE: 4.0,
      softZEnabled: this.softZInterleaver !== null,
      radiometricPhase: radiometricState.diurnalPhase
    };
  }

  /**
   * Executes the dual-pass render pipeline:
   * Pass 1: Render Google 3D Tiles to depth buffer
   * Pass 2: Render full scene with Soft-Z blending on Gaussian Splats
   */
  public render(): void {
    if (!this.renderer) return;

    if (this.softZInterleaver) {
      // Pass 1: G-buffer depth pre-pass on tiles
      this.softZInterleaver.renderTileDepthPrePass(this.tileGroup, this.camera);
    }

    // Pass 2: Main beauty render
    this.renderer.render(this.scene, this.camera);
  }

  private repositionAnchoredEntities(): void {
    for (const { placement, rootObject } of this.mediaPlacements.values()) {
      const localPos = this.rtcKernel.geodeticToCameraRelativeThree(placement.anchor);
      rootObject.position.set(
        localPos[0] + (placement.offsetMeters?.[0] ?? 0),
        localPos[1] + (placement.offsetMeters?.[2] ?? 0),
        localPos[2] - (placement.offsetMeters?.[1] ?? 0)
      );
    }
  }

  private createMediaRepresentationMesh(placement: GenerativeMediaPlacement): THREE.Object3D {
    switch (placement.sourceType) {
      case 'gaussian-splat-spz':
      case 'gaussian-splat-ply': {
        // Point cloud or volumetric ellipsoid representation
        const geom = new THREE.SphereGeometry(1, 16, 16);
        const mat = new THREE.MeshStandardMaterial({
          color: 0x00e5ff,
          wireframe: true,
          transparent: true,
          opacity: 0.8
        });
        return new THREE.Mesh(geom, mat);
      }
      case 'neural-video-quad': {
        const geom = new THREE.PlaneGeometry(16, 9);
        const mat = new THREE.MeshBasicMaterial({
          color: 0xff007f,
          side: THREE.DoubleSide
        });
        return new THREE.Mesh(geom, mat);
      }
      case 'glb-mesh':
      case 'procedural-sdf':
      default: {
        const geom = new THREE.BoxGeometry(2, 2, 2);
        const mat = new THREE.MeshStandardMaterial({
          color: 0x76ff03,
          roughness: 0.4
        });
        return new THREE.Mesh(geom, mat);
      }
    }
  }

  public dispose(): void {
    if (this.softZInterleaver) {
      this.softZInterleaver.dispose();
      this.softZInterleaver = null;
    }
    this.dualStreamer.dispose();
    this.solarHarmonizer.dispose();

    for (const id of Array.from(this.mediaPlacements.keys())) {
      this.removeGenerativeMedia(id);
    }

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
  }
}
