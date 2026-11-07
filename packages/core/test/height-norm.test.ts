/**
 * The place height norm (height-norm.ts) and the first paint's use of it (vector-first-paint.ts): a footprint with no
 * height takes the height its measured neighbours make plausible, never a measured height's place; a 2D-only footprint
 * under another feature's modelled volume is not drawn. Synthetic districts with known heights; no network, no native.
 */
import { describe, expect, it } from 'vitest';
import { estimateHeight, fitHeightNorm, footprintNumbers, HEIGHT_NORM_MIN_SAMPLES, type NormSample } from '../src/node/3d-engine/staged-location/height-norm';
import { paintGeneratedHeightProvenance, PLAUSIBLE_DEFAULT_HEIGHT_M, selectPaintBuildings } from '../src/node/3d-engine/staged-location/vector-first-paint';
import type { VectorBuilding, VectorEvidence } from '../src/node/3d-engine/staged-location/vector-footprints';

type V2 = [number, number];
const rect = (x: number, z: number, w: number, d: number): V2[] => [[x, z], [x + w, z], [x + w, z + d], [x, z + d]];
const ev = (buildings: VectorBuilding[]): VectorEvidence => ({ buildings, water: [], roads: [], tiles: 1, zoom: 17 });

/** Two neighbourhoods 400 m apart: towers (60 m) on the west, row houses (9 m) on the east. */
function district(): VectorBuilding[] {
    const out: VectorBuilding[] = [];
    for (let i = 0; i < 6; i++) for (let k = 0; k < 4; k++) {
        out.push({ id: `t${i}_${k}`, parts: [[rect(-300 + i * 30, k * 30, 20, 20)]], extruded: [{ loops: [rect(-300 + i * 30, k * 30, 20, 20)], heightM: 58 + ((i + k) % 3) * 2 }] });
        out.push({ id: `r${i}_${k}`, parts: [[rect(150 + i * 15, k * 15, 8, 10)]], extruded: [{ loops: [rect(150 + i * 15, k * 15, 8, 10)], heightM: 8 + ((i * k) % 3) }] });
    }
    return out;
}

describe('height norm', () => {
    it('reads area, perimeter and centroid from the loops, holes taken off', () => {
        const f = footprintNumbers([rect(0, 0, 10, 20), rect(2, 2, 2, 2)])!;
        expect(f.areaM2).toBeCloseTo(196, 6);
        expect(f.perimeterM).toBeCloseTo(68, 6);
        expect(f.centroid[0]).toBeCloseTo(5, 6);
        expect(f.centroid[1]).toBeCloseTo(10, 6);
    });

    it('has no norm below the minimum sample count', () => {
        const s: NormSample[] = Array.from({ length: HEIGHT_NORM_MIN_SAMPLES - 1 }, (_, i) => ({ centroid: [i * 10, 0], areaM2: 100, perimeterM: 40, heightM: 10 }));
        expect(fitHeightNorm(s, { constantM: 12 })).toBeUndefined();
    });

    it('estimates from the neighbourhood: a tower plot reads tall, a row-house plot low, both far better than the constant under leave-one-out', () => {
        const samples = district().map(b => ({ ...footprintNumbers(b.extruded![0].loops)!, heightM: b.extruded![0].heightM! }));
        const m = fitHeightNorm(samples, { constantM: 12 })!;
        expect(m.samples).toHaveLength(48);
        expect(m.looMaeM).toBeLessThan(3);
        expect(m.looMaeConstM).toBeGreaterThan(20);
        const tower = estimateHeight(m, footprintNumbers([rect(-120, 0, 20, 20)])!);
        const row = estimateHeight(m, footprintNumbers([rect(240, 0, 8, 10)])!);
        expect(tower.heightM).toBeGreaterThan(50);
        expect(row.heightM).toBeLessThan(13);
        expect(tower.lowM).toBeLessThanOrEqual(tower.heightM);
        expect(tower.highM).toBeGreaterThanOrEqual(tower.heightM);
        expect(tower.confidence).toBeLessThanOrEqual(0.6);
    });

    it('is deterministic: the same samples give the same widths and answers', () => {
        const samples = district().map(b => ({ ...footprintNumbers(b.extruded![0].loops)!, heightM: b.extruded![0].heightM! }));
        const a = fitHeightNorm(samples, { constantM: 12 })!, b = fitHeightNorm(samples.slice(), { constantM: 12 })!;
        expect(b.sigma).toEqual(a.sigma);
        expect(b.looMaeM).toBe(a.looMaeM);
    });
});

describe('first paint with the place norm', () => {
    it('raises a height-less footprint among towers to a tower height, labelled generated, and leaves measured parts alone', () => {
        const blds = [...district(), { id: 'gap', parts: [[rect(-120, 0, 20, 20)]], extruded: [{ loops: [rect(-120, 0, 20, 20)], planOnly: true }] } as VectorBuilding];
        const sel = selectPaintBuildings(ev(blds), 1000, { heightNorm: true });
        const gap = sel.buildings.find(b => b.id === 'gap')!;
        expect(gap.heightGuessed).toBe(true);
        expect(gap.parts[0].topH).toBeGreaterThan(40);
        expect(gap.heightEstimate!.heightM).toBe(gap.parts[0].topH);
        expect(sel.heightNorm!.samples).toBe(48);
        expect(sel.buildings.find(b => b.id === 't0_0')!.parts[0].topH).toBe(58);
        const prov = paintGeneratedHeightProvenance('vectortiles:x', sel.heightNorm);
        expect(prov.label).toBe('generated');
        expect(prov.measuredGeometry).toBe(false);
        expect(prov.method).toMatch(/48 measured footprints/);
    });

    it('holds a kiosk-sized footprint under the place slenderness instead of a needle', () => {
        const blds = [...district(), { id: 'kiosk', parts: [[rect(-120, 0, 2, 2)]], extruded: [{ loops: [rect(-120, 0, 2, 2)], planOnly: true }] } as VectorBuilding];
        const sel = selectPaintBuildings(ev(blds), 1000, { heightNorm: true });
        const k = sel.buildings.find(b => b.id === 'kiosk')!;
        expect(k.parts[0].topH).toBeLessThanOrEqual(sel.heightNorm!.maxSlenderness * 2 + 1e-6);
        expect(sel.heightNorm!.capped).toBeGreaterThanOrEqual(1);
    });

    it('keeps the plain default when off', () => {
        const blds = [...district(), { id: 'gap', parts: [[rect(-120, 0, 20, 20)]], extruded: [{ loops: [rect(-120, 0, 20, 20)], planOnly: true }] } as VectorBuilding];
        const sel = selectPaintBuildings(ev(blds), 1000, { heightNorm: false });
        expect(sel.buildings.find(b => b.id === 'gap')!.parts[0].topH).toBe(PLAUSIBLE_DEFAULT_HEIGHT_M);
        expect(sel.heightNormSkipped).toMatch(/off/);
    });

    it('does not draw a 2D-only footprint under another feature\'s modelled volume, and counts it', () => {
        const vol = { vertices: [[0, 0, 0], [40, 0, 0], [40, 0, 40], [0, 0, 40], [0, 80, 0], [40, 80, 0], [40, 80, 40], [0, 80, 40]] as Array<[number, number, number]>, indices: [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6], heightM: 80 };
        const blds: VectorBuilding[] = [
            { id: 'tower', parts: [], volumes: [vol] },
            { id: 'dup', parts: [[rect(5, 5, 30, 30)]], extruded: [{ loops: [rect(5, 5, 30, 30)], planOnly: true }] },
            { id: 'beside', parts: [[rect(60, 5, 10, 10)]], extruded: [{ loops: [rect(60, 5, 10, 10)], planOnly: true }] }
        ];
        const sel = selectPaintBuildings(ev(blds), 1000, { heightNorm: false, volumeDedup: true });
        expect(sel.buildings.map(b => b.id).sort()).toEqual(['beside', 'tower']);
        expect(sel.buildingsUnderOtherVolume).toBe(1);
        expect(sel.buildingsGivenDefaultHeight).toBe(1);
        const off = selectPaintBuildings(ev(blds), 1000, { heightNorm: false, volumeDedup: false });
        expect(off.buildings).toHaveLength(3);
    });
});
