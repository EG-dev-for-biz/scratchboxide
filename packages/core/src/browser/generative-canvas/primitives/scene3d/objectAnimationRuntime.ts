/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import type { AnimationKeyframe, PhysicsBodyConfig, Scene3DData } from '../../canvas-types';
import type { CustomMeshRegistry } from './syncCustomMeshes';

/**
 * Per-frame runtime consumer for `sb_add_physics` / `sb_insert_keyframe`.
 *
 * The operators only author declarative config onto the JSON scene record
 * (`object.physics`, `object.keyframes`); this module is what actually reads
 * that config every frame and moves the live THREE.Object3D, mirroring how
 * `syncCustomMeshes` is the runtime consumer for `customMeshes[]` creation.
 */

const GRAVITY_MS2 = -9.81;
/** Clamp integration dt so a tab-backgrounded frame gap can't explode velocity/position. */
const MAX_PHYSICS_DT_SEC = 1 / 30;
const GROUND_Y = 0;

/** Ephemeral simulation state (velocity) kept outside the JSON scene record, keyed by object id. */
export type PhysicsRuntimeState = Map<string, { velocity: THREE.Vector3 }>;

function colliderHalfExtent(physics: PhysicsBodyConfig, scale: THREE.Vector3): number {
    if (physics.colliderShape === 'sphere') {
        return Math.max(scale.x, scale.y, scale.z, 0.001) * 0.5;
    }
    // box / capsule / unknown shapes: approximate ground contact using the vertical half-extent.
    return Math.max(scale.y, 0.001) * 0.5;
}

/** Integrates one dynamic/kinematic rigid body by dt seconds, resolving contact against the ground plane. */
function stepPhysicsBody(object3d: THREE.Object3D, physics: PhysicsBodyConfig, velocity: THREE.Vector3, dt: number): void {
    if (physics.bodyType === 'static') return;
    if (physics.bodyType !== 'dynamic') return; // kinematic bodies are externally driven (e.g. by keyframes), not simulated

    velocity.y += GRAVITY_MS2 * dt;
    object3d.position.x += velocity.x * dt;
    object3d.position.y += velocity.y * dt;
    object3d.position.z += velocity.z * dt;

    const halfExtent = colliderHalfExtent(physics, object3d.scale);
    const floor = GROUND_Y + halfExtent;
    if (object3d.position.y <= floor) {
        object3d.position.y = floor;
        if (velocity.y < 0) {
            velocity.y = -velocity.y * physics.restitution;
        }
        const frictionRetain = Math.max(0, 1 - physics.friction);
        velocity.x *= frictionRetain;
        velocity.z *= frictionRetain;
        // A near-resting body with negligible restitution settles rather than micro-bouncing forever.
        if (Math.abs(velocity.y) < 0.02) velocity.y = 0;
    }
}

function easeAlpha(t: number, easing: string | undefined): number {
    switch (easing) {
        case 'easeIn': return t * t;
        case 'easeOut': return 1 - (1 - t) * (1 - t);
        case 'easeInOut': return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        case 'bounce': {
            const n1 = 7.5625, d1 = 2.75;
            let x = t;
            if (x < 1 / d1) return n1 * x * x;
            if (x < 2 / d1) { x -= 1.5 / d1; return n1 * x * x + 0.75; }
            if (x < 2.5 / d1) { x -= 2.25 / d1; return n1 * x * x + 0.9375; }
            x -= 2.625 / d1;
            return n1 * x * x + 0.984375;
        }
        case 'linear':
        default:
            return t; // also covers 'stepped' (handled before easing is applied) and 'cubicBezier' (no control points in this keyframe shape)
    }
}

function sampleChannel(sorted: AnimationKeyframe[], timeMs: number): number | [number, number, number] {
    if (timeMs <= sorted[0].timeMs) return sorted[0].value;
    const last = sorted[sorted.length - 1];
    if (timeMs >= last.timeMs) return last.value;

    for (let i = 0; i < sorted.length - 1; i++) {
        const k0 = sorted[i];
        const k1 = sorted[i + 1];
        if (timeMs < k0.timeMs || timeMs > k1.timeMs) continue;
        if (k1.easing === 'stepped') return k0.value;

        const span = k1.timeMs - k0.timeMs;
        const rawT = span > 0 ? (timeMs - k0.timeMs) / span : 1;
        const t = easeAlpha(rawT, k1.easing);

        if (Array.isArray(k0.value) && Array.isArray(k1.value)) {
            return [
                k0.value[0] + (k1.value[0] - k0.value[0]) * t,
                k0.value[1] + (k1.value[1] - k0.value[1]) * t,
                k0.value[2] + (k1.value[2] - k0.value[2]) * t
            ];
        }
        const a = typeof k0.value === 'number' ? k0.value : 0;
        const b = typeof k1.value === 'number' ? k1.value : 0;
        return a + (b - a) * t;
    }
    return last.value;
}

function applyChannelValue(object3d: THREE.Object3D, property: string, value: number | [number, number, number]): void {
    const [base, axis] = property.split('.');
    const target = base === 'position' ? object3d.position : base === 'rotation' ? object3d.rotation : base === 'scale' ? object3d.scale : null;
    if (!target) return;
    if (Array.isArray(value)) {
        target.set(value[0], value[1], value[2]);
        return;
    }
    if (axis === 'x' || axis === 'y' || axis === 'z') {
        (target as unknown as Record<'x' | 'y' | 'z', number>)[axis] = value;
    }
}

/** Plays back every property curve on `keyframes` at `timeMs`, writing directly onto the live object3d. */
export function applyKeyframesToObject3D(object3d: THREE.Object3D, keyframes: AnimationKeyframe[], timeMs: number): void {
    const byProperty = new Map<string, AnimationKeyframe[]>();
    for (const kf of keyframes) {
        const list = byProperty.get(kf.property);
        if (list) list.push(kf); else byProperty.set(kf.property, [kf]);
    }
    for (const [property, kfs] of byProperty) {
        const sorted = kfs.length > 1 ? [...kfs].sort((a, b) => a.timeMs - b.timeMs) : kfs;
        applyChannelValue(object3d, property, sampleChannel(sorted, timeMs));
    }
}

/**
 * One tick of the object-level animation runtime, called once per rendered frame from Scene3DPrimitive's
 * `animate()` loop. Resolves each config-bearing scene record to its live THREE.Object3D via the same
 * registries the mesh-sync effect populates, steps physics first, then applies authored keyframes so
 * explicit animation always wins over simulated motion.
 */
export function tickObjectAnimations(
    sceneData: Scene3DData,
    customMeshRegistry: CustomMeshRegistry,
    externalObjectsMap: Map<string, THREE.Object3D>,
    physicsState: PhysicsRuntimeState,
    timeMs: number,
    dtSec: number
): void {
    const clampedDt = Math.min(Math.max(dtSec, 0), MAX_PHYSICS_DT_SEC);
    const liveIds = new Set<string>();

    const records: Array<{ id: string; physics?: PhysicsBodyConfig; keyframes?: AnimationKeyframe[] }> = [];
    for (const mesh of sceneData.customMeshes ?? []) {
        if (mesh.physics || mesh.keyframes) records.push({ id: mesh.id, physics: mesh.physics, keyframes: mesh.keyframes });
    }
    for (const obj of sceneData.objects ?? []) {
        if (obj.physics || obj.keyframes) records.push({ id: obj.id, physics: obj.physics, keyframes: obj.keyframes });
    }

    for (const record of records) {
        const object3d = customMeshRegistry.get(record.id)?.mesh ?? externalObjectsMap.get(record.id);
        if (!object3d) continue;

        if (record.physics) {
            liveIds.add(record.id);
            let state = physicsState.get(record.id);
            if (!state) {
                state = { velocity: new THREE.Vector3(0, 0, 0) };
                physicsState.set(record.id, state);
            }
            stepPhysicsBody(object3d, record.physics, state.velocity, clampedDt);
        }

        if (record.keyframes && record.keyframes.length > 0) {
            applyKeyframesToObject3D(object3d, record.keyframes, timeMs);
        }
    }

    for (const id of physicsState.keys()) {
        if (!liveIds.has(id)) physicsState.delete(id);
    }
}
