/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The shared triangle budget, cheap form: the triangles everything but the trees draws this frame (buildings, the
 * district context, the hero, the ground), counted as three culls them, so TreeLodController can take them off its
 * `triangleBudget` (TreeLodFrame.reservedTriangles) and the frame keeps one budget without any building LOD.
 *
 * Counted: every visible mesh (its whole ancestor chain visible) whose bounding sphere meets the camera frustum,
 * triangles x instances; for the shadow pass, every visible mesh that casts a shadow and meets the shadow camera's
 * frustum. Subtrees under `skip` (the trees GLB roots, which their controllers count) and invisible subtrees are not
 * walked, so the cost is proportional to what the rest of the scene shows (a district: a few hundred meshes).
 */

import * as THREE from 'three';

export interface SceneTriangleShare {
    /** Triangles the main pass submits for the counted meshes. */
    main: number;
    /** Triangles the shadow pass submits for them (0 without a shadow camera). */
    shadow: number;
    /** Meshes counted in the main pass. */
    meshes: number;
}

const frustum = new THREE.Frustum();
const shadowFrustum = new THREE.Frustum();
const pv = new THREE.Matrix4();
const sphere = new THREE.Sphere();

function trianglesOf(m: THREE.Mesh): number {
    const g = m.geometry as THREE.BufferGeometry | undefined;
    if (!g) return 0;
    const n = g.index ? g.index.count : (g.getAttribute('position')?.count ?? 0);
    const range = g.drawRange.count === Infinity ? n : Math.min(n, g.drawRange.count);
    const inst = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1;
    return Math.floor(range / 3) * Math.max(0, inst);
}

function worldSphere(m: THREE.Mesh): THREE.Sphere {
    const inst = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh) : undefined;
    if (inst) {
        if (!inst.boundingSphere) inst.computeBoundingSphere();
        sphere.copy(inst.boundingSphere!);
    } else {
        const g = m.geometry as THREE.BufferGeometry;
        if (!g.boundingSphere) g.computeBoundingSphere();
        sphere.copy(g.boundingSphere!);
    }
    return sphere.applyMatrix4(m.matrixWorld);
}

/**
 * The triangles the scene draws this frame outside the subtrees `skip` accepts. Matrices are read as they are (the
 * render loop updates them each frame); `camera` and `shadowCamera` have their matrices updated here.
 */
export function countSceneTriangles(scene: THREE.Object3D, camera: THREE.Camera, opts: { shadowCamera?: THREE.Camera | null; skip?: (o: THREE.Object3D) => boolean } = {}): SceneTriangleShare {
    camera.updateMatrixWorld();
    frustum.setFromProjectionMatrix(pv.multiplyMatrices((camera as THREE.PerspectiveCamera).projectionMatrix, camera.matrixWorldInverse));
    const shadowCam = opts.shadowCamera ?? null;
    if (shadowCam) {
        shadowCam.updateMatrixWorld();
        shadowFrustum.setFromProjectionMatrix(pv.multiplyMatrices((shadowCam as THREE.OrthographicCamera).projectionMatrix, shadowCam.matrixWorldInverse));
    }
    const out: SceneTriangleShare = { main: 0, shadow: 0, meshes: 0 };
    const stack: THREE.Object3D[] = [scene];
    while (stack.length > 0) {
        const o = stack.pop()!;
        if (!o.visible || (o !== scene && opts.skip?.(o))) continue;
        const m = o as THREE.Mesh;
        if (m.isMesh && m.geometry) {
            const tri = trianglesOf(m);
            if (tri > 0) {
                const s = m.frustumCulled || shadowCam ? worldSphere(m) : undefined;
                if (!m.frustumCulled || frustum.intersectsSphere(s!)) { out.main += tri; out.meshes++; }
                if (shadowCam && m.castShadow && (!m.frustumCulled || shadowFrustum.intersectsSphere(s!))) out.shadow += tri;
            }
        }
        for (const c of o.children) stack.push(c);
    }
    return out;
}
