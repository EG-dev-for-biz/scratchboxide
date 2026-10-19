/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The 3D viewport's lens optics: Brown-Conrady distortion (LensDistortionEffect) and thin-lens depth of field
 * (CinematicBokehPass), drawn only when the scene's camera.lens configures them.
 *
 * Frame order when a pass is configured:
 *   1. the scene (overlays hidden) into a half-float target with a depth texture; with distortion the frustum is
 *      widened (overscan) so barrel edges have rendered pixels to pull in;
 *   2. depth of field from that colour + depth (circle of confusion from focal length, f-number and focus);
 *   3. overlays (transform gizmo, selection box, brush ring) on top, sharp, still in the rectilinear frame;
 *   4. distortion of the whole frame (overlays bend with the objects they mark, so they stay on them);
 *   5. tone mapping and output colour space to the canvas (what the renderer applies when drawing straight to it).
 * Picking maps the pointer back through the distortion (mapPointerNdc), so a click hits what is drawn under it.
 */

import * as THREE from 'three';
import type { SceneCameraLens, SceneLensDistortion } from '../../canvas-types';
import { VfxPlateMatchmoveService } from '../../services/video/VfxPlateMatchmoveService';
import { LensDistortionEffect } from '../../services/optics/LensDistortionEffect';
import { CinematicBokehPass } from '../../services/optics/CinematicBokehPass';

/** Widest overscan rendered for distortion (2x the frame on each axis = 4x the pixels). */
export const MAX_OVERSCAN = 2;
/** Depth-of-field sample spread cap, as a fraction of the frame height (24 taps stay smooth up to about this). */
export const MAX_BLUR_RADIUS_FRAME_FRACTION = 0.025;

export type ViewportOpticsPassName = 'depth-of-field' | 'lens-distortion' | 'output' | (string & {});

export interface ViewportDepthOfFieldPlan {
    focalLengthMm: number;
    apertureFStop: number;
    focusDistanceMeters?: number;
    focusObjectId?: string;
    anamorphicSqueeze: number;
}

export interface ViewportDistortionPlan {
    coefficients: Required<Omit<SceneLensDistortion, 'chromaticAberration'>>;
    chromaticAberration: number;
    anamorphicSqueeze: number;
}

export interface ViewportOpticsPlan {
    distortion: ViewportDistortionPlan | null;
    depthOfField: ViewportDepthOfFieldPlan | null;
    /** Passes in draw order; empty = the viewport renders straight to the canvas as before. */
    passes: ViewportOpticsPassName[];
    /** Lens values present but not drawn, and why. */
    issues: string[];
}

const finitePositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const finiteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Which passes a scene lens configures. Pure: no GPU objects. */
export function planViewportOptics(lens: SceneCameraLens | undefined | null): ViewportOpticsPlan {
    const plan: ViewportOpticsPlan = { distortion: null, depthOfField: null, passes: [], issues: [] };
    if (!lens) return plan;
    const squeeze = finitePositive(lens.anamorphicSqueeze) ? lens.anamorphicSqueeze : 1;

    const d = lens.distortion;
    if (d) {
        const c = { k1: d.k1, k2: d.k2 ?? 0, k3: d.k3 ?? 0, p1: d.p1 ?? 0, p2: d.p2 ?? 0 };
        if (!Object.values(c).every(finiteNumber)) {
            plan.issues.push('lens distortion has a coefficient that is not a finite number');
        } else if (Object.values(c).some(v => v !== 0)) {
            plan.distortion = {
                coefficients: c,
                chromaticAberration: finitePositive(d.chromaticAberration) ? d.chromaticAberration : 0,
                anamorphicSqueeze: squeeze
            };
        }
    }

    if (lens.depthOfField !== false) {
        const wantsDof = lens.apertureFStop !== undefined || lens.focusDistanceMeters !== undefined || lens.focusObjectId !== undefined;
        const hasFocus = finitePositive(lens.focusDistanceMeters) || (typeof lens.focusObjectId === 'string' && lens.focusObjectId.length > 0);
        if (finitePositive(lens.focalLengthMm) && finitePositive(lens.apertureFStop) && hasFocus) {
            plan.depthOfField = {
                focalLengthMm: lens.focalLengthMm,
                apertureFStop: lens.apertureFStop,
                focusDistanceMeters: finitePositive(lens.focusDistanceMeters) ? lens.focusDistanceMeters : undefined,
                focusObjectId: lens.focusObjectId || undefined,
                anamorphicSqueeze: squeeze
            };
        } else if (wantsDof) {
            const missing = [
                !finitePositive(lens.focalLengthMm) && 'focal length',
                !finitePositive(lens.apertureFStop) && 'f-number',
                !hasFocus && 'focus distance or focus object'
            ].filter(Boolean);
            plan.issues.push(`depth of field needs ${missing.join(', ')}`);
        }
    }

    if (plan.depthOfField) plan.passes.push('depth-of-field');
    if (plan.distortion) plan.passes.push('lens-distortion');
    if (plan.passes.length > 0) plan.passes.push('output');
    return plan;
}

// ---------------------------------------------------------------------------------------------------------------
// Distortion maths
// ---------------------------------------------------------------------------------------------------------------

type Coefficients = ViewportDistortionPlan['coefficients'];

/** Brown-Conrady distortion of a point in normalized camera coordinates (the spatial services' model). */
export function distortCameraPoint(x: number, y: number, c: Coefficients): [number, number] {
    return VfxPlateMatchmoveService.distortPoint(x, y, { k1: c.k1, k2: c.k2, k3: c.k3, p1: c.p1, p2: c.p2 });
}

/** Inverse of distortCameraPoint (damped Newton). */
export function undistortCameraPoint(x: number, y: number, c: Coefficients, iterations = 20): [number, number] {
    return VfxPlateMatchmoveService.undistortPoint(x, y, { k1: c.k1, k2: c.k2, k3: c.k3, p1: c.p1, p2: c.p2 }, iterations, 1e-12);
}

/**
 * Coefficients in normalized camera coordinates -> the frame-height units LensDistortionEffect's shader works in
 * (coord = (uv - centre) * (aspect, 1), so the top edge is 0.5). With s = 2 tan(vfov / 2), a camera coordinate is
 * s times a frame coordinate; the polynomial is homogeneous per degree, so k_i' = k_i s^(2i) and p' = p s.
 */
export function cameraToFrameCoefficients(c: Coefficients, verticalFovDeg: number): Coefficients {
    const s = 2 * Math.tan(THREE.MathUtils.degToRad(verticalFovDeg) / 2);
    const s2 = s * s;
    return { k1: c.k1 * s2, k2: c.k2 * s2 * s2, k3: c.k3 * s2 * s2 * s2, p1: c.p1 * s, p2: c.p2 * s };
}

/**
 * A point drawn at NDC (ndcX, ndcY) of the distorted frame shows the scene along the pinhole ray through the NDC this
 * returns (it can lie outside [-1, 1]: barrel distortion pulls in what is beyond the frame). null when the lens
 * model has no inverse there (it folds back inside the frame).
 */
export function displayedNdcToPinholeNdc(
    ndcX: number,
    ndcY: number,
    plan: Pick<ViewportDistortionPlan, 'coefficients' | 'anamorphicSqueeze'>,
    verticalFovDeg: number,
    aspect: number
): [number, number] | null {
    const s = 2 * Math.tan(THREE.MathUtils.degToRad(verticalFovDeg) / 2);
    const squeeze = plan.anamorphicSqueeze || 1;
    // frame units (height 1) -> camera units, desqueezed as the shader does
    const xd = (ndcX * aspect / 2) * s / squeeze;
    const yd = (ndcY / 2) * s;
    const [xu, yu] = undistortCameraPoint(xd, yd, plan.coefficients);
    const [rx, ry] = distortCameraPoint(xu, yu, plan.coefficients);
    if (!Number.isFinite(xu) || !Number.isFinite(yu) || Math.hypot(rx - xd, ry - yd) > 1e-6 * Math.max(1, Math.hypot(xd, yd))) return null;
    return [(xu * squeeze / s) * 2 / aspect, (yu / s) * 2];
}

/**
 * Overscan factor the source render needs so every pixel of the distorted frame samples a rendered pixel: the
 * largest |pinhole NDC| over the frame border (>= 1). `folds` when the lens has no inverse somewhere on the border.
 */
export function distortionOverscan(
    plan: Pick<ViewportDistortionPlan, 'coefficients' | 'anamorphicSqueeze'>,
    verticalFovDeg: number,
    aspect: number,
    samplesPerEdge = 9
): { overscan: number; folds: boolean } {
    let m = 1;
    let folds = false;
    for (let i = 0; i < samplesPerEdge; i++) {
        const t = -1 + (2 * i) / (samplesPerEdge - 1);
        for (const [x, y] of [[t, -1], [t, 1], [-1, t], [1, t]] as Array<[number, number]>) {
            const p = displayedNdcToPinholeNdc(x, y, plan, verticalFovDeg, aspect);
            if (!p) { folds = true; continue; }
            m = Math.max(m, Math.abs(p[0]), Math.abs(p[1]));
        }
    }
    return { overscan: m, folds };
}

// ---------------------------------------------------------------------------------------------------------------
// Thin-lens circle of confusion
// ---------------------------------------------------------------------------------------------------------------

/**
 * Thin-lens blur circle diameter on the sensor, in mm, of a point at depth `depthM` (metres along the view axis)
 * when a lens of focal length f (mm) at f-number N is focused at `focusM`:  c = f^2 |d - s| / (N d (s - f)).
 * 0 when the focus is at or inside the focal length (no real image).
 */
export function circleOfConfusionMm(focalLengthMm: number, apertureFStop: number, focusM: number, depthM: number): number {
    const f = focalLengthMm / 1000;
    const s = focusM;
    const d = Math.max(depthM, 1e-6);
    if (!(s > f) || !(apertureFStop > 0)) return 0;
    return ((f * f * Math.abs(d - s)) / (apertureFStop * d * (s - f))) * 1000;
}

/** Height of the frame on the sensor in mm: 2 f tan(vfov / 2) (the sensor height when the FOV came from it). */
export function frameHeightOnSensorMm(focalLengthMm: number, verticalFovDeg: number): number {
    return 2 * focalLengthMm * Math.tan(THREE.MathUtils.degToRad(verticalFovDeg) / 2);
}

/** Blur circle diameter in pixels of a frame `frameHeightPx` tall. */
export function circleOfConfusionPx(
    focalLengthMm: number,
    apertureFStop: number,
    focusM: number,
    depthM: number,
    verticalFovDeg: number,
    frameHeightPx: number
): number {
    return (circleOfConfusionMm(focalLengthMm, apertureFStop, focusM, depthM) / frameHeightOnSensorMm(focalLengthMm, verticalFovDeg)) * frameHeightPx;
}

// ---------------------------------------------------------------------------------------------------------------
// The pass chain
// ---------------------------------------------------------------------------------------------------------------

export interface ViewportOpticsStatus {
    passes: ViewportOpticsPassName[];
    /** Passes configured and drawn in the last frame. */
    drawn: ViewportOpticsPassName[];
    overscan: number;
    focusDistanceMeters: number | null;
    issues: string[];
}

export interface ViewportOpticsFrameIO {
    /** Drawn after depth of field and before distortion (sharp, bent with the scene); hidden during the scene draw. */
    overlays: Array<THREE.Object3D | null | undefined>;
    /** Draws the scene into `target` (the current render target is set to it) and returns the depth texture to use. */
    drawScene: (target: THREE.WebGLRenderTarget) => THREE.Texture | null;
    /** Resolves a focus object id to the viewport object. */
    resolveObject: (id: string) => THREE.Object3D | undefined;
}

const OUTPUT_SHADER = {
    vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
        }
    `,
    fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        varying vec2 vUv;
        void main() {
            gl_FragColor = texture2D(tDiffuse, vUv);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
        }
    `
};

function makeTarget(width: number, height: number, withDepth: boolean, samples: number): THREE.WebGLRenderTarget {
    const target = new THREE.WebGLRenderTarget(width, height, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: true,
        samples
    });
    if (withDepth) {
        const depth = new THREE.DepthTexture(width, height);
        depth.format = THREE.DepthFormat;
        depth.type = THREE.UnsignedIntType;
        target.depthTexture = depth;
    }
    return target;
}

const FOCUS_CENTRE_REFRESH_FRAMES = 30;

export class ViewportOpticsChain {
    private plan: ViewportOpticsPlan = planViewportOptics(undefined);
    private lensPass: LensDistortionEffect | null = null;
    private bokehPass: CinematicBokehPass | null = null;
    private sceneTarget: THREE.WebGLRenderTarget | null = null;
    private dofTarget: THREE.WebGLRenderTarget | null = null;
    private lensTarget: THREE.WebGLRenderTarget | null = null;
    private output: { scene: THREE.Scene; camera: THREE.OrthographicCamera; material: THREE.ShaderMaterial; mesh: THREE.Mesh } | null = null;
    private overscanKey = '';
    private overscanValue = { overscan: 1, folds: false };
    private focus: { id: string; object: THREE.Object3D; centre: THREE.Vector3; frame: number } | null = null;
    private frame = 0;
    private readonly size = new THREE.Vector2();
    private readonly scratch = new THREE.Vector3();
    private readonly box = new THREE.Box3();
    public status: ViewportOpticsStatus = { passes: [], drawn: [], overscan: 1, focusDistanceMeters: null, issues: [] };

    /** Sets the lens; creates the passes it configures and frees the rest. */
    public configure(lens: SceneCameraLens | undefined | null): ViewportOpticsPlan {
        this.plan = planViewportOptics(lens);
        if (this.plan.distortion && !this.lensPass) {
            this.lensPass = new LensDistortionEffect({ mode: 'redistort', edgeMode: 'clamp', chromaticAberration: 0, enabled: true });
        } else if (!this.plan.distortion && this.lensPass) {
            this.lensPass.dispose();
            this.lensPass = null;
            this.lensTarget?.dispose();
            this.lensTarget = null;
        }
        if (this.plan.depthOfField && !this.bokehPass) {
            this.bokehPass = new CinematicBokehPass({ enabled: true });
        } else if (!this.plan.depthOfField && this.bokehPass) {
            this.bokehPass.dispose();
            this.bokehPass = null;
            this.dofTarget?.dispose();
            this.dofTarget = null;
        }
        if (!this.plan.depthOfField || this.focus?.id !== this.plan.depthOfField.focusObjectId) this.focus = null;
        if (!this.active) this.disposeTargets();
        this.overscanKey = '';
        this.status = { passes: [...this.plan.passes], drawn: [], overscan: 1, focusDistanceMeters: null, issues: [...this.plan.issues] };
        return this.plan;
    }

    /** True when the scene lens configures any pass; the viewport renders through render() only then. */
    public get active(): boolean {
        return this.plan.passes.length > 0;
    }

    /** The configured passes in draw order. */
    public get passes(): ViewportOpticsPassName[] {
        return [...this.plan.passes];
    }

    public getPlan(): ViewportOpticsPlan {
        return this.plan;
    }

    /** Pointer NDC on the displayed (distorted) frame -> the NDC to raycast through. Unchanged without distortion. */
    public mapPointerNdc(ndc: THREE.Vector2, camera: THREE.PerspectiveCamera): THREE.Vector2 {
        if (!this.plan.distortion) return ndc;
        const p = displayedNdcToPinholeNdc(ndc.x, ndc.y, this.plan.distortion, camera.fov, camera.aspect);
        return p ? ndc.set(p[0], p[1]) : ndc;
    }

    private overscanFor(camera: THREE.PerspectiveCamera): { overscan: number; folds: boolean } {
        const d = this.plan.distortion!;
        const key = `${camera.fov.toFixed(4)}|${camera.aspect.toFixed(4)}`;
        if (key !== this.overscanKey) {
            this.overscanKey = key;
            this.overscanValue = distortionOverscan(d, camera.fov, camera.aspect);
        }
        return this.overscanValue;
    }

    /** Distance of the plane of focus along the view axis, or null (with an issue) when it cannot be resolved. */
    private focusDistance(camera: THREE.PerspectiveCamera, io: ViewportOpticsFrameIO, issues: string[]): number | null {
        const dof = this.plan.depthOfField!;
        if (!dof.focusObjectId) return dof.focusDistanceMeters ?? null;
        if (!this.focus || this.frame - this.focus.frame >= FOCUS_CENTRE_REFRESH_FRAMES || !this.focus.object.parent) {
            const object = io.resolveObject(dof.focusObjectId);
            if (!object) {
                this.focus = null;
                issues.push(`focus object '${dof.focusObjectId}' is not in the viewport`);
                return null;
            }
            object.updateWorldMatrix(true, true);
            this.box.setFromObject(object);
            if (this.box.isEmpty()) {
                issues.push(`focus object '${dof.focusObjectId}' has no geometry`);
                return null;
            }
            this.focus = { id: dof.focusObjectId, object, centre: this.box.getCenter(new THREE.Vector3()), frame: this.frame };
        }
        camera.updateMatrixWorld();
        const depth = -this.scratch.copy(this.focus.centre).applyMatrix4(camera.matrixWorldInverse).z;
        if (!(depth > dof.focalLengthMm / 1000)) {
            issues.push(`focus object '${dof.focusObjectId}' is behind the camera or inside the focal length`);
            return null;
        }
        return depth;
    }

    private ensureTarget(current: THREE.WebGLRenderTarget | null, width: number, height: number, withDepth: boolean, samples: number): THREE.WebGLRenderTarget {
        if (current && current.width === width && current.height === height) return current;
        current?.dispose();
        return makeTarget(width, height, withDepth, samples);
    }

    /** Draws one frame through the configured passes to the canvas. */
    public render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, io: ViewportOpticsFrameIO): void {
        this.frame++;
        const issues = [...this.plan.issues];
        const drawn: ViewportOpticsPassName[] = [];
        renderer.getDrawingBufferSize(this.size);
        const W = Math.max(1, Math.floor(this.size.x));
        const H = Math.max(1, Math.floor(this.size.y));

        let distortion = this.plan.distortion;
        let overscan = 1;
        // a frustum another feature already offsets (camera.view) is not widened; the outer edge then repeats
        const canWiden = !camera.view?.enabled;
        if (distortion) {
            const o = this.overscanFor(camera);
            if (o.folds) {
                issues.push('lens distortion folds back inside the frame at this field of view (no inverse); not drawn');
                distortion = null;
            } else {
                overscan = canWiden ? Math.min(o.overscan, MAX_OVERSCAN) : 1;
                if (o.overscan > overscan + 1e-3) issues.push(`distortion needs ${o.overscan.toFixed(2)}x overscan; rendered at ${overscan.toFixed(2)}x, the outer edge repeats`);
            }
        }
        // even padding keeps the widened frustum centred on the frame
        const RW = distortion ? W + 2 * Math.ceil((W * overscan - W) / 2) : W;
        const RH = distortion ? H + 2 * Math.ceil((H * overscan - H) / 2) : H;
        const samples = renderer.capabilities?.isWebGL2 === false ? 0 : 4;

        this.sceneTarget = this.ensureTarget(this.sceneTarget, RW, RH, true, samples);
        const widened = RW !== W || RH !== H;
        if (widened) camera.setViewOffset(W, H, -(RW - W) / 2, -(RH - H) / 2, RW, RH);

        const overlays = io.overlays.filter((o): o is THREE.Object3D => !!o && o.visible);
        overlays.forEach(o => { o.visible = false; });
        let depthTexture: THREE.Texture | null;
        const previousTarget = renderer.getRenderTarget();
        try {
            renderer.setRenderTarget(this.sceneTarget);
            depthTexture = io.drawScene(this.sceneTarget);
        } finally {
            overlays.forEach(o => { o.visible = true; });
        }
        let current = this.sceneTarget;

        // depth of field
        let focusM: number | null = null;
        if (this.plan.depthOfField && this.bokehPass) {
            focusM = this.focusDistance(camera, io, issues);
            if (focusM !== null && depthTexture) {
                const dof = this.plan.depthOfField;
                this.dofTarget = this.ensureTarget(this.dofTarget, RW, RH, false, 0);
                const u = this.bokehPass.uniforms;
                // the pass converts sensor mm to pixels by uSensorHeightMm / uResolution.y: the rendered target is
                // `overscan` frames tall, i.e. that many frame heights on the sensor
                u.uSensorHeightMm.value = frameHeightOnSensorMm(dof.focalLengthMm, camera.fov) * (RH / H);
                u.uFocalLengthMm.value = dof.focalLengthMm;
                u.uApertureFStop.value = dof.apertureFStop;
                u.uFocusDistance.value = focusM;
                u.uAnamorphicRatio.value = dof.anamorphicSqueeze;
                // the shader spreads samples over a disc whose radius is the value it computes: that value must be
                // the blur circle's radius, half its diameter
                u.uBokehScale.value = 0.5;
                u.uMaxBlurRadiusPx.value = Math.max(4, MAX_BLUR_RADIUS_FRAME_FRACTION * RH);
                u.uIsLinearDepth.value = false;
                this.bokehPass.setCamera(camera);
                this.bokehPass.render(renderer, current.texture, depthTexture, RW, RH, this.dofTarget);
                current = this.dofTarget;
                drawn.push('depth-of-field');
            } else if (!depthTexture) {
                issues.push('no depth texture from the scene draw; depth of field not drawn');
            }
        }

        // overlays: sharp, on top, in the same (widened) frustum as the scene
        if (overlays.length > 0) {
            const autoClear = renderer.autoClear;
            renderer.autoClear = false;
            renderer.setRenderTarget(current);
            try {
                for (const o of overlays) renderer.render(o, camera);
            } finally {
                renderer.autoClear = autoClear;
            }
        }
        if (widened) camera.clearViewOffset();

        // distortion
        if (distortion && this.lensPass) {
            this.lensTarget = this.ensureTarget(this.lensTarget, W, H, false, 0);
            const c = cameraToFrameCoefficients(distortion.coefficients, camera.fov);
            this.lensPass
                .setDistortion(c.k1, c.k2, c.p1, c.p2, c.k3, 0)
                .setAspectRatio(camera.aspect)
                .setAnamorphicSqueeze(distortion.anamorphicSqueeze)
                .setChromaticAberration(distortion.chromaticAberration)
                .setSourceScale(W / RW, H / RH);
            this.lensPass.render(renderer, current.texture, this.lensTarget);
            current = this.lensTarget;
            drawn.push('lens-distortion');
        }

        // output: tone mapping + output colour space, as a direct draw to the canvas would get
        if (!this.output) {
            const material = new THREE.ShaderMaterial({
                uniforms: { tDiffuse: { value: null } },
                vertexShader: OUTPUT_SHADER.vertexShader,
                fragmentShader: OUTPUT_SHADER.fragmentShader,
                depthTest: false,
                depthWrite: false
            });
            const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
            mesh.frustumCulled = false;
            const scene = new THREE.Scene();
            scene.add(mesh);
            this.output = { scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), material, mesh };
        }
        this.output.material.uniforms.tDiffuse.value = current.texture;
        renderer.setRenderTarget(null);
        renderer.render(this.output.scene, this.output.camera);
        drawn.push('output');
        renderer.setRenderTarget(previousTarget);

        this.status = { passes: [...this.plan.passes], drawn, overscan: RH / H, focusDistanceMeters: focusM, issues };
    }

    private disposeTargets(): void {
        this.sceneTarget?.dispose();
        this.dofTarget?.dispose();
        this.lensTarget?.dispose();
        this.sceneTarget = this.dofTarget = this.lensTarget = null;
        if (this.output) {
            this.output.material.dispose();
            this.output.mesh.geometry.dispose();
            this.output = null;
        }
    }

    public dispose(): void {
        this.configure(undefined);
        this.disposeTargets();
    }
}
