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
 * (`object.physics`, `object.keyframes`); this module reads that config every
 * frame, integrates rigid body dynamics, resolves body-to-body collisions, and
 * moves the live THREE.Object3D — mirroring how `syncCustomMeshes` is the
 * runtime consumer for `customMeshes[]` creation.
 *
 * Physics model:
 *   - Symplectic Euler integration (velocity-first, then position)
 *   - Per-body AABB (box) or sphere broadphase
 *   - Sphere–sphere, AABB–AABB (SAT), and sphere–AABB narrowphase
 *   - Impulse-based velocity resolution with friction and restitution
 *   - Baumgarte positional correction (eliminates sinking)
 *   - Angular velocity integration (quaternion) with scalar inertia tensor
 *   - Ground-plane contact (Y = 0)
 */

const GRAVITY_MS2 = -9.81;
/** Clamp integration dt so a tab-backgrounded frame gap can't explode velocity. */
const MAX_PHYSICS_DT_SEC = 1 / 30;
const GROUND_Y = 0;
/** Baumgarte stabilization fraction — pushes penetrating bodies apart over a few frames. */
const BAUMGARTE = 0.2;
/** Penetration slop — small overlaps below this threshold are not corrected (avoids jitter). */
const SLOP = 0.005;
/** Angular damping per frame to prevent perpetual spin. */
const ANGULAR_DAMPING = 0.98;
/** Linear damping applied to resting bodies on the ground. */
const LINEAR_AIR_DAMPING = 0.999;

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

export interface BodyRuntimeState {
    velocity: THREE.Vector3;
    angularVelocity: THREE.Vector3;
    /** True once the initial velocity from PhysicsBodyConfig has been consumed. */
    initialised: boolean;
}

/** Ephemeral simulation state kept outside the JSON scene record, keyed by object id. */
export type PhysicsRuntimeState = Map<string, BodyRuntimeState>;

// ---------------------------------------------------------------------------
// Collider helpers
// ---------------------------------------------------------------------------

interface SphereCollider {
    kind: 'sphere';
    center: THREE.Vector3;
    radius: number;
}

interface BoxCollider {
    kind: 'box';
    center: THREE.Vector3;
    /** Half-extents in each axis, accounting for object scale. */
    halfExtents: THREE.Vector3;
}

type Collider = SphereCollider | BoxCollider;

function buildCollider(object3d: THREE.Object3D, physics: PhysicsBodyConfig): Collider {
    const scale = new THREE.Vector3();
    object3d.getWorldScale(scale);
    const center = new THREE.Vector3();
    object3d.getWorldPosition(center);

    if (physics.colliderShape === 'sphere') {
        const radius = Math.max(scale.x, scale.y, scale.z, 0.001) * 0.5;
        return { kind: 'sphere', center, radius };
    }
    // box and capsule both approximate as AABB
    const halfExtents = new THREE.Vector3(
        Math.max(scale.x, 0.001) * 0.5,
        Math.max(scale.y, 0.001) * 0.5,
        Math.max(scale.z, 0.001) * 0.5
    );
    return { kind: 'box', center, halfExtents };
}

/** Vertical half-extent for ground contact resolution. */
function groundHalfExtent(collider: Collider): number {
    if (collider.kind === 'sphere') return collider.radius;
    return collider.halfExtents.y;
}

// ---------------------------------------------------------------------------
// Contact manifold
// ---------------------------------------------------------------------------

interface ContactManifold {
    normal: THREE.Vector3;   // from A toward B
    depth: number;           // penetration depth > 0
    point: THREE.Vector3;    // approximate contact point in world space
}

/** Sphere–sphere narrowphase. Returns null if separated. */
function testSphereSphere(a: SphereCollider, b: SphereCollider): ContactManifold | null {
    const delta = new THREE.Vector3().subVectors(b.center, a.center);
    const dist = delta.length();
    const sumR = a.radius + b.radius;
    if (dist >= sumR) return null;
    const depth = sumR - dist;
    const normal = dist > 1e-6 ? delta.divideScalar(dist) : new THREE.Vector3(0, 1, 0);
    const point = new THREE.Vector3().addVectors(a.center, normal.clone().multiplyScalar(a.radius));
    return { normal, depth, point };
}

/** AABB–AABB narrowphase via SAT on the 3 cardinal axes. Returns null if separated. */
function testBoxBox(a: BoxCollider, b: BoxCollider): ContactManifold | null {
    const dx = b.center.x - a.center.x;
    const dy = b.center.y - a.center.y;
    const dz = b.center.z - a.center.z;

    const overlapX = a.halfExtents.x + b.halfExtents.x - Math.abs(dx);
    const overlapY = a.halfExtents.y + b.halfExtents.y - Math.abs(dy);
    const overlapZ = a.halfExtents.z + b.halfExtents.z - Math.abs(dz);

    if (overlapX <= 0 || overlapY <= 0 || overlapZ <= 0) return null;

    // Minimum-penetration axis
    let depth: number;
    let normal: THREE.Vector3;
    if (overlapX <= overlapY && overlapX <= overlapZ) {
        depth = overlapX;
        normal = new THREE.Vector3(dx < 0 ? -1 : 1, 0, 0);
    } else if (overlapY <= overlapX && overlapY <= overlapZ) {
        depth = overlapY;
        normal = new THREE.Vector3(0, dy < 0 ? -1 : 1, 0);
    } else {
        depth = overlapZ;
        normal = new THREE.Vector3(0, 0, dz < 0 ? -1 : 1);
    }

    const point = new THREE.Vector3(
        a.center.x + normal.x * a.halfExtents.x,
        a.center.y + normal.y * a.halfExtents.y,
        a.center.z + normal.z * a.halfExtents.z
    );
    return { normal, depth, point };
}

/** Sphere–AABB narrowphase. Returns null if separated.
 *  Normal convention: FROM sphere (A) TOWARD box (B), consistent with all other tests. */
function testSphereBox(sphere: SphereCollider, box: BoxCollider): ContactManifold | null {
    // Closest point on AABB to sphere center
    const closest = new THREE.Vector3(
        Math.max(box.center.x - box.halfExtents.x, Math.min(sphere.center.x, box.center.x + box.halfExtents.x)),
        Math.max(box.center.y - box.halfExtents.y, Math.min(sphere.center.y, box.center.y + box.halfExtents.y)),
        Math.max(box.center.z - box.halfExtents.z, Math.min(sphere.center.z, box.center.z + box.halfExtents.z))
    );
    // delta points from box surface toward sphere — negate for "A toward B" convention
    const delta = new THREE.Vector3().subVectors(sphere.center, closest);
    const dist = delta.length();
    if (dist >= sphere.radius) return null;
    const depth = sphere.radius - dist;
    // Negate so normal points from sphere (A) toward box (B)
    const normal = dist > 1e-6
        ? delta.clone().negate().divideScalar(dist)
        : new THREE.Vector3(0, -1, 0);
    // Contact point: sphere surface in the direction toward the box
    const point = new THREE.Vector3().addVectors(sphere.center, normal.clone().multiplyScalar(sphere.radius));
    return { normal, depth, point };
}

function testColliders(a: Collider, b: Collider): ContactManifold | null {
    if (a.kind === 'sphere' && b.kind === 'sphere') return testSphereSphere(a, b);
    if (a.kind === 'box'    && b.kind === 'box')    return testBoxBox(a, b);
    if (a.kind === 'sphere' && b.kind === 'box')    return testSphereBox(a, b);
    if (a.kind === 'box'    && b.kind === 'sphere') {
        const m = testSphereBox(b, a);
        if (m) m.normal.negate();
        return m;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Inertia
// ---------------------------------------------------------------------------

function scalarInertia(physics: PhysicsBodyConfig, object3d: THREE.Object3D): number {
    if (physics.inertiaTensor !== undefined) return physics.inertiaTensor;
    const scale = new THREE.Vector3();
    object3d.getWorldScale(scale);
    const m = physics.mass > 0 ? physics.mass : 1;
    if (physics.colliderShape === 'sphere') {
        const r = Math.max(scale.x, scale.y, scale.z) * 0.5;
        return 0.4 * m * r * r;
    }
    // Box: I = m/12 * (w² + h²) — use largest two dimensions
    const dims = [scale.x, scale.y, scale.z].sort((a, b) => b - a);
    return (m / 12) * (dims[0] * dims[0] + dims[1] * dims[1]);
}

// ---------------------------------------------------------------------------
// Impulse resolution
// ---------------------------------------------------------------------------

function resolveImpulse(
    velA: THREE.Vector3, angVelA: THREE.Vector3, invMassA: number, invInertiaA: number, centerA: THREE.Vector3,
    velB: THREE.Vector3, angVelB: THREE.Vector3, invMassB: number, invInertiaB: number, centerB: THREE.Vector3,
    contact: ContactManifold,
    restitution: number,
    friction: number
): void {
    // Vectors from each body's center of mass to the contact point
    const rA = new THREE.Vector3().subVectors(contact.point, centerA);
    const rB = new THREE.Vector3().subVectors(contact.point, centerB);

    const relVel = new THREE.Vector3()
        .addVectors(
            velB.clone().add(new THREE.Vector3().crossVectors(angVelB, rB)),
            velA.clone().negate().sub(new THREE.Vector3().crossVectors(angVelA, rA))
        );

    const velAlongNormal = relVel.dot(contact.normal);
    if (velAlongNormal > 0) return; // separating — no impulse needed

    const rAxN = new THREE.Vector3().crossVectors(rA, contact.normal);
    const rBxN = new THREE.Vector3().crossVectors(rB, contact.normal);

    const denominator =
        invMassA + invMassB +
        rAxN.dot(rAxN) * invInertiaA +
        rBxN.dot(rBxN) * invInertiaB;

    if (denominator < 1e-10) return;

    const j = -(1 + restitution) * velAlongNormal / denominator;
    const impulse = contact.normal.clone().multiplyScalar(j);

    velA.addScaledVector(impulse, -invMassA);
    velB.addScaledVector(impulse,  invMassB);
    angVelA.addScaledVector(new THREE.Vector3().crossVectors(rA, impulse).negate(), invInertiaA);
    angVelB.addScaledVector(new THREE.Vector3().crossVectors(rB, impulse),          invInertiaB);

    // Friction impulse (tangential)
    const tangent = new THREE.Vector3()
        .subVectors(relVel, contact.normal.clone().multiplyScalar(relVel.dot(contact.normal)))
        .normalize();
    const jt = -relVel.dot(tangent) / denominator;
    const maxFriction = Math.abs(j) * friction;
    const frictionImpulse = tangent.multiplyScalar(Math.max(-maxFriction, Math.min(jt, maxFriction)));

    velA.addScaledVector(frictionImpulse, -invMassA);
    velB.addScaledVector(frictionImpulse,  invMassB);
}

// ---------------------------------------------------------------------------
// Per-body entry used in the collision pass
// ---------------------------------------------------------------------------

interface BodyEntry {
    id: string;
    object3d: THREE.Object3D;
    physics: PhysicsBodyConfig;
    state: BodyRuntimeState;
    collider: Collider;
    invMass: number;
    invInertia: number;
}

// ---------------------------------------------------------------------------
// Integration and ground contact
// ---------------------------------------------------------------------------

function integrateDynamicBody(entry: BodyEntry, dt: number): void {
    const { object3d, physics, state } = entry;
    const vel = state.velocity;

    // Apply gravity
    vel.y += GRAVITY_MS2 * dt;

    // Air damping
    vel.multiplyScalar(LINEAR_AIR_DAMPING);
    state.angularVelocity.multiplyScalar(ANGULAR_DAMPING);

    // Integrate position
    object3d.position.x += vel.x * dt;
    object3d.position.y += vel.y * dt;
    object3d.position.z += vel.z * dt;

    // Integrate rotation via angular velocity
    const omega = state.angularVelocity;
    const omegaLen = omega.length();
    if (omegaLen > 1e-6) {
        const angle = omegaLen * dt;
        const axis = omega.clone().normalize();
        const dq = new THREE.Quaternion().setFromAxisAngle(axis, angle);
        object3d.quaternion.premultiply(dq).normalize();
    }
}

function resolveGroundContact(entry: BodyEntry): void {
    const { object3d, physics, state } = entry;
    const collider = entry.collider;
    const halfY = groundHalfExtent(collider);
    const floor = GROUND_Y + halfY;

    if (object3d.position.y <= floor) {
        object3d.position.y = floor;

        // Normal impulse along Y
        if (state.velocity.y < 0) {
            state.velocity.y = -state.velocity.y * physics.restitution;
        }
        // Ground friction on X/Z
        const frictionRetain = Math.max(0, 1 - physics.friction);
        state.velocity.x *= frictionRetain;
        state.velocity.z *= frictionRetain;

        // Settle micro-bouncing
        if (Math.abs(state.velocity.y) < 0.02) state.velocity.y = 0;

        // Damp angular velocity on ground contact (rolling friction)
        state.angularVelocity.multiplyScalar(1 - physics.friction * 0.5);
    }
}

// ---------------------------------------------------------------------------
// Main tick
// ---------------------------------------------------------------------------

/**
 * One tick of the object-level animation runtime, called once per rendered frame from Scene3DPrimitive's
 * `animate()` loop. Steps physics (integration → broadphase → narrowphase → impulse → Baumgarte),
 * then applies authored keyframes so explicit animation always wins over simulated motion.
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

    // ------------------------------------------------------------------
    // 1. Collect all records that carry physics or keyframe config
    // ------------------------------------------------------------------
    const records: Array<{ id: string; physics?: PhysicsBodyConfig; keyframes?: AnimationKeyframe[] }> = [];
    for (const mesh of sceneData.customMeshes ?? []) {
        if (mesh.physics || mesh.keyframes) records.push({ id: mesh.id, physics: mesh.physics, keyframes: mesh.keyframes });
    }
    for (const obj of sceneData.objects ?? []) {
        if (obj.physics || obj.keyframes) records.push({ id: obj.id, physics: obj.physics, keyframes: obj.keyframes });
    }

    // ------------------------------------------------------------------
    // 2. Build live BodyEntry list for dynamic/static bodies
    // ------------------------------------------------------------------
    const bodies: BodyEntry[] = [];
    const liveIds = new Set<string>();

    for (const record of records) {
        if (!record.physics) continue;
        const object3d = customMeshRegistry.get(record.id)?.mesh ?? externalObjectsMap.get(record.id);
        if (!object3d) continue;

        liveIds.add(record.id);
        let state = physicsState.get(record.id);
        if (!state) {
            state = { velocity: new THREE.Vector3(), angularVelocity: new THREE.Vector3(), initialised: false };
            physicsState.set(record.id, state);
        }

        // Consume initial velocity from config once
        if (!state.initialised) {
            if (record.physics.initialVelocity) {
                const [vx, vy, vz] = record.physics.initialVelocity;
                state.velocity.set(vx, vy, vz);
            }
            if (record.physics.angularVelocity) {
                const [ax, ay, az] = record.physics.angularVelocity;
                state.angularVelocity.set(ax, ay, az);
            }
            state.initialised = true;
        }

        // Consume pending impulse from sb_apply_impulse
        const pending = record.physics as PhysicsBodyConfig & { _pendingImpulse?: [number,number,number]; _pendingAngularImpulse?: [number,number,number] };
        if (pending._pendingImpulse) {
            const [dvx, dvy, dvz] = pending._pendingImpulse;
            state.velocity.x += dvx; state.velocity.y += dvy; state.velocity.z += dvz;
            delete pending._pendingImpulse;
        }
        if (pending._pendingAngularImpulse) {
            const [dax, day, daz] = pending._pendingAngularImpulse;
            state.angularVelocity.x += dax; state.angularVelocity.y += day; state.angularVelocity.z += daz;
            delete pending._pendingAngularImpulse;
        }

        const invMass = record.physics.bodyType === 'dynamic' && record.physics.mass > 0
            ? 1 / record.physics.mass : 0;
        const invInertia = invMass > 0 ? 1 / Math.max(scalarInertia(record.physics, object3d), 1e-6) : 0;

        const collider = buildCollider(object3d, record.physics);
        bodies.push({ id: record.id, object3d, physics: record.physics, state, collider, invMass, invInertia });
    }

    // ------------------------------------------------------------------
    // 3. Integrate dynamic bodies
    // ------------------------------------------------------------------
    for (const entry of bodies) {
        if (entry.physics.bodyType !== 'dynamic') continue;
        integrateDynamicBody(entry, clampedDt);
    }

    // ------------------------------------------------------------------
    // 4. Rebuild colliders after integration (positions changed)
    // ------------------------------------------------------------------
    for (const entry of bodies) {
        entry.collider = buildCollider(entry.object3d, entry.physics);
    }

    // ------------------------------------------------------------------
    // 5. Broadphase + Narrowphase + Impulse resolution (body-to-body)
    //    O(n²) — fine for scene-scale object counts (<~200 bodies)
    // ------------------------------------------------------------------
    for (let i = 0; i < bodies.length; i++) {
        const a = bodies[i];
        const isDynA = a.physics.bodyType === 'dynamic';

        for (let j = i + 1; j < bodies.length; j++) {
            const b = bodies[j];
            const isDynB = b.physics.bodyType === 'dynamic';

            // At least one body must be dynamic for there to be a response
            if (!isDynA && !isDynB) continue;

            const contact = testColliders(a.collider, b.collider);
            if (!contact || contact.depth <= 0) continue;

            const restitution = Math.min(a.physics.restitution, b.physics.restitution);
            const friction    = Math.sqrt(a.physics.friction * b.physics.friction);

            // Velocity impulse — rA/rB are computed from each body's center of mass
            const centerA = a.collider.kind === 'sphere' ? a.collider.center : a.collider.center;
            const centerB = b.collider.kind === 'sphere' ? b.collider.center : b.collider.center;
            resolveImpulse(
                a.state.velocity, a.state.angularVelocity, a.invMass, a.invInertia, centerA,
                b.state.velocity, b.state.angularVelocity, b.invMass, b.invInertia, centerB,
                contact, restitution, friction
            );

            // Positional correction (Baumgarte) — pushes bodies apart to eliminate sinking
            const correction = Math.max(contact.depth - SLOP, 0) * BAUMGARTE / (a.invMass + b.invMass + 1e-10);
            if (isDynA) a.object3d.position.addScaledVector(contact.normal, -correction * a.invMass);
            if (isDynB) b.object3d.position.addScaledVector(contact.normal,  correction * b.invMass);

            // Rebuild colliders for the corrected positions so subsequent pairs are accurate this tick
            if (isDynA) a.collider = buildCollider(a.object3d, a.physics);
            if (isDynB) b.collider = buildCollider(b.object3d, b.physics);
        }
    }

    // ------------------------------------------------------------------
    // 6. Ground plane contact for dynamic bodies
    // ------------------------------------------------------------------
    for (const entry of bodies) {
        if (entry.physics.bodyType !== 'dynamic') continue;
        resolveGroundContact(entry);
    }

    // ------------------------------------------------------------------
    // 7. Garbage-collect stale physics state
    // ------------------------------------------------------------------
    for (const id of physicsState.keys()) {
        if (!liveIds.has(id)) physicsState.delete(id);
    }

    // ------------------------------------------------------------------
    // 8. Keyframe playback (wins over simulated motion)
    // ------------------------------------------------------------------
    for (const record of records) {
        if (!record.keyframes || record.keyframes.length === 0) continue;
        const object3d = customMeshRegistry.get(record.id)?.mesh ?? externalObjectsMap.get(record.id);
        if (!object3d) continue;
        applyKeyframesToObject3D(object3d, record.keyframes, timeMs);
    }
}

// ---------------------------------------------------------------------------
// Keyframe playback (unchanged)
// ---------------------------------------------------------------------------

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
            return t;
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
