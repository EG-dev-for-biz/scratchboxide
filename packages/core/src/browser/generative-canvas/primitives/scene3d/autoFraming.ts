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
    minDistance?: number;      // default: 0.5 (only keeps the camera clear of the near plane)
    force?: boolean;
    /** Direction of key light (from origin towards light) to orient camera towards illuminated facade */
    keyLightDirection?: [number, number, number];
}

export interface SceneBoundsResult {
    box: THREE.Box3;
    sphere: THREE.Sphere;
    hasGeometry: boolean;
}

/**
 * Computes bounding box and sphere of scene geometry, ignoring helper grids, lights, and skies.
 * Intelligently identifies focal hero geometry vs massive flat ground planes to prevent camera over-retreat.
 */
/**
 * Terrain is tagged `sbFramingBackground` when attached (narrower than `sbEnvironment`, which also covers the hero
 * tiles/building, since every placed object snaps onto all of it): framing focuses on what sits on the ground, not
 * the kilometres-wide ground itself.
 */
function hasEnvironmentAncestor(object: THREE.Object3D): boolean {
    for (let cur: THREE.Object3D | null = object; cur; cur = cur.parent) {
        if (cur.userData?.sbFramingBackground) return true;
    }
    return false;
}

export function computeSceneGeometryBounds(scene: THREE.Scene): SceneBoundsResult {
    const box = new THREE.Box3();
    const focalBox = new THREE.Box3();
    let hasGeometry = false;
    let hasFocalGeometry = false;

    scene.traverse((child) => {
        if (child === scene) return;
        // Skip invisible objects, lights, cameras, skies, helpers, and gizmos
        if (!child.visible) return;
        if ((child as any).isLight || (child as any).isCamera || (child as any).isHelper) return;
        if ((child as any).isGridHelper || child.userData?.isGizmo || child.userData?.handleType) return;
        const name = child.name || '';
        if (
            // `sb-` is also the viewport's own internal-helper prefix (sb-selection-helper, sb-grid-helper, ...), but
            // mergeStagedParts.ts (the draw-call-reduction work) names a staged building's REAL merged meshes
            // `sb-merged-parts-<n>`: skipping those here excluded the hero building from every framing bound, leaving
            // only background geometry (e.g. terrain) to frame on — the second half of the vector-first-paint/terrain
            // "nothing structural" bug, found live with a staged Haughwout build.
            (name.startsWith('sb-') && !name.startsWith('sb-merged-parts-')) ||
            name.startsWith('atmosphere_') ||
            name.startsWith('terrain_') ||
            name.startsWith('grid_') ||
            name === 'sky_dome' ||
            name === 'AtmosphericSkyDome' ||
            name === 'PhysicalSunDisc' ||
            name.includes('SkyDome') ||
            name.includes('SunDisc') ||
            name.includes('Orbit Ring') ||
            name === 'volumetric-god-rays' ||
            name.includes('god-rays') ||
            name === 'selectionBox' ||
            name === 'GooglePhotorealistic3DTiles' ||
            name.startsWith('3d-tiles') ||
            name.startsWith('tiles_') ||
            name === 'solar-system'
        ) {
            return;
        }

        if ((child as any).isMesh || (child as any).isPoints || (child as any).isInstancedMesh) {
            box.expandByObject(child);
            hasGeometry = true;

            // Check if this object is a flat ground plane or massive terrain/tile background vs focal structure
            const childBox = new THREE.Box3().setFromObject(child);
            const childSize = new THREE.Vector3();
            childBox.getSize(childSize);
            const isFlatGround = (name.includes('ground') || name.includes('plane') || name.includes('floor')) && childSize.y < 1.0 && Math.max(childSize.x, childSize.z) > 40.0;
            const isBackgroundTileOrTerrain =
                hasEnvironmentAncestor(child) ||
                name.includes('tile-clay') ||
                name.includes('BakedTerrain') ||
                name.includes('tile_mesh') ||
                name.startsWith('external-object-tile') ||
                (child.parent && (child.parent.name.includes('tile-clay') || child.parent.name.startsWith('external-object-tile'))) ||
                (Math.max(childSize.x, childSize.z) > 80.0 && (child.name.toLowerCase().includes('terrain') || child.name.toLowerCase().includes('tile')));

            if (!isFlatGround && !isBackgroundTileOrTerrain) {
                focalBox.expandByObject(child);
                hasFocalGeometry = true;
            }
        }
    });

    const sphere = new THREE.Sphere();
    const effectiveBox = (hasFocalGeometry && !focalBox.isEmpty()) ? focalBox : box;
    if (hasGeometry && !effectiveBox.isEmpty()) {
        effectiveBox.getBoundingSphere(sphere);
    }
    return { box: effectiveBox, sphere, hasGeometry };
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
        minDistance = 0.5,
        force = false
    } = options;

    const center = bounds.sphere.center;
    // Small floors only: a 1 m radius / 15 m distance minimum framed a 0.5 m prop from 15 m away, as a speck.
    const radius = Math.max(bounds.sphere.radius, 0.05);

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

            // Detect generic boilerplate camera position [15, 12, 15] or [15, ty + 12, 15]
            const isBoilerplateDefault =
                Math.abs(camPos.x - 15) < 0.1 &&
                Math.abs(camPos.z - 15) < 0.1 &&
                Math.abs(camPos.y - 12) < 5.0;

            // Detect if camera is clipping inside geometry or dangerously close to bounds
            const isInsideGeometry = bounds.box.containsPoint(camPos) || dist < radius * 1.15;

            // Only retain cameraDef if it is an intentional, valid camera safely outside geometry
            if (!isBoilerplateDefault && !isInsideGeometry) {
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
    }

    // Otherwise, auto-frame to optimal standoff distance
    const fovRad = (fovDegrees * Math.PI) / 180.0;
    const optimalDist = Math.max(minDistance, (radius / Math.sin(fovRad / 2.0)) * marginMultiplier);

    let effAzimuthDeg = azimuthDeg;
    if (options.keyLightDirection && Array.isArray(options.keyLightDirection) && options.keyLightDirection.length >= 3) {
        const [lx, , lz] = options.keyLightDirection;
        if (Math.hypot(lx, lz) > 0.001) {
            // Orient towards the illuminated facade with an aesthetic 15° beauty angle
            effAzimuthDeg = (Math.atan2(lx, lz) * 180.0 / Math.PI) + 15.0;
        }
    }

    const phi = (90.0 - elevationDeg) * (Math.PI / 180.0); // zenith angle
    const theta = effAzimuthDeg * (Math.PI / 180.0);

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
