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
});
