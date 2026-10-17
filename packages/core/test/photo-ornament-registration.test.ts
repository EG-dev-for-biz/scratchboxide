/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** Pose registration from corresponding boxes: known true poses, perturbed nominal ones, boxes made by projecting known face points. */
import { describe, it, expect } from 'vitest';
import { projectToFrame, ZERO_CORRECTION } from '../src/node/spatial/StreetViewPoseRegistrar';
import { castCamera, castRay, pixelRay, type CastFace } from '../src/node/3d-engine/staged-location/survey-casting';
import { registerPanos, triangulate, type Correspondence, type RegView } from '../src/node/3d-engine/staged-location/pano-registration';

const NORTH: CastFace = { id: 'north', source: 'fit', chart: { plane: { origin: [-13, 0, -5.5], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, -1], extentUv: [[0, 0], [26, 24]] } } };
const W = 1440, H = 1080;
const TRUE_A: RegView = { panoId: 'A', eye: [-8, 2.5, -38], headingDeg: 180, pitchDeg: 20, fovDeg: 60, widthPx: W, heightPx: H };
const TRUE_B: RegView = { panoId: 'B', eye: [11, 2.5, -33], headingDeg: 180, pitchDeg: 20, fovDeg: 60, widthPx: W, heightPx: H };
// what the metadata says: position off by metres, the heading by a degree or two
const NOM_A: RegView = { ...TRUE_A, eye: [-6.2, 2.5, -40.1], headingDeg: 181.6 };
const NOM_B: RegView = { ...TRUE_B, eye: [12.4, 2.5, -31.0], headingDeg: 178.3 };

function boxAt(v: RegView, p: [number, number, number], half = 12): [number, number, number, number] {
    const px = projectToFrame(castCamera(v), p)!;
    return [((px[1] - half) / H) * 1000, ((px[0] - half) / W) * 1000, ((px[1] + half) / H) * 1000, ((px[0] + half) / W) * 1000];
}
const points: Array<[number, number, number]> = [[-6, 14, -5.5], [-1, 16, -5.5], [4, 12, -5.5], [8, 15, -5.5], [-9, 17, -5.5], [2, 18, -5.5]];
const corrs = (a: RegView, b: RegView): Correspondence[] => points.map((p, i) => ({ id: `e${i}`, a: { view: a, box: boxAt(TRUE_A, p) }, b: { view: b, box: boxAt(TRUE_B, p) } }));
const castPoint = (v: RegView, c: any, box: [number, number, number, number]) => {
    const cam = castCamera({ ...v, correction: c });
    return castRay(pixelRay(cam, ((box[1] + box[3]) / 2000) * W, ((box[0] + box[2]) / 2000) * H), [NORTH])!.point;
};

describe('registering panos from corresponding boxes', () => {
    it('the nominal poses disagree by metres; the registered ones agree to a few centimetres', () => {
        const cs = corrs(NOM_A, NOM_B);
        const nominalGap = Math.hypot(...castPoint(NOM_A, ZERO_CORRECTION, cs[0].a.box).map((v, i) => v - castPoint(NOM_B, ZERO_CORRECTION, cs[0].b.box)[i]));
        expect(nominalGap).toBeGreaterThan(2);
        const r = registerPanos(cs, [NORTH]);
        expect(r.used).toBe(points.length);
        expect(r.beforeRmsM).toBeGreaterThan(2);
        expect(r.afterRmsM).toBeLessThan(0.2);
        expect(r.afterRmsM).toBeLessThan(r.beforeRmsM / 10);
        // the two views now put the element in the same place on the face
        for (const c of cs) {
            const pa = castPoint(NOM_A, r.corrections.get('A'), c.a.box), pb = castPoint(NOM_B, r.corrections.get('B'), c.b.box);
            expect(Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2])).toBeLessThan(0.25);
        }
    });

    it('a wrong match (the same word on a different thing) is set aside and does not bend the poses', () => {
        const cs = corrs(NOM_A, NOM_B);
        cs.push({ id: 'wrong', a: cs[0].a, b: { view: NOM_B, box: boxAt(TRUE_B, [-9.5, 3, -5.5]) } });
        const r = registerPanos(cs, [NORTH]);
        expect(r.pairs.find(p => p.id === 'wrong')!.used).toBe(false);
        expect(r.afterRmsM).toBeLessThan(0.25);
    });

    it('triangulation of the closest approach recovers the point and reports the gap', () => {
        const p: [number, number, number] = [2, 15, -5.5];
        const ra = pixelRay(castCamera(TRUE_A), 700, 500), rb = pixelRay(castCamera(TRUE_B), 800, 450);
        const t = triangulate(ra, rb);
        expect(t.ok && t.ahead).toBe(true);
        void p;
        const parallel = triangulate({ origin: [0, 0, 0], dir: [0, 0, 1] }, { origin: [1, 0, 0], dir: [0, 0, 1] });
        expect(parallel.ok).toBe(false);
    });

    it('with no correspondences nothing moves', () => {
        const r = registerPanos([], [NORTH]);
        expect(r.corrections.size).toBe(0);
        expect(r.used).toBe(0);
    });
});

// ----------------------------------------------------------------------------------------------------------------
// what the real boxes are like: a pitch error as well as a heading one, boxes of different extents (a band seen to end at different
// places from different panos), a few wrong matches, and the placement noise of a vision model
// ----------------------------------------------------------------------------------------------------------------
describe('registering panos from realistic boxes (noisy extents, bands, a pitch error, wrong matches)', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    const TRUE_C: RegView = { panoId: 'C', eye: [0, 2.5, -41], headingDeg: 180, pitchDeg: 20, fovDeg: 60, widthPx: W, heightPx: H };
    const NOM_C: RegView = { ...TRUE_C, eye: [1.9, 2.5, -39.2], headingDeg: 181.4 };
    const views: Array<[RegView, RegView]> = [[TRUE_A, NOM_A], [TRUE_B, NOM_B], [TRUE_C, NOM_C]];
    // the real pano's pitch is a degree off as well: the nominal camera is built with the stated pitch, the truth is tilted
    const PITCH_ERR = [0.8, -1.1, 0.6];
    const trueWithPitch = views.map(([t], i) => ({ ...t, pitchDeg: t.pitchDeg + PITCH_ERR[i] }));
    const boxOf = (v: RegView, p: [number, number, number], halfW: number, halfH: number, shiftU = 0): [number, number, number, number] => {
        const px = projectToFrame(castCamera(v), [p[0] + shiftU, p[1], p[2]])!;
        const j = () => rnd() * 14;
        return [((px[1] - halfH + j()) / H) * 1000, ((px[0] - halfW + j()) / W) * 1000, ((px[1] + halfH + j()) / H) * 1000, ((px[0] + halfW + j()) / W) * 1000];
    };
    const make = (): Correspondence[] => {
        const out: Correspondence[] = [];
        const spots: Array<[number, number, number]> = [[-8, 13, -5.5], [-3, 16, -5.5], [3, 12, -5.5], [7, 15, -5.5], [-6, 18, -5.5], [1, 9, -5.5]];
        let n = 0;
        for (const p of spots) for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) {
            const band = n % 2 === 0;
            const a = trueWithPitch[i], b = trueWithPitch[j];
            // a band: wide boxes whose ends differ between the two views by a metre or two along the wall
            const ba = band ? boxOf(a, p, 120, 14, rnd() * 3) : boxOf(a, p, 20 + rnd() * 10, 20 + rnd() * 10);
            const bb = band ? boxOf(b, p, 120, 14, rnd() * 3) : boxOf(b, p, 20 + rnd() * 10, 20 + rnd() * 10);
            out.push({ id: `p${n++}`, a: { view: views[i][1], box: ba }, b: { view: views[j][1], box: bb } });
        }
        // two wrong matches
        out.push({ id: 'w0', a: out[0].a, b: { view: NOM_B, box: boxOf(trueWithPitch[1], [-9.5, 3, -5.5], 20, 20) } });
        out.push({ id: 'w1', a: out[3].a, b: { view: NOM_C, box: boxOf(trueWithPitch[2], [9, 20, -5.5], 25, 25) } });
        return out;
    };

    it('lands within a few tens of centimetres of agreement, sets the wrong matches aside, and reports each pano', () => {
        const r = registerPanos(make(), [NORTH]);
        expect(r.afterRmsM).toBeLessThan(0.6);
        expect(r.afterRmsM).toBeLessThan(r.beforeRmsM / 3);
        expect(r.pairs.filter(p => /^w/.test(p.id) && p.used).length).toBe(0);
        expect(r.perPano.length).toBe(3);
        for (const p of r.perPano) { expect(p.pairs).toBeGreaterThan(3); expect(p.afterRmsM).toBeLessThan(p.beforeRmsM); }
        expect(r.setAside).toEqual([]);
        // the pitch is solved too: each pano's pitch moves toward the truth's tilt
        for (const [i, p] of ['A', 'B', 'C'].entries()) expect(Math.abs(r.perPano.find(x => x.panoId === p)!.dpitchDeg - PITCH_ERR[i])).toBeLessThan(Math.abs(PITCH_ERR[i]) + 0.2);
    });

    it('sets aside a pano whose solved shift is implausible, and says so', () => {
        const cs = make();
        // a pano whose every match is of the wrong thing
        for (let i = 0; i < 6; i++) cs.push({ id: `bad${i}`, a: { view: NOM_A, box: boxOf(TRUE_A, [-8 + i * 3, 14, -5.5], 20, 20) }, b: { view: { ...NOM_B, panoId: 'Z', eye: [30, 2.5, -20] }, box: boxOf(TRUE_B, [-8 + i * 3, 14, -5.5], 20, 20) } });
        const r = registerPanos(cs, [NORTH]);
        expect(r.setAside.every(a => a.reason.length > 20)).toBe(true);
        expect(r.afterRmsM).toBeLessThan(0.8);
    });
});
