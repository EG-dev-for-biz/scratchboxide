/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from 'three';
import type { TerrainManager } from '../../services/TerrainManager';
import type { RendererStack } from './types';
import { removeAndDispose } from './types';

import type { PbrTextureSet } from '../../canvas-types';

export interface CustomMeshDefinition {
    id?: string;
    name?: string;
    parentId?: string;
    type?: string;
    position?: [number, number, number];
    rotation?: [number, number, number];
    scale?: [number, number, number];
    material?: { color?: number | string; metalness?: number; roughness?: number; wireframe?: boolean; [k: string]: any };
    pbrTextures?: PbrTextureSet;
    instanceTransforms?: Array<{
        position: [number, number, number];
        scale?: [number, number, number];
        rotation?: [number, number, number, number] | [number, number, number];
    }>;
    lodLevels?: Array<{
        geometryType?: string;
        distance: number;
    }>;
    hairGroom?: any;
    fabricProperties?: any;
    ragdoll?: any;
}

/** Meshes created by this slice, keyed by definition id. Owned by the primitive via a ref. */
export type CustomMeshRegistry = Map<string, { mesh: THREE.Object3D; type: string }>;

export function customMeshDefinitionId(def: CustomMeshDefinition, index: number): string {
    return def.id || def.name || `custom-mesh-${index}`;
}

function createGeometry(type: string | undefined): THREE.BufferGeometry {
    if (type === 'sphere') return new THREE.SphereGeometry(1, 16, 16);
    if (type === 'cylinder') return new THREE.CylinderGeometry(1, 1, 2, 16);
    if (type === 'cone') return new THREE.ConeGeometry(1, 2, 16);
    if (type === 'plane') return new THREE.PlaneGeometry(2, 2);
    if (type === 'torus') return new THREE.TorusGeometry(1, 0.4, 16, 50);
    return new THREE.BoxGeometry(1, 1, 1);
}

function updateInstancedTransforms(mesh: THREE.InstancedMesh, transforms: NonNullable<CustomMeshDefinition['instanceTransforms']>): void {
    const dummy = new THREE.Object3D();
    for (let i = 0; i < transforms.length; ++i) {
        const t = transforms[i];
        dummy.position.set(...t.position);
        if (t.rotation) {
            if (t.rotation.length === 4) {
                dummy.quaternion.set(t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]);
            } else {
                dummy.rotation.set(...(t.rotation as [number, number, number]));
            }
        } else {
            dummy.rotation.set(0, 0, 0);
        }
        if (t.scale) {
            dummy.scale.set(...t.scale);
        } else {
            dummy.scale.set(1, 1, 1);
        }
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
}

function applyDefinition(obj: THREE.Object3D, def: CustomMeshDefinition): void {
    if (def.name) obj.userData.name = def.name;
    if (def.position) obj.position.set(...def.position);
    if (def.rotation) obj.rotation.set(...def.rotation);
    if (def.scale) obj.scale.set(...def.scale);

    if (obj instanceof THREE.InstancedMesh && def.instanceTransforms) {
        updateInstancedTransforms(obj, def.instanceTransforms);
    }

    const mesh = (obj instanceof THREE.Mesh ? obj : (obj.children.find(c => c instanceof THREE.Mesh) as THREE.Mesh | undefined));
    if (!mesh) return;

    if (def.pbrTextures) {
        const pbr = def.pbrTextures;
        const repeat = pbr.repeat || [2, 2];
        const loader = new THREE.TextureLoader();

        // Convert or ensure MeshPhysicalMaterial
        if (!(mesh.material instanceof THREE.MeshPhysicalMaterial)) {
            const oldMat = mesh.material as THREE.Material;
            mesh.material = new THREE.MeshPhysicalMaterial({
                color: 0xffffff,
                metalness: def.material?.metalness ?? 0.1,
                roughness: def.material?.roughness ?? 0.5,
                wireframe: !!def.material?.wireframe
            });
            oldMat?.dispose();
        }

        const pbrMat = mesh.material as THREE.MeshPhysicalMaterial;
        const albedoSrc = pbr.albedoUrl || pbr.albedoMap;
        const normalSrc = pbr.normalUrl || pbr.normalMap;
        const ormSrc = pbr.ormUrl || pbr.ormMap;
        const roughnessSrc = pbr.roughnessUrl || pbr.roughnessMap;
        const metallicSrc = pbr.metallicUrl || pbr.metalnessMap;
        const aoSrc = pbr.aoUrl || pbr.aoMap;

        if (ormSrc) {
            loader.load(ormSrc, (tex) => {
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                tex.repeat.set(repeat[0], repeat[1]);
                tex.colorSpace = THREE.NoColorSpace;
                pbrMat.roughnessMap = tex;
                pbrMat.metalnessMap = tex;
                pbrMat.aoMap = tex;
                pbrMat.aoMapIntensity = 1.0;
                pbrMat.needsUpdate = true;
            });
        }

        if (albedoSrc) {
            loader.load(albedoSrc, (tex) => {
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                tex.repeat.set(repeat[0], repeat[1]);
                tex.colorSpace = THREE.SRGBColorSpace;
                pbrMat.map = tex;
                pbrMat.needsUpdate = true;
            });
        }
        if (normalSrc) {
            loader.load(normalSrc, (tex) => {
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                tex.repeat.set(repeat[0], repeat[1]);
                tex.colorSpace = THREE.NoColorSpace;
                pbrMat.normalMap = tex;
                pbrMat.normalScale.set(1.0, 1.0);
                pbrMat.needsUpdate = true;
            });
        }
        if (roughnessSrc) {
            loader.load(roughnessSrc, (tex) => {
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                tex.repeat.set(repeat[0], repeat[1]);
                tex.colorSpace = THREE.NoColorSpace;
                pbrMat.roughnessMap = tex;
                pbrMat.needsUpdate = true;
            });
        }
        if (metallicSrc) {
            loader.load(metallicSrc, (tex) => {
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                tex.repeat.set(repeat[0], repeat[1]);
                tex.colorSpace = THREE.NoColorSpace;
                pbrMat.metalnessMap = tex;
                pbrMat.needsUpdate = true;
            });
        }
        if (aoSrc) {
            loader.load(aoSrc, (tex) => {
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                tex.repeat.set(repeat[0], repeat[1]);
                tex.colorSpace = THREE.NoColorSpace;
                pbrMat.aoMap = tex;
                pbrMat.aoMapIntensity = 1.0;
                pbrMat.needsUpdate = true;
            });
        }
        pbrMat.needsUpdate = true;
    } else {
        const hasSheenOrHair = !!(def.fabricProperties || def.hairGroom || def.material?.sheen);
        const hasGlassOrPhysical = hasSheenOrHair || def.material?.transmission !== undefined || def.material?.ior !== undefined || def.material?.clearcoat !== undefined;
        const fallbackCol = def.hairGroom ? 0x8b5a2b : 0x38bdf8;
        const colorVal = def.material?.color !== undefined ? def.material.color : fallbackCol;

        if (hasGlassOrPhysical && !(mesh.material instanceof THREE.MeshPhysicalMaterial)) {
            const oldMat = mesh.material as THREE.Material;
            mesh.material = new THREE.MeshPhysicalMaterial({
                color: colorVal as any,
                metalness: def.material?.metalness ?? 0.05,
                roughness: def.material?.roughness ?? 0.65,
                wireframe: !!def.material?.wireframe
            });
            oldMat?.dispose();
        }

        const mat = mesh.material as THREE.MeshStandardMaterial;
        if (mat && (mat as any).isMeshStandardMaterial) {
            try {
                mat.color.set(colorVal as any);
            } catch {
                mat.color.set(fallbackCol);
            }
            mat.metalness = def.material?.metalness ?? 0.5;
            mat.roughness = def.material?.roughness ?? 0.5;
            mat.wireframe = !!def.material?.wireframe;

            if (def.material?.emissive !== undefined) {
                try {
                    mat.emissive.set(def.material.emissive as any);
                } catch {}
            }
            if (def.material?.emissiveIntensity !== undefined) {
                mat.emissiveIntensity = def.material.emissiveIntensity;
            }

            if (mesh.material instanceof THREE.MeshPhysicalMaterial) {
                const physMat = mesh.material as THREE.MeshPhysicalMaterial;
                if (def.material?.transmission !== undefined) {
                    physMat.transmission = def.material.transmission;
                    physMat.transparent = true;
                    physMat.opacity = 1.0;
                }
                if (def.material?.ior !== undefined) {
                    physMat.ior = def.material.ior;
                }
                if (def.material?.clearcoat !== undefined) {
                    physMat.clearcoat = def.material.clearcoat;
                }
                if (def.fabricProperties) {
                    physMat.sheen = def.fabricProperties.sheenIntensity ?? 0.85;
                    physMat.sheenRoughness = 0.35;
                    physMat.sheenColor = new THREE.Color(0xffffff);
                } else if (def.hairGroom) {
                    physMat.roughness = 0.25;
                    physMat.sheen = 0.5;
                }
            }
            mat.needsUpdate = true;
        }
    }
}

/**
 * Id-diffed synchronisation of `customMeshes` → scene:
 *  - same id + same type: update transform/material in place (no re-allocation)
 *  - new id / changed type: create a mesh
 *  - id no longer present: remove + dispose
 *
 * Definitions whose id collides with an object the slice does not own (e.g. the sculptable mesh
 * or a gizmo-moved procedural object that was persisted back into `customMeshes`) are skipped so
 * we never spawn a duplicate box over an existing scene object.
 */
export function syncCustomMeshes(
    stack: RendererStack,
    definitions: CustomMeshDefinition[] | undefined,
    registry: CustomMeshRegistry,
    options: { terrainManager: TerrainManager | null; has3DTiles: boolean }
): { created: number; updated: number; removed: number } {
    const { scene } = stack;
    const defs = Array.isArray(definitions) ? definitions : [];
    const seen = new Set<string>();
    let created = 0;
    let updated = 0;
    let removed = 0;

    defs.forEach((def, index) => {
        const id = customMeshDefinitionId(def, index);
        if (seen.has(id)) return;
        seen.add(id);
        const typeKey = def.instanceTransforms && def.instanceTransforms.length > 0
            ? `${def.type || 'box'}:instanced:${def.instanceTransforms.length}`
            : def.lodLevels && def.lodLevels.length > 0
                ? `${def.type || 'box'}:lod:${def.lodLevels.length}`
                : def.type || 'box';
        const type = def.type || 'box';

        try {
            const existing = registry.get(id);
            if (existing && existing.type === typeKey) {
                applyDefinition(existing.mesh, def);
                updated++;
                return;
            }
            if (existing) {
                removeAndDispose(scene, existing.mesh);
                registry.delete(id);
                removed++;
            }

            // Skip ids that already belong to a scene object we do not manage.
            const foreign = scene.getObjectByName(id);
            if (foreign) return;

            let object3D: THREE.Object3D;
            if (def.instanceTransforms && def.instanceTransforms.length > 0) {
                const instMesh = new THREE.InstancedMesh(
                    createGeometry(type),
                    new THREE.MeshStandardMaterial({ color: 0x38bdf8, metalness: 0.5, roughness: 0.5 }),
                    def.instanceTransforms.length
                );
                updateInstancedTransforms(instMesh, def.instanceTransforms);
                object3D = instMesh;
            } else if (def.lodLevels && def.lodLevels.length > 0) {
                const lod = new THREE.LOD();
                const baseMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, metalness: 0.5, roughness: 0.5 });
                for (const lvl of def.lodLevels) {
                    const lvlMesh = new THREE.Mesh(createGeometry(lvl.geometryType || type), baseMat.clone());
                    lod.addLevel(lvlMesh, lvl.distance);
                }
                object3D = lod;
            } else {
                object3D = new THREE.Mesh(
                    createGeometry(type),
                    new THREE.MeshStandardMaterial({ color: 0x38bdf8, metalness: 0.5, roughness: 0.5 })
                );
            }

            object3D.name = id;
            applyDefinition(object3D, def);
            scene.add(object3D);
            registry.set(id, { mesh: object3D, type: typeKey });
            created++;

            // Auto-snap to terrain if at default ground level or in 3D tiles mode
            if (options.terrainManager && (options.has3DTiles || !def.position || def.position[1] === 0)) {
                options.terrainManager.snapObjectToGround(object3D);
            }
        } catch (meshErr) {
            console.warn('[3D Custom Mesh Error]:', meshErr);
        }
    });

    // Pass 2: Establish hierarchical scene-graph parenting (parentId -> parent object)
    defs.forEach((def, index) => {
        const id = customMeshDefinitionId(def, index);
        const entry = registry.get(id);
        if (!entry) return;
        const object3D = entry.mesh;

        if (def.parentId && def.parentId !== id) {
            const parentEntry = registry.get(def.parentId);
            const parentObj = parentEntry?.mesh || scene.getObjectByName(def.parentId);
            if (parentObj && parentObj !== object3D && object3D.parent !== parentObj) {
                parentObj.add(object3D);
            }
        } else if (object3D.parent && object3D.parent !== scene) {
            scene.add(object3D);
        }
    });

    for (const [id, entry] of Array.from(registry.entries())) {
        if (!seen.has(id)) {
            removeAndDispose(scene, entry.mesh);
            registry.delete(id);
            removed++;
        }
    }

    return { created, updated, removed };
}

export function disposeCustomMeshes(stack: RendererStack, registry: CustomMeshRegistry): void {
    for (const entry of registry.values()) removeAndDispose(stack.scene, entry.mesh);
    registry.clear();
}
