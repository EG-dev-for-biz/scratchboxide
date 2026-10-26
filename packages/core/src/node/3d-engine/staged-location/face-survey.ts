/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pass 1, the draft survey: the structure's four faces in one look.
 *
 * Up to four Google-captured Street View panoramas are chosen so each looks at a different face of the structure from
 * its outward-normal side (the fitted faces' normals when a fit is accepted, otherwise the compass sides of the
 * footprint). Each face is requested wide (field of view 55-70°, aimed at the face's vertical middle, 4:3) in parallel,
 * and ONE vision call reads all of them: per face an inventory of the elements it sees (the model's own words for what
 * each is, never a closed list), where, how big relative to the face, how many repeat and at what pitch, the material
 * and its weathering. The colours are MEASURED from the decoded pixels (photo-palette.ts), never written by the model.
 *
 * The result feeds (1) materialHints for the later texture and PBR steps (labelled photo-inferred, the palette marked
 * measured-from-photo; no Street View pixel is ever used as a texture) and (2) the detail pass, which locates each
 * element in 3D by casting its box through the pano's camera model (survey-casting.ts).
 *
 * Images are decoded in memory and dropped; only pano ids, boxes, text and palettes are kept.
 */

import { groundingRequestFovDeg } from '../../spatial/StreetViewPoseRegistrar';
import type { Content, Part } from '@google/genai';
import {
    MAX_STREET_VIEW_IMAGES_PER_BUILDING, MAX_SURVEY_FACES, schemaClosure, STAGED_VISION_MODEL_DEFAULT, validateContract,
    type FaceSurveyReply, type FittedSurface, type MaterialHints, type StageCost, type StructureFit, type SurveyedFace, type SurveyElement,
    type SurveyMaterial, type Vec3, type VisionModelUse
} from '../../../common/spatial/staged-location-contracts';
import type { VisionModelChain } from '../../gemini/vision-model-chain';
import type { GroundModel } from '../../spatial/StreetViewSurveyPlanner';
import type { StructurePickResult } from './extraction-sizing';
import { MIN_VIEW_DISTANCE_M, MAX_VIEW_DISTANCE_M, pointHidden } from './evidence-aim';
import { ORNAMENT_MAX_OUTPUT_TOKENS, ORNAMENT_THINKING_BUDGET, VisionStageError, visionUse } from './ornament-vision';
import { capImageSide } from './ornament-batches';
import { decodeJpegInMemory, measurePalette } from './photo-palette';
import { chartNormal, chartPoint } from './slot-projection';
import {
    bearingDeg, facadeGeometry, fetchViews, knownRefusals, STREET_VIEW_EYE_HEIGHT_M, type EvidenceImage, type PanoCandidate, type SelectedView, type StreetViewEvidenceDeps
} from './streetview-evidence';
import { callTimeout, type CallTimer } from './call-timer';

const DEG = Math.PI / 180;
export const SURVEY_PROMPT_VERSION = 'survey/v2';
/** A survey image is sent to the vision model at most this long on its longest side (the full image is kept for the palette and registration). */
export const SURVEY_SEND_MAX_SIDE_PX = 1024;
export const SURVEY_FOV_MIN_DEG = 55;
export const SURVEY_FOV_MAX_DEG = 70;
export const SURVEY_IMAGE_TIMEOUT_MS = 30_000;
/** One call per face, each with this limit: the model reads one image and writes a reply of a few thousand tokens. */
export const SURVEY_VISION_TIMEOUT_MS = 240_000;
/** A pano must stand within this angle of a face's outward normal. */
export const SURVEY_MAX_OFF_NORMAL_DEG = 80;
/** Share of a face a pano must see to survey it. */
export const SURVEY_MIN_FACE_SEEN = 0.3;
/** Bearings of the chosen panos, seen from the structure, are kept at least this far apart where the choice allows. */
export const SURVEY_MIN_BEARING_SEPARATION_DEG = 25;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const months = (d?: string) => { const m = /^(\d{4})-(\d{2})/.exec(d ?? ''); return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : -Infinity; };
const angleBetween = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// ----------------------------------------------------------------------------------------------------------------
// the faces
// ----------------------------------------------------------------------------------------------------------------

export interface SurveyFaceTarget {
    faceId: string;
    /** Outward direction, degrees clockwise from north. */
    headingDeg: number;
    source: 'fit' | 'footprint';
    /** The middle of the face (mid-height of the band it stands for), tile frame. */
    centre: Vec3;
    outward: Vec3;
    widthM: number;
    heightM: number;
}

/**
 * A face taller than this is split into several vertical bands, each its own survey target pitched at its own middle,
 * instead of one shot aimed at the structure's overall mid-height. A single wide-FOV shot can resolve a face up to a
 * few dozen metres tall; above that it reads only the band it happens to be aimed at and calls the whole face
 * "surveyed", leaving the rest with no photo evidence at all (a supertall's base and crown, say). No new Street View
 * sources are needed: a band only changes the look angle (pitch), still from the same ground-level panoramas.
 */
export const SURVEY_BAND_HEIGHT_M = 40;
/** At most this many bands per face: the per-building image budget (MAX_STREET_VIEW_IMAGES_PER_BUILDING) is shared
 *  across every face and band, so a very tall building still gets height coverage on every heading rather than
 *  exhausting the budget on one. */
export const MAX_SURVEY_BANDS_PER_FACE = 4;

/** The vertical bands a face of `heightM` splits into: 1 for an ordinary building, up to MAX_SURVEY_BANDS_PER_FACE for a supertall. */
export function surveyBandsFor(heightM: number): number {
    return Math.max(1, Math.min(MAX_SURVEY_BANDS_PER_FACE, Math.ceil(heightM / SURVEY_BAND_HEIGHT_M)));
}

/** The compass faces of the footprint: one per facade heading the structure pick found (at most four), each split into
 *  height bands when the structure is tall enough that one shot could not resolve it top to bottom. */
export function footprintSurveyFaces(structure: Pick<StructurePickResult, 'outline' | 'centroid' | 'facadeHeadingsDeg' | 'groundY' | 'heightM'>): SurveyFaceTarget[] {
    const bands = surveyBandsFor(structure.heightM);
    const bandHeightM = structure.heightM / bands;
    return facadeGeometry(structure).slice(0, MAX_SURVEY_FACES).flatMap(f => {
        const dir: Vec3 = [Math.sin(f.headingDeg * DEG), 0, -Math.cos(f.headingDeg * DEG)];
        return Array.from({ length: bands }, (_, b) => ({
            faceId: bands > 1 ? `h${Math.round(f.headingDeg)}_b${b}` : `h${Math.round(f.headingDeg)}`,
            headingDeg: f.headingDeg, source: 'footprint' as const,
            centre: [f.centre[0], structure.groundY + bandHeightM * (b + 0.5), f.centre[1]] as Vec3,
            outward: dir, widthM: f.widthM, heightM: bandHeightM
        }));
    });
}

/**
 * The faces of an accepted fit: its near-vertical planar surfaces grouped by outward heading (35° apart is a different
 * face), the largest of each group standing for it, at most four groups. Fewer than two groups: the footprint's faces.
 */
export function fitSurveyFaces(fit: Pick<StructureFit, 'surfaces'>, structure: Pick<StructurePickResult, 'outline' | 'centroid' | 'facadeHeadingsDeg' | 'groundY' | 'heightM'>): SurveyFaceTarget[] {
    const verticals: Array<{ s: FittedSurface; heading: number; out: Vec3 }> = [];
    for (const s of fit.surfaces) {
        if (!('plane' in s.chart)) continue;
        const n = unit(s.chart.plane.normal);
        if (Math.abs(n[1]) > 0.3) continue;
        const h: Vec3 = unit([n[0], 0, n[2]]);
        verticals.push({ s, heading: ((Math.atan2(h[0], -h[2]) / DEG) + 360) % 360, out: h });
    }
    verticals.sort((a, b) => b.s.areaM2 - a.s.areaM2);
    const groups: typeof verticals = [];
    for (const v of verticals) if (groups.length < MAX_SURVEY_FACES && groups.every(g => angleBetween(g.heading, v.heading) > 35)) groups.push(v);
    if (groups.length < 2) return footprintSurveyFaces(structure);
    return groups.sort((a, b) => a.heading - b.heading).map(g => {
        const ext = (g.s.chart as { plane: { extentUv: Array<[number, number]> } }).plane.extentUv;
        const us = ext.map(p => p[0]), vs = ext.map(p => p[1]);
        const u = (Math.min(...us) + Math.max(...us)) / 2, v = (Math.min(...vs) + Math.max(...vs)) / 2;
        const c = chartPoint(g.s.chart, u, v);
        return {
            faceId: g.s.id, headingDeg: Math.round(g.heading * 10) / 10, source: 'fit' as const, centre: c, outward: chartNormal(g.s.chart, u),
            widthM: Math.max(1, Math.max(...us) - Math.min(...us)), heightM: Math.max(1, Math.max(...vs) - Math.min(...vs))
        };
    });
}

export function surveyFaceTargets(structure: Pick<StructurePickResult, 'outline' | 'centroid' | 'facadeHeadingsDeg' | 'groundY' | 'heightM'>, fit?: Pick<StructureFit, 'surfaces'>): SurveyFaceTarget[] {
    return fit ? fitSurveyFaces(fit, structure) : footprintSurveyFaces(structure);
}

// ----------------------------------------------------------------------------------------------------------------
// the panos
// ----------------------------------------------------------------------------------------------------------------

export interface SurveyView extends SelectedView { faceId: string }
export interface SurveyPlan { views: SurveyView[]; skipped: Array<{ faceId: string; headingDeg: number; reason: string }> }

/** The share of five points along the face's mid-height an eye sees over the surface model. */
function faceSeen(eye: Vec3, face: SurveyFaceTarget, structure: Pick<StructurePickResult, 'cells'>, ground: Pick<GroundModel, 'cellIndex'>, top: Float32Array): number {
    const t: Vec3 = [-face.outward[2], 0, face.outward[0]];
    let seen = 0;
    for (let i = 0; i < 5; i++) {
        const along = (i / 4 - 0.5) * face.widthM * 0.8;
        const p: Vec3 = [face.centre[0] + t[0] * along + face.outward[0] * 0.3, face.centre[1], face.centre[2] + t[2] * along + face.outward[2] * 0.3];
        if (!pointHidden(eye, p, structure, ground, top)) seen++;
    }
    return seen / 5;
}

/** The aim that frames a whole face from `eye`: heading to its middle, elevation to its vertical middle, fov 55-70°, 4:3. */
export function surveyAim(eye: Vec3, face: SurveyFaceTarget): { headingDeg: number; elevationDeg: number; fovDeg: number; distanceM: number } {
    const d = Math.hypot(face.centre[0] - eye[0], face.centre[2] - eye[2]);
    const headingDeg = bearingDeg(eye[0], eye[2], face.centre[0], face.centre[2]);
    const elevationDeg = Math.max(-20, Math.min(55, Math.atan2(face.centre[1] - eye[1], Math.max(0.1, d)) / DEG));
    // the survey asks for 4:3 crops of the 1920 px grounding frame: the fov to request so that the crop itself spans the face,
    // in both width and height (a band's heightM is its own slice now, not the whole structure: a tall, narrow band needs its
    // height considered too, not just its width)
    const dist = Math.max(1, d);
    const needW = groundingRequestFovDeg(2 * Math.atan((face.widthM / 2) * 1.12 / dist) / DEG, 4 / 3);
    const needH = groundingRequestFovDeg(2 * Math.atan((face.heightM / 2) * 1.12 / dist) / DEG, 4 / 3);
    const need = Math.max(needW, needH);
    return {
        headingDeg: Math.round(headingDeg * 10) / 10, elevationDeg: Math.round(elevationDeg * 10) / 10,
        fovDeg: Math.round(Math.max(SURVEY_FOV_MIN_DEG, Math.min(SURVEY_FOV_MAX_DEG, need)) * 10) / 10,
        distanceM: Math.round(Math.hypot(d, face.centre[1] - eye[1]) * 100) / 100
    };
}

export interface SurveyCandidate { pano: PanoCandidate; eye: Vec3; score: number; bearing: number }

/** Every pano that can look at each face from its outward side (within SURVEY_MAX_OFF_NORMAL_DEG of the normal, MIN-MAX view distance, the face at least 30% seen), best first. */
export function surveyCandidates(
    panos: PanoCandidate[],
    faces: SurveyFaceTarget[],
    structure: Pick<StructurePickResult, 'cells' | 'groundY' | 'centroid'>,
    ground: Pick<GroundModel, 'cellIndex' | 'groundAt'>,
    top: Float32Array
): Map<string, SurveyCandidate[]> {
    const newest = Math.max(-Infinity, ...panos.map(p => months(p.date)));
    const candidates = new Map<string, SurveyCandidate[]>();
    for (const face of faces) {
        const list: SurveyCandidate[] = [];
        for (const p of panos) {
            const g = ground.groundAt(p.x, p.z);
            const eye: Vec3 = [p.x, (g === g ? g : structure.groundY) + STREET_VIEW_EYE_HEIGHT_M, p.z];
            const toEye = unit(sub(eye, face.centre));
            const flat = unit([toEye[0], 0, toEye[2]]);
            const cosOff = dot(flat, face.outward);
            const d = Math.hypot(face.centre[0] - eye[0], face.centre[2] - eye[2]);
            if (cosOff < Math.cos(SURVEY_MAX_OFF_NORMAL_DEG * DEG) || d < MIN_VIEW_DISTANCE_M || d > MAX_VIEW_DISTANCE_M) continue;
            const seen = faceSeen(eye, face, structure, ground, top);
            if (seen < SURVEY_MIN_FACE_SEEN) continue;
            const recency = Number.isFinite(newest) && Number.isFinite(months(p.date)) ? Math.max(0.5, 1 - (newest - months(p.date)) / 72) : 0.75;
            // the distance that frames the face at the widest fov, and a little more: nearer crops it, farther loses pixels
            const ideal = (face.widthM / 2) * 1.12 / Math.tan((SURVEY_FOV_MAX_DEG / 2) * DEG);
            const distFit = d < ideal ? 0.6 + 0.4 * (d / ideal) : 1 / (1 + Math.max(0, d / ideal - 1.8));
            list.push({ pano: p, eye, score: seen * cosOff * recency * distFit, bearing: bearingDeg(structure.centroid.x, structure.centroid.z, p.x, p.z) });
        }
        candidates.set(face.faceId, list.sort((a, b) => b.score - a.score || a.pano.panoId.localeCompare(b.pano.panoId)));
    }
    return candidates;
}

/** The wide view of `face` from candidate `pick`. */
export function surveyViewFor(face: SurveyFaceTarget, pick: SurveyCandidate): SurveyView {
    const aim = surveyAim(pick.eye, face);
    return {
        faceId: face.faceId, panoId: pick.pano.panoId, date: pick.pano.date, copyright: pick.pano.copyright, eye: pick.eye, facadeHeadingDeg: Math.round(face.headingDeg),
        headingDeg: aim.headingDeg, pitchDeg: aim.elevationDeg, fovDeg: aim.fovDeg, aspectRatio: 'RATIO_4X3', distanceM: aim.distanceM,
        score: Math.round(pick.score * 1000) / 1000, aimedSlotIds: [], coveredSlotIds: []
    };
}

/**
 * One pano per face, each looking at its face from the outward side, all different, at different bearings from the
 * structure where the candidates allow. A face no pano sees is skipped, with the reason. The faces with the fewest
 * candidates choose first, so a face with one possible pano gets it. MAX_SURVEY_FACES caps the faces because each Street
 * View image costs a call; `rendered` lifts that cap for cameras that are free renders of the tile (pipeline G's
 * stations), leaving only `max`. `opts.bandedCeiling` is the other deliberate way to spend more real Street View calls:
 * a supertall's faces come back from footprintSurveyFaces split into several height bands each (still real, costed
 * images, just more of them so every band gets a look), and the caller passes its own considered ceiling here rather
 * than the ordinary per-building default.
 */
export function selectSurveyViews(
    panos: PanoCandidate[],
    faces: SurveyFaceTarget[],
    structure: Pick<StructurePickResult, 'cells' | 'groundY' | 'centroid'>,
    ground: Pick<GroundModel, 'cellIndex' | 'groundAt'>,
    top: Float32Array,
    max = MAX_SURVEY_FACES,
    opts: { rendered?: boolean; bandedCeiling?: number } = {}
): SurveyPlan {
    const limit = Math.max(0, opts.rendered ? max : Math.min(opts.bandedCeiling ?? MAX_SURVEY_FACES, max));
    const candidates = surveyCandidates(panos, faces, structure, ground, top);
    const order = [...faces].sort((a, b) => candidates.get(a.faceId)!.length - candidates.get(b.faceId)!.length || a.headingDeg - b.headingDeg);
    const used = new Set<string>();
    const bearings: number[] = [];
    const chosen = new Map<string, SurveyView>();
    const skipped: SurveyPlan['skipped'] = [];
    for (const face of order) {
        const list = candidates.get(face.faceId)!;
        if (chosen.size >= limit) { skipped.push({ faceId: face.faceId, headingDeg: face.headingDeg, reason: `the image budget of ${limit} is spent` }); continue; }
        const free = list.filter(c => !used.has(c.pano.panoId));
        if (!list.length) { skipped.push({ faceId: face.faceId, headingDeg: face.headingDeg, reason: `no Google panorama looks at the ${Math.round(face.headingDeg)}° face from its outward side` }); continue; }
        if (!free.length) { skipped.push({ faceId: face.faceId, headingDeg: face.headingDeg, reason: 'its only panoramas serve other faces' }); continue; }
        // prefer a pano whose bearing differs from those already chosen; fall back to the best free one
        const apart = free.filter(c => bearings.every(b => angleBetween(b, c.bearing) >= SURVEY_MIN_BEARING_SEPARATION_DEG));
        const pick = (apart.length ? apart : free)[0];
        used.add(pick.pano.panoId); bearings.push(pick.bearing);
        chosen.set(face.faceId, surveyViewFor(face, pick));
    }
    return { views: faces.map(f => chosen.get(f.faceId)).filter((v): v is SurveyView => !!v), skipped: skipped.sort((a, b) => a.headingDeg - b.headingDeg) };
}

// ----------------------------------------------------------------------------------------------------------------
// the vision call
// ----------------------------------------------------------------------------------------------------------------

/** The survey prompt text around the images. Open vocabulary: no list of kinds, materials or styles anywhere in it. */
export function surveyPrompt(images: Array<{ index: number; face: SurveyFaceTarget; view: SurveyView; widthPx: number; heightPx: number }>): { preamble: string; closing: string; captions: string[] } {
    const preamble = `You are surveying one real structure from ${images.length} Google Street View photograph${images.length === 1 ? '' : 's'}, one wide view of each face, taken from outside. Make an inventory of what each face carries, so that it can be built later as detail on a clay model and given materials. Everything you report is labelled "photo-inferred".`;
    const captions = images.map(i => `[${i.index}] Google Street View image (© Google, ${i.view.date ?? 'date unknown'}) of the face whose outward direction is ${Math.round(i.face.headingDeg)}° (clockwise from north), looking ${Math.round(i.view.headingDeg)}° from about ${Math.round(i.view.distanceM)} m, field of view ${Math.round(i.view.fovDeg)}°, ${i.widthPx} × ${i.heightPx} px.`);
    const rules = [
        '1. For each image list the architectural elements you can see ON THE STRUCTURE: everything with its own form, such as a repeated row, a band, a panel, an opening, a molding, a carved or relief piece, a figure, lettering. "kind" is your own plain word or words for what it is; there is no list to choose from.',
        '2. "box" is [y0, x0, y1, x1] in 0..1000 of that image (y down), tight around the element. A row or lattice that repeats is ONE element whose box covers the whole row, with "repeat": count what you can see, and give the pitch as a fraction of the structure\'s visible width (axis "h") or height (axis "v") in that image; for a lattice give axis "grid".',
        '3. "sizeRatio" is [width, height] of ONE element (of one unit, for a repeat) as a fraction of the structure\'s visible width and height in that image.',
        '4. "material" says what it is made of and how it is finished, in words; "weathering" says what age, staining or wear shows. Do not give colour codes: colours are measured from the pixels separately. A colour named in words inside the material is fine.',
        '5. "confidence" is 0..100: how sure you are that the element is there and what it is.',
        '6. "materials" lists the distinct materials of that image\'s structure (at most 5), each with a short "where".',
        '7. Not elements: sky, trees and plants, people, vehicles, signs on poles, scaffolding, shadows, reflections, things standing in front of the structure. Do not name the structure and do not add anything you know about it but cannot see in these images.',
        '8. At most 25 elements per image, the most conspicuous first. If a face is hardly visible, say so with an empty list.'
    ];
    const schema = JSON.stringify(schemaClosure('FaceSurveyReply'));
    const closing = `Rules:\n${rules.join('\n')}\n\nReply with JSON only, matching this schema, one entry in "faces" per image, "image" being the image's index: ${schema}`;
    return { preamble, closing, captions };
}

export interface SurveyImage { index: number; face: SurveyFaceTarget; view: SurveyView; widthPx: number; heightPx: number; bytes: Buffer; mimeType: string; sha256: string; id: string; fetchMs: number }

export function surveyContents(images: SurveyImage[]): Content[] {
    const { preamble, closing, captions } = surveyPrompt(images);
    const parts: Part[] = [{ text: preamble }];
    images.forEach((im, k) => {
        parts.push({ inlineData: { mimeType: im.mimeType, data: im.bytes.toString('base64') } });
        parts.push({ text: captions[k] });
    });
    parts.push({ text: closing });
    return [{ role: 'user', parts }];
}

export interface ParsedSurvey { faces: Map<number, { elements: SurveyElement[]; materials: SurveyMaterial[] }>; problems: string[] }

/**
 * Parses and validates the reply. A reply that is not JSON, or has no `faces` array, is an error (one call is all the
 * pass spends, so there is no revision). Inside a valid shell, an element or material that breaks the contract is
 * dropped and counted, so one bad entry does not cost the other faces their inventory.
 */
export function parseSurveyReply(text: string, finishReason: string | undefined, imageCount: number): ParsedSurvey {
    const problems: string[] = [];
    if (finishReason && finishReason !== 'STOP') throw new Error(finishReason === 'MAX_TOKENS' ? 'the reply was cut off (MAX_TOKENS)' : `the reply ended with ${finishReason}, not STOP`);
    let value: any;
    try { value = JSON.parse(text.trim()); } catch (err) { throw new Error(`the reply is not valid JSON (${(err as Error).message})`); }
    if (!value || !Array.isArray(value.faces)) throw new Error('the reply has no "faces" list');
    const faces = new Map<number, { elements: SurveyElement[]; materials: SurveyMaterial[] }>();
    for (const f of value.faces) {
        if (!f || !Number.isInteger(f.image) || f.image < 0 || f.image >= imageCount) { problems.push(`a face entry names image ${f?.image}, which is not one of the ${imageCount} images`); continue; }
        if (faces.has(f.image)) { problems.push(`image ${f.image} appears twice; the first is kept`); continue; }
        const elements: SurveyElement[] = [];
        for (const e of Array.isArray(f.elements) ? f.elements : []) {
            const issues = validateContract('surveyElement', e);
            const box = e?.box;
            if (!issues.length && !(box[0] < box[2] && box[1] < box[3])) issues.push('box is not well-formed (y0 < y1 and x0 < x1)');
            if (issues.length) problems.push(`image ${f.image}: dropped an element (${issues[0]})`);
            else elements.push(e as SurveyElement);
        }
        const materials: SurveyMaterial[] = [];
        for (const m of Array.isArray(f.materials) ? f.materials : []) {
            const issues = validateContract('surveyMaterial', m);
            if (issues.length) problems.push(`image ${f.image}: dropped a material (${issues[0]})`); else materials.push(m as SurveyMaterial);
        }
        faces.set(f.image, { elements, materials });
    }
    return { faces, problems };
}

function responseText(r: { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> }): string {
    return (r.candidates?.[0]?.content?.parts ?? []).filter(p => !p.thought).map(p => p.text ?? '').join('');
}

// ----------------------------------------------------------------------------------------------------------------
// the stage
// ----------------------------------------------------------------------------------------------------------------

/** The survey's decoded-free image bytes, held in memory for the matching call only (never serialised with the result). */
const SURVEY_IMAGES = new WeakMap<object, Map<number, Buffer>>();
export function surveyImageBytes(result: object, imageIndex: number): Buffer | undefined { return SURVEY_IMAGES.get(result)?.get(imageIndex); }

export interface SurveyResult {
    plan: SurveyPlan;
    /** Every face, surveyed or skipped, with its measured palette. */
    faces: SurveyedFace[];
    /** The views whose images were read: pano, pose and size, for the detail pass's camera model. No bytes. */
    read: Array<{ view: SurveyView; widthPx: number; heightPx: number; imageIndex: number; sha256: string }>;
    hints: MaterialHints;
    model: VisionModelUse;
    cost: StageCost;
    problems: string[];
    fetchFailures: Array<{ faceId: string; error: string }>;
    /**
     * The grounding API's refusals ("Pano is not published or eligible"): the face, the pano refused, why, and the next
     * eligible pano asked instead (absent when the face had no other candidate). Recorded, never silently dropped.
     */
    refusals: Array<{ faceId: string; panoId: string; error: string; replacedBy?: string }>;
}

/** Rounds of asking the next candidate pano for a face whose pano the grounding API refused. */
export const SURVEY_REFUSAL_RETRIES = 3;

export interface RunSurveyInput {
    faces: SurveyFaceTarget[];
    panos: PanoCandidate[];
    structure: Pick<StructurePickResult, 'cells' | 'groundY' | 'centroid'>;
    ground: Pick<GroundModel, 'cellIndex' | 'groundAt'>;
    top: Float32Array;
    deps: StreetViewEvidenceDeps;
    chain: VisionModelChain<string>;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
    now?: () => number;
    /** Called once the survey images are in hand, before they are read (the caller may fetch what it will want next). */
    onFetched?: (read: SurveyResult['read']) => void;
    /**
     * The image budget selectSurveyViews works to when the faces carry more than one band per heading (a tall
     * structure's footprintSurveyFaces splits each heading into several, so one shot per heading would silently
     * starve a supertall's bands of everything past the first). Bounded by the caller to MAX_STREET_VIEW_IMAGES_PER_BUILDING,
     * the whole build's shared real-image budget. Left unset, an ordinary one-band-per-heading survey behaves exactly
     * as before (selectSurveyViews' own MAX_SURVEY_FACES default).
     */
    bandedCeiling?: number;
}

/** Fetch the faces in parallel, read each in its own call (in parallel), measure their colours. A face whose call fails is left out with why; throws VisionStageError when no call gives anything usable. */
export async function runFaceSurvey(input: RunSurveyInput): Promise<SurveyResult> {
    const now = input.now ?? Date.now;
    const started = now();
    // panos the grounding API already refused (this run or recently) are never asked for
    const refusedBefore = knownRefusals(input.deps);
    const panos = input.panos.filter(p => !refusedBefore.has(p.panoId));
    const plan = selectSurveyViews(panos, input.faces, input.structure, input.ground, input.top, input.bandedCeiling ?? MAX_SURVEY_FACES, input.bandedCeiling ? { bandedCeiling: input.bandedCeiling } : {});
    const faceOf = new Map(input.faces.map(f => [f.faceId, f]));
    const faceRecords = (): SurveyedFace[] => input.faces.map(f => {
        const skip = plan.skipped.find(s => s.faceId === f.faceId);
        return {
            faceId: f.faceId, headingDeg: f.headingDeg, source: f.source, elements: [], materials: [],
            centreY: f.centre[1], heightM: f.heightM, ...(skip ? { skipped: skip.reason } : {})
        };
    });
    const emptyModel = (error: string): VisionModelUse => visionUse(input.chain, 'failed', { error }, STAGED_VISION_MODEL_DEFAULT.selection);
    if (!plan.views.length) {
        throw new VisionStageError('no Google Street View panorama looks at any face of the structure', emptyModel('no panorama'), false, 'no_street_view');
    }
    input.onProgress?.(`requesting ${plan.views.length} wide view${plan.views.length === 1 ? '' : 's'} of the structure's faces in parallel`);
    const fetched = await fetchViews(plan.views, input.deps, input.signal, SURVEY_IMAGE_TIMEOUT_MS);
    // a pano the grounding API refuses is replaced by the face's next eligible candidate (a different pano, not one
    // another face uses), up to SURVEY_REFUSAL_RETRIES rounds; every refusal is recorded
    const got: EvidenceImage[] = [...fetched.images];
    const notFetched: typeof fetched.failures = [];
    const refusals: SurveyResult['refusals'] = [];
    let pending = fetched.failures;
    const candidates = surveyCandidates(panos, input.faces, input.structure, input.ground, input.top);
    for (let round = 0; round < SURVEY_REFUSAL_RETRIES && pending.length; round++) {
        if (input.signal?.aborted) break;
        notFetched.push(...pending.filter(f => !f.refused));
        const used = new Set(plan.views.map(v => v.panoId));
        const retry: SurveyView[] = [];
        for (const f of pending.filter(x => x.refused)) {
            const faceId = (f.view as SurveyView).faceId;
            const face = faceOf.get(faceId)!;
            const next = (candidates.get(faceId) ?? []).find(c => !used.has(c.pano.panoId) && !input.deps.refusedPanos?.has(c.pano.panoId) && !refusedBefore.has(c.pano.panoId));
            refusals.push({ faceId, panoId: f.view.panoId, error: f.error, ...(next ? { replacedBy: next.pano.panoId } : {}) });
            if (!next) { notFetched.push(f); continue; }
            used.add(next.pano.panoId);
            const view = surveyViewFor(face, next);
            plan.views = plan.views.map(v => (v.faceId === faceId ? view : v));
            retry.push(view);
        }
        pending = [];
        if (!retry.length) break;
        input.onProgress?.(`the grounding API refused ${retry.length} pano${retry.length === 1 ? '' : 's'}; asking the next eligible one for ${retry.length === 1 ? 'that face' : 'those faces'}`);
        const again = await fetchViews(retry, input.deps, input.signal, SURVEY_IMAGE_TIMEOUT_MS);
        got.push(...again.images);
        pending = again.failures;
    }
    notFetched.push(...pending);
    const images: SurveyImage[] = got.map((im: EvidenceImage, k) => ({
        index: k, face: faceOf.get((im.view as SurveyView).faceId)!, view: im.view as SurveyView, widthPx: im.widthPx, heightPx: im.heightPx, bytes: im.bytes, mimeType: im.mimeType, sha256: im.sha256, id: im.id, fetchMs: im.fetchMs
    }));
    const fetchFailures = notFetched.map(f => ({ faceId: (f.view as SurveyView).faceId, error: f.error }));
    if (images.length) input.onFetched?.(images.map(im => ({ view: im.view, widthPx: im.widthPx, heightPx: im.heightPx, imageIndex: im.index, sha256: im.sha256 })));
    if (!images.length) {
        throw new VisionStageError(`every survey image failed to fetch (${fetchFailures.map(f => f.error).slice(0, 2).join('; ')})`, emptyModel('no image'), true, 'no_street_view');
    }

    // one call per face, all at once: each sends one image capped at SURVEY_SEND_MAX_SIDE_PX (the boxes are in 0..1000 of the
    // image, so the size sent does not change them); the full image stays in hand for the palette and the registration
    input.onProgress?.(`reading ${images.length} face${images.length === 1 ? '' : 's'} with ${input.chain.current}, one call each in parallel`);
    const timeoutMs = SURVEY_VISION_TIMEOUT_MS;
    let usage: { promptTokens?: number; outputTokens?: number; thinkingTokens?: number; finishReason?: string } = {};
    const parsed: ParsedSurvey = { faces: new Map(), problems: [] };
    const readFace = async (im: SurveyImage): Promise<{ error?: Error; transient?: boolean; invalid?: boolean }> => {
        const own = new AbortController();
        let timer: CallTimer | undefined;
        const signal = input.signal ? AbortSignal.any([input.signal, own.signal]) : own.signal;
        try {
            const sent = await capImageSide(im.bytes, im.mimeType, im.widthPx, im.heightPx, SURVEY_SEND_MAX_SIDE_PX);
            // the limit starts as the request is sent (not while the image is prepared), in time this thread can read the reply
            timer = callTimeout(() => own.abort(Object.assign(new Error(`the vision call took longer than ${Math.round(timeoutMs / 1000)} s`), { name: 'TimeoutError' })), timeoutMs);
            const r = await input.chain.generate({
                contents: surveyContents([{ ...im, index: 0, bytes: sent.bytes, mimeType: sent.mimeType, widthPx: sent.widthPx, heightPx: sent.heightPx }]),
                config: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: ORNAMENT_MAX_OUTPUT_TOKENS, abortSignal: signal }
            }, {
                stage: 'survey', thinkingBudget: ORNAMENT_THINKING_BUDGET, stream: true,
                onFirstToken: ms => input.onProgress?.(`surveying the ${Math.round(im.face.headingDeg)}° face (first token after ${(ms / 1000).toFixed(1)} s)`)
            });
            const u = r.response.usageMetadata;
            const finishReason = r.response.candidates?.[0]?.finishReason as string | undefined;
            const one = parseSurveyReply(responseText(r.response), finishReason, 1);
            r.remember();
            usage = {
                promptTokens: (usage.promptTokens ?? 0) + (u?.promptTokenCount ?? 0), outputTokens: (usage.outputTokens ?? 0) + (u?.candidatesTokenCount ?? 0),
                thinkingTokens: (usage.thinkingTokens ?? 0) + (u?.thoughtsTokenCount ?? 0), ...(finishReason ? { finishReason } : {})
            };
            const answer = one.faces.get(0);
            if (answer) parsed.faces.set(im.index, answer);
            parsed.problems.push(...one.problems.map(p => `image ${im.index}: ${p.replace(/^image 0: /, '')}`));
            return {};
        } catch (err) {
            if (input.signal?.aborted) throw err;
            const timedOut = own.signal.aborted;
            const message = timedOut ? `the vision call took longer than ${Math.round(timeoutMs / 1000)} s` : (err as Error).message;
            return { error: new Error(message), transient: timedOut || /transient|quota|429|5\d\d|network|fetch failed|None of the chat's models is served/.test(message), invalid: /valid JSON|no "faces"|cut off|ended with/.test(message) };
        } finally {
            timer?.clear();
        }
    };
    const outcomes = await Promise.all(images.map(readFace));
    if (input.signal?.aborted) throw input.signal.reason;
    const failed = outcomes.flatMap((o, k) => (o.error ? [{ im: images[k], ...o }] : []));
    if (failed.length === images.length) {
        const f = failed[0];
        throw new VisionStageError(f.error!.message, visionUse(input.chain, 'failed', { ...usage, error: f.error!.message }), !!f.transient, f.invalid ? 'vision_invalid_reply' : 'vision_unavailable');
    }
    const thinking = input.chain.attempts.length ? input.chain.attempts[input.chain.attempts.length - 1].thinking : undefined;
    const model = visionUse(input.chain, 'answered', { ...usage, ...(thinking ? { thinking } : {}) });

    // the colours: measured from the decoded pixels inside the surveyed elements (the whole frame for a face with none)
    const faces = faceRecords();
    const read: SurveyResult['read'] = [];
    const unread = new Map(failed.map(f => [f.im.index, f]));
    for (const im of images) {
        const rec = faces.find(f => f.faceId === im.face.faceId)!;
        const lost = unread.get(im.index);
        if (lost) {
            rec.panoId = im.view.panoId;
            rec.skipped = `its reading failed (${lost.error!.message})`;
            parsed.problems.push(`image ${im.index}: no reading (${lost.error!.message})`);
            continue;
        }
        const answer = parsed.faces.get(im.index);
        rec.panoId = im.view.panoId;
        if (im.view.date) rec.captureDate = im.view.date;
        rec.elements = answer?.elements ?? [];
        rec.materials = answer?.materials ?? [];
        try {
            rec.palette = measurePalette(decodeJpegInMemory(im.bytes), rec.elements.length ? { regions1000: rec.elements.map(e => e.box) } : {});
        } catch (err) {
            parsed.problems.push(`image ${im.index}: no palette (${(err as Error).message})`);
        }
        read.push({ view: im.view, widthPx: im.widthPx, heightPx: im.heightPx, imageIndex: im.index, sha256: im.sha256 });
    }
    for (const f of fetchFailures) {
        const rec = faces.find(x => x.faceId === f.faceId);
        const tried = refusals.filter(r => r.faceId === f.faceId);
        if (rec) rec.skipped = `its image did not arrive (${f.error})${tried.length ? `; the grounding API refused ${tried.map(r => r.panoId).join(', ')}${tried.some(r => !r.replacedBy) ? ' and no other eligible pano looks at this face' : ''}` : ''}`;
    }
    const cost: StageCost = { images: images.length, visionCalls: images.length, seconds: Math.round(((now() - started) / 1000) * 10) / 10 };
    const hints: MaterialHints = {
        schema: 'scratchbox.material-hints/1', label: 'photo-inferred', palette: 'measured-from-photo',
        textureUse: 'none: the Street View pixels are not projected onto the model', faces, model, cost
    };
    const out: SurveyResult = { plan, faces, read, hints, model, cost, problems: parsed.problems, fetchFailures, refusals };
    SURVEY_IMAGES.set(out, new Map(images.map(im => [im.index, im.bytes])));
    return out;
}

/** One sentence of what the survey found, for the overlay's source line. */
export function describeSurvey(r: Pick<SurveyResult, 'faces' | 'cost' | 'model'> & { refusals?: SurveyResult['refusals'] }): string {
    const surveyed = r.faces.filter(f => !f.skipped);
    const elements = surveyed.reduce((n, f) => n + f.elements.length, 0);
    const colours = surveyed.reduce((n, f) => n + (f.palette?.colours.length ?? 0), 0);
    const skipped = r.faces.length - surveyed.length;
    const refused = r.refusals ?? [];
    const replaced = refused.filter(x => x.replacedBy).length;
    const refusedText = refused.length ? `; the grounding API refused ${refused.length} pano${refused.length === 1 ? '' : 's'} (${refused.map(x => x.panoId).join(', ')})${replaced ? `, ${replaced} replaced by the face's next eligible pano` : ''}` : '';
    return `${surveyed.length} of ${r.faces.length} faces surveyed in ${r.cost.seconds.toFixed(1)} s (${r.cost.images} images, ${r.cost.visionCalls} vision call${r.cost.visionCalls === 1 ? '' : 's'} by ${r.model.used}): ${elements} photo-inferred elements, ${colours} colours measured from the photos${skipped ? `, ${skipped} face${skipped === 1 ? '' : 's'} without a view` : ''}${refusedText}`;
}
