/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Browser entry for contact-shadows.test.ts: a wall 60 m in front of the camera, lit by the sky's cascaded sun from
 * behind the camera and 45 degrees up, with a thin ledge (its 0.3 m shadow under one coarse 256 px shadow texel, which
 * the cascades miss) and a deep canopy (a 3 m shadow the cascades hold) with a second thin ledge inside its shadow. The
 * scene is drawn as the aerial pass draws it
 * (half float colour, 24-bit depth), the contact shadow pass run on that depth, and its multiplier read back at points.
 */

import * as THREE from 'three';
import { CascadedSunLight } from '../../../src/browser/generative-canvas/primitives/scene3d/sunShadowCascades';
import { ContactShadows } from '../../../src/browser/generative-canvas/primitives/scene3d/contactShadows';

const W = 800, H = 600;

function box(scene: THREE.Scene, min: [number, number, number], max: [number, number, number]): void {
    const size = new THREE.Vector3(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 1 }));
    mesh.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
}

async function run() {
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    document.body.appendChild(canvas);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    renderer.setSize(W, H, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.BasicShadowMap;

    const scene = new THREE.Scene();
    box(scene, [-30, 0, -60.5], [30, 30, -60]);          // the wall, its face at z = -60
    box(scene, [-8, 10, -60], [-2, 10.1, -59.7]);        // a ledge 0.3 m deep
    box(scene, [2, 13, -60], [8, 13.2, -57]);            // a canopy 3 m deep: its shadow on the wall runs from y 13 to 10
    box(scene, [2, 12, -60], [8, 12.1, -59.7]);          // and a ledge 0.3 m deep inside that shadow
    const sun = new CascadedSunLight(0xffffff, 3);
    sun.position.set(0, Math.SQRT1_2, Math.SQRT1_2).multiplyScalar(500);
    sun.castShadow = true;
    sun.cascades.mapSize.set(256, 256);
    sun.cascades.maxDistance = 200;
    sun.cascades.casterReach = 100;
    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.5);
    scene.add(sun, hemi);
    scene.updateMatrixWorld(true);

    const camera = new THREE.PerspectiveCamera(45, W / H, 0.5, 2000);
    camera.position.set(0, 10, 0);
    camera.lookAt(0, 10, -60);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    const depthTexture = new THREE.DepthTexture(W, H);
    depthTexture.format = THREE.DepthFormat;
    depthTexture.type = THREE.UnsignedIntType;
    const target = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthTexture });
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);

    const contact = new ContactShadows(() => ({ sun, hemi }));
    // copied into a float target to read it back (a half float target does not read into a Float32Array)
    const readable = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, depthBuffer: false });
    const copy = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
        uniforms: { tSrc: { value: null as THREE.Texture | null } },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: 'uniform sampler2D tSrc; varying vec2 vUv; void main() { gl_FragColor = texture2D(tSrc, vUv); }',
        depthTest: false
    }));
    const copyScene = new THREE.Scene();
    copyScene.add(copy);
    const readBack = (tex: THREE.Texture) => {
        (copy.material as THREE.ShaderMaterial).uniforms.tSrc.value = tex;
        renderer.setRenderTarget(readable);
        renderer.render(copyScene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
        const px = new Float32Array(W * H * 4);
        renderer.readRenderTargetPixels(readable, 0, 0, W, H, px);
        return px;
    };
    const rgba = readBack(contact.render(renderer, camera, depthTexture, W, H));
    // the same depth with the sun's cascades out of the pass (no shadow map to ask)
    sun.castShadow = false;
    const ungated = readBack(contact.render(renderer, camera, depthTexture, W, H));
    sun.castShadow = true;

    // the multiplier at a world point (GL rows run bottom-up, as readPixels returns them), over a 3 x 3 pixel patch
    const at = (p: [number, number, number], data = rgba) => {
        const ndc = new THREE.Vector3(...p).project(camera);
        const x = Math.round((ndc.x * 0.5 + 0.5) * W), y = Math.round((ndc.y * 0.5 + 0.5) * H);
        const v: number[] = [];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) v.push(data[((y + dy) * W + (x + dx)) * 4]);
        return { min: Math.min(...v), max: Math.max(...v), mean: v.reduce((a, b) => a + b, 0) / v.length };
    };
    let darkened = 0;
    for (let i = 0; i < W * H; i++) if (rgba[i * 4] < 0.95) darkened++;
    const result = {
        // under the ledge: its shadow runs from y 10 down to 9.7 on the wall
        underLedge: at([-5, 9.85, -59.99]),
        // under the ledge inside the canopy's shadow, which the cascades hold (a contact ray from here hits the ledge)
        underCanopy: at([5, 11.85, -59.99]),
        underCanopyWithoutCascades: at([5, 11.85, -59.99], ungated),
        openWall: at([-5, 5, -59.99]),
        sky: at([0, 33, -60]),
        darkenedShare: darkened / (W * H),
        cascades: sun.cascades.lastFit?.cascades.map(c => c.halfSize) ?? []
    };
    contact.dispose();
    await fetch('result', { method: 'POST', body: JSON.stringify(result) });
}

run().catch(err => fetch('error', { method: 'POST', body: String(err?.stack ?? err) }));
