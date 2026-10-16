/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Colours measured from the pixels of a photo, never guessed by a model.
 *
 * The image is decoded in memory (jpeg-js; no ffmpeg, no temp file, nothing written), its pixels are sampled on a grid,
 * moved to CIELAB, clustered by a deterministic k-means (farthest-point seeds, fixed iterations), and clusters closer
 * than a CIEDE2000 threshold are merged. What is left, largest first, is the palette: sRGB values with the share of the
 * sampled pixels each holds. The model only names materials; these numbers are the colours.
 *
 * Clay stays one grey. The palette is a hint for the later texture and PBR steps, labelled measured-from-photo.
 */

import * as jpegJs from 'jpeg-js';
import type { FacePalette, MeasuredColour } from '../../../common/spatial/staged-location-contracts';
import { ProColorGradeMatchingService as Colour } from '../../image/ProColorGradeMatchingService';

export interface RgbaFrame { width: number; height: number; data: Uint8Array }

/** Decodes a JPEG in memory. Throws on bytes that are not a decodable JPEG; writes nothing. */
export function decodeJpegInMemory(bytes: Uint8Array, maxMemoryMB = 256): RgbaFrame {
    const d = jpegJs.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: maxMemoryMB });
    return { width: d.width, height: d.height, data: d.data as Uint8Array };
}

export interface PaletteOptions {
    /** Seeds for the k-means before merging. */
    k?: number;
    /** Clusters closer than this CIEDE2000 are one colour. */
    mergeDeltaE?: number;
    /** The sampling grid keeps about this many pixels. */
    maxSamples?: number;
    /** Clusters under this share of the samples are dropped. */
    minShare?: number;
    maxColours?: number;
    /** Only pixels inside these boxes [y0, x0, y1, x1] (0..1000) count; none given: the whole frame. */
    regions1000?: Array<[number, number, number, number]>;
    iterations?: number;
}

export const PALETTE_METHOD = 'Lab k-means (farthest-point seeds, deterministic) with CIEDE2000 merging, on a pixel grid of the decoded image';

type Lab = [number, number, number];

/** Measures the palette of a decoded frame. Deterministic: the same pixels give the same colours. */
export function measurePalette(frame: RgbaFrame, opts: PaletteOptions = {}): FacePalette {
    const k = Math.max(2, opts.k ?? 10);
    const mergeDeltaE = opts.mergeDeltaE ?? 9;
    const minShare = opts.minShare ?? 0.02;
    const maxColours = opts.maxColours ?? 6;
    const iterations = opts.iterations ?? 14;
    const { width, height, data } = frame;
    const inRegion = (x: number, y: number): boolean => {
        const r = opts.regions1000;
        if (!r || !r.length) return true;
        const fx = (x / width) * 1000, fy = (y / height) * 1000;
        return r.some(([y0, x0, y1, x1]) => fy >= y0 && fy <= y1 && fx >= x0 && fx <= x1);
    };
    // a grid with a fixed stride: no randomness
    const stride = Math.max(1, Math.round(Math.sqrt((width * height) / (opts.maxSamples ?? 30_000))));
    const labs: Lab[] = [];
    const rgbs: Array<[number, number, number]> = [];
    for (let y = Math.floor(stride / 2); y < height; y += stride) {
        for (let x = Math.floor(stride / 2); x < width; x += stride) {
            if (!inRegion(x, y)) continue;
            const i = (y * width + x) * 4;
            if (data[i + 3] < 128) continue;
            rgbs.push([data[i], data[i + 1], data[i + 2]]);
            labs.push(Colour.srgbToLab(data[i], data[i + 1], data[i + 2]));
        }
    }
    const n = labs.length;
    if (!n) return { colours: [], method: PALETTE_METHOD, pixels: 0, measuredFromPhoto: true };

    // farthest-point seeding: first the pixel nearest the mean, then each next the pixel farthest from every seed so far
    const mean: Lab = [0, 0, 0];
    for (const l of labs) { mean[0] += l[0]; mean[1] += l[1]; mean[2] += l[2]; }
    mean[0] /= n; mean[1] /= n; mean[2] /= n;
    const d2 = (a: Lab, b: Lab) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    let first = 0;
    for (let i = 1; i < n; i++) if (d2(labs[i], mean) < d2(labs[first], mean)) first = i;
    const centres: Lab[] = [[...labs[first]] as Lab];
    const nearest = new Float64Array(n);
    for (let i = 0; i < n; i++) nearest[i] = d2(labs[i], centres[0]);
    while (centres.length < Math.min(k, n)) {
        let far = 0;
        for (let i = 1; i < n; i++) if (nearest[i] > nearest[far]) far = i;
        if (nearest[far] < 1e-9) break;
        centres.push([...labs[far]] as Lab);
        const c = centres[centres.length - 1];
        for (let i = 0; i < n; i++) nearest[i] = Math.min(nearest[i], d2(labs[i], c));
    }
    const assign = new Int32Array(n);
    for (let it = 0; it < iterations; it++) {
        const sum = centres.map(() => [0, 0, 0, 0]);
        for (let i = 0; i < n; i++) {
            let best = 0, bd = Infinity;
            for (let c = 0; c < centres.length; c++) { const dd = d2(labs[i], centres[c]); if (dd < bd) { bd = dd; best = c; } }
            assign[i] = best;
            const s = sum[best]; s[0] += labs[i][0]; s[1] += labs[i][1]; s[2] += labs[i][2]; s[3]++;
        }
        let moved = 0;
        for (let c = 0; c < centres.length; c++) {
            const s = sum[c];
            if (!s[3]) continue;
            const next: Lab = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
            moved += d2(next, centres[c]);
            centres[c] = next;
        }
        if (moved < 1e-4) break;
    }
    // cluster stats; the colour reported is the mean sRGB of the member pixels (the sRGB the photo holds), its Lab the mean Lab
    interface Cluster { lab: Lab; count: number }
    let clusters: Cluster[] = centres.map(() => ({ lab: [0, 0, 0] as Lab, count: 0 }));
    for (let i = 0; i < n; i++) {
        const c = clusters[assign[i]];
        c.lab[0] += labs[i][0]; c.lab[1] += labs[i][1]; c.lab[2] += labs[i][2]; c.count++;
    }
    clusters = clusters.filter(c => c.count > 0).map(c => ({ lab: [c.lab[0] / c.count, c.lab[1] / c.count, c.lab[2] / c.count] as Lab, count: c.count }));
    // merge by CIEDE2000: the closest pair under the threshold, repeatedly, count-weighted
    for (;;) {
        let bi = -1, bj = -1, bd = mergeDeltaE;
        for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) {
            const dd = Colour.calculateDeltaE00(clusters[i].lab, clusters[j].lab);
            if (dd < bd) { bd = dd; bi = i; bj = j; }
        }
        if (bi < 0) break;
        const a = clusters[bi], b = clusters[bj], t = a.count + b.count;
        clusters[bi] = { lab: [(a.lab[0] * a.count + b.lab[0] * b.count) / t, (a.lab[1] * a.count + b.lab[1] * b.count) / t, (a.lab[2] * a.count + b.lab[2] * b.count) / t], count: t };
        clusters.splice(bj, 1);
    }
    clusters.sort((a, b) => b.count - a.count || a.lab[0] - b.lab[0]);
    const colours: MeasuredColour[] = [];
    for (const c of clusters) {
        if (colours.length >= maxColours) break;
        if (c.count / n < minShare && colours.length) continue;
        const [r, g, b] = Colour.labToSrgb(c.lab[0], c.lab[1], c.lab[2]).map(v => Math.max(0, Math.min(255, Math.round(v)))) as [number, number, number];
        colours.push({ srgb: [r, g, b], hex: `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`, share: Math.round((c.count / n) * 1000) / 1000 });
    }
    return { colours, method: PALETTE_METHOD, pixels: n, measuredFromPhoto: true };
}

/** Decode and measure in one step; the bytes are only read. */
export function paletteOfJpeg(bytes: Uint8Array, opts: PaletteOptions = {}): FacePalette {
    return measurePalette(decodeJpegInMemory(bytes), opts);
}
