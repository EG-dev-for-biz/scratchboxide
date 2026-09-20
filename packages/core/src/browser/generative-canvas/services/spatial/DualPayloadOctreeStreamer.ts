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
}

export interface DualPayloadStreamerOptions {
  camera: THREE.PerspectiveCamera;
  errorTarget?: number; // SSE pixel threshold (default 4.0)
  maxSplatBudget?: number; // Maximum active splats (default 2,000,000)
  targetFrameDurationMs?: number; // Target frame time budget (default 16.6ms for 60fps)
  onLoadPayload?: (node: DualPayloadNode) => Promise<{ mesh?: THREE.Object3D; splat?: THREE.Object3D }>;
  onDisposePayload?: (node: DualPayloadNode) => void;
  onLoadNodePayload?: (node: DualPayloadNode) => Promise<{ mesh?: THREE.Object3D; splat?: THREE.Object3D }>;
  onDisposeNodePayload?: (node: DualPayloadNode) => void;
}

/**
 * Single-pass hierarchical dual-payload octree streamer.
 * Simultaneously coordinates Screen-Space Error (SSE) LOD traversal for both
 * polygonal 3D tiles and 3D Gaussian Splat primitives with dynamic framerate budgeting.
 */
export class DualPayloadOctreeStreamer {
  private camera: THREE.PerspectiveCamera;
  private errorTarget: number;
  private maxSplatBudget: number;
  private currentSplatBudget: number;
  private targetFrameDurationMs: number;

  private rootNodes: DualPayloadNode[] = [];
  private activeNodes: Set<DualPayloadNode> = new Set();
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

    this.onLoadPayload = options.onLoadPayload ?? options.onLoadNodePayload;
    this.onDisposePayload = options.onDisposePayload ?? options.onDisposeNodePayload;
  }

  public addRootNode(node: DualPayloadNode): void {
    this.rootNodes.push(node);
  }

  public clearRoots(): void {
    for (const node of this.activeNodes) {
      this.unloadNode(node);
    }
    this.activeNodes.clear();
    this.rootNodes = [];
    this.visibleSplatsCount = 0;
    this.visibleMeshesCount = 0;
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

  public setErrorTarget(target: number): void {
    this.errorTarget = Math.max(0.1, target);
  }

  /**
   * Adapts splat budget dynamically based on frame duration telemetry.
   */
  public reportFrameTelemetry(lastFrameDurationMs: number): void {
    if (lastFrameDurationMs > this.targetFrameDurationMs * 1.1) {
      // Frame took too long; throttle down budget by 10%
      this.currentSplatBudget = Math.max(250000, Math.floor(this.currentSplatBudget * 0.9));
    } else if (lastFrameDurationMs < this.targetFrameDurationMs * 0.8 && this.currentSplatBudget < this.maxSplatBudget) {
      // Plentiful headroom; gently ramp back up
      this.currentSplatBudget = Math.min(this.maxSplatBudget, Math.floor(this.currentSplatBudget * 1.05));
    }
  }

  /**
   * Traverses the octree hierarchy and refines nodes based on SSE and splat budget.
   * Call once per animation frame.
   *
   * @param viewportHeight Canvas height in pixels
   */
  public update(viewportHeight: number): void {
    // Update frustum
    this.projScreenMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

    const nextActiveNodes = new Set<DualPayloadNode>();
    let accumulatedSplats = 0;

    for (const root of this.rootNodes) {
      this.traverseNode(root, viewportHeight, nextActiveNodes, accumulatedSplats);
    }

    // Unload nodes that are no longer active
    for (const active of this.activeNodes) {
      if (!nextActiveNodes.has(active)) {
        this.unloadNode(active);
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
