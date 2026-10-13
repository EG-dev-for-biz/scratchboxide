/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Verifies that sb_add_physics / sb_insert_keyframe config is actually consumed per-frame:
 * tickObjectAnimations is the runtime that Scene3DPrimitive's animate() loop calls every
 * frame, and this test exercises it directly against real THREE.Object3D instances with no
 * WebGL context, the same way the config would be read from a live Scene3DData.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { tickObjectAnimations } from '../src/browser/generative-canvas/primitives/scene3d/objectAnimationRuntime';
import type { PhysicsRuntimeState } from '../src/browser/generative-canvas/primitives/scene3d/objectAnimationRuntime';
import type { CustomMeshRegistry } from '../src/browser/generative-canvas/primitives/scene3d/syncCustomMeshes';
import type { Scene3DData } from '../src/browser/generative-canvas/canvas-types';

function meshAt(id: string, position: [number, number, number], scale: [number, number, number] = [1, 1, 1]): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    mesh.position.set(...position);
    mesh.scale.set(...scale);
    return mesh;
}

function registryWith(entries: Array<[string, THREE.Object3D]>): CustomMeshRegistry {
    const registry: CustomMeshRegistry = new Map();
    for (const [id, mesh] of entries) registry.set(id, { mesh, type: 'box' });
    return registry;
}

describe('tickObjectAnimations (sb_add_physics / sb_insert_keyframe runtime consumer)', () => {
    it('falls a dynamic body under gravity and leaves a static body untouched', () => {
        const dynamicMesh = meshAt('ball', [0, 10, 0]);
        const staticMesh = meshAt('floor-slab', [0, 5, 0]);

        const sceneData: Scene3DData = {
            title: 'Physics Test',
            customMeshes: [
                { id: 'ball', position: [0, 10, 0], scale: [1, 1, 1], physics: { bodyType: 'dynamic', mass: 1, friction: 0.5, restitution: 0.3, colliderShape: 'sphere' } },
                { id: 'floor-slab', position: [0, 5, 0], scale: [1, 1, 1], physics: { bodyType: 'static', mass: 1, friction: 0.5, restitution: 0.3, colliderShape: 'box' } }
            ]
        };

        const registry = registryWith([['ball', dynamicMesh], ['floor-slab', staticMesh]]);
        const physicsState: PhysicsRuntimeState = new Map();

        tickObjectAnimations(sceneData, registry, new Map(), physicsState, 0, 1 / 60);

        expect(dynamicMesh.position.y).toBeLessThan(10);
        expect(staticMesh.position.y).toBe(5);
        expect(physicsState.has('ball')).toBe(true);
    });

    it('bounces a high-restitution falling sphere off the ground plane without ever piercing the floor', () => {
        const ball = meshAt('bouncing-ball', [0, 20, 0]);
        const sceneData: Scene3DData = {
            title: 'Bounce Test',
            customMeshes: [
                { id: 'bouncing-ball', position: [0, 20, 0], scale: [1, 1, 1], physics: { bodyType: 'dynamic', mass: 2.5, friction: 0.3, restitution: 0.85, colliderShape: 'sphere' } }
            ]
        };
        const registry = registryWith([['bouncing-ball', ball]]);
        const physicsState: PhysicsRuntimeState = new Map();

        const dt = 1 / 60;
        let sawBounce = false;
        for (let i = 0; i < 600; i++) {
            const velocityBefore = physicsState.get('bouncing-ball')?.velocity.y ?? 0;
            tickObjectAnimations(sceneData, registry, new Map(), physicsState, i * dt * 1000, dt);
            expect(ball.position.y).toBeGreaterThanOrEqual(0.5 - 1e-6); // sphere radius 0.5, never below floor
            const velocityAfter = physicsState.get('bouncing-ball')!.velocity.y;
            if (velocityBefore < -0.5 && velocityAfter > 0) sawBounce = true;
        }
        // restitution 0.85 dissipates energy slowly (geometric decay of bounce height), so within
        // these 10 simulated seconds it is still mid-bounce rather than at rest — that is correct
        // physical behaviour for this restitution, not a settling failure.
        expect(sawBounce).toBe(true);
    });

    it('settles a low-restitution falling box to rest on the ground plane', () => {
        const box = meshAt('settling-box', [0, 2, 0]);
        const sceneData: Scene3DData = {
            title: 'Settle Test',
            customMeshes: [
                { id: 'settling-box', position: [0, 2, 0], scale: [1, 1, 1], physics: { bodyType: 'dynamic', mass: 1, friction: 0.5, restitution: 0.2, colliderShape: 'box' } }
            ]
        };
        const registry = registryWith([['settling-box', box]]);
        const physicsState: PhysicsRuntimeState = new Map();

        const dt = 1 / 60;
        for (let i = 0; i < 300; i++) {
            tickObjectAnimations(sceneData, registry, new Map(), physicsState, i * dt * 1000, dt);
            expect(box.position.y).toBeGreaterThanOrEqual(0.5 - 1e-6);
        }

        expect(Math.abs(physicsState.get('settling-box')!.velocity.y)).toBeLessThan(0.05);
        expect(box.position.y).toBeCloseTo(0.5, 2);
    });

    it('interpolates a linear position keyframe at the midpoint', () => {
        const mesh = meshAt('kf-mesh', [0, 20, 0]);
        const sceneData: Scene3DData = {
            title: 'Keyframe Test',
            customMeshes: [{
                id: 'kf-mesh',
                position: [0, 20, 0],
                keyframes: [
                    { property: 'position', timeMs: 0, value: [0, 20, 0], easing: 'linear' },
                    { property: 'position', timeMs: 1000, value: [0, 0, 0], easing: 'linear' }
                ]
            }]
        };
        const registry = registryWith([['kf-mesh', mesh]]);

        tickObjectAnimations(sceneData, registry, new Map(), new Map(), 500, 1 / 60);

        expect(mesh.position.y).toBeCloseTo(10, 5);
        expect(mesh.position.x).toBeCloseTo(0, 5);
    });

    it('holds a stepped keyframe at the earlier value until the exact next keyframe time', () => {
        const mesh = meshAt('stepped-mesh', [0, 0, 0]);
        const sceneData: Scene3DData = {
            title: 'Stepped Keyframe Test',
            customMeshes: [{
                id: 'stepped-mesh',
                position: [0, 0, 0],
                keyframes: [
                    { property: 'position.y', timeMs: 0, value: 1, easing: 'linear' },
                    { property: 'position.y', timeMs: 1000, value: 9, easing: 'stepped' }
                ]
            }]
        };
        const registry = registryWith([['stepped-mesh', mesh]]);

        tickObjectAnimations(sceneData, registry, new Map(), new Map(), 999, 1 / 60);
        expect(mesh.position.y).toBe(1);

        tickObjectAnimations(sceneData, registry, new Map(), new Map(), 1000, 1 / 60);
        expect(mesh.position.y).toBe(9);
    });

    it('lets authored keyframes override physics on the same object (keyframes applied after physics)', () => {
        const mesh = meshAt('hybrid', [0, 20, 0]);
        const sceneData: Scene3DData = {
            title: 'Hybrid Test',
            customMeshes: [{
                id: 'hybrid',
                position: [0, 20, 0],
                physics: { bodyType: 'dynamic', mass: 1, friction: 0.5, restitution: 0.5, colliderShape: 'box' },
                keyframes: [{ property: 'position.y', timeMs: 0, value: 42, easing: 'linear' }]
            }]
        };
        const registry = registryWith([['hybrid', mesh]]);

        tickObjectAnimations(sceneData, registry, new Map(), new Map(), 0, 1 / 60);

        expect(mesh.position.y).toBe(42);
    });

    it('does not move a kinematic body under gravity (externally driven only)', () => {
        const mesh = meshAt('platform', [0, 8, 0]);
        const sceneData: Scene3DData = {
            title: 'Kinematic Test',
            customMeshes: [{
                id: 'platform',
                position: [0, 8, 0],
                physics: { bodyType: 'kinematic', mass: 1, friction: 0.5, restitution: 0.5, colliderShape: 'box' }
            }]
        };
        const registry = registryWith([['platform', mesh]]);
        const physicsState: PhysicsRuntimeState = new Map();

        for (let i = 0; i < 30; i++) {
            tickObjectAnimations(sceneData, registry, new Map(), physicsState, i * 16, 1 / 60);
        }

        expect(mesh.position.y).toBe(8);
    });

    it('resolves Media4DObject entries (sceneData.objects) via the external objects map', () => {
        const mesh = meshAt('media-obj', [0, 10, 0]);
        const sceneData: Scene3DData = {
            title: 'Media4D Test',
            objects: [{
                id: 'media-obj',
                content: { type: 'model', durableUri: 'blob://x' } as any,
                space: {} as any,
                physics: { bodyType: 'dynamic', mass: 1, friction: 0.5, restitution: 0.5, colliderShape: 'box' }
            }]
        };
        const externalObjectsMap = new Map<string, THREE.Object3D>([['media-obj', mesh]]);

        tickObjectAnimations(sceneData, new Map(), externalObjectsMap, new Map(), 0, 1 / 60);

        expect(mesh.position.y).toBeLessThan(10);
    });

    it('prunes physics runtime state once an object no longer carries a physics config', () => {
        const mesh = meshAt('temp', [0, 10, 0]);
        const sceneData: Scene3DData = {
            title: 'Prune Test',
            customMeshes: [{ id: 'temp', position: [0, 10, 0], physics: { bodyType: 'dynamic', mass: 1, friction: 0.5, restitution: 0.5, colliderShape: 'box' } }]
        };
        const registry = registryWith([['temp', mesh]]);
        const physicsState: PhysicsRuntimeState = new Map();

        tickObjectAnimations(sceneData, registry, new Map(), physicsState, 0, 1 / 60);
        expect(physicsState.has('temp')).toBe(true);

        delete sceneData.customMeshes![0].physics;
        tickObjectAnimations(sceneData, registry, new Map(), physicsState, 16, 1 / 60);
        expect(physicsState.has('temp')).toBe(false);
    });
});
