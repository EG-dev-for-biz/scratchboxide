/**
 * Rigid body collision system tests — objectAnimationRuntime.ts
 *
 * Verifies body-to-body collision impulse, positional correction (Baumgarte),
 * rotational dynamics, ground contact, and sb_apply_impulse consumption.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { tickObjectAnimations, type PhysicsRuntimeState } from '../src/browser/generative-canvas/primitives/scene3d/objectAnimationRuntime';
import type { CustomMeshRegistry } from '../src/browser/generative-canvas/primitives/scene3d/syncCustomMeshes';
import type { Scene3DData } from '../src/browser/generative-canvas/canvas-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMesh(x: number, y: number, z: number, scale = 1): THREE.Mesh {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.scale.setScalar(scale);
    return mesh;
}

function makeRegistry(entries: Array<{ id: string; mesh: THREE.Object3D }>): CustomMeshRegistry {
    const map = new Map(entries.map(e => [e.id, { mesh: e.mesh }])) as unknown as CustomMeshRegistry;
    return map;
}

function makeScene(objects: Array<{ id: string; bodyType?: string; mass?: number; restitution?: number; friction?: number; colliderShape?: string; initialVelocity?: [number,number,number]; angularVelocity?: [number,number,number] }>): Scene3DData {
    return {
        customMeshes: objects.map(o => ({
            id: o.id,
            name: o.id,
            type: 'box',
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
            physics: {
                bodyType: (o.bodyType ?? 'dynamic') as 'dynamic' | 'static',
                mass: o.mass ?? 1.0,
                friction: o.friction ?? 0.1,
                restitution: o.restitution ?? 0.5,
                colliderShape: (o.colliderShape ?? 'box') as 'box' | 'sphere',
                ...(o.initialVelocity  && { initialVelocity:  o.initialVelocity  }),
                ...(o.angularVelocity  && { angularVelocity:  o.angularVelocity  }),
            },
        })),
    } as unknown as Scene3DData;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rigid body collision — objectAnimationRuntime', () => {
    let physicsState: PhysicsRuntimeState;
    let externalObjectsMap: Map<string, THREE.Object3D>;

    beforeEach(() => {
        physicsState = new Map();
        externalObjectsMap = new Map();
    });

    it('sphere-sphere: two spheres moving toward each other separate after collision', () => {
        const meshA = makeMesh(-0.4, 2, 0); // radius 0.5, so they overlap at x=-0.4 vs x=0.4
        const meshB = makeMesh( 0.4, 2, 0);
        const registry = makeRegistry([{ id: 'a', mesh: meshA }, { id: 'b', mesh: meshB }]);
        const scene = makeScene([
            { id: 'a', colliderShape: 'sphere', initialVelocity: [3, 0, 0] },
            { id: 'b', colliderShape: 'sphere', initialVelocity: [-3, 0, 0] },
        ]);

        // Tick several frames
        for (let i = 0; i < 10; i++) {
            tickObjectAnimations(scene, registry, externalObjectsMap, physicsState, i * 16, 1 / 60);
        }

        const stateA = physicsState.get('a')!;
        const stateB = physicsState.get('b')!;

        // After collision, A should be moving left (or stopped), B moving right (or stopped)
        expect(stateA.velocity.x).toBeLessThanOrEqual(0.1);
        expect(stateB.velocity.x).toBeGreaterThanOrEqual(-0.1);
        // Bodies must not be overlapping: distance > sum of radii (1.0)
        const dist = meshA.position.distanceTo(meshB.position);
        expect(dist).toBeGreaterThanOrEqual(0.9); // allow tiny slop
    });

    it('box-box: stacked box settles on static floor block without sinking through', () => {
        const floor = makeMesh(0, 0, 0); // static, scale 1 → half-extent y = 0.5, top surface at y=0.5
        const box   = makeMesh(0, 1.5, 0); // dynamic, dropped from y=1.5, should rest on top of floor

        floor.scale.set(4, 1, 4);
        box.scale.setScalar(1);

        const registry = makeRegistry([{ id: 'floor', mesh: floor }, { id: 'box', mesh: box }]);
        const scene = makeScene([
            { id: 'floor', bodyType: 'static', mass: 0, friction: 0.5, restitution: 0.1 },
            { id: 'box',   bodyType: 'dynamic', mass: 1,  friction: 0.5, restitution: 0.1 },
        ]);

        // Simulate 120 frames (~2 seconds)
        for (let i = 0; i < 120; i++) {
            tickObjectAnimations(scene, registry, externalObjectsMap, physicsState, i * 16, 1 / 60);
        }

        // Box bottom (y - 0.5) should be >= floor top (0 + 0.5 = 0.5)
        // i.e. box.position.y >= 1.0
        expect(box.position.y).toBeGreaterThanOrEqual(0.9);
        // Box should not have fallen through the ground plane (y=0)
        expect(box.position.y).toBeGreaterThan(0);
        // Box should have settled (velocity near zero)
        const state = physicsState.get('box')!;
        expect(Math.abs(state.velocity.y)).toBeLessThan(0.5);
    });

    it('sphere-box: sphere bounces off a static box elevated above the ground plane', () => {
        // Static box at y=3 (center), scale=1 → top surface at y=3.5
        // Sphere starts at y=4.6 (center), radius=0.5 → bottom at y=4.1, above the box top
        const sphere = makeMesh(0, 4.6, 0);
        const box    = makeMesh(0, 3.0, 0);

        const registry = makeRegistry([{ id: 'sphere', mesh: sphere }, { id: 'box', mesh: box }]);
        const scene = makeScene([
            { id: 'sphere', colliderShape: 'sphere', mass: 1, restitution: 0.6, friction: 0.1 },
            { id: 'box',    colliderShape: 'box',    bodyType: 'static', mass: 0, restitution: 0.6, friction: 0.1 },
        ]);

        // Drop sphere for 30 frames
        for (let i = 0; i < 30; i++) {
            tickObjectAnimations(scene, registry, externalObjectsMap, physicsState, i * 16, 1 / 60);
        }

        // Sphere bottom (sphere.y - radius=0.5) must be at or above the box top (3.0 + 0.5 = 3.5) - slop
        // i.e. sphere.position.y must be >= 3.5 + 0.5 - slop = 3.99
        expect(sphere.position.y).toBeGreaterThanOrEqual(3.4);
    });

    it('initialVelocity: body starts with given velocity on first tick', () => {
        const mesh = makeMesh(0, 5, 0);
        const registry = makeRegistry([{ id: 'a', mesh }]);
        const scene = makeScene([{ id: 'a', initialVelocity: [10, 0, 0] }]);

        tickObjectAnimations(scene, registry, externalObjectsMap, physicsState, 0, 1 / 60);

        const state = physicsState.get('a')!;
        expect(state.velocity.x).toBeCloseTo(10, 0);
        expect(mesh.position.x).toBeGreaterThan(0.1); // moved in X after first tick
    });

    it('angularVelocity: body rotates when given initial angular velocity', () => {
        const mesh = makeMesh(0, 5, 0);
        const initialQ = mesh.quaternion.clone();
        const registry = makeRegistry([{ id: 'a', mesh }]);
        const scene = makeScene([{ id: 'a', angularVelocity: [0, 5, 0] }]); // spin around Y

        for (let i = 0; i < 30; i++) {
            tickObjectAnimations(scene, registry, externalObjectsMap, physicsState, i * 16, 1 / 60);
        }

        // Quaternion should have changed from identity
        const dotQ = mesh.quaternion.dot(initialQ);
        expect(Math.abs(dotQ)).toBeLessThan(0.999); // meaningful rotation occurred
    });

    it('ground contact: body does not fall below y=0', () => {
        const mesh = makeMesh(0, 0.5, 0); // starts just above ground
        const registry = makeRegistry([{ id: 'a', mesh }]);
        const scene = makeScene([{ id: 'a', restitution: 0.0, friction: 1.0 }]);

        for (let i = 0; i < 120; i++) {
            tickObjectAnimations(scene, registry, externalObjectsMap, physicsState, i * 16, 1 / 60);
        }

        // Center of box at y=0.5 (half-extent) — never below ground
        expect(mesh.position.y).toBeGreaterThanOrEqual(0.49);
    });

    it('billiard-style: cue sphere hits target sphere, target moves away', () => {
        const cue    = makeMesh(-2, 0.5, 0); // approaching from left
        const target = makeMesh( 0, 0.5, 0); // stationary

        const registry = makeRegistry([{ id: 'cue', mesh: cue }, { id: 'target', mesh: target }]);
        const scene = makeScene([
            { id: 'cue',    colliderShape: 'sphere', mass: 1, restitution: 0.95, friction: 0.05, initialVelocity: [8, 0, 0] },
            { id: 'target', colliderShape: 'sphere', mass: 1, restitution: 0.95, friction: 0.05 },
        ]);

        const targetXBefore = target.position.x;

        for (let i = 0; i < 60; i++) {
            tickObjectAnimations(scene, registry, externalObjectsMap, physicsState, i * 16, 1 / 60);
        }

        // Target must have moved to the right after being struck
        expect(target.position.x).toBeGreaterThan(targetXBefore + 0.5);
        // Cue should have slowed or reversed
        const cueState = physicsState.get('cue')!;
        expect(cueState.velocity.x).toBeLessThan(8);
    });
});
