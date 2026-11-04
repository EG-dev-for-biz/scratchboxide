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
 * camera toward the sun, every frame, whose open share is counted on the GPU and read there by the overlay: a read-back
 * would stall the frame). A sun behind a building or thick cloud has no glare; one at an edge glows over it, as in
 * footage. The geometry visibility drawn trails the measured one by at most VISIBILITY_GLIDE_BAND and glides the rest
 * over VISIBILITY_EASE_SECONDS: the probe sees leaves, cornices and window edges slide across the disc, and a glare that
 * jumped with each of them flickered, worst under depth of field, which spreads every jump over its whole blur disc. A
 * larger change (the sun going behind a wall) is followed at once, and a hidden sun (VISIBILITY_HIDDEN) has no glare
 * from the frame it is hidden: a glare eased all the way, every 4 frames, glowed on for half a second after it.
 */

import * as THREE from 'three';

/** Measured glare: L/E = GLARE_K · θ_deg^-GLARE_N per steradian (sky-realism benchmark, 13 clear daytime HDR skies). */
export const GLARE_K = 4.2;
export const GLARE_N = 2.5;
/** Angular radius of the sun's disc, degrees. */
export const SUN_RADIUS_DEG = 0.267;
/** The geometry probe's side (pixels; the disc covers ~550 of them). */
const PROBE_SIZE = 32;
/** Time constant (s) of the glide from the shown visibility to the measured one, within VISIBILITY_GLIDE_BAND of it. */
export const VISIBILITY_EASE_SECONDS = 0.2;
/** How far the shown geometry visibility may trail the measured one: a change within it glides, a larger one is followed at once to it. */
export const VISIBILITY_GLIDE_BAND = 0.1;
/** A measured geometry visibility at or below this is a hidden sun (about 5 of the disc's probe pixels open): no glare at once. */
export const VISIBILITY_HIDDEN = 0.01;

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
uniform vec3 uSunIrradiance;   // the scene sun's colour x intensity, times strength x cloud visibility
uniform sampler2D tVisibility; // the shown geometry visibility (VISIBILITY_FRAGMENT), in red
varying vec2 vNdc;
void main() {
    vec4 view = uInvProjection * vec4(vNdc, 1.0, 1.0);
    vec3 ray = normalize((uCameraWorld * vec4(view.xyz / view.w, 0.0)).xyz);
    float theta = degrees(acos(clamp(dot(ray, normalize(uSunDirection)), -1.0, 1.0)));
    // Inside the disc the halo is held at its rim value (the dome draws the disc itself).
    float t = max(theta, ${SUN_RADIUS_DEG.toFixed(3)});
    vec3 glare = uSunIrradiance * texelFetch(tVisibility, ivec2(0), 0).r * ${GLARE_K.toFixed(2)} * pow(t, -${GLARE_N.toFixed(2)});
    gl_FragColor = vec4(min(glare, vec3(6.0e4)), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}`;

const PROBE_SKY_FRAGMENT = /* glsl */ `
uniform samplerCube uSkyCube;
uniform vec3 uSunDirection;
void main() { gl_FragColor = vec4(textureCube(uSkyCube, normalize(uSunDirection)).rgb, 1.0); }`;

// The disc's open share of the probe (white sky, black geometry; the frame is 1.2 disc diameters), and the visibility the
// glare is drawn with: within VISIBILITY_GLIDE_BAND of the measure it glides, further it is brought to the band's edge,
// and a hidden sun is 0. Red is the shown visibility, green the measured one.
const VISIBILITY_FRAGMENT = /* glsl */ `
uniform sampler2D tProbe;
uniform sampler2D tShown;
uniform float uDt;
uniform bool uReset;
void main() {
    const float c = ${((PROBE_SIZE - 1) / 2).toFixed(1)};
    const float r = ${(PROBE_SIZE / 2 / 1.2).toFixed(4)};
    float open = 0.0, n = 0.0;
    for (int y = 0; y < ${PROBE_SIZE}; y++) for (int x = 0; x < ${PROBE_SIZE}; x++) {
        if (length(vec2(float(x), float(y)) - c) > r) continue;
        n += 1.0;
        open += texelFetch(tProbe, ivec2(x, y), 0).r;
    }
    float measured = n > 0.0 ? open / n : 1.0;
    float shown = measured;
    if (measured <= ${VISIBILITY_HIDDEN.toFixed(3)}) shown = 0.0;
    else if (!uReset) {
        shown = clamp(texelFetch(tShown, ivec2(0), 0).r, measured - ${VISIBILITY_GLIDE_BAND.toFixed(3)}, measured + ${VISIBILITY_GLIDE_BAND.toFixed(3)});
        shown += (measured - shown) * (1.0 - exp(-uDt / ${VISIBILITY_EASE_SECONDS.toFixed(3)}));
    }
    gl_FragColor = vec4(shown, measured, 0.0, 1.0);
}`;

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
    /** Last measured fraction of the sun a cloud leaves visible. */
    cloudVisibility = 1;
    /** The cloud visibility eased (VISIBILITY_EASE_SECONDS), as the glare and what else dims with cloud (the god rays) read it. */
    shownCloudVisibility = -1;
    private lastCloudEaseMs = 0;
    private readonly material: THREE.ShaderMaterial;
    private readonly probeTarget = new THREE.WebGLRenderTarget(PROBE_SIZE, PROBE_SIZE, { type: THREE.UnsignedByteType });
    private readonly skyTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType });
    /** The shown geometry visibility, ping-ponged: each frame's pass reads the last one's (VISIBILITY_FRAGMENT). */
    private readonly visibilityTargets = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false }));
    private visibilityIndex = 0;
    private lastProbeMs = -1;
    private readonly probeCamera = new THREE.PerspectiveCamera(SUN_RADIUS_DEG * 2 * 1.2, 1, 0.1, 1e7);
    private readonly occluderMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
    private readonly skyQuad: { scene: THREE.Scene; camera: THREE.OrthographicCamera; material: THREE.ShaderMaterial };
    private readonly visibilityQuad: { scene: THREE.Scene; material: THREE.ShaderMaterial };
    private readonly skyPixel = new Float32Array(4);
    private skyKey = '';

    constructor(private readonly inputs: SunGlareInputs, private strength: number) {
        this.material = new THREE.ShaderMaterial({
            vertexShader: GLARE_VERTEX,
            fragmentShader: GLARE_FRAGMENT,
            uniforms: {
                uInvProjection: { value: new THREE.Matrix4() },
                uCameraWorld: { value: new THREE.Matrix4() },
                uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
                uSunIrradiance: { value: new THREE.Color(0, 0, 0) },
                tVisibility: { value: null as THREE.Texture | null }
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

        const visibilityMaterial = new THREE.ShaderMaterial({
            vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
            fragmentShader: VISIBILITY_FRAGMENT,
            uniforms: { tProbe: { value: this.probeTarget.texture }, tShown: { value: null }, uDt: { value: 0 }, uReset: { value: true } },
            depthTest: false,
            depthWrite: false
        });
        const visibilityScene = new THREE.Scene();
        const visibilityMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), visibilityMaterial);
        visibilityMesh.frustumCulled = false;
        visibilityScene.add(visibilityMesh);
        this.visibilityQuad = { scene: visibilityScene, material: visibilityMaterial };
    }

    setStrength(strength: number): void {
        this.strength = strength;
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
        const now = performance.now();
        this.measureCloud(renderer, sun);
        u.tVisibility.value = this.measureGeometry(renderer, scene, camera, sun, now);
        (u.uSunIrradiance.value as THREE.Color).copy(this.inputs.sunIrradiance()).multiplyScalar(this.strength * up * this.easedCloudVisibility(now));
    }

    /** The cloud visibility, eased (each call glides by the time since the last; the first takes it as it is). */
    easedCloudVisibility(nowMs: number = performance.now()): number {
        if (this.shownCloudVisibility < 0) { this.shownCloudVisibility = this.cloudVisibility; this.lastCloudEaseMs = nowMs; return this.cloudVisibility; }
        const dt = Math.min(0.5, Math.max(0, (nowMs - this.lastCloudEaseMs) / 1000));
        this.lastCloudEaseMs = nowMs;
        this.shownCloudVisibility += (this.cloudVisibility - this.shownCloudVisibility) * (1 - Math.exp(-dt / VISIBILITY_EASE_SECONDS));
        return this.shownCloudVisibility;
    }

    /** The baked sky's radiance at the sun against the disc's cloudless value (read again only when the sky or sun changes). */
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

    /**
     * Draws the 1°-wide view from the camera toward the sun (geometry black on white) and the shown visibility from it
     * (VISIBILITY_FRAGMENT); returns the texture holding it.
     */
    private measureGeometry(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, sun: THREE.Vector3, nowMs: number): THREE.Texture {
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
        const shadowAuto = renderer.shadowMap.autoUpdate, shadowNeeded = renderer.shadowMap.needsUpdate, matrixAuto = scene.matrixWorldAutoUpdate;
        scene.overrideMaterial = this.occluderMaterial;
        scene.background = null;
        scene.fog = null;
        // The probe's material is unlit and the frame's matrices are current. Left on, every probe drew every shadow map
        // again, and the sun's cascades, refitted to the probe's narrow view, were what the passes after the scene draw
        // (the contact shadows) read.
        renderer.shadowMap.autoUpdate = false;
        renderer.shadowMap.needsUpdate = false;
        scene.matrixWorldAutoUpdate = false;
        renderer.setClearColor(0xffffff, 1);
        this.withTarget(renderer, this.probeTarget, () => { renderer.clear(); renderer.render(scene, probe); });
        renderer.setClearColor(clearColor, clearAlpha);
        renderer.shadowMap.autoUpdate = shadowAuto;
        renderer.shadowMap.needsUpdate = shadowNeeded;
        scene.matrixWorldAutoUpdate = matrixAuto;
        scene.overrideMaterial = override;
        scene.background = background;
        scene.fog = fog;
        hidden.forEach(o => { o.visible = true; });

        const v = this.visibilityQuad.material.uniforms;
        const previous = this.visibilityTargets[this.visibilityIndex];
        this.visibilityIndex = 1 - this.visibilityIndex;
        const next = this.visibilityTargets[this.visibilityIndex];
        v.tShown.value = previous.texture;
        v.uReset.value = this.lastProbeMs < 0;
        v.uDt.value = this.lastProbeMs < 0 ? 0 : Math.min(0.5, Math.max(0, (nowMs - this.lastProbeMs) / 1000));
        this.lastProbeMs = nowMs;
        this.withTarget(renderer, next, () => renderer.render(this.visibilityQuad.scene, this.skyQuad.camera));
        return next.texture;
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
        this.visibilityQuad.material.dispose();
        (this.visibilityQuad.scene.children[0] as THREE.Mesh).geometry.dispose();
        this.occluderMaterial.dispose();
        this.probeTarget.dispose();
        this.skyTarget.dispose();
        this.visibilityTargets.forEach(t => t.dispose());
    }
}
