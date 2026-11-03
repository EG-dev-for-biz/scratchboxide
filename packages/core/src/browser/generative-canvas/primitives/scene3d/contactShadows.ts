/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Screen-space contact shadows for the sky's sun, in the viewport's post stack (the aerial perspective pass, beside the
 * contact ambient occlusion; off where that pass is, so in studio scenes and splat worlds). Past the nearest cascade a
 * shadow texel is a decimetre or more, so a sill, a cornice or a mullion 50-200 m out casts nothing the map can hold.
 * Here each pixel that faces the sun marches a short ray toward it through the scene's depth: a surface in front of the
 * ray within a ray's length is a blocker, and the sun's share of the pixel's light is taken away.
 *
 * Only where the cascades call the pixel sunlit (read from the sun's own shadow map at the pixel's world position), so
 * nothing the shadow map already shadows is darkened twice; the ray grows with distance (about 1.2% of it, 0.25-3 m),
 * staying 10-20 pixels long, and the effect fades in over the nearest cascade's far half.
 */

import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { isCascadedSunShadow, SUN_SHADOW_CASCADES, type SunCascadeShadow } from './sunShadowCascades';

export interface ContactShadowLights {
    /** The sky's sun (shining from its position toward the origin); its cascades gate the effect when it has them. */
    sun: THREE.DirectionalLight;
    /** The sky's fill, for the sun's share of a surface's light. */
    hemi?: THREE.HemisphereLight | null;
}

export interface ContactShadowSettings {
    steps: number;
    /** Ray length per metre of distance from the camera, and its bounds, metres. */
    lengthPerMetre: number;
    minLengthM: number;
    maxLengthM: number;
    /** How far behind a blocker's front the ray may pass and still be blocked, in ray lengths. */
    thickness: number;
}

export const CONTACT_SHADOW_DEFAULTS: ContactShadowSettings = { steps: 16, lengthPerMetre: 0.012, minLengthM: 0.25, maxLengthM: 3, thickness: 1.5 };

/** View depth past which contact shadows are fully on when the sun has no cascades, metres (they fade in from half). */
const FADE_END_WITHOUT_CASCADES_M = 15;

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FRAGMENT = /* glsl */ `
uniform sampler2D tDepth;
uniform sampler2D uShadowMap;
uniform vec2 resolution;
uniform mat4 uProj;
uniform mat4 uProjInv;
uniform mat4 uViewToWorld;
uniform vec3 uSunView;
uniform float uSunE;
uniform float uSkyE;
uniform mat4 uShadowMatrix[CASCADES];
uniform vec4 uCascade[CASCADES];
uniform vec2 uShadowMapSize;
uniform float uHasShadow;
uniform vec2 uFade;
uniform float uLengthPerMetre;
uniform vec2 uLengthBounds;
uniform float uThickness;
varying vec2 vUv;

vec3 viewPosAt(vec2 uv, float d) {
    vec4 v = uProjInv * vec4(vec3(uv, d) * 2.0 - 1.0, 1.0);
    return v.xyz / v.w;
}

// The share of the pixel the sun's cascades light (2 x 2 nearest taps, blended), 1 where no cascade covers it.
float litByCascades(vec3 viewPos, vec3 nView) {
    if (uHasShadow < 0.5) return 1.0;
    float vd = -viewPos.z;
    int idx = -1;
    for (int i = 0; i < CASCADES; i++) if (idx < 0 && vd >= uCascade[i].x && vd < uCascade[i].y) idx = i;
    if (idx < 0) return 1.0;
    mat4 M = uShadowMatrix[idx];
    float uvPerM = length(vec3(M[0][0], M[1][0], M[2][0]));
    float zPerM = length(vec3(M[0][2], M[1][2], M[2][2]));
    vec2 texel = 1.0 / uShadowMapSize;
    float texelM = texel.x / uvPerM;
    vec3 world = (uViewToWorld * vec4(viewPos, 1.0)).xyz;
    vec3 nWorld = normalize(mat3(uViewToWorld) * nView);
    vec4 c4 = M * vec4(world + nWorld * (2.0 * texelM), 1.0);
    vec3 c = c4.xyz / c4.w;
    if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
    float z = c.z - texelM * zPerM;
    vec2 st = c.xy * uShadowMapSize - 0.5;
    vec2 f = fract(st);
    vec2 base = (floor(st) + 0.5) * texel;
    float a = step(z, texture2D(uShadowMap, base).x);
    float b = step(z, texture2D(uShadowMap, base + vec2(texel.x, 0.0)).x);
    float cc = step(z, texture2D(uShadowMap, base + vec2(0.0, texel.y)).x);
    float d = step(z, texture2D(uShadowMap, base + texel).x);
    return mix(mix(a, b, f.x), mix(cc, d, f.x), f.y);
}

void main() {
    float depth = texture2D(tDepth, vUv).x;
    if (depth >= 1.0) { gl_FragColor = vec4(1.0); return; }
    vec3 P = viewPosAt(vUv, depth);
    float dist = length(P);
    // one pixel's footprint at this distance, metres
    float pixelM = 2.0 * dist / (uProj[1][1] * resolution.y);
    // the face's normal from the depth (outward, toward the camera); none at a depth jump (a silhouette against the sky
    // or a nearer building), where the neighbouring pixel lies far further than even a grazing surface reaches
    vec3 dx = dFdx(P), dy = dFdy(P);
    if (max(length(dx), length(dy)) > 30.0 * pixelM) { gl_FragColor = vec4(1.0); return; }
    vec3 N = normalize(cross(dx, dy));
    if (dot(N, -P) < 0.0) N = -N;
    float ndl = dot(N, uSunView);
    float fade = smoothstep(uFade.x, uFade.y, -P.z);
    if (ndl <= 0.0 || fade <= 0.0) { gl_FragColor = vec4(1.0); return; }
    float lit = litByCascades(P, N);
    if (lit <= 0.0) { gl_FragColor = vec4(1.0); return; }
    float len = clamp(dist * uLengthPerMetre, uLengthBounds.x, uLengthBounds.y);
    vec3 start = P + N * (0.5 * pixelM);
    float occluded = 0.0;
    for (int i = 1; i <= STEPS; i++) {
        float t = float(i) / float(STEPS);
        vec3 q = start + uSunView * (len * t);
        vec4 cq = uProj * vec4(q, 1.0);
        vec2 uv = cq.xy / cq.w * 0.5 + 0.5;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
        float sd = texture2D(tDepth, uv).x;
        if (sd >= 1.0) continue;
        // the scene's surface at that pixel, in front of the sample (toward the camera) by dz metres
        float dz = viewPosAt(uv, sd).z - q.z;
        if (dz > 0.25 * pixelM + 0.002 && dz < len * uThickness) {
            // a blocker near the start shadows fully; one at the ray's far end only a little
            occluded = 1.0 - t * t;
            break;
        }
    }
    float sunShare = uSunE * ndl / max(uSunE * ndl + uSkyE, 1e-6);
    float m = 1.0 - occluded * lit * sunShare * fade;
    gl_FragColor = vec4(m, m, m, 1.0);
}`;

const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

export class ContactShadows {
    readonly settings: ContactShadowSettings;
    /** Applied in full: the multiplier already holds the sun's share of the light. */
    readonly intensity = 1;
    private readonly target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    private readonly material: THREE.ShaderMaterial;
    private readonly quad: FullScreenQuad;
    private readonly clearColor = new THREE.Color();
    private readonly sunWorld = new THREE.Vector3();

    constructor(private readonly lights: () => ContactShadowLights | null, settings: Partial<ContactShadowSettings> = {}) {
        this.settings = { ...CONTACT_SHADOW_DEFAULTS, ...settings };
        this.material = new THREE.ShaderMaterial({
            name: 'ContactShadows',
            defines: { STEPS: this.settings.steps, CASCADES: SUN_SHADOW_CASCADES },
            uniforms: {
                tDepth: { value: null },
                uShadowMap: { value: null },
                resolution: { value: new THREE.Vector2() },
                uProj: { value: new THREE.Matrix4() },
                uProjInv: { value: new THREE.Matrix4() },
                uViewToWorld: { value: new THREE.Matrix4() },
                uSunView: { value: new THREE.Vector3(0, 1, 0) },
                uSunE: { value: 1 },
                uSkyE: { value: 0 },
                uShadowMatrix: { value: Array.from({ length: SUN_SHADOW_CASCADES }, () => new THREE.Matrix4()) },
                uCascade: { value: Array.from({ length: SUN_SHADOW_CASCADES }, () => new THREE.Vector4(0, 0, 0, 0)) },
                uShadowMapSize: { value: new THREE.Vector2(1, 1) },
                uHasShadow: { value: 0 },
                uFade: { value: new THREE.Vector2(FADE_END_WITHOUT_CASCADES_M / 2, FADE_END_WITHOUT_CASCADES_M) },
                uLengthPerMetre: { value: this.settings.lengthPerMetre },
                uLengthBounds: { value: new THREE.Vector2(this.settings.minLengthM, this.settings.maxLengthM) },
                uThickness: { value: this.settings.thickness }
            },
            vertexShader: VERTEX,
            fragmentShader: FRAGMENT,
            blending: THREE.NoBlending, depthTest: false, depthWrite: false
        });
        this.quad = new FullScreenQuad(this.material);
    }

    /**
     * The light multiplier (red; 1 untouched) for the scene just drawn with `camera` into a target whose depth is
     * `depthTexture`, at that target's size. All 1 when there is no sun or it is down.
     */
    render(renderer: THREE.WebGLRenderer, camera: THREE.Camera & { near: number; far: number }, depthTexture: THREE.Texture, width: number, height: number): THREE.Texture {
        if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
        const u = this.material.uniforms;
        const lights = this.lights();
        const sun = lights?.sun;
        const sunUp = !!sun && sun.visible && sun.intensity > 0 && this.sunWorld.setFromMatrixPosition(sun.matrixWorld).normalize().y > 0;
        u.tDepth.value = depthTexture;
        u.resolution.value.set(width, height);
        u.uProj.value.copy(camera.projectionMatrix);
        u.uProjInv.value.copy(camera.projectionMatrixInverse);
        u.uViewToWorld.value.copy(camera.matrixWorld);
        if (sunUp && sun) {
            u.uSunView.value.copy(this.sunWorld).transformDirection(camera.matrixWorldInverse);
            u.uSunE.value = sun.intensity * lum(sun.color);
            u.uSkyE.value = lights?.hemi ? lights.hemi.intensity * lum(lights.hemi.color) : 0;
        } else {
            // no sun: every pixel faces away from it, so the pass writes 1
            u.uSunView.value.set(0, 0, 0);
        }
        const cascades = sun && sun.castShadow && isCascadedSunShadow(sun.shadow) ? sun.shadow as SunCascadeShadow : null;
        const atlas = cascades?.map?.depthTexture ?? null;
        u.uHasShadow.value = atlas ? 1 : 0;
        if (cascades && atlas) {
            u.uShadowMap.value = atlas;
            u.uShadowMapSize.value.copy(cascades.mapSize).multiply(cascades.getFrameExtents());
            for (let i = 0; i < SUN_SHADOW_CASCADES; i++) {
                u.uShadowMatrix.value[i].copy(cascades.getMatrix(i));
                u.uCascade.value[i].copy(cascades._cascadeData[i]);
            }
            // in over the nearest cascade's far half: inside it the map itself resolves contact
            const nearEnd = cascades._cascadeData[0].y;
            u.uFade.value.set(nearEnd / 2, nearEnd);
        } else {
            u.uShadowMap.value = null;
            u.uFade.value.set(FADE_END_WITHOUT_CASCADES_M / 2, FADE_END_WITHOUT_CASCADES_M);
        }

        const previousTarget = renderer.getRenderTarget();
        const previousAutoClear = renderer.autoClear;
        const previousAlpha = renderer.getClearAlpha();
        renderer.getClearColor(this.clearColor);
        renderer.autoClear = false;
        renderer.setClearColor(0xffffff, 1);
        renderer.setRenderTarget(this.target);
        renderer.clear(true, false, false);
        this.quad.render(renderer);
        renderer.setRenderTarget(previousTarget);
        renderer.setClearColor(this.clearColor, previousAlpha);
        renderer.autoClear = previousAutoClear;
        return this.target.texture;
    }

    dispose(): void {
        this.target.dispose();
        this.material.dispose();
        this.quad.dispose();
    }
}
