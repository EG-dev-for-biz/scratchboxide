/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * What the 3D viewport shows, as one GLB for the Metal path tracer: every visible triangle mesh at its world
 * transform with its own material (instanced meshes written out per instance), and the viewport's furniture left
 * out (grid, gizmos, selection, sky dome, sun disc, god rays, stars, probes). Nothing is made here: the geometry is
 * the scene's own, read as it is drawn. What the tracer cannot take (points, lines, shader materials, splats) is
 * counted, not approximated, and the caller says so.
 *
 * Also the light and camera of the view, in the tracer's terms: the atmospheric sun's direction as elevation and
 * azimuth (the helper's convention: azimuth 0 toward -Z, 90 toward +X), else the neutral studio dome.
 */

import * as THREE from 'three';
import type { PathTraceView } from '../../services/virtual-geometry/path-trace-client';

/** Viewport furniture by the names the viewport gives it: never part of the scene that is traced. */
const FURNITURE_NAMES = new Set([
    'sb-grid-helper', 'sb-selection-helper', 'sb-starfield', 'sb-place-reflection-probe', 'volumetric-god-rays', 'god-rays-emitter',
    'PhysicalSunDisc', 'AtmosphericSkyDome', 'AtmosphericSunGlare', 'sbStepSnapshot'
]);
/** The atmosphere's sun lights (syncAtmosphere / LocationObjectLightingService). */
const SUN_LIGHT_NAMES = new Set(['AtmosphericSunLight', 'LocationSunLight']);
/** Instanced copies written out before the rest are counted as skipped. */
const MAX_INSTANCED_TRIANGLES = 30_000_000;
const MAX_TEXTURE_SIZE = 4096;

export interface PathTraceSnapshotStats {
    meshes: number;
    triangles: number;
    instancesExpanded: number;
    skipped: { points: number; lines: number; shaderMaterials: number; instancesOverCap: number; empty: number };
    exportMs: number;
    bytes: number;
}

export interface PathTraceSnapshot {
    glb: ArrayBuffer;
    stats: PathTraceSnapshotStats;
}

export type PathTraceLighting = { sun: { elevationDeg: number; azimuthDeg: number } } | { studio: Record<string, never> };

function visibleInWorld(o: THREE.Object3D): boolean {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) {
        if (!p.visible || FURNITURE_NAMES.has(p.name)) return false;
    }
    return true;
}

function triangleCount(geometry: THREE.BufferGeometry): number {
    const index = geometry.getIndex();
    const position = geometry.getAttribute('position');
    if (!position) return 0;
    return Math.floor((index ? index.count : position.count) / 3);
}

/** A material the exporter writes as glTF metallic-roughness; shader materials have no glTF reading and are refused. */
function exportMaterial(material: THREE.Material): THREE.Material | null {
    const m = material as THREE.Material & { isShaderMaterial?: boolean; isMeshStandardMaterial?: boolean; isMeshBasicMaterial?: boolean };
    if (m.isShaderMaterial) return null;
    if (m.isMeshStandardMaterial || m.isMeshBasicMaterial) return material;
    // Lambert, Phong, Toon and the like: their colour, map, emission and transparency carried over, rough and non-metal.
    const src = material as THREE.Material & { color?: THREE.Color; map?: THREE.Texture | null; emissive?: THREE.Color; emissiveMap?: THREE.Texture | null; normalMap?: THREE.Texture | null };
    const out = new THREE.MeshStandardMaterial({
        color: src.color ?? new THREE.Color(1, 1, 1),
        map: src.map ?? null,
        emissive: src.emissive ?? new THREE.Color(0, 0, 0),
        emissiveMap: src.emissiveMap ?? null,
        normalMap: src.normalMap ?? null,
        roughness: 0.8,
        metalness: 0,
        transparent: material.transparent,
        opacity: material.opacity,
        side: material.side,
        alphaTest: material.alphaTest
    });
    out.name = material.name;
    return out;
}

/**
 * The visible scene as a binary GLB. `exclude` names further objects the caller draws over the scene (its gizmo
 * group, brush cursor); they and their children are left out.
 */
export async function snapshotSceneForPathTrace(scene: THREE.Scene, exclude: Array<THREE.Object3D | null | undefined> = []): Promise<PathTraceSnapshot> {
    const started = performance.now();
    const excluded = new Set(exclude.filter((o): o is THREE.Object3D => !!o));
    const stats: PathTraceSnapshotStats = {
        meshes: 0, triangles: 0, instancesExpanded: 0,
        skipped: { points: 0, lines: 0, shaderMaterials: 0, instancesOverCap: 0, empty: 0 },
        exportMs: 0, bytes: 0
    };
    scene.updateMatrixWorld(true);
    const root = new THREE.Group();
    root.name = 'sb-path-trace-snapshot';
    const converted = new Map<THREE.Material, THREE.Material | null>();
    const materialFor = (m: THREE.Material): THREE.Material | null => {
        if (!converted.has(m)) converted.set(m, exportMaterial(m));
        return converted.get(m)!;
    };
    const place = (geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], world: THREE.Matrix4, name: string) => {
        const mats = Array.isArray(material) ? material.map(materialFor) : materialFor(material);
        if (Array.isArray(mats) ? mats.some(m => m === null) : mats === null) {
            stats.skipped.shaderMaterials++;
            return;
        }
        const mesh = new THREE.Mesh(geometry, mats as THREE.Material | THREE.Material[]);
        mesh.name = name;
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(world);
        root.add(mesh);
        stats.meshes++;
        stats.triangles += triangleCount(geometry);
    };

    let instancedTriangles = 0;
    const instanceMatrix = new THREE.Matrix4();
    const world = new THREE.Matrix4();
    scene.traverse(o => {
        if (excluded.has(o)) return;
        const obj = o as THREE.Object3D & { isPoints?: boolean; isLine?: boolean; isSprite?: boolean; isMesh?: boolean; isInstancedMesh?: boolean };
        if (!obj.isPoints && !obj.isLine && !obj.isSprite && !obj.isMesh) return;
        let excludedAncestor = false;
        for (let p = o.parent; p; p = p.parent) if (excluded.has(p)) { excludedAncestor = true; break; }
        if (excludedAncestor || !visibleInWorld(o)) return;
        if (obj.isPoints || obj.isSprite) { stats.skipped.points++; return; }
        if (obj.isLine) { stats.skipped.lines++; return; }
        const mesh = o as THREE.Mesh;
        const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
        if (!geometry || triangleCount(geometry) === 0) { stats.skipped.empty++; return; }
        if (obj.isInstancedMesh) {
            const inst = o as THREE.InstancedMesh;
            const tris = triangleCount(geometry);
            for (let i = 0; i < inst.count; i++) {
                if (instancedTriangles + tris > MAX_INSTANCED_TRIANGLES) { stats.skipped.instancesOverCap += inst.count - i; break; }
                inst.getMatrixAt(i, instanceMatrix);
                world.multiplyMatrices(inst.matrixWorld, instanceMatrix);
                place(geometry, inst.material, world, `${inst.name || 'instanced'}#${i}`);
                instancedTriangles += tris;
                stats.instancesExpanded++;
            }
            return;
        }
        place(geometry, mesh.material, mesh.matrixWorld, mesh.name);
    });

    const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
    // Colour maps of opaque materials go as JPEG (far smaller and quicker to encode); the rest stay PNG.
    const jpegMarked: THREE.Texture[] = [];
    for (const m of converted.values()) {
        const map = (m as THREE.MeshStandardMaterial | null)?.map;
        if (m && map && !m.transparent && m.alphaTest === 0 && map.userData.mimeType === undefined) {
            map.userData.mimeType = 'image/jpeg';
            jpegMarked.push(map);
        }
    }
    try {
        const glb = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true, maxTextureSize: MAX_TEXTURE_SIZE }) as ArrayBuffer;
        stats.exportMs = performance.now() - started;
        stats.bytes = glb.byteLength;
        return { glb, stats };
    } finally {
        for (const t of jpegMarked) delete t.userData.mimeType;
        for (const [src, out] of converted) if (out && out !== src) out.dispose();
    }
}

/** The atmospheric sun when one lights the scene from above the horizon, else the neutral studio dome. */
export function pathTraceLightingOf(scene: THREE.Scene): PathTraceLighting {
    let best: THREE.DirectionalLight | null = null;
    scene.traverse(o => {
        const l = o as THREE.DirectionalLight;
        if (!l.isDirectionalLight || !SUN_LIGHT_NAMES.has(l.name) || !visibleInWorld(l) || l.intensity <= 0) return;
        if (!best || l.intensity > best.intensity) best = l;
    });
    const sun = best as THREE.DirectionalLight | null;
    if (!sun) return { studio: {} };
    const from = new THREE.Vector3().setFromMatrixPosition(sun.matrixWorld);
    const to = new THREE.Vector3().setFromMatrixPosition(sun.target.matrixWorld);
    const d = from.sub(to);
    if (d.lengthSq() === 0) return { studio: {} };
    d.normalize();
    if (d.y <= 0) return { studio: {} };
    const elevationDeg = THREE.MathUtils.radToDeg(Math.asin(d.y));
    let azimuthDeg = THREE.MathUtils.radToDeg(Math.atan2(d.x, -d.z));
    if (azimuthDeg < 0) azimuthDeg += 360;
    return { sun: { elevationDeg, azimuthDeg } };
}

/** The viewport camera in the traced file's coordinates (the snapshot's world, less the file's origin). */
export function pathTraceViewOf(camera: THREE.PerspectiveCamera, origin: [number, number, number]): PathTraceView {
    camera.updateMatrixWorld();
    const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const forward = new THREE.Vector3(0, 0, -1).transformDirection(camera.matrixWorld);
    const up = new THREE.Vector3(0, 1, 0).transformDirection(camera.matrixWorld);
    const target = eye.clone().add(forward);
    const fovYDeg = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / (camera.zoom || 1)));
    const round = (v: number) => Math.round(v * 1e5) / 1e5;
    return {
        eye: [round(eye.x - origin[0]), round(eye.y - origin[1]), round(eye.z - origin[2])],
        target: [round(target.x - origin[0]), round(target.y - origin[1]), round(target.z - origin[2])],
        up: [round(up.x), round(up.y), round(up.z)],
        fovYDeg: round(fovYDeg)
    };
}
