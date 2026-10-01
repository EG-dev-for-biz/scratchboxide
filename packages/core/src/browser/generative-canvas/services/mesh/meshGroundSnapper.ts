/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { TerrainElevationGrid } from '../worldbuilder/worldbuilder-types';
import { sampleGridElevation } from '../worldbuilder/RegionalPlacementEngine';

export interface GroundSnapResult {
    count: number;
    avgElevation: number;
    minElevation: number;
    maxElevation: number;
    updatedAreas: any[];
}

/**
 * Sample simulated terrain elevation at point (x, z) relative to bounds.
 */
function sampleSimulatedTerrainElevation(
    x: number,
    z: number,
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number
): number {
    const rangeX = Math.max(maxX - minX, 1e-4);
    const rangeZ = Math.max(maxZ - minZ, 1e-4);
    const normU = Math.min(Math.max((x - minX) / rangeX, 0), 1);
    const normV = Math.min(Math.max((z - minZ) / rangeZ, 0), 1);

    const macroSlope = Math.sin((normU - 0.5) * Math.PI) * 2.5 + Math.cos((normV - 0.5) * Math.PI) * 1.8;
    const microUndulation = Math.sin(x * 0.15) * Math.cos(z * 0.15) * 0.6;
    const baseTerrainHeight = 1.2 + macroSlope + microUndulation;

    return Math.max(0.0, baseTerrainHeight);
}

/**
 * Ground Elevation Snapper Service.
 * Performs vertical downward raycast / terrain grid sampling from footprint centroids and perimeter vertices.
 * Calculates terrain surface elevation baseElevationMeters so building ground bases anchor seamlessly to terrain.
 */
export function snapFootprintsToTerrain(
    areasInput?: any[],
    elevationGrid?: TerrainElevationGrid | null
): GroundSnapResult {
    const areas = areasInput || [];

    if (!areas || areas.length === 0) {
        return {
            count: 0,
            avgElevation: 0,
            minElevation: 0,
            maxElevation: 0,
            updatedAreas: []
        };
    }

    // Compute global bounding box
    let globalMinX = Infinity, globalMaxX = -Infinity;
    let globalMinZ = Infinity, globalMaxZ = -Infinity;

    const processedFootprints = areas.map((bld: any) => {
        if (!bld.geometry || bld.geometry.length < 3) {
            return { ...bld };
        }

        const pts: { x: number; z: number }[] = bld.geometry.map((pt: any) => ({
            x: typeof pt.x === 'number' ? pt.x : (pt.lng || 0),
            z: typeof pt.z === 'number' ? pt.z : (pt.lat || 0)
        }));

        for (const p of pts) {
            if (p.x < globalMinX) globalMinX = p.x;
            if (p.x > globalMaxX) globalMaxX = p.x;
            if (p.z < globalMinZ) globalMinZ = p.z;
            if (p.z > globalMaxZ) globalMaxZ = p.z;
        }

        return { ...bld, parsedPts: pts };
    });

    let totalElevationSum = 0;
    let overallMinElevation = Infinity;
    let overallMaxElevation = -Infinity;
    let snappedCount = 0;

    const updatedAreas = processedFootprints.map((bld: any) => {
        const pts: { x: number; z: number }[] = bld.parsedPts;
        if (!pts || pts.length < 3) {
            return bld;
        }

        // 1. Calculate Footprint Centroid
        let sumX = 0, sumZ = 0;
        for (const p of pts) {
            sumX += p.x;
            sumZ += p.z;
        }
        const cx = sumX / pts.length;
        const cz = sumZ / pts.length;

        // 2. Identify Perimeter Vertices & Edge Midpoints
        const samplePoints: { x: number; z: number }[] = [{ x: cx, z: cz }];
        for (let i = 0; i < pts.length; i++) {
            samplePoints.push(pts[i]);
            const next = (i + 1) % pts.length;
            samplePoints.push({
                x: 0.5 * (pts[i].x + pts[next].x),
                z: 0.5 * (pts[i].z + pts[next].z)
            });
        }

        // 3. Sample Elevation on Terrain Surface
        let minTerrainH = Infinity;
        for (const sp of samplePoints) {
            let h: number;
            if (elevationGrid) {
                h = sampleGridElevation(sp.x, sp.z, elevationGrid);
            } else {
                h = sampleSimulatedTerrainElevation(sp.x, sp.z, globalMinX, globalMaxX, globalMinZ, globalMaxZ);
            }
            if (h < minTerrainH) {
                minTerrainH = h;
            }
        }

        const baseElevationMeters = Math.max(0.0, parseFloat(minTerrainH.toFixed(2)));

        totalElevationSum += baseElevationMeters;
        if (baseElevationMeters < overallMinElevation) overallMinElevation = baseElevationMeters;
        if (baseElevationMeters > overallMaxElevation) overallMaxElevation = baseElevationMeters;
        snappedCount++;

        const { parsedPts, ...cleanBld } = bld;
        return {
            ...cleanBld,
            baseElevationMeters
        };
    });

    const avgElevation = snappedCount > 0 ? totalElevationSum / snappedCount : 0;

    return {
        count: snappedCount,
        avgElevation,
        minElevation: overallMinElevation === Infinity ? 0 : overallMinElevation,
        maxElevation: overallMaxElevation === -Infinity ? 0 : overallMaxElevation,
        updatedAreas
    };
}
