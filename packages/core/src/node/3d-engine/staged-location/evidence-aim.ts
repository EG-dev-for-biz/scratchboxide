/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Which Street View views to ask for, and where to aim each one, from the FITTED slots.
 *
 * Every fitted slot is a 3D region with an outward normal (its host surface's). A view is a pano, an aim (the heading
 * and elevation from the pano's eye to a slot) and a field of view that frames that slot's projected outline. A pano
 * is a candidate for a slot only when it stands in front of the slot (the direction from the slot to the eye makes an
 * angle under 60° with the slot's outward normal), so a pano north of a structure never looks at its south face; and
 * only when the slot is not hidden behind the surface model. The views are chosen greedily by what slot area they add
 * (a slot counts as covered when its centre projects inside the frame and is seen), up to the image budget, nearer and
 * newer panos winning ties. Nothing here knows what a slot holds: only its size, place and normal.
 *
 * Elevation is UP POSITIVE here (streetViewForward's convention); fetchViews converts it to the grounding API's own
 * sign, where positive looks down.
 */

import { MAX_STREET_VIEW_IMAGES_PER_BUILDING, type FittedSurface, type OrnamentSlot, type StructureFit, type Vec3 } from '../../../common/spatial/staged-location-contracts';
import type { GroundingAspectRatio } from '../../spatial/StreetViewGroundingImageService';
import { frameCamera, projectToFrame, ZERO_CORRECTION } from '../../spatial/StreetViewPoseRegistrar';
import type { GroundModel } from '../../spatial/StreetViewSurveyPlanner';
import { chartNormal, slotPoints } from './slot-projection';
import { bearingDeg, STREET_VIEW_EYE_HEIGHT_M, type PanoCandidate, type SelectedView } from './streetview-evidence';
import type { StructurePickResult } from './extraction-sizing';

const DEG = Math.PI / 180;
/** The grounding API's panoramas are about this wide in pixels at any field of view (a narrow fov only upsamples). */
export const GROUNDING_NATIVE_WIDTH_PX = 1920;
export const MIN_VIEW_FOV_DEG = 30;
export const MAX_VIEW_FOV_DEG = 60;
/** A pano must stand within this angle of a slot's outward normal. */
export const MAX_OFF_NORMAL_DEG = 60;
export const MIN_VIEW_DISTANCE_M = 6;
export const MAX_VIEW_DISTANCE_M = 90;
const ASPECTS: Array<{ name: GroundingAspectRatio; ratio: number }> = [
    { name: 'RATIO_1X1', ratio: 1 }, { name: 'RATIO_4X3', ratio: 4 / 3 }, { name: 'RATIO_3X4', ratio: 3 / 4 },
    { name: 'RATIO_16X9', ratio: 16 / 9 }, { name: 'RATIO_21X9', ratio: 21 / 9 }
];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const months = (d?: string) => { const m = /^(\d{4})-(\d{2})/.exec(d ?? ''); return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : -Infinity; };
const signedAngle = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;

export interface SlotTarget {
    slotId: string;
    centre: Vec3;
    outward: Vec3;
    outline: Vec3[];
    /** Area-like weight (m²): what covering the slot is worth. */
    weight: number;
}

/** Every fitted slot as a 3D target. */
export function slotTargets(fit: Pick<StructureFit, 'slots' | 'surfaces'>, structureCentroid: { x: number; z: number }): SlotTarget[] {
    const surfaces = new Map<string, FittedSurface>(fit.surfaces.map(s => [s.id, s]));
    const out: SlotTarget[] = [];
    for (const slot of fit.slots) {
        const { outline } = slotPoints(slot, surfaces);
        if (outline.length < 3) continue;
        const c: Vec3 = [0, 0, 0];
        for (const p of outline) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
        const centre: Vec3 = [c[0] / outline.length, c[1] / outline.length, c[2] / outline.length];
        out.push({ slotId: slot.id, centre, outward: outwardOf(slot, surfaces, centre, structureCentroid), outline, weight: Math.max(0.01, slot.sizeM[0] * slot.sizeM[1]) });
    }
    return out;
}

function outwardOf(slot: OrnamentSlot, surfaces: Map<string, FittedSurface>, centre: Vec3, structureCentroid: { x: number; z: number }): Vec3 {
    const horizontalAway = (): Vec3 => unit([centre[0] - structureCentroid.x, 0, centre[2] - structureCentroid.z]);
    const host = slot.host;
    if ('surface' in host) {
        const surface = surfaces.get(host.surface.surfaceId);
        if (!surface) return horizontalAway();
        const us = host.surface.regionUv.map(p => p[0]);
        return unit(chartNormal(surface.chart, (Math.min(...us) + Math.max(...us)) / 2));
    }
    const surface = surfaces.get(host.edge.surfaceIds[0]);
    if (surface && 'plane' in surface.chart) {
        const n = unit(surface.chart.plane.normal);
        // an edge's outward is horizontal: a roof-plane normal leans up
        const h = unit([n[0], 0, n[2]]);
        return len([h[0], h[1], h[2]]) > 0.5 ? h : horizontalAway();
    }
    return horizontalAway();
}

/** Whether the surface model hides `p` from `eye`: a cell on the way, not the structure's own, stands 0.3 m above the ray. */
export function pointHidden(eye: Vec3, p: Vec3, structure: Pick<StructurePickResult, 'cells'>, ground: Pick<GroundModel, 'cellIndex'>, top: Float32Array): boolean {
    const d = Math.hypot(p[0] - eye[0], p[2] - eye[2]);
    for (let s = 0.5; s < d - 0.5; s += 0.5) {
        const f = s / d;
        const x = eye[0] + (p[0] - eye[0]) * f, z = eye[2] + (p[2] - eye[2]) * f, y = eye[1] + (p[1] - eye[1]) * f;
        if (structure.cells.has(`${Math.floor(x)},${Math.floor(z)}`)) continue;
        const c = ground.cellIndex(x, z);
        if (c >= 0 && top[c] === top[c] && top[c] > y + 0.3) return true;
    }
    return false;
}

function sampleOf(t: SlotTarget): Vec3[] {
    const step = Math.max(1, Math.floor(t.outline.length / 8));
    const out: Vec3[] = [t.centre];
    for (let i = 0; i < t.outline.length && out.length < 9; i += step) out.push(t.outline[i]);
    return out;
}

/** Share of a slot's samples the eye sees (0 when the eye is behind it). */
export function slotSeen(eye: Vec3, t: SlotTarget, structure: Pick<StructurePickResult, 'cells'>, ground: Pick<GroundModel, 'cellIndex'>, top: Float32Array): number {
    const toEye = unit(sub(eye, t.centre));
    if (dot(toEye, t.outward) < Math.cos(MAX_OFF_NORMAL_DEG * DEG)) return 0;
    const pts = sampleOf(t);
    let seen = 0;
    for (const p of pts) if (!pointHidden(eye, p, structure, ground, top)) seen++;
    return seen / pts.length;
}

/** The aim and framing that put one target in the middle of a view from `eye`. */
export function aimAt(eye: Vec3, t: SlotTarget): { headingDeg: number; elevationDeg: number; fovDeg: number; aspectRatio: GroundingAspectRatio; distanceM: number } {
    const d = Math.hypot(t.centre[0] - eye[0], t.centre[2] - eye[2]);
    const headingDeg = bearingDeg(eye[0], eye[2], t.centre[0], t.centre[2]);
    const elevationDeg = Math.max(-60, Math.min(60, Math.atan2(t.centre[1] - eye[1], Math.max(0.1, d)) / DEG));
    // half-angles the outline needs around the aim
    let hAz = 0, hEl = 0;
    for (const q of t.outline) {
        const dq = Math.hypot(q[0] - eye[0], q[2] - eye[2]);
        hAz = Math.max(hAz, Math.abs(signedAngle(bearingDeg(eye[0], eye[2], q[0], q[2]), headingDeg)));
        hEl = Math.max(hEl, Math.abs(Math.atan2(q[1] - eye[1], Math.max(0.1, dq)) / DEG - elevationDeg));
    }
    hAz = Math.min(80, hAz); hEl = Math.min(80, hEl);
    let best = { fov: Infinity, aspect: ASPECTS[1] };
    for (const a of ASPECTS) {
        const need = 2 * Math.atan(Math.max(Math.tan(hAz * DEG), a.ratio * Math.tan(hEl * DEG)) / 0.9) / DEG;
        if (need < best.fov) best = { fov: need, aspect: a };
    }
    const fovDeg = Math.round(Math.max(MIN_VIEW_FOV_DEG, Math.min(MAX_VIEW_FOV_DEG, best.fov)) * 10) / 10;
    return { headingDeg: Math.round(headingDeg * 10) / 10, elevationDeg: Math.round(elevationDeg * 10) / 10, fovDeg, aspectRatio: best.aspect.name, distanceM: Math.round(Math.hypot(d, t.centre[1] - eye[1]) * 100) / 100 };
}

interface Candidate {
    view: SelectedView;
    /** Per slot the view covers: how well (the seen share). */
    covers: Map<string, number>;
    recency: number;
    /** The smallest distance one pixel spans at the slot. */
    native: number;
}

/**
 * The views to fetch, at most `max` (the per-building image budget): the greedy cover of the fitted slots described in
 * the header. A slot the best views leave uncovered stays uncovered (the tile photos read it, or it stays flat).
 */
export function selectViewsForFit(
    panos: PanoCandidate[],
    fit: Pick<StructureFit, 'slots' | 'surfaces'>,
    structure: Pick<StructurePickResult, 'cells' | 'groundY' | 'heightM' | 'centroid'>,
    ground: Pick<GroundModel, 'cellIndex' | 'groundAt'>,
    unmaskedTop: Float32Array,
    max = MAX_STREET_VIEW_IMAGES_PER_BUILDING
): SelectedView[] {
    const limit = Math.max(0, Math.min(MAX_STREET_VIEW_IMAGES_PER_BUILDING, max));
    const targets = slotTargets(fit, structure.centroid);
    if (!limit || !targets.length || !panos.length) return [];
    const totalWeight = targets.reduce((s, t) => s + t.weight, 0);
    const newest = Math.max(...panos.map(p => months(p.date)));
    const candidates: Candidate[] = [];
    // the seen share of every (pano, slot) pair, once
    const seenBy = new Map<string, number[]>();
    for (const p of panos) {
        const g = ground.groundAt(p.x, p.z);
        const eye: Vec3 = [p.x, (g === g ? g : structure.groundY) + STREET_VIEW_EYE_HEIGHT_M, p.z];
        const seen = targets.map(t => {
            const d = Math.hypot(t.centre[0] - eye[0], t.centre[2] - eye[2]);
            return d < MIN_VIEW_DISTANCE_M || d > MAX_VIEW_DISTANCE_M ? 0 : slotSeen(eye, t, structure, ground, unmaskedTop);
        });
        seenBy.set(p.panoId, seen);
        const recency = Number.isFinite(newest) && Number.isFinite(months(p.date)) ? Math.max(0.5, 1 - (newest - months(p.date)) / 72) : 0.75;
        targets.forEach((t, i) => {
            if (seen[i] < 0.4) return;
            const aim = aimAt(eye, t);
            const ratio = ASPECTS.find(a => a.name === aim.aspectRatio)!.ratio;
            const W = 1000, H = W / ratio;
            const cam = frameCamera(eye, aim.headingDeg, aim.elevationDeg, aim.fovDeg, W, H, ZERO_CORRECTION, aim.headingDeg);
            const covers = new Map<string, number>();
            targets.forEach((u, j) => {
                if (seen[j] < 0.4) return;
                const q = projectToFrame(cam, u.centre);
                if (q && q[0] > 0.04 * W && q[0] < 0.96 * W && q[1] > 0.04 * H && q[1] < 0.96 * H) covers.set(u.slotId, seen[j]);
            });
            if (!covers.has(t.slotId)) return;
            const native = (aim.distanceM * aim.fovDeg * DEG) / GROUNDING_NATIVE_WIDTH_PX;
            candidates.push({
                recency,
                native,
                covers,
                view: {
                    panoId: p.panoId, date: p.date, copyright: p.copyright, eye, facadeHeadingDeg: Math.round(((Math.atan2(t.outward[0], -t.outward[2]) / DEG) + 360) % 360),
                    headingDeg: aim.headingDeg, pitchDeg: aim.elevationDeg, fovDeg: aim.fovDeg, aspectRatio: aim.aspectRatio, distanceM: aim.distanceM,
                    score: 0, aimedSlotIds: [t.slotId], coveredSlotIds: [...covers.keys()]
                } satisfies SelectedView
            });
        });
    }
    const weightOf = new Map(targets.map(t => [t.slotId, t.weight]));
    const covered = new Map<string, number>();
    const chosen: SelectedView[] = [];
    while (chosen.length < limit) {
        let best: { c: Candidate; score: number; gain: number } | undefined;
        for (const c of candidates) {
            let gain = 0;
            for (const [slot, q] of c.covers) gain += weightOf.get(slot)! * Math.max(0, q - (covered.get(slot) ?? 0));
            if (gain < 0.02 * totalWeight) continue;
            const score = (gain * c.recency) / Math.sqrt(Math.max(0.005, c.native) / 0.01);
            if (!best || score > best.score || (score === best.score && c.view.panoId < best.c.view.panoId)) best = { c, score, gain };
        }
        if (!best) break;
        best.c.view.score = Math.round(best.score * 1000) / 1000;
        chosen.push(best.c.view);
        for (const [slot, q] of best.c.covers) covered.set(slot, Math.max(covered.get(slot) ?? 0, q));
    }
    return chosen;
}
