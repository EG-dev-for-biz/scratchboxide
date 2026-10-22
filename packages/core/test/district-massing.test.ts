/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * District massing (district-massing.ts): every building massed from its vector footprint and the scan's surface, and checked
 * building by building. A building the scan shows standing whole is rebuilt at the scanned height; one over flat street is
 * not (vector and scan disagree); one running past the extraction is not (the scan holds part of it); one whose scan spills
 * well past its footprint is not (the footprint is too small); each says why.
 */

import { describe, expect, it } from 'vitest';
import { massDistrict } from '../src/node/3d-engine/staged-location/district-massing';
import { evidenceLookup, type VectorEvidence } from '../src/node/3d-engine/staged-location/vector-footprints';
import type { Vec2 } from '../src/common/spatial/staged-location-contracts';

const rect = (x0: number, z0: number, x1: number, z1: number): Vec2[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
const building = (id: string, ring: Vec2[], heightM: number) => ({ id, parts: [[ring]], heightM, extruded: [{ loops: [ring], heightM }] });

describe('massDistrict', () => {
    it('rebuilds the building the scan shows whole, and says why it leaves the others as scanned', () => {
        const ev: VectorEvidence = {
            buildings: [
                building('whole', rect(-20, -20, -5, -5), 18),
                building('flat', rect(5, -20, 20, -5), 12),           // the scan shows street here
                building('edge', rect(35, -5, 55, 5), 15),            // runs past a 45 m extraction
                building('small', rect(-20, 10, -14, 16), 9)          // the scan stands 9 m over a 12 x 12 m block here
            ], water: [], roads: [], tiles: 1, zoom: 17
        };
        const look = evidenceLookup(ev, 60);
        const top = (x: number, z: number) => {
            if (x >= -20 && x <= -5 && z >= -20 && z <= -5) return 2 + 18;
            if (x >= 35 && x <= 55 && z >= -5 && z <= 5) return 2 + 15;
            if (x >= -23 && x <= -11 && z >= 7 && z <= 19) return 2 + 9;
            return 2;
        };
        const rows = massDistrict({ buildings: ev.buildings, look, ground: { groundAt: () => 2, topAt: top }, within: (x, z) => Math.hypot(x, z) <= 45 });
        const by = (id: string) => rows.find(r => r.id === id)!;
        expect(rows).toHaveLength(4);
        const whole = by('whole');
        expect(whole.ok).toBe(true);
        expect(whole.raisedShare).toBe(1);
        expect(whole.groundY).toBe(2);
        expect(whole.massing!.parts.length).toBeGreaterThanOrEqual(1);
        expect(whole.massing!.parts[whole.massing!.parts.length - 1].topY).toBeCloseTo(20, 0);
        expect(by('flat')).toMatchObject({ ok: false, raisedShare: 0 });
        expect(by('flat').reason).toMatch(/disagree that a building stands here/);
        expect(by('edge').ok).toBe(false);
        expect(by('edge').reason).toMatch(/runs past the extraction/);
        expect(by('small').ok).toBe(false);
        expect(by('small').overhangShare).toBeGreaterThan(0.35);
        expect(by('small').reason).toMatch(/smaller than what was scanned/);
    });
});
