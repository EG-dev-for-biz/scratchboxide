/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * What every ground cell of a district is, from every source the build has, fused per cell of the ground model's grid:
 *   - the scan: the top surface's height above the terrain (ground model), so roofs, crowns, cars and bridges stand apart
 *     from the open ground;
 *   - the top-down tile photo: each cell's lit colour (litColour, CIELAB) and its texel-scale texture;
 *   - Google's vector data: building footprints (a building where the scan shows something standing in them; open ground
 *     at the terrain inside a footprint, a plaza or a lawn over an underground structure, is classified as ground and
 *     reported), water areas, road centrelines (the carriageway around them), and the
 *     land-use / land-cover areas' priors (ground-area-priors.ts, handed in by the caller: this module never reads a code).
 * Each cell gets continuous scores (0..1): low vegetation, tree canopy, paved, water, building, raised structure, and a
 * label for display and filtering only (the highest score; open strings, nothing branches on them). The photo colour
 * alone cannot tell a lawn from a green roof or a green truck (the same CIELAB); the area priors can: green open ground
 * counts as vegetation by how much the areas over it say vegetation, so green paint outside every planted area reads as a
 * raised or paved surface, reported, not as lawn. Colour, priors and scores are photo-inferred / vector-labelled
 * evidence, never measurements of what the surface is.
 */

import type { GroundModel } from '../../spatial/StreetViewSurveyPlanner';
import type { TopDownFrame, TopDownPhoto } from './top-down-photo';
import type { EvidenceRaster } from './vector-footprints';
import type { AreaPriorRasters } from './ground-area-priors';
import { litColour } from './surface-materials';

export const GROUND_CLASSIFIER_VERSION = 'ground-classifier/1';

export const GROUND_CLASSIFIER_PARAMS = {
    /** Highest the top may stand above the terrain and still be open ground (m). */
    openAboveM: 0.6,
    /** From this height above the terrain a vegetation-coloured top is a crown (m). */
    canopyAboveM: 2,
    /** Hue (CIELAB, degrees) of vegetation: full between the inner bounds, falling to 0 at the outer ones. Olive lawns sit near 100, fresh grass near 135. */
    hueOuterLow: 78, hueInnerLow: 92, hueInnerHigh: 152, hueOuterHigh: 175,
    /** Chroma (sqrt(a*^2 + b*^2)) from which a colour can be vegetation, and where it fully is. */
    chromaLow: 5, chromaFull: 10,
    /** Lightness range of a vegetation texel mean (excludes deep shade and glare). */
    minL: 12, maxL: 88,
    /** Vegetation prior where no area has an opinion but vector data was read (green open ground off every planted area). */
    offAreaVegetationPrior: 0.3,
    /** Vegetation prior with no vector data at all (no areas read): the photo and the scan decide alone. */
    noEvidenceVegetationPrior: 0.6,
    /** Paved prior on a carriageway (within the road raster). */
    roadPavedPrior: 1
};

/** Labels (display and filtering only; open). */
export const GROUND_LABELS = ['unmeasured', 'building', 'water', 'low-vegetation', 'tree-canopy', 'paved', 'raised-structure'] as const;
export type GroundLabel = typeof GROUND_LABELS[number] | (string & {});

export interface CellColours {
    /** CIELAB per cell (3 per cell); NaN where too few texels were seen. */
    lab: Float32Array;
    /** Linear RGB of the lit texels per cell (3 per cell); NaN where none. */
    linear: Float32Array;
    /** Standard deviation of the cell's texel luminance (sRGB 0..255): blade-scale texture. NaN where none. */
    texture: Float32Array;
}

/** The lit colour and texture of every ground cell in the top-down photo. */
export function cellColours(photo: TopDownPhoto, frame: TopDownFrame, ground: Pick<GroundModel, 'nx' | 'nz' | 'cellMeters' | 'x0' | 'z0'>): CellColours {
    const { nx, nz, cellMeters: cellM, x0, z0 } = ground, N = nx * nz;
    const lab = new Float32Array(N * 3).fill(NaN), linear = new Float32Array(N * 3).fill(NaN), texture = new Float32Array(N).fill(NaN);
    const per = Math.max(1, Math.round(cellM / photo.texelM));
    const buf = new Uint8Array(per * per * 4);
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        const c = k * nx + i;
        const px0 = Math.floor((x0 + i * cellM - frame.x0) / photo.texelM), py0 = Math.floor((z0 + k * cellM - frame.z0) / photo.texelM);
        let n = 0, s = 0, s2 = 0, seen = 0;
        for (let y = 0; y < per; y++) for (let x = 0; x < per; x++, n++) {
            const sx = px0 + x, sy = py0 + y;
            if (sx < 0 || sy < 0 || sx >= photo.width || sy >= photo.height) { buf[n * 4 + 3] = 0; continue; }
            const o = (sy * photo.width + sx) * 4;
            buf[n * 4] = photo.rgba[o]; buf[n * 4 + 1] = photo.rgba[o + 1]; buf[n * 4 + 2] = photo.rgba[o + 2]; buf[n * 4 + 3] = photo.rgba[o + 3];
            if (photo.rgba[o + 3] >= 128) { const l = 0.299 * photo.rgba[o] + 0.587 * photo.rgba[o + 1] + 0.114 * photo.rgba[o + 2]; s += l; s2 += l * l; seen++; }
        }
        const col = litColour(buf, { minTexels: Math.max(4, (per * per) >> 2) });
        if (!col) continue;
        lab.set(col.lab, c * 3); linear.set(col.linearRgb, c * 3);
        texture[c] = Math.sqrt(Math.max(0, s2 / seen - (s / seen) ** 2));
    }
    return { lab, linear, texture };
}

const ramp = (v: number, lo: number, hi: number) => Math.max(0, Math.min(1, (v - lo) / (hi - lo)));

/** 0..1: how much a CIELAB colour reads as living vegetation (hue window, enough chroma, lightness in range). Continuous. */
export function vegetationColourScore(L: number, a: number, b: number, P = GROUND_CLASSIFIER_PARAMS): number {
    if (!Number.isFinite(L) || L < P.minL || L > P.maxL) return 0;
    const hue = (Math.atan2(b, a) * 180) / Math.PI;
    const h = Math.min(ramp(hue, P.hueOuterLow, P.hueInnerLow), 1 - ramp(hue, P.hueInnerHigh, P.hueOuterHigh));
    return h * ramp(Math.hypot(a, b), P.chromaLow, P.chromaFull);
}

export interface GroundClassification {
    version: string;
    x0: number; z0: number; nx: number; nz: number; cellM: number;
    /** Per cell: the top's height above the terrain (m); NaN unmeasured. */
    above: Float32Array;
    colours: CellColours;
    /** Per cell, 0..1: the photo colour's vegetation score. */
    vegetationColour: Float32Array;
    /** Per cell: the vegetation and paved priors used (after the no-opinion defaults). */
    prior: { vegetation: Float32Array; paved: Float32Array; source: 'google-vector' | 'none' };
    scores: { lowVegetation: Float32Array; canopy: Float32Array; paved: Float32Array; water: Float32Array; building: Float32Array; structure: Float32Array };
    /** Index into `labels` per cell. */
    label: Uint8Array;
    labels: readonly string[];
    /** Area (m²) per label, and the green open ground the priors kept from reading as vegetation. */
    stats: { areaM2: Record<string, number>; greenOffPlantedM2: number; openInFootprintM2: number };
    provenance: { label: 'photo-inferred'; method: string };
}

/**
 * Classifies every cell of `ground`. `raster` (rasterizeEvidence on the same grid) and `priors` (areaPriorRasters) are
 * optional: without vector data the photo and the scan decide alone, with the no-evidence prior, and the result says so.
 */
export function classifyGround(photo: TopDownPhoto, frame: TopDownFrame, ground: GroundModel, opts: { raster?: Pick<EvidenceRaster, 'building' | 'water' | 'road'>; priors?: Pick<AreaPriorRasters, 'vegetation' | 'paved'>; colours?: CellColours } = {}, P = GROUND_CLASSIFIER_PARAMS): GroundClassification {
    const { nx, nz, cellMeters: cellM, x0, z0 } = ground, N = nx * nz;
    const colours = opts.colours ?? cellColours(photo, frame, ground);
    const hasVector = !!opts.raster;
    const above = new Float32Array(N), vegetationColour = new Float32Array(N);
    const pv = new Float32Array(N), pp = new Float32Array(N);
    const s = { lowVegetation: new Float32Array(N), canopy: new Float32Array(N), paved: new Float32Array(N), water: new Float32Array(N), building: new Float32Array(N), structure: new Float32Array(N) };
    const label = new Uint8Array(N), areaM2: Record<string, number> = {};
    let greenOff = 0, openInFootprint = 0;
    for (let c = 0; c < N; c++) {
        const top = ground.top[c], g = ground.ground[c];
        above[c] = Number.isFinite(top) && Number.isFinite(g) ? top - g : NaN;
        const veg = vegetationColourScore(colours.lab[c * 3], colours.lab[c * 3 + 1], colours.lab[c * 3 + 2], P);
        vegetationColour[c] = veg;
        const areaVeg = opts.priors?.vegetation[c], areaPaved = opts.priors?.paved[c];
        pv[c] = areaVeg !== undefined && !Number.isNaN(areaVeg) ? areaVeg : hasVector ? P.offAreaVegetationPrior : P.noEvidenceVegetationPrior;
        const road = opts.raster?.road[c] ? P.roadPavedPrior : 0;
        pp[c] = Math.max(road, areaPaved !== undefined && !Number.isNaN(areaPaved) ? areaPaved : 0);
        const a = above[c];
        const inFootprint = !!opts.raster?.building[c], openHere = Number.isFinite(a) && a <= P.openAboveM;
        s.building[c] = inFootprint && !openHere ? 1 : 0;
        if (inFootprint && openHere) openInFootprint += cellM * cellM;
        s.water[c] = opts.raster?.water[c] ? 1 : 0;
        if (Number.isFinite(a)) {
            const open = a <= P.openAboveM;
            const tall = ramp(a, P.openAboveM, P.canopyAboveM);
            // open ground: vegetation by colour weighed by the areas' prior, less the paved prior; the rest paved
            const low = open ? veg * pv[c] * (1 - pp[c]) : 0;
            s.lowVegetation[c] = low;
            s.paved[c] = open ? Math.max(pp[c], 1 - veg) * (1 - low) : 0;
            s.canopy[c] = veg * tall * (1 - s.building[c]);
            s.structure[c] = open ? veg * (1 - pv[c]) * (1 - pp[c]) * 0.9 : (1 - veg) * tall * (1 - s.building[c]);
            if (open && veg >= 0.5 && pv[c] < 0.5) greenOff += cellM * cellM;
        }
        let best = 0, bestV = 0;
        const order: Array<[number, number]> = [[1, s.building[c]], [2, s.water[c]], [3, s.lowVegetation[c]], [4, s.canopy[c]], [5, s.paved[c]], [6, s.structure[c]]];
        for (const [l, v] of order) if (v > bestV) { bestV = v; best = l; }
        label[c] = best;
        areaM2[GROUND_LABELS[best]] = (areaM2[GROUND_LABELS[best]] ?? 0) + cellM * cellM;
    }
    return {
        version: GROUND_CLASSIFIER_VERSION, x0, z0, nx, nz, cellM, above, colours, vegetationColour,
        prior: { vegetation: pv, paved: pp, source: hasVector ? 'google-vector' : 'none' }, scores: s, label, labels: GROUND_LABELS,
        stats: { areaM2, greenOffPlantedM2: greenOff, openInFootprintM2: openInFootprint },
        provenance: { label: 'photo-inferred', method: `per ${cellM} m cell: the scan's top above the terrain, the top-down photo's lit CIELAB colour (vegetation by hue ${P.hueInnerLow}-${P.hueInnerHigh} deg, chroma >= ${P.chromaFull})${hasVector ? ', Google vector buildings, water, carriageways and land-use area priors' : ', no vector data (photo and scan alone)'}` }
    };
}
