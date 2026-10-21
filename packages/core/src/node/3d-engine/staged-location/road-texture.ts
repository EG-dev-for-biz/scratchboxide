/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * SB-Roadie's road surface textures: not the overhead photo pasted onto the road (that carries every car, shadow and
 * crown that stood over it), but a road-aligned surface read from it and redrawn.
 *
 * For each street run a strip image is sampled from the tile photo rendered from above (the tree-stripped tile), one
 * column per step along the road and one row per step across the carriageway, kerb to kerb. Along each row a sliding
 * median over several car lengths keeps what repeats along the road (the tarmac, the painted lines) and drops what does
 * not (cars, shadows, patches). The lane markings are then read as the across-road rows that stay brighter than the
 * tarmac in that median (narrow, a line's width) and redrawn crisp at their measured positions in their measured
 * colour, solid or dashed as the photo shows along the road (the dash length and gap measured). Everything else is the
 * measured tarmac. The sidewalks and kerbs take their measured mean colour. The result is one atlas, one band per run.
 *
 * Labels: the tarmac and marking colours and the marking positions are measured from the photo; the lines themselves
 * are redrawn (vector-modelled). Crossings and lettering do not repeat along the road and are not kept.
 */

import type { RoadSurface, RoadStation } from './road-surfaces';
import type { TopDownPhoto, TopDownFrame } from './top-down-photo';

export interface RoadTextureParams {
    /** Step along the road (m). */
    alongM: number;
    /** Step across the carriageway (m). */
    acrossM: number;
    /** The sliding median along the road reaches this far each way (m): longer than a car. */
    medianHalfM: number;
    /** A marking row is at least this much brighter (luminance 0..1) than the tarmac. */
    markingContrast: number;
    /** A marking is at most this wide across the road (m); wider bright bands are pavement, not lines. */
    markingMaxWidthM: number;
    /** A marking with less than this share of its length painted along the road is dashed. */
    solidShare: number;
    /** Atlas side limit (px). */
    maxPx: number;
}

export const ROAD_TEXTURE_PARAMS: RoadTextureParams = { alongM: 0.2, acrossM: 0.1, medianHalfM: 7, markingContrast: 0.12, markingMaxWidthM: 0.6, solidShare: 0.85, maxPx: 4096 };

export interface RoadBand {
    id: string;
    /** First atlas row and row count of the carriageway band (kerb to kerb, left to right). */
    row0: number; rows: number;
    /** Columns along the road (the run's length / alongM). */
    cols: number;
    /** Rows of the flat sidewalk colour and the kerb colour under the band. */
    sideRow: number; kerbRow: number;
    tarmacRgb: [number, number, number];
    sidewalkRgb: [number, number, number];
    /** The along-road median luminance (0..1) of each row across the carriageway: what the markings were read from. */
    acrossLuminance: number[];
    markings: Array<{ acrossShare: number; widthM: number; rgb: [number, number, number]; dashed: boolean; dashM?: number; gapM?: number; phaseM?: number }>;
}

export interface RoadAtlas {
    width: number; height: number;
    /** sRGB8 RGBA. */
    rgba: Uint8Array;
    bands: Map<string, RoadBand>;
    stats: { runs: number; markings: number; dashed: number; solid: number; texels: number };
}

const lum = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

function samplePhoto(photo: TopDownPhoto, frame: TopDownFrame, x: number, z: number): [number, number, number] | undefined {
    const px = (x - frame.x0) / photo.texelM - 0.5, py = (z - frame.z0) / photo.texelM - 0.5;
    const x0 = Math.floor(px), y0 = Math.floor(py);
    if (x0 < 0 || y0 < 0 || x0 + 1 >= photo.width || y0 + 1 >= photo.height) return undefined;
    const fx = px - x0, fy = py - y0;
    const out: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
        const a = photo.rgba[(y0 * photo.width + x0) * 4 + c], b = photo.rgba[(y0 * photo.width + x0 + 1) * 4 + c];
        const d = photo.rgba[((y0 + 1) * photo.width + x0) * 4 + c], e = photo.rgba[((y0 + 1) * photo.width + x0 + 1) * 4 + c];
        out[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
    }
    return out;
}

function median(v: number[]): number {
    if (!v.length) return NaN;
    const s = [...v].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

/** The position across the carriageway at a station: t in [0, 1] from the left kerb to the right kerb. */
function across(s: RoadStation, t: number): { x: number; z: number } {
    const d = -s.left.halfWidthM + t * (s.left.halfWidthM + s.right.halfWidthM);
    return { x: s.x + s.nx * d, z: s.z + s.nz * d };
}

/** The station interpolated at `along` metres from the run's start. */
function stationAt(r: RoadSurface, along: number): RoadStation {
    const st = r.stations;
    let acc = 0;
    for (let i = 0; i + 1 < st.length; i++) {
        const seg = Math.hypot(st[i + 1].x - st[i].x, st[i + 1].z - st[i].z);
        if (along <= acc + seg || i + 2 === st.length) {
            const f = seg > 1e-9 ? Math.max(0, Math.min(1, (along - acc) / seg)) : 0;
            const a = st[i], b = st[i + 1];
            const lerp = (p: number, q: number) => p + (q - p) * f;
            return {
                ...a, x: lerp(a.x, b.x), z: lerp(a.z, b.z), nx: lerp(a.nx, b.nx), nz: lerp(a.nz, b.nz),
                left: { ...a.left, halfWidthM: lerp(a.left.halfWidthM, b.left.halfWidthM) }, right: { ...a.right, halfWidthM: lerp(a.right.halfWidthM, b.right.halfWidthM) }
            };
        }
        acc += seg;
    }
    return st[st.length - 1];
}

/** Sliding median along one row (window of 2 * half + 1), NaN-aware. */
function slidingMedian(row: Float32Array, half: number): Float32Array {
    const n = row.length, out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const vals: number[] = [];
        for (let k = Math.max(0, i - half); k <= Math.min(n - 1, i + half); k++) if (row[k] === row[k]) vals.push(row[k]);
        out[i] = vals.length ? median(vals) : NaN;
    }
    return out;
}

/**
 * Builds the atlas for every run: the strip sampled, cleaned along the road, its markings read and redrawn. `photo` is the
 * tile photo rendered from above (ideally of the tree-stripped tile) over `frame`.
 */
export function synthesizeRoadTextures(roads: RoadSurface[], photo: TopDownPhoto, frame: TopDownFrame, P: RoadTextureParams = ROAD_TEXTURE_PARAMS): RoadAtlas {
    const stats = { runs: 0, markings: 0, dashed: 0, solid: 0, texels: 0 };
    // the layout: one band per run (carriageway rows + 1 sidewalk row + 1 kerb row + 1 gutter), stacked; rows scaled down together when they overflow
    const plans = roads.filter(r => r.stations.length >= 2).map(r => {
        let width = 0;
        for (const s of r.stations) width = Math.max(width, s.left.halfWidthM + s.right.halfWidthM);
        const cols = Math.max(2, Math.min(P.maxPx, Math.ceil(r.lengthM / P.alongM)));
        const rows = Math.max(4, Math.ceil(width / P.acrossM));
        return { r, cols, rows, width };
    });
    const totalRows = plans.reduce((n, p) => n + p.rows + 3, 0);
    const scale = totalRows > P.maxPx ? (P.maxPx - 3 * plans.length) / (totalRows - 3 * plans.length) : 1;
    let height = 0;
    for (const p of plans) { p.rows = Math.max(4, Math.floor(p.rows * scale)); height += p.rows + 3; }
    const width = Math.max(1, plans.reduce((w, p) => Math.max(w, p.cols), 1));
    height = Math.max(1, height);
    const rgba = new Uint8Array(width * height * 4);
    const bands = new Map<string, RoadBand>();
    let row0 = 0;
    for (const p of plans) {
        const { r, cols, rows } = p;
        const alongStep = r.lengthM / cols;
        // the strip, sampled: rows across (left to right), cols along
        const strip = [0, 1, 2].map(() => new Float32Array(cols * rows).fill(NaN));
        for (let c = 0; c < cols; c++) {
            const s = stationAt(r, (c + 0.5) * alongStep);
            for (let k = 0; k < rows; k++) {
                const t = (k + 0.5) / rows;
                const w = across(s, t);
                const rgb = samplePhoto(photo, frame, w.x, w.z);
                if (!rgb) continue;
                for (let ch = 0; ch < 3; ch++) strip[ch][k * cols + c] = rgb[ch];
            }
        }
        // cleaned along the road: a sliding median per row and channel
        const half = Math.max(1, Math.round(P.medianHalfM / alongStep));
        const clean = [0, 1, 2].map(ch => {
            const out = new Float32Array(cols * rows).fill(NaN);
            for (let k = 0; k < rows; k++) out.set(slidingMedian(strip[ch].subarray(k * cols, (k + 1) * cols), half), k * cols);
            return out;
        });
        // the tarmac: the median colour of the cleaned strip; a row's own brightness is its along-road median luminance
        const rowLum = new Float32Array(rows), rowRgb: Array<[number, number, number]> = [];
        for (let k = 0; k < rows; k++) {
            const ls: number[] = [], rs: number[] = [], gs: number[] = [], bs: number[] = [];
            for (let c = 0; c < cols; c++) {
                const i = k * cols + c;
                if (clean[0][i] !== clean[0][i]) continue;
                ls.push(lum(clean[0][i], clean[1][i], clean[2][i])); rs.push(clean[0][i]); gs.push(clean[1][i]); bs.push(clean[2][i]);
            }
            rowLum[k] = ls.length ? median(ls) : NaN;
            rowRgb.push([median(rs), median(gs), median(bs)]);
        }
        const finiteLum = Array.from(rowLum).filter(v => v === v);
        const tarmacLum = finiteLum.length ? median(finiteLum) : 0.3;
        const tarmacRgb: [number, number, number] = [median(rowRgb.map(c => c[0]).filter(v => v === v)), median(rowRgb.map(c => c[1]).filter(v => v === v)), median(rowRgb.map(c => c[2]).filter(v => v === v))].map(v => (v === v ? v : 90)) as [number, number, number];
        // markings: runs of rows brighter than the tarmac by the contrast, no wider than a line
        const maxRows = Math.max(1, Math.round(P.markingMaxWidthM / (p.width / rows)));
        // (the outermost rows read the kerb and sidewalk beside the band, never a marking)
        const edge = Math.max(1, Math.ceil(0.35 / (p.width / rows)));
        const bright = Array.from(rowLum, (v, k) => k >= edge && k < rows - edge && v === v && v - tarmacLum >= P.markingContrast);
        const markings: RoadBand['markings'] = [];
        for (let k = 0; k < rows; k++) {
            if (!bright[k]) continue;
            let e = k;
            while (e + 1 < rows && bright[e + 1]) e++;
            // the line's width at half its height over the tarmac (the photo and its sampling blur the edges)
            const peak = Math.max(...Array.from(rowLum.subarray(k, e + 1)));
            const halfMax = tarmacLum + (peak - tarmacLum) / 2;
            let n = 0;
            for (let q = k; q <= e; q++) if (rowLum[q] >= halfMax) n++;
            if (n <= maxRows) {
                // the colour: the median of the painted samples themselves (a dashed line's along-road median would blend in the tarmac);
                // dashed or solid: the share of the raw strip along the line that is bright
                const painted: number[][] = [[], [], []];
                for (let q = k; q <= e; q++) for (let c = 0; c < cols; c++) {
                    const i = q * cols + c;
                    if (strip[0][i] === strip[0][i] && lum(strip[0][i], strip[1][i], strip[2][i]) - tarmacLum >= P.markingContrast) for (let ch = 0; ch < 3; ch++) painted[ch].push(strip[ch][i]);
                }
                const rgb: [number, number, number] = painted[0].length ? [median(painted[0]), median(painted[1]), median(painted[2])] : ([0, 1, 2].map(ch => median(rowRgb.slice(k, e + 1).map(c => c[ch]))) as [number, number, number]);
                const mid = Math.floor((k + e) / 2);
                const on: boolean[] = [];
                for (let c = 0; c < cols; c++) { const i = mid * cols + c; on.push(strip[0][i] === strip[0][i] && lum(strip[0][i], strip[1][i], strip[2][i]) - tarmacLum >= P.markingContrast); }
                const share = on.filter(Boolean).length / Math.max(1, on.length);
                let dashM: number | undefined, gapM: number | undefined, phaseM: number | undefined;
                if (share < P.solidShare) {
                    const dashes: number[] = [], gaps: number[] = [], starts: number[] = [];
                    let runLen = 0, state = on[0], runStart = 0;
                    for (let c = 1; c <= cols; c++) {
                        if (c < cols && on[c] === state) { runLen++; continue; }
                        (state ? dashes : gaps).push((runLen + 1) * alongStep);
                        if (state) starts.push(runStart * alongStep);
                        runLen = 0; runStart = c; state = c < cols ? on[c] : state;
                    }
                    if (dashes.length >= 2 && gaps.length >= 2) {
                        dashM = median(dashes); gapM = median(gaps);
                        // the phase: where the dashes start along the road, as the median of each start modulo the period
                        const period = dashM + gapM;
                        phaseM = median(starts.map(v => ((v % period) + period) % period));
                    }
                }
                const dashed = share < P.solidShare && dashM !== undefined;
                markings.push({ acrossShare: (k + n / 2) / rows, widthM: n * (p.width / rows), rgb, dashed, ...(dashed ? { dashM, gapM, phaseM } : {}) });
                if (dashed) stats.dashed++; else if (share >= P.solidShare) stats.solid++;
            }
            k = e;
        }
        stats.markings += markings.length;
        // the sidewalk colour: the photo just outside the measured kerbs, where the stations have a sidewalk
        const side: number[][] = [[], [], []];
        for (const s of r.stations) {
            for (const [sd, sign] of [[s.left, -1], [s.right, 1]] as const) {
                if (!sd.sidewalk) continue;
                const d = sign * (sd.halfWidthM + Math.min(1.5, sd.sidewalk.widthM / 2));
                const rgb = samplePhoto(photo, frame, s.x + s.nx * d, s.z + s.nz * d);
                if (rgb) for (let ch = 0; ch < 3; ch++) side[ch].push(rgb[ch]);
            }
        }
        const sidewalkRgb: [number, number, number] = side[0].length ? [median(side[0]), median(side[1]), median(side[2])] : [tarmacRgb[0] * 1.25, tarmacRgb[1] * 1.25, tarmacRgb[2] * 1.2];
        // paint the band: the cleaned strip with the marking rows filled from their neighbours, then the lines redrawn
        const markRows = new Set<number>();
        for (const m of markings) { const c0 = Math.round(m.acrossShare * rows), hw = Math.ceil(m.widthM / (p.width / rows) / 2); for (let k = c0 - hw; k <= c0 + hw; k++) if (k >= 0 && k < rows) markRows.add(k); }
        for (let k = 0; k < rows; k++) {
            let src = k;
            if (markRows.has(k)) { let d = 1; while (d < rows && markRows.has(src)) { src = k - d >= 0 && !markRows.has(k - d) ? k - d : k + d < rows ? k + d : src; d++; } }
            for (let c = 0; c < cols; c++) {
                const i = src * cols + c, o = ((row0 + k) * width + c) * 4;
                const ok = clean[0][i] === clean[0][i];
                rgba[o] = ok ? clean[0][i] : tarmacRgb[0]; rgba[o + 1] = ok ? clean[1][i] : tarmacRgb[1]; rgba[o + 2] = ok ? clean[2][i] : tarmacRgb[2]; rgba[o + 3] = 255;
            }
        }
        for (const m of markings) {
            const c0 = m.acrossShare * rows, hwRows = Math.max(0.5, m.widthM / (p.width / rows) / 2);
            for (let k = Math.max(0, Math.floor(c0 - hwRows)); k < Math.min(rows, Math.ceil(c0 + hwRows)); k++) {
                for (let c = 0; c < cols; c++) {
                    if (m.dashed && m.dashM && m.gapM) { const period = m.dashM + m.gapM; const along = (c + 0.5) * alongStep - (m.phaseM ?? 0); if (((along % period) + period) % period > m.dashM) continue; }
                    const o = ((row0 + k) * width + c) * 4;
                    rgba[o] = m.rgb[0]; rgba[o + 1] = m.rgb[1]; rgba[o + 2] = m.rgb[2]; rgba[o + 3] = 255;
                }
            }
        }
        const sideRow = row0 + rows, kerbRow = row0 + rows + 1;
        for (let c = 0; c < width; c++) {
            const o = (sideRow * width + c) * 4, q = (kerbRow * width + c) * 4;
            rgba[o] = sidewalkRgb[0]; rgba[o + 1] = sidewalkRgb[1]; rgba[o + 2] = sidewalkRgb[2]; rgba[o + 3] = 255;
            rgba[q] = sidewalkRgb[0] * 0.8; rgba[q + 1] = sidewalkRgb[1] * 0.8; rgba[q + 2] = sidewalkRgb[2] * 0.8; rgba[q + 3] = 255;
            const g = ((row0 + rows + 2) * width + c) * 4;
            rgba[g] = tarmacRgb[0]; rgba[g + 1] = tarmacRgb[1]; rgba[g + 2] = tarmacRgb[2]; rgba[g + 3] = 255;
        }
        bands.set(r.id, { id: r.id, row0, rows, cols, sideRow, kerbRow, tarmacRgb, sidewalkRgb, markings, acrossLuminance: Array.from(rowLum, v => Number(v.toFixed(3))) });
        stats.runs++;
        stats.texels += cols * rows;
        row0 += rows + 3;
    }
    return { width, height, rgba, bands, stats };
}
