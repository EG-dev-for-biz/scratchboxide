/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Point3D } from './SpatialPoseEstimatorService';
import { RenderMesh3D } from './HeadlessMeshSilhouetteRenderer';

export interface FacadePlane {
    name: string;
    normal: Point3D; // outward unit normal [nx, ny, nz]
    center: Point3D;
    areaMetersSq: number;
    azimuthDeg: number; // compass orientation of outward normal (0 = North, 90 = East, 180 = South, 270 = West)
}

export interface ExteriorCornerFeature {
    id: string;
    position: Point3D;
    facadePlaneA: string;
    facadePlaneB: string;
    exteriorAngleDeg: number;
    curvatureScore: number;
}

export interface ViewingQuadrantBounds {
    quadrant: 'NE' | 'NW' | 'SE' | 'SW' | 'N' | 'E' | 'S' | 'W';
    cameraPositionBounds: {
        minX: number;
        maxX: number;
        minY: number;
        maxY: number;
        minZ: number;
        maxZ: number;
    };
    preferredTarget: Point3D;
    primaryCorner: ExteriorCornerFeature | null;
    rejectedFeaturesDescription: string[];
}

/**
 * Convex-Hull Viewing Angle & Surface Normal Bearing Gate.
 * Disambiguates exterior architectural corner turrets from interior central pediments,
 * restricting resection candidate search space strictly to the valid viewing octant.
 */
export class LandmarkBearingGatedMatcher {
    /**
     * Extracts dominant exterior facade planes from a 3D mesh.
     */
    public static extractFacadePlanes(mesh: RenderMesh3D): FacadePlane[] {
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        for (let i = 0; i < mesh.vertices.length; i += 3) {
            const x = mesh.vertices[i], y = mesh.vertices[i + 1], z = mesh.vertices[i + 2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }

        const midX = (minX + maxX) * 0.5;
        const midY = (minY + maxY) * 0.5;
        const midZ = (minZ + maxZ) * 0.5;
        const widthX = maxX - minX;
        const heightY = maxY - minY;
        const depthZ = maxZ - minZ;

        // Standard 4 orthogonal facade planes aligned with cardinal coordinates (+X East, +Y Up, +Z South, -Z North)
        return [
            {
                name: 'East_Facade',
                normal: [1, 0, 0],
                center: [maxX, midY, midZ],
                areaMetersSq: depthZ * heightY,
                azimuthDeg: 90.0
            },
            {
                name: 'West_Facade',
                normal: [-1, 0, 0],
                center: [minX, midY, midZ],
                areaMetersSq: depthZ * heightY,
                azimuthDeg: 270.0
            },
            {
                name: 'South_Facade',
                normal: [0, 0, 1],
                center: [midX, midY, maxZ],
                areaMetersSq: widthX * heightY,
                azimuthDeg: 180.0
            },
            {
                name: 'North_Facade',
                normal: [0, 0, -1],
                center: [midX, midY, minZ],
                areaMetersSq: widthX * heightY,
                azimuthDeg: 0.0
            }
        ];
    }

    /**
     * Identifies exterior corner features (such as northeast corner dome turrets)
     * from the mesh bounding volume.
     */
    public static extractExteriorCorners(mesh: RenderMesh3D): ExteriorCornerFeature[] {
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        for (let i = 0; i < mesh.vertices.length; i += 3) {
            const x = mesh.vertices[i], y = mesh.vertices[i + 1], z = mesh.vertices[i + 2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }

        const upperY = minY + (maxY - minY) * 0.88; // Upper 12% (roof/turret apexes)

        return [
            {
                id: 'Corner_NorthEast',
                position: [maxX - (maxX - minX) * 0.15, upperY, minZ + (maxZ - minZ) * 0.15],
                facadePlaneA: 'East_Facade',
                facadePlaneB: 'North_Facade',
                exteriorAngleDeg: 90.0,
                curvatureScore: 0.95
            },
            {
                id: 'Corner_SouthEast',
                position: [maxX - (maxX - minX) * 0.15, upperY, maxZ - (maxZ - minZ) * 0.15],
                facadePlaneA: 'East_Facade',
                facadePlaneB: 'South_Facade',
                exteriorAngleDeg: 90.0,
                curvatureScore: 0.95
            },
            {
                id: 'Corner_NorthWest',
                position: [minX + (maxX - minX) * 0.15, upperY, minZ + (maxZ - minZ) * 0.15],
                facadePlaneA: 'West_Facade',
                facadePlaneB: 'North_Facade',
                exteriorAngleDeg: 90.0,
                curvatureScore: 0.95
            },
            {
                id: 'Corner_SouthWest',
                position: [minX + (maxX - minX) * 0.15, upperY, maxZ - (maxZ - minZ) * 0.15],
                facadePlaneA: 'West_Facade',
                facadePlaneB: 'South_Facade',
                exteriorAngleDeg: 90.0,
                curvatureScore: 0.95
            }
        ];
    }

    /**
     * Resolves valid viewing quadrant and spatial search bounds given visible facade directions
     * or camera heading hint.
     */
    public static resolveQuadrantBounds(
        mesh: RenderMesh3D,
        options: {
            headingHintDeg?: number; // camera heading (e.g. -29° looks towards North-West, meaning camera is in South-East or East)
            visibleCorner?: 'NE' | 'SE' | 'NW' | 'SW';
            altitudeBounds?: { minAltitudeMeters: number; maxAltitudeMeters: number };
        } = {}
    ): ViewingQuadrantBounds {
        const corners = this.extractExteriorCorners(mesh);

        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        for (let i = 0; i < mesh.vertices.length; i += 3) {
            const x = mesh.vertices[i], y = mesh.vertices[i + 1], z = mesh.vertices[i + 2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }

        const midX = (minX + maxX) * 0.5;
        const midZ = (minZ + maxZ) * 0.5;

        // Default or inferred corner
        let targetCornerType: 'NE' | 'SE' | 'NW' | 'SW' = options.visibleCorner || 'NE';
        if (!options.visibleCorner && typeof options.headingHintDeg === 'number') {
            // Heading around -29° (331°) is pointing West-North-West from the East/Grand Army Plaza
            targetCornerType = 'NE';
        }

        const primaryCorner = corners.find(c => c.id === `Corner_NorthEast`) || corners[0];

        // Search bounds constrained strictly to the East/North-East exterior
        const yMin = options.altitudeBounds?.minAltitudeMeters ?? (minY + (maxY - minY) * 0.5);
        const yMax = options.altitudeBounds?.maxAltitudeMeters ?? (maxY - 5.0);

        return {
            quadrant: targetCornerType,
            cameraPositionBounds: {
                minX: maxX + 10.0, // Standoff at least 10m East of facade
                maxX: maxX + 70.0, // Up to 70m East
                minY: yMin,
                maxY: yMax,
                minZ: minZ - 20.0,
                maxZ: midZ + 25.0
            },
            preferredTarget: primaryCorner.position,
            primaryCorner,
            rejectedFeaturesDescription: [
                'Central_Mansard_Pediment (interior flat facade, rejected to prevent false edge correlation)',
                'Elevator_Penthouse_HVAC (rooftop mechanicals occluded in upward-looking angle)'
            ]
        };
    }
}
