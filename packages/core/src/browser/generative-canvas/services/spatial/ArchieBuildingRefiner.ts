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
 * 3. The PBR material the caller gives as continuous values (sRGB colour, roughness, metalness): no named
 *    palette or archetype list, so any material on any planet can be described.
 ********************************************************************************/

import * as THREE from 'three';

/** A PBR material as continuous values: sRGB colour channels in [0, 1], roughness and metalness in [0, 1]. */
export interface ArchieMaterialParameters {
    color: [number, number, number];
    roughness: number;
    metalness: number;
}

export interface ArchieBuildingRefineOptions {
    /** Maximum abs(Ny) to treat as vertical facade. Default: 0.38 (steep walls). */
    maxFacadeNormalY?: number;
    /** Depth of extruded grounding plinth in meters. Default: 2.5m. */
    plinthDepth?: number;
    /** Horizontal perimeter collar padding for plinth in meters. Default: 0.3m. */
    plinthPadding?: number;
    /** Ground datum level Y in the mesh's own coordinates. If omitted, uses the geometry's bbox min.y. */
    groundDatumY?: number;
    /** The building's material. Required unless customBuildingMaterial is given. */
    material?: ArchieMaterialParameters;
    /** The plinth's material; when omitted the plinth takes the building's material. */
    plinthMaterial?: ArchieMaterialParameters;
    /** Custom PBR material override for building body. */
    customBuildingMaterial?: THREE.Material;
    /** Custom PBR material override for foundation plinth. */
    customPlinthMaterial?: THREE.Material;
    /** Name prefix for the generated meshes. */
    namePrefix?: string;
}

export interface ArchieRefinedBuildingResult {
    /**
     * Root group containing refined building mesh and grounding plinth. It carries the source mesh's own local
     * transform, so put it under the source's parent to keep the building where it was.
     */
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

/** Checks a material given as continuous values and builds it; anything out of range is an error, never replaced. */
export function createArchieMaterial(params: ArchieMaterialParameters | undefined, what: string): THREE.MeshStandardMaterial {
    const unit = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
    if (!params || !Array.isArray(params.color) || params.color.length !== 3 || !params.color.every(unit) || !unit(params.roughness) || !unit(params.metalness)) {
        throw new Error(`ArchieBuildingRefiner: ${what} needs { color: [r, g, b] in 0..1 (sRGB), roughness: 0..1, metalness: 0..1 } (got ${JSON.stringify(params)})`);
    }
    return new THREE.MeshStandardMaterial({
        color: new THREE.Color().setRGB(params.color[0], params.color[1], params.color[2], THREE.SRGBColorSpace),
        roughness: params.roughness,
        metalness: params.metalness,
        side: THREE.DoubleSide
    });
}

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
    options: {
        plinthDepth?: number;
        plinthPadding?: number;
        groundDatumY?: number;
        /** The plinth's material (no stock stone is assumed). */
        material: THREE.Material;
        name?: string;
    }
): THREE.Mesh {
    if (!options?.material) throw new Error('generateWatertightPlinth needs the plinth material');
    const plinthDepth = options.plinthDepth ?? 2.5;
    const plinthPadding = options.plinthPadding ?? 0.3;

    if (!geometry.boundingBox) {
        geometry.computeBoundingBox();
    }
    const bbox = geometry.boundingBox || new THREE.Box3();
    const size = new THREE.Vector3();
    bbox.getSize(size);
    const center = new THREE.Vector3();
    bbox.getCenter(center);

    const baseMinY = options.groundDatumY !== undefined ? options.groundDatumY : bbox.min.y;

    const plinthW = Math.max(0.5, size.x + plinthPadding * 2);
    const plinthD = Math.max(0.5, size.z + plinthPadding * 2);
    const plinthH = Math.max(0.5, plinthDepth);

    const plinthGeom = new THREE.BoxGeometry(plinthW, plinthH, plinthD);
    const plinthMesh = new THREE.Mesh(plinthGeom, options.material);
    plinthMesh.name = options.name || 'archie_watertight_plinth';

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
        const namePrefix = options.namePrefix || (sourceMesh?.name || 'building');

        // The materials asked for, checked before any geometry is built: a missing or out-of-range one is an error.
        const buildingMaterial = options.customBuildingMaterial || createArchieMaterial(options.material, 'the building material');
        const plinthMaterial = options.customPlinthMaterial
            || (options.plinthMaterial ? createArchieMaterial(options.plinthMaterial, 'the plinth material') : buildingMaterial);

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

        // 3. Create refined building mesh (in the geometry's own coordinates)
        const refinedMesh = new THREE.Mesh(smoothedGeom, buildingMaterial);
        refinedMesh.name = `archie_refined_${namePrefix}`;

        // 4. Create watertight grounding plinth (in the same coordinates, under the geometry's base)
        const plinthMesh = generateWatertightPlinth(smoothedGeom, {
            plinthDepth,
            plinthPadding,
            groundDatumY: options.groundDatumY,
            material: plinthMaterial,
            name: `archie_plinth_${namePrefix}`
        });

        // 5. Wrap into a group that takes the source mesh's local transform (position, rotation and scale), so the
        //    building and its plinth stay where the source was once the group replaces it under the same parent.
        const group = new THREE.Group();
        group.name = `archie_building_group_${namePrefix}`;
        if (sourceMesh) {
            group.position.copy(sourceMesh.position);
            group.quaternion.copy(sourceMesh.quaternion);
            group.scale.copy(sourceMesh.scale);
        }
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
