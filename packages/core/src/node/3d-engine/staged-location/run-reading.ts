/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The targeted second pass for runs and bands.
 *
 * The survey inventories what it sees, in its own words. Whatever it found that is a REPEATING RUN (it carries a repeat count) or a
 * BAND (long and thin on the face, or running along a fitted edge) is read again on its own: one narrow crop aimed at the located
 * element from the best one or two panos (their registered poses), one slot (the exterior face or edge the element lies on, found by
 * casting, offered only when the crop shows it), one small prompt. The reading is measured against the fitted edge: count × pitch must
 * fit the run (ornament-anchor.ts), and it is built through the same operators and the same native builder as every other element.
 *
 * Nothing here knows what an element is called: a target is chosen by its repeat and its proportions, and the survey's own word for it is
 * only passed on as text.
 */

import type { RenderMesh3D } from '../../spatial/HeadlessMeshSilhouetteRenderer';
import type { VisionModelChain } from '../../gemini/vision-model-chain';
import {
    type EvidenceImageRef, type OrnamentElement, type OrnamentSpec, type StructureFit, type Vec3
} from '../../../common/spatial/staged-location-contracts';
import { chartNormal } from './slot-projection';
import { projectSlots, registeredPose, nominalPose } from './slot-projection';
import { computeSlotOffer, MIN_SHOWN_FRACTION, readFittedShells, type FittedShells, type SlotOffer } from './slot-exposure';
import { bearingDeg, fetchViews, STREET_VIEW_EYE_HEIGHT_M, type EvidenceImage, type PanoCandidate, type SelectedView, type StreetViewEvidenceDeps } from './streetview-evidence';
import type { GroundingAspectRatio } from '../../spatial/StreetViewGroundingImageService';
import { bbox, footprint, readOrnament, streetViewCaption, VisionStageError, type EvidenceInput } from './ornament-vision';
import type { AnchorNote } from './ornament-anchor';
import type { LocatedElement } from './survey-detail';
import type { Registration } from './pano-registration';

const DEG = Math.PI / 180;
/** A crop of a run is as narrow as the run allows: 14-45 degrees of horizontal field. */
export const RUN_FOV_MIN_DEG = 14;
export const RUN_FOV_MAX_DEG = 45;
export const MAX_RUN_TARGETS = 12;
export const VIEWS_PER_RUN = 2;
/** An element at least this many times longer than it is tall (or the reverse) on its face is a band. */
export const BAND_ASPECT = 4;
export const MIN_RUN_VIEW_DISTANCE_M = 6;
export const MAX_RUN_VIEW_DISTANCE_M = 70;
/** A view whose line of sight meets the face more obliquely than this (cosine of the angle to the normal) is not used. */
export const MIN_FACE_COSINE = 0.35;
export const RUN_READ_TIMEOUT_MS = 150_000;
/** The whole pass, the crop fetches included, is given at most this long (the caller passes less when its stage has less left): a reading still out when it ends is left as the wide reading had it. */
export const RUN_PASS_BUDGET_MS = 300_000;
const ASPECTS: Array<{ name: GroundingAspectRatio; ratio: number }> = [
    { name: 'RATIO_1X1', ratio: 1 }, { name: 'RATIO_4X3', ratio: 4 / 3 }, { name: 'RATIO_3X4', ratio: 3 / 4 }, { name: 'RATIO_16X9', ratio: 16 / 9 }
];

export interface RunTarget {
    id: string;
    located: LocatedElement;
    slotId: string;
    /** Why it is a target: its repeat, its proportions, or the run it covers along a fitted edge. */
    because: string;
}

export interface RunSkip { id: string; kind: string; slotId?: string; reason: string }

/** The survey's elements that are repeating runs or bands, one target each (overlapping runs on one slot keep the most confident). */
export function selectRunTargets(located: LocatedElement[], max = MAX_RUN_TARGETS): RunTarget[] {
    const cands: Array<RunTarget & { score: number }> = [];
    for (const l of located) {
        const w = Math.max(l.widthM, 0.01), h = Math.max(l.heightM, 0.01);
        const aspect = Math.max(w / h, h / w);
        const runLen = l.runAlongM ? l.runAlongM[1] - l.runAlongM[0] : 0;
        let because = '';
        if (l.repeat) because = `a repeating run of about ${l.repeat.count}`;
        else if (aspect >= BAND_ASPECT) because = `a band (${w.toFixed(1)} × ${h.toFixed(1)} m on the face)`;
        else if (runLen >= 2) because = `a run of ${runLen.toFixed(1)} m along a fitted edge`;
        if (!because) continue;
        cands.push({ id: l.id, located: l, slotId: l.slotId, because, score: (l.confidence / 100) * Math.max(0.2, runLen || Math.max(w, h)) * (l.repeat ? 1.5 : 1) });
    }
    cands.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const kept: RunTarget[] = [];
    for (const c of cands) {
        // the same run seen twice (two survey views, or one box split in two): the more confident one stands
        const overlaps = kept.some(k => k.slotId === c.slotId && overlap1d(k.located, c.located) >= 0.5);
        if (overlaps) continue;
        kept.push({ id: c.id, located: c.located, slotId: c.slotId, because: c.because });
        if (kept.length >= max) break;
    }
    return kept;
}

function overlap1d(a: LocatedElement, b: LocatedElement): number {
    const ra = a.runAlongM ?? [a.regionUv.u0, a.regionUv.u1], rb = b.runAlongM ?? [b.regionUv.u0, b.regionUv.u1];
    const lo = Math.max(ra[0], rb[0]), hi = Math.min(ra[1], rb[1]);
    const shorter = Math.max(1e-6, Math.min(ra[1] - ra[0], rb[1] - rb[0]));
    return Math.max(0, hi - lo) / shorter;
}

export interface PlannedRunView { view: SelectedView; visibleFraction: number; registered: boolean; score: number }

/** The best views of a run's slot: from the registered poses of the panos around, aimed at the located element, narrow, and showing the slot unoccluded. */
export function planRunViews(
    target: RunTarget,
    panos: Array<{ panoId: string; date?: string; copyright?: string; eye: Vec3 }>,
    fit: Pick<StructureFit, 'slots' | 'surfaces'>,
    occluder: RenderMesh3D,
    registration: Registration | undefined,
    max = VIEWS_PER_RUN
): PlannedRunView[] {
    const l = target.located;
    const surface = fit.surfaces.find(s => s.id === l.surfaceId);
    const normal: Vec3 = surface ? chartNormal(surface.chart, l.regionUv.u0) : [0, 0, 1];
    const widthM = Math.max(0.5, l.runAlongM ? l.runAlongM[1] - l.runAlongM[0] : Math.max(l.widthM, l.heightM));
    const heightM = Math.max(0.3, l.heightM);
    const out: PlannedRunView[] = [];
    for (const p of panos) {
        const corr = registration?.corrections.get(p.panoId);
        const eye: Vec3 = corr ? [p.eye[0] + corr.dx, p.eye[1] + corr.dy, p.eye[2] + corr.dz] : p.eye;
        const dx = l.centre[0] - eye[0], dy = l.centre[1] - eye[1], dz = l.centre[2] - eye[2];
        const d = Math.hypot(dx, dz);
        if (d < MIN_RUN_VIEW_DISTANCE_M || d > MAX_RUN_VIEW_DISTANCE_M) continue;
        const dist3 = Math.hypot(dx, dy, dz);
        // the line of sight must meet the face squarely enough to see its relief
        const cosine = -(dx * normal[0] + dy * normal[1] + dz * normal[2]) / dist3;
        if (cosine < MIN_FACE_COSINE) continue;
        const elevationDeg = Math.max(-20, Math.min(70, Math.atan2(dy, Math.max(0.1, d)) / DEG));
        const aspect = ASPECTS.reduce((best, a) => (Math.abs(Math.log(a.ratio / (widthM / heightM))) < Math.abs(Math.log(best.ratio / (widthM / heightM))) ? a : best), ASPECTS[1]);
        const needH = 2 * Math.atan(((widthM / 2) * 1.3) / Math.max(1, dist3)) / DEG;
        const needV = 2 * Math.atan((((heightM / 2) * 1.3) / Math.max(1, dist3)) * aspect.ratio) / DEG;
        const fovDeg = Math.round(Math.max(RUN_FOV_MIN_DEG, Math.min(RUN_FOV_MAX_DEG, Math.max(needH, needV))) * 10) / 10;
        // the crop is asked of the pano in its own frame: the stated heading is the registered one less the pano's yaw correction
        const heading = (((bearingDeg(eye[0], eye[2], l.centre[0], l.centre[2]) - (corr?.dyawDeg ?? 0)) % 360) + 360) % 360;
        const widthPx = 1000, heightPx = Math.round(1000 / aspect.ratio);
        const statedPitch = elevationDeg - (corr?.dpitchDeg ?? 0);
        const shown = projectSlots(fit, { eye: p.eye, headingDeg: heading, pitchDeg: statedPitch, fovDeg, widthPx, heightPx, ...(corr ? { correction: corr } : {}) }, occluder)
            .find(s => s.slotId === target.slotId);
        if (!shown || shown.visibleFraction < MIN_SHOWN_FRACTION) continue;
        const view: SelectedView = {
            panoId: p.panoId, date: p.date, copyright: p.copyright, eye: p.eye, facadeHeadingDeg: Math.round(((Math.atan2(normal[0], -normal[2]) / DEG) + 360) % 360),
            headingDeg: Math.round(heading * 10) / 10, pitchDeg: Math.round(statedPitch * 10) / 10, fovDeg, aspectRatio: aspect.name,
            distanceM: Math.round(dist3 * 100) / 100, score: 0, aimedSlotIds: [target.slotId], coveredSlotIds: [target.slotId]
        };
        // nearer is sharper, squarer is clearer, a registered pose is better placed
        const score = shown.visibleFraction * cosine * (corr ? 1.25 : 1) / Math.sqrt(dist3 / 10);
        view.score = Math.round(score * 1000) / 1000;
        out.push({ view, visibleFraction: shown.visibleFraction, registered: !!corr, score });
    }
    out.sort((a, b) => b.score - a.score || a.view.panoId.localeCompare(b.view.panoId));
    const chosen: PlannedRunView[] = [];
    for (const c of out) {
        if (chosen.length >= max) break;
        // distinct panos at least 4 m apart (a second look from elsewhere, not the same one twice)
        if (chosen.some(o => Math.hypot(o.view.eye[0] - c.view.eye[0], o.view.eye[2] - c.view.eye[2]) < 4)) continue;
        chosen.push(c);
    }
    return chosen;
}

export function focusTask(t: RunTarget, slotLengthM: number | undefined): string {
    const l = t.located;
    const where = l.runAlongM
        ? `along the fitted edge of slot ${t.slotId}${slotLengthM ? ` (${slotLengthM.toFixed(2)} m long)` : ''}, over about ${(l.runAlongM[1] - l.runAlongM[0]).toFixed(2)} m of it`
        : `on slot ${t.slotId}, about ${l.widthM.toFixed(2)} × ${l.heightM.toFixed(2)} m`;
    return `A first look at the whole structure saw "${l.kind}" (${l.material}) here, ${t.because}, ${where}. Read only this group: count the repeats you can see and measure their size and spacing in the crop; the repeats × their pitch must fit the run. If the crop does not show it, return no elements and list the slot in emptySlots.`;
}

// ----------------------------------------------------------------------------------------------------------------
// the pass
// ----------------------------------------------------------------------------------------------------------------

export interface RunReadingReport {
    targets: number;
    read: number;
    elements: number;
    replaced: number;
    skipped: RunSkip[];
    /** Per target that was read: how many elements, from how many views. */
    perTarget: Array<{ id: string; slotId: string; views: number; elements: number; model: string }>;
}

export interface RunReadingInput {
    fit: StructureFit;
    fitSha256: string;
    base: OrnamentSpec;
    located: LocatedElement[];
    panos: PanoCandidate[];
    groundAt: (x: number, z: number) => number;
    fallbackGroundY: number;
    registration?: Registration;
    occluder: RenderMesh3D;
    streetView: StreetViewEvidenceDeps;
    chain: VisionModelChain<string>;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
    /** Parallel readings at once (default: all). */
    concurrency?: number;
    budgetMs?: number;
}

export interface RunReadingResult {
    spec: OrnamentSpec;
    anchored: AnchorNote[];
    report: RunReadingReport;
    /** The crops' references (never their bytes), already in spec.evidence. */
    imageRefs: EvidenceImageRef[];
    dropped: Array<{ elementId: string; slotId: string; reasonCode: string; problems: string[] }>;
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            out[i] = await fn(items[i]);
        }
    }));
    return out;
}

/** The focused readings themselves, before they are merged into a wide reading (they do not depend on it, so they can run beside it). */
export interface RunTargetReadings {
    report: RunReadingReport;
    results: Array<{ t: RunTarget; reading: Awaited<ReturnType<typeof readOrnament>>; refs: EvidenceImageRef[] } | undefined>;
}

/** The wide reading with the focused readings merged in (readRunTargets then mergeRunReadings). */
export async function readRuns(input: RunReadingInput): Promise<RunReadingResult> {
    return mergeRunReadings(input, await readRunTargets(input));
}

/** Steps 1-3: the views, the crops and one focused reading per target. Needs no wide reading. */
export async function readRunTargets(input: Omit<RunReadingInput, 'base'>): Promise<RunTargetReadings> {
    const { fit } = input;
    // the pass's budget counts from here, so fetching the crops comes out of it too (the caller sizes it to the time it has left)
    const budgetStarted = Date.now();
    const targets = selectRunTargets(input.located);
    const report: RunReadingReport = { targets: targets.length, read: 0, elements: 0, replaced: 0, skipped: [], perTarget: [] };
    if (!targets.length) return { report, results: [] };
    const solid: FittedShells | undefined = readFittedShells(fit);
    const slotById = new Map(fit.slots.map(s => [s.id, s]));
    const coverCache = new Map<string, import('./slot-cover').SlotCover | undefined>();
    const candidates = input.panos.map(p => {
        const g = input.groundAt(p.x, p.z);
        return { panoId: p.panoId, date: p.date, copyright: p.copyright, eye: [p.x, (g === g ? g : input.fallbackGroundY) + STREET_VIEW_EYE_HEIGHT_M, p.z] as Vec3 };
    });
    input.onProgress?.(`reading ${targets.length} repeating run${targets.length === 1 ? '' : 's'} and band${targets.length === 1 ? '' : 's'} one at a time from narrow crops`);

    // 1. the views, from geometry alone (no network): the best one or two panos per target
    const planned = targets.map(t => ({ t, views: planRunViews(t, candidates, fit, input.occluder, input.registration) }));
    const wanted: Array<{ t: RunTarget; view: SelectedView }> = [];
    for (const { t, views } of planned) {
        if (!views.length) report.skipped.push({ id: t.id, kind: t.located.kind, slotId: t.slotId, reason: 'no pano shows its slot squarely from 6-70 m, unoccluded' });
        for (const v of views) wanted.push({ t, view: v.view });
    }
    if (!wanted.length) return { report, results: [] };

    // 2. fetch every crop at once
    const got = await fetchViews(wanted.map(w => w.view), input.streetView, input.signal);
    const imageFor = new Map<SelectedView, EvidenceImage>();
    for (const im of got.images) imageFor.set(im.view, im);
    for (const f of got.failures) {
        const w = wanted.find(x => x.view === f.view);
        if (w) report.skipped.push({ id: w.t.id, kind: w.t.located.kind, slotId: w.t.slotId, reason: `a crop did not arrive (${f.error})` });
    }

    // 3. one small focused reading per target, several at a time
    const budget = new AbortController();
    const budgetTimer = setTimeout(() => budget.abort(new Error('budget')), Math.max(0, (input.budgetMs ?? RUN_PASS_BUDGET_MS) - (Date.now() - budgetStarted)));
    const readSignal = input.signal ? AbortSignal.any([input.signal, budget.signal]) : budget.signal;
    const results = await pool(planned, input.concurrency ?? Math.max(1, planned.length), async ({ t }) => {
        const mine = wanted.filter(w => w.t === t).map(w => imageFor.get(w.view)).filter((x): x is EvidenceImage => !!x);
        if (!mine.length) return undefined;
        const slot = slotById.get(t.slotId);
        if (!slot) return undefined;
        const evidence: EvidenceInput[] = mine.map((im, k) => {
            const corr = input.registration?.corrections.get(im.view.panoId);
            const slotsShown = projectSlots(fit, { eye: im.view.eye, headingDeg: im.view.headingDeg, pitchDeg: im.view.pitchDeg, fovDeg: im.view.fovDeg, widthPx: im.widthPx, heightPx: im.heightPx, ...(corr ? { correction: corr } : {}) }, input.occluder);
            const ref: EvidenceImageRef = {
                id: im.id, index: k, kind: 'streetview-grounding', widthPx: im.widthPx, heightPx: im.heightPx, sha256: im.sha256, nativeSampleM: im.nativeSampleM,
                panoId: im.view.panoId, ...(im.view.date ? { captureDate: im.view.date } : {}), copyright: im.view.copyright ?? '© Google',
                headingDeg: im.view.headingDeg, pitchDeg: im.view.pitchDeg, fovDeg: im.view.fovDeg, distanceM: im.view.distanceM,
                pose: corr && input.registration ? registeredPose(im.view.eye, corr, Math.min(2, Math.max(0.1, input.registration.afterRmsM))) : nominalPose(im.view.eye), slotsShown
            };
            return { ref, bytes: im.bytes, mimeType: im.mimeType, caption: streetViewCaption(ref) };
        });
        // the slot is offered only when it is on an open exterior face and a crop shows it
        const offerAll = computeSlotOffer(fit, evidence.map(e => e.ref), solid, new Set([t.slotId]), coverCache);
        const entry = offerAll.entries.find(e => e.slotId === t.slotId);
        if (!entry?.offered) {
            report.skipped.push({ id: t.id, kind: t.located.kind, slotId: t.slotId, reason: entry?.why ?? 'its slot is not shown' });
            return undefined;
        }
        const offer: SlotOffer = { ...offerAll, entries: [entry], offeredIds: new Set([t.slotId]) };
        const length = 'edge' in slot.host ? slot.host.edge.carrier.lengthM : undefined;
        try {
            const reading = await readOrnament({
                fit, fitSha256: input.fitSha256, evidence, chain: input.chain, signal: readSignal,
                timeoutMs: RUN_READ_TIMEOUT_MS, located: [t.located], offer, focus: { task: focusTask(t, length) }
            });
            return { t, reading, refs: evidence.map(e => e.ref) };
        } catch (err) {
            if (input.signal?.aborted) throw err;
            if (budget.signal.aborted) { report.skipped.push({ id: t.id, kind: t.located.kind, slotId: t.slotId, reason: `the focused readings' time budget (${Math.round((input.budgetMs ?? RUN_PASS_BUDGET_MS) / 1000)} s) ran out before this one answered` }); return undefined; }
            report.skipped.push({ id: t.id, kind: t.located.kind, slotId: t.slotId, reason: `the focused reading gave nothing usable (${err instanceof VisionStageError ? err.message : (err as Error).message})` });
            return undefined;
        }
    });

    clearTimeout(budgetTimer);
    return { report, results };
}

/** Step 4: the focused readings merged into the wide reading `input.base`. */
export function mergeRunReadings(input: Pick<RunReadingInput, 'fit' | 'base'>, readings: RunTargetReadings): RunReadingResult {
    const { report, results } = readings;
    const slotById = new Map(input.fit.slots.map(s => [s.id, s]));
    const anchored: AnchorNote[] = [];
    const dropped: RunReadingResult['dropped'] = [];
    const imageRefs: EvidenceImageRef[] = [];
    const newElements: OrnamentElement[] = [];
    if (!results.length) return { spec: input.base, anchored, report, imageRefs, dropped };
    // 4. merge: ids made unique, the focused reading replaces whatever the wide reading put on the same stretch of the same slot
    let k = 0;
    const merged: OrnamentElement[] = [];
    for (const r of results) {
        if (!r) continue;
        report.read++;
        const prefix = `r${k++}`;
        const rename = (id: string) => `${prefix}.${id}`;
        const els = r.reading.spec.elements.map(e => ({ ...e, id: rename(e.id) }));
        for (const a of r.reading.anchored) anchored.push({ ...a, elementId: rename(a.elementId) });
        for (const d of r.reading.dropped) dropped.push({ elementId: rename(d.elementId), slotId: d.slotId, reasonCode: d.reasonCode, problems: d.problems });
        for (const ref of r.refs) if (!imageRefs.some(x => x.id === ref.id)) imageRefs.push(ref);
        report.perTarget.push({ id: r.t.id, slotId: r.t.slotId, views: r.refs.length, elements: els.length, model: r.reading.spec.model.used });
        if (!els.length) report.skipped.push({ id: r.t.id, kind: r.t.located.kind, slotId: r.t.slotId, reason: r.reading.spec.emptySlots.find(e => e.slotId === r.t.slotId)?.reason ?? (r.reading.dropped.length ? `every element it read was dropped by the checks (${r.reading.dropped[0].problems[0] ?? r.reading.dropped[0].reasonCode})` : 'the reading returned no element for it') });
        merged.push(...els);
    }
    const base = input.base.elements.filter(b => {
        const slot = slotById.get(b.slotId);
        if (!slot) return true;
        const fb = (() => { try { return bbox(footprint(b.spec, slot)); } catch { return undefined; } })();
        if (!fb) return true;
        const clash = merged.some(m => {
            if (m.slotId !== b.slotId) return false;
            let fm;
            try { fm = bbox(footprint(m.spec, slot)); } catch { return false; }
            const iu = Math.max(0, Math.min(fb.u1, fm.u1) - Math.max(fb.u0, fm.u0)), iv = Math.max(0, Math.min(fb.v1, fm.v1) - Math.max(fb.v0, fm.v0));
            const smaller = Math.max(1e-6, Math.min((fb.u1 - fb.u0) * (fb.v1 - fb.v0), (fm.u1 - fm.u0) * (fm.v1 - fm.v0)));
            const lineOverlap = Math.min(fb.u1, fm.u1) - Math.max(fb.u0, fm.u0);
            return (iu * iv) / smaller >= 0.5 || (Math.min(fb.v1 - fb.v0, fm.v1 - fm.v0) < 1e-3 && lineOverlap / Math.max(1e-6, Math.min(fb.u1 - fb.u0, fm.u1 - fm.u0)) >= 0.5);
        });
        if (clash) report.replaced++;
        return !clash;
    });
    newElements.push(...merged);
    report.elements = newElements.length;
    const evidence = [...input.base.evidence];
    for (const ref of imageRefs) if (!evidence.some(x => x.id === ref.id)) evidence.push({ ...ref, index: evidence.length });
    const spec: OrnamentSpec = {
        ...input.base,
        evidence,
        elements: [...base, ...newElements],
        dropped: [...input.base.dropped, ...dropped.map(d => ({ elementId: d.elementId, slotId: d.slotId, by: 'validator' as const, problems: d.problems }))]
    };
    return { spec, anchored, report, imageRefs, dropped };
}
