/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import {
    WorldSpecification,
    TerrainElevationGrid,
    PlacedActor3D
} from './worldbuilder-types';
import { createSeededRandom } from './seededRandom';

// Local meter scale bounds for local Three.js workspace mapping (assuming [-100..100] grid bounds)
export const WORKSPACE_BOUNDS = {
    minX: -100,
    maxX: 100,
    minZ: -100,
    maxZ: 100
};

// Map region position names to local coordinate centers in meters (x, z)
export const REGION_COORDINATE_MAP: Record<string, [number, number]> = {
    center: [0, 0],
    north: [0, 60],
    south: [0, -60],
    east: [60, 0],
    west: [-60, 0],
    northeast: [50, 50],
    northwest: [-50, 50],
    southeast: [50, -50],
    southwest: [-50, -50]
};

/**
 * Bilinear sampling of the terrain height from our TerrainElevationGrid
 */
export function sampleGridElevation(
    x: number,
    z: number,
    grid: TerrainElevationGrid | null,
    bounds = WORKSPACE_BOUNDS
): number {
    if (!grid || !grid.elevations || grid.elevations.length === 0) {
        return 0.0;
    }

    const res = grid.resolution;
    const rangeX = bounds.maxX - bounds.minX;
    const rangeZ = bounds.maxZ - bounds.minZ;

    // Normalized U, V coordinates [0.0..1.0]
    const u = Math.min(Math.max((x - bounds.minX) / (rangeX || 1.0), 0.0), 1.0);
    const v = Math.min(Math.max((z - bounds.minZ) / (rangeZ || 1.0), 0.0), 1.0);

    const uFloat = u * (res - 1);
    const vFloat = v * (res - 1);
    const col0 = Math.min(Math.max(Math.floor(uFloat), 0), res - 1);
    const row0 = Math.min(Math.max(Math.floor(vFloat), 0), res - 1);
    const col1 = Math.min(col0 + 1, res - 1);
    const row1 = Math.min(row0 + 1, res - 1);

    const fu = uFloat - col0;
    const fv = vFloat - row0;

    const e00 = grid.elevations[col0 + row0 * res] ?? 0.0;
    const e10 = grid.elevations[col1 + row0 * res] ?? 0.0;
    const e01 = grid.elevations[col0 + row1 * res] ?? 0.0;
    const e11 = grid.elevations[col1 + row1 * res] ?? 0.0;

    // Bilinear interpolation
    return (1 - fu) * (1 - fv) * e00 + fu * (1 - fv) * e10 + (1 - fu) * fv * e01 + fu * fv * e11;
}

/**
 * Calculates local sloped surface normals at (x, z) to support physics slope-alignment
 */
export function estimateTerrainNormal(
    x: number,
    z: number,
    grid: TerrainElevationGrid | null,
    delta: number = 1.0
): { nx: number; ny: number; nz: number } {
    const hL = sampleGridElevation(x - delta, z, grid);
    const hR = sampleGridElevation(x + delta, z, grid);
    const hD = sampleGridElevation(x, z - delta, grid);
    const hU = sampleGridElevation(x, z + delta, grid);

    // Approximate partial derivatives
    const dx = (hR - hL) / (2 * delta);
    const dz = (hU - hD) / (2 * delta);

    // Compute normalized surface normal vector
    const len = Math.sqrt(dx * dx + dz * dz + 1.0);
    return {
        nx: -dx / len,
        ny: 1.0 / len,
        nz: -dz / len
    };
}

/**
 * Convert local scene offset in meters (x, y, z) into WGS84 Geographic Coordinate.
 */
export function localToGeo(
    x: number,
    y: number,
    z: number,
    anchor: { lat: number; lng: number; alt?: number } = { lat: 40.7812, lng: -73.9665, alt: 0 }
): { lat: number; lng: number; alt: number } {
    const metersPerLatDegree = 111139.0;
    const latRad = anchor.lat * (Math.PI / 180);
    const metersPerLngDegree = Math.max(1e-4, 111139.0 * Math.cos(latRad));

    const lat = anchor.lat - (z / metersPerLatDegree);
    const lng = anchor.lng + (x / metersPerLngDegree);
    const alt = (anchor.alt ?? 0) + y;

    return { lat, lng, alt };
}

/**
 * Half height offset to prevent meshes from clipping through the terrain surface
 */
export function getActorHalfHeight(actorType: string, scaleY: number = 1.0): number {
    switch (actorType) {
        case 'Cube':
        case 'Box':
            return 0.5 * scaleY;
        case 'Cylinder':
        case 'Cone':
            return 1.0 * scaleY;
        case 'Sphere':
            return 0.5 * scaleY;
        case 'SbVeggieTree':
            // an SB-Veggie tree's position is its trunk base, on the ground
            return 0;
        default:
            return 0.5 * scaleY;
    }
}

/**
 * Place planned objects across regions according to density and geometric rules deterministically.
 */
export function placeRegionalObjects(
    spec: WorldSpecification,
    grid: TerrainElevationGrid | null,
    seed: number = 1337,
    anchor: { lat: number; lng: number; alt?: number } = { lat: 40.7812, lng: -73.9665, alt: 0 }
): PlacedActor3D[] {
    const spawnedActors: PlacedActor3D[] = [];
    const effectiveSeed = spec.seed !== undefined ? spec.seed : seed;
    const rng = createSeededRandom(effectiveSeed);

    if (!spec.objects || spec.objects.length === 0) {
        return spawnedActors;
    }

    for (const obj of spec.objects) {
        // 1. Locate the region definition
        const region = spec.regions.find((r) => r.id === obj.regionId) || spec.regions[0];
        const centerCoord = region ? (REGION_COORDINATE_MAP[region.relativePosition] || [0, 0]) : [0, 0];
        const densityCount = Math.max(1, Math.min(100, Math.floor(obj.density)));

        for (let i = 0; i < densityCount; i++) {
            let x = centerCoord[0];
            let z = centerCoord[1];

            // 2. Apply spacing offset based on placement rules using deterministic RNG
            if (obj.placementRule === 'scattered' || obj.placementRule === 'slope_aligned') {
                const radius = region?.radiusMeters ?? 25.0;
                const angle = rng() * Math.PI * 2;
                const dist = Math.sqrt(rng()) * radius;
                x += Math.cos(angle) * dist;
                z += Math.sin(angle) * dist;
            } else if (obj.placementRule === 'perimeter') {
                const radius = (region?.radiusMeters ?? 25.0) * (0.8 + rng() * 0.2);
                const angle = (i / densityCount) * Math.PI * 2 + (rng() - 0.5) * 0.2;
                x += Math.cos(angle) * radius;
                z += Math.sin(angle) * radius;
            } else if (obj.placementRule === 'grid') {
                const side = Math.ceil(Math.sqrt(densityCount));
                const gx = (i % side) - side / 2;
                const gz = Math.floor(i / side) - side / 2;
                const spacing = 8.0;
                x += gx * spacing;
                z += gz * spacing;
            }

            // Constrain coordinates within workspace boundaries
            x = Math.max(WORKSPACE_BOUNDS.minX, Math.min(WORKSPACE_BOUNDS.maxX, x));
            z = Math.max(WORKSPACE_BOUNDS.minZ, Math.min(WORKSPACE_BOUNDS.maxZ, z));

            // 3. Sample exact elevation at ground level
            const groundY = sampleGridElevation(x, z, grid);

            // 4. Select 3D shape primitive or asset matching the category
            const rawCategory = obj.category.toLowerCase();
            let actorType = 'StaticMeshActor';
            let defaultColor = '#38bdf8';

            if (rawCategory.includes('house') || rawCategory.includes('building') || rawCategory.includes('outpost') || rawCategory.includes('dwelling') || rawCategory.includes('chalet')) {
                actorType = 'Cube';
                defaultColor = '#475569';
            } else if (rawCategory.includes('tower') || rawCategory.includes('pillar') || rawCategory.includes('satellite') || rawCategory.includes('spire') || rawCategory.includes('pylon') || rawCategory.includes('beacon')) {
                actorType = 'Cylinder';
                defaultColor = '#94a3b8';
            } else if (rawCategory.includes('rock') || rawCategory.includes('stone') || rawCategory.includes('boulder') || rawCategory.includes('crag')) {
                actorType = 'Sphere';
                defaultColor = '#57534e';
            } else if (rawCategory.includes('dome') || rawCategory.includes('bunker') || rawCategory.includes('monolith')) {
                actorType = 'Sphere';
                defaultColor = '#334155';
            } else if (rawCategory.includes('tree') || rawCategory.includes('pine') || rawCategory.includes('cactus') || rawCategory.includes('elm') || rawCategory.includes('foliage')) {
                // a place for an SB-Veggie tree (grown natively from measurements: sb.create_tree / botanical_synthesize_tree),
                // never a primitive stand-in (common/spatial/sb-veggie-lockdown.ts)
                actorType = 'SbVeggieTree';
                defaultColor = '#1e3f20';
            }

            const scaleMultiplier = obj.scale || 1.0;
            const variance = 0.85 + rng() * 0.3; // +/- 15% variance
            const finalScale = {
                x: scaleMultiplier * variance,
                y: scaleMultiplier * variance,
                z: scaleMultiplier * variance
            };

            const halfHeight = getActorHalfHeight(actorType, finalScale.y);
            const y = groundY + halfHeight + (obj.heightOffset ?? 0);

            // 5. Compute slope orientation
            let rotationX = 0;
            let rotationZ = 0;
            if (obj.placementRule === 'slope_aligned') {
                const normal = estimateTerrainNormal(x, z, grid);
                rotationX = Math.atan2(normal.nz, normal.ny) * (180 / Math.PI);
                rotationZ = -Math.atan2(normal.nx, normal.ny) * (180 / Math.PI);
            }

            const randomYaw = rng() * 360; // Deterministic yaw rotation (Y-axis)
            const pos = { x, y, z };
            const geo = localToGeo(x, y, z, anchor);

            const actor: PlacedActor3D = {
                id: `act_${obj.id}_${i}`,
                name: `${obj.category.charAt(0).toUpperCase() + obj.category.slice(1)}_${i + 1}`,
                category: 'Procedural',
                type: actorType,
                semanticClass: obj.category,
                folder: region ? `${region.name} Assets` : 'World Assets',
                position: pos,
                rotation: { x: rotationX, y: randomYaw, z: rotationZ },
                scale: finalScale,
                geo,
                visible: true,
                locked: false,
                material: {
                    color: obj.tintHex || defaultColor,
                    roughness: 0.7,
                    metalness: 0.1
                }
            };

            spawnedActors.push(actor);
        }
    }

    return spawnedActors;
}

/**
 * Agentic refinement loop that stabilizes actor placements on ground elevation.
 */
export function refinePlacedActors(
    actors: PlacedActor3D[],
    grid: TerrainElevationGrid | null
): PlacedActor3D[] {
    return actors.map(actor => {
        const { x, z } = actor.position;
        const groundHeight = sampleGridElevation(x, z, grid);
        const halfHeight = getActorHalfHeight(actor.type, actor.scale.y || 1.0);
        const targetY = groundHeight + halfHeight;

        let rotX = actor.rotation.x;
        let rotZ = actor.rotation.z;

        const normal = estimateTerrainNormal(x, z, grid);
        const slopeSteepness = Math.sqrt(normal.nx * normal.nx + normal.nz * normal.nz);

        if (slopeSteepness > 0.15) {
            rotX = Math.atan2(normal.nz, normal.ny) * (180 / Math.PI);
            rotZ = -Math.atan2(normal.nx, normal.ny) * (180 / Math.PI);
        }

        return {
            ...actor,
            position: { x, y: targetY, z },
            rotation: { ...actor.rotation, x: rotX, z: rotZ }
        };
    });
}
