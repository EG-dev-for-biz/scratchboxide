/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import type { TerrainManager } from '../../services/TerrainManager';
import type { RendererStack } from './types';
import { removeAndDispose } from './types';

import type { PbrTextureSet } from '../../canvas-types';
import { getPresetConfig } from './proceduralPbrTextures';
import { authoredMaterialOf } from './clayRenderMode';
import { resolveTextureUrl } from '../../../../common/texture-url-resolver';

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

/** Key on a custom mesh's userData: the pbrTextures set its material was last given, as JSON. */
const PBR_SIG_KEY = 'sbPbrSig';

/**
 * Resolves `src` (a texture-library path is exchanged for a signed GCS URL; anything else — a data
 * URI, an already-absolute URL — passes through unchanged) and loads it, dropping the texture when
 * `isCurrent` says the material or texture set it was for has been replaced while it loaded.
 */
function loadPbrTexture(
    loader: THREE.TextureLoader,
    src: string,
    isCurrent: () => boolean,
    onLoad: (tex: THREE.Texture) => void
): void {
    resolveTextureUrl(src)
        .then(resolvedUrl => {
            loader.load(
                resolvedUrl,
                (tex) => {
                    if (!isCurrent()) {
                        tex.dispose();
                        return;
                    }
                    onLoad(tex);
                },
                undefined,
                (err) => console.error(`[syncCustomMeshes] Failed to load PBR texture "${src}":`, err)
            );
        })
        .catch(err => console.error(`[syncCustomMeshes] Failed to resolve signed URL for PBR texture "${src}":`, err));
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

    obj.castShadow = true;
    obj.receiveShadow = true;

    if (obj instanceof THREE.InstancedMesh && def.instanceTransforms) {
        updateInstancedTransforms(obj, def.instanceTransforms);
    }

    const mesh = (obj instanceof THREE.Mesh ? obj : (obj.children.find(c => c instanceof THREE.Mesh) as THREE.Mesh | undefined));
    if (!mesh) return;

    obj.traverse(c => {
        if ((c as any).isMesh) {
            c.castShadow = true;
            c.receiveShadow = true;
        }
    });

    const presetName = def.material?.preset || (def.pbrTextures as any)?.preset;
    const presetConfig = presetName ? getPresetConfig(presetName) : null;

    if (def.pbrTextures) {
        const pbr = def.pbrTextures;
        const repeat = pbr.repeat || [2, 2];
        const loader = new THREE.TextureLoader();

        // Convert or ensure MeshPhysicalMaterial
        if (!(mesh.material instanceof THREE.MeshPhysicalMaterial)) {
            const oldMat = mesh.material as THREE.Material;
            mesh.material = new THREE.MeshPhysicalMaterial({
                color: (def.material?.color ?? presetConfig?.color ?? 0xffffff) as any,
                metalness: def.material?.metalness ?? presetConfig?.metalness ?? 0.1,
                roughness: def.material?.roughness ?? presetConfig?.roughness ?? 0.5,
                clearcoat: def.material?.clearcoat ?? presetConfig?.clearcoat ?? 0.0,
                clearcoatRoughness: def.material?.clearcoatRoughness ?? presetConfig?.clearcoatRoughness ?? 0.0,
                ior: def.material?.ior ?? presetConfig?.ior ?? 1.5,
                transmission: def.material?.transmission ?? presetConfig?.transmission ?? 0.0,
                wireframe: !!def.material?.wireframe
            });
            oldMat?.dispose();
        }

        const pbrMat = mesh.material as THREE.MeshPhysicalMaterial;
        // the factors multiply the maps, so they follow the definition on every sync, not only when the material is made
        try {
            pbrMat.color.set((def.material?.color ?? presetConfig?.color ?? 0xffffff) as any);
        } catch {
            pbrMat.color.set(0xffffff);
        }
        pbrMat.metalness = def.material?.metalness ?? presetConfig?.metalness ?? 0.1;
        pbrMat.roughness = def.material?.roughness ?? presetConfig?.roughness ?? 0.5;
        const albedoSrc = pbr.albedoUrl || pbr.albedoMap;
        const normalSrc = pbr.normalUrl || pbr.normalMap;
        const ormSrc = pbr.ormUrl || pbr.ormMap;
        const roughnessSrc = pbr.roughnessUrl || pbr.roughnessMap;
        const metallicSrc = pbr.metallicUrl || pbr.metalnessMap;
        const aoSrc = pbr.aoUrl || pbr.aoMap;

        // Maps the set no longer names go, so a new texture never shows over an earlier one's relief.
        if (!albedoSrc) pbrMat.map = null;
        if (!normalSrc) pbrMat.normalMap = null;
        if (!roughnessSrc && !ormSrc) pbrMat.roughnessMap = null;
        if (!metallicSrc && !ormSrc) pbrMat.metalnessMap = null;
        if (!aoSrc && !ormSrc) pbrMat.aoMap = null;

        // A load lands only on the material of the set it was started for (clay mode may be holding that material aside).
        const pbrSig = JSON.stringify(pbr);
        mesh.userData[PBR_SIG_KEY] = pbrSig;
        const isCurrent = () => mesh.userData[PBR_SIG_KEY] === pbrSig && authoredMaterialOf(mesh) === pbrMat;

        if (ormSrc) {
            loadPbrTexture(loader, ormSrc, isCurrent, (tex) => {
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
            loadPbrTexture(loader, albedoSrc, isCurrent, (tex) => {
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                tex.repeat.set(repeat[0], repeat[1]);
                tex.colorSpace = THREE.SRGBColorSpace;
                pbrMat.map = tex;
                pbrMat.needsUpdate = true;
            });
        }
        if (normalSrc) {
            loadPbrTexture(loader, normalSrc, isCurrent, (tex) => {
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
            loadPbrTexture(loader, roughnessSrc, isCurrent, (tex) => {
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                tex.repeat.set(repeat[0], repeat[1]);
                tex.colorSpace = THREE.NoColorSpace;
                pbrMat.roughnessMap = tex;
                pbrMat.needsUpdate = true;
            });
        }
        if (metallicSrc) {
            loadPbrTexture(loader, metallicSrc, isCurrent, (tex) => {
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                tex.repeat.set(repeat[0], repeat[1]);
                tex.colorSpace = THREE.NoColorSpace;
                pbrMat.metalnessMap = tex;
                pbrMat.needsUpdate = true;
            });
        }
        if (aoSrc) {
            loadPbrTexture(loader, aoSrc, isCurrent, (tex) => {
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
        if (mesh.userData[PBR_SIG_KEY] !== undefined) {
            // the texture set was removed (an undo, an edit): its maps go with it
            delete mesh.userData[PBR_SIG_KEY];
            const authored = authoredMaterialOf(mesh);
            for (const m of Array.isArray(authored) ? authored : [authored]) {
                const std = m as THREE.MeshStandardMaterial;
                if (!std.isMeshStandardMaterial) continue;
                std.map = null;
                std.normalMap = null;
                std.roughnessMap = null;
                std.metalnessMap = null;
                std.aoMap = null;
                std.needsUpdate = true;
            }
        }
        const hasPreset = !!presetConfig;
        const hasSheenOrHair = !!(def.fabricProperties || def.hairGroom || def.material?.sheen || (presetConfig && presetConfig.sheen));
        const hasGlassOrPhysical = hasPreset || hasSheenOrHair || def.material?.transmission !== undefined || def.material?.ior !== undefined || def.material?.clearcoat !== undefined;
        const fallbackCol = def.hairGroom ? 0x8b5a2b : (presetConfig?.color ?? 0x38bdf8);
        const colorVal = def.material?.color !== undefined ? def.material.color : fallbackCol;

        if (hasGlassOrPhysical && !(mesh.material instanceof THREE.MeshPhysicalMaterial)) {
            const oldMat = mesh.material as THREE.Material;
            mesh.material = new THREE.MeshPhysicalMaterial({
                color: colorVal as any,
                metalness: def.material?.metalness ?? presetConfig?.metalness ?? 0.05,
                roughness: def.material?.roughness ?? presetConfig?.roughness ?? 0.65,
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
            mat.metalness = def.material?.metalness ?? presetConfig?.metalness ?? 0.5;
            mat.roughness = def.material?.roughness ?? presetConfig?.roughness ?? 0.5;
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
                const trans = def.material?.transmission ?? presetConfig?.transmission;
                if (trans !== undefined) {
                    physMat.transmission = trans;
                    physMat.transparent = true;
                    physMat.opacity = 1.0;
                }
                const iorVal = def.material?.ior ?? presetConfig?.ior;
                if (iorVal !== undefined) {
                    physMat.ior = iorVal;
                }
                const coat = def.material?.clearcoat ?? presetConfig?.clearcoat;
                if (coat !== undefined) {
                    physMat.clearcoat = coat;
                    physMat.clearcoatRoughness = presetConfig?.clearcoatRoughness ?? 0.1;
                }
                if (def.fabricProperties) {
                    physMat.sheen = def.fabricProperties.sheenIntensity ?? 0.85;
                    physMat.sheenRoughness = 0.35;
                    physMat.sheenColor = new THREE.Color(0xffffff);
                } else if (def.hairGroom) {
                    physMat.roughness = 0.25;
                    physMat.sheen = 0.5;
                } else if (presetConfig?.sheen) {
                    physMat.sheen = presetConfig.sheen;
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
