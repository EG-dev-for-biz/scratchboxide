/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pass 2, from the survey to the detail: what the survey found, located in 3D, and one narrow crop per group.
 *
 * The survey's elements carry image boxes. Each box is cast through its pano's camera model onto the fitted faces
 * (survey-casting.ts), which says where it stands on the structure and which fitted slot holds it: the slot comes from
 * geometry, the vision model is never asked to place anything in a coordinate frame it cannot see. Elements are then
 * grouped by slot, and each group gets ONE narrower crop (fov 30-45°) aimed at where the group stands, from the same
 * pano that surveyed it. A group's located run (where its box lands along the slot) and its repeat count are what the
 * measurements are anchored to afterwards (ornament-anchor.ts).
 */

import type { OrnamentSlot, StructureFit, SurveyedFace, SurveyElement, Vec2, Vec3 } from '../../../common/spatial/staged-location-contracts';
import { MAX_STREET_VIEW_IMAGES_PER_BUILDING } from '../../../common/spatial/staged-location-contracts';
import type { GroundingAspectRatio } from '../../spatial/StreetViewGroundingImageService';
import { bearingDeg, NOMINAL_POSE_UNCERTAINTY, type SelectedView } from './streetview-evidence';
import type { SurveyResult } from './face-survey';
import { carrierArc, castBox, fitFaces, slotForCast, type BoxCast } from './survey-casting';
import { pointInPolygon } from './ornament-vision';
import type { Registration } from './pano-registration';

const DEG = Math.PI / 180;
export const DETAIL_FOV_MIN_DEG = 30;
export const DETAIL_FOV_MAX_DEG = 45;
/** An element whose box lands on a slot with less than this share of its own area is not given to that slot (surface slots). */
export const MIN_SLOT_OVERLAP = 0.15;
/** A group wider than one narrow crop frames is read in overlapping crops, at most this many. */
export const MAX_CROPS_PER_GROUP = 3;

export interface LocatedElement {
    /** "f<face>.e<index>": stable for one survey. */
    id: string;
    faceId: string;
    headingDeg: number;
    panoId: string;
    imageIndex: number;
    /** The model's own word for it. */
    kind: string;
    box: [number, number, number, number];
    slotId: string;
    slotOverlap: number;
    surfaceId: string;
    /** The box's extent on the face, metres, in the face's (u, v). */
    regionUv: BoxCast['regionUv'];
    widthM: number;
    heightM: number;
    centre: Vec3;
    /** Metres one image pixel spans at the element. */
    metresPerPx: number;
    /** For a repeat: the count the model saw, and the cell it implies (the run's length over the count; metres, from the scan's geometry). */
    repeat?: { count: number; pitchM: number; axis: string };
    /** On an edge slot: where the box's two ends land along the carrier (metres from its start), clamped to the carrier. */
    runAlongM?: [number, number];
    material: string;
    weathering: string;
    confidence: number;
    /** Metres from the pano to the cast point. */
    distanceM: number;
    /** Where the located place can be wrong by, metres: the nominal (unregistered) pano pose's position and heading error carried to the cast point. */
    locationUncertaintyM: number;
    /** Where the place came from, said plainly: the survey model's own box, cast through the nominal pano pose. */
    placeSource: string;
}

export interface UnlocatedElement { faceId: string; kind: string; reason: string }
export interface DetailPlan {
    located: LocatedElement[];
    unlocated: UnlocatedElement[];
    /** The crops to fetch, narrow, aimed at the located groups; at most `max`. */
    views: SelectedView[];
}

export const LOCATED_PLACE_SOURCE = 'the survey model\'s bounding box cast through the nominal (unregistered) pano pose';

/** Where a registered element's place can still be wrong by: the pairs' disagreement left after the fit, plus a quarter degree of heading at the distance, never looser than the nominal pose. */
export function registeredUncertaintyAt(distanceM: number, afterRmsM: number, pairResidualM: number): number {
    const v = Math.hypot(Math.max(0.05, afterRmsM), pairResidualM, distanceM * Math.tan(0.25 * Math.PI / 180));
    return Math.min(poseUncertaintyAt(distanceM), Math.round(v * 100) / 100);
}

export function registeredPlaceSource(reg: Registration, panoId: string, pairs: number): string {
    const p = reg.perPano.find(x => x.panoId === panoId);
    return `the survey model's bounding box cast through pano ${panoId}'s pose registered against ${pairs} matched view${pairs === 1 ? '' : 's'} (eye shifted ${p ? Math.hypot(p.dxM, p.dzM).toFixed(2) : '0'} m, heading ${p ? p.dyawDeg.toFixed(2) : '0'}°; the matched boxes disagree by ${reg.afterRmsM.toFixed(2)} m RMS after the fit, ${reg.beforeRmsM.toFixed(2)} m before)`;
}

/** The nominal pose's position and heading error carried to a point `distanceM` away, metres (the two add in quadrature). */
export function poseUncertaintyAt(distanceM: number): number {
    const a = distanceM * Math.tan(NOMINAL_POSE_UNCERTAINTY.degrees * Math.PI / 180);
    return Math.round(Math.hypot(NOMINAL_POSE_UNCERTAINTY.meters, a) * 100) / 100;
}

/** Casts every surveyed element onto the fitted faces and finds its slot. */
export function locateSurveyElements(survey: Pick<SurveyResult, 'faces' | 'read'>, fit: Pick<StructureFit, 'slots' | 'surfaces'>, registration?: Registration): { located: LocatedElement[]; unlocated: UnlocatedElement[] } {
    const faces = fitFaces(fit);
    const located: LocatedElement[] = [];
    const unlocated: UnlocatedElement[] = [];
    for (const face of survey.faces) {
        const r = survey.read.find(x => x.view.faceId === face.faceId);
        if (!r || face.skipped) continue;
        face.elements.forEach((el: SurveyElement, k) => {
            const correction = registration?.corrections.get(r.view.panoId);
            const view = { eye: r.view.eye, headingDeg: r.view.headingDeg, pitchDeg: r.view.pitchDeg, fovDeg: r.view.fovDeg, widthPx: r.widthPx, heightPx: r.heightPx, ...(correction ? { correction } : {}) };
            const cast = castBox(view, el.box, faces);
            if (!cast) { unlocated.push({ faceId: face.faceId, kind: el.kind, reason: 'its box does not land on any fitted face' }); return; }
            const slot = slotForCast(cast, fit);
            if (!slot) { unlocated.push({ faceId: face.faceId, kind: el.kind, reason: `its box lands on fitted face ${cast.faceId}, in no slot` }); return; }
            const slotDef = fit.slots.find(s => s.id === slot.slotId)!;
            if ('surface' in slotDef.host && slot.overlap < MIN_SLOT_OVERLAP) { unlocated.push({ faceId: face.faceId, kind: el.kind, reason: `only ${Math.round(slot.overlap * 100)}% of its box lies in slot ${slot.slotId}` }); return; }
            const widthM = cast.regionUv.u1 - cast.regionUv.u0, heightM = cast.regionUv.v1 - cast.regionUv.v0;
            let runAlongM: [number, number] | undefined;
            let runLen = widthM;
            if ('edge' in slotDef.host) {
                const pts = slotDef.host.edge.carrier.points as Vec3[];
                const a = carrierArc(pts, cast.ends[0]), b = carrierArc(pts, cast.ends[1]);
                const lo = Math.max(0, Math.min(a.s, b.s)), hi = Math.min(a.total, Math.max(a.s, b.s));
                runAlongM = [Math.round(lo * 1000) / 1000, Math.round(hi * 1000) / 1000];
                runLen = hi - lo;
            }
            const horizontal = el.repeat?.axis !== 'v';
            const repeat = el.repeat ? { count: el.repeat.count, axis: el.repeat.axis, pitchM: Math.round(((horizontal ? runLen : heightM) / el.repeat.count) * 1000) / 1000 } : undefined;
            located.push({
                id: `${face.faceId}.e${k}`, faceId: face.faceId, headingDeg: face.headingDeg, panoId: r.view.panoId, imageIndex: r.imageIndex, kind: el.kind, box: el.box,
                slotId: slot.slotId, slotOverlap: Math.round(slot.overlap * 1000) / 1000, surfaceId: cast.faceId, regionUv: cast.regionUv, widthM: Math.round(widthM * 1000) / 1000, heightM: Math.round(heightM * 1000) / 1000,
                centre: cast.centre, metresPerPx: Math.round(cast.metresPerPx * 10000) / 10000,
                ...(repeat ? { repeat } : {}), ...(runAlongM ? { runAlongM } : {}), material: el.material, weathering: el.weathering, confidence: el.confidence,
                distanceM: Math.round(cast.distanceM * 100) / 100,
                ...placeOf(registration, r.view.panoId, face.faceId, k, cast.distanceM)
            });
        });
    }
    return { located, unlocated };
}

function placeOf(reg: Registration | undefined, panoId: string, faceId: string, k: number, distanceM: number): { locationUncertaintyM: number; placeSource: string } {
    const mine = reg?.pairs.filter(p => p.used && p.id.startsWith(`${faceId}.e${k}@`)) ?? [];
    const panoPairs = reg?.perPano.find(p => p.panoId === panoId)?.pairs ?? 0;
    if (!reg || !mine.length || panoPairs < 1) return { locationUncertaintyM: poseUncertaintyAt(distanceM), placeSource: LOCATED_PLACE_SOURCE };
    return { locationUncertaintyM: registeredUncertaintyAt(distanceM, reg.afterRmsM, Math.max(...mine.map(p => p.residualM))), placeSource: registeredPlaceSource(reg, panoId, mine.length) };
}

const ASPECTS: Array<{ name: GroundingAspectRatio; ratio: number }> = [
    { name: 'RATIO_1X1', ratio: 1 }, { name: 'RATIO_4X3', ratio: 4 / 3 }, { name: 'RATIO_3X4', ratio: 3 / 4 }, { name: 'RATIO_16X9', ratio: 16 / 9 }
];

/**
 * One narrow crop per slot that holds located elements: from the pano that surveyed them, aimed at the middle of the
 * group, field of view framing the group but kept to 30-45°. The slots with the most confident, largest groups come
 * first; at most `max` crops (the per-building image budget).
 */
export function planDetailViews(located: LocatedElement[], survey: Pick<SurveyResult, 'read'>, max = MAX_STREET_VIEW_IMAGES_PER_BUILDING, registration?: Registration): SelectedView[] {
    const bySlot = new Map<string, LocatedElement[]>();
    for (const l of located) bySlot.set(l.slotId, [...(bySlot.get(l.slotId) ?? []), l]);
    const groups = [...bySlot.entries()].map(([slotId, els]) => {
        const weight = els.reduce((w, e) => w + (e.confidence / 100) * Math.max(0.05, e.widthM * e.heightM), 0);
        return { slotId, els, weight };
    }).sort((a, b) => b.weight - a.weight || a.slotId.localeCompare(b.slotId));
    const views: SelectedView[] = [];
    for (const g of groups) {
        if (views.length >= Math.max(0, Math.min(MAX_STREET_VIEW_IMAGES_PER_BUILDING, max))) break;
        // the pano that saw most of the group's confidence
        const byImage = new Map<string, number>();
        for (const e of g.els) byImage.set(e.panoId, (byImage.get(e.panoId) ?? 0) + e.confidence);
        const panoId = [...byImage.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
        const r = survey.read.find(x => x.view.panoId === panoId);
        if (!r) continue;
        const nominalEye = r.view.eye;
        // the pano's true place and heading are the registered ones: the crop is aimed from there (the stated heading is relative to the pano's own frame)
        const corr = registration?.corrections.get(panoId);
        const eye: Vec3 = corr ? [nominalEye[0] + corr.dx, nominalEye[1] + corr.dy, nominalEye[2] + corr.dz] : nominalEye;
        const inPano = g.els.filter(e => e.panoId === panoId);
        const u0 = Math.min(...inPano.map(e => e.regionUv.u0)), u1 = Math.max(...inPano.map(e => e.regionUv.u1));
        const v0 = Math.min(...inPano.map(e => e.regionUv.v0)), v1 = Math.max(...inPano.map(e => e.regionUv.v1));
        // the group's extent along its own horizontal axis (the farthest-apart pair of element centres); a group wider than one crop frames is split
        // into overlapping crops along it, so a long row is read in pieces each close enough to count
        const meanC: Vec3 = [inPano.reduce((s, e) => s + e.centre[0], 0) / inPano.length, inPano.reduce((s, e) => s + e.centre[1], 0) / inPano.length, inPano.reduce((s, e) => s + e.centre[2], 0) / inPano.length];
        let axis: [number, number] = [0, 0];
        let far = 0;
        for (const p of inPano) for (const q of inPano) { const l = Math.hypot(p.centre[0] - q.centre[0], p.centre[2] - q.centre[2]); if (l > far) { far = l; axis = [(q.centre[0] - p.centre[0]) / l, (q.centre[2] - p.centre[2]) / l]; } }
        const widthM = Math.max(0.5, u1 - u0), heightM = Math.max(0.5, v1 - v0);
        const dMean = Math.hypot(meanC[0] - eye[0], meanC[2] - eye[2]);
        const coverM = 2 * Math.tan((DETAIL_FOV_MAX_DEG * DEG) / 2) * Math.max(1, dMean) / 1.25;
        let t0 = 0, t1 = 0;
        if (far > 0) { const proj = inPano.flatMap(e => { const t = (e.centre[0] - meanC[0]) * axis[0] + (e.centre[2] - meanC[2]) * axis[1]; return [t - e.widthM / 2, t + e.widthM / 2]; }); t0 = Math.min(...proj); t1 = Math.max(...proj); }
        const spanM = Math.max(far > 0 ? t1 - t0 : widthM, widthM);
        const n = Math.max(1, Math.min(MAX_CROPS_PER_GROUP, Math.ceil(spanM / (0.7 * coverM))));
        for (let k = 0; k < n; k++) {
            if (views.length >= Math.max(0, Math.min(MAX_STREET_VIEW_IMAGES_PER_BUILDING, max))) break;
            const frac = n === 1 ? 0.5 : (k + 0.5) / n;
            const tc = n === 1 || far <= 0 ? 0 : t0 + (t1 - t0) * frac - 0;
            const cx = meanC[0] + (n === 1 ? 0 : axis[0] * tc), cz = meanC[2] + (n === 1 ? 0 : axis[1] * tc), cy = meanC[1];
            const winW = n === 1 ? widthM : Math.max(0.5, spanM / n * 1.4);
            const d = Math.hypot(cx - eye[0], cz - eye[2]);
            const elevationDeg = Math.max(-20, Math.min(60, Math.atan2(cy - eye[1], Math.max(0.1, d)) / DEG));
            const aspect = ASPECTS.reduce((best, a) => (Math.abs(Math.log(a.ratio / (winW / heightM))) < Math.abs(Math.log(best.ratio / (winW / heightM))) ? a : best), ASPECTS[1]);
            // fov (horizontal) that frames the larger need with 25% margin; kept to 30-45
            const needH = 2 * Math.atan(((winW / 2) * 1.25) / Math.max(1, d)) / DEG;
            const needV = 2 * Math.atan((((heightM / 2) * 1.25) / Math.max(1, d)) * aspect.ratio) / DEG;
            const fovDeg = Math.round(Math.max(DETAIL_FOV_MIN_DEG, Math.min(DETAIL_FOV_MAX_DEG, Math.max(needH, needV))) * 10) / 10;
            const heading = (((bearingDeg(eye[0], eye[2], cx, cz) - (corr?.dyawDeg ?? 0)) % 360) + 360) % 360;
            views.push({
                panoId, date: r.view.date, copyright: r.view.copyright, eye: nominalEye, facadeHeadingDeg: Math.round(inPano[0].headingDeg),
                headingDeg: Math.round(heading * 10) / 10, pitchDeg: Math.round((elevationDeg - (corr?.dpitchDeg ?? 0)) * 10) / 10, fovDeg, aspectRatio: aspect.name,
                distanceM: Math.round(Math.hypot(d, cy - eye[1]) * 100) / 100, score: Math.round(g.weight * 1000) / 1000, aimedSlotIds: [g.slotId], coveredSlotIds: [g.slotId]
            });
        }
    }
    return views;
}

/** Locate the survey's elements on a fit and plan the crops. A survey with nothing locatable plans nothing. */
export function planDetailFromSurvey(survey: Pick<SurveyResult, 'faces' | 'read'>, fit: Pick<StructureFit, 'slots' | 'surfaces'>, max = MAX_STREET_VIEW_IMAGES_PER_BUILDING, registration?: Registration): DetailPlan {
    const { located, unlocated } = locateSurveyElements(survey, fit, registration);
    return { located, unlocated, views: planDetailViews(located, survey, max, registration) };
}

/** The hints table the reading prompt carries: per slot, what the survey saw there and where it stands, as the scan measures it. */
/** The part of a located element that lies inside a surface slot's region: its extent and the point with the most room (the farthest from the region's edge). */
export function insideSlot(l: Pick<LocatedElement, 'regionUv'>, region: Vec2[]): { u0: number; u1: number; v0: number; v1: number; cu: number; cv: number; roomM: number } | undefined {
    const r = l.regionUv;
    const N = 24;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    let best: { cu: number; cv: number; room: number } | undefined;
    const edgeDist = (u: number, v: number): number => {
        let d = Infinity;
        for (let i = 0, j = region.length - 1; i < region.length; j = i++) {
            const [ax, ay] = region[j], [bx, by] = region[i];
            const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
            const t = Math.max(0, Math.min(1, ((u - ax) * dx + (v - ay) * dy) / l2));
            d = Math.min(d, Math.hypot(u - (ax + t * dx), v - (ay + t * dy)));
        }
        return d;
    };
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        const u = r.u0 + ((r.u1 - r.u0) * (i + 0.5)) / N, v = r.v0 + ((r.v1 - r.v0) * (j + 0.5)) / N;
        if (!pointInPolygon(u, v, region, 0)) continue;
        u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
        const room = Math.min(edgeDist(u, v), u - r.u0 + (r.u1 - r.u0) / N, r.u1 - u + (r.u1 - r.u0) / N, v - r.v0 + (r.v1 - r.v0) / N, r.v1 - v + (r.v1 - r.v0) / N);
        if (!best || room > best.room) best = { cu: u, cv: v, room };
    }
    return best ? { u0, u1, v0, v1, cu: best.cu, cv: best.cv, roomM: best.room } : undefined;
}

export function surveyHintLines(located: LocatedElement[], slots: OrnamentSlot[]): string[] {
    const lines: string[] = [];
    for (const slot of slots) {
        const here = located.filter(l => l.slotId === slot.id);
        if (!here.length) continue;
        for (const l of here) {
            // the survey's own repeat count and pitch are NOT passed on: the close crop is read afresh, so the two readings stay independent
            const rep = l.repeat ? `, a repeating element (count it from the crop yourself)` : '';
            // a surface slot: where the element stands INSIDE the slot's own region (the element's box cut with the region's polygon), in the chart
            // axes the reply uses, with the point of most room: so nothing needs placing in a frame the model cannot see
            const inside = 'surface' in slot.host ? insideSlot(l, slot.host.surface.regionUv) : undefined;
            const run = l.runAlongM ? `, running ${l.runAlongM[0].toFixed(2)}-${l.runAlongM[1].toFixed(2)} m along the edge`
                : `, ${l.widthM.toFixed(2)} × ${l.heightM.toFixed(2)} m on the face${inside ? `, inside the slot over u ${inside.u0.toFixed(2)}-${inside.u1.toFixed(2)} m, v ${inside.v0.toFixed(2)}-${inside.v1.toFixed(2)} m, with most room at u ${inside.cu.toFixed(2)} m, v ${inside.cv.toFixed(2)} m (about ${inside.roomM.toFixed(2)} m clear all round; the slot's own chart axes, the ones your reply uses)` : ''}`;
            lines.push(`${slot.id}: the survey saw "${l.kind}" (${l.material}; ${l.weathering}; confidence ${l.confidence})${run}${rep}; the place comes from ${l.placeSource} and is good to about ${l.locationUncertaintyM.toFixed(1)} m`);
        }
    }
    return lines;
}

/** For the result: the faces that were surveyed and how many of their elements found a slot. */
export function describeLocated(faces: SurveyedFace[], plan: Pick<DetailPlan, 'located' | 'unlocated' | 'views'>): string {
    const total = faces.reduce((n, f) => n + f.elements.length, 0);
    return `${plan.located.length} of ${total} surveyed elements located in ${new Set(plan.located.map(l => l.slotId)).size} slots, ${plan.views.length} narrow crop${plan.views.length === 1 ? '' : 's'}`;
}
