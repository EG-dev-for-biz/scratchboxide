/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * One reflection probe capture, shared by the place reflections (placeReflections.ts) and the facade material reading's
 * glass (stagedBuild/facadeMaterialLook.ts): a cube render of the scene from a point, prefiltered (PMREM), with a labelled
 * fallback sky gradient in the directions where no geometry was drawn. The fallback is the capture's background only
 * for the duration of the capture (restored before it returns): never the viewport background, never a visible sky.
 */

import * as THREE from 'three';

/** Label of the fallback sky the probe sees where no geometry was drawn (never a background). */
export const PLACE_REFLECTION_FALLBACK_SOURCE = 'place-reflection-fallback-sky';
/** Default cube face size of a probe. */
export const PLACE_PROBE_SIZE = 256;

/** Linear radiance of the fallback sky: zenith, horizon and ground, before scaling to the scene's lights. */
const FALLBACK_ZENITH = [0.30, 0.45, 0.72];
const FALLBACK_HORIZON = [0.78, 0.81, 0.84];
const FALLBACK_GROUND = [0.16, 0.15, 0.14];

/**
 * The scale of the fallback sky: what a white diffuse surface facing the scene's direct lights would send back (three's
 * Lambert: irradiance over pi), plus its ambient and hemisphere fill, so the sky sits with what the probe sees lit.
 */
export function fallbackSkyScale(scene: THREE.Scene): number {
    let direct = 0, fill = 0;
    for (const o of scene.children) {
        const l = o as THREE.Light & { isDirectionalLight?: boolean; isAmbientLight?: boolean; isHemisphereLight?: boolean };
        if (!l.isLight || !l.visible) continue;
        if (l.isDirectionalLight) direct += l.intensity;
        else if (l.isAmbientLight || l.isHemisphereLight) fill += l.intensity;
    }
    const s = direct / Math.PI + fill;
    return Math.min(2.5, Math.max(0.25, s));
}

/** The fallback sky as a small linear equirectangular texture (64 x 32), labelled. */
export function createFallbackSkyTexture(scale = 1): THREE.DataTexture {
    const W = 64, H = 32;
    const data = new Float32Array(W * H * 4);
    for (let j = 0; j < H; j++) {
        // three's equirect lookup: v = 0.5 + asin(y) / pi, with the first row at v = 0 (straight down)
        const y = Math.sin(((j + 0.5) / H - 0.5) * Math.PI);
        let c: number[];
        if (y >= 0) {
            const t = Math.pow(y, 0.55);
            c = FALLBACK_HORIZON.map((h, k) => h + (FALLBACK_ZENITH[k] - h) * t);
        } else {
            const t = Math.min(1, -y / 0.25);
            const s = t * t * (3 - 2 * t);
            c = FALLBACK_HORIZON.map((h, k) => h + (FALLBACK_GROUND[k] - h) * s);
        }
        for (let i = 0; i < W; i++) {
            const o = (j * W + i) * 4;
            data[o] = c[0] * scale; data[o + 1] = c[1] * scale; data[o + 2] = c[2] * scale; data[o + 3] = 1;
        }
    }
    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.name = PLACE_REFLECTION_FALLBACK_SOURCE;
    tex.userData = { sbProvenance: PLACE_REFLECTION_FALLBACK_SOURCE, note: 'fallback sky gradient seen by reflection probes where no geometry was drawn; never a background', scale };
    tex.needsUpdate = true;
    return tex;
}

export interface ProbeCapture {
    position: THREE.Vector3;
    near: number;
    far: number;
    /** Hidden for the capture (the receiving object itself, overlays and gizmos). */
    hide?: Array<THREE.Object3D | null | undefined>;
}

/** GPU bytes of a PMREM target (half-float RGBA). */
export function pmremBytes(target: THREE.WebGLRenderTarget | undefined): number {
    return target ? target.width * target.height * 8 : 0;
}

/**
 * One cube render of the scene from a point and its prefiltered environment (see the file comment). The cube target, the
 * PMREM generator (its shaders compile once) and the fallback sky are kept between captures and freed by dispose().
 * During a capture the shadow maps are not re-rendered (the frame's own are reused) and the scene's background is the
 * fallback sky; both are restored before it returns.
 */
export class ReflectionProbeRenderer {
    private pmrem?: THREE.PMREMGenerator;
    private cube?: THREE.WebGLCubeRenderTarget;
    private cubeCam?: THREE.CubeCamera;
    private fallback?: THREE.DataTexture;
    private fallbackScale = -1;

    constructor(private readonly renderer: THREE.WebGLRenderer, readonly size = PLACE_PROBE_SIZE) {}

    /** Renders the probe; `into` (a target this renderer returned before) is reused, else a new target is returned. */
    capture(scene: THREE.Scene, c: ProbeCapture, into?: THREE.WebGLRenderTarget): THREE.WebGLRenderTarget {
        const renderer = this.renderer;
        this.cube ??= new THREE.WebGLCubeRenderTarget(this.size, { type: THREE.HalfFloatType });
        if (!this.cubeCam) this.cubeCam = new THREE.CubeCamera(c.near, c.far, this.cube);
        for (const cam of this.cubeCam.children as THREE.PerspectiveCamera[]) {
            if (cam.near !== c.near || cam.far !== c.far) { cam.near = c.near; cam.far = c.far; cam.updateProjectionMatrix(); }
        }
        this.cubeCam.position.copy(c.position);
        this.cubeCam.updateMatrixWorld(true);

        const scale = fallbackSkyScale(scene);
        if (!this.fallback || Math.abs(scale - this.fallbackScale) > 1e-3) {
            this.fallback?.dispose();
            this.fallback = createFallbackSkyTexture(scale);
            this.fallbackScale = scale;
        }

        const hidden: THREE.Object3D[] = [];
        for (const o of c.hide ?? []) if (o && o.visible) { o.visible = false; hidden.push(o); }
        const background = scene.background, bgIntensity = scene.backgroundIntensity, bgBlur = scene.backgroundBlurriness;
        const shadowAuto = renderer.shadowMap.autoUpdate;
        const target = renderer.getRenderTarget();
        try {
            scene.background = this.fallback;
            scene.backgroundIntensity = 1;
            scene.backgroundBlurriness = 0;
            renderer.shadowMap.autoUpdate = false;
            this.cubeCam.update(renderer, scene);
            this.pmrem ??= new THREE.PMREMGenerator(renderer);
            return into ? this.pmrem.fromCubemap(this.cube.texture, into) : this.pmrem.fromCubemap(this.cube.texture);
        } finally {
            scene.background = background;
            scene.backgroundIntensity = bgIntensity;
            scene.backgroundBlurriness = bgBlur;
            renderer.shadowMap.autoUpdate = shadowAuto;
            renderer.setRenderTarget(target);
            for (const o of hidden) o.visible = true;
        }
    }

    /** GPU bytes kept between captures (the cube target and the generator's working target). */
    residentBytes(): number {
        const cube = this.cube ? this.size * this.size * 6 * 8 : 0;
        const pingPong = (this.pmrem as unknown as { _pingPongRenderTarget?: THREE.WebGLRenderTarget } | undefined)?._pingPongRenderTarget;
        return cube + pmremBytes(pingPong);
    }

    dispose(): void {
        this.cube?.dispose();
        this.cube = undefined;
        this.cubeCam = undefined;
        this.pmrem?.dispose();
        this.pmrem = undefined;
        this.fallback?.dispose();
        this.fallback = undefined;
        this.fallbackScale = -1;
    }
}

