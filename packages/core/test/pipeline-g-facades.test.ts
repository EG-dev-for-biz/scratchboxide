/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline G's facades (pipeline-g/facades.ts) on a native massing whose 30 m street front is a sawtooth of piers (0.6 m
 * deep, one every 3 m, as a footprint tracing The Rookery's gives): the front's walls are grouped into one facade on their
 * mean plane, the plain walls stay as they are; a reading on the facade is laid back onto the walls (each opening onto the
 * recess it lies in, a band onto every wall facing the street, a pier member onto the wall holding its centre) and the
 * native tool builds all of it.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { massingSpecText, type Massing } from '../src/node/3d-engine/staged-location/pipeline-e/massing-spec';
import { runMassing } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import { groupFacades, layBack, loopCorners } from '../src/node/3d-engine/staged-location/pipeline-g/facades';
import { programItems } from '../src/node/3d-engine/staged-location/pipeline-g/read';

const PARAMS = { bake: 0, sections: 0, topdown: 0, residual: 0 };

/** A 30 x 20 m plan, its south front (z = 0) a sawtooth: 2 m recess, then a pier 1 m wide standing 0.6 m out, every 3 m. */
function sawtoothPlan(): Array<[number, number]> {
    const ring: Array<[number, number]> = [];
    for (let k = 0; k < 10; k++) {
        const x = k * 3;
        ring.push([x, 0], [x + 2, 0], [x + 2, 0.6], [x + 3, 0.6]);
    }
    ring.push([30, 0], [30, -20], [0, -20]);
    // the front reads east along z = 0 then the plan closes north
    return ring;
}

describe('pipeline G facades', () => {
    it('finds the corners of a sawtooth outline and keeps the piers inside its tolerance', () => {
        const c = loopCorners(sawtoothPlan(), 1.2);
        expect(c.length).toBeGreaterThanOrEqual(3);
        expect(c.length).toBeLessThanOrEqual(5);
    });

    it('groups the sawtooth front into one facade, reads onto it, and builds the reading on its walls', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g-facades-'));
        const m: Pick<Massing, 'parts' | 'meshes'> = { parts: [{ id: 'p', baseY: 0, topY: 12, loops: [sawtoothPlan()], planes: [], heightSource: 'vector', heights: {} }], meshes: [] };
        const probe = await runMassing(massingSpecText(m, { outDir: dir, params: PARAMS }), dir);
        const walls = probe.report.faces.filter(f => f.kind === 'wall');
        expect(walls.length).toBe(43);
        const g = groupFacades(probe.report.faces);
        const front = g.groups.find(x => Math.abs(x.face.normal[2]) > 0.99)!;
        expect(front).toBeDefined();
        // the front's 40 walls (recesses, pier fronts and pier sides) are one facade about 30 m wide, on their mean plane
        expect(front.members.length).toBeGreaterThanOrEqual(38);
        expect(front.face.sMax - front.face.sMin).toBeGreaterThan(29);
        expect(front.face.tMax - front.face.tMin).toBeCloseTo(12, 6);
        for (const mb of front.members) expect(g.groupOf.get(mb.key)).toBe(front.face.key);
        expect(g.surveyFaces.some(f => f.key === front.face.key)).toBe(true);
        expect(g.surveyFaces.some(f => front.members.some(mb => mb.key === f.key))).toBe(false);
        // a reading on the facade: a window 1.2 m wide centred in each recess, a band across, a member on each pier
        const s0 = front.face.sMin;
        const recessCentre = (k: number) => {
            // the recess k runs x = 3k .. 3k + 2: its facade s, whichever way the facade's s runs
            const p = [3 * k + 1, 0, 0];
            return (p[0] - front.face.origin[0]) * front.face.axisS[0] + (p[2] - front.face.origin[2]) * front.face.axisS[2];
        };
        const pierCentre = (k: number) => recessCentre(k) + 2 * Math.sign(front.face.axisS[0]);
        const cols = Array.from({ length: 10 }, (_, k) => [recessCentre(k) - s0 - 0.6, recessCentre(k) - s0 + 0.6]);
        const items = programItems({
            wallColour: '#b0a090',
            openings: [{ h0: 2, h1: 4, archRise: 0.6, cols }],
            horizontal: [{ h: 6, u0: 0, u1: front.face.sMax - s0, profile: [[-0.15, 0], [0, 0.2], [0.15, 0]] }],
            vertical: [{ u: Array.from({ length: 10 }, (_, k) => pierCentre(k) - s0), h0: 0, h1: 12, profile: [[-0.3, 0], [0, 0.1], [0.3, 0]] }]
        }, front.face, 'g0_');
        const laid = layBack(front, items);
        expect(laid.droppedOpenings).toEqual([]);
        const all = [...laid.byMember.values()];
        const openings = all.flatMap(x => x.openings), sweeps = all.flatMap(x => x.faceSweeps);
        expect(openings).toHaveLength(10);
        // each window lies on a recess wall (normal facing the street) and keeps its width
        for (const o of openings) {
            const w = walls.find(f => f.key === o.face)!;
            expect(Math.abs(w.normal[2])).toBeGreaterThan(0.99);
            expect(w.sMax - w.sMin).toBeCloseTo(2, 6);
            expect(o.s1 - o.s0).toBeCloseTo(1.2, 6);
            expect(o.t0).toBeCloseTo(2, 6);
        }
        // the band: on the 20 walls facing the street (recesses and pier fronts), not on the pier sides
        const band = sweeps.filter(w => w.axis === 0);
        expect(band).toHaveLength(20);
        // the pier members: one on each pier front
        expect(sweeps.filter(w => w.axis === 1).flatMap(w => w.placements)).toHaveLength(10);
        const r = await runMassing(massingSpecText(m, { outDir: dir, params: PARAMS, openings, faceSweeps: sweeps }), dir);
        expect(r.report.rejectedOpenings).toEqual([]);
        expect(r.report.rejectedSweeps).toEqual([]);
        expect(r.nodes.filter(n => n.kind === 'opening')).toHaveLength(10);
        // the counts stay with the facade's first member, so the totals are the facade's
        expect(all.reduce((a, x) => a + x.counts.openings, 0)).toBe(10);
    });

    it('leaves a plain building alone', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g-facades-'));
        const m: Pick<Massing, 'parts' | 'meshes'> = { parts: [{ id: 'q', baseY: 0, topY: 9, loops: [[[0, 0], [12, 0], [12, -8], [0, -8]]], planes: [], heightSource: 'vector', heights: {} }], meshes: [] };
        const r = await runMassing(massingSpecText(m, { outDir: dir, params: PARAMS }), dir);
        const g = groupFacades(r.report.faces);
        expect(g.groups).toEqual([]);
        expect(g.surveyFaces).toEqual(r.report.faces);
    });
});
