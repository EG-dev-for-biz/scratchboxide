/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';

export interface AutoFramingResult {
    position: [number, number, number];
    target: [number, number, number];
    distance: number;
    theta: number;
    phi: number;
    radius: number;
    center: [number, number, number];
    autoFramed: boolean;
}

export interface AutoFramingOptions {
    fovDegrees?: number;
    marginMultiplier?: number; // default: 1.35
    elevationDeg?: number;     // default: 28 degrees
    azimuthDeg?: number;       // default: 45 degrees
    minDistance?: number;      // default: 15.0
    force?: boolean;
}

export interface SceneBoundsResult {
    box: THREE.Box3;
    sphere: THREE.Sphere;
    hasGeometry: boolean;
}

/**
 * Computes bounding box and sphere of scene geometry, ignoring helper grids, lights, and skies.
 */
export function computeSceneGeometryBounds(scene: THREE.Scene): SceneBoundsResult {
    const box = new THREE.Box3();
    let hasGeometry = false;

    scene.traverse((child) => {
        if (child === scene) return;
        // Skip lights, cameras, skies, helpers
        if ((child as any).isLight || (child as any).isCamera || (child as any).isHelper) return;
        const name = child.name || '';
        if (
            name.startsWith('atmosphere_') ||
            name.startsWith('terrain_') ||
            name.startsWith('grid_') ||
            name === 'sky_dome' ||
            name === 'selectionBox' ||
            name === 'GooglePhotorealistic3DTiles' ||
            name.startsWith('3d-tiles') ||
            name.startsWith('tiles_')
        ) {
            return;
        }

        if ((child as any).isMesh || (child as any).isPoints || (child as any).isInstancedMesh) {
            box.expandByObject(child);
            hasGeometry = true;
        }
    });

    const sphere = new THREE.Sphere();
    if (hasGeometry && !box.isEmpty()) {
        box.getBoundingSphere(sphere);
    }
    return { box, sphere, hasGeometry };
}

/**
 * Calculates standoff camera parameters to fully frame the scene without wall clipping.
 */
export function calculateStandoffCamera(
    bounds: SceneBoundsResult,
    cameraDef?: { position?: [number, number, number]; target?: [number, number, number]; fov?: number },
    options: AutoFramingOptions = {}
): AutoFramingResult | null {
    if (!bounds.hasGeometry || bounds.box.isEmpty()) return null;

    const {
        fovDegrees = cameraDef?.fov ?? 60.0,
        marginMultiplier = 1.35,
        elevationDeg = 28.0,
        azimuthDeg = 45.0,
        minDistance = 15.0,
        force = false
    } = options;

    const center = bounds.sphere.center;
    const radius = Math.max(bounds.sphere.radius, 1.0);

    // If cameraDef has an explicit position and not forced to re-frame, respect camera coordinates!
    if (!force && cameraDef?.position && Array.isArray(cameraDef.position) && cameraDef.position.length >= 3) {
        const camPos = new THREE.Vector3(cameraDef.position[0], cameraDef.position[1], cameraDef.position[2]);
        if (!isNaN(camPos.x) && !isNaN(camPos.y) && !isNaN(camPos.z) && (camPos.x !== 0 || camPos.y !== 0 || camPos.z !== 0)) {
            const tx = cameraDef.target ? cameraDef.target[0] : center.x;
            const ty = cameraDef.target ? cameraDef.target[1] : center.y;
            const tz = cameraDef.target ? cameraDef.target[2] : center.z;
            const dx = camPos.x - tx;
            const dy = camPos.y - ty;
            const dz = camPos.z - tz;
            const dist = Math.max(0.1, Math.hypot(dx, dy, dz));
            return {
                position: [camPos.x, camPos.y, camPos.z],
                target: [tx, ty, tz],
                distance: dist,
                phi: Math.acos(Math.max(-1, Math.min(1, dy / dist))),
                theta: Math.atan2(dx, dz),
                radius,
                center: [center.x, center.y, center.z],
                autoFramed: false
            };
        }
    }

    // Otherwise, auto-frame to optimal standoff distance
    const fovRad = (fovDegrees * Math.PI) / 180.0;
    const optimalDist = Math.max(minDistance, (radius / Math.sin(fovRad / 2.0)) * marginMultiplier);

    const phi = (90.0 - elevationDeg) * (Math.PI / 180.0); // zenith angle
    const theta = azimuthDeg * (Math.PI / 180.0);

    const px = center.x + optimalDist * Math.sin(phi) * Math.sin(theta);
    const py = center.y + optimalDist * Math.cos(phi);
    const pz = center.z + optimalDist * Math.sin(phi) * Math.cos(theta);

    const targetY = center.y;
    return {
        position: [px, py, pz],
        target: [center.x, targetY, center.z],
        distance: optimalDist,
        phi,
        theta,
        radius,
        center: [center.x, center.y, center.z],
        autoFramed: true
    };
}
