/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A replicate read with more repeats than the OrnamentSpec takes per axis (400) is split into blocks that place the
 * same instances, so the spec validates instead of failing the whole ornament stage (live arch run: "800 > 400").
 */

import { describe, expect, it } from 'vitest';
import { ORNAMENT_REPLICATE_MAX_COUNT, PROVENANCE, validateContract, type OperatorSpec, type OrnamentElement } from '../src/common/spatial/staged-location-contracts';
import { splitOversizeReplicates } from '../src/node/3d-engine/staged-location/ornament-expand';

const seed = { operator: 'relief', relief: { surfaceId: 's0', region: { outer: [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]] }, height: { panel: { depthM: -0.005, edgeWidthM: 0, edgeProfile: [[0, 0], [1, 1]] } }, maxEdgeM: 0.05 } } as const;

function element(id: string, spec: OperatorSpec, buildOrder: number): OrnamentElement {
    return {
        id, slotId: 'slot0', spec, confidence: 0.8, depthBasis: 'shadow', evidence: [{ imageId: 'sv:x', box1000: [0, 0, 10, 10] }],
        checks: { slotOverlap: 1, minFeatureM: 0.01, nativeSampleM: 0.01 },
        provenance: { label: PROVENANCE.photoInferred, measuredGeometry: false, confidence: 0.8, method: 'test', sources: [] }, buildOrder
    } as OrnamentElement;
}

/** Every instance offset a lattice places (what scratchbox_ornament.hpp builds). */
function latticeInstances(spec: OperatorSpec): string[] {
    if (spec.operator !== 'replicate' || !('lattice' in spec.replicate.domain)) return [];
    const g = spec.replicate.domain.lattice;
    const out: string[] = [];
    for (let j = 0; j < g.counts[1]; j++) for (let i = 0; i < g.counts[0]; i++) {
        out.push(`${(g.originUv[0] + i * g.pitchUv[0] + (j % 2) * g.rowOffsetU).toFixed(6)},${(g.originUv[1] + j * g.pitchUv[1]).toFixed(6)}`);
    }
    return out;
}

describe('ornament replicate limit', () => {
    it('splits a lattice read past the per-axis limit into blocks placing the same instances, and each block validates', () => {
        const big: OperatorSpec = { operator: 'replicate', replicate: { seed: seed as any, alignToSurface: true, domain: { lattice: { originUv: [0.1, 0.2], pitchUv: [0.012, 0.03], counts: [800, 401], rowOffsetU: 0.006 } } } };
        expect(validateContract('operatorSpec' as any, big).join(' ')).toMatch(/800 is above the maximum 400/);
        const small: OperatorSpec = { operator: 'replicate', replicate: { seed: seed as any, alignToSurface: true, domain: { lattice: { originUv: [0, 0], pitchUv: [0.1, 0.1], counts: [3, 2], rowOffsetU: 0 } } } };
        const res = splitOversizeReplicates([element('e000', small, 0), element('e001', big, 1)]);
        expect(res.split).toEqual([{ elementId: 'e001', parts: ['e001', 'e001-2', 'e001-3', 'e001-4'], before: '800 × 401' }]);
        expect(res.elements.map(e => e.id)).toEqual(['e000', 'e001', 'e001-2', 'e001-3', 'e001-4']);
        expect(res.elements.map(e => e.buildOrder)).toEqual([0, 1, 2, 3, 4]);
        for (const e of res.elements) expect(validateContract('operatorSpec' as any, e.spec)).toEqual([]);
        for (const e of res.elements.slice(1)) {
            const g = (e.spec as any).replicate.domain.lattice;
            expect(Math.max(...g.counts)).toBeLessThanOrEqual(ORNAMENT_REPLICATE_MAX_COUNT);
            expect(e.provenance.note).toMatch(/read as one replicate of 800 × 401; split into 4 blocks/);
        }
        // the same instances, row-offset phase included
        const before = latticeInstances(big).sort();
        const after = res.elements.slice(1).flatMap(e => latticeInstances(e.spec)).sort();
        expect(after).toEqual(before);
        expect(after.length).toBe(800 * 401);
        // a reading within the limit is returned as it is
        expect(splitOversizeReplicates([element('e000', small, 7)]).elements[0].buildOrder).toBe(7);
    });

    it('splits a run along an edge into runs whose start offsets continue the pitch', () => {
        const run: OperatorSpec = { operator: 'replicate', replicate: { seed: seed as any, alignToSurface: true, domain: { along: { carrier: { slot: { slotId: 'slot0', t0: 0, t1: 1, offset: [0, 0] } }, pitchM: 0.02, count: 900, startOffsetM: 0.1 } } } };
        const res = splitOversizeReplicates([element('e002', run, 0)]);
        const runs = res.elements.map(e => (e.spec as any).replicate.domain.along);
        expect(runs.map((a: any) => a.count)).toEqual([400, 400, 100]);
        expect(runs.map((a: any) => Number(a.startOffsetM.toFixed(6)))).toEqual([0.1, 8.1, 16.1]);
        for (const e of res.elements) expect(validateContract('operatorSpec' as any, e.spec)).toEqual([]);
    });
});
