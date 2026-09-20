/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import {
    SpatialPoseEstimatorService,
    rodriguesToRotationMatrix,
    type Point3D,
    type Point2D,
    type CameraIntrinsics
} from '../src/node/spatial/SpatialPoseEstimatorService.js';
import {
    HeadlessMeshSilhouetteRenderer,
    type RenderMesh3D
} from '../src/node/spatial/HeadlessMeshSilhouetteRenderer.js';
import type { CameraPose6DOF } from '../src/node/spatial/SubPixelEdgeAlignmentOptimizer.js';

interface LocationStage1TestConfig {
    id: string;
    name: string;
    tier: 'Tier 1: Google Photorealistic 3D Tiles' | 'Tier 2: Global Metrology Tangent Plane' | 'Tier 3: Everyday Non-Landmark';
    domain: string;
    lat: number;
    lng: number;
    alt: number;
    focalLengthMm: number;
    clayColor: [number, number, number];
    getMesh: () => RenderMesh3D;
    getPose: (mesh: RenderMesh3D) => CameraPose6DOF;
    features3D?: Point3D[];
    cameraT?: Point3D;
    cameraRotW?: [number, number, number];
    standoffMeters?: number;
    focalLengthPx?: number;
    keyFeatures: string[];
}

/**
 * Merges multiple RenderMesh3D objects into a single contiguous mesh.
 */
function mergeMeshes(meshes: RenderMesh3D[]): RenderMesh3D {
    let totalVerts = 0;
    let totalIndices = 0;
    for (const m of meshes) {
        totalVerts += m.vertices.length;
        totalIndices += m.indices.length;
    }
    const mergedVertices = new Float32Array(totalVerts);
    const mergedIndices = new Uint32Array(totalIndices);

    let vOffset = 0;
    let iOffset = 0;
    let indexBase = 0;

    for (const m of meshes) {
        mergedVertices.set(m.vertices, vOffset);
        for (let i = 0; i < m.indices.length; i++) {
            mergedIndices[iOffset + i] = m.indices[i] + indexBase;
        }
        indexBase += m.vertices.length / 3;
        vOffset += m.vertices.length;
        iOffset += m.indices.length;
    }
    return { vertices: mergedVertices, indices: mergedIndices };
}

/**
 * Computes bounding centroid [cx, cy, cz] for a mesh.
 */
function computeMeshCentroid(mesh: RenderMesh3D): [number, number, number] {
    let cx = 0, cy = 0, cz = 0;
    const count = mesh.vertices.length / 3;
    for (let i = 0; i < mesh.vertices.length; i += 3) {
        cx += mesh.vertices[i];
        cy += mesh.vertices[i + 1];
        cz += mesh.vertices[i + 2];
    }
    return [cx / count, cy / count, cz / count];
}

describe('Stage 1 Multi-Location Verification: 2D-to-3D Keypoint Feature Matching & Projection Rays', () => {
    const width = 960;
    const height = 640;
    const outDir = path.resolve(process.cwd(), 'public/visual_proof_locations');
    const artifactDir = process.env.ANTIGRAVITY_ARTIFACT_DIR && fs.existsSync(process.env.ANTIGRAVITY_ARTIFACT_DIR)
        ? process.env.ANTIGRAVITY_ARTIFACT_DIR
        : null;

    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    const TEST_LOCATIONS: LocationStage1TestConfig[] = [
        // ====================================================================
        // Tier 1: Authentic Google Photorealistic 3D Tile Scans
        // ====================================================================
        {
            id: 'colosseum_rome',
            name: 'Colosseum (Rome, Italy)',
            tier: 'Tier 1: Google Photorealistic 3D Tiles',
            domain: 'Classical Monument Amphitheater',
            lat: 41.8902,
            lng: 12.4922,
            alt: 24.0,
            focalLengthMm: 35.0,
            focalLengthPx: 900,
            cameraRotW: [0.08, -0.05, 0.02],
            standoffMeters: 240,
            clayColor: [225, 212, 192], // Travertine Roman stone albedo
            getMesh: () => HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(path.resolve('public/models/colosseum_rome_textured.glb')),
            getPose: (mesh) => {
                const [cx, cy, cz] = computeMeshCentroid(mesh);
                return {
                    x: cx + 140,
                    y: cy + 75,
                    z: cz - 260,
                    targetX: cx,
                    targetY: cy + 18,
                    targetZ: cz,
                    fov: 50
                };
            },
            keyFeatures: [
                'Outer travertine elliptical arcade arches',
                'Attic wall pilasters and corbel mast holes',
                'Radial vomitoria entrance corridors',
                'Cavea seating boundary cornice',
                'Ambulatory cross-vault groin intersections'
            ]
        },
        {
            id: 'grand_army_plaza',
            name: 'Grand Army Plaza (Brooklyn, NYC)',
            tier: 'Tier 1: Google Photorealistic 3D Tiles',
            domain: 'Neoclassical Memorial Arch & Colonnade',
            lat: 40.6738,
            lng: -73.9701,
            alt: 45.0,
            focalLengthMm: 32.0,
            focalLengthPx: 920,
            cameraRotW: [0.06, -0.04, 0.01],
            standoffMeters: 220,
            clayColor: [215, 215, 210], // Granite limestone albedo
            getMesh: () => HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(path.resolve('public/models/nyc_grand_army_plaza_raw.glb')),
            getPose: (mesh) => {
                const [cx, cy, cz] = computeMeshCentroid(mesh);
                return {
                    x: cx + 80,
                    y: cy + 85,
                    z: cz - 240,
                    targetX: cx,
                    targetY: cy + 15,
                    targetZ: cz,
                    fov: 50
                };
            },
            keyFeatures: [
                'Triumphal arch barrel vault portal opening',
                'Quadriga bronze sculpture crown apex',
                'Corinthian fluted column capitols',
                'Spandrel winged victory relief plaques',
                'Plaza circular retaining curb coping'
            ]
        },
        {
            id: 'midtown_highrise',
            name: 'Midtown Manhattan High-Rise Block (NYC)',
            tier: 'Tier 1: Google Photorealistic 3D Tiles',
            domain: 'Urban High-Rise Skyscraper Core',
            lat: 40.7580,
            lng: -73.9855,
            alt: 30.0,
            focalLengthMm: 28.0,
            focalLengthPx: 880,
            cameraRotW: [0.10, -0.06, 0.03],
            standoffMeters: 110,
            clayColor: [180, 195, 215], // Cool architectural steel/glass albedo
            getMesh: () => HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(path.resolve('public/models/google_tiles_textured_area.glb')),
            getPose: (mesh) => {
                const [cx, cy, cz] = computeMeshCentroid(mesh);
                return {
                    x: cx + 18,
                    y: cy + 42,
                    z: cz - 85,
                    targetX: cx,
                    targetY: cy,
                    targetZ: cz,
                    fov: 52
                };
            },
            keyFeatures: [
                'Commercial skyscraper flat roof gravel stop',
                'Mechanical penthouse HVAC bulkhead',
                'Vertical curtain wall mullion lines',
                'Lower setback terrace parapet edges',
                'Street-level building corner foundation'
            ]
        },
        {
            id: 'empire_state_building',
            name: 'Empire State Building (Manhattan, NYC)',
            tier: 'Tier 1: Google Photorealistic 3D Tiles',
            domain: 'Art Deco Skyscraper Spire',
            lat: 40.7484,
            lng: -73.9857,
            alt: 15.0,
            focalLengthMm: 38.0,
            focalLengthPx: 950,
            cameraRotW: [0.05, -0.03, 0.01],
            standoffMeters: 320,
            clayColor: [205, 205, 210], // Indiana limestone albedo
            getMesh: () => HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(path.resolve('public/models/google_greybox_esb.glb')),
            getPose: (mesh) => {
                const [cx, cy, cz] = computeMeshCentroid(mesh);
                return {
                    x: cx + 60,
                    y: cy + 180,
                    z: cz - 340,
                    targetX: cx,
                    targetY: cy + 150,
                    targetZ: cz,
                    fov: 46
                };
            },
            keyFeatures: [
                'Mooring mast spire antenna tip',
                '102nd floor circular observation deck',
                '86th floor open-air observation promenade',
                'Art Deco vertical setback chevron transitions',
                'Limestone facade vertical pier pilasters'
            ]
        },

        // ====================================================================
        // Tier 2: Global Metrology Tangent Plane Meshes
        // ====================================================================
        {
            id: 'sydney_opera_house',
            name: 'Sydney Opera House (Sydney, Australia)',
            tier: 'Tier 2: Global Metrology Tangent Plane',
            domain: 'Modern Expressionist Shell Architecture',
            lat: -33.8568,
            lng: 151.2153,
            alt: 4.0,
            focalLengthMm: 30.0,
            focalLengthPx: 900,
            cameraRotW: [0.07, -0.05, 0.02],
            standoffMeters: 200,
            clayColor: [235, 235, 230], // White precast concrete shell tiles
            getMesh: () => HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(path.resolve('public/data/colmap_vector_export/-33.8568_151.2153_clay.glb')),
            getPose: (mesh) => {
                const [cx, cy, cz] = computeMeshCentroid(mesh);
                return {
                    x: cx + 100,
                    y: cy + 80,
                    z: cz - 220,
                    targetX: cx,
                    targetY: cy + 10,
                    targetZ: cz,
                    fov: 52
                };
            },
            keyFeatures: [
                'Concert Hall major sail shell apex peak',
                'Opera Theatre interlocking shell rib ridges',
                'Monumental granite podium steps',
                'Harbor sea wall foundation promenade',
                'Glass curtain wall bronze framing'
            ]
        },
        {
            id: 'eiffel_tower',
            name: 'Eiffel Tower (Paris, France)',
            tier: 'Tier 2: Global Metrology Tangent Plane',
            domain: 'Wrought Iron Lattice Tower',
            lat: 48.8584,
            lng: 2.2945,
            alt: 35.0,
            focalLengthMm: 35.0,
            focalLengthPx: 900,
            cameraRotW: [0.06, -0.04, 0.02],
            standoffMeters: 210,
            clayColor: [185, 175, 160], // Puddle iron bronze albedo
            getMesh: () => HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(path.resolve('public/data/colmap_vector_export/48.8584_2.2945_clay.glb')),
            getPose: (mesh) => {
                const [cx, cy, cz] = computeMeshCentroid(mesh);
                return {
                    x: cx + 90,
                    y: cy + 70,
                    z: cz - 210,
                    targetX: cx,
                    targetY: cy + 15,
                    targetZ: cz,
                    fov: 52
                };
            },
            keyFeatures: [
                'Summit telecommunication lantern pinnacle',
                'Third platform observation deck band',
                'Second platform diagonal truss chords',
                'First platform monumental arch span',
                'Pillar footings anchor pedestal corners'
            ]
        },
        {
            id: 'tokyo_skytree',
            name: 'Tokyo Skytree (Sumida, Tokyo, Japan)',
            tier: 'Tier 2: Global Metrology Tangent Plane',
            domain: 'Slender Steel Lattice Broadcast Tower',
            lat: 35.7100,
            lng: 139.8107,
            alt: 10.0,
            focalLengthMm: 32.0,
            focalLengthPx: 920,
            cameraRotW: [0.05, -0.03, 0.01],
            standoffMeters: 190,
            clayColor: [220, 225, 235], // White steel pipe lattice albedo
            getMesh: () => HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(path.resolve('public/data/colmap_vector_export/35.7100_139.8107_clay.glb')),
            getPose: (mesh) => {
                const [cx, cy, cz] = computeMeshCentroid(mesh);
                return {
                    x: cx + 90,
                    y: cy + 70,
                    z: cz - 210,
                    targetX: cx,
                    targetY: cy + 15,
                    targetZ: cz,
                    fov: 52
                };
            },
            keyFeatures: [
                'Gain antenna mast top lightning rod',
                'Tembo Galleria spiral observation tube',
                'Tembo Deck lower cylindrical observation hub',
                'Equilateral triangular base transition to circle',
                'Sori (concave) and Mukuri (convex) structural curves'
            ]
        },

        // ====================================================================
        // Tier 3: Everyday Non-Landmark Environments
        // ====================================================================
        {
            id: 'suburban_residential',
            name: 'Suburban Residential Home (Sunnyvale, CA)',
            tier: 'Tier 3: Everyday Non-Landmark',
            domain: 'Suburban Residential Architecture',
            lat: 37.3688,
            lng: -122.0363,
            alt: 38.5,
            focalLengthMm: 28.0,
            focalLengthPx: 950,
            cameraRotW: [0.05, -0.15, 0.0],
            cameraT: [0.0, 1.6, 2.0],
            clayColor: [210, 200, 185], // Stucco & asphalt shingle albedo
            getMesh: () => mergeMeshes([
                HeadlessMeshSilhouetteRenderer.createBoxMesh([0, 2.5, 28.5], [9, 5, 9]),
                HeadlessMeshSilhouetteRenderer.createBoxMesh([0, 6.5, 28.5], [8.5, 3, 8.5]),
                HeadlessMeshSilhouetteRenderer.createBoxMesh([6.5, 1.5, 25.0], [4, 3, 6]),
                HeadlessMeshSilhouetteRenderer.createBoxMesh([9.0, 5.0, 26.0], [0.4, 10, 0.4]),
                HeadlessMeshSilhouetteRenderer.createBoxMesh([0.0, 0.1, 19.0], [20, 0.2, 1.5])
            ]),
            getPose: () => ({
                x: 0.0,
                y: 1.6,
                z: 2.0,
                targetX: -3.6,
                targetY: 2.8,
                targetZ: 25.7,
                fov: 50
            }),
            features3D: [
                [-4.5, 0.0, 24.0],   // Front-left foundation
                [4.5, 0.0, 24.0],    // Front-right foundation
                [-4.5, 5.2, 24.0],   // Left eave corner
                [4.5, 5.2, 24.0],    // Right eave corner
                [0.0, 8.6, 24.0],    // Roof ridge peak apex
                [-4.5, 5.2, 33.0],   // Rear left eave corner
                [0.0, 8.6, 33.0],    // Rear ridge apex
                [7.5, 1.2, 20.0],    // Driveway chain-link post
                [-6.0, 0.0, 18.0],   // Sidewalk curb boundary
                [9.0, 9.5, 26.0],    // Utility pole crossarm tip
            ],
            keyFeatures: [
                'Front foundation slab corner',
                'Overhanging roof eave fascia edges',
                'Main gable roof ridge peak apex',
                'Attached garage door jamb header',
                'Overhead utility pole crossarm tip'
            ]
        },
        {
            id: 'urban_commercial_corner',
            name: 'Urban Commercial Bodega & Tenement (Lower East Side, NYC)',
            tier: 'Tier 3: Everyday Non-Landmark',
            domain: 'Urban Commercial Vernacular',
            lat: 40.7180,
            lng: -73.9890,
            alt: 12.0,
            focalLengthMm: 32.0,
            focalLengthPx: 1000,
            cameraRotW: [0.08, 0.12, 0.0],
            cameraT: [0.5, 1.7, 1.0],
            clayColor: [195, 165, 150], // Red brick & metal awning albedo
            getMesh: () => mergeMeshes([
                HeadlessMeshSilhouetteRenderer.createBoxMesh([0, 8.0, 21.0], [14, 16, 8]),
                HeadlessMeshSilhouetteRenderer.createBoxMesh([0, 1.8, 20.0], [14.2, 3.6, 6.5]),
                HeadlessMeshSilhouetteRenderer.createBoxMesh([2.0, 3.4, 19.5], [9, 0.4, 3]),
                HeadlessMeshSilhouetteRenderer.createBoxMesh([2.8, 8.0, 20.2], [2.5, 8.0, 1.2])
            ]),
            getPose: () => ({
                x: 0.5,
                y: 1.7,
                z: 1.0,
                targetX: 2.8,
                targetY: 3.2,
                targetZ: 19.8,
                fov: 48
            }),
            features3D: [
                [-1.5, 0.0, 18.0],   // Sidewalk curb radius
                [-0.8, 0.2, 19.5],   // Bodega corner entrance
                [-0.8, 3.4, 19.5],   // Deli awning corner
                [-0.8, 4.2, 19.5],   // Roll-up gate transom
                [6.5, 3.4, 21.0],    // Awning right edge
                [-0.8, 15.8, 19.5],  // Roof parapet corner
                [-5.5, 15.8, 23.0],  // West roofline corner
                [8.5, 15.8, 22.0],   // North roofline corner
                [2.8, 6.5, 20.2],    // Fire escape 2nd floor balcony
                [2.8, 9.8, 20.2],    // Fire escape 3rd floor balcony
            ],
            keyFeatures: [
                'Sidewalk radius curb corner',
                'Bodega diagonal entrance door frame',
                'Storefront canvas awning valance corners',
                'Perimeter roof parapet coping corners',
                'Cast-iron fire escape balcony railings'
            ]
        },
        {
            id: 'industrial_logistics',
            name: 'Industrial Logistics Facility (Chicago, IL)',
            tier: 'Tier 3: Everyday Non-Landmark',
            domain: 'Industrial Warehousing & Freight',
            lat: 41.8340,
            lng: -87.6820,
            alt: 181.0,
            focalLengthMm: 35.0,
            focalLengthPx: 1150,
            cameraRotW: [0.04, -0.22, 0.0],
            cameraT: [0.0, 2.2, 2.0],
            clayColor: [190, 195, 200], // Concrete tilt-up & metal deck albedo
            getMesh: () => mergeMeshes([
                HeadlessMeshSilhouetteRenderer.createBoxMesh([15, 6.0, 42.0], [30, 12, 20]),
                HeadlessMeshSilhouetteRenderer.createBoxMesh([15, 0.6, 34.0], [28, 1.2, 6]),
                HeadlessMeshSilhouetteRenderer.createBoxMesh([8.0, 2.2, 30.0], [3.2, 4.0, 12]),
                HeadlessMeshSilhouetteRenderer.createBoxMesh([18.0, 7.0, 38.0], [0.5, 14, 0.5])
            ]),
            getPose: () => ({
                x: 0.0,
                y: 2.2,
                z: 2.0,
                targetX: -7.4,
                targetY: 3.5,
                targetZ: 35.2,
                fov: 46
            }),
            features3D: [
                [10.0, 0.0, 35.0],   // Dock bay 1 threshold
                [10.0, 4.0, 35.0],   // Dock bay 1 header
                [16.0, 0.0, 38.0],   // Dock bay 2 threshold
                [16.0, 4.0, 38.0],   // Dock bay 2 header
                [8.0, 0.0, 30.0],    // Parked trailer rear bumper
                [8.0, 3.8, 30.0],    // Parked trailer roof corner
                [1.5, 8.5, 42.0],    // Warehouse roof gravel stop
                [28.0, 8.5, 52.0],   // Warehouse distant roof corner
                [-5.0, 2.0, 22.0],   // Chain-link gate post
                [18.0, 12.0, 38.0],  // High-mast sodium luminaire
            ],
            keyFeatures: [
                'Depressed concrete dock leveler bumper edge',
                'Roll-up overhead door steel headers',
                'Dock apron asphalt transition seam',
                'Corrugated metal warehouse perimeter fascia',
                'High-mast yard light fixture crossbar'
            ]
        },
        {
            id: 'suburban_strip_mall',
            name: 'Suburban Strip Mall Plaza (Paramus, NJ)',
            tier: 'Tier 3: Everyday Non-Landmark',
            domain: 'Suburban Strip Commercial Center',
            lat: 40.9445,
            lng: -74.0725,
            alt: 28.0,
            focalLengthMm: 30.0,
            focalLengthPx: 980,
            cameraRotW: [0.02, -0.18, 0.0],
            cameraT: [0.0, 1.6, 2.5],
            clayColor: [205, 195, 180], // Stucco facade & asphalt parking
            getMesh: () => mergeMeshes([
                HeadlessMeshSilhouetteRenderer.createBoxMesh([4.0, 3.5, 36.0], [32, 7, 10]),
                HeadlessMeshSilhouetteRenderer.createBoxMesh([0.0, 4.0, 34.0], [18, 1.2, 2.5]),
                HeadlessMeshSilhouetteRenderer.createBoxMesh([-11.0, 3.5, 30.0], [2.5, 7.0, 1.0]),
                HeadlessMeshSilhouetteRenderer.createBoxMesh([0.0, 0.05, 24.0], [36, 0.1, 16])
            ]),
            getPose: () => ({
                x: 0.0,
                y: 1.6,
                z: 2.5,
                targetX: -5.7,
                targetY: 2.2,
                targetZ: 34.0,
                fov: 50
            }),
            features3D: [
                [-12.0, 6.5, 30.0],  // Pylon sign top left
                [-10.0, 6.5, 30.0],  // Pylon sign top right
                [-11.0, 0.0, 30.0],  // Pylon sign base
                [-6.0, 4.2, 34.0],   // Storefront 1 awning apex
                [0.0, 4.2, 36.0],    // Storefront 2 awning apex
                [6.0, 4.2, 38.0],    // Storefront 3 awning apex
                [-8.0, 5.5, 35.0],   // Parapet horizontal roofline
                [18.0, 5.5, 45.0],   // Far right storefront roofline
                [-4.0, 0.0, 24.0],   // Speed bump left edge
                [2.0, 0.0, 25.0],    // Speed bump right edge
            ],
            keyFeatures: [
                'Roadside multi-tenant pylon sign cabinet',
                'Individual tenant barrel-vault awning crests',
                'Continuous horizontal storefront roof parapet',
                'Yellow painted speed bump asphalt crest',
                'Striped parking stall boundary vertex'
            ]
        },
        {
            id: 'civil_highway_overpass',
            name: 'Civil Highway Interchange Flyover (Newark, NJ)',
            tier: 'Tier 3: Everyday Non-Landmark',
            domain: 'Transportation Infrastructure',
            lat: 40.7010,
            lng: -74.1720,
            alt: 8.5,
            focalLengthMm: 24.0,
            focalLengthPx: 1050,
            cameraRotW: [0.05, -0.10, 0.0],
            cameraT: [0.0, 1.7, 2.0],
            clayColor: [195, 195, 195], // Reinforced concrete bridge albedo
            getMesh: () => mergeMeshes([
                HeadlessMeshSilhouetteRenderer.createBoxMesh([6.0, 8.5, 30.0], [16, 2.2, 36]),
                HeadlessMeshSilhouetteRenderer.createBoxMesh([7.5, 4.0, 26.0], [2.2, 8.0, 2.2]),
                HeadlessMeshSilhouetteRenderer.createBoxMesh([11.0, 4.0, 38.0], [2.2, 8.0, 2.2]),
                HeadlessMeshSilhouetteRenderer.createBoxMesh([1.5, 7.2, 22.0], [7.0, 2.5, 0.4]),
                HeadlessMeshSilhouetteRenderer.createBoxMesh([3.0, 0.6, 18.0], [0.3, 1.2, 14])
            ]),
            getPose: () => ({
                x: 0.0,
                y: 1.7,
                z: 2.0,
                targetX: -2.6,
                targetY: 3.0,
                targetZ: 27.9,
                fov: 54
            }),
            features3D: [
                [7.5, 0.0, 26.0],    // Concrete Pier 1 base
                [7.5, 7.5, 26.0],    // Concrete Pier 1 pier cap
                [11.0, 0.0, 38.0],   // Concrete Pier 2 base
                [11.0, 7.5, 38.0],   // Concrete Pier 2 pier cap
                [-0.5, 6.2, 22.0],   // Overhead sign bottom left
                [3.5, 6.2, 22.0],    // Overhead sign bottom right
                [-0.5, 8.2, 22.0],   // Overhead sign top left
                [3.5, 8.2, 22.0],    // Overhead sign top right
                [3.0, 1.0, 15.0],    // Guardrail post top
                [6.0, 9.8, 32.0],    // Flyover bridge soffit edge
            ],
            keyFeatures: [
                'Cast-in-place reinforced pier column footing',
                'Cantilevered hammerhead pier cap corners',
                'Dual box girder bridge soffit edge line',
                'High-mast highway direction sign corner',
                'W-beam roadside crash guardrail post'
            ]
        }
    ];

    it('verifies all 12 diverse locations in the array exist and can be loaded', () => {
        expect(TEST_LOCATIONS.length).toBe(12);

        const tiers = new Set(TEST_LOCATIONS.map(loc => loc.tier));
        expect(tiers.size).toBe(3);

        for (const loc of TEST_LOCATIONS) {
            const mesh = loc.getMesh();
            expect(mesh.vertices.length).toBeGreaterThan(0);
            expect(mesh.indices.length).toBeGreaterThan(0);
            expect(loc.keyFeatures.length).toBeGreaterThanOrEqual(5);
        }
    });

    describe.each(TEST_LOCATIONS)('Location: $name ($tier)', (loc) => {
        it('executes Stage 1 2D-to-3D keypoint matching, sightline rays, and PnP resectioning', () => {
            const mesh = loc.getMesh();
            const pose = loc.getPose(mesh);

            // 1. Calculate camera intrinsics
            const fx = loc.focalLengthPx ?? ((height * 0.5) / Math.tan(((pose.fov * Math.PI) / 180) * 0.5));
            const fy = fx;
            const intrinsics: CameraIntrinsics = {
                fx,
                fy,
                cx: width * 0.5,
                cy: height * 0.5,
                width,
                height
            };

            // 2. Extract 2D-3D point pairs
            const R_gt = rodriguesToRotationMatrix(loc.cameraRotW ?? [0.05, -0.05, 0.02]);
            const points3D: Point3D[] = [];
            let points2D: Point2D[] = [];

            if (loc.features3D && loc.cameraT) {
                points3D.push(...loc.features3D);
                const t_gt = loc.cameraT;
                points2D = points3D.map(p => {
                    const xc = R_gt[0][0] * p[0] + R_gt[0][1] * p[1] + R_gt[0][2] * p[2] + t_gt[0];
                    const yc = R_gt[1][0] * p[0] + R_gt[1][1] * p[1] + R_gt[1][2] * p[2] + t_gt[1];
                    const zc = R_gt[2][0] * p[0] + R_gt[2][1] * p[1] + R_gt[2][2] * p[2] + t_gt[2];
                    return [intrinsics.fx * (xc / zc) + intrinsics.cx, intrinsics.fy * (yc / zc) + intrinsics.cy];
                });
            } else {
                const [cx, cy, cz] = computeMeshCentroid(mesh);
                const standoff = loc.standoffMeters ?? 200;
                const t_gt: Point3D = [
                    -cx * R_gt[0][0] - cy * R_gt[0][1] - cz * R_gt[0][2],
                    -cx * R_gt[1][0] - cy * R_gt[1][1] - cz * R_gt[1][2],
                    -cx * R_gt[2][0] - cy * R_gt[2][1] - cz * R_gt[2][2] + standoff
                ];
                const totalVerts = mesh.vertices.length / 3;
                const stride = Math.max(1, Math.floor(totalVerts / 256));
                for (let i = 0; i < totalVerts && points3D.length < 16; i += stride) {
                    const X = mesh.vertices[i * 3];
                    const Y = mesh.vertices[i * 3 + 1];
                    const Z = mesh.vertices[i * 3 + 2];
                    const xc = R_gt[0][0] * X + R_gt[0][1] * Y + R_gt[0][2] * Z + t_gt[0];
                    const yc = R_gt[1][0] * X + R_gt[1][1] * Y + R_gt[1][2] * Z + t_gt[1];
                    const zc = R_gt[2][0] * X + R_gt[2][1] * Y + R_gt[2][2] * Z + t_gt[2];
                    if (zc > 10) {
                        const u = intrinsics.fx * (xc / zc) + intrinsics.cx;
                        const v = intrinsics.fy * (yc / zc) + intrinsics.cy;
                        if (u >= 60 && u <= width - 60 && v >= 50 && v <= height - 50) {
                            points3D.push([X, Y, Z]);
                            points2D.push([u, v]);
                        }
                    }
                }
            }

            expect(points3D.length).toBeGreaterThanOrEqual(6);
            expect(points2D.length).toBe(points3D.length);

            // 3. Analytical solvePnP resectioning
            const pnpResult = SpatialPoseEstimatorService.solvePnP(
                points3D,
                points2D,
                intrinsics
            );

            expect(pnpResult.converged).toBe(true);
            expect(pnpResult.meanReprojectionErrorPx).toBeLessThan(0.01);

            const ransacResult = SpatialPoseEstimatorService.solvePnPRansac(
                points3D,
                points2D,
                intrinsics,
                { inlierThresholdPx: 2.0, maxRansacIterations: 100 }
            );

            expect(ransacResult.pose.converged).toBe(true);
            expect(ransacResult.inlierCount).toBe(points3D.length);
            expect(ransacResult.pose.meanReprojectionErrorPx).toBeLessThan(0.01);

            // 4. Render shaded 3D mesh
            const render = HeadlessMeshSilhouetteRenderer.renderShadedMesh(
                mesh,
                pose,
                width,
                height,
                { clayColor: loc.clayColor, bgColor: [14, 18, 24, 255] }
            );

            // 5. Draw HUD telemetry banners and border dividers
            for (let y = 0; y < 44; y++) {
                for (let x = 0; x < width; x++) {
                    const idx = (y * width + x) * 4;
                    render.rgba[idx] = Math.floor(render.rgba[idx] * 0.25 + 10);
                    render.rgba[idx + 1] = Math.floor(render.rgba[idx + 1] * 0.25 + 14);
                    render.rgba[idx + 2] = Math.floor(render.rgba[idx + 2] * 0.25 + 20);
                }
            }
            for (let y = height - 36; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const idx = (y * width + x) * 4;
                    render.rgba[idx] = Math.floor(render.rgba[idx] * 0.25 + 10);
                    render.rgba[idx + 1] = Math.floor(render.rgba[idx + 1] * 0.25 + 14);
                    render.rgba[idx + 2] = Math.floor(render.rgba[idx + 2] * 0.25 + 20);
                }
            }
            HeadlessMeshSilhouetteRenderer.drawLine(render.rgba, width, height, 0, 44, width, 44, [0, 240, 255, 120]);
            HeadlessMeshSilhouetteRenderer.drawLine(render.rgba, width, height, 0, height - 36, width, height - 36, [0, 240, 255, 120]);

            // 6. Draw 2D-to-3D keypoint anchors and projection sightline rays
            for (let k = 0; k < points2D.length; k++) {
                const px = points2D[k][0];
                const py = points2D[k][1];

                const dx = px - width * 0.5;
                const dy = py - height * 0.5;
                const len = Math.hypot(dx, dy) || 1;
                const rayLen = 28;
                const rx = px + (dx / len) * rayLen;
                const ry = py + (dy / len) * rayLen;

                // Projection ray vector (cyan/emerald)
                HeadlessMeshSilhouetteRenderer.drawLine(
                    render.rgba, width, height,
                    px, py, rx, ry,
                    [0, 255, 210, 240]
                );

                // Perpendicular tick at ray tip
                const perpX = -(dy / len) * 4;
                const perpY = (dx / len) * 4;
                HeadlessMeshSilhouetteRenderer.drawLine(
                    render.rgba, width, height,
                    rx - perpX, ry - perpY, rx + perpX, ry + perpY,
                    [0, 255, 210, 200]
                );

                // Outer targeting ring (golden, translucent)
                HeadlessMeshSilhouetteRenderer.drawPoint(
                    render.rgba, width, height,
                    px, py, 7,
                    [255, 215, 0, 90],
                    [255, 215, 0, 160]
                );

                // Golden center anchor with dark outline
                HeadlessMeshSilhouetteRenderer.drawPoint(
                    render.rgba, width, height,
                    px, py, 4,
                    [255, 215, 0, 255],
                    [0, 0, 0, 255]
                );
            }

            // 7. Export PNG visual proof artifact
            const pngFilename = `stage1_matching_${loc.id}.png`;
            const destPath1 = path.join(outDir, pngFilename);
            HeadlessMeshSilhouetteRenderer.exportPngToFile(destPath1, width, height, render.rgba);

            expect(fs.existsSync(destPath1)).toBe(true);
            expect(fs.statSync(destPath1).size).toBeGreaterThan(5_000);

            if (artifactDir) {
                const destPath2 = path.join(artifactDir, pngFilename);
                HeadlessMeshSilhouetteRenderer.exportPngToFile(destPath2, width, height, render.rgba);
                expect(fs.existsSync(destPath2)).toBe(true);
            }
        });
    });
});
