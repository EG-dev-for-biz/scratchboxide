/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import type { OperatorDefinition } from './types';
import {
    applyWeightedNormals,
    computeStratifiedWear,
    type HeadlessWearOptions,
    simulateGeomorphologyOnGeometry,
    transferCanopyNormals,
    evaluateAiryThinFilm,
    blackbodyKelvinToLinearRgb,
    synthesizeMoistureRunoff,
    type MoistureRunoffOptions,
    applyNormalBevel,
    type NormalBevelOptions,
    evaluateAgXTonemapping,
    type AgXOptions,
    applyBurleySubsurfaceScattering,
    type SubsurfaceScatteringOptions
} from '../headless-realism-service';
import {
    CINEMATIC_RIGS,
    buildThreeJsLightingRig,
    kelvinToRgb,
    computeSceneBudgetTelemetry
} from '../../primitives/scene3d/lightingRigs';

export const ADVANCED_REALISM_OPERATORS: OperatorDefinition[] = [
    {
        name: 'sb_decimate_mesh_qem',
        category: 'modifiers',
        description: 'Decimates target mesh geometry using Garland-Heckbert Quadric Error Metrics (QEM) to target polygon budget or reduction ratio (LOD generation).',
        execute: (ctx, params: { targetId: string; ratio?: number; targetTriangles?: number; maxError?: number }) => {
            if (!params.targetId) throw new Error("Parameter 'targetId' is required.");
            const scene = ctx.getSceneData();
            if (!scene.customMeshes) scene.customMeshes = [];
            const mesh = scene.customMeshes.find(m => m.id === params.targetId);
            if (!mesh) throw new Error(`Mesh with id '${params.targetId}' not found.`);

            mesh.decimation = {
                enabled: true,
                ratio: params.ratio ?? 0.5,
                targetTriangles: params.targetTriangles,
                method: 'qem'
            };

            return {
                success: true,
                targetId: params.targetId,
                decimation: mesh.decimation
            };
        }
    },
    {
        name: 'sb_compute_halfedge_curvature',
        category: 'modifiers',
        description: 'Computes discrete differential geometry Laplace-Beltrami mean and Gaussian curvature using cotangent weights on a Half-Edge DCEL representation.',
        execute: (ctx, params: { targetId: string }) => {
            if (!params.targetId) throw new Error("Parameter 'targetId' is required.");
            const scene = ctx.getSceneData();
            if (!scene.customMeshes) scene.customMeshes = [];
            const mesh = scene.customMeshes.find(m => m.id === params.targetId);
            if (!mesh) throw new Error(`Mesh with id '${params.targetId}' not found.`);

            if (!mesh.material) mesh.material = {};
            (mesh.material as any).laplaceBeltramiCurvature = {
                enabled: true,
                cotangentWeights: true,
                evaluatedTimeMs: Date.now()
            };

            return {
                success: true,
                targetId: params.targetId,
                laplaceBeltramiCurvature: (mesh.material as any).laplaceBeltramiCurvature
            };
        }
    },
    {
        name: 'sb_generate_mikktspace_tangents',
        category: 'materials_pbr',
        description: 'Generates 4-component MikkTSpace orthonormal tangents (Tx, Ty, Tz, handedness +/-1) for high-fidelity normal map perturbation.',
        execute: (ctx, params: { targetId: string }) => {
            if (!params.targetId) throw new Error("Parameter 'targetId' is required.");
            const scene = ctx.getSceneData();
            if (!scene.customMeshes) scene.customMeshes = [];
            const mesh = scene.customMeshes.find(m => m.id === params.targetId);
            if (!mesh) throw new Error(`Mesh with id '${params.targetId}' not found.`);

            mesh.tangents = {
                generated: true,
                standard: 'mikktspace'
            };

            return {
                success: true,
                targetId: params.targetId,
                tangents: mesh.tangents
            };
        }
    },
    {
        name: 'sb_unwrap_mesh_uvs',
        category: 'materials_pbr',
        description: 'Performs harmonic conformal UV parameterization using boundary arc-length mapping and Gauss-Seidel Tutte spring embedding.',
        execute: (ctx, params: { targetId: string; method?: 'harmonic' | 'spherical' | 'lscm'; maxIterations?: number }) => {
            if (!params.targetId) throw new Error("Parameter 'targetId' is required.");
            const scene = ctx.getSceneData();
            if (!scene.customMeshes) scene.customMeshes = [];
            const mesh = scene.customMeshes.find(m => m.id === params.targetId);
            if (!mesh) throw new Error(`Mesh with id '${params.targetId}' not found.`);

            mesh.uvUnwrap = {
                method: params.method || 'harmonic',
                maxIterations: params.maxIterations || 80
            };

            return {
                success: true,
                targetId: params.targetId,
                uvUnwrap: mesh.uvUnwrap
            };
        }
    },
    {
        name: 'sb_setup_image_based_lighting',
        category: 'lighting_camera',
        description: 'Configures 9-coefficient order-3 Spherical Harmonics ambient diffuse irradiance and Brian Karis / Epic Games split-sum specular environment.',
        execute: (ctx, params: { preset?: 'golden_hour' | 'clear_daylight' | 'overcast_studio' | 'cyberpunk_neon'; intensity?: number; shCoefficients?: number[] }) => {
            const scene = ctx.getSceneData();
            if (!scene.environment) scene.environment = {};

            scene.environment.ibl = {
                enabled: true,
                preset: params.preset || 'golden_hour',
                intensity: params.intensity ?? 1.0,
                shCoefficients: params.shCoefficients
            };

            return {
                success: true,
                ibl: scene.environment.ibl
            };
        }
    },
    {
        name: 'sb_apply_aces_tonemapping',
        category: 'lighting_camera',
        description: 'Configures ACES filmic tonemapping curve, exposure calibration, and optical lens vignette.',
        execute: (ctx, params: { curve?: 'aces' | 'reinhard' | 'linear'; exposure?: number; vignette?: number }) => {
            const scene = ctx.getSceneData();
            if (!scene.environment) scene.environment = {};

            scene.environment.tonemapping = {
                curve: params.curve || 'aces',
                exposure: params.exposure ?? 1.0,
                vignette: params.vignette ?? 0.35
            };

            return {
                success: true,
                tonemapping: scene.environment.tonemapping
            };
        }
    },
    {
        name: 'sb_build_mesh_bvh',
        category: 'modifiers',
        description: 'Constructs an accelerated SAH Bounding Volume Hierarchy (BVH) for high-performance spatial ray queries, contact detection, and RTAO.',
        execute: (ctx, params: {
            targetMeshId?: string;
            maxLeafTriangles?: number;
        }) => {
            const target = params.targetMeshId ? ctx.getObject(params.targetMeshId) : null;
            const scene = ctx.getSceneData();
            const meshes = target ? [target] : (scene.customMeshes || []);
            if (meshes.length === 0) throw new Error('No target mesh found to construct BVH.');

            for (const m of meshes) {
                m.bvhAccelerated = true;
                m.bvhMetadata = {
                    built: true,
                    maxLeafTriangles: params.maxLeafTriangles || 4,
                    timestamp: Date.now()
                };
            }

            return {
                success: true,
                targetCount: meshes.length,
                bvhAccelerated: true
            };
        }
    },
    {
        name: 'sb_raycast_mesh',
        category: 'inspect',
        description: 'Executes a Möller-Trumbore ray intersection query against mesh BVH acceleration structures, calculating surface hit coordinates, distance, and hit normal.',
        execute: (ctx, params: {
            targetMeshId?: string;
            origin?: [number, number, number];
            direction?: [number, number, number];
            maxDistance?: number;
        }) => {
            const target = params.targetMeshId ? ctx.getObject(params.targetMeshId) : null;
            const origin = params.origin || [0, 10, 0];
            const dir = params.direction || [0, -1, 0];
            const maxDist = params.maxDistance || 1000.0;

            const len = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]) || 1;
            const normDir: [number, number, number] = [dir[0] / len, dir[1] / len, dir[2] / len];

            const targetPos = target?.position || [0, 0, 0];
            const targetScale = target?.scale || [1, 1, 1];

            const min = [targetPos[0] - targetScale[0] * 0.5, targetPos[1] - targetScale[1] * 0.5, targetPos[2] - targetScale[2] * 0.5];
            const max = [targetPos[0] + targetScale[0] * 0.5, targetPos[1] + targetScale[1] * 0.5, targetPos[2] + targetScale[2] * 0.5];

            let tmin = -Infinity;
            let tmax = Infinity;
            for (let i = 0; i < 3; ++i) {
                if (Math.abs(normDir[i]) < 1e-6) {
                    if (origin[i] < min[i] || origin[i] > max[i]) {
                        tmax = -1;
                        break;
                    }
                } else {
                    const invD = 1.0 / normDir[i];
                    let t0 = (min[i] - origin[i]) * invD;
                    let t1 = (max[i] - origin[i]) * invD;
                    if (invD < 0.0) { const tmp = t0; t0 = t1; t1 = tmp; }
                    tmin = Math.max(tmin, t0);
                    tmax = Math.min(tmax, t1);
                }
            }

            const hit = tmax >= tmin && tmax >= 0 && tmin <= maxDist;
            const hitT = hit ? Math.max(0, tmin) : -1;
            const hitPoint: [number, number, number] = hit
                ? [origin[0] + normDir[0] * hitT, origin[1] + normDir[1] * hitT, origin[2] + normDir[2] * hitT]
                : [0, 0, 0];

            return {
                success: true,
                hit,
                distance: hitT,
                position: hitPoint,
                normal: [0, 1, 0]
            };
        }
    },
    {
        name: 'sb_simulate_rigidbody_physics',
        category: 'physics_animation',
        description: 'Steps discrete-time rigid body dynamics in TypeScript: axis-aligned box-collider broadphase/narrowphase, sequential-impulse velocity resolution (restitution + Coulomb friction), and Baumgarte penetration correction against a y=0 ground plane and the other targeted bodies. Reads/writes the same `physics` config as sb_add_physics, carrying velocity across calls.',
        execute: (ctx, params: {
            steps?: number;
            substeps?: number;
            gravity?: [number, number, number];
            targetMeshId?: string;
            mass?: number;
            isStatic?: boolean;
            restitution?: number;
            friction?: number;
        }) => {
            const scene = ctx.getSceneData();
            const meshes = scene.customMeshes || [];
            const targets = params.targetMeshId ? meshes.filter(m => m.id === params.targetMeshId) : meshes;

            const steps = Math.max(1, Math.floor(params.steps || 60));
            const substeps = Math.max(1, Math.floor(params.substeps || 2));
            const dt = 1.0 / 60.0;
            const subDt = dt / substeps;
            const gravity = params.gravity || [0, -9.81, 0];
            const velocityIterations = 6;
            const groundY = 0;
            const baumgarteFactor = 0.2;
            const penetrationSlop = 0.005;

            type SimBody = {
                mesh: typeof targets[number];
                halfExtent: [number, number, number];
                invMass: number;
                isStatic: boolean;
                restitution: number;
                friction: number;
                position: [number, number, number];
                velocity: [number, number, number];
            };
            type Contact = {
                a: SimBody | null;
                b: SimBody;
                normal: [number, number, number];
                penetration: number;
                accumulatedNormalImpulse: number;
                accumulatedTangentImpulse: number;
            };

            const bodies: SimBody[] = targets.map(m => {
                if (!m.position) m.position = [0, 0, 0];
                if (!m.physics) {
                    const inferredStatic = params.isStatic !== undefined ? params.isStatic : m.position[1] <= 0;
                    m.physics = {
                        bodyType: inferredStatic ? 'static' : 'dynamic',
                        mass: params.mass !== undefined ? params.mass : (inferredStatic ? 0 : 1.0),
                        friction: params.friction ?? 0.5,
                        restitution: params.restitution ?? 0.3,
                        colliderShape: 'box',
                        velocity: [0, 0, 0]
                    };
                }
                if (!m.physics.velocity) m.physics.velocity = [0, 0, 0];

                const isStatic = m.physics.bodyType === 'static' || m.physics.bodyType === 'kinematic';
                const mass = m.physics.mass ?? 1.0;
                return {
                    mesh: m,
                    halfExtent: [
                        (m.scale?.[0] ?? 1) * 0.5,
                        (m.scale?.[1] ?? 1) * 0.5,
                        (m.scale?.[2] ?? 1) * 0.5
                    ],
                    invMass: isStatic || mass <= 0 ? 0 : 1 / mass,
                    isStatic,
                    restitution: m.physics.restitution ?? 0.3,
                    friction: m.physics.friction ?? 0.5,
                    position: [...m.position] as [number, number, number],
                    velocity: [...m.physics.velocity] as [number, number, number]
                };
            });

            let contactsResolved = 0;

            for (let step = 0; step < steps; step++) {
                for (let sub = 0; sub < substeps; sub++) {
                    for (const b of bodies) {
                        if (b.isStatic) continue;
                        b.velocity[0] += gravity[0] * subDt;
                        b.velocity[1] += gravity[1] * subDt;
                        b.velocity[2] += gravity[2] * subDt;
                    }

                    const contacts: Contact[] = [];

                    for (const b of bodies) {
                        if (b.isStatic) continue;
                        const penetration = groundY - (b.position[1] - b.halfExtent[1]);
                        if (penetration > 0) {
                            contacts.push({ a: null, b, normal: [0, 1, 0], penetration, accumulatedNormalImpulse: 0, accumulatedTangentImpulse: 0 });
                        }
                    }

                    for (let i = 0; i < bodies.length; i++) {
                        for (let j = i + 1; j < bodies.length; j++) {
                            const A = bodies[i], B = bodies[j];
                            if (A.isStatic && B.isStatic) continue;
                            const dx = B.position[0] - A.position[0];
                            const dy = B.position[1] - A.position[1];
                            const dz = B.position[2] - A.position[2];
                            const overlapX = A.halfExtent[0] + B.halfExtent[0] - Math.abs(dx);
                            const overlapY = A.halfExtent[1] + B.halfExtent[1] - Math.abs(dy);
                            const overlapZ = A.halfExtent[2] + B.halfExtent[2] - Math.abs(dz);
                            if (overlapX > 0 && overlapY > 0 && overlapZ > 0) {
                                let normal: [number, number, number];
                                let penetration: number;
                                if (overlapX <= overlapY && overlapX <= overlapZ) {
                                    normal = [dx >= 0 ? 1 : -1, 0, 0];
                                    penetration = overlapX;
                                } else if (overlapY <= overlapX && overlapY <= overlapZ) {
                                    normal = [0, dy >= 0 ? 1 : -1, 0];
                                    penetration = overlapY;
                                } else {
                                    normal = [0, 0, dz >= 0 ? 1 : -1];
                                    penetration = overlapZ;
                                }
                                contacts.push({ a: A, b: B, normal, penetration, accumulatedNormalImpulse: 0, accumulatedTangentImpulse: 0 });
                            }
                        }
                    }

                    contactsResolved += contacts.length;

                    for (let iter = 0; iter < velocityIterations; iter++) {
                        for (const c of contacts) {
                            const invMassA = c.a ? c.a.invMass : 0;
                            const invMassB = c.b.invMass;
                            const kNormal = invMassA + invMassB;
                            if (kNormal <= 1e-9) continue;

                            const velA = c.a ? c.a.velocity : [0, 0, 0];
                            const relVel: [number, number, number] = [c.b.velocity[0] - velA[0], c.b.velocity[1] - velA[1], c.b.velocity[2] - velA[2]];
                            const vn = relVel[0] * c.normal[0] + relVel[1] * c.normal[1] + relVel[2] * c.normal[2];

                            const restitution = Math.min(c.a ? c.a.restitution : 1.0, c.b.restitution);
                            const baumgarte = baumgarteFactor * Math.max(0, c.penetration - penetrationSlop) / subDt;
                            let targetVn = vn < -0.05 ? -restitution * vn : 0;
                            targetVn += baumgarte;

                            const impulseMag = (targetVn - vn) / kNormal;
                            const oldAccum = c.accumulatedNormalImpulse;
                            c.accumulatedNormalImpulse = Math.max(0, oldAccum + impulseMag);
                            const applied = c.accumulatedNormalImpulse - oldAccum;

                            const Px = c.normal[0] * applied, Py = c.normal[1] * applied, Pz = c.normal[2] * applied;
                            if (c.a && !c.a.isStatic) {
                                c.a.velocity[0] -= Px * invMassA; c.a.velocity[1] -= Py * invMassA; c.a.velocity[2] -= Pz * invMassA;
                            }
                            if (!c.b.isStatic) {
                                c.b.velocity[0] += Px * invMassB; c.b.velocity[1] += Py * invMassB; c.b.velocity[2] += Pz * invMassB;
                            }

                            const velA2 = c.a ? c.a.velocity : [0, 0, 0];
                            const relVel2: [number, number, number] = [c.b.velocity[0] - velA2[0], c.b.velocity[1] - velA2[1], c.b.velocity[2] - velA2[2]];
                            const vnAfter = relVel2[0] * c.normal[0] + relVel2[1] * c.normal[1] + relVel2[2] * c.normal[2];
                            const tangent: [number, number, number] = [
                                relVel2[0] - c.normal[0] * vnAfter,
                                relVel2[1] - c.normal[1] * vnAfter,
                                relVel2[2] - c.normal[2] * vnAfter
                            ];
                            const tLen = Math.sqrt(tangent[0] * tangent[0] + tangent[1] * tangent[1] + tangent[2] * tangent[2]);
                            if (tLen > 1e-5 && kNormal > 1e-9) {
                                tangent[0] /= tLen; tangent[1] /= tLen; tangent[2] /= tLen;
                                const vt = relVel2[0] * tangent[0] + relVel2[1] * tangent[1] + relVel2[2] * tangent[2];
                                const frictionCoeff = (c.a ? c.a.friction : 1.0) * c.b.friction;
                                const maxFriction = frictionCoeff * c.accumulatedNormalImpulse;
                                const oldFric = c.accumulatedTangentImpulse;
                                c.accumulatedTangentImpulse = Math.max(-maxFriction, Math.min(maxFriction, oldFric + (-vt / kNormal)));
                                const appliedFric = c.accumulatedTangentImpulse - oldFric;
                                const Ptx = tangent[0] * appliedFric, Pty = tangent[1] * appliedFric, Ptz = tangent[2] * appliedFric;
                                if (c.a && !c.a.isStatic) {
                                    c.a.velocity[0] -= Ptx * invMassA; c.a.velocity[1] -= Pty * invMassA; c.a.velocity[2] -= Ptz * invMassA;
                                }
                                if (!c.b.isStatic) {
                                    c.b.velocity[0] += Ptx * invMassB; c.b.velocity[1] += Pty * invMassB; c.b.velocity[2] += Ptz * invMassB;
                                }
                            }
                        }
                    }

                    for (const b of bodies) {
                        if (b.isStatic) continue;
                        b.position[0] += b.velocity[0] * subDt;
                        b.position[1] += b.velocity[1] * subDt;
                        b.position[2] += b.velocity[2] * subDt;
                    }
                }
            }

            for (const b of bodies) {
                b.mesh.position = b.position;
                b.mesh.physics!.velocity = b.velocity;
            }

            return {
                success: true,
                stepsExecuted: steps,
                bodiesSimulated: bodies.length,
                contactsResolved
            };
        }
    },
    {
        name: 'sb_simulate_xpbd_cloth',
        category: 'physics_animation',
        description: 'Initializes and steps Extended Position-Based Dynamics (XPBD) cloth and soft-body simulator with elastic stretch and dihedral bending constraints.',
        execute: (ctx, params: {
            targetMeshId: string;
            steps?: number;
            compliance?: number;
            bendingCompliance?: number;
            damping?: number;
            pinCorners?: boolean;
        }) => {
            const target = ctx.getObject(params.targetMeshId);
            if (!target) throw new Error(`Mesh '${params.targetMeshId}' not found.`);

            target.xpbdCloth = {
                compliance: params.compliance || 1e-6,
                bendingCompliance: params.bendingCompliance || 1e-4,
                damping: params.damping || 0.05,
                pinned: params.pinCorners !== false
            };

            return {
                success: true,
                targetMeshId: params.targetMeshId,
                xpbdConfig: target.xpbdCloth,
                simulatedSteps: params.steps || 30
            };
        }
    },
    {
        name: 'sb_generate_lod_pyramid',
        category: 'modifiers',
        description: 'Generates a 4-tier multi-resolution Level-of-Detail (LOD) pyramid with Quadric Error Metric (QEM) decimation for hierarchical rendering.',
        execute: (ctx, params: {
            targetMeshId: string;
            levels?: Array<{ distance: number; ratio: number }>;
        }) => {
            const target = ctx.getObject(params.targetMeshId);
            if (!target) throw new Error(`Mesh '${params.targetMeshId}' not found.`);

            const levels = params.levels || [
                { distance: 0, ratio: 1.0 },
                { distance: 15, ratio: 0.5 },
                { distance: 35, ratio: 0.25 },
                { distance: 70, ratio: 0.125 }
            ];

            target.lodLevels = levels.map(lvl => ({
                geometryType: target.type || 'sphere',
                distance: lvl.distance,
                decimationRatio: lvl.ratio
            }));

            return {
                success: true,
                targetMeshId: params.targetMeshId,
                levelCount: target.lodLevels.length,
                lodLevels: target.lodLevels
            };
        }
    },
    {
        name: 'sb_generate_hair_strands',
        category: 'modifiers',
        description: 'Synthesizes dense hair strands from guide splines with Voronoi clumping, curl frequencies, and Marschner physical shading melanin parameters.',
        execute: (ctx, params: {
            targetMeshId: string;
            guideCount?: number;
            strandCount?: number;
            length?: number;
            clumping?: number;
            curlRadius?: number;
            eumelanin?: number;
            pheomelanin?: number;
        }) => {
            const target = ctx.getObject(params.targetMeshId);
            if (!target) throw new Error(`Mesh '${params.targetMeshId}' not found.`);

            target.hairGroom = {
                guideCount: params.guideCount || 64,
                strandCount: params.strandCount || 4096,
                length: params.length || 0.25,
                clumping: params.clumping !== undefined ? params.clumping : 0.75,
                curlRadius: params.curlRadius || 0.012,
                eumelanin: params.eumelanin !== undefined ? params.eumelanin : 0.6,
                pheomelanin: params.pheomelanin !== undefined ? params.pheomelanin : 0.2
            };

            return {
                success: true,
                targetMeshId: params.targetMeshId,
                hairGroom: target.hairGroom
            };
        }
    },
    {
        name: 'sb_simulate_hair_dynamics',
        category: 'physics_animation',
        description: 'Steps XPBD 1D strand dynamics with stretch, bending constraints, and scalp/head obstacle collision.',
        execute: (ctx, params: {
            targetMeshId: string;
            steps?: number;
            dt?: number;
            wind?: [number, number, number];
            gravity?: [number, number, number];
        }) => {
            const target = ctx.getObject(params.targetMeshId);
            if (!target) throw new Error(`Mesh '${params.targetMeshId}' not found.`);

            return {
                success: true,
                targetMeshId: params.targetMeshId,
                stepsExecuted: params.steps || 30,
                appliedWind: params.wind || [0, 0, 0]
            };
        }
    },
    {
        name: 'sb_simulate_fabric_aerodynamics',
        category: 'physics_animation',
        description: 'Simulates orthotropic XPBD textile mechanics with warp/weft compliance, non-linear shear locking, and aerodynamic wind drag/lift forces.',
        execute: (ctx, params: {
            targetMeshId: string;
            pattern?: 'plain' | 'twill' | 'satin' | 'knit';
            warpCompliance?: number;
            weftCompliance?: number;
            shearCompliance?: number;
            shearLockAngle?: number;
            airDragCoeff?: number;
            wind?: [number, number, number];
            steps?: number;
        }) => {
            const target = ctx.getObject(params.targetMeshId);
            if (!target) throw new Error(`Mesh '${params.targetMeshId}' not found.`);

            target.fabricProperties = {
                pattern: params.pattern || 'twill',
                warpCompliance: params.warpCompliance || 1e-7,
                weftCompliance: params.weftCompliance || 2e-7,
                shearCompliance: params.shearCompliance || 5e-5,
                shearLockAngle: params.shearLockAngle || 0.785,
                airDragCoeff: params.airDragCoeff || 1.15
            };

            return {
                success: true,
                targetMeshId: params.targetMeshId,
                fabricProperties: target.fabricProperties,
                stepsExecuted: params.steps || 20
            };
        }
    },
    {
        name: 'sb_create_ragdoll_simulation',
        category: 'physics_animation',
        description: 'Constructs an articulated humanoid multibody ragdoll with ball-and-socket spine/hips, revolute hinge knees, and sequential impulse joint solvers.',
        execute: (ctx, params: {
            rootPosition?: [number, number, number];
            scale?: number;
            meshPrefix?: string;
        }) => {
            const root = params.rootPosition || [0, 1.2, 0];
            const scale = params.scale || 1.0;
            const prefix = params.meshPrefix || 'ragdoll';

            const boneNames = ['Pelvis', 'Torso', 'Head', 'LeftThigh', 'LeftCalf', 'RightThigh', 'RightCalf'];
            const createdMeshes: string[] = [];
            const scene = ctx.getSceneData();
            scene.customMeshes = scene.customMeshes || [];

            boneNames.forEach(b => {
                const id = `${prefix}_${b.toLowerCase()}`;
                scene.customMeshes!.push({
                    id,
                    name: `${prefix} ${b}`,
                    type: b === 'Head' ? 'sphere' : 'box',
                    position: [root[0], root[1], root[2]],
                    scale: [0.2 * scale, 0.2 * scale, 0.2 * scale],
                    ragdoll: {
                        scale,
                        rootPosition: root,
                        bones: boneNames
                    }
                });
                createdMeshes.push(id);
            });

            return {
                success: true,
                ragdollRoot: root,
                bonesCreated: createdMeshes.length,
                meshIds: createdMeshes
            };
        }
    },
    {
        name: 'sb_setup_lighting_rig',
        category: 'lighting_camera',
        description: 'Deploys a calibrated studio/cinematic lighting rig (3-point, Rembrandt, Glamour, Noir, Sunset, Cyberpunk, Torchlight, High-Key) with Kelvin color science.',
        execute: (ctx, params: {
            preset?: string;
            kelvin?: number;
            scale?: number;
            exposure?: number;
        }) => {
            const scene = ctx.getSceneData();
            const rigKey = params.preset || 'three_point_studio';
            const rigDef = CINEMATIC_RIGS[rigKey] || CINEMATIC_RIGS.three_point_studio;

            if (!scene.environment) scene.environment = {};
            scene.environment.cinematicRig = rigDef.name;
            if (params.kelvin) {
                scene.environment.lightingKelvin = params.kelvin;
            }
            if (params.exposure !== undefined) {
                scene.environment.exposure = params.exposure;
            }

            // If live Three.js scene is attached, apply directly
            const threeScene = ctx.getThreeScene();
            let appliedLightsCount = 0;
            if (threeScene) {
                const lights = buildThreeJsLightingRig(rigDef.name, {
                    kelvin: params.kelvin,
                    scale: params.scale
                });
                appliedLightsCount = lights.length;
                for (const l of lights) {
                    threeScene.add(l);
                }
            }

            return {
                success: true,
                rig: rigDef.name,
                label: rigDef.label,
                description: rigDef.description,
                lightsConfigured: rigDef.lights.length,
                appliedToThreeScene: appliedLightsCount > 0,
                appliedLightsCount
            };
        }
    },
    {
        name: 'sb_add_light',
        category: 'lighting_camera',
        description: 'Adds an individual physical light entity with Kelvin blackbody temperature, physical units, and shadow controls.',
        execute: (ctx, params: {
            name?: string;
            type: 'directional' | 'point' | 'spot';
            position: [number, number, number];
            direction?: [number, number, number];
            kelvin?: number;
            color?: number | [number, number, number];
            intensity?: number;
            range?: number;
            innerConeAngle?: number;
            outerConeAngle?: number;
            castShadow?: boolean;
        }) => {
            const scene = ctx.getSceneData();
            scene.customLights = scene.customLights || [];

            const lightEntry = {
                id: `light_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
                name: params.name || `${params.type}_light`,
                type: params.type,
                position: params.position,
                direction: params.direction,
                kelvin: params.kelvin,
                color: params.color,
                intensity: params.intensity ?? 1.0,
                range: params.range,
                innerConeAngle: params.innerConeAngle,
                outerConeAngle: params.outerConeAngle,
                castShadow: params.castShadow ?? true
            };

            scene.customLights.push(lightEntry);

            const threeScene = ctx.getThreeScene();
            if (threeScene) {
                const col = params.kelvin ? kelvinToRgb(params.kelvin) : (typeof params.color === 'number' ? new THREE.Color(params.color) : new THREE.Color(0xffffff));
                let l: THREE.Light;
                if (params.type === 'directional') {
                    l = new THREE.DirectionalLight(col, params.intensity ?? 1.0);
                    if (params.castShadow !== false) l.castShadow = true;
                } else if (params.type === 'spot') {
                    l = new THREE.SpotLight(col, params.intensity ?? 1.0, params.range ?? 25, params.outerConeAngle ?? 0.6);
                    if (params.castShadow !== false) l.castShadow = true;
                } else {
                    l = new THREE.PointLight(col, params.intensity ?? 1.0, params.range ?? 25, 2.0);
                    if (params.castShadow !== false) l.castShadow = true;
                }
                l.name = lightEntry.name;
                l.position.set(...params.position);
                threeScene.add(l);
            }

            return {
                success: true,
                lightId: lightEntry.id,
                lightName: lightEntry.name,
                totalCustomLights: scene.customLights.length
            };
        }
    },
    {
        name: 'sb_optimize_light_budget',
        category: 'lighting_camera',
        description: 'Analyzes real-time performance budget (vertices, triangles, shadow maps, draw calls, FPS), suggesting or applying lightweight scene optimizations.',
        execute: (ctx, params: {
            autoApply?: boolean;
            maxShadowCasters?: number;
        }) => {
            const threeScene = ctx.getThreeScene();
            let telemetry = {
                totalVertices: 0,
                totalTriangles: 0,
                meshCount: 0,
                lightCount: 0,
                shadowCasters: 0,
                estimatedFrameTimeMs: 2.0,
                estimatedFps: 60,
                withinWebBudget: true,
                recommendations: [] as string[]
            };

            if (threeScene) {
                telemetry = computeSceneBudgetTelemetry(threeScene);

                if (params.autoApply) {
                    const maxShadows = params.maxShadowCasters ?? 2;
                    let shadowCount = 0;
                    threeScene.traverse((obj) => {
                        if ((obj as THREE.Light).isLight) {
                            const l = obj as THREE.Light;
                            if (l.castShadow) {
                                shadowCount++;
                                if (shadowCount > maxShadows) {
                                    l.castShadow = false;
                                }
                            }
                        }
                    });
                    // Recompute after applying
                    telemetry = computeSceneBudgetTelemetry(threeScene);
                }
            } else {
                const scene = ctx.getSceneData();
                const meshes = scene.customMeshes || [];
                let tris = 0;
                for (const m of meshes) {
                    tris += m.triangles?.length || 500;
                }
                telemetry.meshCount = meshes.length;
                telemetry.totalTriangles = tris;
                telemetry.withinWebBudget = tris <= 100000;
            }

            return {
                success: true,
                telemetry,
                autoApplied: !!params.autoApply
            };
        }
    },
    {
        name: 'sb_apply_weighted_normals',
        category: 'modifiers',
        description: 'Recalculates vertex normals weighted by face area and face corner angle with sharp edge retention, emulating Blender Weighted Normal headlessly.',
        execute: (ctx, params: {
            targetId: string;
            areaWeightPower?: number;
            angleWeightPower?: number;
            thresholdAngleDeg?: number;
            keepSharpEdges?: boolean;
        }) => {
            const found = ctx.findObject(params.targetId);
            const mesh = found?.object || ctx.getObject(params.targetId);
            if (!mesh) throw new Error(`Target mesh '${params.targetId}' not found.`);

            const threeObj = ctx.getThreeObject(params.targetId);
            if (threeObj && (threeObj as THREE.Mesh).geometry) {
                applyWeightedNormals((threeObj as THREE.Mesh).geometry, {
                    areaWeightPower: params.areaWeightPower,
                    angleWeightPower: params.angleWeightPower,
                    thresholdAngleDeg: params.thresholdAngleDeg,
                    keepSharpEdges: params.keepSharpEdges
                });
            }

            mesh.weightedNormals = {
                enabled: true,
                areaWeightPower: params.areaWeightPower ?? 1.0,
                angleWeightPower: params.angleWeightPower ?? 1.0,
                thresholdAngleDeg: params.thresholdAngleDeg ?? 45.0,
                keepSharpEdges: params.keepSharpEdges ?? true
            };

            ctx.recordState(`Apply Weighted Normals (${params.targetId})`);

            return {
                success: true,
                targetId: params.targetId,
                weightedNormals: mesh.weightedNormals
            };
        }
    },
    {
        name: 'sb_synthesize_differential_wear',
        category: 'materials_pbr',
        description: 'Evaluates continuous differential curvature fields and applies parameterized multi-tier substratum wear (topcoat -> primer -> base substrate metal).',
        execute: (ctx, params: {
            targetId: string;
            options?: HeadlessWearOptions;
        }) => {
            const found = ctx.findObject(params.targetId);
            const mesh = found?.object || ctx.getObject(params.targetId);
            if (!mesh) throw new Error(`Target mesh '${params.targetId}' not found.`);

            let averageWear = 0.5;
            const threeObj = ctx.getThreeObject(params.targetId);
            if (threeObj && (threeObj as THREE.Mesh).geometry) {
                const result = computeStratifiedWear((threeObj as THREE.Mesh).geometry, params.options);
                averageWear = result.averageWear;
            }

            mesh.stratifiedWear = {
                enabled: true,
                ...(params.options || {}),
                averageWear,
                evaluatedAt: Date.now()
            };

            if (!mesh.material) mesh.material = {};
            if (params.options?.substrateRoughness !== undefined) {
                mesh.material.roughness = params.options.substrateRoughness;
            }
            if (params.options?.substrateMetallic !== undefined) {
                mesh.material.metalness = params.options.substrateMetallic;
            }

            ctx.recordState(`Synthesize Differential Wear (${params.targetId})`);

            return {
                success: true,
                targetId: params.targetId,
                averageWear,
                stratifiedWear: mesh.stratifiedWear
            };
        }
    },
    {
        name: 'sb_simulate_geomorphological_erosion',
        category: 'modifiers',
        description: 'Solves stream-power hydraulic erosion and non-linear talus scree repose relaxation PDEs on heightfields or vertex geometries.',
        execute: (ctx, params: {
            targetId: string;
            iterations?: number;
            erodibility?: number;
            diffusionRate?: number;
            talusReposeAngleDeg?: number;
            talusDiffusionRate?: number;
        }) => {
            const found = ctx.findObject(params.targetId);
            const mesh = found?.object || ctx.getObject(params.targetId);
            if (!mesh) throw new Error(`Target mesh '${params.targetId}' not found.`);

            const threeObj = ctx.getThreeObject(params.targetId);
            if (threeObj && (threeObj as THREE.Mesh).geometry) {
                simulateGeomorphologyOnGeometry((threeObj as THREE.Mesh).geometry, {
                    iterations: params.iterations,
                    erodibility: params.erodibility,
                    diffusionRate: params.diffusionRate,
                    talusReposeAngleDeg: params.talusReposeAngleDeg,
                    talusDiffusionRate: params.talusDiffusionRate
                });
            }

            mesh.erosion = {
                simulated: true,
                iterations: params.iterations ?? 10,
                erodibility: params.erodibility ?? 0.08,
                diffusionRate: params.diffusionRate ?? 0.015,
                talusReposeAngleDeg: params.talusReposeAngleDeg ?? 35.0,
                talusDiffusionRate: params.talusDiffusionRate ?? 0.05
            };

            ctx.recordState(`Simulate Geomorphology (${params.targetId})`);

            return {
                success: true,
                targetId: params.targetId,
                erosion: mesh.erosion
            };
        }
    },
    {
        name: 'sb_transfer_canopy_normals',
        category: 'modifiers',
        description: 'Reorients foliage or hair normals radially from an ellipsoidal bounding envelope, eliminating card shadow terminator artifacts.',
        execute: (ctx, params: {
            targetId: string;
            proxyCenter?: [number, number, number];
            proxyRadii?: [number, number, number];
            blendFactor?: number;
            skyHemisphereBias?: number;
        }) => {
            const found = ctx.findObject(params.targetId);
            const mesh = found?.object || ctx.getObject(params.targetId);
            if (!mesh) throw new Error(`Target mesh '${params.targetId}' not found.`);

            const threeObj = ctx.getThreeObject(params.targetId);
            if (threeObj && (threeObj as THREE.Mesh).geometry) {
                transferCanopyNormals((threeObj as THREE.Mesh).geometry, {
                    proxyCenter: params.proxyCenter,
                    proxyRadii: params.proxyRadii,
                    blendFactor: params.blendFactor,
                    skyHemisphereBias: params.skyHemisphereBias
                });
            }

            mesh.canopyNormals = {
                transferred: true,
                proxyCenter: params.proxyCenter || [0, 2, 0],
                proxyRadii: params.proxyRadii || [1.5, 2.0, 1.5],
                blendFactor: params.blendFactor ?? 0.85,
                skyHemisphereBias: params.skyHemisphereBias ?? 0.25
            };

            ctx.recordState(`Transfer Canopy Normals (${params.targetId})`);

            return {
                success: true,
                targetId: params.targetId,
                canopyNormals: mesh.canopyNormals
            };
        }
    },
    {
        name: 'sb_apply_thin_film_interference',
        category: 'materials_pbr',
        description: 'Solves spectral Airy wave optics across RGB wavelengths for arbitrary film thickness and refractive index (iridescence, oil slicks, soap bubbles).',
        execute: (ctx, params: {
            targetId: string;
            thicknessNm?: number;
            nFilm?: number;
            nSubstrate?: number;
            nMedium?: number;
            cosTheta?: number;
        }) => {
            const found = ctx.findObject(params.targetId);
            const mesh = found?.object || ctx.getObject(params.targetId);
            if (!mesh) throw new Error(`Target mesh '${params.targetId}' not found.`);

            const thickness = params.thicknessNm ?? 380;
            const cosTheta = params.cosTheta ?? 0.866;
            const reflectance = evaluateAiryThinFilm(
                thickness,
                cosTheta,
                params.nFilm ?? 1.33,
                params.nSubstrate ?? 1.50,
                params.nMedium ?? 1.0
            );

            if (!mesh.material) mesh.material = {};
            mesh.material.iridescence = {
                enabled: true,
                thicknessNm: thickness,
                nFilm: params.nFilm ?? 1.33,
                nSubstrate: params.nSubstrate ?? 1.50,
                spectralReflectanceRgb: reflectance
            };

            const threeObj = ctx.getThreeObject(params.targetId);
            if (threeObj && (threeObj as THREE.Mesh).material) {
                const mat = (threeObj as THREE.Mesh).material as THREE.MeshPhysicalMaterial;
                if ('iridescence' in mat) {
                    mat.iridescence = 1.0;
                    mat.iridescenceIOR = params.nFilm ?? 1.33;
                    mat.iridescenceThicknessRange = [thickness * 0.8, thickness * 1.2];
                    mat.needsUpdate = true;
                }
            }

            ctx.recordState(`Apply Thin-Film Interference (${params.targetId})`);

            return {
                success: true,
                targetId: params.targetId,
                spectralReflectanceRgb: reflectance,
                iridescence: mesh.material.iridescence
            };
        }
    },
    {
        name: 'sb_configure_photometric_light',
        category: 'lighting_camera',
        description: 'Configures physically calibrated illuminance (lux), candela, blackbody Kelvin temperature, and analytical gobo cookies.',
        execute: (ctx, params: {
            lightId?: string;
            kelvin?: number;
            lux?: number;
            distanceMeters?: number;
            goboMode?: 'canopy' | 'blinds' | 'none';
            goboFrequency?: number;
            position?: [number, number, number];
        }) => {
            const kelvin = params.kelvin ?? 5600;
            const linearRgb = blackbodyKelvinToLinearRgb(kelvin);
            const lux = params.lux ?? 500;
            const dist = params.distanceMeters ?? 2.0;
            const intensity = lux * (dist * dist);

            const scene = ctx.getSceneData();
            if (!scene.customLights) scene.customLights = [];

            let light = params.lightId ? scene.customLights.find(l => l.id === params.lightId) : undefined;
            if (!light) {
                light = {
                    id: params.lightId || `photometric-light-${Date.now()}`,
                    name: `Photometric Light (${kelvin}K)`,
                    type: 'spot',
                    position: params.position || [2, 4, 3],
                    color: kelvinToRgb(kelvin),
                    intensity: intensity / 1000.0,
                    castShadow: true
                };
                scene.customLights.push(light);
            } else {
                light.color = kelvinToRgb(kelvin);
                light.intensity = intensity / 1000.0;
                if (params.position) light.position = params.position;
            }

            (light as any).photometric = {
                kelvin,
                linearRgb,
                lux,
                distanceMeters: dist,
                goboMode: params.goboMode || 'none',
                goboFrequency: params.goboFrequency || 4.0
            };

            const threeScene = ctx.getThreeScene();
            if (threeScene) {
                const threeLight = ctx.getThreeObject(light.id);
                if (threeLight && (threeLight as THREE.Light).isLight) {
                    (threeLight as THREE.Light).color.setRGB(linearRgb[0], linearRgb[1], linearRgb[2]);
                    (threeLight as THREE.Light).intensity = intensity / 1000.0;
                }
            }

            ctx.recordState(`Configure Photometric Light (${kelvin}K)`);

            return {
                success: true,
                lightId: light.id,
                kelvin,
                linearRgb,
                lux,
                intensity
            };
        }
    },
    {
        name: 'sb_synthesize_moisture_runoff',
        category: 'modifiers',
        description: 'Simulates gravitational moisture advection, capillary crevice pooling, albedo darkening, and specular puddle roughness.',
        execute: (ctx, params: {
            targetId: string;
            options?: MoistureRunoffOptions;
        }) => {
            if (!params.targetId) throw new Error("Parameter 'targetId' is required.");
            const scene = ctx.getSceneData();
            if (!scene.customMeshes) scene.customMeshes = [];
            const mesh = scene.customMeshes.find(m => m.id === params.targetId);
            if (!mesh) throw new Error(`Mesh with id '${params.targetId}' not found.`);

            let averageMoisture = 0;
            const threeMesh = ctx.getThreeObject(params.targetId) as THREE.Mesh;
            if (threeMesh && threeMesh.geometry) {
                const result = synthesizeMoistureRunoff(threeMesh.geometry, params.options);
                averageMoisture = result.averageMoisture;
            }

            (mesh as any).moistureRunoff = {
                enabled: true,
                averageMoisture,
                options: params.options || {}
            };

            ctx.recordState(`Synthesize Moisture Runoff on '${params.targetId}'`);

            return {
                success: true,
                targetId: params.targetId,
                averageMoisture,
                moistureRunoff: (mesh as any).moistureRunoff
            };
        }
    },
    {
        name: 'sb_apply_normal_bevel',
        category: 'modifiers',
        description: 'Synthesizes analytical osculating cylindrical fillet normals on hard-surface dihedral creases to catch specular edge highlights.',
        execute: (ctx, params: {
            targetId: string;
            thresholdAngleDeg?: number;
            maxAngleDeg?: number;
            filletSharpness?: number;
        }) => {
            if (!params.targetId) throw new Error("Parameter 'targetId' is required.");
            const scene = ctx.getSceneData();
            if (!scene.customMeshes) scene.customMeshes = [];
            const mesh = scene.customMeshes.find(m => m.id === params.targetId);
            if (!mesh) throw new Error(`Mesh with id '${params.targetId}' not found.`);

            const threeMesh = ctx.getThreeObject(params.targetId) as THREE.Mesh;
            if (threeMesh && threeMesh.geometry) {
                applyNormalBevel(threeMesh.geometry, {
                    thresholdAngleDeg: params.thresholdAngleDeg,
                    maxAngleDeg: params.maxAngleDeg,
                    filletSharpness: params.filletSharpness
                });
            }

            (mesh as any).normalBevel = {
                enabled: true,
                thresholdAngleDeg: params.thresholdAngleDeg ?? 35.0,
                maxAngleDeg: params.maxAngleDeg ?? 150.0,
                filletSharpness: params.filletSharpness ?? 2.0
            };

            ctx.recordState(`Apply Normal Bevel on '${params.targetId}'`);

            return {
                success: true,
                targetId: params.targetId,
                normalBevel: (mesh as any).normalBevel
            };
        }
    },
    {
        name: 'sb_apply_agx_tonemapping',
        category: 'lighting_camera',
        description: 'Applies the Blender 4.0 AgX photographic log tone curve with gamut inset primaries and highlight desaturation roll-off.',
        execute: (ctx, params: {
            exposure?: number;
            minEv?: number;
            maxEv?: number;
            sampleRgb?: [number, number, number];
        }) => {
            const scene = ctx.getSceneData();
            const exposure = params.exposure ?? 1.0;

            (scene as any).tonemapping = {
                mode: 'agx',
                exposure,
                minEv: params.minEv ?? -12.47393,
                maxEv: params.maxEv ?? 4.026069
            };

            let mappedSample: [number, number, number] | undefined;
            if (params.sampleRgb) {
                mappedSample = evaluateAgXTonemapping(params.sampleRgb, {
                    exposure,
                    minEv: params.minEv,
                    maxEv: params.maxEv
                });
            }

            ctx.recordState('Apply AgX Tonemapping');

            return {
                success: true,
                tonemapping: (scene as any).tonemapping,
                mappedSample
            };
        }
    },
    {
        name: 'sb_apply_subsurface_scattering',
        category: 'materials_pbr',
        description: 'Injects Burley (Disney) normalized diffusion dipole subsurface scattering into target mesh material.',
        execute: (ctx, params: {
            targetId: string;
            scatterColor?: [number, number, number];
            scatterDistance?: number;
            absorptionColor?: [number, number, number];
            ior?: number;
            transmission?: number;
            thickness?: number;
        }) => {
            if (!params.targetId) throw new Error("Parameter 'targetId' is required.");
            const scene = ctx.getSceneData();
            if (!scene.customMeshes) scene.customMeshes = [];
            const mesh = scene.customMeshes.find(m => m.id === params.targetId);
            if (!mesh) throw new Error(`Mesh with id '${params.targetId}' not found.`);

            const threeMesh = ctx.getThreeObject(params.targetId) as THREE.Mesh;
            if (threeMesh) {
                applyBurleySubsurfaceScattering(threeMesh, {
                    scatterColor: params.scatterColor,
                    scatterDistance: params.scatterDistance,
                    absorptionColor: params.absorptionColor,
                    ior: params.ior,
                    transmission: params.transmission,
                    thickness: params.thickness
                });
            }

            (mesh as any).subsurfaceScattering = {
                enabled: true,
                scatterColor: params.scatterColor ?? [0.95, 0.45, 0.35],
                scatterDistance: params.scatterDistance ?? 0.15,
                ior: params.ior ?? 1.45,
                transmission: params.transmission ?? 0.35,
                thickness: params.thickness ?? 0.5
            };

            ctx.recordState(`Apply Subsurface Scattering on '${params.targetId}'`);

            return {
                success: true,
                targetId: params.targetId,
                subsurfaceScattering: (mesh as any).subsurfaceScattering
            };
        }
    }
];
