/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import {
    HeightfieldRaster,
    HeightfieldBounds
} from './HeightfieldRaster';

/**
 * Multi-point offset sample coordinates (in meters relative to center)
 * for street-level ground height determination across undulating terrain and 3D tiles.
 */
export const GROUND_SAMPLE_OFFSETS: Array<[number, number]> = [
    [0, 0],
    [4, 0],
    [-4, 0],
    [0, 4],
    [0, -4],
    [3, 3],
    [-3, 3],
    [3, -3],
    [-3, -3]
];

export interface TerrainManagerOptions {
    scene?: THREE.Scene;
    tilesLayer?: any;
    tilesRenderer?: any;
    engine?: any;
    heightfield?: HeightfieldRaster;
}

/**
 * Centrally manages 3D terrain elevation sampling and surface-snapping math.
 * Queries active terrain providers (such as Google Photorealistic 3D Tiles,
 * procedural terrain meshes, and custom environment geometry) to retrieve precise
 * ground elevation at any local coordinate.
 */
export class TerrainManager {
    private raycaster: THREE.Raycaster;
    public scene?: THREE.Scene;
    public tilesLayer?: any;
    public tilesRenderer?: any;
    public engine?: any;
    public heightfield?: HeightfieldRaster;

    constructor(options: TerrainManagerOptions = {}) {
        this.raycaster = new THREE.Raycaster();
        this.scene = options.scene;
        this.tilesLayer = options.tilesLayer;
        this.tilesRenderer = options.tilesRenderer || options.tilesLayer?.tilesRenderer;
        this.engine = options.engine;
        this.heightfield = options.heightfield;
    }

    /**
     * Attaches or updates an active HeightfieldRaster for O(1) sampling.
     */
    public attachHeightfield(raster: HeightfieldRaster): void {
        this.heightfield = raster;
    }

    /**
     * Bakes an O(1) HeightfieldRaster across the specified region using the current terrain/raycaster.
     */
    public bakeHeightfield(
        bounds: HeightfieldBounds,
        gridResolutionMeters = 2,
        precision: 'float32' | 'uint16' = 'float32',
        sampleFn?: (x: number, z: number) => number | null
    ): HeightfieldRaster {
        const widthM = Math.max(1, bounds.maxX - bounds.minX);
        const heightM = Math.max(1, bounds.maxZ - bounds.minZ);
        const gridWidth = Math.max(2, Math.ceil(widthM / gridResolutionMeters) + 1);
        const gridHeight = Math.max(2, Math.ceil(heightM / gridResolutionMeters) + 1);

        const raster = new HeightfieldRaster({
            bounds,
            gridWidth,
            gridHeight,
            precision
        });

        // Bake elevations using custom sampler or vertical raycasting
        raster.bake((x, z) => {
            if (sampleFn) {
                return sampleFn(x, z);
            }
            const hits = this.raycastVertical(x, z);
            return hits.length > 0 ? hits[0]!.point.y : null;
        });

        this.heightfield = raster;
        return raster;
    }

    /**
     * Attaches or updates the active Three.js scene.
     */
    public attachScene(scene: THREE.Scene): void {
        this.scene = scene;
    }

    /**
     * Attaches or updates the active Google 3D Tiles Layer.
     */
    public attachTilesLayer(layer: any): void {
        this.tilesLayer = layer;
        this.tilesRenderer = layer?.tilesRenderer || layer;
    }

    /**
     * Returns true if Google 3D Tiles layer is active and ready for raycasting.
     */
    public get isTilesActive(): boolean {
        return !!(this.tilesLayer || this.tilesRenderer);
    }

    /**
     * Samples the top surface height (Y coordinate) of active terrain or tiles
     * at given (x, z) coordinates via a single vertical raycast.
     */
    public sampleHeight(
        x: number,
        z: number,
        originY = 2000,
        far = 2500,
        ignoreObject?: THREE.Object3D | THREE.Object3D[]
    ): number | null {
        // Fast O(1) path via cached elevation heightfield
        if (this.heightfield && this.heightfield.contains(x, z)) {
            const fastH = this.heightfield.sampleBilinear(x, z);
            if (fastH !== null) return fastH;
        }

        const hits = this.raycastVertical(x, z, originY, far, ignoreObject);
        return hits.length > 0 ? hits[0].point.y : null;
    }

    /**
     * Street-level ground height: samples 9 offset points around (x, z) to find the minimum
     * ground elevation, preventing objects from snapping onto rooftops or tree canopies.
     */
    public sampleGroundHeight(
        x: number,
        z: number,
        spreadM = 4,
        originY = 2000,
        far = 2500,
        ignoreObject?: THREE.Object3D | THREE.Object3D[]
    ): number | null {
        // Direct single-point surface probe for additive construction & pinpoint grounding
        if (spreadM <= 0.05) {
            return this.sampleHeight(x, z, originY, far, ignoreObject);
        }

        // Fast O(1) path via cached elevation heightfield
        if (this.heightfield && this.heightfield.contains(x, z)) {
            let hMin = Infinity;
            for (const [ox, oz] of GROUND_SAMPLE_OFFSETS) {
                const scale = spreadM / 4;
                const h = this.heightfield.sampleBilinear(x + ox * scale, z + oz * scale);
                if (h !== null && h < hMin) {
                    hMin = h;
                }
            }
            if (hMin !== Infinity) return hMin;
        }

        let minY = Infinity;
        let validHits = 0;

        for (const [ox, oz] of GROUND_SAMPLE_OFFSETS) {
            const scale = spreadM / 4;
            const probeX = x + ox * scale;
            const probeZ = z + oz * scale;
            const hits = this.raycastVertical(probeX, probeZ, originY, far, ignoreObject);
            if (hits.length > 0) {
                validHits++;
                const topHitY = hits[0].point.y;
                if (topHitY < minY) {
                    minY = topHitY;
                }
            }
        }

        if (validHits === 0 || minY === Infinity) {
            // Fallback to direct single-point sample
            const direct = this.sampleHeight(x, z, originY, far, ignoreObject);
            return direct !== null ? direct : null;
        }

        return minY;
    }

    /**
     * Snaps a 3D object to the ground or underlying mesh surface at its current (x, z) location,
     * taking into account its bounding box so the bottom of the object rests directly on the terrain or surface.
     * Defaults to spreadM = 0 (exact surface point contact), enabling objects to build on top of each other
     * or on top of 3D tiles without dropping off edges.
     *
     * @param object The THREE.Object3D to ground.
     * @param offset Optional vertical elevation offset in meters (e.g. contact buffer or stand height).
     * @param spreadM Ground sampling spread in meters (0 for direct surface contact, >0 for perimeter minimum).
     * @returns The newly computed world Y position of the object, or null if no terrain hit.
     */
    public snapObjectToGround(object: THREE.Object3D, offset = 0, spreadM = 0): number | null {
        if (!object) return null;

        // Ensure matrices are up to date
        object.updateMatrixWorld(true);

        const worldPos = new THREE.Vector3();
        object.getWorldPosition(worldPos);

        const groundY = spreadM > 0
            ? (this.sampleGroundHeight(worldPos.x, worldPos.z, spreadM, 2000, 2500, object) ?? this.sampleHeight(worldPos.x, worldPos.z, 2000, 2500, object))
            : this.sampleHeight(worldPos.x, worldPos.z, 2000, 2500, object);

        if (groundY === null) return null;

        // Calculate bottom offset from bounding box
        const bbox = new THREE.Box3().setFromObject(object);
        let bottomOffset = 0;

        if (!bbox.isEmpty() && isFinite(bbox.min.y)) {
            // Distance from object world Y origin to the bottom of its geometry
            bottomOffset = worldPos.y - bbox.min.y;
        }

        const newWorldY = groundY + offset + bottomOffset;

        // Convert world position delta back to local object position
        if (object.parent) {
            const parentWorldPos = new THREE.Vector3();
            object.parent.getWorldPosition(parentWorldPos);
            object.position.y += (newWorldY - worldPos.y);
        } else {
            object.position.y = newWorldY;
        }

        object.updateMatrixWorld(true);
        return object.position.y;
    }

    /**
     * Snaps an array of objects or children within a group to the terrain.
     */
    public snapObjects(
        objects: THREE.Object3D[],
        offset = 0,
        spreadM = 4
    ): Array<{ object: THREE.Object3D; groundY: number }> {
        const results: Array<{ object: THREE.Object3D; groundY: number }> = [];

        for (const obj of objects) {
            const snappedY = this.snapObjectToGround(obj, offset, spreadM);
            if (snappedY !== null) {
                results.push({ object: obj, groundY: snappedY });
            }
        }

        return results;
    }

    /**
     * Calculates the optimal camera target (lookAt) vector grounded on the terrain elevation.
     */
    public getOptimalCameraLookAt(x = 0, z = 0, elevationOffset = 1.5): [number, number, number] {
        const groundY = this.sampleGroundHeight(x, z)
            ?? this.sampleHeight(x, z)
            ?? 0;

        return [x, groundY + elevationOffset, z];
    }

    /**
     * Samples facade base height for lights or signs on building walls.
     */
    public sampleFacadeBaseY(x: number, z: number, mountHeightM: number): number | null {
        const groundY = this.sampleGroundHeight(x, z, 3);
        if (groundY == null) return null;

        const probeOriginY = groundY + mountHeightM + 12;
        const hits = this.raycastVertical(x, z, probeOriginY, mountHeightM + 20);
        const targetY = groundY + mountHeightM;
        let bestY = groundY;
        let bestDelta = Infinity;

        for (const hit of hits) {
            if (hit.point.y < groundY + 0.8) continue;
            const delta = Math.abs(hit.point.y - targetY);
            if (delta < bestDelta) {
                bestDelta = delta;
                bestY = hit.point.y;
            }
        }

        const tolerance = Math.max(3.5, mountHeightM * 0.4);
        if (bestDelta <= tolerance && bestY > groundY + 0.8) {
            return bestY - mountHeightM + 0.02;
        }
        return groundY;
    }

    /**
     * Performs a vertical downward raycast against all active terrain geometry in the scene.
     */
    public raycastVertical(
        x: number,
        z: number,
        originY = 2000,
        far = 2500,
        ignoreObject?: THREE.Object3D | THREE.Object3D[]
    ): THREE.Intersection[] {
        const rayOrigin = new THREE.Vector3(x, originY, z);
        const rayDirection = new THREE.Vector3(0, -1, 0);
        this.raycaster.set(rayOrigin, rayDirection);
        this.raycaster.far = far;

        const hits: THREE.Intersection[] = [];
        const ignoreSet = new Set<THREE.Object3D>();

        if (ignoreObject) {
            const list = Array.isArray(ignoreObject) ? ignoreObject : [ignoreObject];
            for (const item of list) {
                if (item) {
                    item.traverse(c => ignoreSet.add(c));
                }
            }
        }

        // 1. Raycast against TilesLayer / TilesRenderer
        if (this.tilesRenderer) {
            if (typeof this.tilesRenderer.raycast === 'function') {
                try {
                    this.tilesRenderer.raycast(this.raycaster, hits);
                } catch {
                    // Ignore transient tiles renderer raycast error
                }
            }
            if (this.tilesRenderer.group && !ignoreSet.has(this.tilesRenderer.group)) {
                this.tilesRenderer.group.updateMatrixWorld(true);
                this.raycaster.intersectObject(this.tilesRenderer.group, true, hits);
            }
        }

        if (this.tilesLayer && this.tilesLayer.group && !ignoreSet.has(this.tilesLayer.group)) {
            this.tilesLayer.group.updateMatrixWorld(true);
            this.raycaster.intersectObject(this.tilesLayer.group, true, hits);
        }

        // 2. Raycast against Scene Meshes
        if (this.scene) {
            this.scene.updateMatrixWorld(true);

            // Filter out non-terrain / utility objects (helpers, gizmos, cameras, and ignored objects)
            this.scene.traverse((child: THREE.Object3D) => {
                if ((child as THREE.Mesh).isMesh) {
                    const mesh = child as THREE.Mesh;
                    if (ignoreSet.has(mesh)) return;
                    if (
                        mesh.name.includes('Gizmo') ||
                        mesh.name.includes('Helper') ||
                        mesh.name.includes('SelectionBox') ||
                        mesh.name.includes('TransformControl') ||
                        (mesh as any).userData?.isGizmo ||
                        (mesh as any).userData?.isHelper
                    ) {
                        return;
                    }
                    this.raycaster.intersectObject(mesh, false, hits);
                }
            });
        }

        // 3. Raycast against engine objects if available
        if (this.engine?.objects) {
            try {
                const geoTiles = this.engine.objects.listByKind?.('geo.tile');
                if (geoTiles && geoTiles.length > 0) {
                    for (const tile of geoTiles) {
                        if (tile.object3D && !ignoreSet.has(tile.object3D)) {
                            tile.object3D.updateMatrixWorld(true);
                            this.raycaster.intersectObject(tile.object3D, true, hits);
                        }
                    }
                }
            } catch {
                // Ignore engine access error
            }
        }

        // Filter out any hit on ignored objects just in case
        const validHits = ignoreSet.size > 0 ? hits.filter(h => !ignoreSet.has(h.object)) : hits;

        // Sort by distance (closest to ray origin = highest elevation)
        validHits.sort((a, b) => a.distance - b.distance);
        return validHits;
    }
}
