/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from 'three';

export interface DualPayloadNode {
  id: string;
  boundingSphere: THREE.Sphere;
  geometricError: number;
  meshPayloadUrl?: string;
  splatPayloadUrl?: string;
  splatCount?: number;
  children?: DualPayloadNode[];
  parent?: DualPayloadNode;

  // Runtime state
  isLoaded?: boolean;
  isVisible?: boolean;
  meshObject?: THREE.Object3D;
  splatObject?: THREE.Object3D;

  // Cross-dissolve fade state
  fadeProgress?: number;
  isFading?: boolean;
  fadeDirection?: 'in' | 'out';
  fadeStartTime?: number;
}

export interface DualPayloadStreamerOptions {
  camera: THREE.PerspectiveCamera;
  errorTarget?: number; // SSE pixel threshold (default 4.0)
  maxSplatBudget?: number; // Maximum active splats (default 2,000,000)
  targetFrameDurationMs?: number; // Target frame time budget (default 16.6ms for 60fps)
  crossFadeDurationMs?: number; // Duration of LOD cross-dissolve fade in ms (default 250ms)
  onLoadPayload?: (node: DualPayloadNode) => Promise<{ mesh?: THREE.Object3D; splat?: THREE.Object3D }>;
  onDisposePayload?: (node: DualPayloadNode) => void;
  onLoadNodePayload?: (node: DualPayloadNode) => Promise<{ mesh?: THREE.Object3D; splat?: THREE.Object3D }>;
  onDisposeNodePayload?: (node: DualPayloadNode) => void;
}

/**
 * Single-pass hierarchical dual-payload octree streamer.
 * Simultaneously coordinates Screen-Space Error (SSE) LOD traversal for both
 * polygonal 3D tiles and 3D Gaussian Splat primitives with dynamic framerate budgeting
 * and smooth cross-dissolve LOD transitions.
 */
export class DualPayloadOctreeStreamer {
  private camera: THREE.PerspectiveCamera;
  private errorTarget: number;
  private maxSplatBudget: number;
  private currentSplatBudget: number;
  private targetFrameDurationMs: number;
  private crossFadeDurationMs: number;
  private lastUpdateTimeMs: number = 0;

  private rootNodes: DualPayloadNode[] = [];
  private activeNodes: Set<DualPayloadNode> = new Set();
  private fadingNodes: Set<DualPayloadNode> = new Set();
  private visibleSplatsCount: number = 0;
  private visibleMeshesCount: number = 0;

  // Frustum culling
  private frustum: THREE.Frustum = new THREE.Frustum();
  private projScreenMatrix: THREE.Matrix4 = new THREE.Matrix4();

  // Callbacks
  private onLoadPayload?: (node: DualPayloadNode) => Promise<{ mesh?: THREE.Object3D; splat?: THREE.Object3D }>;
  private onDisposePayload?: (node: DualPayloadNode) => void;

  constructor(options: DualPayloadStreamerOptions) {
    this.camera = options.camera;
    this.errorTarget = options.errorTarget ?? 4.0;
    this.maxSplatBudget = options.maxSplatBudget ?? 2000000;
    this.currentSplatBudget = this.maxSplatBudget;
    this.targetFrameDurationMs = options.targetFrameDurationMs ?? 16.6;
    this.crossFadeDurationMs = options.crossFadeDurationMs ?? 250;

    this.onLoadPayload = options.onLoadPayload ?? options.onLoadNodePayload;
    this.onDisposePayload = options.onDisposePayload ?? options.onDisposeNodePayload;
  }

  public addRootNode(node: DualPayloadNode): void {
    this.rootNodes.push(node);
  }

  public clearRoots(): void {
    for (const active of this.activeNodes) {
      this.unloadNode(active);
    }
    for (const fading of this.fadingNodes) {
      this.unloadNode(fading);
    }
    this.activeNodes.clear();
    this.fadingNodes.clear();
    this.rootNodes = [];
    this.visibleSplatsCount = 0;
    this.visibleMeshesCount = 0;
  }

  public getActiveNodes(): DualPayloadNode[] {
    return Array.from(this.activeNodes);
  }

  public getVisibleSplatsCount(): number {
    return this.visibleSplatsCount;
  }

  public getVisibleMeshesCount(): number {
    return this.visibleMeshesCount;
  }

  public getVisibleSplatCount(): number {
    return this.visibleSplatsCount;
  }

  public getVisibleMeshCount(): number {
    return this.visibleMeshesCount;
  }

  public getCurrentSplatBudget(): number {
    return this.currentSplatBudget;
  }

  public setErrorTarget(sse: number): void {
    this.errorTarget = Math.max(0.1, sse);
  }

  public getErrorTarget(): number {
    return this.errorTarget;
  }

  public setMaxSplatBudget(budget: number): void {
    this.maxSplatBudget = Math.max(1000, budget);
    this.currentSplatBudget = this.maxSplatBudget;
  }

  public getMaxSplatBudget(): number {
    return this.maxSplatBudget;
  }

  /**
   * Dynamically adjusts splat budget based on last frame duration.
   * If frame time exceeds targetFrameDurationMs, throttles budget down.
   */
  public reportFrameDuration(actualFrameDurationMs: number): void {
    const ratio = this.targetFrameDurationMs / Math.max(1.0, actualFrameDurationMs);
    if (ratio < 0.9) {
      // Frame drop: throttle budget down smoothly
      this.currentSplatBudget = Math.max(10000, Math.floor(this.currentSplatBudget * 0.92));
    } else if (ratio > 1.2 && this.currentSplatBudget < this.maxSplatBudget) {
      // Plenty of headroom: slowly recover budget
      this.currentSplatBudget = Math.min(this.maxSplatBudget, Math.floor(this.currentSplatBudget * 1.05));
    }
  }

  /**
   * Adapts splat budget dynamically based on frame duration telemetry.
   */
  public reportFrameTelemetry(lastFrameDurationMs: number): void {
    this.reportFrameDuration(lastFrameDurationMs);
  }

  /**
   * Traverses octree hierarchy, evaluates SSE, frustum culls, and triggers load/unload with cross-fading.
   */
  public update(viewportHeight: number, currentTimeMs = (typeof performance !== 'undefined' ? performance.now() : Date.now())): void {
    this.lastUpdateTimeMs = currentTimeMs;
    // Update frustum
    this.projScreenMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

    const nextActiveNodes = new Set<DualPayloadNode>();
    let accumulatedSplats = 0;

    for (const root of this.rootNodes) {
      this.traverseNode(root, viewportHeight, nextActiveNodes, accumulatedSplats);
    }

    // Unload or fade out nodes that are no longer active
    for (const active of this.activeNodes) {
      if (!nextActiveNodes.has(active)) {
        if (this.crossFadeDurationMs > 0 && active.isLoaded) {
          active.fadeDirection = 'out';
          active.fadeStartTime = currentTimeMs;
          active.isFading = true;
          this.fadingNodes.add(active);
        } else {
          this.unloadNode(active);
        }
      }
    }

    // Process nodes fading in or out
    if (this.crossFadeDurationMs > 0 && this.fadingNodes.size > 0) {
      for (const node of Array.from(this.fadingNodes)) {
        const elapsed = currentTimeMs - (node.fadeStartTime ?? currentTimeMs);
        const t = Math.min(1.0, elapsed / this.crossFadeDurationMs);
        if (node.fadeDirection === 'in') {
          node.fadeProgress = t;
          this.applyNodeOpacity(node, t);
          if (t >= 1.0) {
            node.isFading = false;
            this.fadingNodes.delete(node);
          }
        } else if (node.fadeDirection === 'out') {
          node.fadeProgress = 1.0 - t;
          this.applyNodeOpacity(node, 1.0 - t);
          if (t >= 1.0) {
            node.isFading = false;
            this.fadingNodes.delete(node);
            this.unloadNode(node);
          }
        }
      }
    }

    // Update active set and counters
    this.activeNodes = nextActiveNodes;
    this.visibleSplatsCount = 0;
    this.visibleMeshesCount = 0;

    for (const node of this.activeNodes) {
      if (node.splatCount) this.visibleSplatsCount += node.splatCount;
      if (node.meshPayloadUrl) this.visibleMeshesCount++;
    }
  }

  private traverseNode(
    node: DualPayloadNode,
    viewportHeight: number,
    nextActiveNodes: Set<DualPayloadNode>,
    accumulatedSplats: number
  ): void {
    // 1. Frustum culling
    if (!this.frustum.intersectsSphere(node.boundingSphere)) {
      return;
    }

    // 2. Compute distance from camera to sphere surface
    const distanceToCamera = Math.max(0.001, this.camera.position.distanceTo(node.boundingSphere.center) - node.boundingSphere.radius);

    // 3. Compute Screen-Space Error (SSE)
    const sse = DualPayloadOctreeStreamer.computeScreenSpaceError(
      node.geometricError,
      distanceToCamera,
      this.camera.fov,
      viewportHeight
    );

    const hasChildren = node.children && node.children.length > 0;
    const canRefineSplatBudget = accumulatedSplats + (node.splatCount ?? 0) <= this.currentSplatBudget;

    if (sse > this.errorTarget && hasChildren && canRefineSplatBudget) {
      // Needs refinement: recurse into children
      for (const child of node.children!) {
        this.traverseNode(child, viewportHeight, nextActiveNodes, accumulatedSplats + (node.splatCount ?? 0));
      }
    } else {
      // Meets error target or is a leaf: mark active
      nextActiveNodes.add(node);
      this.loadNode(node);
    }
  }

  private loadNode(node: DualPayloadNode): void {
    if (node.isLoaded || !this.onLoadPayload) return;
    node.isLoaded = true;
    this.onLoadPayload(node)
      .then(({ mesh, splat }) => {
        node.meshObject = mesh;
        node.splatObject = splat;
        node.isVisible = true;

        if (this.crossFadeDurationMs > 0) {
          node.fadeProgress = 0.0;
          node.fadeDirection = 'in';
          node.fadeStartTime = this.lastUpdateTimeMs || (typeof performance !== 'undefined' ? performance.now() : Date.now());
          node.isFading = true;
          this.fadingNodes.add(node);
          this.applyNodeOpacity(node, 0.0);
        } else {
          node.fadeProgress = 1.0;
          this.applyNodeOpacity(node, 1.0);
        }
      })
      .catch((err) => {
        console.warn(`[DualPayloadOctreeStreamer] Failed to load node payload ${node.id}:`, err);
        node.isLoaded = false;
      });
  }

  private unloadNode(node: DualPayloadNode): void {
    if (!node.isLoaded) return;
    if (this.onDisposePayload) {
      this.onDisposePayload(node);
    }
    node.isVisible = false;
    node.isLoaded = false;
    node.meshObject = undefined;
    node.splatObject = undefined;
    node.isFading = false;
    this.fadingNodes.delete(node);
  }

  private applyNodeOpacity(node: DualPayloadNode, opacity: number): void {
    const updateObj = (obj?: THREE.Object3D) => {
      if (!obj) return;
      obj.traverse((child: any) => {
        if (child.material) {
          if (Array.isArray(child.material)) {
            for (const m of child.material) {
              m.opacity = opacity;
              m.transparent = true;
            }
          } else {
            child.material.opacity = opacity;
            child.material.transparent = true;
          }
        }
      });
    };
    updateObj(node.meshObject);
    updateObj(node.splatObject);
  }

  /**
   * Ingests and parses standard OGC 3D Tiles 1.1 / Cesium tileset JSON into a DualPayloadNode hierarchy.
   */
  public loadTilesetJson(tileset: Record<string, any> | string, baseUrl = ''): DualPayloadNode {
    const json = typeof tileset === 'string' ? JSON.parse(tileset) : tileset;
    const root = json.root;
    if (!root) throw new Error('Invalid 3D Tileset: missing root node');

    const parseNode = (rawNode: any, parent?: DualPayloadNode, idPrefix = 'tile'): DualPayloadNode => {
      const sphere = DualPayloadOctreeStreamer.parseBoundingVolume(rawNode.boundingVolume);
      const contentUri = rawNode.content?.uri || rawNode.content?.url;
      const fullUrl = contentUri ? (baseUrl ? baseUrl.replace(/\/?$/, '/') + contentUri : contentUri) : undefined;

      const isSplat = fullUrl ? (fullUrl.endsWith('.spz') || fullUrl.endsWith('.splat') || fullUrl.includes('splat')) : false;
      const isMesh = fullUrl ? (!isSplat || fullUrl.endsWith('.glb') || fullUrl.endsWith('.gltf') || fullUrl.endsWith('.b3dm')) : false;

      const node: DualPayloadNode = {
        id: `${idPrefix}_${Math.random().toString(36).slice(2, 8)}`,
        boundingSphere: sphere,
        geometricError: rawNode.geometricError ?? 0,
        meshPayloadUrl: isMesh ? fullUrl : undefined,
        splatPayloadUrl: isSplat ? fullUrl : (fullUrl?.endsWith('.glb') ? fullUrl : undefined),
        parent,
        children: []
      };

      if (Array.isArray(rawNode.children)) {
        node.children = rawNode.children.map((c: any, idx: number) => parseNode(c, node, `${node.id}_${idx}`));
      }

      return node;
    };

    const parsedRoot = parseNode(root, undefined, 'root');
    this.addRootNode(parsedRoot);
    return parsedRoot;
  }

  /**
   * Parses OGC 3D Tiles boundingVolume (sphere, box, or region) into THREE.Sphere.
   */
  public static parseBoundingVolume(volume: any): THREE.Sphere {
    if (!volume) return new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100);

    if (volume.sphere && Array.isArray(volume.sphere) && volume.sphere.length >= 4) {
      return new THREE.Sphere(
        new THREE.Vector3(volume.sphere[0], volume.sphere[1], volume.sphere[2]),
        volume.sphere[3]
      );
    }

    if (volume.box && Array.isArray(volume.box) && volume.box.length >= 12) {
      const center = new THREE.Vector3(volume.box[0], volume.box[1], volume.box[2]);
      const ax = new THREE.Vector3(volume.box[3], volume.box[4], volume.box[5]);
      const ay = new THREE.Vector3(volume.box[6], volume.box[7], volume.box[8]);
      const az = new THREE.Vector3(volume.box[9], volume.box[10], volume.box[11]);
      const radius = Math.sqrt(ax.lengthSq() + ay.lengthSq() + az.lengthSq());
      return new THREE.Sphere(center, radius);
    }

    if (volume.region && Array.isArray(volume.region) && volume.region.length >= 6) {
      // Fallback bounding sphere for geographic region [west, south, east, north, minHeight, maxHeight]
      return new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1000);
    }

    return new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100);
  }

  /**
   * Evaluates the standard Screen-Space Error (SSE) formula in pixels:
   * SSE = (geometricError * viewportHeight) / (2 * distance * tan(FOV / 2))
   */
  public static computeScreenSpaceError(
    geometricError: number,
    distanceMeters: number,
    fovDegrees: number,
    viewportHeight: number
  ): number {
    const fovRad = (fovDegrees * Math.PI) / 180;
    const sse = (geometricError * viewportHeight) / (2.0 * Math.max(0.001, distanceMeters) * Math.tan(fovRad / 2.0));
    return sse;
  }

  public dispose(): void {
    this.clearRoots();
  }
}
