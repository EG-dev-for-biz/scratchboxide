/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Where each fitted slot appears in each Street View image, at the image's nominal pose: the eye at the pano position
 * 2.5 m above the probe ground, the requested heading, pitch and field of view (taken as horizontal), with no
 * registration (v1). The pose is stated as approximate (2 m, 2°), and the evidence check widens its test by that much.
 *
 * A slot's outline is mapped through its host chart (a plane, or a cylinder unrolled as u = r·θ) or, for an edge slot,
 * swept from its measured envelope along the crease; it is projected with projectToFrame and becomes a polygon in
 * Gemini's 0-1000 box convention ([y, x, …]). Its visible share is tested against a 480-px-wide depth render of the
 * fitted model and the pass-through scan.
 */

import type { RenderMesh3D } from '../../spatial/HeadlessMeshSilhouetteRenderer';
import { frameCamera, groundingFocalPx, groundingHorizontalFovDeg, projectToFrame, renderFrameDepth, ZERO_CORRECTION, type FrameCamera, type PoseCorrection } from '../../spatial/StreetViewPoseRegistrar';
import type { EvidenceImageRef, FittedSurface, OrnamentSlot, StructureFit, SurfaceChart, Vec2, Vec3 } from '../../../common/spatial/staged-location-contracts';
import { NOMINAL_POSE_UNCERTAINTY } from './streetview-evidence';

const DEG = Math.PI / 180;
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The 3D point of chart coordinates (u, v) at normal offset n. */
export function chartPoint(chart: SurfaceChart, u: number, v: number, n = 0): Vec3 {
    if ('plane' in chart) {
        const p = chart.plane;
        return add(add(add(p.origin, scale(p.u, u)), scale(p.v, v)), scale(p.normal, n));
    }
    const c = chart.cylinder;
    const axis = norm(c.axisDir);
    const x0 = norm(c.thetaZeroDir);
    const y0 = cross(axis, x0);
    const theta = u / c.radiusM;
    const radial: Vec3 = add(scale(x0, Math.cos(theta)), scale(y0, Math.sin(theta)));
    const r = c.radiusM + c.normalSign * n;
    return add(add(c.axisOrigin, scale(axis, v)), scale(radial, r));
}

/** The outward normal of a chart at (u, v). */
export function chartNormal(chart: SurfaceChart, u: number): Vec3 {
    if ('plane' in chart) return norm(chart.plane.normal);
    const c = chart.cylinder;
    const axis = norm(c.axisDir), x0 = norm(c.thetaZeroDir), y0 = cross(axis, x0);
    const theta = u / c.radiusM;
    return scale(add(scale(x0, Math.cos(theta)), scale(y0, Math.sin(theta))), c.normalSign);
}

function pointInPolygon(u: number, v: number, poly: Vec2[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [ui, vi] = poly[i], [uj, vj] = poly[j];
        if ((vi > v) !== (vj > v) && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui) inside = !inside;
    }
    return inside;
}

/** Points of a slot: its outline (for the polygon) and samples over it (for the visible share). */
export function slotPoints(slot: OrnamentSlot, surfaces: Map<string, FittedSurface>): { outline: Vec3[]; samples: Vec3[] } {
    const host = slot.host;
    if ('surface' in host) {
        const surface = surfaces.get(host.surface.surfaceId);
        if (!surface) return { outline: [], samples: [] };
        const poly = host.surface.regionUv;
        const outline: Vec3[] = [];
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i], b = poly[(i + 1) % poly.length];
            const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.5));
            for (let k = 0; k < steps; k++) outline.push(chartPoint(surface.chart, a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps));
        }
        const us = poly.map(p => p[0]), vs = poly.map(p => p[1]);
        const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
        const samples: Vec3[] = [];
        for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
            const u = u0 + ((u1 - u0) * (i + 0.5)) / 8, v = v0 + ((v1 - v0) * (j + 0.5)) / 8;
            // a hair off the surface, so the surface itself does not occlude its own samples
            if (pointInPolygon(u, v, poly)) samples.push(chartPoint(surface.chart, u, v, 0.05));
        }
        return { outline, samples };
    }
    const e = host.edge;
    const pts = e.carrier.points;
    const surface = surfaces.get(e.surfaceIds[0]);
    const outline: Vec3[] = [];
    const samples: Vec3[] = [];
    const env = e.envelope;
    const eu = env.map(p => p[0]), ev = env.map(p => p[1]);
    const corners: Vec2[] = [[Math.min(...eu), Math.min(...ev)], [Math.max(...eu), Math.min(...ev)], [Math.max(...eu), Math.max(...ev)], [Math.min(...eu), Math.max(...ev)]];
    for (let i = 0; i < pts.length - (e.carrier.closed ? 0 : 1); i++) {
        const a = pts[i] as Vec3, b = pts[(i + 1) % pts.length] as Vec3;
        const t = norm(sub(b, a));
        const out0 = surface ? chartNormal(surface.chart, 0) : ([0, 0, 1] as Vec3);
        const out = norm(sub(out0, scale(t, dot(out0, t))));
        let up = cross(t, out);
        if (up[1] < 0) up = scale(up, -1);
        const steps = Math.max(1, Math.ceil(Math.hypot(...sub(b, a)) / 0.5));
        for (let k = 0; k <= steps; k++) {
            const p = add(a, scale(sub(b, a), k / steps));
            for (const [u, v] of corners) outline.push(add(add(p, scale(out, u)), scale(up, v)));
            samples.push(add(add(p, scale(out, (corners[1][0] + 0.05))), scale(up, (corners[0][1] + corners[2][1]) / 2)));
        }
    }
    return { outline, samples };
}

function convexHull2(points: Vec2[]): Vec2[] {
    const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts;
    const crossZ = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower: Vec2[] = [], upper: Vec2[] = [];
    for (const p of pts) { while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
    return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export interface ProjectedView {
    eye: Vec3;
    headingDeg: number;
    pitchDeg: number;
    fovDeg: number;
    widthPx: number;
    heightPx: number;
    /** The registered pose's offset from the nominal one (absent: the nominal pose). */
    correction?: PoseCorrection;
}

/** The nominal camera of a view (the requested fov converted to the grounding crop's true horizontal fov). */
export function viewCamera(v: ProjectedView, width = v.widthPx, height = v.heightPx): FrameCamera {
    return frameCamera(v.eye as [number, number, number], v.headingDeg, v.pitchDeg, groundingHorizontalFovDeg(v.fovDeg, width, height), width, height, v.correction ?? ZERO_CORRECTION, v.correction?.referenceHeadingDeg ?? v.headingDeg);
}

/** Every slot as seen in one view: its polygon (0-1000, [y, x, …]) and the share of its samples not occluded. */
export function projectSlots(fit: Pick<StructureFit, 'slots' | 'surfaces'>, view: ProjectedView, occluder: RenderMesh3D): EvidenceImageRef['slotsShown'] {
    const surfaces = new Map(fit.surfaces.map(s => [s.id, s]));
    const cam = viewCamera(view);
    const W = 480, H = Math.max(1, Math.round((480 * view.heightPx) / view.widthPx));
    const small = viewCamera(view, W, H);
    const depth = renderFrameDepth(occluder, small);
    const shown: EvidenceImageRef['slotsShown'] = [];
    for (const slot of fit.slots) {
        const { outline, samples } = slotPoints(slot, surfaces);
        const img: Vec2[] = [];
        for (const p of outline) {
            const q = projectToFrame(cam, p);
            if (q) img.push([q[0], q[1]]);
        }
        if (img.length < 3) continue;
        const hull = convexHull2(img);
        // the polygon must touch the image
        const inImage = hull.some(([x, y]) => x >= 0 && x <= view.widthPx && y >= 0 && y <= view.heightPx);
        if (!inImage) continue;
        let visible = 0;
        for (const p of samples) {
            const q = projectToFrame(small, p);
            if (!q || q[0] < 0 || q[1] < 0 || q[0] >= W || q[1] >= H) continue;
            const d = depth[Math.floor(q[1]) * W + Math.floor(q[0])];
            if (!(d < q[2] - 0.15)) visible++;
        }
        const clamp = (v: number) => Math.max(0, Math.min(1000, Math.round(v)));
        shown.push({
            slotId: slot.id,
            polygon1000: hull.flatMap(([x, y]) => [clamp((y / view.heightPx) * 1000), clamp((x / view.widthPx) * 1000)]),
            visibleFraction: samples.length ? Math.round((visible / samples.length) * 1000) / 1000 : 0
        });
    }
    return shown;
}

/** The pose of an image whose pano was registered: the eye as corrected, the uncertainty left after the fit. */
export function registeredPose(eye: Vec3, corr: PoseCorrection, uncertaintyM: number): NonNullable<EvidenceImageRef['pose']> {
    return { eye: [eye[0] + corr.dx, eye[1] + corr.dy, eye[2] + corr.dz], registered: true, uncertaintyM, uncertaintyDeg: 0.5 };
}

/** The nominal pose an evidence image is stated with. */
export function nominalPose(eye: Vec3): NonNullable<EvidenceImageRef['pose']> {
    return { eye, registered: false, uncertaintyM: NOMINAL_POSE_UNCERTAINTY.meters, uncertaintyDeg: NOMINAL_POSE_UNCERTAINTY.degrees };
}

/**
 * Pixels the pose uncertainty can move a point at `distanceM` in a grounding image `widthPx` x `heightPx` requested with fov
 * `fovDeg` (focal length groundingFocalPx: 960 / tan(fov / 2) at the delivered crop).
 */
export function uncertaintyPx(distanceM: number, fovDeg: number, widthPx: number, heightPx: number): number {
    const f = groundingFocalPx(fovDeg, widthPx, heightPx);
    return f * (NOMINAL_POSE_UNCERTAINTY.meters / Math.max(1, distanceM) + NOMINAL_POSE_UNCERTAINTY.degrees * DEG);
}
