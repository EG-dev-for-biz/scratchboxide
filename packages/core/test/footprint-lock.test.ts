/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** The footprint lock: the massing stands on the footprint (Google's, else the tiles' plan), height from Solar first. */

import { describe, expect, it } from 'vitest';
import { footprintConformance, FOOTPRINT_MAX_PROJECTION_M } from '../src/node/3d-engine/staged-location/footprint-lock';
import { buildMassing } from '../src/node/3d-engine/staged-location/pipeline-e/massing-spec';
import { MASSING_PARAMS } from '../src/node/3d-engine/staged-location/pipeline-e/pipeline-e';
import { G_BUILD_PARAMS } from '../src/node/3d-engine/staged-location/pipeline-g/pipeline-g';

const square: Array<[number, number]> = [[0, 0], [20, 0], [20, -10], [0, -10]];
const cells = new Set<string>();
for (let x = 0; x < 20; x++) for (let z = -10; z < 0; z++) cells.add(`${x},${z}`);

describe('the footprint lock', () => {
    it('measures a built mesh against its footprint: walls on it pass, a cornice within the limit passes, a wall moved off it fails', () => {
        const on = [0, 0, 0, 20, 0, 0, 20, 12, -10, 0, 12, -10];
        expect(footprintConformance(on, [square])).toMatchObject({ outsideShare: 0, maxOutsideM: 0, ok: true });
        const cornice = [...on, 10, 12, 0.8];
        expect(footprintConformance(cornice, [square])).toMatchObject({ maxOutsideM: 0.8, ok: true });
        const moved = [...on, 10, 6, FOOTPRINT_MAX_PROJECTION_M + 0.5];
        expect(footprintConformance(moved, [square]).ok).toBe(false);
    });

    it('no rebuild moves a wall onto the scan: the native snap is off for E (and everything built on it) and for G', () => {
        expect(MASSING_PARAMS.snapMaxM).toBe(0);
        expect(G_BUILD_PARAMS.snapMaxM).toBe(0);
    });

    it('with no Google building, the massing stands on the 3D tiles plan of the structure', () => {
        const m = buildMassing({ buildings: [], groundY: 0, scanTop: () => 12, cells, preferExtrusion: true });
        expect(m.parts.length).toBe(1);
        expect(m.notes.join(' ')).toMatch(/scan's plan of the structure/);
    });

    it('takes the height from the Solar API where it agrees with the scan, else the scan\'s own, and says so', () => {
        const building = { id: 'b', parts: [], extruded: [{ loops: [square], heightM: 14 }] };
        const solar = [{ x: 10, z: -5, y: 16, pitchDeg: 2, azimuthDeg: 180, areaM2: 150 } as any];
        // Solar 16 m and vector 14 m against a 10 m scan: the scan leads, both disagreements said
        const m = buildMassing({ buildings: [building], groundY: 0, scanTop: () => 10, cells, solar, preferExtrusion: true });
        expect(m.parts[0]).toMatchObject({ heightSource: 'scan', topY: 10 });
        expect(m.notes.join(' ')).toMatch(/height from the scan \(10\.0 m\); Solar 16\.0 m and vector 14\.0 m disagreed by more than/);
        // Solar within the agreement of the scan: Solar's height, as measured
        const agreeing = buildMassing({ buildings: [building], groundY: 0, scanTop: () => 15, cells, solar, preferExtrusion: true });
        expect(agreeing.parts[0]).toMatchObject({ heightSource: 'solar', topY: 16 });
        // no scan roof at all: Solar stands in, and says the scan has none
        const noScan = buildMassing({ buildings: [building], groundY: 0, scanTop: () => NaN, cells, solar, preferExtrusion: true });
        expect(noScan.parts[0]).toMatchObject({ heightSource: 'solar', topY: 16 });
        expect(noScan.notes.join(' ')).toMatch(/the scan has no roof here/);
    });

    it('reads a gently pitched Solar facet as a flat roof (level wall tops), a steep one as the roof it is', () => {
        const building = { id: 'b', parts: [], extruded: [{ loops: [square], heightM: 14 }] };
        const flat = { x: 10, z: -5, y: 14, pitchDeg: 2, azimuthDeg: 180, areaM2: 40 } as any;
        const gentle = { x: 10, z: -5, y: 14.5, pitchDeg: 11, azimuthDeg: 180, areaM2: 150 } as any;
        const steep = { x: 10, z: -5, y: 15, pitchDeg: 35, azimuthDeg: 180, areaM2: 150 } as any;
        const a = buildMassing({ buildings: [building], groundY: 0, scanTop: () => 14, cells, solar: [flat, gentle], preferExtrusion: true });
        expect(a.parts[0].planes.length).toBe(0);
        // the steep facet is the roof when the scan slopes with it; over a scan that is flat at 14 m it contradicts the
        // measurement and is not this roof (the Flatiron's 12 facets, all kept, put its massing 22.9 m off the scan)
        const sloping = (_x: number, z: number) => Math.max(1, 15 - Math.tan((35 * Math.PI) / 180) * (z + 5));
        const b = buildMassing({ buildings: [building], groundY: 0, scanTop: sloping, cells, solar: [flat, steep], preferExtrusion: true });
        expect(b.parts[0].planes.length).toBe(1);
        const c = buildMassing({ buildings: [building], groundY: 0, scanTop: () => 14, cells, solar: [flat, steep], preferExtrusion: true });
        expect(c.parts[0].planes.length).toBe(0);
        expect(c.solar.pitchedRejected).toBe(1);
    });
});
