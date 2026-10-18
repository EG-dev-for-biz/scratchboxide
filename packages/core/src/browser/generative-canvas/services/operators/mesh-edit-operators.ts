/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import {
    type IOperatorContext,
    type OperatorDefinition,
    computeMeshStatsFromGeometry,
    requireLiveMesh
} from './types';
import { laplacianSmoothGeometry, repairGeometry, subdivideGeometry } from './mesh-topology';
import type { SculptFalloffType } from '../../canvas-types';
import {
    evaluateFalloff,
    recomputeGeometryNormals
} from '../mesh-sculpting-engine';
import {
    ArchieBuildingRefiner,
    type ArchieMaterialParameters
} from '../spatial/ArchieBuildingRefiner';

/**
 * The meshes of the live viewport whose name or id is `targetMeshId`. Throws when no id is given, no viewport is
 * attached, or nothing matches (naming the meshes that are there): an operator that edits scene meshes never picks
 * one by a keyword in its name and never builds a stand-in to edit.
 */
export function findViewportMeshes(threeScene: THREE.Scene | undefined, targetMeshId: string | undefined, operator: string): THREE.Mesh[] {
    if (!targetMeshId) {
        throw new Error(`${operator} needs targetMeshId: the name or id of the mesh in the scene to edit; no mesh is guessed`);
    }
    if (!threeScene) {
        throw new Error(`${operator} edits meshes in the live 3D viewport, and no viewport is attached here`);
    }
    const matches: THREE.Mesh[] = [];
    const names: string[] = [];
    threeScene.traverse(node => {
        if (!(node as THREE.Mesh).isMesh) return;
        if (node.name) names.push(node.name);
        if (String((node as any).id) === String(targetMeshId) || node.name === targetMeshId || node.uuid === targetMeshId) {
            matches.push(node as THREE.Mesh);
        }
    });
    if (matches.length === 0) {
        const listed = names.slice(0, 20).map(n => `'${n}'`).join(', ');
        throw new Error(`${operator}: no mesh named or with id '${targetMeshId}' in the scene${names.length ? ` (meshes: ${listed}${names.length > 20 ? ', ...' : ''})` : ' (it has no named meshes)'}`);
    }
    return matches;
}


/** Shared body of the two subdivision operators: subdivides a copy and swaps it in (undo swaps back). */
function subdivideOperator(ctx: IOperatorContext, params: { objectId: string; iterations?: number }, operator: string, scheme: 'loop' | 'midpoint') {
    const { mesh } = requireLiveMesh(ctx, params.objectId, operator);
    const iterations = Math.floor(params.iterations ?? 1);
    if (!(iterations >= 1 && iterations <= 4)) throw new Error(`${operator}: iterations must be 1 to 4 (each multiplies the triangles by 4).`);
    const before = mesh.geometry.getAttribute('position').count;
    const result = subdivideGeometry(mesh.geometry, iterations, scheme);
    mesh.geometry = result.geometry;
    return {
        objectId: params.objectId,
        iterations,
        scheme,
        vertexCountBefore: before,
        vertexCount: result.vertexCount,
        faceCount: result.faceCount,
        droppedAttributes: result.droppedAttributes
    };
}

export const MESH_EDIT_OPERATORS: OperatorDefinition[] = [
    {
        name: 'sb_subdivide_mesh',
        category: 'mesh_edit',
        description: 'Midpoint-subdivides the live viewport mesh: each triangle splits into four at its edge midpoints, `iterations` times (1-4). The shape is unchanged and uv, color and other attributes are interpolated. Needs the live 3D viewport.',
        execute: (ctx, params: { objectId: string; iterations?: number }) => subdivideOperator(ctx, params, 'sb_subdivide_mesh', 'midpoint')
    },
    {
        name: 'sb_smooth_mesh',
        category: 'mesh_edit',
        description: 'Laplacian-smooths the live viewport mesh: each interior vertex moves `factor` (0..1) of the way to the mean of its neighbours, `iterations` times; open boundary vertices stay put. Needs the live 3D viewport.',
        execute: (ctx, params: { objectId: string; factor?: number; iterations?: number }) => {
            const { mesh } = requireLiveMesh(ctx, params.objectId, 'sb_smooth_mesh');
            const factor = params.factor ?? 0.5;
            const iterations = Math.max(1, Math.floor(params.iterations ?? 1));
            if (!(factor > 0 && factor <= 1)) throw new Error('sb_smooth_mesh: factor must be in (0, 1].');
            const result = laplacianSmoothGeometry(mesh.geometry, factor, iterations);
            recomputeGeometryNormals(mesh.geometry);
            return { objectId: params.objectId, factor, iterations, ...result };
        }
    },
    {
        name: 'sb_deform_vertices',
        category: 'mesh_edit',
        description: 'Deforms vertices within radial sphere along vector using mathematical falloff curve.',
        execute: (ctx, params: { objectId: string; center?: [number, number, number]; strokePoint?: [number, number, number]; radius?: number; direction?: [number, number, number]; strength?: number; falloff?: SculptFalloffType }) => {
            const { mesh } = requireLiveMesh(ctx, params.objectId, 'sb_deform_vertices');

            const centerCoord = params.center || params.strokePoint || [0, 0, 0];
            const center = new THREE.Vector3(centerCoord[0], centerCoord[1], centerCoord[2]);
            const radius = params.radius ?? 2.5;
            const direction = params.direction ? new THREE.Vector3(params.direction[0], params.direction[1], params.direction[2]).normalize() : new THREE.Vector3(0, 1, 0);
            const strength = params.strength || 1.0;
            const falloffType = params.falloff || 'gaussian';

            let affectedVertices = 0;

            {
                const geo = mesh.geometry;
                const posAttr = geo.attributes.position as THREE.BufferAttribute;
                if (posAttr) {
                    const temp = new THREE.Vector3();
                    for (let i = 0; i < posAttr.count; i++) {
                        temp.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
                        const dist = temp.distanceTo(center);
                        if (dist <= radius) {
                            const weight = evaluateFalloff(dist, radius, falloffType);
                            const disp = direction.clone().multiplyScalar(strength * weight);
                            posAttr.setXYZ(i, temp.x + disp.x, temp.y + disp.y, temp.z + disp.z);
                            affectedVertices++;
                        }
                    }
                    posAttr.needsUpdate = true;
                    recomputeGeometryNormals(geo);
                }
            }

            return { objectId: params.objectId, affectedVertices, radius, strength };
        }
    },
    {
        name: 'sb_taper_mesh',
        category: 'mesh_edit',
        description: 'Tapers mesh cross-sections along an axis with linear or power scaling profile.',
        execute: (ctx, params: { objectId: string; axis?: 'x' | 'y' | 'z'; factor: number; minBound?: number; maxBound?: number; power?: number }) => {
            const { mesh } = requireLiveMesh(ctx, params.objectId, 'sb_taper_mesh');

            const axis = params.axis || 'y';
            const factor = params.factor ?? 0.5;
            const power = params.power ?? 1.0;
            let affectedVertices = 0;

            {
                const geo = mesh.geometry;
                geo.computeBoundingBox();
                const bb = geo.boundingBox || new THREE.Box3();
                const minB = params.minBound ?? (axis === 'x' ? bb.min.x : axis === 'y' ? bb.min.y : bb.min.z);
                const maxB = params.maxBound ?? (axis === 'x' ? bb.max.x : axis === 'y' ? bb.max.y : bb.max.z);
                const range = Math.max(1e-5, maxB - minB);

                const posAttr = geo.attributes.position as THREE.BufferAttribute;
                if (posAttr) {
                    for (let i = 0; i < posAttr.count; i++) {
                        const coord = axis === 'x' ? posAttr.getX(i) : axis === 'y' ? posAttr.getY(i) : posAttr.getZ(i);
                        const t = Math.min(1.0, Math.max(0.0, (coord - minB) / range));
                        const s = 1.0 + (factor - 1.0) * Math.pow(t, power);

                        if (axis === 'x') {
                            posAttr.setY(i, posAttr.getY(i) * s);
                            posAttr.setZ(i, posAttr.getZ(i) * s);
                        } else if (axis === 'y') {
                            posAttr.setX(i, posAttr.getX(i) * s);
                            posAttr.setZ(i, posAttr.getZ(i) * s);
                        } else {
                            posAttr.setX(i, posAttr.getX(i) * s);
                            posAttr.setY(i, posAttr.getY(i) * s);
                        }
                        affectedVertices++;
                    }
                    posAttr.needsUpdate = true;
                    recomputeGeometryNormals(geo);
                }
            }

            return { objectId: params.objectId, axis, factor, power, affectedVertices: affectedVertices };
        }
    },
    {
        name: 'sb_twist_mesh',
        category: 'mesh_edit',
        description: 'Twists mesh vertices around an axis with a specified total angle in radians.',
        execute: (ctx, params: { objectId: string; axis?: 'x' | 'y' | 'z'; angle: number; minBound?: number; maxBound?: number }) => {
            const { mesh } = requireLiveMesh(ctx, params.objectId, 'sb_twist_mesh');

            const axis = params.axis || 'y';
            const totalAngle = params.angle ?? Math.PI * 0.5;
            let affectedVertices = 0;

            {
                const geo = mesh.geometry;
                geo.computeBoundingBox();
                const bb = geo.boundingBox || new THREE.Box3();
                const minB = params.minBound ?? (axis === 'x' ? bb.min.x : axis === 'y' ? bb.min.y : bb.min.z);
                const maxB = params.maxBound ?? (axis === 'x' ? bb.max.x : axis === 'y' ? bb.max.y : bb.max.z);
                const range = Math.max(1e-5, maxB - minB);

                const posAttr = geo.attributes.position as THREE.BufferAttribute;
                if (posAttr) {
                    for (let i = 0; i < posAttr.count; i++) {
                        const coord = axis === 'x' ? posAttr.getX(i) : axis === 'y' ? posAttr.getY(i) : posAttr.getZ(i);
                        const t = Math.min(1.0, Math.max(0.0, (coord - minB) / range));
                        const theta = totalAngle * t;
                        const cos = Math.cos(theta);
                        const sin = Math.sin(theta);

                        if (axis === 'x') {
                            const y = posAttr.getY(i);
                            const z = posAttr.getZ(i);
                            posAttr.setY(i, cos * y - sin * z);
                            posAttr.setZ(i, sin * y + cos * z);
                        } else if (axis === 'y') {
                            const x = posAttr.getX(i);
                            const z = posAttr.getZ(i);
                            posAttr.setX(i, cos * x + sin * z);
                            posAttr.setZ(i, -sin * x + cos * z);
                        } else {
                            const x = posAttr.getX(i);
                            const y = posAttr.getY(i);
                            posAttr.setX(i, cos * x - sin * y);
                            posAttr.setY(i, sin * x + cos * y);
                        }
                        affectedVertices++;
                    }
                    posAttr.needsUpdate = true;
                    recomputeGeometryNormals(geo);
                }
            }

            return { objectId: params.objectId, axis, angle: totalAngle, affectedVertices: affectedVertices };
        }
    },
    {
        name: 'sb_bend_mesh',
        category: 'mesh_edit',
        description: 'Conformal cylindrical bend of mesh around an axis preserving arc length.',
        execute: (ctx, params: { objectId: string; mainAxis?: 'x' | 'y' | 'z'; bendAxis?: 'x' | 'y' | 'z'; angle: number; radius: number }) => {
            const { mesh } = requireLiveMesh(ctx, params.objectId, 'sb_bend_mesh');

            const mainAxis = params.mainAxis || 'x';
            const bendAxis = params.bendAxis || 'y';
            const angle = params.angle ?? Math.PI * 0.25;
            const radius = Math.max(1e-4, params.radius ?? 5.0);
            let affectedVertices = 0;

            {
                const geo = mesh.geometry;
                const posAttr = geo.attributes.position as THREE.BufferAttribute;
                if (posAttr) {
                    for (let i = 0; i < posAttr.count; i++) {
                        const mainVal = mainAxis === 'x' ? posAttr.getX(i) : mainAxis === 'y' ? posAttr.getY(i) : posAttr.getZ(i);
                        const bendVal = bendAxis === 'x' ? posAttr.getX(i) : bendAxis === 'y' ? posAttr.getY(i) : posAttr.getZ(i);

                        const theta = (mainVal / radius) * (angle / Math.PI);
                        const r = radius + bendVal;
                        const newMain = r * Math.sin(theta);
                        const newBend = r * Math.cos(theta) - radius;

                        if (mainAxis === 'x') posAttr.setX(i, newMain);
                        else if (mainAxis === 'y') posAttr.setY(i, newMain);
                        else posAttr.setZ(i, newMain);

                        if (bendAxis === 'x') posAttr.setX(i, newBend);
                        else if (bendAxis === 'y') posAttr.setY(i, newBend);
                        else posAttr.setZ(i, newBend);

                        affectedVertices++;
                    }
                    posAttr.needsUpdate = true;
                    recomputeGeometryNormals(geo);
                }
            }

            return { objectId: params.objectId, mainAxis, bendAxis, angle, radius, affectedVertices: affectedVertices };
        }
    },
    {
        name: 'sb_lattice_deform',
        category: 'mesh_edit',
        description: 'Free-Form Deformation (FFD) using 3D trivariate Bernstein control lattice grid.',
        execute: (ctx, params: { objectId: string; dimensions?: [number, number, number]; controlOffsets?: Array<{ index: [number, number, number]; delta: [number, number, number] }> }) => {
            const { mesh } = requireLiveMesh(ctx, params.objectId, 'sb_lattice_deform');

            const dims = params.dimensions || [3, 3, 3];
            const offsets = params.controlOffsets || [];
            let affectedVertices = 0;

            if (offsets.length > 0) {
                const geo = mesh.geometry;
                geo.computeBoundingBox();
                const bb = geo.boundingBox || new THREE.Box3();
                const size = new THREE.Vector3().subVectors(bb.max, bb.min);
                const posAttr = geo.attributes.position as THREE.BufferAttribute;

                if (posAttr && size.x > 1e-5 && size.y > 1e-5 && size.z > 1e-5) {
                    const binomial = (n: number, k: number) => {
                        if (k < 0 || k > n) return 0;
                        if (k === 0 || k === n) return 1;
                        let res = 1;
                        for (let i = 1; i <= k; i++) res = res * (n - (k - i)) / i;
                        return res;
                    };
                    const bernstein = (n: number, i: number, t: number) => {
                        return binomial(n, i) * Math.pow(t, i) * Math.pow(1 - t, n - i);
                    };

                    for (let vIdx = 0; vIdx < posAttr.count; vIdx++) {
                        const u = Math.min(1.0, Math.max(0.0, (posAttr.getX(vIdx) - bb.min.x) / size.x));
                        const v = Math.min(1.0, Math.max(0.0, (posAttr.getY(vIdx) - bb.min.y) / size.y));
                        const w = Math.min(1.0, Math.max(0.0, (posAttr.getZ(vIdx) - bb.min.z) / size.z));

                        let dX = 0, dY = 0, dZ = 0;
                        for (const off of offsets) {
                            const [ci, cj, ck] = off.index;
                            const weight = bernstein(dims[0] - 1, ci, u) * bernstein(dims[1] - 1, cj, v) * bernstein(dims[2] - 1, ck, w);
                            dX += off.delta[0] * weight;
                            dY += off.delta[1] * weight;
                            dZ += off.delta[2] * weight;
                        }

                        posAttr.setXYZ(vIdx, posAttr.getX(vIdx) + dX, posAttr.getY(vIdx) + dY, posAttr.getZ(vIdx) + dZ);
                        affectedVertices++;
                    }
                    posAttr.needsUpdate = true;
                    recomputeGeometryNormals(geo);
                }
            }

            return { objectId: params.objectId, dimensions: dims, controlOffsetsCount: offsets.length, affectedVertices: affectedVertices };
        }
    },
    {
        name: 'sb_sculpt_stroke',
        category: 'mesh_edit',
        description: 'Executes digital sculpting stroke: grab, clay, inflate, flatten, pinch, crease, smooth.',
        execute: (ctx, params: { objectId: string; brush: 'grab' | 'clay' | 'inflate' | 'flatten' | 'pinch' | 'crease' | 'smooth'; center: [number, number, number]; radius: number; strength: number; direction?: [number, number, number]; falloff?: string }) => {
            const { mesh } = requireLiveMesh(ctx, params.objectId, 'sb_sculpt_stroke');

            const brush = params.brush || 'clay';
            const center = new THREE.Vector3(params.center[0], params.center[1], params.center[2]);
            const radius = Math.max(1e-4, params.radius ?? 1.5);
            const strength = params.strength ?? 0.5;
            const dir = params.direction ? new THREE.Vector3(params.direction[0], params.direction[1], params.direction[2]).normalize() : new THREE.Vector3(0, 1, 0);
            const falloffType = (params.falloff || 'smoothstep') as SculptFalloffType;
            let affectedVertices = 0;

            {
                const geo = mesh.geometry;
                const posAttr = geo.attributes.position as THREE.BufferAttribute;
                const normAttr = geo.attributes.normal as THREE.BufferAttribute;

                if (posAttr) {
                    const vPos = new THREE.Vector3();
                    const vNorm = new THREE.Vector3();

                    for (let i = 0; i < posAttr.count; i++) {
                        vPos.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
                        const dist = vPos.distanceTo(center);
                        if (dist <= radius) {
                            const w = evaluateFalloff(dist, radius, falloffType);
                            if (normAttr) vNorm.set(normAttr.getX(i), normAttr.getY(i), normAttr.getZ(i));
                            else vNorm.set(0, 1, 0);

                            if (brush === 'grab') {
                                vPos.addScaledVector(dir, strength * w);
                            } else if (brush === 'clay') {
                                const clayDir = new THREE.Vector3().addVectors(vNorm, dir).normalize();
                                vPos.addScaledVector(clayDir, strength * w * 0.75);
                            } else if (brush === 'inflate') {
                                vPos.addScaledVector(vNorm, strength * w);
                            } else if (brush === 'flatten') {
                                const planeDist = new THREE.Vector3().subVectors(vPos, center).dot(dir);
                                vPos.addScaledVector(dir, -planeDist * strength * w);
                            } else if (brush === 'pinch') {
                                const inward = new THREE.Vector3().subVectors(center, vPos).normalize();
                                vPos.addScaledVector(inward, strength * w);
                            } else if (brush === 'crease') {
                                const inward = new THREE.Vector3().subVectors(center, vPos).normalize();
                                vPos.addScaledVector(inward, strength * w * 0.5);
                                vPos.addScaledVector(vNorm, -strength * w * 0.5);
                            } else if (brush === 'smooth') {
                                vPos.lerp(center, strength * w * 0.2);
                            }

                            posAttr.setXYZ(i, vPos.x, vPos.y, vPos.z);
                            affectedVertices++;
                        }
                    }
                    posAttr.needsUpdate = true;
                    recomputeGeometryNormals(geo);
                }
            }

            return { objectId: params.objectId, brush, radius, strength, affectedVertices: affectedVertices };
        }
    },
    {
        name: 'sb_loop_subdivide',
        category: 'mesh_edit',
        description: 'Loop-subdivides the live viewport mesh (4x triangles per iteration, 1-4 iterations), smoothing the welded surface; uv and color attributes are not carried and are listed in droppedAttributes. Needs the live 3D viewport.',
        execute: (ctx, params: { objectId: string; iterations?: number }) => subdivideOperator(ctx, params, 'sb_loop_subdivide', 'loop')
    },
    {
        name: 'sb_repair_mesh',
        category: 'mesh_edit',
        description: 'Repairs the live viewport mesh: removes faces that collapse when positions within weldEpsilon are welded, removes repeated faces, makes winding consistent (closed surfaces face outward) and recomputes normals. Returns what it changed and the watertight check before and after. Needs the live 3D viewport.',
        execute: (ctx, params: { objectId: string; weldEpsilon?: number; removeDegenerates?: boolean }) => {
            const { mesh } = requireLiveMesh(ctx, params.objectId, 'sb_repair_mesh');
            const weldEpsilon = params.weldEpsilon ?? 1e-4;
            const before = computeMeshStatsFromGeometry(mesh.geometry);
            const geometry = mesh.geometry.clone();
            const result = repairGeometry(geometry, weldEpsilon, params.removeDegenerates !== false);
            recomputeGeometryNormals(geometry);
            mesh.geometry = geometry;
            const after = computeMeshStatsFromGeometry(geometry);
            return {
                objectId: params.objectId,
                weldEpsilon,
                ...result,
                before: { faceCount: before.faceCount, boundaryEdgeCount: before.boundaryEdgeCount, nonManifoldEdgeCount: before.nonManifoldEdgeCount, isWatertight: before.isWatertight },
                after: { faceCount: after.faceCount, boundaryEdgeCount: after.boundaryEdgeCount, nonManifoldEdgeCount: after.nonManifoldEdgeCount, isWatertight: after.isWatertight }
            };
        }
    },
    {
        name: 'sb_reshape_mesh',
        category: 'mesh_edit',
        description: 'Applies explicit deformation operations (taper factor, twist angle, bend angle, bulge factor) along the mesh\'s vertical (Y) extent in the viewport. Each operation gives its own values; nothing is read from prose and nothing is applied by default.',
        execute: (ctx, params: {
            objectId: string;
            prompt?: string;
            operations?: Array<{
                type: 'taper' | 'twist' | 'bend' | 'bulge' | (string & {});
                factor?: number;
                angle?: number;
                [key: string]: any;
            }>;
        }) => {
            // The operations are the caller's: a prompt is kept as a note but never turned into stock magnitudes.
            const ops = Array.isArray(params.operations) ? [...params.operations] : [];
            if (ops.length === 0) {
                throw new Error('sb_reshape_mesh needs operations: give each deformation with its own values (taper factor, twist angle, bend angle, bulge factor).');
            }
            const required: Record<string, 'factor' | 'angle'> = { taper: 'factor', twist: 'angle', bend: 'angle', bulge: 'factor' };
            for (const op of ops) {
                const key = required[op.type];
                if (!key) throw new Error(`sb_reshape_mesh cannot apply "${op.type}" in the viewport (taper, twist, bend, bulge); use the native mesh_apply_deformers tool for others.`);
                if (typeof op[key] !== 'number' || !Number.isFinite(op[key])) throw new Error(`sb_reshape_mesh: ${op.type} needs a number ${key}.`);
            }
            const { mesh } = requireLiveMesh(ctx, params.objectId, 'sb_reshape_mesh');

            let vertexCount = 0;
            {
                const geo = mesh.geometry;
                const pos = geo.attributes.position as THREE.BufferAttribute;
                if (pos) {
                    vertexCount = pos.count;
                    geo.computeBoundingBox();
                    const bbox = geo.boundingBox || new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
                    const minY = bbox.min.y;
                    const maxY = bbox.max.y;
                    const heightY = Math.max(1e-4, maxY - minY);

                    for (const op of ops) {
                        const factor = op.factor as number;
                        if (op.type === 'taper') {
                            for (let i = 0; i < pos.count; i++) {
                                const y = pos.getY(i);
                                const t = Math.max(0, Math.min(1, (y - minY) / heightY));
                                const scale = 1.0 + (factor - 1.0) * t;
                                pos.setX(i, pos.getX(i) * scale);
                                pos.setZ(i, pos.getZ(i) * scale);
                            }
                        } else if (op.type === 'twist') {
                            const angleRad = ((op.angle as number) * Math.PI) / 180;
                            for (let i = 0; i < pos.count; i++) {
                                const y = pos.getY(i);
                                const t = Math.max(0, Math.min(1, (y - minY) / heightY));
                                const theta = angleRad * t;
                                const cosT = Math.cos(theta);
                                const sinT = Math.sin(theta);
                                const x = pos.getX(i);
                                const z = pos.getZ(i);
                                pos.setX(i, x * cosT - z * sinT);
                                pos.setZ(i, x * sinT + z * cosT);
                            }
                        } else if (op.type === 'bulge') {
                            for (let i = 0; i < pos.count; i++) {
                                const y = pos.getY(i);
                                const t = (y - (minY + maxY) * 0.5) / (heightY * 0.5);
                                const envelope = Math.max(0, 1 - t * t);
                                const scale = 1.0 + factor * envelope;
                                pos.setX(i, pos.getX(i) * scale);
                                pos.setZ(i, pos.getZ(i) * scale);
                            }
                        } else if (op.type === 'bend') {
                            const bendAngle = ((op.angle as number) * Math.PI) / 180;
                            for (let i = 0; i < pos.count; i++) {
                                const y = pos.getY(i);
                                const t = Math.max(0, Math.min(1, (y - minY) / heightY));
                                const theta = bendAngle * t;
                                const x = pos.getX(i);
                                pos.setX(i, x + Math.sin(theta) * (heightY * 0.25));
                            }
                        }
                    }
                    pos.needsUpdate = true;
                    recomputeGeometryNormals(geo);
                }
            }

            return {
                objectId: params.objectId,
                appliedOperations: ops,
                vertexCount,
                prompt: params.prompt,
                success: true
            };
        }
    },
    {
        name: 'sb_refine_building_structure',
        category: 'mesh_edit',
        description: 'Refines the scanned building mesh(es) named by targetMeshId in the live viewport: planar facade normal smoothing and a level grounding plinth under the building (both in scene space, +Y up, through the mesh\'s whole parent chain), and the PBR material given as material { color: [r, g, b] sRGB 0..1, roughness 0..1, metalness 0..1 } (required; plinthMaterial is optional and defaults to the same material). Every mesh with that name or id is refined in place, under its own parent with its own transform. Fails when no such mesh is in the scene; it never picks a mesh by name keywords or builds a stand-in.',
        execute: (ctx, params: {
            targetMeshId?: string;
            material?: ArchieMaterialParameters;
            plinthMaterial?: ArchieMaterialParameters;
            plinthDepth?: number;
            plinthPadding?: number;
            maxFacadeNormalY?: number;
            groundDatumY?: number;
        }) => {
            // The buildings are the meshes the caller names in the live viewport; no mesh is guessed from its name
            // and no demo building is built when none is found.
            const targets = findViewportMeshes(ctx.getThreeScene(), params.targetMeshId, 'sb_refine_building_structure');
            const refiner = new ArchieBuildingRefiner();
            // Every target is refined before the scene changes, so a bad material leaves the scene untouched.
            const refined = targets.map(target => ({
                target,
                result: refiner.refineBuilding(target, {
                    material: params.material,
                    plinthMaterial: params.plinthMaterial,
                    plinthDepth: params.plinthDepth ?? 2.5,
                    plinthPadding: params.plinthPadding ?? 0.3,
                    maxFacadeNormalY: params.maxFacadeNormalY ?? 0.38,
                    groundDatumY: params.groundDatumY
                })
            }));
            const threeScene = ctx.getThreeScene()!;
            for (const { target, result } of refined) {
                // The refined group carries the target's local transform: it replaces the target under the same parent.
                const parent = target.parent ?? threeScene;
                parent.add(result.group);
                parent.remove(target);
            }

            return {
                success: true,
                targetMeshId: params.targetMeshId,
                material: params.material,
                refinedCount: refined.length,
                buildings: refined.map(({ result }) => ({
                    refinedMeshName: result.refinedMesh.name,
                    plinthMeshName: result.plinthMesh.name,
                    parentName: result.group.parent?.name,
                    metrics: result.metrics
                }))
            };
        }
    }
];
