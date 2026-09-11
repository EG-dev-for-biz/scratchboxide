/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from 'three';
import type { LatLngAlt } from '../../../common/coordinate/LocalTangentPlane';
import { GoogleMapsService } from '../google-maps-service';
import { ClayPresetId, CLAY_PRESETS } from './TileClayProcessor';
import { TerrainManager } from './TerrainManager';
import { PhotorealCachePlugin } from './tiles/PhotorealCachePlugin';
import {
  FLATTEN_MAX_VERTICES,
  FlattenFootprintPoint,
  computeFlattenBounds,
  bakeFlattenHeightfield
} from './mesh/FlattenRegion';

let TilesRenderer: any;
let GoogleCloudAuthPlugin: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const tr = require('3d-tiles-renderer');
  TilesRenderer = tr.TilesRenderer || tr;
  const trp = require('3d-tiles-renderer/plugins');
  GoogleCloudAuthPlugin = trp.GoogleCloudAuthPlugin || trp;
} catch {
  // Headless Node / SSR / Test runner mock fallback
}

// Headless Node / SSR / Test runner mock fallback
class SafeTilesRenderer {
  public group = new THREE.Group();
  public lruCache = { maxBytesSize: 1024 * 1024 * 1024, minBytesSize: 512 * 1024 * 1024 };
  public downloadQueue = { maxJobs: 24 };
  public parseQueue = { maxJobs: 16 };
  public maxTilesProcessed = 400;
  public errorTarget = 5.0;
  public rootURL = '';
  public onLoadModel: any = null;
  public registerPlugin(_plugin: any) {}
  public setCamera(_camera: any) {}
  public setResolutionFromRenderer(_camera: any, _renderer: any) {}
  public update() {}
  public dispose() {}
}

class SafeGoogleCloudAuthPlugin {
  constructor(_opts?: any) {}
}

export type TilesRendererType = any;
export type GoogleCloudAuthPluginType = any;

function getTilesRendererClasses(): { TilesRendererClass: any; GoogleCloudAuthPluginClass: any } {
  const ResolvedTilesRenderer = typeof TilesRenderer !== 'undefined' && TilesRenderer ? TilesRenderer : SafeTilesRenderer;
  const ResolvedGoogleCloudAuthPlugin = typeof GoogleCloudAuthPlugin !== 'undefined' && GoogleCloudAuthPlugin ? GoogleCloudAuthPlugin : SafeGoogleCloudAuthPlugin;
  return {
    TilesRendererClass: ResolvedTilesRenderer,
    GoogleCloudAuthPluginClass: ResolvedGoogleCloudAuthPlugin
  };
}

// WGS-84 Ellipsoid constants
const WGS84_A = 6378137.0; // semi-major axis (meters)
const WGS84_F = 1.0 / 298.257223563; // flattening
const WGS84_B = WGS84_A * (1.0 - WGS84_F); // semi-minor axis (meters)
const WGS84_E2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_A * WGS84_A); // eccentricity squared

export interface Google3DTilesLayerOptions {
  apiKey?: string;
  origin?: LatLngAlt;
  geoidHeight?: number;
  renderMode?: 'clay' | 'textured' | 'grayscale' | 'blueprint';
  clayPreset?: ClayPresetId;
  customColor?: number | string;
  errorTarget?: number;
  maxMemoryMB?: number;
  enablePersistentCache?: boolean;
}

/**
 * High-performance Google Photorealistic 3D Tiles Layer for Scratchbox IDE.
 * Anchors the 3D scene directly to Google's worldwide photorealistic 3D tile system
 * with WGS84 geodetic-to-local ENU alignment, clay/architectural shaders, and LOD streaming.
 */
export class GooglePhotorealistic3DTilesLayer {
  public readonly group: THREE.Group;
  public tilesRenderer: any = null;
  public onTileLoaded?: (modelScene: THREE.Object3D) => void;
  private terrainManager?: TerrainManager;
  private isDisposed: boolean = false;
  private currentOrigin: LatLngAlt;
  private geoidHeight: number;
  private renderMode: 'clay' | 'textured' | 'grayscale' | 'blueprint';
  private clayPreset: ClayPresetId;
  private styleUniforms: {
    uTileRenderMode: { value: number };
    uTileColor: { value: THREE.Color };
    uTileRoughness: { value: number };
    uTileMetalness: { value: number };
    uFlattenActive: { value: number };
    uFlattenPolyCount: { value: number };
    uFlattenPoly: { value: THREE.Vector2[] };
    uFlattenBoundsMin: { value: THREE.Vector2 };
    uFlattenBoundsMax: { value: THREE.Vector2 };
    uFlattenMargin: { value: number };
    uFlattenExcavateDepth: { value: number };
    uFlattenHeightTex: { value: THREE.DataTexture };
  };

  constructor(options: Google3DTilesLayerOptions = {}) {
    this.group = new THREE.Group();
    this.group.name = 'GooglePhotorealistic3DTiles';
    this.currentOrigin = options.origin || { lat: 37.7749, lng: -122.4194, alt: 0 };
    this.geoidHeight = options.geoidHeight ?? -30.0;
    this.renderMode = options.renderMode || 'clay';
    this.clayPreset = options.clayPreset || 'warm-clay';

    const clayDef = CLAY_PRESETS[this.clayPreset] || CLAY_PRESETS['warm-clay'];
    const tileColor = options.customColor ? new THREE.Color(options.customColor as any) : new THREE.Color(clayDef.color);

    const defaultFlattenTex = new THREE.DataTexture(new Float32Array([0]), 1, 1, THREE.RedFormat, THREE.FloatType);
    defaultFlattenTex.needsUpdate = true;

    this.styleUniforms = {
      uTileRenderMode: { value: this.renderMode === 'clay' ? 1.0 : this.renderMode === 'grayscale' ? 2.0 : this.renderMode === 'blueprint' ? 3.0 : 0.0 },
      uTileColor: { value: tileColor },
      uTileRoughness: { value: clayDef.roughness },
      uTileMetalness: { value: clayDef.metalness },
      uFlattenActive: { value: 0.0 },
      uFlattenPolyCount: { value: 0 },
      uFlattenPoly: { value: Array.from({ length: FLATTEN_MAX_VERTICES }, () => new THREE.Vector2(0, 0)) },
      uFlattenBoundsMin: { value: new THREE.Vector2(0, 0) },
      uFlattenBoundsMax: { value: new THREE.Vector2(1, 1) },
      uFlattenMargin: { value: 0.8 },
      uFlattenExcavateDepth: { value: 0.0 },
      uFlattenHeightTex: { value: defaultFlattenTex }
    };

    this.initTilesRenderer(options);
  }

  private initTilesRenderer(options: Google3DTilesLayerOptions): void {
    const mapsService = GoogleMapsService.getInstance();
    const apiKey = options.apiKey || mapsService.getApiKey() || (typeof process !== 'undefined' ? process.env?.GOOGLE_MAPS_API_KEY || process.env?.MAP_TILES_API_KEY : '') || '';
    const { TilesRendererClass, GoogleCloudAuthPluginClass } = getTilesRendererClasses();

    try {
      this.tilesRenderer = new TilesRendererClass();
      this.tilesRenderer.errorTarget = options.errorTarget ?? 5.0;

      // LRU cache budget
      const maxBytes = (options.maxMemoryMB ?? 1024) * 1024 * 1024;
      this.tilesRenderer.lruCache.maxBytesSize = maxBytes;
      this.tilesRenderer.lruCache.minBytesSize = Math.floor(maxBytes * 0.7);

      (this.tilesRenderer as any).downloadQueue.maxJobs = 24;
      (this.tilesRenderer as any).parseQueue.maxJobs = 16;
      this.tilesRenderer.maxTilesProcessed = 400;

      // Auth Plugin
      if (apiKey) {
        const authPlugin = new GoogleCloudAuthPluginClass({
          apiToken: apiKey,
          autoRefreshToken: true,
          useRecommendedSettings: false
        });
        this.tilesRenderer.registerPlugin(authPlugin);
      } else {
        (this.tilesRenderer as any).rootURL = 'https://tile.googleapis.com/v1/3dtiles/root.json';
      }

      // Register Persistent IndexedDB Tile Cache Plugin (spce logic)
      if (options.enablePersistentCache !== false) {
        const cachePlugin = new PhotorealCachePlugin({ enabled: true });
        this.tilesRenderer.registerPlugin(cachePlugin);
      }

      // Add to group
      this.group.add(this.tilesRenderer.group);

      // Align Coordinates
      this.updateOrigin(this.currentOrigin, this.geoidHeight);

      // Attach Material Shader Patcher
      (this.tilesRenderer as any).onLoadModel = (scene: THREE.Object3D) => {
        scene.traverse((child: THREE.Object3D) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            if (Array.isArray(mesh.material)) {
              mesh.material.forEach(m => this.patchTileMaterial(m));
            } else if (mesh.material) {
              this.patchTileMaterial(mesh.material);
            }
          }
        });
        if (this.onTileLoaded) {
          try {
            this.onTileLoaded(scene);
          } catch {
            // Ignore callback error
          }
        }
      };
    } catch (err) {
      console.warn('[GooglePhotorealistic3DTilesLayer] TilesRenderer initialization error:', err);
    }
  }

  private patchTileMaterial(mat: THREE.Material): void {
    if (!mat || (mat as any).userData?.sbTilesPatched) return;
    (mat as any).userData.sbTilesPatched = true;

    const origOnBeforeCompile = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader: any, renderer: THREE.WebGLRenderer) => {
      if (origOnBeforeCompile) {
        origOnBeforeCompile.call(mat, shader, renderer);
      }

      shader.uniforms.uTileRenderMode = this.styleUniforms.uTileRenderMode;
      shader.uniforms.uTileColor = this.styleUniforms.uTileColor;
      shader.uniforms.uTileRoughness = this.styleUniforms.uTileRoughness;
      shader.uniforms.uTileMetalness = this.styleUniforms.uTileMetalness;
      shader.uniforms.uFlattenActive = this.styleUniforms.uFlattenActive;
      shader.uniforms.uFlattenPolyCount = this.styleUniforms.uFlattenPolyCount;
      shader.uniforms.uFlattenPoly = this.styleUniforms.uFlattenPoly;
      shader.uniforms.uFlattenBoundsMin = this.styleUniforms.uFlattenBoundsMin;
      shader.uniforms.uFlattenBoundsMax = this.styleUniforms.uFlattenBoundsMax;
      shader.uniforms.uFlattenMargin = this.styleUniforms.uFlattenMargin;
      shader.uniforms.uFlattenExcavateDepth = this.styleUniforms.uFlattenExcavateDepth;
      shader.uniforms.uFlattenHeightTex = this.styleUniforms.uFlattenHeightTex;

      // Vertex shader hooks for world position and normals
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `
        #include <common>
        varying vec3 vWorldPosition;
        varying vec3 vWorldNormal;
        `
      );

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        #include <begin_vertex>
        vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
        `
      );

      // Fragment Shader Clay & Terrain Excavation Override
      shader.fragmentShader = `
        uniform float uTileRenderMode;
        uniform vec3 uTileColor;
        uniform float uTileRoughness;
        uniform float uTileMetalness;
        uniform float uFlattenActive;
        uniform int uFlattenPolyCount;
        uniform vec2 uFlattenPoly[32];
        uniform vec2 uFlattenBoundsMin;
        uniform vec2 uFlattenBoundsMax;
        uniform float uFlattenMargin;
        uniform float uFlattenExcavateDepth;
        uniform sampler2D uFlattenHeightTex;
        varying vec3 vWorldPosition;
        varying vec3 vWorldNormal;

        bool spcePointInFlattenPoly(vec2 p) {
          bool inside = false;
          int n = uFlattenPolyCount;
          for (int i = 0; i < 32; i++) {
            if (i >= n) break;
            int j = i - 1;
            if (i == 0) j = n - 1;
            vec2 a = uFlattenPoly[i];
            vec2 b = uFlattenPoly[j];
            if ((a.y > p.y) != (b.y > p.y)) {
              float dy = b.y - a.y;
              if (abs(dy) > 1e-6) {
                float xIntersect = (b.x - a.x) * (p.y - a.y) / dy + a.x;
                if (p.x < xIntersect) inside = !inside;
              }
            }
          }
          return inside;
        }

        float spceSampleFlattenGround(vec2 xz) {
          vec2 size = uFlattenBoundsMax - uFlattenBoundsMin;
          vec2 uv = (xz - uFlattenBoundsMin) / max(size, vec2(1e-3));
          uv = clamp(uv, 0.0, 1.0);
          return texture2D(uFlattenHeightTex, uv).r;
        }
      ` + shader.fragmentShader;

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `
        #include <dithering_fragment>
        if (uFlattenActive > 0.5) {
          vec2 flattenXZ = vWorldPosition.xz;
          if (spcePointInFlattenPoly(flattenXZ)) {
            float groundY = spceSampleFlattenGround(flattenXZ) - uFlattenExcavateDepth;
            if (vWorldPosition.y > groundY + uFlattenMargin) {
              discard;
            }
          }
        }
        if (uTileRenderMode > 0.5) {
          if (uTileRenderMode < 1.5) {
            // Mode 1: Architectural Matte Clay
            diffuseColor.rgb = uTileColor;
            #ifdef USE_ROUGHNESS
              roughnessFactor = uTileRoughness;
            #endif
            #ifdef USE_METALNESS
              metalnessFactor = uTileMetalness;
            #endif
          } else if (uTileRenderMode < 2.5) {
            // Mode 2: Grayscale Luminance
            #ifdef USE_MAP
              float luma = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
              diffuseColor.rgb = vec3(luma);
            #endif
          } else if (uTileRenderMode < 3.5) {
            // Mode 3: Blueprint Architectural Blue
            diffuseColor.rgb = vec3(0.02, 0.08, 0.22);
          }
        }
        `
      );
    };

    mat.needsUpdate = true;
  }

  /**
   * Applies polygon flattening / excavation across the 3D photogrammetry terrain.
   */
  public applyFlattenPolygon(
    polygon: FlattenFootprintPoint[],
    sampleGround?: (x: number, z: number) => number | null,
    opts?: { margin?: number; gridSize?: number; excavateDepth?: number }
  ): void {
    if (polygon.length < 3) return;
    const trimmed = polygon.slice(0, FLATTEN_MAX_VERTICES);
    const bounds = computeFlattenBounds(trimmed);
    const gridSize = Math.min(64, Math.max(4, opts?.gridSize ?? 32));
    const margin = opts?.margin ?? 0.8;
    const excavateDepth = opts?.excavateDepth ?? 0.0;

    const groundSampler = sampleGround || ((x, z) => this.terrainManager?.sampleGroundHeight(x, z) ?? 0);
    const { heightfield } = bakeFlattenHeightfield(groundSampler, bounds.min, bounds.max, gridSize);

    const floatData = new Float32Array(heightfield);
    const tex = new THREE.DataTexture(floatData, gridSize, gridSize, THREE.RedFormat, THREE.FloatType);
    tex.needsUpdate = true;

    this.styleUniforms.uFlattenActive.value = 1.0;
    this.styleUniforms.uFlattenPolyCount.value = trimmed.length;
    this.styleUniforms.uFlattenBoundsMin.value.set(bounds.min[0], bounds.min[1]);
    this.styleUniforms.uFlattenBoundsMax.value.set(bounds.max[0], bounds.max[1]);
    this.styleUniforms.uFlattenMargin.value = margin;
    this.styleUniforms.uFlattenExcavateDepth.value = excavateDepth;
    this.styleUniforms.uFlattenHeightTex.value = tex;

    for (let i = 0; i < FLATTEN_MAX_VERTICES; i++) {
      if (i < trimmed.length) {
        this.styleUniforms.uFlattenPoly.value[i]!.set(trimmed[i]!.x, trimmed[i]!.z);
      } else {
        this.styleUniforms.uFlattenPoly.value[i]!.set(0, 0);
      }
    }
  }

  /**
   * Clears active terrain polygon flattening.
   */
  public clearFlattenPolygon(): void {
    this.styleUniforms.uFlattenActive.value = 0.0;
    this.styleUniforms.uFlattenPolyCount.value = 0;
  }

  /**
   * Updates geographic origin and recomputes the Earth-Fixed ECEF to local ENU coordinate matrix.
   */
  public updateOrigin(origin: LatLngAlt, geoidHeight: number = -30.0): void {
    this.currentOrigin = origin;
    this.geoidHeight = geoidHeight;

    if (!this.tilesRenderer) return;

    const latRad = origin.lat * (Math.PI / 180);
    const lngRad = origin.lng * (Math.PI / 180);
    const altEllipsoid = (origin.alt ?? 0) + geoidHeight;

    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const sinLng = Math.sin(lngRad);
    const cosLng = Math.cos(lngRad);

    const n = WGS84_A / Math.sqrt(1.0 - WGS84_E2 * sinLat * sinLat);
    const x = (n + altEllipsoid) * cosLat * cosLng;
    const y = (n + altEllipsoid) * cosLat * sinLng;
    const z = ((1.0 - WGS84_E2) * n + altEllipsoid) * sinLat;

    // Three.js X = East, Y = Up, Z = -North
    const m00 = -sinLng;
    const m01 = cosLng;
    const m02 = 0;
    const m03 = -(m00 * x + m01 * y + m02 * z);

    const m10 = cosLat * cosLng;
    const m11 = cosLat * sinLng;
    const m12 = sinLat;
    const m13 = -(m10 * x + m11 * y + m12 * z);

    const m20 = sinLat * cosLng;
    const m21 = sinLat * sinLng;
    const m22 = -cosLat;
    const m23 = -(m20 * x + m21 * y + m22 * z);

    const localMatrix = new THREE.Matrix4();
    localMatrix.set(
      m00, m01, m02, m03,
      m10, m11, m12, m13,
      m20, m21, m22, m23,
      0,   0,   0,   1
    );

    this.tilesRenderer.group.matrix.copy(localMatrix);
    this.tilesRenderer.group.matrixAutoUpdate = false;
  }

  /**
   * Sets the visual rendering mode of the 3D tiles (clay, textured, grayscale, blueprint).
   */
  public setRenderMode(mode: 'clay' | 'textured' | 'grayscale' | 'blueprint', clayPreset?: ClayPresetId): void {
    this.renderMode = mode;
    if (clayPreset) this.clayPreset = clayPreset;

    const clayDef = CLAY_PRESETS[this.clayPreset] || CLAY_PRESETS['warm-clay'];
    this.styleUniforms.uTileRenderMode.value = mode === 'clay' ? 1.0 : mode === 'grayscale' ? 2.0 : mode === 'blueprint' ? 3.0 : 0.0;
    this.styleUniforms.uTileColor.value.set(clayDef.color);
    this.styleUniforms.uTileRoughness.value = clayDef.roughness;
    this.styleUniforms.uTileMetalness.value = clayDef.metalness;
  }

  /**
   * Called every frame in the viewport animation loop to drive LOD streaming.
   */
  public update(camera: THREE.Camera, renderer?: THREE.WebGLRenderer): void {
    if (this.isDisposed || !this.tilesRenderer) return;

    try {
      this.tilesRenderer.setCamera(camera);
      if (renderer) {
        this.tilesRenderer.setResolutionFromRenderer(camera, renderer);
      }
      this.tilesRenderer.update();
    } catch {
      // Ignore transient update frame errors
    }
  }

  /**
   * Lazily instantiates or retrieves the TerrainManager for this 3D tiles layer.
   */
  public getTerrainManager(scene?: THREE.Scene): TerrainManager {
    if (!this.terrainManager) {
      this.terrainManager = new TerrainManager({
        scene,
        tilesLayer: this,
        tilesRenderer: this.tilesRenderer
      });
    } else if (scene && !this.terrainManager.scene) {
      this.terrainManager.attachScene(scene);
    }
    return this.terrainManager;
  }

  /**
   * Performs raycasting against resident 3D tile meshes and internal geometry.
   */
  public raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
    if (this.isDisposed) return;
    if (this.tilesRenderer && typeof (this.tilesRenderer as any).raycast === 'function') {
      try {
        (this.tilesRenderer as any).raycast(raycaster, intersects);
      } catch {
        // Fallback to group intersection
      }
    }
    this.group.updateMatrixWorld(true);
    raycaster.intersectObject(this.group, true, intersects);
  }

  /**
   * Samples the top surface height at (x, z) on this 3D tiles layer.
   */
  public sampleHeight(x: number, z: number): number | null {
    return this.getTerrainManager().sampleHeight(x, z);
  }

  /**
   * Samples the 9-point street-level ground height at (x, z) on this 3D tiles layer.
   */
  public sampleGroundHeight(x: number, z: number, spreadM = 4): number | null {
    return this.getTerrainManager().sampleGroundHeight(x, z, spreadM);
  }

  /**
   * Cleanly disposes all WebGL GPU memory and network caches.
   */
  public dispose(): void {
    this.isDisposed = true;
    if (this.tilesRenderer) {
      try {
        this.group.remove(this.tilesRenderer.group);
        this.tilesRenderer.dispose();
      } catch (e) {
        // Ignore dispose errors
      }
      this.tilesRenderer = null;
    }
    this.terrainManager = undefined;
  }
}
