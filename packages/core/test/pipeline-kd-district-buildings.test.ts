/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { districtBuildingIndex, districtFootprints } from '../src/node/3d-engine/staged-location/pipeline-k/district-buildings';
import { signedFootprintDistance } from '../src/node/3d-engine/staged-location/pipeline-k/base-cleanup';
import { stagedPipelineK, stagedPipelineKD } from '../src/node/3d-engine/staged-location/pipeline-k/pipeline-k';

const square = (x0: number, z0: number, w: number): Array<[number, number]> => [[x0, z0], [x0 + w, z0], [x0 + w, z0 + w], [x0, z0 + w]];

describe('pipeline K-D: which building a point stands in', () => {
    it('finds the building by its footprint, a wall\'s width outside it too, and none in the street', () => {
        // two 20 m buildings sharing a party wall at x = 20, a third across a 30 m street
        const fps = districtFootprints([
            { id: 'a', parts: [{ loops: [square(0, 0, 20)] }] },
            { id: 'b', parts: [{ loops: [square(20, 0, 20)] }] },
            { id: 'c', parts: [{ loops: [square(0, 50, 20)] }, { loops: [square(20, 50, 10)] }] }
        ]);
        const at = districtBuildingIndex(fps);
        expect(at(5, 5)).toBe(0);
        expect(at(35, 5)).toBe(1);
        // deepest inside wins beside the party wall
        expect(at(19, 10)).toBe(0);
        expect(at(21, 10)).toBe(1);
        // a facade photo half a metre outside the footprint still belongs to it
        expect(at(-0.5, 10)).toBe(0);
        // the street between, and building c's second part
        expect(at(10, 35)).toBe(-1);
        expect(at(25, 55)).toBe(2);
    });

    it('is pipeline K throughout, and K-D only for a district', () => {
        expect(stagedPipelineK({ pipeline: 'kd' }, {})).toBe(true);
        expect(stagedPipelineKD({ pipeline: 'kd' })).toBe(true);
        expect(stagedPipelineKD({ pipeline: 'kd', isolate: true })).toBe(false);
        expect(stagedPipelineKD({ pipeline: 'k' })).toBe(false);
    });

    it('with no margin, gives the signed distance\'s answer everywhere: overlapping parts, shared walls, a many-sided outline', () => {
        // a station block drawn as overlapping parts (one of 400 sides), two halls sharing a wall, a building across the street
        const ring: Array<[number, number]> = Array.from({ length: 400 }, (_, i) => { const a = (i / 400) * 2 * Math.PI, r = 60 + 4 * Math.sin(9 * a); return [100 + r * Math.cos(a), 100 + r * Math.sin(a)]; });
        const fps = districtFootprints([
            { id: 'block', parts: [{ loops: [ring] }] },
            { id: 'hall', parts: [{ loops: [square(70, 70, 60)] }] },
            { id: 'annex', parts: [{ loops: [square(130, 70, 20)] }] },
            { id: 'across', parts: [{ loops: [square(0, 200, 30)] }, { loops: [square(10, 210, 10)] }] }
        ]);
        const at = districtBuildingIndex(fps, { marginM: 0, cellM: 20 });
        // the lookup it replaced: every building whose box holds the point, the least signed distance at most 0, the last of equals
        const slow = (x: number, z: number) => {
            let best = -1, bestD = 0;
            fps.forEach((b, k) => { const d = signedFootprintDistance(x, z, b.loops); if (d <= bestD) { bestD = d; best = k; } });
            return best;
        };
        const pts: Array<[number, number]> = [];
        for (let x = -10; x <= 200; x += 0.73) for (let z = -10; z <= 250; z += 0.91) pts.push([x, z]);
        for (const b of fps) for (const l of b.loops) for (let i = 0; i < l.length; i++) { const a = l[i], c = l[(i + 1) % l.length]; pts.push([a[0], a[1]], [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2]); }
        const wrong = pts.filter(([x, z]) => at(x, z) !== slow(x, z));
        expect(wrong).toEqual([]);
        // and the overlap is really there: inside both the block and the hall, the deeper one answers
        expect(at(100, 100)).toBe(slow(100, 100));
        expect([0, 1]).toContain(at(100, 100));
    });
});
