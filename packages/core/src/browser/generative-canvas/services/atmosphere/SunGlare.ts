/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Veiling glare round the sun: the light a lens (or an eye) scatters out of the sun's image into a wide halo. Its shape
 * is measured: on 13 clear daytime HDR skies (Poly Haven references, sky-realism benchmark), the radiance in the rings
 * 0.75-3° from the sun, less the sky's own level there, falls as L/E = 4.2 · θ^-2.5 per steradian (θ in degrees, E the
 * sun's direct irradiance; within ~10% at every ring). That is ~2.8% of the sun's light, typical veiling glare for a
 * camera and of the same order as the CIE disability-glare function of the eye (10 · θ^-2). Strength 1 is that average.
 *
 * It is drawn after the scene as a screen-space overlay, scaled by how much of the sun is visible: through cloud (the
 * baked sky's disc at the sun's direction against its cloudless value) and past geometry (a 1° probe render from the
 * camera toward the sun, a few times a second). A sun behind a building or thick cloud has no glare; one at an edge
 * glows over it, as in footage.
 */

import * as THREE from 'three';

/** Measured glare: L/E = GLARE_K · θ_deg^-GLARE_N per steradian (sky-realism benchmark, 13 clear daytime HDR skies). */
export const GLARE_K = 4.2;
export const GLARE_N = 2.5;
/** Angular radius of the sun's disc, degrees. */
export const SUN_RADIUS_DEG = 0.267;
const PROBE_SIZE = 16;
const PROBE_EVERY_FRAMES = 4;

const GLARE_VERTEX = /* glsl */ `
varying vec2 vNdc;
void main() {
    vNdc = position.xy;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const GLARE_FRAGMENT = /* glsl */ `
uniform mat4 uInvProjection;
uniform mat4 uCameraWorld;
uniform vec3 uSunDirection;
uniform vec3 uSunIrradiance;   // the scene sun's colour x intensity, times strength x visibility
varying vec2 vNdc;
void main() {
    vec4 view = uInvProjection * vec4(vNdc, 1.0, 1.0);
    vec3 ray = normalize((uCameraWorld * vec4(view.xyz / view.w, 0.0)).xyz);
    float theta = degrees(acos(clamp(dot(ray, normalize(uSunDirection)), -1.0, 1.0)));
    // Inside the disc the halo is held at its rim value (the dome draws the disc itself).
    float t = max(theta, ${SUN_RADIUS_DEG.toFixed(3)});
    vec3 glare = uSunIrradiance * ${GLARE_K.toFixed(2)} * pow(t, -${GLARE_N.toFixed(2)});
    gl_FragColor = vec4(min(glare, vec3(6.0e4)), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}`;

const PROBE_SKY_FRAGMENT = /* glsl */ `
uniform samplerCube uSkyCube;
uniform vec3 uSunDirection;
void main() { gl_FragColor = vec4(textureCube(uSkyCube, normalize(uSunDirection)).rgb, 1.0); }`;

export interface SunGlareInputs {
    sunDirection: () => THREE.Vector3;
    /** The scene sun's linear colour times its intensity (the directional light's irradiance). */
    sunIrradiance: () => THREE.Color;
    /** Sun elevation, degrees: below the horizon there is no direct sun to scatter. */
    sunElevationDeg: () => number;
    /** The baked sky cube, and the disc radiance it would hold at the sun with no cloud in front (luminance). */
    skyCube: () => THREE.Texture;
    clearDiscLuminance: () => number;
    /** Objects that are sky, not occluders (the dome, the sun disc, this overlay). */
    skyObjects: () => THREE.Object3D[];
}

export class SunGlare {
    readonly mesh: THREE.Mesh;
    /** Last measured fractions of the sun left visible. */
    cloudVisibility = 1;
    geometryVisibility = 1;
    private readonly material: THREE.ShaderMaterial;
    private readonly probeTarget = new THREE.WebGLRenderTarget(PROBE_SIZE, PROBE_SIZE, { type: THREE.UnsignedByteType });
    private readonly skyTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType });
    private readonly probeCamera = new THREE.PerspectiveCamera(SUN_RADIUS_DEG * 2 * 1.2, 1, 0.1, 1e7);
    private readonly occluderMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
    private readonly skyQuad: { scene: THREE.Scene; camera: THREE.OrthographicCamera; material: THREE.ShaderMaterial };
    private readonly pixels = new Uint8Array(PROBE_SIZE * PROBE_SIZE * 4);
    private readonly skyPixel = new Float32Array(4);
    private frame = 0;
    private skyKey = '';

    constructor(private readonly inputs: SunGlareInputs, private strength: number) {
        this.material = new THREE.ShaderMaterial({
            vertexShader: GLARE_VERTEX,
            fragmentShader: GLARE_FRAGMENT,
            uniforms: {
                uInvProjection: { value: new THREE.Matrix4() },
                uCameraWorld: { value: new THREE.Matrix4() },
                uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
                uSunIrradiance: { value: new THREE.Color(0, 0, 0) }
            },
            blending: THREE.AdditiveBlending,
            transparent: true,
            depthTest: false,
            depthWrite: false
        });
        this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
        this.mesh.name = 'AtmosphericSunGlare';
        // its own additive sprite material, never the scene-wide clay pass
        this.mesh.userData.sbKeepAuthoredMaterial = true;
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 1e9;
        this.mesh.onBeforeRender = (renderer, scene, camera) => this.beforeRender(renderer as THREE.WebGLRenderer, scene, camera);

        const skyMaterial = new THREE.ShaderMaterial({
            vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
            fragmentShader: PROBE_SKY_FRAGMENT,
            uniforms: { uSkyCube: { value: null }, uSunDirection: { value: new THREE.Vector3(0, 1, 0) } },
            depthTest: false,
            depthWrite: false
        });
        const skyScene = new THREE.Scene();
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), skyMaterial);
        quad.frustumCulled = false;
        skyScene.add(quad);
        this.skyQuad = { scene: skyScene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), material: skyMaterial };
    }

    setStrength(strength: number): void {
        this.strength = strength;
    }

    /** Fraction of the sun visible (cloud and geometry), as last measured. */
    get visibility(): number {
        return this.cloudVisibility * this.geometryVisibility;
    }

    private beforeRender(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
        const u = this.material.uniforms;
        const sun = this.inputs.sunDirection();
        u.uInvProjection.value.copy((camera as THREE.PerspectiveCamera).projectionMatrixInverse);
        u.uCameraWorld.value.copy(camera.matrixWorld);
        u.uSunDirection.value.copy(sun);
        // Above the horizon only (the refracted disc's upper limb sets at about -0.83°).
        const up = THREE.MathUtils.smoothstep(this.inputs.sunElevationDeg(), -0.83, 0.5);
        // Glare belongs to a camera's frame: none in cube captures (reflection probes, sky bakes, panoramas). Those
        // also cannot be measured from: three's readRenderTargetPixels then restores a cube target's framebuffer
        // array as if it were one framebuffer and throws.
        const current = renderer.getRenderTarget();
        const cubeCapture = !!current && (current as THREE.WebGLRenderTarget & { isWebGLCubeRenderTarget?: boolean }).isWebGLCubeRenderTarget === true;
        if (this.strength <= 0 || up <= 0 || cubeCapture) {
            (u.uSunIrradiance.value as THREE.Color).setRGB(0, 0, 0);
            return;
        }
        if (this.frame++ % PROBE_EVERY_FRAMES === 0) {
            this.measureCloud(renderer, sun);
            this.measureGeometry(renderer, scene, camera, sun);
        }
        (u.uSunIrradiance.value as THREE.Color).copy(this.inputs.sunIrradiance()).multiplyScalar(this.strength * up * this.visibility);
    }

    /** The baked sky's radiance at the sun against the disc's cloudless value. */
    private measureCloud(renderer: THREE.WebGLRenderer, sun: THREE.Vector3): void {
        const cube = this.inputs.skyCube();
        const key = `${cube.uuid}:${cube.version}:${sun.x.toFixed(5)},${sun.y.toFixed(5)},${sun.z.toFixed(5)}`;
        if (key === this.skyKey) return;
        this.skyKey = key;
        const m = this.skyQuad.material.uniforms;
        m.uSkyCube.value = cube;
        m.uSunDirection.value.copy(sun);
        this.withTarget(renderer, this.skyTarget, () => renderer.render(this.skyQuad.scene, this.skyQuad.camera));
        renderer.readRenderTargetPixels(this.skyTarget, 0, 0, 1, 1, this.skyPixel);
        const lum = 0.2126 * this.skyPixel[0] + 0.7152 * this.skyPixel[1] + 0.0722 * this.skyPixel[2];
        const clear = this.inputs.clearDiscLuminance();
        this.cloudVisibility = clear > 0 ? Math.min(1, Math.max(0, lum / clear)) : 1;
    }

    /** Share of a 1°-wide view from the camera toward the sun that no geometry covers. */
    private measureGeometry(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, sun: THREE.Vector3): void {
        const probe = this.probeCamera;
        probe.position.setFromMatrixPosition(camera.matrixWorld);
        probe.lookAt(probe.position.clone().add(sun));
        probe.far = (camera as THREE.PerspectiveCamera).far || 1e7;
        probe.updateProjectionMatrix();
        probe.updateMatrixWorld();
        const hidden = this.inputs.skyObjects().filter(o => o.visible);
        hidden.forEach(o => { o.visible = false; });
        const override = scene.overrideMaterial, background = scene.background, fog = scene.fog;
        const clearColor = renderer.getClearColor(new THREE.Color()), clearAlpha = renderer.getClearAlpha();
        scene.overrideMaterial = this.occluderMaterial;
        scene.background = null;
        scene.fog = null;
        renderer.setClearColor(0xffffff, 1);
        this.withTarget(renderer, this.probeTarget, () => { renderer.clear(); renderer.render(scene, probe); });
        renderer.setClearColor(clearColor, clearAlpha);
        scene.overrideMaterial = override;
        scene.background = background;
        scene.fog = fog;
        hidden.forEach(o => { o.visible = true; });
        renderer.readRenderTargetPixels(this.probeTarget, 0, 0, PROBE_SIZE, PROBE_SIZE, this.pixels);
        // Only the disc counts: pixels within its radius of the probe's centre (the frame is 1.2 disc diameters).
        let open = 0, n = 0;
        const c = (PROBE_SIZE - 1) / 2, r = (PROBE_SIZE / 2) / 1.2;
        for (let y = 0; y < PROBE_SIZE; y++) for (let x = 0; x < PROBE_SIZE; x++) {
            if (Math.hypot(x - c, y - c) > r) continue;
            n++;
            open += this.pixels[(y * PROBE_SIZE + x) * 4] / 255;
        }
        this.geometryVisibility = n ? open / n : 1;
    }

    private withTarget(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, draw: () => void): void {
        const previous = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), level = renderer.getActiveMipmapLevel();
        const xr = renderer.xr.enabled;
        renderer.xr.enabled = false;
        renderer.setRenderTarget(target);
        draw();
        renderer.setRenderTarget(previous, face, level);
        renderer.xr.enabled = xr;
    }

    dispose(): void {
        this.material.dispose();
        this.mesh.geometry.dispose();
        this.skyQuad.material.dispose();
        (this.skyQuad.scene.children[0] as THREE.Mesh).geometry.dispose();
        this.occluderMaterial.dispose();
        this.probeTarget.dispose();
        this.skyTarget.dispose();
    }
}
