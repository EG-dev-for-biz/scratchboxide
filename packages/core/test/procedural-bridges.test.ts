/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Bridges rebuilt from scratch in the likeness of the scan (procedural-bridges.ts) and the water under them
 * (procedural-ground.ts): a crossing over water is found and measured on a synthetic river and deck; the vision reading of
 * its elevation (three arches, as Princes Bridge read 2026-10-22) is parsed and applied (half-ellipse soffits between
 * springing and crown, solid supports between), and the mesh is built from it; the water's level and sheet come from the
 * scan over Google's water areas.
 */

import { describe, expect, it } from 'vitest';
import { applyBridgeReading, buildBridgeMesh, measureBridges, parseBridgeReading, type Bridge, type ScanProbe } from '../src/node/3d-engine/staged-location/procedural-bridges';
import { buildWaterSurface, measureWaterLevel } from '../src/node/3d-engine/staged-location/procedural-ground';

// a river 100 m wide (z 0..100) at y = -3; a deck 20 m wide along x = 0 at y = 8 crossing it; the banks at y = 0
const waterAt = (x: number, z: number) => z > 0 && z < 100;
const onDeck = (x: number, z: number) => Math.abs(x) <= 10 && z > -12 && z < 112;
const topAt = (x: number, z: number) => (onDeck(x, z) ? 8 : waterAt(x, z) ? -3 : 0);
const probe = { near: () => false } as unknown as ScanProbe;

describe('bridges', () => {
    it('finds the crossing and measures its deck and width', () => {
        const [b] = measureBridges({ lines: [[[0, -40], [0, 140]]], waterAt, topAt, groundAt: () => 0, within: () => true, waterY: -3, probe });
        expect(b).toBeDefined();
        expect(b.widthM).toBeGreaterThan(18);
        expect(b.widthM).toBeLessThan(22);
        expect(b.stations.filter(s => s.overWater).every(s => s.deckY === 8)).toBe(true);
        expect(b.lengthM).toBeGreaterThan(110);
    });

    it('parses and applies a reading: arched soffits over the openings, supports to the water between', () => {
        const r = parseBridgeReading(JSON.stringify({ openings: [{ fromM: 3, toM: 33, springM: 6, crownM: 9 }, { fromM: 37, toM: 67, springM: 6, crownM: 9 }, { fromM: 71, toM: 101, springM: 6, crownM: 9 }, { fromM: 5, toM: 4, crownM: 1 }], fasciaTopM: 11, parapetTopM: 12, repeats: [{ what: 'lamp posts', spacingM: 34, heightM: 3 }], colourSrgb: [75, 88, 300] }))!;
        expect(r.openings).toHaveLength(3);
        expect(r.colourSrgb).toEqual([75, 88, 255]);
        expect(r.repeats![0].spacingM).toBe(34);
        const [b] = measureBridges({ lines: [[[0, -40], [0, 140]]], waterAt, topAt, groundAt: () => 0, within: () => true, waterY: -3, probe });
        // the elevation's left edge at the chord's start minus 3 m (renderBridgeElevation's margin)
        const L = Math.hypot(b.stations.at(-1)!.x - b.stations[0].x, b.stations.at(-1)!.z - b.stations[0].z);
        const built: Bridge = applyBridgeReading(b, r, { s0: -(L + 6) / 2, lengthM: L, reversed: false });
        expect(built.piers).toBeGreaterThanOrEqual(2);
        const over = built.stations.filter(s => s.overWater);
        const highest = Math.max(...over.map(s => s.soffitY));
        expect(highest).toBeLessThanOrEqual(-3 + 9 + 1e-6);   // the crown
        expect(highest).toBeGreaterThan(-3 + 8.5);
        expect(over.some(s => s.soffitY === -3)).toBe(true);  // a support reaches the water
        const m = buildBridgeMesh(built, { x0: -50, z0: -50, widthM: 200, heightM: 200 });
        expect(m.deck.indices.length).toBeGreaterThan(0);
        expect(m.deck.uv.length / 2).toBe(m.deck.positions.length / 3);
        expect(m.body.indices.length).toBeGreaterThan(m.deck.indices.length);
    });

    it('measures the water level over the water areas and lays a sheet there, a cell wider than the water', () => {
        const within = () => true, bounds = { x0: -50, z0: -20, x1: 50, z1: 120 };
        expect(measureWaterLevel(waterAt, topAt, within, bounds)).toBe(-3);
        const w = buildWaterSurface({ waterAt, within, bounds, levelY: -3 });
        expect(w.cells).toBeGreaterThan(0);
        let minZ = Infinity, maxZ = -Infinity;
        for (let i = 0; i < w.positions.length; i += 3) { expect(w.positions[i + 1]).toBe(-3); minZ = Math.min(minZ, w.positions[i + 2]); maxZ = Math.max(maxZ, w.positions[i + 2]); }
        expect(minZ).toBeLessThan(0);
        expect(maxZ).toBeGreaterThan(100);
    });
});
