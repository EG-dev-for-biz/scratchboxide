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
 * The fallback carries the scene's sun (its brightest directional light) as a small disc in the light's direction, its
 * radiance set so the disc sends exactly the light's irradiance: glass and water mirror the sun where the angle is right,
 * and only there.
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

/** The scene's sun as the probe sky draws it: toward the light (unit, world), its irradiance and linear colour. */
export interface ProbeSun { direction: [number, number, number]; irradiance: number; color: [number, number, number] }

/** Angular radius of the sun's disc in the probe sky (degrees): wider than the real sun's quarter degree, so a probe face resolves it. */
export const PROBE_SUN_RADIUS_DEG = 1.0;

/** The scene's brightest visible directional light, as the probe sky's sun; undefined when it has none. */
export function sceneSun(scene: THREE.Scene): ProbeSun | undefined {
    let best: THREE.DirectionalLight | undefined;
    scene.traverseVisible(o => {
        const l = o as THREE.DirectionalLight;
        if (l.isDirectionalLight && l.intensity > 0 && (!best || l.intensity > best.intensity)) best = l;
    });
    if (!best) return undefined;
    const from = best.getWorldPosition(new THREE.Vector3()), to = best.target.getWorldPosition(new THREE.Vector3());
    const d = from.sub(to);
    if (!(d.lengthSq() > 0)) return undefined;
    d.normalize();
    return { direction: [d.x, d.y, d.z], irradiance: best.intensity, color: [best.color.r, best.color.g, best.color.b] };
}

/**
 * The fallback sky as a small linear equirectangular texture (64 x 32; 512 x 256 with a sun, so its disc is resolved),
 * labelled. With `sun` above the horizon, its disc is added: radiance spread over the disc's texels (soft at the rim) so
 * that it integrates over their solid angle to the sun's irradiance.
 */
export function createFallbackSkyTexture(scale = 1, sun?: ProbeSun): THREE.DataTexture {
    const withSun = !!sun && sun.direction[1] > -Math.sin((PROBE_SUN_RADIUS_DEG * Math.PI) / 180);
    const W = withSun ? 512 : 64, H = withSun ? 256 : 32;
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
    if (withSun) {
        // three's equirect lookup: u = atan(z, x) / 2 pi + 0.5, v = asin(y) / pi + 0.5
        const [sx, sy, sz] = sun!.direction, rad = (PROBE_SUN_RADIUS_DEG * Math.PI) / 180, cosIn = Math.cos(rad), cosOut = Math.cos(1.5 * rad);
        const w = new Float32Array(W * H);
        let sum = 0;
        for (let j = 0; j < H; j++) {
            const lat = ((j + 0.5) / H - 0.5) * Math.PI, cl = Math.cos(lat), y = Math.sin(lat), dOmega = ((2 * Math.PI) / W) * (Math.PI / H) * cl;
            for (let i = 0; i < W; i++) {
                const phi = ((i + 0.5) / W - 0.5) * 2 * Math.PI;
                const c = Math.cos(phi) * cl * sx + y * sy + Math.sin(phi) * cl * sz;
                if (c <= cosOut) continue;
                const t = Math.min(1, (c - cosOut) / (cosIn - cosOut)), v = t * t * (3 - 2 * t);
                w[j * W + i] = v; sum += v * dOmega;
            }
        }
        if (sum > 0) for (let k = 0; k < W * H; k++) if (w[k]) for (let c = 0; c < 3; c++) data[k * 4 + c] += (sun!.irradiance * sun!.color[c] * w[k]) / sum;
    }
    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.name = PLACE_REFLECTION_FALLBACK_SOURCE;
    tex.userData = { sbProvenance: PLACE_REFLECTION_FALLBACK_SOURCE, note: 'fallback sky gradient seen by reflection probes where no geometry was drawn; never a background' + (withSun ? "; the scene's sun drawn as a disc in its light's direction, at its irradiance" : ''), scale, ...(withSun ? { sun } : {}) };
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
    private fallbackKey = '';

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

        const scale = fallbackSkyScale(scene), sun = sceneSun(scene);
        const key = [scale, ...(sun ? [...sun.direction, sun.irradiance, ...sun.color] : [])].map(v => v.toFixed(3)).join(',');
        if (!this.fallback || key !== this.fallbackKey) {
            this.fallback?.dispose();
            this.fallback = createFallbackSkyTexture(scale, sun);
            this.fallbackKey = key;
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
        this.fallbackKey = '';
    }
}

