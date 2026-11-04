/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The viewport's walk mode on small synthetic meshes built from raw buffers: the ground follow, the step up onto kerbs
 * and stairs, the fall off a ledge, the slide along a wall, and the triangle hierarchy that answers the queries. Every
 * test asserts where the walker ends up.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { TriangleBvh, WalkCollisionWorld, closestSegmentTriangle, triangleBvhOf } from '../src/browser/generative-canvas/primitives/scene3d/walkCollision';
import { WALK_DEFAULTS, Walker, walkInputOf } from '../src/browser/generative-canvas/primitives/scene3d/walkMode';
import type { WalkInput } from '../src/browser/generative-canvas/primitives/scene3d/walkMode';

const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });

function meshOf(positions: number[]): THREE.Mesh {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return new THREE.Mesh(g, material);
}

/** A level rectangle at height y. */
function floor(x0: number, z0: number, x1: number, z1: number, y = 0): number[] {
    return [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z0, x1, y, z1, x0, y, z1];
}

/** A closed axis-aligned box (12 triangles). */
function box(min: [number, number, number], max: [number, number, number]): number[] {
    const [a, b, c] = min, [d, e, f] = max;
    const v = [[a, b, c], [d, b, c], [d, e, c], [a, e, c], [a, b, f], [d, b, f], [d, e, f], [a, e, f]];
    const faces = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]];
    return faces.flatMap(([p, q, r, s]) => [...v[p], ...v[q], ...v[r], ...v[p], ...v[r], ...v[s]]);
}

/** A vertical quad in the plane x = const, spanning z0..z1 and y0..y1 (zero thickness). */
function wallX(x: number, z0: number, z1: number, y0: number, y1: number): number[] {
    return [x, y0, z0, x, y0, z1, x, y1, z1, x, y0, z0, x, y1, z1, x, y1, z0];
}

/** A vertical quad in the plane z = const. */
function wallZ(z: number, x0: number, x1: number, y0: number, y1: number): number[] {
    return [x0, y0, z, x1, y0, z, x1, y1, z, x0, y0, z, x1, y1, z, x0, y1, z];
}

/** A slope rising toward -z: height (z0 - z) * tan(deg) from z0 to z1 (z1 < z0), across x0..x1. */
function slope(x0: number, x1: number, z0: number, z1: number, deg: number, y0 = 0): number[] {
    const top = y0 + (z0 - z1) * Math.tan(THREE.MathUtils.degToRad(deg));
    return [x0, y0, z0, x1, y0, z0, x1, top, z1, x0, y0, z0, x1, top, z1, x0, top, z1];
}

function sceneOf(...parts: number[][]): THREE.Scene {
    const scene = new THREE.Scene();
    for (const p of parts) scene.add(meshOf(p));
    scene.updateMatrixWorld(true);
    return scene;
}

const FORWARD: WalkInput = { forward: 1, right: 0, up: 0, run: false };
const STILL: WalkInput = { forward: 0, right: 0, up: 0, run: false };

/** Steps the walker for `seconds` at a fixed frame interval. */
function walk(w: Walker, seconds: number, input: WalkInput, dt = 1 / 60): void {
    const frames = Math.round(seconds / dt);
    for (let i = 0; i < frames; i++) w.step(dt, input);
}

/** A walker at x, z facing -Z (yaw 0), dropped from 2 m up. */
function walkerIn(scene: THREE.Scene, x = 0, z = 0, yaw = 0): Walker {
    const w = new Walker(new WalkCollisionWorld(scene));
    w.placeAt(new THREE.Vector3(x, 2, z), yaw, 0);
    return w;
}

describe('walk mode: ground follow', () => {
    it('stands the eye 1.7 m above the floor and walks 1.4 m/s on the level, at any frame rate', () => {
        const scene = sceneOf(floor(-50, -50, 50, 50));
        const at60 = walkerIn(scene);
        expect(at60.grounded).toBe(true);
        expect(at60.feet.y).toBeCloseTo(0, 6);
        expect(at60.eye(new THREE.Vector3()).y).toBeCloseTo(WALK_DEFAULTS.eyeHeight, 6);
        walk(at60, 2, FORWARD, 1 / 60);
        expect(at60.feet.z).toBeCloseTo(-2.8, 3);
        expect(at60.feet.x).toBeCloseTo(0, 6);
        expect(at60.feet.y).toBeCloseTo(0, 6);

        const at20 = walkerIn(scene);
        walk(at20, 2, FORWARD, 1 / 20);
        expect(at20.feet.z).toBeCloseTo(at60.feet.z, 3);

        const run = walkerIn(scene);
        walk(run, 1, { ...FORWARD, run: true });
        expect(run.feet.z).toBeCloseTo(-5, 3);
    });

    it('moves on the horizontal plane whatever the pitch, and turns with yaw', () => {
        const scene = sceneOf(floor(-50, -50, 50, 50));
        const w = walkerIn(scene, 0, 0, Math.PI / 2); // facing -X
        w.pitch = -1.2; // looking steeply down
        walk(w, 1, FORWARD);
        expect(w.feet.x).toBeCloseTo(-1.4, 3);
        expect(w.feet.z).toBeCloseTo(0, 3);
        expect(w.feet.y).toBeCloseTo(0, 6);
    });

    it('keeps the feet on a 20 degree slope up and down', () => {
        const deg = 20;
        const scene = sceneOf(floor(-5, -5, 5, 5), slope(-5, 5, -5, -15, deg), floor(-5, -15, 5, -30, 10 * Math.tan(THREE.MathUtils.degToRad(deg))));
        const w = walkerIn(scene);
        walk(w, 4, FORWARD); // 5.6 m: 0.6 m up the slope
        const expected = (-5 - w.feet.z) * Math.tan(THREE.MathUtils.degToRad(deg));
        expect(w.feet.z).toBeCloseTo(-5.6, 2);
        expect(w.feet.y).toBeCloseTo(expected, 2);
        expect(w.grounded).toBe(true);
        // and back down: the walker keeps to the slope (it never leaves the ground, so it never falls)
        w.yaw = Math.PI;
        for (let i = 0; i < 120; i++) { w.step(1 / 60, FORWARD); expect(w.grounded).toBe(true); }
        expect(w.feet.y).toBeCloseTo(0, 6);
    });

    it('follows a floor under a moved, rotated and scaled parent', () => {
        const scene = new THREE.Scene();
        const parent = new THREE.Group();
        parent.position.set(3, 2.5, -1);
        parent.rotation.y = 0.7;
        parent.scale.setScalar(2);
        parent.add(meshOf(floor(-20, -20, 20, 20, 0.25))); // world height 2.5 + 2 * 0.25
        scene.add(parent);
        scene.updateMatrixWorld(true);
        const w = new Walker(new WalkCollisionWorld(scene));
        w.placeAt(new THREE.Vector3(3, 8, -1), 0, 0);
        expect(w.feet.y).toBeCloseTo(3, 5);
        walk(w, 1, FORWARD);
        expect(w.feet.y).toBeCloseTo(3, 5);
    });

    it('holds its height over nothing, and a hidden or vetoed floor is nothing', () => {
        const scene = sceneOf(floor(-50, -50, 50, 50));
        scene.children[0].visible = false;
        const w = walkerIn(scene);
        expect(w.overVoid).toBe(true);
        walk(w, 1, STILL);
        expect(w.feet.y).toBeCloseTo(2, 6);

        scene.children[0].visible = true;
        const vetoed = new Walker(new WalkCollisionWorld(scene, mesh => mesh !== scene.children[0]));
        vetoed.placeAt(new THREE.Vector3(0, 2, 0), 0, 0);
        expect(vetoed.overVoid).toBe(true);
    });
});

describe('walk mode: steps and falls', () => {
    it('steps up a 15 cm kerb and down again; a 60 cm block stops it', () => {
        // kerb from z = -2 to z = -6 (top 0.15), then street again; a 0.6 m block beyond
        const scene = sceneOf(floor(-50, -50, 50, 50), box([-5, 0, -6], [5, 0.15, -2]), box([-5, 0, -12], [5, 0.6, -10]));
        const w = walkerIn(scene);
        walk(w, 2, FORWARD); // z = -2.8: on the kerb
        expect(w.feet.y).toBeCloseTo(0.15, 6);
        expect(w.grounded).toBe(true);
        walk(w, 3, FORWARD); // z = -7: off the far edge, down on the street (0.15 is within stepDown: no fall)
        expect(w.feet.z).toBeCloseTo(-7, 2);
        expect(w.feet.y).toBeCloseTo(0, 6);
        walk(w, 4, FORWARD); // into the block's face at z = -10
        expect(w.feet.y).toBeCloseTo(0, 6);
        expect(w.feet.z).toBeGreaterThan(-10 + WALK_DEFAULTS.radius * 0.5);
        expect(w.feet.z).toBeLessThan(-9.5);
    });

    it('the eye eases onto a step instead of jumping', () => {
        const scene = sceneOf(floor(-50, -50, 50, 50), box([-5, 0, -10], [5, 0.3, -1]));
        const w = walkerIn(scene);
        const eye = new THREE.Vector3();
        let maxJump = 0, lastEye = w.eye(eye).y;
        for (let i = 0; i < 120; i++) {
            w.step(1 / 60, FORWARD);
            const y = w.eye(eye).y;
            maxJump = Math.max(maxJump, Math.abs(y - lastEye));
            lastEye = y;
        }
        expect(w.feet.y).toBeCloseTo(0.3, 6);
        expect(lastEye).toBeCloseTo(0.3 + WALK_DEFAULTS.eyeHeight, 2);
        expect(maxJump).toBeLessThan(0.1); // the feet rose 0.3 m in one substep
    });

    it('climbs a flight of 18 cm stairs', () => {
        const steps: number[][] = [floor(-50, -50, 50, 50)];
        for (let i = 0; i < 6; i++) steps.push(box([-3, 0, -2 - 0.3 * (i + 1)], [3, 0.18 * (i + 1), -2 - 0.3 * i]));
        steps.push(box([-3, 0, -20], [3, 1.08, -3.8]));
        const scene = sceneOf(...steps);
        const w = walkerIn(scene);
        walk(w, 3, FORWARD); // z = -4.2: on the landing
        expect(w.feet.z).toBeCloseTo(-4.2, 2);
        expect(w.feet.y).toBeCloseTo(1.08, 6);
    });

    it('falls off a 3 m ledge under gravity and lands on the ground below', () => {
        const scene = sceneOf(floor(-50, -50, 50, 50), box([-5, 0, -1], [5, 3, 5]));
        const w = new Walker(new WalkCollisionWorld(scene));
        w.placeAt(new THREE.Vector3(0, 4, 0), 0, 0);
        expect(w.feet.y).toBeCloseTo(3, 6);
        // walk to the edge (z = -1) and off it
        let leftAt = -1, t = 0;
        const heights: number[] = [];
        for (let i = 0; i < 180; i++) {
            w.step(1 / 60, FORWARD);
            t += 1 / 60;
            if (leftAt < 0 && !w.grounded) leftAt = t;
            if (leftAt >= 0) heights.push(w.feet.y);
        }
        expect(leftAt).toBeGreaterThan(0);
        // in the air for sqrt(2 h / g) = 0.78 s: a third of a second after leaving it is still well above the ground
        const third = heights[Math.round(0.33 * 60)];
        expect(third).toBeLessThan(3 - 0.4);
        expect(third).toBeGreaterThan(1.5);
        expect(w.grounded).toBe(true);
        expect(w.feet.y).toBeCloseTo(0, 6);
        expect(w.vy).toBe(0);
    });

    it('cannot walk up a 60 degree slope', () => {
        const scene = sceneOf(floor(-50, -50, 50, 50), slope(-5, 5, -2, -10, 60));
        const w = walkerIn(scene);
        walk(w, 4, FORWARD);
        expect(w.feet.y).toBeLessThan(WALK_DEFAULTS.stepUp + 0.01);
        expect(w.feet.z).toBeGreaterThan(-2.5);
    });
});

describe('walk mode: walls', () => {
    it('slides along a wall it walks into at 45 degrees instead of stopping or passing it', () => {
        const scene = sceneOf(floor(-50, -50, 50, 50), wallX(1, -50, 50, 0, 10));
        const w = walkerIn(scene, 0, 0, -Math.PI / 4); // forward = (+X, -Z) / sqrt 2
        walk(w, 3, FORWARD);
        expect(w.feet.x).toBeLessThanOrEqual(1 - WALK_DEFAULTS.radius + 0.002);
        expect(w.feet.x).toBeGreaterThan(1 - WALK_DEFAULTS.radius - 0.01);
        // the move along the wall carries on: 1.4 m/s * 3 s * cos 45 = 2.97 m
        expect(w.feet.z).toBeLessThan(-2.9);
    });

    it('stays in a corner it walks into', () => {
        const scene = sceneOf(floor(-50, -50, 50, 50), wallX(1, -50, 50, 0, 10), wallZ(-1, -50, 50, 0, 10));
        const w = walkerIn(scene, 0, 0, -Math.PI / 4);
        walk(w, 3, { ...FORWARD, run: true });
        expect(w.feet.x).toBeCloseTo(1 - WALK_DEFAULTS.radius, 2);
        expect(w.feet.z).toBeCloseTo(-1 + WALK_DEFAULTS.radius, 2);
    });

    it('a run at 10 frames a second never tunnels through a zero-thickness wall', () => {
        const scene = sceneOf(floor(-50, -50, 50, 50), wallZ(-2, -50, 50, 0, 10));
        const w = walkerIn(scene);
        walk(w, 3, { ...FORWARD, run: true }, 0.1);
        expect(w.feet.z).toBeGreaterThan(-2 + WALK_DEFAULTS.radius - 0.01);
        expect(w.feet.z).toBeLessThan(-2 + WALK_DEFAULTS.radius + 0.01);
    });

    it('a pole of one instanced mesh blocks the way, its other instances elsewhere', () => {
        const pole = new THREE.BufferGeometry();
        pole.setAttribute('position', new THREE.Float32BufferAttribute(box([-0.1, 0, -0.1], [0.1, 3, 0.1]), 3));
        const poles = new THREE.InstancedMesh(pole, material, 3);
        [[20, 0], [0, -3], [-20, 0]].forEach(([x, z], i) => poles.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, 0, z)));
        const scene = sceneOf(floor(-50, -50, 50, 50));
        scene.add(poles);
        scene.updateMatrixWorld(true);
        const w = walkerIn(scene);
        walk(w, 4, FORWARD);
        expect(w.feet.z).toBeCloseTo(-3 + 0.1 + WALK_DEFAULTS.radius, 2);
    });

    it('meets a mesh that moved into its way since the scene was last read', () => {
        const scene = sceneOf(floor(-50, -50, 50, 50));
        const pole = meshOf(box([-0.1, 0, -0.1], [0.1, 3, 0.1]));
        pole.position.set(20, 0, 0);
        scene.add(pole);
        scene.updateMatrixWorld(true);
        const w = walkerIn(scene);
        pole.position.set(0, 0, -3);
        pole.updateMatrixWorld(true);
        walk(w, 4, FORWARD);
        expect(w.feet.z).toBeCloseTo(-3 + 0.1 + WALK_DEFAULTS.radius, 2);
    });
});

describe('walk mode: flying', () => {
    it('flies along the view, pitch included, with no gravity; back to walking it falls to the ground', () => {
        const scene = sceneOf(floor(-50, -50, 50, 50));
        const w = walkerIn(scene);
        w.setMode('fly');
        w.pitch = Math.PI / 6;
        walk(w, 1, FORWARD);
        expect(w.feet.y).toBeCloseTo(WALK_DEFAULTS.flySpeed * Math.sin(Math.PI / 6), 3);
        expect(w.feet.z).toBeCloseTo(-WALK_DEFAULTS.flySpeed * Math.cos(Math.PI / 6), 3);
        w.setMode('walk');
        walk(w, 3, STILL);
        expect(w.grounded).toBe(true);
        expect(w.feet.y).toBeCloseTo(0, 6);
    });

    it('reads movement from key codes', () => {
        expect(walkInputOf({ KeyW: true, ShiftLeft: true })).toEqual({ forward: 1, right: 0, up: 0, run: true });
        expect(walkInputOf({ ArrowDown: true, KeyA: true, KeyQ: true })).toEqual({ forward: -1, right: -1, up: -1, run: false });
        expect(walkInputOf({ KeyW: true, KeyS: true })).toEqual({ forward: 0, right: 0, up: 0, run: false });
    });
});

describe('walk mode: the triangle hierarchy', () => {
    /** A bumpy terrain of n x n cells. */
    function terrain(n: number): THREE.BufferGeometry {
        const pos: number[] = [];
        const h = (x: number, z: number) => Math.sin(x * 0.7) * Math.cos(z * 0.4) * 2;
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
            const x0 = i - n / 2, z0 = j - n / 2, x1 = x0 + 1, z1 = z0 + 1;
            pos.push(x0, h(x0, z0), z0, x1, h(x1, z0), z0, x1, h(x1, z1), z1, x0, h(x0, z0), z0, x1, h(x1, z1), z1, x0, h(x0, z1), z1);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        return g;
    }

    it('finds the same nearest crossing as testing every triangle', () => {
        const g = terrain(40);
        const bvh = triangleBvhOf(g)!;
        expect(bvh.triangleCount).toBe(40 * 40 * 2);
        const mesh = new THREE.Mesh(g, material);
        const raycaster = new THREE.Raycaster();
        let seed = 7;
        const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        const out = { triangle: -1 };
        for (let i = 0; i < 200; i++) {
            const o = new THREE.Vector3(rand() * 40 - 20, 5 + rand() * 5, rand() * 40 - 20);
            const d = new THREE.Vector3(rand() - 0.5, -rand(), rand() - 0.5).normalize();
            raycaster.set(o, d);
            raycaster.far = 30;
            const brute = raycaster.intersectObject(mesh)[0];
            const s = bvh.segmentHit(o.x, o.y, o.z, d.x * 30, d.y * 30, d.z * 30, out);
            if (!brute) { expect(s).toBe(Infinity); continue; }
            expect(s * 30).toBeCloseTo(brute.distance, 4);
        }
    });

    it('drops collapsed triangles and is rebuilt when the index changes', () => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(floor(-1, -1, 1, 1), 3));
        g.setIndex([0, 1, 2, 3, 4, 5]);
        const first = triangleBvhOf(g)!;
        expect(first.triangleCount).toBe(2);
        expect(triangleBvhOf(g)).toBe(first);
        const index = g.index!;
        index.setXYZ(3, 3, 3, 3); // a hidden part: one corner three times
        index.needsUpdate = true;
        const second = triangleBvhOf(g)!;
        expect(second).not.toBe(first);
        expect(second.triangleCount).toBe(1);
    });

    it('a box query visits every triangle the box touches', () => {
        const g = terrain(30);
        const bvh = new TriangleBvh(new Float32Array(g.getAttribute('position').array as Float32Array), new Uint32Array(Array.from({ length: 30 * 30 * 6 }, (_, i) => i)));
        const seen = new Set<number>();
        bvh.trianglesInBox(-2, -10, -2, 2, 10, 2, k => seen.add(k));
        // a 4 x 4 m column holds 4 x 4 cells of 2 triangles (plus the cells its edges touch)
        expect(seen.size).toBeGreaterThanOrEqual(32);
        expect(seen.size).toBeLessThan(200);
    });

    it('measures segment-to-triangle distance', () => {
        const a = new THREE.Vector3(0, 0, 0), b = new THREE.Vector3(2, 0, 0), c = new THREE.Vector3(0, 0, 2);
        const s = new THREE.Vector3(), t = new THREE.Vector3();
        // a vertical segment above the triangle's interior
        expect(closestSegmentTriangle(new THREE.Vector3(0.5, 1, 0.5), new THREE.Vector3(0.5, 3, 0.5), a, b, c, s, t)).toBeCloseTo(1, 9);
        expect(t.toArray()).toEqual([0.5, 0, 0.5]);
        // a vertical segment beside the hypotenuse: the nearest point is on that edge
        const d2 = closestSegmentTriangle(new THREE.Vector3(2, -1, 2), new THREE.Vector3(2, 1, 2), a, b, c, s, t);
        expect(d2).toBeCloseTo(2, 9); // distance sqrt 2 from (2, 0, 2) to (1, 0, 1)
        // a segment through the triangle
        expect(closestSegmentTriangle(new THREE.Vector3(0.5, -1, 0.5), new THREE.Vector3(0.5, 1, 0.5), a, b, c, s, t)).toBe(0);
    });
});
