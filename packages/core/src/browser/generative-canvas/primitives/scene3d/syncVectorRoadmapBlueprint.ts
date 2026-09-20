/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from 'three';
import type { VectorRoadmapConfig } from '../../canvas-types';
import { GoogleMapsService } from '../../services/google-maps-service';
import { removeAndDispose, type VectorRoadmapHandle } from './types';

export interface VectorRoadmapBlueprintInput {
    config?: VectorRoadmapConfig;
    geoAnchor?: { lat: number; lng: number; elevation?: number; active?: boolean } | null;
}

export function syncVectorRoadmapBlueprint(
    scene: THREE.Scene,
    currentHandle: VectorRoadmapHandle | null,
    input: VectorRoadmapBlueprintInput
): VectorRoadmapHandle {
    const { config, geoAnchor } = input;
    const isEnabled = Boolean(
        config?.enabled &&
        (config?.groundBlueprint ?? true) &&
        geoAnchor?.lat !== undefined &&
        geoAnchor?.lng !== undefined
    );

    if (!isEnabled) {
        if (currentHandle) {
            currentHandle.dispose();
        }
        return {
            blueprintMesh: null,
            dispose: () => {}
        };
    }

    const lat = geoAnchor!.lat;
    const lng = geoAnchor!.lng;
    const elevation = geoAnchor!.elevation ?? 0;
    const elevationOffset = config?.groundElevationOffset ?? -0.05;
    const size = config?.groundBlueprintSize ?? 500;
    const opacity = config?.groundBlueprintOpacity ?? 0.85;

    // Check if we can reuse the existing mesh and simply adjust opacity / position
    const existingMesh = currentHandle?.blueprintMesh;
    const lastUserData = existingMesh?.userData as {
        lat?: number;
        lng?: number;
        size?: number;
        mapId?: string;
    } | undefined;

    if (
        existingMesh &&
        lastUserData &&
        lastUserData.lat === lat &&
        lastUserData.lng === lng &&
        lastUserData.size === size &&
        lastUserData.mapId === config?.mapId
    ) {
        const mat = existingMesh.material as THREE.MeshStandardMaterial;
        if (mat) {
            mat.opacity = opacity;
            mat.transparent = opacity < 1.0;
        }
        existingMesh.position.set(0, elevation + elevationOffset, 0);
        return currentHandle!;
    }

    // Otherwise clean up previous mesh and construct new one
    if (currentHandle) {
        currentHandle.dispose();
    }

    const mapsService = GoogleMapsService.getInstance();
    const blueprintUrl = mapsService.getVectorRoadmapStaticBlueprintUrl({
        center: { lat, lng },
        zoom: 17,
        size: 1024,
        scale: 2,
        mapId: config?.mapId
    });

    const textureLoader = new THREE.TextureLoader();
    textureLoader.setCrossOrigin('anonymous');

    const geometry = new THREE.PlaneGeometry(size, size, 1, 1);
    // Rotate to lie flat on the ground (XZ plane)
    geometry.rotateX(-Math.PI / 2);

    const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.9,
        metalness: 0.1,
        transparent: opacity < 1.0,
        opacity,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'sb-vector-roadmap-blueprint';
    mesh.position.set(0, elevation + elevationOffset, 0);
    mesh.receiveShadow = true;
    mesh.userData = {
        lat,
        lng,
        size,
        mapId: config?.mapId
    };

    if (typeof document !== 'undefined') {
        textureLoader.load(
            blueprintUrl,
            (loadedTexture) => {
                loadedTexture.generateMipmaps = true;
                loadedTexture.minFilter = THREE.LinearMipmapLinearFilter;
                loadedTexture.magFilter = THREE.LinearFilter;
                loadedTexture.wrapS = THREE.ClampToEdgeWrapping;
                loadedTexture.wrapT = THREE.ClampToEdgeWrapping;
                material.map = loadedTexture;
                material.needsUpdate = true;
            },
            undefined,
            (err) => {
                console.warn('[VectorRoadmap] Failed to load static blueprint texture:', err);
            }
        );
    }

    scene.add(mesh);

    return {
        blueprintMesh: mesh,
        dispose: () => {
            removeAndDispose(scene, mesh);
        }
    };
}
