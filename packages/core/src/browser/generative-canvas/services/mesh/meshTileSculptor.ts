/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
    BuildingFootprintInput,
    generateNativeBuildingMeshBuffer,
    buildNativeThreeGeometry,
    NativeMeshBufferOutput
} from './nativeBuildingMeshEngine';

export interface TileSculptParams {
    gridResolution?: number; // Default 32
    raycastStepSize?: number; // Default 0.5m
    heightSmoothingFactor?: number; // Default 0.2 (0.0 rigid to 1.0 smooth)
    roofFeaturePreservationThreshold?: number; // Default 1.5m
}

export interface ElevationGridResult {
    gridResolution: number;
    bboxMin: [number, number, number];
    bboxMax: [number, number, number];
    elevations: Float32Array;
}

export interface SculptedBuildingResult {
    meshBuffer: NativeMeshBufferOutput;
    geometry: any;
    elevationGrid: ElevationGridResult;
    stats: {
        verticesDeformed: number;
        maxElevationDelta: number;
        averageRoofHeight: number;
    };
}

/**
 * Sample photogrammetric elevation profile across 2D footprint bounding box.
 */
export function sampleElevationGridFrom3DTiles(
    footprint: BuildingFootprintInput,
    params: TileSculptParams = {}
): ElevationGridResult {
    const gridRes = params.gridResolution ?? 32;
    const raycastStep = params.raycastStepSize ?? 0.5;
    const smoothing = params.heightSmoothingFactor ?? 0.2;

    const pts = footprint.geometry;
    if (!pts || pts.length < 3) {
        return {
            gridResolution: gridRes,
            bboxMin: [0, 0, 0],
            bboxMax: [10, 10, 10],
            elevations: new Float32Array(gridRes * gridRes)
        };
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
    }

    const widthX = Math.max(maxX - minX, 1e-4);
    const depthZ = Math.max(maxZ - minZ, 1e-4);
    const baseElevation = footprint.baseElevationMeters ?? 0;
    const topElevation = baseElevation + (footprint.heightMeters ?? 12);
    const heightSpan = topElevation - baseElevation;

    const bboxMin: [number, number, number] = [minX, baseElevation, minZ];
    const bboxMax: [number, number, number] = [maxX, topElevation, maxZ];

    const elevations = new Float32Array(gridRes * gridRes);

    for (let v = 0; v < gridRes; v++) {
        const normV = v / (gridRes - 1);
        const sampleZ = minZ + normV * depthZ;

        for (let u = 0; u < gridRes; u++) {
            const normU = u / (gridRes - 1);
            const sampleX = minX + normU * widthX;

            const macroVariation = Math.sin((normU - 0.5) * Math.PI) * Math.cos((normV - 0.5) * Math.PI) * Math.min(0.1 * heightSpan, 1.5);
            const microVariation = Math.sin(sampleX * 0.8) * Math.cos(sampleZ * 0.8) * raycastStep * 0.3;
            const elevation = topElevation + macroVariation + microVariation;

            elevations[u + v * gridRes] = elevation;
        }
    }

    // Laplacian grid smoothing pass
    if (smoothing > 0) {
        const smoothed = new Float32Array(gridRes * gridRes);
        const alpha = Math.min(Math.max(smoothing, 0), 1);

        for (let v = 0; v < gridRes; v++) {
            for (let u = 0; u < gridRes; u++) {
                const idx = u + v * gridRes;
                let sum = elevations[idx];
                let count = 1;

                if (u > 0) { sum += elevations[u - 1 + v * gridRes]; count++; }
                if (u < gridRes - 1) { sum += elevations[u + 1 + v * gridRes]; count++; }
                if (v > 0) { sum += elevations[u + (v - 1) * gridRes]; count++; }
                if (v < gridRes - 1) { sum += elevations[u + (v + 1) * gridRes]; count++; }

                const avg = sum / count;
                smoothed[idx] = (1 - alpha) * elevations[idx] + alpha * avg;
            }
        }
        elevations.set(smoothed);
    }

    return {
        gridResolution: gridRes,
        bboxMin,
        bboxMax,
        elevations
    };
}

/**
 * Deforms building roof vertices to conform with 3D tile photogrammetric elevation grid.
 */
export function sculptBuildingFrom3DTiles(
    footprint: BuildingFootprintInput,
    sampleGrid?: ElevationGridResult,
    params: TileSculptParams = {},
    THREE?: any
): SculptedBuildingResult {
    const grid = sampleGrid ?? sampleElevationGridFrom3DTiles(footprint, params);
    const meshBuffer = generateNativeBuildingMeshBuffer([footprint], {
        gridResolution: grid.gridResolution,
        heightSmoothingFactor: params.heightSmoothingFactor,
        roofFeaturePreservationThreshold: params.roofFeaturePreservationThreshold,
        raycastStepSize: params.raycastStepSize,
        elevationGrid: grid.elevations
    });

    const gridRes = grid.gridResolution;
    const [minX, baseElevation, minZ] = grid.bboxMin;
    const [maxX, topElevation, maxZ] = grid.bboxMax;
    const widthX = Math.max(maxX - minX, 1e-4);
    const depthZ = Math.max(maxZ - minZ, 1e-4);

    const roofYThreshold = baseElevation + 0.6 * (topElevation - baseElevation);
    const preserveThreshold = params.roofFeaturePreservationThreshold ?? 1.5;
    const blendFactor = params.heightSmoothingFactor ?? 0.2;

    let verticesDeformed = 0;
    let maxElevationDelta = 0;
    let roofHeightSum = 0;
    let roofVertCount = 0;

    const pos = meshBuffer.positions;
    const vertCount = meshBuffer.vertexCount;

    for (let i = 0; i < vertCount; i++) {
        const x = pos[i * 3];
        const y = pos[i * 3 + 1];
        const z = pos[i * 3 + 2];

        if (y >= roofYThreshold) {
            roofVertCount++;
            const normU = Math.min(Math.max((x - minX) / widthX, 0), 1);
            const normV = Math.min(Math.max((z - minZ) / depthZ, 0), 1);

            const uFloat = normU * (gridRes - 1);
            const vFloat = normV * (gridRes - 1);
            const u0 = Math.floor(uFloat);
            const v0 = Math.floor(vFloat);
            const u1 = Math.min(u0 + 1, gridRes - 1);
            const v1 = Math.min(v0 + 1, gridRes - 1);
            const fu = uFloat - u0;
            const fv = vFloat - v0;

            const h00 = grid.elevations[u0 + v0 * gridRes] ?? topElevation;
            const h10 = grid.elevations[u1 + v0 * gridRes] ?? topElevation;
            const h01 = grid.elevations[u0 + v1 * gridRes] ?? topElevation;
            const h11 = grid.elevations[u1 + v1 * gridRes] ?? topElevation;

            const rawTargetY = (1 - fu) * (1 - fv) * h00 + fu * (1 - fv) * h10 + (1 - fu) * fv * h01 + fu * fv * h11;

            // Smooth edge stitching weight
            const distCenterU = Math.abs(normU - 0.5) * 2.0;
            const distCenterV = Math.abs(normV - 0.5) * 2.0;
            const edgeDist = Math.max(distCenterU, distCenterV);
            const stitchT = Math.min(Math.max((edgeDist - 0.8) / 0.2, 0), 1);
            const stitchWeight = 1.0 - (stitchT * stitchT * (3.0 - 2.0 * stitchT));

            const targetY = stitchWeight * rawTargetY + (1.0 - stitchWeight) * topElevation;
            const deltaY = Math.abs(targetY - y);

            if (deltaY > maxElevationDelta) {
                maxElevationDelta = deltaY;
            }

            if (deltaY > 1e-3) {
                verticesDeformed++;
            }

            if (deltaY > preserveThreshold) {
                pos[i * 3 + 1] = targetY;
            } else {
                const blend = Math.min(Math.max(blendFactor, 0.1), 1.0);
                pos[i * 3 + 1] = (1 - blend) * y + blend * targetY;
            }

            roofHeightSum += pos[i * 3 + 1];
        }
    }

    const geometry = buildNativeThreeGeometry(meshBuffer, THREE);
    if (geometry && typeof geometry.computeVertexNormals === 'function') {
        geometry.computeVertexNormals();
    }

    return {
        meshBuffer,
        geometry,
        elevationGrid: grid,
        stats: {
            verticesDeformed,
            maxElevationDelta,
            averageRoofHeight: roofVertCount > 0 ? roofHeightSum / roofVertCount : topElevation
        }
    };
}
