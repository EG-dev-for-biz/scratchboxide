/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Image box to 3D: where a thing the survey saw in a Street View image stands on the fitted structure.
 *
 * The camera model is the pano's: position from the metadata (the nominal eye), heading, elevation and horizontal fov
 * (frameCamera, the same model projectSlots uses to go the other way). A pixel is a ray from the eye; the ray is cast
 * onto the fitted faces (their charts) or, when the fit was not accepted, onto the footprint's own vertical faces. The
 * box's corners and centre give the element's place on the face in the face's (u, v) metres, which is what a slot is
 * in, so a survey element finds its slot by geometry and the vision model is never asked to place anything in a frame
 * it cannot see.
 *
 * Image coordinates here are the survey's 0..1000 boxes [y0, x0, y1, x1] (y down), like every box in the contracts.
 */

import type { FittedSurface, StructureFit, Vec2, Vec3 } from '../../../common/spatial/staged-location-contracts';
import { frameCamera, ZERO_CORRECTION, type FrameCamera, type PoseCorrection } from '../../spatial/StreetViewPoseRegistrar';

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export interface CastView {
    eye: Vec3;
    headingDeg: number;
    /** Elevation of the view axis, degrees, up positive (the app's convention). */
    pitchDeg: number;
    fovDeg: number;
    widthPx: number;
    heightPx: number;
    /** The registered pose's offset from the nominal one (eye shift in the tile frame, yaw); absent for the nominal pose. */
    correction?: PoseCorrection;
}

export function castCamera(v: CastView): FrameCamera {
    return frameCamera(v.eye, v.headingDeg, v.pitchDeg, v.fovDeg, v.widthPx, v.heightPx, v.correction ?? ZERO_CORRECTION, v.headingDeg);
}

/** The ray through a pixel (x right, y down), unit direction in the tile frame. */
export function pixelRay(cam: FrameCamera, px: number, py: number): { origin: Vec3; dir: Vec3 } {
    const xc = (px - cam.cx) / cam.fx, yc = -(py - cam.cy) / cam.fy;
    return { origin: cam.eye, dir: unit(add(add(scale(cam.right, xc), scale(cam.up, yc)), cam.fwd)) };
}

/** A box [y0, x0, y1, x1] in 0..1000 of an image, as pixel corners. */
export function boxPixels(box1000: [number, number, number, number], widthPx: number, heightPx: number): { x0: number; y0: number; x1: number; y1: number } {
    const [y0, x0, y1, x1] = box1000;
    return { x0: (x0 / 1000) * widthPx, y0: (y0 / 1000) * heightPx, x1: (x1 / 1000) * widthPx, y1: (y1 / 1000) * heightPx };
}

/** What a ray can land on: a fitted surface, or a face of the footprint standing in for one. */
export interface CastFace {
    id: string;
    chart: FittedSurface['chart'];
    /** 'fit' for a fitted surface, 'footprint' for a vertical face of the structure's outline (no accepted fit). */
    source: 'fit' | 'footprint';
}

export interface FaceHit {
    faceId: string;
    source: CastFace['source'];
    point: Vec3;
    u: number;
    v: number;
    distanceM: number;
}

function planeUv(c: Extract<FittedSurface['chart'], { plane: unknown }>['plane'], p: Vec3): Vec2 {
    const d = sub(p, c.origin);
    return [dot(d, c.u) / (dot(c.u, c.u) || 1), dot(d, c.v) / (dot(c.v, c.v) || 1)];
}

function inExtent(extent: Vec2[], u: number, v: number, slack: number): boolean {
    if (!extent.length) return true;
    const us = extent.map(p => p[0]), vs = extent.map(p => p[1]);
    return u >= Math.min(...us) - slack && u <= Math.max(...us) + slack && v >= Math.min(...vs) - slack && v <= Math.max(...vs) + slack;
}

/** The nearest hit of a ray on the faces, only on the side the face faces (a face seen from behind is not hit). */
export function castRay(ray: { origin: Vec3; dir: Vec3 }, faces: CastFace[], slackM = 0.3): FaceHit | undefined {
    let best: FaceHit | undefined;
    for (const f of faces) {
        let hit: { t: number; u: number; v: number } | undefined;
        if ('plane' in f.chart) {
            const pl = f.chart.plane;
            const n = unit(pl.normal);
            const denom = dot(ray.dir, n);
            if (denom >= -1e-6) continue;
            const t = dot(sub(pl.origin, ray.origin), n) / denom;
            if (t <= 0.1) continue;
            const p = add(ray.origin, scale(ray.dir, t));
            const [u, v] = planeUv(pl, p);
            if (!inExtent(pl.extentUv, u, v, slackM)) continue;
            hit = { t, u, v };
        } else {
            const c = f.chart.cylinder;
            const axis = unit(c.axisDir), x0 = unit(c.thetaZeroDir), y0 = cross(axis, x0);
            // solve |(o + t d - a) x axis| = R
            const oc = sub(ray.origin, c.axisOrigin);
            const dPerp = sub(ray.dir, scale(axis, dot(ray.dir, axis)));
            const oPerp = sub(oc, scale(axis, dot(oc, axis)));
            const A = dot(dPerp, dPerp), B = 2 * dot(dPerp, oPerp), C = dot(oPerp, oPerp) - c.radiusM * c.radiusM;
            const disc = B * B - 4 * A * C;
            if (A < 1e-12 || disc < 0) continue;
            const roots = [(-B - Math.sqrt(disc)) / (2 * A), (-B + Math.sqrt(disc)) / (2 * A)].filter(t => t > 0.1).sort((a, b) => a - b);
            for (const t of roots) {
                const p = add(ray.origin, scale(ray.dir, t));
                const rel = sub(p, c.axisOrigin);
                const v = dot(rel, axis);
                const radial = unit(sub(rel, scale(axis, v)));
                const theta = Math.atan2(dot(radial, y0), dot(radial, x0));
                const outward = scale(radial, c.normalSign);
                if (dot(outward, ray.dir) >= 0) continue; // the inside of the surface it faces away from
                const thetaDeg = ((theta * 180) / Math.PI + 360) % 360;
                const [t0, t1] = c.thetaDeg;
                const lo = ((t0 % 360) + 360) % 360, span = ((t1 - t0) % 360 + 360) % 360 || 360;
                if (((thetaDeg - lo + 360) % 360) > span) continue;
                if (v < c.zM[0] - slackM || v > c.zM[1] + slackM) continue;
                hit = { t, u: ((lo + ((thetaDeg - lo + 360) % 360)) * Math.PI / 180) * c.radiusM, v };
                break;
            }
        }
        if (hit && (!best || hit.t < best.distanceM)) {
            best = { faceId: f.id, source: f.source, point: add(ray.origin, scale(ray.dir, hit.t)), u: hit.u, v: hit.v, distanceM: hit.t };
        }
    }
    return best;
}

/** The fitted surfaces as cast faces. */
export function fitFaces(fit: Pick<StructureFit, 'surfaces'>): CastFace[] {
    return fit.surfaces.map(s => ({ id: s.id, chart: s.chart, source: 'fit' as const }));
}

/**
 * The vertical faces of a footprint outline, tall as the structure, as plane faces (no accepted fit to cast onto). Each
 * edge's plane faces away from the footprint's centroid; u runs along the edge, v up from the ground.
 */
export function footprintFaces(outline: Array<[number, number]>, centroid: { x: number; z: number }, groundY: number, heightM: number): CastFace[] {
    const out: CastFace[] = [];
    for (let i = 0; i < outline.length; i++) {
        const a = outline[i], b = outline[(i + 1) % outline.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 1) continue;
        const u: Vec3 = [(b[0] - a[0]) / len, 0, (b[1] - a[1]) / len];
        let n: Vec3 = unit(cross(u, [0, 1, 0]));
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if ((mid[0] - centroid.x) * n[0] + (mid[1] - centroid.z) * n[2] < 0) n = scale(n, -1);
        // u runs along the edge; flip so (u, v, n) is right-handed isn't needed for casting: the plane is what matters
        out.push({ id: `f${i}`, source: 'footprint', chart: { plane: { origin: [a[0], groundY, a[1]], u, v: [0, 1, 0], normal: n, extentUv: [[0, 0], [len, heightM]] } } });
    }
    return out;
}

export interface BoxCast {
    /** Where the box stands on a face: the face and the (u, v) rectangle its corners and centre land in. */
    faceId: string;
    source: CastFace['source'];
    regionUv: { u0: number; v0: number; u1: number; v1: number };
    centreUv: Vec2;
    centre: Vec3;
    /** Where the left and right edges of the box, at its middle height, land on the face (a run's two ends). */
    ends: [Vec3, Vec3];
    /** How many of the five rays (four corners and the centre) landed on this face. */
    hits: number;
    /** Metres per pixel on the face at the centre. */
    metresPerPx: number;
    distanceM: number;
}

/** Casts the four corners and the centre of an image box; the face most rays land on wins (nearer on a tie). */
export function castBox(view: CastView, box1000: [number, number, number, number], faces: CastFace[]): BoxCast | undefined {
    const cam = castCamera(view);
    const b = boxPixels(box1000, view.widthPx, view.heightPx);
    const pts: Array<[number, number]> = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1], [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2]];
    const hits = pts.map(([x, y]) => castRay(pixelRay(cam, x, y), faces));
    const byFace = new Map<string, FaceHit[]>();
    for (const h of hits) if (h) byFace.set(h.faceId, [...(byFace.get(h.faceId) ?? []), h]);
    let bestId: string | undefined;
    for (const [id, hs] of byFace) {
        if (!bestId) { bestId = id; continue; }
        const cur = byFace.get(bestId)!;
        if (hs.length > cur.length || (hs.length === cur.length && Math.min(...hs.map(h => h.distanceM)) < Math.min(...cur.map(h => h.distanceM)))) bestId = id;
    }
    if (!bestId) return undefined;
    const hs = byFace.get(bestId)!;
    const us = hs.map(h => h.u), vs = hs.map(h => h.v);
    const centreHit = hits[4]?.faceId === bestId ? hits[4]! : hs[0];
    const onFace = faces.filter(f => f.id === bestId);
    const ym = (b.y0 + b.y1) / 2;
    const endOf = (x: number, fallback: Vec3): Vec3 => castRay(pixelRay(cam, x, ym), onFace, 1e3)?.point ?? fallback;
    const ends: [Vec3, Vec3] = [endOf(b.x0, centreHit.point), endOf(b.x1, centreHit.point)];
    const pxStep = Math.hypot(view.widthPx, view.heightPx) / 400;
    const probe = castRay(pixelRay(cam, (b.x0 + b.x1) / 2 + pxStep, (b.y0 + b.y1) / 2), faces.filter(f => f.id === bestId));
    const metresPerPx = probe ? Math.hypot(probe.point[0] - centreHit.point[0], probe.point[1] - centreHit.point[1], probe.point[2] - centreHit.point[2]) / pxStep : (centreHit.distanceM * (view.fovDeg * Math.PI / 180)) / view.widthPx;
    return {
        faceId: bestId, source: centreHit.source, hits: hs.length,
        regionUv: { u0: Math.min(...us), v0: Math.min(...vs), u1: Math.max(...us), v1: Math.max(...vs) },
        centreUv: [centreHit.u, centreHit.v], centre: centreHit.point, ends, metresPerPx, distanceM: centreHit.distanceM
    };
}

/** The slot a located element belongs to: the surface slot whose region holds the element's centre (most overlap), else the nearest edge slot. */
export function slotForCast(cast: BoxCast, fit: Pick<StructureFit, 'slots' | 'surfaces'>): { slotId: string; overlap: number } | undefined {
    const surfaces = new Map(fit.surfaces.map(s => [s.id, s]));
    let best: { slotId: string; overlap: number } | undefined;
    const r = cast.regionUv;
    const area = Math.max(1e-6, (r.u1 - r.u0) * (r.v1 - r.v0));
    for (const slot of fit.slots) {
        const host = slot.host;
        if ('surface' in host) {
            if (host.surface.surfaceId !== cast.faceId) continue;
            const us = host.surface.regionUv.map(p => p[0]), vs = host.surface.regionUv.map(p => p[1]);
            const iu = Math.max(0, Math.min(r.u1, Math.max(...us)) - Math.max(r.u0, Math.min(...us)));
            const iv = Math.max(0, Math.min(r.v1, Math.max(...vs)) - Math.max(r.v0, Math.min(...vs)));
            const overlap = (iu * iv) / area;
            if (overlap > 0 && (!best || overlap > best.overlap)) best = { slotId: slot.id, overlap };
        } else {
            const e = host.edge;
            if (!e.surfaceIds.includes(cast.faceId)) continue;
            const surface = surfaces.get(cast.faceId);
            if (!surface) continue;
            // an edge slot is a band along a crease: its overlap is how close the crease runs to the element's centre, in the element's own height, on the same 0-1 scale as a surface slot's area fraction (1 = the crease runs through the centre), so an element sitting on a crease takes the edge slot and one clear of it takes the surface
            const pts = e.carrier.points;
            let dMin = Infinity;
            for (let i = 0; i < pts.length - 1; i++) dMin = Math.min(dMin, distToSegment(cast.centre, pts[i] as Vec3, pts[i + 1] as Vec3));
            const reach = Math.max(0.6, 0.5 * (r.v1 - r.v0) + 0.5);
            if (dMin <= reach) {
                const overlap = Math.max(0.01, 1 - dMin / reach);
                if (!best || overlap > best.overlap) best = { slotId: slot.id, overlap };
            }
        }
    }
    return best;
}

function distToSegment(p: Vec3, a: Vec3, b: Vec3): number {
    const ab = sub(b, a), ap = sub(p, a);
    const t = Math.max(0, Math.min(1, dot(ap, ab) / (dot(ab, ab) || 1)));
    const q = add(a, scale(ab, t));
    return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** Arc length along a polyline of the point nearest to `p`, metres from the first point, and the polyline's total length. */
export function carrierArc(points: Vec3[], p: Vec3): { s: number; total: number } {
    let best = { s: 0, d: Infinity };
    let acc = 0;
    for (let i = 0; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1];
        const ab = sub(b, a), ap = sub(p, a);
        const len2 = dot(ab, ab) || 1;
        const t = Math.max(0, Math.min(1, dot(ap, ab) / len2));
        const q = add(a, scale(ab, t));
        const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
        const segLen = Math.sqrt(len2);
        if (d < best.d) best = { s: acc + t * segLen, d };
        acc += segLen;
    }
    return { s: best.s, total: acc };
}
