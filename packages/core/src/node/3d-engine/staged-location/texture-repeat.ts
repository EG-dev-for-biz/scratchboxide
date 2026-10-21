/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The texture pass's missing rung (docs/processes/texture_repeat_inference.md): where a facade plane's REAL texels
 * (rungs 0-2: Street View projection or tile-photo transfer, never a previous fill) show a clean horizontal and/or
 * vertical repeat, the rest of that same plane is filled by resampling the real texels at the detected pitch, not by
 * the flat measured-palette colour (rung 3 of the old ladder) and never by invention.
 *
 * This is the user's stated texture-inference order (memory: "Texture inference order 2026-10-18") applied to colour:
 * unobserved texture is filled from real data first. Repetition (this file) stands in for "copy from the best-observed
 * sibling"; mirror-symmetry across a twin side is a separate, larger feature (cross-wall, needs twin detection) and is
 * out of scope here (see docs/processes/texture_repeat_inference.md, "follow-ups").
 *
 * Method, mirrored from the geometry ladder's relief-averaging stage (pipeline-e/relief.ts + scratchbox_relief_average.hpp):
 * that stage trims and averages measured samples along a wall's repeats and keeps the result only when the signal clears
 * K_SIGMA standard errors from MIN_BLOCKS independent blocks. This file runs the same two gates (trimmed mean +
 * K-sigma-over-noise, minimum independent repeats) on a 1D lightness profile along each atlas axis of a facade plane
 * (one UV map = one chart or island = one plane), to decide whether a pitch is real before ever using it to fill a texel.
 * An irregular facade (the Jefferson Market cautionary case, docs/processes/*version-f*) fails the gate on every axis and
 * is left to the flat-palette rung exactly as before: nothing here is allowed to impose a repeat that is not there.
 *
 * Provenance: a filled texel is labelled 'inferred-repeat' (packages/core/src/common/spatial/texture-pass-contracts.ts
 * TexelLabel, an open string): not 'photo-inferred' (its own spot was never observed) and not 'generated' (it is not
 * invented; every value copied in comes from a real photo-derived texel on the same plane, at a position the detected
 * pitch says should look the same). Source `'texture-repeat-inference'`.
 */

import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import {
    packConfidenceTexel, unpackConfidenceTexel, type BakedTexturePlanes, type TexelProvenance, type TexturePassDegradation, type UvAtlas
} from '../../../common/spatial/texture-pass-contracts';
import { SRGB8_TO_LINEAR, linearToSrgb255 } from '../../../common/spatial/photogrammetric-delight';
import { linearToLab } from './texel-exposure';

/** The rung index a texel this file fills is packed with (texture-pass.ts: between tile-photo-transfer and the measured palette). */
export const TEXTURE_RUNG_REPEATED_NAME = 'repeated same-plane fill';

/** A texel only this file's rung ever produced may be trusted as a donor for another texel's fill (never compound a fill on a fill). */
export const MAX_DONOR_RUNG = 2;

/** Mirrors relief.ts K_SIGMA: a periodic signal is kept only when its phase amplitude clears this many standard errors of the noise. */
export const K_SIGMA = 3;
/** Mirrors relief.ts MIN_BLOCKS (by analogy: independent repeats of the candidate pitch within the real-covered run). */
export const MIN_REPEATS = 3;
/** Minimum real samples a profile bin (one atlas row or column) needs before it is trusted at all. */
export const MIN_BIN_SAMPLES = 4;
/** Trimmed-mean fraction dropped from each end, same as relief.ts RELIEF_PARAMS.trim. */
export const TRIM = 0.2;
/** Candidate pitch search range, metres (a narrower bay/band would be noise; a wider one would need more wall than most facades have). */
export const MIN_PERIOD_M = 0.3;
export const MAX_PERIOD_M = 8;
/** Minimum normalized cross-correlation (Pearson, lag-shifted) the best candidate pitch must clear. */
export const NCC_GATE = 0.55;
/** A filled texel needs at least this many real donor samples at its phase to be written at all. */
export const MIN_DONORS = 2;
/** How many pitch periods out from a texel donors are searched for, each axis. */
export const DONOR_SEARCH_PERIODS = 8;

export interface AxisPitch {
    axis: 'row' | 'col';
    pitchPx: number;
    pitchM: number;
    ncc: number;
    repeats: number;
    amplitude: number;
    noise: number;
    confidence: number;
}

export interface AxisRefusal { axis: 'row' | 'col'; reason: string }

export interface PlaneRepeatDetection {
    mapIndex: number;
    bbox: { x0: number; y0: number; x1: number; y1: number };
    accepted: AxisPitch[];
    refused: AxisRefusal[];
}

interface Bin { mean: number; se: number; n: number }

/** Lightness (Lab L*) of a linear-RGB sample, for the profile (robust to hue noise; matches relief.ts/plate-audit.ts's use of L). */
function sampleL(albedo: Uint8Array, i: number): number {
    const o = i * 4;
    const lab = linearToLab(SRGB8_TO_LINEAR[albedo[o]], SRGB8_TO_LINEAR[albedo[o + 1]], SRGB8_TO_LINEAR[albedo[o + 2]]);
    return lab[0];
}

/** True when texel `i` is real: covered, written, and at a rung no later fill may build on (never compound a fill on a fill). */
function isReal(atlas: UvAtlas, planes: BakedTexturePlanes, i: number): boolean {
    if (!atlas.texels.covered[i] || atlas.texels.gutter[i]) return false;
    if (!planes.albedo[i * 4 + 3]) return false;
    const c = unpackConfidenceTexel(planes.confidence, i);
    return c.covered && c.rung <= MAX_DONOR_RUNG;
}

/** Trimmed mean and its standard error over `values` (sorted ascending by the caller is not required; this sorts). */
function trimmedStats(values: number[]): { mean: number; se: number; n: number } {
    const sorted = [...values].sort((a, b) => a - b);
    const drop = Math.floor(sorted.length * TRIM);
    const kept = sorted.slice(drop, sorted.length - drop || undefined);
    const used = kept.length ? kept : sorted;
    const mean = used.reduce((s, v) => s + v, 0) / used.length;
    const variance = used.length > 1 ? used.reduce((s, v) => s + (v - mean) ** 2, 0) / (used.length - 1) : 0;
    const se = Math.sqrt(variance / Math.max(1, used.length));
    return { mean, se, n: used.length };
}

/** Per-row (axis 'row') or per-column (axis 'col') trimmed-mean lightness over real texels only, within `bbox`. Gaps are undefined. */
function buildProfile(atlas: UvAtlas, planes: BakedTexturePlanes, mapIndex: number, bbox: PlaneRepeatDetection['bbox'], axis: 'row' | 'col'): Bin[] {
    const { x0, y0, x1, y1 } = bbox;
    const length = axis === 'row' ? y1 - y0 + 1 : x1 - x0 + 1;
    const bins: Bin[] = [];
    for (let k = 0; k < length; k++) {
        const values: number[] = [];
        if (axis === 'row') {
            const y = y0 + k;
            for (let x = x0; x <= x1; x++) {
                const i = y * atlas.width + x;
                if (atlas.texels.mapIndex[i] === mapIndex && isReal(atlas, planes, i)) values.push(sampleL(planes.albedo, i));
            }
        } else {
            const x = x0 + k;
            for (let y = y0; y <= y1; y++) {
                const i = y * atlas.width + x;
                if (atlas.texels.mapIndex[i] === mapIndex && isReal(atlas, planes, i)) values.push(sampleL(planes.albedo, i));
            }
        }
        bins.push(values.length >= MIN_BIN_SAMPLES ? trimmedStats(values) : { mean: NaN, se: NaN, n: 0 });
    }
    return bins;
}

/** Pearson correlation of `bins` against itself shifted by `lag`, over bins both sides have (NaN-aware). */
function laggedNcc(bins: Bin[], lag: number): { ncc: number; pairs: number } {
    const a: number[] = [], b: number[] = [];
    for (let k = 0; k + lag < bins.length; k++) {
        if (bins[k].n < MIN_BIN_SAMPLES || bins[k + lag].n < MIN_BIN_SAMPLES) continue;
        a.push(bins[k].mean); b.push(bins[k + lag].mean);
    }
    if (a.length < 4) return { ncc: 0, pairs: a.length };
    const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
    let num = 0, da = 0, db = 0;
    for (let k = 0; k < a.length; k++) { num += (a[k] - ma) * (b[k] - mb); da += (a[k] - ma) ** 2; db += (b[k] - mb) ** 2; }
    const denom = Math.sqrt(da * db);
    return { ncc: denom > 1e-9 ? num / denom : 0, pairs: a.length };
}

/** Phase-folded amplitude (max - min of the phase-bin trimmed means) and the noise floor (median per-bin SE) for `pitchPx`. */
function phaseAmplitude(bins: Bin[], pitchPx: number): { amplitude: number; noise: number; phasesCovered: number } {
    const phases: number[][] = Array.from({ length: pitchPx }, () => []);
    const ses: number[] = [];
    bins.forEach((bin, k) => { if (bin.n >= MIN_BIN_SAMPLES) { phases[k % pitchPx].push(bin.mean); ses.push(bin.se); } });
    const means = phases.filter(p => p.length > 0).map(p => trimmedStats(p).mean);
    const phasesCovered = means.length;
    if (phasesCovered < 2 || !ses.length) return { amplitude: 0, noise: Infinity, phasesCovered };
    const sortedSes = [...ses].sort((a, b) => a - b);
    const noise = sortedSes[Math.floor(sortedSes.length / 2)] || 1e-6;
    return { amplitude: Math.max(...means) - Math.min(...means), noise, phasesCovered };
}

/**
 * Searches for the best periodic pitch along one axis of a plane. Gates (mirroring relief.ts's measured-feature gate):
 * at least MIN_REPEATS independent repeats fit in the real-covered run, the lagged NCC clears NCC_GATE, and the
 * phase-folded amplitude clears K_SIGMA standard errors of the noise floor (it is a real repeating pattern, not smooth
 * drift or photo noise that a correlation search alone could mistake for one).
 */
export function detectAxisPitch(bins: Bin[], pixelsPerMeter: number, axis: 'row' | 'col'): AxisPitch | AxisRefusal {
    const validBins = bins.filter(b => b.n >= MIN_BIN_SAMPLES).length;
    if (validBins < MIN_BIN_SAMPLES * MIN_REPEATS) return { axis, reason: `only ${validBins} of ${bins.length} ${axis === 'row' ? 'rows' : 'columns'} have enough real texels to read a profile (need at least ${MIN_BIN_SAMPLES * MIN_REPEATS})` };
    const minLag = Math.max(2, Math.round(MIN_PERIOD_M * pixelsPerMeter));
    const maxLag = Math.min(Math.floor(bins.length / MIN_REPEATS), Math.round(MAX_PERIOD_M * pixelsPerMeter));
    if (maxLag <= minLag) return { axis, reason: `the plane is not wide enough along its ${axis === 'row' ? 'height' : 'width'} for ${MIN_REPEATS} repeats of even a ${MIN_PERIOD_M} m pitch` };
    let best: { lag: number; ncc: number; pairs: number } | undefined;
    for (let lag = minLag; lag <= maxLag; lag++) {
        const { ncc, pairs } = laggedNcc(bins, lag);
        if (pairs < MIN_BIN_SAMPLES) continue;
        if (!best || ncc > best.ncc) best = { lag, ncc, pairs };
    }
    if (!best || best.ncc < NCC_GATE) return { axis, reason: `no candidate pitch between ${MIN_PERIOD_M} and ${MAX_PERIOD_M} m correlates at or above ${NCC_GATE} (best ${best ? best.ncc.toFixed(2) : 'n/a'}): the plane does not show a clean repeat` };
    const { amplitude, noise, phasesCovered } = phaseAmplitude(bins, best.lag);
    if (phasesCovered < 2) return { axis, reason: 'the candidate pitch folds to fewer than two distinct phases with real data' };
    if (amplitude < K_SIGMA * noise) return { axis, reason: `the pattern's phase contrast (${amplitude.toFixed(2)} L*) does not clear ${K_SIGMA} standard errors of the noise (${(K_SIGMA * noise).toFixed(2)}): too weak to trust as a real repeat` };
    const repeats = Math.floor(bins.length / best.lag);
    if (repeats < MIN_REPEATS) return { axis, reason: `the candidate pitch (${best.lag}px) only repeats ${repeats} times across the plane (need ${MIN_REPEATS})` };
    const confidence = Math.max(0.3, Math.min(0.85, 0.3 + 0.55 * ((best.ncc - NCC_GATE) / (1 - NCC_GATE))));
    return { axis, pitchPx: best.lag, pitchM: best.lag / pixelsPerMeter, ncc: Math.round(best.ncc * 1000) / 1000, repeats, amplitude, noise, confidence };
}

function isAxisPitch(x: AxisPitch | AxisRefusal): x is AxisPitch { return 'pitchPx' in x; }

/** Runs the gate for every UV map (plane) the atlas holds, over its real (non-fallback) texels. */
export function detectPlaneRepeats(atlas: UvAtlas, planes: BakedTexturePlanes): PlaneRepeatDetection[] {
    const byMap = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
    for (let y = 0; y < atlas.height; y++) {
        for (let x = 0; x < atlas.width; x++) {
            const i = y * atlas.width + x;
            if (!atlas.texels.covered[i] || atlas.texels.gutter[i]) continue;
            const m = atlas.texels.mapIndex[i];
            if (m === 65535) continue;
            const bb = byMap.get(m);
            if (!bb) byMap.set(m, { x0: x, y0: y, x1: x, y1: y });
            else { bb.x0 = Math.min(bb.x0, x); bb.y0 = Math.min(bb.y0, y); bb.x1 = Math.max(bb.x1, x); bb.y1 = Math.max(bb.y1, y); }
        }
    }
    const out: PlaneRepeatDetection[] = [];
    for (const [mapIndex, bbox] of byMap) {
        const pxPerM = atlas.maps[mapIndex]?.texelsPerMeter || 1 / (atlas.texels.sizeM.find(v => v > 0) || 1);
        const rowProfile = buildProfile(atlas, planes, mapIndex, bbox, 'row');
        const colProfile = buildProfile(atlas, planes, mapIndex, bbox, 'col');
        const row = detectAxisPitch(rowProfile, pxPerM, 'row');
        const col = detectAxisPitch(colProfile, pxPerM, 'col');
        const accepted = [row, col].filter(isAxisPitch);
        const refused = [row, col].filter(x => !isAxisPitch(x)) as AxisRefusal[];
        out.push({ mapIndex, bbox, accepted, refused });
    }
    return out;
}

/** Trimmed-mean linear RGB of `samples` (each a texel index into `albedo`). */
function trimmedLinearRgb(albedo: Uint8Array, samples: number[]): Vec3 {
    const chans: [number[], number[], number[]] = [[], [], []];
    for (const i of samples) for (let c = 0; c < 3; c++) chans[c].push(SRGB8_TO_LINEAR[albedo[i * 4 + c]]);
    return chans.map(v => trimmedStats(v).mean) as Vec3;
}

/**
 * Fills same-plane texels the real rungs left uncovered, by resampling real texels at the detected pitch(es): a
 * trimmed average of every real texel at the same phase (same `(x - x0) mod pitchPx`, and/or `(y - y0) mod pitchPx`),
 * searched up to DONOR_SEARCH_PERIODS periods either way. Chosen over a single nearest-phase sample so one occluded or
 * noisy repeat cannot dominate the fill; chosen over averaging every phase (which would blur the pattern away) because
 * only the matching phase is averaged. A texel with fewer than MIN_DONORS real samples at its phase is left uncovered,
 * same as before (it falls through to the palette rung).
 */
export function repeatFill(atlas: UvAtlas, base: BakedTexturePlanes, detections: PlaneRepeatDetection[], rungIndex: number): { planes: BakedTexturePlanes; degradations: TexturePassDegradation[] } {
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
                if (base.albedo[i * 4 + 3]) continue; // already covered by a real or better rung
                considered++;
                const donors: number[] = [];
                const xRange = colPitch ? Array.from({ length: 2 * DONOR_SEARCH_PERIODS + 1 }, (_, k) => x + (k - DONOR_SEARCH_PERIODS) * colPitch.pitchPx).filter(v => v >= x0 && v <= x1) : [x];
                const yRange = rowPitch ? Array.from({ length: 2 * DONOR_SEARCH_PERIODS + 1 }, (_, k) => y + (k - DONOR_SEARCH_PERIODS) * rowPitch.pitchPx).filter(v => v >= y0 && v <= y1) : [y];
                for (const yy of yRange) for (const xx of xRange) {
                    if (xx === x && yy === y) continue;
                    const j = yy * atlas.width + xx;
                    if (atlas.texels.mapIndex[j] === d.mapIndex && isReal(atlas, base, j)) donors.push(j);
                }
                if (donors.length < MIN_DONORS) continue;
                const rgbLinear = trimmedLinearRgb(base.albedo, donors);
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
        method: `trimmed-mean linear RGB of the real texels on the same plane at the detected pitch's matching phase (row and/or column, up to ${DONOR_SEARCH_PERIODS} periods either way, at least ${MIN_DONORS} donors); gated by lagged NCC >= ${NCC_GATE} and phase amplitude >= ${K_SIGMA} standard errors of the noise over >= ${MIN_REPEATS} repeats`,
        coverage: considered ? filled / considered : 0
    }] : [];
    return { planes: { layerKey: base.layerKey, width: atlas.width, height: atlas.height, albedo, confidence, provenance, degradations: [] }, degradations };
}
