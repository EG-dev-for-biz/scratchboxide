/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

declare module '3d-tiles-renderer' {
  import * as THREE from 'three';

  export class TilesRenderer {
    public group: THREE.Group;
    public lruCache: { maxBytesSize: number; minBytesSize: number };
    public downloadQueue: { maxJobs: number };
    public parseQueue: { maxJobs: number };
    public maxTilesProcessed: number;
    public errorTarget: number;
    public rootURL: string;
    public onLoadModel?: ((scene: THREE.Object3D) => void) | null;
    constructor(url?: string);
    public registerPlugin(plugin: any): void;
    public setCamera(camera: THREE.Camera): void;
    public setResolutionFromRenderer(camera: THREE.Camera, renderer: THREE.WebGLRenderer): void;
    public update(): void;
    public raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void;
    public dispose(): void;
  }
}

declare module '3d-tiles-renderer/plugins' {
  export interface GoogleCloudAuthPluginOptions {
    apiToken?: string;
    autoRefreshToken?: boolean;
    useRecommendedSettings?: boolean;
  }

  export class GoogleCloudAuthPlugin {
    constructor(options?: GoogleCloudAuthPluginOptions);
  }
}
