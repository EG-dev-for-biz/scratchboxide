/**
 * texture-repeat.ts: the missing rung between the real-photo rungs and the flat palette (docs/processes/texture_repeat_inference.md).
 * Synthetic atlases only (no network, no model, no native build): a periodic plane with gaps must be filled correctly
 * with a stated confidence and the 'inferred-repeat' label; an irregular plane (the Jefferson Market cautionary case)
 * must be refused with a reason on every axis and left untouched, never a fabricated repeat.
 */
import { describe, expect, it } from 'vitest';
import {
    packConfidenceTexel, unpackConfidenceTexel, TEXTURE_LADDER_RUNGS, type BakedTexturePlanes, type UvAtlas
} from '../src/common/spatial/texture-pass-contracts';
import { SRGB8_TO_LINEAR, linearToSrgb255 } from '../src/common/spatial/photogrammetric-delight';
import {
    detectPlaneRepeats, repeatFill, K_SIGMA, MIN_REPEATS, NCC_GATE, MIN_BIN_SAMPLES, MIN_DONORS, MAX_DONOR_RUNG,
    DONOR_SEARCH_PERIODS, MAX_DONOR_SEARCH_PERIODS
} from '../src/node/3d-engine/staged-location/texture-repeat';

const RUNG_REPEATED = TEXTURE_LADDER_RUNGS.indexOf('repeated same-plane fill');
const RUNG_PALETTE = TEXTURE_LADDER_RUNGS.indexOf('measured palette colour');
const RUNG_STREET_VIEW = 0;

/** A flat atlas: one map covering every texel, no gutter, 1 texel = 10 cm (texelsPerMeter = 10). */
function flatAtlas(width: number, height: number, texelsPerMeter = 10): UvAtlas {
    const n = width * height;
    return {
        layerKey: 'l', width, height,
        maps: [{ nodeName: 'facade', kind: 'chart-plane', texelsPerMeter, atlasRect: [0, 0, 1, 1], chartId: 's00' }],
        texels: {
            covered: new Uint8Array(n).fill(1), gutter: new Uint8Array(n), mapIndex: new Uint16Array(n),
            position: new Float32Array(n * 3), normal: new Float32Array(n * 3), sizeM: new Float32Array(n).fill(1 / texelsPerMeter)
        }
    };
}

function emptyPlanes(atlas: UvAtlas): BakedTexturePlanes {
    const n = atlas.width * atlas.height;
    return { layerKey: atlas.layerKey, width: atlas.width, height: atlas.height, albedo: new Uint8Array(n * 4), confidence: { width: atlas.width, height: atlas.height, data: new Uint8Array(n * 4) }, provenance: [], degradations: [] };
}

/** Writes a real (rung-0) texel at `i` with the given 0..255 sRGB grey value. */
function writeReal(planes: BakedTexturePlanes, i: number, grey: number): void {
    planes.albedo.set([grey, grey, grey, 255], i * 4);
    packConfidenceTexel(planes.confidence, i, 0, 0.9, RUNG_STREET_VIEW);
}

describe('texture-repeat.ts: the gate thresholds mirror relief.ts', () => {
    it('K_SIGMA, MIN_REPEATS and NCC_GATE are the stated constants', () => {
        expect(K_SIGMA).toBe(3); // same K as relief.ts's measured-feature gate
        expect(MIN_REPEATS).toBeGreaterThanOrEqual(3);
        expect(NCC_GATE).toBeGreaterThan(0.5);
        expect(MIN_BIN_SAMPLES).toBeGreaterThanOrEqual(4);
        expect(MIN_DONORS).toBeGreaterThanOrEqual(2);
        expect(MAX_DONOR_RUNG).toBe(2); // never compounds a fill on a fill
    });
});

describe('texture-repeat.ts: a genuinely periodic, well-sampled plane', () => {
    // 60 rows (6 m at 10 texels/m) x 24 columns (2.4 m): a horizontal band every 10 rows (1 m pitch), flat across columns.
    const width = 24, height = 60, pitchRows = 10;
    const bandL = (row: number) => (Math.floor(row / (pitchRows / 2)) % 2 === 0 ? 40 : 200); // square-wave band pattern

    function buildPeriodicAtlasAndPlanes(dropRows: number[]): { atlas: UvAtlas; planes: BakedTexturePlanes } {
        const atlas = flatAtlas(width, height);
        const planes = emptyPlanes(atlas);
        for (let y = 0; y < height; y++) {
            if (dropRows.includes(y)) continue; // these rows are left uncovered (as if occluded in every photo)
            const grey = bandL(y);
            for (let x = 0; x < width; x++) writeReal(planes, y * width + x, grey);
        }
        return { atlas, planes };
    }

    it('detects the vertical pitch and fills the dropped rows from the real rows at the same phase, labelled inferred-repeat', () => {
        // drop two whole bands' worth of rows: a clean gap the ladder would otherwise send to the flat palette
        const dropRows = [12, 13, 32, 33, 34];
        const { atlas, planes } = buildPeriodicAtlasAndPlanes(dropRows);
        const detections = detectPlaneRepeats(atlas, planes);
        expect(detections).toHaveLength(1);
        const d = detections[0];
        const row = d.accepted.find(a => a.axis === 'row');
        expect(row, `row axis refused: ${JSON.stringify(d.refused)}`).toBeDefined();
        expect(row!.pitchPx).toBe(pitchRows);
        expect(row!.ncc).toBeGreaterThanOrEqual(NCC_GATE);
        expect(row!.repeats).toBeGreaterThanOrEqual(MIN_REPEATS);
        expect(row!.confidence).toBeGreaterThan(0);
        expect(row!.confidence).toBeLessThanOrEqual(0.85);

        const { planes: filled, degradations } = repeatFill(atlas, planes, detections, RUNG_REPEATED);
        expect(degradations).toHaveLength(0); // the plane was gated in; nothing here falls through

        for (const y of dropRows) {
            for (const x of [0, width - 1]) {
                const i = y * width + x;
                expect(filled.albedo[i * 4 + 3], `row ${y} col ${x} was not filled`).toBe(255);
                const got = filled.albedo[i * 4];
                const want = bandL(y);
                expect(Math.abs(got - want), `row ${y}: got ${got}, want ~${want}`).toBeLessThanOrEqual(2);
                const c = unpackConfidenceTexel(filled.confidence, i);
                expect(c.rung).toBe(RUNG_REPEATED);
                expect(c.weight01).toBeGreaterThan(0);
            }
        }
        expect(filled.provenance).toHaveLength(1);
        expect(filled.provenance[0].label).toBe('inferred-repeat');
        expect(filled.provenance[0].source).toBe('texture-repeat-inference');
        expect(filled.provenance[0].coverage).toBeCloseTo(1, 3); // every dropped, requested texel got filled
    });

    it('never fills a texel the real rungs already colour (never overwrites rung 0-2 data)', () => {
        const { atlas, planes } = buildPeriodicAtlasAndPlanes([]); // nothing dropped
        const detections = detectPlaneRepeats(atlas, planes);
        const { planes: filled } = repeatFill(atlas, planes, detections, RUNG_REPEATED);
        // every texel already had alpha 255 from writeReal; the fill plane must be empty (base.albedo[i*4+3] already set)
        expect(filled.albedo.every(v => v === 0)).toBe(true);
    });

    it('does not use a texel this same rung produced as a donor for another fill (MAX_DONOR_RUNG)', () => {
        const dropRows = [12, 13];
        const { atlas, planes } = buildPeriodicAtlasAndPlanes(dropRows);
        const detections = detectPlaneRepeats(atlas, planes);
        const i = 12 * width;
        // simulate a texel already (incorrectly) stamped at the repeated rung before the fill runs
        packConfidenceTexel(planes.confidence, i, 0, 0.5, RUNG_REPEATED);
        planes.albedo.set([99, 99, 99, 255], i * 4);
        const { planes: filled } = repeatFill(atlas, planes, detections, RUNG_REPEATED);
        // the fill must not have treated texel i (rung 3, not <= MAX_DONOR_RUNG) as a donor for its neighbours
        const donorRung = unpackConfidenceTexel(planes.confidence, i).rung;
        expect(donorRung).toBeGreaterThan(MAX_DONOR_RUNG);
    });
});

describe('texture-repeat.ts: a plane whose real evidence is unevenly spread (a supertall with coverage dense near the base, sparse toward the crown)', () => {
    // 1000 rows (100 m at 10 texels/m) x 24 columns, same 1 m vertical pitch; real data only in two dense bands at the
    // very top and bottom, with an 801-row (80.1 m) gap between them — far wider than the old fixed DONOR_SEARCH_PERIODS
    // (8 periods = 8 m) but within the new ceiling (MAX_DONOR_SEARCH_PERIODS = 64 periods = 64 m from either edge of
    // the gap, so a texel up to ~64 m into the gap from the nearest real band is still reachable).
    const width = 24, height = 1000, pitchRows = 10;
    const bandL = (row: number) => (Math.floor(row / (pitchRows / 2)) % 2 === 0 ? 40 : 200);

    function buildAtlasWithWideGap(): { atlas: UvAtlas; planes: BakedTexturePlanes } {
        const atlas = flatAtlas(width, height);
        const planes = emptyPlanes(atlas);
        for (let y = 0; y < height; y++) {
            if (y >= 100 && y < 901) continue; // the gap: rows [100, 900] uncovered
            const grey = bandL(y);
            for (let x = 0; x < width; x++) writeReal(planes, y * width + x, grey);
        }
        return { atlas, planes };
    }

    it('reaches across the gap by growing the donor search radius, where the old fixed radius would have failed', () => {
        const { atlas, planes } = buildAtlasWithWideGap();
        const detections = detectPlaneRepeats(atlas, planes);
        expect(detections).toHaveLength(1);
        const row = detections[0].accepted.find(a => a.axis === 'row');
        expect(row, `row axis refused: ${JSON.stringify(detections[0].refused)}`).toBeDefined();
        expect(row!.pitchPx).toBe(pitchRows);

        // the gap's middle, row 500: 400 rows (40 m) from the nearest real row at 99 or 901 — more than
        // DONOR_SEARCH_PERIODS (80 rows) but less than MAX_DONOR_SEARCH_PERIODS (640 rows)
        const midGapRow = 500;
        expect(Math.min(midGapRow - 99, 901 - midGapRow)).toBeGreaterThan(DONOR_SEARCH_PERIODS * pitchRows);
        expect(Math.min(midGapRow - 99, 901 - midGapRow)).toBeLessThan(MAX_DONOR_SEARCH_PERIODS * pitchRows);

        const { planes: filled } = repeatFill(atlas, planes, detections, RUNG_REPEATED);
        const i = midGapRow * width;
        expect(filled.albedo[i * 4 + 3], 'the mid-gap texel was not filled: the donor search did not reach far enough').toBe(255);
        expect(Math.abs(filled.albedo[i * 4] - bandL(midGapRow))).toBeLessThanOrEqual(2);
    });
});

describe('texture-repeat.ts: an irregular facade is correctly refused (the Jefferson Market cautionary case)', () => {
    it('a non-periodic, noisy plane gates out on every axis and nothing is fabricated', () => {
        const width = 24, height = 60;
        const atlas = flatAtlas(width, height);
        const planes = emptyPlanes(atlas);
        // a pseudo-random, non-periodic value per row and per column (an irregular Gothic facade: no clean repeat anywhere)
        let seed = 42;
        const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                // deliberately no shared structure between rows or columns: just position-dependent noise
                const grey = Math.round(60 + 140 * rand());
                writeReal(planes, y * width + x, grey);
            }
        }
        // drop a chunk that would otherwise fall to the palette rung
        for (let y = 20; y < 25; y++) for (let x = 0; x < width; x++) planes.albedo[(y * width + x) * 4 + 3] = 0;

        const detections = detectPlaneRepeats(atlas, planes);
        expect(detections).toHaveLength(1);
        const d = detections[0];
        expect(d.accepted, `accepted an axis on noise: ${JSON.stringify(d.accepted)}`).toHaveLength(0);
        expect(d.refused.length).toBeGreaterThan(0);
        for (const r of d.refused) expect(r.reason.length).toBeGreaterThan(0);

        const { planes: filled, degradations } = repeatFill(atlas, planes, detections, RUNG_REPEATED);
        expect(filled.albedo.every(v => v === 0)).toBe(true); // nothing filled: falls through to the palette rung, unfilled here
        expect(degradations).toHaveLength(1);
        expect(degradations[0].reasonCode).toBe('repeat_not_detected');
        expect(degradations[0].reason).toContain('No real gated repeat was found');
    });

    it('too few real samples per row refuses rather than guessing', () => {
        const width = 24, height = 60;
        const atlas = flatAtlas(width, height);
        const planes = emptyPlanes(atlas);
        // only 2 real texels per row (below MIN_BIN_SAMPLES): every row profile bin is a gap
        for (let y = 0; y < height; y++) { writeReal(planes, y * width, 100); writeReal(planes, y * width + 1, 100); }
        const detections = detectPlaneRepeats(atlas, planes);
        expect(detections[0].accepted.filter(a => a.axis === 'row')).toHaveLength(0);
        expect(detections[0].refused.find(r => r.axis === 'row')!.reason).toMatch(/enough real texels/);
    });
});

// sanity: the sRGB <-> linear round trip the module relies on for averaging stays within 1/255
describe('texture-repeat.ts: colour helpers stay consistent with the rest of the pass', () => {
    it('round-trips sRGB -> linear -> sRGB within rounding', () => {
        for (const v of [0, 1, 60, 128, 200, 255]) expect(Math.abs(Math.round(linearToSrgb255(SRGB8_TO_LINEAR[v])) - v)).toBeLessThanOrEqual(1);
    });
});
