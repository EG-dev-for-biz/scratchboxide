/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The sky's sun casts camera-fitted cascaded shadows (sunShadowCascades.ts): the view cut into logarithmic slices, each
 * slice in its own square box, sized in fixed steps and centred on whole texels. What the shader relies on is checked
 * on the fit itself: every point the view shows at a depth falls inside the box of the cascade that depth selects,
 * with the casters toward the sun in front of its near plane; the near box is a few centimetres a texel at street
 * level; turning or nudging the camera does not make the boxes crawl; from the air the boxes keep to the district.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
    CascadedSunLight, SUN_SHADOW_CASCADES, SunCascadeShadow, fitSunCascades, sunCascadeSplits, type SunCascadeFit
} from '../src/browser/generative-canvas/primitives/scene3d/sunShadowCascades';
import { installSoftShadowChunks, patchShadowChunk } from '../src/browser/generative-canvas/primitives/scene3d/softShadowChunk';

const RESOLUTION = 1996;

function camera(position: [number, number, number], target: [number, number, number]): THREE.PerspectiveCamera {
    const cam = new THREE.PerspectiveCamera(45, 1.6, 0.1, 20000);
    cam.position.set(...position);
    cam.lookAt(...target);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    return cam;
}

/** Sun 20 degrees up in the south-west (the location sky's afternoon sun). */
const toSun = new THREE.Vector3(Math.cos(THREE.MathUtils.degToRad(20)) * Math.sin(THREE.MathUtils.degToRad(225)), Math.sin(THREE.MathUtils.degToRad(20)), Math.cos(THREE.MathUtils.degToRad(20)) * Math.cos(THREE.MathUtils.degToRad(225))).normalize();

function cascadeCamera(fit: SunCascadeFit, i: number): THREE.OrthographicCamera {
    const c = fit.cascades[i];
    const cam = new THREE.OrthographicCamera(-c.halfSize, c.halfSize, c.halfSize, -c.halfSize, c.near, c.far);
    cam.position.copy(c.position);
    cam.quaternion.copy(fit.orientation);
    cam.updateMatrixWorld(true);
    return cam;
}

/** The cascade the shader reads for a view depth: the nearest whose range holds it. */
function cascadeFor(fit: SunCascadeFit, depth: number): number {
    return fit.cascades.findIndex(c => depth >= c.data.x && depth < c.data.y);
}

/** Points the camera sees: along rays through a grid of the frame, at depths spread over [near, far]. */
function viewPoints(cam: THREE.PerspectiveCamera, near: number, far: number): Array<{ p: THREE.Vector3; depth: number }> {
    const out: Array<{ p: THREE.Vector3; depth: number }> = [];
    for (let ix = -1; ix <= 1; ix += 0.25) for (let iy = -1; iy <= 1; iy += 0.25) for (let k = 0; k <= 40; k++) {
        const depth = near * Math.pow(far / near, k / 40);
        const ndc = new THREE.Vector3(ix, iy, -1).applyMatrix4(cam.projectionMatrixInverse);
        const view = ndc.multiplyScalar(depth / -ndc.z);
        out.push({ p: view.applyMatrix4(cam.matrixWorld), depth });
    }
    return out;
}

function expectInsideBox(cam: THREE.OrthographicCamera, p: THREE.Vector3, slack = 1e-6): void {
    const q = p.clone().applyMatrix4(cam.matrixWorldInverse);
    expect(Math.abs(q.x)).toBeLessThanOrEqual(cam.right * (1 + slack));
    expect(Math.abs(q.y)).toBeLessThanOrEqual(cam.top * (1 + slack));
    expect(-q.z).toBeGreaterThanOrEqual(cam.near);
    expect(-q.z).toBeLessThanOrEqual(cam.far);
}

describe('camera-fitted cascaded sun shadows', () => {
    it('splits the view logarithmically: a short first slice, each later one longer', () => {
        const s = sunCascadeSplits(0.1, 1500, 4);
        expect(s).toHaveLength(5);
        expect(s[0]).toBe(0.1);
        expect(s[4]).toBe(1500);
        expect(s[1]).toBeGreaterThanOrEqual(4);
        expect(s[1]).toBeLessThan(25);
        for (let i = 1; i < 4; i++) expect(s[i + 1] / s[i]).toBeGreaterThan(2);
    });

    it('at street level every visible point falls in the box of its cascade, and the near box is a few centimetres a texel', () => {
        const cam = camera([0, 1.7, 0], [0, 1.5, -100]);
        const fit = fitSunCascades({ camera: cam, toSun, resolution: RESOLUTION, maxDistance: 1500, casterReach: 1000 });
        expect(fit.cascades).toHaveLength(SUN_SHADOW_CASCADES);
        expect(fit.splits[0]).toBeCloseTo(cam.near, 9);
        expect(fit.splits[SUN_SHADOW_CASCADES]).toBe(1500);
        const cams = fit.cascades.map((_, i) => cascadeCamera(fit, i));
        let checked = 0;
        for (const { p, depth } of viewPoints(cam, cam.near, 1499)) {
            const i = cascadeFor(fit, depth);
            expect(i).toBeGreaterThanOrEqual(0);
            expectInsideBox(cams[i], p);
            checked++;
        }
        expect(checked).toBeGreaterThan(3000);
        const nearTexel = (2 * fit.cascades[0].halfSize) / RESOLUTION;
        expect(nearTexel).toBeGreaterThan(0.005);
        expect(nearTexel).toBeLessThanOrEqual(0.04);
        // casters toward the sun: a point on the receiver, 300 m up the sun's direction, is still in front of the near plane
        for (const [i, c] of cams.entries()) {
            const mid = new THREE.Vector3(0, 0, -(fit.splits[i] + fit.splits[i + 1]) / 2).applyMatrix4(cam.matrixWorld);
            expectInsideBox(c, mid.clone().addScaledVector(toSun, Math.min(300, 0.9 * 1000)), 1e9);
        }
    });

    it('turning the camera keeps every box the same size, and a nudge keeps them on whole texels', () => {
        const a = fitSunCascades({ camera: camera([0, 1.7, 0], [0, 1.5, -100]), toSun, resolution: RESOLUTION, maxDistance: 1500, casterReach: 1000 });
        const turned = fitSunCascades({ camera: camera([0, 1.7, 0], [70, 1.5, -70]), toSun, resolution: RESOLUTION, maxDistance: 1500, casterReach: 1000 });
        const nudged = fitSunCascades({ camera: camera([0.0013, 1.7, -0.0021], [0.0013, 1.5, -100.0021]), toSun, resolution: RESOLUTION, maxDistance: 1500, casterReach: 1000 });
        const toLight = new THREE.Matrix4().makeRotationFromQuaternion(a.orientation).transpose();
        for (let i = 0; i < SUN_SHADOW_CASCADES; i++) {
            expect(turned.cascades[i].halfSize).toBe(a.cascades[i].halfSize);
            expect(nudged.cascades[i].halfSize).toBe(a.cascades[i].halfSize);
            const texel = (2 * a.cascades[i].halfSize) / RESOLUTION;
            for (const fit of [a, turned, nudged]) {
                const c = fit.cascades[i].position.clone().applyMatrix4(toLight);
                expect(Math.abs(c.x / texel - Math.round(c.x / texel))).toBeLessThan(1e-6);
                expect(Math.abs(c.y / texel - Math.round(c.y / texel))).toBeLessThan(1e-6);
            }
            // a nudge of a couple of millimetres moves a box by whole texels, never a fraction (here: at most one)
            const da = a.cascades[i].position.clone().applyMatrix4(toLight), dn = nudged.cascades[i].position.clone().applyMatrix4(toLight);
            expect(Math.abs(dn.x - da.x) / texel).toBeLessThanOrEqual(1 + 1e-6);
            expect(Math.abs(dn.y - da.y) / texel).toBeLessThanOrEqual(1 + 1e-6);
        }
    });

    it('from the air the cascades keep to the district: its depth range, its extent, and every caster in it', () => {
        const cam = camera([0, 600, 800], [0, 0, 0]);
        const content = new THREE.Box3(new THREE.Vector3(-300, 0, -300), new THREE.Vector3(300, 380, 300));
        const fit = fitSunCascades({ camera: cam, toSun, resolution: RESOLUTION, maxDistance: 3000, casterReach: 1000, content });
        // the slices start where the district does, not at the lens, and end where it ends
        expect(fit.splits[0]).toBeGreaterThan(400);
        expect(fit.splits[SUN_SHADOW_CASCADES]).toBeLessThan(1500);
        const cams = fit.cascades.map((_, i) => cascadeCamera(fit, i));
        // no box wider than the district seen along the sun (its far slices would otherwise span the whole frame, ~1 km)
        for (const c of fit.cascades) expect(c.halfSize).toBeLessThan(560);
        // every visible point of the district is in its cascade's box
        const corners: THREE.Vector3[] = [];
        for (let x = -300; x <= 300; x += 50) for (let z = -300; z <= 300; z += 50) for (const y of [0, 120, 380]) corners.push(new THREE.Vector3(x, y, z));
        const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
        let checked = 0;
        for (const p of corners) {
            if (!frustum.containsPoint(p)) continue;
            const depth = -p.clone().applyMatrix4(cam.matrixWorldInverse).z;
            const i = cascadeFor(fit, depth);
            expect(i).toBeGreaterThanOrEqual(0);
            expectInsideBox(cams[i], p, 1e-6);
            checked++;
        }
        expect(checked).toBeGreaterThan(100);
        // every caster in the district is in front of each box's near plane
        for (const c of cams) {
            for (let k = 0; k < 8; k++) {
                const p = new THREE.Vector3(k & 1 ? 300 : -300, k & 2 ? 380 : 0, k & 4 ? 300 : -300).applyMatrix4(c.matrixWorldInverse);
                expect(-p.z).toBeGreaterThanOrEqual(c.near);
            }
        }
    });

    it('three draws it as a SunLight with a 2 x 2 atlas, and its shader reads the same number of cascades', () => {
        expect(installSoftShadowChunks()).toBe(true);
        const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
        expect(chunk).toContain(`#define SUN_LIGHT_CASCADES ${SUN_SHADOW_CASCADES}`);
        expect(chunk).toContain('float sbSunCascadeShadow(');
        expect(patchShadowChunk(chunk)).toBe(chunk);

        const scene = new THREE.Scene();
        const sun = new CascadedSunLight(0xffffff, 3);
        sun.position.copy(toSun).multiplyScalar(500);
        sun.castShadow = true;
        const block = new THREE.Mesh(new THREE.BoxGeometry(20, 60, 20), new THREE.MeshStandardMaterial());
        block.position.set(0, 30, -40);
        block.castShadow = block.receiveShadow = true;
        scene.add(sun, block);
        scene.updateMatrixWorld(true);
        expect(sun).toBeInstanceOf(THREE.DirectionalLight);
        expect(sun.isSunLight).toBe(true);
        expect(sun.type).toBe('SunLight');
        const shadow = sun.shadow as unknown as SunCascadeShadow;
        expect(shadow.getViewportCount()).toBe(SUN_SHADOW_CASCADES);
        expect(shadow.getFrameExtents().toArray()).toEqual([2, 2]);

        const cam = camera([0, 1.7, 30], [0, 10, -40]);
        shadow.updateMatrices(sun, cam);
        // the block's base, near the camera, maps into cascade 0's tile of the atlas (the lower-left quarter)
        const base = new THREE.Vector3(0, 0.5, -29.5);
        const depth = -base.clone().applyMatrix4(cam.matrixWorldInverse).z;
        const i = shadow._cascadeData.findIndex(c => depth >= c.x && depth < c.y);
        expect(i).toBeGreaterThanOrEqual(0);
        const uv = base.clone().applyMatrix4(shadow.getMatrix(i));
        expect(uv.x).toBeGreaterThan((i % 2) / 2);
        expect(uv.x).toBeLessThan((i % 2 + 1) / 2);
        expect(uv.y).toBeGreaterThan(Math.floor(i / 2) / 2);
        expect(uv.y).toBeLessThan((Math.floor(i / 2) + 1) / 2);
        expect(uv.z).toBeGreaterThan(0);
        expect(uv.z).toBeLessThan(1);
        // the cover camera (tree culling, triangle budget) holds every cascade's box
        const cover = shadow.camera;
        for (let k = 0; k < SUN_SHADOW_CASCADES; k++) {
            const c = shadow.getCamera(k).position.clone().applyMatrix4(cover.matrixWorldInverse);
            expect(Math.abs(c.x)).toBeLessThanOrEqual(cover.right + 1e-6);
            expect(Math.abs(c.y)).toBeLessThanOrEqual(cover.top + 1e-6);
        }
        // the content's bounds came from the scene the light is in
        expect(shadow.lastFit!.splits[0]).toBeGreaterThan(cam.near);
    });
});
