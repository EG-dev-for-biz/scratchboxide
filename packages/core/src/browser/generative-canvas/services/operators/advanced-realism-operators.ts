/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import { type OperatorDefinition, OperatorUnavailableError, requireLiveMesh } from './types';
import {
    applyWeightedNormals,
    computeStratifiedWear,
    estimateDifferentialCurvature,
    type HeadlessWearOptions,
    simulateGeomorphologyOnGeometry,
    transferCanopyNormals,
    evaluateAiryThinFilm,
    synthesizeMoistureRunoff,
    type MoistureRunoffOptions,
    applyNormalBevel,
    applyBurleySubsurfaceScattering
} from '../headless-realism-service';
import { CINEMATIC_RIGS, computeSceneBudgetTelemetry, isSceneLightingRig } from '../../primitives/scene3d/lightingRigs';
import { stagedPartOfHit } from '../../primitives/scene3d/stagedBuild/mergeStagedParts';

/**
 * Runs `edit` on a copy of the mesh's geometry and swaps the copy in, so the viewport timeline can undo the edit by
 * swapping back (normals and colors are not part of its vertex deltas). The replaced geometry stays with the history.
 */
function editGeometryCopy<T>(mesh: THREE.Mesh, edit: (geometry: THREE.BufferGeometry) => T): T {
    const geometry = mesh.geometry.clone();
    const result = edit(geometry);
    mesh.geometry = geometry;
    return result;
}

/** Swaps in copies of the mesh's materials with vertex colors on, so colors painted into the geometry show. */
function enableVertexColors(mesh: THREE.Mesh): void {
    const withColors = (m: THREE.Material) => {
        if (m.vertexColors) return m;
        const copy = m.clone();
        copy.vertexColors = true;
        return copy;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(withColors) : withColors(mesh.material);
}

/**
 * Swaps in a MeshPhysicalMaterial copy of the mesh's material (keeping color, roughness, metalness and maps when it
 * was another kind) and returns it. The original stays with the viewport timeline, so undo swaps it back.
 */
function ensurePhysicalMaterial(mesh: THREE.Mesh): THREE.MeshPhysicalMaterial {
    const current = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
    let next: THREE.MeshPhysicalMaterial;
    if (current instanceof THREE.MeshPhysicalMaterial) {
        next = current.clone();
    } else {
        next = new THREE.MeshPhysicalMaterial({
            color: current?.color ?? 0xffffff,
            roughness: current?.roughness ?? 0.5,
            metalness: current?.metalness ?? 0.0,
            map: current?.map ?? null,
            normalMap: current?.normalMap ?? null
        });
    }
    mesh.material = next;
    return next;
}

export const ADVANCED_REALISM_OPERATORS: OperatorDefinition[] = [
    {
        name: 'sb_compute_halfedge_curvature',
        category: 'inspect',
        description: 'Measures per-vertex principal curvature (edge normal-curvature extremes k1/k2, mean H, Gaussian K, shape index) on the live viewport mesh and returns their range and mean. Needs the mesh in the live 3D viewport.',
        execute: (ctx, params: { targetId: string }) => {
            const { mesh } = requireLiveMesh(ctx, params.targetId, 'sb_compute_halfedge_curvature');
            const m = estimateDifferentialCurvature(mesh.geometry);
            const summary = (values: number[]) => {
                if (values.length === 0) return { min: 0, max: 0, mean: 0 };
                let min = Infinity, max = -Infinity, sum = 0;
                for (const v of values) { min = Math.min(min, v); max = Math.max(max, v); sum += v; }
                return { min, max, mean: sum / values.length };
            };
            return {
                targetId: params.targetId,
                vertexCount: m.meanCurvature.length,
                meanCurvature: summary(m.meanCurvature),
                gaussianCurvature: summary(m.gaussianCurvature),
                shapeIndex: summary(m.shapeIndex),
                curvedness: summary(m.curvedness)
            };
        }
    },
    {
        name: 'sb_raycast_mesh',
        category: 'inspect',
        description: 'Casts a ray (world-space origin and direction) against the triangles of a mesh in the live viewport, or of every mesh when targetMeshId is omitted, and returns the nearest hit: point, distance, world-space face normal, face index and mesh. Needs the live 3D viewport.',
        execute: (ctx, params: {
            targetMeshId?: string;
            origin: [number, number, number];
            direction: [number, number, number];
            maxDistance?: number;
        }) => {
            if (!Array.isArray(params.origin) || !Array.isArray(params.direction)) {
                throw new Error('sb_raycast_mesh needs origin and direction, each [x, y, z].');
            }
            const dir = new THREE.Vector3(...params.direction);
            if (dir.lengthSq() < 1e-12) throw new Error('sb_raycast_mesh: direction must be non-zero.');
            let targets: THREE.Object3D[];
            if (params.targetMeshId) {
                targets = [requireLiveMesh(ctx, params.targetMeshId, 'sb_raycast_mesh').mesh];
            } else {
                const threeScene = ctx.getThreeScene();
                if (!threeScene) throw new OperatorUnavailableError('sb_raycast_mesh casts against the meshes in the live 3D viewport, and no viewport is attached here.');
                targets = [threeScene];
            }
            for (const t of targets) t.updateWorldMatrix(true, true);
            const raycaster = new THREE.Raycaster(new THREE.Vector3(...params.origin), dir.normalize(), 0, params.maxDistance ?? Infinity);
            const hit = raycaster.intersectObjects(targets, true).find(h => (h.object as THREE.Mesh).isMesh);
            if (!hit) return { hit: false };
            const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : undefined;
            // a staged part (its own mesh, or a range of a merged mesh): named as the node it is, with its provenance
            const part = stagedPartOfHit(hit);
            return {
                hit: true,
                distance: hit.distance,
                position: hit.point.toArray() as [number, number, number],
                normal: normal?.toArray() as [number, number, number] | undefined,
                faceIndex: hit.faceIndex ?? null,
                meshName: part?.partIndex !== undefined ? part.name : (hit.object.name || hit.object.uuid),
                ...(part ? { stagedPart: { name: part.name, label: part.label ?? null, ids: part.ids ?? {} } } : {})
            };
        }
    },
    {
        name: 'sb_setup_lighting_rig',
        category: 'lighting_camera',
        description: 'Sets the scene\'s cinematic lighting rig (environment.cinematicRig), which the viewport builds as Kelvin-calibrated lights, optionally at a given colour temperature (environment.lightingKelvin). preset is a rig key from CINEMATIC_RIGS; an unknown key fails and lists the rigs.',
        execute: (ctx, params: { preset?: string; kelvin?: number }) => {
            const scene = ctx.getSceneData();
            const rigKey = params.preset || 'three_point_studio';
            const rigDef = CINEMATIC_RIGS[rigKey];
            if (!rigDef) throw new Error(`sb_setup_lighting_rig: no rig '${rigKey}' (rigs: ${Object.keys(CINEMATIC_RIGS).join(', ')}).`);
            if (!scene.environment) scene.environment = {};
            scene.environment.cinematicRig = rigDef.name;
            // a preset replaces an explicit rig written earlier (sb_set_explicit_lighting_rig)
            delete scene.environment.lightingRig;
            if (params.kelvin !== undefined) scene.environment.lightingKelvin = params.kelvin;
            return {
                rig: rigDef.name,
                label: rigDef.label,
                description: rigDef.description,
                lightsConfigured: rigDef.lights.length,
                lightingKelvin: scene.environment.lightingKelvin
            };
        }
    },
    {
        name: 'sb_set_explicit_lighting_rig',
        category: 'lighting_camera',
        description: 'Writes an explicit light rig into the scene (environment.lightingRig, named by environment.cinematicRig): { name, label, description, ambientColor, ambientIntensity, origin?, lights: [{ name, type: directional|point|spot, position (relative to origin), direction?, kelvin? | color?, intensity, range?, innerConeAngle?, outerConeAngle?, castShadow? }] }. The viewport builds these lights in place of the studio rig, scaled with the content. A sun/sky atmosphere the scene draws would replace the rig, so it is switched off (enabled: false, its settings kept) and reported.',
        execute: (ctx, params: { rig?: unknown }) => {
            if (!isSceneLightingRig(params.rig)) {
                throw new Error('sb_set_explicit_lighting_rig: rig needs a name and at least one light with type (directional, point or spot), a position [x, y, z] and a finite intensity >= 0. Nothing was changed.');
            }
            const scene = ctx.getSceneData();
            if (!scene.environment) scene.environment = {};
            scene.environment.cinematicRig = params.rig.name;
            scene.environment.lightingRig = JSON.parse(JSON.stringify(params.rig));
            // the rig's lights carry their own colour temperatures
            delete scene.environment.lightingKelvin;
            const switchedOff: string[] = [];
            const atm = scene.features?.atmosphericScattering;
            if (atm === true || (typeof atm === 'object' && atm !== null && atm.enabled !== false)) {
                scene.features = { ...(scene.features ?? {}), atmosphericScattering: { ...(typeof atm === 'object' ? atm : {}), enabled: false } };
                switchedOff.push('features.atmosphericScattering');
            }
            const loose = scene as { atmosphere?: unknown };
            if (loose.atmosphere === true || (typeof loose.atmosphere === 'object' && loose.atmosphere !== null && (loose.atmosphere as { enabled?: unknown }).enabled !== false)) {
                loose.atmosphere = { ...(typeof loose.atmosphere === 'object' ? loose.atmosphere as object : {}), enabled: false };
                switchedOff.push('atmosphere');
            }
            return { rig: params.rig.name, lightsConfigured: params.rig.lights.length, atmosphereSwitchedOff: switchedOff };
        }
    },
    {
        name: 'sb_optimize_light_budget',
        category: 'lighting_camera',
        description: 'Measures the live viewport\'s render budget (vertices, triangles, meshes, lights, shadow casters) and, with autoApply, turns off shadows on lights past maxShadowCasters. Needs the live 3D viewport.',
        execute: (ctx, params: { autoApply?: boolean; maxShadowCasters?: number }) => {
            const threeScene = ctx.getThreeScene();
            if (!threeScene) throw new OperatorUnavailableError('sb_optimize_light_budget measures the live 3D viewport, and no viewport is attached here.');
            let shadowsDisabled = 0;
            if (params.autoApply) {
                const maxShadows = params.maxShadowCasters ?? 2;
                let shadowCount = 0;
                threeScene.traverse(obj => {
                    const l = obj as THREE.Light;
                    if (l.isLight && l.castShadow && ++shadowCount > maxShadows) {
                        l.castShadow = false;
                        shadowsDisabled++;
                    }
                });
            }
            return { telemetry: computeSceneBudgetTelemetry(threeScene), shadowsDisabled };
        }
    },
    {
        name: 'sb_apply_weighted_normals',
        category: 'modifiers',
        description: 'Recalculates the vertex normals of the live viewport mesh weighted by face area and corner angle, keeping edges sharper than the threshold angle sharp. Needs the live 3D viewport.',
        execute: (ctx, params: { targetId: string; areaWeightPower?: number; angleWeightPower?: number; thresholdAngleDeg?: number; keepSharpEdges?: boolean }) => {
            const { mesh } = requireLiveMesh(ctx, params.targetId, 'sb_apply_weighted_normals');
            editGeometryCopy(mesh, geometry => {
                applyWeightedNormals(geometry, {
                    areaWeightPower: params.areaWeightPower,
                    angleWeightPower: params.angleWeightPower,
                    thresholdAngleDeg: params.thresholdAngleDeg,
                    keepSharpEdges: params.keepSharpEdges
                });
            });
            return { targetId: params.targetId, vertexCount: mesh.geometry.getAttribute('position').count };
        }
    },
    {
        name: 'sb_synthesize_differential_wear',
        category: 'materials_pbr',
        description: 'Paints layered edge wear (topcoat -> primer -> substrate) into the vertex colors of the live viewport mesh from its measured convexity, and turns on vertex colors in its material. Needs the live 3D viewport.',
        execute: (ctx, params: { targetId: string; options?: HeadlessWearOptions }) => {
            const { mesh } = requireLiveMesh(ctx, params.targetId, 'sb_synthesize_differential_wear');
            const result = editGeometryCopy(mesh, geometry => computeStratifiedWear(geometry, params.options));
            enableVertexColors(mesh);
            return { targetId: params.targetId, averageWear: result.averageWear, vertexCount: result.wearExposures.length };
        }
    },
    {
        name: 'sb_simulate_geomorphological_erosion',
        category: 'modifiers',
        description: 'Erodes the heights (Y) of the live viewport mesh: stream-power incision on slopes, Laplacian diffusion and talus relaxation above the repose angle, over the welded vertex neighbourhoods. Needs the live 3D viewport.',
        execute: (ctx, params: { targetId: string; iterations?: number; erodibility?: number; diffusionRate?: number; talusReposeAngleDeg?: number; talusDiffusionRate?: number }) => {
            const { mesh } = requireLiveMesh(ctx, params.targetId, 'sb_simulate_geomorphological_erosion');
            const result = simulateGeomorphologyOnGeometry(mesh.geometry, {
                iterations: params.iterations,
                erodibility: params.erodibility,
                diffusionRate: params.diffusionRate,
                talusReposeAngleDeg: params.talusReposeAngleDeg,
                talusDiffusionRate: params.talusDiffusionRate
            });
            return { targetId: params.targetId, ...result };
        }
    },
    {
        name: 'sb_transfer_canopy_normals',
        category: 'modifiers',
        description: 'Blends the vertex normals of the live viewport mesh (foliage cards, hair) toward the radial normals of an ellipsoidal envelope, removing card shading seams. Needs the live 3D viewport.',
        execute: (ctx, params: { targetId: string; proxyCenter?: [number, number, number]; proxyRadii?: [number, number, number]; blendFactor?: number; skyHemisphereBias?: number }) => {
            const { mesh } = requireLiveMesh(ctx, params.targetId, 'sb_transfer_canopy_normals');
            editGeometryCopy(mesh, geometry => {
                if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
                transferCanopyNormals(geometry, {
                    proxyCenter: params.proxyCenter,
                    proxyRadii: params.proxyRadii,
                    blendFactor: params.blendFactor,
                    skyHemisphereBias: params.skyHemisphereBias
                });
            });
            return { targetId: params.targetId, vertexCount: mesh.geometry.getAttribute('position').count };
        }
    },
    {
        name: 'sb_apply_thin_film_interference',
        category: 'materials_pbr',
        description: 'Evaluates Airy thin-film reflectance for the given film thickness and indices, and turns on Three.js physical iridescence with that film on the live viewport mesh material. Needs the live 3D viewport.',
        execute: (ctx, params: {
            targetId: string;
            thicknessNm?: number;
            nFilm?: number;
            nSubstrate?: number;
            nMedium?: number;
            cosTheta?: number;
        }) => {
            const { mesh, record } = requireLiveMesh(ctx, params.targetId, 'sb_apply_thin_film_interference');
            const thickness = params.thicknessNm ?? 380;
            const nFilm = params.nFilm ?? 1.33;
            const reflectance = evaluateAiryThinFilm(thickness, params.cosTheta ?? 0.866, nFilm, params.nSubstrate ?? 1.50, params.nMedium ?? 1.0);
            const mat = ensurePhysicalMaterial(mesh);
            mat.iridescence = 1.0;
            mat.iridescenceIOR = nFilm;
            mat.iridescenceThicknessRange = [thickness * 0.8, thickness * 1.2];
            mat.needsUpdate = true;
            if (!record.material) record.material = {};
            record.material.iridescence = { thicknessNm: thickness, nFilm, nSubstrate: params.nSubstrate ?? 1.50, spectralReflectanceRgb: reflectance };
            return { targetId: params.targetId, spectralReflectanceRgb: reflectance, iridescence: record.material.iridescence };
        }
    },
    {
        name: 'sb_synthesize_moisture_runoff',
        category: 'modifiers',
        description: 'Darkens the vertex colors of the live viewport mesh where gravity-driven runoff streaks and crevice pooling put moisture, and turns on vertex colors in its material. Needs the live 3D viewport.',
        execute: (ctx, params: { targetId: string; options?: MoistureRunoffOptions }) => {
            const { mesh } = requireLiveMesh(ctx, params.targetId, 'sb_synthesize_moisture_runoff');
            const result = editGeometryCopy(mesh, geometry => synthesizeMoistureRunoff(geometry, params.options));
            enableVertexColors(mesh);
            return { targetId: params.targetId, averageMoisture: result.averageMoisture };
        }
    },
    {
        name: 'sb_apply_normal_bevel',
        category: 'modifiers',
        description: 'Rounds the shading normals of the live viewport mesh across creases between the threshold and max dihedral angles, so hard edges catch a highlight. Geometry is unchanged. Needs the live 3D viewport.',
        execute: (ctx, params: { targetId: string; thresholdAngleDeg?: number; maxAngleDeg?: number; filletSharpness?: number }) => {
            const { mesh } = requireLiveMesh(ctx, params.targetId, 'sb_apply_normal_bevel');
            editGeometryCopy(mesh, geometry => {
                if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
                applyNormalBevel(geometry, {
                    thresholdAngleDeg: params.thresholdAngleDeg,
                    maxAngleDeg: params.maxAngleDeg,
                    filletSharpness: params.filletSharpness
                });
            });
            return { targetId: params.targetId, vertexCount: mesh.geometry.getAttribute('position').count };
        }
    },
    {
        name: 'sb_apply_subsurface_scattering',
        category: 'materials_pbr',
        description: 'Gives the live viewport mesh a physical material with transmission, IOR and thickness plus a wrapped back-scatter term from each directional light in the scatter color. Needs the live 3D viewport.',
        execute: (ctx, params: {
            targetId: string;
            scatterColor?: [number, number, number];
            scatterDistance?: number;
            absorptionColor?: [number, number, number];
            ior?: number;
            transmission?: number;
            thickness?: number;
        }) => {
            const { mesh } = requireLiveMesh(ctx, params.targetId, 'sb_apply_subsurface_scattering');
            ensurePhysicalMaterial(mesh);
            applyBurleySubsurfaceScattering(mesh, {
                scatterColor: params.scatterColor,
                scatterDistance: params.scatterDistance,
                absorptionColor: params.absorptionColor,
                ior: params.ior,
                transmission: params.transmission,
                thickness: params.thickness
            });
            const mat = mesh.material as THREE.MeshPhysicalMaterial;
            return { targetId: params.targetId, transmission: mat.transmission, ior: mat.ior, thickness: mat.thickness };
        }
    }
];
