/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Where the 3D viewport's lens focuses when the scene's camera.lens asks it to measure focus itself:
 *
 * - auto focus (focusMode 'auto'): continuous autofocus on what is at the centre of the frame. Every
 *   AUTO_FOCUS_INTERVAL_MS the scene's own depth buffer (the one depth of field blurs from) is read over a centred
 *   square AF area (autoFocusAreaFraction of the frame height) at AUTO_FOCUS_GRID x AUTO_FOCUS_GRID points; the
 *   nearest robust depth (a low quantile, so one stray pixel does not grab focus) is the target, and the focus glides
 *   toward it with the time constant focusPullSeconds, in dioptres (1 / distance) as a focus ring travels. Sky or no
 *   geometry under the AF area keeps the last focus.
 * - a tracked point (focusMode 'track' with a focusPoint): a surface point stored in its object's local frame; every
 *   frame it is taken to world space through the object's current matrix and its depth along the view axis is the
 *   focus distance, so it follows a moving camera and a moving object. A lost object holds the last distance and
 *   says so.
 * - manual focus with nothing stored yet (no focusDistanceMeters, no focusObjectId): read the same continuous
 *   autofocus as above until a distance or focus object is set. This is what keeps depth of field from ever refusing
 *   to draw just because a distance hasn't been picked — manual is a precise override once given one, not a
 *   precondition for drawing at all.
 *
 * Manual focus with a stored distance, and a whole tracked object (focusObjectId), stay with ViewportOpticsChain.
 * Nothing here branches on scene content: the AF area, pull time and point are continuous values.
 */

import * as THREE from 'three';
import type { SceneCameraLens, SceneFocusPoint } from '../../canvas-types';
import { VfxPlateMatchmoveService } from '../../services/video/VfxPlateMatchmoveService';

export type FocusMode = NonNullable<SceneCameraLens['focusMode']>;

/** The focus modes the viewport draws (the operator refuses others). */
export const FOCUS_MODES_DRAWN: readonly string[] = ['manual', 'auto', 'track'];
/** AF area side as a fraction of the frame height when the lens sets none. */
export const DEFAULT_AUTO_FOCUS_AREA_FRACTION = 0.1;
/** Focus-pull time constant (s) when the lens sets none: about 0.7 s to cover 90 % of a pull. */
export const DEFAULT_FOCUS_PULL_SECONDS = 0.3;
/** How often auto focus reads the depth under the AF area. */
export const AUTO_FOCUS_INTERVAL_MS = 100;
/** Depth samples per side of the AF area. */
export const AUTO_FOCUS_GRID = 5;
/** The nearest robust depth: this quantile of the samples that hit geometry. */
export const AUTO_FOCUS_NEAR_QUANTILE = 0.2;
/** A frame gap longer than this (a hidden tab) is taken as this long for the focus pull. */
const MAX_PULL_STEP_SECONDS = 1;
/** A depth-buffer value this close to 1 is the cleared far plane: sky / nothing. */
const FAR_PLANE_EPSILON = 2 ** -22;

const finitePositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

export function isFocusPoint(p: unknown): p is SceneFocusPoint {
    const q = p as SceneFocusPoint | null | undefined;
    return !!q && Array.isArray(q.localPosition) && q.localPosition.length === 3 && q.localPosition.every(v => typeof v === 'number' && Number.isFinite(v))
        && (q.objectId === undefined || (typeof q.objectId === 'string' && q.objectId.length > 0));
}

/** The mode a lens focuses in: its focusMode, else 'track' when it names a point or object, else 'manual'. */
export function effectiveFocusMode(lens: SceneCameraLens | undefined | null): FocusMode {
    if (typeof lens?.focusMode === 'string' && lens.focusMode) return lens.focusMode;
    return isFocusPoint(lens?.focusPoint) || (typeof lens?.focusObjectId === 'string' && lens.focusObjectId) ? 'track' : 'manual';
}

/**
 * True when the viewport measures the focus distance itself, so none needs to be stored: auto focus, a tracked
 * point, or manual focus with nothing stored yet (depth of field then draws from a continuous autofocus read instead
 * of refusing to draw — manual becomes a precise override the moment a distance or focus object is set, never a
 * trap that blocks depth of field on an unset field).
 */
export function lensMeasuresFocus(lens: SceneCameraLens | undefined | null): boolean {
    const mode = effectiveFocusMode(lens);
    if (mode === 'auto') return true;
    if (mode === 'track') return isFocusPoint(lens?.focusPoint);
    const hasStoredFocus = finitePositive(lens?.focusDistanceMeters) || (typeof lens?.focusObjectId === 'string' && lens.focusObjectId.length > 0);
    return !hasStoredFocus;
}

export function autoFocusAreaOf(lens: SceneCameraLens | undefined | null): number {
    const a = lens?.autoFocusAreaFraction;
    return finitePositive(a) ? Math.min(1, a) : DEFAULT_AUTO_FOCUS_AREA_FRACTION;
}

export function focusPullSecondsOf(lens: SceneCameraLens | undefined | null): number {
    const t = lens?.focusPullSeconds;
    return typeof t === 'number' && Number.isFinite(t) && t >= 0 ? t : DEFAULT_FOCUS_PULL_SECONDS;
}

/**
 * The nearest robust depth of AF samples: the `quantile` of the finite positive ones (sky / misses are left out), or
 * null when none hit. A low quantile takes the nearest surface that covers part of the area, not one stray pixel.
 */
export function robustNearestDepth(depths: ArrayLike<number>, quantile = AUTO_FOCUS_NEAR_QUANTILE): number | null {
    const hits: number[] = [];
    for (let i = 0; i < depths.length; i++) if (finitePositive(depths[i])) hits.push(depths[i]);
    if (hits.length === 0) return null;
    hits.sort((a, b) => a - b);
    const q = Math.min(1, Math.max(0, quantile));
    return hits[Math.round(q * (hits.length - 1))];
}

/**
 * One step of the focus pull: an exponential approach with time constant `tauSec` in dioptres (1 / distance), the
 * way a focus ring moves, so a pull from 2 m to 50 m does not crawl through the near range. tau 0 snaps.
 */
export function focusPullStep(currentM: number, targetM: number, dtSec: number, tauSec: number): number {
    if (!(tauSec > 0) || !finitePositive(currentM)) return targetM;
    const a = 1 - Math.exp(-Math.max(0, dtSec) / tauSec);
    const d = 1 / currentM + (1 / targetM - 1 / currentM) * a;
    return d > 0 ? 1 / d : targetM;
}

/** A perspective depth-buffer value (0..1) -> depth along the view axis in metres; null for the far plane (sky). */
export function depthBufferToViewDepth(raw: number, near: number, far: number): number | null {
    if (!(raw < 1 - FAR_PLANE_EPSILON) || !(raw >= 0)) return null;
    const zNdc = 2 * raw - 1;
    return (2 * near * far) / (far + near - zNdc * (far - near));
}

/** Inverse of three's packDepthToRGBA (bytes 0..255). */
export function unpackRgbaDepth(r: number, g: number, b: number, a: number): number {
    const down = 255 / 256;
    return (r / 255) * down + (g / 255) * (down / 256) + (b / 255) * (down / 65536) + (a / 255) / 16777216;
}

/** The AF area's half extent in UV of the rendered target (the target may be overscanned around the frame). */
export function autoFocusHalfExtentUv(areaFraction: number, frame: ViewportFocusFrame): [number, number] {
    const sidePx = Math.min(1, Math.max(0, areaFraction)) * frame.height;
    return [sidePx / (2 * frame.renderWidth), sidePx / (2 * frame.renderHeight)];
}

/** Depth of a world point along the camera's view axis (what the thin lens focuses at). */
export function viewAxisDepth(world: THREE.Vector3, camera: THREE.Camera, scratch = new THREE.Vector3()): number {
    camera.updateMatrixWorld();
    return -scratch.copy(world).applyMatrix4(camera.matrixWorldInverse).z;
}

/** World position of a focus point now (through its object's current world matrix), or null when the object is gone. */
export function focusPointWorld(point: SceneFocusPoint, resolveObject: (id: string) => THREE.Object3D | undefined, out = new THREE.Vector3()): THREE.Vector3 | null {
    out.set(point.localPosition[0], point.localPosition[1], point.localPosition[2]);
    if (!point.objectId) return out;
    const object = resolveObject(point.objectId);
    if (!object || !object.parent) return null;
    object.updateWorldMatrix(true, false);
    return out.applyMatrix4(object.matrixWorld);
}

/**
 * A pinhole NDC -> where the distorted frame draws it (the forward map of displayedNdcToPinholeNdc), so the reticle
 * sits on the tracked point when the lens bends the image.
 */
export function pinholeNdcToDisplayedNdc(
    ndcX: number, ndcY: number,
    distortion: { coefficients: { k1: number; k2: number; k3: number; p1: number; p2: number }; anamorphicSqueeze: number },
    verticalFovDeg: number, aspect: number
): [number, number] {
    const s = 2 * Math.tan(THREE.MathUtils.degToRad(verticalFovDeg) / 2);
    const squeeze = distortion.anamorphicSqueeze || 1;
    const xu = (ndcX * aspect / 2) * s / squeeze;
    const yu = (ndcY / 2) * s;
    const [xd, yd] = VfxPlateMatchmoveService.distortPoint(xu, yu, distortion.coefficients);
    return [(xd * squeeze / s) * 2 / aspect, (yd / s) * 2];
}

/** The frame being drawn: its size and the (possibly overscanned) size of the target the scene was rendered into. */
export interface ViewportFocusFrame {
    width: number;
    height: number;
    renderWidth: number;
    renderHeight: number;
}

export interface ViewportFocusStatus {
    mode: FocusMode;
    /** The focus distance drawn last frame. */
    distanceMeters: number | null;
    /** Auto focus: the depth the last AF read measured (the pull glides toward it). */
    targetMeters: number | null;
    /** Why focus is held (lost object, sky under the AF area), or null. */
    notice: string | null;
    /** A tracked point's world position last frame. */
    worldPoint: [number, number, number] | null;
    /** Auto focus: number of AF reads so far (for checks). */
    reads: number;
}

const SAMPLER_SHADER = {
    vertexShader: /* glsl */ `
        void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */ `
        #include <packing>
        uniform sampler2D tDepth;
        uniform vec2 uHalf;
        uniform float uGrid;
        void main() {
            vec2 cell = floor(gl_FragCoord.xy);
            vec2 t = uGrid > 1.0 ? cell / (uGrid - 1.0) : vec2(0.5);
            vec2 uv = vec2(0.5) + (t - 0.5) * 2.0 * uHalf;
            gl_FragColor = packDepthToRGBA(texture2D(tDepth, uv).x);
        }
    `
};

/**
 * Measures the focus distance for auto focus and a tracked point (see the file comment). The optics chain calls
 * focusDistance() once per frame with the scene's depth texture; it returns undefined for the modes the chain
 * resolves itself (manual, a whole focus object).
 */
export class ViewportFocusController {
    private lens: SceneCameraLens | undefined;
    private mode: FocusMode = 'manual';
    private key = '';
    private current: number | null = null;
    private target: number | null = null;
    private lastReadMs = -Infinity;
    private lastStepMs: number | null = null;
    private sampler: { target: THREE.WebGLRenderTarget; scene: THREE.Scene; camera: THREE.OrthographicCamera; material: THREE.ShaderMaterial; mesh: THREE.Mesh; pixels: Uint8Array } | null = null;
    private readonly world = new THREE.Vector3();
    private readonly scratch = new THREE.Vector3();
    public status: ViewportFocusStatus = { mode: 'manual', distanceMeters: null, targetMeters: null, notice: null, worldPoint: null, reads: 0 };

    public configure(lens: SceneCameraLens | undefined | null): void {
        this.lens = lens ?? undefined;
        this.mode = effectiveFocusMode(lens);
        // a new mode or target starts from the stored distance; other edits (AF area, pull time, f-stop) keep the glide
        const key = JSON.stringify([this.mode, lens?.focusPoint ?? null, lens?.focusObjectId ?? null]);
        if (key !== this.key) {
            this.key = key;
            this.current = finitePositive(lens?.focusDistanceMeters) ? lens!.focusDistanceMeters! : null;
            this.target = null;
            this.lastReadMs = -Infinity;
            this.lastStepMs = null;
            this.status = { mode: this.mode, distanceMeters: this.current, targetMeters: null, notice: null, worldPoint: null, reads: 0 };
        } else {
            this.status = { ...this.status, mode: this.mode };
        }
        if (!lensMeasuresFocus(lens)) this.disposeSampler();
    }

    /** True when this controller sets the focus distance (auto focus or a tracked point). */
    public get measures(): boolean {
        return lensMeasuresFocus(this.lens);
    }

    public get focusMode(): FocusMode {
        return this.mode;
    }

    public get areaFraction(): number {
        return autoFocusAreaOf(this.lens);
    }

    /**
     * The focus distance for this frame, null when there is none yet (an issue says why), or undefined when the chain
     * resolves focus itself. `nowMs` drives the throttle and the pull (performance.now()).
     */
    public focusDistance(
        renderer: THREE.WebGLRenderer,
        camera: THREE.PerspectiveCamera,
        depthTexture: THREE.Texture | null,
        frame: ViewportFocusFrame,
        resolveObject: (id: string) => THREE.Object3D | undefined,
        nowMs: number,
        issues: string[]
    ): number | null | undefined {
        if (!this.measures) return undefined;
        const minDepth = finitePositive(this.lens?.focalLengthMm) ? this.lens!.focalLengthMm! / 1000 : 0;
        // only an actual tracked point follows an object; every other measuring case (auto, or manual with nothing
        // stored yet) reads the live autofocus the same way
        const d = this.mode === 'track'
            ? this.trackPoint(camera, resolveObject, minDepth)
            : this.autoFocus(renderer, camera, depthTexture, frame, minDepth, nowMs);
        if (this.status.notice) issues.push(this.status.notice);
        this.status.distanceMeters = d;
        return d;
    }

    /** A tracked point's world position now (for the reticle), or null. */
    public trackedPointWorld(resolveObject: (id: string) => THREE.Object3D | undefined): THREE.Vector3 | null {
        const p = this.lens?.focusPoint;
        if (this.mode !== 'track' || !isFocusPoint(p)) return null;
        return focusPointWorld(p, resolveObject, this.world);
    }

    private autoFocus(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, depthTexture: THREE.Texture | null, frame: ViewportFocusFrame, minDepth: number, nowMs: number): number | null {
        if (depthTexture && nowMs - this.lastReadMs >= AUTO_FOCUS_INTERVAL_MS) {
            this.lastReadMs = nowMs;
            const depths = this.readAreaDepths(renderer, camera, depthTexture, frame);
            const nearest = robustNearestDepth(depths.filter(v => v > minDepth));
            this.status.reads++;
            if (nearest === null) {
                const held = this.current ?? this.target;
                this.status.notice = held !== null
                    ? `focus: auto focus sees no surface under the AF area (sky or empty); holding ${held.toFixed(2)} m`
                    : 'focus: auto focus sees no surface under the AF area yet (sky or empty); point the centre of the frame at geometry';
            } else {
                this.target = nearest;
                this.status.notice = null;
            }
            this.status.targetMeters = this.target;
        }
        const dt = this.lastStepMs === null ? 0 : Math.min(MAX_PULL_STEP_SECONDS, (nowMs - this.lastStepMs) / 1000);
        this.lastStepMs = nowMs;
        if (this.target !== null) {
            this.current = this.current === null ? this.target : focusPullStep(this.current, this.target, dt, focusPullSecondsOf(this.lens));
        }
        return this.current;
    }

    private trackPoint(camera: THREE.PerspectiveCamera, resolveObject: (id: string) => THREE.Object3D | undefined, minDepth: number): number | null {
        const point = this.lens!.focusPoint!;
        const world = focusPointWorld(point, resolveObject, this.world);
        const held = () => this.current !== null ? `; holding the last focus distance ${this.current.toFixed(2)} m` : '';
        if (!world) {
            this.status.worldPoint = null;
            this.status.notice = `focus: the tracked point's object '${point.objectId}' is not in the viewport${held()}`;
            return this.current;
        }
        this.status.worldPoint = [world.x, world.y, world.z];
        const depth = viewAxisDepth(world, camera, this.scratch);
        if (!(depth > minDepth)) {
            this.status.notice = `focus: the tracked point is behind the camera or inside the focal length${held()}`;
            return this.current;
        }
        this.status.notice = null;
        this.current = depth;
        return depth;
    }

    /** Depths (m) at the AF grid; 0 where the depth buffer holds the far plane. */
    private readAreaDepths(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, depthTexture: THREE.Texture, frame: ViewportFocusFrame): number[] {
        const n = AUTO_FOCUS_GRID;
        if (!this.sampler) {
            const target = new THREE.WebGLRenderTarget(n, n, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
            const material = new THREE.ShaderMaterial({
                uniforms: { tDepth: { value: null }, uHalf: { value: new THREE.Vector2() }, uGrid: { value: n } },
                vertexShader: SAMPLER_SHADER.vertexShader,
                fragmentShader: SAMPLER_SHADER.fragmentShader,
                depthTest: false,
                depthWrite: false
            });
            const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
            mesh.frustumCulled = false;
            const scene = new THREE.Scene();
            scene.add(mesh);
            this.sampler = { target, scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), material, mesh, pixels: new Uint8Array(n * n * 4) };
        }
        const s = this.sampler;
        s.material.uniforms.tDepth.value = depthTexture;
        const [hu, hv] = autoFocusHalfExtentUv(autoFocusAreaOf(this.lens), frame);
        (s.material.uniforms.uHalf.value as THREE.Vector2).set(hu, hv);
        const previous = renderer.getRenderTarget();
        const autoClear = renderer.autoClear;
        try {
            renderer.autoClear = true;
            renderer.setRenderTarget(s.target);
            renderer.render(s.scene, s.camera);
            renderer.readRenderTargetPixels(s.target, 0, 0, n, n, s.pixels);
        } finally {
            renderer.autoClear = autoClear;
            renderer.setRenderTarget(previous);
        }
        const out: number[] = [];
        for (let i = 0; i < n * n; i++) {
            const p = s.pixels;
            const raw = unpackRgbaDepth(p[4 * i], p[4 * i + 1], p[4 * i + 2], p[4 * i + 3]);
            out.push(depthBufferToViewDepth(raw, camera.near, camera.far) ?? 0);
        }
        return out;
    }

    private disposeSampler(): void {
        if (!this.sampler) return;
        this.sampler.target.dispose();
        this.sampler.material.dispose();
        this.sampler.mesh.geometry.dispose();
        this.sampler = null;
    }

    public dispose(): void {
        this.disposeSampler();
    }
}
