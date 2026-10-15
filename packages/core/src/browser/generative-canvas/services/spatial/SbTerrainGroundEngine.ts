/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * SB-Terrain slope-driven ground materials (Universal).
 *
 * Measures each ground mesh's surface slope (mean slope, planarity and steepness ratios, from its normals) and gives
 * it the PBR material the caller's slope ramp assigns to that slope: a list of stops, each a slope in degrees with an
 * sRGB colour, roughness and metalness, interpolated linearly between stops. There are no named surface classes
 * (rock, grass, pavement) or stock colours: the caller (the model) chooses the materials for whatever ground this is,
 * on any planet, and nearby slopes get nearby materials.
 ********************************************************************************/

import * as THREE from 'three';

/** One stop of a slope ramp: at `slopeDeg`, the material is this sRGB colour (0..1), roughness and metalness. */
export interface SlopeMaterialStop {
    slopeDeg: number;
    color: [number, number, number];
    roughness: number;
    metalness: number;
}

/** Continuous slope measurements of a surface, from its vertex normals (+Y up). */
export interface SurfaceSlopeMetrics {
    /** Slope of the mean normal, in degrees (0 = level). */
    meanSlopeDeg: number;
    /** Fraction of normals within ~18 degrees of vertical (Ny >= 0.95). */
    planarityRatio: number;
    /** Fraction of normals steeper than ~41 degrees (Ny < 0.75). */
    steepnessRatio: number;
    vertexCount: number;
}

export interface SlopeMaterialResult {
    meshes: Array<SurfaceSlopeMetrics & {
        name: string;
        material: { color: [number, number, number]; roughness: number; metalness: number };
    }>;
}

/** Measures a mesh's or geometry's surface slope from its normals (computing them when it has none). */
export function measureSurfaceSlope(meshOrGeometry: THREE.Mesh | THREE.BufferGeometry): SurfaceSlopeMetrics {
    const geom = (meshOrGeometry as THREE.Mesh).isMesh
        ? (meshOrGeometry as THREE.Mesh).geometry
        : (meshOrGeometry as THREE.BufferGeometry);
    if (!geom.attributes.normal) {
        geom.computeVertexNormals();
    }
    const normals = geom.attributes.normal;
    if (!normals || normals.count === 0) {
        throw new Error('measureSurfaceSlope: the surface has no vertices to measure');
    }
    let flatCount = 0;
    let steepCount = 0;
    let totalNy = 0;
    for (let i = 0; i < normals.count; i++) {
        const ny = Math.max(-1.0, Math.min(1.0, normals.getY(i)));
        totalNy += ny;
        if (ny >= 0.95) flatCount++;
        else if (ny < 0.75) steepCount++;
    }
    const meanNy = totalNy / normals.count;
    return {
        meanSlopeDeg: Math.acos(Math.max(-1.0, Math.min(1.0, meanNy))) * (180.0 / Math.PI),
        planarityRatio: flatCount / normals.count,
        steepnessRatio: steepCount / normals.count,
        vertexCount: normals.count
    };
}

/** Checks a slope ramp: at least one stop, finite slopes, colours and factors in 0..1. Throws on anything else. */
export function validateSlopeStops(stops: SlopeMaterialStop[] | undefined): SlopeMaterialStop[] {
    const unit = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
    if (!Array.isArray(stops) || stops.length === 0) {
        throw new Error('the slope ramp needs at least one stop { slopeDeg, color: [r, g, b] sRGB 0..1, roughness: 0..1, metalness: 0..1 }');
    }
    stops.forEach((stop, i) => {
        if (!stop || typeof stop.slopeDeg !== 'number' || !Number.isFinite(stop.slopeDeg) || !Array.isArray(stop.color)
            || stop.color.length !== 3 || !stop.color.every(unit) || !unit(stop.roughness) || !unit(stop.metalness)) {
            throw new Error(`slope ramp stop ${i} must be { slopeDeg, color: [r, g, b] sRGB 0..1, roughness: 0..1, metalness: 0..1 } (got ${JSON.stringify(stop)})`);
        }
    });
    return [...stops].sort((a, b) => a.slopeDeg - b.slopeDeg);
}

/** The ramp's material at `slopeDeg`: linear between the stops around it, the end stop's beyond the ends. */
export function materialAtSlope(sortedStops: SlopeMaterialStop[], slopeDeg: number): { color: [number, number, number]; roughness: number; metalness: number } {
    const first = sortedStops[0];
    const last = sortedStops[sortedStops.length - 1];
    const pick = (s: SlopeMaterialStop) => ({ color: [...s.color] as [number, number, number], roughness: s.roughness, metalness: s.metalness });
    if (slopeDeg <= first.slopeDeg) return pick(first);
    if (slopeDeg >= last.slopeDeg) return pick(last);
    for (let i = 0; i + 1 < sortedStops.length; i++) {
        const a = sortedStops[i], b = sortedStops[i + 1];
        if (slopeDeg >= a.slopeDeg && slopeDeg <= b.slopeDeg) {
            const t = b.slopeDeg === a.slopeDeg ? 0 : (slopeDeg - a.slopeDeg) / (b.slopeDeg - a.slopeDeg);
            const lerp = (x: number, y: number) => x + (y - x) * t;
            return {
                color: [lerp(a.color[0], b.color[0]), lerp(a.color[1], b.color[1]), lerp(a.color[2], b.color[2])],
                roughness: lerp(a.roughness, b.roughness),
                metalness: lerp(a.metalness, b.metalness)
            };
        }
    }
    return pick(last);
}

export class SbTerrainGroundEngine {
    /**
     * Gives each mesh the material the slope ramp assigns to its measured mean slope, in place: the meshes keep their
     * place in the scene graph, geometry and transform. The ramp is checked before any mesh changes.
     */
    public applySlopeMaterials(meshes: THREE.Mesh[], options: { stops: SlopeMaterialStop[] }): SlopeMaterialResult {
        const stops = validateSlopeStops(options?.stops);
        const planned = meshes.map(mesh => {
            const metrics = measureSurfaceSlope(mesh);
            return { mesh, metrics, material: materialAtSlope(stops, metrics.meanSlopeDeg) };
        });
        for (const { mesh, material } of planned) {
            mesh.material = new THREE.MeshStandardMaterial({
                color: new THREE.Color().setRGB(material.color[0], material.color[1], material.color[2], THREE.SRGBColorSpace),
                roughness: material.roughness,
                metalness: material.metalness,
                side: THREE.DoubleSide
            });
        }
        return {
            meshes: planned.map(({ mesh, metrics, material }) => ({ name: mesh.name, ...metrics, material }))
        };
    }
}
