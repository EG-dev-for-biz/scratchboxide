/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { StationPlate } from './SurveyTextureUnprojector';
import { warpStationImage, type WarpSource, type WarpTarget } from './BeautifyStationService';
import { EMPTY_DEPTH } from './SurveyStationRenderService';

export interface RadianceEqualizationOptions {
    /** Enable cross-station radiance harmonization. Default true. */
    enabled?: boolean;
    /** Color space: 'ycbcr' (default, separates luminance from chrominance) or 'rgb'. */
    colorSpace?: 'ycbcr' | 'rgb';
    /** Blend factor between original and equalized plate: 0.0 (no change) to 1.0 (full equalization). Default 0.85. */
    blendStrength?: number;
    /** Minimum mutual overlap fraction to consider stations directly connected. Default 0.03 (3%). */
    minOverlapFraction?: number;
    /** Explicit station ID to use as anchor reference. If omitted, station with median foreground luminance is selected. */
    referenceStationId?: number;
}

export interface StationEqualizationTelemetry {
    stationId: number;
    stationName?: string;
    isAnchor: boolean;
    matchedToStationId?: number;
    overlapFraction: number;
    meanLuminanceBefore: number;
    meanLuminanceAfter: number;
    meanRgbBefore: [number, number, number];
    meanRgbAfter: [number, number, number];
}

export interface RadianceEqualizationResult {
    anchorStationId: number;
    stationsEqualized: number;
    telemetry: StationEqualizationTelemetry[];
}

/**
 * Harmonizes exposure, dynamic range, and color temperature across multiple camera stations
 * using non-linear Cumulative Distribution Function (CDF) histogram matching and mutual
 * surface overlap correspondence tracking.
 */
export class StationRadianceEqualizer {
    /**
     * Fast conversion from sRGB to YCbCr (ITU-R BT.601).
     * Y in [0, 255], Cb in [0, 255], Cr in [0, 255].
     */
    public static rgbToYcbcr(r: number, g: number, b: number): [number, number, number] {
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        return [
            Math.max(0, Math.min(255, Math.round(y))),
            Math.max(0, Math.min(255, Math.round(cb))),
            Math.max(0, Math.min(255, Math.round(cr)))
        ];
    }

    /**
     * Fast conversion from YCbCr back to sRGB.
     */
    public static ycbcrToRgb(y: number, cb: number, cr: number): [number, number, number] {
        const r = y + 1.402 * (cr - 128);
        const g = y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128);
        const b = y + 1.772 * (cb - 128);
        return [
            Math.max(0, Math.min(255, Math.round(r))),
            Math.max(0, Math.min(255, Math.round(g))),
            Math.max(0, Math.min(255, Math.round(b)))
        ];
    }

    /**
     * Constructs a monotonic lookup table that maps src histogram to ref histogram
     * via normalized Cumulative Distribution Function (CDF) inversion.
     */
    public static buildCdfLut(srcValues: number[], refValues: number[]): Uint8Array {
        const lut = new Uint8Array(256);
        if (srcValues.length === 0 || refValues.length === 0) {
            for (let i = 0; i < 256; i++) lut[i] = i;
            return lut;
        }

        const histSrc = new Float64Array(256);
        const histRef = new Float64Array(256);

        for (let i = 0; i < srcValues.length; i++) {
            const v = Math.max(0, Math.min(255, srcValues[i]));
            histSrc[v]++;
        }
        for (let i = 0; i < refValues.length; i++) {
            const v = Math.max(0, Math.min(255, refValues[i]));
            histRef[v]++;
        }

        const cdfSrc = new Float64Array(256);
        const cdfRef = new Float64Array(256);
        let sumSrc = 0;
        let sumRef = 0;

        for (let i = 0; i < 256; i++) {
            sumSrc += histSrc[i];
            sumRef += histRef[i];
            cdfSrc[i] = sumSrc / srcValues.length;
            cdfRef[i] = sumRef / refValues.length;
        }

        // Monotonic mapping: find ref index with closest cumulative probability
        for (let srcV = 0; srcV < 256; srcV++) {
            const p = cdfSrc[srcV];
            let bestRefV = 0;
            let bestDiff = 1.0;
            for (let refV = 0; refV < 256; refV++) {
                const diff = Math.abs(cdfRef[refV] - p);
                if (diff < bestDiff) {
                    bestDiff = diff;
                    bestRefV = refV;
                }
            }
            lut[srcV] = bestRefV;
        }

        return lut;
    }

    /**
     * Equalizes an array of station plates in-place.
     */
    public static equalizePlates(
        plates: StationPlate[],
        options: RadianceEqualizationOptions = {}
    ): RadianceEqualizationResult {
        if (plates.length <= 1 || options.enabled === false) {
            return {
                anchorStationId: plates[0]?.station?.id ?? 0,
                stationsEqualized: 0,
                telemetry: []
            };
        }

        const blend = options.blendStrength ?? 0.85;
        const minOverlap = options.minOverlapFraction ?? 0.03;
        const colorSpace = options.colorSpace ?? 'ycbcr';

        // 1. Compute foreground statistics per plate
        interface PlateStats {
            plate: StationPlate;
            fgIndices: number[];
            meanLum: number;
            meanRgb: [number, number, number];
            meanCb: number;
            meanCr: number;
        }

        const stats: PlateStats[] = [];

        for (const plate of plates) {
            const total = plate.width * plate.height;
            const fgIndices: number[] = [];
            let sumLum = 0;
            let sumR = 0, sumG = 0, sumB = 0;
            let sumCb = 0, sumCr = 0;

            for (let i = 0; i < total; i++) {
                const z = plate.depth[i];
                const alpha = plate.rgba[i * 4 + 3];
                if (z < EMPTY_DEPTH * 0.5 && z > 0 && alpha > 0) {
                    fgIndices.push(i);
                    const r = plate.rgba[i * 4];
                    const g = plate.rgba[i * 4 + 1];
                    const b = plate.rgba[i * 4 + 2];
                    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
                    sumLum += lum;
                    sumR += r;
                    sumG += g;
                    sumB += b;
                    const [, cb, cr] = this.rgbToYcbcr(r, g, b);
                    sumCb += cb;
                    sumCr += cr;
                }
            }

            const count = fgIndices.length || 1;
            stats.push({
                plate,
                fgIndices,
                meanLum: sumLum / count,
                meanRgb: [sumR / count, sumG / count, sumB / count],
                meanCb: sumCb / count,
                meanCr: sumCr / count
            });
        }

        // 2. Select anchor plate
        let anchorIdx = 0;
        if (options.referenceStationId !== undefined) {
            const found = stats.findIndex(s => s.plate.station.id === options.referenceStationId);
            if (found >= 0) anchorIdx = found;
        } else {
            // Find plate whose mean luminance is closest to the median mean-luminance
            const sortedLums = [...stats].map(s => s.meanLum).sort((a, b) => a - b);
            const medianLum = sortedLums[Math.floor(sortedLums.length / 2)];
            let bestDiff = Infinity;
            for (let i = 0; i < stats.length; i++) {
                const diff = Math.abs(stats[i].meanLum - medianLum);
                if (diff < bestDiff) {
                    bestDiff = diff;
                    anchorIdx = i;
                }
            }
        }

        const anchorStat = stats[anchorIdx];
        const telemetry: StationEqualizationTelemetry[] = [
            {
                stationId: anchorStat.plate.station.id,
                stationName: anchorStat.plate.station.name,
                isAnchor: true,
                overlapFraction: 1.0,
                meanLuminanceBefore: anchorStat.meanLum,
                meanLuminanceAfter: anchorStat.meanLum,
                meanRgbBefore: anchorStat.meanRgb,
                meanRgbAfter: anchorStat.meanRgb
            }
        ];

        const equalizedSet = new Set<number>([anchorStat.plate.station.id]);

        // 3. Iteratively match remaining plates via maximum overlap spanning tree
        while (equalizedSet.size < plates.length) {
            let bestCandidateIdx = -1;
            let bestReferenceIdx = -1;
            let bestOverlapFrac = -1;
            let bestWarp: any = null;

            for (let i = 0; i < stats.length; i++) {
                if (equalizedSet.has(stats[i].plate.station.id)) continue;

                // Check overlap with any already-equalized plate
                for (let j = 0; j < stats.length; j++) {
                    if (!equalizedSet.has(stats[j].plate.station.id)) continue;

                    // Forward warp reference plate j into candidate plate i
                    const src: WarpSource = {
                        station: stats[j].plate.station,
                        rgba: stats[j].plate.rgba as Buffer,
                        depth: stats[j].plate.depth,
                        width: stats[j].plate.width,
                        height: stats[j].plate.height,
                        intrinsics: stats[j].plate.intrinsics
                    };
                    const dst: WarpTarget = {
                        station: stats[i].plate.station,
                        width: stats[i].plate.width,
                        height: stats[i].plate.height,
                        intrinsics: stats[i].plate.intrinsics
                    };

                    try {
                        const warp = warpStationImage(src, dst);
                        if (warp.coveredFraction > bestOverlapFrac) {
                            bestOverlapFrac = warp.coveredFraction;
                            bestCandidateIdx = i;
                            bestReferenceIdx = j;
                            bestWarp = warp;
                        }
                    } catch {
                        // Ignore warp errors on non-overlapping frustums
                    }
                }
            }

            // If no candidate had significant overlap, pick the next un-equalized and match globally to anchor
            if (bestCandidateIdx === -1 || bestOverlapFrac < minOverlap) {
                const nextCandidateIdx = stats.findIndex(s => !equalizedSet.has(s.plate.station.id));
                if (nextCandidateIdx === -1) break;

                const cand = stats[nextCandidateIdx];
                this.applyGlobalCdfMatching(cand, anchorStat, blend, colorSpace);
                equalizedSet.add(cand.plate.station.id);

                telemetry.push({
                    stationId: cand.plate.station.id,
                    stationName: cand.plate.station.name,
                    isAnchor: false,
                    matchedToStationId: anchorStat.plate.station.id,
                    overlapFraction: 0.0,
                    meanLuminanceBefore: cand.meanLum,
                    meanLuminanceAfter: this.computePlateMeanLum(cand.plate),
                    meanRgbBefore: cand.meanRgb,
                    meanRgbAfter: this.computePlateMeanRgb(cand.plate)
                });
                continue;
            }

            const cand = stats[bestCandidateIdx];
            const ref = stats[bestReferenceIdx];

            this.applyOverlapCdfMatching(cand, ref, bestWarp, blend, colorSpace);
            equalizedSet.add(cand.plate.station.id);

            telemetry.push({
                stationId: cand.plate.station.id,
                stationName: cand.plate.station.name,
                isAnchor: false,
                matchedToStationId: ref.plate.station.id,
                overlapFraction: bestOverlapFrac,
                meanLuminanceBefore: cand.meanLum,
                meanLuminanceAfter: this.computePlateMeanLum(cand.plate),
                meanRgbBefore: cand.meanRgb,
                meanRgbAfter: this.computePlateMeanRgb(cand.plate)
            });
        }

        return {
            anchorStationId: anchorStat.plate.station.id,
            stationsEqualized: plates.length,
            telemetry
        };
    }

    /**
     * Applies CDF matching across mutually visible overlap pixels.
     */
    private static applyOverlapCdfMatching(
        cand: { plate: StationPlate; fgIndices: number[] },
        ref: { plate: StationPlate },
        warp: { rgba: Buffer; mask: Uint8Array },
        blend: number,
        colorSpace: 'ycbcr' | 'rgb'
    ): void {
        const total = cand.plate.width * cand.plate.height;
        const overlapSrcY: number[] = [];
        const overlapRefY: number[] = [];
        const overlapSrcCb: number[] = [];
        const overlapRefCb: number[] = [];
        const overlapSrcCr: number[] = [];
        const overlapRefCr: number[] = [];

        const overlapSrcR: number[] = [];
        const overlapRefR: number[] = [];
        const overlapSrcG: number[] = [];
        const overlapRefG: number[] = [];
        const overlapSrcB: number[] = [];
        const overlapRefB: number[] = [];

        for (let i = 0; i < total; i++) {
            // Check mutual visibility: warped pixel exists and candidate pixel is foreground
            if (warp.mask[i] === 0 && cand.plate.depth[i] < EMPTY_DEPTH * 0.5 && cand.plate.depth[i] > 0) {
                const sR = cand.plate.rgba[i * 4];
                const sG = cand.plate.rgba[i * 4 + 1];
                const sB = cand.plate.rgba[i * 4 + 2];

                const rR = warp.rgba[i * 4];
                const rG = warp.rgba[i * 4 + 1];
                const rB = warp.rgba[i * 4 + 2];

                if (colorSpace === 'ycbcr') {
                    const [sY, sCb, sCr] = this.rgbToYcbcr(sR, sG, sB);
                    const [rY, rCb, rCr] = this.rgbToYcbcr(rR, rG, rB);
                    overlapSrcY.push(sY);
                    overlapRefY.push(rY);
                    overlapSrcCb.push(sCb);
                    overlapRefCb.push(rCb);
                    overlapSrcCr.push(sCr);
                    overlapRefCr.push(rCr);
                } else {
                    overlapSrcR.push(sR); overlapRefR.push(rR);
                    overlapSrcG.push(sG); overlapRefG.push(rG);
                    overlapSrcB.push(sB); overlapRefB.push(rB);
                }
            }
        }

        if (colorSpace === 'ycbcr') {
            const lutY = this.buildCdfLut(
                overlapSrcY.length > 50 ? overlapSrcY : this.collectForegroundLums(cand.plate),
                overlapRefY.length > 50 ? overlapRefY : this.collectForegroundLums(ref.plate)
            );

            // Compute chrominance delta
            const meanSrcCb = overlapSrcCb.length > 0 ? overlapSrcCb.reduce((a, b) => a + b, 0) / overlapSrcCb.length : 128;
            const meanRefCb = overlapRefCb.length > 0 ? overlapRefCb.reduce((a, b) => a + b, 0) / overlapRefCb.length : 128;
            const deltaCb = meanRefCb - meanSrcCb;

            const meanSrcCr = overlapSrcCr.length > 0 ? overlapSrcCr.reduce((a, b) => a + b, 0) / overlapSrcCr.length : 128;
            const meanRefCr = overlapRefCr.length > 0 ? overlapRefCr.reduce((a, b) => a + b, 0) / overlapRefCr.length : 128;
            const deltaCr = meanRefCr - meanSrcCr;

            for (const i of cand.fgIndices) {
                const sR = cand.plate.rgba[i * 4];
                const sG = cand.plate.rgba[i * 4 + 1];
                const sB = cand.plate.rgba[i * 4 + 2];
                const [y, cb, cr] = this.rgbToYcbcr(sR, sG, sB);

                const matchedY = lutY[y];
                const matchedCb = Math.max(0, Math.min(255, Math.round(cb + deltaCb)));
                const matchedCr = Math.max(0, Math.min(255, Math.round(cr + deltaCr)));

                const [newR, newG, newB] = this.ycbcrToRgb(matchedY, matchedCb, matchedCr);

                cand.plate.rgba[i * 4]     = Math.round((1 - blend) * sR + blend * newR);
                cand.plate.rgba[i * 4 + 1] = Math.round((1 - blend) * sG + blend * newG);
                cand.plate.rgba[i * 4 + 2] = Math.round((1 - blend) * sB + blend * newB);
            }
        } else {
            const lutR = this.buildCdfLut(overlapSrcR, overlapRefR);
            const lutG = this.buildCdfLut(overlapSrcG, overlapRefG);
            const lutB = this.buildCdfLut(overlapSrcB, overlapRefB);

            for (const i of cand.fgIndices) {
                const sR = cand.plate.rgba[i * 4];
                const sG = cand.plate.rgba[i * 4 + 1];
                const sB = cand.plate.rgba[i * 4 + 2];

                cand.plate.rgba[i * 4]     = Math.round((1 - blend) * sR + blend * lutR[sR]);
                cand.plate.rgba[i * 4 + 1] = Math.round((1 - blend) * sG + blend * lutG[sG]);
                cand.plate.rgba[i * 4 + 2] = Math.round((1 - blend) * sB + blend * lutB[sB]);
            }
        }
    }

    /**
     * Applies global CDF matching across all foreground pixels when no direct overlap exists.
     */
    private static applyGlobalCdfMatching(
        cand: { plate: StationPlate; fgIndices: number[] },
        ref: { plate: StationPlate; fgIndices: number[] },
        blend: number,
        colorSpace: 'ycbcr' | 'rgb'
    ): void {
        if (colorSpace === 'ycbcr') {
            const srcY = this.collectForegroundLums(cand.plate);
            const refY = this.collectForegroundLums(ref.plate);
            const lutY = this.buildCdfLut(srcY, refY);

            for (const i of cand.fgIndices) {
                const sR = cand.plate.rgba[i * 4];
                const sG = cand.plate.rgba[i * 4 + 1];
                const sB = cand.plate.rgba[i * 4 + 2];
                const [y, cb, cr] = this.rgbToYcbcr(sR, sG, sB);

                const matchedY = lutY[y];
                const [newR, newG, newB] = this.ycbcrToRgb(matchedY, cb, cr);

                cand.plate.rgba[i * 4]     = Math.round((1 - blend) * sR + blend * newR);
                cand.plate.rgba[i * 4 + 1] = Math.round((1 - blend) * sG + blend * newG);
                cand.plate.rgba[i * 4 + 2] = Math.round((1 - blend) * sB + blend * newB);
            }
        } else {
            const srcR = cand.fgIndices.map(i => cand.plate.rgba[i * 4]);
            const refR = ref.fgIndices.map(i => ref.plate.rgba[i * 4]);
            const srcG = cand.fgIndices.map(i => cand.plate.rgba[i * 4 + 1]);
            const refG = ref.fgIndices.map(i => ref.plate.rgba[i * 4 + 1]);
            const srcB = cand.fgIndices.map(i => cand.plate.rgba[i * 4 + 2]);
            const refB = ref.fgIndices.map(i => ref.plate.rgba[i * 4 + 2]);

            const lutR = this.buildCdfLut(srcR, refR);
            const lutG = this.buildCdfLut(srcG, refG);
            const lutB = this.buildCdfLut(srcB, refB);

            for (const i of cand.fgIndices) {
                const sR = cand.plate.rgba[i * 4];
                const sG = cand.plate.rgba[i * 4 + 1];
                const sB = cand.plate.rgba[i * 4 + 2];

                cand.plate.rgba[i * 4]     = Math.round((1 - blend) * sR + blend * lutR[sR]);
                cand.plate.rgba[i * 4 + 1] = Math.round((1 - blend) * sG + blend * lutG[sG]);
                cand.plate.rgba[i * 4 + 2] = Math.round((1 - blend) * sB + blend * lutB[sB]);
            }
        }
    }

    private static collectForegroundLums(plate: StationPlate): number[] {
        const lums: number[] = [];
        const total = plate.width * plate.height;
        for (let i = 0; i < total; i++) {
            if (plate.depth[i] < EMPTY_DEPTH * 0.5 && plate.depth[i] > 0 && plate.rgba[i * 4 + 3] > 0) {
                const r = plate.rgba[i * 4];
                const g = plate.rgba[i * 4 + 1];
                const b = plate.rgba[i * 4 + 2];
                lums.push(Math.round(0.299 * r + 0.587 * g + 0.114 * b));
            }
        }
        return lums;
    }

    private static computePlateMeanLum(plate: StationPlate): number {
        let sum = 0;
        let count = 0;
        const total = plate.width * plate.height;
        for (let i = 0; i < total; i++) {
            if (plate.depth[i] < EMPTY_DEPTH * 0.5 && plate.depth[i] > 0 && plate.rgba[i * 4 + 3] > 0) {
                sum += 0.299 * plate.rgba[i * 4] + 0.587 * plate.rgba[i * 4 + 1] + 0.114 * plate.rgba[i * 4 + 2];
                count++;
            }
        }
        return count > 0 ? sum / count : 0;
    }

    private static computePlateMeanRgb(plate: StationPlate): [number, number, number] {
        let sR = 0, sG = 0, sB = 0;
        let count = 0;
        const total = plate.width * plate.height;
        for (let i = 0; i < total; i++) {
            if (plate.depth[i] < EMPTY_DEPTH * 0.5 && plate.depth[i] > 0 && plate.rgba[i * 4 + 3] > 0) {
                sR += plate.rgba[i * 4];
                sG += plate.rgba[i * 4 + 1];
                sB += plate.rgba[i * 4 + 2];
                count++;
            }
        }
        return count > 0 ? [sR / count, sG / count, sB / count] : [0, 0, 0];
    }
}
