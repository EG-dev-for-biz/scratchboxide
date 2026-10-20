/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Browser entry (bundled by sky-dome-equirect-renderer): renders the real sky dome for each spec into a linear float
 * cube map, resamples it to an equirectangular panorama (row 0 = zenith, column = compass azimuth clockwise from
 * north), and posts the floats and the scene lights back to the runner.
 */

import * as THREE from 'three';
import { createAtmosphericSkyDome } from '../../browser/generative-canvas/services/atmosphere/AtmosphericSkyDome';
import type { AtmosphericScatteringConfig } from '../../browser/generative-canvas/services/atmosphere/atmosphere-types';

interface Spec { config: AtmosphericScatteringConfig; width: number; height: number; timeSeconds: number }

const EQUIRECT_FRAGMENT = /* glsl */ `
uniform samplerCube uCube;
varying vec2 vUv;
void main() {
    float el = radians(90.0 - 180.0 * (1.0 - vUv.y));
    float az = radians(360.0 * vUv.x);
    // Compass azimuth clockwise from north; three.js world: +X east, +Y up, -Z north.
    vec3 dir = vec3(cos(el) * sin(az), sin(el), -cos(el) * cos(az));
    gl_FragColor = vec4(textureCube(uCube, dir).rgb, 1.0);
}`;

async function run() {
    const specs: Spec[] = await (await fetch('specs.json')).json();
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    for (let index = 0; index < specs.length; index++) {
        const spec = specs[index];
        try {
            const scene = new THREE.Scene();
            const dome = createAtmosphericSkyDome(scene, false, spec.config);
            dome.update(spec.timeSeconds, 0);
            const cubeTarget = new THREE.WebGLCubeRenderTarget(512, { type: THREE.FloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
            const cubeCamera = new THREE.CubeCamera(0.1, 5000, cubeTarget);
            scene.add(cubeCamera);
            cubeCamera.update(renderer, scene);

            const target = new THREE.WebGLRenderTarget(spec.width, spec.height, { type: THREE.FloatType });
            const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
                uniforms: { uCube: { value: cubeTarget.texture } },
                vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
                fragmentShader: EQUIRECT_FRAGMENT,
                depthTest: false
            }));
            const quadScene = new THREE.Scene();
            quadScene.add(quad);
            const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
            renderer.setRenderTarget(target);
            renderer.render(quadScene, cam);
            const rgba = new Float32Array(spec.width * spec.height * 4);
            renderer.readRenderTargetPixels(target, 0, 0, spec.width, spec.height, rgba);
            renderer.setRenderTarget(null);
            // GL rows run bottom-up; flip so row 0 is the zenith, and drop alpha.
            const rgb = new Float32Array(spec.width * spec.height * 3);
            for (let j = 0; j < spec.height; j++) for (let i = 0; i < spec.width; i++) {
                const s = ((spec.height - 1 - j) * spec.width + i) * 4, d = (j * spec.width + i) * 3;
                rgb[d] = rgba[s]; rgb[d + 1] = rgba[s + 1]; rgb[d + 2] = rgba[s + 2];
            }
            const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
            const lights = {
                sunIntensity: dome.sunLight.intensity,
                sunColor: [dome.sunLight.color.r, dome.sunLight.color.g, dome.sunLight.color.b],
                hemiIntensity: dome.hemiLight.intensity,
                hemiSkyLuminance: lum(dome.hemiLight.color),
                hemiGroundLuminance: lum(dome.hemiLight.groundColor),
                castShadow: dome.sunLight.castShadow
            };
            await fetch(`result?i=${index}`, { method: 'POST', body: rgb.buffer });
            await fetch(`lights?i=${index}`, { method: 'POST', body: JSON.stringify(lights) });
            dome.dispose();
            cubeTarget.dispose();
            target.dispose();
        } catch (err) {
            await fetch(`error?i=${index}`, { method: 'POST', body: String((err as Error)?.stack ?? err) });
        }
    }
    await fetch('done', { method: 'POST' });
}

run().catch(err => fetch('error?i=-1', { method: 'POST', body: String(err?.stack ?? err) }));
