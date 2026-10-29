/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Temporal anti-aliasing for the optics chain, run on the scene draw before depth of field, distortion, flare and
 * diffusion, so every lens effect reads a frame that is steady under sub-pixel motion.
 *  - jitter: each frame the projection is offset by a sub-pixel Halton (2, 3) step, so over a few frames each pixel
 *    integrates its whole footprint, and detail smaller than a pixel (a distant lamp, a glint, a window mullion) is
 *    averaged instead of being hit on one frame and missed on the next;
 *  - reprojection: each pixel's world point (from the depth buffer and the unjittered camera) is projected through the
 *    previous frame's unjittered camera to find where it was, and the history is read there (Catmull-Rom, so it stays
 *    sharp);
 *  - neighbourhood clip: the history is clipped to the variance box of the current frame's 3 x 3 neighbourhood in YCoCg,
 *    so moving objects (which carry no motion vectors) and disocclusions do not ghost;
 *  - the blend weights each sample by 1 / (1 + luma), so one very bright sample (the sun's disc) cannot dominate the
 *    average and pop.
 * Colour is the chain's linear, coverage-premultiplied RGBA; alpha is blended and box-clamped with it.
 */

import * as THREE from 'three';

const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const RESOLVE_FRAGMENT = /* glsl */ `
uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform float uCurrentWeight;
uniform bool uHasHistory;
varying vec2 vUv;

vec4 sbFinite(vec4 c) {
    for (int k = 0; k < 4; k++) if (!(c[k] == c[k])) c[k] = 0.0;
    return clamp(c, vec4(-6.0e4), vec4(6.0e4));
}
vec3 toYCoCg(vec3 c) { return vec3(dot(c, vec3(0.25, 0.5, 0.25)), dot(c, vec3(0.5, 0.0, -0.5)), dot(c, vec3(-0.25, 0.5, -0.25))); }
vec3 fromYCoCg(vec3 c) { return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }
// compresses brightness so the clip box and the blend are not ruled by a few very bright samples
float luma(vec3 c) { return max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0); }
vec3 compress(vec3 c) { return c / (1.0 + luma(c)); }
vec3 expand(vec3 c) { return c / max(1.0 - luma(c), 1e-4); }

// Catmull-Rom history read in 5 bilinear taps (the corners' weight is small and dropped)
vec4 sampleHistory(vec2 uv) {
    vec2 size = 1.0 / uTexel;
    vec2 pos = uv * size;
    vec2 c = floor(pos - 0.5) + 0.5;
    vec2 f = pos - c;
    vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
    vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
    vec2 w3 = f * f * (-0.5 + 0.5 * f);
    vec2 w12 = w1 + w2;
    vec2 tc12 = (c + w2 / w12) * uTexel;
    vec2 tc0 = (c - 1.0) * uTexel;
    vec2 tc3 = (c + 2.0) * uTexel;
    vec4 s = texture2D(tHistory, vec2(tc12.x, tc0.y)) * (w12.x * w0.y)
           + texture2D(tHistory, vec2(tc0.x, tc12.y)) * (w0.x * w12.y)
           + texture2D(tHistory, tc12) * (w12.x * w12.y)
           + texture2D(tHistory, vec2(tc3.x, tc12.y)) * (w3.x * w12.y)
           + texture2D(tHistory, vec2(tc12.x, tc3.y)) * (w12.x * w3.y);
    float wsum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
    return max(s / wsum, vec4(0.0));
}

void main() {
    vec4 cur = sbFinite(texture2D(tCurrent, vUv));
    if (!uHasHistory) { gl_FragColor = cur; return; }

    // neighbourhood statistics in compressed YCoCg; the nearest depth of the 3 x 3 (so an edge reprojects with its
    // foreground)
    vec3 m1 = vec3(0.0), m2 = vec3(0.0);
    float aMin = 1.0, aMax = 0.0;
    float depth = 1.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 o = vec2(float(x), float(y)) * uTexel;
            vec4 s = sbFinite(texture2D(tCurrent, vUv + o));
            vec3 q = toYCoCg(compress(max(s.rgb, vec3(0.0))));
            m1 += q; m2 += q * q;
            aMin = min(aMin, s.a); aMax = max(aMax, s.a);
            depth = min(depth, texture2D(tDepth, vUv + o).x);
        }
    }
    vec3 mean = m1 / 9.0;
    vec3 sigma = sqrt(max(m2 / 9.0 - mean * mean, vec3(0.0)));
    vec3 boxMin = mean - 1.25 * sigma, boxMax = mean + 1.25 * sigma;

    // where this pixel's surface was last frame
    vec4 world = uInvViewProj * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    world /= world.w;
    vec4 prev = uPrevViewProj * world;
    vec2 prevUv = prev.xy / prev.w * 0.5 + 0.5;
    if (prev.w <= 0.0 || any(lessThan(prevUv, vec2(0.0))) || any(greaterThan(prevUv, vec2(1.0)))) { gl_FragColor = cur; return; }

    vec4 hist = sbFinite(sampleHistory(prevUv));
    vec3 hq = toYCoCg(compress(hist.rgb));
    // clip toward the box centre (not a per-channel clamp, which shifts hue)
    vec3 d = hq - mean;
    vec3 ext = max(boxMax - mean, vec3(1e-5));
    float t = max(max(abs(d.x) / ext.x, abs(d.y) / ext.y), abs(d.z) / ext.z);
    if (t > 1.0) hq = mean + d / t;
    float ha = clamp(hist.a, aMin, aMax);

    // the blend, in compressed space: one very bright sample cannot own the average
    vec3 cq = toYCoCg(compress(max(cur.rgb, vec3(0.0))));
    // a fast reprojection (in pixels) leans on the current frame: the history is blurrier the more it moved
    float speed = length((prevUv - vUv) / uTexel);
    float w = clamp(uCurrentWeight + speed * 0.02, uCurrentWeight, 0.5);
    vec3 outQ = mix(hq, cq, w);
    gl_FragColor = vec4(expand(fromYCoCg(outQ)), mix(ha, cur.a, w));
}`;

/** The Halton (2, 3) sequence, centred: sub-pixel offsets in [-0.5, 0.5). */
export function haltonJitter(index: number, length = 8): [number, number] {
    const halton = (i: number, b: number) => {
        let f = 1, r = 0;
        for (let n = i; n > 0; n = Math.floor(n / b)) { f /= b; r += f * (n % b); }
        return r;
    };
    const i = (index % length) + 1;
    return [halton(i, 2) - 0.5, halton(i, 3) - 0.5];
}

/** A turn of the view this large between two frames, or a zoom this large, is a cut: the history is dropped. */
export const CUT_TURN_DEGREES = 10;
export const CUT_ZOOM_RATIO = 1.05;

export interface CameraPose { forward: THREE.Vector3; fov: number }

function poseOf(camera: THREE.PerspectiveCamera, reuse: CameraPose | null): CameraPose {
    const pose = reuse ?? { forward: new THREE.Vector3(), fov: camera.fov };
    camera.getWorldDirection(pose.forward);
    pose.fov = camera.fov;
    return pose;
}

/**
 * True when the camera jumped since the last pose: turned more than CUT_TURN_DEGREES or zoomed past CUT_ZOOM_RATIO
 * in one frame. Moving the camera along is not a cut (reprojection follows it; the clip catches what it uncovers).
 */
export function isCameraCut(last: CameraPose | null, camera: THREE.PerspectiveCamera): boolean {
    if (!last) return false;
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const turn = THREE.MathUtils.radToDeg(forward.angleTo(last.forward));
    const zoom = Math.max(camera.fov, last.fov) / Math.max(1e-6, Math.min(camera.fov, last.fov));
    return turn > CUT_TURN_DEGREES || zoom > CUT_ZOOM_RATIO;
}

/** Share of the current frame in each blend: about the last 10 frames are averaged at rest. */
export const TAA_CURRENT_WEIGHT = 0.1;

export class TemporalAAPass {
    private readonly material: THREE.ShaderMaterial;
    private readonly quad: THREE.Mesh;
    private readonly copyMaterial = new THREE.ShaderMaterial({
        uniforms: { tSrc: { value: null } },
        vertexShader: QUAD_VERTEX,
        fragmentShader: 'uniform sampler2D tSrc; varying vec2 vUv; void main() { gl_FragColor = texture2D(tSrc, vUv); }',
        depthTest: false,
        depthWrite: false
    });
    private readonly scene = new THREE.Scene();
    private readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    private history: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
    private read = 0;
    private hasHistory = false;
    private frameIndex = 0;
    private readonly viewProj = new THREE.Matrix4();
    private readonly prevViewProj = new THREE.Matrix4();
    private jitterPx: [number, number] = [0, 0];
    private lastPose: CameraPose | null = null;

    constructor() {
        this.material = new THREE.ShaderMaterial({
            uniforms: {
                tCurrent: { value: null }, tHistory: { value: null }, tDepth: { value: null },
                uTexel: { value: new THREE.Vector2() }, uInvViewProj: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() },
                uCurrentWeight: { value: TAA_CURRENT_WEIGHT }, uHasHistory: { value: false }
            },
            vertexShader: QUAD_VERTEX,
            fragmentShader: RESOLVE_FRAGMENT,
            depthTest: false,
            depthWrite: false
        });
        this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
        this.quad.frustumCulled = false;
        this.scene.add(this.quad);
    }

    /**
     * Offsets the camera's projection by this frame's sub-pixel jitter (call after any setViewOffset, before the scene
     * draw). The unjittered view-projection is kept for the resolve; call endJitter after the draw to remove it.
     */
    beginJitter(camera: THREE.PerspectiveCamera, width: number, height: number): void {
        camera.updateMatrixWorld();
        if (isCameraCut(this.lastPose, camera)) this.hasHistory = false;
        this.lastPose = poseOf(camera, this.lastPose);
        this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        this.jitterPx = haltonJitter(this.frameIndex++);
        const e = camera.projectionMatrix.elements;
        // clip x += 2 jx / W * w (w = -z_view): the third column scales z_view
        e[8] -= (2 * this.jitterPx[0]) / width;
        e[9] -= (2 * this.jitterPx[1]) / height;
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    }

    endJitter(camera: THREE.PerspectiveCamera): void {
        camera.updateProjectionMatrix();
    }

    /** The jitter applied to the frame being drawn, in pixels. */
    get jitter(): [number, number] {
        return [...this.jitterPx];
    }

    /** Forgets the history (a camera cut, a new scene): the next frame starts the average afresh. */
    reset(): void {
        this.hasHistory = false;
    }

    /** Blends the jittered frame into the history; returns the resolved frame (valid until the next render). */
    render(renderer: THREE.WebGLRenderer, current: THREE.Texture, depth: THREE.Texture, width: number, height: number): THREE.WebGLRenderTarget {
        if (!this.history || this.history[0].width !== width || this.history[0].height !== height) {
            this.history?.forEach(t => t.dispose());
            const make = () => new THREE.WebGLRenderTarget(width, height, {
                type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false
            });
            this.history = [make(), make()];
            this.hasHistory = false;
        }
        const u = this.material.uniforms;
        u.tCurrent.value = current;
        u.tDepth.value = depth;
        u.tHistory.value = this.history[this.read].texture;
        (u.uTexel.value as THREE.Vector2).set(1 / width, 1 / height);
        (u.uInvViewProj.value as THREE.Matrix4).copy(this.viewProj).invert();
        (u.uPrevViewProj.value as THREE.Matrix4).copy(this.prevViewProj);
        u.uHasHistory.value = this.hasHistory;
        const out = this.history[1 - this.read];
        renderer.setRenderTarget(out);
        renderer.render(this.scene, this.ortho);
        this.read = 1 - this.read;
        this.prevViewProj.copy(this.viewProj);
        this.hasHistory = true;
        return out;
    }

    /** Copies a texture into a target (the resolved frame onto a target overlays may draw on). */
    copy(renderer: THREE.WebGLRenderer, source: THREE.Texture, target: THREE.WebGLRenderTarget): void {
        this.copyMaterial.uniforms.tSrc.value = source;
        this.quad.material = this.copyMaterial;
        renderer.setRenderTarget(target);
        renderer.render(this.scene, this.ortho);
        this.quad.material = this.material;
    }

    dispose(): void {
        this.copyMaterial.dispose();
        this.history?.forEach(t => t.dispose());
        this.history = null;
        this.material.dispose();
        this.quad.geometry.dispose();
    }
}
