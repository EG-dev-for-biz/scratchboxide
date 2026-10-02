/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs-extra';
import * as path from 'path';
import { LocalTangentPlane } from '../../common/coordinate/LocalTangentPlane';
import type {
    ColmapCameraPose,
    GeodeticAnchor
} from '../../common/spatial/colmap-vector-reference-types';
import {
    SurveySynthesisEngine,
    stationFromLookAt,
    horizontalFovDegrees,
    type StationOptics
} from '../../common/spatial/SurveySynthesisEngine';
import { HeadlessMeshSilhouetteRenderer, type RenderMesh3D } from './HeadlessMeshSilhouetteRenderer';
import { OrientedBoundingBoxSolver, type DualBoundingBoxResult } from './OrientedBoundingBoxSolver';

export interface AdaptiveSurveyRigOptions {
    /** Maximum number of stations to synthesize (default 40). */
    cameraBudget?: number;
    /** Desired Ground Sampling Distance in mm/pixel (e.g. 2.0 mm for travertine pore detail). Auto-calculates optimal standoff. */
    targetResolutionMm?: number;
    /** Survey mode: 'facade-perimeter' (default), 'interior-cavity', 'multitier-complete', or 'inspection-macro'. */
    mode?: 'facade-perimeter' | 'interior-cavity' | 'multitier-complete' | 'inspection-macro';
    /** Base camera focal length in mm (default 35mm). */
    focalLengthMm?: number;
    /** Sensor width in mm (default 36mm full frame). */
    sensorWidthMm?: number;
    /** Aspect ratio (default 16/9). */
    aspectRatio?: number;
    /** Minimum ground clearance in meters (default 1.8m). Stations will NEVER be placed lower than local terrain + clearance. */
    minGroundClearanceMeters?: number;
    /** Explicit standoff override in meters (if unset, derived from targetResolutionMm and sensor optics). */
    standoffMeters?: number;
    /** Focus region centroid override [x, y, z] in local ENU (if unset, extracted from OBB centroid). */
    focusCentroid?: [number, number, number];
    /** Radius in meters around focusCentroid to isolate the target structure from surrounding terrain. */
    cropRadius?: number;
    /** Bounding box [min, max] to isolate the target structure from surrounding terrain. */
    cropBox?: { min: [number, number, number]; max: [number, number, number] };
    /** Geodetic anchor (lat, lng, elevation). */
    anchor?: GeodeticAnchor;
    /** Render resolution width for GSD calculation (default 1920). */
    renderWidth?: number;
    /** Render resolution height for GSD calculation (default 1080). */
    renderHeight?: number;
}

export interface AdaptiveTierInfo {
    name: string;
    altitudeENU: number;
    heightAboveGround: number;
    stationCount: number;
    standoffMeters: number;
    focalLengthMm: number;
    mode: 'inward' | 'outward-up' | 'across-down' | 'rim-down';
}

export interface AdaptiveSurveyRigResult {
    poses: ColmapCameraPose[];
    aabb: DualBoundingBoxResult['aabb'];
    obb: DualBoundingBoxResult['obb'];
    groundDatumY: number;
    standoffMeters: number;
    tiers: AdaptiveTierInfo[];
    stats: {
        stationCount: number;
        minAltitudeENU: number;
        maxAltitudeENU: number;
        averageGroundClearance: number;
        boundingRadiusMeters: number;
        groundDatumY: number;
        structureCentroid: [number, number, number];
        structureDimensions: [number, number, number];
    };
}

/**
 * Adaptive Survey Rig Service: Derives photogrammetric camera station placements directly from
 * real 3D mesh geometry (OBB, surface normals, ground elevation, and architectural dimensions).
 *
 * Eliminates hardcoded presets ('amphitheatre-complete', 'orbital-multi-tier') and static coordinate
 * hashes in accordance with Scratchbox Adaptive Domain Architecture (ADA).
 *
 * Invariants enforced:
 * 1. Zero underground stations: Camera altitude is strictly clamped above sampled local terrain.
 * 2. Mesh-conformal dilation: Stations trace the oriented bounding envelope of the landmark.
 * 3. Exact feature targeting: Optical axes point directly at facade sections, not arbitrary [0, 20, 0].
 * 4. Sky bounding: Each station receives a strict maxDepth to prevent unprojecting sky splats into 3D.
 */
export class AdaptiveSurveyRigService {
    /**
     * Plans an adaptive survey rig for a given mesh or GLB path.
     */
    public static planRig(
        meshOrGlb: RenderMesh3D | string | Buffer,
        options: AdaptiveSurveyRigOptions = {}
    ): AdaptiveSurveyRigResult {
        let mesh: RenderMesh3D;
        if (typeof meshOrGlb === 'string' || Buffer.isBuffer(meshOrGlb)) {
            mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(meshOrGlb);
        } else {
            mesh = meshOrGlb;
        }

        const rawVerts = mesh.vertices;
        if (!rawVerts || rawVerts.length < 9) {
            throw new Error('Mesh contains insufficient vertices for adaptive survey rig planning');
        }
        const vertices = rawVerts instanceof Float32Array ? rawVerts : new Float32Array(rawVerts);

        // Filter vertices to isolate target structure from wide environmental terrain if specified
        let activeVertices = vertices;
        if (options.cropBox) {
            const { min, max } = options.cropBox;
            const filtered: number[] = [];
            for (let i = 0; i < vertices.length; i += 3) {
                const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2];
                if (x >= min[0] && x <= max[0] && y >= min[1] && y <= max[1] && z >= min[2] && z <= max[2]) {
                    filtered.push(x, y, z);
                }
            }
            if (filtered.length >= 9) {
                activeVertices = new Float32Array(filtered);
            }
        } else if (options.focusCentroid && (options.cropRadius || options.cropRadius === undefined)) {
            const [cx, , cz] = options.focusCentroid;
            const radius = options.cropRadius ?? 140.0;
            const r2 = radius * radius;
            const filtered: number[] = [];
            for (let i = 0; i < vertices.length; i += 3) {
                const x = vertices[i], z = vertices[i + 2];
                const dx = x - cx, dz = z - cz;
                if (dx * dx + dz * dz <= r2) {
                    filtered.push(x, vertices[i + 1], z);
                }
            }
            if (filtered.length >= 9) {
                activeVertices = new Float32Array(filtered);
            }
        }

        // 1. Compute Dual Bounding Box (AABB + OBB) on structure vertices
        const bbox = OrientedBoundingBoxSolver.compute(activeVertices);
        const { aabb, obb } = bbox;

        const centroid: [number, number, number] = options.focusCentroid ?? [
            obb.center[0],
            obb.center[1],
            obb.center[2]
        ];

        // 2. Compute true Ground Datum Y
        // Sample the 10th-percentile of active structure vertices to find surrounding ground datum
        const groundDatumY = this.estimateGroundDatum(activeVertices, aabb);

        const structureHeight = Math.max(1.0, aabb.max[1] - groundDatumY);
        const halfWidth = Math.max(1.0, obb.dimensions[0] * 0.5);
        const halfDepth = Math.max(1.0, obb.dimensions[2] * 0.5);
        const yawRad = obb.yawRad;

        // 3. Determine Optimal Standoff Distance
        const budget = Math.max(4, options.cameraBudget ?? 40);
        const minClearance = Math.max(0.5, options.minGroundClearanceMeters ?? 1.8);
        const sensorWidth = options.sensorWidthMm ?? 36.0;
        const renderW = options.renderWidth ?? 1920;
        const baseFocalLength = options.focalLengthMm ?? 35.0;

        let standoff = options.standoffMeters;
        if (!standoff) {
            if (options.targetResolutionMm && options.targetResolutionMm > 0) {
                // GSD = (pixelPitchMm * standoffMm) / focalLengthMm
                // standoffMeters = (targetResolutionMm * focalLengthMm) / (pixelPitchMm * 1000)
                const pixelPitchMm = sensorWidth / renderW;
                standoff = (options.targetResolutionMm * baseFocalLength) / (pixelPitchMm * 1000.0);
            } else {
                // Adaptive default: scale with structure envelope, between 18m and 55m
                const maxHorizRadius = Math.max(halfWidth, halfDepth);
                standoff = Math.max(18.0, Math.min(55.0, maxHorizRadius * 0.35 + 10.0));
            }
        }
        standoff = Math.max(6.0, standoff);

        // 4. Configure Adaptive Survey Tiers based on Mode and Structure Height
        const mode = options.mode ?? 'facade-perimeter';
        const tierConfigs = this.allocateTiers(budget, mode, groundDatumY, structureHeight, standoff, baseFocalLength, minClearance);

        // 5. Synthesize Camera Stations along the Oriented Envelope
        const anchor: GeodeticAnchor = options.anchor ?? {
            lat: 41.8902,
            lng: 12.4922,
            elevationMeters: groundDatumY,
            headingDeg: (yawRad * 180) / Math.PI
        };

        const safeAnchor = {
            ...anchor,
            elevationMeters: anchor.elevationMeters ?? groundDatumY
        };
        const ltp = new LocalTangentPlane({
            lat: safeAnchor.lat,
            lng: safeAnchor.lng,
            alt: safeAnchor.elevationMeters
        });

        const poses: ColmapCameraPose[] = [];
        let stationId = 1;

        for (const tier of tierConfigs) {
            const optics: StationOptics = {
                focalLengthMm: tier.focalLengthMm,
                sensorWidthMm: sensorWidth,
                aspectRatio: options.aspectRatio ?? 16 / 9
            };
            const fov = horizontalFovDegrees(optics.focalLengthMm, optics.sensorWidthMm);

            for (let i = 0; i < tier.stationCount && poses.length < budget; i++) {
                // Distribute azimuth evenly around the oriented perimeter
                const theta = (2 * Math.PI * i) / tier.stationCount;

                // Base surface point on oriented bounding ellipse
                const cosT = Math.cos(theta);
                const sinT = Math.sin(theta);

                // Local unrotated vector along principal axes
                const localSurfX = halfWidth * cosT;
                const localSurfZ = halfDepth * sinT;

                // Normal on ellipse: (cosT / halfWidth, sinT / halfDepth) normalized
                let nx = cosT / halfWidth;
                let nz = sinT / halfDepth;
                const nLen = Math.hypot(nx, nz) || 1.0;
                nx /= nLen;
                nz /= nLen;

                // Dilate along normal by tier standoff
                const localEyeX = localSurfX + tier.standoffMeters * nx;
                const localEyeZ = localSurfZ + tier.standoffMeters * nz;

                // Rotate into world local ENU by OBB yaw
                const cosYaw = Math.cos(yawRad);
                const sinYaw = Math.sin(yawRad);

                const eyeX = centroid[0] + (localEyeX * cosYaw - localEyeZ * sinYaw);
                const eyeZ = centroid[2] + (localEyeX * sinYaw + localEyeZ * cosYaw);

                const surfX = centroid[0] + (localSurfX * cosYaw - localSurfZ * sinYaw);
                const surfZ = centroid[2] + (localSurfX * sinYaw + localSurfZ * cosYaw);

                // Sample local terrain height beneath candidate camera position
                const localTerrainY = this.sampleTerrainHeight(vertices, eyeX, eyeZ, 6.0);
                const minSafeY = Math.max(groundDatumY + minClearance, localTerrainY + minClearance);
                const eyeY = Math.max(tier.altitudeENU, minSafeY);

                // Target calculation
                let targetX = surfX;
                let targetY = groundDatumY + tier.heightAboveGround * 0.75;
                let targetZ = surfZ;

                if (tier.mode === 'outward-up') {
                    // Looking outward from interior
                    const lookDist = Math.max(25.0, tier.standoffMeters);
                    targetX = eyeX + lookDist * (nx * cosYaw - nz * sinYaw);
                    targetY = groundDatumY + structureHeight * 0.45;
                    targetZ = eyeZ + lookDist * (nx * sinYaw + nz * cosYaw);
                } else if (tier.mode === 'rim-down') {
                    // Looking steeply downward from upper rim
                    targetX = surfX;
                    targetY = groundDatumY + structureHeight * 0.25;
                    targetZ = surfZ;
                }

                const eye: [number, number, number] = [eyeX, eyeY, eyeZ];
                const target: [number, number, number] = [targetX, targetY, targetZ];

                const fwd: [number, number, number] = [
                    target[0] - eye[0],
                    target[1] - eye[1],
                    target[2] - eye[2]
                ];
                const distToTarget = Math.hypot(...fwd);

                const stationPose = stationFromLookAt(stationId, eye, target, optics, safeAnchor, {
                    name: `ADAPTIVE_${tier.name}_STATION_${String(stationId).padStart(2, '0')}`,
                    cameraAltitude: Number(eyeY.toFixed(3)),
                    cameraHeightAboveGround: Number((eyeY - groundDatumY).toFixed(3))
                });

                // Attach ADA adaptive guarantees
                (stationPose as any).maxDepth = Math.max(40.0, Number((tier.standoffMeters * 2.8).toFixed(1)));
                (stationPose as any).dropSky = true;
                (stationPose as any).targetDistance = Number(distToTarget.toFixed(2));
                (stationPose as any).groundDatumY = Number(groundDatumY.toFixed(2));

                poses.push(stationPose);
                stationId++;
            }
        }

        const altitudes = poses.map(p => p.positionLocalENU[1]);
        const minAlt = Math.min(...altitudes);
        const maxAlt = Math.max(...altitudes);
        const avgClearance = altitudes.reduce((sum, y) => sum + (y - groundDatumY), 0) / Math.max(1, altitudes.length);
        const maxHorizDist = Math.max(...poses.map(p => Math.hypot(p.positionLocalENU[0] - centroid[0], p.positionLocalENU[2] - centroid[2])));

        return {
            poses,
            aabb,
            obb,
            groundDatumY,
            standoffMeters: standoff,
            tiers: tierConfigs,
            stats: {
                stationCount: poses.length,
                minAltitudeENU: Number(minAlt.toFixed(2)),
                maxAltitudeENU: Number(maxAlt.toFixed(2)),
                averageGroundClearance: Number(avgClearance.toFixed(2)),
                boundingRadiusMeters: Number(maxHorizDist.toFixed(2)),
                groundDatumY: Number(groundDatumY.toFixed(2)),
                structureCentroid: [Number(centroid[0].toFixed(2)), Number(centroid[1].toFixed(2)), Number(centroid[2].toFixed(2))],
                structureDimensions: [Number(obb.dimensions[0].toFixed(2)), Number(obb.dimensions[1].toFixed(2)), Number(obb.dimensions[2].toFixed(2))]
            }
        };
    }

    /**
     * Estimates the ground datum elevation from vertex cloud.
     * Uses the lowest 5th percentile of vertices to avoid subterranean noise spikes.
     */
    private static estimateGroundDatum(vertices: Float32Array | number[], aabb: DualBoundingBoxResult['aabb']): number {
        const numVerts = vertices.length / 3;
        if (numVerts < 100) return aabb.min[1];

        // Sample up to 2000 vertices evenly across the mesh
        const step = Math.max(1, Math.floor(numVerts / 2000));
        const sampledY: number[] = [];
        for (let i = 0; i < vertices.length; i += step * 3) {
            sampledY.push(vertices[i + 1]);
        }
        sampledY.sort((a, b) => a - b);

        // 5th percentile represents true ground level while filtering outlier spikes
        const p05Index = Math.floor(sampledY.length * 0.05);
        return sampledY[p05Index];
    }

    /**
     * Samples local terrain surface height within a search radius.
     */
    private static sampleTerrainHeight(
        vertices: Float32Array | number[],
        x: number,
        z: number,
        searchRadius: number = 6.0
    ): number {
        const r2 = searchRadius * searchRadius;
        let maxY = -Infinity;
        const numVerts = vertices.length / 3;
        const stride = numVerts > 50000 ? 6 : 3; // subsample for performance if dense

        for (let i = 0; i < vertices.length; i += stride) {
            const vx = vertices[i];
            const vz = vertices[i + 2];
            const dx = vx - x;
            const dz = vz - z;
            if (dx * dx + dz * dz <= r2) {
                const vy = vertices[i + 1];
                if (vy > maxY) maxY = vy;
            }
        }
        return maxY;
    }

    /**
     * Allocates tiers based on budget, mode, and structure height.
     */
    private static allocateTiers(
        budget: number,
        mode: string,
        groundDatumY: number,
        structureHeight: number,
        baseStandoff: number,
        baseFocalLength: number,
        minClearance: number
    ): AdaptiveTierInfo[] {
        if (mode === 'interior-cavity') {
            return [
                {
                    name: 'INTERIOR_FLOOR',
                    altitudeENU: groundDatumY + minClearance,
                    heightAboveGround: minClearance,
                    stationCount: Math.round(budget * 0.6),
                    standoffMeters: Math.max(8.0, baseStandoff * 0.6),
                    focalLengthMm: 24,
                    mode: 'outward-up'
                },
                {
                    name: 'INTERIOR_MID',
                    altitudeENU: groundDatumY + structureHeight * 0.4,
                    heightAboveGround: structureHeight * 0.4,
                    stationCount: Math.max(2, budget - Math.round(budget * 0.6)),
                    standoffMeters: Math.max(12.0, baseStandoff * 0.8),
                    focalLengthMm: 28,
                    mode: 'across-down'
                }
            ];
        }

        if (mode === 'inspection-macro') {
            return [
                {
                    name: 'MACRO_DETAIL',
                    altitudeENU: groundDatumY + minClearance,
                    heightAboveGround: minClearance,
                    stationCount: budget,
                    standoffMeters: Math.max(6.0, baseStandoff * 0.4),
                    focalLengthMm: 50,
                    mode: 'inward'
                }
            ];
        }

        if (mode === 'multitier-complete') {
            // Comprehensive 4-Tier complete coverage
            const countTier1 = Math.max(2, Math.round(budget * 0.35));
            const countTier2 = Math.max(2, Math.round(budget * 0.30));
            const countTier3 = Math.max(2, Math.round(budget * 0.20));
            const countTier4 = Math.max(1, budget - countTier1 - countTier2 - countTier3);

            return [
                {
                    name: 'STREET_PEDESTRIAN',
                    altitudeENU: groundDatumY + minClearance,
                    heightAboveGround: minClearance,
                    stationCount: countTier1,
                    standoffMeters: baseStandoff,
                    focalLengthMm: baseFocalLength,
                    mode: 'inward'
                },
                {
                    name: 'MID_FACADE',
                    altitudeENU: groundDatumY + structureHeight * 0.38,
                    heightAboveGround: structureHeight * 0.38,
                    stationCount: countTier2,
                    standoffMeters: baseStandoff * 1.2,
                    focalLengthMm: baseFocalLength,
                    mode: 'inward'
                },
                {
                    name: 'UPPER_ATTIC',
                    altitudeENU: groundDatumY + structureHeight * 0.82,
                    heightAboveGround: structureHeight * 0.82,
                    stationCount: countTier3,
                    standoffMeters: baseStandoff * 1.45,
                    focalLengthMm: Math.min(50, baseFocalLength * 1.4),
                    mode: 'inward'
                },
                {
                    name: 'AERIAL_OVERVIEW',
                    altitudeENU: groundDatumY + structureHeight * 1.35,
                    heightAboveGround: structureHeight * 1.35,
                    stationCount: countTier4,
                    standoffMeters: baseStandoff * 1.8,
                    focalLengthMm: 24,
                    mode: 'rim-down'
                }
            ];
        }

        // Default 'facade-perimeter': 3 Tiers (Street, Mid-Facade, Attic Rim)
        const count1 = Math.max(2, Math.round(budget * 0.45));
        const count2 = Math.max(2, Math.round(budget * 0.35));
        const count3 = Math.max(1, budget - count1 - count2);

        return [
            {
                name: 'STREET_LEVEL',
                altitudeENU: groundDatumY + minClearance,
                heightAboveGround: minClearance,
                stationCount: count1,
                standoffMeters: baseStandoff,
                focalLengthMm: baseFocalLength,
                mode: 'inward'
            },
            {
                name: 'MID_FACADE',
                altitudeENU: groundDatumY + structureHeight * 0.40,
                heightAboveGround: structureHeight * 0.40,
                stationCount: count2,
                standoffMeters: baseStandoff * 1.25,
                focalLengthMm: baseFocalLength,
                mode: 'inward'
            },
            {
                name: 'UPPER_ATTIC',
                altitudeENU: groundDatumY + structureHeight * 0.85,
                heightAboveGround: structureHeight * 0.85,
                stationCount: count3,
                standoffMeters: baseStandoff * 1.5,
                focalLengthMm: Math.min(50, baseFocalLength * 1.4),
                mode: 'inward'
            }
        ];
    }
}
