/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * When Google's vector data has no building footprint at a place (orchestrator.ts: eBuildings empty), pipeline E/G used
 * to be unable to run at all and the build fell back to an unstructured remeshed scan. scanDerivedFootprint builds a
 * fallback VectorBuilding from the structure's own convex outline on the scan (already computed in the tiles stage
 * regardless of vector data) instead, so pipeline E's buildMassing still has a footprint to extrude. Its provenance
 * token (SCAN_FOOTPRINT_TOKEN) must report honestly as 'measured' (a real, simplified measurement of the scan), not
 * fall through to massingProvenance's 'vector-massing' default.
 */

import { describe, expect, it } from 'vitest';
import { scanDerivedFootprint } from '../src/node/3d-engine/staged-location/orchestrator';
import { buildMassing } from '../src/node/3d-engine/staged-location/pipeline-e/massing-spec';
import { massingProvenance, SCAN_FOOTPRINT_TOKEN } from '../src/node/3d-engine/staged-location/pipeline-e/pipeline-e';
import type { Vec2 } from '../src/common/spatial/staged-location-contracts';

const square = (half: number): Vec2[] => [[-half, -half], [half, -half], [half, half], [-half, half]];

describe('scanDerivedFootprint', () => {
    it('builds a fallback VectorBuilding from the structure\'s own scan outline and height, labelled with the scan-footprint token', () => {
        const b = scanDerivedFootprint({ outline: square(10), heightM: 12 });
        expect(b).toBeDefined();
        expect(b!.extruded).toEqual([{ loops: [square(10)], heightM: 12 }]);
        expect(b!.provenance).toBe(SCAN_FOOTPRINT_TOKEN);
    });

    it('returns undefined when there is no structure to fall back on', () => {
        expect(scanDerivedFootprint(undefined)).toBeUndefined();
    });

    it('returns undefined when the outline is degenerate (fewer than 3 points)', () => {
        expect(scanDerivedFootprint({ outline: [[0, 0], [1, 0]], heightM: 12 })).toBeUndefined();
        expect(scanDerivedFootprint({ outline: [], heightM: 12 })).toBeUndefined();
    });
});

describe('a scan-derived footprint through buildMassing', () => {
    it('extrudes to a real part at the structure\'s measured height, and massingProvenance labels it measured (not vector-massing)', () => {
        const scanTop = (x: number, z: number) => (Math.abs(x) <= 10 && Math.abs(z) <= 10 ? 12 : 0);
        const building = scanDerivedFootprint({ outline: square(10), heightM: 12 })!;
        const massing = buildMassing({ buildings: [building], groundY: 0, scanTop, cells: new Set(['0,0']) });
        expect(massing.parts).toHaveLength(1);
        const [part] = massing.parts;
        expect(part.topY).toBeCloseTo(12, 6);
        expect(part.provenance).toBe(SCAN_FOOTPRINT_TOKEN);

        const record = massingProvenance(part, massing);
        expect(record.label).toBe('measured');
        expect(record.measuredGeometry).toBe(true);
        expect(record.method).toMatch(/no Google vector footprint/);
    });

    it('a part with no provenance token (a real vector building) still falls through to the vector-massing label, unaffected', () => {
        const scanTop = (x: number, z: number) => (Math.abs(x) <= 10 && Math.abs(z) <= 10 ? 12 : 0);
        const massing = buildMassing({ buildings: [{ id: 'vec', parts: [], extruded: [{ loops: [square(10)], heightM: 12 }] }], groundY: 0, scanTop, cells: new Set(['0,0']) });
        const record = massingProvenance(massing.parts[0], massing);
        expect(record.label).toBe('vector-massing');
    });
});
