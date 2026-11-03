/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Contact ambient occlusion for the viewport's post stack: ground-truth ambient occlusion (GTAO, three's GTAOShader) read
 * from the depth the aerial perspective pass already renders the scene with, normals rebuilt from that depth, then
 * three's Poisson denoise. The result is the open share of each pixel's hemisphere (1 open, lower in corners); the
 * aerial pass multiplies the surface's light by it before the haze goes on. Its reach is a few metres, so it marks
 * where walls meet the street, window reveals and eaves; distant buildings need baked occlusion to sit on the ground.
 *
 * three's GTAOPass is not used: given a depth texture and no normals it dereferences a normal target it never made.
 */

import * as THREE from 'three';
import { GTAOShader, generateMagicSquareNoise } from 'three/examples/jsm/shaders/GTAOShader.js';
import { PoissonDenoiseShader, generatePdSamplePointInitializer } from 'three/examples/jsm/shaders/PoissonDenoiseShader.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

export interface ContactAmbientOcclusionSettings {
    /** World radius the occlusion is looked for within, metres. */
    radiusM: number;
    /** Depth difference beyond which a sample is taken to be behind, not beside, metres. */
    thicknessM: number;
    /** How strongly the occlusion darkens: 0 none, 1 all of it. */
    intensity: number;
    samples: number;
}

/** A street-scale reach: a kerb, a recessed window, the foot of a wall. */
export const CONTACT_AO_DEFAULTS: ContactAmbientOcclusionSettings = { radiusM: 2, thicknessM: 2, intensity: 0.75, samples: 16 };

/** A fixed, tileable noise for the denoise's rotation (a hash, not Math.random, so frames and runs match). */
function denoiseNoise(size = 64): THREE.DataTexture {
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < data.length; i++) {
        let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
        h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
        data[i] = h & 0xff;
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
}

export class ContactAmbientOcclusion {
    readonly settings: ContactAmbientOcclusionSettings;
    private readonly gtaoTarget: THREE.WebGLRenderTarget;
    private readonly denoiseTarget: THREE.WebGLRenderTarget;
    private readonly gtao: THREE.ShaderMaterial;
    private readonly denoise: THREE.ShaderMaterial;
    private readonly quad = new FullScreenQuad();
    private readonly noise: THREE.DataTexture;
    private readonly denoiseNoise: THREE.DataTexture;
    private readonly clearColor = new THREE.Color();

    constructor(settings: Partial<ContactAmbientOcclusionSettings> = {}) {
        this.settings = { ...CONTACT_AO_DEFAULTS, ...settings };
        const target = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
        this.gtaoTarget = target();
        this.denoiseTarget = target();
        this.noise = generateMagicSquareNoise();
        this.denoiseNoise = denoiseNoise();
        this.gtao = new THREE.ShaderMaterial({
            name: 'ContactAmbientOcclusion.gtao',
            // normals rebuilt from the depth (NORMAL_VECTOR_TYPE 0), radius in world metres
            defines: { ...GTAOShader.defines, NORMAL_VECTOR_TYPE: 0, DEPTH_SWIZZLING: 'x', SAMPLES: this.settings.samples, SCREEN_SPACE_RADIUS: 0 },
            uniforms: THREE.UniformsUtils.clone(GTAOShader.uniforms),
            vertexShader: GTAOShader.vertexShader,
            fragmentShader: GTAOShader.fragmentShader,
            blending: THREE.NoBlending, depthTest: false, depthWrite: false
        });
        this.gtao.uniforms.tNoise.value = this.noise;
        this.gtao.uniforms.radius.value = this.settings.radiusM;
        this.gtao.uniforms.thickness.value = this.settings.thicknessM;
        this.gtao.uniforms.distanceExponent.value = 2;
        this.gtao.uniforms.distanceFallOff.value = 1;
        this.gtao.uniforms.scale.value = 1;
        this.denoise = new THREE.ShaderMaterial({
            name: 'ContactAmbientOcclusion.denoise',
            defines: { ...PoissonDenoiseShader.defines, NORMAL_VECTOR_TYPE: 0, DEPTH_VALUE_SOURCE: 0, SAMPLES: 16, SAMPLE_VECTORS: generatePdSamplePointInitializer(16, 2, 2) },
            uniforms: THREE.UniformsUtils.clone(PoissonDenoiseShader.uniforms),
            vertexShader: PoissonDenoiseShader.vertexShader,
            fragmentShader: PoissonDenoiseShader.fragmentShader,
            blending: THREE.NoBlending, depthTest: false, depthWrite: false
        });
        this.denoise.uniforms.tDiffuse.value = this.gtaoTarget.texture;
        this.denoise.uniforms.tNoise.value = this.denoiseNoise;
        this.denoise.uniforms.lumaPhi.value = 10;
        this.denoise.uniforms.depthPhi.value = 2;
        this.denoise.uniforms.normalPhi.value = 3;
        this.denoise.uniforms.radius.value = 8;
    }

    get intensity(): number { return this.settings.intensity; }

    /**
     * The occlusion of the scene just drawn with `camera` into a target whose depth is `depthTexture` (red: 1 open),
     * at that target's size. Sky (depth 1) stays open.
     */
    render(renderer: THREE.WebGLRenderer, camera: THREE.Camera & { near: number; far: number }, depthTexture: THREE.Texture, width: number, height: number): THREE.Texture {
        if (this.gtaoTarget.width !== width || this.gtaoTarget.height !== height) {
            this.gtaoTarget.setSize(width, height);
            this.denoiseTarget.setSize(width, height);
        }
        const g = this.gtao.uniforms;
        g.tDepth.value = depthTexture;
        g.resolution.value.set(width, height);
        g.cameraNear.value = camera.near;
        g.cameraFar.value = camera.far;
        g.cameraProjectionMatrix.value.copy(camera.projectionMatrix);
        g.cameraProjectionMatrixInverse.value.copy(camera.projectionMatrixInverse);
        g.cameraWorldMatrix.value.copy(camera.matrixWorld);
        const isPerspective = (camera as THREE.PerspectiveCamera).isPerspectiveCamera ? 1 : 0;
        if (this.gtao.defines.PERSPECTIVE_CAMERA !== isPerspective) { this.gtao.defines.PERSPECTIVE_CAMERA = isPerspective; this.gtao.needsUpdate = true; }
        const d = this.denoise.uniforms;
        d.tDepth.value = depthTexture;
        d.resolution.value.set(width, height);
        d.cameraProjectionMatrixInverse.value.copy(camera.projectionMatrixInverse);

        const previousTarget = renderer.getRenderTarget();
        const previousAutoClear = renderer.autoClear;
        const previousAlpha = renderer.getClearAlpha();
        renderer.getClearColor(this.clearColor);
        renderer.autoClear = false;
        // cleared open: pixels the shaders discard (sky, no depth) are unoccluded
        renderer.setClearColor(0xffffff, 1);
        for (const [material, target] of [[this.gtao, this.gtaoTarget], [this.denoise, this.denoiseTarget]] as const) {
            renderer.setRenderTarget(target);
            renderer.clear(true, false, false);
            this.quad.material = material;
            this.quad.render(renderer);
        }
        renderer.setRenderTarget(previousTarget);
        renderer.setClearColor(this.clearColor, previousAlpha);
        renderer.autoClear = previousAutoClear;
        return this.denoiseTarget.texture;
    }

    dispose(): void {
        this.gtaoTarget.dispose();
        this.denoiseTarget.dispose();
        this.gtao.dispose();
        this.denoise.dispose();
        this.quad.dispose();
        this.noise.dispose();
        this.denoiseNoise.dispose();
    }
}
