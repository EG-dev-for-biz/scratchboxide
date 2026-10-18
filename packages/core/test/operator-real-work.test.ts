/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The direct-dispatch operators either do the work on the real mesh or fail with a typed error: no constant
 * normals, no stand-in primitives, no literal watertight flags. Each case here fails on the old fake behaviour.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DirectDispatchOperatorEngine, computeMeshStatsFromGeometry } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import { ViewportHistory } from '../src/browser/generative-canvas/services/viewport-history';
import {
    applyBurleySubsurfaceScattering,
    applyFilamentClothSheen,
    simulateGeomorphologyOnGeometry
} from '../src/browser/generative-canvas/services/headless-realism-service';
import type { Scene3DData } from '../src/browser/generative-canvas/canvas-types';
import { saveViewportSnapshot } from './helpers/scene3d-viewport-snapshot';

function liveEngine(meshes: THREE.Mesh[], data: Partial<Scene3DData> = {}) {
    const engine = new DirectDispatchOperatorEngine({ title: 'ops', customMeshes: [], objects: [], ...data } as Scene3DData);
    const scene = new THREE.Scene();
    for (const m of meshes) scene.add(m);
    scene.updateMatrixWorld(true);
    engine.attachThreeScene(scene);
    return { engine, scene };
}

function named(name: string, geometry: THREE.BufferGeometry): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x9aa0a6 }));
    mesh.name = name;
    return mesh;
}

/** Resolves `#include <chunk>` the way three's WebGLProgram does, so the injected GLSL can be read in context. */
function resolveIncludes(src: string, depth = 0): string {
    if (depth > 8) return src;
    return src.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_m, name: string) => {
        const chunk = (THREE.ShaderChunk as Record<string, string>)[name];
        return chunk === undefined ? '' : resolveIncludes(chunk, depth + 1);
    });
}

/** The fragment shader a material's onBeforeCompile produces, with chunks resolved. */
function compiledFragment(material: THREE.Material): string {
    const shader: any = {
        uniforms: {},
        vertexShader: THREE.ShaderLib.physical.vertexShader,
        fragmentShader: THREE.ShaderLib.physical.fragmentShader
    };
    material.onBeforeCompile(shader, undefined as any);
    return resolveIncludes(shader.fragmentShader);
}

describe('router: undo snapshots share blobs instead of re-serialising the scene', () => {
    it('keeps typed arrays as the same buffers through dispatch and undo', () => {
        const vertices = new Float32Array([0, 1, 2, 3, 4, 5]);
        const engine = new DirectDispatchOperatorEngine({
            title: 't',
            customMeshes: [{ id: 'a', type: 'box', position: [0, 0, 0], scale: [1, 1, 1], vertices } as any],
            objects: []
        });
        engine.dispatch('sb_translate', { objectId: 'a', delta: [1, 0, 0] });
        expect(engine.getSceneData().customMeshes![0].position).toEqual([1, 0, 0]);
        expect(engine.dispatch('sb_undo', {}).success).toBe(true);
        const restored = (engine.getSceneData().customMeshes![0] as any).vertices;
        // A JSON round trip turns a Float32Array into a plain object and copies it.
        expect(restored).toBeInstanceOf(Float32Array);
        expect(restored.buffer).toBe(vertices.buffer);
        expect(engine.getSceneData().customMeshes![0].position).toEqual([0, 0, 0]);
        // The action log is a log: undo is appended to it, not rolled back.
        expect(engine.getActionLog().map(a => a.operator)).toEqual(['sb_translate', 'sb_undo']);
    });
});

describe('objects that exist only in the viewport', () => {
    it('are edited live without being written into the scene data as stand-in shapes', () => {
        const part = named('generated-part', new THREE.SphereGeometry(1, 8, 6));
        const { engine } = liveEngine([part]);
        expect(engine.dispatch('sb_translate', { objectId: 'generated-part', delta: [2, 0, 0] }).success).toBe(true);
        expect(part.position.x).toBe(2);
        expect(engine.getSceneData().customMeshes).toEqual([]);
    });
});

describe('geometry operators need the live mesh', () => {
    it('fails with not_available_here when no viewport is attached (the server path)', () => {
        const engine = new DirectDispatchOperatorEngine({ title: 't', customMeshes: [{ id: 'hero', type: 'box' }], objects: [] } as Scene3DData);
        for (const op of ['sb_subdivide_mesh', 'sb_loop_subdivide', 'sb_smooth_mesh', 'sb_get_mesh_stats', 'sb_taper_mesh', 'sb_sculpt_stroke']) {
            const res = engine.dispatch(op, { objectId: 'hero', factor: 0.5, center: [0, 0, 0], radius: 1, strength: 1, brush: 'clay' });
            expect(res.success, op).toBe(false);
            expect(res.errorCode, op).toBe('not_available_here');
        }
        const ray = engine.dispatch('sb_raycast_mesh', { targetMeshId: 'hero', origin: [0, 5, 0], direction: [0, -1, 0] });
        expect(ray.errorCode).toBe('not_available_here');
        // Nothing was recorded as done.
        expect(engine.getOperatorStack()).toEqual([]);
    });

    it('removed operators are not in the registry', () => {
        const engine = new DirectDispatchOperatorEngine();
        for (const op of ['sb_extrude_faces', 'sb_boolean_op', 'sb_decimate_mesh_qem', 'sb_simulate_rigidbody_physics', 'sb_add_mesh', 'sb_simulate_particles', 'sb_ai_render_viewport', 'sb_add_modifier']) {
            expect(engine.getOperator(op), op).toBeUndefined();
        }
    });
});

describe('sb_raycast_mesh intersects the triangles, not the bounding box', () => {
    it('hits the sphere top with an upward normal and misses past its silhouette', () => {
        const ball = named('ball', new THREE.SphereGeometry(1, 48, 24));
        ball.position.set(0, 2, 0);
        const { engine } = liveEngine([ball]);
        const down = engine.dispatch('sb_raycast_mesh', { targetMeshId: 'ball', origin: [0, 10, 0], direction: [0, -1, 0] });
        expect(down.success).toBe(true);
        expect(down.data.hit).toBe(true);
        expect(down.data.position[1]).toBeCloseTo(3, 2);
        expect(down.data.distance).toBeCloseTo(7, 2);
        expect(down.data.normal[1]).toBeGreaterThan(0.99);
        // Inside the bounding box corner but outside the sphere.
        const corner = engine.dispatch('sb_raycast_mesh', { targetMeshId: 'ball', origin: [0.9, 10, 0.9], direction: [0, -1, 0] });
        expect(corner.data.hit).toBe(false);
        // A side hit has a sideways normal.
        const side = engine.dispatch('sb_raycast_mesh', { origin: [10, 2, 0], direction: [-1, 0, 0] });
        expect(side.data.hit).toBe(true);
        expect(side.data.normal[0]).toBeGreaterThan(0.99);
        expect(side.data.meshName).toBe('ball');
    });
});

describe('sb_get_mesh_stats measures the mesh', () => {
    it('reports watertight only for closed surfaces and counts the real edges', () => {
        const closed = computeMeshStatsFromGeometry(new THREE.BoxGeometry(2, 2, 2));
        // The box's faces are split at the corners; welded it is a closed 12-triangle surface with 18 edges.
        expect(closed.isWatertight).toBe(true);
        expect(closed.edgeCount).toBe(18);
        expect(closed.volume).toBeCloseTo(8, 4);
        const open = computeMeshStatsFromGeometry(new THREE.PlaneGeometry(2, 2, 2, 2));
        expect(open.isWatertight).toBe(false);
        expect(open.boundaryEdgeCount).toBe(8);
        expect(open.volume).toBeNull();
    });
});

describe('subdivision works on the mesh in the viewport', () => {
    it('Loop-subdivides the real sphere (not a stand-in box) and undo swaps the original back', () => {
        const ball = named('ball', new THREE.SphereGeometry(1, 16, 12));
        const original = ball.geometry;
        const { engine, scene } = liveEngine([ball], { customMeshes: [{ id: 'ball', type: 'sphere' }] as any });
        const history = new ViewportHistory({ maxBytes: 50_000_000, maxEntries: 100 });
        engine.attachHistory(history);
        const before = computeMeshStatsFromGeometry(original);
        const res = engine.dispatch('sb_loop_subdivide', { objectId: 'ball', iterations: 1 });
        expect(res.success).toBe(true);
        expect(res.data.faceCount).toBe(before.faceCount * 4);
        expect(ball.geometry).not.toBe(original);
        // Every vertex stays near the unit sphere (a box stand-in would put corners at sqrt(3)/2 or beyond).
        const pos = ball.geometry.getAttribute('position');
        for (let i = 0; i < pos.count; i++) {
            const r = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
            expect(r).toBeGreaterThan(0.9);
            expect(r).toBeLessThan(1.0001);
        }
        expect(computeMeshStatsFromGeometry(ball.geometry).isWatertight).toBe(true);
        const camera = new THREE.PerspectiveCamera(45, 4 / 3, 0.1, 100);
        camera.position.set(2.5, 2, 3);
        camera.lookAt(0, 0, 0);
        const shot = saveViewportSnapshot('operator_real_work/loop_subdivided_sphere', scene, camera, { highlight: ball });
        expect(shot.drawnPixels).toBeGreaterThan(1000);
        history.undo();
        expect(ball.geometry).toBe(original);
        history.redo();
        expect(computeMeshStatsFromGeometry(ball.geometry).faceCount).toBe(before.faceCount * 4);
    });

    it('midpoint subdivision keeps the shape and interpolates uvs', () => {
        const box = named('crate', new THREE.BoxGeometry(2, 2, 2));
        const { engine } = liveEngine([box]);
        const res = engine.dispatch('sb_subdivide_mesh', { objectId: 'crate', iterations: 2 });
        expect(res.data.faceCount).toBe(12 * 16);
        expect(res.data.droppedAttributes).toEqual([]);
        box.geometry.computeBoundingBox();
        expect(box.geometry.boundingBox!.max.toArray()).toEqual([1, 1, 1]);
        expect(box.geometry.getAttribute('uv').count).toBe(res.data.vertexCount);
    });
});

describe('sb_set_origin moves the pivot, not the mesh', () => {
    it('keeps every vertex where it is in the world', () => {
        const box = named('crate', new THREE.BoxGeometry(2, 4, 2));
        box.position.set(3, 1, -2);
        box.rotation.set(0, Math.PI / 3, 0.2);
        box.scale.set(1.5, 0.5, 2);
        const { engine } = liveEngine([box], { customMeshes: [{ id: 'crate', type: 'box', position: [3, 1, -2] }] as any });
        const worldBefore = Array.from({ length: 8 }, (_, i) => new THREE.Vector3().fromBufferAttribute(box.geometry.getAttribute('position') as THREE.BufferAttribute, i).applyMatrix4(box.matrixWorld));
        const res = engine.dispatch('sb_set_origin', { objectId: 'crate', originType: 'bottom' });
        expect(res.success).toBe(true);
        box.updateMatrixWorld(true);
        const pos = box.geometry.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < 8; i++) {
            const now = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(box.matrixWorld);
            expect(now.distanceTo(worldBefore[i])).toBeLessThan(1e-5);
        }
        box.geometry.computeBoundingBox();
        expect(box.geometry.boundingBox!.min.y).toBeCloseTo(0, 6);
        expect(engine.getSceneData().customMeshes![0].position).toEqual(box.position.toArray());
    });
});

describe('headless realism fixes', () => {
    it('the subsurface back-scatter writes to light terms that exist where it is injected', () => {
        const mesh = named('skin', new THREE.SphereGeometry(1, 8, 6));
        mesh.material = new THREE.MeshPhysicalMaterial();
        applyBurleySubsurfaceScattering(mesh, {});
        const frag = compiledFragment(mesh.material as THREE.Material);
        const injected = frag.indexOf('uSssScatterColor * sssBackDot');
        expect(injected).toBeGreaterThan(0);
        const injectedLine = frag.slice(frag.lastIndexOf('\n', injected), frag.indexOf('\n', injected));
        // The old shader added to outgoingLight here, before three declares it.
        expect(injectedLine).not.toMatch(/\boutgoingLight\b/);
        expect(frag.search(/ReflectedLight\s+reflectedLight\b/)).toBeLessThan(injected);
        expect(frag.search(/vec3\s+outgoingLight\b/)).toBeGreaterThan(injected);
        // directionalLights[] only exists when the scene has directional lights.
        expect(frag.lastIndexOf('#if NUM_DIR_LIGHTS > 0', injected)).toBeGreaterThan(frag.search(/ReflectedLight\s+reflectedLight\b/));
    });

    it('the cloth sheen does not use outgoingLight before it is declared', () => {
        const mesh = named('cloth', new THREE.PlaneGeometry(1, 1));
        applyFilamentClothSheen(mesh, {});
        const frag = compiledFragment(mesh.material as THREE.Material);
        const firstUse = frag.search(/\boutgoingLight\b/);
        const declaration = frag.search(/vec3\s+outgoingLight\b/);
        expect(declaration).toBeGreaterThan(-1);
        expect(firstUse).toBe(declaration + frag.slice(declaration).search(/\boutgoingLight\b/));
    });

    it('erosion links both ends of every edge and works on seam-split meshes', () => {
        const plane = new THREE.PlaneGeometry(4, 4, 8, 8);
        plane.rotateX(-Math.PI / 2);
        const pos = plane.getAttribute('position') as THREE.BufferAttribute;
        let peak = -1;
        for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getX(i)) < 1e-6 && Math.abs(pos.getZ(i)) < 1e-6) peak = i;
        pos.setY(peak, 2);
        const split = plane.toNonIndexed();
        const result = simulateGeomorphologyOnGeometry(split, { iterations: 5 });
        expect(result.vertexCount).toBe(81);
        expect(result.maxHeightChange).toBeGreaterThan(0.01);
        // Every copy of the peak moved together.
        const ys = new Set<number>();
        const sp = split.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < sp.count; i++) if (Math.abs(sp.getX(i)) < 1e-6 && Math.abs(sp.getZ(i)) < 1e-6) ys.add(sp.getY(i));
        expect(ys.size).toBe(1);
        expect([...ys][0]).toBeLessThan(2);
    });
});
