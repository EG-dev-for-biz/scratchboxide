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

export interface CustomMeshDefinition {
    id?: string;
    name?: string;
    type?: string;
    position?: [number, number, number];
    rotation?: [number, number, number];
    scale?: [number, number, number];
    material?: { color?: number | string; metalness?: number; roughness?: number; wireframe?: boolean; [k: string]: any };
}

/** Meshes created by this slice, keyed by definition id. Owned by the primitive via a ref. */
export type CustomMeshRegistry = Map<string, { mesh: THREE.Mesh; type: string }>;

export function customMeshDefinitionId(def: CustomMeshDefinition, index: number): string {
    return def.id || def.name || `custom-mesh-${index}`;
}

function createGeometry(type: string | undefined): THREE.BufferGeometry {
    if (type === 'sphere') return new THREE.SphereGeometry(1, 16, 16);
    if (type === 'cylinder') return new THREE.CylinderGeometry(1, 1, 2, 16);
    if (type === 'plane') return new THREE.PlaneGeometry(2, 2);
    if (type === 'torus') return new THREE.TorusGeometry(1, 0.4, 16, 50);
    return new THREE.BoxGeometry(1, 1, 1);
}

function applyDefinition(mesh: THREE.Mesh, def: CustomMeshDefinition): void {
    if (def.name) mesh.userData.name = def.name;
    if (def.position) mesh.position.set(...def.position);
    if (def.rotation) mesh.rotation.set(...def.rotation);
    if (def.scale) mesh.scale.set(...def.scale);
    const mat = mesh.material as THREE.MeshStandardMaterial;
    if (mat && (mat as any).isMeshStandardMaterial) {
        mat.color.set(def.material?.color !== undefined ? Number(def.material.color) : 0x38bdf8);
        mat.metalness = def.material?.metalness ?? 0.5;
        mat.roughness = def.material?.roughness ?? 0.5;
        mat.wireframe = !!def.material?.wireframe;
        mat.needsUpdate = true;
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
        const type = def.type || 'box';

        try {
            const existing = registry.get(id);
            if (existing && existing.type === type) {
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

            const mesh = new THREE.Mesh(
                createGeometry(type),
                new THREE.MeshStandardMaterial({ color: 0x38bdf8, metalness: 0.5, roughness: 0.5 })
            );
            mesh.name = id;
            applyDefinition(mesh, def);
            scene.add(mesh);
            registry.set(id, { mesh, type });
            created++;

            // Auto-snap to terrain if at default ground level or in 3D tiles mode
            if (options.terrainManager && (options.has3DTiles || !def.position || def.position[1] === 0)) {
                options.terrainManager.snapObjectToGround(mesh);
            }
        } catch (meshErr) {
            console.warn('[3D Custom Mesh Error]:', meshErr);
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
