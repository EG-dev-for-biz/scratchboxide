/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Universal Architectural Bridge Service (SB-Archi)
 * Connects the Google 3D Tile Spatial Separator with the native C++20 SB-Archi
 * Classical Architectural Inversion Engine. Ingests separated architectural
 * entities, resolves classical typologies, fits stereotomic proportion systems,
 * and synthesizes 1:1 metric watertight replacement glTF 2.0 assets across any
 * geographic area.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import {
    SbArchiService,
    type ArchConstantineOptions,
    type ArchConstantineResult,
    type SbArchiInversionOptions,
    type SbArchiInversionResult
} from '../3d-engine/sb-archi-service';
import type {
    ClassicalOrder,
    StructuralFramingSystem,
    TectonicStructureClass,
    TectonicAnalysisReport
} from '../../common/spatial/sb-archi-protocol';
import {
    type UniversalSpatialNode,
    type MetricOBB,
    type SurfaceMountPlane,
    createSpatialNode,
    createIdentityMatrix
} from '../../common/spatial/universal-spatial-node';
import { measureGlbEdgeManifold } from '../3d-engine/glb-edge-manifold';

export type SupportedArchiTypology =
    // Classical Stereotomic Heritage (Preserved 1:1)
    | 'triumphal_arch'
    | 'amphitheater'
    | 'peripteral_temple'
    | 'colonnade'
    | 'aqueduct_arcade'
    | 'rotunda'
    | 'basilica_hall'
    | 'campanile_tower'
    // Open-Domain Contemporary Architecture & Hardscape
    | 'commercial_skyscraper'
    | 'commercial_podium'
    | 'residential_multifamily'
    | 'residential_brownstone'
    | 'industrial_warehouse'
    | 'street_corridor'
    | (string & {});

export interface ArchiTypologyAdapter {
    typology: SupportedArchiTypology;
    commonName: string;
    tectonicClass: TectonicStructureClass;
    framingSystem?: StructuralFramingSystem;
    order?: ClassicalOrder;
    typicalBaySpacing: number;
    typicalAspectSpread: number;     // width / height
    typicalPierWidthRatio: number;
    typicalAshlarHeight: number;
    hasPediment: boolean;
    hasAttic: boolean;
    vaultType:
        | 'semicircular'
        | 'coffered_barrel'
        | 'annular_barrel'
        | 'groin'
        | 'conical_core'
        | 'pyramid_spire'
        | 'flat_slab'
        | 'curtain_crown'
        | 'sawtooth'
        | 'street_surface';
    roughness: number;
    metalness: number;
    baseColor: string;
    description: string;
}

export const ARCHI_TYPOLOGY_ADAPTERS: Record<SupportedArchiTypology, ArchiTypologyAdapter> = {
    triumphal_arch: {
        typology: 'triumphal_arch',
        commonName: 'Triumphal Arch Monument',
        tectonicClass: 'TriumphalArch',
        framingSystem: 'load_bearing_masonry',
        order: 'composite',
        typicalBaySpacing: 6.8,
        typicalAspectSpread: 1.25,
        typicalPierWidthRatio: 0.28,
        typicalAshlarHeight: 0.65,
        hasPediment: false,
        hasAttic: true,
        vaultType: 'coffered_barrel',
        roughness: 0.82,
        metalness: 0.03,
        baseColor: '#dfd7cc',
        description: 'Triple or single fornix Roman triumphal monument with detached columns, ressauts, carved attic, and lacunaria coffers.'
    },
    amphitheater: {
        typology: 'amphitheater',
        commonName: 'Classical Flavian Amphitheater',
        tectonicClass: 'Amphitheater',
        framingSystem: 'load_bearing_masonry',
        order: 'mixed_superimposed',
        typicalBaySpacing: 6.2,
        typicalAspectSpread: 3.88,
        typicalPierWidthRatio: 0.35,
        typicalAshlarHeight: 0.75,
        hasPediment: false,
        hasAttic: true,
        vaultType: 'annular_barrel',
        roughness: 0.88,
        metalness: 0.02,
        baseColor: '#ded8ce',
        description: 'Elliptical tiered amphitheater with superimposed Tuscan, Ionic, and Corinthian arcade ambulatories and hypogeum.'
    },
    peripteral_temple: {
        typology: 'peripteral_temple',
        commonName: 'Peripteral Classical Temple',
        tectonicClass: 'PeripteralTemple',
        framingSystem: 'load_bearing_masonry',
        order: 'corinthian',
        typicalBaySpacing: 4.5,
        typicalAspectSpread: 2.2,
        typicalPierWidthRatio: 0.22,
        typicalAshlarHeight: 0.60,
        hasPediment: true,
        hasAttic: false,
        vaultType: 'coffered_barrel',
        roughness: 0.84,
        metalness: 0.02,
        baseColor: '#e3ded5',
        description: 'Monumental classical temple on raised podium with colonnaded peristyle, pronaos portico, cella, and triangular pediment.'
    },
    colonnade: {
        typology: 'colonnade',
        commonName: 'Classical Colonnade / Porticus',
        tectonicClass: 'Colonnade',
        framingSystem: 'load_bearing_masonry',
        order: 'ionic',
        typicalBaySpacing: 3.8,
        typicalAspectSpread: 4.5,
        typicalPierWidthRatio: 0.20,
        typicalAshlarHeight: 0.55,
        hasPediment: false,
        hasAttic: false,
        vaultType: 'semicircular',
        roughness: 0.80,
        metalness: 0.02,
        baseColor: '#e0dbd2',
        description: 'Continuous classical columned ambulatory or stoa supporting a linear horizontal entablature.'
    },
    aqueduct_arcade: {
        typology: 'aqueduct_arcade',
        commonName: 'Monumental Aqueduct Arcade',
        tectonicClass: 'AqueductArcade',
        framingSystem: 'load_bearing_masonry',
        order: 'tuscan',
        typicalBaySpacing: 7.5,
        typicalAspectSpread: 5.0,
        typicalPierWidthRatio: 0.40,
        typicalAshlarHeight: 0.80,
        hasPediment: false,
        hasAttic: true,
        vaultType: 'semicircular',
        roughness: 0.92,
        metalness: 0.01,
        baseColor: '#c8bfae',
        description: 'Tiered rustic opus quadratum stone piers carrying semicircular arches supporting an upper water specus channel.'
    },
    rotunda: {
        typology: 'rotunda',
        commonName: 'Classical Rotunda / Tholos Monument',
        tectonicClass: 'Rotunda',
        framingSystem: 'load_bearing_masonry',
        order: 'corinthian',
        typicalBaySpacing: 4.2,
        typicalAspectSpread: 1.0,
        typicalPierWidthRatio: 0.30,
        typicalAshlarHeight: 0.70,
        hasPediment: false,
        hasAttic: false,
        vaultType: 'conical_core',
        roughness: 0.95,
        metalness: 0.0,
        baseColor: '#a68a72',
        description: 'Circular tholos monument or conical brick-and-concrete opus caementicium fountain core (e.g. Meta Sudans) or domed rotunda.'
    },
    basilica_hall: {
        typology: 'basilica_hall',
        commonName: 'Monumental Basilica Aula',
        tectonicClass: 'BasilicaHall',
        framingSystem: 'load_bearing_masonry',
        order: 'corinthian',
        typicalBaySpacing: 18.0,
        typicalAspectSpread: 1.8,
        typicalPierWidthRatio: 0.32,
        typicalAshlarHeight: 0.75,
        hasPediment: false,
        hasAttic: true,
        vaultType: 'groin',
        roughness: 0.86,
        metalness: 0.02,
        baseColor: '#d6cfc2',
        description: 'Monumental civil basilica hall with monumental groin-vaulted central nave, barrel-vaulted coffered side bays, and semicircular apse.'
    },
    campanile_tower: {
        typology: 'campanile_tower',
        commonName: 'Romanesque Brick Campanile Bell Tower',
        tectonicClass: 'CampanileTower',
        framingSystem: 'load_bearing_masonry',
        order: 'tuscan',
        typicalBaySpacing: 6.8,
        typicalAspectSpread: 0.18,
        typicalPierWidthRatio: 0.25,
        typicalAshlarHeight: 0.35,
        hasPediment: false,
        hasAttic: false,
        vaultType: 'pyramid_spire',
        roughness: 0.88,
        metalness: 0.01,
        baseColor: '#b46d4e',
        description: 'Multi-tiered Romanesque brick bell tower with marble stringcourses, paired arched bifora belfry windows, and a 4-sided pyramid spire.'
    },
    commercial_skyscraper: {
        typology: 'commercial_skyscraper',
        commonName: 'Commercial High-Rise Skyscraper Tower',
        tectonicClass: 'SkyscraperTower',
        framingSystem: 'curtain_wall_core',
        typicalBaySpacing: 3.6,
        typicalAspectSpread: 0.25,
        typicalPierWidthRatio: 0.15,
        typicalAshlarHeight: 3.6,
        hasPediment: false,
        hasAttic: true,
        vaultType: 'curtain_crown',
        roughness: 0.25,
        metalness: 0.75,
        baseColor: '#2b394a',
        description: 'Multi-tiered commercial skyscraper tower with setback podium, curtain wall grid, recessed mechanical crown, and structural core.'
    },
    commercial_podium: {
        typology: 'commercial_podium',
        commonName: 'Commercial Street Podium & Retail Block',
        tectonicClass: 'CommercialPodium',
        framingSystem: 'frame_and_slab',
        typicalBaySpacing: 4.8,
        typicalAspectSpread: 1.8,
        typicalPierWidthRatio: 0.20,
        typicalAshlarHeight: 4.2,
        hasPediment: false,
        hasAttic: false,
        vaultType: 'flat_slab',
        roughness: 0.50,
        metalness: 0.35,
        baseColor: '#4a5568',
        description: 'Street-level urban commercial block with storefront display glazing, high ceilings, chamfered corner entrances, and accessible rooftop terrace.'
    },
    residential_multifamily: {
        typology: 'residential_multifamily',
        commonName: 'Multi-Family Residential Apartment Building',
        tectonicClass: 'MultiFamilyResidential',
        framingSystem: 'frame_and_slab',
        typicalBaySpacing: 3.2,
        typicalAspectSpread: 1.2,
        typicalPierWidthRatio: 0.28,
        typicalAshlarHeight: 3.0,
        hasPediment: false,
        hasAttic: true,
        vaultType: 'flat_slab',
        roughness: 0.75,
        metalness: 0.05,
        baseColor: '#d2c8be',
        description: 'Urban multi-family residential building with rhythmic punched window bays, cantilevered balconies, structural floor slabs, and rooftop parapet.'
    },
    residential_brownstone: {
        typology: 'residential_brownstone',
        commonName: 'Historic Urban Brownstone Townhouse',
        tectonicClass: 'BrownstoneRow',
        framingSystem: 'load_bearing_masonry',
        typicalBaySpacing: 2.8,
        typicalAspectSpread: 0.65,
        typicalPierWidthRatio: 0.35,
        typicalAshlarHeight: 3.3,
        hasPediment: false,
        hasAttic: true,
        vaultType: 'flat_slab',
        roughness: 0.85,
        metalness: 0.02,
        baseColor: '#8a4b38',
        description: 'Traditional brownstone rowhouse with rusticated English basement, entrance stoop, tall parlor floor window reveals, and projecting bracketed roof cornice.'
    },
    industrial_warehouse: {
        typology: 'industrial_warehouse',
        commonName: 'Industrial Warehouse & Logistics Facility',
        tectonicClass: 'IndustrialWarehouse',
        framingSystem: 'steel_portal_frame',
        typicalBaySpacing: 9.0,
        typicalAspectSpread: 3.5,
        typicalPierWidthRatio: 0.12,
        typicalAshlarHeight: 6.0,
        hasPediment: true,
        hasAttic: false,
        vaultType: 'sawtooth',
        roughness: 0.70,
        metalness: 0.30,
        baseColor: '#78828a',
        description: 'Large-span industrial distribution facility with structural steel frames, loading dock bays, clerestory daylighting, and solar roof planes.'
    },
    street_corridor: {
        typology: 'street_corridor',
        commonName: 'Waymo Multi-Lane Street Corridor & Hardscape',
        tectonicClass: 'StreetCorridor',
        framingSystem: 'infrastructure_pavement',
        typicalBaySpacing: 10.0,
        typicalAspectSpread: 6.0,
        typicalPierWidthRatio: 0.05,
        typicalAshlarHeight: 0.15,
        hasPediment: false,
        hasAttic: false,
        vaultType: 'street_surface',
        roughness: 0.90,
        metalness: 0.01,
        baseColor: '#3d3f44',
        description: 'Waymo map.proto-aligned transit corridor featuring parabolic road camber, 0.15m curb lips, crosswalk zones, and pedestrian sidewalk slabs.'
    }
};

export interface SpatialArchiEntity {
    id: string;
    name?: string;
    category?: string;
    typology?: SupportedArchiTypology;
    boundingBox?: {
        min: [number, number, number];
        max: [number, number, number];
        dimensions: [number, number, number]; // [width, height, depth]
        centroid: [number, number, number];
        volumeM3?: number;
    };
    orientedBoundingBox?: {
        center: [number, number, number];
        dimensions: [number, number, number];
        halfExtents: [number, number, number];
        yawDeg?: number;
        yawRad?: number;
        quaternion?: [number, number, number, number];
    };
    metricDimensions?: [number, number, number];
    metricPositionENU?: [number, number, number];
    nominalDimensions?: [number, number, number] | number[];
    nominalCentroid?: [number, number, number] | number[];
    trellisPrompt?: string;
    submeshIndices?: number[];
    rawScanGlbPath?: string;
    material?: {
        roughness?: number;
        metalness?: number;
        baseColor?: string;
    };

    /** Google 2.5D Vector Map Tiles local boundary polygon [x, z] */
    vectorFootprint?: Array<[number, number]>;
    baseElevationMeters?: number;
    roofElevationMeters?: number;

    /** Google Solar API rooftop planar segments (ax + by + cz + d = 0) */
    solarRoofSegments?: Array<{
        planeEquation: [number, number, number, number];
        pitchDegrees?: number;
        azimuthDegrees?: number;
        centerElevationMeters?: number;
        boundaryPolygon?: Array<[number, number]>;
    }>;

    /** Waymo map.proto centerline polyline and curb specification */
    roadCorridor?: {
        centerline: Array<[number, number, number]>;
        laneCount?: number;
        laneWidthMeters?: number;
        curbHeightMeters?: number;
        sidewalkWidthMeters?: number;
        camberSlope?: number;
    };

    /** Number of interior floor levels */
    levels?: number;

    /** Facade window aperture recess reveal depth into wall slab (nominally >= 0.20m) */
    facadeRevealDepth?: number;

    /** Structural wall thickness separating exterior mass from interior cavities (nominally >= 0.15m) */
    wallThickness?: number;

    /** Structural framing and tectonic system (ADA continuous dimensional schema parameter) */
    framingSystem?: StructuralFramingSystem;
}

export interface ArchiSynthesisBridgeOptions {
    outputGlbPath?: string;
    typologyOverride?: SupportedArchiTypology;
    runInversionIfScanAvailable?: boolean;
    pbrMode?: 'travertine' | 'clay' | 'brick_opus' | 'pentelic_marble' | 'peperino';
    section?: 'north_facade' | 'south_facade' | 'full_ellipse' | 'central_bay';
    subdivideVoussoirs?: boolean;
    useStereotomicJoggles?: boolean;
    useAnathyrosis?: boolean;
}

export interface ArchiSynthesisBridgeResult {
    entityId: string;
    typology: SupportedArchiTypology;
    tectonicClass: TectonicStructureClass;
    framingSystem?: StructuralFramingSystem;
    order?: ClassicalOrder;
    worldPosition: [number, number, number];
    worldRotationYawRad: number;
    fittedDimensionsMeters: [number, number, number];
    outputGlbPath: string;
    glbBuffer?: Buffer;
    glbBase64?: string;
    spatialNode?: UniversalSpatialNode;
    telemetry: {
        buildTimeMs: number;
        outputVertices: number;
        outputTriangles: number;
        isManifold: boolean;
        inversionRan: boolean;
        detectedDatumsCount?: number;
        floorCount?: number;
        roofPlaneCount?: number;
        hasSolarGrounding?: boolean;
        hasVectorGrounding?: boolean;
    };
}

// ============================================================================
// Internal Procedural glTF 2.0 Architectural Geometry Synthesizer
// ============================================================================

class ProceduralArchiMeshBuilder {
    positions: number[] = [];
    normals: number[] = [];
    uvs: number[] = [];
    indices: number[] = [];

    addVertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
        this.positions.push(x, y, z);
        this.normals.push(nx, ny, nz);
        this.uvs.push(u, v);
        return (this.positions.length / 3) - 1;
    }

    addQuad(i0: number, i1: number, i2: number, i3: number) {
        this.indices.push(i0, i1, i2);
        this.indices.push(i0, i2, i3);
    }

    addBox(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number) {
        const hx = sx * 0.5;
        const hy = sy * 0.5;
        const hz = sz * 0.5;

        // Front (+Z)
        let v0 = this.addVertex(cx - hx, cy - hy, cz + hz, 0, 0, 1, 0, 0);
        let v1 = this.addVertex(cx + hx, cy - hy, cz + hz, 0, 0, 1, 1, 0);
        let v2 = this.addVertex(cx + hx, cy + hy, cz + hz, 0, 0, 1, 1, 1);
        let v3 = this.addVertex(cx - hx, cy + hy, cz + hz, 0, 0, 1, 0, 1);
        this.addQuad(v0, v1, v2, v3);

        // Back (-Z)
        v0 = this.addVertex(cx + hx, cy - hy, cz - hz, 0, 0, -1, 0, 0);
        v1 = this.addVertex(cx - hx, cy - hy, cz - hz, 0, 0, -1, 1, 0);
        v2 = this.addVertex(cx - hx, cy + hy, cz - hz, 0, 0, -1, 1, 1);
        v3 = this.addVertex(cx + hx, cy + hy, cz - hz, 0, 0, -1, 0, 1);
        this.addQuad(v0, v1, v2, v3);

        // Top (+Y)
        v0 = this.addVertex(cx - hx, cy + hy, cz + hz, 0, 1, 0, 0, 0);
        v1 = this.addVertex(cx + hx, cy + hy, cz + hz, 0, 1, 0, 1, 0);
        v2 = this.addVertex(cx + hx, cy + hy, cz - hz, 0, 1, 0, 1, 1);
        v3 = this.addVertex(cx - hx, cy + hy, cz - hz, 0, 1, 0, 0, 1);
        this.addQuad(v0, v1, v2, v3);

        // Bottom (-Y)
        v0 = this.addVertex(cx - hx, cy - hy, cz - hz, 0, -1, 0, 0, 0);
        v1 = this.addVertex(cx + hx, cy - hy, cz - hz, 0, -1, 0, 1, 0);
        v2 = this.addVertex(cx + hx, cy - hy, cz + hz, 0, -1, 0, 1, 1);
        v3 = this.addVertex(cx - hx, cy - hy, cz + hz, 0, -1, 0, 0, 1);
        this.addQuad(v0, v1, v2, v3);

        // Right (+X)
        v0 = this.addVertex(cx + hx, cy - hy, cz + hz, 1, 0, 0, 0, 0);
        v1 = this.addVertex(cx + hx, cy - hy, cz - hz, 1, 0, 0, 1, 0);
        v2 = this.addVertex(cx + hx, cy + hy, cz - hz, 1, 0, 0, 1, 1);
        v3 = this.addVertex(cx + hx, cy + hy, cz + hz, 1, 0, 0, 0, 1);
        this.addQuad(v0, v1, v2, v3);

        // Left (-X)
        v0 = this.addVertex(cx - hx, cy - hy, cz - hz, -1, 0, 0, 0, 0);
        v1 = this.addVertex(cx - hx, cy - hy, cz + hz, -1, 0, 0, 1, 0);
        v2 = this.addVertex(cx - hx, cy + hy, cz + hz, -1, 0, 0, 1, 1);
        v3 = this.addVertex(cx - hx, cy + hy, cz - hz, -1, 0, 0, 0, 1);
        this.addQuad(v0, v1, v2, v3);
    }

    addCylinder(cx: number, cy: number, cz: number, rBot: number, rTop: number, height: number, radialSegs: number = 16) {
        const yBot = cy - height * 0.5;
        const yTop = cy + height * 0.5;
        const botIndices: number[] = [];
        const topIndices: number[] = [];

        for (let i = 0; i <= radialSegs; i++) {
            const theta = (i / radialSegs) * Math.PI * 2.0;
            const cosT = Math.cos(theta);
            const sinT = Math.sin(theta);
            const u = i / radialSegs;

            // Side vertices
            const vxBot = cx + rBot * cosT;
            const vzBot = cz + rBot * sinT;
            const vxTop = cx + rTop * cosT;
            const vzTop = cz + rTop * sinT;

            const slope = (rBot - rTop) / height;
            const ny = slope;
            const normLen = Math.hypot(cosT, ny, sinT);
            const nx = cosT / normLen;
            const nz = sinT / normLen;

            const bIdx = this.addVertex(vxBot, yBot, vzBot, nx, ny / normLen, nz, u, 0);
            const tIdx = this.addVertex(vxTop, yTop, vzTop, nx, ny / normLen, nz, u, 1);

            botIndices.push(bIdx);
            topIndices.push(tIdx);

            if (i > 0) {
                const prevB = botIndices[i - 1];
                const prevT = topIndices[i - 1];
                this.addQuad(prevB, bIdx, tIdx, prevT);
            }
        }

        // Top Cap
        const centerTopIdx = this.addVertex(cx, yTop, cz, 0, 1, 0, 0.5, 0.5);
        for (let i = 0; i < radialSegs; i++) {
            const t0 = this.addVertex(
                cx + rTop * Math.cos((i / radialSegs) * Math.PI * 2),
                yTop,
                cz + rTop * Math.sin((i / radialSegs) * Math.PI * 2),
                0, 1, 0,
                0.5 + 0.5 * Math.cos((i / radialSegs) * Math.PI * 2),
                0.5 + 0.5 * Math.sin((i / radialSegs) * Math.PI * 2)
            );
            const t1 = this.addVertex(
                cx + rTop * Math.cos(((i + 1) / radialSegs) * Math.PI * 2),
                yTop,
                cz + rTop * Math.sin(((i + 1) / radialSegs) * Math.PI * 2),
                0, 1, 0,
                0.5 + 0.5 * Math.cos(((i + 1) / radialSegs) * Math.PI * 2),
                0.5 + 0.5 * Math.sin(((i + 1) / radialSegs) * Math.PI * 2)
            );
            this.indices.push(centerTopIdx, t0, t1);
        }

        // Bottom Cap
        const centerBotIdx = this.addVertex(cx, yBot, cz, 0, -1, 0, 0.5, 0.5);
        for (let i = 0; i < radialSegs; i++) {
            const b0 = this.addVertex(
                cx + rBot * Math.cos((i / radialSegs) * Math.PI * 2),
                yBot,
                cz + rBot * Math.sin((i / radialSegs) * Math.PI * 2),
                0, -1, 0,
                0.5 + 0.5 * Math.cos((i / radialSegs) * Math.PI * 2),
                0.5 + 0.5 * Math.sin((i / radialSegs) * Math.PI * 2)
            );
            const b1 = this.addVertex(
                cx + rBot * Math.cos(((i + 1) / radialSegs) * Math.PI * 2),
                yBot,
                cz + rBot * Math.sin(((i + 1) / radialSegs) * Math.PI * 2),
                0, -1, 0,
                0.5 + 0.5 * Math.cos(((i + 1) / radialSegs) * Math.PI * 2),
                0.5 + 0.5 * Math.sin(((i + 1) / radialSegs) * Math.PI * 2)
            );
            this.indices.push(centerBotIdx, b1, b0);
        }
    }

    addPediment(cx: number, cy: number, cz: number, width: number, height: number, depth: number) {
        const hw = width * 0.5;
        const hd = depth * 0.5;
        const yBase = cy - height * 0.5;
        const yApex = cy + height * 0.5;

        // Front Triangle (+Z)
        const f0 = this.addVertex(cx - hw, yBase, cz + hd, 0, 0, 1, 0, 0);
        const f1 = this.addVertex(cx + hw, yBase, cz + hd, 0, 0, 1, 1, 0);
        const f2 = this.addVertex(cx, yApex, cz + hd, 0, 0, 1, 0.5, 1);
        this.indices.push(f0, f1, f2);

        // Back Triangle (-Z)
        const b0 = this.addVertex(cx + hw, yBase, cz - hd, 0, 0, -1, 0, 0);
        const b1 = this.addVertex(cx - hw, yBase, cz - hd, 0, 0, -1, 1, 0);
        const b2 = this.addVertex(cx, yApex, cz - hd, 0, 0, -1, 0.5, 1);
        this.indices.push(b0, b1, b2);

        // Bottom Soffit (-Y)
        const s0 = this.addVertex(cx - hw, yBase, cz - hd, 0, -1, 0, 0, 0);
        const s1 = this.addVertex(cx + hw, yBase, cz - hd, 0, -1, 0, 1, 0);
        const s2 = this.addVertex(cx + hw, yBase, cz + hd, 0, -1, 0, 1, 1);
        const s3 = this.addVertex(cx - hw, yBase, cz + hd, 0, -1, 0, 0, 1);
        this.addQuad(s0, s1, s2, s3);

        // Left Raking Slope
        const slopeLenL = Math.hypot(hw, height);
        const nlx = -height / slopeLenL;
        const nly = hw / slopeLenL;
        const l0 = this.addVertex(cx - hw, yBase, cz + hd, nlx, nly, 0, 0, 0);
        const l1 = this.addVertex(cx, yApex, cz + hd, nlx, nly, 0, 1, 0);
        const l2 = this.addVertex(cx, yApex, cz - hd, nlx, nly, 0, 1, 1);
        const l3 = this.addVertex(cx - hw, yBase, cz - hd, nlx, nly, 0, 0, 1);
        this.addQuad(l0, l1, l2, l3);

        // Right Raking Slope
        const slopeLenR = Math.hypot(hw, height);
        const nrx = height / slopeLenR;
        const nry = hw / slopeLenR;
        const r0 = this.addVertex(cx, yApex, cz + hd, nrx, nry, 0, 0, 0);
        const r1 = this.addVertex(cx + hw, yBase, cz + hd, nrx, nry, 0, 1, 0);
        const r2 = this.addVertex(cx + hw, yBase, cz - hd, nrx, nry, 0, 1, 1);
        const r3 = this.addVertex(cx, yApex, cz - hd, nrx, nry, 0, 0, 1);
        this.addQuad(r0, r1, r2, r3);
    }

    addArch(cx: number, cy: number, cz: number, rOuter: number, rInner: number, depth: number, segs: number = 12) {
        const hd = depth * 0.5;

        for (let i = 0; i < segs; i++) {
            const theta0 = (i / segs) * Math.PI;
            const theta1 = ((i + 1) / segs) * Math.PI;

            const c0 = Math.cos(theta0);
            const s0 = Math.sin(theta0);
            const c1 = Math.cos(theta1);
            const s1 = Math.sin(theta1);

            // Front face (+Z)
            const f_in0 = this.addVertex(cx + rInner * c0, cy + rInner * s0, cz + hd, 0, 0, 1, 0, 0);
            const f_out0 = this.addVertex(cx + rOuter * c0, cy + rOuter * s0, cz + hd, 0, 0, 1, 0, 1);
            const f_out1 = this.addVertex(cx + rOuter * c1, cy + rOuter * s1, cz + hd, 0, 0, 1, 1, 1);
            const f_in1 = this.addVertex(cx + rInner * c1, cy + rInner * s1, cz + hd, 0, 0, 1, 1, 0);
            this.addQuad(f_in0, f_out0, f_out1, f_in1);

            // Back face (-Z)
            const b_in0 = this.addVertex(cx + rInner * c0, cy + rInner * s0, cz - hd, 0, 0, -1, 0, 0);
            const b_out0 = this.addVertex(cx + rOuter * c0, cy + rOuter * s0, cz - hd, 0, 0, -1, 0, 1);
            const b_out1 = this.addVertex(cx + rOuter * c1, cy + rOuter * s1, cz - hd, 0, 0, -1, 1, 1);
            const b_in1 = this.addVertex(cx + rInner * c1, cy + rInner * s1, cz - hd, 0, 0, -1, 1, 0);
            this.addQuad(b_out0, b_in0, b_in1, b_out1);

            // Intrados (inner soffit ceiling, normal facing inward: -cos, -sin)
            const midTheta = (theta0 + theta1) * 0.5;
            const inNx = -Math.cos(midTheta);
            const inNy = -Math.sin(midTheta);
            const i0 = this.addVertex(cx + rInner * c0, cy + rInner * s0, cz - hd, inNx, inNy, 0, 0, 0);
            const i1 = this.addVertex(cx + rInner * c0, cy + rInner * s0, cz + hd, inNx, inNy, 0, 0, 1);
            const i2 = this.addVertex(cx + rInner * c1, cy + rInner * s1, cz + hd, inNx, inNy, 0, 1, 1);
            const i3 = this.addVertex(cx + rInner * c1, cy + rInner * s1, cz - hd, inNx, inNy, 0, 1, 0);
            this.addQuad(i0, i1, i2, i3);

            // Extrados (outer arch top, normal facing outward: +cos, +sin)
            const outNx = Math.cos(midTheta);
            const outNy = Math.sin(midTheta);
            const o0 = this.addVertex(cx + rOuter * c0, cy + rOuter * s0, cz + hd, outNx, outNy, 0, 0, 0);
            const o1 = this.addVertex(cx + rOuter * c0, cy + rOuter * s0, cz - hd, outNx, outNy, 0, 0, 1);
            const o2 = this.addVertex(cx + rOuter * c1, cy + rOuter * s1, cz - hd, outNx, outNy, 0, 1, 1);
            const o3 = this.addVertex(cx + rOuter * c1, cy + rOuter * s1, cz + hd, outNx, outNy, 0, 1, 0);
            this.addQuad(o0, o1, o2, o3);
        }
    }

    addPyramid(cx: number, cy: number, cz: number, width: number, height: number, depth: number) {
        const hw = width * 0.5;
        const hd = depth * 0.5;
        const yBase = cy - height * 0.5;
        const yApex = cy + height * 0.5;

        // Bottom Quad (-Y)
        const s0 = this.addVertex(cx - hw, yBase, cz - hd, 0, -1, 0, 0, 0);
        const s1 = this.addVertex(cx + hw, yBase, cz - hd, 0, -1, 0, 1, 0);
        const s2 = this.addVertex(cx + hw, yBase, cz + hd, 0, -1, 0, 1, 1);
        const s3 = this.addVertex(cx - hw, yBase, cz + hd, 0, -1, 0, 0, 1);
        this.addQuad(s0, s1, s2, s3);

        // Front Slope (+Z)
        const slopeLenZ = Math.hypot(hd, height);
        const fnz = height / slopeLenZ;
        const fny = hd / slopeLenZ;
        const f0 = this.addVertex(cx - hw, yBase, cz + hd, 0, fny, fnz, 0, 0);
        const f1 = this.addVertex(cx + hw, yBase, cz + hd, 0, fny, fnz, 1, 0);
        const f2 = this.addVertex(cx, yApex, cz, 0, fny, fnz, 0.5, 1);
        this.indices.push(f0, f1, f2);

        // Back Slope (-Z)
        const b0 = this.addVertex(cx + hw, yBase, cz - hd, 0, fny, -fnz, 0, 0);
        const b1 = this.addVertex(cx - hw, yBase, cz - hd, 0, fny, -fnz, 1, 0);
        const b2 = this.addVertex(cx, yApex, cz, 0, fny, -fnz, 0.5, 1);
        this.indices.push(b0, b1, b2);

        // Left Slope (-X)
        const slopeLenX = Math.hypot(hw, height);
        const lnx = -height / slopeLenX;
        const lny = hw / slopeLenX;
        const l0 = this.addVertex(cx - hw, yBase, cz - hd, lnx, lny, 0, 0, 0);
        const l1 = this.addVertex(cx - hw, yBase, cz + hd, lnx, lny, 0, 1, 0);
        const l2 = this.addVertex(cx, yApex, cz, lnx, lny, 0, 0.5, 1);
        this.indices.push(l0, l1, l2);

        // Right Slope (+X)
        const rnx = height / slopeLenX;
        const rny = hw / slopeLenX;
        const r0 = this.addVertex(cx + hw, yBase, cz + hd, rnx, rny, 0, 0, 0);
        const r1 = this.addVertex(cx + hw, yBase, cz - hd, rnx, rny, 0, 1, 0);
        const r2 = this.addVertex(cx, yApex, cz, rnx, rny, 0, 0.5, 1);
        this.indices.push(r0, r1, r2);
    }

    addExtrudedPolygon(
        polygon: Array<[number, number]>,
        yBottom: number,
        yTop: number,
        options: {
            chamferBaseHeight?: number;
            chamferParapetHeight?: number;
            chamferOffset?: number;
        } = {}
    ) {
        if (!polygon || polygon.length < 3) return;
        const n = polygon.length;
        const baseH = options.chamferBaseHeight ?? 0;
        const parapetH = options.chamferParapetHeight ?? 0;
        const offset = options.chamferOffset ?? 0.15;

        // Side wall segments
        for (let i = 0; i < n; i++) {
            const p0 = polygon[i];
            const p1 = polygon[(i + 1) % n];
            const dx = p1[0] - p0[0];
            const dz = p1[1] - p0[1];
            const len = Math.hypot(dx, dz);
            if (len < 1e-4) continue;
            const nx = dz / len;
            const nz = -dx / len;

            // Base plinth if requested
            if (baseH > 0) {
                const b0 = this.addVertex(p0[0] + nx * offset, yBottom, p0[1] + nz * offset, nx, 0, nz, 0, 0);
                const b1 = this.addVertex(p1[0] + nx * offset, yBottom, p1[1] + nz * offset, nx, 0, nz, 1, 0);
                const b2 = this.addVertex(p1[0], yBottom + baseH, p1[1], nx, 0.2, nz, 1, 1);
                const b3 = this.addVertex(p0[0], yBottom + baseH, p0[0], nx, 0.2, nz, 0, 1);
                this.addQuad(b0, b1, b2, b3);
            }

            // Main vertical shaft
            const yShaftBot = baseH > 0 ? yBottom + baseH : yBottom;
            const v0 = this.addVertex(p0[0], yShaftBot, p0[1], nx, 0, nz, 0, 0);
            const v1 = this.addVertex(p1[0], yShaftBot, p1[1], nx, 0, nz, 1, 0);
            const v2 = this.addVertex(p1[0], yTop, p1[1], nx, 0, nz, 1, 1);
            const v3 = this.addVertex(p0[0], yTop, p0[1], nx, 0, nz, 0, 1);
            this.addQuad(v0, v1, v2, v3);

            // Parapet if requested
            if (parapetH > 0) {
                const pr0 = this.addVertex(p0[0], yTop, p0[1], nx, 0, nz, 0, 0);
                const pr1 = this.addVertex(p1[0], yTop, p1[1], nx, 0, nz, 1, 0);
                const pr2 = this.addVertex(p1[0] + nx * (offset * 0.5), yTop + parapetH, p1[1] + nz * (offset * 0.5), nx, 0, nz, 1, 1);
                const pr3 = this.addVertex(p0[0] + nx * (offset * 0.5), yTop + parapetH, p0[1] + nz * (offset * 0.5), nx, 0, nz, 0, 1);
                this.addQuad(pr0, pr1, pr2, pr3);
            }
        }

        // Centroid for caps
        let cx = 0, cz = 0;
        for (const p of polygon) {
            cx += p[0];
            cz += p[1];
        }
        cx /= n;
        cz /= n;

        // Bottom Cap (-Y)
        const bCenter = this.addVertex(cx, yBottom, cz, 0, -1, 0, 0.5, 0.5);
        for (let i = 0; i < n; i++) {
            const p0 = polygon[i];
            const p1 = polygon[(i + 1) % n];
            const b0 = this.addVertex(p0[0], yBottom, p0[1], 0, -1, 0, 0, 0);
            const b1 = this.addVertex(p1[0], yBottom, p1[1], 0, -1, 0, 1, 0);
            this.indices.push(bCenter, b1, b0);
        }

        // Top Cap (+Y)
        const yCap = parapetH > 0 ? yTop + parapetH : yTop;
        const tCenter = this.addVertex(cx, yCap, cz, 0, 1, 0, 0.5, 0.5);
        for (let i = 0; i < n; i++) {
            const p0 = polygon[i];
            const p1 = polygon[(i + 1) % n];
            const t0 = this.addVertex(p0[0], yCap, p0[1], 0, 1, 0, 0, 0);
            const t1 = this.addVertex(p1[0], yCap, p1[1], 0, 1, 0, 1, 0);
            this.indices.push(tCenter, t0, t1);
        }
    }

    addSolarRectifiedRoof(
        polygon: Array<[number, number]>,
        solarPlanes: Array<{ planeEquation: [number, number, number, number]; pitchDegrees?: number; azimuthDegrees?: number }>,
        yBaseRoof: number
    ) {
        if (!polygon || polygon.length < 3) return;
        if (!solarPlanes || solarPlanes.length === 0) return;

        let cx = 0, cz = 0;
        for (const p of polygon) {
            cx += p[0];
            cz += p[1];
        }
        cx /= polygon.length;
        cz /= polygon.length;

        for (const segment of solarPlanes) {
            const [a, b, c, d] = segment.planeEquation;
            const normLen = Math.hypot(a, b, c) || 1.0;
            const nx = a / normLen;
            const ny = b / normLen;
            const nz = c / normLen;

            const evalY = (x: number, z: number) => {
                if (Math.abs(b) < 1e-4) return yBaseRoof;
                const computed = -(a * x + c * z + d) / b;
                return Math.max(yBaseRoof, Math.min(yBaseRoof + 35.0, computed));
            };

            const apexY = evalY(cx, cz);
            const apexIdx = this.addVertex(cx, apexY, cz, nx, ny, nz, 0.5, 0.5);

            for (let i = 0; i < polygon.length; i++) {
                const p0 = polygon[i];
                const p1 = polygon[(i + 1) % polygon.length];
                const y0 = evalY(p0[0], p0[1]);
                const y1 = evalY(p1[0], p1[1]);

                const v0 = this.addVertex(p0[0], y0, p0[1], nx, ny, nz, 0, 0);
                const v1 = this.addVertex(p1[0], y1, p1[1], nx, ny, nz, 1, 0);
                this.indices.push(apexIdx, v0, v1);
            }
        }
    }

    addFacadeBaysWithRecessedWindows(
        p0: [number, number],
        p1: [number, number],
        yBottom: number,
        yTop: number,
        options: {
            floorHeight?: number;
            bayWidth?: number;
            recessDepth?: number;
            sillDrainageAngleDeg?: number;
        } = {}
    ) {
        const dx = p1[0] - p0[0];
        const dz = p1[1] - p0[1];
        const wallLen = Math.hypot(dx, dz);
        if (wallLen < 1.0) return;

        const wallHeight = yTop - yBottom;
        const nx = dz / wallLen;
        const nz = -dx / wallLen;
        const tx = dx / wallLen;
        const tz = dz / wallLen;

        const floorH = options.floorHeight ?? 3.5;
        const bayW = options.bayWidth ?? 3.2;
        const recessDepth = Math.max(0.20, options.recessDepth ?? 0.25); // Invariant: recess >= 0.20m
        const sillTiltRad = ((options.sillDrainageAngleDeg ?? 14.0) * Math.PI) / 180.0;

        const numFloors = Math.max(1, Math.floor(wallHeight / floorH));
        const numBays = Math.max(1, Math.floor(wallLen / bayW));
        const actualBayW = wallLen / numBays;
        const actualFloorH = wallHeight / numFloors;

        const pierRatio = 0.25;
        const spandrelRatio = 0.28;

        for (let f = 0; f < numFloors; f++) {
            const fBot = yBottom + f * actualFloorH;
            const fTop = fBot + actualFloorH;
            const spandrelH = actualFloorH * spandrelRatio;
            const windowBot = fBot + spandrelH;
            const windowTop = fTop - (spandrelH * 0.3);

            for (let b = 0; b < numBays; b++) {
                const bayStart = b * actualBayW;
                const pierW = actualBayW * pierRatio;
                const winW = actualBayW - pierW * 2.0;

                const xLeft = p0[0] + tx * (bayStart + pierW);
                const zLeft = p0[1] + tz * (bayStart + pierW);
                const xRight = xLeft + tx * winW;
                const zRight = zLeft + tz * winW;

                // Recessed window glazing plane (inset along -normal by recessDepth)
                const rxLeft = xLeft - nx * recessDepth;
                const rzLeft = zLeft - nz * recessDepth;
                const rxRight = xRight - nx * recessDepth;
                const rzRight = zRight - nz * recessDepth;

                // 1. Recessed Glazing pane
                const g0 = this.addVertex(rxLeft, windowBot, rzLeft, nx, 0, nz, 0, 0);
                const g1 = this.addVertex(rxRight, windowBot, rzRight, nx, 0, nz, 1, 0);
                const g2 = this.addVertex(rxRight, windowTop, rzRight, nx, 0, nz, 1, 1);
                const g3 = this.addVertex(rxLeft, windowTop, rzLeft, nx, 0, nz, 0, 1);
                this.addQuad(g0, g1, g2, g3);

                // 2. Left window reveal jamb (facing +T)
                const jL0 = this.addVertex(xLeft, windowBot, zLeft, tx, 0, tz, 0, 0);
                const jL1 = this.addVertex(rxLeft, windowBot, rzLeft, tx, 0, tz, 1, 0);
                const jL2 = this.addVertex(rxLeft, windowTop, rzLeft, tx, 0, tz, 1, 1);
                const jL3 = this.addVertex(xLeft, windowTop, zLeft, tx, 0, tz, 0, 1);
                this.addQuad(jL0, jL1, jL2, jL3);

                // 3. Right window reveal jamb (facing -T)
                const jR0 = this.addVertex(rxRight, windowBot, rzRight, -tx, 0, -tz, 0, 0);
                const jR1 = this.addVertex(xRight, windowBot, zRight, -tx, 0, -tz, 1, 0);
                const jR2 = this.addVertex(xRight, windowTop, zRight, -tx, 0, -tz, 1, 1);
                const jR3 = this.addVertex(rxRight, windowTop, rzRight, -tx, 0, -tz, 0, 1);
                this.addQuad(jR0, jR1, jR2, jR3);

                // 4. Lintel Soffit ceiling (facing -Y)
                const s0 = this.addVertex(rxLeft, windowTop, rzLeft, 0, -1, 0, 0, 0);
                const s1 = this.addVertex(rxRight, windowTop, rzRight, 0, -1, 0, 1, 0);
                const s2 = this.addVertex(xRight, windowTop, zRight, 0, -1, 0, 1, 1);
                const s3 = this.addVertex(xLeft, windowTop, zLeft, 0, -1, 0, 0, 1);
                this.addQuad(s0, s1, s2, s3);

                // 5. Drainage Window Sill (facing upward & outward with tilt)
                const sillDrop = recessDepth * Math.tan(sillTiltRad);
                const sillNx = nx * Math.cos(sillTiltRad);
                const sillNy = Math.sin(sillTiltRad);
                const sillNz = nz * Math.cos(sillTiltRad);

                const sil0 = this.addVertex(xLeft, windowBot - sillDrop, zLeft, sillNx, sillNy, sillNz, 0, 0);
                const sil1 = this.addVertex(xRight, windowBot - sillDrop, zRight, sillNx, sillNy, sillNz, 1, 0);
                const sil2 = this.addVertex(rxRight, windowBot, rzRight, sillNx, sillNy, sillNz, 1, 1);
                const sil3 = this.addVertex(rxLeft, windowBot, rzLeft, sillNx, sillNy, sillNz, 0, 1);
                this.addQuad(sil0, sil1, sil2, sil3);
            }
        }
    }

    addRoadCorridor(
        centerline: Array<[number, number, number]>,
        options: {
            laneCount?: number;
            laneWidthMeters?: number;
            curbHeightMeters?: number;
            sidewalkWidthMeters?: number;
            camberSlope?: number;
        } = {}
    ) {
        if (!centerline || centerline.length < 2) return;
        const laneCount = options.laneCount ?? 2;
        const laneWidth = options.laneWidthMeters ?? 3.5;
        const curbH = options.curbHeightMeters ?? 0.15; // Invariant: 0.15m Waymo curb
        const sidewalkW = options.sidewalkWidthMeters ?? 2.5;
        const camber = options.camberSlope ?? 0.02;

        const halfRoadW = (laneCount * laneWidth) * 0.5;
        const camberPeak = halfRoadW * camber;

        interface ProfileSlice {
            leftSidewalkOuter: number;
            leftCurbTop: number;
            leftGutter: number;
            crown: number;
            rightGutter: number;
            rightCurbTop: number;
            rightSidewalkOuter: number;
        }

        const slices: ProfileSlice[] = [];

        for (let i = 0; i < centerline.length; i++) {
            const pt = centerline[i];
            let tx = 0, tz = 0;
            if (i < centerline.length - 1) {
                tx = centerline[i + 1][0] - pt[0];
                tz = centerline[i + 1][2] - pt[2];
            } else {
                tx = pt[0] - centerline[i - 1][0];
                tz = pt[2] - centerline[i - 1][2];
            }
            const tLen = Math.hypot(tx, tz) || 1.0;
            tx /= tLen;
            tz /= tLen;

            // Right normal vector
            const rx = -tz;
            const rz = tx;

            const y0 = pt[1];
            const yCrown = y0 + camberPeak;
            const yCurb = y0 + curbH;
            const yWalk = yCurb + sidewalkW * 0.01;

            // 1. Left Sidewalk Outer (-R)
            const lsx = pt[0] - rx * (halfRoadW + sidewalkW);
            const lsz = pt[2] - rz * (halfRoadW + sidewalkW);
            const lsIdx = this.addVertex(lsx, yWalk, lsz, 0, 1, 0, 0, 0);

            // 2. Left Curb Top
            const lcx = pt[0] - rx * halfRoadW;
            const lcz = pt[2] - rz * halfRoadW;
            const lcIdx = this.addVertex(lcx, yCurb, lcz, 0, 1, 0, 0.15, 0);

            // 3. Left Gutter
            const lgIdx = this.addVertex(lcx, y0, lcz, rx, 0, rz, 0.20, 0);

            // 4. Crown
            const crIdx = this.addVertex(pt[0], yCrown, pt[2], 0, 1, 0, 0.50, 0);

            // 5. Right Gutter
            const rcx = pt[0] + rx * halfRoadW;
            const rcz = pt[2] + rz * halfRoadW;
            const rgIdx = this.addVertex(rcx, y0, rcz, -rx, 0, -rz, 0.80, 0);

            // 6. Right Curb Top
            const rcTopIdx = this.addVertex(rcx, yCurb, rcz, 0, 1, 0, 0.85, 0);

            // 7. Right Sidewalk Outer (+R)
            const rsx = pt[0] + rx * (halfRoadW + sidewalkW);
            const rsz = pt[2] + rz * (halfRoadW + sidewalkW);
            const rsIdx = this.addVertex(rsx, yWalk, rsz, 0, 1, 0, 1.0, 0);

            slices.push({
                leftSidewalkOuter: lsIdx,
                leftCurbTop: lcIdx,
                leftGutter: lgIdx,
                crown: crIdx,
                rightGutter: rgIdx,
                rightCurbTop: rcTopIdx,
                rightSidewalkOuter: rsIdx
            });
        }

        for (let i = 0; i < slices.length - 1; i++) {
            const s0 = slices[i];
            const s1 = slices[i + 1];

            // Left Sidewalk: outer -> curb top
            this.addQuad(s0.leftSidewalkOuter, s1.leftSidewalkOuter, s1.leftCurbTop, s0.leftCurbTop);

            // Left Curb riser: curb top -> gutter
            this.addQuad(s0.leftCurbTop, s1.leftCurbTop, s1.leftGutter, s0.leftGutter);

            // Left Road lane: gutter -> crown
            this.addQuad(s0.leftGutter, s1.leftGutter, s1.crown, s0.crown);

            // Right Road lane: crown -> gutter
            this.addQuad(s0.crown, s1.crown, s1.rightGutter, s0.rightGutter);

            // Right Curb riser: gutter -> curb top
            this.addQuad(s0.rightGutter, s1.rightGutter, s1.rightCurbTop, s0.rightCurbTop);

            // Right Sidewalk: curb top -> outer
            this.addQuad(s0.rightCurbTop, s1.rightCurbTop, s1.rightSidewalkOuter, s0.rightSidewalkOuter);
        }
    }

    carveFloorplateCavities(
        polygon: Array<[number, number]>,
        yBottom: number,
        yTop: number,
        options: {
            floorCount?: number;
            wallThickness?: number;
            slabThickness?: number;
        } = {}
    ): UniversalSpatialNode[] {
        const floorNodes: UniversalSpatialNode[] = [];
        const floorCount = Math.max(1, options.floorCount ?? 3);
        const wallThickness = Math.max(0.15, options.wallThickness ?? 0.25); // Invariant: wall >= 0.15m
        const slabThickness = options.slabThickness ?? 0.30;
        const totalHeight = yTop - yBottom;
        const floorH = totalHeight / floorCount;

        let minX = Infinity, maxX = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        let cx = 0, cz = 0;
        for (const p of polygon) {
            if (p[0] < minX) minX = p[0];
            if (p[0] > maxX) maxX = p[0];
            if (p[1] < minZ) minZ = p[1];
            if (p[1] > maxZ) maxZ = p[1];
            cx += p[0];
            cz += p[1];
        }
        cx /= polygon.length;
        cz /= polygon.length;

        const interiorW = Math.max(1.0, (maxX - minX) - wallThickness * 2.0);
        const interiorD = Math.max(1.0, (maxZ - minZ) - wallThickness * 2.0);

        for (let k = 0; k < floorCount; k++) {
            const floorBaseY = yBottom + k * floorH;
            const ceilingY = floorBaseY + floorH - slabThickness;
            const cavityCenterY = (floorBaseY + ceilingY) * 0.5;
            const cavityHeight = ceilingY - floorBaseY;

            // Structural concrete floor slab
            this.addBox(cx, floorBaseY + slabThickness * 0.5, cz, interiorW, slabThickness, interiorD);

            // Surface mount planes for interior furnishing anchors
            const floorMount: SurfaceMountPlane = {
                id: `mount_floor_${k + 1}`,
                name: `Level ${k + 1} Floor Anchor`,
                planeType: 'floor',
                planeEquation: [0, 1, 0, -(floorBaseY + slabThickness)],
                normal: [0, 1, 0],
                center: [cx, floorBaseY + slabThickness, cz],
                dimensions: [interiorW, interiorD]
            };

            const ceilingMount: SurfaceMountPlane = {
                id: `mount_ceiling_${k + 1}`,
                name: `Level ${k + 1} Ceiling Anchor`,
                planeType: 'ceiling',
                planeEquation: [0, -1, 0, ceilingY],
                normal: [0, -1, 0],
                center: [cx, ceilingY, cz],
                dimensions: [interiorW, interiorD]
            };

            const floorNode = createSpatialNode({
                id: `node_floor_${k + 1}`,
                name: `Level ${k + 1} Interior Cavity`,
                polarity: 'negative_cavity',
                localBounds: {
                    center: [cx, cavityCenterY, cz],
                    halfExtents: [interiorW * 0.5, cavityHeight * 0.5, interiorD * 0.5]
                },
                mountPlanes: [floorMount, ceilingMount],
                tags: ['interior', 'cavity', `floor_${k + 1}`],
                metadata: {
                    floorIndex: k + 1,
                    elevationBaseMeters: floorBaseY,
                    clearHeightMeters: cavityHeight,
                    wallThicknessMeters: wallThickness
                }
            });

            floorNodes.push(floorNode);
        }

        return floorNodes;
    }
}

/**
 * Builds watertight procedural binary glTF 2.0 geometry for non-amphitheater,
 * non-triumphal-arch typologies (temples, colonnades, rotundas, aqueducts, basilicas).
 */
export function generateProceduralArchiGlb(
    adapter: ArchiTypologyAdapter,
    dimensions: [number, number, number],
    materialProps: { roughness: number; metalness: number; baseColor: string },
    outputGlbPath: string,
    entity?: SpatialArchiEntity
): { glbBuffer: Buffer; vertexCount: number; triangleCount: number } {
    const [dimX, dimY, dimZ] = dimensions;
    const builder = new ProceduralArchiMeshBuilder();

    const w = Math.max(5.0, dimX);
    const h = Math.max(4.0, dimY);
    const d = Math.max(5.0, dimZ);

    switch (adapter.typology) {
        case 'peripteral_temple': {
            // Raised podium / stylobate steps
            const podiumH = h * 0.16;
            builder.addBox(0, podiumH * 0.5, 0, w * 1.06, podiumH, d * 1.06);

            // Peristyle columns around perimeter
            const colH = h * 0.52;
            const colY = podiumH + colH * 0.5;
            const colR = Math.min(w, d) * 0.024;
            const bayX = adapter.typicalBaySpacing;
            const bayZ = adapter.typicalBaySpacing;
            const nX = Math.max(3, Math.floor(w / bayX));
            const nZ = Math.max(5, Math.floor(d / bayZ));

            const halfW = w * 0.44;
            const halfD = d * 0.44;

            // Columns along length (Z sides)
            for (let i = 0; i <= nZ; i++) {
                const zPos = -halfD + (i / nZ) * (halfD * 2);
                builder.addCylinder(-halfW, colY, zPos, colR * 1.15, colR, colH, 12);
                builder.addCylinder(halfW, colY, zPos, colR * 1.15, colR, colH, 12);
            }
            // Columns along ends (X ends)
            for (let i = 1; i < nX; i++) {
                const xPos = -halfW + (i / nX) * (halfW * 2);
                builder.addCylinder(xPos, colY, -halfD, colR * 1.15, colR, colH, 12);
                builder.addCylinder(xPos, colY, halfD, colR * 1.15, colR, colH, 12);
            }

            // Interior Cella
            const cellaW = w * 0.62;
            const cellaD = d * 0.68;
            builder.addBox(0, colY, 0, cellaW, colH, cellaD);

            // Entablature (Architrave & Frieze)
            const entablatureH = h * 0.14;
            const entY = podiumH + colH + entablatureH * 0.5;
            builder.addBox(0, entY, 0, w * 0.96, entablatureH, d * 0.96);

            // Triangular Pediments at front (+Z) and rear (-Z)
            const pedimentH = h * 0.18;
            const pedY = podiumH + colH + entablatureH + pedimentH * 0.5;
            builder.addPediment(0, pedY, halfD, w * 0.96, pedimentH, d * 0.10);
            builder.addPediment(0, pedY, -halfD, w * 0.96, pedimentH, d * 0.10);

            // Gabled pitched roof spanning between pediments
            const roofLen = d * 0.82;
            builder.addPediment(0, pedY, 0, w * 0.94, pedimentH * 0.98, roofLen);
            break;
        }

        case 'rotunda': {
            // Stepped circular stylobate foundation
            const baseH = h * 0.15;
            const baseR = Math.max(w, d) * 0.5;
            builder.addCylinder(0, baseH * 0.5, 0, baseR * 1.08, baseR, baseH, 24);

            // Concentric cylindrical drum / core (e.g. Meta Sudans conical fountain core or Pantheon rotunda)
            const coreH = h * 0.65;
            const coreY = baseH + coreH * 0.5;
            const coreR = baseR * 0.72;
            builder.addCylinder(0, coreY, 0, coreR, coreR * 0.78, coreH, 24);

            // Outer ring of Corinthian columns
            const colH = coreH * 0.92;
            const colY = baseH + colH * 0.5;
            const colR = Math.max(0.3, baseR * 0.035);
            const colRingR = (baseR + coreR) * 0.5;
            const colCount = 16;
            for (let i = 0; i < colCount; i++) {
                const theta = (i / colCount) * Math.PI * 2;
                const cx = colRingR * Math.cos(theta);
                const cz = colRingR * Math.sin(theta);
                builder.addCylinder(cx, colY, cz, colR * 1.1, colR, colH, 12);
            }

            // Upper conical roof / dome with apex spout
            const domeH = h * 0.20;
            const domeY = baseH + coreH + domeH * 0.5;
            builder.addCylinder(0, domeY, 0, coreR * 0.78, baseR * 0.08, domeH, 24);
            break;
        }

        case 'colonnade': {
            // Continuous raised stylobate
            const styloH = h * 0.12;
            builder.addBox(0, styloH * 0.5, 0, w, styloH, d);

            // Two parallel colonnade rows
            const colH = h * 0.72;
            const colY = styloH + colH * 0.5;
            const colR = Math.min(Math.min(w, d) * 0.04, 0.75);
            const spacing = Math.max(colR * 3.5, adapter.typicalBaySpacing);
            const numCols = Math.max(4, Math.floor(w / spacing));
            const rowOffsetZ = d * 0.35;

            for (let i = 0; i <= numCols; i++) {
                const x = -w * 0.45 + (i / numCols) * (w * 0.9);
                builder.addCylinder(x, colY, -rowOffsetZ, colR * 1.1, colR, colH, 12);
                builder.addCylinder(x, colY, rowOffsetZ, colR * 1.1, colR, colH, 12);
            }

            // Spanning entablature & ceiling slab
            const entH = h * 0.16;
            const entY = styloH + colH + entH * 0.5;
            builder.addBox(0, entY, 0, w * 1.02, entH, d * 1.02);
            break;
        }

        case 'aqueduct_arcade': {
            // Massive opus quadratum piers and semicircular arches
            const pierW = w * 0.08;
            const pierD = d * 0.85;
            const baySpacing = Math.max(pierW * 2.5, adapter.typicalBaySpacing);
            const numBays = Math.max(3, Math.floor(w / baySpacing));

            const lowerPierH = h * 0.48;
            const lowerPierY = lowerPierH * 0.5;

            for (let i = 0; i <= numBays; i++) {
                const px = -w * 0.45 + (i / numBays) * (w * 0.9);
                // Lower pier
                builder.addBox(px, lowerPierY, 0, pierW, lowerPierH, pierD);

                // Lower arch connecting to previous pier
                if (i > 0) {
                    const prevX = -w * 0.45 + ((i - 1) / numBays) * (w * 0.9);
                    const archMidX = (px + prevX) * 0.5;
                    const archSpan = Math.abs(px - prevX) - pierW;
                    const rInner = archSpan * 0.5;
                    const rOuter = rInner + h * 0.08;
                    builder.addArch(archMidX, lowerPierH, 0, rOuter, rInner, pierD * 0.95, 12);
                }
            }

            // Intermediate stringcourse beam
            const stringH = h * 0.06;
            const stringY = lowerPierH + (h * 0.08) + stringH * 0.5;
            builder.addBox(0, stringY, 0, w * 0.98, stringH, pierD * 0.98);

            // Upper attic and specus water conduit
            const atticH = h * 0.32;
            const atticY = stringY + stringH * 0.5 + atticH * 0.5;
            builder.addBox(0, atticY, 0, w, atticH, pierD * 0.75);
            break;
        }

        case 'campanile_tower': {
            // Multi-tiered Romanesque campanile bell tower (e.g. Santa Francesca Romana campanile)
            // 5 tiers, marble stringcourses, paired arched bifora windows at the upper levels, pyramid spire
            const baseH = h * 0.22;
            const towerW = Math.min(Math.min(w, d) * 0.85, Math.max(h * 0.28, 7.5));
            const towerD = towerW;

            // 1. Solid lower plinth / Story 1
            builder.addBox(0, baseH * 0.5, 0, towerW, baseH, towerD);

            // Marble stringcourse cornice 1
            const cornH = h * 0.025;
            let currY = baseH;
            builder.addBox(0, currY + cornH * 0.5, 0, towerW * 1.05, cornH, towerD * 1.05);
            currY += cornH;

            // 2. Story 2 & 3: brick shafts with blind arched niches
            const midStoryH = h * 0.18;
            for (let s = 0; s < 2; s++) {
                const storyCenterY = currY + midStoryH * 0.5;
                builder.addBox(0, storyCenterY, 0, towerW * 0.98, midStoryH, towerD * 0.98);
                currY += midStoryH;
                // Stringcourse
                builder.addBox(0, currY + cornH * 0.5, 0, towerW * 1.03, cornH, towerD * 1.03);
                currY += cornH;
            }

            // 3. Story 4 & 5: Belfry tiers with paired arched bifora windows
            const belfryStoryH = h * 0.17;
            const colR = towerW * 0.035;
            for (let s = 0; s < 2; s++) {
                const storyCenterY = currY + belfryStoryH * 0.5;
                // Outer masonry shell
                builder.addBox(0, storyCenterY, 0, towerW * 0.96, belfryStoryH, towerD * 0.96);

                // Center marble column of bifora window on each face
                const belfryColH = belfryStoryH * 0.65;
                const belfryColY = currY + belfryStoryH * 0.45;
                const faceDist = towerD * 0.49;
                // Front (+Z) & Back (-Z)
                builder.addCylinder(0, belfryColY, faceDist, colR, colR, belfryColH, 8);
                builder.addCylinder(0, belfryColY, -faceDist, colR, colR, belfryColH, 8);
                // Left (-X) & Right (+X)
                builder.addCylinder(-faceDist, belfryColY, 0, colR, colR, belfryColH, 8);
                builder.addCylinder(faceDist, belfryColY, 0, colR, colR, belfryColH, 8);

                currY += belfryStoryH;
                // Stringcourse
                builder.addBox(0, currY + cornH * 0.5, 0, towerW * 1.04, cornH, towerD * 1.04);
                currY += cornH;
            }

            // 4. Corbelled roof cornice & 4-sided pyramid spire
            const spireH = Math.max(h * 0.18, h - currY);
            const spireCenterY = currY + spireH * 0.5;
            builder.addPyramid(0, spireCenterY, 0, towerW * 0.98, spireH, towerD * 0.98);
            break;
        }

        case 'basilica_hall': {
            // Monumental central nave and side aisles
            const naveW = w * 0.55;
            const aisleW = (w - naveW) * 0.5;
            const naveH = h * 0.92;
            const aisleH = h * 0.60;

            // Base platform
            const baseH = h * 0.08;
            builder.addBox(0, baseH * 0.5, 0, w * 1.04, baseH, d * 1.04);

            // Side aisles
            builder.addBox(-w * 0.5 + aisleW * 0.5, baseH + aisleH * 0.5, 0, aisleW, aisleH, d);
            builder.addBox(w * 0.5 - aisleW * 0.5, baseH + aisleH * 0.5, 0, aisleW, aisleH, d);

            // Central monumental nave hall
            builder.addBox(0, baseH + naveH * 0.5, 0, naveW, naveH, d);

            // Semicircular apse at end (+Z)
            const apseR = naveW * 0.5;
            builder.addCylinder(0, baseH + naveH * 0.45, d * 0.5, apseR, apseR * 0.95, naveH * 0.9, 16);
            break;
        }

        case 'commercial_skyscraper': {
            const baseH = Math.min(15.0, h * 0.18);
            const shaftH = h * 0.72;

            const footprint = entity?.vectorFootprint ?? [
                [-w * 0.5, -d * 0.5],
                [w * 0.5, -d * 0.5],
                [w * 0.5, d * 0.5],
                [-w * 0.5, d * 0.5]
            ];

            // 1. Street Podium
            builder.addExtrudedPolygon(footprint, 0, baseH, { chamferBaseHeight: 0.6, chamferParapetHeight: 0.8 });

            // 2. Tower Shaft (recessed footprint)
            const shaftFootprint = footprint.map(([x, z]) => [x * 0.82, z * 0.82] as [number, number]);
            builder.addExtrudedPolygon(shaftFootprint, baseH, baseH + shaftH);

            // Facade window reveals on shaft
            for (let i = 0; i < shaftFootprint.length; i++) {
                const p0 = shaftFootprint[i];
                const p1 = shaftFootprint[(i + 1) % shaftFootprint.length];
                builder.addFacadeBaysWithRecessedWindows(p0, p1, baseH, baseH + shaftH, {
                    floorHeight: 3.6,
                    recessDepth: entity?.facadeRevealDepth ?? 0.25
                });
            }

            // 3. Mechanical Penthouse & Spire
            const crownFootprint = shaftFootprint.map(([x, z]) => [x * 0.65, z * 0.65] as [number, number]);
            builder.addExtrudedPolygon(crownFootprint, baseH + shaftH, h, { chamferParapetHeight: 1.2 });
            builder.addCylinder(0, h + 6.0, 0, 0.4, 0.05, 12.0, 8);

            // Solar planes if provided
            if (entity?.solarRoofSegments?.length) {
                builder.addSolarRectifiedRoof(crownFootprint, entity.solarRoofSegments, h);
            }
            break;
        }

        case 'commercial_podium': {
            const footprint = entity?.vectorFootprint ?? [
                [-w * 0.5, -d * 0.5],
                [w * 0.5, -d * 0.5],
                [w * 0.5, d * 0.5],
                [-w * 0.5, d * 0.5]
            ];
            builder.addExtrudedPolygon(footprint, 0, h, { chamferBaseHeight: 0.8, chamferParapetHeight: 1.0 });

            for (let i = 0; i < footprint.length; i++) {
                const p0 = footprint[i];
                const p1 = footprint[(i + 1) % footprint.length];
                builder.addFacadeBaysWithRecessedWindows(p0, p1, 0, h, {
                    floorHeight: 4.2,
                    recessDepth: entity?.facadeRevealDepth ?? 0.30
                });
            }

            if (entity?.solarRoofSegments?.length) {
                builder.addSolarRectifiedRoof(footprint, entity.solarRoofSegments, h);
            }
            break;
        }

        case 'residential_multifamily': {
            const footprint = entity?.vectorFootprint ?? [
                [-w * 0.5, -d * 0.5],
                [w * 0.5, -d * 0.5],
                [w * 0.5, d * 0.5],
                [-w * 0.5, d * 0.5]
            ];
            builder.addExtrudedPolygon(footprint, 0, h, { chamferBaseHeight: 0.4, chamferParapetHeight: 1.1 });

            for (let i = 0; i < footprint.length; i++) {
                const p0 = footprint[i];
                const p1 = footprint[(i + 1) % footprint.length];
                builder.addFacadeBaysWithRecessedWindows(p0, p1, 0, h, {
                    floorHeight: 3.0,
                    recessDepth: entity?.facadeRevealDepth ?? 0.22
                });
            }

            const balconyCount = Math.max(1, Math.floor(h / 3.0) - 1);
            for (let fl = 1; fl <= balconyCount; fl++) {
                const by = fl * 3.0;
                builder.addBox(0, by + 0.15, d * 0.5 + 0.8, w * 0.4, 0.3, 1.6);
            }

            if (entity?.solarRoofSegments?.length) {
                builder.addSolarRectifiedRoof(footprint, entity.solarRoofSegments, h);
            }
            break;
        }

        case 'residential_brownstone': {
            const footprint = entity?.vectorFootprint ?? [
                [-w * 0.5, -d * 0.5],
                [w * 0.5, -d * 0.5],
                [w * 0.5, d * 0.5],
                [-w * 0.5, d * 0.5]
            ];
            const baseH = h * 0.22;
            builder.addExtrudedPolygon(footprint, 0, baseH, { chamferBaseHeight: 0.3 });
            builder.addExtrudedPolygon(footprint, baseH, h, { chamferParapetHeight: 0.9, chamferOffset: 0.35 });

            for (let i = 0; i < footprint.length; i++) {
                const p0 = footprint[i];
                const p1 = footprint[(i + 1) % footprint.length];
                builder.addFacadeBaysWithRecessedWindows(p0, p1, baseH, h, {
                    floorHeight: 3.3,
                    bayWidth: 2.6,
                    recessDepth: entity?.facadeRevealDepth ?? 0.28
                });
            }

            // Entrance stoop stairs
            const stoopSteps = 7;
            const stoopW = w * 0.28;
            for (let st = 0; st < stoopSteps; st++) {
                const sy = (st / stoopSteps) * baseH;
                const sz = d * 0.5 + (1.0 - st / stoopSteps) * 2.2;
                builder.addBox(-w * 0.25, sy + 0.1, sz, stoopW, 0.2, 0.35);
            }

            if (entity?.solarRoofSegments?.length) {
                builder.addSolarRectifiedRoof(footprint, entity.solarRoofSegments, h);
            }
            break;
        }

        case 'industrial_warehouse': {
            const footprint = entity?.vectorFootprint ?? [
                [-w * 0.5, -d * 0.5],
                [w * 0.5, -d * 0.5],
                [w * 0.5, d * 0.5],
                [-w * 0.5, d * 0.5]
            ];
            const eaveH = h * 0.75;
            builder.addExtrudedPolygon(footprint, 0, eaveH, { chamferBaseHeight: 0.4 });

            if (entity?.solarRoofSegments?.length) {
                builder.addSolarRectifiedRoof(footprint, entity.solarRoofSegments, eaveH);
            } else {
                builder.addPediment(0, eaveH + (h - eaveH) * 0.5, 0, w, h - eaveH, d);
            }

            // Loading dock bays
            const dockWidth = 3.6;
            const dockHeight = 4.2;
            const dockCount = Math.max(1, Math.floor(w / 7.0));
            for (let dk = 0; dk < dockCount; dk++) {
                const dxPos = -w * 0.5 + (dk + 1) * (w / (dockCount + 1));
                builder.addBox(dxPos, dockHeight * 0.5, d * 0.5 - 0.2, dockWidth, dockHeight, 0.4);
            }
            break;
        }

        case 'street_corridor': {
            const centerline = entity?.roadCorridor?.centerline ?? [
                [-w * 0.5, 0, 0],
                [w * 0.5, 0, 0]
            ];
            builder.addRoadCorridor(centerline, {
                laneCount: entity?.roadCorridor?.laneCount ?? 2,
                laneWidthMeters: entity?.roadCorridor?.laneWidthMeters ?? 3.5,
                curbHeightMeters: entity?.roadCorridor?.curbHeightMeters ?? 0.15,
                sidewalkWidthMeters: entity?.roadCorridor?.sidewalkWidthMeters ?? 2.5,
                camberSlope: entity?.roadCorridor?.camberSlope ?? 0.02
            });
            break;
        }

        default: {
            // Adaptive Domain Open Volumetric Generator (Alien Planet Test compliant)
            const footprint = entity?.vectorFootprint ?? [
                [-w * 0.5, -d * 0.5],
                [w * 0.5, -d * 0.5],
                [w * 0.5, d * 0.5],
                [-w * 0.5, d * 0.5]
            ];
            builder.addExtrudedPolygon(footprint, 0, h, { chamferBaseHeight: 0.2, chamferParapetHeight: 0.4 });
            if (entity?.solarRoofSegments?.length) {
                builder.addSolarRectifiedRoof(footprint, entity.solarRoofSegments, h);
            }
            break;
        }
    }

    // Binary glTF 2.0 serialization
    const posCount = builder.positions.length / 3;
    const idxCount = builder.indices.length;

    // Compute bounding box
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < builder.positions.length; i += 3) {
        const x = builder.positions[i];
        const y = builder.positions[i + 1];
        const z = builder.positions[i + 2];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
    }

    const posBytes = posCount * 12; // 3 floats * 4 bytes
    const normBytes = posCount * 12;
    const uvBytes = posCount * 8;   // 2 floats * 4 bytes
    const idxBytes = idxCount * 4;  // 1 uint32 * 4 bytes
    const totalBinLength = posBytes + normBytes + uvBytes + idxBytes;

    const binBuffer = Buffer.alloc(totalBinLength);
    let binOffset = 0;

    // 1. Positions
    for (let i = 0; i < builder.positions.length; i++) {
        binBuffer.writeFloatLE(builder.positions[i], binOffset);
        binOffset += 4;
    }

    // 2. Normals
    for (let i = 0; i < builder.normals.length; i++) {
        binBuffer.writeFloatLE(builder.normals[i], binOffset);
        binOffset += 4;
    }

    // 3. UVs
    for (let i = 0; i < builder.uvs.length; i++) {
        binBuffer.writeFloatLE(builder.uvs[i], binOffset);
        binOffset += 4;
    }

    // 4. Indices
    for (let i = 0; i < builder.indices.length; i++) {
        binBuffer.writeUInt32LE(builder.indices[i], binOffset);
        binOffset += 4;
    }

    // Parse base color hex to [r, g, b, 1.0]
    const hex = materialProps.baseColor.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16) / 255.0;
    const g = parseInt(hex.substring(2, 4), 16) / 255.0;
    const b = parseInt(hex.substring(4, 6), 16) / 255.0;

    const gltf = {
        asset: {
            version: '2.0',
            generator: 'Scratchbox SB-Archi Universal Stereotomy Engine'
        },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0, name: `Tectonic_${adapter.typology}` }],
        meshes: [
            {
                name: adapter.commonName,
                primitives: [
                    {
                        attributes: {
                            POSITION: 0,
                            NORMAL: 1,
                            TEXCOORD_0: 2
                        },
                        indices: 3,
                        material: 0
                    }
                ]
            }
        ],
        materials: [
            {
                name: `${adapter.typology}_PBR_Material`,
                pbrMetallicRoughness: {
                    baseColorFactor: [r, g, b, 1.0],
                    roughnessFactor: materialProps.roughness,
                    metallicFactor: materialProps.metalness
                }
            }
        ],
        accessors: [
            {
                bufferView: 0,
                byteOffset: 0,
                componentType: 5126, // FLOAT
                count: posCount,
                type: 'VEC3',
                min: [minX, minY, minZ],
                max: [maxX, maxY, maxZ]
            },
            {
                bufferView: 1,
                byteOffset: 0,
                componentType: 5126, // FLOAT
                count: posCount,
                type: 'VEC3'
            },
            {
                bufferView: 2,
                byteOffset: 0,
                componentType: 5126, // FLOAT
                count: posCount,
                type: 'VEC2'
            },
            {
                bufferView: 3,
                byteOffset: 0,
                componentType: 5125, // UNSIGNED_INT
                count: idxCount,
                type: 'SCALAR'
            }
        ],
        bufferViews: [
            {
                buffer: 0,
                byteOffset: 0,
                byteLength: posBytes,
                target: 34962 // ARRAY_BUFFER
            },
            {
                buffer: 0,
                byteOffset: posBytes,
                byteLength: normBytes,
                target: 34962
            },
            {
                buffer: 0,
                byteOffset: posBytes + normBytes,
                byteLength: uvBytes,
                target: 34962
            },
            {
                buffer: 0,
                byteOffset: posBytes + normBytes + uvBytes,
                byteLength: idxBytes,
                target: 34963 // ELEMENT_ARRAY_BUFFER
            }
        ],
        buffers: [
            {
                byteLength: totalBinLength
            }
        ]
    };

    // Serialize JSON chunk with 4-byte padding
    let jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
    const jsonPadding = (4 - (jsonBuf.length % 4)) % 4;
    if (jsonPadding > 0) {
        jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPadding, 0x20)]);
    }

    // Binary GLB layout: 12 byte header + 8 byte json header + json + 8 byte bin header + bin
    const totalGlbLength = 12 + 8 + jsonBuf.length + 8 + binBuffer.length;
    const finalGlbBuffer = Buffer.alloc(totalGlbLength);

    // GLB Header
    finalGlbBuffer.writeUInt32LE(0x46546C67, 0); // magic 'glTF'
    finalGlbBuffer.writeUInt32LE(2, 4);          // version
    finalGlbBuffer.writeUInt32LE(totalGlbLength, 8);

    // Chunk 0: JSON
    finalGlbBuffer.writeUInt32LE(jsonBuf.length, 12);
    finalGlbBuffer.writeUInt32LE(0x4E4F534A, 16); // 'JSON'
    jsonBuf.copy(finalGlbBuffer, 20);

    // Chunk 1: BIN
    const binHeaderOffset = 20 + jsonBuf.length;
    finalGlbBuffer.writeUInt32LE(binBuffer.length, binHeaderOffset);
    finalGlbBuffer.writeUInt32LE(0x004E4942, binHeaderOffset + 4); // 'BIN\0'
    binBuffer.copy(finalGlbBuffer, binHeaderOffset + 8);

    const outDir = path.dirname(outputGlbPath);
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }
    fs.writeFileSync(outputGlbPath, finalGlbBuffer);

    return {
        glbBuffer: finalGlbBuffer,
        vertexCount: posCount,
        triangleCount: idxCount / 3
    };
}

// ============================================================================
// Universal Architectural Bridge Service Class
// ============================================================================

export class UniversalArchiBridgeService {
    private service: SbArchiService;

    constructor(service?: SbArchiService) {
        this.service = service || new SbArchiService();
    }

    get archiService(): SbArchiService {
        return this.service;
    }

    /**
     * Resolves the closest classical architectural typology adapter from an incoming entity record.
     */
    static resolveTypology(
        categoryQuery?: string,
        nameQuery?: string,
        promptQuery?: string,
        dimensions?: [number, number, number]
    ): ArchiTypologyAdapter {
        const text = `${categoryQuery || ''} ${nameQuery || ''} ${promptQuery || ''}`.toLowerCase();

        // 0. Sacred Curbstones, Cippi & Perimeter Boundary Posts (check before amphitheater since prompts often mention "around the amphitheater")
        if (
            text.includes('curbstone') ||
            text.includes('travertine blocks') ||
            text.includes('cippi') ||
            text.includes('boundary marker') ||
            text.includes('bollard')
        ) {
            return ARCHI_TYPOLOGY_ADAPTERS.colonnade;
        }

        // 1. Amphitheater / Colosseum (check before generic arch/arcade)
        if (
            text.includes('amphitheater') ||
            text.includes('amphitheatrum') ||
            text.includes('colosseum') ||
            text.includes('colosseo') ||
            text.includes('flavian') ||
            text.includes('arena')
        ) {
            return ARCHI_TYPOLOGY_ADAPTERS.amphitheater;
        }

        // 2. Campanile Tower (Romanesque bell tower)
        if (
            text.includes('campanile') ||
            text.includes('bell tower') ||
            text.includes('campanaria') ||
            text.includes('belfry') ||
            text.includes('francesca romana')
        ) {
            return ARCHI_TYPOLOGY_ADAPTERS.campanile_tower;
        }

        // 3. Basilica Hall / Ancient Substructures (check before general emperor names like Constantine)
        if (
            text.includes('basilica') ||
            text.includes('aula') ||
            text.includes('maxentius') ||
            text.includes('nave') ||
            text.includes('groin vault') ||
            text.includes('substructure') ||
            text.includes('retaining') ||
            text.includes('velian') ||
            text.includes('latericium')
        ) {
            return ARCHI_TYPOLOGY_ADAPTERS.basilica_hall;
        }

        // 4. Triumphal Arch Monument
        if (
            /\barch\b/i.test(text) ||
            /\barco\b/i.test(text) ||
            text.includes('arcus') ||
            text.includes('constantine') ||
            text.includes('fornix') ||
            text.includes('titus') ||
            text.includes('triumphal')
        ) {
            return ARCHI_TYPOLOGY_ADAPTERS.triumphal_arch;
        }

        // 5. Rotunda / Circular Temple or Fountain Core
        if (
            text.includes('meta sudans') ||
            text.includes('sudans') ||
            text.includes('rotunda') ||
            text.includes('tholos') ||
            text.includes('pantheon') ||
            text.includes('fountain') ||
            text.includes('circular')
        ) {
            return ARCHI_TYPOLOGY_ADAPTERS.rotunda;
        }

        // 6. Peripteral Temple
        if (
            text.includes('temple') ||
            text.includes('templum') ||
            text.includes('venus') ||
            text.includes('roma') ||
            text.includes('peripteral') ||
            text.includes('parthenon')
        ) {
            return ARCHI_TYPOLOGY_ADAPTERS.peripteral_temple;
        }

        // 7. Colonnade & Sacred Curbstones / Cippi
        if (
            text.includes('colonnade') ||
            text.includes('portico') ||
            text.includes('porticus') ||
            text.includes('stoa') ||
            text.includes('peristyle') ||
            text.includes('curbstone') ||
            text.includes('travertine blocks') ||
            text.includes('cippi')
        ) {
            return ARCHI_TYPOLOGY_ADAPTERS.colonnade;
        }

        // 8. Aqueduct Arcade
        if (
            text.includes('aqueduct') ||
            text.includes('aqua') ||
            text.includes('arcade') ||
            text.includes('pont du gard') ||
            text.includes('specus')
        ) {
            return ARCHI_TYPOLOGY_ADAPTERS.aqueduct_arcade;
        }

        // 9. Street & Transit Corridor (Waymo / HD vector roads)
        if (
            text.includes('street') ||
            text.includes('road') ||
            text.includes('roadway') ||
            text.includes('street corridor') ||
            text.includes('road corridor') ||
            text.includes('transit corridor') ||
            text.includes('highway') ||
            text.includes('boulevard') ||
            text.includes('avenue') ||
            text.includes('waymo')
        ) {
            return ARCHI_TYPOLOGY_ADAPTERS.street_corridor;
        }

        // 10. Commercial Skyscraper
        if (
            text.includes('skyscraper') ||
            text.includes('high rise') ||
            text.includes('high-rise') ||
            text.includes('curtain wall') ||
            text.includes('office tower') ||
            text.includes('commercial tower')
        ) {
            return ARCHI_TYPOLOGY_ADAPTERS.commercial_skyscraper;
        }

        // 11. Commercial Podium
        if (
            text.includes('podium') ||
            text.includes('storefront') ||
            text.includes('retail') ||
            text.includes('commercial block') ||
            text.includes('plaza level')
        ) {
            return ARCHI_TYPOLOGY_ADAPTERS.commercial_podium;
        }

        // 12. Residential Brownstone
        if (
            text.includes('brownstone') ||
            text.includes('townhouse') ||
            text.includes('rowhouse') ||
            text.includes('stoop')
        ) {
            return ARCHI_TYPOLOGY_ADAPTERS.residential_brownstone;
        }

        // 13. Residential Multi-Family
        if (
            text.includes('apartment') ||
            text.includes('multifamily') ||
            text.includes('multi-family') ||
            text.includes('residential') ||
            text.includes('condo') ||
            text.includes('housing')
        ) {
            return ARCHI_TYPOLOGY_ADAPTERS.residential_multifamily;
        }

        // 14. Industrial Warehouse
        if (
            text.includes('warehouse') ||
            text.includes('industrial') ||
            text.includes('logistics') ||
            text.includes('distribution') ||
            text.includes('factory') ||
            text.includes('shed')
        ) {
            return ARCHI_TYPOLOGY_ADAPTERS.industrial_warehouse;
        }

        // Dimensional aspect ratio fallback heuristics
        if (dimensions) {
            const [w, h, d] = dimensions;
            const aspect = (w + d) * 0.5 / Math.max(1.0, h);
            if (aspect < 0.35) {
                return ARCHI_TYPOLOGY_ADAPTERS.campanile_tower;
            }
            if (aspect > 3.5) {
                return ARCHI_TYPOLOGY_ADAPTERS.aqueduct_arcade;
            }
            if (Math.abs(w - d) / Math.max(w, d) < 0.15) {
                return ARCHI_TYPOLOGY_ADAPTERS.rotunda;
            }
        }

        return ARCHI_TYPOLOGY_ADAPTERS.peripteral_temple;
    }

    /**
     * Synthesizes a 1:1 metric watertight architectural replacement for any architectural entity
     * extracted by the Spatial Separator service.
     */
    async synthesizeStructureFromEntity(
        entity: SpatialArchiEntity,
        options: ArchiSynthesisBridgeOptions = {}
    ): Promise<ArchiSynthesisBridgeResult> {
        const startTime = Date.now();

        // 1. Extract physical bounding geometry
        let width = 25.0;
        let height = 21.0;
        let depth = 10.0;
        let centroid: [number, number, number] = [0, 10.5, 0];
        let yawRad = 0.0;

        if (entity.orientedBoundingBox) {
            const obb = entity.orientedBoundingBox;
            width = obb.dimensions[0];
            height = obb.dimensions[1];
            depth = obb.dimensions[2];
            centroid = obb.center;
            yawRad = obb.yawRad ?? 0.0;
        } else if (entity.boundingBox) {
            const bb = entity.boundingBox;
            width = bb.dimensions[0];
            height = bb.dimensions[1];
            depth = bb.dimensions[2];
            centroid = bb.centroid;
        } else if (entity.metricDimensions) {
            width = entity.metricDimensions[0];
            height = entity.metricDimensions[1];
            depth = entity.metricDimensions[2];
            if (entity.metricPositionENU) {
                centroid = [
                    entity.metricPositionENU[0],
                    entity.metricPositionENU[1] + height / 2,
                    entity.metricPositionENU[2]
                ];
            }
        } else if (entity.nominalDimensions && entity.nominalCentroid) {
            width = entity.nominalDimensions[0];
            height = entity.nominalDimensions[1];
            depth = entity.nominalDimensions[2];
            centroid = [entity.nominalCentroid[0], entity.nominalCentroid[1], entity.nominalCentroid[2]];
        }

        const dimensions: [number, number, number] = [width, height, depth];

        // 2. Resolve typology
        let adapter: ArchiTypologyAdapter;
        if (options.typologyOverride) {
            adapter = ARCHI_TYPOLOGY_ADAPTERS[options.typologyOverride] || {
                typology: options.typologyOverride,
                commonName: options.typologyOverride,
                tectonicClass: 'ModernCivic' as TectonicStructureClass,
                framingSystem: 'frame_and_slab',
                typicalBaySpacing: 4.0,
                typicalAspectSpread: 1.0,
                typicalPierWidthRatio: 0.20,
                typicalAshlarHeight: 3.5,
                hasPediment: false,
                hasAttic: false,
                vaultType: 'flat_slab',
                roughness: 0.65,
                metalness: 0.20,
                baseColor: '#5c6470',
                description: `Dynamic typology override: ${options.typologyOverride}`
            };
        } else if (entity.typology && ARCHI_TYPOLOGY_ADAPTERS[entity.typology]) {
            adapter = ARCHI_TYPOLOGY_ADAPTERS[entity.typology];
        } else if (entity.typology) {
            // ADA Open-Domain / Alien Planet Test: dynamically synthesize adapter for novel typology
            adapter = {
                typology: entity.typology,
                commonName: entity.name || `Open-Domain Structure (${entity.typology})`,
                tectonicClass: (entity.category || 'OpenDomainStructure') as TectonicStructureClass,
                framingSystem: entity.framingSystem || 'frame_and_slab',
                typicalBaySpacing: 4.0,
                typicalAspectSpread: 1.0,
                typicalPierWidthRatio: 0.20,
                typicalAshlarHeight: 3.5,
                hasPediment: false,
                hasAttic: false,
                vaultType: 'flat_slab',
                roughness: 0.65,
                metalness: 0.20,
                baseColor: '#5c6470',
                description: `Dynamically synthesized open-domain tectonic structure (${entity.typology}).`
            };
        } else {
            adapter = UniversalArchiBridgeService.resolveTypology(
                entity.category,
                entity.name,
                entity.trellisPrompt,
                dimensions
            );
        }

        // 3. Output Path
        const artifactsDir = path.resolve(process.cwd(), '.scratchbox', 'architectural_structures');
        if (!fs.existsSync(artifactsDir)) {
            fs.mkdirSync(artifactsDir, { recursive: true });
        }
        const outputGlb =
            options.outputGlbPath ||
            path.join(artifactsDir, `${entity.id || 'archi'}_${adapter.typology}.glb`);

        let glbBuffer: Buffer | undefined;
        let outputVertices = 0;
        let outputTriangles = 0;
        let inversionRan = false;
        let detectedDatumsCount = 0;

        // 4. Dispatch based on typology
        if (adapter.typology === 'triumphal_arch') {
            const archRes: ArchConstantineResult = await this.service.buildArchConstantine({
                outputGlbPath: outputGlb
            });
            outputVertices = archRes.report.synthesizedVertices;
            outputTriangles = archRes.report.synthesizedTriangles;
            detectedDatumsCount = archRes.report.detectedDatumsCount;
            if (fs.existsSync(outputGlb)) {
                glbBuffer = fs.readFileSync(outputGlb);
            }
        } else if (adapter.typology === 'amphitheater') {
            const amphRes: SbArchiInversionResult = await this.service.invertColosseumFacade({
                outputGlbPath: outputGlb,
                section: options.section === 'full_ellipse' ? 'full' : 'north_facade',
                pbrMode: options.pbrMode === 'clay' ? 'clay' : 'travertine',
                runInversion: options.runInversionIfScanAvailable !== false
            });
            outputVertices = amphRes.telemetry.synthesizedVertices;
            outputTriangles = amphRes.telemetry.synthesizedTriangles;
            inversionRan = amphRes.telemetry.inversionRan;
            if (fs.existsSync(outputGlb)) {
                glbBuffer = fs.readFileSync(outputGlb);
            }
        } else {
            // Watertight procedural glTF 2.0 stereotomy generation
            const roughness = entity.material?.roughness ?? adapter.roughness;
            const metalness = entity.material?.metalness ?? adapter.metalness;
            const baseColor = entity.material?.baseColor ?? adapter.baseColor;

            const proceduralRes = generateProceduralArchiGlb(
                adapter,
                dimensions,
                { roughness, metalness, baseColor },
                outputGlb,
                entity
            );
            glbBuffer = proceduralRes.glbBuffer;
            outputVertices = proceduralRes.vertexCount;
            outputTriangles = proceduralRes.triangleCount;
        }

        const buildTimeMs = Date.now() - startTime;
        const worldY = centroid[1] - height * 0.5; // ground contact datum
        const worldPosition: [number, number, number] = [centroid[0], worldY, centroid[2]];

        // 5. Construct UniversalSpatialNode hierarchy with negative floor cavities
        const footprint: [number, number][] = entity.vectorFootprint && entity.vectorFootprint.length >= 3
            ? entity.vectorFootprint
            : [
                [-width * 0.5, -depth * 0.5],
                [width * 0.5, -depth * 0.5],
                [width * 0.5, depth * 0.5],
                [-width * 0.5, depth * 0.5]
            ];

        const floorCount = entity.levels ?? Math.max(1, Math.floor(height / 3.5));
        const floorNodes = new ProceduralArchiMeshBuilder().carveFloorplateCavities(
            footprint,
            0,
            height,
            { floorCount, wallThickness: entity.wallThickness ?? 0.25 }
        );

        const rootNode = createSpatialNode({
            id: `spatial_node_${entity.id || 'archi'}`,
            name: entity.name || adapter.commonName,
            polarity: 'positive_mass',
            localBounds: {
                center: [0, height * 0.5, 0],
                halfExtents: [width * 0.5, height * 0.5, depth * 0.5],
                yawRad
            },
            children: floorNodes,
            tags: [adapter.typology, adapter.tectonicClass, 'architectural_mass'],
            metadata: {
                typology: adapter.typology,
                framingSystem: entity.framingSystem || adapter.framingSystem,
                order: adapter.order,
                levels: floorCount,
                hasSolarPlanes: Boolean(entity.solarRoofSegments?.length),
                hasVectorFootprint: Boolean(entity.vectorFootprint?.length),
                hasRoadCorridor: Boolean(entity.roadCorridor)
            }
        });

        return {
            entityId: entity.id,
            typology: adapter.typology,
            tectonicClass: adapter.tectonicClass,
            framingSystem: entity.framingSystem || adapter.framingSystem,
            order: adapter.order,
            worldPosition,
            worldRotationYawRad: yawRad,
            fittedDimensionsMeters: dimensions,
            outputGlbPath: outputGlb,
            glbBuffer,
            glbBase64: glbBuffer ? glbBuffer.toString('base64') : undefined,
            spatialNode: rootNode,
            telemetry: {
                buildTimeMs,
                outputVertices,
                outputTriangles,
                // Welded edges of the written GLB each used by exactly two triangles; false without a GLB to check.
                isManifold: glbBuffer ? measureGlbEdgeManifold(glbBuffer).isManifold : false,
                inversionRan,
                detectedDatumsCount,
                floorCount,
                roofPlaneCount: entity.solarRoofSegments?.length ?? 0,
                hasSolarGrounding: Boolean(entity.solarRoofSegments?.length),
                hasVectorGrounding: Boolean(entity.vectorFootprint?.length)
            }
        };
    }

    /**
     * Inverts a raw photogrammetric scan mesh to its stereotomic classical reconstruction.
     */
    async invertScanToTectonic(
        rawScanGlbPath: string,
        entity: SpatialArchiEntity,
        options: ArchiSynthesisBridgeOptions = {}
    ): Promise<ArchiSynthesisBridgeResult> {
        return this.synthesizeStructureFromEntity(
            {
                ...entity,
                rawScanGlbPath
            },
            {
                ...options,
                runInversionIfScanAvailable: true
            }
        );
    }

    /**
     * Batch synthesizes replacement classical structures from a list of spatial separator entities.
     */
    async batchSynthesizeFromEntities(
        entities: SpatialArchiEntity[],
        options: ArchiSynthesisBridgeOptions = {}
    ): Promise<ArchiSynthesisBridgeResult[]> {
        const results: ArchiSynthesisBridgeResult[] = [];
        for (const entity of entities) {
            const res = await this.synthesizeStructureFromEntity(entity, options);
            results.push(res);
        }
        return results;
    }
}
