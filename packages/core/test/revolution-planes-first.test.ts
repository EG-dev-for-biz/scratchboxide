/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Planes first for solids of revolution (revolution-fit.ts polygonalSections): a square tower whose blobby scan the fit
 * took for round (St Paul's west towers, 2026-10-22: rebuilt as cylinders with cone hats) is vetoed, naming its sides; a
 * round tower and an eight-faceted dome stay revolutions.
 */

import { describe, expect, it } from 'vitest';
import { parseRevolutionPlan, planVetoReason, polygonalSections, vectorOutlineVeto } from '../src/node/3d-engine/staged-location/revolution-fit';

/** Points on a vertical prism around (0, 0): `radiusAt(theta)` the outline, y from 0 to 20, a little noise. */
function tower(radiusAt: (t: number) => number): Float32Array {
    const out: number[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.1;
    for (let y = 0.1; y < 20; y += 0.25) for (let k = 0; k < 360; k += 2) {
        const t = (k / 180) * Math.PI, r = radiusAt(t) + rnd();
        const x = r * Math.cos(t), z = r * Math.sin(t);
        out.push(x, y, z, x, y + 0.01, z, x + 0.001, y, z + 0.001);   // a sliver triangle at the point (the scan as triangle soup)
    }
    return Float32Array.from(out);
}
const record = (R: number) => ({ axis: { x: 0, z: 0 } as never, envelope: Array.from({ length: 21 }, (_, y) => [y, R] as [number, number]), stacks: [{ yBottom: 0, yTop: 20, cap: null } as never] });
// a square of half-side 3 (rounded a little, as a scan blurs corners)
const square = (t: number) => { const a = Math.PI / 2, u = ((((t - Math.PI / 4) % a) + a) % a) - a / 2; return Math.min(3 / Math.cos(u), 3.9); };

describe('planes first for revolutions', () => {
    it('vetoes a square tower the fit took for round, naming its sides', () => {
        const v = polygonalSections(record(4), tower(square));
        expect(v.tested).toBeGreaterThan(10);
        expect(v.sides).toBe(4);
        expect(v.reason).toMatch(/planes first: \d+ of \d+ sections of its body are a 4-sided polygon/);
    });

    it('keeps a round tower and an eight-faceted dome body', () => {
        expect(polygonalSections(record(3), tower(() => 3)).reason).toBeUndefined();
        expect(polygonalSections(record(9), tower(t => 8.45 * (1 + 0.037 * Math.cos(8 * t)))).reason).toBeUndefined();
    });
    it('vetoes on the plan view: a square tower goes, octagons stay (the replies Flinders Street gave)', () => {
        const reply = (t: string) => parseRevolutionPlan(t);
        expect(planVetoReason(reply('{"plan":"polygon","sides":4,"confidence":0.9,"what":"square tower with an octagonal spire"}'))).toMatch(/planes first: seen straight down on the tile photo it is a 4-sided polygon \(square tower/);
        expect(planVetoReason(reply('{"plan":"polygon","sides":8,"confidence":0.98,"what":"octagonal copper-clad dome"}'))).toBeUndefined();
        expect(planVetoReason(reply('{"plan":"circle","confidence":0.9,"what":"round drum"}'))).toBeUndefined();
        expect(planVetoReason(reply('{"plan":"polygon","sides":4,"confidence":0.3,"what":"unsure"}'))).toBeUndefined();
        expect(planVetoReason(reply('not json'))).toBeUndefined();
    });

    it('vetoes where a comparable few-cornered vector part stands under the axis, not a round one', () => {
        const r = { axis: { x: 0, z: 0 } as never, plan: { r: 4 } as never };
        expect(vectorOutlineVeto(r, [[[-3.5, -3.5], [3.5, -3.5], [3.5, 3.5], [-3.5, 3.5]]])).toMatch(/4-cornered outline/);
        const round = Array.from({ length: 24 }, (_, i) => [4 * Math.cos(i * Math.PI / 12), 4 * Math.sin(i * Math.PI / 12)] as [number, number]);
        expect(vectorOutlineVeto(r, [round])).toBeUndefined();
        expect(vectorOutlineVeto(r, [[[-40, -40], [40, -40], [40, 40], [-40, 40]]])).toBeUndefined();   // a whole cathedral: not comparable
    });
});

