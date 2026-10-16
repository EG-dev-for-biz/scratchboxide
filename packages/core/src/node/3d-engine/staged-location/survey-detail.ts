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

import type { OrnamentSlot, StructureFit, SurveyedFace, SurveyElement, Vec3 } from '../../../common/spatial/staged-location-contracts';
import { MAX_STREET_VIEW_IMAGES_PER_BUILDING } from '../../../common/spatial/staged-location-contracts';
import type { GroundingAspectRatio } from '../../spatial/StreetViewGroundingImageService';
import { bearingDeg, type SelectedView } from './streetview-evidence';
import type { SurveyResult } from './face-survey';
import { carrierArc, castBox, fitFaces, slotForCast, type BoxCast } from './survey-casting';

const DEG = Math.PI / 180;
export const DETAIL_FOV_MIN_DEG = 30;
export const DETAIL_FOV_MAX_DEG = 45;
/** An element whose box lands on a slot with less than this share of its own area is not given to that slot (surface slots). */
export const MIN_SLOT_OVERLAP = 0.15;

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
}

export interface UnlocatedElement { faceId: string; kind: string; reason: string }
export interface DetailPlan {
    located: LocatedElement[];
    unlocated: UnlocatedElement[];
    /** The crops to fetch, narrow, aimed at the located groups; at most `max`. */
    views: SelectedView[];
}

/** Casts every surveyed element onto the fitted faces and finds its slot. */
export function locateSurveyElements(survey: Pick<SurveyResult, 'faces' | 'read'>, fit: Pick<StructureFit, 'slots' | 'surfaces'>): { located: LocatedElement[]; unlocated: UnlocatedElement[] } {
    const faces = fitFaces(fit);
    const located: LocatedElement[] = [];
    const unlocated: UnlocatedElement[] = [];
    for (const face of survey.faces) {
        const r = survey.read.find(x => x.view.faceId === face.faceId);
        if (!r || face.skipped) continue;
        face.elements.forEach((el: SurveyElement, k) => {
            const view = { eye: r.view.eye, headingDeg: r.view.headingDeg, pitchDeg: r.view.pitchDeg, fovDeg: r.view.fovDeg, widthPx: r.widthPx, heightPx: r.heightPx };
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
                ...(repeat ? { repeat } : {}), ...(runAlongM ? { runAlongM } : {}), material: el.material, weathering: el.weathering, confidence: el.confidence
            });
        });
    }
    return { located, unlocated };
}

const ASPECTS: Array<{ name: GroundingAspectRatio; ratio: number }> = [
    { name: 'RATIO_1X1', ratio: 1 }, { name: 'RATIO_4X3', ratio: 4 / 3 }, { name: 'RATIO_3X4', ratio: 3 / 4 }, { name: 'RATIO_16X9', ratio: 16 / 9 }
];

/**
 * One narrow crop per slot that holds located elements: from the pano that surveyed them, aimed at the middle of the
 * group, field of view framing the group but kept to 30-45°. The slots with the most confident, largest groups come
 * first; at most `max` crops (the per-building image budget).
 */
export function planDetailViews(located: LocatedElement[], survey: Pick<SurveyResult, 'read'>, max = MAX_STREET_VIEW_IMAGES_PER_BUILDING): SelectedView[] {
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
        const eye = r.view.eye;
        const inPano = g.els.filter(e => e.panoId === panoId);
        const u0 = Math.min(...inPano.map(e => e.regionUv.u0)), u1 = Math.max(...inPano.map(e => e.regionUv.u1));
        const v0 = Math.min(...inPano.map(e => e.regionUv.v0)), v1 = Math.max(...inPano.map(e => e.regionUv.v1));
        const cx = inPano.reduce((s, e) => s + e.centre[0], 0) / inPano.length, cy = inPano.reduce((s, e) => s + e.centre[1], 0) / inPano.length, cz = inPano.reduce((s, e) => s + e.centre[2], 0) / inPano.length;
        const d = Math.hypot(cx - eye[0], cz - eye[2]);
        const elevationDeg = Math.max(-20, Math.min(60, Math.atan2(cy - eye[1], Math.max(0.1, d)) / DEG));
        const widthM = Math.max(0.5, u1 - u0), heightM = Math.max(0.5, v1 - v0);
        const aspect = ASPECTS.reduce((best, a) => (Math.abs(Math.log(a.ratio / (widthM / heightM))) < Math.abs(Math.log(best.ratio / (widthM / heightM))) ? a : best), ASPECTS[1]);
        // fov (horizontal) that frames the larger need with 25% margin; kept to 30-45
        const needH = 2 * Math.atan(((widthM / 2) * 1.25) / Math.max(1, d)) / DEG;
        const needV = 2 * Math.atan((((heightM / 2) * 1.25) / Math.max(1, d)) * aspect.ratio) / DEG;
        const fovDeg = Math.round(Math.max(DETAIL_FOV_MIN_DEG, Math.min(DETAIL_FOV_MAX_DEG, Math.max(needH, needV))) * 10) / 10;
        views.push({
            panoId, date: r.view.date, copyright: r.view.copyright, eye, facadeHeadingDeg: Math.round(inPano[0].headingDeg),
            headingDeg: Math.round(bearingDeg(eye[0], eye[2], cx, cz) * 10) / 10, pitchDeg: Math.round(elevationDeg * 10) / 10, fovDeg, aspectRatio: aspect.name,
            distanceM: Math.round(Math.hypot(d, cy - eye[1]) * 100) / 100, score: Math.round(g.weight * 1000) / 1000, aimedSlotIds: [g.slotId], coveredSlotIds: [g.slotId]
        });
    }
    return views;
}

/** Locate the survey's elements on a fit and plan the crops. A survey with nothing locatable plans nothing. */
export function planDetailFromSurvey(survey: Pick<SurveyResult, 'faces' | 'read'>, fit: Pick<StructureFit, 'slots' | 'surfaces'>, max = MAX_STREET_VIEW_IMAGES_PER_BUILDING): DetailPlan {
    const { located, unlocated } = locateSurveyElements(survey, fit);
    return { located, unlocated, views: planDetailViews(located, survey, max) };
}

/** The hints table the reading prompt carries: per slot, what the survey saw there and where it stands, as the scan measures it. */
export function surveyHintLines(located: LocatedElement[], slots: OrnamentSlot[]): string[] {
    const lines: string[] = [];
    for (const slot of slots) {
        const here = located.filter(l => l.slotId === slot.id);
        if (!here.length) continue;
        for (const l of here) {
            const rep = l.repeat ? `, ${l.repeat.count} repeats (${l.repeat.axis}) about ${Math.round(l.repeat.pitchM * 1000)} mm per cell` : '';
            const run = l.runAlongM ? `, running ${l.runAlongM[0].toFixed(2)}-${l.runAlongM[1].toFixed(2)} m along the edge` : `, ${l.widthM.toFixed(2)} × ${l.heightM.toFixed(2)} m on the face`;
            lines.push(`${slot.id}: the survey saw "${l.kind}" (${l.material}; ${l.weathering}; confidence ${l.confidence})${run}${rep}`);
        }
    }
    return lines;
}

/** For the result: the faces that were surveyed and how many of their elements found a slot. */
export function describeLocated(faces: SurveyedFace[], plan: Pick<DetailPlan, 'located' | 'unlocated' | 'views'>): string {
    const total = faces.reduce((n, f) => n + f.elements.length, 0);
    return `${plan.located.length} of ${total} surveyed elements located in ${new Set(plan.located.map(l => l.slotId)).size} slots, ${plan.views.length} narrow crop${plan.views.length === 1 ? '' : 's'}`;
}
