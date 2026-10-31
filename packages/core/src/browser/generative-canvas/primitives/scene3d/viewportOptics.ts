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
 *   5. lens flare and diffusion (LensGlowPass) read from that frame: the light the lens and a filter in front of it spread;
 *   6. tone mapping and output colour space to the canvas (what the renderer applies when drawing straight to it), with the
 *      flare and diffusion added before it, then film grain when the lens has it (on the finished picture, as on film).
 *      Content drawn with tone mapping off (provenance views) is left un-tone-mapped, and content whose shader writes
 *      final display values (splats) is left as drawn, each by its coverage mask (depthless-coverage.ts, drawn after
 *      step 1 against the scene's depth), as a direct draw leaves them.
 * Picking maps the pointer back through the distortion (mapPointerNdc), so a click hits what is drawn under it.
 */

import * as THREE from 'three';
import type { SceneCameraLens, SceneColorHarmony, SceneFilmGrain, SceneLookMatch, SceneLensDiffusion, SceneLensDistortion, SceneLensFlare } from '../../canvas-types';
import { VfxPlateMatchmoveService } from '../../services/video/VfxPlateMatchmoveService';
import { LensDistortionEffect } from '../../services/optics/LensDistortionEffect';
import { CinematicBokehPass } from '../../services/optics/CinematicBokehPass';
import { LensGlowPass, type LensGlowSettings } from '../../services/optics/LensGlowPass';
import { TemporalAAPass } from '../../services/optics/TemporalAAPass';
import { ColorHarmonyPass } from '../../services/postprocessing/ColorHarmonyPass';
import { planColorHarmony, type ColorHarmonyPlan } from '../../services/postprocessing/color-harmony';
import { findDepthlessContent, findToneMapExemptContent, renderContentMask, renderObjectMask, sameContent } from '../../services/postprocessing/depthless-coverage';
import { LOOK_BANDS, planLookMatch, type LookMatchPlan } from '../../services/postprocessing/look-match';
import { lensMeasuresFocus } from './viewportFocus';

/** Widest overscan rendered for distortion (2x the frame on each axis = 4x the pixels). */
export const MAX_OVERSCAN = 2;
/**
 * Depth-of-field blur radius cap, as a fraction of the frame height. The pass reads each tap's footprint from a mip chain,
 * so a wide blur stays smooth; the cap only bounds what a lens far wider than any real one would ask for (an 85 mm f/1.4
 * focused at 2 m blurs infinity to a radius of about 5.6% of a full-frame height).
 */
export const MAX_BLUR_RADIUS_FRAME_FRACTION = 0.12;

export type ViewportOpticsPassName = 'temporal-aa' | 'color-harmony' | 'look-match' | 'depth-of-field' | 'lens-distortion' | 'lens-flare' | 'diffusion' | 'film-grain' | 'output' | (string & {});

/** Flare defaults when the lens sets only an amount: four ghosts, a faint halo, no streak, flaring above 1.5 (brighter than white). */
export const DEFAULT_FLARE: Required<Omit<SceneLensFlare, 'amount'>> = { ghosts: 4, halo: 0.3, streak: 0, threshold: 1.5 };
/** Diffusion glow width (Gaussian sigma) as a fraction of the frame height, when the lens sets none. */
export const DEFAULT_DIFFUSION_SPREAD = 0.04;

/** Grain size on the sensor (micrometres) when the lens sets none: a fine 35 mm stock. */
export const DEFAULT_GRAIN_SIZE_UM = 6;

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
    /** Film grain drawn in the output pass, or null. */
    filmGrain: Required<SceneFilmGrain> | null;
    /** Lens flare and diffusion (LensGlowPass), or null. */
    flare: Required<SceneLensFlare> | null;
    diffusion: Required<SceneLensDiffusion> | null;
    depthOfField: ViewportDepthOfFieldPlan | null;
    /** The scene's colour harmony grade (color-harmony.ts), drawn on the scene before depth of field, or null. */
    colorHarmony: ColorHarmonyPlan | null;
    /** The scene's look match (look-match.ts), drawn in the output pass after tone mapping, or null. */
    lookMatch: LookMatchPlan | null;
    /** Passes in draw order; empty = the viewport renders straight to the canvas as before. */
    passes: ViewportOpticsPassName[];
    /** Lens values present but not drawn, and why. */
    issues: string[];
}

const finitePositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const finiteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Which passes a scene lens (and the scene's colour harmony grade) configures. Pure: no GPU objects. */
export function planViewportOptics(lens: SceneCameraLens | undefined | null, harmony?: SceneColorHarmony | null, lookMatch?: SceneLookMatch | null): ViewportOpticsPlan {
    const plan: ViewportOpticsPlan = { distortion: null, filmGrain: null, flare: null, diffusion: null, depthOfField: null, colorHarmony: null, lookMatch: null, passes: [], issues: [] };
    const graded = planColorHarmony(harmony);
    plan.colorHarmony = graded.harmony;
    plan.issues.push(...graded.issues);
    if (plan.colorHarmony) plan.passes.push('color-harmony');
    const matched = planLookMatch(lookMatch);
    plan.lookMatch = matched.lookMatch;
    plan.issues.push(...matched.issues);
    if (!lens) {
        if (plan.lookMatch) plan.passes.push('look-match');
        if (plan.passes.length > 0) plan.passes.push('output');
        return plan;
    }
    const squeeze = finitePositive(lens.anamorphicSqueeze) ? lens.anamorphicSqueeze : 1;

    const d = lens.distortion;
    if (d) {
        const c = { k1: d.k1, k2: d.k2 ?? 0, k3: d.k3 ?? 0, p1: d.p1 ?? 0, p2: d.p2 ?? 0 };
        if (!Object.values(c).every(finiteNumber)) {
            plan.issues.push('lens distortion has a coefficient that is not a finite number');
        } else if (Object.values(c).some(v => v !== 0) || finitePositive(d.chromaticAberration)) {
            // lateral colour alone is drawn too (the distortion pass with zero coefficients only shifts red and blue)
            plan.distortion = {
                coefficients: c,
                chromaticAberration: finitePositive(d.chromaticAberration) ? d.chromaticAberration : 0,
                anamorphicSqueeze: squeeze
            };
        }
    }

    if (lens.depthOfField !== false) {
        // auto focus, a tracked point, and manual focus with nothing stored yet are all measured by the viewport
        // (viewportFocus.ts): no stored distance is required before depth of field can draw
        const measured = lensMeasuresFocus(lens);
        // a lens holding only other passes (film grain, distortion) asks for no depth of field: measured focus counts as
        // asking only with a focus mode or point, or depth of field switched on
        const asksFocus = lens.focusMode !== undefined || lens.focusPoint !== undefined || lens.depthOfField === true;
        const wantsDof = lens.apertureFStop !== undefined || lens.focusDistanceMeters !== undefined || lens.focusObjectId !== undefined || (measured && asksFocus);
        const hasFocus = finitePositive(lens.focusDistanceMeters) || (typeof lens.focusObjectId === 'string' && lens.focusObjectId.length > 0) || measured;
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

    const g = lens.filmGrain;
    if (g && finitePositive(g.amount)) {
        plan.filmGrain = { amount: Math.min(1, g.amount), sizeUm: finitePositive(g.sizeUm) ? g.sizeUm : DEFAULT_GRAIN_SIZE_UM, chroma: finiteNumber(g.chroma) ? Math.min(1, Math.max(0, g.chroma)) : 0, animate: g.animate !== false };
    }

    const f = lens.flare;
    if (f && finitePositive(f.amount)) {
        const clamp01 = (v: unknown, dflt: number) => (finiteNumber(v) ? Math.min(1, Math.max(0, v)) : dflt);
        plan.flare = {
            amount: Math.min(1, f.amount),
            ghosts: finiteNumber(f.ghosts) ? Math.min(8, Math.max(0, Math.round(f.ghosts))) : DEFAULT_FLARE.ghosts,
            halo: clamp01(f.halo, DEFAULT_FLARE.halo),
            streak: clamp01(f.streak, DEFAULT_FLARE.streak),
            threshold: finitePositive(f.threshold) ? f.threshold : DEFAULT_FLARE.threshold
        };
    }
    const m = lens.diffusion;
    if (m && finitePositive(m.strength)) {
        plan.diffusion = { strength: Math.min(1, m.strength), spread: finitePositive(m.spread) ? Math.min(0.5, m.spread) : DEFAULT_DIFFUSION_SPREAD };
    }

    if (plan.depthOfField) plan.passes.push('depth-of-field');
    if (plan.distortion) plan.passes.push('lens-distortion');
    if (plan.flare) plan.passes.push('lens-flare');
    if (plan.diffusion) plan.passes.push('diffusion');
    // the look match is drawn in the output pass, after tone mapping and before the grain
    if (plan.lookMatch) plan.passes.push('look-match');
    if (plan.filmGrain) plan.passes.push('film-grain');
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

/** True when the distortion map keeps orientation at (x, y) and on the segment from the centre to it (before any fold). */
export function distortionIsOrientationPreserving(x: number, y: number, c: Coefficients, steps = 16): boolean {
    const h = 1e-6;
    for (let i = 1; i <= steps; i++) {
        const px = (x * i) / steps, py = (y * i) / steps;
        const [ax, ay] = distortCameraPoint(px + h, py, c);
        const [bx, by] = distortCameraPoint(px - h, py, c);
        const [cx, cy] = distortCameraPoint(px, py + h, c);
        const [dx, dy] = distortCameraPoint(px, py - h, c);
        const det = ((ax - bx) * (cy - dy) - (ay - by) * (cx - dx)) / (4 * h * h);
        if (!(det > 0)) return false;
    }
    return true;
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
    // a preimage past the fold (the map's Jacobian not positive there) shows the scene flipped: not a lens image
    if (!distortionIsOrientationPreserving(xu, yu, plan.coefficients)) return null;
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

/**
 * Widest frame (width / height) the distortion can be drawn on at this vertical field of view: beyond it the
 * polynomial folds back (no inverse) at the frame corners. Infinity when it never folds up to 4:1.
 */
export function distortionMaxAspect(plan: Pick<ViewportDistortionPlan, 'coefficients' | 'anamorphicSqueeze'>, verticalFovDeg: number): number {
    const folds = (aspect: number) => distortionOverscan(plan, verticalFovDeg, aspect, 5).folds;
    if (!folds(4)) return Infinity;
    let lo = 0.05, hi = 4;
    if (folds(lo)) return 0;
    for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        if (folds(mid)) hi = mid; else lo = mid;
    }
    return lo;
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
    /** The scene drawn (its flat background colour is composited after tone mapping, as a direct draw clears to it). */
    scene: THREE.Scene;
    /**
     * Draws the scene into `target` (the current render target is set to it). Returns the depth texture to use, and
     * `displayReferred` when what it wrote is already final display values (a post pass such as aerial perspective
     * drew it): the output then copies it instead of tone mapping it again.
     */
    drawScene: (target: THREE.WebGLRenderTarget) => { depthTexture: THREE.Texture | null; displayReferred?: boolean };
    /** True when drawScene will return displayReferred (known before the draw, so the background is left in place). */
    displayReferred?: boolean;
    /** Resolves a focus object id to the viewport object. */
    resolveObject: (id: string) => THREE.Object3D | undefined;
    /**
     * Focus measured by the viewport (auto focus, a tracked point) from the scene's depth: a distance, null when there
     * is none yet, undefined to let the chain resolve the lens's focus distance or focus object.
     */
    measureFocus?: (camera: THREE.PerspectiveCamera, depthTexture: THREE.Texture | null, frame: { width: number; height: number; renderWidth: number; renderHeight: number }, issues: string[]) => number | null | undefined;
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
        uniform vec3 uBackground;   // flat background, already in the output colour space (not tone mapped)
        uniform bool uDisplayReferred;
        // film grain: amount (0 none), grain cell size in output pixels, chroma, frame seed
        uniform float uGrainAmount;
        uniform float uGrainCellPx;
        uniform float uGrainChroma;
        uniform float uGrainSeed;
        // lens flare and diffusion (LensGlowPass), linear and premultiplied like tDiffuse
        uniform sampler2D tDiffusion;
        uniform float uDiffusion;
        uniform sampler2D tGhosts;
        uniform sampler2D tStreak;
        uniform float uFlare;
        uniform float uStreak;
        // coverage (alpha) of content drawn with tone mapping off: left un-tone-mapped, as a direct draw leaves it
        uniform sampler2D tUntoned;
        uniform bool uUseUntoned;
        // coverage of content whose shader writes final display values (splats): left as drawn, neither tone-mapped nor encoded
        uniform sampler2D tDisplay;
        uniform bool uUseDisplay;
        // the look match (look-match.ts applyLookMatch, which this repeats), on display colours, where tObjects marks the
        // scene's objects: knots (sourceL, targetL, chromaGain, -) and (sourceA, sourceB, targetA, targetB)
        uniform float uLookMatch;
        uniform int uKnotCount;
        uniform vec4 uKnotL[${LOOK_BANDS}];
        uniform vec4 uKnotAB[${LOOK_BANDS}];
        uniform sampler2D tObjects;
        uniform bool uSrgbOutput;
        varying vec2 vUv;

        vec3 sbCbrt(vec3 v) { return sign(v) * pow(abs(v), vec3(1.0 / 3.0)); }
        vec3 sbToOklab(vec3 c) {
            vec3 lms = sbCbrt(vec3(
                dot(c, vec3(0.4122214708, 0.5363325363, 0.0514459929)),
                dot(c, vec3(0.2119034982, 0.6806995451, 0.1073969566)),
                dot(c, vec3(0.0883024619, 0.2817188376, 0.6299787005))));
            return vec3(
                dot(lms, vec3(0.2104542553, 0.7936177850, -0.0040720468)),
                dot(lms, vec3(1.9779984951, -2.4285922050, 0.4505937099)),
                dot(lms, vec3(0.0259040371, 0.7827717662, -0.8086757660)));
        }
        vec3 sbFromOklab(vec3 lab) {
            vec3 lms = vec3(
                dot(lab, vec3(1.0, 0.3963377774, 0.2158037573)),
                dot(lab, vec3(1.0, -0.1055613458, -0.0638541728)),
                dot(lab, vec3(1.0, -0.0894841775, -1.2914855480)));
            lms = lms * lms * lms;
            return vec3(
                dot(lms, vec3(4.0767416621, -3.3077115913, 0.2309699292)),
                dot(lms, vec3(-1.2684380046, 2.6097574011, -0.3413193965)),
                dot(lms, vec3(-0.0041960863, -0.7034186147, 1.7076147010)));
        }
        vec3 sbDecode(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
        vec3 sbEncode(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
        vec3 sbLookMatch(vec3 shown) {
            vec3 lin = uSrgbOutput ? sbDecode(clamp(shown, 0.0, 1.0)) : clamp(shown, 0.0, 1.0);
            vec3 lab = sbToOklab(lin);
            vec4 l0 = uKnotL[0], l1 = uKnotL[1], ab0 = uKnotAB[0], ab1 = uKnotAB[1];
            for (int i = 1; i < ${LOOK_BANDS} - 1; i++) {
                if (i + 1 >= uKnotCount || lab.x <= uKnotL[i].x) break;
                l0 = uKnotL[i]; l1 = uKnotL[i + 1]; ab0 = uKnotAB[i]; ab1 = uKnotAB[i + 1];
            }
            float t = clamp((lab.x - l0.x) / (l1.x - l0.x), 0.0, 1.0);
            float L2 = lab.x < l0.x ? lab.x + (l0.y - l0.x) : lab.x > l1.x ? lab.x + (l1.y - l1.x) : mix(l0.y, l1.y, t);
            vec4 ab = mix(ab0, ab1, t);
            float gain = mix(l0.z, l1.z, t);
            vec2 moved = (lab.yz - ab.xy) * gain + ab.zw;
            vec3 graded = mix(lab, vec3(L2, moved), uLookMatch);
            vec3 outLin = clamp(sbFromOklab(graded), 0.0, 1.0);
            return uSrgbOutput ? sbEncode(outLin) : outLin;
        }
        vec3 sbMatched(vec3 shown) {
            if (uLookMatch <= 0.0) return shown;
            float w = clamp(texture2D(tObjects, vUv).r, 0.0, 1.0);
            return w > 0.0 ? mix(shown, sbLookMatch(shown), w) : shown;
        }

        float sbHash(vec3 p) {
            p = fract(p * vec3(0.1031, 0.1030, 0.0973));
            p += dot(p, p.yzx + 33.33);
            return fract((p.x + p.y) * p.z);
        }
        // value noise on cells of uGrainCellPx, smoothly interpolated, zero mean, unit-ish spread
        float sbGrain(vec2 px, float channel) {
            vec2 q = px / max(uGrainCellPx, 0.5);
            vec2 i = floor(q), f = fract(q);
            f = f * f * (3.0 - 2.0 * f);
            float s = uGrainSeed + channel * 17.0;
            float a = sbHash(vec3(i, s)), b = sbHash(vec3(i + vec2(1.0, 0.0), s));
            float c = sbHash(vec3(i + vec2(0.0, 1.0), s)), d = sbHash(vec3(i + vec2(1.0, 1.0), s));
            return (mix(mix(a, b, f.x), mix(c, d, f.x), f.y) - 0.5) * 3.4;
        }
        vec3 sbApplyGrain(vec3 col) {
            if (uGrainAmount <= 0.0) return col;
            vec2 px = gl_FragCoord.xy;
            float mono = sbGrain(px, 0.0);
            vec3 n = mix(vec3(mono), vec3(mono, sbGrain(px, 1.0), sbGrain(px, 2.0)), uGrainChroma);
            // strongest in the mid-tones, as an emulsion's grain shows most there
            float l = clamp(dot(col, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
            float w = 0.25 + 0.75 * 4.0 * l * (1.0 - l);
            return clamp(col + n * (0.12 * uGrainAmount * w), 0.0, 1.0);
        }
        void main() {
            vec4 c = texture2D(tDiffuse, vUv);
            // a filter in front of the lens scatters a share of all light into its glow (energy kept: what goes into the
            // glow leaves the sharp image), and the lens adds its flare; both before tone mapping, as light
            if (uDiffusion > 0.0) c = c * (1.0 - uDiffusion) + texture2D(tDiffusion, vUv) * uDiffusion;
            if (uFlare > 0.0) {
                vec3 flare = (texture2D(tGhosts, vUv).rgb + texture2D(tStreak, vUv).rgb * uStreak) * uFlare;
                // light over an uncovered (flat background) pixel still shows: it raises the coverage it is drawn with
                c = vec4(c.rgb + flare, max(c.a, clamp(dot(flare, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0)));
            }
            if (uDisplayReferred) {
                gl_FragColor = vec4(sbApplyGrain(sbMatched(c.rgb)), 1.0);
                return;
            }
            // the scene was drawn over a transparent clear: alpha is its coverage (blur spreads it like the colour)
            float a = clamp(c.a, 0.0, 1.0);
            gl_FragColor = vec4(a > 1e-4 ? c.rgb / a : vec3(0.0), 1.0);
            vec3 untonedRgb = gl_FragColor.rgb;
            #include <tonemapping_fragment>
            if (uUseUntoned) gl_FragColor.rgb = mix(gl_FragColor.rgb, untonedRgb, clamp(texture2D(tUntoned, vUv).a, 0.0, 1.0));
            #include <colorspace_fragment>
            if (uUseDisplay) gl_FragColor.rgb = mix(gl_FragColor.rgb, untonedRgb, clamp(texture2D(tDisplay, vUv).a, 0.0, 1.0));
            gl_FragColor = vec4(sbApplyGrain(mix(uBackground, sbMatched(gl_FragColor.rgb), a)), 1.0);
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

/** An 8-bit target: masks the CPU reads back (readRenderTargetPixels needs a byte format). */
function makeByteTarget(width: number, height: number, withDepth: boolean): THREE.WebGLRenderTarget {
    const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: withDepth });
    if (withDepth) {
        const depth = new THREE.DepthTexture(width, height);
        depth.format = THREE.DepthFormat;
        depth.type = THREE.UnsignedIntType;
        target.depthTexture = depth;
    }
    return target;
}

/**
 * One frame as shown on the canvas, before the look match, and which of its pixels are the objects measured: the scene's
 * objects, or the given ones where they are seen. Both bottom row first, RGBA bytes.
 */
export interface ViewportObjectSample {
    width: number;
    height: number;
    /** The canvas's display colours. */
    rgba: Uint8Array;
    /** Per pixel, red channel: the share of it that is the objects measured. */
    mask: Uint8Array;
    /** The ids asked for that are not in the viewport (their pixels are not in the mask). */
    missing: string[];
}

export class ViewportOpticsChain {
    private plan: ViewportOpticsPlan = planViewportOptics(undefined);
    private lensPass: LensDistortionEffect | null = null;
    private bokehPass: CinematicBokehPass | null = null;
    private glowPass: LensGlowPass | null = null;
    private taaPass: TemporalAAPass | null = null;
    private harmonyPass: ColorHarmonyPass | null = null;
    private harmonyTarget: THREE.WebGLRenderTarget | null = null;
    private coverageTarget: THREE.WebGLRenderTarget | null = null;
    /** The share of each pixel that is the scene's objects (the look match's weight), and it bent by the lens. */
    private objectMaskTarget: THREE.WebGLRenderTarget | null = null;
    private objectMaskLensTarget: THREE.WebGLRenderTarget | null = null;
    /** Coverage of the objects a sample asked for, and it bent by the lens. */
    private sampleMaskTarget: THREE.WebGLRenderTarget | null = null;
    private sampleMaskLensTarget: THREE.WebGLRenderTarget | null = null;
    private pendingSample: { objectIds: string[]; resolve: (s: ViewportObjectSample) => void; reject: (e: Error) => void } | null = null;
    /** Coverage of content drawn with tone mapping off (provenance views): the output leaves it un-tone-mapped. */
    private untonedTarget: THREE.WebGLRenderTarget | null = null;
    private untonedLensTarget: THREE.WebGLRenderTarget | null = null;
    /** Coverage of content whose shader writes final display values (splats): the output leaves it as drawn. */
    private displayTarget: THREE.WebGLRenderTarget | null = null;
    private displayLensTarget: THREE.WebGLRenderTarget | null = null;
    private taaCopyTarget: THREE.WebGLRenderTarget | null = null;
    private sceneTarget: THREE.WebGLRenderTarget | null = null;
    private dofTarget: THREE.WebGLRenderTarget | null = null;
    private lensTarget: THREE.WebGLRenderTarget | null = null;
    private output: { scene: THREE.Scene; camera: THREE.OrthographicCamera; material: THREE.ShaderMaterial; mesh: THREE.Mesh } | null = null;
    private overscanKey = '';
    private overscanValue: { overscan: number; folds: boolean; maxAspect?: number } = { overscan: 1, folds: false };
    private focus: { id: string; object: THREE.Object3D; centre: THREE.Vector3; frame: number } | null = null;
    private frame = 0;
    private sensorHeightMm: number | undefined;
    private readonly size = new THREE.Vector2();
    private readonly scratch = new THREE.Vector3();
    private readonly box = new THREE.Box3();
    public status: ViewportOpticsStatus = { passes: [], drawn: [], overscan: 1, focusDistanceMeters: null, issues: [] };

    /** Sets the lens and the scene's colour harmony grade; creates the passes they configure and frees the rest. */
    public configure(lens: SceneCameraLens | undefined | null, harmony?: SceneColorHarmony | null, lookMatch?: SceneLookMatch | null): ViewportOpticsPlan {
        this.plan = planViewportOptics(lens, harmony, lookMatch);
        this.sensorHeightMm = lens?.sensorHeightMm;
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
        if ((this.plan.flare || this.plan.diffusion) && !this.glowPass) {
            this.glowPass = new LensGlowPass();
        } else if (!this.plan.flare && !this.plan.diffusion && this.glowPass) {
            this.glowPass.dispose();
            this.glowPass = null;
        }
        if (this.plan.colorHarmony && !this.harmonyPass) {
            this.harmonyPass = new ColorHarmonyPass();
        } else if (!this.plan.colorHarmony && this.harmonyPass) {
            this.harmonyPass.dispose();
            this.harmonyPass = null;
            this.harmonyTarget?.dispose();
            this.harmonyTarget = null;
        }
        // temporal anti-aliasing runs whenever a lens effect draws, unless the lens turns it off (a colour grade alone
        // spreads no light, so it does not need it)
        const lensEffect = this.plan.passes.some(p => p !== 'color-harmony' && p !== 'look-match' && p !== 'output');
        const taa = lensEffect && lens?.temporalAntiAliasing !== false;
        if (taa && !this.taaPass) this.taaPass = new TemporalAAPass();
        else if (!taa && this.taaPass) {
            this.taaPass.dispose();
            this.taaPass = null;
        }
        this.taaPass?.reset();
        if (!this.plan.depthOfField || this.focus?.id !== this.plan.depthOfField.focusObjectId) this.focus = null;
        if (this.plan.passes.length === 0 && !this.pendingSample) this.disposeTargets();
        this.overscanKey = '';
        this.status = { passes: [...this.plan.passes], drawn: [], overscan: 1, focusDistanceMeters: null, issues: [...this.plan.issues] };
        return this.plan;
    }

    /** The object depth of field holds focus on and its centre (world) as last measured, or null. */
    public get focusTarget(): { object: THREE.Object3D; centre: THREE.Vector3 } | null {
        return this.focus ? { object: this.focus.object, centre: this.focus.centre } : null;
    }

    /** True when the scene lens configures any pass; the viewport renders through render() only then. */
    public get active(): boolean {
        return this.plan.passes.length > 0 || !!this.pendingSample;
    }

    /**
     * The next frame as shown, before the look match, with a mask of the objects to measure: `objectIds` where they are
     * seen, else every object of the scene (never the sky). The viewport draws through the chain for that frame. A newer
     * request replaces one not yet taken (it is rejected).
     */
    public requestObjectSample(objectIds: string[] = []): Promise<ViewportObjectSample> {
        this.pendingSample?.reject(new Error('a newer sample was asked for'));
        return new Promise((resolve, reject) => { this.pendingSample = { objectIds, resolve, reject }; });
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

    private overscanFor(camera: THREE.PerspectiveCamera): { overscan: number; folds: boolean; maxAspect?: number } {
        const d = this.plan.distortion!;
        const key = `${camera.fov.toFixed(4)}|${camera.aspect.toFixed(4)}`;
        if (key !== this.overscanKey) {
            this.overscanKey = key;
            this.overscanValue = distortionOverscan(d, camera.fov, camera.aspect);
            if (this.overscanValue.folds) this.overscanValue.maxAspect = distortionMaxAspect(d, camera.fov);
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

    private ensureByteTarget(current: THREE.WebGLRenderTarget | null, width: number, height: number, withDepth: boolean): THREE.WebGLRenderTarget {
        if (current && current.width === width && current.height === height) return current;
        current?.dispose();
        return makeByteTarget(width, height, withDepth);
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
                issues.push(`lens distortion not drawn: at a ${camera.fov.toFixed(1)}° field of view these coefficients fold back (have no inverse) inside a ${camera.aspect.toFixed(2)}:1 frame; they can be drawn up to ${(o.maxAspect ?? 0).toFixed(2)}:1`);
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
        // a sub-pixel jitter of the projection for this frame's scene draw only (depth of field and overlays see the
        // unjittered camera)
        this.taaPass?.beginJitter(camera, RW, RH);

        const overlays = io.overlays.filter((o): o is THREE.Object3D => !!o && o.visible);
        overlays.forEach(o => { o.visible = false; });
        // A flat background (or none: the clear colour) is not tone mapped when drawn straight to the canvas, so the
        // scene is drawn over a transparent clear and the output composites that colour after tone mapping.
        const scene = io.scene;
        const background = scene.background;
        const flatBackground = !io.displayReferred && (!background || (background as THREE.Color).isColor === true);
        const backgroundColour = flatBackground ? (background ? (background as THREE.Color).clone() : renderer.getClearColor(new THREE.Color())) : null;
        const clearColour = renderer.getClearColor(new THREE.Color());
        const clearAlpha = renderer.getClearAlpha();
        let drawn_: { depthTexture: THREE.Texture | null; displayReferred?: boolean };
        const previousTarget = renderer.getRenderTarget();
        try {
            if (flatBackground) {
                scene.background = null;
                renderer.setClearColor(0x000000, 0);
            }
            renderer.setRenderTarget(this.sceneTarget);
            drawn_ = io.drawScene(this.sceneTarget);
        } finally {
            if (flatBackground) {
                scene.background = background;
                renderer.setClearColor(clearColour, clearAlpha);
            }
            overlays.forEach(o => { o.visible = true; });
            this.taaPass?.endJitter(camera);
        }
        const depthTexture = drawn_.depthTexture;
        // content masks, drawn alone against the scene's depth (so what other geometry hides is not in them):
        //  - the harmony grade is on the scene's objects only, never the sky (a dome mesh, a texture, a flat colour): objects
        //    are what wrote depth, and content that writes none (splats) by its coverage;
        //  - content drawn with tone mapping off (splats, provenance views) is left un-tone-mapped by the output, as a direct
        //    draw to the canvas leaves it
        let coverage: THREE.Texture | null = null;
        let untoned: THREE.Texture | null = null;
        let display: THREE.Texture | null = null;
        const sample = this.pendingSample;
        this.pendingSample = null;
        const wantsObjects = !!this.plan.lookMatch || !!sample;
        const depthless = (this.plan.colorHarmony || wantsObjects) && depthTexture ? findDepthlessContent(scene) : [];
        const exempt = !drawn_.displayReferred ? findToneMapExemptContent(scene, new Set(overlays)) : { untoned: [], display: [] };
        if (exempt.untoned.length + exempt.display.length > 0 && !depthTexture) issues.push('no depth texture from the scene draw; content drawn with tone mapping off (splats, provenance views) is tone-mapped with the rest');
        if (depthTexture && exempt.untoned.length > 0) {
            this.untonedTarget = this.ensureTarget(this.untonedTarget, RW, RH, true, 0);
            if (renderContentMask(renderer, camera, exempt.untoned, this.untonedTarget, depthTexture)) untoned = this.untonedTarget.texture;
        }
        if (depthTexture && exempt.display.length > 0) {
            this.displayTarget = this.ensureTarget(this.displayTarget, RW, RH, true, 0);
            if (renderContentMask(renderer, camera, exempt.display, this.displayTarget, depthTexture)) display = this.displayTarget.texture;
        }
        if (depthless.length > 0) {
            if (display && sameContent(depthless, exempt.display)) coverage = display;
            else {
                this.coverageTarget = this.ensureTarget(this.coverageTarget, RW, RH, true, 0);
                if (renderContentMask(renderer, camera, depthless, this.coverageTarget, depthTexture)) coverage = this.coverageTarget.texture;
            }
        }
        // the objects' share of each pixel: the look match's weight, and what a sample measures
        let objectMask: THREE.Texture | null = null;
        let sampleMask: THREE.Texture | null = null;
        const missing: string[] = [];
        if (wantsObjects && depthTexture) {
            this.objectMaskTarget = this.ensureByteTarget(this.objectMaskTarget, RW, RH, false);
            renderObjectMask(renderer, depthTexture, coverage, this.objectMaskTarget);
            objectMask = this.objectMaskTarget.texture;
            if (sample && sample.objectIds.length > 0) {
                const objects = sample.objectIds.map(id => {
                    const o = io.resolveObject(id);
                    if (!o) missing.push(id);
                    return o;
                }).filter((o): o is THREE.Object3D => !!o);
                this.sampleMaskTarget = this.ensureByteTarget(this.sampleMaskTarget, RW, RH, true);
                if (renderContentMask(renderer, camera, objects, this.sampleMaskTarget, depthTexture)) sampleMask = this.sampleMaskTarget.texture;
            } else {
                sampleMask = objectMask;
            }
        } else if (this.plan.lookMatch) {
            issues.push('no depth texture from the scene draw; look match not drawn (it could not tell the objects from the background)');
        }
        let current = this.sceneTarget;
        let taaHistory: THREE.WebGLRenderTarget | null = null;

        // temporal anti-aliasing: every lens effect after it reads the steady, resolved frame
        if (this.taaPass) {
            if (depthTexture) {
                current = taaHistory = this.taaPass.render(renderer, current.texture, depthTexture, RW, RH);
                drawn.push('temporal-aa');
            } else {
                issues.push('no depth texture from the scene draw; temporal anti-aliasing not drawn');
                this.taaPass.reset();
            }
        }

        // colour harmony: on the scene's own light, before depth of field blurs objects into the background
        const harmony = this.plan.colorHarmony;
        if (harmony && this.harmonyPass) {
            if (!depthTexture) {
                issues.push('no depth texture from the scene draw; colour harmony not drawn (it could not tell the objects from the background)');
            } else {
                this.harmonyTarget = this.ensureTarget(this.harmonyTarget, RW, RH, false, 0);
                this.harmonyPass.render(renderer, current.texture, depthTexture, harmony, this.harmonyTarget, coverage, display);
                current = this.harmonyTarget;
                drawn.push('color-harmony');
            }
        }

        // depth of field
        let focusM: number | null = null;
        if (this.plan.depthOfField && this.bokehPass) {
            const measured = io.measureFocus?.(camera, depthTexture, { width: W, height: H, renderWidth: RW, renderHeight: RH }, issues);
            focusM = measured !== undefined ? measured : this.focusDistance(camera, io, issues);
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
            // the resolved frame is also the next frame's history: overlays go on a copy of it
            if (this.taaPass && taaHistory && current === taaHistory) {
                this.taaCopyTarget = this.ensureTarget(this.taaCopyTarget, RW, RH, false, 0);
                this.taaPass.copy(renderer, current.texture, this.taaCopyTarget);
                current = this.taaCopyTarget;
            }
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
            // the tone mapping masks bend with the frame they mark
            this.lensPass.setChromaticAberration(0);
            if (untoned) {
                this.untonedLensTarget = this.ensureTarget(this.untonedLensTarget, W, H, false, 0);
                this.lensPass.render(renderer, untoned, this.untonedLensTarget);
                untoned = this.untonedLensTarget.texture;
            }
            if (display) {
                this.displayLensTarget = this.ensureTarget(this.displayLensTarget, W, H, false, 0);
                this.lensPass.render(renderer, display, this.displayLensTarget);
                display = this.displayLensTarget.texture;
            }
            if (objectMask) {
                const bentObjects = objectMask;
                this.objectMaskLensTarget = this.ensureByteTarget(this.objectMaskLensTarget, W, H, false);
                this.lensPass.render(renderer, objectMask, this.objectMaskLensTarget);
                objectMask = this.objectMaskLensTarget.texture;
                if (sampleMask === bentObjects) sampleMask = objectMask;
            }
            if (sampleMask && sampleMask !== objectMask) {
                this.sampleMaskLensTarget = this.ensureByteTarget(this.sampleMaskLensTarget, W, H, false);
                this.lensPass.render(renderer, sampleMask, this.sampleMaskLensTarget);
                sampleMask = this.sampleMaskLensTarget.texture;
            }
            drawn.push('lens-distortion');
        }

        // output: tone mapping + output colour space, as a direct draw to the canvas would get
        if (!this.output) {
            const material = new THREE.ShaderMaterial({
                uniforms: {
                    tDiffuse: { value: null }, uBackground: { value: new THREE.Vector3() }, uDisplayReferred: { value: false }, uGrainAmount: { value: 0 }, uGrainCellPx: { value: 1 }, uGrainChroma: { value: 0 }, uGrainSeed: { value: 0 },
                    tDiffusion: { value: null }, uDiffusion: { value: 0 }, tGhosts: { value: null }, tStreak: { value: null }, uFlare: { value: 0 }, uStreak: { value: 0 },
                    tUntoned: { value: null }, uUseUntoned: { value: false }, tDisplay: { value: null }, uUseDisplay: { value: false },
                    uLookMatch: { value: 0 }, uKnotCount: { value: 0 }, tObjects: { value: null }, uSrgbOutput: { value: true },
                    uKnotL: { value: Array.from({ length: LOOK_BANDS }, () => new THREE.Vector4()) },
                    uKnotAB: { value: Array.from({ length: LOOK_BANDS }, () => new THREE.Vector4()) }
                },
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
        const ou = this.output.material.uniforms;
        ou.tDiffuse.value = current.texture;
        // lens flare and diffusion, from the frame as it now stands (after depth of field and distortion)
        const glow = this.glowPass && (this.plan.flare || this.plan.diffusion)
            ? this.glowPass.render(renderer, current.texture, current.width, current.height, { flare: this.plan.flare, diffusion: this.plan.diffusion } satisfies LensGlowSettings)
            : null;
        ou.uDiffusion.value = glow?.diffusion ? glow.diffusionStrength : 0;
        ou.tDiffusion.value = glow?.diffusion ?? null;
        ou.uFlare.value = glow?.ghosts ? glow.flareAmount : 0;
        ou.tGhosts.value = glow?.ghosts ?? null;
        ou.tStreak.value = glow?.streak ?? glow?.ghosts ?? null;
        ou.uStreak.value = glow?.streak ? glow.streakGain : 0;
        if (glow?.ghosts) drawn.push('lens-flare');
        if (glow?.diffusion) drawn.push('diffusion');
        ou.uDisplayReferred.value = !!drawn_.displayReferred;
        ou.tUntoned.value = untoned;
        ou.uUseUntoned.value = !!untoned;
        ou.tDisplay.value = display;
        ou.uUseDisplay.value = !!display;
        // film grain: its size on the sensor -> output pixels by the frame height on the sensor (the lens's film back)
        const grain = this.plan.filmGrain;
        ou.uGrainAmount.value = grain ? grain.amount : 0;
        if (grain) {
            // the lens's film back, else the 24 mm full-frame height the camera panel assumes
            const sensorH = finitePositive(this.sensorHeightMm) ? this.sensorHeightMm : 24;
            ou.uGrainCellPx.value = Math.max(0.5, (grain.sizeUm / 1000 / sensorH) * H);
            ou.uGrainChroma.value = grain.chroma;
            ou.uGrainSeed.value = grain.animate ? this.frame % 997 : 0;
            drawn.push('film-grain');
        }
        // a texture / cube background was drawn into the target opaque; the composite then never shows this colour
        const bg = backgroundColour ? backgroundColour.getRGB({ r: 0, g: 0, b: 0 }, renderer.outputColorSpace) : { r: 0, g: 0, b: 0 };
        (ou.uBackground.value as THREE.Vector3).set(bg.r, bg.g, bg.b);
        // the look match, on the objects as shown
        const look = objectMask ? this.plan.lookMatch : null;
        ou.tObjects.value = objectMask;
        ou.uSrgbOutput.value = renderer.outputColorSpace === THREE.SRGBColorSpace;
        if (look) {
            ou.uKnotCount.value = look.knots.length;
            look.knots.forEach((k, i) => {
                (ou.uKnotL.value as THREE.Vector4[])[i].set(k.sourceL, k.targetL, k.chromaGain, 0);
                (ou.uKnotAB.value as THREE.Vector4[])[i].set(k.sourceA, k.sourceB, k.targetA, k.targetB);
            });
            drawn.push('look-match');
        }
        renderer.setRenderTarget(null);
        if (sample) {
            // the frame as it shows before the match, read back as drawn, then the frame drawn again with it
            ou.uLookMatch.value = 0;
            renderer.render(this.output.scene, this.output.camera);
            try {
                if (!sampleMask) throw new Error(missing.length ? `none of ${missing.join(', ')} is in the viewport` : 'no depth texture from the scene draw: the objects cannot be told from the background');
                const gl = renderer.getContext();
                const rgba = new Uint8Array(W * H * 4);
                gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
                const maskTarget = sampleMask === objectMask ? (distortion ? this.objectMaskLensTarget! : this.objectMaskTarget!) : (distortion ? this.sampleMaskLensTarget! : this.sampleMaskTarget!);
                const mask = new Uint8Array(W * H * 4);
                if (maskTarget.width !== W || maskTarget.height !== H) throw new Error(`the object mask is ${maskTarget.width}x${maskTarget.height}, the frame ${W}x${H}`);
                renderer.readRenderTargetPixels(maskTarget, 0, 0, W, H, mask);
                renderer.setRenderTarget(null);
                sample.resolve({ width: W, height: H, rgba, mask, missing });
            } catch (e) {
                sample.reject(e instanceof Error ? e : new Error(String(e)));
            }
        }
        ou.uLookMatch.value = look ? look.strength : 0;
        renderer.render(this.output.scene, this.output.camera);
        drawn.push('output');
        renderer.setRenderTarget(previousTarget);

        this.status = { passes: [...this.plan.passes], drawn, overscan: RH / H, focusDistanceMeters: focusM, issues };
    }

    private disposeTargets(): void {
        this.sceneTarget?.dispose();
        this.dofTarget?.dispose();
        this.lensTarget?.dispose();
        this.taaCopyTarget?.dispose();
        this.harmonyTarget?.dispose();
        this.coverageTarget?.dispose();
        this.objectMaskTarget?.dispose();
        this.objectMaskLensTarget?.dispose();
        this.sampleMaskTarget?.dispose();
        this.sampleMaskLensTarget?.dispose();
        this.objectMaskTarget = this.objectMaskLensTarget = this.sampleMaskTarget = this.sampleMaskLensTarget = null;
        this.untonedTarget?.dispose();
        this.untonedLensTarget?.dispose();
        this.displayTarget?.dispose();
        this.displayLensTarget?.dispose();
        this.sceneTarget = this.dofTarget = this.lensTarget = this.taaCopyTarget = this.harmonyTarget = this.coverageTarget = this.untonedTarget = this.untonedLensTarget = this.displayTarget = this.displayLensTarget = null;
        if (this.output) {
            this.output.material.dispose();
            this.output.mesh.geometry.dispose();
            this.output = null;
        }
    }

    public dispose(): void {
        this.pendingSample?.reject(new Error('the viewport closed'));
        this.pendingSample = null;
        this.configure(undefined);
        this.disposeTargets();
    }
}
