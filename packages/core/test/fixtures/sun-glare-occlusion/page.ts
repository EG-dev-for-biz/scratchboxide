/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Browser entry for sun-glare-occlusion.test.ts: the sun's glare (SunGlare.ts) drawn frame by frame at 60 Hz (a fake
 * clock) while a wall 60 m out, perpendicular to the sun, slides its straight edge across the disc: off, all the way
 * over, back off, half over, jittering by 0.06 of the disc's radius (0.8 of a probe pixel), and sweeping across in 12
 * frames. Per frame it records the glare drawn (the frame's mean) and the probe's measured and shown visibility, and
 * which cameras the sun's cascades were fitted to.
 */

import * as THREE from 'three';
import { SunGlare, SUN_RADIUS_DEG } from '../../../src/browser/generative-canvas/services/atmosphere/SunGlare';
import { CascadedSunLight } from '../../../src/browser/generative-canvas/primitives/scene3d/sunShadowCascades';

const W = 160, H = 120, D = 60;

async function run() {
    let clock = 0;
    performance.now = () => clock;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    document.body.appendChild(canvas);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    renderer.setSize(W, H, false);
    renderer.shadowMap.enabled = true;

    const sunDir = new THREE.Vector3(0, Math.sin(Math.PI / 6), -Math.cos(Math.PI / 6)).normalize();
    const scene = new THREE.Scene();
    const sky = new THREE.WebGLCubeRenderTarget(4);
    const glare = new SunGlare({
        sunDirection: () => sunDir,
        sunIrradiance: () => new THREE.Color(1, 1, 1),
        sunElevationDeg: () => 30,
        skyCube: () => sky.texture,
        clearDiscLuminance: () => 0,
        skyObjects: () => [glare.mesh]
    }, 1);
    scene.add(glare.mesh);

    // a wall perpendicular to the sun, its edge `e` disc radii from the disc's centre (negative: past it, over the disc)
    const half = 200;
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(2 * half, 2 * half), new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide }));
    wall.castShadow = true;
    const right = new THREE.Vector3().crossVectors(sunDir, new THREE.Vector3(0, 1, 0)).normalize();
    wall.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), sunDir.clone().negate());
    const rho = D * Math.tan(THREE.MathUtils.degToRad(SUN_RADIUS_DEG));
    const edgeAt = (e: number | null) => {
        wall.visible = e !== null;
        if (e !== null) wall.position.copy(sunDir).multiplyScalar(D).addScaledVector(right, e * rho + half);
        wall.updateMatrixWorld(true);
    };
    scene.add(wall);

    // the sky's sun with cascades, to see which views they are fitted to
    const sun = new CascadedSunLight(0xffffff, 1);
    sun.position.copy(sunDir).multiplyScalar(500);
    sun.castShadow = true;
    sun.cascades.mapSize.set(256, 256);
    const fittedTo = new Set<string>();
    const updateMatrices = sun.shadow.updateMatrices.bind(sun.shadow);
    sun.shadow.updateMatrices = (light: THREE.Light, viewCamera?: THREE.Camera) => { if (viewCamera) fittedTo.add(viewCamera === camera ? 'view' : 'other'); updateMatrices(light, viewCamera); };
    scene.add(sun);

    const camera = new THREE.PerspectiveCamera(60, W / H, 0.5, 2000);
    camera.lookAt(sunDir);
    camera.updateMatrixWorld(true);

    const target = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType });
    const px = new Float32Array(W * H * 4);
    const vis = new Float32Array(4);
    const visibilityTargets = (glare as unknown as { visibilityTargets: THREE.WebGLRenderTarget[]; visibilityIndex: number });
    const frame = () => {
        clock += 1000 / 60;
        renderer.setRenderTarget(target);
        renderer.setClearColor(0x000000, 1);
        renderer.clear();
        renderer.render(scene, camera);
        renderer.readRenderTargetPixels(target, 0, 0, W, H, px);
        let sum = 0;
        for (let i = 0; i < W * H; i++) sum += px[i * 4];
        renderer.readRenderTargetPixels(visibilityTargets.visibilityTargets[visibilityTargets.visibilityIndex], 0, 0, 1, 1, vis);
        return { glare: sum / (W * H), shown: vis[0], measured: vis[1] };
    };
    const steps = (n: number, e: number | null | ((i: number) => number | null)) => Array.from({ length: n }, (_, i) => { edgeAt(typeof e === 'function' ? e(i) : e); return frame(); });

    const open = steps(10, null);
    const covered = steps(5, -2);
    const reopened = steps(40, null);
    const halfOver = steps(60, 0);
    const jitter = steps(30, i => (i % 2 ? 0.06 : -0.06));
    const sweep = steps(16, i => 1.2 - (2.4 * i) / 11);
    const result = { open, covered, reopened, halfOver, jitter, sweep, fittedTo: [...fittedTo] };
    glare.dispose();
    await fetch('result', { method: 'POST', body: JSON.stringify(result) });
}

run().catch(err => fetch('error', { method: 'POST', body: String(err?.stack ?? err) }));
