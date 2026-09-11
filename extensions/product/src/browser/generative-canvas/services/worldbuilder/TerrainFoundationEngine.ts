/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { WorldSpecification, TerrainElevationGrid } from './worldbuilder-types';

// Map relative position enums to normalized 2D coordinate centers [0.0..1.0]
const POSITION_MAP: Record<string, [number, number]> = {
    center: [0.5, 0.5],
    north: [0.5, 1.0],
    south: [0.5, 0.0],
    east: [1.0, 0.5],
    west: [0.0, 0.5],
    northeast: [1.0, 1.0],
    northwest: [0.0, 1.0],
    southeast: [1.0, 0.0],
    southwest: [0.0, 0.0]
};

/**
 * Procedural heightfield generation combining multi-octave FBM noise,
 * terracation, ridge shaping, and IDW (Inverse Distance Weighting) regional blending.
 */
export function generateCompositeHeightfield(
    spec: WorldSpecification,
    resolution: number = 32,
    latCenter: number = 40.7812,
    lngCenter: number = -73.9665
): TerrainElevationGrid {
    const halfLatSpan = 0.005;
    const halfLngSpan = 0.006;
    const south = latCenter - halfLatSpan;
    const north = latCenter + halfLatSpan;
    const west = lngCenter - halfLngSpan;
    const east = lngCenter + halfLngSpan;

    const totalPoints = resolution * resolution;
    const elevations = new Float32Array(totalPoints);

    let minElevation = Infinity;
    let maxElevation = -Infinity;

    const terracation = Math.min(Math.max(spec.terrain.terracation ?? 0.0, 0.0), 1.0);
    const erosionWeight = Math.min(Math.max(spec.terrain.erosionWeight ?? 0.0, 0.0), 1.0);
    const noiseScale = spec.terrain.noiseScale || 1.0;
    const ridgeFactor = Math.min(Math.max(spec.terrain.ridgeFactor ?? 0.0, 0.0), 1.0);

    for (let r = 0; r < resolution; r++) {
        const v = r / (resolution - 1); // 0.0 at South, 1.0 at North

        for (let c = 0; c < resolution; c++) {
            const u = c / (resolution - 1); // 0.0 at West, 1.0 at East

            // 1. Compute IDW regional base height blending
            let totalWeight = 0;
            let blendedBaseHeight = 0;

            if (spec.regions && spec.regions.length > 0) {
                for (const region of spec.regions) {
                    const center = POSITION_MAP[region.relativePosition] || [0.5, 0.5];
                    const dx = u - center[0];
                    const dy = v - center[1];
                    const distSq = dx * dx + dy * dy;

                    // Smooth inverse distance weighting
                    const weight = 1.0 / (distSq + 0.015);
                    totalWeight += weight;
                    blendedBaseHeight += (region.baseElevation ?? 0) * weight;
                }
            }

            let h = totalWeight > 0 ? blendedBaseHeight / totalWeight : 0.0;

            // 2. Multi-octave FBM procedural noise variation
            const S = 10.0 * noiseScale;
            const octave1 = Math.sin(u * S) * Math.cos(v * S) * 6.0;
            const octave2 = Math.sin(u * 2 * S + 1.2) * Math.cos(v * 2 * S + 0.8) * 3.0;
            const octave3 = Math.sin(u * 4 * S + 2.4) * Math.cos(v * 4 * S + 1.6) * 1.5;
            const octave4 = Math.sin(u * 8 * S) * Math.cos(v * 8 * S) * 0.75;
            let noise = octave1 + octave2 + octave3 + octave4;

            // Optional ridge sharpening
            if (ridgeFactor > 0.0) {
                const ridge = (1.0 - Math.abs(Math.sin(u * S * 1.5) * Math.cos(v * S * 1.5))) * 8.0;
                noise = (1.0 - ridgeFactor) * noise + ridgeFactor * ridge;
            }

            h += noise;

            // 3. Terracing step factor (0.0 to 1.0)
            if (terracation > 0.0) {
                const stepSize = 5.0; // 5-meter structural shelves
                const steppedHeight = Math.round(h / stepSize) * stepSize;
                h = (1.0 - terracation) * h + terracation * steppedHeight;
            }

            // 4. Geomorphic erosion adjustment (power / valley carving approximation)
            if (erosionWeight > 0.0) {
                const factor = 1.0 - erosionWeight * 0.35;
                h = h >= 0 ? Math.pow(h, factor) : -Math.pow(Math.abs(h), factor);
            }

            // Constrain inside planned bounds
            h = Math.max(spec.terrain.elevationMin, Math.min(spec.terrain.elevationMax, h));

            const idx = c + r * resolution;
            elevations[idx] = h;

            if (h < minElevation) minElevation = h;
            if (h > maxElevation) maxElevation = h;
        }
    }

    return {
        resolution,
        south,
        west,
        north,
        east,
        elevations,
        minElevation: minElevation === Infinity ? 0 : minElevation,
        maxElevation: maxElevation === -Infinity ? 0 : maxElevation
    };
}

/**
 * Builds continuous terrain foundation and returns elevation grid.
 */
export async function buildTerrainFoundation(
    spec: WorldSpecification,
    options?: {
        resolution?: number;
        latCenter?: number;
        lngCenter?: number;
    }
): Promise<TerrainElevationGrid> {
    const res = options?.resolution ?? 32;
    const lat = options?.latCenter ?? 40.7812;
    const lng = options?.lngCenter ?? -73.9665;
    return generateCompositeHeightfield(spec, res, lat, lng);
}

/**
 * Procedural Three.js Terrain Mesh Builder.
 * Generates an optimized, vertex-normal smoothed BufferGeometry mesh from a TerrainElevationGrid.
 */
export function createTerrainMesh(
    grid: TerrainElevationGrid,
    THREE: any,
    options?: {
        width?: number;
        depth?: number;
        color?: string | number;
        roughness?: number;
        metalness?: number;
        wireframe?: boolean;
        receiveShadow?: boolean;
    }
): any {
    const width = options?.width ?? 200;
    const depth = options?.depth ?? 200;
    const res = grid.resolution;

    const geometry = new THREE.PlaneGeometry(width, depth, res - 1, res - 1);
    geometry.rotateX(-Math.PI / 2);

    const posAttr = geometry.attributes.position;
    if (posAttr && posAttr.count === grid.elevations.length) {
        for (let i = 0; i < posAttr.count; i++) {
            posAttr.setY(i, grid.elevations[i]);
        }
        posAttr.needsUpdate = true;
        geometry.computeVertexNormals();
    }

    const material = new THREE.MeshStandardMaterial({
        color: options?.color !== undefined ? options.color : 0x3d5a2d,
        roughness: options?.roughness ?? 0.85,
        metalness: options?.metalness ?? 0.05,
        wireframe: !!options?.wireframe
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'procedural-terrain-foundation';
    mesh.receiveShadow = options?.receiveShadow !== false;
    return mesh;
}
