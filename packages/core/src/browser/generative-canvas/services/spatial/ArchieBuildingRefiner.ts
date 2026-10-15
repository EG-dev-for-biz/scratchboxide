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
    /** Maximum abs(world-up component) of a normal to treat as vertical facade. Default: 0.38 (steep walls). */
    maxFacadeNormalY?: number;
    /** Depth of extruded grounding plinth in meters. Default: 2.5m. */
    plinthDepth?: number;
    /** Horizontal perimeter collar padding for plinth in meters. Default: 0.3m. */
    plinthPadding?: number;
    /**
     * Ground datum: the world (scene) Y the plinth's top sits at. If omitted, the building's lowest point in world
     * space. A bare geometry has no placement, so its own coordinates are its world.
     */
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

/** The world-up (Y) component of normal `i`, through `normalMatrix` (world space) when given. */
function worldNormalY(normals: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, i: number, normalMatrix: THREE.Matrix3 | undefined, scratch: THREE.Vector3): number {
    scratch.fromBufferAttribute(normals, i);
    if (normalMatrix) scratch.applyMatrix3(normalMatrix).normalize();
    return scratch.y;
}

/**
 * Bilateral Planar Facade Normal Smoothing:
 *
 * Projects normals of steep vertical facade surfaces (|world Ny| < maxFacadeNormalY) strictly into the horizontal
 * world plane while normalizing them. This eliminates photogrammetric scanning ripples and warping artifacts on
 * vertical walls while keeping horizontal roof decks and pitched roofs/cornices undisturbed.
 *
 * "Vertical" and "horizontal" are the scene's (+Y up): with `matrixWorld` (the mesh's world matrix, parent chain
 * included) the normals are taken into world space, smoothed there, and written back in the geometry's own frame,
 * so a Z-up asset under a reorienting parent or a tile mesh in an ECEF-based frame is smoothed as it stands.
 * Without it the geometry's own coordinates are taken as world.
 */
export function smoothFacadeNormals(
    geometry: THREE.BufferGeometry,
    options?: { maxFacadeNormalY?: number; inPlace?: boolean; matrixWorld?: THREE.Matrix4 }
): THREE.BufferGeometry {
    const maxNy = options?.maxFacadeNormalY ?? 0.38;
    const geom = options?.inPlace ? geometry : geometry.clone();

    if (!geom.attributes.normal) {
        geom.computeVertexNormals();
    }

    const normals = geom.attributes.normal;
    // Local -> world for normals is the normal matrix; world -> local is the transpose of the upper 3x3.
    const toWorld = options?.matrixWorld ? new THREE.Matrix3().getNormalMatrix(options.matrixWorld) : undefined;
    const toLocal = options?.matrixWorld ? new THREE.Matrix3().setFromMatrix4(options.matrixWorld).transpose() : undefined;
    const n = new THREE.Vector3();

    for (let i = 0; i < normals.count; i++) {
        if (Math.abs(worldNormalY(normals, i, toWorld, n)) < maxNy) {
            // Project strictly into the horizontal world plane
            const horizLen = Math.hypot(n.x, n.z);
            if (horizLen > 1e-4) {
                n.set(n.x / horizLen, 0.0, n.z / horizLen);
                if (toLocal) n.applyMatrix3(toLocal).normalize();
                normals.setXYZ(i, n.x, n.y, n.z);
            }
        }
    }

    normals.needsUpdate = true;
    return geom;
}

/**
 * Generates a solid, watertight perimeter plinth box beneath the building base.
 * Seals floating building geometry and subterranean photogrammetric voids.
 *
 * The plinth stands on the scene's ground: level in world space (+Y up), under the building's lowest world point (or
 * groundDatumY), covering its world footprint, with its sides along the building's own heading (its local X axis
 * laid flat). With `matrixWorld` (the building mesh's world matrix) the plinth's vertices are written in the
 * building's own frame, so the plinth placed beside the building, with the same transform, stands under it in the
 * scene. Without it the geometry's own coordinates are taken as world. The footprint in metres is in
 * `userData.plinthFootprintMeters`.
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
        /** The building mesh's world matrix (its parent chain included). */
        matrixWorld?: THREE.Matrix4;
    }
): THREE.Mesh {
    if (!options?.material) throw new Error('generateWatertightPlinth needs the plinth material');
    const plinthDepth = options.plinthDepth ?? 2.5;
    const plinthPadding = options.plinthPadding ?? 0.3;
    const positions = geometry.getAttribute('position');
    if (!positions || positions.count === 0) throw new Error('generateWatertightPlinth: the building geometry has no vertices');
    const toWorld = options.matrixWorld ?? new THREE.Matrix4();
    if (Math.abs(toWorld.determinant()) < 1e-12) throw new Error('generateWatertightPlinth: the building\'s world matrix is singular (a zero scale)');

    // The plinth's frame: world up, and the building's local X (else Z) axis laid flat as its heading.
    const up = new THREE.Vector3(0, 1, 0);
    const linear = new THREE.Matrix3().setFromMatrix4(toWorld);
    const heading = new THREE.Vector3(1, 0, 0).applyMatrix3(linear).setY(0);
    if (heading.lengthSq() < 1e-12) heading.set(0, 0, 1).applyMatrix3(linear).setY(0);
    heading.normalize();
    const across = new THREE.Vector3().crossVectors(heading, up).normalize();

    // The building's extent in that frame, in world metres.
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const p = new THREE.Vector3();
    for (let i = 0; i < positions.count; i++) {
        p.fromBufferAttribute(positions, i).applyMatrix4(toWorld);
        const a = p.dot(heading), y = p.y, b = p.dot(across);
        min.set(Math.min(min.x, a), Math.min(min.y, y), Math.min(min.z, b));
        max.set(Math.max(max.x, a), Math.max(max.y, y), Math.max(max.z, b));
    }

    const baseMinY = options.groundDatumY !== undefined ? options.groundDatumY : min.y;

    const plinthW = Math.max(0.5, max.x - min.x + plinthPadding * 2);
    const plinthD = Math.max(0.5, max.z - min.z + plinthPadding * 2);
    const plinthH = Math.max(0.5, plinthDepth);

    // Its top sits 0.1 m into the building base to guarantee zero seam.
    const centre = new THREE.Vector3()
        .addScaledVector(heading, (min.x + max.x) / 2)
        .addScaledVector(up, baseMinY - plinthH * 0.5 + 0.1)
        .addScaledVector(across, (min.z + max.z) / 2);
    const plinthGeom = new THREE.BoxGeometry(plinthW, plinthH, plinthD);
    plinthGeom.applyMatrix4(new THREE.Matrix4().makeBasis(heading, up, across).setPosition(centre));
    if (options.matrixWorld) plinthGeom.applyMatrix4(toWorld.clone().invert());

    const plinthMesh = new THREE.Mesh(plinthGeom, options.material);
    plinthMesh.name = options.name || 'archie_watertight_plinth';
    plinthMesh.userData.plinthFootprintMeters = { width: plinthW, length: plinthD };
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
        // Up is the scene's: the source's world matrix (parent chain included) takes its geometry into world space.
        sourceMesh?.updateWorldMatrix(true, false);
        const matrixWorld = sourceMesh ? sourceMesh.matrixWorld.clone() : undefined;

        const maxNy = options.maxFacadeNormalY ?? 0.38;
        const plinthDepth = options.plinthDepth ?? 2.5;
        const plinthPadding = options.plinthPadding ?? 0.3;
        const namePrefix = options.namePrefix || (sourceMesh?.name || 'building');

        // The materials asked for, checked before any geometry is built: a missing or out-of-range one is an error.
        const buildingMaterial = options.customBuildingMaterial || createArchieMaterial(options.material, 'the building material');
        const plinthMaterial = options.customPlinthMaterial
            || (options.plinthMaterial ? createArchieMaterial(options.plinthMaterial, 'the plinth material') : buildingMaterial);

        // 1. Bilateral planar facade normal smoothing (vertical in world space)
        const smoothedGeom = smoothFacadeNormals(rawGeom, { maxFacadeNormalY: maxNy, matrixWorld });

        // Count smoothed vs preserved vertices for telemetry (world-horizontal normals are facades)
        let smoothedCount = 0;
        let preservedCount = 0;
        const normals = smoothedGeom.getAttribute('normal');
        if (normals) {
            const toWorld = matrixWorld ? new THREE.Matrix3().getNormalMatrix(matrixWorld) : undefined;
            const n = new THREE.Vector3();
            for (let i = 0; i < normals.count; i++) {
                if (Math.abs(worldNormalY(normals, i, toWorld, n)) < 1e-4) {
                    smoothedCount++;
                } else {
                    preservedCount++;
                }
            }
        }

        // 3. Create refined building mesh (in the geometry's own coordinates)
        const refinedMesh = new THREE.Mesh(smoothedGeom, buildingMaterial);
        refinedMesh.name = `archie_refined_${namePrefix}`;

        // 4. Create watertight grounding plinth (level in world space under the building's base, written in the
        //    geometry's own frame)
        const plinthMesh = generateWatertightPlinth(smoothedGeom, {
            plinthDepth,
            plinthPadding,
            groundDatumY: options.groundDatumY,
            material: plinthMaterial,
            name: `archie_plinth_${namePrefix}`,
            matrixWorld
        });

        // 5. Wrap into a group that takes the source mesh's local transform (its matrix, which the world matrix above
        //    was built from), so the building and its plinth stay where the source was once the group replaces it
        //    under the same parent.
        const group = new THREE.Group();
        group.name = `archie_building_group_${namePrefix}`;
        if (sourceMesh) {
            group.matrix.copy(sourceMesh.matrix);
            group.matrix.decompose(group.position, group.quaternion, group.scale);
            group.matrixAutoUpdate = sourceMesh.matrixAutoUpdate;
        }
        group.add(refinedMesh);
        group.add(plinthMesh);

        const posAttr = smoothedGeom.getAttribute('position');
        const vertexCount = posAttr ? posAttr.count : 0;
        const indexAttr = smoothedGeom.getIndex();
        const triangleCount = indexAttr ? indexAttr.count / 3 : vertexCount / 3;

        const footprint = plinthMesh.userData.plinthFootprintMeters as { width: number; length: number };

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
                plinthWidthMeters: footprint.width,
                plinthLengthMeters: footprint.length
            }
        };
    }
}
