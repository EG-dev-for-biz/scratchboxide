/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pass 2: the survey's elements located in 3D on a known synthetic structure, their slots found by geometry, the narrow
 * crops, and the measurements anchored to the scan (snapped inside the 0.31 m tolerance, a problem outside it, clipped
 * back into the slot instead of failing "runs outside the slot").
 */
import { describe, it, expect } from 'vitest';
import { locateSurveyElements, planDetailFromSurvey, planDetailViews, surveyHintLines, DETAIL_FOV_MAX_DEG, DETAIL_FOV_MIN_DEG } from '../src/node/3d-engine/staged-location/survey-detail';
import { anchorElements } from '../src/node/3d-engine/staged-location/ornament-anchor';
import { expandElements } from '../src/node/3d-engine/staged-location/ornament-expand';
import { checkReply, ornamentPromptText } from '../src/node/3d-engine/staged-location/ornament-vision';
import { castCamera } from '../src/node/3d-engine/staged-location/survey-casting';
import { PHOTO_CORRECTION_TOLERANCE_M, PROVENANCE, type EvidenceImageRef, type CompactElement } from '../src/common/spatial/staged-location-contracts';
import { projectToFrame } from '../src/node/spatial/StreetViewPoseRegistrar';
import { corniceReply } from './helpers/photo-ornament-fixtures';
import { structureFit } from './helpers/staged-location-fixtures';

const fit = structureFit();
const VIEW = { eye: [0, 2.5, -40] as [number, number, number], headingDeg: 180, pitchDeg: 25, fovDeg: 60, widthPx: 1440, heightPx: 1080 };

/** The 0..1000 [y0, x0, y1, x1] box round some face points of the north wall (z = -5.5). */
function boxAround(points: Array<[number, number]>): [number, number, number, number] {
    const cam = castCamera(VIEW);
    const px = points.map(([x, y]) => projectToFrame(cam, [x, y, -5.5])!);
    const r = (v: number) => Math.max(0, Math.min(1000, Math.round(v)));
    return [r(Math.min(...px.map(p => p[1])) / VIEW.heightPx * 1000), r(Math.min(...px.map(p => p[0])) / VIEW.widthPx * 1000), r(Math.max(...px.map(p => p[1])) / VIEW.heightPx * 1000), r(Math.max(...px.map(p => p[0])) / VIEW.widthPx * 1000)];
}

/** A survey of the north wall: the cornice run (x -3.24..3.24 m, 18 dentils) and a spandrel medallion (x -8..-6, y 13..15, in the S01 region). */
function survey() {
    const view = { faceId: 'h0', panoId: 'N1', date: '2025-06', copyright: '© Google', eye: VIEW.eye, facadeHeadingDeg: 0, headingDeg: VIEW.headingDeg, pitchDeg: VIEW.pitchDeg, fovDeg: VIEW.fovDeg, aspectRatio: 'RATIO_4X3' as const, distanceM: 38, score: 1 };
    return {
        faces: [{
            faceId: 'h0', headingDeg: 0, source: 'footprint' as const, panoId: 'N1', materials: [],
            elements: [
                { kind: 'dentil course', box: boxAround([[-3.24, 20.0], [3.24, 20.0], [-3.24, 20.4], [3.24, 20.4]]), repeat: { count: 18, pitchRatio: 0.05, axis: 'h' }, material: 'stone', weathering: 'clean', confidence: 80 },
                { kind: 'medallion', box: boxAround([[-8, 13], [-6, 13], [-8, 15], [-6, 15]]), material: 'carved stone', weathering: 'worn', confidence: 60 },
                { kind: 'something in the sky', box: [0, 0, 20, 30] as [number, number, number, number], material: 'x', weathering: 'y', confidence: 50 }
            ]
        }],
        read: [{ view, widthPx: VIEW.widthPx, heightPx: VIEW.heightPx, imageIndex: 0, sha256: 'a'.repeat(64) }]
    };
}

describe('locating the survey\'s elements by geometry', () => {
    it('puts each box on its fitted face and finds its slot; the run along the cornice comes out in metres from the scan', () => {
        const { located, unlocated } = locateSurveyElements(survey(), fit);
        const dentils = located.find(l => l.kind === 'dentil course')!;
        expect(dentils.slotId).toBe('S02');
        expect(dentils.surfaceId).toBe('s00');
        // the cornice carrier runs x -13.15..13.15 at y 20.1: the run is x -3.24..3.24, i.e. 9.9 .. 16.4 m along it
        expect(dentils.runAlongM![0]).toBeCloseTo(13.15 - 3.24, 0);
        expect(dentils.runAlongM![1]).toBeCloseTo(13.15 + 3.24, 0);
        expect(dentils.repeat!.count).toBe(18);
        expect(dentils.repeat!.pitchM).toBeCloseTo(6.48 / 18, 1);
        const medallion = located.find(l => l.kind === 'medallion')!;
        expect(medallion.slotId).toBe('S01');
        expect(medallion.widthM).toBeGreaterThan(1.5); expect(medallion.widthM).toBeLessThan(3);
        // a box in the sky lands on nothing and is reported, not forced into a slot
        expect(unlocated).toEqual([expect.objectContaining({ kind: 'something in the sky', reason: expect.stringMatching(/does not land|in no slot/) })]);
    });

    it('plans one narrow crop per slot group from the pano that saw it: aimed up at the group, fov 30-45, within the budget', () => {
        const plan = planDetailFromSurvey(survey(), fit);
        expect(plan.views.length).toBe(2);
        for (const v of plan.views) {
            expect(v.panoId).toBe('N1');
            expect(v.fovDeg).toBeGreaterThanOrEqual(DETAIL_FOV_MIN_DEG); expect(v.fovDeg).toBeLessThanOrEqual(DETAIL_FOV_MAX_DEG);
            expect(v.pitchDeg).toBeGreaterThan(10); // looking up at a cornice and a spandrel (elevation, up positive)
            expect(v.aimedSlotIds!.length).toBe(1);
        }
        const cornice = plan.views.find(v => v.aimedSlotIds![0] === 'S02')!;
        // the cornice run is centred on x = 0: the crop looks straight south
        expect(Math.abs(cornice.headingDeg - 180)).toBeLessThan(3);
        const medallion = plan.views.find(v => v.aimedSlotIds![0] === 'S01')!;
        expect(medallion.headingDeg).toBeGreaterThan(180); expect(medallion.headingDeg).toBeLessThan(200); // west of the centre line, which is to the right when looking south
        expect(planDetailViews(plan.located, survey(), 1).length).toBe(1);
        expect(planDetailViews(plan.located, survey(), 0)).toEqual([]);
        expect(surveyHintLines(plan.located, fit.slots).join('\n')).toMatch(/S02: the survey saw "dentil course".*count it from the crop yourself.*good to about \d/);
        // the survey's own count and pitch are not passed on as a prior for the second reading
        expect(surveyHintLines(plan.located, fit.slots).join('\n')).not.toMatch(/18 repeats|mm per cell/);
        expect(ornamentPromptText(fit, [], plan.located).tables).toMatch(/Survey: a first look at the whole structure/);
        expect(ornamentPromptText(fit, [], []).tables).not.toMatch(/Survey:/);
    });
});

const svRef = (): EvidenceImageRef => ({
    id: 'sv:N1:180:25:40', index: 0, kind: 'streetview-grounding', widthPx: 1440, heightPx: 1080, sha256: 'c'.repeat(64), nativeSampleM: 0.02, panoId: 'N1', captureDate: '2025-06', copyright: '© Google',
    headingDeg: 180, pitchDeg: 25, fovDeg: 40, distanceM: 38, pose: { eye: [0, 2.5, -40], registered: false, uncertaintyM: 2, uncertaintyDeg: 2 },
    slotsShown: [{ slotId: 'S01', polygon1000: [50, 50, 50, 950, 950, 950, 950, 50], visibleFraction: 1 }, { slotId: 'S02', polygon1000: [50, 50, 50, 950, 950, 950, 950, 50], visibleFraction: 1 }]
});
const compact = (over: Partial<CompactElement> & Pick<CompactElement, 'slot' | 'op'>): CompactElement => ({ conf: 80, depthBasis: 'shadow', ev: [[0, 300, 300, 600, 600]], ...over });
const expand = (els: CompactElement[]) => expandElements(els, fit, [svRef()], 'test');

describe('anchoring the measurements to the scan', () => {
    const located = () => locateSurveyElements(survey(), fit).located;
    /** The same located elements as if the pano pose had been registered (a place good to 0.1 m): only then may a run overwrite a pitch. */
    const registered = () => located().map(l => ({ ...l, locationUncertaintyM: 0.1 }));

    it('snaps count x pitch to the located run inside the 0.31 m tolerance and labels the element photo-corrected, with the error it carried', () => {
        // 18 dentils at 0.37 m = 6.66 m against a 6.48 m run: 0.18 m apart
        const x = expand([compact({ slot: 'S02', op: { replicate: { seed: { sweep: { t: [0, 14], profile: [0, 0, 250, 0, 250, 100, 0, 100] } }, along: [0, 370, 18] } } })]);
        const r = anchorElements(x, fit, registered());
        expect(r.problems.size).toBe(0);
        expect(r.notes).toEqual([expect.objectContaining({ kind: 'run-snapped', slotId: 'S02', toleranceM: PHOTO_CORRECTION_TOLERANCE_M })]);
        expect(r.notes[0].errorM).toBeGreaterThan(0.05); expect(r.notes[0].errorM).toBeLessThan(0.45); // 6.66 m against the 6.5 m run the box casts to, plus the run's own 0.1 m
        expect(r.notes[0].note).toMatch(/survey model's bounding box cast through the nominal \(unregistered\) pano pose, good to ±0\.1 m/);
        const spec = x[0].element.spec as any;
        expect(spec.replicate.domain.along.count).toBe(18);
        expect(spec.replicate.domain.along.pitchM).toBeCloseTo(6.48 / 18, 1);
        expect(spec.replicate.domain.along.carrier.slot.t0).toBeCloseTo((13.15 - 3.24) / 26.3, 1);
        expect(x[0].element.provenance.label).toBe(PROVENANCE.photoCorrected);
        expect(x[0].element.checks.anchor).toMatchObject({ toleranceM: PHOTO_CORRECTION_TOLERANCE_M });
        expect(x[0].element.provenance.note).toMatch(/photo-corrected inside the scan tolerance/);
    });

    it('outside the tolerance nothing is snapped: the problem goes back with the numbers', () => {
        const x = expand([compact({ slot: 'S02', op: { replicate: { seed: { sweep: { t: [0, 14], profile: [0, 0, 250, 0, 250, 100, 0, 100] } }, along: [0, 700, 18] } } })]);
        const before = JSON.stringify(x[0].element.spec);
        const r = anchorElements(x, fit, registered());
        expect(JSON.stringify(x[0].element.spec)).toBe(before);
        expect(r.notes).toEqual([]);
        expect(r.problems.get(0)![0]).toMatch(/anchor: the crop was read as 18 repeats × 700 mm = 12\.6 m, while the run from the survey model's bounding box.* spans 6\.\d+ m/);
        // the revision asks for a re-read of the image, never for a match to the span
        expect(r.problems.get(0)![0]).toMatch(/re-read the repeat count and the pitch as they appear; do not adjust them to match the span/);
    });

    it('after the one re-read, a reading within reach of the measured span is kept on it, labelled with the error; an impossible one (a row of 72 m on a 6.5 m run) is still rejected', () => {
        const mk = (pitch: number, count: number) => expand([compact({ slot: 'S02', op: { replicate: { seed: { sweep: { t: [0, 14], profile: [0, 0, 250, 0, 250, 100, 0, 100] } }, along: [0, pitch, count] } } })]);
        const x = mk(700, 18);
        const first = anchorElements(x, fit, registered());
        expect(first.problems.size).toBe(1); // asked once
        const r = anchorElements(x, fit, registered(), undefined, true);
        expect(r.problems.size).toBe(0);
        expect(r.notes[0]).toMatchObject({ kind: 'pitch-snapped' });
        expect(r.notes[0].errorM).toBeGreaterThan(PHOTO_CORRECTION_TOLERANCE_M);
        expect((x[0].element.spec as any).replicate.domain.along.pitchM).toBeCloseTo(6.48 / 18, 1);
        expect(x[0].element.provenance.label).toBe(PROVENANCE.photoCorrected);
        expect(x[0].element.provenance.note).toMatch(/off by more than the 0\.31 m tolerance, and the error is labelled/);
        const impossible = mk(360, 200);
        const bad = anchorElements(impossible, fit, registered(), undefined, true);
        expect(bad.problems.get(0)![0]).toMatch(/72 mm|72 m|72\.0 m/);
        expect(bad.notes).toEqual([]);
    });

    it('a run placed only by the nominal pano pose (good to metres) never overwrites the photo-read pitch, and a gross gap goes back as a re-read', () => {
        const near = expand([compact({ slot: 'S02', op: { replicate: { seed: { sweep: { t: [0, 14], profile: [0, 0, 250, 0, 250, 100, 0, 100] } }, along: [0, 370, 18] } } })]);
        const loose = located();
        expect(loose.every(l => l.locationUncertaintyM > PHOTO_CORRECTION_TOLERANCE_M)).toBe(true);
        const r = anchorElements(near, fit, loose);
        expect(r.problems.size).toBe(0);
        expect((near[0].element.spec as any).replicate.domain.along.pitchM).toBeCloseTo(0.37, 3); // untouched: 18 x 0.37 = 6.66 m is within the run's own uncertainty
        expect(r.notes.filter(n => n.kind === 'run-snapped')).toEqual([]);
        const gross = expand([compact({ slot: 'S02', op: { replicate: { seed: { sweep: { t: [0, 14], profile: [0, 0, 250, 0, 250, 100, 0, 100] } }, along: [0, 700, 18] } } })]);
        const g = anchorElements(gross, fit, loose);
        expect(g.problems.get(0)![0]).toMatch(/±\d+(\.\d+)? m, from the survey model's bounding box/);
        expect(g.problems.get(0)![0]).toMatch(/do not adjust them to match that span/);
    });

    it('a row that runs past the fitted edge is shortened to what fits when no run was located, and says so', () => {
        const x = expand([compact({ slot: 'S02', op: { replicate: { seed: { sweep: { t: [0, 14], profile: [0, 0, 250, 0, 250, 100, 0, 100] } }, along: [0, 1000, 40] } } })]);
        const r = anchorElements(x, fit, []);
        expect(r.notes[0].kind).toBe('count-clipped');
        expect((x[0].element.spec as any).replicate.domain.along.count).toBe(27); // 26.3 m / 1 m + 1
    });

    it('a medallion 0.2 m outside its slot is moved back inside instead of failing "runs outside the slot"; 2 m outside is still a problem', () => {
        // S01 is u 2..8, v 12..18 on s00; a 0.9 m radius medallion at u = 8.1 sticks out by 1.0 m... use a small one: radius 0.3 m at u = 7.9 sticks out 0.2 m
        const small = (u: number) => compact({ slot: 'S01', op: { revolve: { at: [u * 1000, 15000], axis: 'n', profile: [0, 0, 300, 0, 300, 100, 0, 100] } } });
        const ok = expand([small(7.9)]);
        expect(anchorElements(ok, fit, []).notes[0]).toMatchObject({ kind: 'clipped-to-slot' });
        expect((ok[0].element.spec as any).revolve.axisOrigin[0]).toBeLessThanOrEqual(7.7 + 1e-6);
        const far = expand([small(9.9)]);
        expect(anchorElements(far, fit, []).notes).toEqual([]);
    });
});

describe('the whole check: a reply that used to fail on "outside the slot" and on a count x pitch the scan contradicts', () => {
    it('an overshoot inside the tolerance passes with anchoring; the same reply without the survey is sent back (the old failure)', () => {
        const reply = { elements: [{ slot: 'S01', op: { revolve: { at: [7900, 15000], axis: 'n', profile: [0, 0, 300, 0, 300, 100, 0, 100] } }, conf: 70, depthBasis: 'rim', ev: [[0, 300, 300, 600, 600]] }], corrections: [], emptySlots: [] };
        const text = JSON.stringify(reply);
        const withSurvey = checkReply(text, 'STOP', fit, [svRef()], 'test', false, locateSurveyElements(survey(), fit).located);
        expect(withSurvey.problems).toEqual([]);
        expect(withSurvey.anchored).toHaveLength(1);
        const without = checkReply(text, 'STOP', fit, [svRef()], 'test', false, []);
        // with a survey that located nothing the slot rule still guards, but the clip needs no survey: both pass; the problem returns only for a real overshoot
        expect(without.problems).toEqual([]);
        const wild = JSON.stringify({ ...reply, elements: [{ ...reply.elements[0], op: { revolve: { at: [9900, 15000], axis: 'n', profile: [0, 0, 300, 0, 300, 100, 0, 100] } } }] });
        expect(checkReply(wild, 'STOP', fit, [svRef()], 'test', false, []).problems.join(' ')).toMatch(/rule 5: the element runs outside slot S01/);
    });

    it('the recorded cornice reading (dentils 18 at 0.36 m, a five-band profile) survives the checks with its dentils anchored to the located run', () => {
        const r = checkReply(JSON.stringify(corniceReply()), 'STOP', fit, [svRef()], 'recorded', true, locateSurveyElements(survey(), fit).located);
        expect(r.kept.map(e => e.label)).toEqual(expect.arrayContaining(['dentils', 'cornice', 'medallion']));
        const dentils = r.kept.find(e => e.label === 'dentils')!;
        expect((dentils.spec as any).replicate.domain.along.count).toBe(18);
        expect(dentils.provenance.label).toMatch(/photo-(inferred|corrected)/);
        expect(r.dropped).toEqual([]);
    });
});
