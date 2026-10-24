/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The massing choice on scans with a known answer (surface-agreement.ts, scan-sections.ts, massing-choice.ts):
 *  - a plain 20 x 10 x 30 m block whose one side is a party wall against a taller neighbour: the extruded block explains
 *    it (the hidden wall does not count against it) and is chosen over the more detailed section stack;
 *  - a slim 6 m shaft 60 m tall under a 30 m wide deck: the block covering the deck's plan fails, the section stack is chosen.
 */

import { describe, expect, it } from 'vitest';
import { sampleSurface, surfaceAgreement, unseenBesideNeighbours } from '../src/node/3d-engine/staged-location/pipeline-e/surface-agreement';
import { scanSlices, bandsFromSlices, partsFromBands, samplePartsSurface, SCAN_SECTION_PARAMS } from '../src/node/3d-engine/staged-location/pipeline-e/scan-sections';
import { chooseMassing } from '../src/node/3d-engine/staged-location/pipeline-e/massing-choice';
import type { MassingPart } from '../src/node/3d-engine/staged-location/pipeline-e/massing-spec';

/** A box's surface as triangles; `skip` names faces left out ('-x', '+x', '-z', '+z', 'bottom'). */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, skip: string[] = []): { pos: number[]; idx: number[] } {
    const pos: number[] = [], idx: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[]) => { const v = pos.length / 3; pos.push(...a, ...b, ...c, ...d); idx.push(v, v + 1, v + 2, v, v + 2, v + 3); };
    if (!skip.includes('-x')) quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]);
    if (!skip.includes('+x')) quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]);
    if (!skip.includes('-z')) quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]);
    if (!skip.includes('+z')) quad([x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1]);
    quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]);
    if (!skip.includes('bottom')) quad([x0, y0, z0], [x0, y0, z1], [x1, y0, z1], [x1, y0, z0]);
    return { pos, idx };
}
const prism = (id: string, loop: Array<[number, number]>, baseY: number, topY: number): MassingPart => ({ id, baseY, topY, loops: [loop], planes: [], heightSource: 'scan', heights: {} });

describe('massing choice', () => {
    it('keeps a plain block a block, and a party wall the scan cannot see does not count against it', () => {
        // the scan: the building's three open walls and roof (its +x wall is pressed against a 40 m neighbour)
        const b = box(0, 20, 0, 30, 0, 10, ['+x', 'bottom']);
        const scan = sampleSurface(b.pos, b.idx, 0.5);
        const block = samplePartsSurface([prism('block', [[0, 0], [20, 0], [20, 10], [0, 10]], 0, 30)], 0.5);
        const inPlan = (x: number, z: number) => x >= 0 && x <= 20 && z >= 0 && z <= 10;
        const top = (x: number, z: number) => (x > 20 && x < 30 && z >= -5 && z <= 15 ? 40 : inPlan(x, z) ? 30 : 0);
        const blind = surfaceAgreement(scan, block, 1, { groundY: 0 });
        const seen = surfaceAgreement(scan, block, 1, { groundY: 0, unseen: unseenBesideNeighbours(top, inPlan) });
        expect(blind.banded.precision).toBeLessThan(0.9);        // the hidden wall counted against it
        expect(seen.banded.precision).toBeGreaterThan(0.95);     // ... and not, once it is known to be unseen
        expect(seen.banded.precision - blind.banded.precision).toBeGreaterThan(0.08);
        expect(seen.banded.coverage).toBeGreaterThan(0.95);
        const slices = scanSlices(scan, 0, { ...SCAN_SECTION_PARAMS, cellM: 0.5 });
        const stack = samplePartsSurface(partsFromBands(bandsFromSlices(slices, 0.85, { ...SCAN_SECTION_PARAMS, cellM: 0.5 }), 's', { ...SCAN_SECTION_PARAMS, cellM: 0.5 }), 0.5);
        const choice = chooseMassing([
            { label: 'block', complexity: 12, agreement: seen },
            { label: 'sections', complexity: 1000, agreement: surfaceAgreement(scan, stack, 1, { groundY: 0, unseen: unseenBesideNeighbours(top, inPlan) }) }
        ]);
        expect(choice.chosen).toBe('block');
        expect(choice.explains).toBe(true);
    });

    it('gives a slim shaft under a wide deck the shape its scan demands, not the block of its plan', () => {
        const shaft = box(-3, 3, 0, 60, -3, 3, ['bottom']), deck = box(-15, 15, 60, 66, -15, 15);
        const n = shaft.pos.length / 3;
        const scan = sampleSurface([...shaft.pos, ...deck.pos], [...shaft.idx, ...deck.idx.map(i => i + n)], 0.5);
        const block = samplePartsSurface([prism('block', [[-15, -15], [15, -15], [15, 15], [-15, 15]], 0, 66)], 0.5);
        const P = { ...SCAN_SECTION_PARAMS, cellM: 0.5 };
        const parts = partsFromBands(bandsFromSlices(scanSlices(scan, 0, P), 0.5, P), 's', P);
        const stacked = samplePartsSurface(parts, 0.5);
        const choice = chooseMassing([
            { label: 'block', complexity: 12, agreement: surfaceAgreement(scan, block, 1, { groundY: 0 }) },
            { label: 'sections', complexity: parts.length * 8, agreement: surfaceAgreement(scan, stacked, 1, { groundY: 0 }) }
        ]);
        expect(choice.candidates[0].accepted).toBe(false);
        expect(choice.chosen).toBe('sections');
        expect(choice.explains).toBe(true);
        // the stack's widest band is the deck, near its top; its narrowest is the shaft
        const widths = parts.map(p => Math.max(...p.loops[0].map(q => q[0])) - Math.min(...p.loops[0].map(q => q[0])));
        expect(Math.max(...widths)).toBeGreaterThan(28);
        expect(Math.min(...widths)).toBeLessThan(8);
    });
});
