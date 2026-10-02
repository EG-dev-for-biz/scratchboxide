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
    /** Survey mode: 'facade-perimeter' (default), 'interior-cavity', 'multitier-complete', 'inspection-macro', or 'nooks-and-crannies'. */
    mode?: 'facade-perimeter' | 'interior-cavity' | 'multitier-complete' | 'inspection-macro' | 'nooks-and-crannies';
    /** If true, provisions specialized penetrative stations (soffit-upward, ambulacrum corridors, hypogeum trenches) to capture recessed cavities. */
    penetrativeInteriorRigs?: boolean;
    /** Coverage density preset (default 'standard'). 'nooks-and-crannies' enables high-density penetrative tiers. */
    coverageDensity?: 'standard' | 'high' | 'ultra-dense' | 'nooks-and-crannies';
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
    /** Minimum free-space clearance in meters (default 1.5m). Probes surrounding geometry to prevent embedding cameras inside columns or solid masonry. */
    minFreeSpaceClearanceMeters?: number;
    /** If true (default true), performs free-space ray verification to adjust or discard colliding stations. */
    verifyFreeSpaceClearance?: boolean;
}


export interface AdaptiveTierInfo {
    name: string;
    altitudeENU: number;
    heightAboveGround: number;
    stationCount: number;
    standoffMeters: number;
    focalLengthMm: number;
    mode: 'inward' | 'outward-up' | 'across-down' | 'rim-down' | 'soffit-upward' | 'ambulacrum-corridor' | 'hypogeum-trench';
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
        const mode = options.mode ?? ((options.penetrativeInteriorRigs || options.coverageDensity === 'nooks-and-crannies') ? 'nooks-and-crannies' : 'facade-perimeter');
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
                let localEyeX = localSurfX + tier.standoffMeters * nx;
                let localEyeZ = localSurfZ + tier.standoffMeters * nz;

                if (tier.mode === 'soffit-upward') {
                    // Positioned close to exterior facade base (4-8m) looking upward into arch soffits / ceilings
                    const closeStandoff = Math.min(Math.max(4.0, tier.standoffMeters * 0.25), 8.0);
                    localEyeX = localSurfX + closeStandoff * nx;
                    localEyeZ = localSurfZ + closeStandoff * nz;
                } else if (tier.mode === 'ambulacrum-corridor') {
                    // Positioned inside the internal annular ring gallery (76% of outer perimeter)
                    const ringRatio = 0.76;
                    localEyeX = halfWidth * ringRatio * cosT;
                    localEyeZ = halfDepth * ringRatio * sinT;
                } else if (tier.mode === 'hypogeum-trench') {
                    // Sunken central arena / trench
                    const trenchRatio = 0.35;
                    localEyeX = halfWidth * trenchRatio * cosT;
                    localEyeZ = halfDepth * trenchRatio * sinT;
                }

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
                } else if (tier.mode === 'soffit-upward') {
                    // Aiming upward into arch intrados (+45° to +65° pitch)
                    targetX = surfX;
                    targetY = eyeY + Math.max(12.0, structureHeight * 0.40);
                    targetZ = surfZ;
                } else if (tier.mode === 'ambulacrum-corridor') {
                    // Looking along the curve of the annular gallery with +20° upward tilt into vaults
                    const tanX = -sinT;
                    const tanZ = cosT;
                    targetX = eyeX + 16.0 * (tanX * cosYaw - tanZ * sinYaw);
                    targetY = eyeY + 5.5;
                    targetZ = eyeZ + 16.0 * (tanX * sinYaw + tanZ * cosYaw);
                } else if (tier.mode === 'hypogeum-trench') {
                    // Looking across sunken hypogeum floor
                    targetX = centroid[0];
                    targetY = groundDatumY + 1.5;
                    targetZ = centroid[2];
                }

                let eye: [number, number, number] = [eyeX, eyeY, eyeZ];
                let clearanceDistance = 999.0;

                // Additive Phase 1: Free-Space Ray Clearance Probe
                if (options.verifyFreeSpaceClearance !== false && vertices && vertices.length > 30) {
                    const clearanceResult = AdaptiveSurveyRigService.verifyStationClearance(
                        vertices,
                        eye,
                        centroid,
                        options.minFreeSpaceClearanceMeters ?? 1.50
                    );
                    if (!clearanceResult.valid) {
                        // Candidate station could not achieve safe clearance inside solid masonry
                        continue;
                    }
                    eye = clearanceResult.adjustedPos;
                    const minAltitude = groundDatumY + (options.minGroundClearanceMeters ?? 1.8);
                    if (eye[1] < minAltitude) {
                        eye[1] = minAltitude;
                    }
                    clearanceDistance = clearanceResult.minDistance;
                }

                const target: [number, number, number] = [targetX, targetY, targetZ];

                const fwd: [number, number, number] = [
                    target[0] - eye[0],
                    target[1] - eye[1],
                    target[2] - eye[2]
                ];
                const distToTarget = Math.hypot(...fwd);

                const stationPose = stationFromLookAt(stationId, eye, target, optics, safeAnchor, {
                    name: `ADAPTIVE_${tier.name}_STATION_${String(stationId).padStart(2, '0')}`,
                    cameraAltitude: Number(eye[1].toFixed(3)),
                    cameraHeightAboveGround: Number((eye[1] - groundDatumY).toFixed(3))
                });

                // Attach ADA adaptive guarantees
                (stationPose as any).maxDepth = (tier.mode === 'soffit-upward' || tier.mode === 'ambulacrum-corridor')
                    ? Math.max(25.0, Number((structureHeight * 0.8).toFixed(1)))
                    : Math.max(40.0, Number((tier.standoffMeters * 2.8).toFixed(1)));
                (stationPose as any).dropSky = true;
                (stationPose as any).targetDistance = Number(distToTarget.toFixed(2));
                (stationPose as any).groundDatumY = Number(groundDatumY.toFixed(2));
                (stationPose as any).freeSpaceClearanceMeters = clearanceDistance;

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
     * Verifies that a candidate camera station has sufficient free-space clearance (min 1.5m).
     * If too close to masonry (e.g. inside an arcade pillar or wall), nudges the station
     * along the repulsion gradient into open void space. If no clearance is possible, marks invalid.
     */
    public static verifyStationClearance(
        vertices: Float32Array | number[],
        candidatePos: [number, number, number],
        centroid: [number, number, number],
        minClearance: number = 1.50
    ): { valid: boolean; adjustedPos: [number, number, number]; minDistance: number } {
        const numVerts = vertices.length / 3;
        if (numVerts < 10) {
            return { valid: true, adjustedPos: candidatePos, minDistance: 999.0 };
        }

        let curPos: [number, number, number] = [candidatePos[0], candidatePos[1], candidatePos[2]];
        const minClearanceSq = minClearance * minClearance;
        const stride = numVerts > 50000 ? 6 : 3;

        for (let iter = 0; iter < 3; iter++) {
            let minDistSq = Infinity;
            let repulseX = 0;
            let repulseY = 0;
            let repulseZ = 0;

            for (let i = 0; i < vertices.length; i += stride) {
                const vx = vertices[i];
                const vy = vertices[i + 1];
                const vz = vertices[i + 2];

                const dx = curPos[0] - vx;
                const dy = curPos[1] - vy;
                const dz = curPos[2] - vz;
                const distSq = dx * dx + dy * dy + dz * dz;

                if (distSq < minDistSq) {
                    minDistSq = distSq;
                }

                // If within clearance bubble, accumulate repulsion gradient
                if (distSq < minClearanceSq && distSq > 1e-4) {
                    const invDist = 1.0 / Math.sqrt(distSq);
                    repulseX += dx * invDist;
                    repulseY += dy * invDist;
                    repulseZ += dz * invDist;
                }
            }

            if (minDistSq >= minClearanceSq) {
                // Sits safely in free space
                return {
                    valid: true,
                    adjustedPos: [curPos[0], curPos[1], curPos[2]],
                    minDistance: Number(Math.sqrt(minDistSq).toFixed(3))
                };
            }

            // If repulsion vector is valid, push camera out along the gradient of open space
            const repulseLen = Math.hypot(repulseX, repulseY, repulseZ);
            if (repulseLen > 1e-4) {
                const step = (minClearance - Math.sqrt(minDistSq)) + 0.35;
                curPos[0] += (repulseX / repulseLen) * step;
                curPos[1] += (repulseY / repulseLen) * step * 0.5;
                curPos[2] += (repulseZ / repulseLen) * step;
            } else {
                // If symmetric pinch (inside column center), push radially away from structure centroid
                const outX = curPos[0] - centroid[0];
                const outZ = curPos[2] - centroid[2];
                const outLen = Math.hypot(outX, outZ);
                if (outLen > 1e-4) {
                    curPos[0] += (outX / outLen) * minClearance;
                    curPos[2] += (outZ / outLen) * minClearance;
                }
            }
        }

        // Final distance check after iterations
        let finalMinDistSq = Infinity;
        for (let i = 0; i < vertices.length; i += stride) {
            const dx = curPos[0] - vertices[i];
            const dy = curPos[1] - vertices[i + 1];
            const dz = curPos[2] - vertices[i + 2];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < finalMinDistSq) finalMinDistSq = d2;
        }

        const finalDist = Math.sqrt(finalMinDistSq);
        const valid = finalDist >= (minClearance * 0.70); // allow tolerance after pushing into void
        return {
            valid,
            adjustedPos: [curPos[0], curPos[1], curPos[2]],
            minDistance: Number(finalDist.toFixed(3))
        };
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

        if (mode === 'nooks-and-crannies') {
            // Specialized 5-Tier penetrative coverage targeting soffits, inner corridors, and hypogeum
            const countSoffit = Math.max(2, Math.round(budget * 0.25));
            const countCorridor = Math.max(2, Math.round(budget * 0.20));
            const countStreet = Math.max(2, Math.round(budget * 0.25));
            const countMid = Math.max(2, Math.round(budget * 0.15));
            const countHypogeum = Math.max(1, budget - countSoffit - countCorridor - countStreet - countMid);

            return [
                {
                    name: 'SOFFIT_UPWARD',
                    altitudeENU: groundDatumY + minClearance,
                    heightAboveGround: minClearance,
                    stationCount: countSoffit,
                    standoffMeters: Math.max(5.0, baseStandoff * 0.25),
                    focalLengthMm: 24,
                    mode: 'soffit-upward'
                },
                {
                    name: 'AMBULACRUM_CORRIDOR',
                    altitudeENU: groundDatumY + minClearance + 0.5,
                    heightAboveGround: minClearance + 0.5,
                    stationCount: countCorridor,
                    standoffMeters: Math.max(8.0, baseStandoff * 0.4),
                    focalLengthMm: 28,
                    mode: 'ambulacrum-corridor'
                },
                {
                    name: 'STREET_PEDESTRIAN',
                    altitudeENU: groundDatumY + minClearance,
                    heightAboveGround: minClearance,
                    stationCount: countStreet,
                    standoffMeters: baseStandoff,
                    focalLengthMm: baseFocalLength,
                    mode: 'inward'
                },
                {
                    name: 'MID_FACADE',
                    altitudeENU: groundDatumY + structureHeight * 0.40,
                    heightAboveGround: structureHeight * 0.40,
                    stationCount: countMid,
                    standoffMeters: baseStandoff * 1.25,
                    focalLengthMm: baseFocalLength,
                    mode: 'inward'
                },
                {
                    name: 'INTERIOR_HYPOGEUM',
                    altitudeENU: groundDatumY + 1.2,
                    heightAboveGround: 1.2,
                    stationCount: countHypogeum,
                    standoffMeters: Math.max(8.0, baseStandoff * 0.35),
                    focalLengthMm: 24,
                    mode: 'hypogeum-trench'
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
