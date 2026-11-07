import { describe, expect, it } from 'vitest';
import { kFootprintLoops } from '../src/node/3d-engine/staged-location/orchestrator';

type V = [number, number];
const square = (x: number, z: number, s: number): V[] => [[x, z], [x + s, z], [x + s, z + s], [x, z + s]];

describe("pipeline K's footprint loops (kFootprintLoops)", () => {
    it("takes a building's modelled parts when it has them, and leaves its plan-only parts and plan out", () => {
        const loops = kFootprintLoops([{
            parts: [[square(0, 0, 50)]],
            extruded: [{ loops: [square(0, 0, 20)] }, { loops: [square(30, 0, 10)], planOnly: true }]
        }]);
        expect(loops).toEqual([square(0, 0, 20)]);
    });

    it('takes the plan-only parts when the building has no modelled part', () => {
        const loops = kFootprintLoops([{ parts: [[square(0, 0, 50)]], extruded: [{ loops: [square(5, 5, 30)], planOnly: true }] }]);
        expect(loops).toEqual([square(5, 5, 30)]);
    });

    it("takes the vector tile's plan footprint when Google gives no extruded part at all, instead of nothing", () => {
        const plan = square(10, 20, 40);
        expect(kFootprintLoops([{ parts: [[plan, square(20, 30, 5)]] }])).toEqual([plan]);
        expect(kFootprintLoops([{ parts: [[plan]], extruded: [] }])).toEqual([plan]);
    });

    it('gathers every building of a structure, and drops rings under three corners', () => {
        const loops = kFootprintLoops([
            { parts: [[square(0, 0, 10)]] },
            { parts: [[[[0, 0], [1, 1]]]], extruded: [{ loops: [square(100, 0, 10)] }] },
            { parts: [[[[0, 0], [1, 1]]]] }
        ]);
        expect(loops).toEqual([square(0, 0, 10), square(100, 0, 10)]);
    });
});
