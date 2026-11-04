/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Where a district's ground is grass, from two measurements that must agree:
 *   - height: the scan's top surface within `maxAboveGroundM` of the terrain (the ground model), so building roofs,
 *     tree crowns, hedges taller than that and parked cars are never grass;
 *   - appearance: the cell's lit colour (litColour over the top-down tile photo) reads as vegetation in CIELAB
 *     (ground-classifier.ts vegetationColourScore: a hue window from olive to fresh green, with chroma), not a grey plaza
 *     or a brown path; weighed by what the ground classifier's area priors say about the cell (Google's park outlines say
 *     planted, parking lots and carriageways say paved, green open ground off every planted area is held back as likely
 *     paint, a roof or a vehicle and counted as `offPlanted`). Without a classification the photo and the scan decide
 *     alone, at the no-evidence prior.
 * A majority filter removes speckle, and patches under `minPatchM2` are dropped. Each grass cell carries a confidence
 * from how green it is and how close to the terrain it lies; the mask is photo-inferred (read off photographs), never
 * measured. Water is never grass: a green pond or fountain pool passes both tests, so cells inside Google's vector water
 * areas (rasterizeEvidence's `water`, on the ground grid), grown by `waterMarginM`, are left out when the caller has them.
 * Under a tree crown the ground is hidden from above. Inside a park outline (Google's FEATURE_TYPE_PARK areas, when the
 * caller passes them), each hidden cell takes the surface of the nearest ground the survey did see in the same park:
 * grass continues as grass, and a path continues as path for `pathReachM` (a path runs on under the canopy; it does not
 * pave the whole wood). Hidden park ground beyond that is lawn, the usual floor of a park's planted areas. Cells inside
 * a vector building (a pavilion, an arch) are never filled. Those cells are mask value 2, generated (a plausible fill, not
 * a reading), with a lower confidence. Outside parks nothing under a crown is filled, so street trees and courtyards
 * never sprout lawns.
 */

import type { GroundModel } from '../../spatial/StreetViewSurveyPlanner';
import type { TopDownFrame, TopDownPhoto } from './top-down-photo';
import { cellColours, vegetationColourScore, GROUND_CLASSIFIER_PARAMS, type GroundClassification } from './ground-classifier';

export const GRASS_DETECT_VERSION = 'grass-detect/2';

export const GRASS_DETECT_PARAMS = {
    /** Highest the top surface may stand above the terrain and still be a lawn (m). */
    maxAboveGroundM: 0.6,
    /** Least vegetation score (the colour's vegetation score x the area's vegetation prior x (1 - its paved prior)) of a grass cell. */
    minScore: 0.35,
    majorityPasses: 2,
    minPatchM2: 4,
    /** How far past a vector water area's edge a cell is still water (m): the polygon and the scan disagree by about a metre. */
    waterMarginM: 1.5,
    /** Confidence of a grass cell filled in under a park's tree crowns. */
    underCrownConfidence: 0.35,
    /** How far a path seen at a crown's edge runs on under it before the hidden ground counts as lawn (m). */
    pathReachM: 4
};

export interface GrassMask {
    version: string;
    x0: number; z0: number; nx: number; nz: number; cellM: number;
    /** 1 where the cell is grass seen from above, 2 where it is grass filled in under a park's tree crowns. */
    mask: Uint8Array;
    /** 0..1 per grass cell (0 elsewhere). */
    confidence: Float32Array;
    /** The lit photo colour (linear RGB, 3 per cell) of each cell read green; 0 elsewhere and under crowns (nothing seen there). */
    colour: Float32Array;
    cells: number;
    areaM2: number;
    /** Green open ground held back by the area priors: 1 off every planted area (likely paint, a roof, a vehicle), 2 on paved ground. */
    heldBack: Uint8Array;
    /** The filled-in part (mask value 2): cells and area, included in `cells` and `areaM2`. */
    underCrown: { cells: number; areaM2: number };
    patches: Array<{ cells: number; areaM2: number; centre: [number, number]; meanConfidence: number }>;
    /** Cells looked at, and why the rest were not grass. */
    stats: { measured: number; tooHigh: number; water: number; notGreen: number; noColour: number; speckle: number; offPlanted: number; paved: number; building: number };
    provenance: { label: 'photo-inferred'; method: string; underCrown?: { label: 'generated'; method: string } };
}

/**
 * `water`, `park` and `building`, when given, are non-zero per ground-grid cell inside a vector water area, a park
 * outline and a building footprint (rasterizeEvidence / rasterizeAreas over the ground model's grid).
 */
export function detectGrass(photo: TopDownPhoto, frame: TopDownFrame, ground: GroundModel, P = GRASS_DETECT_PARAMS, evidence?: { water?: Uint8Array; park?: Uint8Array; building?: Uint8Array | Int32Array; classification?: GroundClassification }): GrassMask {
    const { nx, nz, cellMeters: cellM, x0, z0 } = ground;
    const N = nx * nz;
    const raw = new Uint8Array(N), heldBack = new Uint8Array(N), score = new Float32Array(N), colour = new Float32Array(N * 3);
    const stats = { measured: 0, tooHigh: 0, water: 0, notGreen: 0, noColour: 0, speckle: 0, offPlanted: 0, paved: 0, building: 0 };
    const water = evidence?.water ? grow(evidence.water, nx, nz, Math.round(P.waterMarginM / cellM)) : undefined;
    const cls = evidence?.classification;
    const colours = cls?.colours ?? cellColours(photo, frame, ground);
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        const c = k * nx + i;
        const top = ground.top[c], g = ground.ground[c];
        if (!Number.isFinite(top) || !Number.isFinite(g)) continue;
        stats.measured++;
        const above = top - g;
        if (above > P.maxAboveGroundM) { stats.tooHigh++; continue; }
        if (water?.[c]) { stats.water++; continue; }
        if (cls ? cls.scores.building[c] : evidence?.building?.[c]) { stats.building++; continue; }
        const L = colours.lab[c * 3], a = colours.lab[c * 3 + 1], b = colours.lab[c * 3 + 2];
        if (!Number.isFinite(L)) { stats.noColour++; continue; }
        const veg = cls ? cls.vegetationColour[c] : vegetationColourScore(L, a, b);
        if (veg * (cls ? 1 : GROUND_CLASSIFIER_PARAMS.noEvidenceVegetationPrior) < P.minScore) { stats.notGreen++; continue; }
        const pv = cls ? cls.prior.vegetation[c] : GROUND_CLASSIFIER_PARAMS.noEvidenceVegetationPrior, pp = cls ? cls.prior.paved[c] : 0;
        const fused = veg * pv * (1 - pp);
        if (fused < P.minScore) { if (pp >= 0.5) { stats.paved++; heldBack[c] = 2; } else { stats.offPlanted++; heldBack[c] = 1; } continue; }
        raw[c] = 1;
        colour.set(colours.linear.subarray(c * 3, c * 3 + 3), c * 3);
        const green = Math.min(1, fused / Math.max(P.minScore, pv));
        const low = 1 - Math.max(0, above) / P.maxAboveGroundM;
        score[c] = Math.max(0.05, 0.5 * green + 0.5 * Math.min(1, low * 1.5)) * (0.6 + 0.4 * green);
    }
    // majority filter (3 x 3): a cell takes the state most of its neighbourhood has
    let mask = raw;
    for (let pass = 0; pass < P.majorityPasses; pass++) {
        const next = new Uint8Array(N);
        for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
            let on = 0, tot = 0;
            for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
                const ii = i + di, kk = k + dk;
                if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
                tot++; on += mask[kk * nx + ii];
            }
            next[k * nx + i] = on * 2 > tot ? 1 : 0;
        }
        mask = next;
    }
    const filled = evidence?.park ? fillUnderCrowns(mask, ground, evidence.park, water, evidence.building, P.maxAboveGroundM, Math.round(P.pathReachM / cellM)) : 0;
    // patches: 4-connected; the small ones dropped
    const label = new Int32Array(N).fill(-1);
    const patches: GrassMask['patches'] = [];
    const confidence = new Float32Array(N);
    const minCells = Math.max(1, Math.round(P.minPatchM2 / (cellM * cellM)));
    const stack: number[] = [], members: number[] = [];
    for (let s = 0; s < N; s++) {
        if (!mask[s] || label[s] >= 0) continue;
        members.length = 0; stack.push(s); label[s] = patches.length;
        while (stack.length) {
            const c = stack.pop()!; members.push(c);
            const i = c % nx, k = (c / nx) | 0;
            for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const ii = i + di, kk = k + dk;
                if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
                const n = kk * nx + ii;
                if (mask[n] && label[n] < 0) { label[n] = label[s]; stack.push(n); }
            }
        }
        if (members.length < minCells) { for (const c of members) mask[c] = 0; stats.speckle += members.length; label[s] = -2; continue; }
        let sx = 0, sz = 0, sc = 0;
        for (const c of members) {
            // a cell the filter filled in from its neighbours: lower confidence; under a crown: lower still
            const conf = mask[c] === 2 ? P.underCrownConfidence : score[c] || 0.3;
            confidence[c] = conf; sc += conf;
            sx += x0 + ((c % nx) + 0.5) * cellM; sz += z0 + (((c / nx) | 0) + 0.5) * cellM;
        }
        patches.push({ cells: members.length, areaM2: members.length * cellM * cellM, centre: [sx / members.length, sz / members.length], meanConfidence: sc / members.length });
    }
    let cells = 0, under = 0;
    for (let c = 0; c < N; c++) { if (mask[c]) cells++; if (mask[c] === 2) under++; }
    patches.sort((p, q) => q.areaM2 - p.areaM2);
    return {
        version: GRASS_DETECT_VERSION, x0, z0, nx, nz, cellM, mask, confidence, colour, heldBack, cells, areaM2: cells * cellM * cellM,
        underCrown: { cells: under, areaM2: under * cellM * cellM }, patches, stats,
        provenance: { label: 'photo-inferred', method: `ground-level cells (within ${P.maxAboveGroundM} m of the terrain) whose lit top-down colour reads as vegetation (CIELAB hue ${GROUND_CLASSIFIER_PARAMS.hueInnerLow}-${GROUND_CLASSIFIER_PARAMS.hueInnerHigh} deg, chroma), ${cls?.prior.source === 'google-vector' ? 'weighed by Google land-use priors (planted areas, parking, carriageways; green off every planted area held back), ' : 'no area priors (photo and scan alone), '}score >= ${P.minScore}, majority-filtered, patches >= ${P.minPatchM2} m2${water ? `, outside vector water areas (+${P.waterMarginM} m)` : ', no vector water areas given'}`,
            ...(evidence?.park ? { underCrown: { label: 'generated' as const, method: `inside park outlines, ground hidden by crowns (${filled} cells) continues the nearest surface seen in the same park (grass; a path for ${P.pathReachM} m), lawn beyond` } } : {}) }
    };
}

/**
 * Fills the park cells hidden under crowns (top more than `maxAboveM` above the terrain, outside buildings and water) from
 * the seen, dry ground of the same park: a breadth-first wave from every seen park cell carries grass or path outward
 * through hidden cells; the path wave stops after `pathReach` cells. A hidden cell the grass wave reaches, or that no wave
 * reaches, becomes 2. Returns the number of cells filled.
 */
function fillUnderCrowns(mask: Uint8Array, ground: GroundModel, park: Uint8Array, water: Uint8Array | undefined, building: Uint8Array | Int32Array | undefined,
    maxAboveM: number, pathReach: number): number {
    const { nx, nz } = ground, N = nx * nz;
    const hidden = (c: number) => park[c] && !water?.[c] && !building?.[c] && ground.top[c] - ground.ground[c] > maxAboveM;
    const from = new Int8Array(N).fill(-1), dist = new Int32Array(N);
    let queue: number[] = [];
    for (let c = 0; c < N; c++) {
        if (!park[c] || water?.[c] || building?.[c] || !Number.isFinite(ground.top[c]) || !Number.isFinite(ground.ground[c]) || hidden(c)) continue;
        from[c] = mask[c] ? 1 : 0;
        queue.push(c);
    }
    let filled = 0;
    while (queue.length) {
        const next: number[] = [];
        for (const c of queue) {
            if (from[c] === 0 && dist[c] >= pathReach) continue;
            const i = c % nx, k = (c / nx) | 0;
            for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const ii = i + di, kk = k + dk;
                if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
                const n = kk * nx + ii;
                if (from[n] >= 0 || !hidden(n)) continue;
                from[n] = from[c]; dist[n] = dist[c] + 1;
                next.push(n);
            }
        }
        queue = next;
    }
    for (let c = 0; c < N; c++) if (hidden(c) && from[c] !== 0) { mask[c] = 2; filled++; }
    return filled;
}

/** `m` grown by `r` cells (a square neighbourhood). */
function grow(m: Uint8Array, nx: number, nz: number, r: number): Uint8Array {
    if (r <= 0) return m;
    const out = new Uint8Array(m.length);
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        if (!m[k * nx + i]) continue;
        for (let kk = Math.max(0, k - r); kk <= Math.min(nz - 1, k + r); kk++) out.fill(1, kk * nx + Math.max(0, i - r), kk * nx + Math.min(nx - 1, i + r) + 1);
    }
    return out;
}

/** The top-down photo with the grass mask laid over it (seen grass green, filled-in grass cyan, tint by confidence; outlines bright; green held back by the area priors orange), RGBA. */
export function grassOverlay(photo: TopDownPhoto, frame: TopDownFrame, g: GrassMask): Uint8Array {
    const out = Uint8Array.from(photo.rgba);
    const at = (x: number, z: number) => {
        const i = Math.floor((x - g.x0) / g.cellM), k = Math.floor((z - g.z0) / g.cellM);
        return i < 0 || k < 0 || i >= g.nx || k >= g.nz ? -1 : k * g.nx + i;
    };
    for (let py = 0; py < photo.height; py++) for (let px = 0; px < photo.width; px++) {
        const x = frame.x0 + (px + 0.5) * photo.texelM, z = frame.z0 + (py + 0.5) * photo.texelM;
        const c = at(x, z);
        const o = (py * photo.width + px) * 4;
        if (c >= 0 && !g.mask[c] && g.heldBack?.[c]) { out[o] = out[o] * 0.4 + 255 * 0.6; out[o + 1] = out[o + 1] * 0.4 + 120 * 0.6; out[o + 2] = out[o + 2] * 0.4; continue; }
        if (c < 0 || !g.mask[c]) { out[o] = out[o] * 0.55; out[o + 1] = out[o + 1] * 0.55; out[o + 2] = out[o + 2] * 0.55; continue; }
        const i = c % g.nx, k = (c / g.nx) | 0;
        const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([di, dk]) => { const ii = i + di, kk = k + dk; return ii < 0 || kk < 0 || ii >= g.nx || kk >= g.nz || !g.mask[kk * g.nx + ii]; });
        const t = 0.35 + 0.35 * g.confidence[c];
        if (edge) { out[o] = 255; out[o + 1] = 230; out[o + 2] = 0; continue; }
        // seen grass green; grass filled in under crowns cyan
        const [r, gr, b] = g.mask[c] === 2 ? [0, 200, 255] : [0, 255, 60];
        out[o] = out[o] * (1 - t) + r * t; out[o + 1] = out[o + 1] * (1 - t) + gr * t; out[o + 2] = out[o + 2] * (1 - t) + b * t;
    }
    return out;
}
