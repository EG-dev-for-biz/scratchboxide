/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * What Google's land-use and land-cover areas say about the ground under them, as priors for the ground classifier
 * (ground-classifier.ts): a vegetation prior and a paved prior per area, from the area's type codes. This is data, read
 * at the caller's boundary (the classifier never matches a type code itself): an entry is keyed by one of Google's codes as
 * the vector tiles carry them, a code with no entry has no opinion, and an area takes the entry of its most specific code
 * that has one. Coarse land-cover areas (Landsat vegetation, urban area) carry no entry: at district scale they cover
 * parks, streets and roofs alike.
 * The priors only weigh measurements (the photo's colour, the scan's height): no geometry is chosen by a code.
 */

import type { VectorEvidence } from './vector-footprints';
import { rasterizeAreas, type EvidenceGrid } from './vector-footprints';

export interface AreaPrior {
    /** 0..1: how likely open ground in the area is planted (lawn, beds), given its colour reads as vegetation. */
    vegetation?: number;
    /** 0..1: how likely open ground in the area is paved. */
    paved?: number;
}

/** Google code -> prior. Open: add an entry to give a code an opinion; codes not listed are kept as labels and weigh nothing. */
export const GOOGLE_AREA_PRIORS: Readonly<Record<string, AreaPrior>> = {
    FEATURE_TYPE_PARK: { vegetation: 1, paved: 0.3 },
    FEATURE_TYPE_PARKING_LOT: { vegetation: 0, paved: 1 }
};

/** The prior of an area with these type codes: its most specific code's entry, undefined when no code has one. */
export function areaPriorOf(types: readonly string[], table: Readonly<Record<string, AreaPrior>> = GOOGLE_AREA_PRIORS): AreaPrior | undefined {
    for (let i = types.length - 1; i >= 0; i--) if (table[types[i]]) return table[types[i]];
    return undefined;
}

export interface AreaPriorRasters {
    /** Per cell: the highest vegetation prior of the areas over it; NaN where no area has an opinion. */
    vegetation: Float32Array;
    /** Per cell: the highest paved prior of the areas over it; NaN where no area has an opinion. */
    paved: Float32Array;
    /** Codes that carried an opinion here, and the areas they covered. */
    used: Array<{ code: string; areas: number }>;
}

/** The priors of every land-use area of `ev` rasterised on `g` (where areas overlap, the highest prior of each kind). */
export function areaPriorRasters(ev: VectorEvidence, g: EvidenceGrid, table: Readonly<Record<string, AreaPrior>> = GOOGLE_AREA_PRIORS): AreaPriorRasters {
    const N = g.nx * g.nz, vegetation = new Float32Array(N).fill(NaN), paved = new Float32Array(N).fill(NaN);
    const used: AreaPriorRasters['used'] = [];
    for (const code of Object.keys(table)) {
        const areas = (ev.landuse ?? []).filter(a => areaPriorOf(a.types, table) === table[code]);
        if (!areas.length) continue;
        used.push({ code, areas: areas.length });
        const mask = rasterizeAreas({ ...ev, landuse: areas }, g, code);
        const p = table[code];
        for (let c = 0; c < N; c++) {
            if (!mask[c]) continue;
            if (p.vegetation !== undefined) vegetation[c] = Number.isNaN(vegetation[c]) ? p.vegetation : Math.max(vegetation[c], p.vegetation);
            if (p.paved !== undefined) paved[c] = Number.isNaN(paved[c]) ? p.paved : Math.max(paved[c], p.paved);
        }
    }
    return { vegetation, paved, used };
}
