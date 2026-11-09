/**
 * texture-repeat.ts repeatFill: the donor index must fill exactly what the per-texel donor search filled. The oracle
 * below is that search as it stood before the index (findDonors building new range and donor arrays for every texel at
 * every doubling radius, then sorting the donors' channels): 80+ minutes at Penn on one district's pipeline-E faces.
 * Every fixture compares the two byte for byte (albedo, confidence) and the degradations and provenance whole, on
 * synthetic atlases only (no network, no model, no native build).
 */
import { describe, expect, it } from 'vitest';
import {
    packConfidenceTexel, unpackConfidenceTexel, TEXTURE_LADDER_RUNGS, type BakedTexturePlanes, type TexelProvenance, type TexturePassDegradation, type UvAtlas
} from '../src/common/spatial/texture-pass-contracts';
import { SRGB8_TO_LINEAR, linearToSrgb255 } from '../src/common/spatial/photogrammetric-delight';
import type { Vec3 } from '../src/common/spatial/staged-location-contracts';
import {
    detectPlaneRepeats, repeatFill, DONOR_SEARCH_PERIODS, MAX_DONOR_RUNG, MAX_DONOR_SEARCH_PERIODS, MIN_DONORS, TRIM,
    type AxisPitch, type PlaneRepeatDetection
} from '../src/node/3d-engine/staged-location/texture-repeat';

const RUNG_REPEATED = TEXTURE_LADDER_RUNGS.indexOf('repeated same-plane fill');

// ---- the oracle: repeatFill's per-texel donor search before the index, verbatim but for names ----
function oracleIsReal(atlas: UvAtlas, planes: BakedTexturePlanes, i: number): boolean {
    if (!atlas.texels.covered[i] || atlas.texels.gutter[i]) return false;
    if (!planes.albedo[i * 4 + 3]) return false;
    const c = unpackConfidenceTexel(planes.confidence, i);
    return c.covered && c.rung <= MAX_DONOR_RUNG;
}
function oracleTrimmedMean(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const drop = Math.floor(sorted.length * TRIM);
    const kept = sorted.slice(drop, sorted.length - drop || undefined);
    const used = kept.length ? kept : sorted;
    return used.reduce((s, v) => s + v, 0) / used.length;
}
function oracleTrimmedLinearRgb(albedo: Uint8Array, samples: number[]): Vec3 {
    const chans: [number[], number[], number[]] = [[], [], []];
    for (const i of samples) for (let c = 0; c < 3; c++) chans[c].push(SRGB8_TO_LINEAR[albedo[i * 4 + c]]);
    return chans.map(v => oracleTrimmedMean(v)) as Vec3;
}
function oracleFindDonors(atlas: UvAtlas, base: BakedTexturePlanes, d: PlaneRepeatDetection, x: number, y: number, rowPitch: AxisPitch | undefined, colPitch: AxisPitch | undefined): number[] {
    const { x0, y0, x1, y1 } = d.bbox;
    for (let periods = DONOR_SEARCH_PERIODS; ; periods = Math.min(MAX_DONOR_SEARCH_PERIODS, periods * 2)) {
        const xRange = colPitch ? Array.from({ length: 2 * periods + 1 }, (_, k) => x + (k - periods) * colPitch.pitchPx).filter(v => v >= x0 && v <= x1) : [x];
        const yRange = rowPitch ? Array.from({ length: 2 * periods + 1 }, (_, k) => y + (k - periods) * rowPitch.pitchPx).filter(v => v >= y0 && v <= y1) : [y];
        const donors: number[] = [];
        for (const yy of yRange) for (const xx of xRange) {
            if (xx === x && yy === y) continue;
            const j = yy * atlas.width + xx;
            if (atlas.texels.mapIndex[j] === d.mapIndex && oracleIsReal(atlas, base, j)) donors.push(j);
        }
        if (donors.length >= MIN_DONORS || periods >= MAX_DONOR_SEARCH_PERIODS) return donors;
    }
}
function oracleRepeatFill(atlas: UvAtlas, base: BakedTexturePlanes, detections: PlaneRepeatDetection[], rungIndex: number): { planes: BakedTexturePlanes; degradations: TexturePassDegradation[] } {
    const n = atlas.width * atlas.height;
    const albedo = new Uint8Array(n * 4);
    const confidence = { width: atlas.width, height: atlas.height, data: new Uint8Array(n * 4) };
    const degradations: TexturePassDegradation[] = [];
    let filled = 0, considered = 0;
    for (const d of detections) {
        const rowPitch = d.accepted.find(a => a.axis === 'row');
        const colPitch = d.accepted.find(a => a.axis === 'col');
        if (!rowPitch && !colPitch) {
            degradations.push({
                stage: 'repeat-fill', reasonCode: 'repeat_not_detected',
                reason: `No real gated repeat was found on this plane's face (${d.refused.map(r => r.reason).join('; ') || 'no axis had enough real samples'}), so uncovered texels keep the measured-palette colour instead of a resampled repeat.`
            });
            continue;
        }
        const { x0, y0, x1, y1 } = d.bbox;
        const confAt = rowPitch ? rowPitch.confidence : 0;
        const confBt = colPitch ? colPitch.confidence : 0;
        const confidence01 = rowPitch && colPitch ? Math.min(0.85, Math.max(confAt, confBt)) : (rowPitch ? confAt : confBt);
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const i = y * atlas.width + x;
                if (atlas.texels.mapIndex[i] !== d.mapIndex || !atlas.texels.covered[i] || atlas.texels.gutter[i]) continue;
                if (base.albedo[i * 4 + 3]) continue;
                considered++;
                const donors = oracleFindDonors(atlas, base, d, x, y, rowPitch, colPitch);
                if (donors.length < MIN_DONORS) continue;
                const rgbLinear = oracleTrimmedLinearRgb(base.albedo, donors);
                const srgb = rgbLinear.map(v => Math.round(linearToSrgb255(v)));
                albedo.set([srgb[0], srgb[1], srgb[2], 255], i * 4);
                const weight = Math.min(0.85, confidence01 * Math.min(1, donors.length / (2 * MIN_DONORS)));
                packConfidenceTexel(confidence, i, 0, weight, rungIndex);
                filled++;
            }
        }
    }
    const provenance: TexelProvenance[] = filled ? [{
        source: 'texture-repeat-inference', label: 'inferred-repeat',
        method: `trimmed-mean linear RGB of the real texels on the same plane at the detected pitch's matching phase (row and/or column, up to ${DONOR_SEARCH_PERIODS} periods either way, at least ${MIN_DONORS} donors); gated by lagged NCC >= 0.55 and phase amplitude >= 3 standard errors of the noise over >= 3 repeats`,
        coverage: considered ? filled / considered : 0
    }] : [];
    return { planes: { layerKey: base.layerKey, width: atlas.width, height: atlas.height, albedo, confidence, provenance, degradations: [] }, degradations };
}

// ---- fixtures ----
/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface Fixture { atlas: UvAtlas; base: BakedTexturePlanes }

/**
 * An atlas of `maps` side-by-side planes whose bboxes overlap by a few columns (texels interleave there), with gutter
 * texels, uncovered texels, real texels at `realShare` (colour from a periodic pattern plus noise, so donors differ),
 * and some written texels at a rung past MAX_DONOR_RUNG (written, so not a target, and never a donor).
 */
function fixture(seed: number, width: number, height: number, realShare: number, maps = 1): Fixture {
    const r = rng(seed), n = width * height;
    const atlas: UvAtlas = {
        layerKey: 'l', width, height,
        maps: Array.from({ length: maps }, (_, m) => ({ nodeName: `p${m}`, kind: 'chart-plane' as const, texelsPerMeter: 10, atlasRect: [0, 0, 1, 1] as [number, number, number, number] })),
        texels: {
            covered: new Uint8Array(n), gutter: new Uint8Array(n), mapIndex: new Uint16Array(n).fill(65535),
            position: new Float32Array(n * 3), normal: new Float32Array(n * 3), sizeM: new Float32Array(n).fill(0.1)
        }
    };
    const base: BakedTexturePlanes = { layerKey: 'l', width, height, albedo: new Uint8Array(n * 4), confidence: { width, height, data: new Uint8Array(n * 4) }, provenance: [], degradations: [] };
    const band = Math.ceil(width / maps);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (r() < 0.03) continue; // outside every chart
        let m = Math.min(maps - 1, Math.floor(x / band));
        if (maps > 1 && x % band < 3 && m > 0 && r() < 0.5) m -= 1; // interleave at the seams: overlapping bboxes
        atlas.texels.mapIndex[i] = m;
        atlas.texels.covered[i] = 1;
        if (r() < 0.02) { atlas.texels.gutter[i] = 1; continue; }
        const u = r();
        if (u < realShare) {
            const g = 40 + ((x % 7) * 23 + (y % 5) * 31) % 180;
            base.albedo.set([Math.min(255, g + Math.floor(r() * 20)), Math.floor(r() * 256), (g + Math.floor(r() * 60)) % 256, 255], i * 4);
            packConfidenceTexel(base.confidence, i, 0, 0.9, Math.floor(r() * (MAX_DONOR_RUNG + 1)));
        } else if (u < realShare + 0.02) {
            base.albedo.set([9, 9, 9, 255], i * 4);
            packConfidenceTexel(base.confidence, i, 0, 0.5, MAX_DONOR_RUNG + 1);
        }
    }
    return { atlas, base };
}

function pitch(axis: 'row' | 'col', pitchPx: number, confidence: number): AxisPitch {
    return { axis, pitchPx, pitchM: pitchPx / 10, ncc: 0.9, repeats: 5, amplitude: 30, noise: 1, confidence };
}

/** One detection per map, over each map's real bbox, with the given pitches. */
function detections(atlas: UvAtlas, perMap: (m: number) => AxisPitch[]): PlaneRepeatDetection[] {
    const boxes = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
    for (let y = 0; y < atlas.height; y++) for (let x = 0; x < atlas.width; x++) {
        const i = y * atlas.width + x;
        const m = atlas.texels.mapIndex[i];
        if (!atlas.texels.covered[i] || atlas.texels.gutter[i] || m === 65535) continue;
        const bb = boxes.get(m);
        if (!bb) boxes.set(m, { x0: x, y0: y, x1: x, y1: y });
        else { bb.x0 = Math.min(bb.x0, x); bb.y0 = Math.min(bb.y0, y); bb.x1 = Math.max(bb.x1, x); bb.y1 = Math.max(bb.y1, y); }
    }
    return [...boxes].map(([mapIndex, bbox]) => {
        const accepted = perMap(mapIndex);
        return { mapIndex, bbox, accepted, refused: accepted.length ? [] : [{ axis: 'row' as const, reason: 'no gated axis' }] };
    });
}

/** Compares the two fills; returns how many texels the oracle filled and the share of its targets that was. */
function expectIdentical(f: Fixture, dets: PlaneRepeatDetection[]): { filled: number; coverage: number } {
    const want = oracleRepeatFill(f.atlas, f.base, dets, RUNG_REPEATED);
    const got = repeatFill(f.atlas, f.base, dets, RUNG_REPEATED);
    expect(Buffer.from(got.planes.albedo).equals(Buffer.from(want.planes.albedo))).toBe(true);
    expect(Buffer.from(got.planes.confidence.data).equals(Buffer.from(want.planes.confidence.data))).toBe(true);
    expect(got.degradations).toEqual(want.degradations);
    expect(got.planes.provenance).toEqual(want.planes.provenance);
    let filled = 0;
    for (let i = 3; i < want.planes.albedo.length; i += 4) if (want.planes.albedo[i]) filled++;
    return { filled, coverage: want.planes.provenance[0]?.coverage ?? 0 };
}

describe('texture-repeat.ts repeatFill: the donor index fills exactly what the per-texel search filled', () => {
    it('relies on SRGB8_TO_LINEAR rising with the byte (a byte histogram sums the donors in sorted order)', () => {
        for (let k = 1; k < 256; k++) expect(SRGB8_TO_LINEAR[k]).toBeGreaterThan(SRGB8_TO_LINEAR[k - 1]);
    });

    it('both axes, dense real texels: the first radius suffices almost everywhere', () => {
        const f = fixture(1, 97, 83, 0.6);
        expect(expectIdentical(f, detections(f.atlas, () => [pitch('row', 5, 0.7), pitch('col', 7, 0.6)])).filled).toBeGreaterThan(1000);
    });

    it('one axis at a time: the other axis keeps the texel\'s own row or column', () => {
        const f = fixture(2, 120, 64, 0.4);
        expect(expectIdentical(f, detections(f.atlas, () => [pitch('col', 6, 0.5)])).filled).toBeGreaterThan(500);
        expect(expectIdentical(f, detections(f.atlas, () => [pitch('row', 4, 0.8)])).filled).toBeGreaterThan(500);
    });

    it('sparse real texels on lattices wider than the widest window: the radius doubles, windows clip, some texels stay unfilled', () => {
        // pitch 2 over 400 columns: 200 cells a phase, wider than 2 * MAX_DONOR_SEARCH_PERIODS + 1 = 129
        const f = fixture(3, 400, 300, 0.0002);
        const { filled, coverage } = expectIdentical(f, detections(f.atlas, () => [pitch('row', 2, 0.6), pitch('col', 2, 0.6)]));
        expect(filled).toBeGreaterThan(100);
        expect(coverage).toBeLessThan(1); // some texels found fewer than MIN_DONORS even at the widest radius
    });

    it('very sparse, one axis: most texels give up at the widest radius', () => {
        const f = fixture(4, 600, 40, 0.002);
        expect(expectIdentical(f, detections(f.atlas, () => [pitch('col', 3, 0.5)])).coverage).toBeLessThan(0.5);
    });

    it('several planes with overlapping bboxes, a plane without a gated axis, mixed pitches', () => {
        const f = fixture(5, 150, 90, 0.3, 3);
        const { filled } = expectIdentical(f, detections(f.atlas, m => m === 0 ? [pitch('row', 9, 0.4), pitch('col', 4, 0.85)] : m === 1 ? [] : [pitch('col', 11, 0.3)]));
        expect(filled).toBeGreaterThan(500);
    });

    it('a pitch longer than the plane is wide leaves one cell a phase (the window is the texel\'s own cell)', () => {
        const f = fixture(6, 30, 30, 0.5);
        expectIdentical(f, detections(f.atlas, () => [pitch('row', 40, 0.5), pitch('col', 3, 0.5)]));
    });

    it('end to end with detectPlaneRepeats on a periodic facade with holes', () => {
        const width = 160, height = 120, n = width * height;
        const r = rng(7);
        const f = fixture(7, width, height, 0);
        for (let i = 0; i < n; i++) {
            if (!f.atlas.texels.covered[i] || f.atlas.texels.gutter[i]) continue;
            const x = i % width, y = Math.floor(i / width);
            const hole = (x > 40 && x < 90 && y > 30 && y < 80) || r() < 0.2;
            if (hole) { f.base.albedo.fill(0, i * 4, i * 4 + 4); f.base.confidence.data.fill(0, i * 4, i * 4 + 4); continue; }
            const g = (Math.floor(x / 4) % 2 ? 200 : 50) + (Math.floor(y / 6) % 2 ? 0 : 30) + Math.floor(r() * 6);
            f.base.albedo.set([g, g - 10, g - 20, 255], i * 4);
            packConfidenceTexel(f.base.confidence, i, 0, 0.9, 0);
        }
        const dets = detectPlaneRepeats(f.atlas, f.base);
        expect(dets.some(d => d.accepted.length > 0)).toBe(true);
        expect(expectIdentical(f, dets).filled).toBeGreaterThan(2000);
    });
});
