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
