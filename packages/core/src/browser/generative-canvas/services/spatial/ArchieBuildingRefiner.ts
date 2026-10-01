/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Archie Authentic Building Structure Refinement Engine (Universal).
 *
 * Instead of replacing buildings with coarse box/cone approximations,
 * Archie takes authentic scanned photogrammetric building geometry directly
 * and refines it with:
 * 1. Bilateral planar facade normal smoothing (eliminating photogrammetry sensor
 *    wrinkles on vertical walls while preserving roofs & architectural cornices).
 * 2. Watertight grounding plinths (extruding solid perimeter bases below ground
 *    datum to seal open cavities and floating building geometry).
 * 3. Photoreal architectural PBR materials across canonical global archetypes
 *    (Roman ochre, Travertine limestone, Imperial brick, Metro bronze/granite).
 ********************************************************************************/

import * as THREE from 'three';

export type ArchieBuildingPalette =
    | 'roman_ochre'
    | 'roman_ochre_deep'
    | 'limestone'
    | 'imperial_brick'
    | 'metro_bronze'
    | 'granite';

export interface ArchieBuildingRefineOptions {
    /** Maximum abs(Ny) to treat as vertical facade. Default: 0.38 (steep walls). */
    maxFacadeNormalY?: number;
    /** Depth of extruded grounding plinth in meters. Default: 2.5m. */
    plinthDepth?: number;
    /** Horizontal perimeter collar padding for plinth in meters. Default: 0.3m. */
    plinthPadding?: number;
    /** Ground datum level Y in meters. If omitted, uses building bbox min.y. */
    groundDatumY?: number;
    /** Material palette style. Default: 'roman_ochre'. */
    palette?: ArchieBuildingPalette;
    /** Custom PBR material override for building body. */
    customBuildingMaterial?: THREE.Material;
    /** Custom PBR material override for foundation plinth. */
    customPlinthMaterial?: THREE.Material;
    /** Name prefix for the generated meshes. */
    namePrefix?: string;
}

export interface ArchieRefinedBuildingResult {
    /** Root group containing refined building mesh and grounding plinth. */
    group: THREE.Group;
    /** Refined building mesh with smoothed facade normals and assigned PBR material. */
    refinedMesh: THREE.Mesh;
    /** Solid grounding plinth mesh sealing the foundation base. */
    plinthMesh: THREE.Mesh;
    /** Geometric and refinement telemetry metrics. */
    metrics: {
        vertexCount: number;
        triangleCount: number;
        facadeVerticesSmoothed: number;
        preservedRoofVertices: number;
        plinthDepthMeters: number;
        plinthWidthMeters: number;
        plinthLengthMeters: number;
    };
}

/** Pre-configured architectural PBR material presets */
export const ARCHIE_BUILDING_PALETTES: Record<ArchieBuildingPalette, {
    color: number;
    roughness: number;
    metalness: number;
    name: string;
}> = {
    roman_ochre: {
        color: 0xc47e45,
        roughness: 0.85,
        metalness: 0.02,
        name: 'Roman Terracotta Ochre'
    },
    roman_ochre_deep: {
        color: 0xba693a,
        roughness: 0.86,
        metalness: 0.02,
        name: 'Deep Roman Ochre'
    },
    limestone: {
        color: 0xeae5db,
        roughness: 0.82,
        metalness: 0.03,
        name: 'Travertine / Indiana Limestone'
    },
    imperial_brick: {
        color: 0xa75a38,
        roughness: 0.90,
        metalness: 0.03,
        name: 'Roman Imperial Brick'
    },
    metro_bronze: {
        color: 0x2b303a,
        roughness: 0.50,
        metalness: 0.65,
        name: 'Patinated Metro Bronze / Architectural Metal'
    },
    granite: {
        color: 0x33363a,
        roughness: 0.78,
        metalness: 0.05,
        name: 'Charcoal Granite'
    }
};

/**
 * Bilateral Planar Facade Normal Smoothing:
 *
 * Projects normals of steep vertical facade surfaces (|Ny| < maxFacadeNormalY) strictly
 * into the horizontal (X, Z) plane while normalizing them.
 * This completely eliminates photogrammetric scanning ripples and warping artifacts
 * on vertical walls while keeping horizontal roof decks (|Ny| >= 0.70) and pitched
 * roofs/cornices undisturbed.
 */
export function smoothFacadeNormals(
    geometry: THREE.BufferGeometry,
    options?: { maxFacadeNormalY?: number; inPlace?: boolean }
): THREE.BufferGeometry {
    const maxNy = options?.maxFacadeNormalY ?? 0.38;
    const geom = options?.inPlace ? geometry : geometry.clone();

    if (!geom.attributes.normal) {
        geom.computeVertexNormals();
    }

    const normals = geom.attributes.normal.array as Float32Array;
    const count = normals.length / 3;

    for (let i = 0; i < count; i++) {
        const idx = i * 3;
        const nx = normals[idx];
        const ny = normals[idx + 1];
        const nz = normals[idx + 2];

        if (Math.abs(ny) < maxNy) {
            // Project strictly into horizontal XZ plane
            const horizLen = Math.hypot(nx, nz);
            if (horizLen > 1e-4) {
                normals[idx] = nx / horizLen;
                normals[idx + 1] = 0.0;
                normals[idx + 2] = nz / horizLen;
            }
        }
    }

    geom.attributes.normal.needsUpdate = true;
    return geom;
}

/**
 * Generates a solid, watertight perimeter plinth box beneath the building base.
 * Seals floating building geometry and subterranean photogrammetric voids.
 */
export function generateWatertightPlinth(
    geometry: THREE.BufferGeometry,
    options?: {
        plinthDepth?: number;
        plinthPadding?: number;
        groundDatumY?: number;
        material?: THREE.Material;
        name?: string;
    }
): THREE.Mesh {
    const plinthDepth = options?.plinthDepth ?? 2.5;
    const plinthPadding = options?.plinthPadding ?? 0.3;

    if (!geometry.boundingBox) {
        geometry.computeBoundingBox();
    }
    const bbox = geometry.boundingBox || new THREE.Box3();
    const size = new THREE.Vector3();
    bbox.getSize(size);
    const center = new THREE.Vector3();
    bbox.getCenter(center);

    const baseMinY = options?.groundDatumY !== undefined ? options.groundDatumY : bbox.min.y;

    const plinthW = Math.max(0.5, size.x + plinthPadding * 2);
    const plinthD = Math.max(0.5, size.z + plinthPadding * 2);
    const plinthH = Math.max(0.5, plinthDepth);

    const plinthGeom = new THREE.BoxGeometry(plinthW, plinthH, plinthD);
    const plinthMaterial = options?.material || new THREE.MeshStandardMaterial({
        color: ARCHIE_BUILDING_PALETTES.limestone.color,
        roughness: ARCHIE_BUILDING_PALETTES.limestone.roughness,
        metalness: ARCHIE_BUILDING_PALETTES.limestone.metalness,
        side: THREE.DoubleSide
    });

    const plinthMesh = new THREE.Mesh(plinthGeom, plinthMaterial);
    plinthMesh.name = options?.name || 'archie_watertight_plinth';

    // Position plinth so its top aligns slightly into the building base to guarantee zero seam
    const plinthCenterY = baseMinY - plinthH * 0.5 + 0.1;
    plinthMesh.position.set(center.x, plinthCenterY, center.z);

    return plinthMesh;
}

/**
 * Universal Archie Building Refiner Service.
 */
export class ArchieBuildingRefiner {
    /**
     * Takes an authentic scanned building mesh or geometry and refines it with
     * bilateral planar facade normal smoothing, watertight grounding plinth, and
     * architectural PBR material properties.
     */
    public refineBuilding(
        meshOrGeometry: THREE.Mesh | THREE.BufferGeometry,
        options: ArchieBuildingRefineOptions = {}
    ): ArchieRefinedBuildingResult {
        const isMesh = (meshOrGeometry as THREE.Mesh).isMesh;
        const sourceMesh = isMesh ? (meshOrGeometry as THREE.Mesh) : null;
        const rawGeom = isMesh ? (meshOrGeometry as THREE.Mesh).geometry : (meshOrGeometry as THREE.BufferGeometry);

        const maxNy = options.maxFacadeNormalY ?? 0.38;
        const plinthDepth = options.plinthDepth ?? 2.5;
        const plinthPadding = options.plinthPadding ?? 0.3;
        const paletteKey = options.palette || 'roman_ochre';
        const namePrefix = options.namePrefix || (sourceMesh?.name || 'building');

        // 1. Bilateral planar facade normal smoothing
        const smoothedGeom = smoothFacadeNormals(rawGeom, { maxFacadeNormalY: maxNy });

        // Count smoothed vs preserved vertices for telemetry
        let smoothedCount = 0;
        let preservedCount = 0;
        const normals = smoothedGeom.getAttribute('normal');
        if (normals) {
            for (let i = 0; i < normals.count; i++) {
                if (Math.abs(normals.getY(i)) < 1e-4) {
                    smoothedCount++;
                } else {
                    preservedCount++;
                }
            }
        }

        // 2. Resolve PBR Materials
        const paletteDef = ARCHIE_BUILDING_PALETTES[paletteKey] || ARCHIE_BUILDING_PALETTES.roman_ochre;
        const buildingMaterial = options.customBuildingMaterial || new THREE.MeshStandardMaterial({
            color: paletteDef.color,
            roughness: paletteDef.roughness,
            metalness: paletteDef.metalness,
            side: THREE.DoubleSide
        });

        const plinthMaterial = options.customPlinthMaterial || new THREE.MeshStandardMaterial({
            color: ARCHIE_BUILDING_PALETTES.limestone.color,
            roughness: ARCHIE_BUILDING_PALETTES.limestone.roughness,
            metalness: ARCHIE_BUILDING_PALETTES.limestone.metalness,
            side: THREE.DoubleSide
        });

        // 3. Create refined building mesh
        const refinedMesh = new THREE.Mesh(smoothedGeom, buildingMaterial);
        refinedMesh.name = `archie_refined_${namePrefix}`;
        if (sourceMesh) {
            refinedMesh.position.copy(sourceMesh.position);
            refinedMesh.quaternion.copy(sourceMesh.quaternion);
            refinedMesh.scale.copy(sourceMesh.scale);
        }

        // 4. Create watertight grounding plinth
        const plinthMesh = generateWatertightPlinth(smoothedGeom, {
            plinthDepth,
            plinthPadding,
            groundDatumY: options.groundDatumY,
            material: plinthMaterial,
            name: `archie_plinth_${namePrefix}`
        });
        if (sourceMesh) {
            plinthMesh.position.add(sourceMesh.position);
        }

        // 5. Wrap into cohesive group
        const group = new THREE.Group();
        group.name = `archie_building_group_${namePrefix}`;
        group.add(refinedMesh);
        group.add(plinthMesh);

        const posAttr = smoothedGeom.getAttribute('position');
        const vertexCount = posAttr ? posAttr.count : 0;
        const indexAttr = smoothedGeom.getIndex();
        const triangleCount = indexAttr ? indexAttr.count / 3 : vertexCount / 3;

        const plinthBbox = new THREE.Box3().setFromObject(plinthMesh);
        const plinthSize = new THREE.Vector3();
        plinthBbox.getSize(plinthSize);

        return {
            group,
            refinedMesh,
            plinthMesh,
            metrics: {
                vertexCount,
                triangleCount,
                facadeVerticesSmoothed: smoothedCount,
                preservedRoofVertices: preservedCount,
                plinthDepthMeters: plinthDepth,
                plinthWidthMeters: plinthSize.x,
                plinthLengthMeters: plinthSize.z
            }
        };
    }
}
